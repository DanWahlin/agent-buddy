//! The companion service's launcher on Windows.
//!
//! macOS and Linux start the service with launchd and systemd. Windows has no
//! per-user service manager, and node.exe opens a console window when it runs
//! at sign-in. So the installer (`daemon/src/installer.ts`) points the user's
//! `Run` registry key at this program with `--companion-service`. This program
//! has no window, starts node.exe with no console, and restarts it when it stops.
//! `service.json` in the data folder says which node.exe and cli.js to run.
//!
//! One launcher runs at a time. A new one tells the old one to stop and takes
//! its place, so an install picks up a new program or service at once.
//! `--companion-service-stop` stops the launcher and its service.

#[derive(Debug, PartialEq)]
pub enum Mode {
    Run,
    Stop,
}

pub fn options(args: &[String]) -> Option<Mode> {
    match args.get(1).map(String::as_str) {
        Some("--companion-service") => Some(Mode::Run),
        Some("--companion-service-stop") => Some(Mode::Stop),
        _ => None,
    }
}

/// What `service.json` holds.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, PartialEq, serde::Deserialize)]
pub struct ServiceConfig {
    pub node: std::path::PathBuf,
    pub cli: std::path::PathBuf,
    #[serde(default)]
    pub environment: std::collections::BTreeMap<String, String>,
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_config(text: &str) -> Option<ServiceConfig> {
    let config: ServiceConfig = serde_json::from_str(text).ok()?;
    (config.node.is_absolute() && config.cli.is_absolute()).then_some(config)
}

/// The wait before the next start: short for a service that ran for a time,
/// longer each time it stops again soon after it starts.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn restart_delay(failures: u32) -> std::time::Duration {
    std::time::Duration::from_secs(2u64.saturating_mul(1 << failures.min(5)).min(60))
}

#[cfg(not(windows))]
pub fn run(_mode: Mode) -> i32 {
    eprintln!("The companion service launcher is for Windows only.");
    1
}

#[cfg(windows)]
pub fn run(mode: Mode) -> i32 {
    windows::run(mode)
}

/// Stops the service that a launcher supervises, and waits for it. True when
/// no launcher runs after the call.
#[cfg(windows)]
pub fn stop_service() -> bool {
    windows::stop() == 0
}

/// Sets up a command that runs node.exe for the service: no console window, and
/// this program in AGENT_COMPANION_LAUNCHER, so the service can start (at sign-in)
/// or stop (on uninstall) through it.
#[cfg(windows)]
pub fn service_command(command: &mut std::process::Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    if let Ok(program) = std::env::current_exe() {
        command.env("AGENT_COMPANION_LAUNCHER", program);
    }
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(windows)]
mod windows {
    use super::{parse_config, restart_delay, service_command, Mode, ServiceConfig};
    use std::fs::OpenOptions;
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, WAIT_ABANDONED, WAIT_OBJECT_0,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    };
    use windows_sys::Win32::System::Threading::{
        CreateEventW, CreateMutexW, OpenEventW, OpenMutexW, ReleaseMutex, ResetEvent, SetEvent,
        WaitForSingleObject, EVENT_MODIFY_STATE, SYNCHRONIZATION_SYNCHRONIZE,
    };

    // Local\ names are for this sign-in session only.
    const MUTEX: &str = "Local\\ESP32AgentCompanionService";
    const STOP: &str = "Local\\ESP32AgentCompanionServiceStop";
    const TAKEOVER: u32 = 15_000;
    const LOG_LIMIT: u64 = 5 * 1024 * 1024;
    /// A service that runs this long before it stops is not failing.
    const HEALTHY: Duration = Duration::from_secs(30);

    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(Some(0)).collect()
    }

    pub fn run(mode: Mode) -> i32 {
        // A debug build has a console. The service does not need it.
        #[cfg(debug_assertions)]
        unsafe {
            windows_sys::Win32::System::Console::FreeConsole()
        };
        match mode {
            Mode::Run => supervise(),
            Mode::Stop => stop(),
        }
    }

    fn signal_stop() -> bool {
        let name = wide(STOP);
        let event = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr()) };
        if event.is_null() {
            return false;
        }
        let event = Handle(event);
        unsafe { SetEvent(event.0) };
        true
    }

    /// Waits until no launcher holds the mutex. True when none does.
    fn wait_for_mutex(mutex: HANDLE) -> bool {
        let result = unsafe { WaitForSingleObject(mutex, TAKEOVER) };
        result == WAIT_OBJECT_0 || result == WAIT_ABANDONED
    }

    pub fn stop() -> i32 {
        if !signal_stop() {
            return 0;
        }
        let name = wide(MUTEX);
        let mutex = unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, 0, name.as_ptr()) };
        if mutex.is_null() {
            return 0;
        }
        let mutex = Handle(mutex);
        if wait_for_mutex(mutex.0) {
            unsafe { ReleaseMutex(mutex.0) };
            0
        } else {
            eprintln!("The companion service did not stop.");
            1
        }
    }

    fn supervise() -> i32 {
        let Some(data) = crate::service::data_directory() else { return 1 };
        let mutex_name = wide(MUTEX);
        let mutex = unsafe { CreateMutexW(std::ptr::null(), 1, mutex_name.as_ptr()) };
        if mutex.is_null() {
            return 1;
        }
        // With initial ownership asked for, a mutex that was there already is not owned.
        let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        let mutex = Handle(mutex);
        let stop_name = wide(STOP);
        // Manual reset: it stays set until the next launcher owns the mutex.
        let stop = unsafe { CreateEventW(std::ptr::null(), 1, 0, stop_name.as_ptr()) };
        if stop.is_null() {
            return 1;
        }
        let stop = Handle(stop);
        if existed {
            unsafe { SetEvent(stop.0) };
            if !wait_for_mutex(mutex.0) {
                return 1;
            }
        }
        unsafe { ResetEvent(stop.0) };
        let mut log = Log::new(data.join("companion.log"));
        log.line("[launcher] started");
        let mut failures = 0;
        loop {
            let delay = match start(&data, &mut log) {
                Some(mut child) => {
                    let _job = tie_to_launcher(&child);
                    let started = Instant::now();
                    loop {
                        if wait(stop.0, Duration::from_millis(500)) {
                            let _ = child.kill();
                            let _ = child.wait();
                            return stopped(&mut log, &mutex);
                        }
                        if let Ok(Some(status)) = child.try_wait() {
                            log.line(&format!("[launcher] the service stopped: {status}"));
                            break;
                        }
                    }
                    failures = if started.elapsed() >= HEALTHY { 0 } else { failures + 1 };
                    restart_delay(failures)
                }
                None => {
                    failures += 1;
                    restart_delay(failures)
                }
            };
            if wait(stop.0, delay) {
                return stopped(&mut log, &mutex);
            }
        }
    }

    /// Lets the next launcher, or a stop that waits, take the mutex.
    fn stopped(log: &mut Log, mutex: &Handle) -> i32 {
        log.line("[launcher] stopped");
        unsafe { ReleaseMutex(mutex.0) };
        0
    }

    /// The service stops when this launcher does, however it stops (an installer or
    /// Task Manager can end it). Else the old service keeps the pipe, and no new one starts.
    /// Programs the service starts (the desktop app, an uninstall) are not in the job.
    fn tie_to_launcher(child: &Child) -> Option<Handle> {
        use std::os::windows::io::AsRawHandle;
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let job = Handle(job);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags =
                JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
            let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
            let info = &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const core::ffi::c_void;
            if SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, info, size) == 0
                || AssignProcessToJobObject(job.0, child.as_raw_handle() as HANDLE) == 0
            {
                return None;
            }
            Some(job)
        }
    }

    fn wait(event: HANDLE, time: Duration) -> bool {
        unsafe { WaitForSingleObject(event, time.as_millis().min(u32::MAX as u128) as u32) == WAIT_OBJECT_0 }
    }

    fn start(data: &std::path::Path, log: &mut Log) -> Option<Child> {
        let config: ServiceConfig = match std::fs::read_to_string(data.join("service.json")) {
            Ok(text) => match parse_config(&text) {
                Some(config) => config,
                None => {
                    log.line("[launcher] service.json is not valid");
                    return None;
                }
            },
            Err(error) => {
                log.line(&format!("[launcher] cannot read service.json: {error}"));
                return None;
            }
        };
        let (stdout, stderr) = log.handles();
        let mut command = Command::new(&config.node);
        command
            .arg(&config.cli)
            .arg("daemon")
            .envs(&config.environment)
            .stdin(Stdio::null())
            .stdout(stdout)
            .stderr(stderr);
        service_command(&mut command);
        if let Some(folder) = config.cli.parent() {
            command.current_dir(folder);
        }
        match command.spawn() {
            Ok(child) => Some(child),
            Err(error) => {
                log.line(&format!("[launcher] cannot start {}: {error}", config.node.display()));
                None
            }
        }
    }

    struct Log {
        path: PathBuf,
    }

    impl Log {
        fn new(path: PathBuf) -> Self {
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            // Keep one older log, so the log cannot grow without limit.
            if std::fs::metadata(&path).map(|it| it.len() > LOG_LIMIT).unwrap_or(false) {
                let _ = std::fs::rename(&path, path.with_extension("log.old"));
            }
            Self { path }
        }

        fn line(&mut self, text: &str) {
            use std::io::Write;
            if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&self.path) {
                let _ = writeln!(file, "{text}");
            }
        }

        fn handles(&self) -> (Stdio, Stdio) {
            let open = || OpenOptions::new().create(true).append(true).open(&self.path);
            match (open(), open()) {
                (Ok(out), Ok(err)) => (out.into(), err.into()),
                _ => (Stdio::null(), Stdio::null()),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_launcher_modes_come_from_the_first_argument() {
        let args = |list: &[&str]| list.iter().map(|it| it.to_string()).collect::<Vec<_>>();
        assert_eq!(options(&args(&["app", "--companion-service"])), Some(Mode::Run));
        assert_eq!(options(&args(&["app", "--companion-service-stop"])), Some(Mode::Stop));
        assert_eq!(options(&args(&["app", "--settings"])), None);
        assert_eq!(options(&args(&["app"])), None);
    }

    #[test]
    fn the_service_config_needs_absolute_paths() {
        let (node, cli) = if cfg!(windows) {
            ("C:\\\\n\\\\node.exe", "C:\\\\a\\\\cli.js")
        } else {
            ("/n/node", "/a/cli.js")
        };
        let config = parse_config(&format!(
            r#"{{"node":"{node}","cli":"{cli}","environment":{{"CODEX_HOME":"x"}}}}"#
        ))
        .unwrap();
        assert_eq!(config.environment.get("CODEX_HOME").map(String::as_str), Some("x"));
        assert_eq!(parse_config(r#"{"node":"node","cli":"cli.js"}"#), None);
        assert_eq!(parse_config("not json"), None);
    }

    #[test]
    fn a_service_that_keeps_failing_waits_longer() {
        assert_eq!(restart_delay(0).as_secs(), 2);
        assert_eq!(restart_delay(1).as_secs(), 4);
        assert_eq!(restart_delay(4).as_secs(), 32);
        assert_eq!(restart_delay(9).as_secs(), 60);
    }
}

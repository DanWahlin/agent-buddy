//! The companion service (the ESP32 daemon) that comes inside a release build.
//!
//! `scripts/bundle-daemon.mjs` puts the daemon, a Node.js runtime and the
//! character packs in the app's `daemon-runtime` resource. When no daemon
//! answers, the app copies that folder to the daemon's data folder and installs
//! the service and the agents' hooks from the copy. They then keep working when
//! the app moves, and the service starts when the user signs in, with or
//! without the app. An update of the app updates the copy. A daemon that runs
//! from another folder, such as a clone of the repository, is left alone.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::daemon;

const RUNTIME: &str = "daemon-runtime";
/// The Node.js program at the top of the runtime folder.
const NODE: &str = if cfg!(windows) { "node.exe" } else { "node" };
/// How long a daemon has to answer before the app installs its own. The
/// service manager restarts a daemon that stops within a few seconds.
const WAIT_FOR_DAEMON: Duration = Duration::from_secs(10);
const RETRY: Duration = Duration::from_secs(2);
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);
/// Set while `ensure` runs, so a second start of the app does not install
/// the service again while the first start does.
static ENSURING: AtomicBool = AtomicBool::new(false);
/// PATH, then the variables that move an agent's settings folder. The hook
/// installer must see the same values as the agents, and the service keeps them.
const SHELL_VARIABLES: [&str; 7] = [
    "PATH",
    "COPILOT_HOME",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "GROK_HOME",
    "HERMES_HOME",
    "OPENCLAW_HOME",
];

#[derive(Debug, PartialEq)]
pub enum Action {
    /// Another daemon runs, or this app's copy at this version.
    Leave,
    /// This app's copy runs at another version.
    Install,
    /// No daemon answers yet.
    Wait,
}

/// What to do with the daemon that answered (or did not), given where this
/// app installs its copy and the version it carries. `rebuilt` is true when
/// the copy is from another build of the same version.
pub fn decide(status: Option<&Value>, installed: &Path, version: &str, rebuilt: bool) -> Action {
    let Some(status) = status else { return Action::Wait };
    let service = status.get("service");
    let root = service.and_then(|it| it.get("root")).and_then(Value::as_str);
    let running = service.and_then(|it| it.get("version")).and_then(Value::as_str);
    match root {
        Some(root) if same_path(Path::new(root), installed) && (running != Some(version) || rebuilt) => Action::Install,
        _ => Action::Leave,
    }
}

/// True when the bundled runtime has a `BUILD_HASH` file and the copy has another one.
fn rebuilt(bundled: &Path, installed: &Path) -> bool {
    let read = |folder: &Path| std::fs::read_to_string(folder.join("BUILD_HASH")).ok().map(|it| it.trim().to_string());
    match read(bundled) {
        Some(build) => read(installed).as_deref() != Some(build.as_str()),
        None => false,
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Where the daemon keeps its files. Mirrors `defaultDataDirectory` in
/// `daemon/src/paths.ts`.
pub fn data_directory() -> Option<PathBuf> {
    if cfg!(windows) {
        let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).filter(|it| it.is_absolute())
            .or_else(|| std::env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join("AppData").join("Local")))?;
        return Some(local.join("ESP32 Agent Companion"));
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    if cfg!(target_os = "macos") {
        return Some(home.join("Library/Application Support/ESP32 Agent Companion"));
    }
    let state = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/state"));
    Some(state.join("esp32-agent-companion"))
}

/// Start the daemon this app carries, when no other daemon runs. Blocks for
/// up to `WAIT_FOR_DAEMON`, so call it off the main thread. Returns true when
/// it installed a service where none ran, so the user is new to the app.
/// Whether this build carries the companion service: a release build does,
/// a build run from the repository does not.
pub fn bundled(resources: Option<&Path>) -> bool {
    resources.is_some_and(|it| it.join(RUNTIME).join("VERSION").is_file())
}

pub fn ensure(resources: Option<PathBuf>) -> bool {
    if ENSURING.swap(true, Ordering::AcqRel) {
        return false;
    }
    let result = ensure_once(resources);
    ENSURING.store(false, Ordering::Release);
    result
}

fn ensure_once(resources: Option<PathBuf>) -> bool {
    let Some(bundled) = resources.map(|it| it.join(RUNTIME)) else { return false };
    let Ok(version) = std::fs::read_to_string(bundled.join("VERSION")) else { return false };
    let version = version.trim().to_string();
    let (Some(socket), Some(data)) = (daemon::socket_path(), data_directory()) else { return false };
    let installed = data.join("runtime");
    let started = Instant::now();
    let upgrade = loop {
        let status = daemon::request(&socket, &json!({ "type": "status" }));
        match decide(status.as_ref(), &installed, &version, rebuilt(&bundled, &installed)) {
            Action::Leave => return false,
            Action::Install => break true,
            Action::Wait if started.elapsed() >= WAIT_FOR_DAEMON => break false,
            Action::Wait => std::thread::sleep(RETRY),
        }
    };
    println!("[service] installing the companion service {version}");
    match install(&bundled, &installed, &version) {
        Ok(()) => {
            println!("[service] the companion service runs from {}", installed.display());
            !upgrade
        }
        Err(error) => {
            eprintln!("[service] could not install the companion service: {error}");
            false
        }
    }
}

fn install(bundled: &Path, installed: &Path, version: &str) -> Result<(), String> {
    let current = std::fs::read_to_string(installed.join("VERSION")).ok();
    if current.as_deref().map(str::trim) != Some(version) || rebuilt(bundled, installed) || !installed.join(NODE).is_file() {
        replace(bundled, installed).map_err(|error| format!("could not copy the service: {error}"))?;
    }
    let mut command = Command::new(installed.join(NODE));
    command
        .arg(installed.join("daemon").join("dist").join("src").join("install.js"))
        .current_dir(installed.join("daemon"))
        .envs(user_environment())
        .stdin(Stdio::null());
    #[cfg(windows)]
    crate::launcher::service_command(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("could not run the installer: {error}"))?;
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        println!("[service] {line}");
    }
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

/// Copy beside the old folder, then swap, so a failed copy changes nothing.
/// A daemon that runs from the old folder keeps its open files until the
/// installer restarts it.
fn replace(bundled: &Path, installed: &Path) -> std::io::Result<()> {
    let parent = installed.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
    create_private_dir(parent)?;
    let staging = parent.join("runtime.new");
    let old = parent.join("runtime.old");
    let _ = std::fs::remove_dir_all(&staging);
    let _ = std::fs::remove_dir_all(&old);
    copy_dir(bundled, &staging)?;
    // A downloaded app's files are quarantined, and the copies would be too.
    #[cfg(target_os = "macos")]
    let _ = Command::new("/usr/bin/xattr")
        .args(["-dr", "com.apple.quarantine"])
        .arg(&staging)
        .stderr(Stdio::null())
        .status();
    if installed.exists() {
        // Windows cannot rename a folder while a program in it runs. The
        // installer starts the service again.
        #[cfg(windows)]
        if !crate::launcher::stop_service() {
            eprintln!("[service] the old companion service did not stop");
        }
        rename(installed, &old)?;
    }
    rename(&staging, installed)?;
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
}

/// On Windows, a program that just stopped, or a virus scanner, can keep a
/// file open for a short time, so try again.
fn rename(from: &Path, to: &Path) -> std::io::Result<()> {
    let tries = if cfg!(windows) { 20 } else { 1 };
    let mut result = std::fs::rename(from, to);
    for _ in 1..tries {
        if result.is_ok() {
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
        result = std::fs::rename(from, to);
    }
    result
}

fn create_private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)
}

/// A recursive copy that keeps file modes and symbolic links.
fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let (source, target) = (entry.path(), to.join(entry.file_name()));
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_dir(&source, &target)?;
        } else if kind.is_symlink() {
            #[cfg(unix)]
            std::os::unix::fs::symlink(std::fs::read_link(&source)?, &target)?;
        } else {
            std::fs::copy(&source, &target)?;
        }
    }
    Ok(())
}

/// The user's own PATH and agent folder variables, from their login shell: an
/// app opened from the Dock or a launcher gets a short PATH and none of the
/// variables. The service and the hook installer use them to find the agents'
/// CLIs and settings.
fn user_environment() -> Vec<(&'static str, String)> {
    // Windows gives every program the user's own variables, and has no login shell to ask.
    if cfg!(windows) {
        return Vec::new();
    }
    let shell = login_shell_values().unwrap_or_default();
    let mut result = vec![("PATH", merge_paths(shell.first().map_or("", String::as_str),
                                               &std::env::var("PATH").unwrap_or_default()))];
    for (name, value) in SHELL_VARIABLES.iter().zip(shell.iter()).skip(1) {
        if !value.is_empty() {
            result.push((name, value.clone()));
        }
    }
    result
}

fn login_shell_values() -> Option<Vec<String>> {
    use std::io::Read;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    // printf repeats its format for each value. Plain "$NAME" works in sh, bash, zsh and fish.
    let values: Vec<String> = SHELL_VARIABLES.iter().map(|name| format!("\"${name}\"")).collect();
    let mut child = Command::new(shell)
        .args(["-ilc", &format!("printf '{SHELL_MARK}%s{SHELL_MARK}' {}", values.join(" "))])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        let _ = sender.send(text);
    });
    let text = receiver.recv_timeout(SHELL_TIMEOUT);
    let _ = child.kill();
    let _ = child.wait();
    parse_shell_values(&text.ok()?)
}

const SHELL_MARK: &str = "__AGENT_COMPANION_ENV__";

/// The text a login shell printed: anything (such as a greeting), then
/// MARK value MARK for each variable, in order.
fn parse_shell_values(text: &str) -> Option<Vec<String>> {
    let start = text.find(SHELL_MARK)?;
    let parts: Vec<&str> = text[start..].split(SHELL_MARK).collect();
    let values: Vec<String> = parts.iter().skip(1).step_by(2).take(SHELL_VARIABLES.len())
        .map(|value| value.to_string()).collect();
    (values.len() == SHELL_VARIABLES.len()).then_some(values)
}

/// Absolute entries only, the first of each, the shell's first.
fn merge_paths(first: &str, second: &str) -> String {
    let mut entries: Vec<&str> = Vec::new();
    for entry in first.split(':').chain(second.split(':')) {
        if entry.starts_with('/') && !entries.contains(&entry) {
            entries.push(entry);
        }
    }
    entries.join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_this_apps_copy_at_another_version_is_replaced() {
        let installed = Path::new("/data/runtime");
        let status = |root: &str, version: &str| json!({ "service": { "root": root, "version": version } });
        assert_eq!(decide(None, installed, "0.8.0", false), Action::Wait);
        assert_eq!(decide(Some(&status("/data/runtime", "0.7.0")), installed, "0.8.0", false), Action::Install);
        assert_eq!(decide(Some(&status("/data/runtime", "0.8.0")), installed, "0.8.0", false), Action::Leave);
        // Another build of the same version.
        assert_eq!(decide(Some(&status("/data/runtime", "0.8.0")), installed, "0.8.0", true), Action::Install);
        // A clone of the repository, or a daemon too old to say where it runs.
        assert_eq!(decide(Some(&status("/src/companion", "0.7.0")), installed, "0.8.0", true), Action::Leave);
        assert_eq!(decide(Some(&json!({ "state": "idle" })), installed, "0.8.0", true), Action::Leave);
    }

    #[test]
    fn a_new_build_hash_replaces_the_copy() {
        let root = std::env::temp_dir().join(format!("companion-build-{}", std::process::id()));
        let (bundled, installed) = (root.join("bundled"), root.join("installed"));
        std::fs::create_dir_all(&bundled).unwrap();
        std::fs::create_dir_all(&installed).unwrap();
        // A bundle without BUILD_HASH, as earlier versions made, changes nothing.
        assert!(!rebuilt(&bundled, &installed));
        std::fs::write(bundled.join("BUILD_HASH"), "abc\n").unwrap();
        assert!(rebuilt(&bundled, &installed));
        std::fs::write(installed.join("BUILD_HASH"), "abc").unwrap();
        assert!(!rebuilt(&bundled, &installed));
        std::fs::write(installed.join("BUILD_HASH"), "def").unwrap();
        assert!(rebuilt(&bundled, &installed));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_shells_path_comes_first_without_repeats_or_relative_entries() {
        assert_eq!(
            merge_paths("/opt/homebrew/bin:/usr/bin:bin", "/usr/bin:/bin:"),
            "/opt/homebrew/bin:/usr/bin:/bin"
        );
    }

    #[test]
    fn the_shells_values_are_read_in_order_after_any_greeting() {
        let mark = SHELL_MARK;
        let mut text = format!("Welcome!\n{mark}/opt/homebrew/bin:/usr/bin{mark}");
        for value in ["", "", "/work/codex", "", "", ""] {
            text.push_str(&format!("{mark}{value}{mark}"));
        }
        let values = parse_shell_values(&text).unwrap();
        assert_eq!(values[0], "/opt/homebrew/bin:/usr/bin");
        assert_eq!(values[3], "/work/codex");
        assert_eq!(parse_shell_values(&format!("{mark}/usr/bin{mark}")), None);
        assert_eq!(parse_shell_values("no marks"), None);
    }

    #[test]
    fn a_copy_keeps_modes_and_links() {
        let root = std::env::temp_dir().join(format!("companion-copy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let from = root.join("from");
        std::fs::create_dir_all(from.join("bin")).unwrap();
        std::fs::write(from.join("bin/node"), "#!/bin/sh\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(from.join("bin/node"), std::fs::Permissions::from_mode(0o755)).unwrap();
            std::os::unix::fs::symlink("bin/node", from.join("link")).unwrap();
        }
        replace(&from, &root.join("data/runtime")).unwrap();
        let copied = root.join("data/runtime");
        assert_eq!(std::fs::read_to_string(copied.join("bin/node")).unwrap(), "#!/bin/sh\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(copied.join("bin/node")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o755);
            assert_eq!(std::fs::read_link(copied.join("link")).unwrap(), Path::new("bin/node"));
        }
        // A second copy replaces the first, and leaves nothing beside it.
        replace(&from, &copied).unwrap();
        assert!(!root.join("data/runtime.old").exists() && !root.join("data/runtime.new").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }
}

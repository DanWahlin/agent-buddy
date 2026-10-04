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
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::daemon;

const RUNTIME: &str = "daemon-runtime";
/// How long a daemon has to answer before the app installs its own. The
/// service manager restarts a daemon that stops within a few seconds.
const WAIT_FOR_DAEMON: Duration = Duration::from_secs(10);
const RETRY: Duration = Duration::from_secs(2);
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);

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
/// app installs its copy and the version it carries.
pub fn decide(status: Option<&Value>, installed: &Path, version: &str) -> Action {
    let Some(status) = status else { return Action::Wait };
    let service = status.get("service");
    let root = service.and_then(|it| it.get("root")).and_then(Value::as_str);
    let running = service.and_then(|it| it.get("version")).and_then(Value::as_str);
    match root {
        Some(root) if same_path(Path::new(root), installed) && running != Some(version) => Action::Install,
        _ => Action::Leave,
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
        return None;
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
pub fn ensure(resources: Option<PathBuf>) -> bool {
    let Some(bundled) = resources.map(|it| it.join(RUNTIME)) else { return false };
    let Ok(version) = std::fs::read_to_string(bundled.join("VERSION")) else { return false };
    let version = version.trim().to_string();
    let (Some(socket), Some(data)) = (daemon::socket_path(), data_directory()) else { return false };
    let installed = data.join("runtime");
    let started = Instant::now();
    let upgrade = loop {
        let status = daemon::request(&socket, &json!({ "type": "status" }));
        match decide(status.as_ref(), &installed, &version) {
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
    if current.as_deref().map(str::trim) != Some(version) || !installed.join("node").is_file() {
        replace(bundled, installed).map_err(|error| format!("could not copy the service: {error}"))?;
    }
    let output = Command::new(installed.join("node"))
        .arg(installed.join("daemon/dist/src/install.js"))
        .current_dir(installed.join("daemon"))
        .env("PATH", user_path())
        .stdin(Stdio::null())
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
        std::fs::rename(installed, &old)?;
    }
    std::fs::rename(&staging, installed)?;
    let _ = std::fs::remove_dir_all(&old);
    Ok(())
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

/// The user's own PATH, from their login shell: an app opened from the Dock or
/// a launcher gets a short one. The service and the hook installer use it to
/// find the agents' CLIs.
fn user_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let shell = login_shell_path().unwrap_or_default();
    merge_paths(&shell, &current)
}

fn login_shell_path() -> Option<String> {
    use std::io::Read;
    const MARK: &str = "__AGENT_COMPANION_PATH__";
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let mut child = Command::new(shell)
        .args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
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
    let text = text.ok()?;
    let start = text.find(MARK)? + MARK.len();
    let end = start + text[start..].find(MARK)?;
    Some(text[start..end].to_string())
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
        assert_eq!(decide(None, installed, "0.8.0"), Action::Wait);
        assert_eq!(decide(Some(&status("/data/runtime", "0.7.0")), installed, "0.8.0"), Action::Install);
        assert_eq!(decide(Some(&status("/data/runtime", "0.8.0")), installed, "0.8.0"), Action::Leave);
        // A clone of the repository, or a daemon too old to say where it runs.
        assert_eq!(decide(Some(&status("/src/companion", "0.7.0")), installed, "0.8.0"), Action::Leave);
        assert_eq!(decide(Some(&json!({ "state": "idle" })), installed, "0.8.0"), Action::Leave);
    }

    #[test]
    fn the_shells_path_comes_first_without_repeats_or_relative_entries() {
        assert_eq!(
            merge_paths("/opt/homebrew/bin:/usr/bin:bin", "/usr/bin:/bin:"),
            "/opt/homebrew/bin:/usr/bin:/bin"
        );
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

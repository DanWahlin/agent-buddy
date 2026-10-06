//! Following the ESP32 Agent Companion daemon.
//!
//! The daemon already has every agent's hooks, the state coordinator, the badge
//! roles, the character and the settings. The desktop is a second screen for
//! it, so it asks the daemon rather than doing any of that again: `status`
//! over the daemon's own socket, a few times a second. The daemon only answers
//! requests - it has no event stream - and a local round trip costs nothing.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;

use serde_json::{json, Value};

const POLL: Duration = Duration::from_millis(400);
#[cfg(unix)]
const TIMEOUT: Duration = Duration::from_millis(1500);
const MAX_REPLY_BYTES: u64 = 256 * 1024;
const MAX_BADGES: usize = 4;
const ROLES: [&str; 3] = ["working", "attention", "complete"];
const STATES: [&str; 5] = ["idle", "surprise", "working", "complete", "attention"];

/// The cue volume when the daemon does not give one, as Settings has it.
pub const DEFAULT_VOLUME: u8 = 30;

/// What the desktop takes from the daemon's status.
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub state: String,
    /// The character to show, and the `.acpk` the daemon would install for it.
    pub character: Option<String>,
    pub pack: Option<PathBuf>,
    pub visible: bool,
    pub backdrop: String,
    /// Whether the page plays the device's sound cues. Off unless turned on.
    pub sounds: bool,
    /// How loud the cues play, 0 to 100.
    pub volume: u8,
    /// Whether a device is connected; without one the desktop picks the character.
    pub connected: bool,
    /// Already filtered by the badge setting and cut to four, as the device gets them.
    pub badges: Vec<(String, String)>,
    pub icons: Vec<(String, String, String)>,
    /// "AIC: 902", "Tokens: 1.2M": the lines the device shows at the bottom of
    /// its screen. Empty when usage is off in Settings.
    pub usage: Vec<String>,
    /// A character being installed on the device (name, percent), and the
    /// result of the last install, so the desktop can show what the device does.
    pub installing: Value,
    pub last_install: Value,
}

impl Snapshot {
    /// What the page needs: the state, backdrop, sounds, volume, badges and usage.
    pub fn for_page(&self) -> Value {
        json!({
            "state": self.state,
            "visible": self.visible,
            "backdrop": self.backdrop,
            "sounds": self.sounds,
            "volume": self.volume,
            "badges": self.badges.iter()
                .map(|(id, role)| json!({ "id": id, "role": role }))
                .collect::<Vec<_>>(),
            "icons": self.icons.iter()
                .map(|(id, color, mask)| json!({ "id": id, "color": color, "mask": mask }))
                .collect::<Vec<_>>(),
            "usage": self.usage,
            "installing": self.installing,
            "lastInstall": self.last_install,
            "connected": self.connected,
        })
    }
}

/// Where the daemon listens. Mirrors `daemon/src/paths.ts`.
///
/// On Windows that is a named pipe per user, not a file.
pub fn socket_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("AGENT_COMPANION_SOCKET") {
        return Some(PathBuf::from(path));
    }
    if cfg!(windows) {
        return Some(PathBuf::from(windows_pipe_name(&std::env::var("USERNAME").ok()?)));
    }
    let home = PathBuf::from(std::env::var_os("HOME")?);
    if cfg!(target_os = "macos") {
        return Some(home.join("Library/Application Support/ESP32 Agent Companion/daemon.sock"));
    }
    if let Some(runtime) = std::env::var_os("XDG_RUNTIME_DIR") {
        return Some(PathBuf::from(runtime).join("esp32-agent-companion/daemon.sock"));
    }
    let uid = home_owner_uid()?;
    Some(std::env::temp_dir().join(format!("esp32-agent-companion-{uid}/daemon.sock")))
}

/// The user id without libc: the owner of the home directory is the user.
pub fn home_owner_uid() -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let home = std::env::var_os("HOME")?;
        return std::fs::metadata(home).ok().map(|meta| meta.uid());
    }
    #[allow(unreachable_code)]
    None
}

/// One request, one newline-delimited JSON reply.
#[cfg(unix)]
pub fn request(path: &std::path::Path, body: &Value) -> Option<Value> {
    use std::os::unix::net::UnixStream;
    let mut stream = UnixStream::connect(path).ok()?;
    stream.set_read_timeout(Some(TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(TIMEOUT)).ok()?;
    stream.write_all(format!("{body}\n").as_bytes()).ok()?;
    stream.shutdown(std::net::Shutdown::Write).ok()?;
    let mut reply = String::new();
    stream.take(MAX_REPLY_BYTES).read_to_string(&mut reply).ok()?;
    serde_json::from_str(reply.trim()).ok()
}

/// The pipe name `paths.ts` builds from the user name. Node counts UTF-16
/// units, so a character outside that safe set becomes one `_` per unit.
pub fn windows_pipe_name(user: &str) -> String {
    let mut safe = String::new();
    for c in user.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            safe.push(c);
        } else {
            safe.extend(std::iter::repeat('_').take(c.len_utf16()));
        }
    }
    safe.truncate(64);
    if safe.is_empty() {
        safe.push_str("user");
    }
    format!(r"\\.\pipe\esp32-agent-companion-{safe}")
}

/// One request, one newline-delimited JSON reply. A named pipe cannot
/// half-close, so the daemon answers at the newline and then ends the pipe.
#[cfg(windows)]
pub fn request(path: &std::path::Path, body: &Value) -> Option<Value> {
    const ERROR_PIPE_BUSY: i32 = 231;
    let mut pipe = None;
    for _ in 0..10 {
        match std::fs::OpenOptions::new().read(true).write(true).open(path) {
            Ok(file) => {
                pipe = Some(file);
                break;
            }
            Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY) => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
    let mut pipe = pipe?;
    pipe.write_all(format!("{body}\n").as_bytes()).ok()?;
    let mut reply = String::new();
    pipe.take(MAX_REPLY_BYTES).read_to_string(&mut reply).ok()?;
    serde_json::from_str(reply.trim()).ok()
}

#[cfg(not(any(unix, windows)))]
pub fn request(_path: &std::path::Path, _body: &Value) -> Option<Value> {
    None
}

/// Read the parts of a status reply the desktop uses, tolerating an older daemon.
pub fn parse(status: &Value) -> Option<Snapshot> {
    let state = status.get("state")?.as_str()?;
    if !STATES.contains(&state) {
        return None;
    }
    let desktop = status.get("desktop");
    let badges = status.get("badges");
    let device = status
        .get("character")
        .and_then(Value::as_str)
        .filter(|id| *id != "none")
        .map(str::to_string);
    let character = desktop
        .and_then(|it| it.get("character"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or(device);
    let enabled = badges.and_then(|it| it.get("enabled")).and_then(Value::as_bool) != Some(false);
    let active = if enabled {
        badges
            .and_then(|it| it.get("active"))
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let id = item.get("id")?.as_str()?;
                        let role = item.get("role")?.as_str()?;
                        ROLES.contains(&role).then(|| (id.to_string(), role.to_string()))
                    })
                    .take(MAX_BADGES)
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let icons = badges
        .and_then(|it| it.get("icons"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some((
                        item.get("id")?.as_str()?.to_string(),
                        item.get("color")?.as_str()?.to_string(),
                        item.get("mask")?.as_str()?.to_string(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Snapshot {
        state: state.to_string(),
        character,
        pack: desktop
            .and_then(|it| it.get("pack"))
            .and_then(Value::as_str)
            .map(PathBuf::from),
        visible: desktop.and_then(|it| it.get("visible")).and_then(Value::as_bool) != Some(false),
        connected: status.get("connected").and_then(Value::as_bool) == Some(true),
        backdrop: desktop
            .and_then(|it| it.get("backdrop"))
            .and_then(Value::as_str)
            .unwrap_or("device")
            .to_string(),
        sounds: desktop.and_then(|it| it.get("sounds")).and_then(Value::as_bool) == Some(true),
        volume: desktop
            .and_then(|it| it.get("volume"))
            .and_then(Value::as_u64)
            .filter(|it| *it <= 100)
            .map_or(DEFAULT_VOLUME, |it| it as u8),
        badges: active,
        icons,
        usage: status
            .get("usage")
            .and_then(|it| it.get("lines"))
            .and_then(Value::as_array)
            .map(|lines| lines.iter().filter_map(|line| Some(line.as_str()?.to_string())).collect())
            .unwrap_or_default(),
        installing: status.get("installing").cloned().unwrap_or(Value::Null),
        last_install: status.get("lastInstall").cloned().unwrap_or(Value::Null),
    })
}

/// Poll the daemon for as long as the app runs, calling back on every change,
/// with `None` while it cannot be reached. Settings can stop the app: the
/// daemon then answers with `desktopCommand: "quit"`, and `on_quit` runs.
/// The device's BOOT button sends `desktopCommand: "settings"`, and
/// `on_settings` runs.
pub fn follow(
    on_change: impl Fn(Option<&Snapshot>) + Send + 'static,
    on_quit: impl FnOnce() + Send + 'static,
    on_settings: impl Fn() + Send + 'static,
) {
    let Some(path) = socket_path() else {
        on_change(None);
        return;
    };
    let ask = status_request();
    std::thread::spawn(move || {
        let mut last: Option<Option<Snapshot>> = None;
        loop {
            let reply = request(&path, &ask);
            match reply.as_ref().and_then(command) {
                Some("quit") => {
                    println!("[daemon] Settings closed the app");
                    on_quit();
                    return;
                }
                Some("settings") => {
                    println!("[daemon] the device asked for Settings");
                    on_settings();
                }
                _ => {}
            }
            let snapshot = reply.and_then(|it| parse(&it));
            if last.as_ref() != Some(&snapshot) {
                match (&last, &snapshot) {
                    (Some(None) | None, Some(_)) => {
                        println!("[daemon] following {}", path.display())
                    }
                    (Some(Some(_)), None) => println!("[daemon] lost"),
                    _ => {}
                }
                on_change(snapshot.as_ref());
                last = Some(snapshot);
            }
            std::thread::sleep(POLL);
        }
    });
}

/// The display variables the app sends with each status request. Settings
/// sees that the app runs, and the daemon can start it again after it closes.
const DISPLAY_VARIABLES: [&str; 8] = [
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "XAUTHORITY",
    "XDG_RUNTIME_DIR",
    "XDG_SESSION_TYPE",
    "XDG_CURRENT_DESKTOP",
    "DBUS_SESSION_BUS_ADDRESS",
    "HYPRLAND_INSTANCE_SIGNATURE",
];

/// The release this app was built from: the repository's VERSION file, read by build.rs.
pub const APP_VERSION: &str = env!("AGENT_COMPANION_VERSION");

fn status_request() -> Value {
    // flasher: this app installs firmware over USB when run with --flash-firmware.
    let mut body = json!({ "type": "status", "client": "desktop", "flasher": 1, "version": APP_VERSION });
    if let Some(path) = launch_path() {
        body["executable"] = json!(path.to_string_lossy());
    }
    // A service manager does not always give the daemon the display, and the
    // app needs it when the daemon starts it.
    let environment: serde_json::Map<String, Value> = DISPLAY_VARIABLES
        .iter()
        .filter_map(|name| Some((name.to_string(), json!(std::env::var(name).ok()?))))
        .collect();
    body["environment"] = Value::Object(environment);
    body
}

fn command(reply: &Value) -> Option<&str> {
    reply.get("desktopCommand").and_then(Value::as_str)
}

/// What to run to start this app again: the AppImage rather than its
/// temporary mount, and the `.app` bundle rather than the binary inside it.
fn launch_path() -> Option<PathBuf> {
    if cfg!(target_os = "linux") {
        if let Some(image) = std::env::var_os("APPIMAGE") {
            return Some(PathBuf::from(image));
        }
    }
    let executable = std::env::current_exe().ok()?;
    Some(app_bundle(&executable).unwrap_or(executable))
}

/// `/Applications/X.app/Contents/MacOS/x` -> `/Applications/X.app`.
fn app_bundle(executable: &std::path::Path) -> Option<PathBuf> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    let is_bundle = macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app";
    is_bundle.then(|| bundle.to_path_buf())
}

/// Turn the page's sounds on or off. The daemon keeps the setting, so Settings
/// shows the same; true when it took the change.
pub fn set_sounds(on: bool) -> bool {
    let Some(path) = socket_path() else { return false };
    let reply = request(&path, &json!({ "type": "desktop", "sounds": on }));
    reply.and_then(|it| it.get("ok")?.as_bool()) == Some(true)
}

/// The settings page's address, with its private token, from the daemon.
pub fn settings_url() -> Option<String> {
    let reply = request(&socket_path()?, &json!({ "type": "settings" }))?;
    reply.get("url")?.as_str().map(str::to_string)
}

/// Whether this computer has used a device. None when no daemon answers, or
/// an older one does not say.
pub fn device_used() -> Option<bool> {
    let reply = request(&socket_path()?, &json!({ "type": "status" }))?;
    reply.get("deviceUsed")?.as_bool()
}

/// Ask the daemon to stop its service. True when it took the request.
pub fn stop_service() -> bool {
    let Some(path) = socket_path() else { return false };
    let reply = request(&path, &json!({ "type": "stopService" }));
    reply.and_then(|it| it.get("ok")?.as_bool()) == Some(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_windows_pipe_name_matches_the_daemon() {
        assert_eq!(windows_pipe_name("Dan"), r"\\.\pipe\esp32-agent-companion-Dan");
        assert_eq!(windows_pipe_name("Dan W"), r"\\.\pipe\esp32-agent-companion-Dan_W");
        assert_eq!(windows_pipe_name("dé😀"), r"\\.\pipe\esp32-agent-companion-d___");
        assert_eq!(windows_pipe_name(""), r"\\.\pipe\esp32-agent-companion-user");
        assert_eq!(windows_pipe_name(&"a".repeat(80)).len(), r"\\.\pipe\esp32-agent-companion-".len() + 64);
    }

    #[test]
    fn a_status_gives_the_character_visibility_backdrop_and_badges() {
        let status = json!({
            "state": "working", "character": "openclaw",
            "badges": {
                "enabled": true,
                "active": [
                    { "id": "copilot", "role": "working" }, { "id": "claude", "role": "working" },
                    { "id": "codex", "role": "attention" }, { "id": "grok", "role": "working" },
                    { "id": "hermes", "role": "working" }, { "id": "bad", "role": "dancing" }
                ],
                "icons": [{ "id": "copilot", "name": "x", "color": "#8F9BFF", "mask": "AAAA" }, { "id": "broken" }]
            },
            "desktop": { "visible": false, "backdrop": "device", "sounds": true, "volume": 30, "character": "claude", "pack": "/p/claude.acpk" }
        });
        let snapshot = parse(&status).unwrap();
        assert!(snapshot.sounds);
        assert_eq!(snapshot.for_page()["sounds"], true);
        assert_eq!(snapshot.volume, 30);
        assert_eq!(snapshot.for_page()["volume"], 30);
        assert_eq!(snapshot.character.as_deref(), Some("claude"));
        assert_eq!(snapshot.pack, Some(PathBuf::from("/p/claude.acpk")));
        assert!(!snapshot.visible);
        assert_eq!(snapshot.backdrop, "device");
        assert_eq!(snapshot.badges.len(), 4);
        assert_eq!(snapshot.badges[2], ("codex".to_string(), "attention".to_string()));
        assert_eq!(snapshot.icons, vec![("copilot".into(), "#8F9BFF".into(), "AAAA".into())]);
        assert!(snapshot.installing.is_null());

        let installing = parse(&json!({
            "state": "idle", "transport": "wifi",
            "installing": { "character": "claude", "name": "Claude", "percent": 42 },
            "lastInstall": null
        })).unwrap();
        assert_eq!(installing.installing["name"], "Claude");
        assert_eq!(installing.installing["percent"], 42);
        assert_eq!(installing.for_page()["installing"]["percent"], 42);
    }

    #[test]
    fn the_app_names_its_bundle_and_obeys_a_quit() {
        assert_eq!(
            app_bundle(std::path::Path::new("/Applications/Agent Companion.app/Contents/MacOS/agent-companion")),
            Some(PathBuf::from("/Applications/Agent Companion.app"))
        );
        assert_eq!(app_bundle(std::path::Path::new("/repo/target/release/agent-companion")), None);
        let body = status_request();
        assert_eq!(body["type"], "status");
        assert_eq!(body["client"], "desktop");
        assert_eq!(body["version"], APP_VERSION);
        assert!(!APP_VERSION.is_empty());
        assert!(body["executable"].as_str().is_some_and(|it| std::path::Path::new(it).is_absolute()));
        assert!(body["environment"].as_object().unwrap().keys().all(|it| DISPLAY_VARIABLES.contains(&it.as_str())));
        assert_eq!(
            command(&json!({ "state": "idle", "desktopCommand": "quit" })),
            Some("quit")
        );
        assert_eq!(
            command(&json!({ "state": "idle", "desktopCommand": "settings" })),
            Some("settings")
        );
        assert_eq!(command(&json!({ "state": "idle" })), None);
    }

    #[test]
    fn badges_switched_off_show_none_as_on_the_device() {
        let status = json!({
            "state": "working",
            "badges": { "enabled": false, "active": [{ "id": "copilot", "role": "working" }], "icons": [] }
        });
        assert!(parse(&status).unwrap().badges.is_empty());
    }

    #[test]
    fn usage_lines_pass_through_to_the_page() {
        let status = json!({
            "state": "idle",
            "usage": { "enabled": true, "window": "today", "aic": 902, "tokens": 1200000,
                       "lines": ["AIC: 902", "Tokens: 1.2M"] }
        });
        let snapshot = parse(&status).unwrap();
        assert_eq!(snapshot.usage, vec!["AIC: 902", "Tokens: 1.2M"]);
        assert_eq!(snapshot.for_page()["usage"][1], "Tokens: 1.2M");
        assert!(parse(&json!({ "state": "idle" })).unwrap().usage.is_empty());
    }

    #[test]
    fn an_older_daemon_still_drives_the_desktop() {
        let snapshot = parse(&json!({ "state": "attention", "character": "copilot" })).unwrap();
        assert_eq!(snapshot.character.as_deref(), Some("copilot"));
        assert!(snapshot.visible);
        assert!(!snapshot.connected);
        assert!(!snapshot.sounds);
        assert_eq!(snapshot.volume, DEFAULT_VOLUME);
        assert_eq!(snapshot.backdrop, "device");
        let loud = parse(&json!({ "state": "idle", "desktop": { "volume": 400 } })).unwrap();
        assert_eq!(loud.volume, DEFAULT_VOLUME);
        assert_eq!(parse(&json!({ "state": "idle", "character": "none" })).unwrap().character, None);
        assert!(parse(&json!({ "state": "dancing" })).is_none());
        assert!(parse(&json!([])).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn a_real_socket_round_trip() {
        use std::os::unix::net::UnixListener;
        let path = std::env::temp_dir().join(format!("ac-daemon-{}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut body = String::new();
            stream.read_to_string(&mut body).unwrap();
            assert_eq!(serde_json::from_str::<Value>(body.trim()).unwrap(), json!({ "type": "status" }));
            stream.write_all(b"{\"state\":\"complete\"}\n").unwrap();
        });
        let reply = request(&path, &json!({ "type": "status" })).unwrap();
        server.join().unwrap();
        assert_eq!(parse(&reply).unwrap().state, "complete");
        let _ = std::fs::remove_file(&path);
        assert!(request(&path, &json!({ "type": "status" })).is_none());
    }
}

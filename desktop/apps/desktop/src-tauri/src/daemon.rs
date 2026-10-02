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
const TIMEOUT: Duration = Duration::from_millis(1500);
const MAX_REPLY_BYTES: u64 = 256 * 1024;
const MAX_BADGES: usize = 4;
const ROLES: [&str; 3] = ["working", "attention", "complete"];
const STATES: [&str; 5] = ["idle", "surprise", "working", "complete", "attention"];

/// What the desktop takes from the daemon's status.
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub state: String,
    /// The character to show, and the `.acpk` the daemon would install for it.
    pub character: Option<String>,
    pub pack: Option<PathBuf>,
    pub visible: bool,
    pub backdrop: String,
    /// Whether a device is connected; without one the desktop picks the character.
    pub connected: bool,
    /// Already filtered by the badge setting and cut to four, as the device gets them.
    pub badges: Vec<(String, String)>,
    pub icons: Vec<(String, String, String)>,
}

impl Snapshot {
    /// What the page needs: the state, backdrop and badges.
    pub fn for_page(&self) -> Value {
        json!({
            "state": self.state,
            "backdrop": self.backdrop,
            "badges": self.badges.iter()
                .map(|(id, role)| json!({ "id": id, "role": role }))
                .collect::<Vec<_>>(),
            "icons": self.icons.iter()
                .map(|(id, color, mask)| json!({ "id": id, "color": color, "mask": mask }))
                .collect::<Vec<_>>(),
        })
    }
}

/// Where the daemon listens. Mirrors `daemon/src/paths.ts`.
///
/// The daemon has no Windows build (its README sends Windows users to WSL 2),
/// so on Windows there is nothing to follow.
pub fn socket_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("AGENT_COMPANION_SOCKET") {
        return Some(PathBuf::from(path));
    }
    if cfg!(windows) {
        return None;
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
fn home_owner_uid() -> Option<u32> {
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

#[cfg(not(unix))]
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
        badges: active,
        icons,
    })
}

/// Poll the daemon for as long as the app runs, calling back on every change,
/// with `None` while it cannot be reached.
pub fn follow(on_change: impl Fn(Option<&Snapshot>) + Send + 'static) {
    let Some(path) = socket_path() else {
        on_change(None);
        return;
    };
    std::thread::spawn(move || {
        let mut last: Option<Option<Snapshot>> = None;
        loop {
            let snapshot = request(&path, &json!({ "type": "status" })).and_then(|it| parse(&it));
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

/// Choose the desktop's character, for when no device is connected to choose it.
pub fn set_character(id: &str) -> bool {
    socket_path()
        .and_then(|path| request(&path, &json!({ "type": "desktop", "character": id })))
        .and_then(|reply| reply.get("ok")?.as_bool())
        == Some(true)
}

/// The settings page's address, with its private token, from the daemon.
pub fn settings_url() -> Option<String> {
    let reply = request(&socket_path()?, &json!({ "type": "settings" }))?;
    reply.get("url")?.as_str().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

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
            "desktop": { "visible": false, "backdrop": "device", "character": "claude", "pack": "/p/claude.acpk" }
        });
        let snapshot = parse(&status).unwrap();
        assert_eq!(snapshot.character.as_deref(), Some("claude"));
        assert_eq!(snapshot.pack, Some(PathBuf::from("/p/claude.acpk")));
        assert!(!snapshot.visible);
        assert_eq!(snapshot.backdrop, "device");
        assert_eq!(snapshot.badges.len(), 4);
        assert_eq!(snapshot.badges[2], ("codex".to_string(), "attention".to_string()));
        assert_eq!(snapshot.icons, vec![("copilot".into(), "#8F9BFF".into(), "AAAA".into())]);
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
    fn an_older_daemon_still_drives_the_desktop() {
        let snapshot = parse(&json!({ "state": "attention", "character": "copilot" })).unwrap();
        assert_eq!(snapshot.character.as_deref(), Some("copilot"));
        assert!(snapshot.visible);
        assert!(!snapshot.connected);
        assert_eq!(snapshot.backdrop, "device");
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

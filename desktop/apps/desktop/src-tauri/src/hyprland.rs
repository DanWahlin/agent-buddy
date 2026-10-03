//! Living on Hyprland (Omarchy and others).
//!
//! Hyprland is a tiling Wayland compositor. A new window there is tiled, gets a
//! border, has the desktop blurred behind its transparent corners, and cannot
//! learn where the pointer is or where it sits itself - everything a desktop pet
//! needs to be otherwise. Hyprland's own IPC socket fills those gaps:
//!
//! - `cursorpos` and `j/clients` give the pointer and this window's place, in
//!   the same global layout coordinates, so click-through works on Wayland.
//! - `dispatch` floats and pins the window and switches off its border, shadow
//!   and blur, so it behaves like a pet with no user configuration at all.
//!
//! Hyprland changed its configuration to Lua, and dispatchers with it. Each
//! dispatch is sent in the Lua form first and the classic form if that fails,
//! the same way Omarchy's own scripts do, so both old and new versions work.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;

const TIMEOUT: Duration = Duration::from_millis(500);

/// This window, as Hyprland sees it.
#[derive(Clone, Debug, PartialEq)]
pub struct Client {
    pub address: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub floating: bool,
    pub pinned: bool,
}

/// Hyprland's request socket, when this session is a Hyprland one.
pub fn socket() -> Option<PathBuf> {
    let signature = std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE")?;
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")?;
    let path = PathBuf::from(runtime).join("hypr").join(signature).join(".socket.sock");
    path.exists().then_some(path)
}

pub fn available() -> bool {
    socket().is_some()
}

#[cfg(unix)]
fn request(command: &str) -> Option<String> {
    use std::os::unix::net::UnixStream;
    let mut stream = UnixStream::connect(socket()?).ok()?;
    stream.set_read_timeout(Some(TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(TIMEOUT)).ok()?;
    stream.write_all(command.as_bytes()).ok()?;
    let mut reply = String::new();
    stream.read_to_string(&mut reply).ok()?;
    Some(reply)
}

#[cfg(not(unix))]
fn request(_command: &str) -> Option<String> {
    None
}

/// The pointer, in global layout coordinates.
pub fn cursor() -> Option<(f64, f64)> {
    parse_cursor(&request("cursorpos")?)
}

pub fn parse_cursor(reply: &str) -> Option<(f64, f64)> {
    let (x, y) = reply.trim().split_once(',')?;
    Some((x.trim().parse().ok()?, y.trim().parse().ok()?))
}

/// This process's window, if Hyprland has mapped it yet.
pub fn own_window() -> Option<Client> {
    find_client(&request("j/clients")?, std::process::id())
}

pub fn find_client(clients: &str, pid: u32) -> Option<Client> {
    let clients: Value = serde_json::from_str(clients).ok()?;
    let client = clients
        .as_array()?
        .iter()
        .find(|client| client.get("pid").and_then(Value::as_u64) == Some(pid as u64))?;
    let pair = |key: &str| -> Option<(f64, f64)> {
        let values = client.get(key)?.as_array()?;
        Some((values.first()?.as_f64()?, values.get(1)?.as_f64()?))
    };
    let (x, y) = pair("at")?;
    let (width, height) = pair("size")?;
    Some(Client {
        address: client.get("address")?.as_str()?.to_string(),
        x,
        y,
        width,
        height,
        floating: client.get("floating").and_then(Value::as_bool).unwrap_or(false),
        pinned: client.get("pinned").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// Run a dispatcher, Lua form first, classic form if that is refused.
fn dispatch(lua: &str, classic: &str) -> bool {
    let ok = |reply: Option<String>| reply.is_some_and(|it| it.trim() == "ok");
    ok(request(&format!("dispatch {lua}"))) || ok(request(&format!("dispatch {classic}")))
}

/// The dispatches that turn a fresh window into a pet, in order.
pub fn settle_commands(client: &Client, at: Option<(i32, i32)>) -> Vec<(String, String)> {
    let window = format!("address:{}", client.address);
    let lua = |call: &str, args: &str| format!("hl.dsp.window.{call}({{ window = \"{window}\"{args} }})");
    let mut commands = Vec::new();
    if !client.floating {
        commands.push((lua("float", ", action = \"set\""), format!("setfloating {window}")));
    }
    if !client.pinned {
        commands.push((lua("pin", ""), format!("pin {window}")));
    }
    // The transparent corners must show the desktop, not a blurred box.
    for (prop, classic, value) in [
        ("border_size", "bordersize", "0"),
        ("no_shadow", "noshadow", "1"),
        ("no_blur", "noblur", "1"),
    ] {
        commands.push((
            lua("set_prop", &format!(", prop = \"{prop}\", value = \"{value}\"")),
            format!("setprop {window} {classic} {value}"),
        ));
    }
    commands.push((
        lua("set_prop", ", prop = \"opacity\", value = \"1 override 1 override\""),
        format!("setprop {window} alpha 1 lock"),
    ));
    if let Some((x, y)) = at {
        commands.push((
            lua("move", &format!(", x = {x}, y = {y}, relative = false")),
            format!("movewindowpixel exact {x} {y},{window}"),
        ));
    }
    commands.push((lua("alter_zorder", ", mode = \"top\""), format!("alterzorder top,{window}")));
    commands
}

/// Make this window a pet: wait for Hyprland to map it, then float, pin and
/// unclutter it, and put it back where it was. Returns where it ended up.
pub fn settle(at: Option<(i32, i32)>) -> Option<Client> {
    let mut client = None;
    for _ in 0..50 {
        client = own_window();
        if client.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let client = client?;
    for (lua, classic) in settle_commands(&client, at) {
        if !dispatch(&lua, &classic) {
            eprintln!("[hyprland] could not apply: {classic}");
        }
    }
    own_window()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cursor_reply_is_two_numbers() {
        assert_eq!(parse_cursor("1234, 567\n"), Some((1234.0, 567.0)));
        assert_eq!(parse_cursor("-10, 20"), Some((-10.0, 20.0)));
        assert_eq!(parse_cursor("unknown request"), None);
    }

    #[test]
    fn this_window_is_found_by_process() {
        let clients = r#"[
            {"address":"0xaaa","pid":1,"at":[0,0],"size":[10,10],"floating":false,"pinned":false},
            {"address":"0xbbb","pid":4242,"at":[2200,1000],"size":[280,280],"floating":true,"pinned":false}
        ]"#;
        let client = find_client(clients, 4242).unwrap();
        assert_eq!(client.address, "0xbbb");
        assert_eq!((client.x, client.y, client.width, client.height), (2200.0, 1000.0, 280.0, 280.0));
        assert!(client.floating && !client.pinned);
        assert!(find_client(clients, 7).is_none());
        assert!(find_client("not json", 1).is_none());
    }

    #[test]
    fn a_tiled_window_is_floated_pinned_uncluttered_and_placed() {
        let client = Client {
            address: "0xbbb".into(), x: 0.0, y: 0.0, width: 280.0, height: 280.0,
            floating: false, pinned: false,
        };
        let commands = settle_commands(&client, Some((100, 200)));
        let classic: Vec<&str> = commands.iter().map(|(_, it)| it.as_str()).collect();
        assert_eq!(classic, [
            "setfloating address:0xbbb",
            "pin address:0xbbb",
            "setprop address:0xbbb bordersize 0",
            "setprop address:0xbbb noshadow 1",
            "setprop address:0xbbb noblur 1",
            "setprop address:0xbbb alpha 1 lock",
            "movewindowpixel exact 100 200,address:0xbbb",
            "alterzorder top,address:0xbbb",
        ]);
        assert_eq!(commands[0].0, r#"hl.dsp.window.float({ window = "address:0xbbb", action = "set" })"#);
        assert_eq!(commands[6].0, r#"hl.dsp.window.move({ window = "address:0xbbb", x = 100, y = 200, relative = false })"#);
    }

    #[test]
    fn what_is_already_true_is_not_toggled() {
        let client = Client {
            address: "0x1".into(), x: 0.0, y: 0.0, width: 1.0, height: 1.0,
            floating: true, pinned: true,
        };
        let classic: Vec<String> = settle_commands(&client, None).into_iter().map(|(_, it)| it).collect();
        assert!(!classic.iter().any(|it| it.starts_with("setfloating") || it.starts_with("pin ")));
        assert!(!classic.iter().any(|it| it.starts_with("movewindowpixel")));
    }
}

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The companion as a window of its own: a second screen for the ESP32 device.
//!
//! The page inside draws with the firmware's own engine, compiled to
//! WebAssembly, from the same `.acpk` pack the device installs. Everything else
//! - what the agents are doing, the badges, which character, whether to show at
//! all, the backdrop - comes from the ESP32 daemon, the same place the device
//! gets it. This file is what is genuinely the window's job: a transparent pet
//! that stays out of the way until the pointer is on the character, can be
//! picked up and moved, and can be quit.

mod daemon;
mod hyprland;
mod packs;
mod placement;
mod pointer;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WebviewWindow, WindowEvent, Wry};

use daemon::Snapshot;
use placement::Placement;
use pointer::{Pointer, Region};

struct App {
    pointer: Arc<Pointer>,
    /// Whether the page has ever reported drawing anything.
    drawn: AtomicBool,
    /// Whether the page is listening, so a pack can be sent to it.
    ready: AtomicBool,
    /// Whether the window is showing.
    visible: AtomicBool,
    /// Hidden by the user from its menu, until they show it again from the
    /// tray. For this run only: Settings decides whether it shows at all.
    user_hidden: AtomicBool,
    /// The repository's built packs, for when there is no daemon.
    built_in: Option<PathBuf>,
    ids: Vec<String>,
    /// The character picked from the tray, used only without the daemon.
    chosen: Mutex<Option<String>>,
    daemon: Mutex<Option<Snapshot>>,
    /// The pack the page has been told to show, and the only one served.
    current: Mutex<Option<(String, PathBuf)>>,
    tray: Mutex<Option<tauri::tray::TrayIcon>>,
    characters: Mutex<Option<Submenu<Wry>>>,
    /// The tray's Show/Hide item, whose label follows the window.
    visibility: Mutex<Option<MenuItem<Wry>>>,
}

impl App {
    /// The daemon decides when it is there; otherwise the tray's choice does.
    fn wanted(&self) -> Option<(String, PathBuf)> {
        let daemon = self.daemon.lock().unwrap().clone();
        if let Some(character) = daemon.as_ref().and_then(|it| it.character.clone()) {
            if let Some(pack) = daemon.as_ref().and_then(|it| it.pack.clone()).filter(|p| p.is_file()) {
                return Some((character, pack));
            }
            if let Some(path) = self.built_in.as_deref().and_then(|dir| packs::path_for(dir, &character)) {
                return Some((character, path));
            }
        }
        let chosen = self.chosen.lock().unwrap().clone();
        let id = packs::choose(&self.ids, chosen.as_deref())?.clone();
        let path = packs::path_for(self.built_in.as_deref()?, &id)?;
        Some((id, path))
    }
}

/// Tell the page which pack to load, when it differs from what it has.
fn show_pack(app: &Arc<App>, window: &WebviewWindow, force: bool) {
    let Some(next) = app.wanted() else {
        // An installed app has no packs of its own: it shows the character the
        // companion service names, from the service's own packs.
        let message = if app.daemon.lock().unwrap().is_some() {
            "The companion service has no character pack to show yet."
        } else {
            "Waiting for the companion service. Start it with: npm run setup"
        };
        let _ = window.emit("to-view", serde_json::json!({ "type": "error", "message": message }));
        return;
    };
    {
        let mut current = app.current.lock().unwrap();
        if !force && current.as_ref() == Some(&next) {
            return;
        }
        *current = Some(next.clone());
    }
    if !app.ready.load(Ordering::Relaxed) {
        return;
    }
    println!("[packs] showing {} from {}", next.0, next.1.display());
    if let Some(tray) = app.tray.lock().unwrap().as_ref() {
        let _ = tray.set_tooltip(Some(format!("Agent Companion - {}", next.0)));
    }
    let _ = window.emit("to-view-pack", serde_json::json!({ "url": packs::pack_url(&next.0) }));
}

/// Pass the daemon's latest to the page, and act on the parts that are the shell's.
fn apply_daemon(app: &Arc<App>, window: &WebviewWindow) {
    let snapshot = app.daemon.lock().unwrap().clone();
    let state = snapshot.as_ref().map_or("idle", |it| it.state.as_str()).to_string();
    let _ = window.emit(
        "to-view",
        serde_json::json!({ "type": "daemon", "daemon": snapshot.as_ref().map(Snapshot::for_page) }),
    );
    let _ = window.emit("to-view", serde_json::json!({ "type": "state", "state": state }));

    update_visibility(app, window);

    // A connected device decides the character, so the tray would only be
    // overruled a moment later; without one, the tray chooses.
    if let Some(menu) = app.characters.lock().unwrap().as_ref() {
        let device = snapshot.as_ref().is_some_and(|it| it.connected);
        let _ = menu.set_enabled(!device && !app.ids.is_empty());
        let _ = menu.set_text(if device { "Character (install in Settings)" } else { "Character" });
    }
    show_pack(app, window, false);
}

/// Show or hide the window: hidden if Settings turns the desktop companion
/// off, or the user hid it from its menu. The page stops drawing while hidden.
fn update_visibility(app: &Arc<App>, window: &WebviewWindow) {
    let wanted = app.daemon.lock().unwrap().as_ref().map_or(true, |it| it.visible);
    let user_hidden = app.user_hidden.load(Ordering::Relaxed);
    let visible = wanted && !user_hidden;
    let was_visible = app.visible.swap(visible, Ordering::Relaxed);
    let _ = if visible { window.show() } else { window.hide() };
    let _ = window.emit("to-view", serde_json::json!({ "type": "showing", "showing": visible }));
    app.pointer.refresh(window);
    if let Some(item) = app.visibility.lock().unwrap().as_ref() {
        let _ = item.set_text(if user_hidden { "Show Agent Companion" } else { "Hide Agent Companion" });
        // Settings has it off: showing it from here would be overruled.
        let _ = item.set_enabled(wanted);
    }
    // Shown again, the window is new to the compositor, and tiled again.
    if visible && !was_visible {
        settle_on_hyprland(window);
    }
}

fn set_user_hidden(app: &Arc<App>, window: &WebviewWindow, hidden: bool) {
    app.user_hidden.store(hidden, Ordering::Relaxed);
    update_visibility(app, window);
}

/// Open the Settings page, which the daemon serves with a private token.
fn open_settings() {
    std::thread::spawn(|| match daemon::settings_url() {
        Some(url) => packs::open(&url),
        None => eprintln!("[settings] the ESP32 daemon is not running"),
    });
}

/// The character's own menu, on a right-click: hide it to the tray or menu
/// bar, open Settings, or close the app.
#[tauri::command]
fn show_context_menu(window: WebviewWindow) {
    let handle = window.app_handle();
    let build = || -> tauri::Result<Menu<Wry>> {
        let hide = MenuItem::with_id(handle, "context:hide", "Hide", true, None::<&str>)?;
        let settings = MenuItem::with_id(handle, "context:settings", "Open Settings…", true, None::<&str>)?;
        let separator = tauri::menu::PredefinedMenuItem::separator(handle)?;
        let close = MenuItem::with_id(handle, "context:close", "Close", true, None::<&str>)?;
        Menu::with_items(handle, &[&hide, &settings, &separator, &close])
    };
    match build() {
        Ok(menu) => {
            let _ = window.popup_menu(&menu);
        }
        Err(error) => eprintln!("[menu] could not build the menu: {error}"),
    }
}

/// The page saying where it drew the character.
#[tauri::command]
fn set_region(app: tauri::State<'_, Arc<App>>, region: Region) {
    if !app.drawn.swap(true, Ordering::Relaxed) {
        println!("[view] drawn at {:.0}x{:.0}", region.rx * 2.0, region.ry * 2.0);
    }
    app.pointer.set_region(region);
}

/// The page talking back.
#[tauri::command]
fn from_view(app: tauri::State<'_, Arc<App>>, window: WebviewWindow, message: serde_json::Value) {
    match message.get("type").and_then(|value| value.as_str()) {
        // It is up and listening, so now it can be told what to show. Waiting
        // for this rather than pushing early means a slow page cannot miss it.
        Some("ready") => {
            app.ready.store(true, Ordering::Relaxed);
            let app = app.inner().clone();
            show_pack(&app, &window, true);
            apply_daemon(&app, &window);
        }
        Some("failed") => eprintln!(
            "the page failed: {}",
            message.get("message").and_then(|value| value.as_str()).unwrap_or("?")
        ),
        _ => {}
    }
}

/// Pick the window up. The character itself is the handle; the page decides
/// when a press is a drag rather than a poke, because only it sees the travel.
#[tauri::command]
fn start_drag(window: WebviewWindow) {
    let _ = window.start_dragging();
}

/// The tray wears the character it is showing, cut from a frame the page drew.
#[tauri::command]
fn set_tray_icon(app: tauri::State<'_, Arc<App>>, rgba: Vec<u8>, width: u32, height: u32) {
    if rgba.len() != (width * height * 4) as usize || width == 0 || width > 256 {
        return;
    }
    if let Some(tray) = app.tray.lock().unwrap().as_ref() {
        let _ = tray.set_icon(Some(tauri::image::Image::new_owned(rgba, width, height)));
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    linux_environment();

    let built_in = packs::built_in_directory();
    let ids = built_in.as_deref().map(packs::list).unwrap_or_default();
    println!(
        "[packs] {}",
        if ids.is_empty() { "none built - run python3 tools/character_pack.py build".to_string() } else { ids.join(", ") }
    );
    let app = Arc::new(App {
        pointer: Arc::new(Pointer::new()),
        drawn: AtomicBool::new(false),
        ready: AtomicBool::new(false),
        visible: AtomicBool::new(true),
        user_hidden: AtomicBool::new(false),
        built_in,
        ids,
        chosen: Mutex::new(None),
        daemon: Mutex::new(None),
        current: Mutex::new(None),
        tray: Mutex::new(None),
        characters: Mutex::new(None),
        visibility: Mutex::new(None),
    });

    let setup = app.clone();
    let serving = app.clone();
    let again = app.clone();
    #[cfg(target_os = "macos")]
    let reopened = app.clone();
    tauri::Builder::default()
        // Must be the first plugin. Opening the app while it runs brings the
        // pet back, which matters when it was hidden and the menu bar was too
        // full for its icon to show.
        .plugin(tauri_plugin_single_instance::init(move |handle, args, _cwd| {
            let Some(window) = handle.get_webview_window("main") else { return };
            match Command::from_args(&args) {
                Command::Show => set_user_hidden(&again, &window, false),
                Command::Hide => set_user_hidden(&again, &window, true),
                Command::Toggle => {
                    let hidden = again.user_hidden.load(Ordering::Relaxed);
                    set_user_hidden(&again, &window, !hidden);
                }
                Command::Quit => handle.exit(0),
            }
        }))
        .manage(app.clone())
        .invoke_handler(tauri::generate_handler![
            set_region, from_view, start_drag, set_tray_icon, show_context_menu
        ])
        // Only the pack the page was told to show can be fetched, by its id.
        .register_uri_scheme_protocol(packs::SCHEME, move |_ctx, request| {
            let current = serving.current.lock().unwrap().clone();
            let file = packs::requested_id(request.uri().path())
                .zip(current)
                .filter(|(id, (current_id, _))| id == current_id)
                .map(|(_, (_, path))| path);
            let response = tauri::http::Response::builder();
            match file.map(|path| std::fs::read(&path)) {
                Some(Ok(bytes)) => response
                    .header("content-type", "application/octet-stream")
                    // The page and this protocol are different origins.
                    .header("access-control-allow-origin", "*")
                    .body(bytes),
                Some(Err(error)) => {
                    eprintln!("[packs] could not read the pack: {error}");
                    response.status(500).body(Vec::new())
                }
                None => response.status(404).body(Vec::new()),
            }
            .expect("a response is always buildable")
        })
        .setup(move |handle| {
            // On macOS `skipTaskbar` does not hide the Dock icon, and a regular
            // app's window cannot sit over another app's full-screen Space. An
            // accessory app does both, which is what a desktop pet should be;
            // the tray stays the way in.
            #[cfg(target_os = "macos")]
            handle.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let window: WebviewWindow = handle.get_webview_window("main").expect("the main window");

            // Start transparent to the mouse. If the page never reports where
            // it drew, the desktop stays usable rather than this swallowing
            // every click on the screen.
            let _ = window.set_ignore_cursor_events(true);
            placement::restore(&window);
            *setup.chosen.lock().unwrap() = packs::remembered(&window);
            build_tray(handle.handle(), &window, &setup)?;

            // Remember where it is put. Tauri reports every step of a drag, so
            // this writes often; the file is two numbers and the alternative is
            // losing the position when the app is killed rather than quit.
            let moving = window.clone();
            let tracking = setup.pointer.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::Moved(at) => {
                    placement::remember(&moving, Placement { x: at.x, y: at.y });
                    tracking.refresh(&moving);
                }
                WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                    tracking.refresh(&moving)
                }
                _ => {}
            });

            setup.pointer.clone().watch(window.clone());
            settle_on_hyprland(&window);

            let following = setup.clone();
            let shown = window.clone();
            daemon::follow(move |snapshot| {
                *following.daemon.lock().unwrap() = snapshot.cloned();
                if following.ready.load(Ordering::Relaxed) {
                    apply_daemon(&following, &shown);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the app should start")
        .run(move |handle, event| {
            // macOS: opening the app again from Finder, Spotlight or the Dock.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(window) = handle.get_webview_window("main") {
                    set_user_hidden(&reopened, &window, false);
                }
                return;
            }
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                // Take the window down before the process goes. Tauri's exit
                // ends in `std::process::exit`, which runs no destructors, so
                // WebView2 tears down with the HWND still alive and complains
                // on stderr that its window class still has a window.
                // Destroying it first is clean, and idempotent.
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.destroy();
                }
            }
        });
}

/// What a second launch asks of the running app. Plain, it shows the pet,
/// which is the way back when the menu bar is too full for the tray icon; the
/// flags make it scriptable, for a keyboard shortcut for example.
#[derive(Debug, PartialEq)]
enum Command {
    Show,
    Hide,
    Toggle,
    Quit,
}

impl Command {
    fn from_args(args: &[String]) -> Self {
        let flag = |name: &str| args.iter().skip(1).any(|arg| arg == name);
        if flag("--quit") {
            Self::Quit
        } else if flag("--toggle") {
            Self::Toggle
        } else if flag("--hide") {
            Self::Hide
        } else {
            Self::Show
        }
    }
}

/// Choices that have to be made before GTK starts.
#[cfg(target_os = "linux")]
fn linux_environment() {
    // On most Wayland desktops an app cannot read the cursor's position, place
    // its own window, or keep it above others, and a pet needs all three; GTK's
    // X11 backend (XWayland) can. Hyprland answers all three over its IPC
    // (hyprland.rs), so there it stays native. A backend the user chose wins.
    if std::env::var_os("WAYLAND_DISPLAY").is_some()
        && std::env::var_os("GDK_BACKEND").is_none()
        && !hyprland::available()
    {
        std::env::set_var("GDK_BACKEND", "x11");
    }
    // WebKitGTK's DMA-BUF renderer draws a blank window on NVIDIA's driver.
    if std::path::Path::new("/proc/driver/nvidia/version").exists()
        && std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

/// On Hyprland, float, pin and unclutter the window and put it back where it
/// was, in the background: Hyprland maps it a moment after it is shown.
fn settle_on_hyprland(window: &WebviewWindow) {
    if !hyprland::available() {
        return;
    }
    let at = placement::saved(window).map(|it| (it.x, it.y));
    std::thread::spawn(move || {
        if hyprland::settle(at).is_none() {
            eprintln!("[hyprland] the window did not appear to Hyprland");
        }
    });
}

/// With no title bar and no taskbar button, the tray is the only way in.
fn build_tray(handle: &tauri::AppHandle, window: &WebviewWindow, app: &Arc<App>) -> tauri::Result<()> {
    let mut entries: Vec<MenuItem<Wry>> = Vec::new();
    for id in &app.ids {
        let mut name = id.clone();
        if let Some(first) = name.get_mut(0..1) {
            first.make_ascii_uppercase();
        }
        entries.push(MenuItem::with_id(handle, format!("pack:{id}"), name, true, None::<&str>)?);
    }
    let references: Vec<&dyn tauri::menu::IsMenuItem<Wry>> =
        entries.iter().map(|item| item as &dyn tauri::menu::IsMenuItem<Wry>).collect();
    let characters = Submenu::with_items(handle, "Character", !entries.is_empty(), &references)?;

    let visibility = MenuItem::with_id(handle, "visibility", "Hide Agent Companion", true, None::<&str>)?;
    let settings = MenuItem::with_id(handle, "settings", "Open Settings…", true, None::<&str>)?;
    let centre = MenuItem::with_id(handle, "centre", "Bring Back to Centre", true, None::<&str>)?;
    let quit = MenuItem::with_id(handle, "quit", "Quit Agent Companion", true, None::<&str>)?;
    let menu = Menu::with_items(handle, &[&visibility, &characters, &settings, &centre, &quit])?;

    let tray_window = window.clone();
    let tray_app = app.clone();
    let tray = TrayIconBuilder::new()
        .icon(handle.default_window_icon().expect("a window icon").clone())
        .tooltip("Agent Companion")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |handle, event| {
            let id = event.id.as_ref();
            match id {
                "quit" => handle.exit(0),
                "visibility" => {
                    let hidden = tray_app.user_hidden.load(Ordering::Relaxed);
                    set_user_hidden(&tray_app, &tray_window, !hidden);
                }
                // For when it has ended up somewhere unreachable - a screen
                // that has since gone, or dragged almost off an edge.
                "centre" => {
                    let _ = tray_window.center();
                    tray_app.pointer.refresh(&tray_window);
                }
                // The daemon's page, where the character and the desktop
                // settings live. Asked for each time: its address carries a
                // token that changes when the daemon restarts.
                "settings" => open_settings(),
                _ if id.starts_with("pack:") => {
                    let chosen = id.trim_start_matches("pack:").to_string();
                    *tray_app.chosen.lock().unwrap() = Some(chosen.clone());
                    packs::remember(&tray_window, &chosen);
                    if tray_app.daemon.lock().unwrap().is_some() {
                        // The daemon keeps the choice, so the settings page and
                        // the device agree; the change arrives on the next poll.
                        std::thread::spawn(move || {
                            if !daemon::set_character(&chosen) {
                                eprintln!("[daemon] could not set the character to {chosen}");
                            }
                        });
                    } else {
                        show_pack(&tray_app, &tray_window, false);
                    }
                }
                _ => {}
            }
        })
        .build(handle)?;
    *app.tray.lock().unwrap() = Some(tray);
    *app.characters.lock().unwrap() = Some(characters);
    *app.visibility.lock().unwrap() = Some(visibility);

    // The character's right-click menu.
    let menu_window = window.clone();
    let menu_app = app.clone();
    handle.on_menu_event(move |handle, event| match event.id.as_ref() {
        "context:hide" => set_user_hidden(&menu_app, &menu_window, true),
        "context:settings" => open_settings(),
        "context:close" => handle.exit(0),
        _ => {}
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Command;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|it| it.to_string()).collect()
    }

    #[test]
    fn a_second_launch_shows_the_pet_unless_asked_otherwise() {
        assert_eq!(Command::from_args(&args(&["agent-companion-desktop"])), Command::Show);
        assert_eq!(Command::from_args(&args(&["app", "--show"])), Command::Show);
        assert_eq!(Command::from_args(&args(&["app", "--hide"])), Command::Hide);
        assert_eq!(Command::from_args(&args(&["app", "--toggle"])), Command::Toggle);
        assert_eq!(Command::from_args(&args(&["app", "--quit"])), Command::Quit);
        // The program's own path is never mistaken for a flag.
        assert_eq!(Command::from_args(&args(&["--hide"])), Command::Show);
    }
}

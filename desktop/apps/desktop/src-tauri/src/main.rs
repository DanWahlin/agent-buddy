#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The companion as a window of its own: a second screen for the ESP32 device.
//!
//! The page inside draws with the firmware's own engine, compiled to
//! WebAssembly, from the same `.acpk` pack the device installs. Everything
//! else (what the agents are doing, the badges, which character, whether to
//! show at all, the backdrop) comes from the ESP32 daemon, the same place the
//! device gets it. This file is what is genuinely the window's job: a transparent pet
//! that stays out of the way until the pointer is on the character, can be
//! picked up and moved, and can be quit.

mod daemon;
mod flasher;
mod hyprland;
mod launcher;
mod packs;
mod placement;
mod pointer;
mod service;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry};

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
    /// What Settings last said, kept while the daemon can't be reached.
    wanted: AtomicBool,
    /// Hidden by the user from its menu, until they show it again from the
    /// tray. For this run only: Settings decides whether it shows at all.
    user_hidden: AtomicBool,
    /// The repository's built packs, for when there is no daemon.
    built_in: Option<PathBuf>,
    ids: Vec<String>,
    daemon: Mutex<Option<Snapshot>>,
    /// The pack the page has been told to show, and the only one served.
    current: Mutex<Option<(String, PathBuf)>>,
    tray: Mutex<Option<tauri::tray::TrayIcon>>,
    /// The tray's Show/Hide item, whose label follows the window.
    visibility: Mutex<Option<MenuItem<Wry>>>,
    /// Whether this build carries the companion service and starts it itself.
    bundled: AtomicBool,
    /// The address the Settings window loaded. The lock also stops two quick
    /// clicks from making two windows.
    settings: Mutex<Option<String>>,
}

impl App {
    /// The daemon decides when it is there; otherwise the default character shows.
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
        let id = packs::choose(&self.ids)?.clone();
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
        } else if app.bundled.load(Ordering::Relaxed) {
            // The window in the middle of the screen says the service is starting.
            return;
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
    let tray = app.tray.lock().unwrap().clone();
    if let Some(tray) = tray {
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

    // The tray says what the device is doing while it installs a character.
    let tray = app.tray.lock().unwrap().clone();
    if let Some(tray) = tray {
        let installing = snapshot.as_ref().map(|it| &it.installing).filter(|it| !it.is_null());
        let current = app.current.lock().unwrap().as_ref().map(|(id, _)| id.clone()).unwrap_or_default();
        let tooltip = match installing {
            Some(install) => format!(
                "Agent Companion - installing {} on the device: {}%",
                install["name"].as_str().unwrap_or("a character"),
                install["percent"].as_u64().unwrap_or(0)
            ),
            None => format!("Agent Companion - {current}"),
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
    show_pack(app, window, false);
}

/// Show or hide the window: hidden if Settings turns the desktop companion
/// off, or the user hid it from its menu. The page stops drawing while hidden.
fn update_visibility(app: &Arc<App>, window: &WebviewWindow) {
    let reported = app.daemon.lock().unwrap().as_ref().map(|it| it.visible);
    if let Some(reported) = reported {
        app.wanted.store(reported, Ordering::Relaxed);
    }
    let wanted = app.wanted.load(Ordering::Relaxed);
    let user_hidden = app.user_hidden.load(Ordering::Relaxed);
    let visible = wanted && !user_hidden;
    let was_visible = app.visible.swap(visible, Ordering::Relaxed);
    // Every daemon update comes through here, so only a change shows the
    // window: showing it takes the keyboard on some platforms.
    if visible && !was_visible {
        show_without_focus(window);
    } else if !visible {
        let _ = window.hide();
    }
    let _ = window.emit("to-view", serde_json::json!({ "type": "showing", "showing": visible }));
    app.pointer.refresh(window);
    let item = app.visibility.lock().unwrap().clone();
    if let Some(item) = item {
        let _ = item.set_text(if user_hidden { "Show Agent Companion" } else { "Hide Agent Companion" });
        // Settings has it off: showing it from here would be overruled.
        let _ = item.set_enabled(wanted);
    }
    // Shown again, the window is new to the compositor, and tiled again.
    if visible && !was_visible {
        settle_on_hyprland(window);
    }
}

/// Put a window in front of every app's windows and give it the keys. A click
/// on the pet does not make this the active app, and macOS can refuse to
/// activate it, so the window is ordered front on its own first: it is then
/// in sight even when the keys stay where they were.
#[cfg(target_os = "macos")]
fn bring_to_front(window: &WebviewWindow) {
    let target = window.clone();
    let _ = window.run_on_main_thread(move || {
        use objc2_app_kit::{NSApplication, NSWindow};
        // Asked for here, on the main thread, so a window closed meanwhile is not used.
        let Ok(pointer) = target.ns_window() else { return };
        let main = objc2::MainThreadMarker::new().expect("on the main thread");
        let app = NSApplication::sharedApplication(main);
        if app.isHidden() {
            app.unhideWithoutActivation();
        }
        // SAFETY: Tauri's NSWindow, open while this runs on the main thread.
        let ns_window = unsafe { &*(pointer as *const NSWindow) };
        ns_window.orderFrontRegardless();
        ns_window.makeKeyWindow();
        #[allow(deprecated)]
        app.activateIgnoringOtherApps(true);
    });
}

#[cfg(not(target_os = "macos"))]
fn bring_to_front(window: &WebviewWindow) {
    let _ = window.set_focus();
}

/// Put the window on screen without making it the key window or this the
/// active app: a pet must never take the keys from the app you type in.
#[cfg(target_os = "macos")]
fn show_without_focus(window: &WebviewWindow) {
    let Ok(pointer) = window.ns_window() else {
        let _ = window.show();
        return;
    };
    let address = pointer as usize;
    let _ = window.run_on_main_thread(move || {
        use objc2_app_kit::{NSApplication, NSWindow};
        let main = objc2::MainThreadMarker::new().expect("on the main thread");
        let app = NSApplication::sharedApplication(main);
        // Cmd-H hides the whole app, which ordering a window front does not undo.
        if app.isHidden() {
            app.unhideWithoutActivation();
        }
        // SAFETY: Tauri's NSWindow, alive for as long as the app runs.
        let ns_window = unsafe { &*(address as *const NSWindow) };
        ns_window.orderFrontRegardless();
    });
}

#[cfg(not(target_os = "macos"))]
fn show_without_focus(window: &WebviewWindow) {
    let _ = window.show();
}

fn set_user_hidden(app: &Arc<App>, window: &WebviewWindow, hidden: bool) {
    app.user_hidden.store(hidden, Ordering::Relaxed);
    // Showing is also the cure for any hide from outside the app, so make
    // sure the window is put back even if this app thought it was showing.
    if !hidden {
        app.visible.store(false, Ordering::Relaxed);
    }
    update_visibility(app, window);
}

/// The label of the window that shows the Settings page.
const SETTINGS: &str = "settings";

/// Show the Settings page, which the daemon serves with a private token, in a
/// window of this app: a browser would open a new tab each time, and nothing
/// outside a browser can bring one of its tabs to the front. The menus call
/// it, and so does a click on the case's upper button.
#[tauri::command]
fn open_settings(handle: AppHandle) {
    // Off the main thread: the daemon is asked over a socket, and on Windows
    // making a webview from the main thread deadlocks.
    std::thread::spawn(move || match daemon::settings_url() {
        Some(url) => show_settings(&handle, url),
        None => eprintln!("[settings] the ESP32 daemon is not running"),
    });
}

fn show_settings(handle: &AppHandle, address: String) {
    let Ok(url) = address.parse::<tauri::Url>() else {
        eprintln!("[settings] the daemon gave an address that is not valid");
        return;
    };
    let app = handle.state::<Arc<App>>();
    let mut loaded = app.settings.lock().unwrap();
    if let Some(window) = handle.get_webview_window(SETTINGS) {
        // The token changes when the daemon restarts, so the open page would
        // be refused. Otherwise leave it as it is, on the tab the user chose.
        if loaded.as_deref() != Some(address.as_str()) && window.navigate(url).is_ok() {
            *loaded = Some(address);
        }
        let _ = window.unminimize();
        let _ = window.show();
        bring_to_front(&window);
        return;
    }
    // Only the pet's window may use this app's commands (capabilities/default.json),
    // so the page, which is the daemon's, gets nothing from the app.
    let built = WebviewWindowBuilder::new(handle, SETTINGS, WebviewUrl::External(url))
        .title("Agent Companion Settings")
        .inner_size(1000.0, 860.0)
        .min_inner_size(420.0, 480.0)
        .center()
        .build();
    match built {
        Ok(window) => {
            *loaded = Some(address);
            bring_to_front(&window);
        }
        Err(error) => eprintln!("[settings] could not open the window: {error}"),
    }
}

/// The label of the window that says the companion service is starting.
const STARTING: &str = "starting";

/// While a release build waits for its companion service, say so in a small
/// window in the middle of the screen: the character has nothing to show yet,
/// and its own window may be in a corner. The window closes when the service
/// answers. A service that answers at once gets no window at all.
fn show_starting(handle: AppHandle, app: Arc<App>) {
    if !app.bundled.load(Ordering::Relaxed) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        if app.daemon.lock().unwrap().is_some() || handle.get_webview_window(STARTING).is_some() {
            return;
        }
        // Off the main thread, as making a webview from it deadlocks on Windows.
        let built = WebviewWindowBuilder::new(&handle, STARTING, WebviewUrl::App("starting.html".into()))
            .title("Agent Companion")
            .inner_size(440.0, 250.0)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .always_on_top(true)
            .center()
            .build();
        let window = match built {
            Ok(window) => window,
            Err(error) => return eprintln!("[starting] could not open the window: {error}"),
        };
        while app.daemon.lock().unwrap().is_none() {
            // Closed by the user.
            if handle.get_webview_window(STARTING).is_none() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
        let _ = window.close();
    });
}

/// The case's lower button mutes and unmutes the page's sounds. The daemon
/// keeps the setting, so Settings shows the same. Off the main thread, as the
/// daemon is asked over a socket.
#[tauri::command]
async fn set_sounds(on: bool) -> bool {
    tauri::async_runtime::spawn_blocking(move || daemon::set_sounds(on))
        .await
        .unwrap_or(false)
}

/// The character's own menu, on a right-click: hide it to the tray or menu
/// bar, open Settings, or close the app.
#[tauri::command]
fn show_context_menu(window: WebviewWindow) {
    let handle = window.app_handle();
    let build = || -> tauri::Result<Menu<Wry>> {
        let hide = MenuItem::with_id(handle, "context:hide", "Hide", true, None::<&str>)?;
        let settings = MenuItem::with_id(handle, "context:settings", "Settings", true, None::<&str>)?;
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
    let tray = app.tray.lock().unwrap().clone();
    if let Some(tray) = tray {
        let _ = tray.set_icon(Some(tauri::image::Image::new_owned(rgba, width, height)));
    }
}

fn main() {
    // The companion service runs this binary to install firmware over USB; no window, no single instance.
    let args: Vec<String> = std::env::args().collect();
    if let Some(options) = flasher::options(&args) {
        std::process::exit(flasher::run(options));
    }
    // Windows starts the companion service through this binary at sign-in; no window either.
    if let Some(mode) = launcher::options(&args) {
        std::process::exit(launcher::run(mode));
    }

    #[cfg(target_os = "linux")]
    linux_environment();

    // Tauri starts a worker thread per CPU core for async work, and this app
    // has next to none: its commands are quick and synchronous. One will do.
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .expect("an async runtime");
    tauri::async_runtime::set(runtime.handle().clone());

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
        wanted: AtomicBool::new(true),
        user_hidden: AtomicBool::new(false),
        built_in,
        ids,
        daemon: Mutex::new(None),
        current: Mutex::new(None),
        tray: Mutex::new(None),
        visibility: Mutex::new(None),
        bundled: AtomicBool::new(false),
        settings: Mutex::new(None),
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
            // Starting the app again also starts the service again if it stopped.
            let resources = handle.path().resource_dir().ok();
            std::thread::spawn(move || service::ensure(resources));
            show_starting(handle.clone(), again.clone());
            match Command::from_args(&args) {
                Command::Show => set_user_hidden(&again, &window, false),
                Command::Hide => set_user_hidden(&again, &window, true),
                Command::Toggle => {
                    let hidden = again.user_hidden.load(Ordering::Relaxed);
                    set_user_hidden(&again, &window, !hidden);
                }
                Command::Settings => open_settings(handle.clone()),
                Command::Quit => handle.exit(0),
            }
        }))
        .manage(app.clone())
        .invoke_handler(tauri::generate_handler![
            set_region, from_view, start_drag, set_tray_icon, show_context_menu, open_settings, set_sounds
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
            if Command::from_args(&std::env::args().collect::<Vec<_>>()) == Command::Settings {
                open_settings(handle.handle().clone());
            }

            // A release build carries the companion service, and starts it
            // when no other one runs. A new user then sees Settings, as
            // `npm run setup` shows it, once the new service answers.
            let resources = handle.path().resource_dir().ok();
            setup.bundled.store(service::bundled(resources.as_deref()), Ordering::Relaxed);
            show_starting(handle.handle().clone(), setup.clone());
            let welcome = handle.handle().clone();
            std::thread::spawn(move || {
                if !service::ensure(resources) {
                    return;
                }
                for _ in 0..15 {
                    if let Some(url) = daemon::settings_url() {
                        return show_settings(&welcome, url);
                    }
                    std::thread::sleep(std::time::Duration::from_secs(1));
                }
            });

            let following = setup.clone();
            let shown = window.clone();
            let quitting = handle.handle().clone();
            let asked = handle.handle().clone();
            daemon::follow(
                move |snapshot| {
                    *following.daemon.lock().unwrap() = snapshot.cloned();
                    if following.ready.load(Ordering::Relaxed) {
                        // Window, tray and menu changes belong on the main thread;
                        // made from here they wait on it, and it may be waiting on us.
                        let (app, window) = (following.clone(), shown.clone());
                        let _ = shown.run_on_main_thread(move || apply_daemon(&app, &window));
                    }
                },
                move || quitting.exit(0),
                move || open_settings(asked.clone()),
            );
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
    Settings,
    Quit,
}

impl Command {
    fn from_args(args: &[String]) -> Self {
        let flag = |name: &str| args.iter().skip(1).any(|arg| arg == name);
        if flag("--quit") {
            Self::Quit
        } else if flag("--settings") {
            Self::Settings
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
    if std::env::var_os("WAYLAND_DISPLAY").is_some() && !hyprland::available() {
        match std::env::var("GDK_BACKEND") {
            Err(_) => std::env::set_var("GDK_BACKEND", "x11"),
            Ok(backend) if backend.starts_with("wayland") => eprintln!(
                "[desktop] GDK_BACKEND={backend}: on this Wayland desktop the character cannot follow \
                 the cursor, move itself or stay above other windows. Unset GDK_BACKEND to use XWayland."
            ),
            Ok(_) => {}
        }
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
    let visibility = MenuItem::with_id(handle, "visibility", "Hide Agent Companion", true, None::<&str>)?;
    let settings = MenuItem::with_id(handle, "settings", "Settings", true, None::<&str>)?;
    let quit = MenuItem::with_id(handle, "quit", "Quit Agent Companion", true, None::<&str>)?;
    let menu = Menu::with_items(handle, &[&visibility, &settings, &quit])?;

    let tray_window = window.clone();
    let tray_app = app.clone();
    let tray = TrayIconBuilder::new()
        .icon(handle.default_window_icon().expect("a window icon").clone())
        .tooltip("Agent Companion")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |handle, event| match event.id.as_ref() {
            "quit" => handle.exit(0),
            "visibility" => {
                let hidden = tray_app.user_hidden.load(Ordering::Relaxed);
                set_user_hidden(&tray_app, &tray_window, !hidden);
            }
            // The daemon's page, where the character and the desktop
            // settings live. Asked for each time: its address carries a
            // token that changes when the daemon restarts.
            "settings" => open_settings(handle.clone()),
            _ => {}
        })
        .build(handle)?;
    *app.tray.lock().unwrap() = Some(tray);
    *app.visibility.lock().unwrap() = Some(visibility);

    // The character's right-click menu.
    let menu_window = window.clone();
    let menu_app = app.clone();
    handle.on_menu_event(move |handle, event| match event.id.as_ref() {
        "context:hide" => set_user_hidden(&menu_app, &menu_window, true),
        "context:settings" => open_settings(handle.clone()),
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
        assert_eq!(Command::from_args(&args(&["app", "--settings"])), Command::Settings);
        // The program's own path is never mistaken for a flag.
        assert_eq!(Command::from_args(&args(&["--hide"])), Command::Show);
    }
}

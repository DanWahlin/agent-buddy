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
    /// The pack the page has been told to show, and the only one served, with
    /// the version it had then.
    current: Mutex<Option<(String, PathBuf, Option<packs::Version>)>>,
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
    let version = packs::version(&next.1);
    let next = (next.0, next.1, version);
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
    let _ = window.emit("to-view-pack", serde_json::json!({ "url": packs::pack_url(&next.0, version) }));
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
        let current = app.current.lock().unwrap().as_ref().map(|(id, _, _)| id.clone()).unwrap_or_default();
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
        hide_companion(window);
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
    if let Err(error) = window.unminimize() {
        eprintln!("[desktop] could not restore the character window: {error}");
    }
    let _ = window.show();
}

fn hide_companion(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    if let Err(error) = window.hide() {
        eprintln!("[desktop] could not hide the character window: {error}");
    }
    #[cfg(target_os = "linux")]
    if hyprland::available() {
        // Hyprland has no taskbar and ignores minimize requests. The tray remains available.
        if let Err(error) = window.hide() {
            eprintln!("[desktop] could not hide the character window: {error}");
        }
        return;
    }
    // Keep the taskbar entry on Windows and Linux desktops that support minimization.
    #[cfg(not(target_os = "macos"))]
    match window.is_minimized() {
        Ok(true) => {}
        Ok(false) => {
            if let Err(error) = window.minimize() {
                eprintln!("[desktop] could not minimize the character window: {error}");
            }
        }
        Err(error) => eprintln!("[desktop] could not read the character window's minimized state: {error}"),
    }
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

fn restore_settings(window: &WebviewWindow) {
    if let Err(error) = window.unminimize().and_then(|()| window.show()) {
        eprintln!("[settings] could not restore the window: {error}");
        return;
    }
    bring_to_front(window);
}

fn reopen_app(handle: &AppHandle, app: &Arc<App>) {
    if let Some(window) = handle.get_webview_window(SETTINGS) {
        restore_settings(&window);
    } else if !app.wanted.load(Ordering::Relaxed) {
        open_settings(handle.clone());
    } else if let Some(window) = handle.get_webview_window("main") {
        set_user_hidden(app, &window, false);
    }
}

#[cfg(target_os = "windows")]
fn settings_taskbar(handle: &AppHandle, settings_open: bool) {
    if let Some(window) = handle.get_webview_window("main") {
        if let Err(error) = window.set_skip_taskbar(settings_open) {
            eprintln!("[desktop] could not update the character's taskbar entry: {error}");
        }
    }
}

#[cfg(any(test, not(target_os = "macos")))]
fn restore_on_focus(visible: bool, pointer_on_taskbar: bool) -> bool {
    !visible || pointer_on_taskbar
}

#[cfg(target_os = "macos")]
fn companion_collection_behavior(
    current: objc2_app_kit::NSWindowCollectionBehavior,
    joins_applications: bool,
) -> objc2_app_kit::NSWindowCollectionBehavior {
    use objc2_app_kit::NSWindowCollectionBehavior as Behavior;
    let mut behavior = current
        & !(Behavior::Primary | Behavior::Auxiliary | Behavior::CanJoinAllApplications
            | Behavior::FullScreenPrimary | Behavior::FullScreenNone);
    behavior |= Behavior::CanJoinAllSpaces | Behavior::FullScreenAuxiliary;
    if joins_applications {
        behavior |= Behavior::CanJoinAllApplications;
    }
    behavior
}

#[cfg(target_os = "macos")]
fn configure_companion_spaces(window: &WebviewWindow) -> tauri::Result<()> {
    use objc2_app_kit::NSWindow;
    let pointer = window.ns_window()?;
    // SAFETY: Called during setup on the main thread, while Tauri owns this window.
    let native = unsafe { &*(pointer as *const NSWindow) };
    let joins_applications = objc2::available!(macos = 13.0);
    native.setCollectionBehavior(companion_collection_behavior(native.collectionBehavior(), joins_applications));
    if !joins_applications {
        eprintln!("[desktop] macOS before 13 cannot show the character over other apps' full-screen Spaces with a Dock entry");
    }
    Ok(())
}

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
        restore_settings(&window);
        #[cfg(target_os = "windows")]
        settings_taskbar(handle, true);
        return;
    }
    // Only the pet's window may use this app's commands (capabilities/default.json),
    // so the page, which is the daemon's, gets nothing from the app.
    let monitor = handle.get_webview_window("main").and_then(|window| match window.current_monitor() {
        Ok(monitor) => monitor,
        Err(error) => {
            eprintln!("[settings] could not locate the companion's monitor: {error}");
            None
        }
    }).or_else(|| match handle.primary_monitor() {
        Ok(monitor) => monitor,
        Err(error) => {
            eprintln!("[settings] could not locate the primary monitor: {error}");
            None
        }
    });
    let built = WebviewWindowBuilder::new(handle, SETTINGS, WebviewUrl::External(url))
        .title("Agent Buddy")
        .inner_size(placement::SETTINGS_SIZE.0, placement::SETTINGS_SIZE.1)
        .min_inner_size(420.0, 480.0)
        .center()
        .skip_taskbar(false)
        .visible(false)
        .build();
    match built {
        Ok(window) => {
            #[cfg(target_os = "windows")]
            {
                settings_taskbar(handle, true);
                let taskbar_handle = handle.clone();
                window.on_window_event(move |event| {
                    if matches!(event, WindowEvent::Destroyed) {
                        settings_taskbar(&taskbar_handle, false);
                    }
                });
            }
            if let Some(monitor) = monitor {
                if let Err(error) = placement::fit_settings(&window, &monitor) {
                    eprintln!("[settings] could not fit the window to the monitor: {error}");
                }
            } else {
                eprintln!("[settings] no monitor work area is available; using the window manager's placement");
            }
            *loaded = Some(address);
            if let Err(error) = window.show() {
                eprintln!("[settings] could not show the window: {error}");
            }
            bring_to_front(&window);
        }
        Err(error) => eprintln!("[settings] could not open the window: {error}"),
    }
}

/// The label of the window that says the companion service is starting.
const STARTING: &str = "starting";
const STARTING_TITLE: &str = "Starting Agent Companion";

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
            .title(STARTING_TITLE)
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
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(target_os = "linux")]
    if hyprland::available() {
        if let Some(window) = context.config_mut().app.windows.iter_mut().find(|window| window.label == "main") {
            // GTK otherwise locks the first tiled size. Equal min/max bounds keep the character fixed.
            window.resizable = true;
        }
    }
    tauri::Builder::default()
        // Must be the first plugin. Opening the app again restores Settings first.
        .plugin(tauri_plugin_single_instance::init(move |handle, args, _cwd| {
            let Some(window) = handle.get_webview_window("main") else { return };
            let command = Command::from_args(&args);
            if !command.starts_service() {
                quit(handle.clone(), Quit::Quiet);
                return;
            }
            // Starting the app again also starts the service again if it stopped.
            let resources = handle.path().resource_dir().ok();
            std::thread::spawn(move || service::ensure(resources));
            show_starting(handle.clone(), again.clone());
            match command {
                Command::Reopen => reopen_app(handle, &again),
                Command::Show => set_user_hidden(&again, &window, false),
                Command::Hide => set_user_hidden(&again, &window, true),
                Command::Toggle => {
                    let hidden = again.user_hidden.load(Ordering::Relaxed);
                    set_user_hidden(&again, &window, !hidden);
                }
                Command::Settings => open_settings(handle.clone()),
                Command::Quit => quit(handle.clone(), Quit::Quiet),
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(app.clone())
        .invoke_handler(tauri::generate_handler![
            set_region, from_view, start_drag, set_tray_icon, show_context_menu, open_settings, set_sounds
        ])
        // Only the pack the page was told to show can be fetched, by its id.
        .register_uri_scheme_protocol(packs::SCHEME, move |_ctx, request| {
            let current = serving.current.lock().unwrap().clone();
            let file = packs::requested_id(request.uri().path())
                .zip(current)
                .filter(|(id, (current_id, _, _))| id == current_id)
                .map(|(_, (_, path, _))| path);
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
            let command = Command::from_args(&std::env::args().collect::<Vec<_>>());
            if !command.starts_service() {
                handle.handle().exit(0);
                return Ok(());
            }
            if matches!(command, Command::Hide | Command::Toggle) {
                setup.user_hidden.store(true, Ordering::Relaxed);
            }
            #[cfg(target_os = "macos")]
            handle.handle().set_activation_policy(tauri::ActivationPolicy::Regular)?;

            let window: WebviewWindow = handle.get_webview_window("main").expect("the main window");
            #[cfg(target_os = "macos")]
            configure_companion_spaces(&window)?;

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
            #[cfg(not(target_os = "macos"))]
            let controlled = setup.clone();
            window.on_window_event(move |event| match event {
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    quit(moving.app_handle().clone(), Quit::Ask);
                }
                #[cfg(not(target_os = "macos"))]
                WindowEvent::Focused(true) => {
                    let visible = controlled.visible.load(Ordering::Relaxed);
                    if restore_on_focus(visible, pointer::cursor_on_taskbar(&moving)) {
                        if !visible {
                            hide_companion(&moving);
                        }
                        reopen_app(moving.app_handle(), &controlled);
                    }
                }
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
            if command == Command::Settings {
                open_settings(handle.handle().clone());
            }

            // A release build carries the companion service, and starts it
            // when no other one runs. New and returning users with incomplete
            // setup see the shared setup page once the service answers.
            let resources = handle.path().resource_dir().ok();
            setup.bundled.store(service::bundled(resources.as_deref()), Ordering::Relaxed);
            show_starting(handle.handle().clone(), setup.clone());
            let welcome = handle.handle().clone();
            std::thread::spawn(move || {
                let installed = service::ensure(resources);
                for _ in 0..15 {
                    if let Some(pending) = daemon::setup_due() {
                        if installed || pending {
                            if let Some(url) = daemon::settings_url() {
                                show_settings(&welcome, url);
                            }
                        }
                        return;
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
        .build(context)
        .expect("the app should start")
        .run(move |handle, event| {
            // macOS: opening the app again from Finder, Spotlight or the Dock.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                reopen_app(handle, &reopened);
                return;
            }
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = &event {
                api.prevent_exit();
                quit(handle.clone(), Quit::Ask);
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
    Reopen,
    Show,
    Hide,
    Toggle,
    Settings,
    Quit,
}

impl Command {
    fn starts_service(&self) -> bool {
        *self != Self::Quit
    }

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
        } else if flag("--show") {
            Self::Show
        } else {
            Self::Reopen
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
    let Some(configured) = window.app_handle().config().app.windows.iter().find(|it| it.label == window.label()) else {
        eprintln!("[hyprland] the character window has no configured size");
        return;
    };
    let size = tauri::LogicalSize::new(configured.width, configured.height);
    let resized = window.clone();
    std::thread::spawn(move || {
        if hyprland::settle(at).is_none() {
            eprintln!("[hyprland] the window did not appear to Hyprland");
            return;
        }
        if let Err(error) = resized.set_size(size) {
            eprintln!("[hyprland] could not restore the configured character size: {error}");
        }
    });
}

/// How the user quit: from a menu, from `--quit`, or with the tray's item
/// that also stops the companion service.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Quit {
    Ask,
    Quiet,
    AndStopService,
}

#[derive(Debug, PartialEq)]
enum QuitPlan {
    App,
    AppAndService,
    /// Say one time that the service keeps the device going, and let the user choose.
    Ask,
}

/// Without a device the service has nothing to do, so it stops with the app,
/// when the app can start it again. With a device it keeps running.
fn quit_plan(how: Quit, device_used: Option<bool>, can_restart: bool, notice_due: bool) -> QuitPlan {
    match (how, device_used) {
        (Quit::AndStopService, _) => QuitPlan::AppAndService,
        (_, Some(false)) if can_restart => QuitPlan::AppAndService,
        (Quit::Ask, Some(true)) if notice_due => QuitPlan::Ask,
        _ => QuitPlan::App,
    }
}

/// Off the main thread: it asks the daemon, and the notice waits for the user.
fn quit(handle: tauri::AppHandle, how: Quit) {
    std::thread::spawn(move || {
        let cached_busy = handle.state::<Arc<App>>().daemon.lock().unwrap().as_ref().is_some_and(|it| it.busy);
        if daemon::installing().unwrap_or(cached_busy) {
            use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
            handle.dialog().message("Setup or installation is in progress. Keep the USB cable connected and wait before quitting.")
                .title("Agent Buddy").kind(MessageDialogKind::Info).blocking_show();
            return;
        }
        let can_restart = handle.state::<Arc<App>>().bundled.load(Ordering::Relaxed);
        let notice_due = how == Quit::Ask && service::quit_notice_due();
        let stop = match quit_plan(how, daemon::device_used(), can_restart, notice_due) {
            QuitPlan::App => false,
            QuitPlan::AppAndService => true,
            QuitPlan::Ask => match ask_on_quit(&handle) {
                Some(stop) => {
                    service::remember_quit_notice();
                    stop
                }
                None => return,
            },
        };
        if stop && !daemon::stop_service() {
            eprintln!("[service] the companion service did not take the stop request");
        }
        if daemon::installing().unwrap_or(cached_busy) {
            use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
            handle.dialog().message("Setup or installation started before the app could close. Wait before quitting.")
                .title("Agent Buddy").kind(MessageDialogKind::Info).blocking_show();
            return;
        }
        handle.exit(0);
    });
}

/// Some(true) to stop the service too, Some(false) to close only the app, None to cancel.
fn ask_on_quit(handle: &tauri::AppHandle) -> Option<bool> {
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};
    const CLOSE: &str = "Close App";
    const STOP: &str = "Close App and Stop Service";
    const CANCEL: &str = "Cancel";
    let result = handle
        .dialog()
        .message(
            "Your device continues to show agent activity after the app closes, because the companion \
             service runs in the background.\n\nTo stop the service too, choose Close App and Stop Service. \
             The tray menu also has Quit and Stop Companion Service. This message shows one time only.",
        )
        .title("Close Agent Companion?")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::YesNoCancelCustom(CLOSE.into(), STOP.into(), CANCEL.into()))
        .blocking_show_with_result();
    match result {
        MessageDialogResult::Yes => Some(false),
        MessageDialogResult::No => Some(true),
        MessageDialogResult::Custom(label) if label == CLOSE => Some(false),
        MessageDialogResult::Custom(label) if label == STOP => Some(true),
        _ => None,
    }
}

/// The tray keeps character controls and an explicit service-stop action available.
fn build_tray(handle: &tauri::AppHandle, window: &WebviewWindow, app: &Arc<App>) -> tauri::Result<()> {
    let visibility = MenuItem::with_id(handle, "visibility", "Hide Agent Companion", true, None::<&str>)?;
    let settings = MenuItem::with_id(handle, "settings", "Settings", true, None::<&str>)?;
    let quit_app = MenuItem::with_id(handle, "quit", "Quit Agent Companion", true, None::<&str>)?;
    let quit_all = MenuItem::with_id(handle, "quit-and-stop", "Quit and Stop Companion Service", true, None::<&str>)?;
    let separator = tauri::menu::PredefinedMenuItem::separator(handle)?;
    let menu = Menu::with_items(handle, &[&visibility, &settings, &separator, &quit_app, &quit_all])?;

    let tray_window = window.clone();
    let tray_app = app.clone();
    let tray = TrayIconBuilder::new()
        .icon(handle.default_window_icon().expect("a window icon").clone())
        .tooltip("Agent Companion")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |handle, event| match event.id.as_ref() {
            "quit" => quit(handle.clone(), Quit::Ask),
            "quit-and-stop" => quit(handle.clone(), Quit::AndStopService),
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
        "context:close" => quit(handle.clone(), Quit::Ask),
        _ => {}
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{quit_plan, Command, Quit, QuitPlan};

    #[test]
    fn quit_stops_the_service_only_without_a_device_or_when_asked() {
        assert_eq!(quit_plan(Quit::AndStopService, Some(true), false, false), QuitPlan::AppAndService);
        assert_eq!(quit_plan(Quit::AndStopService, None, true, true), QuitPlan::AppAndService);
        assert_eq!(quit_plan(Quit::Ask, Some(false), true, true), QuitPlan::AppAndService);
        assert_eq!(quit_plan(Quit::Quiet, Some(false), true, false), QuitPlan::AppAndService);
        // A build without the service cannot start it again, so it leaves it running.
        assert_eq!(quit_plan(Quit::Ask, Some(false), false, true), QuitPlan::App);
        assert_eq!(quit_plan(Quit::Ask, Some(true), true, true), QuitPlan::Ask);
        assert_eq!(quit_plan(Quit::Ask, Some(true), true, false), QuitPlan::App);
        assert_eq!(quit_plan(Quit::Quiet, Some(true), true, true), QuitPlan::App);
        assert_eq!(quit_plan(Quit::Ask, None, true, true), QuitPlan::App);
    }

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|it| it.to_string()).collect()
    }

    #[test]
    fn a_second_launch_restores_the_app_unless_asked_otherwise() {
        assert_eq!(Command::from_args(&args(&["agent-companion-desktop"])), Command::Reopen);
        assert_eq!(Command::from_args(&args(&["app", "--show"])), Command::Show);
        assert_eq!(Command::from_args(&args(&["app", "--hide"])), Command::Hide);
        assert_eq!(Command::from_args(&args(&["app", "--toggle"])), Command::Toggle);
        assert_eq!(Command::from_args(&args(&["app", "--quit"])), Command::Quit);
        assert_eq!(Command::from_args(&args(&["app", "--settings"])), Command::Settings);
        // The program's own path is never mistaken for a flag.
        assert_eq!(Command::from_args(&args(&["--hide"])), Command::Reopen);
    }

    #[test]
    fn a_quit_command_never_starts_or_restarts_the_service() {
        assert!(!Command::from_args(&args(&["app", "--quit"])).starts_service());
        assert!(Command::from_args(&args(&["app"])).starts_service());
        assert!(Command::from_args(&args(&["app", "--settings"])).starts_service());
    }

    #[test]
    fn clicking_the_character_does_not_raise_settings_but_taskbar_activation_does() {
        assert!(!super::restore_on_focus(true, false));
        assert!(super::restore_on_focus(true, true));
        assert!(super::restore_on_focus(false, true));
        assert!(super::restore_on_focus(false, false));
    }

    #[test]
    fn minimizing_settings_does_not_restore_it_when_focus_falls_back_to_the_character() {
        assert!(!super::restore_on_focus(true, false));
    }

    #[test]
    fn the_startup_title_matches_its_page_and_is_distinct_from_the_character() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let character_title = config["app"]["windows"][0]["title"].as_str().unwrap();
        assert_ne!(super::STARTING_TITLE, character_title);
        assert!(include_str!("../../ui/starting.html")
            .contains(&format!("<title>{}</title>", super::STARTING_TITLE)));
    }

    #[test]
    fn the_character_keeps_a_taskbar_entry_without_changing_its_overlay() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let window = &config["app"]["windows"][0];
        assert_eq!(window["skipTaskbar"], false);
        assert_eq!(window["alwaysOnTop"], true);
        assert_eq!(window["transparent"], true);
        assert_eq!(window["visibleOnAllWorkspaces"], true);
        assert_eq!(window["focus"], false);
        assert_eq!(window["minWidth"], window["width"]);
        assert_eq!(window["maxWidth"], window["width"]);
        assert_eq!(window["minHeight"], window["height"]);
        assert_eq!(window["maxHeight"], window["height"]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_character_can_join_full_screen_spaces_without_conflicting_behaviors() {
        use objc2_app_kit::NSWindowCollectionBehavior as Behavior;
        let current = Behavior::Primary | Behavior::Auxiliary | Behavior::FullScreenPrimary
            | Behavior::FullScreenNone | Behavior::Stationary;
        let modern = super::companion_collection_behavior(current, true);
        assert!(modern.contains(Behavior::CanJoinAllSpaces | Behavior::FullScreenAuxiliary
            | Behavior::CanJoinAllApplications | Behavior::Stationary));
        assert!(!modern.intersects(Behavior::Primary | Behavior::Auxiliary | Behavior::FullScreenPrimary
            | Behavior::FullScreenNone));
        let legacy = super::companion_collection_behavior(modern, false);
        assert!(legacy.contains(Behavior::CanJoinAllSpaces | Behavior::FullScreenAuxiliary | Behavior::Stationary));
        assert!(!legacy.contains(Behavior::CanJoinAllApplications));
    }
}

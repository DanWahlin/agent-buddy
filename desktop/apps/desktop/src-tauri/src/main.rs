#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The companion as a window of its own.
//!
//! This is only the window. Everything that decides what the character should
//! be doing - the endpoint, the coordinators, which project a hook belongs to -
//! runs in the Node process this spawns, because that code is already written
//! and already tested on three platforms. The two speak newline-delimited JSON
//! over stdio, so a Rust bridge could replace it later without this file
//! changing.
//!
//! What is genuinely this side's job is being a pet: a transparent window that
//! stays out of the way until the pointer is actually on the character, can be
//! picked up and moved, and can be quit.

mod bridge;
mod packs;
mod placement;
mod pointer;

use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use tauri::menu::{Menu, MenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WebviewWindow, WindowEvent};

use bridge::Bridge;
use packs::Pack;
use placement::Placement;
use pointer::{Pointer, Region};

struct App {
    pointer: Arc<Pointer>,
    /// Whether the page has ever reported drawing anything.
    drawn: AtomicBool,
    bridge: Mutex<Option<Bridge>>,
    packs: Mutex<Vec<Pack>>,
    showing: Mutex<Option<String>>,
}

/// The page saying where it drew the character.
///
/// The first of these is the only proof from out here that anything was drawn
/// at all: the canvas is not sized until a pack has loaded, so a window that
/// stays silent has failed to load one - which is how a lost `to-view-pack`
/// showed up as an empty window and nothing else.
#[tauri::command]
fn set_region(app: tauri::State<'_, Arc<App>>, region: Region) {
    if !app.drawn.swap(true, std::sync::atomic::Ordering::Relaxed) {
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
        Some("ready") => show_current_pack(&app, &window),
        Some("failed") => eprintln!(
            "the page failed: {}",
            message.get("message").and_then(|value| value.as_str()).unwrap_or("?")
        ),
        _ => {}
    }
}

/// Drive a state by hand, which reaches every window on the machine.
#[tauri::command]
fn simulate(app: tauri::State<'_, Arc<App>>, state: String) {
    if let Some(bridge) = app.bridge.lock().unwrap().as_ref() {
        bridge.send(&serde_json::json!({ "type": "send", "state": state }));
    }
}

/// Pick the window up.
///
/// There is no title bar to drag - a pet with one would be a dialog - so the
/// character itself is the handle. The page decides when this is a drag rather
/// than a poke, because only it knows whether the pointer moved.
#[tauri::command]
fn start_drag(window: WebviewWindow) {
    let _ = window.start_dragging();
}

/// Tell the page which pack to fetch, as a URL it is allowed to load.
fn show_current_pack(app: &Arc<App>, window: &WebviewWindow) {
    let packs = app.packs.lock().unwrap();
    let wanted = app.showing.lock().unwrap().clone();
    let Some(pack) = packs::choose(&packs, wanted.as_deref()) else {
        let _ = window.emit(
            "to-view",
            serde_json::json!({ "type": "error", "message": "No character packs were found." }),
        );
        return;
    };

    println!("[packs] showing {}", pack.id);

    // Every pack is served the same way, wherever it lives, so the page has one
    // kind of URL to deal with and the renderer resolves image names against it
    // exactly as it would over http.
    let _ = window.emit(
        "to-view-pack",
        serde_json::json!({ "url": packs::manifest_url(&pack.id) }),
    );
}

fn main() {
    let app = Arc::new(App {
        pointer: Arc::new(Pointer::new()),
        drawn: AtomicBool::new(false),
        bridge: Mutex::new(None),
        packs: Mutex::new(Vec::new()),
        showing: Mutex::new(None),
    });

    let setup = app.clone();
    let exiting = app.clone();
    let serving = app.clone();
    tauri::Builder::default()
        .manage(app.clone())
        .invoke_handler(tauri::generate_handler![set_region, from_view, simulate, start_drag])
        // Packs are served from here rather than read by the page. Only the
        // packs found at startup are reachable, and only within their own
        // folders, so this is a narrower door than a filesystem scope.
        .register_uri_scheme_protocol(packs::SCHEME, move |_ctx, request| {
            let found = {
                let known = serving.packs.lock().unwrap();
                packs::resolve(&known, request.uri().path())
            };
            let Some(file) = found else {
                return tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .expect("a 404 is always buildable");
            };
            match std::fs::read(&file) {
                Ok(bytes) => tauri::http::Response::builder()
                    .header("content-type", packs::content_type(&file))
                    // The page and this protocol are different origins, so
                    // without this every fetch fails CORS before it is read.
                    // Saying so costs nothing: only the packs found at startup
                    // are reachable here in the first place.
                    .header("access-control-allow-origin", "*")
                    .body(bytes)
                    .expect("a body is always buildable"),
                Err(error) => {
                    eprintln!("[packs] could not read {}: {error}", file.display());
                    tauri::http::Response::builder()
                        .status(500)
                        .body(Vec::new())
                        .expect("a 500 is always buildable")
                }
            }
        })
        .setup(move |handle| {
            let window: WebviewWindow = handle.get_webview_window("main").expect("the main window");

            // Start transparent to the mouse. If the page never reports where
            // it drew, the desktop stays usable rather than this swallowing
            // every click on the screen.
            let _ = window.set_ignore_cursor_events(true);

            placement::restore(&window);

            let mine: Vec<std::path::PathBuf> = packs::user_folder(&window).into_iter().collect();
            if let (Some(script), Some(bundled)) = (
                packs::locate("scripts/discover-packs.mjs"),
                packs::locate("ui/packs"),
            ) {
                *setup.packs.lock().unwrap() = packs::discover(&script, &bundled, &mine);
            }
            *setup.showing.lock().unwrap() = packs::remembered(&window);

            build_tray(handle.handle(), &window, &setup)?;

            // Remember where it is put. Tauri reports every step of a drag, so
            // this writes often; the file is two numbers and the alternative is
            // losing the position when the app is killed rather than quit.
            let moving = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::Moved(at) = event {
                    placement::remember(&moving, Placement { x: at.x, y: at.y });
                }
            });

            setup.pointer.clone().watch(window.clone());

            match Bridge::spawn(window.clone()) {
                Ok(started) => *setup.bridge.lock().unwrap() = Some(started),
                // Worth saying, and worth still showing the character: it is
                // just as useful asleep as it is absent.
                Err(error) => eprintln!("could not start the bridge: {error}"),
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the app should start")
        .run(move |_handle, event| {
            // The bridge holds the endpoint, and the other windows only take
            // over promptly because it closes its connections on the way out.
            // Exiting without telling it would leave them waiting.
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                if let Some(bridge) = exiting.bridge.lock().unwrap().take() {
                    bridge.stop();
                }
            }
        });
}

/// With no title bar and no taskbar button, the tray is the only way in.
fn build_tray(
    handle: &tauri::AppHandle,
    window: &WebviewWindow,
    app: &Arc<App>,
) -> tauri::Result<()> {
    let packs = app.packs.lock().unwrap().clone();

    let mut entries: Vec<MenuItem<tauri::Wry>> = Vec::new();
    for pack in &packs {
        entries.push(MenuItem::with_id(
            handle,
            format!("pack:{}", pack.id),
            &pack.name,
            true,
            None::<&str>,
        )?);
    }
    let references: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        entries.iter().map(|item| item as &dyn tauri::menu::IsMenuItem<tauri::Wry>).collect();
    let characters = Submenu::with_items(handle, "Character", !entries.is_empty(), &references)?;

    let folder = MenuItem::with_id(handle, "folder", "Open Characters Folder…", true, None::<&str>)?;
    let centre = MenuItem::with_id(handle, "centre", "Bring Back to Centre", true, None::<&str>)?;
    let quit = MenuItem::with_id(handle, "quit", "Quit Agent Companion", true, None::<&str>)?;
    let menu = Menu::with_items(handle, &[&characters, &folder, &centre, &quit])?;

    let tray_window = window.clone();
    let tray_app = app.clone();
    TrayIconBuilder::new()
        .icon(handle.default_window_icon().expect("a window icon").clone())
        .tooltip("Agent Companion")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(move |handle, event| {
            let id = event.id.as_ref();
            match id {
                "quit" => handle.exit(0),
                // For when it has ended up somewhere unreachable - a screen
                // that has since gone, or dragged almost off an edge.
                "centre" => {
                    let _ = tray_window.center();
                }
                // Drop a pack folder in here and it is picked up next start.
                "folder" => {
                    if let Some(mine) = packs::user_folder(&tray_window) {
                        packs::reveal(&mine);
                    }
                }
                _ if id.starts_with("pack:") => {
                    let chosen = id.trim_start_matches("pack:").to_string();
                    *tray_app.showing.lock().unwrap() = Some(chosen.clone());
                    packs::remember(&tray_window, &chosen);
                    show_current_pack(&tray_app, &tray_window);
                }
                _ => {}
            }
        })
        .build(handle)?;
    Ok(())
}

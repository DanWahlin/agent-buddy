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
//! stays out of the way until the pointer is actually on the character.

mod bridge;
mod placement;
mod pointer;

use std::sync::{Arc, Mutex};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WebviewWindow, WindowEvent};

use bridge::Bridge;
use placement::Placement;
use pointer::{Pointer, Region};

struct App {
    pointer: Arc<Pointer>,
    bridge: Mutex<Option<Bridge>>,
}

/// The page saying where it drew the character.
#[tauri::command]
fn set_region(app: tauri::State<'_, Arc<App>>, region: Region) {
    app.pointer.set_region(region);
}

/// The page talking back. It has little to say yet beyond being ready.
#[tauri::command]
fn from_view(message: serde_json::Value) {
    if message.get("type").and_then(|value| value.as_str()) == Some("failed") {
        eprintln!(
            "the page failed: {}",
            message.get("message").and_then(|value| value.as_str()).unwrap_or("?")
        );
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

fn main() {
    let app = Arc::new(App {
        pointer: Arc::new(Pointer::new()),
        bridge: Mutex::new(None),
    });

    let setup = app.clone();
    tauri::Builder::default()
        .manage(app.clone())
        .invoke_handler(tauri::generate_handler![set_region, from_view, simulate, start_drag])
        .setup(move |handle| {
            let window: WebviewWindow = handle.get_webview_window("main").expect("the main window");

            // Start transparent to the mouse. If the page never reports where
            // it drew, the desktop stays usable rather than this swallowing
            // every click on the screen.
            let _ = window.set_ignore_cursor_events(true);

            placement::restore(&window);

            // With no title bar and no taskbar button, the tray is the only way
            // to quit. Without it the only way out is killing the terminal,
            // which is a trap rather than a missing convenience.
            let quit = MenuItem::with_id(handle, "quit", "Quit Agent Companion", true, None::<&str>)?;
            let centre = MenuItem::with_id(handle, "centre", "Bring Back to Centre", true, None::<&str>)?;
            let menu = Menu::with_items(handle, &[&centre, &quit])?;
            let tray_window = window.clone();
            TrayIconBuilder::new()
                .icon(handle.default_window_icon().expect("a window icon").clone())
                .tooltip("Agent Companion")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    // For when it has ended up somewhere unreachable - a screen
                    // that has since gone, or dragged almost off an edge.
                    "centre" => { let _ = tray_window.center(); }
                    _ => {}
                })
                .build(handle)?;

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
                if let Some(bridge) = app.bridge.lock().unwrap().take() {
                    bridge.stop();
                }
            }
        });
}

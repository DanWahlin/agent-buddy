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
mod pointer;

use std::sync::{Arc, Mutex};

use tauri::{Manager, WebviewWindow};

use bridge::Bridge;
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

fn main() {
    let app = Arc::new(App {
        pointer: Arc::new(Pointer::new()),
        bridge: Mutex::new(None),
    });

    let setup = app.clone();
    tauri::Builder::default()
        .manage(app.clone())
        .invoke_handler(tauri::generate_handler![set_region, from_view, simulate])
        .setup(move |handle| {
            let window: WebviewWindow = handle.get_webview_window("main").expect("the main window");

            // Start transparent to the mouse. If the page never reports where
            // it drew, the desktop stays usable rather than this swallowing
            // every click on the screen.
            let _ = window.set_ignore_cursor_events(true);

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

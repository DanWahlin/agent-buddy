// Keep the console in dev so the prototype can report what it is doing.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Does Tauri's click-through hold up for a desktop pet?
//!
//! Electron has `setIgnoreMouseEvents(true, { forward: true })`: clicks fall
//! through to whatever is behind, but the window still sees the pointer move.
//! Tauri has no equivalent - `set_ignore_cursor_events` is all or nothing, and
//! the `forward` option is still an open request (tauri-apps/tauri#6164). So
//! while click-through is on, the page receives nothing at all and cannot tell
//! when the cursor has arrived over the character.
//!
//! The way round it is to do the hit test outside the webview: read the cursor
//! position, decide whether it is over the character, and turn click-through
//! off only then. That is not a workaround so much as a thing we need anyway -
//! a desktop pet has to follow the pointer across the whole screen, which a
//! webview cannot see either.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow};

/// The character's opaque area, in CSS pixels within the window.
///
/// An ellipse rather than the real alpha mask: the art is a head, the firmware
/// already clips its effects to an ellipse around one, and reading pixels back
/// every frame to test a cursor would cost far more than it is worth.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
struct Region {
    cx: f64,
    cy: f64,
    rx: f64,
    ry: f64,
}

/// Is this point within the region, allowing for a margin?
///
/// The margin gives the edge some hysteresis. Without it the cursor sitting
/// exactly on the boundary flips click-through on and off every poll, which
/// costs a window style change each time and reads as a flicker.
fn inside(region: &Region, x: f64, y: f64, margin: f64) -> bool {
    let rx = region.rx + margin;
    let ry = region.ry + margin;
    if rx <= 0.0 || ry <= 0.0 {
        return false;
    }
    let dx = (x - region.cx) / rx;
    let dy = (y - region.cy) / ry;
    dx * dx + dy * dy <= 1.0
}

const STICKY_MARGIN: f64 = 6.0;
const POLL: Duration = Duration::from_millis(16);

struct State {
    region: Mutex<Region>,
    /// What the page last reported, so the log can say when it changed.
    over: Mutex<bool>,
}

/// The page tells us where it drew the character.
#[tauri::command]
fn set_region(state: tauri::State<'_, Arc<State>>, region: Region) {
    *state.region.lock().unwrap() = region;
    println!("[region] cx={:.1} cy={:.1} rx={:.1} ry={:.1}", region.cx, region.cy, region.rx, region.ry);
}

/// Run the hit test without touching the cursor, so it can be checked in a test.
#[tauri::command]
fn probe(state: tauri::State<'_, Arc<State>>, x: f64, y: f64) -> bool {
    inside(&state.region.lock().unwrap(), x, y, 0.0)
}

/// Whether the pointer is currently over the character.
#[tauri::command]
fn is_over(state: tauri::State<'_, Arc<State>>) -> bool {
    *state.over.lock().unwrap()
}

/// Follow the cursor and hand the window over only when it is on the character.
fn watch_cursor(window: WebviewWindow, state: Arc<State>) {
    // Start transparent to the mouse. If anything below goes wrong, the desktop
    // stays usable rather than the window swallowing every click on the screen.
    let _ = window.set_ignore_cursor_events(true);
    let mut over = false;

    loop {
        std::thread::sleep(POLL);

        let Ok(cursor) = window.app_handle().cursor_position() else { continue };
        let (Ok(origin), Ok(scale)) = (window.inner_position(), window.scale_factor()) else { continue };

        // Cursor and window are both in physical pixels; the region the page
        // reported is in CSS pixels, so the difference is scaled once here.
        let x = (cursor.x - origin.x as f64) / scale;
        let y = (cursor.y - origin.y as f64) / scale;

        let region = *state.region.lock().unwrap();
        let margin = if over { STICKY_MARGIN } else { 0.0 };
        let now = inside(&region, x, y, margin);

        if now != over {
            over = now;
            *state.over.lock().unwrap() = now;
            // Over the character the window takes the mouse, so hovering and
            // poking work. Anywhere else it is not there as far as the mouse
            // is concerned.
            let _ = window.set_ignore_cursor_events(!now);
            println!("[cursor] {:.0},{:.0} -> {}", x, y, if now { "over the character (window takes the mouse)" } else { "off it (clicks pass through)" });
        }
    }
}

/// Cycle click-through on a timer so the window style can be watched from
/// outside, without moving the real cursor about.
fn self_test(window: WebviewWindow) {
    println!("[self-test] cycling click-through every 800ms");
    let mut ignore = true;
    loop {
        let _ = window.set_ignore_cursor_events(ignore);
        println!("[self-test] set_ignore_cursor_events({})", ignore);
        ignore = !ignore;
        std::thread::sleep(Duration::from_millis(800));
    }
}

fn main() {
    let state = Arc::new(State {
        region: Mutex::new(Region::default()),
        over: Mutex::new(false),
    });

    let testing = std::env::args().any(|argument| argument == "--self-test");

    tauri::Builder::default()
        .manage(state.clone())
        .invoke_handler(tauri::generate_handler![set_region, probe, is_over])
        .setup(move |app| {
            let window = app.get_webview_window("main").expect("the main window");

            #[cfg(windows)]
            if let Ok(handle) = window.hwnd() {
                // Printed so the checks outside can find this exact window.
                println!("[window] hwnd={}", handle.0 as isize);
            }

            let for_thread = window.clone();
            let state = state.clone();
            std::thread::spawn(move || {
                if testing {
                    self_test(for_thread)
                } else {
                    watch_cursor(for_thread, state)
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the prototype should start");
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEAD: Region = Region { cx: 100.0, cy: 100.0, rx: 60.0, ry: 50.0 };

    #[test]
    fn the_centre_is_on_the_character() {
        assert!(inside(&HEAD, 100.0, 100.0, 0.0));
    }

    #[test]
    fn a_corner_of_the_window_is_not() {
        // The case that matters: a square window, an elliptical character, and
        // a click in the empty corner that has to reach what is behind.
        assert!(!inside(&HEAD, 0.0, 0.0, 0.0));
        assert!(!inside(&HEAD, 200.0, 200.0, 0.0));
    }

    #[test]
    fn the_edges_of_the_ellipse_are_included() {
        assert!(inside(&HEAD, 160.0, 100.0, 0.0));
        assert!(inside(&HEAD, 100.0, 150.0, 0.0));
        assert!(!inside(&HEAD, 161.0, 100.0, 0.0));
        assert!(!inside(&HEAD, 100.0, 151.0, 0.0));
    }

    #[test]
    fn the_margin_holds_on_just_past_the_edge() {
        // Leaving is stickier than arriving, so the boundary does not chatter.
        assert!(!inside(&HEAD, 164.0, 100.0, 0.0));
        assert!(inside(&HEAD, 164.0, 100.0, STICKY_MARGIN));
    }

    /// Replayed from a real session, with the region the page reported.
    ///
    /// Invented points cluster in the easy middle of the shape. These are where
    /// a hand actually took the mouse, and four of them land within a few
    /// percent of the boundary - which is the only place the sticky edge does
    /// any work, and the only place this can go wrong.
    #[test]
    fn the_transitions_seen_in_use_are_the_ones_the_geometry_gives() {
        let region = Region { cx: 130.0, cy: 120.0, rx: 88.4, ry: 78.0 };
        let observed = [
            (144.0, 189.0, true), (41.0, 82.0, false),
            (54.0, 122.0, true), (57.0, 51.0, false),
            (46.0, 103.0, true), (38.0, 96.0, false),
            (129.0, 46.0, true), (176.0, 201.0, false),
            (128.0, 174.0, true), (33.0, 182.0, false),
            (82.0, 184.0, true), (208.0, 203.0, false),
            (210.0, 137.0, true), (133.0, 206.0, false),
        ];

        let mut over = false;
        for (x, y, logged) in observed {
            // Leaving is stickier than arriving, as the watcher does it.
            let margin = if over { STICKY_MARGIN } else { 0.0 };
            let computed = inside(&region, x, y, margin);
            assert_eq!(computed, logged, "at {x},{y}");
            over = computed;
        }
    }

    #[test]
    fn a_region_nobody_has_reported_yet_claims_nothing() {
        // Before the page reports, every click must pass through - not none.
        let empty = Region::default();
        assert!(!inside(&empty, 0.0, 0.0, 0.0));
        assert!(!inside(&empty, 100.0, 100.0, 0.0));
    }
}

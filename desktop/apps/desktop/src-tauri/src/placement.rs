//! Remembering where the companion was put.
//!
//! A pet that returns to the middle of the screen every time it starts is a pet
//! you move every time it starts. So the position is written when it settles
//! and read back on the way up.
//!
//! The awkward part is not saving it but trusting it. A position is only
//! meaningful while the screen it was on still exists: unplug the monitor it
//! was living on, or come back from a dock, and the saved point is somewhere
//! nobody can see. So it is checked against the monitors that exist *now*, and
//! ignored when it no longer lands on one.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{Manager, PhysicalPosition, WebviewWindow};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Placement {
    pub x: i32,
    pub y: i32,
}

/// What the window is configured to be, for when it cannot yet say.
const FALLBACK_SIZE: (u32, u32) = (220, 220);

fn file(window: &WebviewWindow) -> Option<PathBuf> {
    let directory = window.app_handle().path().app_data_dir().ok()?;
    Some(directory.join("placement.json"))
}

/// Is enough of the window on a screen to see and grab?
///
/// How much of it overlaps a monitor, not where its corner is. A corner test
/// has to guess: it cannot tell a window hanging 40 pixels off the left edge,
/// which is mostly visible, from one hanging 200 off, which is not. The window
/// is small, so a strip of it is all that needs to be reachable.
pub fn visible_on(
    monitors: &[(PhysicalPosition<i32>, (u32, u32))],
    at: Placement,
    size: (u32, u32),
) -> bool {
    const NEEDED: i32 = 48;
    let (window_width, window_height) = (size.0 as i32, size.1 as i32);

    monitors.iter().any(|(origin, (screen_width, screen_height))| {
        let across = (at.x + window_width).min(origin.x + *screen_width as i32) - at.x.max(origin.x);
        let down = (at.y + window_height).min(origin.y + *screen_height as i32) - at.y.max(origin.y);
        across >= NEEDED && down >= NEEDED
    })
}

fn monitors_of(window: &WebviewWindow) -> Vec<(PhysicalPosition<i32>, (u32, u32))> {
    window
        .available_monitors()
        .map(|found| {
            found
                .into_iter()
                .map(|monitor| {
                    let size = monitor.size();
                    (*monitor.position(), (size.width, size.height))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Put the window back where it was, if that is still a place.
pub fn restore(window: &WebviewWindow) {
    let Some(path) = file(window) else { return };
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    let Ok(saved) = serde_json::from_str::<Placement>(&text) else { return };

    // Asked before the window has been laid out, so a zero size is an answer
    // meaning "not yet" rather than "no window". Taken literally it makes every
    // saved position look off-screen, and the position is never restored.
    let measured = window.outer_size().map(|it| (it.width, it.height)).unwrap_or((0, 0));
    let size = match measured {
        (0, _) | (_, 0) => FALLBACK_SIZE,
        known => known,
    };

    if !visible_on(&monitors_of(window), saved, size) {
        // Not an error worth showing anyone: the screen it lived on is simply
        // not here today. Where it opened is where it would have gone anyway.
        println!("[placement] {},{} is off-screen now; leaving it where it opened", saved.x, saved.y);
        return;
    }
    println!("[placement] back to {},{}", saved.x, saved.y);
    let _ = window.set_position(PhysicalPosition::new(saved.x, saved.y));
}

/// Write down where it is now.
pub fn remember(window: &WebviewWindow, at: Placement) {
    let Some(path) = file(window) else { return };
    if let Some(directory) = path.parent() {
        let _ = std::fs::create_dir_all(directory);
    }
    if let Ok(text) = serde_json::to_string(&at) {
        let _ = std::fs::write(path, text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WINDOW: (u32, u32) = (220, 220);

    fn screen(x: i32, y: i32, w: u32, h: u32) -> (PhysicalPosition<i32>, (u32, u32)) {
        (PhysicalPosition::new(x, y), (w, h))
    }

    #[test]
    fn a_point_on_the_only_screen_is_fine() {
        let screens = [screen(0, 0, 1920, 1080)];
        assert!(visible_on(&screens, Placement { x: 100, y: 100 }, WINDOW));
    }

    #[test]
    fn a_point_on_a_second_screen_is_fine_too() {
        // A monitor to the left has negative coordinates, which is the case
        // that catches a naive "is it positive" check.
        let screens = [screen(0, 0, 1920, 1080), screen(-1920, 0, 1920, 1080)];
        assert!(visible_on(&screens, Placement { x: -1800, y: 200 }, WINDOW));
    }

    #[test]
    fn the_screen_it_lived_on_going_away_is_noticed() {
        let docked = [screen(0, 0, 1920, 1080), screen(1920, 0, 2560, 1440)];
        let laptop = [screen(0, 0, 1920, 1080)];
        let on_the_second = Placement { x: 2400, y: 300 };

        assert!(visible_on(&docked, on_the_second, WINDOW));
        assert!(!visible_on(&laptop, on_the_second, WINDOW), "should not be restored off-screen");
    }

    /// Hanging off an edge is only a problem once too little is left to grab.
    #[test]
    fn hanging_off_an_edge_is_judged_by_what_is_left() {
        let screens = [screen(0, 0, 1920, 1080)];
        // 180 of 220 pixels still showing: perfectly usable.
        assert!(visible_on(&screens, Placement { x: -40, y: 500 }, WINDOW));
        // 20 pixels showing, at either edge: gone for practical purposes.
        assert!(!visible_on(&screens, Placement { x: -200, y: 500 }, WINDOW));
        assert!(!visible_on(&screens, Placement { x: 1900, y: 500 }, WINDOW));
        assert!(!visible_on(&screens, Placement { x: 500, y: 1060 }, WINDOW));
    }

    #[test]
    fn with_no_monitors_at_all_nothing_is_visible() {
        assert!(!visible_on(&[], Placement { x: 0, y: 0 }, WINDOW));
    }
}

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
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Placement {
    pub x: i32,
    pub y: i32,
}

/// What the window is configured to be, for when it cannot yet say.
const FALLBACK_SIZE: (u32, u32) = (220, 220);

pub const SETTINGS_SIZE: (f64, f64) = (1300.0, 1118.0);
const SETTINGS_MINIMUM: (f64, f64) = (420.0, 480.0);
const SCREEN_MARGIN: f64 = 24.0;

#[derive(Debug)]
pub struct SettingsBounds {
    pub position: PhysicalPosition<i32>,
    pub size: PhysicalSize<u32>,
    pub minimum: PhysicalSize<u32>,
}

pub fn settings_bounds(
    origin: PhysicalPosition<i32>,
    work_area: PhysicalSize<u32>,
    scale: f64,
    frame: PhysicalSize<u32>,
) -> Result<SettingsBounds, &'static str> {
    if !scale.is_finite() || scale <= 0.0 || work_area.width <= frame.width || work_area.height <= frame.height {
        return Err("the monitor has no usable window area");
    }
    let margin = (SCREEN_MARGIN * scale).round() as u32;
    let horizontal = margin.min((work_area.width - frame.width - 1) / 2);
    let vertical = margin.min((work_area.height - frame.height - 1) / 2);
    let width = ((SETTINGS_SIZE.0 * scale).round() as u32).max(1)
        .min(work_area.width - frame.width - 2 * horizontal);
    let height = ((SETTINGS_SIZE.1 * scale).round() as u32).max(1)
        .min(work_area.height - frame.height - 2 * vertical);
    Ok(SettingsBounds {
        position: PhysicalPosition::new(
            origin.x + ((work_area.width - width - frame.width) / 2) as i32,
            origin.y + ((work_area.height - height - frame.height) / 2) as i32,
        ),
        size: PhysicalSize::new(width, height),
        minimum: PhysicalSize::new(
            ((SETTINGS_MINIMUM.0 * scale).round() as u32).min(width),
            ((SETTINGS_MINIMUM.1 * scale).round() as u32).min(height),
        ),
    })
}

pub fn fit_settings(window: &WebviewWindow, monitor: &tauri::Monitor) -> Result<(), String> {
    let work = monitor.work_area();
    window.set_position(work.position).map_err(|error| error.to_string())?;
    let outer = window.outer_size().map_err(|error| error.to_string())?;
    let inner = window.inner_size().map_err(|error| error.to_string())?;
    let frame = PhysicalSize::new(outer.width.saturating_sub(inner.width), outer.height.saturating_sub(inner.height));
    let bounds = settings_bounds(work.position, work.size, monitor.scale_factor(), frame)?;
    window.set_min_size(Some(bounds.minimum)).map_err(|error| error.to_string())?;
    window.set_size(bounds.size).map_err(|error| error.to_string())?;
    window.set_position(bounds.position).map_err(|error| error.to_string())?;
    println!("[settings] launch size {:.0}x{:.0}, fitted to the monitor work area",
        bounds.size.width as f64 / monitor.scale_factor(), bounds.size.height as f64 / monitor.scale_factor());
    Ok(())
}

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
/// Where the window was last put, if anywhere.
pub fn saved(window: &WebviewWindow) -> Option<Placement> {
    let text = std::fs::read_to_string(file(window)?).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn restore(window: &WebviewWindow) {
    let Some(saved) = saved(window) else { return };

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

    #[test]
    fn settings_launch_thirty_percent_larger_when_the_screen_has_room() {
        let bounds = settings_bounds(PhysicalPosition::new(0, 0), PhysicalSize::new(2560, 1440),
            1.0, PhysicalSize::new(0, 28)).unwrap();
        assert_eq!(bounds.size, PhysicalSize::new(1300, 1118));
        assert_eq!(bounds.minimum, PhysicalSize::new(420, 480));
        assert_eq!(bounds.position, PhysicalPosition::new(630, 147));
    }

    #[test]
    fn settings_fit_a_retina_laptop_work_area_including_the_title_bar() {
        let origin = PhysicalPosition::new(0, 48);
        let area = PhysicalSize::new(3024, 1840);
        let frame = PhysicalSize::new(0, 56);
        let bounds = settings_bounds(origin, area, 2.0, frame).unwrap();
        assert_eq!(bounds.size.width, 2600);
        assert_eq!(bounds.size.height, 1688);
        assert!(bounds.position.y >= origin.y + 48);
        assert!(bounds.position.y + (bounds.size.height + frame.height) as i32 <= origin.y + area.height as i32 - 48);
    }

    #[test]
    fn settings_fit_small_and_negative_origin_screens_without_an_oversized_minimum() {
        let origin = PhysicalPosition::new(-800, -600);
        let area = PhysicalSize::new(640, 400);
        let frame = PhysicalSize::new(12, 36);
        let bounds = settings_bounds(origin, area, 1.0, frame).unwrap();
        assert_eq!(bounds.size, PhysicalSize::new(580, 316));
        assert_eq!(bounds.minimum, PhysicalSize::new(420, 316));
        assert_eq!(bounds.position, PhysicalPosition::new(-776, -576));
        assert!(settings_bounds(origin, area, 0.0, frame).is_err());
        assert!(settings_bounds(origin, area, f64::NAN, frame).is_err());
    }
}

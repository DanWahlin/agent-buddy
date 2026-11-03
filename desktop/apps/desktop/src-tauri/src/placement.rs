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
use tauri::{LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

/// Where the window's top-left corner was, in physical pixels, and the size it
/// had then, so the corner means the same place when the app starts again.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Placement {
    pub x: i32,
    pub y: i32,
    /// The character size from Settings, as a scale of the configured window.
    /// Files from before there were sizes have none: those were Medium.
    #[serde(default = "medium")]
    pub scale: f64,
}

fn medium() -> f64 {
    1.0
}

/// Settings' character sizes and how much each scales the whole window, so the
/// character, its effects and the device around it stay together. Medium is
/// the configured window.
pub const SIZES: [(&str, f64); 4] = [("small", 0.8), ("medium", 1.0), ("large", 1.25), ("extra-large", 1.5)];

/// The scale of a size Settings names; Medium for anything else.
pub fn scale_of(size: &str) -> f64 {
    SIZES.iter().find(|(name, _)| *name == size).map_or(1.0, |(_, scale)| *scale)
}

/// A scale read back from a file: one of the sizes, or Medium.
fn known_scale(scale: f64) -> f64 {
    if SIZES.iter().any(|(_, known)| (known - scale).abs() < 1e-6) { scale } else { 1.0 }
}

/// What the window is configured to be, in logical pixels, for when the
/// configuration cannot say.
const FALLBACK_SIZE: (f64, f64) = (280.0, 280.0);

/// The character window's configured size, in logical pixels: Medium.
pub fn base_size(window: &WebviewWindow) -> (f64, f64) {
    window
        .app_handle()
        .config()
        .app
        .windows
        .iter()
        .find(|it| it.label == window.label())
        .map_or(FALLBACK_SIZE, |it| (it.width, it.height))
}

/// The window's logical size at `scale`, made smaller if it would not fit in
/// `room` (the work area, in logical pixels), keeping it square.
pub fn scaled_size(base: (f64, f64), scale: f64, room: Option<(f64, f64)>) -> (f64, f64) {
    let mut scale = scale;
    if let Some((width, height)) = room.filter(|(width, height)| *width > 0.0 && *height > 0.0) {
        scale = scale.min(width / base.0).min(height / base.1);
    }
    ((base.0 * scale).round().max(1.0), (base.1 * scale).round().max(1.0))
}

/// Where the window goes when its size changes from `old` to `new`, all in
/// physical pixels: the middle of its bottom edge, where the character stands,
/// stays put. Within `area` (the work area: x, y, width, height) it may not
/// stick out further than it already did, so growing never pushes it off the
/// screen, and a window the user left hanging over an edge keeps hanging.
pub fn anchored(
    at: (i32, i32),
    old: (u32, u32),
    new: (u32, u32),
    area: Option<(i32, i32, u32, u32)>,
) -> (i32, i32) {
    let (old_width, old_height) = (old.0 as i64, old.1 as i64);
    let (new_width, new_height) = (new.0 as i64, new.1 as i64);
    let mut x = at.0 as i64 + (old_width - new_width) / 2;
    let mut y = at.1 as i64 + old_height - new_height;
    if let Some((left, top, width, height)) = area {
        let fit = |value: i64, start: i64, length: i64, was: i64, old_length: i64, new_length: i64| {
            let low = start.min(was);
            let high = (start + length).max(was + old_length) - new_length;
            if high < low { low } else { value.clamp(low, high) }
        };
        x = fit(x, left as i64, width as i64, at.0 as i64, old_width, new_width);
        y = fit(y, top as i64, height as i64, at.1 as i64, old_height, new_height);
    }
    (x as i32, y as i32)
}

/// Give the window a logical size, with its minimum and maximum the same, so
/// it cannot be resized by hand. The bounds come off first: the new size may
/// be outside the old ones.
fn set_logical_size(window: &WebviewWindow, (width, height): (f64, f64)) {
    let size = LogicalSize::new(width, height);
    let _ = window.set_min_size(None::<tauri::Size>);
    let _ = window.set_max_size(None::<tauri::Size>);
    if let Err(error) = window.set_size(size) {
        eprintln!("[placement] could not resize the character window: {error}");
    }
    let _ = window.set_min_size(Some(size));
    let _ = window.set_max_size(Some(size));
}

/// The work area of the monitor the window is on, in physical pixels.
fn work_area(window: &WebviewWindow) -> Option<(i32, i32, u32, u32)> {
    let monitor = window.current_monitor().ok().flatten()?;
    let work = monitor.work_area();
    Some((work.position.x, work.position.y, work.size.width, work.size.height))
}

/// Change the character size: the window scales, and the character keeps
/// standing where it stood.
pub fn rescale(window: &WebviewWindow, scale: f64) {
    let base = base_size(window);
    if crate::hyprland::available() {
        rescale_on_hyprland(window, base, scale);
        return;
    }
    let factor = window.scale_factor().ok().filter(|it| it.is_finite() && *it > 0.0).unwrap_or(1.0);
    let area = work_area(window);
    let room = area.map(|(_, _, width, height)| (width as f64 / factor, height as f64 / factor));
    let logical = scaled_size(base, scale, room);
    let (Ok(at), Ok(old), Ok(inner)) = (window.outer_position(), window.outer_size(), window.inner_size()) else {
        set_logical_size(window, logical);
        return;
    };
    // The window has no frame, but a system that adds one adds it to both sizes.
    let new = (
        (logical.0 * factor).round() as u32 + old.width.saturating_sub(inner.width),
        (logical.1 * factor).round() as u32 + old.height.saturating_sub(inner.height),
    );
    let (x, y) = anchored((at.x, at.y), (old.width, old.height), new, area);
    set_logical_size(window, logical);
    let _ = window.set_position(PhysicalPosition::new(x, y));
    println!("[placement] character size {:.0}x{:.0} at {x},{y}", logical.0, logical.1);
    remember(window, Placement { x, y, scale });
}

/// On Hyprland a window cannot place itself, and only Hyprland knows where it
/// is, in its own layout coordinates (logical pixels), so it is asked, in the
/// background: its requests wait for an answer.
fn rescale_on_hyprland(window: &WebviewWindow, base: (f64, f64), scale: f64) {
    let logical = scaled_size(base, scale, None);
    let window = window.clone();
    std::thread::spawn(move || {
        let before = crate::hyprland::own_window();
        set_logical_size(&window, logical);
        let Some(client) = before else { return };
        let (x, y) = anchored(
            (client.x.round() as i32, client.y.round() as i32),
            (client.width.round() as u32, client.height.round() as u32),
            (logical.0 as u32, logical.1 as u32),
            None,
        );
        if crate::hyprland::move_to(&client, x, y) {
            remember(&window, Placement { x, y, scale });
        }
    });
}

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

/// Where the window was last put, if anywhere.
pub fn saved(window: &WebviewWindow) -> Option<Placement> {
    let text = std::fs::read_to_string(file(window)?).ok()?;
    serde_json::from_str(&text).ok()
}

/// Put the window back at the size and place it had, and say which size that
/// is, as a scale. The position only counts while it is still on a screen.
pub fn restore(window: &WebviewWindow) -> f64 {
    let Some(saved) = saved(window) else { return 1.0 };
    let scale = known_scale(saved.scale);
    let factor = window.scale_factor().ok().filter(|it| it.is_finite() && *it > 0.0).unwrap_or(1.0);
    let room = work_area(window).map(|(_, _, width, height)| (width as f64 / factor, height as f64 / factor));
    let logical = scaled_size(base_size(window), scale, room);
    if scale != 1.0 {
        set_logical_size(window, logical);
    }

    // Worked out rather than measured: the window has not been laid out yet,
    // and a zero size would make every saved position look off-screen.
    let size = ((logical.0 * factor).round() as u32, (logical.1 * factor).round() as u32);
    if !visible_on(&monitors_of(window), saved, size) {
        // Not an error worth showing anyone: the screen it lived on is simply
        // not here today. Where it opened is where it would have gone anyway.
        println!("[placement] {},{} is off-screen now; leaving it where it opened", saved.x, saved.y);
        return scale;
    }
    println!("[placement] back to {},{}", saved.x, saved.y);
    let _ = window.set_position(PhysicalPosition::new(saved.x, saved.y));
    scale
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
        assert!(visible_on(&screens, Placement { x: 100, y: 100, scale: 1.0 }, WINDOW));
    }

    #[test]
    fn a_point_on_a_second_screen_is_fine_too() {
        // A monitor to the left has negative coordinates, which is the case
        // that catches a naive "is it positive" check.
        let screens = [screen(0, 0, 1920, 1080), screen(-1920, 0, 1920, 1080)];
        assert!(visible_on(&screens, Placement { x: -1800, y: 200, scale: 1.0 }, WINDOW));
    }

    #[test]
    fn the_screen_it_lived_on_going_away_is_noticed() {
        let docked = [screen(0, 0, 1920, 1080), screen(1920, 0, 2560, 1440)];
        let laptop = [screen(0, 0, 1920, 1080)];
        let on_the_second = Placement { x: 2400, y: 300, scale: 1.0 };

        assert!(visible_on(&docked, on_the_second, WINDOW));
        assert!(!visible_on(&laptop, on_the_second, WINDOW), "should not be restored off-screen");
    }

    /// Hanging off an edge is only a problem once too little is left to grab.
    #[test]
    fn hanging_off_an_edge_is_judged_by_what_is_left() {
        let screens = [screen(0, 0, 1920, 1080)];
        // 180 of 220 pixels still showing: perfectly usable.
        assert!(visible_on(&screens, Placement { x: -40, y: 500, scale: 1.0 }, WINDOW));
        // 20 pixels showing, at either edge: gone for practical purposes.
        assert!(!visible_on(&screens, Placement { x: -200, y: 500, scale: 1.0 }, WINDOW));
        assert!(!visible_on(&screens, Placement { x: 1900, y: 500, scale: 1.0 }, WINDOW));
        assert!(!visible_on(&screens, Placement { x: 500, y: 1060, scale: 1.0 }, WINDOW));
    }

    #[test]
    fn with_no_monitors_at_all_nothing_is_visible() {
        assert!(!visible_on(&[], Placement { x: 0, y: 0, scale: 1.0 }, WINDOW));
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

    #[test]
    fn sizes_scale_the_configured_window_and_anything_else_is_medium() {
        assert_eq!(scale_of("small"), 0.8);
        assert_eq!(scale_of("medium"), 1.0);
        assert_eq!(scale_of("large"), 1.25);
        assert_eq!(scale_of("extra-large"), 1.5);
        assert_eq!(scale_of("huge"), 1.0);
        assert_eq!(known_scale(1.25), 1.25);
        assert_eq!(known_scale(7.0), 1.0);
        assert_eq!(known_scale(f64::NAN), 1.0);
        assert_eq!(scaled_size((280.0, 280.0), 0.8, None), (224.0, 224.0));
        assert_eq!(scaled_size((280.0, 280.0), 1.5, None), (420.0, 420.0));
    }

    #[test]
    fn a_size_never_outgrows_the_screen() {
        assert_eq!(scaled_size((280.0, 280.0), 1.5, Some((1440.0, 875.0))), (420.0, 420.0));
        assert_eq!(scaled_size((280.0, 280.0), 1.5, Some((800.0, 350.0))), (350.0, 350.0));
        assert_eq!(scaled_size((280.0, 280.0), 1.25, Some((0.0, 0.0))), (350.0, 350.0));
    }

    #[test]
    fn a_placement_from_before_sizes_is_medium() {
        let old: Placement = serde_json::from_str(r#"{"x":10,"y":-20}"#).unwrap();
        assert_eq!((old.x, old.y, old.scale), (10, -20, 1.0));
        let saved = serde_json::to_string(&Placement { x: 1, y: 2, scale: 1.25 }).unwrap();
        let back: Placement = serde_json::from_str(&saved).unwrap();
        assert_eq!((back.x, back.y, back.scale), (1, 2, 1.25));
    }

    /// The character stands at the middle of the window's bottom edge, so that
    /// point stays where it is when the window grows or shrinks.
    #[test]
    fn a_new_size_keeps_the_bottom_centre_in_place() {
        let area = Some((0, 0, 1920, 1080));
        assert_eq!(anchored((800, 500), (280, 280), (420, 420), area), (730, 360));
        assert_eq!(anchored((730, 360), (420, 420), (280, 280), area), (800, 500));
        // Retina: physical pixels.
        assert_eq!(anchored((1600, 1000), (560, 560), (700, 700), Some((0, 0, 3024, 1890))), (1530, 860));
        assert_eq!(anchored((800, 500), (280, 280), (280, 280), area), (800, 500));
    }

    #[test]
    fn growing_stays_on_the_screen() {
        let area = Some((0, 25, 1440, 875));
        // In a corner: it grows up and in, not off the right or the bottom.
        assert_eq!(anchored((1160, 620), (280, 280), (420, 420), area), (1020, 480));
        // At the top left, below the menu bar.
        assert_eq!(anchored((0, 25), (280, 280), (420, 420), area), (0, 25));
        // On a second monitor to the left, with negative coordinates.
        assert_eq!(anchored((-300, 700), (280, 280), (420, 420), Some((-1920, 0, 1920, 1080))), (-420, 560));
        // Without a work area the anchor alone decides.
        assert_eq!(anchored((1160, 620), (280, 280), (420, 420), None), (1090, 480));
    }

    #[test]
    fn a_window_left_hanging_over_an_edge_keeps_hanging_but_no_further() {
        let area = Some((0, 0, 1920, 1080));
        // 100 pixels over the left edge: growing keeps that much over, not more.
        assert_eq!(anchored((-100, 400), (280, 280), (420, 420), area), (-100, 260));
        // Shrinking needs no room, so it just keeps its anchor.
        assert_eq!(anchored((-100, 400), (280, 280), (224, 224), area), (-72, 456));
        // Over the bottom edge: it grows upwards from where it was.
        assert_eq!(anchored((500, 900), (280, 280), (420, 420), area), (430, 760));
    }

    #[test]
    fn a_window_bigger_than_the_screen_keeps_its_top_left_on_it() {
        assert_eq!(anchored((100, 100), (280, 280), (420, 420), Some((0, 0, 400, 300))), (0, 0));
    }
}

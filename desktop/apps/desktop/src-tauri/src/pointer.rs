//! Taking the mouse only when the pointer is actually on the character.
//!
//! Tauri's `set_ignore_cursor_events` is all or nothing: there is no way to
//! pass clicks through while still seeing the pointer, the way Electron's
//! `forward` option does (tauri-apps/tauri#6164). So while click-through is on
//! the page receives nothing and cannot tell the cursor has arrived, and the
//! decision has to be made out here from the cursor's own position.
//!
//! That is not really a workaround. A companion on the desktop has to follow
//! the pointer across the whole screen, which a webview cannot see either, so
//! this same reading does both jobs.
//!

use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow};

/// The character's opaque area, in CSS pixels within the window.
///
/// An ellipse rather than the real alpha mask: the art is a head, the firmware
/// already clips its effects to an ellipse around one, and reading pixels back
/// every poll to test a cursor would cost far more than it is worth.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct Region {
    pub cx: f64,
    pub cy: f64,
    pub rx: f64,
    pub ry: f64,
}

/// Leaving is stickier than arriving, so a cursor resting on the boundary does
/// not flip the window style back and forth every poll.
const STICKY_MARGIN: f64 = 6.0;
/// How often to look while the cursor is near the window: quick enough that
/// hovering onto the character feels immediate.
const POLL_NEAR: Duration = Duration::from_millis(50);
/// How often to look while it is far away: there is nothing to decide until it comes back.
const POLL_FAR: Duration = Duration::from_millis(150);
/// While the window is hidden there is nothing to decide at all; this is only
/// how quickly a show is noticed.
const POLL_HIDDEN: Duration = Duration::from_millis(1000);
/// "Near" is within this many CSS pixels of the window's edge.
const NEAR: f64 = 120.0;

pub fn inside(region: &Region, x: f64, y: f64, margin: f64) -> bool {
    let rx = region.rx + margin;
    let ry = region.ry + margin;
    if rx <= 0.0 || ry <= 0.0 {
        return false;
    }
    let dx = (x - region.cx) / rx;
    let dy = (y - region.cy) / ry;
    dx * dx + dy * dy <= 1.0
}

/// Where the window is, in physical pixels, and its scale. Kept up to date from
/// window events, so each poll asks the system for the cursor alone: every
/// window query is a round trip to the main thread.
#[derive(Clone, Copy, Debug, Default)]
pub struct Geometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale: f64,
    pub visible: bool,
}

impl Geometry {
    pub fn of(window: &WebviewWindow) -> Option<Self> {
        let origin = window.inner_position().ok()?;
        let size = window.inner_size().ok()?;
        Some(Self {
            x: origin.x as f64,
            y: origin.y as f64,
            width: size.width as f64,
            height: size.height as f64,
            scale: window.scale_factor().ok()?,
            visible: window.is_visible().unwrap_or(true),
        })
    }
}

/// The cursor in the same physical pixels as the window's position. On macOS
/// it is read straight from Core Graphics, which any thread may do: Tauri's
/// own call waits for the main thread every time, and this runs 20 times a
/// second.
fn cursor_position(window: &WebviewWindow, geometry: &Geometry) -> Option<tauri::PhysicalPosition<f64>> {
    #[cfg(target_os = "macos")]
    {
        use core_graphics::event::CGEvent;
        use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
        let _ = window;
        let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
        let point = CGEvent::new(source).ok()?.location();
        // Core Graphics answers in points from the top left of the main
        // display. Tauri gives the window's position as those points times
        // the window's own scale, so the cursor takes the same scale: with
        // displays of mixed scale, the main display's would miss.
        return Some(tauri::PhysicalPosition::new(point.x * geometry.scale, point.y * geometry.scale));
    }
    #[allow(unreachable_code)]
    {
        let _ = geometry;
        window.app_handle().cursor_position().ok()
    }
}

pub struct Pointer {
    region: Mutex<Region>,
    geometry: Mutex<Option<Geometry>>,
}

impl Pointer {
    pub fn new() -> Self {
        Self { region: Mutex::new(Region::default()), geometry: Mutex::new(None) }
    }

    pub fn set_region(&self, region: Region) {
        *self.region.lock().unwrap() = region;
    }

    /// Called when the window moves, resizes, rescales, shows or hides.
    pub fn refresh(&self, window: &WebviewWindow) {
        if let Some(geometry) = Geometry::of(window) {
            *self.geometry.lock().unwrap() = Some(geometry);
        }
    }

    /// Follow the cursor, handing the window the mouse only over the character.
    pub fn watch(self: Arc<Self>, window: WebviewWindow) {
        if self.geometry.lock().unwrap().is_none() {
            self.refresh(&window);
        }
        if crate::hyprland::available() {
            self.watch_hyprland(window);
            return;
        }
        std::thread::spawn(move || {
            let mut over = false;
            let mut wait = POLL_NEAR;
            loop {
                std::thread::sleep(wait);
                let Some(geometry) = *self.geometry.lock().unwrap() else { continue };
                if !geometry.visible {
                    wait = POLL_HIDDEN;
                    continue;
                }

                let Some(cursor) = cursor_position(&window, &geometry) else { continue };

                // Cursor and window are both physical; the region the page
                // reported is in CSS pixels, so the difference is scaled once.
                let x = (cursor.x - geometry.x) / geometry.scale;
                let y = (cursor.y - geometry.y) / geometry.scale;
                let width = geometry.width / geometry.scale;
                let height = geometry.height / geometry.scale;
                wait = if x < -NEAR || y < -NEAR || x > width + NEAR || y > height + NEAR {
                    POLL_FAR
                } else {
                    POLL_NEAR
                };

                let region = *self.region.lock().unwrap();
                let margin = if over { STICKY_MARGIN } else { 0.0 };
                let now = inside(&region, x, y, margin);

                if now != over {
                    over = now;
                    let _ = window.set_ignore_cursor_events(!now);
                }
            }
        });
    }

    /// The same, on Hyprland, where a Wayland window can learn neither the
    /// cursor nor its own place: Hyprland's IPC answers both, in the same
    /// layout coordinates. Its requests are handled synchronously, so it is
    /// asked for the cursor at 10 Hz near the window, and for the window's
    /// place once a second, which is also when a move is noticed and saved.
    fn watch_hyprland(self: Arc<Self>, window: WebviewWindow) {
        const NEAR_WAIT: Duration = Duration::from_millis(100);
        const FAR_WAIT: Duration = Duration::from_millis(300);
        const REFRESH_EVERY: u32 = 10;
        std::thread::spawn(move || {
            let mut over = false;
            let mut wait = NEAR_WAIT;
            let mut client: Option<crate::hyprland::Client> = None;
            let mut ticks = REFRESH_EVERY;
            loop {
                std::thread::sleep(wait);
                let Some(geometry) = *self.geometry.lock().unwrap() else { continue };
                if !geometry.visible {
                    wait = POLL_HIDDEN;
                    ticks = REFRESH_EVERY;
                    continue;
                }
                if ticks >= REFRESH_EVERY || client.is_none() {
                    ticks = 0;
                    let found = crate::hyprland::own_window();
                    if let (Some(now), Some(before)) = (&found, &client) {
                        if (now.x, now.y) != (before.x, before.y) {
                            crate::placement::remember(
                                &window,
                                crate::placement::Placement { x: now.x as i32, y: now.y as i32 },
                            );
                        }
                    }
                    client = found;
                }
                ticks += 1;
                let (Some(placed), Some((cursor_x, cursor_y))) = (&client, crate::hyprland::cursor()) else {
                    wait = FAR_WAIT;
                    continue;
                };

                // Layout units to the page's CSS pixels: the window's CSS
                // width over its width on the layout.
                let css = (geometry.width / geometry.scale) / placed.width.max(1.0);
                let x = (cursor_x - placed.x) * css;
                let y = (cursor_y - placed.y) * css;
                let (width, height) = (placed.width * css, placed.height * css);
                wait = if x < -NEAR || y < -NEAR || x > width + NEAR || y > height + NEAR {
                    FAR_WAIT
                } else {
                    NEAR_WAIT
                };

                let region = *self.region.lock().unwrap();
                let now = inside(&region, x, y, if over { STICKY_MARGIN } else { 0.0 });
                if now != over {
                    over = now;
                    let _ = window.set_ignore_cursor_events(!now);
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEAD: Region = Region { cx: 100.0, cy: 100.0, rx: 60.0, ry: 50.0 };

    #[test]
    fn the_centre_is_on_the_character() {
        assert!(inside(&HEAD, 100.0, 100.0, 0.0));
    }

    /// The case the whole mechanism exists for: a square window, a round
    /// character, and a click in the empty corner that has to reach behind.
    #[test]
    fn a_corner_of_the_window_is_not() {
        assert!(!inside(&HEAD, 0.0, 0.0, 0.0));
        assert!(!inside(&HEAD, 200.0, 200.0, 0.0));
    }

    #[test]
    fn the_margin_holds_on_just_past_the_edge() {
        assert!(!inside(&HEAD, 164.0, 100.0, 0.0));
        assert!(inside(&HEAD, 164.0, 100.0, STICKY_MARGIN));
    }

    /// Before the page has reported, every click must pass through - not none.
    #[test]
    fn a_region_nobody_has_reported_yet_claims_nothing() {
        let empty = Region::default();
        assert!(!inside(&empty, 0.0, 0.0, 0.0));
        assert!(!inside(&empty, 100.0, 100.0, 0.0));
    }

    /// Replayed from the prototype session, with the region the page reported.
    /// Four of these land within a few percent of the boundary, which is the
    /// only place the sticky edge does any work.
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
            let margin = if over { STICKY_MARGIN } else { 0.0 };
            let computed = inside(&region, x, y, margin);
            assert_eq!(computed, logged, "at {x},{y}");
            over = computed;
        }
    }
}

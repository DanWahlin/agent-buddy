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
//! Proven in `apps/click-through-prototype` before any of this was built on it.

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
const POLL: Duration = Duration::from_millis(16);

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

pub struct Pointer {
    region: Mutex<Region>,
}

impl Pointer {
    pub fn new() -> Self {
        Self { region: Mutex::new(Region::default()) }
    }

    pub fn set_region(&self, region: Region) {
        *self.region.lock().unwrap() = region;
    }

    /// Follow the cursor, handing the window the mouse only over the character.
    pub fn watch(self: Arc<Self>, window: WebviewWindow) {
        std::thread::spawn(move || {
            let mut over = false;
            loop {
                std::thread::sleep(POLL);

                let Ok(cursor) = window.app_handle().cursor_position() else { continue };
                let (Ok(origin), Ok(scale)) = (window.inner_position(), window.scale_factor())
                else {
                    continue;
                };

                // Cursor and window are both physical; the region the page
                // reported is in CSS pixels, so the difference is scaled once.
                let x = (cursor.x - origin.x as f64) / scale;
                let y = (cursor.y - origin.y as f64) / scale;

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

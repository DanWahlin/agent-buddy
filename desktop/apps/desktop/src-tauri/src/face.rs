//! Cutting a tray icon out of whichever character is showing.
//!
//! The icon was the one built into the binary, so it stayed the same character
//! whatever was on screen. A tray icon that does not match the character is worse than a
//! generic one: it says the wrong thing rather than nothing.
//!
//! Frame 0 of a gaze track is the centre pose every track returns to - the
//! character looking straight out, which is the picture wanted here. The margin
//! around it is room to move, not part of the character, so it is trimmed:
//! keeping it spends most of a 16-pixel icon on nothing.

use std::path::Path;

use image::{imageops::FilterType, GenericImageView, RgbaImage};
use serde::Deserialize;

#[derive(Deserialize)]
struct Manifest {
    frame: Frame,
    tracks: std::collections::HashMap<String, Track>,
}

#[derive(Deserialize)]
struct Frame {
    width: u32,
    height: u32,
}

#[derive(Deserialize)]
struct Track {
    base: String,
}

/// The gaze tracks, in the order worth trying. Any of them is the centre pose
/// at frame 0; an expression track would be a face pulling a face.
const GAZE: [&str; 4] = ["right", "left", "up", "down"];

/// A square RGBA icon of the character, ready for the tray.
pub fn cut(folder: &Path, size: u32) -> Option<(Vec<u8>, u32, u32)> {
    let manifest: Manifest =
        serde_json::from_slice(&std::fs::read(folder.join("pack.json")).ok()?).ok()?;

    let track = GAZE
        .iter()
        .find_map(|name| manifest.tracks.get(*name))
        .or_else(|| manifest.tracks.values().next())?;

    let strip = image::open(folder.join(&track.base)).ok()?;
    // A track is its frames laid out along the strip; the first is the centre.
    let frame = strip
        .view(0, 0, manifest.frame.width.min(strip.width()), manifest.frame.height.min(strip.height()))
        .to_image();

    let trimmed = trim(&frame);
    let fitted = image::imageops::resize(&trimmed, size, size, FilterType::Lanczos3);
    Some((fitted.into_raw(), size, size))
}

/// Drop the fully transparent border, so the character fills the icon.
fn trim(frame: &RgbaImage) -> RgbaImage {
    let (width, height) = frame.dimensions();
    let mut left = width;
    let mut top = height;
    let mut right = 0u32;
    let mut bottom = 0u32;

    for (x, y, pixel) in frame.enumerate_pixels() {
        if pixel.0[3] == 0 {
            continue;
        }
        left = left.min(x);
        top = top.min(y);
        right = right.max(x);
        bottom = bottom.max(y);
    }

    // Nothing visible at all: give back what came in rather than an empty image.
    if right < left || bottom < top {
        return frame.clone();
    }

    // Square it off around the middle, so resizing cannot squash the face.
    let box_width = right - left + 1;
    let box_height = bottom - top + 1;
    let side = box_width.max(box_height);
    let centre_x = left + box_width / 2;
    let centre_y = top + box_height / 2;
    let x = centre_x.saturating_sub(side / 2).min(width.saturating_sub(side).max(0));
    let y = centre_y.saturating_sub(side / 2).min(height.saturating_sub(side).max(0));

    image::imageops::crop_imm(frame, x, y, side.min(width), side.min(height)).to_image()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn blank(width: u32, height: u32) -> RgbaImage {
        RgbaImage::from_pixel(width, height, Rgba([0, 0, 0, 0]))
    }

    #[test]
    fn the_transparent_border_goes() {
        let mut frame = blank(100, 100);
        // A small opaque square in the middle, as a character in its margin.
        for x in 40..60 {
            for y in 40..60 {
                frame.put_pixel(x, y, Rgba([255, 0, 0, 255]));
            }
        }
        let trimmed = trim(&frame);
        assert_eq!(trimmed.dimensions(), (20, 20), "should be the character, not its room");
    }

    #[test]
    fn a_wide_character_still_comes_out_square() {
        let mut frame = blank(100, 100);
        for x in 10..90 {
            for y in 45..55 {
                frame.put_pixel(x, y, Rgba([0, 255, 0, 255]));
            }
        }
        let (width, height) = trim(&frame).dimensions();
        assert_eq!(width, height, "resizing a non-square crop would squash it");
    }

    /// A downward pose can hide the character entirely behind its own frame.
    #[test]
    fn a_frame_with_nothing_in_it_is_left_alone() {
        let frame = blank(40, 30);
        assert_eq!(trim(&frame).dimensions(), (40, 30));
    }

    /// Against the real art, since the decoding and the layout are the parts a
    /// synthetic image cannot check. Skips rather than fails where the packs
    /// are not to hand, as the packer's rig tests do.
    #[test]
    fn a_real_pack_yields_an_icon_with_something_in_it() {
        let shipped = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packs/copilot")
            .canonicalize();
        let Ok(folder) = shipped else { return };
        if !folder.join("pack.json").is_file() {
            return;
        }

        let (rgba, width, height) = cut(&folder, 32).expect("the shipped pack should yield an icon");
        assert_eq!((width, height), (32, 32));
        assert_eq!(rgba.len(), 32 * 32 * 4);

        // Trimmed properly, most of the icon is character rather than margin.
        let opaque = rgba.chunks_exact(4).filter(|pixel| pixel[3] > 32).count();
        assert!(opaque > 32 * 32 / 3,
            "only {opaque} of {} pixels are the character; the margin was not trimmed",
            32 * 32);
    }
}

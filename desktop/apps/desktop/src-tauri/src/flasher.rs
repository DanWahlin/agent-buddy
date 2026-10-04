//! Installs a release firmware bundle on the device over USB.
//!
//! The companion service runs `agent-companion-desktop --flash-firmware <dir>
//! --port <path>` after it downloads and checks a release, and reads the lines
//! this prints: `stage <name>`, `progress <percent>`, then `done` or `error
//! <message>`. It runs before Tauri starts, so it needs no window and works while
//! the pet is open.

use std::{borrow::Cow, fs, path::Path};

use espflash::{
    connection::{Connection, ResetAfterOperation, ResetBeforeOperation},
    flasher::Flasher,
    image_format::Segment,
    target::{Chip, ProgressCallbacks},
};
use serde::Deserialize;
use serialport::{FlowControl, UsbPortInfo};
use sha2::{Digest, Sha256};

const FLASH_BYTES: u64 = 16 * 1024 * 1024;
const ESPRESSIF_VID: u16 = 0x303a;
// The ESP32-S3's own USB port (USB-Serial-JTAG); espflash resets it differently from a UART bridge.
const USB_SERIAL_JTAG_PID: u16 = 0x1001;
const FLASH_BAUD: u32 = 460_800;

// The same files, order and budgets as tools/flash_release.py.
const IMAGES: [&str; 5] = [
    "bin/bootloader.bin",
    "bin/partitions.bin",
    "bin/boot_app0.bin",
    "bin/application.bin",
    "bin/character-copilot.acpk",
];
const FIXED: [(u64, u64); 4] = [(0, 0x8000), (0x8000, 0x1000), (0xe000, 0x2000), (0x10000, 0x200000)];

#[derive(Deserialize)]
struct Manifest {
    schema_version: u64,
    chip: String,
    flash_size: String,
    asset_sha256: String,
    images: Vec<Image>,
}

#[derive(Deserialize)]
struct Image {
    file: String,
    offset: u64,
    max_size: u64,
    size: u64,
    sha256: String,
}

pub struct Options {
    pub dir: String,
    pub port: String,
    pub pid: u16,
}

/// Reads `--flash-firmware <dir> --port <path> [--pid <hex>]`; None for a normal launch.
pub fn options(args: &[String]) -> Option<Result<Options, String>> {
    let dir = value(args, "--flash-firmware")?;
    Some((|| {
        let port = value(args, "--port").ok_or("--port is required")?;
        let pid = match value(args, "--pid") {
            Some(pid) => u16::from_str_radix(pid.trim_start_matches("0x"), 16).map_err(|_| "--pid must be hex")?,
            None => USB_SERIAL_JTAG_PID,
        };
        Ok(Options { dir: dir.to_string(), port: port.to_string(), pid })
    })())
}

fn value<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    args.iter().position(|arg| arg == name).and_then(|index| args.get(index + 1)).map(String::as_str)
}

/// Runs the install and returns the process exit code.
pub fn run(options: Result<Options, String>) -> i32 {
    match options.and_then(|options| flash(&options)) {
        Ok(()) => {
            println!("done");
            0
        }
        Err(error) => {
            println!("error {}", error.replace('\n', " "));
            1
        }
    }
}

fn flash(options: &Options) -> Result<(), String> {
    println!("stage checking");
    let segments = load(Path::new(&options.dir))?;

    println!("stage connecting");
    let serial = serialport::new(&options.port, 115_200)
        .flow_control(FlowControl::None)
        .open_native()
        .map_err(|error| format!("Couldn't open {}: {error}", options.port))?;
    let info = UsbPortInfo {
        vid: ESPRESSIF_VID,
        pid: options.pid,
        serial_number: None,
        manufacturer: None,
        product: None,
    };
    let connection = Connection::new(
        serial,
        info,
        ResetAfterOperation::HardReset,
        ResetBeforeOperation::DefaultReset,
        115_200,
    );
    let mut flasher = Flasher::connect(connection, true, true, false, Some(Chip::Esp32s3), Some(FLASH_BAUD))
        .map_err(|error| format!("Couldn't connect to the ESP32-S3: {error}"))?;

    println!("stage writing");
    let sizes = segments.iter().map(|segment| (segment.addr, segment.data.len() as u64)).collect();
    let mut progress = Progress::new(sizes);
    // Writes each image as it is, so the bootloader keeps its own flash settings, and resets after.
    flasher
        .write_bins_to_flash(&segments, &mut progress)
        .map_err(|error| format!("Couldn't write the firmware: {error}"))
}

/// Reads and checks a bundle the way tools/flash_release.py does, and returns what to write.
pub fn load(dir: &Path) -> Result<Vec<Segment<'static>>, String> {
    let text = fs::read(dir.join("manifest.json")).map_err(|error| format!("Couldn't read manifest.json: {error}"))?;
    let manifest: Manifest = serde_json::from_slice(&text).map_err(|error| format!("Invalid manifest.json: {error}"))?;
    validate(&manifest)?;
    let segments = manifest
        .images
        .iter()
        .map(|image| {
            let mut data = fs::read(dir.join(&image.file)).map_err(|error| format!("Couldn't read {}: {error}", image.file))?;
            if data.len() as u64 != image.size || hex_sha256(&data) != image.sha256 {
                return Err(format!("Image size or SHA256 mismatch: {}.", image.file));
            }
            // The stub writes whole 32-bit words, so the last bytes of an unaligned image are lost
            // unless we pad it like esptool does. 0xFF is the erased-flash value.
            data.resize(data.len().next_multiple_of(4), 0xff);
            Ok(Segment { addr: image.offset as u32, data: Cow::Owned(data) })
        })
        .collect::<Result<Vec<_>, String>>()?;
    // The assets image must go exactly where this bundle's own partition table puts it.
    let assets = &manifest.images[IMAGES.len() - 1];
    if assets_partition(&segments[1].data) != Some((assets.offset, assets.max_size)) {
        return Err("The assets offset does not match partitions.bin.".into());
    }
    Ok(segments)
}

/// Finds the character assets partition (data, subtype 0x40, "assets") in an ESP-IDF partition table.
fn assets_partition(table: &[u8]) -> Option<(u64, u64)> {
    table.chunks_exact(32).take_while(|entry| entry[..2] == [0xaa, 0x50]).find_map(|entry| {
        let label = entry[12..28].split(|&byte| byte == 0).next().unwrap_or_default();
        (entry[2] == 0x01 && entry[3] == 0x40 && label == b"assets").then(|| {
            let word = |at: usize| u64::from(u32::from_le_bytes(entry[at..at + 4].try_into().unwrap()));
            (word(4), word(8))
        })
    })
}

fn validate(manifest: &Manifest) -> Result<(), String> {
    if manifest.schema_version != 1 {
        return Err("Unsupported manifest schema.".into());
    }
    if manifest.chip != "esp32s3" || manifest.flash_size != "16MB" {
        return Err("Unsupported chip or flash size; expected ESP32-S3 with 16MB.".into());
    }
    if manifest.images.len() != IMAGES.len() {
        return Err("Manifest must contain exactly the five supported images.".into());
    }
    let mut end = 0;
    for (index, (image, file)) in manifest.images.iter().zip(IMAGES).enumerate() {
        if image.file != file {
            return Err("Invalid image filename or order.".into());
        }
        if let Some(&(offset, budget)) = FIXED.get(index) {
            if (image.offset, image.max_size) != (offset, budget) {
                return Err(format!("Unsafe offset or budget for {file}."));
            }
        } else if image.offset % 0x10000 != 0 {
            return Err("Unsafe assets offset.".into());
        }
        let fits = image.offset.checked_add(image.max_size).is_some_and(|end| end <= FLASH_BYTES);
        if image.max_size == 0 || image.size == 0 || image.size > image.max_size || !fits {
            return Err(format!("Image exceeds its flash budget: {file}."));
        }
        if image.offset < end {
            return Err("Image partitions overlap.".into());
        }
        end = image.offset + image.max_size;
    }
    if manifest.asset_sha256 != manifest.images[IMAGES.len() - 1].sha256 {
        return Err("Asset SHA256 mismatch.".into());
    }
    Ok(())
}

fn hex_sha256(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Turns espflash's per-image chunk counts into one percent for the whole install.
struct Progress {
    sizes: Vec<(u32, u64)>,
    done: u64,
    current: Option<(u64, usize)>,
    shown: Option<u64>,
}

impl Progress {
    fn new(sizes: Vec<(u32, u64)>) -> Self {
        Progress { sizes, done: 0, current: None, shown: None }
    }

    fn total(&self) -> u64 {
        self.sizes.iter().map(|(_, size)| size).sum::<u64>().max(1)
    }

    fn show(&mut self, bytes: u64) {
        let percent = (bytes * 100 / self.total()).min(100);
        if self.shown != Some(percent) {
            self.shown = Some(percent);
            println!("progress {percent}");
        }
    }
}

impl ProgressCallbacks for Progress {
    fn init(&mut self, addr: u32, total: usize) {
        let size = self.sizes.iter().find(|(start, _)| *start == addr).map_or(0, |(_, size)| *size);
        self.current = Some((size, total.max(1)));
    }

    fn update(&mut self, current: usize) {
        if let Some((size, chunks)) = self.current {
            self.show(self.done + size * current.min(chunks) as u64 / chunks as u64);
        }
    }

    fn verifying(&mut self) {}

    fn finish(&mut self, _skipped: bool) {
        if let Some((size, _)) = self.current.take() {
            self.done += size;
            self.show(self.done);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle(dir: &Path, change: impl FnOnce(&mut serde_json::Value)) {
        let offsets = [0u64, 0x8000, 0xe000, 0x10000, 0x410000];
        let budgets = [0x8000u64, 0x1000, 0x2000, 0x200000, 0xbe0000];
        fs::create_dir_all(dir.join("bin")).unwrap();
        let images: Vec<_> = IMAGES
            .iter()
            .enumerate()
            .map(|(index, file)| {
                let data = if index == 1 { partition_table(0x410000, 0xbe0000) } else { vec![index as u8; 16 + index] };
                fs::write(dir.join(file), &data).unwrap();
                serde_json::json!({
                    "file": file, "offset": offsets[index], "max_size": budgets[index],
                    "size": data.len(), "sha256": hex_sha256(&data),
                })
            })
            .collect();
        let mut manifest = serde_json::json!({
            "schema_version": 1, "name": "esp32-agent-companion", "version": "0.7.0",
            "chip": "esp32s3", "flash_size": "16MB",
            "asset_sha256": images[4]["sha256"], "images": images,
        });
        change(&mut manifest);
        fs::write(dir.join("manifest.json"), manifest.to_string()).unwrap();
    }

    fn partition_table(offset: u32, size: u32) -> Vec<u8> {
        let mut table = Vec::new();
        for (kind, subtype, at, length, label) in [(0u8, 0x10u8, 0x10000u32, 0x200000u32, "app0"), (1, 0x40, offset, size, "assets")] {
            let mut entry = vec![0xaa, 0x50, kind, subtype];
            entry.extend(at.to_le_bytes());
            entry.extend(length.to_le_bytes());
            let mut name = [0u8; 16];
            name[..label.len()].copy_from_slice(label.as_bytes());
            entry.extend(name);
            entry.extend([0u8; 4]);
            table.extend(entry);
        }
        table.resize(0xc00, 0xff);
        table
    }

    fn temp(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("companion-flasher-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn loads_a_valid_bundle_in_order() {
        let dir = temp("valid");
        bundle(&dir, |_| {});
        let segments = load(&dir).unwrap();
        assert_eq!(segments.iter().map(|s| s.addr).collect::<Vec<_>>(), [0, 0x8000, 0xe000, 0x10000, 0x410000]);
        assert_eq!(segments[3].data.len(), 20);
        assert_eq!(segments[3].data[19], 0xff);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn refuses_unsafe_or_damaged_bundles() {
        type Change = fn(&mut serde_json::Value);
        let cases: [(&str, Change); 8] = [
            ("chip", |m| m["chip"] = "esp32".into()),
            ("offset", |m| m["images"][3]["offset"] = 0x20000.into()),
            ("overlap", |m| m["images"][4]["offset"] = 0x200000.into()),
            ("order", |m| m["images"][0]["file"] = "bin/partitions.bin".into()),
            ("hash", |m| m["images"][2]["sha256"] = "0".repeat(64).into()),
            ("asset", |m| m["asset_sha256"] = "0".repeat(64).into()),
            ("table", |m| m["images"][4]["offset"] = 0x420000.into()),
            ("wrap", |m| m["images"][4]["offset"] = 0xffff_ffff_ffff_0000u64.into()),
        ];
        for (name, change) in cases {
            let dir = temp(name);
            bundle(&dir, change);
            assert!(load(&dir).is_err(), "{name} was accepted");
            fs::remove_dir_all(dir).unwrap();
        }
    }

    #[test]
    fn reads_the_command_line() {
        let args: Vec<String> = ["app", "--flash-firmware", "/tmp/fw", "--port", "/dev/cu.usbmodem1", "--pid", "0x1001"]
            .iter()
            .map(|arg| arg.to_string())
            .collect();
        let parsed = options(&args).unwrap().unwrap();
        assert_eq!((parsed.dir.as_str(), parsed.port.as_str(), parsed.pid), ("/tmp/fw", "/dev/cu.usbmodem1", 0x1001));
        assert!(options(&args[..1]).is_none());
        assert!(options(&args[..3]).unwrap().is_err());
    }

    #[test]
    fn reports_one_percent_for_all_images() {
        let mut progress = Progress::new(vec![(0, 100), (0x10000, 300)]);
        progress.init(0, 4);
        progress.update(4);
        progress.finish(false);
        assert_eq!(progress.shown, Some(25));
        progress.init(0x10000, 3);
        progress.update(1);
        assert_eq!(progress.shown, Some(50));
        progress.finish(false);
        assert_eq!(progress.shown, Some(100));
    }
}

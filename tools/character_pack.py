#!/usr/bin/env python3
"""Build and validate self-describing character packs for the firmware shell.

`build` discovers `characters/*/character.json` in sorted order. Each manifest
points to character-local frame data and metadata, plus an optional validator::

  {
    "id": "openclaw",
    "name": "OpenClaw",
    "layout": "full-frame",
    "frames": "frames.bin",
    "metadata": "frames.json",
    "motionSpeed": 1.3,
    "walk": {"track": 9, "first": 1, "frames": 23, "fps": 12.0},
    "validator": "tools/embed_openclaw_lab.py"
  }

Layouts: `base-patch` metadata contains `frames`, `baseBounds`,
`maxPatchPixels`, and `trackSteps`; `full-frame` metadata contains `blocks` as
`[offset, size]` pairs. A pack holds exactly one character: a 256-byte header,
a frame table, and compressed RGB565 frame blocks. The device keeps a single
pack in its flash assets partition; the daemon installs a different pack over
USB or Wi-Fi.

Format version 1 (little-endian):
  0   magic "ACPK"                 128 frame_count u32
  4   format_version u16 (1)       132 table_offset u32
  6   header_bytes u16 (256)       136 table_bytes u32
  8   total_bytes u32              140 data_offset u32
  12  layout u8 (1 base+patch,     144 data_bytes u32
      2 full frame)                160 sha256[32] of the whole pack with
  13  directions, steps,               this field zeroed
      blink_levels u8 x3
  16  id[16], display_name[24]
  56  width, height u16
  60  base x, y, width, height u16
  68  max_patch_pixels u32
  72  motion_speed_permille u16
  74  walk_direction u8 (255 none), walk_frames u8
  76  walk_fps_centi u16, walk_first u8
  80  track_steps[16] u8, track_offsets[16] u16
  148 thumbnail_offset u32, thumbnail_bytes u32 (optional PNG between the table
      and the data; zero when absent; the firmware ignores it)

Layout 1 tables hold 48-byte frames: base {offset,size}, patch x/y/w/h u16,
and four blink {offset,size} blocks. Layout 2 tables hold one {offset,size}
block per (direction, step, blink level). Offsets are relative to the data.
"""
import argparse
import csv
import hashlib
import importlib.util
import json
import platform
import re
import struct
import sys
import zlib
from pathlib import Path

if __package__:
    from . import sprite_codec
else:
    import sprite_codec

ROOT = Path(__file__).resolve().parents[1]
CHARACTERS = Path("characters")
OUTPUT = Path("build/characters")
HOST_ASSEMBLY = Path("build/character_packs_host.S")
PARTITIONS = Path("firmware/AgentCompanion/partitions.csv")
MAGIC = b"ACPK"
FORMAT_VERSION = 1
HEADER_BYTES = 256
SHA_OFFSET = 160
LAYOUT_BASE_PATCH = 1
LAYOUT_FULL_FRAME = 2
LAYOUTS = {"base-patch": LAYOUT_BASE_PATCH, "full-frame": LAYOUT_FULL_FRAME}
WIDTH, HEIGHT = 412, 352
DIRECTIONS, STEPS, BLINK_LEVELS = 13, 24, 5
MODEL_TRACK_STEPS = [24, 24, 12, 12] + [24] * 9
NO_WALK = 255
HEADER = struct.Struct("<4sHHIBBBB16s24sHHHHHHIHBBHBB16B16HIIIIIII")
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MAX_THUMBNAIL_BYTES = 256 * 1024
PATCH_FRAME = struct.Struct("<IIHHHHIIIIIIII")
BLOCK = struct.Struct("<II")
ID_PATTERN = re.compile(r"[a-z0-9][a-z0-9-]{0,15}")


class PackError(ValueError):
    pass


def track_offsets(steps):
    offsets, total = [], 0
    for count in steps:
        offsets.append(total)
        total += count
    return offsets


def encode(pack_id, display_name, layout, table, data, *, base=(0, 0, 0, 0),
           max_patch_pixels=0, motion_speed=1.0, walk=None, track_steps=None, thumbnail=b""):
    if not ID_PATTERN.fullmatch(pack_id):
        raise PackError("Pack id must be 1-16 lowercase letters, digits, or hyphens.")
    name = display_name.encode("ascii", "replace")
    if (not 0 < len(name) <= 24 or not display_name.isascii()
            or not all(32 <= byte < 127 for byte in name)):
        raise PackError("Display name must be 1-24 printable ASCII characters.")
    steps = list(track_steps or (MODEL_TRACK_STEPS if layout == LAYOUT_BASE_PATCH
                                 else [STEPS] * DIRECTIONS))
    walk_direction, walk_frames, walk_fps, walk_first = walk or (NO_WALK, 0, 0.0, 0)
    if thumbnail and (not thumbnail.startswith(PNG_SIGNATURE) or len(thumbnail) > MAX_THUMBNAIL_BYTES):
        raise PackError("Thumbnail must be a PNG of at most 256 KiB.")
    table_offset = HEADER_BYTES
    thumbnail_offset = table_offset + len(table) if thumbnail else 0
    data_offset = table_offset + len(table) + len(thumbnail)
    data_offset += -data_offset % 4
    total = data_offset + len(data)
    frame_count = len(table) // (PATCH_FRAME.size if layout == LAYOUT_BASE_PATCH else BLOCK.size)
    header = HEADER.pack(
        MAGIC, FORMAT_VERSION, HEADER_BYTES, total, layout, DIRECTIONS, STEPS, BLINK_LEVELS,
        pack_id.encode("ascii"), name, WIDTH, HEIGHT, *base, max_patch_pixels,
        round(motion_speed * 1000), walk_direction, walk_frames, round(walk_fps * 100),
        walk_first, 0, *(steps + [0] * (16 - len(steps))),
        *(track_offsets(steps) + [0] * (16 - len(steps))),
        frame_count, table_offset, len(table), data_offset, len(data),
        thumbnail_offset, len(thumbnail))
    pack = bytearray(header.ljust(HEADER_BYTES, b"\0"))
    pack += table
    pack += thumbnail
    pack += b"\0" * (data_offset - len(pack))
    pack += data
    pack[SHA_OFFSET:SHA_OFFSET + 32] = hashlib.sha256(pack).digest()
    return bytes(pack)


def digest(pack):
    hashed = bytearray(pack)
    hashed[SHA_OFFSET:SHA_OFFSET + 32] = b"\0" * 32
    return hashlib.sha256(hashed).digest()


def decode(pack, max_bytes=None):
    """Validate a pack exactly as the firmware does and return its header fields."""
    if len(pack) < HEADER_BYTES:
        raise PackError("Character pack is shorter than its header.")
    values = HEADER.unpack_from(pack)
    (magic, version, header_bytes, total, layout, directions, steps, blink_levels,
     raw_id, raw_name, width, height, base_x, base_y, base_width, base_height,
     max_patch, motion, walk_direction, walk_frames, walk_fps, walk_first, _reserved) = values[:23]
    track_steps = list(values[23:39])
    offsets = list(values[39:55])
    frame_count, table_offset, table_bytes, data_offset, data_bytes = values[55:60]
    thumbnail_offset, thumbnail_bytes = values[60:62]
    if magic != MAGIC or version != FORMAT_VERSION or header_bytes != HEADER_BYTES:
        raise PackError("Not a version 1 character pack.")
    if total != len(pack) or (max_bytes is not None and total > max_bytes):
        raise PackError("Character pack size is invalid or exceeds the device partition.")
    if (width, height, directions, steps, blink_levels) != (
            WIDTH, HEIGHT, DIRECTIONS, STEPS, BLINK_LEVELS):
        raise PackError("Character pack does not match the firmware animation model.")
    pack_id = raw_id.rstrip(b"\0").decode("ascii", "replace")
    name = raw_name.rstrip(b"\0").decode("ascii", "replace")
    if not ID_PATTERN.fullmatch(pack_id) or not name:
        raise PackError("Character pack id or display name is invalid.")
    used = track_steps[:DIRECTIONS]
    expected_steps = MODEL_TRACK_STEPS if layout == LAYOUT_BASE_PATCH else [STEPS] * DIRECTIONS
    if (used != expected_steps or offsets[:DIRECTIONS] != track_offsets(used)
            or any(track_steps[DIRECTIONS:]) or any(offsets[DIRECTIONS:])):
        raise PackError("Character pack track layout is unsupported.")
    if not 100 <= motion <= 4000:
        raise PackError("Character pack motion speed is out of range.")
    if walk_direction != NO_WALK and (
            walk_direction >= DIRECTIONS or not 1 <= walk_frames <= STEPS
            or walk_first + walk_frames > STEPS or not 1 <= walk_fps <= 6000):
        raise PackError("Character pack walk cycle is invalid.")
    if (table_offset != HEADER_BYTES or table_offset + table_bytes > data_offset
            or data_offset % 4 or data_offset + data_bytes != total or not data_bytes):
        raise PackError("Character pack sections are misaligned or overlap.")
    if thumbnail_bytes and (
            thumbnail_offset < table_offset + table_bytes
            or thumbnail_offset + thumbnail_bytes > data_offset
            or thumbnail_bytes > MAX_THUMBNAIL_BYTES
            or pack[thumbnail_offset:thumbnail_offset + len(PNG_SIGNATURE)] != PNG_SIGNATURE):
        raise PackError("Character pack thumbnail is invalid.")
    if not thumbnail_bytes and thumbnail_offset:
        raise PackError("Character pack thumbnail is invalid.")
    table = pack[table_offset:table_offset + table_bytes]
    if layout == LAYOUT_BASE_PATCH:
        if frame_count != sum(MODEL_TRACK_STEPS) or table_bytes != frame_count * PATCH_FRAME.size:
            raise PackError("Base/patch frame table has the wrong size.")
        if (not base_width or not base_height or base_x + base_width > WIDTH
                or base_y + base_height > HEIGHT or not max_patch):
            raise PackError("Base/patch frame bounds are invalid.")
        for index in range(frame_count):
            fields = PATCH_FRAME.unpack_from(table, index * PATCH_FRAME.size)
            px, py, pw, ph = fields[2:6]
            blocks = [fields[0:2]] + [fields[6 + i * 2:8 + i * 2] for i in range(4)]
            if ((pw == 0) != (ph == 0) or px + pw > WIDTH or py + ph > HEIGHT
                    or pw * ph > max_patch):
                raise PackError(f"Frame {index} blink patch is outside its bounds.")
            for number, (offset, size) in enumerate(blocks):
                required = number == 0 or pw > 0
                if (required and not size) or offset + size > data_bytes:
                    raise PackError(f"Frame {index} references data outside the pack.")
    elif layout == LAYOUT_FULL_FRAME:
        if (frame_count != DIRECTIONS * STEPS * BLINK_LEVELS
                or table_bytes != frame_count * BLOCK.size):
            raise PackError("Full-frame block table has the wrong size.")
        for index in range(frame_count):
            offset, size = BLOCK.unpack_from(table, index * BLOCK.size)
            if not size or offset + size > data_bytes:
                raise PackError(f"Block {index} references data outside the pack.")
    else:
        raise PackError("Character pack layout is unsupported by this firmware.")
    if digest(pack) != pack[SHA_OFFSET:SHA_OFFSET + 32]:
        raise PackError("Character pack SHA-256 does not match its contents.")
    return dict(id=pack_id, name=name, layout=layout, total_bytes=total,
                frame_count=frame_count, data_bytes=data_bytes, thumbnail_bytes=thumbnail_bytes,
                sha256=pack[SHA_OFFSET:SHA_OFFSET + 32].hex())


def read_assets_partition(root=ROOT):
    path = root / PARTITIONS
    raw = path.read_bytes()

    def number(value):
        value = value.strip()
        multiplier = 1
        if value[-1:].upper() in ("K", "M"):
            multiplier = 1024 if value[-1:].upper() == "K" else 1024 * 1024
            value = value[:-1]
        return int(value, 16 if value.lower().startswith("0x") else 10) * multiplier

    rows = [[cell.strip() for cell in row] for row in
            csv.reader(line for line in raw.decode("utf-8").splitlines()
                       if line.strip() and not line.lstrip().startswith("#"))]
    matches = [row for row in rows if row and row[0] == "assets"]
    if len(matches) != 1 or len(matches[0]) < 5:
        raise ValueError("partitions.csv must contain exactly one named assets partition.")
    return {"size": number(matches[0][4])}


def checked_relative(base, value, label):
    if not isinstance(value, str) or not value or Path(value).is_absolute():
        raise PackError(f"{label} must be a relative path.")
    path = (base / value).resolve()
    if not path.is_relative_to(base.resolve()):
        raise PackError(f"{label} escapes the character directory.")
    return path


def load_json(path):
    return json.loads(path.read_text())


def run_validator(root, character_dir, manifest):
    validator = manifest.get("validator")
    if validator is None:
        return
    path = checked_relative(character_dir, validator, "validator")
    if not path.is_file():
        raise PackError(f"Validator does not exist: {path.relative_to(root)}")
    module_name = f"character_validator_{manifest['id'].replace('-', '_')}"
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise PackError(f"Cannot load validator: {path.relative_to(root)}")
    module = importlib.util.module_from_spec(spec)
    added = [str(path.parent), str(root / "tools")]
    old_path = list(sys.path)
    sys.path[:0] = added
    try:
        spec.loader.exec_module(module)
        validate = getattr(module, "validate", None)
        if not callable(validate):
            raise PackError(f"Validator must expose validate(root): {path.relative_to(root)}")
        validate(root)
    finally:
        sys.path[:] = old_path


def pack_table(layout, metadata):
    if layout == LAYOUT_BASE_PATCH:
        table = bytearray()
        frames = metadata.get("frames")
        if not isinstance(frames, list):
            raise PackError("Base-patch metadata must include a frame list.")
        for frame in frames:
            blinks = [value for block in frame["blinks"] for value in (block["offset"], block["size"])]
            table += PATCH_FRAME.pack(frame["base"]["offset"], frame["base"]["size"],
                                      frame["patchX"], frame["patchY"],
                                      frame["patchWidth"], frame["patchHeight"], *blinks)
        return bytes(table)
    blocks = metadata.get("blocks")
    if not isinstance(blocks, list):
        raise PackError("Full-frame metadata must include blocks.")
    return b"".join(BLOCK.pack(int(offset), int(size)) for offset, size in blocks)


def idle_frame(layout, table, data, base):
    """Decode the shared idle center pose to a 412x352 RGB565 big-endian canvas."""
    if layout == LAYOUT_BASE_PATCH:
        offset, size = PATCH_FRAME.unpack_from(table, 0)[:2]
        return sprite_codec.decode_base(data[offset:offset + size], {
            "width": WIDTH, "height": HEIGHT, "baseBounds": list(base)})
    offset, size = BLOCK.unpack_from(table, 0)
    frame = sprite_codec.decode_pixels(data[offset:offset + size], WIDTH)
    if len(frame) != WIDTH * HEIGHT * 2:
        raise PackError("Idle frame does not match the animation model.")
    return frame


def png(width, height, rows):
    def chunk(kind, body):
        return (struct.pack(">I", len(body)) + kind + body
                + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF))
    return (PNG_SIGNATURE + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))


def thumbnail_png(frame, scale=2):
    """Box-downscale an RGB565 big-endian frame into an RGB PNG."""
    width, height = WIDTH // scale, HEIGHT // scale
    samples = scale * scale
    rows = bytearray()
    for y in range(height):
        rows.append(0)
        for x in range(width):
            red = green = blue = 0
            for dy in range(scale):
                start = ((y * scale + dy) * WIDTH + x * scale) * 2
                for dx in range(scale):
                    value = frame[start + dx * 2] << 8 | frame[start + dx * 2 + 1]
                    red += (value >> 11) * 255 // 31
                    green += ((value >> 5) & 63) * 255 // 63
                    blue += (value & 31) * 255 // 31
            rows += bytes((red // samples, green // samples, blue // samples))
    return png(width, height, rows)


def normalize_walk(walk):
    if walk is None:
        return None
    if not isinstance(walk, dict):
        raise PackError("walk must be null or an object.")
    return (int(walk["track"]), int(walk["frames"]), float(walk["fps"]), int(walk["first"]))


def build_character(root, character_dir):
    manifest_path = character_dir / "character.json"
    manifest = load_json(manifest_path)
    pack_id = manifest.get("id")
    if pack_id != character_dir.name:
        raise PackError(f"{manifest_path.relative_to(root)} id must match its folder name.")
    if not ID_PATTERN.fullmatch(pack_id):
        raise PackError(f"Invalid character id: {pack_id!r}")
    layout_name = manifest.get("layout")
    if layout_name not in LAYOUTS:
        raise PackError(f"Unsupported layout for {pack_id}: {layout_name!r}")
    layout = LAYOUTS[layout_name]
    run_validator(root, character_dir, manifest)
    metadata = load_json(checked_relative(character_dir, manifest.get("metadata"), "metadata"))
    data = checked_relative(character_dir, manifest.get("frames"), "frames").read_bytes()
    table = pack_table(layout, metadata)
    options = {"motion_speed": float(manifest.get("motionSpeed", 1.0)),
               "walk": normalize_walk(manifest.get("walk"))}
    if layout == LAYOUT_BASE_PATCH:
        options.update(base=tuple(metadata["baseBounds"]),
                       max_patch_pixels=int(metadata["maxPatchPixels"]),
                       track_steps=list(metadata["trackSteps"]))
    # An optional manifest "thumbnail" PNG overrides the one rendered from the idle pose.
    if manifest.get("thumbnail"):
        options["thumbnail"] = checked_relative(character_dir, manifest["thumbnail"], "thumbnail").read_bytes()
    else:
        options["thumbnail"] = thumbnail_png(idle_frame(layout, table, data, options.get("base")))
    return encode(pack_id, manifest.get("name"), layout, table, data, **options)


def discover_characters(root=ROOT):
    base = root / CHARACTERS
    if not base.is_dir():
        raise PackError("characters/ does not exist.")
    return [path for path in sorted(base.iterdir()) if (path / "character.json").is_file()]


def write_if_changed(path, data):
    if not path.exists() or path.read_bytes() != data:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def host_symbol(name):
    parts = re.findall(r"[A-Za-z0-9]+", name)
    if not parts:
        raise PackError(f"Cannot derive a host symbol from character name {name!r}.")
    return "".join(part[:1].upper() + part[1:] for part in parts)


def host_assembly(paths):
    darwin = platform.system() == "Darwin"
    lines = [".section __TEXT,__const" if darwin else ".section .rodata"]
    for name, path in paths.items():
        symbol = ("_" if darwin else "") + f"k{name}Pack"
        escaped = str(path).replace("\\", "\\\\").replace('"', '\\"')
        lines += [".balign 4", f".globl {symbol}", f"{symbol}:", f'.incbin "{escaped}"',
                  f".globl {symbol}End", f"{symbol}End:"]
    return "\n".join(lines) + "\n"


def build(root=ROOT):
    output = root / OUTPUT
    partition = read_assets_partition(root)["size"]
    paths = {}
    for character_dir in discover_characters(root):
        manifest = load_json(character_dir / "character.json")
        pack = build_character(root, character_dir)
        info = decode(pack, partition)
        pack_id = info["id"]
        path = output / f"{pack_id}.acpk"
        write_if_changed(path, pack)
        paths[host_symbol(info["name"])] = path
        print(f"Character pack {pack_id}: {info['total_bytes']:,} / {partition:,} bytes, "
              f"SHA256 {info['sha256']}")
    write_if_changed(root / HOST_ASSEMBLY, host_assembly(paths).encode())
    return paths


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("build", help="Build character packs into build/characters")
    check = commands.add_parser("validate", help="Validate a pack file")
    check.add_argument("pack", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "build":
            build()
        else:
            info = decode(args.pack.read_bytes(), read_assets_partition()["size"])
            print(json.dumps(info, indent=2))
        return 0
    except (OSError, ValueError, KeyError, TypeError, struct.error) as error:
        print(f"Character pack error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

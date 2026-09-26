import copy
import hashlib
import io
import json
import math
from pathlib import Path
import shutil
import sys
import struct
import unittest
from unittest.mock import Mock, patch
import uuid
import zlib

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import embed_sprites
import export_sprite_firmware as exporter
import sprite_compression as compression
from sprite_codec import decode_base, decode_pixels


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def source_pixels(path):
    with Image.open(path) as image:
        rgb = np.asarray(image.convert("RGB"), dtype=np.uint16)
    # Independent implementation: truncation, not palette quantization or rounding.
    return (rgb[:, :, 0] // 8 * 2048 + rgb[:, :, 1] // 4 * 32
            + rgb[:, :, 2] // 8).astype("<u2")


def expected_display(source):
    """Independent scalar float32 coordinate tables and packed-lane blending."""
    def f32(value):
        return struct.unpack("f", struct.pack("f", value))[0]

    factor = f32(396 / 240)
    def axis(length, source_length, offset):
        positions, weights = [], []
        for pixel in range(length):
            coordinate = f32(f32(f32(pixel + 0.5 - offset) / factor) - 0.5)
            coordinate = max(0.0, min(source_length - 1.0, coordinate))
            lower = math.floor(coordinate)
            positions.append(lower)
            weights.append(math.floor(f32(f32(coordinate - lower) * 32) + 0.5))
        return np.array(positions), np.array(weights, dtype=np.uint32)

    xx, wx = axis(400, 240, 2)
    yy, wy = axis(352, 224, f32(f32(352 - f32(224 * factor)) / 2))

    def mix(first, second, weight):
        first = first.astype(np.uint32)
        second = second.astype(np.uint32)
        a = (first | first << 16) & 0x07E0F81F
        b = (second | second << 16) & 0x07E0F81F
        mixed = ((a * (32 - weight) + b * weight) >> 5) & 0x07E0F81F
        return (mixed | mixed >> 16) & 0xFFFF

    horizontal = mix(source[:, xx], source[:, np.minimum(xx + 1, 239)], wx)
    result = mix(horizontal[yy], horizontal[np.minimum(yy + 1, 223)], wy[:, None])
    result[:, :2] = 0
    result[:, 398:] = 0
    return np.pad(result, ((0, 0), (6, 6))).astype(">u2")


def expected_pixels(path):
    return expected_display(source_pixels(path))


def inverse_word_up(raw, shape):
    """Independent inverse: cumulative uint16 sums, not exporter helpers."""
    residuals = np.frombuffer(raw, dtype=">u2").reshape(shape).astype(np.uint32)
    return np.cumsum(residuals, axis=0).astype(">u2")


class SpriteCompressionTest(unittest.TestCase):
    def setUp(self):
        self.directory = ROOT / "build/sprite-codec-tests" / uuid.uuid4().hex
        self.addCleanup(lambda: shutil.rmtree(self.directory) if self.directory.exists() else None)
        self.cache = compression.CompressionCache(self.directory)

    def test_word_wraps_big_endian_and_per_block_reset(self):
        raw = bytes.fromhex("ffff 0000 0000 ffff ffff 0000")
        expected = bytes.fromhex("ffff 0000 0001 ffff ffff 0001")
        predicted = compression.word_up(raw, 2)
        self.assertEqual(predicted, expected)
        self.assertEqual(inverse_word_up(predicted, (3, 2)).tobytes(), raw)
        self.assertEqual(compression.word_up(raw[:4], 2), raw[:4])
        self.assertEqual(compression.word_up(raw, 2), predicted)
        self.assertEqual(compression.ENCODING, "zlib-rgb565-word-up-be")
        for width in (0, -1, True, 1.5, 4):
            with self.subTest(width=width), self.assertRaises(ValueError):
                compression.word_up(raw, width)
        for invalid in (b"", b"\x00"):
            with self.assertRaises(ValueError):
                compression.word_up(invalid, 1)

    def test_cache_hits_are_validated_and_deterministic(self):
        raw = bytes.fromhex("ffff 0000 0000 ffff ffff 0000")
        encoded = self.cache.compress(raw, 2)
        self.assertEqual(inverse_word_up(zlib.decompress(encoded), (3, 2)).tobytes(), raw)
        path = self.cache.path_for(raw, 2)
        before = path.stat().st_mtime_ns
        with patch.object(compression.zopfli.zlib, "compress", side_effect=AssertionError("cache miss")):
            self.assertEqual(self.cache.compress(raw, 2), encoded)
        self.assertEqual(path.stat().st_mtime_ns, before)
        path.unlink()
        self.assertEqual(self.cache.compress(raw, 2), encoded)
        self.assertNotEqual(path, self.cache.path_for(raw, 1))
        self.assertFalse(list(self.directory.glob("*.part")))

    def test_standard_library_decode_api_and_invalid_streams(self):
        raw = bytes.fromhex("ffff 0000 0000 ffff ffff 0000")
        encoded = self.cache.compress(raw, 2)
        self.assertEqual(decode_pixels(encoded, 2), raw)
        for invalid in (encoded[:-1], encoded + b"trailing", encoded + encoded,
                        zlib.compress(b""), zlib.compress(b"\0")):
            with self.subTest(stream=invalid), self.assertRaises((ValueError, zlib.error)):
                decode_pixels(invalid, 2)
        for width in (0, -1, True, 1.5, 4):
            with self.subTest(width=width), self.assertRaises(ValueError):
                decode_pixels(encoded, width)

    def test_decode_base_places_crop_and_rejects_invalid_bounds(self):
        raw = bytes.fromhex("ffff 0000 0000 ffff ffff 0000")
        encoded = self.cache.compress(raw, 2)
        metadata = {"width": 5, "height": 6, "baseBounds": [1, 2, 2, 3]}
        expected = np.zeros((6, 5), dtype=">u2")
        expected[2:5, 1:3] = np.frombuffer(raw, dtype=">u2").reshape(3, 2)
        self.assertEqual(decode_base(encoded, metadata), expected.tobytes())
        for bounds in (None, [1, 2, 2], [True, 2, 2, 3], [-1, 2, 2, 3],
                       [1, 2, 0, 3], [4, 2, 2, 3], [1, 4, 2, 3], [1, 2, 2, 2]):
            with self.subTest(bounds=bounds), self.assertRaises(ValueError):
                decode_base(encoded, dict(metadata, baseBounds=bounds))

    def test_crop_prepass_unions_reachable_bases_only(self):
        poses = {}
        for name, point in (("a.png", (20, 30)), ("b.png", (10, 12)),
                            ("omitted.png", (0, 0)), ("c.png", (50, 80))):
            pixels = np.zeros((352, 412), dtype=">u2")
            pixels[point] = 1
            poses[name] = pixels
        manifest = {"directions": {
            "up": {"frames": [{"file": name} for name in ("a.png", "b.png", "omitted.png")]},
            "right": {"frames": [{"file": "c.png"}]},
        }}
        tracks = [(name, ROOT / "fake/animation.json", manifest) for name in ("up", "right")]
        with patch.object(exporter, "contained_path", side_effect=lambda directory, name: directory / name), \
                patch.object(exporter, "read_png", side_effect=lambda path, _: (poses[path.name], "")) as read, \
                patch.object(exporter, "rgb565", side_effect=lambda pixels: pixels), \
                patch.object(exporter, "display_pixels", side_effect=lambda pixels: pixels):
            self.assertEqual(exporter.derive_base_bounds(tracks, [2, 1]), [12, 10, 69, 41])
            self.assertEqual(read.call_count, 3)
            for pixels in poses.values():
                pixels.fill(0)
            with self.assertRaisesRegex(ValueError, "no nonblack pixels"):
                exporter.derive_base_bounds(tracks, [2, 1])

    def test_nonblack_padding_is_rejected_on_every_edge(self):
        bounds = [2, 3, 4, 5]
        pixels = np.zeros((12, 10), dtype=">u2")
        pixels[3:8, 2:6] = 0xFFFF
        exporter.validate_black_padding(pixels, bounds, "valid")
        for point in ((2, 2), (8, 2), (3, 1), (3, 6)):
            invalid = pixels.copy()
            invalid[point] = 1
            with self.subTest(point=point), self.assertRaisesRegex(ValueError, "refusing to clip"):
                exporter.validate_black_padding(invalid, bounds, "test blink")

    def test_corrupt_wrong_trailing_and_oversized_cache_records_are_repaired(self):
        raw = bytes.fromhex("ffff 0000 0000 ffff ffff 0000")
        encoded = self.cache.compress(raw, 2)
        path = self.cache.path_for(raw, 2)
        def record(data):
            return compression.CACHE_VERSION + hashlib.sha256(data).digest() + data
        invalid_records = [
            b"truncated", path.read_bytes()[:-1], record(zlib.compress(bytes(len(raw)))),
            record(encoded + b"trailing"), record(encoded[:-1]),
            record(zlib.compress(b"\0" * (len(raw) + 1))),
            record(encoded) + bytes(4096),
        ]
        compress = compression.zopfli.zlib.compress
        for invalid in invalid_records:
            with self.subTest(size=len(invalid)):
                path.write_bytes(invalid)
                with patch.object(compression.zopfli.zlib, "compress", wraps=compress) as called:
                    self.assertEqual(self.cache.compress(raw, 2), encoded)
                    called.assert_called_once()
                self.assertEqual(path.read_bytes(), record(encoded))

    def test_store_deduplication_includes_width_and_empty_blocks_stay_empty(self):
        store = exporter.BlockStore(self.directory)
        self.assertEqual(store.add(b"", 0), {"offset": 0, "size": 0})
        self.assertEqual(store.references, 0)
        self.assertFalse(self.directory.exists())
        raw = bytes.fromhex("ffff 0000 0000 ffff ffff 0000")
        first = store.add(raw, 2)
        self.assertEqual(first, store.add(raw, 2))
        other_width = store.add(raw, 1)
        self.assertNotEqual(first, other_width)
        self.assertEqual(len(store.blocks), 2)
        for block, width in ((first, 2), (other_width, 1)):
            data = store.data[block["offset"]:block["offset"] + block["size"]]
            self.assertEqual(inverse_word_up(zlib.decompress(data), (6 // width, width)).tobytes(), raw)

    def test_all_reachable_states_preserve_locked_pixels_without_export(self):
        metadata = json.loads((ROOT / "characters/copilot/frames.json").read_text())
        data = (ROOT / "characters/copilot/frames.bin").read_bytes()
        digest = hashlib.sha256()
        states = 0
        def decode(block, shape):
            raw = zlib.decompress(data[block["offset"]:block["offset"] + block["size"]])
            self.assertEqual(metadata["encoding"], compression.ENCODING)
            raw = inverse_word_up(raw, shape).tobytes()
            predicted = compression.word_up(raw, shape[1])
            actual = inverse_word_up(predicted, shape)
            self.assertEqual(actual.tobytes(), raw)
            return actual
        base_x, base_y, base_width, base_height = metadata["baseBounds"]
        for frame in metadata["frames"]:
            crop = decode(frame["base"], (base_height, base_width))
            base = np.zeros((metadata["height"], metadata["width"]), dtype=">u2")
            base[base_y:base_y + base_height, base_x:base_x + base_width] = crop
            digest.update(base.tobytes())
            states += 1
            x, y, width, height = (frame[key] for key in
                                  ("patchX", "patchY", "patchWidth", "patchHeight"))
            for block in frame["blinks"]:
                actual = base.copy()
                if width * height:
                    actual[y:y + height, x:x + width] = decode(block, (height, width))
                digest.update(actual.tobytes())
                states += 1
        self.assertEqual(states, 1440)
        self.assertEqual(digest.hexdigest(),
                         "c6bb1ddd2b3272be79511cbfd091b17ff1d9e46f61df173097df4d2516ba8a5b")


class SpriteFirmwareAssetsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source_path = ROOT / "characters/copilot/sprites/animation.json"
        cls.source = json.loads(cls.source_path.read_text())
        cls.metadata = json.loads((ROOT / "characters/copilot/frames.json").read_text())
        cls.data = (ROOT / "characters/copilot/frames.bin").read_bytes()
        cls.inputs = exporter.load_manifests(cls.source_path)
        cls.track_inputs = {direction: (path, manifest)
                            for path, _, manifest, directions in cls.inputs for direction in directions}

    def decode(self, block, shape):
        offset, size = block["offset"], block["size"]
        self.assertIs(type(offset), int)
        self.assertIs(type(size), int)
        self.assertGreaterEqual(offset, 0)
        self.assertGreater(size, 0)
        self.assertLessEqual(offset + size, len(self.data))
        decoder = zlib.decompressobj()
        raw = decoder.decompress(self.data[offset:offset + size])
        self.assertTrue(decoder.eof)
        self.assertEqual(decoder.unused_data, b"")
        self.assertEqual(decoder.unconsumed_tail, b"")
        self.assertEqual(len(raw), int(np.prod(shape)) * 2)
        return inverse_word_up(raw, shape)

    def decode_base(self, block):
        x, y, width, height = self.metadata["baseBounds"]
        base = np.zeros((self.metadata["height"], self.metadata["width"]), dtype=">u2")
        base[y:y + height, x:x + width] = self.decode(block, (height, width))
        return base

    def test_every_base_and_all_four_blinks_match_exact_rgb565(self):
        self.assertEqual(len(self.metadata["frames"]), sum(self.metadata["trackSteps"]))
        max_patch = 0
        empty_patches = 0
        digest = hashlib.sha256()
        occupied = np.zeros((352, 412), dtype=bool)
        outside_crop = np.ones((352, 412), dtype=bool)
        bx, by, bw, bh = self.metadata["baseBounds"]
        outside_crop[by:by + bh, bx:bx + bw] = False
        for frame in self.metadata["frames"]:
            direction, step = frame["direction"], frame["step"]
            with self.subTest(direction=direction, step=step):
                self.assertEqual(frame["direction"], direction)
                self.assertEqual(frame["step"], step)
                path, manifest = self.track_inputs[direction]
                source = manifest["directions"][direction]["frames"][step]
                base = self.decode_base(frame["base"])
                occupied |= base != 0
                np.testing.assert_array_equal(base, expected_pixels(path.parent / source["file"]))
                digest.update(base.tobytes())
                x, y, width, height = (frame[key] for key in
                                      ("patchX", "patchY", "patchWidth", "patchHeight"))
                self.assertTrue(all(type(value) is int for value in (x, y, width, height)))
                self.assertTrue(0 <= x <= x + width <= 412)
                self.assertTrue(0 <= y <= y + height <= 352)
                self.assertLess(width * height, 400 * 352)
                max_patch = max(max_patch, width * height)
                expected_blinks = [expected_pixels(path.parent / name) for name in source["blinks"]]
                changed = np.any(np.stack(expected_blinks) != base, axis=0)
                rows, columns = np.nonzero(changed)
                if len(rows):
                    self.assertEqual((x, y, width, height),
                                     (columns.min(), rows.min(), columns.max() - columns.min() + 1,
                                      rows.max() - rows.min() + 1))
                else:
                    empty_patches += 1
                    self.assertEqual((x, y, width, height), (0, 0, 0, 0))
                for block, expected in zip(frame["blinks"], expected_blinks):
                    actual = base.copy()
                    if width * height:
                        actual[y:y + height, x:x + width] = self.decode(block, (height, width))
                    else:
                        self.assertEqual(block, {"offset": 0, "size": 0})
                    np.testing.assert_array_equal(actual, expected)
                    self.assertFalse(actual[outside_crop].any())
                    digest.update(actual.tobytes())
        self.assertEqual(self.metadata["maxPatchPixels"], max_patch)
        self.assertEqual(self.metadata["maxPatchBytes"], max_patch * 2)
        self.assertGreater(empty_patches, 0)
        rows, columns = np.nonzero(occupied)
        self.assertEqual(self.metadata["baseBounds"],
                         [columns.min(), rows.min(), columns.max() + 1 - columns.min(),
                          rows.max() + 1 - rows.min()])
        self.assertEqual(self.metadata["baseBounds"], [32, 23, 348, 304])
        self.assertEqual(digest.hexdigest(),
                         "c6bb1ddd2b3272be79511cbfd091b17ff1d9e46f61df173097df4d2516ba8a5b")

    def test_shared_center_hashes_and_blocks_at_every_level(self):
        reference = self.metadata["frames"][0]
        source_reference = self.source["directions"]["right"]["frames"][0]
        center_names = [source_reference["file"], *source_reference["blinks"]]
        hashes = [sha256(expected_pixels(self.source_path.parent / name).tobytes()) for name in center_names]
        self.assertEqual(hashes, self.metadata["centerRgb565Sha256"])
        with Image.open(self.source_path.parent / source_reference["file"]) as image:
            self.assertEqual(sha256(image.convert("RGB").tobytes()), self.metadata["centerRgbSha256"])
        for direction_index in range(len(self.metadata["directions"])):
            frame = self.metadata["frames"][self.metadata["trackOffsets"][direction_index]]
            for key in ("base", "patchX", "patchY", "patchWidth", "patchHeight", "blinks"):
                self.assertEqual(frame[key], reference[key])

    def test_original_idle_pixels_remain_identical(self):
        digest = hashlib.sha256()
        for frame in self.metadata["frames"]:
            if frame["direction"] not in exporter.DIRECTIONS:
                continue
            base = self.decode_base(frame["base"])
            x, y, width, height = (frame[key] for key in
                                  ("patchX", "patchY", "patchWidth", "patchHeight"))
            for level in range(5):
                actual = base.copy()
                if level and width * height:
                    actual[y:y + height, x:x + width] = self.decode(frame["blinks"][level - 1],
                                                                   (height, width))
                self.assertFalse(actual[:, :6].any())
                self.assertFalse(actual[:, 406:].any())
                digest.update(actual[:, 6:406].tobytes())
        self.assertEqual(digest.hexdigest(),
                         "4035577d819c399ce219951dc7dafdc85bae96599e167926de82bfb42f78bb92")

    def test_spring_endpoint_is_shared_and_rejects_old_recoil(self):
        if "surprise" not in self.metadata["directions"]:
            self.skipTest("No expression artwork exported")
        offset = self.metadata["trackOffsets"][self.metadata["directions"].index("surprise")]
        last = self.metadata["frames"][offset + 23]
        for key in ("base", "patchX", "patchY", "patchWidth", "patchHeight", "blinks"):
            self.assertEqual(last[key], self.metadata["frames"][0][key])
        inputs = copy.deepcopy(self.inputs)
        archived = json.loads((ROOT / "characters/copilot/expressions/animation.candidate.json").read_text())
        old = archived["directions"]["surprise"]["frames"][-1]
        frame = inputs[-1][2]["directions"]["surprise"]["frames"][-1]
        for key in ("file", "blinks", "sha256"):
            frame[key] = old[key]
        with patch.object(exporter, "load_manifests", return_value=inputs):
            with self.assertRaisesRegex(ValueError, "Spring surprise must end"):
                exporter.build_assets(self.source_path)

    def test_export_rejects_pixels_outside_prepass_crop(self):
        with patch.object(exporter, "derive_base_bounds", return_value=[0, 0, 1, 1]):
            with self.assertRaisesRegex(ValueError, "Nonblack pixels outside shared base crop"):
                exporter.build_assets(self.source_path)

    def test_expression_order_full_tracks_and_preserved_blinks(self):
        expected = list(exporter.DIRECTIONS)
        if len(self.inputs) > 1:
            expected.extend(embed_sprites.EXPRESSION_DIRECTIONS)
        self.assertEqual(self.metadata["directions"], expected)
        offset = 0
        for index, direction in enumerate(expected):
            count = 12 if direction in ("up", "down") else 24
            self.assertEqual(self.metadata["trackSteps"][index], count)
            self.assertEqual(self.metadata["trackOffsets"][index], offset)
            frames = self.metadata["frames"][offset:offset + count]
            offset += count
            self.assertEqual([frame["step"] for frame in frames], list(range(count)))
            _, manifest = self.track_inputs[direction]
            for actual, source in zip(frames, manifest["directions"][direction]["frames"]):
                if source.get("blinkMaskState") == "expression-preserved":
                    self.assertEqual(actual["patchWidth"], 0)
                    self.assertEqual(actual["patchHeight"], 0)
                    self.assertEqual(actual["blinks"], [{"offset": 0, "size": 0}] * 4)

    def test_deduplication_contiguous_blocks_and_budget(self):
        unique = {}
        raw_blocks = {}
        references = 0
        referenced_bytes = 0
        raw_referenced_bytes = 0
        for frame in self.metadata["frames"]:
            for block, width in [(frame["base"], self.metadata["baseBounds"][2])] + [
                    (block, frame["patchWidth"]) for block in frame["blinks"]]:
                if not block["size"]:
                    self.assertEqual(block, {"offset": 0, "size": 0})
                    continue
                references += 1
                referenced_bytes += block["size"]
                key = (block["offset"], block["size"])
                compressed = self.data[key[0]:sum(key)]
                raw = zlib.decompress(compressed)
                raw_referenced_bytes += len(raw)
                raw = inverse_word_up(raw, (len(raw) // (width * 2), width)).tobytes()
                raw_key = (width, raw)
                if raw_key in raw_blocks:
                    self.assertEqual(key, raw_blocks[raw_key], "Identical bytes and width must share one block")
                raw_blocks[raw_key] = key
                unique[key] = compressed
        cursor = 0
        for offset, size in sorted(unique):
            self.assertEqual(offset, cursor, "Blob must contain only referenced unique blocks")
            cursor += size
        self.assertEqual(cursor, len(self.data))
        self.assertEqual(self.metadata["uniqueBlocks"], len(unique))
        self.assertEqual(self.metadata["blockReferences"], references)
        self.assertEqual(self.metadata["rawReferencedBytes"], raw_referenced_bytes)
        self.assertEqual(self.metadata["deduplicatedBytesSaved"], referenced_bytes - len(self.data))
        self.assertGreater(references, len(unique))
        self.assertEqual(self.metadata["dataBytes"], len(self.data))
        self.assertEqual(self.metadata["dataSha256"], sha256(self.data))
        metadata_bytes = len(self.metadata["frames"]) * 48 + len(self.metadata["directions"]) * 3 + 4 + 32
        self.assertEqual(self.metadata["metadataBytes"], metadata_bytes)
        self.assertEqual(self.metadata["totalAssetBytes"], len(self.data) + metadata_bytes)
        partition = embed_sprites.read_assets_partition()
        self.assertEqual(self.metadata["partition"], partition)
        self.assertEqual(self.metadata["assetBudgetBytes"], partition["size"])
        self.assertEqual(self.metadata["budgetRemainingBytes"], partition["size"] - len(self.data))
        self.assertLessEqual(len(self.data), partition["size"])
        exporter.enforce_budget(len(self.data), partition["size"])

    def test_nonsecret_provenance_hashes_match_all_inputs(self):
        for path, raw, manifest, directions in self.inputs:
            record = self.metadata["sourceManifests"][path.relative_to(ROOT).as_posix()]
            self.assertEqual(record["sha256"], sha256(raw))
            names = set()
            for direction in directions:
                for frame in manifest["directions"][direction]["frames"]:
                    names.update([frame["file"], *frame["blinks"]])
            self.assertEqual(set(record["sourcePngSha256"]), names)
            for name, digest in record["sourcePngSha256"].items():
                self.assertEqual(digest, sha256((path.parent / name).read_bytes()))
        for direction in self.metadata["directions"]:
            source = self.metadata["sources"][direction]
            self.assertEqual(source["provider"], "Azure GPT Image")
            self.assertEqual(source["sourceSha256"], sha256((ROOT / source["source"]).read_bytes()))
            allowed = {"provider", "source", "sourceSha256"}
            if "generationManifest" in source:
                allowed |= {"generationManifest", "generationManifestSha256"}
                self.assertEqual(source["generationManifestSha256"],
                                 sha256((ROOT / source["generationManifest"]).read_bytes()))
            self.assertEqual(set(source), allowed)

    def test_invalid_metadata_providers_bounds_and_budget_fail(self):
        mutations = [
            lambda m: m.update(width=239),
            lambda m: m.update(height=True),
            lambda m: m.update(count=12),
            lambda m: m.update(blinkLevels=[1, 0]),
            lambda m: m.update(centerSha256="not a hash"),
            lambda m: m["directions"].pop("down_left"),
            lambda m: m["directions"]["right"].update(provider="firmware atlas"),
            lambda m: m["directions"]["right"].update(width=241),
            lambda m: m["directions"]["right"]["frames"].pop(),
            lambda m: m["directions"]["right"]["frames"][0].update(blinks=[]),
            lambda m: m["directions"]["right"]["frames"][0].update(file=None),
            lambda m: m["directions"]["right"]["frames"][0].update(eyes=[[-1, 0, 2, 3]]),
        ]
        for mutation in mutations:
            manifest = copy.deepcopy(self.source)
            mutation(manifest)
            with self.assertRaises(ValueError):
                exporter.validate_manifest(manifest)
        for bounds in (None, [1, 2, 3], [-1, 0, 2, 3], [0, 0, 241, 224],
                       [0, 0, 240, 225], [2, 0, 2, 3], [False, 0, 2, 3]):
            with self.assertRaises(ValueError):
                exporter.validate_bounds(bounds, 240, 224, "test")
        partition_budget = embed_sprites.read_assets_partition()["size"]
        with self.assertRaisesRegex(ValueError, "exceed partition budget"):
            exporter.enforce_budget(partition_budget + 1, partition_budget)
        exporter.enforce_budget(partition_budget, partition_budget)
        for budget in (0, -1, True):
            with self.assertRaises(ValueError):
                exporter.enforce_budget(1, budget)
        for filename in ("../animation.json", "/absolute.png", "", None):
            with self.assertRaises(ValueError):
                exporter.contained_path(self.source_path.parent, filename)

    def test_png_dimensions_format_and_transparency_fail(self):
        for image, image_format in ((Image.new("RGB", (239, 224)), "PNG"),
                                    (Image.new("RGB", (240, 224)), "JPEG"),
                                    (Image.new("RGBA", (240, 224), (0, 0, 0, 0)), "PNG")):
            stream = io.BytesIO()
            image.save(stream, format=image_format)
            path = Mock()
            path.read_bytes.return_value = stream.getvalue()
            with self.assertRaises(ValueError):
                exporter.read_png(path, (240, 224))

    def test_rgb565_byte_order_and_zero_patch(self):
        pixels = np.array([[[255, 0, 0], [0, 255, 0], [0, 0, 255],
                            [7, 3, 7], [8, 4, 8]]], dtype=np.uint8)
        self.assertEqual(exporter.rgb565(pixels).tobytes(),
                         b"\x00\xf8\xe0\x07\x1f\x00\x00\x00\x21\x08")
        base = np.zeros((224, 240), dtype="<u2")
        self.assertEqual(exporter.patch_bounds(base, [base.copy() for _ in range(4)]), (0, 0, 0, 0))
        blinks = [base.copy() for _ in range(4)]
        blinks[0][2, 3] = 1
        blinks[3][5, 8] = 2
        self.assertEqual(exporter.patch_bounds(base, blinks), (3, 2, 6, 4))
        store = exporter.BlockStore()
        self.assertEqual(store.add(b"", 0), {"offset": 0, "size": 0})
        self.assertEqual(len(store.data), 0)
        self.assertEqual(store.add(b"same bytes", 5), store.add(b"same bytes", 5))

    def test_display_resampling_matches_independent_packed_reference(self):
        yy, xx = np.indices((224, 240), dtype=np.uint32)
        source = ((xx * 977 + yy * 3571) & 0xFFFF).astype("<u2")
        actual = exporter.display_pixels(source)
        np.testing.assert_array_equal(actual, expected_display(source))
        self.assertEqual(actual.dtype, np.dtype(">u2"))
        self.assertFalse(actual[:, :8].any())
        self.assertFalse(actual[:, 404:].any())
        for value, wire in ((0xF800, b"\xf8\x00"), (0x07E0, b"\x07\xe0"),
                            (0x001F, b"\x00\x1f"), (0xFFFF, b"\xff\xff")):
            solid = exporter.display_pixels(np.full((224, 240), value, dtype="<u2"))
            self.assertEqual(solid[0, 8:9].tobytes(), wire)
            self.assertTrue((solid[:, 8:404] == value).all())
        with self.assertRaises(ValueError):
            exporter.display_pixels(np.zeros((352, 400), dtype="<u2"))
        self.assertEqual(self.metadata["profile"], "display-ready")
        self.assertEqual(self.metadata["encoding"], "zlib-rgb565-word-up-be")
        self.assertTrue(self.metadata["displayReady"])
        self.assertEqual((self.metadata["width"], self.metadata["height"]), (412, 352))

    def test_frame_table_lives_in_the_character_pack_and_repeat_build_cache(self):
        firmware = ROOT / "firmware/AgentCompanion"
        for obsolete in ("generated/sprite_assets.h", "src/sprite_data.cpp", "src/sprite_blob.S",
                         "generated/sprite_bytes.h"):
            self.assertFalse((firmware / obsolete).exists(), f"Firmware must not embed {obsolete}")
        self.assertFalse(hasattr(exporter, "render_header"))
        self.assertEqual(self.metadata["metadataStorage"], "character-pack")
        paths = [ROOT / "characters/copilot/frames.bin", ROOT / "characters/copilot/frames.json"]
        before = [path.stat().st_mtime_ns for path in paths]
        with patch("builtins.print"):
            exporter.export()
            embed_sprites.embed()
        self.assertEqual([path.stat().st_mtime_ns for path in paths], before)
        self.assertFalse((ROOT / "build/sprite_host.S").exists())

    def test_embedding_rejects_stale_inputs_with_regeneration_command(self):
        first_png = next(iter(self.metadata["sourceManifests"][embed_sprites.IDLE_MANIFEST]["sourcePngSha256"]))
        first_source = self.metadata["sources"]["right"]["source"]
        generation_manifest = self.metadata["sources"]["up_right"]["generationManifest"]
        read_bytes = Path.read_bytes
        stale_paths = [self.source_path, self.source_path.parent / first_png,
                       ROOT / first_source, ROOT / generation_manifest]
        if len(self.inputs) > 1:
            expression_path = self.inputs[1][0]
            expression_record = self.metadata["sourceManifests"][expression_path.relative_to(ROOT).as_posix()]
            stale_paths.extend([expression_path,
                                expression_path.parent / next(iter(expression_record["sourcePngSha256"]))])
        for stale in stale_paths:
            with self.subTest(stale=stale):
                def changed_bytes(path):
                    return b"changed source" if path == stale else read_bytes(path)
                with patch.object(Path, "read_bytes", autospec=True, side_effect=changed_bytes):
                    with self.assertRaisesRegex(
                            ValueError, "Stale sprite export:.*python3 characters/copilot/tools/export_sprite_firmware.py"):
                        embed_sprites.embed()
        invalid = copy.deepcopy(self.metadata)
        invalid["sourceManifests"]["../outside/animation.json"] = {}
        with self.assertRaisesRegex(ValueError, "inventory changed"):
            embed_sprites.validate_sources(ROOT, invalid)
        invalid = copy.deepcopy(self.metadata)
        invalid["sourceManifests"][embed_sprites.IDLE_MANIFEST]["sourcePngSha256"] = {}
        with self.assertRaisesRegex(ValueError, "Missing sprite source PNG hash inventory"):
            embed_sprites.validate_sources(ROOT, invalid)

    def test_embedding_rejects_stale_profile_and_encoding(self):
        metadata_path = ROOT / "characters/copilot/frames.json"
        read_text = Path.read_text
        for field, value in (("formatVersion", 1), ("profile", "compact"),
                             ("encoding", "zlib-rgb565-le"), ("width", 240),
                             ("height", 224), ("displayReady", False), ("resampling", {})):
            invalid = copy.deepcopy(self.metadata)
            invalid[field] = value
            def stale_text(path, *args, **kwargs):
                return json.dumps(invalid) if path == metadata_path else read_text(path, *args, **kwargs)
            with self.subTest(field=field):
                with patch.object(Path, "read_text", autospec=True, side_effect=stale_text):
                    with self.assertRaisesRegex(ValueError, "profile/encoding.*export_sprite_firmware.py"):
                        embed_sprites.embed()

    def test_embedding_rejects_inconsistent_compact_track_tables(self):
        metadata_path = ROOT / "characters/copilot/frames.json"
        read_text = Path.read_text
        for field, value in (("trackSteps", [24] * len(self.metadata["directions"])),
                             ("trackOffsets", [0] * len(self.metadata["directions"])),
                             ("frameCount", 312), ("steps", 12),
                             ("frames", self.metadata["frames"][:-1])):
            invalid = copy.deepcopy(self.metadata)
            invalid[field] = value
            def stale_text(path, *args, **kwargs):
                return json.dumps(invalid) if path == metadata_path else read_text(path, *args, **kwargs)
            with self.subTest(field=field):
                with patch.object(Path, "read_text", autospec=True, side_effect=stale_text):
                    with self.assertRaisesRegex(ValueError, "binary/metadata mismatch"):
                        embed_sprites.embed()

    def test_optional_expression_manifest_presence_and_validation(self):
        path = ROOT / embed_sprites.EXPRESSION_MANIFEST
        exists = Path.exists
        read_bytes = Path.read_bytes
        with patch.object(Path, "exists", autospec=True,
                          side_effect=lambda p: False if p == path else exists(p)):
            self.assertEqual(len(exporter.load_manifests(self.source_path)), 1)
        expressions = copy.deepcopy(self.source)
        expressions["directions"] = {
            name: copy.deepcopy(self.source["directions"]["right"])
            for name in embed_sprites.EXPRESSION_DIRECTIONS
        }
        for data, valid in ((json.dumps(expressions).encode(), True), (b"{not json", False),
                            (json.dumps(self.source).encode(), False)):
            with patch.object(Path, "exists", autospec=True,
                              side_effect=lambda p: True if p == path else exists(p)):
                with patch.object(Path, "read_bytes", autospec=True,
                                  side_effect=lambda p: data if p == path else read_bytes(p)):
                    if valid:
                        inputs = exporter.load_manifests(self.source_path)
                        self.assertEqual(inputs[1][3], embed_sprites.EXPRESSION_DIRECTIONS)
                    else:
                        with self.assertRaises(ValueError):
                            exporter.load_manifests(self.source_path)
        for field, value in (("centerSha256", "0" * 64),
                             ("approvedSpriteManifestSha256", "0" * 64)):
            invalid = copy.deepcopy(expressions)
            invalid[field] = value
            with patch.object(Path, "exists", autospec=True,
                              side_effect=lambda p: True if p == path else exists(p)):
                with patch.object(Path, "read_bytes", autospec=True,
                                  side_effect=lambda p: json.dumps(invalid).encode()
                                  if p == path else read_bytes(p)):
                    with self.assertRaises(ValueError):
                        exporter.load_manifests(self.source_path)

    def test_partition_budget_parsing_and_validation(self):
        path = ROOT / "firmware/AgentCompanion/partitions.csv"
        read_bytes = Path.read_bytes
        valid = ("# Name, Type, SubType, Offset, Size, Flags\n"
                 "factory, app, factory, 0x10000, 2M,\n"
                 "assets, data, 0x40, 0x210000, 0xDE0000,\n"
                 "coredump, data, coredump, 0xFF0000, 64K,\n")
        invalid = [
            valid.replace("assets,", "missing,"),
            valid + "assets,data,0x40,0x210000,0xDE0000,\n",
            valid.replace("data, 0x40", "app, 0x40"),
            valid.replace("data, 0x40", "data, 0x41"),
            valid.replace("0xDE0000", "0"),
            valid.replace("0xDE0000", "0xDF0000"),
            valid.replace("0x210000", "0x200000"),
            valid.replace("0x210000", "0x210001"),
        ]
        for text in [valid, *invalid]:
            with patch.object(Path, "read_bytes", autospec=True,
                              side_effect=lambda p: text.encode() if p == path else read_bytes(p)):
                if text == valid:
                    partition = embed_sprites.read_assets_partition()
                    self.assertEqual(partition["size"], 0xDE0000)
                    self.assertEqual(partition["offset"], 0x210000)
                else:
                    with self.assertRaises(ValueError):
                        embed_sprites.read_assets_partition()

    def test_embedding_rejects_changed_partition_and_manifest_inventory(self):
        path = ROOT / "firmware/AgentCompanion/partitions.csv"
        original = path.read_bytes()
        read_bytes = Path.read_bytes
        with patch.object(Path, "read_bytes", autospec=True,
                          side_effect=lambda p: original + b"\n# changed\n" if p == path else read_bytes(p)):
            with self.assertRaisesRegex(ValueError, "Stale sprite assets partition"):
                embed_sprites.embed()
        expression_path = ROOT / embed_sprites.EXPRESSION_MANIFEST
        exists = Path.exists
        present = expression_path.exists()
        with patch.object(Path, "exists", autospec=True,
                          side_effect=lambda p: not present if p == expression_path else exists(p)):
            with self.assertRaisesRegex(ValueError, "inventory changed"):
                embed_sprites.validate_sources(ROOT, self.metadata)


if __name__ == "__main__":
    unittest.main()

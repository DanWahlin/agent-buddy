import json
import os
from pathlib import Path
import sys
import unittest

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "characters/copilot/tools"))
from prepare_sprite_animation import blink, eye_bounds
from create_diagonal_guides import DIAGONALS
from prepare_device_diagonals import unpack_frame

ASSETS = Path(os.environ.get("SPRITE_ASSETS", str(ROOT / "characters/copilot/sprites")))


def pixels(filename):
    with Image.open(ASSETS / filename) as image:
        return np.asarray(image.convert("RGB"))


class SpriteAssetsTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads((ASSETS / "animation.json").read_text())

    def test_complete_tracks_and_identical_center_at_every_blink_level(self):
        self.assertEqual(set(self.manifest["directions"]), {"right", "left", "up", "down", *DIAGONALS})
        self.assertEqual(self.manifest["blinkLevels"], [1, 0.75, 0.5, 0.25, 0])
        reference = self.manifest["directions"]["right"]["frames"][0]
        center_images = [pixels(name) for name in [reference["file"], *reference["blinks"]]]
        for direction, track in self.manifest["directions"].items():
            with self.subTest(direction=direction):
                self.assertEqual(len(track["frames"]), 24)
                front = track["frames"][0]
                for actual, expected in zip([front["file"], *front["blinks"]], center_images):
                    np.testing.assert_array_equal(pixels(actual), expected)
                for frame in track["frames"]:
                    self.assertEqual(len(frame["blinks"]), 4)
                    for name in [frame["file"], *frame["blinks"]]:
                        self.assertEqual(pixels(name).shape, (224, 240, 3))

    def test_blinks_change_only_eye_neighborhoods_and_preserve_silhouette(self):
        for direction, track in self.manifest["directions"].items():
            for index, frame in enumerate(track["frames"]):
                with self.subTest(direction=direction, frame=index):
                    original = pixels(frame["file"])
                    permitted = np.zeros(original.shape[:2], dtype=bool)
                    for x0, y0, x1, y1 in frame["eyes"]:
                        permitted[max(0, y0 - 4):y1 + 4, max(0, x0 - 4):x1 + 4] = True
                    self.assertLess(permitted.mean(), 0.2, "blink regions must remain local to the eyes")
                    silhouette_edge = distance_transform_edt(original.max(axis=2) > 32) <= 2
                    for name in frame["blinks"]:
                        actual = pixels(name)
                        np.testing.assert_array_equal(actual[~permitted], original[~permitted])
                        np.testing.assert_array_equal(actual[silhouette_edge], original[silhouette_edge])
                    if not frame["eyes"]:
                        self.assertEqual(direction, "down")
                        self.assertGreaterEqual(index, 15)
                        self.assertEqual(frame["blinkMaskState"], "occluded-or-rim-clipped")
                    else:
                        self.assertFalse(np.array_equal(pixels(frame["blinks"][-1]), original))

    def test_generated_directions_actually_move_the_eyes_correctly(self):
        def centers(direction, index):
            bounds = self.manifest["directions"][direction]["frames"][index]["eyes"]
            return np.mean([[(x0 + x1) / 2, (y0 + y1) / 2] for x0, y0, x1, y1 in bounds], axis=0)
        center = centers("right", 0)
        self.assertGreater(centers("right", 23)[0], center[0] + 40)
        self.assertLess(centers("left", 23)[0], center[0] - 40)
        self.assertLess(centers("up", 23)[1], center[1] - 40)
        self.assertGreater(centers("down", 12)[1], center[1] + 40)

    def test_open_eye_reproduction_and_invalid_masks(self):
        image = Image.open(ASSETS / "right-00.png").convert("RGB")
        np.testing.assert_array_equal(np.asarray(blink(image, eye_bounds(image), 1)), np.asarray(image))
        with self.assertRaises(ValueError):
            blink(image, eye_bounds(image), -0.1)
        with self.assertRaises(ValueError):
            eye_bounds(Image.new("RGB", (240, 224)))

    def test_diagonals_use_verified_generated_artwork(self):
        import hashlib
        for direction in DIAGONALS:
            track = self.manifest["directions"][direction]
            self.assertEqual(track["provider"], "Azure GPT Image")
            provenance = json.loads((ROOT / track["generationProvenance"]).read_text())
            source = ROOT / "characters/copilot/source/generated-sprites" / track["source"]
            digest = hashlib.sha256(source.read_bytes()).hexdigest()
            self.assertEqual(track["sourceSha256"], digest)
            self.assertEqual(provenance["sha256"], digest)
            self.assertEqual(provenance["reference"], "characters/copilot/source/generated-sprites/approved-center.png")
            for frame in track["frames"]:
                self.assertIn("-generated-", frame["file"])
                self.assertNotIn("atlasTurn", frame)
            self.assertFalse(np.array_equal(pixels(track["frames"][0]["file"]),
                                            pixels(track["frames"][-1]["file"])))

    def test_diagonals_turn_both_horizontally_and_vertically(self):
        for direction in DIAGONALS:
            track = self.manifest["directions"][direction]
            def center(frame):
                return np.mean([[(x0 + x1) / 2, (y0 + y1) / 2]
                                for x0, y0, x1, y1 in frame["eyes"]], axis=0)
            delta = center(track["frames"][-1]) - center(track["frames"][0])
            with self.subTest(direction=direction):
                self.assertGreater(delta[0] * (1 if direction.endswith("right") else -1), 15)
                self.assertGreater(delta[1] * (1 if direction.startswith("down") else -1), 5)

    def test_native_frame_byte_order_and_rgb565_channels(self):
        packed = np.zeros((352, 400), dtype=">u2")
        packed[0, :3] = [0xF800, 0x07E0, 0x001F]
        image = np.asarray(unpack_frame(packed.tobytes()))
        np.testing.assert_array_equal(image[0, :3], [[255, 0, 0], [0, 255, 0], [0, 0, 255]])


if __name__ == "__main__":
    unittest.main()

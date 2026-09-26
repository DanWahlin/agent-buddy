import json
from pathlib import Path
import sys
import unittest

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "characters/copilot/tools"))
from alternate_attention import COUNTER_ROLL_DEGREES, swap_eye_lights
from prepare_generated_expressions import apparent_goggle_roll
from prepare_sprite_animation import blink
from smooth_surprise import APPROVED, OUTPUT, digest, rigid_matrix, transform_head


class AlternateAttentionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads((OUTPUT / "animation.json").read_text())
        cls.original = cls.manifest["directions"]["attention"]
        cls.track = cls.manifest["directions"]["attention_alternate"]

    def test_originals_retained_and_center_identical(self):
        archived = json.loads((OUTPUT / "animation.candidate.json").read_text())
        for name in ("working", "complete", "attention"):
            self.assertEqual(self.manifest["directions"][name]["frames"], archived["directions"][name]["frames"])
        reference = json.loads((APPROVED / "animation.json").read_text())["directions"]["right"]["frames"][0]
        first = self.track["frames"][0]
        for actual, source in zip([first["file"], *first["blinks"]], [reference["file"], *reference["blinks"]]):
            self.assertEqual((OUTPUT / actual).read_bytes(), (APPROVED / source).read_bytes())

    def test_eye_swap_is_local_and_shapes_trade_places(self):
        for frame in self.original["frames"][1:]:
            original = Image.open(OUTPUT / frame["file"]).convert("RGB")
            swapped, bounds = swap_eye_lights(original, frame["eyes"])
            permitted = np.zeros((224, 240), dtype=bool)
            for x0, y0, x1, y1 in [*frame["eyes"], *bounds]:
                permitted[y0-5:y1+5, x0-5:x1+5] = True
            self.assertLess(permitted.mean(), .08)
            np.testing.assert_array_equal(np.asarray(swapped)[~permitted], np.asarray(original)[~permitted])
            for source, destination in zip(frame["eyes"][::-1], bounds):
                self.assertEqual(source[3]-source[1], destination[3]-destination[1])
        self.assertLess(bounds[0][3]-bounds[0][1], bounds[1][3]-bounds[1][1])

    def test_rigid_reconstruction_blinks_and_no_clipping(self):
        for frame, source in zip(self.track["frames"][1:], self.original["frames"][1:]):
            original = Image.open(OUTPUT / source["file"]).convert("RGB")
            swapped, eyes = swap_eye_lights(original, source["eyes"])
            matrix = rigid_matrix(original.size, COUNTER_ROLL_DEGREES * frame["strength"])
            np.testing.assert_allclose(matrix[:2, :2].T @ matrix[:2, :2], np.eye(2), atol=1e-12)
            for filename, openness in zip([frame["file"], *frame["blinks"]], (1, .75, .5, .25, 0)):
                actual = np.asarray(Image.open(OUTPUT / filename).convert("RGB"))
                expected = transform_head(blink(swapped, eyes, openness), matrix)
                np.testing.assert_array_equal(actual, np.asarray(expected))
                self.assertFalse(actual[[0, -1], :, :].any())
                self.assertFalse(actual[:, [0, -1], :].any())
            self.assertEqual(digest(OUTPUT / frame["file"]), frame["sha256"])
        original_roll = apparent_goggle_roll(Image.open(OUTPUT / self.original["frames"][-1]["file"]))
        alternate_roll = apparent_goggle_roll(Image.open(OUTPUT / self.track["frames"][-1]["file"]))
        self.assertGreater(original_roll, 2)
        self.assertLess(alternate_roll, -2)
        self.assertAlmostEqual(original_roll-alternate_roll, COUNTER_ROLL_DEGREES, delta=1)

    def test_provenance(self):
        recipe = json.loads((ROOT / self.track["generationProvenance"]).read_text())
        self.assertEqual(digest(ROOT / recipe["script"]), recipe["scriptSha256"])
        self.assertEqual(digest(ROOT / recipe["helpers"]), recipe["helpersSha256"])
        for filename, sha in recipe["sourcePngSha256"].items():
            self.assertEqual(digest(OUTPUT / filename), sha)


if __name__ == "__main__":
    unittest.main()

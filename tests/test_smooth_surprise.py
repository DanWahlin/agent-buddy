import json
from pathlib import Path
import sys
import unittest

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "characters/copilot/tools"))
from smooth_surprise import APPROVED, OUTPUT, digest, recoil, recoil_matrix, render


class SmoothSurpriseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads((OUTPUT / "animation.json").read_text())
        cls.track = json.loads((OUTPUT / "review/smooth-surprise.json").read_text())
        cls.reference = json.loads((APPROVED / "animation.json").read_text())["directions"]["right"]["frames"][0]
        cls.neutral = Image.open(APPROVED / cls.reference["file"]).convert("RGB")

    def test_shared_center_and_archived_originals(self):
        first = self.track["frames"][0]
        for actual, original in zip([first["file"], *first["blinks"]],
                                    [self.reference["file"], *self.reference["blinks"]]):
            self.assertEqual((OUTPUT / actual).read_bytes(), (APPROVED / original).read_bytes())
        for i in range(24):
            self.assertTrue((OUTPUT / f"surprise-{i:02d}.png").is_file())
        self.assertEqual(self.track["rendering"], "localized-eye-light-rigid-recoil")

    def test_body_is_fixed_and_light_reconstruction_is_exact(self):
        original = np.asarray(self.neutral)
        permitted = np.zeros(original.shape[:2], dtype=bool)
        for x0, y0, x1, y1 in self.track["eyeRegions"]:
            permitted[y0:y1, x0:x1] = True
        self.assertLess(permitted.mean(), .1)
        material = (original[:, :, 0] > 80) & (original[:, :, 1] > 150)
        for x0, y0, x1, y1 in self.reference["eyes"]:
            material[y0-4:y1+4, x0-4:x1+4] = False
        last = original.astype(float)
        for frame in self.track["frames"]:
            actual = np.asarray(Image.open(OUTPUT / frame["file"]).convert("RGB"))
            local = render(self.neutral, self.reference["eyes"], self.track["targetEyes"], frame["strength"])
            pixels = np.asarray(local)
            np.testing.assert_array_equal(pixels[~permitted], original[~permitted])
            np.testing.assert_array_equal(pixels[material], original[material])
            np.testing.assert_array_equal(actual, np.asarray(recoil(local, frame["strength"])))
            self.assertLess(np.abs(pixels.astype(float)-last)[permitted].mean(), 3)
            self.assertEqual(digest(OUTPUT / frame["file"]), frame["sha256"])
            last = pixels.astype(float)

    def test_visible_eyes_never_shrink_or_jump_on_entry(self):
        previous = None
        previous_edges = None
        sizes = []
        for frame in self.track["frames"]:
            # Measure in head-local space so the intentional rigid motion is not eye jitter.
            actual = np.asarray(render(self.neutral, self.reference["eyes"],
                                       self.track["targetEyes"], frame["strength"]))
            current, edges = [], []
            for initial, target in zip(self.reference["eyes"], self.track["targetEyes"]):
                x0, y0 = min(initial[0], target[0])-2, min(initial[1], target[1])-2
                x1, y1 = max(initial[2], target[2])+2, max(initial[3], target[3])+2
                eye = actual[y0:y1, x0:x1]
                yy, xx = np.nonzero((eye[:, :, 1] > 150) & (eye[:, :, 0] > 80))
                current.append([np.ptp(xx)+1, np.ptp(yy)+1])
                edges.append([xx.min()+x0, yy.min()+y0, xx.max()+x0, yy.max()+y0])
            current = np.array(current)
            edges = np.array(edges)
            if previous is not None:
                self.assertTrue(np.all(current >= previous))
                self.assertTrue(np.all(np.abs(edges-previous_edges) <= 1))
                self.assertTrue(np.all(edges[:, :2] <= previous_edges[:, :2]))
                self.assertTrue(np.all(edges[:, 2:] >= previous_edges[:, 2:]))
            sizes.append(current)
            previous = current
            previous_edges = edges
        self.assertGreater(np.prod(sizes[-1], axis=1).mean(), np.prod(sizes[0], axis=1).mean()*1.5)

    def test_recoil_is_rigid_subpixel_bounded_and_unclipped(self):
        pixels = np.asarray(self.neutral)
        yy, xx = np.nonzero(pixels.max(axis=2) > 0)
        points = np.stack([xx + .5, yy + .5, np.ones_like(xx)], axis=0)
        previous = points[:2]
        for frame in self.track["frames"]:
            matrix = recoil_matrix(self.neutral.size, frame["strength"])
            rotation = matrix[:2, :2]
            np.testing.assert_allclose(rotation.T @ rotation, np.eye(2), atol=1e-12)
            self.assertAlmostEqual(np.linalg.det(rotation), 1)
            moved = (matrix @ points)[:2]
            self.assertLess(np.linalg.norm(moved-previous, axis=0).max(), .5)
            self.assertTrue(np.all(moved > 2))
            self.assertTrue(np.all(moved[0] < self.neutral.width-2))
            self.assertTrue(np.all(moved[1] < self.neutral.height-2))
            actual = np.asarray(Image.open(OUTPUT / frame["file"]).convert("RGB"))
            self.assertFalse(actual[[0, -1], :, :].any())
            self.assertFalse(actual[:, [0, -1], :].any())
            self.assertEqual(frame["headRotationDegrees"], 2 * frame["strength"])
            self.assertEqual(frame["headTranslation"], [0, -4 * frame["strength"]])
            previous = moved
        self.assertGreater(np.linalg.norm(previous-points[:2], axis=0).max(), 4)

    def test_other_modes_and_processing_provenance(self):
        archived = json.loads((OUTPUT / "animation.candidate.json").read_text())
        for name in ("working", "complete", "attention"):
            self.assertEqual(self.manifest["directions"][name]["frames"], archived["directions"][name]["frames"])
        recipe = json.loads((ROOT / self.track["generationProvenance"]).read_text())
        self.assertEqual(digest(ROOT / recipe["script"]), recipe["scriptSha256"])
        self.assertEqual(digest(OUTPUT / self.track["source"]), recipe["sha256"])


if __name__ == "__main__":
    unittest.main()

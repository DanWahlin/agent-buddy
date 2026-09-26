"""Focused art/provenance tests; never reads firmware or modifies approved sprites."""
import json
from pathlib import Path
import sys
import unittest

import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, label

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "characters/copilot/tools"))
from prepare_generated_expressions import (
    APPROVED, COUNT, DIRECTIONS, HEIGHT, OUTPUT, WIDTH, colored_heads,
    apparent_goggle_roll, digest, expression_eyes, reconstruct_frame,
)


def pixels(path):
    with Image.open(path) as image:
        return np.asarray(image.convert("RGB"))


class GeneratedExpressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads((OUTPUT / "animation.candidate.json").read_text())
        cls.approved = json.loads((APPROVED / "animation.json").read_text())

    def test_manifest_contract_and_exact_shared_neutral_at_all_blink_levels(self):
        m = self.manifest
        self.assertEqual(list(m["directions"]), list(DIRECTIONS))
        self.assertEqual((m["width"], m["height"], m["count"]), (WIDTH, HEIGHT, COUNT))
        self.assertEqual(m["blinkLevels"], [1, 0.75, 0.5, 0.25, 0])
        self.assertEqual(m["centerSha256"], self.approved["centerSha256"])
        reference = self.approved["directions"]["right"]["frames"][0]
        approved_names = [reference["file"], *reference["blinks"]]
        for track in self.approved["directions"].values():
            first = track["frames"][0]
            for actual, original in zip([first["file"], *first["blinks"]], approved_names):
                self.assertEqual((APPROVED / actual).read_bytes(), (APPROVED / original).read_bytes())
        for track in m["directions"].values():
            self.assertEqual(track["count"], 24)
            self.assertEqual(len(track["frames"]), 24)
            first = track["frames"][0]
            for actual, original in zip([first["file"], *first["blinks"]], approved_names):
                self.assertEqual((OUTPUT / actual).read_bytes(), (APPROVED / original).read_bytes())
            for frame in track["frames"]:
                self.assertEqual(len(frame["blinks"]), 4)
                for filename in [frame["file"], *frame["blinks"]]:
                    self.assertEqual(pixels(OUTPUT / filename).shape, (224, 240, 3))

    def test_generation_provenance_and_all_raw_frames_retained(self):
        for name, track in self.manifest["directions"].items():
            with self.subTest(direction=name):
                source = OUTPUT / track["source"]
                provenance = json.loads((ROOT / track["generationProvenance"]).read_text())
                self.assertEqual(track["provider"], "Azure GPT Image")
                self.assertEqual(digest(source), track["sourceSha256"])
                self.assertEqual(digest(source), provenance["sha256"])
                self.assertEqual(digest(ROOT / provenance["prompt"]), provenance["promptSha256"])
                self.assertEqual(digest(ROOT / provenance["layoutGuide"]), provenance["layoutGuideSha256"])
                self.assertEqual(digest(ROOT / provenance["reference"]), provenance["referenceSha256"])
                with Image.open(source) as image:
                    sheet = image.convert("RGB")
                self.assertEqual(sheet.size, (1536, 1024))
                _, heads = colored_heads(sheet)
                self.assertEqual(len(heads), 24)
                for index, frame in enumerate(track["frames"]):
                    self.assertEqual(frame["sourceIndex"], index)
                    np.testing.assert_array_equal(
                        pixels(OUTPUT / frame["rawCrop"]),
                        np.asarray(sheet.crop(tuple(frame["cropBounds"]))),
                    )

    def test_every_non_neutral_pose_reconstructs_from_only_crop_scale_translation(self):
        for direction, track in self.manifest["directions"].items():
            with Image.open(OUTPUT / track["source"]) as image:
                source = image.convert("RGB")
            for index, frame in enumerate(track["frames"]):
                with self.subTest(direction=direction, frame=index):
                    self.assertEqual(digest(OUTPUT / frame["file"]), frame["sha256"])
                    bounds = frame["cropBounds"]
                    size = [round((bounds[2]-bounds[0])*frame["uniformScale"]),
                            round((bounds[3]-bounds[1])*frame["uniformScale"])]
                    self.assertEqual(size, frame["registeredSize"])
                    if index == 0:
                        self.assertTrue(frame["neutralOverride"])
                    else:
                        self.assertFalse(frame["neutralOverride"])
                        np.testing.assert_array_equal(
                            np.asarray(reconstruct_frame(source, frame)),
                            pixels(OUTPUT / frame["file"]),
                        )

    def test_blinks_are_local_and_expression_preservation_is_exact(self):
        for direction, track in self.manifest["directions"].items():
            for index, frame in enumerate(track["frames"]):
                with self.subTest(direction=direction, frame=index):
                    original = pixels(OUTPUT / frame["file"])
                    permitted = np.zeros((224, 240), dtype=bool)
                    for x0, y0, x1, y1 in frame["eyes"]:
                        permitted[max(0, y0-4):y1+4, max(0, x0-4):x1+4] = True
                    self.assertLess(permitted.mean(), .13)
                    edge = distance_transform_edt(original.max(axis=-1) > 32) <= 2
                    for filename in frame["blinks"]:
                        actual = pixels(OUTPUT / filename)
                        np.testing.assert_array_equal(actual[~permitted], original[~permitted])
                        np.testing.assert_array_equal(actual[edge], original[edge])
                        if frame["blinkMaskState"] == "expression-preserved":
                            np.testing.assert_array_equal(actual, original)
                    if direction in ("working", "attention") and index:
                        self.assertFalse(np.array_equal(
                            pixels(OUTPUT / frame["blinks"][-1]), original))

    def test_coherent_silhouettes_margins_and_bounded_registration(self):
        for direction, track in self.manifest["directions"].items():
            heights = []
            last_center = None
            for index, frame in enumerate(track["frames"]):
                with self.subTest(direction=direction, frame=index):
                    image = pixels(OUTPUT / frame["file"])
                    self.assertLessEqual(abs(apparent_goggle_roll(image)), 8)
                    silhouette = image.max(axis=-1) > 32
                    self.assertFalse(silhouette[:6].any() or silhouette[-6:].any()
                                     or silhouette[:, :6].any() or silhouette[:, -6:].any())
                    components, _ = label(silhouette)
                    sizes = np.bincount(components.ravel())[1:]
                    self.assertEqual(np.count_nonzero(sizes > 80), 1)
                    self.assertGreater(sizes.max(), 16000)
                    self.assertLess(sizes.max(), 37000)
                    yy, xx = np.nonzero(silhouette)
                    width, height = np.ptp(xx)+1, np.ptp(yy)+1
                    self.assertLessEqual(width, 220)
                    self.assertLessEqual(height, 198)
                    heights.append(int(height))
                    center = np.array([(xx.min()+xx.max())/2, (yy.min()+yy.max())/2])
                    if last_center is not None:
                        self.assertLessEqual(float(np.linalg.norm(center-last_center)), 3.)
                    last_center = center
            self.assertLessEqual(max(heights)/min(heights), 1.22)
            self.assertLessEqual(max(abs(a-b) for a, b in zip(heights, heights[1:])), 12)

    def test_existing_approved_assets_were_not_modified(self):
        self.assertEqual(digest(APPROVED / "animation.json"),
                         self.manifest["approvedSpriteManifestSha256"])
        inventory = json.loads((OUTPUT / "references/approved-inventory.json").read_text())
        for filename, expected in inventory.items():
            self.assertEqual(digest(APPROVED / filename), expected, filename)

    def test_expression_endpoints_and_refined_attention_entrance(self):
        tracks = self.manifest["directions"]

        def sizes(direction, index):
            return np.array([[x1-x0,y1-y0] for x0,y0,x1,y1 in
                             tracks[direction]["frames"][index]["eyes"]])

        neutral = sizes("surprise", 0)
        self.assertGreater(sizes("surprise", 23).prod(axis=1).mean(),
                           neutral.prod(axis=1).mean()*2)
        self.assertLess(sizes("working", 23)[:,1].mean(), neutral[:,1].mean()*.5)
        happy = sizes("complete", 23)
        self.assertTrue(np.all(happy[:,0] > happy[:,1]*1.5))
        curious = sizes("attention", 23)
        self.assertGreater(curious[0,1], curious[1,1]*1.5)
        entrance = sizes("attention", 1)
        self.assertLessEqual(abs(int(entrance[0,1]-entrance[1,1])), 3)
        self.assertGreater(entrance[:,1].min(), 20)
        for track in tracks.values():
            playback = track["recommendedPlaybackIndices"]
            self.assertEqual(playback[0], 0)
            self.assertEqual(playback[-1], 23)
            self.assertEqual(playback, sorted(set(playback)))
            self.assertTrue(all(0 <= i < 24 for i in track["recommendedLoopIndices"]))

    def test_eye_detector_rejects_missing_eyes(self):
        with self.assertRaises(ValueError):
            expression_eyes(Image.new("RGB", (240, 224)))


if __name__ == "__main__":
    unittest.main()

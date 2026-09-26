"""Verify one-way spring art without builds, servers, exports, or device access."""
import copy
import json
from pathlib import Path
import sys
import unittest
from unittest import mock

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "characters/copilot/tools"))
import spring_surprise as spring
from smooth_surprise import render


class SpringSurpriseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest = json.loads((spring.OUTPUT / "animation.json").read_text())
        cls.track = cls.manifest["directions"]["surprise"]
        cls.reference = json.loads((spring.APPROVED / "animation.json").read_text())["directions"]["right"]["frames"][0]
        cls.neutral = Image.open(spring.APPROVED / cls.reference["file"]).convert("RGB")
        cls.preservation = json.loads((spring.REVIEW / f"{spring.PREFIX}-preservation.json").read_text())

    def test_both_endpoints_are_exact_shared_center_at_all_five_levels(self):
        self.assertEqual(self.track["count"], 24)
        self.assertEqual(self.track["neutralFrames"], [0,23])
        self.assertEqual(self.track["terminalFrame"], 23)
        for index in (0,23):
            frame = self.track["frames"][index]
            for actual, expected in zip([frame["file"], *frame["blinks"]],
                                        [self.reference["file"], *self.reference["blinks"]]):
                self.assertEqual((spring.OUTPUT / actual).read_bytes(),
                                 (spring.APPROVED / expected).read_bytes())
            self.assertEqual(frame["eyes"], self.reference["eyes"])
            self.assertEqual(frame["headScale"], 1)
            self.assertEqual(frame["headTranslation"], [0,0])
            self.assertEqual(frame["headRotationDegrees"], 0)
            self.assertEqual(frame["strength"], 0)
            np.testing.assert_array_equal(frame["headTransform"], np.eye(3))

    def test_uniform_time_compression_single_rebound_and_settling(self):
        frames = self.track["frames"]
        times = np.array([f["sampleTime"] for f in frames])
        np.testing.assert_allclose(times, np.arange(24)/23, atol=1e-15)
        np.testing.assert_allclose(self.track["sampleTimesMs"], times*800)
        self.assertEqual(self.track["durationMs"], 800)
        self.assertEqual(self.track["sampling"], "uniform-time")
        self.assertEqual(self.track["recommendedPlaybackIndices"], list(range(24)))
        self.assertEqual(self.track["recommendedLoopIndices"], [23])
        self.assertEqual(self.track["interruptionPolicy"], "finish-forward-to-frame-23")
        scales = np.array([f["headScale"] for f in frames])
        self.assertGreaterEqual(scales.min(), .91)
        self.assertLessEqual(scales.min(), .92)
        self.assertGreaterEqual(scales.max(), 1.01)
        self.assertLessEqual(scales.max(), 1.02)
        self.assertTrue(80 <= times[scales.argmin()]*800 <= 130)
        self.assertTrue(280 <= times[scales.argmax()]*800 <= 440)
        oversized = np.flatnonzero(scales > 1)
        np.testing.assert_array_equal(oversized, np.arange(oversized[0], oversized[-1]+1))
        self.assertLess(np.abs(scales[17:]-1).max(), .002)
        self.assertLess(abs(scales[-2]-1), .00001)
        rise = np.array([f["headTranslation"][1] for f in frames])
        self.assertGreaterEqual(rise.min(), -3)
        self.assertLess(rise.min(), -2.8)
        self.assertLess(rise.max(), .7)
        summary = self.track["springMotion"]
        self.assertAlmostEqual(summary["maxCompressionPercent"], (1-scales.min())*100, places=5)
        self.assertAlmostEqual(summary["maxOversizePercent"], (scales.max()-1)*100, places=5)
        self.assertEqual(summary["compressionPeakFrame"], int(scales.argmin()))
        self.assertEqual(summary["reboundPeakFrame"], int(scales.argmax()))
        self.assertAlmostEqual(summary["compressionPeakMs"], times[scales.argmin()]*800, places=5)
        self.assertAlmostEqual(summary["reboundPeakMs"], times[scales.argmax()]*800, places=5)
        for frame in frames:
            actual = spring.physics(frame["sampleTime"])
            expected = {key: frame[key] for key in actual}
            for key in actual:
                np.testing.assert_allclose(actual[key], expected[key], rtol=0, atol=1e-14)

    def test_eye_pulse_preserves_approved_target_and_relaxes_before_rest(self):
        original = json.loads((spring.OUTPUT / "animation.candidate.json").read_text())
        targets = original["directions"]["surprise"]["frames"][-1]["eyes"]
        self.assertEqual(self.track["targetEyes"], targets)
        strength = np.array([f["strength"] for f in self.track["frames"]])
        peak = int(strength.argmax())
        self.assertTrue(.15 <= peak/23 <= .20)
        self.assertEqual(strength[peak], 1)
        self.assertEqual(self.track["frames"][peak]["eyeLocalBounds"], targets)
        self.assertTrue(np.all(np.diff(strength[:peak+1]) > 0))
        self.assertTrue(np.all(np.diff(strength[peak:]) < 0))
        self.assertLess(strength[1], .3)
        self.assertLess(strength[20], .003)

    def test_only_eye_lights_change_before_one_uniform_whole_image_transform(self):
        original = np.asarray(self.neutral)
        permitted = np.zeros(original.shape[:2], dtype=bool)
        for x0,y0,x1,y1 in self.track["eyeRegions"]:
            permitted[y0:y1,x0:x1] = True
        self.assertLess(permitted.mean(), .1)
        for frame in self.track["frames"]:
            with self.subTest(frame=frame["file"]):
                t = frame["sampleTime"]
                local = render(self.neutral, self.reference["eyes"],
                               self.track["targetEyes"], frame["strength"])
                np.testing.assert_array_equal(np.asarray(local)[~permitted], original[~permitted])
                matrix = spring.spring_matrix(self.neutral.size, t)
                linear = matrix[:2,:2]
                np.testing.assert_allclose(linear.T @ linear,
                                           np.eye(2)*frame["headScale"]**2, atol=1e-13)
                self.assertAlmostEqual(np.linalg.det(linear), frame["headScale"]**2)
                self.assertGreater(np.linalg.det(linear), 0)
                np.testing.assert_allclose(matrix, frame["headTransform"], atol=1e-14)
                self.assertLessEqual(abs(frame["headRotationDegrees"]), 1)
                actual = np.asarray(Image.open(spring.OUTPUT / frame["file"]).convert("RGB"))
                expected = spring.render_frame(self.neutral, self.reference["eyes"],
                                               self.track["targetEyes"], t)
                np.testing.assert_array_equal(actual, np.asarray(expected))
                self.assertEqual(spring.digest(spring.OUTPUT / frame["file"]), frame["sha256"])

    def test_unclipped_subpixel_motion_and_expression_preserving_blinks(self):
        original = np.asarray(self.neutral)
        yy, xx = np.nonzero(original.max(axis=-1) > 32)
        points = np.stack((xx+.5, yy+.5, np.ones_like(xx)))
        previous = points[:2].copy()
        motions = []
        for index, frame in enumerate(self.track["frames"]):
            matrix = spring.spring_matrix(self.neutral.size, frame["sampleTime"])
            moved = (matrix @ points)[:2]
            motions.append(float(np.linalg.norm(moved-previous, axis=0).max()))
            previous = moved
            self.assertTrue(np.all(moved > 3))
            self.assertTrue(np.all(moved[0] < self.neutral.width-3))
            self.assertTrue(np.all(moved[1] < self.neutral.height-3))
            actual = np.asarray(Image.open(spring.OUTPUT / frame["file"]).convert("RGB"))
            self.assertFalse(actual[:3].any() or actual[-3:].any()
                             or actual[:,:3].any() or actual[:,-3:].any())
            if index not in (0,23):
                for filename in frame["blinks"]:
                    self.assertEqual((spring.OUTPUT / filename).read_bytes(),
                                     (spring.OUTPUT / frame["file"]).read_bytes())
        self.assertLess(motions[1], 3.1, "The first contact sample must not snap.")
        self.assertLess(max(motions), 5.1)
        self.assertLess(motions[-1], .01)

    def test_other_tracks_originals_and_old_smooth_art_are_untouched(self):
        current = {name: track for name, track in self.manifest["directions"].items()
                   if name != "surprise"}
        self.assertEqual(current, self.preservation["otherTracks"])
        self.assertIn("attention_alternate", current)
        self.assertEqual(spring.digest(spring.APPROVED / "animation.json"),
                         self.preservation["approvedManifestSha256"])
        for filename, expected in self.preservation["originalPngSha256"].items():
            self.assertEqual(spring.digest(spring.OUTPUT / filename), expected, filename)
        for prefix in ("surprise", "surprise-smooth"):
            for index in range(24):
                for suffix in ("", "-blink-1", "-blink-2", "-blink-3", "-blink-4"):
                    self.assertIn(f"{prefix}-{index:02d}{suffix}.png",
                                  self.preservation["originalPngSha256"])

    def test_local_recipe_and_preview_provenance(self):
        recipe = json.loads((ROOT / self.track["generationProvenance"]).read_text())
        self.assertEqual(recipe["sha256"], spring.digest(spring.OUTPUT / self.track["source"]))
        self.assertEqual(self.track["sourceSha256"], recipe["sha256"])
        self.assertEqual(recipe["scriptSha256"], spring.digest(ROOT / recipe["script"]))
        self.assertEqual(recipe["springMotion"], self.track["springMotion"])
        for path, expected in recipe["helperSha256"].items():
            self.assertEqual(spring.digest(ROOT / path), expected)
        for path, expected in recipe["sourcePngSha256"].items():
            self.assertEqual(spring.digest(ROOT / path), expected)
        self.assertEqual(spring.digest(ROOT / recipe["originalReactionManifest"]),
                         recipe["originalReactionManifestSha256"])
        self.assertEqual(self.track, json.loads((spring.REVIEW / f"{spring.PREFIX}.json").read_text()))
        with Image.open(spring.REVIEW / f"{spring.PREFIX}-animation.webp") as image:
            self.assertEqual(image.size, self.neutral.size)
            self.assertEqual(image.n_frames, 24)
        with Image.open(spring.REVIEW / f"{spring.PREFIX}-contact.png") as image:
            self.assertEqual(image.size, (self.neutral.width*6, (self.neutral.height+30)*4))

    def test_standard_publisher_uses_spring_and_retains_alternate_attention_hook(self):
        import alternate_attention
        import prepare_generated_expressions as prepare
        import smooth_surprise
        frame = dict(file="unused.png", blinks=["unused-blink.png"], sha256="test")
        candidate = dict(
            approvedSpriteManifestSha256="test",
            directions={name: dict(frames=[copy.deepcopy(frame)])
                        for name in ("surprise", "working", "complete", "attention")},
        )
        alternate = self.manifest["directions"]["attention_alternate"]
        # Exercise the publishing hook without reading/writing any images,
        # manifest, or other agents' generated tracks.
        with mock.patch.object(Path, "read_text", return_value=json.dumps(candidate)), \
                mock.patch.object(Path, "write_text") as write, \
                mock.patch.object(prepare, "digest", return_value="test"), \
                mock.patch.object(prepare.Image, "open") as image, \
                mock.patch.object(spring, "build_track", return_value=self.track) as build, \
                mock.patch.object(alternate_attention, "build_track", return_value=alternate) as other, \
                mock.patch.object(smooth_surprise, "build_track", side_effect=AssertionError("Legacy surprise restored")):
            image.return_value.__enter__.return_value.size = (240,224)
            prepare.publish_reviewed()
            build.assert_called_once_with()
            other.assert_called_once_with()
            published = json.loads(write.call_args.args[0])
            self.assertEqual(published["directions"]["surprise"], self.track)
            self.assertEqual(published["directions"]["attention_alternate"], alternate)

    def test_invalid_times_rejected(self):
        for t in (-.01, 1.01, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                spring.physics(t)


if __name__ == "__main__":
    unittest.main()

from pathlib import Path
import hashlib
import json
import select
import subprocess
import unittest

from tools.serve_preview import NativeCharacterRenderer, RendererSessions

ROOT = Path(__file__).resolve().parents[1]
EXE = ROOT / "build/character-preview"


class CharacterPreviewTests(unittest.TestCase):
    def create(self):
        renderer = NativeCharacterRenderer(EXE)
        self.addCleanup(renderer.close)
        return renderer

    def test_native_pixels_pause_and_session_isolation(self):
        sessions = RendererSessions(EXE, NativeCharacterRenderer)
        self.addCleanup(sessions.close_all)
        first, second = sessions.get("character-one"), sessions.get("character-two")
        before, metadata = first.frame({"delta": 0, "playing": False, "character": "copilot"})
        self.assertEqual(len(before), 383984)
        self.assertEqual(metadata["index"], "0")
        self.assertEqual(metadata["mode"], "0")
        self.assertTrue(any(before))
        stride = 412 * 2
        art = before[57*stride:409*stride]
        assets = json.loads((ROOT / "characters/copilot/frames.json").read_text())
        self.assertEqual(hashlib.sha256(art).hexdigest(),
                         assets["centerRgb565Sha256"][0])
        self.assertEqual(before[:57*stride], bytes(57*stride))
        self.assertEqual(before[409*stride:], bytes(57*stride))
        for y in range(57, 409):
            self.assertEqual(before[y*stride:y*stride+12], bytes(12))
            self.assertEqual(before[y*stride+812:(y+1)*stride], bytes(12))
        for _ in range(90):
            second.frame({"delta": 1 / 30})
        after, paused = first.frame({"delta": 1000, "playing": False})
        self.assertEqual(before, after)
        self.assertEqual(paused["index"], "0")
        self.assertEqual(paused["effectSeconds"], metadata["effectSeconds"])
        self.assertIs(sessions.get("character-one"), first)

    def test_expression_availability_or_full_native_handoffs(self):
        renderer = self.create()
        before, info = renderer.frame({})
        if int(info["availableDirections"]) < 13:
            for mode in range(1, 5):
                with self.assertRaisesRegex(ValueError, "Expression assets unavailable"):
                    renderer.frame({"mode": mode})
                after, current = renderer.frame({})
                self.assertEqual(before, after)
                self.assertEqual(current["eventId"], "0")
            _, sleeping = renderer.frame({"mode": 5, "delta": 1 / 30})
            self.assertEqual(sleeping["requestedMode"], "5")
            return
        for mode in (5, 4, 1, 2, 3, 0):
            _, current = renderer.frame({"mode": mode, "delta": 1 / 30})
            previous = current
            for _ in range(240):
                pixels, current = renderer.frame({"delta": 1 / 30})
                self.assertEqual(len(pixels), 383984)
                spring_handoff = (previous["mode"], previous["direction"], previous["index"],
                                  current["index"]) == ("1", "8", "23", "0")
                if not spring_handoff:
                    self.assertLessEqual(abs(int(current["index"]) - int(previous["index"])), 1)
                if current["direction"] != previous["direction"]:
                    self.assertEqual(current["index"], "0")
                    self.assertTrue(previous["index"] == "0" or spring_handoff)
                previous = current
            expected = 4 if mode == 1 else 0 if mode == 3 else mode
            self.assertEqual(int(current["mode"]), expected)

    def test_spring_settles_to_identical_neutral_within_one_second(self):
        renderer = self.create()
        pixels, state = renderer.frame({"mode": 1, "delta": 1/30})
        frames = []
        previous = None
        for _ in range(27):
            if state["mode"] != "1":
                self.assertEqual(state["mode"], "0")
                self.assertEqual(pixels, previous, "Final spring sample is exactly the idle handoff")
                break
            self.assertEqual(state["direction"], "8")
            frames.append(int(state["index"]))
            previous = pixels
            pixels, state = renderer.frame({"delta": 1/30})
        else:
            self.fail("Spring reaction took longer than 0.9 seconds")
        self.assertEqual(frames, list(range(24)))

    def test_validation_and_bounded_sessions(self):
        renderer = self.create()
        for payload in ([], {"delta": True}, {"delta": float("nan")}, {"delta": -1},
                        {"delta": 86401}, {"mode": True}, {"mode": 6}, {"mode": -2},
                        {"playing": 1}, {"playing": "false"}, {"character": "other"},
                        {"character": 1}, {"direction": True}, {"direction": -2},
                        {"direction": 8}):
            with self.assertRaises(ValueError):
                renderer.frame(payload)
        self.assertTrue(renderer.lock.acquire(False))
        try:
            with self.assertRaisesRegex(RuntimeError, "in flight"):
                renderer.frame({})
        finally:
            renderer.lock.release()
        sessions = RendererSessions(EXE, NativeCharacterRenderer)
        self.addCleanup(sessions.close_all)
        for i in range(8):
            sessions.get(f"tab-{i}")
        with self.assertRaises(RuntimeError):
            sessions.get("ninth-tab")
        for session in (None, [], "../escape", "x" * 65):
            with self.assertRaises(ValueError):
                sessions.get(session)
        sessions.close("tab-0")
        sessions.get("replacement")
        processes = [instance.process for instance in sessions.instances.values()]
        sessions.close_all()
        self.assertTrue(all(process.poll() is not None for process in processes))
        with self.assertRaisesRegex(RuntimeError, "shutting down"):
            sessions.get("too-late")

    def test_native_protocol_rejects_malformed_commands_without_desync(self):
        renderer = self.create()
        for line in (b"nan -1 1 0 -1\n", b"0 4 9 0 -1\n", b"0 1e90 1 0 -1\n",
                     b"0 0.5 1 0 -1\n", b"0 -1 1 2 -1\n", b"0 -1 1 0 8\n",
                     b"0 -1 1 0 -1 extra\n", b"hello\n"):
            renderer.process.stdin.write(line)
            self.assertTrue(select.select([renderer.process.stdout], [], [], 5)[0])
            self.assertTrue(renderer.process.stdout.readline().startswith(b"ERR "))
        pixels, _ = renderer.frame({})
        self.assertEqual(len(pixels), 383984)
        process = subprocess.Popen([str(EXE)], stdin=subprocess.PIPE, stdout=subprocess.PIPE)
        output, _ = process.communicate(b"x" * 300 + b"\n", timeout=5)
        self.assertIn(b"exceeds 255 bytes", output)
        self.assertEqual(process.returncode, 1)

    def test_openclaw_sprite_pack_supports_all_modes_and_directional_idle(self):
        renderer = self.create()
        copilot, _ = renderer.frame({"playing": False, "character": "copilot"})
        center, metadata = renderer.frame({"playing": False, "character": "openclaw"})
        self.assertEqual(len(center), 383984)
        self.assertTrue(any(center))
        self.assertNotEqual(center, copilot)
        repeated, _ = renderer.frame({"playing": False, "character": "openclaw"})
        self.assertEqual(center, repeated)
        self.assertEqual(metadata["mode"], "0")
        renderer.frame({
            "mode": 0, "direction": 0, "playing": True,
            "character": "openclaw", "delta": 1 / 30,
        })
        for _ in range(120):
            _, wave = renderer.frame({
                "playing": True, "character": "openclaw", "delta": 1 / 30,
            })
            if wave["direction"] == "0" and int(wave["index"]) > 0:
                break
        else:
            self.fail("Explicit OpenClaw wave preview did not enter the right-hand track")
        for mode in range(6):
            pixels, current = renderer.frame(
                {"mode": mode, "delta": 1 / 30, "character": "openclaw"})
            self.assertEqual(len(pixels), 383984)
            self.assertTrue(any(pixels))
            self.assertEqual(current["requestedMode"], str(mode))

        renderer = self.create()
        center, _ = renderer.frame({"playing": False, "character": "openclaw"})
        renderer.frame({"playing": True, "character": "openclaw"})
        turns = {}
        for _ in range(2400):
            pixels, state = renderer.frame({"delta": 1 / 30, "character": "openclaw"})
            direction = int(state["direction"])
            if int(state["index"]) >= 8 and direction in (0, 1):
                turns.setdefault(direction, pixels)
            if len(turns) == 2:
                break
        self.assertEqual(set(turns), {0, 1})
        self.assertNotEqual(turns[0], center)
        self.assertNotEqual(turns[1], center)
        self.assertNotEqual(turns[0], turns[1])

    def test_switching_from_openclaw_clears_pixels_outside_copilot_art(self):
        clean = self.create()
        expected = [clean.frame({
            "playing": False, "character": "copilot", "delta": 0,
        })[0] for _ in range(2)]

        renderer = self.create()
        for _ in range(2):
            renderer.frame({"playing": False, "character": "copilot", "delta": 0})
        for _ in range(2):
            renderer.frame({"playing": False, "character": "openclaw", "delta": 0})
        actual = [renderer.frame({
            "playing": False, "character": "copilot", "delta": 0,
        })[0] for _ in range(2)]

        self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()

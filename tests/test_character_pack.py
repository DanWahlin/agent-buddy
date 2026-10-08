import hashlib
from pathlib import Path
import struct
import sys
import unittest
import unittest.mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

import character_pack as packs


class CharacterPackTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.paths = packs.build()
        cls.copilot = (ROOT / "build/characters/copilot.acpk").read_bytes()
        cls.openclaw = (ROOT / "build/characters/openclaw.acpk").read_bytes()

    def test_built_in_packs_wrap_the_validated_exports_unchanged(self):
        copilot = packs.decode(self.copilot, 0xDE0000)
        openclaw = packs.decode(self.openclaw, 0xDE0000)
        self.assertEqual((copilot["id"], copilot["name"], copilot["layout"]),
                         ("copilot", "Copilot", packs.LAYOUT_BASE_PATCH))
        self.assertEqual((openclaw["id"], openclaw["name"], openclaw["layout"]),
                         ("openclaw", "OpenClaw", packs.LAYOUT_FULL_FRAME))
        for pack, source in ((self.copilot, ROOT / "characters/copilot/frames.bin"),
                             (self.openclaw, ROOT / "characters/openclaw/frames.bin")):
            data_offset, data_bytes = struct.unpack_from("<II", pack, 140)
            self.assertEqual(pack[data_offset:data_offset + data_bytes], source.read_bytes())
        self.assertEqual(struct.unpack_from("<BBHB", self.openclaw, 74), (9, 23, 1200, 1))
        self.assertEqual(struct.unpack_from("<H", self.openclaw, 72)[0], 1300)

    def test_build_is_deterministic_and_emits_host_symbols(self):
        before = {path: path.stat().st_mtime_ns for path in self.paths.values()}
        with unittest.mock.patch("builtins.print"):
            packs.build()
        self.assertEqual({path: path.stat().st_mtime_ns for path in self.paths.values()}, before)
        assembly = (ROOT / packs.HOST_ASSEMBLY).read_text()
        for symbol in ("kCopilotPack", "kCopilotPackEnd", "kOpenClawPack", "kOpenClawPackEnd"):
            self.assertIn(f"{symbol}:", assembly)

    def test_digest_covers_everything_except_its_own_field(self):
        hashed = bytearray(self.copilot)
        hashed[160:192] = bytes(32)
        self.assertEqual(self.copilot[160:192], hashlib.sha256(hashed).digest())
        for offset in (0, 20, 300, len(self.copilot) - 1):
            with self.subTest(offset=offset):
                changed = bytearray(self.copilot)
                changed[offset] ^= 1
                with self.assertRaises(packs.PackError):
                    packs.decode(bytes(changed))

    def test_rejects_oversized_truncated_and_unsupported_packs(self):
        with self.assertRaisesRegex(packs.PackError, "exceeds"):
            packs.decode(self.copilot, len(self.copilot) - 1)
        with self.assertRaisesRegex(packs.PackError, "size"):
            packs.decode(self.copilot[:-1])
        with self.assertRaisesRegex(packs.PackError, "shorter"):
            packs.decode(self.copilot[:100])
        for offset, value, message in ((13, 12, "animation model"), (12, 3, "track layout|layout"),
                                       (82, 24, "track layout")):
            changed = bytearray(self.copilot)
            changed[offset] = value
            with self.subTest(offset=offset), self.assertRaisesRegex(packs.PackError, message):
                packs.decode(bytes(changed))

    def test_base_patch_walk_cycles_must_fit_their_track(self):
        def walk(direction, frames, first):
            changed = bytearray(self.copilot)
            struct.pack_into("<BBHB", changed, 74, direction, frames, 1150, first)
            changed[160:192] = packs.digest(bytes(changed))
            return bytes(changed)
        self.assertEqual(packs.decode(walk(9, 23, 1))["id"], "copilot")
        with self.assertRaisesRegex(packs.PackError, "walk cycle"):
            packs.decode(walk(2, 12, 1))

    def test_packs_embed_an_idle_thumbnail_the_firmware_ignores(self):
        for pack in (self.copilot, self.openclaw):
            offset, size = struct.unpack_from("<II", pack, 148)
            table_offset, table_bytes, data_offset = struct.unpack_from("<III", pack, 132)
            self.assertEqual(offset, table_offset + table_bytes)
            self.assertLessEqual(offset + size, data_offset)
            image = pack[offset:offset + size]
            self.assertTrue(image.startswith(packs.PNG_SIGNATURE))
            self.assertEqual(struct.unpack(">II", image[16:24]), (206, 176))
            self.assertGreater(packs.decode(pack)["thumbnail_bytes"], 1000)
        with self.assertRaises(packs.PackError):
            packs.encode("valid", "Name", packs.LAYOUT_FULL_FRAME, b"", b"x", thumbnail=b"not png")
        changed = bytearray(self.copilot)
        struct.pack_into("<I", changed, 152, 10 ** 7)
        changed[160:192] = packs.digest(bytes(changed))
        with self.assertRaisesRegex(packs.PackError, "thumbnail"):
            packs.decode(bytes(changed))

    def test_thumbnails_center_the_visible_character(self):
        width, height = packs.WIDTH, packs.HEIGHT
        frame = bytearray(width * height * 2)
        for y in range(10, 60):
            for x in range(300, 380):
                frame[(y * width + x) * 2:(y * width + x) * 2 + 2] = b"\xff\xff"
        centered = packs.centered_frame(bytes(frame))
        lit = [(i // 2 % width, i // 2 // width) for i in range(0, len(centered), 2) if centered[i]]
        xs, ys = [x for x, _ in lit], [y for _, y in lit]
        self.assertEqual(len(lit), 80 * 50)
        self.assertLessEqual(abs(min(xs) - (width - 1 - max(xs))), 1)
        self.assertLessEqual(abs(min(ys) - (height - 1 - max(ys))), 1)
        blank = bytes(width * height * 2)
        self.assertEqual(packs.centered_frame(blank), blank)

    def test_encoder_validates_identity(self):
        for pack_id in ("", "Copilot", "-copilot", "x" * 17):
            with self.subTest(pack_id=pack_id), self.assertRaises(packs.PackError):
                packs.encode(pack_id, "Name", packs.LAYOUT_FULL_FRAME, b"", b"x")
        with self.assertRaises(packs.PackError):
            packs.encode("valid", "\u00e9", packs.LAYOUT_FULL_FRAME, b"", b"x")

    def test_validate_command(self):
        with unittest.mock.patch("builtins.print") as printed:
            self.assertEqual(packs.main(["validate", str(ROOT / "build/characters/openclaw.acpk")]), 0)
        self.assertIn('"id": "openclaw"', printed.call_args[0][0])


if __name__ == "__main__":
    unittest.main()

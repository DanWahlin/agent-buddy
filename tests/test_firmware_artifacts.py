import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock
from tools.firmware_artifacts import (BINARIES, BUNDLE, INPUTS, artifacts, binaries, check, layout,
                                     record, snapshot)


class FirmwareBundleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.put("firmware/AgentCompanion/partitions.csv",
                 "otadata,data,ota,0xE000,0x2000,\napp0,app,ota_0,0x10000,0x200000,\n"
                 "app1,app,ota_1,0x210000,0x200000,\nassets,data,0x40,0x410000,0xBE0000,\n")
        self.put("firmware/AgentCompanion/AgentCompanion.ino", "void setup() {}")
        self.put("build/characters/copilot.acpk", b"default character pack")
        for path in BINARIES:
            self.put(path, b"compiled")

    def put(self, path, value):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(value.encode() if isinstance(value, str) else value)

    def test_matching_bundle(self):
        snapshot(self.root)
        record(self.root)
        check(self.root)
        self.assertEqual(layout(self.root)[1]["offset"], 0x410000)

    def test_records_portable_paths(self):
        # A bundle recorded under WSL or CI must still pass check on Windows, and vice versa.
        snapshot(self.root)
        record(self.root)
        bundle = json.loads((self.root / BUNDLE).read_text())
        self.assertIn("firmware/AgentCompanion/AgentCompanion.ino", bundle["inputs"]["files"])
        for key in [*bundle["inputs"]["files"], *bundle["binaries"]]:
            self.assertNotIn("\\", key)

    def test_records_the_board_and_rejects_a_different_board(self):
        snapshot(self.root)
        record(self.root)
        bundle = json.loads((self.root / BUNDLE).read_text())
        self.assertEqual(bundle["inputs"]["board"], "waveshare-amoled-175")
        bundle["inputs"]["board"] = "other-board"
        self.put(BUNDLE, json.dumps(bundle))
        with self.assertRaisesRegex(ValueError, "built for board other-board"):
            check(self.root)

    def test_each_board_builds_in_its_own_folder(self):
        # The default board keeps build/firmware, which release packaging reads.
        self.assertEqual(artifacts("waveshare-amoled-175"), (Path("build/firmware"), INPUTS, BUNDLE))
        build, _, bundle_path = artifacts("waveshare-lcd-154")
        self.assertEqual(build, Path("build/firmware-waveshare-lcd-154"))
        for path in binaries(build):
            self.put(path, b"compiled for the LCD")
        with mock.patch.dict(os.environ, {"BOARD": "waveshare-lcd-154"}):
            snapshot(self.root)
            record(self.root)
            check(self.root)
        bundle = json.loads((self.root / bundle_path).read_text())
        self.assertEqual(bundle["inputs"]["board"], "waveshare-lcd-154")
        self.assertIn("build/firmware-waveshare-lcd-154/AgentCompanion.ino.bin", bundle["binaries"])
        self.assertFalse((self.root / BUNDLE).exists())

    def test_unknown_board_is_rejected(self):
        with mock.patch.dict(os.environ, {"BOARD": "no-such-board"}), \
                self.assertRaisesRegex(ValueError, "Unknown board"):
            snapshot(self.root)

    def test_source_changed_during_build(self):
        snapshot(self.root)
        self.put("firmware/AgentCompanion/AgentCompanion.ino", "changed")
        with self.assertRaisesRegex(ValueError, "during compilation"):
            record(self.root)

    def test_rejects_stale_source_or_binaries(self):
        snapshot(self.root)
        record(self.root)
        self.put(BINARIES[0], b"other binary")
        with self.assertRaisesRegex(ValueError, "artifacts changed"):
            check(self.root)
        self.put(BINARIES[0], b"compiled")
        self.put("firmware/AgentCompanion/AgentCompanion.ino", "changed")
        with self.assertRaisesRegex(ValueError, "since compilation"):
            check(self.root)

    def test_default_pack_is_part_of_the_matched_set(self):
        snapshot(self.root)
        record(self.root)
        self.put("build/characters/copilot.acpk", b"different pack")
        with self.assertRaisesRegex(ValueError, "default character changed"):
            check(self.root)
        self.put("build/characters/copilot.acpk", b"")
        with self.assertRaisesRegex(ValueError, "empty or exceeds"):
            snapshot(self.root)

    def test_rejects_oversized_app(self):
        snapshot(self.root)
        self.put(BINARIES[0], b"\0" * (0x200000 + 1))
        with self.assertRaisesRegex(ValueError, "exceeds"):
            record(self.root)

    def test_rejects_partition_overlap(self):
        self.put("firmware/AgentCompanion/partitions.csv",
                 "otadata,data,ota,0xE000,0x2000,\napp0,app,ota_0,0x10000,0x200000,\n"
                 "app1,app,ota_1,0x210000,0x200000,\nassets,data,0x40,0x400000,0xBE0000,\n")
        with self.assertRaisesRegex(ValueError, "overlap"):
            layout(self.root)

    def test_requires_two_matching_app_slots(self):
        # Without a second slot of the same size, an update over Wi-Fi has nowhere to go.
        self.put("firmware/AgentCompanion/partitions.csv",
                 "factory,app,factory,0x10000,0x200000,\nassets,data,0x40,0x210000,0xDE0000,\n")
        with self.assertRaisesRegex(ValueError, "required"):
            layout(self.root)
        self.put("firmware/AgentCompanion/partitions.csv",
                 "otadata,data,ota,0xE000,0x2000,\napp0,app,ota_0,0x10000,0x200000,\n"
                 "app1,app,ota_1,0x210000,0x100000,\nassets,data,0x40,0x410000,0xBE0000,\n")
        with self.assertRaisesRegex(ValueError, "match app0"):
            layout(self.root)


if __name__ == "__main__":
    unittest.main()

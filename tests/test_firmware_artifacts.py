from pathlib import Path
import tempfile
import unittest
from tools.firmware_artifacts import BINARIES, check, layout, record, snapshot


class FirmwareBundleTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.put("firmware/AgentCompanion/partitions.csv",
                 "factory,app,factory,0x10000,0x200000,\nassets,data,0x40,0x210000,0xDE0000,\n")
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
        self.assertEqual(layout(self.root)[1]["offset"], 0x210000)

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
                 "factory,app,factory,0x10000,0x200000,\nassets,data,0x40,0x200000,0xDE0000,\n")
        with self.assertRaisesRegex(ValueError, "overlap"):
            layout(self.root)


if __name__ == "__main__":
    unittest.main()

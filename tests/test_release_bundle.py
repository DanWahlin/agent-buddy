import contextlib
import importlib.metadata
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

from tools import character_pack, firmware_artifacts, flash_release, package_release

ROOT = Path(__file__).resolve().parents[1]


def tiny_pack(pack_id):
    """A minimal valid pack: every frame references the same one-byte block."""
    if pack_id == "copilot":
        table = character_pack.PATCH_FRAME.pack(0, 1, 0, 0, 0, 0, *([0] * 8)) * 288
        return character_pack.encode("copilot", "Copilot", character_pack.LAYOUT_BASE_PATCH,
                                     table, b"x", base=(0, 0, 1, 1), max_patch_pixels=1)
    table = character_pack.BLOCK.pack(0, 1) * (13 * 24 * 5)
    return character_pack.encode(pack_id, "OpenClaw", character_pack.LAYOUT_FULL_FRAME, table, b"y")


class ReleaseBundleTests(unittest.TestCase):
    def setUp(self):
        fixtures = ROOT / "build/test-fixtures"
        fixtures.mkdir(parents=True, exist_ok=True)
        directory = tempfile.TemporaryDirectory(dir=fixtures)
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.put("firmware/AgentCompanion/partitions.csv",
                 "nvs,data,nvs,0x9000,0x5000,\n"
                 "factory,app,factory,0x10000,0x200000,\n"
                 "assets,data,0x40,0x210000,0xDE0000,\n")
        self.put("firmware/AgentCompanion/AgentCompanion.ino", "void setup() {}")
        for pack_id in ("copilot", "openclaw"):
            self.put(f"build/characters/{pack_id}.acpk", tiny_pack(pack_id))
        for path in firmware_artifacts.BINARIES:
            self.put(path, b"compiled-" + path.name.encode())
        self.put("build/firmware/boot_app0.bin", b"\xff" * 8192)
        for path in ("tools/flash_release.py", "requirements-flash.txt"):
            self.put(path, (ROOT / path).read_bytes())
        firmware_artifacts.snapshot(self.root)
        firmware_artifacts.record(self.root)

    def put(self, path, value):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(value.encode() if isinstance(value, str) else value)

    def bundle(self):
        firmware, characters = package_release.package(self.root, "1.2.3")
        extracted = self.root / "extracted"
        with zipfile.ZipFile(firmware) as archive:
            archive.extractall(extracted)
        return extracted, firmware, characters

    def rehash(self, root):
        files = {name: (root / name).read_bytes() for name in flash_release.PAYLOAD_NAMES}
        (root / "SHA256SUMS").write_bytes(package_release.checksum_file(files))

    def mutate_manifest(self, root, change):
        manifest = json.loads((root / "manifest.json").read_text())
        change(manifest)
        (root / "manifest.json").write_text(json.dumps(manifest))
        self.rehash(root)

    def invoke(self, root, args):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return flash_release.main(args, root=root)

    def test_fresh_deterministic_archives_and_offline_installer(self):
        extracted, firmware, characters = self.bundle()
        original = [firmware.read_bytes(), characters.read_bytes()]
        package_release.package(self.root, "1.2.3")
        self.assertEqual(original, [firmware.read_bytes(), characters.read_bytes()])
        self.assertEqual(firmware.name, "esp32-agent-companion-v1.2.3-firmware.zip")
        self.assertEqual(characters.name, "esp32-agent-companion-v1.2.3-characters.zip")
        with zipfile.ZipFile(firmware) as archive:
            self.assertEqual(set(archive.namelist()), {*flash_release.PAYLOAD_NAMES, "SHA256SUMS"})
            self.assertTrue(all(info.date_time == (1980, 1, 1, 0, 0, 0) for info in archive.infolist()))
        with zipfile.ZipFile(characters) as archive:
            self.assertEqual(archive.namelist(), ["copilot.acpk", "openclaw.acpk"])
            self.assertEqual(archive.read("openclaw.acpk"), tiny_pack("openclaw"))
        with zipfile.ZipFile(firmware) as archive:
            self.assertEqual(archive.read("bin/character-copilot.acpk"), tiny_pack("copilot"))
        self.assertEqual((firmware.parent / "SHA256SUMS").read_bytes(),
                         package_release.checksum_file(dict(zip((firmware.name, characters.name), original))))
        manifest = flash_release.verify_bundle(extracted)
        self.assertEqual([image["offset"] for image in manifest["images"]],
                         [0, 0x8000, 0xe000, 0x10000, 0x210000])
        self.assertEqual(manifest["images"][2]["size"], 8192)
        with mock.patch.object(flash_release, "require_dependencies", side_effect=AssertionError("dependency probe")), \
                mock.patch.object(flash_release.subprocess, "run", side_effect=AssertionError("hardware")):
            self.assertEqual(self.invoke(extracted, ["--verify-only"]), 0)
        # -S disables site packages: this really executes the standalone copy without esptool.
        result = subprocess.run([sys.executable, "-S", str(extracted / "flash.py"), "--verify-only"],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_custom_name_and_repository(self):
        firmware, characters = package_release.package(self.root, "0.0.0", name="new-name",
                                                       repository="Someone/new-name")
        self.assertEqual(characters.name, "new-name-v0.0.0-characters.zip")
        with zipfile.ZipFile(firmware) as archive:
            self.assertIn(b"github.com/Someone/new-name/releases/tag/v0.0.0", archive.read("INSTALL.txt"))
            self.assertNotIn(b"DanWahlin", archive.read("manifest.json"))
            self.assertNotIn(str(self.root).encode(), archive.read("manifest.json"))

    def test_rejects_corrupt_and_missing_files(self):
        extracted, _, _ = self.bundle()
        for filename in (*flash_release.PAYLOAD_NAMES, "SHA256SUMS"):
            with self.subTest(filename=filename):
                path = extracted / filename
                data = path.read_bytes()
                path.write_bytes(data + b"corrupt")
                with self.assertRaises((ValueError, UnicodeError)):
                    flash_release.verify_bundle(extracted)
                path.unlink()
                with self.assertRaisesRegex(ValueError, "Missing"):
                    flash_release.verify_bundle(extracted)
                path.write_bytes(data)

    def test_rejects_stale_build_and_guarded_boot_app0(self):
        for filename in ("firmware/AgentCompanion/AgentCompanion.ino", "build/firmware/boot_app0.bin"):
            with self.subTest(filename=filename):
                path = self.root / filename
                original = path.read_bytes()
                path.write_bytes(b"changed")
                with self.assertRaisesRegex(ValueError, "changed"):
                    package_release.package(self.root, "1.2.3")
                self.assertFalse((self.root / "build/release").exists())
                path.write_bytes(original)
        (self.root / "build/firmware-bundle.json").unlink()
        with self.assertRaises(FileNotFoundError):
            package_release.package(self.root, "1.2.3")

    def test_missing_binary(self):
        (self.root / "build/firmware/boot_app0.bin").unlink()
        with self.assertRaises(FileNotFoundError):
            package_release.package(self.root, "1.2.3")

    def test_rejects_unsafe_manifest_even_with_updated_checksums(self):
        extracted, _, _ = self.bundle()
        original = (extracted / "manifest.json").read_bytes()
        changes = [
            lambda m: m.update(chip="esp32"),
            lambda m: m.update(schema_version=True),
            lambda m: m.update(flash_size="8MB"),
            lambda m: m.update(version="01.2.3"),
            lambda m: m.update(asset_sha256="0" * 64),
            lambda m: m.update(images=m["images"][:-1]),
            lambda m: m["images"][0].update(file="../bootloader.bin"),
            lambda m: m["images"][0].update(file="/bin/bootloader.bin"),
            lambda m: m["images"][0].update(file=r"bin\bootloader.bin"),
            lambda m: m["images"][1].update(offset=0x9000),
            lambda m: m["images"][2].update(offset=0xd000),
            lambda m: m["images"][3].update(offset=0x20000),
            lambda m: m["images"][3].update(max_size=0x300000),
            lambda m: m["images"][4].update(offset=0x200000),
            lambda m: m["images"][4].update(offset=0x210001),
            lambda m: m["images"][4].update(max_size=0x1000000),
            lambda m: m["images"][0].update(offset=False),
            lambda m: m["images"][0].update(size=0),
            lambda m: m["images"][0].update(sha256="0" * 64),
        ]
        for index, change in enumerate(changes):
            with self.subTest(change=index):
                (extracted / "manifest.json").write_bytes(original)
                self.mutate_manifest(extracted, change)
                with self.assertRaises(ValueError):
                    flash_release.verify_bundle(extracted)

    def test_rejects_symlinks_and_unsafe_checksum_paths(self):
        extracted, _, _ = self.bundle()
        sums = extracted / "SHA256SUMS"
        original = sums.read_bytes()
        for suffix in (f"{'0' * 64}  ../outside\n", original.decode().splitlines()[0] + "\n"):
            sums.write_bytes(original + suffix.encode())
            with self.assertRaisesRegex(ValueError, "Invalid SHA256SUMS"):
                flash_release.verify_bundle(extracted)
        sums.write_bytes(original)
        target = extracted / "bin/boot_app0.bin"
        target.unlink()
        target.symlink_to(self.root / "build/firmware/boot_app0.bin")
        with self.assertRaisesRegex(ValueError, "Symlink"):
            flash_release.verify_bundle(extracted)

    def test_budget_checks(self):
        for filename, size in (("build/firmware/AgentCompanion.ino.bootloader.bin", 0x8001),
                               ("build/firmware/AgentCompanion.ino.partitions.bin", 0x1001),
                               ("build/firmware/boot_app0.bin", 0x2001)):
            with self.subTest(filename=filename):
                path = self.root / filename
                original = path.read_bytes()
                path.write_bytes(b"x" * size)
                firmware_artifacts.record(self.root)
                with self.assertRaisesRegex(ValueError, "budget"):
                    package_release.package(self.root, "1.2.3")
                path.write_bytes(original)
        self.put("build/firmware/AgentCompanion.ino.bin", b"x" * (0x200000 + 1))
        with self.assertRaisesRegex(ValueError, "exceeds"):
            firmware_artifacts.record(self.root)
        self.put("build/characters/copilot.acpk", b"x" * (0xDE0000 + 1))
        with self.assertRaisesRegex(ValueError, "exceeds the assets partition"):
            firmware_artifacts.snapshot(self.root)

    def test_rejects_invalid_or_mislabeled_character_packs(self):
        path = self.root / "build/characters/openclaw.acpk"
        path.write_bytes(path.read_bytes()[:-1] + b"z")
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            package_release.package(self.root, "1.2.3")
        path.write_bytes(tiny_pack("other"))
        with self.assertRaisesRegex(ValueError, "different id"):
            package_release.package(self.root, "1.2.3")

    def test_layout_is_read_not_reexported(self):
        self.put("firmware/AgentCompanion/partitions.csv",
                 "factory,app,factory,0x10000,0x200000,\n"
                 "assets,data,0x40,0x220000,0xDD0000,\n")
        firmware_artifacts.snapshot(self.root)
        firmware_artifacts.record(self.root)
        extracted, _, _ = self.bundle()
        image = flash_release.verify_bundle(extracted)["images"][-1]
        self.assertEqual((image["offset"], image["max_size"]), (0x220000, 0xDD0000))

    def test_file_change_during_packaging_is_rejected(self):
        original_check = firmware_artifacts.check
        calls = 0

        def change_after_first_check(root):
            nonlocal calls
            original_check(root)
            calls += 1
            if calls == 1:
                self.put("build/firmware/boot_app0.bin", b"changed")

        with mock.patch.object(firmware_artifacts, "check", side_effect=change_after_first_check):
            with self.assertRaisesRegex(ValueError, "changed"):
                package_release.package(self.root, "1.2.3")
        self.assertFalse((self.root / "build/release").exists())

    def test_invalid_names_and_versions(self):
        for version in ("v1.2.3", "1.2", "1.2.3-rc.1", "1.2.3+meta", "01.2.3", "1.2.3\n", "../1.2.3"):
            with self.subTest(version=version), self.assertRaisesRegex(ValueError, "SemVer"):
                package_release.package(self.root, version)
        for name in ("", "../bad", "UPPER", "has space", "é", "bad--slug", "-bad"):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "slug"):
                package_release.package(self.root, "1.2.3", name=name)

    def test_flash_command_confirmation_and_no_erase(self):
        extracted, _, _ = self.bundle()
        with mock.patch.object(flash_release, "require_dependencies"), \
                mock.patch.object(flash_release.subprocess, "run") as run, \
                mock.patch("builtins.input", return_value="FLASH") as confirm:
            self.assertEqual(self.invoke(extracted, ["--port", "COM7"]), 0)
            confirm.assert_called_once()
            expected = [sys.executable, "-m", "esptool", "--chip", "esp32s3", "--port", "COM7",
                        "--baud", "460800", "write-flash", "--flash-mode", "keep",
                        "--flash-freq", "keep", "--flash-size", "16MB"]
            for offset, filename in zip((0, 0x8000, 0xe000, 0x10000, 0x210000), flash_release.IMAGE_NAMES):
                expected.extend((hex(offset), str(extracted / filename)))
            run.assert_called_once_with(expected, check=True)
            self.assertNotIn("erase-flash", expected)
            self.assertNotIn("0x9000", expected)
            run.reset_mock()
            confirm.reset_mock()
            self.assertEqual(self.invoke(extracted, ["--port", "COM7", "--yes"]), 0)
            confirm.assert_not_called()
            run.assert_called_once()
            run.reset_mock()
            confirm.return_value = "no"
            self.assertEqual(self.invoke(extracted, ["--port", "COM7"]), 1)
            self.assertEqual(self.invoke(extracted, ["--yes"]), 1)
            run.assert_not_called()

    def test_validation_precedes_dependency_and_subprocess(self):
        extracted, _, _ = self.bundle()
        (extracted / "bin/application.bin").write_bytes(b"wrong")
        with mock.patch.object(flash_release, "require_dependencies") as dependencies, \
                mock.patch.object(flash_release.subprocess, "run") as run:
            self.assertEqual(self.invoke(extracted, ["--yes", "--port", "COM7"]), 1)
            dependencies.assert_not_called()
            run.assert_not_called()

    def test_missing_dependency_guidance_and_failure_status(self):
        extracted, _, _ = self.bundle()
        python_check = mock.patch.object(flash_release, "require_python")
        python_check.start()
        self.addCleanup(python_check.stop)
        with mock.patch.object(importlib.metadata, "version",
                               side_effect=importlib.metadata.PackageNotFoundError):
            with self.assertRaisesRegex(ValueError, "pip install esptool==5.3.0"):
                flash_release.require_dependencies()
            self.assertEqual(self.invoke(extracted, ["--list-ports"]), 1)
        with mock.patch.object(importlib.metadata, "version", return_value="4.8"):
            with self.assertRaisesRegex(ValueError, "5.3.0 is required"):
                flash_release.require_dependencies()
        with mock.patch.object(flash_release, "require_dependencies"), \
                mock.patch.object(flash_release.subprocess, "run", side_effect=subprocess.CalledProcessError(2, "esptool")):
            self.assertEqual(self.invoke(extracted, ["--yes", "--port", "COM7"]), 1)

    def test_old_python_gets_a_clear_upgrade_message(self):
        extracted, _, _ = self.bundle()
        with self.assertRaisesRegex(ValueError, r"Python 3\.10 or newer is required.*this is Python 3\.9"):
            flash_release.require_python((3, 9, 6))
        flash_release.require_python((3, 10, 0))
        with mock.patch.object(flash_release, "require_python",
                               side_effect=ValueError("Python 3.10 or newer is required")), \
                mock.patch.object(importlib.metadata, "version") as version:
            self.assertEqual(self.invoke(extracted, ["--list-ports"]), 1)
            version.assert_not_called()
        self.assertEqual((extracted / "requirements.txt").read_text(),
                         'esptool==5.3.0; python_version >= "3.10"\n')

    def test_list_ports_only_loads_optional_modules_for_that_action(self):
        ports = mock.Mock()
        ports.comports.return_value = [mock.Mock(device="COM7", description="USB serial")]
        serial_tools = mock.Mock(list_ports=ports)
        with mock.patch.dict(sys.modules, {"serial": mock.Mock(), "serial.tools": serial_tools}), \
                mock.patch.object(flash_release, "require_dependencies") as dependencies, \
                mock.patch.object(flash_release.subprocess, "run") as run:
            self.assertEqual(self.invoke(self.root, ["--list-ports"]), 0)
            dependencies.assert_called_once()
            ports.comports.assert_called_once()
            run.assert_not_called()

    def test_packaging_cli_reports_errors(self):
        with mock.patch.object(package_release, "ROOT", self.root), \
                contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(package_release.main(["--version", "v1.2.3"]), 1)
        self.assertIn("SemVer", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()

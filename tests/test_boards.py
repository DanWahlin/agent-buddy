import copy
import re
from pathlib import Path
import unittest

from tools import boards

ROOT = Path(__file__).resolve().parents[1]
FIRMWARE = ROOT / "firmware/AgentCompanion"


class BoardTargetTests(unittest.TestCase):
    def setUp(self):
        self.data = boards.load()

    def test_every_board_has_sources_and_a_selector_branch(self):
        # validate() checks the board folders and both selector headers.
        boards.validate(self.data)
        self.assertIn(self.data["default"], self.data["boards"])

    def test_default_board_is_the_selector_fallback(self):
        directory = self.data["boards"][self.data["default"]]["directory"]
        for header in boards.SELECTORS:
            selector = (boards.BOARD_SOURCES / header).read_text()
            fallback = selector.split("#else", 1)[1]
            self.assertIn(f'"{directory}/{header}"', fallback, header)

    def test_board_config_defines_the_shared_contract(self):
        names = ("kId", "kName", "kDisplayPanelName", "kTouchControllerName", "kDisplaySize", "kPanelSize",
                 "kDisplayCsPin", "kBrightness", "kSpiFrequency", "kAudioMclkPin", "kAudioAmplifierPin",
                 "kAudioCodecI2cAddress", "kAudioMinimumCodecVolume", "kAudioMaximumCodecVolume", "kTouchSda",
                 "kTouchScl", "kTouchInterrupt", "kTouchReset", "kTouchI2cAddress", "kTouchMirrorX",
                 "kTouchMirrorY", "kI2cFrequency", "kImuI2cAddress", "kImuName", "kBootButtonPin")
        drivers = ("TouchController", "kTouchPointCapacity", "displayBus", "displayPanel", "displayScanout",
                   "setDisplayBrightness", "beginBoard", "configureTouch", "accelerometer", "audioOutput",
                   "variant")
        # Each display bus needs its own pins: a QSPI pixel-write prefix, or a data/command pin.
        buses = {"Arduino_ESP32QSPI": ("kDisplayQspiWriteCommand", "kDisplayQspiPixelAddress"),
                 "Arduino_ESP32SPIDMA": ("kDisplayDcPin",)}
        for board_id, entry in self.data["boards"].items():
            config = (boards.BOARD_SOURCES / entry["directory"] / "BoardConfig.h").read_text()
            for name in names:
                self.assertRegex(config, rf"\b{name}\b", f"{board_id}: {name}")
            self.assertIn(f'kId[] = "{board_id}"', config)
            # Packs, layouts, and effects are drawn at 466x466 on every board; scanout fits the panel.
            self.assertIn("constexpr int kDisplaySize = 466;", config, board_id)
            includes = re.findall(r"#include\s*([<\"][^>\"]+)", config)
            self.assertLessEqual(set(includes), {"<cstdint", "<cstddef"}, "BoardConfig.h must stay free of vendor headers")
            source = (boards.BOARD_SOURCES / entry["directory"] / "BoardDrivers.h").read_text()
            for name in drivers:
                self.assertRegex(source, rf"\b{name}\b", f"{board_id}: {name}")
            used = [bus for bus in buses if re.search(rf"\b{bus}\b", source)]
            self.assertEqual(len(used), 1, f"{board_id}: one display bus")
            for name in buses[used[0]]:
                self.assertRegex(config, rf"\b{name}\b", f"{board_id}: {name}")

    def test_shared_firmware_has_no_board_pins_or_vendor_drivers(self):
        shared = [path for path in FIRMWARE.rglob("*") if path.suffix in (".ino", ".h", ".cpp")
                  and boards.BOARD_SOURCES not in path.parents and "generated" not in path.parts]
        for path in shared:
            text = path.read_text(errors="ignore")
            for pattern in (r"\bArduino_CO5300\b", r"\bArduino_ESP32QSPI\b", r"\bTouchDrvCST92xx\b",
                            r"TouchDrvCSTXXX\.hpp", r"\bCST92XX_SLAVE_ADDRESS\b", r"\bQMI8658_L_SLAVE_ADDRESS\b",
                            r"\bSensorQMI8658\b", r"\bes8311_\w+", r"ESP_I2S\.h", r"\bI2SClass\b",
                            r"\bArduino_ST7789\b", r"\bArduino_ESP32SPIDMA\b", r"\bTouchDrvCST816\b",
                            r"\bCST816_SLAVE_ADDRESS\b", r"\bESP32QSPI_SPI_HOST\b", r"\bledc\w+\(",
                            r"\bkDisplayQspi\w+", r"\bkDisplayDcPin\b"):
                self.assertNotRegex(text, pattern, path.relative_to(ROOT).as_posix())

    def test_usb_info_reply_names_the_board(self):
        # The app must install firmware only for the board the device runs. The `i` reply names it on
        # its own BOARD line, after the INFO line.
        sketch = (FIRMWARE / "AgentCompanion.ino").read_text()
        info = sketch.index('logMessage("INFO protocol=')
        board = sketch.index('logMessage("BOARD id=%s variant=%s\\n", board::kId, board::variantName(board::variant()));')
        self.assertLess(info, board)
        self.assertLess(board, sketch.index('logMessage("CHARACTER id=', info))
        self.assertNotIn("board=%s", sketch[info:board])

    def test_longest_usb_info_reply_fits_a_log_message(self):
        # logMessage() drops a message longer than its buffer, and the app finds the device only by its
        # INFO reply. Each %s field's longest value: a mode name, a 16-character pack id, a 32-byte
        # SSID in base64, a 16-digit firmware ID, and the longest board variant name.
        sketch = (FIRMWARE / "AgentCompanion.ino").read_text()
        buffer = int(re.search(r"void logMessage\(const char\* format, \.\.\.\) \{.*?char message\[(\d+)\];",
                               sketch, re.S).group(1))
        start = sketch.index('logMessage("INFO protocol=') + len("logMessage(")
        literals = re.match(r'(\s*"(?:[^"\\]|\\.)*")+', sketch[start:]).group(0)
        info = "".join(re.findall(r'"((?:[^"\\]|\\.)*)"', literals)).replace("\\n", "\n")
        variants = [variant for path in boards.BOARD_SOURCES.glob("*/Board*.h")
                    for body in re.findall(r'variantName\(Variant[^)]*\)\s*\{[^}]*', path.read_text())
                    for variant in re.findall(r'"([a-z0-9-]+)"', body)]
        longest = {"mode": 9, "requested": 9, "character": 16, "ssid_b64": 44, "firmware": 16,
                   "board_variant": max(map(len, variants))}
        length, position = 0, 0
        for match in re.finditer(r"(\w+)=%(llu|u|s)", info):
            length += match.start() - position + len(match.group(1)) + 1
            kind = match.group(2)
            if kind == "s":
                self.assertIn(match.group(1), longest, f"Give the longest value of {match.group(1)}=")
            length += 20 if kind == "llu" else 10 if kind == "u" else longest[match.group(1)]
            position = match.end()
        length += len(info) - position
        self.assertNotIn("%", info[position:])
        self.assertLess(length, buffer)

    def test_build_keeps_the_core_defines(self):
        # The ESP32 core sets -DBOARD_HAS_PSRAM in build.defines, so the board define must not replace it.
        script = (ROOT / "tools/arduino.sh").read_text()
        self.assertNotIn("build.defines", script)
        self.assertIn('compiler.cpp.extra_flags=-D$BOARD_DEFINE', script)
        self.assertIn('compiler.c.extra_flags=-D$BOARD_DEFINE', script)

    def test_build_is_reproducible(self):
        # The ESP32 core compiles __DATE__ and __TIME__ in; a fixed time keeps the firmware ID stable.
        script = (ROOT / "tools/arduino.sh").read_text()
        self.assertIn('export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}"', script)
        self.assertLess(script.index("SOURCE_DATE_EPOCH"), script.index("compile --fqbn"))

    def test_validate_rejects_inconsistent_targets(self):
        board_id = self.data["default"]
        changes = [
            lambda d: d.update(default="missing"),
            lambda d: d.update(boards={}),
            lambda d: d["boards"][board_id].update(define="WRONG"),
            lambda d: d["boards"][board_id].update(define="AGENT_BOARD_NOT_IN_SELECTOR"),
            lambda d: d["boards"][board_id].update(directory="missing_folder"),
            lambda d: d["boards"][board_id].pop("fqbn"),
            lambda d: d["boards"][board_id]["vendor"].pop("revision"),
            lambda d: d["boards"].update({"Bad_ID": d["boards"][board_id]}),
        ]
        for index, change in enumerate(changes):
            with self.subTest(change=index):
                data = copy.deepcopy(self.data)
                change(data)
                with self.assertRaises(ValueError):
                    boards.validate(data)

    def test_cli_reports_fields_and_unknown_boards(self):
        self.assertEqual(boards.main(["field", "id"]), 0)
        self.assertEqual(boards.main(["field", "fqbn", "--board", "no-such-board"]), 1)

    def test_vendor_revision_is_pinned(self):
        for entry in self.data["boards"].values():
            self.assertRegex(entry["vendor"]["revision"], r"^[0-9a-f]{40}$")


if __name__ == "__main__":
    unittest.main()

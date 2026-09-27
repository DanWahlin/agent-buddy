import time
import io
from pathlib import Path
import tempfile
import unittest
from tools.device import (NonResettingSerial, read_frame_end, parse_memory, validate_memory,
                          request_mode, capture, parse_character_status,
                          request_character_status)


class Port:
    def __init__(self, chunks):
        self.chunks = iter(chunks)

    def read_until(self, _):
        return next(self.chunks, b"")


class CharacterTelemetryTests(unittest.TestCase):
    def test_installed_and_missing_packs(self):
        status = parse_character_status("CHARACTER id=openclaw layout=full-frame bytes=10000700 name=OpenClaw")
        self.assertEqual(status, dict(id="openclaw", layout="full-frame", bytes=10000700, name="OpenClaw"))
        self.assertEqual(parse_character_status("CHARACTER id=none reason=No character pack is installed."),
                         dict(id="none", reason="No character pack is installed."))
        self.assertIsNone(parse_character_status("WIFI configured=1"))

    def test_invalid_status_fails_explicitly(self):
        for line in ("CHARACTER id=Copilot", "CHARACTER id=copilot layout=other bytes=1 name=x"):
            with self.assertRaises(RuntimeError):
                parse_character_status(line)

    def test_query_uses_only_existing_info_command(self):
        class QueryPort:
            def __init__(self):
                self.writes = []
                self.lines = iter((b"INFO protocol=5\n",
                                   b"CHARACTER id=copilot layout=base-patch bytes=9540870 name=Copilot\n"))
            def write(self, data):
                self.writes.append(data)
            def readline(self):
                return next(self.lines, b"")
        port = QueryPort()
        self.assertEqual(request_character_status(port)["id"], "copilot")
        self.assertEqual(port.writes, [b"i"])
        with self.assertRaises(TimeoutError):
            request_character_status(port, timeout=0)


class FrameProtocolTests(unittest.TestCase):
    def test_legacy_and_full_height_captures(self):
        from PIL import Image

        class CapturePort:
            def __init__(self, width, height):
                self.stream = io.BytesIO(f"FRAME_BE {width} {height} {width*height*2}\n".encode()
                                        + b"\x07\xe0" * (width*height) + b"\nEND_FRAME\n")
            def write(self, data):
                self.written = data
            def readline(self):
                return self.stream.readline()
            def read(self, count):
                return self.stream.read(count)
            def read_until(self, _):
                return self.stream.readline()

        with tempfile.TemporaryDirectory() as directory:
            for width, height in ((400, 352), (400, 466), (412, 466)):
                port = CapturePort(width, height)
                path = Path(directory) / f"{width}-{height}.png"
                capture(port, path)
                self.assertEqual(port.written, b"s")
                with Image.open(path) as image:
                    top = (466-height)//2
                    self.assertEqual(image.size, (466, 466))
                    self.assertEqual(image.getpixel((233, top)), (0, 255, 0))
                    self.assertEqual(image.getpixel((233, top+height-1)), (0, 255, 0))
                    if top:
                        self.assertEqual(image.getpixel((233, top-1)), (0, 0, 0))

    def test_monitor_does_not_drive_reset_lines(self):
        port = NonResettingSerial(port=None)
        port._update_dtr_state()
        port._update_rts_state()

    def test_lf_and_crlf(self):
        for ending in (b"\n", b"\r\n"):
            read_frame_end(Port([b"\n", b"END_FRAME" + ending]), time.monotonic() + 1)

    def test_partial_serial_reads(self):
        read_frame_end(Port([b"\nE", b"ND_", b"FRAME", b"\r\n"]), time.monotonic() + 1)

    def test_rejects_unexpected_output(self):
        with self.assertRaises(RuntimeError):
            read_frame_end(Port([b"\nCAPTURE_ERROR timed out\n"]), time.monotonic() + 1)

    def test_times_out(self):
        with self.assertRaises(TimeoutError):
            read_frame_end(Port([]), time.monotonic() - 1)


class MemoryTelemetryTests(unittest.TestCase):
    def setUp(self):
        self.sample = dict(free_internal=160000, min_internal=150000, largest_internal=100000,
                           free_psram=7812340, render_stack_free=14000, display_stack_free=4000)

    def test_complete_memory_line(self):
        line = "MEM " + " ".join(f"{key}={value}" for key, value in self.sample.items())
        self.assertEqual(parse_memory(line), self.sample)
        self.assertIsNone(parse_memory("POSE direction=1"))

    def test_malformed_or_missing_fields(self):
        for line in ("MEM free_internal=oops", "MEM free_internal=1", "MEM free_internal=-1"):
            with self.assertRaises(RuntimeError):
                parse_memory(line)

    def test_exact_stability(self):
        validate_memory([self.sample] * 3)

    def test_rejects_missing_reports(self):
        for samples in ([], [self.sample], [self.sample] * 2):
            with self.assertRaises(RuntimeError):
                validate_memory(samples)

    def test_detects_leak_or_fragmentation(self):
        for field in ("free_internal", "free_psram", "largest_internal"):
            changed = {**self.sample, field: self.sample[field] - 100}
            with self.assertRaises(RuntimeError):
                validate_memory([self.sample, self.sample, changed])
            validate_memory([self.sample, self.sample, changed], tolerance=100)

    def test_headroom_thresholds(self):
        for field, minimum in (("min_internal", 8192), ("render_stack_free", 1024), ("display_stack_free", 1024)):
            validate_memory([{**self.sample, field: minimum}] * 3)
            with self.assertRaises(RuntimeError):
                validate_memory([{**self.sample, field: minimum - 1}] * 3)


class ControlPort:
    def __init__(self, lines):
        self.lines = iter(lines)
        self.written = []

    def write(self, data):
        self.written.append(data)

    def readline(self):
        return next(self.lines)


class ModeCommandTests(unittest.TestCase):
    def test_negotiates_before_sending(self):
        port = ControlPort([b"INFO protocol=1 uptime_ms=123\n", b"COMMAND accepted=working\n"])
        request_mode(port, "working")
        self.assertEqual(port.written, [b"i", b"!working\n"])

    def test_accepts_backward_compatible_protocols(self):
        for protocol in (1, 2, 3, 4, 5, 6):
            with self.subTest(protocol=protocol):
                port = ControlPort([
                    f"INFO protocol={protocol}\n".encode(),
                    b"COMMAND accepted=surprise\n",
                ])
                request_mode(port, "surprise")
                self.assertEqual(port.written, [b"i", b"!surprise\n"])

    def test_rejects_unsupported_protocol_before_mode(self):
        port = ControlPort([b"INFO protocol=7\n"])
        with self.assertRaises(RuntimeError):
            request_mode(port, "surprise")
        self.assertEqual(port.written, [b"i"])

    def test_invalid_mode_sends_nothing(self):
        port = ControlPort([])
        with self.assertRaises(ValueError):
            request_mode(port, "working\n!complete")
        self.assertFalse(port.written)

    def test_command_rejection_is_explicit(self):
        port = ControlPort([b"INFO protocol=1\n", b"COMMAND_ERROR queue full\n"])
        with self.assertRaises(RuntimeError):
            request_mode(port, "attention")


if __name__ == "__main__":
    unittest.main()

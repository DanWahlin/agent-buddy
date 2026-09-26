#!/usr/bin/env python3
"""Bounded serial health/performance check and optional on-device framebuffer capture."""
import argparse
from pathlib import Path
import re
import time
import os
import math
if os.name == "posix":
    import termios

import serial

MEMORY_FIELDS = (
    "free_internal", "min_internal", "largest_internal", "free_psram",
    "render_stack_free", "display_stack_free",
)
CHARACTER_MODES = ("idle", "surprise", "working", "complete", "attention")

def parse_character_status(line):
    if not line.startswith("CHARACTER "):
        return None
    match = re.fullmatch(r"CHARACTER id=([a-z0-9-]+) layout=(base-patch|full-frame) bytes=(\d+) name=(.+)", line)
    if match:
        character, layout, size, name = match.groups()
        return dict(id=character, layout=layout, bytes=int(size), name=name)
    match = re.fullmatch(r"CHARACTER id=none reason=(.*)", line)
    if match:
        return dict(id="none", reason=match.group(1))
    raise RuntimeError(f"Malformed character telemetry: {line}")


def request_character_status(port, timeout=10):
    port.write(b"i")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        line = port.readline().decode("utf-8", errors="replace").strip()
        status = parse_character_status(line)
        if status is not None:
            print(line, flush=True)
            return status
        if any(marker in line for marker in ("FATAL", "Guru Meditation", "abort()")):
            raise RuntimeError(f"Character query failed: {line}")
    raise TimeoutError("No character status received; check firmware protocol 6 and boot completion.")


def request_mode(port, mode):
    if mode not in CHARACTER_MODES:
        raise ValueError(f"Unknown character mode: {mode}")
    # Negotiate before sending a packet: older firmware interprets standalone 's' as capture.
    port.write(b"i")
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        line = port.readline().decode("utf-8", errors="replace").strip()
        if line.startswith("INFO protocol="):
            match = re.match(r"INFO protocol=(\d+)(?: |$)", line)
            if not match or int(match.group(1)) not in (1, 2, 3, 4, 5):
                raise RuntimeError(f"Unsupported device command protocol: {line}")
            print(line, flush=True)
            break
        if any(marker in line for marker in ("FATAL", "Guru Meditation", "abort()")):
            raise RuntimeError(f"Device command negotiation failed: {line}")
    else:
        raise TimeoutError("Device has no compatible character-command protocol; no mode command was sent.")
    port.write(f"!{mode}\n".encode("ascii"))
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        line = port.readline().decode("utf-8", errors="replace").strip()
        if line == f"COMMAND accepted={mode}":
            print(line, flush=True)
            return
        if any(marker in line for marker in ("COMMAND_ERROR", "FATAL", "Guru Meditation", "abort()")):
            raise RuntimeError(f"Device rejected the mode command: {line}")
    raise TimeoutError(f"No acknowledgement for {mode}.")


def parse_memory(line):
    if not line.startswith("MEM "):
        return None
    fields = line.split()[1:]
    if any(re.fullmatch(r"[a-z_]+=\d+", field) is None for field in fields):
        raise RuntimeError(f"Malformed memory telemetry: {line}")
    result = {key: int(value) for key, value in (field.split("=") for field in fields)}
    if len(result) != len(fields) or set(result) != set(MEMORY_FIELDS):
        raise RuntimeError(f"Unexpected memory telemetry fields: {line}")
    return result


def validate_memory(samples, tolerance=0):
    if len(samples) < 3:
        raise RuntimeError("At least three MEM reports are required to check memory stability.")
    for field in ("free_internal", "largest_internal", "free_psram"):
        values = [sample[field] for sample in samples]
        if max(values) - min(values) > tolerance:
            raise RuntimeError(
                f"Memory varied: {field}={min(values)}..{max(values)} bytes "
                f"(allowed {tolerance}). Investigate; variation alone does not establish a leak."
            )
    for field, minimum in (("min_internal", 8192), ("render_stack_free", 1024), ("display_stack_free", 1024)):
        if min(sample[field] for sample in samples) < minimum:
            raise RuntimeError(f"Insufficient {field} headroom; require at least {minimum} bytes.")


def check_heap_integrity(port):
    port.write(b"h")
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        line = port.readline().decode("utf-8", errors="replace").strip()
        if line == "HEAP integrity=ok":
            print("PASS: on-device heap integrity", flush=True)
            return
        if any(marker in line for marker in ("FATAL", "CORRUPT", "Guru Meditation", "assert failed", "watchdog")):
            raise RuntimeError(f"Heap diagnostic failed: {line}")
    raise TimeoutError("No heap integrity acknowledgement from the device.")


class NonResettingSerial(serial.Serial):
    """Observe the ESP32 without pulsing its DTR/RTS auto-reset signals."""

    def _update_dtr_state(self):
        pass

    def _update_rts_state(self):
        pass

    def _reconfigure_port(self, force_update=False):
        super()._reconfigure_port(force_update)
        attributes = termios.tcgetattr(self.fd)
        attributes[2] &= ~termios.HUPCL
        termios.tcsetattr(self.fd, termios.TCSANOW, attributes)


def read_frame_end(port, deadline):
    pending = bytearray()
    while time.monotonic() < deadline:
        pending.extend(port.read_until(b"\n"))
        while b"\n" in pending:
            line, _, remainder = pending.partition(b"\n")
            pending = bytearray(remainder)
            token = line.strip()
            if not token:
                continue
            if token == b"END_FRAME":
                return
            raise RuntimeError(f"Unexpected framebuffer terminator: {token!r}")
    raise TimeoutError("Missing framebuffer terminator")


def capture(port, destination):
    import numpy as np
    from PIL import Image

    port.write(b"s")
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        line = port.readline()
        if line.startswith((b"CAPTURE_POSE ", b"CAPTURE_STATE ")):
            print(line.decode("ascii").strip(), flush=True)
        if line.startswith(b"FRAME_BE "):
            _, width, height, size = line.decode("ascii").split()
            width, height, size = int(width), int(height), int(size)
            if (width, height, size) not in ((400, 352, 281600), (400, 466, 372800), (412, 466, 383984)):
                raise RuntimeError(f"Unexpected framebuffer header: {line!r}")
            raw = bytearray()
            while len(raw) < size and time.monotonic() < deadline:
                raw.extend(port.read(size - len(raw)))
            if len(raw) != size:
                raise TimeoutError(f"Incomplete frame: {len(raw)}/{size} bytes")
            read_frame_end(port, deadline)
            pixels = np.frombuffer(raw, dtype=">u2").reshape(height, width).astype(np.uint32)
            rgb = np.stack([
                (pixels >> 11) * 255 // 31,
                ((pixels >> 5) & 63) * 255 // 63,
                (pixels & 31) * 255 // 31,
            ], axis=-1).astype(np.uint8)
            image = Image.new("RGB", (466, 466))
            image.paste(Image.fromarray(rgb), ((466-width)//2, (466-height)//2))
            image.save(destination)
            print(f"Captured device framebuffer: {destination}")
            return
        if b"FATAL" in line or b"Guru Meditation" in line:
            raise RuntimeError(line.decode("utf-8", errors="replace"))
    raise TimeoutError("Device did not send a framebuffer header")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", default="/dev/cu.usbmodem2101")
    parser.add_argument("--seconds", type=float, default=30)
    parser.add_argument("--min-fps", type=float, default=29)
    parser.add_argument("--capture", type=Path)
    parser.add_argument("--log", type=Path)
    parser.add_argument("--mode", choices=CHARACTER_MODES, help="Send a character event before observation.")
    parser.add_argument("--character", action="store_true",
                        help="Query the installed character pack before observation.")
    parser.add_argument("--warmup-seconds", type=float, default=0,
                        help="Log, but exclude, this initial interval before the measured interval.")
    parser.add_argument("--check-memory", action="store_true")
    parser.add_argument("--memory-tolerance", type=int, default=0,
                        help="Allowed peak-to-trough heap variation in bytes (default: exact stability).")
    parser.add_argument("--max-gap-ms", type=float, help="Maximum interval between frame presentations.")
    args = parser.parse_args()
    if not math.isfinite(args.seconds) or args.seconds < 6:
        parser.error("--seconds must be at least 6 to receive a PERF report")
    if not math.isfinite(args.min_fps) or args.min_fps <= 0:
        parser.error("--min-fps must be finite and positive.")
    if not math.isfinite(args.warmup_seconds) or args.warmup_seconds < 0 or args.memory_tolerance < 0:
        parser.error("Warmup and memory tolerance must be finite and nonnegative.")
    if args.max_gap_ms is not None and (not math.isfinite(args.max_gap_ms) or args.max_gap_ms <= 0):
        parser.error("--max-gap-ms must be finite and positive.")
    if os.name != "posix":
        parser.error("Non-resetting observation currently supports macOS and Linux.")
    port = NonResettingSerial(port=None, baudrate=115200, timeout=0.5)
    port.port = args.port
    lines, rates, memory, gaps = [], [], [], []
    try:
        port.open()
        if args.character:
            status = request_character_status(port)
            print(f"Character: {status.get('name', status['id'])}", flush=True)
        if args.mode:
            request_mode(port, args.mode)
        measured_start = time.monotonic() + args.warmup_seconds
        deadline = measured_start + args.seconds
        while time.monotonic() < deadline:
            line = port.readline().decode("utf-8", errors="replace").strip()
            if not line:
                continue
            warming = time.monotonic() < measured_start
            logged = f"[warmup] {line}" if warming else line
            print(logged, flush=True)
            lines.append(logged)
            if any(marker in line for marker in ("FATAL", "Guru Meditation", "assert failed", "Task watchdog", "abort()")):
                raise RuntimeError(f"Device runtime error: {line}")
            if warming:
                continue
            match = re.fullmatch(r"PERF fps=([\d.]+) .+", line)
            if match:
                rates.append(float(match.group(1)))
            sample = parse_memory(line)
            if sample is not None:
                memory.append(sample)
            match = re.fullmatch(r"PACING min_gap_us=(\d+) max_gap_us=(\d+)", line)
            if match:
                gaps.append(int(match.group(2)))
        if not rates:
            raise RuntimeError("No PERF reports received; device operation is not verified.")
        if min(rates) < args.min_fps:
            raise RuntimeError(f"Measured {min(rates):.1f} fps, below {args.min_fps:.1f} fps threshold.")
        if args.max_gap_ms is not None:
            if not gaps:
                raise RuntimeError("No PACING telemetry received.")
            if max(gaps) > args.max_gap_ms * 1000:
                raise RuntimeError(f"Frame presentation gap {max(gaps) / 1000:.3f} ms exceeds {args.max_gap_ms:.3f} ms.")
            print(f"PASS: maximum presentation gap {max(gaps) / 1000:.3f} ms")
        if args.check_memory:
            validate_memory(memory, args.memory_tolerance)
            print(f"PASS: {len(memory)} stable memory reports; sufficient internal heap and stack headroom")
            check_heap_integrity(port)
        print(f"PASS: {len(rates)} reports, {min(rates):.1f}-{max(rates):.1f} fps")
        if args.capture:
            capture(port, args.capture)
    finally:
        port.close()
        if args.log:
            args.log.write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()

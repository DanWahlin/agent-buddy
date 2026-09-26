#!/usr/bin/env python3
"""Local interactive UI backed by the exact native firmware motion/renderer."""
import argparse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import os
import re
from pathlib import Path
import select
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]

def available_characters():
    results = []
    for manifest in sorted((ROOT / "characters").glob("*/character.json")):
        try:
            record = json.loads(manifest.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        pack_id = record.get("id")
        name = record.get("name")
        if isinstance(pack_id, str) and isinstance(name, str):
            results.append({"id": pack_id, "name": name})
    return results


def available_character_ids():
    return {record["id"] for record in available_characters()}


def build_renderer():
    subprocess.run([sys.executable, str(ROOT / "characters/copilot/legacy-atlas/tools/embed_atlas.py")], check=True)
    sources = ROOT / "firmware/AgentCompanion/src"
    executable = ROOT / "build/live-preview"
    subprocess.run([
        "clang++", "-std=c++17", "-O3", "-Wall", "-Wextra", "-Werror",
        str(ROOT / "characters/copilot/legacy-atlas/tools/live_preview.cpp"), str(ROOT / "characters/copilot/legacy-atlas/src/AtlasRenderer.cpp"),
        str(sources / "Motion.cpp"), str(ROOT / "characters/copilot/legacy-atlas/src/turn_atlas.cpp"),
        str(ROOT / "build/atlas_host.S"), "-lz", "-o", str(executable),
    ], check=True)
    return executable


def build_character_renderer():
    subprocess.run(["bash", str(ROOT / "tools/build_character_preview.sh")], check=True)
    return ROOT / "build/character-preview"


class NativeRenderer:
    def __init__(self, executable):
        self.process = subprocess.Popen(
            [str(executable)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)
        self.lock = threading.Lock()

    def read(self, count, deadline):
        result = bytearray()
        fd = self.process.stdout.fileno()
        while len(result) < count:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
                raise TimeoutError("Native renderer did not respond within five seconds.")
            chunk = os.read(fd, count - len(result))
            if not chunk:
                raise RuntimeError("Native renderer exited unexpectedly.")
            result.extend(chunk)
        return bytes(result)

    def frame(self, payload):
        if not isinstance(payload, dict):
            raise ValueError("Request must be a JSON object.")
        time_value = payload.get("time", 0)
        command = payload.get("command", 0)
        direction = payload.get("direction", 0)
        turn = payload.get("turn", 0)
        openness = payload.get("openness", 1)
        seed = payload.get("seed", 20260910)
        for name, value in (("time", time_value), ("turn", turn), ("openness", openness)):
            if not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"{name} must be a finite number.")
        if not 0 <= time_value <= 86400 or not 0 <= turn <= 1 or not 0 <= openness <= 1:
            raise ValueError("Time or pose parameter is out of range.")
        if type(command) is not int or not 0 <= command <= 4:
            raise ValueError("Unknown command.")
        if type(direction) is not int or not 0 <= direction < 8:
            raise ValueError("Direction must be between 0 and 7.")
        if type(seed) is not int or not 0 <= seed <= 4294967295:
            raise ValueError("Seed must be an unsigned 32-bit integer.")
        request = f"{time_value:.9f} {command} {direction} {turn:.9f} {openness:.9f} {seed}\n"
        with self.lock:
            if self.process.poll() is not None:
                raise RuntimeError("Native renderer is no longer running.")
            self.process.stdin.write(request.encode("ascii"))
            deadline = time.monotonic() + 5
            header = bytearray()
            while not header.endswith(b"\n") and len(header) < 1024:
                header.extend(self.read(1, deadline))
            fields = header.decode("ascii").strip().split()
            if len(fields) != 7 or fields[0] != "OK" or int(fields[1]) != 281600:
                raise RuntimeError(f"Native render failed: {header.decode('ascii').strip()}")
            pixels = self.read(int(fields[1]), deadline)
            return pixels, dict(direction=fields[2], turn=fields[3], openness=fields[4],
                                renderMs=fields[5], automatic=fields[6])

    def close(self):
        with self.lock:
            if self.process.poll() is None:
                self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
            finally:
                self.process.stdin.close()
                self.process.stdout.close()


class NativeCharacterRenderer(NativeRenderer):
    def frame(self, payload):
        if not isinstance(payload, dict):
            raise ValueError("Request must be a JSON object.")
        delta = payload.get("delta", 0)
        mode = payload.get("mode", -1)
        playing = payload.get("playing", True)
        character = payload.get("character", "copilot")
        direction = payload.get("direction", -1)
        if type(delta) not in (int, float) or not math.isfinite(delta) or not 0 <= delta <= 86400:
            raise ValueError("delta must be a finite number between zero and 86400.")
        if type(mode) is not int or not -1 <= mode <= 5:
            raise ValueError("Character mode must be -1 (unchanged) or 0..5.")
        if type(playing) is not bool:
            raise ValueError("playing must be a boolean.")
        if not isinstance(character, str) or character not in available_character_ids():
            raise ValueError("Character is not available.")
        if type(direction) is not int or not -1 <= direction <= 7:
            raise ValueError("Direction must be -1 (automatic) or 0..7.")
        if not self.lock.acquire(blocking=False):
            raise RuntimeError("A frame is already in flight for this character session.")
        try:
            if self.process.poll() is not None:
                raise RuntimeError("Character renderer is no longer running.")
            self.process.stdin.write(
                f"{delta:.12f} {mode} {int(playing)} {character} {direction}\n".encode("ascii"))
            deadline = time.monotonic() + 5
            header = bytearray()
            while not header.endswith(b"\n") and len(header) < 1024:
                header.extend(self.read(1, deadline))
            text = header.decode("ascii").strip()
            if text.startswith("ERR "):
                raise ValueError(text[4:])
            fields = text.split()
            if len(fields) != 12 or fields[0] != "OK" or fields[1] != "383984":
                self.process.terminate()
                raise RuntimeError("Invalid native character frame header.")
            pixels = self.read(int(fields[1]), deadline)
            names = ("direction", "index", "blink", "mode", "requestedMode", "effectSeconds",
                     "eventId", "renderMs", "availableDirections", "playing")
            return pixels, dict(zip(names, fields[2:]))
        except (TimeoutError, BrokenPipeError):
            if self.process.poll() is None:
                self.process.terminate()
            raise
        finally:
            self.lock.release()


class RendererSessions:
    def __init__(self, executable, renderer_type=NativeRenderer):
        self.executable = executable
        self.renderer_type = renderer_type
        self.instances = {}
        self.lock = threading.Lock()
        self.closed = False

    def get(self, session):
        if not isinstance(session, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,64}", session):
            raise ValueError("A valid browser session is required.")
        with self.lock:
            if self.closed:
                raise RuntimeError("Preview sessions are shutting down.")
            if session not in self.instances:
                if len(self.instances) >= 8:
                    raise RuntimeError("Eight previews are already open. Close an unused preview first.")
                self.instances[session] = self.renderer_type(self.executable)
            return self.instances[session]

    def close(self, session):
        with self.lock:
            instance = self.instances.pop(session, None)
            if instance:
                instance.close()

    def close_all(self):
        with self.lock:
            self.closed = True
            instances = list(self.instances.values())
            self.instances.clear()
        for instance in instances:
            instance.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--skip-build", action="store_true", help="Use explicitly prebuilt native binaries.")
    args = parser.parse_args()
    sessions = RendererSessions(ROOT / "build/live-preview" if args.skip_build else build_renderer())
    characters = RendererSessions(
        ROOT / "build/character-preview" if args.skip_build else build_character_renderer(),
        NativeCharacterRenderer)

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *arguments, **keywords):
            super().__init__(*arguments, directory=str(ROOT / "web"), **keywords)

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def log_message(self, format_string, *arguments):
            if self.command != "POST" or len(arguments) < 2 or str(arguments[1]) != "200":
                super().log_message(format_string, *arguments)

        def translate_path(self, path):
            if path == "/characters" or path.startswith("/characters/"):
                from urllib.parse import unquote, urlsplit
                relative = unquote(urlsplit(path).path).lstrip("/")
                target = (ROOT / relative).resolve()
                characters = (ROOT / "characters").resolve()
                if target == characters or characters in target.parents:
                    return str(target)
                return str(characters)
            return super().translate_path(path)

        def do_GET(self):
            if self.path == "/api/characters":
                data = json.dumps({"characters": available_characters()}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            super().do_GET()

        def do_POST(self):
            if self.path not in ("/api/frame", "/api/close", "/api/character/frame", "/api/character/close"):
                self.send_error(404)
                return
            try:
                self.connection.settimeout(5)
                size = int(self.headers.get("Content-Length", "0"))
                if size <= 0 or size > 4096:
                    raise ValueError("Invalid request size.")
                payload = json.loads(self.rfile.read(size))
                if not isinstance(payload, dict):
                    raise ValueError("Request must be a JSON object.")
                selected = characters if self.path.startswith("/api/character/") else sessions
                if self.path.endswith("/close"):
                    session = payload.get("session")
                    if not isinstance(session, str):
                        raise ValueError("Browser session is required.")
                    selected.close(session)
                    self.send_response(204)
                    self.end_headers()
                    return
                pixels, metadata = selected.get(payload.get("session")).frame(payload)
            except (ValueError, json.JSONDecodeError) as error:
                self.send_error(400, str(error))
                return
            except (RuntimeError, OSError) as error:
                self.send_error(503, str(error))
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(pixels)))
            for key, value in metadata.items():
                self.send_header(f"X-Copilot-{key}", value)
            self.end_headers()
            self.wfile.write(pixels)

    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
        print(f"Copilot Motion Studio: http://127.0.0.1:{args.port}", flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        sessions.close_all()
        characters.close_all()


if __name__ == "__main__":
    main()

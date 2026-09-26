#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
mkdir -p build
"${CXX:-clang++}" -std=c++17 -O1 -g -Wall -Wextra -Werror \
  -fsanitize=address,undefined -fno-omit-frame-pointer \
  tests/test_working_bits.cpp firmware/AgentCompanion/src/AgentBadges.cpp \
  firmware/AgentCompanion/src/CharacterEffects.cpp \
  -o build/test-working-bits
build/test-working-bits
python3 <<'PY'
from pathlib import Path
from array import array
import sys
import math
import json
sys.path.insert(0, 'tools')
from sprite_codec import decode_pixels

metadata = json.loads(Path('characters/copilot/frames.json').read_text())
records = {(frame['direction'], frame['step']): frame['base'] for frame in metadata['frames']}
blob = Path('characters/copilot/frames.bin').read_bytes()
width = metadata['width']
assert width == 412
inset = (width - 400) // 2
for direction in (0, 1, 9):
    for pose in range(24):
        block = records[metadata['directions'][direction], pose]
        offset, size = block['offset'], block['size']
        x, y, cropped_width, cropped_height = metadata['baseBounds']
        cropped = decode_pixels(blob[offset:offset + size], cropped_width)
        assert len(cropped) == cropped_width * cropped_height * 2
        frame = bytearray(width * metadata['height'] * 2)
        for row in range(cropped_height):
            start = ((row + y) * width + x) * 2
            frame[start:start + cropped_width * 2] = cropped[row * cropped_width * 2:(row + 1) * cropped_width * 2]
        assert len(frame) == width * 352 * 2
        if direction == 9 or pose <= 13:
            pixels = array('H')
            pixels.frombytes(frame)
            radius = math.sqrt(max((i % width - inset - 200)**2 + (i // width - 176)**2
                                   for i, value in enumerate(pixels) if value))
            assert 200 - 5 - radius > 12, (
                f'Orbit clearance too small: direction={direction}, pose={pose}')
        for y in range(0, 33):
            for lane in (176, 188, 210, 222):
                for x in range(lane, lane + 5):
                    offset = (y * width + inset + x) * 2
                    assert frame[offset:offset + 2] == b'\0\0', (
                        f'Artwork hides binary lane: direction={direction}, pose={pose}, x={x}, y={y}')
print('All 72 focused/unfocus/left/right exported poses leave the binary lanes unobstructed')
print('Every rendered Working pose has more than twelve pixels of full-ball orbit clearance')
PY

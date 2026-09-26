"""Shared deterministic sprite export helpers for character-specific exporters."""
from __future__ import annotations

import hashlib
import io
from pathlib import Path

import numpy as np
from PIL import Image

from sprite_compression import CompressionCache

WIDTH, HEIGHT = 240, 224
DISPLAY_WIDTH, DISPLAY_HEIGHT, DRAW_WIDTH = 412, 352, 396


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def write_if_changed(path, data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    if path.exists() and path.read_bytes() == data:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def contained_path(directory, name):
    if not isinstance(name, str) or not name or Path(name).is_absolute():
        raise ValueError(f"Expected a relative asset path: {name!r}")
    path = (directory / name).resolve()
    if not path.is_relative_to(directory.resolve()):
        raise ValueError(f"Asset path escapes its directory: {name!r}")
    if not path.is_file():
        raise ValueError(f"Missing asset: {path}")
    return path


def read_png(path, expected_size=None):
    data = path.read_bytes()
    with Image.open(io.BytesIO(data)) as image:
        if image.format != "PNG":
            raise ValueError(f"Expected PNG: {path}")
        if expected_size is not None and image.size != expected_size:
            raise ValueError(f"Invalid image dimensions for {path}: {image.size}")
        if "A" in image.getbands() and image.getchannel("A").getextrema() != (255, 255):
            raise ValueError(f"Transparent pixels are not supported: {path}")
        if "transparency" in image.info:
            raise ValueError(f"PNG transparency is not supported: {path}")
        pixels = np.asarray(image.convert("RGB")).copy()
    return pixels, sha256(data)


def rgb565(pixels):
    channels = pixels.astype(np.uint16)
    return ((channels[:, :, 0] >> 3) << 11 |
            (channels[:, :, 1] >> 2) << 5 |
            channels[:, :, 2] >> 3).astype("<u2")


def display_pixels(source):
    """Resample already-truncated RGB565 pixels into SPI wire-order pixels."""
    if source.shape != (HEIGHT, WIDTH):
        raise ValueError(f"Expected {WIDTH}x{HEIGHT} source pixels.")
    factor = np.float32(DRAW_WIDTH) / np.float32(WIDTH)
    offset_x = np.float32(DISPLAY_WIDTH - DRAW_WIDTH) / np.float32(2)
    offset_y = (np.float32(DISPLAY_HEIGHT) - np.float32(HEIGHT) * factor) / np.float32(2)

    def coordinates(length, source_length, offset):
        position = ((np.arange(length, dtype=np.float32) + np.float32(0.5) - offset)
                    / factor - np.float32(0.5))
        position = np.clip(position, np.float32(0), np.float32(source_length - 1))
        lower = np.floor(position).astype(np.int32)
        upper = np.minimum(lower + 1, source_length - 1)
        weight = np.floor((position - lower.astype(np.float32)) * np.float32(32)
                          + np.float32(0.5)).astype(np.uint32)
        return lower, upper, weight

    x0, x1, wx = coordinates(DISPLAY_WIDTH, WIDTH, offset_x)
    y0, y1, wy = coordinates(DISPLAY_HEIGHT, HEIGHT, offset_y)
    result = np.zeros((DISPLAY_HEIGHT, DISPLAY_WIDTH), dtype=np.uint32)
    for shift, mask in ((11, 31), (5, 63), (0, 31)):
        channel = (source.astype(np.uint32) >> shift) & mask
        horizontal = (channel[:, x0] * (32 - wx) + channel[:, x1] * wx) // 32
        interpolated = (horizontal[y0] * (32 - wy[:, None])
                        + horizontal[y1] * wy[:, None]) // 32
        result |= interpolated << shift
    xx = np.arange(DISPLAY_WIDTH, dtype=np.float32) + np.float32(0.5)
    result[:, (xx < offset_x) | (xx >= offset_x + np.float32(DRAW_WIDTH))] = 0
    return result.astype(">u2")


class BlockStore:
    def __init__(self, cache_directory=None):
        self.data = bytearray()
        self.blocks = {}
        self.cache = CompressionCache() if cache_directory is None else CompressionCache(cache_directory)
        self.referenced_compressed_bytes = 0
        self.referenced_raw_bytes = 0
        self.references = 0

    def add(self, raw, width):
        if not raw:
            return {"offset": 0, "size": 0}
        if type(width) is not int or width <= 0 or len(raw) % (width * 2):
            raise ValueError("Sprite blocks require complete RGB565 rows and a positive integer width.")
        self.references += 1
        self.referenced_raw_bytes += len(raw)
        key = (width, raw)
        if key not in self.blocks:
            compressed = self.cache.compress(raw, width)
            self.blocks[key] = {"offset": len(self.data), "size": len(compressed)}
            self.data.extend(compressed)
        block = self.blocks[key]
        self.referenced_compressed_bytes += block["size"]
        return dict(block)

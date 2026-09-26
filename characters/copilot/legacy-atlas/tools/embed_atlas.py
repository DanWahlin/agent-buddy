#!/usr/bin/env python3
"""Embed the compressed atlas without a multi-megabyte C++ initializer."""
from pathlib import Path
import hashlib
import platform

ROOT = Path(__file__).resolve().parents[4]


def main():
    source = ROOT / "characters/copilot/legacy-atlas/assets/turn-atlas.bin"
    data = source.read_bytes()
    if len(data) > 10 * 1024 * 1024:
        raise ValueError("Atlas exceeds the 10 MiB asset budget.")
    digest = hashlib.sha256(data).hexdigest()
    include = ROOT / "characters/copilot/legacy-atlas/generated/atlas_bytes.h"
    marker = f"// SHA256 {digest}\n"
    existing = ""
    if include.exists():
        with include.open() as stream:
            existing = stream.readline()
    if existing != marker:
        with include.open("w") as stream:
            stream.write(marker)
            for offset in range(0, len(data), 32):
                stream.write(".byte " + ",".join(str(v) for v in data[offset:offset + 32]) + "\n")
    build = ROOT / "build"
    build.mkdir(exist_ok=True)
    symbol = "_ZN7copilot10kAtlasDataE"
    section = ".section .rodata"
    if platform.system() == "Darwin":
        symbol = "_" + symbol
        section = ".section __TEXT,__const"
    escaped = str(source).replace("\\", "\\\\").replace('"', '\\"')
    (build / "atlas_host.S").write_text(
        f'{section}\n.balign 4\n.globl {symbol}\n{symbol}:\n.incbin "{escaped}"\n'
    )
    print(f"Atlas embedded: {len(data):,} bytes, SHA256 {digest}")


if __name__ == "__main__":
    main()

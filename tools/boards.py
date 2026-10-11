#!/usr/bin/env python3
"""Read the firmware build targets in firmware/boards.json.

Each board is one build target: one firmware binary for one hardware model.
The firmware selects the board's pins and drivers with the board's compiler
define (see firmware/AgentCompanion/src/boards/).
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BOARDS = ROOT / "firmware" / "boards.json"
BOARD_SOURCES = ROOT / "firmware" / "AgentCompanion" / "src" / "boards"
SELECTORS = ("BoardConfig.h", "BoardDrivers.h")
BOARD_ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")
DEFINE = re.compile(r"^AGENT_BOARD_[A-Z0-9_]+$")
REQUIRED = ("name", "define", "directory", "chip", "flash_size", "fqbn", "vendor")


def load(path=BOARDS):
    data = json.loads(Path(path).read_text())
    validate(data)
    return data


def validate(data, sources=BOARD_SOURCES):
    boards = data.get("boards")
    if not isinstance(boards, dict) or not boards:
        raise ValueError("boards.json must list one or more boards.")
    if data.get("default") not in boards:
        raise ValueError("boards.json default must name a listed board.")
    defines = set()
    for board_id, board in boards.items():
        if not BOARD_ID.match(board_id):
            raise ValueError(f"Board ID {board_id!r} must use lowercase letters, digits, and hyphens.")
        missing = [key for key in REQUIRED if not board.get(key)]
        if missing:
            raise ValueError(f"Board {board_id} is missing {', '.join(missing)}.")
        if not DEFINE.match(board["define"]) or board["define"] in defines:
            raise ValueError(f"Board {board_id} needs a unique AGENT_BOARD_* define.")
        defines.add(board["define"])
        directory = sources / board["directory"]
        for header in SELECTORS:
            if not (directory / header).is_file():
                raise ValueError(f"Board {board_id} needs {directory / header}.")
            selector = (sources / header).read_text()
            if f"defined({board['define']})" not in selector:
                raise ValueError(f"src/boards/{header} does not select {board['define']}.")
            if f'"{board["directory"]}/{header}"' not in selector:
                raise ValueError(f"src/boards/{header} does not include {board['directory']}/{header}.")
        vendor = board["vendor"]
        for key in ("repository", "revision", "directory_env", "default_directory", "libraries"):
            if not vendor.get(key):
                raise ValueError(f"Board {board_id} vendor is missing {key}.")
    return data


def board(data, board_id=None):
    board_id = board_id or os.environ.get("BOARD") or data["default"]
    if board_id not in data["boards"]:
        raise ValueError(f"Unknown board {board_id!r}. Known boards: {', '.join(data['boards'])}.")
    return board_id, data["boards"][board_id]


def vendor_directory(entry):
    vendor = entry["vendor"]
    return Path(os.path.expanduser(os.environ.get(vendor["directory_env"]) or vendor["default_directory"]))


def fetch_vendor(entry, destination):
    """Clone the pinned vendor revision with only the library folders."""
    import subprocess

    vendor = entry["vendor"]
    destination = Path(destination)
    if not (destination / ".git").is_dir():
        subprocess.run(["git", "clone", "--filter=blob:none", "--no-checkout", vendor["repository"], str(destination)], check=True)
    subprocess.run(["git", "-C", str(destination), "sparse-checkout", "set", *vendor["libraries"]], check=True)
    subprocess.run(["git", "-C", str(destination), "checkout", "--detach", vendor["revision"]], check=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="print the board IDs")
    sub.add_parser("default", help="print the default board ID")
    sub.add_parser("validate", help="check boards.json against the firmware sources")
    field = sub.add_parser("field", help="print one board field")
    field.add_argument("name", choices=("id", "name", "models", "define", "directory", "chip", "flash_size", "fqbn"))
    field.add_argument("--board")
    for name, help_text in (
        ("vendor-dir", "print the vendor directory for this computer"),
        ("libraries", "print the library directories, one for each line"),
        ("check-vendor", "check that the vendor files are present"),
    ):
        command = sub.add_parser(name, help=help_text)
        command.add_argument("--board")
    fetch = sub.add_parser("fetch-vendor", help="clone the pinned vendor libraries")
    fetch.add_argument("destination")
    fetch.add_argument("--board")
    args = parser.parse_args(argv)
    try:
        data = load()
        if args.command == "list":
            print("\n".join(data["boards"]))
            return 0
        if args.command == "default":
            print(data["default"])
            return 0
        if args.command == "validate":
            print(f"{len(data['boards'])} board(s) OK")
            return 0
        board_id, entry = board(data, args.board)
        if args.command == "field":
            print(board_id if args.name == "id" else entry.get(args.name, ""))
        elif args.command == "vendor-dir":
            print(vendor_directory(entry))
        elif args.command == "libraries":
            base = vendor_directory(entry)
            print("\n".join(str(base / path) for path in entry["vendor"]["libraries"]))
        elif args.command == "check-vendor":
            base = vendor_directory(entry)
            for path, label in entry["vendor"].get("required_files", {}).items():
                if not (base / path).is_file():
                    env = entry["vendor"]["directory_env"]
                    print(f"{label} is missing from {base}. Set {env} or see docs/build-from-source.md.", file=sys.stderr)
                    return 1
        elif args.command == "fetch-vendor":
            fetch_vendor(entry, args.destination)
        return 0
    except (ValueError, KeyError, json.JSONDecodeError) as error:
        print(error, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

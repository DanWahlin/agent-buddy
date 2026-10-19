#!/usr/bin/env python3
"""Update VERSION/changelog, then commit, tag, and atomically push a stable release."""
import argparse
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
VERSION_PATTERN = re.compile(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)")


def version_tuple(value):
    if VERSION_PATTERN.fullmatch(value) is None:
        raise ValueError("Use a stable version such as 0.1.0, without a v prefix.")
    return tuple(map(int, value.split(".")))


def run(arguments, root=ROOT):
    result = subprocess.run(arguments, cwd=root, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, check=False)
    if result.returncode:
        raise RuntimeError(f"{arguments[0]} failed: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout.strip()


def check_tag(tag, root=ROOT):
    version = (root / "VERSION").read_text().strip()
    version_tuple(version)
    if tag != "v" + version:
        raise ValueError(f"Tag {tag!r} does not match VERSION ({version}).")


def release(version, root=ROOT, dry_run=False):
    requested = version_tuple(version)
    current = version_tuple((root / "VERSION").read_text().strip())
    if requested < current:
        raise ValueError("The requested version is older than VERSION.")
    if run(["git", "branch", "--show-current"], root) != "main":
        raise ValueError("Release from the main branch.")
    if run(["git", "status", "--porcelain"], root):
        raise ValueError("Commit or stash current work before releasing; the worktree must be clean.")
    if shutil.which("git-cliff") is None:
        raise ValueError("Install git-cliff before releasing, or run the Release workflow (see docs/releases.md).")
    tag = "v" + version
    run(["git", "fetch", "--quiet", "origin", "main", "--tags"], root)
    if run(["git", "rev-parse", "HEAD"], root) != run(["git", "rev-parse", "origin/main"], root):
        raise ValueError("Local main and origin/main differ. Synchronize them before releasing.")
    if run(["git", "tag", "--list", tag], root):
        raise ValueError(f"Tag {tag} already exists; choose a new version.")
    print(f"Release {tag}: update VERSION/CHANGELOG.md, commit, create annotated tag, push main and tag.")
    if dry_run:
        print("Dry run: no release files modified and no release commit, tag, or push created.")
        return
    with tempfile.TemporaryDirectory(prefix="esp32-release-") as directory:
        notes = Path(directory) / "CHANGELOG.md"
        run(["git-cliff", "--tag", tag, "--output", str(notes)], root)
        changelog = notes.read_text()
        if not changelog.strip():
            raise RuntimeError("git-cliff generated an empty changelog.")
    message = "Release " + tag
    session = os.environ.get("COPILOT_SESSION_ID")
    if session:
        if re.fullmatch(r"[0-9a-fA-F-]{36}", session) is None:
            raise ValueError("COPILOT_SESSION_ID must be a session UUID.")
        message += ("\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
                    "\nCopilot-Session: " + session)
    (root / "VERSION").write_text(version + "\n")
    (root / "CHANGELOG.md").write_text(changelog)
    run(["git", "add", "--", "VERSION", "CHANGELOG.md"], root)
    run(["git", "commit", "-m", message], root)
    run(["git", "tag", "-a", tag, "-m", "Release " + tag], root)
    run(["git", "push", "--atomic", "origin", "HEAD:refs/heads/main", f"refs/tags/{tag}"], root)
    print(f"Pushed {tag}. GitHub Actions will validate, build, and publish the matching bundles.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version", nargs="?")
    parser.add_argument("--dry-run", action="store_true", help="Check readiness without creating a release.")
    parser.add_argument("--check-tag", metavar="TAG", help="Only check that a CI tag matches VERSION.")
    args = parser.parse_args()
    try:
        if args.check_tag:
            if args.version or args.dry_run:
                parser.error("--check-tag cannot be combined with a version or --dry-run.")
            check_tag(args.check_tag)
        elif args.version:
            release(args.version, dry_run=args.dry_run)
        else:
            parser.error("Provide a version or --check-tag.")
    except (OSError, ValueError, RuntimeError) as error:
        parser.exit(1, f"Release stopped: {error}\nInspect git status and tags before retrying; no automatic rollback is performed.\n")


if __name__ == "__main__":
    main()

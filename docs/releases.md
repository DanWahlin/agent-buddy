# Tagging and releases

This follows the Agent Arcade convention: stable `vX.Y.Z` tags trigger a build,
`git-cliff` groups commit messages into release notes, and GitHub Actions publishes
the downloadable files. Branch/PR builds and manual workflow runs on a branch
validate and upload workflow artifacts without publishing a release.

## Publish a version

Merge the intended changes to `main` first. Then, on GitHub, open **Actions**,
choose **Release**, select **Run workflow** on `main`, and enter the next stable
version without a `v` (for example `0.14.17`). Nothing needs to be installed on
your computer. Check **Only check that the release can be made** for a dry run.

The workflow runs [`tools/release.py`](../tools/release.py) on a GitHub runner with
a pinned `git-cliff` ([`requirements-release.txt`](../requirements-release.txt)).
The helper checks that `main` matches `origin/main` and the tag is unused. It
updates only `VERSION` and `CHANGELOG.md`, commits them as the person who ran the
workflow, creates an annotated tag, then atomically pushes the branch and tag. It
never stages unrelated files or force-pushes.

**A run without the dry run publishes a tag, then starts Build and Release on it.**
A tag that a workflow's token pushes starts no workflow by itself, so the Release
workflow starts Build and Release, which publishes the release when every job passes.
A manual Build and Release run on a `v*` tag publishes that release again.

### From a computer

The same helper runs locally with Git, Python 3.10+, and
[git-cliff](https://git-cliff.org/docs/installation/) (`brew install git-cliff` on
macOS). From the repository root, on an up-to-date `main`:

```bash
python3 tools/release.py 0.1.0 --dry-run
python3 tools/release.py 0.1.0
```

A tag pushed from a computer starts Build and Release itself. If the final push
fails, the local commit/tag remain for inspection; there is no automatic
rollback. After resolving the remote problem, push that existing release rather
than rerunning the helper:

```bash
git push --atomic origin main v0.1.0
```

An optional `COPILOT_SESSION_ID` adds Copilot attribution/session trailers.

## Release contents

| Asset | Purpose |
| --- | --- |
| `<repo>-v<version>-firmware.zip` | Firmware for the default board (Waveshare ESP32-S3-Touch-AMOLED-1.75): Python installer, checksums, and all matching flash `.bin` files |
| `<repo>-v<version>-<board>-firmware.zip` | The same for each other board in `firmware/boards.json`, such as `waveshare-lcd-154` |
| `<repo>-v<version>-characters.zip` | Every built-in character pack (`copilot.acpk`, `openclaw.acpk`) |
| `SHA256SUMS` | Checksums for every other release file, including the desktop apps |

The installer validates the included files and writes each at its declared
address, including the default Copilot pack in the character partition. It does
not use `erase-flash` or pad a merged image over NVS. A different existing
firmware may use a different partition layout, so users should back up its data
before installing.

Character packs are self-describing and SHA-256 protected, so any pack that uses
the firmware's animation model can be installed later with
`npm run character path/to/pack.acpk` from a source checkout.

## Build release bundles locally

After a successful firmware build:

```bash
python3 tools/package_release.py --version "$(cat VERSION)"
```

Files appear in `build/release/`. `--name` and `--repository` override branding;
GitHub Actions derives both from the repository, so its artifact names follow a
future repository rename. The card's `copilot/` directory is a firmware path,
not a repository name, and remains unchanged.

## Automation details

`.github/workflows/build.yml` runs native tests, re-exports and compares sprite
assets, installs the pinned Arduino CLI/core and Waveshare libraries, builds the
firmware, then packages only a verified matched bundle. Its `daemon-windows` job
runs the companion service's tests on native Windows, and a release waits for it.
This needs no Azure credentials or image-generation calls: all approved source
artwork is checked in.

Actions are pinned to revisions. Build jobs have read-only repository permissions;
only the tag-triggered publishing job receives `contents: write`. The tag must
match `VERSION`. A manual run produces downloadable workflow artifacts, not a
GitHub Release. Neither workflow can verify physical touch response, card I/O
timing, or AMOLED scanout; those checks still require the device.

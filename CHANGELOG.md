# Changelog

Notable changes to this ESP32 companion.

## [v0.11.0]

### Features and improvements

- Add service and desktop app versions to the Settings status card

- Improve Status card text with normal size and weight


### Fixes

- Fix Needs attention for Copilot questions and plan approvals

## [v0.10.0]

### Build and maintenance

- Rebuild desktop engine for orientation firmware sources

- Preserve networking RAM and update protocol-limit tests


### Features and improvements

- Add accelerometer-based display orientation

- Add saved web alignment trim and pipelined display DMA


### Other changes

- Start Wi-Fi before renderer allocations

## [v0.9.0]

### Features and improvements

- Add desktop sounds with a volume slider, uninstall from Settings, and a simpler tray menu

- Add native Windows support: bundled service, WSL hooks, and Windows Arm64 installer

## [v0.8.1]

### Fixes

- Fix the Linux AppImage build: remove the musl serialport binding from the bundle

## [v0.8.0]

### Features and improvements

- Add the desktop app as the single entry point: Settings window, bundled service, USB firmware install, and Wi-Fi updates approved with BOOT


### Fixes

- Fix the Claude frames metadata for the new character partition size

## [v0.7.0]

### Build and maintenance

- Run the tests on three platforms, and the packer without a rig

- Drive the harness from a real bridge, and test that on three platforms

- Build the workspaces in dependency order, not alphabetical

- Stop the tests tidying up while a host is still writing

- Remove an accidentally committed hook capture file

- Give the engine CI job's pip cache a requirements file

- Pin the desktop workflow's actions and drop its PR-branch trigger


### Documentation

- Document the desktop companion as a second screen for the device

- Give the README a three-part quick start: device, Settings, desktop

- README: say how to use only the desktop app, and open the app after xattr


### Features and improvements

- Stop the new test passing for the wrong reasons

- Ship the three Agent Companion characters, and add Claude as the third


### Fixes

- Add the Copilot and OpenClaw packs, and three fixes they exposed

- Fix character switching, mixed-scale displays, and Settings' hide


### Other changes

- Agent Companion for VS Code: any agent avatar, driven by real hooks

- Close every connection on shutdown, not just the registered subscribers

- Record Dan Wahlin's approval of the vendored code

- Lift what every host needs out of the extension

- Let each window follow its own project

- Find out whether Tauri can do click-through

- Keep the transitions a real hand produced

- Run the bridge as a process, for a shell that is not Node

- Share the page between hosts, not just the pieces under it

- Put the companion in a window of its own

- Check what Copilot CLI actually sends, rather than assuming

- Give the shim a home that outlives the host that installed it

- Let the companion be moved, and be quit

- Let the desktop app change character

- Make the window actually show the character it was told to

- Make the tray icon look like the character it is showing

- Make the icon folder, since it is no longer checked in

- Describe the thing it has become, not the thing it started as

- Apply remaining changes

- Quit without a Chromium error on the way out

- Bring the Desktop Agent Companion in under desktop/

- Make the Desktop Agent Companion at home under desktop/

- Let the companion service drive the desktop companion

- Draw the desktop character with the device's own engine

- Show the desktop character on a copy of the device

- Give the desktop device a lit rim, and a switch to hide it

- Share the per-frame character step between device, desktop and preview

- Make the desktop companion light enough to leave running

- Drop the .vsix attribute left from the VS Code extension

- Remove what the desktop no longer uses, and share the warm-up render

- Let people run the desktop app without Rust or Emscripten

- Run the desktop app on Linux, Omarchy included, with per-OS install steps

- Give the desktop character a right-click menu: Hide, Open Settings, Close

- Make a hidden desktop character always easy to bring back

- Show a device install on the desktop without making it wait

- Show the install ring only with a device connected, and raise its label

- Trim the desktop app's CPU further, and recover from Cmd-H

- Stop the desktop app from taking keyboard focus

- Keep the render task off the unmapped pack during an install

- Let agent events end a manual state override

## [v0.6.0]

### Features and improvements

- Add Wi-Fi network scan and live join status

## [v0.5.1]

### Other changes

- Ignore permission prompts from one-shot agent runs

- Recognize one-shot Grok and Hermes runs

- Recognize Hermes one-shot runs through its python relaunch

- Show the device's Wi-Fi network on the settings page

## [v0.5.0]

### Build and maintenance

- Rebuild character packs automatically when characters change


### Documentation

- Restructure the README into a step-by-step guide

- Document the 16 MiB flash ceiling and the character art pipeline

- Make the README a focused step-by-step guide


### Features and improvements

- Add Claude as a built-in character pack


### Other changes

- Ignore recoverable Copilot errors for attention

- Clear error attention when an agent finishes its turn normally

- Keep touch alive and stop the settings menu stranding the display

- Record firmware artifact paths POSIX-style

- Let device.py send modes to protocol 6 firmware

- Offer Claude in Character Lab

- Keep internal RAM free for Wi-Fi with large blink patches

## [v0.4.0]

### Documentation

- Update OpenClaw setup documentation


### Features and improvements

- Add .gitattributes to enforce LF line endings

- Add multi-agent hooks, character packs, Wi-Fi setup, settings page, and agent badges


### Fixes

- Fix CI and explain old-Python flashing failures


### Other changes

- Use sys.executable instead of hardcoded python3

- Upgrade to Node.js 24 LTS

- Center character thumbnails on the settings page

## [v0.3.1]

### Fixes

- Fix portable release validation

## [v0.3.0]

### Features and improvements

- Add sleeping state and portable daemon

- Add OpenClaw character support

## [v0.2.0]

### Build and maintenance

- Present animated demo as circular display

- Keep circular display intact across GIF frames


### Documentation

- Update README for Agent Companion rename


### Features and improvements

- Add animated character demo to README

- Document support for B and C device variants

- Add swipe-up device settings

- Add Copilot companion daemon

- Add synchronized device sound cues

- Add adjustable sound volume


### Other changes

- Refine project logo to match the thin round device

- Fit settings header to round display

- Return tapped surprise to idle

- Enlarge Working binary glyphs

- Resume working after attention

- Harden multi-agent daemon state

- Refine working and attention sounds

- Make working cue speaker audible

- Label settings controls clearly

- Clear completed subagent leases

## [v0.1.0]

### Features and improvements

- Create ESP32 Copilot firmware and sprite review studio

- Add polished character reactions and full-height working animation

- Add compact sprites, microSD support, and release automation


# Changelog

Notable changes to this ESP32 companion.

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


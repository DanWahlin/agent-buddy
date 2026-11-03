# Desktop app details

More about the desktop app. Start with
[Desktop Agent Buddy](../README.md#desktop-agent-buddy) in the README.

## The companion service that the app carries

When you open the app and no companion service answers within 10 seconds, the
app installs the one that it carries:

- It copies the service, a Node.js runtime, and the character packs to the
  service's data folder: `~/Library/Application Support/ESP32 Agent Companion/runtime`
  on macOS, `~/.local/state/esp32-agent-companion/runtime` on Linux, or
  `%LOCALAPPDATA%\ESP32 Agent Companion\runtime` on Windows.
- From that copy, it installs the background service (a LaunchAgent, a systemd
  user service, or on Windows a `Run` registry value that starts the app's own
  launcher), as `npm run setup` does. The service then starts when you sign in,
  with or without the app.
- A new installation opens the welcome screen. You select and approve agents
  before the app installs any hooks. The app opens Settings after you select
  **Finish**.
- Setup that you didn't finish resumes when the app starts. Updates keep the
  agents that you approved, and they don't install hooks for agents that you
  didn't select.

When you update the app, it updates its copy of the service. If a service from a
clone of the repository runs, the app leaves it alone and follows it. To change
back to the repository's service, run `npm run setup` in the clone.

Before version 0.15.4, the app was named Agent Companion. The new version
removes the Agent Companion app when it installs, or on macOS when it first
opens, and it keeps your settings and characters.

## Start and stop it from Settings

On the **Desktop** tab in Settings, **Start** opens the app and **Stop** closes
it. The service finds the app in these places:

- Where the app last ran. Each time the app runs, it tells the service where it
  is, so a download in any folder or a build from source works after you open
  it one time.
- Before it has run: `/Applications` or `~/Applications` (macOS), `/usr/bin`
  (the Linux `.deb`), or a build in this repository
  (`desktop/apps/desktop/src-tauri/target/release`).

If the service can't find the app (for example, an AppImage that you haven't
opened yet), **Start** stays off until you open the app one time yourself.
Settings shows the app as running only while it follows the service, so an app
from release 0.7.0 or earlier shows as **Not running**.

## Window and controls

The window has no frame and is always on top.

- **Clicks** go through to whatever is behind it, except on the character and
  the case's buttons.
- **Click the character** to poke it, as you tap the device. **Drag it** to move
  it. It remembers where you put it.
- **Click the upper button on the device's case** to open Settings. Pressing the
  BOOT button on the real device does the same.
- **Click the lower button on the device's case** to turn sounds on or off. A
  blue light on the button shows that sounds are on. See [Sounds](#sounds).
- **Right-click the character** for **Hide**, **Settings**, and **Close**.
- **Settings opens in a window of the app**, not in a browser tab. If the
  Settings window is already open, the app brings it to the front. To use a
  browser, run `npm run settings`.
- **Use the Dock or taskbar** to return to the running app. An open Settings
  window takes priority, including when it is minimized. The window keeps your
  current tab and setup progress. On Windows, Settings is the only taskbar
  window while it is open. After Settings closes, the character's taskbar entry
  returns.
- **To bring the character back after Hide**, use **Show Agent Buddy** in the
  tray menu, or run the app with `--show`. On Windows and Linux desktops with a
  taskbar, Hide minimizes the character window so the app stays available. On
  Hyprland, including Omarchy, Hide removes the window and keeps the menu-bar
  tray entry. On macOS, the Dock entry stays while the app runs.
- **The tray icon** has **Show Agent Buddy** or **Hide Agent Buddy**,
  **Settings**, **Quit Agent Buddy**, and **Quit and Stop Companion Service**.
  Choose the character in Settings.
- **From a terminal or a keyboard shortcut**, run the app again with
  `--toggle`, `--show`, `--hide`, `--settings`, or `--quit` to control the
  running one.

The running app appears in the macOS Dock, or in the taskbar on Windows and
supported Linux desktops. Its menu bar or tray icon stays available.

Hide is for now. To keep the character off the desktop for good, turn off
**Show the character on the desktop** in Settings. If the desktop character is
off, selecting the app entry opens Settings instead of turning the character on.

On macOS 13 or later, the character can still appear over other apps'
full-screen Spaces. Earlier macOS versions keep the Dock entry, but they can't
show this window over another app's full-screen Space.

## Quitting

If this computer has never used a device, **Quit** and **Close** also stop the
companion service, because it has nothing to do without the app. After a device
has connected one time (over USB, or paired over Wi-Fi), the service keeps
running when the app quits, so the device continues to show your agents. The
first time, the app tells you this and lets you stop the service too.

To stop the service later, use **Quit and Stop Companion Service** in the tray
menu, or **Stop** in the **Companion service** row on the **Desktop** tab in
Settings. The device then goes idle. The service starts again when you open the
app or sign in to your computer again. If the service doesn't work correctly,
click **Restart** in the same row. The app stays open and reconnects.

## Sounds

The desktop app plays the device's sound cues when the character starts work,
needs attention, finishes, or is poked. The cues are the same WAV files as on
the device. Sounds are **off** (muted) until you turn them on. To turn them on
or off, do one of these:

- Click the lower button on the case.
- In Settings, select the **Desktop** tab and use **Play sounds**.

The two always agree, because the companion service keeps the setting. To make
the sounds softer or louder, for example when music plays, use the
**Sound volume** slider below **Play sounds** (30% by default). A tick plays at
the new level when you release the slider. These settings are for the desktop
app only: the device keeps its own **Volume** in its on-screen menu. The app
plays no sounds while the character is hidden.

## Wayland and Hyprland

On Hyprland (including Omarchy), the app floats, pins, and removes the border of
its own window, so there's nothing to configure. On other Wayland desktops, it
runs through XWayland so that it can see the pointer.

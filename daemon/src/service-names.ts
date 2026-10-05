// The names that the installer gives the companion service, and that the uninstaller removes.

// macOS: the launch agent, and its log in ~/Library/Logs.
export const launchAgentLabel = 'com.danwahlin.esp32-agent-companion';
export const macLogName = 'esp32-agent-companion.log';
// Linux: the systemd user unit.
export const systemdUnit = 'esp32-agent-companion.service';
// Windows: the registry value that starts the service when the user signs in.
export const windowsRunKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const windowsRunValue = 'ESP32 Agent Companion';

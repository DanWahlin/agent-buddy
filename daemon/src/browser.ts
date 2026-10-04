import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';

// The commands that open a URL in the default browser, tried in order. WSL hands it to Windows.
export function browserCommands(url: string, platform: NodeJS.Platform, wsl: boolean): [string, string[]][] {
  if (platform === 'darwin') return [['/usr/bin/open', [url]]];
  if (platform === 'win32') return [['cmd', ['/c', 'start', '""', url]]];
  if (wsl) return [['wslview', [url]], ['explorer.exe', [url]]];
  return [['xdg-open', [url]]];
}

// `environment` adds display variables that a service manager may not give the daemon.
export async function openBrowser(url: string, environment: Record<string, string> = {}): Promise<boolean> {
  for (const [command, args] of browserCommands(url, process.platform, isWsl())) {
    const code = await new Promise<number | null>(resolve => {
      const child = spawn(command, args, {stdio: 'ignore', env: {...process.env, ...environment}});
      child.once('error', () => resolve(-1));
      child.once('exit', resolve);
    });
    // explorer.exe exits with 1 even when it opens the page.
    if (code === 0 || (command === 'explorer.exe' && code !== -1)) return true;
  }
  return false;
}

function isWsl(): boolean {
  try {
    return /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
  } catch {
    return false;
  }
}

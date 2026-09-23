/**
 * Enough of the `vscode` module to exercise the host code under `node --test`.
 *
 * esbuild aliases the real module to this when building the test bundle, so the
 * code under test is the code that ships - no interfaces re-declared, no logic
 * duplicated for testability.
 */

export enum FileType { Unknown = 0, File = 1, Directory = 2, SymbolicLink = 64 }

export enum ConfigurationTarget { Global = 1, Workspace = 2, WorkspaceFolder = 3 }

export class Uri {
  readonly scheme: string;
  readonly path: string;

  private constructor(scheme: string, path: string) {
    this.scheme = scheme;
    this.path = path;
  }

  static file(path: string): Uri {
    return new Uri('file', path.replace(/\\/g, '/'));
  }

  static parse(value: string): Uri {
    const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(value);
    return match ? new Uri(match[1], '/' + match[2]) : Uri.file(value);
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    const joined = [base.path.replace(/\/$/, ''), ...segments].join('/');
    return new Uri(base.scheme, joined);
  }

  get fsPath(): string { return this.path; }
  toString(): string { return this.scheme + '://' + this.path.replace(/^\//, ''); }
}

/** An in-memory file tree. Directories are inferred from the file paths. */
export const files = new Map<string, string>();

export function reset(): void {
  files.clear();
  configuration.clear();
  for (const key of Object.keys(listeners)) delete listeners[key];
}

/** Settings, keyed `section.name`. */
export const configuration = new Map<string, unknown>();

function children(directory: string): Array<[string, FileType]> {
  const prefix = directory.replace(/\/$/, '') + '/';
  const seen = new Map<string, FileType>();
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) seen.set(rest, FileType.File);
    else seen.set(rest.slice(0, slash), FileType.Directory);
  }
  return [...seen.entries()];
}

function isDirectory(path: string): boolean {
  const prefix = path.replace(/\/$/, '') + '/';
  for (const known of files.keys()) if (known.startsWith(prefix)) return true;
  return false;
}

export const workspace = {
  fs: {
    async stat(uri: Uri): Promise<{ type: FileType }> {
      if (files.has(uri.path)) return { type: FileType.File };
      if (isDirectory(uri.path)) return { type: FileType.Directory };
      throw new Error('ENOENT: ' + uri.path);
    },
    async readFile(uri: Uri): Promise<Uint8Array> {
      const content = files.get(uri.path);
      if (content === undefined) throw new Error('ENOENT: ' + uri.path);
      return new TextEncoder().encode(content);
    },
    async readDirectory(uri: Uri): Promise<Array<[string, FileType]>> {
      if (!isDirectory(uri.path)) throw new Error('ENOENT: ' + uri.path);
      return children(uri.path);
    },
  },
  getConfiguration(section: string) {
    return {
      get<T>(name: string): T | undefined {
        return configuration.get(section + '.' + name) as T | undefined;
      },
      async update(name: string, value: unknown): Promise<void> {
        configuration.set(section + '.' + name, value);
      },
    };
  },
  onDidChangeConfiguration() { return { dispose() {} }; },
};

/** Everything the output channel records, for assertions. */
export const logged: Array<{ level: string; text: string }> = [];

/** Listeners the host registered, so a test can fire the real handler. */
export const listeners: Record<string, Array<(value: never) => void>> = {};

function emitter(name: string) {
  return (listener: (value: never) => void) => {
    (listeners[name] ??= []).push(listener);
    return { dispose() { listeners[name] = (listeners[name] ?? []).filter(l => l !== listener); } };
  };
}

/** Fire an event at whatever the host registered for it. */
export function emit(name: string, value: unknown): void {
  for (const listener of listeners[name] ?? []) listener(value as never);
}

export const window = {
  onDidChangeTextEditorSelection: emitter('selection'),
  onDidChangeTextEditorVisibleRanges: emitter('visibleRanges'),
  onDidChangeActiveTextEditor: emitter('activeEditor'),
  onDidChangeWindowState: emitter('windowState'),
  createOutputChannel() {
    const write = (level: string) => (text: string) => logged.push({ level, text });
    return {
      info: write('info'), warn: write('warn'), error: write('error'),
      debug: write('debug'), trace: write('trace'), append: write('append'),
      appendLine: write('append'), show() {}, dispose() {},
    };
  },
  registerWebviewViewProvider() { return { dispose() {} }; },
  showErrorMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  showQuickPick: async () => undefined,
};

export const commands = {
  registerCommand() { return { dispose() {} }; },
  executeCommand: async () => undefined,
};

/**
 * A stand-in for the webview. `asWebviewUri` mimics the real rewriting closely
 * enough to tell whether the host resolved the right file.
 */
export function fakeWebview() {
  const posted: unknown[] = [];
  return {
    posted,
    cspSource: 'https://file+.vscode-resource.vscode-cdn.net',
    options: {} as Record<string, unknown>,
    html: '',
    asWebviewUri(uri: Uri) {
      return {
        toString: () => 'https://file+.vscode-resource.vscode-cdn.net' + uri.path,
      };
    },
    postMessage(message: unknown) { posted.push(message); return Promise.resolve(true); },
    onDidReceiveMessage(listener: (message: unknown) => void) {
      (this as unknown as { listener?: unknown }).listener = listener;
      return { dispose() {} };
    },
  };
}

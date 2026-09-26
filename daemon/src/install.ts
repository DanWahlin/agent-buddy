import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {installDaemon} from './installer.js';

await installDaemon(join(dirname(fileURLToPath(import.meta.url)), 'cli.js'));

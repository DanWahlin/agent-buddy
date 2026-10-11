import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {installDaemon} from './installer.js';

const arguments_ = process.argv.slice(2);
if (arguments_.some(argument => !['--desktop', '--existing-install'].includes(argument)))
  throw new Error('Unknown companion installer option.');
await installDaemon(join(dirname(fileURLToPath(import.meta.url)), 'cli.js'), {
  desktop: arguments_.includes('--desktop'), existingInstall: arguments_.includes('--existing-install'),
});

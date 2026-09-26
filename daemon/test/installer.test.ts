import assert from 'node:assert/strict';
import test from 'node:test';
import {createInstallationPlan, serviceEnvironment} from '../src/installer.js';

const context = {
  home: '/home/example',
  node: '/opt/node/bin/node',
  cli: '/home/example/agent companion/dist/src/cli.js',
  uid: 1000,
  configHome: '/home/example/.config',
};

test('creates macOS hooks and a launch agent', () => {
  const plan = createInstallationPlan('darwin', context);
  assert.equal(plan.files.length, 2);
  assert.match(plan.files[0]?.path ?? '', /\.copilot\/hooks\/agent-companion\.json$/);
  assert.match(plan.files[0]?.content ?? '', /userPromptSubmitted/);
  assert.match(plan.files[1]?.path ?? '', /Library\/LaunchAgents\/com\.danwahlin/);
  assert.match(plan.files[1]?.content ?? '', /KeepAlive/);
  assert.deepEqual(plan.commands.map(command => command.executable),
                   ['launchctl', 'launchctl', 'launchctl']);
});

test('creates Linux hooks and a systemd user service', () => {
  const plan = createInstallationPlan('linux', context);
  assert.equal(plan.files.length, 2);
  assert.equal(plan.files[1]?.path,
               '/home/example/.config/systemd/user/esp32-agent-companion.service');
  assert.match(plan.files[1]?.content ?? '',
               /ExecStart="\/opt\/node\/bin\/node" "\/home\/example\/agent companion\/dist\/src\/cli\.js" daemon/);
  assert.deepEqual(plan.commands.map(command => command.arguments), [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', 'esp32-agent-companion.service'],
    ['--user', 'restart', 'esp32-agent-companion.service'],
  ]);
});

test('services get the user PATH and HERMES_HOME so agent detection matches setup', () => {
  const environment = serviceEnvironment({
    PATH: '/repo/node_modules/.bin:/npm/lib/node-gyp-bin:/opt/homebrew/bin:~/.dotnet/tools:/usr/bin:/opt/homebrew/bin',
    HERMES_HOME: '/h/50%',
    HOME: '/x',
  });
  assert.deepEqual(environment, {PATH: '/opt/homebrew/bin:/usr/bin', HERMES_HOME: '/h/50%'});
  const mac = createInstallationPlan('darwin', {...context, environment});
  assert.match(mac.files[1]?.content ?? '',
               /<key>EnvironmentVariables<\/key>\n  <dict>\n    <key>PATH<\/key><string>\/opt\/homebrew\/bin:\/usr\/bin<\/string>/);
  const linux = createInstallationPlan('linux', {...context, environment});
  assert.match(linux.files[1]?.content ?? '', /^Environment="PATH=\/opt\/homebrew\/bin:\/usr\/bin"$/m);
  assert.match(linux.files[1]?.content ?? '', /^Environment="HERMES_HOME=\/h\/50%%"$/m);
});

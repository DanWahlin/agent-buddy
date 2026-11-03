import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createBuilder, InputType, OtlpProtocol, type InteractionInput} from './.aspire/modules/aspire.mjs';
import {developmentEnvironment, prepareDevelopmentState, run} from '../tools/dev.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const env = developmentEnvironment(root);
const token = await prepareDevelopmentState(env);
const builder = await createBuilder();

const companion = await builder.addJavaScriptApp('companion', '../daemon', {runScriptName: 'dev'})
    .withNpm({installCommand: 'ci', installArgs: ['--no-audit', '--no-fund']})
    .withOtlpExporter({protocol: OtlpProtocol.HttpJson})
    // Settings validates Host/Origin, so its advertised port must be its actual port.
    .withHttpEndpoint({name: 'http', env: 'AGENT_COMPANION_SETTINGS_PORT', isProxied: false})
    .withHttpHealthCheck({path: '/'})
    .withUrlForEndpoint('http', async url => {
        if (!url.url) throw new Error('Settings endpoint URL is unavailable.');
        url.url = `${url.url.replace(/\/$/, '')}/#token=${token}`;
        url.displayText = 'Settings (development)';
    });

await builder.addPythonApp('character-lab', '..', 'tools/serve_preview.py')
    .withHttpEndpoint({name: 'http', env: 'PORT', isProxied: false})
    .withHttpHealthCheck({path: '/api/characters'})
    .withUrlForEndpoint('http', async url => {
        if (!url.url) throw new Error('Character Lab endpoint URL is unavailable.');
        url.url = `${url.url.replace(/\/$/, '')}/character-preview.html`;
        url.displayText = 'Character Lab';
    });

// The frontend build and native app are one host process tree, never a container.
await builder.addNodeApp('desktop', '..', 'tools/dev.mjs')
    .withNpm({install: false})
    .withArgs(['desktop'])
    .waitFor(companion)
    .withExplicitStart();

const boards: {default: string; boards: Record<string, {name: string}>} =
    JSON.parse(await readFile(join(root, 'firmware/boards.json'), 'utf8'));
const boardInput: InteractionInput = {
    name: 'board', label: 'Board', inputType: InputType.Choice, required: true,
    value: boards.default,
    options: Object.entries(boards.boards).map(([key, board]) => ({key, value: board.name})),
};

let firmwareBusy = false;
async function command(action: string, args: string[] = []) {
    const firmware = action.startsWith('firmware-') || action === 'package';
    if (firmware && firmwareBusy)
        return {success: false, errorMessage: 'Wait for the current firmware operation to finish.'};
    if (firmware) firmwareBusy = true;
    try {
        await run(process.execPath, [join(root, 'tools/dev.mjs'), action, ...args], {cwd: root, env});
        return {success: true};
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[${action}] ${message}`);
        return {success: false, errorMessage: message};
    } finally {
        if (firmware) firmwareBusy = false;
    }
}

await companion.withCommand('state', 'Preview character state', async context => {
    const args = await context.arguments();
    return command('send', [await args.requiredValue('state')]);
}, {commandOptions: {
    arguments: [{
        name: 'state', label: 'State', inputType: InputType.Choice, required: true, value: 'working',
        options: ['idle', 'surprise', 'working', 'attention', 'complete'].map(key => ({key, value: key})),
    }],
}});

for (const [action, label, description] of [
    ['firmware-setup', 'Set up firmware toolchain', 'Download the pinned ESP32 core and vendor libraries into this checkout. No device is opened.'],
    ['firmware-build', 'Build firmware', 'Compile source for the selected board. No device is opened.'],
    ['package', 'Package local firmware', 'Package already-built firmware and characters into build/release. Does not publish a release.'],
]) {
    await companion.withCommand(action, label, async context => {
        const args = await context.arguments();
        return command(action, [await args.requiredValue('board')]);
    }, {commandOptions: {description, arguments: [boardInput]}});
}

await companion.withCommand('firmware-flash', 'Flash selected USB device', async context => {
    const args = await context.arguments();
    return command('firmware-flash', [
        await args.requiredValue('board'), await args.requiredValue('port'), await args.requiredValue('confirm'),
    ]);
}, {commandOptions: {
    description: 'macOS/Linux only. Refuses an occupied port. Stop any installed companion service first.',
    confirmationMessage: 'Replace firmware and the character on the selected device? Confirm the physical board model first.',
    arguments: [
        boardInput,
        {name: 'port', label: 'USB port (/dev/...)', inputType: InputType.Text, required: true},
        {name: 'confirm', label: 'Type FLASH to replace firmware', inputType: InputType.Text, required: true},
    ],
}});

await builder.build().run();
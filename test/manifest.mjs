/**
 * Manifest and host-compatibility assertions for the published bundle.
 *
 * These are the checks DSH itself performs on an installed bundle: the patch
 * file the profile composes, the `exports` the Client module graph resolves,
 * the display metadata the plugin card reads, and — when a dsh installation can
 * be found — the real `evaluatePluginCompatibility` gate from
 * `@deepseek-ai/dsh-app-boot` against the real runtime version.
 *
 * The gate is what turns `peerDependencies` into "declared supported dsh
 * versions": a version outside the range blocks installation and activation.
 * Run with `npm test` (or `node test/manifest.mjs`).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

let failures = 0;
let passed = 0;
/** Register one assertion with a readable name; failures keep the suite going. */
function check(name, run) {
	try {
		run();
		passed += 1;
	} catch (error) {
		failures += 1;
		console.error(`FAIL ${name}\n     ${error.message}`);
	}
}

/** The declared support range, from the one place DSH enforces it. */
const declaredRange = manifest.peerDependencies['@deepseek-ai/dsh'];

check('identity and packaging fields are present', () => {
	assert.equal(manifest.name, 'dsh-live-turn-stats');
	assert.equal(manifest.type, 'module');
	assert.match(manifest.version, /^\d+\.\d+\.\d+/);
	assert.equal(manifest.license, 'MIT');
});

check('the bundle patch exists and inserts this package name', () => {
	const patch = manifest.dsh.bundle.patch;
	assert.equal(typeof patch, 'string');
	const file = join(root, patch);
	assert.ok(existsSync(file), `${patch} must exist`);
	const text = readFileSync(file, 'utf8');
	assert.match(text, /- insert:/, 'the patch must be an insert list');
	assert.ok(text.includes(`name: ${manifest.name}`), 'the inserted row must name this package');
});

check('exports resolve to existing files', () => {
	for (const [key, target] of Object.entries(manifest.exports)) {
		if (key.includes('*')) continue;
		assert.ok(existsSync(join(root, target)), `exports["${key}"] -> ${target} must exist`);
	}
	assert.equal(manifest.exports['./client'], './client.js', 'the Client half is resolved through ./client');
});

check('the client declaration matches what the browser half needs', () => {
	assert.equal(manifest.dsh.client.platform, 'web');
	assert.equal(manifest.dsh.client.immediately, true, 'a composer pill must be loaded at boot');
	assert.deepEqual(manifest.dsh.client.inject, [
		'@deepseek-ai/dsh-api-session-controller',
		'@deepseek-ai/dsh-client-locale',
		'@deepseek-ai/dsh-client-ui-chat',
	], 'the prefetch list must name the packages whose client halves this pill needs');
	for (const ns of ['en', 'zh']) {
		const file = join(root, 'locale', `${ns}.json`);
		assert.ok(existsSync(file), `locale/${ns}.json is the plugin-card text`);
		assert.equal(typeof JSON.parse(readFileSync(file, 'utf8')).meta.title, 'string');
	}
});

check('the published file set covers everything the runtime reads', () => {
	// npm always publishes package.json, README and LICENSE; every other file the
	// runtime reads must be listed, because a git or registry install ships this
	// list and nothing else.
	const listed = manifest.files;
	for (const needed of ['index.js', 'client.js', manifest.dsh.bundle.patch.replace(/^\.\//, '')]) {
		assert.ok(listed.includes(needed), `${needed} must be published`);
	}
	assert.ok(listed.includes('locale'), 'the plugin-card locale directory must be published');
	assert.deepEqual(readdirSync(join(root, 'locale')).sort(), ['en.json', 'zh.json']);
});

check('the top-level engines.dsh range restates the enforced peer range', () => {
	// Since dsh 0.2.1 `evaluatePluginCompatibility` reads an own top-level
	// `engines.dsh` FIRST and only falls back to peerDependencies when that is
	// absent, and dshmarket lists on the same field. The two must agree.
	assert.equal(typeof declaredRange, 'string');
	assert.ok(declaredRange.trim() !== '');
	assert.equal(manifest.engines.dsh, declaredRange, 'top-level engines.dsh must not contradict the gate');
});

check('the dsh.engines badge copy agrees with it too', () => {
	assert.equal(manifest.dsh.engines.dsh, declaredRange, 'the badge copy must not contradict the gate');
});

// ---------------------------------------------------------------------------
// The real gate: read the installed dsh's own compatibility evaluator.
// ---------------------------------------------------------------------------

/** Candidate dsh-app-boot directories, most specific first. */
function appBootCandidates() {
	const candidates = [];
	if (typeof process.env.DSH_APP_BOOT_DIR === 'string') candidates.push(process.env.DSH_APP_BOOT_DIR);
	const fromArgv = process.argv.find((value) => /[\\/]dsh[\\/].*\.(?:js|cjs|mjs)$/.test(value));
	if (fromArgv !== undefined) {
		let dir = dirname(resolve(fromArgv));
		for (let depth = 0; depth < 6; depth += 1) {
			candidates.push(join(dir, 'node_modules', '@deepseek-ai', 'dsh-app-boot'));
			dir = dirname(dir);
		}
	}
	// A Desktop install keeps every runtime it manages under
	// <appData>/DSH/data/versions; those are the runtimes this bundle actually
	// loads into, so they outrank a global npm install that may sit on an older
	// release. Newest name first, numerically.
	const desktopVersions = process.env.APPDATA === undefined
		? undefined
		: join(process.env.APPDATA, 'DSH', 'data', 'versions');
	if (desktopVersions !== undefined && existsSync(desktopVersions)) {
		let names = [];
		try {
			names = readdirSync(desktopVersions);
		} catch {
			// An unreadable versions directory just skips this source.
		}
		for (const name of names.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
			candidates.push(join(desktopVersions, name, 'node_modules', '@deepseek-ai', 'dsh-app-boot'));
		}
	}
	const globalRoots = [
		process.env.APPDATA === undefined ? undefined : join(process.env.APPDATA, 'npm', 'node_modules'),
		join(homedir(), '.npm-global', 'lib', 'node_modules'),
		'/usr/local/lib/node_modules',
	];
	for (const globalRoot of globalRoots) {
		if (globalRoot === undefined) continue;
		candidates.push(join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-app-boot'));
	}
	candidates.push(join(root, 'node_modules', '@deepseek-ai', 'dsh-app-boot'));
	return candidates;
}

const appBoot = appBootCandidates().find((dir) => existsSync(join(dir, 'lib', 'index.js'))) ?? null;

if (appBoot === null) {
	console.log(`SKIP host compatibility gate: no installed @deepseek-ai/dsh-app-boot found; declared range ${declaredRange}`);
} else {
	try {
		const gate = await import(pathToFileURL(join(appBoot, 'lib', 'index.js')).href);
		const runtime = gate.getDshRuntimeVersion();
		console.log(`host compatibility gate: ${appBoot} (dsh ${runtime})`);
		check(`the installed dsh ${runtime} satisfies ${declaredRange}`, () => {
			const issue = gate.evaluatePluginCompatibility(manifest, {}, runtime);
			assert.equal(issue, undefined, issue === undefined ? '' : `peers refused: ${JSON.stringify(issue.peers)}`);
		});
		check('an older dsh is refused, so the declaration has teeth', () => {
			const issue = gate.evaluatePluginCompatibility(manifest, {}, '0.1.0');
			assert.notEqual(issue, undefined, 'dsh 0.1.0 must not be silently accepted');
			assert.equal(issue.name, manifest.name);
			assert.equal(issue.exempted, false);
		});
		check('a later release line is refused', () => {
			assert.notEqual(gate.evaluatePluginCompatibility(manifest, {}, '0.3.0'), undefined, 'the <0.3.0-0 ceiling must hold');
		});
	} catch (error) {
		console.log(`SKIP host compatibility gate: ${error.message}`);
	}
}

if (failures > 0) {
	console.error(`\n${passed} check(s) passed before the ${failures} failure(s) above.`);
	process.exitCode = 1;
} else {
	console.log(`${passed} checks passed`);
}

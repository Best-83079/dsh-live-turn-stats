/**
 * Offline assertions for the newest-Turn fold behind the pill.
 *
 * The browser half is loaded here through a `window.__ModuleLoader__` shim with
 * a minimal React stub: every assertion targets the pure window fold, so the
 * figures can be checked without a running Harness or a browser.
 *
 * Run with `npm test` (or `node test/fold.mjs`).
 */
import assert from 'node:assert/strict';

const registrations = [];
globalThis.window = {
	__ModuleLoader__: {
		load(registration) {
			registrations.push(registration);
		},
	},
};

// The bundle is plain CJS-shaped browser code: importing it executes
// `window.__ModuleLoader__.load`, which the shim above captured.
await import(new URL('../client.js', import.meta.url).href);

assert.equal(registrations.length, 1, 'client.js must register exactly one module');
assert.equal(registrations[0].id, 'dsh-live-turn-stats', 'module id must equal the package name');

const reactStub = {
	Fragment: 'fragment',
	createElement: () => null,
	useCallback: (fn) => fn,
	useEffect: () => undefined,
	useLayoutEffect: () => undefined,
	useMemo: (fn) => fn(),
	useRef: (value) => ({ current: value ?? null }),
	useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
	useSyncExternalStore: () => null,
};
const reactDomStub = { createPortal: () => null };
const module_ = registrations[0].factory((spec) => {
	if (spec === 'react') return reactStub;
	if (spec === 'react-dom') return reactDomStub;
	throw new Error(`unexpected require(${JSON.stringify(spec)})`);
});
const {
	foldEntries, summarise, readSummary, firstTokenTimeInStream, isTokenDelta,
	formatSeconds, formatSpeed, formatCount, displayFigures,
} = module_.internals;

/** One durable Session event as the window carries it. */
const durable = (event) => ({ type: 'event', event });
/** One client-only live chunk row. */
const transient = (event) => ({ type: 'transient', event });
/** Event envelope: the fold reads only `type`, `time`, and `data`. */
const ev = (type, time, data) => ({ type, time, data });
/** Live text delta as an in-flight Step emits it. */
const delta = (time, turn, step, text) => transient(ev('assistant/live-chunk', time, {
	attemptId: 'attempt-1', turn, step, chunk: { type: 'text-delta', index: 0, text },
}));
/** Live usage chunk: the last thing a stream reports before `finish`. */
const usageChunk = (time, turn, step, outputTokens) => transient(ev('assistant/live-chunk', time, {
	attemptId: 'attempt-1', turn, step, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens } },
}));
/** Durable settlement of one Step. */
const settlement = (time, turn, step, stream, usage) => durable(ev('assistant/message', time, {
	turn, step, message: { id: `m-${turn}-${step}`, content: [] }, stream, usage,
}));
/** The pill's own locale interpolation, without the locale service. */
const fakeT = (key, params) => (params === undefined ? key : key.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match)));

const checks = [];
/** Register one assertion with a readable name; failures abort the run. */
function check(name, run) {
	try {
		run();
		checks.push(name);
	} catch (error) {
		console.error(`FAIL ${name}\n     ${error.message}`);
		process.exitCode = 1;
	}
}

check('live stream: TTFT lands with the first token, speed waits for usage', () => {
	const entries = [
		durable(ev('turn/start', 1000, { turn: 7 })),
		durable(ev('step/start', 1100, { turn: 7, step: 1 })),
		delta(1150, 7, 1, ''),
		delta(1600, 7, 1, 'He'),
	];
	const summary = summarise(foldEntries(entries));
	assert.equal(summary.turn, 7);
	assert.equal(summary.steps, 1);
	assert.equal(summary.ttftMs, 500);
	assert.equal(summary.firstTokenAt, 1600);
	assert.equal(summary.pending, 'generating');
	assert.equal(summary.tps, null);
	assert.equal(summary.closed, false);
});

check('live stream: a usage chunk yields the Turn speed before settlement', () => {
	const entries = [
		durable(ev('turn/start', 1000, { turn: 7 })),
		durable(ev('step/start', 1100, { turn: 7, step: 1 })),
		delta(1600, 7, 1, 'He'),
		usageChunk(2600, 7, 1, 50),
	];
	const summary = summarise(foldEntries(entries));
	assert.equal(summary.ttftMs, 500);
	assert.equal(summary.decodeTokens, 50);
	assert.equal(summary.decodeMs, 1000);
	assert.equal(summary.tps, 50);
	assert.equal(summary.pending, null);
});

check('incremental appends equal a full refold', () => {
	const entries = [
		durable(ev('turn/start', 1000, { turn: 7 })),
		durable(ev('step/start', 1100, { turn: 7, step: 1 })),
		delta(1600, 7, 1, 'He'),
	];
	const incremental = module_.internals.foldInto(module_.internals.createFold(), entries, 0);
	const appended = entries.concat([usageChunk(2600, 7, 1, 50)]);
	module_.internals.foldInto(incremental, appended, entries.length);
	assert.deepEqual(summarise(incremental), summarise(foldEntries(appended)));
});

check('reload: a durable settlement reproduces TTFT from its packed stream', () => {
	const stream = [{ type: 'text-chunks', time0: 2500, index: 0, dt: [0, 120], texts: ['', 'Hello'] }];
	const entries = [
		durable(ev('turn/start', 2000, { turn: 3 })),
		durable(ev('step/start', 2100, { turn: 3, step: 1 })),
		settlement(3200, 3, 1, stream, { inputTokens: 5, outputTokens: 80 }),
		durable(ev('turn/end', 3300, { turn: 3, reason: 'success' })),
	];
	const summary = summarise(foldEntries(entries));
	assert.equal(summary.ttftMs, 400, 'first token is reconstructed from time0 + dt offsets');
	assert.equal(summary.decodeMs, 700);
	assert.equal(summary.decodeTokens, 80);
	assert.ok(Math.abs(summary.tps - 80 / 0.7) < 1e-9);
	assert.equal(summary.closed, true);
	assert.equal(summary.pending, null);
});

check('a name-bearing Tool-call run starts at its first member', () => {
	const stream = [{ type: 'tool-call-chunks', time0: 2500, index: 0, dt: [50], id: 'c1', name: 'read', args: ['', '{}'] }];
	assert.equal(firstTokenTimeInStream(stream), 2500);
});

check('a Tool-call run without a name starts at its first non-empty fragment', () => {
	const stream = [{ type: 'tool-call-chunks', time0: 2500, index: 0, dt: [40, 60], id: 'c1', args: ['', '', '{}'] }];
	assert.equal(firstTokenTimeInStream(stream), 2600);
});

check('an attempt that committed no message still times its Step', () => {
	const stream = [{ type: 'reasoning-chunks', time0: 1200, index: 0, dt: [30], texts: ['', 'think'] }];
	const entries = [
		durable(ev('turn/start', 1000, { turn: 2 })),
		durable(ev('step/start', 1100, { turn: 2, step: 1 })),
		durable(ev('assistant/attempt', 1500, { turn: 2, step: 1, stream })),
	];
	const summary = summarise(foldEntries(entries));
	assert.equal(summary.ttftMs, 130, 'the token time is time0 plus the offsets before its member');
	assert.equal(summary.pending, 'generating');
});

check('a multi-Step Turn reports its first latency and its total speed', () => {
	const entries = [
		durable(ev('turn/start', 1000, { turn: 1 })),
		durable(ev('step/start', 1100, { turn: 1, step: 1 })),
		delta(1400, 1, 1, 'a'),
		settlement(2000, 1, 1, [], { outputTokens: 30 }),
		durable(ev('step/start', 2100, { turn: 1, step: 2 })),
		delta(2600, 1, 2, 'b'),
		settlement(3600, 1, 2, [], { outputTokens: 60 }),
	];
	const summary = summarise(foldEntries(entries));
	assert.equal(summary.steps, 2);
	assert.equal(summary.ttftMs, 300, 'the Turn answers when its first Step does');
	assert.equal(summary.decodeTokens, 90);
	assert.equal(summary.decodeMs, 1600);
	assert.equal(summary.tps, 90 / 1.6);
});

check('a retry keeps the Step earlier attempt first token', () => {
	const laterStream = [{ type: 'text-chunks', time0: 2000, index: 0, dt: [0], texts: ['second'] }];
	const entries = [
		durable(ev('turn/start', 1000, { turn: 4 })),
		durable(ev('step/start', 1100, { turn: 4, step: 1 })),
		delta(1500, 4, 1, 'first'),
		durable(ev('llm/retry', 1700, { turn: 4, step: 1, attempt: 1, delayMs: 200 })),
		settlement(3000, 4, 1, laterStream, { outputTokens: 10 }),
	];
	const summary = summarise(foldEntries(entries));
	assert.equal(summary.firstTokenAt, 1500);
	assert.equal(summary.ttftMs, 400);
});

check('a closed Turn without a token reports nothing at all', () => {
	const earlier = [
		durable(ev('turn/start', 500, { turn: 1 })),
		durable(ev('step/start', 600, { turn: 1, step: 1 })),
		delta(900, 1, 1, 'x'),
		durable(ev('turn/end', 1000, { turn: 1, reason: 'success' })),
	];
	assert.notEqual(summarise(foldEntries(earlier)), null);
	const withEmptyLatest = earlier.concat([
		durable(ev('turn/start', 2000, { turn: 2 })),
		durable(ev('step/start', 2100, { turn: 2, step: 1 })),
		durable(ev('turn/end', 2200, { turn: 2, reason: 'error' })),
	]);
	assert.equal(summarise(foldEntries(withEmptyLatest)), null, 'a stale earlier Turn must not be relabelled 本轮');
});

check('a running Turn with no Step yet counts from the Turn start', () => {
	const entries = [
		durable(ev('turn/start', 5000, { turn: 9 })),
		transient(ev('assistant/live-chunk', 5200, { attemptId: 'a', turn: 9, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } })),
	];
	const summary = summarise(foldEntries(entries));
	assert.equal(summary.ttftMs, null);
	assert.equal(summary.pending, 'awaiting');
	assert.equal(summary.awaitingSince, 5000);
});

check('a window that starts mid-Step still times from its step/start', () => {
	const entries = [
		durable(ev('step/start', 1100, { turn: 9, step: 2 })),
		delta(1500, 9, 2, 'mid'),
	];
	const summary = summarise(foldEntries(entries));
	assert.equal(summary.turn, 9);
	assert.equal(summary.ttftMs, 400);
	assert.equal(summary.pending, 'generating');
});

check('malformed usage is ignored, not trusted', () => {
	const entries = [
		durable(ev('turn/start', 1000, { turn: 6 })),
		durable(ev('step/start', 1100, { turn: 6, step: 1 })),
		delta(1400, 6, 1, 'x'),
		usageChunk(2400, 6, 1, -1),
	];
	const summary = summarise(foldEntries(entries));
	assert.equal(summary.decodeTokens, 0);
	assert.equal(summary.tps, null);
	assert.equal(summary.pending, 'generating');
});

check('stale events of an older Turn never reopen it', () => {
	const entries = [
		durable(ev('step/start', 1000, { turn: 3, step: 1 })),
		delta(1300, 3, 1, 'x'),
		durable(ev('step/start', 2000, { turn: 4, step: 1 })),
		delta(2300, 4, 1, 'y'),
		durable(ev('assistant/message', 2400, { turn: 3, step: 1, message: { id: 'q', content: [] }, stream: [], usage: { outputTokens: 99 } })),
	];
	const summary = summarise(foldEntries(entries));
	assert.equal(summary.turn, 4);
	assert.equal(summary.ttftMs, 300);
	assert.equal(summary.decodeTokens, 0, 'the late Turn-3 settlement is not folded into Turn 4');
});

check('chunk classification matches the Host reader', () => {
	assert.equal(isTokenDelta({ type: 'text-delta', index: 0, text: '' }), false);
	assert.equal(isTokenDelta({ type: 'text-delta', index: 0, text: 'x' }), true);
	assert.equal(isTokenDelta({ type: 'reasoning-delta', index: 0, text: ' ' }), true);
	assert.equal(isTokenDelta({ type: 'tool-call-delta', index: 0, id: 'c', argumentsDelta: '' }), false);
	assert.equal(isTokenDelta({ type: 'tool-call-delta', index: 0, id: 'c', name: 'read', argumentsDelta: '' }), true);
	assert.equal(isTokenDelta({ type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }), false);
	assert.equal(isTokenDelta(null), false);
});

check('formatted figures match the shipped dialog shape', () => {
	assert.equal(formatSeconds(3600, fakeT), '3.6s');
	assert.equal(formatSeconds(162000, fakeT), '2m42s');
	assert.equal(formatSeconds(-5, fakeT), '0s');
	assert.equal(formatSpeed(142.4, fakeT), '142 tok/s');
	assert.equal(formatSpeed(3.55, fakeT), '3.6 tok/s');
	assert.equal(formatCount(0), '0');
	assert.equal(formatCount(1234), '1,234');
	assert.equal(formatCount(1234567), '1,234,567');
});

check('the panel counts the wait up while the first token is pending', () => {
	const summary = summarise(foldEntries([
		durable(ev('turn/start', 1000, { turn: 12 })),
		durable(ev('step/start', 1100, { turn: 12, step: 1 })),
	]));
	const figures = displayFigures(summary, 3300, fakeT);
	assert.equal(figures.label, 'Turn waiting for first token 2.2s', 'the trigger and the panel share one string');
	assert.equal(figures.rows[0].value, 'waiting for first token 2.2s');
	assert.equal(figures.rows[1].value, 'not recorded');
	assert.equal(figures.rows[2].value, 'not recorded');
	assert.equal(figures.rows[3].value, 'not recorded');
	assert.equal(figures.rows[4].value, '1');
});

check('the panel reports the settled Turn with grouped tokens', () => {
	const summary = summarise(foldEntries([
		durable(ev('turn/start', 1000, { turn: 12 })),
		durable(ev('step/start', 1100, { turn: 12, step: 1 })),
		delta(1600, 12, 1, 'He'),
		settlement(2600, 12, 1, [], { outputTokens: 1234 }),
		durable(ev('turn/end', 2700, { turn: 12, reason: 'success' })),
	]));
	const figures = displayFigures(summary, 9000, fakeT);
	assert.equal(figures.label, 'Turn 0.5s · 1234 tok/s');
	assert.equal(figures.live, null);
	assert.equal(figures.rows[0].value, '0.5s');
	assert.equal(figures.rows[1].value, '1234 tok/s');
	assert.equal(figures.rows[2].value, '1,234');
	assert.equal(figures.rows[3].value, '1s');
	assert.equal(figures.rows[4].value, '1');
});

check('the panel names the generating wait before usage arrives', () => {
	const summary = summarise(foldEntries([
		durable(ev('turn/start', 1000, { turn: 3 })),
		durable(ev('step/start', 1100, { turn: 3, step: 1 })),
		delta(1600, 3, 1, 'He'),
	]));
	const figures = displayFigures(summary, 4000, fakeT);
	assert.equal(figures.label, 'Turn 0.5s · generating 2.4s');
	assert.equal(figures.rows[0].value, '0.5s');
	assert.equal(figures.rows[1].value, 'generating 2.4s');
});

check('the read cache reuses one summary per window and follows appends', () => {
	const base = [
		durable(ev('turn/start', 1000, { turn: 7 })),
		durable(ev('step/start', 1100, { turn: 7, step: 1 })),
	];
	const appended = [delta(1600, 7, 1, 'He')];
	let window = { entries: base, hasMore: false, revision: 1, change: { kind: 'replace', entries: base } };
	const liveSource = { getSnapshot: () => window, subscribe: () => () => {} };
	const first = readSummary(liveSource);
	assert.equal(readSummary(liveSource), first, 'the same window object must return the same summary identity');
	assert.equal(first.pending, 'awaiting');
	window = { entries: base.concat(appended), hasMore: false, revision: 2, change: { kind: 'append', entries: appended } };
	const second = readSummary(liveSource);
	assert.notEqual(second, first);
	assert.equal(second.ttftMs, 500);
	assert.deepEqual(second, summarise(foldEntries(window.entries)));

	// A settle frame replaces the attempt's transient rows with its durable
	// settlement, so the fold must restart rather than continue at the tail.
	const stream = [{ type: 'text-chunks', time0: 1600, index: 0, dt: [0], texts: ['He'] }];
	const settled = base.concat([settlement(3000, 7, 1, stream, { outputTokens: 40 })]);
	window = { entries: settled, hasMore: false, revision: 3, change: { kind: 'settle-assistant', attemptId: 'attempt-1' } };
	const third = readSummary(liveSource);
	assert.equal(third.ttftMs, 500, 'the settled stream reproduces the live first token');
	assert.equal(third.decodeTokens, 40);
	assert.deepEqual(third, summarise(foldEntries(settled)));
});

if (process.exitCode === 1) {
	console.error(`\n${checks.length} check(s) passed before the failures above.`);
} else {
	console.log(`${checks.length} checks passed`);
}

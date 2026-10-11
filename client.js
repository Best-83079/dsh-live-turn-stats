/**
 * Latest-Turn live statistics pill.
 *
 * The shipped session-stats pill reports whole-session averages: its TTFT is
 * `ttftMs / ttftSteps` over every Step in the log, and its TPS divides every
 * token ever reported by every decode window ever recorded. That answers "how
 * is this session doing", not "how is this answer doing".
 *
 * This pill answers the second question from data the browser already has. It
 * subscribes to the current Session's contiguous event window
 * (`ctx.sessions.binding(sessionId).eventSource`) and folds the **newest Turn**
 * only:
 *
 * - TTFT is the newest Turn's first Step that carries both a `step/start`
 *   boundary and a first output token — the time from that Step's start to the
 *   first non-empty text, reasoning, or Tool-call delta. While the Turn is still
 *   waiting for its first token the pill counts that wait up live.
 * - Output speed divides the Turn's reported output tokens by its recorded
 *   decode wall time (`firstTokenTime` → settlement), exactly as the shipped
 *   dialog defines TPS, but scoped to the Turn. Before any attempt reports
 *   usage the pill shows how long the current answer has been generating.
 *
 * Both figures come from recorded event times, never from an invented span. The
 * live chunks of an in-flight requirement live in the window as
 * `assistant/live-chunk` transient rows, and the durable settlement embeds the
 * attempt's compact timed stream (`assistant/message.stream`), which is what
 * keeps TTFT correct after a reload — when the transient rows are gone.
 *
 * The bundle imports nothing but `react`: every other value comes from a Cordis
 * service (`slots`, `sessions`, `locale`) resolved at runtime, so a renamed or
 * absent Harness package degrades this pill instead of breaking the client
 * module table.
 */

window.__ModuleLoader__.load({
	id: 'dsh-live-turn-stats',
	factory(require) {
		const React = require('react');
		const h = React.createElement;

		/** Client locale namespace owned by this bundle. */
		const NS = 'live-turn-stats';

		/** Readable keys double as the English fallback text. */
		const EN = {
			'Turn': 'Turn',
			'waiting for first token': 'waiting for first token',
			'generating': 'generating',
			'{seconds}s': '{seconds}s',
			'{minutes}m{seconds}s': '{minutes}m{seconds}s',
			'{tps} tok/s': '{tps} tok/s',
			'First token (TTFT)': 'First token (TTFT)',
			'Output speed (TPS)': 'Output speed (TPS)',
			'Output tokens': 'Output tokens',
			'Decode time': 'Decode time',
			'Steps': 'Steps',
			'not recorded': 'not recorded',
			'Latest turn only — the neighbouring pill averages the whole session.': 'Latest turn only — the neighbouring pill averages the whole session.',
			'This pill needs the Session event window (ctx.sessions), which this client does not provide.': 'This pill needs the Session event window (ctx.sessions), which this client does not provide.',
		};

		const ZH = {
			'Turn': '本轮',
			'waiting for first token': '等待首字',
			'generating': '生成中',
			'{seconds}s': '{seconds}秒',
			'{minutes}m{seconds}s': '{minutes}分{seconds}秒',
			'{tps} tok/s': '{tps} tok/s',
			'First token (TTFT)': '首 token 延迟（TTFT）',
			'Output speed (TPS)': '输出速度（TPS）',
			'Output tokens': '输出 token',
			'Decode time': '解码用时',
			'Steps': '步数',
			'not recorded': '未记录',
			'Latest turn only — the neighbouring pill averages the whole session.': '只统计最新一轮，旁边的「会话统计」是整个会话的平均值。',
			'This pill needs the Session event window (ctx.sessions), which this client does not provide.': '这个胶囊需要会话事件窗口（ctx.sessions），当前客户端没有提供。',
		};

		/**
		 * Pill geometry: the shipped stats pill's row metrics, so the two sit on one
		 * line. Theme tokens only, so light and dark follow the host.
		 * @param pending - whether a live figure is still being counted up.
		 * @returns the pill's inline style.
		 */
		function pillStyle(pending) {
			return {
				boxSizing: 'border-box',
				minWidth: 0,
				maxWidth: '100%',
				color: pending ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
				font: 'inherit',
				fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
				lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
				fontVariantNumeric: 'tabular-nums',
				whiteSpace: 'nowrap',
				borderRadius: 999,
				display: 'inline-flex',
				alignItems: 'center',
				gap: 6,
				padding: '1px 8px',
			};
		}

		/** Label geometry: the pill clips a long figure instead of widening the row. */
		const LABEL_STYLE = { textOverflow: 'ellipsis', minWidth: 0, overflow: 'hidden' };

		//#region The newest Turn's live figures
		/**
		 * Whether one stream chunk carries the model's first output token —
		 * the port of `isTokenDelta` from `@deepseek-ai/dsh-llm`, so the fold
		 * agrees with the Host projection and the Trajectory view about where
		 * latency ends and decoding starts.
		 * @param chunk - any stream chunk.
		 * @returns whether the chunk carries output.
		 */
		function isTokenDelta(chunk) {
			if (chunk === null || typeof chunk !== 'object') return false;
			if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return chunk.text !== '';
			if (chunk.type === 'tool-call-delta') return chunk.argumentsDelta !== '' || chunk.name !== undefined;
			return false;
		}

		/**
		 * First member time one packed delta run accepts: members of a packed run
		 * carry only their offset from `time0`, so the exact instant of a delta is
		 * reconstructed by summing the deltas before it.
		 * @param run - one packed `*-chunks` record.
		 * @param predicate - member acceptance test.
		 * @returns the accepted member's time, or undefined when none qualifies.
		 */
		function firstRunMemberTime(run, predicate) {
			const fragments = run.type === 'tool-call-chunks' ? run.args : run.texts;
			if (!Array.isArray(fragments) || !Array.isArray(run.dt)) return undefined;
			let time = run.time0;
			for (let index = 0; index < fragments.length; index += 1) {
				if (index > 0) time += run.dt[index - 1];
				if (predicate(fragments[index])) return time;
			}
			return undefined;
		}

		/**
		 * First token time of one compact durable stream — the port of
		 * `assistantStreamFirstTokenTime`, reached here so a reloaded Session
		 * keeps exact TTFT without its transient live chunks.
		 * @param stream - `assistant/message` / `assistant/attempt` stream records.
		 * @returns the first token's time, or undefined when the stream carries none.
		 */
		function firstTokenTimeInStream(stream) {
			if (!Array.isArray(stream)) return undefined;
			for (const record of stream) {
				if (record === null || typeof record !== 'object') continue;
				if (record.type === 'chunk') {
					if (isTokenDelta(record.chunk)) return record.time;
					continue;
				}
				if (record.type !== 'text-chunks' && record.type !== 'reasoning-chunks' && record.type !== 'tool-call-chunks') continue;
				if (record.type === 'tool-call-chunks' && record.name !== undefined) return record.time0;
				const time = firstRunMemberTime(record, (fragment) => fragment !== '');
				if (time !== undefined) return time;
			}
			return undefined;
		}

		/**
		 * Provider-reported output tokens, ignored when malformed — the same guard
		 * the shipped dialog applies to a settled node's usage.
		 * @param usage - provider usage value from a message or a usage chunk.
		 * @returns the token count, or null when it is not a usable number.
		 */
		function outputTokensOf(usage) {
			if (usage === null || typeof usage !== 'object') return null;
			const value = usage.outputTokens;
			return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
		}

		/** One Step's timing facts inside the folded Turn. */
		function createStep(step) {
			return {
				step,
				startTime: null,
				firstTokenTime: null,
				decodeEndTime: null,
				outputTokens: null,
			};
		}

		/** Empty accumulator: only the newest Turn is ever described. */
		function createFold() {
			return { entries: null, index: 0, turn: null };
		}

		/**
		 * Open, adopt, or reject the Turn an event belongs to. The window is a
		 * contiguous slice of one log, so a Turn number only ever moves forward;
		 * an event for an older Turn is stale window content and is dropped.
		 * @param fold - running accumulator.
		 * @param turn - Turn number from the event payload.
		 * @param time - event time used as the Turn's fallback start.
		 * @returns the Turn when the event belongs to the newest one, else null.
		 */
		function openTurn(fold, turn, time) {
			if (typeof turn !== 'number') return null;
			if (fold.turn !== null && turn === fold.turn.turn) {
				if (fold.turn.startedAt === null) fold.turn.startedAt = time;
				return fold.turn;
			}
			if (fold.turn !== null && turn < fold.turn.turn) return null;
			fold.turn = { turn, closed: false, startedAt: time, steps: [] };
			return fold.turn;
		}

		/**
		 * Resolve one Step of the Turn, creating it when the window reached it
		 * without its `step/start` boundary.
		 * @param turn - owning Turn.
		 * @param step - Step number from the event payload.
		 * @returns the Step, or null when the payload carries no Step number.
		 */
		function stepOf(turn, step) {
			if (typeof step !== 'number') return null;
			const last = turn.steps[turn.steps.length - 1];
			if (last !== undefined && last.step === step) return last;
			for (const candidate of turn.steps) if (candidate.step === step) return candidate;
			const created = createStep(step);
			turn.steps.push(created);
			return created;
		}

		/**
		 * Apply one window entry to the accumulator. Unrelated event types return
		 * without touching the Turn, so the fold stays cheap on a busy stream.
		 * @param fold - running accumulator.
		 * @param event - durable Session event or transient live chunk.
		 */
		function applyEvent(fold, event) {
			const type = event.type;
			if (type !== 'turn/start' && type !== 'turn/end' && type !== 'step/start' && type !== 'assistant/live-chunk' && type !== 'assistant/message' && type !== 'assistant/attempt') return;
			const data = event.data;
			if (data === null || typeof data !== 'object') return;
			const time = typeof event.time === 'number' ? event.time : null;
			if (type === 'turn/start') {
				openTurn(fold, data.turn, time);
				return;
			}
			if (type === 'turn/end') {
				const turn = fold.turn !== null && fold.turn.turn === data.turn ? fold.turn : null;
				if (turn !== null) turn.closed = true;
				return;
			}
			const turn = openTurn(fold, data.turn, time);
			if (turn === null) return;
			const step = stepOf(turn, data.step);
			if (step === null) return;
			if (type === 'step/start') {
				if (step.startTime === null) step.startTime = time;
				return;
			}
			if (type === 'assistant/live-chunk') {
				const chunk = data.chunk;
				if (isTokenDelta(chunk) && step.firstTokenTime === null) step.firstTokenTime = time;
				if (chunk !== null && typeof chunk === 'object' && chunk.type === 'usage') {
					const tokens = outputTokensOf(chunk.usage);
					if (tokens !== null) {
						step.outputTokens = tokens;
						step.decodeEndTime = time;
					}
				}
				return;
			}
			// assistant/message and assistant/attempt both embed the attempt's timed
			// stream; the message additionally settles the Step and carries usage.
			if (step.firstTokenTime === null) {
				const first = firstTokenTimeInStream(data.stream);
				if (first !== undefined) step.firstTokenTime = first;
			}
			if (type !== 'assistant/message') return;
			const tokens = outputTokensOf(data.usage);
			if (tokens !== null) {
				step.outputTokens = tokens;
				step.decodeEndTime = time;
			}
		}

		/**
		 * Fold window entries into the accumulator, continuing from the entry the
		 * previous pass stopped at.
		 * @param fold - accumulator to extend.
		 * @param entries - the window's complete ordered entry list.
		 * @param from - first entry index to read.
		 * @returns the same accumulator.
		 */
		function foldInto(fold, entries, from) {
			fold.entries = entries;
			for (let index = from; index < entries.length; index += 1) {
				const entry = entries[index];
				if (entry === null || typeof entry !== 'object') continue;
				const event = entry.event;
				if (event === null || typeof event !== 'object') continue;
				applyEvent(fold, event);
			}
			fold.index = entries.length;
			return fold;
		}

		/**
		 * Fold a complete entry list from scratch.
		 * @param entries - the window's complete ordered entry list.
		 * @returns a fresh accumulator.
		 */
		function foldEntries(entries) {
			return foldInto(createFold(), Array.isArray(entries) ? entries : [], 0);
		}

		/**
		 * Describe the newest Turn, or nothing when it carries no first token yet
		 * and can no longer gain one.
		 *
		 * `pending` names the live state the pill counts up: `awaiting` until the
		 * Turn's first token lands, `generating` while the answer streams before
		 * any attempt reported usage, and null once a real figure can be shown.
		 * @param fold - folded accumulator.
		 * @returns display-ready newest-Turn figures, or null.
		 */
		function summarise(fold) {
			const turn = fold.turn;
			if (turn === null) return null;
			let ttftMs = null;
			let firstTokenAt = null;
			let decodeMs = 0;
			let decodeTokens = 0;
			let tokenSteps = 0;
			for (const step of turn.steps) {
				if (ttftMs === null && step.startTime !== null && step.firstTokenTime !== null) {
					ttftMs = Math.max(0, step.firstTokenTime - step.startTime);
					firstTokenAt = step.firstTokenTime;
				}
				if (step.firstTokenTime !== null && step.decodeEndTime !== null && step.outputTokens !== null) {
					decodeMs += Math.max(0, step.decodeEndTime - step.firstTokenTime);
					decodeTokens += step.outputTokens;
					tokenSteps += 1;
				}
			}
			// A closed Turn that never produced a token has nothing to report, and a
			// stale figure from an earlier Turn would be a lie about "本轮".
			if (ttftMs === null && turn.closed) return null;
			const newest = turn.steps.length === 0 ? null : turn.steps[turn.steps.length - 1];
			return {
				turn: turn.turn,
				closed: turn.closed,
				steps: turn.steps.length,
				ttftMs,
				firstTokenAt,
				decodeMs,
				decodeTokens,
				tokenSteps,
				tps: decodeMs > 0 ? decodeTokens / (decodeMs / 1000) : null,
				awaitingSince: ttftMs !== null ? null : (newest !== null && newest.startTime !== null ? newest.startTime : turn.startedAt),
				pending: ttftMs === null ? 'awaiting' : tokenSteps === 0 && !turn.closed ? 'generating' : null,
			};
		}

		/** Per-source read cache; a window object is immutable per publication. */
		const summaries = new WeakMap();

		/**
		 * Read one Session's newest-Turn figures, reusing the folded accumulator
		 * when the window only grew at its tail (the streaming case) and refolding
		 * when history was prepended or a settled attempt replaced its live rows.
		 * @param source - the Session's event source.
		 * @returns display-ready figures, or null.
		 */
		function readSummary(source) {
			const window = source.getSnapshot();
			const cached = summaries.get(source);
			if (cached !== undefined && cached.window === window) return cached.summary;
			const entries = window !== null && typeof window === 'object' && Array.isArray(window.entries) ? window.entries : [];
			const change = window !== null && typeof window === 'object' ? window.change : null;
			const appended = cached !== undefined
				&& change !== null && typeof change === 'object' && change.kind === 'append' && Array.isArray(change.entries)
				&& entries.length === cached.window.entries.length + change.entries.length;
			const fold = appended ? foldInto(cached.fold, entries, cached.fold.index) : foldEntries(entries);
			const summary = summarise(fold);
			summaries.set(source, { window, fold, summary });
			return summary;
		}

		/**
		 * Compact duration: `45.2s` under a minute, `2m42s` from there on — the
		 * shipped dialog's own shape, in this namespace's own words.
		 * @param ms - duration in milliseconds.
		 * @param t - translate seat.
		 * @returns display string.
		 */
		function formatSeconds(ms, t) {
			const seconds = Math.max(0, ms) / 1000;
			if (seconds < 60) return t('{seconds}s', { seconds: Math.round(seconds * 10) / 10 });
			const whole = Math.round(seconds);
			return t('{minutes}m{seconds}s', { minutes: Math.floor(whole / 60), seconds: whole % 60 });
		}

		/**
		 * Decode-throughput figure: whole tokens from ten up, one decimal below.
		 * @param tps - tokens per second.
		 * @param t - translate seat.
		 * @returns display string.
		 */
		function formatSpeed(tps, t) {
			const clamped = Math.max(0, tps);
			const value = clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
			return t('{tps} tok/s', { tps: value });
		}
		//#endregion

		return {
			// Only slots, the Session event window, and locale are needed, so the pill
			// appears in any composition that has a conversation.
			inject: ['slots', 'sessions', 'locale'],
			apply(ctx) {
				// The namespace dictionaries are owned by this feature; the bound
				// translator is only a convenience, so a registration failure leaves a
				// readable English fallback instead of an empty pill.
				try {
					ctx.effect(() => ctx.locale.register(NS, 'en', EN));
					ctx.effect(() => ctx.locale.register(NS, 'zh', ZH));
				} catch (error) {
					console.warn('live-turn-stats: locale dictionaries not registered', error);
				}
				let bound = null;
				try {
					bound = ctx.locale.bind(NS);
				} catch (error) {
					console.warn('live-turn-stats: locale namespace not bound', error);
				}
				/** Local copy of the active locale, used when the framework seat misses. */
				const fallback = (key, params) => {
					let dict = EN;
					try {
						const snapshot = ctx.locale.getLocale();
						if (snapshot !== null && typeof snapshot === 'object' && typeof snapshot.active === 'string' && snapshot.active.startsWith('zh')) dict = ZH;
					} catch {
						// keep the English copy
					}
					const template = typeof dict[key] === 'string' ? dict[key] : key;
					if (params === undefined) return template;
					return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
				};
				const translate = (key, params) => {
					if (bound !== null) {
						try {
							const text = bound(key, params);
							if (typeof text === 'string' && text !== key) return text;
						} catch {
							// fall through to the local copy
						}
					}
					return fallback(key, params);
				};

				/** The live event window of one Session, when its binding is retained. */
				const sourceOf = (sessionId) => {
					try {
						const binding = ctx.sessions.binding(sessionId);
						if (binding === undefined || binding === null) return undefined;
						return binding.eventSource;
					} catch (error) {
						console.warn('live-turn-stats: session event window unavailable', error);
						return undefined;
					}
				};

				/**
				 * The pill. It renders nothing until the newest Turn has something to
				 * say, and counts a live wait or generation up once per second.
				 */
				function LiveTurnPill({ sessionId, t }) {
					const tr = typeof t === 'function' ? t : translate;
					const source = sourceOf(sessionId);
					const subscribe = React.useCallback(
						(listener) => (source === undefined ? () => {} : source.subscribe(listener)),
						[source],
					);
					const read = React.useCallback(
						() => (source === undefined ? null : readSummary(source)),
						[source],
					);
					const summary = React.useSyncExternalStore(subscribe, read, read);
					const pending = summary === null ? null : summary.pending;
					const [now, setNow] = React.useState(() => Date.now());
					React.useEffect(() => {
						if (pending === null) return undefined;
						setNow(Date.now());
						const timer = setInterval(() => setNow(Date.now()), 1000);
						return () => clearInterval(timer);
					}, [pending, summary === null ? null : summary.turn]);
					if (summary === null) return null;

					const elapsed = (from) => formatSeconds(Math.max(0, now - (typeof from === 'number' ? from : now)), tr);
					const ttftText = summary.ttftMs === null ? null : formatSeconds(summary.ttftMs, tr);
					const speedText = summary.tps === null ? null : formatSpeed(summary.tps, tr);
					const detail = summary.pending === 'awaiting'
						? `${tr('waiting for first token')} ${elapsed(summary.awaitingSince)}`
						: summary.pending === 'generating'
							? `${tr('generating')} ${elapsed(summary.firstTokenAt)}`
							: speedText;
					const parts = [ttftText, detail].filter((part) => part !== null);
					const label = `${tr('Turn')} ${parts.join(' · ')}`;
					const title = [
						tr('Latest turn only — the neighbouring pill averages the whole session.'),
						`${tr('First token (TTFT)')}: ${ttftText ?? tr('not recorded')}`,
						`${tr('Output speed (TPS)')}: ${speedText ?? tr('not recorded')}`,
						`${tr('Output tokens')}: ${summary.tokenSteps === 0 ? tr('not recorded') : summary.decodeTokens}`,
						`${tr('Decode time')}: ${summary.decodeMs > 0 ? formatSeconds(summary.decodeMs, tr) : tr('not recorded')}`,
						`${tr('Steps')}: ${summary.steps}`,
					].join('\n');

					return h('span', {
						style: pillStyle(summary.pending !== null),
						'data-live-turn-stats': true,
						'data-pending': summary.pending === null ? 'false' : 'true',
						'data-turn': summary.turn,
						title,
					},
						h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, style: { flex: 'none' } },
							h('circle', { cx: 8, cy: 8, r: 5.75, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }),
							h('path', { d: 'M8 4.75V8.4l2.5 1.6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' })),
						h('span', { style: LABEL_STYLE }, label));
				}

				try {
					ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
						name: 'conversation.composer.dock',
						id: 'live-turn-stats',
						// The shipped session-stats cell is order 0, so this lands
						// immediately beside it, before the cost meters.
						order: 0.5,
						locale: NS,
					}, LiveTurnPill));
				} catch (error) {
					console.warn('live-turn-stats: pill not registered', error);
				}
			},
			/**
			 * Test seam: the pure window fold and its formatters, so
			 * `test/fold.mjs` exercises the figures without a browser.
			 */
			internals: {
				foldEntries,
				foldInto,
				createFold,
				summarise,
				readSummary,
				firstTokenTimeInStream,
				isTokenDelta,
				formatSeconds,
				formatSpeed,
			},
		};
	},
});

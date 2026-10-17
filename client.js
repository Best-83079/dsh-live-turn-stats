/**
 * Latest-Turn live statistics pill.
 *
 * The shipped composer statistics report whole-session averages: their TTFT is
 * `ttftMs / ttftSteps` over every Step in the log, and their TPS divides every
 * token ever reported by every decode window ever recorded. That answers "how
 * is this session doing", not "how is this answer doing".
 *
 * Since dsh 0.2.1 those shipped figures are two `conversation.composer.dock`
 * entries rather than one: `activity` (order 0 — Turn and Step counts with the
 * session's output speed, TTFT, LLM time, and Tool time) and `usage` (order 1 —
 * whole-log token total and cache hit). Earlier releases registered a single
 * `stats` entry that rendered both readings inside itself.
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
 * The pill is a button: clicking it opens the shipped stat dialog's own
 * presentation — a fixed, viewport-clamped panel anchored above the trigger,
 * dismissed by an outside press or Escape — carrying the same `dl` rows the
 * session-average dialog uses.
 *
 * The bundle imports nothing but `react` and `react-dom` (both platform seed
 * words): every other value comes from a Cordis service (`slots`, `sessions`,
 * `locale`) resolved at runtime, so a renamed or absent Harness package degrades
 * this pill instead of breaking the client module table.
 */

window.__ModuleLoader__.load({
	id: 'dsh-live-turn-stats',
	factory(require) {
		const React = require('react');
		const ReactDOM = require('react-dom');
		const h = React.createElement;

		/** Client locale namespace owned by this bundle. */
		const NS = 'live-turn-stats';

		/** Readable keys double as the English fallback text. */
		const EN = {
			'Turn': 'Turn',
			'Turn {turn}': 'Turn {turn}',
			'Latest turn stats': 'Latest turn stats',
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
			'Turn {turn}': '第 {turn} 轮',
			'Latest turn stats': '最新一轮统计',
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

		/** Distance between the trigger and its panel. */
		const PANEL_GAP = 8;
		/** Smallest distance the panel keeps from the viewport edges. */
		const PANEL_MARGIN = 12;

		/**
		 * Unplaced panel: laid out but invisible, so the first pass can measure its
		 * real size before it is placed (the shipped dialog's measure pass).
		 */
		const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };

		/**
		 * Trigger geometry: the shipped stats pill's row metrics, so the two sit on
		 * one line, plus the shipped trigger's hover/expanded treatment.
		 * @param active - hovered, focused, or expanded.
		 * @param live - whether a figure is still being counted up.
		 * @returns the trigger's inline style.
		 */
		function triggerStyle(active, live) {
			return {
				boxSizing: 'border-box',
				minWidth: 0,
				maxWidth: '100%',
				color: active || live ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
				background: active ? 'var(--dsw-alias-interactive-bg-hover, transparent)' : 'transparent',
				font: 'inherit',
				fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
				lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
				fontVariantNumeric: 'tabular-nums',
				whiteSpace: 'nowrap',
				border: 'none',
				borderRadius: 'var(--dsw-radius-sm, 8px)',
				cursor: 'pointer',
				display: 'inline-flex',
				alignItems: 'center',
				gap: 6,
				padding: '1px 8px',
			};
		}

		/** Panel chrome: the shipped stat dialog's surface, spacing, and type scale. */
		const PANEL_STYLE = {
			position: 'fixed',
			zIndex: 1100,
			boxSizing: 'border-box',
			width: 'max-content',
			minWidth: 'min(300px, 100vw - 24px)',
			maxWidth: 'min(440px, 100vw - 24px)',
			borderRadius: 'var(--dsw-radius-lg, 12px)',
			background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-overlay))',
			backdropFilter: 'var(--dsw-menu-backdrop-filter, none)',
			boxShadow: 'var(--dsw-elevation-prominent, 0 8px 28px rgba(0, 0, 0, .18))',
			color: 'var(--dsw-alias-label-secondary)',
			cursor: 'default',
			border: 'none',
			padding: 16,
			fontSize: 12,
			lineHeight: '18px',
		};
		/** Title row: primary text on the left, the Turn number on the right. */
		const PANEL_TITLE_STYLE = {
			color: 'var(--dsw-alias-label-primary)',
			display: 'flex',
			justifyContent: 'space-between',
			gap: 16,
			marginBottom: 8,
			fontWeight: 500,
		};
		const PANEL_TITLE_LABEL_STYLE = { display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 };
		const PANEL_TITLE_VALUE_STYLE = { fontVariantNumeric: 'tabular-nums' };
		/** Hairline between the title and the figures, as shipped. */
		const PANEL_RULE_STYLE = { borderTop: '0.5px solid var(--dsw-alias-border-l2)', marginBottom: 10 };
		const PANEL_DETAILS_STYLE = {
			display: 'grid',
			gridTemplateColumns: 'minmax(76px, auto) minmax(0, 1fr)',
			gap: '6px 16px',
			margin: 0,
			color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
		};
		const PANEL_TERM_STYLE = { minWidth: 0, margin: 0 };
		const PANEL_VALUE_STYLE = {
			minWidth: 0,
			margin: 0,
			color: 'var(--dsw-alias-label-secondary)',
			fontVariantNumeric: 'tabular-nums',
			textAlign: 'right',
		};
		const PANEL_NOTE_STYLE = { marginTop: 10, color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))' };

		/** Label geometry: the trigger clips a long figure instead of widening the row. */
		const LABEL_STYLE = { textOverflow: 'ellipsis', minWidth: 0, overflow: 'hidden' };

		/** The trigger's and the panel title's glyph, inheriting the text color. */
		function ClockIcon() {
			return h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, style: { flex: 'none' } },
				h('circle', { cx: 8, cy: 8, r: 5.75, fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }),
				h('path', { d: 'M8 4.75V8.4l2.5 1.6', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }));
		}

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
			return { turn: null };
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
			for (let index = from; index < entries.length; index += 1) {
				const entry = entries[index];
				if (entry === null || typeof entry !== 'object') continue;
				const event = entry.event;
				if (event === null || typeof event !== 'object') continue;
				applyEvent(fold, event);
			}
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
		 * Fold one append batch into the accumulator. A consecutive-revision append
		 * carries exactly the entries that arrived, so the window's own entry array
		 * never has to be materialized — the whole point of the tail fast path.
		 * @param fold - accumulator to extend.
		 * @param entries - the published append delta.
		 * @returns the same accumulator.
		 */
		function foldAppended(fold, entries) {
			for (const entry of entries) {
				if (entry === null || typeof entry !== 'object') continue;
				const event = entry.event;
				if (event === null || typeof event !== 'object') continue;
				applyEvent(fold, event);
			}
			return fold;
		}

		/**
		 * Describe the newest Turn, or nothing when it produced no output at all
		 * and can no longer gain any.
		 *
		 * `pending` names the live state the pill counts up: `awaiting` until the
		 * Turn's first token lands, `generating` while the answer streams before
		 * any attempt reported usage, and null once a real figure can be shown.
		 * A Step whose `step/start` is outside the window never yields a latency,
		 * but its tokens still count — the pill must not call that "waiting for the
		 * first token" while it is visibly streaming.
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
				// The first token's instant is tracked on its own: a Step whose
				// `step/start` fell outside the window still proves output started,
				// even though it can never yield a latency.
				if (step.firstTokenTime !== null && (firstTokenAt === null || step.firstTokenTime < firstTokenAt)) {
					firstTokenAt = step.firstTokenTime;
				}
				if (ttftMs === null && step.startTime !== null && step.firstTokenTime !== null) {
					ttftMs = Math.max(0, step.firstTokenTime - step.startTime);
				}
				if (step.firstTokenTime !== null && step.decodeEndTime !== null && step.outputTokens !== null) {
					decodeMs += Math.max(0, step.decodeEndTime - step.firstTokenTime);
					decodeTokens += step.outputTokens;
					tokenSteps += 1;
				}
			}
			// Only a Turn that produced no output at all has nothing to report; a
			// stale figure from an earlier Turn would be a lie about "本轮".
			if (firstTokenAt === null && turn.closed) return null;
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
				awaitingSince: firstTokenAt !== null ? null : (newest !== null && newest.startTime !== null ? newest.startTime : turn.startedAt),
				pending: firstTokenAt === null ? 'awaiting' : tokenSteps === 0 && !turn.closed ? 'generating' : null,
			};
		}

		/** Per-source read cache; a window object is immutable per publication. */
		const summaries = new WeakMap();

		/**
		 * Read one Session's newest-Turn figures, reusing the folded accumulator
		 * when the window only grew at its tail (the streaming case) and refolding
		 * when history was prepended, an attempt settled, or the window was rebased.
		 *
		 * The tail fast path requires the window's revision to be exactly one ahead
		 * of the window last read. `change` describes only the newest mutation of a
		 * batch, so a length comparison cannot tell a pure append from a batch that
		 * also retired an attempt's live rows (`settleAssistant`, a net-zero length
		 * change) or re-installed a window of the same length; resuming the fold
		 * across such a batch would silently skip the rows it inserted.
		 * @param source - the Session's event source.
		 * @returns display-ready figures, or null.
		 */
		function readSummary(source) {
			const window = source.getSnapshot();
			const cached = summaries.get(source);
			if (cached !== undefined && cached.window === window) return cached.summary;
			const change = window !== null && typeof window === 'object' ? window.change : null;
			const appended = cached !== undefined
				&& change !== null && typeof change === 'object' && change.kind === 'append' && Array.isArray(change.entries)
				&& typeof window.revision === 'number' && cached.window.revision === window.revision - 1;
			let fold;
			if (appended) {
				fold = foldAppended(cached.fold, change.entries);
			} else {
				// Read the window's entries exactly once: the getter materializes the
				// whole window, so probing it twice would double that cost.
				const entries = window !== null && typeof window === 'object' ? window.entries : undefined;
				fold = foldEntries(Array.isArray(entries) ? entries : []);
			}
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

		/**
		 * Exact token count with thousands separators: the panel shows exact
		 * figures, so grouping never hides a digit that changed.
		 * @param value - token count.
		 * @returns grouped digits.
		 */
		function formatCount(value) {
			return String(Math.max(0, Math.round(value))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
		}

		/**
		 * Every string one summary contributes, resolved at one instant, so the
		 * trigger and the panel cannot disagree and their live rows tick together.
		 * @param summary - folded newest-Turn figures.
		 * @param now - wall clock, used only for the live elapsed figures.
		 * @param t - translate seat.
		 * @returns display-ready figures, the trigger label among them.
		 */
		function displayFigures(summary, now, t) {
			const elapsed = (from) => formatSeconds(Math.max(0, now - (typeof from === 'number' ? from : now)), t);
			const ttftText = summary.ttftMs === null ? null : formatSeconds(summary.ttftMs, t);
			const speedText = summary.tps === null ? null : formatSpeed(summary.tps, t);
			const live = summary.pending === 'awaiting'
				? `${t('waiting for first token')} ${elapsed(summary.awaitingSince)}`
				: summary.pending === 'generating'
					? `${t('generating')} ${elapsed(summary.firstTokenAt)}`
					: null;
			const detail = live ?? speedText;
			return {
				ttftText,
				speedText,
				live,
				label: `${t('Turn')} ${[ttftText, detail].filter((part) => part !== null).join(' · ')}`,
				rows: [
					{ label: t('First token (TTFT)'), value: summary.pending === 'awaiting' ? live : ttftText ?? t('not recorded') },
					{ label: t('Output speed (TPS)'), value: summary.pending === 'generating' ? live : speedText ?? t('not recorded') },
					{ label: t('Output tokens'), value: summary.tokenSteps === 0 ? t('not recorded') : formatCount(summary.decodeTokens) },
					{ label: t('Decode time'), value: summary.decodeMs > 0 ? formatSeconds(summary.decodeMs, t) : t('not recorded') },
					{ label: t('Steps'), value: String(summary.steps) },
				],
			};
		}

		/**
		 * The margin the panel's top edge is clamped to. The desktop frame reserves
		 * a strip above the page, and the shipped dialog's own overlay helper widens
		 * the margin to clear it; a fullscreen frame keeps the plain margin.
		 * @param min - the plain margin.
		 * @returns the top margin to clamp to.
		 */
		function overlayTopMargin(min) {
			try {
				const root = document.documentElement;
				const clearance = Number.parseFloat(
					window.getComputedStyle(root).getPropertyValue('--dsh-frame-top-clearance'),
				);
				if (Number.isNaN(clearance)) return min;
				return Math.max(min, (root.hasAttribute('data-fullscreen') ? 0 : clearance) + 20);
			} catch {
				return min;
			}
		}

		/**
		 * Place a fixed panel above its trigger, clamped into the viewport and clear
		 * of the frame's reserved strip, and keep it there while the page scrolls,
		 * the window resizes, or the panel's own content changes size — the shipped
		 * stat dialog's own anchoring, without its primitives package.
		 * @param open - whether the panel is mounted.
		 * @param anchorRef - ref of the trigger.
		 * @param panelRef - ref of the panel.
		 * @returns the placement, or null while the measuring pass runs.
		 */
		function useAnchoredPanel(open, anchorRef, panelRef) {
			const [pos, setPos] = React.useState(null);
			React.useLayoutEffect(() => {
				if (!open) {
					setPos(null);
					return undefined;
				}
				let frame = 0;
				const place = () => {
					const anchor = anchorRef.current;
					const panel = panelRef.current;
					if (anchor === null || panel === null) return;
					const trigger = anchor.getBoundingClientRect();
					const rect = panel.getBoundingClientRect();
					const width = Math.min(rect.width, window.innerWidth - PANEL_MARGIN * 2);
					const left = Math.min(
						Math.max(trigger.left + trigger.width / 2 - width / 2, PANEL_MARGIN),
						Math.max(PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN),
					);
					const above = trigger.top - rect.height - PANEL_GAP;
					const below = trigger.bottom + PANEL_GAP;
					// Prefer sitting above the trigger; drop below it when that would
					// cross the frame's reserved top strip; then clamp into the viewport
					// with the shipped overlay helper's own formula.
					const topMargin = overlayTopMargin(PANEL_MARGIN);
					const floor = window.innerHeight - rect.height - PANEL_MARGIN;
					const top = Math.min(Math.max(above >= topMargin ? above : below, topMargin), floor);
					setPos({ left: Math.round(left), top: Math.round(top) });
				};
				place();
				const onViewportChange = () => {
					window.cancelAnimationFrame(frame);
					frame = window.requestAnimationFrame(place);
				};
				// The panel is `max-content` wide and its live rows tick every second,
				// so a content-driven size change has to re-place it too — not only a
				// viewport change. Measuring keeps the final width, so placing does not
				// resize it and the observer cannot loop.
				let observer;
				if (typeof ResizeObserver !== 'undefined') {
					observer = new ResizeObserver(onViewportChange);
					if (panelRef.current !== null) observer.observe(panelRef.current);
				}
				window.addEventListener('resize', onViewportChange);
				window.addEventListener('scroll', onViewportChange, true);
				return () => {
					window.cancelAnimationFrame(frame);
					if (observer !== undefined) observer.disconnect();
					window.removeEventListener('resize', onViewportChange);
					window.removeEventListener('scroll', onViewportChange, true);
				};
			}, [open, anchorRef, panelRef]);
			return pos;
		}

		/**
		 * Close the panel on an outside pointer press or Escape. The trigger is
		 * exempt, so its own click stays a toggle rather than a close-then-open.
		 * @param open - whether the panel is mounted.
		 * @param rootRef - ref of the trigger.
		 * @param panelRef - ref of the panel.
		 * @param setOpen - open-state writer.
		 */
		function useDismiss(open, rootRef, panelRef, setOpen) {
			React.useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					const target = event.target;
					const insidePanel = target instanceof Node && panelRef.current !== null && panelRef.current.contains(target);
					const insideTrigger = target instanceof Node && rootRef.current !== null && rootRef.current.contains(target);
					if (insidePanel || insideTrigger) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === 'Escape') setOpen(false);
				};
				document.addEventListener('pointerdown', onPointerDown, true);
				document.addEventListener('keydown', onKeyDown);
				return () => {
					document.removeEventListener('pointerdown', onPointerDown, true);
					document.removeEventListener('keydown', onKeyDown);
				};
			}, [open, rootRef, panelRef, setOpen]);
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
				 * say, counts a live wait or generation up once per second, and opens
				 * its detail panel on click.
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
					const [open, setOpen] = React.useState(false);
					const [hovered, setHovered] = React.useState(false);
					const [focused, setFocused] = React.useState(false);
					const rootRef = React.useRef(null);
					const panelRef = React.useRef(null);
					const pos = useAnchoredPanel(open, rootRef, panelRef);
					useDismiss(open, rootRef, panelRef, setOpen);
					const hasSummary = summary !== null;
					React.useEffect(() => {
						if (!hasSummary && open) setOpen(false);
					}, [hasSummary, open]);
					if (summary === null) return null;

					const figures = displayFigures(summary, now, tr);
					const trigger = h('button', {
						ref: rootRef,
						type: 'button',
						style: triggerStyle(open || hovered || focused, summary.pending !== null),
						'aria-haspopup': 'dialog',
						'aria-expanded': open,
						'aria-label': figures.label,
						'data-live-turn-stats': true,
						'data-pending': summary.pending === null ? 'false' : 'true',
						'data-turn': summary.turn,
						onClick: () => setOpen(!open),
						onPointerEnter: () => setHovered(true),
						onPointerLeave: () => setHovered(false),
						onFocus: () => setFocused(true),
						onBlur: () => setFocused(false),
					},
						h(ClockIcon, null),
						h('span', { style: LABEL_STYLE }, figures.label));

					if (!open) return trigger;
					const panel = h('div', {
						ref: panelRef,
						role: 'dialog',
						'aria-label': tr('Latest turn stats'),
						'data-live-turn-stats-panel': true,
						style: pos === null ? { ...PANEL_STYLE, ...MEASURE_STYLE } : { ...PANEL_STYLE, left: pos.left, top: pos.top },
					},
						h('div', { style: PANEL_TITLE_STYLE },
							h('span', { style: PANEL_TITLE_LABEL_STYLE },
								h(ClockIcon, null),
								tr('Latest turn stats')),
							h('span', { style: PANEL_TITLE_VALUE_STYLE }, tr('Turn {turn}', { turn: summary.turn }))),
						h('div', { style: PANEL_RULE_STYLE, 'aria-hidden': true }),
						h('dl', { style: PANEL_DETAILS_STYLE },
							figures.rows.flatMap((row) => [
								h('dt', { key: `${row.label}:term`, style: PANEL_TERM_STYLE }, row.label),
								h('dd', { key: `${row.label}:value`, style: PANEL_VALUE_STYLE }, row.value),
							])),
						h('div', { style: PANEL_NOTE_STYLE }, tr('Latest turn only — the neighbouring pill averages the whole session.')));
					return h(React.Fragment, null, trigger, ReactDOM.createPortal(panel, document.body));
				}

				try {
					ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
						name: 'conversation.composer.dock',
						id: 'live-turn-stats',
						// The shipped readings are `activity` (order 0) and `usage`
						// (order 1) since dsh 0.2.1, so 1.5 lands after both of them —
						// and still before the cost meters, which order higher. On older
						// releases the single `stats` entry occupied order 0, so 1.5 sat
						// after it as well.
						order: 1.5,
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
				formatCount,
				displayFigures,
			},
		};
	},
});

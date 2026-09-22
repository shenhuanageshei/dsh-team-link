// dsh-team-link — node half (host plugin).
//
// Upstream dsh-session-link behavior, kept in full: direct user prompts
// carrying a session deep link (the canonical `dsh-session:<base64url>` URI,
// this deployment's `dsh://session/<sessionId>` deep link, or the legacy web
// deep link `http(s)://<host>/s/<sessionId>`) are resolved through the shipped
// session-reference service and the bounded snapshot is injected as read-only
// model context immediately before the direct prompt.
//
// New in -pro (and in the 0.3.x team upgrade):
//  1. team_link_list_sessions — list the sessions of the current
//     workspace (id / title / running state / created time).
//  2. team_link_export — export any session as markdown + JSON into
//     the session workspace's `.dsh-exports/` directory; the same renderer
//     also streams downloads through an exact webServer route for the
//     conversation-header export button.
//  3. team_link_send — deliver a message to another live session.
//     A running target receives it inside its current turn (steer); an idle
//     target is woken as a new turn (followup). Every send passes
//     two gates before delivery: the sender's user must approve (permanently
//     memorable per target) and the receiver's inbound policy must accept it
//     (ask / accept / reject, plus trusted and blocked sender lists, edited
//     through the settings UI).
//  4. team_link_watch — the M1 cross-session watchdog (register / list / clear).
//  5. team_link_roster / team_link_team_read / team_link_team_append — the M2 team
//     identity registry (roles, version history, writer policy) and the team
//     blackboard under <workspace>/team/<name>/ (mirror + decisions + discipline).
//  6. M3 (0.3.3) grows team_link_send into the §3.4 broadcast: an optional
//     `targets` fan-out (session id / team:<name>/<role> / coordinator-only
//     team:<name>/*, one full gate pass per target, ≤8 targets) and an optional
//     `meta` envelope rendered into the banner's first line (V10 keeps the
//     source at exactly three members). Delivery replies carry the §3.5 busy
//     prediction.
//  7. team_link_rotate — the M4 two-phase hand-over (§3.6): `prepare` mints a
//     one-time token bound to (team, role, successor), snapshots the trust state
//     for revocation and freezes the team; `claim` (only by the successor, only
//     with that token) migrates the in-team pairs through a single confirmation
//     dialog — or provisionally, with a 24h rollback, when nobody is there to
//     confirm — revokes the outgoing coordinator's trust symmetrically and
//     settles the roster. Expired tokens and provisional windows are swept by the
//     same patrol timer as the M1 watchdog (§3.6.2 评审 #4/#5).
//  8. §10.1 (A/D) — team_link_send additionally projects the §10.1.2 structured
//     delivery receipt through `output.presentationMeta`, persisted as
//     `tool/result.meta`; the browser half renders the sender's own tool row and
//     a top-level summary node from it. The receipt is bounded where it is
//     persisted — the body at 2000 code points, the `targets` array at 24 rows
//     (a single `team:<name>/*` legally expands past the ≤8 EXPRESSION bound) —
//     and each cut is stated on the card, never in the counts or in the
//     model-visible report. The model-visible text is untouched, and
//     no new session-log event type is introduced (A/D read existing
//     tool/call + tool/result events only).
//  9. §10.2 ② — the `/team_session` command: one human command creates N worker
//     ROOT sessions (N ≤ 8 and per-team members ≤ 24 are code constants), drives
//     each with one `followup` kickoff task after every create resolved, registers
//     them in the roster by role (idempotently, through the existing writer gate),
//     and pairs each new worker with the coordinator. The command is registered
//     through the OPTIONAL `commands` injection — `inject` below stays at four
//     entries — and one batch confirmation carries the counts, the model, the cwd,
//     the conservative cost and the trust being granted before anything happens.
//     Every created session RESOLVES an agent preset — the host's DEFAULT one when
//     the caller named none — and MOUNTS it in its own `setup`, the `dsh-webhook`
//     template's own order; a creation path that skipped that step produced a
//     session that could not start a single turn (真机缺陷 #1 / DEFECT-1). The
//     same template is a SEQUENCE, not just a shape: it also CREATES the
//     workspace, feeds `workspace.path` into `meta.cwd`, and ATTACHES the finished
//     session to it — a creation path that copied only the `meta` shape produced
//     sessions with no workspace membership, which the sidebar (grouped by
//     workspace) could not list (真机缺陷 #2 / DEFECT-2). Both halves now live in
//     the ONE creation path; the §11.2 `successor:"auto"` hand-over creates
//     through that same function, so both fixes cover the trust-migration path as
//     well.
import { encodeSessionReferenceUri, parseSessionReferenceText } from "@deepseek-ai/dsh-session-reference";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "schemastery";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Stable Cordis plugin name (also the package id the client half rides on). */
const name = "dsh-team-link";
/** Services this host row needs before it activates. The remaining services
 * (userQuestions, settings, webServer, commands, agentPresets) are resolved at
 * runtime and degrade gracefully when absent: sends refuse without an approval
 * UI, approval memory falls back to process-local state, and the export route is
 * skipped while the export tool keeps working. `settings` and `webServer` are
 * read through that same runtime channel, but a single read at apply time is a
 * time-of-activation snapshot (cordis `ctx.get` only returns ACTIVE providers,
 * §9.1.2) — so both are re-tried after activation via `ctx.inject([...])`, the
 * policy store additionally retries lazily on every `get()`/`update()`, and any
 * failure to attach leaves a log line instead of degrading silently
 * (§9.1.3 / §5.3). `commands` (the §10.2 ② `/team_session` registration) rides
 * that same ordered-injection channel, so this array keeps its four entries: an
 * optional dependency must never grow it (§10.2.1 / §10.3). `agentPresets` — the
 * preset every created session is composed from — is read with a plain `ctx.get`
 * AT CREATION TIME instead (a command runs long after activation, and the read
 * belongs next to the `agents.create` it feeds); its absence is the one branch
 * that may skip the preset face, and it leaves one warn per created session. */
const inject = ["sessionReferenceResolver", "tools", "sessionQuery", "agents"];

const PLUGIN_LABEL = "dsh-team-link";
/** Directory (inside the session's workspace) receiving export artifacts. */
const EXPORT_DIR = ".dsh-exports";
/** Per-text-block truncation limit for markdown exports (JSON stays complete). */
const MD_BLOCK_LIMIT = 16000;
/** Per-tool-result truncation limit for markdown exports. */
const MD_TOOL_RESULT_LIMIT = 2000;
/** How long the receiving user has to answer an inbound confirmation. */
const RECEIVE_CONFIRM_TIMEOUT_MS = 180000;
/** Cap on sessions rendered by the list tool. */
const LIST_LIMIT = 50;
/** Cap on sessions given a surface read — the topic/activity digest AND the §3.1
 * liveness signal both fold the same surface. One cold log costs a zstd
 * decompression plus a surface projection, so the list tool reads a bounded
 * window and the rows past it say so instead of showing a verdict computed from
 * nothing (see {@link LV_WINDOW_NOTE}). */
const PREVIEW_SESSIONS = 12;
/** Liveness line of a row outside that window: the readings below it are a
 * snapshot of a BOUNDED read, so an unread row labels itself unread rather than
 * omitting the line or printing a verdict with no surface behind it. The row
 * itself still lists (id, agent state, creation time, provisional marks). */
const LV_WINDOW_NOTE = `未读（超出快照窗口 ${PREVIEW_SESSIONS}）—— 本行未读取会话日志：verdict / 静默时长 / goal / 主题 / 最近动态均未判定（代理状态见该行的运行标志）。`;
/** Liveness thresholds in minutes (§3.1): idle silence past `LV_SILENT_MIN` is
 * the P1 symptom ("双端都在等"), and a running turn past `LV_RUN_MIN` is
 * reported as long-running rather than healthy. */
const LV_SILENT_MIN = 10;
const LV_RUN_MIN = 30;
/** A liveness reading is a snapshot of a moving system, so every row says when it
 * was taken and when it stops being trustworthy (§3.1 防偏离 regulations). */
const READ_STALE_NOTE = ">2min 作废";
/** Verdicts the cross-session watchdog acts on (§3.2.3): a silent idle target, a
 * root-cause goal-disarmed target, and a target whose agent is gone. */
const TICKABLE_VERDICTS = new Set(["silent-idle", "goal-disarmed", "dead"]);
/** Watchdog limits (§3.2.4, anti-runaway): at most this many registrations per
 * watcher session, and these floors/ceilings on the thresholds a caller may set. */
const WATCHDOG_MAX_PER_SESSION = 3;
const WATCHDOG_MIN_SILENT_MINUTES = 10;
const WATCHDOG_DEFAULT_SILENT_MINUTES = 10;
const WATCHDOG_MIN_INTERVAL_MINUTES = 5;
const WATCHDOG_DEFAULT_INTERVAL_MINUTES = 5;
const WATCHDOG_MAX_TTL_HOURS = 24;
const WATCHDOG_DEFAULT_TTL_HOURS = 12;
/** Registration id prefix; distinct from `slp-` so the two kinds never collide. */
const WATCHDOG_ID_PREFIX = "wd-";
/** Tick message id prefix (§3.2.3). The client card reads the `slp-` stem. */
const WATCHDOG_TICK_ID_PREFIX = "slp-wd-";
/**
 * Live watchdog controller of each plugin context. `apply` is the only writer;
 * `host-half.test.mjs` reads it (through {@link __testing}) so it can drive the
 * real `patrol` implementation with an injected clock instead of waiting.
 */
const WATCHDOG_BY_CTX = new WeakMap();

// ---------------------------------------------------------------------------
// upstream deep-link resolution (verbatim behavior; labels renamed only)
// ---------------------------------------------------------------------------

/**
 * `dsh://` deep links copied by the header button: `dsh://session/<sessionId>`.
 * Only ids shaped like harness session ids (`session-…`) are treated as
 * references, so an unrelated `dsh://` URI cannot hijack a message.
 */
const DSH_URI_RE = /dsh:\/\/session\/(session-[A-Za-z0-9_-]+)/gu;
/**
 * Legacy web deep links: `/s/<sessionId>`. Kept for pasted copies of the
 * browser-openable URL. The host part is ignored: session ids are opaque and
 * local to this DSH home.
 */
const WEB_DEEP_LINK_RE = /https?:\/\/[^\s"'<>()\\]+?\/s\/(session-[A-Za-z0-9_-]+)/gu;
/** Any occurrence of a supported link form, used as a cheap pre-filter. */
const ANY_LINK_RE = /dsh-session:[A-Za-z0-9_-]+|dsh:\/\/session\/session-[A-Za-z0-9_-]+|\/s\/session-[A-Za-z0-9_-]+/u;

/** True when the message is a direct user prompt rather than injected context. */
function isDirectUserMessage(message) {
	return message !== null && typeof message === "object" && message?.source?.kind === "user";
}

/** All text of one content block array, in order. */
function textOf(content) {
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => block?.type === "text" && typeof block?.text === "string" ? [block.text] : []).join("\n");
}

/**
 * Normalize one content block array for references: `dsh://` and web deep
 * links become markdown mentions, then every `dsh-session:` form is parsed
 * into a structured reference and replaced with its readable `@label` text.
 * Malformed or non-canonical URIs throw — callers must never let that fail a
 * user's turn.
 * @param content - the user message content.
 * @returns the normalized content and the structured references, or
 *   `null` when no reference-shaped text was present.
 */
function normalizeReferences(content) {
	let references = [];
	let changed = false;
	const normalized = content.map((block) => {
		if (block?.type !== "text" || typeof block?.text !== "string") return block;
		if (!ANY_LINK_RE.test(block.text)) return block;
		const withMentions = block.text
			.replace(DSH_URI_RE, (_full, sessionId) => `@[${sessionId}](${encodeSessionReferenceUri(sessionId)})`)
			.replace(WEB_DEEP_LINK_RE, (_full, sessionId) => `@[${sessionId}](${encodeSessionReferenceUri(sessionId)})`);
		const parsed = parseSessionReferenceText(withMentions);
		if (parsed.references.length > 0) changed = true;
		references = [...references, ...parsed.references];
		return { ...block, text: parsed.text };
	});
	return changed ? { content: normalized, references } : null;
}

/**
 * Register the upstream `agent/pre-step` listener that turns deep links found
 * in direct user prompts into sourced snapshot context. Fail-open throughout.
 * @param ctx - plugin context carrying the `sessionReferenceResolver` service.
 */
function registerDeepLinks(ctx) {
	ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal?.aborted === true) return decision;
		// Fail open: no parse or snapshot failure may ever break a user turn.
		const targets = [];
		for (const message of decision.messages) {
			if (!isDirectUserMessage(message)) continue;
			try {
				const text = textOf(message.content);
				if (text === "" || !ANY_LINK_RE.test(text)) continue;
				const normalized = normalizeReferences(message.content);
				if (normalized !== null) targets.push({ message, ...normalized });
			} catch (error) {
				ctx.logger?.warn?.(`${PLUGIN_LABEL}: leaving a malformed link as plain text: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (targets.length === 0) return decision;
		// Build the modified decision; every later failure leaves it untouched.
		const result = { ...decision, messages: [...decision.messages] };
		for (const target of targets) {
			try {
				const prepared = await ctx.sessionReferenceResolver.prepare(agent, target.content, target.references, signal);
				const index = result.messages.indexOf(target.message);
				if (index === -1) continue;
				// The injected snapshot is the plugin's most direct carrier INTO the
				// caller's next request, and the referenced session's own log is exactly
				// where a lone surrogate can come from — so both messages are repaired
				// here (a no-op for well-formed text; the resolver's behavior is left
				// alone, only the bytes it hands over are).
				const replaced = { ...target.message, content: wellFormedContent(prepared.content) };
				const context = prepared.additionalContext === undefined || prepared.additionalContext === null
					? prepared.additionalContext
					: { ...prepared.additionalContext, content: wellFormedContent(prepared.additionalContext.content) };
				// Sourced snapshot first, then the readable direct prompt. `additionalContext`
				// is optional in the resolver's contract, so a missing one is dropped rather
				// than spliced in as `undefined` — the direct prompt must survive either way.
				if (context === undefined || context === null) result.messages.splice(index, 1, replaced);
				else result.messages.splice(index, 1, context, replaced);
			} catch (error) {
				if (signal?.aborted === true) return decision;
				ctx.logger?.warn?.(`${PLUGIN_LABEL}: skipped references in turn ${turn} step ${step}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return result;
	}, { prepend: true });
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Filesystem-safe timestamp for export artifact names. */
function timestamp(date = new Date()) {
	const pad = (n) => String(n).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * Local `YYYY-MM-DD HH:mm:ss` stamp for relay banners. The audited
 * `agent-message` source admits exactly `{kind, form, senderSessionId}`, so the
 * delivery time has no home there and travels in the message body instead —
 * where the receiving card reads it back.
 */
function localStamp(date = new Date()) {
	const pad = (n) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Single-line preview of arbitrary text. Cuts on code-point boundaries only: a
 * code-unit slice can split a surrogate pair and leave a lone surrogate — half
 * an emoji — in the returned string, and a lone surrogate forwarded into the
 * next model request fails that request with HTTP 400 INVALID_REQUEST for the
 * rest of the session (see `wellFormed`). The limits themselves are unchanged;
 * only the counting unit is: `[...flat]` iterates code points, so a preview is
 * truncated when it exceeds `limit` code points, not code units.
 */
function preview(text, limit = 120) {
	const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
	const chars = [...flat];
	return chars.length <= limit ? flat : `${chars.slice(0, limit - 1).join("")}…`;
}

/**
 * Truncate long text with an explicit marker (exports must stay honest). Cuts
 * on code-point boundaries only, for the same reason as `preview`. The count in
 * the marker is a code-point count too: it used to count UTF-16 code units, so
 * an astral character was billed as two "字符" while being cut in half.
 */
function truncate(text, limit) {
	const value = String(text ?? "");
	const chars = [...value];
	return chars.length <= limit ? value : `${chars.slice(0, limit).join("")}\n…[已截断 ${chars.length - limit} 字符]`;
}

/**
 * A lone surrogate must never leave this plugin: the orchestrator forwards tool
 * output verbatim into the next model request, and an unpaired surrogate makes
 * that request fail with HTTP 400 INVALID_REQUEST — permanently, for the whole
 * session (observed on 4/4 logged sessions that carried one over
 * deepseek-official). `preview`/`truncate` keep this plugin from CREATING a lone
 * surrogate; this pass also repairs one that entered from outside — an older
 * build's log, a cross-session message body, an echoed tool argument. The
 * unpaired half becomes U+FFFD; nothing else in the string changes.
 * `String.prototype.toWellFormed` (Node >= 20) is the native equivalent, the
 * regex is the fallback for older runtimes.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
function wellFormed(value) {
	const text = String(value ?? "");
	return typeof text.toWellFormed === "function" ? text.toWellFormed() : text.replace(LONE_SURROGATE, "\uFFFD");
}

/** Well-formed copy of a content block array: text blocks are repaired, every
 * other block (and a non-array) passes through untouched. */
function wellFormedContent(content) {
	if (!Array.isArray(content)) return content;
	return content.map((block) => block?.type === "text" && typeof block.text === "string" ? { ...block, text: wellFormed(block.text) } : block);
}

/**
 * Tool output contract for every tool in this plugin: a plain string value,
 * rendered well-formed. `output.render` is the last stop before a return value
 * becomes model-facing tool-result content (dsh-tools calls it and snapshots the
 * blocks), so this single gate covers every return path — including the early
 * refusals whose text embeds log-derived ids and titles.
 */
function textOutput() {
	return {
		schema: { type: "string" },
		render: (_args, value) => [{ type: "text", text: wellFormed(String(value)) }],
	};
}

/** JSON.stringify that never throws and never returns undefined. */
function safeJson(value) {
	try {
		const text = JSON.stringify(value, null, 2);
		return text === undefined ? String(value) : text;
	} catch {
		return String(value);
	}
}

/** Human-readable one-line description of a thrown error. */
function describeError(error) {
	if (error !== null && typeof error === "object" && typeof error.code === "string" && error.code !== "") {
		return `${error.code}: ${error.message ?? ""}`.trim();
	}
	if (error instanceof Error) return error.message;
	return String(error);
}

/** Session id of the agent executing a tool call, when known. */
function agentSessionId(exec) {
	return typeof exec?.agent?.id === "string" && exec.agent.id !== "" ? exec.agent.id : undefined;
}

/** Workspace cwd of the agent executing a tool call. */
function agentCwd(exec) {
	const cwd = exec?.agent?.session?.header?.cwd;
	return typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
}

/** `「标题」(id)` when a title exists, the bare id otherwise. */
function sessionLabel(sessionId, title) {
	return typeof title === "string" && title !== "" ? `「${title}」(${sessionId})` : sessionId;
}

/** First direct-user text on a session surface — what the session was asked to do. */
function firstSurfaceUserText(events) {
	for (const event of events) {
		if (event?.type !== "user/message" || event.data?.source?.kind !== "user") continue;
		const text = textOf(event.data.content);
		if (text !== "") return text;
	}
	return undefined;
}

/** Latest human/model text on a session surface — what the session is doing now. */
function lastSurfaceText(events) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.type === "assistant/message") {
			const text = textOf(event.data?.message?.content);
			if (text !== "") return text;
		} else if (event?.type === "user/message" && event.data?.source?.kind === "user") {
			const text = textOf(event.data.content);
			if (text !== "") return text;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// liveness signal and verdict (§3.1)
// ---------------------------------------------------------------------------

/**
 * Goal signal for one session — the strongest liveness fact available. The
 * `goals` service is resolved at runtime with `ctx.get("goals")` (§3.1
 * implementation note: the goal-round driver injects it, so it is a plain
 * service call and needs no log parsing), and its absence is a supported
 * degradation: the whole plugin keeps working with `goal: null` shown as `?`
 * instead of failing to start (red line §5.3).
 *
 * @returns `null` when the service is unavailable (degraded), otherwise the
 *   normalized goal signal — phase `"none"` when the session has no current
 *   goal, or when no live agent exists to ask about (the agent face already
 *   reports `dead` for that case).
 */
function readGoalSignal(ctx, sessionId, agent) {
	const goals = ctx.get?.("goals");
	if (goals === undefined || goals === null || typeof goals.get !== "function") return null;
	const none = { phase: "none", activation: "?", rounds: "-", blockedReason: null };
	if (agent === undefined) return none;
	try {
		const view = goals.get(agent);
		if (view === undefined || view === null) return none;
		const rounds = `${Number.isFinite(view.roundsStarted) ? view.roundsStarted : "?"}/${Number.isFinite(view.maxGoalRounds) ? view.maxGoalRounds : "?"}`;
		const reason = view.blockedReason === undefined || view.blockedReason === null
			? null
			: `${view.blockedReason.code}: ${view.blockedReason.message}`;
		return {
			phase: typeof view.phase === "string" && view.phase !== "" ? view.phase : "none",
			activation: view.activation === "armed" || view.activation === "disarmed" ? view.activation : "?",
			rounds,
			blockedReason: typeof reason === "string" ? wellFormed(reason) : null,
		};
	} catch {
		// A goal read that throws (not live, projection failure) is not a reason to
		// lose the session's other signals — the goal face degrades to "unknown".
		return none;
	}
}

/**
 * The §3.1 verdict: five states, and the four-state tick policy of §3.7 in one
 * place.
 *
 * - `dead` — no live agent (A4: nothing can wake it, the signal face says so);
 * - `long-running` — a live turn that has been running longer than `runMin`;
 * - `goal-disarmed` — idle with an active-but-disarmed goal: the root-cause
 *   silent state (V5, activation is deliberately not persisted), which must be
 *   reported immediately instead of waiting for the silence threshold;
 * - `silent-idle` — idle, no goal, and no activity for longer than `silentMin`
 *   (the P1 scenario);
 * - `ok` — everything else, including paused/blocked/complete goals: those are
 *   silence somebody already explained (waiting on a human), so they are shown,
 *   never alarmed on.
 *
 * @param signal - a {@link buildLivenessSignal} result.
 * @param cfg - `now` plus the two minute thresholds (defaults §3.1).
 */
function verdictOf(signal, cfg = {}) {
	const now = typeof cfg.now === "number" ? cfg.now : Date.now();
	const silentMin = typeof cfg.silentMin === "number" ? cfg.silentMin : LV_SILENT_MIN;
	const runMin = typeof cfg.runMin === "number" ? cfg.runMin : LV_RUN_MIN;
	if (signal.agent === "not-live") return "dead";
	if (signal.agent === "running") {
		if (typeof signal.turnStartedAt === "number" && now - signal.turnStartedAt > runMin * 60000) return "long-running";
		return "ok";
	}
	const goal = signal.goal;
	if (goal !== null && goal !== undefined) {
		if (goal.phase === "active" && goal.activation === "armed") return "ok";
		if (goal.phase === "active" && goal.activation === "disarmed") return "goal-disarmed";
		if (goal.phase === "paused" || goal.phase === "blocked" || goal.phase === "complete") return "ok";
	}
	if (signal.silenceMs > silentMin * 60000) return "silent-idle";
	return "ok";
}

/**
 * Read one session's liveness signal (§3.1). Never throws and never costs more
 * than the surface the caller already read: the agent comes from the registry,
 * the timestamps from the session surface, the goal from the optional service.
 *
 * `silenceMs` is 0 when neither timestamp is readable (no evidence of silence
 * is not evidence of liveness, but an unknown reading must not fire alarms), and
 * the renderer shows that case as `?`.
 */
function buildLivenessSignal(ctx, sessionId, options = {}) {
	const now = typeof options.now === "number" ? options.now : Date.now();
	const agent = options.agent !== undefined ? options.agent : ctx.agents.get(sessionId);
	const agentState = agent === undefined ? "not-live" : agent.status === "running" ? "running" : "idle";
	let lastAssistantAt = null;
	let lastInboundAt = null;
	let turnStartedAt = null;
	const events = Array.isArray(options.surface?.events) ? options.surface.events : [];
	for (const event of events) {
		const time = typeof event?.time === "number" ? event.time : undefined;
		if (time === undefined) continue;
		if (event.type === "assistant/message") lastAssistantAt = time;
		else if (event.type === "user/message") lastInboundAt = time;
		else if (event.type === "turn/start") turnStartedAt = time;
	}
	const lastActivity = Math.max(lastAssistantAt ?? Number.NEGATIVE_INFINITY, lastInboundAt ?? Number.NEGATIVE_INFINITY);
	const signal = {
		agent: agentState,
		lastAssistantAt,
		lastInboundAt,
		turnStartedAt,
		goal: readGoalSignal(ctx, sessionId, agent),
		silenceMs: Number.isFinite(lastActivity) ? Math.max(0, now - lastActivity) : 0,
		verdict: "ok",
	};
	signal.verdict = verdictOf(signal, { now, silentMin: options.silentMin, runMin: options.runMin });
	return signal;
}

/** Reading stamp for the liveness face and the watchdog tick body. */
function readStamp(now) {
	return localStamp(new Date(now));
}

/** A silence duration in minutes, one decimal — display and tick-body unit. */
function fmtSilence(ms) {
	return `${(ms / 60000).toFixed(1)}min`;
}

/** The target's last observed activity watermark (§3.1 timestamps), or `null`
 * when neither side is readable — the watchdog's "same silence period" key. */
function lastActivityOf(signal) {
	if (signal.lastAssistantAt === null && signal.lastInboundAt === null) return null;
	return Math.max(signal.lastAssistantAt ?? Number.NEGATIVE_INFINITY, signal.lastInboundAt ?? Number.NEGATIVE_INFINITY);
}

/** One-line goal summary for the signal face; `?` means the goal service is absent. */
function goalSummary(goal) {
	if (goal === null || goal === undefined) return "?";
	if (goal.phase === "none") return "none";
	const blocked = goal.blockedReason === null ? "" : ` blocked=${goal.blockedReason}`;
	return `${goal.phase}/${goal.activation}(${goal.rounds})${blocked}`;
}

/** The per-row liveness signal line of `team_link_list_sessions`. */
function livenessLine(signal) {
	const agent = signal.agent === "running" ? "运行中" : signal.agent === "idle" ? "空闲" : "未运行";
	const silence = signal.lastAssistantAt === null && signal.lastInboundAt === null
		? "静默 ?"
		: `静默 ${fmtSilence(signal.silenceMs)}`;
	const parts = [`verdict=${signal.verdict}`, `代理=${agent}`, `goal=${goalSummary(signal.goal)}`, silence];
	if (signal.agent === "running" && signal.turnStartedAt !== null) parts.push(`回合始于 ${readStamp(signal.turnStartedAt)}`);
	if (signal.lastAssistantAt !== null) parts.push(`末条助手 ${readStamp(signal.lastAssistantAt)}`);
	if (signal.lastInboundAt !== null) parts.push(`末条入站 ${readStamp(signal.lastInboundAt)}`);
	return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// policy store: settings-backed, memory fallback
// ---------------------------------------------------------------------------

/** Default cross-session messaging policy. */
const DEFAULT_POLICY = {
	receiveMode: "ask",
	trustedSenders: [],
	blockedSenders: [],
	rememberTargets: [],
	pairs: [],
	watchdogs: [],
	teams: [],
	/**
	 * §10.2 ② (§10.2.6 orphan guard): the durable `pending-creates` intents. An
	 * intent is written BEFORE its session is created and removed once the create
	 * resolves, so an intent left behind is the only surviving evidence that a
	 * create was attempted — the startup sweep reports it as an adoptable session
	 * instead of leaving a silent orphan.
	 *
	 * Declared here (not as `z.any()`) for the same reason the pair fields are: a
	 * DECLARED field is the one the canonical shape owns — the schema gives it a
	 * default and the settings UI can render it. What declaring does NOT do is
	 * gate survival: `schemastery` coerce-and-defaults, it does **not** drop
	 * undeclared keys (measured, 差异审计 B5 — that is exactly why `recoveries`,
	 * which this schema does not declare, survives a write/read cycle). The
	 * earlier wording here claimed the provider would strip an undeclared field;
	 * that reading was wrong, and it is the belief the audit traced §11.9.5⑦'s
	 * design error back to.
	 */
	pendingCreates: [],
};

const POLICY_MODES = new Set(["ask", "accept", "reject"]);

/**
 * One registered watchdog (§3.2.2). `team` is the M2 roster hook; v1 allows an
 * empty value (pure sessionId list mode). Every field carries a fallback so a
 * hand-edited settings file degrades to "drop that entry" rather than making the
 * whole policy namespace unreadable — a namespace that fails to resolve would
 * fall back to memory and orphan the user's pairs.
 */
const WatchdogConfig = z.object({
	id: z.string().default(""),
	team: z.string().default(""),
	watcherSession: z.string().default(""),
	targets: z.array(z.string()).default([]),
	silentMinutes: z.number().default(WATCHDOG_DEFAULT_SILENT_MINUTES),
	intervalMinutes: z.number().default(WATCHDOG_DEFAULT_INTERVAL_MINUTES),
	expiresAt: z.number().default(0),
	createdAt: z.number().default(0),
});

/**
 * One role of one team (§3.3.1). `current` is an empty string in the stored
 * shape when the role is vacant; the normalized view renders that as `null`.
 * `pending` is the M4 rotation slot (§3.6) — M2 never writes one, but carries a
 * row written by a later milestone through untouched (`z.any()`).
 */
const TeamRoleConfig = z.object({
	role: z.string().default(""),
	current: z.string().default(""),
	pending: z.any().default(null),
	/** M4 (§3.6.2): timestamp of the last COMPLETED rotation of this role — the
	 * second half of the ten-minute anti-storm window (rateLimit(team, role, 10min)),
	 * the half a live pending cannot express. */
	rotationAt: z.number().default(0),
	/** M4 (§3.6.2 评审 #5): the open ratification window of an unconfirmed
	 * rotation — {at, expiresAt} — or null once ratified or rolled back. */
	provisional: z.any().default(null),
	/** M4 (§3.6.2 评审 #10): the verdict word the last settled rotation recorded
	 * — 已批准 / 待批准(24h) / 无待迁移对. Declared here on purpose: a declared field
	 * carries a default, so a row written without it still reads back in the
	 * canonical shape the replay compares. (It is NOT declared because the schema
	 * would otherwise drop it — `schemastery` keeps undeclared keys; see
	 * `DEFAULT_POLICY`'s `pendingCreates` note and 差异审计 B5.) */
	rotationStatus: z.string().default(""),
	history: z.array(z.object({
		session: z.string().default(""),
		from: z.number().default(0),
		until: z.any().default(null),
		note: z.string().default(""),
	})).default([]),
});

/**
 * One team of the roster (§3.3.1). `workspace` is captured from the creating
 * session's `agentCwd` at the first session-side upsert and is the root of both
 * the roster mirror and the blackboard directory. Every field carries a
 * fallback, for the same reason the watchdog entries do: a hand-edited settings
 * row must degrade to "drop that team", never to an unreadable namespace.
 */
const TeamConfig = z.object({
	name: z.string().default(""),
	createdAt: z.number().default(0),
	workspace: z.string().default(""),
	policy: z.object({ writer: z.string().default("coordinator") }).default({ writer: "coordinator" }),
	roles: z.array(TeamRoleConfig).default([]),
	/** M4 (§3.6.2): the pre-rotation snapshot a prepare takes
	 * ({at, pairs, trustedSenders, rememberTargets, roster}) — the evidence a
	 * symmetric revocation is rolled back against by hand. */
	rotationBackup: z.any().default(null),
});

const PolicyConfig = z.object({
	receiveMode: z.string().default("ask"),
	trustedSenders: z.array(z.string()).default([]),
	blockedSenders: z.array(z.string()).default([]),
	rememberTargets: z.array(z.string()).default([]),
	// M4 (§3.6.2): a pair migrated by a rotation may be PROVISIONAL — granted
	// without a present user and revoked automatically when the ratification
	// window closes. Both fields are declared here on purpose — for the ONE reason
	// declaration is for: they are part of the canonical shape this namespace owns,
	// so every stored pair carries them and the settings UI can render them.
	// (NOT because undeclared keys would be dropped: `schemastery` keeps them; see
	// `DEFAULT_POLICY`'s `pendingCreates` note and 差异审计 B5.) The TTL still must
	// never silently become permanent trust — that is the normalizer's job
	// (`pairList` writes `provisional: false` / `expiresAt: 0` for a hand-edited row
	// that omits them), not the schema's.
	pairs: z.array(z.object({
		a: z.string(),
		b: z.string(),
		createdAt: z.number().default(0),
		provisional: z.boolean().default(false),
		expiresAt: z.number().default(0),
	})).default([]),
	watchdogs: z.array(WatchdogConfig).default([]),
	teams: z.array(TeamConfig).default([]),
	/** §10.2 ② (§10.2.6): the durable `pending-creates` intents (see DEFAULT_POLICY). */
	pendingCreates: z.array(z.object({
		team: z.string().default(""),
		role: z.string().default(""),
		sessionId: z.string().default(""),
		createdAt: z.number().default(0),
		expiresAt: z.number().default(0),
		by: z.string().default(""),
	})).default([]),
});

/** Coerce any stored/patched value into a complete, well-typed policy view. */
function normalizePolicy(value) {
	const stringList = (list) => Array.isArray(list) ? list.filter((item) => typeof item === "string") : [];
	const pairList = (list) => Array.isArray(list) ? list.filter((pair) => typeof pair?.a === "string" && typeof pair?.b === "string").map((pair) => ({
		a: pair.a,
		b: pair.b,
		createdAt: typeof pair.createdAt === "number" ? pair.createdAt : 0,
		provisional: pair.provisional === true,
		expiresAt: typeof pair.expiresAt === "number" && Number.isFinite(pair.expiresAt) ? pair.expiresAt : 0,
	})) : [];
	return {
		receiveMode: POLICY_MODES.has(value?.receiveMode) ? value.receiveMode : "ask",
		trustedSenders: stringList(value?.trustedSenders),
		blockedSenders: stringList(value?.blockedSenders),
		rememberTargets: stringList(value?.rememberTargets),
		pairs: pairList(value?.pairs),
		watchdogs: watchdogList(value?.watchdogs),
		teams: normalizeTeams(value?.teams),
		pendingCreates: pendingCreateList(value?.pendingCreates),
	};
}

/**
 * Normalized `pending-creates` intents (§10.2 ②; §10.2.6 orphan guard). These
 * are the durable twin of the in-memory intent map: written BEFORE a session is
 * created, removed when the create resolves, and reported by the startup sweep
 * when they outlive their TTL. An entry without a session id or with an
 * unusable deadline is dropped — it could never be reported or matched.
 */
function pendingCreateList(list) {
	if (!Array.isArray(list)) return [];
	const entries = [];
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		if (typeof entry.sessionId !== "string" || entry.sessionId === "") continue;
		if (typeof entry.expiresAt !== "number" || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= 0) continue;
		entries.push({
			team: typeof entry.team === "string" ? entry.team : "",
			role: typeof entry.role === "string" ? entry.role : "",
			sessionId: entry.sessionId,
			createdAt: typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : 0,
			expiresAt: entry.expiresAt,
			by: typeof entry.by === "string" ? entry.by : "",
		});
	}
	return entries;
}

/**
 * Normalized watchdog registrations: entries without an id or a watcher are
 * dropped (they can never be patrolled or cleared), and every other field is
 * coerced into its declared type. `team` is kept as `null` in this view when it
 * is empty — the M2 roster hook §3.2.2 allows `null` in v1.
 */
function watchdogList(list) {
	if (!Array.isArray(list)) return [];
	const number = (item, fallback) => typeof item === "number" && Number.isFinite(item) ? item : fallback;
	const entries = [];
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		if (typeof entry.id !== "string" || entry.id === "") continue;
		if (typeof entry.watcherSession !== "string" || entry.watcherSession === "") continue;
		entries.push({
			id: entry.id,
			team: typeof entry.team === "string" && entry.team !== "" ? entry.team : null,
			watcherSession: entry.watcherSession,
			targets: [...new Set((Array.isArray(entry.targets) ? entry.targets : []).filter((target) => typeof target === "string" && target !== ""))],
			silentMinutes: number(entry.silentMinutes, WATCHDOG_DEFAULT_SILENT_MINUTES),
			intervalMinutes: number(entry.intervalMinutes, WATCHDOG_DEFAULT_INTERVAL_MINUTES),
			expiresAt: number(entry.expiresAt, 0),
			createdAt: number(entry.createdAt, 0),
		});
	}
	return entries;
}

/**
 * Normalized M4 rotation slot (§3.6.2), or `null`. M2 has no rotation flow —
 * this only makes sure a `pending` written by a later milestone survives a
 * read/write cycle of the settings namespace instead of being silently dropped
 * (the namespace is shared, so a lossy normalizer would be a migration bug).
 */
function normalizePending(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const session = typeof value.session === "string" ? value.session : "";
	const token = typeof value.token === "string" ? value.token : "";
	if (session === "" || token === "") return null;
	const expiresAt = typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) ? value.expiresAt : 0;
	const pending = {
		session,
		token,
		team: typeof value.team === "string" ? value.team : "",
		role: typeof value.role === "string" ? value.role : "",
		expiresAt,
		// The anti-storm window needs to know when this pending was minted; a
		// hand-written row without it is dated from its TTL (the invariant
		// expiresAt = createdAt + ROTATION_TTL_MS holds for every row we write).
		createdAt: typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : Math.max(0, expiresAt - ROTATION_TTL_MS),
	};
	if (typeof value.note === "string" && value.note !== "") pending.note = value.note;
	// The idempotency marker of §3.6.2: the pairs this claim already migrated.
	// Non-empty ⇒ a previous claim got as far as the marker, so a retry replays
	// the recorded list instead of migrating twice.
	if (Array.isArray(value.migratedPairs)) pending.migratedPairs = value.migratedPairs.filter((pair) => pair !== null && typeof pair === "object" && typeof pair.a === "string" && typeof pair.b === "string").map((pair) => ({
		a: pair.a,
		b: pair.b,
		createdAt: typeof pair.createdAt === "number" && Number.isFinite(pair.createdAt) ? pair.createdAt : 0,
		provisional: pair.provisional === true,
		expiresAt: typeof pair.expiresAt === "number" && Number.isFinite(pair.expiresAt) ? pair.expiresAt : 0,
	}));
	return pending;
}

/** Normalized M4 ratification window of one role (§3.6.2 评审 #5), or null. */
function normalizeProvisional(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const expiresAt = typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) ? value.expiresAt : 0;
	if (expiresAt <= 0) return null;
	return {
		at: typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0,
		expiresAt,
		session: typeof value.session === "string" ? value.session : "",
	};
}

/** Normalized M4 revocation snapshot of one team (§3.6.2), or null. */
function normalizeRotationBackup(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const snapshot = {
		at: typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0,
		pairs: Array.isArray(value.pairs) ? value.pairs.filter((pair) => typeof pair?.a === "string" && typeof pair?.b === "string").map((pair) => ({ a: pair.a, b: pair.b, createdAt: typeof pair.createdAt === "number" ? pair.createdAt : 0, provisional: pair.provisional === true, expiresAt: typeof pair.expiresAt === "number" ? pair.expiresAt : 0 })) : [],
		trustedSenders: Array.isArray(value.trustedSenders) ? value.trustedSenders.filter((id) => typeof id === "string") : [],
		rememberTargets: Array.isArray(value.rememberTargets) ? value.rememberTargets.filter((id) => typeof id === "string") : [],
		roster: value.roster === null || typeof value.roster !== "object" ? null : value.roster,
	};
	return snapshot;
}

/**
 * One role's version history (§3.3.1), normalized: a record is
 * `{session, from, until|null, note?}` and `until: null` marks the tenure the
 * current holder is still serving. Records without a session are dropped — they
 * could never be attributed or closed.
 */
function normalizeHistory(list) {
	if (!Array.isArray(list)) return [];
	const entries = [];
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		const session = typeof entry.session === "string" ? entry.session : "";
		if (session === "") continue;
		const record = {
			session,
			from: typeof entry.from === "number" && Number.isFinite(entry.from) ? entry.from : 0,
			until: typeof entry.until === "number" && Number.isFinite(entry.until) ? entry.until : null,
		};
		if (typeof entry.note === "string" && entry.note !== "") record.note = entry.note;
		entries.push(record);
	}
	return entries;
}

/** The roles of one team, normalized: nameless or duplicate roles are dropped,
 * an empty `current` becomes a vacant `null`. */
function normalizeRoles(list) {
	if (!Array.isArray(list)) return [];
	const roles = [];
	const seen = new Set();
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		const role = typeof entry.role === "string" ? entry.role.trim() : "";
		if (role === "" || seen.has(role)) continue;
		seen.add(role);
		roles.push({
			role,
			current: typeof entry.current === "string" && entry.current !== "" ? entry.current : null,
			pending: normalizePending(entry.pending),
			rotationAt: typeof entry.rotationAt === "number" && Number.isFinite(entry.rotationAt) ? entry.rotationAt : 0,
			provisional: normalizeProvisional(entry.provisional),
			rotationStatus: typeof entry.rotationStatus === "string" ? entry.rotationStatus : "",
			history: normalizeHistory(entry.history),
			recoveries: normalizeRecoveries(entry.recoveries),
		});
	}
	return roles;
}

/**
 * The roster (§3.3.1) as this plugin reads it: teams with a legal `[a-z0-9-]+`
 * name, deduplicated, every nested field coerced. A team whose name is illegal
 * is dropped rather than kept — the name is a path segment of the blackboard, so
 * an illegal one must never reach `path.join` through a settings row.
 */
function normalizeTeams(list) {
	if (!Array.isArray(list)) return [];
	const teams = [];
	const seen = new Set();
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		const name = typeof entry.name === "string" ? entry.name : "";
		if (!TEAM_NAME_RE.test(name) || seen.has(name)) continue;
		seen.add(name);
		teams.push({
			name,
			createdAt: typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : 0,
			workspace: typeof entry.workspace === "string" ? entry.workspace : "",
			policy: { writer: entry.policy?.writer === "any" ? "any" : "coordinator" },
			roles: normalizeRoles(entry.roles),
			rotationBackup: normalizeRotationBackup(entry.rotationBackup),
		});
	}
	return teams;
}

/** True when the two sessions share an approved auto-relay pair that is still
 * live at `now` — see {@link pairRecordBetween} for the expiry rule. */
function pairBetween(view, a, b, now = Date.now()) {
	return pairRecordBetween(view, a, b, now) !== null;
}

/** §3.6.2 评审 #8 (防御纵深): a rotation-granted pair whose 24h ratification
 * window has run out is already back on the ordinary gates — the sweep deletes
 * the row, but between the deadline and the next sweep the row must not keep
 * granting a channel that bypasses both approval gates, or the "24h 自动回退"
 * promise would be silently false for exactly that window. */
function isExpiredProvisionalPair(pair, now) {
	return pair.provisional === true && pair.expiresAt > 0 && pair.expiresAt <= now;
}

/** The LIVE pair record joining two sessions, or null. The record (not just the
 * boolean) is what the M4 provisional face needs: a rotation may have granted
 * the channel without a present user, and the sender has to be told that this
 * delivery rides a channel with a 24h rollback (§3.6.2 评审 #3).
 *
 * 评审 #8: an expired provisional record counts as NO pair (the delivery side
 * stops honouring the channel at its deadline, not only when the sweep happens
 * to run), and a live record wins over an expired one — a pairing created after
 * the deadline must never be shadowed by the dead row it superseded. */
function pairRecordBetween(view, a, b, now = Date.now()) {
	const matches = view.pairs.filter((pair) => (pair.a === a && pair.b === b) || (pair.a === b && pair.b === a));
	return matches.find((pair) => !isExpiredProvisionalPair(pair, now)) ?? null;
}

/** Append one sender id to a policy list without ever duplicating it. */
function withSender(list, senderId) {
	return list.includes(senderId) ? list : [...list, senderId];
}

/**
 * Create the messaging policy store. Prefers the settings service (namespace
 * `team-link`, user-editable through the settings UI and persisted by
 * the settings provider); falls back to process-local memory when settings is
 * unavailable so the approval flow still works within one run.
 *
 * §9.1.3: the read is NOT a one-shot snapshot. cordis `ctx.get` returns only
 * providers whose fiber is already active, and the settings provider finishes
 * its `[Service.init]` (load from disk → publish) asynchronously — so an
 * apply-time read can legitimately come back `undefined` and used to switch
 * this store to memory **silently and forever** (teams / watchdogs / pairs
 * never reaching `settings.yaml`). The three-part fix: try once immediately
 * (the fast path: a synchronous provider, tests included), otherwise leave one
 * warn and wait for the provider through the OPTIONAL `ctx.inject(["settings"],
 * cb)` — ordered but not a hard dependency, so a host without settings still
 * loads this plugin — and retry lazily on every `get()` / `update()`. The warn
 * is emitted at most once: no second silent fallback, and no warn storm either
 * (§5.3 红线).
 */
/** Current settings namespace for the messaging policy. */
const POLICY_NAMESPACE = "team-link";
/**
 * Pre-rename namespace (<= 0.2.4, when this plugin was dsh-session-link-pro).
 * Registered for the one-time data migration below; user trust data (pairs /
 * trustedSenders / blockedSenders / rememberTargets / receiveMode) must never
 * be orphaned by the rename.
 */
const LEGACY_POLICY_NAMESPACE = "session-link-pro";

/**
 * True when a normalized policy view holds NOTHING the user or a tool has put
 * there — every field at its declared default. This is the one predicate that
 * licenses a wholesale write of the current namespace, so it has to name EVERY
 * field, and so must the writes it licenses: {@link adoptMemoryWindow}'s patch is
 * the other half of this licence (the legacy migration's write is deliberately
 * scoped to the five trust fields and is NOT wholesale — it must not carry a
 * roster or a pending-create intent). Both halves are checked below against
 * {@link DEFAULT_POLICY}: the two writers that consume the predicate
 * (`migrateLegacyPolicy`'s guard, `adoptMemoryWindow`) used a five-field subset
 * before, which is how a namespace holding a roster could still read as "at
 * defaults" — and the ② round repeated the shape one level down by adding
 * `pendingCreates` to the predicate while the fold's patch kept writing the seven
 * older keys (差异审计修复轮 🟡-1). Fields added to {@link DEFAULT_POLICY} belong
 * here AND in every wholesale write, in the same change.
 */
function policyIsAtDefaults(view) {
	return view.receiveMode === DEFAULT_POLICY.receiveMode
		&& view.trustedSenders.length === 0
		&& view.blockedSenders.length === 0
		&& view.rememberTargets.length === 0
		&& view.pairs.length === 0
		&& view.watchdogs.length === 0
		&& view.teams.length === 0
		&& view.pendingCreates.length === 0;
}

function createPolicyStore(ctx) {
	const memory = structuredClone(DEFAULT_POLICY);
	/** Registered settings scopes; `scope !== null` means "attached". */
	let scope = null;
	let legacyScope = null;
	/** The unattached-window warn is written once and never repeated *inside that
	 * window*, so the lazy retries below cannot turn into a warn storm (U11:
	 * 有且仅有一行). 评审 round-3 🟡 #1: the unit this gate counts is the
	 * UNATTACHED WINDOW, not the process lifetime — `detach()` re-opens it, so a
	 * provider that returns and then refuses says so again instead of leaving a
	 * silently refused second window behind the first window's line. */
	let attachWarned = false;
	/** Set when a write landed in process memory — i.e. inside the startup
	 * window, before the store could attach (§9.1.3 数据一致性). Cleared once the
	 * window's outcome has been recorded (评审 round-3 🔵 #3), so a later window
	 * cannot re-fold — and re-warn about — a memory state that was already
	 * resolved; the `fold failed` outcome keeps it set, because those writes
	 * really are still memory-only and the next attach must try again. */
	let memoryDirty = false;
	/** True when the provider answered but REFUSED to register the legacy
	 * namespace. Kept apart from "there is no legacy namespace" so the post-attach
	 * chain line can tell the two apart (评审 round-3 🔵 #5); `attach` writes it on
	 * both branches of the legacy register, so it always describes the window that
	 * just attached. */
	let legacyRefused = false;

	/**
	 * The live view: settings once attached, process memory before that. A call
	 * that finds the store unattached is the third retry hook of §9.1.3 — a tool
	 * call (or the watchdog tick) is the earliest moment a provider that came up
	 * late can be picked up without a fiber of our own.
	 */
	function get() {
		if (scope === null) attachFrom(ctx);
		try {
			return normalizePolicy(scope !== null ? scope.get() : memory);
		} catch {
			return normalizePolicy(memory);
		}
	}

	/** Mirror of {@link get} on the write side: retry, then write through the
	 * attached scope or into process memory (the startup-window fallback). */
	async function update(patch) {
		if (scope === null) attachFrom(ctx);
		if (scope !== null) {
			await scope.update(patch);
			return;
		}
		memoryDirty = true;
		for (const [key, value] of Object.entries(patch)) memory[key] = structuredClone(value);
	}

	/**
	 * One-time rename migration: when the legacy namespace (this plugin's
	 * identity before 0.3.0) still carries data and the current namespace
	 * is at defaults, copy everything over and reset the legacy namespace
	 * to base so the migration never repeats. Both non-default → the user
	 * already diverged under the new name; current wins, legacy kept.
	 *
	 * §9.1.3: called from {@link attach}, i.e. only once the current namespace
	 * really exists. At apply time this is a guaranteed no-op (nothing is
	 * registered yet), which is why the call site moved.
	 *
	 * @returns a one-token outcome the attach-time chain reports in its own line
	 *   (评审 round-2 🔵 #3): "no legacy namespace" (nothing registered for it, and
	 *   nothing refused either — the store's pre-attach state), "legacy namespace
	 *   refused (register failed)" (the provider answered but rejected the
	 *   register, so the two states below are no longer conflated — 评审 round-3
	 *   🔵 #5), "legacy read failed", "no legacy data", "migrated", "kept (current
	 *   namespace in use)" or "failed". Every branch either leaves a line of its
	 *   own or is named by the chain line, so no outcome of this function is
	 *   invisible any more — the read failure in particular used to return with
	 *   no log at all.
	 */
	async function migrateLegacyPolicy() {
		if (legacyScope === null) {
			return legacyRefused ? "legacy namespace refused (register failed)" : "no legacy namespace";
		}
		let legacy;
		try {
			legacy = normalizePolicy(legacyScope.get());
		} catch (error) {
			// best-effort ≠ silent (评审 round-2 🔵 #3): the namespace exists but
			// cannot be read, so the pre-rename trust data is NOT migrated — the
			// one branch of this function that used to swallow that silently.
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: legacy namespace "${LEGACY_POLICY_NAMESPACE}" could not be read (${describeError(error)}) — 旧命名空间的信任数据本次未迁移`);
			return "legacy read failed";
		}
		const legacyHasData = legacy.pairs.length > 0 || legacy.trustedSenders.length > 0
			|| legacy.blockedSenders.length > 0 || legacy.rememberTargets.length > 0
			|| legacy.receiveMode !== DEFAULT_POLICY.receiveMode;
		if (!legacyHasData) return "no legacy data";
		// The migration moves TRUST data (the pre-rename namespace's whole
		// vocabulary: receiveMode + the four lists + pairs), so the guard and the
		// write are both scoped to exactly those fields. The guard used to be a
		// five-field "is the current namespace at defaults" test and the write used
		// to be a wholesale `structuredClone(DEFAULT_POLICY)` — together a real
		// defect: a namespace holding a roster / a watchdog / a pending-create
		// intent still passed the guard, and the migration's payload (which carries
		// no `teams` at all) then wiped the roster a §10.2 ② batch had just written.
		const current = get();
		const trustInUse = current.pairs.length > 0 || current.trustedSenders.length > 0
			|| current.blockedSenders.length > 0 || current.rememberTargets.length > 0
			|| current.receiveMode !== DEFAULT_POLICY.receiveMode;
		if (trustInUse) {
			ctx.logger?.info?.(`${PLUGIN_LABEL}: legacy policy namespace "${LEGACY_POLICY_NAMESPACE}" still holds data; kept untouched (current namespace already in use)`);
			return "kept (current namespace in use)";
		}
		try {
			await update({
				receiveMode: legacy.receiveMode,
				trustedSenders: [...legacy.trustedSenders],
				blockedSenders: [...legacy.blockedSenders],
				rememberTargets: [...legacy.rememberTargets],
				pairs: [...legacy.pairs],
			});
			await legacyScope.update({
				receiveMode: DEFAULT_POLICY.receiveMode,
				trustedSenders: [],
				blockedSenders: [],
				rememberTargets: [],
				pairs: [],
			});
			ctx.logger?.info?.(`${PLUGIN_LABEL}: migrated policy from legacy namespace "${LEGACY_POLICY_NAMESPACE}" (${legacy.pairs.length} pairs, ${legacy.trustedSenders.length} trusted senders)`);
			return "migrated";
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: legacy policy migration failed (legacy data left in place): ${describeError(error)}`);
			return "failed";
		}
	}

	/**
	 * The fiber that owned the settings scopes is gone, so the scopes are dead:
	 * the store goes back to "unattached" instead of quietly serving a dead one
	 * (评审 round-2 🟡 #1). The owner is either the provider's injection fiber (the
	 * provider went away) or this plugin's own fiber (unload / reload), so the
	 * line names the release without claiming which of the two happened. `get()` /
	 * `update()` then take the §9.1.3 ③ lazy-retry path again, which re-attaches as
	 * soon as the provider comes back — and until then the memory engine answers,
	 * which is this store's documented unattached state rather than a stale scope
	 * pretending to be live.
	 *
	 * Without this, a late `ctx.inject(["settings"], …)` attach outlives its
	 * provider: `scope` stays non-null while dead, so every `update()` throws
	 * into the caller's「写入设置失败」path while every `get()` silently answers
	 * from process memory — a read/write divergence that no retry can repair,
	 * because the retry is gated on `scope === null`.
	 *
	 * Idempotent: repeated calls (both scopes already released) are no-ops.
	 *
	 * 评审 round-3 🟡 #1: releasing the scopes also RE-OPENS the one-shot warn gate.
	 * The gate counts unattached windows, and this call ends one — so if the
	 * provider comes back and this time REFUSES `register`, that window must say
	 * so. Pre-fix the gate was process-lifetime: the second window's refusal was
	 * swallowed, and the only trace was the release line's "memory-only until it
	 * attaches again" — which cannot distinguish 「仍在等」 from 「被拒绝」, the very
	 * distinction this gate exists for (silent refusal is the original ③ defect).
	 * Retries inside one window still share the gate, so this stays one warn per
	 * window rather than a warn storm.
	 */
	function detach() {
		if (scope === null && legacyScope === null) return;
		scope = null;
		legacyScope = null;
		attachWarned = false;
		ctx.logger?.info?.(`${PLUGIN_LABEL}: settings scope released with its owner fiber — policy store is memory-only on namespace "${POLICY_NAMESPACE}" until it attaches again`);
	}

	/**
	 * Attach the store to one settings service (§9.1.3). Idempotent: the first
	 * successful attach wins and everything after it is a no-op. A provider that
	 * refuses `register` leaves the store memory-only — with a warn, never
	 * silently, and never more than once per unattached window: the lazy retries
	 * reach this catch again on every `get()` / `update()` while `scope` stays
	 * null, so the line goes through the SAME one-shot gate as the
	 * "not active at activation" line below (U11: an unattached window carries
	 * exactly one warn, whichever arrival path got there first). `detach()` ends
	 * a window and re-opens that gate (评审 round-3 🟡 #1) — the next window's
	 * refusal is its own line, not silence behind the previous window's.
	 *
	 * `owner` is the context the service was read from, and the scopes are bound
	 * to ITS fiber's lifetime (评审 round-2 🟡 #1) — the same ownership rule the
	 * export route already uses for `webServer`
	 * (`target.effect(() => webServer.register(…))`, see registerExportRoute):
	 * the effect belongs to the context that found the service, so a late
	 * injection's attach is undone together with its own injection fiber. For
	 * the fast path that owner is this plugin's own fiber (see attachFrom).
	 */
	function attach(settings, owner) {
		if (scope !== null) return;
		try {
			scope = settings.register(POLICY_NAMESPACE, PolicyConfig, { base: structuredClone(DEFAULT_POLICY) });
		} catch (error) {
			if (!attachWarned) {
				attachWarned = true;
				// The only arrival that reaches this catch: `attachFrom` calls here
				// only after a service with a `register()` was handed over, so the
				// provider answered and refused this register. The other arrival —
				// "no service yet / no register()" — is named by the activation
				// branch, which writes through this same gate. (评审 round-3 🔵 #2:
				// a third, `unavailableDetail`, parameter used to sit here claiming
				// the activation branch routed its wording through it; no caller
				// ever passed it — that route never existed.)
				ctx.logger?.warn?.(`${PLUGIN_LABEL}: settings register failed (${describeError(error)}) — 状态仅存进程内存`);
			}
			return;
		}
		try {
			legacyScope = settings.register(LEGACY_POLICY_NAMESPACE, PolicyConfig, { base: structuredClone(DEFAULT_POLICY) });
			legacyRefused = false;
		} catch (error) {
			// best-effort ≠ silent (评审 #4): the legacy namespace is optional, but
			// an unavailable one means the pre-rename trust data is NOT migrated —
			// that has to be visible rather than swallowed. The flag carries the
			// same fact into the chain line, where "refused" and "never had that
			// namespace" used to read identically (评审 round-3 🔵 #5).
			legacyScope = null;
			legacyRefused = true;
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: legacy namespace "${LEGACY_POLICY_NAMESPACE}" unavailable (${describeError(error)}) — 旧命名空间的信任数据不会自动迁移`);
		}
		ctx.logger?.info?.(`${PLUGIN_LABEL}: policy store attached to settings namespace "${POLICY_NAMESPACE}"`);
		// 评审 round-2 🟡 #1: the two scopes above live exactly as long as the
		// fiber of the context they were taken from. Registering that binding is
		// what makes a provider restart observable to this store at all; if the
		// owner refuses the effect, the scope is now unbindable and that must be
		// said out loud (a provider that goes away would leave a dead scope
		// attached — the very failure this binding exists to prevent).
		try {
			owner.effect(() => () => detach(), "team-link: policy store settings scope");
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: could not bind the settings scope to its owner fiber's lifetime (${describeError(error)}) — this store would keep serving the scope after its owner is gone`);
		}
		// §9.1.3 调用点迁移：the one-time legacy migration is driven from here, not
		// from apply — before the attach there is no current namespace to compare
		// the legacy one against (at apply time the call was a guaranteed no-op).
		// The order matters: any write made during the memory-only window is folded
		// in FIRST, so the migration's "current namespace already in use?" test
		// sees the final state and cannot overwrite newer data with legacy data.
		//
		// 评审 round-2 🔵 #3: this chain used to be fire-and-forget with a silent
		// `catch`, so its outcome was unobservable — a reader could not tell
		// "migrated" from "skipped" from "failed" without instrumenting the store.
		// One info line now names both steps' outcomes; the steps' own lines (and
		// the early catch inside migrateLegacyPolicy) stay where they are.
		void adoptMemoryWindow()
			.then(async (memoryOutcome) => {
				const legacyOutcome = await migrateLegacyPolicy();
				ctx.logger?.info?.(`${PLUGIN_LABEL}: post-attach policy chain finished — memory window: ${memoryOutcome}; legacy migration: ${legacyOutcome}`);
			})
			.catch((error) => {
				ctx.logger?.warn?.(`${PLUGIN_LABEL}: post-attach policy chain failed (${describeError(error)}) — 内存窗口并入 / 旧命名空间迁移的完成情况未知，状态仍以设置命名空间为准`);
			});
	}

	/**
	 * §9.1.3 数据一致性（防御性冗余）: the memory engine can only be written inside
	 * the startup window — before the attach, and in practice before any agent
	 * exists to call a tool. Should it nevertheless happen, the write must not be
	 * silently dropped when settings finally arrives: fold it in under the same
	 * rule as the legacy migration (only while the settings namespace is still at
	 * defaults — settings stays the source of truth), and say so in one line.
	 *
	 * @returns a one-token outcome for the chain's completion line (评审 round-2
	 *   🔵 #3): "none (no writes while unattached)", "not folded (settings
	 *   namespace already in use)", "folded into settings" or "fold failed".
	 *   The window flag is cleared on the two outcomes that CONSUME it (评审
	 *   round-3 🔵 #3) — otherwise a later, brand-new provider would fold the same
	 *   memory state a second time and log the "理论不可达" warn again, i.e. the flag
	 *   would outlive the window it belongs to. `fold failed` keeps it set: those
	 *   writes are genuinely still memory-only, so the next attach must retry.
	 *
	 * 差异审计修复轮 🟡-1: this patch and {@link policyIsAtDefaults} are the two
	 * halves of ONE licence — the predicate says "the namespace holds nothing", the
	 * patch is the wholesale write it licenses — so a key added to
	 * {@link DEFAULT_POLICY} has to appear in BOTH. The ② round added
	 * `pendingCreates`, and only the predicate followed: `get()` read a view whose
	 * `pendingCreates` was the in-memory row while this patch wrote the other seven
	 * keys, so a §10.2.6 intent written in the startup window was dropped at the
	 * fold and the next boot's sweep had nothing to report (the durable orphan
	 * record that is the whole point of the key). Every key of `DEFAULT_POLICY` is
	 * named below, deliberately in the same order, so the next one cannot be
	 * half-added.
	 */
	async function adoptMemoryWindow() {
		if (!memoryDirty) return "none (no writes while unattached)";
		const current = get();
		if (!policyIsAtDefaults(current)) {
			memoryDirty = false;
			return "not folded (settings namespace already in use)";
		}
		try {
			await update({
				receiveMode: memory.receiveMode,
				trustedSenders: [...memory.trustedSenders],
				blockedSenders: [...memory.blockedSenders],
				rememberTargets: [...memory.rememberTargets],
				pairs: [...memory.pairs],
				watchdogs: [...memory.watchdogs],
				teams: [...memory.teams],
				pendingCreates: [...memory.pendingCreates],
			});
			memoryDirty = false;
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: policy store attached with writes from the memory-only startup window — 这些写入已并入设置命名空间 "${POLICY_NAMESPACE}"（该窗口理论不可达，本次确实发生了）`);
			return "folded into settings";
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: failed to fold the memory-only startup window into settings (${describeError(error)}) — 窗口内的写入仍在进程内存里，本次未能落盘`);
			return "fold failed";
		}
	}

	/**
	 * Attach from whatever one context can hand over right now. Never throws.
	 *
	 * Returns WHY it did or did not attach (评审 round-2 🔵 #2), so the activation
	 * branch below can name the reason instead of reading `ctx.get("settings")` a
	 * second time — the two reads could straddle the moment the provider appears,
	 * and the warn would then describe a state that is no longer true.
	 *
	 * - `"attached"` — a live scope, either already present or just registered;
	 * - `"refused"` — the provider answered but `register` threw; {@link attach}
	 *   already left its line through the shared one-shot gate, so the activation
	 *   branch must not run (and must not relabel that line);
	 * - `"no-register"` — there IS a settings service here without `register()`;
	 * - `"not-active"` — nothing to take from this context (yet).
	 *
	 * `target` is also passed on as the scope's owner, so whichever context
	 * produced the service owns its lifetime too (评审 round-2 🟡 #1): the fast
	 * path binds the scope to this plugin's own fiber, the late injection to its
	 * own injection fiber.
	 */
	function attachFrom(target) {
		if (scope !== null) return "attached";
		const settings = target.get?.("settings");
		if (settings === undefined) return "not-active";
		if (typeof settings.register !== "function") return "no-register";
		attach(settings, target);
		return scope !== null ? "attached" : "refused";
	}

	// ① Fast path — a provider that is already active (or a synchronous stub).
	//    That context is this plugin's own fiber: the store, its tools, the
	//    watchdog timers and this effect all die together with it, and a plugin
	//    restart re-runs `apply` into a fresh store — so a scope taken here can
	//    never be reachable while dead. It is still bound (attach does that for
	//    every owner) so teardown is explicit and both sites of §9.1.3 behave
	//    alike; what it does NOT need is a retry of its own.
	const activationReason = attachFrom(ctx);
	if (activationReason !== "attached" && activationReason !== "refused") {
		// ② Not there yet: leave exactly one line (§5.3 红线: 不得静默失效) and
		// register the optional ordered injection. `ctx.inject` is not a hard
		// dependency: when the service never appears, this plugin still loads and
		// runs on the memory engine. The line is written through the same gate the
		// register failure uses, so the two arrival paths share one warn. The
		// reason comes from the read above — not from a second `ctx.get`.
		if (!attachWarned) {
			attachWarned = true;
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: settings not active at activation (${activationReason === "no-register" ? "no register()" : "not yet active"}) — memory-only until it attaches; no persistence meanwhile`);
		}
		if (typeof ctx.inject === "function") {
			ctx.inject(["settings"], (child) => { attachFrom(child); });
		} else {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: ctx.inject unavailable — 依赖首次工具调用时的惰性重试兜底`);
		}
	}
	// ③ 惰性兜底 lives in get()/update() above: retry silently, attach on
	//    success (the attach line plus the chain's outcome line), and never
	//    repeat the activation warn.

	return { get, update, migrateLegacyPolicy };
}

// ---------------------------------------------------------------------------
// cross-session watchdog (§3.2)
// ---------------------------------------------------------------------------

/** Inclusive bounded-number reading for one registration argument. */
function readBoundedNumber(value, name, min, max, options = {}) {
	if (value === undefined || value === null) return { value: undefined };
	if (typeof value !== "number" || !Number.isFinite(value)) return { error: `${name} 必须是数字。` };
	if (options.integer === true && !Number.isInteger(value)) return { error: `${name} 必须是整数。` };
	if (value < min) return { error: `${name} 不能小于 ${min}。` };
	if (max !== undefined && value > max) return { error: `${name} 不能大于 ${max}。` };
	return { value };
}

/** TTL reading (§3.2.4: `<= 24h`, default 12h; strictly positive). */
function readTtlHours(value) {
	if (value === undefined || value === null) return { value: WATCHDOG_DEFAULT_TTL_HOURS };
	if (typeof value !== "number" || !Number.isFinite(value)) return { error: "ttlHours 必须是数字。" };
	if (value <= 0) return { error: "ttlHours 必须大于 0。" };
	if (value > WATCHDOG_MAX_TTL_HOURS) return { error: `ttlHours 不能大于 ${WATCHDOG_MAX_TTL_HOURS}（防失控）。` };
	return { value };
}

/**
 * Build one validated registration (§3.2.2 schema, §3.2.4 anti-runaway rules).
 * Pure — it neither reads nor writes the store — so every bound is directly
 * testable and a rejected request can never leave a half-written entry behind.
 *
 * @returns `{ value: entry }` or `{ error: reason }`.
 */
function buildWatchdogRegistration(request) {
	const caller = request.caller;
	const now = request.now;
	const targets = [...new Set((Array.isArray(request.targets) ? request.targets : [])
		.filter((target) => typeof target === "string" && target.trim() !== "")
		.map((target) => target.trim()))];
	if (targets.length === 0) return { error: "register 需要 targets（至少一个被盯会话 id）。" };
	if (targets.includes(caller)) return { error: "register 拒绝自指注册：targets 不能包含观察者自身会话（自指 = 变相的自 tick 定时器，§3.2.4）。" };
	const silent = readBoundedNumber(request.silentMinutes, "silentMinutes", WATCHDOG_MIN_SILENT_MINUTES, undefined, { integer: true });
	if (silent.error !== undefined) return { error: silent.error };
	const interval = readBoundedNumber(request.intervalMinutes, "intervalMinutes", WATCHDOG_MIN_INTERVAL_MINUTES, undefined, { integer: true });
	if (interval.error !== undefined) return { error: interval.error };
	const ttl = readTtlHours(request.ttlHours);
	if (ttl.error !== undefined) return { error: ttl.error };
	return {
		value: {
			id: `${WATCHDOG_ID_PREFIX}${randomUUID()}`,
			team: null,
			watcherSession: caller,
			targets,
			silentMinutes: silent.value ?? WATCHDOG_DEFAULT_SILENT_MINUTES,
			intervalMinutes: interval.value ?? WATCHDOG_DEFAULT_INTERVAL_MINUTES,
			expiresAt: now + ttl.value * 3600000,
			createdAt: now,
		},
	};
}

/**
 * The watchdog tick message (§3.2.3). Both bodies are plugin constants: the
 * only interpolated values are status fields (target id, reading time, silence
 * duration), so no registration argument can smuggle a payload into the
 * watcher's next request. The source is the audited three-member relay shape
 * (V10) — the watchdog has no session identity of its own, so the watcher is
 * recorded as the sender of the message it receives (§3.2.3 note (a)).
 */
function tickMessage(watcherSession, target, signal, now) {
	let text;
	if (signal.verdict === "goal-disarmed") {
		text = `[watchdog] 目标 ${target} 的 goal 处于 active-but-disarmed（可能原因：max-tokens 回合结束 / DSH 重启 / agent error，读数 ${readStamp(now)}）。该状态不会自愈：请向用户说明并请求授权 resume；用户同意后调用 update_goal(action:"resume") 恢复续跑。复核用 team_link_list_sessions。`;
	} else {
		text = `[watchdog] 目标 ${target} 失联征兆：verdict=${signal.verdict} 静默 ${fmtSilence(signal.silenceMs)}（读数 ${readStamp(now)}）。请用 team_link_list_sessions 复核后处置；误报或不再需要盯人可用 team_link_watch clear。`;
	}
	return {
		id: `${WATCHDOG_TICK_ID_PREFIX}${randomUUID()}`,
		role: "user",
		source: { kind: "agent-message", form: "relay", senderSessionId: watcherSession },
		content: [{ type: "text", text: wellFormed(text) }],
	};
}

/** Best-effort session surface read; an unreadable or cold log yields `undefined`. */
async function readSessionSurface(ctx, sessionId) {
	try {
		return await ctx.sessionQuery.readSurface(sessionId);
	} catch {
		return undefined;
	}
}

/**
 * Cross-session watchdog controller (§3.2.3). One interval timer per
 * registration at its `intervalMinutes` granularity, plus two process-local
 * maps: the per-target tick debounce and the watcher-dead marks. §3.2.4 is
 * explicit that neither is persisted — a restart forgets them, which may cost
 * one extra tick and never resurrects a stale "already handled" state.
 */
function createWatchdog(ctx, policy, rotation) {
	const timers = new Map();
	const ticked = new Map();
	const deadWatchers = new Map();
	let disposed = false;

	function stopTimer(id) {
		const timer = timers.get(id);
		if (timer === undefined) return;
		clearInterval(timer);
		timers.delete(id);
	}

	/** Drop every process-local trace of one registration. */
	function forget(id) {
		for (const key of [...ticked.keys()]) if (key.startsWith(`${id}\n`)) ticked.delete(key);
		deadWatchers.delete(id);
	}

	/** (Re)arm the patrol timer of one registration. */
	function schedule(entry) {
		if (disposed) return;
		stopTimer(entry.id);
		const timer = setInterval(() => {
			void patrol({ id: entry.id }).catch((error) => {
				ctx.logger?.warn?.(`${PLUGIN_LABEL}: watchdog patrol failed: ${describeError(error)}`);
			});
		}, entry.intervalMinutes * 60000);
		// A patrol timer is background housekeeping: it must never hold the shell open.
		timer.unref?.();
		timers.set(entry.id, timer);
	}

	/** Drop one registration and its timer (clear tool, TTL self-clean). */
	async function removeWatchdog(id) {
		stopTimer(id);
		forget(id);
		const current = policy.get().watchdogs;
		if (!current.some((entry) => entry.id === id)) return;
		try {
			await policy.update({ watchdogs: current.filter((entry) => entry.id !== id) });
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: watchdog ${id} could not be removed: ${describeError(error)}`);
		}
	}

	/**
	 * Already ticked for this target's current silent period? The watermark is the
	 * target's last observed activity (§3.1's two timestamps): unchanged since the
	 * last tick means nothing happened in between, so the same silence is still
	 * being reported and a second tick would be noise. It also covers targets
	 * whose silence cannot be measured at all (a gone agent has no activity
	 * watermark either, so it is ticked once and not on every patrol).
	 *
	 * A watermark that DID advance is a new silence period, but the patrol also
	 * waits out one interval before reporting it — the "去抖间隔" of §3.2.4, so a
	 * burst of activity cannot produce a burst of ticks.
	 */
	function recentlyTicked(id, target, signal, intervalMinutes, now) {
		const last = ticked.get(`${id}\n${target}`);
		if (last === undefined) return false;
		if (last.activity === lastActivityOf(signal)) return true;
		return now - last.at < intervalMinutes * 60000;
	}

	function markTicked(id, target, signal, now) {
		ticked.set(`${id}\n${target}`, { at: now, activity: lastActivityOf(signal), silenceMs: signal.silenceMs });
	}

	/**
	 * Watcher agent gone: mark the signal face and leave the registration alone
	 * (A4 — nothing can wake a closed session; the tick has nowhere to land).
	 * The mark is process-local, so if the watcher comes back inside the TTL the
	 * patrol simply resumes delivering.
	 */
	function markWatcherDead(id, now) {
		if (deadWatchers.has(id)) return;
		deadWatchers.set(id, now);
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: watchdog ${id} observer session is not live; keeping the registration until its TTL`);
	}

	/**
	 * One pass for one registration (§3.2.3, line by line): an expired
	 * registration self-cleans FIRST — ahead of every watcher gate, so a watcher
	 * that is gone, running or armed-active can never keep an expired row (and its
	 * empty timer) alive (§3.2.3 TTL 自清【最先】, audit D1); then missing watcher →
	 * mark the signal face and stop; running watcher → never interrupt; armed-active
	 * watcher → it has its own cadence (A1); then per target: skip every verdict
	 * outside {@link TICKABLE_VERDICTS}, debounce one tick per silent period, and
	 * deliver.
	 */
	async function patrolOne(entry, now) {
		if (now > entry.expiresAt) {
			await removeWatchdog(entry.id);
			return;
		}
		const watcher = ctx.agents.get(entry.watcherSession);
		if (watcher === undefined) {
			markWatcherDead(entry.id, now);
			return;
		}
		deadWatchers.delete(entry.id);
		if (watcher.status === "running") return;
		const watcherGoal = readGoalSignal(ctx, entry.watcherSession, watcher);
		if (watcherGoal !== null && watcherGoal.phase === "active" && watcherGoal.activation === "armed") return;
		for (const target of entry.targets) {
			const targetAgent = ctx.agents.get(target);
			const surface = targetAgent === undefined ? undefined : await readSessionSurface(ctx, target);
			const signal = buildLivenessSignal(ctx, target, {
				now,
				agent: targetAgent,
				surface,
				silentMin: entry.silentMinutes,
				runMin: LV_RUN_MIN,
			});
			if (!TICKABLE_VERDICTS.has(signal.verdict)) continue;
			if (recentlyTicked(entry.id, target, signal, entry.intervalMinutes, now)) continue;
			try {
				watcher.followup(tickMessage(entry.watcherSession, target, signal, now));
				markTicked(entry.id, target, signal, now);
			} catch (error) {
				ctx.logger?.warn?.(`${PLUGIN_LABEL}: watchdog tick to ${entry.watcherSession} failed: ${describeError(error)}`);
			}
		}
	}

	/**
	 * Run one patrol pass over every registration, or over one explicit id.
	 * `now` is injectable so the TTL and debounce behaviour is testable without
	 * waiting for wall-clock time.
	 */
	async function patrol(options = {}) {
		if (disposed) return;
		const now = typeof options.now === "number" ? options.now : Date.now();
		for (const entry of policy.get().watchdogs) {
			if (options.id !== undefined && entry.id !== options.id) continue;
			await patrolOne(entry, now);
		}
		// §3.6.2 评审 #4: the M4 expiry sweep rides this same patrol timer — one
		// background timer for both jobs, and it dies with the plugin. The timer only
		// exists per registration (§3.2.4), so the roster/rotate/team-read lazy calls
		// are what keep a team without a single watchdog from staying frozen.
		await runRotationSweep(now);
	}

	/** Best-effort M4 sweep: a sweep failure is logged, never a patrol failure. */
	async function runRotationSweep(now) {
		if (rotation === null || rotation === undefined || typeof rotation.sweep !== "function") return;
		try {
			await rotation.sweep({ now });
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: rotation sweep failed: ${describeError(error)}`);
		}
	}

	/**
	 * Arm the timers of every persisted registration and hand back the disposer
	 * that is passed to `ctx.effect` — the plugin's only background work must die
	 * with the plugin (§3.2.4 / the task's cleanup requirement).
	 */
	function start() {
		for (const entry of policy.get().watchdogs) schedule(entry);
		return () => {
			disposed = true;
			for (const id of [...timers.keys()]) stopTimer(id);
			timers.clear();
			ticked.clear();
			deadWatchers.clear();
		};
	}

	/** Clear one registration's process-local state (the clear tool's target). */
	function cancel(id) {
		stopTimer(id);
		forget(id);
	}

	// `deadWatchers` is read by the watch tool's list action; `timers` and
	// `ticked` are exposed so host-half.test.mjs can assert timer ownership and
	// the debounce without reaching into closure state.
	return { start, schedule, cancel, patrol, removeWatchdog, timers, ticked, deadWatchers };
}

// ---------------------------------------------------------------------------
// roster (team role registry) + team blackboard (§3.3, M2)
// ---------------------------------------------------------------------------

/** Team names are `[a-z0-9-]+` (§3.3.1). The name becomes a path segment of the
 * blackboard directory, so every other shape — a separator, a dot, an empty
 * string — is refused at the door instead of reaching `path.join`. */
const TEAM_NAME_RE = /^[a-z0-9-]+$/u;
/** The convention role whose incumbent is the writer under the default
 * `policy.writer === "coordinator"` (§3.3.1/§3.3.2); other roles are free-form. */
const COORDINATOR_ROLE = "coordinator";
/** Blackboard directory (inside a team's captured workspace) and its files. */
const TEAM_DIR = "team";
const ROSTER_MIRROR_FILE = "roster.md";
const DECISIONS_FILE = "decisions.md";
const DISCIPLINE_FILE = "discipline.md";
/** The `file` argument is a closed set (§4.1) — never a caller-supplied path. */
const BLACKBOARD_FILES = new Set(["decisions", "discipline"]);
/** §4.1: one blackboard line may not exceed this many characters, counted in
 * code points so an astral character costs one (the `preview` convention). */
const BLACKBOARD_LINE_LIMIT = 500;
/** Trailing decisions returned by one `team_link_team_read` (§3.3.3, K = 20). */
const DECISIONS_WINDOW = 20;
/** Longest role name accepted — a role name is a settings key and a markdown
 * heading, not a document. */
const ROLE_NAME_LIMIT = 64;

/** Team name reading (§3.3.1): `[a-z0-9-]+`, trimmed; everything else refuses. */
function readTeamName(value) {
	if (typeof value !== "string" || value.trim() === "") return { error: "需要 team（团队名）。" };
	const name = value.trim();
	if (!TEAM_NAME_RE.test(name)) return { error: `团队名 ${name} 非法：只允许 [a-z0-9-]+（团队名是黑板目录的路径段，收紧字符集以杜绝路径穿越）。` };
	return { value: name };
}

/** Role name reading: non-empty, bounded, free of control characters, and never
 * the addressing grammar's reserved word — a role name is stored in settings,
 * rendered as a markdown heading AND is a path segment of `team:<name>/<role>`.
 * A role literally named `*` would make `team:<name>/*` ambiguous: the wildcard
 * branch of §3.4 is matched first, so the role could never be addressed (R6, M3
 * review). */
function readRoleName(value) {
	if (typeof value !== "string" || value.trim() === "") return { error: "需要 role（角色名；约定角色名 coordinator）。" };
	const role = value.trim();
	if (role === "*") return { error: "角色名不能是 *（寻址文法保留字：team:<name>/* 表示全队广播，§3.4；以 * 命名的角色永远无法被点对点寻址）。" };
	if ([...role].length > ROLE_NAME_LIMIT) return { error: `角色名过长（上限 ${ROLE_NAME_LIMIT} 字符）。` };
	if (/[\u0000-\u001F\u007F]/u.test(role)) return { error: "角色名不能包含控制字符或换行。" };
	return { value: role };
}

/** Session id reading for `set-role` — one line, so a history record cannot be
 * split by an injected newline or a `|` separator. */
function readSessionId(value) {
	if (typeof value !== "string" || value.trim() === "") return { error: "需要 session（新现任会话 id）。" };
	const session = value.trim();
	if (/[\r\n|]/u.test(session)) return { error: "session 不能包含换行或 | 字符。" };
	return { value: session };
}

/** History note reading: optional, trimmed; an empty note is no note. */
function readNote(value) {
	if (typeof value !== "string") return undefined;
	const note = value.trim();
	return note === "" ? undefined : note;
}

/**
 * One role record in the canonical field order of {@link normalizeRoles}. Every
 * internal constructor goes through here: a stored row must round-trip through
 * normalize → write → normalize without changing shape (the U4 idempotency
 * assertion compares the stored JSON), and that includes the M4 fields a caller
 * may not have thought about.
 *
 * `recoveries` is §11.9.5⑦'s first audit trail (version history): one row per
 * `team_link_recover` invocation, with the requester named. It is a field of a
 * role ROW, not a new policy key — the eight top-level keys stay eight (U29).
 */
function roleRecord(fields) {
	return {
		role: fields.role,
		current: fields.current ?? null,
		pending: fields.pending ?? null,
		rotationAt: typeof fields.rotationAt === "number" && Number.isFinite(fields.rotationAt) ? fields.rotationAt : 0,
		provisional: fields.provisional ?? null,
		rotationStatus: typeof fields.rotationStatus === "string" ? fields.rotationStatus : "",
		history: fields.history ?? [],
		recoveries: fields.recoveries ?? [],
	};
}

/**
 * §11.9.5⑦ recovery audit rows, normalized the way every other role field is:
 * only a well-shaped row survives, and a row written by hand without the
 * declared fields is dropped rather than carried as a half-record.
 */
function normalizeRecoveries(list) {
	if (!Array.isArray(list)) return [];
	const rows = [];
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) continue;
		const verb = typeof entry.verb === "string" ? entry.verb : "";
		if (!RECOVERY_VERBS.has(verb)) continue;
		const row = {
			verb,
			at: entry.at,
			by: typeof entry.by === "string" ? entry.by : "",
			from: typeof entry.from === "string" && entry.from !== "" ? entry.from : null,
			to: typeof entry.to === "string" && entry.to !== "" ? entry.to : null,
		};
		if (typeof entry.note === "string" && entry.note !== "") row.note = entry.note;
		rows.push(row);
	}
	return rows;
}

// ---------------------------------------------------------------------------
// §11.9.3 诊断面 — liveness is read, never persisted
// ---------------------------------------------------------------------------
//
// HONESTY, STATED WHERE IT BELONGS (design §11.9.3): liveness is a process-local,
// transient, OBSERVER-RELATIVE fact (upstream: "Ambient presence is neither
// liveness proof nor authorization"). It is therefore NEVER written down — not
// into the roster rows, not into the `roster.md` mirror, which is a FILE on disk.
// Landing a reading in a durable artifact makes it stale the moment it lands, and
// a plugin reload lands a whole wave of them at once (§10.2.5: unload/reload tears
// down every plugin-created agent). What IS durable is only the DESIGNER's
// expression — `current === null` — and that is a different fact:
//
//   vacant      = current 为 null        → 用户显式表达的空缺（§3.3.2 retire 的产物）
//   seated-dead = current 非空，但无活代理 → 悬空指针（死亡空缺）
//
// The two words are DERIVED at read time and rendered only on live read faces:
// the three gates' refusals, `roster get`'s incumbent row, and the startup sweep.
// Merging them would hand both situations the wrong first action: a vacancy is
// fixed in the settings UI, a dead incumbent is fixed by reopening that session.

/** The word for a role whose `current` is the empty seat (deliberate vacancy). */
const VACANT_LABEL = "vacant";
/** The word for a role whose seat is taken but whose holder has no live agent. */
const SEATED_DEAD_LABEL = "seated-dead";

/** §11.9.5① the CLOSED verb set of the recovery tool. Exactly two, because the
 * audit landing point has to be single and countable: a verb that is not in this
 * set is refused before anything is read, which is what keeps «恢复» from
 * decaying into a second, looser roster editor. */
const RECOVERY_VERBS = new Set(["revive", "reappoint"]);
/** §11.9.5⑦'s audit note on the roster row, in ONE fixed shape: the verb, the
 * agent-named reason term, and the requester. An unattributed recovery is exactly
 * the thing the design refuses to allow, so the requester is never omitted.
 *
 * The REASON term is `vacant-due-to-death` BY DESIGN (design §11.9.5⑦'s own
 * wording) — the D-word is NOT `seated-dead`, because this note is mirrored into
 * `roster.md`, and §11.9.3 forbids landing a LIVENESS term in that file. The
 * liveness reading lives where it belongs: the `decisions.md` audit row and the
 * tool's answer, both of which are events rather than a state mirror. The invented
 * id is sanitized here so the note can never carry a newline into a history row. */
function recoveryNote(verb, requester) {
	const who = String(requester ?? "").replace(/[\u0000-\u001F\u007F|]/gu, "_");
	return `recovery(${verb}, vacant-due-to-death, requester=${who === "" ? "unknown" : who})`;
}

/** §11.9.4's recovery ladder, in the caller's terms, in ONE place: the gates'
 * refusals, `roster get`, the recovery tool's own refusals and the startup sweep
 * all point at the same three rungs (and the third one is always reachable). */
function recoveryLadderText() {
	return "恢复梯子：① 在侧边栏重新打开该会话（同一个会话 id 复活，身份/信任/pairs 零改动）→ ② team_link_recover action=revive（仅插件自建会话，需在场确认）→ ③ team_link_recover action=reappoint（现任不会/不应再回来时改任，走完整 M4 交接）→ ④ 设置 UI 直接改 team-link 的 teams 键（用户永远是超级写者）。";
}

/** One line of §11.9.3's read-time liveness diagnosis for a role row, or `""`
 * when there is nothing to diagnose. Pure: `isLive` is injected, and the seat
 * must be OCCUPIED for this to say anything — `current === null` is the
 * deliberate vacancy, whose existing wording ("请由用户经设置 UI 指定现任")
 * is already the correct first action (§11.9.3: the two emptinesses must stay
 * distinguishable, or both get the wrong guidance). */
function recoveryLadderSuffix(entry, isLive) {
	if (entry === null || entry === undefined) return "";
	const incumbent = entry.current;
	if (incumbent === null || incumbent === undefined || incumbent === "") return "";
	if (isLive(incumbent) === true) return "";
	return `\n【活性诊断】该角色不在空缺名单里——现任 ${incumbent} 被 roster 认定为该角色的持有者，但本进程当前没有它的活动代理（${SEATED_DEAD_LABEL}；「能通讯、不能改身份」：黑板与 team_link_send 仍通，被卡住的是 roster 变更 / 换届 / 建队登记）。这不是「刻意空缺」（${VACANT_LABEL}，current=null），所以这里不该改人，而该把那个会话拉回来。${recoveryLadderText()}`;
}

/** A tool-layer liveness probe: the plugin's own live registry, read once. */
function agentIsLive(ctx, sessionId) {
	return typeof sessionId === "string" && sessionId !== "" && ctx.agents.get(sessionId) !== undefined;
}

/** §11.9.3's enrichment of a pure gate's refusal. The gate bodies stay PURE
 * (`writerGate` / `rotateGate` / `retireGate` take no `ctx` and are exported to
 * the test surface as such); the TOOL layer — which has a `ctx`, and therefore a
 * liveness reading — appends the named diagnosis to the refusal it already got.
 * A gate that passed, or whose message has nothing to diagnose (vacant seat,
 * caller without a session identity), comes back byte-identical. */
function withLiveGateDiagnostic(ctx, entry, result) {
	if (result === undefined || result === null || result.error === undefined) return result;
	const suffix = recoveryLadderSuffix(entry, (id) => agentIsLive(ctx, id));
	return suffix === "" ? result : { ...result, error: `${result.error}${suffix}` };
}

/**
 * §11.9.3's startup-sweep row: every role whose seat is taken but whose holder
 * has no live agent, across every team. This is the FIRST thing a user sees after
 * a reload took the whole plugin-created roster down (§10.2.5), so it names the
 * roles and the ladder instead of waiting for somebody to be refused.
 *
 * A `current === null` role is NOT listed: that is the deliberate vacancy, and
 * reporting it here would turn a design decision into an alarm.
 */
function seatedDeadRoles(view, isLive) {
	const rows = [];
	for (const team of view.teams) {
		for (const entry of team.roles) {
			const incumbent = entry.current;
			if (incumbent === null || incumbent === undefined || incumbent === "") continue;
			if (isLive(incumbent) === true) continue;
			rows.push(`- 团队 ${team.name} 的角色 ${entry.role}：现任 ${incumbent} 无活动代理（${SEATED_DEAD_LABEL}）——盘上会话仍在，${recoveryLadderText()}`);
		}
	}
	return rows;
}

/** One role record of a team, or `null`. */
function roleOf(team, role) {
	return team.roles.find((entry) => entry.role === role) ?? null;
}

/** The open (incumbent) tenure record of one role, or `null` — `until: null` is
 * what marks the tenure the current holder is still serving. */
function openTenureOf(entry) {
	for (let index = entry.history.length - 1; index >= 0; index -= 1) {
		const record = entry.history[index];
		if (record.session === entry.current && record.until === null) return record;
	}
	return null;
}

/** The start of a role's open tenure — the incumbent's `from`, falling back to
 * the team creation time when history holds no open record (hand-edited row). */
function tenureStartOf(entry, team) {
	const open = openTenureOf(entry);
	return open === null ? team.createdAt : open.from;
}

/** Close one tenure inside a history copy: set its `until` (and the note), or
 * append a closing record when no open one exists for that session (§3.3.2
 * "旧任 until=now, note"). Returns the same array, mutated. */
function closeTenure(history, session, now, note) {
	for (let index = history.length - 1; index >= 0; index -= 1) {
		const record = history[index];
		if (record.session !== session || record.until !== null) continue;
		record.until = now;
		if (note !== undefined) record.note = note;
		return history;
	}
	const previous = history.filter((record) => record.session === session).pop();
	const record = { session, from: previous === undefined ? now : previous.from, until: now };
	if (note !== undefined) record.note = note;
	history.push(record);
	return history;
}

/**
 * §3.3.2 write permission for one team. `policy.writer === "any"` admits every
 * session. `"coordinator"` (the default) admits only the session currently
 * holding the `coordinator` role — and a vacant coordinator refuses every
 * session path, because the design points that case at the settings UI, where
 * the user is always the super-writer.
 */
function writerGate(team, caller) {
	if (team.policy.writer === "any") return { ok: true };
	const coordinator = roleOf(team, COORDINATOR_ROLE);
	const incumbent = coordinator === null ? null : coordinator.current;
	if (incumbent === null) {
		return { error: `写操作被拒绝：团队 ${team.name} 的 policy.writer=coordinator，但 coordinator 角色当前空缺（current=null）——会话路径写不进去，请由用户经设置 UI（设置命名空间 team-link 的 teams 键）指定现任协调者。` };
	}
	if (caller === undefined) {
		return { error: `写操作被拒绝：团队 ${team.name} 的 policy.writer=coordinator，只有现任协调者会话 ${incumbent} 可写，而当前执行上下文没有会话身份（exec.agent.id）。` };
	}
	if (caller !== incumbent) {
		return { error: `写操作被拒绝：团队 ${team.name} 的 policy.writer=coordinator，只有现任协调者会话 ${incumbent} 可写（当前调用会话 ${caller}）。` };
	}
	return { ok: true };
}

/**
 * §3.3.2 (v1.3) retirement permission, implemented verbatim: "仅现任协调者会话
 * 或用户发起". Deliberately independent of `policy.writer` — the clause names
 * the incumbent coordinator, not the writer policy, so a `writer: "any"` team
 * still retires through its coordinator. The user path is the settings UI.
 */
function retireGate(team, caller) {
	const coordinator = roleOf(team, COORDINATOR_ROLE);
	const incumbent = coordinator === null ? null : coordinator.current;
	if (incumbent === null) {
		return { error: `退役被拒绝：团队 ${team.name} 的 coordinator 角色当前空缺（current=null），没有「现任协调者会话」可以发起退役。请由用户经设置 UI 处理。` };
	}
	if (caller === undefined || caller !== incumbent) {
		return { error: `退役被拒绝：只有现任协调者会话 ${incumbent} 可以发起退役（当前调用会话 ${caller ?? "（无会话身份）"}）。` };
	}
	return { ok: true };
}

/**
 * Pure `upsert-team` (§3.3.2): create a team, or update an existing one
 * idempotently. On an existing team only `policy` is updatable — and only the
 * user can change it (this tool has no policy parameter), so an existing team's
 * policy, roles, history and createdAt are all left alone. `workspace` is
 * captured from the creating session's `agentCwd` and is never overwritten; a
 * team that has no workspace yet (a row written by hand in the settings UI)
 * captures the first one that comes along.
 *
 * §3.3.2「创建即认领」(§9.2.2): a team created through this tool seeds its
 * `coordinator` role with the CREATING session as the incumbent, inside the same
 * write. The creation path deliberately does not pass `writerGate` (bootstrap
 * has to be reachable), while `writerGate` refuses every session path once the
 * coordinator is vacant — so without this seed a tool-created team would be born
 * un-writable and M2–M4 would be unreachable from the tool surface. It happens
 * only on creation, only for the session doing the creating; `request.coordinator`
 * is absent for an existing team (whose roles this function never touches), so
 * upsert-team stays idempotent and non-incumbents still cannot hijack a team.
 */
function applyTeamUpsert(teams, request) {
	const { name, workspace, now } = request;
	const existing = teams.find((team) => team.name === name) ?? null;
	if (existing === null) {
		const coordinator = typeof request.coordinator === "string" && request.coordinator !== "" ? request.coordinator : null;
		// `roleRecord` writes the canonical row (every TeamRoleConfig field
		// explicit), so a seeded roster round-trips through settings exactly like
		// one that set-role built.
		const roles = coordinator === null ? [] : [roleRecord({
			role: COORDINATOR_ROLE,
			current: coordinator,
			history: [{ session: coordinator, from: now, until: null, note: "创建者自举" }],
		})];
		// Every field the schema declares is written explicitly: this object may go
		// straight into renderRosterMirror, which reads team.rotationBackup.
		const team = { name, createdAt: now, workspace, policy: { writer: "coordinator" }, roles, rotationBackup: null };
		return { teams: [...teams, team], team, created: true, capturedWorkspace: workspace !== "" };
	}
	const captured = existing.workspace === "" && workspace !== "";
	const team = captured ? { ...existing, workspace } : existing;
	return { teams: teams.map((entry) => (entry.name === name ? team : entry)), team, created: false, capturedWorkspace: captured };
}

/**
 * Pure `set-role` (§3.3.2): replace the incumbent and extend the version history
 * — the previous tenure is closed (`until = now`, plus the caller's note) and
 * the new one is appended open (`until: null`). A role that does not exist yet
 * is created by the appointment. **pairs are never migrated here**: §3.3.2
 * reserves migration for the rotation flow (§3.6), so no hand-over can bypass
 * the rotation token — and a set-role that seats a rotation's PREPARED successor
 * clears that pending instead (评审 #9, see below): the token may not survive an
 * explicit change of identity, or the successor's own claim would read it as an
 * already-settled rotation and skip the symmetric revocation.
 * @returns `{ team, previous, clearedPending }` — `clearedPending` is true when
 *   this call invalidated an in-flight rotation token.
 */
function applySetRole(team, request) {
	const { role, session, note, now } = request;
	const existing = roleOf(team, role);
	const previous = existing === null ? null : existing.current;
	const history = existing === null ? [] : existing.history.map((record) => ({ ...record }));
	if (previous !== null) closeTenure(history, previous, now, note);
	const open = { session, from: now, until: null };
	// The note belongs to the hand-over it describes: it lands on the tenure being
	// closed. Only a first appointment (no previous holder) has nowhere else to
	// put it, so there it annotates the tenure it opens.
	if (previous === null && note !== undefined) open.note = note;
	history.push(open);
	// rotationAt/provisional ride along untouched: set-role换的是身份，不是换届
	// 记账（那些字段属于 M4 的 rotation 流程）。
	const next = existing === null
		? { role, current: session, history, pending: null }
		: { ...existing, current: session, history };
	// §3.6.2 评审 #9: seating the very session a rotation PREPARED as successor
	// invalidates that token. The pending survives otherwise, and the successor's
	// later claim then reads `current === pending.session` as "the previous claim
	// already settled" and replays: it would report the hand-over as landed while
	// the symmetric revocation (the retiree's pairs/trustedSenders/rememberTargets)
	// never ran — leaving the old coordinator's 免门通道 alive — and the claim path
	// would skip it silently. Identity changed by an explicit writer action, so the
	// token dies here and the claim hits the ordinary "没有 pending" refusal.
	const clearedPending = existing !== null && existing.pending !== null && existing.pending !== undefined && existing.pending.session === session;
	if (clearedPending) next.pending = null;
	const record = roleRecord(next);
	const roles = existing === null
		? [...team.roles, record]
		: team.roles.map((entry) => (entry.role === role ? record : entry));
	return { team: { ...team, roles }, previous, clearedPending };
}

/**
 * Pure `retire` (§3.3.2 v1.3): the role's `current` becomes vacant and the
 * incumbent's tenure is closed with the retirement note. Retire itself touches
 * no trust data — the optional cleanup runs afterwards, on the user's word.
 * @returns `{ team, retired }` or `{ error }`.
 */
function applyRetire(team, request) {
	const { role, note, now } = request;
	const existing = roleOf(team, role);
	if (existing === null) return { error: `团队 ${team.name} 没有角色 ${role}。` };
	if (existing.current === null) return { error: `团队 ${team.name} 的角色 ${role} 已经空缺（vacant），无需退役。` };
	const retired = existing.current;
	const history = existing.history.map((record) => ({ ...record }));
	closeTenure(history, retired, now, note);
	const roles = team.roles.map((entry) => (entry.role === role ? { ...entry, current: null, history } : entry));
	return { team: { ...team, roles }, retired };
}

/** Trust references pointing at one session, in both directions (§3.3.2 retire
 * cleanup). `pairs` is directional by construction and both ends are matched;
 * the two id lists are this plugin's global lists, so "pointing at" means the
 * session appears in them. */
function trustReferencesTo(view, session) {
	const pairs = view.pairs.filter((pair) => pair.a === session || pair.b === session);
	const trustedSenders = view.trustedSenders.filter((id) => id === session);
	const rememberTargets = view.rememberTargets.filter((id) => id === session);
	return { pairs, trustedSenders, rememberTargets, total: pairs.length + trustedSenders.length + rememberTargets.length };
}

/** Blackboard paths of one team. `name` is already `[a-z0-9-]+`, so no segment
 * of the joined path can escape the captured workspace. */
function blackboardPaths(team) {
	const dir = path.join(team.workspace, TEAM_DIR, team.name);
	return {
		dir,
		roster: path.join(dir, ROSTER_MIRROR_FILE),
		decisions: path.join(dir, DECISIONS_FILE),
		discipline: path.join(dir, DISCIPLINE_FILE),
	};
}

/** Human-readable rendering of one team — the `roster.md` mirror (§3.3.1). The
 * settings namespace stays the source of truth; this copy is overwritten by the
 * next roster change. A pending rotation token is rendered MASKED (first four /
 * last four characters): the mirror is a file on disk, and the full token is
 * handed out exactly once, in the `prepare` result (§3.6.2 评审 #3). */
function renderRosterMirror(team) {
	const lines = [
		`# 团队 roster：${team.name}`,
		"",
		`- 生成时间：${localStamp()}`,
		`- 创建时间：${readStamp(team.createdAt)}`,
		`- workspace：${team.workspace === "" ? "（未捕获）" : team.workspace}`,
		`- policy.writer：${team.policy.writer}（coordinator=仅现任协调者会话可写；any=任何会话可写）`,
		"- 事实源：设置命名空间 `team-link` 的 `teams` 键；本文件由 dsh-team-link 与设置变更同一事务内 best-effort 镜像，读以 settings 为准。",
	];
	if (team.rotationBackup !== null) {
		lines.push(`- 换届撤销快照（rotationBackup）：${readStamp(team.rotationBackup.at)} 时的 pairs ${team.rotationBackup.pairs.length} 条 / trustedSenders ${team.rotationBackup.trustedSenders.length} 项 / rememberTargets ${team.rotationBackup.rememberTargets.length} 项（对称撤销的还原依据）。`);
	}
	lines.push(
		"",
		"## 角色",
		"",
	);
	if (team.roles.length === 0) lines.push("（无角色：用 team_link_roster action=set-role 指定现任）", "");
	for (const entry of team.roles) {
		lines.push(`### ${entry.role}`, "");
		lines.push(`- 现任：${entry.current === null ? "空缺（vacant）" : `${entry.current}（自 ${readStamp(tenureStartOf(entry, team))}）`}`);
		lines.push(`- pending：${entry.pending === null ? "（无）" : `${entry.pending.session}（token ${maskToken(entry.pending.token)}（掩码；完整令牌只在 prepare 的一次性返回里），创建 ${readStamp(entry.pending.createdAt)}，到期 ${readStamp(entry.pending.expiresAt)}，team=${entry.pending.team} role=${entry.pending.role}，已迁移 ${entry.pending.migratedPairs === undefined ? 0 : entry.pending.migratedPairs.length} 条）`}`);
		lines.push(`- provisional：${entry.provisional === null ? "（无）" : `${entry.provisional.session === "" ? "" : `${entry.provisional.session} 的 `}信任迁移待批准（自 ${readStamp(entry.provisional.at)}，${readStamp(entry.provisional.expiresAt)} 到期未批准则自动回退）`}`);
		lines.push(`- 版本史（共 ${entry.history.length} 条，退役≠删除）：`);
		if (entry.history.length === 0) lines.push("  - （无）");
		for (const record of entry.history) {
			const until = record.until === null ? "现任" : readStamp(record.until);
			const note = record.note === undefined ? "" : `　备注：${preview(record.note, 200)}`;
			lines.push(`  - ${record.session}　${readStamp(record.from)} → ${until}${note}`);
		}
		// §11.9.5⑦ trail #2, and the ONLY durable home of a recovery record's reason:
		// rows of the version history carry a note but no verb, so a death recovery
		// needs its own audited line to stay distinguishable from a routine hand-over.
		// Liveness itself is deliberately absent from this file (§11.9.3).
		const recoveries = entry.recoveries ?? [];
		if (recoveries.length > 0) {
			lines.push(`- 恢复记录（team_link_recover，共 ${recoveries.length} 条）：`);
			for (const record of recoveries) {
				const note = record.note === undefined ? "" : `　备注：${preview(record.note, 200)}`;
				lines.push(`  - ${record.verb}　${record.from ?? "（无现任）"} → ${record.to ?? "（无）"}　${readStamp(record.at)}　发起会话 ${record.by === "" ? "unknown" : record.by}${note}`);
			}
		}
		lines.push("");
	}
	return wellFormed(`${lines.join("\n")}\n`);
}

/** Best-effort mirror write (§3.3.1: same transaction as the settings change; a
 * failure is a warning only — the settings namespace stays authoritative and the
 * next roster change rewrites the file). */
async function writeRosterMirror(team) {
	if (team.workspace === "") return { ok: false, error: "团队没有 workspace 记录，无法定位 <workspace>/team/<name>/roster.md" };
	try {
		const file = blackboardPaths(team).roster;
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, renderRosterMirror(team), "utf8");
		return { ok: true, path: file };
	} catch (error) {
		return { ok: false, error: describeError(error) };
	}
}

/** The mirror line of a tool result: success names the file, failure says the
 * settings namespace is unaffected (§3.3.1「失败仅告警」). */
function mirrorNote(mirror) {
	return mirror.ok
		? `镜像已更新：${mirror.path}`
		: `（注意：roster.md 镜像写入失败——${mirror.error}。settings 是本插件的事实源，本次变更已生效；镜像会在下一次 roster 变更时重试，也可手工从设置重建。）`;
}

/** Content hash of a blackboard file — the discipline file's optimistic lock
 * (§3.3.3). Truncated to 16 hex characters: short enough to carry in a tool
 * call, still 64 bits of a SHA-256 digest. */
function blackboardHash(text) {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** Read one blackboard file. A missing file is an empty file — reported as such
 * — and any other failure comes back as readable text instead of an exception
 * out of a tool call. */
async function readBlackboardFile(file) {
	try {
		return { text: await readFile(file, "utf8"), exists: true };
	} catch (error) {
		if (error !== null && typeof error === "object" && error.code === "ENOENT") return { text: "", exists: false };
		return { error: describeError(error) };
	}
}

/** Every non-empty line of a blackboard file, in order. */
function blackboardLines(text) {
	return text.split(/\r?\n/u).filter((line) => line.trim() !== "");
}

/** Highest `seq` already present in decisions.md — the ledger's counter (§3.3.3
 * "seq 单调递增", assigned by the plugin). Unparsable lines are ignored rather
 * than allowed to reset the counter. */
function lastDecisionSeq(text) {
	let max = 0;
	for (const line of blackboardLines(text)) {
		const matched = /^(\d+)\s*\|/u.exec(line);
		if (matched === null) continue;
		const seq = Number(matched[1]);
		if (Number.isFinite(seq) && seq > max) max = seq;
	}
	return max;
}

/** §4.1 line bound, counted in code points (so an astral character costs one). */
function readBlackboardLine(value, name) {
	if (typeof value !== "string") return { error: `${name} 必须是字符串。` };
	if (value.trim() === "") return { error: `${name} 不能为空。` };
	const length = [...value].length;
	if (length > BLACKBOARD_LINE_LIMIT) {
		return { error: `${name} 超过单行上限 ${BLACKBOARD_LINE_LIMIT} 字符（当前 ${length} 字符；§4.1 防黑板刷屏）。` };
	}
	return { value };
}

/** Author field of one ledger row: the caller's session id, kept to a single
 * injection-free line (a row is parsed by splitting on `|`). A caller without a
 * session identity is recorded honestly as `unknown` rather than invented. */
function blackboardAuthor(exec) {
	const caller = agentSessionId(exec);
	if (caller === undefined) return "unknown";
	return caller.replace(/[\r\n|]/gu, "_");
}

/** One ledger row: `seq | ISO 时间 | author-session-id | 正文` (§3.3.3). */
function decisionRow(seq, iso, author, text) {
	return `${seq} | ${iso} | ${author} | ${text}`;
}

/**
 * Register the M2 tools (§3.3.2/§3.3.3): the roster registry and the team
 * blackboard reader/writer.
 */
function registerTeamTools(ctx, policy, rotation) {
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_roster",
		description: "团队角色注册表（roster，M2）：团队 -> 角色 -> 会话，含版本史。action：get（任何会话可读：全体团队概要 + 指定 team 详情含 history）/ upsert-team（创建或幂等更新；团队名 [a-z0-9-]+；**创建时把调用会话播种为 coordinator 现任**（创建即认领：否则 policy.writer=coordinator 下的空缺团队谁都写不进）；已存在时只有 policy 属于可更新面，roles/history 原样保留，本工具无 policy 参数，故 policy 由用户经设置 UI 修改）/ set-role（换现任：current 替换 + history 追加，旧任记录 until=now；不迁移 pairs——那是 M4 rotation 的专属动作）/ retire（退役：仅现任协调者会话发起，current 置空 + history 记退役；随后可选一个用户确认对话框清理指向退役会话的 pairs/trustedSenders/rememberTargets）。写权限：policy.writer=coordinator 时只有该团队 coordinator 角色的现任会话可写，现任空缺时会话路径一律拒绝（用户经设置 UI 永远是超级写者）；writer=any 时任何会话可写。",
		parameters: {
			action: { type: "string", required: true, enum: ["get", "upsert-team", "set-role", "retire"], description: "get / upsert-team / set-role / retire" },
			team: { type: "string", description: "团队名（[a-z0-9-]+）" },
			role: { type: "string", description: "set-role / retire：角色名（约定角色名 coordinator，允许自定义如 reviewer）" },
			session: { type: "string", description: "set-role：新现任会话 id" },
			note: { type: "string", description: "set-role / retire：写入版本史的备注" },
		},
		output: textOutput(),
		timeoutMs: 60000,
		async execute(args, exec) {
			try {
				const action = typeof args.action === "string" ? args.action : "";
				// §3.6.2 评审 #4 (「定时 + roster 触碰时懒检查」): every roster touch is a
				// moment a stranded rotation token or an unratified provisional window
				// would be noticed, so the sweep runs here too — awaited, so it can
				// never race this call's own settings write.
				const swept = await rotation.sweep({ now: Date.now(), signal: exec.signal });
				const teams = policy.get().teams;
				const caller = agentSessionId(exec);
				const now = Date.now();

				if (action === "get") {
					const wanted = args.team === undefined || args.team === null || args.team === "" ? null : readTeamName(args.team);
					if (wanted !== null && wanted.error !== undefined) return wellFormed(`读取失败：${wanted.error}`);
					const lines = [`团队注册表（共 ${teams.length} 个团队）：`];
					if (teams.length === 0) lines.push("（无团队：用 action=upsert-team 创建，团队名 [a-z0-9-]+）");
					for (const team of teams) {
						lines.push(`- ${team.name} — 创建于 ${readStamp(team.createdAt)} · policy.writer=${team.policy.writer} · 角色 ${team.roles.length} 个 · workspace=${team.workspace === "" ? "（未捕获）" : team.workspace}`);
						for (const entry of team.roles) {
							lines.push(`    角色 ${entry.role}：${entry.current === null ? "空缺（vacant）" : `现任 ${entry.current}（自 ${readStamp(tenureStartOf(entry, team))}）`}${recoveryLadderSuffix(entry, (id) => agentIsLive(ctx, id))}`);
						}
					}
					if (wanted !== null) {
						const team = teams.find((candidate) => candidate.name === wanted.value);
						if (team === undefined) {
							lines.push("", `读取失败：团队 ${wanted.value} 不在注册表中。`);
							return wellFormed(lines.join("\n"));
						}
						lines.push("", `团队 ${team.name} 详情：`);
						lines.push(`- workspace：${team.workspace === "" ? "（未捕获）" : team.workspace}`);
						lines.push(`- policy.writer：${team.policy.writer}（coordinator=仅现任协调者会话可写；any=任何会话可写）`);
						lines.push(`- 黑板目录：${team.workspace === "" ? "（未捕获 workspace，黑板不可用）" : blackboardPaths(team).dir}`);
						lines.push(`- 换届撤销快照（rotationBackup）：${team.rotationBackup === null ? "（无）" : `${readStamp(team.rotationBackup.at)} 时的 pairs ${team.rotationBackup.pairs.length} 条 / trustedSenders ${team.rotationBackup.trustedSenders.length} 项 / rememberTargets ${team.rotationBackup.rememberTargets.length} 项`}`);
						for (const entry of team.roles) {
							lines.push(`- 角色 ${entry.role}：${entry.current === null ? "空缺（vacant）" : `现任 ${entry.current}（自 ${readStamp(tenureStartOf(entry, team))}）`}${recoveryLadderSuffix(entry, (id) => agentIsLive(ctx, id))}`);
							lines.push(`    pending：${entry.pending === null ? "（无）" : `${entry.pending.session}（token ${maskToken(entry.pending.token)}（掩码——完整令牌只在 prepare 的一次性返回里给出），创建 ${readStamp(entry.pending.createdAt)}，到期 ${readStamp(entry.pending.expiresAt)}，绑定 team=${entry.pending.team} role=${entry.pending.role}，已迁移 ${entry.pending.migratedPairs === undefined ? 0 : entry.pending.migratedPairs.length} 条）`}`);
							lines.push(`    provisional：${entry.provisional === null ? "（无）" : `${entry.provisional.session === "" ? "" : `${entry.provisional.session} 的 `}信任迁移待批准（自 ${readStamp(entry.provisional.at)}，${readStamp(entry.provisional.expiresAt)} 到期未批准则自动回退为过门投递）`}`);
							lines.push(`    版本史（共 ${entry.history.length} 条，退役≠删除）：`);
							if (entry.history.length === 0) lines.push("      - （无）");
							for (const record of entry.history) {
								const until = record.until === null ? "现任" : readStamp(record.until);
								const note = record.note === undefined ? "" : `　备注：${preview(record.note, 200)}`;
								lines.push(`      - ${record.session}　${readStamp(record.from)} → ${until}${note}`);
							}
							const recoveries = entry.recoveries ?? [];
							if (recoveries.length > 0) {
								lines.push(`    恢复记录（共 ${recoveries.length} 条，team_link_recover 的审计；与 roster.md 镜像同源）：`);
								for (const record of recoveries) {
									const note = record.note === undefined ? "" : `　备注：${preview(record.note, 200)}`;
									lines.push(`      - ${record.verb}　${record.from ?? "（无现任）"} → ${record.to ?? "（无）"}　${readStamp(record.at)}　发起会话 ${record.by === "" ? "unknown" : record.by}${note}`);
								}
							}
						}
					}
					lines.push("", `（读数 ${readStamp(now)}，${READ_STALE_NOTE}）`);
					if (swept.lines.length > 0) lines.push("", "换届过期清扫（本次 roster 读取触发）：", ...swept.lines);
					return wellFormed(lines.join("\n"));
				}

				if (action === "upsert-team") {
					const name = readTeamName(args.team);
					if (name.error !== undefined) return wellFormed(`创建/更新失败：${name.error}`);
					const existing = teams.find((team) => team.name === name.value) ?? null;
					if (existing !== null) {
						const gate = withLiveGateDiagnostic(ctx, roleOf(existing, COORDINATOR_ROLE), writerGate(existing, caller));
						if (gate.error !== undefined) return wellFormed(gate.error);
					}
					if (caller === undefined) {
						return wellFormed("创建/更新失败：需要可交互的活动代理——workspace 在团队创建时从执行会话的 agentCwd 捕获（exec.agent.id 缺失时无法定位黑板根目录）。");
					}
					// §3.3.2 创建即认领: the creation path seeds `caller` as the
					// coordinator incumbent, so the team is writable the moment it
					// exists. An existing team ignores `coordinator` entirely.
					const applied = applyTeamUpsert(teams, { name: name.value, workspace: agentCwd(exec), now, coordinator: caller });
					try {
						await policy.update({ teams: applied.teams });
					} catch (error) {
						return wellFormed(`创建/更新失败：写入设置失败（${describeError(error)}）。`);
					}
					const mirror = await writeRosterMirror(applied.team);
					const lines = [
						applied.created
							? `已创建团队 ${applied.team.name}：policy.writer=coordinator，coordinator 已由创建会话 ${caller} 认领（创建即认领，§3.3.2 bootstrap），workspace=${applied.team.workspace}（自执行会话 agentCwd 捕获）。`
							: `团队 ${applied.team.name} 已存在：upsert-team 幂等——roles / 版本史 / createdAt / policy 均未改动${applied.capturedWorkspace ? `（仅补记首次捕获的 workspace=${applied.team.workspace}）` : ""}。`,
						`现状：policy.writer=${applied.team.policy.writer} · 角色 ${applied.team.roles.length} 个 · 创建于 ${readStamp(applied.team.createdAt)}。`,
						mirrorNote(mirror),
					];
					if (applied.created) lines.push("下一步：直接开始协作（team_link_team_append 写黑板 / team_link_send 派活），用 action=set-role 增补其它角色；换届走 team_link_rotate。注意 policy.writer=coordinator 下只有现任协调者会话可写——创建者现在就是现任，若要交给别的会话，请在交班时用 action=set-role 显式指定。");
					return wellFormed(lines.join("\n"));
				}

				if (action === "set-role") {
					const name = readTeamName(args.team);
					if (name.error !== undefined) return wellFormed(`写入失败：${name.error}`);
					const team = teams.find((candidate) => candidate.name === name.value) ?? null;
					if (team === null) return wellFormed(`写入失败：团队 ${name.value} 不在注册表中（先用 action=upsert-team 创建）。`);
					const gate = withLiveGateDiagnostic(ctx, roleOf(team, COORDINATOR_ROLE), writerGate(team, caller));
					if (gate.error !== undefined) return wellFormed(gate.error);
					const role = readRoleName(args.role);
					if (role.error !== undefined) return wellFormed(`写入失败：${role.error}`);
					const session = readSessionId(args.session);
					if (session.error !== undefined) return wellFormed(`写入失败：${session.error}`);
					const note = readNote(args.note);
					const applied = applySetRole(team, { role: role.value, session: session.value, note, now });
					try {
						await policy.update({ teams: teams.map((entry) => (entry.name === team.name ? applied.team : entry)) });
					} catch (error) {
						return wellFormed(`写入失败：写入设置失败（${describeError(error)}）。`);
					}
					const mirror = await writeRosterMirror(applied.team);
					const entry = roleOf(applied.team, role.value);
					return wellFormed([
						`已设置：团队 ${team.name} 的角色 ${role.value} —— ${applied.previous === null ? "原为空缺，现指定" : `原任 ${applied.previous} 被替换为`} ${session.value}（自 ${readStamp(now)}）。`,
						`版本史 ${entry === null ? 0 : entry.history.length} 条${applied.previous === null ? "" : `（旧任 ${applied.previous} 记录 until=${readStamp(now)}）`}${note === undefined ? "" : `；备注：${preview(note, 200)}`}。`,
						"未迁移 pairs：换届的信任迁移是 rotation（M4）的专属动作，set-role 只换身份（§3.3.2）。",
						// §3.6.2 评审 #9: seating the rotation's own successor kills that
						// token, and the successor has to hear it here — otherwise its later
						// claim just says「没有 pending」with no visible reason.
						...(applied.clearedPending
							? [`已作废在飞令牌：本次指定的会话正是换届 pending 的继任者（${session.value}）——身份已由本次显式变更，令牌失效、冻结随之解除；该换届不再可能用原令牌 claim（claim 会报「没有 pending」）。要重建信任迁移请由现任重新 prepare。`]
							: []),
						mirrorNote(mirror),
					].join("\n"));
				}

				if (action === "retire") {
					const name = readTeamName(args.team);
					if (name.error !== undefined) return wellFormed(`退役失败：${name.error}`);
					const team = teams.find((candidate) => candidate.name === name.value) ?? null;
					if (team === null) return wellFormed(`退役失败：团队 ${name.value} 不在注册表中。`);
					const gate = withLiveGateDiagnostic(ctx, roleOf(team, COORDINATOR_ROLE), retireGate(team, caller));
					if (gate.error !== undefined) return wellFormed(gate.error);
					const role = readRoleName(args.role);
					if (role.error !== undefined) return wellFormed(`退役失败：${role.error}`);
					const note = readNote(args.note);
					const applied = applyRetire(team, { role: role.value, note, now });
					if (applied.error !== undefined) return wellFormed(`退役失败：${applied.error}`);
					try {
						await policy.update({ teams: teams.map((entry) => (entry.name === team.name ? applied.team : entry)) });
					} catch (error) {
						return wellFormed(`退役失败：写入设置失败（${describeError(error)}）。`);
					}
					const mirror = await writeRosterMirror(applied.team);
					const lines = [
						`已退役：团队 ${team.name} 的角色 ${role.value} —— 现任 ${applied.retired} 置空（vacant），版本史记录 until=${readStamp(now)}${note === undefined ? "" : `，备注：${preview(note, 200)}`}。`,
						mirrorNote(mirror),
					];
					// §3.3.2 optional cleanup: one dialog listing every trust reference that
					// still points at the retired session, in both directions. Retire itself
					// already happened — the cleanup can only fail soft.
					const view = policy.get();
					const references = trustReferencesTo(view, applied.retired);
					const userQuestions = ctx.get?.("userQuestions");
					if (references.total === 0) {
						lines.push("信任清理：没有指向该会话的 pairs / trustedSenders / rememberTargets，无需清理。");
					} else if (userQuestions === undefined || typeof userQuestions.ask !== "function") {
						lines.push(`信任清理已跳过：确认服务（userQuestions）不可用。退役本身已完成；${references.pairs.length} 个 pairs、${references.trustedSenders.length} 个 trustedSenders、${references.rememberTargets.length} 个 rememberTargets 仍指向该会话（不是安全洞——pairs 照旧过门——只是死数据），可由用户在设置 team-link 中删除。`);
					} else {
						let choice;
						try {
							const answer = await userQuestions.ask({
								questions: [{
									id: "retire-cleanup",
									header: "退役信任清理",
									question: wellFormed([
										`会话 ${applied.retired} 已从团队 ${team.name} 的角色 ${role.value} 退役。`,
										"",
										"以下信任引用仍指向该会话（含跨端两个方向）：",
										`- pairs（${references.pairs.length} 个，双向配对）：${references.pairs.length === 0 ? "（无）" : references.pairs.map((pair) => `${pair.a} ↔ ${pair.b}`).join("，")}`,
										`- trustedSenders（${references.trustedSenders.length} 个，该会话在「免确认接收的发送方」列表中）：${references.trustedSenders.length === 0 ? "（无）" : references.trustedSenders.join("，")}`,
										`- rememberTargets（${references.rememberTargets.length} 个，该会话在「免确认发送目标」列表中）：${references.rememberTargets.length === 0 ? "（无）" : references.rememberTargets.join("，")}`,
										"",
										"确认后清理这些引用；保留则它们原样留在设置里（配对通道照旧过门，不是安全洞，只是死数据堆积）。",
									].join("\n")),
									options: [
										{ label: "清理", description: "删除上面列出的、指向退役会话的 pairs / trustedSenders / rememberTargets（对话框打开期间新增的信任引用不受影响）" },
										{ label: "保留", description: "不改动信任数据（死数据保留，可随时在设置里删除）" },
									],
								}],
								agent: exec.agent,
								signal: exec.signal,
							});
							choice = answer?.answers?.[0]?.selected?.[0];
						} catch (error) {
							lines.push(`信任清理未完成：确认对话框失败（${describeError(error)}）；引用保持原样，退役本身已完成。`);
						}
						if (choice === "清理") {
							try {
								// R1 (M2 review): the dialog spans an unbounded human wait, so the
								// reference list collected BEFORE it is a display artifact, not the
								// write basis — writing `view` back would silently drop every pair and
								// trust entry created while the dialog was open. Re-read the store and
								// remove only the references the dialog listed AND that are still
								// present, which shrinks the read-modify-write window from the length
								// of the dialog to this synchronous block.
								const latest = policy.get();
								const listedPairs = new Set(references.pairs.map((pair) => `${pair.a}\n${pair.b}\n${pair.createdAt}`));
								const pairs = latest.pairs.filter((pair) => !listedPairs.has(`${pair.a}\n${pair.b}\n${pair.createdAt}`));
								const trustedSenders = latest.trustedSenders.filter((id) => !references.trustedSenders.includes(id));
								const rememberTargets = latest.rememberTargets.filter((id) => !references.rememberTargets.includes(id));
								await policy.update({ pairs, trustedSenders, rememberTargets });
								lines.push(`已清理：${latest.pairs.length - pairs.length} 个 pairs / ${latest.trustedSenders.length - trustedSenders.length} 个 trustedSenders / ${latest.rememberTargets.length - rememberTargets.length} 个 rememberTargets（按最新设置视图过滤：对话框里列出、期间已被其它变更删掉的引用不再计入；对话框期间新增的信任引用不受影响）。`);
							} catch (error) {
								lines.push(`信任清理失败：写入设置失败（${describeError(error)}）；退役本身已完成。`);
							}
						} else if (choice === "保留") {
							lines.push("已保留全部信任引用（未做任何清理）。");
						} else if (choice !== undefined) {
							lines.push(`信任清理未执行：对话框返回「${choice}」，不是明确同意。`);
						}
					}
					return wellFormed(lines.join("\n"));
				}

				return "操作失败：action 必须是 get / upsert-team / set-role / retire。";
			} catch (error) {
				return wellFormed(`roster 操作失败：${describeError(error)}`);
			}
		},
	})), "team-link: roster tool");

	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_team_read",
		description: "读团队黑板（M2，§3.3.3）：读取前先跑一次换届过期清扫（过期的 pending / provisional 窗口不因没人注册看门狗而漏），再返回 roster 概要 + decisions.md 末 20 条 + discipline.md 全文 + 各文件 baseHash（decisions 的**仅供参考/审计**——decisions 只追加、不接受 baseHash 参数；discipline 的供整文件替换的乐观锁使用）。任何会话可读；写黑板没有权限门，但读要一次读齐省轮次。文件不存在按空处理并如实标注。黑板根目录 = <team.workspace>/team/<name>/（workspace 在团队首次创建时从会话 agentCwd 捕获）。",
		parameters: {
			team: { type: "string", required: true, description: "团队名（须已在 roster 中注册）" },
		},
		output: textOutput(),
		timeoutMs: 30000,
		async execute(args, exec) {
			try {
				// §3.6.2 评审 #4/#7: the lazy half of the expiry sweep — a team frozen
				// by a stranded token (or holding an unratified provisional window) also
				// gets its notice when somebody reads the board, not only on a roster
				// touch or a watchdog patrol. The pass is awaited so the lines below
				// describe the post-sweep roster.
				await rotation.sweep({ now: Date.now(), signal: exec?.signal });
				const name = readTeamName(args.team);
				if (name.error !== undefined) return wellFormed(`读取失败：${name.error}`);
				const team = policy.get().teams.find((candidate) => candidate.name === name.value) ?? null;
				if (team === null) return wellFormed(`读取失败：团队 ${name.value} 不在注册表中（先用 team_link_roster action=upsert-team 创建）。`);
				if (team.workspace === "") return wellFormed(`读取失败：团队 ${name.value} 没有 workspace 记录，黑板根目录未知（workspace 在团队首次创建时从会话 agentCwd 捕获；可由用户经设置 UI 补写路径）。`);
				const paths = blackboardPaths(team);
				const decisions = await readBlackboardFile(paths.decisions);
				if (decisions.error !== undefined) return wellFormed(`读取失败：decisions.md 无法读取（${decisions.error}）。`);
				const discipline = await readBlackboardFile(paths.discipline);
				if (discipline.error !== undefined) return wellFormed(`读取失败：discipline.md 无法读取（${discipline.error}）。`);
				const rows = blackboardLines(decisions.text);
				const shown = rows.slice(-DECISIONS_WINDOW);
				const decisionsHash = blackboardHash(decisions.text);
				const disciplineHash = blackboardHash(discipline.text);
				const lines = [
					`团队 ${team.name} 黑板（根：${paths.dir}）`,
					"",
					"--- roster（概要；事实源 = 设置 team-link 的 teams 键）---",
					`- policy.writer=${team.policy.writer} · 角色 ${team.roles.length} 个`,
				];
				for (const entry of team.roles) lines.push(`- 角色 ${entry.role}：${entry.current === null ? "空缺（vacant）" : `现任 ${entry.current}`}`);
				lines.push("", `--- decisions.md（只追加；此处显示末 ${DECISIONS_WINDOW} 条）---`);
				lines.push(decisions.exists
					? `共 ${rows.length} 条，显示 ${shown.length} 条 · baseHash=${decisionsHash}（仅供参考/审计：decisions 只追加、不接受 baseHash 参数）`
					: `（文件不存在，按空处理：0 条）baseHash=${decisionsHash}（空内容哈希；仅供参考/审计）`);
				for (const row of shown) lines.push(row);
				lines.push("", "--- discipline.md（整文件替换，带 baseHash 乐观锁）---");
				lines.push(discipline.exists ? `baseHash=${disciplineHash}（乐观锁：整文件替换必须携带此值）` : `（文件不存在，按空处理）baseHash=${disciplineHash}（空内容哈希；乐观锁：整文件替换必须携带此值）`);
				lines.push(discipline.text === "" ? "（空）" : discipline.text);
				lines.push("", `单行上限 ${BLACKBOARD_LINE_LIMIT} 字符（§4.1）。写黑板用 team_link_team_append：file=decisions 只追加（无需 baseHash，seq 由插件分配——上面的 decisions baseHash 仅供参考/审计）；file=discipline 整文件替换（必须携带上面的 discipline baseHash，那是唯一的乐观锁）。`);
				lines.push("", `（读数 ${readStamp(Date.now())}，${READ_STALE_NOTE}）`);
				return wellFormed(lines.join("\n"));
			} catch (error) {
				return wellFormed(`读取失败：${describeError(error)}`);
			}
		},
	})), "team-link: team read tool");

	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_team_append",
		description: "写团队黑板（M2，§3.3.3）：file=decisions 只追加一条裁决（格式 'seq | ISO时间 | author-session-id | 正文'，seq 由插件分配、单调递增，无需 baseHash）；file=discipline 整文件替换纪律条款（必须携带 team_link_team_read 返回的当前 baseHash，不匹配则拒绝并要求重读——乐观锁，防两个 worker 并发改稿互相覆盖）。两者都受单行 500 字符上限（§4.1）。任何会话都可写：黑板没有写权限门，写入者身份记录在行内 author 字段（透明可审计）。",
		parameters: {
			team: { type: "string", required: true, description: "团队名（须已在 roster 中注册）" },
			file: { type: "string", required: true, enum: ["decisions", "discipline"], description: "decisions（只追加）/ discipline（整文件替换）" },
			line: { type: "string", description: "decisions：单行正文；discipline：新的整份内容" },
			baseHash: { type: "string", description: "discipline 必填：team_link_team_read 返回的当前 baseHash" },
		},
		output: textOutput(),
		timeoutMs: 30000,
		async execute(args, exec) {
			try {
				const name = readTeamName(args.team);
				if (name.error !== undefined) return wellFormed(`写入失败：${name.error}`);
				const team = policy.get().teams.find((candidate) => candidate.name === name.value) ?? null;
				if (team === null) return wellFormed(`写入失败：团队 ${name.value} 不在注册表中（先用 team_link_roster action=upsert-team 创建）。`);
				if (team.workspace === "") return wellFormed(`写入失败：团队 ${name.value} 没有 workspace 记录，黑板根目录未知。`);
				const file = typeof args.file === "string" ? args.file : "";
				if (!BLACKBOARD_FILES.has(file)) return wellFormed("写入失败：file 必须是 decisions 或 discipline（白名单，不接受任何路径）。");
				const paths = blackboardPaths(team);
				const author = blackboardAuthor(exec);

				if (file === "decisions") {
					const text = readBlackboardLine(args.line, "line");
					if (text.error !== undefined) return wellFormed(`写入失败：${text.error}`);
					if (/[\r\n]/u.test(text.value)) return wellFormed("写入失败：decisions 的正文必须单行——每行是一条账本记录，换行会破坏 seq | 时间 | author | 正文 的解析。");
					const existing = await readBlackboardFile(paths.decisions);
					if (existing.error !== undefined) return wellFormed(`写入失败：decisions.md 无法读取（${existing.error}）。`);
					const seq = lastDecisionSeq(existing.text) + 1;
					const row = decisionRow(seq, new Date().toISOString(), author, text.value);
					// Append, do not rewrite: the ledger is append-only, so a concurrent append
					// from another session can at worst duplicate a seq number, never lose a row
					// (§3.3.3 puts the optimistic lock on discipline only). The leading newline
					// repairs a file whose last append was interrupted before its terminator.
					const prefix = existing.text === "" || existing.text.endsWith("\n") ? "" : "\n";
					try {
						await mkdir(paths.dir, { recursive: true });
						await appendFile(paths.decisions, `${prefix}${row}\n`, "utf8");
					} catch (error) {
						return wellFormed(`写入失败：decisions.md 写入出错（${describeError(error)}）。`);
					}
					return wellFormed([
						`已追加 decisions #${seq}（author=${author}）→ ${paths.decisions}`,
						"行格式：seq | ISO 时间 | author-session-id | 正文（seq 由插件分配、单调递增；只追加不删除）。",
						`单行上限 ${BLACKBOARD_LINE_LIMIT} 字符（本次 ${[...text.value].length} 字符，§4.1）。`,
					].join("\n"));
				}

				if (typeof args.line !== "string") return wellFormed("写入失败：discipline 需要 line（新的整份内容）。");
				const contentLines = args.line.split(/\r?\n/u);
				const tooLong = contentLines.findIndex((row) => [...row].length > BLACKBOARD_LINE_LIMIT);
				if (tooLong !== -1) return wellFormed(`写入失败：discipline 第 ${tooLong + 1} 行超过单行上限 ${BLACKBOARD_LINE_LIMIT} 字符（当前 ${[...contentLines[tooLong]].length} 字符；§4.1）。`);
				const baseHash = typeof args.baseHash === "string" ? args.baseHash.trim() : "";
				if (baseHash === "") return wellFormed("写入失败：discipline 是整文件替换，必须携带 team_link_team_read 返回的当前 baseHash（乐观锁，防双写覆盖）。");
				const existing = await readBlackboardFile(paths.discipline);
				if (existing.error !== undefined) return wellFormed(`写入失败：discipline.md 无法读取（${existing.error}）。`);
				const currentHash = blackboardHash(existing.text);
				if (baseHash !== currentHash) {
					return wellFormed(`写入失败：discipline baseHash 不匹配——文件已被其他会话改写（当前 baseHash=${currentHash}，你携带的是 ${baseHash}）。请重新 team_link_team_read 取回最新内容与 baseHash 后再写（乐观锁）。`);
				}
				try {
					await mkdir(paths.dir, { recursive: true });
					await writeFile(paths.discipline, args.line, "utf8");
				} catch (error) {
					return wellFormed(`写入失败：discipline.md 写入出错（${describeError(error)}）。`);
				}
				return wellFormed([
					`已替换 discipline.md（author=${author}）→ ${paths.discipline}`,
					`baseHash ${currentHash} → ${blackboardHash(args.line)}（下次替换必须携带新值）。`,
					`共 ${contentLines.length} 行；单行上限 ${BLACKBOARD_LINE_LIMIT} 字符（§4.1）。`,
				].join("\n"));
			} catch (error) {
				return wellFormed(`写入失败：${describeError(error)}`);
			}
		},
	})), "team-link: team append tool");
}

/**
 * Register the M4 tool: the two phases of a rotation (§3.6.2). Kept in its own
 * registration (rather than folded into the M2 roster tool) because the two
 * phases have different actors, different preconditions and a token.
 */
// ---------------------------------------------------------------------------
// §11.2/§11.4 successor:"auto" — the plugin builds the successor and hands over
// ---------------------------------------------------------------------------
//
// 机制与判断分离 (§3.6.2, unchanged): the plugin owns every mechanical step —
// create the root session, write the hand-over document, mint the token, freeze,
// deliver — and the MODEL owns the judgement, which is the hand-over body. What
// this path adds over the manual one is exactly one thing: the successor session
// no longer has to exist before the hand-over starts (§11.0).

// --- the five-hard-section list and its renderings (§11.9.6) ----------------
// HOISTED to here on purpose: the lists below are read by the §11.2 delivery body
// and by the `team_link_rotate` description, both of which live in THIS section,
// while the validator that consumes them sits far below with the document
// contract. One `const` array can only be initialized once, so the source of
// truth has to sit above every reader.
//
/** The FIVE body sections a `successor:"auto"` prepare refuses to run without
 * (§11.9.6). This ONE array is the source of the validator, of the scaffold the
 * refusal prints, of {@link HANDOFF_SECTION_HINTS}, of the header's integrity
 * line, and of every prose rendering of the list — {@link handoffSectionsInline},
 * {@link handoffSectionsAsHeadings}, {@link handoffDeliveryMessage} and the
 * `team_link_rotate` description all render FROM it. A section therefore cannot
 * be enforced in one place and advertised in another (the ② round's "same-fact
 * list, half of it updated" lesson; ③a 差异审计修复轮 🟡-3). */
const HANDOFF_HARD_SECTIONS = ["mission", "in-flight", "commitments", "unknowns", "task-and-goal"];
/** The soft sections: their absence is a WARNING, never a refusal (§11.9.6). */
const HANDOFF_SOFT_SECTIONS = ["first-actions", "team-map", "conventions"];
/** One scaffold line per hard section, in §11.9.6's own terms — the refusal hands
 * the model something it can fill in instead of only a complaint. Keyed by the
 * SAME names as {@link HANDOFF_HARD_SECTIONS} (locked by a host-half assertion,
 * because this is a list that must be edited together with that one). */
const HANDOFF_SECTION_HINTS = {
	mission: "角色对团队负责什么（这个角色存在的理由，不是任务清单）",
	"in-flight": "在飞工作：事项 / 相关成员 / 当前状态 / 下一步",
	commitments: "未兑现的承诺（答应过谁、什么、什么时候）",
	unknowns: "负面空间声明——把沉默变成信息：不知道什么、谁在等什么、哪里还没验证",
	"task-and-goal": "当前目标与 goal 相位（armed-active / paused / blocked / 无 goal）；继任者的第一个动作建议是 /goal resume 或新建 goal，本节必须说清有没有 goal 可续",
};
/** §11.9.6's hard sections as one inline list, in the §11.9.6 order — the ONE
 * rendering every prose face uses (the tool description, the `handoff` parameter,
 * the delivery body, the scaffold's refusal line and {@link handoffScaffold}).
 * There is no second spelling of this list anywhere: that is what makes "rename a
 * section and the prose follows" true instead of merely intended. */
function handoffSectionsInline() {
	return HANDOFF_HARD_SECTIONS.join(" / ");
}

/** The sentinel `successor` value meaning "build one for me" (§11.2). Compared
 * verbatim after trimming, so an id can never collide with it (ids are validated
 * by {@link readSessionId}, which rejects this token's shape anyway). */
const ROTATION_AUTO = "auto";
/** Question id of the §11.4.1 confirmation — matched by id, not by order. */
const ROTATION_AUTO_DIALOG_ID = "rotation-auto";
/** The ONE answer that lets the auto path run; everything else (the cancel
 * option, an unanswered dialog, a timeout, a missing confirmation service) is
 * fail-closed (§11.4.1). */
const ROTATION_AUTO_CONFIRM_LABEL = "创建并交班";
const ROTATION_AUTO_CANCEL_LABEL = "取消";

/** §11.4.1's confirmation text: creation + hand-over is a big blast radius, so
 * the box names the count, the cwd, the model situation, the conservative cost,
 * the trust being touched and what cancelling does.
 *
 * DEFECT-4 补一线：新会话的默认标题也在框里写明（`state.title` 与创建路径交给
 * `sessionTitle.rename` 的是**同一个值**）。理由是它与「成本口径 / 信任面」同一层级——
 * 用户要在**动作发生之前**知道他将得到什么，而不是事后去侧边栏里发现一批同名会话。 */
function rotationAutoDialogText(state) {
	return [
		`即将自动换届：为团队 ${state.teamName} 的角色 ${state.roleName} 新建 1 个根会话并立即交班。`,
		`- 新会话 id：${state.sessionId}（插件自建、插件持有它的 AgentHandle；meta 只放 cwd/agentPreset，不含任何血统字段，§11.4.2 / §10.2.5）`,
		`- cwd：${state.cwd}`,
		state.title === undefined
			? "- 会话标题（DEFECT-4）：无法从 team/role 派生 ⇒ 本次不设标题（它会显示为宿主的默认标题，很可能是工作区名）——可在壳里手动重命名。"
			: `- 会话标题（DEFECT-4）：「${state.title}」——按「<team> · <role>」派生（团队名过长时截**团队段**、**role 段完整**；缺口2：宿主的标题上限按字节剪尾巴，剪掉的若是 role，同队两个角色就会撞成同一个名字；不设标题会让它显示为工作区名，在侧边栏里认不出来）；想改随时在壳里重命名。`,
		`- 模型 / 预设：§11.2 的两个入口都没有 model/provider 参数 ⇒ 两半都由插件解析并带上宿主缺省模型选择（agentDefaultModel.currentSelection()，§10.2.2 模板第 ④ 步；缺了它继任者首回合报 prompt variable "{{model}}" has no value，真机缺陷 #3），preset 取宿主缺省——缺省也解析并挂载（§10.2.2 模板；缺了它继任者首回合起不来，真机缺陷 #1）`,
		`- 保守成本口径：一个新根会话的完整生命周期成本（它自己的上下文与每个回合同样计价）+ 它上任后的第一个 /goal 回合；插件不为它设上限。`,
		`- 交班内容：交接文档（头部 + 事实段 + 交接正文，落盘 <workspace>/team/${state.teamName}/handoff-${state.roleName}-<时间戳>.md）、一次性令牌（30 分钟有效，投给新会话，此后一律掩码）、「立即 claim」指令。`,
		`- 信任面：令牌与冻结按 M4 原样走（§3.6.2）——信任迁移仍要继任者在 claim 时经确认框逐项勾选（无人值守则 provisional + 24h 回退），本次确认不迁移任何 pairs、不改任何信任数据。`,
		`- 选「${ROTATION_AUTO_CANCEL_LABEL}」= 什么都不做：零创建、零令牌、零 freeze。`,
	].join("\n");
}

/** The §11.4.1 confirmation itself. Fail-closed on every path that is not the
 * explicit 「创建并交班」 answer — that is what makes 取消 ⇒ 零副作用 a structural
 * property rather than something the caller remembers. */
async function askRotationAuto(ctx, agent, state, text, signal) {
	const userQuestions = ctx.get?.("userQuestions");
	if (userQuestions === undefined || userQuestions === null || typeof userQuestions.ask !== "function") {
		return { confirmed: false, reason: "确认服务（userQuestions）不可用——自动换届要新建会话并交班，无确认即不执行（fail-closed，§11.4.1）" };
	}
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, ROTATION_CONFIRM_TIMEOUT_MS);
	timer.unref?.();
	const forward = () => controller.abort();
	signal?.addEventListener?.("abort", forward);
	try {
		const answer = await userQuestions.ask({
			questions: [{
				id: ROTATION_AUTO_DIALOG_ID,
				header: "自动换届确认",
				question: wellFormed(text),
				detail: `一次确认覆盖：新建会话 ${state.sessionId}、写交接文档、铸令牌与广播 rotation-freeze、把令牌与交接正文 followup 给新会话。`,
				options: [
					{ label: ROTATION_AUTO_CONFIRM_LABEL, description: `新建 1 个根会话并交班给 ${state.sessionId}（令牌 30 分钟有效；信任迁移仍要它在 claim 时逐项确认）` },
					{ label: ROTATION_AUTO_CANCEL_LABEL, description: "什么都不做：零创建、零令牌、零 freeze、零交接文档" },
				],
			}],
			agent,
			signal: controller.signal,
		});
		const item = Array.isArray(answer?.answers) ? answer.answers.find((entry) => entry?.id === ROTATION_AUTO_DIALOG_ID) : undefined;
		if (item === undefined || !Array.isArray(item.selected)) return { confirmed: false, reason: "确认框没有返回本次自动换届问题的答案" };
		if (!item.selected.includes(ROTATION_AUTO_CONFIRM_LABEL)) return { confirmed: false, reason: `用户在确认框里选择了「${item.selected.join("、") || "（未选择）"}」` };
		return { confirmed: true };
	} catch (error) {
		return { confirmed: false, reason: timedOut ? "确认框 3 分钟内未获确认（按取消处理）" : `确认框失败（${describeError(error)}）` };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener?.("abort", forward);
	}
}

/** §11.4.5's delivery body: the token (only here, only once), the claim call,
 * the document path and the whole hand-over body — driven with `followup`, never
 * `inject` (the task has to WAKE the successor). */
function handoffDeliveryMessage(state) {
	return [
		`【${PLUGIN_LABEL} 换届交接】你是团队 ${state.teamName} 的角色 ${state.roleName} 的继任者会话（旧任 ${state.previous}）。`,
		"",
		`① 一次性令牌（30 分钟内有效；明文只在本条出现这一次，此后一律掩码）：${state.token}`,
		`② 立即认领：调用 team_link_rotate action=claim，team=${state.teamName}，role=${state.roleName}，token=<上面那串>。`,
		"   认领时用户会看到一个逐项勾选的多选框（旧任 ↔ 同 team 成员的免确认通道）；无人值守或超时 → 全部以 provisional 迁移，24 小时内未批准自动回退。旧任的 pairs/trustedSenders/rememberTargets 会在 claim 里被对称吊销——这是 M4 的原样机制，自动化不跳过任何一步（§11.6）。",
		`③ 交接文档（审计与人类可读；team_link_team_read 刻意不呈现它，§11.4.3）：${state.documentPath}`,
		"④ 令牌 30 分钟内无人认领 ⇒ 本次换届自动取消、旧任仍为现任、冻结解除；你仍在盘上，可被收编或关闭（§11.5）。",
		"⑤ 上任后的第一个动作建议 /goal resume 或新建 goal（armed-active = 内建心跳，防静默；插件绝不代调 goals.resume，§3.7）。",
		"",
		"—— 以下为旧任提供的交接正文（五个硬节：" + handoffSectionsInline() + "；插件只把关结构——节在场 / 非空 / 有界——不把关内容质量，§11.9.6）——",
		"",
		state.body,
	].join("\n");
}

/**
 * §11.2's automatic entry point, step by step (§11.3 时序), with every side
 * effect behind the two gates the design names: the §11.9.6 ladder (which runs
 * BEFORE anything exists) and the §11.4.1 confirmation (fail-closed).
 *
 * The two failure rules of §11.5 are kept: a create that never settled keeps its
 * `pending-create` intent (so the startup sweep reports it as adoptable), and a
 * partial success is never rolled back — the session is reported, not deleted.
 *
 * @returns `{ lines }` or `{ error }`.
 */
async function autoHandover(deps, request) {
	const { ctx, policy, rotation, controller } = deps;
	const { teamName, roleName, note, handoff, caller, agent, signal, now } = request;
	const cwd = request.cwd;
	// ---- 1) the admission checks prepare would make, BEFORE any side effect ---
	const view = policy.get();
	const admission = prepareAdmission(view, { teamName, roleName, successor: undefined, now, caller, isLive: (id) => agentIsLive(ctx, id) });
	if (admission.error !== undefined) return { error: `${admission.error}（successor:"auto"：闸门在创建之前先查，本次零建会话、零令牌、零 freeze。）` };
	if (typeof controller?.rootCtx?.agents?.create !== "function") {
		return { error: "prepare 失败：本宿主没有可用的 agents.create（编程创建会话不可用）——successor:\"auto\" 无法自建继任者，本次零创建。请退回手工路径：先在壳里新建会话，再把它的 id 作为 successor 传入（§3.6.4 的兜底始终保留）。" };
	}
	if (typeof cwd !== "string" || cwd === "" || !path.isAbsolute(cwd)) {
		return { error: `prepare 失败：无法确定新会话的工作目录（发起会话的 cwd = ${cwd === undefined || cwd === "" ? "（未捕获）" : cwd}）——会话边界会校验绝对路径（§10.2.6），本次零创建、零令牌、零 freeze。` };
	}
	// ---- 2) one confirmation, fail-closed (§11.4.1) --------------------------
	// The new id and the token are plain VALUES at this point — nothing durable,
	// nothing handed out. The confirmation below is what turns them into effects,
	// and the token exists this early only so the hand-over document can carry its
	// mask (§11.9.6 orders the document BEFORE the token is persisted/issued; the
	// manual path does the identical look-ahead in the tool layer).
	const sessionId = teamSessionId(teamName, roleName, () => randomUUID());
	const token = randomUUID();
	// DEFECT-4: the successor's default title is decided HERE, before the create, so
	// the confirmation box can name the title the user is about to get — the same
	// value the one creation path hands to `sessionTitle.rename` (one derivation,
	// two faces: the box and the rename).
	const successorTitle = teamSessionTitle({ team: teamName }, { role: roleName, sessionId });
	const dialog = await askRotationAuto(ctx, agent, { teamName, roleName, sessionId, cwd, title: successorTitle }, rotationAutoDialogText({ teamName, roleName, sessionId, cwd, title: successorTitle }), signal);
	if (!dialog.confirmed) {
		return { lines: [`未自动换届（successor:"auto"）：${dialog.reason}。本次零创建、零令牌、零 freeze、零交接文档——§11.4.1 的确认是必经之门。`] };
	}
	// ---- 3) the durable intent, written BEFORE the create (§11.5 / §10.2.6) ---
	try {
		await addTeamSessionPending(policy, { team: teamName, role: roleName, sessionId, createdAt: now, expiresAt: now + TEAM_SESSION_PENDING_TTL_MS, by: caller ?? "" });
		controller.pending.set(sessionId, { team: teamName, role: roleName, sessionId });
	} catch (error) {
		return { error: `prepare 失败：pending-create 意图写入失败（${describeError(error)}）——未创建（宁可不建，也不留一个没有意图记录的孤儿）。` };
	}
	// ---- 4) create from the PLUGIN ROOT ctx (§11.4.2 / §10.2.5) --------------
	// `team` rides the plan so the ONE creation path can derive the successor's
	// DEFECT-4 title (`<team> · <role>`) exactly as ② does — this literal is the
	// auto path's only plan, so a missing `team` here would silently push the
	// successor onto the id-prefix fallback instead of the shared rule.
	let creation;
	try {
		creation = await createRootAgent(ctx, controller.rootCtx, { preset: undefined, provider: undefined, model: undefined, team: teamName }, { sessionId, role: roleName }, cwd);
	} catch (error) {
		return { error: `prepare 失败：继任者会话创建失败（${describeError(error)}）。未铸令牌、未广播 freeze；pending-create 意图保留，启动清扫会把它报进可收编清单（§11.5）。` };
	}
	const handle = creation.handle;
	controller.handles.set(sessionId, handle);
	// ---- 5) the hand-over document, BEFORE prepare (§11.9.6) ----------------
	// 评审 #4: the facts section is a READING, and the confirmation box above spans
	// an unbounded human wait — counts taken from `view` (read before the box opened)
	// would describe a store that may no longer exist at the instant the document
	// lands. Re-read once here, the same TOCTOU discipline the two recovery verbs
	// apply to the incumbent immediately before they write: the document then states
	// the counts of the store `prepare` is about to snapshot, and what is left
	// between the reading and the write is one synchronous step instead of a human
	// wait. WHICH rotation this document is about does not move: the retiree and the
	// successor stay the ones the header already names (`admission.entry.current` /
	// `sessionId`) — only the numbers are taken at the write instant.
	const factsView = policy.get();
	const factsTeam = factsView.teams.find((entry) => entry.name === teamName) ?? admission.team;
	const held = trustReferencesTo(factsView, admission.entry.current);
	const plan = planRotationMigration(factsView, { members: new Set(teamMembers(factsTeam)), retiree: admission.entry.current, successor: sessionId });
	const document = await writeHandoffDocument(admission.team, {
		roleName,
		previous: admission.entry.current,
		successor: sessionId,
		token,
		preparedAt: now,
		body: handoff.body,
		report: handoff.report,
		facts: rotationFactRows({
			retiree: admission.entry.current,
			successor: sessionId,
			candidates: plan.candidates,
			dropped: plan.dropped,
			removedCount: held.pairs.length,
			trustedSenderCount: held.trustedSenders.length,
			rememberTargetCount: held.rememberTargets.length,
		}),
	});
	if (document.ok !== true) {
		return { error: `prepare 失败（abort-before-prepare，§11.9.6）：交接文档写入失败（${document.error}）——不铸令牌、不广播 freeze。已建的继任者会话 ${sessionId} 保留并如实报为孤儿（§11.5 部分成功不回滚）：它已在盘上、可能已被打开；pending-create 意图保留，启动清扫会把它报进可收编清单。` };
	}
	// ---- 6) prepare: the published M4 mechanism, untouched (§11.4.4) ---------
	const prepared = await rotation.prepare({ teamName, roleName, successor: sessionId, note, caller, now, signal, token });
	if (prepared.error !== undefined) {
		return { error: `${prepared.error}（successor:"auto"：令牌从未落盘、从未投出，freeze 未广播；交接文档 ${document.path} 已写但本次换届不存在。已建的会话 ${sessionId} 保留并报为孤儿——pending-create 意图保留，启动清扫会把它报进可收编清单，§11.5。）` };
	}
	// ---- 7) the intent is resolved: this session IS the rotation's successor ---
	try {
		await removeTeamSessionPending(policy, sessionId);
	} catch (error) {
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: pending-create intent ${sessionId} could not be cleared after prepare (${describeError(error)}) — 启动清扫会把它报进可收编清单（换届本身已生效）`);
	}
	controller.pending.delete(sessionId);
	// ---- 8) drive it: followup, never inject (§11.4.5) ----------------------
	let delivered = true;
	let deliveryError;
	try {
		handle.agent.followup(relayUserMessage(handoffDeliveryMessage({ teamName, roleName, previous: admission.entry.current, token, documentPath: document.path, body: handoff.body }), caller));
	} catch (error) {
		delivered = false;
		deliveryError = describeError(error);
	}
	return {
		lines: [
			`自建继任者（successor:"auto"，§11.4.2）：${sessionId}（根会话——meta 只有 cwd=${cwd}，不含 origin/parentSession/delegationDepth/parentAgent；AgentHandle 由插件持有，§10.2.5 的生命周期代价同样适用：插件卸载/重载 = 它的代理随插件一起拆掉，会话仍在盘上）。`,
			// DEFECT-4：这一行是**读数**——`creation.title` 就是交给标题服务的那个值
			// （未设成时 undefined），不是拿 team/role 重算一遍。用户在侧边栏里看到的
			// 标题就是它，所以回执如实说，而不是让用户自己去发现它们全同名。
			creation.title === undefined
				? `标题（DEFECT-4）：本次**未设成**标题（原因见上文那一行 warn）——它会显示为宿主的默认标题（很可能是工作区名，在侧边栏里认不出来）。想改可在壳里手动重命名。`
				: `标题（DEFECT-4）：已命名为「${creation.title}」（按「<team> · <role>」派生；不设标题会让它显示为工作区名、与其他会话无法区分）。想改随时在壳里重命名。`,
			`交接文档（§11.4.3 / §11.9.6）：${document.path}（头部 + 事实段 + 你提供的正文；上一份：${document.previousDocument ?? "（无——本角色落盘的第一份）"}）`,
			...handoff.warnings.map((line) => `正文校验：${line}`),
			delivered
				? `投递（§11.4.5）：已用 followup 把令牌与交接正文投给 ${sessionId}（不是 inject——任务需要驱动；消息 source 仍恰三成员 {kind, form, senderSessionId}）。`
				: `投递失败（${deliveryError}）：令牌已生效但继任者没收到——可把交接文档 ${document.path} 与令牌重新交给它，或等 30 分钟超时清扫取消本次换届（§11.5）。`,
			...prepared.lines,
			`§11.5 失败与孤儿：30 分钟内无人 claim ⇒ 既有清扫照常广播 rotation-cancelled（旧任仍为 current、冻结解除），并额外点名本次插件新建的会话 ${sessionId}；会话一律保留、不回滚，可收编或关闭。`,
		],
	};
}

/** The M4 rotate tool (§3.6.2), grown by §11.2's auto entry. Kept in its own
 * registrar because the two phases plus the automatic path are one mechanism. */
function registerRotationTools(ctx, policy, rotation, controller) {
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_rotate",
		description: "团队换届（M4，两阶段）。action=prepare（Phase A，只能由该角色的现行会话发起）：生成一次性令牌（绑定 team+role+successor，30 分钟有效）、把待迁移的信任状态快照进 rotationBackup（撤销依据）、向全队广播 rotation-freeze 固定冻结清单，并返回交接指引（令牌只在这里出现一次，此后一律掩码 tok-xxxx…yyyy）。prepare 的 successor 可以写 \"auto\"（§11.2）：插件自建一个根会话当继任者、把 handoff 正文写成 <workspace>/team/<name>/handoff-<role>-<时间戳>.md（头部 + 事实段 + 正文，§11.9.6），再铸令牌并用 followup 把令牌与交接正文投给继任者（不是 inject）；auto 需要 handoff 正文，硬节用这几个标题：" + handoffSectionsInline() + "，缺硬节或正文为空一律拒绝于工具入口（零建会话、零令牌、零 freeze），且创建会话+交班前必过一次确认框（无确认服务 → fail-closed）。action=claim（Phase B，只能由 pending 指定的继任者会话凭令牌发起）：单个确认对话框列出全部「退役者↔同 team 成员」的 pairs 供逐项勾选（无人值守/超时/无确认服务 → 全部以 provisional 迁移，24h 内未批准自动回退；⚠️ 超时**不是失败**：若调用方在对话框等待期间超时或被中止，无人值守分支**已经落盘**（换届成立、旧任信任已对称吊销），读数会按该分支如实报告后果、到期时刻与批准路径（谁批、在哪批），重试不会撤销它，也不必重试）；迁移成功后对称吊销退役者的 pairs/trustedSenders/rememberTargets，落定 roster（current=新任、版本史追加），广播 rotation-done，并清除 pending。令牌过期未认领由过期清扫自动取消（广播 rotation-cancelled，旧任仍为 current，解除冻结；auto 自建的继任者会被额外点名）。域限定：团队外的 pairs 与未勾选的 pairs 一律随退役清理、不迁移；claim 幂等（同一令牌重放返回既有迁移清单、不重复迁移，判据是 current 已是继任者——域内没有候选 pair 时迁移清单本就是空的，同样走重放）。10 分钟速率限制防换届风暴。",
		parameters: {
			action: { type: "string", required: true, enum: ["prepare", "claim"], description: "prepare（Phase A：现任发起，出令牌 + 广播冻结）/ claim（Phase B：继任者凭令牌认领）" },
			team: { type: "string", required: true, description: "团队名（[a-z0-9-]+，须已在 roster 中）" },
			role: { type: "string", required: true, description: "要换届的角色名（约定角色名 coordinator）" },
			successor: { type: "string", description: "prepare 必填：继任者会话 id，或 \"auto\" 让插件自建一个根会话（令牌绑定 (team, role, successor) 三元组；须由该会话自己 claim）" },
			token: { type: "string", description: "claim 必填：prepare 返回的一次性令牌（掩码形式 tok-xxxx…yyyy 不是令牌）" },
			note: { type: "string", description: "写入版本史的备注（记在旧任任期的 until 记录上）；prepare 时给出则随 pending 保存，claim 时可直接覆盖" },
			handoff: { type: "string", description: "prepare 可选：交接正文（Markdown）。五个硬节各以一个标题开头：" + handoffSectionsInline() + "（软节 " + HANDOFF_SOFT_SECTIONS.join(" / ") + " 缺了只警告）。successor:\"auto\" 时必须给（空正文或硬节缺/空 → 拒绝于工具入口，零建会话零令牌零 freeze）；显式 successor 时可选，给了就写入交接文档，缺了只警告。插件只把关结构（节在场 / 非空 / 有界），不把关内容质量（§11.9.6）。" },
		},
		output: textOutput(),
		// The claim dialog may legitimately wait ROTATION_CONFIRM_TIMEOUT_MS (3min)
		// for a present user; the tool timeout has to sit above it.
		timeoutMs: 300000,
		async execute(args, exec) {
			try {
				const action = typeof args.action === "string" ? args.action : "";
				if (!ROTATION_ACTIONS.has(action)) return "操作失败：action 必须是 prepare 或 claim。";
				const name = readTeamName(args.team);
				if (name.error !== undefined) return wellFormed(`换届失败：${name.error}`);
				const role = readRoleName(args.role);
				if (role.error !== undefined) return wellFormed(`换届失败：${role.error}`);
				const caller = agentSessionId(exec);
				const now = Date.now();
				// The lazy half of the expiry sweep (§3.6.2 评审 #4). A claim excludes its
				// own team+role so that an expired token still gets its specific refusal
				// (and its cancellation) from the claim path below.
				const swept = await rotation.sweep({
					now,
					signal: exec.signal,
					// A claim must not sweep AWAY the very pending it is about to
					// validate: that one is handled (and reported specifically) by claim.
					except: action === "claim" ? { team: name.value, role: role.value } : null,
				});
				const preamble = swept.lines.length === 0 ? [] : ["换届过期清扫（本次调用触发）：", ...swept.lines, ""];
				const note = readNote(args.note);
				if (action === "prepare") {
					if (args.successor === undefined || args.successor === null || args.successor === "") {
						return wellFormed("prepare 失败：需要 successor（继任者会话 id，或 \"auto\" 让插件自建）——令牌绑定三元组 (team, role, successor)，没有继任者就无法换届（§3.6.1 原则 1）。successor:\"auto\"（§11.2）会自建一个根会话并自动交接（需要 handoff 正文）。§3.6.4 的半自动兜底始终保留：先在壳里打开/创建一个继任者会话，再把它的事务 id 传进来；令牌随交接 prompt 交给该会话。只想让角色空出来请用 team_link_roster action=retire。");
					}
					const auto = typeof args.successor === "string" && args.successor.trim() === ROTATION_AUTO;
					// §11.9.6's ladder runs FIRST — before the create, the token and the
					// freeze — so a refusal here is provably zero-side-effect.
					const handoff = readHandoffArgument(args.handoff, { auto });
					if (handoff.error !== undefined) return wellFormed(handoff.error);
					if (auto) {
						const outcome = await autoHandover({ ctx, policy, rotation, controller }, {
							teamName: name.value,
							roleName: role.value,
							note,
							handoff,
							caller,
							// The CALLER's workspace, never `process.cwd()`: a successor created in
							// the host process's own directory would be in the wrong workspace, so
							// an uncaptured cwd refuses instead (§10.2.6's absolute-path boundary).
							cwd: exec.agent?.session?.header?.cwd,
							agent: exec.agent,
							signal: exec.signal,
							now,
						});
						if (outcome.error !== undefined) return wellFormed(outcome.error);
						return wellFormed([...preamble, ...outcome.lines].join("\n"));
					}
					const successor = readSessionId(args.successor);
					if (successor.error !== undefined) return wellFormed(`prepare 失败：${successor.error}`);
					// The token is minted HERE, one step before prepare, because the
					// hand-over document's header carries its mask and the document is
					// written before the pending exists (§11.9.6). Nothing of it becomes
					// durable or visible unless this call reaches prepare.
					const token = randomUUID();
					const notes = [];
					if (handoff.body !== "") {
						const view = policy.get();
						const admission = prepareAdmission(view, { teamName: name.value, roleName: role.value, successor: successor.value, now, caller });
						if (admission.error !== undefined) {
							// §11.9.3: the refusal above is the one that names the incumbent,
							// so a seated-dead incumbent has to be diagnosed here — the words
							// "只有现任 X 可以发起换届" are TRUE and still MISLEADING when X
							// cannot be woken.
							const team = view.teams.find((candidate) => candidate.name === name.value) ?? null;
							const gate = withLiveGateDiagnostic(ctx, team === null ? null : roleOf(team, role.value), { error: admission.error });
							return wellFormed(gate.error);
						}
						const held = trustReferencesTo(policy.get(), admission.entry.current);
						const plan = planRotationMigration(policy.get(), { members: new Set(teamMembers(admission.team)), retiree: admission.entry.current, successor: successor.value });
						const document = await writeHandoffDocument(admission.team, {
							roleName: role.value,
							previous: admission.entry.current,
							successor: successor.value,
							token,
							preparedAt: now,
							body: handoff.body,
							report: handoff.report,
							facts: rotationFactRows({
								retiree: admission.entry.current,
								successor: successor.value,
								candidates: plan.candidates,
								dropped: plan.dropped,
								removedCount: held.pairs.length,
								trustedSenderCount: held.trustedSenders.length,
								rememberTargetCount: held.rememberTargets.length,
							}),
						});
						notes.push(document.ok
							? `交接文档（§11.4.3）：${document.path}（上一份：${document.previousDocument ?? "（无——本角色落盘的第一份）"}）`
							: `（注意：交接文档写入失败——${document.error}。本次换届照常进行：§11.9.6 的 abort-before-prepare 只对 successor:"auto" 生效，显式 successor 的会话有自己的生命与上下文。）`);
					}
					notes.push(...handoff.warnings.map((line) => `正文校验：${line}`));
					const result = await rotation.prepare({ teamName: name.value, roleName: role.value, successor: successor.value, note, caller, now, signal: exec.signal, token });
					if (result.error !== undefined) return wellFormed(result.error);
					return wellFormed([...preamble, ...result.lines, ...notes].join("\n"));
				}
				const token = readRotationToken(args.token);
				if (token.error !== undefined) return wellFormed(`claim 失败：${token.error}`);
				const result = await rotation.claim({ teamName: name.value, roleName: role.value, token: token.value, note, caller, now, signal: exec.signal, agent: exec.agent });
				if (result.error !== undefined) return wellFormed(result.error);
				return wellFormed([...preamble, ...result.lines].join("\n"));
			} catch (error) {
				return wellFormed(`换届操作失败：${describeError(error)}`);
			}
		},
	})), "team-link: rotate tool");
}

// ---------------------------------------------------------------------------
// export rendering
// ---------------------------------------------------------------------------

/**
 * Render one content block array as markdown. Known block types (text,
 * tool_use, tool-result) get dedicated shapes; anything else is fenced JSON so
 * the export stays complete without guessing at newer block types.
 */
function renderContentBlocks(content, limit = MD_BLOCK_LIMIT) {
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") {
			parts.push(truncate(block.text, limit));
		} else if (block?.type === "tool_use") {
			parts.push(`**工具调用 \`${block.name}\`**（call \`${block.id}\`）\n\n\`\`\`json\n${truncate(safeJson(block.arguments), limit)}\n\`\`\``);
		} else if (block?.type === "tool-result" && Array.isArray(block.content)) {
			parts.push(truncate(renderContentBlocks(block.content, limit), limit));
		} else {
			parts.push(`\`\`\`json\n${truncate(safeJson(block), limit)}\n\`\`\``);
		}
	}
	return parts.join("\n\n") || "（空内容）";
}

/**
 * Render a complete session log as readable markdown. Turns become section
 * breaks; user and assistant messages become labeled blocks; tool results are
 * summarized with a hard truncation so a runaway log cannot produce an
 * unbounded document (the JSON export keeps full fidelity).
 */
function renderSessionMarkdown(session, events, title) {
	const lines = [];
	lines.push(`# 会话导出：${typeof title === "string" && title !== "" ? title : session.id}`, "");
	lines.push(`- 会话 ID：\`${session.id}\``);
	if (typeof title === "string" && title !== "") lines.push(`- 标题：${title}`);
	lines.push(`- 创建时间：${new Date(session.createdAt).toISOString()}`);
	if (typeof session.cwd === "string" && session.cwd !== "") lines.push(`- 工作目录：${session.cwd}`);
	if (typeof session.origin === "string" && session.origin !== "") lines.push(`- 来源：${session.origin}`);
	if (typeof session.parentSession === "string" && session.parentSession !== "") lines.push(`- 父会话：\`${session.parentSession}\``);
	lines.push(`- 事件数：${events.length}`);
	lines.push(`- 导出工具：${PLUGIN_LABEL}`);
	for (const event of events) {
		switch (event?.type) {
			case "turn/start": {
				lines.push("", "---", "", `### Turn ${event.data?.turn ?? "?"}`);
				break;
			}
			case "user/message": {
				const message = event.data;
				const note = message?.source?.kind === "user" ? "" : `（来源：${message?.source?.kind ?? "unknown"}）`;
				lines.push("", `**👤 用户${note}**`, "", renderContentBlocks(message?.content));
				break;
			}
			case "assistant/message": {
				const message = event.data?.message;
				lines.push("", "**🤖 助手**", "", renderContentBlocks(message?.content));
				break;
			}
			case "tool/result": {
				const message = event.data?.message;
				const callId = typeof message?.source?.callId === "string" ? message.source.callId : "";
				const mark = event.data?.error !== undefined ? "（错误）" : "";
				lines.push("", `**🔧 工具结果${mark}** \`${callId}\``, "", renderContentBlocks(message?.content, MD_TOOL_RESULT_LIMIT));
				break;
			}
			case "command/run": {
				const data = event.data ?? {};
				const command = typeof data.command === "string" ? data.command : preview(safeJson(data), 200);
				lines.push("", `> 💻 ${preview(command, 200)}`);
				break;
			}
			default:
				// Structural events (step/turn markers, todo writes, compaction,
				// approval trails, ...) stay out of the readable rendering; the
				// JSON export keeps every one of them.
				break;
		}
	}
	return wellFormed(`${lines.join("\n")}\n`);
}

/**
 * Serialized complete-fidelity JSON export document — the one place the file
 * writer and the download route both call. `JSON.stringify` is already
 * well-formed (ES2019 escapes an unpaired surrogate as a six-character `\uXXXX`
 * escape, never raw), so `wellFormed` is a no-op today; it stays as the explicit
 * statement of the contract this document is written under.
 */
function jsonExportText(session, events, title) {
	return wellFormed(JSON.stringify(buildJsonExport(session, events, title), null, 2));
}

/** Complete-fidelity JSON export document. */
function buildJsonExport(session, events, title) {
	return {
		exporter: PLUGIN_LABEL,
		exportedAt: new Date().toISOString(),
		session,
		title: typeof title === "string" ? title : null,
		eventCount: events.length,
		events,
	};
}

/**
 * The ONE filename-safety invariant for a session id (§4.1 / 评审 #2): both the
 * download route's `content-disposition` and the export tool's artifact names
 * come from here, so a session id carrying a separator or any other non-filename
 * rune cannot land in a path or a header unmapped. Only the id is sanitised —
 * the `-<timestamp>.{md,json}` tail (and the route's extension) is unchanged, so
 * the artifacts stay as readable as they were.
 */
function fileSafeSessionId(sessionId) {
	return String(sessionId).replace(/[^\w.-]/gu, "_");
}

/** Latest log-backed title for one session, or undefined. Never throws. */
async function titleOf(ctx, sessionId) {
	try {
		const snapshots = await ctx.sessionQuery.readTitleSnapshots([sessionId]);
		const first = Array.isArray(snapshots) ? snapshots[0] : undefined;
		if (first?.status === "fulfilled" && typeof first.value?.title === "string") return first.value.title;
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Export one session to `.dsh-exports/<id>-<timestamp>.{md,json}` inside the
 * session's own workspace (or an explicit outputDir). The id goes through
 * {@link fileSafeSessionId} — the same invariant the download route uses — so a
 * session id can never steer the write out of the export directory or pick the
 * file's extension; the timestamped name shape is untouched.
 * @returns the header, events, folded title, and the absolute paths written.
 */
async function exportSession(ctx, sessionId, { format = "both", outputDir } = {}) {
	const { session, events } = await ctx.sessionQuery.readSession(sessionId);
	const title = await titleOf(ctx, sessionId);
	const dir = typeof outputDir === "string" && outputDir !== "" ? outputDir : path.join(typeof session.cwd === "string" && session.cwd !== "" ? session.cwd : process.cwd(), EXPORT_DIR);
	await mkdir(dir, { recursive: true });
	const stamp = timestamp();
	const name = fileSafeSessionId(sessionId);
	const files = [];
	if (format === "both" || format === "json") {
		const file = path.join(dir, `${name}-${stamp}.json`);
		await writeFile(file, `${jsonExportText(session, events, title)}\n`, "utf8");
		files.push(file);
	}
	if (format === "both" || format === "md") {
		const file = path.join(dir, `${name}-${stamp}.md`);
		await writeFile(file, renderSessionMarkdown(session, events, title), "utf8");
		files.push(file);
	}
	return { session, events, title, files };
}

// ---------------------------------------------------------------------------
// broadcast fan-out + envelope meta (§3.4, M3)
// ---------------------------------------------------------------------------

/** Address-expression prefix. Anything else is taken as a session id — the
 * legacy meaning of a send target, and §3.4's first resolution step. */
const TEAM_EXPR_PREFIX = "team:";
/** §4.1: one fan-out travels to at most this many targets (counted on the raw
 * argument, before duplicates are collapsed, so a batch can never smuggle extra
 * work past the bound). */
const FANOUT_MAX_TARGETS = 8;
/** The closed `meta.type` set of §3.4. */
const META_TYPES = new Set(["ruling", "receipt", "report", "ask"]);
/** The closed `meta.pri` set of §3.4 (P0 = highest). */
const META_PRIS = new Set(["P0", "P1", "P2"]);
/** §4.1: `meta.ref` is a short reference; a longer one is truncated to this many
 * code points (the `preview` counting unit, so an astral character costs one). */
const META_REF_LIMIT = 16;
/** Exactly the three keys §3.4 gives the envelope — no more, no fewer. */
const META_KEYS = new Set(["type", "pri", "ref"]);
/** How many live sessions a `no-agent` refusal names before it stops. The list is
 * a self-healing hint on a refusal path, not a session listing tool (that is
 * `team_link_list_sessions`, which is bounded by `LIST_LIMIT`); ten ids are
 * enough to spot a transcription slip and small enough to keep the refusal
 * readable. A longer match set declares the bound instead of hiding it. */
const NO_AGENT_LIST_LIMIT = 10;
/** The ❌ lead of the `no-agent` refusal: a failure that a model might read as a
 * queued send (the reported incident) must say so in its very first character —
 * the field the eye lands on before any of the explanatory text. */
const NO_DELIVERY_PREFIX = "❌ 未投递";

/**
 * §3.4 envelope reading. The whole object is rejected as a unit: a half-accepted
 * envelope would make the delivered banner say something the caller did not ask
 * for, and an undefined key or an out-of-enum value is reported as a parameter
 * error rather than silently dropped.
 *
 * @returns `{ value: meta|null, notes }` (`notes` carries the truncation report)
 *   or `{ error }`.
 */
function readMeta(value) {
	if (value === undefined || value === null) return { value: null, notes: [] };
	if (typeof value !== "object" || Array.isArray(value)) {
		return { error: "meta 必须是对象 { type?, pri?, ref? }：type ∈ ruling/receipt/report/ask，pri ∈ P0/P1/P2，ref 为不超过 16 字符的短引用。" };
	}
	const unknown = Object.keys(value).filter((key) => !META_KEYS.has(key));
	if (unknown.length > 0) {
		return { error: `meta 含 §3.4 未定义的字段 ${unknown.join("、")}——信封只有 type（ruling/receipt/report/ask）、pri（P0/P1/P2）、ref（≤16 字符）三个键，未定义字段一律拒绝而不是静默丢弃。` };
	}
	const meta = {};
	const notes = [];
	if (value.type !== undefined && value.type !== null) {
		if (typeof value.type !== "string" || !META_TYPES.has(value.type)) {
			return { error: `meta.type 非法：${typeof value.type === "string" ? value.type : safeJson(value.type)}——枚举 ruling / receipt / report / ask。` };
		}
		meta.type = value.type;
	}
	if (value.pri !== undefined && value.pri !== null) {
		if (typeof value.pri !== "string" || !META_PRIS.has(value.pri)) {
			return { error: `meta.pri 非法：${typeof value.pri === "string" ? value.pri : safeJson(value.pri)}——枚举 P0 / P1 / P2。` };
		}
		meta.pri = value.pri;
	}
	if (value.ref !== undefined && value.ref !== null) {
		if (typeof value.ref !== "string") return { error: "meta.ref 必须是字符串（短引用，≤16 字符）。" };
		if (/[\u0000-\u001F\u007F]/u.test(value.ref)) return { error: "meta.ref 不能包含控制字符或换行——它是 banner 首行的单行字段。" };
		const chars = [...value.ref];
		if (chars.length === 0) return { error: "meta.ref 不能是空字符串——不需要该字段就不要传这个键。" };
		meta.ref = chars.length <= META_REF_LIMIT ? value.ref : chars.slice(0, META_REF_LIMIT).join("");
		if (chars.length > META_REF_LIMIT) {
			notes.push(`meta.ref 超过 ${META_REF_LIMIT} 字符（原 ${chars.length} 字符），已按码点截断为「${meta.ref}」。`);
		}
	}
	return { value: meta, notes };
}

/**
 * The §3.4 banner first-line fields, in the design's order and shape
 * (`type=ruling pri=P0 ref=slp-a1b2`) — only the keys the caller actually gave,
 * so a partial envelope renders a partial line instead of an empty slot.
 */
function metaBannerFields(meta) {
	if (meta === null || meta === undefined) return "";
	const parts = [];
	if (meta.type !== undefined) parts.push(`type=${meta.type}`);
	if (meta.pri !== undefined) parts.push(`pri=${meta.pri}`);
	if (meta.ref !== undefined) parts.push(`ref=${meta.ref}`);
	return parts.length === 0 ? "" : ` · ${parts.join(" ")}`;
}

/** Append the envelope notes (a truncated `ref`) to one send result. */
function withMetaNotes(text, notes) {
	return notes.length === 0 ? text : `${text}\n注意：${notes.join("；")}`;
}

/**
 * §3.4 address resolution for ONE expression. Priority, verbatim: a session id
 * is taken as-is (and still passes both gates per target — V8 is never
 * relaxed); `team:<name>/<role>` is point-to-point and open to any session;
 * `team:<name>/*` is the whole team and coordinator-only, because the
 * coordinator's value is partly the curation of what each worker sees
 * (《调研》§5.3 论据 (a): the incident notice was a curated forward) — and a
 * flash worker's scarcest resource is context.
 *
 * A vacant role becomes the typed `no-holder` row of §3.4 (评审 #7: never a
 * `[null]` target); it is neither a delivery nor a failure, so it counts in
 * neither. A team that is not in the roster refuses the whole call.
 *
 * @param expr - one `targets` entry.
 * @param teams - the normalized roster (`policy.get().teams`).
 * @param caller - `exec.agent.id`, the identity the wildcard rule compares.
 * @param options - `isLive(sessionId)`, the live-member filter of §3.4's
 *   `allLiveMembers` (defaults to "everyone is live", which keeps the resolver
 *   a pure function for the unit tests).
 * @returns `{ rows }` — id rows `{ sessionId, expr }` or typed rows
 *   `{ target, outcome: "no-holder", detail }` — or `{ error }` for a refusal
 *   that ends the whole call.
 */
function resolveTargets(expr, teams, caller, options = {}) {
	const isLive = typeof options.isLive === "function" ? options.isLive : () => true;
	if (!expr.startsWith(TEAM_EXPR_PREFIX)) return { rows: [{ sessionId: expr, expr }] };
	const body = expr.slice(TEAM_EXPR_PREFIX.length);
	const slash = body.indexOf("/");
	if (slash === -1 || slash === body.length - 1) {
		return { error: `寻址表达式 ${expr} 非法：形如 team:<name>/<role> 或 team:<name>/*（name 为 [a-z0-9-]+），或直接给会话 id。` };
	}
	const name = body.slice(0, slash);
	const member = body.slice(slash + 1);
	const team = teams.find((candidate) => candidate.name === name) ?? null;
	if (team === null) {
		return { error: `寻址表达式 ${expr} 指向的团队 ${name} 不在注册表中（先用 team_link_roster action=upsert-team 创建，或直接用会话 id 发送）。` };
	}
	if (member === "*") {
		const coordinator = roleOf(team, COORDINATOR_ROLE);
		const incumbent = coordinator === null ? null : coordinator.current;
		if (incumbent === null || caller === undefined || caller !== incumbent) {
			return { error: `全队广播被拒绝：team:${name}/* 只能由团队 ${name} 的现任协调者会话发起（现任 ${incumbent ?? "空缺"}，当前调用会话 ${caller ?? "（无会话身份）"}）。理由（《调研》§5.3 论据 (a)）：协调者的价值部分在于策展每个 worker 看到什么，而 flash worker 最稀缺的资源是上下文——全连通群播会让每个 worker 的上下文互相污染。请点对点发送（team:<name>/<role> 或会话 id），或由协调者发起全队广播。` };
		}
		// §3.4 `allLiveMembers`: every role that is filled AND live. A vacant role
		// is not a member, and a member whose agent is gone has nowhere to land —
		// point-to-point addressing is the form that reports such a target back.
		// The caller itself is skipped: the relay path refuses self-send by
		// construction, so keeping it would put a guaranteed refusal row in every
		// broadcast.
		const rows = [];
		for (const entry of team.roles) {
			if (entry.current === null || entry.current === caller) continue;
			if (!isLive(entry.current)) continue;
			rows.push({ sessionId: entry.current, expr });
		}
		return { rows };
	}
	const role = roleOf(team, member);
	if (role === null) {
		return { rows: [{ target: expr, outcome: "no-holder", detail: `团队 ${name} 没有角色 ${member}（未注册，等同空缺）` }] };
	}
	if (role.current === null) return { rows: [{ target: expr, outcome: "no-holder", detail: "该角色当前空缺" }] };
	return { rows: [{ sessionId: role.current, expr }] };
}

/**
 * §3.4 resolution of a whole `targets` array. Every expression is resolved
 * first and any expression-level refusal ends the call BEFORE a single message
 * is delivered — so a batch is never half-sent because of a bad address. Duplicate
 * session ids (and repeated `no-holder` expressions) collapse into one row; the
 * dropped count is reported in the summary.
 *
 * @returns `{ rows, duplicates }` or `{ error }`.
 */
function resolveTargetList(targets, teams, caller, options = {}) {
	if (targets.length === 0) return { error: "targets 不能是空数组——给至少一个目标（会话 id、team:<name>/<role> 或 team:<name>/*）。" };
	if (targets.length > FANOUT_MAX_TARGETS) {
		return { error: `单次 fan-out 最多 ${FANOUT_MAX_TARGETS} 个目标（本次 ${targets.length} 个；§4.1 防偏离）。请拆成多次广播。` };
	}
	const rows = [];
	const seenSessions = new Set();
	const seenExpressions = new Set();
	let duplicates = 0;
	for (const item of targets) {
		if (typeof item !== "string" || item.trim() === "") {
			return { error: "targets 的每一项都必须是非空字符串（会话 id、team:<name>/<role> 或 team:<name>/*）。" };
		}
		const resolved = resolveTargets(item.trim(), teams, caller, options);
		if (resolved.error !== undefined) return { error: resolved.error };
		for (const row of resolved.rows) {
			if (row.sessionId === undefined) {
				if (seenExpressions.has(row.target)) { duplicates += 1; continue; }
				seenExpressions.add(row.target);
				rows.push(row);
				continue;
			}
			if (seenSessions.has(row.sessionId)) { duplicates += 1; continue; }
			seenSessions.add(row.sessionId);
			rows.push(row);
		}
	}
	return { rows, duplicates };
}

/** Result-row label of one resolved target: the resolved session id, with the
 * expression it came from when that is something else (`session-x（via team:t/*）`). */
function targetLabel(row) {
	return row.expr === row.sessionId ? row.sessionId : `${row.sessionId}（via ${row.expr}）`;
}

/**
 * §3.5 (the P3 prevention face): one sentence about the semantics the sender just
 * bought. `turnStartedAt` comes from §3.1's signal — the same reading the
 * liveness face prints — and when the surface cannot be read the steer semantics
 * are still stated, just without a number.
 */
function busyGuidance(signal, now) {
	if (signal.agent !== "running") return "";
	if (typeof signal.turnStartedAt !== "number") {
		return "目标回合运行中，起始时间不可读（steer 注入当前回合）；需新回合语义请等其空闲。";
	}
	const minutes = Math.max(0, Math.floor((now - signal.turnStartedAt) / 60000));
	return `目标回合已运行 ${minutes} 分钟（steer 注入当前回合）；需新回合语义请等其空闲。`;
}

/**
 * Live sessions of the caller's own workspace, rendered as `id（运行中/空闲）`
 * rows: the self-healing half of a `no-agent` refusal.
 *
 * The agent registry is the ONLY source — no surface read, no log
 * decompression — so the enumeration costs nothing on a path a mistyped id
 * lands on. The filter is the caller's own view of "another root session here":
 * a live root agent (the same `roots()` judgement `deliverToTarget`'s subagent
 * guard uses, so a subagent is never advertised as an addressable peer), in the
 * caller's workspace, and never the caller itself. When the execution context
 * carries no session identity (the rotation notice path builds its sender from
 * an id alone) the workspace column is unknown and the cwd filter is skipped —
 * excluding the caller is then all that can honestly be done.
 *
 * @param ctx - plugin context; `ctx.agents.list()` is the registry read
 *   (goal-round-driver uses the same API).
 * @param exec - the tool-call context; `exec.agent` carries the caller's own
 *   `session.header.cwd` when it has one.
 * @param selfId - the caller's session id, excluded from its own hint list.
 * @returns `{ rows, total }` — `total` is the match count BEFORE the
 *   `NO_AGENT_LIST_LIMIT` cut, so the caller can declare the bound rather than
 *   hide it.
 */
function liveWorkspaceSessions(ctx, exec, selfId) {
	const rows = [];
	if (typeof ctx?.agents?.list !== "function") return { rows, total: 0 };
	const roots = typeof ctx.agents.roots === "function" ? ctx.agents.roots() : null;
	const caller = exec?.agent;
	const callerCwd = caller?.session?.header?.cwd;
	const scoped = typeof callerCwd === "string" && callerCwd !== "";
	let total = 0;
	for (const agent of ctx.agents.list()) {
		if (agent === undefined || agent === null) continue;
		if (agent === caller || (selfId !== undefined && agent.id === selfId)) continue;
		// Two independent subagent judgements, both already used by the delivery
		// guard: the coarse `origin` class and roots() membership.
		if (agent.session?.header?.origin === "subagent") continue;
		if (roots !== null && !roots.includes(agent)) continue;
		if (scoped && agent.session?.header?.cwd !== callerCwd) continue;
		total += 1;
		if (rows.length < NO_AGENT_LIST_LIMIT) {
			rows.push(`${agent.id}（${agent.status === "running" ? "运行中" : "空闲"}）`);
		}
	}
	return { rows, total };
}

/**
 * The `no-agent` refusal, made self-healing. Reported incident: a coordinator
 * mistyped one digit of a target id, got "没有活动代理", and had nothing to
 * compare the id against — so it carried on reporting the send as fine while
 * the target session was alive. Three parts, in order:
 *
 * 1. the ❌ 未投递 lead — a failure may never be read as a queued send;
 * 2. the legacy sentence, kept word for word (目标会话 <id> 没有活动代理) so the
 *    refusal stays recognisable, followed by the live same-workspace sessions
 *    from {@link liveWorkspaceSessions};
 * 3. the recovery hint: compare the id (transcription slip is the common case),
 *    re-open the session in the sidebar after a DSH restart (that is what
 *    restores it as a live agent), or re-read the list before retrying.
 *
 * `targetId` is the caller's own tool argument echoed back — the wellFormed
 * repair rides here as it does on every other refusal.
 */
function noAgentRefusal(ctx, exec, targetId) {
	const { rows, total } = liveWorkspaceSessions(ctx, exec, agentSessionId(exec));
	const listed = total === 0
		? "当前工作区无其他存活会话。"
		: [
			`当前工作区其他存活会话（共 ${total} 个${total > rows.length ? `，仅列前 ${rows.length} 个` : ""}）：`,
			...rows.map((row) => `  - ${row}`),
		].join("\n");
	return wellFormed([
		`${NO_DELIVERY_PREFIX}：目标会话 ${targetId} 没有活动代理（未在本壳中打开或已退出）。仅支持投递到存活会话。`,
		listed,
		"提示：请对照上列 id 核对目标 id（常见错误：转录错位）；若 id 无误且刚重启过 DSH，请在侧边栏打开目标会话一次使其恢复为活动代理；也可先调 team_link_list_sessions 查询。",
	].join("\n"));
}

/**
 * Deliver one relay message to one target session — the complete legacy send
 * path, unchanged: the self / dead / subagent guards, the explicit block (which
 * also drops a stale pair), the pairing fast path, gate 1 (sender approval),
 * gate 2 (receiver policy) and the steer/followup delivery. §3.5's busy
 * prediction rides on the success sentence.
 *
 * The single-target call and every fan-out iteration both go through here, so a
 * batch can never skip a gate a single send would have raised (§3.4/§4.1:
 * fan-out 不放宽任何门; V8).
 *
 * `options.internal` is the §3.6.2 "内部广播路径" used by the rotation notices:
 * the body is a plugin constant (no model can inject into it), so the SENDER-side
 * approval gate is skipped — but the receiver's inbound policy, its block list
 * and the pair fast path are all still walked exactly as below (the plugin never
 * gets a channel the user did not grant; §5.3 红线 "fan-out 不绕门").
 * An internal notice NEVER opens the receiver's "ask" dialog (§3.6.2 评审 #3): it
 * is delivered inside a tool call or a background patrol, one recipient after the
 * other, so a three-minute dialog per unpaired member could eat the caller's whole
 * budget (the rotation tool is allowed 300s) — the receiver is skipped with an
 * explicit row (refused-ask semantics) whose text names the two ways to receive
 * the notice later (trustedSenders / pairing). Sweep-originated notices take the
 * same path: the two broadcast modes are one.
 *
 * @returns `{ outcome: "delivered"|"refused"|"no-agent", text }`; `text` is the
 *   legacy result sentence, reused verbatim as the fan-out row detail.
 */
async function deliverToTarget(ctx, policy, sender, exec, targetId, text, meta, options = {}) {
	const internal = options.internal === true;
	if (targetId === sender.id) return { outcome: "refused", text: "发送失败：目标会话不能是当前会话。" };
	const target = ctx.agents.get(targetId);
	// `targetId` is a model-supplied tool argument echoed straight back into the
	// caller's history — the "tool argument echo" carrier — so the refusal is
	// repaired here and does not rely on the output.render gate alone.
	if (target === undefined) return { outcome: "no-agent", text: noAgentRefusal(ctx, exec, targetId) };
	if (target?.session?.header?.origin === "subagent") return { outcome: "refused", text: "发送失败：目标会话是子代理会话，不支持接收跨会话消息。" };
	if (typeof ctx.agents.roots === "function" && !ctx.agents.roots().includes(target)) {
		return { outcome: "refused", text: "发送失败：目标代理不是根代理（可能是子代理），不支持接收跨会话消息。" };
	}

	// ---- block check + pairing fast path ----------------------------------
	const initialView = policy.get();
	// One instant for every pair decision of this delivery: an expired provisional
	// channel must be judged by the same clock as the gate it is denied (§3.6.2 评审 #8).
	const gateNow = Date.now();
	if (initialView.blockedSenders.includes(sender.id)) {
		// An explicit block always wins, even over an established pair.
		if (pairBetween(initialView, sender.id, targetId, gateNow)) {
			try {
				await policy.update({ pairs: initialView.pairs.filter((pair) => !((pair.a === sender.id && pair.b === targetId) || (pair.a === targetId && pair.b === sender.id))) });
			} catch {
				/* best-effort pair cleanup once the sender is blocked */
			}
		}
		return { outcome: "refused", text: "未投递：目标会话已屏蔽来自当前会话的消息。" };
	}
	// 评审 #8: an expired provisional record is NO pair here — the delivery falls
	// back to the two ordinary gates the moment the 24h window closes, whether or
	// not the sweep has deleted the row yet.
	const pair = pairRecordBetween(initialView, sender.id, targetId, gateNow);
	const paired = pair !== null;
	const userQuestions = paired ? undefined : ctx.get?.("userQuestions");
	const askable = userQuestions !== undefined && typeof userQuestions.ask === "function";
	// Deliberately fail-closed: without the confirmation service an unpaired send
	// refuses, even in a configuration whose gates would not have asked (sender
	// already remembered AND the receiver trusting/accepting). Relaxing this to
	// "ask only if a gate would prompt" is a policy decision, not a bug fix — and
	// the fan-out inherits it per target, so a batch is never a way around it.
	// An INTERNAL notice has no sender-side gate to answer, so this guard does not
	// apply to it; its receiver-side dialog is checked where that dialog is raised.
	if (!internal && !paired && !askable) {
		return { outcome: "refused", text: "发送失败：跨会话发送需要用户批准，但确认服务（userQuestions）不可用。" };
	}

	// ---- gate 1: sender-side approval (skipped for plugin-internal notices) --
	if (!internal && !paired && !policy.get().rememberTargets.includes(targetId)) {
		let choice;
		try {
			const answer = await userQuestions.ask({
				questions: [{
					id: "send-confirm",
					header: "跨会话发送确认",
					// The payload is the caller's own text, echoed back into a dialog;
					// preview() cannot create a lone surrogate but cannot repair one it
					// was handed either, so the question leaves well-formed.
					question: wellFormed(`发送消息到会话 ${sessionLabel(targetId, undefined)}？\n\n${preview(text, 300)}`),
					options: [
						{ label: "发送", description: "本次发送；下次发送到该会话仍会确认" },
						{ label: "记住该目标并发送", description: "今后发送到该会话不再逐次确认" },
						{ label: "取消", description: "不发送" },
					],
				}],
				agent: sender,
				signal: exec.signal,
			});
			choice = answer?.answers?.[0]?.selected?.[0];
		} catch (error) {
			return { outcome: "refused", text: wellFormed(`发送失败：发送确认未完成（${describeError(error)}）。`) };
		}
		if (choice === "取消") return { outcome: "refused", text: "已取消：用户拒绝了本次发送。" };
		if (choice !== "发送" && choice !== "记住该目标并发送") return { outcome: "refused", text: "发送失败：发送确认未得到明确同意。" };
		if (choice === "记住该目标并发送") {
			try {
				await policy.update({ rememberTargets: withSender(policy.get().rememberTargets, targetId) });
			} catch {
				/* remembering is best-effort; the send itself proceeds */
			}
		}
	}

	const [senderTitle, targetTitle] = await Promise.all([titleOf(ctx, sender.id), titleOf(ctx, targetId)]);

	// ---- gate 2: receiver-side inbound policy -----------------------------
	if (!paired && !policy.get().trustedSenders.includes(sender.id)) {
		const view = policy.get();
		if (view.receiveMode === "reject") return { outcome: "refused", text: "未投递：目标会话的接收策略为全部拒绝（可在设置 team-link 中调整）。" };
		if (view.receiveMode === "ask") {
			if (!askable) return { outcome: "refused", text: "未投递：目标会话的接收策略为逐条确认（ask），但确认服务（userQuestions）不可用。" };
			if (internal) {
				// §3.6.2 评审 #3: an internal notice never blocks on a confirmation
				// dialog — not for a sweep (no present user) and not for prepare/claim
				// either (N unpaired "ask" members × a 3-minute dialog would overrun the
				// caller's tool budget). The row is the record; the ask mode itself is
				// not overridden, so the receiver can still be reached by making the
				// sender trusted or by pairing.
				return { outcome: "refused", text: "未投递：目标会话的接收策略为逐条确认（ask），而插件内部通知（rotation-freeze / rotation-done / rotation-cancelled / rotation-expired）一律不弹确认框——通知在工具调用或巡逻里逐个串行投递，3 分钟弹框会拖垮调用方（几个 ask 成员就吃掉全部工具预算）。可把发送方加入 trustedSenders 或建立配对后补收。" };
			}
			let timedOut = false;
			const controller = new AbortController();
			const timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, RECEIVE_CONFIRM_TIMEOUT_MS);
			const forwardAbort = () => controller.abort();
			exec.signal?.addEventListener?.("abort", forwardAbort);
			let choice;
			try {
				const answer = await userQuestions.ask({
					questions: [{
						id: "receive-confirm",
						header: "收到跨会话消息请求",
						question: wellFormed(`会话 ${sessionLabel(sender.id, senderTitle)} 请求向你发送消息：\n\n${preview(text, 300)}`),
						options: [
							{ label: "接收", description: "接收这一次" },
							{ label: "总是接收该会话", description: "记住该发送方，今后免确认" },
							{ label: "配对：双向免确认", description: "建立配对通道：这两个会话今后互发免确认（本次亦接收）" },
							{ label: "拒绝并屏蔽该会话", description: "拒绝本次，并屏蔽该发送方" },
						],
					}],
					agent: target,
					signal: controller.signal,
				});
				choice = answer?.answers?.[0]?.selected?.[0];
			} catch (error) {
				return timedOut
					? { outcome: "refused", text: "未投递：目标会话用户未在 3 分钟内确认接收。" }
					: { outcome: "refused", text: wellFormed(`未投递：目标会话用户未能确认（${describeError(error)}）。`) };
			} finally {
				clearTimeout(timer);
				exec.signal?.removeEventListener?.("abort", forwardAbort);
			}
			if (choice === "拒绝并屏蔽该会话") {
				try {
					await policy.update({ blockedSenders: withSender(policy.get().blockedSenders, sender.id) });
				} catch {
					/* best-effort persistence of the block decision */
				}
				return { outcome: "refused", text: "未投递：目标会话用户拒绝并屏蔽了来自当前会话的消息。" };
			}
			if (choice === "配对：双向免确认") {
				try {
					const current = policy.get();
					const pairedAt = Date.now();
					if (!pairBetween(current, sender.id, targetId, pairedAt)) {
						await policy.update({ pairs: [...current.pairs, { a: sender.id, b: targetId, createdAt: pairedAt }] });
					}
				} catch {
					/* best-effort pairing; this send still proceeds */
				}
			} else if (choice === "总是接收该会话") {
				try {
					await policy.update({ trustedSenders: withSender(policy.get().trustedSenders, sender.id) });
				} catch {
					/* best-effort persistence of the trust decision */
				}
			} else if (choice !== "接收") {
				return { outcome: "refused", text: "未投递：目标会话用户未确认接收。" };
			}
		}
		// receiveMode === "accept" → deliver without asking
	}

	// ---- §3.5 busy prediction (read before delivering, so the minutes are the
	// turn the message actually lands in) ------------------------------------
	const now = Date.now();
	const running = target.status === "running";
	// One liveness read feeds BOTH faces of §3.5: the sentence below and the
	// structured `busy` of the §10.1.2 card — same clock, same sample, so the
	// card and the model-visible text cannot disagree about the turn's age. An
	// idle target is NOT read (the surface read is the expensive half).
	const busySignal = running ? buildLivenessSignal(ctx, targetId, { now, agent: target, surface: await readSessionSurface(ctx, targetId) }) : undefined;
	const busy = running ? busyGuidance(busySignal, now) : "";

	// ---- deliver -----------------------------------------------------------
	// The banner is written into the TARGET session's log, where a lone
	// surrogate would kill that session's next request — so the payload is
	// made well-formed here, at the door, not merely where it is displayed.
	// §3.4's envelope rides on the first line; the source below still carries
	// exactly the three audited members (V10).
	const banner = wellFormed([
		`📨 [跨会话消息 · 来自会话 ${sessionLabel(sender.id, senderTitle)} · ${localStamp()}${metaBannerFields(meta)}]`,
		"",
		text,
		"",
		"（如需回复，可让本会话调用 team_link_send 工具发回）",
	].join("\n"));
	// The source is the audited cross-session relay shape the DSH 0.1.5
	// session-format migration admits — exactly `{kind, form, senderSessionId}`.
	// An unknown kind (or any extra member) refuses the WHOLE session log at
	// migration time, so the sender, the plugin name, the delivery time AND the
	// envelope fields live in the banner text instead of the source.
	const message = {
		id: `slp-${randomUUID()}`,
		role: "user",
		source: { kind: "agent-message", form: "relay", senderSessionId: sender.id },
		content: [{ type: "text", text: banner }],
	};
	if (running) target.steer(message);
	else target.followup(message);
	// §3.6.2 评审 #3 (provisional 可见面): a delivery that rides a rotation-granted
	// channel says so — the sender has to know the channel is not ratified yet and
	// that it rolls back in 24h. The banner deliberately gains no field (the
	// envelope stays the §3.4 three-key object) — this suffix is the face of record.
	const channelNote = paired
		? pair.provisional === true
			? "（provisional 通道，24h 内未批准自动回退）"
			: "（已配对通道，免确认自动投递）"
		: "";
	return {
		outcome: "delivered",
		text: wellFormed(`已投递到 ${sessionLabel(targetId, targetTitle)}${channelNote}：${running ? `目标正在运行，消息将在步边界注入当前回合。${busy}` : "目标空闲，已唤醒目标会话并作为新回合处理（消息与回复稍后出现在目标会话中）"}。`),
		// §10.1.2: the structured half of the same prediction, for the card.
		// Only a delivery that reached an agent has one — a refusal has no turn
		// to describe.
		busy: sendBusyOf(running, busySignal, now),
	};
}

/**
 * §3.4 fan-out: {@link deliverToTarget} once per resolved target, one result row
 * each, then the summary line. Nothing here relaxes a gate — the loop calls the
 * legacy path itself, approval dialog and all, so N targets cost N approvals.
 * `no-holder` rows are the typed vacancy results: neither a delivery nor a
 * failure, and the design counts them in neither.
 *
 * Failure lead (reported incident: a caller read "1 投递 / 2 拒绝" as "broadcast
 * done" while two thirds of the team never heard anything): as soon as ONE
 * target did not come back `delivered`, the report OPENS with
 * `❌ N 个目标未投递（M 个已投递）` — the shape a fully successful batch has, in
 * which the header, the per-target rows and the summary simply follow, is kept
 * exactly for the all-delivered case. `no-holder` counts as 未投递 here for the
 * same reason it counts in neither 投递 nor 拒绝 below: the message did not
 * reach that target, and the lead-in says 未投递, never 失败 — the detailed
 * summary keeps the vacancy in its own, separate bucket.
 *
 * @returns `{ lines, results }` — the report lines of the fan-out. Each
 *   `results` entry also carries the resolved `sessionId` (null for a
 *   `no-holder` row) and its `expr`, plus the §10.1.2 `busy` of a delivery —
 *   internal fields only: they feed the card, never the report text.
 */
async function fanout(ctx, policy, sender, exec, request) {
	const { rows, duplicates, meta, payload } = request;
	const results = [];
	for (const row of rows) {
		if (row.sessionId === undefined) {
			results.push({ label: row.target, outcome: "no-holder", text: row.detail, sessionId: null, expr: row.target });
			continue;
		}
		// R5 (M3 review): one target's failure must not be able to take the whole
		// report down. An exception raised while delivering to target N (a throwing
		// steer/followup, a service that vanished mid-loop) becomes that target's
		// own refused row — the other targets keep their deliveries and the summary
		// line is always produced. Single-target sends keep their legacy behavior:
		// there the thrown error IS the answer, and no second target is at risk.
		try {
			const outcome = await deliverToTarget(ctx, policy, sender, exec, row.sessionId, payload, meta);
			results.push({ label: targetLabel(row), outcome: outcome.outcome, text: outcome.text, sessionId: row.sessionId, expr: row.expr, busy: outcome.busy });
		} catch (error) {
			results.push({ label: targetLabel(row), outcome: "refused", text: `发送失败：投递到该目标时异常（${describeError(error)}），其余目标不受影响。`, sessionId: row.sessionId, expr: row.expr });
		}
	}
	const count = (wanted) => results.filter((entry) => entry.outcome === wanted).length;
	const summary = [`${count("delivered")} 投递`, `${count("refused")} 拒绝`];
	if (count("no-agent") > 0) summary.push(`${count("no-agent")} 无活动代理`);
	if (count("no-holder") > 0) summary.push(`${count("no-holder")} 空缺目标（no-holder，不计入投递与失败）`);
	if (duplicates > 0) summary.push(`${duplicates} 个重复目标已去重`);
	// Failure lead (see the doc comment): the first line of a batch that lost a
	// target says so, so the shape of a successful batch can never stand in for
	// one that did not reach everyone.
	const undelivered = results.filter((entry) => entry.outcome !== "delivered").length;
	const lines = [];
	if (undelivered > 0) lines.push(`❌ ${undelivered} 个目标未投递（${count("delivered")} 个已投递）`);
	lines.push(`广播 fan-out：${results.length} 个目标${duplicates > 0 ? `（重复目标已去重 ${duplicates} 个）` : ""}`);
	for (const entry of results) lines.push(`- ${entry.label} → ${entry.outcome}：${entry.text}`);
	lines.push(`汇总：${summary.join(" / ")}。`);
	return { lines, results };
}

// ---------------------------------------------------------------------------
// §10.1.2 the sender-side receipt: `output.presentationMeta`
// ---------------------------------------------------------------------------

/**
 * The card `team_link_send` persists as `tool/result.meta`. This is the ONLY
 * data source of the sender-side cards (A: the tool row; D: the top-level
 * node) — the client never parses the result text, so a wording change here
 * cannot silently break a renderer.
 *
 * Lives in the core-opaque `meta` of `tool/result`, so it carries its own
 * discriminator (`kind`) instead of relying on "the only tool that writes
 * meta"; `v` is the branch point for a future schema change.
 *
 * WELL-FORMEDNESS (差异审计 F2). `meta` is validated as JSON and written into
 * the durable session log at `tool/result.meta`, and a lone surrogate there
 * fails the next model request of that session with HTTP 400 — permanently
 * (see `wellFormed`). The card is NOT rendered through `textOutput`, so the
 * model-visible gate does not cover it: every string that enters the card is
 * passed through `wellFormed` at its construction site instead. The complete
 * inventory of string members, and where each one is repaired:
 *   - `kind` — a module constant, not caller-derived (held to that by U13);
 *   - `senderSessionId` — {@link buildSendCard} (repaired);
 *   - `meta.type` / `meta.pri` — §3.4 closed enums, repaired at the same place
 *     (a no-op that keeps the rule "no string skips the gate" mechanical);
 *   - `meta.ref` — the caller's own text, repaired at the same place;
 *   - `message.text` — {@link sendCardMessage} (repaired before truncation);
 *   - `targets[].sessionId`, `targets[].expr`, `targets[].detail` —
 *     {@link buildSendCard} (repaired);
 *   - `targets[].outcome` — one of four literals minted in this file.
 * Everything else on the card is a number or a boolean.
 *
 * SIZE (差异审计 B1 的宿主侧补口). Two members are bounded, both by §10.1.2 and
 * both stating their own cut: `message.text` at 2000 code points (1500 + "..." +
 * 400, `truncated`/`chars`) and the `targets` ARRAY at {@link SEND_CARD_ROW_LIMIT}
 * rows (`targetsTruncated: { shown, total }`). Neither cut touches a count: the
 * `summary` always covers the whole delivery, and the model-visible report stays
 * one line per target. The client's own render-time row cap is the second,
 * independent defence for a `meta` that did not come from this file (it is
 * core-opaque and persisted, so a hand-edited log can carry any shape).
 *
 * `meta` rides `tool/result` and is projected only for a top-level dispatch
 * (`dsh-tools`: `exec.parent === undefined`), which is exactly a model-issued
 * `team_link_send` call. A call made from inside a `run_code` program therefore
 * has no card, and its row keeps the plain (model-visible text) rendering.
 */

/** §10.1.2 discriminator of the card. */
const SEND_CARD_KIND = "team-link-send";
/** §10.1.2 card schema version. */
const SEND_CARD_VERSION = 1;
/** §10.1.2 体积纪律, verbatim (U13 asserts these numbers): a persisted card must
 * be bounded, otherwise one long message is welded into the session log at full
 * length. Over the cap the body becomes head 1500 + the 3-code-point mark +
 * tail 400 = 1903 code points — still inside the cap. */
const SEND_MESSAGE_MAX_CHARS = 2000;
const SEND_MESSAGE_HEAD_CHARS = 1500;
const SEND_MESSAGE_TAIL_CHARS = 400;
/** The 省略标记: exactly three code points, as §10.1.2 specifies. */
const SEND_MESSAGE_MARK = "...";
/** §10.1.2 row discipline (2026-09-19 修正): the bound on `targets` is a ROW
 * count, not an expression count. {@link FANOUT_MAX_TARGETS} bounds the INPUT
 * expressions (≤8), but ONE `team:<name>/*` is a single expression that expands
 * to every filled live member of that team ({@link resolveTargets}), so a legal
 * broadcast can carry more rows than 8. The array that gets welded into the
 * session log at `tool/result.meta` is the card's, so the card caps its OWN rows
 * here — the same 24 as the design's per-team member cap (§10.2.4 每队成员总数
 * ≤24, so one full-team broadcast still renders whole) — and STATES the cut on
 * itself (`targetsTruncated`), the same 有界呈现 + 如实标注 discipline the body's
 * 2000/1500+3+400 follows. The `summary` counts and the model-visible report are
 * NOT bounded by this: the card is a bounded VIEW, the report is the full archive. */
const SEND_CARD_ROW_LIMIT = 24;

/**
 * §10.1.2 body rule. Code points (not UTF-16 units) are the counting and cutting
 * unit, so an astral character is never split by the cut itself; the whole
 * string is made well-formed FIRST, so a lone surrogate inherited from a tool
 * argument cannot reach the log through the card either.
 *
 * @param text - the caller's `message` argument.
 * @returns `{ text, truncated, chars }` — `chars` is the ORIGINAL code-point
 *   count (unchanged by the repair, which is 1:1 on code points).
 */
function sendCardMessage(text) {
	const clean = wellFormed(text);
	const chars = Array.from(clean);
	if (chars.length <= SEND_MESSAGE_MAX_CHARS) return { text: clean, truncated: false, chars: chars.length };
	return {
		text: chars.slice(0, SEND_MESSAGE_HEAD_CHARS).join("") + SEND_MESSAGE_MARK + chars.slice(chars.length - SEND_MESSAGE_TAIL_CHARS).join(""),
		truncated: true,
		chars: chars.length,
	};
}

/**
 * §3.5 busy prediction as a structured value, from the SAME reading
 * {@link busyGuidance} renders as a sentence. `minutes` is present only when
 * the running turn's start is readable (§10.1.2: "读不到时间戳则只有
 * running"), and never on an idle target — a followup woke it into a NEW turn,
 * so there is no running turn to describe.
 */
function sendBusyOf(running, signal, now) {
	if (running !== true) return { running: false };
	return typeof signal?.turnStartedAt === "number"
		? { running: true, minutes: Math.max(0, Math.floor((now - signal.turnStartedAt) / 60000)) }
		: { running: true };
}

/**
 * §10.1.2 envelope as it rides the card: exactly the keys §3.4 normalized, each
 * one through {@link wellFormedText}. `type`/`pri` are closed enums (the repair
 * is a no-op there) and `ref` is the caller's own text — an unpaired surrogate
 * in it is not a control character, so `readMeta`'s single-line check does not
 * catch it; this is the gate that does, because the envelope is persisted with
 * the card and never passes `textOutput.render`.
 */
function sendCardEnvelope(meta) {
	const out = {};
	if (meta.type !== undefined) out.type = wellFormedText(meta.type);
	if (meta.pri !== undefined) out.pri = wellFormedText(meta.pri);
	if (meta.ref !== undefined) out.ref = wellFormedText(meta.ref);
	return out;
}

/**
 * {@link wellFormed} for a member that is a string or absent. A non-string is
 * passed through UNTOUCHED rather than coerced: the only non-strings that can
 * reach the card are a hostile caller's non-string `targetSessionId`, and
 * keeping the wrong type there is what lets the client's shape reader reject
 * the card and degrade to the model-visible text row (§10.1.5 降级优先) —
 * stringifying it would dress that value up as a valid id instead.
 */
function wellFormedText(value) {
	return typeof value === "string" ? wellFormed(value) : value;
}

/**
 * Assemble one §10.1.2 receipt.
 *
 * Every string member is repaired here (see the inventory on the card doc
 * comment above): `sessionId` and `expr` are the caller's own addressing text —
 * a literal id or a `team:<name>/<role>` expression is echoed back into the card
 * verbatim, so neither may skip the gate just because the model-visible text
 * goes through `textOutput`.
 *
 * @param request - `{ senderSessionId, at, meta, message, targets, deduped, fanout }`;
 *   each target is `{ sessionId, expr?, outcome, detail, busy? }`.
 * @returns the card as a JSON value (no `undefined` members — it is snapshotted
 *   as lossless JSON by the Tool registry before it is persisted). The rows are
 *   capped at {@link SEND_CARD_ROW_LIMIT}; a card that had to cut rows carries
 *   `targetsTruncated: { shown, total }` (the mark of the §10.1.2 row bound) and
 *   a card inside the bound carries no such member at all — so the small case is
 *   byte-for-byte what it was before the bound existed.
 */
function buildSendCard(request) {
	const summary = { delivered: 0, refused: 0, noAgent: 0, noHolder: 0, deduped: request.deduped };
	// Every resolved target is COUNTED, and only then are the rows cut: the
	// summary is the honest total of the delivery that happened, the rows are its
	// bounded view (§10.1.2 — a cut must never cost a count). The model-visible
	// report this card accompanies is unaffected either way: `fanout` renders one
	// line per target from the same `results`, so the archive stays complete.
	const rows = [];
	for (const target of request.targets) {
		if (target.outcome === "delivered") summary.delivered += 1;
		else if (target.outcome === "refused") summary.refused += 1;
		else if (target.outcome === "no-agent") summary.noAgent += 1;
		else summary.noHolder += 1;
		const row = {
			sessionId: target.sessionId === undefined || target.sessionId === null ? null : wellFormedText(target.sessionId),
			outcome: target.outcome,
			detail: wellFormed(target.detail),
		};
		// §10.1.2: `expr` marks a target that came from an addressing expression
		// (team:<n>/<role>, team:<n>/*) — a literal session id is not an expression,
		// and `resolveTargets` stores the id itself in `expr` for that case.
		// Repaired for the same reason as `sessionId`: on the `no-holder` path the
		// expression is echoed straight from the caller's argument.
		if (target.expr !== undefined && target.expr !== target.sessionId) row.expr = wellFormedText(target.expr);
		if (target.busy !== undefined) row.busy = target.busy;
		rows.push(row);
	}
	// §10.1.2 体积纪律 for rows, not just for the body: the persisted card is
	// bounded, and the cut is stated with the two facts a renderer needs —
	// `shown` is the placeholder of the client's `sendRowsTruncated` wording
	// (「已截断——仅显示前 {shown} 行」), `total` is how many rows the delivery
	// really had, so the mark itself cannot understate the broadcast.
	const cut = rows.length > SEND_CARD_ROW_LIMIT;
	const targets = cut ? rows.slice(0, SEND_CARD_ROW_LIMIT) : rows;
	// §10.1.2: the envelope is present only when the caller actually gave one —
	// `meta: {}` (a legal no-op) renders no banner fields and so no envelope here.
	const hasMeta = request.meta !== null && request.meta !== undefined && Object.keys(request.meta).length > 0;
	return {
		kind: SEND_CARD_KIND,
		v: SEND_CARD_VERSION,
		at: request.at,
		senderSessionId: wellFormedText(request.senderSessionId),
		...(hasMeta ? { meta: sendCardEnvelope(request.meta) } : {}),
		message: request.message,
		targets,
		...(cut ? { targetsTruncated: { shown: SEND_CARD_ROW_LIMIT, total: rows.length } } : {}),
		summary,
		fanout: request.fanout === true,
	};
}

/**
 * Per-dispatch card, keyed by the frozen `exec.arguments` object the Tool
 * registry hands to BOTH `execute` and `output.presentationMeta` of one call
 * (`dsh-tools`: `tool.execute(exec.arguments, exec)` and later
 * `tool.output.presentationMeta(exec.arguments, value)`, same object identity).
 * A WeakMap rather than "the last card" so two concurrent sends always project
 * their own receipt and can never read each other's.
 */
const SEND_CARD_BY_ARGS = new WeakMap();

/**
 * `output` contract of `team_link_send`: byte-for-byte the {@link textOutput}
 * behavior for everything model-visible (same schema, same renderer), plus the
 * §10.1.2 structured receipt the core persists as `tool/result.meta` — durable,
 * so a replayed session log reproduces the same card without re-running the send.
 *
 * The projection returns the card the tool body stashed for THIS call. When
 * there is none — a call refused before the delivery stage (mutually exclusive
 * or missing address, invalid `meta`, no interactive agent), or an authored
 * result whose body never ran — it returns an empty object, which is not a card:
 * the client's shape reader rejects it and falls back to the model-visible text
 * (§10.1.5 降级优先) instead of inventing a receipt for a delivery that never
 * happened. Returning `undefined` is not an option: the registry treats it as a
 * non-lossless projection and fails the whole tool call.
 */
function sendOutput() {
	return {
		...textOutput(),
		presentationMeta: (args) => SEND_CARD_BY_ARGS.get(args) ?? {},
	};
}

// ---------------------------------------------------------------------------
// rotation: two-phase team hand-over (§3.6, M4)
// ---------------------------------------------------------------------------

/** Phase A token lifetime (§3.6.2): a prepared hand-over must be claimed inside
 * this window, otherwise the sweep cancels it and releases the team freeze. */
const ROTATION_TTL_MS = 30 * 60000;
/** Phase B provisional trust lifetime (§3.6.2 评审 #5): a migration granted
 * without a present user is revoked after this window unless ratified. */
const ROTATION_PROVISIONAL_TTL_MS = 24 * 3600000;
/** Anti-storm window of §3.6.2 (`rateLimit(team, role, 10min)`): one prepare per
 * team+role per window, counting a live pending AND a completed rotation. */
const ROTATION_RATE_LIMIT_MS = 10 * 60000;
/** How long the single rotation dialog waits for a present user before the claim
 * falls back to the unattended (provisional) path (§3.6.1 principle 4). */
const ROTATION_CONFIRM_TIMEOUT_MS = 180000;
/** The tool's closed `action` set (§3.6.2: exactly two phases). */
const ROTATION_ACTIONS = new Set(["prepare", "claim"]);
/** Display prefix of a masked token (§3.6.2 评审 #3 / M2 评审 #3). */
const ROTATION_TOKEN_LABEL = "tok-";
/** The history note a rolled-back provisional migration leaves behind. */
const ROTATION_PROVISIONAL_NOTE = "provisional 未批准过期";
/** The third rotation verdict (§3.6.2 评审 #5): a claim with no in-domain
 * candidate opens no dialog, so neither "已批准" (nobody was asked, nobody
 * approved) nor "待批准(24h)" (no provisional window exists) is true. */
const ROTATION_STATUS_NONE = "无待迁移对";
/** Question id of the rotation dialog — the answer is matched by id, not order. */
const ROTATION_DIALOG_ID = "rotation-migrate";
/**
 * Why the claim's dialog produced no answer (§3.6.1 principle 4). The four causes
 * all end in the SAME write — the unattended provisional migration — but they are
 * not the same story, and the caller's reading has to tell them apart:
 *
 * `unavailable` (no `userQuestions` service), `no-answer` (a service that returned
 * without this question) and `failed` (the dialog itself threw) keep the wording
 * they have always had. `timeout` is the real machine's shape (2026-09-20, the
 * v038d-probe hand-over): the caller's tool bridge aborted the waiting nested call
 * at ~120s, **the caller read only 「超时」**, and the rotation had in fact
 * committed. An aborted dialog is therefore classified as 「nobody answered」, never
 * as 「the dialog failed」 — and only that class gets the self-reporting reading
 * {@link unattendedClaimReading} builds, because only it is the shape that gets
 * mistaken for a failed call.
 */
const ROTATION_DIALOG_CAUSES = Object.freeze({
	UNAVAILABLE: "unavailable",
	NO_ANSWER: "no-answer",
	TIMEOUT: "timeout",
	FAILED: "failed",
});

/**
 * The second half of {@link ROTATION_DIALOG_CAUSES.TIMEOUT}'s classification: is
 * this dialog error the 「nobody answered」 class rather than a dialog that failed
 * on its own?
 *
 * `signal.aborted` is the authoritative half — the claim only ever aborts the
 * dialog when the CALLER's own signal aborted (it forwards `request.signal`), so
 * an aborted dialog means the caller stopped waiting. The error shape is the
 * second half: real bridges deliver `AbortError` / `ABORTED` (the 2026-09-20
 * machine's exact shape) and some deliver a timeout code instead.
 */
function dialogNoAnswerError(error, signal) {
	if (signal?.aborted === true) return true;
	const code = typeof error?.code === "string" ? error.code : typeof error?.cause?.code === "string" ? error.cause.code : "";
	if (/abort|timeout|etimedout/iu.test(code)) return true;
	const name = typeof error?.name === "string" ? error.name : "";
	return /aborterror|timeouterror/iu.test(name);
}

// ---------------------------------------------------------------------------
// §10.2 ② /team_session — one command, N worker root sessions, one roster write
// ---------------------------------------------------------------------------

/**
 * Slash-command name of §10.2.1 (without the leading slash). The command is
 * registered through the OPTIONAL ordered injection of the `commands` service
 * (§10.2.1): this plugin's module-level `inject` stays at its four entries, and
 * a shell without that service loads the plugin unchanged — minus this one
 * command — with a single warn line.
 */
const TEAM_SESSION_COMMAND = "team_session";
/** The one argument whose value runs to the end of the line (§10.2.4 grammar):
 * the parser needs the literal key to cut the captured text at the right place,
 * so the token is named once here instead of being spelled out in the parser. */
const TEAM_SESSION_TASK_KEY = "task=";
/** Every key the command grammar accepts (`count=`/`n=` and `role=`/`roles=` are
 * the two accepted aliases). The unknown-key refusal and the key test read this ONE
 * list, so the message can never advertise a key the parser does not accept. The
 * ORDER here is this array's own (aliases beside their canonical key); the hint below
 * is written out by hand and is NOT a rendering of this array — the two are kept in
 * step by the assertion on {@link TEAM_SESSION_KEY_HINT}, not by sharing a literal. */
const TEAM_SESSION_KEYS = ["n", "count", "team", "roles", "role", "task", "preset", "model"];
/** The one key list the unknown-key refusal prints — kept beside the list so the
 * message can never advertise a key the parser does not accept. Since §10.2.8.2 it
 * also announces the SHAPE those keys live in (a parameter area at the head of the
 * line, the body after it, no positional role names), because the refusals are the
 * only place a user who typed the abolished form ever sees the grammar. */
const TEAM_SESSION_KEY_HINT = "n / team / roles / preset / model / task（参数区只在行首，其后全部是正文 = 启动任务；位置角色名已废除，角色只能由 roles= 声明）";
/** R3's way out (§10.2.8.2): every parameter refusal ends with it. Under 方案 A the
 * thing the user probably wanted — writing the text directly — is the grammar's own
 * first-class path, so the refusal has to say so. */
const TEAM_SESSION_BODY_HINT = "想写正文就直接写（参数区结束后的全部文本就是启动任务）；也可以用 task= 给任务。";
/** How much of an offending token R3 echoes verbatim. A pasted document makes
 * tokens hundreds of code points long, and an echo that dwarfs its own message
 * helps nobody; a short offender (`n=abc`) comes back untouched. */
const TEAM_SESSION_OFFENDER_PREVIEW = 160;
/** §10.2.8.2's fallback for the DEFAULT team name — the only step of that default
 * which can fail (a workspace directory whose name is not `[a-z0-9-]+`). */
const TEAM_SESSION_DEFAULT_TEAM = "default";
/** §10.2.4 command syntax hard cap (N ≤ 8), a CODE CONSTANT on purpose: it is
 * the same bound the existing fan-out already taught the user (§3.4), and the
 * design deliberately keeps it out of the settings schema. */
const TEAM_SESSION_MAX_CREATES = 8;
/** §10.2.4 per-team member ceiling (≤ 24), also a code constant — the same
 * number the §10.1.2 receipt caps its rendered rows at. */
const TEAM_SESSION_MAX_MEMBERS = 24;
/** How long the one batch confirmation waits for a present user before the
 * command gives up and creates NOTHING (§10.2.4 / U16: 取消 → 零创建零 pairs). */
const TEAM_SESSION_CONFIRM_TIMEOUT_MS = 180000;
/** §10.2.8.4 (b): the confirmation dialog's HARD budget — CODE POINTS and NEWLINE
 * characters, both asserted by the suite. The numbers are a contract, and the crop
 * below is by paragraph ({@link teamSessionDialogText}): the dialog used to grow with
 * our own prose until the shell had to scroll it and the 「创建 / 取消」 row fell out of
 * the viewport (真机事实见 §10.2.8.0), so the budget is enforced rather than hoped for.
 * 「渲染高度不超视口」 itself stays a REAL-MACHINE item (it depends on the window width)
 * and is deliberately NOT asserted.
 *
 * 2026-09-22 裁定 A 之后这两条数**都不许动**（用户裁定里的「硬顶 600/12 与必备五件不变」）：
 * 收紧后的正文（六行 / 参照夹具 353 码点）离它们更远，而**可裁段为空** ⇒ `dialogFits` 在**任何
 * 路径上都不再被调用**（`optional` 恒为空 ⇒ 拟合循环与终态构造都不会走到它；它现在只是「某段自述
 * 回到框里」时的哨兵，见 {@link teamSessionDialogText} 的「可裁段现在是空的」一段）。 */
const TEAM_SESSION_DIALOG_MAX_CODE_POINTS = 600;
const TEAM_SESSION_DIALOG_MAX_NEWLINES = 12;
/** §10.2.8.4 修法表**第 0 行**的第二个预算：确认框 `question` 的**单行**上限（码点）。
 * 依据是壳的布局、不是偏好 —— `question` 被渲进**无高度钳制的 `<header><h2>`**（在滚动容器
 * **之外**），而 `detail` 在 `Mbwy4a_body{overflow-y:auto}` **之内**、底栏 `flex-shrink:0` 也在
 * 滚动区外 ⇒ 长 `question` 推出视野的正是底部的「创建 / 取消」（真机事实：§10.2.8.0 的 8 次
 * 够不着）。所以 question 只留一行话，披露正文整段进 detail。 */
const TEAM_SESSION_DIALOG_MAX_QUESTION_POINTS = 120;
/** §10.2.8.4 (b): session-list rows shown before 「…等 N 个」. The FULL count is always
 * stated — the U13/U14 bounded-presentation convention. */
const TEAM_SESSION_DIALOG_LIST_ROWS = 3;
/** §10.2.8.4 (b): 「**不逐角色展开**：只给 **id 形状 ＋ 计数**，全量清单进完成回报」.
 * This is the CONSTANT half of {@link teamSessionId}'s grammar — ONE stem for the whole
 * batch, so it costs the dialog the same few code points for EVERY input while still
 * telling the reader which ids the confirmation is about; the per-role id list itself is
 * the completion report's job (`command/done`). */
const TEAM_SESSION_ID_SHAPE = "team-link-<team>-<role>-<uuid8>";
/** §10.2.8.4 (a): how much of the startup task the dialog previews, in code points.
 * The preview line also carries the annotation that says the full text will be
 * delivered regardless ({@link teamSessionTaskNote}). */
const TEAM_SESSION_DIALOG_TASK_CHARS = 32;
/** Per-field caps for the values a user can make arbitrarily long: a team name is
 * `[a-z0-9-]+` with no length bound, a cwd is a path, a session id is opaque, and
 * `model=`/`provider=` are whatever the parser found before the first whitespace
 * ({@link TEAM_SESSION_MODEL_RE} only SHAPES `provider/model` — it does not bound
 * either half), and `preset=` is the same shape of input (the parser's assignment for it
 * only forbids a SECOND `preset=`; nothing bounds its length — §10.2.8.4 (b) 的
 * per-field 清单里它**有自己的一格**，不再复用角色的 8 码点，否则常见 preset id 会被截成
 * 认不出，而这一行是 §10.2.4 的必备披露；2026-09-22 第 2 轮评审 🔵#3). They are WHY the
 * required blocks fit the budget for the COMMON and the VERIFIED-EXTREME inputs — without
 * them 「不得压掉必备披露」 and a hard budget could not both hold. They are NOT a
 * 「fits for EVERY input」 guarantee: 最极端组合下必备块本身就超 600（见
 * {@link teamSessionDialogText} 的「不保证」一段与设计档 §10.2.8.4 的残余行 · 第一机制）。
 *
 * `title: 40` 这一格**当前没有取用点**：裁定 A 把「会话标题」自述段整段移出了框体（改由完成回报
 * 承载），而这一格是 §10.2.8.4 (b) 的 per-field 清单里**设计档点名的一格**（标题 40），所以它按
 * 「描述面与实现一致」的要求**留在表里但注明休眠**，而不是删掉 —— 一旦标题段回到框里，它立刻重新
 * 生效。其余的 key 都有自己的取用点。 */
const TEAM_SESSION_DIALOG_FIELD_CHARS = { team: 20, cwd: 24, id: 28, role: 8, skipped: 16, title: 40, model: 40, provider: 24, preset: 24 };
/** §10.2.8.7 裁定 2: the role-semantics line the DIALOG and the COMPLETION REPORT each
 * carry. It exists because the defect-③ dialog was unreadable, so the sentence that
 * answered 「为什么新会话显示是 worker」 was never seen; it is one line on purpose and
 * it is inside {@link TEAM_SESSION_DIALOG_MAX_CODE_POINTS}. */
const TEAM_SESSION_ROLE_GUIDANCE = "新会话是 worker；你自己（调用会话）是 coordinator；要交棒请用 team_link_rotate。";
/** Question id of the batch dialog — the answer is matched by id, not order. */
const TEAM_SESSION_DIALOG_ID = "team-session-batch";
/** The one option label that authorizes the batch (§10.3: 批量动作必须有一处人类确认). */
const TEAM_SESSION_CONFIRM_LABEL = "创建";
/** §10.2.6 orphan guard: how long a `pending-creates` intent may sit unresolved
 * before the startup sweep reports it as adoptable (the create crashed, or the
 * plugin was unloaded mid-loop). */
const TEAM_SESSION_PENDING_TTL_MS = 5 * 60000;
/** The `model` argument's grammar: `model=<provider>/<model>` or bare `model=<model>`. */
const TEAM_SESSION_MODEL_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.:-]+)$/u;
/** Session-id code points outside this class are dropped, so an id can never
 * carry a lone surrogate or a control character into the durable session id. */
const TEAM_SESSION_ID_ILLEGAL = /[^A-Za-z0-9_-]/gu;
/** Session-id suffix length (8 hex characters of one random UUID). */
const TEAM_SESSION_ID_SUFFIX = 8;

/**
 * Live §10.2 ② controller of each plugin context. `apply` is the only writer;
 * `host-half.test.mjs` reads it (through {@link __testing}) so the command's
 * per-context intent bookkeeping is reachable without poking closure state.
 */
const TEAM_SESSION_BY_CTX = new WeakMap();

/** One id accepted by `team:<name>/<role>` addressing and by a session id. */
function readTeamSessionRoleName(value) {
	return readRoleName(value);
}

/**
 * Parse the `/team_session` input grammar — §10.2.8.2 的方案 A「参数可省」，写成
 * R1/R2/R3 三条规则，读代码即可读出文法：
 *
 * `
 * /team_session [n=<1..8>] [team=<name>] [roles=<r1,r2,…>] [task=<任务>]
 *               [preset=<presetId>] [model=<provider>/<model>] [正文…]
 * `
 *
 * **R1 —— 参数区只在行首，且分区谓词是闭合的。** 从**第一个 token** 起，连续取「形状
 * 合法（含 `=` 且 label 非空）、key 已知、取值本地合法」的 token 作参数；结束条件恰
 * 有两类：
 *   - **(a) 静默结束**：token 不含 `=`，或 `=` 位于首字符（label 为空）⇒ 该 token 起
 *     **全部算正文**（这一支不报错，正文照收）；
 *   - **(b) 报错**：token 形状合法而 key 未知，或 key 已知而取值不合法（`n=abc`）⇒
 *     **整条命令拒绝**，并**原样回显 offender**（R3）。
 *
 * **R2 —— 正文不解析。** 进入正文后，任何「字母＋等号」（`N=3`、`pid=384448`、
 * `word=`）**一律当正文逐字保留**，永不作为参数。这正是 §10.2.8.1 的病灶：一具 3058
 * 字的交接正文里含 `同窗 N=3）。`，而旧实现在**整条输入**上做 token 扫描，把它读成
 * `n=3）。` 并在参数校验阶段就拒掉整条命令（连「角色名」那一步都没走到）。
 *
 * **R3 —— 失败必须点名。** 任何参数错误都**原样回显 offender**（如 `n=abc`）并给出出路
 * （{@link TEAM_SESSION_BODY_HINT}）。旧文案里那句提示「你把正文当成角色名了」随位置角色名
 * 废除而一并删除 —— 它在 R1 下已无触发条件（裸 token 现在是正文的起点）。
 *
 * **位置角色名废除（§10.2.8.2 的语义变更，必须显式宣布）**：裸 token（不含 `=`）
 * **不再被当作角色名**，而是**正文的起点**；声明角色的唯一拼法是 `roles=`（别名
 * `role=`）。旧读法会把一具正文里的 284 个裸 token 变成 284 个角色，再以「会话个数
 * 284 超过硬顶 8」失败（§10.2.8.1 的第二个雷）。
 *
 * **正文 = 启动任务**：参数区结束后的**全部正文就是**该次批量建队的启动任务，与
 * `task=` **同一个槽**；**两处同现 ⇒ 报错**（「任务只能给一处」）—— 否则同一批会话会在
 * 两种读法下拿到不同的任务。
 *
 * **`task=` 与参数区的复合**：`task=` 的取值**仍按既有 `taskBoundary` 规则吞到下一个
 * 已知 `key=`（或行尾）**，其多 token 的取值部分**不参与**参数区扫描 ⇒ `task=帮我做 X`
 * 既不会在 `X` 处结束参数区，也不与「正文与 `task=` 同现 ⇒ 报错」冲突。带引号的
 * `task=` 取值是**整个取值**：闭引号之后不许再有内容（否则那段文本会被静默丢掉）。
 *
 * **默认值**（方案 A 的必然结果）：`team` 省略 ⇒ 取**调用会话工作区目录名**
 * （{@link teamSessionDefaultTeam}：`basename(cwd)`，不合 `[a-z0-9-]+` 时回退
 * `default`）· `n` 省略 ⇒ `1`（给了 `roles=` 时 = 角色数）· `roles` 省略 ⇒ 1 个
 * worker（角色 `worker-1`）。
 *
 * `role=`/`roles=` 与 `count=`/`n=` 仍是同一批 key 的两个别名（人两种都写），带引号的
 * 取值照旧剥一层引号。每个畸形 token 都以自己的文案拒绝**整条**命令，所以下面的 plan
 * 只会从一份完全合法的请求上建出来。
 *
 * @returns `{ error }` 或 `{ value }` —— 解析后的请求（U16 的纯函数那一半），发生在任何
 *   plan / 对话框 / 写入之前。`value.task` 承载任务槽，无论它来自 `task=` 还是参数区
 *   之后的正文。
 */
function readTeamSessionCommand(rawInput) {
	const text = typeof rawInput === "string" ? rawInput : "";
	// `bare` is the ABOLISHED positional-role bucket (§10.2.8.2): it stays in the
	// shape, and it is always EMPTY — a bare token is the body's first token now. It
	// is kept (rather than deleted) so that 「nothing ever lands in the positional
	// bucket again」 is a checkable invariant instead of a removed field.
	const value = { n: undefined, team: undefined, roles: undefined, task: undefined, preset: undefined, model: undefined, provider: undefined, bare: [] };
	/**
	 * Remove ONE pair of quotes wrapping the whole VALUE and return the inside.
	 * The token's key is already off by then, so `team="t"` hands over `"t"` and
	 * gets `t` back. A value that is only half quoted — the closing quote and the
	 * opened one do not bracket the same text — reports `{ malformed: true }`, so
	 * the caller refuses instead of guessing where the value ends.
	 */
	const unwrapQuoted = (value) => {
		const quoted = /^(["'])([\s\S]*)\1$/u.exec(value);
		if (quoted !== null) return { text: quoted[2] };
		if (value.startsWith("\"") || value.startsWith("'") || value.endsWith("\"") || value.endsWith("'")) {
			return { malformed: true };
		}
		return { text: value };
	};
	// The one assignment path every key shares: the key owns every rule it has
	// (integer / role list / model split) and receives an ALREADY unwrapped value,
	// so there is exactly one place where quotes come off.
	const assign = (key, raw, label) => {
		if (raw === "") return `${label}= 后面缺少取值。`;
		if (key === "n" || key === "count") {
			if (!/^[0-9]+$/u.test(raw)) return `${label} 必须是整数（会话个数，1..${TEAM_SESSION_MAX_CREATES}）。`;
			value.n = Number(raw);
			return undefined;
		}
		if (key === "team") {
			if (value.team !== undefined) return `${label} 重复给了两次（team=… 只能出现一次）。`;
			value.team = raw;
			return undefined;
		}
		if (key === "task") {
			if (value.task !== undefined) return `${label} 重复给了两次（task=… 只能出现一次；按角色的任务写在同一个 task 里）。`;
			value.task = raw;
			return undefined;
		}
		if (key === "preset") {
			if (value.preset !== undefined) return `${label} 重复给了两次（preset=… 只能出现一次）。`;
			value.preset = raw;
			return undefined;
		}
		if (key === "model") {
			if (value.model !== undefined) return `${label} 重复给了两次（model=… 只能出现一次）。`;
			const matched = TEAM_SESSION_MODEL_RE.exec(raw);
			if (matched === null) {
				value.model = raw;
			} else {
				value.provider = matched[1];
				value.model = matched[2];
			}
			return undefined;
		}
		const roles = raw.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
		if (roles.length !== raw.split(",").length || roles.length === 0) return `${label} 需要形如 roles=<r1,r2,…> 的非空角色名列表。`;
		if (value.roles !== undefined) value.roles = [...value.roles, ...roles];
		else value.roles = roles;
		return undefined;
	};
	// The scanner keeps a quoted SEGMENT joined to its neighbours, because
	// `key="value"` must reach the parser as ONE token — a plain "quoted string is
	// its own token" reading splits it into `key=` and `"value"`, which both lose
	// the pairing and turn the trailing quote into a half-quote refusal. `task="a b"`
	// is the case this exists for; a whole quoted positional role name is no longer
	// a thing (R1(a) makes a bare token the body's first token), while a quoted
	// `roles="a,b"` still works. The alternation is wrapped in its OWN group on
	// purpose: without it the trailing `+` binds to the last branch only and
	// `team="t"` still splits in two.
	const RE = /(?:(?:[^\s"']+|"[^"]*"|'[^']*'))+/gu;
	/** Split an input into tokens with their offsets. The same scanner serves the
	 * whole line and — when an unquoted `task=` stops at a `key=` boundary — the tail
	 * after it, so both are read by one set of rules. */
	const tokensIn = (input) => {
		const found = [];
		for (let match = RE.exec(input); match !== null; match = RE.exec(input)) found.push({ token: match[0], index: match.index });
		return found;
	};
	const tokens = tokensIn(text);
	/** R3's echo of the offending token, bounded ({@link TEAM_SESSION_OFFENDER_PREVIEW}):
	 * a pasted document makes tokens hundreds of code points long, and an echo that
	 * dwarfs its own message is not a kindness. Short offenders (`n=abc`) come back
	 * verbatim. */
	const offender = (token) => preview(token, TEAM_SESSION_OFFENDER_PREVIEW);
	/** R1(b): a known key whose own value rule refused the value. */
	const refuseValue = (token, failure) => `参数 ${offender(token)} 不合法：${failure}（可用：${TEAM_SESSION_KEY_HINT}）。${TEAM_SESSION_BODY_HINT}`;
	/** R1(b): a token shaped like a parameter whose key the grammar does not know. */
	const refuseUnknown = (token) => `未知参数 ${offender(token)}（可用：${TEAM_SESSION_KEY_HINT}）。${TEAM_SESSION_BODY_HINT}`;
	// `task=` must be read from the RAW LINE and not from the token list: its value
	// is not one token, it is every remaining code point up to the next known
	// `key=` (or the end of the input) — the existing `taskBoundary` rule, kept
	// verbatim — so those value tokens are SKIPPED by the parameter scan below and
	// the argument is taken whole, quote stripping included.
	const taskAt = /(?:^|\s)task=/u.exec(text);
	const taskKeyAt = taskAt === null ? -1 : taskAt.index === 0 ? 0 : taskAt.index + 1;
	/** The boundary rule for an UNQUOTED task: the text runs until the first
	 * whitespace-separated token that opens a known `key=`. A word that merely
	 * contains an `=` (`a=b`) is content, so `fix the bug` has no boundary — the
	 * old reading cut it at the first space and lost `the`/`bug`; this one loses
	 * nothing and still honours the grammar's `task=… model=… preset=…` order,
	 * which the hint has always advertised. */
	const taskBoundary = (rest) => {
		const scan = /(?:^|\s)([A-Za-z]+)=/gu;
		for (let match = scan.exec(rest); match !== null; match = scan.exec(rest)) {
			if (match.index === 0) continue;
			if (TEAM_SESSION_KEYS.includes(match[1].toLowerCase())) return match.index;
		}
		return -1;
	};
	/**
	 * R1's inner step: read ONE token of the parameter area.
	 *
	 * @returns `{ body }` — R1(a): this token (and everything after it) is the body;
	 *   `{ error }` — R1(b): the whole command is refused, offender echoed;
	 *   `{}` — the token was a parameter and the area continues.
	 */
	const takeParam = (entry) => {
		const equals = entry.token.indexOf("=");
		// R1(a) — no `=`, or an empty label: the parameter area ends HERE and this
		// token opens the body. A leading `=` lands here too (its label is empty).
		if (equals <= 0) return { body: entry.index };
		const label = entry.token.slice(0, equals);
		const key = label.toLowerCase();
		// R1(b) — shaped like a parameter, but the key is unknown.
		if (!TEAM_SESSION_KEYS.includes(key)) return { error: refuseUnknown(entry.token) };
		// The VALUE is the quoted unit, so quotes come off here — before the key
		// sees it — and `team="t"` reads exactly like `team=t`.
		const given = unwrapQuoted(entry.token.slice(equals + 1));
		if (given.malformed === true) return { error: refuseValue(entry.token, `${label}= 的取值引号不配对（请把整个取值放进一对引号里）。`) };
		// R1(b) — the key is known and its OWN rule refused the value (`n=abc`).
		const failure = assign(key === "role" ? "roles" : key, given.text, label);
		if (failure !== undefined) return { error: refuseValue(entry.token, failure) };
		return {};
	};
	let bodyAt = -1;
	let cursor = 0;
	while (cursor < tokens.length) {
		const entry = tokens[cursor];
		if (entry.index !== taskKeyAt) {
			const step = takeParam(entry);
			if (step.error !== undefined) return { error: step.error };
			if (step.body !== undefined) {
				bodyAt = step.body;
				break;
			}
			cursor += 1;
			continue;
		}
		// ---- the `task=` parameter: its value is not one token (§10.2.8.2) --------
		const beside = text.slice(taskKeyAt + TEAM_SESSION_TASK_KEY.length);
		const quotedOpen = beside.startsWith("\"") ? "\"" : beside.startsWith("'") ? "'" : null;
		if (quotedOpen !== null) {
			// A quoted task ends at its CLOSING quote: the quoted span is the value
			// (spaces inside it are content), and nothing may follow it — text after
			// the closing quote would be silently lost, so it is refused instead.
			const close = beside.indexOf(quotedOpen, 1);
			const echo = TEAM_SESSION_TASK_KEY + offender(beside);
			if (close === -1) return { error: refuseValue(echo, `task= 的取值引号不配对（开引号 ${quotedOpen} 没有闭合）。`) };
			const rest = beside.slice(close + 1).trim();
			if (rest !== "") return { error: refuseValue(echo, `task= 的取值引号不成对：${preview(rest, 60)} 落在闭引号之后。请把整个任务文本放进一对引号里（task= 之后不能再写别的参数）。`) };
			const failure = assign("task", beside.slice(1, close), "task");
			if (failure !== undefined) return { error: refuseValue(echo, failure) };
			break;
		}
		// Unquoted: the value runs to the first recognized key= (or to the end of the
		// line), and the keys after that boundary are parsed by the SAME rules as the
		// rest of the line — a bare token there opens the body, which is exactly the
		// 「任务只能给一处」 refusal below.
		const boundary = taskBoundary(beside);
		const split = boundary === -1 ? { text: beside, tail: "" } : { text: beside.slice(0, boundary), tail: beside.slice(boundary + 1) };
		const failure = assign("task", split.text, "task");
		if (failure !== undefined) return { error: refuseValue(TEAM_SESSION_TASK_KEY + offender(beside), failure) };
		if (boundary === -1) break;
		const tailStart = taskKeyAt + TEAM_SESSION_TASK_KEY.length + boundary + 1;
		const next = tokens.findIndex((candidate) => candidate.index >= tailStart);
		if (next === -1) break;
		cursor = next;
	}
	if (bodyAt !== -1) {
		const body = text.slice(bodyAt);
		// 「任务只能给一处」: the parameter area carried a `task=` and then ended into a
		// body. Both are the SAME slot, so seating this batch would depend on which
		// reading won — refuse and name both halves instead.
		if (value.task !== undefined) {
			return { error: `任务只能给一处：参数里的 task= 与参数区之后的正文同时出现（正文 = 启动任务，与 task= 等价）。正文从「${preview(body, 60)}」开始 —— 请把任务只给一处再发：删掉 task=，让正文当启动任务；或用 task= 一次写全，参数区结束后不再写正文。` };
		}
		value.task = body;
	}
	return { value };
}

/**
 * §10.2.8.2's DEFAULT team name: the CALLING session's workspace directory name.
 * `basename(cwd)` is the only thing read here — not the whole path (a path is not a
 * team name) and never `process.cwd()` (this half runs in the host process, and the
 * fact we are after belongs to the caller's session).
 *
 * A directory name that is not a legal team name (`[a-z0-9-]+` — the same rule
 * {@link readTeamName} enforces, because a team name is a path segment of the
 * blackboard directory) falls back to `default` instead of being refused: the user
 * did not TYPE this value, so refusing the whole command over a directory name
 * would be refusing a decision they never made.
 */
function teamSessionDefaultTeam(cwd) {
	const base = typeof cwd === "string" ? path.basename(cwd.trim()) : "";
	return TEAM_NAME_RE.test(base) ? base : TEAM_SESSION_DEFAULT_TEAM;
}

/**
 * Turn a parsed request into the §10.2.4 plan — the counts, the ids and the
 * two constants that bound the batch. `existingRoles` is the team's current
 * roster (empty for a team that does not exist yet); a role already seated
 * there is SKIPPED (§10.2.6 idempotency), while a seated role's session still
 * survives the admission test — because a team that has already grown past the
 * ceiling must not be grown further by this command.
 *
 * @returns `{ error }` or `{ value: { team, roles, skipped, sessions, … } }`.
 */
function teamSessionPlan(request, existingRoles = [], now = Date.now(), uuid = () => randomUUID()) {
	const team = readTeamName(request.team);
	if (team.error !== undefined) return { error: `需要 team（团队名）：${team.error}` };
	const wanted = Array.isArray(request.roles) && request.roles.length > 0 ? request.roles : null;
	// §10.2.8.2's defaults, and they are what makes 方案 A「参数可省」 real: `n`
	// omitted ⇒ 1 when no `roles=` was given, else the number of roles; `roles`
	// omitted ⇒ one worker (the naming loop below supplies `worker-1`). A bare
	// `/team_session <正文>` therefore means ONE worker — the pre-§10.2.8 plan refused
	// that line with 「需要角色列表」, which is the shape §10.2.8.0 measured.
	const count = request.n === undefined ? (wanted === null ? 1 : wanted.length) : request.n;
	if (!Number.isInteger(count) || count < 1) return { error: `会话个数必须是正整数（n=1..${TEAM_SESSION_MAX_CREATES}）。` };
	if (count > TEAM_SESSION_MAX_CREATES) {
		return { error: `会话个数 ${count} 超过命令硬顶 N ≤ ${TEAM_SESSION_MAX_CREATES}（§10.2.4，代码常量——刻意不进 settings）。请分批建队，或先在团队里补角色再逐个 /team_session。` };
	}
	const names = [];
	for (let index = 0; index < count; index += 1) {
		const candidate = wanted === null || index >= wanted.length ? `worker-${index + 1}` : wanted[index];
		const role = readTeamSessionRoleName(candidate);
		if (role.error !== undefined) return { error: `角色名非法：${role.error}` };
		if (names.includes(role.value)) return { error: `角色名 ${role.value} 在本次命令里重复出现——会话 id 会撞车，请给每个 worker 一个不同角色名。` };
		names.push(role.value);
	}
	const seated = new Set(existingRoles.filter((entry) => typeof entry === "string" && entry !== ""));
	const skipped = names.filter((role) => seated.has(role));
	const creating = names.filter((role) => !seated.has(role));
	const members = seated.size + creating.length;
	if (members > TEAM_SESSION_MAX_MEMBERS) {
		return { error: `团队 ${team.value} 登记后的成员数将达 ${members}，超过每队成员上限 ${TEAM_SESSION_MAX_MEMBERS}（§10.2.4，代码常量）。本队当前已登记角色 ${seated.size} 个，本次还要新建 ${creating.length} 个。` };
	}
	const sessions = names.map((role, index) => ({
		role,
		index,
		skip: seated.has(role),
		sessionId: seated.has(role) ? undefined : teamSessionId(team.value, role, uuid),
	}));
	return {
		value: {
			team: team.value,
			count,
			names,
			skipped,
			creating,
			sessions,
			members,
			task: typeof request.task === "string" && request.task.trim() !== "" ? request.task.trim() : undefined,
			preset: typeof request.preset === "string" && request.preset.trim() !== "" ? request.preset.trim() : undefined,
			model: typeof request.model === "string" && request.model.trim() !== "" ? request.model.trim() : undefined,
			provider: typeof request.provider === "string" && request.provider.trim() !== "" ? request.provider.trim() : undefined,
			now,
		},
	};
}

/** One worker's session id (§10.2.2): `team-link-<team>-<role>-<uuid8>`, with
 * every code point outside the id alphabet dropped, and the same suffix length
 * for every id so two roles can never collide by truncation. */
function teamSessionId(team, role, uuid) {
	const stem = `team-link-${team}-${role}`.replace(TEAM_SESSION_ID_ILLEGAL, "-");
	const hex = String(uuid()).replace(/[^0-9a-f]/gu, "");
	return `${stem}-${(hex + "0".repeat(TEAM_SESSION_ID_SUFFIX)).slice(0, TEAM_SESSION_ID_SUFFIX)}`;
}

/** DEFECT-4 的标题分隔符。用 ` · `（空格 + U+00B7 + 空格）而不是 `-`：团队名与角色名
 * 本身都是 `[a-z0-9-]+`，用连字符会让「哪个是团队、哪个是角色」在肉眼上不可分。 */
const TEAM_SESSION_TITLE_SEPARATOR = " · ";
/** 回落到「会话 id 短前缀」时取多少个码点。够长到越过 `team-link-` 这段所有 id 共有的
 * 前缀、把 team/role 两段都带进来（`team-link-v038d-probe-worker-1` 就是 28 个），
 * 又不至于把整条 id 抄进侧边栏。 */
const TEAM_SESSION_TITLE_STEM_CHARS = 28;
/** 宿主标题的字节预算（缺口2 的边界就在这个数上）：`dsh-base` 随包发的那份
 * `cordis.patch.yml:60` 给 `dsh-session-title` 设的是 `maxTitleBytes: 80`，而它的
 * `normalizeSessionTitle` 只**保留能装进预算的最长码点前缀**（`lib/index.js:33-45`）——
 * **剪尾巴，不追加任何标记，也不拒绝**。所以 `teamSessionTitle` 必须自己把预算守住：
 * 派生值一旦超预算，被剪掉的就是排在最后的 role 段（见 {@link teamSessionTitle}）。
 * 预算是宿主的设置项、理论上可被改；我们守的是**它随包发的那个值**，并在派生时留下余量
 * 说明（超长团队段被截、role 段完整）——这比「把 role 交给上游去剪」可分辨得多。 */
const TEAM_SESSION_TITLE_MAX_BYTES = 80;
/** 被截的团队段的省略号标记。上游截断什么都不加（剪完就剪完），所以「这里被截过」这件事
 * 只能由我们自己说出来——否则两组标题的差别只剩肉眼要数到第 60 个字符的团队名前缀。 */
const TEAM_SESSION_TITLE_ELLIPSIS = "…";

/** 一个字符串的 UTF-8 字节数（上游的计量单位就是字节：`Buffer.byteLength(…, "utf8")`）。
 * 自己数而不是用 `Buffer`：这一层是纯字符串逻辑，不给自己加 Node 全局的依赖。 */
function utf8ByteLength(text) {
	let bytes = 0;
	for (const character of text) {
		const point = character.codePointAt(0);
		bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
	}
	return bytes;
}

/** 把 `text` 压进 `maxBytes`（UTF-8 字节）：装得下就**一个字节都不动**，装不下就留最长的
 * 码点前缀 + 省略号（绝不劈开一个码点）。装不下连省略号都放不住时返回空串——调用方据此
 * 决定整段要不要出现（{@link teamSessionTitle} 里团队段为空 ⇒ 只留 role 段）。 */
function truncateUtf8(text, maxBytes) {
	if (maxBytes <= 0) return "";
	if (utf8ByteLength(text) <= maxBytes) return text;
	const room = maxBytes - utf8ByteLength(TEAM_SESSION_TITLE_ELLIPSIS);
	if (room <= 0) return "";
	let used = 0;
	let out = "";
	for (const character of text) {
		const bytes = utf8ByteLength(character);
		if (used + bytes > room) break;
		out += character;
		used += bytes;
	}
	return `${out}${TEAM_SESSION_TITLE_ELLIPSIS}`;
}

/**
 * DEFECT-4（真机缺陷 #4）：新建会话的**可区分**默认标题。
 *
 * 真机现象（用户原话）：「可以看到新的会话，不过**会话名称都是 `dsh-session-link-pro`**」
 * ——编程创建出来的 worker **全部显示为工作区名**，在侧边栏里互相认不出来。根因是**我们
 * 刻意不设标题**，当时的理由是「命名是用户可见的交互决定，三个 worker 该叫什么？设计没给
 * 就不自造」。**这个判断是错的**：不设标题**不等于**不替用户决定——**默认值（工作区名）
 * 本身就是那个很糟的决定**。官方模板 `dsh-webhook` 的 `createWebhookSession` 第 8 步就是
 * 调 `ctx.sessionTitle` 的 `rename(handle.agent.session, resolved.title)`（`lib/index.js:119`）。
 *
 * 标题**只从已有的结构化信息**派生（不新造随机数、不读工作区名、不读 cwd）：
 *   ① team 与 role 都在 ⇒ `<team> · <role>`（例：`v038d-probe · worker-1`）；
 *   ② 只有 team ⇒ `<team>`；
 *   ③ 其余（含只有 role）⇒ 会话 id 的短前缀 —— **绝不回落成工作区名**：那正是本缺陷的
 *      现象本身，「回落到默认」不是「没做决定」。
 *
 * ② 的每个 `plan.sessions` 条目与 ③a 的单条 `entry` 形状相同，所以这一个函数同时服务
 * 两条路径、**只有一处调用点**（`createRootAgent`），且「同一批里不同 role ⇒ 标题两两
 * 不同」**由 team+role 唯一确定**，不靠调用点自律。分支 ②（只有 team）与 ③（id 前缀）
 * 今天两条路径都到不了——② 的 `plan.team` 是计划阶段校验过的必填项、③a 的 `teamName` /
 * `roleName` 也都必填——它们留着是因为「派生不出可区分的标题」必须有一个**如实**的分支
 * （且它绝不读工作区名），而不是一句静默的 `undefined`。
 *
 * @returns 标题字符串；连 id 都没有时 `undefined`（调用方按降级处理并留痕）。
 *
 * **边界（缺口2：预算由我们守，role 段不许被剪）**：标题的最终长度由**宿主的标题服务**
 * 决定（`maxTitleBytes: 80`，见 {@link TEAM_SESSION_TITLE_MAX_BYTES}），而团队名只受
 * `[a-z0-9-]+` 约束、**没有长度上限**（角色名上限 64 字符）。本函数此前把 `<team> · <role>`
 * 原样交出去，等于把超预算的那一份交给上游去**剪尾巴**——被剪掉的恰好是 role：
 * 修前实测一个 79 字节的团队名把同队两个 role 的标题都剪成 `…-then-some ` 这一模一样的
 * 前缀，可区分性在这一档整段失效。现在改为**团队段先截、role 段完整保留**：
 *   ① 团队段装得下（`≤ 80 - 分隔符字节 - role 字节`）⇒ 原样，一个字节都不动（短团队名的
 *      标题与修前逐字相同）；
 *   ② 装不下 ⇒ 留可辨识前缀 + `…`；连前缀都放不住才退成「只有 role 段」——**不是**退成
 *      工作区名，也不留一个空的 `<team> · `。
 * 于是「同队两个 role ⇒ 标题两两不同」在**任意**团队名长度下都成立，条件是 role 自己能装进
 * 预算（`role` 超过约 76 字节时任何方案都装不下它，那时我们仍会给出一个非空、以省略号结尾的
 * role 前缀——两个这样的 role 只有在它们的**前 ≤73 字节前缀**完全相同时才会同名，那是预算本身
 * 的边界，不是遗漏；同理，两个**不同团队**的同名 role 若团队名在前 ≤73 字节内完全相同，也会
 * 拿到同一个标题。本条不为此新增团队名的长度约束，那是接口变更）。
 */
function teamSessionTitle(plan, entry) {
	const team = typeof plan?.team === "string" ? plan.team.trim() : "";
	const role = typeof entry?.role === "string" ? entry.role.trim() : "";
	if (team !== "" && role !== "") {
		const room = TEAM_SESSION_TITLE_MAX_BYTES - utf8ByteLength(TEAM_SESSION_TITLE_SEPARATOR);
		const roleSegment = truncateUtf8(role, room);
		const teamSegment = truncateUtf8(team, room - utf8ByteLength(roleSegment));
		return teamSegment === "" ? roleSegment : `${teamSegment}${TEAM_SESSION_TITLE_SEPARATOR}${roleSegment}`;
	}
	if (team !== "") return truncateUtf8(team, TEAM_SESSION_TITLE_MAX_BYTES);
	const sessionId = typeof entry?.sessionId === "string" ? entry.sessionId : "";
	if (sessionId !== "") return truncateUtf8(sessionId.slice(0, TEAM_SESSION_TITLE_STEM_CHARS), TEAM_SESSION_TITLE_MAX_BYTES);
	return undefined;
}

/**
 * The one batch dialog of §10.2.4, in its required content: how many sessions,
 * which model/preset, which cwd, a conservative cost statement, and — because the
 * first inbound message of every new worker is delivered through §10.2.3's option
 * (i) preset pairing — the trust being granted. The pairing is never silent: it is
 * written here, in the dialog body, before it exists.
 *
 * §10.2.8.4 (缺陷③) rewrote HOW that content is rendered, not WHAT it says. The
 * dialog used to grow with our own prose until the shell had to scroll it and the
 * 「提交 / 跳过」 row fell out of the viewport (真机事实见 §10.2.8.0); the fix is a
 * HARD budget ({@link TEAM_SESSION_DIALOG_MAX_CODE_POINTS} /
 * {@link TEAM_SESSION_DIALOG_MAX_NEWLINES}) plus two bounded renderings:
 *   a. the task preview is annotated ({@link teamSessionTaskNote}) — 「共 N 字，
 *      此处仅显示前 M 字；完整正文会原样作为启动任务投递」 (截断那一支);
 *   b. the session list is capped at {@link TEAM_SESSION_DIALOG_LIST_ROWS} rows
 *      plus 「…等 N 个」, with the count stated once on the line (the U13/U14
 *      bounded-presentation convention).
 *
 * **2026-09-22 用户裁定 A（`docs/collab-enhancements-design-2026-09-19.md` §10.2.8.4 修法表 (c)
 * 行的「已裁」）—— 本函数的第二次收紧，判据是 U33c：**真机上这个框「有点大，文字也太多了，
 * 导致选项被积压」（同一输入的 `detail` 收前实测 **569 码点 / 10 行**；用户截图那次协调者 id 取满
 * 28 码点 ⇒ 585）。裁定 A 做了两件事：**压掉解释性括号与 § 号**（「（绕过发送方审批与接收方 ask
 * 两道门，§10.2.3 预置配对）」「（保守）」「未给 model=/provider ⇒ 两半都解析并带上宿主缺省模型
 * 选择」「不设标题时它们会全都显示为工作区名」…），以及**把「会话标题」自述段整段移出框体**（改由
 * 完成回报承载，见 handler 的「- 标题（DEFECT-4）：」一行）。九件必备事实因此落在**六行**里：
 *   ① 数量 ＋ 角色与 id 形状 · ② 模型/预设 ＋ cwd · ③ 启动任务 · ④ 角色指引 ·
 *   ⑤ 成本口径（有任务支含「按各自模型计费」）＋ 信任授予 · ⑥ 确认则。
 * **判据定档（2026-09-22 偏差修复轮，审计 DIVERGENCE #3 / #4 之后）**：**≤ 6 行（硬）且 ≤ 380 码点**
 * （此前写的是 ≤350 —— 它只对 12 码点参照成立，历史来源是那次本地复现）。参照夹具
 * （`/team_session 你是新的主管会话` ＋ 12 码点协调者 id）实测 **353 码点 / 6 行** ✓；同一夹具取满
 * 28 码点协调者 id（= 真机那次）**369 / 6 行** ✓。
 * **380 的来由**：本轮把有任务支成本行里被漏删的「**按各自模型计费**」**放回**（+8 码点 —— 它是成本
 * 口径的一部分：每队各按自己的模型计费）⇒ 上界由 **350 放宽到 380**。这是一次**有代价的放宽**，
 * 换的是**一条必备事实的回归**，不是「本来就 380」；34 码点的余量同时覆盖 12 与 28 码点两个参照
 * （353 / 369）以及把一处解释性文字加回时的变异读数（387 —— 仍 > 380，码点侧照样变红）。
 *
 * The crop is by PARAGRAPH and it is annotated, and it deliberately cannot touch
 * §10.2.4's mandatory disclosure (次数 / 模型 / cwd / 成本 / 配对授权文案) nor the
 * §10.2.8.7 role-guidance line: those blocks are 「required」 and every field inside
 * them is capped ({@link TEAM_SESSION_DIALOG_FIELD_CHARS}).
 *
 * **可裁段现在是空的（必须知道的一件事）**：裁定 A 移出去的那个「会话标题」块**正是**此前唯一的
 * `required: false` 段，所以 `optional` 从此恒为空、`dropped` 恒为 0 ⇒ {@link dialogFits} 与
 * {@link TEAM_SESSION_DIALOG_CROP_NOTE_TIERS} 这条**标注路径不再被触发**（代码按「不许动」原样
 * 保留，将来任何一段自述回到框里它会立刻重新生效）。后果如实记录在
 * `docs/verification-log.md` 与交付报告里：U33 (i)/(ii) 的「标注在场」两相已改成「必备 body 逐字
 * 交付、一字未裁」——那不是能力下降，而是**没有可裁的段**之后剩下的事实。
 *
 * **不保证（本注释此前写成「the required set fits for EVERY input」，实测已证伪）**：per-field
 * caps 让**常规与已验证的极端**装得下，**不是对任意输入成立的不变式**。2026-09-22 实测的最极端
 * 组合（20 字团队名 ＋ 8 个已登记角色 ＋ 300 字 `model=` ＋ 60 字 `preset=` ＋ 3000 字正文 ＋
 * 长 cwd ＋ 取满 28 码点的协调者 id）在**收紧后的这版正文**里是 **615 码点 > 600**（收紧前 693），
 * 而设计明令必备披露永不裁剪 ⇒ 那一档仍必然超额。这是设计档的**残余 / 待立项**
 * （`docs/collab-enhancements-design-2026-09-19.md` §10.2.8.4 的**残余行 · 第一机制**）：要真做到
 * 「任意输入」需要一个**裁剪必备块的机制**，本批**不做**。
 *
 * DEFECT-1: the preset slot is named on EVERY path. Before the fix a missing
 * `preset=` meant 「没有任何预设」, which the dialog rendered as nothing at all; now it
 * means the host's DEFAULT preset, resolved and mounted (§10.2.2), so the body says
 * which one the boxes will get.
 *
 * §10.2.8.2 默认值第 4 条 (同支纪律, 2026-09-22 第 2 轮评审 🟡#1): EVERY line about what the
 * batch will DO follows that rule's own branch — the cost line included. The no-task shape
 * must not say 「followup 驱动一次」 (read next to 「不投启动任务」 it claims a dispatch that
 * will not happen); the task shape keeps the original wording verbatim.
 *
 * DEFECT-3 收尾 (裁定 2): the model slot says the same. It used to read 「（本会话默认）」
 * whenever `model=` was absent — the wording of a judgement that the real machine has
 * since refuted (an agent created without `agentOptions` never reaches the host's own
 * default), and it is also false for the half-route caller. Every shape now names what
 * will really be written ({@link teamSessionModelLine}).
 */
function teamSessionDialogText(plan, cwd, coordinatorId) {
	const cap = TEAM_SESSION_DIALOG_FIELD_CHARS;
	const roles = plan.sessions.map((entry) => `${dialogField(entry.role, cap.role)}${entry.skip ? "（已登记，跳过）" : ""}`);
	const shown = roles.slice(0, TEAM_SESSION_DIALOG_LIST_ROWS);
	const hidden = roles.length - shown.length;
	const skippedNote = plan.skipped.length === 0 ? "" : `（${plan.skipped.length} 个角色已登记，跳过：${dialogField(plan.skipped.join("、"), cap.skipped)}）`;
	// §10.2.8.7 裁定 2: the role-semantics line stays a line of its OWN (「各加一行」 in both
	// the dialog and the completion report), so it is never merged with another fact.
	// 两支都写**成本口径**：有任务支原来那句里的「按各自模型计费」在 2026-09-22 裁定 A 落码时被
	// 一并删掉，而它不在裁定清单里（属**未经申报的删事实**：每队各按自己的模型计费是成本口径的一部分）
	// ⇒ 2026-09-22 偏差修复轮（独立发散审计 DIVERGENCE #4）**放回**，代价 **+8 码点**（判据随之由
	// ≤350 放宽到 ≤380，见 {@link teamSessionDialogText} 的「判据定档」一段）。
	const costLine = plan.task === undefined
		? "成本：本次 0 次驱动（未给正文/task=，不投启动任务；后续派活时按各自模型计费）"
		: `成本：${plan.creating.length} 个会话 × 至少一个完整回合（followup 驱动一次，按各自模型计费）`;
	const trustLine = `信任授予：与主会话 ${dialogField(coordinatorId ?? "（当前会话）", cap.id)} 建立双向免确认 pairs 配对。`;
	// 模型/预设那一格：**两个槽都取宿主缺省**时合并成一句话 —— 原来把「宿主缺省」写了两次
	// （`宿主缺省 · preset=宿主缺省`），同一件事说两遍正是裁定 A 要压掉的那种字数；两个槽仍然
	// 都被点名（标签就是「模型/预设」），所以 DEFECT-1 的「preset 槽在任何一条路上都被说出来」不变。
	const modelPreset = plan.provider === undefined && plan.model === undefined && plan.preset === undefined
		? "宿主缺省"
		: `${teamSessionModelLine(plan)} · preset=${plan.preset === undefined ? "宿主缺省" : dialogField(plan.preset, cap.preset)}`;
	// 计数**只写一遍**：全部角色都在这一行列出来时（`hidden === 0`），「将创建 N 个」本身就是那个数；
	// 只有在角色被有界呈现截掉时（`hidden > 0`）才另写「共 N 个」，否则同一行里同一个数字写两遍。
	const idShapeNote = hidden > 0
		? `（共 ${roles.length} 个，仅列前 ${shown.length} 个 · id 形状 ${TEAM_SESSION_ID_SHAPE}）`
		: `（id 形状 ${TEAM_SESSION_ID_SHAPE}）`;
	const blocks = [
		// ---- §10.2.4 的必备披露 —— 永不裁剪 --------------------------------------
		// 2026-09-22 用户裁定 A（设计档 §10.2.8.4 修法表 (c) 行的「已裁」）：真机上这个框
		// 「有点大，文字也太多了，导致选项被积压」，所以解释性括号与 § 号一律压掉，并把
		// 「会话标题」自述段**整段移出框体**（改由完成回报承载，见 handler 的
		// 「- 标题（DEFECT-4）：」一行 —— 那条读数一个字都没少）。九件必备事实自此落在**六行**
		// 里，每一行都是一件事实（或与之同族的第二件）：
		//   ① 数量 ＋ 角色与 id 形状 · ② 模型/预设 ＋ cwd · ③ 启动任务 · ④ 角色指引 ·
		//   ⑤ 成本口径 ＋ 信任授予 · ⑥ 确认则。
		// 参照夹具（`/team_session 你是新的主管会话` ＋ 12 码点协调者 id）的判据是 **≤6 行且
		// ≤380 码点**（改前 569 码点 / 10 行；实测 353，id 取满 28 码点那一具 369）—— 由 host-half
		// 的 U33c 双相断言咬住（把删掉的解释性文字加回一处 ⇒ 码点侧变红）。380 的来由见本函数顶部的
		// 「判据定档」一段：350 放宽 +30，换的是「按各自模型计费」那条事实的放回。
		{ required: true, text: `将创建 ${plan.creating.length} 个 worker 根会话并登记进团队 ${dialogField(plan.team, cap.team)}${skippedNote}${idShapeNote}：${shown.join("；")}${hidden > 0 ? `；…等 ${roles.length} 个` : ""}。` },
		{ required: true, text: `- 模型/预设：${modelPreset}；cwd：${dialogField(cwd, cap.cwd)}` },
		{ required: true, text: `- 启动任务：${teamSessionTaskNote(plan.task)}` },
		// §10.2.8.7 裁定 2: one line of its own, and it is inside the budget below.
		{ required: true, text: TEAM_SESSION_ROLE_GUIDANCE },
		// §10.2.8.2 默认值第 4 条下的**同支纪律**（2026-09-22 第 2 轮评审 🟡#1）：这一行与下一行
		// 「确认则」走**同一条支** —— 无任务支不得说「followup 驱动一次」（同一张框里那句话会被读成
		// 「已经派活了」，与「不投启动任务」自相矛盾），有任务支保留原意。U30 的措辞断言同时咬这一行。
		{ required: true, text: `${costLine}；${trustLine}` },
		// §10.2.8.2 默认值第 4 条: 既无正文也无 `task=` ⇒ 只建会话、**不投启动任务** —— the
		// authorization line describes the batch that will actually run, so it names this
		// shape too (the confirmation is the human's only view of it).
		{ required: true, text: plan.task === undefined
			? `确认则：创建 → 登记 roster 与 pairs（本次未给正文/task=，不投启动任务）；取消则零创建、零 pairs。`
			: `确认则：创建 → 投递启动任务 → 登记 roster 与 pairs；取消则零创建、零 pairs。` },
	];
	/** The blocks of one candidate body, joined the way the dialog renders them. */
	const priced = (list) => list.map((block) => block.text).join("\n");
	/** §10.2.8.4 (b) 的**终态构造 —— 拟合循环与终态走的就是这个函数**：`priced(list)` 是正文，
	 * 标注（`stillDropped > 0` 时）永远**另起一行**追加，且**取第一个装得进 `dialogFits` 的档**
	 * （两档一起查，码点与换行同判）。两档都装不下时交付**最小档** —— 那是机制一的残余
	 * （必备 body 自超），不是把标注省掉。装进 `dialogFits` 的那一条**已经含标注**，所以
	 * 「装得下」这句话说的是**交付串**，不是标价前的正文。
	 * `stillDropped <= 0` ⇒ 什么都没省略 ⇒ 不贴标注（这也是「可选段全装下」那一支）。 */
	const candidate = (list, stillDropped) => {
		const body = priced(list);
		if (stillDropped <= 0) return body;
		const notes = TEAM_SESSION_DIALOG_CROP_NOTE_TIERS.map((tier) => `${body}\n${teamSessionDialogCropNote(stillDropped, tier)}`);
		return notes.find((note) => dialogFits(note)) ?? notes[notes.length - 1];
	};
	let kept = blocks.filter((block) => block.required);
	const optional = blocks.filter((block) => !block.required);
	let dropped = optional.length;
	for (const block of optional) {
		if (dialogFits(candidate([...kept, block], dropped - 1))) {
			kept.push(block);
			dropped -= 1;
		}
	}
	// §10.2.8.4 (b): the terminal string goes through the SAME construction as the fit
	// loop above — including the final budget decision inside it — so what the shell
	// receives is what was measured. (The defect this replaces appended the note AFTER
	// the loop and never re-checked it, so a legal body of 592 shipped as 634.)
	const text = candidate(kept, dropped);
	return wellFormed(text);
}

/**
 * §10.2.8.4 修法表**第 0 行**（首要、结构性）：确认框的 `question` **只放一行话**，披露正文
 * （{@link teamSessionDialogText} 的产物）整段移进 `detail`。
 *
 * 依据是壳的布局，逐条可复核（dsh-client-ui-user-questions/lib/client.js）：
 *   - `question` → `<header><h2 class=…title>`（:601-612），header 是 `flex-shrink:0`、
 *     **在滚动容器之外**，且**没有任何高度钳制** ⇒ 正文多长，header 就多高；
 *   - `detail` → `div.Mbwy4a_body[data-question-scroll]`（:636-644），其 CSS 是
 *     `overflow-y:auto`（:334 的 `.Mbwy4a_body`）⇒ 正文在**滚动区之内**；
 *   - 底栏 `footer` 是 `flex-shrink:0` 且在滚动区外，而卡片本身 `overflow:hidden` ⇒
 *     被撑出去的 header 会把「创建 / 取消」挤出卡片（真机读数：8 次够不着，§10.2.8.0）。
 * 换槽位之后，**动作可达性与文本长度脱钩**：正文再长也只是滚动区变长。
 *
 * 「单行 ＋ ≤ {@link TEAM_SESSION_DIALOG_MAX_QUESTION_POINTS} 码点」由 {@link dialogField}
 * **结构性**保证（它先把空白 run 压成一个空格再截断），所以这不是「写的时候注意一下」，
 * 而是这个字符串**不可能**违反的形状。
 */
function teamSessionDialogQuestion(plan) {
	const cap = TEAM_SESSION_DIALOG_FIELD_CHARS;
	return dialogField(`确认创建 ${plan.creating.length} 个 worker 会话并登记进团队 ${dialogField(plan.team, cap.team)}？`, TEAM_SESSION_DIALOG_MAX_QUESTION_POINTS);
}

/** Code points of `text` — never UTF-16 units, because a cut must not split a
 * surrogate pair (the same rule {@link preview} and {@link truncate} follow). */
function dialogCodePoints(text) {
	return [...String(text ?? "")].length;
}

/** `text` with every whitespace run collapsed to one space: the dialog's fields are
 * ONE line each, so a pasted document's newlines cannot spend the newline budget. */
function dialogFlatten(text) {
	return String(text ?? "").replace(/\s+/gu, " ").trim();
}

/** A dialog field: flattened, then cut to `limit` code points with an ellipsis. */
function dialogField(text, limit) {
	const flat = dialogFlatten(text);
	const chars = [...flat];
	return chars.length <= limit ? flat : `${chars.slice(0, limit - 1).join("")}…`;
}

/** §10.2.8.4 (b): BOTH budgets, in one predicate — code points and newlines. */
function dialogFits(text) {
	return dialogCodePoints(text) <= TEAM_SESSION_DIALOG_MAX_CODE_POINTS && (String(text).match(/\n/gu) ?? []).length <= TEAM_SESSION_DIALOG_MAX_NEWLINES;
}

/** §10.2.8.4 (b) 的**标注档位**（2026-09-22 会诊 #68 裁定）：标注行**参与** 600/12 预算，所以它
 * 必须在两个长度之间**自适应**。两个模板都是**具名常量**，长度按**实际 `dropped` 的位数**算出来
 * （数字写进句子：`dropped` 到两位数时每档再 +1 码点），代码里没有写死的 21／11：
 *   - 全档 {@link TEAM_SESSION_DIALOG_CROP_NOTE_FULL} `（已省略 N 段自述；必备披露一字未少。）`
 *     —— N 为一位数时 **21 码点**；
 *   - 最小档 {@link TEAM_SESSION_DIALOG_CROP_NOTE_MINIMAL} `（已省略 N 段自述）` —— N 为一位数时
 *     **11 码点**。
 * 两档都**不说**「已裁剪至 600 码点 / 12 行上限」：交付串可能正是超 600 的那一条，那句话会
 * **自证矛盾**（本批的病灶之一，见 {@link teamSessionDialogText}）。 */
const TEAM_SESSION_DIALOG_CROP_NOTE_FULL = (dropped) => `（已省略 ${dropped} 段自述；必备披露一字未少。）`;
const TEAM_SESSION_DIALOG_CROP_NOTE_MINIMAL = (dropped) => `（已省略 ${dropped} 段自述）`;
/** 档位按**从宽到窄**排列：{@link teamSessionDialogText} 的终态构造取**第一个**装得进
 * `dialogFits` 的档；两档都装不下时交付**最后（最窄）那一档** —— 那是「如实标注的受限超额」，
 * 只能由**不可裁的必备 body** 引起（机制一残余，见设计档 §10.2.8.4 的残余行）。
 *
 * **触发面为空（2026-09-22 裁定 A，逐条可复核）**：这两档只在 `dropped > 0` 时被取用，而裁定 A
 * 把框里唯一的 `required: false` 段（「会话标题」）整段移了出去 ⇒ 现在没有任何一条路径会取用它们。
 * 用户裁定里的「不许动：…两档标注与终态预算机制」按**代码原样保留**执行（不改一个字符），并且
 * 它们在 `host-half.test.mjs` 里仍有一份**纯函数**判据（档位常量各自的长度与「不含自证矛盾句」）；
 * 一旦某段自述回到框里，取用路径立刻恢复。 */
const TEAM_SESSION_DIALOG_CROP_NOTE_TIERS = [TEAM_SESSION_DIALOG_CROP_NOTE_FULL, TEAM_SESSION_DIALOG_CROP_NOTE_MINIMAL];

/** One tier of the crop annotation (§10.2.8.4 (b): 超出即按段落裁剪并标注). It names what was
 * kept, so a reader of a cropped box knows the disclosure is intact — and its length is a
 * function of the ACTUAL `dropped` count rather than a constant. */
function teamSessionDialogCropNote(dropped, tier = TEAM_SESSION_DIALOG_CROP_NOTE_FULL) {
	return tier(dropped);
}

/**
 * §10.2.8.4 (a): the task preview WITH its honesty annotation. {@link preview}
 * alone only cut the text and appended 「…」 — the repository's own rule is 「截断必须
 * 标注」 (U13/U14 的 targetsTruncated{shown,total}), and without it a truncated task
 * reads like the whole task. The numbers are CODE POINTS of the ORIGINAL text, and
 * the preview itself is flattened, so the annotation is also where a reader learns
 * the preview is single-line.
 *
 * 裁定 A 的两处：① 没被截断的那一支只写「共 N 字：<全文>」—— 原来那句「完整正文会原样作为
 * 启动任务投递」在**没有东西被截**的时候是在重复它自己已经显示出来的内容；② 被截断的那一支
 * **一字未少**（「共 N 字 / 此处仅显示前 M 字（单行）/ 完整正文会原样作为启动任务投递」），因为
 * 那三个数正是 U33 (a) 要求写出来的东西。
 */
function teamSessionTaskNote(task) {
	if (typeof task !== "string" || task.trim() === "") return "（未给正文/task=，只建会话、不投启动任务）";
	const total = dialogCodePoints(task);
	const shown = dialogField(task, TEAM_SESSION_DIALOG_TASK_CHARS);
	// 裁定 A：**没被截断**时不写那句「完整正文会原样作为启动任务投递」—— 它就是被显示出来的东西，
	// 再说一遍是废话；「共 N 字」照留（U33 (a) 的标注在**截断**那一支一字未少）。
	return total <= TEAM_SESSION_DIALOG_TASK_CHARS
		? `共 ${total} 字：${shown}`
		: `共 ${total} 字，此处仅显示前 ${TEAM_SESSION_DIALOG_TASK_CHARS} 字（单行）；完整正文会原样作为启动任务投递：${shown}`;
}


/**
 * The dialog's model slot (裁定 2), in the three shapes the create path really
 * resolves — 两侧都给、只给一半、两侧都没给 (§10.2.2 模板第 ④ 步 /
 * {@link resolveTeamSessionModelSelection}). It replaced 「（本会话默认）」, which was the
 * wording of a judgement the real machine has refuted (DEFECT-3: an agent created by
 * `agents.create` without `agentOptions` never reaches the host's own default) and which
 * was false for the half-route caller as well. The dialog authorizes a batch, so it must
 * describe what the new sessions will actually be given — the resolved pair is not
 * knowable here (the service is asked inside the create path), so the sentence names the
 * RESOLUTION, not a value it cannot read yet.
 *
 * 裁定 2 的判据（三个形状**各自如实**、且不出现被真机推翻的「本会话默认」）在裁定 A 之下**原样
 * 成立**，变的只是措辞的松紧：三种形状现在分别读作 `宿主缺省`（两侧都没给）/
 * `model=<m>（provider 取宿主缺省）`（只给一半，**点名缺的是哪一半**）/
 * `model=<m>（provider=<p>）`（两侧都给，**一个字都不提缺省解析**，因为那条路根本不问服务）。
 * 裁定 A 点名的教学式说明（`未给 model=/provider ⇒ 两半都解析并带上宿主缺省模型选择`）已按裁定
 * 压掉；「宿主缺省」四个字说的正是实现真正会做的事（见下）。
 *
 * §10.2.8.4 (b) 的**硬预算**同批覆盖这两个取值：`model=` / `provider=` 是**用户可任意长**的字段
 * （解析器只定形状、不定长度），所以它们和团队名 / cwd / 会话 id 一样走
 * {@link TEAM_SESSION_DIALOG_FIELD_CHARS} 的逐字段封顶 —— 否则一句 `model=<300 字>` 就能顶破 600
 * 码点，而「必备披露装得下**每一个**输入」正是那组封顶存在的理由。
 */
function teamSessionModelLine(plan) {
	const cap = TEAM_SESSION_DIALOG_FIELD_CHARS;
	if (plan.provider !== undefined && plan.model !== undefined) return `model=${dialogField(plan.model, cap.model)}（provider=${dialogField(plan.provider, cap.provider)}）`;
	// 裁定 A：两侧都没给 ⇒ 只留「宿主缺省」四个字（原来那句「未给 model=/provider ⇒ 两半都解析
	// 并带上宿主缺省模型选择」是用户点名要压掉的教学式说明）。**事实一件不少**：它说的正是实现
	// 真正会做的事 —— {@link resolveTeamSessionModelSelection} 会问宿主缺省读数并把解析结果当作
	// `agentOptions` 写进去（DEFECT-3 的裁决：新会话拿的不是调用会话的默认，而是宿主的缺省，
	// 所以这里既不写「本会话默认」，也不写「没有任何模型」）。它与同一行 `preset=宿主缺省` 同形。
	if (plan.provider === undefined && plan.model === undefined) return "宿主缺省";
	// 只给一半：点名**缺的是哪一半**（裁定 2 的判据），并把补齐的来路留在同一句里。
	return plan.model === undefined
		? `provider=${dialogField(plan.provider, cap.provider)}（model 取宿主缺省）`
		: `model=${dialogField(plan.model, cap.model)}（provider 取宿主缺省）`;
}

/**
 * The pairs patch of §10.2.3 (i): one record per newly created worker, each a
 * TWO-WAY pairing with the coordinator. `pairBetween` is the same predicate the
 * send path uses, so a channel the store already holds is not duplicated.
 */
function withTeamSessionPairs(view, coordinatorId, workerIds, now) {
	const pairs = [...view.pairs];
	let added = 0;
	for (const workerId of workerIds) {
		// `pairBetween` answers a BOOLEAN (the record-returning sibling is
		// `pairRecordBetween`): a truthiness test is the right one here, and the
		// first draft's `!== null` compiled, ran and silently granted nothing.
		if (pairBetween(view, coordinatorId, workerId, now)) continue;
		// The patch is normalized before it leaves, for the same reason the M4
		// rotation writes its grants through `normalizePolicy`: the store must hand
		// back the SHAPE it produces itself, so a row is written with every declared
		// field present (`provisional` / `expiresAt`) and a later read cannot depend
		// on a default the schema happens to supply. (This is about canonical shape,
		// not about stripping — `schemastery` keeps undeclared keys; 差异审计 B5.)
		// The grant is an ordinary, ratified channel — never a provisional one — and
		// it says so in the record.
		pairs.push({ a: coordinatorId, b: workerId, createdAt: now, provisional: false, expiresAt: 0 });
		added += 1;
	}
	return { pairs: added === 0 ? view.pairs : pairs, added };
}

/** One role row of the batch registration, in the canonical {@link roleRecord}
 * field order the roster round-trips through settings. */
function teamSessionRoleRow(role, sessionId, now, note) {
	return roleRecord({
		role,
		current: sessionId,
		history: [{ session: sessionId, from: now, until: null, note }],
	});
}

/**
 * The §10.2.3 kickoff task: the worker's role, the team it belongs to, the one
 * task, and HOW to report back. "服从" is stated here and in the roster write
 * policy — never in lineage (§10.2.7): the message is the only place a created
 * session learns who it answers to.
 */
function teamSessionKickoffText(plan, role, cwd) {
	// §10.2.8.6（2026-09-22 第 2 轮评审 🔵#2）：下面 `perRole === undefined` 那一支对
	// `/team_session` **不可达** —— 唯一的驱动路径在 drive 循环处就按
	// `plan.task === undefined ? [] : created` 把无任务那一支整个挡掉了（as-of 本次提交
	// `lib/index.js:5122`），所以这条命令**只会**在有任务时调用本函数。保住这一支不是
	// 漏掉的死码清理，而是**防御**：将来若再加一条驱动路径（或有人挪走/放宽那道守卫），少了这一行
	// 就会让 kickoff 静默丢掉「任务」行。注意本函数另有导出面
	// （`__testing.teamSessionKickoffText`，as-of `:8915`）**不经那道守卫**，仅供测试读数。
	const perRole = plan.task === undefined ? undefined : teamSessionRoleTask(plan.task, role);
	return wellFormed([
		`你是团队 ${plan.team} 的 ${role}（worker 根会话，由主会话 ${plan.coordinatorId ?? "（未知）"} 通过 /team_session 创建）。`,
		"",
		`- 工作目录（cwd）：${cwd}`,
		perRole === undefined ? "- 任务：见下方（本次命令没有给出 task=，请等待主会话派活）" : `- 任务：${perRole}`,
		"",
		`汇报与协作：用 team_link_send 把结果发回主会话 ${plan.coordinatorId ?? "（未知）"}（本命令已为你们建立 pairs 双向免确认通道，投递不再弹确认框）；团队约定与裁决用 team_link_team_read 读、team_link_team_append 写（本会话已登记为团队 ${plan.team} 的角色 ${role}）。`,
		"完成或遇到阻塞时，请明确回报：结论 / 证据 / 下一步。不要静默等待。",
	].join("\n"));
}

/** A task string that names per-role tasks as `<role>:<task>` separated by `|`;
 * a string that names none applies to every worker verbatim. */
function teamSessionRoleTask(task, role) {
	if (!task.includes("|")) return task;
	for (const part of task.split("|")) {
		const trimmed = part.trim();
		const colon = trimmed.indexOf(":");
		const halfwidth = trimmed.indexOf("：");
		const boundary = colon === -1 ? halfwidth : halfwidth === -1 ? colon : Math.min(colon, halfwidth);
		if (boundary <= 0) continue;
		if (trimmed.slice(0, boundary).trim() === role) return trimmed.slice(boundary + 1).trim();
	}
	return task;
}

/** Every worker that came back from a create, in creation order. */
function createdTeamSessionRoles(results) {
	return results.filter((entry) => entry.ok && !entry.skipped);
}

/**
 * §10.2.5 lifetime: the batch controller is built once per plugin activation
 * and handed to the command handler.
 *
 * - `rootCtx` is the PLUGIN's own context — the one whose fiber owns every
 *   `AgentHandle` this command creates. Creating from the temporary context of
 *   one command handler would tie the new agents to a fiber that is torn down
 *   the moment the handler returns (会诊 G14①), so the handler never calls
 *   `ctx.agents.create` itself; it calls {@link TeamSessionController.createAll}.
 * - `handles` is the plugin-held registry of those handles, so the ownership
 *   claim is an inspectable fact (U18) rather than a comment.
 * - `pending` mirrors the durable `pending-creates` intents of the policy store
 *   for this activation, so a create that never settled can be reported.
 */
function createTeamSession(rootCtx) {
	const handles = new Map();
	const pending = new Map();
	return {
		rootCtx,
		handles,
		pending,
		hasHandle: (sessionId) => handles.has(sessionId),
		handleFor: (sessionId) => handles.get(sessionId),
	};
}

/** The optional model-selection hook, same shape as the `dsh-webhook` template:
 * apply the creation-time selection until the session's first durable request
 * header exists. Absent provider/model (or an agent context without the event
 * API) leaves the agent on its inherited selection.
 *
 * DEFECT-3 之后，这条 early-return 只是**防御**：无论调用方给了几半（两侧都没给 / 只给
 * 一半），解析出来的都是一对真实的 provider/model（见
 * {@link resolveTeamSessionModelSelection}），所以本模块造出来的 agent 永远带着一个
 * 模型选择——这正是 `{{model}}` 那个变量的值。 */
function installTeamSessionModelSelection(agentCtx, selection) {
	if (typeof agentCtx?.on !== "function") return;
	if (typeof selection?.provider !== "string" || typeof selection?.model !== "string") return;
	agentCtx.on("agent/request", async ({ agent }, next) => {
		const resolved = await next();
		if (agent.session.requestHeader() !== undefined || resolved.provider !== selection.provider || resolved.model !== selection.model) return resolved;
		const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved;
		return { ...withoutInheritedEffort, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) };
	});
}

/** One line per dial rejection, in the §10.2.4 plan's own terms. */
function teamSessionNoConfirmText(plan, reason) {
	return `未创建任何会话（${reason}）。本次零创建、零 pairs；团队 ${plan.team} 与 roster 未改动。`;
}

/**
 * The single batch dialog of §10.2.4. Fail-closed on every path that is not an
 * explicit 「创建」 answer: no confirmation service, a thrown ask, or the
 * 3-minute wait — that is what makes 取消 → 零创建零 pairs a structural
 * property (U16) rather than a check the caller remembers.
 *
 * §10.2.8.4 第 0 行（换槽位）：`text` 是**披露正文**（{@link teamSessionDialogText} 的产物），
 * 它落在 `detail` 上 —— 壳把 `detail` 渲进滚动区 `Mbwy4a_body{overflow-y:auto}` 之内，
 * 而 `question` 落在一个**无高度钳制、且在滚动区之外**的 `<header><h2>` 里。所以
 * `question` 只拿 {@link teamSessionDialogQuestion} 的一行话：把 3058 字的正文放进
 * `question` 正是真机上把「创建 / 取消」推出视野的那件事（§10.2.8.0）。
 */
async function askTeamSessionBatch(ctx, agent, plan, text, signal) {
	const userQuestions = ctx.get?.("userQuestions");
	if (userQuestions === undefined || userQuestions === null || typeof userQuestions.ask !== "function") {
		return { confirmed: false, reason: "确认服务（userQuestions）不可用——批量创建是爆炸半径大的动作，无确认即不执行（fail-closed）" };
	}
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, TEAM_SESSION_CONFIRM_TIMEOUT_MS);
	timer.unref?.();
	const forward = () => controller.abort();
	signal?.addEventListener?.("abort", forward);
	try {
		const answer = await userQuestions.ask({
			questions: [{
				id: TEAM_SESSION_DIALOG_ID,
				header: "批量建队确认",
				// ---- §10.2.8.4 修法表第 0 行：换槽位 ----------------------------------
				// question = **一行话**（{@link teamSessionDialogQuestion}：无换行、≤120 码点），
				// detail = **披露正文整段**（调用方交进来的 {@link teamSessionDialogText} 产物：
				// ≤600 码点 / ≤12 换行，U33 两个都单测断言）。换槽位前这里放的是 `text`，
				// 于是正文被渲进**无高度钳制、且在滚动区之外**的 `<header><h2>`，底部的
				// 「创建 / 取消」被推出卡片 —— 真机 8 次够不着即此因（§10.2.8.0 / §10.2.8.4）。
				question: teamSessionDialogQuestion(plan),
				detail: text,
				options: [
					{ label: TEAM_SESSION_CONFIRM_LABEL, description: `创建 ${plan.creating.length} 个 worker 会话并登记进团队 ${plan.team}（并建立与主会话的 pairs 双向免确认通道）` },
					{ label: "取消", description: "什么都不做：零创建、零 pairs、roster 不改动" },
				],
			}],
			agent,
			signal: controller.signal,
		});
		const item = Array.isArray(answer?.answers) ? answer.answers.find((entry) => entry?.id === TEAM_SESSION_DIALOG_ID) : undefined;
		if (item === undefined || !Array.isArray(item.selected)) return { confirmed: false, reason: "确认框没有返回本次批量建队问题的答案" };
		if (!item.selected.includes(TEAM_SESSION_CONFIRM_LABEL)) return { confirmed: false, reason: `用户在确认框里选择了「${item.selected.join("、") || "（未选择）"}」` };
		return { confirmed: true };
	} catch (error) {
		return { confirmed: false, reason: timedOut ? "确认框 3 分钟内未获确认（按取消处理）" : `确认框失败（${describeError(error)}）` };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener?.("abort", forward);
	}
}

/**
 * §10.2.2 + §10.2.3 + §10.2.6: create the batch, then drive it.
 *
 * The order is the design's, not an implementation convenience:
 * 1. the `pending-creates` intent is written BEFORE the create, so a crash
 *    between the two leaves a durable trace the startup sweep can report;
 * 2. every `create` resolves first (serial: N agents whose first turns fire
 *    together are a cost peak, §10.2.6 并发), and only then does any `followup`
 *    run — "Setup composes, it never drives";
 * 3. the first create that throws STOPS the loop, keeps everything already
 *    built, and is reported in the caller's summary. Nothing is rolled back: a
 *    session that exists on disk may already be open somewhere (§10.2.6 失败即停).
 *
 * @returns `{ results, created }` — `results` carries one row per planned
 *   worker (`ok` / `failed` / `skipped` / `not-attempted`), so the report is a
 *   faithful list rather than an all-or-nothing verdict.
 */
async function createTeamSessions(ctx, controller, policy, plan, cwd, coordinatorId) {
	const results = [];
	const created = [];
	let stopped = false;
	for (const entry of plan.sessions) {
		if (entry.skip) {
			results.push({ role: entry.role, sessionId: undefined, skipped: true, ok: true, detail: "同 team 同 role 已登记（按 role 幂等，§10.2.6）" });
			continue;
		}
		if (stopped) {
			results.push({ role: entry.role, sessionId: entry.sessionId, skipped: false, ok: false, notAttempted: true, detail: "前一个 create 失败后按「失败即停」未尝试" });
			continue;
		}
		// ---- 1) the durable intent, before the create, never after it ---------
		try {
			await addTeamSessionPending(policy, { team: plan.team, role: entry.role, sessionId: entry.sessionId, createdAt: Date.now(), expiresAt: Date.now() + TEAM_SESSION_PENDING_TTL_MS, by: coordinatorId ?? "" });
			controller.pending.set(entry.sessionId, { team: plan.team, role: entry.role, sessionId: entry.sessionId });
		} catch (error) {
			results.push({ role: entry.role, sessionId: entry.sessionId, skipped: false, ok: false, detail: `pending-create 意图写入失败（${describeError(error)}）——未创建（宁可不建，也不留一个没有意图记录的孤儿）` });
			stopped = true;
			continue;
		}
		// ---- 2) create: from the PLUGIN ROOT ctx, so the handle outlives the handler
		let creation;
		try {
			creation = await createRootAgent(ctx, controller.rootCtx, plan, entry, cwd);
		} catch (error) {
			results.push({ role: entry.role, sessionId: entry.sessionId, skipped: false, ok: false, detail: `创建失败（${describeError(error)}）` });
			stopped = true;
			continue;
		}
		const handle = creation.handle;
		// ---- 3) the plugin holds the handle; the intent is resolved -----------
		controller.handles.set(entry.sessionId, handle);
		controller.pending.delete(entry.sessionId);
		try {
			await removeTeamSessionPending(policy, entry.sessionId);
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: pending-create intent ${entry.sessionId} could not be cleared (${describeError(error)}) — 启动清扫会把它报进可收编清单`);
		}
		created.push({ role: entry.role, sessionId: entry.sessionId, handle });
		// `title` is the value the title service ACCEPTED (or `undefined` when the
		// naming degraded), carried here so the caller's completion list can state
		// what was really set instead of recomputing it from team/role (DEFECT-4).
		results.push({ role: entry.role, sessionId: entry.sessionId, skipped: false, ok: true, title: creation.title, detail: "已创建（handle 由插件持有）" });
	}
	// ---- 4) drive: only after every create resolved, and only as followup ---
	// `followup` (not `inject`): the kickoff task must WAKE the new session, and
	// `inject` is the "deliver without driving" semantics (§10.2.3).
	//
	// §10.2.8.2 默认值第 4 条: **既无正文也无 `task=` ⇒ 只建会话、不投启动任务** —— 正文与
	// `task=` 是**同一个槽**（R2: 正文 = 启动任务），两者都没给就是**没有任务**；此时投一具
	// 「请等待主会话派活」的 kickoff 是本插件替人类编一条他没写的任务。会话照建、照登记、照配对，
	// 完成回报如实说是哪一种形状（`driven` 保持 undefined ⇒ 报告走「未投启动任务」那一支）。
	for (const item of plan.task === undefined ? [] : created) {
		const row = results.find((candidate) => candidate.sessionId === item.sessionId);
		try {
			item.handle.agent.followup(teamSessionKickoffMessage(teamSessionKickoffText({ ...plan, coordinatorId }, item.role, cwd), coordinatorId));
			if (row !== undefined) row.driven = true;
		} catch (error) {
			if (row !== undefined) {
				row.driven = false;
				row.detail = `已创建，但启动任务投递失败（${describeError(error)}）`;
			}
		}
	}
	return { results, created };
}

/**
 * The ONE creation path of this module (§10.2.2's template), shared by the
 * `/team_session` batch and the §11.2 `successor:"auto"` hand-over. Two call
 * sites would be two places to keep the root-session contract in (meta carries
 * cwd/agentPreset and nothing else, creation from the plugin root ctx, AND the
 * workspace attach that follows it), so there is exactly one — and
 * `host-half.test.mjs` counts the `agents.create` call site in the source.
 *
 * 模板的**完整时序**（真机缺陷 #2 把它变成这份清单，`dsh-webhook/lib/index.js`
 * 的 `createWebhookSession` 逐行对应）：
 *   ① `workspaceRegistry.create(cwd)`（:96）→ ② `meta.cwd = workspace.path`
 *   （:103）→ ③ 建会话 `agents.create`（:99-111）→ ④
 *   把会话挂进工作区 `attachSession(sessionId)`（:115）；④ 之后（或之中）失败 ⇒
 *   ⑤ `detachSession` + `dispose` 回滚、各失败一行 warn、原错误照抛（:135-147）。
 *   ⑥ **命名** `sessionTitle` 的 `rename(handle.agent.session, title)`（:119，真机缺陷 #4）
 *   —— {@link renameTeamSession}。
 * ①④ 唯一允许跳过的分支是**服务缺席**（`ctx.get("workspaceRegistry")` 拿不到，
 * §10.3 红线不许把它塞进模块级 `inject`），且每个新建会话留一行 warn 如实说明
 * 「未挂进工作区，可能不会出现在侧边栏」——降级但绝不静默。
 *
 * @returns `{ handle, title }` —— `title` 是**真正交给标题服务**的那一个字符串（未设成
 *   时 `undefined`），供 ② 的完成清单与 ③a 的交班摘要**如实**说明设了什么标题。
 */
async function createRootAgent(ctx, rootCtx, plan, entry, cwd) {
	// ① 建/取工作区。registry 会把路径**归一化**，而 ④ 的 attachSession 拿会话
	// header 里 realpath 过的 cwd 与 workspace 记录比对 ⇒ ② 必须写
	// `workspace.path`，写调用方的原始 cwd 会在 attach 时被拒。
	const workspace = await openTeamSessionWorkspace(ctx, cwd, entry.sessionId);
	// ② ③ create options（preset 解析 → meta → setup 里的 mount）与 create。
	const options = await buildTeamSessionCreateOptions(ctx, plan, entry, workspace === undefined ? cwd : workspace.path);
	const handle = await rootCtx.agents.create(options);
	// ④ ⑤ 挂进工作区，失败按模板回滚。模板把命名排在挂载**之后**（:115 → :119），
	// 这里逐字同序：attach 失败会回滚掉这个会话（detach + dispose），那就不该先给它
	// 留下一条标题事件。
	const attached = workspace === undefined ? handle : await attachTeamSession(ctx, workspace, options.sessionId, handle);
	// ⑥ 命名（DEFECT-4）。降级（服务缺席 / rename 抛错）只留一行 warn，**不阻断创建**。
	const title = renameTeamSession(ctx, attached, plan, entry);
	return { handle: attached, title };
}

/**
 * 模板时序的 ①（`dsh-webhook:96`）：建/取这个新建会话所属的工作区。
 *
 * `workspaceRegistry` 是**可选**服务：它读 `ctx.get`（AT CREATION TIME，与
 * `agentPresets` 同款），**不进**模块级 `inject`（§10.3 红线仍是 4 项）。
 * 服务缺席是唯一允许跳过 workspace 面的分支，且绝不静默：每个新建会话一行
 * warn，点名「未挂进工作区，可能不会出现在侧边栏」——用户找不到自己刚建出来的
 * worker 正是真机缺陷 #2 的现象，所以这句话必须可读。
 *
 * 服务**在**但 `create` 抛错时不降级：创建阶段就报出去（调用方按「失败即停」
 * 报这一条），与模板一致——`meta.cwd` 拿不到归一化路径的话，④ 的会话边界校验
 * 也会拒。
 */
async function openTeamSessionWorkspace(ctx, cwd, sessionId) {
	const workspaceRegistry = ctx.get?.("workspaceRegistry");
	if (workspaceRegistry === undefined || workspaceRegistry === null || typeof workspaceRegistry.create !== "function") {
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: workspaceRegistry service unavailable — 新会话 ${sessionId} 未挂进工作区，可能不会出现在侧边栏（真机缺陷 #2）。会话照常创建与驱动；用 team_link_list_sessions 仍能按 id 找到并打开它。`);
		return undefined;
	}
	return await workspaceRegistry.create(cwd);
}

/**
 * 模板时序的 ④⑤（`dsh-webhook:115` / :135-147）：把刚建好的会话挂进工作区；失败
 * 则按模板的顺序回滚——先 `detachSession`、再 `handle.dispose()`，每一步失败各留
 * 一行 warn（模板的 `reportRollbackFailure`），最后**照抛原错误**（回滚失败绝不
 * 顶替原始失败）。
 *
 * **与模板的一处有意差异**：模板用 `attached` 标志门着 detach（只有 attach 成功
 * 后的后续步骤失败才摘除），这里**无条件**调 detach。理由是那个标志在这里不可
 * 观测且会漏掉真正的半成品：真实 `attachSession` 先 `host.rememberSessionPath()`
 * 再写记录，写记录那一步抛错时 `attached` 仍是 false，而会话已经在 registry 的
 * 路径索引里；`detachSession` 幂等（id 不在记录里时它不改写、不产事件），所以无
 * 条件调用既不误伤也保住了模板的语义——**失败的创建不留下半个已挂载的会话**。
 */
async function attachTeamSession(ctx, workspace, sessionId, handle) {
	try {
		await workspace.attachSession(sessionId);
		return handle;
	} catch (error) {
		try {
			await workspace.detachSession(sessionId);
		} catch (rollbackError) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: workspace detach rollback for Session "${sessionId}" failed (${describeError(rollbackError)})`);
		}
		try {
			await handle.dispose();
		} catch (rollbackError) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: Agent disposal rollback for Session "${sessionId}" failed (${describeError(rollbackError)})`);
		}
		throw error;
	}
}

/**
 * 模板时序的 ⑥（`dsh-webhook:119`）：把刚建好的会话命名成**可区分**的标题（DEFECT-4，
 * 派生规则见 {@link teamSessionTitle}）。
 *
 * **服务获取方式是 `ctx.get` 取名为 `sessionTitle` 的服务，不进模块级 `inject`**——§10.3
 * 的红线仍是那 4 项，与 `agentPresets` / `workspaceRegistry` / `agentDefaultModel` 同款。
 * 它是**可选**服务：缺席、或 `rename` 抛错（标题规范化后为空 / 会话不在册 / 服务已
 * dispose），都只留 **一行 warn**，**不阻断创建**。
 *
 * **与 preset / 模型选择那两处的口径故意不同（这是判断，不是疏漏）**：那两处服务缺失时
 * **拒绝创建**（`宁可不建，也不建一个跑不起来的会话`），因为它们决定的是这个会话**能不能
 * 跑**——缺 persona-prefix 的组装源、或缺 `{{model}}` 的值，造出来的会话首回合就死
 * （真机缺陷 #1 / #3）。标题只决定会话**在侧边栏里长什么样**：一个没改到名的会话仍然是
 * 一个能用的 worker，为一个**呈现面**让整批建队失败、或让换届的继任者干脆不存在（那会把
 * 信任迁移卡死在「令牌投不出去」上），是本末倒置。所以这里是**降级 + 如实留痕**，而不是
 * fail-fast；两档降级各有一行具名 warn，判据在 `host-half.test.mjs` 里各有一条行为断言。
 *
 * @returns 真正交给标题服务的那个字符串（回执/确认框据此**如实**说明设了什么标题，
 *   而不是拿 team/role 重算一遍）；未设成时 `undefined`（warn 已如实说明）。
 */
function renameTeamSession(ctx, handle, plan, entry) {
	const sessionId = entry?.sessionId ?? "（未知会话）";
	const title = teamSessionTitle(plan, entry);
	if (title === undefined) {
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: 新会话 ${sessionId} 无法从已有的结构化信息派生标题（team/role/id 三者都缺）——本次未设标题，宿主会给它默认标题（很可能是工作区名，同一批 worker 在侧边栏里会无法区分）。会话照常创建与驱动；标题可在壳里手动重命名。`);
		return undefined;
	}
	const sessionTitle = ctx.get?.("sessionTitle");
	if (sessionTitle === undefined || sessionTitle === null || typeof sessionTitle.rename !== "function") {
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: sessionTitle service unavailable — 新会话 ${sessionId} 未设标题（打算用的标题是「${title}」）：它于是显示为宿主的默认标题（很可能是工作区名），同一批 worker 在侧边栏里会无法区分（真机缺陷 #4）。会话照常创建与驱动；标题可在壳里随时手动改。`);
		return undefined;
	}
	try {
		sessionTitle.rename(handle?.agent?.session, title);
		return title;
	} catch (error) {
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: sessionTitle.rename failed for ${sessionId} (${describeError(error)}) — 新会话照常创建与驱动，标题保持宿主的默认（很可能是工作区名，侧边栏里可能无法区分）；标题可在壳里手动重命名。`);
		return undefined;
	}
}

/**
 * §10.2.2: the create options, verbatim. `meta` carries cwd and agentPreset and
 * NOTHING else — `origin` / `parentSession` / `delegationDepth` / `parentAgent`
 * stay unwritten, because `undefined` is the only legal non-subagent value of
 * `origin` and omitting `parentAgent` is what makes the session a ROOT session
 * (U18; §10.3 forbids marking these sessions as subagents).
 *
 * DEFECT-1 (真机缺陷 #1): the preset is resolved for EVERY creation, not only
 * when the caller passed `preset=`. The `dsh-webhook` template this section
 * copies resolves one unconditionally — `resolve(undefined)` answers the host's
 * own `defaultId` — and mounts it inside `setup`. Skipping that path when no
 * `preset=` was given left the new agent with NO persona-prefix assembly source
 * at all, so the session was created and then could not run a single turn:
 * `prompt variable "{{model}}" has no value for this assembly (section
 * "deployment:persona-prefix")`. 「会建」 ≠ 「能用」: the mount is what makes the
 * agent runnable, and this is the ONE creation path both §10.2 ② and §11.2's
 * `successor:"auto"` go through.
 *
 * The ONLY branch that may skip the preset face is the ABSENCE of the optional
 * `agentPresets` service — and it is never silent: one warn names what is
 * missing and what it costs. A service that IS there and rejects (unknown id, a
 * composition that will not mount) is a real failure and propagates: the batch
 * reports it and no session is created, because a session with no composition
 * source is the defect, not a degraded success.
 *
 * 异步是必需的：`meta.agentPreset` 必须在 `agents.create` **之前**就拿到真实
 * preset id（模板的顺序），而缺省解析只能问服务（`resolve(undefined)`）。
 *
 * DEFECT-3 (真机缺陷 #3): 同一个模板动作序列里还有**另一件**「缺省也要做」的事——
 * `resolveRequest` 在调用方**任一侧**没给（只给了 model，或只给了 provider）时也解析宿主的
 * 缺省模型选择，**缺的那一半**由它补齐，整对写进 `agentOptions` 并装成 `setup` 里的初始
 * 模型选择（{@link resolveTeamSessionModelSelection}）。
 * DEFECT-1 只补了「装配源」（preset 的 resolve + mount），**没补那个变量的值**：没有
 * `agentOptions` 的 agent 走不到宿主的缺省，`{{model}}` 于是无值，首回合照样起不来。
 * 「会建」≠「能用」在同一个函数上出现过两次，所以这两件事现在都在这里，且都有断言钉住。
 *
 * `cwd` 由 {@link createRootAgent} 传入：模板 `:103` 的取值是
 * `workspace.path`（registry 归一化后的路径），只在 workspace 服务缺席时才回落
 * 到调用方 cwd——attach 时会话边界拿的是同一个归一化路径。
 */
async function buildTeamSessionCreateOptions(ctx, plan, entry, cwd) {
	// DEFECT-3 的模型选择解析（模板 `resolveRequest` 的 if 分支，`dsh-webhook:30-36`，
	// 含 2026-09-20 收尾裁定）：调用方**任一侧**没给（只给 `model=`，或只给了 provider）
	// 时**也**解析宿主的缺省模型选择，**缺的那一半**由它补齐，并把**同一份** selection
	// 一路带到 `setup`（模板第 9 步）。原来的形状是「两侧都没给才解析，否则原样照抄」
	// ⇒ 只给一半的调用方拿到的是残缺的一对（`agentOptions = {model}`），编程创建的 agent
	// 于是没有任何可运行的模型选择 ⇒ `{{model}}`（`dsh-agent-loop` 的
	// `ctx.systemPrompt.variable("model", (context) => context.agent?.options.model)`）
	// 无值，首回合死在 `prompt variable "{{model}}" has no value`——真机缺陷 #3，
	// 以及同一缺陷类的「半条路由」（`model=X` 而漏写 `provider=` 的人类用户）。
	const modelSelection = resolveTeamSessionModelSelection(ctx, plan, entry.sessionId);
	const agentOptions = { provider: modelSelection.provider, model: modelSelection.model };
	// The optional service is read ONCE and the SAME instance is what `setup`
	// mounts through: a second read would be a second place where the mounted
	// composition can silently diverge from the id written into `meta`.
	const agentPresets = ctx.get?.("agentPresets");
	let presetId;
	if (agentPresets !== undefined && agentPresets !== null && typeof agentPresets.resolve === "function") {
		const preset = await agentPresets.resolve(plan.preset);
		await agentPresets.standingKeyFor(preset.id);
		presetId = preset.id;
	} else {
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: agentPresets service unavailable — 新会话 ${entry.sessionId} 既未解析也未挂载 preset：它没有 persona-prefix 的组装源，首回合可能因此起不来（真机缺陷 #1）。会话照常创建，若它跑不起来请检查宿主的 agentPresets 服务。`);
	}
	return {
		sessionId: entry.sessionId,
		meta: { cwd, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
		// 无条件传（与模板 `dsh-webhook:106` 的 `agentOptions: resolved.agentOptions,`
		// 逐字同一形状）。收尾裁定 3：`agentOptions` 现在**永远**带着一对非空
		// provider/model（上一步已解析/补齐），所以原来那个
		// 「空对象就不传」的条件分支**不可达**——留着它只会让人以为这里还有一条
		// 「无模型选择」的路。
		agentOptions,
		setup: async (agentCtx) => {
			// Unconditional whenever a preset was resolved — the 「有才挂」 shape
			// (a second chance to skip the mount) is what DEFECT-1 was.
			if (presetId !== undefined) await agentPresets.mount(agentCtx, presetId);
			installTeamSessionModelSelection(agentCtx, modelSelection);
		},
	};
}

/**
 * DEFECT-3（真机缺陷 #3）与它的**半条路由**收尾：模板 `dsh-webhook` 的
 * `resolveRequest` 的模型选择分支（`lib/index.js:28-52`）——调用方没给 model 时，缺省选择
 * 也**必须**解析出来；**只给一半**时缺的那一半同样必须补齐（收尾裁定，见下）：
 *
 * ```js
 * const selected = ctx.agentDefaultModel.currentSelection();
 * agentOptions = { provider: selected.provider, model: selected.model };
 * ```
 *
 * 为什么不能省（真机一次就把「宿主会兜底」这条假设推翻了）：`{{model}}` 的值不是来自
 * 宿主的缺省设置，而是来自**这个 agent 自己的 `options.model`**
 * （`dsh-agent-loop` 用 `ctx.systemPrompt.variable("model", (context) =>
 * context.agent?.options.model)` 注册它）。宿主的缺省只在**它自己的装配流程**里生效；
 * 一个由 `agents.create` 造出来、没有 `agentOptions` 的 agent 走不到那里。
 *
 * **收尾裁定（2026-09-20）——任一侧缺失就补齐**：`model=X` 而漏写 `provider=` 的调用方
 * 拿到的是 `agentOptions = {model}`，那是**同一个缺陷类的另一半**（`dsh-agent-loop` 以
 * 「has no provider/model」拒绝），失效形态与 DEFECT-1/3 一模一样。所以判据不是「两侧
 * 都没给」，而是「**任一侧**缺失」：只缺哪一半，就由**这一次** `currentSelection()` 的读数
 * 补哪一半（两侧都缺 ⇒ 一对全取缺省；两侧都给 ⇒ **完全不问服务**，行为与修复前逐字相同）。
 *
 * 服务获取方式是 `ctx.get`（**不**进模块级 `inject`，§10.3 红线仍 4 项）。服务拿不到、
 * 或拿到的 selection 补不出缺的那一半时**拒绝创建**（fail-visible，二选一里更硬的那个）：
 * 没有它就没有可解析的缺省模型，造出来的 agent 就是跑不起来的——「宁可不建，也不建一个
 * 跑不起来的会话」。
 *
 * @throws 服务缺席且调用方没给全，或 `currentSelection()` 补不出缺的那一半时。
 */
function resolveTeamSessionModelSelection(ctx, plan, sessionId) {
	if (plan.provider !== undefined && plan.model !== undefined) return { provider: plan.provider, model: plan.model };
	// Which half the caller left out — named in both refusals, because 「哪一半缺」是这两个
	// 失败面唯一能让人立刻修好的信息（fail-visible 的实质）。
	const missing = plan.provider === undefined && plan.model === undefined
		? "provider/model 两侧都没给"
		: plan.model === undefined
			? `只给了 provider=${JSON.stringify(plan.provider)}、缺 model`
			: `只给了 model=${JSON.stringify(plan.model)}、缺 provider`;
	const agentDefaultModel = ctx.get?.("agentDefaultModel");
	if (agentDefaultModel === undefined || agentDefaultModel === null || typeof agentDefaultModel.currentSelection !== "function") {
		throw new Error(`agentDefaultModel service unavailable — ${missing}，而没有它就没有可解析的缺省模型选择（真机缺陷 #3）：新会话 ${sessionId} 的 agentOptions 补不成可运行的一对，而 deployment:persona-prefix 里 {{model}} 的值正是它 ⇒ 首回合会以 prompt variable "{{model}}" has no value 失败。拒绝创建：宁可不建，也不建一个跑不起来的会话。两条出路——传 model=<provider>/<model>（或让宿主的 agentDefaultModel service 可用）。`);
	}
	const selected = agentDefaultModel.currentSelection();
	// The caller's own half always wins; only the missing half is taken from this ONE reading.
	const provider = plan.provider ?? selected?.provider;
	const model = plan.model ?? selected?.model;
	if (typeof provider !== "string" || provider === "" || typeof model !== "string" || model === "") {
		throw new Error(`agentDefaultModel.currentSelection() 没有给出可用的 provider/model（provider=${JSON.stringify(selected?.provider)}, model=${JSON.stringify(selected?.model)}）——调用方没给的那部分（${missing}）只能由它来补，补不出来就等于写进 agentOptions 的那一对残缺，会原样复现真机缺陷 #3（新会话首回合报 prompt variable "{{model}}" has no value）。拒绝创建：宁可不建，也不建一个跑不起来的会话。两条出路——传 model=<provider>/<model>，或修好宿主的缺省模型设置。`);
	}
	return { provider, model };
}

/**
 * A cross-session relay message whose `source` carries exactly the three audited
 * members — `{kind, form, senderSessionId}` (V10). An extra member refuses the
 * whole session log at migration time, so the plugin name and the delivery moment
 * live in the body instead.
 *
 * SCOPE OF THIS BUILDER (差异审计修复轮 🔵-3). The claim is "ONE builder for every
 * relay THIS PLUGIN DRIVES" — the messages the plugin constructs to wake or
 * answer someone (the §10.2.3 kickoff, the §11.4.5 hand-over delivery, the §11.2
 * command instruction). It is NOT "the module's only three-member relay literal":
 * two other faces construct their own, on purpose, and they are three-member for
 * the same red-line reason —
 *
 *   - {@link tickMessage} (the §3.2.3 watchdog tick): its id prefix `slp-wd-` and
 *     its sender are the watchdog's own identity (the message is delivered to the
 *     WATCHER, who is also its recorded sender), so routing it through this
 *     builder would change both facts;
 *   - the §3.4 `team_link_send` delivery in `deliverToTarget`: its body is the
 *     envelope banner and its receiver is addressed by an already-resolved target,
 *     so it builds its message where that banner is built.
 *
 * All three sites are three-member. A change to the triple's shape therefore has
 * three places to touch, and a fourth literal appearing anywhere is a defect: the
 * assertion that this builder stays the only one THIS FILE DRIVES is about the
 * driven set, not about the file's literal count.
 *
 * 设计 §10.2.3 的模板写的是 `handle.agent.followup(createUserMessage({content,
 * source}))`；这里是**手写的等价字面量**——一条**有意保留的偏差**（差异审计
 * 修复轮 🔵-2 的裁定）。裁定的依据是导入面：`createUserMessage` 来自
 * `@deepseek-ai/dsh-llm`，而本模块的**导入白名单只有六项**且经 U19 断言锁住
 * （白名单的一项目的正是「新增依赖无法偷渡写入 API」）。审计逐行比对的结论是
 * 两者实体**逐字相同**，差别只在那条上游构造函数产出的消息**被深冻结**
 * （`brandString` 是恒等函数）；本插件的消息一旦投出就不再改写，所以为一个
 * 单行消息的深冻结把导入面从 6 项扩到 7 项，与那条红线不相称。**若将来本文件已经因
 * 别的理由引入 `@deepseek-ai/dsh-llm`，这一处应随之改回上游构造函数**（那时白名单
 * 本就要一起改）。
 */
function relayUserMessage(text, senderSessionId) {
	return {
		id: `slp-${randomUUID()}`,
		role: "user",
		source: { kind: "agent-message", form: "relay", senderSessionId },
		content: [{ type: "text", text: wellFormed(text) }],
	};
}

/** The §10.2.3 kickoff task, driven into a freshly created worker. */
function teamSessionKickoffMessage(text, coordinatorId) {
	return relayUserMessage(text, coordinatorId);
}

/** Append one §10.2.6 `pending-creates` intent (read-modify-write, like every
 * other policy write in this plugin). */
async function addTeamSessionPending(policy, intent) {
	const current = policy.get();
	await policy.update({ pendingCreates: [...current.pendingCreates, intent] });
}

/** Resolve one intent by session id. A missing row is not an error: the sweep
 * may already have reported it. */
async function removeTeamSessionPending(policy, sessionId) {
	const current = policy.get();
	if (!current.pendingCreates.some((entry) => entry.sessionId === sessionId)) return;
	await policy.update({ pendingCreates: current.pendingCreates.filter((entry) => entry.sessionId !== sessionId) });
}

/**
 * §10.2.6 orphan guard, ownership half: one roster write for the whole batch,
 * through the SAME functions the roster tool uses — the creation path goes
 * through `upsert-team`'s「创建即认领」bootstrap, and an EXISTING team still
 * passes the existing `writerGate` first. No bypass is added (§10.2.4 既有 team
 * 的权限).
 *
 * @returns `{ team }` or `{ error }`.
 */
async function registerTeamSessionRoles(ctx, policy, plan, cwd, coordinatorId, createdRoleNames) {
	const added = createdRoleNames.filter((role) => !plan.skipped.includes(role));
	if (added.length === 0) return { team: null, added: [] };
	const view = policy.get();
	const existing = view.teams.find((candidate) => candidate.name === plan.team) ?? null;
	if (existing !== null) {
		const gate = withLiveGateDiagnostic(ctx, roleOf(existing, COORDINATOR_ROLE), writerGate(existing, coordinatorId));
		if (gate.error !== undefined) return { error: gate.error };
	}
	const byRole = new Map(plan.sessions.filter((entry) => !entry.skip).map((entry) => [entry.role, entry.sessionId]));
	const now = Date.now();
	const applied = applyTeamUpsert(view.teams, { name: plan.team, workspace: cwd, now, coordinator: coordinatorId });
	let team = applied.team;
	for (const role of added) {
		const sessionId = byRole.get(role);
		if (sessionId === undefined) continue;
		if (roleOf(team, role) !== null) continue;
		team = { ...team, roles: [...team.roles, teamSessionRoleRow(role, sessionId, now, `/team_session 批量建队`)] };
	}
	try {
		// The write maps over `applied.teams` — the AUTHORITATIVE post-upsert list
		// (creation path included) — and substitutes the `team` object the roster
		// rows above were folded into. Both halves matter: rebuilding the list from
		// the pre-write view drops the team this very call created, and writing
		// `applied.teams` as-is drops the rows, because `team` is a NEW object by
		// then (the entries in `applied.teams` still point at the un-extended one).
		await policy.update({ teams: applied.teams.map((entry) => (entry.name === plan.team ? team : entry)) });
	} catch (error) {
		return { error: `roster 写入失败（${describeError(error)}）——会话已创建并保留，请手动用 team_link_roster action=set-role 补登记。` };
	}
	const mirror = await writeRosterMirror(team);
	return { team, added, created: applied.created, mirror };
}

/**
 * The `commands` seam of this plugin (§10.2.1): ONE optional service, N slash
 * commands, ONE warn line per activation window. The module-level `inject` array
 * is untouched — `commands` is never a hard dependency, and a shell that never
 * provides it keeps every other tool face intact.
 *
 * The line is per SEAM, not per command, on purpose: the fact it reports ("the
 * service is not active at activation") is shared, so a per-command copy would
 * make the startup window carry as many near-identical lines as there are
 * commands — and the window's "one line per seam" contract is what makes it
 * readable. Both commands are named in that one line instead.
 *
 * The seam is shared by both commands for the same reason: "which registration
 * states exist and what each one says" is one fact, and a second copy of it would
 * be a second thing to keep in step (② 的「同一清单两处写」教训).
 */
function createCommandsSeam(ctx, commandNames) {
	const specs = [];
	const label = commandNames.map((entry) => `/${entry}`).join(" 与 ");
	let warned = false;
	let injected = false;
	const warn = (detail) => {
		if (warned) return;
		warned = true;
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: commands service unavailable at activation (${detail}) — ${label} 未注册（同一个可选 seam，其余命令与工具面照常）；本插件不把 commands 当硬依赖。`);
	};
	const attach = (target, spec) => {
		const commands = target.get?.("commands");
		if (commands === undefined || commands === null) return "not-active";
		if (typeof commands.register !== "function") return "no-register";
		try {
			commands.register(spec.build());
			ctx.logger?.info?.(`${PLUGIN_LABEL}: /${spec.name} registered through the optional commands service`);
			return "registered";
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: commands.register("${spec.name}") failed (${describeError(error)}) — 该命令不可用，其余工具面不受影响`);
			return "refused";
		}
	};
	return {
		add(spec) {
			specs.push(spec);
			// ① Fast path — the service is already active (the normal case on this
			//    host, where `commands` is composed before this plugin).
			const reason = attach(ctx, spec);
			if (reason === "registered") return;
			// ② A service that IS there but cannot take the command is a different
			// fact from "not up yet", and it will never become registerable — say it.
			if (reason === "no-register") {
				warn("no register()");
				return;
			}
			// One line for this activation window whenever the service was not already
			// active, for the same reason §9.1.3 made the settings seam speak here: the
			// only way to tell "the provider is still initialising" from "this shell has
			// no commands plugin" is to say what was observed at activation. The window
			// then carries exactly one line per seam, each naming its own service, and
			// the ordered injection below is the recovery — a provider that does arrive
			// registers with no second line.
			warn("not yet active");
			// No injection channel means no retry story; nothing is added in that case
			// on purpose: the settings store owns the line for a context without
			// `ctx.inject` (§9.1.3 ②), and the line above already named this service.
			if (injected || typeof ctx.inject !== "function") return;
			injected = true;
			ctx.inject(["commands"], (child) => {
				let refused = false;
				for (const pending of specs) {
					if (attach(child, pending) === "no-register") refused = true;
				}
				if (refused) warn("no register()");
			});
		},
	};
}

/**
 * `apply`'s §10.2 entry point: register `/team_session` through the shared
 * optional `commands` seam (§10.2.1).
 */
function registerTeamSessionCommand(ctx, policy, rotation, controller, seam) {
	seam.add({
		name: TEAM_SESSION_COMMAND,
		build: () => ({
			name: TEAM_SESSION_COMMAND,
			description: `§10.2 自动建队：一条命令创建 N 个 worker 根会话（N ≤ ${TEAM_SESSION_MAX_CREATES}，每队成员 ≤ ${TEAM_SESSION_MAX_MEMBERS}，均为代码常量）→ 创建完成后用 followup 投递启动任务 → 按 role 幂等登记进 roster → 与主会话建立 pairs 双向免确认通道（§10.2.3 选项 (i)，写入前有一次批量确认框）。文法（§10.2.8.2「参数可省」）：参数区只在行首，从行首连续读 key=value；遇到第一个不含 = 的 token 起，其后全部文本就是正文 = 启动任务（与 task= 等价，两处同现即报错）。位置角色名已废除 —— 声明角色只能写 roles=<r1,r2,…>（别名 role=）。默认：team 取调用会话工作区目录名（不合 [a-z0-9-]+ 回退 default）、n 省略时 1（给了 roles= 时为角色数）、roles 省略时 1 个 worker（worker-1）。task= 的取值含空格（一直读到下一个 key= 或行尾，整段也可加一对引号）。取消确认框 → 零创建零 pairs。`,
			// The descriptor carries only a hint (CommandInputDescriptor) plus the
			// fact that this grammar cannot use attachments: the handler owns every
			// further decision on the free-form input.
			input: { hint: `[n=<1..${TEAM_SESSION_MAX_CREATES}>] [team=<name>] [roles=<r1,r2,…>] [task=<一句话任务>] [preset=<presetId>] [model=<provider>/<model>] [正文…]`, attachments: false },
			recordInput: true,
			handler: async (invocation) => {
				try {
					const parsed = readTeamSessionCommand(invocation.rawInput);
					if (parsed.error !== undefined) return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_SESSION_COMMAND}：${parsed.error}` };
					const coordinatorId = typeof invocation.agent?.id === "string" && invocation.agent.id !== "" ? invocation.agent.id : undefined;
					if (coordinatorId === undefined) return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_SESSION_COMMAND}：当前命令没有可交互的活动代理（命令本身是人类指令，但 roster 登记与会话创建都需要调用会话身份）。` };
					const cwd = invocation.agent?.session?.header?.cwd;
					if (typeof cwd !== "string" || cwd === "" || !path.isAbsolute(cwd)) {
						return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_SESSION_COMMAND}：调用会话的 cwd 不是绝对路径（${cwd === undefined || cwd === "" ? "（未捕获）" : cwd}）——会话边界会校验绝对路径（§10.2.6），请在有工作目录的会话里执行。` };
					}
					// Every roster touch is a sweep moment (the roster tool's own lazy
					// hook), so a stranded rotation deadline is noticed here too.
					await rotation.sweep({ now: Date.now(), signal: invocation.signal });
					const view = policy.get();
					// §10.2.8.2's default: `team` omitted ⇒ the CALLING session's workspace
					// directory name (an illegal directory name falls back to `default`). Resolved
					// HERE because this is the first place the cwd is known — the parser is a pure
					// function of the raw line and has no session, and the roster lookup below must
					// search the SAME name this plan will seat the batch under.
					const teamName = typeof parsed.value.team === "string" && parsed.value.team.trim() !== "" ? parsed.value.team.trim() : teamSessionDefaultTeam(cwd);
					const existing = view.teams.find((candidate) => candidate.name === teamName) ?? null;
					const seated = existing === null ? [] : existing.roles.map((entry) => entry.role);
					const planned = teamSessionPlan({ ...parsed.value, team: teamName }, seated, Date.now());
					if (planned.error !== undefined) return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_SESSION_COMMAND}：${planned.error}` };
					const plan = planned.value;
					if (existing !== null) {
						const gate = withLiveGateDiagnostic(ctx, roleOf(existing, COORDINATOR_ROLE), writerGate(existing, coordinatorId));
						if (gate.error !== undefined) return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_SESSION_COMMAND}：${gate.error}` };
					}
					if (plan.creating.length === 0) {
						return { kind: "success", text: `${PLUGIN_LABEL} /${TEAM_SESSION_COMMAND}：团队 ${plan.team} 已登记本次请求的全部 ${plan.skipped.length} 个角色（按 role 幂等，§10.2.6），无需创建。零创建、零 pairs。` };
					}
					const dialog = await askTeamSessionBatch(ctx, invocation.agent, plan, teamSessionDialogText(plan, cwd, coordinatorId), invocation.signal);
					if (!dialog.confirmed) return { kind: "success", text: `${PLUGIN_LABEL} /${TEAM_SESSION_COMMAND}：${teamSessionNoConfirmText(plan, dialog.reason)}` };
					const outcome = await createTeamSessions(ctx, controller, policy, plan, cwd, coordinatorId);
					const createdRoles = createdTeamSessionRoles(outcome.results).map((entry) => entry.role);
					// DEFECT-4: the titles the title service ACCEPTED, per role — the
					// completion list renders these readings (`undefined` = the naming
					// degraded, and the line above plus the warn say so).
					const titleRows = createdTeamSessionRoles(outcome.results).map((entry) => `${entry.role} → ${entry.title ?? "未设标题"}`);
					const registration = await registerTeamSessionRoles(ctx, policy, plan, cwd, coordinatorId, createdRoles);
					// ---- pairs (§10.2.3 (i)): only workers that EXIST get a channel,
					// and the grant happens after the dialog authorized it, never before
					// — so 取消 really is 零创建零 pairs.
					let pairsAdded = 0;
					let pairsError;
					const workerIds = outcome.created.map((item) => item.sessionId);
					if (workerIds.length > 0) {
						try {
							const granted = withTeamSessionPairs(policy.get(), coordinatorId, workerIds, Date.now());
							if (granted.added > 0) await policy.update({ pairs: granted.pairs });
							pairsAdded = granted.added;
						} catch (error) {
							pairsError = describeError(error);
						}
					}
					const lines = [
						`/${TEAM_SESSION_COMMAND} 批量建队完成清单（团队 ${plan.team}，读数 ${readStamp(Date.now())}）：`,
						// §10.2.8.2 默认值第 4 条: `driven` stays undefined when there was no task to hand
						// over — 「只建会话」is a third outcome, and the report names it instead of
						// claiming a kickoff that never went out.
						...outcome.results.map((entry) => `- ${entry.role}${entry.sessionId === undefined ? "" : ` → ${entry.sessionId}`}：${entry.ok ? (entry.skipped ? "跳过（已登记）" : entry.driven === undefined ? "已创建（未给正文/task=，不投启动任务）" : entry.driven === false ? "已创建，启动任务投递失败" : "已创建 + 已投递启动任务") : `未创建（${entry.detail}）`}`),
						// DEFECT-4: `entry.title` is what the title service ACCEPTED (see
						// `renameTeamSession`) — a reading, not a recomputation. A row whose
						// naming degraded honestly says so instead of printing the title it
						// would have liked to set.
						`- 标题（DEFECT-4）：${titleRows.length === 0 ? "（本次没有新建会话）" : titleRows.join("、")}（按「<team> · <role>」派生，不再让它们全部显示为工作区名、在侧边栏里互相无法区分；想改随时在壳里重命名）`,
					// §10.2.8.7 裁定 2: the completion REPORT carries the same one-line role guidance as the
					// dialog (the defect-③ box was unreadable, so the sentence answering 「新会话为什么显示
					// 成 worker」 was never seen). One line, like the dialog's.
					`- 角色指引（§10.2.8.7）：${TEAM_SESSION_ROLE_GUIDANCE}`,
						`- roster：${registration.error !== undefined ? `未写入（${registration.error}）` : registration.added.length === 0 ? "无需改动（全部角色已登记）" : `已登记 ${registration.added.length} 个角色：${registration.added.join("、")}${registration.created ? "（团队本次创建，创建者已认领 coordinator）" : ""}${registration.mirror === undefined ? "" : `；${mirrorNote(registration.mirror)}`}`}`,
						`- pairs：${pairsError === undefined ? `与主会话 ${coordinatorId} 建立/确认 ${pairsAdded} 条双向免确认通道（既有通道不重复写；§10.2.3 (i) 预置配对，未在确认框授权前发生）` : `写入失败（${pairsError}）——后续投递将照走过门确认`}`,
						"保留声明（§10.2.5 / §10.2.6）：已创建的会话一律保留、不回滚——它们已经存在于盘上，可能已被打开；失败即停，不再继续创建后续会话。",
						"生命周期（§10.2.5）：这些会话的 AgentHandle 由插件持有，插件卸载/重载 = 它们的代理随本插件一起拆掉（会话仍在盘上）。重载后 roster 会把「盘上有会话但无活代理」如实标 dead（team_link_list_sessions），在侧边栏逐个打开即可收编，再按 roster 重新登记。",
					];
					if (registration.error !== undefined) lines.push(`→ 补救：用 team_link_roster action=set-role 为上面已创建的会话逐个补登记（团队 ${plan.team}）。`);
					return { kind: outcome.results.some((entry) => !entry.ok) || registration.error !== undefined ? "error" : "success", text: wellFormed(lines.join("\n")) };
				} catch (error) {
					return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_SESSION_COMMAND} 失败：${describeError(error)}` };
				}
			},
		}),
	});
}

// ---------------------------------------------------------------------------
// §11.2 `/team_rotate <role>` — the human trigger for the automatic hand-over
// ---------------------------------------------------------------------------

/**
 * Slash-command name of §11.2 (without the leading slash). It rides the SAME
 * optional `commands` seam as `/team_session` (§10.2.1) — the module-level
 * `inject` array stays at its four entries.
 */
const TEAM_ROTATE_COMMAND = "team_rotate";
/** The one key this grammar accepts. The role is positional, so the key list
 * stays this short — and the unknown-key refusal prints exactly this list, which
 * is what keeps the message from advertising a key the parser refuses.
 * {@link TEAM_ROTATE_KEY_HINT} is RENDERED FROM this array, so the advertised key
 * set and the accepted key set cannot drift apart in either direction (③a 差异审计
 * 修复轮 🟡-4 / host-half 的双向锁断言). */
const TEAM_ROTATE_KEYS = ["team"];
/** Per-key help of `/team_rotate`. `null` is the honest value for a key that has
 * no `=<value>` form — none today, but leaving the hole in the map is cheaper
 * than re-shaping it later. */
const TEAM_ROTATE_KEY_HELP = { team: "<name>（可选）" };
const TEAM_ROTATE_KEY_HINT = TEAM_ROTATE_KEYS.map((key) => `${key}=${TEAM_ROTATE_KEY_HELP[key] ?? "<值>"}`).join("  ");

/**
 * §11.2's command grammar, and nothing beyond it: `/team_rotate <role> [team=<name>]`.
 * No quoting is supported ON PURPOSE — a team name is `[a-z0-9-]+` and a role name
 * is validated by {@link readRoleName}, so quotes would be syntax the command
 * advertised and then had to strip; a value that carries one is refused instead.
 */
function readTeamRotateCommand(rawInput) {
	const text = typeof rawInput === "string" ? rawInput.trim() : "";
	const syntax = `/${TEAM_ROTATE_COMMAND} <role> [${TEAM_ROTATE_KEY_HINT}]`;
	if (text === "") return { error: `需要角色名。语法：${syntax}` };
	const value = {};
	for (const token of text.split(/\s+/u)) {
		const at = token.indexOf("=");
		if (at === -1) {
			if (value.role !== undefined) return { error: `只接受一个角色名（已给「${value.role}」，又出现了「${token}」）。语法：${syntax}` };
			value.role = token;
			continue;
		}
		const key = token.slice(0, at);
		const raw = token.slice(at + 1);
		if (!TEAM_ROTATE_KEYS.includes(key)) return { error: `未知参数「${key}=」（本命令只接受 ${TEAM_ROTATE_KEY_HINT}；角色名直接写，不加 key）。` };
		if (raw === "") return { error: `「${key}=」的值为空。` };
		if (/["']/u.test(raw)) return { error: `「${key}=」的值不要带引号（团队名是 [a-z0-9-]+，直接写）。` };
		value[key] = raw;
	}
	if (value.role === undefined) return { error: `需要角色名。语法：${syntax}` };
	return { value };
}

/**
 * §11.2 / §11.9.7: the command only does MECHANISM. `CommandResult` text is
 * rendered by the dispatching UI and never enters the model context, so the
 * command cannot draft the hand-over body itself — it drives the incumbent with
 * this instruction, and the model drafts the body and makes the tool call. The
 * syntax taught here is the syntax the tool implements (one contract, one
 * wording): `successor:"auto"` plus the five hard sections.
 */
function teamRotateInstruction(teamName, roleName, caller) {
	return [
		`【${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}】你是团队 ${teamName} 的角色 ${roleName} 的现任（会话 ${caller}），有人请你交班。下面是机制步骤，判断由你给：`,
		"",
		"① 起草交接正文（Markdown；五个硬节各以一个标题开头，标题名逐字如下）：",
		...HANDOFF_HARD_SECTIONS.map((name) => `   ## ${name} —— ${HANDOFF_SECTION_HINTS[name]}`),
		`   软节（缺了只警告，不拒绝）：${HANDOFF_SOFT_SECTIONS.map((name) => `## ${name}`).join(" / ")}`,
		"② 然后调用（交接正文放进 handoff 参数；自建继任者、写交接文档、铸令牌、投递都由插件承担）：",
		`   team_link_rotate  action="prepare"  team="${teamName}"  role="${roleName}"  successor="auto"  handoff="<第 ① 步的正文>"`,
		"③ 会弹一个确认框（新建 1 个会话 + 交班的爆炸半径：id / cwd / 模型情形 / 保守成本口径 / 信任面）——人类确认后才会真的建会话；无确认服务则 fail-closed。",
		"④ 之后没有你的动作：继任者凭投给它的令牌自己 claim；rotation-done 广播后旧任即可关闭（插件绝不自动关闭任何会话，§11.4.7）。",
		"",
		`提醒：这份正文是继任者得到的全部（它是零上下文的新根会话）；插件只把关结构（五硬节在场 / 非空 / 有界），不把关内容质量（§11.9.6）。`,
	].join("\n");
}

/**
 * `apply`'s §11.2 entry point. Three things happen here and nothing else: the
 * caller is checked to BE that role's incumbent (§11.2's own gate — the command
 * writes no roster state, so `writerGate` is not the right gate here, and the
 * tool's own `rotateGate` repeats this check one step later), the session is
 * driven with `followup`, and the UI gets a summary.
 *
 * H3 (§11.8 / §11.9.7): driving one's own session from a command handler has no
 * interface-level prohibition, but its turn semantics are a smoke-test item for
 * the restart window — so the summary says so out loud, and the TOOL entry stays
 * the fallback path (a human can always just ask the incumbent in words).
 */
function registerTeamRotateCommand(ctx, policy, rotation, seam) {
	seam.add({
		name: TEAM_ROTATE_COMMAND,
		build: () => ({
			name: TEAM_ROTATE_COMMAND,
			description: `§11.2 自动换届（③）的人类入口：/${TEAM_ROTATE_COMMAND} <role> [${TEAM_ROTATE_KEY_HINT}]。handler 校验发起会话确为该角色的现任 → 用 followup 把「起草交接正文（五硬节）并调用 team_link_rotate action=prepare successor:"auto"」的指令投给该会话 → 返回摘要给 UI。命令自身不做交接正文（命令的返回值进不了模型上下文，正文必须由模型起草），也绝不自建会话：真正的新建会话 + 交班在工具侧，且必须过一次确认框（§11.4.1）。命令的可用性是可选的：没有 commands 服务时本命令不注册，其余工具面照常（§10.2.1）。`,
			input: { hint: `<role> [${TEAM_ROTATE_KEY_HINT}]`, attachments: false },
			recordInput: true,
			handler: async (invocation) => {
				try {
					const parsed = readTeamRotateCommand(invocation.rawInput);
					if (parsed.error !== undefined) return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：${parsed.error}` };
					const role = readRoleName(parsed.value.role);
					if (role.error !== undefined) return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：${role.error}` };
					const caller = typeof invocation.agent?.id === "string" && invocation.agent.id !== "" ? invocation.agent.id : undefined;
					if (caller === undefined) return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：当前命令没有可交互的活动代理——换届由现任发起，命令必须能驱动发起者自己的会话。` };
					// Every roster touch is a sweep moment (the roster tool's own lazy hook),
					// so a stranded rotation deadline is noticed here too.
					await rotation.sweep({ now: Date.now(), signal: invocation.signal });
					const view = policy.get();
					const named = typeof parsed.value.team === "string" ? parsed.value.team.trim() : undefined;
					const teams = named === undefined ? view.teams : view.teams.filter((team) => team.name === named);
					if (teams.length === 0) {
						// Two different facts, two different sentences: an empty registry is not
						// "the team you named does not exist".
						return { kind: "error", text: named === undefined
							? `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：本机还没有注册任何团队（先用 team_link_roster action=upsert-team 创建，它会把发起会话播种为该队的 coordinator 现任）。`
							: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：团队 ${named} 不在注册表中（先用 team_link_roster action=upsert-team 创建）。` };
					}
					const incumbent = teams.filter((team) => roleOf(team, role.value)?.current === caller);
					if (incumbent.length === 0) {
						const detail = teams.map((team) => {
							const entry = roleOf(team, role.value);
							return entry === null ? `团队 ${team.name} 没有角色 ${role.value}` : `团队 ${team.name} 的角色 ${role.value} 现任是 ${entry.current ?? "（空缺）"}`;
						}).join("；");
						return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：发起会话 ${caller} 不是该角色的现任（${detail}）——换届只能由现任发起（§3.6.2 的 rotateGate 在工具侧作同样判定）。` };
					}
					if (incumbent.length > 1) return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：你在 ${incumbent.length} 个团队担任 ${role.value}（${incumbent.map((team) => team.name).join("、")}）——请用 team=<name> 指定其中一个。` };
					const team = incumbent[0];
					const limited = rotationRateLimited(roleOf(team, role.value), Date.now());
					if (limited.limited) return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：该角色现在处于换届速率限制窗口——${limited.reason}。现在唤醒只会让你再撞一次同样的拒绝（§3.6.2 rateLimit(team, role, 10min)），本命令未投递任何指令。` };
					invocation.agent.followup(relayUserMessage(teamRotateInstruction(team.name, role.value, caller), caller));
					return {
						kind: "success",
						text: wellFormed([
							`/${TEAM_ROTATE_COMMAND}：已把「起草交接并调用 team_link_rotate prepare successor:"auto"」的指令投给本会话（团队 ${team.name} 角色 ${role.value}）。`,
							"- 命令只做机制：交接正文（五硬节）由模型起草，插件负责自建继任者、写交接文档、铸令牌、投递。",
							"- 下一步：本会话会被这条 followup 唤醒，随后弹一次确认框；确认之前不会创建任何会话、不铸令牌、不广播 freeze（无确认服务 → fail-closed，§11.4.1）。",
							"- H3 待验（§11.8 / §11.9.7）：命令 handler 驱动自身会话的 followup 尚未真机验证。若这条唤醒没有发生，请直接用自然语言让现任调用 team_link_rotate action=prepare … successor=\"auto\"——工具入口与命令入口并存，工具入口是兜底。",
						].join("\n")),
					};
				} catch (error) {
					return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND} 失败：${describeError(error)}` };
				}
			},
		}),
	});
}

/**
 * §10.2.6 startup sweep: report every `pending-creates` intent that outlived its
 * TTL as an ADOPTABLE session (the create crashed, or the plugin unloaded
 * mid-loop). The row is never deleted on the strength of the guess that the
 * session does not exist — the plugin cannot tell an orphan session from a
 * never-created one, so it hands the list to the human and removes the intent
 * (its report IS the record).
 *
 * The report is the caller's LOG line, so the wording says where it came from.
 * The liveness probe is injected (§11.9.3): the sweep has a `ctx` and therefore a
 * reading, and the reading is used HERE and nowhere durable.
 *
 * @returns `{ reported, lines }` — the durable intents reported, in the caller's
 *   terms; `lines` is the complete startup report (pending-create orphans plus
 *   the seated-dead roster rows).
 */
async function sweepPendingCreates(ctx, policy, now = Date.now()) {
	const view = policy.get();
	const expired = view.pendingCreates.filter((entry) => entry.expiresAt > 0 && entry.expiresAt <= now);
	// §11.9.3's startup row (computed from the SAME read as the sweep above, so the
	// two halves of one report cannot describe two different rosters). It is a pure
	// read: nothing about liveness is written anywhere, which is the whole point.
	const dead = seatedDeadRoles(view, (id) => agentIsLive(ctx, id));
	let lines = dead;
	if (expired.length === 0) return { reported: [], lines };
	try {
		await policy.update({ pendingCreates: view.pendingCreates.filter((entry) => !expired.includes(entry)) });
	} catch (error) {
		return { reported: [], lines: [...lines, `pending-create 清扫写入失败（${describeError(error)}）：本次未生效，下次启动/巡逻会重试。`] };
	}
	lines = [...lines, ...expired.map((entry) => `- 团队 ${entry.team} 的角色 ${entry.role}：意图于 ${readStamp(entry.createdAt)} 写于创建之前，超时（${readStamp(entry.expiresAt)}）未回填 → 会话 ${entry.sessionId} 可能已创建但未登记，也可能根本没建成：可在侧边栏按这个 id 找它，找到即打开收编并用 team_link_roster action=set-role 重新登记（插件不删任何会话）。`)];
	ctx.logger?.warn?.(`${PLUGIN_LABEL}: ${expired.length} 个 pending-create 意图超时未回填 — 可收编清单见本轮启动报告`);
	return { reported: expired, lines };
}

/** Masked rendering of a one-time rotation token: `tok-<head4>…<tail4>`. The full
 * value is handed to the preparing caller exactly once and never rendered again —
 * not in the mirror, not in `roster get` (§3.6.2 评审 #3). */
function maskToken(token) {
	const text = String(token ?? "");
	if (text.length <= 4) return `${ROTATION_TOKEN_LABEL}…`;
	return `${ROTATION_TOKEN_LABEL}${text.slice(0, 4)}…${text.slice(-4)}`;
}

/** One status field of an internal notice, reduced to a single injection-free
 * line. Notice bodies are plugin constants (§3.6.2) — the only values that ever
 * enter one are validated identifiers, and this pass keeps even those from
 * carrying a newline (or a `|`) into the body. */
function noticeField(value) {
	return String(value ?? "").replace(/[\u0000-\u001F\u007F|]/gu, "_");
}

/** The filled roles of one team, deduplicated, in roster order — "同 team 成员" of
 * §3.6.1 principle 2, and the recipient set of an internal notice. A vacant role
 * is not a member. */
function teamMembers(team) {
	const members = [];
	for (const entry of team.roles) {
		if (entry.current === null || members.includes(entry.current)) continue;
		members.push(entry.current);
	}
	return members;
}

/**
 * §11.5's "插件必须额外报告它自建的那个继任者会话", answered from DURABLE
 * evidence first. The question is "did THIS PLUGIN build the session this token
 * was issued to?", and the one reading that cannot answer it across an
 * activation boundary is the in-memory handle registry: a plugin reload drops
 * every handle (the sessions stay on disk, the registry does not), so a
 * handle-only predicate makes the naming line vanish in exactly the window the
 * design put it there to cover — the orphan nobody knows about.
 *
 * The order of the three sources is therefore the order of their durability:
 *
 * 1. the hand-over document the plugin wrote for this very swap
 *    (`team/<name>/handoff-<role>-<ts>.md`, header `successor:`), read from the
 *    directory — durable, survives reload, and it is the auto path's own record
 *    (the manual path writes one too when the model supplied a body, so it is
 *    evidence that the session exists, which is the fact the line reports). The
 *    NEWEST document is the one that answers: a token that is still pending is
 *    necessarily the latest prepare's, so an id appearing only in an older
 *    document belongs to a swap that has already been superseded;
 * 2. the `pending-creates` intent, which is written BEFORE the create and
 *    removed only after prepare succeeded — a surviving intent for this id means
 *    the resolution step failed, and it is durable as well;
 * 3. `hasHandle`, the in-memory registry, kept as CORROBORATION (the design's
 *    "内存 handle 只作附加佐证") and as the answer the current activation can
 *    still give.
 *
 * Both durable reads are taken from their owners — the directory and the policy
 * store — rather than from this module's memory, which is what lets the same
 * function answer for a window whose handles are gone, and lets a fixture
 * present such a window (a fresh empty registry over the SAME disk state).
 *
 * @param request.team - the roster team row (the document lives under its
 *   captured workspace).
 * @param request.role - the role whose hand-over document is consulted.
 * @param request.sessionId - the session to attribute.
 * @param request.pendingCreates - the durable intents to consult.
 * @param request.hasHandle - the current activation's registry reading.
 * @returns `{ pluginCreated, evidence }` — `evidence` names the source that
 *   answered, for the caller's report and for the assertions.
 */
async function successorOwnershipOf(request) {
	const { team, role, sessionId, pendingCreates, hasHandle } = request;
	const handleWitness = typeof hasHandle === "function" && hasHandle(sessionId) === true;
	if (team !== null && team !== undefined && typeof sessionId === "string" && sessionId !== "") {
		const document = await handoffDocumentNamesLatest(team, role, sessionId);
		if (document.error === null && document.named === true) {
			return { pluginCreated: true, evidence: "handoff-document" };
		}
	}
	const intents = Array.isArray(pendingCreates) ? pendingCreates : [];
	if (intents.some((entry) => entry.sessionId === sessionId)) return { pluginCreated: true, evidence: "pending-create-intent" };
	if (handleWitness) return { pluginCreated: true, evidence: "handle" };
	return { pluginCreated: false, evidence: "none" };
}

/** All the cancelled successors of one sweep, keyed `team\u0000role`, with §11.5's
 * naming verdict already resolved. One pass, so the report loop below cannot
 * await anything and the row order stays the sweep's own.
 *
 * The pending-create intents are read from the caller's LIVE store (not from the
 * sweep's entry snapshot): the sweep clears the token's pending in memory before
 * it reports, and an intent that this very candidate resolved must not be read
 * back as "the plugin never finished creating it". */
async function successorOwnershipIndex(cancelled, policy, hasHandle) {
	const index = new Map();
	for (const item of cancelled) {
		const view = policy.get();
		const team = view.teams.find((record) => record.name === item.team) ?? null;
		index.set(`${item.team}\u0000${item.role}`, await successorOwnershipOf({ team, role: item.role, sessionId: item.caller, pendingCreates: view.pendingCreates, hasHandle }));
	}
	return index;
}

/** The report's own name for the source that answered §11.5's question — the
 * sentence names its evidence, so a reader can tell a durable finding from the
 * current activation's memory. */
function ownershipEvidenceLabel(evidence) {
	if (evidence === "handoff-document") return "落盘的交接文档头部 successor 行";
	if (evidence === "pending-create-intent") return "落盘的 pending-create 意图";
	if (evidence === "handle") return "本激活窗口的 AgentHandle 注册表";
	return "（无证据）";
}

/** The remaining part of an anti-storm window, for the refusal sentence. */
function fmtWindowRest(until, now) {
	return `窗口剩余约 ${Math.max(0, Math.ceil((until - now) / 60000))} 分钟`;
}

/** §3.6.2 `rateLimit(team, role, 10min)`: refuse a prepare while a pending minted
 * inside the window exists, or a rotation — **or a §11.9.5⑦ recovery**, which stamps
 * the SAME `rotationAt` field — of the same role completed inside it. Pure — `now`
 * is the caller's clock, so both branches are testable directly, and the recovery
 * path reads this ONE function rather than restating the second half (a restatement
 * would be a second implementation of the same window, and the audit found exactly
 * that: the duplicate branch could never fire). */
function rotationRateLimited(entry, now) {
	if (entry === null || entry === undefined) return { limited: false };
	const pending = entry.pending;
	if (pending !== null && pending !== undefined) {
		const minted = pending.createdAt > 0 ? pending.createdAt : pending.expiresAt - ROTATION_TTL_MS;
		if (now - minted < ROTATION_RATE_LIMIT_MS) {
			return { limited: true, reason: `该角色已有 pending（创建于 ${readStamp(minted)}，${fmtWindowRest(minted + ROTATION_RATE_LIMIT_MS, now)}）` };
		}
	}
	if (entry.rotationAt > 0 && now - entry.rotationAt < ROTATION_RATE_LIMIT_MS) {
		return { limited: true, reason: `该角色刚完成过一次换届/恢复（${readStamp(entry.rotationAt)}，${fmtWindowRest(entry.rotationAt + ROTATION_RATE_LIMIT_MS, now)}）` };
	}
	return { limited: false };
}

/** §3.6.2 prepare permission, verbatim: the incumbent session of that role. The
 * user path is the settings UI (the user is the super-writer there), not a tool
 * call — so a caller that is not the incumbent is refused, never guessed at. */
function rotateGate(team, entry, caller) {
	if (entry.current === null) {
		return { error: `prepare 被拒绝：团队 ${team.name} 的角色 ${entry.role} 当前空缺（current=null），没有「现任」可以发起换届。请由用户经设置 UI 指定现任后再换。` };
	}
	if (caller === undefined || caller !== entry.current) {
		return { error: `prepare 被拒绝：只有该角色的现任会话 ${entry.current} 可以发起换届（当前调用会话 ${caller ?? "（无会话身份）"}）。用户路径是设置 UI（直接改设置命名空间 team-link 的 teams 键），不是工具调用（§3.6.2）。` };
	}
	return { ok: true };
}

/** Stable identity of one pair record (the R1 convention): a rotation must tell
 * "the pair the dialog listed" from "a pair added while the dialog was open". */
function pairKey(pair) {
	return `${pair.a}\n${pair.b}\n${pair.createdAt}`;
}

/**
 * §3.6.2 prepare's admission checks, in ONE place: the manual path runs them
 * inside prepare, and the §11.2 `successor:"auto"` path runs them BEFORE it
 * creates anything — so a request prepare would refuse never leaves a session
 * behind, and the refusal words exist once instead of twice. Pure.
 *
 * `request.isLive` is the §11.9.3 liveness probe (injected, exactly like the
 * gates' own enrichment): the refusal it decorates is the one that names the
 * incumbent, which is where "只有现任 X 可发起" is MISLEADING when X has no live
 * agent. Absent probe ⇒ the words are the pre-§11.9 ones.
 *
 * `request.userInitiated` (§3.6.2's own `|| userInitiated` alternative, made
 * concrete by design §11.9.4/§11.9.5) is the ONE case where the incumbent check is
 * not the authorization: the caller is the recovery controller, and the
 * authorization is the human's click in `team_link_recover`'s dialog — a party
 * whose permission ceiling is the settings UI super-writer, so it can only
 * NARROW the existing human permission, never add one (会诊 #43 K). Every OTHER
 * check in this function still runs for that path.
 *
 * @returns `{ team, entry }` or `{ error }`.
 */
function prepareAdmission(view, request) {
	const { teamName, roleName, successor, now, caller, isLive } = request;
	const team = view.teams.find((entry) => entry.name === teamName) ?? null;
	if (team === null) return { error: `prepare 失败：团队 ${teamName} 不在注册表中（先用 team_link_roster action=upsert-team 创建）。` };
	const entry = roleOf(team, roleName);
	if (entry === null) return { error: `prepare 失败：团队 ${teamName} 没有角色 ${roleName}（先用 team_link_roster action=set-role 指定现任）。` };
	if (request.userInitiated !== true) {
		const gate = rotateGate(team, entry, caller);
		if (gate.error !== undefined) return { error: `${gate.error}${typeof isLive === "function" ? recoveryLadderSuffix(entry, isLive) : ""}` };
	}
	if (successor !== undefined && successor !== null && successor === entry.current) {
		return { error: `prepare 失败：继任者不能是现任自己（${successor}）——自换会先把现任的 pairs/trustedSenders/rememberTargets 全部吊销，再以 provisional 迁回，等于一次没有意义的信任重建。换人请指定另一个会话；纯粹的降低信任用 team_link_roster action=retire。` };
	}
	const limited = rotationRateLimited(entry, now);
	if (limited.limited) {
		return { error: `prepare 失败：换届速率限制（§3.6.2 rateLimit(team, role, 10min)，防换届风暴）——${limited.reason}。请等窗口结束，或先让当前 pending 被认领/过期清扫。` };
	}
	return { team, entry };
}

/**
 * §3.6.1 principle 2 in one place: which pairs a rotation MAY migrate. A pair
 * qualifies only when it touches the outgoing holder AND its other end is a
 * member of the same roster ("爆炸半径限团队域"); the pair that would only join
 * the successor to itself does not qualify either. Everything else is dropped
 * with the retirement and never migrated.
 *
 * @returns `{ candidates, dropped }` — `candidates` in dialog order; several
 *   records naming the same counterpart yield one candidate, the rest are
 *   reported as duplicates.
 */
function planRotationMigration(view, request) {
	const { members, retiree, successor } = request;
	const candidates = [];
	const dropped = [];
	for (const pair of view.pairs) {
		if (pair.a !== retiree && pair.b !== retiree) continue;
		const other = pair.a === retiree ? pair.b : pair.a;
		if (other === successor) {
			dropped.push({ pair, other, reason: "对端就是继任者（迁移后会变成自己与自己配对）" });
			continue;
		}
		if (!members.has(other)) {
			dropped.push({ pair, other, reason: "对端不在本团队域内（§3.6.1 原则 2）" });
			continue;
		}
		if (candidates.some((candidate) => candidate.other === other)) {
			dropped.push({ pair, other, reason: "同一对端已有一条待迁移通道（重复记录）" });
			continue;
		}
		candidates.push({ pair, other });
	}
	return { candidates, dropped };
}

/**
 * The trust half of a claim: migrate the chosen in-domain pairs onto the new
 * holder, and revoke the outgoing holder symmetrically (§3.6.1 principle 3 —
 * every pair touching it, plus its two entries in the global trust lists).
 * Pure: it returns the three policy lists, it does not write them.
 */
function applyRotationTrust(view, request) {
	const { retiree, successor, chosen, now, provisional } = request;
	const removed = view.pairs.filter((pair) => pair.a === retiree || pair.b === retiree);
	const kept = view.pairs.filter((pair) => pair.a !== retiree && pair.b !== retiree);
	const additions = [];
	for (const candidate of chosen) {
		const exists = kept.some((pair) => (pair.a === successor && pair.b === candidate.other) || (pair.a === candidate.other && pair.b === successor));
		if (exists) continue;
		additions.push({
			a: successor,
			b: candidate.other,
			createdAt: now,
			provisional: provisional === true,
			expiresAt: provisional === true ? now + ROTATION_PROVISIONAL_TTL_MS : 0,
		});
	}
	return {
		pairs: [...kept, ...additions],
		trustedSenders: view.trustedSenders.filter((id) => id !== retiree),
		rememberTargets: view.rememberTargets.filter((id) => id !== retiree),
		additions,
		removed,
		revoked: {
			trustedSenders: view.trustedSenders.filter((id) => id === retiree),
			rememberTargets: view.rememberTargets.filter((id) => id === retiree),
		},
	};
}

/**
 * The roster half of a claim (§3.6.2 "roster 落定"): the old tenure closes with
 * the note, the new one opens, and the pending keeps the migrated-pairs marker —
 * the idempotency record, written BEFORE the pending is cleared, so a crash in
 * between leaves a replayable state instead of a second migration. An unconfirmed
 * rotation also opens its ratification window here. Pure.
 *
 * §3.6.2 评审 #10: the claim's verdict word (`status`) is recorded on the role
 * here, in the same write as the settlement. The replay used to RE-DERIVE it
 * from the leftover state, and that derivation is lossy: a dialog answered with
 * every candidate unchecked is ratified (status 已批准) yet migrates no pair and
 * opens no window, so `provisional === null && migrated.length === 0` replayed
 * it as 无待迁移对 — a different word about the same rotation.
 */
function settleRotation(team, request) {
	const { role, now, note, migratedPairs, provisional, status } = request;
	const existing = roleOf(team, role);
	const previous = existing.current;
	const history = existing.history.map((record) => ({ ...record }));
	if (previous !== null) closeTenure(history, previous, now, note);
	history.push({ session: existing.pending.session, from: now, until: null });
	const record = roleRecord({
		role,
		current: existing.pending.session,
		history,
		rotationAt: now,
		provisional: provisional === true ? { at: now, expiresAt: now + ROTATION_PROVISIONAL_TTL_MS, session: existing.pending.session } : null,
		rotationStatus: status ?? "",
		pending: { ...existing.pending, migratedPairs },
	});
	return {
		team: { ...team, roles: team.roles.map((entry) => (entry.role === role ? record : entry)) },
		previous,
		successor: existing.pending.session,
	};
}

/** The verdict word of a settled rotation, read from the role the claim recorded
 * it on (§3.6.2 评审 #10). The fallback is only for a role row written before
 * that field existed — the derivation it uses is exactly the lossy one the
 * recorded word replaces, so it stays as the legacy path rather than as a
 * second source of truth. */
function rotationStatusOf(entry, migrated) {
	if (typeof entry.rotationStatus === "string" && entry.rotationStatus !== "") return entry.rotationStatus;
	if (entry.provisional !== null && entry.provisional !== undefined) return "待批准(24h)";
	return migrated.length === 0 ? ROTATION_STATUS_NONE : "已批准";
}

/** Drop one role's pending — the last step of a claim, and of a cancellation. */
function clearRotationPending(team, role) {
	return { ...team, roles: team.roles.map((entry) => (entry.role === role ? { ...entry, pending: null } : entry)) };
}

/** The pairs one provisional window actually has to roll back (§3.6.2 评审 #2):
 * still provisional, already past their deadline, and granted to THIS window's
 * successor — the exact shape a rotation migration writes. An empty result means
 * the window has nothing to roll back (its pairs were ratified in the settings UI,
 * or the migration never created one), which is what makes the rotation-expired
 * notice and the "provisional 未批准过期" history entry false in that state. Pure. */
function doomedProvisionalPairs(pairs, successor, now) {
	// The expiry half is {@link isExpiredProvisionalPair} (评审 #8) — one definition
	// of "past its deadline" for the window query, the delivery-side gate and the
	// sweep's unconditional deletion.
	return pairs.filter((pair) => isExpiredProvisionalPair(pair, now) && (pair.a === successor || pair.b === successor));
}

// --- internal notices (§3.6.2 "内部广播路径") -------------------------------
// Four bodies, all plugin constants: only status fields (team, role, session
// ids, reading time) are interpolated, and every interpolated identifier passes
// `noticeField` first. No model-supplied text (a `note`, a message body) can
// reach a notice, so a notice can never smuggle a prompt into a peer's next
// request — the same red line the watchdog tick body is built on.

/** rotation-freeze: the freeze check-list is plugin constant text (§4.2). */
function freezeNotice(team, role, caller, successor, now) {
	return `[rotation-freeze] 团队 ${noticeField(team)} 的角色 ${noticeField(role)} 开始换届（发起会话 ${noticeField(caller)}，继任者 ${noticeField(successor)}，读数 ${readStamp(now)}）。冻结清单：① 停掉本会话的哨兵/看门狗与后台 job；② 确认没有在飞的动作（未完成的投递或工具调用）；③ 向协调者回报「状态已冻结」；④ 等待交接结果通知（rotation-done / rotation-cancelled）。冻结期间不要发起换届，也不要改动信任配置。`;
}

/** rotation-done: `status` is the ratified / provisional / no-candidate verdict of
 * the claim. The three verdicts carry three different sentences: the middle one
 * claims a rollback window that does not exist when nothing was migrated (§3.6.2
 * 评审 #5), so it must not be reached by the no-candidate status. */
function doneNotice(team, role, previous, successor, status, now) {
	const verdict = status === "已批准"
		? "迁移的 pairs 已是正式通道（旧任持有的 pairs/trustedSenders/rememberTargets 已对称吊销）。"
		: status === ROTATION_STATUS_NONE
			? "本次换届域内没有待迁移的通道（未弹确认框，也没有 provisional 回退窗口）：退役者持有的 pairs/trustedSenders/rememberTargets 已对称吊销，团队内不需要重建任何通道。"
			: "迁移的 pairs 是 provisional 通道：24h 内未获批准将自动回退为过门投递，期间经该通道投递的消息不可回收（§3.6.1 诚实声明）。";
	return `[rotation-done] 团队 ${noticeField(team)} 的角色 ${noticeField(role)} 换届完成（读数 ${readStamp(now)}）：旧任 ${noticeField(previous)} → 新任 ${noticeField(successor)}；信任迁移状态：${status}。${verdict}`;
}

/** rotation-cancelled: a token nobody claimed inside its 30 minutes (§3.6.2 评审 #4). */
function cancelledNotice(team, role, incumbent, caller, now) {
	return `[rotation-cancelled] 团队 ${noticeField(team)} 的角色 ${noticeField(role)} 的换届令牌过期未认领（发起会话 ${noticeField(caller)}，清扫读数 ${readStamp(now)}）：旧任 ${noticeField(incumbent)} 仍为 current（换届未发生），解除冻结——本条通知即解冻信号。需要换人请由现任重新 prepare。`;
}

/** rotation-expired: the 24h ratification window closed unapproved (§3.6.2 评审 #5). */
function expiredNotice(team, role, successor, now) {
	return `[rotation-expired] 团队 ${noticeField(team)} 的角色 ${noticeField(role)} 的 provisional 信任迁移 24h 内未获批准，已自动回退（清扫读数 ${readStamp(now)}）：迁移的 pairs 已删除，${noticeField(successor)} 仍为 current（换届事实已成立，降格需用户显式操作），此后投递按正常过门（首问门）处理。`;
}

/** One-line summary of a notice's delivery rows. */
function noticeSummary(rows) {
	const count = (wanted) => rows.filter((row) => row.includes(`→ ${wanted}`)).length;
	return `${count("delivered")} 投递 / ${count("refused")} 拒绝 / ${count("no-agent")} 无活动代理`;
}

// ---------------------------------------------------------------------------
// §11.9.6 hand-over document contract (③a)
// ---------------------------------------------------------------------------
//
// HONESTY, STATED WHERE IT BELONGS (design §11.9.6, almost verbatim): the plugin
// can only vet the STRUCTURE of a hand-over body — a section is present,
// non-empty and bounded — it can NOT vet CONTENT QUALITY. The presence gate
// guards against FORGETTING, not against going through the motions: a body that
// writes "TODO" under all five headings passes this gate, and nothing here
// pretends otherwise.

/** Header schema tag of the hand-over document
 * (`<workspace>/team/<name>/handoff-<role>-<ts>.md`, §11.4.3). */
const HANDOFF_SCHEMA = "team-link/handoff/1";
/** §11.4.3 file-name prefix. The timestamp makes every document unique, which is
 * exactly why a hand-over document needs no baseHash optimistic lock. */
const HANDOFF_FILE_PREFIX = "handoff-";
/** The header's `claimedAt` value at write time. The document is written BEFORE
 * prepare (§11.9.6 abort-before-prepare), so nobody has claimed when it lands —
 * and the claim never re-verifies, let alone rewrites, the document. */
const HANDOFF_CLAIMED_PLACEHOLDER = "（未认领；本文件写于 prepare 之前——§11.9.6：claim 时不复验文档，本文件不追写。认领时刻记在 roster 版本史与 claim 返回里）";
/** The header's `rotationStatus` value at write time, honest about the ORDER:
 * the token this header masks is minted in memory so the mask is real, but it
 * becomes durable and is issued only when prepare runs, one step later. */
const HANDOFF_STATUS_PREPARED = "待 prepare 落定（本文件先于令牌落盘与 freeze 广播写入；prepare 失败则本次换届不存在，认领后的状态词以 claim 返回为准）";

/** A heading line's normalized name: `## Task and Goal:` → `task-and-goal`. The
 * folding (`_`/whitespace → `-`) is what makes "task_and_goal" and
 * "Task and Goal" the same section instead of two silent near-misses. */
function normalizeHandoffSection(title) {
	return String(title ?? "").trim().toLowerCase().replace(/[\s_]+/gu, "-").replace(/^-+|-+$/gu, "");
}

/**
 * Split one hand-over body into its named sections. Pure text handling, and the
 * heading recognition is deliberately forgiving (`#`…`######`, an optional
 * trailing colon, any case, `-`/`_`/spaces inside the name): a body the model
 * DID write must not be refused over a heading style (§11.9.6 — the gate is
 * about presence, and a false refusal is a gate that lies).
 *
 * @returns `{ preamble, sections }` — `preamble` is the text before the first
 *   heading, kept so the document can carry the model's own words verbatim.
 */
function parseHandoffBody(text) {
	const preamble = [];
	const sections = [];
	let current = null;
	for (const line of String(text ?? "").split(/\r?\n/u)) {
		const heading = /^\s*#{1,6}\s*(.*?)\s*$/u.exec(line);
		if (heading !== null && heading[1] !== "") {
			const title = heading[1].replace(/[:：]\s*$/u, "").trim();
			current = { name: normalizeHandoffSection(title), title, lines: [] };
			sections.push(current);
			continue;
		}
		if (current === null) preamble.push(line);
		else current.lines.push(line);
	}
	return { preamble, sections };
}

/**
 * §11.9.6's structural report of one body: which HARD sections are absent, which
 * are present but EMPTY, which SOFT ones are absent. Pure — the ladder that
 * decides refuse-vs-warn lives in {@link readHandoffArgument}, so the counting
 * and the decision can be read (and asserted) separately.
 */
function handoffBodyReport(text) {
	const parsed = parseHandoffBody(text);
	const contentOf = (name) => {
		const section = parsed.sections.find((candidate) => candidate.name === name);
		return section === undefined ? undefined : section.lines.join("\n").trim();
	};
	const missingHard = [];
	const emptyHard = [];
	for (const name of HANDOFF_HARD_SECTIONS) {
		const content = contentOf(name);
		if (content === undefined) missingHard.push(name);
		else if (content === "") emptyHard.push(name);
	}
	return {
		parsed,
		missingHard,
		emptyHard,
		missingSoft: HANDOFF_SOFT_SECTIONS.filter((name) => contentOf(name) === undefined),
	};
}

/** The five-hard-section scaffold a refusal hands back (§11.9.6), rendered from
 * the same lists the validator uses. */
function handoffScaffold() {
	const lines = ["交接正文用 Markdown 写，五个硬节各以一个标题开头（标题名与下面逐字一致）：", ""];
	for (const name of HANDOFF_HARD_SECTIONS) lines.push(`## ${name}`, HANDOFF_SECTION_HINTS[name] ?? "", "");
	lines.push(`软节（缺了只警告，不拒绝）：${HANDOFF_SOFT_SECTIONS.map((name) => `## ${name}`).join(" / ")}`);
	return lines.join("\n");
}

/** The header's integrity verdict, rendered from the SAME report the ladder
 * decided on — so the document can never claim a completeness the gate did not
 * measure (the cross-round lesson: one fact, one source). */
function handoffIntegrityLine(report) {
	const complete = HANDOFF_HARD_SECTIONS.length - report.missingHard.length - report.emptyHard.length;
	const soft = report.missingSoft.length === 0
		? `软节齐全（${HANDOFF_SOFT_SECTIONS.length}/${HANDOFF_SOFT_SECTIONS.length}）`
		: `软节缺 ${report.missingSoft.length}/${HANDOFF_SOFT_SECTIONS.length}（${report.missingSoft.join("、")}）`;
	return `结构完整：硬节 ${complete}/${HANDOFF_HARD_SECTIONS.length}、${soft}；插件只把关结构（节在场 / 非空 / 有界），不把关内容质量——presence 门防遗忘、不防敷衍（§11.9.6）`;
}

/**
 * §11.9.6's 缺项阶梯, evaluated at the TOOL ENTRY and therefore before any side
 * effect: `successor:"auto"` plus a missing/empty body is refused here (zero
 * session, zero token, zero freeze), a missing hard section is refused BY NAME,
 * a missing soft section is a warning, and an EXPLICIT successor with no body at
 * all is allowed with a warning (M4's existing semantics are not tightened for
 * it — that session has its own life and context).
 *
 * ③a 差异审计修复轮 🟡-6: the two refusals below say WHICH successor form they
 * are talking about, rendered from THIS call's own `auto` flag rather than from
 * the case the branch was originally written for. The wording is the design's
 * (`successor:"auto"`), but it is now derived, so a future second entry point
 * that reaches these lines with an explicit successor cannot be told a story
 * about a path it did not take.
 *
 * @returns `{ error }` (refuse) or `{ body, warnings, report }` (proceed).
 */
function readHandoffArgument(value, options = {}) {
	const auto = options.auto === true;
	// The path label of THIS call (🟡-6). `successor:"auto"` is the §11.2 name of
	// the automatic path; an explicit successor is named by its own value.
	const pathHere = auto ? "successor:\"auto\"" : "显式 successor";
	const present = typeof value === "string" && value.trim() !== "";
	if (!present) {
		if (!auto) {
			return {
				body: "",
				report: null,
				warnings: [`未提供交接正文（handoff）：显式指定的继任者有自己的会话与上下文，M4 现有语义不因此收紧（§11.9.6 缺项阶梯）——但交接正文是头部/事实段之外唯一能留下判断的东西，建议下次仍按五硬节写一份：${handoffSectionsInline()}。`],
			};
		}
		return {
			error: `prepare 被拒绝（${pathHere} + 交接正文缺失或为空）：auto 路径造出的继任者是零上下文的新根会话，交接正文是它得到的全部——空正文的自动换届等于造一个失忆的持钥者（§11.9.6）。本次零建会话、零令牌、零 freeze。\n\n${handoffScaffold()}`,
		};
	}
	const report = handoffBodyReport(value);
	const named = [...report.missingHard.map((name) => `${name}（缺）`), ...report.emptyHard.map((name) => `${name}（空）`)];
	if (named.length > 0) {
		return {
			error: `prepare 被拒绝（${pathHere} + 交接正文缺硬节）：${named.join("、")}。本次零建会话、零令牌、零 freeze——请补齐后重试。\n\n${handoffScaffold()}`,
		};
	}
	const warnings = [];
	if (report.missingSoft.length === 0) warnings.push(`交接正文结构完整：硬节 ${HANDOFF_HARD_SECTIONS.length}/${HANDOFF_HARD_SECTIONS.length}、软节 ${HANDOFF_SOFT_SECTIONS.length}/${HANDOFF_SOFT_SECTIONS.length} 齐全（头部已记录）。`);
	else warnings.push(`交接正文缺软节：${report.missingSoft.join("、")}（放行——软节缺失只警告；头部已记录，§11.9.6）。`);
	return { body: value, warnings, report };
}

/**
 * §11.9.6 事实段 and the claim's own report are ONE fact source: this function
 * renders the three categories both of them state — the migration rows, the
 * dropped rows and the symmetric-revocation line. `selectedKeys === null` is the
 * "the claim has not run yet" mode, because the hand-over document is written
 * before prepare (§11.9.6 abort-before-prepare); both modes share every word they
 * both use, so the document and the claim result can never tell two different
 * stories about the same rotation (「不可两处口径」).
 */
function rotationFactRows(state) {
	const retiree = state.retiree;
	const successor = state.successor;
	const candidates = Array.isArray(state.candidates) ? state.candidates : [];
	const selected = state.selectedKeys ?? null;
	const additions = Array.isArray(state.additions) ? state.additions : [];
	const provisional = state.provisional === true;
	const migration = [];
	if (candidates.length === 0) {
		migration.push("  - （域内没有待迁移的 pairs）");
	} else if (selected === null) {
		for (const candidate of candidates) {
			migration.push(`  - ${candidate.other} ↔ ${retiree} → 待 claim 逐项勾选（域内候选；迁移与否在继任者 ${successor} 认领时落定）`);
		}
	} else {
		for (const candidate of candidates) {
			// "Selected" is decided by the dialog answer, not by whether a new record
			// was written: a counterpart the successor is already paired with migrates
			// without a second record.
			if (!selected.has(pairKey(candidate.pair))) {
				migration.push(`  - ${candidate.other} ↔ ${retiree} → 未迁移（未勾选）→ 已随退役清理；今后该对端走正常首问门。`);
				continue;
			}
			const added = additions.find((pair) => pair.b === candidate.other);
			if (added === undefined) {
				migration.push(`  - ${candidate.other} ↔ ${retiree} → 已迁移（新任与该对端已有配对记录，未新增重复记录）。`);
				continue;
			}
			migration.push(`  - ${candidate.other} ↔ ${retiree} → 已迁移为 ${candidate.other} ↔ ${successor}（${provisional ? `provisional，24h 内未批准自动回退，到期 ${readStamp(added.expiresAt)}` : "正式通道"}）。`);
		}
	}
	const dropped = (Array.isArray(state.dropped) ? state.dropped : []).map((item) => `  - ${item.other} ↔ ${retiree} → 未迁移（${item.reason}）→ 已随退役清理。`);
	// One head for both the prepare-time and the claim-time revocation sentence:
	// the template is written once, so the document and the claim result can never
	// drift apart (and the source lock in host-half.test.mjs can count it as one).
	const revokedHead = `对称撤销（§3.6.1 原则 3）：退役者 ${retiree} 持有的 pairs ${state.removedCount ?? 0} 条已全部清除`;
	const revocation = state.revoked === undefined || state.revoked === null
		? [`${revokedHead}（其中迁移条数在 claim 勾选后才落定）；trustedSenders ${state.trustedSenderCount ?? 0} 项与 rememberTargets ${state.rememberTargetCount ?? 0} 项一并清除——明细见 claim 返回。`]
		: [`${revokedHead}（其中迁移 ${state.migratedCount ?? 0} 条）；trustedSenders 移除 ${state.revoked.trustedSenders ?? 0} 项；rememberTargets 移除 ${state.revoked.rememberTargets ?? 0} 项。`];
	return { migration, dropped, revocation };
}

/** The ONE rendering of a provisional window's deadline (§3.6.2 评审 #5). Three
 * read faces have to name the same instant and they must never each compute their
 * own: the claim's guidance sentence, the hand-over document's 事实段, and the
 * unattended reading below (缺口1) that has to stand on its own. */
function provisionalWindowExpiry(now) {
	return readStamp(now + ROTATION_PROVISIONAL_TTL_MS);
}

/** §3.6.2 评审 #5's three provisional verdicts in ONE place: the claim's report
 * and the hand-over document's 事实段 both have to state the rollback window, so
 * the sentence lives here instead of being spelled out twice. */
function provisionalGuidance(state) {
	const { now, successor, provisional, status } = state;
	if (provisional === true) {
		return `provisional 回退窗口：${provisionalWindowExpiry(now)} 到期。到期未批准 → 迁移的 pairs 自动删除、version history 记「${ROTATION_PROVISIONAL_NOTE}」、广播 rotation-expired；${successor} 保持 current，信任回退为过门投递（§3.6.2 评审 #5 终态）。补批准：在设置 UI 把该 pair 的 provisional 置 false 即转正式（回退前有效；已转正式的窗口到期时静默关闭，不记版本史、不广播 rotation-expired——没有回退发生）。`;
	}
	if (status === ROTATION_STATUS_NONE) return "回退窗口：本次换届没有新建任何通道（域内无待迁移对），因此没有 provisional 回退窗口——回退窗口只随迁移出的 pair 产生。";
	return "迁移的 pairs 已是正式通道（无回退窗口）。";
}

/**
 * 缺口1（真机 2026-09-20 的可观测性缺口）：一次**无人应答**的 claim 对话框，其读数必须
 * 自报**真实后果**。
 *
 * 真机现场：逐项勾选对话框无人应答，外层工具桥在 ~120s 中止了那次嵌套调用，
 * **调用方读到的只有「超时」**，而 claim 已经走完无人值守分支并落盘（roster 落定、
 * 14 条 pairs 转 provisional）。后果是「已换届」，不是「没做成」——两者在调用方读数上
 * 同形是缺陷本身（插件行为正确：attended-only、无无人值守变体是设计如此，§11.4.6）。
 *
 * 所以：**只有** timeout/abort 这一类拿到这句自作主张的读数（它必须能被单独读懂——调用方
 * 可能只读得到这一行），另外三类原因（服务缺席 / 服务没给出答案 / 对话框自己抛错）与所有
 * **失败**拒绝保持各自的原话不变，那条可分性由 `host-half.test.mjs` 的两条断言分别咬住。
 *
 * 「到期时刻」取自 {@link provisionalWindowExpiry}——与迁移行、窗口句同一个函数、同一个
 * `now`，不许在这里再算一遍。
 */
function unattendedClaimReading(state) {
	const { dialog, count, now } = state;
	const migrated = `全部 ${count} 条域内候选以 provisional 迁移`;
	if (dialog.cause !== ROTATION_DIALOG_CAUSES.TIMEOUT) return `${dialog.reason}（${migrated}。）`;
	return `${dialog.detail}——这不是「调用失败」：已按设计（§3.6.1 原则 4 的无人值守分支）把${migrated}，并已落盘（换届已成立、旧任信任已对称吊销；重试或等待都不会撤销它，也不必重试）。回退窗口 ${provisionalWindowExpiry(now)} 到期；到期前由人类在设置 UI 把该 pair 的 provisional 置 false 即转正式（attended-only：插件与模型都不能代批）。`;
}

/** §11.4.3 path of one hand-over document: `<workspace>/team/<name>/handoff-<role>-<YYYYMMDD-HHmmss>.md`.
 * `role` is validated `[A-Za-z0-9_-]+` and the stamp is digits and dashes only,
 * so no segment of the joined path can escape the captured workspace. */
function handoffDocumentPath(team, roleName, now) {
	return path.join(blackboardPaths(team).dir, `${HANDOFF_FILE_PREFIX}${roleName}-${timestamp(new Date(now))}.md`);
}

/** The hand-over documents already on disk for this team+role, oldest first.
 * Read from the DIRECTORY, not from memory: previous hand-overs may have been
 * written before this activation — which is exactly what makes this list the
 * durable half of §11.5's "did the plugin build this successor?" question.
 * @returns `{ files, error }` — `files` are base names; `error` is set only when
 *   the directory could not be read at all (an absent directory is empty). */
async function listHandoffDocuments(team, roleName) {
	const dir = blackboardPaths(team).dir;
	try {
		const entries = await readdir(dir);
		return { files: entries.filter((entry) => entry.startsWith(`${HANDOFF_FILE_PREFIX}${roleName}-`) && entry.endsWith(".md")).sort(), error: null };
	} catch (error) {
		if (error !== null && typeof error === "object" && error.code === "ENOENT") return { files: [], error: null };
		return { files: [], error: describeError(error) };
	}
}

/** The newest hand-over document already on disk for this team+role — the
 * §11.9.6 事实段's「上下一份交接文档路径」. */
async function latestHandoffDocument(team, roleName) {
	const listed = await listHandoffDocuments(team, roleName);
	const mine = listed.files;
	return { path: mine.length === 0 ? null : path.join(blackboardPaths(team).dir, mine[mine.length - 1]), error: listed.error };
}

/**
 * §11.5's durable half, one document at a time: does this hand-over document's
 * HEADER name `sessionId` as the successor? A pure text read of the `---` block at
 * the top (`renderHandoffDocument`'s header) — scanning only that block keeps a
 * BODY that happens to quote another rotation's header from being read as this
 * one's successor.
 *
 * The value is matched exactly. A header row is `key: value` and every session id
 * this plugin mints is a UUID or a `team-link-…` id — neither can be a prefix of
 * the other, so an exact comparison cannot mistake one id for another (and a
 * hand-edited file that puts prose after the id is treated as "not this swap"
 * rather than as a match).
 */
function handoffDocumentNamesSuccessor(text, sessionId) {
	if (typeof sessionId !== "string" || sessionId === "") return false;
	const header = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(String(text));
	if (header === null) return false;
	for (const line of header[1].split(/\r?\n/u)) {
		if (/^\s*successor\s*:/u.test(line) && line.slice(line.indexOf(":") + 1).trim() === sessionId) return true;
	}
	return false;
}

/**
 * §11.5's first durable source, resolved to a yes/no: does the NEWEST hand-over
 * document of this team+role name `sessionId` as its successor? Only the newest
 * one can — a token that is still pending is necessarily the latest prepare's, so
 * an id that appears only in an older document belongs to a swap that has already
 * been superseded, and reading it as this swap's successor would be a false
 * positive.
 *
 * @returns `{ named, error }` — `error` is set when the directory could not be
 *   read at all, in which case the caller must NOT read `named: false` as "the
 *   plugin built nothing".
 */
async function handoffDocumentNamesLatest(team, roleName, sessionId) {
	const listed = await listHandoffDocuments(team, roleName);
	if (listed.error !== null) return { named: false, error: listed.error };
	if (listed.files.length === 0) return { named: false, error: null };
	try {
		const text = await readFile(path.join(blackboardPaths(team).dir, listed.files[listed.files.length - 1]), "utf8");
		return { named: handoffDocumentNamesSuccessor(text, sessionId), error: null };
	} catch (error) {
		return { named: false, error: describeError(error) };
	}
}

/**
 * §11.9.6's three layers, rendered: the header the plugin writes (schema / team /
 * role / both session ids / preparedAt / claimedAt / the token MASK /
 * rotationStatus / the integrity verdict), the fact section the plugin writes
 * from {@link rotationFactRows} + {@link provisionalGuidance} (the same sources
 * the claim's own report reads), and the model's body — carried verbatim, because
 * it is the successor's whole context and the plugin has no business editing it.
 */
function renderHandoffDocument(request) {
	const report = request.report;
	const lines = [
		"---",
		`schema: ${HANDOFF_SCHEMA}`,
		`team: ${request.teamName}`,
		`role: ${request.roleName}`,
		`previous: ${request.previous ?? "（空缺）"}`,
		`successor: ${request.successor}`,
		`preparedAt: ${new Date(request.preparedAt).toISOString()}`,
		`claimedAt: ${HANDOFF_CLAIMED_PLACEHOLDER}`,
		`tokenMask: ${maskToken(request.token)}`,
		`rotationStatus: ${HANDOFF_STATUS_PREPARED}`,
		`integrity: ${handoffIntegrityLine(report)}`,
		"---",
		"",
		`# 交接文档：团队 ${request.teamName} 的角色 ${request.roleName}`,
		"",
		"## 事实段（插件写；与 claim 返回文案同一事实源，§11.9.6）",
		"",
		`- 退役者 → 继任者：${request.previous ?? "（空缺）"} → ${request.successor}（写入读数 ${readStamp(request.preparedAt)}）`,
		`- freeze 广播正文（与投出的 rotation-freeze 同一常量，§4.2）：${freezeNotice(request.teamName, request.roleName, request.previous ?? "（空缺）", request.successor, request.preparedAt)}`,
		"- freeze 投递结果（含 no-agent 未投递名单）：本文件先于广播写入，逐目标结果在 prepare 的返回里；换届落定后的汇总在 claim 的 rotation-done 广播行里。",
		`- 域内待迁移的 pairs（候选 ${request.facts.migration.length} 行）与未迁移清单：`,
		...request.facts.migration,
		...request.facts.dropped,
		`- ${request.facts.revocation[0] ?? "对称撤销（§3.6.1 原则 3）：（无记录）"}`,
		`- ${provisionalGuidance({ now: request.preparedAt, successor: request.successor, provisional: true, status: "" })}`,
		"- 上下一份交接文档：",
		request.previousDocument === null
			? "  - 上一份：（无——这是本团队本角色落盘的第一份交接文档）"
			: `  - 上一份：${request.previousDocument}`,
		"  - 下一份：（尚未写入——下一次换届生成新文件；本文件不追写，§11.4.3）",
		"",
		"## 正文（旧任模型撰写，插件原样保留）",
		"",
		request.body.trimEnd(),
		"",
	];
	return wellFormed(`${lines.join("\n")}`);
}

/**
 * Write one hand-over document (§11.4.3 / §11.9.6). The plugin writes it — no
 * new model-facing blackboard write face is added, so the write surface does not
 * grow. It is a single whole-file write, which is why the blackboard's 500-code-
 * point per-line bound does not apply here, and the timestamped name is why no
 * optimistic lock is needed.
 *
 * @returns `{ ok, path }` or `{ ok: false, error }` — the auto path treats a
 *   failure as abort-before-prepare (§11.9.6).
 */
async function writeHandoffDocument(team, request) {
	if (team.workspace === "") return { ok: false, error: "团队没有 workspace 记录，无法定位 <workspace>/team/<name>/handoff-*.md" };
	const previous = await latestHandoffDocument(team, request.roleName);
	try {
		const file = handoffDocumentPath(team, request.roleName, request.preparedAt);
		await mkdir(path.dirname(file), { recursive: true });
		// The team row is the authority for the team name (the same rule the header
		// rows follow): a caller cannot render a document about another team than the
		// one whose directory it lands in.
		await writeFile(file, renderHandoffDocument({ ...request, teamName: team.name, previousDocument: previous.path }), "utf8");
		return { ok: true, path: file, previousDocument: previous.path, previousError: previous.error };
	} catch (error) {
		return { ok: false, error: describeError(error) };
	}
}

// --- the rotation controller -------------------------------------------------

/**
 * Live rotation controller of one plugin context. `apply` is the only writer;
 * `host-half.test.mjs` reads it through {@link __testing} so the sweep can be
 * driven with an injected clock instead of waiting 24 hours.
 */
const ROTATION_BY_CTX = new WeakMap();

/**
 * The M4 two-phase hand-over (§3.6.2, line by line).
 *
 * `prepare` mints a one-time token bound to (team, role, successor), snapshots
 * the trust state for revocation and broadcasts the freeze; `claim` — only from
 * the successor session and only with that token — migrates the in-team pairs
 * through one confirmation dialog (or provisionally, when nobody is there to
 * confirm), revokes the outgoing holder symmetrically and settles the roster.
 * `sweep` is the expiry half (评审 #4/#5): it rides the watchdog patrol timer
 * and every roster touch, so a stranded token can never freeze a team forever.
 *
 * `extras.hasHandle` answers §11.5's ownership question for the CURRENT
 * activation (the plugin-held handle registry). It is deliberately only the
 * third source — {@link successorOwnershipOf} reads the durable hand-over
 * document and the durable pending-create intent first, because the registry is
 * empty after every reload while the sweep still runs on the reloaded state.
 */
function createRotation(ctx, policy, extras = {}) {
	/**
	 * Deliver one internal notice (§3.6.2 "内部广播路径"): the sender-side approval
	 * gate is skipped — the body is a plugin constant nobody can inject into — but
	 * the receiver's inbound policy and the explicit block list are honoured
	 * exactly as they are for a normal send, and it never opens a receiver
	 * confirmation dialog (§3.6.2 评审 #3 — the notice path is serial, so a dialog
	 * per recipient could overrun the caller's budget; an "ask" receiver is skipped
	 * with an explicit row by {@link deliverToTarget}).
	 *
	 * The sender identity is chosen by the caller and is always the session the
	 * notice is factually about: the caller of prepare/claim, or (for a sweep) the
	 * role's current holder — "旧任仍为 current" for a cancellation, the successor
	 * for an expiry. A caller that has no such identity (a vacant role) leaves the
	 * notice unsent and says so, rather than inventing a sender.
	 *
	 * The receivers are the team's incumbent members PLUS `options.alsoNotify`
	 * (§3.6.2 评审 #6): after a rotation the outgoing holder is no longer anyone's
	 * `current`, so the done/cancelled notice about that very hand-over would never
	 * reach the session it is about. An extra id joins only while it is still live
	 * (A4: nothing can wake a closed session) and never the sender.
	 */
	async function broadcastNotice(teamName, senderId, text, options = {}) {
		const team = policy.get().teams.find((entry) => entry.name === teamName) ?? null;
		if (team === null) return { rows: [`  - （团队 ${teamName} 不在注册表中，未广播）`], summary: "0 投递（团队不在注册表）" };
		if (senderId === undefined || senderId === null || senderId === "") {
			return { rows: ["  - （通知没有可用的发送方会话身份，未广播）"], summary: "0 投递（无发送方身份）" };
		}
		// §3.6.2 评审 #6: members first (a dead member keeps its no-agent row — the
		// roster is the record), then the outgoing holder the caller named, added
		// only while it still resolves to a live agent.
		const recipients = teamMembers(team).filter((id) => id !== senderId);
		for (const id of Array.isArray(options.alsoNotify) ? options.alsoNotify : []) {
			if (typeof id !== "string" || id === "" || id === senderId || recipients.includes(id)) continue;
			if (ctx.agents.get(id) === undefined) continue;
			recipients.push(id);
		}
		const rows = [];
		for (const target of recipients) {
			try {
				const outcome = await deliverToTarget(ctx, policy, { id: senderId }, { signal: options.signal }, target, text, null, {
					internal: true,
				});
				rows.push(`  - ${target} → ${outcome.outcome}：${preview(outcome.text, 200)}`);
			} catch (error) {
				rows.push(`  - ${target} → refused：通知投递异常（${describeError(error)}）`);
			}
		}
		if (recipients.length === 0) rows.push("  - （团队成员只有发起者自身，无需广播）");
		return { rows, summary: noticeSummary(rows) };
	}

	/** The one dialog of a claim (§3.6.1 principle 4): all candidate pairs in a
	 * single request, per-item selection, one batch submission.
	 *
	 * Every un-answered branch names its CAUSE ({@link ROTATION_DIALOG_CAUSES}), and
	 * the timeout class carries no `reason` sentence at all: its reading is built by
	 * {@link unattendedClaimReading}, where the clock and the candidate count are
	 * both known — a timeout must self-report the change it committed (缺口1). */
	async function askRotationDialog(request) {
		const userQuestions = ctx.get?.("userQuestions");
		if (userQuestions === undefined || typeof userQuestions.ask !== "function") {
			return { answered: false, cause: ROTATION_DIALOG_CAUSES.UNAVAILABLE, reason: "确认服务（userQuestions）不可用——按无人值守路径处理：全部域内 pairs 以 provisional 迁移，24h 内未批准自动回退。" };
		}
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, ROTATION_CONFIRM_TIMEOUT_MS);
		timer.unref?.();
		const forward = () => controller.abort();
		request.signal?.addEventListener?.("abort", forward);
		try {
			const answer = await userQuestions.ask({
				questions: [{
					id: ROTATION_DIALOG_ID,
					header: "换届信任迁移确认",
					question: wellFormed(request.question),
					detail: wellFormed(request.detail),
					options: request.candidates.map((candidate) => ({
						label: candidate.other,
						description: `对端会话 ${candidate.other}（pairs 建立于 ${readStamp(candidate.pair.createdAt)}）——勾选则迁移为 ${request.successor} ↔ ${candidate.other}`,
					})),
					multiSelect: true,
				}],
				agent: request.agent,
				signal: controller.signal,
			});
			const item = Array.isArray(answer?.answers) ? answer.answers.find((entry) => entry?.id === ROTATION_DIALOG_ID) : undefined;
			if (item === undefined || !Array.isArray(item.selected)) {
				return { answered: false, cause: ROTATION_DIALOG_CAUSES.NO_ANSWER, reason: "对话框没有返回本次换届问题的答案——按未确认处理：全部域内 pairs 以 provisional 迁移，24h 内未批准自动回退。" };
			}
			const keys = new Set();
			const claimed = new Set();
			for (const label of item.selected) {
				const index = request.candidates.findIndex((candidate, position) => !claimed.has(position) && candidate.other === label);
				if (index === -1) continue;
				claimed.add(index);
				keys.add(pairKey(request.candidates[index].pair));
			}
			return { answered: true, selected: keys };
		} catch (error) {
			// The abort/timeout class is NOT the dialog failing (真机 2026-09-20): the
			// caller stopped waiting, and the unattended branch below is about to commit
			// a real change. It therefore gets its own cause — and its reading is built
			// where the clock and the candidate count are known ({@link
			// unattendedClaimReading}), never here.
			if (timedOut || dialogNoAnswerError(error, request.signal)) {
				return {
					answered: false,
					cause: ROTATION_DIALOG_CAUSES.TIMEOUT,
					detail: timedOut
						? `换届确认对话框 ${Math.round(ROTATION_CONFIRM_TIMEOUT_MS / 60000)} 分钟内未获应答（超时；无人在场）`
						: `换届确认对话框未获应答（调用方中止：${describeError(error)}）`,
				};
			}
			return {
				answered: false,
				cause: ROTATION_DIALOG_CAUSES.FAILED,
				reason: `换届确认对话框失败（${describeError(error)}）——按无人值守路径处理：全部域内 pairs 以 provisional 迁移，24h 内未批准自动回退。`,
			};
		} finally {
			clearTimeout(timer);
			request.signal?.removeEventListener?.("abort", forward);
		}
	}

	/** Phase A (§3.6.2). @returns `{ lines, token }` or `{ error }`. */
	async function prepare(request) {
		const { teamName, roleName, successor, note, caller, now } = request;
		const view = policy.get();
		const admission = prepareAdmission(view, { teamName, roleName, successor, now, caller, userInitiated: request.recovery !== undefined && request.recovery !== null });
		if (admission.error !== undefined) return { error: admission.error };
		const { team, entry } = admission;
		// §11.4.3: the auto path needs one step of look-ahead — the hand-over
		// document is written BEFORE this call (§11.9.6 abort-before-prepare) and its
		// header carries the token MASK, so that path mints the token itself and
		// hands it in here. A token that never reaches this line is never persisted,
		// never issued and never frozen — the manual callers pass none and keep the
		// historical behaviour byte for byte.
		const token = typeof request.token === "string" && request.token !== "" ? request.token : randomUUID();
		const pending = { session: successor, token, team: teamName, role: roleName, expiresAt: now + ROTATION_TTL_MS, createdAt: now, migratedPairs: [] };
		if (note !== undefined) pending.note = note;
		const backup = {
			at: now,
			pairs: view.pairs.map((pair) => ({ ...pair })),
			trustedSenders: [...view.trustedSenders],
			rememberTargets: [...view.rememberTargets],
			roster: structuredClone(team),
		};
		const nextTeam = { ...team, rotationBackup: backup, roles: team.roles.map((record) => (record.role === roleName ? { ...record, pending } : record)) };
		// §11.9.5⑦'s first audit trail rides THIS write when the caller is the
		// recovery tool (`recovery` is absent for every ordinary caller, whose
		// behaviour stays byte-identical): bundling it with the pending means a
		// recovery can never leave a token on disk with no record of who minted it.
		const mergedTeam = request.recovery === undefined || request.recovery === null
			? nextTeam
			: withRecoveryRow(nextTeam, roleName, {
				verb: request.recovery.verb,
				at: now,
				by: request.recovery.by ?? "",
				from: request.recovery.from ?? null,
				to: successor,
				note: note ?? recoveryNote(request.recovery.verb, request.recovery.by),
			});
		try {
			await policy.update({ teams: view.teams.map((record) => (record.name === teamName ? mergedTeam : record)) });
		} catch (error) {
			return { error: `prepare 失败：写入设置失败（${describeError(error)}）——未生成令牌，也未广播冻结。` };
		}
		const mirror = await writeRosterMirror(mergedTeam);
		const notice = await broadcastNotice(teamName, caller, freezeNotice(teamName, roleName, caller, successor, now), { signal: request.signal });
		return {
			token,
			lines: [
				`换届包已就绪：团队 ${teamName} 的角色 ${roleName}，现任 ${entry.current} → 继任者 ${successor}（读数 ${readStamp(now)}）。`,
				`令牌（一次性，30 分钟内有效）：${token}`,
				`此后一切渲染都是掩码形式 ${maskToken(token)}——完整令牌只在本条返回里出现这一次（roster get 与 roster.md 镜像都只给掩码）。`,
				`把令牌随交接 prompt 交给 ${successor}（交接内容——prompt / 交接文档——由你起草：机制与判断分离，§3.6.2）。`,
				`继任者拿到令牌后调用：team_link_rotate action=claim，team=${teamName}，role=${roleName}，token=<令牌>。`,
				`提交时间与状态（§3.6.1 原则 1）：令牌绑定 (team, role, successor)，30 分钟 TTL；过期未认领由清扫自动取消并解除冻结；成功认领后立即作废。`,
				"提示继任者：上任首个动作建议 /goal resume 或新建 goal（armed-active = 内建心跳，防重蹈 00:31 的静默；插件绝不代调 goals.resume，§3.7 合规 resume 回路）。",
				"错峰默认（§3.6.1）：先换协调者 → 稳定 → 再换 worker——任何时刻保留一个活记忆（纪律与协议上下文是最贵的重建物）。一次全换之前必须先跑上面的 FREEZE 清单，并把交接文档落盘。",
				`自建继任者（§11.2 / §11.4.2）：successor 可以写 "auto" —— 插件自建一个根会话（agents.create 公开可用；meta 只放 cwd、不含血统字段，ownership 语义见 §10.2.5）、把你的 handoff 正文写成 <workspace>/team/${teamName}/handoff-${roleName}-<时间戳>.md（头部 + 事实段 + 正文），再铸令牌并用 followup 把令牌与交接正文投给继任者（不是 inject）。该路径需要一个确认框（§11.4.1）与五硬节正文（§11.9.6），正文缺失或缺硬节会在建会话之前就被拒绝。手工路径照旧可用：先在壳里新建会话、用 team_link_list_sessions 取它的会话 id 后重新 prepare。`,
				`撤销依据（rotationBackup）：已快照 ${now} 时的 pairs ${backup.pairs.length} 条 / trustedSenders ${backup.trustedSenders.length} 项 / rememberTargets ${backup.rememberTargets.length} 项与 roster。`,
				`冻结广播（rotation-freeze 固定清单）：${notice.summary}`,
				...notice.rows,
				mirrorNote(mirror),
			],
		};
	}
	/** The idempotent replay of a claim that already settled the roster (§3.6.2).
	 * The settlement (with its migratedPairs marker) is written in ONE update and
	 * the pending is cleared in the next, so a pending that survives next to a
	 * settled roster proves the previous claim did not finish its last step: the
	 * pairs are migrated, the roster is settled, and the only things left are the
	 * bookkeeping and — at worst — the rotation-done notice the team waits on to
	 * leave the freeze. The notice is therefore re-emitted here (at-least-once,
	 * never a second migration); a duplicate notice is noise, a missing one keeps
	 * workers frozen.
	 *
	 * 评审 #1 decides what "settled" means: `current === pending.session`. The
	 * migratedPairs marker is NOT the signal — a migration can legitimately add no
	 * record at all (no in-domain candidate, or every checked counterpart already
	 * paired with the successor), and that empty marker must not be mistaken for an
	 * unclaimed token. 评审 #4: the replay is the step that finishes the
	 * bookkeeping, so it rewrites the roster mirror too. */
	async function replayClaim(request) {
		const { teamName, roleName, entry, pending, now } = request;
		const view = policy.get();
		const settled = entry.current === pending.session;
		const clearedTeams = view.teams.map((record) => (record.name === teamName ? clearRotationPending(record, roleName) : record));
		let cleared = true;
		try {
			await policy.update({ teams: clearedTeams });
		} catch (error) {
			cleared = false;
		}
		// The outgoing holder is read from the revocation snapshot the prepare took
		// (the settled history no longer names it unambiguously): never invented.
		const snapshot = view.teams.find((record) => record.name === teamName)?.rotationBackup?.roster ?? null;
		const previousId = (snapshot?.roles ?? []).find((record) => record.role === roleName)?.current ?? null;
		const previous = previousId ?? "（旧任，见 rotationBackup）";
		const migrated = pending.migratedPairs ?? [];
		// 评审 #5 decided which words exist; 评审 #10 decides where they come from.
		// The claim recorded its verdict word on the role when it settled, so the
		// replay reads it back. Re-deriving it here was lossy: a dialog answered with
		// every candidate unchecked is ratified (已批准) yet migrates nothing and
		// opens no window, and the old derivation replayed it as 无待迁移对 — a
		// different word about the same rotation, which the waiting team reads.
		const status = rotationStatusOf(entry, migrated);
		const notice = settled
			? await broadcastNotice(teamName, pending.session, doneNotice(teamName, roleName, previous, pending.session, status, now), { signal: request.signal, alsoNotify: [previousId] })
			: { rows: ["  - （现任已另行变更，不再重复广播 rotation-done）"], summary: "0 投递（换届已被后续变更取代）" };
		const mirrorSource = (cleared ? clearedTeams : view.teams).find((record) => record.name === teamName);
		const mirror = mirrorSource === undefined ? { ok: false, error: `团队 ${teamName} 不在注册表中` } : await writeRosterMirror(mirrorSource);
		return {
			lines: [
				`claim 重放（同一令牌）：团队 ${teamName} 的角色 ${roleName} 的这次换届已由上一次 claim 完成落定——本次不重复迁移、不重复改动信任数据，只收尾。`,
				`已迁移的通道（${migrated.length} 条，记录来自 pending.migratedPairs）：`,
				...(migrated.length === 0
					? ["  - （无：上次 claim 没有迁移任何 pair——域内没有候选，或对端与继任者本已配对）"]
					: migrated.map((pair) => `  - ${pair.b} ↔ ${pair.a}（${pair.provisional ? "provisional，到期 " + readStamp(pair.expiresAt) : "正式通道"}）`)),
				`现任：${entry.current ?? "（空缺）"}（pending 记录的继任者 ${pending.session}）。`,
				cleared ? "pending 已清除（本次收尾完成）。" : "pending 清除失败：写入设置失败——重试 claim 即可（仍不会重复迁移）。",
				settled
					? `本轮通知：rotation-done 重发（${notice.summary}）。`
					: "本轮不广播 rotation-done：现任已不是这次换届的继任者，重发会与事实矛盾。",
				...notice.rows,
				mirrorNote(mirror),
				`（读数 ${readStamp(now)}，${READ_STALE_NOTE}）`,
			],
		};
	}

	/** Phase B (§3.6.2). @returns `{ lines }` or `{ error }`. */
	async function claim(request) {
		const { teamName, roleName, token, note, caller, now } = request;
		const view = policy.get();
		const team = view.teams.find((entry) => entry.name === teamName) ?? null;
		if (team === null) return { error: `claim 失败：团队 ${teamName} 不在注册表中。` };
		const entry = roleOf(team, roleName);
		if (entry === null) return { error: `claim 失败：团队 ${teamName} 没有角色 ${roleName}。` };
		const pending = entry.pending;
		if (pending === null || pending === undefined) {
			return { error: `claim 失败：团队 ${teamName} 的角色 ${roleName} 当前没有 pending——令牌尚未 prepare、已过期被清扫、或本次换届已认领成功并作废（§3.6.1 原则 1：成功即作废）。` };
		}
		if (pending.team !== teamName || pending.role !== roleName) {
			return { error: `claim 失败：令牌绑定不匹配——pending 绑定的是 (team=${pending.team}, role=${pending.role})，本次调用是 (team=${teamName}, role=${roleName})。令牌绑定三元组 (team, role, successor)，不匹配一律拒绝（§3.6.1 原则 1）。` };
		}
		if (caller === undefined || caller !== pending.session) {
			return { error: `claim 失败：只有 pending 指定的继任者会话 ${pending.session} 可以认领（当前调用会话 ${caller ?? "（无会话身份）"}）——主张权靠令牌，且必须由继任者会话本身发起（§3.6.1 原则 1）。` };
		}
		if (token !== pending.token) {
			return { error: "claim 失败：令牌不匹配（令牌一次性，只在 prepare 的返回里给出过一次；掩码形式 tok-xxxx…yyyy 不是令牌）。" };
		}
		// 评审 #1: the settled signal is `current === pending.session`, and it is read
		// here (before the expiry branch) because the two states it splits have
		// opposite truths — an unclaimed token is cancelled, a settled roster with a
		// stranded pending only needs its bookkeeping finished.
		const settled = entry.current === pending.session;
		if (pending.expiresAt > 0 && pending.expiresAt <= now) {
			// §3.6.2 评审 #4: an unclaimed token may not leave the team frozen —
			// run the cancellation for exactly this role, then refuse. The refusal
			// states what the sweep actually did: a settled roster is cleared
			// silently (nothing was cancelled), so it must not be described as a
			// cancelled hand-over that left the old incumbent in place.
			const swept = await sweep({ now, signal: request.signal, only: { team: teamName, role: roleName } });
			const tail = swept.lines.length === 0 ? "" : `\n${swept.lines.join("\n")}`;
			return { error: settled
				? `claim 失败：令牌已过期（到期 ${readStamp(pending.expiresAt)}，30 分钟有效）——但这次换届其实已经落定：current 已是继任者 ${pending.session}，只是 pending 残留（上次 claim 的最后一步没写完）。已按落定态静默清除 pending（不广播 rotation-cancelled——「换届未发生」与事实相反），冻结在落定那一刻就已解除。无需重新 prepare（换届已完成）；如果确实要再换一次，请由现任重新 prepare。${tail}`
				: `claim 失败：令牌已过期（到期 ${readStamp(pending.expiresAt)}，30 分钟有效）。已按过期清扫取消本次换届并广播 rotation-cancelled——旧任 ${entry.current} 仍为 current，冻结解除。${tail}请由现任重新 prepare。` };
		}

		const migrated = Array.isArray(pending.migratedPairs) ? pending.migratedPairs : [];
		// §3.6.2 评审 #1: a non-empty marker is not the only proof that the previous
		// claim already settled. A migration that added no record (no in-domain
		// candidate, or every checked counterpart already paired with the successor)
		// leaves `migratedPairs` empty, and re-running the migration path in that
		// state would treat the successor as the retiree and revoke the successor's
		// own pairs. `current === pending.session` cannot hold for a fresh pending
		// (prepare refuses a self-succession), so it is the settled signal.
		if (migrated.length > 0 || settled) {
			return await replayClaim({ teamName, roleName, team, entry, pending, now, signal: request.signal });
		}

		// ---- the single rotation dialog (§3.6.1 principle 4) ------------------
		const members = new Set(teamMembers(team));
		const plan = planRotationMigration(view, { members, retiree: entry.current, successor: pending.session });
		const exclusions = plan.dropped.length === 0
			? "退役者与团队外没有任何 pairs，全部相关 pairs 都在本次确认范围内。"
			: `以下 ${plan.dropped.length} 条 pairs 与退役者相关但不在迁移范围（随退役清理，不迁移）：${plan.dropped.map((item) => `${item.other}（${item.reason}）`).join("；")}。`;
		let ratified;
		let chosen;
		let ratification;
		if (plan.candidates.length === 0) {
			// 评审 #5: there is nothing to ratify, so no dialog is raised and no
			// approval is claimed — the status word says exactly that (below).
			ratified = true;
			chosen = [];
			ratification = "无域内待迁移对：未弹确认框（没有需要迁移的通道，因此没有任何确认被征求），全部与退役者相关的 pairs 随退役清理。";
		} else {
			const dialog = await askRotationDialog({
				candidates: plan.candidates,
				successor: pending.session,
				agent: request.agent,
				signal: request.signal,
				question: `团队 ${teamName} 的角色 ${roleName} 交接到 ${pending.session}（旧任 ${entry.current}）。勾选要迁移给新任的免确认通道（pairs）；未勾选的通道将随退役清理，今后该对端走正常首问门（发送方确认 + 接收方策略）。`,
				detail: `迁移后的通道是双向免确认通道，会绕过两道批准门——所以只迁移你确实要保留的对。候选 ${plan.candidates.length} 条，对端必须是本团队成员。${exclusions}`,
			});
			if (dialog.answered) {
				ratified = true;
				chosen = plan.candidates.filter((candidate) => dialog.selected.has(pairKey(candidate.pair)));
				ratification = `已获在场确认（单个对话框，逐项勾选 + 整批提交）：勾选 ${chosen.length} / 候选 ${plan.candidates.length} 条，迁移为正式通道（provisional=false）。`;
			} else {
				ratified = false;
				chosen = [...plan.candidates];
				// 缺口1: an unanswered dialog is a WRITE, and the timeout class has to say
				// so on the line a caller may be reading alone.
				ratification = unattendedClaimReading({ dialog, count: plan.candidates.length, now });
			}
		}
		const provisional = !ratified;
		const selectedKeys = new Set(chosen.map((candidate) => pairKey(candidate.pair)));
		// The hand-over note: the claim's own note wins, the one prepare carried
		// through the pending is the fallback (§3.6.2 "history 追加（旧任 until=now+note）").
		const effectiveNote = note ?? pending.note;
		// §3.6.2 评审 #5 / #10: the verdict word is decided HERE — where the dialog
		// outcome and the candidate count are both still known — and handed to the
		// settlement, which records it on the role. A later replay reads the recorded
		// word instead of re-deriving it from state that cannot tell "a dialog was
		// answered with nothing checked" from "there was never a candidate".
		const status = plan.candidates.length === 0 ? ROTATION_STATUS_NONE : ratified ? "已批准" : "待批准(24h)";
		const trust = applyRotationTrust(view, { retiree: entry.current, successor: pending.session, chosen, now, provisional });
		const settlement = settleRotation(team, { role: roleName, now, note: effectiveNote, migratedPairs: trust.additions, provisional, status });
		const teams = view.teams.map((record) => (record.name === teamName ? settlement.team : record));
		try {
			// One write carries the trust lists AND the settled roster (with the
			// migratedPairs marker): the marker can therefore never exist without the
			// settlement, which is what makes the replay path below sound.
			await policy.update({ pairs: trust.pairs, trustedSenders: trust.trustedSenders, rememberTargets: trust.rememberTargets, teams });
		} catch (error) {
			return { error: `claim 失败：写入设置失败（${describeError(error)}）——迁移与落定是同一笔写入，本次没有产生任何变更；可用同一令牌重试。` };
		}
		let bookkeeping = "pending 已清除（migratedPairs 先落盘再清，崩溃重试走重放路径）。";
		const clearedTeams = teams.map((record) => (record.name === teamName ? clearRotationPending(record, roleName) : record));
		let cleared = true;
		try {
			await policy.update({ teams: clearedTeams });
		} catch (error) {
			cleared = false;
			bookkeeping = `pending 清除失败（${describeError(error)}）：迁移与落定已生效，pending 里留着 migratedPairs 记录——用同一令牌重放 claim 即完成收尾（不会重复迁移）。`;
		}
		// 评审 #4: the mirror is rendered from the roster the claim leaves behind, not
		// from the pre-clear copy — otherwise roster.md keeps advertising a pending
		// that no longer exists (the settings namespace, always the source of truth,
		// has none). When the clear itself failed the mirror stays truthful instead
		// and shows the pending that really is on disk; the next roster change
		// rewrites it anyway (§3.3.1 best-effort).
		const mirrorSource = (cleared ? clearedTeams : teams).find((record) => record.name === teamName) ?? settlement.team;
		const mirror = await writeRosterMirror(mirrorSource);
		// 评审 #6: the retiree is no longer anyone's `current`, so without the union it
		// would never learn that the hand-over it prepared actually completed.
		const notice = await broadcastNotice(teamName, pending.session, doneNotice(teamName, roleName, settlement.previous ?? "（旧任）", pending.session, status, now), { signal: request.signal, alsoNotify: [settlement.previous] });
		// §11.9.6「不可两处口径」: the migration / dropped / revocation rows and the
		// provisional sentence come from the SAME builders the hand-over document's
		// 事实段 renders. Nothing here re-spells them.
		const facts = rotationFactRows({
			retiree: entry.current,
			successor: pending.session,
			candidates: plan.candidates,
			selectedKeys,
			additions: trust.additions,
			dropped: plan.dropped,
			provisional,
			removedCount: trust.removed.length,
			migratedCount: trust.additions.length,
			revoked: { trustedSenders: trust.revoked.trustedSenders.length, rememberTargets: trust.revoked.rememberTargets.length },
		});
		return {
			lines: [
				`换届完成（claim）：团队 ${teamName} 的角色 ${roleName}，旧任 ${settlement.previous} → 新任 ${pending.session}（读数 ${readStamp(now)}）。`,
				`信任迁移（域限定：仅「退役者 ↔ 同 team 成员」，§3.6.1 原则 2）：`,
				...facts.migration,
				...facts.dropped,
				`${facts.revocation[0]}`,
				`批准状态：${ratification}`,
				`roster 落定：${roleName}.current = ${pending.session}；版本史新增旧任 until=${readStamp(now)}${effectiveNote === undefined ? "" : `（备注：${preview(effectiveNote, 200)}）`}；${bookkeeping}`,
				provisionalGuidance({ now, successor: pending.session, provisional, status }),
				`通知广播（rotation-done，新任为发送方）：${notice.summary}`,
				...notice.rows,
				mirrorNote(mirror),
				`（读数 ${readStamp(now)}，${READ_STALE_NOTE}）`,
			],
		};
	}

	/**
	 * The expiry half of §3.6.2 (评审 #4/#5), hung on the same patrol timer as the
	 * M1 watchdog and touched lazily by every roster touch, rotate call and team
	 * read. It cancels a pending nobody claimed inside its 30 minutes (which
	 * releases the freeze), and closes a provisional window whose 24h ratification
	 * window ran out.
	 *
	 * The notice sender is the role's current holder — "旧任仍为 current" for a
	 * cancellation, and the successor for an expiry — because that is the session
	 * the notice is factually about, and it is the identity the receivers' gates
	 * (pairing / trustedSenders) were already established against. A leftover
	 * pending whose role is already settled is only bookkeeping: it is cleared
	 * silently, because the CANCELLED notice would state the opposite of the truth.
	 *
	 * @returns `{ cancelled, expired, closed, lines }` — the three actions the pass
	 *   took (a cancellation, a rollback, a silent window close), so a caller can
	 *   assert on the decision and not only on its text. 评审 #8 adds a fourth,
	 *   unconditional one: every expired provisional pair is deleted even when no
	 *   role needed bookkeeping (a hand-deleted window leaves that as the only work).
	 */
	async function sweep(options = {}) {
		const now = typeof options.now === "number" ? options.now : Date.now();
		const only = options.only ?? null;
		const except = options.except ?? null;
		const view = policy.get();
		const cancelled = [];
		const expired = [];
		const closed = [];
		// §3.6.2 评审 #1: a settled pending is cleared with no notice and no row, so it
		// is invisible in the three lists above — without this flag the pass would
		// return before writing and the pending would come back on the next read.
		// 评审 #8: this flag guards the TEAMS write only; the doomed-pair deletion
		// below is decided on its own and must not depend on any role bookkeeping.
		let touched = false;
		const teams = view.teams.map((team) => ({ ...team, roles: team.roles.map((entry) => ({ ...entry })) }));
		for (const team of teams) {
			if (only !== null && team.name !== only.team) continue;
			for (const entry of team.roles) {
				if (only !== null && entry.role !== only.role) continue;
				if (except !== null && except.team === team.name && except.role === entry.role) continue;
				const pending = entry.pending;
				if (pending !== null && pending !== undefined && pending.expiresAt > 0 && pending.expiresAt <= now) {
					// §3.6.2 评审 #1: `current === pending.session` alone is the settled
					// signal. A rotation whose migration added no record (no in-domain
					// candidate, or every checked counterpart already paired with the
					// successor) leaves `migratedPairs` empty, so requiring a non-empty
					// marker would read a settled roster as an unclaimed token and
					// broadcast the exact opposite of the truth ("旧任仍为 current").
					const settled = entry.current === pending.session;
					entry.pending = null;
					touched = true;
					if (!settled) {
						// §3.6.2 评审 #6: the session the hand-over was prepared for, read
						// from the revocation snapshot (never invented). For a plain
						// cancellation it is the role's current holder again — already a
						// member and the sender of this notice — so the union only bites
						// when set-role moved the role on while the token was in flight.
						const backupRoles = team.rotationBackup?.roster?.roles;
						const snapshotIncumbent = (Array.isArray(backupRoles) ? backupRoles.find((record) => record.role === entry.role)?.current : null) ?? null;
						cancelled.push({ team: team.name, role: entry.role, incumbent: entry.current, caller: pending.session, snapshotIncumbent });
					}
				}
				const provisional = entry.provisional;
				if (provisional !== null && provisional !== undefined && provisional.expiresAt > 0 && provisional.expiresAt <= now) {
					const successor = provisional.session !== "" ? provisional.session : entry.current;
					entry.provisional = null;
					touched = true;
					// §3.6.2 评审 #2: the window only has something to roll back while
					// its migration is STILL provisional and past its deadline.
					// Ratifying is a settings-UI edit that flips `pair.provisional`
					// alone (README「补批准」), so the role's window can run out with
					// nothing left to delete — and then both the version-history entry
					// and the rotation-expired notice ("迁移的 pairs 已删除") would be
					// false. That case closes the window silently: no history entry,
					// no broadcast, because no rollback happened and the plugin never
					// observed the ratification it would have to name.
					if (doomedProvisionalPairs(view.pairs, successor, now).length === 0) {
						closed.push({ team: team.name, role: entry.role, successor });
					} else {
						const history = entry.history.map((record) => ({ ...record }));
						history.push({ session: successor ?? "（未知）", from: provisional.at, until: now, note: ROTATION_PROVISIONAL_NOTE });
						entry.history = history;
						expired.push({ team: team.name, role: entry.role, successor });
					}
				}
			}
		}
		// §3.6.2 评审 #8: the doomed pairs are computed BEFORE the write guard, and
		// deleted whether or not the pass found any role bookkeeping to do. A user can
		// hand-delete a role's `provisional` window (or the whole role/team row) in the
		// settings UI while the pairs it granted stay behind: the loop above then sets
		// nothing, `touched` stays false, and the old early return let the expired
		// channel survive forever — still riding the pair fast path and still bypassing
		// both gates, which is exactly the "24h 自动回退" promise going silently false.
		const doomed = view.pairs.filter((pair) => isExpiredProvisionalPair(pair, now));
		const patch = {};
		if (touched) patch.teams = teams;
		if (doomed.length > 0) {
			const keys = new Set(doomed.map(pairKey));
			patch.pairs = view.pairs.filter((pair) => !keys.has(pairKey(pair)));
		}
		if (Object.keys(patch).length === 0) return { cancelled, expired, closed, lines: [] };
		try {
			await policy.update(patch);
		} catch (error) {
			return { cancelled: [], expired: [], closed: [], lines: [`换届过期清扫写入失败（${describeError(error)}）：本次未生效，下次巡逻/roster 触碰会重试。`] };
		}
		const lines = [];
		// §11.5's naming question is resolved BEFORE the report loop, from the
		// durable sources first (see {@link successorOwnershipOf}): a plugin reload
		// empties the handle registry while the hand-over document and the
		// pending-create intent stay on disk, so a handle-only reading would drop
		// the naming line in exactly the window it exists for.
		const ownership = cancelled.length === 0 ? new Map() : await successorOwnershipIndex(cancelled, policy, extras.hasHandle);
		for (const item of cancelled) {
			// §3.6.2 评审 #6: the recipients are the members UNION the session the
			// hand-over was prepared for (see the push above) — the freeze was raised
			// at that session's request, so its release belongs in its inbox too.
			const notice = await broadcastNotice(item.team, item.incumbent, cancelledNotice(item.team, item.role, item.incumbent ?? "（空缺）", item.caller, now), { signal: options.signal, alsoNotify: [item.snapshotIncumbent] });
			lines.push(`- 令牌过期取消：团队 ${item.team} 的角色 ${item.role}（旧任 ${item.incumbent ?? "（空缺）"} 仍为 current，已广播 rotation-cancelled：${notice.summary}）`);
			lines.push(...notice.rows);
			// §11.5: a successor the PLUGIN created must never become an unknown
			// orphan — it exists on disk because of this hand-over and nobody has
			// claimed it, so the cancellation report names it (the manual path's
			// successor is the user's own session and stays out of this line).
			const attributed = ownership.get(`${item.team}\u0000${item.role}`);
			if (attributed !== undefined && attributed.pluginCreated === true) {
				lines.push(`- 本次换届由插件新建的继任者会话 ${item.caller} 仍存活但未认领，可收编或关闭（§11.5：自建继任者必须被点名，否则它会变成一个没人知道的孤儿；判据取自${ownershipEvidenceLabel(attributed.evidence)}——不依赖本激活窗口的内存态）。`);
			}
		}
		for (const item of expired) {
			const notice = await broadcastNotice(item.team, item.successor, expiredNotice(item.team, item.role, item.successor ?? "（空缺）", now), { signal: options.signal });
			lines.push(`- provisional 未批准回退：团队 ${item.team} 的角色 ${item.role}（迁移的 pairs 已删除，${item.successor ?? "（空缺）"} 仍为 current，已广播 rotation-expired：${notice.summary}）`);
			lines.push(...notice.rows);
		}
		for (const item of closed) {
			lines.push(`- provisional 窗口静默关闭：团队 ${item.team} 的角色 ${item.role}（域内已无待回退的 provisional pair——迁移已转正式、或本次换届本就没有新建通道；未记版本史、未广播 rotation-expired）`);
		}
		return { cancelled, expired, closed, lines };
	}

	return { prepare, claim, sweep, broadcastNotice };
}

// ---------------------------------------------------------------------------
// §11.9.4/§11.9.5 recovery — `team_link_recover`, exactly two closed verbs
// ---------------------------------------------------------------------------
//
// THREE POWERS, KEPT APART (design §11.9.5). Authoring a recovery is not the same
// as authorizing one, and neither is the same as performing one:
//
//   initiator  — whoever calls the tool. It only gets to ASK.
//   authority  — the human's click in the dialog, and nothing else. `userQuestions`
//                answers can only come from the UI, so a model cannot answer its
//                own box; an absent confirmation service is FAIL-CLOSED, and there
//                is deliberately NO provisional/unattended variant. The asymmetry
//                with M4's claim is the point: a pair migration can be rolled back
//                by the sweep, an INCUMBENCY cannot — writes an illegitimate
//                holder makes are already facts.
//   execution  — L2 hands the whole job to the published M4 mechanism. `reappoint`
//                is literally a prepare the human authorized in this dialog, so it
//                inherits every boundary prepare has (token binding, 24h rollback,
//                domain-limited migration, symmetric revocation) and can grant
//                nothing prepare could not.
//
// The boundary argument, in one sentence (会诊 #43 K): ANY action gated by a human
// confirmation box has the SETTINGS UI SUPER-WRITER as its permission ceiling —
// that party can already change everything, with no audit at all — so a recovery
// can only ever NARROW the existing human permission into a smaller, more
// auditable form. Back doors can only come from the part that BYPASSES the human,
// which is why every one of the eight constraints below is about not bypassing.

/** The closed verb set (§11.9.5①) — the single auditable landing point that makes
 * «只有两个动词» a checkable property instead of a promise. */
const RECOVERY_ACTIONS = new Set(["revive", "reappoint"]);
/** §11.9.5⑦'s anti-storm window. Recovery inherits M4's 10-minute rotation window
 * (the role path already knows how to say "the same role, too soon"), which is
 * what keeps a blocked member from machine-gunning the dialog. */
const RECOVERY_RATE_LIMIT_MS = ROTATION_RATE_LIMIT_MS;
/** The ONE answer that lets a `revive` run; everything else (the cancel option, an
 * unanswered dialog, a timeout, a missing confirmation service) is fail-closed. The
 * candidate dialog of `reappoint` names its own answer set — its options ARE the
 * candidates — so it needs no label constants of its own. */
const RECOVER_CONFIRM_LABEL = "执行恢复";
const RECOVER_CANCEL_LABEL = "取消";
const RECOVER_DIALOG_ID = "recovery-confirm";

/** §11.9.5②/⑧, in the caller's terms, printed wherever recovery refuses: the two
 * ways it must never be "helped" are named here so a reader cannot mistake either
 * for an oversight. */
function recoveryBoundaryText() {
	return "恢复刻意只做两件事，且刻意不给自己留别的路：① 动词封闭（只有 revive / reappoint，不接受任意 roster 字段写入）；② attended-only（必须有人在对话框里点一下，没有 provisional、没有 TTL、没有无人值守降级，无确认服务即 fail-closed——与 M4 claim 的不对称是刻意的：pair 迁移可被清扫自动回退，而 incumbency 不可）；③ 候选由插件从**活成员 ∪ 常驻的「自建继任者（新建会话）」**计算，模型不能指定继任者 id；④ revive 只绑当前 current（不存在「复活任意历史会话」）；⑤ writerGate 原样不动；⑥ 绝不把 policy.writer 降级为 any 当作「修复」——那是对团队的静默弱化，属于被拒绝的做法。另有三权分开（§11.9.5）：**发起** ∈ {该角色最近一任前任} ∪ {团队现任成员}（发起权不依赖信任、只依赖身份资格），**授权** 唯一来源是对话框里人类那一下点击，**复权** 由执行侧的 fail-closed 保证——域外的会话被拒绝时，设置 UI（R2 级，用户在那里是超级写者）仍是永远可用的出口。";
}

/** §11.9.4's L1/L2 boundary in the caller's terms: which emptiness this call is
 * about, and the one thing that decides it. */
function vacancyKindText(entry) {
	if (entry === null) return "该角色不在 roster 中";
	if (entry.current === null) return `${VACANT_LABEL}（current=null，刻意空缺：由 retire 或设置 UI 造出来的显式表达）`;
	return `${SEATED_DEAD_LABEL}（current=${entry.current}，有席位但本进程没有它的活动代理）`;
}

/**
 * §11.9.5⑧: the entry sweep. Recovery runs the PUBLISHED expiry sweep before it
 * looks at anything, so a recovery never interleaves with a token that is still
 * in flight (the P3 lesson: an explicit identity change kills a token, and vice
 * versa). Pure in the sense that matters — it decides, it does not act.
 */
function recoveryPreflight(entry, now, isLive) {
	if (entry === null || entry === undefined) {
		return { error: "该团队没有这个角色（先用 team_link_roster action=set-role 指定现任；恢复不创建角色）。" };
	}
	if (entry.pending !== null && entry.pending !== undefined && entry.pending.expiresAt > 0 && entry.pending.expiresAt > now) {
		return { error: `该角色已有在飞的换届令牌（继任者 ${entry.pending.session}，${readStamp(entry.pending.expiresAt)} 到期）——恢复不插队：让它被认领，或等它过期被清扫（≤30 分钟）后再恢复。恢复入口进入时已先跑过既有过期清扫。` };
	}
	const limited = recoveryRateLimited(entry, now);
	if (limited.limited) return { error: `恢复速率限制（§11.9.5⑦，窗口 ${RECOVERY_RATE_LIMIT_MS / 60000} 分钟）——${limited.reason}。请等窗口结束（防对话框轰炸）。` };
	if (entry.current === null || entry.current === undefined) return { ok: true, kind: VACANT_LABEL, incumbent: null };
	if (isLive(entry.current) === true) {
		return { error: `该角色的现任 ${entry.current} 有活动代理——恢复只用于「现任无人」，正常换届请由现任自己发起 team_link_rotate action=prepare（幂等：条件由宿主观测，不由调用方主张）。` };
	}
	return { ok: true, kind: SEATED_DEAD_LABEL, incumbent: entry.current };
}

/** The recovery side of the SAME window (差异审计 B1). A recovery stamps the
 * `rotationAt` field too — that is what makes it auditable in exactly one place —
 * so `rotationRateLimited` alone answers it, for both its branches. The removed
 * duplicate (a second `rotationAt` comparison with the recovery deadline) could
 * never fire: `RECOVERY_RATE_LIMIT_MS === ROTATION_RATE_LIMIT_MS`, and the shared
 * branch below already compares the same field against the same limit. Restating
 * it was a second implementation of one rule — the class of defect this round
 * exists to remove, not to add. Pure. */
function recoveryRateLimited(entry, now) {
	return rotationRateLimited(entry, now);
}

/** The §4.2 (c) synthetic candidate's label. It is minted by the PLUGIN (the model
 * never writes it), and it is the identity the dialog answer is matched against —
 * so B6's "候选由插件算，模型不得指定继任者 id" holds for this candidate exactly
 * as it does for a live member: the answer can only name a label the plugin put
 * in the box. The successor id does not exist yet at this point (§10.2.2 mints it
 * AFTER the human picks), so a label is the only honest identity available. */
const SELF_SUCCESSOR_LABEL = "自建继任者（新建会话）";

/** §11.9.5③ + §4.2 (c): the candidate set is computed by the PLUGIN and is
 * **活成员 ∪ 插件自建继任者（常驻）**:
 *
 * - `teamMembers` filtered by the liveness probe (the same set §3.6.1 principle 2
 *   uses), excluding the role being recovered (that one is the dead incumbent);
 * - PLUS the synthetic `自建继任者（新建会话）` candidate, which is ALWAYS present
 *   and is NOT conditional on the live set being empty. The incident this batch
 *   exists for had a candidate list of length **1** (the only survivor was the
 *   coordinator itself), so a trigger of the form "only when there are no
 *   candidates" would never have fired — and the one option left would still be
 *   "seat a worker role on the coordinator".
 *
 * The model's only input is `team` (+ optional `role`); there is no parameter
 * anywhere in this tool that could name a successor id, and the synthetic entry
 * carries no id at all. Pure.
 */
function reapCandidateRoles(team, roleName, isLive) {
	const live = team.roles
		.filter((entry) => entry.role !== roleName && entry.current !== null && entry.current !== undefined && isLive(entry.current) === true)
		.map((entry) => ({ role: entry.role, session: entry.current, synthetic: false }));
	return [...live, { role: null, session: null, synthetic: true, label: SELF_SUCCESSOR_LABEL }];
}

/** One candidate's dialog identity: a live member is named by its session id (the
 * historical label, unchanged), the synthetic one by the plugin's own constant. */
function candidateLabel(candidate) {
	return candidate.synthetic === true ? SELF_SUCCESSOR_LABEL : candidate.session;
}

/** One candidate's option description, the same sentence shape for both kinds: what
 * picking it will do, and — for the synthetic one — the §4.2 (c) cost declaration
 * (an EMPTY-CONTEXT new session: history does not migrate, trust migrates only
 * through the successor's own claim). */
function candidateOptionText(candidate, roleName) {
	if (candidate.synthetic === true) {
		return `由插件**新建一个根会话**当继任者（${SELF_SUCCESSOR_LABEL}；id 形如 team-link-<team>-<role>-<uuid8>，由插件铸造）——**代价如实声明**：它是**空上下文的新会话**，前任的历史/对话**不迁移**；信任（pairs / trustedSenders / rememberTargets）也不在本次迁移，而是靠它本人凭令牌 claim 时逐项勾选，或无人值守时全部 provisional + 24h 回退。插件会从 roster 事实生成一份五硬节的交接文档（读不到的项如实标未知）交给它。`;
	}
	return `角色 ${candidate.role} 的现任会话 ${candidate.session}（活代理；由宿主从本队活成员算出）——勾选它即以 M4 prepare 语义把它铸为该角色 ${roleName} 的继任者`;
}

/**
 * §11.9.5 的**发起域**，与授权域分开：发起者 ∈ {该角色**最近一任前任**} ∪ {团队
 * **现任成员**}。旧任可以发起——发起权不依赖信任、只依赖身份资格，它上下文最完整
 * （「回聘旧任」是最自然的恢复）——但授权仍必须由人类在对话框里给出。
 *
 * 域外的活会话被拒，**且拒得说清出口**：设置 UI（R2 级）永远是超级写者路径，
 * 所以挡住的只是「会话路径」，不是「人」。代价如实写在 README：非成员的活会话
 * （人类随手开的、不属于本队的会话）不能发起恢复——这是有意的收窄。
 *
 * 判据全部由宿主从 roster 读出，调用方主张不了任何一条：`team.current` /
 * `entry.current` / `entry.history` 都是落盘事实。`entry === null` 判过（不窄化），
 * 好让「这个角色不存在」由两个动词各自的错误文案回答（那里的文案更准）。
 */
function previousHolderOf(entry) {
	if (entry === null || entry === undefined) return null;
	const history = Array.isArray(entry.history) ? entry.history : [];
	for (let index = history.length - 1; index >= 0; index -= 1) {
		const record = history[index];
		const session = typeof record?.session === "string" ? record.session : "";
		if (session !== "" && record.until !== null && session !== entry.current) return session;
	}
	return null;
}

/**
 * The domain in the caller's terms: what the domain IS, who the caller is, where
 * the caller sits, and the always-open exit. Pure — the roster and the caller's
 * session id are both arguments, so the rule is testable without a ctx.
 *
 * @returns `true` when the caller may initiate, or a refusal object naming the
 *   requested role's current holder, its last predecessor, and the settings UI.
 */
function initiatorAllowsRecovery(team, roleName, caller) {
	if (team === null || team === undefined) return true;
	const entry = roleOf(team, roleName);
	if (entry === null) return true;
	const members = new Set(teamMembers(team));
	const previous = previousHolderOf(entry);
	if (caller !== undefined && caller !== "" && (members.has(caller) || previous === caller)) return true;
	return { error: `恢复被拒绝（发起域，§11.9.5）：本工具的发起者只能是团队 ${team.name} 的**现任成员**，或该角色**最近一任前任**。当前调用会话 ${caller ?? "（无会话身份）"} 两者都不是——${caller === undefined ? "这次调用没有会话身份" : `它不在本队现任成员 [${[...members].join("、") || "（无）"}] 里`}，也不是该角色的前任 ${previous ?? "（无前任记录）"}。**被挡住的只是会话路径，不是人**：设置 UI 直接改 team-link 的 teams 键仍是永远可用的出口（用户在那里是超级写者，R2 级）。或者由现任成员/旧任发起（旧任上下文最完整，「回聘旧任」本就是最自然的恢复）。${RECOVERY_NO_WRITE_SUFFIX}` };
}

/** §11.9.5⑧'s honesty clause (差异审计 B2, same narrowing as §11.9.6's): the entry
 * sweep runs BEFORE every recovery verb, and it can really cancel a token that has
 * expired since some earlier call — writing settings and broadcasting a notice. So
 * no refusal may promise a bare 「零写入」 any more: the true statement is always
 * about **this call's own** side effects. This suffix is the one place that says so,
 * appended to every refusal instead of being restated per branch. */
const RECOVERY_NO_WRITE_SUFFIX = "（本次恢复调用自身零写入：没有建会话、没有铸令牌、没有广播 freeze、没有写 roster/信任。注意入口的既有过期清扫**先于**本次判断运行——若上面报了它清的过期令牌，那是清扫按既有语义做的真写入，不是本次恢复做的，见 §11.9.5⑧。）";

/** One refusal / cancellation line in the §11.9.5 terms above: the branch's own
 * sentence, then the scoped zero-write attestation. */
function recoveryRefusal(text) {
	return `${text}。${RECOVERY_NO_WRITE_SUFFIX}`;
}

/** §11.9.5⑦ trail #3: the team blackboard is append-only, so an event can be
 * recorded while the writer gate is jammed (the board has no write gate at all).
 * The row is built from the SAME shape the recovery tool's audit uses, so the
 * board and the tool's answer can never tell two different stories (「不可两处口径」). */
function recoveryDecisionRow(row) {
	const iso = new Date(row.at).toISOString();
	const head = `recovery ${row.verb} team=${row.team} role=${row.role}`;
	const from = row.from === null || row.from === undefined ? "（无现任）" : row.from;
	const to = row.to === null || row.to === undefined ? "（无）" : row.to;
	const tail = ` by=${row.by === "" || row.by === undefined ? "unknown" : row.by}`;
	return `${head} from=${from} to=${to} reason=${row.reason}${tail}（${iso}）`;
}

/** §11.9.5⑦ trail #2 + #3: the roster.md mirror and the decisions.md append.
 * Both are best-effort BY DESIGN and reported as such — the settings namespace is
 * the source of truth, and a failed audit line must never make a recovery that
 * already happened look like it did not. The decisions row goes through the same
 * `readBlackboardLine` bound the model-facing writer obeys, capped to the
 * decision field so the ledger's per-line limit cannot be broken by it. */
async function writeRecoveryTrails(team, row) {
	const mirror = team === null ? { ok: false, error: "团队不在注册表中" } : await writeRosterMirror(team);
	let decisions = "（未写：团队没有 workspace 记录，黑板根目录未知）";
	if (team !== null && team.workspace !== "") {
		const paths = blackboardPaths(team);
		try {
			const existing = await readBlackboardFile(paths.decisions);
			if (existing.error !== undefined) {
				decisions = `（未写：decisions.md 无法读取——${existing.error}）`;
			} else {
				const seq = lastDecisionSeq(existing.text) + 1;
				const line = readBlackboardLine(row.decision, "decisions 正文");
				if (line.error !== undefined) {
					decisions = `（未写：${line.error}）`;
				} else {
					const prefix = existing.text === "" || existing.text.endsWith("\n") ? "" : "\n";
					await mkdir(paths.dir, { recursive: true });
					await appendFile(paths.decisions, `${prefix}${decisionRow(seq, new Date(row.at).toISOString(), row.by === "" ? "unknown" : row.by, line.value)}\n`, "utf8");
					decisions = `已追加 decisions #${seq} → ${paths.decisions}`;
				}
			}
		} catch (error) {
			decisions = `（未写：decisions.md 写入出错——${describeError(error)}）`;
		}
	}
	return { mirror, decisions };
}

/** The §11.9.4 confirmation of ONE recovery step. Fail-closed on every path that
 * is not the explicit 「执行恢复」 answer — that property is what makes "no human,
 * no recovery" structural rather than something each caller remembers. */
async function askRecoveryConfirm(ctx, agent, request, signal) {
	const userQuestions = ctx.get?.("userQuestions");
	if (userQuestions === undefined || userQuestions === null || typeof userQuestions.ask !== "function") {
		return { confirmed: false, reason: "确认服务（userQuestions）不可用——恢复必须有人在对话框里点一下；无确认即不执行（fail-closed，§11.9.5②）。刻意没有 provisional / 无人值守变体：pair 迁移可被自动回退，身份不可。" };
	}
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, ROTATION_CONFIRM_TIMEOUT_MS);
	timer.unref?.();
	const forward = () => controller.abort();
	signal?.addEventListener?.("abort", forward);
	try {
		const answer = await userQuestions.ask({
			questions: [{
				id: RECOVER_DIALOG_ID,
				header: request.header,
				question: wellFormed(request.question),
				detail: wellFormed(request.detail),
				options: [
					{ label: RECOVER_CONFIRM_LABEL, description: request.confirmDescription },
					{ label: RECOVER_CANCEL_LABEL, description: request.cancelDescription },
				],
			}],
			agent,
			signal: controller.signal,
		});
		const item = Array.isArray(answer?.answers) ? answer.answers.find((entry) => entry?.id === RECOVER_DIALOG_ID) : undefined;
		if (item === undefined || !Array.isArray(item.selected)) return { confirmed: false, reason: "确认框没有返回本次恢复问题的答案" };
		if (!item.selected.includes(RECOVER_CONFIRM_LABEL)) return { confirmed: false, reason: `用户在确认框里选择了「${item.selected.join("、") || "（未选择）"}」` };
		return { confirmed: true };
	} catch (error) {
		return { confirmed: false, reason: timedOut ? "确认框 3 分钟内未获确认（按取消处理）" : `确认框失败（${describeError(error)}）` };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener?.("abort", forward);
	}
}

/**
 * §11.9.5③'s candidate dialog, and the ONLY way a successor can enter this path:
 * the options ARE the plugin-computed live candidates, and the answer is read back
 * BY MATCHING THOSE LABELS. There is no parameter anywhere in this tool that could
 * carry a successor id, so "模型不可指定继任者 id" is a structural property of the
 * answer's provenance rather than a sentence in a description.
 *
 * Fail-closed on every path that is not exactly one selected candidate: no
 * confirmation service, a thrown ask, a timeout, or an empty selection.
 *
 * @returns `{ confirmed, picked }` (with `picked.length === 1`, 差异审计 B3) or
 *   `{ confirmed: false, reason }`.
 */
async function askRecoveryCandidates(ctx, agent, request, candidates, signal) {
	const userQuestions = ctx.get?.("userQuestions");
	if (userQuestions === undefined || userQuestions === null || typeof userQuestions.ask !== "function") {
		return { confirmed: false, reason: "确认服务（userQuestions）不可用——恢复必须有人在对话框里点一下；无确认即不执行（fail-closed，§11.9.5②）。刻意没有 provisional / 无人值守变体：pair 迁移可被自动回退，身份不可。" };
	}
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, ROTATION_CONFIRM_TIMEOUT_MS);
	timer.unref?.();
	const forward = () => controller.abort();
	signal?.addEventListener?.("abort", forward);
	try {
		const answer = await userQuestions.ask({
			questions: [{
				id: RECOVER_DIALOG_ID,
				header: request.header,
				question: wellFormed(request.question),
				detail: wellFormed(request.detail),
				// 批次 2 §4.2 (c): the option list is one label per plugin-computed candidate,
				// and the synthetic `自建继任者（新建会话）` entry is one of them. Its label is the
				// plugin's constant (§{@link SELF_SUCCESSOR_LABEL}) because no successor id
				// exists yet — the human picks a LABEL, the plugin mints the id afterwards.
				options: candidates.map((candidate) => ({
					label: candidateLabel(candidate),
					description: candidateOptionText(candidate, request.roleName),
				})),
				// ONE successor, ONE choice (差异审计 B3). This used to say
				// `multiSelect: true` while the caller went on to use `picked[0]` — so a
				// human who checked a second candidate had that choice silently
				// discarded (the box promised something the code did not do). The two
				// honest options were "act on every pick" (rejected: one recovery is one
				// prepare for one successor; anything else is a batch feature this design
				// does not have, and it would have to define what two successors MEAN)
				// and "ask for exactly one". This is the latter: a single-select box
				// cannot express a choice the code will not act on. The option list is
				// still exactly one label per plugin-computed candidate, and the answer is
				// still read back BY MATCHING THOSE LABELS (a label outside the list is
				// refused, never guessed at).
			}],
			agent,
			signal: controller.signal,
		});
		const item = Array.isArray(answer?.answers) ? answer.answers.find((entry) => entry?.id === RECOVER_DIALOG_ID) : undefined;
		if (item === undefined || !Array.isArray(item.selected)) return { confirmed: false, reason: "确认框没有返回本次恢复问题的答案" };
		// A single-select answer arrives as a one-element list; matching it against the
		// candidate labels is what makes "模型不可指定继任者 id" structural, and a label
		// that is not in the list (a hand-edited card, a hijacked answer) matches nothing.
		const claimed = new Set();
		const picked = [];
		for (const label of item.selected) {
			const index = candidates.findIndex((candidate, position) => !claimed.has(position) && candidateLabel(candidate) === label);
			if (index === -1) continue;
			claimed.add(index);
			picked.push(candidates[index]);
		}
		if (picked.length === 0) return { confirmed: false, reason: `用户没有勾选任何候选人（收到「${item.selected.join("、") || "（空）"}」）` };
		return { confirmed: true, picked };
	} catch (error) {
		return { confirmed: false, reason: timedOut ? "确认框 3 分钟内未获确认（按取消处理）" : `确认框失败（${describeError(error)}）` };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener?.("abort", forward);
	}
}

/**
 * §11.9.4 L1: revive the SAME session. Identity unchanged, roster untouched,
 * trust completely untouched — reviving is not replacing anybody, so `writerGate`
 * has nothing to loosen and no pairs move.
 *
 * THE APPLICABILITY DOMAIN IS THE WHOLE POINT (会诊 D7, which the parent's own
 * first draft missed entirely): `resume`'s `ownerCtx` is the PLUGIN ROOT context,
 * so the revived agent's runtime ownership transfers to the plugin and unload
 * tears it down. Doing that to a session a HUMAN created would move its lifecycle
 * from the UI to the plugin — strictly WORSE than the status quo, in which a
 * plugin reload does not touch human sessions at all. L1 therefore serves the
 * sessions this plugin built, and hands everybody else a deep link instead.
 *
 * §11.9.5⑥ is stated here because this is where the temptation lives: when the
 * write gate is jammed, `policy.writer = "any"` looks like a fix. It is not — it
 * silently weakens the whole team — and this function has no code path that
 * touches `policy`.
 */
async function reviveIncumbent(deps, request) {
	const { ctx, policy, controller } = deps;
	const { teamName, roleName, caller, agent, signal, now } = request;
	const isLive = (id) => controller.liveProbe(id);
	const view = policy.get();
	const team = view.teams.find((entry) => entry.name === teamName) ?? null;
	if (team === null) return { error: `恢复失败：团队 ${teamName} 不在注册表中。` };
	// 批次 2 (§4.2 (a)): the ROLE gate that used to stand here is gone. §11.9.1 only
	// ever argued that a dead coordinator must be recoverable — it never argued that
	// a dead worker may not be revived, and the real failure shape (a reload tears
	// down EVERY plugin-built session, not just the coordinator's) is exactly the
	// one that gate refused. `revive` is the identity-preserving verb: it writes no
	// roster field, mints no token, moves no pair and never touches `policy`, so
	// widening its role face does not move it one inch toward being a general
	// roster editor. The OWNERSHIP gate below is untouched (§5 B3).
	const entry = roleOf(team, roleName);
	const preflight = recoveryPreflight(entry, now, isLive);
	if (preflight.error !== undefined) return { error: `恢复失败（revive）：${preflight.error}` };
	if (preflight.kind === VACANT_LABEL) {
		return { error: `恢复失败（revive）：${vacancyKindText(entry)}。revive 复活的是一个**会话 id**，而这里是刻意空缺——没有 id 可复活。要指派一个人请用 team_link_recover action=reappoint（同样需要在场确认），或由用户经设置 UI 直接指定现任。` };
	}
	const incumbent = preflight.incumbent;
	// §11.9.4's applicability domain. `hasHandle` is the plugin's own handle
	// registry — the honest witness for "the plugin created it" INSIDE this
	// activation — and the id grammar `team-link-<team>-<role>-<uuid8>` (§10.2.2,
	// the same one `/team_session` and `successor:"auto"` mint) is what survives a
	// reload, which is precisely when L1 matters most: after a reload the handle
	// map is empty BY CONSTRUCTION, so a handle-only predicate would refuse every
	// session this plugin ever made — including the very ones this path exists for.
	const pluginCreated = controller.hasHandle(incumbent) === true || pluginSessionIdMatches(teamName, roleName, incumbent);
	if (!pluginCreated) {
		return { error: [
			`恢复失败（revive）：现任 ${incumbent} 不是本插件创建的会话（§11.9.4 的适用域），所以这里只给深链指引，不替你复活它。`,
			`理由如实说：resume 的 ownerCtx 是**插件根 ctx**——复活后该代理的运行时所有权会归插件，插件卸载/重载就把它一起拆掉。对**人类自建**会话做 revive 会把它的生命周期从 UI 转给插件，比现状（插件重载不影响人类会话）**更差**。`,
			`正确动作（L1 的人类版本，零信任手术）：在侧边栏重新打开会话 ${incumbent}——同一个会话 id 复活，身份/信任/pairs 全部原样回来，writerGate 按 id 比对直接放行。`,
			`若那个会话不该再回来：team_link_recover action=reappoint（人改任，走完整 M4 交接），或由用户在设置 UI 直接改现任。`,
		].join("\n") };
	}
	if (typeof ctx.agents?.resume !== "function") {
		return { error: `恢复失败（revive）：本宿主没有可用的 ctx.agents.resume（无 factory 或未配置 sessionPersistence）——fail-closed，本次零改动：roster 未动、信任未动、没有任何放弃所有权的代理。改走 team_link_recover action=reappoint（人改任，走完整 M4 交接），或由用户在侧边栏打开会话 ${incumbent}，或经设置 UI 直接改现任。` };
	}
	const dialog = await askRecoveryConfirm(ctx, agent, {
		header: "恢复确认（revive）",
		question: [
			`把团队 ${teamName} 的角色 ${roleName} 的现任会话 ${incumbent} 复活？`,
			"",
			`- 现状：${vacancyKindText(entry)}（读数 ${readStamp(now)}）`,
			`- 发起会话：${caller ?? "（无会话身份）"}`,
			"- 这一步做什么：ctx.agents.resume 载入该会话的持久化日志并在其上恢复一个代理——身份不变（id 还是那个 id）、roster 不动、信任零改动（pairs / trustedSenders / rememberTargets 一个字节都不碰），也不改 policy。",
			"- 代价（如实声明）：该代理的运行时所有权归**本插件**，插件卸载/重载即拆（§10.2.5 的生命周期事实同样适用）。会话仍在盘上，可再次恢复。",
			`- 选「${RECOVER_CANCEL_LABEL}」= 什么都不做：不 resume、不写任何状态。`,
		].join("\n"),
		detail: recoveryBoundaryText(),
		confirmDescription: `resume 会话 ${incumbent}（resumeSessionId=${incumbent}），只复活、不换人`,
		cancelDescription: "什么都不做（零 resume、零写入、零广播）",
	}, signal);
	if (!dialog.confirmed) return { refused: recoveryRefusal(`未恢复（revive）：${dialog.reason}。本次零 resume`) };
	// TOCTOU, first re-read: the dialog just spanned an unbounded human wait, so the
	// observation that opened it is re-taken before the resume call.
	const reopened = policy.get();
	const teamNow = reopened.teams.find((entry) => entry.name === teamName) ?? null;
	const entryNow = teamNow === null ? null : roleOf(teamNow, roleName);
	if (entryNow === null || entryNow.current !== incumbent) {
		return { refused: recoveryRefusal(`恢复已中止（revive，写前复检）：该角色的现任已不是 ${incumbent}（现在是 ${entryNow === null || entryNow.current === null ? "（空缺）" : entryNow.current}）——别把令牌式的身份主张当成当前事实。零 resume`) };
	}
	if (isLive(incumbent)) return { refused: recoveryRefusal(`恢复已中止（revive，写前复检）：现任 ${incumbent} 已经有活动代理了（多半是有人刚在侧边栏打开了它）。它本来就不需要恢复；若确实要换人，请走 team_link_rotate（需要现任自己发起）或 team_link_recover action=reappoint。零 resume`) };
	let handle;
	try {
		handle = await ctx.agents.resume({ resumeSessionId: incumbent });
	} catch (error) {
		return { error: `恢复失败（revive，fail-closed）：resume 抛出（${describeError(error)}）。本次零改动：roster 未动、信任未动、没有任何放弃所有权的代理。若侧边栏已经打开过该会话，那就不需要恢复；否则改走 team_link_recover action=reappoint，或由用户在侧边栏打开会话 ${incumbent}，或经设置 UI 直接改现任。` };
	}
	if (handle === null || handle === undefined || handle.agent === null || handle.agent === undefined) {
		return { error: `恢复失败（revive，fail-closed）：resume 没有返回可用的 AgentHandle（返回 ${preview(safeJson(handle), 120)}）——按失败处理，roster 未动、信任未动。` };
	}
	// The plugin owns what it revived (§11.9.4), so the handle joins the same
	// registry every plugin-created handle lives in. The handle's disposer is
	// single-shot, so the unload path disposing it again is a no-op.
	controller.handles.set(incumbent, handle);
	// The observation that authorizes the write, re-taken a second time at the
	// moment of writing (the design asks for both: at the dialog and before the
	// pen). This is the reading the version history records.
	const final = policy.get();
	const teamFinal = final.teams.find((entry) => entry.name === teamName) ?? null;
	const entryFinal = teamFinal === null ? null : roleOf(teamFinal, roleName);
	if (entryFinal === null || entryFinal.current !== incumbent) {
		return { refused: `恢复已中止（revive，落笔前复检）：该角色的现任在本次调用中途变成了 ${entryFinal === null || entryFinal.current === null ? "（空缺）" : entryFinal.current}——已 resume 的会话 ${incumbent} 保持存活（不撤销，插件不自动关闭任何会话），但本次不写任何审计与限速记录。` };
	}
	if (teamFinal.workspace !== "") {
		await mkdir(blackboardPaths(teamFinal).dir, { recursive: true });
	}
	const row = { verb: "revive", at: now, by: caller ?? "", from: incumbent, to: incumbent, note: recoveryNote("revive", caller) };
	const written = final.teams.map((record) => (record.name === teamName ? withRecoveryRow(record, roleName, row) : record));
	try {
		await policy.update({ teams: written });
	} catch (error) {
		return { error: `恢复失败（revive）：resume 成功但审计写入失败（${describeError(error)}）——会话 ${incumbent} 已复活且仍然存活（不撤销：插件不自动关闭任何会话），但版本史/限速没落下。roster 的其他字段未动。请重试本次恢复。` };
	}
	// The mirror is rendered from the roster the WRITE left behind (§3.3.1): passing
	// the pre-write `teamFinal` would publish a roster.md that omits the very
	// recovery row this function just recorded — the file and the settings namespace
	// would then tell two different stories about the same call.
	const writtenTeam = written.find((record) => record.name === teamName) ?? teamFinal;
	const trails = await writeRecoveryTrails(writtenTeam, { ...row, team: teamName, role: roleName, reason: `现任无活动代理（${SEATED_DEAD_LABEL}）`, decision: recoveryDecisionRow({ ...row, team: teamName, role: roleName, reason: `现任无活动代理（${SEATED_DEAD_LABEL}）` }) });
	return {
		lines: [
			`已恢复（revive）：团队 ${teamName} 的角色 ${roleName} —— 会话 ${incumbent} 复活成功（读数 ${readStamp(now)}）。`,
			`- 身份不变：resumeSessionId=${incumbent}，roster 的 current 一字未动；信任零改动（没有迁移、没有吊销，pairs / trustedSenders / rememberTargets 未碰）。`,
			`- 生命周期（如实声明，§11.9.4）：该代理的运行时所有权归本插件（resume 的 ownerCtx 是插件根 ctx）——插件卸载/重载会把它的代理一起拆掉，会话仍在盘上，可再次 revive 或由人在侧边栏打开。`,
			`- 审计留痕（§11.9.5⑦，三处）：① 版本史备注 ${row.note}；② ${mirrorNote(trails.mirror)}；③ 黑板 ${trails.decisions}`,
			`- 限速（§11.9.5⑦）：本次恢复已占用该角色的 ${RECOVERY_RATE_LIMIT_MS / 60000} 分钟恢复/换届窗口（防对话框轰炸），窗口内的下一次恢复会被拒绝并说明剩余时间。`,
			`- policy.writer 未动（仍是 ${teamFinal.policy.writer}）——恢复不改权限模型，也绝不把 writer 降级为 any 当作「修复」（§11.9.5⑥）。`,
		],
	};
}

/** Append one §11.9.5⑦ audit row to a role record, through the canonical
 * constructor so the row round-trips through settings unchanged. */
function withRecoveryRow(team, roleName, row) {
	return {
		...team,
		roles: team.roles.map((entry) => (entry.role === roleName ? roleRecord({ ...entry, rotationAt: row.at, recoveries: [...(entry.recoveries ?? []), row] }) : entry)),
	};
}

/** True when one session id is the `team-link-<team>-<role>-<uuid8>` id this
 * plugin's own §10.2.2 template mints for that very team and role. This is the
 * DURABLE half of §11.9.4's applicability domain: the handle registry answers it
 * within an activation, and this answers it across a reload — which is exactly
 * when revival is needed, because the reload emptied the registry. */
function pluginSessionIdMatches(teamName, roleName, sessionId) {
	if (typeof sessionId !== "string" || sessionId === "") return false;
	const stem = `team-link-${teamName}-${roleName}`.replace(TEAM_SESSION_ID_ILLEGAL, "-");
	if (!sessionId.startsWith(`${stem}-`)) return false;
	const suffix = sessionId.slice(stem.length + 1);
	return suffix.length === TEAM_SESSION_ID_SUFFIX && /^[0-9a-f]+$/u.test(suffix);
}

/**
 * §11.9.4 L2: `reappoint` — the human-authorized prepare. This is the whole of
 * the recovery mechanism's second verb: the plugin computes the candidates from
 * the LIVE members (the model supplied only `team`, and optionally `role`), the
 * human picks, and then the published M4 `prepare` runs VERBATIM — token bound to
 * (team, role, successor), `rotationBackup` snapshot, `rotation-freeze` broadcast
 * — followed by the successor's own claim, also verbatim. Nothing here re-spells
 * any of that, which is what makes "claim 逐字不动，不新增令牌类型" checkable: the
 * only new thing in the pipeline is WHO was allowed to mint the coin.
 */
async function reapIncumbent(deps, request) {
	const { ctx, policy, rotation, controller } = deps;
	const { teamName, roleName, caller, agent, signal, now } = request;
	const isLive = (id) => controller.liveProbe(id);
	const view = policy.get();
	const team = view.teams.find((entry) => entry.name === teamName) ?? null;
	if (team === null) return { error: `恢复失败：团队 ${teamName} 不在注册表中。` };
	const entry = roleOf(team, roleName);
	const preflight = recoveryPreflight(entry, now, isLive);
	if (preflight.error !== undefined) return { error: `恢复失败（reappoint）：${preflight.error}` };
	const incumbent = preflight.incumbent;
	// §4.2 (c) ① (差异审计第 5 条 / N1 — 闸门收窄): the capability gate constrains the
	// SELF-BUILD BRANCH, never the verb's entry. Handing a role to a LIVE member needs
	// no `agents.create` at all, so gating the entry on it refused a path that worked
	// before this batch existed. The gate therefore has exactly two outcomes:
	//   - no `agents.create` ⇒ the box still opens and offers the LIVE members only
	//     (the synthetic candidate is not offered — it could never be honoured);
	//   - no `agents.create` AND zero live candidates ⇒ the fail-closed REPORT with
	//     **zero dialogs**: there is nothing the plugin could do for the human.
	const canSelfBuild = typeof controller.teamSession?.rootCtx?.agents?.create === "function";
	// §4.2 (c): the candidate set is 活成员 ∪ 插件自建继任者（常驻）. The synthetic
	// entry is ALWAYS computed (and offered whenever this host can build one), so the
	// "no live member to hand the role to" refusal is no longer a state the dialog
	// pretends cannot happen — candidates running out was exactly the state that had
	// no exit.
	const candidates = reapCandidateRoles(team, roleName, isLive);
	const liveCandidates = candidates.filter((candidate) => candidate.synthetic !== true);
	const offered = canSelfBuild ? candidates : liveCandidates;
	if (offered.length === 0) {
		return { error: `恢复失败（reappoint，${SELF_SUCCESSOR_LABEL}）：本宿主没有可用的 agents.create（编程创建会话不可用）——插件无法新建继任者，而本队也没有**任何可改任的活成员**（活成员改任那条路本身不需要该服务，这里是两条路同时不存在）。本次零创建、零令牌、零 freeze、零写入（连确认框都不弹）。可走的路径：① 先在壳里新建一个会话，再用 team_link_rotate action=prepare 把它的 id 作为 successor 传入（显式 successor 不需要 agents.create，手工路径始终保留，§3.6.4）；② team_link_recover action=revive（仅插件自建会话）；③ 由用户在设置 UI 直接改现任。${RECOVERY_NO_WRITE_SUFFIX}` };
	}
	const optionText = offered.map((candidate) => candidate.synthetic === true
		? `- ${SELF_SUCCESSOR_LABEL}（常驻候选；当前本队另有 ${liveCandidates.length} 位活成员可选）`
		: `- ${candidate.role} → ${candidate.session}（活代理）`).join("\n");
	const dialog = await askRecoveryCandidates(ctx, agent, {
		header: "恢复确认（reappoint）",
		roleName,
		question: [
			`团队 ${teamName} 的角色 ${roleName} 的现任不会/不应再回来吗？勾选一位改任（人改任 = 人类对话授权的 prepare）。`,
			"",
			`- 现状：${vacancyKindText(entry)}（读数 ${readStamp(now)}）`,
			`- 发起会话：${caller ?? "（无会话身份）"}`,
			canSelfBuild
				? "- 候选由插件算出 = **本队活成员 ∪ 插件自建继任者（常驻）**（模型不能指定任何继任者 id；合成候选连 id 都还没有——它由插件在人类勾选之后才铸）："
				// 差异审计第 5 条 (§4.2 (c) ① 收窄): the same sentence with the synthetic
				// candidate REMOVED, because this host cannot honour it — an option that
				// could never be carried out is exactly what a box must not offer. The
				// capability gap is stated here instead, so the human sees WHY the list is
				// shorter (N1: 只降级该面子面，并留痕).
				: `- 候选由插件算出 = **本队活成员**（模型不能指定任何继任者 id）。本宿主没有可用的 agents.create，插件无法新建继任者 ⇒ 「${SELF_SUCCESSOR_LABEL}」这一项**不列出**（活成员改任不需要该服务，所以这条路照常可用）：`,
			optionText,
			"- 之后发生什么（逐字走既有 M4，一步不跳）：铸一次性令牌绑定 (team, role, successor)（30 分钟）→ 把待迁移的信任状态快照进 rotationBackup（撤销依据，对死亡现任的对称吊销此时是纯清理）→ 向全队广播 rotation-freeze → 由继任者本人凭令牌 claim（届时还有第二道人类关卡：逐项勾选要迁移的 pairs，或无人值守走 provisional + 24h 回退）。",
			"- 本次只做前面那半段（可见步骤：确认 → 铸令牌 → 快照 → 广播冻结）。信任迁移不在本次发生。",
			// The synthetic candidate's cost declaration is printed only where that
			// candidate is actually on the list (the same one-read rule as the line above).
			...(canSelfBuild ? [`- 若选「${SELF_SUCCESSOR_LABEL}」：代价如实声明——继任者是**空上下文的新会话**（前任的历史/对话**不迁移**），它拿到的上下文只有插件从 roster 事实生成的交接文档；信任靠它本人凭令牌 claim 时逐项勾选迁移，或无人值守时全部 provisional + 24h 回退。`] : []),
			"- 不勾选任何一项 = 什么都不做：零令牌、零 freeze、零写入。",
		].join("\n"),
		detail: recoveryBoundaryText(),
	}, offered, signal);
	if (!dialog.confirmed) return { refused: recoveryRefusal(`未改任（reappoint）：${dialog.reason}。本次零令牌、零 freeze`) };
	const picked = dialog.picked[0];
	// TOCTOU, first re-read (the dialog spanned an unbounded human wait): the dead
	// incumbent may have been reopened while the box was open, and the candidate may
	// have died. Both facts are re-observed from the host, never taken from the
	// caller's assertion (§11.9.5, ③'s sibling constraint).
	const reopened = policy.get();
	const teamNow = reopened.teams.find((record) => record.name === teamName) ?? null;
	const entryNow = teamNow === null ? null : roleOf(teamNow, roleName);
	if (entryNow === null || entryNow.current !== incumbent) {
		return { refused: recoveryRefusal(`恢复已中止（reappoint，写前复检）：该角色的现任已不是 ${incumbent}（现在是 ${entryNow === null || entryNow.current === null ? "（空缺）" : entryNow.current}）——有人在这段时间里改任/退役了它，本次的身份主张已过期。零令牌、零 freeze`) };
	}
	if (isLive(incumbent)) return { refused: recoveryRefusal(`恢复已中止（reappoint，写前复检）：现任 ${incumbent} 已经有活动代理了（多半是有人刚在侧边栏打开了它）——现任已复活，无需恢复，正常换届请走 team_link_rotate action=prepare（由现任自己发起）。零令牌、零 freeze`) };
	if (picked.synthetic !== true && !isLive(picked.session)) return { refused: recoveryRefusal(`恢复已中止（reappoint，写前复检）：候选 ${picked.session}（角色 ${picked.role}）在确认期间已经没有活动代理了——写入它会原地再造一个死结。零令牌、零 freeze`) };
	// §4.2 (c): the synthetic candidate has no session to re-check — it does not exist
	// yet — so its half of the chain starts here, after the SAME two re-reads above
	// (the incumbent is still the same id and still dead). From this point on it is
	// the published mechanism, verbatim: §10.2.2 id → hand-over document → prepare →
	// the same three audit trails → the followup that drives it (§11.4.5). The
	// capability gate is not restated here: this branch is unreachable unless the
	// host has `agents.create`, because the gate above decides which candidates the
	// box offers in the first place.
	if (picked.synthetic === true) {
		return await appointSelfBuiltSuccessor({ ctx, policy, rotation, controller }, { teamName, roleName, caller, agent, signal, now, incumbent, team: teamNow, entry: entryNow, candidates: offered });
	}
	// The published mechanism, verbatim: prepare mints the token, snapshots
	// `rotationBackup`, broadcasts the freeze and writes the roster mirror. The
	// recovery row rides the SAME settings write the prepare makes, so the audit and
	// the pending can never disagree about whether this happened.
	const prepared = await rotation.prepare({ teamName, roleName, successor: picked.session, note: recoveryNote("reappoint", caller), caller, now, signal, recovery: { verb: "reappoint", from: incumbent, by: caller ?? "" } });
	if (prepared.error !== undefined) return { error: prepared.error };
	const after = policy.get();
	const teamAfter = after.teams.find((record) => record.name === teamName) ?? null;
	const row = { verb: "reappoint", at: now, by: caller ?? "", from: incumbent, to: picked.session, note: recoveryNote("reappoint", caller) };
	const trails = teamAfter === null
		? { mirror: { ok: false, error: `团队 ${teamName} 不在注册表中` }, decisions: "（未写：团队不在注册表中）" }
		: await writeRecoveryTrails(teamAfter, { ...row, team: teamName, role: roleName, reason: `现任无活动代理（${SEATED_DEAD_LABEL}）；继任者 = 本队活成员 ${picked.role}`, decision: recoveryDecisionRow({ ...row, team: teamName, role: roleName, reason: `现任无活动代理（${SEATED_DEAD_LABEL}）；继任者 = 本队活成员 ${picked.role}` }) });
	return {
		lines: [
			`恢复：已按 §11.9.4 L2 铸好换届包（reappoint）：团队 ${teamName} 的角色 ${roleName}，${incumbent === null ? "（空缺）" : incumbent} → ${picked.session}（角色 ${picked.role}，由插件算出的候选集中经人类确认选定——本条选中的是**本队活成员**那一类；读数 ${readStamp(now)}）。`,
			`- 候选集（宿主计算，模型不可指定）：${offered.map((candidate) => candidate.synthetic === true ? SELF_SUCCESSOR_LABEL : `${candidate.role}→${candidate.session}`).join("、")}`,
			...(canSelfBuild ? [] : [`- 本宿主没有可用的 agents.create（编程创建会话不可用），所以「${SELF_SUCCESSOR_LABEL}」不在候选里；活成员改任这条路径不需要该服务，照常可用。`]),
			`- 审计留痕（§11.9.5⑦，三处）：① 版本史备注 ${row.note}；② ${mirrorNote(trails.mirror)}；③ 黑板 ${trails.decisions}`,
			...prepared.lines,
			"下一步（§11.4.4 → §11.4.6，claim 逐字不动）：把令牌与交接文档交给继任者会话，由它本人调用 team_link_rotate action=claim；claim 会再走一次人类确认（逐项勾选 pairs），无人值守则 provisional + 24h 回退。两道人类关卡 + 24h 回退网，不合并、不省略（§11.9.5）。",
			`- policy.writer 未动（仍是 ${teamAfter === null ? "（未知）" : teamAfter.policy.writer}）：恢复不改权限模型，也绝不把 writer 降级为 any（§11.9.5⑥）。`,
		],
	};
}

/**
 * §4.2 (c) ④: the hand-over body the PLUGIN writes for a self-built successor.
 * The published `successor:"auto"` path takes that body from the model; this
 * path has no model in it at all (that is the point — the box has one synthetic
 * candidate and no place to type a body), so the plugin renders the five HARD
 * sections from roster facts and marks everything it cannot read as UNKNOWN.
 *
 * The honesty rule is §11.9.6's, and `unknowns` is the section it lands in: the
 * incumbent is dead BY PREMISE (this verb only runs on a seated-dead role), so
 * nothing about its in-flight work is observable from here, and inventing a
 * plausible-looking note would hand a fresh session a fabricated memory.
 *
 * ONE section has a real data source and therefore is not automatically UNKNOWN:
 * `task-and-goal` renders the goals reading when {@link readGoalSignal} produced
 * one (the same reading `in-flight` reports as evidence), and says 未知 only when
 * there was no reading to render — §4.2 (c) ④'s 「读不到才标未知」, in code. In this
 * verb's normal case the incumbent has no live agent, so the reading is absent and
 * the section really is unknown; the branch exists so the section cannot keep
 * declaring a source it never consumes (差异审计第 8 条).
 *
 * @returns one markdown body whose five hard sections are present and NON-EMPTY
 *   (asserted against {@link HANDOFF_HARD_SECTIONS} in the host suite).
 */
function selfBuiltHandoffBody(request) {
	const trust = request.trust;
	const lines = [
		"## mission",
		`接管团队 ${request.teamName} 的角色 ${request.roleName}（本会话由 team_link_recover action=reappoint 的「${SELF_SUCCESSOR_LABEL}」路径新建：该角色的前任在本进程没有活动代理，人类在候选里选的是**由插件新建一个会话**，而不是把该角色改任给某位活成员）。`,
		`- 前任会话（roster 事实）：${request.incumbent}`,
		`- 发起会话：${request.caller === undefined || request.caller === "" ? "（无会话身份）" : request.caller}`,
		`- 本会话的工作目录：${request.cwd}`,
		"",
		"## in-flight",
		"前任已死，进行中工作不可读——本插件只读 roster 事实，不读会话正文，所以这一节不做任何推测。",
		request.goal.readable ? `- goals 服务读数（该角色前任的会话）：${request.goal.text}` : `- goals 服务：读不到（${request.goal.reason}）。`,
		"",
		"## commitments",
		"该角色记在前任名下的信任指针（只报**存在性与数量**，不复制任何密钥素材）：",
		`- pairs：${trust.pairs} 条`,
		`- trustedSenders：${trust.trustedSenders} 条`,
		`- rememberTargets：${trust.rememberTargets} 条`,
		"迁移方式（§11.9.5）：这些信任**不在本次迁移**——你本人凭令牌调用 team_link_rotate action=claim 时逐项勾选要迁移的 pairs；无人值守（超时 / 无确认服务）则全部以 provisional 迁移，24h 内未获人类批准自动回退。",
		"",
		"## unknowns",
		"- 前任的进行中工作（未落盘的计划、正在跑的工具调用、未发出的消息）——不可读，本节不做推测。",
		"- 前任的会话正文与对话上下文——本插件不读会话正文（导出面是给人用的，不在恢复链路上），交接文档不复制任何会话内容。",
		// §4.2 (c) ④ + §11.9.6 诚实原则: a section may only call something unknown if it
		// still IS unknown. Once the goals service answered, the goal stops being an
		// unknown — what stays unknowable is the part the reading never covered.
		...(request.goal.readable
			? ["- 前任 goal 的**正文与后续意图**——goals 读数只有 phase / activation / rounds 三项，goal 正文与它打算怎么继续不在本插件的读面上。"]
			: [`- 前任的 goal：${request.goal.reason}`]),
		"- 前任是否有未提交的代码改动、是否有别的会话在等它——本插件无从观测（不在它的读面上）。",
		"",
		"## task-and-goal",
		// §4.2 (c) ④: this section's declared data source IS the goals reading — the same
		// reading `in-flight` reports as evidence. Hard-coding 未知 here while computing a
		// reading above was the section declaring a source it never consumed (差异审计第 8 条):
		// the reading is rendered here, and 未知 is kept for the case that really has none.
		...(request.goal.readable
			? [
				`- 该角色的 goal（goals 服务读数，读自该角色前任的会话 ${request.incumbent}）：${request.goal.text}`,
				"- 该读数是**停工时刻的快照**（只有 phase / activation / rounds），不是它的计划；需要更完整的任务上下文时，由人类或在场的旧任补写本节。",
			]
			: [
				"- 该角色的任务与目标：**未知**——goals 按 agent 取读数，而前任没有活动代理，因此这一节读不到任何东西；本文件禁止编造。",
				"- 请由人类，或在场的旧任，补写这一节；插件只保证结构（五硬节在场且非空），不保证内容。",
			]),
		"",
	];
	return lines.join("\n");
}
/**
 * §4.2 (c): the whole chain for the synthetic successor, with nothing re-spelled —
 * §10.2.2 id → the SAME creation path `/team_session` and `successor:"auto"` use →
 * the hand-over document → the published `prepare` VERBATIM → the same three audit
 * trails → the §11.4.5 `followup` that delivers the token and the body to the session
 * that was just built. (The capability gate is answered by `reapIncumbent` before the
 * box opens: this function is only reached when the host CAN build a successor.)
 *
 * The order of the middle three follows §11.9.6 (the document is written BEFORE
 * `prepare`, so a document failure aborts before any token exists) and therefore
 * matches the auto path's own sequence rather than the list order in §4.2 (c) —
 * the design's numbering names the ELEMENTS, and §11.9.6 is the ordering. Delivery is
 * last for the reason §11.4.5 gives: the token has to exist before it can be handed
 * over, and the successor has to be WOKEN, not merely told.
 *
 * @returns `{ lines }` or `{ error }` — every failure path states its own
 *   side-effect boundary, and none of them rolls a created session back
 *   (§10.2.6: a session on disk may already be open somewhere).
 */
async function appointSelfBuiltSuccessor(deps, request) {
	const { ctx, policy, rotation, controller } = deps;
	const { teamName, roleName, caller, signal, now, incumbent, team, candidates } = request;
	const teamSession = controller.teamSession;
	const rootCtx = teamSession?.rootCtx;
	// The successor's workspace: the TEAM's own recorded workspace when there is one
	// (this team's roster mirror and hand-over documents live under it), and the
	// initiating session's cwd as the fallback. `process.cwd()` is never used — a
	// successor created in the host process's own directory would be in the wrong
	// workspace (the same boundary the auto path draws).
	const cwd = typeof team?.workspace === "string" && team.workspace !== "" ? team.workspace : agentCwd({ agent: request.agent });
	if (typeof cwd !== "string" || cwd === "" || !path.isAbsolute(cwd)) {
		const teamWorkspace = team?.workspace === undefined || team.workspace === "" ? "（未记录）" : team.workspace;
		const callerCwd = request.agent?.session?.header?.cwd ?? "（未捕获）";
		return { error: `恢复失败（reappoint，${SELF_SUCCESSOR_LABEL}）：无法确定新会话的工作目录（团队 workspace = ${teamWorkspace}；发起会话的 cwd = ${callerCwd}）——会话边界只接受绝对路径（§10.2.6），本次零创建、零令牌、零 freeze、零写入。` };
	}
	const sessionId = teamSessionId(teamName, roleName, () => randomUUID());
	// The token is minted BEFORE the document, because the document's header carries
	// its MASK (§11.9.6) — the identical look-ahead the auto path does. Nothing of it
	// becomes durable unless this call reaches `prepare`.
	const token = randomUUID();
	// ---- ② the durable intent BEFORE the create (§10.2.6) --------------------
	try {
		await addTeamSessionPending(policy, { team: teamName, role: roleName, sessionId, createdAt: now, expiresAt: now + TEAM_SESSION_PENDING_TTL_MS, by: caller ?? "" });
		teamSession.pending.set(sessionId, { team: teamName, role: roleName, sessionId });
	} catch (error) {
		return { error: `恢复失败（reappoint，${SELF_SUCCESSOR_LABEL}）：pending-create 意图写入失败（${describeError(error)}）——未创建（宁可不建，也不留一个没有意图记录的孤儿）。本次零创建、零令牌、零 freeze。` };
	}
	// ---- ③ create from the plugin ROOT ctx (§10.2.2 / §10.2.5) --------------
	let creation;
	try {
		creation = await createRootAgent(ctx, rootCtx, { preset: undefined, provider: undefined, model: undefined, team: teamName }, { sessionId, role: roleName }, cwd);
	} catch (error) {
		return { error: `恢复失败（reappoint，${SELF_SUCCESSOR_LABEL}）：继任者会话创建失败（${describeError(error)}）。未铸令牌、未广播 freeze；pending-create 意图保留，启动清扫会把它报进可收编清单（§10.2.6）。` };
	}
	const handle = creation.handle;
	teamSession.handles.set(sessionId, handle);
	// ---- ④ the hand-over document, BEFORE prepare (§11.9.6) -----------------
	// The facts are re-read HERE rather than reused from the pre-dialog view: the box
	// spanned an unbounded human wait, so the counts this document states must be the
	// counts of the store `prepare` is about to snapshot — the same TOCTOU discipline
	// the two verbs apply to their incumbent before writing.
	const factsView = policy.get();
	const factsTeam = factsView.teams.find((record) => record.name === teamName) ?? team;
	const held = trustReferencesTo(factsView, incumbent);
	const plan = planRotationMigration(factsView, { members: new Set(teamMembers(factsTeam)), retiree: incumbent, successor: sessionId });
	// §11.9.6's honesty rule, applied to the one fact this path could otherwise
	// fabricate: the role's goal is read from a DEAD incumbent, so the plugin reports
	// exactly what the host can answer and marks the rest unknown.
	const goalAgent = typeof ctx.agents?.get === "function" ? ctx.agents.get(incumbent) : undefined;
	const goalSignal = readGoalSignal(ctx, incumbent, goalAgent);
	const goal = goalSignal === null
		? { readable: false, reason: "goals 服务不可用（宿主没有这个服务），该角色的目标读不到" }
		: goalAgent === undefined
			? { readable: false, reason: `该角色的前任会话 ${incumbent} 没有活动代理——goals 按 agent 取读数，所以取不到` }
			: { readable: true, text: `phase=${goalSignal.phase} · activation=${goalSignal.activation} · rounds=${goalSignal.rounds}` };
	const body = selfBuiltHandoffBody({
		teamName,
		roleName,
		incumbent,
		caller,
		cwd,
		goal,
		trust: { pairs: held.pairs.length, trustedSenders: held.trustedSenders.length, rememberTargets: held.rememberTargets.length },
	});
	const document = await writeHandoffDocument(factsTeam, {
		roleName,
		previous: incumbent,
		successor: sessionId,
		token,
		preparedAt: now,
		body,
		report: handoffBodyReport(body),
		facts: rotationFactRows({
			retiree: incumbent,
			successor: sessionId,
			candidates: plan.candidates,
			dropped: plan.dropped,
			removedCount: held.pairs.length,
			trustedSenderCount: held.trustedSenders.length,
			rememberTargetCount: held.rememberTargets.length,
		}),
	});
	if (document.ok !== true) {
		return { error: `恢复失败（reappoint，${SELF_SUCCESSOR_LABEL}，abort-before-prepare §11.9.6）：交接文档写入失败（${document.error}）——不铸令牌、不广播 freeze。已建的继任者会话 ${sessionId} 保留并如实报为孤儿（§10.2.6 部分成功不回滚）；pending-create 意图保留，启动清扫会把它报进可收编清单。` };
	}
	// ---- ⑤ prepare: the published M4 mechanism, step for step -----------------
	const prepared = await rotation.prepare({ teamName, roleName, successor: sessionId, note: recoveryNote("reappoint", caller), caller, now, signal, token, recovery: { verb: "reappoint", from: incumbent, by: caller ?? "" } });
	if (prepared.error !== undefined) {
		return { error: `${prepared.error}（reappoint，${SELF_SUCCESSOR_LABEL}：令牌从未落盘、freeze 未广播；交接文档 ${document.path} 已写但本次换届不存在。已建的会话 ${sessionId} 保留并报为孤儿——pending-create 意图保留，启动清扫会把它报进可收编清单。）` };
	}
	// ---- ⑥ the intent is resolved: this session IS the rotation's successor ---
	try {
		await removeTeamSessionPending(policy, sessionId);
	} catch (error) {
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: pending-create intent ${sessionId} could not be cleared after prepare (${describeError(error)}) — 启动清扫会把它报进可收编清单（换届本身已生效）`);
	}
	teamSession.pending.delete(sessionId);
	// ---- ⑦ the same three audit trails the other branch writes --------------
	const after = policy.get();
	const teamAfter = after.teams.find((record) => record.name === teamName) ?? null;
	const row = { verb: "reappoint", at: now, by: caller ?? "", from: incumbent, to: sessionId, note: recoveryNote("reappoint", caller) };
	const reason = `现任无活动代理（${SEATED_DEAD_LABEL}）；继任者 = 插件自建的根会话 ${sessionId}（${SELF_SUCCESSOR_LABEL}，空上下文）`;
	const trails = teamAfter === null
		? { mirror: { ok: false, error: `团队 ${teamName} 不在注册表中` }, decisions: "（未写：团队不在注册表中）" }
		: await writeRecoveryTrails(teamAfter, { ...row, team: teamName, role: roleName, reason, decision: recoveryDecisionRow({ ...row, team: teamName, role: roleName, reason }) });
	// ---- ⑧ drive it: followup, never inject (§11.4.5) -----------------------
	// The tail this chain was missing (差异审计第 9 条): the token and the hand-over body
	// were minted, written and audited, but never TOLD to the session they belong to —
	// so a freshly built successor sat idle forever, holding a token nobody delivered.
	// The auto path's own step 8 is these same lines; `followup` and not `inject`
	// because the successor has to be WOKEN, and the message rides the same audited
	// three-member source ({kind, form, senderSessionId}).
	let delivered = true;
	let deliveryError;
	try {
		handle.agent.followup(relayUserMessage(handoffDeliveryMessage({ teamName, roleName, previous: incumbent, token, documentPath: document.path, body }), caller));
	} catch (error) {
		delivered = false;
		deliveryError = describeError(error);
	}
	const candidateSummary = candidates.map((candidate) => (candidate.synthetic === true ? SELF_SUCCESSOR_LABEL : `${candidate.role}→${candidate.session}`)).join("、");
	const titleLine = creation.title === undefined
		? "标题（DEFECT-4）：本次**未设成**标题（原因见上文那行 warn）——它会显示为宿主的默认标题（很可能是工作区名，在侧边栏里认不出来）。"
		: `标题（DEFECT-4）：已命名为「${creation.title}」（按「<team> · <role>」派生；不设标题会让它显示为工作区名、与其他会话无法区分）。`;
	return {
		lines: [
			`恢复：已按 §11.9.4 L2 铸好换届包（reappoint，${SELF_SUCCESSOR_LABEL}）：团队 ${teamName} 的角色 ${roleName}，${incumbent === null ? "（空缺）" : incumbent} → ${sessionId}（**由插件新建的根会话**：人类在对话框里选了「${SELF_SUCCESSOR_LABEL}」，插件按 §10.2.2 铸造 id；读数 ${readStamp(now)}）。`,
			`- 候选集（宿主计算，模型不可指定）：${candidateSummary}`,
			`- 交接文档（§11.9.6，插件从 roster 事实生成的五硬节）：${document.path}（上一份：${document.previousDocument ?? "（无——本角色落盘的第一份）"}）——读不到的项在正文里逐条点名（**如实标未知**），没有编造任何内容；task-and-goal 一节填的是 goals 服务的读数（读不到才标未知）。`,
			titleLine,
			delivered
				? `投递（§11.4.5）：已用 followup 把令牌与交接正文投给 ${sessionId}（不是 inject——任务需要驱动；消息 source 仍恰三成员 {kind, form, senderSessionId}）。`
				: `投递失败（${deliveryError}）：令牌已生效但继任者没收到——可把交接文档 ${document.path} 与令牌重新交给它，或等 30 分钟超时清扫取消本次换届（§11.5）。`,
			`- 代价如实声明（§4.2 (c)）：继任者是**空上下文的新会话**——前任的历史/对话**不迁移**；信任也不在本次迁移，靠它本人凭令牌 claim 时逐项勾选（无人值守则 provisional + 24h 回退）。`,
			"- 生命周期（§10.2.5）：该会话的 AgentHandle 由插件持有——插件卸载/重载会把它的代理一起拆掉，会话仍在盘上；而它的 id 就是插件自建形，所以此后同类死亡都有 L1（revive）可走。",
			`- 审计留痕（§11.9.5⑦，三处）：① 版本史备注 ${row.note}；② ${mirrorNote(trails.mirror)}；③ 黑板 ${trails.decisions}`,
			...prepared.lines,
			"下一步（§11.4.4 → §11.4.6，claim 逐字不动）：把令牌与交接文档交给继任者会话，由它本人调用 team_link_rotate action=claim；claim 会再走一次人类确认（逐项勾选 pairs），无人值守则 provisional + 24h 回退。两道人类关卡 + 24h 回退网，不合并、不省略（§11.9.5）。",
			`- policy.writer 未动（仍是 ${teamAfter === null ? "（未知）" : teamAfter.policy.writer}）：恢复不改权限模型，也绝不把 writer 降级为 any（§11.9.5⑥）。`,
		],
	};
}

/** Token argument reading (§3.6.2): a one-time opaque string. The masked display
 * form `tok-xxxx…yyyy` is deliberately NOT accepted — it is a rendering, and the
 * whole point of the mask is that the rendering is not the token. */
function readRotationToken(value) {
	if (typeof value !== "string" || value.trim() === "") {
		return { error: "需要 token（prepare 返回的一次性令牌；掩码形式 tok-xxxx…yyyy 不是令牌）。" };
	}
	const token = value.trim();
	if (/[\u0000-\u001F\u007F\s]/u.test(token)) return { error: "token 不能包含空白或控制字符。" };
	return { value: token };
}

// ---------------------------------------------------------------------------
// §11.9.4 §11.9.5 — the `team_link_recover` tool
// ---------------------------------------------------------------------------

/**
 * The live recovery controller of one plugin context. It is deliberately tiny:
 * the audit row shape and the anti-storm window are pure helpers above, and the
 * ONE thing that has to be bound to a context is the liveness probe — the same
 * `agents.get(id) !== undefined` reading every other live face uses (§11.9.3).
 */
const RECOVERY_BY_CTX = new WeakMap();

function createRecovery(ctx, policy, rotation, teamSession) {
	return {
		policy,
		rotation,
		teamSession,
		handles: teamSession.handles,
		liveProbe: (sessionId) => agentIsLive(ctx, sessionId),
		hasHandle: (sessionId) => teamSession.hasHandle(sessionId) === true,
	};
}

/**
 * §11.9.5③'s zero-side-effect diagnostic: one row per role, so a caller can see
 * WHICH roles are in which emptiness before choosing a verb. It is a pure read
 * (it runs the sweep first, like every other roster touch, and writes nothing).
 */
function recoveryDiagnosticLines(team, now, isLive) {
	const lines = [`团队 ${team.name}：policy.writer=${team.policy.writer} · 角色 ${team.roles.length} 个`];
	for (const entry of team.roles) {
		const seat = entry.current === null ? VACANT_LABEL : isLive(entry.current) ? "有活代理" : `${SEATED_DEAD_LABEL}（无活代理）`;
		const pending = entry.pending === null || entry.pending === undefined ? "（无在飞令牌）" : `在飞令牌 → ${entry.pending.session}（${readStamp(entry.pending.expiresAt)} 到期）`;
		lines.push(`- 角色 ${entry.role}：${seat} · 现任 ${entry.current ?? "（无）"} · ${pending}`);
	}
	lines.push(`- 恢复入口：team_link_recover action=revive（复活当前 current 这个会话本身，仅插件自建会话，**任意角色**）或 action=reappoint（人改任：候选 = **本队活成员 ∪ 常驻的「${SELF_SUCCESSOR_LABEL}」**，由插件算出、人类勾选后走完整 M4 交接；宿主没有 agents.create 时选项里只剩活成员，两条路都没有才 fail-closed）。`);
	lines.push(`- 硬死锁只有一格：policy.writer=coordinator（默认）且死的是 coordinator（§11.9.1）。日常仍可通讯——黑板 team_link_team_append 与 team_link_send 都不经过 writerGate。`);
	lines.push(`（读数 ${readStamp(now)}，${READ_STALE_NOTE}）`);
	return lines;
}

/**
 * §11.9.4's recovery tool. Registered like every other tool, with the two verbs
 * in ONE place so «恢复只有 revive / reappoint» has a single auditable landing
 * point — which is the whole reason the design refused to hang these on
 * `team_link_rotate` or `team_link_roster` (different actors, different
 * preconditions).
 */
function registerRecoveryTools(ctx, policy, rotation, controller, teamSession) {
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_recover",
		description: [
			"团队恢复（§11.9.4）。用途：某角色的现任「有席位但无活代理」（seated-dead，最常见的原因是插件重载/DSH 重启把插件自建会话的代理拆了），roster 写与换届就此卡住——本工具是那条窄恢复路径。**恰两个封闭动词**：",
			"action=revive：用 ctx.agents.resume 复活**当前 current 这个会话本身**（身份不变、roster 不动、信任零改动）。**受理任意角色**（§4.2 (a)）：重载拆掉的是**所有**插件自建会话，不只 coordinator 的，而 revive 既不写 roster、不铸令牌、不动 pairs/trustedSenders/rememberTargets、也不碰 policy——放开角色面不会把它变成通用 roster 编辑器。只对本插件创建的会话开放（id 形如 team-link-<team>-<role>-<uuid8>，或本进程仍持有它的 AgentHandle）；人类自建的会话只输出深链指引——resume 的 ownerCtx 是插件根 ctx，对人类会话做 revive 会把它的生命周期从 UI 转给插件，比现状更差。resume 不可用（无 factory / 无 sessionPersistence）或抛错 → fail-closed 报告，零改动。",
			"action=reappoint：现任不会/不应再回来时的「人改任」= 人类对话授权的 prepare。候选 = **本队活成员 ∪ 常驻的「自建继任者（新建会话）」**（§4.2 (c)），由**插件**算出并作为对话框选项呈现（模型只传 team，可选 role，**不能指定任何继任者 id**——合成候选连 id 都还没有，它由插件在人类勾选之后才铸）；人类勾选后逐字走既有 M4：铸一次性令牌绑定 (team, role, successor)、把待迁移信任快照进 rotationBackup、广播 rotation-freeze；随后由继任者本人凭令牌 claim（claim 逐字不动，不新增令牌类型）。能力闸门只约束**自建继任者**这条支路，不在动词入口（§4.2 (c) ①）：宿主没有 agents.create ⇒ 弹框照开、只是候选里**不出现**「自建继任者」（只列活成员——活成员改任不需要该服务），**仅当连一个活成员候选都没有**时才 fail-closed 报告且零弹框。选「自建继任者」时的链路逐条复用既有机制：按 §10.2.2 铸 id（team-link-<team>-<role>-<uuid8>）→ 交接文档由**插件从 roster 事实**生成五硬节（读不到的项**如实标未知**，不编造；task-and-goal 一节填 goals 服务的读数，读不到才标未知）→ prepare 逐字跑 → 审计行 verb=reappoint → 用 followup 把令牌与交接正文**投给刚建出的继任者**（与 successor:\"auto\" 同一条投递语义：不是 inject，任务需要驱动）。代价如实声明：继任者是**空上下文的新会话**，历史不迁移；信任靠它 claim 时逐项勾选迁移。",
			"硬约束（§11.9.5，八条）：① 动词封闭，不接受任意 roster 字段写入，**不改 policy.writer**；② attended-only——必须有人在对话框里点一下，**刻意没有 provisional / 无人值守变体**，无确认服务即 fail-closed；③ 候选由插件算、模型不可指定；④ revive 只绑**当前** current（不存在「复活任意历史会话」的动词，否则对称吊销形同虚设）；⑤ writerGate 原样不动；⑥ **绝不把 policy.writer 降级为 any 当作「修复」**（那是对团队的静默弱化）；⑦ 限速（与换届同一个 10 分钟窗口）+ 三处留痕（版本史备注 recovery(...) / roster.md 镜像 / decisions.md 追加——黑板无门，死锁下也能落账）；⑧ 进入即先跑既有过期清扫。另有写时复检（TOCTOU）：对话框弹出时与落笔前各重查一次现任活性，现任已复活则中止。",
			"角色面（★ 两个动词的域**不同**，照实现写）：**两个动词都受理任意角色**（§4.2 (a) 放开了 revive 的角色门；`reappoint` 从来就是任意角色——授权从不源自 coordinator 身份，唯一来源是对话框里人类那一下点击，§11.9.5）。它们的差别在**动词语义**上，不在角色上：`revive` = 身份不变的复活（同一个会话 id，零写）；`reappoint` = 换人（铸令牌 + 快照 + 冻结，走完整 M4 交接）。那条角色窄域是**范围最小化选择、不是安全属性**（§11.9.1 只论证过「死的 coordinator 必须可救」，从未论证「死的 worker 不许救活」），而重载拆掉的是所有插件自建会话——所以它被放开了。不带 role 时只输出诊断（每角色一行：现任 + 活性 + 在飞令牌），零副作用。",
			"发起域（§11.9.5 的「发起 ≠ 授权 ≠ 复权」）：**发起者**只能是团队**现任成员**，或该角色**最近一任前任**（旧任上下文最完整，「回聘旧任」本就是最自然的恢复；发起权不依赖信任、只依赖身份资格）。域外的会话被拒绝，拒绝文案点名现任成员集合、该角色的前任与调用会话，并指出设置 UI（用户在那里是超级写者）仍是永远可用的出口。**代价如实声明**：不属于本队的活会话不能发起恢复——这是有意的收窄；带 role 的诊断读态不受此限（它零写入）。",
		].join("\n"),
		parameters: {
			action: { type: "string", required: true, enum: ["revive", "reappoint"], description: "revive（复活当前 current 会话本身，仅插件自建会话，任意角色）/ reappoint（人改任：人类对话授权的 prepare，候选 = 本队活成员 ∪ 常驻的「自建继任者」）" },
			team: { type: "string", required: true, description: "团队名（[a-z0-9-]+，须已在 roster 中）" },
			role: { type: "string", description: "要恢复的角色名（约定角色名 coordinator；两个动词都受理任意角色——revive 复活同一个会话、reappoint 换人，差别在动词不在角色；不带 role 时只输出诊断，零副作用）" },
		},
		output: textOutput(),
		// Same budget as the rotate tool: the confirmation dialog may legitimately
		// wait ROTATION_CONFIRM_TIMEOUT_MS for a present human.
		timeoutMs: 300000,
		async execute(args, exec) {
			try {
				const action = typeof args.action === "string" ? args.action : "";
				if (!RECOVERY_ACTIONS.has(action)) return wellFormed(`恢复失败：action 必须是 revive 或 reappoint（封闭动词集，§11.9.5①）——恢复刻意只有这两个动作，不存在通用 roster 写入。`);
				const name = readTeamName(args.team);
				if (name.error !== undefined) return wellFormed(`恢复失败：${name.error}`);
				const caller = agentSessionId(exec);
				const now = Date.now();
				// §11.9.5⑧: the entry sweep, awaited, so this call can never interleave
				// with a token that is still in flight.
				const swept = await rotation.sweep({ now, signal: exec.signal });
				const preamble = swept.lines.length === 0 ? [] : ["恢复入口先跑既有过期清扫（§11.9.5⑧）：", ...swept.lines, ""];
				const view = policy.get();
				const team = view.teams.find((entry) => entry.name === name.value) ?? null;
				if (team === null) {
					return wellFormed([...preamble, `恢复失败：团队 ${name.value} 不在注册表中（先用 team_link_roster action=upsert-team 创建）。`].join("\n"));
				}
				// The zero-side-effect read mode: no role → a diagnosis, not an action.
				if (args.role === undefined || args.role === null || args.role === "") {
					return wellFormed([...preamble, "恢复诊断（**本次调用自身**零副作用——不看入口清扫、不弹确认框、不 resume、不铸令牌、不写任何状态；见 §11.9.5⑧：若上面报了它清的过期令牌，那是清扫按既有语义做的真写入）：", ...recoveryDiagnosticLines(team, now, (id) => controller.liveProbe(id)), "", `下一步：${recoveryBoundaryText()}`].join("\n"));
				}
				const role = readRoleName(args.role);
				if (role.error !== undefined) return wellFormed(`恢复失败：${role.error}`);
				// §11.9.5's INITIATOR domain (差异审计 Y2; design line 469). It is
				// answered here, in the instrumented handler, and NOT inside the two
				// verbs: this is the only point that is upstream of BOTH verbs and
				// downstream of the zero-side-effect read mode, which is exactly the
				// boundary the design draws — the domain must refuse BEFORE a session is
				// created, a token is minted or a freeze is broadcast, and the read mode
				// stays open to anybody (it writes nothing).
				const initiator = initiatorAllowsRecovery(team, role.value, caller);
				if (initiator !== true) return wellFormed([...preamble, initiator.error].join("\n"));
				const outcome = action === "revive"
					? await reviveIncumbent({ ctx, policy, rotation, controller }, { teamName: name.value, roleName: role.value, caller, agent: exec.agent, signal: exec.signal, now })
					: await reapIncumbent({ ctx, policy, rotation, controller }, { teamName: name.value, roleName: role.value, caller, agent: exec.agent, signal: exec.signal, now });
				if (outcome.error !== undefined) return wellFormed([...preamble, outcome.error].join("\n"));
				if (outcome.refused !== undefined) return wellFormed([...preamble, outcome.refused].join("\n"));
				return wellFormed([...preamble, ...outcome.lines].join("\n"));
			} catch (error) {
				return wellFormed(`恢复操作失败：${describeError(error)}`);
			}
		},
	})), "team-link: recovery tool");
}
// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

/** Register the M1 model-facing tools on the tools service: the listing with its
 * liveness rows, the export, the cross-session send and the watchdog (§3.1/§3.2). */
function registerTools(ctx, policy, watchdog) {
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_list_sessions",
		description: "列出当前工作区（同目录）的其他 DSH 会话：id、标题/主题摘要、运行状态、创建时间、最近动态，以及每个会话的活性信号行（verdict 五态：ok / goal-disarmed / silent-idle / long-running / dead，含 goal 状态与静默时长）。会话日志只读前 12 个会话且并行读，第 13 行起的活性行标「未读（超出快照窗口）」（verdict/静默/主题均未判定，行本身照常列出）；供跨会话导出、发送前查目标、或判断队友是否失联。读数是快照：行尾附读数时间戳，超过 2 分钟应重新读取。",
		parameters: {
			includeOtherProjects: { type: "boolean", description: "同时列出其他项目目录的会话（默认仅当前工作区目录）" },
		},
		output: textOutput(),
		timeoutMs: 60000,
		async execute(args, exec) {
			try {
				const selfId = agentSessionId(exec);
				const cwd = agentCwd(exec);
				const records = await ctx.sessionQuery.listSessions(undefined);
				const sameProject = records.filter((record) => record.header.cwd === cwd);
				const pool = (args.includeOtherProjects === true ? records : sameProject).filter((record) => record.header.id !== selfId);
				const shown = pool.slice(0, LIST_LIMIT);
				const ids = shown.map((record) => record.header.id);
				const titles = new Map();
				if (ids.length > 0) {
					try {
						const snapshots = await ctx.sessionQuery.readTitleSnapshots(ids);
						for (let index = 0; index < snapshots.length; index += 1) {
							const snapshot = snapshots[index];
							if (snapshot?.status === "fulfilled" && typeof snapshot.value?.title === "string") titles.set(ids[index], snapshot.value.title);
						}
					} catch {
						/* titles are best-effort decoration */
					}
				}
				// One surface read per row of the WINDOW feeds both faces below: the
				// liveness signal (§3.1) needs the last assistant/inbound times and the
				// running turn's start, and the digest folds the same surface into a
				// topic + last-activity preview. A cold or unreadable log is not an
				// error here — both faces degrade to "unknown" and the row still lists.
				//
				// The window is what keeps this tool inside its budget: a cold log costs a
				// zstd decompression plus a surface projection, so reading one per listed
				// session (LIST_LIMIT = 50) overruns the tool timeout on a real workspace.
				// Rows past the window still list, and their liveness line says the row was
				// not read (LV_WINDOW_NOTE).
				const readWindow = shown.slice(0, PREVIEW_SESSIONS);
				// Parallel, not serial: a window of N cold logs costs one decompression's
				// latency, not N. Each read settles alone (an async executor turns even a
				// synchronous throw into a rejection), so one failing log cannot take the
				// rest of the window's liveness rows down with it.
				const settled = await Promise.allSettled(readWindow.map(async (record) => await ctx.sessionQuery.readSurface(record.header.id)));
				const surfaces = new Map();
				for (let index = 0; index < readWindow.length; index += 1) {
					const outcome = settled[index];
					if (outcome.status === "fulfilled") surfaces.set(readWindow[index].header.id, outcome.value);
				}
				const topics = new Map();
				const activities = new Map();
				for (const record of readWindow) {
					const surface = surfaces.get(record.header.id);
					if (surface === undefined) continue;
					const topic = firstSurfaceUserText(surface.events);
					if (topic !== undefined) topics.set(record.header.id, topic);
					const activity = lastSurfaceText(surface.events);
					if (activity !== undefined) activities.set(record.header.id, activity);
				}
				// One reading time for the whole listing: the liveness rows are a
				// snapshot, and every session row says when it was taken and when it
				// stops being trustworthy (§3.1 防偏离).
				const now = Date.now();
				// §3.6.2 评审 #3 (provisional 可见面): an unratified rotation channel is
				// marked on the session row of both parties, so a worker can see that a
				// message arriving over it rides trust that rolls back in 24h.
				// 口径与投递侧对齐（§9.6 ⑧ / 评审 #8）: a provisional record past its
				// deadline is NOT a pair any more — the delivery path already walks the
				// ordinary gates for it. Counting it here would advertise a bypass
				// channel that has already closed (exactly the window between the 24h
				// deadline and the next sweep), so the row uses the same liveness
				// predicate as `pairRecordBetween`.
				const provisionalBySession = new Map();
				for (const pair of policy.get().pairs) {
					if (pair.provisional !== true) continue;
					if (isExpiredProvisionalPair(pair, now)) continue;
					provisionalBySession.set(pair.a, (provisionalBySession.get(pair.a) ?? 0) + 1);
					provisionalBySession.set(pair.b, (provisionalBySession.get(pair.b) ?? 0) + 1);
				}
				const lines = [];
				lines.push(`当前工作区：${cwd}${selfId !== undefined ? `（当前会话：${selfId}）` : ""}`);
				lines.push(`共 ${pool.length} 个其他会话${pool.length > shown.length ? `，按新到旧显示前 ${shown.length} 个` : ""}：`);
				lines.push("");
				if (shown.length === 0) lines.push("（无）");
				for (let index = 0; index < shown.length; index += 1) {
					const record = shown[index];
					const header = record.header;
					const agent = ctx.agents.get(header.id);
					const running = agent?.status === "running";
					const state = running ? "▶ 运行中" : agent !== undefined ? "○ 空闲" : "✕ 未运行";
					const origin = header.origin === "subagent" ? " [子代理]" : "";
					const title = titles.get(header.id);
					const other = args.includeOtherProjects === true && header.cwd !== cwd ? ` · ${header.cwd}` : "";
					const provisionalCount = provisionalBySession.get(header.id) ?? 0;
					const provisionalNote = provisionalCount === 0 ? "" : ` · provisional 配对 ${provisionalCount} 条（换届临时信任：24h 内未批准自动回退，见 team_link_roster）`;
					lines.push(`- ${header.id}${origin} — ${state}${title !== undefined ? `「${title}」` : ""} · 创建于 ${new Date(header.createdAt).toLocaleString()}${other}${provisionalNote}（读数 ${readStamp(now)}，${READ_STALE_NOTE}）`);
					const topic = topics.get(header.id);
					if (topic !== undefined) lines.push(`    主题：${preview(topic, 90)}`);
					const activity = activities.get(header.id);
					if (activity !== undefined && activity !== topic) lines.push(`    最近：${preview(activity, 90)}`);
					// A row past the read window (index >= readWindow.length, which is
					// exactly the rows whose surface we chose not to read) labels itself
					// unread: a verdict built on a missing surface is a reading nobody took,
					// and printing one would hide the bound instead of declaring it (§3.1).
					if (index >= readWindow.length) {
						lines.push(`    活性：${LV_WINDOW_NOTE}`);
					} else {
						const signal = buildLivenessSignal(ctx, header.id, { now, agent, surface: surfaces.get(header.id) });
						lines.push(`    活性：${livenessLine(signal)}`);
					}
				}
				lines.push("");
				lines.push("提示：team_link_export 可导出任意会话（md+JSON）；team_link_send 可发送跨会话消息（需用户批准；接收确认时可选「配对」建立双向免确认通道；目标运行中→注入当前回合，空闲→唤醒为新回合）。");
				// This text goes straight into the caller's history, so it leaves
				// well-formed: preview() no longer CREATES a lone surrogate, and this
				// pass also repairs one that arrived inside an id, a title, a cwd or a
				// logged topic.
				return wellFormed(lines.join("\n"));
			} catch (error) {
				return wellFormed(`列出会话失败：${describeError(error)}`);
			}
		},
	})), "team-link: list tool");

	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_export",
		description: "导出会话完整记录：markdown + JSON 双格式写入会话工作区 .dsh-exports/ 目录（JSON 含全量事件日志，md 为可读渲染）。",
		parameters: {
			sessionId: { type: "string", description: "要导出的会话 id；缺省为当前会话" },
			format: { type: "string", description: "导出格式：md / json / both（缺省 both）" },
			outputDir: { type: "string", description: "输出目录（缺省会话工作区的 .dsh-exports/）" },
		},
		output: textOutput(),
		timeoutMs: 60000,
		async execute(args, exec) {
			const sessionId = typeof args.sessionId === "string" && args.sessionId !== "" ? args.sessionId : agentSessionId(exec);
			if (sessionId === undefined) return "导出失败：未指定 sessionId，且当前上下文无法确定会话 id。";
			const format = ["md", "json", "both"].includes(args.format) ? args.format : "both";
			try {
				const result = await exportSession(ctx, sessionId, { format, outputDir: args.outputDir });
				return wellFormed(`已导出会话 ${sessionLabel(sessionId, result.title)}（${result.events.length} 个事件）：\n${result.files.map((file) => `- ${file}`).join("\n")}`);
			} catch (error) {
				return wellFormed(`导出失败：${describeError(error)}`);
			}
		},
	})), "team-link: export tool");

	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_send",
		description: "向一个或多个会话发送跨会话消息（多会话联调用）。寻址二选一：targetSessionId（单目标）或 targets（广播 fan-out，≤8 项）——每项可以是会话 id、team:<name>/<role> 或 team:<name>/*。team:<name>/* 全队广播只能由该团队现任协调者会话发起（策展理由见《调研》§5.3 论据 (a)），否则整次调用拒绝；team:<name>/<role> 任何会话都可点对点，角色当前空缺时返回 no-holder 结果（不算投递也不算失败）；团队不存在则整次调用拒绝。fan-out 逐目标照走完整投递路径（双门、配对快路径、屏蔽检查都不放宽），返回逐目标结果行与末行汇总；**只要有一个目标不是 delivered，返回文案的首行就是「❌ N 个目标未投递（M 个已投递）」**，之后才是逐目标结果行与汇总——全部投递成功时才维持原形状；重复目标去重后只投一次并在汇总注明。目标会话没有活动代理时（常见成因：目标 id 转录错位）拒绝文案以「❌ 未投递」开头，并列出当前同工作区其他存活会话（id + 运行中/空闲）与核对提示——它不是「已发送」，请对照列表确认 id 后再重发。可选 meta 信封 { type?: 'ruling'|'receipt'|'report'|'ask', pri?: 'P0'|'P1'|'P2', ref?: 不超过 16 字符 } 渲染进 banner 首行紧凑字段（只出现调用方给的键；source 仍恰好三成员，不扩字段），fan-out 时所有目标共享同一 meta。发送前需当前用户批准；目标运行中→消息在步边界注入其当前回合（steer，返回文案带该回合已运行的分钟数），空闲→唤醒目标作为新回合处理。已配对的两个会话互发免确认（接收确认时选「配对：双向免确认」即可建立）。",
		parameters: {
			targetSessionId: { type: "string", description: "目标会话 id（可用 team_link_list_sessions 查询）；与 targets 互斥" },
			targets: { type: "array", items: { type: "string" }, description: "广播 fan-out 的目标列表（最多 8 项）：会话 id、team:<name>/<role> 或 team:<name>/*（全队，仅该团队现任协调者会话）；与 targetSessionId 互斥" },
			message: { type: "string", required: true, description: "要投递的消息文本" },
			meta: { type: "json", description: "可选信封，渲染进 banner 首行（不扩 source）：{ type?: 'ruling'|'receipt'|'report'|'ask', pri?: 'P0'|'P1'|'P2', ref?: string }。只出现调用方给的键；ref 超过 16 字符按码点截断并在返回文案注明；枚举外的值与未定义字段一律拒绝（明确参数错误，不静默丢弃）" },
		},
		// §10.1.2: the model-visible text is unchanged (textOutput), plus the
		// structured receipt the browser half renders the sender-side card from.
		output: sendOutput(),
		async execute(args, exec) {
			const text = args.message;
			const sender = exec?.agent;
			if (sender === undefined || ctx.agents.get(sender.id) !== sender) {
				return "发送失败：跨会话发送需要用户批准，但当前执行上下文没有可交互的活动代理。";
			}
			const meta = readMeta(args.meta);
			if (meta.error !== undefined) return wellFormed(`发送失败：${meta.error}`);
			const wantsTargets = args.targets !== undefined && args.targets !== null;
			const hasTarget = args.targetSessionId !== undefined && args.targetSessionId !== null;
			if (wantsTargets && hasTarget) {
				return "发送失败：targets（广播 fan-out）与 targetSessionId（单目标）互斥——一次调用只能用一种寻址方式。";
			}
			if (!wantsTargets && !hasTarget) {
				return "发送失败：需要 targetSessionId（单目标，沿用原有语义）或 targets（fan-out 广播，最多 8 个目标）之一。";
			}
			if (!wantsTargets) {
				// ---- single target: the legacy path, untouched ---------------------
				const outcome = await deliverToTarget(ctx, policy, sender, exec, args.targetSessionId, text, meta.value);
				// §10.1.2: the receipt is stashed for THIS call (keyed by the frozen
				// args object the registry reuses for the projection) before returning,
				// so the text stays exactly what it was and the card is derived, not
				// parsed back out of it.
				SEND_CARD_BY_ARGS.set(args, buildSendCard({
					at: Date.now(),
					senderSessionId: sender.id,
					meta: meta.value,
					message: sendCardMessage(text),
					targets: [{ sessionId: args.targetSessionId, outcome: outcome.outcome, detail: outcome.text, busy: outcome.busy }],
					deduped: 0,
					fanout: false,
				}));
				return wellFormed(withMetaNotes(outcome.text, meta.notes));
			}
			// ---- §3.4 fan-out: resolve everything first, then deliver per target -
			const resolved = resolveTargetList(Array.isArray(args.targets) ? args.targets : [], policy.get().teams, sender.id, {
				isLive: (sessionId) => ctx.agents.get(sessionId) !== undefined,
			});
			if (resolved.error !== undefined) return wellFormed(`发送失败：${resolved.error}`);
			const report = await fanout(ctx, policy, sender, exec, { rows: resolved.rows, duplicates: resolved.duplicates, meta: meta.value, payload: text });
			for (const note of meta.notes) report.lines.push(`注意：${note}`);
			SEND_CARD_BY_ARGS.set(args, buildSendCard({
				at: Date.now(),
				senderSessionId: sender.id,
				meta: meta.value,
				message: sendCardMessage(text),
				targets: report.results.map((entry) => ({
					sessionId: entry.sessionId,
					expr: entry.expr,
					outcome: entry.outcome,
					detail: entry.text,
					busy: entry.busy,
				})),
				deduped: resolved.duplicates,
				fanout: true,
			}));
			return wellFormed(report.lines.join("\n"));
		},
	})), "team-link: send tool");

	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_watch",
		description: "跨会话看门狗（M1）：给自己注册盯人 —— 被盯会话出现失联征兆（verdict 为 silent-idle / goal-disarmed / dead）且你自己空闲且未处于 armed-active 节奏时，本插件向你自己的会话投递一条固定文案的 tick（你需自己判断是否催办/转派）。action：register（注册，只能给自己注册，targets 不能含自己）/ list（查看注册）/ clear（清除，幂等）。注册上限 3 个/会话；silentMinutes>=10、intervalMinutes>=5（默认 5）、TTL<=24h（默认 12h），到点自动清理。",
		parameters: {
			action: { type: "string", required: true, enum: ["register", "list", "clear"], description: "register / list / clear" },
			targets: { type: "array", items: { type: "string" }, description: "register：被盯会话 id 列表（不能包含自己）" },
			silentMinutes: { type: "integer", description: "register：失联阈值（分钟，>=10，默认 10）" },
			intervalMinutes: { type: "integer", description: "register：巡检间隔（分钟，>=5，默认 5）" },
			ttlHours: { type: "number", description: "register：注册有效期（小时，<=24，默认 12）" },
			id: { type: "string", description: "clear：要清除的注册 id（缺省 = 清除自己全部注册）" },
		},
		output: textOutput(),
		timeoutMs: 30000,
		async execute(args, exec) {
			const caller = agentSessionId(exec);
			if (caller === undefined || ctx.agents.get(caller) !== exec?.agent) {
				return "操作失败：看门狗注册需要可交互的活动代理（exec.agent.id）——看门狗只能给自己注册。";
			}
			const action = typeof args.action === "string" ? args.action : "";
			const now = Date.now();
			const current = policy.get().watchdogs;
			const own = current.filter((entry) => entry.watcherSession === caller);

			if (action === "register") {
				if (own.length >= WATCHDOG_MAX_PER_SESSION) {
					return wellFormed(`注册失败：单个会话最多 ${WATCHDOG_MAX_PER_SESSION} 个看门狗注册（当前 ${own.length} 个）。先用 team_link_watch clear 清理不再需要的注册。`);
				}
				const built = buildWatchdogRegistration({
					caller,
					now,
					targets: args.targets,
					silentMinutes: args.silentMinutes,
					intervalMinutes: args.intervalMinutes,
					ttlHours: args.ttlHours,
				});
				if (built.error !== undefined) return wellFormed(`注册失败：${built.error}`);
				const entry = built.value;
				try {
					await policy.update({ watchdogs: [...current, entry] });
				} catch (error) {
					return wellFormed(`注册失败：写入设置失败（${describeError(error)}）。`);
				}
				watchdog.schedule(entry);
				return wellFormed([
					`已注册看门狗 ${entry.id}：观察者 ${caller} 盯 ${entry.targets.join(", ")}。`,
					`阈值：静默 ${entry.silentMinutes}min · 巡检 ${entry.intervalMinutes}min · TTL ${((entry.expiresAt - now) / 3600000).toFixed(2)}h（到期 ${readStamp(entry.expiresAt)}）。`,
					"观察者空闲且目标出现 silent-idle / goal-disarmed / dead 时，插件会向你自己的会话投递 tick（同一目标一个静默期最多一次；TTL 到点自动清理）。",
				].join("\n"));
			}

			if (action === "list") {
				const lines = [`看门狗注册（共 ${current.length} 个，其中自己 ${own.length} 个）：`];
				if (current.length === 0) lines.push("（无）");
				for (const entry of current) {
					const watcherAgent = ctx.agents.get(entry.watcherSession);
					const watcherState = watcherAgent === undefined ? "未运行" : watcherAgent.status === "running" ? "运行中" : "空闲";
					const dead = watchdog.deadWatchers.has(entry.id) ? " · 观察者=dead（代理不存在，等待用户；注册保留至 TTL）" : "";
					lines.push(`- ${entry.id}${entry.watcherSession === caller ? " [自己]" : ""} — 观察者 ${entry.watcherSession}（${watcherState}${dead}）`);
					lines.push(`    目标：${entry.targets.length === 0 ? "（无）" : entry.targets.join(", ")}`);
					lines.push(`    阈值：静默 ${entry.silentMinutes}min · 巡检 ${entry.intervalMinutes}min · 到期 ${readStamp(entry.expiresAt)} · 团队 ${entry.team ?? "—"}`);
				}
				lines.push("", `（读数 ${readStamp(now)}，${READ_STALE_NOTE}）`);
				return wellFormed(lines.join("\n"));
			}

			if (action === "clear") {
				const wanted = typeof args.id === "string" && args.id !== "" ? args.id : undefined;
				const removable = wanted === undefined ? own : own.filter((entry) => entry.id === wanted);
				if (wanted !== undefined && removable.length === 0) {
					if (current.some((entry) => entry.id === wanted)) {
						return wellFormed(`清除失败：注册 ${wanted} 的观察者不是当前会话，只能清除自己的注册。`);
					}
					return wellFormed(`已清理 0 个注册（${wanted} 不存在或已清除；clear 幂等）。`);
				}
				try {
					await policy.update({ watchdogs: current.filter((entry) => !removable.includes(entry)) });
				} catch (error) {
					return wellFormed(`清除失败：写入设置失败（${describeError(error)}）。`);
				}
				for (const entry of removable) watchdog.cancel(entry.id);
				return wellFormed(wanted === undefined
					? `已清理自己的全部看门狗注册（${removable.length} 个）。`
					: `已清理看门狗注册 ${wanted}。`);
			}

			return "操作失败：action 必须是 register / list / clear。";
		},
	})), "team-link: watch tool");
}

// ---------------------------------------------------------------------------
// web export route (consumed by the conversation-header export button)
// ---------------------------------------------------------------------------

/**
 * §4.1 ②'s decision, extracted as a PURE function so the fence can be asserted
 * without an HTTP fixture (§6 U1 — the reading must not depend on a server being
 * up). It is also the one place the fail-closed rule lives, shared by both layers:
 *
 * - no fence to consult (service absent, or one without `requestRejection`) → 503;
 * - a fence that THROWS has not answered "this request is trusted" → 503;
 * - otherwise the platform's own verdict: its status code, or `null` for "serve it".
 *
 * `null` rather than `undefined` for the allowed case is what lets the handler
 * tell "the fence said yes" from "there was no fence" in one comparison.
 *
 * @param connection - the `connection` service (or whatever `ctx.get` answered).
 * @param req - the request the fence must judge.
 * @returns the status to answer with, or `null` when the request may be served.
 */
function exportGateRejection(connection, req) {
	if (connection === null || connection === undefined || typeof connection.requestRejection !== "function") return 503;
	try {
		const rejection = connection.requestRejection(req);
		return rejection === undefined || rejection === null ? null : rejection;
	} catch {
		// A throwing fence is not a permissive one. Fail closed.
		return 503;
	}
}

/**
 * Serve `GET /team-link/export?session=<id>&format=md|json` downloads.
 *
 * §9.1.3 third site: the same time-of-activation race as the policy store. The
 * route used to be registered only if `webServer` happened to be active at
 * apply time; today it usually is (the absence of this function's warn in the
 * logs is the evidence), but the ordering is not guaranteed by anything. So the
 * service is taken through the same late-attach pattern — immediate try, then
 * `ctx.inject(["webServer"], …)` — while the pre-existing degradation stands:
 * no `webServer` ever ⇒ one warn, no route, and the export tool keeps working.
 *
 * 批次 1 (§4.1) added the SECOND half of that contract: the platform's trust
 * fence. "No fence" now means "no route" for the same reason "no server" does —
 * a route that cannot be guarded must not exist (§5 B2) — and the handler re-reads
 * the fence at request time so a fence that disappears after the mount cannot
 * leave an unguarded window either.
 */
function registerExportRoute(ctx) {
	/**
	 * Mount the route on the context that actually holds the service.
	 *
	 * Returns WHY it did or did not mount (评审 round-3 🔵 #4), the same reason-code
	 * shape `attachFrom` uses for the settings seam, so the activation warn below
	 * is driven by the ONE read this function performs. The pre-fix branch read
	 * `ctx.get("webServer")` a second time just to pick its wording; a provider
	 * that went active between the two reads made the line say "no register()"
	 * about a service that has one (and the injection below still mounted the
	 * route), i.e. the line described a state that was never true.
	 *
	 * - `"mounted"` — a live, FENCED route, registered on `target`'s fiber;
	 * - `"no-register"` — there IS a webServer service here without `register()`;
	 * - `"no-connection"` — the webServer is here but the trust fence is not;
	 * - `"no-rejection"` — a `connection` service that cannot answer a request;
	 * - `"not-active"` — nothing to take from this context.
	 *
	 * 批次 1 (§4.1 ①) grew the reason set by the SECOND service this route needs:
	 * the platform's trust fence (`connection`, whose `requestRejection` is the
	 * Host/Origin fence plus browser authentication). The route is registered only
	 * when BOTH halves are present and usable, so every one of these codes means
	 * "no route" — never "a route nobody guards" (§5 B2).
	 */
	function mount(target) {
		const webServer = target.get?.("webServer");
		if (webServer === undefined) return "not-active";
		if (typeof webServer.register !== "function") return "no-register";
		// §4.1 ①: read through the same runtime channel as `webServer` — never the
		// module-level `inject` array, which would gate the WHOLE plugin on this one
		// optional service (§5 B1).
		const connection = target.get?.("connection");
		if (connection === undefined) return "no-connection";
		if (typeof connection.requestRejection !== "function") return "no-rejection";
		// The effect belongs to the context the service was found on, so a
		// late-attached route is disposed with its own injection fiber.
		target.effect(() => webServer.register({
			kind: "exact",
			path: "/team-link/export",
			handler: async (req, res) => {
				try {
					// §4.1 ②: the request-time half of the fence, and the handler's FIRST
					// statement. The mount-time gate above already guarantees this route was
					// registered only WITH a working fence, so this re-read covers the one
					// window that gate cannot: a fence that went away AFTER the mount. It is
					// read live from the context the route lives on (never captured at mount
					// time), and both of its outcomes are fail-closed — no answer from the
					// fence means no download (§5 B2).
					const rejection = exportGateRejection(target.get?.("connection"), req);
					if (rejection !== null) {
						// The platform's own shape (dsh-client-connection/lib/index.js:608-614):
						// the fence's status code, then "unauthorized" for 401 and "forbidden"
						// for 403. The third case is this plugin's own — a fence that is not
						// there to answer — and it says "unavailable": the request was never
						// judged, so claiming "forbidden" would report a trust verdict that
						// nobody rendered.
						res.writeHead(rejection);
						res.end(rejection === 401 ? "unauthorized" : rejection === 403 ? "forbidden" : "unavailable");
						return;
					}
					// §4.1 ③: the method whitelist, the shape the platform's own routes use
					// (405 + `allow`). This is a download endpoint: it serves GET, and every
					// other method is refused before any session is read.
					if (req.method !== "GET") {
						res.writeHead(405, { allow: "GET" });
						res.end();
						return;
					}
					const url = new URL(req.url ?? "/", "http://localhost");
					const sessionId = url.searchParams.get("session") ?? "";
					const format = url.searchParams.get("format") === "json" ? "json" : "md";
					if (sessionId === "") {
						res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
						res.end("missing ?session=<sessionId>");
						return;
					}
					const { session, events } = await ctx.sessionQuery.readSession(sessionId);
					const title = await titleOf(ctx, sessionId);
					// The id reaches a response header, so keep it to a filename-safe shape.
					// Same invariant as the export tool's artifact names (评审 #2).
					const downloadName = fileSafeSessionId(sessionId);
					if (format === "json") {
						const body = jsonExportText(session, events, title);
						res.writeHead(200, {
							"content-type": "application/json; charset=utf-8",
							"content-disposition": `attachment; filename="${downloadName}.json"`,
						});
						res.end(body);
						return;
					}
					const body = renderSessionMarkdown(session, events, title);
					res.writeHead(200, {
						"content-type": "text/markdown; charset=utf-8",
						"content-disposition": `attachment; filename="${downloadName}.md"`,
					});
					res.end(body);
				} catch (error) {
					res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
					res.end(wellFormed(`export failed: ${describeError(error)}`));
				}
			},
		}), "team-link: export route");
		return "mounted";
	}

	/** The one activation line's wording, from a reason code (§9.1.3 ①②, §4.1 ①).
	 * Each gap names ITSELF: a window that says "no register()" about a service
	 * that has one is exactly the class of lying line the reason-code shape was
	 * introduced to remove. */
	const describeMountFailure = (reason) => {
		if (reason === "no-register") return "no register()";
		if (reason === "no-connection") return "no connection service";
		if (reason === "no-rejection") return "connection without requestRejection()";
		return "not yet active";
	};

	// ① Fast path — webServer already active (the normal case on this host).
	const mountReason = mount(ctx);
	if (mountReason === "mounted") return;
	// ② Not available (yet): one warn for the activation window, and wait for the
	// provider instead of sampling it once. Unlike `settings` there is no tool
	// call to retry from, so the injection is the whole retry story here.
	let warned = false;
	const warnUnavailable = (detail) => {
		if (warned) return;
		warned = true;
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: webServer service unavailable at activation (${detail}) — header export button stays disabled unless it attaches later, the export tool keeps working.`);
	};
	if (typeof ctx.inject === "function") {
		// §4.1 ①: the injection waits for BOTH services, which is what gives the
		// "mount only when the pair is usable" rule its timing guarantee — cordis
		// runs the callback the moment the last dependency becomes active, so the
		// two providers may arrive in either order (and neither order can produce a
		// window with a registered route and no fence).
		ctx.inject(["webServer", "connection"], (child) => {
			const childReason = mount(child);
			if (childReason !== "mounted") warnUnavailable(describeMountFailure(childReason));
		});
	}
	warnUnavailable(describeMountFailure(mountReason));
}

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

/**
 * Host plugin body: deep-link resolution (upstream), the three -pro tools, and
 * the web export route.
 * @param ctx - plugin context carrying the injected services.
 */
function apply(ctx) {
	// §9.1.3 调用点迁移：the one-time legacy migration is driven by the policy
	// store itself, from inside `attach` — calling it here would (as it did
	// before this fix, silently) run against a namespace that is not registered
	// yet whenever the settings provider is still initialising.
	const policy = createPolicyStore(ctx);
	// §10.2 ②: the batch controller holds every AgentHandle this command creates
	// (that is why it is built from THIS context — the plugin's own, §10.2.5) and
	// the command itself is registered through the OPTIONAL `commands` injection.
	// §11.4.2 reuses it: `successor:"auto"` creates the successor from this same
	// root context and holds its handle here, so it must exist before the rotate
	// tool is registered. It also answers §11.5's "did the plugin build this
	// session?" question for the expiry sweep, which is why the rotation
	// controller gets that predicate (the handle registry IS the honest witness).
	const teamSession = createTeamSession(ctx);
	TEAM_SESSION_BY_CTX.set(ctx, teamSession);
	// The M4 controller is built first among the team faces: the watchdog patrol
	// carries its expiry sweep, and the roster/rotate tools call it lazily.
	//
	// §11.5's naming predicate is a DURABLE reader (`successorOwnershipOf`): a
	// plugin reload drops every handle in `teamSession` while the hand-over
	// document and the pending-create intent stay on disk, so the handle registry
	// is handed over as CORROBORATION (`hasHandle`) rather than as the answer.
	// The reading it replaces was the reason the naming line vanished in exactly
	// the window the design put it there for.
	const rotation = createRotation(ctx, policy, {
		hasHandle: (sessionId) => teamSession.hasHandle(sessionId) === true,
	});
	ROTATION_BY_CTX.set(ctx, rotation);
	const watchdog = createWatchdog(ctx, policy, rotation);
	WATCHDOG_BY_CTX.set(ctx, watchdog);
	// §11.9.4/§11.9.5: the recovery controller. It is its own WeakMap-bound object
	// (not a method on the rotation controller) because "which liveness reading this
	// context takes" is the only thing it owns — everything else it does is a call
	// into the published M4 mechanism.
	const recovery = createRecovery(ctx, policy, rotation, teamSession);
	RECOVERY_BY_CTX.set(ctx, recovery);
	registerDeepLinks(ctx);
	registerTools(ctx, policy, watchdog);
	registerTeamTools(ctx, policy, rotation);
	registerRotationTools(ctx, policy, rotation, teamSession);
	registerRecoveryTools(ctx, policy, rotation, recovery, teamSession);
	registerExportRoute(ctx);
	// §10.2 ② `/team_session` and §11.2 `/team_rotate` ride ONE optional seam: a
	// shell without the `commands` service loses both commands, keeps every other
	// face, and gets exactly one warn line for the window (§10.2.1).
	const commandsSeam = createCommandsSeam(ctx, [TEAM_SESSION_COMMAND, TEAM_ROTATE_COMMAND]);
	registerTeamSessionCommand(ctx, policy, rotation, teamSession, commandsSeam);
	registerTeamRotateCommand(ctx, policy, rotation, commandsSeam);
	// §10.2.6 orphan guard: report the `pending-creates` intents that outlived
	// their TTL before this activation, so a create that crashed mid-loop is a
	// list the user can act on rather than a silent orphan.
	void sweepPendingCreates(ctx, policy)
		.then((outcome) => {
			if (outcome.lines.length === 0) return;
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: pending-create 启动清扫 —— 可收编清单：\n${outcome.lines.join("\n")}`);
		})
		.catch((error) => {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: pending-create 启动清扫失败（${describeError(error)}）`);
		});
	// The patrol timers are this plugin's only background work, so they are armed
	// inside one effect: disposing the plugin (unload, reload, config teardown)
	// disposes every timer and the process-local tick state with it.
	ctx.effect(() => watchdog.start(), "team-link: watchdog patrol timers");
}

export { apply, inject, name };

/**
 * Internal surface for `host-half.test.mjs` only: the pure liveness/verdict
 * helpers, the live watchdog controller of a context, the pure roster /
 * blackboard helpers of §3.3, and the M3 broadcast helpers of §3.4/§3.5
 * (address resolution, envelope reading, busy guidance). Nothing else imports
 * it — the model-facing surface is exactly the registered tools.
 */
export const __testing = Object.freeze({
	/** §4.1 ②'s fence decision (批次 1). The download route's whole trust story is
	 * this one pure function plus the mount-time pair check above it, so the
	 * acceptance criterion reads the decision itself instead of standing up an
	 * HTTP fixture (U1). */
	exportGateRejection,
	verdictOf,
	buildLivenessSignal,
	readGoalSignal,
	buildWatchdogRegistration,
	tickMessage,
	watchdogFor: (ctx) => WATCHDOG_BY_CTX.get(ctx),
	normalizeTeams,
	writerGate,
	retireGate,
	applyTeamUpsert,
	applySetRole,
	applyRetire,
	tenureStartOf,
	renderRosterMirror,
	trustReferencesTo,
	readBlackboardLine,
	blackboardHash,
	lastDecisionSeq,
	decisionRow,
	readMeta,
	metaBannerFields,
	resolveTargets,
	resolveTargetList,
	targetLabel,
	busyGuidance,
	readRoleName,
	pairRecordBetween,
	/** The controller `apply` built for this context — or, when `extras` is given,
	 * a §11.5 fixture's controller over the SAME context and policy with the
	 * caller's readings substituted (the live plugin never takes this branch).
	 * The fresh `createPolicyStore(ctx)` reads the same settings namespace as the
	 * one `apply` built, so a fixture changes the READINGS, never the state. */
	rotationFor: (ctx, extras = undefined) => (extras === undefined ? ROTATION_BY_CTX.get(ctx) : createRotation(ctx, createPolicyStore(ctx), extras)),
	/** The §11.5 ownership reading, exposed so the durable sources can be asserted
	 * directly (and so a §11.5 fixture can present a reloaded window). */
	successorOwnershipOf,
	successorOwnershipIndex,
	handoffDocumentNamesSuccessor,
	handoffDocumentNamesLatest,
	ownershipEvidenceLabel,
	maskToken,
	rotationRateLimited,
	rotateGate,
	teamMembers,
	planRotationMigration,
	applyRotationTrust,
	settleRotation,
	clearRotationPending,
	freezeNotice,
	doneNotice,
	cancelledNotice,
	expiredNotice,
	/** §10.2 ② surface: the parser/plan/authorization helpers, the per-context
	 * batch controller (handle ownership), and the §10.2.6 pending-create sweep. */
	readTeamSessionCommand,
	teamSessionDefaultTeam,
	TEAM_SESSION_ROLE_GUIDANCE,
	TEAM_SESSION_DIALOG_MAX_CODE_POINTS,
	TEAM_SESSION_DIALOG_MAX_NEWLINES,
	TEAM_SESSION_DIALOG_LIST_ROWS,
	TEAM_SESSION_DIALOG_TASK_CHARS,
	/** §10.2.8.4 (b) 的**标注两档**（具名常量）：只为「档位长度」的读数开放 —— N=1 时全档
	 * 21 码点、最小档 11 码点，各另加 1 换行。测试量的是这两个常量本身，不是某个用例的巧合。 */
	TEAM_SESSION_DIALOG_CROP_NOTE_TIERS,
	teamSessionPlan,
	teamSessionDialogText,
	teamSessionId,
	withTeamSessionPairs,
	/** §10.2.2 的创建选项构造器本身，只为「半条路由」的读数开放：`model=` 的文法只可能
	 * 给出「两侧都给」或「只给 model」两种形状，而「只给 provider」那半条路由也必须被一个
	 * **真判据**咬住（模型侧能端到端跑一条命令，provider 侧只能直接驱动这个真实函数——
	 * 不是另写一个解析器，否则锁的是复制品）。 */
	buildTeamSessionCreateOptions,
	teamSessionFor: (ctx) => TEAM_SESSION_BY_CTX.get(ctx),
	teamSessionKickoffText,
	sweepPendingCreates,
	pendingCreateList,
	/** §11.9.6 surface: the hand-over document contract (three layers, the
	 * five-hard-section ladder, the shared fact source) and its writer. */
	HANDOFF_HARD_SECTIONS,
	HANDOFF_SOFT_SECTIONS,
	HANDOFF_SECTION_HINTS,
	normalizeHandoffSection,
	parseHandoffBody,
	handoffBodyReport,
	handoffScaffold,
	handoffIntegrityLine,
	readHandoffArgument,
	handoffDocumentPath,
	latestHandoffDocument,
	renderHandoffDocument,
	writeHandoffDocument,
	rotationFactRows,
	provisionalGuidance,
	/** 缺口1 的读数构造器本身（与 `provisionalGuidance` 同一个理由开放：这是一句**读数**，
	 * 谁都能对着确定的输入把它渲染出来核对，而不必去重跑一条完整的 claim）。 */
	unattendedClaimReading,
	/** §11.9.3 诊断面: the two derived words, the ladder text, the read-time
	 * suffix and its gate-layer wrapper, the startup row builder and the one
	 * liveness probe every read face shares. */
	VACANT_LABEL,
	SEATED_DEAD_LABEL,
	recoveryLadderText,
	recoveryLadderSuffix,
	agentIsLive,
	withLiveGateDiagnostic,
	seatedDeadRoles,
	normalizeRecoveries,
	recoveryNote,
	/** §11.2 surface: the `/team_rotate` command's grammar and the instruction it
	 * drives the incumbent with. */
	readTeamRotateCommand,
	teamRotateInstruction,
	TEAM_ROTATE_COMMAND,
	TEAM_ROTATE_KEYS,
	TEAM_ROTATE_KEY_HELP,
	TEAM_ROTATE_KEY_HINT,
	handoffSectionsInline,
	/** §11.9.4/§11.9.5 recovery surface: the closed verb set, the pure preflight
	 * and its rate limit, the candidate computation, the audit builders and the
	 * one per-context liveness probe. */
	RECOVERY_ACTIONS,
	RECOVERY_RATE_LIMIT_MS,
	recoveryBoundaryText,
	vacancyKindText,
	recoveryPreflight,
	recoveryRateLimited,
	reapCandidateRoles,
	/** §4.2 (c) 的合成候选：label 常量与两句文案由同一处产出，所以「候选集 = 活成员 ∪ 自建继任者」与「合成候选的代价声明」都能被断言直接读，而不是抄一份进测试。 */
	SELF_SUCCESSOR_LABEL,
	candidateLabel,
	candidateOptionText,
	/** §4.2 (c) ④ 的交接正文构造器本身：五硬节是否在场且非空，要能被逐节断言（而不是只断言「写了个文件」）。 */
	selfBuiltHandoffBody,
	recoveryDecisionRow,
	recoveryDiagnosticLines,
	withRecoveryRow,
	pluginSessionIdMatches,
	askRecoveryConfirm,
	askRecoveryCandidates,
	writeRecoveryTrails,
	reviveIncumbent,
	reapIncumbent,
	recoveryFor: (ctx) => RECOVERY_BY_CTX.get(ctx),
});

// ===========================================================================
// lib/messaging.js — 批 R · 第 11 小单：messaging 余下三片（导出渲染 / §3.4 广播寻址与投递 / §10.1.2 回执卡）
// ===========================================================================
//
// 归属：docs/2026-10-15-store-compliance-design.md §4 D1/D4 · §5 FR-R1 · §6（拆分不变量 ①–⑤）。
// 本档是 `lib/index.js` 的 messaging 域**余下三片**（§5 候选表里的「messaging 余下 send/list/export」）：
//   ① 导出渲染族 —— 原 "export rendering" 区段：`renderContentBlocks` / `renderSessionMarkdown` /
//      `jsonExportText` / `buildJsonExport` / `fileSafeSessionId` / `titleOf` / `exportSession`；
//   ② §3.4 广播寻址与投递族 —— 原 "broadcast fan-out + envelope meta (§3.4, M3)" 区段：
//      `TEAM_EXPR_PREFIX` / `FANOUT_MAX_TARGETS` / 四个 meta 常量 / `NO_AGENT_LIST_LIMIT` /
//      `NO_DELIVERY_PREFIX` / `readMeta` / `metaBannerFields` / `withMetaNotes` / `resolveTargets` /
//      `resolveTargetList` / `targetLabel` / `busyGuidance` / `liveWorkspaceSessions` /
//      `noAgentRefusal` / `deliverToTarget` / `fanout`；
//   ③ §10.1.2 发送方回执卡族 —— 原 "the sender-side receipt: `output.presentationMeta`" 区段：
//      `SEND_CARD_KIND` / `SEND_CARD_VERSION` / 四个 `SEND_MESSAGE_*` 常量 / `SEND_CARD_ROW_LIMIT` /
//      `sendCardMessage` / `sendBusyOf` / `sendCardEnvelope` / `wellFormedText` / `buildSendCard` /
//      `SEND_CARD_BY_ARGS` / `sendOutput`。
//
// ★ 搬运纪律（D4）：三个区段**逐字节原样**（40 个顶层定义行前只加 `export `）；函数体 / 注释 /
//   缩进 / 文案一个字符都没动（逐字节等价机检见交付报告）。
// ★ 随域搬走的四个**只被本域使用**的常量（设计档 §6 ④「只带它自己的依赖」）：`EXPORT_DIR` /
//   `MD_BLOCK_LIMIT` / `MD_TOOL_RESULT_LIMIT` / `RECEIVE_CONFIRM_TIMEOUT_MS` —— 搬运后入口侧对
//   这四个名字零引用（搬前也只有本域在用：`index.js` 的 378–385 行与 6036/6091/6168/6624 行）。
//
// ★ 被钉符号（`hostSource` 文本锁钉住的 9 个：`writePolicyFileAtomic` / `renameThroughSeam` /
//   `POLICY_FILE_SCHEMA` / `WATCHDOG_DIGEST_DEBOUNCE_MS` / `TICKABLE_VERDICTS` / `agentStateLabel` /
//   `writerGate` / `relayUserMessage` / `buildTeamSessionCreateOptions`）：**一个都没搬**，九个仍
//   逐字节住在 `lib/index.js`（源码锁按函数自身锚点切片，读数因此一字不变）；本档的可执行代码面
//   对那 9 个名字**零命中** —— 它们只出现在本条注释里，那是点名核对，不是引用。
//
// ★ 依赖方向（模块图无环）：本档 → `./shared.js`（`agentSessionId` / `describeError` /
//   `localStamp` / `preview` / `timestamp` / `wellFormed` / `COORDINATOR_ROLE`）· `./rotation.js`
//   （`roleOf`）· `./block.js`（`isBlocked` / `blockSender` / `blockedDeliveryText` /
//   `blockDecisionText`）· `./policy-store.js`（`pairBetween` / `pairRecordBetween` / `withSender`）。
//   这四档都不导入本档 ⇒ **没有新增环**（`shared ↔ rotation` 那一对既有环见 `lib/shared.js` 档头，
//   本单既没触碰、也没加长它）。
//
// ★ 装配缝（先例：`lib/forensics.js` 的 `wireForensics()` / `lib/policy-store.js` 的
//   `wirePolicyStore()`）：本档需要的 7 条入口侧绑定（插件标识 · 三条文本助手 · 会话标签 ·
//   两条活性读数）**只注入、不搬** —— 它们全被入口侧或其它域档继续使用，搬走即「同一函数两份」
//   （设计档 §6 明令禁止双事实源），而域档静态导入入口会成环。前置：入口在**模块求值**时调用一次
//   （`lib/index.js` 模块尾部，`wirePolicyStore(...)` 之后）。后置：本档模块级 `let` 全部绑定到
//   入口那一份真实现，此后每次调用读到的都是它。
//
// ★ 宿主依赖面（Rr3）不变：本档只出现 `node:crypto` / `node:fs/promises` / `node:path` 三条
//   **既有白名单**说明符（与入口同形），内部相对导入不计入。
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { COORDINATOR_ROLE, agentSessionId, describeError, localStamp, preview, timestamp, wellFormed } from "./shared.js";
import { roleOf } from "./rotation.js";
import { blockDecisionText, blockSender, blockedDeliveryText, isBlocked } from "./block.js";
import { pairBetween, pairRecordBetween, withSender } from "./policy-store.js";

// ---------------------------------------------------------------------------
// 装配缝 · `wireMessaging(extras)`（先例：`lib/forensics.js` 的 `wireForensics()`）
// ---------------------------------------------------------------------------
// 前置：入口在**模块求值**时调用一次（`lib/index.js` 模块尾部），给出的 7 个键与被注入的绑定
//       同名同值（同一批绑定、同一份实现）。
// 后置：本档的模块级 `let` 全部绑定到入口那一份真实现；此后每次调用读到的都是它。
// 为什么不是 import：入口 → 域档是单向的；域档 import 入口会成环（实跑当场 TDZ）。
// ---------------------------------------------------------------------------
let PLUGIN_LABEL, truncate, safeJson, textOutput, sessionLabel, buildLivenessSignal, readSessionSurface;

/** 入口侧出口的一次性绑定（见本节档头的前置 / 后置）。 */
export function wireMessaging(extras) {
	({
		PLUGIN_LABEL,
		truncate,
		safeJson,
		textOutput,
		sessionLabel,
		buildLivenessSignal,
		readSessionSurface,
	} = extras);
}

// ---------------------------------------------------------------------------
// 本域自己的常量（原 `lib/index.js`:378–385；只被本域使用 ⇒ 随域搬走，设计档 §6 ④）
// ---------------------------------------------------------------------------
/** Directory (inside the session's workspace) receiving export artifacts. */
export const EXPORT_DIR = ".dsh-exports";
/** Per-text-block truncation limit for markdown exports (JSON stays complete). */
export const MD_BLOCK_LIMIT = 16000;
/** Per-tool-result truncation limit for markdown exports. */
export const MD_TOOL_RESULT_LIMIT = 2000;
/** How long the receiving user has to answer an inbound confirmation. */
export const RECEIVE_CONFIRM_TIMEOUT_MS = 180000;

// ---------------------------------------------------------------------------
// export rendering
// ---------------------------------------------------------------------------

/**
 * Render one content block array as markdown. Known block types (text,
 * tool_use, tool-result) get dedicated shapes; anything else is fenced JSON so
 * the export stays complete without guessing at newer block types.
 */
export function renderContentBlocks(content, limit = MD_BLOCK_LIMIT) {
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
export function renderSessionMarkdown(session, events, title) {
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
export function jsonExportText(session, events, title) {
	return wellFormed(JSON.stringify(buildJsonExport(session, events, title), null, 2));
}

/** Complete-fidelity JSON export document. */
export function buildJsonExport(session, events, title) {
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
export function fileSafeSessionId(sessionId) {
	return String(sessionId).replace(/[^\w.-]/gu, "_");
}

/** Latest log-backed title for one session, or undefined. Never throws. */
export async function titleOf(ctx, sessionId) {
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
export async function exportSession(ctx, sessionId, { format = "both", outputDir } = {}) {
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
export const TEAM_EXPR_PREFIX = "team:";
/** §4.1: one fan-out travels to at most this many targets (counted on the raw
 * argument, before duplicates are collapsed, so a batch can never smuggle extra
 * work past the bound). */
export const FANOUT_MAX_TARGETS = 8;
/** The closed `meta.type` set of §3.4. */
export const META_TYPES = new Set(["ruling", "receipt", "report", "ask"]);
/** The closed `meta.pri` set of §3.4 (P0 = highest). */
export const META_PRIS = new Set(["P0", "P1", "P2"]);
/** §4.1: `meta.ref` is a short reference; a longer one is truncated to this many
 * code points (the `preview` counting unit, so an astral character costs one). */
export const META_REF_LIMIT = 16;
/** Exactly the three keys §3.4 gives the envelope — no more, no fewer. */
export const META_KEYS = new Set(["type", "pri", "ref"]);
/** How many live sessions a `no-agent` refusal names before it stops. The list is
 * a self-healing hint on a refusal path, not a session listing tool (that is
 * `team_link_list_sessions`, which is bounded by `LIST_LIMIT`); ten ids are
 * enough to spot a transcription slip and small enough to keep the refusal
 * readable. A longer match set declares the bound instead of hiding it. */
export const NO_AGENT_LIST_LIMIT = 10;
/** The ❌ lead of the `no-agent` refusal: a failure that a model might read as a
 * queued send (the reported incident) must say so in its very first character —
 * the field the eye lands on before any of the explanatory text. */
export const NO_DELIVERY_PREFIX = "❌ 未投递";

/**
 * §3.4 envelope reading. The whole object is rejected as a unit: a half-accepted
 * envelope would make the delivered banner say something the caller did not ask
 * for, and an undefined key or an out-of-enum value is reported as a parameter
 * error rather than silently dropped.
 *
 * @returns `{ value: meta|null, notes }` (`notes` carries the truncation report)
 *   or `{ error }`.
 */
export function readMeta(value) {
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
export function metaBannerFields(meta) {
	if (meta === null || meta === undefined) return "";
	const parts = [];
	if (meta.type !== undefined) parts.push(`type=${meta.type}`);
	if (meta.pri !== undefined) parts.push(`pri=${meta.pri}`);
	if (meta.ref !== undefined) parts.push(`ref=${meta.ref}`);
	return parts.length === 0 ? "" : ` · ${parts.join(" ")}`;
}

/** Append the envelope notes (a truncated `ref`) to one send result. */
export function withMetaNotes(text, notes) {
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
export function resolveTargets(expr, teams, caller, options = {}) {
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
export function resolveTargetList(targets, teams, caller, options = {}) {
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
export function targetLabel(row) {
	return row.expr === row.sessionId ? row.sessionId : `${row.sessionId}（via ${row.expr}）`;
}

/**
 * §3.5 (the P3 prevention face): one sentence about the semantics the sender just
 * bought. `turnStartedAt` comes from §3.1's signal — the same reading the
 * liveness face prints — and when the surface cannot be read the steer semantics
 * are still stated, just without a number.
 */
export function busyGuidance(signal, now) {
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
export function liveWorkspaceSessions(ctx, exec, selfId) {
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
export function noAgentRefusal(ctx, exec, targetId) {
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
export async function deliverToTarget(ctx, policy, sender, exec, targetId, text, meta, options = {}) {
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
	// ★ 批 I（FR-I3）: 屏蔽的判定从「sender.id 是否在一张**部署级全局名单**里」改成
	// **接收方视角的一对** —— `isBlocked(view, 接收方=targetId, 发送方=sender.id)`：
	// `blocks` 里存在同时含这两个 id 的条目 ⇒ 双向命中；旧格式 `blockedSenders` 仍**并集**
	// 参与（D3/NF-I3：旧记录不静默放开）。`selfId` 用的是**这一处已有的**目标会话 id
	// （`targetId` 就是本轮投递的接收方），没有新引任何身份来源（设计档 §10.2）。
	const blockHit = isBlocked(initialView, targetId, sender.id);
	if (blockHit.blocked) {
		// An explicit block always wins, even over an established pair.
		if (pairBetween(initialView, sender.id, targetId, gateNow)) {
			try {
				await policy.update({ pairs: initialView.pairs.filter((pair) => !((pair.a === sender.id && pair.b === targetId) || (pair.a === targetId && pair.b === sender.id))) });
			} catch {
				/* best-effort pair cleanup once the sender is blocked */
			}
		}
		// FR-I5: 文案点名**谁挡的**与**怎么解**（旧格式那一支还要标注「范围偏大」）。
		return { outcome: "refused", text: blockedDeliveryText(blockHit, targetId, sender.id) };
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
					// ★ 批 I（FR-I2）: 写入**配对化** —— 不再把 `sender.id` 塞进部署级全局名单。
					// 第二个实参是**点屏蔽的那一方**（当事接收方 = 本轮投递的目标会话），它同时
					// 是条目里的 `by`（D2/D7：解除权限的唯一依据）。幂等（同一对不重复追加）。
					await blockSender(policy, targetId, sender.id);
				} catch {
					/* best-effort persistence of the block decision */
				}
				return { outcome: "refused", text: blockDecisionText(targetId, sessionLabel(targetId, targetTitle), sender.id) };
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
export async function fanout(ctx, policy, sender, exec, request) {
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
export const SEND_CARD_KIND = "team-link-send";
/** §10.1.2 card schema version. */
export const SEND_CARD_VERSION = 1;
/** §10.1.2 体积纪律, verbatim (U13 asserts these numbers): a persisted card must
 * be bounded, otherwise one long message is welded into the session log at full
 * length. Over the cap the body becomes head 1500 + the 3-code-point mark +
 * tail 400 = 1903 code points — still inside the cap. */
export const SEND_MESSAGE_MAX_CHARS = 2000;
export const SEND_MESSAGE_HEAD_CHARS = 1500;
export const SEND_MESSAGE_TAIL_CHARS = 400;
/** The 省略标记: exactly three code points, as §10.1.2 specifies. */
export const SEND_MESSAGE_MARK = "...";
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
export const SEND_CARD_ROW_LIMIT = 24;

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
export function sendCardMessage(text) {
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
export function sendBusyOf(running, signal, now) {
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
export function sendCardEnvelope(meta) {
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
export function wellFormedText(value) {
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
export function buildSendCard(request) {
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
export const SEND_CARD_BY_ARGS = new WeakMap();

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
export function sendOutput() {
	return {
		...textOutput(),
		presentationMeta: (args) => SEND_CARD_BY_ARGS.get(args) ?? {},
	};
}

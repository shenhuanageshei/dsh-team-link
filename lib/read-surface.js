// ---------------------------------------------------------------------------
// 读取面域（read-surface）：状态卡 / 列表 / 团队面板的渲染读数 ＋ 两条读路由 —— 批 R（上架合规）第 16 小单
// 从 `lib/index.js` 原样搬出
// ---------------------------------------------------------------------------
// 归属：docs/2026-10-15-store-compliance-design.md §4 D1/D2/D4 · §5 FR-R1 · §6 · §8 Rr1/Rr3/Rr4/Rr8。
// 本档 = 入口原 15 段的读面（38 条声明）：① 读窗口与显示常量（LIST_LIMIT · PREVIEW_SESSIONS ·
// STATUS_TASKS_TAIL_DEFAULT · TASKS_TAIL_DISPLAY_CHARS ＋ forDisplay · 面板「未读」句 · LV_SILENT_MIN ·
// LV_RUN_MIN · 形态与来源字面量）；② §3.1 活性读数（readGoalSignal · verdictOf · buildLivenessSignal ·
// fmtSilence · goalSummary · livenessLine）＋ §4.1 列表读窗（readListReadWindow · listReadTail）；③ 状态卡六段的
// 段体渲染器（probeAgentTeams · sessionFaceLine · teamRoleLines · pendingLines · watchdogRenewField ·
// watchdogLines · tasksDerivedLines · teamDerivedLines · openTenureOf · tenureStartOf）；④ §C1 团队面板载荷
// （panelBadgeOf · modeConclusionLine · buildPanelPayload）；⑤ 两条读路由（exportGateRejection ·
// registerReadRoutes）。
// 实测 59206 字节（CRLF 工作树）/ 58263 字节（EOL 归一到 LF）—— 本小单 60 KB 档位内。机检口径：本档正文按声明行
// 去掉 `export ` 前缀后与入口原位置逐字节相等（EOL 归一），且该段在入口里**零次**。
// 不是本档（下一小单）：createPolicyStore 核心 · /team_session 命令文法 / 计划 / 对话框族 · 换届工具与自动交班 ·
// 交接文档与自建继任者族（另受 host-half.test.mjs 四条**只读 lib/index.js** 的行模板锁约束：rotationFactRows /
// provisionalGuidance / HANDOFF_HARD_SECTIONS / handoffDeliveryMessage 必须留在入口）· 建队命令与回执 · 删团队与
// 名册镜像 · 恢复工具注册族。
// 依赖方向（Rr4，本单不新增环）：不导入入口（ESM 环 = 实跑 TDZ）；出边 = 四条相对导入（./shared.js · ./ledger.js ·
// ./rotation.js · ./messaging.js，逐名见下面的 import）＋ 装配缝 2 条（PLUGIN_LABEL ＋ 被钉的 agentStateLabel 由
// `wireReadSurface(extras)` 求值时一次性绑定到同名 `let` —— 绑定与搬迁前逐个同一 ⇒ 行为逐字不变）。
// 宿主导入 1 条：node:fs/promises 的 open（说明符本来就在 8 条白名单里 ⇒ Rr3 的集合读数一字不变）。
// 被钉符号（9 个：writePolicyFileAtomic / renameThroughSeam / POLICY_FILE_SCHEMA / WATCHDOG_DIGEST_DEBOUNCE_MS /
// TICKABLE_VERDICTS / agentStateLabel / writerGate / relayUserMessage / buildTeamSessionCreateOptions）一个都没搬，
// 九个仍逐字节住在入口；其中只有 agentStateLabel 是本档可执行代码的依赖（只注入不搬），其余 8 个在本档零次。
// 搬运纪律（D4）：新增的只有本段档头 / 4 条 import / 装配缝 / 38 条声明行上的 `export ` 前缀，其余一个字符都没动。
// ---------------------------------------------------------------------------

import { open } from "node:fs/promises";

import { TASKS_PROJECTION_SCAN, blackboardHash, blackboardLines, blackboardPaths, deriveTasksView, readBlackboardFile, renderTaskView } from "./ledger.js";
import { fileSafeSessionId, jsonExportText, renderSessionMarkdown, titleOf } from "./messaging.js";
import { isExpiredProvisionalPair } from "./rotation.js";
import { describeError, maskToken, preview, readStamp, wellFormed } from "./shared.js";

// ---------------------------------------------------------------------------
// 装配缝 · `wireReadSurface(extras)`（先例：`lib/forensics.js` 的 `wireForensics()`）
// ---------------------------------------------------------------------------
// 前置：入口在模块求值时调用一次（lib/index.js 模块尾部，紧挨 `wireTeamSessionCreation(…)`），给出的 2 个键与
// 被注入的绑定同名同值。后置：本档的同名模块级 `let` 全部绑定到入口那一份真实现。为什么不是 import：入口 → 域档
// 会成环（见档头「依赖方向」）。为什么是一次性绑定而不是每次调用现取：绑定之后被搬函数体内的裸名逐字节保留
// （只在函数体外加了这一个缝），D4 的逐字节等价可以直接机检。
// ---------------------------------------------------------------------------
let PLUGIN_LABEL, agentStateLabel;

/** 入口侧出口的一次性绑定（见本节档头的前置 / 后置）。 */
export function wireReadSurface(extras) {
	({ PLUGIN_LABEL, agentStateLabel } = extras);
}

/** Cap on sessions rendered by the list tool. */
export const LIST_LIMIT = 50;
/** Cap on sessions given a surface read — the topic/activity digest AND the §3.1
 * liveness signal both fold the same surface. One cold log costs a zstd
 * decompression plus a surface projection, so the list tool reads a bounded
 * window and the rows past it say so instead of showing a verdict computed from
 * nothing (see {@link LV_WINDOW_NOTE}). */
export const PREVIEW_SESSIONS = 12;

/** §4.2（可观测批 A）the status card's own bounds. 活性半边照旧守
 * PREVIEW_SESSIONS 那条预算（同一个读窗、同一种标注，U7 断言 ≤12）；台账尾是另一种
 * 成本（每团队一次文件读）与另一个问题（「最后几条」），所以有它自己的界 —— 默认 5、
 * 上限 20，**超出即拒绝**（不是静默截断：状态卡是要一屏的，静默截断会让它悄悄变成十屏）。 */
export const STATUS_TASKS_TAIL_DEFAULT = 5;

/** §4.2 台账尾（**行**）的**显示**截断宽度，单位是**码点**（批 F · FR-4）。
 *
 * 为什么需要它：批 F·甲把单行的写入上限从 500 提到 2000（{@link BLACKBOARD_LINE_LIMIT}），
 * 而黑板行会被**两处显示面**渲染出来（状态卡第 ⑥ 段 与 客户端团队面板的 `tasksTail`）——
 * 上限提高 4 倍，这两处最长的行也跟着长 4 倍。**只对显示做截断**：盘上的文件与
 * `team_link_team_read` 的返回**一字不动**（读面保真优先，U5 钉死这一点）。
 * 两处显示面**共用**这一个常量与 {@link forDisplay}（「一处事实一处渲染」）。
 *
 * ★ 按**码点**截断（`[...s]`），**不得**用 `s.length` / `s.slice` —— 后者会把代理对切成
 *   两半，与本仓「astral 切点无半截代理项」的既有红线相抵（与批 E 的 `repairSurrogates`
 *   同源，见 `docs/verification-log.md` 的批 E 宿主回执节）。 */
export const TASKS_TAIL_DISPLAY_CHARS = 300;
/** §4.2 台账行的**显示**形态（批 F · FR-4）。前置：`line` 是盘上的**原始行**（可能很长）。
 *  后置：**只影响显示** —— 盘上文件与 `team_link_team_read` 的返回一字不动；未超宽时
 *  **逐字节**返回入参（`===`，不是「看起来一样」）。
 *  ★ 截断标记点名全文的出处（`team_link_team_read`），否则读者会以为黑板里就存了这么点。 */
export function forDisplay(line) {
	const s = String(line);
	const points = [...s];
	return points.length <= TASKS_TAIL_DISPLAY_CHARS
		? s
		: `${points.slice(0, TASKS_TAIL_DISPLAY_CHARS).join("")}…（已截断，全文见 team_link_team_read）`;
}

/** §C1（客户端面批）团队面板的「未读」句：同一条纪律的**第三个**说话人 —— 面板既不是列表
 * 工具也不是状态卡，它得点名**自己**的窗口（借用别人才是那条纪律要禁的）。
 *
 * 评审修复轮 🔵#3：面板能**翻页**（`offset=k`），所以这句话必须跟着页走 —— 写死「前 12 行」
 * 在第二页上就是一句与实况相反的降级句（那一页读的是 13–24 行）。第一页字节不变，分页那一页
 * 由 {@link panelWindowNote} 换成点名**本次这一页**的措辞。 */
export const PANEL_LV_WINDOW_NOTE = `未读（本面板只读了前 ${PREVIEW_SESSIONS} 行）—— 本行未读取会话日志：verdict / 静默时长 / goal 均未判定（代理状态见上面那一行）。`;
/** §C1 评审修复轮 🔵#3：分页那一页的同一句话 —— 点名**本次这一页**（从第 offset+1 行起），
 * 不再自称「前 12 行」。offset 为 0 / 缺省时逐字复用 {@link PANEL_LV_WINDOW_NOTE}（第一页
 * 的字节一个都不动：客户端夹具与被断言过的旧读数都停在那一句上）。 */
export function panelWindowNote(offset) {
	const start = (typeof offset === "number" && Number.isInteger(offset) && offset > 0 ? offset : 0) + 1;
	if (start === 1) return PANEL_LV_WINDOW_NOTE;
	return `未读（本面板本次只读了 ${PREVIEW_SESSIONS} 行，从第 ${start} 行起）—— 本行未读取会话日志：verdict / 静默时长 / goal 均未判定（代理状态见上面那一行）。`;
}
/** §C1 只读团队面板路由的路径（与导出路由同一道栅栏；**一处**声明，路由注册与测试共用）。 */
export const PANEL_ROUTE_PATH = "/team-link/panel";
/** §C1 面板载荷的缺数说法（R4 的段级出口）：`present:false` + 这一句。 */
export const PANEL_NO_SESSION_IDENTITY = "本次请求没有会话身份（?session=<id> 缺席）：面板不知道「当前工作区」是哪一个，会话面/读窗段不可读（不猜、不冒充）";

/** Liveness thresholds in minutes (§3.1): idle silence past `LV_SILENT_MIN` is
 * the P1 symptom ("双端都在等"), and a running turn past `LV_RUN_MIN` is
 * reported as long-running rather than healthy. */
export const LV_SILENT_MIN = 10;
export const LV_RUN_MIN = 30;

export const TEAM_MODE_AGENT_TEAM = "agent-team";

/** §4.3(4) 的那句**结论**（父档 :67）：agent-team 档不是「另一种平等的形态」。 */
export const TEAM_MODE_CONCLUSION = "结论：agent-team 档应叫「单会话兜底档」，不是「另一种平等的形态」—— 多会话不可用时才切，切过去就等于放弃跨会话的全部能力。";

export const WATCHDOG_ORIGIN_AUTO = "auto";

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
export function readGoalSignal(ctx, sessionId, agent) {
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
export function verdictOf(signal, cfg = {}) {
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
export function buildLivenessSignal(ctx, sessionId, options = {}) {
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

/** A silence duration in minutes, one decimal — display and tick-body unit. */
export function fmtSilence(ms) {
	return `${(ms / 60000).toFixed(1)}min`;
}

/** One-line goal summary for the signal face; `?` means the goal service is absent. */
export function goalSummary(goal) {
	if (goal === null || goal === undefined) return "?";
	if (goal.phase === "none") return "none";
	const blocked = goal.blockedReason === null ? "" : ` blocked=${goal.blockedReason}`;
	return `${goal.phase}/${goal.activation}(${goal.rounds})${blocked}`;
}

/** The per-row liveness signal line of `team_link_list_sessions`. */
export function livenessLine(signal) {
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

/**
 * §4.1（可观测批 A）the list tool's read window, read from the caller's
 * arguments. Returns either `{ error }` — in which case the caller must refuse
 * BEFORE any session log is touched, so the refusal costs ZERO surface reads — or
 * the window itself: `{ mode, records, ids }` plus the readings the tail needs.
 *
 * The three paths are §4.1's, and `ids` (not a positional index) is what the row
 * renderer tests: with `readIds` the read rows are no longer a prefix of the
 * listing, so "index < window length" would label exactly the wrong rows unread.
 *
 * Boundaries are all refusals, never silent cuts (§4.1 / N2): more names than the
 * window, a name that is not in THIS listing, a non-integer or out-of-range
 * `offset`, and the two controls together. Duplicate names are de-duplicated
 * BEFORE they are counted, and a name already inside the default window simply
 * occupies its slot instead of being read twice (§4.1 边界).
 */
export function readListReadWindow(args, shown) {
	const byId = new Map(shown.map((record) => [record.header.id, record]));
	const ids = new Set();
	const finish = (mode, records, extra = {}) => {
		for (const record of records) ids.add(record.header.id);
		return { mode, records, ids, ...extra };
	};
	const wantsNames = args.readIds !== undefined && args.readIds !== null;
	const wantsOffset = args.offset !== undefined && args.offset !== null;
	if (wantsNames && wantsOffset) {
		return { error: "readIds（点名读）与 offset（分页）互斥——一次调用只能用一种读窗控制（两条路径都受同一个成本上限约束）。" };
	}
	if (wantsOffset) {
		const offset = args.offset;
		if (typeof offset !== "number" || !Number.isInteger(offset)) {
			return { error: `offset 必须是整数（收到 ${preview(String(offset), 40)}）。` };
		}
		const max = Math.max(0, shown.length - 1);
		if (offset < 0 || offset > max) {
			return { error: `offset 越界：本次列表共 ${shown.length} 行，有效区间 0..${max}（offset=k 表示从第 k+1 行起读 ${PREVIEW_SESSIONS} 行）。` };
		}
		return finish("offset", shown.slice(offset, offset + PREVIEW_SESSIONS), { offset });
	}
	if (wantsNames) {
		if (!Array.isArray(args.readIds)) return { error: "readIds 必须是会话 id 数组。" };
		const named = [];
		for (const entry of args.readIds) {
			if (typeof entry !== "string" || entry.trim() === "") {
				return { error: `readIds 里有一个不是会话 id 的项（${preview(String(entry), 40)}）——它不属于本次列表。` };
			}
			const id = entry.trim();
			if (!named.includes(id)) named.push(id);
		}
		if (named.length > PREVIEW_SESSIONS) {
			return { error: `readIds 最多 ${PREVIEW_SESSIONS} 个（去重后 ${named.length} 个）——超出即拒绝，本次零读；请分两批点名，或用 offset 分页走完列表。` };
		}
		for (const id of named) {
			if (!byId.has(id)) {
				return { error: `readIds 里的 ${preview(id, 60)} 不属于本次列表（本工作区的会话列表里没有它）——先用 team_link_list_sessions 复制正确的 id。` };
			}
		}
		const namedSet = new Set(named);
		const fill = shown.filter((record) => !namedSet.has(record.header.id)).slice(0, Math.max(0, PREVIEW_SESSIONS - named.length));
		return finish("named", [...named.map((id) => byId.get(id)), ...fill], { named });
	}
	return finish("default", shown.slice(0, PREVIEW_SESSIONS));
}

/**
 * §4.1（可观测批 A）the list tool's TAIL: the unread count plus the two
 * actionable ways to read more. This is the ONLY format addition of the batch
 * (红线 4）——它是**提示不是载荷**，且默认调用也带：读完一页的人不再停在「未读」
 * 这个句号上，而是拿到下一步的确切参数（分页的 offset，或点名的 readIds 骨架）。
 *
 * 行结构与既有行一字不差地留在上面；本函数只追加这一段。样板句与 §4.1 的示例同形
 * （`未读 Y 行（读窗 12/共 X 行）：读第 13–24 行 → offset=12；或点名 → readIds=[…]`），
 * 只是把示例里的占位 id 换成本次**真的**未读的那几个 id —— 提示给的是可复制的参数。
 */
export function listReadTail(read, shown) {
	const unread = shown.filter((record) => !read.ids.has(record.header.id));
	const mode = read.mode === "named"
		? `点名读 ${read.named.length} 个（${read.named.map((id) => preview(id, 60)).join("、")}）+ 默认窗补足`
		: read.mode === "offset"
			? `offset=${read.offset} 起的 ${read.records.length} 行`
			: `默认前 ${read.records.length} 行`;
	const scope = `读窗 ${read.records.length}/共 ${shown.length} 行`;
	const lines = [`读窗：${mode}`];
	if (unread.length === 0) {
		lines.push(`未读 0 行（${scope}）：本次列表已全部读过。`);
		return lines;
	}
	const first = shown.findIndex((record) => !read.ids.has(record.header.id));
	const sample = unread.slice(0, 3).map((record) => `"${record.header.id}"`).join(", ");
	const more = unread.length > 3 ? ", …" : "";
	lines.push(`未读 ${unread.length} 行（${scope}）：读第 ${first + 1}–${first + PREVIEW_SESSIONS} 行 → offset=${first}；或点名 → readIds=[${sample}${more}]`);
	return lines;
}

/** The word for a role whose `current` is the empty seat (deliberate vacancy). */
export const VACANT_LABEL = "vacant";

/**
 * §4.2 的**宿主探测**（只对「切**到** agent-team」这一向）；读面用同一个判据决定名册能不能读。
 *
 * 实测形状（§8 A1，实施期核对本部署）：宿主的服务名就是 `agentTeams`
 * （`TeamService extends Service` → `super(ctx, 'agentTeams')`），而它的读面
 * **要求以活动代理本人为凭据**（`tryMembership(agent)` / `listMembers(agent)`）——
 * 没有「按 id 读某一队」的公开面。于是探测只判三件事：服务在不在、两个读方法在不在、
 * 以及**本次调用方是不是宿主团队成员**（后者只有拿到 agent 才判得了）。
 *
 * 探测不到 ⇒ 调用方（写路径）**拒绝 + 指路 + 零写入**（US3/红线 2）；读路径则如实降级
 * （§4.3(3) 的第二种文案）—— 两条路的处置**不同且不许混用**，所以判据只此一处、
 * 两个调用点各自决定怎么处置。
 */
export function probeAgentTeams(ctx, agent) {
	const service = ctx.get?.("agentTeams");
	// `cause` 是**首行**的判据（D2）：只有服务缺席那一条能说「本部署未提供该投影」，其余四条走中性首行。
	// 文案不再断言「本部署没装载」（D1：本部署的 desktop profile 恰恰装了它）。
	if (service === undefined || service === null) {
		// R1（收尾修复轮）: 这里**只报观测到的现象**，不下因果结论。旧文案断言「本次运行的 profile
		// 没有装载…」是个假阴性来源：cordis 的 ctx.get 只返回**已激活**的 provider（本档 §7 的依据），
		// 一个尚未完成 [Service.init] 的 agentTeams 也会走到这一支，此时「profile 没装载」就是错判。
		// 写成「当前不可见 + 两种可能」：写路径的拒绝照旧刺眼（下一行就是「怎么开」），读路径按 cause
		// 分支如实标注 —— 两条路都不替宿主下结论。
		return { readable: false, available: false, cause: "service-absent", reason: "服务 agentTeams 当前不可见（可能未装载 Agent Teams 组合包 @deepseek-ai/dsh-experimental-agent-team-profile，也可能尚未激活完成 —— 可稍后重试，或核对当前活动 profile 的 dsh.profile.bundles）" };
	}
	if (typeof service.listMembers !== "function" || typeof service.tryMembership !== "function") {
		return { readable: false, available: false, cause: "shape", reason: "宿主 agentTeams 服务在场，但读面形状不认（缺 tryMembership / listMembers）" };
	}
	if (agent === undefined || agent === null) {
		return { readable: false, available: true, cause: "no-agent", reason: "本次调用没有会话身份（exec.agent 缺失），而宿主投影以**活动代理本人**为凭据" };
	}
	try {
		if (service.tryMembership(agent) === undefined) {
			return { readable: false, available: true, cause: "non-member", reason: "本次调用方不是宿主团队的成员（宿主投影只对 Lead / teammate 本人开放）" };
		}
		const members = service.listMembers(agent);
		return { readable: true, available: true, cause: null, members: Array.isArray(members) ? members : [] };
	} catch (error) {
		return { readable: false, available: true, cause: "read-error", reason: `宿主 agentTeams 投影读取失败（${describeError(error)}）` };
	}
}

/** 状态卡 ④ 与面板会话区**共用**的一行会话面（id / 代理状态 / 创建时间 / provisional 标记）。 */
export function sessionFaceLine(header, state, provisionalCount) {
	const provisionalNote = provisionalCount === 0 ? "" : ` · provisional 配对 ${provisionalCount} 条（换届临时信任：24h 内未批准自动回退）`;
	return `- ${header.id} — ${state} · 创建于 ${new Date(header.createdAt).toLocaleString()}${provisionalNote}`;
}

/** §C1 段①团队与角色的**段体**（状态卡与团队面板共用同一份字节：标题由调用方给，段体只有
 * 这一处渲染 —— 「一处事实一处渲染」）。 */
export function teamRoleLines(shownTeams) {
	const lines = [];
	if (shownTeams.length === 0) {
		lines.push("（无团队：用 team_link_roster action=upsert-team 创建，团队名 [a-z0-9-]+）");
		return lines;
	}
	for (const team of shownTeams) {
		lines.push(`- ${team.name} — workspace=${team.workspace === "" ? "（未捕获）" : team.workspace} · policy.writer=${team.policy.writer} · 角色 ${team.roles.length} 个`);
		for (const entry of team.roles) {
			const last = entry.history.length === 0 ? null : entry.history[entry.history.length - 1];
			// 版本史**末条**：不是整段史（那是 roster get 的活），只给最后一段任期。
			const lastTail = last === null ? "（无）" : "　备注：" + preview(last.note, 120);
			const lastText = last === null
				? "（无）"
				: last.session + " " + readStamp(last.from) + " → " + (last.until === null ? "现任" : readStamp(last.until)) + (last.note === undefined ? "" : lastTail);
			const seat = entry.current === null ? "空缺（" + VACANT_LABEL + "）" : "现任 " + entry.current + "（自 " + readStamp(tenureStartOf(entry, team)) + "）";
			lines.push("    角色 " + entry.role + "：" + seat + " · 版本史末条：" + lastText);
		}
	}
	return lines;
}

/** §C1 段②换届 pending 的**段体**（在飞令牌；token 一律掩码）。 */
export function pendingLines(shownTeams) {
	const lines = [];
	let inFlight = 0;
	for (const team of shownTeams) {
		for (const entry of team.roles) {
			if (entry.pending === null || entry.pending === undefined) continue;
			inFlight += 1;
			const pending = entry.pending;
			const migrated = Array.isArray(pending.migratedPairs) ? pending.migratedPairs.length : 0;
			lines.push("- " + team.name + "/" + entry.role + " → 继任者 " + pending.session + " · token " + maskToken(pending.token) + "（掩码——完整令牌只在 prepare 的一次性返回里给出） · 创建 " + readStamp(pending.createdAt) + " · 到期 " + readStamp(pending.expiresAt) + " · 绑定 team=" + pending.team + " role=" + pending.role + " · 已迁移 " + migrated + " 条");
		}
	}
	if (inFlight === 0) lines.push("（无在飞换届令牌）");
	return lines;
}

/**
 * ★ 批 G · FR-R4（设计档 §5 FR-R4 · §7 · §8 U7）：续期留痕那一格的**唯一实现**。
 *
 * 读面有**两处**要渲染它 —— 状态卡第 ③ 段（{@link watchdogLines}）与 `team_link_watch action=list`
 * 的行模板 —— 设计档 §5 FR-R4 明文要求「`renewedAt` 出现在 `watch list` **与**状态卡看门狗段的
 * 渲染文本里」，交付修复轮之前只有状态卡那一侧真的接了（list 行里根本没有这一格）。
 * ⇒ 本函数是**共用同一份字节**的那一份：两处只是调用它，任何一处都不得另写一份格式化
 * （两处各自的文案只要漂移一点点，同一条注册在两个读面上就会说两套读数）。
 *
 * 本部署 `ctx.logger?.warn` 是空操作（设计档 §4 D8），所以留痕只能落在**行字段**上、由这个渲染器读出来。
 * auto 与 manual 一视同仁：手工行永远停在「（从未续期）」（本批**不给 manual 续期**，非目标 3），
 * 那一格对它是准确的读数而不是缺陷。
 *
 * @param entry - 一条看门狗注册行（`policy.watchdogs[]` 的一项）。
 * @returns `" · 上次续期 <stamp>"`（`renewedAt` 是有限数时）或 `" · 上次续期（从未续期）"`。
 */
export function watchdogRenewField(entry) {
	return typeof entry.renewedAt === "number" && Number.isFinite(entry.renewedAt)
		? " · 上次续期 " + readStamp(entry.renewedAt)
		: " · 上次续期（从未续期）";
}

/** §C1 段③看门狗的**段体**（谁盯谁 / 阈值 / 到期；按观察者会话登记，与团队只是弱关联）。 */
export function watchdogLines(ctx, watchdogs) {
	const lines = [];
	if (watchdogs.length === 0) {
		lines.push("（无注册）");
		return lines.map((line) => wellFormed(line));
	}
	for (const entry of watchdogs) {
		const watcher = ctx.agents.get(entry.watcherSession);
		const watcherState = watcher === undefined ? "未运行" : watcher.status === "running" ? "运行中" : "空闲";
		const teamField = entry.team === "" || entry.team === null || entry.team === undefined ? "（未指定）" : entry.team;
		const targets = entry.targets.length === 0 ? "（无）" : entry.targets.join("、");
		// FR-3a（批 1）: 来源那一格只在 auto 上出现 —— 手工行的字节逐字不变（客户端与宿主两边的
		// 既有夹具都停在那一串上）。
		const originField = entry.origin === WATCHDOG_ORIGIN_AUTO ? " · 来源 auto（建队时自动注册）" : "";
		// ★ 批 G · FR-R4（设计档 §5 FR-R4 · §8 U7）：那一格的表达式抽成了共享 helper
		//   {@link watchdogRenewField} —— 本处与 `team_link_watch action=list` 的行模板**同调它**，
		//   两处共用同一份字节（不得各写一份格式化）。
		const renewField = watchdogRenewField(entry);
		lines.push("- " + entry.id + " · team=" + teamField + " · 观察者 " + entry.watcherSession + "（" + watcherState + "） → 目标 " + targets + " · 静默阈 " + entry.silentMinutes + "min · 巡检 " + entry.intervalMinutes + "min · 到期 " + readStamp(entry.expiresAt) + renewField + originField);
	}
	// ★ 批 E（FR-4）：本出口是**模型可见文本**（状态卡/面板看门狗段）⇒ 过消毒。逐行替（不是拼接后
	// 替）：返回形状仍是 string[]，调用方 `lines.push(...)` 那两处逐字不变。
	return lines.map((line) => wellFormed(line));
}

/** §9.3.3 台账的**派生读数**段体：`team_link_team_read` 与团队面板共用同一份字节（同一扫描
 * 窗、同一渲染器 renderTaskView）—— 「同源同形」由这一处保证，而不是靠两边各写一遍。 */
export function tasksDerivedLines(taskRows) {
	const lines = [`（派生读数：扫描最近 ${TASKS_PROJECTION_SCAN} 行；逐任务给「最后主张」与「未消解存疑」——是读数，不是裁决）`];
	const scanned = taskRows.slice(-TASKS_PROJECTION_SCAN);
	const derived = deriveTasksView(scanned);
	// 两条附注描述的是**扫描窗**（派生的真实输入），不是整份文件：`更早的 N 行` 是窗口没
	// 收进来的，「无法解析」是窗口读不出来的（§9.3.3 边界）。
	const earlier = taskRows.length - scanned.length;
	if (earlier > 0) lines.push("（派生只扫描最近 " + TASKS_PROJECTION_SCAN + " 行；更早的 " + earlier + " 行未参与派生）");
	if (derived.unparsable > 0) lines.push("（" + derived.unparsable + " 行无法解析，未参与派生）");
	if (derived.views.length === 0) lines.push("（无任务行）");
	for (const view of derived.views) lines.push(renderTaskView(view));
	return lines;
}

/** §C1 评审修复轮 🔵#4：**一队一份**的派生读数块（团队面板台账段的派生半边）—— 块首带团队
 * 归属头，与同一段台账尾的 `- <team>/tasks.md：…` 两处头同形，续行四空格缩进。行体逐字来自
 * {@link tasksDerivedLines}（面板不改写一个字节），但多团队面板必须说得出「最后主张 / 未消解
 * 存疑」是哪一支队伍的：原先把各团队的派生行顺序拼进同一个数组、一个团队名都不带，两支队伍的
 * 派生读数在界面上分不出谁是谁（对照 `- <team>/tasks.md：…` 那两处头）。
 *
 * @param teamName - 这一份派生读数所属的团队名。
 * @param derivedLines - `tasksDerivedLines()` 的原样输出（首行是块头）。
 * @returns 带归属头的行数组；输入为空时也是空（不造一个空块）。
 */
export function teamDerivedLines(teamName, derivedLines) {
	if (!Array.isArray(derivedLines) || derivedLines.length === 0) return [];
	const lines = ["- " + teamName + "/tasks.md：" + derivedLines[0]];
	for (let index = 1; index < derivedLines.length; index += 1) lines.push("    " + derivedLines[index]);
	return lines;
}

/** The open (incumbent) tenure record of one role, or `null` — `until: null` is
 * what marks the tenure the current holder is still serving. */
export function openTenureOf(entry) {
	for (let index = entry.history.length - 1; index >= 0; index -= 1) {
		const record = entry.history[index];
		if (record.session === entry.current && record.until === null) return record;
	}
	return null;
}

/** The start of a role's open tenure — the incumbent's `from`, falling back to
 * the team creation time when history holds no open record (hand-edited row). */
export function tenureStartOf(entry, team) {
	const open = openTenureOf(entry);
	return open === null ? team.createdAt : open.from;
}

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
export function exportGateRejection(connection, req) {
	if (connection === null || connection === undefined || typeof connection.requestRejection !== "function") return 503;
	try {
		const rejection = connection.requestRejection(req);
		return rejection === undefined || rejection === null ? null : rejection;
	} catch {
		// A throwing fence is not a permissive one. Fail closed.
		return 503;
	}
}

/** §3.3 面板段顶那句**档位结论**：措辞**复用** `TEAM_MODE_CONCLUSION`（同一个常量 ——
 * 面板不复述第二份），前面只加一句「当前是哪些团队在 agent-team 档」。 */
export function modeConclusionLine(shownTeams) {
	const agentTeamTeams = shownTeams.filter((team) => team.mode === TEAM_MODE_AGENT_TEAM);
	const head = agentTeamTeams.length === 0
		? "档位结论：当前没有团队处于 agent-team 档（都是多会话档）。"
		: "档位结论：团队 " + agentTeamTeams.map((team) => team.name).join("、") + " 处于 agent-team 档。";
	return head + TEAM_MODE_CONCLUSION;
}

/**
 * §3.3 面板的**三态徽标**（＋ 一条**不冒充**的第四态）。判据只有两个来源，且各自说得出：
 *   - **Lead** 取自 settings 的 Lead 指针（`mode === agent-team && leadSessionId === id`）——
 *     与宿主投影**无关**，所以投影缺席时这一格照给；
 *   - **成员** 取自宿主 `agentTeams` 投影（`member.id`）；
 *   - 投影**可读**且两处都不是 ⇒ `多会话`（这是读数，不是默认值）；
 *   - 投影**读不到** ⇒ **不冒充**：给 `unknown` ＋ 「档位未判定（原因）」，绝不写成「多会话」
 *     （把一个没读到的名册写成「不是成员」正是 §3.3 明令禁止的那种编造）。
 */
export function panelBadgeOf(sessionId, teams, projection) {
	const lead = teams.find((team) => team.mode === TEAM_MODE_AGENT_TEAM && team.leadSessionId === sessionId);
	if (lead !== undefined) return { state: "agent-team-lead", label: "agent-team·Lead" };
	if (projection.readable) {
		const member = projection.members.find((entry) => entry !== null && typeof entry === "object" && entry.id === sessionId);
		if (member !== undefined) return { state: "agent-team-member", label: "agent-team·成员" };
		return { state: "sessions", label: "多会话" };
	}
	return { state: "unknown", label: `档位未判定（成员名册读不到：${projection.reason}）` };
}

/**
 * §C1（客户端面批）团队面板的**只读**载荷：与宿主状态卡同构的六段 ＋ 形态段。
 *
 * 三条纪律写死在这里：
 *   ① **零写**（W9）：读路径走状态卡那一套（`policy.get` / agents 注册表 / sessionQuery /
 *      黑板文件），**绝不**调用 `team_read` 的惰性清扫 —— 那条会清 pending、删过期 provisional；
 *   ② **同源**（W2/W6）：落点行直接取 `policy.placementLine()`；段体用状态卡同一批渲染器
 *      （{@link teamRoleLines} / {@link pendingLines} / {@link watchdogLines} /
 *      {@link sessionFaceLine} / {@link tasksDerivedLines}）—— 客户端只显示、不重算；
 *   ③ **降级在数据里**（W3/R4）：每段 `present` + `lines`，取不到时 `present:false` +
 *      `unavailable.reason`（面板只显示这一句，不静默留空、不假装「零团队」）。
 *
 * @param ctx - plugin context (`agents` / `sessionQuery` live here).
 * @param policy - the policy store `apply` built.
 * @param options - `{ sessionId, offset }`: the browser's current session and the read-window page.
 * @returns the payload, or `{ error }` when the read-window argument is refused (the caller
 *   answers 4xx; a refusal happens BEFORE any session log is touched).
 */
export async function buildPanelPayload(ctx, policy, options = {}) {
	const now = Date.now();
	const view = policy.get();
	const sessionId = typeof options.sessionId === "string" ? options.sessionId : "";
	const sessionSegment = { present: false, lines: [], rows: [], tail: [], page: null, unavailable: { reason: PANEL_NO_SESSION_IDENTITY } };
	const payload = {
		ok: true,
		generatedAt: now,
		placementLine: policy.placementLine(),
		form: { present: true, lines: [], conclusion: "", badges: {} },
		teams: { present: true, lines: teamRoleLines(view.teams) },
		pending: { present: true, lines: pendingLines(view.teams) },
		watchdogs: { present: true, lines: watchdogLines(ctx, view.watchdogs) },
		tasksTail: { present: true, lines: [], derived: [] },
		sessions: sessionSegment,
	};
	// ---- 形态段（§3.3）：档位结论句与三态徽标都由宿主给字节 ----
	payload.form.conclusion = modeConclusionLine(view.teams);
	payload.form.lines = [payload.form.conclusion];
	// 宿主投影：以**本次请求的会话**为凭据（宿主读面只对 Lead / teammate 本人开放）。没有会话
	// 身份时按探针自己的「无身份」分支如实降级 —— 徽标随之进 unknown，而不是编一个「多会话」。
	const modeProjection = probeAgentTeams(ctx, sessionId === "" ? undefined : ctx.agents.get(sessionId));
	payload.form.badges = {};
	// ---- 台账尾：每团队一次文件读；渲染器与状态卡 ⑥ 同一份、派生读数与 team_read 同一份 ----
	for (const team of view.teams) {
		if (team.workspace === "") {
			payload.tasksTail.lines.push("- " + team.name + "/tasks.md：（无 workspace 记录：黑板根未知，台账不可读）");
			continue;
		}
		const file = await readBlackboardFile(blackboardPaths(team).tasks);
		if (file.error !== undefined) {
			payload.tasksTail.lines.push("- " + team.name + "/tasks.md：（tasks.md 无法读取：" + file.error + "）");
			continue;
		}
		const rows = blackboardLines(file.text);
		const shownRows = rows.slice(-STATUS_TASKS_TAIL_DEFAULT);
		const head = file.exists ? "共 " + rows.length + " 行，显示 " + shownRows.length + " 条" : "（文件不存在，按空处理：0 行）";
		payload.tasksTail.lines.push("- " + team.name + "/tasks.md：" + head + " · baseHash=" + blackboardHash(file.text) + "（仅供参考/审计：tasks 只追加、不接受 baseHash 参数）");
		// ★ 批 F · FR-4（显示面②）：与状态卡第 ⑥ 段**同一个**截断（同一常量、同一函数）。
		//   这一段是**面板 payload**，客户端只显示、不重算 ⇒ 截断必须在宿主这一侧做完。
		//   盘上文件与 `team_link_team_read` 的返回一字不动（U5）。
		for (const row of shownRows) payload.tasksTail.lines.push("    " + forDisplay(row));
		for (const derivedLine of teamDerivedLines(team.name, tasksDerivedLines(rows))) payload.tasksTail.derived.push(derivedLine);
	}
	if (payload.tasksTail.lines.length === 0) payload.tasksTail.lines.push("（无团队：台账不可读 —— 先用 team_link_roster action=upsert-team 建队）");
	// ---- 会话面 / 读窗（§12：未读行显示为未读 ＋ 只读翻页；与状态卡同一个有界读窗）----
	const records = await ctx.sessionQuery.listSessions(undefined);
	let cwd;
	if (sessionId !== "") {
		const record = records.find((entry) => entry.header.id === sessionId);
		cwd = record === undefined ? undefined : record.header.cwd;
		if (cwd === undefined || cwd === null || cwd === "") {
			const agent = ctx.agents.get(sessionId);
			cwd = agent === undefined || agent === null ? undefined : agent.session?.header?.cwd;
		}
	}
	if (cwd === undefined || cwd === null || cwd === "") {
		sessionSegment.unavailable = { reason: sessionId === "" ? PANEL_NO_SESSION_IDENTITY : "会话 " + preview(sessionId, 60) + " 读不到它的 cwd（盘上没有这条会话记录、也没有活动代理）—— 会话面/读窗段不可读" };
		return payload;
	}
	const pool = records.filter((record) => record.header.cwd === cwd && record.header.id !== sessionId);
	const shown = pool.slice(0, LIST_LIMIT);
	const read = readListReadWindow({ offset: options.offset }, shown);
	if (read.error !== undefined) return { error: read.error };
	const settled = await Promise.allSettled(read.records.map(async (record) => await ctx.sessionQuery.readSurface(record.header.id)));
	const surfaces = new Map();
	for (let index = 0; index < read.records.length; index += 1) {
		const outcome = settled[index];
		if (outcome.status === "fulfilled") surfaces.set(read.records[index].header.id, outcome.value);
	}
	const provisionalBySession = new Map();
	for (const pair of view.pairs) {
		if (pair.provisional !== true) continue;
		if (isExpiredProvisionalPair(pair, now)) continue;
		provisionalBySession.set(pair.a, (provisionalBySession.get(pair.a) ?? 0) + 1);
		provisionalBySession.set(pair.b, (provisionalBySession.get(pair.b) ?? 0) + 1);
	}
	const rows = [];
	for (const record of shown) {
		const id = record.header.id;
		const agent = ctx.agents.get(id);
		const face = sessionFaceLine(record.header, agentStateLabel(agent), provisionalBySession.get(id) ?? 0);
		// 读窗之外的行**显示为未读**：一个没人读过的 verdict 是编出来的读数（§3.1 同一条纪律）。
		const liveness = read.ids.has(id)
			? livenessLine(buildLivenessSignal(ctx, id, { now, agent, surface: surfaces.get(id) }))
			: panelWindowNote(read.mode === "offset" ? read.offset : 0);
		const badge = panelBadgeOf(id, view.teams, modeProjection);
		payload.form.badges[id] = badge;
		rows.push({ id, badge, lines: [face, "活性：" + liveness] });
	}
	sessionSegment.present = true;
	sessionSegment.unavailable = null;
	sessionSegment.lines = ["同工作区其他会话 " + pool.length + " 个；本次读窗 " + read.records.length + " 行（预算 ≤" + PREVIEW_SESSIONS + "）。"];
	sessionSegment.rows = rows;
	sessionSegment.tail = listReadTail(read, shown);
	// 评审修复轮 🟡#2：翻页的语义是「**当前页之后**」，不是「第一个未读行」—— 后者算出的
	// 第 0 行永远不在第二页的读窗里 ⇒ nextOffset 恒等于 0 ⇒ 客户端唯一的翻页控件指回第一页
	// （13–24 个会话时两页循环；>24 个时第 25 行起在 UI 上不可达，客户端没有手输 offset 的口子）。
	// 下一页 = 本页读窗的**末行序号 + 1**（命名读在面板路由上不会出现：它只收 offset），越过
	// 末行即 null ⇒ 客户端隐藏「读更多」按钮。列表工具段尾那句 listReadTail 一字未动（它是
	// 提示不是载荷，且与工具面同源）。
	const windowEnd = (read.mode === "offset" ? read.offset : 0) + read.records.length;
	sessionSegment.page = { offset: read.mode === "offset" ? read.offset : 0, size: read.records.length, total: shown.length, nextOffset: windowEnd >= shown.length ? null : windowEnd };
	return payload;
}

/**
 * §4.1 批次 1 起：本插件的**读路由**都挂在同一道栅栏下，由这一个函数一次注册两条：
 * `GET /team-link/export`（会话下载，批次 1）与 `GET /team-link/panel`（§C1 的**只读**
 * 团队面板载荷）。两条路由**共用**同一套门 —— 挂载期的 `webServer` + `connection` 成对门、
 * 请求期的 {@link exportGateRejection}、仅 GET —— 栅栏是一个函数，不是一条规则的两份实现。
 *
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
export function registerReadRoutes(ctx, policy) {
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
		// §C1（客户端面批）的第二条读路由：**只读**团队面板载荷。门与导出路由**逐字同一套**
		// —— 同一次 mount()、同一个 exportGateRejection、同一条「仅 GET」；请求期再读一次栅栏
		// 覆盖的也正是同一扇「挂载之后才消失」的窗。
		target.effect(() => webServer.register({
			kind: "exact",
			path: PANEL_ROUTE_PATH,
			handler: async (req, res) => {
				try {
					const rejection = exportGateRejection(target.get?.("connection"), req);
					if (rejection !== null) {
						res.writeHead(rejection);
						res.end(rejection === 401 ? "unauthorized" : rejection === 403 ? "forbidden" : "unavailable");
						return;
					}
					if (req.method !== "GET") {
						res.writeHead(405, { allow: "GET" });
						res.end();
						return;
					}
					const url = new URL(req.url ?? "/", "http://localhost");
					const sessionId = url.searchParams.get("session") ?? "";
					const offsetRaw = url.searchParams.get("offset");
					let offset;
					if (offsetRaw !== null && offsetRaw !== "") {
						offset = Number(offsetRaw);
						// 越界/非整数在这里就拒（4xx + 可读原因）：面板把它显示成「面板数据不可用」，
						// 而不是静默给一页空数据（N2：不静默截断、不静默补零）。
						if (!Number.isInteger(offset) || offset < 0) {
							res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
							res.end(JSON.stringify({ ok: false, error: "offset 必须是 ≥0 的整数（收到 " + preview(String(offsetRaw), 40) + "）。" }));
							return;
						}
					}
					const payload = await buildPanelPayload(ctx, policy, { sessionId, offset });
					if (payload.error !== undefined) {
						res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
						res.end(JSON.stringify({ ok: false, error: payload.error }));
						return;
					}
					res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
					res.end(JSON.stringify(payload));
				} catch (error) {
					res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({ ok: false, error: "面板读取失败：" + describeError(error) }));
				}
			},
		}), "team-link: panel route");
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
		// §C1 起这条降级线覆盖**两条**读路由（导出 ＋ 只读面板）：两处共用同一套门，缺席也是
		// 一起缺席 —— 所以说出口的也必须是两条面（只说导出会把面板的缺口说成「没事」）。
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: webServer service unavailable at activation (${detail}) — 两条读路由（header export button 与 GET ${PANEL_ROUTE_PATH} 只读团队面板）都未挂载；导出工具本身照常工作，面板会如实显示「面板数据不可用」。`);
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

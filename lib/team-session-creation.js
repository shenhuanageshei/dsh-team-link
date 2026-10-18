// ---------------------------------------------------------------------------
// 批 R（上架合规）第 14 小单：`/team_session` 批量建队 + 批 P 继承读面 —— 从 `lib/index.js` 原样搬出
// ---------------------------------------------------------------------------
// 归属：docs/2026-10-15-store-compliance-design.md §4 D1/D2/D4 · §5 FR-R1 · §6（拆分契约：只做「移动 + 补
//       export」、无副作用搬家、模块图无环）· §8 Rr1/Rr3/Rr4/Rr8。
// ★ 本档是什么：入口原 6,519–7,351 行（833 行 / 34 条声明）的**一整块**：
//   ① §10.2.3 的三条建队助手（pairs 补丁 · 角色行 · 启动任务）· §10.2.4 的批量确认框 ·
//      §10.2.2/§10.2.6 的创建循环 `createTeamSessions`；
//   ② §10.2.2 的**唯一创建落点** `createRootAgent`（工作区建/取 → create options → `agents.create`
//      → 挂载/回滚 → 命名）与它的三个时序助手；
//   ③ 批 P 的三个继承读面（preset / provider-model / approvalPolicy）· 可写面探针 · preset 可用性核对 ·
//      「值 / 未继承（原因：…）」的唯一措辞源与一次采集器（FR-P1…FR-P4）。
//   实测：**52,804 字节**（CRLF 工作树）/ **51,972 字节**（EOL 归一到 LF）—— 本小单 60 KB 档位上限之内。
//   机检口径：把本档那段正文按声明行去掉 `export ` 前缀后，与入口原位置的同一段**逐字节相等**
//   （EOL 归一）；该段在入口里**零次**。
//   ★ 它是一个**自成一体的块**：建队三助手 + 确认框 + 创建循环 + 唯一创建落点 + 继承读面互相闭合，
//     对外只经下面「装配缝」的 11 条入口侧出口与三条相对导入取物。
// ★ 本档**不是**（留给下一小单）：§10.2 的命令文法常量与解析器（`TEAM_SESSION_*` / `readTeamSessionCommand`）·
//   计划与渲染族（`teamSessionPlan` / `teamSessionTitle` / `teamSessionDialogText` / `teamSessionDialogQuestion`）·
//   被钉的 `buildTeamSessionCreateOptions`（含 `resolveTeamSessionModelSelection` 与 `relayUserMessage`）·
//   `registerTeamSessionRoles` / 回执与 `registerTeamSessionCommand`；以及入口里另外三个尚未成档的大块
//   （policy store 核心 / 状态卡诊断面 / 删团队与 roster 写面）。**为什么这一单不搬**：整条 §10.2 家族实测
//   **178,803 字节**，越过本小单 60 KB 的档位上限；上面这些块又与入口的命令注册 / 段 / 回执面互引，
//   单独成档会把一条注册链劈开（设计档 §4 D1 的领域边界）。
// ★ 依赖方向（Rr4「模块图无环」）：本档**不导入入口** `lib/index.js`（那会构成 ESM 环，实跑当场 TDZ）——
//   ① 内部相对导入 **3 条**：`./shared.js`（`describeError` / `wellFormed`）· `./policy-store.js`
//      （`pairBetween`）· `./rotation.js`（`roleRecord`）；
//   ② 装配缝注入 **11 条**（先例 `wireForensics()` / `wireWatchdog(extras)` / `wireRecovery(extras)`）：
//      `wireTeamSessionCreation(extras)` 在模块求值时一次性绑定到同名模块级 `let` 上 —— 绑定与搬迁前
//      **逐个同一** ⇒ 行为逐字不变；逐条归属见入口的 `teamSessionCreationExtras()`。
//   两类出边**都不回指入口或本档** ⇒ 本单**不新增环**。
// ★ 宿主导入 **0 条**（只用相对导入 + 全局对象）⇒ `Rr3` 的**集合**读数一字不变。
// ★ 被钉符号核对（本仓 `hostSource` 文本锁钉住的 9 个：`writePolicyFileAtomic` / `renameThroughSeam` /
//   `POLICY_FILE_SCHEMA` / `WATCHDOG_DIGEST_DEBOUNCE_MS` / `TICKABLE_VERDICTS` / `agentStateLabel` /
//   `writerGate` / `relayUserMessage` / `buildTeamSessionCreateOptions`）：**本单一个都没搬**，九个仍逐字节
//   住在入口（定义、文档注释与锚点切片位置一字不动 ⇒ 那几条源码锁读数不变）。本档可执行代码对它们的
//   引用 = **1 个**（`buildTeamSessionCreateOptions`，`createRootAgent` 里那一处调用）—— 它按「被钉符号
//   只注入不搬」经缝传入；其余 8 个在本档**零次**（`relayUserMessage` 与其族留在入口，见上「本档不是」）。
// ★ 搬运纪律（D4）：本档新增的只有 ① 本段档头 ② 3 条 import 语句 ③ 装配缝 ④ 15 条声明行上的 `export `
//   前缀；其余（含全部行内注释、嵌套函数与中文文案）**一个字符都没动**。
// ---------------------------------------------------------------------------

import { pairBetween } from "./policy-store.js";
import { roleRecord } from "./rotation.js";
import { describeError, wellFormed } from "./shared.js";

// ---------------------------------------------------------------------------
// 装配缝 · `wireTeamSessionCreation(extras)`（先例：`lib/forensics.js` 的 `wireForensics()`）
// ---------------------------------------------------------------------------
// 前置：入口在**模块求值**时调用一次（`lib/index.js` 模块尾部，紧挨 `wireRecovery(…)`），给出的 11 个键
//       与被注入的绑定**同名同值**。
// 后置：本档的模块级 `let` 全部绑定到入口那一份真实现；此后每次建队 / 确认框 / 继承读面 / warn 读到的都是它。
// 为什么不是 import：见档头「依赖方向」②（入口 → 域档会成环）。
// 为什么是一次性绑定而不是每次调用现取：绑定之后创建循环、唯一创建落点与继承读面体内的裸名**逐字节保留**
// （只在函数体外加了这一个缝），D4 的逐字节等价可以直接机检。
// ---------------------------------------------------------------------------
let buildTeamSessionCreateOptions, teamSessionTitle, teamSessionDialogQuestion, addTeamSessionPending, removeTeamSessionPending, teamSessionKickoffMessage, TEAM_SESSION_CONFIRM_TIMEOUT_MS, TEAM_SESSION_DIALOG_ID, TEAM_SESSION_CONFIRM_LABEL, TEAM_SESSION_PENDING_TTL_MS, PLUGIN_LABEL;

/** 入口侧出口的一次性绑定（见本节档头的前置 / 后置）。 */
export function wireTeamSessionCreation(extras) {
	({
		buildTeamSessionCreateOptions,
		teamSessionTitle,
		teamSessionDialogQuestion,
		addTeamSessionPending,
		removeTeamSessionPending,
		teamSessionKickoffMessage,
		TEAM_SESSION_CONFIRM_TIMEOUT_MS,
		TEAM_SESSION_DIALOG_ID,
		TEAM_SESSION_CONFIRM_LABEL,
		TEAM_SESSION_PENDING_TTL_MS,
		PLUGIN_LABEL,
	} = extras);
}

// ---------------------------------------------------------------------------
// §10.2.2/§10.2.3/§10.2.4/§10.2.6 + 批 P 继承 —— 建队与创建落点
// ---------------------------------------------------------------------------

/**
 * The pairs patch of §10.2.3 (i): one record per newly created worker, each a
 * TWO-WAY pairing with the coordinator. `pairBetween` is the same predicate the
 * send path uses, so a channel the store already holds is not duplicated.
 */
export function withTeamSessionPairs(view, coordinatorId, workerIds, now) {
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
export function teamSessionRoleRow(role, sessionId, now, note) {
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
export function teamSessionKickoffText(plan, role, cwd) {
	// §10.2.8.10 ②（默认值第 4 条**反转**，2026-09-22 用户裁定）: 既无正文也无 `task=` 时
	// **仍然驱动这个会话**，但投出去的是**一具最小唤醒（待命通知）**，不是一条被编出来的任务 ——
	// 三件事必须逐字在场：①「本次命令未给任务」②「你已被创建为团队 <team> 的角色 <role>」
	// ③「请等待主会话派活」；并且**不得**要求它做事、**不得**含任务内容。
	//
	// 上一轮评审 🔵#2 说这支对 `/team_session` 不可达（drive 循环按
	// `plan.task === undefined ? [] : created` 把它整个挡掉）——**那道守卫本轮已撤除**，所以
	// 这一支回归主路径，成为「空会话里发命令 ⇒ 新会话也在侧边栏可见」的那一半。
	// 判据（U30 反转）咬 `followedup === 1`、不含任务内容、含待命措辞。
	if (typeof plan.task !== "string" || plan.task.trim() === "") {
		return wellFormed([
			"【待命通知 · 本次命令未给任务】",
			`你已被创建为团队 ${plan.team} 的角色 ${role}（worker 根会话，由主会话 ${plan.coordinatorId ?? "（未知）"} 通过 /team_session 创建，roster 登记已写入）。`,
			"",
			"- 本次命令未给任务：这条消息只是唤醒你、让你出现在会话列表里；它不含任何任务内容，也没有要求你现在做什么。",
			// 评审 round-1 🔵#4：那句「已为你们建立 pairs」在**释放中止**（§10.2.8.9 ② 写时复检 ⇒ 本批
			// 明确不写 pairs）或 pairs 写入失败时为假 —— 所以改成「应当已有 / 若仍弹框说明没建上」，
			// 把可能性说全，而不是替一次可能没发生的写入作保。
			"- 请等待主会话派活：主会话会用 team_link_send 把任务发给你（本命令应已为你们建立 pairs 双向免确认通道；若投递仍弹确认框，说明这次没建上，见主会话的完成回报）。",
			`- 工作目录（cwd）：${cwd}`,
		].join("\n"));
	}
	const perRole = teamSessionRoleTask(plan.task, role);
	return wellFormed([
		`你是团队 ${plan.team} 的 ${role}（worker 根会话，由主会话 ${plan.coordinatorId ?? "（未知）"} 通过 /team_session 创建）。`,
		"",
		`- 工作目录（cwd）：${cwd}`,
		// 能走到这一行 ⇒ `plan.task` 非空（空的那一支在上面就返回了）。`perRole` 仍是空的
		// 那一格（形如 `role:` 的分角色任务里这个角色没写任务）就退回整段任务，不静默丢字。
		`- 任务：${perRole === "" ? plan.task : perRole}`,
		"",
		`汇报与协作：用 team_link_send 把结果发回主会话 ${plan.coordinatorId ?? "（未知）"}（本命令应已为你们建立 pairs 双向免确认通道；若投递仍弹确认框，说明这次没建上，见主会话的完成回报）；团队约定与裁决用 team_link_team_read 读、team_link_team_append 写（本会话已登记为团队 ${plan.team} 的角色 ${role}）。`,
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
export function createdTeamSessionRoles(results) {
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
export function createTeamSession(rootCtx) {
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
export function installTeamSessionModelSelection(agentCtx, selection) {
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
export function teamSessionNoConfirmText(plan, reason) {
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
export async function askTeamSessionBatch(ctx, agent, plan, text, signal) {
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
export async function createTeamSessions(ctx, controller, policy, plan, cwd, coordinatorId) {
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
	// §10.2.8.10 ②（默认值第 4 条**反转**）: 每个新建会话**都被驱动一次** —— 有任务支投
	// 启动任务，无任务支投**最小唤醒**（{@link teamSessionKickoffText} 的待命通知那一支）。
	// 上一轮那道 `plan.task === undefined ? [] : created` 守卫就是在这里，它被**撤除**了：
	// 无回合的会话在侧边栏**不可见**（行 ① 的真机观察 2/3），而「会话照建、却看不见」与
	// 「没建」在体验上是同一件事。措辞仍按支如实写（`minimalWake` ⇒ 报告写「已投最小唤醒」）。
	const minimalWake = typeof plan.task !== "string" || plan.task.trim() === "";
	for (const item of created) {
		const row = results.find((candidate) => candidate.sessionId === item.sessionId);
		try {
			item.handle.agent.followup(teamSessionKickoffMessage(teamSessionKickoffText({ ...plan, coordinatorId }, item.role, cwd), coordinatorId));
			if (row !== undefined) {
				row.driven = true;
				if (minimalWake) row.minimalWake = true;
			}
		} catch (error) {
			if (row !== undefined) {
				row.driven = false;
				row.detail = `已创建，但${minimalWake ? "最小唤醒" : "启动任务"}投递失败（${describeError(error)}）`;
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
/**
 * 批 P · FR-P1：**换届继任者的设置继承读取器**（设计档 `docs/2026-10-14-rotation-inheritance-design.md`
 * §5 FR-P1 / §6.2；D1–D6）。
 *
 * 前置：`incumbentSessionId` 是该角色**当前现任**的会话 id（调用方已在名册里确认过它在位）。
 * 后置：返回 `{ preset, provider, model, approvalPolicy }`；**读不到的项一律 `null`**
 *      （绝不退回调用方、也绝不编造）；本函数**绝不抛**（逐项 try/catch ⇒ `null`）——
 *      因为「继承失败」永远不许阻断创建（NF-P3：换届场景前任已被冻结，拒绝会把整次换届
 *      卡死在没人能修的墙前）。
 *
 * 三个读面 = **实施首步三个宿主探针的结论**（只读，实读宿主 `app.asar`；证据逐条见交付报告）：
 *
 *  - **preset（D1，与复活面 {@link buildTeamSessionResumeOptions} 同一个字段）**：
 *    活代理 ⇒ `agent.session.header.agentPreset`（宿主 `SessionHeader.agentPreset?: string`）；
 *    **代理不在场（探针 3）** ⇒ 会话级冷读 `ctx.sessionQuery.readSession(id).session.agentPreset`
 *    —— 宿主该方法是「读并回放校验一整条逻辑会话日志，**不让它变成实时**」，返回
 *    `SessionLogSnapshot = { session: SessionHeader, inheritedEventCount, events }`。
 *    ⇒ 探针 3 通过：**已死前任仍可继承预设**（header 在盘上），两个分支都不静默（§9）。
 *  - **provider/model（探针 1）**：活代理 ⇒ 宿主**自己的持久投影**
 *    `ctx.get("sessionProjections").stateOf(session, "modelSelection")?.lastUsed`
 *    （state 形状 `{ lastUsed, pending }`，`ModelSelection = { provider, model, reasoningEffort? }`；
 *    宿主 `ApiSessionController.selectionFor()` 就是这一句）；投影面不在场 / 无活代理 ⇒
 *    **同一条投影的取值源**：冷读最后一条 `request/header` 的 `data.header.config.{provider, model}`
 *    （宿主 `applyModelSelectionProjection` 逐字这么折叠）。
 *  - **approvalPolicy（探针 2 / D4）**：活代理 ⇒ 投影 `permissions.currentValue`
 *    （宿主 `PermissionSelection { currentValue: string }`），回退宿主服务出口
 *    `ctx.get("permissionPresets").current(session)`。
 *    ⚠ **本项不进 plan**（D6：`buildTeamSessionCreateOptions` 逐字不改）——FR-P4 的落地是
 *    「**创建返回之后**调 `permissionPresets.set(handle.agent.session, value)`」，见
 *    {@link applyInheritedApprovalPolicy}（读面在这里，写面在 {@link approvalWriteFace}）。
 *
 * **与设计档伪代码的一处实施偏差（如实声明）**：§6.2 把它写成**同步**函数，而探针 3 的
 * 会话级读面（`sessionQuery.readSession`）是**异步**的 ⇒ 实施为 `async`；两个调用点都在
 * `async` 上下文里（`createRootAgent` 之前）。**语义一字未变**：仍然不抛，读不到的项仍是 `null`，
 * 仍然只有 `preset/provider/model` 三项进 plan。
 *
 * **第 2 单（FR-P3）在同一处加了一个 `reasons` 键（如实声明）**：§6.2 的伪代码写的是「四项对象」，
 * 而 FR-P3 要求三处出口逐项说出「没继承的**原因**」——原因必须与值出自**同一次观测**（否则
 * 调用方为了补一句理由要重探一遍宿主面，值与该理由可能对不上）。所以四个值键的形状**一字未动**，
 * 另加 `reasons: { preset, model, approvalPolicy }`（继承到的项为 `null`）。
 * 两个调用点现在走 {@link collectInheritableSettings}（它在本函数之上再叠 preset 可用性核对与
 * 审批档可写面探针，并渲染 FR-P3 的三行）。
 */
function inheritableSessionId(value) {
	return typeof value === "string" && value !== "" ? value : null;
}

/** 继承面只接受「非空字符串」；其余（含 `undefined` / `null` / 空串 / 非串）一律 `null`。 */
function nonEmptyStringOrNull(value) {
	return typeof value === "string" && value !== "" ? value : null;
}

/** 活代理（拿不到 / 读面抛错 ⇒ `undefined`；这里也绝不把异常抛给调用方）。 */
function liveAgentForInheritance(ctx, sessionId) {
	if (sessionId === null) return undefined;
	try {
		const agent = ctx?.agents?.get?.(sessionId);
		return agent === null ? undefined : agent;
	} catch {
		return undefined;
	}
}

/** 会话级冷读快照（探针 3 的那个面；读不到 / 服务不在场 / 抛错 ⇒ `undefined`）。 */
async function coldSessionSnapshot(ctx, sessionId) {
	if (sessionId === null) return undefined;
	const query = ctx?.sessionQuery;
	if (typeof query?.readSession !== "function") return undefined;
	try {
		return await query.readSession(sessionId);
	} catch {
		return undefined;
	}
}

/** 「没有可继承的对象」这一条原因的**唯一措辞**（席位空缺时三项共用）。 */
const INHERIT_REASON_NO_INCUMBENT = "该角色没有可读的前任会话 id（席位空缺，没有可继承的对象）";

/** preset：活代理的 header 优先（D1）；**没有**活代理才走会话级冷读（探针 3 的「仍继承」分支）。
 * `readCold` 是**那一次**冷读的取值器（同一次调用里只观测一次 —— 宿主 `readSession` 的契约就是
 * 「从**一次**观测拿到 header 与完整日志」，两次读可能落在两个不同的时刻）。
 *
 * @returns `{ value, reason }`（FR-P3）：继承到 ⇒ `reason === null`；读不到 ⇒ `value === null`
 *   且 `reason` 是**这一次观测**里读不到的那一句原因。原因与值出自同一次观测，所以三处出口
 *   渲染的值与原因不可能对不上（不在调用方重探一次宿主面）。 */
async function readInheritedPreset(liveAgent, readCold, sessionId) {
	if (sessionId === null) return { value: null, reason: INHERIT_REASON_NO_INCUMBENT };
	const live = nonEmptyStringOrNull(liveAgent?.session?.header?.agentPreset);
	if (live !== null) return { value: live, reason: null };
	// 活着但没存过 ⇒ §9「前任没有存过 preset」那一档：`null` + 具名原因（Pi8），**不编造**，
	// 也不去翻日志（同一个 header 就在内存里，翻出来的还是它）。
	if (liveAgent !== undefined) return { value: null, reason: "前任无存量（它的会话 header 里没有 agentPreset）" };
	const snapshot = await readCold();
	const cold = nonEmptyStringOrNull(snapshot?.session?.agentPreset);
	if (cold !== null) return { value: cold, reason: null };
	return {
		value: null,
		// 探针 3 的两档：**读面在不在**与**存量有没有**是两条不同的原因，各自如实说。
		reason: snapshot === undefined
			? "宿主无会话级读面（前任的代理不在场，且 sessionQuery.readSession 不可用/抛错）"
			: "前任无存量（盘上的会话 header 里没有 agentPreset）",
	};
}

/** 宿主持久投影里的「上次用的模型」；投影未注册 / 面不在场 / 抛错 ⇒ `null`。 */
function modelPairFromProjection(ctx, session) {
	if (session === undefined || session === null) return null;
	try {
		const state = ctx?.get?.("sessionProjections")?.stateOf?.(session, "modelSelection");
		const provider = nonEmptyStringOrNull(state?.lastUsed?.provider);
		const model = nonEmptyStringOrNull(state?.lastUsed?.model);
		return provider !== null && model !== null ? { provider, model } : null;
	} catch {
		return null;
	}
}

/**
 * 冷读日志里最后一条 `request/header` 的模型对（宿主那条投影的**取值源**）。
 * ★ 只认**最后一条**：它本身读不出可运行的一对时**不往前翻**（更早的那一条是「更早用过的」，
 * 把它当成「上一次用的」就是编造）。
 */
function modelPairFromEvents(events) {
	if (!Array.isArray(events)) return null;
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.type !== "request/header") continue;
		const config = event?.data?.header?.config;
		const provider = nonEmptyStringOrNull(config?.provider);
		const model = nonEmptyStringOrNull(config?.model);
		return provider !== null && model !== null ? { provider, model } : null;
	}
	return null;
}

/**
 * provider/model（探针 1）：投影优先（零日志读），冷读兜底（无活代理 / 投影面不在场）。
 *
 * ★ 定点修复轮（2026-10-14；父侧实测 `assertion total: 1690 (failed: 1)`，唯一红 = 判据 Pi2①）：
 * 本函数原先把 `liveAgent?.session` 当作**第一个**实参传给 `modelPairFromProjection(ctx, session)`
 * ⇒ 那个会话对象落进 `ctx` 形参、`session` 形参收到 `undefined` ⇒ 它首行的
 * `if (session === undefined || session === null) return null;` 直接返回 `null`
 * ——于是**宿主持久投影一次都没被问过**（本次实测读数：夹具的 `stateOf(..., "modelSelection")`
 * 命中 **0** 次，而冷读面被点名 1 次），模型对每次都落到冷读兜底，并在「有活代理、但日志里
 * 没有可用的 `request/header`」时读成 `null` ⇒ `plan.provider/model` 退回宿主缺省
 * （缺省服务因此被问 1 次，继任者拿到 `deepseek/deepseek-chat`，而前任存的是另一对）。
 * 修法只是把 `ctx` 补回第一个实参；**语义一字未改**：仍投影优先、仍冷读兜底、读不到仍是 `null`。
 *
 * ★ 第 2 单（FR-P3）把它改成 `{ value, reason }`：**原因与值同源**（同一次观测），三处出口
 * 渲染的就是这一对，不许在调用方为一个 `null` 现编理由。
 */
async function readInheritedModelPair(ctx, liveAgent, readCold, sessionId) {
	if (sessionId === null) return { value: null, reason: INHERIT_REASON_NO_INCUMBENT };
	const projected = liveAgent === undefined ? null : modelPairFromProjection(ctx, liveAgent?.session);
	if (projected !== null) return { value: projected, reason: null };
	const snapshot = await readCold();
	const fromEvents = modelPairFromEvents(snapshot?.events);
	if (fromEvents !== null) return { value: fromEvents, reason: null };
	// 读不到 ⇒ 把**这一次**真正试过哪几条面逐条点名（不写一句笼统的「读不到」）。
	const faceNotes = [];
	if (liveAgent === undefined) faceNotes.push("代理不在场（没有可问的会话投影）");
	else if (typeof ctx?.get?.("sessionProjections")?.stateOf !== "function") faceNotes.push("宿主没有 sessionProjections 服务（会话投影读面缺席）");
	else faceNotes.push("会话投影里没有 modelSelection.lastUsed");
	faceNotes.push(snapshot === undefined
		? "会话日志读不出来（sessionQuery.readSession 不可用或抛错）"
		: "日志最后一条 request/header 里没有可运行的一对");
	return { value: null, reason: `前任上次用的模型对读不到（${faceNotes.join("；")}）` };
}

/** approvalPolicy（探针 2 / D4）：投影 `permissions.currentValue` 优先，回退 `permissionPresets.current`。
 * @returns `{ value, reason }`（FR-P3）—— 与 preset/model 同一个理由：值与其「读不到的原因」同源。
 *   ★ 注意「**可读**」与「**可写**」是两件事：这里只回答读面；能不能设进新会话由
 *   {@link approvalWriteFace} 回答（D4/FR-P4）。 */
function readInheritedApprovalPolicy(ctx, liveAgent) {
	const session = liveAgent?.session;
	if (session === undefined || session === null) {
		return { value: null, reason: "代理不在场（审批档的读面与写面都挂在活代理的会话上）" };
	}
	try {
		const projected = nonEmptyStringOrNull(ctx?.get?.("sessionProjections")?.stateOf?.(session, "permissions")?.currentValue);
		if (projected !== null) return { value: projected, reason: null };
	} catch {
		// 投影面不在场 / 抛错 ⇒ 落到服务出口，不在这里下结论。
	}
	try {
		const current = nonEmptyStringOrNull(ctx?.get?.("permissionPresets")?.current?.(session));
		if (current !== null) return { value: current, reason: null };
	} catch {
		// 服务出口也抛 ⇒ 报「读不到」，原因是下面这一句（不是编造一个档位）。
	}
	return { value: null, reason: "前任没有可读的审批档（permissions 投影与 permissionPresets.current 都没有读数）" };
}

/** 四项的**全 null**读数：读取器任何一步失手时的兜底形状（与「逐项读不到」同一个值面）。 */
const NO_INHERITABLE_SETTINGS = Object.freeze({ preset: null, provider: null, model: null, approvalPolicy: null });
/** 读取器**整体**失手时三项共用的兜底原因（逐项读面已各自 try/catch ⇒ 走到这里只剩「它也抛了」）。 */
const NO_INHERITABLE_REASON_INTERNAL = "读取器内部异常（宿主读面抛错；本函数刻意不抛，NF-P3 不许继承失败阻断创建）";
const NO_INHERITABLE_REASONS = Object.freeze({
	preset: NO_INHERITABLE_REASON_INTERNAL,
	model: NO_INHERITABLE_REASON_INTERNAL,
	approvalPolicy: NO_INHERITABLE_REASON_INTERNAL,
});

export async function readInheritableSettings(ctx, incumbentSessionId) {
	try {
		const sessionId = inheritableSessionId(incumbentSessionId);
		const liveAgent = liveAgentForInheritance(ctx, sessionId);
		// 冷读**至多一次**（同一个观测，两个项各取自己那一半）：先记「读过没有」，再记结果 ——
		// 读不到也是结果，不许因为「结果是 undefined」就再读一遍。
		let coldRead = false;
		let coldValue;
		const readCold = async () => {
			if (!coldRead) {
				coldRead = true;
				coldValue = await coldSessionSnapshot(ctx, sessionId);
			}
			return coldValue;
		};
		const preset = await readInheritedPreset(liveAgent, readCold, sessionId);
		const pair = await readInheritedModelPair(ctx, liveAgent, readCold, sessionId);
		const approval = readInheritedApprovalPolicy(ctx, liveAgent);
		return {
			preset: preset.value,
			// 评审 🔵#7：拆成两个显式键（调用方 `?? undefined` 逐项落回宿主缺省）。
			provider: pair.value === null ? null : pair.value.provider,
			model: pair.value === null ? null : pair.value.model,
			approvalPolicy: approval.value,
			// ★ 第 2 单（FR-P3）：**同一次观测**里「这一项为什么没继承」的那一句。继承到的项为
			// `null`；三项的键与上面三个值面一一对应（`model` 这一项同时覆盖 provider/model 一对）。
			// 这是**加键**，四个值键的形状一字未动（既有判据 Pi1/Pi2 读的就是那四个）。
			reasons: { preset: preset.reason, model: pair.reason, approvalPolicy: approval.reason },
		};
	} catch {
		return { ...NO_INHERITABLE_SETTINGS, reasons: { ...NO_INHERITABLE_REASONS } };
	}
}

/**
 * 批 P · **继承来的 preset 还能不能用**（设计档 §9「继承来的 preset 已被删除/改名」那一档；Pi4）。
 *
 * 为什么需要它：`buildTeamSessionCreateOptions`（**逐字不改**，D6）里 `resolve` 抛错是**真失败**，
 * 它照抛 ⇒ `createRootAgent` 抛 ⇒ 整条换届失败。而设计档 §4 D2/§9 与 NF-P3 要求的是
 * 「**resolve 抛 ⇒ 回退宿主缺省 + 具名如实行，不阻断创建**」（前任已被冻结，拒绝会把整次换届
 * 卡死在没人能修的墙前）。所以判断必须发生在**调用点**：创建之前先把存量探一次，「不可解析」
 * 就地降级成 `undefined`（＝落宿主缺省），并把这句原因交给 FR-P3 的三处出口。
 *
 * 为什么探一次不算「编造」也不算浪费：`resolve` 是**只读**面（租约在 `acquireScope`，不在它），
 * 且**它本来就在同一个调用链里要被问一次**（`buildTeamSessionCreateOptions` 里那次）——这里多问
 * 的一次换来的是「确认框在人类动手**之前**就说出这次会继承什么」（US-P3），代价一次只读调用。
 *
 * @returns `{ value, reason }`：可用 ⇒ `value` 是**原样的存量 id**（不改写调用方给的东西，
 *   `buildTeamSessionCreateOptions` 会照原样再解析一次）、`reason === null`；
 *   不可用 ⇒ `value === null` 且 `reason` 点名那个 id 与**出路**。
 */
async function verifyInheritablePreset(ctx, preset) {
	if (preset === null) return { value: null, reason: null };
	const agentPresets = ctx?.get?.("agentPresets");
	if (agentPresets === undefined || agentPresets === null) {
		return { value: null, reason: `前任存着 preset「${preset}」，但宿主没有 agentPresets 服务（解析不了）⇒ 本次落宿主缺省` };
	}
	if (typeof agentPresets.resolve !== "function") {
		return { value: null, reason: `前任存着 preset「${preset}」，但 agentPresets 服务在场而解析面形状断层（resolve=${typeof agentPresets.resolve}）——本插件拒绝裸调，本次落宿主缺省（不裸 TypeError）` };
	}
	try {
		const resolved = await agentPresets.resolve(preset);
		if (nonEmptyStringOrNull(resolved?.id) === null) {
			return { value: null, reason: `前任的 preset「${preset}」解析不出可用的 preset id（宿主 resolve 返回空）⇒ 本次落宿主缺省` };
		}
		return { value: preset, reason: null };
	} catch (error) {
		return { value: null, reason: `前任的 preset「${preset}」已不可解析（宿主 resolve 抛：${describeError(error)}）⇒ 本次落宿主缺省；出路：在设置里恢复或重命名这个 preset，或把新会话的 preset 在壳里手动设回去` };
	}
}

/**
 * 批 P · FR-P4：审批档的**可写面**（与 {@link readInheritedApprovalPolicy} 的**读面**分开 ——
 * 「读得到」不等于「设得进去」，D4 要求两者都成立才算继承）。
 *
 * 三态（这一处读、三处出口都渲染它，不各自探一遍）：
 *  - `writable`：服务在场且 `set` 是函数 ⇒ FR-P4 走默认支路（创建返回之后设）；
 *  - `absent`：服务**不在场** ⇒ **不调**，只走 FR-P3 的如实行（`未继承` + 具名原因）；
 *  - `broken`：服务**在场**但写面形状断层（无 `set`）⇒ **具名拒绝文案**（与 preset 面
 *    {@link buildTeamSessionCreateOptions} 的 `agentPresets 服务在场，但组成面形状断层` 同款纪律：
 *    **绝不裸调**、**绝不裸 TypeError**）。★ 与 preset 面唯一的差异（有意，如实声明）：
 *    preset 面在形状断层时**拒绝创建**，这里**不拒绝换届** —— 审批档继承是可选增强，让一个
 *    可选增强把整次换届卡死（前任已冻结）恰是 D2/NF-P3 明令禁止的；所以这里的「拒绝」是
 *    **拒绝那次设置调用**，并把那句具名原因原样投进确认框 / 回执 / 交接文档三处 + 一行 warn。
 */
function approvalWriteFace(ctx) {
	const service = ctx?.get?.("permissionPresets");
	if (service === undefined || service === null) {
		return { face: "absent", service: null, reason: "宿主没有 permissionPresets 服务（审批档只读得到、设不进去）⇒ 本次不设，新会话用宿主缺省" };
	}
	if (typeof service.set !== "function") {
		return { face: "broken", service: null, reason: `permissionPresets 服务在场，但写面形状断层（set=${typeof service.set}）——本插件拒绝裸调该服务（不裸 TypeError，与 preset 面的形状断层同款纪律），本次不设审批档；请核对宿主 permissionPresets 服务的形状（0.4.2 记过 standingKeyFor → acquireScope 那一类换代）` };
	}
	return { face: "writable", service, reason: null };
}

/**
 * 批 P · FR-P3：三项继承的**唯一措辞源** ——「值」或「未继承（原因：…）」。
 *
 * 三处出口（确认框正文 / prepare 回执 / handoff 事实段）**都渲染这一个对象**，所以「这一次
 * 会继承什么、没继承什么、为什么」在三处不可能出现两种说法（「不可两处口径」）。未继承的写法
 * 取设计档 §9 的原句形状 `未继承（原因：<原因>）`（Pi8 逐字引用它）。
 *
 * @param inherited {@link readInheritableSettings} 的读数（含 `reasons`）
 * @param writeFace {@link approvalWriteFace} 的读数 —— 审批档要**可读且可写**才算继承（D4）
 * @returns `{ preset, model, approval }`：三行，顺序即渲染顺序。
 */
function inheritanceRows(inherited, writeFace) {
	const unset = (reason) => `未继承（原因：${reason === null || reason === undefined || reason === "" ? "宿主读不出（原因未知）" : reason}）`;
	const approval = inherited.approvalPolicy === null
		? `审批档=${unset(inherited.reasons?.approvalPolicy)}`
		: writeFace.face === "writable"
			? `审批档=${inherited.approvalPolicy}`
			: `审批档=${unset(writeFace.reason)}`;
	return {
		preset: inherited.preset === null ? `preset=${unset(inherited.reasons?.preset)}` : `preset=${inherited.preset}`,
		model: inherited.provider !== null && inherited.model !== null
			? `model=${inherited.provider}/${inherited.model}`
			: `model=${unset(inherited.reasons?.model)}`,
		approval,
	};
}

/** 三行的**固定渲染顺序**（`inheritanceRows` 的键序即契约：preset → model → 审批档）。 */
export function inheritanceRowList(rows) {
	return [rows.preset, rows.model, rows.approval];
}

/**
 * 批 P · **一次采集**：读取器（FR-P1）＋ preset 可用性核对（Pi4）＋ 审批档可写面（FR-P4）＋ 三行渲染
 * （FR-P3）。两个调用点（`autoHandover` / `appointSelfBuiltSuccessor`）与 reappoint 的对话框都用它，
 * 于是「三处如实可见」在**同一个读数**上成立，而不是三条各自拼串的路径。
 *
 * 前置：`incumbentSessionId` 是该角色**当前现任**（可以是 `null` —— 席位空缺那一档）。
 * 后置：`rows` 三项永远非空字符串；`values` 是**可用性核对之后**真正会进 `plan` 的那一份
 * （读不到 / 不可解析 / 不可写 ⇒ 对应项为 `null`）；本函数**绝不抛**（读取器不抛，两个探针各自
 * 把异常折成一条具名原因）。
 */
export async function collectInheritableSettings(ctx, incumbentSessionId) {
	const inherited = await readInheritableSettings(ctx, incumbentSessionId);
	const preset = await verifyInheritablePreset(ctx, inherited.preset);
	const writeFace = approvalWriteFace(ctx);
	const effective = preset.value === null && preset.reason !== null
		// 存量读到了但**不可用** ⇒ 值面降级为 `null`（落宿主缺省），原因换成那条具名的出路说明
		// （读取器那条「读不到」的原因已经被「读到了但不可解析」取代，两句话不能同时挂着）。
		? { ...inherited, preset: null, reasons: { ...inherited.reasons, preset: preset.reason } }
		: inherited;
	return { values: effective, writeFace, rows: inheritanceRows(effective, writeFace) };
}

/**
 * 批 P · FR-P4 的**落地**：把继承来的审批档设进**刚建出来的**新会话。
 *
 * 时序是**硬约束**（探针 2 的结论，D6）：必须在 `agents.create` **返回之后**调 —— 那时
 * `handle.agent.session` 才存在；`buildTeamSessionCreateOptions` **逐字不改**（审批档**不进**
 * `plan`），所以宿主那一代的写面形状换代不会波及创建函数本身。
 *
 * 前置：`values.approvalPolicy` 与 `writeFace` 来自**同一次** {@link collectInheritableSettings}。
 * 后置：返回 `{ attempted, applied, line }`；`line` 是回执/交接文档里那一行**读数**（成功说成功、
 * 失败说失败并点名后果），`applied === false` 时**绝不**让 `line` 读起来像设成了。
 * 本函数**绝不抛**（写面抛错 ⇒ 折成一行具名失败读数）—— 继承失败永远不阻断换届（NF-P3）。
 */
export async function applyInheritedApprovalPolicy(values, writeFace, handle) {
	const value = values.approvalPolicy;
	if (value === null || writeFace.face !== "writable") return { attempted: false, applied: false, line: null };
	// ★ 批 Q · FR-Q5（结转-2，D7②）：**session 在场守卫**。写面的第一参是**会话对象**，而它只在
	// `agents.create` 返回之后才存在于 `handle.agent.session` 上。形状读不出来时**必须具名拒绝**
	// —— 拿 `undefined` 去调 `permissionPresets.set` 会把「没设成」的一路动静变成两种更坏的形态：
	// 宿主桩记账一个 `sessionId: null` 的假成功（判据于是读到「设了」），或宿主抛一个与审批档
	// 无关的裸 TypeError（排查会照错误的方向走）。失败方向与既有两档一致：不阻断换届、如实报。
	const session = handle?.agent?.session;
	if (session === undefined || session === null) {
		return {
			attempted: false,
			applied: false,
			line: `审批档落地（FR-P4）未执行（写面入参形状断层）：创建返回的 handle 上没有「agent.session」（agent=${handle?.agent === undefined || handle?.agent === null ? "（缺）" : "（在场，但 session 不可读）"}）——**没有**调用 permissionPresets.set，新会话的审批档仍是宿主缺省（继承失败绝不阻断换届，NF-P3）；这是写面入参的形状断层，不是审批档本身的问题：请在壳里手动设置，并按宿主版本核对「agents.create」的返回形状。`,
		};
	}
	try {
		await writeFace.service.set(handle?.agent?.session, value);
		return { attempted: true, applied: true, line: `审批档落地（FR-P4）：已在创建返回之后调用 permissionPresets.set(新会话, "${value}") 一次（D6：不进 plan、不动创建函数）。` };
	} catch (error) {
		return { attempted: true, applied: false, line: `审批档落地（FR-P4）失败：permissionPresets.set 抛错（${describeError(error)}）——**新会话的审批档仍是宿主缺省**（继承失败绝不阻断换届，NF-P3），请在壳里手动设置。` };
	}
}

/** 出带宽通道：`buildTeamSessionCreateOptions` 取的 preset 租约只能在 `agents.create`
 * **之后**释放（官方模板 `dsh-webhook` 用 `await using` 跨 create 持有、在 `finally`
 * 释放），而它必须随 options 从构建器走到调用方。挂在 Symbol 上 ⇒ 对宿主不可见
 * （`create` 只读具名键）、对 `Object.keys` / 展开 / `JSON.stringify` 不可见，于是
 * options 的**可见形状**与既有断言一字不变。 */
export const PRESET_SCOPE_RELEASE = Symbol("team-link.presetScopeRelease");

export async function createRootAgent(ctx, rootCtx, plan, entry, cwd) {
	// ① 建/取工作区。registry 会把路径**归一化**，而 ④ 的 attachSession 拿会话
	// header 里 realpath 过的 cwd 与 workspace 记录比对 ⇒ ② 必须写
	// `workspace.path`，写调用方的原始 cwd 会在 attach 时被拒。
	const workspace = await openTeamSessionWorkspace(ctx, cwd, entry.sessionId);
	// ② ③ create options（preset 解析 → meta → setup 里的 mount）与 create。
	const options = await buildTeamSessionCreateOptions(ctx, plan, entry, workspace === undefined ? cwd : workspace.path);
	let handle;
	try {
		handle = await rootCtx.agents.create(options);
	} finally {
		// preset 租约与官方模板**同序**释放：`setup` 里的 `mount` 在 create **期间**跑，
		// 租约必须活到那一刻，之后立刻还回去（`dsh-webhook:158` 取 / `:216` 在 finally 释放）。
		// 释放失败**只留痕**：它发生在 `finally`，抛出去会把 create 的原始错误盖掉。
		const releasePresetScope = options[PRESET_SCOPE_RELEASE];
		if (typeof releasePresetScope === "function") {
			try {
				await releasePresetScope();
			} catch (error) {
				ctx.logger?.warn?.(`${PLUGIN_LABEL}: preset scope release failed — ${describeError(error)}`);
			}
		}
	}
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

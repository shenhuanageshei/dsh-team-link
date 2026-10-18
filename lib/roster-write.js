// ===========================================================================
// lib/roster-write.js — 批 R · 第 19 小单：删团队 / 名册写面 / 名册镜像 / 收件回执（一整段相邻块）
// ===========================================================================
//
// 归属：docs/2026-10-15-store-compliance-design.md §4 D1/D2/D4 · §5 FR-R1 · §6（拆分不变量 ①–⑤）· §8 Rr1/Rr3/Rr4/Rr8。
// ★ 本档是什么：入口原 3151–3855 行（as-of 本单动手前）的**一整段相邻块**，共 28 条声明；加上原先住在
//   常量区、**只被这一块使用**的 7 条收件视图 / 派生回执常量（原 2691–2712 行）⇒ 合计 **35 条声明**：
//   ① 批 H 删团队 —— `DELETE_DIALOG_ID` / `DELETE_CONFIRM_LABEL` / `DELETE_CANCEL_LABEL` 三条常量 ·
//      `blackboardDirPresence`（目录级存在性探测）· `blackboardUntouchedLine`（报告行）·
//      `askDeleteConfirm`（fail-closed 确认框）· `deleteTeam`（写前重读 + 单笔写入）；
//   ② 名册写面（纯变换）—— `applyTeamUpsert` · `applySetRole` · `applyRetire` · `trustReferencesTo`；
//   ③ 名册镜像 —— `renderRosterMirror` · `writeRosterMirror` · `mirrorNote`（settings 是事实源，镜像 best-effort）；
//   ④ 收件视图 / 派生回执（可观测批 A §4.3/§4.4）—— `readTaskReceiptTargets` / `surfaceMessageEvents` /
//      `surfaceEventText` / `shortStamp` / `crossSessionBody` / `inboxOpening` / `readReceiptTargets` /
//      `parseToolArguments` / `surfaceSendRecords` / `resolveSendTargets` / `taskMessageBlock` / `asText` /
//      `receiptRowsOf` / `renderReceiptRow` 与随块搬走的 7 条尺寸 / 形状常量。
//   实测：**44,254 字节 / 705 行**（块正文，CRLF 工作树）+ **2,177 字节 / 22 行**（随块搬走的常量）
//   ⇒ **闭包 46,431 字节 / 727 行**（CRLF）；EOL 归一到 LF 后 45,704 字节。本小单 60 KB 档位上限之内。
//   机检口径：把本档正文按声明行去掉 `export ` 前缀后，与入口原位置的同一段**逐字节相等**（EOL 归一）；
//   那一段在入口里**零次**。
//   ★ 它是一个**自成一体的块**：删团队 → 名册纯变换 → 镜像 → 回执渲染四段在块内互相闭合（35 条声明里
//     23 条只被块内使用），对外只经下面「装配缝」的 4 条入口侧出口 + 五条相对导入 + 两条宿主导入取物。
//     这一段也正是 `lib/watchdog-helpers.js` 档头「留给下一小单」清单里点名的同一块
//     （「删团队 / 名册镜像 / 收件回执（44,186 B）」）—— 本单就是那一块。
// ★ 本档**不是**（留给下一小单，逐条点名；字节为本单实测）：policy store 核心（`createPolicyStore`，
//   1449–2400 = 62,906 B，**越过 60 KB 档位**）· 换届交班余下（`HANDOFF_*` 三常量 / `handoffSectionsInline` /
//   `rotationAuto*` / `askRotationAuto` / `handoffDeliveryMessage` / `autoHandover` /
//   `registerRotationTools`，4080–4536 = 36,246 B）· `/team_session` 执行面（`teamSessionKickoffMessage` /
//   pending 两条 / `registerTeamSessionRoles` / `createCommandsSeam` / 回执四件套 /
//   `registerTeamSessionCommand`，5203–5627 = 32,277 B）· `/team_session` 对话框渲染族（4541–4873 =
//   27,888 B）· `createSections`（2401–2682 = 15,733 B）· 恢复工具三块（`createRecovery` /
//   `recoveryDiagnosticLines` / `registerRecoveryTools`，5727–5840 = 12,960 B）。这些**一个都没动**，入口里仍在原位置。
// ★ 依赖方向（Rr4「模块图无环」）：本档**不导入入口** `lib/index.js`（那会构成 ESM 环，实跑当场 TDZ）——
//   ① 内部相对导入 **5 条**：`./shared.js`（7 名：`COORDINATOR_ROLE` / `describeError` / `localStamp` /
//      `maskToken` / `preview` / `readStamp` / `wellFormed`）· `./rotation.js`（4 名：`ROTATION_CONFIRM_TIMEOUT_MS` /
//      `closeTenure` / `roleOf` / `roleRecord`）· `./ledger.js`（2 名：`TASK_ID_RE` / `blackboardPaths`）·
//      `./messaging.js`（2 名：`SEND_CARD_KIND` / `SEND_CARD_VERSION`）· `./read-surface.js`（2 名：`PREVIEW_SESSIONS` /
//      `tenureStartOf`）；
//   ② 装配缝注入 **4 条**：`textOf`（会话消息取文）· `TEAM_MODES` / `TEAM_MODE_LIST` / `TEAM_MODE_SESSIONS`
//      （形态闭集：名册 / 形态 / 落点 / 段各域都在用的同一份真源，搬走即「同一函数两份」）；
//   ③ 宿主导入 **2 条**：`node:fs/promises` 的 `mkdir` / `readdir` / `writeFile` 与 `node:path`
//      默认导出 —— 两个说明符本来就在那 8 条白名单里 ⇒ `Rr3` 的**集合**读数一字不变。
//   三类出边**都不回指入口或本档** ⇒ 本单**不新增环**。
// ★ 被钉符号核对（本仓 `hostSource` 文本锁钉住的 9 个：`writePolicyFileAtomic` / `renameThroughSeam` /
//   `POLICY_FILE_SCHEMA` / `WATCHDOG_DIGEST_DEBOUNCE_MS` / `TICKABLE_VERDICTS` / `agentStateLabel` /
//   `writerGate` / `relayUserMessage` / `buildTeamSessionCreateOptions`）：**本单一个都没搬**，九个仍逐字节
//   住在入口；本档**可执行代码**对那 9 个名字**零引用**（`writerGate` 只出现在三条中/英文注释里 —— 那是在说
//   「删团队刻意不调用它」「创建路径不传它」，不是取值）。
// ★ 搬运纪律（D4）：本档新增的只有 ① 本段档头 ② 7 条 import 语句（2 条宿主 ＋ 5 条内部相对）③ 装配缝
//   ④ 35 条声明行上的 `export ` 前缀；其余（含全部行内注释、嵌套函数与中文文案）**一个字符都没动**。
// ---------------------------------------------------------------------------

import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { COORDINATOR_ROLE, describeError, localStamp, maskToken, preview, readStamp, wellFormed } from "./shared.js";
import { ROTATION_CONFIRM_TIMEOUT_MS, closeTenure, roleOf, roleRecord } from "./rotation.js";
import { TASK_ID_RE, blackboardPaths } from "./ledger.js";
import { SEND_CARD_KIND, SEND_CARD_VERSION } from "./messaging.js";
import { PREVIEW_SESSIONS, tenureStartOf } from "./read-surface.js";

// ---------------------------------------------------------------------------
// 装配缝 · `wireRosterWrite(extras)`（先例：`lib/forensics.js` 的 `wireForensics()`）
// ---------------------------------------------------------------------------
// 前置：入口在**模块求值**时调用一次（`lib/index.js` 模块尾部，紧挨 `wireTeamSessionCommand(…)`），
//       给出的 4 个键与被注入的绑定**同名同值**（同一批绑定、同一份实现）。
// 后置：本档的模块级 `let` 全部绑定到入口那一份真实现；此后每次调用读到的都是它。
// 为什么不是 import：入口 → 域档会成环（实跑当场 TDZ）。
// 为什么是一次性绑定而不是每次调用现取：绑定之后被搬函数体内的裸名**逐字节保留**（只在函数体外加了
// 这一个缝），D4 的逐字节等价可以直接机检。
// ---------------------------------------------------------------------------
let textOf, TEAM_MODES, TEAM_MODE_LIST, TEAM_MODE_SESSIONS;

/** 入口侧出口的一次性绑定（见本节档头的前置 / 后置）。 */
export function wireRosterWrite(extras) {
	({
		textOf,
		TEAM_MODES,
		TEAM_MODE_LIST,
		TEAM_MODE_SESSIONS,
	} = extras);
}

/** §4.3（可观测批 A）收件视图的**两个尺寸常量**：读调用方自己最近 **20** 条消息；每条预览
 * **80** 码点，越界截断并**标注省略**（本仓「截断必标注」的既有规矩）。20 也是**同一个屏界
 * 常量**：派生回执的「最近 N 次 team_link_send」用它，不再为同一块屏立第三个常量。 */
export const TASK_INBOX_MESSAGES = 20;
export const TASK_INBOX_PREVIEW = 80;
/** §2.2 的映射约定：`meta.ref = t-<序号>`。收件视图按它把消息归到任务号上（**读时算**，
 * 不建队列）。只认 `t-<数字>`——`ref` 里别的值不参与归组，但会被**如实计数**（不静默丢弃）。 */
export const TASK_REF_RE = /ref=(t-\d+)/u;
/** 跨会话消息正文的 banner 首行前缀（§3.4）：收件视图显示 banner **之后**的正文，banner
 * 自己的 `ref=` 已经用于归组了。 */
export const CROSS_SESSION_BANNER_PREFIX = "📨 [跨会话消息";
/** §4.4 的投递事实有两个**既有**事件载体（读既有事件，绝不新增事件类型——§10.3 红线）：
 * 一等工具调用是 `tool/call`；从 `run_code` 程序里发出的是桥记的 `tool/ptc-dispatch`
 * （README 已实测：那一类**没有** `tool/result.meta`，所以回执卡缺席时按实参兜底）。 */
export const SEND_CALL_EVENT_TYPES = new Set(["tool/call", "tool/ptc-dispatch"]);
/** §4.1 的成本不变量在 `team_read` 上的形态：**自读占 1 个额**，点名读目标面用掉余下额度
 * ⇒ 目标面最多 `PREVIEW_SESSIONS - 1` 个；`readIds` 再长也只读前 11 个，其余**如实标未读**。 */
export const TEAM_READ_TARGET_LIMIT = PREVIEW_SESSIONS - 1;
/** §4.4（D7 修复轮）按**当前名册**解析出来的那一行必须自带标注：`team:<name>/<role>` 是
 * 读取**此刻**解析出来的那个人，换届之后它未必是投递当时那一个 —— 不标注就会把 ✅/⚠
 * 悄悄判给一个当时并非收件人的会话（读数失准）。标注是读数，不是裁决。 */
export const ROSTER_RESOLVED_NOTE = " · 按当前名册解析（该表达式按读取时的名册解析，未必是投递当时那一个）";

/** 批 H §6: the delete dialog's own identity. It has its own id and labels rather
 * than reusing the recovery ones: the answer is matched BY LABEL, and two
 * different irreversible acts sharing a label could not be told apart in a
 * transcript. */
export const DELETE_DIALOG_ID = "team-delete-confirm";
export const DELETE_CONFIRM_LABEL = "确认删除";
export const DELETE_CANCEL_LABEL = "取消";

/**
 * 批 H FR-H4③ / NF-H2: the ONE directory-level read `delete` is allowed to do.
 * NF-H2 forbids reading / writing / deleting the CONTENT of
 * `<workspace>/team/<队名>/`, so the probe lists the PARENT directory
 * (`<workspace>/team`) and asks whether the team's own segment is among its
 * entries — the team directory itself is never opened, which is strictly more
 * conservative than the single existence probe the design permits. A missing
 * parent IS a missing team directory (ENOENT); any other failure is reported as
 * an honest "could not tell" rather than a guessed "does not exist".
 *
 * 前置：`team.name` 已过 `[a-z0-9-]+`（路径段不可能越界）。
 * 后置：`{ known: true, exists }` 或 `{ known: false, reason }`；本函数零写入。
 */
export async function blackboardDirPresence(team) {
	if (team.workspace === "") return { known: false, reason: "该团队没有 workspace 记录，黑板目录不可定位" };
	const dir = blackboardPaths(team).dir;
	try {
		const entries = await readdir(path.dirname(dir));
		return { known: true, exists: entries.includes(path.basename(dir)) };
	} catch (error) {
		if (error?.code === "ENOENT") return { known: true, exists: false };
		return { known: false, reason: describeError(error) };
	}
}

/**
 * 批 H FR-H4②③: the report line for the blackboard directory of a team that was
 * just removed from the roster. The path is named ALWAYS — that is the checkable
 * exit for the「不删文件」decision（设计档 §10.3）—— and its existence is stated
 * truthfully: 存在 / 不存在 / 探测失败。A team whose directory never existed must
 * neither fail the call (U11) nor be reported as if a directory had been found.
 */
export async function blackboardUntouchedLine(team) {
	if (team.workspace === "") return "黑板目录：不可定位（该团队没有 workspace 记录——本动作不读不写不删任何黑板文件）。";
	const dir = blackboardPaths(team).dir;
	const presence = await blackboardDirPresence(team);
	if (presence.known !== true) return `黑板目录：${dir} —— 存在性探测失败（${presence.reason}）——如实标注；本动作不读不写不删该目录下的任何文件。`;
	return presence.exists
		? `黑板目录：${dir} —— 存在（原样未动：本动作不读不写不删该目录下的任何文件，要不要手工清理由你决定）。`
		: `黑板目录：${dir} —— 不存在（本来就没有这个目录：本次删除没有创建它，也没有碰它）。`;
}

/**
 * 批 H FR-H3: the confirmation dialog of ONE team deletion. 形制照
 * {@link askRecoveryConfirm} —— fail-closed on every path that is not the
 * explicit 「确认删除」 answer, which is what makes "no human, no deletion"
 * structural rather than something the call site remembers. Deliberately no
 * unattended variant: deleting a roster row is irreversible.
 *
 * 前置：`ctx.get("userQuestions")` 不可用 ⇒ 返回 `{ confirmed: false }`（**不抛**）。
 * 后置：`confirmed` 为真**仅当**用户在对话框里选了「确认删除」那一项；取消 / 超时 /
 *   无确认服务一律 `false`，且 `reason` 点名是哪一档（三态各自可读，U5）。
 */
export async function askDeleteConfirm(ctx, agent, request, signal) {
	const userQuestions = ctx.get?.("userQuestions");
	if (userQuestions === undefined || userQuestions === null || typeof userQuestions.ask !== "function") {
		return { confirmed: false, reason: "确认服务（userQuestions）不可用——删团队是不可逆动作，必须有人在对话框里点一下；无确认即不执行（fail-closed）。刻意没有无人值守变体：不可逆动作没有这个余地。" };
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
				id: DELETE_DIALOG_ID,
				header: request.header,
				question: wellFormed(request.question),
				detail: wellFormed(request.detail),
				options: [
					{ label: DELETE_CONFIRM_LABEL, description: request.confirmDescription },
					{ label: DELETE_CANCEL_LABEL, description: request.cancelDescription },
				],
			}],
			agent,
			signal: controller.signal,
		});
		const item = Array.isArray(answer?.answers) ? answer.answers.find((entry) => entry?.id === DELETE_DIALOG_ID) : undefined;
		if (item === undefined || !Array.isArray(item.selected)) return { confirmed: false, reason: "确认框没有返回本次删除问题的答案" };
		if (!item.selected.includes(DELETE_CONFIRM_LABEL)) return { confirmed: false, reason: `用户在确认框里选择了「${item.selected.join("、") || "（未选择）"}」` };
		return { confirmed: true };
	} catch (error) {
		// ★ 交付评审 🔵#4: the wait is rendered FROM the constant (same form as
		// {@link askModeDialog} 的同款渲染) — a hard-coded 「3 分钟」 would drift
		// silently the moment ROTATION_CONFIRM_TIMEOUT_MS changes.
		return { confirmed: false, reason: timedOut ? `确认框 ${Math.round(ROTATION_CONFIRM_TIMEOUT_MS / 60000)} 分钟内未获确认（超时；无人在场，按取消处理）` : `确认框失败（${describeError(error)}）` };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener?.("abort", forward);
	}
}

/**
 * 批 H FR-H2: the deletion branch itself（设计档 §6 的 `deleteTeam`）。
 * 顺序是判据的一半：**先校验存在性**（不在册 ⇒ 如实拒绝 + 列已知团队名，NF-H3，
 * 零弹框零写入）⇒ **弹确认框**（fail-closed，D3）⇒ **★ 写前重读**（评审 🟡#2：
 * 确认窗口是分钟级，期间别的会话可能做过 `set-role` / `upsert-team` / 删了另一个队
 * —— 拿弹框前那份**陈旧快照**过滤回写会把那些改动**静默回退**）⇒ **单笔**
 * `policy.update({ teams })`。
 *
 * **刻意不调用 `writerGate`**（D2 / US-H2）：已退役（vacant）的队没有现任协调者，
 * 沿用 gate 就谁都删不掉，功能对它的目标场景等于没做；把关改由上面那道人类确认框承担。
 * 其余动作的 gate 逐字未动（U8）。
 *
 * 前置：`teamName` 已 trim 且非空、已过 `[a-z0-9-]+`（由调用方读参层保证）。
 * 后置：`{ ok: true, … }` ⇒ 名册里已无该队，且**只**发生了一笔 `policy.update`；报告里的
 *   `historyCount` / `roleCount` / `workspace` / `dir` 全部取自**写前重读的那一行 `freshRow`**
 *   （评审 🔵#2：与写入基础同源，窗口内的并发 `set-role` / workspace 改动不会让报告描述
 *   一个已经不存在的行）。确认框正文仍用弹框前那一行（它是用户当时看到的那一份）。
 *   `{ ok: false, reason }` ⇒ **一个字节都没写**（校验失败 / 未确认 / 写前重读落空 /
 *   写入抛错四条路都是零写入，最后一条**如实说失败**，绝不报成功，U10）。
 */
export async function deleteTeam(ctx, agent, policy, teamName, signal) {
	const teams0 = policy.get().teams;
	const row = teams0.find((team) => team.name === teamName) ?? null;
	// `row` 是**弹框前**那一行：它只喂确认框正文（「会删什么」——就是此刻给用户看的这一行），
	// 以及下面那道「在册吗」的存在性校验。**报告面不用它**（评审 🔵#2）：确认窗口是分钟级，
	// 期间别的会话对该队 `set-role`（新增版本史）/ 改 workspace 时，弹框前那一行已经不是
	// 实际被删的那一行 —— 报告字段一律从**写前重读的 `fresh` 里那一行**重算，见下面
	// `historyCount` / `roleCount` / `workspace` / `dir` 四处。
	if (row === null) {
		// NF-H3：如实拒绝 + 列已知团队名（不是静默成功）。
		return { ok: false, reason: `团队「${teamName}」不在名册里。已知团队：${teams0.map((team) => team.name).join("、") || "（无）"}` };
	}
	// 版本史在**角色行**上（`normalizeTeams` 的团队行没有 `history` 字段），所以这里按
	// 角色逐个累加 —— 报告与确认框说的是「随这一行一起消失的条目数」，不是恒 0。团队自己
	// 的版本史 = 它每个角色各自的 `history`，删行即全删（D4）。
	const historyCount = row.roles.reduce((total, entry) => total + entry.history.length, 0);
	const paths = blackboardPaths(row);
	const dirText = row.workspace === "" ? "（该团队没有 workspace 记录，黑板目录不可定位）" : paths.dir;
	const confirmation = await askDeleteConfirm(ctx, agent, {
		header: `删除团队 ${teamName}`,
		question: `确定把团队「${teamName}」从名册里删掉吗？`,
		detail: [
			`会删：名册里这一行（含它自己的版本史 ${historyCount} 条）`,
			`不会删：磁盘上的黑板目录（${dirText} 原样保留）`,
			`不会改：pairs / trustedSenders / rememberTargets（信任数据一个字不动）`,
			`不可逆：删掉之后团队成员、版本史都从名册里消失`,
		].join("\n"),
		confirmDescription: "把这一行从名册里删掉（连同它的版本史）。黑板目录原样保留，不删任何文件",
		cancelDescription: "什么都不做（本次零写入，名册原样）",
	}, signal);
	if (confirmation.confirmed !== true) {
		return { ok: false, reason: `未确认：${confirmation.reason} —— 按不可逆动作的规矩，本次没有写入任何东西。` };
	}
	// ★ 评审 🟡#2：**写前重读**（绝不回写弹框前那份快照）。
	const fresh = policy.get().teams;
	const freshRow = fresh.find((team) => team.name === teamName) ?? null;
	if (freshRow === null) {
		return { ok: false, reason: `团队「${teamName}」在确认期间已被删除（幂等：本次零写入）。` };
	}
	try {
		await policy.update({ teams: fresh.filter((team) => team.name !== teamName) });
	} catch (error) {
		// §9 失败方向 / U10：写入抛错 ⇒ 行仍在，如实报错 —— 绝不出现「报成功但没删」。
		return { ok: false, reason: `写入设置失败（${describeError(error)}）—— 名册行仍在，本次删除没有发生。` };
	}
	// ★ 交付评审 🔵#2:**报告字段从 `freshRow` 重算**,与 `policy.update` 的写入基础**同源**。
	// 弹框前那份 `row` 只在窗口内**无人动过该队**时才等于实际被删的那一行;窗口内别的会话
	// `set-role`（新增版本史）/ 改 workspace ⇒ 拿 `row` 报数会描述一个**已经不存在**的行:
	// 「版本史共 M 条」报的是弹框那一刻的条数、黑板目录路径报的是**旧** workspace 下的那个
	// 路径（而 `freshRow` 的 workspace 才是随这一行一起消失的那一个）。四处都从新鲜行重算
	// ⇒ 报告只陈述**真的随这一行消失**的东西。确认框正文用 `row` 是刻意的:它是用户点
	// 「确认删除」时看到的那一份,事后不能改写。
	// （字段名带 `final` 前缀是必须的：上面的 `historyCount` / `dirText` 是**弹框前**那一份，
	//   同一个函数块里再声明一次同名 `const` 会直接 SyntaxError。）
	const finalHistoryCount = freshRow.roles.reduce((total, entry) => total + entry.history.length, 0);
	const finalPaths = blackboardPaths(freshRow);
	const finalDirText = freshRow.workspace === "" ? "（该团队没有 workspace 记录，黑板目录不可定位）" : finalPaths.dir;
	return { ok: true, historyCount: finalHistoryCount, roleCount: freshRow.roles.length, workspace: freshRow.workspace, dir: finalDirText };
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
export function applyTeamUpsert(teams, request) {
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
		// straight into renderRosterMirror, which reads team.rotationBackup — and, since
		// the B batch, team.mode / team.leadSessionId. Writing those two here (instead of
		// leaving them to the schema default, which only the READ face applies) is what
		// keeps the settings row, the read face and the mirror agreeing: without it a
		// freshly created team's mirror rendered `形态（mode）：undefined` /
		// `Lead 会话（leadSessionId）：undefined`（真机实测，2026-09-27 修复轮）.
		const team = { name, createdAt: now, workspace, policy: { writer: "coordinator" }, roles, rotationBackup: null, mode: TEAM_MODE_SESSIONS, leadSessionId: "" };
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
export function applySetRole(team, request) {
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
export function applyRetire(team, request) {
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
export function trustReferencesTo(view, session) {
	const pairs = view.pairs.filter((pair) => pair.a === session || pair.b === session);
	const trustedSenders = view.trustedSenders.filter((id) => id === session);
	const rememberTargets = view.rememberTargets.filter((id) => id === session);
	return { pairs, trustedSenders, rememberTargets, total: pairs.length + trustedSenders.length + rememberTargets.length };
}


/** Human-readable rendering of one team — the `roster.md` mirror (§3.3.1). The
 * settings namespace stays the source of truth; this copy is overwritten by the
 * next roster change. A pending rotation token is rendered MASKED (first four /
 * last four characters): the mirror is a file on disk, and the full token is
 * handed out exactly once, in the `prepare` result (§3.6.2 评审 #3). */
export function renderRosterMirror(team) {
	// L2（2026-09-27 真机冒烟修复轮）：this renderer has to be safe on its own. It is fed
	// either a normalized row (the read face) or the row `applyTeamUpsert` builds — and
	// that row was missing the two B-batch fields, so a created team's mirror printed
	// `形态（mode）：undefined` / `Lead 会话（leadSessionId）：undefined`（真机实测）.
	// Both fields are therefore coerced to a renderable string here by the SAME absence
	// rule `normalizeTeams` uses — an empty or non-string value IS the absence of the
	// field (= the default mode / no Lead) — plus its closed-set rule, so the mirror can
	// never advertise a mode the read face would not say. The degradation TRACE stays on
	// the read face alone (§8.1 A3); the mirror states the normalized value and, as its
	// last line says, settings remain the source of truth.
	const mode = typeof team.mode === "string" && TEAM_MODES.has(team.mode) ? team.mode : TEAM_MODE_SESSIONS;
	const leadSessionId = typeof team.leadSessionId === "string" ? team.leadSessionId : "";
	const lines = [
		`# 团队 roster：${team.name}`,
		"",
		`- 生成时间：${localStamp()}`,
		`- 创建时间：${readStamp(team.createdAt)}`,
		`- workspace：${team.workspace === "" ? "（未捕获）" : team.workspace}`,
		`- policy.writer：${team.policy.writer}（coordinator=仅现任协调者会话可写；any=任何会话可写）`,
		// D3: 镜像自述「与**设置变更**同一事务内镜像」—— 形态（mode / leadSessionId）也是一次设置变更
		// （`set-mode` 落笔后调用同一个 `writeRosterMirror`），所以这两行必须出现在镜像里，否则那句
		// 自述对本字段就是假的。
		`- 形态（mode）：${mode}（闭集 ${TEAM_MODE_LIST}；默认 ${TEAM_MODE_SESSIONS}）`,
		`- Lead 会话（leadSessionId）：${leadSessionId === "" ? "（空；仅 agent-team 档有意义 —— 空串在 agent-team 档下读面标「Lead 未知」，多会话档没有 Lead 角色）" : leadSessionId}`,
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
export async function writeRosterMirror(team) {
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
export function mirrorNote(mirror) {
	return mirror.ok
		? `镜像已更新：${mirror.path}`
		: `（注意：roster.md 镜像写入失败——${mirror.error}。settings 是本插件的事实源，本次变更已生效；镜像会在下一次 roster 变更时重试，也可手工从设置重建。）`;
}

/**
 * §4.3/§4.4（可观测批 A）`team_link_team_read` 的点名读参数：派生回执要读哪些**目标面**。
 * 自读由工具自己完成并**占 1 个额**，所以这里只收「除自己以外、去重后」的前
 * {@link TEAM_READ_TARGET_LIMIT} 个；超出的**不丢**，回给调用方在输出里如实标注。
 * 未点名（缺省）⇒ 空数组 ⇒ **目标面零读**（U11/U14 的判据）。
 */
export function readTaskReceiptTargets(value, selfId) {
	if (value === undefined || value === null) return { ids: [], overflow: [] };
	if (!Array.isArray(value)) return { error: "readIds 必须是会话 id 数组（派生回执要读的目标面）。" };
	const ids = [];
	for (const entry of value) {
		if (typeof entry !== "string" || entry.trim() === "") {
			return { error: `readIds 里有一个不是会话 id 的项（${preview(String(entry), 40)}）。` };
		}
		const id = entry.trim();
		// 点名自己 = 自读那一份（占的正是它自己的额），不重复读。
		if (id === selfId || ids.includes(id)) continue;
		ids.push(id);
	}
	return { ids: ids.slice(0, TEAM_READ_TARGET_LIMIT), overflow: ids.slice(TEAM_READ_TARGET_LIMIT) };
}

/** 一个会话面里的**消息**事件，按日志顺序 —— §4.3 的「最近 N 条消息」取自这里（与 §3.1
 * 的静默读数同一批事件类型，只是这里要的是整批而不是最后一枚时间戳）。 */
export function surfaceMessageEvents(events) {
	const out = [];
	for (const event of Array.isArray(events) ? events : []) {
		if (event?.type !== "user/message" && event?.type !== "assistant/message") continue;
		if (typeof event.time !== "number") continue;
		out.push(event);
	}
	return out;
}

/** 一个消息事件的全文：user 在 `data.content`，assistant 在 `data.message.content`。 */
export function surfaceEventText(event) {
	if (event?.type === "user/message") return textOf(event.data?.content);
	if (event?.type === "assistant/message") return textOf(event.data?.message?.content);
	return "";
}

/** `MM-DD HH:mm` —— §4.3/§4.4 示例行的形状（一行一条，不带年份）。 */
export function shortStamp(ms) {
	const date = new Date(ms);
	const pad = (n) => String(n).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 跨会话消息的正文：剥掉 banner 首行（它的 `ref=` 已经用于归组），其余是载荷（§3.4）。 */
export function crossSessionBody(text) {
	const value = String(text ?? "");
	if (!value.startsWith(CROSS_SESSION_BANNER_PREFIX)) return value;
	const end = value.indexOf("]");
	return end === -1 ? value : value.slice(end + 1).trim();
}

/** §4.3 一条条目的开头：至多 {@link TASK_INBOX_PREVIEW} 码点，截断**必标注**（本仓既有规矩）
 * ——标注留在**同一行**上，因为一条条目就是一行。 */
export function inboxOpening(text) {
	const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
	const chars = [...flat];
	if (chars.length <= TASK_INBOX_PREVIEW) return flat;
	return `${chars.slice(0, TASK_INBOX_PREVIEW).join("")}…（已省略 ${chars.length - TASK_INBOX_PREVIEW} 字符）`;
}

/** §4.4 的结构化回执（`tool/result.meta`，用 §10.1.2 自己的判别符 + 版本认）。形状不认 ⇒
 * null：与客户端同一条纪律——手改过的日志不得让读面**编出**一个投递事实。 */
export function readReceiptTargets(meta) {
	if (meta === null || typeof meta !== "object") return null;
	if (meta.kind !== SEND_CARD_KIND || meta.v !== SEND_CARD_VERSION) return null;
	if (!Array.isArray(meta.targets)) return null;
	const truncated = meta.targetsTruncated !== null && typeof meta.targetsTruncated === "object" && typeof meta.targetsTruncated.total === "number" ? meta.targetsTruncated.total : null;
	return {
		at: typeof meta.at === "number" && Number.isFinite(meta.at) ? meta.at : null,
		ref: typeof meta.meta?.ref === "string" ? meta.meta.ref : null,
		truncated,
		targets: meta.targets.filter((entry) => entry !== null && typeof entry === "object"),
	};
}

/** 工具调用事件里的 `data.arguments`：线上是 **JSON 字符串**（客户端半边读的是同一个字段、
 * 同一种读法）。读不动 ⇒ null（那一条投递记录不参与视图，但会被计数）。 */
export function parseToolArguments(value) {
	if (value !== null && typeof value === "object") return value;
	if (typeof value !== "string") return null;
	try {
		const parsed = JSON.parse(value);
		return parsed !== null && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * §4.4 的**投递事实**：调用方**自己**的会话面里那些 `team_link_send` 调用（读既有事件）。
 * 每一笔读成 `{ at, ref, card, args, unreadable }`：
 *
 * - 有结构化回执（`tool/result.meta`——只有一等工具调用才有）⇒ 用回执里逐目标的
 *   `sessionId` / `expr` / `outcome`（那是**投递当时**解析出来的：全队表达式在这里已经
 *   展开，换届之后仍然指向当时那个会话）；
 * - 没有回执（`run_code` 里发出的那一类）⇒ 按**实参**兜底（见 {@link resolveSendTargets}）。
 */
export function surfaceSendRecords(events) {
	const list = Array.isArray(events) ? events : [];
	const receipts = new Map();
	for (const event of list) {
		if (event?.type !== "tool/result") continue;
		const callId = event.data?.message?.source?.callId;
		const card = readReceiptTargets(event.data?.meta);
		if (typeof callId === "string" && callId !== "" && card !== null) receipts.set(callId, card);
	}
	const records = [];
	for (const event of list) {
		if (!SEND_CALL_EVENT_TYPES.has(event?.type)) continue;
		const data = event.data;
		if (data === null || typeof data !== "object" || data.name !== "team_link_send") continue;
		if (typeof event.time !== "number") continue;
		const card = typeof data.callId === "string" ? receipts.get(data.callId) ?? null : null;
		const args = parseToolArguments(data.arguments);
		if (args === null) {
			records.push({ at: card?.at ?? event.time, ref: card?.ref ?? null, card, args: null, unreadable: true });
			continue;
		}
		records.push({
			at: card?.at ?? event.time,
			ref: card?.ref ?? (typeof args.meta?.ref === "string" ? args.meta.ref : null),
			card,
			args,
			unreadable: false,
		});
	}
	return records;
}

/** 一条寻址表达式**现在**指向哪些会话：裸 id 就是它自己；`team:<name>/<role>` 是该角色的
 * 现任；`team:<name>/*` 是该团队全部在任角色。未知团队 / 空缺角色 ⇒ 空数组（读面不猜）。 */
export function resolveSendTargets(expr, teams) {
	if (typeof expr !== "string" || expr === "") return [];
	if (!expr.startsWith("team:")) return [expr];
	const rest = expr.slice("team:".length);
	const slash = rest.indexOf("/");
	if (slash === -1) return [];
	const team = teams.find((entry) => entry.name === rest.slice(0, slash));
	if (team === undefined) return [];
	const role = rest.slice(slash + 1);
	const filled = team.roles.filter((entry) => entry.current !== null && entry.current !== "");
	if (role === "*") return filled.map((entry) => entry.current);
	return filled.filter((entry) => entry.role === role).map((entry) => entry.current);
}

/**
 * §4.3 + §4.4（可观测批 A）`team_link_team_read` 的**新块**（既有四块一字未动，唯一新增就是
 * 它）：**收件视图**（谁对我说了什么）与**派生回执**（我说出去之后，对方动了没有）。
 *
 * 两半都从**调用方自己**的会话面派生（`selfSurface`，一次 `readSurface(selfId)`），目标面只读
 * **点名**过的那些（`readIds`）—— 未点名时目标面**零读**。**纯派生、零新增持久状态、零新增
 * 写路径**（N3：删掉本块不改变任何写入路径，回执行随时可从原始证据重算）。
 *
 * 措辞纪律（N4）：回执只陈述「该时刻之后有没有 assistant 事件」，**不下结论**——「无后续反应」
 * 既可能是没接住，也可能是还没想完。任何读不到的面都标「未读」，**绝不用空数据算读数**。
 */
export function taskMessageBlock({ selfId, selfSurface, readIds, targetSurfaces, overflowTargets, registeredIds, teams }) {
	const lines = [];
	const attempted = new Set(readIds);
	const messages = surfaceMessageEvents(selfSurface?.events);
	const window = messages.slice(-TASK_INBOX_MESSAGES);
	lines.push(`--- 收件视图（按任务号；来源：本会话最近 ${TASK_INBOX_MESSAGES} 条消息 · 常量 TASK_INBOX_MESSAGES）---`);
	if (selfId === undefined) {
		lines.push("（当前会话未知：收件视图不可用——本块只读调用方自己的会话面，不编造身份。）");
	} else if (selfSurface === undefined) {
		lines.push("（本会话面读取失败：收件视图与派生回执都无法计算——不用空数据算读数。）");
	} else {
		const groups = new Map();
		let withoutRef = 0;
		for (const event of window) {
			const text = surfaceEventText(event);
			const matched = TASK_REF_RE.exec(text);
			if (matched === null) {
				withoutRef += 1;
				continue;
			}
			const sender = typeof event.data?.source?.senderSessionId === "string" && event.data.source.senderSessionId !== "" ? event.data.source.senderSessionId : "（本会话）";
			const entry = { time: event.time, sender, body: crossSessionBody(text) };
			const list = groups.get(matched[1]);
			if (list === undefined) groups.set(matched[1], [entry]);
			else list.push(entry);
		}
		if (window.length === 0) lines.push("（本会话最近没有消息：收件视图无内容。）");
		// 按任务号升序（台账的读法）；同号内按时间升序。
		const ordered = [...groups.entries()].sort((left, right) => Number(left[0].slice(2)) - Number(right[0].slice(2)));
		for (const [task, entries] of ordered) {
			const sorted = [...entries].sort((left, right) => left.time - right.time);
			for (const entry of sorted) lines.push(`- ${task} ← ${entry.sender}（${shortStamp(entry.time)}）：${inboxOpening(entry.body)}`);
			// §4.3 边界：**未登记过的号照样分组显示**（不隐藏），只在该组标注成因 ——
			// 「可能是笔误，也可能是先发后记」，读面不替调用方裁。
			if (registeredIds !== null && !registeredIds.has(task)) {
				lines.push("    （该号在台账里未登记 —— 可能是笔误，也可能是先发后记）");
			}
		}
		if (withoutRef > 0) lines.push(`（无 ref 的消息 ${withoutRef} 条：未归任务，未参与本视图）`);
	}

	lines.push("", `--- 派生回执（我发出去之后，对方动了没有；来源：本会话最近 ${TASK_INBOX_MESSAGES} 次 team_link_send · 同一屏界常量）---`);
	if (selfId === undefined || selfSurface === undefined) {
		lines.push("（本会话面不可读：派生回执无法计算——不用空数据算读数。）");
		return lines;
	}
	const sends = surfaceSendRecords(selfSurface.events).slice(-TASK_INBOX_MESSAGES);
	const rows = [];
	let offTask = 0;
	let unreadable = 0;
	for (const record of sends) {
		if (record.unreadable) {
			unreadable += 1;
			continue;
		}
		if (typeof record.ref !== "string" || !TASK_ID_RE.test(record.ref)) {
			offTask += 1;
			continue;
		}
		rows.push(...receiptRowsOf(record, teams));
	}
	if (sends.length === 0) lines.push("（本会话面里没有 team_link_send 的调用记录。）");
	for (const row of rows.slice(0, TASK_INBOX_MESSAGES)) lines.push(renderReceiptRow(row, { attempted, targetSurfaces }));
	if (rows.length > TASK_INBOX_MESSAGES) lines.push(`（本次还有 ${rows.length - TASK_INBOX_MESSAGES} 行未显示：一行 = 一次投递里的一个目标；同一屏界常量 TASK_INBOX_MESSAGES）`);
	if (offTask > 0) lines.push(`（无任务号的投递 ${offTask} 次：没有挂到 t-<n> 上，未参与本视图）`);
	if (unreadable > 0) lines.push(`（${unreadable} 条调用记录的 arguments 读不动，未参与本视图）`);
	if (overflowTargets.length > 0) lines.push(`（readIds 超出目标面读额（自读占 1 个额，最多 ${TEAM_READ_TARGET_LIMIT} 个）：${overflowTargets.map((id) => preview(id, 60)).join("、")} 本次未读——上面这些行照常按「未读」标注。）`);
	return lines;
}

/** 非空字符串原样返回，其余一律 null —— 读面里所有「可能是字符串的字段」都过它。 */
export function asText(value) {
	return typeof value === "string" && value !== "" ? value : null;
}

/** §4.4 一笔投递读成若干「目标行」：优先用回执（投递当时的解析结果），没有回执才按实参
 * 兜底、并在行上**如实标注** {@link ROSTER_RESOLVED_NOTE}（表达式解析出来的那个人可能已经
 * 不是当时那一个了——换届之后尤其如此；这是读数，不是裁决）。 */
export function receiptRowsOf(record, teams) {
	const rows = [];
	const card = record.card;
	if (card !== null) {
		for (const target of card.targets) {
			// 三个字段先过 asText 再进行对象，不只是风格：§12.5 的跨半边行为锁**静态**扫
			// 「outcome 后面紧跟冒号或三等号、再跟一个字符串字面量」的两种形状，与客户端的短语表
			// 比对；把判定直接写进对象字面量里，会被它读成一个名叫 string 的枚举值。
			const targetExpr = asText(target.expr);
			const targetId = asText(target.sessionId);
			const outcomeToken = asText(target.outcome);
			rows.push({
				ref: record.ref,
				at: card.at ?? record.at,
				expr: targetExpr,
				sessionId: targetId,
				outcome: outcomeToken,
				source: "回执",
			});
		}
		if (card.truncated !== null && card.truncated > card.targets.length) {
			rows.push({ ref: record.ref, at: card.at ?? record.at, expr: null, sessionId: null, outcome: null, source: "回执截断", truncatedTotal: card.truncated });
		}
		return rows;
	}
	const args = record.args;
	const wanted = typeof args.targetSessionId === "string" && args.targetSessionId !== "" ? [args.targetSessionId] : Array.isArray(args.targets) ? args.targets : [];
	for (const expr of wanted) {
		// `team:<name>/<role>` 与 `team:<name>/*` 是**按读取时的名册**解析的（裸 id 是字面量，
		// 不存在这个问题）—— 这个区别必须一路带到行上，见 {@link ROSTER_RESOLVED_NOTE}。
		const rosterResolved = typeof expr === "string" && expr.startsWith("team:");
		const resolved = resolveSendTargets(expr, teams);
		if (resolved.length === 0) {
			rows.push({ ref: record.ref, at: record.at, expr: typeof expr === "string" ? expr : null, sessionId: null, outcome: null, source: "实参", rosterResolved });
			continue;
		}
		for (const sessionId of resolved) rows.push({ ref: record.ref, at: record.at, expr: rosterResolved ? expr : null, sessionId, outcome: null, source: "实参", rosterResolved });
	}
	if (rows.length === 0) rows.push({ ref: record.ref, at: record.at, expr: null, sessionId: null, outcome: null, source: "实参" });
	return rows;
}

/** §4.4 一行回执。三态 + 两条**不冒充读数**的旁支（既有的 outcome 非 delivered、或这次寻址
 * 没解析到具体会话）；措辞一律只陈述事实（有没有后续事件），不下结论。 */
export function renderReceiptRow(row, { attempted, targetSurfaces }) {
	// 回执被行数上限裁过时，这一行只报告「回执自己报的总数」——它不是一个目标，读面不替它
	// 编一个身份（那正是 §10.1.2 的行上限标注在做的事）。
	if (row.source === "回执截断") {
		return `- ${row.ref} → （回执共报了 ${row.truncatedTotal} 个目标，超出逐行渲染上限；明细见该次调用的返回文本——本视图不编目标身份）`;
	}
	const label = row.expr === null ? String(row.sessionId ?? "（未知目标）") : `${row.expr}${row.sessionId === null || row.sessionId === row.expr ? "" : `（${row.sessionId}）`}`;
	const head = `- ${row.ref} → ${label}（${shortStamp(row.at)}）`;
	// D7（修复轮）: 按**当前名册**解析出来的那一行如实标注 —— 「表达式现在指向谁」与
	// 「投递当时是谁」是两个读数；不标注就会让换届后的 ✅/⚠ 看起来像是判给了当时那个会话。
	const rosterNote = row.rosterResolved === true ? ROSTER_RESOLVED_NOTE : "";
	if (row.outcome !== null && row.outcome !== "delivered") return `${head}：未投递（outcome=${preview(row.outcome, 40)}）${rosterNote}`;
	if (row.sessionId === null) return `${head}：未读（这次寻址没解析到具体会话，本视图不猜目标是谁）${rosterNote}`;
	if (!attempted.has(row.sessionId)) return `${head}：未读（未点名读该会话；要读 → readIds=["${row.sessionId}"]）${rosterNote}`;
	const surface = targetSurfaces.get(row.sessionId);
	if (surface === undefined) return `${head}：未读（点名的会话面读取失败——不用空数据算读数）${rosterNote}`;
	const after = surfaceMessageEvents(surface.events).filter((event) => event.type === "assistant/message" && event.time > row.at);
	if (after.length > 0) return `${head}：✅ 有反应（${shortStamp(after[0].time)} 起有 assistant 事件）${rosterNote}`;
	return `${head}：⚠ 无后续反应（该时刻之后无 assistant 事件）${rosterNote}`;
}

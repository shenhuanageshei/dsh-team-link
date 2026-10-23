// ===========================================================================
// lib/team-tools.js — 批 R · 第 21 小单：名册/形态面余下
//                     （形态常量 · 恢复阶梯/活性读数 · 形态史与段渲染 · 形态确认框 · 退役门）
// ===========================================================================
//
// 归属：docs/2026-10-15-store-compliance-design.md §4 D1/D2/D4 · §5 FR-R1 · §6（拆分不变量 ①–⑤）·
//       §8 Rr1/Rr3/Rr4/Rr8。
// ★ 本档是什么：入口原 **五段**（as-of 本单动手前，行号为 CRLF 工作树口径）：
//   ① **810–816**：§4.2 的三条确认框字面量与 Lead 会话 id 形状（`LEAD_SESSION_ID_RE` / `MODE_DIALOG_ID` /
//      `MODE_CONFIRM_LABEL` / `MODE_CANCEL_LABEL`，**4 条声明**）；
//   ② **832–855**：§4.3(3)(4)(5) 的名册投影来源文案 / 能力矩阵 / 形态诊断行（`TEAM_MODE_ROSTER_*` 三条 ·
//      `TEAM_MODE_CAPABILITY_ROWS` · `TEAM_MODE_DIAGNOSTIC`，**5 条声明**）；
//   ③ **2793–3007**：§11.9.5⑦ 恢复行归一化 · 活性读数 · 形态史行与渲染族
//      （`normalizeRecoveries` … `memberLine`，**16 条声明**）；
//   ④ **3019–3140**：§4.3 形态段渲染 / 能力矩阵 / 形态确认框 / 会话面读数
//      （`teamModeSectionLines` … `readLeadSessionId`，**6 条声明**）；
//   ⑤ **3165–3181**：§3.3.2 (v1.3) 退役门 `retireGate`（**1 条声明**）。
//   合计 **32 条声明**；实测 **25,160 字节 / 385 行**（块正文，CRLF 工作树），EOL 归一到 LF 后
//   **24,780 字节**；本档全文 **33,169 字节 / 482 行**（LF 落盘）—— 本小单
//   60 KB 档位（61,440 B）上限之内。
//   机检口径：把本档正文按声明行去掉 `export ` 前缀后，与入口原位置那五段**逐字节相等**
//   （EOL 归一）；那五段在入口里**零次**。
//   ★ 它是一个**自成一体的块**：①② 是形态面的私有常量（搬出后入口零读者）；③④ 是名册/形态面的读数与
//     渲染（`team_link_roster` / `team_link_status` / 工作台摘要共同消费）；⑤ 是写门的姊妹门。
//     32 条声明里 **14 条只被块内使用**，对外只经下面「装配缝」的 4 条入口侧出口 ＋ 四条内部相对导入取物。
// ★ 本档**不是**（留给下一小单 / 被源码锁钉住，逐条点名）：
//   · `registerTeamTools`（§3.3.2/§3.3.3 的 M2 工具注册）—— **被 `host-half.test.mjs:2893–2894` 的直读
//     `lib/index.js` 源码锁钉住**（它 `execute` 里那句「三值白名单」拒绝文案必须出现在入口，
//     即 decisions / discipline / tasks 那一句）⇒ 本单**没有搬**，仍在入口原位置；本档的五段都停在
//     它之前。下一单同样不许搬（同批改测试档不在任何小单的写域里）。
//   · policy store 核心 `createPolicyStore`：函数本体 **63,210 B（LF）** —— 单这一项就已越过 60 KB
//     档位（61,440 B）⇒ 本小单不可切。
//   · 换届交班余下：`HANDOFF_HARD_SECTIONS` / `handoffDeliveryMessage` / `registerRotationTools` 以及
//     `rotationFactRows` / `provisionalGuidance` 被 `host-half.test.mjs` 的**直读 `lib/index.js`** 源码锁
//     钉住（`:4536` 四类行模板锁、`:4875–4894` 五硬节同源锁）⇒ 本单一个都没搬。
//   · `buildTeamSessionCreateOptions`（**被钉**）· `buildTeamSessionResumeOptions` /
//     `resolveTeamSessionModelSelection` · 被钉的 `relayUserMessage` · `teamSessionKickoffMessage` ·
//     pending 两条 · `createSections` · 恢复工具三块 · 入口 `apply` —— 仍在入口。
//   这些**一个都没动**，入口里仍在原位置（搬走的五段留了指路注释）。
// ★ 依赖方向（Rr4「模块图无环」）：本档**不导入入口** `lib/index.js`（那会构成 ESM 环，实跑当场 TDZ）——
//   ① 内部相对导入 **4 条**：`./shared.js`（5 名）· `./rotation.js`（3 名）· `./ledger.js`（6 名）·
//      `./read-surface.js`（3 名）；
//   ② 装配缝注入 **4 条**：`TEAM_MODE_DEGRADATIONS`（形态降级留痕表 —— 入口的 `policyStoreExtras()` 也
//      要它）· `TEAM_MODE_LIST` / `TEAM_MODE_SESSIONS`（形态闭集的渲染与归一 —— 入口写面/降级也读）·
//      `agentCwd`（`otherReachableSessions` 的工作区读数，入口多条缝共用）；
//   ③ 宿主导入 **1 条**：`node:fs/promises` 的 `appendFile` / `mkdir` —— 该说明符本来就在那 8 条白名单里
//      ⇒ `Rr3` 的**集合**读数一字不变。
//   三类出边**都不回指入口或本档** ⇒ 本单**不新增环**。
// ★ 被钉符号核对（本仓 `hostSource` 文本锁钉住的 9 个：`writePolicyFileAtomic` / `renameThroughSeam` /
//   `POLICY_FILE_SCHEMA` / `WATCHDOG_DIGEST_DEBOUNCE_MS` / `TICKABLE_VERDICTS` / `agentStateLabel` /
//   `writerGate` / `relayUserMessage` / `buildTeamSessionCreateOptions`）：**本单一个都没搬**，九个仍逐字节
//   住在入口；本档可执行代码对它们的引用 = **0 处**。注释里的提及恰是三类：① 本段档头这张核对表；
//   ② 「本档不是」清单（`buildTeamSessionCreateOptions` / `relayUserMessage`）；③ 由
//   `withLiveGateDiagnostic` **原样搬来**的 JSDoc 那一句（`writerGate` / `rotateGate` / `retireGate`
//   拿不到 ctx —— 它是被搬正文的一部分，D4 逐字节保留）。
//   另：`normalizeRecoveries` / `SEATED_DEAD_LABEL` / `recoveryLadderText` / `recoveryLadderSuffix` /
//   `agentIsLive` / `withLiveGateDiagnostic` / `seatedDeadRoles` / `teamModeSectionLines` / `memberLine` /
//   `askModeDialog` / `otherReachableSessions` / `readLeadSessionId` / `appendModeHistoryRow` /
//   `backfillModeHistoryRow` / `modeHistoryBody` / `modeCapabilityLines` / `sessionIdSnapshot` /
//   `retireGate` 仍由入口按名导入（`__testing` 与既有七条装配缝取到的都是**同一批绑定**）⟹ 对外名字 /
//   签名 / 语义一字不变。
// ★ 搬运纪律（D4）：本档新增的只有 ① 本段档头 ② 5 条 import 语句（19 个绑定名） ③ 装配缝
//   ④ 32 条声明行上的 `export ` 前缀；其余（含全部行内注释、嵌套函数与中文文案）**一个字符都没动**。
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { blackboardArchiveDir, blackboardAuthor, blackboardLines, blackboardPaths, decisionRow, lastDecisionSeq, readBlackboardFile } from "./ledger.js";
import { TEAM_MODE_AGENT_TEAM, TEAM_MODE_CONCLUSION, VACANT_LABEL } from "./read-surface.js";
import { ROTATION_CONFIRM_TIMEOUT_MS, dialogNoAnswerError, roleOf } from "./rotation.js";
import { COORDINATOR_ROLE, agentSessionId, describeError, preview, wellFormed } from "./shared.js";

// ---------------------------------------------------------------------------
// 装配缝 · `wireTeamTools(extras)`（先例：`lib/forensics.js` 的 `wireForensics()`）
// ---------------------------------------------------------------------------
// 前置：入口在**模块求值**时调用一次（`lib/index.js` 模块尾部，紧挨 `wireTeamSessionSurface(…)`），
//       给出的 4 个键与被注入的绑定**同名同值**（同一批绑定、同一份实现）。
// 后置：本档的模块级 `let` 全部绑定到入口那一份真实现；此后每次调用读到的都是它。
// 为什么不是 import：入口 → 域档会成环（实跑当场 TDZ）。
// 为什么是一次性绑定而不是每次调用现取：绑定之后被搬函数体内的裸名**逐字节保留**（只在函数体外加了
// 这一个缝），D4 的逐字节等价可以直接机检。
// ---------------------------------------------------------------------------
let TEAM_MODE_DEGRADATIONS, TEAM_MODE_LIST, TEAM_MODE_SESSIONS, agentCwd;

export function wireTeamTools(extras) {
	({
		TEAM_MODE_DEGRADATIONS,
		TEAM_MODE_LIST,
		TEAM_MODE_SESSIONS,
		agentCwd,
	} = extras);
}

/** §4.2 Lead 会话 id 的形状（第一道校验）。与 `TEAM_SESSION_ID_ILLEGAL` 同一个字符类，但这里是**收**：
 * 首字符必须字母或数字，其后 0–63 个 `[A-Za-z0-9._-]`。 */
export const LEAD_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
/** §4.2 确认框的单选标签（与既有三个对话框同形：一个确认、一个取消）。 */
export const MODE_DIALOG_ID = "team-mode";
export const MODE_CONFIRM_LABEL = "切换";
export const MODE_CANCEL_LABEL = "取消";

/** §4.3(3) 名册投影的**来源文案**（写死，各有断言）。可读时用第一种；不可读时**按分支**取首行 ——
 * 探针有五条不可读分支（服务缺席 / 缺方法 / 无会话身份 / 调用方非成员 / 读取抛错），其中只有
 * **服务缺席**能说「本部署未提供该投影」；其余四条一律用**中性首行**，真正的原因写在紧随的
 * 「（不可读原因：…）」行里。D2 的教训：无条件先打那一句会让首行与原因行**自相矛盾**
 * （真机最常走到的正是「服务在场、调用方不是成员」那一支）。 */
export const TEAM_MODE_ROSTER_READABLE = "来源：宿主 agentTeams 投影（本部署可读）";
export const TEAM_MODE_ROSTER_UNREADABLE = "成员名册不可读（本部署未提供该投影）—— 仍可读 Lead 与形态";
/** 中性首行：服务在场但读不到（四条分支共用），原因由下一行点名。 */
export const TEAM_MODE_ROSTER_UNREADABLE_NEUTRAL = "成员名册不可读 —— 仍可读 Lead 与形态（哪一条读不到，见下一行的原因）";
/** §4.3(4) 能力矩阵 = **父档 §2.3 的表**，本批**逐行照抄、不改口径**（README 的同一张表与
 * 本常量同源；改一处即两处，这是本仓「一处事实一处渲染」的既有规矩）。 */
export const TEAM_MODE_CAPABILITY_ROWS = Object.freeze([
	{ ability: "跨会话投递（team_link_send）", sessions: "✅ 主用途", agentTeam: "❌ 成员是子代理，不是可投递目标" },
	{ ability: "双门批准 / 配对", sessions: "✅", agentTeam: "❌ 用不上（宿主那套没有独立信任模型）" },
	{ ability: "换届（rotate）/ 恢复（recover）", sessions: "✅", agentTeam: "❌ 没有可换届的会话；Lead 会话没了团队就散了" },
	{ ability: "看门狗（watch）", sessions: "✅", agentTeam: "❌ teammate 不是根代理，盯不了" },
	{ ability: "黑板（decisions / discipline / tasks）", sessions: "✅", agentTeam: "⚠️ 仍可用，但只有 Lead 一方读写" },
	{ ability: "roster 身份 / 版本史", sessions: "✅", agentTeam: "⚠️ 只记「本团队是 agent-team 档 + Lead 是谁」" },
	{ ability: "团队状态卡（只读）", sessions: "✅", agentTeam: "⚠️ 成员部分读宿主投影（2026-09-27 已核：本部署已挂载该服务 ⇒ 探针 available=true）" },
	{ ability: "会话深链 / 导出", sessions: "✅", agentTeam: "✅ 与形态无关" },
]);

/** §4.3(5) 的**形态诊断行**：只提示，绝不自动切（红线 6；`set-mode` 永远由人触发）。 */
export const TEAM_MODE_DIAGNOSTIC = "⚠ 多会话通道看起来不可用（列表里没有其他会话）—— 你可以让协调者切到 agent-team 档（team_link_roster action=set-mode）（只提示：本插件绝不自动切档，切档永远由人在确认框里点一下）。";

/**
 * §11.9.5⑦ recovery audit rows, normalized the way every other role field is:
 * only a well-shaped row survives, and a row written by hand without the
 * declared fields is dropped rather than carried as a half-record.
 */
export function normalizeRecoveries(list) {
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

/** The word for a role whose seat is taken but whose holder has no live agent. */
export const SEATED_DEAD_LABEL = "seated-dead";

/** §11.9.5① the CLOSED verb set of the recovery tool. Exactly two, because the
 * audit landing point has to be single and countable: a verb that is not in this
 * set is refused before anything is read, which is what keeps «恢复» from
 * decaying into a second, looser roster editor. */
export const RECOVERY_VERBS = new Set(["revive", "reappoint"]);

/** §11.9.4's recovery ladder, in the caller's terms, in ONE place: the gates'
 * refusals, `roster get`, the recovery tool's own refusals and the startup sweep
 * all point at the same three rungs (and the third one is always reachable). */
export function recoveryLadderText() {
	return "恢复梯子：① 在侧边栏重新打开该会话（同一个会话 id 复活，身份/信任/pairs 零改动）→ ② team_link_recover action=revive（仅插件自建会话，需在场确认）→ ③ team_link_recover action=reappoint（现任不会/不应再回来时改任，走完整 M4 交接）→ ④ 设置 UI 直接改 team-link 的 teams 键（用户永远是超级写者）。";
}

/** One line of §11.9.3's read-time liveness diagnosis for a role row, or `""`
 * when there is nothing to diagnose. Pure: `isLive` is injected, and the seat
 * must be OCCUPIED for this to say anything — `current === null` is the
 * deliberate vacancy, whose existing wording ("请由用户经设置 UI 指定现任")
 * is already the correct first action (§11.9.3: the two emptinesses must stay
 * distinguishable, or both get the wrong guidance). */
export function recoveryLadderSuffix(entry, isLive) {
	if (entry === null || entry === undefined) return "";
	const incumbent = entry.current;
	if (incumbent === null || incumbent === undefined || incumbent === "") return "";
	if (isLive(incumbent) === true) return "";
	return `\n【活性诊断】该角色不在空缺名单里——现任 ${incumbent} 被 roster 认定为该角色的持有者，但本进程当前没有它的活动代理（${SEATED_DEAD_LABEL}；「能通讯、不能改身份」：黑板与 team_link_send 仍通，被卡住的是 roster 变更 / 换届 / 建队登记）。这不是「刻意空缺」（${VACANT_LABEL}，current=null），所以这里不该改人，而该把那个会话拉回来。${recoveryLadderText()}`;
}

/** A tool-layer liveness probe: the plugin's own live registry, read once. */
export function agentIsLive(ctx, sessionId) {
	return typeof sessionId === "string" && sessionId !== "" && ctx.agents.get(sessionId) !== undefined;
}

/** §11.9.3's enrichment of a pure gate's refusal. The gate bodies stay PURE
 * (`writerGate` / `rotateGate` / `retireGate` take no `ctx` and are exported to
 * the test surface as such); the TOOL layer — which has a `ctx`, and therefore a
 * liveness reading — appends the named diagnosis to the refusal it already got.
 * A gate that passed, or whose message has nothing to diagnose (vacant seat,
 * caller without a session identity), comes back byte-identical. */
export function withLiveGateDiagnostic(ctx, entry, result) {
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
export function seatedDeadRoles(view, isLive) {
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


/**
 * ---------------------------------------------------------------------------
 * §4.1–§4.3（B 批：团队形态）的读面渲染与宿主探测
 * ---------------------------------------------------------------------------
 */

/** §4.1 的留痕行：点名 settings 里的**原值**、闭集、以及落到了哪一档。单行化 + 预览，
 * 所以一个手改出来的畸形值进不了读面的行结构。 */
export function modeDegradationNote(raw) {
	const single = String(raw).replace(/[\r\n\t]/gu, " ");
	return `形态降级留痕：settings 里的原值「${preview(single, 40)}」不在闭集内（闭集 ${TEAM_MODE_LIST}）⇒ 已按默认档 ${TEAM_MODE_SESSIONS} 读出（原值未被改写，请由用户在设置 UI 修正）。`;
}

/** §4.2 形态史行的**正文**（唯一事实源，写读同源）：落笔时用它，幂等分支「账上有没有这一行」
 * 的判据也用它 —— 两处各写一份字面量就是本仓最反对的「双份真相」（D8）。 */
export function modeHistoryBody(mode, lead) {
	// ★ 批 T（D2）：正文前缀取 {@link MODE_HISTORY_PREFIX} —— 归档切点的「形态史行钉住」判定与
	//   这里写下的那一行**共用同一个前缀**，写与钉不会各说一套（逐字节输出不变）。
	return mode === TEAM_MODE_AGENT_TEAM ? `${MODE_HISTORY_PREFIX}agent-team（Lead=${lead}）` : `${MODE_HISTORY_PREFIX}sessions`;
}
/** 一条 decisions 行的**正文列**（第 4 列起，正文里的 `|` 原样拼回）；行不可解析 ⇒ `null`（不猜）。 */
export function decisionRowBody(line) {
	const parts = String(line).split("|");
	if (parts.length < 4 || !/^\d+$/u.test(parts[0].trim())) return null;
	return parts.slice(3).join("|").trim();
}
/** §4.2 幂等分支的补记判据（D8）：账上**已有**这一档的形态史行？只看正文与
 * {@link modeHistoryBody} 逐字相等 —— 不比较时间戳、不看作者（这一档已经记过一次，就不必再记第二次）。 */
export function decisionsHasModeHistory(text, mode, lead) {
	const wanted = modeHistoryBody(mode, lead);
	return blackboardLines(text).some((line) => decisionRowBody(line) === wanted);
}
/** §4.2 形态史落笔（写路径与幂等补记**共用**一条写入路径）：成功回一句「恰好一行」的读数；
 * 失败一律如实说「未写」+ 为什么 —— settings 那半边的状态由 `settingsNote` 交代。 */
export async function appendModeHistoryRow(team, text, exec, label, settingsNote) {
	if (team.workspace === "") {
		return `- ${label}未写：团队 ${team.name} 没有 workspace 记录，黑板根目录未知（${settingsNote}可由用户经设置 UI 补写路径后重发本次切换以补记）。`;
	}
	const paths = blackboardPaths(team);
	const existing = await readBlackboardFile(paths.decisions);
	if (existing.error !== undefined) {
		return `- ${label}未写：decisions.md 无法读取（${existing.error}）（${settingsNote}）。`;
	}
	const seq = lastDecisionSeq(existing.text) + 1;
	const row = decisionRow(seq, new Date().toISOString(), blackboardAuthor(exec), text);
	const prefix = existing.text === "" || existing.text.endsWith("\n") ? "" : "\n";
	try {
		await mkdir(paths.dir, { recursive: true });
		await appendFile(paths.decisions, `${prefix}${row}\n`, "utf8");
		return `- ${label}（恰好一行）：decisions.md #${seq}「${text}」→ ${paths.decisions}`;
	} catch (error) {
		return `- ${label}未写：decisions.md 写入出错（${describeError(error)}）（${settingsNote}）。`;
	}
}
/**
 * §4.2 幂等分支的**补记**（D8）：同档同 Lead 时账上却缺这一档的形态史行 ⇒ 补写**恰好一行**。
 *
 * 为什么必须补：`decisions.md` 可能在上一次切换时写失败（例如团队那时还没有 workspace），而失败
 * 时给出的指路正是「补上路径后重发本次切换以补记」—— 若幂等分支**先命中并零写返回**，那条指路就
 * **不可执行**，US6「每次切换留一行」会被永久破坏。
 *
 * 判据逐条 fail-closed（拿不准就不写，并把「为什么没写」如实说回来）：
 * - 没有 workspace ⇒ 黑板根目录未知 ⇒ 不补记；
 * - 账读不出来 ⇒ 无从知道有没有那一行 ⇒ 不补记（猜就是造假账）；
 * - 账上已有那一行 ⇒ 不补记（仍是零写幂等）；
 * - 账上没有 ⇒ 追加恰好一行；写入失败 ⇒ 如实报「未补记」。
 */
export async function backfillModeHistoryRow(team, mode, lead, exec) {
	if (team.workspace === "") {
		return "- 形态史核对：团队没有 workspace 记录，黑板根目录未知 ⇒ **无法核实账上有没有这一行**，本次**不补记**（宁可不写，也不猜；可由用户经设置 UI 补上 workspace 后重发本次切换以补记）。";
	}
	const existing = await readBlackboardFile(blackboardPaths(team).decisions);
	if (existing.error !== undefined) {
		return `- 形态史核对：decisions.md 无法读取（${existing.error}）⇒ **无法核实账上有没有这一行**，本次**不补记**（宁可不写，也不猜）。`;
	}
	if (decisionsHasModeHistory(existing.text, mode, lead)) {
		return "- 形态史核对：decisions.md 里**已有**这一档的形态史行，本次**零写**（连 decisions.md 都不追加：形态史记的是「声明过这一档」，不是「档位发生变化」—— 这一档已经声明过了）。";
	}
	return appendModeHistoryRow(team, modeHistoryBody(mode, lead), exec, "形态史补记", "本次未写 settings，");
}

/** §4.3 的一行团队形态：形态 +（agent-team 档的）Lead 指针 +（若有）降级留痕。 */
export function modeTeamLine(team) {
	const parts = [`- ${team.name}：形态=${team.mode}`];
	if (team.mode === TEAM_MODE_AGENT_TEAM) {
		// §4.1 的原话就是「读面标 Lead 未知」：没有指针时**不写等号**，免得读成「Lead 是一个叫未知的会话」。
		parts.push(team.leadSessionId === "" ? " · Lead 未知（本档位下 leadSessionId 为空——不编造）" : ` · Lead=${team.leadSessionId}`);
	}
	const degraded = TEAM_MODE_DEGRADATIONS.get(team.name);
	if (degraded !== undefined) parts.push(` · ${modeDegradationNote(degraded)}`);
	return parts.join("");
}

/** §4.3(3) 名册投影的一行（一名成员）：名字（角色，状态，可选模型/自述）。 */
export function memberLine(member) {
	const bits = [member.role === "lead" ? "Lead" : "teammate", String(member.status)];
	if (typeof member.model === "string" && member.model !== "") bits.push(member.model);
	if (typeof member.description === "string" && member.description !== "") bits.push(preview(member.description, 60));
	return `${member.name}（${bits.join("，")}）`;
}

/** §4.3 的形态段渲染器（`roster get` 与状态卡**共用**）：每团队一行形态 + Lead ·
 * 一次成员名册投影（两种来源文案写死其一）· 一次完整能力矩阵 · 结论 ·（必要时）诊断行。
 * `modeTeams` 是本次要显示的团队行；`projection` 是本次读到的宿主投影；
 * `otherSessions` 是会话列表快照判据（`null` = 快照读不到 ⇒ 不判、也不猜）。 */
export function teamModeSectionLines(modeTeams, projection, otherSessions) {
	const lines = [];
	for (const team of modeTeams) lines.push(modeTeamLine(team));
	lines.push("--- 成员名册（agent-team 档的**投影**：读时现算、一行不落 settings）---");
	if (projection.readable) {
		lines.push(TEAM_MODE_ROSTER_READABLE);
		if (projection.members.length === 0) lines.push("（宿主团队当前没有成员行）");
		for (const member of projection.members) lines.push(`- ${memberLine(member)}`);
	} else {
		// D2：首行**按分支**取 —— 只有服务缺席才说「本部署未提供该投影」，其余四条用中性首行，
		// 真正的分支原因由紧随的一行点名（两行互相印证，不再自相矛盾）。
		lines.push(projection.cause === "service-absent" ? TEAM_MODE_ROSTER_UNREADABLE : TEAM_MODE_ROSTER_UNREADABLE_NEUTRAL);
		lines.push(`（不可读原因：${projection.reason}）`);
	}
	lines.push(...modeCapabilityLines(null));
	if (otherSessions !== null && otherSessions.length === 0) lines.push(TEAM_MODE_DIAGNOSTIC);
	return lines;
}

/** 能力矩阵的**唯一渲染器**（读面与写路径的返回体共用一张表、一句结论）。`mode` 只影响那句标题。 */
export function modeCapabilityLines(mode) {
	const lines = [mode === null ? "--- 能力矩阵（两档对照；事实源 = 父档 §2.3，逐行照抄）---" : `--- 能力矩阵（新档 ${mode}；事实源 = 父档 §2.3，逐行照抄）---`, "| 能力 | 多会话档 | agent-team 档 |"];
	for (const row of TEAM_MODE_CAPABILITY_ROWS) lines.push(`| ${row.ability} | ${row.sessions} | ${row.agentTeam} |`);
	lines.push(TEAM_MODE_CONCLUSION);
	return lines;
}

/**
 * §4.2 的第二道门（**人类确认框**）：无确认服务 / 超时 / 取消 ⇒ 拒绝且**零写入**（fail-closed）。
 * 计时器 + `AbortController` 与既有三处调用**同形**（同一个常量
 * {@link ROTATION_CONFIRM_TIMEOUT_MS}）—— 「等一个人」的预算在本仓只有一个数。
 */
export async function askModeDialog(ctx, exec, request) {
	const userQuestions = ctx.get?.("userQuestions");
	if (userQuestions === undefined || typeof userQuestions.ask !== "function") {
		return { confirmed: false, reason: "确认服务（userQuestions）不可用——切档必须有人在对话框里点一下；无确认即不执行（fail-closed，§4.2）。" };
	}
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, ROTATION_CONFIRM_TIMEOUT_MS);
	timer.unref?.();
	const forward = () => controller.abort();
	exec?.signal?.addEventListener?.("abort", forward);
	try {
		const answer = await userQuestions.ask({
			questions: [{
				id: MODE_DIALOG_ID,
				header: "团队形态切换确认",
				question: wellFormed(request.question),
				detail: wellFormed(request.detail),
				options: [
					{ label: MODE_CONFIRM_LABEL, description: request.confirmDescription },
					{ label: MODE_CANCEL_LABEL, description: "不切换：本次零写入（settings 与 decisions.md 都不动，形态不变）" },
				],
			}],
			agent: exec?.agent,
			signal: controller.signal,
		});
		const item = Array.isArray(answer?.answers) ? answer.answers.find((entry) => entry?.id === MODE_DIALOG_ID) : undefined;
		const choice = Array.isArray(item?.selected) ? item.selected[0] : undefined;
		if (choice === MODE_CONFIRM_LABEL) return { confirmed: true };
		if (choice === MODE_CANCEL_LABEL) return { confirmed: false, reason: "确认框选了「取消」。" };
		return { confirmed: false, reason: "确认框没有返回本次形态切换问题的答案。" };
	} catch (error) {
		if (timedOut || dialogNoAnswerError(error, exec?.signal)) {
			return { confirmed: false, reason: timedOut ? `确认框 ${Math.round(ROTATION_CONFIRM_TIMEOUT_MS / 60000)} 分钟内未获应答（超时；无人在场）。` : `确认框未获应答（调用方中止：${describeError(error)}）。` };
		}
		return { confirmed: false, reason: `确认框失败（${describeError(error)}）。` };
	} finally {
		clearTimeout(timer);
		exec?.signal?.removeEventListener?.("abort", forward);
	}
}

/** §4.3(5) 的判据与 §4.2 的在场校验共用**同一份**会话列表快照（同一份记录列表、同一个
 * `ctx.sessionQuery.listSessions`，与 `list_sessions` 同源）；`null` = 列表读不到
 * （不猜：读面据此不打诊断行，写路径据此拒绝）。 */
export async function sessionIdSnapshot(ctx) {
	try {
		const records = await ctx.sessionQuery.listSessions(undefined);
		return records.map((record) => record.header?.id).filter((id) => typeof id === "string" && id !== "");
	} catch {
		return null;
	}
}

/** §4.3(5) 的形态诊断行判据：本工作区里**除自己外没有其他可达会话**。与列表工具同一条
 * 过滤（同一个 cwd、排除调用方自己）；读不到快照 ⇒ `null`（不判）。
 * **没有会话身份 ⇒ 同样 `null`**（R5）—— 那种情况下 cwd 只能按 `process.cwd()` 猜，
 * 「没有其他会话」就成了基于猜测的结论（宁可不出这一行，也不凭空告警）。 */
export async function otherReachableSessions(ctx, exec) {
	const selfId = agentSessionId(exec);
	// R5（收尾修复轮）: 没有会话身份就**返回 null（不判）**。旧实现在这里退化成按 `process.cwd()`
	// 过滤 —— 判据于是变成了**基于猜测**的结论，可能凭空打出「⚠ 多会话通道看起来不可用」。这与
	// 同一个函数**读不到快照**时的处置（`null` ⇒ 不判、不猜）是同一条纪律，也与 `sessionIdSnapshot`
	// 的失败语义对齐：拿不准就不判，绝不猜。
	if (selfId === undefined) return null;
	const cwd = agentCwd(exec);
	try {
		const records = await ctx.sessionQuery.listSessions(undefined);
		return records.filter((record) => record.header?.cwd === cwd && record.header?.id !== selfId).map((record) => record.header.id);
	} catch {
		return null;
	}
}

/** §4.2 第一道校验：Lead 会话 id 的形状。省略是**合法**的（默认取调用方自己），由调用方
 * 处理；显式空串**不合法**（agent-team 档没有 Lead 就没有意义）。 */
export function readLeadSessionId(value) {
	if (typeof value !== "string") return { error: "leadSessionId 必须是字符串（省略 ⇒ 默认取调用方自己的会话 id）。" };
	const lead = value.trim();
	if (lead === "") return { error: "leadSessionId 是**显式空串** —— agent-team 档没有 Lead 就没有意义（省略它即默认取你的会话 id；要给别的会话就给一个可寻址的 id）。" };
	if (!LEAD_SESSION_ID_RE.test(lead)) return { error: `leadSessionId 形状非法（「${preview(lead, 40)}」）—— 首字符必须是字母或数字，其后 0–63 个 [A-Za-z0-9._-]。` };
	return { value: lead };
}

/**
 * §3.3.2 (v1.3) retirement permission, implemented verbatim: "仅现任协调者会话
 * 或用户发起". Deliberately independent of `policy.writer` — the clause names
 * the incumbent coordinator, not the writer policy, so a `writer: "any"` team
 * still retires through its coordinator. The user path is the settings UI.
 */
export function retireGate(team, caller) {
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
// ===========================================================================
// 批 T（黑板归档 / 回收）—— 显式归档动词的核心
// ===========================================================================
// 归属：docs/2026-10-18-blackboard-archive-design.md §4 D2/D3/D4/D7/D8 · §5 FR-T1/FR-T2/FR-T3/FR-T5 ·
//       §6（伪代码逐行落地）· §7（归档头 / 确定性命名 / 路径不变式）· §9（边界）。
// 需求：docs/2026-10-18-blackboard-archive-requirements.md US-T1…US-T5 · NF-T1…NF-T4 · Tr1–Tr13。
//
// ★ 这是什么：把 `decisions.md` / `tasks.md` 的**旧行**显式搬进
//   `archive/<file>-g<世代>-L<起>-L<止>.md`（只搬不删；归档文件**只写一次**），活跃文件保留
//   尾部 + 一行归档指针。切点 = **min(位置切点, 最新形态史行位置)** —— 最新形态史行永不搬走
//   （D2：set-mode 的幂等检查只读活跃文件，把它切走会让检查漏判、产生重复形态史行）。
// ★ 为什么不能天真截断：`seq` 与任务号都是从文件里扫出来的（`lib/ledger.js` 的 `lastSeq` /
//   `registeredTaskIds`）；本批同时把它们的取值面扩到「活跃 ∪ `archive/`」⇒ 归档之后号不回卷、
//   归档过的任务号仍被认。分配面在 `lib/ledger.js`，写面在这里。
// ★ 三道核对（D7/D8；任何一道不过 ⇒ **活跃文件字节不变**）：
//   ① 归档写**之前**重读并比对被搬前缀 ⇒ 变了就中止（此时盘上零写入）；
//   ② 归档名是**确定性**的（1-based 物理行号区间，**不含墙钟**）⇒ 崩溃后重跑算出同一个名字；
//      同名且正文逐行相等 ⇒ 跳过归档写（**原归档头与字节一律不改**），直接完成活跃文件重写；
//   ③ 归档写**之后**、活跃重写**之前**再读一次 ⇒ 前缀仍相等就用**新读数**的尾部（期间的追加自然
//      并入、不丢）；前缀变了就中止，并如实报「已在 archive/ 留下一份孤儿归档」（行在两处、不丢）。
// ★ 失败方向：确认框（无服务 / 取消 / 超时）/ 内容核对 / 同名冲突 / 读失败任一 ⇒ fail-closed、零写入。
// ★ 世代（D4）：只进归档头与文件名，**不落 policy**；定义见 {@link generationOf}。
// ---------------------------------------------------------------------------

/** §5 FR-T1 的具名阈值：**超过**它只在读面**提示**，绝不自动搬（NF-T1；与 `TASKS_PROJECTION_SCAN`
 *  同量级——行数一旦越过派生扫描窗，留在主档的边际价值开始为负）。 */
export const BLACKBOARD_ARCHIVE_NOTICE_LINES = 500;
/** §5 FR-T2 的默认保留尾部行数（具名常量，**不写进 settings** —— 与 `DECISIONS_WINDOW` 等全部
 *  窗界常量同规）。 */
export const BLACKBOARD_ARCHIVE_KEEP_TAIL = 200;
/** 归档动词的**封闭文件集**（D1 / §5 FR-T2）：`discipline.md` 是可锁定的文档而不是台账，
 *  `handoff-<role>-` 是换届取证的活源头 ⇒ 两者都不在搬动面。 */
export const BLACKBOARD_ARCHIVE_FILES = new Set(["decisions", "tasks"]);
/** ★ 归档子目录名（§7 路径不变式）的唯一事实源是 `lib/ledger.js` 的 `BLACKBOARD_ARCHIVE_DIR`
 *  / `blackboardArchiveDir()` —— 写面（本档）与「活跃 ∪ 归档」的并集扫描（`lib/ledger.js`）
 *  共用同一个路径事实。归档一律落在 `team/<name>/archive/` **子目录** ⇒ 交接文档的扫描谓词
 *  （`handoff-<role>-` + `.md`）在结构上就撞不上归档（负向断言进 Tr6）。 */
/** 归档文件头与正文之间的分隔行：正文 = 被搬行**逐字**（§5 FR-T3）。重跑幂等按它取回正文对账，
 *  所以它是**唯一事实源**（写在这里、读也读这里）。 */
export const BLACKBOARD_ARCHIVE_BODY_MARKER = "--- 以下为搬走的行（逐字，未改动）---";
/** 活跃文件里归档指针行的前缀。指针**不是一条账**：读面的正文行（`blackboardBodyLines`）把它排除，
 *  序号扫描（`^\d+\s*\|`）与台账解析都不会命中它。 */
export const BLACKBOARD_ARCHIVE_POINTER_PREFIX = "> 归档指针：";
/** §4.2 形态史行的**正文前缀**（D2 钉住的那一行）。`modeHistoryBody()` 由它构造、{@link isModeHistoryLine}
 *  由它判定 —— 写与钉共用同一个前缀，切点与幂等检查不会各说一套。 */
export const MODE_HISTORY_PREFIX = "形态 → ";
/** 归档确认框的 id 与两个单选标签（与既有四个对话框同形：一个确认、一个取消）。 */
export const ARCHIVE_DIALOG_ID = "team-archive";
export const ARCHIVE_CONFIRM_LABEL = "归档";
export const ARCHIVE_CANCEL_LABEL = "取消";

/** 活跃档的**物理行**（1-based 计数单位）：末尾换行不产生额外一行，行内容逐字保留。 */
function physicalLines(text) {
	const value = String(text ?? "");
	if (value === "") return [];
	const lines = value.split(/\r?\n/u);
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** 行级切分（§6 `splitRows`）：头部的归档指针行与其余正文分开。
 *  前置：`text` 是活跃档的全文。后置：`pointers` 是**开头连续**的指针行（可空），`body` 是其后全部行。 */
export function splitArchiveRows(text) {
	const lines = physicalLines(text);
	const pointers = [];
	let index = 0;
	while (index < lines.length && lines[index].startsWith(BLACKBOARD_ARCHIVE_POINTER_PREFIX)) {
		pointers.push(lines[index]);
		index += 1;
	}
	return { pointers, body: lines.slice(index) };
}

/** 活跃档的**正文行**（读面用）：非空行、且不含归档指针行 —— 「共 N 条」数的从此是账本身。 */
export function blackboardBodyLines(text) {
	return blackboardLines(text).filter((line) => !line.startsWith(BLACKBOARD_ARCHIVE_POINTER_PREFIX));
}

/** 一行是不是 §4.2 的形态史行（正文前缀 = {@link MODE_HISTORY_PREFIX}）。 */
export function isModeHistoryLine(line) {
	const body = decisionRowBody(line);
	return body !== null && body.startsWith(MODE_HISTORY_PREFIX);
}

/** §6 的切点（D2）：`min(位置切点, 最新形态史行位置)` —— 最新形态史行**永不搬走**。
 *  前置：`body` 是 {@link splitArchiveRows} 的正文行、`keepTail` 是非负整数。
 *  后置：`cut === 0` 表示没有可搬的行（调用方据此拒绝，零写入）。 */
export function archiveCutOf(body, keepTail) {
	const positional = Math.max(0, body.length - keepTail);
	let pin = -1;
	for (let index = 0; index < body.length; index += 1) {
		if (isModeHistoryLine(body[index])) pin = index;
	}
	const cut = pin >= 0 ? Math.min(positional, pin) : positional;
	return { positional, pin, cut, pinned: pin >= 0 && pin < positional };
}

/** §7 的 `generationOf(team)`（D4）：该团队**所有角色 `history` 条数的最大值**（0 ⇒ `g0`）。
 *  只用于归档文件名与归档头，**不落 policy**（顶层键仍十一键，无 `generation` 字段）。 */
export function generationOf(team) {
	const roles = Array.isArray(team?.roles) ? team.roles : [];
	let max = 0;
	for (const entry of roles) {
		const rows = Array.isArray(entry?.history) ? entry.history.length : 0;
		if (rows > max) max = rows;
	}
	return max;
}

/** D3/D8 的确定性归档文件名：`<file>-g<世代>-L<起>-L<止>.md`（L = 活跃文件的 1-based **物理**行号）。
 *  **不含墙钟**是幂等的前提：活跃文件没变 ⇒ 重跑算出的名字必然相同，于是「同名 + 正文逐行相等」可判。 */
export function archiveFileName(file, generation, start, end) {
	return `${file}-g${generation}-L${start}-L${end}.md`;
}

/** 归档文件里的**正文**（标记之后的全部行，逐字）；不是本工具写的档（没有标记）⇒ `null`（不猜）。 */
export function archiveBodyLines(text) {
	const lines = physicalLines(text);
	const marker = lines.indexOf(BLACKBOARD_ARCHIVE_BODY_MARKER);
	return marker === -1 ? null : lines.slice(marker + 1);
}

/** 归档头里的归档时间（读面「最近 <ts>」用它）。缺失 / 读不出 ⇒ `""`（不编造一个时刻）。 */
export function archiveStampOf(text) {
	const matched = /^- 归档时间：(.+)$/mu.exec(String(text ?? ""));
	return matched === null ? "" : matched[1].trim();
}

/** 归档文档（§7 的头：时间 / 执行者 / 文件 / 搬走行数 / 行范围 / 各角色届数快照 / 是否因形态史行缩短切点；
 *  正文 = 被搬行逐字）。头行一律不以 `<数字> |` 开头 ⇒ 并集扫描（`lastSeq` / `registeredTaskIds`）
 *  扫整份归档也不会把元数据读成一条账。 */
export function renderArchiveDocument({ team, file, archiveName, generation, moved, start, end, keepCount, beforeCount, pinned, pinLine, at, caller }) {
	const roles = Array.isArray(team?.roles) ? team.roles : [];
	const snapshot = roles
		.map((entry) => `${String(entry?.role ?? "").replace(/[\r\n|]/gu, "_")}=g${Array.isArray(entry?.history) ? entry.history.length : 0}`)
		.join(" · ");
	const header = [
		`# 黑板归档 · ${file}.md · g${generation}`,
		`- 团队：${team.name}`,
		`- 文件：${file}.md（活跃文件 → archive/${archiveName}）`,
		`- 归档时间：${at}`,
		`- 执行者：${caller}`,
		`- 搬走：${moved.length} 行（活跃文件 1-based 物理行 ${start}..${end}）`,
		`- 保留：活跃文件尾部 ${keepCount} 行 + 归档指针行（后者不在本归档里）`,
		`- 世代：g${generation}（各角色 history 条数最大值；**只进本头，不落 policy**）`,
		`- 世代快照：${snapshot === "" ? "（名册里没有角色行）" : snapshot}`,
		`- 切点：${pinned ? `由最新形态史行钉住（该行在活跃文件第 ${pinLine} 行，**留在活跃文件**）` : "位置切点（保留尾部之外的全部旧行）"}`,
		`- 对账：归档 ${moved.length} 行 + 保留 ${keepCount} 行 = 归档前 ${beforeCount} 行`,
		BLACKBOARD_ARCHIVE_BODY_MARKER,
	];
	return `${header.join("\n")}\n${moved.join("\n")}\n`;
}

/** 一行归档指针（活跃文件头部；不留墙钟 ⇒ 崩溃后重跑重写出的活跃文件**逐字节相同**）。 */
export function archivePointerLine({ file, archiveName, moved, start, end, generation, pinned }) {
	return `${BLACKBOARD_ARCHIVE_POINTER_PREFIX}${file}.md 第 ${start}..${end} 行（共 ${moved} 行）已搬至 archive/${archiveName}（世代 g${generation}；只搬不删；该归档文件只写一次${pinned ? "；切点由最新形态史行钉住，该行留在活跃文件" : ""}）`;
}

/** §5 FR-T1 / D6 的**读面两行**：① 归档索引（`archive/` 非空时**始终**给，与阈值无关）；
 *  ② 阈值提示（行数 **>** 500 才给）。返回 0–2 行，由读面原样接在文件段头之后。 */
export function archiveReadFaceLines(file, entries, rowCount) {
	const lines = [];
	const listed = Array.isArray(entries) ? entries : [];
	const mine = listed.filter((entry) => String(entry?.name ?? "").startsWith(`${file}-`) && String(entry?.name ?? "").endsWith(".md"));
	if (mine.length > 0) {
		const total = mine.reduce((sum, entry) => sum + (archiveBodyLines(entry.text) ?? []).length, 0);
		const stamps = mine.map((entry) => archiveStampOf(entry.text)).filter((value) => value !== "").sort();
		const latest = stamps.length === 0 ? "时间未知（归档头缺「归档时间」行）" : stamps[stamps.length - 1];
		lines.push(`另有 ${total} 行已归档至 archive/（最近 ${latest}；共 ${mine.length} 个归档文件，每个只写一次、只搬不删）`);
	}
	if (rowCount > BLACKBOARD_ARCHIVE_NOTICE_LINES) {
		lines.push(`提示：本档 ${rowCount} 行 > 阈值 ${BLACKBOARD_ARCHIVE_NOTICE_LINES}（具名常量，**只提示、绝不自动搬**）——可显式运行 team_link_team_archive（team / file / keepTail）把旧行搬进 archive/。`);
	}
	return lines;
}

/** `keepTail` 的读取（§5 FR-T2）：省略 ⇒ {@link BLACKBOARD_ARCHIVE_KEEP_TAIL}；非非负整数 ⇒ 具名拒绝。 */
export function readArchiveKeepTail(value) {
	if (value === undefined || value === null || value === "") return { value: BLACKBOARD_ARCHIVE_KEEP_TAIL };
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		return { error: `keepTail 必须是非负整数（默认 ${BLACKBOARD_ARCHIVE_KEEP_TAIL}）——收到「${preview(String(value), 40)}」。` };
	}
	return { value };
}

/** §4.2 的第二道门（**人类确认框**）：无确认服务 / 超时 / 取消 ⇒ 拒绝且**零写入**（fail-closed）。
 *  计时器与 `AbortController` 与既有四处调用同形（同一个常量 {@link ROTATION_CONFIRM_TIMEOUT_MS}）。 */
export async function askArchiveDialog(ctx, exec, request) {
	const userQuestions = ctx?.get?.("userQuestions");
	if (userQuestions === undefined || typeof userQuestions.ask !== "function") {
		return { confirmed: false, reason: "确认服务（userQuestions）不可用——归档会重写活跃文件，必须有人在对话框里点一下；无确认即不执行（fail-closed）" };
	}
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ROTATION_CONFIRM_TIMEOUT_MS);
	timer.unref?.();
	const forward = () => controller.abort();
	exec?.signal?.addEventListener?.("abort", forward);
	try {
		const answer = await userQuestions.ask({
			questions: [{
				id: ARCHIVE_DIALOG_ID,
				header: "黑板归档确认",
				question: wellFormed(`${request.file}.md：把前 ${request.moved} 行搬进 archive/${request.archiveName}，活跃文件保留尾部 ${request.keepCount} 行 + 1 行归档指针（只搬不删；该归档文件只写一次）。`),
				detail: wellFormed([
					`被搬范围：活跃文件 1-based 物理行 ${request.start}..${request.end}（共 ${request.moved} 行）`,
					`保留尾部：${request.keepCount} 行`,
					request.pinned ? `切点已因最新形态史行（活跃文件第 ${request.pinLine} 行）回退 —— 该行留在活跃文件（set-mode 幂等检查读得到它）` : "切点 = 位置切点（保留尾部之外的全部旧行）",
					"归档名确定性（不含墙钟）：同一份活跃文件重跑算出同一个名字；同名且正文逐行相等 ⇒ 跳过归档写、原归档字节不改",
					"取消 / 超时 / 无确认服务 ⇒ 本次零写入（活跃文件与 archive/ 都不动）",
				].join("\n")),
				options: [
					{ label: ARCHIVE_CONFIRM_LABEL, description: `搬走 ${request.moved} 行 → archive/${request.archiveName}；活跃文件原子重写（保留 ${request.keepCount} 行 + 1 行指针）` },
					{ label: ARCHIVE_CANCEL_LABEL, description: "不归档：本次零写入（活跃文件与 archive/ 都不动）" },
				],
			}],
			agent: exec?.agent,
			signal: controller.signal,
		});
		const item = Array.isArray(answer?.answers) ? answer.answers.find((entry) => entry?.id === ARCHIVE_DIALOG_ID) : undefined;
		const choice = Array.isArray(item?.selected) ? item.selected[0] : undefined;
		if (choice === ARCHIVE_CONFIRM_LABEL) return { confirmed: true };
		if (choice === ARCHIVE_CANCEL_LABEL) return { confirmed: false, reason: "确认框选了「取消」。" };
		return { confirmed: false, reason: "确认框没有返回本次归档问题的答案。" };
	} catch (error) {
		if (timedOut || dialogNoAnswerError(error, exec?.signal)) {
			return { confirmed: false, reason: timedOut ? `确认框 ${Math.round(ROTATION_CONFIRM_TIMEOUT_MS / 60000)} 分钟内未获应答（超时；无人在场）。` : `确认框未获应答（调用方中止：${describeError(error)}）。` };
		}
		return { confirmed: false, reason: `确认框失败（${describeError(error)}）。` };
	} finally {
		clearTimeout(timer);
		exec?.signal?.removeEventListener?.("abort", forward);
	}
}

/** 前缀相等（D7 的核对单位）：被搬的那几行**逐字**没变。 */
function sameRowPrefix(body, moved) {
	if (body.length < moved.length) return false;
	for (let index = 0; index < moved.length; index += 1) if (body[index] !== moved[index]) return false;
	return true;
}

/** 两份行数组逐行相等（同名归档的幂等判据）。 */
function sameRows(left, right) {
	if (left.length !== right.length) return false;
	for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
	return true;
}

/** 读一个文件；不存在 ⇒ `null`（其余错误照抛，由调用方如实报）。 */
async function readTextIfExists(file) {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (error !== null && typeof error === "object" && error.code === "ENOENT") return null;
		throw error;
	}
}

/** 原子重写（批 L 的唯一临时名纪律 + 同目录 rename）：临时名 `<目标>.tmp-<pid>-<8 hex>`，
 *  任何失败路径都不留残渣，也绝不掩盖原始错误。前置：`file` 的父目录可建。后置：目标内容恰为 `text`。 */
async function writeTextAtomic(file, text) {
	await mkdir(path.dirname(file), { recursive: true });
	const token = createHash("sha256").update(`${process.pid}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 8);
	const tmp = `${file}.tmp-${process.pid}-${token}`;
	let renamed = false;
	try {
		const handle = await open(tmp, "w");
		try {
			await handle.writeFile(text, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tmp, file);
		renamed = true;
	} finally {
		if (!renamed) {
			try { await rm(tmp, { force: true }); } catch { /* best-effort：不掩盖原始错误 */ }
		}
	}
}

/**
 * 归档一个黑板台账档（§6 的伪代码逐行落地；D1 的**新动词** `team_link_team_archive` 的核心）。
 *
 * 前置：team 在册且 `workspace` 已知；`file` ∈ {decisions, tasks}；确认框已确认；活跃文件此刻可读。
 * 后置（成功）：新归档文件**恰存在一份**（`wx`）；活跃文件 = 旧指针行 + 新指针行 + 尾部（含**最新形态史行**）；
 *   被搬行**逐字**在归档里；不丢任何行；分配与「已注册」校验（`lib/ledger.js`）取「活跃 ∪ 归档」。
 * 后置（中止）：**活跃文件字节不变**；归档写之前中止 ⇒ 盘上零写入；归档写之后中止（前缀被改，极罕见）
 *   ⇒ 留下**孤儿归档**（行同时存在于两处、不丢数据；重跑按确定性文件名识别它）。
 *
 * @param {{team: object, file: string, keepTail?: number, now?: number, exec?: object, ctx?: object,
 *   confirm?: ((request: object) => Promise<{confirmed: boolean, reason?: string}>)} } request
 * @returns {Promise<{lines: string[]} | {error: string}>}
 */
export async function archiveBlackboard({ team, file, keepTail = BLACKBOARD_ARCHIVE_KEEP_TAIL, now = Date.now(), exec = undefined, ctx = undefined, confirm = undefined }) {
	const at = new Date(now).toISOString();
	const caller = agentSessionId(exec) ?? "unknown";
	if (!BLACKBOARD_ARCHIVE_FILES.has(file)) {
		return { error: "file 必须是 decisions 或 tasks（白名单，不接受任何路径；discipline 是可锁定的文档、handoff 文档是换届取证的活源头，都不在归档面）。" };
	}
	if (team?.workspace === undefined || team.workspace === "") {
		return { error: `团队 ${team?.name ?? "（未知）"} 没有 workspace 记录，黑板根目录未知（零写入；可由用户经设置 UI 补写路径）。` };
	}
	const paths = blackboardPaths(team);
	const livePath = file === "decisions" ? paths.decisions : paths.tasks;
	const first = await readBlackboardFile(livePath);
	if (first.error !== undefined) return { error: `${file}.md 无法读取（${first.error}）；本次未搬任何行，活跃文件字节不变。` };
	const firstSplit = splitArchiveRows(first.text);
	const plan = archiveCutOf(firstSplit.body, keepTail);
	const pinLine = plan.pin >= 0 ? plan.pin + firstSplit.pointers.length + 1 : 0;
	if (plan.cut <= 0) {
		const why = plan.pin === 0 ? "（最新形态史行就在第 1 行——切点被它钉住）" : "";
		return { error: `无需归档：${file}.md 正文 ${firstSplit.body.length} 行，未超过保留尾部 ${keepTail} 行${why}（零写入）。` };
	}
	const moved = firstSplit.body.slice(0, plan.cut);
	const start = firstSplit.pointers.length + 1;
	const end = firstSplit.pointers.length + plan.cut;
	const generation = generationOf(team);
	const archiveName = archiveFileName(file, generation, start, end);
	const keepCount = firstSplit.body.length - plan.cut;
	const ask = typeof confirm === "function" ? confirm : (question) => askArchiveDialog(ctx, exec, question);
	const answer = await ask({ team, file, archiveName, moved: moved.length, keepCount, start, end, pinned: plan.pinned, pinLine });
	if (answer === undefined || answer === null || answer.confirmed !== true) {
		return { error: `未确认：归档会重写活跃文件（${answer?.reason ?? "确认框没有返回确认"}）；本次零写入。` };
	}
	// —— ① 归档写**之前**：重读并比对被搬前缀（D7）；不一致 ⇒ 中止、零写入 ——
	const beforeWrite = await readBlackboardFile(livePath);
	if (beforeWrite.error !== undefined) return { error: `${file}.md 归档前重读失败（${beforeWrite.error}）；本次零写入。` };
	const beforeSplit = splitArchiveRows(beforeWrite.text);
	if (!sameRowPrefix(beforeSplit.body, moved)) {
		return { error: "归档前重读：被搬的行已被改动 ⇒ 中止（本次**零写入**，活跃文件与 archive/ 一个字节都没动），请重跑。" };
	}
	const archiveDir = blackboardArchiveDir(paths.dir);
	const archivePath = path.join(archiveDir, archiveName);
	const document = renderArchiveDocument({ team, file, archiveName, generation, moved, start, end, keepCount, beforeCount: beforeSplit.body.length, pinned: plan.pinned, pinLine, at, caller });
	let archiveSkipped = false;
	try {
		await mkdir(archiveDir, { recursive: true });
	} catch (error) {
		return { error: `archive/ 目录建不出来（${describeError(error)}）⇒ 中止（活跃文件字节不变）。` };
	}
	let existing = null;
	try {
		existing = await readTextIfExists(archivePath);
	} catch (error) {
		return { error: `同名归档 ${archiveName} 读不出来（${describeError(error)}）⇒ 中止（活跃文件字节不变）。` };
	}
	if (existing !== null) {
		const existingBody = archiveBodyLines(existing);
		if (existingBody === null || !sameRows(existingBody, moved)) {
			return { error: `同名归档 ${archiveName} 已存在但正文不同 ⇒ 中止（**零写入**；本工具绝不覆盖既有归档，请人工处置）。` };
		}
		archiveSkipped = true;
	} else {
		try {
			await writeFile(archivePath, document, { encoding: "utf8", flag: "wx" });
		} catch (error) {
			if (error !== null && typeof error === "object" && error.code === "EEXIST") {
				let raced = null;
				try { raced = await readTextIfExists(archivePath); } catch { raced = null; }
				const racedBody = raced === null ? null : archiveBodyLines(raced);
				if (racedBody === null || !sameRows(racedBody, moved)) {
					return { error: `同名归档 ${archiveName} 在写入前已被别人建出且正文不同 ⇒ 中止（**零写入**）。` };
				}
				archiveSkipped = true;
			} else {
				return { error: `归档文件写不出来（${describeError(error)}）⇒ 中止（活跃文件字节不变；archive/ 下可能留有半成品，请人工核对）。` };
			}
		}
	}
	// —— ② 归档写**之后**、活跃重写**之前**：再读一次（D7：期间的追加自然并入尾部，不丢）——
	const afterArchive = await readBlackboardFile(livePath);
	if (afterArchive.error !== undefined) {
		return { error: `${file}.md 归档后重读失败（${afterArchive.error}）⇒ 已中止；已在 archive/ 留下归档 ${archiveName}（行同时存在于两处、不丢数据；重跑会按同名识别）。` };
	}
	const afterSplit = splitArchiveRows(afterArchive.text);
	if (!sameRowPrefix(afterSplit.body, moved)) {
		return { error: `归档后重读：被搬前缀已变 ⇒ 中止；已在 archive/ 留下孤儿归档 ${archiveName}（行同时存在于两处、不丢数据；重跑会按同名识别）。` };
	}
	const tail = afterSplit.body.slice(plan.cut);
	const pointer = archivePointerLine({ file, archiveName, moved: moved.length, start, end, generation, pinned: plan.pinned });
	const nextText = `${[...afterSplit.pointers, pointer, ...tail].join("\n")}\n`;
	try {
		await writeTextAtomic(livePath, nextText);
	} catch (error) {
		return { error: `活跃文件重写失败（${describeError(error)}）⇒ 已归档 ${moved.length} 行（archive/${archiveName}），活跃文件仍是旧内容（行同时存在于两处、不丢数据；重跑会按同名识别）。` };
	}
	const liveRows = splitArchiveRows(nextText).body.length;
	const pointerCount = afterSplit.pointers.length + 1;
	return {
		lines: [
			`已归档 ${file}.md：搬走 ${moved.length} 行 → archive/${archiveName}（只搬不删；归档文件只写一次${archiveSkipped ? "——本次命中**同名归档且正文逐行相等**，跳过归档写（原归档头与字节未改）" : ""}）`,
			`活跃文件已原子重写：保留 ${tail.length} 行 + 归档指针 ${pointerCount} 行（现共 ${liveRows + pointerCount} 行；指针行不算一条账）`,
			`对账：归档 ${moved.length} 行 + 保留 ${tail.length} 行 = 归档前 ${afterSplit.body.length} 行（逐行相等，未丢任何行）`,
			`命名（确定性区间，不含墙钟）：活跃文件 1-based 物理行 ${start}..${end} · 世代 g${generation}（各角色 history 最大条数；世代只进归档头、不落 policy）· 执行者 ${caller} · 归档时间 ${at}`,
			plan.pinned
				? `切点：由最新形态史行（活跃文件第 ${pinLine} 行）钉住 —— min(位置切点 ${plan.positional} 行, 形态史行位置 ${plan.pin}) = ${plan.cut} 行；该形态史行**留在活跃文件**（set-mode 的幂等检查照旧读得到它）。`
				: `切点：位置切点 ${plan.positional} 行（正文 ${afterSplit.body.length} 行 − 保留尾部 ${keepTail} 行）。`,
			"分配与「已注册」校验现在取「活跃 ∪ archive/」的并集 ⇒ seq 与任务号不回卷、归档过的任务号仍被认（伪造的高号仍被拒）。",
		],
	};
}

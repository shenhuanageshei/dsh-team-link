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

import { appendFile, mkdir } from "node:fs/promises";

import { blackboardAuthor, blackboardLines, blackboardPaths, decisionRow, lastDecisionSeq, readBlackboardFile } from "./ledger.js";
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
	return mode === TEAM_MODE_AGENT_TEAM ? `形态 → agent-team（Lead=${lead}）` : "形态 → sessions";
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

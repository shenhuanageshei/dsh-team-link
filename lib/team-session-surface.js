// ===========================================================================
// lib/team-session-surface.js — 批 R · 第 20 小单：§10.2 ② `/team_session` 命令面
//                                 （对话框渲染族 ＋ 调用方回执族 ＋ 命令注册）
// ===========================================================================
//
// 归属：docs/2026-10-15-store-compliance-design.md §4 D1/D2/D4 · §5 FR-R1 · §6（拆分不变量 ①–⑤）·
//       §8 Rr1/Rr3/Rr4/Rr8。
// ★ 本档是什么：入口原 **两段相邻块**（as-of 本单动手前）—— ① **3862–4176 行**：§10.2.8.4 的**对话框
//   渲染族**（`teamSessionDialogText` / `teamSessionDialogQuestion` / `dialogCodePoints` / `dialogFlatten` /
//   `dialogField` / `dialogFits` / 三段裁段标注 `TEAM_SESSION_DIALOG_CROP_NOTE_*` / `teamSessionDialogCropNote` /
//   `teamSessionTaskNote` / `teamSessionModelLine`，共 **12 条**声明）；② **4527–4930 行**：§10.2.6 的
//   名册登记 `registerTeamSessionRoles` · `commands` 可选缝 `createCommandsSeam` · §10.2.8.10 ① 的调用方
//   回执族（两条常量 ＋ `teamSessionReceiptReason` / `teamSessionReceiptOf` / `teamSessionReceiptText` /
//   `deliverTeamSessionReceipt`）· `registerTeamSessionCommand`（共 **9 条**声明）。
//   合计 **21 条声明**；实测 **57,590 字节 / 719 行**（块正文，CRLF 工作树），EOL 归一到 LF 后
//   **56,871 字节** —— 本小单 60 KB 档位（61,440 B）上限之内。
//   机检口径：把本档正文按声明行去掉 `export ` 前缀后，与入口原位置那两段（以空行相接）**逐字节相等**
//   （EOL 归一）；那两段在入口里**零次**。
//   ★ 它是一个**自成一体的块**：渲染族只被本档的命令注册读（另经 `team-session-command.js` /
//     `team-session-creation.js` 既有的两条装配缝被取用 —— 入口转出的是**同一批绑定**，不是第二份实现）；
//     回执族与命令注册只被入口 `apply` 的那一次调用读；21 条声明里 13 条只被块内使用，对外只经下面
//     「装配缝」的 5 条入口侧出口 ＋ 七条相对导入 ＋ 一条宿主导入取物。
//     这一段正是 `lib/team-session-command.js` 档头「本档不是」清单里点名的同一块（① 对话框渲染族 ＋
//     ③ 的回执 / `createCommandsSeam` / `registerTeamSessionCommand`）—— 本单就是那一块。
// ★ 本档**不是**（留给下一小单，逐条点名；区间字节为 CRLF 工作树口径，闭包为 EOL 归一（LF）口径）：
//   · policy store 核心 `createPolicyStore`（1449–2400：含文档注释 62,415 B / 952 行；函数本体 1470–2400
//     ＝ 61,475 B —— 单这一项就已越过 60 KB 档位（61,440 B）；含随附命名空间常量的闭包 66,800 B）
//   · 换届交班余下（`HANDOFF_*` 三常量 / `handoffSectionsInline` / `rotationAuto*` / `askRotationAuto` /
//     `handoffDeliveryMessage` / `autoHandover` / `registerRotationTools`，3409–3934 ＝ 43,195 B / 526 行）
//   · `buildTeamSessionCreateOptions`（被钉）· `buildTeamSessionResumeOptions` /
//     `resolveTeamSessionModelSelection` · 被钉的 `relayUserMessage` · `teamSessionKickoffMessage` ·
//     pending 两条（`addTeamSessionPending` / `removeTeamSessionPending`）—— 仍在入口
//   · `registerTeamTools`（3165–3408 ＝ 19,966 B / 244 行）· `createSections`（2440–2709 ＝ 14,844 B / 270 行）·
//     恢复工具三块（5081–5172 ＝ 12,277 B / 92 行）· 入口 `apply`（对外装配面，本单不搬）
//   这些**一个都没动**，入口里仍在原位置（搬走的两段留了指路注释）。
// ★ 依赖方向（Rr4「模块图无环」）：本档**不导入入口** `lib/index.js`（那会构成 ESM 环，实跑当场 TDZ）——
//   ① 内部相对导入 **7 条**：`./shared.js`（4 名）· `./rotation.js`（2 名）· `./sections.js`（2 名）·
//      `./watchdog-helpers.js`（2 名）· `./roster-write.js`（3 名）· `./team-session-command.js`（18 名）·
//      `./team-session-creation.js`（6 名）；
//   ② 装配缝注入 **5 条**：`PLUGIN_LABEL`（全局标签：warn 行前缀与回执错因前缀）· `relayUserMessage`
//      （**被钉：只注入不搬**）· `writerGate`（**被钉：只注入不搬**）· `withLiveGateDiagnostic` /
//      `agentIsLive`（入口侧仍在用的两条读数助手：写门诊断与本地活性读数）；
//   ③ 宿主导入 **1 条**：`node:path` 默认导出 —— 说明符本来就在那 8 条白名单里 ⇒ `Rr3` 的**集合**读数
//      一字不变。
//   三类出边**都不回指入口或本档** ⇒ 本单**不新增环**。
// ★ 被钉符号核对（本仓 `hostSource` 文本锁钉住的 9 个：`writePolicyFileAtomic` / `renameThroughSeam` /
//   `POLICY_FILE_SCHEMA` / `WATCHDOG_DIGEST_DEBOUNCE_MS` / `TICKABLE_VERDICTS` / `agentStateLabel` /
//   `writerGate` / `relayUserMessage` / `buildTeamSessionCreateOptions`）：**本单一个都没搬**，九个仍逐字节
//   住在入口；`writerGate` / `relayUserMessage` 只作为依赖经缝传入（本档可执行代码对它们的引用恰是那
//   3 处调用点：`writerGate` 两处、`relayUserMessage` 一处），其余七个在**被搬正文**里**零引用**
//   （连注释里都不出现 —— 只有本段档头的这张核对表点名它们）。
//   另：`teamSessionDialogText` / 回执族 / `TEAM_SESSION_DIALOG_CROP_NOTE_TIERS` /
//   `TEAM_SESSION_RECEIPT_MAX_POINTS` 仍由入口 `__testing` 按名再导出；`teamSessionDialogQuestion` 仍经入口
//   `teamSessionCreationExtras()` 注入建队域 ⟹ 对外名字 / 签名 / 语义一字不变。
// ★ 搬运纪律（D4）：本档新增的只有 ① 本段档头 ② 8 条 import 语句（1 条宿主 ＋ 7 条内部相对）③ 装配缝
//   ④ 21 条声明行上的 `export ` 前缀；其余（含全部行内注释、嵌套函数与中文文案）**一个字符都没动**。
// ---------------------------------------------------------------------------

import path from "node:path";

import { COORDINATOR_ROLE, describeError, readStamp, wellFormed } from "./shared.js";
import { roleOf, teamMembers } from "./rotation.js";
import { charterReinforceLine, sectionsSwitches } from "./sections.js";
import { armTeamWatchdog, isIncumbentCoordinator } from "./watchdog-helpers.js";
import { applyTeamUpsert, mirrorNote, writeRosterMirror } from "./roster-write.js";
import { TEAM_SESSION_COMMAND, TEAM_SESSION_DIALOG_FIELD_CHARS, TEAM_SESSION_DIALOG_LIST_ROWS, TEAM_SESSION_DIALOG_MAX_CODE_POINTS, TEAM_SESSION_DIALOG_MAX_NEWLINES, TEAM_SESSION_DIALOG_MAX_QUESTION_POINTS, TEAM_SESSION_DIALOG_TASK_CHARS, TEAM_SESSION_ID_SHAPE, TEAM_SESSION_MAX_CREATES, TEAM_SESSION_MAX_MEMBERS, TEAM_SESSION_RELEASE_DISCLOSURE, TEAM_SESSION_RELEASE_NOTES, TEAM_SESSION_ROLE_GUIDANCE, applyTeamSessionRelease, readTeamSessionCommand, teamSessionDefaultTeam, teamSessionPlan, teamSessionReleaseVerdict } from "./team-session-command.js";
import { askTeamSessionBatch, createTeamSessions, createdTeamSessionRoles, teamSessionNoConfirmText, teamSessionRoleRow, withTeamSessionPairs } from "./team-session-creation.js";

// ---------------------------------------------------------------------------
// 装配缝 · `wireTeamSessionSurface(extras)`（先例：`lib/forensics.js` 的 `wireForensics()`）
// ---------------------------------------------------------------------------
// 前置：入口在**模块求值**时调用一次（`lib/index.js` 模块尾部，紧挨 `wireRosterWrite(…)`），给出的
//       5 个键与被注入的绑定**同名同值**（同一批绑定、同一份实现）。
// 后置：本档的模块级 `let` 全部绑定到入口那一份真实现；此后每次调用读到的都是它。
// 为什么不是 import：入口 → 域档会成环（实跑当场 TDZ）。
// 为什么是一次性绑定而不是每次调用现取：绑定之后被搬函数体内的裸名**逐字节保留**（只在函数体外加了
// 这一个缝），D4 的逐字节等价可以直接机检。
// ---------------------------------------------------------------------------
let PLUGIN_LABEL, relayUserMessage, writerGate, withLiveGateDiagnostic, agentIsLive;

/** 入口侧出口的一次性绑定（见本节档头的前置 / 后置）。 */
export function wireTeamSessionSurface(extras) {
	({
		PLUGIN_LABEL,
		relayUserMessage,
		writerGate,
		withLiveGateDiagnostic,
		agentIsLive,
	} = extras);
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
 * 组合（团队名取满封顶 32（20 字那具读数再 +12）＋ 8 个已登记角色 ＋ 300 字 `model=` ＋ 60 字 `preset=` ＋ 3000 字正文 ＋
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
 * 默认值第 4 条的反转 (2026-09-22 用户裁定, §10.2.8.10 ②) 把这一行的**分支问题整个消掉了**:
 * 无任务支不再说「不投启动任务」(它改投最小唤醒), 而有任务支与无任务支的模型回合数现在都是
 * N＋1 ⇒ 成本行**不再分支**（它说的东西在两支里都成立, 也就不可能自相矛盾 —— 这正是第 2 轮
 * 评审 🟡#1 的「同支纪律」在本轮被更强地满足的方式）。有任务/无任务**各自的承诺**仍分别写在
 * 「启动任务」与「确认则」两行上（那两行照旧按支写）。
 *
 * DEFECT-3 收尾 (裁定 2): the model slot says the same. It used to read 「（本会话默认）」
 * whenever `model=` was absent — the wording of a judgement that the real machine has
 * since refuted (an agent created without `agentOptions` never reaches the host's own
 * default), and it is also false for the half-route caller. Every shape now names what
 * will really be written ({@link teamSessionModelLine}).
 */
export function teamSessionDialogText(plan, cwd, coordinatorId, release = null) {
	const cap = TEAM_SESSION_DIALOG_FIELD_CHARS;
	// §10.2.8.9 ②: when this very command releases the existing coordinator seat, the
	// batch the human is authorizing includes that write — so it is disclosed IN the
	// box, as the pinned short form (11 code points — 设计档原写 12，勘误见 §10.2.8.9 ②)
	// folded into the 「确认则」 line (the
	// team name is already on line 1, so it is not repeated here).
	const releaseDisclosure = release === null || release === undefined ? "" : TEAM_SESSION_RELEASE_DISCLOSURE;
	const roles = plan.sessions.map((entry) => `${dialogField(entry.role, cap.role)}${entry.skip ? "（已登记，跳过）" : ""}`);
	const shown = roles.slice(0, TEAM_SESSION_DIALOG_LIST_ROWS);
	const hidden = roles.length - shown.length;
	const skippedNote = plan.skipped.length === 0 ? "" : `（${plan.skipped.length} 个角色已登记，跳过：${dialogField(plan.skipped.join("、"), cap.skipped)}）`;
	// §10.2.8.7 裁定 2: the role-semantics line stays a line of its OWN (「各加一行」 in both
	// the dialog and the completion report), so it is never merged with another fact.
	// 成本口径（§10.2.8.10 的**连带改动**，R3 🟡#7）：回执把一次命令的模型回合数从
	// 「N（有任务）/ 0（无任务）」改成**两支同为 N＋1**，所以这一行**不再分支** —— 它说的
	// 东西在两支里都成立，也就不可能与同一张框的「确认则」自相矛盾（🟡#1 的同支纪律由
	// 「不写任何 branch-specific 断言」满足，而不是靠两支各抄一句）。
	//
	// **一次经申报的改写**（不是删事实）：旧文案「N 个会话 × 至少一个完整回合（followup
	// 驱动一次，按各自模型计费）」——「按各自模型计费」在 2026-09-22 裁定 A 落码时被漏删、
	// 由偏差修复轮放回（DIVERGENCE #4），**本次逐字保留**；让位的是机制短语「followup 驱动
	// 一次」（它说的是**怎么驱动**，而这一行报的是**代价**，机制由同一张框的
	// 「确认则：创建 → 投递启动任务」承载）。腾出的码点正是回执那条事实要占的：那句披露（11 码点）
	// 折进「确认则」之后，U33c 两个参照只有 12（28 码点 id 那具）的余量。
	const costLine = `成本：${plan.creating.length + 1} 个回合（${plan.creating.length} 个新会话 ＋ 1 条调用方回执；按各自模型计费）`;
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
		// ≤390 码点**（设计档 §10.4 的 U33c 行定档值；改前 569 码点 / 10 行）。**本批重测**
		// （§10.2.8.10 的成本行改写成 N＋1 回合口径、整体 −7 码点）：12 码点 id **355** ·
		// 28 码点 id **371** · 触发释放那两具 **348 / 382**（28 码点 id ＋ 带日期团队名是最坏一具，
		// 余量只剩 8）。数字沿革：350 → 380（偏差修复轮，放回「按各自模型计费」）→ **390**（与设计档
		// 对齐；测试里此前写 380、比设计档更严）。由 host-half 的 U33c 三条断言咬住（参照 A / 参照 B
		// ＋释放变体 E，且 E 必须逐字等于 B 插入那 11 码点披露）。
		{ required: true, text: `将创建 ${plan.creating.length} 个 worker 根会话并登记进团队 ${dialogField(plan.team, cap.team)}${skippedNote}${idShapeNote}：${shown.join("；")}${hidden > 0 ? `；…等 ${roles.length} 个` : ""}。` },
		{ required: true, text: `- 模型/预设：${modelPreset}；cwd：${dialogField(cwd, cap.cwd)}` },
		{ required: true, text: `- 启动任务：${teamSessionTaskNote(plan.task)}` },
		// §10.2.8.7 裁定 2: one line of its own, and it is inside the budget below.
		{ required: true, text: TEAM_SESSION_ROLE_GUIDANCE },
		// 「同支纪律」（2026-09-22 第 2 轮评审 🟡#1）在本轮**换了更强的满足方式**：默认值第 4 条
		// 反转之后两支的模型回合数都是 N＋1，于是这一行**不再分支** —— 它说的东西在两支里都成立，
		// 也就不可能与下一行的「确认则」自相矛盾。U30 的措辞断言同时咬这一行（两支逐字同形状 ＋
		// 「followup 驱动一次」「0 次驱动」「不投启动任务」都不再出现）。
		{ required: true, text: `${costLine}；${trustLine}` },
		// §10.2.8.10 ②（默认值第 4 条**反转**）: 既无正文也无 `task=` 时**不再**是「不投启动
		// 任务」——它改投一具最小唤醒（`teamSessionKickoffText` 的 `perRole === undefined`
		// 支回归主路径），所以这一行按「投最小唤醒」写，并说清唤醒**不含任务内容**。授权行
		// 描述的就是真正会跑的那一支（这张框是人类对它的唯一视图）。
		// `releaseDisclosure`（§10.2.8.9 ②）折在**同一行**的 pairs 之后、取消则之前：句长
		// 出账算在 U33c 的 390 内，而 U33c 的两个参照读数就是这么来的。
		{ required: true, text: (plan.task === undefined
			? `确认则：创建 → 投最小唤醒 → 登记 roster 与 pairs（唤醒不含任务）`
			: `确认则：创建 → 投递启动任务 → 登记 roster 与 pairs`) + releaseDisclosure + `；取消则零创建、零 pairs。` },
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
export function teamSessionDialogQuestion(plan) {
	const cap = TEAM_SESSION_DIALOG_FIELD_CHARS;
	return dialogField(`确认创建 ${plan.creating.length} 个 worker 会话并登记进团队 ${dialogField(plan.team, cap.team)}？`, TEAM_SESSION_DIALOG_MAX_QUESTION_POINTS);
}

/** Code points of `text` — never UTF-16 units, because a cut must not split a
 * surrogate pair (the same rule {@link preview} and {@link truncate} follow). */
export function dialogCodePoints(text) {
	return [...String(text ?? "")].length;
}

/** `text` with every whitespace run collapsed to one space: the dialog's fields are
 * ONE line each, so a pasted document's newlines cannot spend the newline budget. */
export function dialogFlatten(text) {
	return String(text ?? "").replace(/\s+/gu, " ").trim();
}

/** A dialog field: flattened, then cut to `limit` code points with an ellipsis. */
export function dialogField(text, limit) {
	const flat = dialogFlatten(text);
	const chars = [...flat];
	return chars.length <= limit ? flat : `${chars.slice(0, limit - 1).join("")}…`;
}

/** §10.2.8.4 (b): BOTH budgets, in one predicate — code points and newlines. */
export function dialogFits(text) {
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
export const TEAM_SESSION_DIALOG_CROP_NOTE_FULL = (dropped) => `（已省略 ${dropped} 段自述；必备披露一字未少。）`;
export const TEAM_SESSION_DIALOG_CROP_NOTE_MINIMAL = (dropped) => `（已省略 ${dropped} 段自述）`;
/** 档位按**从宽到窄**排列：{@link teamSessionDialogText} 的终态构造取**第一个**装得进
 * `dialogFits` 的档；两档都装不下时交付**最后（最窄）那一档** —— 那是「如实标注的受限超额」，
 * 只能由**不可裁的必备 body** 引起（机制一残余，见设计档 §10.2.8.4 的残余行）。
 *
 * **触发面为空（2026-09-22 裁定 A，逐条可复核）**：这两档只在 `dropped > 0` 时被取用，而裁定 A
 * 把框里唯一的 `required: false` 段（「会话标题」）整段移了出去 ⇒ 现在没有任何一条路径会取用它们。
 * 用户裁定里的「不许动：…两档标注与终态预算机制」按**代码原样保留**执行（不改一个字符），并且
 * 它们在 `host-half.test.mjs` 里仍有一份**纯函数**判据（档位常量各自的长度与「不含自证矛盾句」）；
 * 一旦某段自述回到框里，取用路径立刻恢复。 */
export const TEAM_SESSION_DIALOG_CROP_NOTE_TIERS = [TEAM_SESSION_DIALOG_CROP_NOTE_FULL, TEAM_SESSION_DIALOG_CROP_NOTE_MINIMAL];

/** One tier of the crop annotation (§10.2.8.4 (b): 超出即按段落裁剪并标注). It names what was
 * kept, so a reader of a cropped box knows the disclosure is intact — and its length is a
 * function of the ACTUAL `dropped` count rather than a constant. */
export function teamSessionDialogCropNote(dropped, tier = TEAM_SESSION_DIALOG_CROP_NOTE_FULL) {
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
export function teamSessionTaskNote(task) {
	if (typeof task !== "string" || task.trim() === "") return "（未给正文/task=）";
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
export function teamSessionModelLine(plan) {
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
 * §10.2.6 orphan guard, ownership half: one roster write for the whole batch,
 * through the SAME functions the roster tool uses — the creation path goes
 * through `upsert-team`'s「创建即认领」bootstrap, and an EXISTING team still
 * passes the existing `writerGate` first. No bypass is added (§10.2.4 既有 team
 * 的权限).
 *
 * @returns `{ team }` or `{ error }`.
 */
export async function registerTeamSessionRoles(ctx, policy, plan, cwd, coordinatorId, createdRoleNames, release = null) {
	const added = createdRoleNames.filter((role) => !plan.skipped.includes(role));
	if (added.length === 0) return { team: null, added: [] };
	const view = policy.get();
	const existing = view.teams.find((candidate) => candidate.name === plan.team) ?? null;
	// The gate is re-run on every path EXCEPT the one that already passed it as a
	// release (its `writerGate` genuinely refuses — that refusal is what the release
	// relaxes, and re-running it here would refuse the very write it authorized).
	if (existing !== null && release === null) {
		const gate = withLiveGateDiagnostic(ctx, roleOf(existing, COORDINATOR_ROLE), writerGate(existing, coordinatorId));
		if (gate.error !== undefined) return { error: gate.error };
	}
	const byRole = new Map(plan.sessions.filter((entry) => !entry.skip).map((entry) => [entry.role, entry.sessionId]));
	const now = Date.now();
	const applied = applyTeamUpsert(view.teams, { name: plan.team, workspace: cwd, now, coordinator: coordinatorId });
	let team = applied.team;
	// ---- §10.2.8.9 ② 写时复检（TOCTOU）-----------------------------------------
	// The verdict was taken BEFORE the dialog; the human may have taken minutes to
	// answer it, and the incumbent may have come back in that window. Re-take BOTH
	// host readings one line before the write, plus the local liveness reading the
	// §11.9.4 ladder uses — any of the three going stale aborts with ZERO writes.
	let released = null;
	if (release !== null) {
		const recheck = await teamSessionReleaseVerdict(ctx, release.incumbent);
		const stillIncumbent = (roleOf(team, COORDINATOR_ROLE)?.current ?? null) === release.incumbent;
		const revived = agentIsLive(ctx, release.incumbent);
		if (recheck.release !== true || !stillIncumbent || revived) {
			const causes = [
				recheck.release === true ? null : "宿主读数已不再确证「已归档 / 已不存在」",
				stillIncumbent ? null : `coordinator 现任已不是 ${release.incumbent}`,
				revived ? `${release.incumbent} 已有活动代理（已复活）` : null,
			].filter((cause) => cause !== null);
			// `releaseAborted` is read by the handler: the batch's AUTHORIZATION basis was the
			// release, so when it aborts the caller is NOT the incumbent — the pair grant must
			// not happen either (a trust write by a non-incumbent is exactly what §3.4's
			// delivery gate exists to prevent).
			return { error: `释放并认领中止（§10.2.8.9 ② 写时复检）：${causes.join("；")} ⇒ 本次**零写入**（未释放、未认领、未登记新角色，也不写信任通道）。已创建的会话照 §10.2.5 保留；请重发命令（那时现任若确实回不来会重新放行），或走 §11.9 的恢复梯子。`, releaseAborted: true };
		}
		team = applyTeamSessionRelease(team, coordinatorId, recheck.reason, now);
		released = recheck.reason;
	}
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
	return { team, added, created: applied.created, released, mirror };
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
export function createCommandsSeam(ctx, commandNames) {
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

/** §10.2.8.10 ①: the caller's receipt is ONE line, capped — the same order of
 * magnitude as the dialog's `question` (120 code points). */
export const TEAM_SESSION_RECEIPT_MAX_POINTS = 120;
/** The fixed tail of a FAILURE receipt. It is what keeps the cap from eating the
 * outlet: the receipt is short by construction, and the full cause + 出路 stay in
 * the command output of the same turn (channel 1 — 真机已核实那条也在屏上). */
export const TEAM_SESSION_RECEIPT_FAILURE_TAIL = "（原因与出路见本回合命令输出）";

/**
 * The plain reason inside a command result: \`<label> /<cmd>[ 失败]：<…>\` minus the
 * prefix it always carries. Deriving it (instead of threading a second copy of the
 * same sentence through every return) is what makes the receipt honest by
 * construction — a NEW failure branch added later cannot forget to fill it in.
 */
export function teamSessionReceiptReason(text) {
	const raw = String(text ?? "");
	const plain = `${PLUGIN_LABEL} /${TEAM_SESSION_COMMAND}：`;
	const failure = `${PLUGIN_LABEL} /${TEAM_SESSION_COMMAND} 失败：`;
	const after = raw.startsWith(failure) ? raw.slice(failure.length) : raw.startsWith(plain) ? raw.slice(plain.length) : raw;
	return after;
}

/** A result's receipt reading: an EXPLICIT one when the branch carries the counts
 * (success / cancel / partial batch), otherwise derived from the result itself —
 * `kind: "error"` is a failure receipt, `"success"` without an explicit receipt is
 * the idempotent 「无需创建」 branch and would be a bug, so it is NOT silently
 * turned into a completion claim: it falls back to a failure-shaped note. */
export function teamSessionReceiptOf(settled) {
	if (settled !== undefined && settled !== null && settled.receipt !== undefined) return settled.receipt;
	const kind = settled === undefined || settled === null ? "error" : settled.kind;
	const reason = teamSessionReceiptReason(settled === undefined || settled === null ? "" : settled.text);
	return kind === "success" ? { state: "error", reason: `结算异常：成功结果没有带团队读数（${reason}）` } : { state: "error", reason };
}

/** §10.2.8.10 ①'s one line, in the three states, with the team name only when it was
 * really resolved (a pre-parse failure has none and must not get one stuffed in). */
export function teamSessionReceiptText(receipt) {
	const label = `/${TEAM_SESSION_COMMAND}`;
	if (receipt.state === "success") {
		const wake = (receipt.minimalWake ?? 0) > 0 ? `（其中最小唤醒 ${receipt.minimalWake} 个）` : "";
		// §10.2.8.9 ② 空批角（评审 round-1 🟡#1）：确证了失联证据却**没有落笔**时，回执也要说
		// 这一句 —— 否则「完成：新建 0 个」会被读成「接管完成了」。
		const note = typeof receipt.note === "string" && receipt.note !== "" ? receipt.note : "";
		const counts = `新建 ${receipt.created ?? 0} 个${wake}`;
		return receipt.team === undefined ? `${label} 完成：${counts}${note}` : `${label} 完成：团队 ${receipt.team}，${counts}${note}`;
	}
	if (receipt.state === "cancel") {
		return receipt.team === undefined ? `${label} 已取消（零创建、零 pairs）` : `${label} 已取消：团队 ${receipt.team}（零创建、零 pairs）`;
	}
	const head = receipt.team === undefined
		? `${label} 失败：`
		: `${label} 失败：团队 ${dialogField(receipt.team, TEAM_SESSION_DIALOG_FIELD_CHARS.team)}，`;
	const room = TEAM_SESSION_RECEIPT_MAX_POINTS - dialogCodePoints(head) - dialogCodePoints(TEAM_SESSION_RECEIPT_FAILURE_TAIL);
	return `${head}${dialogField(receipt.reason ?? "未给出原因", Math.max(12, room))}${TEAM_SESSION_RECEIPT_FAILURE_TAIL}`;
}

/**
 * §10.2.8.10 ① (通道 4): hand the CALLING session its receipt, once, through the
 * SAME three-member envelope every other driven relay uses
 * ({@link relayUserMessage}, sender = the caller itself).
 *
 * `followup` — not `inject` — on purpose: the whole point is that the caller gets
 * a TURN, which is what makes an otherwise-empty coordinator session visible in
 * the sidebar (真机观察 2/3). The message is for the caller's NEXT turn, so it
 * lands after this turn's `command/done` by construction.
 *
 * Both degradations leave a line (§5.3's red line): no caller session to deliver
 * to at all, or a `followup` that throws. The command itself has ALREADY settled
 * by then — the receipt is a durability/visibility extra, never a second verdict.
 */
export async function deliverTeamSessionReceipt(ctx, invocation, settled) {
	const agent = invocation === undefined || invocation === null ? undefined : invocation.agent;
	const id = typeof agent?.id === "string" && agent.id !== "" ? agent.id : undefined;
	if (id === undefined || typeof agent?.followup !== "function") {
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: /${TEAM_SESSION_COMMAND} 的调用方回执未投递（当前命令没有可交互的活动代理 ⇒ 没有可投的调用方会话）`);
		return;
	}
	try {
		agent.followup(relayUserMessage(teamSessionReceiptText(teamSessionReceiptOf(settled)), id));
	} catch (error) {
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: /${TEAM_SESSION_COMMAND} 的调用方回执投递失败（${describeError(error)}）——命令本身已按上面的结果结算，缺的只是调用方会话里那条耐久回执。`);
	}
}

/**
 * `apply`'s §10.2 entry point: register `/team_session` through the shared
 * optional `commands` seam (§10.2.1).
 */
export function registerTeamSessionCommand(ctx, policy, rotation, controller, seam, watchdog, sections = null) {
	seam.add({
		name: TEAM_SESSION_COMMAND,
		build: () => ({
			name: TEAM_SESSION_COMMAND,
			description: `§10.2 自动建队：一条命令创建 N 个 worker 根会话（N ≤ ${TEAM_SESSION_MAX_CREATES}，每队成员 ≤ ${TEAM_SESSION_MAX_MEMBERS}，均为代码常量）→ 创建完成后用 followup 投递启动任务 → 按 role 幂等登记进 roster → 与主会话建立 pairs 双向免确认通道（§10.2.3 选项 (i)，写入前有一次批量确认框）。文法（§10.2.8.2「参数可省」）：参数区只在行首，从行首连续读 key=value；遇到第一个不含 = 的 token 起，其后全部文本就是正文 = 启动任务（与 task= 等价，两处同现即报错）。位置角色名已废除 —— 声明角色只能写 roles=<r1,r2,…>（别名 role=）。默认：team 取调用会话工作区目录名＋当天日期（basename(cwd)-YYYYMMDD，不合 [a-z0-9-]+ 回退 default-YYYYMMDD，日期取命令执行当天本地时区）、n 省略时 1（给了 roles= 时为角色数）、roles 省略时 1 个 worker（worker-1）。task= 的取值含空格（一直读到下一个 key= 或行尾，整段也可加一对引号）。取消确认框 → 零创建零 pairs。`,
			// The descriptor carries only a hint (CommandInputDescriptor) plus the
			// fact that this grammar cannot use attachments: the handler owns every
			// further decision on the free-form input.
			input: { hint: `[n=<1..${TEAM_SESSION_MAX_CREATES}>] [team=<name>] [roles=<r1,r2,…>] [task=<一句话任务>] [preset=<presetId>] [model=<provider>/<model>] [正文…]`, attachments: false },
			recordInput: true,
			// §10.2.8.10 ①（通道 4）: the handler is a thin settle layer — the batch body
			// below computes `{kind, text}` exactly as before (plus the receipt readings a
			// few branches carry), and this layer hands the CALLING session its one-line
			// receipt before returning. The receipt is a `followup` (a message for the
			// caller's NEXT turn), so 「它在 `command/done` 之后落盘」 is structural rather
			// than a timing assumption.
			handler: async (invocation) => {
				const settled = await (async () => {
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
					// §10.2.8.2 / §10.2.8.9 ①'s default: `team` omitted ⇒ the CALLING session's
					// workspace directory name + the day (`basename(cwd)-YYYYMMDD`; an illegal
					// directory name falls back to `default-YYYYMMDD`). Resolved
					// HERE because this is the first place the cwd is known — the parser is a pure
					// function of the raw line and has no session, and the roster lookup below must
					// search the SAME name this plan will seat the batch under. This single call is
					// also where the day is taken: one command reads the date exactly once.
					const teamName = typeof parsed.value.team === "string" && parsed.value.team.trim() !== "" ? parsed.value.team.trim() : teamSessionDefaultTeam(cwd);
					const existing = view.teams.find((candidate) => candidate.name === teamName) ?? null;
					const seated = existing === null ? [] : existing.roles.map((entry) => entry.role);
					const planned = teamSessionPlan({ ...parsed.value, team: teamName }, seated, Date.now());
					if (planned.error !== undefined) return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_SESSION_COMMAND}：${planned.error}` };
					const plan = planned.value;
					// §10.2.8.9 ②: an EXISTING team still passes the SAME `writerGate` — the one
					// narrow relaxation sits BEHIND that refusal, never in front of it. The probe
					// runs ONLY when the gate refused (i.e. the caller is not the incumbent) AND
					// the seat is taken: a passing gate, a vacant seat and `writer=any` never read
					// the two host faces at all (「现任本人零探测」 —— 缺证据时连证据都不取).
					let release = null;
					if (existing !== null) {
						const coordinator = roleOf(existing, COORDINATOR_ROLE);
						const gate = withLiveGateDiagnostic(ctx, coordinator, writerGate(existing, coordinatorId));
						if (gate.error !== undefined) {
							const incumbent = coordinator === null ? null : coordinator.current;
							const verdict = await teamSessionReleaseVerdict(ctx, incumbent);
							if (verdict.release !== true) return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_SESSION_COMMAND}：${gate.error}${verdict.note}` };
							release = { reason: verdict.reason, incumbent };
						}
					}
					if (plan.creating.length === 0) {
						// §10.2.8.10 ①: the idempotent branch is a SUCCESS and still gets a
						// receipt — the caller session needs its turn even when nothing was built.
						//
						// §10.2.8.9 ② 的**空批角**（评审 round-1 🟡#1）：`release` 这时**已经确证**
						// （证据门跑过了），但本次没有任何要创建/登记的角色 ⇒ 没有落笔的理由 ——
						// 而「静默什么都不说」会让用户以为接管完成了，实际现任仍是那个失联旧任。
						// 所以这一支把两件事**都说出来**：证据已确证、本次**未**释放未认领、下一步怎么走。
						// （为什么不在空批上直接释放：释放是一次**身份写入**，§10.2.4 要求它必经确认框，
						// 而这条框的内容是「将创建 N 个…」；在空批上造一条只有披露的框属设计未定的新形态，
						// 留给用户裁定，不自行发明。）
						const emptyBatchNote = release === null ? "" : `；⚠️ 本次**未释放、未认领**：现任 coordinator 的失联证据已确证（${TEAM_SESSION_RELEASE_NOTES[release.reason]}），但这条命令没有任何要创建/登记的角色 ⇒ 没有落笔的理由。要完成接管，请重发一条带**新角色**的命令（roles= 里加一个没登记过的角色即可），或让现任经 §11.9 的恢复梯子回来。`;
						const emptyBatchReceipt = release === null ? "" : "（现任已确证失联，但本次无可建角色 ⇒ 未释放未认领）";
						return { kind: "success", receipt: { state: "success", team: plan.team, created: 0, minimalWake: 0, note: emptyBatchReceipt }, text: `${PLUGIN_LABEL} /${TEAM_SESSION_COMMAND}：团队 ${plan.team} 已登记本次请求的全部 ${plan.skipped.length} 个角色（按 role 幂等，§10.2.6），无需创建。零创建、零 pairs${emptyBatchNote}。` };
					}
					const dialog = await askTeamSessionBatch(ctx, invocation.agent, plan, teamSessionDialogText(plan, cwd, coordinatorId, release), invocation.signal);
					// §10.2.8.10 ①: 取消**也算一次结算**（零创建零 pairs 是结果之一），所以照样有一次回执
					// ——代价如实记在设计档里：连取消也花调用方一个模型回合。
					if (!dialog.confirmed) return { kind: "success", receipt: { state: "cancel", team: plan.team }, text: `${PLUGIN_LABEL} /${TEAM_SESSION_COMMAND}：${teamSessionNoConfirmText(plan, dialog.reason)}` };
					const outcome = await createTeamSessions(ctx, controller, policy, plan, cwd, coordinatorId);
					const createdRoles = createdTeamSessionRoles(outcome.results).map((entry) => entry.role);
					// DEFECT-4: the titles the title service ACCEPTED, per role — the
					// completion list renders these readings (`undefined` = the naming
					// degraded, and the line above plus the warn say so).
					const titleRows = createdTeamSessionRoles(outcome.results).map((entry) => `${entry.role} → ${entry.title ?? "未设标题"}`);
					const registration = await registerTeamSessionRoles(ctx, policy, plan, cwd, coordinatorId, createdRoles, release);
					// ---- pairs (§10.2.3 (i)): only workers that EXIST get a channel,
					// and the grant happens after the dialog authorized it, never before
					// — so 取消 really is 零创建零 pairs.
					let pairsAdded = 0;
					let pairsError;
					// §10.2.8.9 ② 写时复检中止 ⇒ **整批的授权基础没了**（调用会话不是现任协调者），
					// 所以连信任通道也不写 —— 「零写入」在这条路上必须包含 pairs，否则会出现
					// 「非现任给新会话写了免确认通道」这种自相矛盾的状态。
					const pairsAborted = registration.releaseAborted === true;
					const workerIds = pairsAborted ? [] : outcome.created.map((item) => item.sessionId);
					if (workerIds.length > 0) {
						try {
							const granted = withTeamSessionPairs(policy.get(), coordinatorId, workerIds, Date.now());
							if (granted.added > 0) await policy.update({ pairs: granted.pairs });
							pairsAdded = granted.added;
						} catch (error) {
							pairsError = describeError(error);
						}
					}
					// ---- FR-3a（批 1）: 工作台看门狗 ------------------------------------
					// §10.2.8.9 ② 的零写入纪律**包含 watchdogs**（consult #26 §4.3）：写时复检中止
					// 意味着调用会话不是现任协调者，此时连一条 auto 注册都不给写；roster 登记失败
					// 同样不写（团队名册没落笔 ⇒ 盯谁读不出来）。失败隔离由 armTeamWatchdog 负责 ——
					// 它只回一行读数，绝不把这条命令的成败拖下水。
					// FR-2 注册钩子①的另一半（/team_session 建队）：名册写完之后 worker 才有段 ——
				// 与段控制器无关的部分（失败隔离）不受影响：sync 只读名册 + 活代理表，不写状态。
				sections?.sync();
				const workbench = pairsAborted
						? { error: "本次零写入（§10.2.8.9 ② 写时复检中止）" }
						: registration.error !== undefined
							? { error: `roster 未写入（${registration.error}）` }
							: await armTeamWatchdog(ctx, policy, watchdog, {
								team: plan.team,
								watcherSession: coordinatorId,
								targets: [...teamMembers(policy.get().teams.find((entry) => entry.name === plan.team) ?? { roles: [] }), ...outcome.created.map((item) => item.sessionId)],
								now: Date.now(),
							});
					const lines = [
						`/${TEAM_SESSION_COMMAND} 批量建队完成清单（团队 ${plan.team}，读数 ${readStamp(Date.now())}）：`,
						// §10.2.8.10 ②（默认值第 4 条**反转**）: 每个新建会话都被驱动一次，所以
						// 这一行只剩三种读法 —— 「已投递启动任务」/「已投最小唤醒（本次未给任务）」/
						// 「投递失败」。`driven === undefined` 对**已创建**的行已不可达（驱动循环
						// 不再按 `plan.task` 过滤），所以那一格留着如实说「没有任何驱动路径命中它」，
						// 而不是退回一句会被读成「已经派活了」的话。
						...outcome.results.map((entry) => `- ${entry.role}${entry.sessionId === undefined ? "" : ` → ${entry.sessionId}`}：${entry.ok ? (entry.skipped ? "跳过（已登记）" : entry.driven === undefined ? "已创建（未投递：本次没有任何驱动路径命中它）" : entry.driven === false ? `已创建，${entry.minimalWake === true ? "最小唤醒" : "启动任务"}投递失败` : entry.minimalWake === true ? "已创建 + 已投最小唤醒（本次未给任务）" : "已创建 + 已投递启动任务") : `未创建（${entry.detail}）`}`),
						// DEFECT-4: `entry.title` is what the title service ACCEPTED (see
						// `renameTeamSession`) — a reading, not a recomputation. A row whose
						// naming degraded honestly says so instead of printing the title it
						// would have liked to set.
						`- 标题（DEFECT-4）：${titleRows.length === 0 ? "（本次没有新建会话）" : titleRows.join("、")}（按「<team> · <role>」派生，不再让它们全部显示为工作区名、在侧边栏里互相无法区分；想改随时在壳里重命名）`,
					// §10.2.8.7 裁定 2: the completion REPORT carries the same one-line role guidance as the
					// dialog (the defect-③ box was unreadable, so the sentence answering 「新会话为什么显示
					// 成 worker」 was never seen). One line, like the dialog's.
					`- 角色指引（§10.2.8.7）：${TEAM_SESSION_ROLE_GUIDANCE}`,
						`- roster：${registration.error !== undefined ? `未写入（${registration.error}）` : registration.added.length === 0 ? "无需改动（全部角色已登记）" : `已登记 ${registration.added.length} 个角色：${registration.added.join("、")}${registration.created ? "（团队本次创建，创建者已认领 coordinator）" : registration.released ? `（按 §10.2.8.9 ② 释放并接管原团队：${TEAM_SESSION_RELEASE_NOTES[registration.released]}）` : ""}${registration.mirror === undefined ? "" : `；${mirrorNote(registration.mirror)}`}`}`,
						// FR-4（重钉点②）：完成回报里带一行宪章要点 —— 仅当调用方此刻确实是该队现任协调者。
						...((isIncumbentCoordinator(policy.get(), plan.team, coordinatorId) && sectionsSwitches(policy.get()).role !== false) ? [charterReinforceLine(plan.team)] : []),
						`- pairs：${pairsAborted ? "未建立（§10.2.8.9 ② 写时复检中止：释放没落笔 ⇒ 调用会话不是现任协调者，于是不给任何人写信任通道）" : pairsError === undefined ? `与主会话 ${coordinatorId} 建立/确认 ${pairsAdded} 条双向免确认通道（既有通道不重复写；§10.2.3 (i) 预置配对，未在确认框授权前发生）` : `写入失败（${pairsError}）——后续投递将照走过门确认`}`,
						`- 工作台（FR-3a）：${workbench.error !== undefined ? (workbench.entry !== undefined ? (workbench.armed === true ? `已写入 ${workbench.entry.id}：首挂失败（${workbench.error}），已由 rearm 补上` : `已写入但定时器未挂上 ${workbench.entry.id}（${workbench.error}）——注册已在，下一次挂载（attach / 名册写入）的 rearm 会补上`) : `未注册（${workbench.error}）——建队本身不受影响（失败隔离）`) : workbench.created ? `已自动注册看门狗 ${workbench.entry.id}（origin=auto · 覆盖全队 ${workbench.entry.targets.length} 个成员 · **不占手工额度**；摘要在你 running / armed-active 时照投，同一注册两条至少隔 10min，只在有可行动内容时投）` : `已顺延既有自动注册 ${workbench.entry.id}（覆盖全队 ${workbench.entry.targets.length} 个成员）`}`,
						"保留声明（§10.2.5 / §10.2.6）：已创建的会话一律保留、不回滚——它们已经存在于盘上，可能已被打开；失败即停，不再继续创建后续会话。",
						"生命周期（§10.2.5）：这些会话的 AgentHandle 由插件持有，插件卸载/重载 = 它们的代理随本插件一起拆掉（会话仍在盘上）。重载后 roster 会把「盘上有会话但无活代理」如实标 dead（team_link_list_sessions），在侧边栏逐个打开即可收编，再按 roster 重新登记。",
					];
					if (registration.error !== undefined) lines.push(`→ 补救：用 team_link_roster action=set-role 为上面已创建的会话逐个补登记（团队 ${plan.team}）。`);
					const failed = outcome.results.some((entry) => !entry.ok) || registration.error !== undefined;
					return {
						kind: failed ? "error" : "success",
						// §10.2.8.10 ①: the receipt carries the counts the design pins (新建 N 个，
						// 其中最小唤醒 M 个) — read off the SAME rows the report above renders, so a
						// receipt can never claim a wake the batch did not send.
						receipt: { state: failed ? "error" : "success", team: plan.team, created: createdRoles.length, minimalWake: outcome.results.filter((entry) => entry.minimalWake === true).length, reason: pairsAborted ? "释放并认领中止（现任复活 / 证据变化），本次零写入" : failed ? "批量建队未全部成功" : undefined },
						text: wellFormed(lines.join("\n")),
					};
				} catch (error) {
					return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_SESSION_COMMAND} 失败：${describeError(error)}` };
				}
				})();
				await deliverTeamSessionReceipt(ctx, invocation, settled);
				return { kind: settled.kind, text: settled.text };
			},
		}),
	});
}

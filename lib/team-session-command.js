// ---------------------------------------------------------------------------
// 批 R（上架合规）第 18 小单：§10.2 ② `/team_session` 的命令面（文法 · 解析 · 计划 · 标题）—— 从 `lib/index.js` 原样搬出
// ---------------------------------------------------------------------------
// 归属：docs/2026-10-15-store-compliance-design.md §4 D1/D2/D4 · §5 FR-R1 · §6（拆分契约：只做「移动 + 补
//       export」、无副作用搬家、模块图无环）· §8 Rr1/Rr3/Rr4/Rr8。
// ★ 本档是什么：入口原 4515–5213 行（as-of 本单动手前）的**一整段相邻块**，共 44 条声明（31 条
//   `const` · 11 条 `function` · 1 条 `async function` · 1 条裸 `let TEAM_SESSION_NOW_INJECTED;`）：
//   ① §10.2.1/§10.2.4 的命令文法常量（命令名 · `task=` 字面量 · 唯一键表与两条提示 · 未知键的取值预览
//      · 缺省团队 · 两条上限（N ≤ 8 / 成员 ≤ 24）· 确认框超时 · §10.2.8.4 的四条对话框预算 · id 形状
//      · 逐字段封顶表 · 角色指引 · 对话框 id 与确认按钮文案 · pending TTL · model 形状 · id 净化与后缀）；
//   ② 解析器 `readTeamSessionRoleName` / `readTeamSessionCommand`（§10.2.4 的全文法：行首参数区 ·
//      `task=` 到行尾 · 引号归一 · 未知键拒绝 · 正文与 `task=` 二选一）；
//   ③ 时钟与缺省团队（`teamSessionDay` / U35 的注入缝 `teamSessionInjectNow` / `teamSessionDefaultTeam`）；
//   ④ §10.2.6 的「释放现任」判定与写面（`TEAM_SESSION_RELEASE_NOTES` 的三条理由 · 一句披露 ·
//      `teamSessionReleaseVerdict` · `applyTeamSessionRelease`）；
//   ⑤ 计划 `teamSessionPlan` 与 id `teamSessionId`；
//   ⑥ 标题族（`TEAM_SESSION_TITLE_*` 四个常量 · `utf8ByteLength` / `truncateUtf8` · `teamSessionTitle`）。
//   实测：**44,927 字节**（CRLF 工作树）/ **44,228 字节**（EOL 归一到 LF）/ 699 行 —— 本小单 60 KB 档位
//   上限之内（本档整档 **52,038 字节** / 776 行，同样在上限之内）。
//   机检口径：把本档正文按声明行去掉 `export ` 前缀后，与入口原位置的同一段**逐字节相等**（EOL 归一）；
//   那一段在入口里**零次**。
//   ★ 它是一个**自成一体的块**：文法常量只被本段的解析器与工厂读，计划只被标题与本档外的对话框读，
//     标题族只被计划读；对外只经下面「装配缝」的 3 条入口侧出口与两条相对导入取物。
// ★ 本档**不是**（留给下一小单，逐条点名）：
//   ① 对话框渲染族（`teamSessionDialogText` / `teamSessionDialogQuestion` / `dialogCodePoints` /
//      `dialogFlatten` / `dialogField` / `dialogFits` / 三段裁段标注 / `teamSessionDialogCropNote` /
//      `teamSessionTaskNote` / `teamSessionModelLine`）—— 仍在入口。本单的边界恰在 `teamSessionTitle`
//      的 `}` 之后：`teamSessionDialogText` 的**文档注释留在入口那一侧**（注释与函数不分离 ⇒ 入口侧按
//      `function <名>` 锚点切片的那类文本锁读数不受影响）。
//   ② 被钉的 `buildTeamSessionCreateOptions` 与 `relayUserMessage` —— **只注入不搬**（本档对它们零次引用）；
//   ③ `buildTeamSessionResumeOptions` / `resolveTeamSessionModelSelection` / `registerTeamSessionRoles` /
//      回执族（`TEAM_SESSION_RECEIPT_*` / `teamSessionReceipt*` / `deliverTeamSessionReceipt`）/
//      `createCommandsSeam` / `registerTeamSessionCommand` —— 仍在入口。
// ★ 依赖方向（Rr4「模块图无环」）：本档**不导入入口** `lib/index.js`（那会构成 ESM 环，实跑当场 TDZ）——
//   ① 内部相对导入 **2 条**：`./rotation.js`（`closeTenure` / `roleOf`）· `./shared.js`
//      （`COORDINATOR_ROLE` / `describeError` / `preview`）；
//   ② 装配缝注入 **3 条**：`TEAM_NAME_RE` / `readTeamName` / `readRoleName`（三条都仍在入口 —— 团队名与
//      角色名的读取器是名册与形态域共用的基础助手，本单只搬「用到它们的那一段」）。
//   两类出边**都不回指入口或本档** ⇒ 本单**不新增环**。
// ★ 宿主导入 **2 条**：`node:crypto` 的 `randomUUID`、`node:path` 的默认导出 —— 两个说明符本来就在那
//   8 条白名单里 ⇒ `Rr3` 的**集合**读数一字不变。
// ★ 被钉符号核对（本仓 `hostSource` 文本锁钉住的 9 个：`writePolicyFileAtomic` / `renameThroughSeam` /
//   `POLICY_FILE_SCHEMA` / `WATCHDOG_DIGEST_DEBOUNCE_MS` / `TICKABLE_VERDICTS` / `agentStateLabel` /
//   `writerGate` / `relayUserMessage` / `buildTeamSessionCreateOptions`）：**本单一个都没搬**，九个仍逐字节
//   住在入口（定义、文档注释与锚点切片位置一字不动 ⇒ 那几条源码锁读数不变）；**被搬的那段正文**对它
//   们零引用（连注释里都不出现 —— 只有本段档头的这张核对表点名它们）。
// ★ 搬运纪律（D4）：本档新增的只有 ① 本段档头 ② 2 条 import 语句 ③ 装配缝 ④ 28 条声明行上的 `export `
//   前缀；其余（含全部行内注释、嵌套函数与中文文案）**一个字符都没动**。
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import path from "node:path";

import { closeTenure, roleOf } from "./rotation.js";
import { COORDINATOR_ROLE, describeError, preview } from "./shared.js";

// ---------------------------------------------------------------------------
// 装配缝 · `wireTeamSessionCommand(extras)`（先例：`lib/forensics.js` 的 `wireForensics()`）
// ---------------------------------------------------------------------------
// 前置：入口在**模块求值**时调用一次（`lib/index.js` 模块尾部，紧挨 `wireHandover(…)`），给出的 3 个键
//       与被注入的绑定**同名同值**。
// 后置：本档的三个模块级 `let` 全部绑定到入口那一份真实现；此后文法解析 / 计划 / 提示与标题读到的都是它。
// 为什么不是 import：见档头「依赖方向」（入口 → 域档会成环）。
// 为什么是一次性绑定而不是每次调用现取：绑定之后被搬函数体内的裸名**逐字节保留**（只在函数体外加了
// 这一个缝），D4 的逐字节等价可以直接机检。
// ---------------------------------------------------------------------------
let TEAM_NAME_RE, readTeamName, readRoleName;

/** 入口侧出口的一次性绑定（见本节档头的前置 / 后置）。 */
export function wireTeamSessionCommand(extras) {
	({
		TEAM_NAME_RE,
		readTeamName,
		readRoleName,
	} = extras);
}

/**
 * Slash-command name of §10.2.1 (without the leading slash). The command is
 * registered through the OPTIONAL ordered injection of the `commands` service
 * (§10.2.1): this plugin's module-level `inject` stays at its four entries, and
 * a shell without that service loads the plugin unchanged — minus this one
 * command — with a single warn line.
 */
export const TEAM_SESSION_COMMAND = "team_session";
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
export const TEAM_SESSION_MAX_CREATES = 8;
/** §10.2.4 per-team member ceiling (≤ 24), also a code constant — the same
 * number the §10.1.2 receipt caps its rendered rows at. */
export const TEAM_SESSION_MAX_MEMBERS = 24;
/** How long the one batch confirmation waits for a present user before the
 * command gives up and creates NOTHING (§10.2.4 / U16: 取消 → 零创建零 pairs). */
export const TEAM_SESSION_CONFIRM_TIMEOUT_MS = 180000;
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
export const TEAM_SESSION_DIALOG_MAX_CODE_POINTS = 600;
export const TEAM_SESSION_DIALOG_MAX_NEWLINES = 12;
/** §10.2.8.4 修法表**第 0 行**的第二个预算：确认框 `question` 的**单行**上限（码点）。
 * 依据是壳的布局、不是偏好 —— `question` 被渲进**无高度钳制的 `<header><h2>`**（在滚动容器
 * **之外**），而 `detail` 在 `Mbwy4a_body{overflow-y:auto}` **之内**、底栏 `flex-shrink:0` 也在
 * 滚动区外 ⇒ 长 `question` 推出视野的正是底部的「创建 / 取消」（真机事实：§10.2.8.0 的 8 次
 * 够不着）。所以 question 只留一行话，披露正文整段进 detail。 */
export const TEAM_SESSION_DIALOG_MAX_QUESTION_POINTS = 120;
/** §10.2.8.4 (b): session-list rows shown before 「…等 N 个」. The FULL count is always
 * stated — the U13/U14 bounded-presentation convention. */
export const TEAM_SESSION_DIALOG_LIST_ROWS = 3;
/** §10.2.8.4 (b): 「**不逐角色展开**：只给 **id 形状 ＋ 计数**，全量清单进完成回报」.
 * This is the CONSTANT half of {@link teamSessionId}'s grammar — ONE stem for the whole
 * batch, so it costs the dialog the same few code points for EVERY input while still
 * telling the reader which ids the confirmation is about; the per-role id list itself is
 * the completion report's job (`command/done`). */
export const TEAM_SESSION_ID_SHAPE = "team-link-<team>-<role>-<uuid8>";
/** §10.2.8.4 (a): how much of the startup task the dialog previews, in code points.
 * The preview line also carries the annotation that says the full text will be
 * delivered regardless ({@link teamSessionTaskNote}). */
export const TEAM_SESSION_DIALOG_TASK_CHARS = 32;
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
export const TEAM_SESSION_DIALOG_FIELD_CHARS = { team: 32, cwd: 24, id: 28, role: 8, skipped: 16, title: 40, model: 40, provider: 24, preset: 24 };
/** §10.2.8.7 裁定 2: the role-semantics line the DIALOG and the COMPLETION REPORT each
 * carry. It exists because the defect-③ dialog was unreadable, so the sentence that
 * answered 「为什么新会话显示是 worker」 was never seen; it is one line on purpose and
 * it is inside {@link TEAM_SESSION_DIALOG_MAX_CODE_POINTS}. */
export const TEAM_SESSION_ROLE_GUIDANCE = "新会话是 worker；你自己（调用会话）是 coordinator；要交棒请用 team_link_rotate。";
/** Question id of the batch dialog — the answer is matched by id, not order. */
export const TEAM_SESSION_DIALOG_ID = "team-session-batch";
/** The one option label that authorizes the batch (§10.3: 批量动作必须有一处人类确认). */
export const TEAM_SESSION_CONFIRM_LABEL = "创建";
/** §10.2.6 orphan guard: how long a `pending-creates` intent may sit unresolved
 * before the startup sweep reports it as adoptable (the create crashed, or the
 * plugin was unloaded mid-loop). */
export const TEAM_SESSION_PENDING_TTL_MS = 5 * 60000;
/** The `model` argument's grammar: `model=<provider>/<model>` or bare `model=<model>`. */
const TEAM_SESSION_MODEL_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.:-]+)$/u;
/** Session-id code points outside this class are dropped, so an id can never
 * carry a lone surrogate or a control character into the durable session id. */
export const TEAM_SESSION_ID_ILLEGAL = /[^A-Za-z0-9_-]/gu;
/** Session-id suffix length (8 hex characters of one random UUID). */
export const TEAM_SESSION_ID_SUFFIX = 8;

/**
 * Live §10.2 ② controller of each plugin context. `apply` is the only writer;
 * `host-half.test.mjs` reads it (through {@link __testing}) so the command's
 * per-context intent bookkeeping is reachable without poking closure state.
 */
export const TEAM_SESSION_BY_CTX = new WeakMap();

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
 * **默认值**（方案 A 的必然结果）：`team` 省略 ⇒ 取**调用会话工作区目录名＋当天日期**
 * （{@link teamSessionDefaultTeam}：`basename(cwd)-YYYYMMDD`，不合 `[a-z0-9-]+` 时回退
 * `default-YYYYMMDD`；日期取命令执行当天本地时区、一条命令只取一次 —— §10.2.8.9 ①）· `n` 省略 ⇒ `1`（给了 `roles=` 时 = 角色数）· `roles` 省略 ⇒ 1 个
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
export function readTeamSessionCommand(rawInput) {
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
 * §10.2.8.9 ①'s day stamp: `YYYYMMDD` of the day the command runs, in the LOCAL
 * timezone (「命令执行当天」 is the day the human is on, not UTC's). The default
 * name reads it in ONE place and the handler resolves the default exactly once
 * per command ⇒ one command takes the date once, so a line sent at 23:59:59
 * cannot name two different days (跨午夜自洽).
 *
 * `now` and {@link teamSessionInjectNow} are the U35 fixture seam: tests inject
 * 「当天」 and never read the wall clock.
 */
function teamSessionDay(now) {
	const date = new Date(now ?? TEAM_SESSION_NOW_INJECTED ?? Date.now());
	const pad = (value) => String(value).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/**
 * U35 test seam: inject 「当天」 (a timestamp) so fixtures pin the day without the
 * wall clock; pass `undefined`/`null` to restore the real clock. ONLY the default
 * team name reads this — sweep/plan clocks stay on `Date.now()`.
 */
let TEAM_SESSION_NOW_INJECTED;
export function teamSessionInjectNow(now) {
	TEAM_SESSION_NOW_INJECTED = now === undefined || now === null ? undefined : Number(now);
}

/**
 * §10.2.8.2 / §10.2.8.9 ①'s DEFAULT team name: `<basename(cwd)>-YYYYMMDD` — the
 * CALLING session's workspace directory name plus the day (same day ⇒ same team,
 * a new day ⇒ naturally a new team). `basename(cwd)` is the only path part read
 * here (a path is not a team name) and never `process.cwd()` (this half runs in
 * the host process, and the fact we are after belongs to the caller's session).
 *
 * A directory name that is not a legal team name (`[a-z0-9-]+` — the same rule
 * {@link readTeamName} enforces, because a team name is a path segment of the
 * blackboard directory) falls back to `default-YYYYMMDD` instead of being refused:
 * the user did not TYPE this value, so refusing the whole command over a directory
 * name would be refusing a decision they never made. (Undated existing teams stay
 * fully valid — they are reachable only through an explicit `team=`; the default
 * name never resolves to them again and nothing migrates, §10.2.8.9 ①.)
 */
export function teamSessionDefaultTeam(cwd, now) {
	const base = typeof cwd === "string" ? path.basename(cwd.trim()) : "";
	const stem = TEAM_NAME_RE.test(base) ? base : TEAM_SESSION_DEFAULT_TEAM;
	return `${stem}-${teamSessionDay(now)}`;
}

/**
 * §10.2.8.9 ②: the two reasons that release a team name, written VERBATIM into the
 * outgoing coordinator's version history (`until=now`). One vocabulary in one
 * place: the fixtures assert these exact strings and the completion report quotes
 * the same key, so the note a reader sees and the note a test greps cannot drift.
 */
export const TEAM_SESSION_RELEASE_NOTES = {
	archived: "released: coordinator archived",
	gone: "released: coordinator gone",
};

/** §10.2.8.9 ②'s release disclosure, folded into the dialog's 「确认则」 line. The
 * design pins this exact short form and calls it 「12 码点」; 逐字数是 **11**
 * （（将释放并接管原团队）—— 计数笔误已记入交付报告，判据按字面量钉 11、以 12 为口径上界）。
 * The longer wordings (21+ code points) break the U33c budget, and a line of its own
 * breaks the ≤6-line bound — so the SHAPE is 「同一个 11 码点短句，折在 pairs 之后」. */
export const TEAM_SESSION_RELEASE_DISCLOSURE = "（将释放并接管原团队）";

/**
 * §10.2.8.9 ②'s evidence door: is the team's CURRENT coordinator session archived,
 * or gone? Both are HOST readings, and the two failure shapes are kept apart on
 * purpose (审计 #6 / the design's 硬约束) — mixing them is exactly the mutation the
 * fixtures turn red:
 *
 *   - **甲 · 服务未提供** (`ctx.get("workspaceRegistry")` absent, or not a service
 *     object) ⇒ the archive signal is **skipped** and only `gone` decides. A
 *     missing signal is **never** read as 「未归档」;
 *   - **乙 · 服务提供了但读不到** (the getter throws, or `archivedSessionIds` is
 *     not an array) ⇒ `unknown` ⇒ **refuse, before the gone probe runs**, so the
 *     two shapes cannot contaminate each other.
 *
 * Only POSITIVE evidence releases: `archived === true`, or the id filter coming
 * back empty (`gone`: 「被删除」and「从未存在」are indistinguishable host-side and
 * are judged the same on purpose — §10.2.8.9 ②).
 *
 * @returns `{ release: true, reason: "archived"|"gone" }` or
 *   `{ release: false, note }` — `note` is non-empty ONLY when the refusal has
 *   something to disclose (a signal that could not be read, or a degraded 甲 read);
 *   affirmative aliveness (`archived === false` and the session still exists) comes
 *   back byte-clean so the pre-existing refusal text stays verbatim (U17).
 */
export async function teamSessionReleaseVerdict(ctx, incumbent) {
	if (typeof incumbent !== "string" || incumbent === "") return { release: false, note: "" };
	let archived;                          // true | false | undefined（信号不可用）
	let signal = "ok";                     // "ok" | "absent"
	const registry = ctx !== undefined && typeof ctx.get === "function" ? ctx.get("workspaceRegistry") : undefined;
	if (registry === undefined || registry === null || typeof registry !== "object") {
		signal = "absent";
	} else {
		try {
			const ids = registry.archivedSessionIds;
			if (!Array.isArray(ids)) {
				return { release: false, note: "（宿主 workspaceRegistry.archivedSessionIds 不是数组 ⇒ 归档信号读不出，本次不按「已归档」放行）" };
			}
			archived = ids.includes(incumbent);
		} catch (error) {
			return { release: false, note: `（宿主 workspaceRegistry.archivedSessionIds 读取失败：${describeError(error)} ⇒ 归档信号读不出，本次不按「已归档」放行）` };
		}
	}
	if (archived === true) return { release: true, reason: "archived" };
	const query = ctx === undefined || ctx === null ? undefined : ctx.sessionQuery;
	if (query === undefined || query === null || typeof query.filterSessions !== "function") {
		return { release: false, note: "（sessionQuery.filterSessions 不可用 ⇒ 两条宿主读数都取不到，本次不放行）" };
	}
	let rows;
	try {
		rows = await query.filterSessions([{ kind: "id", values: [incumbent] }]);
	} catch (error) {
		return { release: false, note: `（会话是否存在读取失败：${describeError(error)} ⇒ 本次不放行）` };
	}
	if (!Array.isArray(rows)) return { release: false, note: "（sessionQuery.filterSessions 返回的不是会话数组 ⇒ 本次不放行）" };
	if (rows.length === 0) return { release: true, reason: "gone" };
	return {
		release: false,
		note: signal === "absent" ? "（宿主没有 workspaceRegistry 服务 ⇒ 归档信号缺席，本次只按「会话已不存在」判，而该会话仍在）" : "",
	};
}

/**
 * §10.2.8.9 ②'s action, once and in this order: close the incumbent's tenure with
 * the reason note, then seat the CALLING session as the new coordinator.
 *
 * Every OTHER role row comes back byte-identical (裁定 a「保留历史」的**唯一**断言
 * 面), the closed tenure keeps its `from`, and the new open record carries no note
 * of its own: like {@link applySetRole}, the note belongs to the hand-over it
 * describes. `policy` is never touched — the gate stays `coordinator` and is not
 * widened to `any` (边界⑤).
 */
export function applyTeamSessionRelease(team, caller, reason, now) {
	const entry = roleOf(team, COORDINATOR_ROLE);
	if (entry === null) return team;
	const history = entry.history.map((record) => ({ ...record }));
	closeTenure(history, entry.current, now, TEAM_SESSION_RELEASE_NOTES[reason]);
	history.push({ session: caller, from: now, until: null });
	const coordinator = { ...entry, current: caller, history };
	return { ...team, roles: team.roles.map((row) => (row.role === COORDINATOR_ROLE ? coordinator : row)) };
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
export function teamSessionPlan(request, existingRoles = [], now = Date.now(), uuid = () => randomUUID()) {
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
export function teamSessionId(team, role, uuid) {
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
export function teamSessionTitle(plan, entry) {
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

// ---------------------------------------------------------------------------
// 域档：黑板与台账 —— 批 R（上架合规）从 `lib/index.js` 原样搬出
// ---------------------------------------------------------------------------
// 归属：docs/2026-10-15-store-compliance-design.md §4 D1/D2/D4 · §5 FR-R1 · §6（拆分契约：
//       模块间只走相对导入、无环、搬运零行为变更）· §8 Rr1/Rr3/Rr4。
// 黑板三档自己的设计档（逐个点名，便于回查）：`decisions.md` / `discipline.md` 的目录约定
//       与乐观锁见 docs/team-upgrade-design-2026-09-17.md 的 §3.3.1/§3.3.3；`tasks.md` 台账
//       （任务号分配、派生视图、读面窗口）见 docs/team-ledger-and-mode-design-2026-09-26.md
//       的 §9.2/§9.3；迁移表门 `ledgerTransitionGate` 的权威规格是跨仓档
//       `docs/2026-10-14-anti-drift-design.md` 的 §5 FR-7（本仓只在代码注释里引用它）。
//
// ★ 域边界（本小单划定的口径，逐条可核）：本档只承载**黑板文件的内容层** ——
//   路径解析 / 读文件 / 行切分 / seq 计数 / 单行上限校验 / 行构造 / 台账解析与派生视图 / 渲染。
//   **不含**三样（都属于别的域；③ 的分界依据是实测的导入闭包，不是口味）：
//     ① `roster.md` 镜像（`renderRosterMirror` / `writeRosterMirror` / `mirrorNote`）—— 它镜像的
//        是名册，属「名册与状态落点」域；
//     ② 两个黑板书工具的注册体（`registerTeamTools` 里那一段）—— 属「工具注册」域；
//     ③ `team_link_team_read` 的「收件视图 / 派生回执」那一族渲染助手 —— 实测其闭包会拉进
//        `textOf` / `PREVIEW_SESSIONS` / `SEND_CARD_KIND` / `SEND_CARD_VERSION` ⇒ 属「投递」域。
//   `blackboardPaths` 仍返回四条路径（含 `roster.md`）—— 那是它的既有返回形状，一字未动。
// ★ 搬运纪律（D4）：**符号定义与其文档注释逐字节原样** —— 只加 `export` 与下面那几行导入；
//   一行逻辑 / 文案 / 判据都没有改（机械性由两套件全绿背书）。
// ★ 对外契约（D2）：入口仍是 `lib/index.js`（`package.json` 的 `main` / `exports` 一字未动），
//   它从这里 `import` 后把同一批名字交给同一批调用点（含 `__testing` 里那四个：
//   `readBlackboardLine` / `blackboardHash` / `lastDecisionSeq` / `decisionRow`）⇒ 对外名字 /
//   签名 / 语义逐字不变。
// ★ 无环（Rr4）：本档对入口**零导入**；只依赖 `./shared.js` 与三条**既有白名单**宿主说明符。
//   模块图单向：入口 → 本档 → 共享档。
// ★ 宿主依赖面（Rr3）：`node:crypto` / `node:fs/promises` / `node:path` 三条都在既有八条白名单里
//   （与入口那几行同形），内部相对导入不计入 ⇒ 汇总出来的宿主说明符仍恰为那 8 个。
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
// ★ 共享物（设计档 §6「边界规则」）从共享档取用，而不是从入口取（那会成环）：
//   `agentSessionId` 用于 `blackboardAuthor` · `describeError` 用于 `readBlackboardFile` ·
//   `localStamp` 与 `preview` 用于 `taskStamp`（后两者的入边全在本档内）。
import { agentSessionId, describeError, localStamp, preview } from "./shared.js";

/** Blackboard directory (inside a team's captured workspace) and its files. */
export const TEAM_DIR = "team";
export const ROSTER_MIRROR_FILE = "roster.md";
export const DECISIONS_FILE = "decisions.md";
export const DISCIPLINE_FILE = "discipline.md";
/** The third blackboard file (design §9.3.1 of
 * `docs/team-ledger-and-mode-design-2026-09-26.md`): the first one that is neither a
 * lockable document nor a ledger of VERDICTS but a ledger of **claims** — append
 * only, one row per claim, and the "current state" derived at read time. Its rows
 * carry a `kind` and a `task` column the other two files do not have (§9.3.1). */
export const TASKS_FILE = "tasks.md";
/** The `file` argument is a closed set (§4.1) — never a caller-supplied path. */
export const BLACKBOARD_FILES = new Set(["decisions", "discipline", "tasks"]);
/** §4.1: one blackboard line may not exceed this many characters, counted in
 * code points so an astral character costs one (the `preview` convention).
 *
 * 取值依据（批 F·甲，2026-10-11 —— 别只留个数字）：取证里 `team_link_team_append`
 * 的失败样本实测长 **402–639** 码点（29 次 `MALFORMED_RESPONSE` 里 **15 次**出在这个
 * 工具上，失败前的模型思考逐字是「Need to trim the text to 500 characters or less.」
 * ⇒ **「删改」这个动作本身就是漏出框定 token 的高发动作**）。**2000 ≈ 观测最大值 ×3**，
 * 同时仍在「单行读得下去」的量级 ⇒ 上限的**存在意义**（有界单行）不变。曾为 500。
 *
 * ★ 与两个**同名数值无关，改动时别混同**（评审 🔵#9）：
 *   · `team_link_send` **正文**的 2000/2001 边界（**另一机制**：跨会话消息正文的截断
 *     阈值，本批不动 —— 见 {@link SEND_MESSAGE_HEAD_CHARS} 那一段的头 1500 + 标记 + 尾 400）；
 *   · `TASKS_PROJECTION_SCAN = 500`（派生读数的**扫描窗口** —— 它是**读**的窗口，
 *     不是写入上限，本批不动）。
 *   本批只改**黑板单行的写入上限**这一个常量，且必须同批改准描述面（工具 `description` /
 *   `line` 参数说明 / `README.md`）与判据面（`host-half.test.mjs` 里钉这个上限的两族断言）。 */
export const BLACKBOARD_LINE_LIMIT = 2000;
/** Trailing decisions returned by one `team_link_team_read` (§3.3.3, K = 20). */
export const DECISIONS_WINDOW = 20;
/** Trailing task rows returned by one `team_link_team_read` (§9.3.3: the same
 * window shape as the decisions ledger). Deliberately a SEPARATE constant even
 * though the value matches: the two ledgers count in their own space (§9.3.1),
 * so one window must never be able to move the other. */
export const TASKS_WINDOW = 20;
/** How far back the §9.3.4 derived view scans. The raw window above is what a
 * reader SEES; this is what the derivation is computed from — and, because the
 * two are different sizes, the read face says so out loud whenever a file is
 * longer than this (§9.3.3 边界: "更早的 N 行未参与派生"). */
export const TASKS_PROJECTION_SCAN = 500;

/** §9.3.1 the CLOSED set of `kind` values a tasks row may carry. Closed, not
 * advisory: §9.3.4's derived view is defined over exactly these six, so a value
 * outside the set is refused at the door rather than stored and guessed at later. */
export const TASK_KINDS = new Set(["plan", "claim", "done", "block", "dispute", "retract"]);
/** The `task` column shape (§9.3.1): `t-<n>`. */
export const TASK_ID_RE = /^t-\d+$/u;
/** The closed set rendered as one line. Every refusal that has to name the set
 * renders THIS constant, so a refusal can never advertise a different set than
 * the one the validator enforces (the "one fact, one place" rule). */
export const TASK_KIND_LIST = [...TASK_KINDS].join(" / ");
/** §9.3.4 rule 1: the kinds that count as a CLAIM on a task's state. `plan`
 * creates a task, `dispute` questions a claim and `retract` withdraws one —
 * none of the three says where the work stands, so none of them is a claim. */
export const TASK_CLAIM_KINDS = new Set(["claim", "done", "block"]);

/** Blackboard paths of one team. `name` is already `[a-z0-9-]+`, so no segment
 * of the joined path can escape the captured workspace. */
export function blackboardPaths(team) {
	const dir = path.join(team.workspace, TEAM_DIR, team.name);
	return {
		dir,
		roster: path.join(dir, ROSTER_MIRROR_FILE),
		decisions: path.join(dir, DECISIONS_FILE),
		discipline: path.join(dir, DISCIPLINE_FILE),
		tasks: path.join(dir, TASKS_FILE),
	};
}

/** Content hash of a blackboard file — the discipline file's optimistic lock
 * (§3.3.3). Truncated to 16 hex characters: short enough to carry in a tool
 * call, still 64 bits of a SHA-256 digest. */
export function blackboardHash(text) {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// ★ 批 T（黑板归档 / 回收）：归档目录 + 「活跃 ∪ 归档」的取值面（FR-T4 · 设计档
//   docs/2026-10-18-blackboard-archive-design.md §4 D5/D6 · §5 FR-T3/FR-T4 · §7）
// ---------------------------------------------------------------------------
// ★ 为什么取值面在这里：`decisions.seq` 与任务号 `t-<n>` 的**分配**与**「已注册」校验**都是从
//   文件里扫出来的（{@link lastSeq} / {@link registeredTaskIds}）。天真截断会让序号回卷、旧号被
//   复用、归档 id 的 claim 被误拒 ⇒ 三处一律扫「活跃 ∪ `archive/` 同族」，**时机与格式一字不改**。
// ★ 归档子目录名（§7 路径不变式）：唯一一处拼 `archive/`；写面 `lib/team-tools.js` 从本档取用。
// ---------------------------------------------------------------------------

/** 黑板台账档的归档子目录名（`team/<name>/archive/`）。 */
export const BLACKBOARD_ARCHIVE_DIR = "archive";

/** 一个黑板目录的归档子目录绝对路径。 */
export function blackboardArchiveDir(dir) {
	return path.join(dir, BLACKBOARD_ARCHIVE_DIR);
}

/** 读一个黑板目录的归档索引（`archive/*.md`；目录缺省视为空）。**零写入**。
 *
 * `entries` 每项是 `{ name, text }` —— 内容原样带回，正文行数 / 归档时间 / 并集扫描由读者自己算
 * （归档**头的形状**属写面：`lib/team-tools.js` 的 `renderArchiveDocument` / `archiveBodyLines`）。
 * 单档读不出来只少一条（`errors` 如实记下名字，不静默当作「这一档不存在」）；目录读不出来
 * 才是 `error`（缺目录不算错误：`archive/` 不存在 = 还没归档过）。 */
export async function readBlackboardArchive(dir) {
	const archiveDir = blackboardArchiveDir(dir);
	let names;
	try {
		names = await readdir(archiveDir);
	} catch (error) {
		if (error !== null && typeof error === "object" && error.code === "ENOENT") return { entries: [], errors: [], error: null };
		return { entries: [], errors: [], error: describeError(error) };
	}
	const entries = [];
	const errors = [];
	for (const name of names.filter((entry) => entry.endsWith(".md")).sort()) {
		try {
			entries.push({ name, text: await readFile(path.join(archiveDir, name), "utf8") });
		} catch (error) {
			errors.push({ name, error: describeError(error) });
		}
	}
	return { entries, errors, error: null };
}

/**
 * ★ 批 T 的取值面接缝（**为什么需要它**，如实写在代码里）：
 *
 * 分配与「已注册」校验的**调用点在 `lib/index.js` 的 append 工具里**
 * （`registeredTaskIds(existing.text)` / `lastSeq(existing.text)`），它们只拿到**正文**、拿不到路径；
 * 而本批的红线是 `lib/index.js` 一个字节都不改（它已顶到 256 KiB 上限）。于是由**唯一读入口**
 * {@link readBlackboardFile} 在读到台账档时，把「同目录 `archive/` 同族的正文」按**文件路径**登记到
 * 下面这张表；三个取值助手在扫描时按「**正文逐字相等**」取回那一份并一并扫描。
 *
 * 失败方向（说清，不装）：登记缺失 / 正文不等 / 归档读不出来 ⇒ **只扫活跃档**
 * （= 本批之前的行为：号不会回卷到更小，但归档过的旧 id 会退化成「未登记」）。绝不猜另一队的归档：
 * 同名正文在两队之间巧合相等时，最后登记者胜（一张小表，随读更新；`delete + set` 让它排在迭代末尾）。
 */
const archiveScopes = new Map();

/** 该路径是不是两本台账之一（只有它们有归档面：`discipline` 是文档、`roster` 是镜像）。 */
function isLedgerFile(file) {
	const base = path.basename(file);
	return base === DECISIONS_FILE || base === TASKS_FILE;
}

/** 读一次同族归档的正文并登记（在 {@link readBlackboardFile} 里调用；**永不抛**、永不改状态）。 */
async function rememberArchiveScope(file, text) {
	if (!isLedgerFile(file)) return;
	const kind = path.basename(file) === DECISIONS_FILE ? "decisions" : "tasks";
	let archiveText = "";
	try {
		const index = await readBlackboardArchive(path.dirname(file));
		archiveText = index.entries
			.filter((entry) => entry.name.startsWith(`${kind}-`) && entry.name.endsWith(".md"))
			.map((entry) => entry.text)
			.join("\n");
	} catch {
		archiveText = "";
	}
	archiveScopes.delete(file);
	archiveScopes.set(file, { text, archiveText });
}

/** 与一段活跃档正文**逐字相等**的那份归档并集正文（没有 ⇒ `""`：退回只扫活跃档）。 */
function archiveTextFor(text) {
	let found = "";
	for (const entry of archiveScopes.values()) if (entry.text === text) found = entry.archiveText;
	return found;
}

/** Read one blackboard file. A missing file is an empty file — reported as such
 * — and any other failure comes back as readable text instead of an exception
 * out of a tool call.
 *
 * ★ 批 T：读到两本台账之一时顺带登记「同目录 archive/ 同族」的并集正文（见 `archiveScopes`）；
 * 这一步**只读**、失败即当作没有归档，输出形状（`{text, exists}` / `{error}`）一字不变。 */
export async function readBlackboardFile(file) {
	try {
		const text = await readFile(file, "utf8");
		await rememberArchiveScope(file, text);
		return { text, exists: true };
	} catch (error) {
		if (error !== null && typeof error === "object" && error.code === "ENOENT") {
			await rememberArchiveScope(file, "");
			return { text: "", exists: false };
		}
		return { error: describeError(error) };
	}
}

/** Every non-empty line of a blackboard file, in order. */
export function blackboardLines(text) {
	return text.split(/\r?\n/u).filter((line) => line.trim() !== "");
}

/** Highest `seq` already present in a blackboard ledger — its counter (§3.3.3
 * "seq 单调递增", assigned by the plugin). Unparsable lines are ignored rather
 * than allowed to reset the counter.
 *
 * Pulled out of `lastDecisionSeq` when the tasks ledger arrived (§9.2): the two
 * files share the RULE but never the counter — every ledger counts in its own
 * space (§9.3.1), so this function is fed the text of exactly one file. */
export function lastSeq(text) {
	let max = 0;
	// ★ 批 T（D5）：扫「活跃 ∪ 归档」——搬运之后活跃档可能只剩尾部（甚至只剩指针行），
	// 只看活跃档会让 seq 从头重计（跨档重号 ⇒ 审计链断）。归档里的行与活跃档的行**同一种格式**，
	// 所以同一个判据直接喂两份正文；归档头不以 `<数字> |` 开头，扫进去也不会把元数据读成一条账。
	const images = [String(text ?? ""), archiveTextFor(text)];
	for (const image of images) {
		for (const line of blackboardLines(image)) {
			const matched = /^(\d+)\s*\|/u.exec(line);
			if (matched === null) continue;
			const seq = Number(matched[1]);
			if (Number.isFinite(seq) && seq > max) max = seq;
		}
	}
	return max;
}

/** Highest `seq` already present in decisions.md — the ledger's counter (§3.3.3
 * "seq 单调递增", assigned by the plugin). Semantics unchanged: this is now
 * literally `lastSeq`, kept as a named call site so the decisions branch (and
 * the recovery audit row that shares it) still reads as the decisions ledger. */
export function lastDecisionSeq(text) {
	return lastSeq(text);
}

/** §4.1 line bound, counted in code points (so an astral character costs one). */
export function readBlackboardLine(value, name) {
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
export function blackboardAuthor(exec) {
	const caller = agentSessionId(exec);
	if (caller === undefined) return "unknown";
	return caller.replace(/[\r\n|]/gu, "_");
}

/** One ledger row: `seq | ISO 时间 | author-session-id | 正文` (§3.3.3). */
export function decisionRow(seq, iso, author, text) {
	return `${seq} | ${iso} | ${author} | ${text}`;
}

/** One task row: `seq | ISO 时间 | author-session-id | kind | task | 正文` (§9.3.1).
 * Six columns; the two the decisions ledger does not have are the closed-set
 * `kind` and the plugin-assigned `task` number. */
export function tasksRow(seq, iso, author, kind, task, text) {
	return `${seq} | ${iso} | ${author} | ${kind} | ${task} | ${text}`;
}

/**
 * 台账**迁移表门**（批 34 / FR-7 · 设计档 `2026-10-14-anti-drift-design.md` §5 FR-7）。
 *
 * 收口在这一个函数里，因为它是**一条规则**：台账的每一行都得有来历。
 * 判据全部**可机检**（零自然语言理解——本仓铁律）：
 *
 *   ① `kind === "done"` ⇒ 同一 `t-<n>` 必须**先有一条 `claim` 行**。
 *      为什么：`done` 是"这件事做完了"的**主张**，而主张需要一个"我接了这件事"的前件；
 *      没有 claim 的 done 就是**凭空销账**（`docs/2026-09-12-absorption-inventory.md`
 *      第 6 项原话：「宣告做完 ≠ 真做完」）。
 *   ② `kind === "retract"` ⇒ 正文必须含一个指向**本文件里真实存在、且属于同一任务**的行的指针
 *      （`t-<n>` 或 `#<seq>`）。为什么：撤回是**指向某条主张**的动作；指向不存在的东西等于没撤回
 *      任何东西，而指向**别的任务**的行等于「声称撤回 A 却拿 B 当凭据」（装饰不是证据）。
 *      判据**纯文本可判**（零自然语言理解）：把正文里所有 `t-<数字>` / `#<数字>` 抽出来，
 *      **至少一个命中**「本文件可解析行里、`task` 等于本行 `task` 的行」⇒ 过；全不命中 ⇒ 拒。
 *      **不**做语义判断（不做"是否真的驳倒了它"——那超出机检能力）。
 *
 * **失败朝向 = fail-closed**：读不出文件 / 解析异常 ⇒ **拒**（不写）。理由是这条门守的
 * 是"台账还能不能当证据用"——放行一条凭空销账的行，比拒绝一条合法行**不可逆得多**。
 * 这与本插件既有的"解析失败 ⇒ 丢弃那一条"（配置面）**方向不同**，因为两者的代价不对称。
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function ledgerTransitionGate({ kind, task, body, fileText }) {
	if (kind !== "done" && kind !== "retract") return { ok: true };
	const rows = [];
	for (const line of blackboardLines(fileText)) {
		const row = parseTasksRow(line);
		if (row !== null) rows.push(row);
	}
	if (kind === "done") {
		const hasClaim = rows.some((r) => r.task === task && r.kind === "claim");
		if (!hasClaim) {
			const registered = rows.filter((r) => r.task === task).length;
			return {
				ok: false,
				reason: `台账迁移表门：拒写 done(${task})——该任务**没有 claim 行**（本文件里与它相关的行 ${registered} 条）。`
					+ `没有"我接了这件事"的前件，done 就是凭空销账。先写 kind=claim（task=${task}），再回来收工。Nothing was written.`,
			};
		}
		return { ok: true };
	}
	// retract：正文必须指向**本文件里真实存在、且属于同一任务**的 `t-<n>` 或 `#<seq>`
	//
	// ★ 为什么**不加** kind 白名单（会诊 §2 建议 `kind ∈ {claim,done,block}` 的那一条，
	//   我据既有语料**未采纳**）：本仓既有合法夹具 host-half.test.mjs:2679 的正文是
	//   「撤回 #4 的第 2 处」，而 `#4` 那一行是 **dispute**（t-1 上的一次存疑）——retract
	//   在既有设计里**正是用来消解 dispute 的**（§9.3.4 规则 2）。加该白名单会把这条
	//   既有合法撤回打红 ⇒ 白名单是错的，不是我漏了。**夹具是权威，模型建议不是。**
	//
	// ★ 同任务（`r.task === task`）是**必要**的：跨任务指针不是证据（拿别人的任务行当凭据
	//   = 装饰）。它与 done⇒claim 对称——两条门都要求「前件是同一件事上的行」。
	const text = String(body ?? "");
	const taskRefs = [...text.matchAll(/\bt-(\d+)\b/gu)].map((m) => `t-${m[1]}`);
	const seqRefs = [...text.matchAll(/#(\d+)\b/gu)].map((m) => Number(m[1]));
	// ★ 「同任务」对**两种引用形态是同一条谓词**（设计档 §5 FR-7 规则②的判据）：
	//   · `t-<n>` 命中本行的任务号 ⇒ 它点名的正是本任务那一族行（本行的号必已登记，
	//     见既有校验「任务号必须已登记」⇒ 那些行确实存在）；
	//   · `#<seq>` 命中本任务某一行的 seq ⇒ 同理。
	//   这一条**刻意不放宽成「文件里任意真实存在的行」** —— 那只要删掉本行的 `=== task`（或把
	//   `ownRows` 换成 `rows`）就能实现，而它等于拿别人的任务行当凭据（设计档明写否决）。
	const ownRows = rows.filter((r) => r.task === task);
	const hitTask = taskRefs.some((ref) => ref === task);
	const hitSeq = seqRefs.some((s) => ownRows.some((r) => r.seq === s));
	if (!hitTask && !hitSeq) {
		const candidates = ownRows.slice(-5).map((r) => `#${r.seq}`).join(" ") || "（本任务还没有任何行）";
		return {
			ok: false,
			reason: "台账迁移表门：拒写 retract——正文没有指向**本文件里真实存在、且属于同一任务**的主张"
				+ "（需要 `t-<n>` 或 `#<seq>`）。抽到的引用："
				+ (taskRefs.length + seqRefs.length === 0 ? "（无）" : [...taskRefs, ...seqRefs.map((s) => "#" + s)].join("、"))
				+ "；本任务可用的行：" + candidates + "（Nothing was written）。",
		};
	}
	return { ok: true };
}

/** One parsed tasks row (§9.3.1), or `null` when the line is not a row this
 * plugin can attribute to a task. Only the three columns the derivation keys on
 * are validated (seq / kind / task) — the stamp, the author and the body travel
 * as they were written, because the read face shows the raw rows as well and a
 * derived reading must never contradict the row it came from. Extra `|`
 * separators are fine: the body is free text and the columns before it are
 * positional. */
export function parseTasksRow(line) {
	const parts = String(line).split("|");
	if (parts.length < 6) return null;
	const seqText = parts[0].trim();
	if (!/^\d+$/u.test(seqText)) return null;
	const kind = parts[3].trim();
	if (!TASK_KINDS.has(kind)) return null;
	const task = parts[4].trim();
	if (!TASK_ID_RE.test(task)) return null;
	return { seq: Number(seqText), iso: parts[1].trim(), author: parts[2].trim(), kind, task };
}

/** The task numbers registered in one tasks file, plus the highest of them
 * (§9.3.2). The scan covers the WHOLE file — the read window plays no part in
 * allocation — and an unparsable line is skipped rather than allowed to reset
 * the counter, exactly as `lastSeq` treats a damaged seq column (U16).
 *
 * "Registered" is read off the rows: a number lives in the `task` column of a
 * row that names it (in the intended flow, the `plan` row that introduced it).
 * That is the check §9.3.2 asks for — a mis-typed number is refused and the
 * refusal points at `kind=plan`, which is what "别凭记忆转录 id" needs.
 *
 * `unsafe` carries the ids whose numeric value is not a SAFE integer: they stay
 * registered (their rows exist and are readable) but they are not allocatable, which
 * is what keeps the plugin from writing an id its own parser cannot read back. */
export function registeredTaskIds(text) {
	const ids = new Set();
	const unsafe = [];
	let max = 0;
	// ★ 批 T（D5）：扫「活跃 ∪ 归档」——**同一个判据喂两份正文**：
	//   · 分配（`max + 1`）取并集最大 ⇒ 归档之后任务号绝不回卷（t-3 不会被再发一次）；
	//   · 「已注册」取并集里的号 ⇒ 归档过的旧任务号仍被认（claim 合法），而**伪造的高号仍然不在集合里**，
	//     照旧被 `lib/index.js` 的 append 面拒绝（本档不放宽任何一条拒绝）。
	//   失败方向：没有登记到归档 ⇒ 只扫活跃档（本批之前的行为），绝不猜别的队。
	const images = [String(text ?? ""), archiveTextFor(text)];
	for (const image of images) {
		for (const line of blackboardLines(image)) {
			const row = parseTasksRow(line);
			if (row === null) continue;
			ids.add(row.task);
			const number = Number(row.task.slice(2));
			// §9.3.2 allocates `t-<max+1>`, so a number the plugin cannot add one to is not a
			// number it may allocate from: `Number` reads a 22-digit hand-written id as 1e22
			// while `Number.isFinite` stays true, and the next allocation would write
			// `t-1e+22` — a row this file's OWN parser then rejects (`TASK_ID_RE` wants
			// digits). Such ids are collected as UNSAFE and the allocation branch refuses on
			// them: never clamp, never guess what the author meant.
			if (!Number.isSafeInteger(number)) {
				unsafe.push(row.task);
				continue;
			}
			if (number > max) max = number;
		}
	}
	return { ids, max, unsafe };
}

/** §9.3.4's derived view over the rows of one tasks file: for every task, its LAST
 * CLAIM and whether a doubt is still standing. Pure, and deliberately mechanical —
 * it never compares two claims' bodies, never orders rows by their timestamps and
 * never decides which of two claims is right. The only ordering it knows is the
 * ledger's own: seq ascending, ties left in file order (a tie means two sessions
 * appended concurrently, and the file is the order they landed in). That is §9.3.4
 * rule 3 ("绝不自动裁决") written as code; rule 4 ("措辞") is why every word it
 * renders says 主张 and never 状态. */
export function deriveTasksView(lines) {
	const byTask = new Map();
	let unparsable = 0;
	for (const line of lines) {
		const row = parseTasksRow(line);
		if (row === null) {
			unparsable += 1;
			continue;
		}
		const list = byTask.get(row.task);
		if (list === undefined) byTask.set(row.task, [row]);
		else list.push(row);
	}
	const views = [];
	for (const [task, rows] of byTask) {
		rows.sort((left, right) => left.seq - right.seq);
		views.push(taskView(task, rows));
	}
	// Ascending by task number — the reading order of a ledger of `t-<n>` numbers.
	// Recency is NOT the order here on purpose: the raw rows printed underneath
	// already carry it, and "most recently touched first" would editorialise.
	views.sort((left, right) => left.number - right.number);
	return { views, unparsable };
}

/** One task's reading: its last claim, the withdrawals standing after it, and the
 * doubts nothing has answered yet. */
export function taskView(task, rows) {
	let claimIndex = -1;
	for (let index = 0; index < rows.length; index += 1) {
		if (TASK_CLAIM_KINDS.has(rows[index].kind)) claimIndex = index;
	}
	// §9.3.4 rule 1: `retract` does NOT erase history — an append-only ledger has
	// no way to delete a row, and pretending otherwise would be the one operation
	// this whole design exists to refuse. The claim stays; the withdrawal is
	// rendered beside it, keeping BOTH ids (who claimed, who withdrew). Whether the
	// withdrawer had any standing to withdraw is left to a human: the blackboard has
	// no write gate (§9.4), so the read face shows the two ids instead of judging.
	const retracts = claimIndex === -1 ? [] : rows.slice(claimIndex + 1).filter((row) => row.kind === "retract");
	// §9.3.4 rule 2: a doubt is unresolved while no claim / retract of this task
	// follows it.
	const unresolved = [];
	let settledBy = null;
	for (let index = 0; index < rows.length; index += 1) {
		if (rows[index].kind !== "dispute") continue;
		const answer = rows.slice(index + 1).find((row) => TASK_CLAIM_KINDS.has(row.kind) || row.kind === "retract");
		if (answer === undefined) unresolved.push(rows[index]);
		else settledBy = answer;
	}
	return {
		task,
		number: Number(task.slice(2)),
		rows: rows.length,
		claim: claimIndex === -1 ? null : rows[claimIndex],
		retracts,
		unresolved,
		settledBy,
	};
}

/** The stamp of a derived row (§9.3.3): the row's instant rendered on the LOCAL
 * basis at minute precision — the very same local formatting {@link readStamp}
 * uses, so "这条主张是刚发生的吗" can be answered by reading the derived line against
 * the `（读数 …）` line at the foot of the same screen.
 *
 * It deliberately does NOT cut the row's ISO column any more: that column is UTC
 * (`toISOString()`), so slicing it printed a wall clock 8 hours away from the rest
 * of the same screen (真机实测；2026-09-27 修复轮). The ROW is untouched — the UTC
 * ISO value stays the fact source and is still printed verbatim in the raw window
 * under the derived view.
 *
 * A stamp this plugin wrote always parses. A hand-edited row is not this plugin's
 * promise, so an unreadable column is echoed as written: never an invented time,
 * and never a `NaN-NaN-NaN NaN:NaN` reading either. */
export function taskStamp(iso) {
	const at = new Date(String(iso ?? ""));
	return Number.isNaN(at.getTime()) ? preview(String(iso ?? ""), 40) : localStamp(at, false);
}

/** One line of the derived view, in §9.3.3's own shape:
 * `- t-7 · 4 行 · 最后主张 done（2026-09-26 21:19 · worker-b）· ⚠ 未消解存疑 1 条`.
 * The two words that carry the whole design are 最后主张 (a claim, never a state)
 * and 未消解存疑 (a doubt, never a verdict) — §9.3.4 rule 4.
 *
 * §9.3.3 spells the trailing segment with NO space before its separator: the doubt
 * marker hugs the closing `）` of the claim it belongs to (`）· ⚠ 未消解存疑 1 条`),
 * where the leading segments are separated by ` · `. Rendering the tail as one more
 * `join`ed segment is exactly the drift this line was audited for (`） · ⚠ …`), so it
 * is appended to the finished head instead of being joined into it. */
export function renderTaskView(view) {
	const segments = [`- ${view.task}`, `${view.rows} 行`];
	if (view.claim === null) {
		segments.push("尚无主张（仅登记）");
	} else {
		const inside = [taskStamp(view.claim.iso), view.claim.author === "" ? "unknown" : view.claim.author];
		if (view.retracts.length > 0) {
			// §9.3.4 rule 1: one withdrawal is named — and when several follow the same
			// claim, `#N` is the LAST of them, exactly as the claim is the last row of a
			// claim kind. The COUNT of withdrawals is deliberately not rendered: §9.3.4 is
			// a strict definition (「不许自由发挥」), and every withdrawal is already visible
			// verbatim in the raw rows printed beneath the derived view.
			const last = view.retracts[view.retracts.length - 1];
			inside.push(`已由 #${last.seq} 撤回`, `撤回者 ${last.author === "" ? "unknown" : last.author}`);
		}
		segments.push(`最后主张 ${view.claim.kind}（${inside.join(" · ")}）`);
	}
	const head = segments.join(" · ");
	if (view.unresolved.length > 0) return `${head}· ⚠ 未消解存疑 ${view.unresolved.length} 条`;
	if (view.settledBy !== null) return `${head}· 存疑已由 #${view.settledBy.seq} 消解`;
	return head;
}

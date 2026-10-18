// ---------------------------------------------------------------------------
// 换届域（rotation）：M4 两阶段换届的**状态机** —— 批 R（上架合规）从 `lib/index.js` 原样搬出
// ---------------------------------------------------------------------------
// 归属：docs/2026-10-15-store-compliance-design.md §6「边界规则」· §4 D1/D2/D4 · §5 FR-R1 · §8 Rr1/Rr3/Rr4。
// ★ 本档是什么：prepare / claim / 过期清扫（sweep）/ 冻结广播（broadcastNotice）这一族的**状态机**，
//   加上它自己那一族纯判据（准入 `prepareAdmission` / 迁移计划 `planRotationMigration` / 信任迁移
//   `applyRotationTrust` / roster 落定 `settleRotation` / 四条通知文案 / §11.5 归属读数 / 清扫判据）
//   与那一族静态量（TTL / 动作集 / 对话框成因）。
// ★ 本档**不是**（留给下一小单）：`recovery`（revive / reappoint）· `handoff` 文档生成（`handoff*` /
//   `HANDOFF_*` / `readHandoffArgument` / `autoHandover`）· `appoint` 支路 · policy schema 里那三个
//   rotation 归一化器（`normalizePending` / `normalizeProvisional` / `normalizeRotationBackup`）。
//   它们仍住在入口，本档不碰（入口按名引用本档的导出，方向是入口 → 域档）。
// ★ 为什么可以搬（模块图无环，Rr4）：本档**不导入入口** `lib/index.js`（那会构成 ESM 环）——
//   入口侧仍需要的绑定（常量与纯判据）由本档 `export`、入口反向导入；而本档需要的**入口侧出口**
//   一律走**注入缝**（下一条），于是依赖方向是单向的 DAG：入口 → 域档 · 入口 → 共享档 · 域档 → 共享档。
// ★ 四条注入缝（`extras`，先例 = `forensics.js` 的 `wireForensics()`；**不是** ESM 环）：
//   · `mirrorWriter` —— 名册镜像（`writeRosterMirror` / `mirrorNote`）住在**名册域**，它的闭包拖着
//     16 个入口常量（`renderRosterMirror` / `TEAM_MODES` / `tenureStartOf` …）；
//   · `readStaleNote` —— 读数脚注常量 `READ_STALE_NOTE`（同属名册/读面域）；
//   · `timestamp` —— 交接文档文件名的时间戳格式器（§11.5 的读链要用它；纯函数、入口 24 处调用
//     ⇒ 走 `lib/shared.js`，见那份档头）；
//   · `deliver` —— 投递出口 `deliverToTarget`（**投递域**）；
//   · `handoffNames` —— §11.5 持久证据读面 `handoffDocumentNamesLatest`（**handoff 文档域**）；
//   · `ladderSuffix` —— §11.9.3 活性诊断那句（**恢复域**，随 `prepareAdmission` 的 request 注入）；
//   · `factRows` / `provisionalGuidance` —— §11.9.6「不可两处口径」的三条渲染出口**必须**住在入口：
//     `host-half.test.mjs` 的「同源锁」按**文件名**读 `lib/index.js` 并断言那四类行模板各只出现一次
//     （本单实测：搬走它们 ⇒ 该锁读不到而行红）⇒ 同样注入。
// ★ 搬运纪律（D4）：**符号定义与其文档注释逐字节原样** —— 只加 `export `；一行逻辑 / 文案 / 判据未改。
// ★ 宿主依赖面：本档的**宿主**说明符全部落在既有白名单那 8 条里 —— `node:crypto`（`randomUUID`，铸令牌）、
//   `node:fs/promises`（`readdir` / `readFile`，§11.5 的落盘文档读链）、`node:path`（拼路径）；
//   其余两条是**内部相对导入**（`./shared.js` / `./ledger.js`，不计入宿主面）。原文那句口径如下：
//   （内部相对导入、不计入宿主面）⇒ 宿主说明符集合仍是那 8 条（`HOST_IMPORTS`），闸门读数一字未动。
// ★ 被钉符号核对（本仓 `hostSource` 文本锁钉住的 9 个）逐个不在本档：`writePolicyFileAtomic` /
//   `renameThroughSeam` / `POLICY_FILE_SCHEMA` / `WATCHDOG_DIGEST_DEBOUNCE_MS` / `TICKABLE_VERDICTS` /
//   `agentStateLabel` / `writerGate` / `relayUserMessage` / `buildTeamSessionCreateOptions` ——
//   它们在入口那一档，本单一个都没动。
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { COORDINATOR_ROLE, ROTATION_RATE_LIMIT_MS, ROTATION_TOKEN_LABEL, ROTATION_TTL_MS, describeError, fmtWindowRest, maskToken, noticeField, pairKey, preview, readStamp, rotationRateLimited, timestamp, wellFormed } from "./shared.js";
// ★ 批 R 定点修复 R-6：上面那**五个换届符号**（三个窗口常量 ＋ `fmtWindowRest` / `pairKey`）已**下沉到
//   共享档**（`lib/shared.js` 末尾那一节，定义体与文档注释逐字节原样）—— 这里按名导入后**原样再导出**，
//   于是入口（`lib/index.js`）与 `policy-store.js` / `recovery.js` 等导入方一处未改、符号面零变更，
//   而 `shared → rotation` 那条反向边随之消失 ⇒ 模块图无环（设计档 §6 不变量 ③ · 判据 Rr4）。
export { ROTATION_RATE_LIMIT_MS, ROTATION_TOKEN_LABEL, ROTATION_TTL_MS, fmtWindowRest, pairKey };
// ★ §11.5 的读链（{@link handoffDocumentNamesLatest}）与 {@link handoffDocumentPath} 要用黑板目录出口 ——
//   它属于**黑板/台账域**（批 R 第 3 小单已搬进 `lib/ledger.js`）⇒ 从那里按名导入（内部相对导入，
//   宿主说明符面一个字符未动）。
import { blackboardPaths } from "./ledger.js";


// ---------------------------------------------------------------------------
// rotation: two-phase team hand-over (§3.6, M4)
// ---------------------------------------------------------------------------

/** Phase B provisional trust lifetime (§3.6.2 评审 #5): a migration granted
 * without a present user is revoked after this window unless ratified. */
export const ROTATION_PROVISIONAL_TTL_MS = 24 * 3600000;
/** How long the single rotation dialog waits for a present user before the claim
 * falls back to the unattended (provisional) path (§3.6.1 principle 4). */
export const ROTATION_CONFIRM_TIMEOUT_MS = 180000;
/** The tool's closed `action` set (§3.6.2 的两个相位 ＋ 批 S 追加的整队准备动作).
 * ★ 批 S（D1）：`prepare-batch` 是**同一个工具**的第三个动作（扩 action、不建新工具）—— 它只做
 *   Phase A 的批量版；Phase B 仍由 `claim` 逐个**本人**凭自己的令牌完成（批量不代认领、不代批准）。 */
export const ROTATION_ACTIONS = new Set(["prepare", "claim", "prepare-batch"]);
/** 批 S 的动作名（与 {@link ROTATION_ACTIONS} 同源；入口按名路由，不手抄字符串）。 */
export const ROTATION_BATCH_ACTION = "prepare-batch";
/** 批量令牌时限（NF-S2 / D2）：**2 小时**（单角色仍 `ROTATION_TTL_MS` = 30 分钟）。
 * N 个继任者要各自找时间认领，30 分钟会把批量变成「必然部分过期」；代价如实：可用窗口变长，
 * 故仍**一次性**、绑 (team, role, successor) 三元组、成功即作废。 */
export const ROTATION_BATCH_TTL_MS = 2 * 3600000;
/** 整队换届**唯一那道**确认框的 id 与两个选项标签（§11.4.1 同款：按 id 匹配、按标签判）。 */
export const ROTATION_BATCH_DIALOG_ID = "rotation-batch-confirm";
export const ROTATION_BATCH_CONFIRM_LABEL = "确认整队换届";
export const ROTATION_BATCH_CANCEL_LABEL = "取消";
/** The history note a rolled-back provisional migration leaves behind. */
export const ROTATION_PROVISIONAL_NOTE = "provisional 未批准过期";
/** The third rotation verdict (§3.6.2 评审 #5): a claim with no in-domain
 * candidate opens no dialog, so neither "已批准" (nobody was asked, nobody
 * approved) nor "待批准(24h)" (no provisional window exists) is true. */
export const ROTATION_STATUS_NONE = "无待迁移对";
/** Question id of the rotation dialog — the answer is matched by id, not order. */
export const ROTATION_DIALOG_ID = "rotation-migrate";
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
export const ROTATION_DIALOG_CAUSES = Object.freeze({
	UNAVAILABLE: "unavailable",
	NO_ANSWER: "no-answer",
	TIMEOUT: "timeout",
	FAILED: "failed",
});

/** Header schema tag of the hand-over document
 * (`<workspace>/team/<name>/handoff-<role>-<ts>.md`, §11.4.3). */
export const HANDOFF_SCHEMA = "team-link/handoff/1";
/** §11.4.3 file-name prefix. The timestamp makes every document unique, which is
 * exactly why a hand-over document needs no baseHash optimistic lock. */
export const HANDOFF_FILE_PREFIX = "handoff-";
/** The header's `claimedAt` value at write time. The document is written BEFORE
 * prepare (§11.9.6 abort-before-prepare), so nobody has claimed when it lands —
 * and the claim never re-verifies, let alone rewrites, the document. */
export const HANDOFF_CLAIMED_PLACEHOLDER = "（未认领；本文件写于 prepare 之前——§11.9.6：claim 时不复验文档，本文件不追写。认领时刻记在 roster 版本史与 claim 返回里）";
/** The header's `rotationStatus` value at write time, honest about the ORDER:
 * the token this header masks is minted in memory so the mask is real, but it
 * becomes durable and is issued only when prepare runs, one step later. */
export const HANDOFF_STATUS_PREPARED = "待 prepare 落定（本文件先于令牌落盘与 freeze 广播写入；prepare 失败则本次换届不存在，认领后的状态词以 claim 返回为准）";


/** §11.4.3 path of one hand-over document: `<workspace>/team/<name>/handoff-<role>-<YYYYMMDD-HHmmss>.md`.
 * `role` is validated `[A-Za-z0-9_-]+` and the stamp is digits and dashes only,
 * so no segment of the joined path can escape the captured workspace. */
export function handoffDocumentPath(team, roleName, now) {
	return path.join(blackboardPaths(team).dir, `${HANDOFF_FILE_PREFIX}${roleName}-${timestamp(new Date(now))}.md`);
}


/** The hand-over documents already on disk for this team+role, oldest first.
 * Read from the DIRECTORY, not from memory: previous hand-overs may have been
 * written before this activation — which is exactly what makes this list the
 * durable half of §11.5's "did the plugin build this successor?" question.
 * @returns `{ files, error }` — `files` are base names; `error` is set only when
 *   the directory could not be read at all (an absent directory is empty). */
export async function listHandoffDocuments(team, roleName) {
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
export async function latestHandoffDocument(team, roleName) {
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
export function handoffDocumentNamesSuccessor(text, sessionId) {
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
export async function handoffDocumentNamesLatest(team, roleName, sessionId) {
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

/** One role record of a team, or `null`. */
export function roleOf(team, role) {
	return team.roles.find((entry) => entry.role === role) ?? null;
}


/** Close one tenure inside a history copy: set its `until` (and the note), or
 * append a closing record when no open one exists for that session (§3.3.2
 * "旧任 until=now, note"). Returns the same array, mutated. */
export function closeTenure(history, session, now, note) {
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
export function roleRecord(fields) {
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


/** Append one §11.9.5⑦ audit row to a role record, through the canonical
 * constructor so the row round-trips through settings unchanged. */
export function withRecoveryRow(team, roleName, row) {
	return {
		...team,
		roles: team.roles.map((entry) => (entry.role === roleName ? roleRecord({ ...entry, rotationAt: row.at, recoveries: [...(entry.recoveries ?? []), row] }) : entry)),
	};
}

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
export function recoveryNote(verb, requester) {
	const who = String(requester ?? "").replace(/[\u0000-\u001F\u007F|]/gu, "_");
	return `recovery(${verb}, vacant-due-to-death, requester=${who === "" ? "unknown" : who})`;
}


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
export function dialogNoAnswerError(error, signal) {
	if (signal?.aborted === true) return true;
	const code = typeof error?.code === "string" ? error.code : typeof error?.cause?.code === "string" ? error.cause.code : "";
	if (/abort|timeout|etimedout/iu.test(code)) return true;
	const name = typeof error?.name === "string" ? error.name : "";
	return /aborterror|timeouterror/iu.test(name);
}


/** §3.6.2 评审 #8 (防御纵深): a rotation-granted pair whose 24h ratification
 * window has run out is already back on the ordinary gates — the sweep deletes
 * the row, but between the deadline and the next sweep the row must not keep
 * granting a channel that bypasses both approval gates, or the "24h 自动回退"
 * promise would be silently false for exactly that window. */
export function isExpiredProvisionalPair(pair, now) {
	return pair.provisional === true && pair.expiresAt > 0 && pair.expiresAt <= now;
}


/** The filled roles of one team, deduplicated, in roster order — "同 team 成员" of
 * §3.6.1 principle 2, and the recipient set of an internal notice. A vacant role
 * is not a member. */
export function teamMembers(team) {
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
export async function successorOwnershipOf(request) {
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
export async function successorOwnershipIndex(cancelled, policy, hasHandle) {
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
export function ownershipEvidenceLabel(evidence) {
	if (evidence === "handoff-document") return "落盘的交接文档头部 successor 行";
	if (evidence === "pending-create-intent") return "落盘的 pending-create 意图";
	if (evidence === "handle") return "本激活窗口的 AgentHandle 注册表";
	return "（无证据）";
}


/** §3.6.2 prepare permission, verbatim: the incumbent session of that role. The
 * user path is the settings UI (the user is the super-writer there), not a tool
 * call — so a caller that is not the incumbent is refused, never guessed at. */
export function rotateGate(team, entry, caller) {
	if (entry.current === null) {
		return { error: `prepare 被拒绝：团队 ${team.name} 的角色 ${entry.role} 当前空缺（current=null），没有「现任」可以发起换届。请由用户经设置 UI 指定现任后再换。` };
	}
	if (caller === undefined || caller !== entry.current) {
		return { error: `prepare 被拒绝：只有该角色的现任会话 ${entry.current} 可以发起换届（当前调用会话 ${caller ?? "（无会话身份）"}）。用户路径是设置 UI（直接改设置命名空间 team-link 的 teams 键），不是工具调用（§3.6.2）。` };
	}
	return { ok: true };
}


/**
 * 团队 + 角色的定位（**纯**）：这一对查找的拒绝文案只在这里写一次 ——
 * 单角色 `prepareAdmission` 与批量 `admissionChecks`（批 S · D10 的拆分）共用它，
 * 于是「团队不在册 / 没有这个角色」两句话不会因为拆成两个入口而各说一遍。
 *
 * @returns `{ team, entry }` 或 `{ error }`。
 */
function rotationTargetOf(view, teamName, roleName) {
	const team = view.teams.find((entry) => entry.name === teamName) ?? null;
	if (team === null) return { error: `prepare 失败：团队 ${teamName} 不在注册表中（先用 team_link_roster action=upsert-team 创建）。` };
	const entry = roleOf(team, roleName);
	if (entry === null) return { error: `prepare 失败：团队 ${teamName} 没有角色 ${roleName}（先用 team_link_roster action=set-role 指定现任）。` };
	return { team, entry };
}

/**
 * 与「门禁」无关的逐角色校验（批 S · D10 的拆分下半）：**继任者 ≠ 现任** ＋ **限速按角色**。
 * 纯 —— 两条都只读 `entry` 与调用方的时钟，所以单角色与批量两条路读到的窗口是同一个窗口
 * （`rotationRateLimited` 一处实现，`NF-S6`）。
 */
function successorChecksOf(entry, successor, now) {
	if (successor !== undefined && successor !== null && successor === entry.current) {
		return { error: `prepare 失败：继任者不能是现任自己（${successor}）——自换会先把现任的 pairs/trustedSenders/rememberTargets 全部吊销，再以 provisional 迁回，等于一次没有意义的信任重建。换人请指定另一个会话；纯粹的降低信任用 team_link_roster action=retire。` };
	}
	const limited = rotationRateLimited(entry, now);
	if (limited.limited) {
		return { error: `prepare 失败：换届速率限制（§3.6.2 rateLimit(team, role, 10min)，防换届风暴）——${limited.reason}。请等窗口结束，或先让当前 pending 被认领/过期清扫。` };
	}
	return { ok: true };
}

/**
 * 批 S · D10：**门禁无关**的逐角色准入（批量 `prepare-batch` 走这一条；单角色走
 * `prepareAdmission`，后者在里面再加现任门）。会诊 #101 [1]-① 的裁定就是把两条语义拆开 ——
 * 「协调者代 worker 发起」与「只有该角色现任可发起」不能混在同一个函数里，否则单角色那条
 * 安全属性有被静默放宽的风险。
 *
 * 前置：`view` 是 policy 的读视图（纯读）；`request.successor` 是这一次要指定的继任者。
 * 后置：通过 ⇒ `{ team, entry }`；不过 ⇒ `{ error }`（预检期，零副作用）。
 *
 * ★ `request.successorPresent`（批 S · Sr15）：**显式继任者在场**探针（注入；返回
 *   `{ ok }` / `{ error }`）。只有批量入口传它 —— 单角色路径的显式 successor 语义
 *   **一个字不改**（M4 现有语义不收紧），所以这里把它做成**可选探针**而不是无条件校验。
 */
export function admissionChecks(view, request) {
	const { teamName, roleName, successor, now } = request;
	const target = rotationTargetOf(view, teamName, roleName);
	if (target.error !== undefined) return { error: target.error };
	const { team, entry } = target;
	const checks = successorChecksOf(entry, successor, now);
	if (checks.error !== undefined) return { error: checks.error };
	if (typeof request.successorPresent === "function") {
		const presence = request.successorPresent(successor);
		if (presence !== null && typeof presence === "object" && presence.error !== undefined) return { error: presence.error };
	}
	return { team, entry };
}

/**
 * §3.6.2 prepare's admission checks, in ONE place: the manual path runs them
 * inside prepare, and the §11.2 `successor:"auto"` path runs them BEFORE it
 * creates anything — so a request prepare would refuse never leaves a session
 * behind, and the refusal words exist once instead of twice. Pure.
 *
 * ★ 批 S · D10：本函数是「**现任门** ＋ 门禁无关校验」的组合（`rotateGate` ＋
 *   `successorChecksOf`）；它**只**属单角色动词 —— 批量入口只用
 *   {@link admissionChecks}，**绝不**调用本函数（协调者代发起与「只有该角色现任可发起」
 *   在语义上互斥，混成一个带布尔开关的函数正是会诊 #101 [1]-① 点名的风险）。
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
 * ★ 批 S · FR-S6（D8）：批次在飞（任一角色的 pending 带 `batchId` 且未过期）⇒ 单角色
 *   prepare **具名拒绝 + 指路**。它不是权限门，所以放在 gate 之后（现任门的话术优先级不变）；
 *   恢复路径（`userInitiated`）**不受**这条互斥限制 —— 那是救场路径，它自己还有对话框与
 *   写前复检（§11.9.4），被一个在飞批次锁死会让「死的现任」无路可走。
 *
 * @returns `{ team, entry }` or `{ error }`.
 */
export function prepareAdmission(view, request) {
	const { teamName, roleName, successor, now, caller, isLive } = request;
	// 批 R 第 5 小单：恢复域那句活性诊断按名注入（档头）；缺席时退回原分支的空后缀。
	const ladderSuffix = typeof request.ladderSuffix === "function" ? request.ladderSuffix : () => "";
	const target = rotationTargetOf(view, teamName, roleName);
	if (target.error !== undefined) return { error: target.error };
	const { team, entry } = target;
	if (request.userInitiated !== true) {
		const gate = rotateGate(team, entry, caller);
		if (gate.error !== undefined) return { error: `${gate.error}${typeof isLive === "function" ? ladderSuffix(entry, isLive) : ""}` };
		const busy = inFlightBatchOf(team, now);
		if (busy !== null) return { error: singleRoleBatchBusyRefusal(team, busy, entry.role, now) };
	}
	const checks = successorChecksOf(entry, successor, now);
	if (checks.error !== undefined) return { error: checks.error };
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
export function planRotationMigration(view, request) {
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
export function applyRotationTrust(view, request) {
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
export function settleRotation(team, request) {
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
export function rotationStatusOf(entry, migrated) {
	if (typeof entry.rotationStatus === "string" && entry.rotationStatus !== "") return entry.rotationStatus;
	if (entry.provisional !== null && entry.provisional !== undefined) return "待批准(24h)";
	return migrated.length === 0 ? ROTATION_STATUS_NONE : "已批准";
}


/** Drop one role's pending — the last step of a claim, and of a cancellation. */
export function clearRotationPending(team, role) {
	return { ...team, roles: team.roles.map((entry) => (entry.role === role ? { ...entry, pending: null } : entry)) };
}

// ===========================================================================
// 批 Q · 换届的「撤销依据」按换届各存一份（设计档 FR-Q1…FR-Q4）
//
// 病根（需求档 §二）：快照的容器曾是**团队级单槽**，而 prepare **整队覆写**它 ⇒ 换第二个
// 角色时第一个角色的撤销依据被抹掉。修法 = 团队行内部新增集合 `rotationBackups`
// （`[{ rid, at, backup }, …]`，顶层键零新增），四处读面按**本次换届的 rid** 取，
// 收尾只删自己那一条。旧单槽**读取时无损折叠**（D3），下一次换代写回时**吸收为 null**
// （§7：统一置 null，不采用 absorbedAt —— 只此一种吸收形态）。
// ===========================================================================

/** 旧槽（单槽）缺 `at` 时那条折叠条目的 rid —— **确定性、团队内唯一**，绝不 `legacy:undefined`
 * （设计档 §6 ② / 评审 🔵#3）。 */
function legacySlotRid(backup) {
	const at = typeof backup?.at === "number" && Number.isFinite(backup.at) && backup.at > 0 ? backup.at : 0;
	if (at <= 0) return "legacy:at-unknown";
	// ★ 审计修复：`at` 有限但**越界**（例如 1e20，超出 Date 的 ±8.64e15）时 toISOString
	// 会抛 RangeError —— 新 claim / sweep 路径会读到这条折叠条目，所以**绝不抛**，
	// 落到与「缺 at」相同的确定性键（设计档 §6 ② 的同一口径）。
	try {
		return `legacy:${new Date(at).toISOString()}`;
	} catch {
		return "legacy:at-unknown";
	}
}

/**
 * 一次换届的**稳定标识**（设计档 D2 / FR-Q1）：
 * ① 新形状：prepare 把 `rotationId` 写进该角色的 `pending`（行内字段，顶层键不变）⇒ 直接就是 rid；
 * ② 旧形状（**升级前就存在的 pending 里没有这个键**）：`legacy:<角色名>` —— 纯函数、确定性。
 *    折叠侧（{@link rotationEntriesOf}）与 claim 侧（`claim` 取撤销依据）**走同一条推导**，
 *    所以升级窗口里那次在飞换届照样取得到自己那份（Qr10 咬的就是这条全链路）。
 */
export function pendingRotationRid(entry) {
	const explicit = entry?.pending?.rotationId;
	if (typeof explicit === "string" && explicit !== "") return explicit;
	return `legacy:${entry?.role ?? ""}`;
}

/**
 * 一个团队**当下可见的全部撤销依据条目**（设计档 FR-Q1 / D3）。
 *
 * 新形状直接返回；旧单槽 ≠ null 时**读取时折叠**成一条（只发生在读取视图里，不重写历史档）：
 *   ① 该团队**恰有一个**角色持有 pending ⇒ 折成**它**那一份（rid = {@link pendingRotationRid}；
 *      升级前的 pending 因此得到 `legacy:<角色名>`，与 claim 侧推导逐字一致）；
 *   ② 0 个或多个 pending ⇒ 折成**独立条目**（rid = `legacy:<at ISO>`，缺 at 时
 *      `legacy:at-unknown`）—— **永不丢、也不猜归属**（读面照实列出；claim 找不到对应 rid
 *      就具名拒绝，绝不回退到「第一条 / 最近一条」）。
 * 若推导出的 rid 已被新形状里的条目占用（混合形状的手改行）：新形状**优先**（写面权威），
 * 旧槽改挂它自己的确定性键 `legacy:<at>` ⇒ 两份都不丢；连那个键都在场 ⇒ 确实已收在其名下，不再重复。
 */
export function rotationEntriesOf(team) {
	const entries = Array.isArray(team?.rotationBackups) ? team.rotationBackups : [];
	const legacy = team?.rotationBackup;
	if (legacy === null || legacy === undefined || typeof legacy !== "object") return entries;
	const pendingRoles = (Array.isArray(team.roles) ? team.roles : []).filter((record) => record?.pending !== null && record?.pending !== undefined);
	let rid = pendingRoles.length === 1 ? pendingRotationRid(pendingRoles[0]) : legacySlotRid(legacy);
	if (entries.some((entry) => entry.rid === rid)) rid = legacySlotRid(legacy);
	if (entries.some((entry) => entry.rid === rid)) return entries;
	const at = typeof legacy.at === "number" && Number.isFinite(legacy.at) ? legacy.at : 0;
	return [...entries, { rid, at, backup: legacy }];
}

/** 按 rid **精确**取一份撤销依据；找不到 ⇒ null（**不编造、也不借用别人的**）。 */
export function rotationEntryOf(team, rid) {
	if (typeof rid !== "string" || rid === "") return null;
	return rotationEntriesOf(team).find((entry) => entry.rid === rid) ?? null;
}

/**
 * 批 Q · FR-Q2：把**本次**换届的快照追加进集合（设计档 §6）。
 * 前置：team 是名册里的那一行；rid 来自本次 pending 的构造（绝不用「团队第一条」）。
 * 后置：entries 恰多一条 `{ rid, at, backup }`，**其它条目逐字节未动**（这就是「不覆盖别人」）；
 *       同 rid 重放 ⇒ 覆盖自己那一条，不产生第二条（幂等）；
 *       ★ 同一次写里**吸收旧槽**（`rotationBackup: null`）—— 折叠出来的那一份因此被**实体化**
 *       进集合（不丢），而旧槽不再是事实源（不复活）。
 */
export function appendRotationBackup(team, rid, backup, at) {
	const entries = rotationEntriesOf(team).filter((entry) => entry.rid !== rid);
	entries.push({ rid, at, backup });
	return { ...team, rotationBackups: entries, rotationBackup: null };
}

/**
 * 批 Q · FR-Q4：**只删自己那一条**（claim 成功 / 过期取消的收尾）。
 * ★ 必须在改动 `pending` **之前**调用：旧槽折叠的 rid 推导要看「当下有几个 pending」，
 *   顺序反了就会按另一个键去删（或把别人的折叠条目改名）。返回的团队行同样吸收旧槽。
 */
export function removeRotationBackup(team, rid) {
	return { ...team, rotationBackups: rotationEntriesOf(team).filter((entry) => entry.rid !== rid), rotationBackup: null };
}

/** 批 Q · FR-Q4：收尾 = 清 pending ＋ 只删本 rid 那条（**同一笔写**，与既有收尾同处）。 */
export function clearRotation(team, role, rid) {
	const without = removeRotationBackup(team, rid);
	return { ...without, roles: without.roles.map((entry) => (entry.role === role ? { ...entry, pending: null } : entry)) };
}

// ===========================================================================
// 批 S · 整队换届（批量准备）—— 批次状态、准入拆分与交接正文
//
// 判据与口径：docs/2026-10-18-team-rotation-requirements.md §四 Sr1–Sr20 ·
// docs/2026-10-18-team-rotation-design.md §5 FR-S1…S6 / §6 伪代码 / §7 schema · D1–D13。
// ★ 批次状态**只**住在团队行内部（`roles[].pending` 的 `batchId` / `batchRoles`）：policy.json 顶层
//   键集仍是十一键（NF-S4），不新增 `generation` 之类的顶层字段（会诊 #66 §3-⑤）。
// ===========================================================================

/** 某角色行 pending 里的批次标识，没有就是 `null`（D7：与 `rotationId` 同级）。 */
export function batchIdOfPending(entry) {
	const batchId = entry === null || entry === undefined || entry.pending === null || entry.pending === undefined ? undefined : entry.pending.batchId;
	return typeof batchId === "string" && batchId !== "" ? batchId : null;
}

/**
 * 团队里**在飞的那一个批次**（FR-S6 / 设计档 §9 的互斥判定面）：取所有「pending 带 batchId 且未过期」
 * 的角色，按第一个出现者的 batchId 归组。前置：纯读；`now` 是调用方的时钟。后置：没有 ⇒ `null`。
 * ★ 为什么以「未过期」为界：过期 pending 是清扫的活（逐角色取消），它不该继续封锁单角色换届 ——
 *   否则一个没人认领的批次会把整队锁满 2 小时。
 */
export function inFlightBatchOf(team, now) {
	const rows = (Array.isArray(team?.roles) ? team.roles : []).filter((entry) => batchIdOfPending(entry) !== null && entry.pending.expiresAt > now);
	if (rows.length === 0) return null;
	const batchId = batchIdOfPending(rows[0]);
	const same = rows.filter((entry) => batchIdOfPending(entry) === batchId);
	return { batchId, roles: same.map((entry) => entry.role), pendings: same.map((entry) => entry.pending), expiresAt: Math.max(...same.map((entry) => entry.pending.expiresAt)) };
}

/**
 * 一个批次的**角色清单**（批量写盘时写进每个 pending 的 `batchRoles`）。
 * 清单落在 pending 行内（NF-S4 允许的两个落点之一）：claim 成功会清掉该角色自己的 pending，
 * 但同批次**其它**角色的 pending 仍在 —— 读面靠它们的清单才能把「已认领」如实归到这一批，
 * 否则认领过的角色会凭空从批次里消失（Sr7 的 `k/N` 因此读得出来，而不是猜的）。
 */
export function batchManifestOf(team, batchId) {
	for (const entry of Array.isArray(team?.roles) ? team.roles : []) {
		if (batchIdOfPending(entry) !== batchId) continue;
		const manifest = Array.isArray(entry.pending.batchRoles) ? entry.pending.batchRoles : [];
		if (manifest.length > 0) return manifest;
	}
	return [];
}

/**
 * 读面按 `batchId` 分组的逐角色三态（FR-S5；沿用 `roster get` 的 pending 行，不新增工具）。
 * 状态词：`prepared`（pending 在、未到期）/ `expired`（pending 到期等清扫）/ `claimed`（pending 已清除、
 * 现任已是记录的继任者）/ `claimed-pending`（已落定但收尾未完成：`current` 已是继任者而 pending 还在）/
 * `unknown`（pending 已清、现任又不是记录的继任者 —— 被 set-role / 恢复 / **过期清扫取消**改过；**如实标未知，不猜**）。
 */
export function batchGroupsOf(team, now) {
	const ids = [];
	for (const entry of Array.isArray(team?.roles) ? team.roles : []) {
		const batchId = batchIdOfPending(entry);
		if (batchId !== null && !ids.includes(batchId)) ids.push(batchId);
	}
	const groups = [];
	for (const batchId of ids) {
		const rows = [];
		for (const item of batchManifestOf(team, batchId)) {
			const roleEntry = roleOf(team, item.role);
			const pending = roleEntry === null ? null : roleEntry.pending;
			const mine = pending !== null && pending !== undefined && batchIdOfPending(roleEntry) === batchId;
			const state = mine
				? pending.expiresAt > now
					? roleEntry.current === pending.session ? "claimed-pending" : "prepared"
					: "expired"
				: roleEntry !== null && roleEntry.current !== null && roleEntry.current === item.successor ? "claimed" : "unknown";
			rows.push({ role: item.role, successor: item.successor, state, expiresAt: mine ? pending.expiresAt : 0 });
		}
		const of = (wanted) => rows.filter((row) => row.state === wanted).length;
		groups.push({ batchId, total: rows.length, rows, prepared: of("prepared"), claimed: of("claimed") + of("claimed-pending"), expired: of("expired"), unknown: of("unknown") });
	}
	return groups;
}

/** 一个批次分组的**读面行**（`roster get` 的详情与 `roster.md` 镜像共用这一份渲染 —— 一处措辞）。 */
export function batchStateLines(group) {
	const label = (state) => {
		if (state === "prepared") return "已准备（令牌未认领）";
		if (state === "claimed") return "已认领（pending 已清除、现任已是继任者）";
		if (state === "claimed-pending") return "已认领（收尾未完成：现任已是继任者，pending 尚未清除）";
		if (state === "expired") return "已过期（令牌到期，等清扫逐角色取消 —— 旧任仍为 current）";
		return "状态不可得（pending 已清除，且现任不是本批次记录的继任者：被 set-role / 恢复 / 过期清扫取消改过；如实标未知）";
	};
	const lines = [`批次 ${group.batchId}：${group.total} 个角色 —— 已认领 ${group.claimed}/${group.total}、已准备 ${group.prepared}、已过期 ${group.expired}${group.unknown === 0 ? "" : `、状态不可得 ${group.unknown}`}`];
	for (const row of group.rows) lines.push(`  - 角色 ${row.role} → ${row.successor}：${label(row.state)}${row.expiresAt > 0 ? `（到期 ${readStamp(row.expiresAt)}）` : ""}`);
	return lines;
}

/**
 * 写前重读的**比对指纹**（D12）：**目标团队**的 `roles[].current/role`、各角色 `pending.rotationId`
 * 与 `policy.writer`。
 * 为什么含这三样：确认框可能等 3 分钟，期间别的写者（`set-role` / 别的换届 / 恢复）可能改过名册 ——
 * 用预热视图覆盖会静默抹掉别人的写。★ **pending 必须纳入**（交付评审 🟡#1）：确认期若该角色现任
 * 穿插发起一次单角色 prepare，批次写盘会按角色**单槽覆盖** `pending`、令那枚令牌静默作废；把它纳入
 * 指纹 ⇒ 这种穿插会令整批中止（fail-closed），而不是无声吃掉别人的令牌。
 * ★ **只覆盖目标团队**（交付评审 🟡#3）：批量写盘只改目标团队那一行，别的团队变动不该导致假中止。
 * 纯函数、确定性（团队按名字排序 ⇒ 夹具里 teams 数组顺序不影响读数）。
 */
export function rosterFingerprint(view, teamName) {
	const teams = (Array.isArray(view?.teams) ? view.teams : [])
		.filter((team) => teamName === undefined || team.name === teamName)
		.map((team) => ({
			name: team.name,
			writer: team.policy === null || team.policy === undefined ? "" : String(team.policy.writer ?? ""),
			roles: (Array.isArray(team.roles) ? team.roles : []).map((entry) => [entry.role, entry.current ?? null, entry.pending?.rotationId ?? null]),
		}));
	teams.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	return JSON.stringify(teams);
}

/** 单角色 `prepare` 撞上在飞批次时的**具名拒绝 + 指路**（FR-S6 / D8）。 */
export function singleRoleBatchBusyRefusal(team, busy, roleName, now) {
	return `prepare 被拒绝：团队 ${team.name} 有一个**整队换届批次**在飞（batch=${busy.batchId}，涉及角色 ${busy.roles.join("、")}，最晚到期 ${readStamp(busy.expiresAt)}）—— 批次的每个角色已有各自独立的 pending 与撤销依据，此时再接受单角色 prepare（角色 ${roleName}）会让同一角色出现两套来源不可辨的令牌与快照（D8：防「冻结风暴变形」）。指路：① 让本批次走完（各继任者本人按自己的令牌 claim；无人认领的由过期清扫逐角色取消并解除冻结）；② 确实要换人就等本批次结束后重发 action=prepare；③ 现任已死的救场场景走 team_link_recover（恢复路径不受本互斥限制）。`;
}

/** 批次在飞时**再发一次** `prepare-batch` 的具名拒绝（设计档 §9 末段）：列出该批次的逐角色进度。 */
export function batchInFlightRefusal(team, busy, now) {
	const group = batchGroupsOf(team, now).find((candidate) => candidate.batchId === busy.batchId);
	const lines = [
		`整队换届被拒绝：团队 ${team.name} 已经有一个批次在飞（batch=${busy.batchId}，涉及角色 ${busy.roles.join("、")}）—— 同一个团队同一时刻只允许一个整队换届批次（D8 / 设计档 §9：两套 pending 与撤销依据的来源不可辨）。`,
		"本批次当前进度（逐角色三态）：",
		...(group === undefined ? ["  - （该批次的 batchRoles 清单读不到：pending 行里没有它 —— 按「状态不可得」处理，不猜）"] : batchStateLines(group)),
		"指路：① 让本批次走完（各继任者本人凭各自令牌 action=claim；无人认领的令牌由过期清扫逐角色取消）；② 本批次结束后再发 action=prepare-batch。",
	];
	return lines.join("\n");
}

/**
 * 批 S · 自建继任者的交接正文（§11.9.6 五硬节；照 `reappoint`「自建继任者」的既有先例）。
 *
 * 为什么插件来写而不是调用方给：v1 不接受调用方提交的逐角色正文 —— 模型代写**别的角色**的交接
 * 是编造，不是交接（FR-S2 的设计裁定）。所以这里只从 roster 事实起笔，读不到的项**如实标未知**，
 * 与 `selfBuiltHandoffBody` 的诚实规则逐条一致（`§11.9.6`：只把关结构，不把关内容质量）。
 *
 * 五个节名来自入口的真源数组（`request.sections`，即 `HANDOFF_HARD_SECTIONS`）；本函数只按节名
 * **分派内容** —— 名单改名 ⇒ 这里分派不到 ⇒ 返回 `{ error }` ⇒ 预检整批拒绝（**不会静默降级**）。
 *
 * @returns `{ body }` 或 `{ error }`。
 */
export function batchHandoffBody(request) {
	const { teamName, roleName, incumbent, successor, caller, cwd, batchId } = request;
	const sections = Array.isArray(request.sections) && request.sections.length > 0 ? request.sections : [];
	if (sections.length === 0) return { error: "五个硬节的名单没有注入（HANDOFF_HARD_SECTIONS 缺席）——无法生成交接文档" };
	const goal = request.goal ?? { readable: false, reason: "goals 读数未采集" };
	const trust = request.trust ?? { pairs: 0, trustedSenders: 0, rememberTargets: 0 };
	const goalLine = goal.readable === true ? `- goals 服务读数（前任会话 ${incumbent}）：${goal.text}` : `- goals 服务：读不到（${goal.reason}）。`;
	const content = {
		mission: [
			`接管团队 ${teamName} 的角色 ${roleName}（本会话由插件在**整队换届批次 ${batchId}** 里新建：现任协调者 ${caller === undefined || caller === "" ? "（无会话身份）" : caller} 用一条 action=prepare-batch 命令为整队准备 Phase A，继任者候选由插件按 §10.2.2 铸造 id）。`,
			`- 前任会话（roster 事实）：${incumbent}`,
			`- 本会话 id / 标题：${successor}（按「<team> · <role>」派生）`,
			`- 本会话的工作目录：${cwd}`,
			"Phase B 一个不省：你要**本人**凭令牌 action=claim（批量不代认领、不代批准）。",
		],
		"in-flight": [
			`前任 ${incumbent} 的在飞工作对本插件不可读（本插件只读 roster 事实，不读会话正文），本节不做任何推测。`,
			goalLine,
		],
		commitments: [
			`该角色记在前任名下的信任指针（只报**存在性与数量**，不复制任何密钥素材）：pairs ${trust.pairs} 条 · trustedSenders ${trust.trustedSenders} 条 · rememberTargets ${trust.rememberTargets} 条。`,
			"迁移方式（§11.9.5）：这些信任**不在本次迁移** —— 你本人 claim 时逐项勾选要迁移的 pairs；无人值守（超时 / 无确认服务）则全部以 provisional 迁移，24h 内未获人类批准自动回退。",
		],
		unknowns: [
			"- 前任的进行中工作（未落盘的计划、正在跑的工具调用、未发出的消息）—— 不可读，本节不做推测。",
			"- 前任的会话正文与对话上下文 —— 本插件不读会话正文，交接文档不复制任何会话内容。",
			...(goal.readable === true ? ["- 前任 goal 的**正文与后续意图** —— goals 读数只有 phase / activation / rounds 三项，goal 正文不在本插件的读面上。"] : [`- 前任的 goal：${goal.reason}`]),
			"- 前任是否有未提交的代码改动、是否有别的会话在等它 —— 本插件无从观测（不在它的读面上）。",
			`- 同批次其它角色的交接正文：由插件各自生成，互相不可见（v1 不收调用方提交的逐角色正文）。`,
		],
		"task-and-goal": goal.readable === true
			? [
				`- 该角色的 goal（goals 服务读数，读自该角色前任的会话 ${incumbent}）：${goal.text}`,
				"- 该读数是**命令发出时刻的快照**（只有 phase / activation / rounds），不是它的计划；需要更完整的任务上下文时，由人类或在场的旧任补写本节。",
			]
			: [
				"- 该角色的任务与目标：**未知** —— goals 按 agent 取读数，这次没有拿到有效读数；本文件禁止编造。",
				"- 请由人类，或在场的旧任，补写这一节；插件只保证结构（五硬节在场且非空），不保证内容。",
			],
	};
	const lines = [];
	for (const name of sections) {
		const rows = content[name];
		if (rows === undefined) return { error: `交接正文的节名分派不到内容：${name}（与入口的 HANDOFF_HARD_SECTIONS 不同源）——拒绝生成，免得写出一个节名与内容错位的文档` };
		lines.push(`## ${name}`, ...rows, "");
	}
	return { body: lines.join("\n") };
}

/**
 * 批次级 `rotation-freeze`（D9）：**一条**，点名全部角色 ＋ batchId。
 * 逐角色各发一条是通知风暴（5 人队 = 5 条 freeze）；落定 / 取消（rotation-done / rotation-cancelled）
 * 仍**逐角色** —— 那是按角色归账的审计面，不能合并。
 */
export function batchFreezeNotice(teamName, batchId, roles, caller, now) {
	const named = roles.map((item) => `${noticeField(item.role)}→${noticeField(item.successor)}`).join("、");
	return `[rotation-freeze] 团队 ${noticeField(teamName)} 的**整队换届**（批次 ${noticeField(batchId)}）开始：发起会话 ${noticeField(caller)}，本次一次性准备 ${roles.length} 个角色（${named}，读数 ${readStamp(now)}）。冻结清单：① 停掉本会话的哨兵/看门狗与后台 job；② 确认没有在飞的动作（未完成的投递或工具调用）；③ 向协调者回报「状态已冻结」；④ 等待交接结果通知（每个角色各一条 rotation-done / rotation-cancelled）。冻结期间不要发起换届，也不要改动信任配置。Phase B 一个不省：每个继任者**本人**凭自己的令牌 claim。`;
}

/**
 * D11 的**执行期失败**读数：不再承诺零副作用 —— 已建会话**逐项点名**、pending / 撤销依据零写入、
 * 给幂等重试指路。`phase` 区分两处（`mint` = 某个角色的创建/文档失败；`recheck` = mint 循环之后、
 * 写盘之前的最后一次重读发现名册/写策略变了）。平台没有「删会话」原语 ⇒ **不做假补偿**
 * （会诊 #101 [1]-②）。
 *
 * ★ 分歧修复轮 🟡#1：**失败角色自己**的已建会话也要点名。`mint` 在「会话已创建之后」失败时返回
 * `{ error, sessionId, created: true }` —— 旧实现把它丢掉了，于是回执说「零新增会话」而盘上其实
 * 已经多了一个。创建**调用本身**失败则是 `created: false`（**attempted**，不是 created），单独一行
 * 如实说「未建成」，绝不混进「已建」清单。auto 路径在建会话前各写一条 `pendingCreates` 意图
 * （§10.2.6 既有纪律），所以「零写入」只能**限定在 pending / 撤销依据**上，意图的条数照样报出来。
 */
export function batchExecutionFailureReading(state) {
	const { phase, item, error, minted, failed } = state;
	const created = (Array.isArray(minted) ? minted : []).filter((entry) => entry.auto === true);
	const createdIds = created.map((entry) => entry.sessionId);
	const attemptedIds = [];
	if (phase !== "recheck" && failed !== null && typeof failed === "object" && typeof failed.sessionId === "string" && failed.sessionId !== "") {
		if (failed.created === true) createdIds.push(failed.sessionId);
		else attemptedIds.push(failed.sessionId);
	}
	const intents = created.length + (phase !== "recheck" && failed !== null && typeof failed === "object" && failed.intentWritten === true ? 1 : 0);
	const zeroWrite = `**pending/撤销依据零写入**（N 条 pending 与 N 份撤销依据是同一笔，从未落盘；本批已写 ${intents} 条 pendingCreates 意图 —— 它们已在盘上，启动清扫会把它们报进可收编清单）`;
	const lines = [];
	if (phase === "recheck") {
		lines.push(`整队换届中止（写前最后一刻重读，D12）：mint 循环期间团队名册或写策略已变 —— ${zeroWrite}，但本次已建的会话与已写的交接文档**不回滚**（D11：平台没有「删会话」原语，不做假补偿）。`);
	} else {
		lines.push(`整队换届中止（执行期失败，D11）：角色 ${item === undefined || item === null ? "（未知）" : item.roleName} 的继任者铸造失败 —— ${error}。${zeroWrite}；已建的会话与已写的交接文档**不回滚**。`);
	}
	if (createdIds.length === 0) lines.push("- 已建会话：本次没有（零新增会话）。");
	else lines.push(`- 已建会话（逐项点名 —— 它们已在盘上、可能已经被打开）：${createdIds.join("、")}`);
	if (attemptedIds.length > 0) lines.push(`- 已尝试但**未建成**的会话（创建调用失败；**不计入**「已建」）：${attemptedIds.join("、")}`);
	lines.push("- 幂等重试指路：确认原因消失后重跑 action=prepare-batch；已建的会话**可作为显式继任者**传回（successors=<角色>=<会话 id>），这样重试不会再建一批。本次没有任何 pending / 撤销依据落盘，所以重跑不会撞上「批次在飞」。");
	lines.push("- 交接文档：已写的保留（审计件，不作废）；本回执已逐项点名已建的会话，可据此收编或关闭。");
	return lines.join("\n");
}

/**
 * 批 S 的成功回执（FR-S5）：逐角色一行（继任者 / 令牌 / 交接文档 / 下一动作）＋ 批次汇总
 * `k/N 角色已准备` ＋ 一条 freeze ＋ N 份撤销依据 ＋ 镜像行。
 * 令牌明文**只在**这一处出现（与单角色 prepare 同一纪律：此后一律掩码）。
 */
export function batchReceiptLines(state) {
	const { teamName, batchId, minted, vacant, deliveries, notice, now, staleNote, keptBefore, mirrorLine } = state;
	const lines = [
		`整队换届（prepare-batch）：团队 ${teamName} 一次准备 ${minted.length} 个角色，批次 ${batchId}（读数 ${readStamp(now)}）。`,
		`- 批次汇总：${minted.length}/${minted.length} 角色已准备（0/${minted.length} 已认领 —— Phase B 逐个**本人**凭自己的令牌 claim，批量不代认领、不代批准）。`,
		"- 令牌时限：每枚 **2 小时**（单角色仍 30 分钟）；仍一次性、绑 (team, role, successor) 三元组、成功即作废。",
		"- 逐角色（**协调者自己的角色排在最后** —— 否则驱动批次的人先把自己换掉，后半批次成了孤儿驱动）：",
	];
	for (const item of minted) {
		lines.push(`  - ${item.roleName}：${item.incumbent} → ${item.successor}${item.auto === true ? "（插件自建）" : "（显式 id）"}`);
		lines.push(`    令牌（一次性，2 小时内有效，明文只在本条出现这一次）：${item.token}`);
		lines.push(`    此后一律掩码 ${maskToken(item.token)}（roster get 与 roster.md 镜像都只给掩码）；到期 ${readStamp(now + ROTATION_BATCH_TTL_MS)}。`);
		lines.push(`    交接文档：${item.documentPath === null || item.documentPath === undefined ? "（显式 id 路径：插件不生成交接文档 —— 请在壳里自行交接，并把令牌与本条回执交给它）" : item.documentPath}`);
		lines.push(`    下一动作：${item.successor} 本人调用 team_link_rotate action=claim，team=${teamName}，role=${item.roleName}，token=<上面那串>。`);
	}
	if (vacant.length > 0) lines.push(`- 跳过的角色（vacant，没有现任可换）：${vacant.join("、")} —— 本批次不含它们；要指定现任请用 team_link_roster action=set-role。`);
	lines.push(`- 撤销依据（本次批次 ${batchId}）：${minted.length} 份，逐角色一份、各以 rid 为键（${minted.map((item) => `${item.roleName}=${item.rotationId}`).join("、")}）；团队内另有 ${keptBefore} 条此前留存的快照原样保留（按换届各存一份，不整队覆写）。`);
	lines.push("- 写盘：N 条 pending ＋ N 份撤销依据在**恰一次** policy.update 里落盘（预检 / 确认失败则一次都没有）。");
	lines.push(`- 冻结广播（**一条**批次级 rotation-freeze，点名全部角色）：${notice.summary}`);
	lines.push(...notice.rows);
	if (Array.isArray(deliveries) && deliveries.length > 0) {
		lines.push("- 自建继任者的投递（§11.4.5 的 followup，不是 inject）：");
		lines.push(...deliveries);
	}
	lines.push(`- 批次进度读面：team_link_roster action=get team=${teamName}（按 batchId 分组报「已准备 / 已认领 / 已过期」逐角色三态；roster.md 镜像同源）。`);
	lines.push(mirrorLine ?? "");
	lines.push(`（读数 ${readStamp(now)}，${staleNote}）`);
	return lines;
}

// --- internal notices (§3.6.2 "内部广播路径") -------------------------------
// Four bodies, all plugin constants: only status fields (team, role, session
// ids, reading time) are interpolated, and every interpolated identifier passes
// `noticeField` first. No model-supplied text (a `note`, a message body) can
// reach a notice, so a notice can never smuggle a prompt into a peer's next
// request — the same red line the watchdog tick body is built on.


/** The pairs one provisional window actually has to roll back (§3.6.2 评审 #2):
 * still provisional, already past their deadline, and granted to THIS window's
 * successor — the exact shape a rotation migration writes. An empty result means
 * the window has nothing to roll back (its pairs were ratified in the settings UI,
 * or the migration never created one), which is what makes the rotation-expired
 * notice and the "provisional 未批准过期" history entry false in that state. Pure. */
export function doomedProvisionalPairs(pairs, successor, now) {
	// The expiry half is {@link isExpiredProvisionalPair} (评审 #8) — one definition
	// of "past its deadline" for the window query, the delivery-side gate and the
	// sweep's unconditional deletion.
	return pairs.filter((pair) => isExpiredProvisionalPair(pair, now) && (pair.a === successor || pair.b === successor));
}

/** rotation-freeze: the freeze check-list is plugin constant text (§4.2). */
export function freezeNotice(team, role, caller, successor, now) {
	return `[rotation-freeze] 团队 ${noticeField(team)} 的角色 ${noticeField(role)} 开始换届（发起会话 ${noticeField(caller)}，继任者 ${noticeField(successor)}，读数 ${readStamp(now)}）。冻结清单：① 停掉本会话的哨兵/看门狗与后台 job；② 确认没有在飞的动作（未完成的投递或工具调用）；③ 向协调者回报「状态已冻结」；④ 等待交接结果通知（rotation-done / rotation-cancelled）。冻结期间不要发起换届，也不要改动信任配置。`;
}


/** rotation-done: `status` is the ratified / provisional / no-candidate verdict of
 * the claim. The three verdicts carry three different sentences: the middle one
 * claims a rollback window that does not exist when nothing was migrated (§3.6.2
 * 评审 #5), so it must not be reached by the no-candidate status. */
export function doneNotice(team, role, previous, successor, status, now) {
	const verdict = status === "已批准"
		? "迁移的 pairs 已是正式通道（旧任持有的 pairs/trustedSenders/rememberTargets 已对称吊销）。"
		: status === ROTATION_STATUS_NONE
			? "本次换届域内没有待迁移的通道（未弹确认框，也没有 provisional 回退窗口）：退役者持有的 pairs/trustedSenders/rememberTargets 已对称吊销，团队内不需要重建任何通道。"
			: "迁移的 pairs 是 provisional 通道：24h 内未获批准将自动回退为过门投递，期间经该通道投递的消息不可回收（§3.6.1 诚实声明）。";
	return `[rotation-done] 团队 ${noticeField(team)} 的角色 ${noticeField(role)} 换届完成（读数 ${readStamp(now)}）：旧任 ${noticeField(previous)} → 新任 ${noticeField(successor)}；信任迁移状态：${status}。${verdict}`;
}


/** rotation-cancelled: a token nobody claimed inside its 30 minutes (§3.6.2 评审 #4). */
export function cancelledNotice(team, role, incumbent, caller, now) {
	return `[rotation-cancelled] 团队 ${noticeField(team)} 的角色 ${noticeField(role)} 的换届令牌过期未认领（发起会话 ${noticeField(caller)}，清扫读数 ${readStamp(now)}）：旧任 ${noticeField(incumbent)} 仍为 current（换届未发生），解除冻结——本条通知即解冻信号。需要换人请由现任重新 prepare。`;
}


/** rotation-expired: the 24h ratification window closed unapproved (§3.6.2 评审 #5). */
export function expiredNotice(team, role, successor, now) {
	return `[rotation-expired] 团队 ${noticeField(team)} 的角色 ${noticeField(role)} 的 provisional 信任迁移 24h 内未获批准，已自动回退（清扫读数 ${readStamp(now)}）：迁移的 pairs 已删除，${noticeField(successor)} 仍为 current（换届事实已成立，降格需用户显式操作），此后投递按正常过门（首问门）处理。`;
}


/** One-line summary of a notice's delivery rows. */
export function noticeSummary(rows) {
	const count = (wanted) => rows.filter((row) => row.includes(`→ ${wanted}`)).length;
	return `${count("delivered")} 投递 / ${count("refused")} 拒绝 / ${count("no-agent")} 无活动代理`;
}


/** The ONE rendering of a provisional window's deadline (§3.6.2 评审 #5). Three
 * read faces have to name the same instant and they must never each compute their
 * own: the claim's guidance sentence, the hand-over document's 事实段, and the
 * unattended reading below (缺口1) that has to stand on its own. */
export function provisionalWindowExpiry(now) {
	return readStamp(now + ROTATION_PROVISIONAL_TTL_MS);
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
export function unattendedClaimReading(state) {
	const { dialog, count, now } = state;
	const migrated = `全部 ${count} 条域内候选以 provisional 迁移`;
	if (dialog.cause !== ROTATION_DIALOG_CAUSES.TIMEOUT) return `${dialog.reason}（${migrated}。）`;
	return `${dialog.detail}——这不是「调用失败」：已按设计（§3.6.1 原则 4 的无人值守分支）把${migrated}，并已落盘（换届已成立、旧任信任已对称吊销；重试或等待都不会撤销它，也不必重试）。回退窗口 ${provisionalWindowExpiry(now)} 到期；到期前由人类在设置 UI 把该 pair 的 provisional 置 false 即转正式（attended-only：插件与模型都不能代批）。`;
}


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
export function createRotation(ctx, policy, extras = {}) {
	// ★ 批 R 第 5 小单（域拆分 · 依赖注入；先例 = `forensics.js` 的 `wireForensics()`）：
	//   域档**不许**导入入口 `lib/index.js`（那会构成 ESM 环），而下面这几条出口住在入口那一档
	//   —— 名册镜像（`writeRosterMirror` / `mirrorNote`）、读数脚注 `READ_STALE_NOTE`、投递面
	//   `deliverToTarget`、以及 §11.9.6 同源锁钉在入口的三条渲染出口（`rotationFactRows` /
	//   `provisionalGuidance`，见档头）—— 全部由入口在构造时注入。缺席时每条都退回一条**既有**
	//   读法（不是新文案）：镜像退回 `mirrorNote` 的失败文案原型、脚注退回它自己的字面量。
	//   ★ §11.5 的持久证据读面（`handoffDocumentNamesLatest` 那条链）**不走注入** —— 它随本档
	//   一起搬（判据面直接按名调 `successorOwnershipOf`，没有缝可给）。
	const mirrorWriter = extras.mirrorWriter ?? {
		write: async () => ({ ok: false, error: "没有可用的名册镜像写面（本激活未注入）" }),
		note: (mirror) => `（注意：roster.md 镜像写入失败——${mirror.error}。settings 是本插件的事实源，本次变更已生效；镜像会在下一次 roster 变更时重试，也可手工从设置重建。）`,
	};
	const readStaleNote = typeof extras.readStaleNote === "string" ? extras.readStaleNote : ">2min 作废";
	const deliver = extras.deliver;
	const factRows = extras.factRows;
	const guidelines = extras.provisionalGuidance;
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
				const outcome = await deliver(ctx, policy, { id: senderId }, { signal: options.signal }, target, text, null, {
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
		// 批 Q · FR-Q1 / D2：本次换届的稳定标识。**单一来源**是这次 prepare 铸出来的
		// `rotationId`（行内字段，顶层键不变）；claim 侧按它精确取回本次那一份撤销依据。
		// 为什么不是复用既有字段：`token` 是秘密（任何读面都只给掩码，拿它当 rid 会把明文
		// 带进镜像/状态卡）；`session` 是**继任者**（同一会话可以被指定为两个角色的继任者 ⇒
		// 用它当键会让第二个角色的 prepare 覆盖第一个 —— 正是本批要消灭的那个错）；`createdAt`
		// 既非唯一也不与「哪一路 pending」绑定。旧形状（升级前的 pending）走确定性推导
		// `legacy:<角色名>`（{@link pendingRotationRid}）。
		const rid = `rot-${now.toString(36)}-${randomUUID().slice(0, 8)}`;
		const pending = { session: successor, token, team: teamName, role: roleName, rotationId: rid, expiresAt: now + ROTATION_TTL_MS, createdAt: now, migratedPairs: [] };
		if (note !== undefined) pending.note = note;
		const backup = {
			at: now,
			pairs: view.pairs.map((pair) => ({ ...pair })),
			trustedSenders: [...view.trustedSenders],
			rememberTargets: [...view.rememberTargets],
			roster: structuredClone(team),
		};
		// 批 Q · FR-Q2：**追加**本次条目，不再整队覆写单槽（同一次写里吸收旧槽 —— 见 D5/§7）。
		// 「本次之前还有几条在飞」是**写前**读数，只为回执如实报出「没有覆盖别人」。
		const keptBefore = rotationEntriesOf(team).length;
		const withEntry = appendRotationBackup(team, rid, backup, now);
		const nextTeam = { ...withEntry, roles: withEntry.roles.map((record) => (record.role === roleName ? { ...record, pending } : record)) };
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
		const mirror = await mirrorWriter.write(mergedTeam);
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
				`撤销依据（本次换届 rid=${rid}）：已快照 ${now} 时的 pairs ${backup.pairs.length} 条 / trustedSenders ${backup.trustedSenders.length} 项 / rememberTargets ${backup.rememberTargets.length} 项与 roster；团队内另有 ${keptBefore} 条在飞快照原样保留（按换届各存一份，不再整队覆写单槽）。`,
				`冻结广播（rotation-freeze 固定清单）：${notice.summary}`,
				...notice.rows,
				mirrorWriter.note(mirror),
			],
		};
	}
	/**
	 * 批 S · 整队换届的**唯一一道**确认框（D4 / §11.4.1 同款）：逐行 `角色 → 继任者`，无服务 / 取消 /
	 * 超时一律 fail-closed（批量入口**没有**无人值守变体 —— provisional 只属 claim 段）。
	 */
	async function askBatchDialog(request) {
		const userQuestions = ctx.get?.("userQuestions");
		if (userQuestions === undefined || userQuestions === null || typeof userQuestions.ask !== "function") {
			return { confirmed: false, reason: "确认服务（userQuestions）不可用 —— 整队换届会一次改 N 个角色的身份（并在 auto 路径建 N 个会话），无确认即不执行（fail-closed，§11.4.1）" };
		}
		const rows = request.plan.map((item, index) => `${index + 1}. ${item.roleName}：${item.incumbent} → ${item.successor}${item.auto === true ? "（插件自建；候选由插件铸造，模型不可指定）" : "（显式 id：交接文档不由插件生成，请自行交接）"}`);
		const text = [
			`即将整队换届（action=prepare-batch）：团队 ${request.teamName} 一次准备 ${request.plan.length} 个角色，批次 ${request.batchId}。`,
			"- 逐角色（**协调者自己的角色排在最后** —— 否则驱动批次的人先把自己换掉，后半批次成了孤儿驱动）：",
			...rows.map((row) => `  ${row}`),
			`- 令牌：每个角色一枚，绑定 (team, role, successor) 三元组、**一次性**、TTL **2 小时**（批量比单角色的 30 分钟长：N 个继任者要各自找时间认领；代价如实：可用窗口变长，故仍成功即作废）。`,
			"- 写盘：N 条 pending ＋ N 份撤销依据在**一次** policy.update 里落盘；广播**一条**批次级 rotation-freeze（点名全部角色）。",
			"- Phase B 一个不省：每个继任者仍**本人**凭自己的令牌 claim（逐项勾选要迁移的 pairs；无人值守则 provisional ＋ 24h 回退）—— 批量不代认领、不代批准。",
			`- 选「${ROTATION_BATCH_CANCEL_LABEL}」= 什么都不做：零建会话、零令牌、本动作零写入（入口的过期清扫除外）、零广播。`,
		].join("\n");
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
					id: ROTATION_BATCH_DIALOG_ID,
					header: "整队换届确认",
					question: wellFormed(text),
					detail: wellFormed(`一次确认覆盖：${request.plan.length} 个角色各一枚令牌、各一份撤销依据、一条批次级 rotation-freeze；不覆盖任何信任迁移（那是每个继任者 claim 时自己的确认框）。`),
					options: [
						{ label: ROTATION_BATCH_CONFIRM_LABEL, description: `一次准备 ${request.plan.length} 个角色（令牌 2 小时有效；信任迁移仍要各继任者 claim 时逐项确认）` },
						{ label: ROTATION_BATCH_CANCEL_LABEL, description: "什么都不做：零建会话、零令牌、本动作零写入（入口的过期清扫除外）、零广播" },
					],
				}],
				agent: request.agent,
				signal: controller.signal,
			});
			const item = Array.isArray(answer?.answers) ? answer.answers.find((entry) => entry?.id === ROTATION_BATCH_DIALOG_ID) : undefined;
			if (item === undefined || !Array.isArray(item.selected)) return { confirmed: false, reason: "确认框没有返回本次整队换届问题的答案" };
			if (!item.selected.includes(ROTATION_BATCH_CONFIRM_LABEL)) return { confirmed: false, reason: `用户在确认框里选择了「${item.selected.join("、") || "（未选择）"}」` };
			return { confirmed: true };
		} catch (error) {
			return { confirmed: false, reason: timedOut ? "确认框 3 分钟内未获确认（按取消处理）" : `确认框失败（${describeError(error)}）` };
		} finally {
			clearTimeout(timer);
			request.signal?.removeEventListener?.("abort", forward);
		}
	}

	/**
	 * 批 S · 整队换届的 Phase A（FR-S1…FR-S6 / D1…D13）。
	 *
	 * 前置：`caller` 是团队**现任协调者**（工具层先查 writer gate，这里再查发起权 —— D10 的两道门）；
	 *       确认服务可用（否则 fail-closed）；`extras.batch` 是入口注入的执行面（建会话 / 写交接文档 /
	 *       投递 / 在场探针 / 事实读数 —— 见入口的 `batchExtras()`）。
	 * 后置（成功）：团队行里 **N 条** pending 各带 `{ rotationId, batchId, batchRoles }` 与
	 *   `expiresAt = now + ROTATION_BATCH_TTL_MS`；`rotationBackups` 恰增 N 条（每角色一条，互不覆盖）；
	 *   **恰一次** `policy.update`；**恰一条**批次级 rotation-freeze；回执逐角色一行。
	 * 后置（预检失败 / 确认前中止）：**零** agents.create、**零** policy.update、**零**广播。
	 * 后置（确认后执行期失败，D11）：**不再承诺零副作用** —— 已建会话逐项点名、policy 不写。
	 *
	 * @returns `{ lines }` 或 `{ error }`。
	 */
	async function prepareBatch(request) {
		const { teamName, successors, auto, note, caller, now, signal, agent, cwd, roleGiven } = request;
		const batch = extras.batch;
		// ★ 分歧修复轮 🟡#3（本仓判例：参数误用一律拒绝）：`prepare-batch` 是**整队**动作，不收 `role`。
		//   守卫放在**域这里**（工具层只把参数原样传进来 `roleGiven`），与 `successors` / `successor:"auto"`
		//   的参数校验同住一处；否则一个多填的 `role` 会被静默忽略、被读成「整队换届」—— 误用的放大。
		if (roleGiven !== undefined && roleGiven !== null && String(roleGiven).trim() !== "") {
			return { error: `整队换届被拒绝（参数误用）：action=prepare-batch 是**整队**动作，**不收 role**（当前收到 ${preview(String(roleGiven), 60)}）—— 单角色换届请用 action=prepare；批量要指定继任者请用 successors="角色=会话 id, …" 或 successor:"auto"。本次零建会话、零令牌、本动作零写入（入口的过期清扫除外）、零广播。` };
		}
		// ★ FR-S2 的设计裁定：**v1 不接受调用方提交的逐角色交接正文** —— 模型代写**别的角色**的交接
		//   是编造，不是交接。所以给的正文不被静默丢弃，而是**具名拒绝**（零副作用）。
		if (request.handoffGiven === true) {
			return { error: "整队换届被拒绝：v1 **不接受调用方提交的交接正文**（handoff）—— auto 角色的正文由**插件从 roster 事实生成**（读不到的项如实标未知，照 reappoint 先例）；模型代写别的角色的交接是编造，不是交接（FR-S2）。显式 id 路径**不生成**交接文档，交接由你完成。本次零建会话、零令牌、本动作零写入（入口的过期清扫除外）、零广播。" };
		}
		const autoPath = auto === true;
		if (batch === undefined || batch === null || typeof batch !== "object") {
			return { error: `整队换届失败：本激活没有注入批量执行面（建会话 / 交接文档 / 在场探针）—— 本动作整批不执行，零副作用。` };
		}
		const view = policy.get();
		const team = view.teams.find((entry) => entry.name === teamName) ?? null;
		if (team === null) return { error: `整队换届失败：团队 ${teamName} 不在注册表中（先用 team_link_roster action=upsert-team 创建）。` };
		// 1) 发起权（D10 / NF-S3）：该队的**现任协调者** —— 与 writer gate 是两道独立的门，
		//    writer=any 也不放宽这一条（「任一成员可发起」是设计明确不做的那一档）。
		const coordinatorEntry = roleOf(team, COORDINATOR_ROLE);
		const seatedCoordinator = coordinatorEntry === null ? null : coordinatorEntry.current;
		if (seatedCoordinator === null) {
			return { error: `整队换届被拒绝：团队 ${teamName} 的 coordinator 角色当前空缺（current=null）—— 发起权不成立（选择「整队换届」的人必须是现任协调者）。请由用户经设置 UI（设置命名空间 team-link 的 teams 键）指定现任协调者后再换。` };
		}
		if (caller === undefined || caller !== seatedCoordinator) {
			return { error: `整队换届被拒绝：只有**现任协调者会话** ${seatedCoordinator} 可以发起整队换届（当前调用会话 ${caller ?? "（无会话身份）"}）。★ 逐角色 prepare 的发起权仍属**该角色的现任**（两门不混，D10：批量授权是独立入口，单角色的现任门一个字都没动）；用户路径是设置 UI 的 teams 键，不是工具调用（§3.6.2）。` };
		}
		// 2) 批次互斥（设计档 §9 末段）：同一时刻只允许一个批次。
		const busy = inFlightBatchOf(team, now);
		if (busy !== null) return { error: batchInFlightRefusal(team, busy, now) };
		// 3) 角色序列：**协调者自己的角色排最后**（D6）；vacant 角色如实跳过（没有现任可换）。
		const seated = team.roles.filter((entry) => entry.current !== null);
		const vacant = team.roles.filter((entry) => entry.current === null).map((entry) => entry.role);
		if (seated.length === 0) {
			return { error: `整队换届失败：团队 ${teamName} 没有任何在位的角色（全部 vacant）—— 没有可以「换下」的现任。请用 team_link_roster action=set-role 指定现任后再发。` };
		}
		const ordered = [...seated.filter((entry) => entry.role !== COORDINATOR_ROLE), ...seated.filter((entry) => entry.role === COORDINATOR_ROLE)];
		const batchId = `bat-${now.toString(36)}-${randomUUID().slice(0, 8)}`;
		const rid = () => `rot-${now.toString(36)}-${randomUUID().slice(0, 8)}`;
		// 4) 逐角色预检（all-or-nothing；这一段的每一步都**零副作用**）
		const plan = [];
		const failures = [];
		// ★ 分歧修复轮 🟡#3：`successors` 里的**未知角色键**与**重复键**也是参数误用（旧实现静默丢弃）。
		//   重复键在入口的解析器里就拒绝（对象字面量会覆盖，域里看不见）；未知键在这里拒绝 —— 名册是事实源。
		if (!autoPath && successors !== null && typeof successors === "object") {
			const knownRoles = new Set(team.roles.map((entry) => entry.role));
			const unknown = Object.keys(successors).filter((role) => !knownRoles.has(role));
			if (unknown.length > 0) failures.push(`- successors 里的角色键 ${unknown.map((role) => `「${preview(role, 60)}」`).join("、")} 不在团队 ${teamName} 的名册里（已知角色：${team.roles.map((entry) => entry.role).join("、") || "（无）"}）—— 参数误用一律拒绝，不静默丢弃。`);
		}
		for (const entry of ordered) {
			if (autoPath) {
				const made = typeof batch.sessionFor === "function" ? batch.sessionFor(teamName, entry.role) : null;
				if (typeof made !== "string" || made === "") {
					failures.push(`- 角色 ${entry.role}：无法铸造继任者会话 id（批量铸造缝缺 sessionFor）`);
					continue;
				}
				plan.push({ roleName: entry.role, incumbent: entry.current, successor: made, auto: true, rotationId: rid() });
				continue;
			}
			const successor = successors !== null && typeof successors === "object" ? successors[entry.role] : undefined;
			if (typeof successor !== "string" || successor.trim() === "") {
				failures.push(`- 角色 ${entry.role}：没有给出继任者（successors 里缺 ${entry.role}=<会话 id>；v1 不做混合批次：全 auto 用 successor:"auto"，全显式用 successors）`);
				continue;
			}
			plan.push({ roleName: entry.role, incumbent: entry.current, successor: successor.trim(), auto: false, rotationId: rid() });
		}
		if (failures.length > 0) return { error: `整队换届被拒绝（预检 all-or-nothing；本次零建会话、零令牌、本动作零写入（入口的过期清扫除外）、零广播）：\n${failures.join("\n")}` };
		// ★ Sr15：显式继任者的**在场校验**（预检期、零副作用）。一次宿主读拿到「活代理 ∪ 盘上会话」
		//   的 id 集合，再逐个比对 —— 读不出来就 fail-closed（宁可不换，也不铸一枚指向未知会话的令牌）。
		let presentIds = null;
		if (!autoPath) {
			if (typeof batch.existingSessions !== "function") {
				return { error: "整队换届被拒绝：本激活没有会话在场读面（batch.existingSessions 缺席）—— 显式继任者无法校验是否真实存在，按 fail-closed 整批不换。本次零副作用。" };
			}
			const existing = await batch.existingSessions();
			if (existing === null || typeof existing !== "object" || existing.error !== undefined || !(existing.ids instanceof Set || Array.isArray(existing.ids))) {
				return { error: `整队换届被拒绝：会话列表读不到（${existing !== null && typeof existing === "object" && existing.error !== undefined ? existing.error : "宿主没有可用的会话列表读面"}）—— 显式继任者的在场无法校验，按 fail-closed 整批不换（宁可不换，也不铸一枚指向未知会话的令牌）。本次零副作用。` };
			}
			presentIds = existing.ids instanceof Set ? existing.ids : new Set(existing.ids);
		}
		/** 显式继任者的在场探针（同步，喂 {@link admissionChecks}）：不在集合里 ⇒ 具名拒绝。 */
		const presenceOf = (id) => (presentIds !== null && presentIds.has(id)
			? { ok: true }
			: { error: `prepare 失败：显式继任者 ${id} 不是一个存在的会话（活代理注册表与会话列表里都没有它）—— 整批拒绝（Sr15）：令牌只铸给真实存在的会话，预检期零副作用。请先用 team_link_list_sessions 取到正确的会话 id，或在壳里新建一个会话后重发。` });
		for (const item of plan) {
			const admission = admissionChecks(view, {
				teamName, roleName: item.roleName, successor: item.successor, now,
				...(item.auto === true ? {} : { successorPresent: presenceOf }),
			});
			if (admission.error !== undefined) {
				failures.push(`- 角色 ${item.roleName}：${admission.error}`);
				continue;
			}
			if (item.auto !== true) continue;
			// auto：交接文档由**插件从 roster 事实生成**（v1 不收调用方正文）—— 先试生成一次，
			// 五硬节必须齐全；生成失败 / 缺硬节 ⇒ 整批拒绝（Sr4 的红相就是「生成失败照建」）。
			const facts = typeof batch.facts === "function" ? await batch.facts({ team, incumbent: item.incumbent }) : null;
			if (facts === null || typeof facts !== "object" || facts.error !== undefined) {
				failures.push(`- 角色 ${item.roleName}：交接文档无法生成（${facts !== null && typeof facts === "object" && facts.error !== undefined ? facts.error : "事实读数缺席"}）`);
				continue;
			}
			const rendered = batchHandoffBody({ teamName, roleName: item.roleName, incumbent: item.incumbent, successor: item.successor, caller, cwd: facts.cwd ?? cwd, batchId, sections: batch.sections, goal: facts.goal, trust: facts.trust });
			if (rendered.error !== undefined) {
				failures.push(`- 角色 ${item.roleName}：交接文档无法生成（${rendered.error}）`);
				continue;
			}
			const report = typeof batch.handoffReport === "function" ? batch.handoffReport(rendered.body) : null;
			const missing = report === null ? ["无法校验（handoffBodyReport 缺席）"] : [...report.missingHard, ...report.emptyHard.map((name) => `${name}（空）`)];
			if (missing.length > 0) {
				failures.push(`- 角色 ${item.roleName}：交接文档缺硬节 ${missing.join("、")}`);
				continue;
			}
		}
		if (failures.length > 0) return { error: `整队换届被拒绝（预检 all-or-nothing；本次零建会话、零令牌、本动作零写入（入口的过期清扫除外）、零广播）：\n${failures.join("\n")}` };
		// 2.5) 预热指纹（D12）：确认框前后各比对一次。
		const fingerprint = rosterFingerprint(view, teamName);
		// 3) **一道**确认框（无服务 / 取消 / 超时 ⇒ 零副作用）。
		const dialog = await askBatchDialog({ plan, teamName, batchId, agent, signal });
		if (dialog.confirmed !== true) {
			return { lines: [`未发起整队换届（action=prepare-batch）：${dialog.reason}。本次零建会话、零令牌、本动作零写入（入口的过期清扫除外）、零广播 —— 批量入口没有无人值守变体（§11.4.1 的确认是必经之门）。`] };
		}
		// 3.5) 写前重读（D12）：确认期间名册 / 写策略变了 ⇒ 整批中止、零写入。
		const freshView = policy.get();
		if (rosterFingerprint(freshView, teamName) !== fingerprint) {
			return { error: `整队换届中止（写前重读 D12）：确认框期间团队名册或写策略已变（指纹不一致）—— 本次零建会话、零令牌、本动作零写入（盘上零改动；入口的过期清扫除外）、零广播。请用最新的 roster 重跑 action=prepare-batch。` };
		}
		const freshTeam = freshView.teams.find((entry) => entry.name === teamName) ?? null;
		if (freshTeam === null) {
			return { error: `整队换届中止（写前重读 D12）：团队 ${teamName} 已不在注册表中 —— 本次零建会话、零令牌、本动作零写入（盘上零改动；入口的过期清扫除外）、零广播。` };
		}
		// 4) 执行期（D11）：auto ⇒ 建会话 ＋ 写交接文档；令牌在内存里铸好，盘上一次落。
		const minted = [];
		for (const item of plan) {
			const token = randomUUID();
			const entry = { ...item, token };
			let made;
			try {
				made = item.auto === true
					? await batch.mint({ teamName, team: freshTeam, roleName: item.roleName, incumbent: item.incumbent, successor: item.successor, token, now, caller, signal, renderBody: (facts) => batchHandoffBody({ teamName, roleName: item.roleName, incumbent: item.incumbent, successor: item.successor, caller, cwd: facts?.cwd ?? cwd, batchId, sections: batch.sections, goal: facts?.goal, trust: facts?.trust }) })
					: { sessionId: item.successor };
			} catch (error) {
				return { error: batchExecutionFailureReading({ phase: "mint", item: entry, error: describeError(error), minted }) };
			}
			if (made === null || typeof made !== "object" || made.error !== undefined) {
				return { error: batchExecutionFailureReading({ phase: "mint", item: entry, error: made !== null && typeof made === "object" && made.error !== undefined ? made.error : "铸造缝返回了非对象", minted, failed: made }) };
			}
			minted.push({ ...entry, sessionId: typeof made.sessionId === "string" && made.sessionId !== "" ? made.sessionId : item.successor, documentPath: made.documentPath ?? null, body: typeof made.body === "string" ? made.body : null, approvalLine: made.approvalLine ?? null, inheritance: Array.isArray(made.inheritance) ? made.inheritance : [], title: made.title });
		}
		// 4.5) 写前**最后一刻再读一次**（D12 的残余窗口：mint 循环里有 N 次 await）。
		const finalView = policy.get();
		const finalTeam = finalView.teams.find((entry) => entry.name === teamName) ?? null;
		if (rosterFingerprint(finalView, teamName) !== fingerprint || finalTeam === null) {
			return { error: batchExecutionFailureReading({ phase: "recheck", minted }) };
		}
		// 5) **一次写盘**：N 条 pending（rotationId ＋ batchId ＋ batchRoles ＋ 2h）＋ N 份撤销依据。
		const manifest = minted.map((item) => ({ role: item.roleName, successor: item.successor }));
		let nextTeam = finalTeam;
		for (const item of minted) {
			const pending = { session: item.successor, token: item.token, team: teamName, role: item.roleName, rotationId: item.rotationId, batchId, batchRoles: manifest, expiresAt: now + ROTATION_BATCH_TTL_MS, createdAt: now, migratedPairs: [] };
			if (note !== undefined) pending.note = note;
			const backup = { at: now, pairs: finalView.pairs.map((pair) => ({ ...pair })), trustedSenders: [...finalView.trustedSenders], rememberTargets: [...finalView.rememberTargets], roster: structuredClone(finalTeam) };
			nextTeam = appendRotationBackup(nextTeam, item.rotationId, backup, now);
			nextTeam = { ...nextTeam, roles: nextTeam.roles.map((record) => (record.role === item.roleName ? { ...record, pending } : record)) };
		}
		try {
			await policy.update({ teams: finalView.teams.map((record) => (record.name === teamName ? nextTeam : record)) });
		} catch (error) {
			return { error: `整队换届失败：写入设置失败（${describeError(error)}）—— **pending/撤销依据零写入**（N 条 pending 与 N 份撤销依据是同一笔；本批已写 ${minted.filter((item) => item.auto === true).length} 条 pendingCreates 意图 —— 它们已在盘上），但本次已建的会话与已写的交接文档**不回滚**（平台没有「删会话」原语，D11）：${minted.filter((item) => item.auto === true).map((item) => item.sessionId).join("、") || "（本次没有自建会话）"}。幂等重试指路：设置服务恢复后重跑 action=prepare-batch；已建的会话可显式作为 successors 传回，避免再建一批。` };
		}
		const mirror = await mirrorWriter.write(nextTeam);
		// 6) **一条**批次级 freeze（D9）。
		const notice = await broadcastNotice(teamName, caller, batchFreezeNotice(teamName, batchId, minted.map((item) => ({ role: item.roleName, successor: item.successor })), caller, now), { signal });
		// 7) 自建继任者：写盘之后投递（§11.4.5 的 followup，不是 inject）。
		const deliveries = [];
		for (const item of minted) {
			if (item.auto !== true) continue;
			if (typeof batch.deliver !== "function") {
				deliveries.push(`  - ${item.roleName} → ${item.sessionId}：投递面缺席 —— 令牌已生效但继任者没收到，可把交接文档与令牌重新交给它。`);
				continue;
			}
			try {
				const sent = await batch.deliver({ team: nextTeam, roleName: item.roleName, incumbent: item.incumbent, successor: item.sessionId, token: item.token, documentPath: item.documentPath, body: item.body, caller, signal });
				deliveries.push(sent !== null && typeof sent === "object" && sent.delivered === true
					? `  - ${item.roleName} → ${item.sessionId}：已用 followup 把令牌与交接正文投给它（不是 inject —— 任务需要驱动）`
					: `  - ${item.roleName} → ${item.sessionId}：投递失败（${sent !== null && typeof sent === "object" && sent.error !== undefined ? sent.error : "未知原因"}）—— 令牌已生效但继任者没收到，可把交接文档与令牌重新交给它`);
			} catch (error) {
				deliveries.push(`  - ${item.roleName} → ${item.sessionId}：投递异常（${describeError(error)}）—— 令牌已生效，可重新交付`);
			}
		}
		// 8) 回执（逐角色 ＋ 批次汇总 ＋ 一条 freeze ＋ 撤销依据 ＋ 镜像）。
		return { lines: batchReceiptLines({ teamName, batchId, minted, vacant, deliveries, notice, mirrorLine: mirrorWriter.note(mirror), now, staleNote: readStaleNote, keptBefore: rotationEntriesOf(finalTeam).length }), batchId };
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
		// 批 Q · FR-Q4：重放也是「收尾」—— 只删本 rid 那条（与 `claim` 同一处语义、同一笔写）。
		const rid = pendingRotationRid(entry);
		const clearedTeams = view.teams.map((record) => (record.name === teamName ? clearRotation(record, roleName, rid) : record));
		let cleared = true;
		try {
			await policy.update({ teams: clearedTeams });
		} catch (error) {
			cleared = false;
		}
		// The outgoing holder is read from the revocation snapshot the prepare took
		// (the settled history no longer names it unambiguously): never invented.
		// 批 Q · FR-Q3：**按本次换届的 rid** 取那一份（不再读团队级单槽 —— 那会把别人的
		// 换届快照当成这一次的旧任来回答）。
		const snapshot = rotationEntryOf(view.teams.find((record) => record.name === teamName), rid)?.backup?.roster ?? null;
		const previousId = (snapshot?.roles ?? []).find((record) => record.role === roleName)?.current ?? null;
		const previous = previousId ?? "（旧任，见本次撤销依据）";
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
		const mirror = mirrorSource === undefined ? { ok: false, error: `团队 ${teamName} 不在注册表中` } : await mirrorWriter.write(mirrorSource);
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
				mirrorWriter.note(mirror),
				`（读数 ${readStamp(now)}，${readStaleNote}）`,
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

		// 批 Q · FR-Q3（D4）：**按本次 pending 的 rid** 取那一份撤销依据 —— 绝不用「团队第一条 /
		// 最近一条」（US-Q4：不许张冠李戴）。升级窗口里那次在飞换届（pending 里没有 rotationId）
		// 走同一条确定性推导 `legacy:<角色名>`，折叠侧与这里**必然对上**（Qr10）。
		const rid = pendingRotationRid(entry);
		const basis = rotationEntryOf(team, rid);
		const otherEntries = rotationEntriesOf(team).filter((candidate) => candidate.rid !== rid);
		// 失败方向（设计档 §9）：**fail-closed 于信任**。本次换届的撤销依据读不出来、而团队里
		// 确实**有别的换届的快照**时，拒绝继续：借用别人的快照来还原这一路，正是本批要消灭的错，
		// 而「不迁移、如实报」是设计允许的降级方向。团队里一条快照都没有（升级前的手写行 /
		// 夹具）时没有可借的条目 ⇒ 照既有语义继续，并把缺的那一行如实写进回执（Qr11 的两个面）。
		if (basis === null && otherEntries.length > 0) {
			return { error: `claim 失败：本次换届（team=${teamName} role=${roleName}，rid=${rid}）的撤销依据不在团队集合里——团队里现有 ${otherEntries.length} 条快照（${otherEntries.map((candidate) => candidate.rid).join("、")}）都不属于本次，按 fail-closed 于信任（设计档 Q §9）：**绝不借用「第一条 / 最近一条」**来还原这一路，本次零迁移、零落定、零写入。处置：先核对 policy.json 里该角色的「pending.rotationId」，或由现任重新 prepare（会为本次换届新铸一条撤销依据）。` };
		}
		/** 旧任：**取本次那一份快照里的读数**（与 replayClaim 同一条口径，§11.9.6「不可两处口径」），
		 * 快照里没有该角色时才退回活动名册的读数 —— 绝不拿别的换届的 roster 来回答。 */
		const basisPrevious = (basis?.backup?.roster?.roles ?? []).find((record) => record.role === roleName)?.current ?? null;

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
		// FR-2（U3）: 换届落定 = 现任换人 —— 立刻把段对齐（旧现任的段在这里被 dispose、
		// 继任者的段在这里被注册）。
		// ★ t-8 复验 🔴（task-9 A）：这一行**必须在上面那笔写入成功之后**。原先它落在
		// `policy.update(...)` 之前，于是「settlement 一落笔，名册就已经指向继任者了」这句注释
		// 是**假话**：写入若还没发生（或失败 return），段已经先换人 —— 旧现任仍持着协调者宪章、
		// 继任者零段，直到下一次名册写入或插件重载才自愈（验证者探针实测）。现在的位置与注释
		// 说的是同一件事：写入成功了，名册才真的指向继任者。失败分支（上面的 catch / return）
		// 不经过这里 —— 段不动，与「本次没有产生任何变更」一致。
		if (typeof extras.onRosterSettled === "function") extras.onRosterSettled();
		let bookkeeping = "pending 已清除（migratedPairs 先落盘再清，崩溃重试走重放路径）。";
		// 批 Q · FR-Q4：收尾**只删本 rid 那一条**（`clearRotation` 同时清 pending 并在同一笔写里
		// 把旧槽吸收掉 ⇒ 折叠出来的那一份不会在下一次读时「长回来」）—— 别人在飞的那份逐字节不动。
		const clearedTeams = teams.map((record) => (record.name === teamName ? clearRotation(record, roleName, rid) : record));
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
		const mirror = await mirrorWriter.write(mirrorSource);
		// 评审 #6: the retiree is no longer anyone's `current`, so without the union it
		// would never learn that the hand-over it prepared actually completed.
		const retired = basisPrevious ?? settlement.previous;
		const notice = await broadcastNotice(teamName, pending.session, doneNotice(teamName, roleName, retired ?? "（旧任）", pending.session, status, now), { signal: request.signal, alsoNotify: [retired] });
		// §11.9.6「不可两处口径」: the migration / dropped / revocation rows and the
		// provisional sentence come from the SAME builders the hand-over document's
		// 事实段 renders. Nothing here re-spells them.
		const facts = factRows({
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
				`换届完成（claim）：团队 ${teamName} 的角色 ${roleName}，旧任 ${retired} → 新任 ${pending.session}（读数 ${readStamp(now)}）。`,
				`撤销依据（本次换届 rid=${rid}）：${basis === null
					? "本次换届的快照不在集合里（团队内也没有任何快照可借）——按 fail-closed 于信任：绝不借用任何其它换届的快照来还原这一路；本次 claim 照既有语义继续（信任迁移不读快照）。"
					: `已按 rid 取到 ${readStamp(basis.at)} 时的快照——pairs ${basis.backup.pairs.length} 条 / trustedSenders ${basis.backup.trustedSenders.length} 项 / rememberTargets ${basis.backup.rememberTargets.length} 项（对称撤销的还原依据）；团队内另有 ${otherEntries.length} 条在飞快照原样保留`}。`,
				`信任迁移（域限定：仅「退役者 ↔ 同 team 成员」，§3.6.1 原则 2）：`,
				...facts.migration,
				...facts.dropped,
				`${facts.revocation[0]}`,
				`批准状态：${ratification}`,
				`roster 落定：${roleName}.current = ${pending.session}；版本史新增旧任 until=${readStamp(now)}${effectiveNote === undefined ? "" : `（备注：${preview(effectiveNote, 200)}）`}；${bookkeeping}`,
				guidelines({ now, successor: pending.session, provisional, status }),
				`通知广播（rotation-done，新任为发送方）：${notice.summary}`,
				...notice.rows,
				mirrorWriter.note(mirror),
				`（读数 ${readStamp(now)}，${readStaleNote}）`,
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
					// 批 Q · FR-Q4：取消 / 落定收尾都**只删本 rid 那一条**，且在把 pending 抹掉
					// **之前**删（旧槽折叠的 rid 推导要看「当下有几个 pending」；顺序反了会按另一个
					// 键去删）。`removeRotationBackup` 同时吸收旧槽 ⇒ 被吃掉的那份不会复活。
					const pendingRid = pendingRotationRid(entry);
					// ★ 批 S：取消前先记下**批次归属**（清掉 pending 就没了）—— 收尾行据此如实说
					//   「只取消这一个角色」（Sr7：整批一起取消是红相）。
					const batchId = batchIdOfPending(entry);
					// 撤销依据里的前任何：**先**从本次那一份快照读，再删条目（删完就没了）。
					const backupRoles = rotationEntryOf(team, pendingRid)?.backup?.roster?.roles;
					const cleared = removeRotationBackup(team, pendingRid);
					team.rotationBackups = cleared.rotationBackups;
					team.rotationBackup = null;
					entry.pending = null;
					touched = true;
					if (!settled) {
						// §3.6.2 评审 #6: the session the hand-over was prepared for, read
						// from the revocation snapshot (never invented). For a plain
						// cancellation it is the role's current holder again — already a
						// member and the sender of this notice — so the union only bites
						// when set-role moved the role on while the token was in flight.
						// 批 Q · FR-Q3：同样**按本 rid** 取（绝不用「最近一条」）。读数在删条目之前取。
						const snapshotIncumbent = (Array.isArray(backupRoles) ? backupRoles.find((record) => record.role === entry.role)?.current : null) ?? null;
						cancelled.push({ team: team.name, role: entry.role, incumbent: entry.current, caller: pending.session, snapshotIncumbent, batchId });
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
			lines.push(`- 令牌过期取消：团队 ${item.team} 的角色 ${item.role}${item.batchId === null || item.batchId === undefined ? "" : `（整队换届批次 ${item.batchId}：**只**取消这一个角色 —— 同批次其它角色照旧，认领与过期各归各的）`}（旧任 ${item.incumbent ?? "（空缺）"} 仍为 current，已广播 rotation-cancelled：${notice.summary}）`);
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

	return { prepare, prepareBatch, claim, sweep, broadcastNotice };
}

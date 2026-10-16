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

import { describeError, maskToken, noticeField, preview, readStamp, rotationRateLimited, timestamp, wellFormed } from "./shared.js";
// ★ §11.5 的读链（{@link handoffDocumentNamesLatest}）与 {@link handoffDocumentPath} 要用黑板目录出口 ——
//   它属于**黑板/台账域**（批 R 第 3 小单已搬进 `lib/ledger.js`）⇒ 从那里按名导入（内部相对导入，
//   宿主说明符面一个字符未动）。
import { blackboardPaths } from "./ledger.js";


// ---------------------------------------------------------------------------
// rotation: two-phase team hand-over (§3.6, M4)
// ---------------------------------------------------------------------------

export const ROTATION_TTL_MS = 30 * 60000;
/** Phase B provisional trust lifetime (§3.6.2 评审 #5): a migration granted
 * without a present user is revoked after this window unless ratified. */
export const ROTATION_PROVISIONAL_TTL_MS = 24 * 3600000;
/** Anti-storm window of §3.6.2 (`rateLimit(team, role, 10min)`): one prepare per
 * team+role per window, counting a live pending AND a completed rotation. */
export const ROTATION_RATE_LIMIT_MS = 10 * 60000;
/** How long the single rotation dialog waits for a present user before the claim
 * falls back to the unattended (provisional) path (§3.6.1 principle 4). */
export const ROTATION_CONFIRM_TIMEOUT_MS = 180000;
/** The tool's closed `action` set (§3.6.2: exactly two phases). */
export const ROTATION_ACTIONS = new Set(["prepare", "claim"]);
/** Display prefix of a masked token (§3.6.2 评审 #3 / M2 评审 #3). */
export const ROTATION_TOKEN_LABEL = "tok-";
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


/** The remaining part of an anti-storm window, for the refusal sentence. */
export function fmtWindowRest(until, now) {
	return `窗口剩余约 ${Math.max(0, Math.ceil((until - now) / 60000))} 分钟`;
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


/** Stable identity of one pair record (the R1 convention): a rotation must tell
 * "the pair the dialog listed" from "a pair added while the dialog was open". */
export function pairKey(pair) {
	return `${pair.a}\n${pair.b}\n${pair.createdAt}`;
}


/**
 * §3.6.2 prepare's admission checks, in ONE place: the manual path runs them
 * inside prepare, and the §11.2 `successor:"auto"` path runs them BEFORE it
 * creates anything — so a request prepare would refuse never leaves a session
 * behind, and the refusal words exist once instead of twice. Pure.
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
 * @returns `{ team, entry }` or `{ error }`.
 */
export function prepareAdmission(view, request) {
	const { teamName, roleName, successor, now, caller, isLive } = request;
	// 批 R 第 5 小单：恢复域那句活性诊断按名注入（档头）；缺席时退回原分支的空后缀。
	const ladderSuffix = typeof request.ladderSuffix === "function" ? request.ladderSuffix : () => "";
	const team = view.teams.find((entry) => entry.name === teamName) ?? null;
	if (team === null) return { error: `prepare 失败：团队 ${teamName} 不在注册表中（先用 team_link_roster action=upsert-team 创建）。` };
	const entry = roleOf(team, roleName);
	if (entry === null) return { error: `prepare 失败：团队 ${teamName} 没有角色 ${roleName}（先用 team_link_roster action=set-role 指定现任）。` };
	if (request.userInitiated !== true) {
		const gate = rotateGate(team, entry, caller);
		if (gate.error !== undefined) return { error: `${gate.error}${typeof isLive === "function" ? ladderSuffix(entry, isLive) : ""}` };
	}
	if (successor !== undefined && successor !== null && successor === entry.current) {
		return { error: `prepare 失败：继任者不能是现任自己（${successor}）——自换会先把现任的 pairs/trustedSenders/rememberTargets 全部吊销，再以 provisional 迁回，等于一次没有意义的信任重建。换人请指定另一个会话；纯粹的降低信任用 team_link_roster action=retire。` };
	}
	const limited = rotationRateLimited(entry, now);
	if (limited.limited) {
		return { error: `prepare 失败：换届速率限制（§3.6.2 rateLimit(team, role, 10min)，防换届风暴）——${limited.reason}。请等窗口结束，或先让当前 pending 被认领/过期清扫。` };
	}
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
		const pending = { session: successor, token, team: teamName, role: roleName, expiresAt: now + ROTATION_TTL_MS, createdAt: now, migratedPairs: [] };
		if (note !== undefined) pending.note = note;
		const backup = {
			at: now,
			pairs: view.pairs.map((pair) => ({ ...pair })),
			trustedSenders: [...view.trustedSenders],
			rememberTargets: [...view.rememberTargets],
			roster: structuredClone(team),
		};
		const nextTeam = { ...team, rotationBackup: backup, roles: team.roles.map((record) => (record.role === roleName ? { ...record, pending } : record)) };
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
				`撤销依据（rotationBackup）：已快照 ${now} 时的 pairs ${backup.pairs.length} 条 / trustedSenders ${backup.trustedSenders.length} 项 / rememberTargets ${backup.rememberTargets.length} 项与 roster。`,
				`冻结广播（rotation-freeze 固定清单）：${notice.summary}`,
				...notice.rows,
				mirrorWriter.note(mirror),
			],
		};
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
		const clearedTeams = view.teams.map((record) => (record.name === teamName ? clearRotationPending(record, roleName) : record));
		let cleared = true;
		try {
			await policy.update({ teams: clearedTeams });
		} catch (error) {
			cleared = false;
		}
		// The outgoing holder is read from the revocation snapshot the prepare took
		// (the settled history no longer names it unambiguously): never invented.
		const snapshot = view.teams.find((record) => record.name === teamName)?.rotationBackup?.roster ?? null;
		const previousId = (snapshot?.roles ?? []).find((record) => record.role === roleName)?.current ?? null;
		const previous = previousId ?? "（旧任，见 rotationBackup）";
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
		const clearedTeams = teams.map((record) => (record.name === teamName ? clearRotationPending(record, roleName) : record));
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
		const notice = await broadcastNotice(teamName, pending.session, doneNotice(teamName, roleName, settlement.previous ?? "（旧任）", pending.session, status, now), { signal: request.signal, alsoNotify: [settlement.previous] });
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
				`换届完成（claim）：团队 ${teamName} 的角色 ${roleName}，旧任 ${settlement.previous} → 新任 ${pending.session}（读数 ${readStamp(now)}）。`,
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
					entry.pending = null;
					touched = true;
					if (!settled) {
						// §3.6.2 评审 #6: the session the hand-over was prepared for, read
						// from the revocation snapshot (never invented). For a plain
						// cancellation it is the role's current holder again — already a
						// member and the sender of this notice — so the union only bites
						// when set-role moved the role on while the token was in flight.
						const backupRoles = team.rotationBackup?.roster?.roles;
						const snapshotIncumbent = (Array.isArray(backupRoles) ? backupRoles.find((record) => record.role === entry.role)?.current : null) ?? null;
						cancelled.push({ team: team.name, role: entry.role, incumbent: entry.current, caller: pending.session, snapshotIncumbent });
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
			lines.push(`- 令牌过期取消：团队 ${item.team} 的角色 ${item.role}（旧任 ${item.incumbent ?? "（空缺）"} 仍为 current，已广播 rotation-cancelled：${notice.summary}）`);
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

	return { prepare, claim, sweep, broadcastNotice };
}

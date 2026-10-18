// dsh-team-link — node half (host plugin).
//
// Upstream dsh-session-link behavior, kept in full: direct user prompts
// carrying a session deep link (the canonical `dsh-session:<base64url>` URI,
// this deployment's `dsh://session/<sessionId>` deep link, or the legacy web
// deep link `http(s)://<host>/s/<sessionId>`) are resolved through the shipped
// session-reference service and the bounded snapshot is injected as read-only
// model context immediately before the direct prompt.
//
// New in -pro (and in the 0.3.x team upgrade):
//  1. team_link_list_sessions — list the sessions of the current
//     workspace (id / title / running state / created time).
//  2. team_link_export — export any session as markdown + JSON into
//     the session workspace's `.dsh-exports/` directory; the same renderer
//     also streams downloads through an exact webServer route for the
//     conversation-header export button.
//  3. team_link_send — deliver a message to another live session.
//     A running target receives it inside its current turn (steer); an idle
//     target is woken as a new turn (followup). Every send passes
//     two gates before delivery: the sender's user must approve (permanently
//     memorable per target) and the receiver's inbound policy must accept it
//     (ask / accept / reject, plus trusted and blocked sender lists, edited
//     through the settings UI).
//  4. team_link_watch — the M1 cross-session watchdog (register / list / clear).
//  5. team_link_roster / team_link_team_read / team_link_team_append — the M2 team
//     identity registry (roles, version history, writer policy) and the team
//     blackboard under <workspace>/team/<name>/ (mirror + decisions + discipline).
//  6. M3 (0.3.3) grows team_link_send into the §3.4 broadcast: an optional
//     `targets` fan-out (session id / team:<name>/<role> / coordinator-only
//     team:<name>/*, one full gate pass per target, ≤8 targets) and an optional
//     `meta` envelope rendered into the banner's first line (V10 keeps the
//     source at exactly three members). Delivery replies carry the §3.5 busy
//     prediction.
//  7. team_link_rotate — the M4 two-phase hand-over (§3.6): `prepare` mints a
//     one-time token bound to (team, role, successor), snapshots the trust state
//     for revocation and freezes the team; `claim` (only by the successor, only
//     with that token) migrates the in-team pairs through a single confirmation
//     dialog — or provisionally, with a 24h rollback, when nobody is there to
//     confirm — revokes the outgoing coordinator's trust symmetrically and
//     settles the roster. Expired tokens and provisional windows are swept by the
//     same patrol timer as the M1 watchdog (§3.6.2 评审 #4/#5).
//  8. §10.1 (A/D) — team_link_send additionally projects the §10.1.2 structured
//     delivery receipt through `output.presentationMeta`, persisted as
//     `tool/result.meta`; the browser half renders the sender's own tool row and
//     a top-level summary node from it. The receipt is bounded where it is
//     persisted — the body at 2000 code points, the `targets` array at 24 rows
//     (a single `team:<name>/*` legally expands past the ≤8 EXPRESSION bound) —
//     and each cut is stated on the card, never in the counts or in the
//     model-visible report. The model-visible text is untouched, and
//     no new session-log event type is introduced (A/D read existing
//     tool/call + tool/result events only).
//  9. §10.2 ② — the `/team_session` command: one human command creates N worker
//     ROOT sessions (N ≤ 8 and per-team members ≤ 24 are code constants), drives
//     each with one `followup` kickoff task after every create resolved, registers
//     them in the roster by role (idempotently, through the existing writer gate),
//     and pairs each new worker with the coordinator. The command is registered
//     through the OPTIONAL `commands` injection — `inject` below stays at four
//     entries — and one batch confirmation carries the counts, the model, the cwd,
//     the conservative cost and the trust being granted before anything happens.
//     Every created session RESOLVES an agent preset — the host's DEFAULT one when
//     the caller named none — and MOUNTS it in its own `setup`, the `dsh-webhook`
//     template's own order; a creation path that skipped that step produced a
//     session that could not start a single turn (真机缺陷 #1 / DEFECT-1). The
//     same template is a SEQUENCE, not just a shape: it also CREATES the
//     workspace, feeds `workspace.path` into `meta.cwd`, and ATTACHES the finished
//     session to it — a creation path that copied only the `meta` shape produced
//     sessions with no workspace membership, which the sidebar (grouped by
//     workspace) could not list (真机缺陷 #2 / DEFECT-2). Both halves now live in
//     the ONE creation path; the §11.2 `successor:"auto"` hand-over creates
//     through that same function, so both fixes cover the trust-migration path as
//     well.
import { encodeSessionReferenceUri, parseSessionReferenceText } from "@deepseek-ai/dsh-session-reference";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "schemastery";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, readdir, rename, rm, statfs, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// ★ 批 R · FR-R1（域拆分）：崩溃现场（心跳）域搬进 `lib/forensics.js`，此处按名导入（唯一新增的
// 内部相对导入；宿主说明符面一个字符未动）。入口对外面（`main` / `exports` / `apply` / `__testing`）
// 逐字不变 —— `__testing` 里那三个名字与两条缝函数照旧导出，只是后者的实现落在域档里。
import { FORENSICS_FALLBACK_INTERVAL_MS, FORENSICS_KEEP_BOOTS, createForensics, diskSpaceReaderIsDefault, setDiskSpaceReader, wireForensics } from "./forensics.js";
// ★ 批 R · FR-R1（域拆分·第 3 小单）：黑板与台账域搬进 `lib/ledger.js`，宿主半边多域共用的
// 四条基础助手搬进 `lib/shared.js`（设计档 §6「边界规则」）—— 此处按名导入（内部相对导入；
// 宿主说明符面一个字符未动）。入口对外面（`main` / `exports` / `apply` / `__testing`）逐字不变：
// `__testing` 里那四个黑板书名字与两条缝函数照旧导出，只是实现落在域档里。
import { COORDINATOR_ROLE, FRAMING_PLACEHOLDER, FRAMING_WRAP, agentSessionId, describeError, localStamp, preview, sanitizeFraming, sectionsView, setStripImpl, stripFramingTokens, stripImplIsDefault, wellFormed, wellFormedContent } from "./shared.js";
import { maskToken, noticeField, readStamp, rotationRateLimited, timestamp } from "./shared.js";
import { BLACKBOARD_FILES, BLACKBOARD_LINE_LIMIT, DECISIONS_WINDOW, TASK_ID_RE, TASK_KINDS, TASK_KIND_LIST, TASKS_PROJECTION_SCAN, TASKS_WINDOW, blackboardAuthor, blackboardHash, blackboardLines, blackboardPaths, decisionRow, deriveTasksView, lastDecisionSeq, lastSeq, ledgerTransitionGate, readBlackboardFile, readBlackboardLine, registeredTaskIds, renderTaskView, tasksRow } from "./ledger.js";
// ★ 批 R · FR-R1（域拆分·第 4 小单）：段渲染与预算域搬进 `lib/sections.js`，本域需要、且宿主半边
// 多域共用的共享物搬进 `lib/shared.js`（设计档 §6「边界规则」）—— 此处按名导入（内部相对导入；
// 宿主说明符面一个字符未动）。入口对外面（`main` / `exports` / `apply` / `__testing`）逐字不变：
// `__testing` 里那一族段/预算名字与两条缝函数照旧导出，只是实现落在域档 / 共享档里。
import { BUDGET_SECTION_MAX_LINES, BUDGET_SECTION_MAX_ROWS, BUDGET_VERDICT_SCOPE, CHARTER_MAX_LINES, RESOURCE_CONTEXT_NAME, RESOURCE_CONTEXT_ORDER, ROLE_SECTION_NAME, ROLE_SECTION_ORDER_KEY, ROTATE_CANDIDATE_TOKENS, ROTATE_CANDIDATE_TURNS, budgetRowLine, budgetSectionLines, budgetVerdictLine, charterReinforceLine, currentTurnOf, formatTokenCount, readSessionUsage, renderCharterLines, renderResourceContext, renderResourceLine, renderRoleText, renderWorkerDutyLine, rotateCandidateOf, sectionsSwitches, sumTokenTotals } from "./sections.js";
import { HANDOFF_CLAIMED_PLACEHOLDER, HANDOFF_FILE_PREFIX, HANDOFF_SCHEMA, HANDOFF_STATUS_PREPARED, ROTATION_ACTIONS, ROTATION_CONFIRM_TIMEOUT_MS, ROTATION_DIALOG_CAUSES, ROTATION_DIALOG_ID, ROTATION_PROVISIONAL_NOTE, ROTATION_PROVISIONAL_TTL_MS, ROTATION_RATE_LIMIT_MS, ROTATION_STATUS_NONE, ROTATION_TOKEN_LABEL, ROTATION_TTL_MS, applyRotationTrust, cancelledNotice, clearRotationPending, closeTenure, createRotation, dialogNoAnswerError, doneNotice, doomedProvisionalPairs, expiredNotice, fmtWindowRest, freezeNotice, handoffDocumentNamesLatest, handoffDocumentNamesSuccessor, handoffDocumentPath, isExpiredProvisionalPair, latestHandoffDocument, listHandoffDocuments, noticeSummary, ownershipEvidenceLabel, pairKey, planRotationMigration, prepareAdmission, provisionalWindowExpiry, recoveryNote, roleOf, roleRecord, rotateGate, rotationStatusOf, settleRotation, successorOwnershipIndex, successorOwnershipOf, teamMembers, unattendedClaimReading, withRecoveryRow } from "./rotation.js";
import { registerTools, wireRegistration } from "./registration.js";
// ★ 批 R · FR-R1（域拆分·第 7 小单）：名册工具域（`team_link_roster` 的注册）搬进
// `lib/team-registration.js` —— 此处按名导入（内部相对导入；宿主说明符面一个字符未动）。
// 入口对外面（`main` / `exports` / `apply` / `__testing`）逐字不变；工具面（名字 / 描述 / 参数 /
// 返回文案 / 注册顺序）也逐字不变 —— 入口只是把那条语句换成了同一位置的装配调用。
import { registerRosterTool, wireTeamRegistration } from "./team-registration.js";
// ★ 批 R · FR-R1（域拆分·第 8 小单）：黑板读写工具域（`team_link_team_read` 的注册）搬进
// `lib/team-ledger-tools.js` —— 此处按名导入（内部相对导入；宿主说明符面一个字符未动）。
// 入口对外面（`main` / `exports` / `apply` / `__testing`）逐字不变；工具面（名字 / 描述 / 参数 /
// 返回文案 / 注册顺序）也逐字不变 —— 入口只是把那条语句换成了同一位置的装配调用。
// ★ 本单**只搬了 read 那一条**：`team_link_team_append` 仍在本档（原因见 `lib/team-ledger-tools.js`
// 档头第 ① 条 —— 它被 `host-half.test.mjs` 的一条**只读本档**的正向文本锁钉住）。
import { registerTeamLedgerTools, wireTeamLedgerTools } from "./team-ledger-tools.js";
// ★ 批 R · FR-R1（域拆分·第 9 小单 · messaging 第一片）：屏蔽作用域域（九个纯函数：规范化 / 判定 /
// 三个写路径 / 两条拒收文案 / 一条分组读面）搬进 `lib/block.js` —— 此处按名导入（内部相对导入；
// 宿主说明符面一个字符未动）。入口对外面（`main` / `exports` / `apply` / `__testing`）逐字不变；
// 工具面（名字 / 描述 / 参数 / 返回文案 / 注册顺序）也逐字不变 —— 入口只是把定义换成了同一份实现的导入。
// ★ 本子族对外部裸名**零依赖** ⇒ `lib/block.js` 没有装配缝（与 `lib/ledger.js` / `lib/sections.js`
//   同形）：没有可注入之物，缝只会是一条永不执行的死代码（设计档 §6「只带它自己的依赖」）。
import { blockDecisionText, blockEntryBetween, blockListLines, blockPair, blockSender, blockedDeliveryText, clearLegacy, isBlocked, unblockPair } from "./block.js";
// ★ 批 R · FR-R1（域拆分·第 10 小单）：名册与状态落点域的**纯函数族**（归一化全族 + 三个策略读
// 助手 + 状态落点解析 + 折叠结局词）搬进 `lib/policy-store.js` —— 此处按名导入（内部相对导入；
// 宿主说明符面一个字符未动）。入口对外面（`main` / `exports` / `apply` / `__testing`）逐字不变：
// `__testing` 里那五个名字（`normalizeTeams` / `pairRecordBetween` / `pendingCreateList` /
// `resolvePolicyFilePath` / `setPolicyHomeInject`）照旧导出，只是实现落在域档里。
// ★ 本单**只搬纯函数族**：`createPolicyStore` 的 store 生命周期本体（含 pinned 的
//   `writePolicyFileAtomic` / `renameThroughSeam` / `POLICY_FILE_SCHEMA`）仍逐字节住在入口。
import { DEFAULT_POLICY, MEMORY_WINDOW_OUTCOME_FOLDED, MEMORY_WINDOW_OUTCOME_FOLD_FAILED, MEMORY_WINDOW_OUTCOME_NONE, MEMORY_WINDOW_OUTCOME_NOT_FOLDED, POLICY_FILE_NAME, POLICY_REASON_CORRUPT, POLICY_REASON_NOT_ACTIVE, POLICY_REASON_NO_REGISTER, POLICY_REASON_UNWRITABLE, memoryWindowOutcomeLanded, normalizePolicy, normalizeTeams, pairBetween, pairRecordBetween, pendingCreateList, policyIsAtDefaults, resolvePolicyFilePath, setPolicyHomeInject, wirePolicyStore, withSender } from "./policy-store.js";

// ★ 批 R · FR-R1（域拆分·第 11 小单）：messaging 余下三片（导出渲染 / §3.4 广播寻址与投递 /
// §10.1.2 发送方回执卡）搬进 `lib/messaging.js` —— 此处按名导入（内部相对导入；宿主说明符面
// 一个字符未动）。入口对外面（`main` / `exports` / `apply` / `__testing`）逐字不变：`__testing`
// 里那六个广播助手照旧导出，工具面（名字 / 描述 / 参数 / 返回文案 / 注册顺序）也逐字不变 ——
// 入口只是把定义换成了同一份实现的导入。
import { SEND_CARD_BY_ARGS, SEND_CARD_KIND, SEND_CARD_VERSION, buildSendCard, busyGuidance, deliverToTarget, exportSession, fanout, fileSafeSessionId, jsonExportText, metaBannerFields, readMeta, renderSessionMarkdown, resolveTargetList, resolveTargets, sendCardMessage, sendOutput, targetLabel, titleOf, withMetaNotes, wireMessaging } from "./messaging.js";

// ★ 批 R · FR-R1（域拆分·第 12 小单）：跨会话看门狗（M1）的**控制器本体**（`createWatchdog`）搬进
// `lib/watchdog.js` —— 此处按名导入（内部相对导入；宿主说明符面一个字符未动）。入口对外面
// （`main` / `exports` / `apply` / `__testing`）逐字不变：`__testing.watchdogFor(ctx)` 读的仍是 `apply`
// 存进 `WATCHDOG_BY_CTX` 的那个控制器，工具面（名字 / 描述 / 参数 / 返回文案 / 注册顺序）也逐字不变 ——
// 入口只是把函数定义换成了同一份实现 + 一条装配缝（先例见上面各域档同形注释）。
// ★ 本单**只搬了这个函数**：watchdog 家族余下 21 个入口侧声明仍在本档（原因见 `lib/watchdog.js` 档头
//   第 ② 条：整族 65,681 字节越过本小单 60 KB 的档位上限，且其中 12 个名字由 `__testing` 直接开放）。
import { createWatchdog, wireWatchdog } from "./watchdog.js";
// ★ 批 R · FR-R1（域拆分·第 13 小单）：§11.9.4/§11.9.5 恢复域（`team_link_recover` 的两个封闭动词、L1 预检与
// 限速、候选集计算、审计行与三处留痕、两条确认对话框、两个执行体）搬进 `lib/recovery.js` —— 此处按名导入
// （内部相对导入；宿主说明符面一个字符未动：那 8 条白名单一条都没变）。入口对外面（`main` / `exports` /
// `apply` / `__testing`）逐字不变：`__testing` 里那一族恢复名字照旧导出，只是实现落在域档里。
// ★ 被钉的 `writerGate` **没有搬**（定义与文档注释仍在入口），只作为依赖经缝传入（见 `recoveryExtras()`）。
import { RECOVERY_ACTIONS, RECOVERY_RATE_LIMIT_MS, SELF_SUCCESSOR_LABEL, askRecoveryCandidates, askRecoveryConfirm, candidateLabel, candidateOptionText, initiatorAllowsRecovery, pluginSessionIdMatches, reapCandidateRoles, reapIncumbent, recoveryBoundaryText, recoveryDecisionRow, recoveryPreflight, recoveryRateLimited, reviveIncumbent, vacancyKindText, wireRecovery, writeRecoveryTrails } from "./recovery.js";
// ★ 批 R · FR-R1（域拆分·第 14 小单）：§10.2.2/§10.2.3/§10.2.4/§10.2.6 的批量建队与**唯一创建落点**
// （pairs 补丁 / 角色行 / 启动任务 / 批量确认框 / 创建循环 / `createRootAgent` 与工作区挂载·回滚·命名）
// 以及批 P 的三个继承读面与唯一措辞源搬进 `lib/team-session-creation.js` —— 此处按名导入（内部相对导入；
// 宿主说明符面一个字符未动：那 8 条白名单一条都没变），模块尾部那条 `wireTeamSessionCreation(…)` 按
// 「装配缝」给它 11 条入口侧出口。入口对外面（`main` / `exports` / `apply` / `__testing`）逐字不变：
// `__testing` 里那一族建队/继承名字照旧导出，只是实现落在域档里。
// ★ 被钉的 `buildTeamSessionCreateOptions` **没有搬**（定义与文档注释仍在入口），只作为依赖经缝传入
// （见 `teamSessionCreationExtras()`）。
import { PRESET_SCOPE_RELEASE, applyInheritedApprovalPolicy, askTeamSessionBatch, collectInheritableSettings, createRootAgent, createTeamSession, createTeamSessions, createdTeamSessionRoles, inheritanceRowList, installTeamSessionModelSelection, readInheritableSettings, teamSessionKickoffText, teamSessionNoConfirmText, teamSessionRoleRow, wireTeamSessionCreation, withTeamSessionPairs } from "./team-session-creation.js";

/**
 * ★ 批 R 第 5 小单（域拆分）：`lib/rotation.js` 需要的**入口侧出口**，一处装配。
 *
 * 为什么是注入而不是 import：域档**不许**导入入口（那会构成 ESM 环）—— 设计档 §4 的实现先例
 * 是 `forensics.js` 的 `wireForensics()` 注入缝。这里给出的正是那几条**住在入口那一档**的出口
 * （名册镜像两条 / 读数脚注常量 / 投递面 / §11.9.6 同源锁钉在入口的三条渲染出口）；它们的绑定
 * 与搬迁前**逐个同一**，所以被注入后的行为逐字不变。§11.5 的持久证据读面**不在这里** —— 它随
 * 换届域一起搬进了 `lib/rotation.js`（判据面直接按名调那个函数，没有缝可给）。
 *
 * 两个消费点共用它：`apply` 的生产装配，与 `__testing.rotationFor()` 现场新建夹具控制器的那条路
 * —— 后者先合成本函数再让夹具覆盖自己那几个键，于是**夹具走的仍是真路径**。
 */
function rotationExtras() {
	return {
		mirrorWriter: { write: writeRosterMirror, note: mirrorNote },
		readStaleNote: READ_STALE_NOTE,
		deliver: deliverToTarget,
		factRows: rotationFactRows,
		provisionalGuidance,
	};
}

/**
 * ★ 批 R 第 6 小单（域拆分）：`lib/registration.js` 需要的**入口侧出口**，一处装配。
 *
 * 为什么是注入而不是 import：域档**不许**导入入口（那会构成 ESM 环，实跑当场 TDZ）—— 先例是
 * `forensics.js` 的 `wireForensics()` 与本档上面那条 `rotationExtras()`。这 52 条**全部是入口侧仍然
 * 要用的出口**（按归属分九组：读面常量 · 会话面 · 活性 · 黑板 · 名册与形态 · 看门狗 · 投递 · 导出 ·
 * 状态尾）；搬走任何一条都会变成「同一函数两份」（设计档 §6 明令禁止双事实源），而入口**不能**
 * 再导出给域档静态导入（环）⇒ 缝是唯一不破环的路。绑定与被搬前**逐个同一**，所以注入之后行为逐字不变。
 *
 * ★ 被钉符号在这张表里只出现一次：`agentStateLabel` —— 它**没有搬**（定义与文档注释仍在入口），
 *   只是作为依赖经缝传入；那条「按函数自身锚点切片」的源码锁（`hostSource.lastIndexOf("/**", at)`
 *   → `hostSource.indexOf("\n}", at)`）因此读数一字不变。
 */
function registrationExtras() {
	return {
		// ---- 读面常量 ----
		LIST_LIMIT,
		LV_WINDOW_NOTE,
		PREVIEW_SESSIONS,
		READ_STALE_NOTE,
		SEND_CARD_BY_ARGS,
		STATUS_LV_WINDOW_NOTE,
		STATUS_TASKS_TAIL_DEFAULT,
		STATUS_TASKS_TAIL_MAX,
		WATCHDOG_ORIGIN_AUTO,
		// ---- 会话面 ----
		agentCwd,
		agentStateLabel,
		firstSurfaceUserText,
		lastSurfaceText,
		readListReadWindow,
		listReadTail,
		ledgerRowTime,
		reverseWarningNote,
		forDisplay,
		sessionLabel,
		// ---- 活性 ----
		buildLivenessSignal,
		livenessLine,
		// ---- 黑板 ----
		blockListLines,
		blockPair,
		unblockPair,
		clearLegacy,
		// ---- 名册与形态 ----
		readTeamName,
		probeAgentTeams,
		isIncumbentCoordinator,
		teamRoleLines,
		sessionFaceLine,
		teamModeSectionLines,
		loadScopedSessionRecords,
		windowWorkspaceFor,
		windowReadingFor,
		// ---- 看门狗 ----
		buildWatchdogRegistration,
		ensureTeamAutoWatchdogs,
		chainReportLine,
		watchdogLines,
		watchdogRenewField,
		WATCHDOG_MAX_PER_SESSION,
		// ---- 投递 ----
		deliverToTarget,
		fanout,
		buildSendCard,
		sendCardMessage,
		sendOutput,
		resolveTargetList,
		readMeta,
		withMetaNotes,
		// ---- 导出 ----
		exportSession,
		// ---- 状态尾 ----
		pendingLines,
		readStatusTasksTail,
		textOutput,
	};
}

/**
 * ★ 批 R 第 7 小单（域拆分）：`lib/team-registration.js` 需要的**入口侧出口**，一处装配。
 *
 * 为什么是注入而不是 import：域档**不许**导入入口（那会构成 ESM 环，实跑当场 TDZ）—— 先例是
 * `forensics.js` 的 `wireForensics()` 与本档上面那两条 `rotationExtras()` / `registrationExtras()`。
 * 这 44 条**全部是入口侧仍然要用的出口**（按归属分六组：形态常量 · 名册读写与门 · 段与镜像 ·
 * 形态对话框与历史行 · 会话面读数 · 输出包装与读面常量）；搬走任何一条都会变成「同一函数两份」
 * （设计档 §6 明令禁止双事实源），而入口**不能**再导出给域档静态导入（环）⇒ 缝是唯一不破环的路。
 * 绑定与被搬前**逐个同一**，所以注入之后行为逐字不变。
 *
 * ★ 被钉符号在这张表里只出现一次：`writerGate` —— 它**没有搬**（定义与文档注释仍在入口），
 *   只是作为依赖经缝传入；那条「按函数自身锚点切片」的源码锁读数因此一字不变。
 */
function teamRegistrationExtras() {
	return {
		// ---- 形态常量 ----
		AGENT_TEAMS_HOWTO,
		MODE_SETTINGS_FALLBACK,
		TEAM_MODES,
		TEAM_MODE_AGENT_TEAM,
		TEAM_MODE_LIST,
		TEAM_MODE_NO_MIGRATION_LINES,
		TEAM_MODE_SESSIONS,
		TEAM_SESSION_RELEASE_NOTES,
		// ---- 名册读写与门 ----
		applyRetire,
		applySetRole,
		applyTeamUpsert,
		applyTeamSessionRelease,
		writerGate,
		retireGate,
		tenureStartOf,
		deleteTeam,
		blackboardUntouchedLine,
		trustReferencesTo,
		teamSessionReleaseVerdict,
		// ---- 段与镜像 ----
		memberLine,
		mirrorNote,
		writeRosterMirror,
		teamModeSectionLines,
		// ---- 形态对话框与历史行 ----
		askDeleteConfirm,
		askModeDialog,
		appendModeHistoryRow,
		backfillModeHistoryRow,
		modeHistoryBody,
		modeCapabilityLines,
		// ---- 会话面读数 ----
		agentCwd,
		agentIsLive,
		otherReachableSessions,
		probeAgentTeams,
		readLeadSessionId,
		readNote,
		readRoleName,
		readSessionId,
		readTeamName,
		sessionIdSnapshot,
		withLiveGateDiagnostic,
		recoveryLadderSuffix,
		// ---- 输出包装与读面常量 ----
		textOutput,
		READ_STALE_NOTE,
		name,
	};
}

/**
 * ★ 批 R 第 8 小单（域拆分）：`lib/team-ledger-tools.js` 需要的**入口侧出口**，一处装配。
 *
 * 为什么是注入而不是 import：域档**不许**导入入口（那会构成 ESM 环，实跑当场 TDZ）—— 先例是
 * `forensics.js` 的 `wireForensics()` 与本档上面三条 `rotationExtras()` / `registrationExtras()` /
 * `teamRegistrationExtras()`。这 8 条**全部是入口侧仍然要用的出口**；搬走任何一条都会变成
 * 「同一函数两份」（设计档 §6 明令禁止双事实源），而入口**不能**再导出给域档静态导入（环）
 * ⇒ 缝是唯一不破环的路。绑定与被搬前**逐个同一**，所以注入之后行为逐字不变。
 *
 * ★ 口径如实：这张清单是 **word-boundary 宽口径**（在被搬语句原文上按裸词边界匹配、再与本档的
 *   顶层绑定名求交）—— `agentCwd` 在该语句里只出现在**字符串 / 注释**里，仍照给：多给一条不改变
 *   行为，少给一条才会 ReferenceError。
 * ★ 被钉符号（本仓 `hostSource` 文本锁钉住的 9 个）在这一族工具里**一条都不涉及** —— 该语句正文对
 *   那 9 个名字零命中，所以本函数也不转出其中任何一个。
 */
function teamLedgerToolsExtras() {
	return {
		// ---- 读面常量与输出包装 ----
		READ_STALE_NOTE,
		textOutput,
		// ---- 团队 / 会话面读数 ----
		agentCwd,
		readSessionSurface,
		readTeamName,
		// ---- 台账派生与收件/回执（实测闭包属「投递」域，下一小单搬） ----
		readTaskReceiptTargets,
		taskMessageBlock,
		tasksDerivedLines,
	};
}

/**
 * ★ 批 R 第 10 小单（域拆分）：`lib/policy-store.js` 需要的**入口侧出口**，一处装配。
 *
 * 为什么是注入而不是 import：域档**不许**导入入口（那会构成 ESM 环，实跑当场 TDZ）—— 先例是
 * `forensics.js` 的 `wireForensics()` 与本档上面四条 `rotationExtras()` / `registrationExtras()` /
 * `teamRegistrationExtras()` / `teamLedgerToolsExtras()`。这 9 条**全部是入口侧仍然要用的出口**，
 * 其中四个看门狗常量、名册形态闭集与降级留痕表还被本档的 schema 在**模块求值**时读到（域档求值
 * 早于入口正文 ⇒ 只能注入，不能静态 import）。搬走任何一条都会变成「同一函数两份」（设计档 §6
 * 明令禁止双事实源）⇒ 缝是唯一不破环的路。绑定与被搬前**逐个同一**，所以注入之后行为逐字不变。
 *
 * ★ 被钉符号（本仓 `hostSource` 文本锁钉住的 9 个）在这张表里**一条都没有** —— 九个仍逐字节住在
 *   入口，本域可执行代码面对那 9 个名字零命中（见 `lib/policy-store.js` 档头）。
 */
function policyStoreExtras() {
	return {
		// ---- 归一化器读到的缺省 / 来源常量 ----
		WATCHDOG_DEFAULT_SILENT_MINUTES,
		WATCHDOG_DEFAULT_INTERVAL_MINUTES,
		WATCHDOG_ORIGIN_AUTO,
		WATCHDOG_ORIGIN_MANUAL,
		// ---- 名册形态闭集与降级留痕（Map：按引用注入，clear/set 落在同一张表上） ----
		TEAM_NAME_RE,
		TEAM_MODES,
		TEAM_MODE_SESSIONS,
		TEAM_MODE_DEGRADATIONS,
		// ---- 角色行归一化用到的恢复审计行归一化器（定义仍在入口，§11.9.5⑦ 同源） ----
		normalizeRecoveries,
	};
}

/**
 * ★ 批 R 第 11 小单（域拆分）：`lib/messaging.js` 需要的**入口侧出口**，一处装配。
 *
 * 为什么是注入而不是 import：域档**不许**导入入口（那会构成 ESM 环，实跑当场 TDZ）—— 先例是
 * `forensics.js` 的 `wireForensics()` 与本档上面五条 `rotationExtras()` / `registrationExtras()` /
 * `teamRegistrationExtras()` / `teamLedgerToolsExtras()` / `policyStoreExtras()`。这 7 条**全部是
 * 入口侧仍然要用的出口**（插件标识 · 三条文本助手 · 会话标签 · 两条活性读数）；搬走任何一条都会
 * 变成「同一函数两份」（设计档 §6 明令禁止双事实源），而入口**不能**再导出给域档静态导入（环）
 * ⇒ 缝是唯一不破环的路。绑定与被搬前**逐个同一**，所以注入之后行为逐字不变。
 *
 * ★ 被钉符号（本仓 `hostSource` 文本锁钉住的 9 个）在这张表里**一条都没有** —— 九个仍逐字节住在
 *   入口，本域可执行代码面对那 9 个名字零命中（见 `lib/messaging.js` 档头）。
 */
function messagingExtras() {
	return {
		PLUGIN_LABEL,
		truncate,
		safeJson,
		textOutput,
		sessionLabel,
		buildLivenessSignal,
		readSessionSurface,
	};
}

/**
 * ★ 批 R 第 12 小单（域拆分）：`lib/watchdog.js` 需要的**入口侧出口**，一处装配。
 *
 * 为什么是注入而不是 import：域档**不许**导入入口（那会构成 ESM 环，实跑当场 TDZ）—— 先例是
 * `forensics.js` 的 `wireForensics()` 与本档上面六条 `rotationExtras()` / `registrationExtras()` /
 * `teamRegistrationExtras()` / `teamLedgerToolsExtras()` / `policyStoreExtras()` / `messagingExtras()`。
 * 这 27 条**全部是入口侧仍然要用的出口**（按归属分五组：看门狗常量 · 活性读数 · 巡检助手 ·
 * 摘要与两档告警 · 投递与读数面）；搬走任何一条都会变成「同一函数两份」（设计档 §6 明令禁止双事实源），
 * 而入口**不能**再导出给域档静态导入（环）⇒ 缝是唯一不破环的路。绑定与被搬前**逐个同一**，所以注入
 * 之后行为逐字不变。
 *
 * ★ 被钉符号（本仓 `hostSource` 文本锁钉住的 9 个）在这张表里出现**三条**：`WATCHDOG_DIGEST_DEBOUNCE_MS` /
 *   `TICKABLE_VERDICTS` / `relayUserMessage` —— 它们**没有搬**（定义、文档注释与锚点切片位置仍在入口），
 *   只作为依赖经缝传入；那条「按函数自身锚点切片」的源码锁（`hostSource.lastIndexOf("/**", at)`
 *   → `hostSource.indexOf("\n}", at)`）因此读数一字不变。
 */
function watchdogExtras() {
	return {
		// ---- 看门狗常量（前两条被钉，只注入不搬）----
		WATCHDOG_DIGEST_DEBOUNCE_MS,
		TICKABLE_VERDICTS,
		WATCHDOG_ORIGIN_AUTO,
		WATCHDOG_RENEW_WINDOW_MS,
		PATROL_SWEEP_MIN_INTERVAL_MS,
		IDLE_ALERT_MAX_PER_EPISODE,
		LIAISON_PRESSURE_WARN_PERCENT,
		// ---- 活性读数（FR-3b 的判定与水位、收件人窗口读数）----
		LV_RUN_MIN,
		buildLivenessSignal,
		readGoalSignal,
		lastActivityOf,
		// ---- 巡检一条注册的助手（规划 / 名册门 / 按队补挂）----
		classifyWatchdogTargets,
		planAutoWatchdog,
		autoWatchdogRosterGate,
		ensureTeamAutoWatchdogs,
		// ---- 摘要与两档告警的判定 / 指纹 / 渲染 ----
		watchdogDigestActionable,
		watchdogDigestSignature,
		renderWatchdogDigest,
		renderIdleAlert,
		bucketOf,
		renderPressureAlert,
		digestFooters,
		// ---- 投递、插件标识与读数面 ----
		tickMessage,
		relayUserMessage,
		readSessionSurface,
		isIncumbentCoordinator,
		PLUGIN_LABEL,
	};
}

/**
 * ★ 批 R 第 13 小单（域拆分）：`lib/recovery.js` 需要的**入口侧出口**，一处装配。
 *
 * 为什么是注入而不是 import：域档**不许**导入入口（那会构成 ESM 环，实跑当场 TDZ）—— 先例是
 * `forensics.js` 的 `wireForensics()` 与本档上面七条 `rotationExtras()` / `registrationExtras()` /
 * `teamRegistrationExtras()` / `teamLedgerToolsExtras()` / `policyStoreExtras()` / `messagingExtras()` /
 * `watchdogExtras()`。这 12 条**全部是入口侧仍然要用的出口**（按归属分五组：两条状态词 · 两条会话 id
 * 形状常量 · 序列化助手 · 名册镜像与门 · 批 P 继承读数与 §4.2 (c) 自建继任者支路）；搬走任何一条都会变成
 * 「同一函数两份」（设计档 §6 明令禁止双事实源），而入口**不能**再导出给域档静态导入（环）⇒ 缝是唯一
 * 不破环的路。绑定与被搬前**逐个同一**，所以注入之后行为逐字不变。
 *
 * ★ 被钉符号在这张表里出现**一条**：`writerGate` —— 它**没有搬**（定义与文档注释仍在入口），只作为依赖
 *   经缝传入；那条「按函数自身锚点切片」的源码锁读数因此一字不变。★ 口径如实：本域**可执行**代码对
 *   `writerGate` 的引用为 0，它只出现在一条注释与一句用户可见文案里；按宽口径照样给（多给一条不改变
 *   行为，少给一条才会 ReferenceError），先例 `teamLedgerToolsExtras()`。
 */
function recoveryExtras() {
	return {
		// ---- 两条状态词（§11.9.3 的 vacancy / seated-dead 口径，域内直接拼进文案）----
		VACANT_LABEL,
		SEATED_DEAD_LABEL,
		// ---- 两条会话 id 形状常量（pluginSessionIdMatches 的「耐久半」判据）----
		TEAM_SESSION_ID_ILLEGAL,
		TEAM_SESSION_ID_SUFFIX,
		// ---- 序列化助手（fail-closed 报告里那句句柄读数）----
		safeJson,
		// ---- 名册镜像与写门（门被钉：只注入不搬；镜像两条与换届域同一份实现）----
		writerGate,
		writeRosterMirror,
		mirrorNote,
		// ---- 批 P 的继承读数与逐项行渲染 + §4.2 (c) 自建继任者支路（定义仍在入口，下一小单随交接文档族搬）----
		inheritanceRowList,
		collectInheritableSettings,
		buildTeamSessionResumeOptions,
		appointSelfBuiltSuccessor,
	};
}

/**
 * ★ 批 R 第 14 小单（域拆分）：`lib/team-session-creation.js` 需要的**入口侧出口**，一处装配。
 *
 * 为什么是注入而不是 import：域档**不许**导入入口（那会构成 ESM 环，实跑当场 TDZ）—— 先例是
 * `forensics.js` 的 `wireForensics()` 与本档上面八条 `rotationExtras()` / `registrationExtras()` /
 * `teamRegistrationExtras()` / `teamLedgerToolsExtras()` / `policyStoreExtras()` / `messagingExtras()` /
 * `watchdogExtras()` / `recoveryExtras()`。这 11 条**全部是入口侧仍然要用的出口**（按归属分四组：
 * 唯一创建落点 · 标题与问句 · pending 意图 · 批量确认框的四个字面量与全局标签）；搬走任何一条都会变成
 * 「同一函数两份」（设计档 §6 明令禁止双事实源），而入口**不能**再导出给域档静态导入（环）⇒ 缝是唯一
 * 不破环的路。绑定与被搬前**逐个同一**，所以注入之后行为逐字不变。
 *
 * ★ 被钉符号在这张表里出现**一条**：`buildTeamSessionCreateOptions` —— 它**没有搬**（定义与文档注释仍在
 *   入口，那条「按函数自身锚点切片」的源码锁读数因此一字不变），只作为依赖经缝传入；`createRootAgent`
 *   里那一处调用是本域对它的**全部**引用。
 */
function teamSessionCreationExtras() {
	return {
		// ---- 唯一创建落点（§10.2.2 的 create options；被钉：只注入不搬）----
		buildTeamSessionCreateOptions,
		// ---- 标题与确认框那一行问句（§10.2.8.4 的槽位契约，定义仍在入口的渲染族里）----
		teamSessionTitle,
		teamSessionDialogQuestion,
		// ---- pending-create 意图的两条读写（durable 台账，定义仍在入口）----
		addTeamSessionPending,
		removeTeamSessionPending,
		// ---- 启动任务的外壳（§10.2.3；定义仍在入口的 `registerTeamSessionRoles` 族旁）----
		teamSessionKickoffMessage,
		// ---- 批量确认框的四个字面量 / 时限（定义仍在入口的 §10.2 常量区）----
		TEAM_SESSION_DIALOG_ID,
		TEAM_SESSION_CONFIRM_TIMEOUT_MS,
		TEAM_SESSION_CONFIRM_LABEL,
		TEAM_SESSION_PENDING_TTL_MS,
		// ---- 全局标签（warn 行前缀）----
		PLUGIN_LABEL,
	};
}

/** Stable Cordis plugin name (also the package id the client half rides on). */
const name = "dsh-team-link";
/** Services this host row needs before it activates. The remaining services
 * (userQuestions, settings, webServer, commands, agentPresets) are resolved at
 * runtime and degrade gracefully when absent: sends refuse without an approval
 * UI, approval memory falls back to process-local state, and the export route is
 * skipped while the export tool keeps working. `settings` and `webServer` are
 * read through that same runtime channel, but a single read at apply time is a
 * time-of-activation snapshot (cordis `ctx.get` only returns ACTIVE providers,
 * §9.1.2) — so both are re-tried after activation via `ctx.inject([...])`, the
 * policy store additionally retries lazily on every `get()`/`update()`, and any
 * failure to attach leaves a log line instead of degrading silently
 * (§9.1.3 / §5.3). `commands` (the §10.2 ② `/team_session` registration) rides
 * that same ordered-injection channel, so this array keeps its four entries: an
 * optional dependency must never grow it (§10.2.1 / §10.3). `agentPresets` — the
 * preset every created session is composed from — is read with a plain `ctx.get`
 * AT CREATION TIME instead (a command runs long after activation, and the read
 * belongs next to the `agents.create` it feeds); its absence is the one branch
 * that may skip the preset face, and it leaves one warn per created session. */
const inject = ["sessionReferenceResolver", "tools", "sessionQuery", "agents"];

const PLUGIN_LABEL = "dsh-team-link";
/** Cap on sessions rendered by the list tool. */
const LIST_LIMIT = 50;
/** Cap on sessions given a surface read — the topic/activity digest AND the §3.1
 * liveness signal both fold the same surface. One cold log costs a zstd
 * decompression plus a surface projection, so the list tool reads a bounded
 * window and the rows past it say so instead of showing a verdict computed from
 * nothing (see {@link LV_WINDOW_NOTE}). */
const PREVIEW_SESSIONS = 12;
/** Liveness line of a row outside that window: the readings below it are a
 * snapshot of a BOUNDED read, so an unread row labels itself unread rather than
 * omitting the line or printing a verdict with no surface behind it. The row
 * itself still lists (id, agent state, creation time, provisional marks). */
const LV_WINDOW_NOTE = `未读（超出快照窗口 ${PREVIEW_SESSIONS}）—— 本行未读取会话日志：verdict / 静默时长 / goal / 主题 / 最近动态均未判定（代理状态见该行的运行标志）。`;
/** §4.1（可观测批 A）the list tool's two read-window controls: BOTH optional and
 * MUTUALLY EXCLUSIVE. They exist because "12" is a BUDGET, not a capability limit
 * —每读一个会话日志都是一次 zstd 解压 + 一次投影，所以提高默认值等于把超时风险
 * 塞回每一个调用；把「读哪些」的决定权交回调用方，成本上限才不动的。
 *
 * Three paths, ONE invariant (§4.1 成本不变量, asserted by U7):
 *   - 无参数      → `shown.slice(0, PREVIEW_SESSIONS)`（现状逐字不变）；
 *   - `offset=k`  → `shown.slice(k, k + PREVIEW_SESSIONS)`；
 *   - `readIds`   → 点名优先占额，其余按原顺序补足到 PREVIEW_SESSIONS。
 * 超限一律**拒绝**（不是静默截断，N2），且拒绝发生在任何 surface 读之前 ——
 * 因此被拒的那次调用是**零读**（U4/U5/U6：拒绝路径由 stub 计数断言）。 */
const LIST_READ_MODES = new Set(["default", "named", "offset"]);
/** §4.2（可观测批 A）the status card's own bounds. 活性半边照旧守
 * PREVIEW_SESSIONS 那条预算（同一个读窗、同一种标注，U7 断言 ≤12）；台账尾是另一种
 * 成本（每团队一次文件读）与另一个问题（「最后几条」），所以有它自己的界 —— 默认 5、
 * 上限 20，**超出即拒绝**（不是静默截断：状态卡是要一屏的，静默截断会让它悄悄变成十屏）。 */
const STATUS_TASKS_TAIL_DEFAULT = 5;
const STATUS_TASKS_TAIL_MAX = 20;
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
const TASKS_TAIL_DISPLAY_CHARS = 300;
/** §4.2 台账行的**显示**形态（批 F · FR-4）。前置：`line` 是盘上的**原始行**（可能很长）。
 *  后置：**只影响显示** —— 盘上文件与 `team_link_team_read` 的返回一字不动；未超宽时
 *  **逐字节**返回入参（`===`，不是「看起来一样」）。
 *  ★ 截断标记点名全文的出处（`team_link_team_read`），否则读者会以为黑板里就存了这么点。 */
function forDisplay(line) {
	const s = String(line);
	const points = [...s];
	return points.length <= TASKS_TAIL_DISPLAY_CHARS
		? s
		: `${points.slice(0, TASKS_TAIL_DISPLAY_CHARS).join("")}…（已截断，全文见 team_link_team_read）`;
}
/** §4.2 状态卡自己的「未读」句：与 {@link LV_WINDOW_NOTE} 同一条纪律，但点名**本卡**的
 * 窗口 —— 一张只读了 12 行的卡不能借用列表工具的措辞说起别人。 */
const STATUS_LV_WINDOW_NOTE = `未读（本卡只读了前 ${PREVIEW_SESSIONS} 行）—— 本行未读取会话日志：verdict / 静默时长 / goal 均未判定（代理状态见会话面一段）。`;
/** §C1（客户端面批）团队面板的「未读」句：同一条纪律的**第三个**说话人 —— 面板既不是列表
 * 工具也不是状态卡，它得点名**自己**的窗口（借用别人才是那条纪律要禁的）。
 *
 * 评审修复轮 🔵#3：面板能**翻页**（`offset=k`），所以这句话必须跟着页走 —— 写死「前 12 行」
 * 在第二页上就是一句与实况相反的降级句（那一页读的是 13–24 行）。第一页字节不变，分页那一页
 * 由 {@link panelWindowNote} 换成点名**本次这一页**的措辞。 */
const PANEL_LV_WINDOW_NOTE = `未读（本面板只读了前 ${PREVIEW_SESSIONS} 行）—— 本行未读取会话日志：verdict / 静默时长 / goal 均未判定（代理状态见上面那一行）。`;
/** §C1 评审修复轮 🔵#3：分页那一页的同一句话 —— 点名**本次这一页**（从第 offset+1 行起），
 * 不再自称「前 12 行」。offset 为 0 / 缺省时逐字复用 {@link PANEL_LV_WINDOW_NOTE}（第一页
 * 的字节一个都不动：客户端夹具与被断言过的旧读数都停在那一句上）。 */
function panelWindowNote(offset) {
	const start = (typeof offset === "number" && Number.isInteger(offset) && offset > 0 ? offset : 0) + 1;
	if (start === 1) return PANEL_LV_WINDOW_NOTE;
	return `未读（本面板本次只读了 ${PREVIEW_SESSIONS} 行，从第 ${start} 行起）—— 本行未读取会话日志：verdict / 静默时长 / goal 均未判定（代理状态见上面那一行）。`;
}
/** §C1 只读团队面板路由的路径（与导出路由同一道栅栏；**一处**声明，路由注册与测试共用）。 */
const PANEL_ROUTE_PATH = "/team-link/panel";
/** §C1 面板载荷的缺数说法（R4 的段级出口）：`present:false` + 这一句。 */
const PANEL_NO_SESSION_IDENTITY = "本次请求没有会话身份（?session=<id> 缺席）：面板不知道「当前工作区」是哪一个，会话面/读窗段不可读（不猜、不冒充）";
/** §4.2 反面预警注记的输入类型：「surface 消息」是两类消息事件（user/message 与
 * assistant/message）—— 与 §3.1 的静默读数同一批事件，只是这里要的是**时间戳的分布**
 * 而不是最后一枚。 */
const SURFACE_MESSAGE_TYPES = new Set(["user/message", "assistant/message"]);
/** Liveness thresholds in minutes (§3.1): idle silence past `LV_SILENT_MIN` is
 * the P1 symptom ("双端都在等"), and a running turn past `LV_RUN_MIN` is
 * reported as long-running rather than healthy. */
const LV_SILENT_MIN = 10;
const LV_RUN_MIN = 30;
/** A liveness reading is a snapshot of a moving system, so every row says when it
 * was taken and when it stops being trustworthy (§3.1 防偏离 regulations). */
const READ_STALE_NOTE = ">2min 作废";

// ---------------------------------------------------------------------------
// §4.1–§4.3（B 批：团队形态）常量与渲染的**唯一事实源**
// ---------------------------------------------------------------------------

/** §4.1 形态的闭集：两档。闭集外的 `mode` 由 `normalizeTeams` 降级为默认档**并留痕**
 * （沿用既有范式：手改出来的行必须降成**可读状态**，绝不降成不可读命名空间）。 */
const TEAM_MODE_SESSIONS = "sessions";
const TEAM_MODE_AGENT_TEAM = "agent-team";
const TEAM_MODES = new Set([TEAM_MODE_SESSIONS, TEAM_MODE_AGENT_TEAM]);
/** 闭集渲染为一行 —— 每一处拒绝都渲染**这个**常量，于是拒绝文案永远不会广告一个与校验
 * 不同的闭集（「一处事实一处渲染」）。 */
const TEAM_MODE_LIST = [...TEAM_MODES].join(" / ");
/** §4.2 Lead 会话 id 的形状（第一道校验）。与 `TEAM_SESSION_ID_ILLEGAL` 同一个字符类，但这里是**收**：
 * 首字符必须字母或数字，其后 0–63 个 `[A-Za-z0-9._-]`。 */
const LEAD_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
/** §4.2 确认框的单选标签（与既有三个对话框同形：一个确认、一个取消）。 */
const MODE_DIALOG_ID = "team-mode";
const MODE_CONFIRM_LABEL = "切换";
const MODE_CANCEL_LABEL = "取消";
/** §4.2 写路径探测失败的**指路**（US3）：探测不到就点名怎么开，绝不悄悄退回多会话档。
 *
 * **通用表述（D1，2026-09-27 实测更正）**：这条只对「**当前活动的 profile 确实没装载**该组合包」的
 * 情形有意义 —— 本部署的 desktop profile（`DSH_PROFILE=desktop`）**已经装载**它，所以真机走到
 * 的通常不是「没开」，而是「服务在场但本次调用方不是成员」。旧文案断言「本部署未启用」是个**假阴性**
 * 的来源，因此改成让调用方按当前活动 profile 自查，并明说「已经在那里 ⇒ 别的原因」。
 * 兜底路由 {@link MODE_SETTINGS_FALLBACK} 单列一行（设置 UI 永远是超级写者）。 */
const AGENT_TEAMS_HOWTO = "怎么开：先看你**当前活动的 profile** 的 `dsh.profile.bundles` 里有没有 `@deepseek-ai/dsh-experimental-agent-team-profile`（DSH 随包提供、默认关闭）——没有就把它加进去（写完重启 shell 生效）；若已经在那里，说明拦住本次切换的是上面那一行的原因，不是「没开」；确认可用之后再重发本次切换。";
/** D1 补的**兜底路**：形态就落在 settings 的两个键上，而设置 UI 永远是超级写者 —— 工具的所有门
 * （writer gate / 确认框 / 宿主探测）都拦不到它。缺了这句话，一次假阴性就会把用户卡死。 */
const MODE_SETTINGS_FALLBACK = "兜底路（永远可用）：形态就落在 settings 的 `team-link.teams[].mode` / `leadSessionId` 两个键上 —— 用户经设置 UI 永远是超级写者，可以直接在设置里改这两个键（工具侧的那些门拦不到设置 UI）。";
/** §4.1 形态降级的**留痕**：`normalizeTeams` 是纯函数（拿不到 ctx，打不出日志），所以留痕落在
 * **读面**上，由这张进程内表承载（不落 settings、不落任何持久物 —— 重启即忘，与看门狗去抖同一条
 * 纪律：宁可少一条痕，也不留会误判的持久状态）。 */
const TEAM_MODE_DEGRADATIONS = new Map();
/** §4.3(3) 名册投影的**来源文案**（写死，各有断言）。可读时用第一种；不可读时**按分支**取首行 ——
 * 探针有五条不可读分支（服务缺席 / 缺方法 / 无会话身份 / 调用方非成员 / 读取抛错），其中只有
 * **服务缺席**能说「本部署未提供该投影」；其余四条一律用**中性首行**，真正的原因写在紧随的
 * 「（不可读原因：…）」行里。D2 的教训：无条件先打那一句会让首行与原因行**自相矛盾**
 * （真机最常走到的正是「服务在场、调用方不是成员」那一支）。 */
const TEAM_MODE_ROSTER_READABLE = "来源：宿主 agentTeams 投影（本部署可读）";
const TEAM_MODE_ROSTER_UNREADABLE = "成员名册不可读（本部署未提供该投影）—— 仍可读 Lead 与形态";
/** 中性首行：服务在场但读不到（四条分支共用），原因由下一行点名。 */
const TEAM_MODE_ROSTER_UNREADABLE_NEUTRAL = "成员名册不可读 —— 仍可读 Lead 与形态（哪一条读不到，见下一行的原因）";
/** §4.3(4) 能力矩阵 = **父档 §2.3 的表**，本批**逐行照抄、不改口径**（README 的同一张表与
 * 本常量同源；改一处即两处，这是本仓「一处事实一处渲染」的既有规矩）。 */
const TEAM_MODE_CAPABILITY_ROWS = Object.freeze([
	{ ability: "跨会话投递（team_link_send）", sessions: "✅ 主用途", agentTeam: "❌ 成员是子代理，不是可投递目标" },
	{ ability: "双门批准 / 配对", sessions: "✅", agentTeam: "❌ 用不上（宿主那套没有独立信任模型）" },
	{ ability: "换届（rotate）/ 恢复（recover）", sessions: "✅", agentTeam: "❌ 没有可换届的会话；Lead 会话没了团队就散了" },
	{ ability: "看门狗（watch）", sessions: "✅", agentTeam: "❌ teammate 不是根代理，盯不了" },
	{ ability: "黑板（decisions / discipline / tasks）", sessions: "✅", agentTeam: "⚠️ 仍可用，但只有 Lead 一方读写" },
	{ ability: "roster 身份 / 版本史", sessions: "✅", agentTeam: "⚠️ 只记「本团队是 agent-team 档 + Lead 是谁」" },
	{ ability: "团队状态卡（只读）", sessions: "✅", agentTeam: "⚠️ 成员部分读宿主投影（2026-09-27 已核：本部署已挂载该服务 ⇒ 探针 available=true）" },
	{ ability: "会话深链 / 导出", sessions: "✅", agentTeam: "✅ 与形态无关" },
]);
/** §4.3(4) 的那句**结论**（父档 :67）：agent-team 档不是「另一种平等的形态」。 */
const TEAM_MODE_CONCLUSION = "结论：agent-team 档应叫「单会话兜底档」，不是「另一种平等的形态」—— 多会话不可用时才切，切过去就等于放弃跨会话的全部能力。";
/** §4.3(5) 的**形态诊断行**：只提示，绝不自动切（红线 6；`set-mode` 永远由人触发）。 */
const TEAM_MODE_DIAGNOSTIC = "⚠ 多会话通道看起来不可用（列表里没有其他会话）—— 你可以让协调者切到 agent-team 档（team_link_roster action=set-mode）（只提示：本插件绝不自动切档，切档永远由人在确认框里点一下）。";
/** §4.4 的「不会迁移的三件事」——切换确认框正文里逐条列出（**提示式，不阻断**）。 */
const TEAM_MODE_NO_MIGRATION_LINES = Object.freeze([
	"切换后不会迁移：",
	"① 信任（配对 / 白名单 / 记忆目标 —— 都要人重新批准）",
	"② 成员名册（agent-team 的成员不会变成会话；切回来的多会话成员也不会自动出现）",
	"③ 任务归属（宿主的任务板不跟随；台账仍是本插件的账）",
]);

/** Verdicts the cross-session watchdog acts on (§3.2.3): a silent idle target, a
 * root-cause goal-disarmed target, and a target whose agent is gone. */
const TICKABLE_VERDICTS = new Set(["silent-idle", "goal-disarmed", "dead"]);
/** Watchdog limits (§3.2.4, anti-runaway): at most this many registrations per
 * watcher session, and these floors/ceilings on the thresholds a caller may set. */
const WATCHDOG_MAX_PER_SESSION = 3;
const WATCHDOG_MIN_SILENT_MINUTES = 10;
const WATCHDOG_DEFAULT_SILENT_MINUTES = 10;
const WATCHDOG_MIN_INTERVAL_MINUTES = 5;
const WATCHDOG_DEFAULT_INTERVAL_MINUTES = 5;
const WATCHDOG_MAX_TTL_HOURS = 24;
const WATCHDOG_DEFAULT_TTL_HOURS = 12;
/** Registration id prefix; distinct from `slp-` so the two kinds never collide. */
const WATCHDOG_ID_PREFIX = "wd-";
/** Tick message id prefix (§3.2.3). The client card reads the `slp-` stem. */
const WATCHDOG_TICK_ID_PREFIX = "slp-wd-";
/**
 * FR-3（批 1）自动注册的两档来源（设计档 §7.1）。`origin` 是**加性**字段：存量行没有它，
 * 归一化按 `manual` 读（零迁移）。两档的差别只有两条 —— 手工那一档占
 * {@link WATCHDOG_MAX_PER_SESSION} 的额度，工作台摘要只发给 auto 那一档
 * （consult #26 D3：手工 register 的 watchIdle 默认值 = false，既有行为逐字不变）。
 */
const WATCHDOG_ORIGIN_MANUAL = "manual";
const WATCHDOG_ORIGIN_AUTO = "auto";
/** auto 注册的巡检间隔（consult #26 §4.3「silent=10 / interval=10 / ttl=12h」）：它是「全队一条」。 */
const WATCHDOG_AUTO_INTERVAL_MINUTES = 10;
/** 工作台摘要的去抖间隔：同一注册两条摘要至少隔这么久（§4.6「≥10min」）。 */
const WATCHDOG_DIGEST_DEBOUNCE_MS = 10 * 60000;
/**
 * patrol 驱动的换届清扫的最小间隔（有界修复轮 F · 评审 #7 🔵）。
 *
 * FR-7 之后**每条注册**都有自己的定时器，而每次巡逻都会把 M4 的过期清扫带一遍
 * （§3.6.2 评审 #4：一个后台定时器兼两件事）⇒ N 条注册 = 每个间隔 N 次清扫。清扫本身幂等，
 * 但 N 次是纯冗余（它还广播、还写 roster）。去抖把窗口内的 N 次压回 1 次；真正的时限由
 * 懒调用那几条路（roster / rotate / team_read / /team_session / /team_rotate）兜着 ——
 * 它们调的是 `rotation.sweep` 本体，**不经过**这道门（一分钟的粒度对 30 分钟的 TTL 足够）。
 */
const PATROL_SWEEP_MIN_INTERVAL_MS = 60000;
/**
 * ★ 批 G · FR-R1（`docs/2026-10-12-watchdog-renewal-design.md` §5/§7）：auto 工作台注册的**续期窗口**。
 *
 * 语义：巡逻遇到一条 `origin === "auto"` 的行时，只有「尚未过期 ∧ 距到期 ≤ 本窗口」才顺延它的租约
 * （`expiresAt = now + WATCHDOG_DEFAULT_TTL_HOURS`）；`now > expiresAt` 的行照旧走删除门（**不复活**，
 * 设计档 §8 U10 与 §9 的「不复活」行）。
 *
 * 为什么是 **2h**（设计档 §4 D4，父侧裁定）：auto 巡检间隔是 {@link WATCHDOG_AUTO_INTERVAL_MINUTES}
 * = 10 分钟 ⇒ 2h = **12 次**续期机会，容忍休眠与抖动；而写频不受影响 —— 续期后新窗口顺延到
 * `+12h - 2h = +10h`，即「每条每 10 小时一次写」，不是每 10 分钟一次（U3 钉的就是这一条）。
 * 被否决的备选：窗口 0（「到期即续」）依赖「过期行仍有巡逻定时器」，而 `rearm()` **不给过期行挂表**
 * ⇒ 生产上到期行的巡逻根本不会跑，前提不成立；窗口 30min 的余量偏紧。
 */
const WATCHDOG_RENEW_WINDOW_MS = 2 * 3600000;
/** 摘要正文的固定开场 —— 与告警 tick 的 `[watchdog]` 严格分离（两条通道各写各的话）。 */
const WATCHDOG_DIGEST_LABEL = "[workbench]";
/**
 * ★ 批 J · FR-J1（`docs/2026-10-13-coordinator-signal-design.md` §5 FR-J1 · §8 U1）：告警档
 * 「**有活没派**」的固定开场 —— 第三条通道，与 `[watchdog]`（失联三态）和 `[workbench]`（分组
 * 摘要）各自独立：它**不与人共享指纹**（§4 D2），所以不会被换组或换号吃掉。
 */
const WATCHDOG_IDLE_ALERT_LABEL = "[idle-unassigned]";
/**
 * ★ 批 J · FR-J1（设计档 §5 FR-J1 · 需求档 NF-J2 的 ★ 评审 🔴#1 裁决）：**同一段至多投几次**。
 *
 * 「段」= 同一组空闲成员的签名（`idleAwait` 的 id 序列）。窗口外**允许复投**（`bac-1009` 那次
 * 持续了数小时，一次性告警错过就永久没了 ⇒ 信号不许沉没），但每段**至多 3 次** ——
 * 「不刷屏」由这个上限保住。签名一变（成员集合变了）即重置计数。
 */
const IDLE_ALERT_MAX_PER_EPISODE = 3;
/**
 * ★ 批 J · FR-J2（设计档 §5 FR-J2 · §10-1 的**用户裁定**）：协调者**自身**上下文压力的告警阈值。
 *
 * 为什么是 **50**（诚实版理由，设计档 §4 D4 的 §10-1 改写）：它覆盖动机场景 —— 2026-10-13 那次
 * 真机事故里，协调者在 **40.1%** 时就已经在读别人的历史；50 让那一档当场响，同时仍留反噪余量
 * （低于它只在资源行里报读数，不额外打扰）。它是**具名常量**：将来调阈值只改这一行。
 * 被否决的备选：设计档 D4 原写的 **60**（会漏掉那次 40.1% 的场景）；不具名（判据无从可钉）。
 */
const LIAISON_PRESSURE_WARN_PERCENT = 50;
/**
 * ★ 批 J · FR-J2：压力告警档的固定开场 —— 与 `[watchdog]`（失联三态）、`[workbench]`（分组摘要）、
 * `[idle-unassigned]`（有活没派）各自独立的**第四条通道**：它讲的是**收件人自己**的窗口，
 * 与任何目标行的状态无关（所以它与那条注册的 `targets` 一个字都不相干）。
 */
const WATCHDOG_PRESSURE_ALERT_LABEL = "[pressure-warn]";
/**
 * Live watchdog controller of each plugin context. `apply` is the only writer;
 * `host-half.test.mjs` reads it (through {@link __testing}) so it can drive the
 * real `patrol` implementation with an injected clock instead of waiting.
 */
const WATCHDOG_BY_CTX = new WeakMap();
/** FR-1/FR-2(批 2) 的角色/资源段控制器。`apply` 是唯一的写者；`host-half.test.mjs` 经
 * `__testing.sectionsFor` 读它（注册表 + sync 读数），不复制一份进测试。 */
const SECTIONS_BY_CTX = new WeakMap();
/** ★ FR-16（批 7）判据面：`apply` 建的那个策略 store。夹具按它注册一个**计数处理器**，直接读
 * 「数据到位后到底被通知了几次」（U26 的「恰好一次」不能靠副作用反推 —— 处理器本身是幂等的）。 */
const POLICY_BY_CTX = new WeakMap();
/** ★ 批 K（FR-K1…FR-K4）判据面：`apply` 建的那个崩溃现场（心跳）控制器。`host-half.test.mjs`
 * 经 `__testing.forensicsFor` 读它 —— 拍号、落点、上一次那一拍、兜底定时器都从这里读真读数，
 * 不抄一份进测试。 */
const FORENSICS_BY_CTX = new WeakMap();

// ---------------------------------------------------------------------------
// upstream deep-link resolution (verbatim behavior; labels renamed only)
// ---------------------------------------------------------------------------

/**
 * `dsh://` deep links copied by the header button: `dsh://session/<sessionId>`.
 * Only ids shaped like harness session ids (`session-…`) are treated as
 * references, so an unrelated `dsh://` URI cannot hijack a message.
 */
const DSH_URI_RE = /dsh:\/\/session\/(session-[A-Za-z0-9_-]+)/gu;
/**
 * Legacy web deep links: `/s/<sessionId>`. Kept for pasted copies of the
 * browser-openable URL. The host part is ignored: session ids are opaque and
 * local to this DSH home.
 */
const WEB_DEEP_LINK_RE = /https?:\/\/[^\s"'<>()\\]+?\/s\/(session-[A-Za-z0-9_-]+)/gu;
/** Any occurrence of a supported link form, used as a cheap pre-filter. */
const ANY_LINK_RE = /dsh-session:[A-Za-z0-9_-]+|dsh:\/\/session\/session-[A-Za-z0-9_-]+|\/s\/session-[A-Za-z0-9_-]+/u;

/** True when the message is a direct user prompt rather than injected context. */
function isDirectUserMessage(message) {
	return message !== null && typeof message === "object" && message?.source?.kind === "user";
}

/** All text of one content block array, in order. */
function textOf(content) {
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => block?.type === "text" && typeof block?.text === "string" ? [block.text] : []).join("\n");
}

/**
 * Normalize one content block array for references: `dsh://` and web deep
 * links become markdown mentions, then every `dsh-session:` form is parsed
 * into a structured reference and replaced with its readable `@label` text.
 * Malformed or non-canonical URIs throw — callers must never let that fail a
 * user's turn.
 * @param content - the user message content.
 * @returns the normalized content and the structured references, or
 *   `null` when no reference-shaped text was present.
 */
function normalizeReferences(content) {
	let references = [];
	let changed = false;
	const normalized = content.map((block) => {
		if (block?.type !== "text" || typeof block?.text !== "string") return block;
		if (!ANY_LINK_RE.test(block.text)) return block;
		const withMentions = block.text
			.replace(DSH_URI_RE, (_full, sessionId) => `@[${sessionId}](${encodeSessionReferenceUri(sessionId)})`)
			.replace(WEB_DEEP_LINK_RE, (_full, sessionId) => `@[${sessionId}](${encodeSessionReferenceUri(sessionId)})`);
		const parsed = parseSessionReferenceText(withMentions);
		if (parsed.references.length > 0) changed = true;
		references = [...references, ...parsed.references];
		return { ...block, text: parsed.text };
	});
	return changed ? { content: normalized, references } : null;
}

/**
 * Register the upstream `agent/pre-step` listener that turns deep links found
 * in direct user prompts into sourced snapshot context. Fail-open throughout.
 * @param ctx - plugin context carrying the `sessionReferenceResolver` service.
 */
function registerDeepLinks(ctx) {
	ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
		const decision = await next();
		if (decision.kind === "reject" || signal?.aborted === true) return decision;
		// Fail open: no parse or snapshot failure may ever break a user turn.
		const targets = [];
		for (const message of decision.messages) {
			if (!isDirectUserMessage(message)) continue;
			try {
				const text = textOf(message.content);
				if (text === "" || !ANY_LINK_RE.test(text)) continue;
				const normalized = normalizeReferences(message.content);
				if (normalized !== null) targets.push({ message, ...normalized });
			} catch (error) {
				ctx.logger?.warn?.(`${PLUGIN_LABEL}: leaving a malformed link as plain text: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (targets.length === 0) return decision;
		// Build the modified decision; every later failure leaves it untouched.
		const result = { ...decision, messages: [...decision.messages] };
		for (const target of targets) {
			try {
				const prepared = await ctx.sessionReferenceResolver.prepare(agent, target.content, target.references, signal);
				const index = result.messages.indexOf(target.message);
				if (index === -1) continue;
				// The injected snapshot is the plugin's most direct carrier INTO the
				// caller's next request, and the referenced session's own log is exactly
				// where a lone surrogate can come from — so both messages are repaired
				// here (a no-op for well-formed text; the resolver's behavior is left
				// alone, only the bytes it hands over are).
				const replaced = { ...target.message, content: wellFormedContent(prepared.content) };
				const context = prepared.additionalContext === undefined || prepared.additionalContext === null
					? prepared.additionalContext
					: { ...prepared.additionalContext, content: wellFormedContent(prepared.additionalContext.content) };
				// Sourced snapshot first, then the readable direct prompt. `additionalContext`
				// is optional in the resolver's contract, so a missing one is dropped rather
				// than spliced in as `undefined` — the direct prompt must survive either way.
				if (context === undefined || context === null) result.messages.splice(index, 1, replaced);
				else result.messages.splice(index, 1, context, replaced);
			} catch (error) {
				if (signal?.aborted === true) return decision;
				ctx.logger?.warn?.(`${PLUGIN_LABEL}: skipped references in turn ${turn} step ${step}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return result;
	}, { prepend: true });
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------


/**
 * Truncate long text with an explicit marker (exports must stay honest). Cuts
 * on code-point boundaries only, for the same reason as `preview`. The count in
 * the marker is a code-point count too: it used to count UTF-16 code units, so
 * an astral character was billed as two "字符" while being cut in half.
 */
function truncate(text, limit) {
	const value = String(text ?? "");
	const chars = [...value];
	return chars.length <= limit ? value : `${chars.slice(0, limit).join("")}\n…[已截断 ${chars.length - limit} 字符]`;
}

/**
 * Tool output contract for every tool in this plugin: a plain string value,
 * rendered well-formed. `output.render` is the last stop before a return value
 * becomes model-facing tool-result content (dsh-tools calls it and snapshots the
 * blocks), so this single gate covers every return path — including the early
 * refusals whose text embeds log-derived ids and titles.
 */
function textOutput() {
	return {
		schema: { type: "string" },
		render: (_args, value) => [{ type: "text", text: wellFormed(String(value)) }],
	};
}

/** JSON.stringify that never throws and never returns undefined. */
function safeJson(value) {
	try {
		const text = JSON.stringify(value, null, 2);
		return text === undefined ? String(value) : text;
	} catch {
		return String(value);
	}
}

/** Workspace cwd of the agent executing a tool call. */
function agentCwd(exec) {
	const cwd = exec?.agent?.session?.header?.cwd;
	return typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
}

/** `「标题」(id)` when a title exists, the bare id otherwise. */
function sessionLabel(sessionId, title) {
	return typeof title === "string" && title !== "" ? `「${title}」(${sessionId})` : sessionId;
}

/** First direct-user text on a session surface — what the session was asked to do. */
function firstSurfaceUserText(events) {
	for (const event of events) {
		if (event?.type !== "user/message" || event.data?.source?.kind !== "user") continue;
		const text = textOf(event.data.content);
		if (text !== "") return text;
	}
	return undefined;
}

/** Latest human/model text on a session surface — what the session is doing now. */
function lastSurfaceText(events) {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.type === "assistant/message") {
			const text = textOf(event.data?.message?.content);
			if (text !== "") return text;
		} else if (event?.type === "user/message" && event.data?.source?.kind === "user") {
			const text = textOf(event.data.content);
			if (text !== "") return text;
		}
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// liveness signal and verdict (§3.1)
// ---------------------------------------------------------------------------

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
function readGoalSignal(ctx, sessionId, agent) {
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
function verdictOf(signal, cfg = {}) {
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
function buildLivenessSignal(ctx, sessionId, options = {}) {
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
function fmtSilence(ms) {
	return `${(ms / 60000).toFixed(1)}min`;
}

/** The target's last observed activity watermark (§3.1 timestamps), or `null`
 * when neither side is readable — the watchdog's "same silence period" key. */
function lastActivityOf(signal) {
	if (signal.lastAssistantAt === null && signal.lastInboundAt === null) return null;
	return Math.max(signal.lastAssistantAt ?? Number.NEGATIVE_INFINITY, signal.lastInboundAt ?? Number.NEGATIVE_INFINITY);
}

/** One-line goal summary for the signal face; `?` means the goal service is absent. */
function goalSummary(goal) {
	if (goal === null || goal === undefined) return "?";
	if (goal.phase === "none") return "none";
	const blocked = goal.blockedReason === null ? "" : ` blocked=${goal.blockedReason}`;
	return `${goal.phase}/${goal.activation}(${goal.rounds})${blocked}`;
}

/** The per-row liveness signal line of `team_link_list_sessions`. */
function livenessLine(signal) {
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
function readListReadWindow(args, shown) {
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
function listReadTail(read, shown) {
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

/** §4.2 `tasksTail` 的读法：默认 5、上限 20，超出**拒绝**（不是截断——状态卡要一屏）。
 * 与 §4.1 的边界同一风格：整数校验 + 有效区间写在拒绝里。 */
function readStatusTasksTail(value) {
	if (value === undefined || value === null) return { value: STATUS_TASKS_TAIL_DEFAULT };
	if (typeof value !== "number" || !Number.isInteger(value)) {
		return { error: `tasksTail 必须是整数（有效区间 1..${STATUS_TASKS_TAIL_MAX}，默认 ${STATUS_TASKS_TAIL_DEFAULT}）。` };
	}
	if (value < 1 || value > STATUS_TASKS_TAIL_MAX) {
		return { error: `tasksTail 越界（收到 ${value}）：有效区间 1..${STATUS_TASKS_TAIL_MAX}，默认 ${STATUS_TASKS_TAIL_DEFAULT}。` };
	}
	return { value };
}

/** 一行台账（tasks.md / decisions.md）的 ISO 列，读成 ms；读不出来的行返回 null。
 * §4.2 的反面预警注记数的是「T0 之后新增的行」，所以不可解析的行就是**不计入**——
 * 注记只陈述计数，绝不对文件下判断。 */
function ledgerRowTime(line) {
	const parts = String(line).split("|");
	if (parts.length < 2) return null;
	const time = Date.parse(parts[1].trim());
	return Number.isFinite(time) ? time : null;
}

/**
 * §4.2（可观测批 A）反面预警注记 —— 会诊提的「会话停止说话、只写行」。判据**写死在这
 * 一个函数里**（实现即此，U13 逐条断言）：
 *
 * - 时间锚 `T0` ＝ 本读窗内**最旧**的一条 surface 消息时间戳（读窗是**会话集合**不是
 *   时间窗，所以锚必须从数据里取）；
 * - `N` ＝ 该锚**之后**、本读窗内的消息条数；
 * - `M` ＝ `T0` 之后 tasks.md 的新增行数；
 * - **触发条件只此一条**：`N == 0 且 M > 0` ⇒ 打注记；否则**不打**（返回 null）。
 *
 * 成本是**零额外读**：两个计数都取自调用方已经读到的东西（本卡自己读窗里的 surface
 * 事件、本卡自己渲染的台账行）。它是**读数，不是裁决**（N4）—— 只陈述两个计数，不说
 * 「互核已死」。锚取不到（读窗内没有带时间戳的消息）时返回「无法计算」那句，**不猜**。 */
function reverseWarningNote(surfaceEvents, ledgerTimes) {
	const times = [];
	for (const event of surfaceEvents) {
		if (!SURFACE_MESSAGE_TYPES.has(event?.type)) continue;
		if (typeof event?.time !== "number") continue;
		times.push(event.time);
	}
	if (times.length === 0) {
		return { computed: false, text: "（反面预警注记无法计算：本读窗内没有带时间戳的 surface 消息——不猜。）" };
	}
	const anchor = Math.min(...times);
	const windowMessages = times.filter((time) => time > anchor).length;
	const ledgerRows = ledgerTimes.filter((time) => typeof time === "number" && time > anchor).length;
	if (windowMessages === 0 && ledgerRows > 0) {
		return { computed: true, text: `⚠ 窗口内 0 条消息 / 台账同期新增 ${ledgerRows} 行 —— 会话可能已停止说话只写行（读数，不是裁决）。` };
	}
	return { computed: true, text: null };
}

// ---------------------------------------------------------------------------
// policy store: settings-backed, memory fallback
// ---------------------------------------------------------------------------

/**
 * One registered watchdog (§3.2.2). `team` is the M2 roster hook; v1 allows an
 * empty value (pure sessionId list mode). Every field carries a fallback so a
 * hand-edited settings file degrades to "drop that entry" rather than making the
 * whole policy namespace unreadable — a namespace that fails to resolve would
 * fall back to memory and orphan the user's pairs.
 */
const WatchdogConfig = z.object({
	id: z.string().default(""),
	team: z.string().default(""),
	watcherSession: z.string().default(""),
	targets: z.array(z.string()).default([]),
	silentMinutes: z.number().default(WATCHDOG_DEFAULT_SILENT_MINUTES),
	intervalMinutes: z.number().default(WATCHDOG_DEFAULT_INTERVAL_MINUTES),
	expiresAt: z.number().default(0),
	createdAt: z.number().default(0),
	/**
	 * FR-3（批 1）: `manual`（手工 register）或 `auto`（/team_session 建队时自动挂的那一条）。
	 * 声明成 `z.string()` 而不是枚举，理由与 §4.1 的 `mode` 逐字相同：手改出来的闭集外值要能在
	 * 归一化里被降级**并留痕**（枚举会在 schema 层悄悄变成默认值，降级就无声了）。
	 */
	origin: z.string().default(WATCHDOG_ORIGIN_MANUAL),
});

/**
 * One role of one team (§3.3.1). `current` is an empty string in the stored
 * shape when the role is vacant; the normalized view renders that as `null`.
 * `pending` is the M4 rotation slot (§3.6) — M2 never writes one, but carries a
 * row written by a later milestone through untouched (`z.any()`).
 */
const TeamRoleConfig = z.object({
	role: z.string().default(""),
	current: z.string().default(""),
	pending: z.any().default(null),
	/** M4 (§3.6.2): timestamp of the last COMPLETED rotation of this role — the
	 * second half of the ten-minute anti-storm window (rateLimit(team, role, 10min)),
	 * the half a live pending cannot express. */
	rotationAt: z.number().default(0),
	/** M4 (§3.6.2 评审 #5): the open ratification window of an unconfirmed
	 * rotation — {at, expiresAt} — or null once ratified or rolled back. */
	provisional: z.any().default(null),
	/** M4 (§3.6.2 评审 #10): the verdict word the last settled rotation recorded
	 * — 已批准 / 待批准(24h) / 无待迁移对. Declared here on purpose: a declared field
	 * carries a default, so a row written without it still reads back in the
	 * canonical shape the replay compares. (It is NOT declared because the schema
	 * would otherwise drop it — `schemastery` keeps undeclared keys; see
	 * `DEFAULT_POLICY`'s `pendingCreates` note and 差异审计 B5.) */
	rotationStatus: z.string().default(""),
	history: z.array(z.object({
		session: z.string().default(""),
		from: z.number().default(0),
		until: z.any().default(null),
		note: z.string().default(""),
	})).default([]),
});

/**
 * One team of the roster (§3.3.1). `workspace` is captured from the creating
 * session's `agentCwd` at the first session-side upsert and is the root of both
 * the roster mirror and the blackboard directory. Every field carries a
 * fallback, for the same reason the watchdog entries do: a hand-edited settings
 * row must degrade to "drop that team", never to an unreadable namespace.
 */
const TeamConfig = z.object({
	name: z.string().default(""),
	createdAt: z.number().default(0),
	workspace: z.string().default(""),
	policy: z.object({ writer: z.string().default("coordinator") }).default({ writer: "coordinator" }),
	roles: z.array(TeamRoleConfig).default([]),
	/** M4 (§3.6.2): the pre-rotation snapshot a prepare takes
	 * ({at, pairs, trustedSenders, rememberTargets, roster}) — the evidence a
	 * symmetric revocation is rolled back against by hand. */
	rotationBackup: z.any().default(null),
	/** §4.1（B 批）团队**形态**：`sessions`（默认，多会话档）或 `agent-team`（单会话兜底档）。
	 * 声明成 `z.string()` 而不是枚举，正是为了让**手改出来的闭集外值**能进到
	 * `normalizeTeams` 里被降级**并留痕**——枚举会在 schema 层把它变成默认值，
	 * 降级就无声了（本仓最反对的那类事故）。 */
	mode: z.string().default(TEAM_MODE_SESSIONS),
	/** §4.1 只存**指针**（Lead 会话 id）；成员名册**一行都不落 settings**（N3：读时现算）。 */
	leadSessionId: z.string().default(""),
});

const PolicyConfig = z.object({
	receiveMode: z.string().default("ask"),
	trustedSenders: z.array(z.string()).default([]),
	blockedSenders: z.array(z.string()).default([]),
	// ★ 批 I（FR-I1 的第 2 点）: `blocks` 的**声明面**。每个字段都带缺省值，理由与
	// `WatchdogConfig` / `TeamConfig` 逐字相同 —— 手改出来的畸形行要能降级成「丢弃那一条」，
	// 而不是让整个 `team-link` 命名空间读不出来（命名空间解析失败会退回进程内存，把用户的
	// pairs 一起晾在一边）。**丢弃动作在归一化里**（`normalizePolicy` 的 `blockList`），
	// 不在 schema 里：schema 只负责把字段凑齐，判据（U16）读的是归一化后的视图。
	blocks: z.array(z.object({
		a: z.string().default(""),
		b: z.string().default(""),
		by: z.string().default(""),
		since: z.string().default(""),
	})).default([]),
	rememberTargets: z.array(z.string()).default([]),
	// M4 (§3.6.2): a pair migrated by a rotation may be PROVISIONAL — granted
	// without a present user and revoked automatically when the ratification
	// window closes. Both fields are declared here on purpose — for the ONE reason
	// declaration is for: they are part of the canonical shape this namespace owns,
	// so every stored pair carries them and the settings UI can render them.
	// (NOT because undeclared keys would be dropped: `schemastery` keeps them; see
	// `DEFAULT_POLICY`'s `pendingCreates` note and 差异审计 B5.) The TTL still must
	// never silently become permanent trust — that is the normalizer's job
	// (`pairList` writes `provisional: false` / `expiresAt: 0` for a hand-edited row
	// that omits them), not the schema's.
	pairs: z.array(z.object({
		a: z.string(),
		b: z.string(),
		createdAt: z.number().default(0),
		provisional: z.boolean().default(false),
		expiresAt: z.number().default(0),
	})).default([]),
	watchdogs: z.array(WatchdogConfig).default([]),
	teams: z.array(TeamConfig).default([]),
	/** §10.2 ② (§10.2.6): the durable `pending-creates` intents (see DEFAULT_POLICY). */
	pendingCreates: z.array(z.object({
		team: z.string().default(""),
		role: z.string().default(""),
		sessionId: z.string().default(""),
		createdAt: z.number().default(0),
		expiresAt: z.number().default(0),
		by: z.string().default(""),
	})).default([]),
	/** ★ FR-9（批 3）: 总开关 { role, resources }，缺省 true（见 DEFAULT_POLICY 的同名键）。 */
	sections: z.object({
		role: z.boolean().default(true),
		resources: z.boolean().default(true),
	}).default({ role: true, resources: true }),
	/** ★ 批 34 / FR-7: 台账写门的开关，**嵌套形态**（会诊 #78 裁定；见 {@link DEFAULT_POLICY}
	 * 的 `antiDrift` 注）。声明成 `z.boolean()` 而不是 `z.string()`：这一支只有两种取值，
	 * 非法值在 **zod 层**当场被拒（其余键用 `z.string()` 是为了「降级并留痕」，这里没有第三种
	 * 语义可降级到 —— 归一化那一层仍按「非 true 即 false」兜底，见 {@link antiDriftView}）。 */
	antiDrift: z.object({
		ledgerTransitionGate: z.boolean().default(false),
	}).default({ ledgerTransitionGate: false }),
});

/**
 * Create the messaging policy store. Prefers the settings service (namespace
 * `team-link`, user-editable through the settings UI and persisted by
 * the settings provider); falls back to process-local memory when settings is
 * unavailable so the approval flow still works within one run.
 *
 * §9.1.3: the read is NOT a one-shot snapshot. cordis `ctx.get` returns only
 * providers whose fiber is already active, and the settings provider finishes
 * its `[Service.init]` (load from disk → publish) asynchronously — so an
 * apply-time read can legitimately come back `undefined` and used to switch
 * this store to memory **silently and forever** (teams / watchdogs / pairs
 * never reaching `settings.yaml`). The three-part fix: try once immediately
 * (the fast path: a synchronous provider, tests included), otherwise leave one
 * warn and wait for the provider through the OPTIONAL `ctx.inject(["settings"],
 * cb)` — ordered but not a hard dependency, so a host without settings still
 * loads this plugin — and retry lazily on every `get()` / `update()`. The warn
 * is emitted at most once: no second silent fallback, and no warn storm either
 * (§5.3 红线).
 */
/** Current settings namespace for the messaging policy. */
const POLICY_NAMESPACE = "team-link";
/**
 * Pre-rename namespace (<= 0.2.4, when this plugin was dsh-session-link-pro).
 * Registered for the one-time data migration below; user trust data (pairs /
 * trustedSenders / blockedSenders / rememberTargets / receiveMode) must never
 * be orphaned by the rename.
 */
const LEGACY_POLICY_NAMESPACE = "session-link-pro";

// --- 策略持久化自持化（docs/policy-persistence-design-2026-09-27.md）§3.2/§3.3 ---
/** §3.3: the schema version this build writes into `policy.json`. */
const POLICY_FILE_SCHEMA = 1;

/**
 * ★ 批 L（FR-L2）**唯一的改名出口**。体内只有一句真改名，所以判据替换这一层就能注入
 * `EPERM` / `EBUSY`（`node:fs/promises` 是内建模块、它的 ESM 命名空间绑定在测试里不可改写
 * —— 与 `diskSpaceReader` / `stripImpl` 同一条理由，见 `__testing.setRenameThroughSeam`）。
 *
 * 前置：`tmp` 存在、内容已落盘（`fsync` 已过）。后置：成功 ⇒ 目标文件内容为 `tmp` 的内容、
 * `tmp` 消失；失败 ⇒ 抛原始错误（**不重试、不吞** —— 重试归调用方）。
 */
async function renameThroughSeam(tmp, file) {
	await rename(tmp, file);
}
/** 接缝的默认实现：`__testing.setRenameThroughSeam(null)` 回到它（与 `diskSpaceReader` 同款纪律）。 */
const renameThroughSeamDefault = renameThroughSeam;

/** FR-L2 的重试间隔（设计档 §6 的 `sleep`）。前置：`ms` 为正有限数。后置：至少等待 `ms`。不抛。 */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** FR-L3 三要素之二：错误码（errno）。读不到就说「无错误码」—— 不编造一个码。 */
function errorCodeOf(error) {
	const code = error?.code;
	return typeof code === "string" && code !== "" ? code : "无错误码";
}

/**
 * FR-L3 的留痕文本，三要素齐：**目标文件路径 + 错误码（errno）+ 写入者函数名**
 * （US-L3 的用户裁定口径，取代原写的 `file:line` —— 行号会随代码漂移，本仓文档纪律本就禁止
 * 拿行号当定位）。**门在调用方**（一段一行，见 `createPolicyStore` 的 `warnRenameFailureOnce`）：
 * 本函数只造文本，不做门控。
 */
function renameFailureMessage(file, error) {
	const code = errorCodeOf(error);
	const described = describeError(error);
	// ★ 批 L 交付评审 🔵#3：`describeError` 通常以「<code>: …」开头 ⇒ 与前面的「错误码 <code>」**重复**。
	//   这里把描述里那个前缀剥掉（只在确实是该前缀时才剥），留痕三要素一个不少。
	const detail = described.startsWith(`${code}:`) ? described.slice(code.length + 1).trimStart() : described;
	return `${PLUGIN_LABEL}: writePolicyFileAtomic: 原子改名失败（错误码 ${code}：${detail}）—— 目标文件 ${file}；本段只报这一行，随后最多重试到第 3 次（每次间隔 25ms）`;
}

/**
 * §3.4 原子写：**唯一名**临时文件 → `write` → `fsync` → `rename` 覆盖目标；目录先 `mkdir -p`。
 * 读只认 `policy.json`，所以崩在中间留下的半写临时文件永远不会被读成状态（U2）。
 * `fsync` 不能省：没有它，断电可能出现「rename 已落盘、而它指向的内容还没有」的窗口。
 *
 * ★ 批 K（FR-K1）把这一处从 `createPolicyStore` 的闭包里**原样上提到模块级**：崩溃现场心跳
 * （见 {@link createForensics}）要复用的正是**这一个**实现（设计档 §6 明写「复用既有的原子写助手」），
 * 而它此前只在 store 闭包内可见。`fsync` 顺序**一字未动**。
 *
 * ★ 批 L（FR-L1/FR-L2/FR-L3）—— 三处改动全在本函数内：
 *   ① **临时名每次写唯一**（FR-L1）：目标路径 + `.tmp-` + 进程号 + `-` + 8 位随机 hex。
 *      此前名字是**写死的**，两个写入者落在**同一个 inode** 上互相截断 —— 2026-10-13 真机事故里
 *      `policy.json` 变成「841,905 字节的完整 JSON ＋ 尾部 73 字节垃圾」（整份读不出来）。
 *      唯一名之后，「两个写者交错」失去物理前提。
 *   ② **改名有界重试**（FR-L2）：`rename` 在 Windows 上会被占用中的目标拒成 `EPERM`/`EBUSY`；
 *      最多 3 次（含首次）、间隔 25ms、**末次不再多等**；仍失败 ⇒ best-effort 清掉临时文件、
 *      **保留原始 errno** 抛给调用方（既有 `persistPolicyFile` 的 catch 接管 ⇒ 落点行降级）。
 *   ③ **失败留痕**（FR-L3）：首次退避时经 `warn` 出口留**一行**（三要素见
 *      {@link renameFailureMessage}）；重试耗尽后由既有 catch 再报「落点降级」那行 ——
 *      两行**各自受自己的「一段一行」门**。
 *
 * @param {string} file 目标文件（绝对路径）。
 * @param {string} text 完整文档。
 * @param {((message: string) => void) | null} warn FR-L3 的留痕出口：调用方传带自己那道门
 *   （模块级函数没有 ctx）。省略 ⇒ 不留痕（批 K 的心跳走这一支：它有自己的单行 warn，K 的
 *   函数体因此一字未动）。
 * @returns {Promise<void>} 成功 ⇒ 目标内容**恰为** `text`、且不留下任何临时文件；
 *   失败 ⇒ 抛**原始**错误（不吞、不替换）。
 */
async function writePolicyFileAtomic(file, text, warn = null) {
	await mkdir(path.dirname(file), { recursive: true });
	const token = createHash("sha256")
		.update(`${process.pid}:${Date.now()}:${Math.random()}`)
		.digest("hex")
		.slice(0, 8);
	// ★ FR-L1：唯一名 ⇒ 两个写入者**不可能**碰同一个 inode。
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
		let last = null;
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			try {
				await renameThroughSeam(tmp, file);
				renamed = true;
				return;
			} catch (error) {
				last = error;
				if (attempt === 1 && typeof warn === "function") warn(renameFailureMessage(file, error));
				if (attempt < 3) await sleep(25);
			}
		}
		throw last;
	} finally {
		// ★ 批 L 交付评审 🔵#1：**任何**失败路径都不留残渣 —— 不止「改名重试耗尽」，还有
		//   「`writeFile` / `sync` 抛」这一路（原实现只在耗尽分支里 `rm`，写失败会把 `.tmp-*` 留在盘上）。
		//   成功改名 ⇒ `renamed` 为真：临时名已被 rename **消费**，此时**不该**再删（删的是不存在的路径，无意义且会掩盖成功）。
		//   best-effort：清理自己失败**不许掩盖**原始错误（`finally` 内吞掉）。
		if (!renamed) {
			try { await rm(tmp, { force: true }); } catch { /* best-effort：不掩盖原始错误 */ }
		}
	}
}

function createPolicyStore(ctx) {
	const memory = structuredClone(DEFAULT_POLICY);
	/** Registered settings scopes; `scope !== null` means "attached". */
	let scope = null;
	let legacyScope = null;
	/** The unattached-window warn is written once and never repeated *inside that
	 * window*, so the lazy retries below cannot turn into a warn storm (U11:
	 * 有且仅有一行). 评审 round-3 🟡 #1: the unit this gate counts is the
	 * UNATTACHED WINDOW, not the process lifetime — `detach()` re-opens it, so a
	 * provider that returns and then refuses says so again instead of leaving a
	 * silently refused second window behind the first window's line. */
	let attachWarned = false;
	/** Set when a write landed in process memory — i.e. inside the startup
	 * window, before the store could attach (§9.1.3 数据一致性). Cleared once the
	 * window's outcome has been recorded (评审 round-3 🔵 #3), so a later window
	 * cannot re-fold — and re-warn about — a memory state that was already
	 * resolved; the `fold failed` outcome keeps it set, because those writes
	 * really are still memory-only and the next attach must try again. */
	let memoryDirty = false;
	/** True when the provider answered but REFUSED to register the legacy
	 * namespace. Kept apart from "there is no legacy namespace" so the post-attach
	 * chain line can tell the two apart (评审 round-3 🔵 #5); `attach` writes it on
	 * both branches of the legacy register, so it always describes the window that
	 * just attached. */
	let legacyRefused = false;

	// --- 策略持久化自持化（docs/policy-persistence-design-2026-09-27.md）§3.2-§3.5 ---
	/**
	 * §3.2 路径解析的结果：可写的落点（`ok: true`）或解析失败的原因。解析在 store 建立时
	 * 做**一次** —— 落点是这次进程生命周期的性质，不是每次读的属性。
	 */
	const policyPath = resolvePolicyFilePath();
	/** True once a load or a successful write proved the file really is a 落点 (档 2). */
	let fileUsable = false;
	/**
	 * §3.5 的文件侧原因码（后两个：路径解析失败 / 文件不可写），null = 文件侧没出过事。
	 * 它**只**描述文件；设置服务侧的「没注册出本命名空间」由 `serviceObserved` 表达。
	 */
	let fileReason = policyPath.ok ? null : policyPath.reason;
	/** §3.3 `foldedAt`：上一次折叠落定的时刻（null = 从未折叠）。 */
	let fileFoldedAt = null;
	/**
	 * §3.4 写失败：内存态保留 + warn，**一段失败 = 一行**（§5.3 红线不搞 warn 风暴）；
	 * 后续写入仍然重试（`persistPolicyFile` 每次都试），所以这不是「放弃了」。
	 *
	 * 代码评审修复轮 🟡#2：这道门过去是**进程级一次性**的，于是第一次失败 warn 过之后，
	 * 再下一次失败完全静默（与 `attachWarned` 按窗口复位的既有范式不一致）。现在由
	 * `persistPolicyFile` 的**成功分支**复位 ⇒ 一段失败报一行，成功后新的一段失败再报一行。
	 */
	let fileWriteWarned = false;
	/**
	 * ★ 批 L（FR-L3）：原子改名失败的留痕门 —— 同样是**一段一行**（与 `fileWriteWarned`
	 * 同一范式：写成功即复位）。这道门放在 store 里而不是模块级，有两个理由：模块级的原子写
	 * 助手**没有 ctx**（留痕出口只能由调用方传进去），而一个进程里可能同时有多个 store
	 * （判据夹具正是如此）—— 模块级的门会让**后一个** store 的失败静默。与 `fileWriteWarned`
	 * **各自独立**：一段里两行各受自己的门（重试那一行 + 落点降级那一行）。
	 */
	let renameWarned = false;
	/** FR-L3 的留痕出口：本条 store 的一段失败里**只放一行**（复位点见 `persistPolicyFile` 的成功分支）。 */
	const warnRenameFailureOnce = (message) => {
		if (renameWarned) return;
		renameWarned = true;
		ctx.logger?.warn?.(message);
	};
	/**
	 * §3.4 损坏档守卫（代码评审修复轮 🟡#1）：载入判定为损坏（读不出 / 非法 JSON / 没有
	 * policy 对象）之后**一律不覆盖**那份文件。上一版 `loadPolicyFile` 只留了一行 warn 说
	 * 「本次不会覆盖该文件」，而 `persistPolicyFile` **没有任何守卫** —— 文件后端下下一次
	 * 任何写入都会用原子 rename 把损坏文件整个替换掉，落点行还会从「⚠ 仅进程内存」翻成
	 * 「存储：文件」（`policyPlacement` 只看 `fileUsable`）。
	 *
	 * 处置出口是**人工**的：修好或移走该文件（AGENTS.md §七）。每个 store 只读一次文件，
	 * 所以人工修好后需重启进程 —— 这一点与 §3.5 的第 5 个原因码一起说给用户。
	 */
	let fileCorrupted = false;
	/** True once some context handed us a settings service — §3.5 `no-register` 那一支的判据。 */
	let serviceObserved = false;
	/**
	 * True once {@link loadPolicyFile} has been **entered** (whether or not it found a
	 * file). The file is read at most once per store, so the fast path's attach-time
	 * read (§3.1 档 4 的快路径分支) can never re-read a file the startup window already
	 * loaded — and, the other way round, a file that was absent at startup is not
	 * re-probed on every later attach.
	 */
	let fileLoadAttempted = false;
	/**
	 * True when this store actually spent time **unattached** — the §9.1.3 startup
	 * window, or a window opened by {@link detach} when the settings owner fiber went
	 * away (代码评审第 3 轮 🟡#2; the flag is re-set there, so it shares the warn
	 * gate's lifecycle instead of being written only once at activation). Only the
	 * fold line and the archive decision differ by it: a fold caused by the file
	 * backend of a *previous* run says so, instead of claiming a window that never
	 * happened — and this process's own file-backend mirror is not archived.
	 */
	let enteredUnattachedWindow = false;
	/**
	 * 未挂载窗口的**种类**（代码评审修复轮 🔵#4；第 3 轮 🟡#2 加 `"detached"`）：`"none"` =
	 * 没进过窗口（快路径，服务在 activation 就在场且注册成功）；`"refused"` = 服务在场但
	 * **拒绝注册**；`"late"` = 服务那会儿还没来 / 没法注册；`"detached"` = provider 掉线触发
	 * `detach()` 之后又回来（由 `detach()` 同步写入，不沿用 activation 的旧值）。
	 * `enteredUnattachedWindow` 由它派生，折叠那一行的**措辞**再按它分四支 —— 「拒注册后才挂上」
	 * 「provider 掉线后回来」「服务还没来」「服务从一开始就在场」是四件事，不能说成同一句。
	 */
	let unattachedWindowKind = "none";

	/**
	 * §3.3 文件文档。`policy` 走 `normalizePolicy`，所以**键集镜像** settings 命名空间：
	 * **十键**每次写全（权威读数：`host-half.test.mjs` 的 `U19_POLICY_KEYS`。本行原写
	 * 「八个键」—— `pendingCreates`（②）与 `blocks`（批 I）都是后来加的；批 L 按事实更正，
	 * 不写死一个会再次腐烂的数字），迁移型改动不会因为少写一个键而丢数据。
	 */
	function renderPolicyFileDocument(view, foldedAt) {
		return `${JSON.stringify({
			schema: POLICY_FILE_SCHEMA,
			savedAt: new Date().toISOString(),
			foldedAt: foldedAt ?? null,
			policy: normalizePolicy(view),
		}, null, 2)}\n`;
	}

	/**
	 * §3.1 档 2/3：把进程里的这份状态写成文件。永不抛 —— 写失败保留内存态 + warn，
	 * 并把落点降级成「⚠ 仅进程内存 —— 文件不可写」（R2：落点始终可核）。
	 */
	async function persistPolicyFile(options = {}) {
		if (!policyPath.ok) return false;
		// §3.4 损坏档守卫（代码评审修复轮 🟡#1）：载入已判定损坏 ⇒ 这一次写**不落盘**、
		// 那份文件**不被覆盖**，并且**每次写都如实留痕**（不静默，也不吞掉第二次以后）。
		// 状态留进程内存，落点行报第 5 个原因（见 POLICY_REASON_CORRUPT）。
		if (fileCorrupted) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: policy file ${policyPath.file} was judged corrupt at load — 本次写入未落盘，该文件**未被覆盖**；状态仅存进程内存，落点行会显示「原因：${POLICY_REASON_CORRUPT}」；人工处置：修好或移走该文件后重启`);
			return false;
		}
		const foldedAt = options.foldedAt === undefined ? fileFoldedAt : options.foldedAt;
		try {
			// ★ 批 L（FR-L3）：第三参是留痕出口 —— 改名失败时由它留**一行**（一段一行，见
			// `warnRenameFailureOnce`）。批 K 的心跳走的是「不传 ⇒ 不留痕」那一支，函数一字未动。
			await writePolicyFileAtomic(policyPath.file, renderPolicyFileDocument(memory, foldedAt), warnRenameFailureOnce);
			fileUsable = true;
			fileReason = null;
			fileFoldedAt = foldedAt;
			// 🟡#2：一段失败 = 一行 warn。写成功即**复位**这道门，于是「成功之后又失败」
			// 是新的一段，会再说一行（与 `attachWarned` 按窗口复位同一范式）。
			fileWriteWarned = false;
			// ★ 批 L（FR-L3）：改名那道门与落点降级那道门**各自**复位（两行各受自己的门）。
			renameWarned = false;
			return true;
		} catch (error) {
			fileUsable = false;
			fileReason = POLICY_REASON_UNWRITABLE;
			if (!fileWriteWarned) {
				fileWriteWarned = true;
				ctx.logger?.warn?.(`${PLUGIN_LABEL}: policy file write failed (${describeError(error)}) — 状态保留在进程内存里，落点行会显示 ⚠；后续写入仍会重试，本段内此行不再重复（写入一旦成功，本段告警复位，再失败会再报一行）`);
			}
			return false;
		}
	}

	/**
	 * §3.2 载入：**每个 store 只做一次**（`fileLoadAttempted`），由两个入口共用 —— 启动时
	 * 「没挂上 settings」那条（档 2），与 attach 时「服务为默认」那条（档 4 的快路径分支，
	 * 见 {@link loadFileIfServiceAtDefaults}）。`memory` 是文件的内存镜像，所以 attach 之后
	 * `get()` 继续读它。
	 *
	 * 读**不等于**写：这里只读。挂上服务时一个字节都不许写，是 §3.4 与 U6 的另一半，
	 * 由 {@link syncFileFromService} 的三个门保证。
	 *
	 * 代码评审修复轮 🟡#1：三条失败支（读不出 / 非法 JSON / 没有 policy 对象 —— 第 2 轮
	 * 🔵#2 把「policy 是数组」也并进第三条：数组不是命名空间镜像）在此置
	 * `fileCorrupted` —— 它们是「损坏」这一个判定，`persistPolicyFile` 据此**一律不覆盖**
	 * 那份文件，并把原因码升级为第 5 项 `POLICY_REASON_CORRUPT`。
	 */
	function loadPolicyFile() {
		if (fileLoadAttempted) return;
		fileLoadAttempted = true;
		if (!policyPath.ok) return;
		let text;
		try {
			text = readFileSync(policyPath.file, "utf8");
		} catch (error) {
			// ENOENT 不是故障：还没写过东西，落点只是**未定**（§3.5 的 not-active 一支）。
			// 别的错误是「文件在、读不出」—— 那才是真的没有落点，必须说出口。
			if (error?.code === "ENOENT") return;
			fileCorrupted = true;
			fileReason = POLICY_REASON_CORRUPT;
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: policy file ${policyPath.file} is unreadable (${describeError(error)}) — 状态仅存进程内存，且该文件不会被覆盖（原因：${POLICY_REASON_CORRUPT}）`);
			return;
		}
		let doc = null;
		try {
			doc = JSON.parse(text);
		} catch (error) {
			doc = null;
			fileCorrupted = true;
			fileReason = POLICY_REASON_CORRUPT;
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: policy file ${policyPath.file} is not valid JSON (${describeError(error)}) — 状态仅存进程内存，且该文件不会被覆盖（原因：${POLICY_REASON_CORRUPT}）`);
		}
		// 代码评审第 2 轮 🔵#2：`typeof doc.policy !== "object"` 对**数组**不设防（`typeof [] ===
		// "object"`），于是 `{"schema":1,"policy":[]}` 被当成一份合法空档：fileUsable 置真、
		// 落点行翻成「存储：文件 …」，**下一次任何写入**都用原子 rename 把它整个替换掉
		// —— 正是 U11 要防的「损坏档被覆盖」。数组不是命名空间镜像（`normalizePolicy` 会把它读成
		// 一份全默认的空视图），所以与「缺失 / null」同判损坏，走**同一条**置坏分支，不复制逻辑。
		if (doc === null || typeof doc !== "object" || doc.policy === null || typeof doc.policy !== "object" || Array.isArray(doc.policy)) {
			fileCorrupted = true;
			fileReason = POLICY_REASON_CORRUPT;
			if (doc !== null) ctx.logger?.warn?.(`${PLUGIN_LABEL}: policy file ${policyPath.file} has no policy object（policy 缺失 / null / 数组 —— 都不是命名空间镜像）— 状态仅存进程内存，且该文件不会被覆盖（原因：${POLICY_REASON_CORRUPT}）`);
			return;
		}
		const view = normalizePolicy(doc.policy);
		for (const key of Object.keys(DEFAULT_POLICY)) memory[key] = view[key];
		fileUsable = true;
		fileFoldedAt = typeof doc.foldedAt === "string" ? doc.foldedAt : null;
		// §3.1 档 4：文件里**本来就有**状态，与「未挂载期间的写入」是同一件事 —— 设置服务
		// 晚挂时它照样要折叠并入服务。不置这个位的话，文件在、重启后读到它的人却永远看不到
		// 它并入服务，档 4 就只在「本次会话刚写过」这一种情形下成立。
		if (!policyIsAtDefaults(view)) memoryDirty = true;
	}

	/**
	 * §3.3 裁决里的**归档**那一半：文件里也有一份非默认状态时，那一份先原样归档成
	 * `policy.superseded-<ts>.json`，裁决因此可复核（不做静默合并）。文件的重写不在这里
	 * —— 它是 {@link syncFileFromService} 的活，挂在整条链的末尾。
	 *
	 * `kind` 两种（分歧审计修复轮 🟡#5）：`"superseded"`（默认）= §3.3 判**服务胜**，
	 * 文件那一侧被胜出；`"folded"` = 文件那一侧被**并入**服务 —— 折叠之后文件会被改写成
	 * 「合并结果」，没有这份存档，被并入的那一份原字节就再也找不回来了。`"folded"` 只在
	 * **快路径**那一支用（那里文件里那份是唯一一份真值）；晚挂路径不存档，见 adoptMemoryWindow。
	 *
	 * 这一步是**簿记**，所以它永不抛：它失败只意味着「归档没落下来」，服务侧的折叠结论
	 * 不受牵连（否则一次附带的归档失败会把已经并入的写入误报成 `fold failed`）。
	 */
	async function archiveSupersededFile(archived, kind = "superseded") {
		if (!archived || !policyPath.ok || !fileUsable) return;
		try {
			const safeStamp = new Date().toISOString().replace(/[:.]/gu, "-");
			const archiveFile = path.join(policyPath.dir, `${POLICY_FILE_NAME.replace(/\.json$/u, "")}.superseded-${safeStamp}.json`);
			// 原样存字节：归档的是**文件那一侧**（被胜出或被并入的那一份），不是重新渲染的近似物。
			await writePolicyFileAtomic(archiveFile, readFileSync(policyPath.file, "utf8"));
			ctx.logger?.info?.(kind === "folded"
				? `${PLUGIN_LABEL}: 折叠存档：文件后端那一侧已并入设置命名空间（policy.superseded-${safeStamp}.json 存的是**并入前**的原文）— 随后文件会被改写成合并结果并盖 foldedAt`
				: `${PLUGIN_LABEL}: 折叠裁决：设置服务已有数据（policy.superseded-${safeStamp}.json 归档了文件那一侧）— 服务胜出，文件不并入，也不做静默合并`);
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: 归档文件那一侧失败（${describeError(error)}）— 服务侧结论不变`);
		}
	}

	/**
	 * §3.1 档 4 的收尾：**整条** attach 后置链跑完之后，把合并结果写回文件并盖 `foldedAt`。
	 * 之所以挂在链尾而不是折叠那一刻：链上还有旧命名空间迁移，它同样是「合并进来」的一部分，
	 * 写早了文件就少了那一份 —— 下次服务缺席时，那份信任数据等于凭空消失。
	 *
	 * 三个门（缺一不可）：路径解析成功、文件确实是本进程用过的落点（`fileUsable`）、服务已挂上。
	 * 纯设置部署里 `fileUsable` 恒为 false —— 所以这里一个字节都不写（§3.4 只写一处 / U6）。
	 *
	 * 第四个门（代码评审修复轮 🔵#3；第 2 轮 🟡#1 补齐 catch 那一支）：`foldedAt` **只在本次链上
	 * 确有折叠/裁决落定时**才盖新戳，判据取 {@link adoptMemoryWindow} 的结果 ——「none（未挂载期间无写入）」那一种启动根本没有
	 * 折叠发生，而旧实现无条件盖戳，于是 `foldedAt` 冒充「最近一次 attach 时刻」而不是
	 * 「折叠落定时刻」。回写本身不受影响（U3/U4/U8/U10 要求的「合并结果写回文件」照旧），
	 * 只是没有折叠的那一段保留上一次真正落定的戳（逐字节不动）。
	 *
	 * 第 3 轮 🟡#1 的两条收紧：① 判据从「不是 none」收成「**确已落定**的两个结局」
	 * （{@link memoryWindowOutcomeLanded}）；② `fold failed` 的那一支链尾**根本不调用**这里 ——
	 * 那个结局下回写会把窗口数据从内存与文件两边同时抹掉，见 attach 链上的门。
	 */
	async function syncFileFromService(options = {}) {
		if (!policyPath.ok || !fileUsable || scope === null) return;
		// 盖不盖章由**调用方**给，链的两支都显式说明：成功那一支给「本次链上确有折叠/裁决落定」
		// 那个判据（🔵#3），catch 那一支给 `false`（代码评审第 2 轮 🟡#1 —— 链在折叠结果产出
		// **之前**断掉，这一支读不到结果，所以没有资格盖新戳）。默认值取真只为向后兼容，
		// 两个调用点都不再依赖它。
		const foldHappened = options.foldHappened === true;
		try {
			const merged = get();
			for (const key of Object.keys(DEFAULT_POLICY)) memory[key] = merged[key];
			await persistPolicyFile({ foldedAt: foldHappened ? new Date().toISOString() : fileFoldedAt });
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: 合并结果回写文件失败（${describeError(error)}）— 服务侧结论不变，文件仍停在合并前的那一份`);
		}
	}

	/**
	 * §3.5 可核落点（R2 红线）。三态，读一次给一次 —— 不是启动时的快照。
	 *
	 * 代码评审第 2 轮 🔵#3：内存态那一支可以**带两个原因**。服务侧（`serviceObserved` ⇒
	 * `no-register`）与文件侧（`fileReason`：路径解析失败 / 文件不可写 / 文件损坏）是两条
	 * 独立的失效，两条都成立时**并陈**（`also`）而不是让 `no-register` 独占一行 —— 否则
	 * 「文件损坏、请人工处理」这条唯一的行动信号会被吞掉。四种单因形态逐字不变。
	 */
	function policyPlacement() {
		if (scope !== null) return { kind: "service" };
		if (fileUsable) return { kind: "file", file: policyPath.file };
		// 代码评审第 2 轮 🔵#3：两因并存时**并陈**。旧形状是 `no-register` 单方面胜出，于是
		// 「服务在场但拒注册 **且** 文件损坏」时，落点行只说 no-register —— 用户看不到「你的
		// 文件坏了、需要人工处理」这条**唯一的行动信号**（§3.4 的损坏档守卫）。主因仍取
		// `no-register`（与服务侧的既有形状一致），文件侧那一因并陈在后面；**四种单因形态
		// 逐字不变**（`also` 为 null 时拼出的就是原来那一行）。
		if (serviceObserved) return { kind: "memory", reason: POLICY_REASON_NO_REGISTER, also: fileReason };
		return { kind: "memory", reason: fileReason ?? POLICY_REASON_NOT_ACTIVE };
	}

	/** The one sentence the roster/status read faces lead with (§3.5). 两因并存时并陈（🔵#3）。 */
	function policyPlacementLine() {
		const placement = policyPlacement();
		if (placement.kind === "service") return `存储：设置服务（${POLICY_NAMESPACE} 命名空间）`;
		if (placement.kind === "file") return `存储：文件 ${placement.file}`;
		return `⚠ 存储：仅进程内存（重启即失）—— 原因：${placement.reason}${placement.also != null ? `；另：${placement.also}` : ""}`;
	}

	/**
	 * §3.5 落点的**来源**说法：读面里除了首行，还有状态卡段①标题那一处「来源：…」。
	 * 它必须跟首行说同一件事（设置 / 文件 / 内存三态），否则文件后端部署里首行写着
	 * 「存储：文件 …」而下一段照说「设置 team-link 的 teams 键」—— 两个互相打架的落点
	 * （分歧审计修复轮 🔵#9）。措辞与 {@link policyPlacementLine} 同源（同一组判据）。
	 */
	function policyTeamsSourceLabel() {
		const placement = policyPlacement();
		if (placement.kind === "service") return `设置 ${POLICY_NAMESPACE} 的 teams 键`;
		if (placement.kind === "file") return `文件 ${placement.file} 的 teams 键`;
		return "进程内存的 teams 键（重启即失）";
	}

	/** Where an unattached window writes: the file backend when the path resolved, memory otherwise. */
	const unattachedTail = () => (policyPath.ok
		? `文件后端 ${policyPath.file}（设置服务晚挂时折叠并入）`
		: `进程内存——${policyPath.reason}`);

	/**
	 * The live view: settings once attached, the file-backed mirror before that. A call
	 * that finds the store unattached is the third retry hook of §9.1.3 — a tool
	 * call (or the watchdog tick) is the earliest moment a provider that came up
	 * late can be picked up without a fiber of our own.
	 */
	function get() {
		if (scope === null) attachFrom(ctx);
		let view;
		try {
			view = normalizePolicy(scope !== null ? scope.get() : memory);
		} catch {
			view = normalizePolicy(memory);
		}
		settleAttachNotice(view);
		return view;
	}

	/**
	 * **纯读**的同一个视图：`get()` 的两件副作用都不做 —— 不跑 §9.1.3 ③ 的惰性重试
	 * （`attachFrom`），也不补 FR-16 的 attach 通知（`settleAttachNotice`）。已附着时读数
	 * 与 `get()` 逐字相同（都读服务那一份）；未附着时读文件/内存那一份。
	 *
	 * ★ 批 K（崩溃现场心跳）用它读 `sessions.roster` 与 `watchdogs`（设计档 §7）。
	 * **为什么不能用 `get()`**：`get()` 的第一行就是「未附着 ⇒ 重试附着」，而心跳是**后台观测**
	 * （NF-K4：它是观测，不是功能）。用 `get()` ⇒ 一次后台读数会在 activation 之后**自发**把
	 * store 挂上，于是「服务后端切换 + 内存窗口折叠 + attach 后置链 + `policy.json` 回写」
	 * 全被一次观测触发 —— 实测后果：`no-inject` 部署下既有判据
	 * 「U11 前置 —— 晚挂的 provider 不许被自己发现」（host-half.test.mjs:5739）变红，
	 * 而那条判据逐字对应 `get()` 的 JSDoc 所写的契约（「一个**工具调用**（或看门狗那一拍）
	 * 是晚挂 provider 能被拾取的最早时刻」）。观测**不是**一次工具调用，因此它不该享有那条钩子。
	 */
	function peek() {
		try {
			return normalizePolicy(scope !== null ? scope.get() : memory);
		} catch {
			return normalizePolicy(memory);
		}
	}

	/**
	 * ★ FR-16（批 7）: `get()` 首次拿到**非空数据**时**补一次** attach 通知（恰好一次）。
	 *
	 * 调用顺序是判据的一半：`dataReady` 先置位**再**通知 —— 处理器会同步回调 `get()`（`rearm()`
	 * 里就有一次），先置位才挡得住「通知→get→通知」的递归。`attachHandlers` 为空时**不消费**这次
	 * 机会（那一刻没有可通知的人；下一次 `get()` 再补），`notifiedWithData` 保证成功路径只发一次。
	 * 幂等由处理器自己保证（`rearm` / `ensureTeamAutoWatchdogs` 都是幂等的）。
	 */
	function settleAttachNotice(view) {
		if (!dataReady) {
			if (policyIsAtDefaults(view)) return;
			dataReady = true;
		}
		if (notifiedWithData || attachHandlers.length === 0) return;
		notifiedWithData = true;
		notifyAttached();
	}

	/** Mirror of {@link get} on the write side: retry, then write through the
	 * attached scope or into process memory (the startup-window fallback). */
	async function update(patch) {
		if (scope === null) attachFrom(ctx);
		if (scope !== null) {
			await scope.update(patch);
			return;
		}
		memoryDirty = true;
		for (const [key, value] of Object.entries(patch)) memory[key] = structuredClone(value);
		// §3.1 档 2：未挂载设置服务时，这一份状态**同时**写进插件自己的文件（§3.4 原子写）。
		// 「只写一处」（§3.4）的另一半在 `update()` 的 scope 分支：挂上服务之后这里一行都不跑。
		await persistPolicyFile();
	}

	/**
	 * One-time rename migration: when the legacy namespace (this plugin's
	 * identity before 0.3.0) still carries data and the current namespace
	 * is at defaults, copy everything over and reset the legacy namespace
	 * to base so the migration never repeats. Both non-default → the user
	 * already diverged under the new name; current wins, legacy kept.
	 *
	 * §9.1.3: called from {@link attach}, i.e. only once the current namespace
	 * really exists. At apply time this is a guaranteed no-op (nothing is
	 * registered yet), which is why the call site moved.
	 *
	 * @returns a one-token outcome the attach-time chain reports in its own line
	 *   (评审 round-2 🔵 #3): "no legacy namespace" (nothing registered for it, and
	 *   nothing refused either — the store's pre-attach state), "legacy namespace
	 *   refused (register failed)" (the provider answered but rejected the
	 *   register, so the two states below are no longer conflated — 评审 round-3
	 *   🔵 #5), "legacy read failed", "no legacy data", "migrated", "kept (current
	 *   namespace in use)" or "failed". Every branch either leaves a line of its
	 *   own or is named by the chain line, so no outcome of this function is
	 *   invisible any more — the read failure in particular used to return with
	 *   no log at all.
	 */
	async function migrateLegacyPolicy() {
		if (legacyScope === null) {
			return legacyRefused ? "legacy namespace refused (register failed)" : "no legacy namespace";
		}
		let legacy;
		try {
			legacy = normalizePolicy(legacyScope.get());
		} catch (error) {
			// best-effort ≠ silent (评审 round-2 🔵 #3): the namespace exists but
			// cannot be read, so the pre-rename trust data is NOT migrated — the
			// one branch of this function that used to swallow that silently.
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: legacy namespace "${LEGACY_POLICY_NAMESPACE}" could not be read (${describeError(error)}) — 旧命名空间的信任数据本次未迁移`);
			return "legacy read failed";
		}
		const legacyHasData = legacy.pairs.length > 0 || legacy.trustedSenders.length > 0
			|| legacy.blockedSenders.length > 0 || legacy.rememberTargets.length > 0
			|| legacy.receiveMode !== DEFAULT_POLICY.receiveMode;
		if (!legacyHasData) return "no legacy data";
		// The migration moves TRUST data (the pre-rename namespace's whole
		// vocabulary: receiveMode + the four lists + pairs), so the guard and the
		// write are both scoped to exactly those fields. The guard used to be a
		// five-field "is the current namespace at defaults" test and the write used
		// to be a wholesale `structuredClone(DEFAULT_POLICY)` — together a real
		// defect: a namespace holding a roster / a watchdog / a pending-create
		// intent still passed the guard, and the migration's payload (which carries
		// no `teams` at all) then wiped the roster a §10.2 ② batch had just written.
		const current = get();
		const trustInUse = current.pairs.length > 0 || current.trustedSenders.length > 0
			|| current.blockedSenders.length > 0 || current.rememberTargets.length > 0
			|| current.receiveMode !== DEFAULT_POLICY.receiveMode;
		if (trustInUse) {
			ctx.logger?.info?.(`${PLUGIN_LABEL}: legacy policy namespace "${LEGACY_POLICY_NAMESPACE}" still holds data; kept untouched (current namespace already in use)`);
			return "kept (current namespace in use)";
		}
		try {
			await update({
				receiveMode: legacy.receiveMode,
				trustedSenders: [...legacy.trustedSenders],
				blockedSenders: [...legacy.blockedSenders],
				rememberTargets: [...legacy.rememberTargets],
				pairs: [...legacy.pairs],
			});
			await legacyScope.update({
				receiveMode: DEFAULT_POLICY.receiveMode,
				trustedSenders: [],
				blockedSenders: [],
				rememberTargets: [],
				pairs: [],
			});
			ctx.logger?.info?.(`${PLUGIN_LABEL}: migrated policy from legacy namespace "${LEGACY_POLICY_NAMESPACE}" (${legacy.pairs.length} pairs, ${legacy.trustedSenders.length} trusted senders)`);
			return "migrated";
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: legacy policy migration failed (legacy data left in place): ${describeError(error)}`);
			return "failed";
		}
	}

	/**
	 * The fiber that owned the settings scopes is gone, so the scopes are dead:
	 * the store goes back to "unattached" instead of quietly serving a dead one
	 * (评审 round-2 🟡 #1). The owner is either the provider's injection fiber (the
	 * provider went away) or this plugin's own fiber (unload / reload), so the
	 * line names the release without claiming which of the two happened. `get()` /
	 * `update()` then take the §9.1.3 ③ lazy-retry path again, which re-attaches as
	 * soon as the provider comes back — and until then the memory engine answers,
	 * which is this store's documented unattached state rather than a stale scope
	 * pretending to be live.
	 *
	 * Without this, a late `ctx.inject(["settings"], …)` attach outlives its
	 * provider: `scope` stays non-null while dead, so every `update()` throws
	 * into the caller's「写入设置失败」path while every `get()` silently answers
	 * from process memory — a read/write divergence that no retry can repair,
	 * because the retry is gated on `scope === null`.
	 *
	 * Idempotent: repeated calls (both scopes already released) are no-ops.
	 *
	 * 评审 round-3 🟡 #1: releasing the scopes also RE-OPENS the one-shot warn gate.
	 * The gate counts unattached windows, and this call ends one — so if the
	 * provider comes back and this time REFUSES `register`, that window must say
	 * so. Pre-fix the gate was process-lifetime: the second window's refusal was
	 * swallowed, and the only trace was the release line's "memory-only until it
	 * attaches again" — which cannot distinguish 「仍在等」 from 「被拒绝」, the very
	 * distinction this gate exists for (silent refusal is the original ③ defect).
	 * Retries inside one window still share the gate, so this stays one warn per
	 * window rather than a warn storm.
	 *
	 * 代码评审第 3 轮 🟡#2: the window CRITERIA re-open together with that gate —
	 * `unattachedWindowKind` / `enteredUnattachedWindow` used to be written only
	 * once, at activation, so a real detach window folded with whatever wording
	 * activation had left behind (for a fast-path attach that is the 「服务从一开始
	 * 就在场」 claim — a false statement about a window that followed a detach) and
	 * re-used activation's `!enteredUnattachedWindow` for the archive decision
	 * (archiving this process's own file-backend mirror). Both are written HERE
	 * now, so the criteria share the gate's lifecycle exactly.
	 */
	function detach() {
		if (scope === null && legacyScope === null) return;
		scope = null;
		legacyScope = null;
		attachWarned = false;
		// 代码评审第 3 轮 🟡#2：判据与 warn 门**同生命周期** —— detach 结束一个已挂载段、开启
		// 一段新的未挂载窗口，所以「未挂载窗口」的判据也在这里写一次（此前只在 activation 写
		// 一次）。kind 落 `"detached"`：provider 回来后折叠那一行的措辞如实说「provider 被
		// detach 后又回来」，不说成「服务从一开始就在场」（快路径措辞）也不说成「服务还没来」
		// （启动窗口）；`enteredUnattachedWindow` 同步置真 ⇒ 这段窗口里本进程自己写进文件后端
		// 的镜像**不再多归档一份**（与 🔵#4 的 `refused` 窗口同一条裁定：只有真·快路径才存档）。
		unattachedWindowKind = "detached";
		enteredUnattachedWindow = true;
		ctx.logger?.info?.(`${PLUGIN_LABEL}: settings scope released with its owner fiber — 回落落点：${unattachedTail()} on namespace "${POLICY_NAMESPACE}" until it attaches again`);
	}

	/**
	 * Attach the store to one settings service (§9.1.3). Idempotent: the first
	 * successful attach wins and everything after it is a no-op. A provider that
	 * refuses `register` leaves the store memory-only — with a warn, never
	 * silently, and never more than once per unattached window: the lazy retries
	 * reach this catch again on every `get()` / `update()` while `scope` stays
	 * null, so the line goes through the SAME one-shot gate as the
	 * "not active at activation" line below (U11: an unattached window carries
	 * exactly one warn, whichever arrival path got there first). `detach()` ends
	 * a window and re-opens that gate (评审 round-3 🟡 #1) — the next window's
	 * refusal is its own line, not silence behind the previous window's.
	 *
	 * `owner` is the context the service was read from, and the scopes are bound
	 * to ITS fiber's lifetime (评审 round-2 🟡 #1) — the same ownership rule the
	 * export route already uses for `webServer`
	 * (`target.effect(() => webServer.register(…))`, see registerReadRoutes):
	 * the effect belongs to the context that found the service, so a late
	 * injection's attach is undone together with its own injection fiber. For
	 * the fast path that owner is this plugin's own fiber (see attachFrom).
	 */
	function attach(settings, owner) {
		if (scope !== null) return;
		try {
			scope = settings.register(POLICY_NAMESPACE, PolicyConfig, { base: structuredClone(DEFAULT_POLICY) });
		} catch (error) {
			if (!attachWarned) {
				attachWarned = true;
				// The only arrival that reaches this catch: `attachFrom` calls here
				// only after a service with a `register()` was handed over, so the
				// provider answered and refused this register. The other arrival —
				// "no service yet / no register()" — is named by the activation
				// branch, which writes through this same gate. (评审 round-3 🔵 #2:
				// a third, `unavailableDetail`, parameter used to sit here claiming
				// the activation branch routed its wording through it; no caller
				// ever passed it — that route never existed.)
				ctx.logger?.warn?.(`${PLUGIN_LABEL}: settings register failed (${describeError(error)}) — 回落落点：${unattachedTail()}`);
			}
			return;
		}
		try {
			legacyScope = settings.register(LEGACY_POLICY_NAMESPACE, PolicyConfig, { base: structuredClone(DEFAULT_POLICY) });
			legacyRefused = false;
		} catch (error) {
			// best-effort ≠ silent (评审 #4): the legacy namespace is optional, but
			// an unavailable one means the pre-rename trust data is NOT migrated —
			// that has to be visible rather than swallowed. The flag carries the
			// same fact into the chain line, where "refused" and "never had that
			// namespace" used to read identically (评审 round-3 🔵 #5).
			legacyScope = null;
			legacyRefused = true;
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: legacy namespace "${LEGACY_POLICY_NAMESPACE}" unavailable (${describeError(error)}) — 旧命名空间的信任数据不会自动迁移`);
		}
		ctx.logger?.info?.(`${PLUGIN_LABEL}: policy store attached to settings namespace "${POLICY_NAMESPACE}"`);
		// 评审 round-2 🟡 #1: the two scopes above live exactly as long as the
		// fiber of the context they were taken from. Registering that binding is
		// what makes a provider restart observable to this store at all; if the
		// owner refuses the effect, the scope is now unbindable and that must be
		// said out loud (a provider that goes away would leave a dead scope
		// attached — the very failure this binding exists to prevent).
		try {
			owner.effect(() => () => detach(), "team-link: policy store settings scope");
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: could not bind the settings scope to its owner fiber's lifetime (${describeError(error)}) — this store would keep serving the scope after its owner is gone`);
		}
		// §9.1.3 调用点迁移：the one-time legacy migration is driven from here, not
		// from apply — before the attach there is no current namespace to compare
		// the legacy one against (at apply time the call was a guaranteed no-op).
		// The order matters: any write made during the memory-only window is folded
		// in FIRST, so the migration's "current namespace already in use?" test
		// sees the final state and cannot overwrite newer data with legacy data.
		//
		// 评审 round-2 🔵 #3: this chain used to be fire-and-forget with a silent
		// `catch`, so its outcome was unobservable — a reader could not tell
		// "migrated" from "skipped" from "failed" without instrumenting the store.
		// One info line now names both steps' outcomes; the steps' own lines (and
		// the early catch inside migrateLegacyPolicy) stay where they are.
		// 分歧审计修复轮 🟡#5: before the chain starts, the **fast path** (the service was
		// already there at activation) asks the one question that decides the fold —
		// "does the file backend hold a state the service does not?". It has to be
		// asked HERE, not at startup: `loadPolicyFile` used to run only when
		// `scope === null`, so on a fast-path boot the file was never read and teams
		// written while the service was absent stayed invisible — the exact shape of
		// §1's symptom, and U6's second assertion had frozen it as a spec. Both paths
		// now fold through this ONE chain under the ONE §3.3 rule.
		loadFileIfServiceAtDefaults();
				void adoptMemoryWindow()
			.then(async (memoryOutcome) => ({ memoryOutcome, legacyOutcome: await migrateLegacyPolicy() }))
			// 落点行是**链已落定**的信号：先回写文件（§3.1 档 4），再打这一行。看到这行的读者
			// 就可以直接去看文件了 —— 那一行早于回写出现时，判据会读到一个还没跟上的过期快照。
			.then(async ({ memoryOutcome, legacyOutcome }) => {
				// 🔵#3：盖不盖新 `foldedAt` 由「本次链上有没有折叠/裁决落定」决定，而不是「有没有
				// attach 过」—— 未挂载期间无写入的那一种启动照旧回写合并结果，但保留上一次的戳；
				// 判据取**确已落定**的两个结局（代码评审第 3 轮 🟡#1 收紧：`fold failed` 不得算）。
				// 代码评审第 3 轮 🟡#1：`fold failed` 的那一支**连回写都不做** —— 那个结局意味着窗口
				// 数据没并入服务、仍只活在文件里（`adoptMemoryWindow` 的 catch 留痕也是这么说的）；
				// 此刻把服务视图写回文件，等于把内存与文件**两边同时**的窗口数据抹掉（内存这边在
				// `syncFileFromService` 里被服务视图整份替换），且不留归档。宁可保守不回写：文件保留
				// 未并入的那一份，与 catch 留痕逐字一致；也不用「先归档再覆盖」那条路 —— 归档救不回
				// 内存那份镜像。窗口数据仍在 ⇒ 下一次 attach 的折叠会重试（`memoryDirty` 保持置位）。
				if (memoryOutcome === MEMORY_WINDOW_OUTCOME_FOLD_FAILED) {
					ctx.logger?.info?.(`${PLUGIN_LABEL}: post-attach policy chain skipped the file write-back — memory window: fold failed（窗口内的写入仍在文件里、本次未并入：链尾不回写、文件不被覆盖，下一次 attach 会重试折叠）`);
				} else {
					await syncFileFromService({ foldHappened: memoryWindowOutcomeLanded(memoryOutcome) });
				}
				ctx.logger?.info?.(`${PLUGIN_LABEL}: post-attach policy chain finished — memory window: ${memoryOutcome}; legacy migration: ${legacyOutcome}`);
				// FR-7: the view is final only HERE on the fast path — the fold's write (and
				// therefore the watchdogs it brings in) lands inside this chain, long after
				// `apply` armed the timers. Re-arm against the merged view.
				// （FR-16 起 `notifyAttached()` 自身不再判 scope ⇒ 这一处显式判，语义逐字不变。）
				if (scope !== null) notifyAttached();
			})
			.catch((error) => {
				ctx.logger?.warn?.(`${PLUGIN_LABEL}: post-attach policy chain failed (${describeError(error)}) — 内存窗口并入 / 旧命名空间迁移的完成情况未知，状态仍以设置命名空间为准`);
				// FR-7: even a chain that broke mid-way may have changed the readable view (a
				// fold that wrote before failing), so the re-arm rides this branch too.
				if (scope !== null) notifyAttached();
				// 代码评审第 2 轮 🟡#1：链在 `memoryOutcome` 产出**之前**断掉，这一支读不到
				// 折叠结果，所以它**没有资格**判定「本次链上确有折叠/裁决落定」。旧实现无参调用
				// ⇒ {@link syncFileFromService} 的 `options.foldHappened !== false` 对 `undefined`
				// 取真 ⇒ 照样盖新 `foldedAt`，把「最近一次 attach 时刻」冒充「折叠落定时刻」
				// （与 §3.4 的盖戳门字面相反）。显式传 `false`：与成功那一支共用同一个判据，
				// **宁可漏盖不冒盖** —— 保留上一次真正落定的戳，逐字节不动。
				return syncFileFromService({ foldHappened: false });
			});
	}

	/**
	 * §9.1.3 数据一致性（防御性冗余）: the memory engine can only be written inside
	 * the startup window — before the attach, and in practice before any agent
	 * exists to call a tool. Should it nevertheless happen, the write must not be
	 * silently dropped when settings finally arrives: fold it in under the same
	 * rule as the legacy migration (only while the settings namespace is still at
	 * defaults — settings stays the source of truth), and say so in one line.
	 *
	 * @returns a one-token outcome for the chain's completion line (评审 round-2
	 *   🔵 #3): "none (no writes while unattached)", "not folded (settings
	 *   namespace already in use)", "folded into settings" or "fold failed".
	 *   代码评审修复轮 🔵#3 / 第 3 轮 🟡#1: the `foldedAt` gate is the set of LANDED
	 *   outcomes ({@link memoryWindowOutcomeLanded} — "folded into settings" and
	 *   "not folded"); "none" has no fold to stamp, and "fold failed" must neither
	 *   stamp NOR trigger the chain tail's write-back at all (the window data is
	 *   still only in the file — writing the service view back would erase it on
	 *   both sides; see the chain in {@link attach}).
	 *   The window flag is cleared on the two outcomes that CONSUME it (评审
	 *   round-3 🔵 #3) — otherwise a later, brand-new provider would fold the same
	 *   memory state a second time and log the "理论不可达" warn again, i.e. the flag
	 *   would outlive the window it belongs to. `fold failed` keeps it set: those
	 *   writes are genuinely still memory-only, so the next attach must retry.
	 *
	 * 差异审计修复轮 🟡-1: this patch and {@link policyIsAtDefaults} are the two
	 * halves of ONE licence — the predicate says "the namespace holds nothing", the
	 * patch is the wholesale write it licenses — so a key added to
	 * {@link DEFAULT_POLICY} has to appear in BOTH. The ② round added
	 * `pendingCreates`, and only the predicate followed: `get()` read a view whose
	 * `pendingCreates` was the in-memory row while this patch wrote the other seven
	 * keys, so a §10.2.6 intent written in the startup window was dropped at the
	 * fold and the next boot's sweep had nothing to report (the durable orphan
	 * record that is the whole point of the key). Every key of `DEFAULT_POLICY` is
	 * named below, deliberately in the same order, so the next one cannot be
	 * half-added.
	 */
	async function adoptMemoryWindow() {
		if (!memoryDirty) return MEMORY_WINDOW_OUTCOME_NONE;
		const current = get();
		// §3.1 档 4：未挂载期间的那份状态如今由**文件**支撑（原来只在进程内存里），所以
		// 「文件里有没有东西」就是「两边都非默认」那一支的另一半。
		const fileHasState = fileUsable && !policyIsAtDefaults(memory);
		if (!policyIsAtDefaults(current)) {
			memoryDirty = false;
			// §3.3 裁决：服务非默认 ⇒ 服务胜。文件侧**先原样归档**并留痕一行（**不**静默合并）；
			// 随后由链尾的 syncFileFromService 把服务的视图写回文件并盖 foldedAt。
			await archiveSupersededFile(fileHasState);
			return MEMORY_WINDOW_OUTCOME_NOT_FOLDED;
		}
		try {
			// §3.3 归档：**快路径**折叠**落地之后**，把文件那一侧（**并入前**的原字节）原样存档 ——
			// 链尾的 syncFileFromService 随后会把文件改写成「合并结果」，没有这份存档，那一份原字节
			// 就再也找不回来（分歧审计修复轮 🟡#5 / U10）。
			//
			// **位置（代码评审第 4 轮 🔵②③ / C3-a · C3-b）**：在 `update()` **成功之后**。旧位置在
			// `update()` 之前，于是「快路径 ＋ fold failed」会先留下一句承诺「随后文件会被改写成合并
			// 结果并盖 foldedAt」，而那一支的链尾**根本不回写**（见 attach 里的门）—— 承诺与实况相反，
			// 还多一份冗余归档。现在：没有折叠落定就没有归档、也没有那句承诺；文件逐字节不变，被并入的
			// 那一份原字节仍留在落点里（无数据丢失）。归档本身永不抛（自己的 try/catch），所以挪位不会
			// 把一次已经落定的折叠误报成 `fold failed`。
			//
			// 只在这一支存档：晚挂路径（档 2/3/4）里文件后端写的就是**本进程**未挂载窗口的镜像，
			// 与 `memory` 同一份内容，存一份副本既不增可核性又给同目录多出一次写 —— 那一支按裁定
			// 保持一字不动。（代码评审修复轮 🔵#4：`refused` 窗口里写的也是本进程自己的镜像，同样不存档；
			//  第 3 轮 🟡#2 再补 `detached` —— `detach()` 现在同步置判据，所以 `!enteredUnattachedWindow`
			//  覆盖三种未挂载窗口：late / refused / detached。）
			const archiveMergedFile = fileHasState && !enteredUnattachedWindow;
			await update({
				receiveMode: memory.receiveMode,
				trustedSenders: [...memory.trustedSenders],
				blockedSenders: [...memory.blockedSenders],
				// 批 I（FR-I1）: 整份命名空间写入必须带上新键 —— 漏了它，未挂载窗口里点过的
				// 屏蔽（配对屏蔽）会在折叠这一步静默丢掉（与 ② 轮 pendingCreates 那次同族的坑）。
				blocks: [...memory.blocks],
				rememberTargets: [...memory.rememberTargets],
				pairs: [...memory.pairs],
				watchdogs: [...memory.watchdogs],
				teams: [...memory.teams],
				pendingCreates: [...memory.pendingCreates],
				// FR-9: 整份命名空间写入必须带上新键（漏了就会把用户关掉的开关悄悄翻回缺省）。
				sections: { ...memory.sections },
				// ★ 批 34 / FR-7: 同一条理由 —— 漏了它，一次晚挂折叠就会把用户**打开**的写门
				// 悄悄翻回默认 OFF（`policyIsAtDefaults` 同批进了这一个键，两半必须一起到场）。
				antiDrift: { ...memory.antiDrift },
			});
			if (archiveMergedFile) await archiveSupersededFile(true, "folded");
			memoryDirty = false;
			// 折叠**留痕**。两支的措辞必须各自说真话（分歧审计修复轮 🟡#5）：只有真的在未挂载窗口里
			// 写过，才叫「startup window」；快路径那一支折叠的是**上一次进程**留在文件后端里的
			// 状态，本进程从未有过未挂载窗口 —— 说成窗口就是编了一个没发生过的现场。
			// 措辞四支（代码评审修复轮 🔵#4 + 第 3 轮 🟡#2）：`refused` 与「startup window」是两件事 ——
			// 前者是「服务在场但拒绝注册」，窗口真实存在且由文件后端支撑；后者是「服务那会儿还没来」
			// （理论不可达）。`detached`（第 3 轮 🟡#2 新增）是第三件：provider 掉线触发 `detach()`、
			// 后来又回来 —— 判据在 `detach()` 里同步写，不再沿用 activation 那一次的措辞。把任意两件
			// 混成同一句就是替现场编故事。
			const foldTail = policyPath.ok ? policyPath.file : "（无落点）";
			ctx.logger?.warn?.(unattachedWindowKind === "refused"
				? `${PLUGIN_LABEL}: policy store attached after the active provider REFUSED the register（服务在 activation 就已存在，但拒绝注册 "${POLICY_NAMESPACE}"：这段未挂载窗口的写入由文件后端 ${foldTail} 支撑）— 这些写入已并入设置命名空间 "${POLICY_NAMESPACE}"（不静默丢弃；不是「服务从一开始就在场」，也不是「服务还没来」）`
				: unattachedWindowKind === "detached"
					? `${PLUGIN_LABEL}: policy store re-attached after its settings owner was detached（provider 被 detach 后又回来：detach 后这段未挂载窗口的写入由文件后端 ${foldTail} 支撑）— 这些写入已并入设置命名空间 "${POLICY_NAMESPACE}"（不静默丢弃；不是「服务从一开始就在场」的快路径折叠，也不是「服务还没来」的启动窗口 —— 是 provider 掉线又回来的那段）`
					: enteredUnattachedWindow
						? `${PLUGIN_LABEL}: policy store attached with writes from the unattached startup window（该窗口由文件后端 ${foldTail} 支撑）— 这些写入已并入设置命名空间 "${POLICY_NAMESPACE}"（该窗口理论不可达，本次确实发生了）`
						: `${PLUGIN_LABEL}: policy store attached on the fast path with a state from the file backend ${foldTail}（设置服务在场且为默认）— 文件里那一份已并入设置命名空间 "${POLICY_NAMESPACE}"（§3.1 档 4 的快路径折叠；不静默丢弃）`);
			// 文件重写挂在链尾（syncFileFromService），不在这里 —— 这里只负责并入。
			return MEMORY_WINDOW_OUTCOME_FOLDED;
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: failed to fold the unattached startup window into settings (${describeError(error)}) — 窗口内的写入仍在落点 ${policyPath.ok ? policyPath.file : "（进程内存）"} 里，本次未能并入设置命名空间`);
			return MEMORY_WINDOW_OUTCOME_FOLD_FAILED;
		}
	}

	/**
	 * §3.1 档 4 的**快路径**分支（分歧审计修复轮 🟡#5）：attach 成功、命名空间已经可读之后，
	 * 问一次「服务那一侧是不是还停在默认」。
	 *
	 * - **为默认** ⇒ 文件后端里的那份是**唯一**一份真值（纯设置部署里上一次跑没有服务、
	 *   团队只写进了文件），必须读进来交给下面那条链折叠并入 —— 这就是档 4，只是省掉了
	 *   「等服务晚挂」这一段；
	 * - **非默认** ⇒ 按 §3.3 服务胜，文件那一侧**连读都不读**（U6 第二条断言：零字节变动）。
	 *
	 * 不抛：读命名空间失败时什么都不做（保守 —— 读不出服务当前值就没有资格裁胜负），链照跑。
	 */
	function loadFileIfServiceAtDefaults() {
		
		if (fileLoadAttempted || scope === null) return;
		let current;
		try {
			current = normalizePolicy(scope.get());
		} catch {
			return;
		}
		if (!policyIsAtDefaults(current)) return;
		loadPolicyFile();
	}

	/**
	 * Attach from whatever one context can hand over right now. Never throws.
	 *
	 * Returns WHY it did or did not attach (评审 round-2 🔵 #2), so the activation
	 * branch below can name the reason instead of reading `ctx.get("settings")` a
	 * second time — the two reads could straddle the moment the provider appears,
	 * and the warn would then describe a state that is no longer true.
	 *
	 * - `"attached"` — a live scope, either already present or just registered;
	 * - `"refused"` — the provider answered but `register` threw; {@link attach}
	 *   already left its line through the shared one-shot gate, so the activation
	 *   branch must not run (and must not relabel that line);
	 * - `"no-register"` — there IS a settings service here without `register()`;
	 * - `"not-active"` — nothing to take from this context (yet).
	 *
	 * `target` is also passed on as the scope's owner, so whichever context
	 * produced the service owns its lifetime too (评审 round-2 🟡 #1): the fast
	 * path binds the scope to this plugin's own fiber, the late injection to its
	 * own injection fiber.
	 */
	/**
	 * FR-7（批 1）: handlers that must re-read the store every time it (re)attaches.
	 *
	 * The plugin's patrol timers are armed from `policy.get()`, so they are only as good as
	 * the view that was readable at that moment. Two arrivals make the view readable LATER
	 * than activation: a settings provider that comes up after the plugin (`late`), and the
	 * fast-path fold, whose write lands after `apply` has already returned. Both leave every
	 * persisted registration without a timer for the whole process — the "重启后是哑的"
	 * symptom. Fire points are therefore the two moments the view can become final:
	 * (1) the post-attach chain's tail, where the fast-path fold has landed; (2) that chain's
	 * catch, for a chain that broke after having already written something.
	 *
	 * ★ 撤回记录（task-5 A · t-4 复验 🟡2）: `attach()` 里曾有一处「scope 一挂上就开火」的
	 * 第三处调用 —— 它是**未申报的范围扩张**，且实测**不承重**（只删链尾那处，「U12 重挂（快路径
	 * 折叠）」才红；只删链尾之外那处，全库照旧全绿）。原因：快路径那一刻 handler 列表还是空的，
	 * 它补不上那个窗口，却让同一个 attach 事件把 handler 触发两次。已按「措辞与代码不一致时默认
	 * 改措辞、未申报的扩张一律撤回」删掉；本 JSDoc 也随之改成与实现一致的**两处**。
	 *
	 * `onAttach` also fires once immediately when the store is ALREADY attached, so a
	 * handler registered after the fast-path attach does not have to care about ordering
	 * (the rearm it drives is idempotent).
	 */
	const attachHandlers = [];
	/**
	 * ★ FR-16（批 7）: **数据到位后的「补一次」通知**的两个进程内标志。
	 *
	 * 真机读数（2026-10-10）：`onAttach` 的立即回调发生在 `apply()` 期间，而那一刻视图**还是空的**
	 * ⇒ 该回调**零写入、无 warn**（证据：policy.json mtime 停在启动前 15:35）。
	 * **★ 16:33:57 更正（设计档 §13 v1.10）**：探针注册的 tick 恰在启动 + `intervalMinutes`（10min）
	 * 到达 ⇒ **FR-7 的 rearm 其实生效了**（定时器挂得上 —— `start()` 那一轮挂的）；零写入的只剩 FR-10
	 * 的 `ensureTeamAutoWatchdogs`。它是「**没被到达**」还是「**每队 skip/throw**」，在本部署**没有
	 * 观测面**（`ctx.logger?.warn?.` 是空操作）⇒ **因果待证**，先写死结论就是编故事 —— FR-17 补的那
	 * 一行（`chainReportLine`）正是为此。
	 * 文件后端部署（本部署：`no-register` ⇒ `scope === null`）更彻底：现有的三处 `notifyAttached()`
	 * 调用点一处都不跑，attach 处理器在那类部署里**从来没被叫过**（推断：真机「重启后该重挂/该补挂」
	 * 两条证据都等不到，与这条一致）。
	 *
	 * 语义：`dataReady` ＝ 曾经拿到过**非空数据**；`notifiedWithData` ＝ 已经用那份数据通知过
	 * （**恰好一次**）。两个标志分开是必需的 —— `notifyAttached()` 会同步调回 `get()`（rearm 里就
	 * 有一次），先置 `dataReady` 才挡得住重入递归；而「有数据但还没有 handler」不算一次通知机会。
	 */
	let dataReady = false;
	let notifiedWithData = false;
	function onAttach(handler) {
		if (typeof handler !== "function") return;
		attachHandlers.push(handler);
		if (scope !== null) notifyAttached();
	}

	/**
	 * Run every attach handler; one failing handler must never break the others.
	 *
	 * ★ FR-16: 这里**不再**自带 `scope === null` 的早退 —— 「视图可读」不再等价于「设置服务挂上了」
	 * （文件后端部署里可读的是文件那一份，而那正是重挂/补挂需要一个通知的场合）。原先依赖那个早退
	 * 的三处调用点各自显式判 scope，行为逐字不变；新增的「数据到位」那一条走的是不带早退的路。
	 */
	function notifyAttached() {
		for (const handler of attachHandlers) {
			try {
				handler();
			} catch (error) {
				ctx.logger?.warn?.(`${PLUGIN_LABEL}: policy attach handler failed (${describeError(error)})`);
			}
		}
	}

	function attachFrom(target) {
		if (scope !== null) return "attached";
		const settings = target.get?.("settings");
		if (settings === undefined) return "not-active";
		// §3.5：服务在场却注册不出本命名空间，是「⚠ 仅进程内存」的一个独立原因
		// （`no-register`），与「服务根本还没来」分开。
		serviceObserved = true;
		if (typeof settings.register !== "function") return "no-register";
		attach(settings, target);
		return scope !== null ? "attached" : "refused";
	}

	// ① Fast path — a provider that is already active (or a synchronous stub).
	//    That context is this plugin's own fiber: the store, its tools, the
	//    watchdog timers and this effect all die together with it, and a plugin
	//    restart re-runs `apply` into a fresh store — so a scope taken here can
	//    never be reachable while dead. It is still bound (attach does that for
	//    every owner) so teardown is explicit and both sites of §9.1.3 behave
	//    alike; what it does NOT need is a retry of its own.
	const activationReason = attachFrom(ctx);
	// 「未挂载过」这一条只影响折叠那一行的措辞（{@link adoptMemoryWindow}），两种路径读的是
	// 同一个判据：文件后端有没有一份服务没有的状态。
	// 代码评审修复轮 🔵#4：判据从「非 attached 且非 refused」收成「非 attached」——
	// 「服务在场但**拒注册**、后来才挂上」是一个**真实的未挂载窗口**（那段时间里的写入同样
	// 由文件后端支撑、同样要折叠并入），把它排除出去会让留痕说成「服务从一开始就在场」
	// （快路径措辞）并顺手给这个进程自己写的镜像多归档一份。
	unattachedWindowKind = activationReason === "attached" ? "none"
		: activationReason === "refused" ? "refused"
		: "late";
	enteredUnattachedWindow = unattachedWindowKind !== "none";
	// 激活支的条件**不动**（`refused` 的那一行由 `attach` 自己按同一道门写过了，见其 JSDoc）：
	// 变的是「算不算未挂载过」这个判据，不是「activation 这一支要不要跑」。
	if (activationReason !== "attached" && activationReason !== "refused") {
		// ② Not there yet: leave exactly one line (§5.3 红线: 不得静默失效) and
		// register the optional ordered injection. `ctx.inject` is not a hard
		// dependency: when the service never appears, this plugin still loads and
		// runs on the memory engine. The line is written through the same gate the
		// register failure uses, so the two arrival paths share one warn. The
		// reason comes from the read above — not from a second `ctx.get`.
		if (!attachWarned) {
			attachWarned = true;
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: settings not active at activation (${activationReason === "no-register" ? "no register()" : "not yet active"}) — 未挂载期间的落点：${unattachedTail()}`);
		}
		if (typeof ctx.inject === "function") {
			ctx.inject(["settings"], (child) => { attachFrom(child); });
		} else {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: ctx.inject unavailable — 依赖首次工具调用时的惰性重试兜底`);
		}
	}
	// 策略持久化自持化 §3.1 档 2/3：**只有**在没有 scope 的时候才碰文件 —— 挂上服务
	// 的部署里不读、不建、不写（U6/R3）。
	// （快路径那一侧的文件读发生在 {@link attach} 里的 `loadFileIfServiceAtDefaults()`，
	// 且**只有服务为默认**时才发生：服务在场且非默认 ⇒ 裁决是服务胜，文件连读都不读。
	// `loadPolicyFile` 自带「每个 store 只读一次」的门，所以晚挂路径走到这里仍然是那次读。）
	if (scope === null) loadPolicyFile();
	// ③ 惰性兜底 lives in get()/update() above: retry silently, attach on
	//    success (the attach line plus the chain's outcome line), and never
	//    repeat the activation warn.

	// §3.5: `placementLine` 是 roster/status 两个读面的首行来源（R2 红线的落地面）。
	return { get, peek, update, migrateLegacyPolicy, placement: policyPlacement, placementLine: policyPlacementLine, teamsSourceLabel: policyTeamsSourceLabel, onAttach };
}


// ---------------------------------------------------------------------------
// cross-session watchdog (§3.2)
// ---------------------------------------------------------------------------

/** Inclusive bounded-number reading for one registration argument. */
function readBoundedNumber(value, name, min, max, options = {}) {
	if (value === undefined || value === null) return { value: undefined };
	if (typeof value !== "number" || !Number.isFinite(value)) return { error: `${name} 必须是数字。` };
	if (options.integer === true && !Number.isInteger(value)) return { error: `${name} 必须是整数。` };
	if (value < min) return { error: `${name} 不能小于 ${min}。` };
	if (max !== undefined && value > max) return { error: `${name} 不能大于 ${max}。` };
	return { value };
}

/** TTL reading (§3.2.4: `<= 24h`, default 12h; strictly positive). */
function readTtlHours(value) {
	if (value === undefined || value === null) return { value: WATCHDOG_DEFAULT_TTL_HOURS };
	if (typeof value !== "number" || !Number.isFinite(value)) return { error: "ttlHours 必须是数字。" };
	if (value <= 0) return { error: "ttlHours 必须大于 0。" };
	if (value > WATCHDOG_MAX_TTL_HOURS) return { error: `ttlHours 不能大于 ${WATCHDOG_MAX_TTL_HOURS}（防失控）。` };
	return { value };
}

/**
 * Build one validated registration (§3.2.2 schema, §3.2.4 anti-runaway rules).
 * Pure — it neither reads nor writes the store — so every bound is directly
 * testable and a rejected request can never leave a half-written entry behind.
 *
 * @returns `{ value: entry }` or `{ error: reason }`.
 */
function buildWatchdogRegistration(request) {
	const caller = request.caller;
	const now = request.now;
	const targets = [...new Set((Array.isArray(request.targets) ? request.targets : [])
		.filter((target) => typeof target === "string" && target.trim() !== "")
		.map((target) => target.trim()))];
	if (targets.length === 0) return { error: "register 需要 targets（至少一个被盯会话 id）。" };
	if (targets.includes(caller)) return { error: "register 拒绝自指注册：targets 不能包含观察者自身会话（自指 = 变相的自 tick 定时器，§3.2.4）。" };
	const silent = readBoundedNumber(request.silentMinutes, "silentMinutes", WATCHDOG_MIN_SILENT_MINUTES, undefined, { integer: true });
	if (silent.error !== undefined) return { error: silent.error };
	const interval = readBoundedNumber(request.intervalMinutes, "intervalMinutes", WATCHDOG_MIN_INTERVAL_MINUTES, undefined, { integer: true });
	if (interval.error !== undefined) return { error: interval.error };
	const ttl = readTtlHours(request.ttlHours);
	if (ttl.error !== undefined) return { error: ttl.error };
	return {
		value: {
			id: `${WATCHDOG_ID_PREFIX}${randomUUID()}`,
			team: null,
			watcherSession: caller,
			targets,
			silentMinutes: silent.value ?? WATCHDOG_DEFAULT_SILENT_MINUTES,
			intervalMinutes: interval.value ?? WATCHDOG_DEFAULT_INTERVAL_MINUTES,
			expiresAt: now + ttl.value * 3600000,
			createdAt: now,
			// 工具面注册的永远是手工那一档（auto 由 FR-3a 的建队路径铸，见 planAutoWatchdog）。
			origin: WATCHDOG_ORIGIN_MANUAL,
		},
	};
}


/**
 * FR-3a（批 1）: the ONE auto registration of a team's workbench (consult #26 §4.3 A).
 *
 * Pure — it decides WHAT the row should look like (create or refresh) and the caller does
 * the single `policy.update({ watchdogs })` write (AGENTS.md §七「一个时刻只写一处」).
 * Idempotent by `(watcherSession, team)`: rebuilding a team refreshes its one registration
 * instead of piling up a new row per batch, and the TTL rides along (consult #26 D7「顺延」).
 *
 * @returns `{ entry, created }` or `{ error }` — an empty target set is a refusal, not an
 *   empty registration: a watchdog with nothing to watch would only burn a patrol timer.
 */
function planAutoWatchdog(watchdogs, request) {
	const watcher = typeof request?.watcherSession === "string" ? request.watcherSession : "";
	const team = typeof request?.team === "string" ? request.team : "";
	const now = typeof request?.now === "number" ? request.now : Date.now();
	const targets = [...new Set((Array.isArray(request?.targets) ? request.targets : [])
		.filter((target) => typeof target === "string" && target.trim() !== "")
		.map((target) => target.trim()))].filter((target) => target !== watcher);
	if (watcher === "") return { error: "没有观察者会话（自动注册挂在调用会话的协调者身份上）" };
	if (targets.length === 0) return { error: "该队除观察者外没有可盯的成员（agent-team 档的成员不在会话注册表里，本插件盯不到）" };
	const existing = (Array.isArray(watchdogs) ? watchdogs : [])
		.find((entry) => entry.origin === WATCHDOG_ORIGIN_AUTO && entry.watcherSession === watcher && entry.team === team);
	if (existing !== undefined) {
		// ★ 批 G · FR-R2（评审第 2 轮 🔴#1）：refresh 分支的**字段形状**与 FR-R1 的续期逐字同形 ——
		//   ① **保留原 `createdAt`**（续期/刷新是**租约顺延**，不是重建；旧实现把它重写成 `now`，
		//      而设计档 §7 又说 `createdAt`「续期不改」⇒ 同一机制两种说法，本次统一到「不改」）；
		//   ② **写 `renewedAt: now`**（FR-R4 的留痕字段，与 FR-R1 同一处写）；
		//   ③ `targets` 按调用方传来的名册现算覆写（`:2568` 已算好，且已剔掉观察者自己）。
		//   这条分支**今天有活调用方**：`armTeamWatchdog`（`:2716-2718` 的 `planned.created ? … : …`），
		//   而 `/team_session` 建队路径**没有 `existing` 守卫** ⇒ 同队 + 同协调者会话重建时会命中它。
		return { created: false, entry: { ...existing, targets, createdAt: existing.createdAt, renewedAt: now, expiresAt: now + WATCHDOG_DEFAULT_TTL_HOURS * 3600000 } };
	}
	return {
		created: true,
		entry: {
			id: `${WATCHDOG_ID_PREFIX}${randomUUID()}`,
			team,
			watcherSession: watcher,
			targets,
			silentMinutes: WATCHDOG_DEFAULT_SILENT_MINUTES,
			intervalMinutes: WATCHDOG_AUTO_INTERVAL_MINUTES,
			expiresAt: now + WATCHDOG_DEFAULT_TTL_HOURS * 3600000,
			createdAt: now,
			origin: WATCHDOG_ORIGIN_AUTO,
		},
	};
}

/**
 * ★ 批 G（`docs/2026-10-12-watchdog-renewal-design.md` §6 · 评审第 2 轮 🟡#6）：**自动工作台注册的
 * 名册门** —— 「这一个观察者的这一条 auto 行，此刻是否仍有名册依据」。**唯一真值处**。
 *
 * 为什么要抽成一个函数：这条谓词有**两个**调用方 ——
 *   ① `ensureTeamAutoWatchdogs`（`/team_session` 建队 / attach 后置链 / `team_link_watch action=arm-team`
 *      / 批 G · FR-R3 的运行期复活），它决定**要不要铸一行**；
 *   ② `renewAutoRowIfStillValid`（批 G · FR-R1 的巡逻内续期），它决定**要不要续一行**。
 * 两处各写一份就是本批要修的那种「两条路径语义分叉」的形状：单边漂移之后，「ensure 会为它重铸」
 * 与「巡逻会为它续命」不再等价，被否决的裸甲（见 auto 就续）就会从缝里长回来。
 *
 * 三门（设计档 §4 D2 的承重墙，逐条对应「该合法失效」的场景）：
 *   · **团队在场** —— 团队已被删（含用户在设置 UI 直改 teams，那条路不经过任何工具代码）
 *     ⇒ 没有名册依据；
 *   · **watcher 仍是现任协调者** —— 换届 / 换人 / 退役（`current` 为空）⇒ 旧行让位；
 *   · **非空 targets** —— 除观察者外还有人可盯；队缩到无人时，一行看门狗只是白烧一个巡逻定时器。
 * **刻意不看的**：观察者会话的进程内活性（设计档 §4 D3，2:1 裁定）—— 工作台摘要是**团队资产**，
 * 不是那个会话窗口的属性；看重启后谁都不 live，而 FR-10 自己就是「现任不 live 也照写」。
 *
 * @param {Array} teams - 名册（`policy.get().teams`；`ensure` 亦可传 `options.teams` 的等价集合）。
 * @param {string} teamName - 注册行上的队名。
 * @param {string} watcherSession - 注册行上的观察者会话 id。
 * @returns `{ members: string[] }`（名册序，**已剔掉观察者自己**）或 `{ error: string }`（拒绝原因）。
 */
function autoWatchdogRosterGate(teams, teamName, watcherSession) {
	const team = (Array.isArray(teams) ? teams : []).find((entry) => entry?.name === teamName);
	if (team === undefined) return { error: `团队「${teamName}」不在名册里（团队已解散 ⇒ 该行没有名册依据）` };
	const current = roleOf(team, COORDINATOR_ROLE)?.current ?? null;
	if (typeof current !== "string" || current === "") return { error: `团队「${teamName}」的协调者空缺（没有观察者可挂）` };
	if (current !== watcherSession) return { error: `观察者 ${watcherSession} 已不是团队「${teamName}」的现任协调者（现为 ${current}）⇒ 该行已让位` };
	// 与 FR-10 建队那一刻**同一个**目标集（名册序、剔除观察者自己）：续期与重铸据此同源。
	const members = [...new Set((team.roles ?? []).map((role) => role?.current).filter((id) => typeof id === "string" && id !== ""))]
		.filter((id) => id !== watcherSession);
	if (members.length === 0) return { error: `团队「${teamName}」除观察者外没有可盯成员（一行盯不到任何人的看门狗只是白烧一个巡逻定时器）` };
	return { members };
}

/**
 * ★ FR-10（批 5）: attach 后置链按队**补挂** auto 工作台注册。
 *
 * 为什么：`armTeamWatchdog` 此前只有 `/team_session` 建队一个调用点 ⇒ 建队当日之前就存在的
 * **老团队**从来没有 auto 注册（真机 2026-10-10：两个 10-08 的老队，policy.watchdogs 里只有一条
 * 人工取证的 manual），现任协调者于是「不推就不动弹」。
 *
 * 语义（设计档 §5 FR-10）：幂等键 = (origin="auto", watcher=该队现任协调者, team)；**缺失才写**
 * （单写落点 policy.update）；现任不 live 也照写；除 watcher 外无成员 ⇒ 按 planAutoWatchdog 既有
 * 语义跳过并留一行读数；**fail-open** —— 任何失败只留一行 warn，绝不拖 attach 链。
 */
async function ensureTeamAutoWatchdogs(ctx, policy, watchdog, options = {}) {
	const teams = Array.isArray(options.teams) ? options.teams : policy.get().teams;
	// ★ 批 G（FR-R2 与 FR-R3 共用的一条缝）：`now` 可注入 —— `patrol({ now })` 的既有缝隙一路传到这里，
	//   于是「冷启动那一次 ensure」与「巡逻尾部那次 ensure」的续期时刻都由**注入时钟**决定，
	//   判据不必靠墙钟真等（设计档 §8 夹具纪律）。省略时逐字回到旧行为（`Date.now()`）。
	const now = typeof options.now === "number" ? options.now : Date.now();
	const reports = [];
	for (const team of teams) {
		const watcher = roleOf(team, COORDINATOR_ROLE)?.current ?? null;
		if (typeof watcher !== "string" || watcher === "") {
			reports.push({ team: team.name, state: "skip", reason: "现任协调者空缺（没有观察者可以挂）" });
			continue;
		}
		// ★ 批 G · FR-R2（设计档 §5 FR-R2 · §8 U5）：`existing` 查找加**「未过期」谓词**。
		//   旧实现不查 `expiresAt` ⇒ 冷启动（关机 > 12h）后过期行被当「在场」报 `present` 然后 `continue`，
		//   随即被清扫链逐条收掉 ⇒ 工作台**当场死透**（比 12h 慢死更快，正是用户原始投诉的时序）。
		//   加上谓词之后：过期行**不当在场** ⇒ 落到下面 `armTeamWatchdog` ⇒ 命中 `planAutoWatchdog`
		//   的 refresh 分支 ⇒ 同 `id` 原地刷新（保 `createdAt` / 写 `renewedAt` / 重算 `targets`）并挂表。
		//   ⚠ 这是**有意行为**（设计档 §3 非目标 2 的措辞更正）：经 ensure 的 `arm-team` 会**重建**过期行。
		const existing = policy.get().watchdogs
			.find((entry) => entry.origin === WATCHDOG_ORIGIN_AUTO && entry.watcherSession === watcher && entry.team === team.name && entry.expiresAt > now);
		if (existing !== undefined) {
			reports.push({ team: team.name, state: "present", id: existing.id });
			continue;
		}
		// ★ 批 G（评审第 2 轮 🟡#6 的落地面）：名册门走**共享 helper** —— `ensure` 与巡逻续期读同一份谓词。
		const gate = autoWatchdogRosterGate(teams, team.name, watcher);
		if (gate.error !== undefined) {
			reports.push({ team: team.name, state: "skip", reason: gate.error });
			continue;
		}
		try {
			const armed = await armTeamWatchdog(ctx, policy, watchdog, { watcherSession: watcher, team: team.name, targets: gate.members, now });
			if (armed.error !== undefined) {
				// ★ task-31（批 7 微修）: 除 plan 那一档外，这里是**失败**，不是 skip。`armTeamWatchdog` 的两段式报错把两种
				// 失败分得很清楚（「写入失败（…）——本次没有落盘」/「已写入但定时器未挂上（…）」），
				// 原先把它们一律记成 skip ⇒ FR-17 那一行（使命＝「失败必须可见」）在这个方向上瞎掉：
				// 一次真的写入失败会伪装成「这队本来就没得挂」。skip 从此只留两种**非失败**语义：
				// 现任空缺（:2474 那一支）与「除观察者外没有可盯成员」（planAutoWatchdog 的既有拒绝）。
				// plan 档（没有观察者 / 没有可盯成员）＝非失败语义 ⇒ skip；write / schedule 档 ⇒ failed。
				reports.push({ team: team.name, state: armed.stage === "plan" ? "skip" : "failed", reason: armed.error });
				continue;
			}
			reports.push({ team: team.name, state: armed.created ? "created" : "present", id: armed.entry?.id });
		} catch (error) {
			reports.push({ team: team.name, state: "failed", reason: describeError(error) });
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: attach 按队补挂 ${team.name} 的工作台注册失败（${describeError(error)}）—— attach 链不受影响（fail-open）`);
		}
	}
	return reports;
}

/**
 * ★ FR-17（批 7）: attach 后置链的**读面**（进程内存，零写盘）。
 *
 * 为什么要有它：真机两次排查都栽在同一处 —— 后置链里的部分失败在本部署**完全不可见**
 * （`ctx.logger?.warn?.` 是空操作、卡片也不报），于是「补挂没发生」只能靠日志取证，而这里没有
 * 日志出口。这一份记录由 `policy.onAttach` 的处理器**唯一写入**，由 `team_link_status` 读一行出来。
 *
 * 三档各自如实报（缺一档就说明「不可得」，绝不留空）：
 *   · rearm 挂上 N 个定时器（+ 已过期未挂的条数 / 只挂了清扫定时器那一档）；
 *   · 段同步（计划变化 M 项 = added + disposed，另给在场的段数）；
 *   · 按队补挂四态计数 + **首因**（skip / failed 各取第一条的 reason）。
 *
 * 记法：`{ at, rearm, sections, ensure, pending }`。`ensure.pending === true` ＝ 那一轮的补挂还在飞；
 * `ensure.threw === true` ＝ 整轮抛错（四态计数不可得，照样报 failed，不静默）。
 */
function summarizeAutoWatchdogs(reports) {
	const summary = { created: 0, present: 0, skip: 0, failed: 0, firstSkipReason: null, firstFailedReason: null, pending: false, threw: false, error: null };
	for (const report of Array.isArray(reports) ? reports : []) {
		if (report?.state === "created") summary.created += 1;
		else if (report?.state === "present") summary.present += 1;
		else if (report?.state === "failed") {
			summary.failed += 1;
			if (summary.firstFailedReason === null) summary.firstFailedReason = report.reason ?? "（未说原因）";
		} else {
			summary.skip += 1;
			if (summary.firstSkipReason === null) summary.firstSkipReason = report?.reason ?? "（未说原因）";
		}
	}
	return summary;
}

/** 该行的**唯一**渲染处（U27 直接读这个真函数，不抄一份进测试）。`report === null` ⇒ 尚无记录。 */
function chainReportLine(report) {
	if (report === null || report === undefined || report.at === null || report.at === undefined) {
		return "attach 后置链：尚无记录（本进程还没跑过 attach 后置链）—— 这一行不是「没问题」，是「没读数」";
	}
	const parts = [];
	const rearm = report.rearm ?? null;
	parts.push(rearm === null
		? "rearm 未记录"
		: "rearm 挂上 " + String(rearm.armed) + " 个定时器"
			+ (rearm.expired > 0 ? "（另有 " + String(rearm.expired) + " 条已过期、未挂）" : "")
			+ (rearm.sweepTimer === true ? "（无活注册 ⇒ 只挂了一个清扫定时器）" : ""));
	const sync = report.sections ?? null;
	parts.push(sync === null
		? "段同步未记录"
		: "段同步（计划变化 " + String(sync.added + sync.disposed) + " 项；在场 " + String(sync.registered) + " 个段）");
	const ensure = report.ensure ?? null;
	if (ensure === null || ensure.pending === true) parts.push("按队补挂：尚未落定（这一轮还在飞）");
	else if (ensure.threw === true) parts.push("按队补挂：failed（整轮抛错：" + (ensure.error ?? "（未说原因）") + "；四态计数不可得）");
	else parts.push("按队补挂：created " + String(ensure.created) + " · present " + String(ensure.present)
		+ " · skip " + String(ensure.skip) + (ensure.firstSkipReason === null || ensure.firstSkipReason === undefined ? "" : "（首因 " + ensure.firstSkipReason + "）")
		+ " · failed " + String(ensure.failed) + (ensure.firstFailedReason === null || ensure.firstFailedReason === undefined ? "" : "（首因 " + ensure.firstFailedReason + "）"));
	return "attach 后置链（最近一次 " + readStamp(report.at) + "）：" + parts.join(" · ");
}

/**
 * FR-3a: arm (or refresh) the team workbench after a successful `/team_session` build.
 *
 * Failure is ISOLATED on purpose (consult #26 §4.3「失败隔离」): a workbench registration
 * that cannot be written must never fail the build that just succeeded — the caller renders
 * one honest line instead. The write goes through the one 落点 (`policy.update`), never a
 * second one; the timer is armed through the same controller the watch tool uses.
 */
async function armTeamWatchdog(ctx, policy, watchdog, request) {
	const current = policy.get().watchdogs;
	const planned = planAutoWatchdog(current, request);
	// ★ task-31（批 7 微修）: 失败**分段署名** —— `stage` 让调用方能分辨「计划这一档拒了」
	// （没有观察者 / 除观察者外没有可盯成员 ⇒ 非失败语义）与「写入/挂定时器失败」（⇒ failed）。
	// 文案仍沿用既有两段式（「写入失败（…）——本次没有落盘」/「已写入但定时器未挂上（…）」）。
	if (planned.error !== undefined) return { ...planned, stage: "plan" };
	// ★ t-14 B（评审 #3 🟡）：两段**分开**报 —— 写入和挂定时器是两件事，旧实现把后者也报成
	// 「写入失败」，于是读者以为没落盘，实际那条 auto 注册已经在 settings 里（报文撒谎）。
	try {
		await policy.update({
			watchdogs: planned.created
				? [...current, planned.entry]
				: current.map((entry) => (entry.id === planned.entry.id ? planned.entry : entry)),
		});
	} catch (error) {
		return { error: `写入失败（${describeError(error)}）——本次没有落盘`, stage: "write" };
	}
	try {
		watchdog.schedule(planned.entry);
		return { ...planned, armed: true };
	} catch (error) {
		// 已落盘、本进程没挂上：如实说，并**当场试着 rearm 一次**（幂等；它会从 policy 里读到
		// 这条刚写进去的注册）。仍然失败就留一行 warn —— 下一次 attach / 名册写入的 rearm 再补。
		const detail = describeError(error);
		let repaired = false;
		try {
			watchdog.rearm();
			repaired = timerArmed(watchdog, planned.entry.id);
		} catch {
			repaired = false;
		}
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: 工作台注册 ${planned.entry.id} 已写入，但定时器未挂上（${detail}）${repaired ? "；已由 rearm 补上" : "—— 下一次挂载（attach / 名册写入）会补上"}`);
		// ★ t-15 🔵1（批 3 顺手项）：armed=true 时 error 内层**只带 detail** —— 外层报文的
		// 「首挂失败（…）」与「已由 rearm 补上」两个事实已经把它说全了，内层再套一遍
		// 「已写入但定时器未挂上（…）」就成了两层嵌套（实测文本：首挂失败（已写入但定时器未挂上（…）））。
		return { entry: planned.entry, created: planned.created, armed: repaired, error: repaired ? detail : `已写入但定时器未挂上（${detail}）`, stage: "schedule" };
	}
}

/** 该注册此刻是否真的挂着定时器（armTeamWatchdog 的失败分支用它判断 rearm 是否补上了）。 */
function timerArmed(watchdog, id) {
	try {
		return watchdog?.timers?.has?.(id) === true;
	} catch {
		return false;
	}
}

/**
 * The watchdog tick message (§3.2.3). Every body is a plugin constant: the
 * only interpolated values are status fields (target id, reading time, silence
 * duration), so no registration argument can smuggle a payload into the
 * watcher's next request. The source is the audited three-member relay shape
 * (V10) — the watchdog has no session identity of its own, so the watcher is
 * recorded as the sender of the message it receives (§3.2.3 note (a)).
 *
 * ★ 批 D（FR-2 §6.7 · 分歧修复轮 v1.1）：多一个 `origin` 入参。审计 D1 用代码核实
 *   **auto 观察者也会收到告警 tick** —— `patrolOne` 里 `if (suppressed && !workbench) return;`
 *   之后那一支对 auto 与手工**一视同仁**（`planAutoWatchdog` 又把 targets 设成「除观察者外的队员」）
 *   ⇒ 原正文那句「不再需要盯人可用 team_link_watch clear」会**教 auto 观察者去做一件它做不到、
 *   且会坑掉全队工作台的事**（`clear` 拿不走 auto，见 §6.5）。故两档分文案：
 *     · auto（`origin === WATCHDOG_ORIGIN_AUTO`）：**不得**出现「可用 … clear」这类建议，
 *       并点明该注册来自**全队工作台**（它由团队决定去留，观察者无权清）；
 *     · 手工（含 `origin` 缺省 / 未归一化的历史行）：那句建议**逐字原样保留** ——
 *       对它是准确的，且 host-half 的逐字断言钉着它（批 D · U5 ③）。
 *   反走私不变式不变：`origin` 只作**闭集判据**（`=== "auto"` 的二值选择），不是被插值的载荷 ——
 *   手改 settings 行塞不进任意文本。goal-disarmed 那一支两档**逐字相同**（它本来就不含 clear 建议）。
 */
function tickMessage(watcherSession, target, signal, now, origin = undefined) {
	let text;
	if (signal.verdict === "goal-disarmed") {
		text = `[watchdog] 目标 ${target} 的 goal 处于 active-but-disarmed（可能原因：max-tokens 回合结束 / DSH 重启 / agent error，读数 ${readStamp(now)}）。该状态不会自愈：请向用户说明并请求授权 resume；用户同意后调用 update_goal(action:"resume") 恢复续跑。复核用 team_link_list_sessions。`;
	} else if (origin === WATCHDOG_ORIGIN_AUTO) {
		text = `[watchdog] 目标 ${target} 失联征兆：verdict=${signal.verdict} 静默 ${fmtSilence(signal.silenceMs)}（读数 ${readStamp(now)}）。请用 team_link_list_sessions 复核后处置；本条来自**全队工作台**的自动注册（team_link_watch clear 清不掉它，去留由团队决定）；误报可忽略，不必为此做任何清理。`;
	} else {
		text = `[watchdog] 目标 ${target} 失联征兆：verdict=${signal.verdict} 静默 ${fmtSilence(signal.silenceMs)}（读数 ${readStamp(now)}）。请用 team_link_list_sessions 复核后处置；误报或不再需要盯人可用 team_link_watch clear。`;
	}
	return {
		id: `${WATCHDOG_TICK_ID_PREFIX}${randomUUID()}`,
		role: "user",
		source: { kind: "agent-message", form: "relay", senderSessionId: watcherSession },
		// ★ 批 E（FR-4）：本出口是**模型可见文本**（tick 进观察者下一个请求）⇒ 过消毒。
		content: [{ type: "text", text: wellFormed(text) }],
	};
}


/**
 * FR-3b（批 1）:「在飞任务」的读法 —— 一条 **active 的 goal** 就是该会话自己的在飞工作。
 * armed 的 active goal 会自续跑（{@link verdictOf} 判它 ok：「别催」），所以它不算「空闲待派」；
 * 无 goal / paused / blocked / complete 都算「手上没有在飞任务」。
 *
 * 口径声明（批 1，如实登记）：设计档 §5.1 写的是「E2 ＝ 空闲 且 无在飞任务」，consult #26 §4.3
 * 把「在飞任务」进一步定义成 tasks.md 里该成员未收口的行。**本批不读黑板** —— §7.2/§7.3 没有把
 * 台账列进这条链的读数面，NF-5 的读成本上界也不给它开口子；这里取的是同一个判据里**只读宿主
 * 已有读数的那一半**（goal），台账那一半留给后续批次。
 */
function watchdogHasNoInflightWork(signal) {
	const goal = signal.goal;
	return goal === null || goal === undefined || goal.phase !== "active";
}

/**
 * FR-3b: one patrol's target rows grouped into the four workbench groups of §5.1.
 * Pure — the rows are `{ target, signal, previous }` and nothing is read here.
 *
 * The priority decides the ONE group a target lands in: a body that lists the same id under
 * both 「需处置」 and 「空闲待派」 would contradict itself, and the alarm channel would then
 * say something different from the digest about the same target in the same minute.
 *
 * 1. `alarm` — the §3.2.3 tickable verdicts, first on purpose (the digest never softens a
 *    verdict the alarm channel is speaking about);
 * 2. `running` — 谁在跑（别催）;
 * 3. `justFinished` (E1) — running on the previous patrol, not running now;
 * 4. `idleAwait` (E2) — idle with nothing in flight.
 * An idle agent driving its own armed goal falls in no group at all.
 */
function classifyWatchdogTargets(rows) {
	const groups = { running: [], justFinished: [], idleAwait: [], alarm: [] };
	for (const row of rows) {
		if (TICKABLE_VERDICTS.has(row.signal.verdict)) groups.alarm.push(row);
		else if (row.signal.agent === "running") groups.running.push(row);
		else if (row.previous === "running") groups.justFinished.push(row);
		else if (row.signal.agent === "idle" && watchdogHasNoInflightWork(row.signal)) groups.idleAwait.push(row);
	}
	return groups;
}

/** 「有可行动内容」＝ 空闲待派 ∪ 刚转空闲 ∪ 需处置 非空（§4.6）。「谁在跑」单独不构成打扰理由。 */
function watchdogDigestActionable(groups) {
	return groups.idleAwait.length + groups.justFinished.length + groups.alarm.length > 0;
}

/** 状态指纹：四组各自的 id 序列。指纹没变 ⇒ 这条摘要要说的话还是同一句（U9「无事不许打扰」）。 */
function watchdogDigestSignature(groups) {
	return ["running", "justFinished", "idleAwait", "alarm"]
		.map((key) => `${key}:${groups[key].map((row) => row.target).join(",")}`)
		.join("|");
}

/** 静默读数：读不出时间戳时说「?」，不说 0（与 {@link livenessLine} 同一口径）。 */
function digestSilenceOf(signal) {
	return signal.lastAssistantAt === null && signal.lastInboundAt === null ? "静默 ?" : `静默 ${fmtSilence(signal.silenceMs)}`;
}

/**
 * FR-3b: the digest body (§4.4). Every segment is a plugin constant; the only interpolated
 * values are status fields (team name, target ids, verdicts, silence durations, read stamp)
 * — the same anti-smuggling invariant {@link tickMessage} carries, for the same reason: no
 * registration argument can smuggle a payload into the watcher's next request. A hand-edited
 * settings row goes through {@link noticeField}, which is the module's one sanitiser for
 * "a value that enters a body".
 */
function renderWatchdogDigest(entry, groups, now, footers = []) {
	const team = entry.team === null || entry.team === undefined || entry.team === "" ? "（未命名团队）" : noticeField(entry.team);
	const lines = [`${WATCHDOG_DIGEST_LABEL} 团队 ${team} 工作台（读数 ${readStamp(now)}）`];
	const push = (label, group, field) => {
		if (group.length === 0) return;
		lines.push(`${label}：${group.map((row) => field(row)).join("、")}`);
	};
	push("运行中", groups.running, (row) => noticeField(row.target));
	push("空闲待派", groups.idleAwait, (row) => `${noticeField(row.target)}（${digestSilenceOf(row.signal)}）`);
	push("刚转空闲", groups.justFinished, (row) => noticeField(row.target));
	push("需处置", groups.alarm, (row) => `${noticeField(row.target)}（verdict=${noticeField(row.signal.verdict)} ${digestSilenceOf(row.signal)}）`);
	for (const footer of footers) if (typeof footer === "string" && footer !== "") lines.push(footer);
	// ★ 批 D（FR-2 §6.6）**同批改**：脚注的收件人正是协调者，而它原来建议的那件事（`clear` 无 id
	// = 清掉自己的**全部**注册）在 FR-2 之后已经不成立，且当初真把全队资产清掉过两轮 ⇒ 文案必须
	// 与 `clear` 的真实作用域**逐字一致**：只建议清**手工**那一档，并明说本条摘要来自全队工作台的
	// 自动注册（拿不走、也不需要维护）。仍恰一行（行数预算不变，U-WB7 的行数判据原样）。
	// ★ 批 J · FR-J3（设计档 §5 FR-J3 · §8 U5 · §10-2）：脚注**尾部再加一句事实源指路**（与宪章
	//   第 3 条同句）—— 宪章是会话期内恒定的段（压缩后可能淡出），脚注每次摘要都到 ⇒ 两处覆盖两种
	//   时机（§4 D5）。**加在同一行内**：四组正文一行不动、行数预算因此也一行不增（U7 逐字钉）。
	lines.push(`（同一注册两条摘要至少隔 ${WATCHDOG_DIGEST_DEBOUNCE_MS / 60000}min，只在有可行动内容时投；`
		+ `想停掉**你自己手工注册**的盯人可 team_link_watch clear —— 它的注册属于你个人。`
		+ `本条摘要来自**全队工作台**的自动注册，不会被 clear 清掉，也不需要你维护。`
		+ `要看某位成员在干什么 ⇒ 读那个团队的黑板 \`tasks.md\`（\`team_link_team_read\`），**不要读它的会话历史**。）`);
	// ★ 批 E（FR-4）：同 tickMessage —— 本出口是模型可见文本，过消毒（`noticeField` 只收口换行 /
	// 控制字符 / ASCII 竖线，管不到那个框定 token 的包裹结构）。
	const digestText = lines.join("\n");
	return wellFormed(digestText);
}

/**
 * ★ 批 J · FR-J1：**「有活没派」告警档的正文**（设计档 §5 FR-J1 · §6 · 需求档 NF-J3）。
 *
 * 与 {@link renderWatchdogDigest} 同一约束，另加两条本档专属的口径：
 *  · **陈述事实，不指控**（设计档 §4 D1 的措辞裁定）：说「**没有成员在被派活**」这个可观测事实，
 *    不说「你没派活」；本档的触发条件（空闲非空 ∧ 无人在跑）**包含**「团队确实没活干」这一超集，
 *    误报由去抖 + 限量 + 不指控的措辞一起兜住。
 *  · **事实源指路**：想看某位成员在干什么 ⇒ 读那个团队的**黑板 `tasks.md`**（`team_link_team_read`），
 *    **不要读它的会话历史** —— 读别人的会话会把对方的窗口装进你自己的窗口（本档存在的理由之一）。
 *
 * 正文 = 插件常量 + 只插值状态字段（团队名 / 目标 id / 静默时长 / 读数时刻），字段过
 * {@link noticeField}、整段过 {@link wellFormed}（反走私不变式）。
 */
function renderIdleAlert(entry, groups, now) {
	const team = entry.team === null || entry.team === undefined || entry.team === "" ? "（未命名团队）" : noticeField(entry.team);
	const idle = groups.idleAwait.map((row) => `${noticeField(row.target)}（${digestSilenceOf(row.signal)}）`).join("、");
	const lines = [
		`${WATCHDOG_IDLE_ALERT_LABEL} 团队 ${team}：有活没派（读数 ${readStamp(now)}）`,
		`没有成员在被派活（无人运行）：${idle}`,
		"（本档只把事实放到你面前，**不替你派工**。要看某位成员在干什么 ⇒ 读那个团队的黑板 `tasks.md`"
			+ "（`team_link_team_read`），**不要读它的会话历史** —— 那会把它的窗口装进你自己的窗口。）",
	];
	return wellFormed(lines.join("\n"));
}

/**
 * ★ 批 J · FR-J2（设计档 §6「新增符号」· §10-7）：压力**档位** —— 每 10% 一档。
 *
 * 档粒度**写死**（不随阈值走）：告警的粒度是「跨过了一个十个百分点」，跨档振荡（59 ↔ 61）
 * 因此不会重复打扰 —— 这与「阈值具名」是两件事：阈值决定**什么时候开始说**，档位决定
 * **说几次**。前置：`percent` 是有限数（调用方已过类型门）。
 */
function bucketOf(percent) {
	return Math.floor(percent / 10);
}

/**
 * ★ 批 J · FR-J2：**协调者自身上下文压力告警的正文**（设计档 §5 FR-J2 · §6 · 需求档 US-J2/NF-J3）。
 *
 * 与 {@link renderWatchdogDigest} 同一约束（正文 = 插件常量 + 只插值状态字段，过
 * {@link wellFormed}），另加本档专属的一条口径：**点名后果** —— 需求档 US-J2 要的不是又一个
 * 百分比，而是「再读别人的历史会把自己读爆」这句话本身（根因 2 的现象就是「协调者为了看队员
 * 在不在干活去读队员的会话，把对方窗口装进自己的窗口」）。
 *
 * 只插值**读数**（百分比 / 压力 / 窗口 / 读数时刻），**不插值任何外部字符串** —— 本档的输入
 * 是宿主投影里的数字，不是注册参数，所以它比摘要那一族还少一类走私面。
 * 前置：`reading` 是 {@link readSessionUsage} 的返回值且 `percent` 是有限数（调用方已过门）。
 * 后置：恒返回字符串（缺读数时说「未知」，绝不编数）。
 */
function renderPressureAlert(reading, now) {
	const percent = typeof reading?.percent === "number" && Number.isFinite(reading.percent) ? reading.percent.toFixed(1) + "%" : "未知";
	const lines = [
		`${WATCHDOG_PRESSURE_ALERT_LABEL} 你自己的上下文压力 ${percent}（压力 ${formatTokenCount(reading?.pressureTokens)} / 窗口 ${formatTokenCount(reading?.window)}，阈值 ${LIAISON_PRESSURE_WARN_PERCENT}%，读数 ${readStamp(now)}）`,
		"后果点名：再读别人的会话历史会把你自己的窗口读满 —— 读别人的会话会把对方的历史装进你自己的窗口，而"
			+ "「某位成员在干什么」不必从它的历史里读。",
	];
	return wellFormed(lines.join("\n"));
}

/** Best-effort session surface read; an unreadable or cold log yields `undefined`. */
async function readSessionSurface(ctx, sessionId) {
	try {
		return await ctx.sessionQuery.readSurface(sessionId);
	} catch {
		return undefined;
	}
}


// ---------------------------------------------------------------------------
// FR-1/FR-2（批 2）: agent 作用域的角色/资源段
// 归属：docs/2026-10-09-team-autonomy-design.md §5（FR-1/FR-2）· §6（机制伪代码
// registerRoleSection / renderRoleAndResources / renderResourceLine）· §7.2/§7.4 ·
// §8（U1–U6）· §9（边界与失败方向）。
//
// ★ 批 C（提示缓存保真，2026-10-10）改了**落点与拆分**，其余语义逐字不动：
//   归属：docs/2026-10-10-prompt-cache-design.md §5（FR-1…FR-4）· §6（§6.1–§6.4 机制伪代码）·
//   §7.2（进程内状态：disposers 改数组 + 两个独立 warn 门 + RESOURCE_CONTEXT_NAME/ORDER）·
//   §8（U1–U11）· §9（边界）。诊断证据：.investigations/prompt-cache-hit-rate-2026-10-10/结论.md。
//   起因：资源行**每次装配现算**（压力/累计/轮次每步都变），留在系统提示段里 ⇒ 提示前缀逐回合变化
//   ⇒ provider 前缀缓存从变化点起全断（glm-5.3 实测命中 0.5%–8.7%，去掉该行 96%–99%）。
//   修法：段只产**会话期内恒定**的文本（renderRoleText），资源行改挂宿主的**动态运行时上下文**
//   通道（renderResourceContext → sp.context(...)，落点是尾部追加的 user 消息，不是提示前缀）。
//
// ★ 批 D（注册生命周期与自动提示，2026-10-11）在本段**追加三件事**（原有语义、落点、开关一字未动）：
//   归属：docs/2026-10-10-registration-lifecycle-design.md §4.3（回合门）· §5（FR-1…FR-3）·
//   §6（§6.1–§6.6 机制伪代码）· §7.2（wantedIds / 自愈一次性门 / 门控缓存）· §8（U1–U9）· §9（边界）。
//   ① **自愈可达**（FR-1）：`wantedIds` + `needsSync` + `apply()` 里那条独立的 `agent/pre-step`
//      监听器 —— 重启后打开团队会话即自动补挂段与上下文，无需人肉命令（修复 D-1，见 §2.1）。
//   ② **回合门**（FR-3）：`renderResourceContext` 按 `sessionStats.turns` 门控 —— 同一回合内返回
//      上一条字符串（进程内缓存，随 `disposeOne` 释放），回合号前进才现算（用户 2026-10-10 拍板 A）。
//   ③ 渲染体 `renderResourceLine` 多一个可选 `probe`（把这次读到的回合号带出来给门控用）——
//      **探针自身零额外读**（它复用渲染体已经读过的那一次 `sessionStats`），所以批 C 的
//      「只读那三个 key」计数判据在**缓存未命中**那一支原样成立。
//      ★ 范围如实收窄（分歧修复轮 · 审计 D2；与 :3198 的 `probe` 注释、host-half 的 U4 注解、
//      verification-log 的批 D 交付面表**同一口径**）：探针自身零额外读 ⇒ **未命中**（无缓存
//      条目）时投影读恰 3 次（那三个 key）；**命中**（同回合）时由门控读 **1** 次 `sessionStats`
//      （`currentTurnOf`，渲染体整段不跑）；**条目在场但回合已前进**时 ＝ 1 ＋ 3 ＝ **4** 次。
//      所以「不额外多读投影」只对**未命中支的渲染体**成立，**不是全称句**。
//
// ★ 批 R · FR-R1（域拆分·第 4 小单）：上面这段描述的那一族**渲染体与预算读数**（`renderRoleText` /
//   `renderResourceLine` / `renderResourceContext` / `currentTurnOf` / `renderCharterLines` /
//   `renderWorkerDutyLine` / `charterReinforceLine` + `ROLE_SECTION_*` / `RESOURCE_CONTEXT_*` /
//   `CHARTER_MAX_LINES` + 第 ⑧ 段的一族 `BUDGET_*` / `readSessionUsage` / `budgetRowLine` /
//   `rotateCandidateOf` / `budgetVerdictLine` / `budgetSectionLines` / `sectionsSwitches`）已原样搬进
//   **`lib/sections.js`**，本文件按名导入（逐字节等价、对外零变更）。本横幅以下仍属于本文件的只有
//   两样：状态卡段④/⑤/⑧ 的**读窗口径**（`windowWorkspaceFor` / `windowReadingFor` /
//   `loadScopedSessionRecords`）与**段的注册器**（`createSections`）。
// ---------------------------------------------------------------------------

/**
 * ★ 评审裁定 #2（第二轮设计评审，2026-10-09；task-7 转述）：资源行**直接同步读**
 * \`ctx.get("sessionProjections").stateOf(session, …)\`，本批**不实现**设计档 §7.2 里那行
 * \`pulseCache\` —— 评审判定「直读」与「缓存」两者并存且权威未定，裁定＝直读；
 * pulseCache 那一行留待文档修正。因此这里没有任何进程内缓存：每次装配现算（provider 同步）。
 *
 * ★ 宿主读数面（2026-10-09 实读宿主 asar 核对，AGENTS.md §四「换代必复核运行时 API 面」）：
 *   \`sessionProjections.stateOf(session, key)\`，key 与形状逐个核对过 ——
 *   · \`contextPressure\`（stateVersion 5）：\`{ contextWindow?, pressureTokens?, surfaceTokens, sampledSurfaceTokens?, claim? }\`
 *   · \`tokenUsage\`（stateVersion 2）：\`{ totals: { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, last: { turn, step, buckets } | null }\`
 *   · \`sessionStats\`（stateVersion 1）：\`{ turns, steps, llmMs, … }\` ⇒ **turns 在场**（批 2 的先行核实结论；
 *     缺席时按 §9「读数缺席（turns）」降级为「轮次未知」，绝不编数）
 *   · 压缩阈值**不在**投影里（它属 compaction 配置，插件读不到）⇒ 本批如实渲染「未知」，
 *     真正的判读行归 FR-5（批 3）。
 */

/**
 * ★ FR-13（批 5）: 单队卡（或所示团队同工作区）时读窗按**团队 workspace** 取；多队且工作区不同 ⇒ null
 * （退回调用方 cwd）。设计档 §9 的边界行：跨工作区读窗 —— **绝不**把调用方工作区的会话当成该队会话。
 */
function windowWorkspaceFor(shownTeams) {
	if (!Array.isArray(shownTeams) || shownTeams.length === 0) return null;
	const workspaces = [...new Set(shownTeams.map((team) => (typeof team?.workspace === "string" && team.workspace !== "" ? team.workspace : null)))];
	if (workspaces.length !== 1 || workspaces[0] === null) return null;
	return workspaces[0];
}

/**
 * ★ task-28（lead 裁定 ③）: 段④/⑤/⑧ 的**读窗口径**（一处事实一处渲染）。纯函数。
 *
 * 三档，各自如实说（fail-visible —— 绝不静默把调用方工作区当成团队工作区）：
 *   ① 取到唯一的团队 workspace ⇒ 按它取窗；宿主不支持 cwd 子句时补一句降级理由；窗口与该队
 *      workspace 相同时（等价于调用方 cwd）note 为空 —— 那时没有可报的口径差；
 *   ② 所示团队**没有** workspace 记录 ⇒ 回退调用方工作区，并标注回退与原因；
 *   ③ 所示团队的工作区**不止一个**（聚合卡）⇒ 同样回退，原因换成「工作区不止一个」。
 * 名册里一个团队都没有 ⇒ note 为空（那时不存在「该队的窗口」，卡面只是本工作区的团队聚合，
 * 段头句本来就写着「同工作区」）。
 *
 * `teamScoped` 告诉调用方段头该说「该队工作区」还是「同工作区」—— ②③ 两档虽然带了标注，
 * 窗口**是**调用方工作区，段头不许跟着标注一起把它说成该队工作区。
 *
 * @param options.teamWorkspace - 调用方用 {@link windowWorkspaceFor} 算好的团队 workspace（同一判据只算一次）。
 * @param options.unsupported - 宿主是否不支持按工作区取窗（就地过滤那一支）。
 */
function windowReadingFor(shownTeams, callerCwd, options = {}) {
	const teams = Array.isArray(shownTeams) ? shownTeams : [];
	const teamWorkspace = typeof options.teamWorkspace === "string" && options.teamWorkspace !== "" ? options.teamWorkspace : null;
	if (teamWorkspace !== null) {
		const suffix = options.unsupported === true ? "；宿主不支持按工作区取窗 ⇒ 已就地过滤" : "";
		return {
			targetWorkspace: teamWorkspace,
			teamScoped: true,
			note: teamWorkspace === callerCwd ? "" : `【读窗=团队工作区 ${teamWorkspace}${suffix}】`,
		};
	}
	if (teams.length === 0) return { targetWorkspace: callerCwd, teamScoped: false, note: "" };
	// 回退的两条到达路径各自点名原因（读数与本仓既有的「原因码」文风一致：谁挡住的就说谁）。
	const missing = teams.filter((team) => typeof team?.workspace !== "string" || team.workspace === "").length;
	const reason = missing === teams.length
		? (teams.length === 1 ? "该队无 workspace 记录" : "所示团队都没有 workspace 记录")
		: missing > 0
			? "有团队没有 workspace 记录、且工作区不止一个"
			: `所示 ${teams.length} 个团队的工作区不止一个`;
	return { targetWorkspace: callerCwd, teamScoped: false, note: `【读窗=调用方工作区 ${callerCwd}（回退：${reason}）】` };
}

/**
 * 按工作区取会话记录（FR-13）：宿主**支持** `filterSessions` 的 cwd 子句就直接用它；不支持
 * （面缺席 / 抛错 / 返回了别的工作区的行）⇒ 退回调取全部再**就地过滤**，并置 `unsupported`
 * —— 调用方据此在段头如实标注窗口口径（fail-visible，绝不把调用方工作区当成团队工作区）。
 *
 * ★ 2026-10-10 宿主真签名复核（AGENTS.md §四「桩不得只镜像自家调用面」；lead 裁定授权改）：
 * `dsh-session-query/lib/index.js` 的真签名是 `listSessions(signal)`（:95 / :1070，函数体第一句
 * `signal?.throwIfAborted()`）与 `filterSessions(filters, signal)`（:1094），cwd 子句形状
 * `{ kind: "cwd", values: [...] }`（:682-685，取值 string|null）。此前这里写的是
 * `listSessions(workspace)` —— 那是**把工作区当 signal 传**：真宿主上必抛 TypeError，被本函数的
 * catch 吃掉后「优先」那一支**恒不可达**（每张跨工作区卡白烧一次调用，且降级理由说不出口）。
 * 现在改走宿主真有的 cwd 子句；面缺席时退回同一条降级支。
 */
async function loadScopedSessionRecords(ctx, workspace) {
	const query = ctx.sessionQuery;
	if (typeof workspace !== "string" || workspace === "") return { records: await query.listSessions(undefined), unsupported: false };
	if (typeof query.filterSessions !== "function") {
		return { records: await query.listSessions(undefined), unsupported: true };
	}
	let records;
	try {
		records = await query.filterSessions([{ kind: "cwd", values: [workspace] }], undefined);
	} catch (error) {
		return { records: await query.listSessions(undefined), unsupported: true };
	}
	if (!Array.isArray(records)) return { records: await query.listSessions(undefined), unsupported: true };
	// 宿主收下子句却回了别的工作区的行（忽略子句的实现）⇒ 就地过滤 + 如实标注。
	return { records, unsupported: records.some((record) => record.header.cwd !== workspace) };
}

/** FR-4 的共用判据: 该会话此刻是不是这支队伍的现任协调者（四处重钉都读它）。 */
function isIncumbentCoordinator(policyView, teamName, sessionId) {
	if (typeof sessionId !== "string" || sessionId === "") return false;
	const team = (policyView?.teams ?? []).find((entry) => entry.name === teamName);
	if (team === undefined) return false;
	return (roleOf(team, COORDINATOR_ROLE)?.current ?? null) === sessionId;
}

/**
 * FR-4/FR-9 的 digest 脚注（0–2 行）：资源行（resources=true）+ 角色重钉（role=true 且观察者
 * 确实是该队现任协调者）。纯读 —— 资源行直读投影，重钉只读 policy。
 */
function digestFooters(ctx, policy, entry, watcher) {
	const switches = sectionsSwitches(policy.get());
	const footers = [];
	if (switches.resources) {
		const line = renderResourceLine(ctx, watcher);
		if (typeof line === "string" && line !== "") footers.push(line);
	}
	if (switches.role && typeof entry.team === "string" && entry.team !== "" && isIncumbentCoordinator(policy.get(), entry.team, watcher?.id)) {
		footers.push(charterReinforceLine(entry.team));
	}
	return footers;
}

/**
 * FR-1/FR-2 的**注册器与生命周期**（U2–U4；批 C 起两面 —— U5–U7/U9）。归属：设计档
 * §6 的 registerRoleSection（签名与前后置照它）+ §7.2 的进程内 `sections` 表 + §9 的失败方向；
 * 批 C 的落点拆分见 `docs/2026-10-10-prompt-cache-design.md` §6.3/§6.4。
 *
 * 两条注册钩子（设计档 FR-2 行「注册钩子两条路径」）：
 *   ① 名册写入之后（upsert-team / set-role / retire / /team_session 建队 / 换届落定）
 *      —— 由各自的调用点调 `sync()`；
 *   ② **attach 时扫 roster 重建** —— 由 `policy.onAttach`（FR-7 的同一个钩子）触发，
 *      覆盖重启后既有 worker 的段重建。
 *
 * 注册按 `sessionId` 记账（一个会话一条账、**至多两个 disposer**：section 面 + context 面）；
 * 同一个会话同时是两队成员时**协调者版优先**（名册序决定，见 planSections）——这条口径如实登记在
 * 交付报告里。
 *
 * @returns `{ sync, disposeAll, registered, planSections, needsSync, warnSelfHealOnce, turnGate, warnState }`
 *   （后几项供 `__testing` 读；`needsSync`/`warnSelfHealOnce` 是批 D 的自愈面，`turnGate` 是它的回合门缓存）。
 */
function createSections(ctx, policy) {
	/** sessionId -> `{ team, sessionId, role, kind, switches, disposers: fn[] }`（§7.2 的进程内表）。
	 *  ★ 批 C：`disposer` 改**数组**（至多 2 个 —— section 面 + context 面），两处同表管理、
	 *    一起释放（U7：只释放一个 ⇒ 合计 1 ≠ 2 ⇒ 红）。 */
	const registered = new Map();
	/**
	 * ★ 批 D（FR-1 §6.1）: **期望注册集** —— 名册「想要」注册的那些会话 id（进程内，`sync()`
	 * 每次执行末尾就地刷新）。它是自愈判据 {@link needsSync} 的**第一道闸门**：名册不想要的
	 * 会话（绝大多数）在 `wantedIds.has` 这一跳上短路，热路径因此恒为 O(1)、零扫描（U2）。
	 * `sync()` 还没跑过时是空集 ⇒ 判据恒 false、零副作用（§6.1 后置条件）。
	 *
	 * 为什么需要它（D-1 的根因）：`sync()` 只对**活代理**注册，重启时若没有任何会话活着，
	 * attach 扫到的活代理集为空 ⇒ 注册 0 个；此后某个会话被打开（成为活代理）不触发任何 sync
	 * ⇒ 它永远拿不到段与资源行，直到下一次名册写入或下一次 attach（真机读数见设计档 §2.1）。
	 * 判据「名册想要 **且** 还没挂上」正好把这一格补上，且不需要任何新增的宿主面。
	 */
	let wantedIds = new Set();
	/**
	 * ★ 批 D（FR-3 §7.2）: **回合门的进程内缓存** —— `sessionId -> { turn, text }`。
	 * 只用于门控（不是读数缓存：回合号一前进就地覆盖），**随注册生命周期释放** ——
	 * `disposeOne` 同批清（U8：代理消失 ⇒ 注册表与这份缓存一起空，零泄漏）。
	 * 持久化零变更（§7.1：`policy.sections` / `policy.watchdogs` 一个字段都不动）。
	 */
	const turnGate = new Map();
	/** 四个**各自独立**的一次性留痕门（§7.2：整面缺席门 + 段面门 + 上下文面门 + 渲染抛错门；任一
	 *  面缺失都只留该面那一行，绝不牵连另一面）。末一个是 §6.1/§6.2 两个渲染体**共用**的 `onError`。 */
	let unsupportedWarned = false;
	let sectionFaceWarned = false;
	let contextFaceWarned = false;
	let renderWarned = false;
	/** ★ 批 D（FR-1 §7.2）: **自愈**失败的一次性留痕门（第五道门，与上面四道并列）。
	 *  自愈在热路径上跑（每步一次 O(1) 检查），失败只留一行、不刷屏（NFR-3）。 */
	let selfHealWarned = false;

	/** U1（批 2）/ U6①（批 C）: **连 sp 都拿不到** ⇒ 零注册 + **恰好一行** warn（fail-visible，不抛错）。
	 *  两处都缺时合计**至多两行**（段面一行 + 上下文面一行），走的是各自那个门、不是这里。 */
	function warnUnsupported(reason) {
		if (unsupportedWarned) return;
		unsupportedWarned = true;
		ctx.logger?.warn?.(
			PLUGIN_LABEL + ": 角色/资源段未注册（" + reason + "）—— 功能回退到「工具返回重钉」路径："
			+ "team_link_roster action=get、team_link_status 与 /team_session 的完成回报仍会把角色与资源如实叙述出来；"
			+ "本插件不会因为缺这个面而让任何会话的提示装配失败。",
		);
	}

	/** U6②③（批 C）: **section 面**（角色/宪章段）不可用 ⇒ 该面零注册 + 该面恰一行；
	 *  context 面**照常注册**（一处失败不牵连另一面）。 */
	function warnSectionFace(detail) {
		if (sectionFaceWarned) return;
		sectionFaceWarned = true;
		ctx.logger?.warn?.(
			PLUGIN_LABEL + ": 角色/宪章段未注册（宿主没有 agent.ctx.systemPrompt.section 或 getSectionOrder"
			+ (detail === undefined ? "" : "：" + detail) + "）—— 其余功能不受影响：资源行照常挂动态运行时上下文通道，"
			+ "角色文本仍可由 team_link_roster action=get 与 /team_session 的完成回报重钉。",
		);
	}

	/** U6②④（批 C）: **context 面**（资源行）不可用 ⇒ 该面零注册 + 该面恰一行（**新文案**）；
	 *  section 面**照常注册**。资源行退到 digest 脚注 + 状态卡第 ⑧ 段那两处兜底出口。 */
	function warnContextFace(detail) {
		if (contextFaceWarned) return;
		contextFaceWarned = true;
		ctx.logger?.warn?.(
			PLUGIN_LABEL + ": 资源行未挂上动态运行时上下文通道（宿主没有 agent.ctx.systemPrompt.context"
			+ (detail === undefined ? "" : "：" + detail) + "）—— 其余功能不受影响：角色/宪章段照常；"
			+ "资源行仍出现在 team_link_status 第 ⑧ 段与工作台摘要脚注里。",
		);
	}

	/** 渲染体抛错的留痕：一次性门（装配是热路径，不能一抛一行）。
	 *  §6.3：它就是 §6.1/§6.2 两个渲染体的 `onError` 实参 —— **两面共用**这一个门；
	 *  段面与上下文面任何一侧抛错都经它留痕，整个注册生命周期内至多一行。 */
	function warnRender(error) {
		if (renderWarned) return;
		renderWarned = true;
		ctx.logger?.warn?.(PLUGIN_LABEL + ": 角色/资源渲染抛错，已降级为空串（不让装配失败）：" + describeError(error));
	}

	/**
	 * ★ 批 D（FR-1 §6.2）**自愈判据**：两道 O(1) 查表，**绝不做任何扫描**。
	 *
	 * 前置：无。后置：非名册 / 空 id / 已注册 ⇒ `false`；余下 ⇒ `true`。
	 *   · 第一道 `wantedIds.has(sessionId)` —— **所有非名册会话**（绝大多数）在此短路（NFR-2/U2）；
	 *   · 第二道 `!registered.has(sessionId)` —— 已经挂上的会话不再重复 sync（幂等的前提；
	 *     也是 U2「名册且已注册 ⇒ sync 调用次数 0」那一半的依据）。
	 *
	 * ★ 刻意**没有**「失败闩锁」：注册持续失败（例如宿主没有 `systemPrompt` 面）时允许**每步一次**
	 *   幂等重试 —— 加一次性闩锁会让一次瞬时失败之后该会话**永远**不再自愈（U2 的限定，评审 🔵#7）。
	 *   刷屏由 {@link warnSelfHealOnce} 那道一次性门挡住，不靠闩锁。
	 */
	function needsSync(sessionId) {
		return typeof sessionId === "string" && sessionId !== ""
			&& wantedIds.has(sessionId)
			&& !registered.has(sessionId);
	}

	/** ★ 批 D（FR-1 §6.3）**自愈失败的一次性留痕**（U1b：恰一行，且后续步不再刷屏）。
	 *  失败方向是 **fail-open**：这一行只是痕，绝不改变 `next()` 的决定、绝不让回合失败（NFR-3）。 */
	function warnSelfHealOnce(error) {
		if (selfHealWarned) return;
		selfHealWarned = true;
		ctx.logger?.warn?.(
			PLUGIN_LABEL + ": 段/上下文自愈检查失败（已忽略，本步照常装配，fail-open）：" + describeError(error),
		);
	}

	/** 名册 ⇒ 期望的注册表（协调者版优先；vacant / 无活代理的角色不产出计划）。 */
	function planSections(teams) {
		const wanted = new Map();
		const list = Array.isArray(teams) ? teams : [];
		for (const team of list) {
			const incumbent = roleOf(team, COORDINATOR_ROLE)?.current ?? null;
			if (typeof incumbent === "string" && incumbent !== "" && !wanted.has(incumbent)) {
				wanted.set(incumbent, { team: team.name, sessionId: incumbent, role: COORDINATOR_ROLE, kind: "coordinator" });
			}
		}
		for (const team of list) {
			for (const entry of Array.isArray(team.roles) ? team.roles : []) {
				const sessionId = entry.current;
				if (typeof sessionId !== "string" || sessionId === "") continue;
				if (entry.role === COORDINATOR_ROLE) continue;
				if (wanted.has(sessionId)) continue;
				// task-11: worker 版不再携带协调者身份（义务行走角色寻址，见 renderWorkerDutyLine）。
				wanted.set(sessionId, { team: team.name, sessionId, role: entry.role, kind: "worker" });
			}
		}
		return wanted;
	}

	/** 释放一个会话的**两个面**（幂等）。每个 disposer **必须**被调用（U4/U7：代理消失也不泄漏）。
	 *  ★ 批 D（FR-3 §7.2）: 同批释放该会话的**门控缓存** —— 注册与它的缓存是同一条生命
	 *  （U8：只清注册不清缓存 ⇒ 红）。 */
	function disposeOne(sessionId) {
		const entry = registered.get(sessionId);
		if (entry === undefined) return false;
		registered.delete(sessionId);
		turnGate.delete(sessionId);
		for (const disposer of entry.disposers) {
			try {
				disposer();
			} catch (error) {
				ctx.logger?.warn?.(PLUGIN_LABEL + ": 角色/资源段的 disposer 抛错（" + sessionId + "）：" + describeError(error));
			}
		}
		return true;
	}

	/** 给一个**活代理**注册角色/资源（§6.3）。两面**各自探测、各自恰一行 warn、互不牵连**；
	 *  两面都没挂上 ⇒ 零注册（返回 false）。缺席 / 面不齐 ⇒ 见 §9 的失败方向。 */
	function registerOne(plan, switches) {
		// FR-9: 两处都关 ⇒ 零注册（没有段可挂、也没有资源行可挂）。
		if (!switches.role && !switches.resources) return false;
		// ★ 开关必须进**闭包捕获的那份计划**：text 是函数型、每次装配现算，它读的 plan 就是这里
		// 传下去的那一份 —— 只把它记进注册表（registered）而闭包读原 plan，开关就会在渲染面上失灵。
		const effective = { ...plan, switches };
		const agent = ctx.agents.get(effective.sessionId);
		if (agent === undefined) return false;
		const sp = agent.ctx?.systemPrompt;
		// 整面缺席（连服务都没有）⇒ 既有口径的**恰一行**，两面一起不注册。
		if (sp === null || sp === undefined) {
			warnUnsupported("宿主没有 agent.ctx.systemPrompt");
			return false;
		}
		const disposers = [];
		if (switches.role) {
			// 面：section（角色/宪章段）+ getSectionOrder —— 两条必备面缺任何一条都不注册这一面。
			if (typeof sp.section !== "function" || typeof sp.getSectionOrder !== "function") {
				warnSectionFace();
			} else {
				try {
					const disposer = sp.section({
						name: ROLE_SECTION_NAME,
						// §4.3: **section 面**的 order 一律取 getSectionOrder(...)，不用裸常量。
						order: sp.getSectionOrder(ROLE_SECTION_ORDER_KEY),
						// 函数型 text —— 同步、恒返回字符串；只产会话期内恒定的文本（U1/U2）。
						// 抛错时照 §6.1 v1.1 的签名经 onError 留痕（与 context 面共用 warnRender 那道一次性门）。
						text: () => renderRoleText(effective, warnRender),
					});
					disposers.push(typeof disposer === "function" ? disposer : () => {});
				} catch (error) {
					warnSectionFace(describeError(error));
				}
			}
		}
		if (switches.resources) {
			// 面：context（动态运行时上下文，独立探测 —— 上一面成不成功都不影响它）。
			if (typeof sp.context !== "function") {
				warnContextFace();
			} else {
				try {
					const disposer = sp.context({
						name: RESOURCE_CONTEXT_NAME,
						// §4.3: **context 面**允许任意有限 order（宿主契约原文），见 RESOURCE_CONTEXT_ORDER。
						order: RESOURCE_CONTEXT_ORDER,
						// ★ 闭包捕获注册时的 agent（宿主 AssembleContext 没有 agent 字段，§6.2）；
						// ★ 批 D（FR-3）：再带上这一格的**回合门**（按 sessionId 记账，随 disposeOne 释放）。
						text: () => renderResourceContext(ctx, agent, warnRender, { sessionId: effective.sessionId, cache: turnGate }),
					});
					disposers.push(typeof disposer === "function" ? disposer : () => {});
				} catch (error) {
					warnContextFace(describeError(error));
				}
			}
		}
		if (disposers.length === 0) return false;
		registered.set(effective.sessionId, { ...effective, disposers });
		return true;
	}

	/**
	 * 把进程内的段对齐到当前名册 + 当前活代理。幂等、纯本地（不写状态、不碰磁盘）。
	 * 调用点：attach（钩子②）与各名册写入点（钩子①）。
	 */
	function sync() {
		const switches = sectionsSwitches(policy.get());
		const wanted = planSections(policy.get().teams);
		let disposed = 0;
		for (const [sessionId, entry] of [...registered.entries()]) {
			// U4: 代理消失 ⇒ 立刻释放（不留悬挂的注册）。
			if (ctx.agents.get(sessionId) === undefined) {
				if (disposeOne(sessionId)) disposed += 1;
				continue;
			}
			const want = wanted.get(sessionId);
			// 开关也是「同一条」的一部分：用户翻开关 ⇒ 该段按新开关重挂（不会留着旧形状）。
			const same = want !== undefined && want.team === entry.team && want.role === entry.role && want.kind === entry.kind
				&& entry.switches?.role === switches.role && entry.switches?.resources === switches.resources;
			if (!same && disposeOne(sessionId)) disposed += 1;
		}
		let added = 0;
		for (const [sessionId, plan] of wanted) {
			if (registered.has(sessionId)) continue;
			if (registerOne(plan, switches)) added += 1;
		}
		// ★ 批 D（FR-1 §6.4）: **本批唯一新增的一行** —— 把「名册想要谁」刷进闭包缓存，
		// 供每步的自愈判据 needsSync 做第一道 O(1) 查表。其余（释放 / 注册 / 返回计数）逐字未动。
		wantedIds = new Set(wanted.keys());
		return { registered: registered.size, added, disposed };
	}

	/** 插件卸载时的清场（与看门狗定时器同一个生命周期纪律）。 */
	function disposeAll() {
		for (const sessionId of [...registered.keys()]) disposeOne(sessionId);
	}

	/** 五道一次性门的读数面（§7.2；`__testing` 与将来的诊断面读它）。
	 *  ★ 批 D 追加第五道 `selfHealWarned`（自愈失败那一行）。 */
	return {
		sync,
		disposeAll,
		registered,
		planSections,
		/** ★ 批 D（FR-1）：每步的 O(1) 自愈判据（见 {@link needsSync}；U1/U2/U3 读它）。 */
		needsSync,
		/** ★ 批 D（FR-1）：自愈失败的一次性留痕门（`agent/pre-step` 监听器在 catch 里调它）。 */
		warnSelfHealOnce,
		/** ★ 批 D（FR-3 §7.2）：回合门的进程内缓存（`sessionId -> { turn, text }`）—— U8 读它钉
		 *  「代理消失 ⇒ 缓存同批清（零泄漏）」。生产侧只有 `renderResourceContext` 读写它。 */
		turnGate,
		warnState: () => ({ unsupportedWarned, sectionFaceWarned, contextFaceWarned, renderWarned, selfHealWarned }),
	};
}

// ---------------------------------------------------------------------------
// roster (team role registry) + team blackboard (§3.3, M2)
// ---------------------------------------------------------------------------

/** Team names are `[a-z0-9-]+` (§3.3.1). The name becomes a path segment of the
 * blackboard directory, so every other shape — a separator, a dot, an empty
 * string — is refused at the door instead of reaching `path.join`. */
const TEAM_NAME_RE = /^[a-z0-9-]+$/u;
/** §4.3（可观测批 A）收件视图的**两个尺寸常量**：读调用方自己最近 **20** 条消息；每条预览
 * **80** 码点，越界截断并**标注省略**（本仓「截断必标注」的既有规矩）。20 也是**同一个屏界
 * 常量**：派生回执的「最近 N 次 team_link_send」用它，不再为同一块屏立第三个常量。 */
const TASK_INBOX_MESSAGES = 20;
const TASK_INBOX_PREVIEW = 80;
/** §2.2 的映射约定：`meta.ref = t-<序号>`。收件视图按它把消息归到任务号上（**读时算**，
 * 不建队列）。只认 `t-<数字>`——`ref` 里别的值不参与归组，但会被**如实计数**（不静默丢弃）。 */
const TASK_REF_RE = /ref=(t-\d+)/u;
/** 跨会话消息正文的 banner 首行前缀（§3.4）：收件视图显示 banner **之后**的正文，banner
 * 自己的 `ref=` 已经用于归组了。 */
const CROSS_SESSION_BANNER_PREFIX = "📨 [跨会话消息";
/** §4.4 的投递事实有两个**既有**事件载体（读既有事件，绝不新增事件类型——§10.3 红线）：
 * 一等工具调用是 `tool/call`；从 `run_code` 程序里发出的是桥记的 `tool/ptc-dispatch`
 * （README 已实测：那一类**没有** `tool/result.meta`，所以回执卡缺席时按实参兜底）。 */
const SEND_CALL_EVENT_TYPES = new Set(["tool/call", "tool/ptc-dispatch"]);
/** §4.1 的成本不变量在 `team_read` 上的形态：**自读占 1 个额**，点名读目标面用掉余下额度
 * ⇒ 目标面最多 `PREVIEW_SESSIONS - 1` 个；`readIds` 再长也只读前 11 个，其余**如实标未读**。 */
const TEAM_READ_TARGET_LIMIT = PREVIEW_SESSIONS - 1;
/** §4.4（D7 修复轮）按**当前名册**解析出来的那一行必须自带标注：`team:<name>/<role>` 是
 * 读取**此刻**解析出来的那个人，换届之后它未必是投递当时那一个 —— 不标注就会把 ✅/⚠
 * 悄悄判给一个当时并非收件人的会话（读数失准）。标注是读数，不是裁决。 */
const ROSTER_RESOLVED_NOTE = " · 按当前名册解析（该表达式按读取时的名册解析，未必是投递当时那一个）";
/** Longest role name accepted — a role name is a settings key and a markdown
 * heading, not a document. */
const ROLE_NAME_LIMIT = 64;

/** Team name reading (§3.3.1): `[a-z0-9-]+`, trimmed; everything else refuses. */
function readTeamName(value) {
	if (typeof value !== "string" || value.trim() === "") return { error: "需要 team（团队名）。" };
	const name = value.trim();
	if (!TEAM_NAME_RE.test(name)) return { error: `团队名 ${name} 非法：只允许 [a-z0-9-]+（团队名是黑板目录的路径段，收紧字符集以杜绝路径穿越）。` };
	return { value: name };
}

/** Role name reading: non-empty, bounded, free of control characters, and never
 * the addressing grammar's reserved word — a role name is stored in settings,
 * rendered as a markdown heading AND is a path segment of `team:<name>/<role>`.
 * A role literally named `*` would make `team:<name>/*` ambiguous: the wildcard
 * branch of §3.4 is matched first, so the role could never be addressed (R6, M3
 * review). */
function readRoleName(value) {
	if (typeof value !== "string" || value.trim() === "") return { error: "需要 role（角色名；约定角色名 coordinator）。" };
	const role = value.trim();
	if (role === "*") return { error: "角色名不能是 *（寻址文法保留字：team:<name>/* 表示全队广播，§3.4；以 * 命名的角色永远无法被点对点寻址）。" };
	if ([...role].length > ROLE_NAME_LIMIT) return { error: `角色名过长（上限 ${ROLE_NAME_LIMIT} 字符）。` };
	if (/[\u0000-\u001F\u007F]/u.test(role)) return { error: "角色名不能包含控制字符或换行。" };
	return { value: role };
}

/** Session id reading for `set-role` — one line, so a history record cannot be
 * split by an injected newline or a `|` separator. */
function readSessionId(value) {
	if (typeof value !== "string" || value.trim() === "") return { error: "需要 session（新现任会话 id）。" };
	const session = value.trim();
	if (/[\r\n|]/u.test(session)) return { error: "session 不能包含换行或 | 字符。" };
	return { value: session };
}

/** History note reading: optional, trimmed; an empty note is no note. */
function readNote(value) {
	if (typeof value !== "string") return undefined;
	const note = value.trim();
	return note === "" ? undefined : note;
}

/**
 * §11.9.5⑦ recovery audit rows, normalized the way every other role field is:
 * only a well-shaped row survives, and a row written by hand without the
 * declared fields is dropped rather than carried as a half-record.
 */
function normalizeRecoveries(list) {
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

/** The word for a role whose `current` is the empty seat (deliberate vacancy). */
const VACANT_LABEL = "vacant";
/** The word for a role whose seat is taken but whose holder has no live agent. */
const SEATED_DEAD_LABEL = "seated-dead";

/** §11.9.5① the CLOSED verb set of the recovery tool. Exactly two, because the
 * audit landing point has to be single and countable: a verb that is not in this
 * set is refused before anything is read, which is what keeps «恢复» from
 * decaying into a second, looser roster editor. */
const RECOVERY_VERBS = new Set(["revive", "reappoint"]);

/** §11.9.4's recovery ladder, in the caller's terms, in ONE place: the gates'
 * refusals, `roster get`, the recovery tool's own refusals and the startup sweep
 * all point at the same three rungs (and the third one is always reachable). */
function recoveryLadderText() {
	return "恢复梯子：① 在侧边栏重新打开该会话（同一个会话 id 复活，身份/信任/pairs 零改动）→ ② team_link_recover action=revive（仅插件自建会话，需在场确认）→ ③ team_link_recover action=reappoint（现任不会/不应再回来时改任，走完整 M4 交接）→ ④ 设置 UI 直接改 team-link 的 teams 键（用户永远是超级写者）。";
}

/** One line of §11.9.3's read-time liveness diagnosis for a role row, or `""`
 * when there is nothing to diagnose. Pure: `isLive` is injected, and the seat
 * must be OCCUPIED for this to say anything — `current === null` is the
 * deliberate vacancy, whose existing wording ("请由用户经设置 UI 指定现任")
 * is already the correct first action (§11.9.3: the two emptinesses must stay
 * distinguishable, or both get the wrong guidance). */
function recoveryLadderSuffix(entry, isLive) {
	if (entry === null || entry === undefined) return "";
	const incumbent = entry.current;
	if (incumbent === null || incumbent === undefined || incumbent === "") return "";
	if (isLive(incumbent) === true) return "";
	return `\n【活性诊断】该角色不在空缺名单里——现任 ${incumbent} 被 roster 认定为该角色的持有者，但本进程当前没有它的活动代理（${SEATED_DEAD_LABEL}；「能通讯、不能改身份」：黑板与 team_link_send 仍通，被卡住的是 roster 变更 / 换届 / 建队登记）。这不是「刻意空缺」（${VACANT_LABEL}，current=null），所以这里不该改人，而该把那个会话拉回来。${recoveryLadderText()}`;
}

/** A tool-layer liveness probe: the plugin's own live registry, read once. */
function agentIsLive(ctx, sessionId) {
	return typeof sessionId === "string" && sessionId !== "" && ctx.agents.get(sessionId) !== undefined;
}

/** §11.9.3's enrichment of a pure gate's refusal. The gate bodies stay PURE
 * (`writerGate` / `rotateGate` / `retireGate` take no `ctx` and are exported to
 * the test surface as such); the TOOL layer — which has a `ctx`, and therefore a
 * liveness reading — appends the named diagnosis to the refusal it already got.
 * A gate that passed, or whose message has nothing to diagnose (vacant seat,
 * caller without a session identity), comes back byte-identical. */
function withLiveGateDiagnostic(ctx, entry, result) {
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
function seatedDeadRoles(view, isLive) {
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
function modeDegradationNote(raw) {
	const single = String(raw).replace(/[\r\n\t]/gu, " ");
	return `形态降级留痕：settings 里的原值「${preview(single, 40)}」不在闭集内（闭集 ${TEAM_MODE_LIST}）⇒ 已按默认档 ${TEAM_MODE_SESSIONS} 读出（原值未被改写，请由用户在设置 UI 修正）。`;
}

/** §4.2 形态史行的**正文**（唯一事实源，写读同源）：落笔时用它，幂等分支「账上有没有这一行」
 * 的判据也用它 —— 两处各写一份字面量就是本仓最反对的「双份真相」（D8）。 */
function modeHistoryBody(mode, lead) {
	return mode === TEAM_MODE_AGENT_TEAM ? `形态 → agent-team（Lead=${lead}）` : "形态 → sessions";
}
/** 一条 decisions 行的**正文列**（第 4 列起，正文里的 `|` 原样拼回）；行不可解析 ⇒ `null`（不猜）。 */
function decisionRowBody(line) {
	const parts = String(line).split("|");
	if (parts.length < 4 || !/^\d+$/u.test(parts[0].trim())) return null;
	return parts.slice(3).join("|").trim();
}
/** §4.2 幂等分支的补记判据（D8）：账上**已有**这一档的形态史行？只看正文与
 * {@link modeHistoryBody} 逐字相等 —— 不比较时间戳、不看作者（这一档已经记过一次，就不必再记第二次）。 */
function decisionsHasModeHistory(text, mode, lead) {
	const wanted = modeHistoryBody(mode, lead);
	return blackboardLines(text).some((line) => decisionRowBody(line) === wanted);
}
/** §4.2 形态史落笔（写路径与幂等补记**共用**一条写入路径）：成功回一句「恰好一行」的读数；
 * 失败一律如实说「未写」+ 为什么 —— settings 那半边的状态由 `settingsNote` 交代。 */
async function appendModeHistoryRow(team, text, exec, label, settingsNote) {
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
async function backfillModeHistoryRow(team, mode, lead, exec) {
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
function modeTeamLine(team) {
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
function memberLine(member) {
	const bits = [member.role === "lead" ? "Lead" : "teammate", String(member.status)];
	if (typeof member.model === "string" && member.model !== "") bits.push(member.model);
	if (typeof member.description === "string" && member.description !== "") bits.push(preview(member.description, 60));
	return `${member.name}（${bits.join("，")}）`;
}

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
function probeAgentTeams(ctx, agent) {
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

/** 一个代理在会话面上的状态词（列表工具与状态卡原本各写一份 —— §C1 起收敛成**一处**）。
 * `ctx.agents.get` 的两种「没有这个代理」（`undefined` / `null`）都判「✕ 未运行」——
 * `null` 这一档是**行为修正**，不是静默漂移（分歧审计 🔵#5）：收敛前列表工具写的是
 * `running ? "▶ 运行中" : agent !== undefined ? "○ 空闲" : "✕ 未运行"`（`null` ⇒ 「○ 空闲」），
 * 状态卡那一份写 `agent === undefined ? … : agent.status === …`（`null` ⇒ 抛）。对
 * `ctx.agents.get` 实际会产生的两种输入（已定义 / `undefined`）逐字不变。 */
function agentStateLabel(agent) {
	return agent === undefined || agent === null ? "✕ 未运行" : agent.status === "running" ? "▶ 运行中" : "○ 空闲";
}

/** 状态卡 ④ 与面板会话区**共用**的一行会话面（id / 代理状态 / 创建时间 / provisional 标记）。 */
function sessionFaceLine(header, state, provisionalCount) {
	const provisionalNote = provisionalCount === 0 ? "" : ` · provisional 配对 ${provisionalCount} 条（换届临时信任：24h 内未批准自动回退）`;
	return `- ${header.id} — ${state} · 创建于 ${new Date(header.createdAt).toLocaleString()}${provisionalNote}`;
}

/** §C1 段①团队与角色的**段体**（状态卡与团队面板共用同一份字节：标题由调用方给，段体只有
 * 这一处渲染 —— 「一处事实一处渲染」）。 */
function teamRoleLines(shownTeams) {
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
function pendingLines(shownTeams) {
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
function watchdogRenewField(entry) {
	return typeof entry.renewedAt === "number" && Number.isFinite(entry.renewedAt)
		? " · 上次续期 " + readStamp(entry.renewedAt)
		: " · 上次续期（从未续期）";
}

/** §C1 段③看门狗的**段体**（谁盯谁 / 阈值 / 到期；按观察者会话登记，与团队只是弱关联）。 */
function watchdogLines(ctx, watchdogs) {
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
function tasksDerivedLines(taskRows) {
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
function teamDerivedLines(teamName, derivedLines) {
	if (!Array.isArray(derivedLines) || derivedLines.length === 0) return [];
	const lines = ["- " + teamName + "/tasks.md：" + derivedLines[0]];
	for (let index = 1; index < derivedLines.length; index += 1) lines.push("    " + derivedLines[index]);
	return lines;
}

/** §4.3 的形态段渲染器（`roster get` 与状态卡**共用**）：每团队一行形态 + Lead ·
 * 一次成员名册投影（两种来源文案写死其一）· 一次完整能力矩阵 · 结论 ·（必要时）诊断行。
 * `modeTeams` 是本次要显示的团队行；`projection` 是本次读到的宿主投影；
 * `otherSessions` 是会话列表快照判据（`null` = 快照读不到 ⇒ 不判、也不猜）。 */
function teamModeSectionLines(modeTeams, projection, otherSessions) {
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
function modeCapabilityLines(mode) {
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
async function askModeDialog(ctx, exec, request) {
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
async function sessionIdSnapshot(ctx) {
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
async function otherReachableSessions(ctx, exec) {
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
function readLeadSessionId(value) {
	if (typeof value !== "string") return { error: "leadSessionId 必须是字符串（省略 ⇒ 默认取调用方自己的会话 id）。" };
	const lead = value.trim();
	if (lead === "") return { error: "leadSessionId 是**显式空串** —— agent-team 档没有 Lead 就没有意义（省略它即默认取你的会话 id；要给别的会话就给一个可寻址的 id）。" };
	if (!LEAD_SESSION_ID_RE.test(lead)) return { error: `leadSessionId 形状非法（「${preview(lead, 40)}」）—— 首字符必须是字母或数字，其后 0–63 个 [A-Za-z0-9._-]。` };
	return { value: lead };
}

/** The open (incumbent) tenure record of one role, or `null` — `until: null` is
 * what marks the tenure the current holder is still serving. */
function openTenureOf(entry) {
	for (let index = entry.history.length - 1; index >= 0; index -= 1) {
		const record = entry.history[index];
		if (record.session === entry.current && record.until === null) return record;
	}
	return null;
}

/** The start of a role's open tenure — the incumbent's `from`, falling back to
 * the team creation time when history holds no open record (hand-edited row). */
function tenureStartOf(entry, team) {
	const open = openTenureOf(entry);
	return open === null ? team.createdAt : open.from;
}

/**
 * §3.3.2 write permission for one team. `policy.writer === "any"` admits every
 * session. `"coordinator"` (the default) admits only the session currently
 * holding the `coordinator` role — and a vacant coordinator refuses every
 * session path, because the design points that case at the settings UI, where
 * the user is always the super-writer.
 */
function writerGate(team, caller) {
	if (team.policy.writer === "any") return { ok: true };
	const coordinator = roleOf(team, COORDINATOR_ROLE);
	const incumbent = coordinator === null ? null : coordinator.current;
	if (incumbent === null) {
		return { error: `写操作被拒绝：团队 ${team.name} 的 policy.writer=coordinator，但 coordinator 角色当前空缺（current=null）——会话路径写不进去，请由用户经设置 UI（设置命名空间 team-link 的 teams 键）指定现任协调者。` };
	}
	if (caller === undefined) {
		return { error: `写操作被拒绝：团队 ${team.name} 的 policy.writer=coordinator，只有现任协调者会话 ${incumbent} 可写，而当前执行上下文没有会话身份（exec.agent.id）。` };
	}
	if (caller !== incumbent) {
		return { error: `写操作被拒绝：团队 ${team.name} 的 policy.writer=coordinator，只有现任协调者会话 ${incumbent} 可写（当前调用会话 ${caller}）。` };
	}
	return { ok: true };
}

/**
 * §3.3.2 (v1.3) retirement permission, implemented verbatim: "仅现任协调者会话
 * 或用户发起". Deliberately independent of `policy.writer` — the clause names
 * the incumbent coordinator, not the writer policy, so a `writer: "any"` team
 * still retires through its coordinator. The user path is the settings UI.
 */
function retireGate(team, caller) {
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

// ---------------------------------------------------------------------------
// 批 H（删团队）: `team_link_roster action=delete` 的确认框 / 存在性探测 / 落笔
// （设计档 docs/2026-10-12-team-delete-design.md §5 FR-H2…H4 · §6 伪代码）
// ---------------------------------------------------------------------------

/** 批 H §6: the delete dialog's own identity. It has its own id and labels rather
 * than reusing the recovery ones: the answer is matched BY LABEL, and two
 * different irreversible acts sharing a label could not be told apart in a
 * transcript. */
const DELETE_DIALOG_ID = "team-delete-confirm";
const DELETE_CONFIRM_LABEL = "确认删除";
const DELETE_CANCEL_LABEL = "取消";

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
async function blackboardDirPresence(team) {
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
async function blackboardUntouchedLine(team) {
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
async function askDeleteConfirm(ctx, agent, request, signal) {
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
async function deleteTeam(ctx, agent, policy, teamName, signal) {
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
function applyTeamUpsert(teams, request) {
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
function applySetRole(team, request) {
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
function applyRetire(team, request) {
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
function trustReferencesTo(view, session) {
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
function renderRosterMirror(team) {
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
async function writeRosterMirror(team) {
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
function mirrorNote(mirror) {
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
function readTaskReceiptTargets(value, selfId) {
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
function surfaceMessageEvents(events) {
	const out = [];
	for (const event of Array.isArray(events) ? events : []) {
		if (event?.type !== "user/message" && event?.type !== "assistant/message") continue;
		if (typeof event.time !== "number") continue;
		out.push(event);
	}
	return out;
}

/** 一个消息事件的全文：user 在 `data.content`，assistant 在 `data.message.content`。 */
function surfaceEventText(event) {
	if (event?.type === "user/message") return textOf(event.data?.content);
	if (event?.type === "assistant/message") return textOf(event.data?.message?.content);
	return "";
}

/** `MM-DD HH:mm` —— §4.3/§4.4 示例行的形状（一行一条，不带年份）。 */
function shortStamp(ms) {
	const date = new Date(ms);
	const pad = (n) => String(n).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 跨会话消息的正文：剥掉 banner 首行（它的 `ref=` 已经用于归组），其余是载荷（§3.4）。 */
function crossSessionBody(text) {
	const value = String(text ?? "");
	if (!value.startsWith(CROSS_SESSION_BANNER_PREFIX)) return value;
	const end = value.indexOf("]");
	return end === -1 ? value : value.slice(end + 1).trim();
}

/** §4.3 一条条目的开头：至多 {@link TASK_INBOX_PREVIEW} 码点，截断**必标注**（本仓既有规矩）
 * ——标注留在**同一行**上，因为一条条目就是一行。 */
function inboxOpening(text) {
	const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
	const chars = [...flat];
	if (chars.length <= TASK_INBOX_PREVIEW) return flat;
	return `${chars.slice(0, TASK_INBOX_PREVIEW).join("")}…（已省略 ${chars.length - TASK_INBOX_PREVIEW} 字符）`;
}

/** §4.4 的结构化回执（`tool/result.meta`，用 §10.1.2 自己的判别符 + 版本认）。形状不认 ⇒
 * null：与客户端同一条纪律——手改过的日志不得让读面**编出**一个投递事实。 */
function readReceiptTargets(meta) {
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
function parseToolArguments(value) {
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
function surfaceSendRecords(events) {
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
function resolveSendTargets(expr, teams) {
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
function taskMessageBlock({ selfId, selfSurface, readIds, targetSurfaces, overflowTargets, registeredIds, teams }) {
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
function asText(value) {
	return typeof value === "string" && value !== "" ? value : null;
}

/** §4.4 一笔投递读成若干「目标行」：优先用回执（投递当时的解析结果），没有回执才按实参
 * 兜底、并在行上**如实标注** {@link ROSTER_RESOLVED_NOTE}（表达式解析出来的那个人可能已经
 * 不是当时那一个了——换届之后尤其如此；这是读数，不是裁决）。 */
function receiptRowsOf(record, teams) {
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
function renderReceiptRow(row, { attempted, targetSurfaces }) {
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

/**
 * Register the M2 tools (§3.3.2/§3.3.3): the roster registry and the team
 * blackboard reader/writer.
 */
function registerTeamTools(ctx, policy, rotation, sections = null) {
	// ★ 批 R 第 7 小单（域拆分）：`team_link_roster` 的注册语句已**逐字节**搬到
	// `lib/team-registration.js`（`registerRosterTool`）；此处**在同一位置**调用它 ⇒ 三条注册的先后
	// 顺序、工具名 / 描述 / 参数 / 超时与返回文案逐字不变。缝的注入见模块尾部
	// `wireTeamRegistration(teamRegistrationExtras())`。
	registerRosterTool(ctx, policy, rotation, sections);
	// ★ 批 R 第 8 小单（域拆分）：`team_link_team_read` 的注册语句已**逐字节**搬到
	// `lib/team-ledger-tools.js`（`registerTeamLedgerTools`）；此处**在同一位置**（roster 之后、
	// append 之前）调用它 ⇒ 三条注册的先后顺序、工具名 / 描述 / 参数 / 超时与返回文案逐字不变。
	// 缝的注入见模块尾部 `wireTeamLedgerTools(teamLedgerToolsExtras())`。
	registerTeamLedgerTools(ctx, policy, rotation);

	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_team_append",
		description: "写团队黑板（M2，§3.3.3）：file=decisions 只追加一条裁决（格式 'seq | ISO时间 | author-session-id | 正文'，seq 由插件分配、单调递增，无需 baseHash）；file=discipline 整文件替换纪律条款（必须携带 team_link_team_read 返回的当前 baseHash，不匹配则拒绝并要求重读——乐观锁，防两个 worker 并发改稿互相覆盖）。三者都受单行 2000 字符上限（§4.1，按码点计）。任何会话都可写：黑板没有写权限门，写入者身份记录在行内 author 字段（透明可审计）。新增 file=tasks（§9.3.1 只追加任务台账）：每行 'seq | ISO时间 | author-session-id | kind | task | 正文'，kind 是闭集（plan / claim / done / block / dispute / retract）；kind=plan 由插件**扫全文件**分配 t-<最大号+1>（此时不要再传 task），其余 kind 必须给 task 且该号必须已在本文件登记过（未登记的号一律拒绝）；seq 与 decisions **各自独立计数**，单行上限同为 2000 字符。kind / task 与 file=decisions / discipline 组合一律拒绝（参数误用不静默生效）。台账写的永远是「谁声称了什么」：读面给出的「最后主张 / 未消解存疑」是**派生读数**，不是裁决。",
		parameters: {
			team: { type: "string", required: true, description: "团队名（须已在 roster 中注册）" },
			file: { type: "string", required: true, enum: ["decisions", "discipline", "tasks"], description: "decisions（只追加裁决）/ discipline（整文件替换）/ tasks（只追加任务台账）" },
			line: { type: "string", description: "decisions / tasks：单行正文（单行 2000 字符上限，按码点计，§4.1）；discipline：新的整份内容（其中**每一行**同样受这条单行 2000 字符上限约束）" },
			baseHash: { type: "string", description: "discipline 必填：team_link_team_read 返回的当前 baseHash" },
			kind: { type: "string", description: "tasks 必填：闭集 plan / claim / done / block / dispute / retract（plan=派活并由插件分配任务号；claim=接活；done=声称完成；block=卡住或需要授权；dispute=对某条主张存疑；retract=撤回自己此前的主张）" },
			task: { type: "string", description: "tasks：任务号 t-<数字>。kind=plan 时不要传（由插件分配）；其余 kind 必填，且该号必须已在本文件登记过" },
		},
		output: textOutput(),
		timeoutMs: 30000,
		async execute(args, exec) {
			try {
				const name = readTeamName(args.team);
				if (name.error !== undefined) return wellFormed(`写入失败：${name.error}`);
				const team = policy.get().teams.find((candidate) => candidate.name === name.value) ?? null;
				if (team === null) return wellFormed(`写入失败：团队 ${name.value} 不在注册表中（先用 team_link_roster action=upsert-team 创建）。`);
				if (team.workspace === "") return wellFormed(`写入失败：团队 ${name.value} 没有 workspace 记录，黑板根目录未知。`);
				const file = typeof args.file === "string" ? args.file : "";
				if (!BLACKBOARD_FILES.has(file)) return wellFormed("写入失败：file 必须是 decisions 或 discipline 或 tasks（白名单，不接受任何路径）。");
				const paths = blackboardPaths(team);
				const author = blackboardAuthor(exec);
				// §9.3.2 参数误用: `kind` / `task` belong to the tasks ledger alone. Handing
				// either of them to decisions or discipline gets ONE refusal line and ZERO
				// writes — parameter misuse must never take effect silently on the two faces
				// this batch promises not to touch (U18). Presence, not truthiness: an empty
				// string is still the caller using a parameter that has no meaning here.
				const kindArg = args.kind;
				const taskArg = args.task;
				const kindGiven = kindArg !== undefined && kindArg !== null;
				const taskGiven = taskArg !== undefined && taskArg !== null;
				if (file !== "tasks" && (kindGiven || taskGiven)) {
					return wellFormed(`写入失败：kind / task 只对 file=tasks 生效（本次 file=${preview(file, 20)}）——参数误用一律拒绝，防它静默生效；decisions / discipline 的写入面未变。`);
				}

				if (file === "decisions") {
					const text = readBlackboardLine(args.line, "line");
					if (text.error !== undefined) return wellFormed(`写入失败：${text.error}`);
					// ★ 批 E（FR-5）：**落盘前**过消毒（设计档 §6.4）—— 盘上永不出现那个包裹结构。
					// 行格式与校验顺序一律**不动**（形状 → 单行 → 长度上限）；只有正文那一份换成干净的。
					// ★ 交付评审 #2 更正（此前这段注释是**假的**）：长度上限**判两次** —— 先由
					// `readBlackboardLine` 按**原文**判一次（与全部黑板读面同口径），消毒后**再复检一次**
					// （下面的 `cleanLength`）。占位符比原 token 长 ⇒ 只判原文会放过一条「写下去就超限」的
					// 行，而回执又打出「上限 2000 字符（本次 2013 字符）」这种自相矛盾的读数；
					// （★ 批 F·甲：示例数字随上限一起由 500/513 改成 2000/2013 —— 占位符比它替掉的
					//  那一段长 13 码点，所以「原文恰在上限上」的一条写下去就是 2013）；
					// 这道复检与 discipline 分支（同样的消毒后复检）同一口径。
					// 替换处数由占位符自证（§6.5 v1.1）⇒ 回执**不追加**任何读数行。
					const clean = sanitizeFraming(text.value);
					if (/[\r\n]/u.test(clean.text)) return wellFormed("写入失败：decisions 的正文必须单行——每行是一条账本记录，换行会破坏 seq | 时间 | author | 正文 的解析。");
					const cleanLength = [...clean.text].length;
					if (cleanLength > BLACKBOARD_LINE_LIMIT) {
						return wellFormed(`写入失败：decisions 正文超过单行上限 ${BLACKBOARD_LINE_LIMIT} 字符（消毒后 ${cleanLength} 字符，原文 ${[...text.value].length} 字符——占位符比原 token 长；§4.1）。盘上未写入任何内容。`);
					}
					const existing = await readBlackboardFile(paths.decisions);
					if (existing.error !== undefined) return wellFormed(`写入失败：decisions.md 无法读取（${existing.error}）。`);
					const seq = lastDecisionSeq(existing.text) + 1;
					const row = decisionRow(seq, new Date().toISOString(), author, clean.text);
					// Append, do not rewrite: the ledger is append-only, so a concurrent append
					// from another session can at worst duplicate a seq number, never lose a row
					// (§3.3.3 puts the optimistic lock on discipline only). The leading newline
					// repairs a file whose last append was interrupted before its terminator.
					const prefix = existing.text === "" || existing.text.endsWith("\n") ? "" : "\n";
					try {
						await mkdir(paths.dir, { recursive: true });
						await appendFile(paths.decisions, `${prefix}${row}\n`, "utf8");
					} catch (error) {
						return wellFormed(`写入失败：decisions.md 写入出错（${describeError(error)}）。`);
					}
					return wellFormed([
						`已追加 decisions #${seq}（author=${author}）→ ${paths.decisions}`,
						"行格式：seq | ISO 时间 | author-session-id | 正文（seq 由插件分配、单调递增；只追加不删除）。",
						`单行上限 ${BLACKBOARD_LINE_LIMIT} 字符（本次 ${[...clean.text].length} 字符，§4.1）。`,
					].join("\n"));
				}

				if (file === "tasks") {
					const kind = typeof args.kind === "string" ? args.kind.trim() : "";
					if (!TASK_KINDS.has(kind)) {
						return wellFormed(`写入失败：tasks 的 kind 必须在闭集内（${TASK_KIND_LIST}）——当前${kind === "" ? "缺失" : `是「${preview(kind, 40)}」`}。`);
					}
					const text = readBlackboardLine(args.line, "line");
					if (text.error !== undefined) return wellFormed(`写入失败：${text.error}`);
					// ★ 批 E（FR-5）：与 decisions 同一处收口（落盘前消毒；校验与行格式不动）。
					// ★ 交付评审 #2：同样**消毒后复检**长度上限（两个写入分支与 discipline 分支三处同口径）——
					// 只判原文会放过「原文 ≤2000、消毒后 >2000」的行（占位符比原 token 长）。拒绝在任何写之前。
					const clean = sanitizeFraming(text.value);
					if (/[\r\n]/u.test(clean.text)) return wellFormed("写入失败：tasks 的正文必须单行——每行是一条台账记录，换行会破坏 seq | 时间 | author | kind | task | 正文 的解析。");
					const cleanLength = [...clean.text].length;
					if (cleanLength > BLACKBOARD_LINE_LIMIT) {
						return wellFormed(`写入失败：tasks 正文超过单行上限 ${BLACKBOARD_LINE_LIMIT} 字符（消毒后 ${cleanLength} 字符，原文 ${[...text.value].length} 字符——占位符比原 token 长；§4.1）。盘上未写入任何内容。`);
					}
					const existing = await readBlackboardFile(paths.tasks);
					if (existing.error !== undefined) return wellFormed(`写入失败：tasks.md 无法读取（${existing.error}）。`);
					// §9.3.2: allocation scans the WHOLE file (the §9.3.3 read window plays no
					// part here), and the same scan is what tells an already registered number
					// from one that was never introduced into this file.
					const registered = registeredTaskIds(existing.text);
					let task = "";
					if (kind === "plan") {
						if (taskGiven) {
							return wellFormed("写入失败：kind=plan 的任务号由插件分配（扫全文件取 t-<最大号+1>），不要再传 task——要引用一个已登记的号请用 claim / done / block / dispute / retract。");
						}
						// D9: the number is the plugin's to assign, and it assigns a SAFE integer
						// only. A hand-written id past 2^53 (`Number` reads it as 1e22) would
						// otherwise be allocated from and written back as `t-1e+22` — a row this
						// very file's parser refuses. Refusing names the reason and leaves the file
						// untouched; clamping would silently redefine an id somebody else wrote.
						const refusePlan = (reason) => wellFormed(`写入失败：tasks.md 的 kind=plan 分配被拒绝——${reason}（插件只分配安全整数任务号，不钳制、也不猜；请先手工修掉那一行）。`);
						if (registered.unsafe.length > 0) return refusePlan(`文件里已有超出安全整数范围的任务号 ${registered.unsafe.map((id) => preview(id, 40)).join("、")}`);
						const next = registered.max + 1;
						if (!Number.isSafeInteger(next)) return refusePlan(`已登记的最大号 ${registered.max} 加一之后超出安全整数范围`);
						task = `t-${next}`;
					} else {
						const wanted = typeof taskArg === "string" ? taskArg.trim() : "";
						if (wanted === "") return wellFormed(`写入失败：非 plan 必须给 task（形如 t-7）——kind=${kind} 说的是「哪一件事」现在的样子。`);
						if (!TASK_ID_RE.test(wanted)) return wellFormed(`写入失败：task 形状非法（「${preview(wanted, 40)}」）——必须是 t-<数字>（形如 t-7）。`);
						if (!registered.ids.has(wanted)) {
							return wellFormed(`写入失败：task ${wanted} 从未在本文件登记过（本文件已登记 ${registered.ids.size} 个号）——先用 kind=plan 把它登记出来，不要凭记忆转录 id。`);
						}
						task = wanted;
					}
					// —— 批 34 / FR-7：台账**迁移表门**（默认 OFF；开关 `antiDrift.ledgerTransitionGate`）——
					// 权威规格 = 设计档 `2026-10-14-anti-drift-design.md` §5 FR-7（两条规则 +
					// fail-closed），门本体见 {@link ledgerTransitionGate}。
					// 位置刻意选在**所有既有校验之后、`seq` 分配与 append 之前**：
					//   ① 在校验之后 ⇒ 门只对"本来就会被接受的行"生效，不改变既有拒绝面；
					//   ② 在 append 之前 ⇒ 拒 = **零写入**（本仓一贯口径）。
					// 开关读法与同文件其它策略字段同源（`policy.get()`，见上方 teams 读取），
					// 键路径是**嵌套**的 `antiDrift.ledgerTransitionGate`（会诊 #78 裁定，见
					// `DEFAULT_POLICY` 的 `antiDrift` 注与归一化的 {@link antiDriftView}）。
					// 读策略抛错 ⇒ **不静默放行**：按"门可用但读不到开关"处理 ⇒ 回落到关闭
					// （默认 OFF 是用户面拍板的语义；策略面故障不该凭空改变既有写入行为）。
					// 注：D10 的 fail-closed 指的是**门内**的解析失败（台账读不出 / 行解析不了 ⇒
					// 拒写，见门函数），不是「开关读不出来就拒掉所有台账写入」。
					let gateOn = false;
					try {
						gateOn = policy.get()?.antiDrift?.ledgerTransitionGate === true;
					} catch {
						gateOn = false;
					}
					if (gateOn) {
						const verdict = ledgerTransitionGate({
							kind, task, body: clean.text, fileText: existing.text,
						});
						if (!verdict.ok) return wellFormed(`写入失败：${verdict.reason}`);
					}
					const seq = lastSeq(existing.text) + 1;
					const row = tasksRow(seq, new Date().toISOString(), author, kind, task, clean.text);
					// Append, do not rewrite — the same argument as the decisions ledger (§9.4):
					// a concurrent append can at worst duplicate a seq or a freshly allocated
					// task number, it can never lose a row.
					const prefix = existing.text === "" || existing.text.endsWith("\n") ? "" : "\n";
					try {
						await mkdir(paths.dir, { recursive: true });
						await appendFile(paths.tasks, `${prefix}${row}\n`, "utf8");
					} catch (error) {
						return wellFormed(`写入失败：tasks.md 写入出错（${describeError(error)}）。`);
					}
					return wellFormed([
						`已追加 tasks #${seq}（kind=${kind}，task=${task}，author=${author}）→ ${paths.tasks}`,
						"行格式：seq | ISO 时间 | author-session-id | kind | task | 正文（seq 由插件分配、单调递增；task 由 kind=plan 分配；只追加不删除，撤回也是一条新行）。",
						`单行上限 ${BLACKBOARD_LINE_LIMIT} 字符（本次 ${[...clean.text].length} 字符，§4.1）。`,
					].join("\n"));
				}

				if (typeof args.line !== "string") return wellFormed("写入失败：discipline 需要 line（新的整份内容）。");
				// ★ 批 E（FR-5）：整份内容在**落盘前**过消毒（与 decisions / tasks 同一个收口）。
				// 校验顺序不动（单行上限 → baseHash → 乐观锁），只是校验与落盘都用**干净的那一份**：
				// 写下去的字节与回执里那个新 baseHash 因此指的是同一份内容。
				const cleanContent = sanitizeFraming(args.line).text;
				const contentLines = cleanContent.split(/\r?\n/u);
				const tooLong = contentLines.findIndex((row) => [...row].length > BLACKBOARD_LINE_LIMIT);
				if (tooLong !== -1) return wellFormed(`写入失败：discipline 第 ${tooLong + 1} 行超过单行上限 ${BLACKBOARD_LINE_LIMIT} 字符（当前 ${[...contentLines[tooLong]].length} 字符；§4.1）。`);
				const baseHash = typeof args.baseHash === "string" ? args.baseHash.trim() : "";
				if (baseHash === "") return wellFormed("写入失败：discipline 是整文件替换，必须携带 team_link_team_read 返回的当前 baseHash（乐观锁，防双写覆盖）。");
				const existing = await readBlackboardFile(paths.discipline);
				if (existing.error !== undefined) return wellFormed(`写入失败：discipline.md 无法读取（${existing.error}）。`);
				const currentHash = blackboardHash(existing.text);
				if (baseHash !== currentHash) {
					return wellFormed(`写入失败：discipline baseHash 不匹配——文件已被其他会话改写（当前 baseHash=${currentHash}，你携带的是 ${baseHash}）。请重新 team_link_team_read 取回最新内容与 baseHash 后再写（乐观锁）。`);
				}
				try {
					await mkdir(paths.dir, { recursive: true });
					await writeFile(paths.discipline, cleanContent, "utf8");
				} catch (error) {
					return wellFormed(`写入失败：discipline.md 写入出错（${describeError(error)}）。`);
				}
				return wellFormed([
					`已替换 discipline.md（author=${author}）→ ${paths.discipline}`,
					`baseHash ${currentHash} → ${blackboardHash(cleanContent)}（下次替换必须携带新值）。`,
					`共 ${contentLines.length} 行；单行上限 ${BLACKBOARD_LINE_LIMIT} 字符（§4.1）。`,
				].join("\n"));
			} catch (error) {
				return wellFormed(`写入失败：${describeError(error)}`);
			}
		},
	})), "team-link: team append tool");
}

/**
 * Register the M4 tool: the two phases of a rotation (§3.6.2). Kept in its own
 * registration (rather than folded into the M2 roster tool) because the two
 * phases have different actors, different preconditions and a token.
 */
// ---------------------------------------------------------------------------
// §11.2/§11.4 successor:"auto" — the plugin builds the successor and hands over
// ---------------------------------------------------------------------------
//
// 机制与判断分离 (§3.6.2, unchanged): the plugin owns every mechanical step —
// create the root session, write the hand-over document, mint the token, freeze,
// deliver — and the MODEL owns the judgement, which is the hand-over body. What
// this path adds over the manual one is exactly one thing: the successor session
// no longer has to exist before the hand-over starts (§11.0).

// --- the five-hard-section list and its renderings (§11.9.6) ----------------
// HOISTED to here on purpose: the lists below are read by the §11.2 delivery body
// and by the `team_link_rotate` description, both of which live in THIS section,
// while the validator that consumes them sits far below with the document
// contract. One `const` array can only be initialized once, so the source of
// truth has to sit above every reader.
//
/** The FIVE body sections a `successor:"auto"` prepare refuses to run without
 * (§11.9.6). This ONE array is the source of the validator, of the scaffold the
 * refusal prints, of {@link HANDOFF_SECTION_HINTS}, of the header's integrity
 * line, and of every prose rendering of the list — {@link handoffSectionsInline},
 * {@link handoffSectionsAsHeadings}, {@link handoffDeliveryMessage} and the
 * `team_link_rotate` description all render FROM it. A section therefore cannot
 * be enforced in one place and advertised in another (the ② round's "same-fact
 * list, half of it updated" lesson; ③a 差异审计修复轮 🟡-3). */
const HANDOFF_HARD_SECTIONS = ["mission", "in-flight", "commitments", "unknowns", "task-and-goal"];
/** The soft sections: their absence is a WARNING, never a refusal (§11.9.6). */
const HANDOFF_SOFT_SECTIONS = ["first-actions", "team-map", "conventions"];
/** One scaffold line per hard section, in §11.9.6's own terms — the refusal hands
 * the model something it can fill in instead of only a complaint. Keyed by the
 * SAME names as {@link HANDOFF_HARD_SECTIONS} (locked by a host-half assertion,
 * because this is a list that must be edited together with that one). */
const HANDOFF_SECTION_HINTS = {
	mission: "角色对团队负责什么（这个角色存在的理由，不是任务清单）",
	"in-flight": "在飞工作：事项 / 相关成员 / 当前状态 / 下一步",
	commitments: "未兑现的承诺（答应过谁、什么、什么时候）",
	unknowns: "负面空间声明——把沉默变成信息：不知道什么、谁在等什么、哪里还没验证",
	"task-and-goal": "当前目标与 goal 相位（armed-active / paused / blocked / 无 goal）；继任者的第一个动作建议是 /goal resume 或新建 goal，本节必须说清有没有 goal 可续",
};
/** §11.9.6's hard sections as one inline list, in the §11.9.6 order — the ONE
 * rendering every prose face uses (the tool description, the `handoff` parameter,
 * the delivery body, the scaffold's refusal line and {@link handoffScaffold}).
 * There is no second spelling of this list anywhere: that is what makes "rename a
 * section and the prose follows" true instead of merely intended. */
function handoffSectionsInline() {
	return HANDOFF_HARD_SECTIONS.join(" / ");
}

/** The sentinel `successor` value meaning "build one for me" (§11.2). Compared
 * verbatim after trimming, so an id can never collide with it (ids are validated
 * by {@link readSessionId}, which rejects this token's shape anyway). */
const ROTATION_AUTO = "auto";
/** Question id of the §11.4.1 confirmation — matched by id, not by order. */
const ROTATION_AUTO_DIALOG_ID = "rotation-auto";
/** The ONE answer that lets the auto path run; everything else (the cancel
 * option, an unanswered dialog, a timeout, a missing confirmation service) is
 * fail-closed (§11.4.1). */
const ROTATION_AUTO_CONFIRM_LABEL = "创建并交班";
const ROTATION_AUTO_CANCEL_LABEL = "取消";

/** §11.4.1's confirmation text: creation + hand-over is a big blast radius, so
 * the box names the count, the cwd, the **inherited settings** (批 P · FR-P3 ①:
 * 逐项实际值 / 未继承原因 —— `state.inheritance` 三行由 {@link inheritanceRows}
 * 一处渲染，与 prepare 回执、交接文档事实段同源同字), the conservative cost,
 * the trust being touched and what cancelling does.
 *
 * DEFECT-4 补一线：新会话的默认标题也在框里写明（`state.title` 与创建路径交给
 * `sessionTitle.rename` 的是**同一个值**）。理由是它与「成本口径 / 信任面」同一层级——
 * 用户要在**动作发生之前**知道他将得到什么，而不是事后去侧边栏里发现一批同名会话。 */
function rotationAutoDialogText(state) {
	return [
		`即将自动换届：为团队 ${state.teamName} 的角色 ${state.roleName} 新建 1 个根会话并立即交班。`,
		`- 新会话 id：${state.sessionId}（插件自建、插件持有它的 AgentHandle；meta 只放 cwd/agentPreset，不含任何血统字段，§11.4.2 / §10.2.5）`,
		`- cwd：${state.cwd}`,
		state.title === undefined
			? "- 会话标题（DEFECT-4）：无法从 team/role 派生 ⇒ 本次不设标题（它会显示为宿主的默认标题，很可能是工作区名）——可在壳里手动重命名。"
			: `- 会话标题（DEFECT-4）：「${state.title}」——按「<team> · <role>」派生（团队名过长时截**团队段**、**role 段完整**；缺口2：宿主的标题上限按字节剪尾巴，剪掉的若是 role，同队两个角色就会撞成同一个名字；不设标题会让它显示为工作区名，在侧边栏里认不出来）；想改随时在壳里重命名。`,
		// ★ 批 P · FR-P3 ①（US-P3）：**逐项列实际值**——「这次会继承什么、没继承什么、为什么」
		// 必须在人类动手**之前**就在框里读得到。三行由 {@link inheritanceRows} 一处渲染
		// （与 prepare 回执、交接文档事实段同源同字），这里不做任何二次措辞。
		"- 继承清单（批 P：从前任**自己存下的那一份**读；读得到的写值，读不到的逐项写原因）：",
		`  - ${state.inheritance.preset}`,
		`  - ${state.inheritance.model}`,
		`  - ${state.inheritance.approval}`,
		`- 模型 / 预设的缺省口径：§11.2 的两个入口都没有 model/provider 参数 ⇒ **只有读不到**的项才落宿主缺省——模型那一对由 \`agentDefaultModel.currentSelection()\` **解析并带上宿主缺省模型选择**（§10.2.2 模板第 ④ 步；缺了它继任者首回合报 prompt variable "{{model}}" has no value，真机缺陷 #3），preset 那一路的缺省同样解析并挂载（§10.2.2 模板；缺了它继任者首回合起不来，真机缺陷 #1）`,
		`- 保守成本口径：一个新根会话的完整生命周期成本（它自己的上下文与每个回合同样计价）+ 它上任后的第一个 /goal 回合；插件不为它设上限。`,
		`- 交班内容：交接文档（头部 + 事实段 + 交接正文，落盘 <workspace>/team/${state.teamName}/handoff-${state.roleName}-<时间戳>.md）、一次性令牌（30 分钟有效，投给新会话，此后一律掩码）、「立即 claim」指令。`,
		`- 信任面：令牌与冻结按 M4 原样走（§3.6.2）——信任迁移仍要继任者在 claim 时经确认框逐项勾选（无人值守则 provisional + 24h 回退），本次确认不迁移任何 pairs、不改任何信任数据。`,
		`- 选「${ROTATION_AUTO_CANCEL_LABEL}」= 什么都不做：零创建、零令牌、零 freeze。`,
	].join("\n");
}

/** The §11.4.1 confirmation itself. Fail-closed on every path that is not the
 * explicit 「创建并交班」 answer — that is what makes 取消 ⇒ 零副作用 a structural
 * property rather than something the caller remembers. */
async function askRotationAuto(ctx, agent, state, text, signal) {
	const userQuestions = ctx.get?.("userQuestions");
	if (userQuestions === undefined || userQuestions === null || typeof userQuestions.ask !== "function") {
		return { confirmed: false, reason: "确认服务（userQuestions）不可用——自动换届要新建会话并交班，无确认即不执行（fail-closed，§11.4.1）" };
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
				id: ROTATION_AUTO_DIALOG_ID,
				header: "自动换届确认",
				question: wellFormed(text),
				detail: `一次确认覆盖：新建会话 ${state.sessionId}、写交接文档、铸令牌与广播 rotation-freeze、把令牌与交接正文 followup 给新会话。`,
				options: [
					{ label: ROTATION_AUTO_CONFIRM_LABEL, description: `新建 1 个根会话并交班给 ${state.sessionId}（令牌 30 分钟有效；信任迁移仍要它在 claim 时逐项确认）` },
					{ label: ROTATION_AUTO_CANCEL_LABEL, description: "什么都不做：零创建、零令牌、零 freeze、零交接文档" },
				],
			}],
			agent,
			signal: controller.signal,
		});
		const item = Array.isArray(answer?.answers) ? answer.answers.find((entry) => entry?.id === ROTATION_AUTO_DIALOG_ID) : undefined;
		if (item === undefined || !Array.isArray(item.selected)) return { confirmed: false, reason: "确认框没有返回本次自动换届问题的答案" };
		if (!item.selected.includes(ROTATION_AUTO_CONFIRM_LABEL)) return { confirmed: false, reason: `用户在确认框里选择了「${item.selected.join("、") || "（未选择）"}」` };
		return { confirmed: true };
	} catch (error) {
		return { confirmed: false, reason: timedOut ? "确认框 3 分钟内未获确认（按取消处理）" : `确认框失败（${describeError(error)}）` };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener?.("abort", forward);
	}
}

/** §11.4.5's delivery body: the token (only here, only once), the claim call,
 * the document path and the whole hand-over body — driven with `followup`, never
 * `inject` (the task has to WAKE the successor). */
function handoffDeliveryMessage(state) {
	return [
		`【${PLUGIN_LABEL} 换届交接】你是团队 ${state.teamName} 的角色 ${state.roleName} 的继任者会话（旧任 ${state.previous}）。`,
		"",
		`① 一次性令牌（30 分钟内有效；明文只在本条出现这一次，此后一律掩码）：${state.token}`,
		`② 立即认领：调用 team_link_rotate action=claim，team=${state.teamName}，role=${state.roleName}，token=<上面那串>。`,
		"   认领时用户会看到一个逐项勾选的多选框（旧任 ↔ 同 team 成员的免确认通道）；无人值守或超时 → 全部以 provisional 迁移，24 小时内未批准自动回退。旧任的 pairs/trustedSenders/rememberTargets 会在 claim 里被对称吊销——这是 M4 的原样机制，自动化不跳过任何一步（§11.6）。",
		`③ 交接文档（审计与人类可读；team_link_team_read 刻意不呈现它，§11.4.3）：${state.documentPath}`,
		"④ 令牌 30 分钟内无人认领 ⇒ 本次换届自动取消、旧任仍为现任、冻结解除；你仍在盘上，可被收编或关闭（§11.5）。",
		"⑤ 上任后的第一个动作建议 /goal resume 或新建 goal（armed-active = 内建心跳，防静默；插件绝不代调 goals.resume，§3.7）。",
		"",
		"—— 以下为旧任提供的交接正文（五个硬节：" + handoffSectionsInline() + "；插件只把关结构——节在场 / 非空 / 有界——不把关内容质量，§11.9.6）——",
		"",
		state.body,
	].join("\n");
}

/**
 * §11.2's automatic entry point, step by step (§11.3 时序), with every side
 * effect behind the two gates the design names: the §11.9.6 ladder (which runs
 * BEFORE anything exists) and the §11.4.1 confirmation (fail-closed).
 *
 * The two failure rules of §11.5 are kept: a create that never settled keeps its
 * `pending-create` intent (so the startup sweep reports it as adoptable), and a
 * partial success is never rolled back — the session is reported, not deleted.
 *
 * @returns `{ lines }` or `{ error }`.
 */
async function autoHandover(deps, request) {
	const { ctx, policy, rotation, controller } = deps;
	const { teamName, roleName, note, handoff, caller, agent, signal, now } = request;
	const cwd = request.cwd;
	// ---- 1) the admission checks prepare would make, BEFORE any side effect ---
	const view = policy.get();
	const admission = prepareAdmission(view, { teamName, roleName, successor: undefined, now, caller, isLive: (id) => agentIsLive(ctx, id), ladderSuffix: recoveryLadderSuffix });
	if (admission.error !== undefined) return { error: `${admission.error}（successor:"auto"：闸门在创建之前先查，本次零建会话、零令牌、零 freeze。）` };
	if (typeof controller?.rootCtx?.agents?.create !== "function") {
		return { error: "prepare 失败：本宿主没有可用的 agents.create（编程创建会话不可用）——successor:\"auto\" 无法自建继任者，本次零创建。请退回手工路径：先在壳里新建会话，再把它的 id 作为 successor 传入（§3.6.4 的兜底始终保留）。" };
	}
	if (typeof cwd !== "string" || cwd === "" || !path.isAbsolute(cwd)) {
		return { error: `prepare 失败：无法确定新会话的工作目录（发起会话的 cwd = ${cwd === undefined || cwd === "" ? "（未捕获）" : cwd}）——会话边界会校验绝对路径（§10.2.6），本次零创建、零令牌、零 freeze。` };
	}
	// ---- 2) one confirmation, fail-closed (§11.4.1) --------------------------
	// The new id and the token are plain VALUES at this point — nothing durable,
	// nothing handed out. The confirmation below is what turns them into effects,
	// and the token exists this early only so the hand-over document can carry its
	// mask (§11.9.6 orders the document BEFORE the token is persisted/issued; the
	// manual path does the identical look-ahead in the tool layer).
	const sessionId = teamSessionId(teamName, roleName, () => randomUUID());
	const token = randomUUID();
	// DEFECT-4: the successor's default title is decided HERE, before the create, so
	// the confirmation box can name the title the user is about to get — the same
	// value the one creation path hands to `sessionTitle.rename` (one derivation,
	// two faces: the box and the rename).
	const successorTitle = teamSessionTitle({ team: teamName }, { role: roleName, sessionId });
	// 批 P（FR-P1 + FR-P3 + Pi4 + FR-P4 的可写面）：**一次采集**，在确认框**之前**——
	// ① 采集本身只读（读取器 + preset 可用性核对 + 审批档可写面探针，都不写任何状态）；
	// ② US-P3 要求「动手前就看见这次继承什么/没继承什么/为什么」，所以它必须在框之前；
	// ③ 采集**绝不抛**（读取器逐项 try/catch、两个探针各自折成具名原因），所以它放在
	//    既有的失败边界之外不改变任何失败语义。
	const inheritance = await collectInheritableSettings(ctx, admission.entry.current);
	const dialogState = { teamName, roleName, sessionId, cwd, title: successorTitle, inheritance: inheritance.rows };
	const dialog = await askRotationAuto(ctx, agent, dialogState, rotationAutoDialogText(dialogState), signal);
	if (!dialog.confirmed) {
		return { lines: [`未自动换届（successor:"auto"）：${dialog.reason}。本次零创建、零令牌、零 freeze、零交接文档——§11.4.1 的确认是必经之门。`] };
	}
	// ---- 3) the durable intent, written BEFORE the create (§11.5 / §10.2.6) ---
	try {
		await addTeamSessionPending(policy, { team: teamName, role: roleName, sessionId, createdAt: now, expiresAt: now + TEAM_SESSION_PENDING_TTL_MS, by: caller ?? "" });
		controller.pending.set(sessionId, { team: teamName, role: roleName, sessionId });
	} catch (error) {
		return { error: `prepare 失败：pending-create 意图写入失败（${describeError(error)}）——未创建（宁可不建，也不留一个没有意图记录的孤儿）。` };
	}
	// ---- 4) create from the PLUGIN ROOT ctx (§11.4.2 / §10.2.5) --------------
	// `team` rides the plan so the ONE creation path can derive the successor's
	// DEFECT-4 title (`<team> · <role>`) exactly as ② does — this plan is the
	// auto path's only plan, so a missing `team` here would silently push the
	// successor onto the id-prefix fallback instead of the shared rule.
	//
	// 批 P · FR-P2（D1/D3/D6）：preset / provider / model 三项由**前任自己存下的那一份**填
	// （`inheritance.values`，即确认框之前那次 {@link collectInheritableSettings} 的读数；读不到
	// 或不可解析的项是 `null` ⇒ `?? undefined` ⇒ 落宿主缺省，与修复前**逐字同行为**，NF-P3）。
	// **审批档不进 plan**（D6：`buildTeamSessionCreateOptions` 逐字不改）——FR-P4 在下面
	// 「创建返回之后」那一步设。采集绝不抛，所以它放在 `try` 之外不改变失败边界。
	const inherited = inheritance.values;
	let creation;
	try {
		creation = await createRootAgent(ctx, controller.rootCtx, { preset: inherited.preset ?? undefined, provider: inherited.provider ?? undefined, model: inherited.model ?? undefined, team: teamName }, { sessionId, role: roleName }, cwd);
	} catch (error) {
		return { error: `prepare 失败：继任者会话创建失败（${describeError(error)}）。未铸令牌、未广播 freeze；pending-create 意图保留，启动清扫会把它报进可收编清单（§11.5）。` };
	}
	const handle = creation.handle;
	controller.handles.set(sessionId, handle);
	// ---- 4b) FR-P4：审批档**在创建返回之后**设（探针 2 的结论；D6 不许它进 plan）------
	// 读不到 / 服务不在场 / 形状断层 ⇒ `attempted === false`，只走 FR-P3 的如实行（那一行已经
	// 在确认框、回执与交接文档里），**绝不因此拒绝创建**（NF-P3）。
	const approvalApplication = await applyInheritedApprovalPolicy(inherited, inheritance.writeFace, handle);
	// ---- 5) the hand-over document, BEFORE prepare (§11.9.6) ----------------
	// 评审 #4: the facts section is a READING, and the confirmation box above spans
	// an unbounded human wait — counts taken from `view` (read before the box opened)
	// would describe a store that may no longer exist at the instant the document
	// lands. Re-read once here, the same TOCTOU discipline the two recovery verbs
	// apply to the incumbent immediately before they write: the document then states
	// the counts of the store `prepare` is about to snapshot, and what is left
	// between the reading and the write is one synchronous step instead of a human
	// wait. WHICH rotation this document is about does not move: the retiree and the
	// successor stay the ones the header already names (`admission.entry.current` /
	// `sessionId`) — only the numbers are taken at the write instant.
	const factsView = policy.get();
	const factsTeam = factsView.teams.find((entry) => entry.name === teamName) ?? admission.team;
	const held = trustReferencesTo(factsView, admission.entry.current);
	const plan = planRotationMigration(factsView, { members: new Set(teamMembers(factsTeam)), retiree: admission.entry.current, successor: sessionId });
	const document = await writeHandoffDocument(admission.team, {
		roleName,
		previous: admission.entry.current,
		successor: sessionId,
		token,
		preparedAt: now,
		body: handoff.body,
		report: handoff.report,
		// 批 P · FR-P3 ③：交接文档事实段的**继承三行**（与确认框正文、prepare 回执同一份
		// `inheritance.rows`；交接文档是这份继承清单唯一落盘的出口，D5：不落 policy.json）。
		inheritance: inheritanceRowList(inheritance.rows),
		approvalApplication: approvalApplication.line,
		facts: rotationFactRows({
			retiree: admission.entry.current,
			successor: sessionId,
			candidates: plan.candidates,
			dropped: plan.dropped,
			removedCount: held.pairs.length,
			trustedSenderCount: held.trustedSenders.length,
			rememberTargetCount: held.rememberTargets.length,
		}),
	});
	if (document.ok !== true) {
		return { error: `prepare 失败（abort-before-prepare，§11.9.6）：交接文档写入失败（${document.error}）——不铸令牌、不广播 freeze。已建的继任者会话 ${sessionId} 保留并如实报为孤儿（§11.5 部分成功不回滚）：它已在盘上、可能已被打开；pending-create 意图保留，启动清扫会把它报进可收编清单。` };
	}
	// ---- 6) prepare: the published M4 mechanism, untouched (§11.4.4) ---------
	const prepared = await rotation.prepare({ teamName, roleName, successor: sessionId, note, caller, now, signal, token });
	if (prepared.error !== undefined) {
		return { error: `${prepared.error}（successor:"auto"：令牌从未落盘、从未投出，freeze 未广播；交接文档 ${document.path} 已写但本次换届不存在。已建的会话 ${sessionId} 保留并报为孤儿——pending-create 意图保留，启动清扫会把它报进可收编清单，§11.5。）` };
	}
	// ---- 7) the intent is resolved: this session IS the rotation's successor ---
	try {
		await removeTeamSessionPending(policy, sessionId);
	} catch (error) {
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: pending-create intent ${sessionId} could not be cleared after prepare (${describeError(error)}) — 启动清扫会把它报进可收编清单（换届本身已生效）`);
	}
	controller.pending.delete(sessionId);
	// ---- 8) drive it: followup, never inject (§11.4.5) ----------------------
	let delivered = true;
	let deliveryError;
	try {
		handle.agent.followup(relayUserMessage(handoffDeliveryMessage({ teamName, roleName, previous: admission.entry.current, token, documentPath: document.path, body: handoff.body }), caller));
	} catch (error) {
		delivered = false;
		deliveryError = describeError(error);
	}
	return {
		lines: [
			`自建继任者（successor:"auto"，§11.4.2）：${sessionId}（根会话——meta 只有 cwd=${cwd}，不含 origin/parentSession/delegationDepth/parentAgent；AgentHandle 由插件持有，§10.2.5 的生命周期代价同样适用：插件卸载/重载 = 它的代理随插件一起拆掉，会话仍在盘上）。`,
			// DEFECT-4：这一行是**读数**——`creation.title` 就是交给标题服务的那个值
			// （未设成时 undefined），不是拿 team/role 重算一遍。用户在侧边栏里看到的
			// 标题就是它，所以回执如实说，而不是让用户自己去发现它们全同名。
			creation.title === undefined
				? `标题（DEFECT-4）：本次**未设成**标题（原因见上文那一行 warn）——它会显示为宿主的默认标题（很可能是工作区名，在侧边栏里认不出来）。想改可在壳里手动重命名。`
				: `标题（DEFECT-4）：已命名为「${creation.title}」（按「<team> · <role>」派生；不设标题会让它显示为工作区名、与其他会话无法区分）。想改随时在壳里重命名。`,
			`交接文档（§11.4.3 / §11.9.6）：${document.path}（头部 + 事实段 + 你提供的正文；上一份：${document.previousDocument ?? "（无——本角色落盘的第一份）"}）`,
			// ★ 批 P · FR-P3 ②（prepare 回执）：与确认框正文、交接文档事实段**同一份三行**
			// （`inheritance.rows`，一处措辞）；审批档那一行再加一条**落地读数**（FR-P4 是在
			// 创建返回之后设的，回执必须如实说设成了没有 —— 不许只印一行「审批档=Z」）。
			"- 继承清单（批 P：逐项；值或未继承原因）：",
			...inheritanceRowList(inheritance.rows).map((row) => `  - ${row}`),
			...(approvalApplication.line === null ? [] : [`  - ${approvalApplication.line}`]),
			...handoff.warnings.map((line) => `正文校验：${line}`),
			delivered
				? `投递（§11.4.5）：已用 followup 把令牌与交接正文投给 ${sessionId}（不是 inject——任务需要驱动；消息 source 仍恰三成员 {kind, form, senderSessionId}）。`
				: `投递失败（${deliveryError}）：令牌已生效但继任者没收到——可把交接文档 ${document.path} 与令牌重新交给它，或等 30 分钟超时清扫取消本次换届（§11.5）。`,
			...prepared.lines,
			`§11.5 失败与孤儿：30 分钟内无人 claim ⇒ 既有清扫照常广播 rotation-cancelled（旧任仍为 current、冻结解除），并额外点名本次插件新建的会话 ${sessionId}；会话一律保留、不回滚，可收编或关闭。`,
		],
	};
}

/** The M4 rotate tool (§3.6.2), grown by §11.2's auto entry. Kept in its own
 * registrar because the two phases plus the automatic path are one mechanism. */
function registerRotationTools(ctx, policy, rotation, controller, sections = null) {
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_rotate",
		description: "团队换届（M4，两阶段）。action=prepare（Phase A，只能由该角色的现行会话发起）：生成一次性令牌（绑定 team+role+successor，30 分钟有效）、把待迁移的信任状态快照进 rotationBackup（撤销依据）、向全队广播 rotation-freeze 固定冻结清单，并返回交接指引（令牌只在这里出现一次，此后一律掩码 tok-xxxx…yyyy）。prepare 的 successor 可以写 \"auto\"（§11.2）：插件自建一个根会话当继任者、把 handoff 正文写成 <workspace>/team/<name>/handoff-<role>-<时间戳>.md（头部 + 事实段 + 正文，§11.9.6），再铸令牌并用 followup 把令牌与交接正文投给继任者（不是 inject）；auto 需要 handoff 正文，硬节用这几个标题：" + handoffSectionsInline() + "，缺硬节或正文为空一律拒绝于工具入口（零建会话、零令牌、零 freeze），且创建会话+交班前必过一次确认框（无确认服务 → fail-closed）。action=claim（Phase B，只能由 pending 指定的继任者会话凭令牌发起）：单个确认对话框列出全部「退役者↔同 team 成员」的 pairs 供逐项勾选（无人值守/超时/无确认服务 → 全部以 provisional 迁移，24h 内未批准自动回退；⚠️ 超时**不是失败**：若调用方在对话框等待期间超时或被中止，无人值守分支**已经落盘**（换届成立、旧任信任已对称吊销），读数会按该分支如实报告后果、到期时刻与批准路径（谁批、在哪批），重试不会撤销它，也不必重试）；迁移成功后对称吊销退役者的 pairs/trustedSenders/rememberTargets，落定 roster（current=新任、版本史追加），广播 rotation-done，并清除 pending。令牌过期未认领由过期清扫自动取消（广播 rotation-cancelled，旧任仍为 current，解除冻结；auto 自建的继任者会被额外点名）。域限定：团队外的 pairs 与未勾选的 pairs 一律随退役清理、不迁移；claim 幂等（同一令牌重放返回既有迁移清单、不重复迁移，判据是 current 已是继任者——域内没有候选 pair 时迁移清单本就是空的，同样走重放）。10 分钟速率限制防换届风暴。",
		parameters: {
			action: { type: "string", required: true, enum: ["prepare", "claim"], description: "prepare（Phase A：现任发起，出令牌 + 广播冻结）/ claim（Phase B：继任者凭令牌认领）" },
			team: { type: "string", required: true, description: "团队名（[a-z0-9-]+，须已在 roster 中）" },
			role: { type: "string", required: true, description: "要换届的角色名（约定角色名 coordinator）" },
			successor: { type: "string", description: "prepare 必填：继任者会话 id，或 \"auto\" 让插件自建一个根会话（令牌绑定 (team, role, successor) 三元组；须由该会话自己 claim）" },
			token: { type: "string", description: "claim 必填：prepare 返回的一次性令牌（掩码形式 tok-xxxx…yyyy 不是令牌）" },
			note: { type: "string", description: "写入版本史的备注（记在旧任任期的 until 记录上）；prepare 时给出则随 pending 保存，claim 时可直接覆盖" },
			handoff: { type: "string", description: "prepare 可选：交接正文（Markdown）。五个硬节各以一个标题开头：" + handoffSectionsInline() + "（软节 " + HANDOFF_SOFT_SECTIONS.join(" / ") + " 缺了只警告）。successor:\"auto\" 时必须给（空正文或硬节缺/空 → 拒绝于工具入口，零建会话零令牌零 freeze）；显式 successor 时可选，给了就写入交接文档，缺了只警告。插件只把关结构（节在场 / 非空 / 有界），不把关内容质量（§11.9.6）。" },
		},
		output: textOutput(),
		// The claim dialog may legitimately wait ROTATION_CONFIRM_TIMEOUT_MS (3min)
		// for a present user; the tool timeout has to sit above it.
		timeoutMs: 300000,
		async execute(args, exec) {
			try {
				const action = typeof args.action === "string" ? args.action : "";
				if (!ROTATION_ACTIONS.has(action)) return "操作失败：action 必须是 prepare 或 claim。";
				const name = readTeamName(args.team);
				if (name.error !== undefined) return wellFormed(`换届失败：${name.error}`);
				const role = readRoleName(args.role);
				if (role.error !== undefined) return wellFormed(`换届失败：${role.error}`);
				const caller = agentSessionId(exec);
				const now = Date.now();
				// The lazy half of the expiry sweep (§3.6.2 评审 #4). A claim excludes its
				// own team+role so that an expired token still gets its specific refusal
				// (and its cancellation) from the claim path below.
				const swept = await rotation.sweep({
					now,
					signal: exec.signal,
					// A claim must not sweep AWAY the very pending it is about to
					// validate: that one is handled (and reported specifically) by claim.
					except: action === "claim" ? { team: name.value, role: role.value } : null,
				});
				const preamble = swept.lines.length === 0 ? [] : ["换届过期清扫（本次调用触发）：", ...swept.lines, ""];
				const note = readNote(args.note);
				if (action === "prepare") {
					if (args.successor === undefined || args.successor === null || args.successor === "") {
						return wellFormed("prepare 失败：需要 successor（继任者会话 id，或 \"auto\" 让插件自建）——令牌绑定三元组 (team, role, successor)，没有继任者就无法换届（§3.6.1 原则 1）。successor:\"auto\"（§11.2）会自建一个根会话并自动交接（需要 handoff 正文）。§3.6.4 的半自动兜底始终保留：先在壳里打开/创建一个继任者会话，再把它的事务 id 传进来；令牌随交接 prompt 交给该会话。只想让角色空出来请用 team_link_roster action=retire。");
					}
					const auto = typeof args.successor === "string" && args.successor.trim() === ROTATION_AUTO;
					// §11.9.6's ladder runs FIRST — before the create, the token and the
					// freeze — so a refusal here is provably zero-side-effect.
					const handoff = readHandoffArgument(args.handoff, { auto });
					if (handoff.error !== undefined) return wellFormed(handoff.error);
					if (auto) {
						const outcome = await autoHandover({ ctx, policy, rotation, controller }, {
							teamName: name.value,
							roleName: role.value,
							note,
							handoff,
							caller,
							// The CALLER's workspace, never `process.cwd()`: a successor created in
							// the host process's own directory would be in the wrong workspace, so
							// an uncaptured cwd refuses instead (§10.2.6's absolute-path boundary).
							cwd: exec.agent?.session?.header?.cwd,
							agent: exec.agent,
							signal: exec.signal,
							now,
						});
						if (outcome.error !== undefined) return wellFormed(outcome.error);
						return wellFormed([...preamble, ...outcome.lines].join("\n"));
					}
					const successor = readSessionId(args.successor);
					if (successor.error !== undefined) return wellFormed(`prepare 失败：${successor.error}`);
					// The token is minted HERE, one step before prepare, because the
					// hand-over document's header carries its mask and the document is
					// written before the pending exists (§11.9.6). Nothing of it becomes
					// durable or visible unless this call reaches prepare.
					const token = randomUUID();
					const notes = [];
					if (handoff.body !== "") {
						const view = policy.get();
						const admission = prepareAdmission(view, { teamName: name.value, roleName: role.value, successor: successor.value, now, caller, ladderSuffix: recoveryLadderSuffix });
						if (admission.error !== undefined) {
							// §11.9.3: the refusal above is the one that names the incumbent,
							// so a seated-dead incumbent has to be diagnosed here — the words
							// "只有现任 X 可以发起换届" are TRUE and still MISLEADING when X
							// cannot be woken.
							const team = view.teams.find((candidate) => candidate.name === name.value) ?? null;
							const gate = withLiveGateDiagnostic(ctx, team === null ? null : roleOf(team, role.value), { error: admission.error });
							return wellFormed(gate.error);
						}
						const held = trustReferencesTo(policy.get(), admission.entry.current);
						const plan = planRotationMigration(policy.get(), { members: new Set(teamMembers(admission.team)), retiree: admission.entry.current, successor: successor.value });
						const document = await writeHandoffDocument(admission.team, {
							roleName: role.value,
							previous: admission.entry.current,
							successor: successor.value,
							token,
							preparedAt: now,
							body: handoff.body,
							report: handoff.report,
							facts: rotationFactRows({
								retiree: admission.entry.current,
								successor: successor.value,
								candidates: plan.candidates,
								dropped: plan.dropped,
								removedCount: held.pairs.length,
								trustedSenderCount: held.trustedSenders.length,
								rememberTargetCount: held.rememberTargets.length,
							}),
						});
						notes.push(document.ok
							? `交接文档（§11.4.3）：${document.path}（上一份：${document.previousDocument ?? "（无——本角色落盘的第一份）"}）`
							: `（注意：交接文档写入失败——${document.error}。本次换届照常进行：§11.9.6 的 abort-before-prepare 只对 successor:"auto" 生效，显式 successor 的会话有自己的生命与上下文。）`);
					}
					notes.push(...handoff.warnings.map((line) => `正文校验：${line}`));
					const result = await rotation.prepare({ teamName: name.value, roleName: role.value, successor: successor.value, note, caller, now, signal: exec.signal, token });
					if (result.error !== undefined) return wellFormed(result.error);
					return wellFormed([...preamble, ...result.lines, ...notes].join("\n"));
				}
				const token = readRotationToken(args.token);
				if (token.error !== undefined) return wellFormed(`claim 失败：${token.error}`);
				const result = await rotation.claim({ teamName: name.value, roleName: role.value, token: token.value, note, caller, now, signal: exec.signal, agent: exec.agent });
				if (result.error !== undefined) return wellFormed(result.error);
				return wellFormed([...preamble, ...result.lines].join("\n"));
			} catch (error) {
				return wellFormed(`换届操作失败：${describeError(error)}`);
			}
		},
	})), "team-link: rotate tool");
}



/** Phase A token lifetime (§3.6.2): a prepared hand-over must be claimed inside
 * this window, otherwise the sweep cancels it and releases the team freeze. */

// ---------------------------------------------------------------------------
// §10.2 ② /team_session — one command, N worker root sessions, one roster write
// ---------------------------------------------------------------------------

/**
 * Slash-command name of §10.2.1 (without the leading slash). The command is
 * registered through the OPTIONAL ordered injection of the `commands` service
 * (§10.2.1): this plugin's module-level `inject` stays at its four entries, and
 * a shell without that service loads the plugin unchanged — minus this one
 * command — with a single warn line.
 */
const TEAM_SESSION_COMMAND = "team_session";
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
const TEAM_SESSION_MAX_CREATES = 8;
/** §10.2.4 per-team member ceiling (≤ 24), also a code constant — the same
 * number the §10.1.2 receipt caps its rendered rows at. */
const TEAM_SESSION_MAX_MEMBERS = 24;
/** How long the one batch confirmation waits for a present user before the
 * command gives up and creates NOTHING (§10.2.4 / U16: 取消 → 零创建零 pairs). */
const TEAM_SESSION_CONFIRM_TIMEOUT_MS = 180000;
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
const TEAM_SESSION_DIALOG_MAX_CODE_POINTS = 600;
const TEAM_SESSION_DIALOG_MAX_NEWLINES = 12;
/** §10.2.8.4 修法表**第 0 行**的第二个预算：确认框 `question` 的**单行**上限（码点）。
 * 依据是壳的布局、不是偏好 —— `question` 被渲进**无高度钳制的 `<header><h2>`**（在滚动容器
 * **之外**），而 `detail` 在 `Mbwy4a_body{overflow-y:auto}` **之内**、底栏 `flex-shrink:0` 也在
 * 滚动区外 ⇒ 长 `question` 推出视野的正是底部的「创建 / 取消」（真机事实：§10.2.8.0 的 8 次
 * 够不着）。所以 question 只留一行话，披露正文整段进 detail。 */
const TEAM_SESSION_DIALOG_MAX_QUESTION_POINTS = 120;
/** §10.2.8.4 (b): session-list rows shown before 「…等 N 个」. The FULL count is always
 * stated — the U13/U14 bounded-presentation convention. */
const TEAM_SESSION_DIALOG_LIST_ROWS = 3;
/** §10.2.8.4 (b): 「**不逐角色展开**：只给 **id 形状 ＋ 计数**，全量清单进完成回报」.
 * This is the CONSTANT half of {@link teamSessionId}'s grammar — ONE stem for the whole
 * batch, so it costs the dialog the same few code points for EVERY input while still
 * telling the reader which ids the confirmation is about; the per-role id list itself is
 * the completion report's job (`command/done`). */
const TEAM_SESSION_ID_SHAPE = "team-link-<team>-<role>-<uuid8>";
/** §10.2.8.4 (a): how much of the startup task the dialog previews, in code points.
 * The preview line also carries the annotation that says the full text will be
 * delivered regardless ({@link teamSessionTaskNote}). */
const TEAM_SESSION_DIALOG_TASK_CHARS = 32;
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
const TEAM_SESSION_DIALOG_FIELD_CHARS = { team: 32, cwd: 24, id: 28, role: 8, skipped: 16, title: 40, model: 40, provider: 24, preset: 24 };
/** §10.2.8.7 裁定 2: the role-semantics line the DIALOG and the COMPLETION REPORT each
 * carry. It exists because the defect-③ dialog was unreadable, so the sentence that
 * answered 「为什么新会话显示是 worker」 was never seen; it is one line on purpose and
 * it is inside {@link TEAM_SESSION_DIALOG_MAX_CODE_POINTS}. */
const TEAM_SESSION_ROLE_GUIDANCE = "新会话是 worker；你自己（调用会话）是 coordinator；要交棒请用 team_link_rotate。";
/** Question id of the batch dialog — the answer is matched by id, not order. */
const TEAM_SESSION_DIALOG_ID = "team-session-batch";
/** The one option label that authorizes the batch (§10.3: 批量动作必须有一处人类确认). */
const TEAM_SESSION_CONFIRM_LABEL = "创建";
/** §10.2.6 orphan guard: how long a `pending-creates` intent may sit unresolved
 * before the startup sweep reports it as adoptable (the create crashed, or the
 * plugin was unloaded mid-loop). */
const TEAM_SESSION_PENDING_TTL_MS = 5 * 60000;
/** The `model` argument's grammar: `model=<provider>/<model>` or bare `model=<model>`. */
const TEAM_SESSION_MODEL_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.:-]+)$/u;
/** Session-id code points outside this class are dropped, so an id can never
 * carry a lone surrogate or a control character into the durable session id. */
const TEAM_SESSION_ID_ILLEGAL = /[^A-Za-z0-9_-]/gu;
/** Session-id suffix length (8 hex characters of one random UUID). */
const TEAM_SESSION_ID_SUFFIX = 8;

/**
 * Live §10.2 ② controller of each plugin context. `apply` is the only writer;
 * `host-half.test.mjs` reads it (through {@link __testing}) so the command's
 * per-context intent bookkeeping is reachable without poking closure state.
 */
const TEAM_SESSION_BY_CTX = new WeakMap();

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
function readTeamSessionCommand(rawInput) {
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
function teamSessionInjectNow(now) {
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
function teamSessionDefaultTeam(cwd, now) {
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
const TEAM_SESSION_RELEASE_NOTES = {
	archived: "released: coordinator archived",
	gone: "released: coordinator gone",
};

/** §10.2.8.9 ②'s release disclosure, folded into the dialog's 「确认则」 line. The
 * design pins this exact short form and calls it 「12 码点」; 逐字数是 **11**
 * （（将释放并接管原团队）—— 计数笔误已记入交付报告，判据按字面量钉 11、以 12 为口径上界）。
 * The longer wordings (21+ code points) break the U33c budget, and a line of its own
 * breaks the ≤6-line bound — so the SHAPE is 「同一个 11 码点短句，折在 pairs 之后」. */
const TEAM_SESSION_RELEASE_DISCLOSURE = "（将释放并接管原团队）";

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
async function teamSessionReleaseVerdict(ctx, incumbent) {
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
function applyTeamSessionRelease(team, caller, reason, now) {
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
function teamSessionPlan(request, existingRoles = [], now = Date.now(), uuid = () => randomUUID()) {
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
function teamSessionId(team, role, uuid) {
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
function teamSessionTitle(plan, entry) {
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
function teamSessionDialogText(plan, cwd, coordinatorId, release = null) {
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
function teamSessionDialogQuestion(plan) {
	const cap = TEAM_SESSION_DIALOG_FIELD_CHARS;
	return dialogField(`确认创建 ${plan.creating.length} 个 worker 会话并登记进团队 ${dialogField(plan.team, cap.team)}？`, TEAM_SESSION_DIALOG_MAX_QUESTION_POINTS);
}

/** Code points of `text` — never UTF-16 units, because a cut must not split a
 * surrogate pair (the same rule {@link preview} and {@link truncate} follow). */
function dialogCodePoints(text) {
	return [...String(text ?? "")].length;
}

/** `text` with every whitespace run collapsed to one space: the dialog's fields are
 * ONE line each, so a pasted document's newlines cannot spend the newline budget. */
function dialogFlatten(text) {
	return String(text ?? "").replace(/\s+/gu, " ").trim();
}

/** A dialog field: flattened, then cut to `limit` code points with an ellipsis. */
function dialogField(text, limit) {
	const flat = dialogFlatten(text);
	const chars = [...flat];
	return chars.length <= limit ? flat : `${chars.slice(0, limit - 1).join("")}…`;
}

/** §10.2.8.4 (b): BOTH budgets, in one predicate — code points and newlines. */
function dialogFits(text) {
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
const TEAM_SESSION_DIALOG_CROP_NOTE_FULL = (dropped) => `（已省略 ${dropped} 段自述；必备披露一字未少。）`;
const TEAM_SESSION_DIALOG_CROP_NOTE_MINIMAL = (dropped) => `（已省略 ${dropped} 段自述）`;
/** 档位按**从宽到窄**排列：{@link teamSessionDialogText} 的终态构造取**第一个**装得进
 * `dialogFits` 的档；两档都装不下时交付**最后（最窄）那一档** —— 那是「如实标注的受限超额」，
 * 只能由**不可裁的必备 body** 引起（机制一残余，见设计档 §10.2.8.4 的残余行）。
 *
 * **触发面为空（2026-09-22 裁定 A，逐条可复核）**：这两档只在 `dropped > 0` 时被取用，而裁定 A
 * 把框里唯一的 `required: false` 段（「会话标题」）整段移了出去 ⇒ 现在没有任何一条路径会取用它们。
 * 用户裁定里的「不许动：…两档标注与终态预算机制」按**代码原样保留**执行（不改一个字符），并且
 * 它们在 `host-half.test.mjs` 里仍有一份**纯函数**判据（档位常量各自的长度与「不含自证矛盾句」）；
 * 一旦某段自述回到框里，取用路径立刻恢复。 */
const TEAM_SESSION_DIALOG_CROP_NOTE_TIERS = [TEAM_SESSION_DIALOG_CROP_NOTE_FULL, TEAM_SESSION_DIALOG_CROP_NOTE_MINIMAL];

/** One tier of the crop annotation (§10.2.8.4 (b): 超出即按段落裁剪并标注). It names what was
 * kept, so a reader of a cropped box knows the disclosure is intact — and its length is a
 * function of the ACTUAL `dropped` count rather than a constant. */
function teamSessionDialogCropNote(dropped, tier = TEAM_SESSION_DIALOG_CROP_NOTE_FULL) {
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
function teamSessionTaskNote(task) {
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
function teamSessionModelLine(plan) {
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

// ---------------------------------------------------------------------------
// §10.2.2/§10.2.3/§10.2.4/§10.2.6 + 批 P 继承 —— 定义已搬进 `lib/team-session-creation.js`（批 R 第 14 小单）
// ---------------------------------------------------------------------------
//
// ★ 这一整块（入口原 6,519–7,351 行：批量建队的 pairs / 角色行 / 启动任务助手 · 批量确认框 · 创建循环
//   `createTeamSessions` · §10.2.2 的唯一创建落点 `createRootAgent` 与工作区挂载/回滚/命名 · 批 P 的
//   三个继承读面与「值 / 未继承（原因：…）」的唯一措辞源）**逐字节**搬进 `lib/team-session-creation.js`
//   （那一档的档头给归属、依赖方向、被钉符号核对与搬迁纪律）。本档按名导入同一份实现，模块尾部那条
//   `wireTeamSessionCreation(teamSessionCreationExtras())` 给它注入 11 条入口侧出口（被钉的
//   `buildTeamSessionCreateOptions` 也在那张表里，**只注入不搬**）。
// ★ 仍留在下面的同域块（下一小单）：§10.2 的命令文法常量与 `readTeamSessionCommand` · 计划与渲染族
//   （`teamSessionPlan` / `teamSessionTitle` / `teamSessionDialogText` / `teamSessionDialogQuestion`）·
//   `buildTeamSessionCreateOptions` / `buildTeamSessionResumeOptions` / `resolveTeamSessionModelSelection` ·
//   `relayUserMessage` / `registerTeamSessionRoles` / 回执与 `registerTeamSessionCommand`。
// ---------------------------------------------------------------------------

/**
 * §10.2.2: the create options, verbatim. `meta` carries cwd and agentPreset and
 * NOTHING else — `origin` / `parentSession` / `delegationDepth` / `parentAgent`
 * stay unwritten, because `undefined` is the only legal non-subagent value of
 * `origin` and omitting `parentAgent` is what makes the session a ROOT session
 * (U18; §10.3 forbids marking these sessions as subagents).
 *
 * DEFECT-1 (真机缺陷 #1): the preset is resolved for EVERY creation, not only
 * when the caller passed `preset=`. The `dsh-webhook` template this section
 * copies resolves one unconditionally — `resolve(undefined)` answers the host's
 * own `defaultId` — and mounts it inside `setup`. Skipping that path when no
 * `preset=` was given left the new agent with NO persona-prefix assembly source
 * at all, so the session was created and then could not run a single turn:
 * `prompt variable "{{model}}" has no value for this assembly (section
 * "deployment:persona-prefix")`. 「会建」 ≠ 「能用」: the mount is what makes the
 * agent runnable, and this is the ONE creation path both §10.2 ② and §11.2's
 * `successor:"auto"` go through.
 *
 * The ONLY branch that may skip the preset face is the ABSENCE of the optional
 * `agentPresets` service — and it is never silent: one warn names what is
 * missing and what it costs. A service that IS there and rejects (unknown id, a
 * composition that will not mount) is a real failure and propagates: the batch
 * reports it and no session is created, because a session with no composition
 * source is the defect, not a degraded success.
 *
 * 异步是必需的：`meta.agentPreset` 必须在 `agents.create` **之前**就拿到真实
 * preset id（模板的顺序），而缺省解析只能问服务（`resolve(undefined)`）。
 *
 * DEFECT-3 (真机缺陷 #3): 同一个模板动作序列里还有**另一件**「缺省也要做」的事——
 * `resolveRequest` 在调用方**任一侧**没给（只给了 model，或只给了 provider）时也解析宿主的
 * 缺省模型选择，**缺的那一半**由它补齐，整对写进 `agentOptions` 并装成 `setup` 里的初始
 * 模型选择（{@link resolveTeamSessionModelSelection}）。
 * DEFECT-1 只补了「装配源」（preset 的 resolve + mount），**没补那个变量的值**：没有
 * `agentOptions` 的 agent 走不到宿主的缺省，`{{model}}` 于是无值，首回合照样起不来。
 * 「会建」≠「能用」在同一个函数上出现过两次，所以这两件事现在都在这里，且都有断言钉住。
 *
 * `cwd` 由 {@link createRootAgent} 传入：模板 `:103` 的取值是
 * `workspace.path`（registry 归一化后的路径），只在 workspace 服务缺席时才回落
 * 到调用方 cwd——attach 时会话边界拿的是同一个归一化路径。
 */
async function buildTeamSessionCreateOptions(ctx, plan, entry, cwd) {
	// DEFECT-3 的模型选择解析（模板 `resolveRequest` 的 if 分支，`dsh-webhook:30-36`，
	// 含 2026-09-20 收尾裁定）：调用方**任一侧**没给（只给 `model=`，或只给了 provider）
	// 时**也**解析宿主的缺省模型选择，**缺的那一半**由它补齐，并把**同一份** selection
	// 一路带到 `setup`（模板第 9 步）。原来的形状是「两侧都没给才解析，否则原样照抄」
	// ⇒ 只给一半的调用方拿到的是残缺的一对（`agentOptions = {model}`），编程创建的 agent
	// 于是没有任何可运行的模型选择 ⇒ `{{model}}`（`dsh-agent-loop` 的
	// `ctx.systemPrompt.variable("model", (context) => context.agent?.options.model)`）
	// 无值，首回合死在 `prompt variable "{{model}}" has no value`——真机缺陷 #3，
	// 以及同一缺陷类的「半条路由」（`model=X` 而漏写 `provider=` 的人类用户）。
	const modelSelection = resolveTeamSessionModelSelection(ctx, plan, entry.sessionId);
	const agentOptions = { provider: modelSelection.provider, model: modelSelection.model };
	// The optional service is read ONCE and the SAME instance is what `setup`
	// mounts through: a second read would be a second place where the mounted
	// composition can silently diverge from the id written into `meta`.
	const agentPresets = ctx.get?.("agentPresets");
	let presetId;
	/** 现宿主那一代取的 preset 租约（可释放句柄）；0.1.x 一代没有它，保持 null。 */
	let releasePresetScope = null;
	// 组成面**两个方法缺一不可**：`resolve` 取身份、`mount` 把组成装进 agent scope。旧守卫只判
	// `resolve` 就在 `setup` 里裸调 `mount` ⇒ 宿主某代再改 `mount` 的名字时，用户看到的会是裸
	// `TypeError: agentPresets.mount is not a function` 当错误文案 —— 正是 0.4.2 那次
	// `standingKeyFor` 换代真机两次翻车的原文形状。所以形状断层在这里**显式点名**，
	// 且与复活面（{@link buildTeamSessionResumeOptions}）用同一条判据。
	const presetFacePresent = agentPresets !== undefined && agentPresets !== null;
	if (presetFacePresent && (typeof agentPresets.resolve !== "function" || typeof agentPresets.mount !== "function")) {
		throw new Error(`agentPresets 服务在场，但组成面形状断层（resolve=${typeof agentPresets.resolve}, mount=${typeof agentPresets.mount}）——本插件创建与复活两面都靠 resolve → mount 这一对，缺任一个都组装不出 persona-prefix 的组装源。拒绝创建：宁可不建，也不建一个没有组装源的会话（真机缺陷 #1 的形状）；请核对宿主的 preset 服务形状（0.4.2 记过 standingKeyFor → acquireScope 那一类换代）。`);
	}
	if (presetFacePresent) {
		const preset = await agentPresets.resolve(plan.preset);
		// 宿主换代（DSH 0.2.0-rc.1，真机 2026-09-29）：pin preset 的方法由
		// `standingKeyFor` 改为 `acquireScope`。**这不是纯改名**：注册面自己的文档写着
		// 「A revision lease; dispose it after the scoped read completes」，实现是
		// `retain(id)` ＋ 一个 `[Symbol.asyncDispose]` 句柄（`users--` ＋ `collect()`）
		// ⇒ **取到的租约必须释放**，否则该 generation 的 `users` 永不归零、永不被回收
		// （每建一个会话泄一个）。官方模板 `dsh-webhook` 的时序是 `await using` 在
		// create 期间持有、在 `finally` 释放（`lib/index.js:158` / `:216`）——本插件照
		// 同一时序，但 create 在**调用方**，所以这里只**取**，把释放交给
		// `createRootAgent`（经 options 上那个 Symbol 通道带过去）。
		// 两代都在场时**优先现名**；只有旧名时回退旧名（0.1.x 宿主，返回纯值、无句柄
		// ⇒ 刻意不造一个假的 dispose）；两个都没有 ⇒ 显式点名断层，而不是让裸
		// TypeError「agentPresets.standingKeyFor is not a function」当错误文案
		// （真机 2026-09-29 15:35 / 15:46 两次 `/team_session` 失败的原文）。
		if (typeof agentPresets.acquireScope === "function") {
			const scope = await agentPresets.acquireScope(preset.id);
			const dispose = scope === null || scope === undefined ? undefined : scope[Symbol.asyncDispose];
			if (typeof dispose === "function") releasePresetScope = async () => { await dispose.call(scope); };
		} else if (typeof agentPresets.standingKeyFor === "function") {
			await agentPresets.standingKeyFor(preset.id);
		} else {
			throw new Error("agentPresets 服务既没有 acquireScope（DSH 0.2.0-rc.1 一代）也没有 standingKeyFor（0.1.x 一代）——宿主的 preset pin API 与本插件已知的两代模板形状都断层，拒绝创建没有 standing preset 绑定的会话");
		}
		presetId = preset.id;
	} else {
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: agentPresets service unavailable — 新会话 ${entry.sessionId} 既未解析也未挂载 preset：它没有 persona-prefix 的组装源，首回合可能因此起不来（真机缺陷 #1）。会话照常创建，若它跑不起来请检查宿主的 agentPresets 服务。`);
	}
	const options = {
		sessionId: entry.sessionId,
		meta: { cwd, ...(presetId === undefined ? {} : { agentPreset: presetId }) },
		// 无条件传（与模板 `dsh-webhook:106` 的 `agentOptions: resolved.agentOptions,`
		// 逐字同一形状）。收尾裁定 3：`agentOptions` 现在**永远**带着一对非空
		// provider/model（上一步已解析/补齐），所以原来那个
		// 「空对象就不传」的条件分支**不可达**——留着它只会让人以为这里还有一条
		// 「无模型选择」的路。
		agentOptions,
		setup: async (agentCtx) => {
			// Unconditional whenever a preset was resolved — the 「有才挂」 shape
			// (a second chance to skip the mount) is what DEFECT-1 was.
			if (presetId !== undefined) await agentPresets.mount(agentCtx, presetId);
			installTeamSessionModelSelection(agentCtx, modelSelection);
		},
	};
	// 租约经 Symbol 带外传给调用方：对宿主 `agents.create` 不可见（它只读具名键），
	// 对 `Object.keys` / 对象展开 / `JSON.stringify` 同样不可见 ⇒ options 的**可见
	// 形状**与既有断言一字不变，而「释放」这件事有了确定落点。
	if (releasePresetScope !== null) options[PRESET_SCOPE_RELEASE] = releasePresetScope;
	return options;
}

/**
 * §11.9.4 L1 的 **resume 面**：复活一个盘上已存在的会话时，必须走与 create 面**同一条**
 * 「能跑起来」的组装时序 —— 真机缺陷 #5（2026-09-30）。
 *
 * 真机现象：`team_link_recover action=revive` 之后，那个 worker 的**第一回合**逐字报
 * `prompt variable "{{model}}" has no value for this assembly (section
 * "deployment:persona-prefix")`（团队 `mal-analyze-cli-20260929` 的 worker-1..4，
 * 2026-09-30 12:50:54/55，四条日志；未被 revive 过的 worker 零命中）。根因与
 * {@link buildTeamSessionCreateOptions} 修掉的 DEFECT-1 / DEFECT-3 是**同一个缺陷类，
 * 只是换了一条路径**：那一轮把修复全部落在 `agents.create` 上，而 revive 走的是
 * `agents.resume` —— 只传了 `resumeSessionId` 一个键：
 *
 *   - **没有 `agentOptions`** ⇒ 复活出来的 agent **没有任何模型选择**（宿主
 *     `dsh-agent-loop:1970` 是 `options.agentOptions ?? {}`），而 `{{model}}` 的唯一来源
 *     就是 `context.agent?.options.model`（同档 `:1565`）⇒ 首回合死在 persona-prefix 上
 *     （DEFECT-3 的机制在这里原样复现，连错误文案都逐字相同）；
 *   - **没有 `setup`** ⇒ preset **组装源没挂**，而 `standard` preset 正是这具 agent 的
 *     **工具面**（`dsh-web-app/presets/standard.patch.yml`：bash / pwsh / fs / jobs /
 *     skill / goal / plan-mode / compaction / delegation / web 全在组成里）⇒ 就算模型那一关
 *     过了，复活出来的 worker 也拿不回它自己的工具面（DEFECT-1 的机制）。
 *
 * 参照物是宿主**自己**的 resume（`dsh-api-session-controller:399-410`，也就是人在侧边栏
 * 打开一个会话时走的那条路）：`resumeSessionId` + `agentOptions: {provider, model} =
 * agentDefaultModel.currentSelection()` + `setup: composeAgent(presetForObservation(obs)).setup`
 * （**存下来的** preset → `agentPresets.mount`）。本函数就是这三样的插件版，逐条对齐：
 *
 * ① **模型选择**用与 create 面**同一个**解析器（{@link resolveTeamSessionModelSelection}）——
 *    复活面没有调用方可以给 model，所以永远是「两侧都没给」那一支：解析不出来就**拒绝**
 *    （fail-closed，与 create 面同口径：宁可不复活，也不复活一个跑不起来的代理）。
 *    **一处有意的偏差（如实声明）**：宿主自己那条路把「会话上次用的模型」装在 selection 的
 *    取值器里（`selectionFor` 先读持久化的 request header）；本插件没有「每会话模型」这个概念，
 *    这里与 create 面一致地取**当时的缺省**。复活后若缺省已变，模型会跟着缺省走——人设文本与
 *    实际路由仍然一致，这也是本插件在创建时就有的一贯语义。
 * ② **preset** 取**这个会话自己存下来的那一个**（`agent.session.header.agentPreset`：宿主
 *    resume 的 `meta` 就是 `structuredClone(handle.header)`，所以 setup 里读到的就是盘上那份）；
 *    读不到（老会话 / 手工会话）⇒ 显式传 `undefined` 交给 `resolve` 按宿主缺省解析——与 create
 *    面「缺省也解析」同一条口径，**不是**「读不到就干脆不挂」（那正是 DEFECT-1 的形状）。
 *    解析不出来的存量 id ⇒ **显式抛错**（`agent-presets/not-found` 会经 resume 回传），绝不静默
 *    降级成另一支组成源：一个顶着旧名字、跑着别的工具面的会话比一次可读的失败更难查。
 *    服务缺席是可服务降级：**每个复活的会话恰一行 warn**、点名它没有 persona-prefix 组装源，
 *    复活照常（与 create 面同一句口径）。
 * ③ **模型选择的安装**与 create 面同一个钩子（{@link installTeamSessionModelSelection}），挂在
 *    这具 agent **自己的** setup 上下文上。
 *
 * 为什么这里**不取** preset 租约（`acquireScope`）：那是 `dsh-webhook` **create** 时序的一环
 * （解析在前、`create` 在后，中间的窗口需要把该 generation 钉住）。resume 的参照物
 * （宿主的 `composeAgent`）不取租约——`mount` 自己 `retain` → `bind` → 释放，窗口内不会漏。
 * 照抄 create 的租约反而要为一个「谁在什么时候还」再造一处状态。
 *
 * @throws 模型选择解析不出来时（{@link resolveTeamSessionModelSelection}），或存量 preset
 *   解析不出来时（在 `setup` 里由 `agents.resume` 回传）。
 */
async function buildTeamSessionResumeOptions(ctx, sessionId) {
	// `face = "resume"`：同一条解析器，但判词与出路按复活面取（`team_link_recover` 没有
	// `model=` 参数，「传 model=」那条指路在本工具里执行不了 —— D8 那轮的裁定）。
	const modelSelection = resolveTeamSessionModelSelection(ctx, {}, sessionId, "resume");
	const agentOptions = { provider: modelSelection.provider, model: modelSelection.model };
	const agentPresets = ctx.get?.("agentPresets");
	// 与创建面**同一条**三分法（代码评审第 2 轮：同一形状断层不许两个面两种判词）：
	//   服务缺席        ⇒ 可服务降级（恰一行具名 warn，复活照常）；
	//   服务在场但形状断层 ⇒ **显式拒绝**（复活一个没有人设、没有工具面的代理，
	//                       正是 DEFECT-1「会建 ≠ 能用」的形状）；
	//   两方法都在      ⇒ 正常组装。
	const presetFacePresent = agentPresets !== undefined && agentPresets !== null;
	const presetFaceUsable = presetFacePresent && typeof agentPresets.resolve === "function" && typeof agentPresets.mount === "function";
	if (presetFacePresent && !presetFaceUsable) {
		throw new Error(`agentPresets 服务在场，但组成面形状断层（resolve=${typeof agentPresets.resolve}, mount=${typeof agentPresets.mount}）——复活面与创建面都靠 resolve → mount 这一对，缺任一个都组装不出 persona-prefix 的组装源。拒绝恢复：宁可不复活，也不复活一个没有人设、没有工具面的代理（真机缺陷 #1 的形状）；请核对宿主的 preset 服务形状。`);
	}
	if (!presetFaceUsable) {
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: agentPresets service unavailable — 复活的会话 ${sessionId} 既未解析也未挂载 preset：它没有 persona-prefix 的组装源，也拿不回这个 preset 的工具面（真机缺陷 #1 的同一根因）。会话照常复活，若它跑不起来请检查宿主的 agentPresets 服务。`);
	}
	return {
		agentOptions,
		setup: async (agentCtx, agent) => {
			if (presetFaceUsable) {
				const stored = agent?.session?.header?.agentPreset;
				const preset = await agentPresets.resolve(typeof stored === "string" && stored !== "" ? stored : undefined);
				await agentPresets.mount(agentCtx, preset.id);
			}
			installTeamSessionModelSelection(agentCtx, modelSelection);
		},
	};
}

/**
 * DEFECT-3（真机缺陷 #3）与它的**半条路由**收尾：模板 `dsh-webhook` 的
 * `resolveRequest` 的模型选择分支（`lib/index.js:28-52`）——调用方没给 model 时，缺省选择
 * 也**必须**解析出来；**只给一半**时缺的那一半同样必须补齐（收尾裁定，见下）：
 *
 * ```js
 * const selected = ctx.agentDefaultModel.currentSelection();
 * agentOptions = { provider: selected.provider, model: selected.model };
 * ```
 *
 * 为什么不能省（真机一次就把「宿主会兜底」这条假设推翻了）：`{{model}}` 的值不是来自
 * 宿主的缺省设置，而是来自**这个 agent 自己的 `options.model`**
 * （`dsh-agent-loop` 用 `ctx.systemPrompt.variable("model", (context) =>
 * context.agent?.options.model)` 注册它）。宿主的缺省只在**它自己的装配流程**里生效；
 * 一个由 `agents.create` 造出来、没有 `agentOptions` 的 agent 走不到那里。
 *
 * **收尾裁定（2026-09-20）——任一侧缺失就补齐**：`model=X` 而漏写 `provider=` 的调用方
 * 拿到的是 `agentOptions = {model}`，那是**同一个缺陷类的另一半**（`dsh-agent-loop` 以
 * 「has no provider/model」拒绝），失效形态与 DEFECT-1/3 一模一样。所以判据不是「两侧
 * 都没给」，而是「**任一侧**缺失」：只缺哪一半，就由**这一次** `currentSelection()` 的读数
 * 补哪一半（两侧都缺 ⇒ 一对全取缺省；两侧都给 ⇒ **完全不问服务**，行为与修复前逐字相同）。
 *
 * 服务获取方式是 `ctx.get`（**不**进模块级 `inject`，§10.3 红线仍 4 项）。服务拿不到、
 * 或拿到的 selection 补不出缺的那一半时**拒绝创建**（fail-visible，二选一里更硬的那个）：
 * 没有它就没有可解析的缺省模型，造出来的 agent 就是跑不起来的——「宁可不建，也不建一个
 * 跑不起来的会话」。
 *
 * @throws 服务缺席且调用方没给全，或 `currentSelection()` 补不出缺的那一半时。
 */
function resolveTeamSessionModelSelection(ctx, plan, sessionId, face = "create") {
	if (plan.provider !== undefined && plan.model !== undefined) return { provider: plan.provider, model: plan.model };
	// Which half the caller left out — named in both refusals, because 「哪一半缺」是这两个
	// 失败面唯一能让人立刻修好的信息（fail-visible 的实质）。
	const missing = plan.provider === undefined && plan.model === undefined
		? "provider/model 两侧都没给"
		: plan.model === undefined
			? `只给了 provider=${JSON.stringify(plan.provider)}、缺 model`
			: `只给了 model=${JSON.stringify(plan.model)}、缺 provider`;
	// 同一份解析器服务两个面（create / revive），但**出路不一样**：`/team_session` 能传
	// `model=<provider>/<model>`，而 `team_link_recover` 的参数面只有 action/team/role ⇒
	// 给它「传 model=」这条指路就是一条**本工具执行不了**的出路（D8 那轮的裁定：不可执行的
	// 指路本身就是缺陷）。所以两面的判词与出路按 `face` 取不同的措辞，**create 面一字未改**。
	const reviveFace = face === "resume";
	const subject = reviveFace ? `复活的会话 ${sessionId}` : `新会话 ${sessionId}`;
	// 第二段判词里的那个主语在 create 面**原文是没有 id 的**（「新会话首回合报 …」）——
	// 保持逐字不变，别顺手把 id 塞进去。
	const shortSubject = reviveFace ? `复活的会话 ${sessionId}` : "新会话";
	const verdict = reviveFace ? "拒绝恢复：宁可不复活，也不复活一个跑不起来的代理。" : "拒绝创建：宁可不建，也不建一个跑不起来的会话。";
	const unavailableExits = reviveFace ? "一条出路——让宿主的 agentDefaultModel 缺省模型可用（team_link_recover 没有 model= 参数，给不了显式的一对）。" : "两条出路——传 model=<provider>/<model>（或让宿主的 agentDefaultModel service 可用）。";
	const unusableExits = reviveFace ? "一条出路——修好宿主的缺省模型设置（team_link_recover 没有 model= 参数，给不了显式的一对）。" : "两条出路——传 model=<provider>/<model>，或修好宿主的缺省模型设置。";
	const agentDefaultModel = ctx.get?.("agentDefaultModel");
	if (agentDefaultModel === undefined || agentDefaultModel === null || typeof agentDefaultModel.currentSelection !== "function") {
		throw new Error(`agentDefaultModel service unavailable — ${missing}，而没有它就没有可解析的缺省模型选择（真机缺陷 #3）：${subject} 的 agentOptions 补不成可运行的一对，而 deployment:persona-prefix 里 {{model}} 的值正是它 ⇒ 首回合会以 prompt variable "{{model}}" has no value 失败。${verdict}${unavailableExits}`);
	}
	const selected = agentDefaultModel.currentSelection();
	// The caller's own half always wins; only the missing half is taken from this ONE reading.
	const provider = plan.provider ?? selected?.provider;
	const model = plan.model ?? selected?.model;
	if (typeof provider !== "string" || provider === "" || typeof model !== "string" || model === "") {
		throw new Error(`agentDefaultModel.currentSelection() 没有给出可用的 provider/model（provider=${JSON.stringify(selected?.provider)}, model=${JSON.stringify(selected?.model)}）——调用方没给的那部分（${missing}）只能由它来补，补不出来就等于写进 agentOptions 的那一对残缺，会原样复现真机缺陷 #3（${shortSubject}首回合报 prompt variable "{{model}}" has no value）。${verdict}${unusableExits}`);
	}
	return { provider, model };
}

/**
 * A cross-session relay message whose `source` carries exactly the three audited
 * members — `{kind, form, senderSessionId}` (V10). An extra member refuses the
 * whole session log at migration time, so the plugin name and the delivery moment
 * live in the body instead.
 *
 * SCOPE OF THIS BUILDER (差异审计修复轮 🔵-3). The claim is "ONE builder for every
 * relay THIS PLUGIN DRIVES" — the messages the plugin constructs to wake or
 * answer someone (the §10.2.3 kickoff, the §11.4.5 hand-over delivery, the §11.2
 * command instruction). It is NOT "the module's only three-member relay literal":
 * two other faces construct their own, on purpose, and they are three-member for
 * the same red-line reason —
 *
 *   - {@link tickMessage} (the §3.2.3 watchdog tick): its id prefix `slp-wd-` and
 *     its sender are the watchdog's own identity (the message is delivered to the
 *     WATCHER, who is also its recorded sender), so routing it through this
 *     builder would change both facts;
 *   - the §3.4 `team_link_send` delivery in `deliverToTarget`: its body is the
 *     envelope banner and its receiver is addressed by an already-resolved target,
 *     so it builds its message where that banner is built.
 *
 * All three sites are three-member. A change to the triple's shape therefore has
 * three places to touch, and a fourth literal appearing anywhere is a defect: the
 * assertion that this builder stays the only one THIS FILE DRIVES is about the
 * driven set, not about the file's literal count.
 *
 * 设计 §10.2.3 的模板写的是 `handle.agent.followup(createUserMessage({content,
 * source}))`；这里是**手写的等价字面量**——一条**有意保留的偏差**（差异审计
 * 修复轮 🔵-2 的裁定）。裁定的依据是导入面：`createUserMessage` 来自
 * `@deepseek-ai/dsh-llm`，而本模块的**导入白名单只有六项**且经 U19 断言锁住
 * （白名单的一项目的正是「新增依赖无法偷渡写入 API」）。审计逐行比对的结论是
 * 两者实体**逐字相同**，差别只在那条上游构造函数产出的消息**被深冻结**
 * （`brandString` 是恒等函数）；本插件的消息一旦投出就不再改写，所以为一个
 * 单行消息的深冻结把导入面从 6 项扩到 7 项，与那条红线不相称。**若将来本文件已经因
 * 别的理由引入 `@deepseek-ai/dsh-llm`，这一处应随之改回上游构造函数**（那时白名单
 * 本就要一起改）。
 */
function relayUserMessage(text, senderSessionId) {
	return {
		id: `slp-${randomUUID()}`,
		role: "user",
		source: { kind: "agent-message", form: "relay", senderSessionId },
		content: [{ type: "text", text: wellFormed(text) }],
	};
}

/** The §10.2.3 kickoff task, driven into a freshly created worker. */
function teamSessionKickoffMessage(text, coordinatorId) {
	return relayUserMessage(text, coordinatorId);
}

/** Append one §10.2.6 `pending-creates` intent (read-modify-write, like every
 * other policy write in this plugin). */
async function addTeamSessionPending(policy, intent) {
	const current = policy.get();
	await policy.update({ pendingCreates: [...current.pendingCreates, intent] });
}

/** Resolve one intent by session id. A missing row is not an error: the sweep
 * may already have reported it. */
async function removeTeamSessionPending(policy, sessionId) {
	const current = policy.get();
	if (!current.pendingCreates.some((entry) => entry.sessionId === sessionId)) return;
	await policy.update({ pendingCreates: current.pendingCreates.filter((entry) => entry.sessionId !== sessionId) });
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
async function registerTeamSessionRoles(ctx, policy, plan, cwd, coordinatorId, createdRoleNames, release = null) {
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
function createCommandsSeam(ctx, commandNames) {
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
const TEAM_SESSION_RECEIPT_MAX_POINTS = 120;
/** The fixed tail of a FAILURE receipt. It is what keeps the cap from eating the
 * outlet: the receipt is short by construction, and the full cause + 出路 stay in
 * the command output of the same turn (channel 1 — 真机已核实那条也在屏上). */
const TEAM_SESSION_RECEIPT_FAILURE_TAIL = "（原因与出路见本回合命令输出）";

/**
 * The plain reason inside a command result: \`<label> /<cmd>[ 失败]：<…>\` minus the
 * prefix it always carries. Deriving it (instead of threading a second copy of the
 * same sentence through every return) is what makes the receipt honest by
 * construction — a NEW failure branch added later cannot forget to fill it in.
 */
function teamSessionReceiptReason(text) {
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
function teamSessionReceiptOf(settled) {
	if (settled !== undefined && settled !== null && settled.receipt !== undefined) return settled.receipt;
	const kind = settled === undefined || settled === null ? "error" : settled.kind;
	const reason = teamSessionReceiptReason(settled === undefined || settled === null ? "" : settled.text);
	return kind === "success" ? { state: "error", reason: `结算异常：成功结果没有带团队读数（${reason}）` } : { state: "error", reason };
}

/** §10.2.8.10 ①'s one line, in the three states, with the team name only when it was
 * really resolved (a pre-parse failure has none and must not get one stuffed in). */
function teamSessionReceiptText(receipt) {
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
async function deliverTeamSessionReceipt(ctx, invocation, settled) {
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
function registerTeamSessionCommand(ctx, policy, rotation, controller, seam, watchdog, sections = null) {
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

// ---------------------------------------------------------------------------
// §11.2 `/team_rotate <role>` — the human trigger for the automatic hand-over
// ---------------------------------------------------------------------------

/**
 * Slash-command name of §11.2 (without the leading slash). It rides the SAME
 * optional `commands` seam as `/team_session` (§10.2.1) — the module-level
 * `inject` array stays at its four entries.
 */
const TEAM_ROTATE_COMMAND = "team_rotate";
/** The one key this grammar accepts. The role is positional, so the key list
 * stays this short — and the unknown-key refusal prints exactly this list, which
 * is what keeps the message from advertising a key the parser refuses.
 * {@link TEAM_ROTATE_KEY_HINT} is RENDERED FROM this array, so the advertised key
 * set and the accepted key set cannot drift apart in either direction (③a 差异审计
 * 修复轮 🟡-4 / host-half 的双向锁断言). */
const TEAM_ROTATE_KEYS = ["team"];
/** Per-key help of `/team_rotate`. `null` is the honest value for a key that has
 * no `=<value>` form — none today, but leaving the hole in the map is cheaper
 * than re-shaping it later. */
const TEAM_ROTATE_KEY_HELP = { team: "<name>（可选）" };
const TEAM_ROTATE_KEY_HINT = TEAM_ROTATE_KEYS.map((key) => `${key}=${TEAM_ROTATE_KEY_HELP[key] ?? "<值>"}`).join("  ");

/**
 * §11.2's command grammar, and nothing beyond it: `/team_rotate <role> [team=<name>]`.
 * No quoting is supported ON PURPOSE — a team name is `[a-z0-9-]+` and a role name
 * is validated by {@link readRoleName}, so quotes would be syntax the command
 * advertised and then had to strip; a value that carries one is refused instead.
 */
function readTeamRotateCommand(rawInput) {
	const text = typeof rawInput === "string" ? rawInput.trim() : "";
	const syntax = `/${TEAM_ROTATE_COMMAND} <role> [${TEAM_ROTATE_KEY_HINT}]`;
	if (text === "") return { error: `需要角色名。语法：${syntax}` };
	const value = {};
	for (const token of text.split(/\s+/u)) {
		const at = token.indexOf("=");
		if (at === -1) {
			if (value.role !== undefined) return { error: `只接受一个角色名（已给「${value.role}」，又出现了「${token}」）。语法：${syntax}` };
			value.role = token;
			continue;
		}
		const key = token.slice(0, at);
		const raw = token.slice(at + 1);
		if (!TEAM_ROTATE_KEYS.includes(key)) return { error: `未知参数「${key}=」（本命令只接受 ${TEAM_ROTATE_KEY_HINT}；角色名直接写，不加 key）。` };
		if (raw === "") return { error: `「${key}=」的值为空。` };
		if (/["']/u.test(raw)) return { error: `「${key}=」的值不要带引号（团队名是 [a-z0-9-]+，直接写）。` };
		value[key] = raw;
	}
	if (value.role === undefined) return { error: `需要角色名。语法：${syntax}` };
	return { value };
}

/**
 * §11.2 / §11.9.7: the command only does MECHANISM. `CommandResult` text is
 * rendered by the dispatching UI and never enters the model context, so the
 * command cannot draft the hand-over body itself — it drives the incumbent with
 * this instruction, and the model drafts the body and makes the tool call. The
 * syntax taught here is the syntax the tool implements (one contract, one
 * wording): `successor:"auto"` plus the five hard sections.
 */
function teamRotateInstruction(teamName, roleName, caller) {
	return [
		`【${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}】你是团队 ${teamName} 的角色 ${roleName} 的现任（会话 ${caller}），有人请你交班。下面是机制步骤，判断由你给：`,
		"",
		"① 起草交接正文（Markdown；五个硬节各以一个标题开头，标题名逐字如下）：",
		...HANDOFF_HARD_SECTIONS.map((name) => `   ## ${name} —— ${HANDOFF_SECTION_HINTS[name]}`),
		`   软节（缺了只警告，不拒绝）：${HANDOFF_SOFT_SECTIONS.map((name) => `## ${name}`).join(" / ")}`,
		"② 然后调用（交接正文放进 handoff 参数；自建继任者、写交接文档、铸令牌、投递都由插件承担）：",
		`   team_link_rotate  action="prepare"  team="${teamName}"  role="${roleName}"  successor="auto"  handoff="<第 ① 步的正文>"`,
		"③ 会弹一个确认框（新建 1 个会话 + 交班的爆炸半径：id / cwd / 模型情形 / 保守成本口径 / 信任面）——人类确认后才会真的建会话；无确认服务则 fail-closed。",
		"④ 之后没有你的动作：继任者凭投给它的令牌自己 claim；rotation-done 广播后旧任即可关闭（插件绝不自动关闭任何会话，§11.4.7）。",
		"",
		`提醒：这份正文是继任者得到的全部（它是零上下文的新根会话）；插件只把关结构（五硬节在场 / 非空 / 有界），不把关内容质量（§11.9.6）。`,
	].join("\n");
}

/**
 * `apply`'s §11.2 entry point. Three things happen here and nothing else: the
 * caller is checked to BE that role's incumbent (§11.2's own gate — the command
 * writes no roster state, so `writerGate` is not the right gate here, and the
 * tool's own `rotateGate` repeats this check one step later), the session is
 * driven with `followup`, and the UI gets a summary.
 *
 * H3 (§11.8 / §11.9.7): driving one's own session from a command handler has no
 * interface-level prohibition, but its turn semantics are a smoke-test item for
 * the restart window — so the summary says so out loud, and the TOOL entry stays
 * the fallback path (a human can always just ask the incumbent in words).
 */
function registerTeamRotateCommand(ctx, policy, rotation, seam) {
	seam.add({
		name: TEAM_ROTATE_COMMAND,
		build: () => ({
			name: TEAM_ROTATE_COMMAND,
			description: `§11.2 自动换届（③）的人类入口：/${TEAM_ROTATE_COMMAND} <role> [${TEAM_ROTATE_KEY_HINT}]。handler 校验发起会话确为该角色的现任 → 用 followup 把「起草交接正文（五硬节）并调用 team_link_rotate action=prepare successor:"auto"」的指令投给该会话 → 返回摘要给 UI。命令自身不做交接正文（命令的返回值进不了模型上下文，正文必须由模型起草），也绝不自建会话：真正的新建会话 + 交班在工具侧，且必须过一次确认框（§11.4.1）。命令的可用性是可选的：没有 commands 服务时本命令不注册，其余工具面照常（§10.2.1）。`,
			input: { hint: `<role> [${TEAM_ROTATE_KEY_HINT}]`, attachments: false },
			recordInput: true,
			handler: async (invocation) => {
				try {
					const parsed = readTeamRotateCommand(invocation.rawInput);
					if (parsed.error !== undefined) return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：${parsed.error}` };
					const role = readRoleName(parsed.value.role);
					if (role.error !== undefined) return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：${role.error}` };
					const caller = typeof invocation.agent?.id === "string" && invocation.agent.id !== "" ? invocation.agent.id : undefined;
					if (caller === undefined) return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：当前命令没有可交互的活动代理——换届由现任发起，命令必须能驱动发起者自己的会话。` };
					// Every roster touch is a sweep moment (the roster tool's own lazy hook),
					// so a stranded rotation deadline is noticed here too.
					await rotation.sweep({ now: Date.now(), signal: invocation.signal });
					const view = policy.get();
					const named = typeof parsed.value.team === "string" ? parsed.value.team.trim() : undefined;
					const teams = named === undefined ? view.teams : view.teams.filter((team) => team.name === named);
					if (teams.length === 0) {
						// Two different facts, two different sentences: an empty registry is not
						// "the team you named does not exist".
						return { kind: "error", text: named === undefined
							? `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：本机还没有注册任何团队（先用 team_link_roster action=upsert-team 创建，它会把发起会话播种为该队的 coordinator 现任）。`
							: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：团队 ${named} 不在注册表中（先用 team_link_roster action=upsert-team 创建）。` };
					}
					const incumbent = teams.filter((team) => roleOf(team, role.value)?.current === caller);
					if (incumbent.length === 0) {
						const detail = teams.map((team) => {
							const entry = roleOf(team, role.value);
							return entry === null ? `团队 ${team.name} 没有角色 ${role.value}` : `团队 ${team.name} 的角色 ${role.value} 现任是 ${entry.current ?? "（空缺）"}`;
						}).join("；");
						return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：发起会话 ${caller} 不是该角色的现任（${detail}）——换届只能由现任发起（§3.6.2 的 rotateGate 在工具侧作同样判定）。` };
					}
					if (incumbent.length > 1) return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：你在 ${incumbent.length} 个团队担任 ${role.value}（${incumbent.map((team) => team.name).join("、")}）——请用 team=<name> 指定其中一个。` };
					const team = incumbent[0];
					const limited = rotationRateLimited(roleOf(team, role.value), Date.now());
					if (limited.limited) return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：该角色现在处于换届速率限制窗口——${limited.reason}。现在唤醒只会让你再撞一次同样的拒绝（§3.6.2 rateLimit(team, role, 10min)），本命令未投递任何指令。` };
					invocation.agent.followup(relayUserMessage(teamRotateInstruction(team.name, role.value, caller), caller));
					return {
						kind: "success",
						text: wellFormed([
							`/${TEAM_ROTATE_COMMAND}：已把「起草交接并调用 team_link_rotate prepare successor:"auto"」的指令投给本会话（团队 ${team.name} 角色 ${role.value}）。`,
							"- 命令只做机制：交接正文（五硬节）由模型起草，插件负责自建继任者、写交接文档、铸令牌、投递。",
							"- 下一步：本会话会被这条 followup 唤醒，随后弹一次确认框；确认之前不会创建任何会话、不铸令牌、不广播 freeze（无确认服务 → fail-closed，§11.4.1）。",
							"- H3 待验（§11.8 / §11.9.7）：命令 handler 驱动自身会话的 followup 尚未真机验证。若这条唤醒没有发生，请直接用自然语言让现任调用 team_link_rotate action=prepare … successor=\"auto\"——工具入口与命令入口并存，工具入口是兜底。",
						].join("\n")),
					};
				} catch (error) {
					return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND} 失败：${describeError(error)}` };
				}
			},
		}),
	});
}

/**
 * §10.2.6 startup sweep: report every `pending-creates` intent that outlived its
 * TTL as an ADOPTABLE session (the create crashed, or the plugin unloaded
 * mid-loop). The row is never deleted on the strength of the guess that the
 * session does not exist — the plugin cannot tell an orphan session from a
 * never-created one, so it hands the list to the human and removes the intent
 * (its report IS the record).
 *
 * The report is the caller's LOG line, so the wording says where it came from.
 * The liveness probe is injected (§11.9.3): the sweep has a `ctx` and therefore a
 * reading, and the reading is used HERE and nowhere durable.
 *
 * @returns `{ reported, lines }` — the durable intents reported, in the caller's
 *   terms; `lines` is the complete startup report (pending-create orphans plus
 *   the seated-dead roster rows).
 */
async function sweepPendingCreates(ctx, policy, now = Date.now()) {
	const view = policy.get();
	const expired = view.pendingCreates.filter((entry) => entry.expiresAt > 0 && entry.expiresAt <= now);
	// §11.9.3's startup row (computed from the SAME read as the sweep above, so the
	// two halves of one report cannot describe two different rosters). It is a pure
	// read: nothing about liveness is written anywhere, which is the whole point.
	const dead = seatedDeadRoles(view, (id) => agentIsLive(ctx, id));
	let lines = dead;
	if (expired.length === 0) return { reported: [], lines };
	try {
		await policy.update({ pendingCreates: view.pendingCreates.filter((entry) => !expired.includes(entry)) });
	} catch (error) {
		return { reported: [], lines: [...lines, `pending-create 清扫写入失败（${describeError(error)}）：本次未生效，下次启动/巡逻会重试。`] };
	}
	lines = [...lines, ...expired.map((entry) => `- 团队 ${entry.team} 的角色 ${entry.role}：意图于 ${readStamp(entry.createdAt)} 写于创建之前，超时（${readStamp(entry.expiresAt)}）未回填 → 会话 ${entry.sessionId} 可能已创建但未登记，也可能根本没建成：可在侧边栏按这个 id 找它，找到即打开收编并用 team_link_roster action=set-role 重新登记（插件不删任何会话）。`)];
	ctx.logger?.warn?.(`${PLUGIN_LABEL}: ${expired.length} 个 pending-create 意图超时未回填 — 可收编清单见本轮启动报告`);
	return { reported: expired, lines };
}



// ---------------------------------------------------------------------------
// §11.9.6 hand-over document contract (③a)
// ---------------------------------------------------------------------------
//
// HONESTY, STATED WHERE IT BELONGS (design §11.9.6, almost verbatim): the plugin
// can only vet the STRUCTURE of a hand-over body — a section is present,
// non-empty and bounded — it can NOT vet CONTENT QUALITY. The presence gate
// guards against FORGETTING, not against going through the motions: a body that
// writes "TODO" under all five headings passes this gate, and nothing here
// pretends otherwise.


/** A heading line's normalized name: `## Task and Goal:` → `task-and-goal`. The
 * folding (`_`/whitespace → `-`) is what makes "task_and_goal" and
 * "Task and Goal" the same section instead of two silent near-misses. */
function normalizeHandoffSection(title) {
	return String(title ?? "").trim().toLowerCase().replace(/[\s_]+/gu, "-").replace(/^-+|-+$/gu, "");
}

/**
 * Split one hand-over body into its named sections. Pure text handling, and the
 * heading recognition is deliberately forgiving (`#`…`######`, an optional
 * trailing colon, any case, `-`/`_`/spaces inside the name): a body the model
 * DID write must not be refused over a heading style (§11.9.6 — the gate is
 * about presence, and a false refusal is a gate that lies).
 *
 * @returns `{ preamble, sections }` — `preamble` is the text before the first
 *   heading, kept so the document can carry the model's own words verbatim.
 */
function parseHandoffBody(text) {
	const preamble = [];
	const sections = [];
	let current = null;
	for (const line of String(text ?? "").split(/\r?\n/u)) {
		const heading = /^\s*#{1,6}\s*(.*?)\s*$/u.exec(line);
		if (heading !== null && heading[1] !== "") {
			const title = heading[1].replace(/[:：]\s*$/u, "").trim();
			current = { name: normalizeHandoffSection(title), title, lines: [] };
			sections.push(current);
			continue;
		}
		if (current === null) preamble.push(line);
		else current.lines.push(line);
	}
	return { preamble, sections };
}

/**
 * §11.9.6's structural report of one body: which HARD sections are absent, which
 * are present but EMPTY, which SOFT ones are absent. Pure — the ladder that
 * decides refuse-vs-warn lives in {@link readHandoffArgument}, so the counting
 * and the decision can be read (and asserted) separately.
 */
function handoffBodyReport(text) {
	const parsed = parseHandoffBody(text);
	const contentOf = (name) => {
		const section = parsed.sections.find((candidate) => candidate.name === name);
		return section === undefined ? undefined : section.lines.join("\n").trim();
	};
	const missingHard = [];
	const emptyHard = [];
	for (const name of HANDOFF_HARD_SECTIONS) {
		const content = contentOf(name);
		if (content === undefined) missingHard.push(name);
		else if (content === "") emptyHard.push(name);
	}
	return {
		parsed,
		missingHard,
		emptyHard,
		missingSoft: HANDOFF_SOFT_SECTIONS.filter((name) => contentOf(name) === undefined),
	};
}

/** The five-hard-section scaffold a refusal hands back (§11.9.6), rendered from
 * the same lists the validator uses. */
function handoffScaffold() {
	const lines = ["交接正文用 Markdown 写，五个硬节各以一个标题开头（标题名与下面逐字一致）：", ""];
	for (const name of HANDOFF_HARD_SECTIONS) lines.push(`## ${name}`, HANDOFF_SECTION_HINTS[name] ?? "", "");
	lines.push(`软节（缺了只警告，不拒绝）：${HANDOFF_SOFT_SECTIONS.map((name) => `## ${name}`).join(" / ")}`);
	return lines.join("\n");
}

/** The header's integrity verdict, rendered from the SAME report the ladder
 * decided on — so the document can never claim a completeness the gate did not
 * measure (the cross-round lesson: one fact, one source). */
function handoffIntegrityLine(report) {
	const complete = HANDOFF_HARD_SECTIONS.length - report.missingHard.length - report.emptyHard.length;
	const soft = report.missingSoft.length === 0
		? `软节齐全（${HANDOFF_SOFT_SECTIONS.length}/${HANDOFF_SOFT_SECTIONS.length}）`
		: `软节缺 ${report.missingSoft.length}/${HANDOFF_SOFT_SECTIONS.length}（${report.missingSoft.join("、")}）`;
	return `结构完整：硬节 ${complete}/${HANDOFF_HARD_SECTIONS.length}、${soft}；插件只把关结构（节在场 / 非空 / 有界），不把关内容质量——presence 门防遗忘、不防敷衍（§11.9.6）`;
}

/**
 * §11.9.6's 缺项阶梯, evaluated at the TOOL ENTRY and therefore before any side
 * effect: `successor:"auto"` plus a missing/empty body is refused here (zero
 * session, zero token, zero freeze), a missing hard section is refused BY NAME,
 * a missing soft section is a warning, and an EXPLICIT successor with no body at
 * all is allowed with a warning (M4's existing semantics are not tightened for
 * it — that session has its own life and context).
 *
 * ③a 差异审计修复轮 🟡-6: the two refusals below say WHICH successor form they
 * are talking about, rendered from THIS call's own `auto` flag rather than from
 * the case the branch was originally written for. The wording is the design's
 * (`successor:"auto"`), but it is now derived, so a future second entry point
 * that reaches these lines with an explicit successor cannot be told a story
 * about a path it did not take.
 *
 * @returns `{ error }` (refuse) or `{ body, warnings, report }` (proceed).
 */
function readHandoffArgument(value, options = {}) {
	const auto = options.auto === true;
	// The path label of THIS call (🟡-6). `successor:"auto"` is the §11.2 name of
	// the automatic path; an explicit successor is named by its own value.
	const pathHere = auto ? "successor:\"auto\"" : "显式 successor";
	const present = typeof value === "string" && value.trim() !== "";
	if (!present) {
		if (!auto) {
			return {
				body: "",
				report: null,
				warnings: [`未提供交接正文（handoff）：显式指定的继任者有自己的会话与上下文，M4 现有语义不因此收紧（§11.9.6 缺项阶梯）——但交接正文是头部/事实段之外唯一能留下判断的东西，建议下次仍按五硬节写一份：${handoffSectionsInline()}。`],
			};
		}
		return {
			error: `prepare 被拒绝（${pathHere} + 交接正文缺失或为空）：auto 路径造出的继任者是零上下文的新根会话，交接正文是它得到的全部——空正文的自动换届等于造一个失忆的持钥者（§11.9.6）。本次零建会话、零令牌、零 freeze。\n\n${handoffScaffold()}`,
		};
	}
	const report = handoffBodyReport(value);
	const named = [...report.missingHard.map((name) => `${name}（缺）`), ...report.emptyHard.map((name) => `${name}（空）`)];
	if (named.length > 0) {
		return {
			error: `prepare 被拒绝（${pathHere} + 交接正文缺硬节）：${named.join("、")}。本次零建会话、零令牌、零 freeze——请补齐后重试。\n\n${handoffScaffold()}`,
		};
	}
	const warnings = [];
	if (report.missingSoft.length === 0) warnings.push(`交接正文结构完整：硬节 ${HANDOFF_HARD_SECTIONS.length}/${HANDOFF_HARD_SECTIONS.length}、软节 ${HANDOFF_SOFT_SECTIONS.length}/${HANDOFF_SOFT_SECTIONS.length} 齐全（头部已记录）。`);
	else warnings.push(`交接正文缺软节：${report.missingSoft.join("、")}（放行——软节缺失只警告；头部已记录，§11.9.6）。`);
	return { body: value, warnings, report };
}

/**
 * §11.9.6 事实段 and the claim's own report are ONE fact source: this function
 * renders the three categories both of them state — the migration rows, the
 * dropped rows and the symmetric-revocation line. `selectedKeys === null` is the
 * "the claim has not run yet" mode, because the hand-over document is written
 * before prepare (§11.9.6 abort-before-prepare); both modes share every word they
 * both use, so the document and the claim result can never tell two different
 * stories about the same rotation (「不可两处口径」).
 */
function rotationFactRows(state) {
	const retiree = state.retiree;
	const successor = state.successor;
	const candidates = Array.isArray(state.candidates) ? state.candidates : [];
	const selected = state.selectedKeys ?? null;
	const additions = Array.isArray(state.additions) ? state.additions : [];
	const provisional = state.provisional === true;
	const migration = [];
	if (candidates.length === 0) {
		migration.push("  - （域内没有待迁移的 pairs）");
	} else if (selected === null) {
		for (const candidate of candidates) {
			migration.push(`  - ${candidate.other} ↔ ${retiree} → 待 claim 逐项勾选（域内候选；迁移与否在继任者 ${successor} 认领时落定）`);
		}
	} else {
		for (const candidate of candidates) {
			// "Selected" is decided by the dialog answer, not by whether a new record
			// was written: a counterpart the successor is already paired with migrates
			// without a second record.
			if (!selected.has(pairKey(candidate.pair))) {
				migration.push(`  - ${candidate.other} ↔ ${retiree} → 未迁移（未勾选）→ 已随退役清理；今后该对端走正常首问门。`);
				continue;
			}
			const added = additions.find((pair) => pair.b === candidate.other);
			if (added === undefined) {
				migration.push(`  - ${candidate.other} ↔ ${retiree} → 已迁移（新任与该对端已有配对记录，未新增重复记录）。`);
				continue;
			}
			migration.push(`  - ${candidate.other} ↔ ${retiree} → 已迁移为 ${candidate.other} ↔ ${successor}（${provisional ? `provisional，24h 内未批准自动回退，到期 ${readStamp(added.expiresAt)}` : "正式通道"}）。`);
		}
	}
	const dropped = (Array.isArray(state.dropped) ? state.dropped : []).map((item) => `  - ${item.other} ↔ ${retiree} → 未迁移（${item.reason}）→ 已随退役清理。`);
	// One head for both the prepare-time and the claim-time revocation sentence:
	// the template is written once, so the document and the claim result can never
	// drift apart (and the source lock in host-half.test.mjs can count it as one).
	const revokedHead = `对称撤销（§3.6.1 原则 3）：退役者 ${retiree} 持有的 pairs ${state.removedCount ?? 0} 条已全部清除`;
	const revocation = state.revoked === undefined || state.revoked === null
		? [`${revokedHead}（其中迁移条数在 claim 勾选后才落定）；trustedSenders ${state.trustedSenderCount ?? 0} 项与 rememberTargets ${state.rememberTargetCount ?? 0} 项一并清除——明细见 claim 返回。`]
		: [`${revokedHead}（其中迁移 ${state.migratedCount ?? 0} 条）；trustedSenders 移除 ${state.revoked.trustedSenders ?? 0} 项；rememberTargets 移除 ${state.revoked.rememberTargets ?? 0} 项。`];
	return { migration, dropped, revocation };
}

/** §3.6.2 评审 #5's three provisional verdicts in ONE place: the claim's report
 * and the hand-over document's 事实段 both have to state the rollback window, so
 * the sentence lives here instead of being spelled out twice. */
function provisionalGuidance(state) {
	const { now, successor, provisional, status } = state;
	if (provisional === true) {
		return `provisional 回退窗口：${provisionalWindowExpiry(now)} 到期。到期未批准 → 迁移的 pairs 自动删除、version history 记「${ROTATION_PROVISIONAL_NOTE}」、广播 rotation-expired；${successor} 保持 current，信任回退为过门投递（§3.6.2 评审 #5 终态）。补批准：在设置 UI 把该 pair 的 provisional 置 false 即转正式（回退前有效；已转正式的窗口到期时静默关闭，不记版本史、不广播 rotation-expired——没有回退发生）。`;
	}
	if (status === ROTATION_STATUS_NONE) return "回退窗口：本次换届没有新建任何通道（域内无待迁移对），因此没有 provisional 回退窗口——回退窗口只随迁移出的 pair 产生。";
	return "迁移的 pairs 已是正式通道（无回退窗口）。";
}

/**
 * §11.9.6's three layers, rendered: the header the plugin writes (schema / team /
 * role / both session ids / preparedAt / claimedAt / the token MASK /
 * rotationStatus / the integrity verdict), the fact section the plugin writes
 * from {@link rotationFactRows} + {@link provisionalGuidance} (the same sources
 * the claim's own report reads), and the model's body — carried verbatim, because
 * it is the successor's whole context and the plugin has no business editing it.
 */
function renderHandoffDocument(request) {
	const report = request.report;
	const lines = [
		"---",
		`schema: ${HANDOFF_SCHEMA}`,
		`team: ${request.teamName}`,
		`role: ${request.roleName}`,
		`previous: ${request.previous ?? "（空缺）"}`,
		`successor: ${request.successor}`,
		`preparedAt: ${new Date(request.preparedAt).toISOString()}`,
		`claimedAt: ${HANDOFF_CLAIMED_PLACEHOLDER}`,
		`tokenMask: ${maskToken(request.token)}`,
		`rotationStatus: ${HANDOFF_STATUS_PREPARED}`,
		`integrity: ${handoffIntegrityLine(report)}`,
		"---",
		"",
		`# 交接文档：团队 ${request.teamName} 的角色 ${request.roleName}`,
		"",
		"## 事实段（插件写；与 claim 返回文案同一事实源，§11.9.6）",
		"",
		`- 退役者 → 继任者：${request.previous ?? "（空缺）"} → ${request.successor}（写入读数 ${readStamp(request.preparedAt)}）`,
		// ★ 批 P · FR-P3 ③：继承清单（逐项：值 或 未继承（原因：…））—— 与确认框正文、
		// prepare 回执同一份 `inheritanceRows`。直接调用本渲染器（测试 / 未来的别的写入方）
		// 没给这个读数时**如实说没采集**，不编造三行。
		"- 继任者继承的设置（批 P · FR-P3，逐项：值 或 未继承（原因：…）；三处同源 = 确认框正文 / prepare 回执 / 本节）：",
		...(Array.isArray(request.inheritance) && request.inheritance.length > 0
			? request.inheritance.map((row) => `  - ${row}`)
			: ["  - （本次未采集继承读数——直接调用交接文档写入面时没有这个读数；两条换届路径都会带）"]),
		...(typeof request.approvalApplication === "string" && request.approvalApplication !== ""
			? [`  - ${request.approvalApplication}`]
			: []),
		`- freeze 广播正文（与投出的 rotation-freeze 同一常量，§4.2）：${freezeNotice(request.teamName, request.roleName, request.previous ?? "（空缺）", request.successor, request.preparedAt)}`,
		"- freeze 投递结果（含 no-agent 未投递名单）：本文件先于广播写入，逐目标结果在 prepare 的返回里；换届落定后的汇总在 claim 的 rotation-done 广播行里。",
		`- 域内待迁移的 pairs（候选 ${request.facts.migration.length} 行）与未迁移清单：`,
		...request.facts.migration,
		...request.facts.dropped,
		`- ${request.facts.revocation[0] ?? "对称撤销（§3.6.1 原则 3）：（无记录）"}`,
		`- ${provisionalGuidance({ now: request.preparedAt, successor: request.successor, provisional: true, status: "" })}`,
		"- 上下一份交接文档：",
		request.previousDocument === null
			? "  - 上一份：（无——这是本团队本角色落盘的第一份交接文档）"
			: `  - 上一份：${request.previousDocument}`,
		"  - 下一份：（尚未写入——下一次换届生成新文件；本文件不追写，§11.4.3）",
		"",
		"## 正文（旧任模型撰写，插件原样保留）",
		"",
		request.body.trimEnd(),
		"",
	];
	return wellFormed(`${lines.join("\n")}`);
}

/**
 * Write one hand-over document (§11.4.3 / §11.9.6). The plugin writes it — no
 * new model-facing blackboard write face is added, so the write surface does not
 * grow. It is a single whole-file write, which is why the blackboard's 2000-code-
 * point per-line bound does not apply here, and the timestamped name is why no
 * optimistic lock is needed.
 *
 * @returns `{ ok, path }` or `{ ok: false, error }` — the auto path treats a
 *   failure as abort-before-prepare (§11.9.6).
 */
async function writeHandoffDocument(team, request) {
	if (team.workspace === "") return { ok: false, error: "团队没有 workspace 记录，无法定位 <workspace>/team/<name>/handoff-*.md" };
	const previous = await latestHandoffDocument(team, request.roleName);
	try {
		const file = handoffDocumentPath(team, request.roleName, request.preparedAt);
		await mkdir(path.dirname(file), { recursive: true });
		// The team row is the authority for the team name (the same rule the header
		// rows follow): a caller cannot render a document about another team than the
		// one whose directory it lands in.
		await writeFile(file, renderHandoffDocument({ ...request, teamName: team.name, previousDocument: previous.path }), "utf8");
		return { ok: true, path: file, previousDocument: previous.path, previousError: previous.error };
	} catch (error) {
		return { ok: false, error: describeError(error) };
	}
}

// --- the rotation controller -------------------------------------------------

/**
 * Live rotation controller of one plugin context. `apply` is the only writer;
 * `host-half.test.mjs` reads it through {@link __testing} so the sweep can be
 * driven with an injected clock instead of waiting 24 hours.
 */
const ROTATION_BY_CTX = new WeakMap();

// ---------------------------------------------------------------------------
// §11.9.4/§11.9.5 recovery —— 定义已搬进 `lib/recovery.js`（批 R 第 13 小单）
// ---------------------------------------------------------------------------
//
// ★ 这一整块（入口原 8,531–9,186 行：封闭动词集 · 边界与诊断文案 · L1 预检与限速 · 候选集计算 · 审计行与
//   三处留痕 · 两条确认对话框 · 两个动词执行体）**逐字节**搬进 `lib/recovery.js`（那一档的档头给归属、
//   依赖方向、被钉符号核对与搬迁纪律）。本档按名导入同一份实现，模块尾部那条 `wireRecovery(recoveryExtras())`
//   给它注入 12 条入口侧出口（被钉的 `writerGate` 也在那张表里，**只注入不搬**）。
// ★ 仍留在下面的同域四块（下一小单）：`RECOVERY_BY_CTX` / `createRecovery` / `recoveryDiagnosticLines` /
//   `registerRecoveryTools`；更下面的 `selfBuiltHandoffBody` / `appointSelfBuiltSuccessor` 与交接文档族一起走。
// ---------------------------------------------------------------------------

/**
 * §4.2 (c) ④: the hand-over body the PLUGIN writes for a self-built successor.
 * The published `successor:"auto"` path takes that body from the model; this
 * path has no model in it at all (that is the point — the box has one synthetic
 * candidate and no place to type a body), so the plugin renders the five HARD
 * sections from roster facts and marks everything it cannot read as UNKNOWN.
 *
 * The honesty rule is §11.9.6's, and `unknowns` is the section it lands in: the
 * incumbent is dead BY PREMISE (this verb only runs on a seated-dead role), so
 * nothing about its in-flight work is observable from here, and inventing a
 * plausible-looking note would hand a fresh session a fabricated memory.
 *
 * ONE section has a real data source and therefore is not automatically UNKNOWN:
 * `task-and-goal` renders the goals reading when {@link readGoalSignal} produced
 * one (the same reading `in-flight` reports as evidence), and says 未知 only when
 * there was no reading to render — §4.2 (c) ④'s 「读不到才标未知」, in code. In this
 * verb's normal case the incumbent has no live agent, so the reading is absent and
 * the section really is unknown; the branch exists so the section cannot keep
 * declaring a source it never consumes (差异审计第 8 条).
 *
 * @returns one markdown body whose five hard sections are present and NON-EMPTY
 *   (asserted against {@link HANDOFF_HARD_SECTIONS} in the host suite).
 */
function selfBuiltHandoffBody(request) {
	const trust = request.trust;
	const lines = [
		"## mission",
		`接管团队 ${request.teamName} 的角色 ${request.roleName}（本会话由 team_link_recover action=reappoint 的「${SELF_SUCCESSOR_LABEL}」路径新建：该角色的前任在本进程没有活动代理，人类在候选里选的是**由插件新建一个会话**，而不是把该角色改任给某位活成员）。`,
		`- 前任会话（roster 事实）：${request.incumbent}`,
		`- 发起会话：${request.caller === undefined || request.caller === "" ? "（无会话身份）" : request.caller}`,
		`- 本会话的工作目录：${request.cwd}`,
		"",
		"## in-flight",
		"前任已死，进行中工作不可读——本插件只读 roster 事实，不读会话正文，所以这一节不做任何推测。",
		request.goal.readable ? `- goals 服务读数（该角色前任的会话）：${request.goal.text}` : `- goals 服务：读不到（${request.goal.reason}）。`,
		"",
		"## commitments",
		"该角色记在前任名下的信任指针（只报**存在性与数量**，不复制任何密钥素材）：",
		`- pairs：${trust.pairs} 条`,
		`- trustedSenders：${trust.trustedSenders} 条`,
		`- rememberTargets：${trust.rememberTargets} 条`,
		"迁移方式（§11.9.5）：这些信任**不在本次迁移**——你本人凭令牌调用 team_link_rotate action=claim 时逐项勾选要迁移的 pairs；无人值守（超时 / 无确认服务）则全部以 provisional 迁移，24h 内未获人类批准自动回退。",
		"",
		"## unknowns",
		"- 前任的进行中工作（未落盘的计划、正在跑的工具调用、未发出的消息）——不可读，本节不做推测。",
		"- 前任的会话正文与对话上下文——本插件不读会话正文（导出面是给人用的，不在恢复链路上），交接文档不复制任何会话内容。",
		// §4.2 (c) ④ + §11.9.6 诚实原则: a section may only call something unknown if it
		// still IS unknown. Once the goals service answered, the goal stops being an
		// unknown — what stays unknowable is the part the reading never covered.
		...(request.goal.readable
			? ["- 前任 goal 的**正文与后续意图**——goals 读数只有 phase / activation / rounds 三项，goal 正文与它打算怎么继续不在本插件的读面上。"]
			: [`- 前任的 goal：${request.goal.reason}`]),
		"- 前任是否有未提交的代码改动、是否有别的会话在等它——本插件无从观测（不在它的读面上）。",
		"",
		"## task-and-goal",
		// §4.2 (c) ④: this section's declared data source IS the goals reading — the same
		// reading `in-flight` reports as evidence. Hard-coding 未知 here while computing a
		// reading above was the section declaring a source it never consumed (差异审计第 8 条):
		// the reading is rendered here, and 未知 is kept for the case that really has none.
		...(request.goal.readable
			? [
				`- 该角色的 goal（goals 服务读数，读自该角色前任的会话 ${request.incumbent}）：${request.goal.text}`,
				"- 该读数是**停工时刻的快照**（只有 phase / activation / rounds），不是它的计划；需要更完整的任务上下文时，由人类或在场的旧任补写本节。",
			]
			: [
				"- 该角色的任务与目标：**未知**——goals 按 agent 取读数，而前任没有活动代理，因此这一节读不到任何东西；本文件禁止编造。",
				"- 请由人类，或在场的旧任，补写这一节；插件只保证结构（五硬节在场且非空），不保证内容。",
			]),
		"",
	];
	return lines.join("\n");
}
/**
 * §4.2 (c): the whole chain for the synthetic successor, with nothing re-spelled —
 * §10.2.2 id → the SAME creation path `/team_session` and `successor:"auto"` use →
 * the hand-over document → the published `prepare` VERBATIM → the same three audit
 * trails → the §11.4.5 `followup` that delivers the token and the body to the session
 * that was just built. (The capability gate is answered by `reapIncumbent` before the
 * box opens: this function is only reached when the host CAN build a successor.)
 *
 * The order of the middle three follows §11.9.6 (the document is written BEFORE
 * `prepare`, so a document failure aborts before any token exists) and therefore
 * matches the auto path's own sequence rather than the list order in §4.2 (c) —
 * the design's numbering names the ELEMENTS, and §11.9.6 is the ordering. Delivery is
 * last for the reason §11.4.5 gives: the token has to exist before it can be handed
 * over, and the successor has to be WOKEN, not merely told.
 *
 * @returns `{ lines }` or `{ error }` — every failure path states its own
 *   side-effect boundary, and none of them rolls a created session back
 *   (§10.2.6: a session on disk may already be open somewhere).
 */
async function appointSelfBuiltSuccessor(deps, request) {
	const { ctx, policy, rotation, controller } = deps;
	const { teamName, roleName, caller, signal, now, incumbent, team, candidates } = request;
	const teamSession = controller.teamSession;
	const rootCtx = teamSession?.rootCtx;
	// The successor's workspace: the TEAM's own recorded workspace when there is one
	// (this team's roster mirror and hand-over documents live under it), and the
	// initiating session's cwd as the fallback. `process.cwd()` is never used — a
	// successor created in the host process's own directory would be in the wrong
	// workspace (the same boundary the auto path draws).
	const cwd = typeof team?.workspace === "string" && team.workspace !== "" ? team.workspace : agentCwd({ agent: request.agent });
	if (typeof cwd !== "string" || cwd === "" || !path.isAbsolute(cwd)) {
		const teamWorkspace = team?.workspace === undefined || team.workspace === "" ? "（未记录）" : team.workspace;
		const callerCwd = request.agent?.session?.header?.cwd ?? "（未捕获）";
		return { error: `恢复失败（reappoint，${SELF_SUCCESSOR_LABEL}）：无法确定新会话的工作目录（团队 workspace = ${teamWorkspace}；发起会话的 cwd = ${callerCwd}）——会话边界只接受绝对路径（§10.2.6），本次零创建、零令牌、零 freeze、零写入。` };
	}
	const sessionId = teamSessionId(teamName, roleName, () => randomUUID());
	// The token is minted BEFORE the document, because the document's header carries
	// its MASK (§11.9.6) — the identical look-ahead the auto path does. Nothing of it
	// becomes durable unless this call reaches `prepare`.
	const token = randomUUID();
	// ---- ② the durable intent BEFORE the create (§10.2.6) --------------------
	try {
		await addTeamSessionPending(policy, { team: teamName, role: roleName, sessionId, createdAt: now, expiresAt: now + TEAM_SESSION_PENDING_TTL_MS, by: caller ?? "" });
		teamSession.pending.set(sessionId, { team: teamName, role: roleName, sessionId });
	} catch (error) {
		return { error: `恢复失败（reappoint，${SELF_SUCCESSOR_LABEL}）：pending-create 意图写入失败（${describeError(error)}）——未创建（宁可不建，也不留一个没有意图记录的孤儿）。本次零创建、零令牌、零 freeze。` };
	}
	// ---- ③ create from the plugin ROOT ctx (§10.2.2 / §10.2.5) --------------
	// 批 P · FR-P2（D1/D3/D6）：与 auto 路径**同一句**接线 —— preset / provider / model 三项
	// 从**前任自己存下的那一份**来（{@link collectInheritableSettings}；读不到或不可解析的项是
	// `null` ⇒ `?? undefined` ⇒ 落宿主缺省，NF-P3）；**审批档不进 plan**（D6：创建函数逐字不改，
	// FR-P4 在创建返回之后设）。★ 这条路径的前任**按定义就是死的那一个**（recoveryPreflight 的
	// 「读到读数」那一支），所以它读的正是探针 3 的会话级冷读面（`sessionQuery.readSession` 的
	// header）—— Pi9 覆盖的就是这一条。
	const inheritance = await collectInheritableSettings(ctx, incumbent);
	const inherited = inheritance.values;
	let creation;
	try {
		creation = await createRootAgent(ctx, rootCtx, { preset: inherited.preset ?? undefined, provider: inherited.provider ?? undefined, model: inherited.model ?? undefined, team: teamName }, { sessionId, role: roleName }, cwd);
	} catch (error) {
		return { error: `恢复失败（reappoint，${SELF_SUCCESSOR_LABEL}）：继任者会话创建失败（${describeError(error)}）。未铸令牌、未广播 freeze；pending-create 意图保留，启动清扫会把它报进可收编清单（§10.2.6）。` };
	}
	const handle = creation.handle;
	teamSession.handles.set(sessionId, handle);
	// ---- ③b FR-P4：审批档**在创建返回之后**设（与 auto 路径同一句接线，同一步时序）-----
	const approvalApplication = await applyInheritedApprovalPolicy(inherited, inheritance.writeFace, handle);
	// ---- ④ the hand-over document, BEFORE prepare (§11.9.6) -----------------
	// The facts are re-read HERE rather than reused from the pre-dialog view: the box
	// spanned an unbounded human wait, so the counts this document states must be the
	// counts of the store `prepare` is about to snapshot — the same TOCTOU discipline
	// the two verbs apply to their incumbent before writing.
	const factsView = policy.get();
	const factsTeam = factsView.teams.find((record) => record.name === teamName) ?? team;
	const held = trustReferencesTo(factsView, incumbent);
	const plan = planRotationMigration(factsView, { members: new Set(teamMembers(factsTeam)), retiree: incumbent, successor: sessionId });
	// §11.9.6's honesty rule, applied to the one fact this path could otherwise
	// fabricate: the role's goal is read from a DEAD incumbent, so the plugin reports
	// exactly what the host can answer and marks the rest unknown.
	const goalAgent = typeof ctx.agents?.get === "function" ? ctx.agents.get(incumbent) : undefined;
	const goalSignal = readGoalSignal(ctx, incumbent, goalAgent);
	const goal = goalSignal === null
		? { readable: false, reason: "goals 服务不可用（宿主没有这个服务），该角色的目标读不到" }
		: goalAgent === undefined
			? { readable: false, reason: `该角色的前任会话 ${incumbent} 没有活动代理——goals 按 agent 取读数，所以取不到` }
			: { readable: true, text: `phase=${goalSignal.phase} · activation=${goalSignal.activation} · rounds=${goalSignal.rounds}` };
	const body = selfBuiltHandoffBody({
		teamName,
		roleName,
		incumbent,
		caller,
		cwd,
		goal,
		trust: { pairs: held.pairs.length, trustedSenders: held.trustedSenders.length, rememberTargets: held.rememberTargets.length },
	});
	const document = await writeHandoffDocument(factsTeam, {
		roleName,
		previous: incumbent,
		successor: sessionId,
		token,
		preparedAt: now,
		body,
		report: handoffBodyReport(body),
		// 批 P · FR-P3 ③：继承三行 + 审批档落地读数（与 auto 路径同一份 `inheritanceRows`）。
		inheritance: inheritanceRowList(inheritance.rows),
		approvalApplication: approvalApplication.line,
		facts: rotationFactRows({
			retiree: incumbent,
			successor: sessionId,
			candidates: plan.candidates,
			dropped: plan.dropped,
			removedCount: held.pairs.length,
			trustedSenderCount: held.trustedSenders.length,
			rememberTargetCount: held.rememberTargets.length,
		}),
	});
	if (document.ok !== true) {
		return { error: `恢复失败（reappoint，${SELF_SUCCESSOR_LABEL}，abort-before-prepare §11.9.6）：交接文档写入失败（${document.error}）——不铸令牌、不广播 freeze。已建的继任者会话 ${sessionId} 保留并如实报为孤儿（§10.2.6 部分成功不回滚）；pending-create 意图保留，启动清扫会把它报进可收编清单。` };
	}
	// ---- ⑤ prepare: the published M4 mechanism, step for step -----------------
	const prepared = await rotation.prepare({ teamName, roleName, successor: sessionId, note: recoveryNote("reappoint", caller), caller, now, signal, token, recovery: { verb: "reappoint", from: incumbent, by: caller ?? "" } });
	if (prepared.error !== undefined) {
		return { error: `${prepared.error}（reappoint，${SELF_SUCCESSOR_LABEL}：令牌从未落盘、freeze 未广播；交接文档 ${document.path} 已写但本次换届不存在。已建的会话 ${sessionId} 保留并报为孤儿——pending-create 意图保留，启动清扫会把它报进可收编清单。）` };
	}
	// ---- ⑥ the intent is resolved: this session IS the rotation's successor ---
	try {
		await removeTeamSessionPending(policy, sessionId);
	} catch (error) {
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: pending-create intent ${sessionId} could not be cleared after prepare (${describeError(error)}) — 启动清扫会把它报进可收编清单（换届本身已生效）`);
	}
	teamSession.pending.delete(sessionId);
	// ---- ⑦ the same three audit trails the other branch writes --------------
	const after = policy.get();
	const teamAfter = after.teams.find((record) => record.name === teamName) ?? null;
	const row = { verb: "reappoint", at: now, by: caller ?? "", from: incumbent, to: sessionId, note: recoveryNote("reappoint", caller) };
	const reason = `现任无活动代理（${SEATED_DEAD_LABEL}）；继任者 = 插件自建的根会话 ${sessionId}（${SELF_SUCCESSOR_LABEL}，空上下文）`;
	const trails = teamAfter === null
		? { mirror: { ok: false, error: `团队 ${teamName} 不在注册表中` }, decisions: "（未写：团队不在注册表中）" }
		: await writeRecoveryTrails(teamAfter, { ...row, team: teamName, role: roleName, reason, decision: recoveryDecisionRow({ ...row, team: teamName, role: roleName, reason }) });
	// ---- ⑧ drive it: followup, never inject (§11.4.5) -----------------------
	// The tail this chain was missing (差异审计第 9 条): the token and the hand-over body
	// were minted, written and audited, but never TOLD to the session they belong to —
	// so a freshly built successor sat idle forever, holding a token nobody delivered.
	// The auto path's own step 8 is these same lines; `followup` and not `inject`
	// because the successor has to be WOKEN, and the message rides the same audited
	// three-member source ({kind, form, senderSessionId}).
	let delivered = true;
	let deliveryError;
	try {
		handle.agent.followup(relayUserMessage(handoffDeliveryMessage({ teamName, roleName, previous: incumbent, token, documentPath: document.path, body }), caller));
	} catch (error) {
		delivered = false;
		deliveryError = describeError(error);
	}
	const candidateSummary = candidates.map((candidate) => (candidate.synthetic === true ? SELF_SUCCESSOR_LABEL : `${candidate.role}→${candidate.session}`)).join("、");
	const titleLine = creation.title === undefined
		? "标题（DEFECT-4）：本次**未设成**标题（原因见上文那行 warn）——它会显示为宿主的默认标题（很可能是工作区名，在侧边栏里认不出来）。"
		: `标题（DEFECT-4）：已命名为「${creation.title}」（按「<team> · <role>」派生；不设标题会让它显示为工作区名、与其他会话无法区分）。`;
	return {
		lines: [
			`恢复：已按 §11.9.4 L2 铸好换届包（reappoint，${SELF_SUCCESSOR_LABEL}）：团队 ${teamName} 的角色 ${roleName}，${incumbent === null ? "（空缺）" : incumbent} → ${sessionId}（**由插件新建的根会话**：人类在对话框里选了「${SELF_SUCCESSOR_LABEL}」，插件按 §10.2.2 铸造 id；读数 ${readStamp(now)}）。`,
			`- 候选集（宿主计算，模型不可指定）：${candidateSummary}`,
			`- 交接文档（§11.9.6，插件从 roster 事实生成的五硬节）：${document.path}（上一份：${document.previousDocument ?? "（无——本角色落盘的第一份）"}）——读不到的项在正文里逐条点名（**如实标未知**），没有编造任何内容；task-and-goal 一节填的是 goals 服务的读数（读不到才标未知）。`,
			// ★ 批 P · FR-P3 ②（prepare 回执）：与确认框正文、交接文档事实段**同一份三行**；
			// 审批档那一行再加一条落地读数（FR-P4 是创建返回之后设的，回执必须如实说设成了没有）。
			"- 继承清单（批 P：逐项；值或未继承原因）：",
			...inheritanceRowList(inheritance.rows).map((row) => `  - ${row}`),
			...(approvalApplication.line === null ? [] : [`  - ${approvalApplication.line}`]),
			titleLine,
			delivered
				? `投递（§11.4.5）：已用 followup 把令牌与交接正文投给 ${sessionId}（不是 inject——任务需要驱动；消息 source 仍恰三成员 {kind, form, senderSessionId}）。`
				: `投递失败（${deliveryError}）：令牌已生效但继任者没收到——可把交接文档 ${document.path} 与令牌重新交给它，或等 30 分钟超时清扫取消本次换届（§11.5）。`,
			`- 代价如实声明（§4.2 (c)）：继任者是**空上下文的新会话**——前任的历史/对话**不迁移**；信任也不在本次迁移，靠它本人凭令牌 claim 时逐项勾选（无人值守则 provisional + 24h 回退）。`,
			"- 生命周期（§10.2.5）：该会话的 AgentHandle 由插件持有——插件卸载/重载会把它的代理一起拆掉，会话仍在盘上；而它的 id 就是插件自建形，所以此后同类死亡都有 L1（revive）可走。",
			`- 审计留痕（§11.9.5⑦，三处）：① 版本史备注 ${row.note}；② ${mirrorNote(trails.mirror)}；③ 黑板 ${trails.decisions}`,
			...prepared.lines,
			"下一步（§11.4.4 → §11.4.6，claim 逐字不动）：把令牌与交接文档交给继任者会话，由它本人调用 team_link_rotate action=claim；claim 会再走一次人类确认（逐项勾选 pairs），无人值守则 provisional + 24h 回退。两道人类关卡 + 24h 回退网，不合并、不省略（§11.9.5）。",
			`- policy.writer 未动（仍是 ${teamAfter === null ? "（未知）" : teamAfter.policy.writer}）：恢复不改权限模型，也绝不把 writer 降级为 any（§11.9.5⑥）。`,
		],
	};
}

/** Token argument reading (§3.6.2): a one-time opaque string. The masked display
 * form `tok-xxxx…yyyy` is deliberately NOT accepted — it is a rendering, and the
 * whole point of the mask is that the rendering is not the token. */
function readRotationToken(value) {
	if (typeof value !== "string" || value.trim() === "") {
		return { error: "需要 token（prepare 返回的一次性令牌；掩码形式 tok-xxxx…yyyy 不是令牌）。" };
	}
	const token = value.trim();
	if (/[\u0000-\u001F\u007F\s]/u.test(token)) return { error: "token 不能包含空白或控制字符。" };
	return { value: token };
}

// ---------------------------------------------------------------------------
// §11.9.4 §11.9.5 — the `team_link_recover` tool
// ---------------------------------------------------------------------------

/**
 * The live recovery controller of one plugin context. It is deliberately tiny:
 * the audit row shape and the anti-storm window are pure helpers above, and the
 * ONE thing that has to be bound to a context is the liveness probe — the same
 * `agents.get(id) !== undefined` reading every other live face uses (§11.9.3).
 */
const RECOVERY_BY_CTX = new WeakMap();

function createRecovery(ctx, policy, rotation, teamSession) {
	return {
		policy,
		rotation,
		teamSession,
		handles: teamSession.handles,
		liveProbe: (sessionId) => agentIsLive(ctx, sessionId),
		hasHandle: (sessionId) => teamSession.hasHandle(sessionId) === true,
	};
}

/**
 * §11.9.5③'s zero-side-effect diagnostic: one row per role, so a caller can see
 * WHICH roles are in which emptiness before choosing a verb. It is a pure read
 * (it runs the sweep first, like every other roster touch, and writes nothing).
 */
function recoveryDiagnosticLines(team, now, isLive) {
	const lines = [`团队 ${team.name}：policy.writer=${team.policy.writer} · 角色 ${team.roles.length} 个`];
	for (const entry of team.roles) {
		const seat = entry.current === null ? VACANT_LABEL : isLive(entry.current) ? "有活代理" : `${SEATED_DEAD_LABEL}（无活代理）`;
		const pending = entry.pending === null || entry.pending === undefined ? "（无在飞令牌）" : `在飞令牌 → ${entry.pending.session}（${readStamp(entry.pending.expiresAt)} 到期）`;
		lines.push(`- 角色 ${entry.role}：${seat} · 现任 ${entry.current ?? "（无）"} · ${pending}`);
	}
	lines.push(`- 恢复入口：team_link_recover action=revive（复活当前 current 这个会话本身，仅插件自建会话，**任意角色**）或 action=reappoint（人改任：候选 = **本队活成员 ∪ 常驻的「${SELF_SUCCESSOR_LABEL}」**，由插件算出、人类勾选后走完整 M4 交接；宿主没有 agents.create 时选项里只剩活成员，两条路都没有才 fail-closed）。`);
	lines.push(`- 硬死锁只有一格：policy.writer=coordinator（默认）且死的是 coordinator（§11.9.1）。日常仍可通讯——黑板 team_link_team_append 与 team_link_send 都不经过 writerGate。`);
	lines.push(`（读数 ${readStamp(now)}，${READ_STALE_NOTE}）`);
	return lines;
}

/**
 * §11.9.4's recovery tool. Registered like every other tool, with the two verbs
 * in ONE place so «恢复只有 revive / reappoint» has a single auditable landing
 * point — which is the whole reason the design refused to hang these on
 * `team_link_rotate` or `team_link_roster` (different actors, different
 * preconditions).
 */
function registerRecoveryTools(ctx, policy, rotation, controller, teamSession) {
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_recover",
		description: [
			"团队恢复（§11.9.4）。用途：某角色的现任「有席位但无活代理」（seated-dead，最常见的原因是插件重载/DSH 重启把插件自建会话的代理拆了），roster 写与换届就此卡住——本工具是那条窄恢复路径。**恰两个封闭动词**：",
			"action=revive：用 ctx.agents.resume 复活**当前 current 这个会话本身**（身份不变、roster 不动、信任零改动）。**受理任意角色**（§4.2 (a)）：重载拆掉的是**所有**插件自建会话，不只 coordinator 的，而 revive 既不写 roster、不铸令牌、不动 pairs/trustedSenders/rememberTargets、也不碰 policy——放开角色面不会把它变成通用 roster 编辑器。只对本插件创建的会话开放（id 形如 team-link-<team>-<role>-<uuid8>，或本进程仍持有它的 AgentHandle）；人类自建的会话只输出深链指引——resume 的 ownerCtx 是插件根 ctx，对人类会话做 revive 会把它的生命周期从 UI 转给插件，比现状更差。resume 拿到的是宿主自己那条 resume 路径的三样（resumeSessionId + agentOptions + setup，真机缺陷 #5）：模型选择与这个会话自己存下来的 preset 组装源一起装上，组装不出来就**拒绝恢复**（零 resume、零写入），绝不留下一个第一回合就死在 `prompt variable \"{{model}}\" has no value` 的代理。resume 不可用（无 factory / 无 sessionPersistence）或抛错 → fail-closed 报告，零改动。",
			"action=reappoint：现任不会/不应再回来时的「人改任」= 人类对话授权的 prepare。候选 = **本队活成员 ∪ 常驻的「自建继任者（新建会话）」**（§4.2 (c)），由**插件**算出并作为对话框选项呈现（模型只传 team，可选 role，**不能指定任何继任者 id**——合成候选连 id 都还没有，它由插件在人类勾选之后才铸）；人类勾选后逐字走既有 M4：铸一次性令牌绑定 (team, role, successor)、把待迁移信任快照进 rotationBackup、广播 rotation-freeze；随后由继任者本人凭令牌 claim（claim 逐字不动，不新增令牌类型）。能力闸门只约束**自建继任者**这条支路，不在动词入口（§4.2 (c) ①）：宿主没有 agents.create ⇒ 弹框照开、只是候选里**不出现**「自建继任者」（只列活成员——活成员改任不需要该服务），**仅当连一个活成员候选都没有**时才 fail-closed 报告且零弹框。选「自建继任者」时的链路逐条复用既有机制：按 §10.2.2 铸 id（team-link-<team>-<role>-<uuid8>）→ 交接文档由**插件从 roster 事实**生成五硬节（读不到的项**如实标未知**，不编造；task-and-goal 一节填 goals 服务的读数，读不到才标未知）→ prepare 逐字跑 → 审计行 verb=reappoint → 用 followup 把令牌与交接正文**投给刚建出的继任者**（与 successor:\"auto\" 同一条投递语义：不是 inject，任务需要驱动）。代价如实声明：继任者是**空上下文的新会话**，历史不迁移；信任靠它 claim 时逐项勾选迁移。",
			"硬约束（§11.9.5，八条）：① 动词封闭，不接受任意 roster 字段写入，**不改 policy.writer**；② attended-only——必须有人在对话框里点一下，**刻意没有 provisional / 无人值守变体**，无确认服务即 fail-closed；③ 候选由插件算、模型不可指定；④ revive 只绑**当前** current（不存在「复活任意历史会话」的动词，否则对称吊销形同虚设）；⑤ writerGate 原样不动；⑥ **绝不把 policy.writer 降级为 any 当作「修复」**（那是对团队的静默弱化）；⑦ 限速（与换届同一个 10 分钟窗口）+ 三处留痕（版本史备注 recovery(...) / roster.md 镜像 / decisions.md 追加——黑板无门，死锁下也能落账）；⑧ 进入即先跑既有过期清扫。另有写时复检（TOCTOU）：对话框弹出时与落笔前各重查一次现任活性，现任已复活则中止。",
			"角色面（★ 两个动词的域**不同**，照实现写）：**两个动词都受理任意角色**（§4.2 (a) 放开了 revive 的角色门；`reappoint` 从来就是任意角色——授权从不源自 coordinator 身份，唯一来源是对话框里人类那一下点击，§11.9.5）。它们的差别在**动词语义**上，不在角色上：`revive` = 身份不变的复活（同一个会话 id，零写）；`reappoint` = 换人（铸令牌 + 快照 + 冻结，走完整 M4 交接）。那条角色窄域是**范围最小化选择、不是安全属性**（§11.9.1 只论证过「死的 coordinator 必须可救」，从未论证「死的 worker 不许救活」），而重载拆掉的是所有插件自建会话——所以它被放开了。不带 role 时只输出诊断（每角色一行：现任 + 活性 + 在飞令牌），零副作用。",
			"发起域（§11.9.5 的「发起 ≠ 授权 ≠ 复权」）：**发起者**只能是团队**现任成员**，或该角色**最近一任前任**（旧任上下文最完整，「回聘旧任」本就是最自然的恢复；发起权不依赖信任、只依赖身份资格）。域外的会话被拒绝，拒绝文案点名现任成员集合、该角色的前任与调用会话，并指出设置 UI（用户在那里是超级写者）仍是永远可用的出口。**代价如实声明**：不属于本队的活会话不能发起恢复——这是有意的收窄；带 role 的诊断读态不受此限（它零写入）。",
		].join("\n"),
		parameters: {
			action: { type: "string", required: true, enum: ["revive", "reappoint"], description: "revive（复活当前 current 会话本身，仅插件自建会话，任意角色）/ reappoint（人改任：人类对话授权的 prepare，候选 = 本队活成员 ∪ 常驻的「自建继任者」）" },
			team: { type: "string", required: true, description: "团队名（[a-z0-9-]+，须已在 roster 中）" },
			role: { type: "string", description: "要恢复的角色名（约定角色名 coordinator；两个动词都受理任意角色——revive 复活同一个会话、reappoint 换人，差别在动词不在角色；不带 role 时只输出诊断，零副作用）" },
		},
		output: textOutput(),
		// Same budget as the rotate tool: the confirmation dialog may legitimately
		// wait ROTATION_CONFIRM_TIMEOUT_MS for a present human.
		timeoutMs: 300000,
		async execute(args, exec) {
			try {
				const action = typeof args.action === "string" ? args.action : "";
				if (!RECOVERY_ACTIONS.has(action)) return wellFormed(`恢复失败：action 必须是 revive 或 reappoint（封闭动词集，§11.9.5①）——恢复刻意只有这两个动作，不存在通用 roster 写入。`);
				const name = readTeamName(args.team);
				if (name.error !== undefined) return wellFormed(`恢复失败：${name.error}`);
				const caller = agentSessionId(exec);
				const now = Date.now();
				// §11.9.5⑧: the entry sweep, awaited, so this call can never interleave
				// with a token that is still in flight.
				const swept = await rotation.sweep({ now, signal: exec.signal });
				const preamble = swept.lines.length === 0 ? [] : ["恢复入口先跑既有过期清扫（§11.9.5⑧）：", ...swept.lines, ""];
				const view = policy.get();
				const team = view.teams.find((entry) => entry.name === name.value) ?? null;
				if (team === null) {
					return wellFormed([...preamble, `恢复失败：团队 ${name.value} 不在注册表中（先用 team_link_roster action=upsert-team 创建）。`].join("\n"));
				}
				// The zero-side-effect read mode: no role → a diagnosis, not an action.
				if (args.role === undefined || args.role === null || args.role === "") {
					return wellFormed([...preamble, "恢复诊断（**本次调用自身**零副作用——不看入口清扫、不弹确认框、不 resume、不铸令牌、不写任何状态；见 §11.9.5⑧：若上面报了它清的过期令牌，那是清扫按既有语义做的真写入）：", ...recoveryDiagnosticLines(team, now, (id) => controller.liveProbe(id)), "", `下一步：${recoveryBoundaryText()}`].join("\n"));
				}
				const role = readRoleName(args.role);
				if (role.error !== undefined) return wellFormed(`恢复失败：${role.error}`);
				// §11.9.5's INITIATOR domain (差异审计 Y2; design line 469). It is
				// answered here, in the instrumented handler, and NOT inside the two
				// verbs: this is the only point that is upstream of BOTH verbs and
				// downstream of the zero-side-effect read mode, which is exactly the
				// boundary the design draws — the domain must refuse BEFORE a session is
				// created, a token is minted or a freeze is broadcast, and the read mode
				// stays open to anybody (it writes nothing).
				const initiator = initiatorAllowsRecovery(team, role.value, caller);
				if (initiator !== true) return wellFormed([...preamble, initiator.error].join("\n"));
				const outcome = action === "revive"
					? await reviveIncumbent({ ctx, policy, rotation, controller }, { teamName: name.value, roleName: role.value, caller, agent: exec.agent, signal: exec.signal, now })
					: await reapIncumbent({ ctx, policy, rotation, controller }, { teamName: name.value, roleName: role.value, caller, agent: exec.agent, signal: exec.signal, now });
				if (outcome.error !== undefined) return wellFormed([...preamble, outcome.error].join("\n"));
				if (outcome.refused !== undefined) return wellFormed([...preamble, outcome.refused].join("\n"));
				return wellFormed([...preamble, ...outcome.lines].join("\n"));
			} catch (error) {
				return wellFormed(`恢复操作失败：${describeError(error)}`);
			}
		},
	})), "team-link: recovery tool");
}
// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------
// ★ 批 R 第 6 小单（域拆分）：`registerTools(ctx, policy, watchdog, chainReport, forensics)` 连同它的
//   文档注释**原样搬进** `lib/registration.js`（那一块逐字节未改，只多了签名前的 `export `）；本档
//   模块尾部那条 `wireRegistration(registrationExtras())` 给它注入 52 条入口侧出口（逐组归属见上面
//   那个装配器的档头）。这里只留指路注释 —— 横幅仍指着同一个域，只是正文换了住处；
//   `registerTeamTools` / `registerRotationTools` / `registerRecoveryTools` / `registerReadRoutes`
//   与它们各自的文档注释都还在下面，一行未动。
//   ★ 批 R 第 7 小单：`registerTeamTools` **仍在下面**，但它体内 `team_link_roster` 那一条注册语句
//   已**逐字节**搬到 `lib/team-registration.js`（`registerRosterTool`）——本档在**同一位置**调用它，
//   注册顺序与工具面逐字不变。
//   ★ 批 R 第 8 小单：`team_link_team_read` 那一条也已**逐字节**搬到 `lib/team-ledger-tools.js`
//   （`registerTeamLedgerTools`），同样在**同一位置**（roster 之后、append 之前）调用；该体内现在
//   **只剩** `team_link_team_append` 一条（它这一单没搬的原因，见那个域档档头的第 ① 条）。

// ---------------------------------------------------------------------------
// web export route (consumed by the conversation-header export button)
// ---------------------------------------------------------------------------

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
function exportGateRejection(connection, req) {
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
function modeConclusionLine(shownTeams) {
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
function panelBadgeOf(sessionId, teams, projection) {
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
async function buildPanelPayload(ctx, policy, options = {}) {
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
function registerReadRoutes(ctx, policy) {
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

/**
 * Host plugin body: deep-link resolution (upstream), the three -pro tools, and
 * the web export route.
 * @param ctx - plugin context carrying the injected services.
 */
function apply(ctx) {
	// §9.1.3 调用点迁移：the one-time legacy migration is driven by the policy
	// store itself, from inside `attach` — calling it here would (as it did
	// before this fix, silently) run against a namespace that is not registered
	// yet whenever the settings provider is still initialising.
	const policy = createPolicyStore(ctx);
	POLICY_BY_CTX.set(ctx, policy);
	// §10.2 ②: the batch controller holds every AgentHandle this command creates
	// (that is why it is built from THIS context — the plugin's own, §10.2.5) and
	// the command itself is registered through the OPTIONAL `commands` injection.
	// §11.4.2 reuses it: `successor:"auto"` creates the successor from this same
	// root context and holds its handle here, so it must exist before the rotate
	// tool is registered. It also answers §11.5's "did the plugin build this
	// session?" question for the expiry sweep, which is why the rotation
	// controller gets that predicate (the handle registry IS the honest witness).
	const teamSession = createTeamSession(ctx);
	TEAM_SESSION_BY_CTX.set(ctx, teamSession);
	// The M4 controller is built first among the team faces: the watchdog patrol
	// carries its expiry sweep, and the roster/rotate tools call it lazily.
	//
	// §11.5's naming predicate is a DURABLE reader (`successorOwnershipOf`): a
	// plugin reload drops every handle in `teamSession` while the hand-over
	// document and the pending-create intent stay on disk, so the handle registry
	// is handed over as CORROBORATION (`hasHandle`) rather than as the answer.
	// The reading it replaces was the reason the naming line vanished in exactly
	// the window the design put it there for.
	// FR-1/FR-2（批 2）: 段控制器先建（它只依赖 ctx + policy）—— rotation 需要一个「名册落定」
	// 回调：换届 claim 是唯一一处**不经 roster 工具**改现任的写入路径。
	const sections = createSections(ctx, policy);
	SECTIONS_BY_CTX.set(ctx, sections);
	// ★ 批 D（FR-1 §6.3）: **自愈钩子** —— 「名册想要、但还没挂上」的会话，在它自己的下一次
	// `agent/pre-step` 上被补挂。这正是 D-1 的修法：重启后 attach 那一刻若没有任何会话活着，
	// 注册数为 0；此后某个团队会话被打开（成为活代理）时**没有人**再调 sync —— 于是它永远拿不到
	// 角色文本与资源读数，要等到下一次名册写入。挂上这条钩子后，「打开团队会话」这一步自己就把
	// 段与上下文补齐，**不需要人肉跑任何命令**（US-D1 / U1）。
	//
	// 形状与纪律（逐条对应 §6.3）：
	//   · 与 registerDeepLinks 的监听器**并列**：宿主的事件面本就是「一个事件名一个监听器数组」
	//     （cordis@4.0.1 `src/events.ts:132` `_hooks: Record<keyof any, Hook[]>`；`waterfall` 在
	//     `:234-243` 逐个 shift 串起来），多个监听器共存是它的构造性事实，既有那条**逐字未动**。
	//   · 热路径 O(1)：`needsSync` 是两道查表 ⇒ 非名册会话（绝大多数）零扫描（NFR-2 / U2）。
	//   · 命中才 sync（幂等）；失败 fail-open：只经一次性门留一行 warn，**绝不改变 next() 的决定**
	//     （NFR-3 / U1b）。sync 走 `sections.sync()`（属性取用）而不是解构出来的函数引用 ——
	//     判据 U2 要能对 `sync` 打桩计数。
	ctx.on("agent/pre-step", async ({ agent }, next) => {
		try {
			if (sections.needsSync(agent?.session?.header?.id)) sections.sync();
		} catch (error) {
			sections.warnSelfHealOnce(error);
		}
		return next();
	});
	const rotation = createRotation(ctx, policy, {
		...rotationExtras(),
		hasHandle: (sessionId) => teamSession.hasHandle(sessionId) === true,
		onRosterSettled: () => sections.sync(),
	});
	ROTATION_BY_CTX.set(ctx, rotation);
	// ★ 批 K（FR-K1）: 崩溃现场控制器 —— 在 watchdog 之前建，好让巡逻那一拍（FR-K2）拿到它。
	const forensics = createForensics(ctx, policy);
	FORENSICS_BY_CTX.set(ctx, forensics);
	const watchdog = createWatchdog(ctx, policy, rotation, sections, forensics);
	WATCHDOG_BY_CTX.set(ctx, watchdog);
	// ★ FR-17（批 7）: 最近一次 attach 后置链的读数（进程内存，零写盘）—— 见 {@link chainReportLine}。
	const chainReport = { at: null, rearm: null, sections: null, ensure: null };

	// FR-7（自治设计档 §5 · 判据 U12）：attach 时重挂。激活时 `start()` 已经挂过一轮，
	// 但**策略 store 的晚挂与快路径折叠都发生在 activation 之后** —— 那两条路上
	// `policy.get()` 在 activation 那一刻还是空的（服务还没来 / 折叠还在飞），于是持久化的
	// 注册在整个进程里没有定时器（症状：重启后是哑的）。store 每次 attach 落定都回调一次，
	// 把定时器补上（`rearm` 幂等）。
	//
	// ★ FR-17（批 7）：这一函数同时是**读面的唯一写者** —— 三档各自的读数落进 chainReport（进程内存、
	// 零写盘），由 team_link_status 读一行出来。真机两次排查都卡在「后置链做了什么不可见」上：本部署
	// `ctx.logger?.warn?.` 是空操作，warn 这条路等于没有。**FR-16 的因果仍待证**（rearm 已证实生效；
	// 补挂零写入是「没被到达」还是「每队 skip/throw」，要靠这一行下一轮真机读数判）。
	policy.onAttach(() => {
		const chainAt = Date.now();
		chainReport.at = chainAt;
		chainReport.rearm = watchdog.rearm();
		// 设计档 FR-2 行「注册钩子两条路径」的②：attach 时扫 roster 重建（重启后既有 worker）。
		chainReport.sections = sections.sync();
		// ★ FR-10（批 5）：同一时机**按队补挂** auto 工作台注册 —— 老团队（建队早于 auto 注册存在）
		// 由此吃到工作台摘要。fire-and-forget + catch：fail-open，绝不拖 attach 链（只留一行 warn）；
		// 无论成败都写回 chainReport（FR-17：抛错要报 failed，不许静默）。
		chainReport.ensure = { pending: true };
		Promise.resolve()
			.then(() => ensureTeamAutoWatchdogs(ctx, policy, watchdog))
			.then((reports) => { chainReport.ensure = summarizeAutoWatchdogs(reports); })
			.catch((error) => {
				chainReport.ensure = { ...summarizeAutoWatchdogs([]), threw: true, error: describeError(error) };
				ctx.logger?.warn?.(`${PLUGIN_LABEL}: attach 按队补挂工作台注册失败（${describeError(error)}）—— attach 链不受影响（fail-open）`);
			});
	});
	// §11.9.4/§11.9.5: the recovery controller. It is its own WeakMap-bound object
	// (not a method on the rotation controller) because "which liveness reading this
	// context takes" is the only thing it owns — everything else it does is a call
	// into the published M4 mechanism.
	const recovery = createRecovery(ctx, policy, rotation, teamSession);
	RECOVERY_BY_CTX.set(ctx, recovery);
	registerDeepLinks(ctx);
	registerTools(ctx, policy, watchdog, chainReport, forensics);
	registerTeamTools(ctx, policy, rotation, sections);
	registerRotationTools(ctx, policy, rotation, teamSession, sections);
	registerRecoveryTools(ctx, policy, rotation, recovery, teamSession);
	registerReadRoutes(ctx, policy);
	// §10.2 ② `/team_session` and §11.2 `/team_rotate` ride ONE optional seam: a
	// shell without the `commands` service loses both commands, keeps every other
	// face, and gets exactly one warn line for the window (§10.2.1).
	const commandsSeam = createCommandsSeam(ctx, [TEAM_SESSION_COMMAND, TEAM_ROTATE_COMMAND]);
	registerTeamSessionCommand(ctx, policy, rotation, teamSession, commandsSeam, watchdog, sections);
	registerTeamRotateCommand(ctx, policy, rotation, commandsSeam);
	// §10.2.6 orphan guard: report the `pending-creates` intents that outlived
	// their TTL before this activation, so a create that crashed mid-loop is a
	// list the user can act on rather than a silent orphan.
	void sweepPendingCreates(ctx, policy)
		.then((outcome) => {
			if (outcome.lines.length === 0) return;
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: pending-create 启动清扫 —— 可收编清单：\n${outcome.lines.join("\n")}`);
		})
		.catch((error) => {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: pending-create 启动清扫失败（${describeError(error)}）`);
		});
	// The patrol timers are this plugin's only background work, so they are armed
	// inside one effect: disposing the plugin (unload, reload, config teardown)
	// disposes every timer and the process-local tick state with it.
	ctx.effect(() => watchdog.start(), "team-link: watchdog patrol timers");
	// ★ 批 K · FR-K1：首拍在 **activation**（开本次 bootId 目录 + 原子写第一拍；FR-K5 的兜底
	//   定时器随之决定挂不挂）。为什么是这里而不是 `policy.onAttach` 的后置链：那一链在
	//   「文件为空 / 无文件」的本部署形态下一次都不会跑（见 {@link createForensics} 的 `start`）。
	//   fire-and-forget + catch：它**不在任何热路径上**，失败也只留一行 warn（NF-K4）。
	void forensics.start().catch((error) => {
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: 心跳启动失败（${describeError(error)}）—— 取证是观测，绝不影响功能`);
	});
	// 心跳的生命周期与看门狗定时器同一条纪律：插件卸载/重载就把它的定时器收掉（**不删任何文件**）。
	ctx.effect(() => () => forensics.dispose(), "team-link: crash forensics heartbeat");
	// 段的生命周期与看门狗定时器同一条纪律：插件卸载/重载就把它们的 disposer 全跑掉（U4 的另一半）。
	ctx.effect(() => () => sections.disposeAll(), "team-link: role sections");
}

// ★ 批 R · FR-R1：域档 `lib/forensics.js` 复用的五个共享物**经装配缝注入**（同一批绑定、同一份
// 实现，模块图单向：入口 → 域档）。为什么不是「入口再导出、域档静态导入」：那会构成 ESM 环，
// 实跑当场 TDZ（`Cannot access 'FORENSICS_KEEP_BOOTS' before initialization`）——拆分契约
// §6 第 ③ 条「模块图无环」正是要挡这个；而 `package.json` 的 `main` / `exports` 一字未动 ⇒ 对外
// 契约（`apply` / `inject` / `name` 三个名字在下一条语句）不变。
wireForensics({ PLUGIN_LABEL, describeError, readStamp, resolvePolicyFilePath, writePolicyFileAtomic });
// ★ 批 R 第 6 小单：域档 `lib/registration.js` 的 52 条入口侧出口走同一条纪律（同一批绑定、同一份
// 实现，模块图仍是单向：入口 → 域档 → 共享/黑板/换届/段四档）。见上面 `registrationExtras()`。
wireRegistration(registrationExtras());
// ★ 批 R 第 7 小单：域档 `lib/team-registration.js` 的 44 条入口侧出口走同一条纪律（同一批绑定、
// 同一份实现，模块图仍是单向：入口 → 域档 → 共享/黑板/换届/段四档）。见上面 `teamRegistrationExtras()`。
wireTeamRegistration(teamRegistrationExtras());
// ★ 批 R 第 8 小单：域档 `lib/team-ledger-tools.js` 的 8 条入口侧出口走同一条纪律（同一批绑定、
// 同一份实现，模块图仍是单向：入口 → 域档 → 共享/黑板两档）。见上面 `teamLedgerToolsExtras()`。
wireTeamLedgerTools(teamLedgerToolsExtras());
// ★ 批 R 第 10 小单：域档 `lib/policy-store.js` 的 9 条入口侧出口走同一条纪律（同一批绑定、
// 同一份实现，模块图仍是单向：入口 → 域档 → 屏蔽/换届/共享三档）。见上面 `policyStoreExtras()`。
wirePolicyStore(policyStoreExtras());
// ★ 批 R 第 11 小单：域档 `lib/messaging.js` 的 7 条入口侧出口走同一条纪律（同一批绑定、同一份实现，
// 模块图仍是单向：入口 → 域档 → 共享/换届/屏蔽/落点四档）。见上面 `messagingExtras()`。
wireMessaging(messagingExtras());
// ★ 批 R 第 12 小单：域档 `lib/watchdog.js` 的 27 条入口侧出口走同一条纪律（同一批绑定、同一份实现，
// 本档两条出边 = 共享 / 段两档，都不回指入口）。见上面 `watchdogExtras()`。
wireWatchdog(watchdogExtras());
// ★ 批 R 第 13 小单：域档 `lib/recovery.js` 的 12 条入口侧出口走同一条纪律（同一批绑定、同一份实现，
// 本档三条出边 = 共享 / 黑板 / 换届三档，都不回指入口）。见上面 `recoveryExtras()`。
wireRecovery(recoveryExtras());
// ★ 批 R 第 14 小单：域档 `lib/team-session-creation.js` 的 11 条入口侧出口走同一条纪律（同一批绑定、
// 同一份实现，本档三条出边 = 共享 / 落点 / 换届三档，都不回指入口）。见上面 `teamSessionCreationExtras()`。
wireTeamSessionCreation(teamSessionCreationExtras());
export { apply, inject, name };

/**
 * Internal surface for `host-half.test.mjs` only: the pure liveness/verdict
 * helpers, the live watchdog controller of a context, the pure roster /
 * blackboard helpers of §3.3, and the M3 broadcast helpers of §3.4/§3.5
 * (address resolution, envelope reading, busy guidance). Nothing else imports
 * it — the model-facing surface is exactly the registered tools.
 */
export const __testing = Object.freeze({
	/** §4.1 ②'s fence decision (批次 1). The download route's whole trust story is
	 * this one pure function plus the mount-time pair check above it, so the
	 * acceptance criterion reads the decision itself instead of standing up an
	 * HTTP fixture (U1). */
	exportGateRejection,
	/** §C1 只读面板路由的路径常量（夹具按它找路由，不重新拼字符串）。 */
	PANEL_ROUTE_PATH,
	/** §C1 面板载荷的**纯**构造器（只读）：夹具直接驱动它，判据因此读的是数据本身。 */
	buildPanelPayload,
	/** §C1 收敛后的**会话面状态词**（「一处事实一处渲染」）：判据读的是这一处真函数，不抄一份
	 * 进测试 —— 分歧审计 🔵#5 要钉住的是 `agent === null` 那一档（**行为修正**）。 */
	agentStateLabel,
	/** §C1 面板段顶那句档位结论（措辞复用 TEAM_MODE_CONCLUSION）。 */
	modeConclusionLine,
	verdictOf,
	buildLivenessSignal,
	readGoalSignal,
	buildWatchdogRegistration,
	tickMessage,
	/** FR-3b 的两条**纯**读数（判据直接读真函数，不抄一份进测试）：分组分类器与正文渲染器。 */
	classifyWatchdogTargets,
	/** 批 2（FR-1/FR-2）＋批 C 的**纯**渲染读数 + 段控制器：判据直接读真函数，不抄一份进测试。
	 *  批 C 把段渲染体拆成两个：`renderRoleText`（段面，只产会话期内恒定的文本）与
	 *  `renderResourceContext`（上下文面，资源行本体）。 */
	renderCharterLines,
	renderWorkerDutyLine,
	renderResourceLine,
	renderRoleText,
	renderResourceContext,
	CHARTER_MAX_LINES,
	/** 批 3（FR-5/FR-6）的纯读数 + 段体：判据直接读真函数。 */
	readSessionUsage,
	budgetRowLine,
	rotateCandidateOf,
	budgetVerdictLine,
	budgetSectionLines,
	/** FR-17（批 7）的后置链读面：纯渲染器 + 四态压缩器（U27 直接读真函数：正常 / 整轮抛错 / 
	 * 尚未落定 / 尚无记录 四档各有一句，判据不抄一份进测试）。 */
	chainReportLine,
	summarizeAutoWatchdogs,
	charterReinforceLine,
	isIncumbentCoordinator,
	BUDGET_SECTION_MAX_LINES,
	watchdogDigestActionable,
	renderWatchdogDigest,
	/** ★ 批 J · FR-J1：「有活没派」告警档的两条**纯**读数（判据直接读真函数，不抄一份进测试）——
	 *  开场标记与正文渲染器；`IDLE_ALERT_MAX_PER_EPISODE` 是它自己的每段投递上限。 */
	WATCHDOG_IDLE_ALERT_LABEL,
	renderIdleAlert,
	IDLE_ALERT_MAX_PER_EPISODE,
	/** ★ 批 J · FR-J2：压力告警档的同一族读数面 —— 具名阈值（★ 用户裁定 = 50）、它的开场标记、
	 *  正文渲染器与**档位函数**（判据读真值，不抄一份进测试；设计档 §6「新增符号」）。 */
	LIAISON_PRESSURE_WARN_PERCENT,
	WATCHDOG_PRESSURE_ALERT_LABEL,
	renderPressureAlert,
	bucketOf,
	/** FR-3a 的纯规划器（创建/顺延一条 auto 注册；写入由调用方走 policy.update）。 */
	planAutoWatchdog,
	/** t-14 B: 失败隔离的两段文案（update 失败 / schedule 失败）各自的纯读数面。 */
	armTeamWatchdog,
	/** FR-3 的两档来源字面量（夹具按它们种 auto / manual 行）。 */
	WATCHDOG_ORIGIN_MANUAL,
	WATCHDOG_ORIGIN_AUTO,
	watchdogFor: (ctx) => WATCHDOG_BY_CTX.get(ctx),
	/** FR-1/FR-2 的段控制器（注册表 + sync 读数），夹具按它断言 U2–U4。 */
	sectionsFor: (ctx) => SECTIONS_BY_CTX.get(ctx),
	/** FR-16 的策略 store 读数面（U26 的计数处理器挂在它上面；见 {@link POLICY_BY_CTX}）。 */
	policyFor: (ctx) => POLICY_BY_CTX.get(ctx),
	/** ★ 批 34 / FR-7：写门开关的**声明面本身** —— 判据 A-7④ 用它钉「非法值被 zod 拒」。
	 *  注册出去的 `team-link` 命名空间用的就是这一个对象，所以判据读的是真声明、
	 *  不许在测试里另抄一份形状（与 `CHARTER_MAX_LINES` / `LIAISON_PRESSURE_WARN_PERCENT`
	 *  同一条纪律）。 */
	PolicyConfig,
	/** ★ 批 K 的崩溃现场（心跳）控制器：判据读的是**真控制器**的读数（拍号 / 落点 / 上一次那一拍 /
	 *  兜底定时器），不抄一份进测试。同批开放的两条缝：
	 *   · `setDiskSpaceReader` —— U10 的诚实路径（桩成 reject ⇒ `disk.free/total` **恰为 null**；
	 *     `node:fs/promises` 的内建绑定在 ESM 里不可改写，所以这条判据需要一条显式缝）；
	 *   · `diskSpaceReaderIsDefault` —— 让「跑完 U10 必须还原」这件事可核（否则后面的判据会在一个
	 *     坏掉的读盘器上跑出假绿；与 `stripImplIsDefault` 同一纪律）。
	 *  ★ 批 R（FR-R1）：这两条缝的实现随域搬进了 `lib/forensics.js`（本文件按名导入）——
	 *  **对外名字 / 签名 / 语义一字不变**，判据面读到的仍是同一对函数。 */
	forensicsFor: (ctx) => FORENSICS_BY_CTX.get(ctx),
	setDiskSpaceReader,
	diskSpaceReaderIsDefault,
	/** ★ 批 L（FR-L2）的可注入改名接缝：`writePolicyFileAtomic` 的改名**只经** `renameThroughSeam`，
	 *  判据替换这一层即可注入 `EPERM` / `EBUSY`（`node:fs/promises` 是内建模块、ESM 绑定不可改写
	 *  —— 与 `setDiskSpaceReader` / `setStripImpl` 同一条理由）。`null` ⇒ 还原默认实现；
	 *  `renameThroughSeamIsDefault()` 让「跑完必须还原」这件事可核（同 `diskSpaceReaderIsDefault`）。 */
	setRenameThroughSeam: (fn) => { renameThroughSeam = typeof fn === "function" ? fn : renameThroughSeamDefault; },
	renameThroughSeamIsDefault: () => renameThroughSeam === renameThroughSeamDefault,
	FORENSICS_KEEP_BOOTS,
	FORENSICS_FALLBACK_INTERVAL_MS,
	normalizeTeams,
	/** 角色行的**规范形状**（§3.3.2 的字段序）：夹具要断言「其它角色逐字未动」，就得先按
	 * 这个形状种下去 —— 否则量到的是「读时归一化补字段」，不是「谁动了谁的账」。 */
	roleRecord,
	writerGate,
	retireGate,
	applyTeamUpsert,
	applySetRole,
	applyRetire,
	tenureStartOf,
	renderRosterMirror,
	trustReferencesTo,
	readBlackboardLine,
	blackboardHash,
	lastDecisionSeq,
	decisionRow,
	readMeta,
	metaBannerFields,
	/** ★ 批 I（屏蔽的作用域）的判据面 —— 设计档 §6 的五个函数**本身**（判据直接读真函数，
	 *  不抄一份进测试）：`blockPair`（规范化，U2/U3）· `isBlocked`（接收方视角的并集判定，
	 *  U1/U4/U5/U16）· 三个写路径（`blockSender` 的幂等 U3 / `unblockPair` 的权限 U14 /
	 *  `clearLegacy` 的权限三态 U18），以及 U19 的落点不变量（夹具对 `policyFor(ctx)` 拿到
	 *  的那个 store 数 `policy.update` 笔数）。工具面自己的判据仍走 `team_link_block`。 */
	blockPair,
	isBlocked,
	blockSender,
	unblockPair,
	clearLegacy,
	resolveTargets,
	resolveTargetList,
	targetLabel,
	busyGuidance,
	readRoleName,
	pairRecordBetween,
	/** The controller `apply` built for this context — or, when `extras` is given,
	 * a §11.5 fixture's controller over the SAME context and policy with the
	 * caller's readings substituted (the live plugin never takes this branch).
	 * The fresh `createPolicyStore(ctx)` reads the same settings namespace as the
	 * one `apply` built, so a fixture changes the READINGS, never the state. */
	rotationFor: (ctx, extras = undefined) => (extras === undefined
		? ROTATION_BY_CTX.get(ctx)
		: createRotation(ctx, createPolicyStore(ctx), { ...rotationExtras(), ...extras })),
	/** The §11.5 ownership reading, exposed so the durable sources can be asserted
	 * directly (and so a §11.5 fixture can present a reloaded window). */
	successorOwnershipOf,
	successorOwnershipIndex,
	handoffDocumentNamesSuccessor,
	handoffDocumentNamesLatest,
	ownershipEvidenceLabel,
	maskToken,
	rotationRateLimited,
	rotateGate,
	teamMembers,
	planRotationMigration,
	applyRotationTrust,
	settleRotation,
	clearRotationPending,
	freezeNotice,
	doneNotice,
	cancelledNotice,
	expiredNotice,
	/** §10.2 ② surface: the parser/plan/authorization helpers, the per-context
	 * batch controller (handle ownership), and the §10.2.6 pending-create sweep. */
	readTeamSessionCommand,
	teamSessionDefaultTeam,
	/** §10.2.8.9 ① / U35 夹具缝：注入「当天」时间戳（不靠墙钟），传 undefined 还原。 */
	teamSessionInjectNow,
	/** §10.2.8.9 ② 的判据面：证据门（甲/乙两形状各自成支）、释放动作、两处具名文案
	 * （版本史备注与那句披露 —— 字面量 11 码点，设计档原写 12，勘误见 §10.2.8.9 ②）。
	 * 夹具读的是**真函数**，不抄一份进测试。 */
	teamSessionReleaseVerdict,
	applyTeamSessionRelease,
	TEAM_SESSION_RELEASE_NOTES,
	TEAM_SESSION_RELEASE_DISCLOSURE,
	/** §10.2.8.10 ① 的判据面：回执的四个形状（成功 / 失败 / 取消 / 解析前失败）与它
	 * 那条 120 码点的上界。 */
	teamSessionReceiptText,
	teamSessionReceiptOf,
	TEAM_SESSION_RECEIPT_MAX_POINTS,
	TEAM_SESSION_ROLE_GUIDANCE,
	TEAM_SESSION_DIALOG_MAX_CODE_POINTS,
	TEAM_SESSION_DIALOG_MAX_NEWLINES,
	TEAM_SESSION_DIALOG_LIST_ROWS,
	TEAM_SESSION_DIALOG_TASK_CHARS,
	/** §10.2.8.4 (b) 的**标注两档**（具名常量）：只为「档位长度」的读数开放 —— N=1 时全档
	 * 21 码点、最小档 11 码点，各另加 1 换行。测试量的是这两个常量本身，不是某个用例的巧合。 */
	TEAM_SESSION_DIALOG_CROP_NOTE_TIERS,
	teamSessionPlan,
	teamSessionDialogText,
	teamSessionId,
	withTeamSessionPairs,
	/** §10.2.2 的创建选项构造器本身，只为「半条路由」的读数开放：`model=` 的文法只可能
	 * 给出「两侧都给」或「只给 model」两种形状，而「只给 provider」那半条路由也必须被一个
	 * **真判据**咬住（模型侧能端到端跑一条命令，provider 侧只能直接驱动这个真实函数——
	 * 不是另写一个解析器，否则锁的是复制品）。 */
	buildTeamSessionCreateOptions,
	/** 批 P · FR-P1 的继承读取器本身（与 `buildTeamSessionCreateOptions` 同一个理由开放：
	 * 它的两条**读不到 ⇒ `null`** 与「**已死前任仍可继承预设**」（探针 3 的会话级冷读面）
	 * 分支，可以由确定的输入直接驱动**真函数**来核对 —— 不必为了验一次读取去搭一条完整
	 * 的换届链，也不必另写一个复制品）。 */
	readInheritableSettings,
	teamSessionFor: (ctx) => TEAM_SESSION_BY_CTX.get(ctx),
	teamSessionKickoffText,
	sweepPendingCreates,
	pendingCreateList,
	/** §11.9.6 surface: the hand-over document contract (three layers, the
	 * five-hard-section ladder, the shared fact source) and its writer. */
	HANDOFF_HARD_SECTIONS,
	HANDOFF_SOFT_SECTIONS,
	HANDOFF_SECTION_HINTS,
	normalizeHandoffSection,
	parseHandoffBody,
	handoffBodyReport,
	handoffScaffold,
	handoffIntegrityLine,
	readHandoffArgument,
	handoffDocumentPath,
	latestHandoffDocument,
	renderHandoffDocument,
	writeHandoffDocument,
	rotationFactRows,
	provisionalGuidance,
	/** 缺口1 的读数构造器本身（与 `provisionalGuidance` 同一个理由开放：这是一句**读数**，
	 * 谁都能对着确定的输入把它渲染出来核对，而不必去重跑一条完整的 claim）。 */
	unattendedClaimReading,
	/** §11.9.3 诊断面: the two derived words, the ladder text, the read-time
	 * suffix and its gate-layer wrapper, the startup row builder and the one
	 * liveness probe every read face shares. */
	VACANT_LABEL,
	SEATED_DEAD_LABEL,
	recoveryLadderText,
	recoveryLadderSuffix,
	agentIsLive,
	withLiveGateDiagnostic,
	seatedDeadRoles,
	normalizeRecoveries,
	recoveryNote,
	/** §11.2 surface: the `/team_rotate` command's grammar and the instruction it
	 * drives the incumbent with. */
	readTeamRotateCommand,
	teamRotateInstruction,
	TEAM_ROTATE_COMMAND,
	TEAM_ROTATE_KEYS,
	TEAM_ROTATE_KEY_HELP,
	TEAM_ROTATE_KEY_HINT,
	handoffSectionsInline,
	/** §11.9.4/§11.9.5 recovery surface: the closed verb set, the pure preflight
	 * and its rate limit, the candidate computation, the audit builders and the
	 * one per-context liveness probe. */
	RECOVERY_ACTIONS,
	RECOVERY_RATE_LIMIT_MS,
	recoveryBoundaryText,
	vacancyKindText,
	recoveryPreflight,
	recoveryRateLimited,
	reapCandidateRoles,
	/** §4.2 (c) 的合成候选：label 常量与两句文案由同一处产出，所以「候选集 = 活成员 ∪ 自建继任者」与「合成候选的代价声明」都能被断言直接读，而不是抄一份进测试。 */
	SELF_SUCCESSOR_LABEL,
	candidateLabel,
	candidateOptionText,
	/** §4.2 (c) ④ 的交接正文构造器本身：五硬节是否在场且非空，要能被逐节断言（而不是只断言「写了个文件」）。 */
	selfBuiltHandoffBody,
	recoveryDecisionRow,
	recoveryDiagnosticLines,
	withRecoveryRow,
	pluginSessionIdMatches,
	askRecoveryConfirm,
	askRecoveryCandidates,
	writeRecoveryTrails,
	reviveIncumbent,
	reapIncumbent,
	recoveryFor: (ctx) => RECOVERY_BY_CTX.get(ctx),
	/** 策略持久化自持化（设计档 §3.2/§3.5）：路径解析纯函数（U7 的三支读数）与 home 注入点（夹具的私有 DSH_HOME）。 */
	resolvePolicyFilePath,
	setPolicyHomeInject,
	/** 批 E（框定 token 消毒面）的判据面 —— 设计档 §7 的「新增导出面」：
	 *  · `stripFramingTokens` 是**真函数**本身（U6 的零污染对照与 U11 的裸包裹断言都直调它，
	 *    不抄一份进测试）；
	 *  · `setStripImpl` 是 U7 的**注入缝**（塞一个「必抛」的桩 ⇒ 工具照常成功、返回原文本）；
	 *  · `stripImplIsDefault` 让「还原」这件事可核（跑完 U7 必须回到真实现，否则后面的判据
	 *    会在一片坏掉的消毒上跑出假绿）。 */
	stripFramingTokens,
	setStripImpl,
	stripImplIsDefault,
	/** ★ FR-4 的第六个渲染出口（`watchdogLines`，状态卡 / 团队面板的看门狗段体）：**判据面缺它**
	 *  时 U4 整块在 `TypeError: __testing.watchdogLines is not a function` 上崩（套件的顶层
	 *  await 无 `try`，一次崩掉之后**整块判据都不再执行**）。实现侧早已逐行过 `wellFormed`
	 *  （调用点见 {@link watchdogLines}），缺的只是**暴露**——`__testing` 里其余五个渲染出口
	 *  （`tickMessage` / `renderWatchdogDigest` / `renderResourceLine` / `renderRoleText` /
	 *  `renderResourceContext`）都在，独缺这一个。 */
	watchdogLines,
	/** ★ 全仓静态零残留扫描（U8）的**匹配式工厂**：判据自己不必再拼一次码点 —— 两处口径
	 * 若各写一遍，正是「锁的是复制品」。返回一个新的 global 正则（`lastIndex` 不共享）。 */
	framingTokenPattern: () => new RegExp(`(?:</?)?${FRAMING_WRAP}[A-Za-z_]{0,20}${FRAMING_WRAP}`, "gu"),
	/** 遮蔽器：把每一对全角竖线换成 `[BARS]`（体检 / 报告输出**不许**把原串打出来）。
	 *  比匹配式**宽一档**是有意的：半截包裹（只有一侧两竖线）也在遮蔽面内 —— 取证脚本的
	 *  输出用的是同一档口径（`.investigations/…/README.md` 纪律 2）。 */
	maskFramingTokens: (text) => String(text ?? "").split(FRAMING_WRAP).join("[BARS]"),
	/** 占位符**逐字**：命中 1 处就是这一串；命中 N > 1 处是 `[framing-token-removed 1/N]`…
	 *  （判据按它断言「处数由文本自证」，见 §6.5 v1.1）。 */
	FRAMING_PLACEHOLDER,
	/** 批 F（`team_link_team_append` 的长文本压力）的判据面 —— 设计档 §7 的「新增显示常量」
	 *  与 §6.2 的显示截断函数：`forDisplay` 是**真函数本身**（U5 的三处显示面判据都读它，
	 *  不抄一份、也不把手打的省略标记写进测试），`TASKS_TAIL_DISPLAY_CHARS` 是它那个
	 *  **码点**宽度（U5 断言「前 300 码点 + 标记」时由它取值，而不是把 300 抄进套件）。 */
	forDisplay,
	TASKS_TAIL_DISPLAY_CHARS,
});

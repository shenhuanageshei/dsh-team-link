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
// ★ 批 R · FR-R1（域拆分·第 15 小单）：跨会话看门狗（M1）的巡检 / 摘要 / 两档告警助手族（注册校验 ·
// 自动注册规划与按队补挂 · 巡逻一拍 · 摘要与两档告警 · 会话面读数与 digest 脚注）搬进
// `lib/watchdog-helpers.js` —— 此处按名导入（内部相对导入；宿主说明符面一个字符未动：那 8 条白名单
// 一条都没变）。入口对外面（`main` / `exports` / `apply` / `__testing`）逐字不变：`__testing` 里那一族
// 看门狗名字照旧导出，只是实现落在域档里。
// ★ 被钉的 `TICKABLE_VERDICTS` / `WATCHDOG_DIGEST_DEBOUNCE_MS` **没有搬**（定义与文档注释仍在入口），
//   只作为依赖经缝传入（见 `watchdogHelpersExtras()`）。
import { armTeamWatchdog, autoWatchdogRosterGate, bucketOf, buildWatchdogRegistration, chainReportLine, classifyWatchdogTargets, digestFooters, ensureTeamAutoWatchdogs, isIncumbentCoordinator, loadScopedSessionRecords, planAutoWatchdog, readSessionSurface, renderIdleAlert, renderPressureAlert, renderWatchdogDigest, summarizeAutoWatchdogs, tickMessage, watchdogDigestActionable, watchdogDigestSignature, windowReadingFor, windowWorkspaceFor, wireWatchdogHelpers } from "./watchdog-helpers.js";
// ★ 批 R · FR-R1（域拆分·第 16 小单）：读面（状态卡六段的段体渲染器 / §3.1 活性读数 / §4.1 列表读窗 / §C1 团队面板
// 载荷 / 两条读路由：header 导出按钮 ＋ GET 只读团队面板）搬进 `lib/read-surface.js` —— 此处按名导入（内部相对导入；
// 宿主说明符面一个字符未动：那 8 条白名单一条都没变），模块尾部那条 `wireReadSurface(…)` 按「装配缝」给它 2 条
// 入口侧出口（`PLUGIN_LABEL` ＋ 被钉的 `agentStateLabel`）。入口对外面（`main` / `exports` / `apply` / `__testing`）
// 逐字不变：`__testing` 里那一族读面名字（`buildPanelPayload` / `modeConclusionLine` / `verdictOf` /
// `buildLivenessSignal` / `readGoalSignal` / `watchdogLines` / `forDisplay` / `TASKS_TAIL_DISPLAY_CHARS`）照旧导出，
// 只是实现落在域档里。
// ★ 被钉的 `agentStateLabel` **没有搬**（定义与文档注释仍在入口），只作为依赖经缝传入（见 `wireReadSurface(…)`）。
import { LIST_LIMIT, LV_RUN_MIN, LV_SILENT_MIN, PANEL_LV_WINDOW_NOTE, PANEL_NO_SESSION_IDENTITY, PANEL_ROUTE_PATH, PREVIEW_SESSIONS, STATUS_TASKS_TAIL_DEFAULT, TASKS_TAIL_DISPLAY_CHARS, TEAM_MODE_AGENT_TEAM, TEAM_MODE_CONCLUSION, VACANT_LABEL, WATCHDOG_ORIGIN_AUTO, buildLivenessSignal, buildPanelPayload, exportGateRejection, fmtSilence, forDisplay, goalSummary, livenessLine, listReadTail, modeConclusionLine, openTenureOf, panelBadgeOf, panelWindowNote, pendingLines, probeAgentTeams, readGoalSignal, readListReadWindow, registerReadRoutes, sessionFaceLine, tasksDerivedLines, teamDerivedLines, teamRoleLines, tenureStartOf, verdictOf, watchdogLines, watchdogRenewField, wireReadSurface } from "./read-surface.js";
// ★ 批 R · FR-R1（域拆分·第 17 小单）：换届交接面（§11.2 `/team_rotate` 命令 ＋ §10.2.6 启动清扫 · §11.9.6 交接文档
// 契约（解析 / 校验 / 渲染 / 落盘）· §4.2 (c) ④/⑤ 自建继任者正文与整条链路 · 令牌读取器）搬进 `lib/handover.js` ——
// 此处按名导入（内部相对导入；宿主说明符面一个字符未动：那 8 条白名单一条都没变），模块尾部那条
// `wireHandover(handoverExtras())` 按「装配缝」给它 20 条入口侧出口。入口对外面（`main` / `exports` / `apply` /
// `__testing`）逐字不变：`__testing` 里那一族交接/换届名字照旧导出，只是实现落在域档里。
// ★ 被钉的 `relayUserMessage` **没有搬**（定义与文档注释仍在入口），只作为依赖经缝传入；`rotationFactRows` /
//   `provisionalGuidance` 也**没有搬**（两条只读本档的正向行模板锁钉住它们的正文），同样只注入不搬。
import { TEAM_ROTATE_COMMAND, TEAM_ROTATE_KEYS, TEAM_ROTATE_KEY_HELP, TEAM_ROTATE_KEY_HINT, readTeamRotateCommand, teamRotateInstruction, registerTeamRotateCommand, sweepPendingCreates, normalizeHandoffSection, parseHandoffBody, handoffBodyReport, handoffScaffold, handoffIntegrityLine, readHandoffArgument, renderHandoffDocument, writeHandoffDocument, selfBuiltHandoffBody, appointSelfBuiltSuccessor, readRotationToken, wireHandover } from "./handover.js";
// ★ 批 R · FR-R1（域拆分·第 18 小单）：§10.2 ② `/team_session` 的命令面（文法常量 / 解析器 / 计划 / 标题）
// 搬进 `lib/team-session-command.js` —— 此处按名导入（内部相对导入；宿主说明符面一个字符未动：那 8 条白名单
// 一条都没变），模块尾部那条 `wireTeamSessionCommand(teamSessionCommandExtras())` 按「装配缝」给它 3 条入口侧
// 出口（`TEAM_NAME_RE` / `readTeamName` / `readRoleName`）。入口对外面（`main` / `exports` / `apply` / `__testing`）
// 逐字不变：`__testing` 里那一族命令 / 计划 / 标题名字照旧导出，只是实现落在域档里。
// ★ 本单**没有搬的**：对话框渲染族与两条被钉符号（`buildTeamSessionCreateOptions` / `relayUserMessage`）仍在入口
//   （逐条点名见 `lib/team-session-command.js` 档头的「本档不是」）。
// ★ （批 R 第 20 小单补记：上面这句点名的**对话框渲染族**已随该单搬进 `lib/team-session-surface.js`；
//   两条被钉符号仍住在入口。见本档 §10.2 ② 区段里第 20 小单的那条指路注释。）
import { TEAM_SESSION_BY_CTX, TEAM_SESSION_COMMAND, TEAM_SESSION_CONFIRM_LABEL, TEAM_SESSION_CONFIRM_TIMEOUT_MS, TEAM_SESSION_DIALOG_FIELD_CHARS, TEAM_SESSION_DIALOG_ID, TEAM_SESSION_DIALOG_LIST_ROWS, TEAM_SESSION_DIALOG_MAX_CODE_POINTS, TEAM_SESSION_DIALOG_MAX_NEWLINES, TEAM_SESSION_DIALOG_MAX_QUESTION_POINTS, TEAM_SESSION_DIALOG_TASK_CHARS, TEAM_SESSION_ID_ILLEGAL, TEAM_SESSION_ID_SHAPE, TEAM_SESSION_ID_SUFFIX, TEAM_SESSION_MAX_CREATES, TEAM_SESSION_MAX_MEMBERS, TEAM_SESSION_PENDING_TTL_MS, TEAM_SESSION_RELEASE_DISCLOSURE, TEAM_SESSION_RELEASE_NOTES, TEAM_SESSION_ROLE_GUIDANCE, applyTeamSessionRelease, readTeamSessionCommand, teamSessionDefaultTeam, teamSessionId, teamSessionInjectNow, teamSessionPlan, teamSessionReleaseVerdict, teamSessionTitle, wireTeamSessionCommand } from "./team-session-command.js";
import { applyRetire, applySetRole, applyTeamUpsert, askDeleteConfirm, blackboardUntouchedLine, deleteTeam, mirrorNote, readTaskReceiptTargets, renderRosterMirror, taskMessageBlock, trustReferencesTo, wireRosterWrite, writeRosterMirror } from "./roster-write.js";
// ★ 批 R · FR-R1（域拆分·第 20 小单）：§10.2 ② `/team_session` 的命令面（对话框渲染族 / 调用方回执族 /
//   命令注册）搬进 `lib/team-session-surface.js` —— 此处按名导入（内部相对导入；宿主说明符面一个字符未动），
//   模块尾部那条 `wireTeamSessionSurface(teamSessionSurfaceExtras())` 按「装配缝」给它 5 条入口侧出口。
//   入口对外面（`main` / `exports` / `apply` / `__testing`）逐字不变：`__testing` 里那五个名字照旧导出；
//   工具面 / 命令面（名字 / 描述 / 参数 / 返回文案 / 注册顺序）也逐字不变 —— 入口只是把定义换成了同一份实现。
//   ★ 被钉的 `writerGate` / `relayUserMessage` **没有搬**（定义与文档注释仍在入口），只作为依赖经缝传入
//   （见 `teamSessionSurfaceExtras()`）；被钉的 `buildTeamSessionCreateOptions` 与
//   `buildTeamSessionResumeOptions` / `resolveTeamSessionModelSelection` / `teamSessionKickoffMessage` /
//   pending 两条仍住在入口（下一单）。
import { TEAM_SESSION_DIALOG_CROP_NOTE_TIERS, TEAM_SESSION_RECEIPT_MAX_POINTS, createCommandsSeam, registerTeamSessionCommand, teamSessionDialogQuestion, teamSessionDialogText, teamSessionReceiptOf, teamSessionReceiptText, wireTeamSessionSurface } from "./team-session-surface.js";
// ★ 批 R · FR-R1（域拆分·第 21 小单）：§4.1–§4.3 的形态面余下 ＋ §3.3.2 (v1.3) 的退役门
//   （32 条声明：形态闭集/投影/能力矩阵常量 · 恢复阶梯与活性读数 · 形态史行与段渲染 · 形态确认框 ·
//   `retireGate`）**逐字节**搬进 `lib/team-tools.js` —— 此处按名导入（内部相对导入；宿主说明符面一个
//   字符未动），模块尾部那条 `wireTeamTools(teamToolsExtras())` 按「装配缝」给它 4 条入口侧出口。
//   入口对外面（`main` / `exports` / `apply` / `__testing`）逐字不变：`__testing` 里那些名字照旧导出；
//   工具面 / 注册顺序 / 名字 / 描述 / 参数 / 返回文案也逐字不变 —— 入口只是把定义换成了同一份实现。
//   ★ 被钉的 9 个符号**一个都没搬**；`agentStateLabel` / `writerGate` / `registerTeamTools`（钉在入口）
//   与本单的五段相邻，原地一字未动。源码锁直读 `lib/index.js` 的其余符号（五硬节数组 / 投递正文 /
//   换届工具注册 / 换届事实行 / 回退窗口行 / 白名单拒绝文案）也**没有**搬。
import { SEATED_DEAD_LABEL, agentIsLive, appendModeHistoryRow, askModeDialog, backfillModeHistoryRow, memberLine, modeCapabilityLines, modeHistoryBody, normalizeRecoveries, otherReachableSessions, readLeadSessionId, recoveryLadderSuffix, recoveryLadderText, retireGate, seatedDeadRoles, sessionIdSnapshot, teamModeSectionLines, wireTeamTools, withLiveGateDiagnostic } from "./team-tools.js";

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
 * ★ 批 R 第 15 小单（域拆分）：`lib/watchdog-helpers.js` 需要的**入口侧出口**，一处装配。
 *
 * 为什么是注入而不是 import：域档**不许**导入入口（那会构成 ESM 环，实跑当场 TDZ）—— 先例是
 * `forensics.js` 的 `wireForensics()` 与本档上面七条 `rotationExtras()` / `registrationExtras()` /
 * `teamRegistrationExtras()` / `teamLedgerToolsExtras()` / `policyStoreExtras()` / `messagingExtras()` /
 * `watchdogExtras()` 同形（紧随本函数之后的 `recoveryExtras()` 也是同一形态）。这 20 条**全部是入口侧仍然要用的
 * 出口**（按归属分三组：
 * §3.2 看门狗常量 · 活性读数与全局标签 · 插件名）；搬走任何一条都会变成「同一函数两份」（设计档 §6
 * 明令禁止双事实源），而入口**不能**再导出给域档静态导入（环）⇒ 缝是唯一不破环的路。绑定与被搬前
 * **逐个同一**，所以注入之后行为逐字不变。
 *
 * ★ 被钉符号在这张表里出现**两条**：`TICKABLE_VERDICTS` / `WATCHDOG_DIGEST_DEBOUNCE_MS` —— 它们
 *   **没有搬**（定义与文档注释仍在入口），只作为依赖经缝传入；那两条「按函数自身锚点切片」的源码锁
 *   读数因此一字不变。
 */
function watchdogHelpersExtras() {
	return {
		// ---- §3.2 看门狗常量（前两条被钉，只注入不搬）----
		TICKABLE_VERDICTS,
		WATCHDOG_DIGEST_DEBOUNCE_MS,
		WATCHDOG_AUTO_INTERVAL_MINUTES,
		WATCHDOG_DEFAULT_INTERVAL_MINUTES,
		WATCHDOG_DEFAULT_SILENT_MINUTES,
		WATCHDOG_DEFAULT_TTL_HOURS,
		WATCHDOG_MAX_TTL_HOURS,
		WATCHDOG_MIN_INTERVAL_MINUTES,
		WATCHDOG_MIN_SILENT_MINUTES,
		WATCHDOG_ORIGIN_AUTO,
		WATCHDOG_ORIGIN_MANUAL,
		WATCHDOG_DIGEST_LABEL,
		WATCHDOG_IDLE_ALERT_LABEL,
		WATCHDOG_PRESSURE_ALERT_LABEL,
		WATCHDOG_ID_PREFIX,
		WATCHDOG_TICK_ID_PREFIX,
		LIAISON_PRESSURE_WARN_PERCENT,
		// ---- 活性读数、全局标签与插件名 ----
		fmtSilence,
		PLUGIN_LABEL,
		name,
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
		// ---- 标题与确认框那一行问句（§10.2.8.4 的槽位契约，定义已随第 20 小单搬进 `lib/team-session-surface.js`）----
		teamSessionTitle,
		teamSessionDialogQuestion,
		// ---- pending-create 意图的两条读写（durable 台账，定义仍在入口）----
		addTeamSessionPending,
		removeTeamSessionPending,
		// ---- 启动任务的外壳（§10.2.3；定义仍在入口，本节 §10.2 的 pending 两条旁）----
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

/**
 * ★ 批 R 第 17 小单（域拆分）：`lib/handover.js` 需要的**入口侧出口**，一处装配。
 *
 * 为什么是注入而不是 import：域档**不许**导入入口（那会构成 ESM 环，实跑当场 TDZ）—— 先例是
 * `forensics.js` 的 `wireForensics()` 与本档上面那些 `rotationExtras()` / `registrationExtras()` /
 * `teamRegistrationExtras()` / `teamLedgerToolsExtras()` / `policyStoreExtras()` / `messagingExtras()` /
 * `watchdogExtras()` / `watchdogHelpersExtras()` / `recoveryExtras()` / `teamSessionCreationExtras()`。
 * 这 20 条**全部是入口侧仍然要用的出口**（按归属分六组：交接契约的三条常量与「从真源渲染」的助手 ·
 * 两条被文本锁钉住的事实源 · §10.2 的 pending 意图与 TTL · 名册与会话面读数 · 交接正文投递面 ·
 * 被钉的 relay 与全局标签）；搬走任何一条都会变成「同一函数两份」（设计档 §6 明令禁止双事实源），
 * 而入口**不能**再导出给域档静态导入（环）⇒ 缝是唯一不破环的路。绑定与被搬前**逐个同一**，所以注入
 * 之后行为逐字不变。
 *
 * ★ 被钉符号在这张表里出现**一条**：`relayUserMessage` —— 它**没有搬**（定义、文档注释与锚点切片位置仍在
 *   入口），只作为依赖经缝传入；那条「按函数自身锚点切片」的源码锁（`hostSource.indexOf("function
 *   relayUserMessage(")`）读数因此一字不变。
 * ★ 另有**两条文本锁函数**同样只注入不搬：`rotationFactRows` / `provisionalGuidance` ——
 *   `host-half.test.mjs:4536`（`handoffSource`）与 `:4875`（`HANDOFF_SOURCE`）那两条锁**只读
 *   `lib/index.js`**，要求它们的四类行模板在本档里各出现一次 ⇒ 搬走就会立刻跑红。
 * ★ 口径如实：`writerGate` 在本域**只出现在一条英文注释里**（不取值、不参与任何表达式）⇒ 本表**不转出**
 *   它（与 `recoveryExtras()` 那种「文案里要取到值」的宽口径不同）。
 */
function handoverExtras() {
	return {
		// ---- 交接契约：五硬节三条常量与「从真源渲染」的那一条助手（定义仍在入口的 §11.9.6 区）----
		HANDOFF_HARD_SECTIONS,
		HANDOFF_SOFT_SECTIONS,
		HANDOFF_SECTION_HINTS,
		handoffSectionsInline,
		// ---- 被文本锁钉在入口的两条事实源（只注入不搬）----
		rotationFactRows,
		provisionalGuidance,
		// ---- §10.2 的 pending 意图与 TTL（自建继任者的意图落在同一本台账上）----
		TEAM_SESSION_PENDING_TTL_MS,
		addTeamSessionPending,
		removeTeamSessionPending,
		// ---- 名册与会话面读数（与名册/换届两域同一份实现）----
		agentCwd,
		agentIsLive,
		seatedDeadRoles,
		trustReferencesTo,
		teamSessionId,
		mirrorNote,
		readRoleName,
		SEATED_DEAD_LABEL,
		// ---- 交接正文的投递面（定义仍在入口，§11.4.5 的唯一措辞源）----
		handoffDeliveryMessage,
		// ---- 被钉的 relay（只注入不搬）与全局标签（warn / 指令前缀）----
		relayUserMessage,
		PLUGIN_LABEL,
	};
}

/**
 * ★ 批 R 第 18 小单（域拆分）：`lib/team-session-command.js` 需要的**入口侧出口**，一处装配。
 *
 * 为什么是注入而不是 import：域档**不许**导入入口（那会构成 ESM 环，实跑当场 TDZ）—— 先例是
 * `forensics.js` 的 `wireForensics()` 与本档上面那些 `…Extras()`。这 3 条**全部是入口侧仍然要用的出口**
 * （团队名与角色名的三条读取器：名册 / 形态 / 换届 / 建队各域都在用）；搬走任何一条都会变成「同一函数
 * 两份」（设计档 §6 明令禁止双事实源）。绑定与被搬前**逐个同一**，所以注入之后行为逐字不变。
 *
 * ★ 被钉符号在这张表里**不出现**：本单那 9 个一个都没搬，这一个域对它们也零引用。
 */
function teamSessionCommandExtras() {
	return {
		TEAM_NAME_RE,
		readTeamName,
		readRoleName,
	};
}

/**
 * ★ 批 R 第 19 小单（域拆分）：`lib/roster-write.js` 需要的**入口侧出口**，一处装配。
 *
 * 为什么是注入而不是 import：域档**不许**导入入口（那会构成 ESM 环，实跑当场 TDZ）—— 先例是
 * `forensics.js` 的 `wireForensics()` 与本档上面那些 `…Extras()`。这 4 条**全部是入口侧仍然要用的出口**
 * （会话消息取文的那一条助手与形态闭集的三条常量：形态 / 名册 / 落点 / 段各域读的都是同一份真源）；
 * 搬走任何一条都会变成「同一函数两份」（设计档 §6 明令禁止双事实源）。绑定与被搬前**逐个同一**，
 * 所以注入之后行为逐字不变。
 *
 * ★ 被钉符号在这张表里**不出现**：本单那 9 个一个都没搬，本域对它们也零可执行引用。
 */
function rosterWriteExtras() {
	return {
		textOf,
		TEAM_MODES,
		TEAM_MODE_LIST,
		TEAM_MODE_SESSIONS,
	};
}

/**
 * ★ 批 R 第 20 小单（域拆分）：`lib/team-session-surface.js` 需要的**入口侧出口**，一处装配。
 *
 * 为什么是注入而不是 import：域档**不许**导入入口（那会构成 ESM 环，实跑当场 TDZ）—— 先例是
 * `forensics.js` 的 `wireForensics()` 与本档上面那些 `…Extras()`。这 5 条**全部是入口侧仍然要用的出口**
 * （全局标签 / 被钉的投递与写门 / 两条活性读数助手）；搬走任何一条都会变成「同一函数两份」（设计档 §6
 * 明令禁止双事实源），而入口**不能**再导出给域档静态导入（环）⇒ 缝是唯一不破环的路。绑定与被搬前
 * **逐个同一**，所以注入之后行为逐字不变。
 *
 * ★ 被钉符号在这张表里出现**两条**：`relayUserMessage` / `writerGate` —— 它们**没有搬**（定义与文档
 *   注释仍在入口），只作为依赖经缝传入；两条「按函数自身锚点切片」的源码锁读数因此一字不变。
 */
function teamSessionSurfaceExtras() {
	return {
		PLUGIN_LABEL,
		relayUserMessage,
		writerGate,
		withLiveGateDiagnostic,
		agentIsLive,
	};
}

/**
 * ★ 批 R 第 21 小单（域拆分）：`lib/team-tools.js` 需要的**入口侧出口**，一处装配。
 *
 * 为什么是注入而不是 import：域档**不许**导入入口（那会构成 ESM 环，实跑当场 TDZ）—— 先例是
 * `forensics.js` 的 `wireForensics()` 与本档上面那些 `…Extras()`。这 4 条**全部是入口侧仍然要用的出口**
 * （形态闭集的渲染与降级留痕 · 会话面工作区读数）；搬走任何一条都会变成「同一函数两份」（设计档 §6
 * 明令禁止双事实源），而入口**不能**再导出给域档静态导入（环）⇒ 缝是唯一不破环的路。绑定与被搬前
 * **逐个同一**，所以注入之后行为逐字不变。
 *
 * ★ 被钉符号在这张表里**不出现**：本单那 9 个一个都没搬，本域对它们也零引用。
 */
function teamToolsExtras() {
	return {
		TEAM_MODE_DEGRADATIONS,
		TEAM_MODE_LIST,
		TEAM_MODE_SESSIONS,
		agentCwd,
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

const STATUS_TASKS_TAIL_MAX = 20;

/** §4.2 状态卡自己的「未读」句：与 {@link LV_WINDOW_NOTE} 同一条纪律，但点名**本卡**的
 * 窗口 —— 一张只读了 12 行的卡不能借用列表工具的措辞说起别人。 */
const STATUS_LV_WINDOW_NOTE = `未读（本卡只读了前 ${PREVIEW_SESSIONS} 行）—— 本行未读取会话日志：verdict / 静默时长 / goal 均未判定（代理状态见会话面一段）。`;

/** §4.2 反面预警注记的输入类型：「surface 消息」是两类消息事件（user/message 与
 * assistant/message）—— 与 §3.1 的静默读数同一批事件，只是这里要的是**时间戳的分布**
 * 而不是最后一枚。 */
const SURFACE_MESSAGE_TYPES = new Set(["user/message", "assistant/message"]);

/** A liveness reading is a snapshot of a moving system, so every row says when it
 * was taken and when it stops being trustworthy (§3.1 防偏离 regulations). */
const READ_STALE_NOTE = ">2min 作废";

// ---------------------------------------------------------------------------
// §4.1–§4.3（B 批：团队形态）常量与渲染的**唯一事实源**
// ---------------------------------------------------------------------------

/** §4.1 形态的闭集：两档。闭集外的 `mode` 由 `normalizeTeams` 降级为默认档**并留痕**
 * （沿用既有范式：手改出来的行必须降成**可读状态**，绝不降成不可读命名空间）。 */
const TEAM_MODE_SESSIONS = "sessions";

const TEAM_MODES = new Set([TEAM_MODE_SESSIONS, TEAM_MODE_AGENT_TEAM]);
/** 闭集渲染为一行 —— 每一处拒绝都渲染**这个**常量，于是拒绝文案永远不会广告一个与校验
 * 不同的闭集（「一处事实一处渲染」）。 */
const TEAM_MODE_LIST = [...TEAM_MODES].join(" / ");
// ★ 批 R 第 21 小单（域拆分）：§4.2 的 Lead 会话 id 形状与形态确认框三条字面量
//   （`LEAD_SESSION_ID_RE` / `MODE_DIALOG_ID` / `MODE_CONFIRM_LABEL` / `MODE_CANCEL_LABEL`）已**逐字节**
//   搬进 `lib/team-tools.js` —— 本档零读者（只被该档的 `readLeadSessionId` / `askModeDialog` 使用）。
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
// ★ 批 R 第 21 小单（域拆分）：§4.3(3)(4)(5) 的名册投影来源文案 / 能力矩阵 / 形态诊断行
//   （`TEAM_MODE_ROSTER_READABLE` / `TEAM_MODE_ROSTER_UNREADABLE` / `TEAM_MODE_ROSTER_UNREADABLE_NEUTRAL` /
//   `TEAM_MODE_CAPABILITY_ROWS` / `TEAM_MODE_DIAGNOSTIC`）已**逐字节**搬进 `lib/team-tools.js` —— 本档零读者。
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

/** The target's last observed activity watermark (§3.1 timestamps), or `null`
 * when neither side is readable — the watchdog's "same silence period" key. */
function lastActivityOf(signal) {
	if (signal.lastAssistantAt === null && signal.lastInboundAt === null) return null;
	return Math.max(signal.lastAssistantAt ?? Number.NEGATIVE_INFINITY, signal.lastInboundAt ?? Number.NEGATIVE_INFINITY);
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

// ★ 批 R 第 15 小单（域拆分）：本节的 watchdog 助手族（26 条声明：注册校验 / 自动注册规划 / 按队补挂 /
//   巡逻一拍 / 摘要与两档告警 / 会话面读数与 digest 脚注）**逐字节**搬进 `lib/watchdog-helpers.js`
//   （那一档的档头给归属、依赖方向、被钉符号核对与搬迁纪律）。本档按名导入同一份实现，模块尾部那条
//   `wireWatchdogHelpers(watchdogHelpersExtras())` 给它注入 20 条入口侧出口（被钉的
//   `TICKABLE_VERDICTS` / `WATCHDOG_DIGEST_DEBOUNCE_MS` 只注入不搬）。

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
// ★ 批 R 第 19 小单（域拆分）：收件视图 / 派生回执的 7 个尺寸与形状常量（`TASK_INBOX_MESSAGES` /
//   `TASK_INBOX_PREVIEW` / `TASK_REF_RE` / `CROSS_SESSION_BANNER_PREFIX` / `SEND_CALL_EVENT_TYPES` /
//   `TEAM_READ_TARGET_LIMIT` / `ROSTER_RESOLVED_NOTE`）只被那一块使用 ⇒ 随块**逐字节**搬进
//   `lib/roster-write.js`（见该档档头）。
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

// ★ 批 R 第 21 小单（域拆分）：§11.9.5⑦ 的恢复行归一化 · §4.3 形态面的恢复阶梯/活性读数 · 形态史行与
//   渲染族（`normalizeRecoveries` / `SEATED_DEAD_LABEL` / `RECOVERY_VERBS` / `recoveryLadderText` /
//   `recoveryLadderSuffix` / `agentIsLive` / `withLiveGateDiagnostic` / `seatedDeadRoles` /
//   `modeDegradationNote` / `modeHistoryBody` / `decisionRowBody` / `decisionsHasModeHistory` /
//   `appendModeHistoryRow` / `backfillModeHistoryRow` / `modeTeamLine` / `memberLine`，共 16 条声明）已
//   **逐字节**搬进 `lib/team-tools.js`（见该档档头）。本档按名导入同一份实现；模块尾部那条
//   `wireTeamTools(teamToolsExtras())` 给它注入 4 条入口侧出口。
//   下一段停在**被钉的** `agentStateLabel` 之前 —— 它原地未动（文本锁按函数自身锚点切片）。

/** 一个代理在会话面上的状态词（列表工具与状态卡原本各写一份 —— §C1 起收敛成**一处**）。
 * `ctx.agents.get` 的两种「没有这个代理」（`undefined` / `null`）都判「✕ 未运行」——
 * `null` 这一档是**行为修正**，不是静默漂移（分歧审计 🔵#5）：收敛前列表工具写的是
 * `running ? "▶ 运行中" : agent !== undefined ? "○ 空闲" : "✕ 未运行"`（`null` ⇒ 「○ 空闲」），
 * 状态卡那一份写 `agent === undefined ? … : agent.status === …`（`null` ⇒ 抛）。对
 * `ctx.agents.get` 实际会产生的两种输入（已定义 / `undefined`）逐字不变。 */
function agentStateLabel(agent) {
	return agent === undefined || agent === null ? "✕ 未运行" : agent.status === "running" ? "▶ 运行中" : "○ 空闲";
}

// ★ 批 R 第 21 小单（域拆分）：§4.3 形态段渲染 / 能力矩阵 / 形态确认框 / 会话面读数
//   （`teamModeSectionLines` / `modeCapabilityLines` / `askModeDialog` / `sessionIdSnapshot` /
//   `otherReachableSessions` / `readLeadSessionId`，共 6 条声明）已**逐字节**搬进 `lib/team-tools.js`。
//   本段之后是**被钉的** `writerGate` —— 它原地未动（文本锁按函数自身锚点切片）。

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

// ★ 批 R 第 21 小单（域拆分）：§3.3.2 (v1.3) 的退役门 `retireGate`（1 条声明）已**逐字节**搬进
//   `lib/team-tools.js`（入口的 `teamRegistrationExtras()` / `__testing` 按名取同一份实现）。
// ★ 下一段的 `registerTeamTools` **没有搬**：`host-half.test.mjs:2893–2894` 直读 `lib/index.js` 锁住
//   它 `execute` 里那句「三值白名单」拒绝文案（decisions / discipline / tasks）
//   ⇒ 留在入口原地（见 `lib/team-tools.js` 档头「本档不是」）。

// ---------------------------------------------------------------------------
// 批 H（删团队）: `team_link_roster action=delete` 的确认框 / 存在性探测 / 落笔
// （设计档 docs/2026-10-12-team-delete-design.md §5 FR-H2…H4 · §6 伪代码）
// ---------------------------------------------------------------------------

// ★ 批 R 第 19 小单（域拆分）：本节的删团队（`DELETE_*` / `blackboardDirPresence` / `blackboardUntouchedLine` /
//   `askDeleteConfirm` / `deleteTeam`）· 名册写面（`applyTeamUpsert` / `applySetRole` / `applyRetire` /
//   `trustReferencesTo`）· 名册镜像（`renderRosterMirror` / `writeRosterMirror` / `mirrorNote`）· 收件回执
//   （`readTaskReceiptTargets` … `renderReceiptRow`）共 28 条声明**逐字节**搬进 `lib/roster-write.js`（该档档头
//   给归属、依赖方向、被钉符号核对与搬迁纪律）；入口在模块尾部用 `wireRosterWrite(rosterWriteExtras())`
//   注入 4 条入口侧出口，顶部按名导入 12 条入口仍要用的出口 ＋ 装配缝 `wireRosterWrite`。注册顺序 / 工具面文案一个字符未动。

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

// ---------------------------------------------------------------------------
// §10.2 ② 的命令面（文法常量 / 解析器 / 计划 / 标题）—— 定义已搬进 `lib/team-session-command.js`（批 R 第 18 小单）
// ---------------------------------------------------------------------------
//
// ★ 这一整块（入口原 4515–5213 行，as-of 本单动手前：25 条模块级声明（文法与对话框预算常量 ＋
//   `TEAM_SESSION_BY_CTX`）· `readTeamSessionRoleName` / `readTeamSessionCommand` · 时钟与缺省团队三条 ·
//   §10.2.6「释放现任」的四条出口 · `teamSessionPlan` / `teamSessionId` · 标题族七条；另有 1 条裸
//   `let TEAM_SESSION_NOW_INJECTED;` 随注入缝一并搬）**逐字节**搬进
//   `lib/team-session-command.js`（那一档的档头给归属、依赖方向、被钉符号核对与搬迁纪律）。本档按名
//   导入同一份实现，模块尾部那条 `wireTeamSessionCommand(teamSessionCommandExtras())` 给它注入 3 条入口侧
//   出口（`TEAM_NAME_RE` / `readTeamName` / `readRoleName`）。
// ★ 仍留在下面的同域块（下一小单）：对话框渲染族（`teamSessionDialogText` / `teamSessionDialogQuestion` /
//   `dialogCodePoints` / `dialogFlatten` / `dialogField` / `dialogFits` / 三段裁段标注 /
//   `teamSessionDialogCropNote` / `teamSessionTaskNote` / `teamSessionModelLine`）· 被钉的
//   `buildTeamSessionCreateOptions` · `buildTeamSessionResumeOptions` / `resolveTeamSessionModelSelection` ·
//   被钉的 `relayUserMessage` · `registerTeamSessionRoles` · 回执族与 `registerTeamSessionCommand`。

// ★ 批 R 第 20 小单（域拆分）：上面 R-18 横幅点名的「下一小单」就是本单 —— §10.2.8.4 的**对话框渲染族**
//   （`teamSessionDialogText` / `teamSessionDialogQuestion` / `dialogCodePoints` / `dialogFlatten` /
//   `dialogField` / `dialogFits` / 三段裁段标注 / `teamSessionDialogCropNote` / `teamSessionTaskNote` /
//   `teamSessionModelLine`）已**逐字节**搬进 `lib/team-session-surface.js`（见该档档头）。本档按名导入同一份
//   实现，模块尾部那条 `wireTeamSessionSurface(teamSessionSurfaceExtras())` 给它注入 5 条入口侧出口
//   （`PLUGIN_LABEL` / 被钉的 `relayUserMessage` / 被钉的 `writerGate` / `withLiveGateDiagnostic` /
//   `agentIsLive`）。

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

// ★ 批 R 第 20 小单（域拆分）：§10.2.6 的名册登记（`registerTeamSessionRoles`）· `commands` 可选缝
//   （`createCommandsSeam`）· §10.2.8.10 ① 的调用方回执族（`TEAM_SESSION_RECEIPT_*` / `teamSessionReceipt*` /
//   `deliverTeamSessionReceipt`）· `registerTeamSessionCommand` 已**逐字节**搬进
//   `lib/team-session-surface.js`（见该档档头）。本档按名导入同一份实现；`apply` 里的两条调用点
//   （`createCommandsSeam` / `registerTeamSessionCommand`）与 `__testing` 的三个读数面一字未变。

// ---------------------------------------------------------------------------
// §11.2 `/team_rotate` · §11.9.6 交接文档契约 · §4.2 (c) 自建继任者 —— 定义已搬进 `lib/handover.js`（批 R 第 17 小单）
// ---------------------------------------------------------------------------
//
// ★ 这一整块（入口原 6228–6983 行的三段：`/team_rotate` 命令文法·指令·注册 ＋ §10.2.6 启动清扫 ／
//   §11.9.6 的交接正文解析-校验-渲染-落盘 ／ §4.2 (c) ④ 自建继任者正文 ＋ ⑤ 整条链路 ＋ 令牌读取器）
//   **逐字节**搬进 `lib/handover.js`（那一档的档头给归属、依赖方向、被钉符号核对与搬迁纪律）。本档按名
//   导入同一份实现，模块尾部那条 `wireHandover(handoverExtras())` 给它注入 20 条入口侧出口（被钉的
//   `relayUserMessage` 与两条被文本锁钉住的 `rotationFactRows` / `provisionalGuidance` 也在那张表里，
//   **只注入不搬**）。
// ★ 仍留在入口的：① 下面紧跟的 `rotationFactRows` / `provisionalGuidance` —— `host-half.test.mjs` 的两条
//   **只读本档**的正向行模板锁（`:4536` 的 `handoffSource` / `:4875` 的 `HANDOFF_SOURCE`）钉住它们的正文，
//   因此**不能搬**（只经缝注入）；② §11.9.4/§11.9.5 的恢复四块与 `ROTATION_BY_CTX`（下一小单）；③ 交接
//   文档族在本档的三条调用点（`autoHandover` / `registerRotationTools`，走上面的按名导入）。

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
//   `registerRecoveryTools`。★ 原先「更下面的 `selfBuiltHandoffBody` / `appointSelfBuiltSuccessor` 与交接
//   文档族一起走」那半句**已经兑现**：它们随交接文档族搬进了 `lib/handover.js`（批 R 第 17 小单）。
// ---------------------------------------------------------------------------

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
// ★ 批 R 第 16 小单：这一节的正文（`exportGateRejection` / `PANEL_ROUTE_PATH` / `buildPanelPayload` 与
//   `registerReadRoutes`）已原样搬进 `lib/read-surface.js`；入口只在 `apply` 的**同一位置**调用
//   `registerReadRoutes`（两条路由的挂载时机与顺序逐字不变）。横幅保留，指路到此。
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
// ★ 批 R 第 15 小单：域档 `lib/watchdog-helpers.js` 的 20 条入口侧出口走同一条纪律（同一批绑定、同一份实现，
// 本档三条出边 = 共享 / 段 / 换届三档，都不回指入口）。见上面 `watchdogHelpersExtras()`。
wireWatchdogHelpers(watchdogHelpersExtras());
// ★ 批 R 第 13 小单：域档 `lib/recovery.js` 的 12 条入口侧出口走同一条纪律（同一批绑定、同一份实现，
// 本档三条出边 = 共享 / 黑板 / 换届三档，都不回指入口）。见上面 `recoveryExtras()`。
wireRecovery(recoveryExtras());
// ★ 批 R 第 14 小单：域档 `lib/team-session-creation.js` 的 11 条入口侧出口走同一条纪律（同一批绑定、
// 同一份实现，本档三条出边 = 共享 / 落点 / 换届三档，都不回指入口）。见上面 `teamSessionCreationExtras()`。
wireTeamSessionCreation(teamSessionCreationExtras());
// ★ 批 R 第 16 小单：域档 `lib/read-surface.js` 的 2 条入口侧出口（`PLUGIN_LABEL` ＋ 被钉的 `agentStateLabel`：只注入、
// 不搬）走同一条纪律（同一批绑定、同一份实现，本档四条出边 = 共享 / 黑板 / 换届 / 投递四档，都不回指入口）。
wireReadSurface({ PLUGIN_LABEL, agentStateLabel });
// ★ 批 R 第 17 小单：域档 `lib/handover.js` 的 20 条入口侧出口（`PLUGIN_LABEL` ＋ 被钉的 `relayUserMessage`
// ＋ 两条被文本锁钉住的 `rotationFactRows` / `provisionalGuidance`：都只注入、不搬）走同一条纪律（同一批
// 绑定、同一份实现，本档五条出边 = 共享 / 换届 / 恢复 / 建队 / 读面五档，都不回指入口）。见上面
// `handoverExtras()`。
wireHandover(handoverExtras());
// ★ 批 R 第 18 小单：域档 `lib/team-session-command.js` 的 3 条入口侧出口走同一条纪律（同一批绑定、同一份
// 实现，本档两条出边 = 共享 / 换届两档，都不回指入口）。见上面 `teamSessionCommandExtras()`。
wireTeamSessionCommand(teamSessionCommandExtras());
// ★ 批 R 第 19 小单：域档 `lib/roster-write.js` 的 4 条入口侧出口走同一条纪律（同一批绑定、同一份实现，
// 本档五条出边 = 共享 / 换届 / 黑板 / 投递 / 读面五档，都不回指入口）。见上面 `rosterWriteExtras()`。
wireRosterWrite(rosterWriteExtras());
// ★ 批 R 第 20 小单：域档 `lib/team-session-surface.js` 的 5 条入口侧出口（`PLUGIN_LABEL` ＋ 被钉的
// `relayUserMessage` / `writerGate` ＋ 两条读数助手；只注入、不搬）走同一条纪律（同一批绑定、同一份实现，
// 本档七条出边 = 共享 / 换届 / 段 / 看门狗助手 / 名册写面 / 建队 / 命令面七档，都不回指入口）。
// 见上面 `teamSessionSurfaceExtras()`。
wireTeamSessionSurface(teamSessionSurfaceExtras());
// ★ 批 R 第 21 小单：域档 `lib/team-tools.js` 的 4 条入口侧出口（形态闭集两条常量 ＋ 降级留痕表 ＋
// 工作区读数；全部只注入、不搬）走同一条纪律（同一批绑定、同一份实现，本档四条出边 = 共享 / 换届 /
// 黑板 / 读面四档，都不回指入口）。见上面 `teamToolsExtras()`。
wireTeamTools(teamToolsExtras());
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

// ---------------------------------------------------------------------------
// 名册工具域（team-registration）—— 批 R（上架合规）第 7 小单从 `lib/index.js` **原样搬出**
// ---------------------------------------------------------------------------
// 归属：docs/2026-10-15-store-compliance-design.md §6「边界规则」· §4 D1/D2/D4 · §5 FR-R1 · §8 Rr1/Rr3/Rr4。
// ★ 本档是什么：**一条**工具注册语句 —— `ctx.effect(() => ctx.tools.register(defineTool({ name:
//   "team_link_roster", … })), "team-link: roster tool")`，连同它的描述文本、参数表、`output`、
//   `timeoutMs` 与整个 `execute` 体（含全部行内注释）。**语句逐字节等于原位置**（设计档 D4：
//   只做「移动 + 补 export」）：40,969 字节 / 457 行；机检口径：该语句在新档里**逐字节出现恰一次**、在入口里**零次**（EOL 归一同结论）。
// ★ 本档**不是**（留给下一小单）：`registerTeamTools` 里另外两条注册
//   （`team_link_team_read` 9,053 B / `team_link_team_append` 16,932 B）仍在入口。入口侧用
//   `registerRosterTool(ctx, policy, rotation, sections)` 在**同一位置**调用本档 ⇒ 三条注册的
//   先后顺序、工具名 / 描述 / 参数 / 返回文案逐字不变（工具面就是判据面）。
// ★ 依赖方向（Rr4「模块图无环」的实测口径）：本档**不导入入口** `lib/index.js`（那会构成 ESM 环，
//   实跑当场 TDZ）—— 出边只有三类，模块图仍是单向 DAG：
//   ① 内部相对导入（既有域档）：`./shared.js` 七条（`COORDINATOR_ROLE` / `agentSessionId` /
//      `describeError` / `maskToken` / `preview` / `readStamp` / `wellFormed`）· `./ledger.js` 一条
//      （`blackboardPaths`）· `./rotation.js` 一条（`roleOf`）· `./sections.js` 两条
//      （`charterReinforceLine` / `sectionsSwitches`）；
//   ② 宿主导入：`@deepseek-ai/dsh-tools` 的 `defineTool`（既有白名单那 8 条之一 ⇒ `Rr3` 的说明符
//      集合读数一字不变）；
//   ③ **装配缝注入**（先例：`lib/forensics.js` 的 `wireForensics()`、`lib/rotation.js` 的
//      `extras`、`lib/registration.js` 的 `wireRegistration()`）：入口侧 44 条出口由
//      `wireTeamRegistration(extras)` 在模块求值时一次性绑定到本档的同名模块级 `let` 上 —— 绑定与
//      搬迁前**逐个同一** ⇒ 行为逐字不变。逐条归属见入口的 `teamRegistrationExtras()`。
// ★ 为什么这 44 条走缝而不搬：它们**都不是本域私有** —— 每一条在入口侧都另有真实调用点
//   （名册写路径 / 形态切换 / 段对齐 / 镜像 / 信任引用 / 状态卡…），搬走就是「同一函数两份」（设计档
//   §6 明令禁止双事实源）；而入口**不能**再导出给域档静态导入（环）⇒ 缝是唯一不破环的路。
// ★ 被钉符号核对（本仓 `hostSource` 文本锁钉住的 9 个：`writePolicyFileAtomic` / `renameThroughSeam` /
//   `POLICY_FILE_SCHEMA` / `WATCHDOG_DIGEST_DEBOUNCE_MS` / `TICKABLE_VERDICTS` / `agentStateLabel` /
//   `writerGate` / `relayUserMessage` / `buildTeamSessionCreateOptions`）：**本单一个都没搬**，九个仍
//   逐字节住在入口。本档与它们的唯一接触是 `writerGate` —— 这一族工具写权限判定的依赖，经缝传入；
//   它的定义与文档注释原地未动，于是「按函数自身锚点切片」的那条源码锁读数一字不变。
// ★ 搬运纪律（D4）：本档新增的只有 ① 本段档头 ② 5 条 import 语句（12 个绑定名） ③ 装配缝 ④ 包住语句的函数签名与
//   花括号；**语句本身一个字符都没动**（含开头那一个 \t 缩进、行尾注释与英文横幅注释）。
// ---------------------------------------------------------------------------

import { defineTool } from "@deepseek-ai/dsh-tools";

import { COORDINATOR_ROLE, agentSessionId, describeError, maskToken, preview, readStamp, wellFormed } from "./shared.js";
import { blackboardPaths } from "./ledger.js";
import { roleOf } from "./rotation.js";
import { charterReinforceLine, sectionsSwitches } from "./sections.js";

// ---------------------------------------------------------------------------
// 装配缝 · `wireTeamRegistration(extras)`（先例：`lib/forensics.js` 的 `wireForensics()`）
// ---------------------------------------------------------------------------
// 前置：入口在**模块求值**时调用一次（`lib/index.js` 模块尾部，紧挨 `wireRegistration({…})`），
//       给出的 44 个键与被注入的绑定**同名同值**。
// 后置：本档的模块级 `let` 全部绑定到入口那一份真实现；此后每次工具执行读到的都是它。
// 为什么不是 import：见档头「依赖方向」①（入口 → 域档会成环）。
// 为什么是一次性绑定而不是每次调用现取：工具执行是热路径，绑一次就够；而且 `execute` 体内那几条
// 裸名因此**逐字节保留**（只在函数体外加了这一个缝），D4 的逐字节等价可以直接机检。
// ★ 口径如实：本清单是 **word-boundary 宽口径**（在语句原文上按裸词边界匹配）—— 其中
//   `askDeleteConfirm` / `modeCapabilityLines` / `TEAM_MODE_NO_MIGRATION_LINES` / `name` 只出现在注释
//   或块内同名局部量里（多绑不改变行为，少绑才会 ReferenceError）。保留它们是为了让「按裸词边界的
//   机检清单」与缝逐条对齐，不需要人再分辨「这条是注释还是代码」。
// ---------------------------------------------------------------------------
let AGENT_TEAMS_HOWTO, MODE_SETTINGS_FALLBACK, READ_STALE_NOTE, TEAM_MODES, TEAM_MODE_AGENT_TEAM, TEAM_MODE_LIST, TEAM_MODE_NO_MIGRATION_LINES, TEAM_MODE_SESSIONS, TEAM_SESSION_RELEASE_NOTES, agentCwd, agentIsLive, appendModeHistoryRow, applyRetire, applySetRole, applyTeamSessionRelease, applyTeamUpsert, askDeleteConfirm, askModeDialog, backfillModeHistoryRow, blackboardUntouchedLine, deleteTeam, memberLine, mirrorNote, modeCapabilityLines, modeHistoryBody, name, otherReachableSessions, probeAgentTeams, readLeadSessionId, readNote, readRoleName, readSessionId, readTeamName, recoveryLadderSuffix, retireGate, sessionIdSnapshot, teamModeSectionLines, teamSessionReleaseVerdict, tenureStartOf, textOutput, trustReferencesTo, withLiveGateDiagnostic, writeRosterMirror, writerGate;

/** 入口侧出口的一次性绑定（见本节档头的前置 / 后置）。 */
export function wireTeamRegistration(extras) {
	({
		AGENT_TEAMS_HOWTO,
		MODE_SETTINGS_FALLBACK,
		READ_STALE_NOTE,
		TEAM_MODES,
		TEAM_MODE_AGENT_TEAM,
		TEAM_MODE_LIST,
		TEAM_MODE_NO_MIGRATION_LINES,
		TEAM_MODE_SESSIONS,
		TEAM_SESSION_RELEASE_NOTES,
		agentCwd,
		agentIsLive,
		appendModeHistoryRow,
		applyRetire,
		applySetRole,
		applyTeamSessionRelease,
		applyTeamUpsert,
		askDeleteConfirm,
		askModeDialog,
		backfillModeHistoryRow,
		blackboardUntouchedLine,
		deleteTeam,
		memberLine,
		mirrorNote,
		modeCapabilityLines,
		modeHistoryBody,
		name,
		otherReachableSessions,
		probeAgentTeams,
		readLeadSessionId,
		readNote,
		readRoleName,
		readSessionId,
		readTeamName,
		recoveryLadderSuffix,
		retireGate,
		sessionIdSnapshot,
		teamModeSectionLines,
		teamSessionReleaseVerdict,
		tenureStartOf,
		textOutput,
		trustReferencesTo,
		withLiveGateDiagnostic,
		writeRosterMirror,
		writerGate,
	} = extras);
}

/**
 * Register the M2 roster tool (§3.3.2): the team role registry's own action router
 * (`get` / `upsert-team` / `set-role` / `retire` / `set-mode` / `delete`), moved verbatim out of
 * `registerTeamTools` in 批 R 第 7 小单. Body is byte-identical to its old position.
 */
export function registerRosterTool(ctx, policy, rotation, sections = null) {
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_roster",
		description: "团队角色注册表（roster，M2）：团队 -> 角色 -> 会话，含版本史。action：get（任何会话可读：全体团队概要 + 指定 team 详情含 history）/ upsert-team（创建或幂等更新；团队名 [a-z0-9-]+；**创建时把调用会话播种为 coordinator 现任**（创建即认领：否则 policy.writer=coordinator 下的空缺团队谁都写不进）；已存在时只有 policy 属于可更新面，roles/history 原样保留，本工具无 policy 参数，故 policy 由用户经设置 UI 修改）/ set-role（换现任：current 替换 + history 追加，旧任记录 until=now；不迁移 pairs——那是 M4 rotation 的专属动作）/ retire（退役：仅现任协调者会话发起，current 置空 + history 记退役；随后可选一个用户确认对话框清理指向退役会话的 pairs/trustedSenders/rememberTargets）/ set-mode（§4.2，**第五个封闭动词**：把团队形态在多会话档（sessions，默认）与 agent-team 档之间切换。参数：mode（闭集 sessions / agent-team，闭集外一律拒绝并列出两个值）；leadSessionId?（省略 ⇒ **默认取调用方自己的会话 id** 并在确认框正文里明示；显式空串 ⇒ 拒绝；非空须过形状 + **在场校验**（能在本次会话列表快照里找到）两道。**宿主探测只对「切到 agent-team」这一向**：探测不到 ⇒ 拒绝 + 指路怎么开 + **零写入**（切回 sessions 不探测）。**双重门（缺一即 fail-closed、零写入）**：writer gate 原样（现任协调者；空缺 ⇒ 会话路径拒绝）+ 人类确认框（无确认服务 / 超时 / 取消 ⇒ 拒绝且零写入）。落笔后 decisions.md 追加**恰好一行**形态史（`形态 → agent-team（Lead=<id>）` 或 `形态 → sessions`）＋ best-effort 重写 roster.md 镜像（与设置变更同一事务）；**幂等**：同档同 Lead **且账上已有这一档的形态史行** ⇒ 返回「已是该档」，不弹框、不写 settings、零写入；账上缺那一行（上一次 settings 写成功而 decisions 写失败）⇒ **补记恰好一行**再返回（否则那条「补写路径后重发以补记」的指路不可执行），账读不出来或没有 workspace 时**不补记**并如实说明。切档**不迁移信任**（pairs / trustedSenders / rememberTargets 一行不写）、**成员名册一行不落 settings**（只存 Lead 指针）、**不改投任何在飞消息**（§7 明确不做跨形态改投））/ delete（批 H：把团队**从名册里真正删掉** —— 记 `teams` 那一行（连同它自己的版本史）。**豁免 writer gate**：US-H2 的核心场景是「已退役、没有现任协调者」的队，不豁免就谁都删不掉，把关改由**人类确认框**承担（无确认服务 / 取消 / 超时 ⇒ 拒绝且**零写入**）。**不碰黑板文件**：`<workspace>/team/<队名>/` 下的任何文件不读不写不删，只在报告里点出目录路径（存在 / 不存在都如实说）。**不动信任数据**（pairs / trustedSenders / rememberTargets 一个字不写）· **不动其它团队行**。顺序：先校验在册（不在册 ⇒ 如实拒绝并列出已知团队名、零弹框零写入）⇒ 确认框 ⇒ **写前重读名册**（确认窗口内被别人删掉 ⇒ 幂等拒绝、零写入）⇒ 单笔 policy.update）。写权限：policy.writer=coordinator 时只有该团队 coordinator 角色的现任会话可写，现任空缺时会话路径一律拒绝（用户经设置 UI 永远是超级写者）；writer=any 时任何会话可写。**唯一的例外是 delete**：它被上面那条豁免（把关交给人类确认框），其余动作的写权限逐字不变。",
		parameters: {
			action: { type: "string", required: true, enum: ["get", "upsert-team", "set-role", "retire", "set-mode", "delete"], description: "get / upsert-team / set-role / retire / set-mode / delete" },
			team: { type: "string", description: "团队名（[a-z0-9-]+）" },
			role: { type: "string", description: "set-role / retire：角色名（约定角色名 coordinator，允许自定义如 reviewer）" },
			session: { type: "string", description: "set-role：新现任会话 id" },
			note: { type: "string", description: "set-role / retire：写入版本史的备注" },
			mode: { type: "string", description: "set-mode：目标形态，闭集 sessions / agent-team（闭集外一律拒绝并列出两个值）。sessions=多会话档（默认，平级会话之间靠本插件的身份与信任层）；agent-team=单会话兜底档（一个会话内部的子代理团队，本插件只做名册与指路）" },
			leadSessionId: { type: "string", description: "set-mode：切到 agent-team 时的 Lead 会话 id。**省略 ⇒ 默认取调用方自己的会话 id**（切换的人通常就是 Lead），并在确认框正文里明示该默认值；显式空串 ⇒ 拒绝；非空须过两道校验（形状 + 能在本次会话列表快照里找到）。只对 agent-team 档生效——切回 sessions 时传它一律拒绝（多会话档没有 Lead 这个角色），切回时 Lead 指针被清空" },
		},
		output: textOutput(),
		// ★ 交付评审 🟡#1: this tool budget has to sit ABOVE the human dialog it embeds
		// — the same rule `team_link_rotate` / `team_link_recover` already follow
		// (both are 300000 for exactly this reason). TWO of this tool's six actions
		// can open a dialog that legitimately waits ROTATION_CONFIRM_TIMEOUT_MS (3min)
		// for a present human, so one budget covers both:
		//   · `set-mode` — 第二道门的人类确认框 ({@link askModeDialog}, abort timer =
		//     ROTATION_CONFIRM_TIMEOUT_MS at `lib/index.js` 的 set-mode 分支);
		//   · `delete`   — {@link askDeleteConfirm}（批 H），同一个 3 分钟常量。
		// The old 60000 was BELOW that window, so on a host that really aborts
		// `exec.signal` at the budget the effective confirmation window collapsed to
		// ≤60s and the dialog fell into its "确认框失败（… aborted）" branch instead of
		// the designed timeout branch — i.e. 「确认窗口是分钟级」（README §roster 的
		// `delete` 那一行 / 批 H 设计档 §9）was not true on the real machine.
		timeoutMs: 300000,
		async execute(args, exec) {
			try {
				const action = typeof args.action === "string" ? args.action : "";
				// §3.6.2 评审 #4 (「定时 + roster 触碰时懒检查」): every roster touch is a
				// moment a stranded rotation token or an unratified provisional window
				// would be noticed, so the sweep runs here too — awaited, so it can
				// never race this call's own settings write.
				const swept = await rotation.sweep({ now: Date.now(), signal: exec.signal });
				const teams = policy.get().teams;
				const caller = agentSessionId(exec);
				const now = Date.now();

				if (action === "get") {
					const wanted = args.team === undefined || args.team === null || args.team === "" ? null : readTeamName(args.team);
					if (wanted !== null && wanted.error !== undefined) return wellFormed(`读取失败：${wanted.error}`);
					// §3.5 R2 红线：可核落点是本动作的**首行** —— 三态之一，不许静默。
					const lines = [policy.placementLine(), `团队注册表（共 ${teams.length} 个团队）：`];
					if (teams.length === 0) lines.push("（无团队：用 action=upsert-team 创建，团队名 [a-z0-9-]+）");
					for (const team of teams) {
						lines.push(`- ${team.name} — 创建于 ${readStamp(team.createdAt)} · policy.writer=${team.policy.writer} · 角色 ${team.roles.length} 个 · workspace=${team.workspace === "" ? "（未捕获）" : team.workspace}`);
						for (const entry of team.roles) {
							lines.push(`    角色 ${entry.role}：${entry.current === null ? "空缺（vacant）" : `现任 ${entry.current}（自 ${readStamp(tenureStartOf(entry, team))}）`}${recoveryLadderSuffix(entry, (id) => agentIsLive(ctx, id))}`);
						}
					}
					if (wanted !== null) {
						const team = teams.find((candidate) => candidate.name === wanted.value);
						if (team === undefined) {
							lines.push("", `读取失败：团队 ${wanted.value} 不在注册表中。`);
							return wellFormed(lines.join("\n"));
						}
						lines.push("", `团队 ${team.name} 详情：`);
						lines.push(`- workspace：${team.workspace === "" ? "（未捕获）" : team.workspace}`);
						lines.push(`- policy.writer：${team.policy.writer}（coordinator=仅现任协调者会话可写；any=任何会话可写）`);
						lines.push(`- 黑板目录：${team.workspace === "" ? "（未捕获 workspace，黑板不可用）" : blackboardPaths(team).dir}`);
						lines.push(`- 换届撤销快照（rotationBackup）：${team.rotationBackup === null ? "（无）" : `${readStamp(team.rotationBackup.at)} 时的 pairs ${team.rotationBackup.pairs.length} 条 / trustedSenders ${team.rotationBackup.trustedSenders.length} 项 / rememberTargets ${team.rotationBackup.rememberTargets.length} 项`}`);
						for (const entry of team.roles) {
							lines.push(`- 角色 ${entry.role}：${entry.current === null ? "空缺（vacant）" : `现任 ${entry.current}（自 ${readStamp(tenureStartOf(entry, team))}）`}${recoveryLadderSuffix(entry, (id) => agentIsLive(ctx, id))}`);
							lines.push(`    pending：${entry.pending === null ? "（无）" : `${entry.pending.session}（token ${maskToken(entry.pending.token)}（掩码——完整令牌只在 prepare 的一次性返回里给出），创建 ${readStamp(entry.pending.createdAt)}，到期 ${readStamp(entry.pending.expiresAt)}，绑定 team=${entry.pending.team} role=${entry.pending.role}，已迁移 ${entry.pending.migratedPairs === undefined ? 0 : entry.pending.migratedPairs.length} 条）`}`);
							lines.push(`    provisional：${entry.provisional === null ? "（无）" : `${entry.provisional.session === "" ? "" : `${entry.provisional.session} 的 `}信任迁移待批准（自 ${readStamp(entry.provisional.at)}，${readStamp(entry.provisional.expiresAt)} 到期未批准则自动回退为过门投递）`}`);
							lines.push(`    版本史（共 ${entry.history.length} 条，退役≠删除）：`);
							if (entry.history.length === 0) lines.push("      - （无）");
							for (const record of entry.history) {
								const until = record.until === null ? "现任" : readStamp(record.until);
								const note = record.note === undefined ? "" : `　备注：${preview(record.note, 200)}`;
								lines.push(`      - ${record.session}　${readStamp(record.from)} → ${until}${note}`);
							}
							const recoveries = entry.recoveries ?? [];
							if (recoveries.length > 0) {
								lines.push(`    恢复记录（共 ${recoveries.length} 条，team_link_recover 的审计；与 roster.md 镜像同源）：`);
								for (const record of recoveries) {
									const note = record.note === undefined ? "" : `　备注：${preview(record.note, 200)}`;
									lines.push(`      - ${record.verb}　${record.from ?? "（无现任）"} → ${record.to ?? "（无）"}　${readStamp(record.at)}　发起会话 ${record.by === "" ? "unknown" : record.by}${note}`);
								}
							}
						}
					}
					// §4.3（B 批）形态段：**读**面（本段与状态卡共用同一个渲染器 §4.3）。
					// 红线 2 的两条路在这里处置**不同**：宿主投影读不到 ⇒ 如实标注并保持其余
					// 四件事照给（刺眼报错是写路径 set-mode 的事），两条路不混用。
					const modeTeams = wanted === null ? teams : teams.filter((candidate) => candidate.name === wanted.value);
					const modeProjection = probeAgentTeams(ctx, exec?.agent);
					const modeOtherSessions = await otherReachableSessions(ctx, exec);
					lines.push("", "--- 团队形态（§4.3；能力矩阵的事实源 = 父档 §2.3，逐行照抄）---");
					for (const line of teamModeSectionLines(modeTeams, modeProjection, modeOtherSessions)) lines.push(line);
					lines.push("", `（读数 ${readStamp(now)}，${READ_STALE_NOTE}）`);
					if (swept.lines.length > 0) lines.push("", "换届过期清扫（本次 roster 读取触发）：", ...swept.lines);
					return wellFormed(lines.join("\n"));
				}

				if (action === "upsert-team") {
					const name = readTeamName(args.team);
					if (name.error !== undefined) return wellFormed(`创建/更新失败：${name.error}`);
					const existing = teams.find((team) => team.name === name.value) ?? null;
					// §10.2.8.9 ② 的**第二个触发面**（时机与触发面 (ii)）：这条路**没有对话框**
					// （模型可以发起它），所以它的正当性**只**来自证据门 —— 只有确证 archived/gone
					// 才放行，绝不是「模型想改就改」。甲 / 乙两种不可读形状都由 verdict 自己判。
					let release = null;
					if (existing !== null) {
						const coordinator = roleOf(existing, COORDINATOR_ROLE);
						const gate = withLiveGateDiagnostic(ctx, coordinator, writerGate(existing, caller));
						if (gate.error !== undefined) {
							const incumbent = coordinator === null ? null : coordinator.current;
							const verdict = await teamSessionReleaseVerdict(ctx, incumbent);
							if (verdict.release !== true) return wellFormed(`${gate.error}${verdict.note}`);
							release = { reason: verdict.reason, incumbent };
						}
					}
					if (caller === undefined) {
						return wellFormed("创建/更新失败：需要可交互的活动代理——workspace 在团队创建时从执行会话的 agentCwd 捕获（exec.agent.id 缺失时无法定位黑板根目录）。");
					}
					// §3.3.2 创建即认领: the creation path seeds `caller` as the
					// coordinator incumbent, so the team is writable the moment it
					// exists. An existing team ignores `coordinator` entirely.
					const applied = applyTeamUpsert(teams, { name: name.value, workspace: agentCwd(exec), now, coordinator: caller });
					let team = applied.team;
					let nextTeams = applied.teams;
					if (release !== null) {
						// 写时复检（TOCTOU）：这条路 gate 与落笔之间没有对话框，复检照跑 —— 这段窗口里的
						// 任何变化都以「零写入 + 如实报告」收场（§11.9.4 的写时复检模式）。
						const recheck = await teamSessionReleaseVerdict(ctx, release.incumbent);
						const stillIncumbent = (roleOf(team, COORDINATOR_ROLE)?.current ?? null) === release.incumbent;
						const revived = agentIsLive(ctx, release.incumbent);
						if (recheck.release !== true || !stillIncumbent || revived) {
							const causes = [
								recheck.release === true ? null : "宿主读数已不再确证「已归档 / 已不存在」",
								stillIncumbent ? null : `coordinator 现任已不是 ${release.incumbent}`,
								revived ? `${release.incumbent} 已有活动代理（已复活）` : null,
							].filter((cause) => cause !== null);
							return wellFormed(`释放并认领中止（§10.2.8.9 ② 写时复检）：${causes.join("；")} ⇒ 本次零写入。请重发命令；若现任确实回不来，走 §11.9 的恢复梯子。`);
						}
						team = applyTeamSessionRelease(team, caller, recheck.reason, now);
						nextTeams = applied.teams.map((entry) => (entry.name === name.value ? team : entry));
					}
					try {
						await policy.update({ teams: nextTeams });
					} catch (error) {
						return wellFormed(`创建/更新失败：写入设置失败（${describeError(error)}）。`);
					}
					// FR-2 注册钩子①（设计档：upsert-team 的 worker 角色创建分支）：名册落笔后立刻对齐段。
					sections?.sync();
					const mirror = await writeRosterMirror(team);
					const lines = [
						// FR-4（重钉点①）：创建/接管的那一刻 = 角色诞生点，带一行宪章要点（role=false 时不带）。
						...(((applied.created || release !== null) && sectionsSwitches(policy.get()).role !== false) ? [charterReinforceLine(team.name)] : []),
						applied.created
							? `已创建团队 ${team.name}：policy.writer=coordinator，coordinator 已由创建会话 ${caller} 认领（创建即认领，§3.3.2 bootstrap），workspace=${team.workspace}（自执行会话 agentCwd 捕获）。`
							: release !== null
								? `团队 ${team.name} 已存在，且原现任协调者 ${release.incumbent} 确证失联（${release.reason === "archived" ? "已归档" : "已不存在"}）⇒ 按 §10.2.8.9 ② **释放并接管**：版本史写入「${TEAM_SESSION_RELEASE_NOTES[release.reason]}」、current 置为调用会话 ${caller}；**既有角色与它们的现任逐字未动**，policy.writer 仍为 ${team.policy.writer}（未放宽成 any）。`
								: `团队 ${team.name} 已存在：upsert-team 幂等——roles / 版本史 / createdAt / policy 均未改动${applied.capturedWorkspace ? `（仅补记首次捕获的 workspace=${team.workspace}）` : ""}。`,
						`现状：policy.writer=${team.policy.writer} · 角色 ${team.roles.length} 个 · 创建于 ${readStamp(team.createdAt)}。`,
						mirrorNote(mirror),
					];
					if (applied.created) lines.push("下一步：直接开始协作（team_link_team_append 写黑板 / team_link_send 派活），用 action=set-role 增补其它角色；换届走 team_link_rotate。注意 policy.writer=coordinator 下只有现任协调者会话可写——创建者现在就是现任，若要交给别的会话，请在交班时用 action=set-role 显式指定。");
					return wellFormed(lines.join("\n"));
				}

				if (action === "set-role") {
					const name = readTeamName(args.team);
					if (name.error !== undefined) return wellFormed(`写入失败：${name.error}`);
					const team = teams.find((candidate) => candidate.name === name.value) ?? null;
					if (team === null) return wellFormed(`写入失败：团队 ${name.value} 不在注册表中（先用 action=upsert-team 创建）。`);
					const gate = withLiveGateDiagnostic(ctx, roleOf(team, COORDINATOR_ROLE), writerGate(team, caller));
					if (gate.error !== undefined) return wellFormed(gate.error);
					const role = readRoleName(args.role);
					if (role.error !== undefined) return wellFormed(`写入失败：${role.error}`);
					const session = readSessionId(args.session);
					if (session.error !== undefined) return wellFormed(`写入失败：${session.error}`);
					const note = readNote(args.note);
					const applied = applySetRole(team, { role: role.value, session: session.value, note, now });
					try {
						await policy.update({ teams: teams.map((entry) => (entry.name === team.name ? applied.team : entry)) });
					} catch (error) {
						return wellFormed(`写入失败：写入设置失败（${describeError(error)}）。`);
					}
					// FR-2: 换现任 = 段要跟着换会话（旧现任 dispose、新现任注册，U3 的同一机制）。
					sections?.sync();
					const mirror = await writeRosterMirror(applied.team);
					const entry = roleOf(applied.team, role.value);
					return wellFormed([
						`已设置：团队 ${team.name} 的角色 ${role.value} —— ${applied.previous === null ? "原为空缺，现指定" : `原任 ${applied.previous} 被替换为`} ${session.value}（自 ${readStamp(now)}）。`,
						`版本史 ${entry === null ? 0 : entry.history.length} 条${applied.previous === null ? "" : `（旧任 ${applied.previous} 记录 until=${readStamp(now)}）`}${note === undefined ? "" : `；备注：${preview(note, 200)}`}。`,
						"未迁移 pairs：换届的信任迁移是 rotation（M4）的专属动作，set-role 只换身份（§3.3.2）。",
						// §3.6.2 评审 #9: seating the rotation's own successor kills that
						// token, and the successor has to hear it here — otherwise its later
						// claim just says「没有 pending」with no visible reason.
						...(applied.clearedPending
							? [`已作废在飞令牌：本次指定的会话正是换届 pending 的继任者（${session.value}）——身份已由本次显式变更，令牌失效、冻结随之解除；该换届不再可能用原令牌 claim（claim 会报「没有 pending」）。要重建信任迁移请由现任重新 prepare。`]
							: []),
						mirrorNote(mirror),
					].join("\n"));
				}

				if (action === "retire") {
					const name = readTeamName(args.team);
					if (name.error !== undefined) return wellFormed(`退役失败：${name.error}`);
					const team = teams.find((candidate) => candidate.name === name.value) ?? null;
					if (team === null) return wellFormed(`退役失败：团队 ${name.value} 不在注册表中。`);
					const gate = withLiveGateDiagnostic(ctx, roleOf(team, COORDINATOR_ROLE), retireGate(team, caller));
					if (gate.error !== undefined) return wellFormed(gate.error);
					const role = readRoleName(args.role);
					if (role.error !== undefined) return wellFormed(`退役失败：${role.error}`);
					const note = readNote(args.note);
					const applied = applyRetire(team, { role: role.value, note, now });
					if (applied.error !== undefined) return wellFormed(`退役失败：${applied.error}`);
					try {
						await policy.update({ teams: teams.map((entry) => (entry.name === team.name ? applied.team : entry)) });
					} catch (error) {
						return wellFormed(`退役失败：写入设置失败（${describeError(error)}）。`);
					}
					// FR-2: vacant 的角色没有段可挂（旧现任的段在这里被释放）。
					sections?.sync();
					const mirror = await writeRosterMirror(applied.team);
					const lines = [
						`已退役：团队 ${team.name} 的角色 ${role.value} —— 现任 ${applied.retired} 置空（vacant），版本史记录 until=${readStamp(now)}${note === undefined ? "" : `，备注：${preview(note, 200)}`}。`,
						mirrorNote(mirror),
					];
					// §3.3.2 optional cleanup: one dialog listing every trust reference that
					// still points at the retired session, in both directions. Retire itself
					// already happened — the cleanup can only fail soft.
					const view = policy.get();
					const references = trustReferencesTo(view, applied.retired);
					const userQuestions = ctx.get?.("userQuestions");
					if (references.total === 0) {
						lines.push("信任清理：没有指向该会话的 pairs / trustedSenders / rememberTargets，无需清理。");
					} else if (userQuestions === undefined || typeof userQuestions.ask !== "function") {
						lines.push(`信任清理已跳过：确认服务（userQuestions）不可用。退役本身已完成；${references.pairs.length} 个 pairs、${references.trustedSenders.length} 个 trustedSenders、${references.rememberTargets.length} 个 rememberTargets 仍指向该会话（不是安全洞——pairs 照旧过门——只是死数据），可由用户在设置 team-link 中删除。`);
					} else {
						let choice;
						try {
							const answer = await userQuestions.ask({
								questions: [{
									id: "retire-cleanup",
									header: "退役信任清理",
									question: wellFormed([
										`会话 ${applied.retired} 已从团队 ${team.name} 的角色 ${role.value} 退役。`,
										"",
										"以下信任引用仍指向该会话（含跨端两个方向）：",
										`- pairs（${references.pairs.length} 个，双向配对）：${references.pairs.length === 0 ? "（无）" : references.pairs.map((pair) => `${pair.a} ↔ ${pair.b}`).join("，")}`,
										`- trustedSenders（${references.trustedSenders.length} 个，该会话在「免确认接收的发送方」列表中）：${references.trustedSenders.length === 0 ? "（无）" : references.trustedSenders.join("，")}`,
										`- rememberTargets（${references.rememberTargets.length} 个，该会话在「免确认发送目标」列表中）：${references.rememberTargets.length === 0 ? "（无）" : references.rememberTargets.join("，")}`,
										"",
										"确认后清理这些引用；保留则它们原样留在设置里（配对通道照旧过门，不是安全洞，只是死数据堆积）。",
									].join("\n")),
									options: [
										{ label: "清理", description: "删除上面列出的、指向退役会话的 pairs / trustedSenders / rememberTargets（对话框打开期间新增的信任引用不受影响）" },
										{ label: "保留", description: "不改动信任数据（死数据保留，可随时在设置里删除）" },
									],
								}],
								agent: exec.agent,
								signal: exec.signal,
							});
							choice = answer?.answers?.[0]?.selected?.[0];
						} catch (error) {
							lines.push(`信任清理未完成：确认对话框失败（${describeError(error)}）；引用保持原样，退役本身已完成。`);
						}
						if (choice === "清理") {
							try {
								// R1 (M2 review): the dialog spans an unbounded human wait, so the
								// reference list collected BEFORE it is a display artifact, not the
								// write basis — writing `view` back would silently drop every pair and
								// trust entry created while the dialog was open. Re-read the store and
								// remove only the references the dialog listed AND that are still
								// present, which shrinks the read-modify-write window from the length
								// of the dialog to this synchronous block.
								const latest = policy.get();
								const listedPairs = new Set(references.pairs.map((pair) => `${pair.a}\n${pair.b}\n${pair.createdAt}`));
								const pairs = latest.pairs.filter((pair) => !listedPairs.has(`${pair.a}\n${pair.b}\n${pair.createdAt}`));
								const trustedSenders = latest.trustedSenders.filter((id) => !references.trustedSenders.includes(id));
								const rememberTargets = latest.rememberTargets.filter((id) => !references.rememberTargets.includes(id));
								await policy.update({ pairs, trustedSenders, rememberTargets });
								lines.push(`已清理：${latest.pairs.length - pairs.length} 个 pairs / ${latest.trustedSenders.length - trustedSenders.length} 个 trustedSenders / ${latest.rememberTargets.length - rememberTargets.length} 个 rememberTargets（按最新设置视图过滤：对话框里列出、期间已被其它变更删掉的引用不再计入；对话框期间新增的信任引用不受影响）。`);
							} catch (error) {
								lines.push(`信任清理失败：写入设置失败（${describeError(error)}）；退役本身已完成。`);
							}
						} else if (choice === "保留") {
							lines.push("已保留全部信任引用（未做任何清理）。");
						} else if (choice !== undefined) {
							lines.push(`信任清理未执行：对话框返回「${choice}」，不是明确同意。`);
						}
					}
					return wellFormed(lines.join("\n"));
				}

				if (action === "delete") {
					// D2 / US-H2：这一步**刻意不过 `writerGate`** —— 已退役（vacant）的队没有现任
					// 协调者，沿用 gate 就谁都删不掉，功能对它的目标场景等于没做；把关改由下面
					// `deleteTeam` 里那道人类确认框承担（fail-closed）。**其余动作的 gate 逐字未动**
					// （U8 用同一批夹具的 set-role / retire / set-mode / upsert-team 拒绝相钉住）。
					const name = readTeamName(args.team);
					if (name.error !== undefined) return wellFormed(`删除失败：${name.error}`);
					// 拒绝路径一律零写入：校验存在性 / 确认 / 写前重读 / 写入抛错四条路都在
					// `deleteTeam` 里以 `{ ok: false }` 收场（U4 / U5 / U10）。
					const outcome = await deleteTeam(ctx, exec.agent, policy, name.value, exec.signal);
					if (outcome.ok !== true) return wellFormed(`删除失败：${outcome.reason}`);
					// FR-2：与 set-role / retire / upsert-team 同一条「名册写入点」钩子 —— 被删团队
					// 的段在这里被释放（`planSections` 按新鲜名册算，该队的角色已不在其中）。
					sections?.sync();
					return wellFormed([
						`已删除：团队 ${name.value} 的名册行（连同它自己的版本史 —— 角色 ${outcome.roleCount} 个 / 版本史共 ${outcome.historyCount} 条）。该团队已不在名册里（team_link_roster action=get 与 team_link_status 都不再列出它）。`,
						`未改动：pairs / trustedSenders / rememberTargets（信任数据一个字未写）· watchdogs 一行未写（批 G 的 auto 注册会因「团队不在名册里」在下次巡逻被名册门拒绝而自清，那是既有语义）· 其它团队行未动。`,
						await blackboardUntouchedLine({ name: name.value, workspace: outcome.workspace }),
					].join("\n"));
				}

				if (action === "set-mode") {
					const name = readTeamName(args.team);
					if (name.error !== undefined) return wellFormed(`切换失败：${name.error}`);
					const team = teams.find((candidate) => candidate.name === name.value) ?? null;
					if (team === null) return wellFormed(`切换失败：团队 ${name.value} 不在注册表中（先用 action=upsert-team 创建）。`);
					// 双重门之一（**writer gate 原样**）：不是现任协调者 / 现任空缺 ⇒ 拒绝（空缺那一路
					// 的兜底仍是设置 UI，本工具不放宽任何一档）。
					const gate = withLiveGateDiagnostic(ctx, roleOf(team, COORDINATOR_ROLE), writerGate(team, caller));
					if (gate.error !== undefined) return wellFormed(gate.error);
					// ---- 参数读取在任何副作用之前：拒绝一律**零写入**（U7）----
					const mode = typeof args.mode === "string" ? args.mode.trim() : "";
					if (!TEAM_MODES.has(mode)) {
						return wellFormed(`切换失败：mode 必须在闭集内（${TEAM_MODE_LIST}）—— 当前${mode === "" ? "缺失" : `是「${preview(mode, 40)}」`}；两档的含义与能力矩阵见 team_link_roster action=get 的形态段。`);
					}
					const leadGiven = args.leadSessionId !== undefined && args.leadSessionId !== null;
					if (mode === TEAM_MODE_SESSIONS && leadGiven) {
						return wellFormed("切换失败：leadSessionId 只对 agent-team 档生效（多会话档没有 Lead 这个角色）—— 参数误用一律拒绝，防它静默生效；切回多会话档请只给 mode=sessions（本插件会把 Lead 指针清空）。");
					}
					let lead = "";
					let leadIsDefault = false;
					if (mode === TEAM_MODE_AGENT_TEAM) {
						if (leadGiven) {
							const read = readLeadSessionId(args.leadSessionId);
							if (read.error !== undefined) return wellFormed(`切换失败：${read.error}`);
							lead = read.value;
						} else {
							if (caller === undefined) return wellFormed("切换失败：省略 leadSessionId 时默认取**调用方自己**的会话 id，而本次执行上下文没有会话身份（exec.agent.id）—— 请显式给 leadSessionId。");
							lead = caller;
							leadIsDefault = true;
						}
					}
					const currentLead = typeof team.leadSessionId === "string" ? team.leadSessionId : "";
					// §4.2 幂等（D8 放宽）：同档同 Lead **且账上已有这一档的形态史行** ⇒ 已是该档，
					// 不弹框、不写 settings、零写入；账上**缺**那一行（例如上一次 settings 写成功而
					// decisions 写失败）⇒ **补记一行**再返回 —— 否则「每次切换留一行」（US6）会被幂等
					// 分支永久破坏，而失败时给出的指路「重发本次切换以补记」也就不可执行。
					if (team.mode === mode && currentLead === lead) {
						const backfill = await backfillModeHistoryRow(team, mode, lead, exec);
						return wellFormed([
							`已是该档：团队 ${team.name} 的形态已经是 ${mode}${mode === TEAM_MODE_AGENT_TEAM ? `（Lead=${lead}）` : ""}—— 本次**不弹确认框、不写 settings**（形态史记的是「声明过这一档」，不是「档位发生变化」—— **首次声明也算一行**，故账上缺行时补记）；账上那一行见下。`,
							backfill,
							"两档的能力矩阵见 team_link_roster action=get 的形态段。",
						].join("\n"));
					}
					// ---- 在场校验（只对**显式给出**的 Lead；默认值不查，见下面那条注释）----
					if (mode === TEAM_MODE_AGENT_TEAM && leadGiven) {
						const snapshot = await sessionIdSnapshot(ctx);
						if (snapshot === null) return wellFormed("切换失败：本次会话列表快照读取失败——Lead 的在场校验无法完成，拒绝写入（宁可不切，也不写一个找不到的 Lead；可先调 team_link_list_sessions 确认列表可读）。");
						if (!snapshot.includes(lead)) return wellFormed(`切换失败：leadSessionId ${lead} 在本次会话列表快照里找不到（本次列表共 ${snapshot.length} 个会话）—— 多半是 id 转录错位；请先调 team_link_list_sessions 复制正确的 id 再重发。`);
					}
					// ---- 宿主探测：**只对「切到 agent-team」这一向**（US3 / 红线 2）----
					let probe = null;
					if (mode === TEAM_MODE_AGENT_TEAM) {
						probe = probeAgentTeams(ctx, exec?.agent);
						if (probe.available !== true) {
							return wellFormed([
								`切换被拒绝：本宿主现在到不了 agent-team 档 —— ${probe.reason}。`,
								AGENT_TEAMS_HOWTO,
								MODE_SETTINGS_FALLBACK,
								"本次**零写入**：settings 逐字节未动、decisions.md 未追加、连确认框都没弹（红线 2：宿主不可用即刺眼报错 + 指路，绝不把 agent-team 请求当多会话执行）。",
								"仍可用的两件事：① 保持多会话档继续用现有能力（投递 / 配对 / 换届 / 看门狗都在主用途上）；② 确实需要单会话团队时，先按上面把宿主打开，再重发本次切换。",
							].join("\n"));
						}
					}
					// ---- 第二道门：人类确认框（无服务 / 超时 / 取消 ⇒ 拒绝且零写入）----
					// 名册投影用**同一个**探测函数读，但两条路的处置不同：这里只决定确认框正文里
					// 「当前 teammate」那一行照实写谁（不可读 ⇒ 如实说不可读，绝不编造）。
					// R2（收尾修复轮）: **同一个判据只取一次** —— 「切到 agent-team」那一向上面刚探过
					// （probe），这里直接复用为确认框正文的投影；只有「切回 sessions」那一向没有前置
					// 探测，才在这里现读一次。两条路的处置各自决定（可用性门 vs. 正文那一行），
					// 判据仍然只此一处。
					const projection = probe ?? probeAgentTeams(ctx, exec?.agent);
					const teammates = projection.readable
						? (projection.members.length === 0 ? "（宿主团队当前没有成员行）" : projection.members.map(memberLine).join("、"))
						: "（成员名册不可读）";
					const targetSuffix = mode === TEAM_MODE_AGENT_TEAM
						? `（Lead=${lead}${leadIsDefault ? "；**省略 leadSessionId ⇒ 默认取本次调用会话自己**，不同意就取消后显式给另一个 id" : "（本次显式给出）"}）`
						: "（Lead 指针清空：多会话档没有这个角色）";
					const dialog = await askModeDialog(ctx, exec, {
						question: [
							`把团队 ${team.name} 的形态从 ${team.mode} 切到 ${mode}？`,
							"",
							`- 现状：形态=${team.mode}${currentLead === "" ? "" : `（Lead=${currentLead}）`} · policy.writer=${team.policy.writer} · 角色 ${team.roles.length} 个`,
							`- 切换后：形态=${mode}${targetSuffix}`,
							...(probe === null ? [] : ["- 宿主探测：**可到**（agentTeams 服务在、读面形状认）—— 本插件在 agent-team 档下只做名册与指路，不代理宿主的派活 / 任务板。"]),
							"",
							...TEAM_MODE_NO_MIGRATION_LINES,
							`当前 teammate（若可读）：${teammates}`,
							"请确认它们的结论已落到黑板或文件 —— 本提示不阻断切换。",
							"",
							"确认后：settings 的 teams 行写入形态与 Lead（只改本团队行的这两个键），并 best-effort 重写 roster.md 镜像，再在 decisions.md 追加**恰好一行**形态史。本插件**不做跨形态改投**：在飞消息一条都不重路由、也不建桥（§7 不做）。",
						].join("\n"),
						detail: "两档白话：多会话档 = 平级会话之间靠本插件的身份与信任层（投递 / 配对 / 换届 / 黑板）；agent-team 档 = 一个会话内部的子代理团队，本插件只做名册与指路。切档**换的是通道，不是人**：信任不自动迁移，旧配对必须人重新批准（fail-closed）。",
						confirmDescription: `切换 ${team.mode} → ${mode}（写 settings + decisions.md 恰好一行）`,
					});
					if (dialog.confirmed !== true) {
						return wellFormed([
							`切换未执行（目标档 ${mode}）：${dialog.reason}`,
							`本次零写入：settings 与 decisions.md 逐字节未动，团队 ${team.name} 的形态仍为 ${team.mode}。`,
						].join("\n"));
					}
					// 写时复检（TOCTOU，与 upsert-team / recover 同一条纪律）：确认框横跨任意长的人工
					// 等待，所以条件由**宿主观测**、不由调用方主张。
					const reopened = policy.get();
					const teamNow = reopened.teams.find((candidate) => candidate.name === team.name) ?? null;
					const gateNow = teamNow === null ? { error: "该团队已不在注册表中。" } : writerGate(teamNow, caller);
					if (gateNow.error !== undefined) {
						return wellFormed(`切换中止（写时复检）：确认框期间团队 ${team.name} 的状态变了 —— ${gateNow.error}本次零写入。`);
					}
					const nextTeams = reopened.teams.map((entry) => (entry.name === team.name ? { ...entry, mode, leadSessionId: lead } : entry));
					try {
						await policy.update({ teams: nextTeams });
					} catch (error) {
						return wellFormed(`切换失败：写入设置失败（${describeError(error)}）。`);
					}
					// D3: set-mode 也是一次**设置变更**，所以与既有调用点（upsert-team / set-role / retire）
					// 同形：落笔后立刻 best-effort 重写 roster.md 镜像 —— 否则镜像里那两个字段会一直缺，
					// 而镜像文件自述「与设置变更同一事务内镜像」，那句自述对本字段就成了假话。
					// R3（收尾修复轮）: 镜像与形态史必须**同源** —— 两者都取**复检后**的那一行。此前
					// 镜像用复检后的行、形态史用**对话框前**的 team：用户在确认框打开期间经设置 UI 改了
					// workspace 时，镜像写新路径而账写旧路径，账与镜像就此分家（TOCTOU 复检后的不对称）。
					const teamWritten = nextTeams.find((entry) => entry.name === team.name) ?? team;
					const mirror = await writeRosterMirror(teamWritten);
					// ---- decisions.md 追加**恰好一行**形态史（§4.2；D8）----
					// 正文与写入都走**共享**的一条路（`modeHistoryBody` ＋ `appendModeHistoryRow`）：幂等分支
					// 的补记判据读的是同一个正文常量 —— 两处各写一份字面量就是本仓最反对的「双份真相」。
					// R3: 形态史与镜像**同一行来源**（都是复检后的 `teamWritten`），两者不许各取一份行。
					const historyLine = await appendModeHistoryRow(teamWritten, modeHistoryBody(mode, lead), exec, "形态史", "settings 已写入，");
					const teamAfter = policy.get().teams.find((candidate) => candidate.name === team.name) ?? team;
					return wellFormed([
						`已切换形态：团队 ${team.name} —— ${team.mode} → ${mode}${mode === TEAM_MODE_AGENT_TEAM ? `（Lead=${lead}）` : ""}（自 ${readStamp(now)}）。`,
						`- policy.writer=${teamAfter.policy.writer} 未动 · 信任一行未写（pairs / trustedSenders / rememberTargets 逐字节不变，红线 3）· 成员名册一行未落 settings（红线 5：只存 Lead 指针${lead === "" ? "（本次清空）" : ` ${lead}`}）。`,
						historyLine,
						mirrorNote(mirror),
						...(mode === TEAM_MODE_SESSIONS ? ["- 切回多会话档**不会自动回迁信任**：旧配对可能早已过期，要重新说话请走正常的双门（重新批准或重新配对）。"] : []),
						"",
						...modeCapabilityLines(mode),
					].join("\n"));
				}

				return "操作失败：action 必须是 get / upsert-team / set-role / retire / set-mode / delete。";
			} catch (error) {
				return wellFormed(`roster 操作失败：${describeError(error)}`);
			}
		},
	})), "team-link: roster tool");
}

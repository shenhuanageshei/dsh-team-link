// ---------------------------------------------------------------------------
// 工具注册域（registration）：M1 模型可见工具族的注册器 —— 批 R（上架合规）从 `lib/index.js` 原样搬出
// ---------------------------------------------------------------------------
// 归属：docs/2026-10-15-store-compliance-design.md §6「边界规则」· §4 D1/D2/D4 · §5 FR-R1 · §8 Rr1/Rr3/Rr4。
// ★ 本档是什么：**一个**注册器 —— `registerTools(ctx, policy, watchdog, chainReport, forensics)`，
//   它一次注册 M1 那一族模型可见工具（列表 `team_link_list_sessions` · 状态卡 `team_link_status` ·
//   导出 `team_link_export` · 投递 `team_link_send` · 看门狗 `team_link_watch` · 屏蔽 `team_link_block`），
//   连同它自己的文档注释与区域横幅。**函数体一个字符都没动**（设计档 D4）。
// ★ 本档**不是**（留给下一小单）：`registerTeamTools`（名册/黑板/形态那几条工具，实测 ≈92.8 KB）——
//   它仍住在入口，且实测它依赖 `writerGate` / `relayUserMessage` **两个被钉符号** ⇒ 搬它必须另作
//   设计（本单按「宁可少搬、也要绿」只搬一个）。`registerRotationTools` / `registerRecoveryTools` /
//   `registerReadRoutes` 与它们各自的文档注释也仍在入口。
// ★ 依赖方向（Rr4「模块图无环」的实测口径）：本档**不导入入口** `lib/index.js`（那会构成 ESM 环，
//   实跑当场 TDZ）—— 于是本档的出边只有两类，模块图仍是单向 DAG：
//   ① 内部相对导入 `./shared.js` / `./ledger.js` / `./rotation.js` / `./sections.js`（宿主半边既有域档），
//      实测 16 条（`describeError` / `preview` / `readStamp` / `wellFormed` / `sanitizeFraming` /
//      `agentSessionId` / `COORDINATOR_ROLE` / 黑板四条 / 换届两条 / 段两条 / `defineTool`）；
//   ② **装配缝注入**（先例：`lib/forensics.js` 的 `wireForensics()` 与 `lib/rotation.js` 的 `extras`）：
//      入口侧那 52 条出口由 `wireRegistration(extras)` 在模块求值时一次性绑定到本档的同名模块级
//      `let` 上，**绑定与搬迁前逐个同一** ⇒ 行为逐字不变。
// ★ 为什么这 52 条走缝而不搬：它们**都不是本域私有** —— 每一条在入口侧都另有真实调用点（列表/看板/
//   名册/投递/看门狗/导出各域），搬走就是「同一函数两份」（设计档 §6 明令禁止双事实源）；而入口
//   **不能**再导出给域档静态导入（环）⇒ 缝是唯一不破环的路。逐条归属见入口 `registrationExtras()`。
// ★ 被钉符号核对（本仓 `hostSource` 文本锁钉住的 9 个：`writePolicyFileAtomic` / `renameThroughSeam` /
//   `POLICY_FILE_SCHEMA` / `WATCHDOG_DIGEST_DEBOUNCE_MS` / `TICKABLE_VERDICTS` / `agentStateLabel` /
//   `writerGate` / `relayUserMessage` / `buildTeamSessionCreateOptions`）：**本单一个都没搬**，九个仍
//   逐字节住在入口。本档与它们的唯一接触是 `agentStateLabel` —— 这一族工具的依赖，经缝传入；它的
//   定义与文档注释原地未动，于是那条「按函数自身锚点切片」的锁（`hostSource.lastIndexOf("/**", at)`
//   → `hostSource.indexOf("\n}", at)`）读数一字不变。
// ★ 宿主依赖面：本档的**宿主**说明符只有 `@deepseek-ai/dsh-tools`（`defineTool`，既有白名单那 8 条之一）
//   ⇒ `hostHalfSpecifiers()` 的集合读数仍是那 8 条，`Rr3` 不受影响。
// ★ 搬运纪律（D4）：被搬的那一块**只多出 7 个字符** —— 签名前的 `export `；其余逐字节等于原位置
//   （含区域横幅与文档注释，机检见 docs/verification-log.md 的本小单读数）。
// ---------------------------------------------------------------------------

import { defineTool } from "@deepseek-ai/dsh-tools";

import { COORDINATOR_ROLE, agentSessionId, describeError, preview, readStamp, sanitizeFraming, wellFormed } from "./shared.js";
import { blackboardHash, blackboardLines, blackboardPaths, readBlackboardFile } from "./ledger.js";
import { isExpiredProvisionalPair, roleOf } from "./rotation.js";
import { budgetSectionLines, charterReinforceLine } from "./sections.js";

// ---------------------------------------------------------------------------
// 装配缝 · `wireRegistration(extras)`（先例：`lib/forensics.js` 的 `wireForensics()`）
// ---------------------------------------------------------------------------
// 前置：入口在**模块求值**时调用一次（`lib/index.js` 模块尾部，紧挨 `wireForensics({…})`），
//       给出的 52 个键与被注入的绑定**同名同值**。
// 后置：本档的模块级 `let` 全部绑定到入口那一份真实现；此后每次工具执行读到的都是它。
// 为什么不是 import：见档头「依赖方向」①（入口 → 域档会成环）。
// 为什么是一次性绑定而不是每次调用现取：工具执行是热路径，绑一次就够；而且函数体内那 52 个裸名
// 因此**逐字节保留**（只在函数体外加了这一个缝），D4 的逐字节等价可以直接机检。
// ---------------------------------------------------------------------------
let LIST_LIMIT, LV_WINDOW_NOTE, PREVIEW_SESSIONS, READ_STALE_NOTE, SEND_CARD_BY_ARGS, STATUS_LV_WINDOW_NOTE,
STATUS_TASKS_TAIL_DEFAULT, STATUS_TASKS_TAIL_MAX, WATCHDOG_MAX_PER_SESSION, WATCHDOG_ORIGIN_AUTO, agentCwd,
agentStateLabel, blockListLines, blockPair, buildLivenessSignal, buildSendCard, buildWatchdogRegistration, buildWatchdogMute, buildWatchdogUpdate,
chainReportLine, clearLegacy, deliverToTarget, ensureTeamAutoWatchdogs, exportSession, fanout,
firstSurfaceUserText, forDisplay, isIncumbentCoordinator, lastSurfaceText, ledgerRowTime, listReadTail,
livenessLine, loadScopedSessionRecords, pendingLines, probeAgentTeams, readListReadWindow, readMeta,
readStatusTasksTail, readTeamName, resolveTargetList, reverseWarningNote, sendCardMessage, sendOutput,
sessionFaceLine, sessionLabel, teamModeSectionLines, teamRoleLines, textOutput, unblockPair, watchdogLines,
watchdogRenewField, windowReadingFor, windowWorkspaceFor, withMetaNotes;

/** 入口侧出口的一次性绑定（见本节档头的前置 / 后置）。 */
export function wireRegistration(extras) {
	({
		LIST_LIMIT,
		LV_WINDOW_NOTE,
		PREVIEW_SESSIONS,
		READ_STALE_NOTE,
		SEND_CARD_BY_ARGS,
		STATUS_LV_WINDOW_NOTE,
		STATUS_TASKS_TAIL_DEFAULT,
		STATUS_TASKS_TAIL_MAX,
		WATCHDOG_MAX_PER_SESSION,
		WATCHDOG_ORIGIN_AUTO,
		agentCwd,
		agentStateLabel,
		blockListLines,
		blockPair,
		buildLivenessSignal,
		buildSendCard,
		buildWatchdogRegistration,
		buildWatchdogMute,
		buildWatchdogUpdate,
		chainReportLine,
		clearLegacy,
		deliverToTarget,
		ensureTeamAutoWatchdogs,
		exportSession,
		fanout,
		firstSurfaceUserText,
		forDisplay,
		isIncumbentCoordinator,
		lastSurfaceText,
		ledgerRowTime,
		listReadTail,
		livenessLine,
		loadScopedSessionRecords,
		pendingLines,
		probeAgentTeams,
		readListReadWindow,
		readMeta,
		readStatusTasksTail,
		readTeamName,
		resolveTargetList,
		reverseWarningNote,
		sendCardMessage,
		sendOutput,
		sessionFaceLine,
		sessionLabel,
		teamModeSectionLines,
		teamRoleLines,
		textOutput,
		unblockPair,
		watchdogLines,
		watchdogRenewField,
		windowReadingFor,
		windowWorkspaceFor,
		withMetaNotes,
	} = extras);
}


// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

/** Register the M1 model-facing tools on the tools service: the listing with its
 * liveness rows, the export, the cross-session send and the watchdog (§3.1/§3.2). */
export function registerTools(ctx, policy, watchdog, chainReport, forensics = null) {
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_list_sessions",
		description: "列出当前工作区（同目录）的其他 DSH 会话：id、标题/主题摘要、运行状态、创建时间、最近动态，以及每个会话的活性信号行（verdict 五态：ok / goal-disarmed / silent-idle / long-running / dead，含 goal 状态与静默时长）。会话日志**默认**只读前 12 个会话（PREVIEW_SESSIONS）且并行读，未读的行如实标注（verdict/静默/主题均未判定，行本身照常列出）；列表末尾给「未读 Y 行 + 怎么读」的提示。**要读窗口外/更多的行，用两个可选且互斥的参数**：readIds（点名读，把指定会话强制纳入本次读窗，≤12 个、只接受本次列表内的 id，超出或未知一律拒绝且本次零读）或 offset（分页：从第 offset+1 行起读 12 行，整数，越界拒绝并给出有效区间）。成本上限不变：三条路径的单次调用 surface 读数都 ≤ 12。供跨会话导出、发送前查目标、或判断队友是否失联。读数是快照：行尾附读数时间戳，超过 2 分钟应重新读取。",
		parameters: {
			includeOtherProjects: { type: "boolean", description: "同时列出其他项目目录的会话（默认仅当前工作区目录）" },
			readIds: { type: "array", items: { type: "string" }, description: "点名读：把指定会话强制纳入本次读窗（用于窗口外的行；点名优先占额，其余按原顺序补足到 12）。上限 12 个（去重后计数），超出即拒绝且本次零读；只接受本次列表内的会话 id，未知或不属于本列表的 id 一律拒绝并指出。与 offset 互斥" },
			offset: { type: "number", description: "分页：从第 offset+1 行开始读 12 行（默认 0）。必须是整数；负数或越界（≥ 列表行数）即拒绝并给出有效区间。与 readIds 互斥" },
		},
		output: textOutput(),
		timeoutMs: 60000,
		async execute(args, exec) {
			try {
				const selfId = agentSessionId(exec);
				const cwd = agentCwd(exec);
				const records = await ctx.sessionQuery.listSessions(undefined);
				const sameProject = records.filter((record) => record.header.cwd === cwd);
				const pool = (args.includeOtherProjects === true ? records : sameProject).filter((record) => record.header.id !== selfId);
				const shown = pool.slice(0, LIST_LIMIT);
				// §4.1（可观测批 A）: the read window is decided from the caller's
				// arguments BEFORE any session log is touched — so every refusal below
				// (more names than the window, a name outside THIS listing, a bad offset,
				// both controls at once) is a refusal with ZERO surface reads (U4/U5/U6).
				const read = readListReadWindow(args, shown);
				if (read.error !== undefined) return wellFormed(`列出会话失败：${read.error}`);
				const ids = shown.map((record) => record.header.id);
				const titles = new Map();
				if (ids.length > 0) {
					try {
						const snapshots = await ctx.sessionQuery.readTitleSnapshots(ids);
						for (let index = 0; index < snapshots.length; index += 1) {
							const snapshot = snapshots[index];
							if (snapshot?.status === "fulfilled" && typeof snapshot.value?.title === "string") titles.set(ids[index], snapshot.value.title);
						}
					} catch {
						/* titles are best-effort decoration */
					}
				}
				// One surface read per row of the WINDOW feeds both faces below: the
				// liveness signal (§3.1) needs the last assistant/inbound times and the
				// running turn's start, and the digest folds the same surface into a
				// topic + last-activity preview. A cold or unreadable log is not an
				// error here — both faces degrade to "unknown" and the row still lists.
				//
				// The window is what keeps this tool inside its budget: a cold log costs a
				// zstd decompression plus a surface projection, so reading one per listed
				// session (LIST_LIMIT = 50) overruns the tool timeout on a real workspace.
				// Rows past the window still list, and their liveness line says the row was
				// not read (LV_WINDOW_NOTE).
				// The window comes from the caller (§4.1): the default first
				// PREVIEW_SESSIONS rows, a page of them (offset), or the named rows plus
				// the head of the listing (readIds) — all capped at PREVIEW_SESSIONS by
				// construction, which is the cost invariant this batch does not move.
				const readWindow = read.records;
				// Parallel, not serial: a window of N cold logs costs one decompression's
				// latency, not N. Each read settles alone (an async executor turns even a
				// synchronous throw into a rejection), so one failing log cannot take the
				// rest of the window's liveness rows down with it.
				const settled = await Promise.allSettled(readWindow.map(async (record) => await ctx.sessionQuery.readSurface(record.header.id)));
				const surfaces = new Map();
				for (let index = 0; index < readWindow.length; index += 1) {
					const outcome = settled[index];
					if (outcome.status === "fulfilled") surfaces.set(readWindow[index].header.id, outcome.value);
				}
				const topics = new Map();
				const activities = new Map();
				for (const record of readWindow) {
					const surface = surfaces.get(record.header.id);
					if (surface === undefined) continue;
					const topic = firstSurfaceUserText(surface.events);
					if (topic !== undefined) topics.set(record.header.id, topic);
					const activity = lastSurfaceText(surface.events);
					if (activity !== undefined) activities.set(record.header.id, activity);
				}
				// One reading time for the whole listing: the liveness rows are a
				// snapshot, and every session row says when it was taken and when it
				// stops being trustworthy (§3.1 防偏离).
				const now = Date.now();
				// §3.6.2 评审 #3 (provisional 可见面): an unratified rotation channel is
				// marked on the session row of both parties, so a worker can see that a
				// message arriving over it rides trust that rolls back in 24h.
				// 口径与投递侧对齐（§9.6 ⑧ / 评审 #8）: a provisional record past its
				// deadline is NOT a pair any more — the delivery path already walks the
				// ordinary gates for it. Counting it here would advertise a bypass
				// channel that has already closed (exactly the window between the 24h
				// deadline and the next sweep), so the row uses the same liveness
				// predicate as `pairRecordBetween`.
				const provisionalBySession = new Map();
				for (const pair of policy.get().pairs) {
					if (pair.provisional !== true) continue;
					if (isExpiredProvisionalPair(pair, now)) continue;
					provisionalBySession.set(pair.a, (provisionalBySession.get(pair.a) ?? 0) + 1);
					provisionalBySession.set(pair.b, (provisionalBySession.get(pair.b) ?? 0) + 1);
				}
				const lines = [];
				lines.push(`当前工作区：${cwd}${selfId !== undefined ? `（当前会话：${selfId}）` : ""}`);
				lines.push(`共 ${pool.length} 个其他会话${pool.length > shown.length ? `，按新到旧显示前 ${shown.length} 个` : ""}：`);
				lines.push("");
				if (shown.length === 0) lines.push("（无）");
				for (let index = 0; index < shown.length; index += 1) {
					const record = shown[index];
					const header = record.header;
					const agent = ctx.agents.get(header.id);
					const running = agent?.status === "running";
					const state = agentStateLabel(agent);
					const origin = header.origin === "subagent" ? " [子代理]" : "";
					const title = titles.get(header.id);
					const other = args.includeOtherProjects === true && header.cwd !== cwd ? ` · ${header.cwd}` : "";
					const provisionalCount = provisionalBySession.get(header.id) ?? 0;
					const provisionalNote = provisionalCount === 0 ? "" : ` · provisional 配对 ${provisionalCount} 条（换届临时信任：24h 内未批准自动回退，见 team_link_roster）`;
					lines.push(`- ${header.id}${origin} — ${state}${title !== undefined ? `「${title}」` : ""} · 创建于 ${new Date(header.createdAt).toLocaleString()}${other}${provisionalNote}（读数 ${readStamp(now)}，${READ_STALE_NOTE}）`);
					const topic = topics.get(header.id);
					if (topic !== undefined) lines.push(`    主题：${preview(topic, 90)}`);
					const activity = activities.get(header.id);
					if (activity !== undefined && activity !== topic) lines.push(`    最近：${preview(activity, 90)}`);
					// A row NOT in this call's read window labels itself unread: a verdict
					// built on a missing surface is a reading nobody took, and printing one
					// would hide the bound instead of declaring it (§3.1). Membership is
					// tested by ID, not by position — with `readIds` the read rows are
					// scattered, so "index < window length" would label exactly the wrong
					// rows unread (§4.1).
					if (!read.ids.has(header.id)) {
						lines.push(`    活性：${LV_WINDOW_NOTE}`);
					} else {
						const signal = buildLivenessSignal(ctx, header.id, { now, agent, surface: surfaces.get(header.id) });
						lines.push(`    活性：${livenessLine(signal)}`);
					}
				}
				lines.push("");
				// §4.1（可观测批 A）: the tail — the unread count and the two actionable
				// ways to read more. The ONLY format addition of this batch, and it is
				// carried by every call, the default one included (a hint, not payload).
				for (const tailLine of listReadTail(read, shown)) lines.push(tailLine);
				lines.push("");
				lines.push("提示：team_link_export 可导出任意会话（md+JSON）；team_link_send 可发送跨会话消息（需用户批准；接收确认时可选「配对」建立双向免确认通道；目标运行中→注入当前回合，空闲→唤醒为新回合）。");
				// This text goes straight into the caller's history, so it leaves
				// well-formed: preview() no longer CREATES a lone surrogate, and this
				// pass also repairs one that arrived inside an id, a title, a cwd or a
				// logged topic.
				return wellFormed(lines.join("\n"));
			} catch (error) {
				return wellFormed(`列出会话失败：${describeError(error)}`);
			}
		},
	})), "team-link: list tool");

	// §4.2（可观测批 A）只读团队状态卡：一次调用一屏。六个来源**全部是已有的只读面**
	// （settings 的 teams/watchdogs、agent 注册表、有界的有界读窗、tasks.md 尾部），
	// **零新信任面**：不写设置、不写磁盘、不加缓存、不新增持久状态（N3）。贵的那半边
	// （活性）照旧守 PREVIEW_SESSIONS 的预算，超出照旧如实标「未读」（N2）。
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_status",
		description: "只读**团队状态卡**（2026-09-26「台账 + 形态」设计 §4.2）：一次调用一屏讲清团队现状，**八段** —— ① 团队与角色（在位 / 空缺 / 版本史末条）② 换届 pending（在飞令牌：角色 / 继任者 / 到期时刻，**token 掩码**）③ 看门狗（谁盯谁 / 阈值 / 到期 ＋ 一行 **attach 后置链读数**：rearm 计数 · 段同步变化数 · 按队补挂四态 + 首因，见 FR-17）④ 会话面（id / 代理状态 / 创建时间 / provisional 标记；零日志成本）⑤ 活性（**有界**：与 team_link_list_sessions 同一顺序读前 12 行，超出该窗口的行如实标「未读」，不用空数据算 verdict）⑥ 台账尾（tasks.md 末尾 tasksTail 条，默认 5、上限 20，超出拒绝）⑦ **形态**（§4.3；六段由 A 批落地、第 ⑦ 段由 B 批追加：形态 + Lead + 成员名册投影（读不到时**如实标注**，不拒绝）+ **完整能力矩阵**（事实源 = 父档 §2.3）+ 那句「单会话兜底档」结论 + 形态诊断行（除自己外没有其他可达会话时只提示、绝不自动切档））⑧ **资源/预算**（批 3 追加：每会话一行 压力/窗口/累计/轮次 + 轮换标记（turns>100 或 tokens>2 亿，严格大于）+ 一句现成命令 team_link_rotate action=prepare successor:auto + 判读行（读数不可得 ⇒「读数不可得，不作判读」；可得 ⇒ 否定式结论，见 U7；**判读行末尾恒接一句范围界定**：本节只判上下文/预算，宿主工具闸门——如写入自动评审 429——属另一类、不在本节口径内，见 FR-14）；段体 ≤12 行；resources=false 时整段不出现；**纯读**，只读 sessionProjections）。**全只读**：调用前后 settings 与磁盘文件逐字节不变（不写、不缓存、不新增持久状态）；也不跑换届过期清扫（那会写）。team 省略 ⇒ 聚合本工作区全部团队（每团队一段）；给了但不存在 ⇒ 拒绝并列出已知团队名。调用方无会话身份时照常出卡，「当前会话」处如实标注（（当前会话未知）），**不编造身份**。末尾附 §4.2 的**反面预警注记**（窗口内 0 条消息 / 台账同期新增 M 行 ⇒ 会话可能已停止说话只写行——**读数，不是裁决**；零额外读：两个计数都取自本卡已读到的 surface 事件与台账行）。★ 可选 `action=forensics`（批 K）：读**崩溃现场**（本次启动 + 死亡窗口 + 死前四类读数（内存 / 磁盘 / 活会话 / 看门狗）+ 保留份数 + 免责句），**只读、零写入**；省略 action 即出上面那张团队状态卡（逐字不变）。",
		parameters: {
			team: { type: "string", description: "只看这一个团队（省略 ⇒ 聚合本工作区全部团队，每团队一段）；给了但不在注册表中 → 拒绝并列出已知团队名" },
			tasksTail: { type: "number", description: "台账显示最后几条（默认 5；上限 20，超出拒绝；有效区间 1..20）" },
			action: { type: "string", description: "可选动作。`forensics` = 读**崩溃现场**（批 K 的心跳留证：本次启动 + 死亡窗口 + 死前四类读数（内存/磁盘/活会话/看门狗）+ 保留份数 + 免责句）；**只读**、零写入；省略 ⇒ 出**团队状态卡**（八段），逐字不变；★ **空串视为省略**（`\"\"` 与「不传该参数」逐字同义 —— 很多壳里「没填」就是空串）；闭集外的取值**不静默生效**：如实拒绝并点名唯一支持的那一个值" },
		},
		output: textOutput(),
		timeoutMs: 30000,
		async execute(args, exec) {
			// ★ 批 K · FR-K4（设计档 §5 D7/§5 FR-K4）：**不加新工具**（工具数同改锁），让既有状态卡
			//   多一个可选动作。两条纪律：① 本动作**只读**（只读自家 forensics 下的心跳与目录列表，
			//   U6）；② **不带该参数时下面所有既有分支逐字未动** —— 这段是严格的早返回，不进任何
			//   既有读窗、不碰任何既有行（U7 的「逐字不变」就是这一句）。
			// ★ 判据 U15（交付评审 🔵#2）：空串的口径是 **「视为省略」**（下面的 `=== ""` 这一支），
			//   而这句话**逐字写在参数的 description 里**（`空串视为省略`）—— 判据同时咬住两侧
			//   （描述里有这句 ∧ 空串确实走省略支），改任一侧而不同改另一侧就红。
			//   为什么选「视为省略」而不是「也拒绝」：空串在多数壳里就是「没填」，按误用拒绝会打击
			//   一个**没有任何歧义**的输入；而闭集外的真值（如 "nope"）照旧不静默生效（下一行）。
			const action = args.action === undefined || args.action === null || args.action === "" ? null : String(args.action);
			if (action !== null && action !== "forensics") {
				return wellFormed(`${policy.placementLine()}\n状态卡读取失败：action 只支持 forensics（本批唯一新增动作），收到 ${JSON.stringify(action)}。省略 action 即出团队状态卡。`);
			}
			if (action === "forensics") {
				if (forensics === null) return wellFormed(`${policy.placementLine()}\n崩溃现场读取失败：心跳控制器缺席（本上下文没有建起它）。`);
				try {
					// 落点行仍是首行（R2 红线：这一家的每一次读都要说得出状态存在哪），紧随其后是现场读数。
					return wellFormed(`${policy.placementLine()}\n${await forensics.renderForensicsReport(Date.now())}`);
				} catch (error) {
					return wellFormed(`${policy.placementLine()}\n崩溃现场读取失败：${describeError(error)}`);
				}
			}
			try {
				const now = Date.now();
				const selfId = agentSessionId(exec);
				const cwd = agentCwd(exec);
				// ---- 参数读取在任何读之前：拒绝是零成本的，也是零读的 ----
				const wantedTeam = args.team === undefined || args.team === null || args.team === "" ? null : readTeamName(args.team);
				if (wantedTeam !== null && wantedTeam.error !== undefined) return wellFormed(`状态卡读取失败：${wantedTeam.error}`);
				const tail = readStatusTasksTail(args.tasksTail);
				if (tail.error !== undefined) return wellFormed(`状态卡读取失败：${tail.error}`);
				const view = policy.get();
				const teams = view.teams;
				if (wantedTeam !== null && !teams.some((entry) => entry.name === wantedTeam.value)) {
					// 首行仍是落点：连「读不到这个团队」这一支也要说得出状态存在哪（R2）。
					return wellFormed(`${policy.placementLine()}\n状态卡读取失败：团队 ${wantedTeam.value} 不在注册表中（已知团队：${teams.length === 0 ? "（无）" : teams.map((entry) => entry.name).join("、")}）。`);
				}
				const shownTeams = wantedTeam === null ? teams : teams.filter((entry) => entry.name === wantedTeam.value);

				// ---- 会话面 + 活性半边：与 list_sessions **同一顺序、同一个有界读窗** ----
				// ★ FR-13（批 5）: 读窗**优先按团队 workspace** 取（单队卡 / 所示团队同工作区）；宿主不支持
				// 按工作区取窗 ⇒ 就地过滤 + 段头如实标注。**绝不**把调用方工作区的会话当成该队会话（U23）。
				// ★ task-28: 「取不到团队 workspace」的两条到达路径（该队无 workspace 记录 / 聚合卡里工作区
				// 不止一个）**也**如实标注 —— 回退到调用方工作区是允许的，**静默**回退不是。口径文案由纯函数
				// {@link windowReadingFor} 一处渲染；这里的 teamScoped 决定段头说「该队工作区」还是「同工作区」。
				const windowWorkspace = windowWorkspaceFor(shownTeams);
				const scoped = await loadScopedSessionRecords(ctx, windowWorkspace);
				const records = scoped.records;
				const windowReading = windowReadingFor(shownTeams, cwd, { teamWorkspace: windowWorkspace, unsupported: scoped.unsupported });
				const targetWorkspace = windowReading.targetWorkspace;
				const windowNote = windowReading.note;
				const pool = records.filter((record) => record.header.cwd === targetWorkspace && record.header.id !== selfId);
				const shown = pool.slice(0, LIST_LIMIT);
				const readWindow = shown.slice(0, PREVIEW_SESSIONS);
				const windowIds = new Set(readWindow.map((record) => record.header.id));
				const settled = await Promise.allSettled(readWindow.map(async (record) => await ctx.sessionQuery.readSurface(record.header.id)));
				const surfaces = new Map();
				for (let index = 0; index < readWindow.length; index += 1) {
					const outcome = settled[index];
					if (outcome.status === "fulfilled") surfaces.set(readWindow[index].header.id, outcome.value);
				}
				const provisionalBySession = new Map();
				for (const pair of view.pairs) {
					if (pair.provisional !== true) continue;
					if (isExpiredProvisionalPair(pair, now)) continue;
					provisionalBySession.set(pair.a, (provisionalBySession.get(pair.a) ?? 0) + 1);
					provisionalBySession.set(pair.b, (provisionalBySession.get(pair.b) ?? 0) + 1);
				}

				// ---- 台账尾：每团队一次文件读；同一批行也喂给 §4.2 的注记（零额外读）----
				const ledgers = [];
				for (const team of shownTeams) {
					if (team.workspace === "") {
						ledgers.push({ team, rows: [], shownRows: [], error: "（无 workspace 记录：黑板根未知，台账不可读）" });
						continue;
					}
					const file = await readBlackboardFile(blackboardPaths(team).tasks);
					if (file.error !== undefined) {
						ledgers.push({ team, rows: [], shownRows: [], error: `（tasks.md 无法读取：${file.error}）` });
						continue;
					}
					const rows = blackboardLines(file.text);
					ledgers.push({ team, rows, shownRows: rows.slice(-tail.value), hash: blackboardHash(file.text), exists: file.exists });
				}

				// §3.5 R2 红线：可核落点是状态卡的**首行**。
				const lines = [policy.placementLine(), `团队状态卡（读数 ${readStamp(now)}，${READ_STALE_NOTE}）`];
				// FR-4（重钉点③）：**第 2 行**的角色重钉 —— 仅当调用方是某支所示团队的现任协调者
				// （U16 的另一半：首行仍是 placementLine，这一行紧随其后）。
				const reinforceTeam = shownTeams.find((team) => isIncumbentCoordinator(view, team.name, selfId));
				if (reinforceTeam !== undefined && view.sections.role !== false) lines.splice(1, 0, charterReinforceLine(reinforceTeam.name));
				lines.push(`当前工作区：${cwd}（${selfId ? `当前会话：${selfId}` : "当前会话未知"}）`);

				// --- ① 团队与角色（在位 / 空缺 / 版本史末条）---
				lines.push("", `--- 团队与角色（${wantedTeam === null ? `共 ${teams.length} 个团队` : wantedTeam.value}；来源：${policy.teamsSourceLabel()}）---`);
				for (const line of teamRoleLines(shownTeams)) lines.push(line);

				// --- ② 换届 pending（在飞令牌；掩码）---
				lines.push("", "--- 换届 pending（在飞令牌；token 一律掩码）---");
				for (const line of pendingLines(shownTeams)) lines.push(line);

				// --- ③ 看门狗 ---
				lines.push("", "--- 看门狗（policy.watchdogs；按观察者会话登记，与团队只是弱关联，故本节列出全部注册）---");
				for (const line of watchdogLines(ctx, view.watchdogs)) lines.push(line);
				// ★ FR-17（批 7）: 后置链读面 —— **一行**，纯读进程内存（不写盘、不写 settings）。
				// 真机两次排查都卡在「后置链做了什么完全不可见」上（本部署没有 logger 出口）。
				lines.push(chainReportLine(chainReport));

				// --- ④ 会话面（零日志成本的面）---
				// 段头的口径词按 **teamScoped** 取，不按「有没有标注」取：task-28 的两条回退支带了标注，
				// 但窗口是**调用方工作区** —— 让它跟着标注说成「该队工作区」就是把标注反过来用成谎话。
				lines.push("", `${windowNote}--- 会话面（${windowNote !== "" && windowReading.teamScoped ? "该队工作区" : "同工作区"}其他会话：id / 代理状态 / 创建时间 / provisional 标记；本条不读日志）---`);
				if (shown.length === 0) lines.push("（无）");
				for (const record of shown) {
					const header = record.header;
					const agent = ctx.agents.get(header.id);
					const state = agentStateLabel(agent);
					const provisional = provisionalBySession.get(header.id) ?? 0;
					lines.push(sessionFaceLine(header, state, provisional));
				}
				if (pool.length > shown.length) lines.push(`（共 ${pool.length} 个其他会话，按新到旧显示前 ${shown.length} 个）`);

				// --- ⑤ 活性（有界）---
				lines.push("", `${windowNote}--- 活性（有界：与 team_link_list_sessions 同一顺序读前 ${PREVIEW_SESSIONS} 行）---`);
				if (shown.length === 0) lines.push("（无）");
				for (const record of shown) {
					const id = record.header.id;
					if (!windowIds.has(id)) {
						lines.push(`- ${id}：${STATUS_LV_WINDOW_NOTE}`);
						continue;
					}
					const signal = buildLivenessSignal(ctx, id, { now, agent: ctx.agents.get(id), surface: surfaces.get(id) });
					lines.push(`- ${id}：${livenessLine(signal)}`);
				}

				// --- ⑥ 台账尾 ---
				lines.push("", `--- 台账尾（tasks.md 末 ${tail.value} 条；tasksTail 默认 ${STATUS_TASKS_TAIL_DEFAULT}、上限 ${STATUS_TASKS_TAIL_MAX}）---`);
				if (shownTeams.length === 0) lines.push("（无团队）");
				for (const ledger of ledgers) {
					if (ledger.error !== undefined) {
						lines.push(`- ${ledger.team.name}/tasks.md：${ledger.error}`);
						continue;
					}
					lines.push(`- ${ledger.team.name}/tasks.md：${ledger.exists ? `共 ${ledger.rows.length} 行，显示 ${ledger.shownRows.length} 条` : "（文件不存在，按空处理：0 行）"} · baseHash=${ledger.hash}（仅供参考/审计：tasks 只追加、不接受 baseHash 参数）`);
					// ★ 批 F · FR-4（显示面①）：行**按码点**截到 TASKS_TAIL_DISPLAY_CHARS —— 状态卡
					//   是要一屏的，写入上限提到 2000 之后一行能长到四倍。**只动显示**：盘上那行与
					//   `team_link_team_read` 的返回一字不动（U5 两半都钉住）。同一截断也用在
					//   客户端面板的 `tasksTail`（{@link buildPanelPayload}）—— 两处共用 {@link forDisplay}。
					for (const row of ledger.shownRows) lines.push(`    ${forDisplay(row)}`);
				}

				// --- ⑦ 形态（§4.3；本段由 B 批追加）---
				// 读面处置：宿主投影读不到 ⇒ 如实标注；形态 + Lead + 能力矩阵照给（红线 2 的读路径
				// 降级，与写路径的刺眼报错是两条路）。诊断行复用本卡**已经读到**的那份会话面
				//（pool 就是「同工作区、除自己以外」；没有会话身份时按 R5 传 null = 不判）——零额外读。
				const modeProjection = probeAgentTeams(ctx, exec?.agent);
				lines.push("", "--- 形态（⑦；本段由 B 批 §4.3 追加：形态 + Lead + 成员名册投影 + 能力矩阵 + 诊断行）---");
				// R5（收尾修复轮）: 诊断行的判据与 otherReachableSessions 收敛到同一条纪律 —— 调用方没有
				// 会话身份（selfId === undefined）时**不判**（传 null），而不是拿 pool 当结论：那种情况下
				// pool 是按一个猜出来的 cwd（process.cwd()）过滤出来的。④/⑤ 段的会话面照旧用 pool 显示。
				for (const modeLine of teamModeSectionLines(shownTeams, modeProjection, selfId === undefined ? null : pool.map((record) => record.header.id))) lines.push(modeLine);

				// --- ⑧ 资源/预算（§5 FR-5/FR-6；本段由批 3 追加）---
				// 零写盘（U13）：只读 sessionProjections（内存投影）与 policy；resources=false ⇒ 整段不出现。
				if (view.sections.resources !== false) {
					lines.push("");
					if (windowNote !== "") lines.push(`${windowNote}（第 ⑧ 段同一读窗）`);
					for (const line of budgetSectionLines(ctx, [selfId, ...shown.map((record) => record.header.id)])) lines.push(line);
				}

				// --- 反面预警注记（零额外读；判据写死在 reverseWarningNote 里）---
				const surfaceEvents = [...surfaces.values()].flatMap((surface) => Array.isArray(surface?.events) ? surface.events : []);
				const ledgerTimes = ledgers.flatMap((ledger) => ledger.rows.map(ledgerRowTime).filter((time) => time !== null));
				const note = reverseWarningNote(surfaceEvents, ledgerTimes);
				if (note.text !== null && (note.computed || readWindow.length > 0)) {
					lines.push("", "--- 反面预警注记 ---", note.text);
				}
				return wellFormed(lines.join("\n"));
			} catch (error) {
				return wellFormed(`状态卡读取失败：${describeError(error)}`);
			}
		},
	})), "team-link: status tool");

	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_export",
		description: "导出会话完整记录：markdown + JSON 双格式写入会话工作区 .dsh-exports/ 目录（JSON 含全量事件日志，md 为可读渲染）。",
		parameters: {
			sessionId: { type: "string", description: "要导出的会话 id；缺省为当前会话" },
			format: { type: "string", description: "导出格式：md / json / both（缺省 both）" },
			outputDir: { type: "string", description: "输出目录（缺省会话工作区的 .dsh-exports/）" },
		},
		output: textOutput(),
		timeoutMs: 60000,
		async execute(args, exec) {
			const sessionId = typeof args.sessionId === "string" && args.sessionId !== "" ? args.sessionId : agentSessionId(exec);
			if (sessionId === undefined) return "导出失败：未指定 sessionId，且当前上下文无法确定会话 id。";
			const format = ["md", "json", "both"].includes(args.format) ? args.format : "both";
			try {
				const result = await exportSession(ctx, sessionId, { format, outputDir: args.outputDir });
				return wellFormed(`已导出会话 ${sessionLabel(sessionId, result.title)}（${result.events.length} 个事件）：\n${result.files.map((file) => `- ${file}`).join("\n")}`);
			} catch (error) {
				return wellFormed(`导出失败：${describeError(error)}`);
			}
		},
	})), "team-link: export tool");

	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_send",
		description: "向一个或多个会话发送跨会话消息（多会话联调用）。寻址二选一：targetSessionId（单目标）或 targets（广播 fan-out，≤8 项）——每项可以是会话 id、team:<name>/<role> 或 team:<name>/*。team:<name>/* 全队广播只能由该团队现任协调者会话发起（策展理由见《调研》§5.3 论据 (a)），否则整次调用拒绝；team:<name>/<role> 任何会话都可点对点，角色当前空缺时返回 no-holder 结果（不算投递也不算失败）；团队不存在则整次调用拒绝。fan-out 逐目标照走完整投递路径（双门、配对快路径、屏蔽检查都不放宽），返回逐目标结果行与末行汇总；**只要有一个目标不是 delivered，返回文案的首行就是「❌ N 个目标未投递（M 个已投递）」**，之后才是逐目标结果行与汇总——全部投递成功时才维持原形状；重复目标去重后只投一次并在汇总注明。目标会话没有活动代理时（常见成因：目标 id 转录错位）拒绝文案以「❌ 未投递」开头，并列出当前同工作区其他存活会话（id + 运行中/空闲）与核对提示——它不是「已发送」，请对照列表确认 id 后再重发。可选 meta 信封 { type?: 'ruling'|'receipt'|'report'|'ask', pri?: 'P0'|'P1'|'P2', ref?: 不超过 16 字符 } 渲染进 banner 首行紧凑字段（只出现调用方给的键；source 仍恰好三成员，不扩字段），fan-out 时所有目标共享同一 meta。发送前需当前用户批准；目标运行中→消息在步边界注入其当前回合（steer，返回文案带该回合已运行的分钟数），空闲→唤醒目标作为新回合处理。已配对的两个会话互发免确认（接收确认时选「配对：双向免确认」即可建立）。",
		parameters: {
			targetSessionId: { type: "string", description: "目标会话 id（可用 team_link_list_sessions 查询）；与 targets 互斥" },
			targets: { type: "array", items: { type: "string" }, description: "广播 fan-out 的目标列表（最多 8 项）：会话 id、team:<name>/<role> 或 team:<name>/*（全队，仅该团队现任协调者会话）；与 targetSessionId 互斥" },
			message: { type: "string", required: true, description: "要投递的消息文本" },
			meta: { type: "json", description: "可选信封，渲染进 banner 首行（不扩 source）：{ type?: 'ruling'|'receipt'|'report'|'ask', pri?: 'P0'|'P1'|'P2', ref?: string }。只出现调用方给的键；ref 超过 16 字符按码点截断并在返回文案注明；枚举外的值与未定义字段一律拒绝（明确参数错误，不静默丢弃）" },
		},
		// §10.1.2: the model-visible text is unchanged (textOutput), plus the
		// structured receipt the browser half renders the sender-side card from.
		output: sendOutput(),
		async execute(args, exec) {
			// ★ 批 E（FR-3）：投递正文在**组装点**过一次消毒 —— 这是本插件**唯一**把调用方正文交给
			// 别人的地方：它随 banner 落进**目标**会话的日志（`deliverToTarget`），也随实参进
			// `sendCardMessage`（卡片文本）。一处收口，两条通路同时干净；`wellFormed*` 本身幂等，
			// 所以下游再遇到它也不会二次编号。无替换 ⇒ 逐字节原样（`removed === 0`），下面每条
			// 既有路径的字节都不变。
			const text = sanitizeFraming(args.message).text;
			const sender = exec?.agent;
			if (sender === undefined || ctx.agents.get(sender.id) !== sender) {
				return "发送失败：跨会话发送需要用户批准，但当前执行上下文没有可交互的活动代理。";
			}
			const meta = readMeta(args.meta);
			if (meta.error !== undefined) return wellFormed(`发送失败：${meta.error}`);
			const wantsTargets = args.targets !== undefined && args.targets !== null;
			const hasTarget = args.targetSessionId !== undefined && args.targetSessionId !== null;
			if (wantsTargets && hasTarget) {
				return "发送失败：targets（广播 fan-out）与 targetSessionId（单目标）互斥——一次调用只能用一种寻址方式。";
			}
			if (!wantsTargets && !hasTarget) {
				return "发送失败：需要 targetSessionId（单目标，沿用原有语义）或 targets（fan-out 广播，最多 8 个目标）之一。";
			}
			if (!wantsTargets) {
				// ---- single target: the legacy path, untouched ---------------------
				const outcome = await deliverToTarget(ctx, policy, sender, exec, args.targetSessionId, text, meta.value);
				// §10.1.2: the receipt is stashed for THIS call (keyed by the frozen
				// args object the registry reuses for the projection) before returning,
				// so the text stays exactly what it was and the card is derived, not
				// parsed back out of it.
				SEND_CARD_BY_ARGS.set(args, buildSendCard({
					at: Date.now(),
					senderSessionId: sender.id,
					meta: meta.value,
					message: sendCardMessage(text),
					targets: [{ sessionId: args.targetSessionId, outcome: outcome.outcome, detail: outcome.text, busy: outcome.busy }],
					deduped: 0,
					fanout: false,
				}));
				return wellFormed(withMetaNotes(outcome.text, meta.notes));
			}
			// ---- §3.4 fan-out: resolve everything first, then deliver per target -
			const resolved = resolveTargetList(Array.isArray(args.targets) ? args.targets : [], policy.get().teams, sender.id, {
				isLive: (sessionId) => ctx.agents.get(sessionId) !== undefined,
			});
			if (resolved.error !== undefined) return wellFormed(`发送失败：${resolved.error}`);
			const report = await fanout(ctx, policy, sender, exec, { rows: resolved.rows, duplicates: resolved.duplicates, meta: meta.value, payload: text });
			for (const note of meta.notes) report.lines.push(`注意：${note}`);
			SEND_CARD_BY_ARGS.set(args, buildSendCard({
				at: Date.now(),
				senderSessionId: sender.id,
				meta: meta.value,
				message: sendCardMessage(text),
				targets: report.results.map((entry) => ({
					sessionId: entry.sessionId,
					expr: entry.expr,
					outcome: entry.outcome,
					detail: entry.text,
					busy: entry.busy,
				})),
				deduped: resolved.duplicates,
				fanout: true,
			}));
			return wellFormed(report.lines.join("\n"));
		},
	})), "team-link: send tool");

	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_watch",
		description: "跨会话看门狗（M1）：给自己注册盯人 —— 被盯会话出现失联征兆（verdict 为 silent-idle / goal-disarmed / dead）且你自己空闲且未处于 armed-active 节奏时，本插件向你自己的会话投递一条固定文案的 tick（你需自己判断是否催办/转派）。action：register（注册，只能给自己注册，targets 不能含自己）/ list（查看注册）/ clear（幂等；**只清你自己手工注册的那些** —— `origin:auto` 那一条是**全队工作台**的资产，点名它会被拒绝、不带 id 时它原样留着并如实报出还有几条未清除）/ **arm-team**（补挂自己队的工作台注册：**现任协调者**一条命令幂等补挂 —— 复用建队那条 ensure 逻辑，**缺失才写**，第二次调用不新增；参数 team 省略 ⇒ 你任现任协调者的那些队，给了 ⇒ 必须是该队的**现任协调者**；**非现任 / coordinator 空缺 / 队不在名册一律拒绝并点名原因**；补挂出来的是 origin=auto 那条，所以**不占这 3 条手工额度**）。注册上限 3 个/会话（只数手工注册）；silentMinutes>=10、intervalMinutes>=5（默认 5）、TTL<=24h（默认 12h），到点自动清理。★ auto 那一档（`/team_session` 建队成功时自动注册的一条，origin=auto、team=团队名、targets=全队成员）**不占这 3 条额度**，并且额外投「工作台摘要」（谁在跑 / 谁空闲待派 / 谁刚干完 / 谁需处置）：摘要在你 running / armed-active 时**照投**（告警类 tick 的抑制原样不变），同一注册两条至少隔 10min，且只在有可行动内容时投（无事不打扰）。★ 这条自动注册另投两条**独立通道**（批 J，与摘要互不抑制）：**`[idle-unassigned]` 有活没派**（空闲待派非空 ∧ 无人在跑 ⇒ 点名「没有成员在被派活」；每段至多 3 次）与 **`[pressure-warn]` 自身压力告警**（你是该队现任协调者且你自己的上下文压力 ≥ 50% 时投，跨档上升沿才再投）。要看某位成员在干什么 ⇒ 读那个团队的黑板 `tasks.md`（`team_link_team_read`），**不要读它的会话历史**。attach 时本插件会按名册为每个队自动补挂一次（FR-10），所以建队早于本功能的**老团队**也吃得到摘要；arm-team 是那条自动路径的**显式入口**（幂等，可安全重发）。 ★ 批 U（2026-10-23 用户反馈）：register 之后可用 **update**（按 id 就地改 silentMinutes / intervalMinutes / ttlHours / wake，不必清掉重登记）· **mute** / **unmute**（临时静音投递；auto 那一档也可由观察者自己按暂停键，默认 12h、上限 24h；注册与续期不动）。`wake:false`（或观察者上一次 tick 之后没有 assistant 回复）时投递改走 inject —— 只进收件箱、不唤醒新回合，避免把已经在错误循环里的会话每拍再拉起一次。",
		parameters: {
			action: { type: "string", required: true, enum: ["register", "update", "mute", "unmute", "list", "clear", "arm-team"], description: "register / update / mute / unmute / list / clear / arm-team" },
			team: { type: "string", description: "arm-team：要补挂的团队名（缺省 = 你任现任协调者的那些队）。给了但不在名册 / 你不是该队现任协调者 ⇒ 拒绝并点名原因" },
			targets: { type: "array", items: { type: "string" }, description: "register：被盯会话 id 列表（不能包含自己）" },
			silentMinutes: { type: "integer", description: "register / update：失联阈值（分钟，>=10，默认 10）" },
			intervalMinutes: { type: "integer", description: "register / update：巡检间隔（分钟，>=5，默认 5）" },
			ttlHours: { type: "number", description: "register / update：有效期（小时，<=24，默认 12；update 从**现在**起算续租）" },
			wake: { type: "boolean", description: "register / update：true=投递并唤醒新回合（默认）；false=只投递不唤醒（inject，进收件箱等下个回合）" },
			hours: { type: "number", description: "mute：静音多久（小时，默认 12，上限 24）；unmute 不需要" },
			id: { type: "string", description: "update / mute / unmute：要操作的注册 id（必填；先 list 查）· clear：要清除的注册 id（缺省 = 清掉你**手工**注册的那些）。★ 全队工作台的自动注册（origin=auto）**清不掉**（clear 会拒绝）；要停它的投递请用 mute（观察者本人即可，默认 12h / 上限 24h）" },
		},
		output: textOutput(),
		timeoutMs: 30000,
		async execute(args, exec) {
			const caller = agentSessionId(exec);
			if (caller === undefined || ctx.agents.get(caller) !== exec?.agent) {
				return "操作失败：看门狗注册需要可交互的活动代理（exec.agent.id）——看门狗只能给自己注册。";
			}
			const action = typeof args.action === "string" ? args.action : "";
			const now = Date.now();
			const current = policy.get().watchdogs;
			const own = current.filter((entry) => entry.watcherSession === caller);
			// FR-3a（批 1）: 额度只数**手工**注册 —— auto 那一条（/team_session 建队时自动挂的
			// 工作台）不占额度，否则「自动注册」会把用户的手工额度吃掉一条（U11）。
			const ownManual = own.filter((entry) => entry.origin !== WATCHDOG_ORIGIN_AUTO);

			if (action === "register") {
				if (ownManual.length >= WATCHDOG_MAX_PER_SESSION) {
					return wellFormed(`注册失败：单个会话最多 ${WATCHDOG_MAX_PER_SESSION} 个看门狗注册（当前 ${ownManual.length} 个手工注册，auto 注册不占额度）。先用 team_link_watch clear 清理不再需要的**手工**注册（全队工作台的自动注册不占这里的额度，也清不掉）。`);
				}
				const built = buildWatchdogRegistration({
					caller,
					now,
					targets: args.targets,
					silentMinutes: args.silentMinutes,
					intervalMinutes: args.intervalMinutes,
					ttlHours: args.ttlHours,
					wake: args.wake,
				});
				if (built.error !== undefined) return wellFormed(`注册失败：${built.error}`);
				const entry = built.value;
				try {
					await policy.update({ watchdogs: [...current, entry] });
				} catch (error) {
					return wellFormed(`注册失败：写入设置失败（${describeError(error)}）。`);
				}
				watchdog.schedule(entry);
				return wellFormed([
					`已注册看门狗 ${entry.id}：观察者 ${caller} 盯 ${entry.targets.join(", ")}。`,
					`阈值：静默 ${entry.silentMinutes}min · 巡检 ${entry.intervalMinutes}min · TTL ${((entry.expiresAt - now) / 3600000).toFixed(2)}h（到期 ${readStamp(entry.expiresAt)}）。`,
					"观察者空闲且目标出现 silent-idle / goal-disarmed / dead 时，插件会向你自己的会话投递 tick（同一目标一个静默期最多一次；TTL 到点自动清理）。",
				].join("\n"));
			}

			if (action === "list") {
				const lines = [`看门狗注册（共 ${current.length} 个，其中自己 ${own.length} 个）：`];
				if (current.length === 0) lines.push("（无）");
				for (const entry of current) {
					const watcherAgent = ctx.agents.get(entry.watcherSession);
					const watcherState = watcherAgent === undefined ? "未运行" : watcherAgent.status === "running" ? "运行中" : "空闲";
					// ★ 批 G（FR-R5 的「读面文案同批改准」）：那一格的寿命口径按**来源**分岔 —— auto 那一档
					// 从批 G 起随名册续期（「名册有效期内」），手工那一档仍是用户自定的 TTL（本批**不**给
					// manual 续期）。文案不改的话，auto 行会读到一句与行为相反的话。
					const dead = watchdog.deadWatchers.has(entry.id)
						? (entry.origin === WATCHDOG_ORIGIN_AUTO
							? " · 观察者=dead（代理不存在，等待用户；注册随名册续期，名册失效时由 TTL 收尸）"
							: " · 观察者=dead（代理不存在，等待用户；注册保留至 TTL）")
						: "";
					// FR-3a: 来源分两档，读数里说清楚（auto 那一条不占手工额度、且会投工作台摘要）。
					const origin = entry.origin === WATCHDOG_ORIGIN_AUTO ? "auto（建队时自动注册，不占手工额度，投工作台摘要）" : "manual";
					lines.push(`- ${entry.id}${entry.watcherSession === caller ? " [自己]" : ""} — 观察者 ${entry.watcherSession}（${watcherState}${dead}）`);
					lines.push(`    目标：${entry.targets.length === 0 ? "（无）" : entry.targets.join(", ")}`);
					// ★ 批 G · FR-R4（交付修复轮）：那一格与状态卡第 ③ 段是**同一次调用** ——
					// 两者共用 `watchdogRenewField` 这一份字节（设计档 §5 FR-R4 明文要求
					// `renewedAt` 在 `watch list` **与**状态卡看门狗段**两处**都渲染）。
					// 交付修复轮之前本行漏了这一格：状态卡说「上次续期 …」而 list 一个字都不提。
					// ★ 批 U: 静音与「不唤醒」都是注册上的有效状态，list 必须如实显示（否则读面比行为窄）。
					const muted = typeof entry.mutedUntil === "number" && entry.mutedUntil > now ? ` · 已静音至 ${readStamp(entry.mutedUntil)}` : "";
					const wakeNote = entry.wake === false ? " · 投递不唤醒（inject）" : "";
					lines.push(`    阈值：静默 ${entry.silentMinutes}min · 巡检 ${entry.intervalMinutes}min · 到期 ${readStamp(entry.expiresAt)}${watchdogRenewField(entry)} · 团队 ${entry.team ?? "—"} · 来源 ${origin}${muted}${wakeNote}`);
				}
				lines.push("", `（读数 ${readStamp(now)}，${READ_STALE_NOTE}）`);
				return wellFormed(lines.join("\n"));
			}

			if (action === "clear") {
				// ★ 批 D（FR-2 §6.5）: **只清手工**。auto 那一条是**全队工作台**的资产，不是调用方的
				// 私人订阅 —— 一句普通命令拿不走它（D-2 真机读数：23:32:55 协调者 `clear`（无 id）⇒
				// 23:46:48 写盘时 `policy.watchdogs` 8 → 7、被删那条 expiresAt **还没到**；同一个坑
				// 17:43 建的那条 22:47 前已经没了）。自动化消失只剩 TTL 到期与团队解散两条路（§9）。
				const ownAuto = own.filter((entry) => entry.origin === WATCHDOG_ORIGIN_AUTO);
				const wanted = typeof args.id === "string" && args.id !== "" ? args.id : undefined;
				if (wanted !== undefined && ownAuto.some((entry) => entry.id === wanted)) {
					// ★ 分歧修复轮（设计档 §6.5 v1.1）：回执必须含「该注册未清除」—— §8 的 U6 判据要求它，
					// 而伪代码原文漏了这三个字 ⇒ 判据与规格打架、交付态两条红（两条断言同源）。
					return wellFormed(`清除失败：${wanted} 是**全队工作台**的自动注册（不是你的私人订阅）—— 它随团队存在，只能靠 TTL 到期或团队解散消失；**该注册未清除**。可清除的是你自己手工注册的那些（当前 ${ownManual.length} 个）。★ 要临时停它的投递请用 mute（观察者本人即可，默认 12h / 上限 24h；注册与续期不动）。`);
				}
				const removable = wanted === undefined ? ownManual : ownManual.filter((entry) => entry.id === wanted);
				if (wanted !== undefined && removable.length === 0) {
					if (current.some((entry) => entry.id === wanted)) {
						return wellFormed(`清除失败：注册 ${wanted} 的观察者不是当前会话，只能清除自己的注册。`);
					}
					return wellFormed(`已清理 0 个注册（${wanted} 不存在或已清除；clear 幂等）。`);
				}
				try {
					await policy.update({ watchdogs: current.filter((entry) => !removable.includes(entry)) });
				} catch (error) {
					return wellFormed(`清除失败：写入设置失败（${describeError(error)}）。`);
				}
				for (const entry of removable) watchdog.cancel(entry.id);
				// 清掉了别人的东西却不说，与 D-2 的教训同族 ⇒ 有 auto 在场时如实点一句「未清除」。
				const autoNote = ownAuto.length > 0
					? `（另有 ${ownAuto.length} 个自动注册属于全队工作台，未清除。）`
					: "";
				return wellFormed(wanted === undefined
					? `已清理自己的手工看门狗注册（${removable.length} 个）。${autoNote}`
					: `已清理看门狗注册 ${wanted}。${autoNote}`);
			}

			// ★ 批 U（2026-10-23 用户反馈）: 就地调整 / 静音 / 恢复 —— 三条运维口令。
			if (action === "update") {
				const wanted = typeof args.id === "string" && args.id !== "" ? args.id : undefined;
				if (wanted === undefined) return wellFormed("更新失败：需要 id（要调整的注册 id；先 team_link_watch action=list 查）。");
				const target = current.find((entry) => entry.id === wanted);
				if (target === undefined) return wellFormed(`更新失败：注册 ${wanted} 不存在（update 不猜、也不新建；register 才是新建）。`);
				if (target.watcherSession !== caller) return wellFormed(`更新失败：注册 ${wanted} 的观察者不是当前会话（${target.watcherSession}），只能调整自己的注册。`);
				const patched = buildWatchdogUpdate(target, { now, silentMinutes: args.silentMinutes, intervalMinutes: args.intervalMinutes, ttlHours: args.ttlHours, wake: args.wake });
				if (patched.error !== undefined) return wellFormed(`更新失败：${patched.error}`);
				try {
					await policy.update({ watchdogs: current.map((entry) => (entry.id === wanted ? patched.value : entry)) });
				} catch (error) {
					return wellFormed(`更新失败：写入设置失败（${describeError(error)}）。`);
				}
				watchdog.schedule(patched.value);
				return wellFormed([
					`已更新看门狗 ${wanted}：观察者 ${caller} 盯 ${patched.value.targets.join(", ")}。`,
					`阈值：静默 ${patched.value.silentMinutes}min · 巡检 ${patched.value.intervalMinutes}min · 到期 ${readStamp(patched.value.expiresAt)}${watchdogRenewField(patched.value)}。`,
					"（定时器已按新间隔重挂；未给的字段保持原值。）",
				].join("\n"));
			}

			if (action === "mute" || action === "unmute") {
				const wanted = typeof args.id === "string" && args.id !== "" ? args.id : undefined;
				if (wanted === undefined) return wellFormed(`${action === "mute" ? "静音" : "恢复"}失败：需要 id（先 team_link_watch action=list 查）。`);
				const target = current.find((entry) => entry.id === wanted);
				if (target === undefined) return wellFormed(`${action === "mute" ? "静音" : "恢复"}失败：注册 ${wanted} 不存在（先 list 查）。`);
				if (target.watcherSession !== caller) return wellFormed(`${action === "mute" ? "静音" : "恢复"}失败：注册 ${wanted} 的观察者不是当前会话（${target.watcherSession}），只能操作自己的注册。`);
				let next;
				let hours = 0;
				if (action === "mute") {
					const muted = buildWatchdogMute(target, { now, hours: args.hours });
					if (muted.error !== undefined) return wellFormed(`静音失败：${muted.error}`);
					next = muted.value;
					hours = muted.hours;
				} else {
					next = { ...target };
					delete next.mutedUntil;
				}
				try {
					await policy.update({ watchdogs: current.map((entry) => (entry.id === wanted ? next : entry)) });
				} catch (error) {
					return wellFormed(`${action === "mute" ? "静音" : "恢复"}失败：写入设置失败（${describeError(error)}）。`);
				}
				return wellFormed(action === "mute"
					? `已静音看门狗 ${wanted} 至 ${readStamp(next.mutedUntil)}（${hours}h）：这段时间不再向 ${caller} 投递 tick / 工作台摘要 / 告警；注册、续期与 TTL 不变，unmute 随时恢复。`
					: `已恢复看门狗 ${wanted} 的投递（mutedUntil 已清除；注册与阈值一字未动）。`);
			}

			// ★ FR-12（批 5）: 现任协调者一条命令**幂等补挂自己队**的工作台注册 —— 复用 FR-10 的
			// ensure 逻辑（同一个 ensureTeamAutoWatchdogs + 同一份 options 形状），**不另写一份**。
			// 判据 U22：现任可用且幂等（第二次不新增）；非现任 / 队不在名册 ⇒ 拒绝并点名原因。
			// writer gate 语义沿用：观察者**必须**是该队现任协调者（auto 注册的 watcher 就是现任），
			// 所以门就是「现任才放行」；coordinator 空缺时按 writerGate 同一条纪律拒绝（指路设置 UI）。
			if (action === "arm-team") {
				const wantedTeam = typeof args.team === "string" && args.team.trim() !== "" ? args.team.trim() : undefined;
				const teams = policy.get().teams;
				const incumbentOf = (team) => roleOf(team, COORDINATOR_ROLE)?.current ?? null;
				let subject;
				if (wantedTeam !== undefined) {
					const team = teams.find((entry) => entry.name === wantedTeam);
					if (team === undefined) {
						return wellFormed(`补挂失败：团队「${wantedTeam}」不在名册中（已知团队：${teams.length === 0 ? "（无）" : teams.map((entry) => entry.name).join("、")}）——先用 team_link_roster action=upsert-team 建队。`);
					}
					const incumbent = incumbentOf(team);
					if (incumbent === null) {
						return wellFormed(`补挂失败：团队 ${team.name} 的 coordinator 角色当前空缺（current=null），没有「现任协调者会话」可以当观察者 —— writer gate 语义沿用（现任空缺时会话路径一律拒绝），请由用户经设置 UI 指定现任后重发。`);
					}
					if (incumbent !== caller) {
						// 「非现任 ⇒ 拒绝」是无条件的（设计档 FR-12 行原文），比 writerGate 紧一档：auto 注册的
						// watcher 就是现任协调者，非现任补挂等于替别人挂表 —— 所以即便 policy.writer=any 也只受理
						// 现任。两档各说各的话，别让 writer=any 的队读到一句与它不符的拒绝理由。
						const gateNote = team.policy.writer === "any"
							? "本命令比 writerGate 紧一档：auto 注册的观察者就是该队现任协调者，所以即便 policy.writer=any 也只受理现任（非现任补挂等于替别人挂表）。"
							: "writer gate 语义沿用：policy.writer=coordinator 时非现任拒写。";
						return wellFormed(`补挂失败：只有团队 ${team.name} 的现任协调者会话 ${incumbent} 可以补挂它自己的工作台注册（当前调用会话 ${caller}）——${gateNote}`);
					}
					subject = [team];
				} else {
					subject = teams.filter((team) => incumbentOf(team) === caller);
					if (subject.length === 0) {
						const known = teams.map((team) => `${team.name}（现任协调者 ${incumbentOf(team) ?? "空缺"}）`);
						return wellFormed(`补挂失败：当前会话 ${caller} 不是名册里任何团队的现任协调者 —— 只有现任协调者能补挂自己队的工作台注册（名册：${known.length === 0 ? "（无团队）" : known.join("、")}）。`);
					}
				}
				let reports;
				try {
					reports = await ensureTeamAutoWatchdogs(ctx, policy, watchdog, { teams: subject });
				} catch (error) {
					return wellFormed(`补挂失败：${describeError(error)}（fail-open：注册表未被本次调用改动；下一次 attach 或巡逻会再试）。`);
				}
				const rows = new Map(policy.get().watchdogs.map((entry) => [entry.id, entry]));
				const lines = [`补挂结果（${subject.length} 个队）：`];
				for (const report of reports) {
					const row = report.id === undefined ? undefined : rows.get(report.id);
					if (report.state === "created") lines.push(`- ${report.team}：已补挂工作台注册 ${report.id}（观察者 ${caller} → 目标 ${row === undefined ? "（刚落的那一条读不到）" : row.targets.join(", ")}；幂等：重复调用不会新增）。`);
					else if (report.state === "present") lines.push(`- ${report.team}：已有工作台注册 ${report.id}（幂等：本次未新增）。`);
					// task-31: skip 与 failed 分开说 —— 「未补挂」（这队本来就没得挂）与「补挂失败」
					// （写入失败 / 定时器未挂上）是两件事，命令面与状态卡那一行同一条口径。
					else if (report.state === "failed") lines.push(`- ${report.team}：补挂失败 —— ${report.reason}（fail-open：本次命令不受影响；下一次 attach 或巡逻会再试）。`);
					else lines.push(`- ${report.team}：未补挂 —— ${report.reason}（fail-open：本次命令不受影响；下一次 attach 或巡逻会再试）。`);
				}
				lines.push("来源 auto（不占手工额度）：watch list 里那一行显示「来源 auto」，摘要按工作台口径推给你（running / armed-active 时照投）。");
				return wellFormed(lines.join("\n"));
			}

			return "操作失败：action 必须是 register / update / mute / unmute / list / clear / arm-team。";
		},
	})), "team-link: watch tool");

	// ★ 批 I · FR-I4: 屏蔽的作用域管理（`list` / `unblock` / `clear-legacy`）。
	// 与 `team_link_watch` 同级的注册点、同一条 `ctx.effect` 形制。**零新 import** 由这个
	// 工具面自己守住：它只用本文件已有的 `wellFormed` / `agentSessionId` / `policy` 与 §6 的
	// 三个写路径（`blockSender` 是投递路径在用，这里只读/解/清）。
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_block",
		description: "跨会话屏蔽的作用域管理（批 I）。屏蔽是**两个会话之间的一对**（双向）：A↔B 之后 A→B 与 B→A 都拒，**不影响**它们与别的会话的正常往来；解除之后立刻恢复。action=**list**（看当前屏蔽：配对屏蔽与旧格式**分两组**呈现，各带可执行的出口）· action=**unblock**（解一对，参数 a / b = 这一对的两个会话 id；**只有发起屏蔽的那一方（条目的 `by`）能解** —— 被屏蔽的一方与第三方调用一律拒绝且零写入，拒绝文案列出当前全部屏蔽）· action=**clear-legacy sender=<id>**（按发送方**逐条**清一条**旧格式**屏蔽记录：旧的 blockedSenders 是**部署级全局名单**、范围偏大，挡的是该发送方对**所有**会话的投递；**被该条目挡住的发送方本人不得清自己的条目**（本人清 ⇒ 拒绝且零写入），其余任何会话可清；**不做批量清**）。解除动作不弹确认框（一次只解一条、随时可再屏蔽回去）。",
		parameters: {
			action: { type: "string", required: true, enum: ["list", "unblock", "clear-legacy"], description: "list（看当前屏蔽，配对与旧格式分组）/ unblock（解一对）/ clear-legacy（按发送方逐条清一条旧格式记录）" },
			a: { type: "string", description: "unblock：这一对里的一个会话 id（与 b 合起来是**两个不同的**会话；顺序不限，写入时按字典序规范化）" },
			b: { type: "string", description: "unblock：这一对里的另一个会话 id" },
			sender: { type: "string", description: "clear-legacy：要清掉的那条**旧格式**记录的发送方会话 id（就是被它挡住的那一方；本人不得清自己的条目）" },
		},
		output: textOutput(),
		timeoutMs: 30000,
		async execute(args, exec) {
			const action = typeof args.action === "string" ? args.action : "";
			// `list` 是纯读：不需要调用方身份（与 `team_link_status` 同类），也**不写**。
			if (action === "list") return wellFormed(blockListLines(policy.get()).join("\n"));

			// 解与清都要判**权限**，而权限判据只有一条：调用方自己的会话 id（D7/D8）。
			// 拿不到身份 ⇒ fail-closed 拒绝（不猜、不替别的会话做权限判定）。
			const caller = agentSessionId(exec);
			if (caller === undefined) {
				return wellFormed("操作失败：屏蔽的作用域管理需要当前会话 id（exec.agent.id）来判定权限（D7/D8），本上下文拿不到 —— 拒绝执行，零写入。");
			}

			if (action === "unblock") {
				const a = typeof args.a === "string" ? args.a.trim() : "";
				const b = typeof args.b === "string" ? args.b.trim() : "";
				if (a === "" || b === "") return wellFormed("解除失败：需要 a 与 b 两个会话 id（这一对的两个端点）——不做任何写入。");
				if (a === b) return wellFormed(`解除失败：a 与 b 是同一个会话（${a}）——屏蔽是「两个不同会话之间的一对」，自己屏蔽自己不成立，也没有这样的一条可以解。未做任何写入。`);
				let outcome;
				try {
					outcome = await unblockPair(policy, caller, a, b);
				} catch (error) {
					return wellFormed(`解除失败：写入设置失败（${describeError(error)}）——原屏蔽仍在（绝不出现「报成功但没解开」）。`);
				}
				if (outcome.ok) {
					const entry = outcome.entry;
					return wellFormed([
						`已解除配对屏蔽：${entry.a} ↔ ${entry.b}（由 ${entry.by} 发起）。`,
						`这一对**双向**恢复：${entry.a} → ${entry.b} 与 ${entry.b} → ${entry.a} 都不再被这条屏蔽拦下（别的对与旧格式名单不受影响，现余配对屏蔽 ${outcome.remaining.length} 条）。`,
					].join("\n"));
				}
				if (outcome.reason === "absent") {
					return wellFormed([
						`解除失败：${blockPair(a, b).a} ↔ ${blockPair(a, b).b} 之间没有配对屏蔽（不是静默成功——本次**零写入**）。`,
						...blockListLines(policy.get()),
					].join("\n"));
				}
				const entry = outcome.entry;
				const isEnd = caller === entry.a || caller === entry.b;
				return wellFormed([
					`解除失败：这一对（${entry.a} ↔ ${entry.b}）是由 ${entry.by} 发起的屏蔽，**只有发起屏蔽的一方可以解除**（当前调用会话 ${caller}${isEnd ? "是被屏蔽的一方" : "既不是这一对的两个端点之一"}——本次**零写入**，屏蔽仍在）。`,
					`要解除请由 ${entry.by} 调用 team_link_block action=unblock a=${entry.a} b=${entry.b}；若那一方已不存在，只能人工改 policy.json 的 blocks 条目后重启（AGENTS.md §七 的既有路径）。`,
					...blockListLines(policy.get()),
				].join("\n"));
			}

			if (action === "clear-legacy") {
				const sender = typeof args.sender === "string" ? args.sender.trim() : "";
				if (sender === "") return wellFormed("清除失败：需要 sender（要清掉的那条旧格式记录的发送方会话 id）——不做任何写入。");
				let outcome;
				try {
					outcome = await clearLegacy(policy, caller, sender);
				} catch (error) {
					return wellFormed(`清除失败：写入设置失败（${describeError(error)}）——原记录仍在。`);
				}
				if (outcome.ok) {
					return wellFormed([
						`已清除 1 条旧格式屏蔽：${sender}（它不是自己清的——受益方不能自己动手）。`,
						`该发送方对**所有**会话的投递从此不再被这条旧记录拦下；其余旧记录与其它所有键逐字节未动（现余旧格式记录 ${outcome.remaining.length} 条${outcome.remaining.length === 0 ? "" : `：${outcome.remaining.join("、")}`}）。`,
						"注意：这只是清掉**旧格式**那一条；那个发送方与某个会话之间若另有**配对屏蔽**，那条仍然有效（用 team_link_block action=list 看当前屏蔽）。",
					].join("\n"));
				}
				if (outcome.reason === "beneficiary") {
					return wellFormed([
						`清除失败：${sender} 正是这条旧格式记录**挡住的发送方本人** —— 受益方不能自己动手清掉自己的条目（旧条目没有 by 字段，所以这里沿用 D7 的底线：谁被挡，谁不能解）。未做任何写入。`,
						`请由**别的**会话调用 team_link_block action=clear-legacy sender=${sender}（其余任何会话都可清）。`,
						...blockListLines(policy.get()),
					].join("\n"));
				}
				return wellFormed([
					`清除失败：旧格式名单里没有 ${sender}（不是静默成功——本次**零写入**）。`,
					...blockListLines(policy.get()),
				].join("\n"));
			}

			return "操作失败：action 必须是 list / unblock / clear-legacy。";
		},
	})), "team-link: block tool");
}

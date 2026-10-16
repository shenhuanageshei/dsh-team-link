// ---------------------------------------------------------------------------
// 域档：段渲染与预算 —— 批 R（上架合规）从 `lib/index.js` 原样搬出
// ---------------------------------------------------------------------------
// 归属：docs/2026-10-15-store-compliance-design.md §4 D1/D2/D4 · §5 FR-R1 · §6（拆分契约：
//       模块间只走相对导入、无环、搬运零行为变更）· §8 Rr1/Rr3/Rr4。
// 本域两半各自的**权威设计档**（逐个点名，便于回查）：
//   · 段渲染（角色/宪章段 + 资源行）—— docs/2026-10-09-team-autonomy-design.md §5 FR-1/FR-2 ·
//     §6（registerRoleSection / renderRoleAndResources / renderResourceLine）· §7.2/§7.4 · §8 U1–U6；
//     批 C 的落点拆分（段只产会话期内恒定的文本、资源行改挂动态运行时上下文通道）见
//     docs/2026-10-10-prompt-cache-design.md §5 FR-1…FR-4 · §6（§6.1–§6.4）；批 D 的回合门见
//     docs/2026-10-10-registration-lifecycle-design.md §4.3 · §5 FR-3 · §6；批 E 的消毒面见
//     docs/2026-10-11-token-sanitize-design.md §5 FR-4（本域三个渲染出口都是模型可见文本）。
//   · 预算（状态卡第 ⑧ 段「资源/预算」+ 判读行 + 轮换标记）—— docs/2026-10-09-team-autonomy-design.md
//     §5 FR-5/FR-6 · §8 U7/U8/§9；FR-14 的范围界定句与批 7 的留位算式同档。
//
// ★ 域边界（本小单划定的口径，逐条可核）：本档承载「**段文本 / 资源读数 / 第 ⑧ 段预算**」这一族的
//   纯渲染体与其常量。**不含**四样（各属别的域；边界依据是它们的调用面，不是口味）：
//     ① `createSections`（段的注册器与生命周期：注册表 / sync / 五道一次性 warn 门）—— 属
//        「工具注册与生命周期」域；它从本档导入渲染体与注册名常量（模块图单向，见下）。
//     ② `isIncumbentCoordinator`（名册判据：该会话此刻是不是**现任**协调者）—— 属名册/策略域；
//        `digestFooters`（工作台摘要脚注的组装）留在入口，由它调本档的渲染体。
//     ③ `windowWorkspaceFor` / `windowReadingFor` / `loadScopedSessionRecords`（状态卡段④/⑤/⑧ 的
//        **读窗口径**）—— 属会话读取面；它们与本档符号之间零引用（实测，两个方向都是 0）。
//     ④ 两条注册名 / order 常量的**取值理由**注释（§4.3 的宿主契约原文）随常量一并搬来，一字未动。
// ★ 搬运纪律（D4）：**符号定义与其文档注释逐字节原样** —— 只加 `export ` 与下面那一行导入；
//   一行逻辑 / 文案 / 判据都没有改（机械性由两套件全绿背书）。
// ★ 对外契约（D2）：入口仍是 `lib/index.js`（`package.json` 的 `main` / `exports` 一字未动），
//   它从这里 `import` 后把同一批名字交给同一批调用点 —— 含 `__testing` 里那一族段/预算读数
//   （本档 13 个名字：五个渲染体 + `CHARTER_MAX_LINES` + 五个预算读数 + `BUDGET_SECTION_MAX_LINES`
//   + `charterReinforceLine`；同族第 14 个 `isIncumbentCoordinator` 留在入口）⇒ 对外名字 /
//   签名 / 语义逐字不变。
// ★ 无环（Rr4）：本档对入口**零导入**；只依赖 `./shared.js` 的共享物。模块图单向：
//   入口 → 本档 → 共享档。
// ★ 宿主依赖面（Rr3）：本档**零宿主说明符**（纯函数 + 字符串拼接，不碰 fs / path / crypto）
//   ⇒ 汇总出来的宿主说明符仍恰为白名单那 8 个。
// ---------------------------------------------------------------------------

import { COORDINATOR_ROLE, describeError, sectionsView, wellFormed } from "./shared.js";

/**
 * 段的注册名与 **section 面的 order 来源**。
 *
 * ★ 批 C（§4.3 末条）：**两面不同，别把这条读成全称** ——
 *   · **section 面**（角色/宪章段，{@link ROLE_SECTION_NAME}）：`order` 一律取
 *     `getSectionOrder(...)`、**不用裸常量**。宿主 README 原文：「Repository-owned contributors
 *     resolve centrally allocated positions through `ctx.systemPrompt.getSectionOrder(name)`;
 *     runtime-context contributors use `getContextOrder(name)`. **External contributions may use
 *     any finite order.**」—— 闭集 `SECTION_ORDERS` 是给**仓库自有**贡献方的中心分配表，
 *     本段取的是宿主中心分配的 `TEAM_POLICY` 位次，走查表正是它规定的读法。
 *   · **context 面**（资源行）：闭集 `CONTEXT_ORDERS`（110/115/120）同样是给仓库自有贡献方的；
 *     本插件是**外部贡献方** ⇒ 任意**有限** order 就是契约规定的用法（宿主校验只有
 *     `Number.isFinite(order)`）。取值与理由见 {@link RESOURCE_CONTEXT_ORDER}。
 */
export const ROLE_SECTION_NAME = "team-link:role";
export const ROLE_SECTION_ORDER_KEY = "TEAM_POLICY";
/** 资源行的注册名（批 C，§7.2）。与段名分列，两条通道各自记账、各自 dispose。 */
export const RESOURCE_CONTEXT_NAME = "team-link:resources";
/**
 * 资源行的 `order`（批 C，§4.3）—— 本仓**唯一一处裸 order 常量**，理由逐字见上面那段宿主契约原文：
 * 外部贡献方「may use any finite order」。取 **130**（而不是 110/115/120 的下一个自然数 125）：
 * 给宿主未来的内置 context 键留位 —— 撞值本身无害（`contexts` 按 `a.order - b.order` 排、等值按
 * 注册序稳定），但没必要撞。U3 钉死 `order === 130`；宿主换代复核时把 `context` /
 * `getContextOrder` 加进核对清单（AGENTS.md §四）。
 */
export const RESOURCE_CONTEXT_ORDER = 130;
/** 评审 #3（第二轮设计评审）的行数预算：宪章段 ≤8 行、资源行恰 1 行。U 判据按换行切分逐个断言。 */
export const CHARTER_MAX_LINES = 8;

/** 计数渲染（token 量级）：不可读 ⇒ 「未知」（U6：缺字段显示未知，不显示 NaN / undefined）。 */
export function formatTokenCount(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "未知";
	if (value < 1000) return String(Math.round(value));
	if (value < 1e6) return (value / 1e3).toFixed(1) + "K";
	return (value / 1e6).toFixed(2) + "M";
}

/** tokenUsage.totals 的四桶求和（宿主形状见上）；不可读 ⇒ undefined。 */
export function sumTokenTotals(totals) {
	if (totals === null || typeof totals !== "object") return undefined;
	let sum = 0;
	let seen = false;
	for (const key of ["uncachedInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
		const value = totals[key];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
			sum += value;
			seen = true;
		}
	}
	return seen ? sum : undefined;
}

/**
 * FR-2 的资源行（恰 1 行，评审 #3 的行数预算）。前置：\`ctx.get\` 可用；后置：**恒返回字符串**
 * 且不含换行；任何一项读不出来都渲染「未知」/「不可读」，**绝不编数**（§9 fail-visible）。
 * 纯读：不写、不缓存、不改宿主状态（评审裁定 #2）。
 *
 * ★ 批 D（FR-3）：多一个**可选**出参 `probe` —— 把这次读到的回合号（`sessionStats.turns`）带出去，
 *   供回合门（{@link renderResourceContext}）判断「还是不是同一个回合」。**探针自身零额外读**：
 *   它复用本函数已经读过的那一次 `sessionStats`。
 *   ★ 范围如实收窄（分歧修复轮 · 审计 D2；与 :3115 的段头注释、host-half 的 U4 注解、
 *   verification-log 的批 D 交付面表同一口径）：**未命中**（无缓存条目）时投影读恰 3 次
 *   （那三个 key）⇒ 批 C 的「只读那三个 key」计数判据在这一支原样成立；**命中**（同回合）时
 *   门控自己读 **1** 次 `sessionStats`（渲染体整段不跑）；**条目在场但回合已前进**时 ＝ 1 ＋ 3 ＝ **4** 次。
 *   所以「不额外多读投影」**只对未命中支的渲染体成立**，不是全称句。
 *   传 `undefined` 时本函数的行为与批 C **逐字相同**（它仍是纯读的）。
 *
 * @param probe - 可选；`{ turn?: number }`。回合号读不出来时不写这个键（门控据此放弃门控）。
 */
export function renderResourceLine(ctx, agent, probe = undefined) {
	const projections = ctx?.get?.("sessionProjections");
	if (typeof projections?.stateOf !== "function") return "[team-link 会话资源] 不可读（sessionProjections 缺席）";
	const session = agent?.session;
	if (session === undefined || session === null) return "[team-link 会话资源] 不可读（本会话没有 session 面）";
	let pressure;
	let usage;
	let stats;
	try {
		pressure = projections.stateOf(session, "contextPressure");
		usage = projections.stateOf(session, "tokenUsage");
		stats = projections.stateOf(session, "sessionStats");
	} catch (error) {
		// ★ 批 E（FR-4）：错误文本是本出口里唯一能把**外部字节**带进上下文的一处（宿主服务自己抛的
		// 消息），所以这一条 return 也过消毒 —— 与下面那条正常 return 走同一个出口函数。
		return wellFormed("[team-link 会话资源] 不可读（投影读取抛错：" + describeError(error) + "）");
	}
	if (pressure === undefined && usage === undefined && stats === undefined) return "[team-link 会话资源] 不可读（投影未注册）";
	const window = typeof pressure?.contextWindow === "number" && pressure.contextWindow > 0 ? pressure.contextWindow : undefined;
	const pressureTokens = typeof pressure?.pressureTokens === "number" && pressure.pressureTokens >= 0 ? pressure.pressureTokens : undefined;
	const percent = window !== undefined && pressureTokens !== undefined ? ((pressureTokens / window) * 100).toFixed(1) + "%" : "未知";
	// ★ 批 D（FR-3）：回合号的**唯一**判定点（与门控读的是同一个 key、同一个闸门条件）。
	const turn = typeof stats?.turns === "number" && Number.isFinite(stats.turns) && stats.turns >= 0 ? stats.turns : undefined;
	if (probe !== null && typeof probe === "object") probe.turn = turn;
	const turns = turn === undefined ? "轮次未知" : "第 " + String(turn) + " 轮";
	// ★ 批 E（FR-4）：本出口是**模型可见文本**（系统提示的动态上下文通道）⇒ 过消毒。
	return wellFormed([
		"[team-link 会话资源]",
		"窗口 " + formatTokenCount(window),
		"压力 " + formatTokenCount(pressureTokens) + "（" + percent + "）",
		"压缩阈值 未知（宿主投影不含该读数）",
		"累计 ≈" + formatTokenCount(sumTokenTotals(usage?.totals)),
		turns,
	].join(" · "));
}

/**
 * FR-1 的协调者宪章（≤{@link CHARTER_MAX_LINES} 行，评审 #3 的行数预算）。
 * 条目全部是插件常量，只有 team / sessionId 两个**状态字段**被插值 —— 与 tickMessage 同一
 * 反走私不变式：注册参数（手改的 roster 行）不能把任意载荷塞进系统提示。
 */
export function renderCharterLines(team, sessionId) {
	return [
		"你是团队 " + team + " 的协调者（现任会话 " + sessionId + "）。职责边界：",
		"1. 你只做：管理 / 协调 / 决策 / 评审 / 设计；**不实施**：不改源码、不跑测试、不执行 git 提交、不做排查。",
		"2. 实施一律派给团队成员（team_link_send 用 team:<团队>/<角色> 寻址）；单点实现可派 eng_coder。",
		// ★ 批 J · FR-J3（设计档 §5 FR-J3 · §8 U5 · §10-2）：第 3 条尾部补**事实源指路** ——
		//   要看某位成员在干什么，读那个团队的黑板 tasks.md，**不要读它的会话历史**（后者的
		//   代价正是 FR-J2 那条压力告警讲的：对方的窗口会装进你自己的窗口）。仍**恰一行**
		//   （行数预算 `CHARTER_MAX_LINES` 不变，批 C 的 U2 逐字锁仍绿：新句不含禁词模式）。
		"3. 开工先看状态：team_link_status（谁在跑 / 谁空闲 / 谁需处置）；工作台摘要会自动推来，不必轮询。要看某位成员在干什么 ⇒ 读那个团队的黑板 `tasks.md`（`team_link_team_read`），**不要读它的会话历史**。",
		"4. 成员「空闲」= 待派工，不是故障；只有「需处置」（silent-idle / dead）才需要复核。",
		"5. 派活与收活都记账（team_link_team_append file=tasks，kind=plan/claim/done），不靠对话记忆。",
		"6. 用户直接命令你实施时先确认：这活该派还是该自己做（只有用户明确说「你自己做」才自己做）。",
	].join("\n");
}

/**
 * FR-2 的 worker 版义务行（恰 1 行）：向谁汇报 + 不要静默等待。
 *
 * ★ task-11（t-9 存疑 #2 的裁定；形状由 lead 定）：**只用角色寻址** team:<团队>/coordinator，
 * 不再嵌协调者会话的裸 id。理由：换届 = 换会话，写死 id 的那一刻就开始过期 —— 而 sync 的
 * 「同一条」判据只比 team/role/kind（t-9 的 B 判据钉的正是「旁观 worker 段逐字未动」），
 * 于是旧 id 会一直挂在段里。角色寻址在**投递时**由 team_link_send 按当时的现任解析 ⇒ 永不过期，
 * 也就不需要因换届而重注册 worker 段。被否决的另一条路（把 coordinatorId 纳入比较）会让每次
 * 换届把全队 worker 段 dispose + 重注册。
 */
export function renderWorkerDutyLine(team, role) {
	return "你是团队 " + team + " 的角色 " + role + "：向本队协调者汇报（team_link_send 用 team:" + team + "/" + COORDINATOR_ROLE + " 寻址，投递时按当时现任解析）；不要静默等待 —— 干完就回报结论/证据/下一步，需要授权或遇到阻塞就明说。";
}

/**
 * §6.1（批 C）**段渲染体**：只产**会话期内恒定**的文本 —— 宪章 / 义务行。
 *
 * 前置：`plan.switches` 已由 {@link sectionsView} 归一（缺省视为 true）。
 * 后置：同一会话连续两次调用返回值**逐字节相等**（批 C 的核心不变量 U1 —— 锚测试）；
 *   任何输入下恒返回字符串（可能为空串），**不抛**（返回 undefined 会让整次装配抛错）。
 *
 * ★ v1.1（差异审计 🔵⑦）：签名补 `onError` —— 抛错时**仍然吞掉并返回空串**（热路径绝不让装配失败），
 *   但必须经 `onError` **留一行痕**，与 {@link renderResourceContext} 对称，恢复批 2 的可见性。
 *   §9 的失败方向是 fail-visible，静默 `catch {}` 与它矛盾。生产侧传的是注册器里那个**一次性**
 *   留痕门（`warnRender`，§6.3 明说它「就是 §6.2 那个 onError 实参——同一个函数的两个名字」），
 *   所以两面共用一道门：两面任何一侧抛错，整个注册生命周期内也只留**一行**。
 *
 * ★ 资源行**不在**这里（批 C 把它搬出段面，落点见 {@link renderResourceContext}）：它每次装配
 *   现算，留在段里会让系统提示逐回合变化 ⇒ provider 前缀缓存从变化点起全断。段里只留恒定文本。
 *
 * @param plan - `{ team, sessionId, role, kind, switches }`（kind: "coordinator" | "worker"；
 *   task-11 之后 worker 版**不依赖**协调者身份 —— 它走角色寻址，于是换届不会让它的文本过期）
 * @param onError - 可选；抛错时以该 error 调用一次（调用方负责一次性门）
 */
export function renderRoleText(plan, onError) {
	try {
		// FR-9 总开关：role=false ⇒ 角色文本（宪章 / 义务行）全缺（注册处也不再挂这个面）。
		const switches = sectionsView(plan.switches);
		if (!switches.role) return "";
		// ★ 批 E（FR-4）：本出口是**模型可见文本**（段面进系统提示）⇒ 过消毒。两档各自渲染，
		// 但只有一个出口 —— 消毒挂在这一处即可覆盖 coordinator / worker 两条支路。
		return wellFormed(plan.kind === "coordinator"
			? renderCharterLines(plan.team, plan.sessionId)
			: renderWorkerDutyLine(plan.team, plan.role));
	} catch (error) {
		// 输入全是插件自己的常量（team / sessionId / role / kind），生产里本不会抛；这里仍然吞掉，
		// 因为装配是热路径，**绝不让任何会话的提示装配因为本插件失败**（§9 fail-visible）。
		// 但吞掉不等于沉默：照 v1.1 的签名经 onError 留一行痕（一次性门由调用方持有）。
		if (typeof onError === "function") onError(error);
		return "";
	}
}

/** ★ 批 D（FR-3）: 门控用的**回合号**读取。只在「缓存命中」那条路径上多读一次 `sessionStats`
 *  （渲染体自身的读不被它替代，见 {@link renderResourceLine} 的探针）。读不出来（服务缺席 /
 *  会话面不在 / 读抛错 / 不是有限数）⇒ `undefined` ⇒ 调用方**放弃门控**（每次现算）。
 *  这仍然只碰 `sessionProjections` 的三个 key 里那一个，桩上没有任何写方法。 */
export function currentTurnOf(ctx, agent) {
	const projections = ctx?.get?.("sessionProjections");
	if (typeof projections?.stateOf !== "function") return undefined;
	const session = agent?.session;
	if (session === undefined || session === null) return undefined;
	try {
		const stats = projections.stateOf(session, "sessionStats");
		return typeof stats?.turns === "number" && Number.isFinite(stats.turns) && stats.turns >= 0 ? stats.turns : undefined;
	} catch {
		return undefined;
	}
}

/**
 * §6.2（批 C）**上下文渲染体**：落点是宿主的动态运行时上下文通道（尾部追加的
 * user 消息，不是系统提示前缀）。内容逐字沿用 {@link renderResourceLine}（功能一条不减）。
 *
 * 前置：`ctx` 可用；`agent` **由注册时闭包捕获**。
 *   ★ 宿主 `AssembleContext = { scope?, signal? }` —— **没有 `agent` 字段**（会诊 #34 D5，asar 实读），
 *     所以 `assembly?.agent` **恒为 undefined**：`text` 是零参闭包，注册处直接捕获当时那个 agent，
 *     **不写这条走不到的死路径**。
 * 后置：恒返回字符串；任一项读不出来 ⇒ 行内说「不可读（<原因码>）」，**绝不编数**（FR-2 原口径）；
 *   纯读：不写宿主状态、不改宿主状态；渲染体自身抛错 ⇒ 吞掉 + 经 `onError` 一次性留痕（可选）、
 *   返回空串（空串 = 本步不贡献上下文，宿主按整条快照文本去重，不会因此多发消息）。
 *
 * ★ 批 D（FR-3，用户 2026-10-10 拍板 A）**回合门**：带 `gate`（`{ sessionId, cache }`）时，
 *   **同一个 `sessionStats.turns` 内返回上一条字符串**，回合号前进才现算 —— 每步一条持久化快照的
 *   量级（批 C 实测 0.93 条/请求）由此降一个量级。代价如实声明：**回合内读数会变陈**
 *   （长回合里压力增长看不见），这正是设计档 §4.3 记下的、被接受的代价。
 *   缓存是**进程内、只用于门控**（不是读数缓存：回合号一前进就地覆盖），随注册生命周期释放（U8）。
 *   回合号读不出来 ⇒ **不门控**（每次现算）：判不了「是不是同一回合」时，宁可多写一条也不返回陈读数。
 */
export function renderResourceContext(ctx, agent, onError, gate = undefined) {
	try {
		const cache = gate?.cache;
		const sessionId = gate?.sessionId;
		const gated = cache instanceof Map && typeof sessionId === "string" && sessionId !== "";
		if (gated) {
			const cached = cache.get(sessionId);
			if (cached !== undefined && currentTurnOf(ctx, agent) === cached.turn) return cached.text;
		}
		// 探针只在门控开启时挂上（不带 gate 的调用点——digest 脚注、__testing 直调——行为逐字不变）。
		const probe = gated ? {} : undefined;
		// ★ 批 E（FR-4）：本出口是**模型可见文本**。`renderResourceLine` 自己已过一道，但门控**命中**
		// 时返回的是**缓存里那一条**（绕开了那个出口），所以消毒在门控两侧各挂一处 —— 两条 return
		// 都覆盖到，缓存里存的也已是干净文本（写进缓存的正是下面这个 `text`）。
		const text = wellFormed(renderResourceLine(ctx, agent, probe));
		if (gated) {
			// `probe.turn` 是 undefined（投影读不出来 / 早退分支）⇒ 不留条目，也顺手清掉可能过期的旧条目。
			if (probe.turn === undefined) cache.delete(sessionId);
			else cache.set(sessionId, { turn: probe.turn, text });
		}
		return text;
	} catch (error) {
		if (typeof onError === "function") onError(error);
		return "";
	}
}


/**
 * ★ FR-5/FR-6（批 3）: 状态卡第 ⑧ 段「资源/预算」＋轮换标记。
 *
 * 父侧裁定（task-12 描述里的口径，**与旧设计档措辞不同、以裁定为准**）：宿主投影不含压缩阈值 ⇒
 * 判读行**不做**「低于阈值」的比较；结论二选一 —— 读数不可得 ⇒「读数不可得，不作判读」；
 * 可得 ⇒「未见收口理由：本系统按压力自动压缩，结构上不存在『预算耗尽』」。
 * 「预算耗尽」一词只允许出现在**判读行**且只能是**否定式**（U7）。
 */
export const BUDGET_SECTION_MAX_LINES = 12;
/**
 * §FR-15 起的**读窗口**上限：只对前这么多会话读投影（成本不变量）。**渲染**的明细行数由
 * `budgetSectionLines` 的留位算式决定（段头 / 判读行 / 轮换标记 / 裁剪标注先占位 ⇒ 实际更少），
 * 所以这个常量是「最多读几个」，不是「最多渲染几行」——两件事分开，行数上限的判据见 U25。
 */
export const BUDGET_SECTION_MAX_ROWS = BUDGET_SECTION_MAX_LINES - 2;
/** FR-6 的轮换阈值（D-B3 裁定：**严格大于** —— 100 整 / 2 亿整不算候选）。 */
export const ROTATE_CANDIDATE_TURNS = 100;
export const ROTATE_CANDIDATE_TOKENS = 200000000;

/** FR-9 的总开关（读到缺省 = 两处都开）。 */
export function sectionsSwitches(policyView) {
	return sectionsView(policyView?.sections);
}

/**
 * 一个会话的资源读数（纯读 · 零缓存 —— 评审裁定 #2）。
 * @returns 一个对象：available / reason / sessionId / window / pressureTokens / percent / totalTokens / turns；
 *   available 为 false 时 reason 是原因码之一：sessionProjections 缺席 / 没有会话身份 / 投影读取抛错 / 投影未注册。
 */
export function readSessionUsage(ctx, sessionId) {
	const projections = ctx?.get?.("sessionProjections");
	if (typeof projections?.stateOf !== "function") return { available: false, reason: "sessionProjections 缺席", sessionId };
	if (typeof sessionId !== "string" || sessionId === "") return { available: false, reason: "没有会话身份", sessionId };
	// ★ 2026-10-10 真机缺陷热修：**绝不构造替身会话对象**。宿主真身是
	//   stateOf(session, key) → materializeCells(session) → session.snapshotEvents(...)；
	//   任何 `{ header: { id } }` 之类的替身都会在真宿主抛
	//   `session.snapshotEvents is not a function`（本批第 ⑧ 段因此每行都渲染成「不可读」）。
	//   只取**活动会话**的真身：ctx.agents.get(id).session；拿不到 ⇒ 如实说「非活动会话」。
	// ★ D（task-18）：全仓 `.stateOf(` 只剩**两组**调用点 —— :2967-2969 的 renderResourceLine（走
	//   agent.session 真身）与这里（走 ctx.agents.get(id).session 真身）。两组**都只传真实会话对象**；
	//   宿主内部会调 session.snapshotEvents(...)，替身必炸（2026-10-10 真机）。
	const session = ctx?.agents?.get?.(sessionId)?.session;
	if (session === undefined || session === null) return { available: false, reason: "非活动会话", sessionId };
	let pressure;
	let usage;
	let stats;
	try {
		pressure = projections.stateOf(session, "contextPressure");
		usage = projections.stateOf(session, "tokenUsage");
		stats = projections.stateOf(session, "sessionStats");
	} catch (error) {
		return { available: false, reason: "投影读取抛错", detail: describeError(error), sessionId };
	}
	if (pressure === undefined && usage === undefined && stats === undefined) return { available: false, reason: "投影未注册", sessionId };
	const window = typeof pressure?.contextWindow === "number" && pressure.contextWindow > 0 ? pressure.contextWindow : undefined;
	const pressureTokens = typeof pressure?.pressureTokens === "number" && pressure.pressureTokens >= 0 ? pressure.pressureTokens : undefined;
	return {
		available: true,
		sessionId,
		window,
		pressureTokens,
		percent: window !== undefined && pressureTokens !== undefined ? (pressureTokens / window) * 100 : undefined,
		totalTokens: sumTokenTotals(usage?.totals),
		turns: typeof stats?.turns === "number" && Number.isFinite(stats.turns) && stats.turns >= 0 ? stats.turns : undefined,
	};
}

/** 第 ⑧ 段的一行（会话资源）。读数不可得 ⇒ 整行如实标「不可读」并给原因码（§9）。 */
export function budgetRowLine(readings, extra = "") {
	if (!readings.available) return "- " + readings.sessionId + "：不可读（原因：" + readings.reason + (readings.detail === undefined ? "" : "：" + readings.detail) + "）" + extra;
	const windowField = readings.window === undefined ? "未知" : formatTokenCount(readings.window);
	const percentField = readings.percent === undefined ? "未知" : readings.percent.toFixed(1) + "%";
	const turnsField = readings.turns === undefined ? "轮次未知" : "第 " + String(readings.turns) + " 轮";
	return "- " + readings.sessionId + "：压力 " + percentField + "（窗口 " + windowField + "） · 累计 ≈" + formatTokenCount(readings.totalTokens) + " · " + turnsField + extra;
}

/** FR-6: 该会话是否达到轮换线（严格大于；turns 不可读 ⇒ 只按 tokens 判，并标「轮次未知」）。 */
export function rotateCandidateOf(readings) {
	if (!readings.available) return null;
	const byTurns = readings.turns !== undefined && readings.turns > ROTATE_CANDIDATE_TURNS;
	const byTokens = readings.totalTokens !== undefined && readings.totalTokens > ROTATE_CANDIDATE_TOKENS;
	if (!byTurns && !byTokens) return null;
	return {
		turns: readings.turns,
		tokens: readings.totalTokens,
		label: "轮换候选（" + (readings.turns === undefined ? "轮次未知" : "turns=" + String(readings.turns)) + " / tokens≈" + formatTokenCount(readings.totalTokens) + "）",
	};
}

/**
 * ★ FR-14（批 6）的**范围界定句**（逐字，设计档 §5 FR-14 原句）。判读行末尾恒接这一句。
 *
 * 为什么：真机核对（2026-10-10）拿到宿主原文 —— auto review of tool "write" failed: its body was
 * not executed: reviewer ended with error RATE_LIMIT: 429: {"code":"1310","message":"您已达到
 * 每周/每月使用上限…重置"}。这是**真实存在**的写入闸门（工具本体未执行），而第 ⑧ 段/判读行只
 * 担保「上下文/预算」这一档。两类混谈会**既误判真事、也放过真幻觉**（用户当时就把它当成了
 * 插件的配额幻觉）⇒ 判读行必须自己说清「我判的是哪一类」。新增句**不含**任何禁词（三词的
 * 计数与位置约束原样，U24 用程序化指纹核对）。
 */
export const BUDGET_VERDICT_SCOPE = "（本节只判上下文/预算；宿主工具闸门——如写入自动评审 429——属另一类，见工具报错原文，不在本节口径内。）";

/**
 * 第 ⑧ 段的判读行（U7 措辞纪律的**唯一**落点）：读数不可得 ⇒ 不作判读；可得 ⇒ 否定式结论。
 * 「预算耗尽」四个字整个模块里只允许出现在本函数的那个字符串里（且只能是否定式）。
 * FR-14 起：两支的末尾都接 {@link BUDGET_VERDICT_SCOPE}（**只加这一句**，既有两句一字未改）。
 */
export function budgetVerdictLine(anyAvailable, firstUnavailableReason) {
	if (!anyAvailable) return "预算判读：读数不可得，不作判读" + (firstUnavailableReason === undefined ? "（原因不可读）" : "（原因：" + firstUnavailableReason + "）") + "。" + BUDGET_VERDICT_SCOPE;
	return "预算判读：未见收口理由：本系统按压力自动压缩，结构上不存在『预算耗尽』。" + BUDGET_VERDICT_SCOPE;
}

/**
 * FR-5/FR-6 的段体：段头 + 明细行（候选行尾带 ⚠ 标记）+（有候选时的）一句现成命令 + 判读行，
 * 总行数 ≤BUDGET_SECTION_MAX_LINES。**纯读**：只读 sessionProjections 与 policy。
 *
 * ★ FR-15（批 7）: 行数上限下**判读行与轮换标记恒在场** —— 先给它们（以及裁剪标注）留位，
 * 被裁的只能是明细行，且裁剪**如实标注**。为什么：旧实现先拼完整段再 `slice(0, 12)`，真机
 * 2026-10-10 实测「10 个会话行 + 轮换标记 = 12 行」时**判读行（末行）被静默裁掉**（`判读` 命中 0）
 * —— FR-14 的范围界定句恰好在**最需要它的忙碌团队**上失效。
 */
export function budgetSectionLines(ctx, sessionIds, options = {}) {
	const allIds = sessionIds.filter((id, index, all) => typeof id === "string" && id !== "" && all.indexOf(id) === index);
	// 读窗口（成本不变量）：只对前 BUDGET_SECTION_MAX_ROWS 个会话读投影；**渲染**行数由下面的留位算式定。
	const ids = allIds.slice(0, BUDGET_SECTION_MAX_ROWS);
	const rows = [];
	let anyAvailable = false;
	let firstReason;
	const candidates = [];
	for (const id of ids) {
		const readings = readSessionUsage(ctx, id);
		if (readings.available) anyAvailable = true;
		else if (firstReason === undefined) firstReason = readings.reason;
		const candidate = rotateCandidateOf(readings);
		rows.push(candidate === null ? budgetRowLine(readings) : budgetRowLine(readings, " · ⚠ " + candidate.label));
		if (candidate !== null) candidates.push({ id, candidate });
	}
	const markerLine = candidates.length === 0 ? null : "→ 轮换（只标记、不自动；判断权在你）：team_link_rotate action=prepare successor:auto —— 候选 " + candidates.map((row) => row.id).join("、");
	const verdictLine = budgetVerdictLine(anyAvailable, firstReason);
	// 先留位：段头 1 行 + 判读行 1 行 +（有候选时的）轮换标记 1 行 ⇒ 明细行能占这么多。
	const tailLines = 1 + (markerLine === null ? 0 : 1);
	let kept = rows.length;
	let cropNote = null;
	if (rows.length > BUDGET_SECTION_MAX_LINES - 1 - tailLines) {
		// 要裁明细 ⇒ 还得让出一行给标注（总行数因此仍是 ≤ 上限，而不是「裁了也不说」）。
		kept = BUDGET_SECTION_MAX_LINES - 1 - tailLines - 1;
		cropNote = "（行数上限 " + BUDGET_SECTION_MAX_LINES + "；已省略 " + (allIds.length - kept) + " 行明细）";
	}
	const lines = ["--- 资源/预算（⑧；每会话一行：压力 / 窗口 / 累计 / 轮次；只读 sessionProjections，零写盘）---"];
	if (ids.length === 0) lines.push("（无会话可读）");
	for (const row of rows.slice(0, kept)) lines.push(row);
	if (cropNote !== null) lines.push(cropNote);
	if (markerLine !== null) lines.push(markerLine);
	lines.push(verdictLine);
	return lines;
}

/** FR-4 的重钉行（四处共用一句，只在调用方是现任协调者时出现）。 */
export function charterReinforceLine(teamName) {
	return "角色重钉：你是团队 " + teamName + " 的协调者（现任）——派活/评审/决策，**不亲手实施**；实施派给成员（team_link_send 用角色寻址）。";
}

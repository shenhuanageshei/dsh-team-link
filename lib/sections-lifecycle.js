// ---------------------------------------------------------------------------
// 域档：段与资源的注册器与生命周期 —— 批 R 第 22 小单从 `lib/index.js` 原样搬出
// ---------------------------------------------------------------------------
// 归属：docs/2026-10-15-store-compliance-design.md §4 D1/D2/D4 · §5 FR-R1 · §6（拆分不变量 ①–⑤）。
// 本档承载的那一个函数的权威设计档：docs/2026-10-09-team-autonomy-design.md §5 FR-1/FR-2 · §6
// （registerRoleSection 的签名与前后置）· §7.2（进程内 `sections` 表）· §9（失败方向）；批 C 的落点
// 拆分见 docs/2026-10-10-prompt-cache-design.md §6.3/§6.4；批 D 的回合门与自愈见
// docs/2026-10-10-registration-lifecycle-design.md §4.3 · §5 FR-3 · §6。
//
// ★ 本档只装**一个**函数：`createSections(ctx, policy)` 连同它那条 JSDoc —— 注册表 / 期望集 /
//   回合门缓存 / 五道一次性留痕门 / 自愈判据 / 注册与释放 / `sync()` / `disposeAll()` / 读数面。
//
// ★ 为什么是**新档**而不是并进 `lib/sections.js`：那一档的档头把 `createSections` 明确列为**不属于**
//   它的符号（「属工具注册与生命周期域」，见该档「域边界」①）；本档沿用它同一批既有依赖方向：
//   本档 → `./sections.js`（渲染体与四条注册名 / 开关）· `./rotation.js`（`roleOf`）· `./shared.js`。
//
// ★ 被钉符号（本仓 `hostSource` 文本锁钉住的 9 个）在这一块里**零命中** —— 九个仍逐字节住在入口。
//
// ★ 依赖方向（模块图无环）：本档三条出边 = `./shared.js` / `./sections.js` / `./rotation.js`；
//   `rotation.js` 的可达集 = { rotation, shared, ledger }，`sections.js` 的可达集 = { sections, shared }，
//   都**不含本档、也不含入口** ⇒ 没有新环。本档**零宿主说明符**。
//
// ★ 装配缝（先例：`lib/forensics.js` 的 `wireForensics()`）：本档需要的**唯一一条**入口侧绑定
//   （`PLUGIN_LABEL`：三段 warn 文案的前缀）**只注入、不搬**。前置：入口在**模块求值**时调用一次
//   （`lib/index.js` 模块尾部）。后置：本档模块级 `let` 绑定到入口那一份真实现。
//
// ★ 搬运纪律（D4）：本档新增的只有 ① 本段档头 ② 3 条 import ③ 装配缝 ④ 定义行前的 `export `；
//   **函数体 / 注释 / 缩进 / 文案一个字符都没动**（逐字节等价机检见交付报告）。
// ---------------------------------------------------------------------------

import { roleOf } from "./rotation.js";
import { RESOURCE_CONTEXT_NAME, RESOURCE_CONTEXT_ORDER, ROLE_SECTION_NAME, ROLE_SECTION_ORDER_KEY, renderResourceContext, renderRoleText, sectionsSwitches } from "./sections.js";
import { COORDINATOR_ROLE, describeError } from "./shared.js";

// ---------------------------------------------------------------------------
// 装配缝 · `wireSectionsLifecycle(extras)`（先例：`lib/forensics.js` 的 `wireForensics()`）
// ---------------------------------------------------------------------------
let PLUGIN_LABEL;

/** 入口侧出口的一次性绑定（见档头的前置 / 后置）。 */
export function wireSectionsLifecycle(extras) {
	({ PLUGIN_LABEL } = extras);
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
export function createSections(ctx, policy) {
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

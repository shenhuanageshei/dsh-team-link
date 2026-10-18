// ---------------------------------------------------------------------------
// 批 R（上架合规）第 15 小单：跨会话看门狗（M1）的巡检 / 摘要 / 两档告警助手族 —— 从 `lib/index.js` 原样搬出
// ---------------------------------------------------------------------------
// 归属：docs/2026-10-15-store-compliance-design.md §4 D1/D2/D4 · §5 FR-R1 · §6（拆分契约：只做「移动 + 补
//       export」、无副作用搬家、模块图无环）· §8 Rr1/Rr3/Rr4/Rr8。
// ★ 本档是什么：入口原 2,537–3,218 行（682 行 / 26 条声明）的**一整块**：
//   ① §3.2 的注册校验与自动注册规划（readBoundedNumber / readTtlHours / buildWatchdogRegistration /
//      planAutoWatchdog / autoWatchdogRosterGate / ensureTeamAutoWatchdogs / summarizeAutoWatchdogs /
//      chainReportLine / armTeamWatchdog）；
//   ② 巡逻一拍与摘要（timerArmed / tickMessage / watchdogHasNoInflightWork / classifyWatchdogTargets /
//      watchdogDigestActionable / watchdogDigestSignature / digestSilenceOf / renderWatchdogDigest）；
//   ③ 两档独立告警（renderIdleAlert / bucketOf / renderPressureAlert）；
//   ④ 它们共用的会话面读数与 digest 脚注（readSessionSurface / windowWorkspaceFor / windowReadingFor /
//      loadScopedSessionRecords / isIncumbentCoordinator / digestFooters）。
//   实测：**47,512 字节**（CRLF 工作树）/ **46,830 字节**（EOL 归一到 LF）—— 本小单 60 KB 档位上限之内。
//   机检口径：把本档那段正文按声明行去掉 `export ` 前缀后，与入口原位置的同一段**逐字节相等**（EOL 归一）；
//   该段在入口里**零次**。
//   ★ 它是一个**自成一体的块**：注册校验 → 自动注册规划 / 按队补挂 → 巡逻一拍 → 摘要与两档告警 → 读数脚注
//     互相闭合，对外只经下面「装配缝」的 20 条入口侧出口与三条相对导入 + 一条宿主导入取物。
// ★ 本档**不是**（留给下一小单）：入口里另外几个尚未成档的大块 —— policy store 核心（62,447 B，**越过
//   60 KB 档位**）· 换届交班面（命令 + 交接文档 + 自建继任者委任，52,641 B，但它被 `host-half.test.mjs`
//   四条「只读 lib/index.js」的行模板锁钉住：`rotationFactRows` 必须留在入口）· `/team_session` 的计划与
//   确认框族（46,193 B）· 删团队 / 名册镜像 / 收件回执（44,186 B）。
//   为什么这一单搬它：候选闭包实测（见交付报告）里它是**最大的、且不撞任何「只读 index.js」文本锁**的
//   自成一体的块（47,512 B）—— watchdog 家族在 R-12 那一单就记过「整族 65,681 B 越过 60 KB」，本单把
//   助手族这一半搬走，余下（§3.2 常量区 / `watchdogLines` 段渲染 / `watchdogFor` 等）留给下一单。
// ★ 依赖方向（Rr4「模块图无环」）：本档**不导入入口** `lib/index.js`（那会构成 ESM 环，实跑当场 TDZ）——
//   ① 内部相对导入 **3 条**：`./shared.js`（5 名）· `./sections.js`（4 名）· `./rotation.js`（1 名）；
//   ② 宿主导入 **1 条**：`node:crypto` 的 `randomUUID`（说明符已在白名单内 ⇒ Rr3 的集合读数不变）；
//   ③ 装配缝注入 **20 条**（先例 `wireForensics()` / `wireWatchdog(extras)` / `wireRecovery(extras)`）：
//      `wireWatchdogHelpers(extras)` 在模块求值时一次性绑定到同名模块级 `let` 上 —— 绑定与搬迁前
//      **逐个同一** ⇒ 行为逐字不变；逐条归属见入口的 `watchdogHelpersExtras()`。
//   两类出边**都不回指入口或本档** ⇒ 本单**不新增环**。
// ★ 被钉符号核对（本仓 `hostSource` 文本锁钉住的 9 个：writePolicyFileAtomic / renameThroughSeam /
//   POLICY_FILE_SCHEMA / WATCHDOG_DIGEST_DEBOUNCE_MS / TICKABLE_VERDICTS / agentStateLabel / writerGate /
//   relayUserMessage / buildTeamSessionCreateOptions）：**本单一个都没搬**，九个仍逐字节住在入口（定义、
//   文档注释与锚点切片位置一字不动 ⇒ 那几条源码锁读数不变）。其中两个（WATCHDOG_DIGEST_DEBOUNCE_MS /
//   TICKABLE_VERDICTS）是本档**可执行代码**的依赖 —— 按「被钉符号只注入不搬」经缝传入；其余 7 个在本档
//   可执行代码里**零次**。
// ★ 搬运纪律（D4）：本档新增的只有 ① 本段档头 ② 4 条 import 语句 ③ 装配缝 ④ 26 条声明行上的 `export `
//   前缀；其余（含全部行内注释、嵌套函数与中文文案）**一个字符都没动**。
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { roleOf } from "./rotation.js";
import { charterReinforceLine, formatTokenCount, renderResourceLine, sectionsSwitches } from "./sections.js";
import { COORDINATOR_ROLE, describeError, noticeField, readStamp, wellFormed } from "./shared.js";

// ---------------------------------------------------------------------------
// 装配缝 · `wireWatchdogHelpers(extras)`（先例：`lib/forensics.js` 的 `wireForensics()`）
// ---------------------------------------------------------------------------
// 前置：入口在**模块求值**时调用一次（`lib/index.js` 模块尾部，紧挨 `wireWatchdog(…)`），给出的 20 个键
//       与被注入的绑定**同名同值**。
// 后置：本档的模块级 `let` 全部绑定到入口那一份真实现；此后每次注册校验 / 巡逻一拍 / 摘要渲染 / 读数脚注
//       读到的都是它。
// 为什么不是 import：见档头「依赖方向」①（入口 → 域档会成环）。
// 为什么是一次性绑定而不是每次调用现取：绑定之后巡逻 / 摘要 / 告警 / 读数体内的裸名**逐字节保留**
// （只在函数体外加了这一个缝），D4 的逐字节等价可以直接机检。
// ---------------------------------------------------------------------------
let TICKABLE_VERDICTS, WATCHDOG_DIGEST_DEBOUNCE_MS, WATCHDOG_AUTO_INTERVAL_MINUTES, WATCHDOG_DEFAULT_INTERVAL_MINUTES, WATCHDOG_DEFAULT_SILENT_MINUTES, WATCHDOG_DEFAULT_TTL_HOURS, WATCHDOG_MAX_TTL_HOURS, WATCHDOG_MIN_INTERVAL_MINUTES, WATCHDOG_MIN_SILENT_MINUTES, WATCHDOG_ORIGIN_AUTO, WATCHDOG_ORIGIN_MANUAL, WATCHDOG_DIGEST_LABEL, WATCHDOG_IDLE_ALERT_LABEL, WATCHDOG_PRESSURE_ALERT_LABEL, WATCHDOG_ID_PREFIX, WATCHDOG_TICK_ID_PREFIX, LIAISON_PRESSURE_WARN_PERCENT, fmtSilence, PLUGIN_LABEL, name;

/** 入口侧出口的一次性绑定（见本节档头的前置 / 后置）。 */
export function wireWatchdogHelpers(extras) {
	({
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
		fmtSilence,
		PLUGIN_LABEL,
		name,
	} = extras);
}

/** Inclusive bounded-number reading for one registration argument. */
export function readBoundedNumber(value, name, min, max, options = {}) {
	if (value === undefined || value === null) return { value: undefined };
	if (typeof value !== "number" || !Number.isFinite(value)) return { error: `${name} 必须是数字。` };
	if (options.integer === true && !Number.isInteger(value)) return { error: `${name} 必须是整数。` };
	if (value < min) return { error: `${name} 不能小于 ${min}。` };
	if (max !== undefined && value > max) return { error: `${name} 不能大于 ${max}。` };
	return { value };
}

/** TTL reading (§3.2.4: `<= 24h`, default 12h; strictly positive). */
export function readTtlHours(value) {
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
export function buildWatchdogRegistration(request) {
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
export function planAutoWatchdog(watchdogs, request) {
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
export function autoWatchdogRosterGate(teams, teamName, watcherSession) {
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
export async function ensureTeamAutoWatchdogs(ctx, policy, watchdog, options = {}) {
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
export function summarizeAutoWatchdogs(reports) {
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
export function chainReportLine(report) {
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
export async function armTeamWatchdog(ctx, policy, watchdog, request) {
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
export function timerArmed(watchdog, id) {
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
export function tickMessage(watcherSession, target, signal, now, origin = undefined) {
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
export function watchdogHasNoInflightWork(signal) {
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
export function classifyWatchdogTargets(rows) {
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
export function watchdogDigestActionable(groups) {
	return groups.idleAwait.length + groups.justFinished.length + groups.alarm.length > 0;
}

/** 状态指纹：四组各自的 id 序列。指纹没变 ⇒ 这条摘要要说的话还是同一句（U9「无事不许打扰」）。 */
export function watchdogDigestSignature(groups) {
	return ["running", "justFinished", "idleAwait", "alarm"]
		.map((key) => `${key}:${groups[key].map((row) => row.target).join(",")}`)
		.join("|");
}

/** 静默读数：读不出时间戳时说「?」，不说 0（与 {@link livenessLine} 同一口径）。 */
export function digestSilenceOf(signal) {
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
export function renderWatchdogDigest(entry, groups, now, footers = []) {
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
export function renderIdleAlert(entry, groups, now) {
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
export function bucketOf(percent) {
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
export function renderPressureAlert(reading, now) {
	const percent = typeof reading?.percent === "number" && Number.isFinite(reading.percent) ? reading.percent.toFixed(1) + "%" : "未知";
	const lines = [
		`${WATCHDOG_PRESSURE_ALERT_LABEL} 你自己的上下文压力 ${percent}（压力 ${formatTokenCount(reading?.pressureTokens)} / 窗口 ${formatTokenCount(reading?.window)}，阈值 ${LIAISON_PRESSURE_WARN_PERCENT}%，读数 ${readStamp(now)}）`,
		"后果点名：再读别人的会话历史会把你自己的窗口读满 —— 读别人的会话会把对方的历史装进你自己的窗口，而"
			+ "「某位成员在干什么」不必从它的历史里读。",
	];
	return wellFormed(lines.join("\n"));
}

/** Best-effort session surface read; an unreadable or cold log yields `undefined`. */
export async function readSessionSurface(ctx, sessionId) {
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
export function windowWorkspaceFor(shownTeams) {
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
export function windowReadingFor(shownTeams, callerCwd, options = {}) {
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
export async function loadScopedSessionRecords(ctx, workspace) {
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
export function isIncumbentCoordinator(policyView, teamName, sessionId) {
	if (typeof sessionId !== "string" || sessionId === "") return false;
	const team = (policyView?.teams ?? []).find((entry) => entry.name === teamName);
	if (team === undefined) return false;
	return (roleOf(team, COORDINATOR_ROLE)?.current ?? null) === sessionId;
}

/**
 * FR-4/FR-9 的 digest 脚注（0–2 行）：资源行（resources=true）+ 角色重钉（role=true 且观察者
 * 确实是该队现任协调者）。纯读 —— 资源行直读投影，重钉只读 policy。
 */
export function digestFooters(ctx, policy, entry, watcher) {
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

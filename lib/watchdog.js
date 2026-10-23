// ---------------------------------------------------------------------------
// 看门狗控制器域（watchdog）：跨会话看门狗（M1）的**控制器本体** —— 批 R（上架合规）第 12 小单从 `lib/index.js` 原样搬出
// ---------------------------------------------------------------------------
// 归属：docs/2026-10-15-store-compliance-design.md §4 D1/D2/D4 · §5 FR-R1 · §6（拆分契约：只做「移动 + 补
//       export」、无副作用搬家、模块图无环）· §8 Rr1/Rr3/Rr4/Rr8。
// ★ 本档是什么：**一个**控制器工厂 —— `createWatchdog(ctx, policy, rotation, sections = undefined,
//   forensics = undefined)`，连同它上面那段 JSDoc。**函数体逐字节等于原位置**（设计档 D4：只做「移动 +
//   补 export」）：662 行；工作树 43,746 字节（CRLF 行尾）/ 43,084 字节（EOL 归一到 LF）。机检口径：该段
//   文本在本档里**逐字节出现恰一次**（唯一差别是声明行多了 `export ` 这 7 个字节）、在入口里**零次**
//   （EOL 归一同结论）。
//   ★ 它是一个**自成一体的块**：七张进程内表（`timers` / `ticked` / `deadWatchers` / `lastAgentState` /
//     `digested` / `idleAlerted` / `pressureAlerted`）、22 条内部函数（`stopTimer` … `cancel`）与那条具名
//     返回值 `controller` 全在闭包内；对外只依赖 27 个入口侧出口（见下面「装配缝」）。
// ★ 本档**不是**（留给下一小单）：watchdog 家族**余下 21 个声明**仍在入口（`readBoundedNumber` /
//   `readTtlHours` / `buildWatchdogRegistration` / `planAutoWatchdog` / `autoWatchdogRosterGate` /
//   `ensureTeamAutoWatchdogs` / `summarizeAutoWatchdogs` / `chainReportLine` / `armTeamWatchdog` /
//   `timerArmed` / `tickMessage` / `watchdogHasNoInflightWork` / `classifyWatchdogTargets` /
//   `watchdogDigestActionable` / `watchdogDigestSignature` / `digestSilenceOf` / `renderWatchdogDigest` /
//   `renderIdleAlert` / `bucketOf` / `renderPressureAlert` / `readSessionSurface`；实测 22,329 字节）。
//   **为什么这一单不搬它们**：① 整族（上述 21 个声明 + 本函数）实测 65,681 字节，一并搬走会让本档 ≈ 68 KB，
//   越过本小单 60 KB 的档位上限；② 其中 12 个名字由入口的 `__testing` **直接开放**给判据
//   （`buildWatchdogRegistration` / `planAutoWatchdog` / `summarizeAutoWatchdogs` / `chainReportLine` /
//   `armTeamWatchdog` / `tickMessage` / `classifyWatchdogTargets` / `watchdogDigestActionable` /
//   `renderWatchdogDigest` / `renderIdleAlert` / `bucketOf` / `renderPressureAlert`），另有 3 个经
//   `registrationExtras()` 注入 `lib/registration.js`（`buildWatchdogRegistration` /
//   `ensureTeamAutoWatchdogs` / `chainReportLine`）⇒ 它们属于「工具注册 / 状态卡」的读面，等那一族整体
//   成档时再走。
// ★ 依赖方向（Rr4「模块图无环」的实测口径）：本档**不导入入口** `lib/index.js`（那会构成 ESM 环，实跑
//   当场 TDZ）—— 出边只有两类，且**都不回指入口或本档**（本单**不新增环**；全图既有的环见报告）：
//   ① 内部相对导入（既有域档）：`./shared.js`（`describeError` —— 六处 warn 的单行报错文本）与
//      `./sections.js`（`readSessionUsage` —— 工作台摘要与压力告警读收件人自己的窗口），共 **2 条**；
//   ② **装配缝注入**（先例：`lib/forensics.js` 的 `wireForensics()`、`lib/registration.js` 的
//      `wireRegistration(extras)`）：入口侧 27 条出口由 `wireWatchdog(extras)` 在模块求值时一次性绑定到
//      本档的同名模块级 `let` 上 —— 绑定与搬迁前**逐个同一** ⇒ 行为逐字不变。逐条归属见入口的
//      `watchdogExtras()`（五组：看门狗常量 · 活性读数 · 巡检助手 · 摘要与两档告警 · 投递与读数面）。
// ★ 本档**零宿主导入**（那 8 条白名单一条都没用到）⇒ `Rr3` 的宿主说明符集合读数一字不变。
// ★ 被钉符号核对（本仓 `hostSource` 文本锁钉住的 9 个：`writePolicyFileAtomic` / `renameThroughSeam` /
//   `POLICY_FILE_SCHEMA` / `WATCHDOG_DIGEST_DEBOUNCE_MS` / `TICKABLE_VERDICTS` / `agentStateLabel` /
//   `writerGate` / `relayUserMessage` / `buildTeamSessionCreateOptions`）：**本单一个都没搬**，九个仍逐字节
//   住在入口；其中 **3 个**是本函数的依赖（`WATCHDOG_DIGEST_DEBOUNCE_MS` / `TICKABLE_VERDICTS` /
//   `relayUserMessage`）⇒ **只经缝注入**（定义、文档注释与锚点切片位置一字不动 ⇒ 那几条源码锁读数不变）。
// ★ 搬运纪律（D4）：本档新增的只有 ① 本段档头 ② 2 条 import 语句 ③ 装配缝 ④ 声明行上的 `export ` 前缀；
//   函数体（含全部行内注释与那 22 条内部函数）**一个字符都没动**。
// ---------------------------------------------------------------------------

import { describeError } from "./shared.js";
import { readSessionUsage } from "./sections.js";

// ---------------------------------------------------------------------------
// 装配缝 · `wireWatchdog(extras)`（先例：`lib/forensics.js` 的 `wireForensics()`）
// ---------------------------------------------------------------------------
// 前置：入口在**模块求值**时调用一次（`lib/index.js` 模块尾部，紧挨 `wireMessaging(…)`），给出的 27 个键
//       与被注入的绑定**同名同值**。
// 后置：本档的模块级 `let` 全部绑定到入口那一份真实现；此后每次巡逻 / 投递 / 读数读到的都是它。
// 为什么不是 import：见档头「依赖方向」②（入口 → 域档会成环）。
// 为什么是一次性绑定而不是每次调用现取：控制器是长活对象（定时器回调跨回合），绑一次就够；而且
// `createWatchdog` 体内那几条裸名**逐字节保留**（只在函数体外加了这一个缝），D4 的逐字节等价可以直接机检。
// ---------------------------------------------------------------------------
let PLUGIN_LABEL, PATROL_SWEEP_MIN_INTERVAL_MS, WATCHDOG_DIGEST_DEBOUNCE_MS, WATCHDOG_ORIGIN_AUTO, WATCHDOG_TICK_ID_PREFIX, WATCHDOG_RENEW_WINDOW_MS, IDLE_ALERT_MAX_PER_EPISODE, LIAISON_PRESSURE_WARN_PERCENT, LV_RUN_MIN, TICKABLE_VERDICTS, lastActivityOf, buildLivenessSignal, readGoalSignal, classifyWatchdogTargets, planAutoWatchdog, autoWatchdogRosterGate, ensureTeamAutoWatchdogs, watchdogDigestActionable, watchdogDigestSignature, renderWatchdogDigest, renderIdleAlert, bucketOf, renderPressureAlert, digestFooters, tickMessage, relayUserMessage, readSessionSurface, isIncumbentCoordinator;

/** 入口侧出口的一次性绑定（见本节档头的前置 / 后置）。 */
export function wireWatchdog(extras) {
	({
		PLUGIN_LABEL,
		PATROL_SWEEP_MIN_INTERVAL_MS,
		WATCHDOG_DIGEST_DEBOUNCE_MS,
		WATCHDOG_ORIGIN_AUTO,
		WATCHDOG_TICK_ID_PREFIX,
		WATCHDOG_RENEW_WINDOW_MS,
		IDLE_ALERT_MAX_PER_EPISODE,
		LIAISON_PRESSURE_WARN_PERCENT,
		LV_RUN_MIN,
		TICKABLE_VERDICTS,
		lastActivityOf,
		buildLivenessSignal,
		readGoalSignal,
		classifyWatchdogTargets,
		planAutoWatchdog,
		autoWatchdogRosterGate,
		ensureTeamAutoWatchdogs,
		watchdogDigestActionable,
		watchdogDigestSignature,
		renderWatchdogDigest,
		renderIdleAlert,
		bucketOf,
		renderPressureAlert,
		digestFooters,
		tickMessage,
		relayUserMessage,
		readSessionSurface,
		isIncumbentCoordinator,
	} = extras);
}

/**
 * Cross-session watchdog controller (§3.2.3). One interval timer per
 * registration at its `intervalMinutes` granularity, plus two process-local
 * maps: the per-target tick debounce and the watcher-dead marks. §3.2.4 is
 * explicit that neither is persisted — a restart forgets them, which may cost
 * one extra tick and never resurrects a stale "already handled" state.
 */
export function createWatchdog(ctx, policy, rotation, sections = undefined, forensics = undefined) {
	const timers = new Map();
	const ticked = new Map();
	const deadWatchers = new Map();
	/**
	 * FR-3b (E1) 的判据面：上一次巡逻看到的 agent 状态（键 `注册×目标`）。进程内、不落盘
	 * —— 与 `ticked`/`deadWatchers` 同一条取舍（重启即忘 ⇒ 首轮没有 previous，于是不会凭空
	 * 报一次「刚转空闲」）。
	 */
	const lastAgentState = new Map();
	/**
	 * FR-3b 的摘要去抖：每条注册最近一次**投出去**的摘要 `{ at, signature }`。签名变了才允许
	 * 下一条 —— 光有时间窗不足以防噪（一条常驻的「有人闲着」会变成每 10 分钟一次的打扰）。
	 */
	const digested = new Map();
	/**
	 * ★ 批 J · FR-J1（设计档 §5 FR-J1 · §7）：**「有活没派」告警档自己的去抖与限量**
	 * —— `entry.id -> { at, signature, count }`。与 `digested` 同姿态（进程内、不落盘，
	 * 重启即忘），但**各记各的**：两档共用一份指纹就等于互相抑制（§4 D2 否决项）。
	 * ★ **已知边界（设计档 §9「同 team ＋ 同 watcherSession 的重复注册行」）**：记账键是 `entry.id`
	 * ⇒ 盘上若**手工**造出同 `team` ＋ 同 `watcherSession` 的两条注册行，同一轮可能各投一条**近似**告警
	 * （各自按自己的 `entry.id` 享满 {@link IDLE_ALERT_MAX_PER_EPISODE}）。该形态**工具面造不出**
	 * （`team_link_watch register` 不带 `team`）、噪声有界 ⇒ 本批取「如实记档、维持现状」；将来要收口
	 * 就把键改成 `team + watcherSession`（语义变更，另行立批）。
	 */
	const idleAlerted = new Map();
	/**
	 * ★ 批 J · FR-J2（设计档 §5 FR-J2 · §7）：**协调者自身压力告警自己的去抖与档位**
	 * —— `entry.id -> { at, bucket }`。与 `idleAlerted` / `digested` 同姿态（进程内、不落盘，
	 * 重启即忘），也**各记各的**：压力告警讲的是收件人自己的窗口，与摘要和目标行都无关，
	 * 共用任何一份指纹都只会互相抑制。
	 * ★ **已知边界（设计档 §9「同 team ＋ 同 watcherSession 的重复注册行」）**：与 `idleAlerted`
	 * 同一条 —— 记账键是 `entry.id` ⇒ 手工造出的重复行在同一轮可能各投一条近似告警、各记各的档位；
	 * 工具面造不出该形态、噪声有界 ⇒ 维持现状（同上：要收口就把键改成 `team + watcherSession`）。
	 */
	const pressureAlerted = new Map();
	let disposed = false;

	function stopTimer(id) {
		const timer = timers.get(id);
		if (timer === undefined) return;
		clearInterval(timer);
		timers.delete(id);
	}

	/** Drop every process-local trace of one registration. */
	function forget(id) {
		for (const key of [...ticked.keys()]) if (key.startsWith(`${id}\n`)) ticked.delete(key);
		for (const key of [...lastAgentState.keys()]) if (key.startsWith(`${id}\n`)) lastAgentState.delete(key);
		deadWatchers.delete(id);
		digested.delete(id);
		idleAlerted.delete(id);
		pressureAlerted.delete(id);
	}

	/**
	 * ★ FR-K5 ③（设计档 §5 FR-K5 ③ · §9「注册中途归零」；交付评审 🟡#1 的第二半）：
	 * **「最后一条注册消失」的那一刻，兜底心跳必须重新挂上**。
	 *
	 * 治的是什么：{@link schedule} 是**按注册**建定时器的，而 {@link patrolBeat} 一跑就
	 * `disarmForensicsFallback()`（「巡逻在跑」**等价于**「存在注册」）。于是「activation 时挂兜底」
	 * 只挡住了**零注册启动**那一半：最后一条注册被 `removeWatchdog` / `cancel`（clear 工具）/
	 * TTL 自清扫收掉之后，`timers` 归零、巡逻从此不会再来，心跳就**静默冻结在删注册之前那一拍**
	 * —— 那与「启动时零注册」是**同一种失效**，只是换了个入口。
	 *
	 * 三条纪律：
	 *   · **幂等**：已挂 ⇒ {@link armForensicsFallback} 自带 `fallbackTimer !== null` 门 ⇒
	 *     返回 `false`、**不产生第二个定时器**（U14 ③）；
	 *   · **不双写**：`timers` 非空 ⇒ 巡逻会写，兜底**不许**顶上来（与 U12② 同一条口径）；
	 *   · ★ **「没有定时器」还不等于「巡逻不会再来」**：一条注册可以被**不经过 `schedule`** 的路径
	 *     种进 policy（判据夹具正是这样种的：`ns.data.watchdogs = [...]` 之后巡逻照跑）⇒ 那时也
	 *     **不挂**。两个方向的代价不对称：不该挂却挂了 ⇒ 当场变成 U12② 的双写；该挂而没挂 ⇒
	 *     由下一次 `rearm()`（attach 与每次收注册后都跑）补上。故谓词 = 「**既没有定时器、
	 *     也没有任何注册行**」。
	 * @returns 本次**真的**挂上了才 `true`（判据读它，不从文案反推）。
	 */
	function syncForensicsFallback() {
		if (timers.size > 0) return false;
		let rows = null;
		try {
			rows = policy.get().watchdogs;
		} catch {
			rows = null;                             // 读不到名册 ⇒ 按「没有注册」处理（错法只许是「多写几拍」）
		}
		if (Array.isArray(rows) && rows.length > 0) return false;
		return forensics?.armForensicsFallback?.() === true;
	}

	/** (Re)arm the patrol timer of one registration. */
	function schedule(entry) {
		if (disposed) return;
		stopTimer(entry.id);
		const timer = setInterval(() => {
			void patrol({ id: entry.id }).catch((error) => {
				ctx.logger?.warn?.(`${PLUGIN_LABEL}: watchdog patrol failed: ${describeError(error)}`);
			});
		}, entry.intervalMinutes * 60000);
		// A patrol timer is background housekeeping: it must never hold the shell open.
		timer.unref?.();
		timers.set(entry.id, timer);
	}

	/** Drop one registration and its timer (clear tool, TTL self-clean). */
	async function removeWatchdog(id) {
		stopTimer(id);
		forget(id);
		const current = policy.get().watchdogs;
		if (!current.some((entry) => entry.id === id)) {
			// ★ FR-K5 ③：这条**提前返回**也是一条「最后一条注册消失」的路径（定时器刚停、policy 里
			//   本就没有它）⇒ 同样复核一次兜底（幂等，不会产生第二个定时器）。
			syncForensicsFallback();
			return;
		}
		try {
			await policy.update({ watchdogs: current.filter((entry) => entry.id !== id) });
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: watchdog ${id} could not be removed: ${describeError(error)}`);
		}
		// ★ t-14 A（评审 #2 🟡 · 真行为缺陷）：收掉一条之后**幂等地 rearm 一次**。
		// 机理：一条注册的定时器回调是 `patrol({ id: entry.id })`（**单条**巡逻），而 rearm 在
		// 「一条活的都没有」时只给**最新那条过期行**挂清扫专用定时器。于是多条全过期时：那条
		// 最新行被收掉 ⇒ 它的定时器一并 stopTimer ⇒ 其余过期行**从此没有任何定时器**，不 rearm /
		// 不重挂就永远躺在 policy 里。在这里补一次 rearm ⇒ 下一条过期行接棒，清扫持续推进到空。
		// （幂等：schedule 先 stopTimer 再重建；没有条目可挂时它就是一次空跑。）
		rearm();
		// ★ FR-K5 ③：`rearm()` 之后「还剩几条注册」才是最终形态 ⇒ 在它**后面**复核兜底。
		//   收掉的若是**最后一条**注册，这里把兜底心跳重新挂上（否则巡检与心跳一起静默冻结）。
		syncForensicsFallback();
	}

	/**
	 * Already ticked for this target's current silent period? The watermark is the
	 * target's last observed activity (§3.1's two timestamps): unchanged since the
	 * last tick means nothing happened in between, so the same silence is still
	 * being reported and a second tick would be noise. It also covers targets
	 * whose silence cannot be measured at all (a gone agent has no activity
	 * watermark either, so it is ticked once and not on every patrol).
	 *
	 * A watermark that DID advance is a new silence period, but the patrol also
	 * waits out one interval before reporting it — the "去抖间隔" of §3.2.4, so a
	 * burst of activity cannot produce a burst of ticks.
	 */
	function recentlyTicked(id, target, signal, intervalMinutes, now) {
		const last = ticked.get(`${id}\n${target}`);
		if (last === undefined) return false;
		if (last.activity === lastActivityOf(signal)) return true;
		return now - last.at < intervalMinutes * 60000;
	}

	function markTicked(id, target, signal, now) {
		ticked.set(`${id}\n${target}`, { at: now, activity: lastActivityOf(signal), silenceMs: signal.silenceMs });
	}

	/**
	 * ★ 批 U（2026-10-23 用户反馈）: 投递唤醒策略 —— 提醒**不许**把会话拖进「每拍一个新回合、
	 * 每回合都失败」的错误循环。
	 *
	 * 宿主语义（实读 asar）: `followup` = `send(..., "next-turn", true)` **唤醒一个新回合**；
	 * `inject` = `send(..., "next-step", false)` **只进收件箱、不唤醒**。两条出口：
	 *   ① 注册上的 `wake:false` ⇒ 一律 inject（用户显式要求「只提醒、别拉回合」）；
	 *   ② 观察者**上一拍 tick 没有 assistant 回复**（surface 里末条 `slp-wd-` 之后没有
	 *      assistant/message）⇒ 判定「它可能起不来了」，本拍降级 inject 并留一行 warn，
	 *      不再反复拉起一个必然失败的新回合。证据不足（surface 读不到）一律**不降级**。
	 */
	function deliverToWatcher(watcher, wake, message) {
		if (wake === false) watcher.inject(message);
		else watcher.followup(message);
	}

	/** 本拍是否**真的**要投东西给观察者（决定要不要多读一次它自己的 surface）。 */
	function patrolWouldDeliver(entry, rows, suppressed, workbench, now) {
		if (workbench) return true;
		if (suppressed) return false;
		return rows.some((row) => TICKABLE_VERDICTS.has(row.signal.verdict)
			&& !recentlyTicked(entry.id, row.target, row.signal, entry.intervalMinutes, now));
	}

	/**
	 * The watcher's surface still tails a watchdog tick with no assistant reply after it —
	 * the cheapest reliable signal that the last wake did not finish a turn (model 400 /
	 * crash / stuck). A surface read failure means "no evidence" and must NOT downgrade.
	 */
	async function lastWatchdogTickUnanswered(sessionId) {
		const surface = await readSessionSurface(ctx, sessionId);
		const events = Array.isArray(surface?.events) ? surface.events : [];
		let lastTick = -1;
		for (let index = 0; index < events.length; index += 1) {
			const event = events[index];
			if (event?.type !== "user/message") continue;
			const id = event.data?.id;
			if (typeof id === "string" && id.startsWith(WATCHDOG_TICK_ID_PREFIX)) lastTick = index;
		}
		if (lastTick === -1) return false;
		for (let index = lastTick + 1; index < events.length; index += 1) {
			if (events[index]?.type === "assistant/message") return false;
		}
		return true;
	}

	/**
	 * Watcher agent gone: mark the signal face and leave the registration alone
	 * (A4 — nothing can wake a closed session; the tick has nowhere to land).
	 * The mark is process-local, so if the watcher comes back inside the TTL the
	 * patrol simply resumes delivering.
	 *
	 * ★ 批 G（FR-R5 · 设计档 §10.2 · §4 D3）改口径：「保留至 TTL」是**批 G 之前**的读法 —— 那时
	 * 12 小时 TTL 是**健康团队的死线**（连续开机满 12h，工作台摘要静默熄灭，正是用户原始投诉）。
	 * 命中 FR-R1 的**续期**之后，auto 那一档的注册**保留至名册有效期内**（团队在场 ∧ watcher 仍是
	 * 现任 ∧ 仍有可盯成员 ⇒ 巡逻会顺延它的租约），**名册失效时由 TTL 收尸**（团队已删 / 已换人 /
	 * 已退役 ⇒ 名册门拒绝续期 ⇒ 照旧到期自清）。
	 * 所以「观察者死了」这件事**不再是**注册的死因（D3 的 2:1 裁定：工作台摘要是**团队资产**，
	 * 不是那个会话窗口的属性；而「死观察者不做投递」由本函数与 `patrolOne` 的早退门照旧压住）。
	 * 原文锚（迁移留名）：`keeping the registration until its TTL`。
	 */
	function markWatcherDead(id, now) {
		if (deadWatchers.has(id)) return;
		deadWatchers.set(id, now);
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: watchdog ${id} observer session is not live; keeping the registration while its roster basis holds (TTL reclaims it once that basis is gone)`);
	}

	/**
	 * Read one patrol's target rows: every target's signal plus the agent state the PREVIOUS
	 * patrol recorded (E1's `previous`). Exactly one surface read per target per patrol — the
	 * two channels (alarm tick + workbench digest) share this pass, so FR-3b adds no new read
	 * cost to a registration that was already being patrolled.
	 */
	async function readTargetRows(entry, now) {
		const rows = [];
		for (const target of entry.targets) {
			const targetAgent = ctx.agents.get(target);
			const surface = targetAgent === undefined ? undefined : await readSessionSurface(ctx, target);
			const signal = buildLivenessSignal(ctx, target, {
				now,
				agent: targetAgent,
				surface,
				silentMin: entry.silentMinutes,
				runMin: LV_RUN_MIN,
			});
			rows.push({ target, signal, previous: lastAgentState.get(`${entry.id}\n${target}`) });
		}
		return rows;
	}

	/** Record this patrol's agent states — they are the next patrol's `previous` (E1). */
	function rememberAgentStates(entry, rows) {
		for (const row of rows) lastAgentState.set(`${entry.id}\n${row.target}`, row.signal.agent === "running" ? "running" : "idle");
	}

	/** A1: an armed-active watcher has a cadence of its own — the ALARM channel stays quiet. */
	function watcherArmedActive(entry, watcher) {
		const watcherGoal = readGoalSignal(ctx, entry.watcherSession, watcher);
		return watcherGoal !== null && watcherGoal.phase === "active" && watcherGoal.activation === "armed";
	}

	/**
	 * FR-3b: at most one digest per registration, and only when it has something to say
	 * (§4.6). Two gates, ANDed:
	 *
	 * - the debounce window ({@link WATCHDOG_DIGEST_DEBOUNCE_MS}): two digests of the same
	 *   registration are never closer than that;
	 * - the state SIGNATURE: a state that has already been reported is not reported again.
	 *   The window alone is not enough — an entry whose team simply sits idle would then emit
	 *   a digest every ten minutes for its whole TTL, which is exactly the noise U9 forbids.
	 *
	 * A failed delivery is logged and NOT retried inside this patrol (it sets the window but
	 * clears the signature, so the next patrol window may try the still-actionable state
	 * again). Called only for `origin:"auto"` entries: the manual arm keeps its audited
	 * behaviour byte for byte (consult #26 D3).
	 */
	function deliverDigest(entry, watcher, rows, now, wake = true) {
		const groups = classifyWatchdogTargets(rows);
		if (!watchdogDigestActionable(groups)) return;
		const signature = watchdogDigestSignature(groups);
		const last = digested.get(entry.id);
		if (last !== undefined && now - last.at < WATCHDOG_DIGEST_DEBOUNCE_MS) return;
		if (last !== undefined && last.signature === signature) return;
		try {
			// FR-9/FR-4: 脚注两行（各自受开关管）——资源行（resources=true）+ 角色重钉（role=true 且
			// 观察者是该队现任协调者）。两者都是纯读，不进 digest 自身的分组正文。
			const footers = digestFooters(ctx, policy, entry, watcher);
			deliverToWatcher(watcher, wake, relayUserMessage(renderWatchdogDigest(entry, groups, now, footers), entry.watcherSession));
			digested.set(entry.id, { at: now, signature });
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: watchdog digest to ${entry.watcherSession} failed: ${describeError(error)}`);
			digested.set(entry.id, { at: now, signature: null });
		}
	}

	/**
	 * ★ 批 J · FR-J1：**「有活没派」独立告警档**（设计档 §5 FR-J1 · §6 机制伪代码 · §9 边界）。
	 *
	 * 治的是什么（需求档 §2.1 的真机读数）：`bac-1009` 的三个队员**全部空闲**，协调者却在自己做
	 * 记账与文档；而「空闲待派」今天只是**摘要里的一行散文**，还被「有可行动内容才投」+ 指纹去重
	 * 两道门压着 ⇒ 最该刺眼的形态与「刚转空闲」同一档处理。本档把它提成**自己的通道**：自己的
	 * 去抖、自己的指纹、自己的限量（{@link IDLE_ALERT_MAX_PER_EPISODE}）。
	 *
	 * **前置**：`rows` 是本轮巡逻读到的目标行（`{target, signal, previous}`）；`now` 是注入时钟；
	 * `entry.watcherSession` 是一个活代理（`patrolOne` 的 watcher 门已过）。
	 * **后置**：恰在触发条件成立且不触门时**投递一条**并推进本档状态；否则**零投递**。
	 * **不抛**：投递失败只留一行 warn（与 {@link deliverDigest} 同一姿态，设计档 §9 失败方向 =
	 * fail-open）—— 绝不让巡逻崩。
	 *
	 * 四道门（顺序即设计档 §6 的伪代码）：
	 *   ① **角色门**（设计档 §10-3）：只有该队的**现任协调者**收这条 —— 派工是它的活，别的会话收到
	 *      只是噪音（且它也无权派工）；
	 *   ② 无空闲成员 ⇒ 零投递（无人可派，本来也没什么可说）；
	 *   ③ **有人在跑 ⇒ 不是「有活没派」** ⇒ 零投递，并把本档状态**删掉**（＝重置这一段，设计档
	 *      §10-4：条件由真转假再转真 ⇒ 新一段，重新可投）；
	 *   ④ 去抖 + 限量：同一签名 10 分钟内不重复（{@link WATCHDOG_DIGEST_DEBOUNCE_MS}）；窗口外
	 *      **可复投**但同一签名至多 {@link IDLE_ALERT_MAX_PER_EPISODE} 次，签名一变即重置计数。
	 */
	function deliverIdleAlert(entry, watcher, rows, now, wake = true) {
		if (!isIncumbentCoordinator(policy.get(), entry.team, entry.watcherSession)) return;   // ①
		const groups = classifyWatchdogTargets(rows);                                          // 既有分类器，不复制
		if (groups.idleAwait.length === 0) return;                                             // ②
		if (groups.running.length > 0) {                                                       // ③
			idleAlerted.delete(entry.id);
			return;
		}
		const signature = groups.idleAwait.map((row) => row.target).join(",");
		const last = idleAlerted.get(entry.id);
		if (last !== undefined && last.signature === signature) {                              // ④
			if (now - last.at < WATCHDOG_DIGEST_DEBOUNCE_MS) return;                            // 窗口内 ⇒ 零投递
			if (last.count >= IDLE_ALERT_MAX_PER_EPISODE) return;                               // 本段已投满 ⇒ 等签名变化
		}
		const count = last !== undefined && last.signature === signature ? last.count + 1 : 1;  // 签名一变 ⇒ 重置为 1
		try {
			deliverToWatcher(watcher, wake, relayUserMessage(renderIdleAlert(entry, groups, now), entry.watcherSession));
			idleAlerted.set(entry.id, { at: now, signature, count });
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: watchdog idle alert to ${entry.watcherSession} failed: ${describeError(error)}`);
			// fail-open 的**状态取舍**（设计档 §9 只规定「只留一行 warn」，未规定状态）：窗口照记、
			// **计数不推进**（一次失败的投递不是一次投递，不该吃掉本段的 3 次额度），且**保留签名**
			// ⇒ 失败的同一段在窗口内不会每轮重试刷 warn，窗口外照旧可再试（与 `deliverDigest` 那条
			// 「记窗口、允许下个窗口再试」同一取舍，差别只在签名不置空）。
			idleAlerted.set(entry.id, { at: now, signature, count: last !== undefined && last.signature === signature ? last.count : 0 });
		}
	}

	/**
	 * ★ 批 J · FR-J2：**协调者自身上下文压力告警**（设计档 §5 FR-J2 · §6 机制伪代码 · §9 边界 ·
	 * §10-1/§10-7）。
	 *
	 * 治的是什么（需求档 §2.2 根因 2）：资源行今天只把「压力」渲染成一个冷冰冰的百分比
	 * （{@link renderResourceLine}），**没有任何阈值告警** —— 于是「为了看队员在不在干活去读队员的
	 * 会话、把对方窗口装进自己窗口」这件事**没有任何东西拦它**。本档把「你自己的窗口快满了」变成
	 * 一条**点名后果**的消息（{@link renderPressureAlert}）。
	 *
	 * **前置**：`entry.watcherSession` 是一个活代理（`patrolOne` 的 watcher 门已过）；`now` 是注入时钟。
	 * **后置**：恰在「是现任协调者 ∧ 压力读数可读 ∧ ≥ 阈值 ∧ 过了去抖 ∧ 档位比上次投出去的更大」时
	 * **投递一条**并推进本档状态；否则**零投递**（纯读，无副作用）。
	 * **不抛**：投影读失败与投递失败**各只留一行 warn**（与 {@link deliverDigest} 同一姿态，设计档 §9
	 * 失败方向 = fail-open）—— 绝不让巡逻崩。
	 *
	 * 六道门（顺序即设计档 §6 的伪代码 ＋ §10 的折入）：
	 *   ① **角色门**（设计档 §6「★ 只发给现任协调者」＋ U4）：这条讲的是「**你的**窗口」，
	 *      发给别的会话既不对题也无从行动（需求档 US-J2 的收件人就是协调者）；
	 *   ② **读数门**（设计档 §9「读不到压力投影」）：`percent` 读不出来 ⇒ **不说** ——
	 *      **绝不编造一个百分比**（与资源行「绝不编数」同一条既有口径）；
	 *   ③ **阈值门**：`percent >= LIAISON_PRESSURE_WARN_PERCENT`（★ 用户裁定 = 50，设计档 §10-1）；
	 *   ④ **去抖窗**（{@link WATCHDOG_DIGEST_DEBOUNCE_MS}）：两条压力告警至少隔这么久；
	 *   ⑤ **上升沿**（设计档 §10-7 🔵）：只在**档位变大**时才再告警 —— 同一档（每 10%，见
	 *      {@link bucketOf}）不重复，且**档位回落后再回到同档也不重投**（跨档振荡 59↔61 不打扰）；
	 *   ⑥ 投递：正文过 `wellFormed`（NF-J3 的反走私不变式）。
	 *
	 * 读侧用的是 {@link readSessionUsage}（**对象**读数，`.percent` 在这里）—— 设计档 §6 伪代码
	 * 写的 `renderResourceContext(...).percent` 是**形状写错**：那个函数返回的是**渲染好的字符串**
	 * （`lib/index.js` 的 `renderResourceContext` → `wellFormed(renderResourceLine(...))`）；同一条
	 * 投影路径的**对象**出口是 `readSessionUsage`。§10-9 要求的「实施首步确认形状」结论即此。
	 */
	function deliverPressureAlert(entry, watcher, now, wake = true) {
		if (!isIncumbentCoordinator(policy.get(), entry.team, entry.watcherSession)) return;   // ①
		let reading;
		try {
			reading = readSessionUsage(ctx, entry.watcherSession);                              // ②
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: watchdog pressure reading for ${entry.watcherSession} failed: ${describeError(error)}`);
			return;
		}
		if (typeof reading?.percent !== "number" || !Number.isFinite(reading.percent)) return; // ② 读不到 ⇒ 不说
		if (reading.percent < LIAISON_PRESSURE_WARN_PERCENT) return;                            // ③
		const bucket = bucketOf(reading.percent);                                               // 档位（每 10% 一档，判据见 ⑤）
		const last = pressureAlerted.get(entry.id);
		if (last !== undefined && now - last.at < WATCHDOG_DIGEST_DEBOUNCE_MS) return;          // ④
		if (last !== undefined && bucket <= last.bucket) return;                                // ⑤ 上升沿
		try {                                                                                   // ⑥ 投递
			deliverToWatcher(watcher, wake, relayUserMessage(renderPressureAlert(reading, now), entry.watcherSession));
			pressureAlerted.set(entry.id, { at: now, bucket });
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: watchdog pressure alert to ${entry.watcherSession} failed: ${describeError(error)}`);
			// fail-open 的**状态取舍**（设计档 §9 只规定「只留一行 warn」，与 {@link deliverIdleAlert}
			// 同一取舍）：窗口照记（失败的同一档在窗口内不会每轮重试刷 warn），但**档位不推进**
			// （一次失败的投递不是一次投递）⇒ 窗口外同一档照旧可再试、档位变大也照旧会响。
			pressureAlerted.set(entry.id, { at: now, bucket: last !== undefined ? last.bucket : -1 });
		}
	}

	/**
	 * ★ 批 G · FR-R1：auto 工作台注册的**续期判定**（设计档 §5 FR-R1 · §6 机制伪代码）。
	 *
	 * **位置**（交付修复轮：`ReferenceError: policy is not defined`）：它与它的唯一调用方
	 * `patrolOne` 同处 `createWatchdog(ctx, policy, rotation, sections)` 的**函数体**内 ——
	 * 它引用的 `policy` 是该闭包的形参、`rearm` 是同体的函数声明，移到模块级就会双双失联。
	 *
	 * **前置**：① 调用方（`patrolOne`）必须**先过** `entry.origin === WATCHDOG_ORIGIN_AUTO` 门 ——
	 * manual 行根本不进本函数（它是用户的意志，TTL 逐字节旧行为）；② `entry` 是本轮巡逻的**目标条目**
	 * （**不是**快照里的旧对象 —— 见 §4 D1 否决的「外层预扫全表」）；③ `now` 是注入时钟。
	 *
	 * **后置**：返回 `true` ⇒ 该条目的 `expiresAt` / `targets` / `renewedAt` 已落盘、定时器已重排
	 * （调用方应立即 `return`，不再回落删除门）；返回 `false` ⇒ **一个字节都没写**（调用方继续走既有路径）。
	 *
	 * 六道门与窗口（逐条对应设计档 §5 FR-R1、§6、§8 U1–U5/U9/U10/U12）：
	 *   ① 名册门（共享 helper）—— 团队在场 ∧ watcher 仍是现任 ∧ 非空 targets；
	 *   ② `planAutoWatchdog` 的 `error` ⇒ 不续（让它死；与建队时的拒绝同一语义）；
	 *   ③ `planned.created === true` ⇒ 不续 —— **只 refresh，不 resurrect**：并发清理窗口里条目刚被
	 *      别人收掉时，巡逻里凭空复活它是意外行为（`map`-by-id 本就写不到，这里把它显式化）；
	 *      ③′ 同一姿态的另一半（**重复行夹缝**）：`planned.entry.id !== entry.id` ⇒ 不续 —— 盘上同
	 *      watcher+team 的重复 auto 行（设置 UI 直改）会让 `existing` 不是本条目、写盘带进 `existing.id`
	 *      ⇒ 表内重复 id；正常路径由 `(watcherSession, team)` 幂等键保证两者相等（恒真、零行为变化）；
	 *   ④ **窗口**（{@link WATCHDOG_RENEW_WINDOW_MS}）—— `now > entry.expiresAt` ⇒ 不续（**不复活已过期行**）；
	 *      未进入窗口 ⇒ 什么都不做（U3 的写频：窗口内连巡逻两次，第二次零写）；
	 *   ⑤ `policy.update` 抛错 ⇒ 静默返回 `false`（**fail-open**：保留旧 `expiresAt`、巡逻不崩、
	 *      退化成今天的行为 —— 到期自清，下个 tick 仍会重试；**不引入新死法**）；
	 *   ⑥ 写盘成功后**必调** `rearm()`（设计档 §4 D5）—— 既把续出来的行排上自己的定时器
	 *      （`schedule` 先 `stopTimer` 同 id，不产生双定时器），又给同队「该合法死掉」的过期行
	 *      **接回清扫链**（否则它们永远没人碰）。
	 *
	 * **保留身份字段**：`id`（`planAutoWatchdog` 从 `existing` 展开即保留）与 `createdAt`（本函数显式
	 * 覆盖回原值，D7）；`renewedAt = now`（FR-R4 的留痕，D8）。
	 */
	async function renewAutoRowIfStillValid(entry, now) {
		// ① 名册门 —— 与 `ensureTeamAutoWatchdogs` 调的是**同一个**函数（共享 helper，不复制两份）。
		const gate = autoWatchdogRosterGate(policy.get().teams, entry.team, entry.watcherSession);
		if (gate.error !== undefined) return false;
		const planned = planAutoWatchdog(policy.get().watchdogs, { watcherSession: entry.watcherSession, team: entry.team, targets: gate.members, now });
		if (planned.error !== undefined) return false;   // ② 队缩到无可盯成员 ⇒ 让它死
		if (planned.created === true) return false;      // ③ 只 refresh，不 resurrect
		// ③′ 「重复行夹缝」守卫（与 ③ 同一姿态：只 refresh 不 resurrect）。防的是：`planAutoWatchdog`
		//   按 `(origin, watcher, team)` 匹配出的 `existing` **未必是本条目** —— 盘上若经**设置 UI 直改**
		//   （本仓把它当真实输入面）出现同 watcher+team 的**两条** auto 行，则 `existing.id !== entry.id`，
		//   而下面 `map`-by-id 的写盘会把 `entry.id` 那一行替换成**携带 `existing.id`** 的行 ⇒
		//   **表内出现重复 id、旧行滞留**，定时器 Map（按 id 键）亦受扰。正常路径由 `(watcherSession, team)`
		//   幂等键保证 `existing` 就是本条目（此守卫恒真、行为零变化）；真撞上时不写、让下个 tick 重判。
		if (planned.entry.id !== entry.id) return false;
		// ④ 窗口：到期前 WATCHDOG_RENEW_WINDOW_MS 内才写；已过期（now > expiresAt）一律不碰。
		if (now > entry.expiresAt || entry.expiresAt - now > WATCHDOG_RENEW_WINDOW_MS) return false;
		const next = { ...planned.entry, createdAt: entry.createdAt, renewedAt: now };
		try {
			await policy.update({ watchdogs: policy.get().watchdogs.map((row) => (row.id === entry.id ? next : row)) });
		} catch {
			return false;                                  // ⑤ fail-open：下个 tick 重试
		}
		rearm();                                           // ⑥ D5：挂表 + 接回清扫链
		return true;
	}

	/**
	 * One pass for one registration (§3.2.3, line by line): an expired
	 * registration self-cleans FIRST — ahead of every watcher gate, so a watcher
	 * that is gone, running or armed-active can never keep an expired row (and its
	 * empty timer) alive (§3.2.3 TTL 自清【最先】, audit D1); then missing watcher →
	 * mark the signal face and stop; running watcher → never interrupt; armed-active
	 * watcher → it has its own cadence (A1); then per target: skip every verdict
	 * outside {@link TICKABLE_VERDICTS}, debounce one tick per silent period, and
	 * deliver.
	 *
	 * FR-3b (批 1) extends the tail of that pass with the workbench digest. The two watcher
	 * gates above are the A1 suppression and they keep applying to the ALARM channel only
	 * (D-A1 准: the digest is delivered while the observer is running / armed-active). A
	 * registration that carries no digest (every manual one) therefore still returns before
	 * the first surface read, exactly as before.
	 */
	async function patrolOne(entry, now) {
		// ★ 批 G · FR-R1（设计档 §5 FR-R1 · §6「插入位置（硬约束）」）：**续期判定必须在到期门之前**，
		//   且**只对本条目**判定、续成即 `return`。
		//   为什么必须在这里（三条，逐条对应设计档）：
		//     ① 放到 `now > entry.expiresAt` 之后 ⇒ 行先被 `removeWatchdog` 收掉，续期永远没机会；
		//     ② 放到 `patrol()` 外层做成「预扫全表」⇒ 外层循环迭代的是 `policy.get().watchdogs` 的
		//        **快照**，续期后再碰到旧 `entry` 对象会拿旧 `expiresAt` 走删除门，**把刚续的行删掉**
		//        （§4 D1 否决项）；
		//     ③ 放在 watcher 活性门（`ctx.agents.get` 那一段）**之前**：续期门是**名册真值**，不看进程内
		//        活性（§4 D3 的 2:1 裁定）—— 重启后谁都不 live，协调者窗口关着而机器长开恰恰是原始投诉
		//        的另一半，放在活性门之后就白改了。
		//   manual 行**根本不进**这条分支（用户的意志：TTL 逐字节旧行为，U8 不回归）。
		if (entry.origin === WATCHDOG_ORIGIN_AUTO && await renewAutoRowIfStillValid(entry, now)) return;
		if (now > entry.expiresAt) {
			await removeWatchdog(entry.id);
			return;
		}
		// ★ 批 U（用户反馈）: 静音的注册照常走续期 / TTL 自清，但**零投递**（连目标 surface 都不读）。
		//   `mute` 是 auto 那一条（清不掉的团队工作台注册）唯一可由观察者自己按下的停止键。
		if (typeof entry.mutedUntil === "number" && entry.mutedUntil > now) return;
		const watcher = ctx.agents.get(entry.watcherSession);
		if (watcher === undefined) {
			markWatcherDead(entry.id, now);
			return;
		}
		deadWatchers.delete(entry.id);
		const workbench = entry.origin === WATCHDOG_ORIGIN_AUTO;
		let suppressed = watcher.status === "running";
		if (!suppressed) suppressed = watcherArmedActive(entry, watcher);
		if (suppressed && !workbench) return;
		const rows = await readTargetRows(entry, now);
		// ★ 批 U: 唤醒策略（见 deliverToWatcher / lastWatchdogTickUnanswered）。
		let wake = entry.wake !== false;
		if (wake && patrolWouldDeliver(entry, rows, suppressed, workbench, now) && await lastWatchdogTickUnanswered(entry.watcherSession)) {
			wake = false;
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: watchdog delivery to ${entry.watcherSession} will not wake — its last tick has no assistant reply yet (the session may be failing)`);
		}
		if (!suppressed) {
			for (const row of rows) {
				if (!TICKABLE_VERDICTS.has(row.signal.verdict)) continue;
				if (recentlyTicked(entry.id, row.target, row.signal, entry.intervalMinutes, now)) continue;
				try {
					// ★ 批 D（FR-2 §6.7 · 分歧修复轮）：把注册的 `origin` 带进正文 —— auto 那一档的 tick
					// 不得被教去 `clear`（审计 D1：这一支对两档一视同仁，auto 观察者确实收得到）。
					deliverToWatcher(watcher, wake, tickMessage(entry.watcherSession, row.target, row.signal, now, entry.origin));
					markTicked(entry.id, row.target, row.signal, now);
				} catch (error) {
					ctx.logger?.warn?.(`${PLUGIN_LABEL}: watchdog tick to ${entry.watcherSession} failed: ${describeError(error)}`);
				}
			}
		}
		if (workbench) deliverDigest(entry, watcher, rows, now, wake);
		// ★ 批 J · FR-J1：紧接摘要之后 —— 「有活没派」是**独立的一条**（设计档 §4 D2：不与摘要共用
		//   指纹，所以两者互不抑制；U3 钉的就是这一条）。它自己的第一道门是**角色门**，所以这里
		//   不加 `workbench` 门：手工行若不落在名册上（`team` 为空）当场被角色门挡掉，语义不变。
		deliverIdleAlert(entry, watcher, rows, now, wake);
		// ★ 批 J · FR-J2：与上一条**并列**（设计档 §5 FR-J2：投递在 `patrolOne` 的 watcher 分支）。
		//   它讲的是**收件人自己**的窗口 ⇒ 既不看 `rows`、也不受摘要的指纹影响；`rows` 因此不传
		//   （签名 = `deliverPressureAlert(entry, watcher, now)`，逐字照设计档 §6）。
		deliverPressureAlert(entry, watcher, now, wake);
		rememberAgentStates(entry, rows);
	}

	/**
	 * Run one patrol pass over every registration, or over one explicit id.
	 * `now` is injectable so the TTL and debounce behaviour is testable without
	 * waiting for wall-clock time.
	 */
	async function patrol(options = {}) {
		if (disposed) return;
		const now = typeof options.now === "number" ? options.now : Date.now();
		for (const entry of policy.get().watchdogs) {
			if (options.id !== undefined && entry.id !== options.id) continue;
			await patrolOne(entry, now);
		}
		// ★ 批 G · FR-R3（设计档 §5 FR-R3）：**循环体末尾**的去抖周期 ensure —— 见 {@link runPatrolEnsure}。
		//   放在这里（而不是循环体之前）有两个理由：① 本轮该续的已续、该死的已死，`ensure` 看到的是
		//   收尾之后的名册现实；② 报警 tick 与工作台摘要都已投完，一次慢写推后不了本轮的投递。
		await runPatrolEnsure(now);
		// ★ 批 K · FR-K2（设计档 §5/§6）：**同一轮巡逻的末尾再写一拍崩溃现场心跳**。
		//   与 `runPatrolEnsure` 并列、同一条「一个后台定时器干两件事」的姿态（D4：零新增常驻定时器）。
		//   位置取这里而不是循环体之前：本轮的投递与续期都已落定，一次慢写推后不了任何东西；
		//   而且它是**观测**——`patrolBeat` 自己吞掉一切失败（NF-K4），绝不让心跳的坏天气影响巡逻。
		//   注意本函数是**按注册**被定时器调用的（{@link schedule}），所以「巡逻在跑」本身就等价于
		//   「存在注册」——FR-K5 的兜底定时器正是据此退场。
		await forensics?.patrolBeat?.(now);
		// §3.6.2 评审 #4: the M4 expiry sweep rides this same patrol timer — one
		// background timer for both jobs, and it dies with the plugin. The timer only
		// exists per registration (§3.2.4), so the roster/rotate/team-read lazy calls
		// are what keep a team without a single watchdog from staying frozen.
		// ★ FR-11（批 5）: 每轮巡逻顺带一次**轻量段同步** —— 覆盖「现任协调者晚启动」
		// （此前 sync 只在 attach 与五处名册写入上，代理晚启动没有任何钩子）。纯读名册 + 活代理表；
		// 仅当计划变化才写**进程内**注册表：不写 policy、不碰 team_link_status（只读合同不破）。
		sections?.sync?.();
		await runRotationSweep(now);
		// ★ FR-K5 ③（交付评审 🟡#1 的第二半）：**顺序要紧** —— 上面那一行的 `patrolBeat` 早已把
		//   兜底收掉（它按「巡逻在跑 ⇒ 存在注册」退场），而本轮循环里的 `patrolOne` 可能刚把
		//   **最后一条**注册收掉（TTL 自清扫 / 名册门）⇒ 两条合起来正是设计档 §9「注册中途归零」
		//   那一行：定时器归零、巡逻不会再来。所以在**巡逻的最末尾**复核一次兜底（`timers` 与名册
		//   都空 ⇒ 顶上；幂等，不会产生第二个定时器）。放在 `runRotationSweep` **之后**是要紧的：
		//   这一处读的是本轮**全部**收尾动作之后的 `timers` 形态（后两个动作按实现都不会动定时器，
		//   但判据与实现不该靠这句断言活着）。
		syncForensicsFallback();
	}

	/**
	 * ★ 批 G · FR-R3（设计档 §5 FR-R3 · §8 U6/U11）：巡逻尾部的**去抖周期 ensure**。
	 *
	 * 治的是 FR-R1 覆盖不了的那个时序：机器睡过「2h 窗口 + 到期点」之后，行**已被清扫**，
	 * 而今天**没有任何东西**会重建它（`ensureTeamAutoWatchdogs` 只有 attach 后置链与 `arm-team`
	 * 两个「挂载时刻」调用点）⇒ 工作台静默熄灭，直到下次重启。它顺带关掉「换届后**新**协调者的行
	 * 要等重启才建」这个既有缺口（那名册门的 watcher 一换，旧行不续、照旧被 TTL 收掉；新现任的行
	 * 由本函数铸出）。
	 *
	 * 三条纪律（逐条对应设计档 §5 FR-R3）：
	 *   · **去抖 60s**（进程级时间戳，仿 `runRotationSweep`）—— N 条注册各自每 10 分钟巡逻一次，
	 *     没有去抖就是 N 次冗余 ensure；
	 *   · **时钟可注入**（与 `patrol({ now })` **同一条**注入缝）—— 否则判据只能靠墙钟真等 60s
	 *     （评审第 2 轮 🔵#9；时间戳在**发起之前**落笔，并发/重入时只有一次真正跑）；
	 *   · **失败只留 warn**（fail-open）—— ensure 自己已经是逐队 try/catch，这里再兜一层是为了
	 *     「巡逻绝不因为一次补挂而崩」
	 * 但它**不在投递（tick / 工作台摘要）的关键路径上** —— 调用点在 `patrol` 循环体之后，投递已全部完成
	 * （调用处确实是 `await runPatrolEnsure(now)`：一次慢写最多推后本轮的收尾 —— 段同步 / 换届清扫）。
	 * 语义**逐字复用** `ensureTeamAutoWatchdogs`（除 FR-R2 那一个「未过期」谓词外一个字不改）。
	 */
	let lastPatrolEnsureAt = null;
	async function runPatrolEnsure(now) {
		if (lastPatrolEnsureAt !== null && now - lastPatrolEnsureAt < PATROL_SWEEP_MIN_INTERVAL_MS) return;
		lastPatrolEnsureAt = now;
		try {
			await ensureTeamAutoWatchdogs(ctx, policy, controller, { now });
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: 巡逻按队补挂工作台注册失败（${describeError(error)}）—— 巡逻不受影响（fail-open）`);
		}
	}

	/**
	 * Best-effort M4 sweep: a sweep failure is logged, never a patrol failure.
	 *
	 * 有界修复轮 F（评审 #7 🔵）: 去抖 —— 距上一次巡逻清扫不足
	 * {@link PATROL_SWEEP_MIN_INTERVAL_MS} 就跳过（N 条注册的冗余从这里消掉）。
	 * 时间戳在**发起之前**落笔（并发/重入时只有一次真正的清扫），且只由本函数拥有。
	 */
	let lastPatrolSweepAt = null;
	async function runRotationSweep(now) {
		if (rotation === null || rotation === undefined || typeof rotation.sweep !== "function") return;
		if (lastPatrolSweepAt !== null && now - lastPatrolSweepAt < PATROL_SWEEP_MIN_INTERVAL_MS) return;
		lastPatrolSweepAt = now;
		try {
			await rotation.sweep({ now });
		} catch (error) {
			ctx.logger?.warn?.(`${PLUGIN_LABEL}: rotation sweep failed: ${describeError(error)}`);
		}
	}

	/**
	 * Arm the timers of every persisted registration and hand back the disposer
	 * that is passed to `ctx.effect` — the plugin's only background work must die
	 * with the plugin (§3.2.4 / the task's cleanup requirement).
	 */
	/**
	 * FR-7: (re)arm the patrol timer of EVERY registration the store currently holds.
	 * Idempotent (`schedule` stops the old timer first), so it is safe on every (re)attach —
	 * and that is exactly how the plugin uses it: `start()` once at activation, plus one
	 * `rearm()` per policy-store attach (`policy.onAttach` in `apply`). Without that second
	 * half a persisted registration is MUTE for the whole process whenever the store was not
	 * readable at activation time: a settings provider that comes up after the plugin, or a
	 * fast-path fold that lands after `apply` returned.
	 */
	function rearm() {
		const now = Date.now();
		let live = 0;
		let expired = 0;
		let newestExpired;
		for (const entry of policy.get().watchdogs) {
			// ★ 评审裁定 #9（第二轮设计评审，2026-10-09；task-7 转述）：**过期条目不再挂定时器**
			// （旧实现逐条 schedule，实测不跳）。判据与 patrolOne 的第一道门**同一个**谓词
			// （`now > entry.expiresAt`），所以「跳过」与「被清扫」不会各读一套。
			const isExpired = typeof entry.expiresAt === "number" && now > entry.expiresAt;
			if (isExpired) {
				expired += 1;
				if (newestExpired === undefined || entry.expiresAt > newestExpired.expiresAt) newestExpired = entry;
				continue;
			}
			schedule(entry);
			live += 1;
		}
		// 「跳过」不等于「不清理」：过期行由既有的 TTL 自清扫负责，而那要有人巡逻。一条活注册
		// 都没有时，给**最新**的那条过期注册挂一个清扫专用定时器（它一跑就被 removeWatchdog
		// 收掉）——否则那些行会一直躺在 policy 里，等到下一次有人注册才被顺手清掉。
		if (live === 0 && newestExpired !== undefined) schedule(newestExpired);
		// ★ FR-K5 ③（§5 FR-K5 ③ · §9「注册中途归零」）：一条定时器都不剩（既没有活注册、也没有
		//   清扫专用定时器）⇒ 巡逻**从此不会再来** ⇒ 兜底心跳必须顶上，否则心跳静默冻结。
		//   幂等：`live > 0` 或那条清扫专用定时器在场时，`timers` 非空 ⇒ 这里是一次空跑。
		syncForensicsFallback();
		// ★ FR-17（批 7）: 把读数**交出去** —— 「rearm 挂上 N 个定时器」是 attach 后置链读面的第一档
		// （真机两次排查都卡在「后置链做了什么完全不可见」上）。幂等性不变：返回值只有调用方在用。
		return { armed: live, expired, sweepTimer: live === 0 && newestExpired !== undefined };
	}

	function start() {
		rearm();
		return () => {
			disposed = true;
			for (const id of [...timers.keys()]) stopTimer(id);
			timers.clear();
			ticked.clear();
			deadWatchers.clear();
			lastAgentState.clear();
			digested.clear();
		};
	}

	/** Clear one registration's process-local state (the clear tool's target). */
	function cancel(id) {
		stopTimer(id);
		forget(id);
		// ★ FR-K5 ③：clear 工具是「先 `policy.update` 摘行、再逐条 `cancel` ⇒ 停表」的两步写法
		//   ⇒ 清掉的若是**最后一条**注册，这里就是那个「归零时刻」，兜底心跳必须顶上。
		syncForensicsFallback();
	}

	// `deadWatchers` is read by the watch tool's list action; `timers`, `ticked`,
	// `lastAgentState` and `digested` are exposed so host-half.test.mjs can assert timer
	// ownership, the tick debounce, the E1 watermark and the digest debounce without reaching
	// into closure state; `rearm` is what `apply` hangs on the policy store's attach.
	//
	// ★ 批 G 分歧修复轮（D1 🔴 · 交付修复）：这份返回值**必须具名**。
	//   起因：FR-R3 的 `runPatrolEnsure`（本函数体内）需要把控制器交给 `ensureTeamAutoWatchdogs`，
	//   而它当时引用的是一个**在本函数作用域里不存在**的 `watchdog` 绑定 —— 全仓唯一的
	//   `const watchdog = createWatchdog(...)` 在 `apply` 体内，**不在**本闭包的作用域链上。
	//   后果：每次巡逻都在 `runPatrolEnsure` 的 try 里抛 `ReferenceError`，被吞成一行 warn，
	//   而本部署 `ctx.logger?.warn` 是空操作（设计档 §4 D8）⇒ 生产上完全不可见、FR-R3 等于没做。
	//   现在具名为 `controller`，`runPatrolEnsure` 传的就是它（`controller` 的声明在本函数末，
	//   但所有读取都发生在 `createWatchdog` 返回之后 —— 定时器回调 / `apply` 的调用点，无 TDZ 风险）。
	const controller = { start, rearm, schedule, cancel, patrol, removeWatchdog, timers, ticked, lastAgentState, digested, deadWatchers };
	return controller;
}

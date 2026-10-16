// ---------------------------------------------------------------------------
// 域档：崩溃现场留证（心跳）—— 批 R（上架合规）从 `lib/index.js` 原样搬出
// ---------------------------------------------------------------------------
// 归属：docs/2026-10-15-store-compliance-design.md §4 D1/D2/D4 · §5 FR-R1 · §6（拆分契约：
//       模块间只走相对导入、无环、搬运零行为变更）· §8 Rr1/Rr4。
// 被搬域自己的设计档：docs/2026-10-13-crash-forensics-design.md · 需求档
//       docs/2026-10-13-crash-forensics-requirements.md（见下面那段段头里的逐条归属）。
//
// ★ 搬运纪律（D4）：**函数体与常量逐字节原样** —— 只加 `export`、把入口那五个共享物的**取用点**
//   改成注入式读取（`need("…")`，见下）、并把两条内联 lambda 缝做成模块级函数；其余一字未改
//   （段头注释块「批 K · 崩溃现场留证（心跳）」随域一起搬来，正文一字未改）。
// ★ 对外契约（D2）：入口仍是 `lib/index.js`（`package.json` 的 `main` / `exports` 一字未动），
//   它从这里 `import` 后再把同一批名字交给 `__testing` ⇒ 判据面与用户看到的名字/签名逐字不变。
// ★ 无环（Rr4）：本档对入口**零导入**（共享物走 `wireForensics()` 注入，见下面那段注释 ——
//   静态导入会构成 ESM 环、实跑当场 TDZ），模块图是单向的 DAG：入口 → 本档。
//   宿主依赖面（Rr3）不变：本档只出现 `node:fs` / `node:fs/promises` / `node:path`
//   三条**既有白名单**说明符（与入口那几行同形），内部相对导入不计入。
// ---------------------------------------------------------------------------

import { mkdirSync } from "node:fs";
import { readFile, readdir, rm, statfs } from "node:fs/promises";
import path from "node:path";
// ★ 宿主半边的共享物（设计档 §6 边界规则里的「共享物」）**不经静态导入**取用，改由入口在装配时
//   `wireForensics()` 注入**同一批绑定**（同一份实现，不复制第二份 —— 双事实源必漂移）。
//   为什么不是 `import { … } from "./index.js"`：那会与入口的 `import … from "./forensics.js"`
//   构成 **ESM 环**，实跑当场 `ReferenceError: Cannot access 'FORENSICS_KEEP_BOOTS' before
//   initialization`（TDZ）—— 拆分契约 §6 第 ③ 条「模块图无环（禁 A→B→A）」正是要挡这个。
//   注入方向的模块图是**单向**的：入口 → 本档；本档对入口零导入。
let shared = null;

/**
 * ★ 装配缝（`index.js` 在模块级调用一次，早于 `apply` / `createForensics` 的任何一次调用）。
 *
 * 前置：`deps` 提供五个绑定 —— `PLUGIN_LABEL` / `describeError` / `readStamp` /
 * `resolvePolicyFilePath` / `writePolicyFileAtomic`（与搬出前同名的**同一批**绑定）。
 * 后置：本档的五个取用点改读注入值。幂等：重复注入只覆盖一次引用，无副作用。
 */
export function wireForensics(deps) {
	shared = deps ?? null;
}

/** 读一个共享物；未装配 ⇒ 当场说清是哪一条缺了（fail-closed，不静默 `undefined`）。 */
function need(name) {
	const value = shared === null ? undefined : shared[name];
	if (value === undefined) throw new Error(`forensics: 共享物 ${name} 未注入（入口应先调用 wireForensics()）`);
	return value;
}

// 批 K · 崩溃现场留证（心跳）
// 归属：docs/2026-10-13-crash-forensics-design.md §4（决策 D1–D7）· §5（FR-K1…FR-K5）·
//       §6（机制伪代码）· §7（状态与 schema）· §8（判据 Fk U1–U15）· §9（边界）；
//       需求档 docs/2026-10-13-crash-forensics-requirements.md（NF-K1…NF-K5 · §五 非目标）。
//
// 为什么是「活着时持续写」：崩溃是**非正常退出**（宿主 crash.log 40 条逐条 `non-graceful-end`，
// 见需求档 §2.1）⇒ 进程没有机会在死时跑任何收尾代码，「死时写」这种写**永远不会发生**。
// 本模块只做三件事：
//   ① FR-K1：activation 开一个 `<DSH_HOME>/team-link/forensics/<bootId>/` 目录并写**首拍**；
//   ② FR-K2：每拍**原子覆盖** `heartbeat.json`（复用既有 {@link writePolicyFileAtomic}），并按
//      **心跳内嵌的 `lastBeatAt`**（不是目录 mtime —— 评审 🔵#5）保留最近
//      {@link FORENSICS_KEEP_BOOTS} 份；
//   ③ FR-K3/FR-K4：下次启动读**上一次**那一份 ⇒ 死亡窗口 = [上次 `lastBeatAt`, 本次 `startedAt`]，
//      由 `team_link_status action=forensics` **只读**呈现；
//   ④ FR-K5：**兜底心跳定时器（双向）** —— 零注册启动 ⇒ 另起一个 `unref()` 的兜底（否则心跳静默
//      停在首拍）；出现注册（巡逻开始跑）⇒ 退场、**不双写**；★ **中途归零 ⇒ 重新挂上** ——
//      巡逻定时器是**按注册**建的，最后一条注册被收掉之后巡逻不会再来，只在启动时挂兜底等于把
//      「静默冻结」换个入口。三个重挂点都在 `createWatchdog` 里：收注册（`removeWatchdog`）·
//      clear 工具（`cancel`）· 重挂表（`rearm`），外加**巡逻最末尾**那一次（`patrolBeat` 刚把兜底
//      收掉，而同一轮可能刚收掉最后一条注册）。
//
// 三条硬边界（每条都有判据咬住）：
//   · **纯自家**：只读写自家 forensics 根下的东西 —— 宿主那半个仪表（§2 根因②）一概不读、不写、
//     不删，代码里连它的名字都不出现（**U13** 是这条的负向锁）。
//   · **fail-open**：它是**观测**不是功能 —— 任何失败只留一行 warn，绝不抛进热路径（**NF-K4 / U8**）。
//   · **不编造**：磁盘读不到就是 `null`（**U10**）；没有旧目录就说「无（首次运行）」（**U4**）；
//     **在飞作业数本批不做**（插件读不到宿主的作业服务：模块级 `inject` 恰 4 项、没有 `jobs`）
//     —— 读数里**没有这一格**，也不用猜测的 0 冒充（需求档 §五 5 / 设计档 §5 ★）。
// ---------------------------------------------------------------------------
/** §7 / D5：保留的**启动份数**上限（超出按最旧清理；按心跳内嵌 `lastBeatAt` 排序）。 */
export const FORENSICS_KEEP_BOOTS = 10;
/** FR-K5 的兜底心跳间隔（毫秒）：10 分钟 —— 与默认巡逻间隔同一量级（设计档 §4 D4 的登记值）。 */
export const FORENSICS_FALLBACK_INTERVAL_MS = 600000;
/** §7：目录名 / 文件名 / 形状版本（`schema` **独立于** `POLICY_FILE_SCHEMA`，两者不相干）。 */
const FORENSICS_DIR_NAME = "forensics";
const FORENSICS_HEARTBEAT_NAME = "heartbeat.json";
const FORENSICS_SCHEMA = 1;
/**
 * §9 边界「清理越界」：**只删匹配 `forensics/<bootId>/` 形态**的目录（不做通配删除）。
 * `bootId` = `<ISO 时间戳，冒号与点换成 ->-<pid>`（见 {@link createForensics}），所以形态 = 一条正则。
 *
 * ★ **判据 U14 同批收紧（交付评审 🔵#3）**：谓词必须与**生成端严格互为镜像**。生成端是
 * `new Date().toISOString().replace(/[:.]/gu, "-")` ⇒ `toISOString()` 恒为 24 字符的
 * `YYYY-MM-DDTHH:mm:ss.sssZ`，换完全长成 **`YYYY-MM-DDTHH-MM-SS-mmm`** ＋ `Z-<pid>`。
 * 收紧前那条 `[\d-]+` 是**宽松的近似**：`2026-10-13T--Z-1` 这类畸形名也照样通过（它只作删除闸
 * 与计数过滤，风险为 0，但两套口径就是两套口径）。现在逐段钉死（年 4 · 月/日 2 · 时/分/秒 2 ·
 * 毫秒 3 · pid 任意位数）—— 生成端产出的每一个名字都通过，别的一律不通过。
 */
const FORENSICS_BOOT_DIR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+$/u;

/**
 * ★ 批 K 的免责声明（设计评审 🟡#3② / 判据 **U11**）。它是这一批的**诚实边界**，不是客套话：
 * 心跳只证明「最后一次说话停在那一刻」，而**正常退出**（关机、关窗、重启）与**崩溃**在这份数据上
 * **同形** —— 两种情况下最后一拍都停在那里，窗口的形状一模一样。**区分二者只能由人**去结合宿主
 * 那份 `crash.log` 的 `non-graceful-end` 记录；而那个目录本插件**一个字都不读**（设计档 §5 ★）。
 * ⇒ 本批**只留现场，不单独下崩溃结论**。
 */
const FORENSICS_DISCLAIMER = "免责：本批只留现场、**非正常退出不单独归因** —— 正常退出与崩溃在这份数据上**同形**（最后一次心跳都停在那儿、窗口形状一样），区分二者需由人结合宿主 crash.log 的 non-graceful-end 记录判定；本插件不读宿主的那个目录（一个字都不读、不写、不删）。";

/** 人类可读的字节数。`null` / 非数 ⇒ **如实说读不到**，绝不编造一个 0（U10 的同一口径）。 */
export function formatForensicsBytes(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return "读不到（不编造）";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let size = value;
	let unit = 0;
	while (size >= 1024 && unit < units.length - 1) {
		size /= 1024;
		unit += 1;
	}
	return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** 人类可读的时长（死亡窗口用）。不可得 ⇒ 「未知」。 */
export function formatForensicsDuration(ms) {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "未知";
	const seconds = Math.round(ms / 1000);
	if (seconds < 90) return `${seconds} 秒`;
	const minutes = Math.round(ms / 60000);
	if (minutes < 90) return `${minutes} 分钟`;
	return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

/** 计数格：数 ⇒ 数字；读不到 ⇒ 「读不到」（**不写 0 冒充**）。 */
export function formatForensicsCount(value) {
	return typeof value === "number" && Number.isFinite(value) ? String(value) : "读不到";
}

/**
 * §8 U10 的诚实路径：`statfs` 读不到 ⇒ `{ free: null, total: null }`，**绝不编造数字**。
 *
 * 为什么这里有一层注入缝（模块级 `diskSpaceReader`）：`node:fs/promises` 是**内建模块**，它的
 * ESM 命名空间绑定在测试里**不可改写**（模块命名空间对象只读）⇒「把 `statfs` 桩成 reject」这条
 * 判据必须有一条与 `setPolicyHomeInject` / `setStripImpl` 同款的缝。**默认值永远是真 `statfs`**。
 */
export async function readDiskSpaceFromStatfs(dir) {
	const stats = await statfs(dir);
	const size = Number(stats.bsize);
	const total = Number(stats.blocks);
	const available = Number(stats.bavail);
	return { free: available * size, total: total * size };
}
/** ★ 两条**判据缝**（判据 `U10` 的红相构造与「必须还原」的可核出口；搬出前是入口 `__testing`
 *  里那两条内联 lambda，逐字搬来做成模块级函数 —— 对外名字 / 签名 / 语义一字不变）。
 *  `node:fs/promises` 是**内建模块**，它的 ESM 命名空间绑定在测试里**不可改写** ⇒ 这条缝是
 *  与 `setPolicyHomeInject` / `setStripImpl` / `setRenameThroughSeam` 同款的那条注入缝。 */
/** 换掉 / 还原读盘器：非函数 ⇒ 还原默认实现（与 `setStripImpl` 同语义）。★ 可变绑定本身
 *  **不 `export`**（`export let` 的写面会让「谁改了它」不可审计）—— 写只走两条缝函数。 */
export function setDiskSpaceReader(fn) {
	diskSpaceReader = typeof fn === "function" ? fn : readDiskSpaceFromStatfs;
}
/** 「跑完 U10 必须还原」的可核出口（同 `renameThroughSeamIsDefault` 的纪律）。 */
export function diskSpaceReaderIsDefault() {
	return diskSpaceReader === readDiskSpaceFromStatfs;
}

let diskSpaceReader = readDiskSpaceFromStatfs;

/** §7 的 `uptimeSeconds`：读不到就是 `null`（不编造 —— 与磁盘同一条诚实口径）。 */
export function readUptimeSeconds() {
	try {
		const value = process.uptime();
		return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
	} catch {
		return null;
	}
}

/**
 * §7 的 `memory`：`process.memoryUsage()` 的 `rss` / `heapUsed` / `heapTotal`（**不引入依赖**）。
 * 读不到 ⇒ `null`，不编造。
 */
export function readMemory() {
	try {
		const usage = process.memoryUsage();
		const pick = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
		return { rss: pick(usage?.rss), heapUsed: pick(usage?.heapUsed), heapTotal: pick(usage?.heapTotal) };
	} catch {
		return { rss: null, heapUsed: null, heapTotal: null };
	}
}

/**
 * §6 的 `rosterSessionCount()`：名册里**点过名的会话**数（`policy.teams` 的角色行：在职 `current`
 * ＋ 换届在飞 `pending.session`，按 id 去重）。只在制的两格 —— 版本史是**历史**，不是「此刻名册
 * 上有几个会话」。读数不可得 ⇒ `null`。
 */
export function rosterSessionCount(view) {
	try {
		const ids = new Set();
		for (const team of Array.isArray(view?.teams) ? view.teams : []) {
			for (const role of Array.isArray(team?.roles) ? team.roles : []) {
				for (const id of [role?.current, role?.pending?.session]) {
					if (typeof id === "string" && id !== "") ids.add(id);
				}
			}
		}
		return ids.size;
	} catch {
		return null;
	}
}

/**
 * 崩溃现场（心跳）控制器：一个 ctx 一个，闭包持有本次启动的身份、拍号、兜底定时器与
 * 「上一次那拍」的进程内缓存。**全部读写的根**只有 {@link FORENSICS_DIR_NAME} 之下的路径。
 *
 * `bootId` 的形态：`<ISO 时间戳>-<pid>`（与宿主 `state.json` 的 bootId 同形，便于对时间线），
 * 其中 ISO 串里的 `:` 与 `.` 换成 `-` —— 否则 Windows 上根本无法当目录名（本仓既有的
 * `policy.superseded-<safeStamp>.json` 用的是同一条替换）。**目录名恰等于心跳里的 `bootId`**。
 */
export function createForensics(ctx, policy) {
	const resolved = need("resolvePolicyFilePath")();
	// 落点：`<DSH_HOME 或 ~/.dsh>/team-link/forensics`（与 policy.json 同级，设计档 D1）。
	// 路径来源与 policy 落点**同一条**（同一个 `resolvePolicyFilePath`），不另发明一套解析。
	const root = resolved.ok ? path.join(resolved.dir, FORENSICS_DIR_NAME) : null;
	const startedAt = new Date().toISOString();
	const bootId = `${startedAt.replace(/[:.]/gu, "-")}-${process.pid}`;
	const dir = root === null ? null : path.join(root, bootId);
	const heartbeatFile = dir === null ? null : path.join(dir, FORENSICS_HEARTBEAT_NAME);
	let seq = 0;
	let lastBeatAt = null;
	/** ★ FR-K3：**上一次**启动的现场（activation 读**一次**、缓存在进程内 —— 设计档 §5 FR-K3）。 */
	let previous = null;
	let started = false;
	let disposed = false;
	let warned = false;
	/** FR-K5：零看门狗注册时的兜底心跳定时器（`null` = 没挂）。 */
	let fallbackTimer = null;

	/**
	 * NF-K4 的单行 warn 门：心跳写失败**每一次启动只报一行**（与既有「不搞 warn 风暴」同规），
	 * 且**绝不抛** —— 它是观测，不是功能。
	 */
	function warnOnce(error) {
		if (warned) return;
		warned = true;
		ctx.logger?.warn?.(`${need("PLUGIN_LABEL")}: 心跳写失败（${need("describeError")(error)}）—— 取证是观测，绝不影响功能（本次启动只报这一行）`);
	}

	/** §7 的 `sessions.live`：活代理数（`ctx.agents.list()`）；读不到 ⇒ `null`（不编造）。 */
	function liveAgentCount() {
		try {
			const list = ctx.agents?.list?.();
			return Array.isArray(list) ? list.length : null;
		} catch {
			return null;
		}
	}

	/** §7 的 `disk`：读不到 ⇒ 两格都是 `null`（U10 的诚实路径）。 */
	async function diskReading() {
		try {
			const reading = await diskSpaceReader(root);
			const pick = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
			return { free: pick(reading?.free), total: pick(reading?.total) };
		} catch {
			return { free: null, total: null };
		}
	}

	/** §7 的 `watchdogs` 读数：注册数；读不到 ⇒ `null`（**不编造** —— 与磁盘同一条口径）。
	 *  ★ 走 `peek()` 而不是 `get()`：观测读不许触发惰性附着（见 {@link peek} 的 JSDoc）。 */
	function watchdogCount() {
		try {
			const view = policy.peek();
			return Array.isArray(view?.watchdogs) ? view.watchdogs.length : null;
		} catch {
			return null;
		}
	}

	/**
	 * ★ FR-K5 的兜底心跳（设计评审 🟡#1 的处置）。**为什么必须有它**：巡逻定时器是**按注册建**的
	 * （{@link schedule} → `setInterval`），**零注册时根本不存在巡逻** ⇒ 心跳会**静默停在首拍**，
	 * 而这与本批的目的（**宿主级**崩溃取证）正面冲突 —— 一台没人注册看门狗的机器，正是最可能
	 * 毫无征兆崩掉的那种。
	 *
	 * 三条纪律：
	 *   · **`unref()`**：后台家务绝不许把壳吊住（与 {@link schedule} 同规）；
	 *   · **一旦出现注册就退场**：巡逻开始跑的那一刻（{@link patrolBeat}）停掉它 —— **不双写**；
	 *   · **它自己也不写第二遍**：`fallbackTick` 先看定时器还在不在（已退场 ⇒ 空转）。
	 * 常见情形（本部署恒有自动注册）仍走 D4 的复用路径、**零额外定时器**。
	 *
	 * 返回值：`fallbackTick` 把那一拍的 promise **交回调用方**（定时器回调 `void` 掉它）—— 判据要能
	 * 确定性地等这次写落地，而不是「等几个 tick 大概写完了」（U12 的双向读数）。
	 */
	function fallbackTick(now = Date.now()) {
		if (fallbackTimer === null || disposed) return Promise.resolve(false);   // 已退场（巡逻在跑）⇒ 不双写
		return writeHeartbeat(now);
	}
	function armForensicsFallback() {
		if (disposed || fallbackTimer !== null || heartbeatFile === null) return false;
		const timer = setInterval(() => { void fallbackTick(Date.now()); }, FORENSICS_FALLBACK_INTERVAL_MS);
		timer.unref?.();
		fallbackTimer = timer;
		return true;
	}
	function disarmForensicsFallback() {
		if (fallbackTimer === null) return false;
		clearInterval(fallbackTimer);
		fallbackTimer = null;
		return true;
	}

	/**
	 * FR-K1/FR-K2 的写一拍。**后置**：`heartbeat.json` 是一次完整原子写（或本次写失败 —— 失败只
	 * warn，绝不抛）；`seq` / `lastBeatAt` 只在**写成功**之后前进。**不抛**。
	 */
	async function writeHeartbeat(now = Date.now()) {
		if (disposed || heartbeatFile === null) return false;
		const stamp = new Date(now).toISOString();
		let view = null;
		try {
			// ★ `peek()`：观测读不许触发惰性附着（见 {@link peek} 的 JSDoc —— 用 `get()` 会让
			//   一次后台心跳把晚挂的 settings 服务拉上来）。
			view = policy.peek();
		} catch {
			view = null;
		}
		const doc = {
			schema: FORENSICS_SCHEMA,
			bootId,
			pid: process.pid,
			startedAt,
			lastBeatAt: stamp,
			seq: seq + 1,
			uptimeSeconds: readUptimeSeconds(),
			memory: readMemory(),
			disk: await diskReading(),
			sessions: { live: liveAgentCount(), roster: rosterSessionCount(view) },
			watchdogs: watchdogCount(),
		};
		try {
			await need("writePolicyFileAtomic")(heartbeatFile, JSON.stringify(doc));
		} catch (error) {
			warnOnce(error);
			return false;
		}
		seq += 1;
		lastBeatAt = stamp;
		return true;
	}

	/**
	 * D5 / §9「清理越界」：保留最近 `keep` 次启动，超出按**心跳内嵌的 `lastBeatAt`** 排序清掉最旧的
	 * （**不用目录 mtime** —— 它是否随原子覆盖更新取决于实现细节，口径不稳，评审 🔵#5）。三条硬规矩：
	 *   · **永不删本次**（`bootId` 那一行显式跳过：本次若连心跳都写失败，它的 `lastBeatAt` 读不到，
	 *     只按排序清就会**把本次自己删掉**，而那正好是可诊断性最差的一次启动）；
	 *   · **只删 `forensics/<bootId>/` 形态**的目录（{@link FORENSICS_BOOT_DIR_PATTERN} 把关，
	 *     不做通配删除）；
	 *   · 失败只 warn（fail-open）。**不抛**。
	 *
	 * 读不出心跳的旧目录（损坏 / 没有那个文件）排在**最后**（＝最旧 ⇒ 先清）：这样「目录数有界」
	 * 这条 NF-K3 不会因为一个坏目录而失效。`readPreviousForensics` 对它们是**另一条**处置（跳过）。
	 * @returns 被清掉的目录名数组（判据读它；不是在文案里反推）。
	 */
	async function pruneForensics(keep = FORENSICS_KEEP_BOOTS) {
		const removed = [];
		if (root === null || disposed) return removed;
		let entries;
		try {
			entries = await readdir(root, { withFileTypes: true });
		} catch {
			return removed;                    // 目录还不存在 / 读不到 ⇒ 没有旧档可清（这不是失败）
		}
		const rows = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			let at = Number.NEGATIVE_INFINITY;
			try {
				const doc = JSON.parse(await readFile(path.join(root, entry.name, FORENSICS_HEARTBEAT_NAME), "utf8"));
				const parsed = Date.parse(doc?.lastBeatAt);
				if (Number.isFinite(parsed)) at = parsed;
			} catch {
				at = Number.NEGATIVE_INFINITY;
			}
			rows.push({ name: entry.name, at });
		}
		rows.sort((left, right) => right.at - left.at);
		for (const row of rows.slice(Math.max(0, keep))) {
			if (row.name === bootId) continue;                        // ★ 永不删本次
			if (!FORENSICS_BOOT_DIR_PATTERN.test(row.name)) continue; // ★ 只删自家 bootId 形态
			try {
				await rm(path.join(root, row.name), { recursive: true, force: true });
				removed.push(row.name);
			} catch (error) {
				warnOnce(error);
			}
		}
		return removed;
	}

	/**
	 * FR-K2：**每次巡逻写一拍**。巡逻是本插件唯一的周期路径（每条注册一个定时器），心跳搭它
	 * ⇒ **零新增常驻定时器**（设计档 §4 D4）。
	 *
	 * 同一处收掉 FR-K5 的兜底定时器：「巡逻在跑」**等价于**「存在注册」（定时器是 {@link schedule}
	 * 按注册建的）⇒ 从这一刻起兜底退场，**不双写**（U12②）。
	 */
	async function patrolBeat(now) {
		disarmForensicsFallback();
		await writeHeartbeat(typeof now === "number" ? now : Date.now());
	}

	/**
	 * FR-K1：**activation 时**开本次启动的现场目录并写首拍。幂等（重复调用零写）。
	 *
	 * 为什么目录用**同步** `mkdirSync`：调用点是 `apply` 的收尾（`void forensics.start()`），
	 * 而「每次启动一个目录」是这一批的**设计前提**（D2）—— 同步建目录让「activation 之后目录
	 * 就在那儿」成为确定性事实，而不是「几个 tick 之后大概在」。心跳本身仍是异步原子写。
	 *
	 * ★ 调用点**刻意不挂在 `policy.onAttach` 上**（设计档 §5 括号里那句落点猜测）：本部署是
	 * `no-register` ⇒ 文件后端，而那条后置链的三个 `notifyAttached()` 全被 `scope !== null`
	 * 门住（见 {@link onAttach} 的 JSDoc 与 §3.5 的注释），文件为空/无文件时它**一次都不会跑**
	 * ⇒ 首拍挂在那里等于**静默零心跳**，正是本批要消灭的失效形态。写在 `apply` 收尾即
	 * 「activation 之后心跳在场」，与判据 U1 的验收口径一致。
	 */
	async function start() {
		if (started || disposed) return false;
		started = true;
		if (heartbeatFile === null) return false;
		try {
			mkdirSync(dir, { recursive: true });
		} catch (error) {
			warnOnce(error);
		}
		// ★ FR-K3：**先读上一次那一份、再写首拍**（顺序有讲究：清理在后面，但「先读」这条顺序
		//   保证「上一次的现场」读的是清理**之前**的那一份目录列表）。
		previous = await readPreviousForensics();
		await writeHeartbeat(Date.now());
		// 清理**紧跟首拍之后**：本次目录（刚写进去的那一拍）必是最新的一行，`keep` 之内的位置
		// 由它自己占住，于是「本次永不删」与「恰剩 keep 份」两件事在同一次启动里就成立。
		await pruneForensics();
		return true;
	}

	/**
	 * FR-K3：找**上一次**的现场（**不含本次**）。
	 *
	 * 后置：`{ bootId, lastBeatAt, readings }` 或 `null`（一个旧目录都没有 / 旧的全都坏 ⇒
	 * 「无（首次运行）」，**绝不编造一个窗口**）。**不抛**。
	 *
	 * §9「旧目录里的心跳损坏 / 不可解析」：**跳过该目录、视同无此份** —— 这既不是失败，也不是
	 * 编一个窗口的理由；全部旧目录都坏 ⇒ 与「首次运行」同一支。
	 * §9「同时多次启动」：取**非本次里 `lastBeatAt` 最大**的那一份是**有意取舍** —— 并存实例下它
	 * 可能选中另一个**仍在跳动**的兄弟实例，而那正是「最近一次真实现场」，不是异常。
	 */
	async function readPreviousForensics() {
		if (root === null) return null;
		let entries;
		try {
			entries = await readdir(root, { withFileTypes: true });
		} catch {
			return null;
		}
		let best = null;
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === bootId) continue;
			let doc;
			try {
				doc = JSON.parse(await readFile(path.join(root, entry.name, FORENSICS_HEARTBEAT_NAME), "utf8"));
			} catch {
				continue;                                  // 损坏 / 不可解析 ⇒ 跳过，视同无此份
			}
			if (doc === null || typeof doc !== "object" || Array.isArray(doc)) continue;
			const at = Date.parse(doc.lastBeatAt);
			if (!Number.isFinite(at)) continue;
			if (best === null || at > best.at) best = { at, doc, name: entry.name };
		}
		if (best === null) return null;
		return {
			bootId: typeof best.doc.bootId === "string" && best.doc.bootId !== "" ? best.doc.bootId : best.name,
			lastBeatAt: best.doc.lastBeatAt,
			readings: readingsOf(best.doc),
		};
	}

	/** 把一拍心跳里的四类读数摘出来（**原样**，缺格 ⇒ `null`，不补 0）。 */
	function readingsOf(doc) {
		return {
			memory: doc?.memory ?? null,
			disk: doc?.disk ?? null,
			sessions: doc?.sessions ?? null,
			watchdogs: typeof doc?.watchdogs === "number" ? doc.watchdogs : null,
			seq: typeof doc?.seq === "number" ? doc.seq : null,
			uptimeSeconds: typeof doc?.uptimeSeconds === "number" ? doc.uptimeSeconds : null,
		};
	}

	/** 读**本次**那一拍（盘上的那一份；读不到 ⇒ `null`）。纯读。 */
	async function readOwnHeartbeat() {
		if (heartbeatFile === null) return null;
		try {
			const doc = JSON.parse(await readFile(heartbeatFile, "utf8"));
			return doc !== null && typeof doc === "object" && !Array.isArray(doc) ? doc : null;
		} catch {
			return null;
		}
	}

	/** 四类读数的一屏三行（内存 / 磁盘 / 会话 + 看门狗）。 */
	function readingLines(label, readings) {
		const memory = readings?.memory ?? null;
		const disk = readings?.disk ?? null;
		const sessions = readings?.sessions ?? null;
		return [
			`- ${label}内存：rss=${formatForensicsBytes(memory?.rss)}｜heapUsed=${formatForensicsBytes(memory?.heapUsed)}｜heapTotal=${formatForensicsBytes(memory?.heapTotal)}`,
			`- ${label}磁盘：free=${formatForensicsBytes(disk?.free)}｜total=${formatForensicsBytes(disk?.total)}`,
			`- ${label}会话：活代理=${formatForensicsCount(sessions?.live)}｜名册=${formatForensicsCount(sessions?.roster)}｜看门狗=${formatForensicsCount(readings?.watchdogs)}`,
		];
	}

	/**
	 * FR-K4 的渲染体：`team_link_status action=forensics` 的**全部正文行**。
	 *
	 * **纯读**：只读自家 `forensics/` 下的心跳与目录列表 —— 一个字节都不写（U6 的只读合同）。
	 * 输出含：本次启动 · **死亡窗口** · **死前四类读数** · 保留份数 · **免责句**（U11）。
	 * **不含**「在飞作业」这一格（本批读不到宿主的作业服务 —— 设计档 §5 ★ / 需求档 §五 5）。
	 */
	async function renderForensicsReport(now = Date.now()) {
		const lines = [`崩溃现场（批 K；读数 ${need("readStamp")(now)}；纯自家心跳 —— 不读、不写、不删宿主的任何文件）`];
		if (root === null) {
			lines.push("⚠ 无落点：DSH_HOME 与 homedir 都解析不出（路径解析失败）⇒ **本次不写心跳**，不猜任何目录。");
			lines.push("", FORENSICS_DISCLAIMER);
			return lines.join("\n");
		}
		// ---- 本次启动 ----
		lines.push("", "--- 本次启动 ---");
		lines.push(`- bootId：${bootId}｜pid：${process.pid}｜startedAt：${startedAt}`);
		lines.push(`- 最近一拍：${lastBeatAt ?? "（本进程尚未写出）"}｜seq=${seq}`);
		lines.push(`- 现场目录：${dir}`);
		// ---- 保留份数（只读目录列表；读不到 ⇒ 如实说读不到）----
		let kept = null;
		try {
			// 只数**自家 bootId 形态**的目录 —— 与 `pruneForensics` 管理的面**同一个面**（否则一个
			// 外来的无关目录会让「保留 N 份 / 上限 10」这句读数失实）。
			kept = (await readdir(root, { withFileTypes: true }))
				.filter((entry) => entry.isDirectory() && FORENSICS_BOOT_DIR_PATTERN.test(entry.name)).length;
		} catch {
			kept = null;
		}
		lines.push(`- 保留：${kept === null ? "读不到" : `${kept} 份`}（上限 ${FORENSICS_KEEP_BOOTS} 份，按心跳内嵌的 lastBeatAt 排序清理，永不删本次）`);
		// ---- 死亡窗口 + 死前读数 ----
		lines.push("", "--- 死亡窗口（上一次的最后一拍 → 本次启动）---");
		if (previous === null) {
			lines.push("无（首次运行 —— 没有任何旧 bootId 目录；本批**不编造**窗口）。");
			lines.push("", "--- 读数（本次最近一拍；还没有「死前」那一份可读）---");
			const own = readingsOf(await readOwnHeartbeat());
			for (const line of readingLines("", own)) lines.push(line);
		} else {
			const at = Date.parse(previous.lastBeatAt);
			const boot = Date.parse(startedAt);
			const span = Number.isFinite(at) && Number.isFinite(boot) ? formatForensicsDuration(boot - at) : "未知";
			lines.push(`- 上一次现场：${previous.bootId}｜最后一拍：${previous.lastBeatAt}`);
			lines.push(`- 窗口：${previous.lastBeatAt} → ${startedAt}（**${span}** 无人知道）`);
			lines.push("", "--- 死前读数（上面那一拍，即上一次进程活着时写下的最后一拍）---");
			for (const line of readingLines("", previous.readings)) lines.push(line);
		}
		lines.push("", FORENSICS_DISCLAIMER);
		return lines.join("\n");
	}

	/** 判据面（只读）：本控制器持有的全部事实，一个字段都不多算。 */
	function inspect() {
		return {
			root, dir, heartbeatFile, bootId, startedAt, pid: process.pid,
			seq, lastBeatAt, started, disposed, warned, previous,
			fallbackArmed: fallbackTimer !== null,
		};
	}

	/**
	 * 插件卸载 / 重载时的收尾：把本控制器标记为已死（此后再写就是空转）并收掉它自己的兜底定时器
	 * —— **绝不删任何文件**（现场要留给下一次启动读，那是这一批的全部意义）。
	 */
	function dispose() {
		if (disposed) return;
		disposed = true;
		disarmForensicsFallback();
	}

	// ★ FR-K5 的挂表：**同步**在 activation 建控制器时决定（不是 `start()` 的异步尾巴里）——
	//   两个理由：① 判据要能确定性地读「activation 之后兜底在不在」（不靠「等几个 tick 大概挂上了」）；
	//   ② 真是「零注册」的那种机器，正是最可能在启动后不久毫无征兆崩掉的那一类，兜底不该晚几拍。
	//   读不到名册时按「零注册」处理：这一支的错法必须是「多写几拍」，**绝不能**是「静默零心跳」；
	//   而双写的窗口有界 —— 第一条注册的巡逻一跑，{@link patrolBeat} 就把兜底收掉。
	const dogsAtActivation = watchdogCount();
	if (dogsAtActivation === null || dogsAtActivation === 0) armForensicsFallback();

	return {
		bootId, startedAt, root, dir, heartbeatFile,
		start, writeHeartbeat, patrolBeat, pruneForensics, readPreviousForensics, renderForensicsReport,
		armForensicsFallback, disarmForensicsFallback, fallbackTick,
		inspect, dispose,
	};
}

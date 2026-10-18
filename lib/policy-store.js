// ===========================================================================
// lib/policy-store.js — 批 R · 第 10 小单：名册与状态落点域（policy store / normalize / 迁移）
// ===========================================================================
//
// 归属：docs/2026-10-15-store-compliance-design.md §4 D1/D4 · §5 FR-R1 · §6（拆分不变量 ①–⑤）。
// 本档只搬**纯函数族**（归一化 + 状态落点解析 + 折叠结局词），**不碰** `createPolicyStore` 的
// store 生命周期本体（它是本域下一小单的活；本单边界见交付报告「没搬的」）。
//
// ★ 本单搬了什么（三个连续区段，逐字节原样；每个定义行前只加 `export `）：
//   ① `DEFAULT_POLICY` · `POLICY_MODES` · `antiDriftView`（缺省策略 / 收件模式闭集 / 写门视图）；
//   ② `normalizePolicy` 与其整族归一化器（`pendingCreateList` / `watchdogList` / `normalizePending` /
//      `normalizeProvisional` / `normalizeRotationBackup` / `normalizeHistory` / `normalizeRoles` /
//      `normalizeTeams`）＋ 三个策略读助手（`pairBetween` / `pairRecordBetween` / `withSender`）；
//   ③ 状态落点：`POLICY_FILE_DIR` / `POLICY_FILE_NAME` · 四个折叠结局词与
//      `memoryWindowOutcomeLanded` · 五个落点原因码 · `policyHomeSources` / `policyHomeInject` ·
//      `policyIsAtDefaults` · `resolvePolicyFilePath`。
//
// ★ 被钉符号（`hostSource` 文本锁钉住的 9 个：`writePolicyFileAtomic` / `renameThroughSeam` /
//   `POLICY_FILE_SCHEMA` / `WATCHDOG_DIGEST_DEBOUNCE_MS` / `TICKABLE_VERDICTS` / `agentStateLabel` /
//   `writerGate` / `relayUserMessage` / `buildTeamSessionCreateOptions`）：**一个都没搬**，九个仍
//   逐字节住在 `lib/index.js`（源码锁按函数自身锚点切片，读数因此一字不变）；本档的可执行代码面
//   对那 9 个名字**零命中** —— 它们只出现在本条注释里，那是点名核对，不是引用。
//
// ★ 依赖方向（模块图无环）：本档 → `./block.js`（`blockPair`）· `./rotation.js`（`ROTATION_TTL_MS` /
//   `isExpiredProvisionalPair`）· `./shared.js`（`sectionsView`）。三条都是**已存在的**边，且这三档
//   都不导入本档 ⇒ **没有新增环**（`shared ↔ rotation` 那一对既有环见 `lib/shared.js` 档头，本单
//   既没触碰、也没加长它）。
//
// ★ 装配缝（先例：`lib/forensics.js` 的 `wireForensics()`）：本档需要的 9 条入口侧绑定
//   （四个看门狗缺省 / 来源常量 · 名册形态闭集与降级留痕表 · `normalizeRecoveries`）**只注入、不搬** ——
//   它们要么被入口侧仍然使用，要么被入口的 schema 在**模块求值**时读到（域档求值早于入口正文 ⇒
//   静态 import 会 TDZ）。前置：入口在**模块求值**时调用一次（`lib/index.js` 模块尾部，
//   `wireTeamLedgerTools(...)` 之后）。后置：本档模块级 `let` 全部绑定到入口那一份真实现，此后
//   每次调用读到的都是它。
//
// ★ 搬运纪律（D4）：本档新增的只有 ① 本段档头 ② 5 条 import ③ 装配缝 + 一个 home 注入 setter
//   ④ 30 个定义行的 `export ` 前缀；**函数体 / 注释 / 缩进 / 文案一个字符都没动**（逐字节等价
//   机检见交付报告）。
// ---------------------------------------------------------------------------

import os from "node:os";
import path from "node:path";

import { blockPair } from "./block.js";
import { ROTATION_TTL_MS, isExpiredProvisionalPair } from "./rotation.js";
import { sectionsView } from "./shared.js";

// ---------------------------------------------------------------------------
// 装配缝 · `wirePolicyStore(extras)`（先例：`lib/forensics.js` 的 `wireForensics()`）
// ---------------------------------------------------------------------------
// 前置：入口在**模块求值**时调用一次（`lib/index.js` 模块尾部），给出的 9 个键与被注入的绑定
//       同名同值（同一批绑定、同一份实现）。
// 后置：本档的模块级 `let` 全部绑定到入口那一份真实现；此后每次归一化 / 读落点读到的都是它。
// 为什么不是 import：入口 → 域档是单向的；域档 import 入口会成环（实跑当场 TDZ）。
// ---------------------------------------------------------------------------
let WATCHDOG_DEFAULT_SILENT_MINUTES, WATCHDOG_DEFAULT_INTERVAL_MINUTES, WATCHDOG_ORIGIN_AUTO, WATCHDOG_ORIGIN_MANUAL;
let TEAM_NAME_RE, TEAM_MODES, TEAM_MODE_SESSIONS, TEAM_MODE_DEGRADATIONS;
let normalizeRecoveries;

/** 入口侧出口的一次性绑定（见本节档头的前置 / 后置）。 */
export function wirePolicyStore(extras) {
	({
		WATCHDOG_DEFAULT_SILENT_MINUTES,
		WATCHDOG_DEFAULT_INTERVAL_MINUTES,
		WATCHDOG_ORIGIN_AUTO,
		WATCHDOG_ORIGIN_MANUAL,
		TEAM_NAME_RE,
		TEAM_MODES,
		TEAM_MODE_SESSIONS,
		TEAM_MODE_DEGRADATIONS,
		normalizeRecoveries,
	} = extras);
}

/**
 * 落点夹具的 home 注入点（原 `lib/index.js` 的 `__testing.setPolicyHomeInject` 闭包）。
 * `null` ⇒ 生产（`process.env` + `os.homedir()`）；对象 ⇒ 钉死两个输入（夹具的私有 DSH_HOME）。
 * 为什么是 setter 而不是导出那个 `let`：ESM 的 import 绑定只读，入口的 `__testing` 面需要一个
 * 可写入口；语义与搬迁前**逐字相同**（`value ?? null`）。
 */
export function setPolicyHomeInject(value) {
	policyHomeInject = value ?? null;
}

// ===========================================================================
// 区段 ①：缺省策略 / 收件模式闭集 / 写门视图（原 lib/index.js:1094–1167）
// ===========================================================================

/** Default cross-session messaging policy. */
export const DEFAULT_POLICY = {
	receiveMode: "ask",
	trustedSenders: [],
	blockedSenders: [],
	/**
	 * ★ 批 I（FR-I1）: 屏蔽的**作用域**从「部署级全局名单」改成「**两个会话之间的一对**」。
	 * 条目形状 `{ a, b, by, since }`（D2）：`a` / `b` 是这一对的两个会话 id（写入时按字典序
	 * 规范化 ⇒ A↔B 与 B↔A 是**同一条**），`by` 是**点屏蔽的那一方**（当事接收方）——它是
	 * D7「只有发起屏蔽的一方可以解除」的**唯一判定依据**，缺了它 D7 就无从判定；`since`
	 * 只作**留痕**（不参与任何判定）。
	 * `blockedSenders`（旧格式）**原样保留、不再新增**，检查时**并集**参与判定（D3/NF-I3：
	 * 旧记录不静默放开）；它的唯一出口是 `team_link_block action=clear-legacy sender=<id>`。
	 */
	blocks: [],
	rememberTargets: [],
	pairs: [],
	watchdogs: [],
	teams: [],
	/**
	 * §10.2 ② (§10.2.6 orphan guard): the durable `pending-creates` intents. An
	 * intent is written BEFORE its session is created and removed once the create
	 * resolves, so an intent left behind is the only surviving evidence that a
	 * create was attempted — the startup sweep reports it as an adoptable session
	 * instead of leaving a silent orphan.
	 *
	 * Declared here (not as `z.any()`) for the same reason the pair fields are: a
	 * DECLARED field is the one the canonical shape owns — the schema gives it a
	 * default and the settings UI can render it. What declaring does NOT do is
	 * gate survival: `schemastery` coerce-and-defaults, it does **not** drop
	 * undeclared keys (measured, 差异审计 B5 — that is exactly why `recoveries`,
	 * which this schema does not declare, survives a write/read cycle). The
	 * earlier wording here claimed the provider would strip an undeclared field;
	 * that reading was wrong, and it is the belief the audit traced §11.9.5⑦'s
	 * design error back to.
	 */
	pendingCreates: [],
	/**
	 * ★ FR-9（批 3 · **本批唯一触碰红线的点**）：总开关。
	 * `role=false` ⇒ **section 面**不注册（角色/宪章段；worker 的义务行同样归这一档）；
	 * `resources=false` ⇒ **context 面**不注册（资源行不挂宿主那条动态运行时上下文通道），
	 * 于是资源行在**三处全缺**（动态运行时上下文 / 状态卡第 ⑧ 段 / digest 脚注）。
	 * ★ 两面的区别见 {@link ROLE_SECTION_NAME} 那段注释（批 C 把资源行从提示段搬到了 context 通道，
	 * 本行原写的「提示段」自批 C 起不成立）。
	 * 缺省 true；键集变化必须与 README 的键集描述**同批**更新（U17），断言见 host-half.test.mjs。
	 */
	sections: { role: true, resources: true },
	/**
	 * ★ 批 34 / FR-7（跨仓交付 · **team-link 侧**）：台账写门的开关。
	 * 权威规格 = `dsh-thincoder-suite/docs/2026-10-14-anti-drift-design.md` §5 **FR-7**
	 * （规则① `done` 需 `claim` 来历 · 规则② `retract` 需同任务真实存在的指针 · fail-closed）；
	 * **嵌套形态**的依据 = 该档 §14 **L-9**（会诊 #78 裁定：三家一致建议嵌套，与 suite 侧同名键的
	 * 点号路径一致 ⇒ 将来加兄弟键不再动顶层键集锁）。默认 **OFF**（D7「先单队试点」）。
	 *
	 * ★ 开门语义 = **两侧各设一次**（L-9 的遗留项）：本键住在**本插件自己的** `PolicyConfig`
	 * 命名空间 `team-link` 里，由**本插件自己的设置面**改；suite 仓的 `anti_drift_config` 写的是
	 * **它自己**配置面上的同名键，对这里的门**完全无效**（D8 归属分家：一期无跨插件读取）。
	 */
	antiDrift: { ledgerTransitionGate: false },
};

export const POLICY_MODES = new Set(["ask", "accept", "reject"]);

/**
 * ★ 批 34 / FR-7：`antiDrift` 的归一化 —— 与 {@link sectionsView} 同族的一支。
 *
 * 判据 = **只有显式的 `true` 才开门**（手改出来的非布尔值一律按 OFF 读）。朝向刻意与
 * `sectionsView` 相反：总开关的缺省是「开」，一个坏值该降级成开；写门的缺省是「关」，
 * 一个坏值绝不能把门凭空**打开**。归一化视图又恰好是 `policy.update({...})` 的输入，
 * 所以这里也只输出这一支声明的键（固定键白名单，见 {@link normalizePolicy}）。
 */
export function antiDriftView(value) {
	return { ledgerTransitionGate: value?.ledgerTransitionGate === true };
}

// ===========================================================================
// 区段 ②：归一化全族 + 三个策略读助手（原 lib/index.js:1309–1610）
// ===========================================================================

/** Coerce any stored/patched value into a complete, well-typed policy view. */
export function normalizePolicy(value) {
	const stringList = (list) => Array.isArray(list) ? list.filter((item) => typeof item === "string") : [];
	const pairList = (list) => Array.isArray(list) ? list.filter((pair) => typeof pair?.a === "string" && typeof pair?.b === "string").map((pair) => ({
		a: pair.a,
		b: pair.b,
		createdAt: typeof pair.createdAt === "number" ? pair.createdAt : 0,
		provisional: pair.provisional === true,
		expiresAt: typeof pair.expiresAt === "number" && Number.isFinite(pair.expiresAt) ? pair.expiresAt : 0,
	})) : [];
	/**
	 * ★ 批 I（FR-I1 的第 3 点 / U16）: `blocks` 的归一化。三条规则：
	 *  ① **缺 `a` / `b` / `by` 的条目一律丢弃**，其余条目**原样保留** —— 一条坏的不能把整张
	 *     表带走，也不能被带进判定（`by` 缺失的条目连「谁能解」都答不出来，留着只会让
	 *     `isBlocked` 命中一条无人能解的屏蔽）；★ **U20**（用户 2026-10-12 追加项 D3）把**同一族**的
	 *     第二种死条目也挡在这里：`by` 落在这一对的 `a` / `b` **之外**（手工改出来的「第三人」）⇒
	 *     同样**丢弃那一条** —— 它按 D7 谁都解不开，与缺 `by` 是同一种畸形；
	 *  ② 顺序**按 `blockPair` 规范化**：手改/异构写出来的 `b,a` 顺序与 `a,b` 是同一对；
	 *  ③ 同一对**只留最早一条**（`by` 取最早那个发起方）—— 与写入侧 `blockSender` 的幂等
	 *     早退同口径（§9「互蔽」：第二个发起方的 `by` 被吞掉，这是**已知行为**，判定只看
	 *     条目在场、不看 `by`，所以对「谁都不能解」这一点没有影响）。
	 */
	const blockList = (list) => {
		if (!Array.isArray(list)) return [];
		const kept = [];
		const seen = new Set();
		for (const entry of list) {
			if (entry === null || typeof entry !== "object") continue;
			if (typeof entry.a !== "string" || entry.a === "") continue;
			if (typeof entry.b !== "string" || entry.b === "") continue;
			if (typeof entry.by !== "string" || entry.by === "") continue;
			const pair = blockPair(entry.a, entry.b);
			if (entry.by !== pair.a && entry.by !== pair.b) continue;   // U20：by 必须是这一对里的某一方
			const key = `${pair.a}\u0000${pair.b}`;
			if (seen.has(key)) continue;
			seen.add(key);
			kept.push({ a: pair.a, b: pair.b, by: entry.by, since: typeof entry.since === "string" ? entry.since : "" });
		}
		return kept;
	};
	return {
		receiveMode: POLICY_MODES.has(value?.receiveMode) ? value.receiveMode : "ask",
		trustedSenders: stringList(value?.trustedSenders),
		blockedSenders: stringList(value?.blockedSenders),
		blocks: blockList(value?.blocks),
		rememberTargets: stringList(value?.rememberTargets),
		pairs: pairList(value?.pairs),
		watchdogs: watchdogList(value?.watchdogs),
		teams: normalizeTeams(value?.teams),
		pendingCreates: pendingCreateList(value?.pendingCreates),
		sections: sectionsView(value?.sections),
		// ★ 批 34 / FR-7: 写门开关必须**在场**于这一份固定键白名单里 —— 不加这一行，
		// `policy.get().antiDrift` 恒为 `undefined`，门恒 OFF，而这正是盘上那个
		// 「接线在、声明不在」半成品的形态（设计档 §14 L-9）。
		antiDrift: antiDriftView(value?.antiDrift),
	};
}

/**
 * Normalized `pending-creates` intents (§10.2 ②; §10.2.6 orphan guard). These
 * are the durable twin of the in-memory intent map: written BEFORE a session is
 * created, removed when the create resolves, and reported by the startup sweep
 * when they outlive their TTL. An entry without a session id or with an
 * unusable deadline is dropped — it could never be reported or matched.
 */
export function pendingCreateList(list) {
	if (!Array.isArray(list)) return [];
	const entries = [];
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		if (typeof entry.sessionId !== "string" || entry.sessionId === "") continue;
		if (typeof entry.expiresAt !== "number" || !Number.isFinite(entry.expiresAt) || entry.expiresAt <= 0) continue;
		entries.push({
			team: typeof entry.team === "string" ? entry.team : "",
			role: typeof entry.role === "string" ? entry.role : "",
			sessionId: entry.sessionId,
			createdAt: typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : 0,
			expiresAt: entry.expiresAt,
			by: typeof entry.by === "string" ? entry.by : "",
		});
	}
	return entries;
}

/**
 * Normalized watchdog registrations: entries without an id or a watcher are
 * dropped (they can never be patrolled or cleared), and every other field is
 * coerced into its declared type. `team` is kept as `null` in this view when it
 * is empty — the M2 roster hook §3.2.2 allows `null` in v1.
 */
export function watchdogList(list) {
	if (!Array.isArray(list)) return [];
	const number = (item, fallback) => typeof item === "number" && Number.isFinite(item) ? item : fallback;
	const entries = [];
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		if (typeof entry.id !== "string" || entry.id === "") continue;
		if (typeof entry.watcherSession !== "string" || entry.watcherSession === "") continue;
		entries.push({
			id: entry.id,
			team: typeof entry.team === "string" && entry.team !== "" ? entry.team : null,
			watcherSession: entry.watcherSession,
			targets: [...new Set((Array.isArray(entry.targets) ? entry.targets : []).filter((target) => typeof target === "string" && target !== ""))],
			silentMinutes: number(entry.silentMinutes, WATCHDOG_DEFAULT_SILENT_MINUTES),
			intervalMinutes: number(entry.intervalMinutes, WATCHDOG_DEFAULT_INTERVAL_MINUTES),
			expiresAt: number(entry.expiresAt, 0),
			createdAt: number(entry.createdAt, 0),
			// ★ 批 G · FR-R4（设计档 §7「归一化白名单」行）：**加性**字段，必须同批加进白名单 ——
			//   这一份归一化是**固定键白名单**，不加这一行，`renewedAt` 每次读写循环都被**静默丢掉**
			//   （glm-5.3 在会诊里点名的坑；U7 钉的就是它）。
			//   旧行（以及**从未续期**的行）没有这个键 ⇒ 这里**不写这个键**（而不是写 `undefined`）：
			//   归一化视图是 `policy.update({ watchdogs })` 的输入，`JSON.stringify` 会丢掉值为
			//   `undefined` 的成员 —— 写成一个显式的 `undefined` 会让「落盘形状」随序列化路径漂移；
			//   「键不在场」才是「从未续期」的诚实表示（读面据此渲染「（从未续期）」，零迁移，
			//   与 `origin` 的加性引入同例）。
			...(typeof entry.renewedAt === "number" && Number.isFinite(entry.renewedAt) ? { renewedAt: entry.renewedAt } : {}),
			// FR-3（批 1）: 闭集外的值（手改的 settings 行）**降级为 manual** —— 降级方向是保守的
			// （auto 那一档是唯一会主动投摘要的，绝不因为一个手滑的字符串把它打开）。
			origin: entry.origin === WATCHDOG_ORIGIN_AUTO ? WATCHDOG_ORIGIN_AUTO : WATCHDOG_ORIGIN_MANUAL,
		});
	}
	return entries;
}

/**
 * Normalized M4 rotation slot (§3.6.2), or `null`. M2 has no rotation flow —
 * this only makes sure a `pending` written by a later milestone survives a
 * read/write cycle of the settings namespace instead of being silently dropped
 * (the namespace is shared, so a lossy normalizer would be a migration bug).
 */
export function normalizePending(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const session = typeof value.session === "string" ? value.session : "";
	const token = typeof value.token === "string" ? value.token : "";
	if (session === "" || token === "") return null;
	const expiresAt = typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) ? value.expiresAt : 0;
	const pending = {
		session,
		token,
		team: typeof value.team === "string" ? value.team : "",
		role: typeof value.role === "string" ? value.role : "",
		expiresAt,
		// The anti-storm window needs to know when this pending was minted; a
		// hand-written row without it is dated from its TTL (the invariant
		// expiresAt = createdAt + ROTATION_TTL_MS holds for every row we write).
		createdAt: typeof value.createdAt === "number" && Number.isFinite(value.createdAt) ? value.createdAt : Math.max(0, expiresAt - ROTATION_TTL_MS),
	};
	if (typeof value.note === "string" && value.note !== "") pending.note = value.note;
	// ★ 批 Q · FR-Q1 / D2：本次换届的**稳定标识**。归一化是**固定键白名单**，不加这一行，
	//   `rotationId` 每次读写循环都被静默丢掉（与批 G 的 `renewedAt` 逐字同一坑）。
	//   旧行（以及**升级前就存在的 pending**）没有这个键 ⇒ **不写这个键**（不是写 `undefined`）：
	//   「键不在场」正是「这次换届没有新标识」的诚实表示，读取侧据此走确定性推导
	//   `legacy:<角色名>`（见 `lib/rotation.js` 的 `pendingRotationRid`）。
	if (typeof value.rotationId === "string" && value.rotationId !== "") pending.rotationId = value.rotationId;
	// ★ 批 S · D13：批次标识与批次清单 —— **同一条白名单纪律**（批 G 的 `renewedAt`、批 Q 的
	//   `rotationId`、本批的 `batchId` / `batchRoles`）。不加这两行，`batchId` 在「写 → 读」那一步
	//   （以及重启后重新读 policy）就被**静默丢掉** ⇒ 批次互斥与 `roster get` 的批次分组一起失效，
	//   而且**不报错**（Sr14 三面判据咬的就是这条）。
	if (typeof value.batchId === "string" && value.batchId !== "") pending.batchId = value.batchId;
	// 批次清单（`[{ role, successor }]`）：清单落在 pending 行内（NF-S4 允许的落点），读面靠它把
	// 「已认领」如实归到这一批 —— claim 会清掉该角色自己的 pending，但同批次别的 pending 还在。
	if (Array.isArray(value.batchRoles)) {
		const roles = value.batchRoles.filter((item) => item !== null && typeof item === "object" && typeof item.role === "string" && item.role !== "" && typeof item.successor === "string" && item.successor !== "").map((item) => ({ role: item.role, successor: item.successor }));
		if (roles.length > 0) pending.batchRoles = roles;
	}
	// The idempotency marker of §3.6.2: the pairs this claim already migrated.
	// Non-empty ⇒ a previous claim got as far as the marker, so a retry replays
	// the recorded list instead of migrating twice.
	if (Array.isArray(value.migratedPairs)) pending.migratedPairs = value.migratedPairs.filter((pair) => pair !== null && typeof pair === "object" && typeof pair.a === "string" && typeof pair.b === "string").map((pair) => ({
		a: pair.a,
		b: pair.b,
		createdAt: typeof pair.createdAt === "number" && Number.isFinite(pair.createdAt) ? pair.createdAt : 0,
		provisional: pair.provisional === true,
		expiresAt: typeof pair.expiresAt === "number" && Number.isFinite(pair.expiresAt) ? pair.expiresAt : 0,
	}));
	return pending;
}

/** Normalized M4 ratification window of one role (§3.6.2 评审 #5), or null. */
export function normalizeProvisional(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const expiresAt = typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) ? value.expiresAt : 0;
	if (expiresAt <= 0) return null;
	return {
		at: typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0,
		expiresAt,
		session: typeof value.session === "string" ? value.session : "",
	};
}

/** Normalized M4 revocation snapshot of one team (§3.6.2), or null. */
export function normalizeRotationBackup(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
	const snapshot = {
		at: typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0,
		pairs: Array.isArray(value.pairs) ? value.pairs.filter((pair) => typeof pair?.a === "string" && typeof pair?.b === "string").map((pair) => ({ a: pair.a, b: pair.b, createdAt: typeof pair.createdAt === "number" ? pair.createdAt : 0, provisional: pair.provisional === true, expiresAt: typeof pair.expiresAt === "number" ? pair.expiresAt : 0 })) : [],
		trustedSenders: Array.isArray(value.trustedSenders) ? value.trustedSenders.filter((id) => typeof id === "string") : [],
		rememberTargets: Array.isArray(value.rememberTargets) ? value.rememberTargets.filter((id) => typeof id === "string") : [],
		roster: value.roster === null || typeof value.roster !== "object" ? null : value.roster,
	};
	return snapshot;
}

/**
 * 批 Q · FR-Q1: the **per-rotation** revocation snapshots of one team, normalized.
 *
 * 形状：`[{ rid, at, backup }, …]`（设计档 D1：数组能自带 at 与顺序，map 做不到）。
 * 一条没有 `rid` 的行无法被任何一次换届**精确取回** ⇒ 丢弃（它本来也进不了任何读面）；
 * 一条 `backup` 为 `null` / 非对象的行 ⇒ 丢弃（`normalizeRotationBackup` 返回 `null`，没有可还原字段）；
 * 一条 `backup: {}` 的空壳 ⇒ **保留**：归一化后它是**合法空快照**（`at: 0` ＋ 空集合 ＋ `roster: null`），
 * 不是坏值 —— 丢弃它会让读面凭空少一条（与代码一致：归一化只对 `null` / 非对象返回 `null`）。
 * 旧槽（`rotationBackup` 单槽）**不在这里折叠** —— 折叠要知道该团队的 pending 形状，
 * 所以它属于读取视图（`rotationEntriesOf`，见 `lib/rotation.js`）而不是归一化。
 */
export function normalizeRotationBackups(list) {
	if (!Array.isArray(list)) return [];
	const entries = [];
	const seen = new Set();
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		const rid = typeof entry.rid === "string" ? entry.rid : "";
		if (rid === "" || seen.has(rid)) continue;
		const backup = normalizeRotationBackup(entry.backup);
		if (backup === null) continue;
		seen.add(rid);
		const at = typeof entry.at === "number" && Number.isFinite(entry.at) && entry.at > 0 ? entry.at : backup.at;
		entries.push({ rid, at, backup });
	}
	return entries;
}

/**
 * One role's version history (§3.3.1), normalized: a record is
 * `{session, from, until|null, note?}` and `until: null` marks the tenure the
 * current holder is still serving. Records without a session are dropped — they
 * could never be attributed or closed.
 */
export function normalizeHistory(list) {
	if (!Array.isArray(list)) return [];
	const entries = [];
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		const session = typeof entry.session === "string" ? entry.session : "";
		if (session === "") continue;
		const record = {
			session,
			from: typeof entry.from === "number" && Number.isFinite(entry.from) ? entry.from : 0,
			until: typeof entry.until === "number" && Number.isFinite(entry.until) ? entry.until : null,
		};
		if (typeof entry.note === "string" && entry.note !== "") record.note = entry.note;
		entries.push(record);
	}
	return entries;
}

/** The roles of one team, normalized: nameless or duplicate roles are dropped,
 * an empty `current` becomes a vacant `null`. */
export function normalizeRoles(list) {
	if (!Array.isArray(list)) return [];
	const roles = [];
	const seen = new Set();
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		const role = typeof entry.role === "string" ? entry.role.trim() : "";
		if (role === "" || seen.has(role)) continue;
		seen.add(role);
		roles.push({
			role,
			current: typeof entry.current === "string" && entry.current !== "" ? entry.current : null,
			pending: normalizePending(entry.pending),
			rotationAt: typeof entry.rotationAt === "number" && Number.isFinite(entry.rotationAt) ? entry.rotationAt : 0,
			provisional: normalizeProvisional(entry.provisional),
			rotationStatus: typeof entry.rotationStatus === "string" ? entry.rotationStatus : "",
			history: normalizeHistory(entry.history),
			recoveries: normalizeRecoveries(entry.recoveries),
		});
	}
	return roles;
}

/**
 * The roster (§3.3.1) as this plugin reads it: teams with a legal `[a-z0-9-]+`
 * name, deduplicated, every nested field coerced. A team whose name is illegal
 * is dropped rather than kept — the name is a path segment of the blackboard, so
 * an illegal one must never reach `path.join` through a settings row.
 */
export function normalizeTeams(list) {
	if (!Array.isArray(list)) return [];
	const teams = [];
	const seen = new Set();
	/** §4.1（B 批）形态降级的留痕（进程内，见 {@link TEAM_MODE_DEGRADATIONS}）：每次归一化
	 * **重建**一遍，所以用户在设置 UI 改回合法值之后，那一行留痕会自己消失 —— 留痕跟着
	 * 事实走，不比事实活得久。 */
	const degradations = new Map();
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		const name = typeof entry.name === "string" ? entry.name : "";
		if (!TEAM_NAME_RE.test(name) || seen.has(name)) continue;
		seen.add(name);
		// §4.1: a value outside the closed set degrades to the DEFAULT mode and leaves a
		// trace on the read face — the same rule every other field follows ("a hand-edited
		// row degrades to a readable state, never to an unreadable namespace"). An empty
		// string (or a non-string) is not a degradation: it is the ABSENCE of the field,
		// which is what every pre-B settings row looks like (U1: 既有团队零迁移).
		const rawMode = typeof entry.mode === "string" ? entry.mode : "";
		const mode = TEAM_MODES.has(rawMode) ? rawMode : TEAM_MODE_SESSIONS;
		if (rawMode !== "" && !TEAM_MODES.has(rawMode)) degradations.set(name, rawMode);
		teams.push({
			name,
			createdAt: typeof entry.createdAt === "number" && Number.isFinite(entry.createdAt) ? entry.createdAt : 0,
			workspace: typeof entry.workspace === "string" ? entry.workspace : "",
			policy: { writer: entry.policy?.writer === "any" ? "any" : "coordinator" },
			roles: normalizeRoles(entry.roles),
			rotationBackup: normalizeRotationBackup(entry.rotationBackup),
			// 批 Q · FR-Q1（D1/D6）：**团队行内部**的新集合 —— 顶层键一个不加（U19_POLICY_KEYS 原样）。
			// 旧行没有这个键 ⇒ 归一化补一个空集合（与 roles / history 同一条读时补齐纪律）；
			// 旧单槽 `rotationBackup` 仍是只读迁移源，折叠在 `rotationEntriesOf`（读取视图）里发生。
			rotationBackups: normalizeRotationBackups(entry.rotationBackups),
			mode,
			leadSessionId: typeof entry.leadSessionId === "string" ? entry.leadSessionId : "",
		});
	}
	TEAM_MODE_DEGRADATIONS.clear();
	for (const [name, raw] of degradations) TEAM_MODE_DEGRADATIONS.set(name, raw);
	return teams;
}

/** True when the two sessions share an approved auto-relay pair that is still
 * live at `now` — see {@link pairRecordBetween} for the expiry rule. */
export function pairBetween(view, a, b, now = Date.now()) {
	return pairRecordBetween(view, a, b, now) !== null;
}

/** The LIVE pair record joining two sessions, or null. The record (not just the
 * boolean) is what the M4 provisional face needs: a rotation may have granted
 * the channel without a present user, and the sender has to be told that this
 * delivery rides a channel with a 24h rollback (§3.6.2 评审 #3).
 *
 * 评审 #8: an expired provisional record counts as NO pair (the delivery side
 * stops honouring the channel at its deadline, not only when the sweep happens
 * to run), and a live record wins over an expired one — a pairing created after
 * the deadline must never be shadowed by the dead row it superseded. */
export function pairRecordBetween(view, a, b, now = Date.now()) {
	const matches = view.pairs.filter((pair) => (pair.a === a && pair.b === b) || (pair.a === b && pair.b === a));
	return matches.find((pair) => !isExpiredProvisionalPair(pair, now)) ?? null;
}

/** Append one sender id to a policy list without ever duplicating it. */
export function withSender(list, senderId) {
	return list.includes(senderId) ? list : [...list, senderId];
}

// ===========================================================================
// 区段 ③：状态落点（文件名 / 折叠结局 / 原因码 / home 注入 / 解析）（原 lib/index.js:1644–1754）
// ===========================================================================

/** §3.2: the global sub-directory (under the resolved home) holding the policy file. */
export const POLICY_FILE_DIR = "team-link";
/** §3.2/§3.3: the file itself. */
export const POLICY_FILE_NAME = "policy.json";
/**
 * §3.5 落点行的三个「拿不到可写的落点」原因码。前两个是设置服务侧的（服务在场却
 * 注册不出本命名空间的 scope，含 register 被拒），后两个是文件侧的（同源：路径解析
 * 失败 / 写不进去）。`not-active` 是残余原因：设置服务还没来、文件后端也还没建立
 * 过 —— 此时「仅进程内存」是一条**待定**读数，不是已证实的丢失。
 */
/**
 * {@link adoptMemoryWindow} 的「本次链上没有折叠发生」那一个结局（代码评审修复轮 🔵#3 用它当
 * `foldedAt` 盖戳门的判据，与它的文案共用一个常量，免得一改文案就静默失配）。
 */
export const MEMORY_WINDOW_OUTCOME_NONE = "none (no writes while unattached)";
/**
 * 代码评审第 3 轮 🟡#1：`foldedAt` 盖戳门从「不是 {@link MEMORY_WINDOW_OUTCOME_NONE} 就算
 * 折叠发生过」收紧成「**确已落定**的两个结局」才盖 —— `fold failed` 对旧判据取真，于是链尾
 * 照样盖新戳，与 §3.4「宁可漏盖不冒盖」相反（且该结局下链尾连回写都不做，见 attach 的链）。
 * 三个结局词与 {@link adoptMemoryWindow} 的返回值共用同一组常量（同 🔵#3 的理由：判据与
 * 文案共用一个词，一改文案就静默失配）。
 */
export const MEMORY_WINDOW_OUTCOME_NOT_FOLDED = "not folded (settings namespace already in use)";
export const MEMORY_WINDOW_OUTCOME_FOLDED = "folded into settings";
export const MEMORY_WINDOW_OUTCOME_FOLD_FAILED = "fold failed";
/** §3.4 盖戳门的判据：本次链上**确有折叠/裁决落定**（两个 landed 结局之一）才有资格盖新 `foldedAt`。 */
export function memoryWindowOutcomeLanded(outcome) {
	return outcome === MEMORY_WINDOW_OUTCOME_FOLDED || outcome === MEMORY_WINDOW_OUTCOME_NOT_FOLDED;
}
export const POLICY_REASON_NOT_ACTIVE = "not-active";
export const POLICY_REASON_NO_REGISTER = "no-register";
export const POLICY_REASON_PATH_UNRESOLVED = "路径解析失败";
export const POLICY_REASON_UNWRITABLE = "文件不可写";
/**
 * §3.5 的**第 5 个**文件侧原因码（代码评审修复轮 🟡#1）。与既有四项并列：载入时判定文件损坏
 * （读不出 / 非法 JSON / 没有 policy 对象）⇒ 插件**一律不覆盖**那份文件，状态落内存，
 * 并把「人工处置 = 修好或移走该文件」这条**用户唯一出口**写进文档（AGENTS.md §七）。
 */
export const POLICY_REASON_CORRUPT = "文件损坏（不覆盖；请人工处理）";

/**
 * Test seam (§3.2): the `{env, homedir}` pair the resolver reads. `null` = production
 * (`process.env` + `os.homedir()`); an object pins both inputs, which is how a fixture
 * gets a private DSH_HOME and how U7 exercises the two fallback branches. Same shape
 * as the existing `teamSessionInjectNow` clock seam.
 */
let policyHomeInject = null;
export function policyHomeSources() {
	return policyHomeInject === null ? { env: process.env, homedir: () => os.homedir() } : policyHomeInject;
}

/**
 * True when a normalized policy view holds NOTHING the user or a tool has put
 * there — every field at its declared default. This is the one predicate that
 * licenses a wholesale write of the current namespace, so it has to name EVERY
 * field, and so must the writes it licenses: {@link adoptMemoryWindow}'s patch is
 * the other half of this licence (the legacy migration's write is deliberately
 * scoped to the five trust fields and is NOT wholesale — it must not carry a
 * roster or a pending-create intent). Both halves are checked below against
 * {@link DEFAULT_POLICY}: the two writers that consume the predicate
 * (`migrateLegacyPolicy`'s guard, `adoptMemoryWindow`) used a five-field subset
 * before, which is how a namespace holding a roster could still read as "at
 * defaults" — and the ② round repeated the shape one level down by adding
 * `pendingCreates` to the predicate while the fold's patch kept writing the seven
 * older keys (差异审计修复轮 🟡-1). Fields added to {@link DEFAULT_POLICY} belong
 * here AND in every wholesale write, in the same change.
 */
export function policyIsAtDefaults(view) {
	return view.receiveMode === DEFAULT_POLICY.receiveMode
		&& view.trustedSenders.length === 0
		&& view.blockedSenders.length === 0
		// 批 I（FR-I1）: 新增键必须进这个判据 —— 它许可的是「整份命名空间写入」，漏一个键就会
		// 把用户点过的屏蔽（配对屏蔽）悄悄判成「命名空间是空的」，从而让一次折叠把它抹掉。
		&& view.blocks.length === 0
		&& view.rememberTargets.length === 0
		&& view.pairs.length === 0
		&& view.watchdogs.length === 0
		&& view.teams.length === 0
		&& view.pendingCreates.length === 0
		// FR-9: 新增键必须进这个判据（它许可的是「整份命名空间写入」，漏一个键就会把用户
		// 关掉的开关悄悄翻回缺省）。
		&& view.sections.role === DEFAULT_POLICY.sections.role
		&& view.sections.resources === DEFAULT_POLICY.sections.resources
		// ★ 批 34 / FR-7: 同一条理由 —— 漏了它，一个把写门打开的命名空间会被判成「全是缺省」，
		// 于是一次晚挂折叠/旧命名空间迁移就能把用户打开的门悄悄翻回 OFF。
		&& view.antiDrift.ledgerTransitionGate === DEFAULT_POLICY.antiDrift.ledgerTransitionGate;
}

/**
 * §3.2 路径解析（本设计档新增；插件此前完全不读环境）。纯函数：没有 ctx、没有副作用，
 * 所以三支读数都能被直接断言。`env` / `homedir` 是注入点 —— 生产读 `process.env` 与
 * `os.homedir()`，测试注入夹具的私有 home（测试进程永远不许碰到真实的 ~/.dsh）。
 * @returns {{ok: true, file: string, dir: string, source: string}|{ok: false, reason: string}}
 */
export function resolvePolicyFilePath(sources = policyHomeSources()) {
	const fromEnv = typeof sources?.env?.DSH_HOME === "string" ? sources.env.DSH_HOME.trim() : "";
	if (fromEnv !== "") {
		const dir = path.join(fromEnv, POLICY_FILE_DIR);
		// 落在**全局**目录，不落工作区：团队按名字全局寻址，放工作区会造成「换个工作区
		// 团队就没了」（设计档 §3.2）。
		return { ok: true, dir, file: path.join(dir, POLICY_FILE_NAME), source: "DSH_HOME" };
	}
	let home = "";
	try { home = typeof sources?.homedir === "function" ? String(sources.homedir() ?? "") : ""; } catch { home = ""; }
	if (home.trim() !== "") {
		const dir = path.join(home.trim(), ".dsh", POLICY_FILE_DIR);
		return { ok: true, dir, file: path.join(dir, POLICY_FILE_NAME), source: "homedir" };
	}
	// 两者都拿不到 ⇒ 落第 3 档（进程内存 + warn），不猜任何目录。
	return { ok: false, reason: POLICY_REASON_PATH_UNRESOLVED };
}

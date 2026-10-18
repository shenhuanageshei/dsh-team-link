// ---------------------------------------------------------------------------
// 域档：policy store 的生命周期本体 —— 批 R 第 22 小单从 `lib/index.js` 原样搬出
// ---------------------------------------------------------------------------
// 归属：docs/2026-10-15-store-compliance-design.md §4 D1/D2/D4 · §5 FR-R1 · §6（拆分不变量 ①–⑤）。
// 本档只装**一个**函数：`createPolicyStore(ctx)` —— 状态落点 / 载入 / 原子落地 / 折叠加盖 /
// 旧命名空间迁移 / 落点行 / `onAttach` 链，即 store 的**生命周期本体**。
//
// ★ 为什么是**新档**而不是并进 `lib/policy-store.js`：那一档承载的是**纯函数族**（归一化 /
//   落点解析 / 折叠结局词），它的档头把「store 生命周期本体」明确登记为后续小单的活；两档的依赖
//   方向是单向的：本档 → `./policy-store.js`（纯函数族）· `./shared.js`（`describeError`）。
//
// ★ 被钉符号（本仓 `hostSource` 文本锁钉住的 9 个）在这一块里出现**两条**：`writePolicyFileAtomic` /
//   `POLICY_FILE_SCHEMA` —— 它们**没有搬**（定义与文档注释仍逐字节住在入口），只作为依赖经缝传入。
//   另有 `POLICY_NAMESPACE` / `LEGACY_POLICY_NAMESPACE` / `PolicyConfig` / `PLUGIN_LABEL` 四条同样
//   只注入（入口侧仍在使用 / 是定义在入口的 schemastery schema；域档 import 入口会成环）。
//
// ★ 依赖方向（模块图无环）：本档两条出边 = `./policy-store.js` / `./shared.js`，两条都不回指本档、
//   也不回指入口 ⇒ 没有新环。宿主说明符只有既有的 `node:path` / `node:fs`（白名单里那两条）。
//
// ★ 装配缝（先例：`lib/forensics.js` 的 `wireForensics()`）：本档需要的 6 条入口侧绑定**只注入、
//   不搬**。前置：入口在**模块求值**时调用一次（`lib/index.js` 模块尾部）。后置：本档模块级 `let`
//   全部绑定到入口那一份真实现，此后每次调用读到的都是它。
//
// ★ 搬运纪律（D4）：本档新增的只有 ① 本段档头 ② 4 条 import ③ 装配缝 ④ 定义行前的 `export `；
//   **函数体 / 注释 / 缩进 / 文案一个字符都没动**（逐字节等价机检见交付报告）。
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_POLICY, MEMORY_WINDOW_OUTCOME_FOLDED, MEMORY_WINDOW_OUTCOME_FOLD_FAILED, MEMORY_WINDOW_OUTCOME_NONE, MEMORY_WINDOW_OUTCOME_NOT_FOLDED, POLICY_FILE_NAME, POLICY_REASON_CORRUPT, POLICY_REASON_NOT_ACTIVE, POLICY_REASON_NO_REGISTER, POLICY_REASON_UNWRITABLE, memoryWindowOutcomeLanded, normalizePolicy, policyIsAtDefaults, resolvePolicyFilePath } from "./policy-store.js";
import { describeError } from "./shared.js";

// ---------------------------------------------------------------------------
// 装配缝 · `wirePolicyStoreLifecycle(extras)`（先例：`lib/forensics.js` 的 `wireForensics()`）
// ---------------------------------------------------------------------------
let PLUGIN_LABEL, POLICY_NAMESPACE, LEGACY_POLICY_NAMESPACE, PolicyConfig, writePolicyFileAtomic, POLICY_FILE_SCHEMA;

/** 入口侧出口的一次性绑定（见档头的前置 / 后置）。 */
export function wirePolicyStoreLifecycle(extras) {
	({
		PLUGIN_LABEL,
		POLICY_NAMESPACE,
		LEGACY_POLICY_NAMESPACE,
		PolicyConfig,
		writePolicyFileAtomic,
		POLICY_FILE_SCHEMA,
	} = extras);
}
export function createPolicyStore(ctx) {
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

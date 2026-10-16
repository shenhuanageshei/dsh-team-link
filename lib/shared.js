// ---------------------------------------------------------------------------
// 共享档：宿主半边**多域共用**的基础助手 —— 批 R（上架合规）从 `lib/index.js` 原样搬出
// ---------------------------------------------------------------------------
// 归属：docs/2026-10-15-store-compliance-design.md §6「边界规则」（共享物抽到
//       `lib/shared.js`，各域从它导入）· §4 D1/D2/D4 · §5 FR-R1 · §8 Rr1/Rr3/Rr4。
//
// ★ 为什么需要它（拆分契约 §6 第 ③ 条「模块图无环」）：域档**不能**从入口 `lib/index.js`
//   静态导入共享物 —— 那会构成 ESM 环（入口 → 域档 → 入口）。把共享物下沉到本档后，模块图
//   是单向的 DAG：入口 → 共享档 · 入口 → 域档 · 域档 → 共享档。
// ★ 成员口径：**被 ≥2 个域使用、且本批已搬出的域需要它**的符号。本次四条 —— `localStamp` /
//   `preview` / `describeError` / `agentSessionId`（交付时实测入边数 3 / 19 / 48 / 6）。
//   四条都不是 `hostSource` 文本锁钉住的符号 ⇒ 可以下沉；被钉符号则**不能**搬 —— 那些锁
//   把符号的**相对位置**当判据（成对锚点切片：`hostSource.slice(indexOf(A), indexOf(B))`，
//   例如 `buildTeamSessionCreateOptions` … `buildTeamSessionResumeOptions` 那一条），
//   搬走一个就把切片打断。本档四条经逐条核对**均不在**被钉名单里。
// ★ 搬运纪律（D4）：**函数体与文档注释逐字节原样** —— 只加 `export`；一行逻辑 / 文案 / 判据未改。
// ★ 零 import：四条都是自洽的纯函数 ⇒ 本档不引入任何依赖（宿主说明符面一个字符未动）。
// ★ 对外契约（D2）：入口仍是 `lib/index.js`（`package.json` 的 `main` / `exports` 一字未动），
//   它从这里 `import` 后把同一批绑定用在同一批调用点上（含 `wireForensics()` 那条注入缝）——
//   对外名字 / 签名 / 语义逐字不变。
// ---------------------------------------------------------------------------

/**
 * Local `YYYY-MM-DD HH:mm:ss` stamp for relay banners. The audited
 * `agent-message` source admits exactly `{kind, form, senderSessionId}`, so the
 * delivery time has no home there and travels in the message body instead —
 * where the receiving card reads it back.
 *
 * `withSeconds === false` yields the same stamp truncated to the minute
 * (`YYYY-MM-DD HH:mm`) — the shape the ledger's derived view renders its claim
 * times in (§9.3.3). Both shapes are built from ONE local basis by one field
 * construction on purpose: every time this plugin *renders* has to be comparable
 * on sight with the `（读数 …）` line printed at the foot of the same screen (see
 * {@link taskStamp}).
 */
export function localStamp(date = new Date(), withSeconds = true) {
	const pad = (n) => String(n).padStart(2, "0");
	const minute = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
	return withSeconds ? `${minute}:${pad(date.getSeconds())}` : minute;
}

/**
 * Single-line preview of arbitrary text. Cuts on code-point boundaries only: a
 * code-unit slice can split a surrogate pair and leave a lone surrogate — half
 * an emoji — in the returned string, and a lone surrogate forwarded into the
 * next model request fails that request with HTTP 400 INVALID_REQUEST for the
 * rest of the session (see `wellFormed`). The limits themselves are unchanged;
 * only the counting unit is: `[...flat]` iterates code points, so a preview is
 * truncated when it exceeds `limit` code points, not code units.
 */
export function preview(text, limit = 120) {
	const flat = String(text ?? "").replace(/\s+/gu, " ").trim();
	const chars = [...flat];
	return chars.length <= limit ? flat : `${chars.slice(0, limit - 1).join("")}…`;
}

/** Human-readable one-line description of a thrown error. */
export function describeError(error) {
	if (error !== null && typeof error === "object" && typeof error.code === "string" && error.code !== "") {
		return `${error.code}: ${error.message ?? ""}`.trim();
	}
	if (error instanceof Error) return error.message;
	return String(error);
}

/** Session id of the agent executing a tool call, when known. */
export function agentSessionId(exec) {
	return typeof exec?.agent?.id === "string" && exec.agent.id !== "" ? exec.agent.id : undefined;
}

// ---------------------------------------------------------------------------
// 共享档 · 追加（批 R 第 4 小单）：段渲染与预算域**需要、且宿主半边多域共用**的共享物
// ---------------------------------------------------------------------------
// 归属：docs/2026-10-15-store-compliance-design.md §6「边界规则」（共享物抽到 `lib/shared.js`，
//       各域从它导入）· §4 D4 · §5 FR-R1 · §8 Rr3/Rr4。
// ★ 与上面那一节的关系（**本档成员总数现为 4 + 16 = 20**，实测 `^export` 计数）：上面那四条（`localStamp` /
//   `preview` / `describeError` / `agentSessionId`）是第 3 小单（ledger 域）那一波；本节这一批 16 条是
//   第 4 小单（sections 域）这一波 —— 各节标题里的「本次 / 本节」都只指自己那一波。
// ★ 为什么要下沉（Rr4「模块图无环」）：域档**不能**从入口 `lib/index.js` 静态导入 —— 那会构成
//   ESM 环（R-2 的 forensics 档因此走的是装配缝注入）。sections 域的三个渲染出口要用 `wellFormed`
//   （本插件唯一的模型可见文本收口点），`sectionsView` / `COORDINATOR_ROLE` 是被多域共用的基础物
//   ⇒ 一并下沉到本档，入口与域档都从这里取（**单一事实源**，不复制两份）。
// ★ 两条**注入缝**（`setStripImpl` / `stripImplIsDefault`）同批搬来：它们改写的 `stripImpl` 是本档
//   的模块级 `let`，而 ESM 的导入绑定在**导入方是只读的** —— 缝必须与它改写的绑定同住一档，
//   否则 `__testing.setStripImpl(...)` 会在真机上抛（U7 的判据当场红）。函数体逐字节原样：
//   原位置是 `__testing` 对象里的两条内联箭头，那里现在按名引用本档这两个导出。
// ★ 搬运纪律（D4）：**符号定义与其文档注释逐字节原样** —— 只加 `export `；一行逻辑 / 文案未改。
// ★ 零宿主依赖：本节新增的名字里没有一个引入 `import`（`wellFormed` 一族只用 JS 原生正则与
//   码点）⇒ 宿主说明符面一个字符未动。
// ---------------------------------------------------------------------------
/**
 * A lone surrogate must never leave this plugin: the orchestrator forwards tool
 * output verbatim into the next model request, and an unpaired surrogate makes
 * that request fail with HTTP 400 INVALID_REQUEST — permanently, for the whole
 * session (observed on 4/4 logged sessions that carried one over
 * deepseek-official). `preview`/`truncate` keep this plugin from CREATING a lone
 * surrogate; this pass also repairs one that entered from outside — an older
 * build's log, a cross-session message body, an echoed tool argument. The
 * unpaired half becomes U+FFFD; nothing else in the string changes.
 * `String.prototype.toWellFormed` (Node >= 20) is the native equivalent, the
 * regex is the fallback for older runtimes.
 */
export const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Lone-surrogate 修复本身（批 E：从 {@link wellFormed} 里提出来，**行为逐字不变**）——
 *  三个 `wellFormed*` 收口点共用它，于是每一处都只需接**一次**消毒（§6.5 v1.1 之后消毒没有
 *  任何可重复计数的状态：处数是写进文本里的编号，重复跑一遍也只会看到「零命中」）。 */
export function repairSurrogates(value) {
	const text = String(value ?? "");
	return typeof text.toWellFormed === "function" ? text.toWellFormed() : text.replace(LONE_SURROGATE, "\uFFFD");
}

/**
 * ★ 批 E（FR-2）: 修好 lone surrogate 之后**再过一道框定 token 消毒**（{@link sanitizeFraming} ——
 * 消毒函数外面那一层注入缝，U7 的桩塞在它下面；设计档 `docs/2026-10-11-token-sanitize-design.md`
 * §6.3）—— 于是本插件全部 10 个工具的模型可见文本都经这一个收口点。替换处数**写进文本本身**
 * （§6.5 v1.1：占位符带编号，见 {@link FRAMING_PLACEHOLDER}），所以这里不需要任何累加器 /
 * 执行上下文；无替换时返回的字符串**逐字节等于**入参（NFR-2 / U6）。
 */
export function wellFormed(value) {
	return sanitizeFraming(repairSurrogates(value)).text;
}

/** Well-formed copy of a content block array: text blocks are repaired, every
 * other block (and a non-array) passes through untouched.
 * ★ 批 E（FR-2）: 文本块走的是**同一个**收口点（修复 + 消毒各一次），非文本块与
 * 非数组原样透过 —— 签名与返回形状都不变。 */
export function wellFormedContent(content) {
	if (!Array.isArray(content)) return content;
	return content.map((block) => block?.type === "text" && typeof block.text === "string" ? { ...block, text: sanitizeFraming(repairSurrogates(block.text)).text } : block);
}

// ---------------------------------------------------------------------------
// 框定 token 消毒面（批 E；设计档 docs/2026-10-11-token-sanitize-design.md）
//
// ★ 本节的**文本纪律**（设计档 §6.1）：那个框定 token 是 DeepSeek 的**特殊 token**，
//   **逐字写进源码 / 测试 / 文档 / 脚本 / 工具参数**，本身就会提高「写这一动作」被判
//   `MALFORMED_RESPONSE` 的概率（父侧 2026-10-11 因此自伤两次）⇒ **构造它必须用码点**
//   （{@link FULLWIDTH_BAR}），体检 / 消毒工具的输出也必须遮蔽成 `[BARS]`。
//   匹配式认的是**整个包裹结构**（两枚全角竖线夹 `[A-Za-z_]{0,20}`），
//   紧邻的前导 `<` `/` 是**可选**前缀 —— 形态取证里那 40 例就是**裸包裹**（§2.3）。
// ---------------------------------------------------------------------------

/** 全角竖线 U+FF5C —— **不是** ASCII 的 `|`（ASCII 那个是表格 / 数学记号里的正当字符）。 */
export const FULLWIDTH_BAR = String.fromCharCode(0xff5c);
/** 包裹结构的两侧（两枚全角竖线）。 */
export const FRAMING_WRAP = FULLWIDTH_BAR + FULLWIDTH_BAR;
/** ★ 匹配式**由码点拼出**（源码里因此没有原串）：`(?:</?)?` + 两竖线 + 词 + 两竖线，`g` 才能在
 * 一行里替掉多处；处数**逐处**计数（不是「这条字符串脏了」），并写进占位符的编号里（§6.5 v1.1）。 */
export const FRAMING_RE = new RegExp(`(?:</?)?${FRAMING_WRAP}[A-Za-z_]{0,20}${FRAMING_WRAP}`, "gu");
/** 替换文本：纯 ASCII、与原 token **无关**（NF-5 禁止「长得像」的占位符 —— 占位符自己也可能被
 * 解析器认出来）。用户 2026-10-11 已拍板（设计档 §0.3 ②）。
 *
 * ★ v1.1（§6.5）：这一串**自带编号** —— 命中 **1** 处仍是逐字的 `[framing-token-removed]`，
 * 命中 **N > 1** 处则是 `[framing-token-removed 1/N]` … `[… N/N]`。**处数是文本自己的一部分**，
 * 于是「不改回执、不加累加器、不新增 import」三件事同时成立：工具回执里的处数由被替换出来的
 * 那串直接呈现；无替换时文本逐字节原样（U5 / U6 因此是结构性的，不靠判断）。 */
export const FRAMING_PLACEHOLDER = "[framing-token-removed]";

/** 第 i / n 处的编号占位符（`n === 1` 时**不带**编号 —— 保持用户在 §0.3 ② 拍板的那一串逐字不变）。 */
export function framingPlaceholderAt(index, total) {
	return total === 1 ? FRAMING_PLACEHOLDER : `${FRAMING_PLACEHOLDER.slice(0, -1)} ${index}/${total}]`;
}

/**
 * 消毒：把框定 token 的**整个包裹结构**替换成 {@link FRAMING_PLACEHOLDER}（多处带编号）。
 *
 * 前置：`text` 可为任意值（含 `undefined` / 数字 / `null`）。
 * 后置：返回 `{ text, removed }`。`removed === 0` ⇒ `text` **逐字节等于**入参
 * （NFR-2 / U6：不改原文其余部分 —— 干净文本走的是 `return { text, removed: 0 }` 这条
 * **不经过 `replace`** 的路径）。
 *
 * ★ **fail-open 落在缝上**（NFR-3 / U7）：本函数是 U7 的**注入缝** `stripImpl` 的**默认实现**，
 * 而调用点一律经 {@link sanitizeFraming}；后者把「实现自己抛错 / 返回畸形值」一律折成
 * 「原样返回、`removed = 0`」。这里**不再**自包一层 `try` —— 缝若被换成别的东西（U7 的桩就
 * **必抛**），抛出点根本不在本函数里，包在这里反而盖不住（见 {@link sanitizeFraming}）。
 * 本实现自身只用 JS 原生正则与码点，结构上不会抛（设计档 §9「重启 / 升级」一行）。
 *
 * @param text - 任意值；只有字符串会被检查。
 * @returns `{ text, removed }` —— `removed` 是**替换处数**（同一字符串里多处则逐个计数）。
 */
export function stripFramingTokens(text) {
	if (typeof text !== "string" || text === "") return { text, removed: 0 };
	// ★ 先数一遍再替换：编号要带**总处数**（`1/N`），而 `replace` 的回调是在替换途中
	// 逐个调用的 —— 总处数只能来自一次独立扫描（`matchAll` 与 `replace` 用同一个
	// global 正则；`matchAll` 内部会克隆正则，不会把 `lastIndex` 留在 `FRAMING_RE` 上）。
	const hits = [...text.matchAll(FRAMING_RE)].length;
	if (hits === 0) return { text, removed: 0 };
	let index = 0;
	const out = text.replace(FRAMING_RE, () => {
		index += 1;
		return framingPlaceholderAt(index, hits);
	});
	return { text: out, removed: hits };
}

/**
 * ★ U7 的**注入缝**（设计档 §6.5）：模块内一个可替换的间接层。生产路径永远解析到
 * {@link stripFramingTokens}；`__testing.setStripImpl` 塞进一个「必抛」的桩，用来证明
 * 「消毒自己坏了，工具照常成功、返回原文本」（fail-open）。用一个装订在模块上的引用而不是
 * 让每个调用点都查一次注入对象：热路径保持在一次函数调用。
 */
export let stripImpl = stripFramingTokens;

/** 当前生效的消毒实现（调用点只经这一层，注入缝才对所有收口点同时生效）。
 *
 * ★ 批 E：**fail-open 必须落在缝上**（NFR-3 / U7）—— 注入缝被换成别的东西（U7 的桩就**必抛**，
 * 一个坏实现也可能返回 `undefined` / 非字符串的 `text`）时，抛出点在这个调用里，**不在**
 * {@link stripFramingTokens} 里面（后者现在是缝的默认实现，自己不再包 `try`）。任何这类情况
 * 一律**原样返回** `{ text, removed: 0 }`：消毒永远不能让任何工具调用失败。
 *
 * ★ v1.1（§6.5）：处数**不再需要任何通道** —— 它是被替换出来的那串编号占位符自身的一部分，
 * 于是这里只剩「消毒 + 兜底」一件事，没有累加器、没有执行上下文、没有回执追加。 */
export function sanitizeFraming(text) {
	try {
		const result = stripImpl(text);
		return result !== null && typeof result === "object" && typeof result.text === "string" && result.removed > 0
			? { text: result.text, removed: result.removed }
			: { text, removed: 0 };
	} catch {
		return { text, removed: 0 };
	}
}

/** FR-9 的总开关：归一化成两个布尔（手改出来的非布尔值按缺省 true 读）。 */
export function sectionsView(value) {
	return {
		role: value?.role === false ? false : true,
		resources: value?.resources === false ? false : true,
	};
}

/** The convention role whose incumbent is the writer under the default
 * `policy.writer === "coordinator"` (§3.3.1/§3.3.2); other roles are free-form. */
export const COORDINATOR_ROLE = "coordinator";

/** U7 注入缝 / 「已还原」读数的**导出形态**（第 4 小单随 `stripImpl` 一并下沉；函数体逐字节原样，
 *  只把它从 `__testing` 对象里的内联箭头提成具名导出 —— 那里的两个键现在按名引用本档）。 */
export const setStripImpl = (fn) => { stripImpl = typeof fn === "function" ? fn : stripFramingTokens; };
export const stripImplIsDefault = () => stripImpl === stripFramingTokens;

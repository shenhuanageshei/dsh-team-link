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

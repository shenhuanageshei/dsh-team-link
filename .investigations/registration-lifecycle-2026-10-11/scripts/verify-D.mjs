// verify-D.mjs —— 批 D 真机验收（设计档 §8 的 U9），一条命令出结论。
//
// 用法：
//   node verify-D.mjs "<会话文件 .v4.jsonl.zstd 绝对路径>" "<本次重启时刻 ISO，如 2026-10-11T02:00:00Z>"
//
// 它验的是**批 D 的 FR-1（自愈可达）在真机上成不成立**：
//   ① 重启之后**不跑任何命令**，该会话自己就带上了角色文本（系统提示里含义务行/宪章）
//   ② 该会话的动作上下文快照里出现 `[team-link 会话资源]` 行
//   ③ ★ 决定性一项：**整个窗口内、该工作区的任何会话都没有跑过名册写入**
//      —— 名册写入是批 D 之前的旧通路，有它在，前两项即使成立也是**空转**
//
// 判据：
//   PASS = ①②③ 同时成立
//   ①② 成立但 ③ 不干净 ⇒ **无法判**，别读成通过
//   ① 或 ② 缺 ⇒ FAIL
//
// 实现要点（两个都踩过坑）：
//   · 会话日志是多帧 zstd，Node 自带的 zstdDecompressSync 只出**第一帧** ⇒ 逐帧走帧头；
//   · 快照消息的文本在 `data.content`（user/message），系统提示在 `data.message.content`（system/message）—— 两者不同；
//   · ③ 要扫**同工作区的其他会话**（名册写入发生在调用方那个会话里），
//     且必须**全扫**（按 mtime 截断会把更早写入的会话挤掉）⇒ 用 decodeSince：帧边界不解压就能走，
//     只解压「最早事件仍 >= 重启时刻」的那些帧，代价从「整档解压」降到「尾部几帧」。

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const [src, restartArg] = process.argv.slice(2);
if (src === undefined || restartArg === undefined) {
	console.error("用法: node verify-D.mjs <session.v4.jsonl.zstd> <重启时刻 ISO>");
	process.exit(2);
}
const RESTART = Date.parse(restartArg);
if (Number.isNaN(RESTART)) {
	console.error(`重启时刻解析失败: ${restartArg}`);
	process.exit(2);
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function frameEnd(b, off) {
	if (b.readUInt32LE(off) !== 0xfd2fb528) return -1;
	let p = off + 4;
	const fhd = b[p++];
	const fcsFlag = (fhd >> 6) & 3;
	const single = (fhd >> 5) & 1;
	const checksum = (fhd >> 2) & 1;
	if (!single) p += 1;
	p += [0, 1, 2, 4][fhd & 3];
	p += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
	for (;;) {
		const h = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
		p += 3;
		const last = h & 1;
		const bt = (h >> 1) & 3;
		const bs = (h >> 3) & 0x1fffff;
		if (bt === 0 || bt === 2) p += bs;
		else if (bt === 1) p += 1;
		else return -1;
		if (last) break;
	}
	if (checksum) p += 4;
	return p;
}
const parse = (l) => { try { return JSON.parse(l); } catch { return null; } };
const txtOf = (c) => (c || []).map((x) => x.text || "").join("");

/** 只解压「窗口内」的帧：从最后一帧往回走，直到某帧的最早事件早于 `since`。
 *  ★ 语义：**无论走到哪一步，`events` 都已覆盖 ≥ since 的全部事件**（要么越过窗口才停，要么走到第 0 帧
 *  ——后者意味着整档都在窗口内，反而更完整）⇒ 「完整性」只由**解压失败**决定，不由停止位置决定。
 *  返回 { events, failedFrames, frames, decodedFrames }。 */
function decodeSince(file, since) {
	const b = fs.readFileSync(file);
	const spans = [];
	let off = 0;
	while (off < b.length) {
		const end = frameEnd(b, off);
		if (end < 0 || end <= off) {
			const n = b.indexOf(MAGIC, off + 1);
			if (n < 0) break;
			off = n;
			continue;
		}
		spans.push([off, end]);
		off = end;
	}
	const events = [];
	let failedFrames = 0;
	let decodedFrames = 0;
	for (let i = spans.length - 1; i >= 0; i -= 1) {
		let chunk = null;
		try { chunk = zlib.zstdDecompressSync(b.subarray(spans[i][0], spans[i][1])).toString("utf8"); } catch { failedFrames += 1; continue; }
		decodedFrames += 1;
		const list = chunk.split(/\r?\n/).filter(Boolean).map(parse).filter(Boolean);
		events.push(...list);
		if (list.length > 0 && Math.min(...list.map((e) => e.time ?? Infinity)) < since) break;
	}
	return { events: events.filter((e) => e.time >= since).sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1)), failedFrames, frames: spans.length, decodedFrames };
}

const at = (ms) => new Date(ms).toISOString().slice(11, 19);
const main = decodeSince(src, RESTART);
const post = main.events;
console.log(`### 批 D 真机验收 · ${src.split(/[\\/]/).slice(-2)[0]}`);
console.log(`    重启时刻基准（UTC）：${new Date(RESTART).toISOString()}`);
console.log(`    重启后事件数：${post.length}（解压 ${main.decodedFrames}/${main.frames} 帧，解压失败 ${main.failedFrames} 帧）`);

// ① 角色文本
const ROLE_MARKERS = ["不要静默等待", "职责边界", "你是团队"];
const hasRole = (t) => ROLE_MARKERS.some((m) => t.includes(m));
const systems = post.filter((e) => e.type === "system/message").map((e) => ({ seq: e.seq, time: e.time, text: txtOf(e.data?.message?.content) }));
console.log("\n=== ① 角色文本是否自动挂上（自愈可达）===");
if (systems.length === 0) console.log("  重启后没有系统提示事件 ⇒ 该会话还没跑过任何一步");
else {
	for (const s of [systems[0], systems[systems.length - 1]]) {
		console.log(`  ${s === systems[0] ? "首条" : "末条"}：seq ${s.seq}（${at(s.time)}）len=${s.text.length}  角色文本=${hasRole(s.text) ? "✅有" : "❌无"}`);
	}
	console.log(`  ⇒ 重启后系统提示共 ${systems.length} 条；首条即有 = ${hasRole(systems[0].text) ? "是（自愈当步生效）" : "否（晚一步，或根本没挂）"}`);
}

// ② 动作上下文快照（文本在 data.content）
const NEEDLE = "[team-link 会话资源]";
const snapsAll = post.filter((e) => e.type === "user/message" && txtOf(e.data?.content).includes("Current runtime context"));
const snapsHit = snapsAll.filter((e) => txtOf(e.data.content).includes(NEEDLE));
console.log("\n=== ② 动作上下文快照里的资源行 ===");
console.log(`  运行时上下文快照条数：${snapsAll.length}；其中含资源行：${snapsHit.length}`);
if (snapsHit.length > 0) {
	const last = snapsHit[snapsHit.length - 1];
	const t = txtOf(last.data.content);
	const i = t.indexOf(NEEDLE);
	const j = t.indexOf("\n", i);
	console.log(`  逐字（seq ${last.seq}，${at(last.time)}）：`);
	console.log(`    ${JSON.stringify(t.slice(i, j < 0 ? undefined : j))}`);
} else console.log("  ⚠ 没有含资源行的快照 ⇒ 插件那一面没挂上或没渲染");

// ③ 名册写入：本会话 + 同工作区**全部**候选会话
const ROLE_TOOLS = ["team_link_roster", "team_link_rotate", "team_link_recover"];
const WRITE_ARGS = /set-role|retire|prepare|claim|reappoint|revive|upsert-team/u;
const writesOf = (list, who) => list
	.filter((e) => e.type === "tool/call" && ROLE_TOOLS.includes(String(e.data?.name)) && WRITE_ARGS.test(String(e.data?.arguments ?? "")))
	.map((e) => ({ at: at(e.time), who, name: e.data?.name, args: String(e.data?.arguments ?? "").slice(0, 110) }));
console.log("\n=== ③ 窗口内的名册写入（决定前面两项是不是空转）===");
const writes = writesOf(post, "本会话");
console.log(writes.length === 0 ? "  本会话内：无" : "");
for (const w of writes) console.log(`  ⚠ ${w.at}  [${w.who}] ${w.name}  ${w.args}`);

const wsDir = path.dirname(path.dirname(src));
let cands = [];
try {
	cands = fs.readdirSync(wsDir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => path.join(wsDir, d.name, "session.v4.jsonl.zstd"))
		.filter((f) => f !== src && fs.existsSync(f))
		.filter((f) => fs.statSync(f).mtimeMs >= RESTART);
} catch (error) {
	console.log(`  同工作区枚举失败（${error instanceof Error ? error.message : String(error)}）`);
}
let incomplete = 0;
for (const f of cands) {
	try {
		const r = decodeSince(f, RESTART);
		if (r.failedFrames > 0) incomplete += 1;
		for (const w of writesOf(r.events, path.basename(path.dirname(f)).slice(0, 36))) writes.push(w);
	} catch { incomplete += 1; }
}
console.log(`  同工作区：候选 ${cands.length} 个（重启后有过写入的会话），**全部扫过**；解压失败 ${incomplete} 个`);
for (const w of writes.filter((x) => x.who !== "本会话")) console.log(`  ⚠ ${w.at}  [${w.who}] ${w.name}  ${w.args}`);
if (cands.length === 0) console.log("  同工作区：重启后没有别的会话写过 ⇒ 无从被污染");

// ④ 命中率（批 C 口径，顺带）
const rows = [];
for (const e of post) {
	if (e.type !== "assistant/message") continue;
	const u = e.data?.usage;
	if (u === undefined || typeof u.cacheReadTokens !== "number") continue;
	const prompt = (u.inputTokens ?? 0) + u.cacheReadTokens;
	if (prompt === 0) continue;
	rows.push({ at: at(e.time), prompt, read: u.cacheReadTokens, hit: (u.cacheReadTokens / prompt) * 100 });
}
console.log("\n=== ④ 重启后每个请求的缓存命中率（批 C 口径，顺带）===");
for (const r of rows) console.log(`  ${r.at}  prompt=${r.prompt.toLocaleString()}  cacheRead=${r.read.toLocaleString()}  hit=${r.hit.toFixed(1)}%`);
const tot = rows.reduce((a, r) => ({ p: a.p + r.prompt, c: a.c + r.read }), { p: 0, c: 0 });
if (tot.p > 0) console.log(`  聚合：n=${rows.length}  HIT=${((tot.c / tot.p) * 100).toFixed(1)}%`);

// 判
const roleOk = systems.length > 0 && hasRole(systems[systems.length - 1].text);
const snapOk = snapsHit.length > 0;
console.log("\n=== 判 ===");
if (roleOk && snapOk && writes.length === 0 && incomplete === 0) {
	console.log("  ✅ PASS —— 重启后不跑任何命令，角色文本与资源行都自己挂上了（FR-1 自愈在真机成立）");
} else if (roleOk && snapOk) {
	console.log("  ⚠ 无法判 —— 两样都在，但 ③ 不干净：");
	if (writes.length > 0) console.log(`     窗口内有 ${writes.length} 次名册写入 ⇒ 这次读数**可能是空转**（旧通路干的）；`);
	if (incomplete > 0) console.log(`     有 ${incomplete} 个候选会话存在**解压失败**的帧 ⇒ 无法排除污染。`);
	console.log("     请在**下一次重启后、不跑任何名册写入**的前提下重跑本脚本。");
} else {
	console.log(`  ❌ FAIL —— ${roleOk ? "" : "角色文本缺 "}${snapOk ? "" : "资源行缺 "}⇒ 自愈没生效（把上面 ③ 与逐字读数一并交给父侧）`);
}
console.log("\n看门狗那半边（clear 拿不走 auto 注册）另跑两条工具读数：");
console.log("  ① team_link_watch action=list —— 该队的 auto 注册应当在列");
console.log("  ② 在现任协调者会话里跑一次 team_link_watch action=clear，再跑 list —— auto 注册**仍应在列**");

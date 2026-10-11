// tally-malformed.mjs —— 跨会话统计 `MALFORMED_RESPONSE`（tool input is invalid JSON），
// 并按「失败时正在发出的工具调用名」分档，同时检测参数里是否混入 DSML 分隔符。
// 用法：node tally-malformed.mjs <sessions 根目录> [工作区名过滤正则]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = process.argv[2];
const filter = process.argv[3] ? new RegExp(process.argv[3], "u") : null;
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function frameEnd(b, off) {
	if (b.readUInt32LE(off) !== 0xfd2fb528) return -1;
	let p = off + 4;
	const fhd = b[p++];
	const fcsFlag = (fhd >> 6) & 3, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1;
	if (!single) p += 1;
	p += [0, 1, 2, 4][fhd & 3];
	p += fcsFlag === 0 ? (single ? 1 : 0) : [0, 2, 4, 8][fcsFlag];
	for (;;) {
		const h = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
		p += 3;
		const last = h & 1, bt = (h >> 1) & 3, bs = (h >> 3) & 0x1fffff;
		if (bt === 0 || bt === 2) p += bs; else if (bt === 1) p += 1; else return -1;
		if (last) break;
	}
	if (checksum) p += 4;
	return p;
}
function decode(file) {
	const b = fs.readFileSync(file);
	let off = 0; const outs = [];
	while (off < b.length) {
		const end = frameEnd(b, off);
		if (end < 0 || end <= off) { const n = b.indexOf(MAGIC, off + 1); if (n < 0) break; off = n; continue; }
		try { outs.push(zlib.zstdDecompressSync(b.subarray(off, end))); } catch {}
		off = end;
	}
	return Buffer.concat(outs).toString("utf8").split(/\r?\n/).filter(Boolean)
		.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
		.sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1));
}
const BAR = String.fromCharCode(0xFF5C); // 全角竖线 U+FF5C（★ 纪律：原串不逐字出现）
const DSML = new RegExp("</?" + BAR + BAR + "[A-Za-z_]{0,20}" + BAR + BAR, "u");

const byTool = new Map();
let total = 0;
const perSession = [];
const wsDirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && (filter === null || filter.test(d.name)));
for (const ws of wsDirs) {
	const wsPath = path.join(root, ws.name);
	for (const s of fs.readdirSync(wsPath, { withFileTypes: true })) {
		if (!s.isDirectory()) continue;
		const f = path.join(wsPath, s.name, "session.v4.jsonl.zstd");
		if (!fs.existsSync(f)) continue;
		let evs = [];
		try { evs = decode(f); } catch { continue; }
		let n = 0;
		for (let i = 0; i < evs.length; i += 1) {
			const e = evs[i];
			if (e.type !== "turn/end") continue;
			if (e.data?.reason?.error?.code !== "MALFORMED_RESPONSE") continue;
			n += 1; total += 1;
			// 往前找同 turn 的 assistant/attempt，取工具名与参数
			let tool = "(未知)";
			let dsml = false;
			for (let k = i - 1; k >= 0 && k > i - 60; k -= 1) {
				const p = evs[k];
				if (p.type !== "assistant/attempt" || p.data?.turn !== e.data?.turn) continue;
				for (const seg of p.data?.stream ?? []) {
					if (seg.type === "tool-call-chunks" && typeof seg.name === "string" && seg.name !== "") tool = seg.name;
					const raw = JSON.stringify(seg);
					if (DSML.test(raw)) dsml = true;
					const m = raw.match(/arguments\\?":\\?"((?:[^"\\]|\\.){0,400})/u);
					if (m && DSML.test(m[1])) dsml = true;
				}
				break;
			}
			const key = `${tool}${dsml ? "  ★含DSML" : ""}`;
			byTool.set(key, (byTool.get(key) ?? 0) + 1);
		}
		if (n > 0) perSession.push([`${ws.name.replace(/^--D-workspace-|--$/gu, "")}/${s.name.slice(0, 44)}`, n]);
	}
}
console.log(`扫描工作区目录 ${wsDirs.length} 个；MALFORMED_RESPONSE 失败共 ${total} 次\n`);
console.log("=== 按「失败时正在调的工具」 ===");
for (const [k, v] of [...byTool.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log("\n=== 按会话（前 25） ===");
for (const [k, v] of perSession.sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${String(v).padStart(4)}  ${k}`);

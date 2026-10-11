// dump-failures.mjs —— 对每次 MALFORMED_RESPONSE，把失败那次工具调用的**原始 arguments 字符串**
// 拿出来做 JSON.parse 诊断：报出错位置、并把出错点前后 60 字符打出来。用于定位「坏在哪」。
// 用法：node dump-failures.mjs <sessions 根> <工作区过滤正则> [只看某工具]
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
const root = process.argv[2];
const filter = new RegExp(process.argv[3], "u");
const only = process.argv[4];
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
		.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const at = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const BAR = String.fromCharCode(0xFF5C); // 全角竖线 U+FF5C（★ 纪律：原串不逐字出现）
const DSML = new RegExp("</?" + BAR + BAR + "[A-Za-z_]{0,20}" + BAR + BAR, "u");
let n = 0;
for (const ws of fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && filter.test(d.name))) {
	const wsPath = path.join(root, ws.name);
	for (const s of fs.readdirSync(wsPath, { withFileTypes: true })) {
		if (!s.isDirectory()) continue;
		const f = path.join(wsPath, s.name, "session.v4.jsonl.zstd");
		if (!fs.existsSync(f)) continue;
		let evs = [];
		try { evs = decode(f); } catch { continue; }
		evs.sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1));
		for (let i = 0; i < evs.length; i += 1) {
			const e = evs[i];
			if (e.type !== "turn/end" || e.data?.reason?.error?.code !== "MALFORMED_RESPONSE") continue;
			let found = null;
			for (let k = i - 1; k >= 0 && k > i - 80; k -= 1) {
				const p = evs[k];
				if (p.type !== "assistant/attempt" || p.data?.turn !== e.data?.turn) continue;
				let name = "";
				for (const seg of p.data?.stream ?? []) if (seg.type === "tool-call-chunks" && seg.name) name = seg.name;
				let args = "";
				for (const seg of p.data?.stream ?? []) if (seg.type === "chunk" && seg.chunk?.type === "block-end" && seg.chunk.block?.type === "tool-call") args = seg.chunk.block.arguments ?? "";
				found = { name, args };
				break;
			}
			if (found === null) continue;
			if (only !== undefined && found.name !== only) continue;
			n += 1;
			const { name, args } = found;
			console.log(`\n════ #${n}  ${ws.name.replace(/^--D-workspace-|--$/gu, "")} / ${s.name.slice(0, 40)}  turn=${e.data.turn} step=${e.data.step}  ${at(e.time)}`);
			console.log(`  工具: ${name}   argsLen=${args.length}  含DSML=${DSML.test(args)}`);
			try {
				JSON.parse(args);
				console.log("  ⚠ JSON.parse 竟然成功了 —— 坏点可能在流式切分，不在最终串");
			} catch (err) {
				const msg = String(err.message ?? err);
				const m = msg.match(/position (\d+)/u);
				console.log(`  JSON.parse 失败: ${msg}`);
				if (m) {
					const pos = Number(m[1]);
					console.log(`  ── 出错点前后（位置 ${pos}）──`);
					console.log(`     …${JSON.stringify(args.slice(Math.max(0, pos - 70), pos))} ⟪这里⟫ ${JSON.stringify(args.slice(pos, pos + 70))}…`);
				}
			}
			const rawNl = args.includes("\n");
			console.log(`  诊断: 含裸换行=${rawNl}  含DSML=${DSML.test(args)}  首 90=${JSON.stringify(args.slice(0, 90))}`);
		}
	}
}
console.log(`\n==== 共 ${n} 条（只看工具=${only ?? "全部"}）`);

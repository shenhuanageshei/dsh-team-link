// token-variants.mjs —— 枚举「框定 token」在会话里的**形态**（用于设计档按实测写消毒规则）。
// ★ 纪律：本脚本**不写原串**，一切用码点拼（BAR = U+FF5C）。原串本身是特殊 token，逐字写进工具参数会提高自己被判 MALFORMED 的概率。
// 用法：node token-variants.mjs <sessions 根> <工作区过滤>
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
const root = process.argv[2];
const filter = new RegExp(process.argv[3], "u");
const BAR = String.fromCharCode(0xff5c);
const PAIR = BAR + BAR;               // 两根竖线
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
// 形态计数：把出现点前后 14 个字符里的 **字母数字与下划线** 抽出来，看两竖线夹的是什么词
const shapes = new Map();
const rawVicinity = new Map();
let total = 0;
const codePoints = (s) => [...s].map((c) => "U+" + c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")).join(" ");
for (const ws of fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && filter.test(d.name))) {
	const wsPath = path.join(root, ws.name);
	for (const s of fs.readdirSync(wsPath, { withFileTypes: true })) {
		if (!s.isDirectory()) continue;
		const f = path.join(wsPath, s.name, "session.v4.jsonl.zstd");
		if (!fs.existsSync(f)) continue;
		let evs = [];
		try { evs = decode(f); } catch { continue; }
		for (const e of evs) {
			if (e.type !== "assistant/attempt") continue;
			const raw = JSON.stringify(e.data ?? {});
			let from = 0;
			for (;;) {
				const i = raw.indexOf(PAIR, from);
				if (i < 0) break;
				from = i + PAIR.length;
				total += 1;
				const before = raw.slice(Math.max(0, i - 10), i);
				const after = raw.slice(i + PAIR.length, i + PAIR.length + 22);
				const word = (after.match(/^[A-Za-z_]{0,14}/u) ?? [""])[0];
				const key = `${before.endsWith("<") || before.endsWith("<\\") ? "以 < 或 <\\ 起" : "无前缀尖括号"} + 竖线 + 「${word || "(非字母)"}」`;
				shapes.set(key, (shapes.get(key) ?? 0) + 1);
				if (rawVicinity.size < 12) rawVicinity.set(`${before.slice(-10)}  «PAIR»  ${after.slice(0, 22)}`, i);
			}
		}
	}
}
console.log(`两竖线（U+FF5C ×2）出现总数：${total}`);
console.log(`码点：PAIR = ${codePoints(PAIR)}；竖线单字 = ${codePoints(BAR)}（全角竖线，不是 ASCII 的 | ）\n`);
console.log("=== 形态分布 ===");
for (const [k, v] of [...shapes.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
console.log("\n=== 现场（前 12 例，两侧各若干字符）===");
for (const k of rawVicinity.keys()) console.log(`  ${JSON.stringify(k)}`);

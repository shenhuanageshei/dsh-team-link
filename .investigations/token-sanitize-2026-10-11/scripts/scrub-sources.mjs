// scrub-sources.mjs —— 把工作产物里**逐字写出**的框定 token 改写成「码点构造」。
//
// 为什么存在：那个 token 是特殊 token，**逐字写进源码/文档/脚本，本身就会提高写这一动作被判
// `MALFORMED_RESPONSE` 的概率**（父侧 2026-10-11 因此自伤两次）。所以本仓的纪律是：
// **原串绝不逐字出现，构造它必须用码点**。
//
// ★ 本脚本自己也遵守这条纪律：整个文件里不含原串，全部用 String.fromCharCode(0xFF5C) 拼。
//
// 用法：
//   node scrub-sources.mjs                 # 只体检（默认，零写入）
//   node scrub-sources.mjs <目标目录...> --write
//
// 它做两件事：
//   ① 找到含「两枚全角竖线」的**源码行**，把它们改写成构造式（只在 --write 时落盘）；
//   ② 常量名字保持 `DSML` 不变（ASCII 四字母无害），只是不再把整串写死。
import fs from "node:fs";
import path from "node:path";

const BAR = String.fromCharCode(0xff5c); // 全角竖线 U+FF5C —— 注意不是 ASCII 的 |
const WRAP = BAR + BAR;
const WRAP_RE = new RegExp(WRAP, "u");

const args = process.argv.slice(2);
const write = args.includes("--write");
const targets = args.filter((a) => !a.startsWith("--"));

// 目标行里若同时出现这两样，就是「把原串写死了」
const looksRaw = (line) => WRAP_RE.test(line) && /const\s+DSML\s*=|DSML|MPL/iu.test(line);

// ★ 另一条同族纪律：**体检工具的输出也必须遮蔽** —— 把原串打出来 = 自己把它喂进上下文。
const masked = (s) => String(s).split(WRAP).join("[BARS]");

// 改写后的那两行（**不含原串**，用码点构造）
const REPLACEMENT = [
	`const BAR = String.fromCharCode(0xFF5C); // 全角竖线 U+FF5C（★ 纪律：原串不逐字出现）`,
	`const DSML = new RegExp("</?" + BAR + BAR + "[A-Za-z_]{0,20}" + BAR + BAR, "u");`,
];

const walk = (dir, out = []) => {
	for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, d.name);
		if (d.isDirectory()) {
			if (d.name === "node_modules" || d.name.startsWith(".git")) continue;
			walk(p, out);
		} else if (/\.(mjs|js|cjs|md)$/u.test(d.name)) out.push(p);
	}
	return out;
};

const roots = targets.length > 0 ? targets : ["."];
const files = [];
for (const r of roots) {
	const st = fs.statSync(r);
	if (st.isDirectory()) files.push(...walk(r));
	else files.push(r);
}

let dirty = 0;
let fixed = 0;
for (const f of files) {
	let text;
	try { text = fs.readFileSync(f, "utf8"); } catch { continue; }
	if (!WRAP_RE.test(text)) continue;
	const lines = text.split("\n");
	const hits = lines.map((l, i) => [l, i]).filter(([l]) => looksRaw(l));
	if (hits.length === 0) {
		console.log(`  · 含竖线但非写死式（人工看一眼）: ${f}`);
		continue;
	}
	dirty += hits.length;
	console.log(`  ✗ ${f}  —— ${hits.length} 行写死了原串`);
	for (const [l] of hits) console.log(`       原文（已遮蔽）: ${JSON.stringify(masked(l).slice(0, 110))}`);
	if (!write) continue;
	for (const [, i] of hits) lines[i] = REPLACEMENT.join("\n");
	fs.writeFileSync(f, lines.join("\n"), "utf8"); // utf8 无 BOM（AGENTS.md §六）
	fixed += hits.length;
	console.log(`       ⇒ 已改写为码点构造`);
}
console.log(`\n扫了 ${files.length} 个文件；写死原串的行 ${dirty} 处；${write ? `已改写 ${fixed} 处` : "（体检模式，零写入；加 --write 才落盘）"}`);

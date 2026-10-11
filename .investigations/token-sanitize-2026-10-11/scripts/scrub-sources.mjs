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
//   node scrub-sources.mjs --selftest      # 自检下面两条隐患各自的**可红判据**（零落盘：只用临时目录）
//
// 它做两件事：
//   ① 找到含「两枚全角竖线」的**源码行**，把它们改写成构造式（只在 --write 时落盘）；
//   ② 常量名字保持 `DSML` 不变（ASCII 四字母无害），只是不再把整串写死。
//
// ★★ `--write` 的**拒写**口径（交付评审 #5 修复；两条隐患都属于「写坏比不写更糟」）：
//   ① 同一个**代码**文件里 ≥2 处命中 ⇒ **拒绝写入**：旧实现对**每一**命中行都插入整段 `REPLACEMENT`
//      （`const BAR` ＋ `const DSML` **两行**）⇒ 同文件里 `const BAR` 被声明两次 ⇒ 被改文件抛
//      `SyntaxError: Identifier 'BAR' has already been declared`（正是批 E 修过的那类崩溃形态）。
//      ⇒ 多命中一律拒写，逐处打印（已遮蔽）请人工处理；写前另有一道「改写后不得出现重复声明」的
//      守卫，把「这个文件本来就声明过 BAR」这一支也一并挡掉。
//   ② `.md`（文档）或任何**非代码**文件命中 ⇒ **只遮蔽 / 只报告**，一个字节都不写 —— 旧实现把文档行
//      替换成 **JS 代码行**，等于往 Markdown 里注入源码。文档里的原串请人工改成码点描述或删掉。
//   ⇒ 有拒写时退出码为 1（体检模式的退出码不变）：拒写绝不静默。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BAR = String.fromCharCode(0xff5c); // 全角竖线 U+FF5C —— 注意不是 ASCII 的 |
const WRAP = BAR + BAR;
const WRAP_RE = new RegExp(WRAP, "u");

const args = process.argv.slice(2);
const write = args.includes("--write");
const selftestRequested = args.includes("--selftest");
const targets = args.filter((a) => !a.startsWith("--"));

// 目标行里若出现**完整的包裹结构**，就是「把原串写死了」。
//
// ★ 口径加宽（分歧审计 #11）：旧判据是 `WRAP_RE.test(line) && /DSML|MPL/`，即「两枚全角竖线
//   **且**同行另有 DSML/MPL」—— 它比设计档 §8 的 U8 声明**窄**：把一处**裸包裹**（无 DSML 字样）
//   逐字写进文件，旧判据照样报 0 命中（即 `AGENTS.md` §一.3 点名的那类**假阴性**）。
//   ⇒ 现在与 U8 声明的匹配式**同一模式**（`lib/index.js` 的 `framingTokenPattern()`）：
//     可选前缀 `<` / `</` ＋ 两枚全角竖线 ＋ `[A-Za-z_]{0,20}` ＋ 两枚全角竖线。
const WRAP_STRUCTURE_RE = new RegExp(`(?:</?)?${WRAP}[A-Za-z_]{0,20}${WRAP}`, "u");
// ★ 同类纪律的安全阀（**如实声明**）：合法构造式在**运行期**拼出的字节里也含这个模式
//   （下面的 `REPLACEMENT` 就是「两串 ＋ 两串」），因此宽口径会给出**假阳性**。
//   这一档不属于「逐字写死」，用一条很窄的排除规则滤掉：**只含构造材料的行**——
//   整行**没有**任何连续两枚**字面**全角竖线，却引用了 `String.fromCharCode(0xFF5C)` 或 `BAR`/`WRAP`。
//   排除掉的会**逐条打印**请人工看一眼，不静默吞掉（体检工具宁可吵，不可漏）。
const LITERAL_WRAP_RE = new RegExp(`${WRAP}`, "u");
const readsAsConstructed = (line) => !LITERAL_WRAP_RE.test(line)
	&& /String\.fromCharCode\(\s*0x[fF]{2}5[cC]\s*\)|\b(?:BAR|WRAP)\b/u.test(line);
const looksRaw = (line) => WRAP_STRUCTURE_RE.test(line) && !readsAsConstructed(line);

// ★ 另一条同族纪律：**体检工具的输出也必须遮蔽** —— 把原串打出来 = 自己把它喂进上下文。
const masked = (s) => String(s).split(WRAP).join("[BARS]");

// 改写后的那两行（**不含原串**，用码点构造）
const REPLACEMENT = [
	`const BAR = String.fromCharCode(0xFF5C); // 全角竖线 U+FF5C（★ 纪律：原串不逐字出现）`,
	`const DSML = new RegExp("</?" + BAR + BAR + "[A-Za-z_]{0,20}" + BAR + BAR, "u");`,
];

// ★ 文件分档：**代码**才允许自动改写；**文档**（`.md`）与任何**非代码**文件永远只遮蔽/只报告
// （评审 #5 隐患 ②：往非代码文件里注入 JS 代码行 = 写坏它）。
const CODE_FILE_RE = /\.(mjs|js|cjs)$/u;
const DOC_FILE_RE = /\.md$/u;

/** 改写后**不得**出现重复声明：`REPLACEMENT` 声明的是 `BAR` 与 `DSML` 两个名字，同文件里各只许一份
 *  （重复 `const` ⇒ SyntaxError —— 正是本工具要避免的崩溃形态）。返回撞名的名字数组。 */
const duplicateConstNames = (text) => ["BAR", "DSML"].filter((name) => (text.match(new RegExp(`\\bconst\\s+${name}\\b`, "gu")) ?? []).length > 1);

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

/**
 * 处理**一个**文件。返回 `{ hits, kind, wrote, refused, reason }`。
 *  · `--write` 缺席 ⇒ 只报告，零写入（体检模式）。
 *  · `.md` 或任何**非代码**文件 ⇒ **只遮蔽/只报告**，一个字节都不写（绝不把 JS 代码行注进去）。
 *  · 代码文件（`.mjs`/`.js`/`.cjs`）≥2 处命中 ⇒ **拒绝写入**（见文件头 ①）。
 *  · 代码文件恰 1 处命中 ⇒ 整行改写为码点构造；写前再验一次「改写后无重复声明」，撞名就拒写。
 * 前置：`file` 可读（读不到按 0 命中处理，绝不抛出）。后置：只有「代码 ＋ 恰 1 处 ＋ 无重复声明」
 * 这一支会落盘，且写入是 utf8 无 BOM（AGENTS.md §六）。
 */
const scrubFile = (file, write, log = console.log) => {
	let text;
	try { text = fs.readFileSync(file, "utf8"); } catch { return { hits: 0, kind: "unreadable", wrote: false, refused: false }; }
	if (!WRAP_RE.test(text)) return { hits: 0, kind: "clean", wrote: false, refused: false };
	const doc = DOC_FILE_RE.test(file);
	const code = CODE_FILE_RE.test(file);
	const lines = text.split("\n");
	const hits = lines.map((l, i) => [l, i]).filter(([l]) => looksRaw(l));
	if (hits.length === 0) {
		log(`  · 含竖线但非写死式（人工看一眼）: ${file}`);
		return { hits: 0, kind: "ambiguous", wrote: false, refused: false };
	}
	log(`  ✗ ${file}  —— ${hits.length} 行写死了原串${doc ? "（Markdown 文档）" : code ? "" : "（非代码文件）"}`);
	for (const [l] of hits) log(`       原文（已遮蔽）: ${JSON.stringify(masked(l).slice(0, 110))}`);
	if (!write) return { hits: hits.length, kind: doc ? "doc" : code ? "code" : "other", wrote: false, refused: false };
	if (!code) {
		log(`      ⇒ 拒绝写入（${doc ? ".md 文档" : "非代码文件"}只遮蔽/只报告：替换成 JS 代码行 = 往非代码文件里注入源码；请人工改成码点描述或删掉原串）`);
		return { hits: hits.length, kind: doc ? "doc" : "other", wrote: false, refused: true, reason: doc ? "doc-file" : "not-code" };
	}
	if (hits.length > 1) {
		log(`      ⇒ 拒绝写入（同文件 ${hits.length} 处命中：整段常量插入会让 \`const BAR\` 声明两遍 ⇒ 写下去那份文件 SyntaxError；请人工逐处改，或让本工具一次只改一处）`);
		return { hits: hits.length, kind: "code", wrote: false, refused: true, reason: "multi-hit" };
	}
	const nextLines = lines.slice();
	for (const [, i] of hits) nextLines[i] = REPLACEMENT.join("\n");
	const next = nextLines.join("\n");
	const duplicates = duplicateConstNames(next);
	if (duplicates.length > 0) {
		log(`      ⇒ 拒绝写入（改写后会同文件重复声明 ${duplicates.map((name) => `\`const ${name}\``).join(" / ")} ⇒ SyntaxError；该文件里已有一份声明，请人工改）`);
		return { hits: hits.length, kind: "code", wrote: false, refused: true, reason: `duplicate-decl:${duplicates.join(",")}` };
	}
	fs.writeFileSync(file, next, "utf8"); // utf8 无 BOM（AGENTS.md §六）
	log(`      ⇒ 已改写为码点构造（1 处；未新增重复声明）`);
	return { hits: hits.length, kind: "code", wrote: true, refused: false };
};

/**
 * `--selftest`：两条隐患各一条**可红**判据 —— 都跑在**同一个** `scrubFile` 写入路径上
 * （不是另写一份逻辑来自证）。
 * 红相 = 还原旧实现（每处命中插整段 `REPLACEMENT`、`.md` 照写）⇒ ①③ 红；
 *        把 `.md` / 非代码分档删掉 ⇒ ③ 红；把「恰 1 处才写」放宽 ⇒ ① 红；
 *        去掉「无重复声明」守卫 ⇒ ⑤ 红。②④ 是对照与夹具自证（保证前三条不是空转）。
 * 全部夹具写在系统临时目录里，跑完即删（**零落盘到仓库**）。
 */
function runSelftest() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "scrub-selftest-"));
	const quiet = () => {};
	/** 夹具里的「原串」——**由码点拼出**（本文件内不出现原串；一切输出仍经 `masked`）。 */
	const raw = WRAP + "DSML" + WRAP;
	const results = [];
	try {
		// ① 隐患 1 的判据：同文件 ≥2 处命中 ⇒ 拒写，且**不产生**第二次 `const BAR`
		const multiPath = path.join(root, "multi.mjs");
		const multiText = `const a = "${raw}";\nconst b = "${raw}";\n`;
		fs.writeFileSync(multiPath, multiText, "utf8");
		const multiResult = scrubFile(multiPath, true, quiet);
		const multiAfter = fs.readFileSync(multiPath, "utf8");
		results.push([
			"① 同文件 2 处命中 ⇒ 拒绝写入、文件逐字节不变、零 `const BAR`（旧实现：插两遍 ⇒ SyntaxError）",
			multiResult.refused === true && multiResult.reason === "multi-hit"
				&& multiAfter === multiText
				&& (multiAfter.match(/\bconst\s+BAR\b/gu) ?? []).length === 0,
		]);
		// ①-对照：单处命中照常改写，改写后两个常量各**恰一份**、文件里零字面竖线
		const singlePath = path.join(root, "single.mjs");
		fs.writeFileSync(singlePath, `const DSML = new RegExp("${raw}", "u");\n`, "utf8");
		const singleResult = scrubFile(singlePath, true, quiet);
		const singleAfter = fs.readFileSync(singlePath, "utf8");
		results.push([
			"② 对照：单处命中照常改写 —— 改写后 `const BAR` / `const DSML` 各恰一份，且文件里零字面竖线",
			singleResult.wrote === true
				&& (singleAfter.match(/\bconst\s+BAR\b/gu) ?? []).length === 1
				&& (singleAfter.match(/\bconst\s+DSML\b/gu) ?? []).length === 1
				&& !LITERAL_WRAP_RE.test(singleAfter),
		]);
		// ② 隐患 2 的判据：`.md` 命中 ⇒ 只遮蔽/只报告，一个字节都不写，绝不注入 JS
		const docPath = path.join(root, "doc.md");
		const docText = `说明：原串写作 ${raw} ，必须改成码点构造。\n`;
		fs.writeFileSync(docPath, docText, "utf8");
		const docResult = scrubFile(docPath, true, quiet);
		const docAfter = fs.readFileSync(docPath, "utf8");
		results.push([
			"③ `.md` 命中 ⇒ 拒绝写入、文件逐字节不变、零 JS 注入（旧实现：文档行被换成 JS 代码行）",
			docResult.refused === true && docResult.kind === "doc" && docResult.reason === "doc-file"
				&& docAfter === docText
				&& !docAfter.includes("const BAR") && !docAfter.includes("String.fromCharCode"),
		]);
		// ④ 夹具自证（★ 负相）：上面三条读的确实是「写死式」判据 —— 夹具行判为写死，构造行不判为写死
		results.push([
			"④ 夹具自证（★ 负相：夹具真的推得动）：裸包裹夹具行**判为**写死式，码点构造行**不判**为写死式",
			looksRaw(`const a = "${raw}";`) === true
				&& WRAP_STRUCTURE_RE.test(`const a = "${raw}";`) === true
				&& looksRaw(`const BAR = String.fromCharCode(0xFF5C);`) === false
				&& looksRaw(`const DSML = new RegExp("</?" + BAR + BAR + "[A-Za-z_]{0,20}" + BAR + BAR, "u");`) === false,
		]);
		// ⑤ 守卫自证：文件里**本来就**声明过 BAR ⇒ 单处命中也不许写（同一崩溃形态的另一支）
		const dupPath = path.join(root, "already-declared.mjs");
		const dupText = `const BAR = String.fromCharCode(0xFF5C);\nconst a = "${raw}";\n`;
		fs.writeFileSync(dupPath, dupText, "utf8");
		const dupResult = scrubFile(dupPath, true, quiet);
		const dupAfter = fs.readFileSync(dupPath, "utf8");
		results.push([
			"⑤ 文件里已有一份 `const BAR` ⇒ 单处命中**同样拒写**（「无重复声明」守卫，文件逐字节不变）",
			dupResult.refused === true && String(dupResult.reason).startsWith("duplicate-decl") && dupAfter === dupText,
		]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	console.log("--selftest（隐患①的判据 = ①、隐患②的判据 = ③；②④⑤ 是对照与自证。全部夹具在系统临时目录里，仓库零落盘）：");
	for (const [name, pass] of results) console.log(`  ${pass ? "✓" : "✗"} ${name}`);
	const failed = results.filter(([, pass]) => !pass).length;
	console.log(failed === 0 ? "--selftest PASS" : `--selftest FAIL（${failed} 条）`);
	if (failed > 0) process.exitCode = 1;
}

if (selftestRequested) {
	runSelftest();
} else {
	const roots = targets.length > 0 ? targets : ["."];
	const files = [];
	for (const r of roots) {
		const st = fs.statSync(r);
		if (st.isDirectory()) files.push(...walk(r));
		else files.push(r);
	}

	let dirty = 0;
	let fixed = 0;
	let refused = 0;
	for (const f of files) {
		const result = scrubFile(f, write);
		dirty += result.hits;
		if (result.wrote) fixed += result.hits;
		if (result.refused) refused += 1;
	}
	const tail = write
		? `已改写 ${fixed} 处；拒绝写入 ${refused} 个文件（.md / 非代码 / 多命中一律拒写 —— 每一处的理由都印在上面）`
		: "（体检模式，零写入；加 --write 才落盘）";
	console.log(`\n扫了 ${files.length} 个文件；写死原串的行 ${dirty} 处；${tail}`);
	if (write && refused > 0) {
		console.log(`★ ${refused} 个文件**没有被自动改写**（拒写比写坏强）——请人工处理上面点名的那几行。`);
		process.exitCode = 1;
	}
}

// balance-scan.mjs —— 括号/引号配平扫描（自己实现，用来**一次找全**语法类不平衡）。
// Node 的 --check 只报第一个；本脚本逐字符走一遍并给出**所有**深度异常点。
// 处理：'…' "…" `…`（含 ${} 嵌套）、// 行注释、/* */ 块注释。
// 用法：node balance-scan.mjs <file.js>
import fs from "node:fs";
const file = process.argv[2];
const src = fs.readFileSync(file, "utf8");
const LINE = (() => { const a = []; let n = 1; for (const ch of src) { a.push(n); if (ch === "\n") n += 1; } return a; })();

const OPEN = { "(": ")", "[": "]", "{": "}" };
const CLOSE = { ")": "(", "]": "[", "}": "{" };
let stack = [];
let i = 0;
let line = 1;
let state = "code"; // code | line-comment | block-comment | sq | dq | tpl
let tplStack = [];  // 模板字面量里 ${ 的嵌套层数
let prev = null;    // 上一个「有效字符」，用于判断 `/` 是正则还是除号
const problems = [];

while (i < src.length) {
	const c = src[i];
	const n = src[i + 1];
	if (c === "\n") { line += 1; if (state === "line-comment") state = "code"; i += 1; continue; }
	if (state === "line-comment") { i += 1; continue; }
	if (state === "block-comment") { if (c === "*" && n === "/") { state = "code"; i += 2; continue; } i += 1; continue; }
	if (state === "sq" || state === "dq") {
		if (c === "\\") { i += 2; continue; }
		if ((state === "sq" && c === "'") || (state === "dq" && c === '"')) { state = "code"; i += 1; continue; }
		i += 1; continue;
	}
	if (state === "tpl") {
		if (c === "\\") { i += 2; continue; }
		if (c === "`") { state = tplStack.pop() ?? "code"; i += 1; continue; }
		if (c === "$" && n === "{") { tplStack.push("tpl"); state = "code"; stack.push({ ch: "{", line, from: "tpl" }); i += 2; continue; }
		i += 1; continue;
	}
	// code
	if (c === "/" && n === "/") { state = "line-comment"; i += 2; continue; }
	if (c === "/" && n === "*") { state = "block-comment"; i += 2; continue; }
	// ★ 正则字面量：只看前一个「有效字符」判断。若它不能结尾一个表达式，则 `/` 是正则起手。
	if (c === "/" && (prev === null || "(,=:[!&|?{};+-*%<>~^".includes(prev))) {
		let j = i + 1;
		let inClass = false;
		while (j < src.length) {
			const d = src[j];
			if (d === "\\") { j += 2; continue; }
			if (d === "\n") break;
			if (d === "[") inClass = true;
			else if (d === "]") inClass = false;
			else if (d === "/" && !inClass) { j += 1; break; }
			j += 1;
		}
		while (j < src.length && /[a-z]/iu.test(src[j])) j += 1; // 旗标
		i = j; prev = "x"; continue;
	}
	if (!/\s/u.test(c)) prev = c;   // ← 所有非空白代码字符都刷新 prev
	if (c === "'") { state = "sq"; i += 1; continue; }
	if (c === '"') { state = "dq"; i += 1; continue; }
	if (c === "`") { state = "tpl"; tplStack.push("code"); i += 1; continue; }
	if (OPEN[c] !== undefined) { stack.push({ ch: c, line, from: "code" }); i += 1; continue; }
	if (CLOSE[c] !== undefined) {
		const top = stack.pop();
		if (top === undefined) problems.push(`第 ${line} 行：多一个 '${c}'（栈已空）`);
		else if (OPEN[top.ch] !== c) problems.push(`第 ${line} 行：'${c}' 与第 ${top.line} 行的 '${top.ch}' 不配对`);
		else if (top.from === "tpl" && c === "}") { /* ${ } 收口：回到模板字面量 */ state = "tpl"; tplStack.pop(); }
		i += 1; continue;
	}
	i += 1;
}
for (const s of stack) problems.push(`第 ${s.line} 行：'${s.ch}' 未闭合（到文件末尾仍未配上）`);
if (state !== "code") problems.push(`文件结束时仍处于「${state}」状态（字符串/注释/模板未收口）`);
console.log(`文件 ${file}：${LINE[LINE.length - 1]} 行`);
if (problems.length === 0) console.log("  ✓ 括号与引号全部配平（未发现语法类不平衡）");
else { console.log(`  ✗ 发现 ${problems.length} 处不平衡：`); for (const p of problems) console.log(`     - ${p}`); }

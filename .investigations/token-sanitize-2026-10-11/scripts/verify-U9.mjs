// verify-U9.mjs —— 批 E 真机项 U9 的**安全等价版**取证。
//
// 为什么不能照原始设计做：U9 原稿要求「把含毒文本经 team_link_team_append 落盘」，
// 而那意味着**把那个原串逐字写进工具参数** —— 正是会触发 MALFORMED_RESPONSE 的动作
// （批 E 取证的 15 次失败全部由此而来）。父侧为此自伤过三次。
// ⇒ 本脚本走**安全等价**路径：用码点构造原串、**直接写盘**，再由**真机的读面**
//    （team_link_team_read）验收「读回文本里是占位符、不是原串」。
//
// 覆盖缺口（如实声明）：**本脚本不覆盖 append 写入路径的消毒**（那条由判据 U1①–⑤ 的
// 夹具路径覆盖，且实现里 sanitizeFraming 就在写盘前一行 —— 见 lib/index.js 的
// decisions/tasks/discipline 三个写入分支）。缺口存在的唯一原因是「不能逐字写原串」。
//
// 用法：node verify-U9.mjs <blackboardDir>      # 例：node verify-U9.mjs team/u9-verify-1012
import fs from "node:fs";
import path from "node:path";

const BAR = String.fromCharCode(0xff5c);          // 全角竖线 U+FF5C
const WRAP = BAR + BAR;
const token = `</${WRAP}DSML${WRAP}`;              // 实测最常出现的形态（带 </ 前缀）

const dir = process.argv[2];
if (typeof dir !== "string" || dir === "") {
	console.error("用法：node verify-U9.mjs <blackboardDir>");
	process.exit(2);
}
const file = path.join(dir, "decisions.md");
fs.mkdirSync(dir, { recursive: true });

const author = "session-ab58a5d1-024b-492b-828b-4bf4fafb1718";
const row = `1 | 2026-10-12T00:30:00.000Z | ${author} | U9 真机取证：带毒正文 ${token} 收尾（这一行由脚本用码点写入，不经工具参数）`;
fs.writeFileSync(file, row + "\n", "utf8");

// 自证：盘上那一行**确实**含原串（否则这次取证是空转 —— 与「负相自证」同一纪律）
const back = fs.readFileSync(file, "utf8");
const hits = [...back.matchAll(new RegExp(`(?:</?)?${WRAP}[A-Za-z_]{0,20}${WRAP}`, "gu"))].length;
console.log(`已写入 ${file}`);
console.log(`  盘上原串命中数 = ${hits}  ${hits >= 1 ? "✅ 夹具自证：盘上确实有原串（这次取证不是空转）" : "❌ 夹具没写进去 ⇒ 本次取证无效"}`);
console.log(`  遮蔽预览：${row.replace(new RegExp(`${WRAP}`, "gu"), "[BARS]").slice(0, 160)}`);
process.exit(hits >= 1 ? 0 : 1);

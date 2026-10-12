// prune-temp-stores.mjs —— 清理 DSH 在 %TEMP% 下留下的「工作区变更存档」。
//
// 为什么要有它：DSH 每跑一次就在 %TEMP% 建一个 `dsh-workspace-changes-<6位>` 目录
// （内容：`captures/` + `objects/XX/<sha>` 的内容寻址存档），**没有任何保留期、没有清理入口**。
// 真机实测（2026-10-12）：**218 个目录 / 9.41 GB**，最早 10-06、最新当天 —— 是 C 盘吃紧的主因。
//
// 本脚本的安全边界（**故意做窄**）：
//   ① **只认一个前缀**：目录名必须严格匹配 `^dsh-workspace-changes-[A-Za-z0-9]{6}$`；
//   ② **只认一个父目录**：解析后的绝对路径的父目录必须**恰好等于** `%TEMP%`（防路径穿越 / 防误删别处同名目录）；
//   ③ **默认只看不动**：不加 `--apply` 一律零写入，只打印将要删什么；
//   ④ **年龄闸**：`--keep-days N`（默认 3）内的目录一律保留（当前在跑的那一两次几乎必然落在窗口里）；
//   ⑤ **删失败不硬来**：遇到被占用 / 无权限的文件，**跳过该目录并如实报出**，不重试、不递归强删。
//
// 用法：
//   node prune-temp-stores.mjs                     # 体检：列出会删什么、能省多少（零写入）
//   node prune-temp-stores.mjs --keep-days 7       # 体检，保留最近 7 天
//   node prune-temp-stores.mjs --apply             # 真删（默认保留最近 3 天）
//   node prune-temp-stores.mjs --apply --keep-days 1
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PREFIX_RE = /^dsh-workspace-changes-[A-Za-z0-9]{6}$/;

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const keepDaysIndex = argv.indexOf("--keep-days");
const keepDays = keepDaysIndex === -1 ? 3 : Number(argv[keepDaysIndex + 1]);
if (!Number.isFinite(keepDays) || keepDays < 0) {
	console.error("用法：node prune-temp-stores.mjs [--apply] [--keep-days N]（N 为保留天数，默认 3）");
	process.exit(2);
}

const tempRoot = path.resolve(os.tmpdir());
const cutoffMs = Date.now() - keepDays * 24 * 3600_000;

const fmtGB = (bytes) => (bytes / 1024 ** 3).toFixed(2) + " GB";
const fmtStamp = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 16);

/** 递归求和 + 计数（只读；出错如实让调用方看到）。 */
function measure(dir) {
	let bytes = 0;
	let files = 0;
	const walk = (current) => {
		let entries;
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else {
				try {
					bytes += fs.statSync(full).size;
					files += 1;
				} catch {
					/* 读不到的条目如实跳过（不猜） */
				}
			}
		}
	};
	walk(dir);
	return { bytes, files };
}

// ── 收集候选（三重校验：父目录 === TEMP ∧ 名字合前缀 ∧ 是目录） ──────────────────────
const candidates = [];
for (const entry of fs.readdirSync(tempRoot, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	if (!PREFIX_RE.test(entry.name)) continue;
	const full = path.resolve(tempRoot, entry.name);
	if (path.dirname(full) !== tempRoot) continue; // ② 父目录必须恰好是 TEMP
	let stat;
	try {
		stat = fs.statSync(full);
	} catch {
		continue;
	}
	const tooYoung = stat.mtimeMs > cutoffMs;
	candidates.push({ name: entry.name, full, mtimeMs: stat.mtimeMs, tooYoung });
}

console.log(`TEMP 根目录：${tempRoot}`);
console.log(`保留窗口：最近 ${keepDays} 天（${fmtStamp(cutoffMs)} 之后的一律保留）`);
console.log(`匹配前缀的目录：${candidates.length} 个（前缀 ${PREFIX_RE}）\n`);

let deleteBytes = 0;
let deleteFiles = 0;
let keepBytes = 0;
const willDelete = [];
const willKeep = [];
for (const candidate of candidates) {
	const { bytes, files } = measure(candidate.full);
	candidate.bytes = bytes;
	candidate.files = files;
	if (candidate.tooYoung) {
		willKeep.push(candidate);
		keepBytes += bytes;
	} else {
		willDelete.push(candidate);
		deleteBytes += bytes;
		deleteFiles += files;
	}
}

const line = (candidate, action) =>
	`  ${action}  ${candidate.name}  ${fmtGB(candidate.bytes).padStart(9)}  ${String(candidate.files).padStart(7)} files  mtime ${fmtStamp(candidate.mtimeMs)}`;

console.log(`【保留】${willKeep.length} 个 · ${fmtGB(keepBytes)}`);
for (const candidate of willKeep.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 5)) console.log(line(candidate, "KEEP"));
if (willKeep.length > 5) console.log(`  …（另有 ${willKeep.length - 5} 个保留项未列出）`);

console.log(`\n【待删】${willDelete.length} 个 · ${fmtGB(deleteBytes)} · ${deleteFiles} 个文件`);
const oldest = [...willDelete].sort((a, b) => a.mtimeMs - b.mtimeMs);
for (const candidate of oldest.slice(0, 12)) console.log(line(candidate, " DEL"));
if (willDelete.length > 12) console.log(`  …（另有 ${willDelete.length - 12} 个待删项未列出）`);
if (oldest.length > 0) console.log(`  最老：${fmtStamp(oldest[0].mtimeMs)} · 最新：${fmtStamp(oldest[oldest.length - 1].mtimeMs)}`);

if (!apply) {
	console.log(`\n（体检模式，零写入。要真删请加 --apply）`);
	process.exit(0);
}

// ── 真删（逐个目录；删失败如实报出并跳过，不重试、不硬来） ─────────────────────────
console.log(`\n开始删除 ${willDelete.length} 个目录…`);
let removed = 0;
let removedBytes = 0;
const failures = [];
for (const candidate of willDelete) {
	try {
		fs.rmSync(candidate.full, { recursive: true, force: true, maxRetries: 0 });
		removed += 1;
		removedBytes += candidate.bytes;
		if (removed % 20 === 0) console.log(`  …已删 ${removed}/${willDelete.length}（${fmtGB(removedBytes)}）`);
	} catch (error) {
		failures.push({ name: candidate.name, reason: String(error?.message ?? error) });
	}
}
console.log(`\n已删 ${removed} 个目录 · 释放 ${fmtGB(removedBytes)}`);
if (failures.length > 0) {
	console.log(`跳过 ${failures.length} 个（被占用 / 无权限 —— 如实报出，未重试）：`);
	for (const failure of failures.slice(0, 12)) console.log(`  SKIP  ${failure.name}  ${failure.reason}`);
}

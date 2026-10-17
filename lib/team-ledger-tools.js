// ---------------------------------------------------------------------------
// 黑板读写工具域（team-ledger-tools）—— 批 R（上架合规）第 8 小单从 `lib/index.js` **原样搬出**
// ---------------------------------------------------------------------------
// 归属：docs/2026-10-15-store-compliance-design.md §4 D1/D2/D4 · §5 FR-R1 · §6（拆分契约：只做
//       「移动 + 补 export」、无副作用搬家、模块图无环）· §8 Rr3/Rr4/Rr8。
// ★ 本档是什么：**一条**工具注册语句 —— `ctx.effect(() => ctx.tools.register(defineTool({ name:
//   "team_link_team_read", … })), "team-link: team read tool")`，连同它的描述文本、参数表、
//   `output`、`timeoutMs` 与整个 `execute` 体（含全部行内注释）。**语句逐字节等于原位置**（设计档
//   D4：只做「移动 + 补 export」）：97 行；工作树 9,088 字节（CRLF 行尾）/ 8,991 字节（EOL 归一到 LF）。
//   机检口径：该语句在新档里**逐字节出现恰一次**、在入口里**零次**（EOL 归一同结论）。
// ★ 本档**不是**（留给下一小单）：
//   ① `team_link_team_append` 的注册语句（16,969 B）仍在入口。**为什么这一单不搬它**：它被
//      `host-half.test.mjs:2894` 的一条**只读入口单档**的正向文本锁钉住 —— 那条判据先
//      `readFile("./lib/index.js")`，再 `includes(...)` 该语句体内那句三段白名单拒绝文案。语句一搬走
//      它必红，而修它要按 FR-R0 的口径把读数改成 `hostSource`（宿主半边文件集拼接），那一步落在
//      **测试档**、不在本小单写域内 ⇒ 按「宁可少搬、也要绿」只搬 read 这一条，append 连它的助手一起
//      留在入口（下一小单的第一件事就是那一行的口径修正）。
//   ② read 工具的两条**私有助手**（`readTaskReceiptTargets` / `taskMessageBlock`）也留在入口：实测闭包
//      会拉进整族「收件视图 / 派生回执」渲染助手（`surfaceMessageEvents` · `surfaceEventText` → `textOf`
//      · `readReceiptTargets` → `SEND_CARD_KIND` / `SEND_CARD_VERSION` · `shortStamp` · `inboxOpening` …），
//      那族归**投递**域（`lib/ledger.js` 档头第 ③ 条已按实测导入闭包把它划走）⇒ 按「形态 / 投递 /
//      其余留给下一单」不动，经缝传入本档。
// ★ 依赖方向（Rr4「模块图无环」的实测口径）：本档**不导入入口** `lib/index.js`（那会构成 ESM 环，
//   实跑当场 TDZ）—— 出边只有三类，模块图仍是单向 DAG：
//   ① 内部相对导入（既有域档）：`./shared.js` 四条（`agentSessionId` / `describeError` / `readStamp` /
//      `wellFormed`）· `./ledger.js` 八条（`BLACKBOARD_LINE_LIMIT` / `DECISIONS_WINDOW` / `TASKS_WINDOW`
//      / `blackboardHash` / `blackboardLines` / `blackboardPaths` / `readBlackboardFile` /
//      `registeredTaskIds`）；
//   ② 宿主导入：`@deepseek-ai/dsh-tools` 的 `defineTool`（既有白名单那 8 条之一 ⇒ `Rr3` 的说明符集合
//      读数一字不变）；
//   ③ **装配缝注入**（先例：`lib/forensics.js` 的 `wireForensics()`、`lib/team-registration.js` 的
//      `wireTeamRegistration(extras)`）：入口侧 8 条出口由 `wireTeamLedgerTools(extras)` 在模块求值时
//      一次性绑定到本档的同名模块级 `let` 上 —— 绑定与搬迁前**逐个同一** ⇒ 行为逐字不变。逐条归属见
//      入口的 `teamLedgerToolsExtras()`。
// ★ 为什么这 8 条走缝而不搬：搬走它们要么是「同一函数两份」、要么与既有归属打架（设计档 §6 明令禁止
//   双事实源），而入口**不能**再导出给域档静态导入（环）⇒ 缝是唯一不破环的路。逐条如实：
//   · 六条（`READ_STALE_NOTE` / `agentCwd` / `readSessionSurface` / `readTeamName` / `tasksDerivedLines`
//     / `textOutput`）在入口侧**另有真实调用点**（状态卡 / 会话面读数 / 台账派生视图 / 输出包装 /
//     时钟常量）；
//   · 两条（`readTaskReceiptTargets` / `taskMessageBlock`）在**本单之后**只剩这一个消费点（就是本档），
//     但它们的实测闭包会拉进整族「收件视图 / 派生回执」助手（见上面第 ② 条）—— 那族归**投递**域，
//     按「形态 / 投递 / 其余留给下一单」不动它们，下一小单搬那族时这两条随之下去。
//   口径如实：本清单是 **word-boundary 宽口径**（在语句原文上按裸词边界匹配，再与入口的顶层绑定名求交）
//   —— `agentCwd` 在语句里只出现在**字符串 / 注释**里（"workspace 在团队首次创建时从会话 agentCwd
//   捕获"），仍照绑：多绑不改变行为，少绑才会 ReferenceError。
// ★ 被钉符号核对（本仓 `hostSource` 文本锁钉住的 9 个：`writePolicyFileAtomic` / `renameThroughSeam` /
//   `POLICY_FILE_SCHEMA` / `WATCHDOG_DIGEST_DEBOUNCE_MS` / `TICKABLE_VERDICTS` / `agentStateLabel` /
//   `writerGate` / `relayUserMessage` / `buildTeamSessionCreateOptions`）：**本单一个都没搬**，九个仍逐字节
//   住在入口；**本档的可执行代码面对这 9 个名字零命中**（机检口径：剥掉全部 `//` 注释行后逐一做裸词
//   边界检索 = 0 —— 上面这几个名字只出现在这条注释里，那是点名核对，不是引用）⇒ 那些「按函数自身锚点
//   切片」的源码锁读数一字不变，本档也**没有任何一条**经缝与它们接触。
// ★ 搬运纪律（D4）：本档新增的只有 ① 本段档头 ② 3 条 import 语句（13 个绑定名） ③ 装配缝 ④ 包住语句的
//   函数签名与花括号；**语句本身一个字符都没动**（含开头那一个 \t 缩进与行尾注释）。
// ---------------------------------------------------------------------------

import { defineTool } from "@deepseek-ai/dsh-tools";

import { agentSessionId, describeError, readStamp, wellFormed } from "./shared.js";
import { BLACKBOARD_LINE_LIMIT, DECISIONS_WINDOW, TASKS_WINDOW, blackboardHash, blackboardLines, blackboardPaths, readBlackboardFile, registeredTaskIds } from "./ledger.js";

// ---------------------------------------------------------------------------
// 装配缝 · `wireTeamLedgerTools(extras)`（先例：`lib/forensics.js` 的 `wireForensics()`）
// ---------------------------------------------------------------------------
// 前置：入口在**模块求值**时调用一次（`lib/index.js` 模块尾部，紧挨 `wireTeamRegistration({…})`），
//       给出的 8 个键与被注入的绑定**同名同值**。
// 后置：本档的模块级 `let` 全部绑定到入口那一份真实现；此后每次工具执行读到的都是它。
// 为什么不是 import：见档头「依赖方向」①（入口 → 域档会成环）。
// 为什么是一次性绑定而不是每次调用现取：工具执行是热路径，绑一次就够；而且 `execute` 体内那几条裸名
// 因此**逐字节保留**（只在函数体外加了这一个缝），D4 的逐字节等价可以直接机检。
// ---------------------------------------------------------------------------
let READ_STALE_NOTE, agentCwd, readSessionSurface, readTaskReceiptTargets, readTeamName, taskMessageBlock, tasksDerivedLines, textOutput;

/** 入口侧出口的一次性绑定（见本节档头的前置 / 后置）。 */
export function wireTeamLedgerTools(extras) {
	({
		READ_STALE_NOTE,
		agentCwd,
		readSessionSurface,
		readTaskReceiptTargets,
		readTeamName,
		taskMessageBlock,
		tasksDerivedLines,
		textOutput,
	} = extras);
}

/**
 * Register the M2 blackboard READER (§3.3.3): `team_link_team_read` — roster summary + the three
 * blackboard files' windows and baseHashes + the §9.3.3 derived ledger view + the §4.3/§4.4 inbox
 * view and derived receipts. Moved verbatim out of `registerTeamTools` in 批 R 第 8 小单; the body is
 * byte-identical to its old position。
 */
export function registerTeamLedgerTools(ctx, policy, rotation) {
	ctx.effect(() => ctx.tools.register(defineTool({
		name: "team_link_team_read",
		description: "读团队黑板（M2，§3.3.3）：读取前先跑一次换届过期清扫（过期的 pending / provisional 窗口不因没人注册看门狗而漏），再返回 roster 概要 + decisions.md 末 20 条 + discipline.md 全文 + tasks.md 末 20 条与任务派生读数（逐任务的「最后主张 / 未消解存疑」——**是读数，不是裁决**）+ **收件视图**（按任务号分组：谁对 t-<n> 说过什么 —— 取调用方**自己**最近 20 条消息里的 ref=t-<n>，无 ref 的消息如实计数、不静默丢弃；未登记的号照样分组并标注）+ **派生回执**（我发出去之后对方动了没有：从调用方自己会话面的投递记录派生，四态 ✅ 有反应 / ⚠ 无后续反应 / 未读 / 未投递（回执 outcome 非 delivered 时，只陈述 outcome、不下结论）—— 目标面**只在 readIds 点名时才读**，未点名一律标「未读」；没有结构化回执时按实参兜底解析寻址表达式，其中按**当前名册**解析出来（`team:<name>/<role>`）的行如实标注「按当前名册解析」——换届之后它未必是投递当时那一个）+ 各文件 baseHash（decisions 的**仅供参考/审计**——decisions 只追加、不接受 baseHash 参数；discipline 的供整文件替换的乐观锁使用）。任何会话可读；写黑板没有权限门，但读要一次读齐省轮次。文件不存在按空处理并如实标注。黑板根目录 = <team.workspace>/team/<name>/（workspace 在团队首次创建时从会话 agentCwd 捕获）。",
		parameters: {
			team: { type: "string", required: true, description: "团队名（须已在 roster 中注册）" },
			readIds: { type: "array", items: { type: "string" }, description: "派生回执要点名读哪些**目标面**（会话 id 数组）。自读（调用方自己的会话面）占 1 个读额，故最多 11 个目标面——成本不变量 ≤ min(12, 1+|readIds|)；超出读额的如实标未读。**不传 = 目标面零读**（回执行一律标「未读」，绝不偷偷变贵）" },
		},
		output: textOutput(),
		timeoutMs: 30000,
		async execute(args, exec) {
			try {
				// §3.6.2 评审 #4/#7: the lazy half of the expiry sweep — a team frozen
				// by a stranded token (or holding an unratified provisional window) also
				// gets its notice when somebody reads the board, not only on a roster
				// touch or a watchdog patrol. The pass is awaited so the lines below
				// describe the post-sweep roster.
				await rotation.sweep({ now: Date.now(), signal: exec?.signal });
				const name = readTeamName(args.team);
				if (name.error !== undefined) return wellFormed(`读取失败：${name.error}`);
				const team = policy.get().teams.find((candidate) => candidate.name === name.value) ?? null;
				if (team === null) return wellFormed(`读取失败：团队 ${name.value} 不在注册表中（先用 team_link_roster action=upsert-team 创建）。`);
				if (team.workspace === "") return wellFormed(`读取失败：团队 ${name.value} 没有 workspace 记录，黑板根目录未知（workspace 在团队首次创建时从会话 agentCwd 捕获；可由用户经设置 UI 补写路径）。`);
				const paths = blackboardPaths(team);
				const decisions = await readBlackboardFile(paths.decisions);
				if (decisions.error !== undefined) return wellFormed(`读取失败：decisions.md 无法读取（${decisions.error}）。`);
				const discipline = await readBlackboardFile(paths.discipline);
				if (discipline.error !== undefined) return wellFormed(`读取失败：discipline.md 无法读取（${discipline.error}）。`);
				const tasks = await readBlackboardFile(paths.tasks);
				if (tasks.error !== undefined) return wellFormed(`读取失败：tasks.md 无法读取（${tasks.error}）。`);
				const rows = blackboardLines(decisions.text);
				const shown = rows.slice(-DECISIONS_WINDOW);
				const decisionsHash = blackboardHash(decisions.text);
				const disciplineHash = blackboardHash(discipline.text);
				const taskRows = blackboardLines(tasks.text);
				const taskShown = taskRows.slice(-TASKS_WINDOW);
				const tasksHash = blackboardHash(tasks.text);
				const lines = [
					`团队 ${team.name} 黑板（根：${paths.dir}）`,
					"",
					"--- roster（概要；事实源 = 设置 team-link 的 teams 键）---",
					`- policy.writer=${team.policy.writer} · 角色 ${team.roles.length} 个`,
				];
				for (const entry of team.roles) lines.push(`- 角色 ${entry.role}：${entry.current === null ? "空缺（vacant）" : `现任 ${entry.current}`}`);
				lines.push("", `--- decisions.md（只追加；此处显示末 ${DECISIONS_WINDOW} 条）---`);
				lines.push(decisions.exists
					? `共 ${rows.length} 条，显示 ${shown.length} 条 · baseHash=${decisionsHash}（仅供参考/审计：decisions 只追加、不接受 baseHash 参数）`
					: `（文件不存在，按空处理：0 条）baseHash=${decisionsHash}（空内容哈希；仅供参考/审计）`);
				for (const row of shown) lines.push(row);
				lines.push("", "--- discipline.md（整文件替换，带 baseHash 乐观锁）---");
				lines.push(discipline.exists ? `baseHash=${disciplineHash}（乐观锁：整文件替换必须携带此值）` : `（文件不存在，按空处理）baseHash=${disciplineHash}（空内容哈希；乐观锁：整文件替换必须携带此值）`);
				lines.push(discipline.text === "" ? "（空）" : discipline.text);
				// §9.3.3: the tasks ledger's read face — the raw window AND the derived
				// view, in that order, with every boundary stated out loud. The window is
				// what a reader can always fall back on; the derivation is a READING of
				// those rows and never a replacement for them (§9.4 "派生是读数").
				lines.push("", `--- tasks.md（只追加台账；显示末 ${TASKS_WINDOW} 条）---`);
				lines.push(tasks.exists
					? `共 ${taskRows.length} 行，显示 ${taskShown.length} 条 · baseHash=${tasksHash}（仅供参考/审计：tasks 只追加、不接受 baseHash 参数）`
					: `（文件不存在，按空处理：0 行）baseHash=${tasksHash}（空内容哈希；仅供参考/审计：tasks 只追加、不接受 baseHash 参数）`);
				// §9.3.3 的派生读数段体由 {@link tasksDerivedLines} **一处**渲染 —— 团队面板读的是同一份字节。
				for (const derivedLine of tasksDerivedLines(taskRows)) lines.push(derivedLine);
				lines.push("（原始行）");
				for (const row of taskShown) lines.push(row);
				// §4.3/§4.4（可观测批 A）: the inbox view + the derived receipts. The
				// SELF read comes first (自读占 1 个额), then the target faces the caller
				// NAMED — and with nothing named there is **zero** target read (U11/U14,
				// asserted through the surface stub). Every unreadable face is labelled
				// 未读: a reading is never computed from data nobody read (N2).
				const caller = agentSessionId(exec);
				const wantedTargets = readTaskReceiptTargets(args.readIds, caller);
				if (wantedTargets.error !== undefined) return wellFormed(`读取失败：${wantedTargets.error}`);
				const selfSurface = caller === undefined ? undefined : await readSessionSurface(ctx, caller);
				const targetSurfaces = new Map();
				const targetSettled = await Promise.allSettled(wantedTargets.ids.map(async (id) => await readSessionSurface(ctx, id)));
				for (let index = 0; index < wantedTargets.ids.length; index += 1) {
					const outcome = targetSettled[index];
					targetSurfaces.set(wantedTargets.ids[index], outcome.status === "fulfilled" ? outcome.value : undefined);
				}
				for (const blockLine of taskMessageBlock({
					selfId: caller,
					selfSurface,
					readIds: wantedTargets.ids,
					targetSurfaces,
					overflowTargets: wantedTargets.overflow,
					// 「已登记」取自**同一个** team 的 tasks.md（就是上面刚读进内存的那份文件：
					// 零额外读），所以「未登记」的标注不会因为另一队的台账而失真。
					registeredIds: registeredTaskIds(tasks.text).ids,
					teams: policy.get().teams,
				})) lines.push(blockLine);
				lines.push("", `单行上限 ${BLACKBOARD_LINE_LIMIT} 字符（§4.1）。写黑板用 team_link_team_append：file=decisions 只追加（无需 baseHash，seq 由插件分配——上面的 decisions baseHash 仅供参考/审计）；file=discipline 整文件替换（必须携带上面的 discipline baseHash，那是唯一的乐观锁）；file=tasks 只追加一条主张（同样无需 baseHash，seq 与任务号由插件分配——上面的 tasks baseHash 仅供参考/审计）。`);
				lines.push("", `（读数 ${readStamp(Date.now())}，${READ_STALE_NOTE}）`);
				return wellFormed(lines.join("\n"));
			} catch (error) {
				return wellFormed(`读取失败：${describeError(error)}`);
			}
		},
	})), "team-link: team read tool");
}

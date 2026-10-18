// ---------------------------------------------------------------------------
// 批 R（上架合规）第 17 小单：换届交接面（/team_rotate 命令 · §11.9.6 交接文档契约 · §4.2 (c) 自建继任者）—— 从 `lib/index.js` 原样搬出
// ---------------------------------------------------------------------------
// 归属：docs/2026-10-15-store-compliance-design.md §4 D1/D2/D4 · §5 FR-R1 · §6（拆分契约：只做「移动 + 补
//       export」、无副作用搬家、模块图无环）· §8 Rr1/Rr3/Rr4/Rr8。
// ★ 本档是什么：入口原 6228–6983 行范围内的**三段相邻块**，共 19 条声明：
//   ① §11.2 `/team_rotate <role>` 的人工入口（命令名 / 键表 / 键提示 / 文法解析器 / 投给现任的指令 /
//      命令注册）＋ §10.2.6 的启动清扫 `sweepPendingCreates`；
//   ② §11.9.6 的交接文档契约（标题归一化 · 正文切分 · 结构报告 · 五硬节脚手架 · 完整性读数 · 缺项阶梯
//      `readHandoffArgument` · 三层渲染 `renderHandoffDocument` · 整档落盘 `writeHandoffDocument`）；
//   ③ §4.2 (c) ④ 自建继任者的交接正文 `selfBuiltHandoffBody` ＋ §4.2 (c) ⑤ 整条链路
//      `appointSelfBuiltSuccessor`（id → 唯一创建落点 → 交接文档 → prepare → 三处留痕 → followup 投递）
//      ＋ `/team_rotate` 的令牌读取器 `readRotationToken`。
//   实测：**46,153 字节**（CRLF 工作树，三段合计）/ **45,486 字节**（EOL 归一到 LF）—— 本小单 60 KB 档位上限之内（本档全文 **55,761 字节** / **54,979 字节**（LF）/ 782 行）。
//   机检口径：把本档那三段正文按声明行去掉 `export ` 前缀后，与入口原位置的同一段**逐字节相等**
//   （EOL 归一）；那三段在入口里**零次**。
//   ★ 它是一个**自成一体的块**：命令入口 → 交接正文契约 → 自建继任者链路互相闭合（正文由 ② 校验、
//     由 ③ 生成，令牌读取器喂 ② 的 claim 面），对外只经下面「装配缝」的 20 条入口侧出口与五条相对导入取物。
// ★ 本档**不是**（留给下一小单 / 被文本锁钉住，逐条点名）：
//   ① `rotationFactRows` 与 `provisionalGuidance` —— `host-half.test.mjs` 的两条**只读 `lib/index.js`** 的
//      正向行模板锁（`:4536` 的 `handoffSource` / `:4875` 的 `HANDOFF_SOURCE`）钉住它们的正文，
//      **没有搬**，只经装配缝注入（本档对它们的可执行引用 = 2 处：`renderHandoffDocument` 的 `facts` 与
//      `provisionalGuidance` 的回退窗口行、`appointSelfBuiltSuccessor` 的 `rotationFactRows`）。
//   ② `ROTATION_BY_CTX` 与 §11.9.4/§11.9.5 的恢复四块（`createRecovery` / `recoveryDiagnosticLines` /
//      `registerRecoveryTools` / `RECOVERY_BY_CTX`）—— 仍在入口，下一小单。
//   ③ 交接文档族在入口的**三条调用点**（`autoHandover` 的 `writeHandoffDocument`、`registerRotationTools` 的
//      `readHandoffArgument` / `writeHandoffDocument` / `readRotationToken`）—— 入口按名导入即可。
// ★ 依赖方向（Rr4「模块图无环」）：本档**不导入入口** `lib/index.js`（那会构成 ESM 环，实跑当场 TDZ）——
//   ① 内部相对导入 **5 条**：`./shared.js`（`describeError` / `maskToken` / `readStamp` /
//      `rotationRateLimited` / `wellFormed`）· `./rotation.js`（`HANDOFF_CLAIMED_PLACEHOLDER` /
//      `HANDOFF_SCHEMA` / `HANDOFF_STATUS_PREPARED` / `freezeNotice` / `handoffDocumentPath` /
//      `latestHandoffDocument` / `planRotationMigration` / `recoveryNote` / `roleOf` / `teamMembers`）·
//      `./recovery.js`（`SELF_SUCCESSOR_LABEL` / `recoveryDecisionRow` / `writeRecoveryTrails`）·
//      `./team-session-creation.js`（`applyInheritedApprovalPolicy` / `collectInheritableSettings` /
//      `createRootAgent` / `inheritanceRowList`）· `./read-surface.js`（`readGoalSignal`）；
//   ② 装配缝注入 **20 条**（先例 `wireForensics()` / `wireWatchdog(extras)` / `wireRecovery(extras)`）：
//      `wireHandover(extras)` 在模块求值时一次性绑定到同名模块级 `let` 上 —— 绑定与搬迁前**逐个同一**
//      ⇒ 行为逐字不变；逐条归属见入口的 `handoverExtras()`。
//   两类出边**都不回指入口或本档** ⇒ 本单**不新增环**。
// ★ 宿主导入 **3 条**：`node:crypto` 的 `randomUUID`、`node:fs/promises` 的 `mkdir` / `writeFile`、
//   `node:path` 的默认导出 —— 三个说明符本来就在那 8 条白名单里 ⇒ `Rr3` 的**集合**读数一字不变。
// ★ 被钉符号核对（本仓 `hostSource` 文本锁钉住的 9 个：`writePolicyFileAtomic` / `renameThroughSeam` /
//   `POLICY_FILE_SCHEMA` / `WATCHDOG_DIGEST_DEBOUNCE_MS` / `TICKABLE_VERDICTS` / `agentStateLabel` /
//   `writerGate` / `relayUserMessage` / `buildTeamSessionCreateOptions`）：**本单一个都没搬**，九个仍逐字节
//   住在入口（定义、文档注释与锚点切片位置一字不动 ⇒ 那几条源码锁读数不变）。本档可执行代码对它们的
//   引用 = **1 个**（`relayUserMessage`：命令指令一次 + 自建继任者的投递一次）—— 它按「被钉符号只注入不搬」
//   经缝传入；其余 8 个在本档**零次**（`writerGate` 只出现在一条英文注释里，不取值、不注入）。
// ★ 搬运纪律（D4）：本档新增的只有 ① 本段档头 ② 5 条 import 语句 ③ 装配缝 ④ 19 条声明行上的 `export `
//   前缀 ⑤ 两处「中间那段没搬」的指路注释；其余（含全部行内注释、嵌套函数与中文文案）**一个字符都没动**。
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { HANDOFF_CLAIMED_PLACEHOLDER, HANDOFF_SCHEMA, HANDOFF_STATUS_PREPARED, ROTATION_BATCH_TTL_MS, freezeNotice, handoffDocumentPath, latestHandoffDocument, planRotationMigration, recoveryNote, roleOf, teamMembers } from "./rotation.js";
import { SELF_SUCCESSOR_LABEL, recoveryDecisionRow, writeRecoveryTrails } from "./recovery.js";
import { readGoalSignal } from "./read-surface.js";
import { describeError, maskToken, readStamp, rotationRateLimited, wellFormed } from "./shared.js";
import { applyInheritedApprovalPolicy, collectInheritableSettings, createRootAgent, inheritanceRowList } from "./team-session-creation.js";

// ---------------------------------------------------------------------------
// 装配缝 · `wireHandover(extras)`（先例：`lib/forensics.js` 的 `wireForensics()`）
// ---------------------------------------------------------------------------
// 前置：入口在**模块求值**时调用一次（`lib/index.js` 模块尾部，紧挨 `wireReadSurface(…)`），给出的 20 个键
//       与被注入的绑定**同名同值**。
// 后置：本档的模块级 `let` 全部绑定到入口那一份真实现；此后命令注册 / 清扫 / 交接正文校验与渲染 /
//       自建继任者链路读到的都是它。
// 为什么不是 import：见档头「依赖方向」（入口 → 域档会成环）。
// 为什么是一次性绑定而不是每次调用现取：绑定之后被搬函数体内的裸名**逐字节保留**（只在函数体外加了
// 这一个缝），D4 的逐字节等价可以直接机检。
// ---------------------------------------------------------------------------
let PLUGIN_LABEL, SEATED_DEAD_LABEL, HANDOFF_HARD_SECTIONS, HANDOFF_SOFT_SECTIONS, HANDOFF_SECTION_HINTS, handoffSectionsInline, TEAM_SESSION_PENDING_TTL_MS, addTeamSessionPending, removeTeamSessionPending, agentCwd, agentIsLive, seatedDeadRoles, trustReferencesTo, teamSessionId, mirrorNote, handoffDeliveryMessage, relayUserMessage, rotationFactRows, provisionalGuidance, readRoleName;

/** 入口侧出口的一次性绑定（见本节档头的前置 / 后置）。 */
export function wireHandover(extras) {
	({
		PLUGIN_LABEL,
		SEATED_DEAD_LABEL,
		HANDOFF_HARD_SECTIONS,
		HANDOFF_SOFT_SECTIONS,
		HANDOFF_SECTION_HINTS,
		handoffSectionsInline,
		TEAM_SESSION_PENDING_TTL_MS,
		addTeamSessionPending,
		removeTeamSessionPending,
		agentCwd,
		agentIsLive,
		seatedDeadRoles,
		trustReferencesTo,
		teamSessionId,
		mirrorNote,
		handoffDeliveryMessage,
		relayUserMessage,
		rotationFactRows,
		provisionalGuidance,
		readRoleName,
	} = extras);
}

// ---------------------------------------------------------------------------
// §11.2 `/team_rotate <role>` — the human trigger for the automatic hand-over
// ---------------------------------------------------------------------------

/**
 * Slash-command name of §11.2 (without the leading slash). It rides the SAME
 * optional `commands` seam as `/team_session` (§10.2.1) — the module-level
 * `inject` array stays at its four entries.
 */
export const TEAM_ROTATE_COMMAND = "team_rotate";
/** The one key this grammar accepts. The role is positional, so the key list
 * stays this short — and the unknown-key refusal prints exactly this list, which
 * is what keeps the message from advertising a key the parser refuses.
 * {@link TEAM_ROTATE_KEY_HINT} is RENDERED FROM this array, so the advertised key
 * set and the accepted key set cannot drift apart in either direction (③a 差异审计
 * 修复轮 🟡-4 / host-half 的双向锁断言). */
export const TEAM_ROTATE_KEYS = ["team"];
/** Per-key help of `/team_rotate`. `null` is the honest value for a key that has
 * no `=<value>` form — none today, but leaving the hole in the map is cheaper
 * than re-shaping it later. */
export const TEAM_ROTATE_KEY_HELP = { team: "<name>（可选）" };
export const TEAM_ROTATE_KEY_HINT = TEAM_ROTATE_KEYS.map((key) => `${key}=${TEAM_ROTATE_KEY_HELP[key] ?? "<值>"}`).join("  ");

/**
 * §11.2's command grammar, and nothing beyond it: `/team_rotate <role> [team=<name>]`.
 * No quoting is supported ON PURPOSE — a team name is `[a-z0-9-]+` and a role name
 * is validated by {@link readRoleName}, so quotes would be syntax the command
 * advertised and then had to strip; a value that carries one is refused instead.
 */
export function readTeamRotateCommand(rawInput) {
	const text = typeof rawInput === "string" ? rawInput.trim() : "";
	const syntax = `/${TEAM_ROTATE_COMMAND} <role> [${TEAM_ROTATE_KEY_HINT}]`;
	if (text === "") return { error: `需要角色名。语法：${syntax}` };
	const value = {};
	for (const token of text.split(/\s+/u)) {
		const at = token.indexOf("=");
		if (at === -1) {
			if (value.role !== undefined) return { error: `只接受一个角色名（已给「${value.role}」，又出现了「${token}」）。语法：${syntax}` };
			value.role = token;
			continue;
		}
		const key = token.slice(0, at);
		const raw = token.slice(at + 1);
		if (!TEAM_ROTATE_KEYS.includes(key)) return { error: `未知参数「${key}=」（本命令只接受 ${TEAM_ROTATE_KEY_HINT}；角色名直接写，不加 key）。` };
		if (raw === "") return { error: `「${key}=」的值为空。` };
		if (/["']/u.test(raw)) return { error: `「${key}=」的值不要带引号（团队名是 [a-z0-9-]+，直接写）。` };
		value[key] = raw;
	}
	if (value.role === undefined) return { error: `需要角色名。语法：${syntax}` };
	return { value };
}

/**
 * §11.2 / §11.9.7: the command only does MECHANISM. `CommandResult` text is
 * rendered by the dispatching UI and never enters the model context, so the
 * command cannot draft the hand-over body itself — it drives the incumbent with
 * this instruction, and the model drafts the body and makes the tool call. The
 * syntax taught here is the syntax the tool implements (one contract, one
 * wording): `successor:"auto"` plus the five hard sections.
 */
export function teamRotateInstruction(teamName, roleName, caller) {
	return [
		`【${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}】你是团队 ${teamName} 的角色 ${roleName} 的现任（会话 ${caller}），有人请你交班。下面是机制步骤，判断由你给：`,
		"",
		"① 起草交接正文（Markdown；五个硬节各以一个标题开头，标题名逐字如下）：",
		...HANDOFF_HARD_SECTIONS.map((name) => `   ## ${name} —— ${HANDOFF_SECTION_HINTS[name]}`),
		`   软节（缺了只警告，不拒绝）：${HANDOFF_SOFT_SECTIONS.map((name) => `## ${name}`).join(" / ")}`,
		"② 然后调用（交接正文放进 handoff 参数；自建继任者、写交接文档、铸令牌、投递都由插件承担）：",
		`   team_link_rotate  action="prepare"  team="${teamName}"  role="${roleName}"  successor="auto"  handoff="<第 ① 步的正文>"`,
		"③ 会弹一个确认框（新建 1 个会话 + 交班的爆炸半径：id / cwd / 模型情形 / 保守成本口径 / 信任面）——人类确认后才会真的建会话；无确认服务则 fail-closed。",
		"④ 之后没有你的动作：继任者凭投给它的令牌自己 claim；rotation-done 广播后旧任即可关闭（插件绝不自动关闭任何会话，§11.4.7）。",
		"",
		`提醒：这份正文是继任者得到的全部（它是零上下文的新根会话）；插件只把关结构（五硬节在场 / 非空 / 有界），不把关内容质量（§11.9.6）。`,
	].join("\n");
}

/**
 * `apply`'s §11.2 entry point. Three things happen here and nothing else: the
 * caller is checked to BE that role's incumbent (§11.2's own gate — the command
 * writes no roster state, so `writerGate` is not the right gate here, and the
 * tool's own `rotateGate` repeats this check one step later), the session is
 * driven with `followup`, and the UI gets a summary.
 *
 * H3 (§11.8 / §11.9.7): driving one's own session from a command handler has no
 * interface-level prohibition, but its turn semantics are a smoke-test item for
 * the restart window — so the summary says so out loud, and the TOOL entry stays
 * the fallback path (a human can always just ask the incumbent in words).
 */
export function registerTeamRotateCommand(ctx, policy, rotation, seam) {
	seam.add({
		name: TEAM_ROTATE_COMMAND,
		build: () => ({
			name: TEAM_ROTATE_COMMAND,
			description: `§11.2 自动换届（③）的人类入口：/${TEAM_ROTATE_COMMAND} <role> [${TEAM_ROTATE_KEY_HINT}]。handler 校验发起会话确为该角色的现任 → 用 followup 把「起草交接正文（五硬节）并调用 team_link_rotate action=prepare successor:"auto"」的指令投给该会话 → 返回摘要给 UI。命令自身不做交接正文（命令的返回值进不了模型上下文，正文必须由模型起草），也绝不自建会话：真正的新建会话 + 交班在工具侧，且必须过一次确认框（§11.4.1）。命令的可用性是可选的：没有 commands 服务时本命令不注册，其余工具面照常（§10.2.1）。`,
			input: { hint: `<role> [${TEAM_ROTATE_KEY_HINT}]`, attachments: false },
			recordInput: true,
			handler: async (invocation) => {
				try {
					const parsed = readTeamRotateCommand(invocation.rawInput);
					if (parsed.error !== undefined) return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：${parsed.error}` };
					const role = readRoleName(parsed.value.role);
					if (role.error !== undefined) return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：${role.error}` };
					const caller = typeof invocation.agent?.id === "string" && invocation.agent.id !== "" ? invocation.agent.id : undefined;
					if (caller === undefined) return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：当前命令没有可交互的活动代理——换届由现任发起，命令必须能驱动发起者自己的会话。` };
					// Every roster touch is a sweep moment (the roster tool's own lazy hook),
					// so a stranded rotation deadline is noticed here too.
					await rotation.sweep({ now: Date.now(), signal: invocation.signal });
					const view = policy.get();
					const named = typeof parsed.value.team === "string" ? parsed.value.team.trim() : undefined;
					const teams = named === undefined ? view.teams : view.teams.filter((team) => team.name === named);
					if (teams.length === 0) {
						// Two different facts, two different sentences: an empty registry is not
						// "the team you named does not exist".
						return { kind: "error", text: named === undefined
							? `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：本机还没有注册任何团队（先用 team_link_roster action=upsert-team 创建，它会把发起会话播种为该队的 coordinator 现任）。`
							: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：团队 ${named} 不在注册表中（先用 team_link_roster action=upsert-team 创建）。` };
					}
					const incumbent = teams.filter((team) => roleOf(team, role.value)?.current === caller);
					if (incumbent.length === 0) {
						const detail = teams.map((team) => {
							const entry = roleOf(team, role.value);
							return entry === null ? `团队 ${team.name} 没有角色 ${role.value}` : `团队 ${team.name} 的角色 ${role.value} 现任是 ${entry.current ?? "（空缺）"}`;
						}).join("；");
						return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：发起会话 ${caller} 不是该角色的现任（${detail}）——换届只能由现任发起（§3.6.2 的 rotateGate 在工具侧作同样判定）。` };
					}
					if (incumbent.length > 1) return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：你在 ${incumbent.length} 个团队担任 ${role.value}（${incumbent.map((team) => team.name).join("、")}）——请用 team=<name> 指定其中一个。` };
					const team = incumbent[0];
					const limited = rotationRateLimited(roleOf(team, role.value), Date.now());
					if (limited.limited) return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND}：该角色现在处于换届速率限制窗口——${limited.reason}。现在唤醒只会让你再撞一次同样的拒绝（§3.6.2 rateLimit(team, role, 10min)），本命令未投递任何指令。` };
					invocation.agent.followup(relayUserMessage(teamRotateInstruction(team.name, role.value, caller), caller));
					return {
						kind: "success",
						text: wellFormed([
							`/${TEAM_ROTATE_COMMAND}：已把「起草交接并调用 team_link_rotate prepare successor:"auto"」的指令投给本会话（团队 ${team.name} 角色 ${role.value}）。`,
							"- 命令只做机制：交接正文（五硬节）由模型起草，插件负责自建继任者、写交接文档、铸令牌、投递。",
							"- 下一步：本会话会被这条 followup 唤醒，随后弹一次确认框；确认之前不会创建任何会话、不铸令牌、不广播 freeze（无确认服务 → fail-closed，§11.4.1）。",
							"- H3 待验（§11.8 / §11.9.7）：命令 handler 驱动自身会话的 followup 尚未真机验证。若这条唤醒没有发生，请直接用自然语言让现任调用 team_link_rotate action=prepare … successor=\"auto\"——工具入口与命令入口并存，工具入口是兜底。",
						].join("\n")),
					};
				} catch (error) {
					return { kind: "error", text: `${PLUGIN_LABEL} /${TEAM_ROTATE_COMMAND} 失败：${describeError(error)}` };
				}
			},
		}),
	});
}

/**
 * §10.2.6 startup sweep: report every `pending-creates` intent that outlived its
 * TTL as an ADOPTABLE session (the create crashed, or the plugin unloaded
 * mid-loop). The row is never deleted on the strength of the guess that the
 * session does not exist — the plugin cannot tell an orphan session from a
 * never-created one, so it hands the list to the human and removes the intent
 * (its report IS the record).
 *
 * The report is the caller's LOG line, so the wording says where it came from.
 * The liveness probe is injected (§11.9.3): the sweep has a `ctx` and therefore a
 * reading, and the reading is used HERE and nowhere durable.
 *
 * @returns `{ reported, lines }` — the durable intents reported, in the caller's
 *   terms; `lines` is the complete startup report (pending-create orphans plus
 *   the seated-dead roster rows).
 */
export async function sweepPendingCreates(ctx, policy, now = Date.now()) {
	const view = policy.get();
	const expired = view.pendingCreates.filter((entry) => entry.expiresAt > 0 && entry.expiresAt <= now);
	// §11.9.3's startup row (computed from the SAME read as the sweep above, so the
	// two halves of one report cannot describe two different rosters). It is a pure
	// read: nothing about liveness is written anywhere, which is the whole point.
	const dead = seatedDeadRoles(view, (id) => agentIsLive(ctx, id));
	let lines = dead;
	if (expired.length === 0) return { reported: [], lines };
	try {
		await policy.update({ pendingCreates: view.pendingCreates.filter((entry) => !expired.includes(entry)) });
	} catch (error) {
		return { reported: [], lines: [...lines, `pending-create 清扫写入失败（${describeError(error)}）：本次未生效，下次启动/巡逻会重试。`] };
	}
	lines = [...lines, ...expired.map((entry) => `- 团队 ${entry.team} 的角色 ${entry.role}：意图于 ${readStamp(entry.createdAt)} 写于创建之前，超时（${readStamp(entry.expiresAt)}）未回填 → 会话 ${entry.sessionId} 可能已创建但未登记，也可能根本没建成：可在侧边栏按这个 id 找它，找到即打开收编并用 team_link_roster action=set-role 重新登记（插件不删任何会话）。`)];
	ctx.logger?.warn?.(`${PLUGIN_LABEL}: ${expired.length} 个 pending-create 意图超时未回填 — 可收编清单见本轮启动报告`);
	return { reported: expired, lines };
}



// ---------------------------------------------------------------------------
// §11.9.6 hand-over document contract (③a)
// ---------------------------------------------------------------------------
//
// HONESTY, STATED WHERE IT BELONGS (design §11.9.6, almost verbatim): the plugin
// can only vet the STRUCTURE of a hand-over body — a section is present,
// non-empty and bounded — it can NOT vet CONTENT QUALITY. The presence gate
// guards against FORGETTING, not against going through the motions: a body that
// writes "TODO" under all five headings passes this gate, and nothing here
// pretends otherwise.


/** A heading line's normalized name: `## Task and Goal:` → `task-and-goal`. The
 * folding (`_`/whitespace → `-`) is what makes "task_and_goal" and
 * "Task and Goal" the same section instead of two silent near-misses. */
export function normalizeHandoffSection(title) {
	return String(title ?? "").trim().toLowerCase().replace(/[\s_]+/gu, "-").replace(/^-+|-+$/gu, "");
}

/**
 * Split one hand-over body into its named sections. Pure text handling, and the
 * heading recognition is deliberately forgiving (`#`…`######`, an optional
 * trailing colon, any case, `-`/`_`/spaces inside the name): a body the model
 * DID write must not be refused over a heading style (§11.9.6 — the gate is
 * about presence, and a false refusal is a gate that lies).
 *
 * @returns `{ preamble, sections }` — `preamble` is the text before the first
 *   heading, kept so the document can carry the model's own words verbatim.
 */
export function parseHandoffBody(text) {
	const preamble = [];
	const sections = [];
	let current = null;
	for (const line of String(text ?? "").split(/\r?\n/u)) {
		const heading = /^\s*#{1,6}\s*(.*?)\s*$/u.exec(line);
		if (heading !== null && heading[1] !== "") {
			const title = heading[1].replace(/[:：]\s*$/u, "").trim();
			current = { name: normalizeHandoffSection(title), title, lines: [] };
			sections.push(current);
			continue;
		}
		if (current === null) preamble.push(line);
		else current.lines.push(line);
	}
	return { preamble, sections };
}

/**
 * §11.9.6's structural report of one body: which HARD sections are absent, which
 * are present but EMPTY, which SOFT ones are absent. Pure — the ladder that
 * decides refuse-vs-warn lives in {@link readHandoffArgument}, so the counting
 * and the decision can be read (and asserted) separately.
 */
export function handoffBodyReport(text) {
	const parsed = parseHandoffBody(text);
	const contentOf = (name) => {
		const section = parsed.sections.find((candidate) => candidate.name === name);
		return section === undefined ? undefined : section.lines.join("\n").trim();
	};
	const missingHard = [];
	const emptyHard = [];
	for (const name of HANDOFF_HARD_SECTIONS) {
		const content = contentOf(name);
		if (content === undefined) missingHard.push(name);
		else if (content === "") emptyHard.push(name);
	}
	return {
		parsed,
		missingHard,
		emptyHard,
		missingSoft: HANDOFF_SOFT_SECTIONS.filter((name) => contentOf(name) === undefined),
	};
}

/** The five-hard-section scaffold a refusal hands back (§11.9.6), rendered from
 * the same lists the validator uses. */
export function handoffScaffold() {
	const lines = ["交接正文用 Markdown 写，五个硬节各以一个标题开头（标题名与下面逐字一致）：", ""];
	for (const name of HANDOFF_HARD_SECTIONS) lines.push(`## ${name}`, HANDOFF_SECTION_HINTS[name] ?? "", "");
	lines.push(`软节（缺了只警告，不拒绝）：${HANDOFF_SOFT_SECTIONS.map((name) => `## ${name}`).join(" / ")}`);
	return lines.join("\n");
}

/** The header's integrity verdict, rendered from the SAME report the ladder
 * decided on — so the document can never claim a completeness the gate did not
 * measure (the cross-round lesson: one fact, one source). */
export function handoffIntegrityLine(report) {
	const complete = HANDOFF_HARD_SECTIONS.length - report.missingHard.length - report.emptyHard.length;
	const soft = report.missingSoft.length === 0
		? `软节齐全（${HANDOFF_SOFT_SECTIONS.length}/${HANDOFF_SOFT_SECTIONS.length}）`
		: `软节缺 ${report.missingSoft.length}/${HANDOFF_SOFT_SECTIONS.length}（${report.missingSoft.join("、")}）`;
	return `结构完整：硬节 ${complete}/${HANDOFF_HARD_SECTIONS.length}、${soft}；插件只把关结构（节在场 / 非空 / 有界），不把关内容质量——presence 门防遗忘、不防敷衍（§11.9.6）`;
}

/**
 * §11.9.6's 缺项阶梯, evaluated at the TOOL ENTRY and therefore before any side
 * effect: `successor:"auto"` plus a missing/empty body is refused here (zero
 * session, zero token, zero freeze), a missing hard section is refused BY NAME,
 * a missing soft section is a warning, and an EXPLICIT successor with no body at
 * all is allowed with a warning (M4's existing semantics are not tightened for
 * it — that session has its own life and context).
 *
 * ③a 差异审计修复轮 🟡-6: the two refusals below say WHICH successor form they
 * are talking about, rendered from THIS call's own `auto` flag rather than from
 * the case the branch was originally written for. The wording is the design's
 * (`successor:"auto"`), but it is now derived, so a future second entry point
 * that reaches these lines with an explicit successor cannot be told a story
 * about a path it did not take.
 *
 * @returns `{ error }` (refuse) or `{ body, warnings, report }` (proceed).
 */
export function readHandoffArgument(value, options = {}) {
	const auto = options.auto === true;
	// The path label of THIS call (🟡-6). `successor:"auto"` is the §11.2 name of
	// the automatic path; an explicit successor is named by its own value.
	const pathHere = auto ? "successor:\"auto\"" : "显式 successor";
	const present = typeof value === "string" && value.trim() !== "";
	if (!present) {
		if (!auto) {
			return {
				body: "",
				report: null,
				warnings: [`未提供交接正文（handoff）：显式指定的继任者有自己的会话与上下文，M4 现有语义不因此收紧（§11.9.6 缺项阶梯）——但交接正文是头部/事实段之外唯一能留下判断的东西，建议下次仍按五硬节写一份：${handoffSectionsInline()}。`],
			};
		}
		return {
			error: `prepare 被拒绝（${pathHere} + 交接正文缺失或为空）：auto 路径造出的继任者是零上下文的新根会话，交接正文是它得到的全部——空正文的自动换届等于造一个失忆的持钥者（§11.9.6）。本次零建会话、零令牌、零 freeze。\n\n${handoffScaffold()}`,
		};
	}
	const report = handoffBodyReport(value);
	const named = [...report.missingHard.map((name) => `${name}（缺）`), ...report.emptyHard.map((name) => `${name}（空）`)];
	if (named.length > 0) {
		return {
			error: `prepare 被拒绝（${pathHere} + 交接正文缺硬节）：${named.join("、")}。本次零建会话、零令牌、零 freeze——请补齐后重试。\n\n${handoffScaffold()}`,
		};
	}
	const warnings = [];
	if (report.missingSoft.length === 0) warnings.push(`交接正文结构完整：硬节 ${HANDOFF_HARD_SECTIONS.length}/${HANDOFF_HARD_SECTIONS.length}、软节 ${HANDOFF_SOFT_SECTIONS.length}/${HANDOFF_SOFT_SECTIONS.length} 齐全（头部已记录）。`);
	else warnings.push(`交接正文缺软节：${report.missingSoft.join("、")}（放行——软节缺失只警告；头部已记录，§11.9.6）。`);
	return { body: value, warnings, report };
}
// ---------------------------------------------------------------------------
// §11.9.6 交接文档契约的**渲染与落盘**两段（中间 `rotationFactRows` / `provisionalGuidance` 没搬，见档头「本档不是」①）
// ---------------------------------------------------------------------------

/**
 * §11.9.6's three layers, rendered: the header the plugin writes (schema / team /
 * role / both session ids / preparedAt / claimedAt / the token MASK /
 * rotationStatus / the integrity verdict), the fact section the plugin writes
 * from {@link rotationFactRows} + {@link provisionalGuidance} (the same sources
 * the claim's own report reads), and the model's body — carried verbatim, because
 * it is the successor's whole context and the plugin has no business editing it.
 */
export function renderHandoffDocument(request) {
	const report = request.report;
	const lines = [
		"---",
		`schema: ${HANDOFF_SCHEMA}`,
		`team: ${request.teamName}`,
		`role: ${request.roleName}`,
		`previous: ${request.previous ?? "（空缺）"}`,
		`successor: ${request.successor}`,
		`preparedAt: ${new Date(request.preparedAt).toISOString()}`,
		`claimedAt: ${HANDOFF_CLAIMED_PLACEHOLDER}`,
		`tokenMask: ${maskToken(request.token)}`,
		`rotationStatus: ${HANDOFF_STATUS_PREPARED}`,
		`integrity: ${handoffIntegrityLine(report)}`,
		"---",
		"",
		`# 交接文档：团队 ${request.teamName} 的角色 ${request.roleName}`,
		"",
		"## 事实段（插件写；与 claim 返回文案同一事实源，§11.9.6）",
		"",
		`- 退役者 → 继任者：${request.previous ?? "（空缺）"} → ${request.successor}（写入读数 ${readStamp(request.preparedAt)}）`,
		// ★ 批 P · FR-P3 ③：继承清单（逐项：值 或 未继承（原因：…））—— 与确认框正文、
		// prepare 回执同一份 `inheritanceRows`。直接调用本渲染器（测试 / 未来的别的写入方）
		// 没给这个读数时**如实说没采集**，不编造三行。
		"- 继任者继承的设置（批 P · FR-P3，逐项：值 或 未继承（原因：…）；三处同源 = 确认框正文 / prepare 回执 / 本节）：",
		...(Array.isArray(request.inheritance) && request.inheritance.length > 0
			? request.inheritance.map((row) => `  - ${row}`)
			: ["  - （本次未采集继承读数——直接调用交接文档写入面时没有这个读数；两条换届路径都会带）"]),
		...(typeof request.approvalApplication === "string" && request.approvalApplication !== ""
			? [`  - ${request.approvalApplication}`]
			: []),
		`- freeze 广播正文（与投出的 rotation-freeze 同一常量，§4.2）：${freezeNotice(request.teamName, request.roleName, request.previous ?? "（空缺）", request.successor, request.preparedAt)}`,
		"- freeze 投递结果（含 no-agent 未投递名单）：本文件先于广播写入，逐目标结果在 prepare 的返回里；换届落定后的汇总在 claim 的 rotation-done 广播行里。",
		`- 域内待迁移的 pairs（候选 ${request.facts.migration.length} 行）与未迁移清单：`,
		...request.facts.migration,
		...request.facts.dropped,
		`- ${request.facts.revocation[0] ?? "对称撤销（§3.6.1 原则 3）：（无记录）"}`,
		`- ${provisionalGuidance({ now: request.preparedAt, successor: request.successor, provisional: true, status: "" })}`,
		"- 上下一份交接文档：",
		request.previousDocument === null
			? "  - 上一份：（无——这是本团队本角色落盘的第一份交接文档）"
			: `  - 上一份：${request.previousDocument}`,
		"  - 下一份：（尚未写入——下一次换届生成新文件；本文件不追写，§11.4.3）",
		"",
		"## 正文（旧任模型撰写，插件原样保留）",
		"",
		request.body.trimEnd(),
		"",
	];
	return wellFormed(`${lines.join("\n")}`);
}

/**
 * Write one hand-over document (§11.4.3 / §11.9.6). The plugin writes it — no
 * new model-facing blackboard write face is added, so the write surface does not
 * grow. It is a single whole-file write, which is why the blackboard's 2000-code-
 * point per-line bound does not apply here, and the timestamped name is why no
 * optimistic lock is needed.
 *
 * @returns `{ ok, path }` or `{ ok: false, error }` — the auto path treats a
 *   failure as abort-before-prepare (§11.9.6).
 */
export async function writeHandoffDocument(team, request) {
	if (team.workspace === "") return { ok: false, error: "团队没有 workspace 记录，无法定位 <workspace>/team/<name>/handoff-*.md" };
	const previous = await latestHandoffDocument(team, request.roleName);
	try {
		const file = handoffDocumentPath(team, request.roleName, request.preparedAt);
		await mkdir(path.dirname(file), { recursive: true });
		// The team row is the authority for the team name (the same rule the header
		// rows follow): a caller cannot render a document about another team than the
		// one whose directory it lands in.
		await writeFile(file, renderHandoffDocument({ ...request, teamName: team.name, previousDocument: previous.path }), "utf8");
		return { ok: true, path: file, previousDocument: previous.path, previousError: previous.error };
	} catch (error) {
		return { ok: false, error: describeError(error) };
	}
}
// ---------------------------------------------------------------------------
// §4.2 (c) ④/⑤ 自建继任者（正文 ＋ 整条链路）与 `/team_rotate` 的令牌读取器
// ---------------------------------------------------------------------------

/**
 * §4.2 (c) ④: the hand-over body the PLUGIN writes for a self-built successor.
 * The published `successor:"auto"` path takes that body from the model; this
 * path has no model in it at all (that is the point — the box has one synthetic
 * candidate and no place to type a body), so the plugin renders the five HARD
 * sections from roster facts and marks everything it cannot read as UNKNOWN.
 *
 * The honesty rule is §11.9.6's, and `unknowns` is the section it lands in: the
 * incumbent is dead BY PREMISE (this verb only runs on a seated-dead role), so
 * nothing about its in-flight work is observable from here, and inventing a
 * plausible-looking note would hand a fresh session a fabricated memory.
 *
 * ONE section has a real data source and therefore is not automatically UNKNOWN:
 * `task-and-goal` renders the goals reading when {@link readGoalSignal} produced
 * one (the same reading `in-flight` reports as evidence), and says 未知 only when
 * there was no reading to render — §4.2 (c) ④'s 「读不到才标未知」, in code. In this
 * verb's normal case the incumbent has no live agent, so the reading is absent and
 * the section really is unknown; the branch exists so the section cannot keep
 * declaring a source it never consumes (差异审计第 8 条).
 *
 * @returns one markdown body whose five hard sections are present and NON-EMPTY
 *   (asserted against {@link HANDOFF_HARD_SECTIONS} in the host suite).
 */
export function selfBuiltHandoffBody(request) {
	const trust = request.trust;
	const lines = [
		"## mission",
		`接管团队 ${request.teamName} 的角色 ${request.roleName}（本会话由 team_link_recover action=reappoint 的「${SELF_SUCCESSOR_LABEL}」路径新建：该角色的前任在本进程没有活动代理，人类在候选里选的是**由插件新建一个会话**，而不是把该角色改任给某位活成员）。`,
		`- 前任会话（roster 事实）：${request.incumbent}`,
		`- 发起会话：${request.caller === undefined || request.caller === "" ? "（无会话身份）" : request.caller}`,
		`- 本会话的工作目录：${request.cwd}`,
		"",
		"## in-flight",
		"前任已死，进行中工作不可读——本插件只读 roster 事实，不读会话正文，所以这一节不做任何推测。",
		request.goal.readable ? `- goals 服务读数（该角色前任的会话）：${request.goal.text}` : `- goals 服务：读不到（${request.goal.reason}）。`,
		"",
		"## commitments",
		"该角色记在前任名下的信任指针（只报**存在性与数量**，不复制任何密钥素材）：",
		`- pairs：${trust.pairs} 条`,
		`- trustedSenders：${trust.trustedSenders} 条`,
		`- rememberTargets：${trust.rememberTargets} 条`,
		"迁移方式（§11.9.5）：这些信任**不在本次迁移**——你本人凭令牌调用 team_link_rotate action=claim 时逐项勾选要迁移的 pairs；无人值守（超时 / 无确认服务）则全部以 provisional 迁移，24h 内未获人类批准自动回退。",
		"",
		"## unknowns",
		"- 前任的进行中工作（未落盘的计划、正在跑的工具调用、未发出的消息）——不可读，本节不做推测。",
		"- 前任的会话正文与对话上下文——本插件不读会话正文（导出面是给人用的，不在恢复链路上），交接文档不复制任何会话内容。",
		// §4.2 (c) ④ + §11.9.6 诚实原则: a section may only call something unknown if it
		// still IS unknown. Once the goals service answered, the goal stops being an
		// unknown — what stays unknowable is the part the reading never covered.
		...(request.goal.readable
			? ["- 前任 goal 的**正文与后续意图**——goals 读数只有 phase / activation / rounds 三项，goal 正文与它打算怎么继续不在本插件的读面上。"]
			: [`- 前任的 goal：${request.goal.reason}`]),
		"- 前任是否有未提交的代码改动、是否有别的会话在等它——本插件无从观测（不在它的读面上）。",
		"",
		"## task-and-goal",
		// §4.2 (c) ④: this section's declared data source IS the goals reading — the same
		// reading `in-flight` reports as evidence. Hard-coding 未知 here while computing a
		// reading above was the section declaring a source it never consumed (差异审计第 8 条):
		// the reading is rendered here, and 未知 is kept for the case that really has none.
		...(request.goal.readable
			? [
				`- 该角色的 goal（goals 服务读数，读自该角色前任的会话 ${request.incumbent}）：${request.goal.text}`,
				"- 该读数是**停工时刻的快照**（只有 phase / activation / rounds），不是它的计划；需要更完整的任务上下文时，由人类或在场的旧任补写本节。",
			]
			: [
				"- 该角色的任务与目标：**未知**——goals 按 agent 取读数，而前任没有活动代理，因此这一节读不到任何东西；本文件禁止编造。",
				"- 请由人类，或在场的旧任，补写这一节；插件只保证结构（五硬节在场且非空），不保证内容。",
			]),
		"",
	];
	return lines.join("\n");
}
/**
 * §4.2 (c): the whole chain for the synthetic successor, with nothing re-spelled —
 * §10.2.2 id → the SAME creation path `/team_session` and `successor:"auto"` use →
 * the hand-over document → the published `prepare` VERBATIM → the same three audit
 * trails → the §11.4.5 `followup` that delivers the token and the body to the session
 * that was just built. (The capability gate is answered by `reapIncumbent` before the
 * box opens: this function is only reached when the host CAN build a successor.)
 *
 * The order of the middle three follows §11.9.6 (the document is written BEFORE
 * `prepare`, so a document failure aborts before any token exists) and therefore
 * matches the auto path's own sequence rather than the list order in §4.2 (c) —
 * the design's numbering names the ELEMENTS, and §11.9.6 is the ordering. Delivery is
 * last for the reason §11.4.5 gives: the token has to exist before it can be handed
 * over, and the successor has to be WOKEN, not merely told.
 *
 * @returns `{ lines }` or `{ error }` — every failure path states its own
 *   side-effect boundary, and none of them rolls a created session back
 *   (§10.2.6: a session on disk may already be open somewhere).
 */
export async function appointSelfBuiltSuccessor(deps, request) {
	const { ctx, policy, rotation, controller } = deps;
	const { teamName, roleName, caller, signal, now, incumbent, team, candidates } = request;
	const teamSession = controller.teamSession;
	const rootCtx = teamSession?.rootCtx;
	// The successor's workspace: the TEAM's own recorded workspace when there is one
	// (this team's roster mirror and hand-over documents live under it), and the
	// initiating session's cwd as the fallback. `process.cwd()` is never used — a
	// successor created in the host process's own directory would be in the wrong
	// workspace (the same boundary the auto path draws).
	const cwd = typeof team?.workspace === "string" && team.workspace !== "" ? team.workspace : agentCwd({ agent: request.agent });
	if (typeof cwd !== "string" || cwd === "" || !path.isAbsolute(cwd)) {
		const teamWorkspace = team?.workspace === undefined || team.workspace === "" ? "（未记录）" : team.workspace;
		const callerCwd = request.agent?.session?.header?.cwd ?? "（未捕获）";
		return { error: `恢复失败（reappoint，${SELF_SUCCESSOR_LABEL}）：无法确定新会话的工作目录（团队 workspace = ${teamWorkspace}；发起会话的 cwd = ${callerCwd}）——会话边界只接受绝对路径（§10.2.6），本次零创建、零令牌、零 freeze、零写入。` };
	}
	const sessionId = teamSessionId(teamName, roleName, () => randomUUID());
	// The token is minted BEFORE the document, because the document's header carries
	// its MASK (§11.9.6) — the identical look-ahead the auto path does. Nothing of it
	// becomes durable unless this call reaches `prepare`.
	const token = randomUUID();
	// ---- ② the durable intent BEFORE the create (§10.2.6) --------------------
	try {
		await addTeamSessionPending(policy, { team: teamName, role: roleName, sessionId, createdAt: now, expiresAt: now + TEAM_SESSION_PENDING_TTL_MS, by: caller ?? "" });
		teamSession.pending.set(sessionId, { team: teamName, role: roleName, sessionId });
	} catch (error) {
		return { error: `恢复失败（reappoint，${SELF_SUCCESSOR_LABEL}）：pending-create 意图写入失败（${describeError(error)}）——未创建（宁可不建，也不留一个没有意图记录的孤儿）。本次零创建、零令牌、零 freeze。` };
	}
	// ---- ③ create from the plugin ROOT ctx (§10.2.2 / §10.2.5) --------------
	// 批 P · FR-P2（D1/D3/D6）：与 auto 路径**同一句**接线 —— preset / provider / model 三项
	// 从**前任自己存下的那一份**来（{@link collectInheritableSettings}；读不到或不可解析的项是
	// `null` ⇒ `?? undefined` ⇒ 落宿主缺省，NF-P3）；**审批档不进 plan**（D6：创建函数逐字不改，
	// FR-P4 在创建返回之后设）。★ 这条路径的前任**按定义就是死的那一个**（recoveryPreflight 的
	// 「读到读数」那一支），所以它读的正是探针 3 的会话级冷读面（`sessionQuery.readSession` 的
	// header）—— Pi9 覆盖的就是这一条。
	const inheritance = await collectInheritableSettings(ctx, incumbent);
	const inherited = inheritance.values;
	let creation;
	try {
		creation = await createRootAgent(ctx, rootCtx, { preset: inherited.preset ?? undefined, provider: inherited.provider ?? undefined, model: inherited.model ?? undefined, team: teamName }, { sessionId, role: roleName }, cwd);
	} catch (error) {
		return { error: `恢复失败（reappoint，${SELF_SUCCESSOR_LABEL}）：继任者会话创建失败（${describeError(error)}）。未铸令牌、未广播 freeze；pending-create 意图保留，启动清扫会把它报进可收编清单（§10.2.6）。` };
	}
	const handle = creation.handle;
	teamSession.handles.set(sessionId, handle);
	// ---- ③b FR-P4：审批档**在创建返回之后**设（与 auto 路径同一句接线，同一步时序）-----
	const approvalApplication = await applyInheritedApprovalPolicy(inherited, inheritance.writeFace, handle);
	// ---- ④ the hand-over document, BEFORE prepare (§11.9.6) -----------------
	// The facts are re-read HERE rather than reused from the pre-dialog view: the box
	// spanned an unbounded human wait, so the counts this document states must be the
	// counts of the store `prepare` is about to snapshot — the same TOCTOU discipline
	// the two verbs apply to their incumbent before writing.
	const factsView = policy.get();
	const factsTeam = factsView.teams.find((record) => record.name === teamName) ?? team;
	const held = trustReferencesTo(factsView, incumbent);
	const plan = planRotationMigration(factsView, { members: new Set(teamMembers(factsTeam)), retiree: incumbent, successor: sessionId });
	// §11.9.6's honesty rule, applied to the one fact this path could otherwise
	// fabricate: the role's goal is read from a DEAD incumbent, so the plugin reports
	// exactly what the host can answer and marks the rest unknown.
	const goalAgent = typeof ctx.agents?.get === "function" ? ctx.agents.get(incumbent) : undefined;
	const goalSignal = readGoalSignal(ctx, incumbent, goalAgent);
	const goal = goalSignal === null
		? { readable: false, reason: "goals 服务不可用（宿主没有这个服务），该角色的目标读不到" }
		: goalAgent === undefined
			? { readable: false, reason: `该角色的前任会话 ${incumbent} 没有活动代理——goals 按 agent 取读数，所以取不到` }
			: { readable: true, text: `phase=${goalSignal.phase} · activation=${goalSignal.activation} · rounds=${goalSignal.rounds}` };
	const body = selfBuiltHandoffBody({
		teamName,
		roleName,
		incumbent,
		caller,
		cwd,
		goal,
		trust: { pairs: held.pairs.length, trustedSenders: held.trustedSenders.length, rememberTargets: held.rememberTargets.length },
	});
	const document = await writeHandoffDocument(factsTeam, {
		roleName,
		previous: incumbent,
		successor: sessionId,
		token,
		preparedAt: now,
		body,
		report: handoffBodyReport(body),
		// 批 P · FR-P3 ③：继承三行 + 审批档落地读数（与 auto 路径同一份 `inheritanceRows`）。
		inheritance: inheritanceRowList(inheritance.rows),
		approvalApplication: approvalApplication.line,
		facts: rotationFactRows({
			retiree: incumbent,
			successor: sessionId,
			candidates: plan.candidates,
			dropped: plan.dropped,
			removedCount: held.pairs.length,
			trustedSenderCount: held.trustedSenders.length,
			rememberTargetCount: held.rememberTargets.length,
		}),
	});
	if (document.ok !== true) {
		return { error: `恢复失败（reappoint，${SELF_SUCCESSOR_LABEL}，abort-before-prepare §11.9.6）：交接文档写入失败（${document.error}）——不铸令牌、不广播 freeze。已建的继任者会话 ${sessionId} 保留并如实报为孤儿（§10.2.6 部分成功不回滚）；pending-create 意图保留，启动清扫会把它报进可收编清单。` };
	}
	// ---- ⑤ prepare: the published M4 mechanism, step for step -----------------
	const prepared = await rotation.prepare({ teamName, roleName, successor: sessionId, note: recoveryNote("reappoint", caller), caller, now, signal, token, recovery: { verb: "reappoint", from: incumbent, by: caller ?? "" } });
	if (prepared.error !== undefined) {
		return { error: `${prepared.error}（reappoint，${SELF_SUCCESSOR_LABEL}：令牌从未落盘、freeze 未广播；交接文档 ${document.path} 已写但本次换届不存在。已建的会话 ${sessionId} 保留并报为孤儿——pending-create 意图保留，启动清扫会把它报进可收编清单。）` };
	}
	// ---- ⑥ the intent is resolved: this session IS the rotation's successor ---
	try {
		await removeTeamSessionPending(policy, sessionId);
	} catch (error) {
		ctx.logger?.warn?.(`${PLUGIN_LABEL}: pending-create intent ${sessionId} could not be cleared after prepare (${describeError(error)}) — 启动清扫会把它报进可收编清单（换届本身已生效）`);
	}
	teamSession.pending.delete(sessionId);
	// ---- ⑦ the same three audit trails the other branch writes --------------
	const after = policy.get();
	const teamAfter = after.teams.find((record) => record.name === teamName) ?? null;
	const row = { verb: "reappoint", at: now, by: caller ?? "", from: incumbent, to: sessionId, note: recoveryNote("reappoint", caller) };
	const reason = `现任无活动代理（${SEATED_DEAD_LABEL}）；继任者 = 插件自建的根会话 ${sessionId}（${SELF_SUCCESSOR_LABEL}，空上下文）`;
	const trails = teamAfter === null
		? { mirror: { ok: false, error: `团队 ${teamName} 不在注册表中` }, decisions: "（未写：团队不在注册表中）" }
		: await writeRecoveryTrails(teamAfter, { ...row, team: teamName, role: roleName, reason, decision: recoveryDecisionRow({ ...row, team: teamName, role: roleName, reason }) });
	// ---- ⑧ drive it: followup, never inject (§11.4.5) -----------------------
	// The tail this chain was missing (差异审计第 9 条): the token and the hand-over body
	// were minted, written and audited, but never TOLD to the session they belong to —
	// so a freshly built successor sat idle forever, holding a token nobody delivered.
	// The auto path's own step 8 is these same lines; `followup` and not `inject`
	// because the successor has to be WOKEN, and the message rides the same audited
	// three-member source ({kind, form, senderSessionId}).
	let delivered = true;
	let deliveryError;
	try {
		handle.agent.followup(relayUserMessage(handoffDeliveryMessage({ teamName, roleName, previous: incumbent, token, documentPath: document.path, body }), caller));
	} catch (error) {
		delivered = false;
		deliveryError = describeError(error);
	}
	const candidateSummary = candidates.map((candidate) => (candidate.synthetic === true ? SELF_SUCCESSOR_LABEL : `${candidate.role}→${candidate.session}`)).join("、");
	const titleLine = creation.title === undefined
		? "标题（DEFECT-4）：本次**未设成**标题（原因见上文那行 warn）——它会显示为宿主的默认标题（很可能是工作区名，在侧边栏里认不出来）。"
		: `标题（DEFECT-4）：已命名为「${creation.title}」（按「<team> · <role>」派生；不设标题会让它显示为工作区名、与其他会话无法区分）。`;
	return {
		lines: [
			`恢复：已按 §11.9.4 L2 铸好换届包（reappoint，${SELF_SUCCESSOR_LABEL}）：团队 ${teamName} 的角色 ${roleName}，${incumbent === null ? "（空缺）" : incumbent} → ${sessionId}（**由插件新建的根会话**：人类在对话框里选了「${SELF_SUCCESSOR_LABEL}」，插件按 §10.2.2 铸造 id；读数 ${readStamp(now)}）。`,
			`- 候选集（宿主计算，模型不可指定）：${candidateSummary}`,
			`- 交接文档（§11.9.6，插件从 roster 事实生成的五硬节）：${document.path}（上一份：${document.previousDocument ?? "（无——本角色落盘的第一份）"}）——读不到的项在正文里逐条点名（**如实标未知**），没有编造任何内容；task-and-goal 一节填的是 goals 服务的读数（读不到才标未知）。`,
			// ★ 批 P · FR-P3 ②（prepare 回执）：与确认框正文、交接文档事实段**同一份三行**；
			// 审批档那一行再加一条落地读数（FR-P4 是创建返回之后设的，回执必须如实说设成了没有）。
			"- 继承清单（批 P：逐项；值或未继承原因）：",
			...inheritanceRowList(inheritance.rows).map((row) => `  - ${row}`),
			...(approvalApplication.line === null ? [] : [`  - ${approvalApplication.line}`]),
			titleLine,
			delivered
				? `投递（§11.4.5）：已用 followup 把令牌与交接正文投给 ${sessionId}（不是 inject——任务需要驱动；消息 source 仍恰三成员 {kind, form, senderSessionId}）。`
				: `投递失败（${deliveryError}）：令牌已生效但继任者没收到——可把交接文档 ${document.path} 与令牌重新交给它，或等 30 分钟超时清扫取消本次换届（§11.5）。`,
			`- 代价如实声明（§4.2 (c)）：继任者是**空上下文的新会话**——前任的历史/对话**不迁移**；信任也不在本次迁移，靠它本人凭令牌 claim 时逐项勾选（无人值守则 provisional + 24h 回退）。`,
			"- 生命周期（§10.2.5）：该会话的 AgentHandle 由插件持有——插件卸载/重载会把它的代理一起拆掉，会话仍在盘上；而它的 id 就是插件自建形，所以此后同类死亡都有 L1（revive）可走。",
			`- 审计留痕（§11.9.5⑦，三处）：① 版本史备注 ${row.note}；② ${mirrorNote(trails.mirror)}；③ 黑板 ${trails.decisions}`,
			...prepared.lines,
			"下一步（§11.4.4 → §11.4.6，claim 逐字不动）：把令牌与交接文档交给继任者会话，由它本人调用 team_link_rotate action=claim；claim 会再走一次人类确认（逐项勾选 pairs），无人值守则 provisional + 24h 回退。两道人类关卡 + 24h 回退网，不合并、不省略（§11.9.5）。",
			`- policy.writer 未动（仍是 ${teamAfter === null ? "（未知）" : teamAfter.policy.writer}）：恢复不改权限模型，也绝不把 writer 降级为 any（§11.9.5⑥）。`,
		],
	};
}

// ---------------------------------------------------------------------------
// 批 S · 整队换届（`team_link_rotate action=prepare-batch`）的**执行面**
// ---------------------------------------------------------------------------
// 归属：docs/2026-10-18-team-rotation-design.md §5 FR-S2/S3 · §6 伪代码（mintOne / 建会话 / 交接文档）
// · §9 边界「确认后执行期失败」（D11）。
// ★ 为什么在这里而不是 `lib/rotation.js`：执行面必须调 `createRootAgent` / `collectInheritableSettings` /
//   `applyInheritedApprovalPolicy` / `writeHandoffDocument` 这一族，而 `handover.js` 已经**导入**
//   `rotation.js`（反向导入会成环，Rr4）。所以它是交接域的一个导出，由入口交给换届域的 `extras.batch`。
// ★ 它与 `autoHandover`（入口）走**同一条创建路径、同一句注入**（DENFECT-1/3/4 与批 P 的继承四件套都靠
//   `createRootAgent` 那一个落点）；差别只在编排：批量把「建会话 / 写文档 / 铸令牌」与「一次写盘」拆开，
//   好让 N 个角色共用**一笔** `policy.update`（D3 / NF-S1）。

/**
 * 整队换届的执行面，一处装配（入口 `apply` 以 `batchRotationExtras({ ctx, policy, teamSession })` 取它）。
 * 前置：`teamSession` 是 `apply` 建的那个控制器（rootCtx / pending / handles 都挂在它上面）。
 * 后置：返回 `{ sections, handoffReport, sessionFor, existingSessions, facts, mint, deliver }` —— 换届域
 *   只经这几个成员干活，且**全部可能失败的分支都返回具名 `{ error }`**（不抛、不静默降级）。
 */
export function batchRotationExtras({ ctx, policy, teamSession }) {
	const rootCtx = teamSession === undefined || teamSession === null ? undefined : teamSession.rootCtx;
	/** 一个角色的 goal 读数（§11.9.6 的诚实规则：读不到就写清为什么读不到）。 */
	const goalOf = (incumbent) => {
		const agent = typeof ctx.agents?.get === "function" ? ctx.agents.get(incumbent) : undefined;
		const signal = readGoalSignal(ctx, incumbent, agent);
		if (signal === null) return { readable: false, reason: "goals 服务不可用（宿主没有这个服务），该角色的目标读不到" };
		if (agent === undefined) return { readable: false, reason: `该角色的前任会话 ${incumbent} 没有活动代理——goals 按 agent 取读数，所以取不到` };
		return { readable: true, text: `phase=${signal.phase} · activation=${signal.activation} · rounds=${signal.rounds}` };
	};
	return {
		// 五个硬节的**真源**（入口唯一的 `HANDOFF_HARD_SECTIONS`）与结构校验（本档的实现）——
		// 换届域按注入的名单渲染正文，再用这里的报告复核：名单改了就当场红，不会静默降级。
		sections: HANDOFF_HARD_SECTIONS,
		handoffReport: handoffBodyReport,
		// 与 §10.2.2 / §11.2 / §11.9.4 同一条铸造规则（`team-link-<team>-<role>-<uuid8>`）。
		sessionFor: (teamName, roleName) => teamSessionId(teamName, roleName, () => randomUUID()),
		/** 在场读面（Sr15）：活代理注册表 ∪ 盘上会话列表。读不出来 ⇒ `{ error }`（换届域据此 fail-closed）。 */
		async existingSessions() {
			const ids = new Set();
			try {
				for (const agent of typeof ctx.agents?.list === "function" ? ctx.agents.list() : []) {
					if (typeof agent?.id === "string" && agent.id !== "") ids.add(agent.id);
				}
			} catch {
				// 注册表读不出来不致命：下面还有「盘上会话」那一次机会；两处都空 ⇒ 调用方按 fail-closed 处理。
			}
			if (typeof ctx.sessionQuery?.listSessions !== "function") return { ids };
			try {
				const records = await ctx.sessionQuery.listSessions(undefined);
				for (const record of Array.isArray(records) ? records : []) {
					if (typeof record?.header?.id === "string" && record.header.id !== "") ids.add(record.header.id);
				}
			} catch (error) {
				return { error: `会话列表读不出来（${describeError(error)}）` };
			}
			return { ids };
		},
		/** 零副作用的事实读数（预检期用）：交接文档落点 / 新会话 cwd / agents.create 可用性 / goal / 信任计数。 */
		facts({ team, incumbent }) {
			if (team.workspace === "") return { error: `团队 ${team.name} 没有 workspace 记录，无法定位 <workspace>/team/<name>/handoff-*.md` };
			// ★ 分歧修复轮 🔵#9②：空 workspace 已在上一行返回 ⇒ 旧写法的 `: cwd` 回退**不可达**（死分支）。
			//   团队 workspace 是唯一落点；不是绝对路径就 fail-closed，绝不拿发起会话的 cwd 顶替。
			const base = team.workspace;
			if (typeof base !== "string" || base === "" || !path.isAbsolute(base)) return { error: `无法确定新会话的工作目录（团队 workspace = ${typeof base === "string" && base !== "" ? base : "（未记录）"}）—— 会话边界只接受绝对路径（§10.2.6）` };
			if (typeof rootCtx?.agents?.create !== "function") return { error: "本宿主没有可用的 agents.create（编程创建会话不可用）—— 整队换届的 auto 路径无法自建继任者" };
			const held = trustReferencesTo(policy.get(), incumbent);
			return { cwd: base, goal: goalOf(incumbent), trust: { pairs: held.pairs.length, trustedSenders: held.trustedSenders.length, rememberTargets: held.rememberTargets.length } };
		},
		/**
		 * 一个角色的**执行期**铸造（D11 的「执行期」从这里开始）：pending-create 意图 → 建会话 → 审批档 →
		 * 交接文档（§11.9.6 的 abort-before-prepare）。失败一律返回 `{ error, sessionId?, created?, intentWritten? }`（`created` 区分「会话已建成之后失败」与「创建调用本身失败」即 attempted；`intentWritten` 说明 pending-create 意图是否已落盘）—— 调用方据此
		 * **逐项点名**已建的会话，且绝不回滚（平台没有「删会话」原语）。
		 */
		async mint({ team, roleName, incumbent, successor, token, now, caller, renderBody }) {
			try {
				await addTeamSessionPending(policy, { team: team.name, role: roleName, sessionId: successor, createdAt: now, expiresAt: now + TEAM_SESSION_PENDING_TTL_MS, by: caller ?? "" });
				teamSession.pending.set(successor, { team: team.name, role: roleName, sessionId: successor });
			} catch (error) {
				return { error: `pending-create 意图写入失败（${describeError(error)}）—— 未创建（宁可不建，也不留一个没有意图记录的孤儿）`, intentWritten: false };
			}
			const inheritance = await collectInheritableSettings(ctx, incumbent);
			const inherited = inheritance.values;
			let creation;
			try {
				creation = await createRootAgent(ctx, rootCtx, { preset: inherited.preset ?? undefined, provider: inherited.provider ?? undefined, model: inherited.model ?? undefined, team: team.name }, { sessionId: successor, role: roleName }, team.workspace);
			} catch (error) {
				return { error: `继任者会话创建失败（${describeError(error)}）；pending-create 意图保留，启动清扫会把它报进可收编清单（§10.2.6）`, sessionId: successor, created: false, intentWritten: true };
			}
			teamSession.handles.set(successor, creation.handle);
			const approval = await applyInheritedApprovalPolicy(inherited, inheritance.writeFace, creation.handle);
			const view = policy.get();
			const teamRow = view.teams.find((entry) => entry.name === team.name) ?? team;
			const held = trustReferencesTo(view, incumbent);
			const plan = planRotationMigration(view, { members: new Set(teamMembers(teamRow)), retiree: incumbent, successor });
			const rendered = renderBody({ cwd: teamRow.workspace, goal: goalOf(incumbent), trust: { pairs: held.pairs.length, trustedSenders: held.trustedSenders.length, rememberTargets: held.rememberTargets.length } });
			if (rendered === null || typeof rendered !== "object" || rendered.error !== undefined) return { error: rendered !== null && typeof rendered === "object" && rendered.error !== undefined ? rendered.error : "交接正文渲染失败", sessionId: successor, created: true, intentWritten: true };
			const report = handoffBodyReport(rendered.body);
			const missing = [...report.missingHard, ...report.emptyHard];
			if (missing.length > 0) return { error: `交接正文缺硬节 ${missing.join("、")}（abort-before-prepare，§11.9.6）`, sessionId: successor, created: true, intentWritten: true };
			const document = await writeHandoffDocument(teamRow, {
				roleName, previous: incumbent, successor, token, preparedAt: now, body: rendered.body, report,
				inheritance: inheritanceRowList(inheritance.rows),
				approvalApplication: approval.line,
				facts: rotationFactRows({ retiree: incumbent, successor, candidates: plan.candidates, dropped: plan.dropped, removedCount: held.pairs.length, trustedSenderCount: held.trustedSenders.length, rememberTargetCount: held.rememberTargets.length }),
			});
			if (document.ok !== true) return { error: `交接文档写入失败（${document.error}）—— abort-before-prepare（§11.9.6）`, sessionId: successor, created: true, intentWritten: true };
			return { sessionId: successor, documentPath: document.path, body: rendered.body, approvalLine: approval.line, inheritance: inheritanceRowList(inheritance.rows), title: creation.title };
		},
		/** §11.4.5 的投递：`followup`，不是 `inject`（任务需要驱动）；投递失败只如实报，令牌仍然有效。 */
		async deliver({ team, roleName, incumbent, successor, token, documentPath, body, caller }) {
			const handle = teamSession.handles.get(successor);
			if (handle === undefined || handle === null || handle.agent === undefined) return { delivered: false, error: `本激活没有该会话的 AgentHandle（${successor}）` };
			try {
				handle.agent.followup(relayUserMessage(handoffDeliveryMessage({ teamName: team.name, roleName, previous: incumbent, token, documentPath, body: typeof body === "string" ? body : "" }, { ttlMinutes: ROTATION_BATCH_TTL_MS / 60000, bodySource: "插件从 roster 事实生成的交接正文（读不到的项已如实标未知）" }), caller));
			} catch (error) {
				return { delivered: false, error: describeError(error) };
			}
			try {
				await removeTeamSessionPending(policy, successor);
			} catch (error) {
				ctx.logger?.warn?.(`${PLUGIN_LABEL}: pending-create intent ${successor} could not be cleared after prepare-batch (${describeError(error)}) — 启动换届清扫不受影响。`);
			}
			teamSession.pending.delete(successor);
			return { delivered: true };
		},
	};
}

/** Token argument reading (§3.6.2): a one-time opaque string. The masked display
 * form `tok-xxxx…yyyy` is deliberately NOT accepted — it is a rendering, and the
 * whole point of the mask is that the rendering is not the token. */
export function readRotationToken(value) {
	if (typeof value !== "string" || value.trim() === "") {
		return { error: "需要 token（prepare 返回的一次性令牌；掩码形式 tok-xxxx…yyyy 不是令牌）。" };
	}
	const token = value.trim();
	if (/[\u0000-\u001F\u007F\s]/u.test(token)) return { error: "token 不能包含空白或控制字符。" };
	return { value: token };
}

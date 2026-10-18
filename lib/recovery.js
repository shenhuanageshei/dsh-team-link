// ---------------------------------------------------------------------------
// 恢复域（recovery）：`team_link_recover` 的两个封闭动词 —— 批 R（上架合规）第 13 小单从 `lib/index.js` 原样搬出
// ---------------------------------------------------------------------------
// 归属：docs/2026-10-15-store-compliance-design.md §4 D1/D2/D4 · §5 FR-R1 · §6（拆分契约：只做「移动 + 补
//       export」、无副作用搬家、模块图无环）· §8 Rr1/Rr3/Rr4/Rr8。
// ★ 本档是什么：§11.9.4/§11.9.5 恢复域的**一整块**（入口原 8,531–9,186 行，656 行 / 24 条声明）：五个常量
//   （封闭动词集 + 限速窗口 + 三条对话框字面量）· 两条边界与诊断文案 · L1 预检与限速 · 候选集计算（活成员
//   ∪ 常驻的合成继任者）· 审计行与三处留痕（写路径）· 两条确认对话框 · 两个动词执行体（`reviveIncumbent` /
//   `reapIncumbent`）。实测：**51,762 字节**（CRLF 工作树）/ **51,107 字节**（EOL 归一到 LF）—— 本小单
//   60 KB 档位上限之内。机检口径：把本档那段正文按声明行去掉 `export ` 前缀后，与入口原位置的同一段
//   **逐字节相等**（EOL 归一）；该段在入口里**零次**。
//   ★ 它是一个**自成一体的块**：动词集、预检、候选、文案、对话框与两个执行体互相闭合，对外只经下面
//     「装配缝」的 12 条入口侧出口与三条相对导入取物。
// ★ 本档**不是**（留给下一小单）：恢复域余下四块仍在入口 —— `RECOVERY_BY_CTX`（上下文表）与
//   `createRecovery`（1,863 字节）/ `recoveryDiagnosticLines`（零副作用诊断行）/ `registerRecoveryTools`
//   （工具注册体，含全部模型可见描述与参数声明）/ `readRotationToken`；以及与 §4.2 (c) 自建继任者支路同族的
//   `selfBuiltHandoffBody` / `appointSelfBuiltSuccessor`（它们与 `writeHandoffDocument` /
//   `handoffDeliveryMessage` 同属「交接文档 + §11.4 投递」，宜与那一族整体成档）。**为什么这一单不搬**：
//   整域（上述全部）实测 **87,113 字节**，一并搬走会越过本小单 60 KB 的档位上限。
// ★ 依赖方向（Rr4「模块图无环」的实测口径）：本档**不导入入口** `lib/index.js`（那会构成 ESM 环，实跑
//   当场 TDZ）—— 出边只有两类，且**都不回指入口或本档**（本单**不新增环**）：
//   ① 内部相对导入（既有域档）：`./shared.js`（5 个：`describeError` / `preview` / `readStamp` /
//      `rotationRateLimited` / `wellFormed`）· `./ledger.js`（5 个：`blackboardPaths` / `decisionRow` /
//      `lastDecisionSeq` / `readBlackboardFile` / `readBlackboardLine`，全在 `writeRecoveryTrails` 那一处）·
//      `./rotation.js`（6 个：`ROTATION_CONFIRM_TIMEOUT_MS` / `ROTATION_RATE_LIMIT_MS` / `recoveryNote` /
//      `roleOf` / `teamMembers` / `withRecoveryRow`），共 **3 条**；
//   ② **装配缝注入**（先例：`lib/forensics.js` 的 `wireForensics()`、`lib/watchdog.js` 的 `wireWatchdog(extras)`）：
//      入口侧 12 条出口由 `wireRecovery(extras)` 在模块求值时一次性绑定到本档的同名模块级 `let` 上 ——
//      绑定与搬迁前**逐个同一** ⇒ 行为逐字不变。逐条归属见入口的 `recoveryExtras()`（五组：两条状态词 ·
//      两条会话 id 形状常量 · 序列化/输出助手 · 名册镜像与门 · 批 P 继承读数与自建继任者支路）。
// ★ 宿主导入 1 条：`node:fs/promises`（`appendFile` / `mkdir`，只服务 `writeRecoveryTrails`）—— 该说明符
//   **本来就在 8 条白名单里** ⇒ `Rr3` 的**集合**读数一字不变（本档不引入任何新宿主依赖面）。
// ★ 被钉符号核对（本仓 `hostSource` 文本锁钉住的 9 个：`writePolicyFileAtomic` / `renameThroughSeam` /
//   `POLICY_FILE_SCHEMA` / `WATCHDOG_DIGEST_DEBOUNCE_MS` / `TICKABLE_VERDICTS` / `agentStateLabel` /
//   `writerGate` / `relayUserMessage` / `buildTeamSessionCreateOptions`）：**本单一个都没搬**，九个仍逐字节
//   住在入口（定义、文档注释与锚点切片位置一字不动 ⇒ 那几条源码锁读数不变）。本档可执行代码对它们的
//   引用 = **0**；其中 **1 个**（`writerGate`）只出现在一条注释与一句用户可见文案里（§11.9.5⑤ 的口径
//   声明），按「word-boundary 宽口径」照样经缝注入（多给一条不改变行为，先例 `teamLedgerToolsExtras()`）。
// ★ 搬运纪律（D4）：本档新增的只有 ① 本段档头 ② 4 条 import 语句 ③ 装配缝 ④ 18 条声明行上的 `export `
//   前缀；其余（含全部行内注释、嵌套函数与中文文案）**一个字符都没动**。
// ---------------------------------------------------------------------------

import { appendFile, mkdir } from "node:fs/promises";

import { blackboardPaths, decisionRow, lastDecisionSeq, readBlackboardFile, readBlackboardLine } from "./ledger.js";
import { ROTATION_CONFIRM_TIMEOUT_MS, ROTATION_RATE_LIMIT_MS, recoveryNote, roleOf, teamMembers, withRecoveryRow } from "./rotation.js";
import { describeError, preview, readStamp, rotationRateLimited, wellFormed } from "./shared.js";

// ---------------------------------------------------------------------------
// 装配缝 · `wireRecovery(extras)`（先例：`lib/forensics.js` 的 `wireForensics()`）
// ---------------------------------------------------------------------------
// 前置：入口在**模块求值**时调用一次（`lib/index.js` 模块尾部，紧挨 `wireWatchdog(…)`），给出的 12 个键
//       与被注入的绑定**同名同值**。
// 后置：本档的模块级 `let` 全部绑定到入口那一份真实现；此后每次恢复调用 / 对话框 / 留痕读到的都是它。
// 为什么不是 import：见档头「依赖方向」②（入口 → 域档会成环）。
// 为什么是一次性绑定而不是每次调用现取：绑定之后两个动词执行体体内的裸名**逐字节保留**（只在函数体外加了
// 这一个缝），D4 的逐字节等价可以直接机检。
// ---------------------------------------------------------------------------
let VACANT_LABEL, SEATED_DEAD_LABEL, TEAM_SESSION_ID_ILLEGAL, TEAM_SESSION_ID_SUFFIX, safeJson, writerGate, writeRosterMirror, mirrorNote, inheritanceRowList, collectInheritableSettings, buildTeamSessionResumeOptions, appointSelfBuiltSuccessor;

/** 入口侧出口的一次性绑定（见本节档头的前置 / 后置）。 */
export function wireRecovery(extras) {
	({
		VACANT_LABEL,
		SEATED_DEAD_LABEL,
		TEAM_SESSION_ID_ILLEGAL,
		TEAM_SESSION_ID_SUFFIX,
		safeJson,
		writerGate,
		writeRosterMirror,
		mirrorNote,
		inheritanceRowList,
		collectInheritableSettings,
		buildTeamSessionResumeOptions,
		appointSelfBuiltSuccessor,
	} = extras);
}

// ---------------------------------------------------------------------------
// §11.9.4/§11.9.5 recovery — `team_link_recover`, exactly two closed verbs
// ---------------------------------------------------------------------------
//
// THREE POWERS, KEPT APART (design §11.9.5). Authoring a recovery is not the same
// as authorizing one, and neither is the same as performing one:
//
//   initiator  — whoever calls the tool. It only gets to ASK.
//   authority  — the human's click in the dialog, and nothing else. `userQuestions`
//                answers can only come from the UI, so a model cannot answer its
//                own box; an absent confirmation service is FAIL-CLOSED, and there
//                is deliberately NO provisional/unattended variant. The asymmetry
//                with M4's claim is the point: a pair migration can be rolled back
//                by the sweep, an INCUMBENCY cannot — writes an illegitimate
//                holder makes are already facts.
//   execution  — L2 hands the whole job to the published M4 mechanism. `reappoint`
//                is literally a prepare the human authorized in this dialog, so it
//                inherits every boundary prepare has (token binding, 24h rollback,
//                domain-limited migration, symmetric revocation) and can grant
//                nothing prepare could not.
//
// The boundary argument, in one sentence (会诊 #43 K): ANY action gated by a human
// confirmation box has the SETTINGS UI SUPER-WRITER as its permission ceiling —
// that party can already change everything, with no audit at all — so a recovery
// can only ever NARROW the existing human permission into a smaller, more
// auditable form. Back doors can only come from the part that BYPASSES the human,
// which is why every one of the eight constraints below is about not bypassing.

/** The closed verb set (§11.9.5①) — the single auditable landing point that makes
 * «只有两个动词» a checkable property instead of a promise. */
export const RECOVERY_ACTIONS = new Set(["revive", "reappoint"]);
/** §11.9.5⑦'s anti-storm window. Recovery inherits M4's 10-minute rotation window
 * (the role path already knows how to say "the same role, too soon"), which is
 * what keeps a blocked member from machine-gunning the dialog. */
export const RECOVERY_RATE_LIMIT_MS = ROTATION_RATE_LIMIT_MS;
/** The ONE answer that lets a `revive` run; everything else (the cancel option, an
 * unanswered dialog, a timeout, a missing confirmation service) is fail-closed. The
 * candidate dialog of `reappoint` names its own answer set — its options ARE the
 * candidates — so it needs no label constants of its own. */
const RECOVER_CONFIRM_LABEL = "执行恢复";
const RECOVER_CANCEL_LABEL = "取消";
const RECOVER_DIALOG_ID = "recovery-confirm";

/** §11.9.5②/⑧, in the caller's terms, printed wherever recovery refuses: the two
 * ways it must never be "helped" are named here so a reader cannot mistake either
 * for an oversight. */
export function recoveryBoundaryText() {
	return "恢复刻意只做两件事，且刻意不给自己留别的路：① 动词封闭（只有 revive / reappoint，不接受任意 roster 字段写入）；② attended-only（必须有人在对话框里点一下，没有 provisional、没有 TTL、没有无人值守降级，无确认服务即 fail-closed——与 M4 claim 的不对称是刻意的：pair 迁移可被清扫自动回退，而 incumbency 不可）；③ 候选由插件从**活成员 ∪ 常驻的「自建继任者（新建会话）」**计算，模型不能指定继任者 id；④ revive 只绑当前 current（不存在「复活任意历史会话」）；⑤ writerGate 原样不动；⑥ 绝不把 policy.writer 降级为 any 当作「修复」——那是对团队的静默弱化，属于被拒绝的做法。另有三权分开（§11.9.5）：**发起** ∈ {该角色最近一任前任} ∪ {团队现任成员}（发起权不依赖信任、只依赖身份资格），**授权** 唯一来源是对话框里人类那一下点击，**复权** 由执行侧的 fail-closed 保证——域外的会话被拒绝时，设置 UI（R2 级，用户在那里是超级写者）仍是永远可用的出口。";
}

/** §11.9.4's L1/L2 boundary in the caller's terms: which emptiness this call is
 * about, and the one thing that decides it. */
export function vacancyKindText(entry) {
	if (entry === null) return "该角色不在 roster 中";
	if (entry.current === null) return `${VACANT_LABEL}（current=null，刻意空缺：由 retire 或设置 UI 造出来的显式表达）`;
	return `${SEATED_DEAD_LABEL}（current=${entry.current}，有席位但本进程没有它的活动代理）`;
}

/**
 * §11.9.5⑧: the entry sweep. Recovery runs the PUBLISHED expiry sweep before it
 * looks at anything, so a recovery never interleaves with a token that is still
 * in flight (the P3 lesson: an explicit identity change kills a token, and vice
 * versa). Pure in the sense that matters — it decides, it does not act.
 */
export function recoveryPreflight(entry, now, isLive) {
	if (entry === null || entry === undefined) {
		return { error: "该团队没有这个角色（先用 team_link_roster action=set-role 指定现任；恢复不创建角色）。" };
	}
	if (entry.pending !== null && entry.pending !== undefined && entry.pending.expiresAt > 0 && entry.pending.expiresAt > now) {
		return { error: `该角色已有在飞的换届令牌（继任者 ${entry.pending.session}，${readStamp(entry.pending.expiresAt)} 到期）——恢复不插队：让它被认领，或等它过期被清扫（≤30 分钟）后再恢复。恢复入口进入时已先跑过既有过期清扫。` };
	}
	const limited = recoveryRateLimited(entry, now);
	if (limited.limited) return { error: `恢复速率限制（§11.9.5⑦，窗口 ${RECOVERY_RATE_LIMIT_MS / 60000} 分钟）——${limited.reason}。请等窗口结束（防对话框轰炸）。` };
	if (entry.current === null || entry.current === undefined) return { ok: true, kind: VACANT_LABEL, incumbent: null };
	if (isLive(entry.current) === true) {
		return { error: `该角色的现任 ${entry.current} 有活动代理——恢复只用于「现任无人」，正常换届请由现任自己发起 team_link_rotate action=prepare（幂等：条件由宿主观测，不由调用方主张）。` };
	}
	return { ok: true, kind: SEATED_DEAD_LABEL, incumbent: entry.current };
}

/** The recovery side of the SAME window (差异审计 B1). A recovery stamps the
 * `rotationAt` field too — that is what makes it auditable in exactly one place —
 * so `rotationRateLimited` alone answers it, for both its branches. The removed
 * duplicate (a second `rotationAt` comparison with the recovery deadline) could
 * never fire: `RECOVERY_RATE_LIMIT_MS === ROTATION_RATE_LIMIT_MS`, and the shared
 * branch below already compares the same field against the same limit. Restating
 * it was a second implementation of one rule — the class of defect this round
 * exists to remove, not to add. Pure. */
export function recoveryRateLimited(entry, now) {
	return rotationRateLimited(entry, now);
}

/** The §4.2 (c) synthetic candidate's label. It is minted by the PLUGIN (the model
 * never writes it), and it is the identity the dialog answer is matched against —
 * so B6's "候选由插件算，模型不得指定继任者 id" holds for this candidate exactly
 * as it does for a live member: the answer can only name a label the plugin put
 * in the box. The successor id does not exist yet at this point (§10.2.2 mints it
 * AFTER the human picks), so a label is the only honest identity available. */
export const SELF_SUCCESSOR_LABEL = "自建继任者（新建会话）";

/** §11.9.5③ + §4.2 (c): the candidate set is computed by the PLUGIN and is
 * **活成员 ∪ 插件自建继任者（常驻）**:
 *
 * - `teamMembers` filtered by the liveness probe (the same set §3.6.1 principle 2
 *   uses), excluding the role being recovered (that one is the dead incumbent);
 * - PLUS the synthetic `自建继任者（新建会话）` candidate, which is ALWAYS present
 *   and is NOT conditional on the live set being empty. The incident this batch
 *   exists for had a candidate list of length **1** (the only survivor was the
 *   coordinator itself), so a trigger of the form "only when there are no
 *   candidates" would never have fired — and the one option left would still be
 *   "seat a worker role on the coordinator".
 *
 * The model's only input is `team` (+ optional `role`); there is no parameter
 * anywhere in this tool that could name a successor id, and the synthetic entry
 * carries no id at all. Pure.
 */
export function reapCandidateRoles(team, roleName, isLive) {
	const live = team.roles
		.filter((entry) => entry.role !== roleName && entry.current !== null && entry.current !== undefined && isLive(entry.current) === true)
		.map((entry) => ({ role: entry.role, session: entry.current, synthetic: false }));
	return [...live, { role: null, session: null, synthetic: true, label: SELF_SUCCESSOR_LABEL }];
}

/** One candidate's dialog identity: a live member is named by its session id (the
 * historical label, unchanged), the synthetic one by the plugin's own constant. */
export function candidateLabel(candidate) {
	return candidate.synthetic === true ? SELF_SUCCESSOR_LABEL : candidate.session;
}

/** One candidate's option description, the same sentence shape for both kinds: what
 * picking it will do, and — for the synthetic one — the §4.2 (c) cost declaration
 * (an EMPTY-CONTEXT new session: history does not migrate, trust migrates only
 * through the successor's own claim). */
export function candidateOptionText(candidate, roleName) {
	if (candidate.synthetic === true) {
		return `由插件**新建一个根会话**当继任者（${SELF_SUCCESSOR_LABEL}；id 形如 team-link-<team>-<role>-<uuid8>，由插件铸造）——**代价如实声明**：它是**空上下文的新会话**，前任的历史/对话**不迁移**；信任（pairs / trustedSenders / rememberTargets）也不在本次迁移，而是靠它本人凭令牌 claim 时逐项勾选，或无人值守时全部 provisional + 24h 回退。插件会从 roster 事实生成一份五硬节的交接文档（读不到的项如实标未知）交给它。`;
	}
	return `角色 ${candidate.role} 的现任会话 ${candidate.session}（活代理；由宿主从本队活成员算出）——勾选它即以 M4 prepare 语义把它铸为该角色 ${roleName} 的继任者`;
}

/**
 * §11.9.5 的**发起域**，与授权域分开：发起者 ∈ {该角色**最近一任前任**} ∪ {团队
 * **现任成员**}。旧任可以发起——发起权不依赖信任、只依赖身份资格，它上下文最完整
 * （「回聘旧任」是最自然的恢复）——但授权仍必须由人类在对话框里给出。
 *
 * 域外的活会话被拒，**且拒得说清出口**：设置 UI（R2 级）永远是超级写者路径，
 * 所以挡住的只是「会话路径」，不是「人」。代价如实写在 README：非成员的活会话
 * （人类随手开的、不属于本队的会话）不能发起恢复——这是有意的收窄。
 *
 * 判据全部由宿主从 roster 读出，调用方主张不了任何一条：`team.current` /
 * `entry.current` / `entry.history` 都是落盘事实。`entry === null` 判过（不窄化），
 * 好让「这个角色不存在」由两个动词各自的错误文案回答（那里的文案更准）。
 */
function previousHolderOf(entry) {
	if (entry === null || entry === undefined) return null;
	const history = Array.isArray(entry.history) ? entry.history : [];
	for (let index = history.length - 1; index >= 0; index -= 1) {
		const record = history[index];
		const session = typeof record?.session === "string" ? record.session : "";
		if (session !== "" && record.until !== null && session !== entry.current) return session;
	}
	return null;
}

/**
 * The domain in the caller's terms: what the domain IS, who the caller is, where
 * the caller sits, and the always-open exit. Pure — the roster and the caller's
 * session id are both arguments, so the rule is testable without a ctx.
 *
 * @returns `true` when the caller may initiate, or a refusal object naming the
 *   requested role's current holder, its last predecessor, and the settings UI.
 */
export function initiatorAllowsRecovery(team, roleName, caller) {
	if (team === null || team === undefined) return true;
	const entry = roleOf(team, roleName);
	if (entry === null) return true;
	const members = new Set(teamMembers(team));
	const previous = previousHolderOf(entry);
	if (caller !== undefined && caller !== "" && (members.has(caller) || previous === caller)) return true;
	return { error: `恢复被拒绝（发起域，§11.9.5）：本工具的发起者只能是团队 ${team.name} 的**现任成员**，或该角色**最近一任前任**。当前调用会话 ${caller ?? "（无会话身份）"} 两者都不是——${caller === undefined ? "这次调用没有会话身份" : `它不在本队现任成员 [${[...members].join("、") || "（无）"}] 里`}，也不是该角色的前任 ${previous ?? "（无前任记录）"}。**被挡住的只是会话路径，不是人**：设置 UI 直接改 team-link 的 teams 键仍是永远可用的出口（用户在那里是超级写者，R2 级）。或者由现任成员/旧任发起（旧任上下文最完整，「回聘旧任」本就是最自然的恢复）。${RECOVERY_NO_WRITE_SUFFIX}` };
}

/** §11.9.5⑧'s honesty clause (差异审计 B2, same narrowing as §11.9.6's): the entry
 * sweep runs BEFORE every recovery verb, and it can really cancel a token that has
 * expired since some earlier call — writing settings and broadcasting a notice. So
 * no refusal may promise a bare 「零写入」 any more: the true statement is always
 * about **this call's own** side effects. This suffix is the one place that says so,
 * appended to every refusal instead of being restated per branch. */
const RECOVERY_NO_WRITE_SUFFIX = "（本次恢复调用自身零写入：没有建会话、没有铸令牌、没有广播 freeze、没有写 roster/信任。注意入口的既有过期清扫**先于**本次判断运行——若上面报了它清的过期令牌，那是清扫按既有语义做的真写入，不是本次恢复做的，见 §11.9.5⑧。）";

/** One refusal / cancellation line in the §11.9.5 terms above: the branch's own
 * sentence, then the scoped zero-write attestation. */
function recoveryRefusal(text) {
	return `${text}。${RECOVERY_NO_WRITE_SUFFIX}`;
}

/** §11.9.5⑦ trail #3: the team blackboard is append-only, so an event can be
 * recorded while the writer gate is jammed (the board has no write gate at all).
 * The row is built from the SAME shape the recovery tool's audit uses, so the
 * board and the tool's answer can never tell two different stories (「不可两处口径」). */
export function recoveryDecisionRow(row) {
	const iso = new Date(row.at).toISOString();
	const head = `recovery ${row.verb} team=${row.team} role=${row.role}`;
	const from = row.from === null || row.from === undefined ? "（无现任）" : row.from;
	const to = row.to === null || row.to === undefined ? "（无）" : row.to;
	const tail = ` by=${row.by === "" || row.by === undefined ? "unknown" : row.by}`;
	return `${head} from=${from} to=${to} reason=${row.reason}${tail}（${iso}）`;
}

/** §11.9.5⑦ trail #2 + #3: the roster.md mirror and the decisions.md append.
 * Both are best-effort BY DESIGN and reported as such — the settings namespace is
 * the source of truth, and a failed audit line must never make a recovery that
 * already happened look like it did not. The decisions row goes through the same
 * `readBlackboardLine` bound the model-facing writer obeys, capped to the
 * decision field so the ledger's per-line limit cannot be broken by it. */
export async function writeRecoveryTrails(team, row) {
	const mirror = team === null ? { ok: false, error: "团队不在注册表中" } : await writeRosterMirror(team);
	let decisions = "（未写：团队没有 workspace 记录，黑板根目录未知）";
	if (team !== null && team.workspace !== "") {
		const paths = blackboardPaths(team);
		try {
			const existing = await readBlackboardFile(paths.decisions);
			if (existing.error !== undefined) {
				decisions = `（未写：decisions.md 无法读取——${existing.error}）`;
			} else {
				const seq = lastDecisionSeq(existing.text) + 1;
				const line = readBlackboardLine(row.decision, "decisions 正文");
				if (line.error !== undefined) {
					decisions = `（未写：${line.error}）`;
				} else {
					const prefix = existing.text === "" || existing.text.endsWith("\n") ? "" : "\n";
					await mkdir(paths.dir, { recursive: true });
					await appendFile(paths.decisions, `${prefix}${decisionRow(seq, new Date(row.at).toISOString(), row.by === "" ? "unknown" : row.by, line.value)}\n`, "utf8");
					decisions = `已追加 decisions #${seq} → ${paths.decisions}`;
				}
			}
		} catch (error) {
			decisions = `（未写：decisions.md 写入出错——${describeError(error)}）`;
		}
	}
	return { mirror, decisions };
}

/** The §11.9.4 confirmation of ONE recovery step. Fail-closed on every path that
 * is not the explicit 「执行恢复」 answer — that property is what makes "no human,
 * no recovery" structural rather than something each caller remembers. */
export async function askRecoveryConfirm(ctx, agent, request, signal) {
	const userQuestions = ctx.get?.("userQuestions");
	if (userQuestions === undefined || userQuestions === null || typeof userQuestions.ask !== "function") {
		return { confirmed: false, reason: "确认服务（userQuestions）不可用——恢复必须有人在对话框里点一下；无确认即不执行（fail-closed，§11.9.5②）。刻意没有 provisional / 无人值守变体：pair 迁移可被自动回退，身份不可。" };
	}
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, ROTATION_CONFIRM_TIMEOUT_MS);
	timer.unref?.();
	const forward = () => controller.abort();
	signal?.addEventListener?.("abort", forward);
	try {
		const answer = await userQuestions.ask({
			questions: [{
				id: RECOVER_DIALOG_ID,
				header: request.header,
				question: wellFormed(request.question),
				detail: wellFormed(request.detail),
				options: [
					{ label: RECOVER_CONFIRM_LABEL, description: request.confirmDescription },
					{ label: RECOVER_CANCEL_LABEL, description: request.cancelDescription },
				],
			}],
			agent,
			signal: controller.signal,
		});
		const item = Array.isArray(answer?.answers) ? answer.answers.find((entry) => entry?.id === RECOVER_DIALOG_ID) : undefined;
		if (item === undefined || !Array.isArray(item.selected)) return { confirmed: false, reason: "确认框没有返回本次恢复问题的答案" };
		if (!item.selected.includes(RECOVER_CONFIRM_LABEL)) return { confirmed: false, reason: `用户在确认框里选择了「${item.selected.join("、") || "（未选择）"}」` };
		return { confirmed: true };
	} catch (error) {
		return { confirmed: false, reason: timedOut ? "确认框 3 分钟内未获确认（按取消处理）" : `确认框失败（${describeError(error)}）` };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener?.("abort", forward);
	}
}

/**
 * §11.9.5③'s candidate dialog, and the ONLY way a successor can enter this path:
 * the options ARE the plugin-computed live candidates, and the answer is read back
 * BY MATCHING THOSE LABELS. There is no parameter anywhere in this tool that could
 * carry a successor id, so "模型不可指定继任者 id" is a structural property of the
 * answer's provenance rather than a sentence in a description.
 *
 * Fail-closed on every path that is not exactly one selected candidate: no
 * confirmation service, a thrown ask, a timeout, or an empty selection.
 *
 * @returns `{ confirmed, picked }` (with `picked.length === 1`, 差异审计 B3) or
 *   `{ confirmed: false, reason }`.
 */
export async function askRecoveryCandidates(ctx, agent, request, candidates, signal) {
	const userQuestions = ctx.get?.("userQuestions");
	if (userQuestions === undefined || userQuestions === null || typeof userQuestions.ask !== "function") {
		return { confirmed: false, reason: "确认服务（userQuestions）不可用——恢复必须有人在对话框里点一下；无确认即不执行（fail-closed，§11.9.5②）。刻意没有 provisional / 无人值守变体：pair 迁移可被自动回退，身份不可。" };
	}
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, ROTATION_CONFIRM_TIMEOUT_MS);
	timer.unref?.();
	const forward = () => controller.abort();
	signal?.addEventListener?.("abort", forward);
	try {
		const answer = await userQuestions.ask({
			questions: [{
				id: RECOVER_DIALOG_ID,
				header: request.header,
				question: wellFormed(request.question),
				detail: wellFormed(request.detail),
				// 批次 2 §4.2 (c): the option list is one label per plugin-computed candidate,
				// and the synthetic `自建继任者（新建会话）` entry is one of them. Its label is the
				// plugin's constant (§{@link SELF_SUCCESSOR_LABEL}) because no successor id
				// exists yet — the human picks a LABEL, the plugin mints the id afterwards.
				options: candidates.map((candidate) => ({
					label: candidateLabel(candidate),
					description: candidateOptionText(candidate, request.roleName),
				})),
				// ONE successor, ONE choice (差异审计 B3). This used to say
				// `multiSelect: true` while the caller went on to use `picked[0]` — so a
				// human who checked a second candidate had that choice silently
				// discarded (the box promised something the code did not do). The two
				// honest options were "act on every pick" (rejected: one recovery is one
				// prepare for one successor; anything else is a batch feature this design
				// does not have, and it would have to define what two successors MEAN)
				// and "ask for exactly one". This is the latter: a single-select box
				// cannot express a choice the code will not act on. The option list is
				// still exactly one label per plugin-computed candidate, and the answer is
				// still read back BY MATCHING THOSE LABELS (a label outside the list is
				// refused, never guessed at).
			}],
			agent,
			signal: controller.signal,
		});
		const item = Array.isArray(answer?.answers) ? answer.answers.find((entry) => entry?.id === RECOVER_DIALOG_ID) : undefined;
		if (item === undefined || !Array.isArray(item.selected)) return { confirmed: false, reason: "确认框没有返回本次恢复问题的答案" };
		// A single-select answer arrives as a one-element list; matching it against the
		// candidate labels is what makes "模型不可指定继任者 id" structural, and a label
		// that is not in the list (a hand-edited card, a hijacked answer) matches nothing.
		const claimed = new Set();
		const picked = [];
		for (const label of item.selected) {
			const index = candidates.findIndex((candidate, position) => !claimed.has(position) && candidateLabel(candidate) === label);
			if (index === -1) continue;
			claimed.add(index);
			picked.push(candidates[index]);
		}
		if (picked.length === 0) return { confirmed: false, reason: `用户没有勾选任何候选人（收到「${item.selected.join("、") || "（空）"}」）` };
		return { confirmed: true, picked };
	} catch (error) {
		return { confirmed: false, reason: timedOut ? "确认框 3 分钟内未获确认（按取消处理）" : `确认框失败（${describeError(error)}）` };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener?.("abort", forward);
	}
}

/**
 * §11.9.4 L1: revive the SAME session. Identity unchanged, roster untouched,
 * trust completely untouched — reviving is not replacing anybody, so `writerGate`
 * has nothing to loosen and no pairs move.
 *
 * THE APPLICABILITY DOMAIN IS THE WHOLE POINT (会诊 D7, which the parent's own
 * first draft missed entirely): `resume`'s `ownerCtx` is the PLUGIN ROOT context,
 * so the revived agent's runtime ownership transfers to the plugin and unload
 * tears it down. Doing that to a session a HUMAN created would move its lifecycle
 * from the UI to the plugin — strictly WORSE than the status quo, in which a
 * plugin reload does not touch human sessions at all. L1 therefore serves the
 * sessions this plugin built, and hands everybody else a deep link instead.
 *
 * §11.9.5⑥ is stated here because this is where the temptation lives: when the
 * write gate is jammed, `policy.writer = "any"` looks like a fix. It is not — it
 * silently weakens the whole team — and this function has no code path that
 * touches `policy`.
 */
export async function reviveIncumbent(deps, request) {
	const { ctx, policy, controller } = deps;
	const { teamName, roleName, caller, agent, signal, now } = request;
	const isLive = (id) => controller.liveProbe(id);
	const view = policy.get();
	const team = view.teams.find((entry) => entry.name === teamName) ?? null;
	if (team === null) return { error: `恢复失败：团队 ${teamName} 不在注册表中。` };
	// 批次 2 (§4.2 (a)): the ROLE gate that used to stand here is gone. §11.9.1 only
	// ever argued that a dead coordinator must be recoverable — it never argued that
	// a dead worker may not be revived, and the real failure shape (a reload tears
	// down EVERY plugin-built session, not just the coordinator's) is exactly the
	// one that gate refused. `revive` is the identity-preserving verb: it writes no
	// roster field, mints no token, moves no pair and never touches `policy`, so
	// widening its role face does not move it one inch toward being a general
	// roster editor. The OWNERSHIP gate below is untouched (§5 B3).
	const entry = roleOf(team, roleName);
	const preflight = recoveryPreflight(entry, now, isLive);
	if (preflight.error !== undefined) return { error: `恢复失败（revive）：${preflight.error}` };
	if (preflight.kind === VACANT_LABEL) {
		return { error: `恢复失败（revive）：${vacancyKindText(entry)}。revive 复活的是一个**会话 id**，而这里是刻意空缺——没有 id 可复活。要指派一个人请用 team_link_recover action=reappoint（同样需要在场确认），或由用户经设置 UI 直接指定现任。` };
	}
	const incumbent = preflight.incumbent;
	// §11.9.4's applicability domain. `hasHandle` is the plugin's own handle
	// registry — the honest witness for "the plugin created it" INSIDE this
	// activation — and the id grammar `team-link-<team>-<role>-<uuid8>` (§10.2.2,
	// the same one `/team_session` and `successor:"auto"` mint) is what survives a
	// reload, which is precisely when L1 matters most: after a reload the handle
	// map is empty BY CONSTRUCTION, so a handle-only predicate would refuse every
	// session this plugin ever made — including the very ones this path exists for.
	const pluginCreated = controller.hasHandle(incumbent) === true || pluginSessionIdMatches(teamName, roleName, incumbent);
	if (!pluginCreated) {
		return { error: [
			`恢复失败（revive）：现任 ${incumbent} 不是本插件创建的会话（§11.9.4 的适用域），所以这里只给深链指引，不替你复活它。`,
			`理由如实说：resume 的 ownerCtx 是**插件根 ctx**——复活后该代理的运行时所有权会归插件，插件卸载/重载就把它一起拆掉。对**人类自建**会话做 revive 会把它的生命周期从 UI 转给插件，比现状（插件重载不影响人类会话）**更差**。`,
			`正确动作（L1 的人类版本，零信任手术）：在侧边栏重新打开会话 ${incumbent}——同一个会话 id 复活，身份/信任/pairs 全部原样回来，writerGate 按 id 比对直接放行。`,
			`若那个会话不该再回来：team_link_recover action=reappoint（人改任，走完整 M4 交接），或由用户在设置 UI 直接改现任。`,
		].join("\n") };
	}
	if (typeof ctx.agents?.resume !== "function") {
		return { error: `恢复失败（revive）：本宿主没有可用的 ctx.agents.resume（无 factory 或未配置 sessionPersistence）——fail-closed，本次零改动：roster 未动、信任未动、没有任何放弃所有权的代理。改走 team_link_recover action=reappoint（人改任，走完整 M4 交接），或由用户在侧边栏打开会话 ${incumbent}，或经设置 UI 直接改现任。` };
	}
	const dialog = await askRecoveryConfirm(ctx, agent, {
		header: "恢复确认（revive）",
		question: [
			`把团队 ${teamName} 的角色 ${roleName} 的现任会话 ${incumbent} 复活？`,
			"",
			`- 现状：${vacancyKindText(entry)}（读数 ${readStamp(now)}）`,
			`- 发起会话：${caller ?? "（无会话身份）"}`,
			"- 这一步做什么：ctx.agents.resume 载入该会话的持久化日志并在其上恢复一个代理——身份不变（id 还是那个 id）、roster 不动、信任零改动（pairs / trustedSenders / rememberTargets 一个字节都不碰），也不改 policy。",
			`- 同时按宿主自己那条 resume 路径的时序把这具代理**组装齐**：模型选择（agentOptions，也就是 deployment:persona-prefix 里 {{model}} 的值）＋ 这个会话自己存下来的 preset 组装源（工具面与人设）。组装不出来时本次恢复**拒绝执行**，绝不留下一个第一回合就会死在 prompt variable "{{model}}" has no value 的代理（真机缺陷 #5）。`,
			"- 代价（如实声明）：该代理的运行时所有权归**本插件**，插件卸载/重载即拆（§10.2.5 的生命周期事实同样适用）。会话仍在盘上，可再次恢复。",
			`- 选「${RECOVER_CANCEL_LABEL}」= 什么都不做：不 resume、不写任何状态。`,
		].join("\n"),
		detail: recoveryBoundaryText(),
		confirmDescription: `resume 会话 ${incumbent}（resumeSessionId=${incumbent}），只复活、不换人`,
		cancelDescription: "什么都不做（零 resume、零写入、零广播）",
	}, signal);
	if (!dialog.confirmed) return { refused: recoveryRefusal(`未恢复（revive）：${dialog.reason}。本次零 resume`) };
	// TOCTOU, first re-read: the dialog just spanned an unbounded human wait, so the
	// observation that opened it is re-taken before the resume call.
	const reopened = policy.get();
	const teamNow = reopened.teams.find((entry) => entry.name === teamName) ?? null;
	const entryNow = teamNow === null ? null : roleOf(teamNow, roleName);
	if (entryNow === null || entryNow.current !== incumbent) {
		return { refused: recoveryRefusal(`恢复已中止（revive，写前复检）：该角色的现任已不是 ${incumbent}（现在是 ${entryNow === null || entryNow.current === null ? "（空缺）" : entryNow.current}）——别把令牌式的身份主张当成当前事实。零 resume`) };
	}
	if (isLive(incumbent)) return { refused: recoveryRefusal(`恢复已中止（revive，写前复检）：现任 ${incumbent} 已经有活动代理了（多半是有人刚在侧边栏打开了它）。它本来就不需要恢复；若确实要换人，请走 team_link_rotate（需要现任自己发起）或 team_link_recover action=reappoint。零 resume`) };
	let handle;
	// DEFECT-5（真机 2026-09-30）：resume **不是**「只要一个 id」。宿主自己的 resume 给的是
	// 三样（`resumeSessionId` + `agentOptions` + `setup`，`dsh-api-session-controller:406-410`），
	// 少了两样，复活出来的 agent 就没有模型选择、也没有 preset 组装源 ⇒ 第一回合死在
	// `prompt variable "{{model}}" has no value`（四个 worker 的真机形状）。
	let resumeOptions;
	try {
		resumeOptions = await buildTeamSessionResumeOptions(ctx, incumbent);
	} catch (error) {
		return { error: `恢复失败（revive，fail-closed）：无法为 ${incumbent} 组装一个**能跑起来**的恢复选项（${describeError(error)}）——本次零 resume、零改动：roster 未动、信任未动、没有任何放弃所有权的代理。为什么不肯将就：复活出来的代理若没有可运行的模型选择，第一回合就会以 prompt variable "{{model}}" has no value（section "deployment:persona-prefix"）失败（真机 2026-09-30 四个 worker 的原文）。出路——修好宿主的 agentDefaultModel 缺省设置（或由人在侧边栏打开会话 ${incumbent}，走宿主自己的 resume 路径），也可以改走 team_link_recover action=reappoint（人改任，走完整 M4 交接）。` };
	}
	try {
		handle = await ctx.agents.resume({ resumeSessionId: incumbent, agentOptions: resumeOptions.agentOptions, setup: resumeOptions.setup });
	} catch (error) {
		return { error: `恢复失败（revive，fail-closed）：resume 抛出（${describeError(error)}）。本次零改动：roster 未动、信任未动、没有任何放弃所有权的代理。若侧边栏已经打开过该会话，那就不需要恢复；否则改走 team_link_recover action=reappoint，或由用户在侧边栏打开会话 ${incumbent}，或经设置 UI 直接改现任。` };
	}
	if (handle === null || handle === undefined || handle.agent === null || handle.agent === undefined) {
		return { error: `恢复失败（revive，fail-closed）：resume 没有返回可用的 AgentHandle（返回 ${preview(safeJson(handle), 120)}）——按失败处理，roster 未动、信任未动。` };
	}
	// The plugin owns what it revived (§11.9.4), so the handle joins the same
	// registry every plugin-created handle lives in. The handle's disposer is
	// single-shot, so the unload path disposing it again is a no-op.
	controller.handles.set(incumbent, handle);
	// The observation that authorizes the write, re-taken a second time at the
	// moment of writing (the design asks for both: at the dialog and before the
	// pen). This is the reading the version history records.
	const final = policy.get();
	const teamFinal = final.teams.find((entry) => entry.name === teamName) ?? null;
	const entryFinal = teamFinal === null ? null : roleOf(teamFinal, roleName);
	if (entryFinal === null || entryFinal.current !== incumbent) {
		return { refused: `恢复已中止（revive，落笔前复检）：该角色的现任在本次调用中途变成了 ${entryFinal === null || entryFinal.current === null ? "（空缺）" : entryFinal.current}——已 resume 的会话 ${incumbent} 保持存活（不撤销，插件不自动关闭任何会话），但本次不写任何审计与限速记录。` };
	}
	if (teamFinal.workspace !== "") {
		await mkdir(blackboardPaths(teamFinal).dir, { recursive: true });
	}
	const row = { verb: "revive", at: now, by: caller ?? "", from: incumbent, to: incumbent, note: recoveryNote("revive", caller) };
	const written = final.teams.map((record) => (record.name === teamName ? withRecoveryRow(record, roleName, row) : record));
	try {
		await policy.update({ teams: written });
	} catch (error) {
		return { error: `恢复失败（revive）：resume 成功但审计写入失败（${describeError(error)}）——会话 ${incumbent} 已复活且仍然存活（不撤销：插件不自动关闭任何会话），但版本史/限速没落下。roster 的其他字段未动。请重试本次恢复。` };
	}
	// The mirror is rendered from the roster the WRITE left behind (§3.3.1): passing
	// the pre-write `teamFinal` would publish a roster.md that omits the very
	// recovery row this function just recorded — the file and the settings namespace
	// would then tell two different stories about the same call.
	const writtenTeam = written.find((record) => record.name === teamName) ?? teamFinal;
	const trails = await writeRecoveryTrails(writtenTeam, { ...row, team: teamName, role: roleName, reason: `现任无活动代理（${SEATED_DEAD_LABEL}）`, decision: recoveryDecisionRow({ ...row, team: teamName, role: roleName, reason: `现任无活动代理（${SEATED_DEAD_LABEL}）` }) });
	return {
		lines: [
			`已恢复（revive）：团队 ${teamName} 的角色 ${roleName} —— 会话 ${incumbent} 复活成功（读数 ${readStamp(now)}）。`,
			`- 身份不变：resumeSessionId=${incumbent}，roster 的 current 一字未动；信任零改动（没有迁移、没有吊销，pairs / trustedSenders / rememberTargets 未碰）。`,
			`- 生命周期（如实声明，§11.9.4）：该代理的运行时所有权归本插件（resume 的 ownerCtx 是插件根 ctx）——插件卸载/重载会把它的代理一起拆掉，会话仍在盘上，可再次 revive 或由人在侧边栏打开。`,
			`- 审计留痕（§11.9.5⑦，三处）：① 版本史备注 ${row.note}；② ${mirrorNote(trails.mirror)}；③ 黑板 ${trails.decisions}`,
			`- 限速（§11.9.5⑦）：本次恢复已占用该角色的 ${RECOVERY_RATE_LIMIT_MS / 60000} 分钟恢复/换届窗口（防对话框轰炸），窗口内的下一次恢复会被拒绝并说明剩余时间。`,
			`- policy.writer 未动（仍是 ${teamFinal.policy.writer}）——恢复不改权限模型，也绝不把 writer 降级为 any 当作「修复」（§11.9.5⑥）。`,
		],
	};
}

/** True when one session id is the `team-link-<team>-<role>-<uuid8>` id this
 * plugin's own §10.2.2 template mints for that very team and role. This is the
 * DURABLE half of §11.9.4's applicability domain: the handle registry answers it
 * within an activation, and this answers it across a reload — which is exactly
 * when revival is needed, because the reload emptied the registry. */
export function pluginSessionIdMatches(teamName, roleName, sessionId) {
	if (typeof sessionId !== "string" || sessionId === "") return false;
	const stem = `team-link-${teamName}-${roleName}`.replace(TEAM_SESSION_ID_ILLEGAL, "-");
	if (!sessionId.startsWith(`${stem}-`)) return false;
	const suffix = sessionId.slice(stem.length + 1);
	return suffix.length === TEAM_SESSION_ID_SUFFIX && /^[0-9a-f]+$/u.test(suffix);
}

/**
 * §11.9.4 L2: `reappoint` — the human-authorized prepare. This is the whole of
 * the recovery mechanism's second verb: the plugin computes the candidates from
 * the LIVE members (the model supplied only `team`, and optionally `role`), the
 * human picks, and then the published M4 `prepare` runs VERBATIM — token bound to
 * (team, role, successor), `rotationBackup` snapshot, `rotation-freeze` broadcast
 * — followed by the successor's own claim, also verbatim. Nothing here re-spells
 * any of that, which is what makes "claim 逐字不动，不新增令牌类型" checkable: the
 * only new thing in the pipeline is WHO was allowed to mint the coin.
 */
export async function reapIncumbent(deps, request) {
	const { ctx, policy, rotation, controller } = deps;
	const { teamName, roleName, caller, agent, signal, now } = request;
	const isLive = (id) => controller.liveProbe(id);
	const view = policy.get();
	const team = view.teams.find((entry) => entry.name === teamName) ?? null;
	if (team === null) return { error: `恢复失败：团队 ${teamName} 不在注册表中。` };
	const entry = roleOf(team, roleName);
	const preflight = recoveryPreflight(entry, now, isLive);
	if (preflight.error !== undefined) return { error: `恢复失败（reappoint）：${preflight.error}` };
	const incumbent = preflight.incumbent;
	// §4.2 (c) ① (差异审计第 5 条 / N1 — 闸门收窄): the capability gate constrains the
	// SELF-BUILD BRANCH, never the verb's entry. Handing a role to a LIVE member needs
	// no `agents.create` at all, so gating the entry on it refused a path that worked
	// before this batch existed. The gate therefore has exactly two outcomes:
	//   - no `agents.create` ⇒ the box still opens and offers the LIVE members only
	//     (the synthetic candidate is not offered — it could never be honoured);
	//   - no `agents.create` AND zero live candidates ⇒ the fail-closed REPORT with
	//     **zero dialogs**: there is nothing the plugin could do for the human.
	const canSelfBuild = typeof controller.teamSession?.rootCtx?.agents?.create === "function";
	// §4.2 (c): the candidate set is 活成员 ∪ 插件自建继任者（常驻）. The synthetic
	// entry is ALWAYS computed (and offered whenever this host can build one), so the
	// "no live member to hand the role to" refusal is no longer a state the dialog
	// pretends cannot happen — candidates running out was exactly the state that had
	// no exit.
	const candidates = reapCandidateRoles(team, roleName, isLive);
	const liveCandidates = candidates.filter((candidate) => candidate.synthetic !== true);
	const offered = canSelfBuild ? candidates : liveCandidates;
	if (offered.length === 0) {
		return { error: `恢复失败（reappoint，${SELF_SUCCESSOR_LABEL}）：本宿主没有可用的 agents.create（编程创建会话不可用）——插件无法新建继任者，而本队也没有**任何可改任的活成员**（活成员改任那条路本身不需要该服务，这里是两条路同时不存在）。本次零创建、零令牌、零 freeze、零写入（连确认框都不弹）。可走的路径：① 先在壳里新建一个会话，再用 team_link_rotate action=prepare 把它的 id 作为 successor 传入（显式 successor 不需要 agents.create，手工路径始终保留，§3.6.4）；② team_link_recover action=revive（仅插件自建会话）；③ 由用户在设置 UI 直接改现任。${RECOVERY_NO_WRITE_SUFFIX}` };
	}
	const optionText = offered.map((candidate) => candidate.synthetic === true
		? `- ${SELF_SUCCESSOR_LABEL}（常驻候选；当前本队另有 ${liveCandidates.length} 位活成员可选）`
		: `- ${candidate.role} → ${candidate.session}（活代理）`).join("\n");
	// ★ 批 P · FR-P3 ①（reappoint 的对话框构造点）：本次**可能**继承什么，必须在人类勾选之前
	// 就在框里读得到（US-P3）。只在「本宿主建得出自建继任者」时采集 —— 那条路才用得上这份读数
	// （改任给活成员不建会话、也不继承任何设置），所以能力闸门关着时不产生这次只读成本。
	const inheritance = canSelfBuild ? await collectInheritableSettings(ctx, incumbent) : null;
	const dialog = await askRecoveryCandidates(ctx, agent, {
		header: "恢复确认（reappoint）",
		roleName,
		question: [
			`团队 ${teamName} 的角色 ${roleName} 的现任不会/不应再回来吗？勾选一位改任（人改任 = 人类对话授权的 prepare）。`,
			"",
			`- 现状：${vacancyKindText(entry)}（读数 ${readStamp(now)}）`,
			`- 发起会话：${caller ?? "（无会话身份）"}`,
			canSelfBuild
				? "- 候选由插件算出 = **本队活成员 ∪ 插件自建继任者（常驻）**（模型不能指定任何继任者 id；合成候选连 id 都还没有——它由插件在人类勾选之后才铸）："
				// 差异审计第 5 条 (§4.2 (c) ① 收窄): the same sentence with the synthetic
				// candidate REMOVED, because this host cannot honour it — an option that
				// could never be carried out is exactly what a box must not offer. The
				// capability gap is stated here instead, so the human sees WHY the list is
				// shorter (N1: 只降级该面子面，并留痕).
				: `- 候选由插件算出 = **本队活成员**（模型不能指定任何继任者 id）。本宿主没有可用的 agents.create，插件无法新建继任者 ⇒ 「${SELF_SUCCESSOR_LABEL}」这一项**不列出**（活成员改任不需要该服务，所以这条路照常可用）：`,
			optionText,
			// 批 P · FR-P3 ①：逐项实际值 / 未继承原因（与 prepare 回执、交接文档事实段同一份三行）。
			// 口径：这些设置**跟着新会话走**，而只有「自建继任者」那条路会新建会话 ⇒ 改任给活成员
			// 不继承任何设置（那一行如实说清楚，免得人类以为改任也会带上这些）。
			...(inheritance === null ? [] : [
				`- 若选「${SELF_SUCCESSOR_LABEL}」：新会话会继承前任**自己存下的**这些设置（批 P · 逐项：值或未继承原因；改任给活成员**不**适用——那条路不建会话、不继承任何设置）：`,
				...inheritanceRowList(inheritance.rows).map((row) => `  - ${row}`),
			]),
			"- 之后发生什么（逐字走既有 M4，一步不跳）：铸一次性令牌绑定 (team, role, successor)（30 分钟）→ 把待迁移的信任状态快照按本次换届各存一份（rotationBackups 数组；旧槽 rotationBackup 仅迁移源；撤销依据，对死亡现任的对称吊销此时是纯清理）→ 向全队广播 rotation-freeze → 由继任者本人凭令牌 claim（届时还有第二道人类关卡：逐项勾选要迁移的 pairs，或无人值守走 provisional + 24h 回退）。",
			"- 本次只做前面那半段（可见步骤：确认 → 铸令牌 → 快照 → 广播冻结）。信任迁移不在本次发生。",
			// The synthetic candidate's cost declaration is printed only where that
			// candidate is actually on the list (the same one-read rule as the line above).
			...(canSelfBuild ? [`- 若选「${SELF_SUCCESSOR_LABEL}」：代价如实声明——继任者是**空上下文的新会话**（前任的历史/对话**不迁移**），它拿到的上下文只有插件从 roster 事实生成的交接文档；信任靠它本人凭令牌 claim 时逐项勾选迁移，或无人值守时全部 provisional + 24h 回退。`] : []),
			"- 不勾选任何一项 = 什么都不做：零令牌、零 freeze、零写入。",
		].join("\n"),
		detail: recoveryBoundaryText(),
	}, offered, signal);
	if (!dialog.confirmed) return { refused: recoveryRefusal(`未改任（reappoint）：${dialog.reason}。本次零令牌、零 freeze`) };
	const picked = dialog.picked[0];
	// TOCTOU, first re-read (the dialog spanned an unbounded human wait): the dead
	// incumbent may have been reopened while the box was open, and the candidate may
	// have died. Both facts are re-observed from the host, never taken from the
	// caller's assertion (§11.9.5, ③'s sibling constraint).
	const reopened = policy.get();
	const teamNow = reopened.teams.find((record) => record.name === teamName) ?? null;
	const entryNow = teamNow === null ? null : roleOf(teamNow, roleName);
	if (entryNow === null || entryNow.current !== incumbent) {
		return { refused: recoveryRefusal(`恢复已中止（reappoint，写前复检）：该角色的现任已不是 ${incumbent}（现在是 ${entryNow === null || entryNow.current === null ? "（空缺）" : entryNow.current}）——有人在这段时间里改任/退役了它，本次的身份主张已过期。零令牌、零 freeze`) };
	}
	if (isLive(incumbent)) return { refused: recoveryRefusal(`恢复已中止（reappoint，写前复检）：现任 ${incumbent} 已经有活动代理了（多半是有人刚在侧边栏打开了它）——现任已复活，无需恢复，正常换届请走 team_link_rotate action=prepare（由现任自己发起）。零令牌、零 freeze`) };
	if (picked.synthetic !== true && !isLive(picked.session)) return { refused: recoveryRefusal(`恢复已中止（reappoint，写前复检）：候选 ${picked.session}（角色 ${picked.role}）在确认期间已经没有活动代理了——写入它会原地再造一个死结。零令牌、零 freeze`) };
	// §4.2 (c): the synthetic candidate has no session to re-check — it does not exist
	// yet — so its half of the chain starts here, after the SAME two re-reads above
	// (the incumbent is still the same id and still dead). From this point on it is
	// the published mechanism, verbatim: §10.2.2 id → hand-over document → prepare →
	// the same three audit trails → the followup that drives it (§11.4.5). The
	// capability gate is not restated here: this branch is unreachable unless the
	// host has `agents.create`, because the gate above decides which candidates the
	// box offers in the first place.
	if (picked.synthetic === true) {
		return await appointSelfBuiltSuccessor({ ctx, policy, rotation, controller }, { teamName, roleName, caller, agent, signal, now, incumbent, team: teamNow, entry: entryNow, candidates: offered });
	}
	// The published mechanism, verbatim: prepare mints the token, snapshots
	// `rotationBackup`, broadcasts the freeze and writes the roster mirror. The
	// recovery row rides the SAME settings write the prepare makes, so the audit and
	// the pending can never disagree about whether this happened.
	const prepared = await rotation.prepare({ teamName, roleName, successor: picked.session, note: recoveryNote("reappoint", caller), caller, now, signal, recovery: { verb: "reappoint", from: incumbent, by: caller ?? "" } });
	if (prepared.error !== undefined) return { error: prepared.error };
	const after = policy.get();
	const teamAfter = after.teams.find((record) => record.name === teamName) ?? null;
	const row = { verb: "reappoint", at: now, by: caller ?? "", from: incumbent, to: picked.session, note: recoveryNote("reappoint", caller) };
	const trails = teamAfter === null
		? { mirror: { ok: false, error: `团队 ${teamName} 不在注册表中` }, decisions: "（未写：团队不在注册表中）" }
		: await writeRecoveryTrails(teamAfter, { ...row, team: teamName, role: roleName, reason: `现任无活动代理（${SEATED_DEAD_LABEL}）；继任者 = 本队活成员 ${picked.role}`, decision: recoveryDecisionRow({ ...row, team: teamName, role: roleName, reason: `现任无活动代理（${SEATED_DEAD_LABEL}）；继任者 = 本队活成员 ${picked.role}` }) });
	return {
		lines: [
			`恢复：已按 §11.9.4 L2 铸好换届包（reappoint）：团队 ${teamName} 的角色 ${roleName}，${incumbent === null ? "（空缺）" : incumbent} → ${picked.session}（角色 ${picked.role}，由插件算出的候选集中经人类确认选定——本条选中的是**本队活成员**那一类；读数 ${readStamp(now)}）。`,
			`- 候选集（宿主计算，模型不可指定）：${offered.map((candidate) => candidate.synthetic === true ? SELF_SUCCESSOR_LABEL : `${candidate.role}→${candidate.session}`).join("、")}`,
			...(canSelfBuild ? [] : [`- 本宿主没有可用的 agents.create（编程创建会话不可用），所以「${SELF_SUCCESSOR_LABEL}」不在候选里；活成员改任这条路径不需要该服务，照常可用。`]),
			`- 审计留痕（§11.9.5⑦，三处）：① 版本史备注 ${row.note}；② ${mirrorNote(trails.mirror)}；③ 黑板 ${trails.decisions}`,
			...prepared.lines,
			"下一步（§11.4.4 → §11.4.6，claim 逐字不动）：把令牌与交接文档交给继任者会话，由它本人调用 team_link_rotate action=claim；claim 会再走一次人类确认（逐项勾选 pairs），无人值守则 provisional + 24h 回退。两道人类关卡 + 24h 回退网，不合并、不省略（§11.9.5）。",
			`- policy.writer 未动（仍是 ${teamAfter === null ? "（未知）" : teamAfter.policy.writer}）：恢复不改权限模型，也绝不把 writer 降级为 any（§11.9.5⑥）。`,
		],
	};
}

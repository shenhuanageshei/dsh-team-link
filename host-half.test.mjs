// Unit smoke test for the dsh-team-link host half: drives the
// registered agent/pre-step listener through a real cordis waterfall with a
// stubbed sessionReferenceResolver (upstream deep-link behavior, unchanged),
// then exercises the three -pro tools against stubbed services.
// Run after the node_modules junctions are in place (see README).
import { Context } from "@deepseek-ai/cordis";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apply, __testing } from "./lib/index.js";

let failures = 0;
/** Assertions executed in this run, printed at the end so the README figure is
 * checkable against the run instead of remembered (§9.6 ⑧). */
let assertions = 0;
function check(label, cond) {
	assertions += 1;
	console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
	if (!cond) failures += 1;
}

/** Diagnostic rendering for a FAIL message: `JSON.stringify` returns `undefined`
 * for `undefined`, and the harness's own console bridge rejects the resulting
 * non-JSON argument (INVALID_ARGS) — which would turn a FAIL into a crash and
 * hide the assertions after it. This renders every value, `undefined` included. */
function show(value) {
	return JSON.stringify(value) ?? String(value);
}

/**
 * Y7 discipline (③b 差异审计): an index into data the plugin MIGHT not have
 * produced, read as `undefined` instead of throwing. `revivePost.recoveries[0]`
 * aborts the whole run with a TypeError the moment `recoveries` is missing, so
 * everything after it — including `assertion total` — never prints, and the red
 * run lies about its own size. `at()` keeps every one of those reads inside the
 * assertion: the condition simply comes out false and the suite runs to the end.
 */
function at(list, index, fallback = undefined) {
	return Array.isArray(list) && index < list.length ? list[index] : fallback;
}

// ---------------------------------------------------------------------------
// shared stubs
// ---------------------------------------------------------------------------

const CWD = "C:/dev/demo";

// ---------------------------------------------------------------------------
// 临时目录（有界修复轮 A 项）：**每一次进程跑自己的一份独一无二的根**。
// 修复前是四个固定名字（`.test-tmp` / `.test-tmp-escape` / `.test-tmp-lone` /
// `.test-tmp-team`，都在工作树里），并发复跑时互相踩对方的目录。
// 实测（2026-10-09，两个并发作业，修复前）：A 进程 ALL PASS，B 进程在
// `.test-tmp/session-target-<ts>.json` 上 ENOENT 崩、退出码 1。
// 落在 os.tmpdir() 之下，顺带让跑测期间的工作树保持干净（不必再靠 .gitignore）。
// ---------------------------------------------------------------------------
const TEST_ROOT = mkdtempSync(path.join(tmpdir(), "dsh-team-link-test-"));
// t-8/task-9 F: 崩溃路径的兜底 —— 套件末尾的 rmSync 只在**跑完**时执行，中途 uncaught 会留一份
// 临时根（本轮调试期实测留了 8 份）。挂一个 exit 钩子：正常退出与 uncaught 崩溃都会走到它。
process.on("exit", () => { try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* 收尾不许再抛 */ } });

/** Per-fixture policy-home counter (see setup): every fixture gets its own DSH_HOME so
 * the file backend can never leak one fixture's roster into the next. */
let policyHomeSeq = 0;

function makeSenderAgent(status, cwd = CWD) {
	const calls = { injected: [], steered: [], followedup: [] };
	const agent = {
		id: "session-self",
		status,
		session: hostShapedSession({ header: { id: "session-self", cwd } }),
		inject(message) { calls.injected.push(message); },
		steer(message) { calls.steered.push(message); },
		followup(message) { calls.followedup.push(message); },
	};
	return { agent, calls };
}

function makeTargetAgent(status = "idle") {
	const calls = { injected: [], steered: [], followedup: [] };
	const agent = {
		id: "session-target",
		status,
		session: hostShapedSession({ header: { id: "session-target", cwd: CWD } }),
		inject(message) { calls.injected.push(message); },
		steer(message) { calls.steered.push(message); }, followup(message) { calls.followedup.push(message); },
	};
	return { agent, calls };
}

/**
 * Settings service stub covering the two namespaces the plugin registers
 * (`team-link` and, for the one-time rename migration, `session-link-pro`).
 * `register` returns the same `get()`/`update(patch)` scope shape the real
 * `settings` service does, so the policy store (and the watchdog list it now
 * carries) is exercised through its real settings path, not the memory fallback.
 * `seed` pre-fills a namespace's data at register time (the state a provider
 * would have loaded from disk), which is how U9 gives the rename migration
 * something to migrate without hand-writing a settings file.
 *
 * `F1` (`settingsRegisterThrows`) models a provider that IS active but refuses
 * `register` — the divergence-audit path where the store can never attach and
 * every lazy retry re-enters the catch. `legacyRegisterThrows` keeps the current
 * namespace working and refuses only `session-link-pro`, the one-line clause of
 * 评审 #4 (an unavailable legacy namespace must say so). `legacyGetThrows` is the
 * other half of that story (评审 round-2 🔵 #3): the legacy namespace registers
 * fine but cannot be READ, which is the branch that used to return with no log
 * at all. `settingsUpdateThrows` (评审 round-3 🟡 #1) models a provider whose
 * register SUCCEEDS but whose scope UPDATE fails — the one arrival that drives
 * `adoptMemoryWindow` into its catch, i.e. the `fold failed` outcome: the window
 * writes are still in the file backend, and the chain tail must not wash them
 * away by writing the service view back over them.
 *
 * `markDead()` (评审 round-2 🟡 #1) models a provider that is gone: the scopes it
 * handed out stop serving. No test flips it by hand — the provider is mounted
 * through a real cordis plugin fiber (see `provideSettingsFiber`) and the fiber's
 * own teardown effect is what retires the stub.
 */
function makeSettings(seed = {}, { settingsRegisterThrows = false, legacyRegisterThrows = false, legacyGetThrows = false, settingsUpdateThrows = false, settingsUpdateDelayMs = 0 } = {}) {
	const namespaces = new Map();
	let alive = true;
	let refusing = Boolean(settingsRegisterThrows);
	const guard = () => { if (!alive) throw new Error("settings provider disposed (its fiber was torn down)"); };
	return {
		namespaces,
		markDead() { alive = false; },
		/**
		 * Code-review round 🔵#4 handle: a provider that refused `register` at activation and
		 * starts answering later — the 「服务在场但拒注册、后来才挂上」 window. Flipping this is
		 * what lets the next lazy `get()`/`update()` retry attach for real; without it the store
		 * would refuse forever and the fold branch would never run.
		 */
		stopRefusing() { refusing = false; },
		service: {
			register(namespace, _schema, options = {}) {
				if (refusing) throw new Error("register refused by stub");
				if (legacyRegisterThrows && String(namespace) === "session-link-pro") throw new Error("legacy namespace refused by stub");
				guard();
				const isLegacy = String(namespace) === "session-link-pro";
				// ★ 批 5（U20 的「缺失才写」判据）：每次 update 落一条**补丁记录** —— 「第二次 attach 一个字
				// 都没写」这件事只能靠写次数读出来（内容相同的重写会换掉 data.watchdogs 的数组对象）。
				const state = { base: structuredClone(options.base ?? {}), data: structuredClone(seed[String(namespace)] ?? {}), updates: [] };
				namespaces.set(String(namespace), state);
				return {
					get() {
						guard();
						if (isLegacy && legacyGetThrows) throw new Error("legacy namespace unreadable by stub");
						return { ...structuredClone(state.base), ...structuredClone(state.data) };
					},
					async update(patch) {
					guard();
					// 评审 round-3 🟡 #1: register 成功但 update 抛错 —— 折叠必失败的唯一到达路径。
					// 状态**先不动**（不 Object.assign）：折叠失败后窗口数据必须仍在文件那一侧。
					if (settingsUpdateThrows) throw new Error("settings update refused by stub");
					// 批 1（FR-7）: 真宿主的 `scope.update` 是**异步**的（真实 I/O），而这份桩默认同步落盘
					// —— 于是「快路径折叠在 `apply` 返回之后才落定」那个窗口在套件里根本不出现。
					// `settingsUpdateDelayMs` 把那半拍补回来（默认 0 = 桩的历史行为，其余夹具一字不动）。
					if (settingsUpdateDelayMs > 0) await new Promise((resolve) => { setTimeout(resolve, settingsUpdateDelayMs); });
					state.updates.push(structuredClone(patch));
					Object.assign(state.data, structuredClone(patch));
					},
				};
			},
		},
	};
}


/**
 * 批 2（FR-1/FR-2）: agent 作用域 \`systemPrompt\` 服务桩。
 * 真宿主里每个 agent 的 \`agent.ctx.systemPrompt\` 就是这个面（本机三个用户插件都在用同一条路，
 * 设计档 §4 层 3-f 有先例）。桩记录每一次 \`section()\` 的**逐字参数**与每个 disposer 的调用次数
 * —— U2（注册参数）/U3（换届换段）/U4（代理消失不泄漏）都读这两个读数，而不是抄一份进测试。
 *
 * 三个降级旋钮各对应 U1 的一条到达路径：\`omitSection\`（面在、没有 section）/ \`omitOrder\`
 * （没有 getSectionOrder）/ \`sectionThrows\`（注册抛错）。
 */
function makeSystemPrompt({ orders = { TEAM_POLICY: 900 }, omitSection = false, omitOrder = false, sectionThrows = false } = {}) {
	const sections = [];
	const service = {
		...(omitSection ? {} : {
			section(options) {
				if (sectionThrows) throw new Error("stub systemPrompt.section refused");
				const record = { name: options?.name, order: options?.order, text: options?.text, disposed: 0 };
				sections.push(record);
				return () => { record.disposed += 1; };
			},
		}),
		...(omitOrder ? {} : {
			getSectionOrder(name) { return orders[String(name)]; },
		}),
	};
	return {
		service,
		sections,
		/** 某个名字的活段（未被 dispose 的那些）。 */
		live: (name = undefined) => sections.filter((record) => record.disposed === 0 && (name === undefined || record.name === name)),
		/** 直接在那个段的函数型 text 上渲染一次（不经过宿主装配）。 */
		render: (record, assembly) => record.text(assembly),
	};
}

/**
 * 批 2（FR-2）: \`sessionProjections\` 服务桩。读数形状按 **2026-10-09 实读宿主 asar 核对过**的
 * 三个 key（\`contextPressure\` v5 / \`tokenUsage\` v2 / \`sessionStats\` v1，见 lib/index.js 里那一段
 * 注释）；\`readings\` 缺席的 key 就是「投影未注册」那一档。\`calls\` 记录每一次 stateOf 的
 * （sessionId, key），用来证明资源行**只读**、且读的是哪几个 key。
 */
function makeSessionProjections({ readings = {}, omit = false, throws = false } = {}) {
	const calls = [];
	const service = omit ? {} : {
		stateOf(session, key) {
			calls.push({ sessionId: session?.header?.id, key });
			if (throws) throw new Error("stub sessionProjections.stateOf exploded");
			// ★ 镜像宿主（AGENTS.md §四点名的坑：桩只镜像自家调用面 ⇒ 把宿主断层永久挡在套件外）。
			// 宿主真身：stateOf → materializeCells(session) → session.snapshotEvents(...)。传进来的会话
			// 对象不具该函数 ⇒ 与真机**逐字同一句**抛错（这正是 2026-10-10 真机那次缺陷）。
			if (typeof session?.snapshotEvents !== "function") throw new Error("session.snapshotEvents is not a function");
			return readings[key];
		},
	};
	return { service, calls, readings };
}

/**
 * 宿主**真实形状**的会话对象（AGENTS.md §四：桩必须镜像宿主，不能只镜像自家调用面）。
 * 真身 `sessionProjections.stateOf(session, key)` 内部会走 `session.snapshotEvents(...)` —— 不具该方法的
 * 会话对象（例如插件自己捏的 `{ header: { id } }` 替身）在真宿主必抛
 * `session.snapshotEvents is not a function`（2026-10-10 真机实测）。夹具统一走本函数造型。
 */
const hostShapedSession = (session) => ({ snapshotEvents() { return []; }, ...session });

/** Scripted userQuestions service: ask() pops the next scripted answer. */
function makeUserQuestions(script) {
	const requests = [];
	return {
		script,
		service: {
			async ask(request) {
				requests.push(request);
				const next = script.shift();
				if (next === undefined) throw Object.assign(new Error("no scripted answer"), { code: "NO_PROVIDER" });
				// A scripted entry may be a FUNCTION: the case then runs while the dialog
				// is still pending, which is how the R1 retire race is reproduced (plugin
				// state changes between the dialog opening and the write-back). It is
				// handed the REQUEST as well, so a case can wait on the very signal the
				// plugin passed in — which is how the claim dialog's abort/timeout shapes
				// are reproduced (缺口1: the caller's bridge aborts the waiting dialog).
				const choice = typeof next === "function" ? await next(request) : next;
				// An ARRAY entry is the multi-select answer (the M4 rotation dialog lists every
				// candidate pair as an option of ONE question); a scalar is the single-select
				// answer. Every question of a request gets the same scripted selection — which is
				// exactly one question for every caller in this file.
				const selected = Array.isArray(choice) ? [...choice] : [choice];
				return { answers: request.questions.map((question) => ({ id: question.id, selected: [...selected], custom: undefined })) };
			},
		},
		requests,
	};
}

/**
 * Capturing stand-in for cordis' LoggerService. §5.3 红线 is "a service that
 * fails to attach must leave a line", so the assertions need the lines
 * themselves rather than a console. Callable like the real `ctx.logger()`, so an
 * internal cordis `ctx.logger(...)` call cannot trip over the stub.
 */
function makeLogger() {
	const lines = { warn: [], info: [], error: [] };
	const logger = () => logger;
	for (const level of ["warn", "info", "error"]) logger[level] = (message) => { lines[level].push(String(message)); };
	return { lines, service: logger };
}

/**
 * `commands` service stub (§10.2.1). The plugin reaches it through the OPTIONAL
 * `ctx.inject(["commands"], …)` channel, so this records the definitions it was
 * handed instead of executing them: the command face is asserted on the
 * definition (name / descriptor / handler), and the handler is then driven
 * directly with a `CommandInvocation` shape (`{ commandId, agent, rawInput,
 * attachments, signal }`) exactly as the real registry would.
 *
 * `service()` hands back one instance per provider mount, mirroring the real
 * service's lifetime, and refuses `register` when `refuse` is set — the second
 * degradation reason code (a service that IS there but will not take the
 * command).
 */
function makeCommands() {
	const definitions = [];
	const refusals = [];
	const state = {
		definitions,
		refusals,
		refuse: false,
		command: (name) => definitions.find((definition) => definition.name === name),
		service: () => ({
			register(definition) {
				if (state.refuse) {
					refusals.push(definition?.name);
					throw new Error("commands.register refused by stub");
				}
				definitions.push(definition);
				return () => {};
			},
		}),
	};
	return state;
}

/** The host's `defaultId` as this fixture models it: what `resolve(undefined)`
 * answers with. DEFECT-1 is precisely about a creation path that never asked. */
const STUB_DEFAULT_PRESET = "dsh-default";

/**
 * `agentPresets` service stub (§10.2.2's template = `dsh-webhook`'s
 * `createWebhookSession`). The plugin reaches it the way that template does —
 * `resolve` (+ the pin call — `acquireScope` on current hosts, `standingKeyFor`
 * on 0.1.x) BEFORE `agents.create`, then `mount(agentCtx,
 * id)` inside `setup` — and this stub keeps the two properties those calls must
 * satisfy, because a stub that only counted calls could not tell 「建出来了」
 * from 「能用」:
 *
 * - `resolve(id)` treats an ABSENT id as the host's `defaultId`
 *   ({@link STUB_DEFAULT_PRESET}) — the real service's own fallback. The call is
 *   recorded verbatim, so 「缺省也解析」 is asserted at the PROVIDER side rather
 *   than inferred from the plugin's own report;
 * - `mount(agentCtx, id)` refuses a context with no agent identity exactly as the
 *   real service refuses an unscoped one ("refusing to compose an unscoped
 *   context"), and records the `(agentId, id)` PAIR. That pair is the reading the
 *   DEFECT-1 assertions use: the preset an agent was COMPOSED FROM, tied to the
 *   agent it was composed for — the persona-prefix assembly source itself, not
 *   merely "some mount happened somewhere".
 *
 * An unknown id throws (`agent-preset/not-found`), like the real service — the
 * `preset=<bogus>` case is there to prove a named-but-unresolvable preset fails
 * loudly instead of quietly producing an uncomposable session.
 */
function makeAgentPresets({ defaultId = STUB_DEFAULT_PRESET, known = [STUB_DEFAULT_PRESET, "coder", "reviewer"], pinSurface = "current", omitMount = false } = {}) {
	if (!["current", "legacy", "both", "none"].includes(pinSurface)) throw new Error(`makeAgentPresets: unknown pinSurface ${JSON.stringify(pinSurface)}（可用：current / legacy / both / none）`);
	const resolved = [];
	const standings = [];
	const acquired = [];
	const released = [];
	const legacyPinned = [];
	const mounts = [];
	const notFound = (id) => new Error(`agent-presets: preset "${id}" not found (available: ${known.join(", ")})`);
	const service = {
		async resolve(id) {
			resolved.push(id);
			const wanted = id ?? defaultId;
			if (!known.includes(wanted)) throw notFound(wanted);
			return { id: wanted };
		},
		// 宿主换代（DSH 0.2.0-rc.1，真机 2026-09-29）：pin 面由 `pinSurface` 选择 ——
		// "current"（默认，只有 acquireScope，0.2.0-rc.1 真机形状）/ "legacy"（只有
		// standingKeyFor，0.1.x 一代）/ "both"（两代都在场，验「优先现名」）/ "none"
		//（两个都没有，验断层被显式点名而非裸 TypeError）。无论走哪支，`standings`
		// 记同一个读数，DEFECT-1 的既有断言不随宿主换代改口径。
		...(pinSurface === "legacy" || pinSurface === "none" ? {} : {
			// 真宿主的形状（`@deepseek-ai/dsh-agent-preset-registry` 的 `acquireScope`）：
			// `retain(id)` ＋ 一个 `[Symbol.asyncDispose]` 句柄（`users--` ＋ `collect()`），
			// 注册面文档原话是「A revision lease; dispose it after the scoped read
			// completes」。**桩必须连句柄一起建模**：只返回 `{ key }` 的桩会把「拿到的
			// 租约永不释放」这层缺陷永久挡在套件外面 —— 与上一轮「桩里只有自家在调的
			// 方法名」是同一个盲区，只是这次挡住的是泄漏、不是改名。
			async acquireScope(id) {
				acquired.push(id);
				standings.push(id);
				let disposed = false;
				return {
					key: `scope:${id}`,
					[Symbol.asyncDispose]: async () => {
						if (disposed) return;
						disposed = true;
						released.push(id);
					},
				};
			},
		}),
		...(pinSurface === "current" || pinSurface === "none" ? {} : {
			async standingKeyFor(id) {
				legacyPinned.push(id);
				standings.push(id);
				return { agentPreset: id };
			},
		}),
		// `omitMount` 是「服务在场、组成面只有一半」的形状断层 fixture（代码评审同批）：
		// 只判 `resolve` 就裸调 `mount` 会在宿主某代改名时把裸 TypeError 当错误文案。
		...(omitMount ? {} : {
			async mount(agentCtx, id) {
				if (agentCtx === undefined || agentCtx === null || typeof agentCtx.agentId !== "string") {
					throw new Error("agent-presets: refusing to compose an unscoped context; the scope key is what joins an agent to its preset");
				}
				if (!known.includes(id)) throw notFound(id);
				mounts.push({ agentId: agentCtx.agentId, id, ctx: agentCtx });
				return { id };
			},
		}),
	};
	return { service, resolved, standings, acquired, released, legacyPinned, mounts, defaultId, pinSurface };
}

/** DEFECT-1 的端到端读数，按**会话 id** 配对（不按位置）：`meta.agentPreset`
 * （宿主此后要读的那一份）与 `mount` 真正绑定的 preset（agent 的 persona-prefix
 * 组装源）必须同源，且各恰一次。① 缺省、② 显式 preset=、③a `successor:"auto"`
 * 三条路径共用这一个判据 —— 判据只写一处，才不会出现「三处口径」。 */
function presetBindingOf(env) {
	return env.creates.map((options) => {
		const mounted = env.agentPresets.mounts.filter((entry) => entry.agentId === options.sessionId);
		return { id: options.sessionId, meta: options.meta.agentPreset, mounts: mounted.length, mountedId: mounted[0]?.id ?? null };
	});
}
function presetBoundOnce(env) {
	return env.creates.length > 0 && presetBindingOf(env).every((row) => row.mounts === 1 && typeof row.meta === "string" && row.meta === row.mountedId);
}
/** The one NAMED degradation line of the preset face, per created session. */
function presetServiceWarns(env) {
	return env.log.lines.warn.filter((line) => line.includes("agentPresets service unavailable"));
}

/** The host's default model selection as this fixture models it (真机缺陷 #3). */
const STUB_DEFAULT_PROVIDER = "deepseek";
const STUB_DEFAULT_MODEL = "deepseek-chat";

/**
 * `agentDefaultModel` 服务桩 —— 真机缺陷 #3 的判据面（§10.2.2 模板 `resolveRequest`
 * 的**缺省分支**，`dsh-webhook/lib/index.js:30-36`）。官方模板在调用方**没给** model 时
 * 也解析：`currentSelection()` ⇒ `agentOptions = {provider, model}`，并把它装成初始模型
 * 选择（模板第 9 步 `installInitialModelSelection`）。
 *
 * 为什么这不是「装了没有」的同义反复：`{{model}}`（`deployment:persona-prefix` 引用的
 * 那个变量）的取值就是 `agent.options.model` —— `dsh-agent-loop` 用
 * `ctx.systemPrompt.variable("model", (context) => context.agent?.options.model)` 注册它
 * （`dsh-agent-loop/lib/index.js:1534`）。所以「`currentSelection()` 的返回值」「写进
 * `agentOptions` 的那一对」「装在 setup 上的模型选择」**必须是同一对**；缺任何一处，
 * 新建的会话照样死在 `prompt variable "{{model}}" has no value`。
 *
 * `calls` 记录的是**服务侧**读数（插件到底问过没有），`provider`/`model` 可被 fixture
 * 覆盖成空串，从而造出「服务在、但读不出可用的 provider/model」那一档。
 */
function makeAgentDefaultModel({ provider = STUB_DEFAULT_PROVIDER, model = STUB_DEFAULT_MODEL, reasoningEffort = undefined } = {}) {
	const calls = [];
	const service = {
		currentSelection() {
			calls.push({ provider, model });
			return { provider, model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) };
		},
	};
	return { service, calls };
}

/**
 * `workspaceRegistry` service stub —— 真机缺陷 #2 的判据面。插件照
 * `dsh-webhook` 的 `createWebhookSession` 那样用它：`create(cwd)` 在
 * `agents.create` **之前**，`attachSession(sessionId)` 在它 resolve **之后**。这个
 * 桩保住那两次调用必须满足的那一条性质：**会话属于某个工作区，只是因为那份工作区
 * 自己的成员名单里有它**。「盘上有会话、cwd 也对」不是「侧边栏里看得到」——差别就
 * 是这条成员关系，也正是 DEFECT-2 的现象。
 *
 * `sessionIds` 即侧边栏分组所读的成员名单。两个失败 fixture：
 * - `refuseAttach`：registry 直接拒绝挂载（回滚用例）；
 * - `registerThenRefuse`：真实的半成品——实体的 `attachSession` 先
 *   `host.rememberSessionPath()` 再写记录，写记录抛错时会话已在路径索引里而
 *   `sessionIds` 未必有它。回滚**不能**靠 `attached` 标志（它此时仍是 false），
 *   这条 fixture 就是为那个半状态准备的。
 */
function makeWorkspaceRegistry({ refuseAttach = false, registerThenRefuse = false, normalize = (workspacePath) => workspacePath, archived = [], archiveUnreadable = "none" } = {}) {
	const creates = [];
	const attached = [];
	const detached = [];
	const workspaces = [];
	const service = {
		/**
		 * 真机缺陷外的第二处宿主读数（§10.2.8.9 ② ①）——`dsh-workspace` 的**公开 getter**
		 * （`dsh-workspace/lib/index.js:436-438`，归档名单跨工作区、本插件已在用同一个服务做
		 * `create(cwd)`）。三种夹具形状，正是 fail-safe 要与不要区分的三档：
		 *   - `archived: [...]` ⇒ 正常读数（名单在场）；
		 *   - `archiveUnreadable: "not-array"` ⇒ **服务在、形状不对**（fail-safe 乙 ⇒ 拒绝）；
		 *   - `archiveUnreadable: "throws"` ⇒ **服务在、getter 抛错**（同上，另一条分支）；
		 * 「服务整个缺席」由 `omitWorkspaceRegistry` 承担（fail-safe 甲 ⇒ 跳过归档信号）。
		 */
		get archivedSessionIds() {
			if (archiveUnreadable === "throws") throw new Error("stub workspace: archivedSessionIds exploded");
			if (archiveUnreadable === "not-array") return undefined;
			return [...archived];
		},
		async create(workspacePath) {
			creates.push(workspacePath);
			const record = { path: normalize(workspacePath), sessionIds: [] };
			const workspace = {
				/** 归一化后的路径——模板 `:103` 把它写进 `meta.cwd`，`attachSession`
				 * 也拿同一个值比对，所以「meta.cwd 来自 registry 而不是调用方原样
				 * 透传」是**可观测**的，不是源码里的一句话。 */
				path: record.path,
				get sessionIds() { return [...record.sessionIds]; },
				async attachSession(sessionId) {
					attached.push({ path: record.path, sessionId });
					if (registerThenRefuse) {
						record.sessionIds = [sessionId, ...record.sessionIds];
						throw new Error(`stub workspace: record write failed after registering ${sessionId}`);
					}
					if (refuseAttach) throw new Error(`stub workspace refused attach for ${sessionId}`);
					if (!record.sessionIds.includes(sessionId)) record.sessionIds = [sessionId, ...record.sessionIds];
				},
				async detachSession(sessionId) {
					detached.push({ path: record.path, sessionId });
					record.sessionIds = record.sessionIds.filter((id) => id !== sessionId);
				},
				has: (sessionId) => record.sessionIds.includes(sessionId),
			};
			workspaces.push(workspace);
			return workspace;
		},
	};
	return { service, creates, attached, detached, workspaces };
}

/** DEFECT-2 的端到端读数，按**会话 id** 配对（不按位置）：每个新建会话的 workspace
 * 各建恰一次、`attachSession` 恰一次且 id 就是**这个会话自己的** id、且写进
 * `meta.cwd` 的正是那份 workspace 的路径。①②③a 三条路径共用这一个判据 —— 判据
 * 只写一处，才不会出现「三处口径」。 */
function workspaceBindingOf(env) {
	return env.creates.map((options) => {
		const rows = env.workspaceRegistry.attached.filter((entry) => entry.sessionId === options.sessionId);
		return { id: options.sessionId, attached: rows.length, path: rows[0]?.path ?? null, metaCwd: options.meta.cwd, member: env.workspaceRegistry.workspaces.some((workspace) => workspace.has(options.sessionId)) };
	});
}
function workspaceBoundOnce(env) {
	return env.creates.length > 0 && workspaceBindingOf(env).every((row) => row.attached === 1 && row.path === row.metaCwd && row.member === true);
}
/** The one NAMED degradation line of the workspace face, per created session. */
function workspaceServiceWarns(env) {
	return env.log.lines.warn.filter((line) => line.includes("workspaceRegistry service unavailable"));
}

/**
 * `sessionTitle` service stub —— 真机缺陷 #4 的判据面（`dsh-webhook` 的
 * `createWebhookSession` 第 8 步：`ctx.sessionTitle.rename(handle.agent.session,
 * resolved.title)`，`lib/index.js:119`）。
 *
 * 真机现象：编程创建的会话**全部叫工作区名**（`dsh-session-link-pro`）⇒ 侧边栏里
 * **互相无法区分**。根因是插件**从不设标题**（理由曾是「命名是用户可见的交互决定，
 * 设计没给就不自造」）——但**默认值（工作区名）本身就是一个很糟的决定**。
 *
 * 这个桩记的是 `(会话 id, 标题)` 的**配对**，所以判据是「**这个**会话被命名成了
 * **按它自己的 role 派生**的标题」，而不是「`rename` 被调用过几次」——后者对
 * 「两个会话都被命名成同一个常量」照样全绿（空锁）。
 *
 * 形状照真服务：`rename` 拿的是**会话对象**（不是 id）、标题必须是可见字符、会话不在册
 * 就抛。两个失败 fixture 各对应实现的一条降级分支（`omitSessionTitle` = 服务整个缺席、
 * `refuseRename` = 服务在但改名失败），两档都必须**只留一行 warn、不阻断创建**。
 *
 * **桩不模拟上游的字节截断**（那是 `dsh-session-title` 的职责：`maxTitleBytes: 80`，
 * 只留能装下的最长码点前缀）。所以桩记下的是**插件交出去的那一份**；缺口2 的判据据此
 * 自己按上游语义算一遍 `upstreamTitle`——「交出去的这一份已经超预算」本身就是那条判据要
 * 抓的东西，桩若顺手替它截断，反而会把缺陷藏起来。 */
function makeSessionTitle({ refuseRename = false } = {}) {
	const renames = [];
	const service = {
		rename(session, title) {
			const sessionId = session?.header?.id;
			if (typeof sessionId !== "string" || sessionId === "") throw new Error("session-title: refusing to rename a session that is not live in this store");
			if (typeof title !== "string" || title.trim() === "") throw new Error("session-title: title must contain visible characters");
			if (refuseRename) throw new Error(`stub session-title refused rename for ${sessionId}`);
			renames.push({ sessionId, title });
			return { title, source: { kind: "user" } };
		},
	};
	return { service, renames };
}

/** DEFECT-4 的端到端读数，按**会话 id** 配对（不按位置）：每个新建会话各被命名一次、
 * 命名的就是**这个会话自己的** id。①②③a 三条路径共用这一个形状的判据 —— 判据只写
 * 一处，才不会出现「三处口径」。 */
function sessionTitleOf(env) {
	return env.creates.map((options) => {
		const rows = env.sessionTitle.renames.filter((entry) => entry.sessionId === options.sessionId);
		return { id: options.sessionId, renames: rows.length, title: rows[0]?.title ?? null };
	});
}
/** 整个读数：每个新建会话恰被命名一次，且标题非空。 */
function sessionTitledOnce(env) {
	return env.creates.length > 0 && sessionTitleOf(env).every((row) => row.renames === 1 && typeof row.title === "string" && row.title !== "");
}
/** The one NAMED degradation line of the title face, when the SERVICE is absent. */
function sessionTitleServiceWarns(env) {
	return env.log.lines.warn.filter((line) => line.includes("sessionTitle service unavailable"));
}
/** The other NAMED degradation line of the title face, when the rename itself throws. */
function sessionTitleRenameWarns(env) {
	return env.log.lines.warn.filter((line) => line.includes("sessionTitle.rename failed"));
}

/** DEFECT-3 的端到端读数，按**会话 id** 配对（不按位置）：每个新建会话拿到的那一对
 * provider/model 是不是 `currentSelection()` 那一刻的读数，以及创建时装上的模型选择钩子
 * 是不是挂在**这个会话自己**的 setup 上下文上（`agents.create` 的 `setup` 真的被工厂
 * await 过——桩照做了）。①②③a 三条路径共用这一个判据，判据只写一处。 */
function modelSelectionOf(env) {
	return env.creates.map((options) => {
		const created = env.created.find((item) => item.agent.id === options.sessionId);
		return {
			id: options.sessionId,
			provider: options.agentOptions?.provider,
			model: options.agentOptions?.model,
			// 装上了就是 `"function"`，没装就是 `"undefined"` —— 存的是 typeof 的读数本身，
			// 免得调用点再套一层 `typeof`（那是「永远为假」的空锁）。
			hook: typeof created?.agent?.setupCalls?.["agent/request"],
			setupAgentId: created?.agent?.setupCtx?.agentId,
		};
	});
}
/** The whole reading: every creation carries `expected` AND installed the hook. */
function modelSelectionBoundOnce(env, expected = { provider: STUB_DEFAULT_PROVIDER, model: STUB_DEFAULT_MODEL }) {
	return env.creates.length > 0 && modelSelectionOf(env).every((row) => row.provider === expected.provider && row.model === expected.model && row.hook === "function");
}
/** 模型选择钩子的**行为**读数：把创建时装上的那个 `agent/request` 监听器喂一份「继承来的」
 * 配置，看它是否按创建时就定下的那一对收敛。`dsh-webhook` 模板的
 * `installInitialModelSelection` 就是这个语义（首份持久 header 之前，继承来的
 * reasoningEffort 被创建时的选择覆盖；路由不同则原样放行）。钩子不在 ⇒ `installed:false`
 * ——这条读数因此能区分「装了」与「没装」，而不是只看源码里有没有那句话。 */
async function probeModelHook(agent, resolved) {
	const hook = agent?.setupCalls?.["agent/request"];
	if (typeof hook !== "function") return { installed: false };
	const out = await hook({ agent: { session: { requestHeader: () => undefined } } }, async () => resolved);
	return { installed: true, out };
}

/**
 * `agents` service stub with the §10.2.2 create face: every `create` call is
 * recorded (options included, which is how the lineage assertions read `meta`),
 * the returned handle's agent is a full message sink, and `failAt` makes the
 * n-th create reject — the fixture behind the §10.2.6「失败即停」case.
 *
 * `createDelayMs` + `inFlight` are the §10.2.6 并发 fixture (G2): each create
 * costs a little time and the provider records how many are in the air at once,
 * so a batch that fans out would report a peak above the ≤2 bound while the
 * serial loop reports 1.
 */
function makeAgents(extraAgents, hidden, { failAt = -1, onCreated = undefined, actionLog = undefined, createDelayMs = 0, inFlight = undefined, resumeRecords = [], resumeCalls = [], resumeDelayMs = 0, resumedAgents = [], systemPrompt = undefined } = {}) {
	const created = [];
	const creates = [];
	/** In-flight bookkeeping for the §10.2.6 并发 red line (G2): the PROVIDER side
	 * is the honest place to measure "how many `agents.create` are in the air at
	 * once" — a counter inside the plugin would only report what the plugin
	 * believes about itself. `inFlight.max` is the peak, `inFlight.now` the live
	 * depth and `inFlight.calls` the sample log, so a red run can name the peak it
	 * actually saw instead of only failing a bound. */
	const flight = inFlight ?? { max: 0, now: 0, calls: [] };
	async function takeFlight() {
		flight.now += 1;
		flight.max = Math.max(flight.max, flight.now);
		flight.calls.push(flight.now);
		// A little cost per create is what makes the measurement decisive: a batch
		// that is genuinely serial still peaks at 1, while an unbounded fan-out of
		// N creates would overlap and report N. With a synchronous stub alone a
		// hanging bug could hide inside one microtask tick.
		if (createDelayMs > 0) await new Promise((resolve) => { setTimeout(resolve, createDelayMs); });
	}
	return {
		created,
		creates,
		inFlight: flight,
		resumeCalls,
		/** §11.9.4 L1's face: load a persisted session and resume an agent on it —
		 * the same `AgentRegistry.resume(options)` shape upstream documents
		 * (`resumeSessionId`, `agentOptions`, `setup`). It rejects for the two
		 * reasons the real registry does (an id already published, an id that is not
		 * a persisted session) and it publishes into the SAME registry `create` uses,
		 * so a resumed session is immediately addressable — which is what makes the
		 * "复活后 writerGate 按 id 比对直接放行" claim checkable instead of assumed. */
		async resume(options) {
			resumeCalls.push(options);
			actionLog?.push("resume");
			if (resumeDelayMs > 0) await new Promise((resolve) => { setTimeout(resolve, resumeDelayMs); });
			const sessionId = options?.resumeSessionId;
			const record = resumeRecords.find((item) => item.header?.id === sessionId);
			if (typeof sessionId !== "string" || record === undefined) {
				throw new Error(`stub factory: no persisted session ${sessionId}`);
			}
			if (extraAgents.some((agent) => agent.id === sessionId)) {
				throw new Error(`stub factory: agent for session ${sessionId} is already published`);
			}
			const calls = { injected: [], steered: [], followedup: [] };
			const agent = {
				id: sessionId,
				status: "idle",
				resumed: true,
				// 批 2: 复活的会话回到现任 ⇒ 段要能重新挂上（同 create 面）。
				...(systemPrompt === undefined ? {} : { ctx: { systemPrompt } }),
				// 真宿主的 `resume` 用**盘上那份 header** 当 `meta`（`dsh-agent-loop` 的
				// `prepare(id, { meta: structuredClone(handle.header) })`），所以复活出来的
				// `agent.session.header` 就是持久化的那一个 —— `agentPreset`（DEFECT-5 的
				// 组装源）连同 `cwd` 一起从记录里来，而不是桩自己编一个。桩若只给 `{id, cwd}`，
				// 「复活的会话拿回**它自己**那份 preset」这层就被永久挡在套件外面。
				session: { header: { id: sessionId, cwd: CWD, ...(record.header?.agentPreset === undefined ? {} : { agentPreset: record.header.agentPreset }) }, requestHeader: () => undefined },
				inject(message) { calls.injected.push(message); },
				steer(message) { calls.steered.push(message); },
				followup(message) { calls.followedup.push(message); actionLog?.push("followup"); },
			};
			created.push({ agent, calls, options });
			// 发布（进注册表 / 解除 hidden / 记进 `resumedAgents`）在 `setup` **成功之后** ——
			// 真工厂是先 `setup` 再 publish，setup 抛错则回滚（`dsh-agent-loop` 的
			// `initializeAgent` catch ⇒ `prepared.dispose()`）；桩若先发布再 setup，一个失败的
			// setup 会在注册表里留下一枚活代理，「fail-closed 之后没有活代理被留下」这半条
			// 就在夹具上读不到（DEFECT-5 ⑦ 正是靠这条读数）。
			if (typeof options.setup === "function") {
				const setupCalls = { requests: [] };
				// The fixture's stand-in for the agent's SCOPE identity. The real
				// service binds `scopeOf(agentCtx)`, and that binding IS the agent's
				// persona-prefix composition source; without an identity on the
				// context this stub could only answer "did some mount happen", which
				// is the exact confusion DEFECT-1 is about (「建出来了」 ≠ 「能用」).
				// 上下文里的 `agentId` 按**这条路径自己的身份**取：`create` 面给的是
				// `options.sessionId`，而 resume 面**只有** `options.resumeSessionId`
				// （宿主的 `ResumeAgentOptions` 没有 `sessionId` 这个键）。原先两处共用
				// `options.sessionId` ⇒ 复活面上的 `agentId` 恒为 `undefined`、桩的 `mount`
				// 按「无 scope」拒绝 —— 恰好把 DEFECT-5 要钉的那一层挡在套件外（DEFECT-1
				// 那轮「桩只镜像自家实现的调用面」是同一个盲区）。
				const agentCtx = { agentId: options.sessionId ?? options.resumeSessionId, on(event, listener) { setupCalls[event] = listener; return () => {}; } };
				await options.setup(agentCtx, agent);
				agent.setupCalls = setupCalls;
				agent.setupCtx = agentCtx;
			}
			extraAgents.push(agent);
			// A resumed session is LIVE again, so it stops being "hidden": that is
			// exactly the observation §11.9.4 rests on ("复活后 writerGate 按 id 比对
			// 直接放行"), and it has to move together with the publication above or the
			// A4 fixture would keep reporting the session as closed.
			hidden.delete(sessionId);
			resumedAgents.push(agent);
			onCreated?.(agent, options);
			return { agent, async dispose() { const index = extraAgents.indexOf(agent); if (index >= 0) extraAgents.splice(index, 1); } };
		},
		async create(options) {
			creates.push(options);
			actionLog?.push("create");
			await takeFlight();
			try {
			if (failAt >= 0 && creates.length - 1 === failAt) throw new Error(`stub factory refused create #${failAt + 1}`);
			const calls = { injected: [], steered: [], followedup: [] };
			const agent = {
				id: options.sessionId,
				status: "idle",
				// 批 2: 新建出来的会话也是 roster 成员 ⇒ sync 会给它注册段，所以它同样带 systemPrompt 面。
				...(systemPrompt === undefined ? {} : { ctx: { systemPrompt } }),
				session: { header: { id: options.sessionId, cwd: options.meta?.cwd ?? CWD, ...(options.meta?.origin === undefined ? {} : { origin: options.meta.origin }) }, requestHeader: () => undefined },
				inject(message) { calls.injected.push(message); },
				steer(message) { calls.steered.push(message); },
				followup(message) { calls.followedup.push(message); actionLog?.push("followup"); },
			};
			created.push({ agent, calls, options });
			extraAgents.push(agent);
			// The real factory awaits `setup` BEFORE publication, and the §10.2.2
			// template's setup is where the optional preset mount and the creation-time
			// model selection live — so the stub runs it against a minimal scoped
			// context (an `on()` sink) instead of skipping the composition the
			// assertion is about. A setup that throws rolls the create back, exactly
			// as the real factory documents.
			if (typeof options.setup === "function") {
				const setupCalls = { requests: [] };
				// The fixture's stand-in for the agent's SCOPE identity. The real
				// service binds `scopeOf(agentCtx)`, and that binding IS the agent's
				// persona-prefix composition source; without an identity on the
				// context this stub could only answer "did some mount happen", which
				// is the exact confusion DEFECT-1 is about (「建出来了」 ≠ 「能用」).
				const agentCtx = { agentId: options.sessionId ?? options.resumeSessionId, on(event, listener) { setupCalls[event] = listener; return () => {}; } };
				await options.setup(agentCtx, agent);
				agent.setupCalls = setupCalls;
				agent.setupCtx = agentCtx;
			}
			onCreated?.(agent, options);
			return { agent, async dispose() { const index = extraAgents.indexOf(agent); if (index >= 0) extraAgents.splice(index, 1); } };
			} finally {
				flight.now -= 1;
			}
		},
	};
}

/** 子句取值校验：宿主 `copyStrings`（:791）逐句搬来 —— 必须是非空串数组。 */
function copyQueryStrings(name, values) {
	if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) throw new Error(`session ` + name + " filter values must be an array of strings");
	return [...values];
}
/** 子句取值校验：宿主 `copyNullableStrings`（:798）逐句搬来 —— string|null 数组。 */
function copyQueryNullableStrings(name, values) {
	if (!Array.isArray(values) || values.some((value) => value !== null && typeof value !== "string")) throw new Error("session " + name + " filter values must be an array of strings or null");
	return [...values];
}
/**
 * ★ 宿主真签名镜像（lead 裁定 2026-10-10 · AGENTS.md §四「桩不得只镜像自家调用面」）：
 * `dsh-session-query/lib/index.js:674` 的 `materializeSessionResultFilters` 逐句搬到这里 ——
 * 非数组即抛、未知子句 kind 即抛（含 kind 缺失）、取值按各子句自己的校验。桩宽松 = 断层溜到真机：
 * 上一次这类事故是「套件全绿、真机首次调用的方法名已经换代」，本次是「把工作区当 signal 传」。
 */
function materializeQueryFilters(filters) {
	if (!Array.isArray(filters)) throw new Error("session filters must be an array");
	return filters.map((filter) => {
		switch (filter?.kind) {
			case "id": return { kind: "id", values: copyQueryStrings("id", filter.values) };
			case "cwd": return { kind: "cwd", values: copyQueryNullableStrings("cwd", filter.values) };
			case "created-at": return { kind: "created-at", from: filter.from, to: filter.to };
			case "parent": return { kind: "parent", values: copyQueryNullableStrings("parent", filter.values) };
			case "availability": return { kind: "availability", values: copyQueryStrings("availability", filter.values) };
			default: throw new Error("session unknown filter kind " + (typeof filter?.kind === "string" ? '"' + filter.kind + '"' : "(missing)"));
		}
	});
}
/** 谓词：宿主 `sessionPredicate`（:751）的 `id`/`cwd` 两支逐句搬来（cwd 读
 * `record.header.cwd ?? null`），另三支按同一份记录形状实现（availability 读 live/persisted）。 */
function filterQueryRecords(records, clauses) {
	return records.filter((record) => clauses.every((clause) => {
		if (clause.kind === "id") return clause.values.includes(record.header?.id);
		if (clause.kind === "cwd") return clause.values.includes(record.header?.cwd ?? null);
		if (clause.kind === "parent") return clause.values.includes(record.header?.parentSession ?? null);
		if (clause.kind === "created-at") {
			const at = record.header?.createdAt;
			return (clause.from === undefined || at >= clause.from) && (clause.to === undefined || at <= clause.to);
		}
		return clause.values.some((value) => (value === "live" ? record.live === true : record.persisted === true));
	}));
}

/**
 * @param surfaceReadHook - optional probe run at the START of every surface
 * read. The list tool's read window (§3.1: bounded to PREVIEW_SESSIONS, and
 * parallel) is asserted through it: a read sequenced behind the previous one
 * resolves with a different in-flight count than a parallel batch.
 */
function makeQuery(sessions, eventsBySession = {}, surfaceReadHook) {
	const query = {
		/** ids whose surface was read, in call order — the read-window bound. */
		surfaceReads: [],
		/** ids whose full event log was read, in call order (§4.1 U1: a refused
		 * download must leave this list EMPTY). */
		readSessionCalls: [],
		/** Mutable persisted-session rows: `listSessions` reads this list, so a case
		 * can add the row a runtime-created session gets at its first checkpoint. */
		records: sessions,
		/** ★ 宿主真签名镜像（lead 裁定 2026-10-10 · AGENTS.md §四「桩不得只镜像自家调用面」）：
		 * 真身 `dsh-session-query/lib/index.js:95`（及 :1070）的签名是 `listSessions(signal)`，
		 * 函数体第一句就是 `signal?.throwIfAborted()`。桩**逐字同形**：传字符串/错形状在这里自然抛
		 * TypeError，于是「把工作区当 signal 传、被 catch 吃掉后静默退化成降级支」这类断层在套件里
		 * 当场红，而不是溜到真机（上一次这类断层是「1438 条全绿、真机首次调用的方法名已换代」）。 */
		async listSessions(signal) {
			signal?.throwIfAborted();
			return query.records;
		},
		async readTitleSnapshots(ids, _signal) {
			return ids.map((id) => ({ status: "fulfilled", value: { session: { id }, title: id === "session-target" ? "目标会话" : id === "session-runner" ? "跑着呢" : undefined } }));
		},
		/**
		 * §10.2.8.9 ②'s `gone` probe — the SAME predicate the real service implements
		 * (`dsh-session-query/lib/index.js:1094/:1154` → `SessionResultFilter[]`), over the
		 * SAME record list `listSessions` reads. A fixture therefore expresses 「这个
		 * 会话还在盘上」 and 「它已不存在」 with ONE list, and the release door cannot be
		 * green on a stub that answers differently from the listing.
		 *
		 * ★ 宿主真签名镜像（lead 裁定 2026-10-10）：签名 `filterSessions(filters, signal)`、非数组即抛、
		 * 未知子句 kind 即抛、`cwd`/`parent` 取值必须 string|null（见下面的
		 * {@link materializeQueryFilters} / {@link filterQueryRecords}）—— 桩宽松就等于把断层挡在套件外。
		 */
		async filterSessions(filters, signal) {
			signal?.throwIfAborted();
			const clauses = materializeQueryFilters(filters);
			const byId = new Map((query.records ?? []).map((record) => [record.header?.id, record]));
			const ids = typeof query.corpusSessionIds === "function" ? query.corpusSessionIds() : (query.records ?? []).map((record) => record.header?.id);
			const corpus = ids.map((id) => byId.get(id) ?? { header: { id } });
			return filterQueryRecords(corpus, clauses);
		},
		async readSession(id) {
			// 批次 1 (§4.1 / U1): the ids this read was asked for, in call order. The
			// download route's fence is asserted on «readSession was NEVER called» —
			// a refused request must not have touched the session store at all, and
			// that is only readable if the read leaves a trace of its own.
			query.readSessionCalls.push(id);
			const events = eventsBySession[id];
			if (events === undefined) throw new Error(`session not found: ${id}`);
			return { session: { id, createdAt: 1700000000000, cwd: CWD }, events };
		},
		async readSurface(id) {
			query.surfaceReads.push(id);
			if (surfaceReadHook !== undefined) await surfaceReadHook(id);
			const events = eventsBySession[id];
			if (events === undefined) throw new Error(`session not found: ${id}`);
			return { session: { id }, capturedThroughSeq: events.length, events };
		},
	};
	return query;
}

/**
 * 批次 1 (§4.1): the platform's trust fence, as the download route sees it.
 *
 * requestRejection(request) is the WHOLE contract the plugin may depend on
 * (@deepseek-ai/dsh-client-connection/lib/index.js:553 — the Host/Origin fence
 * first, then browser authentication; returning undefined means "serve it").
 * The default stub answers undefined: the trusted, logged-in deployment.
 * `reject` replaces the verdict, which is how the fence fixture below turns the
 * same route into a cross-site / unauthenticated caller.
 *
 * `calls` is the witness that the route really handed the request to the
 * platform fence instead of inventing a rule of its own.
 */
function makeConnection({ reject } = {}) {
	const calls = [];
	return {
		calls,
		service: {
			requestRejection(request) {
				calls.push(request);
				return typeof reject === "function" ? reject(request) : undefined;
			},
		},
	};
}

/**
 * The fence with the platform's own rule (Host/Origin → 403, browser cookie →
 * 401), modeled from that implementation. The route never re-implements it: it
 * only forwards the request and writes back what comes out, so this fixture's
 * rule IS the platform's rule for the cases below.
 */
function makeFencedConnection() {
	return makeConnection({
		reject(request) {
			const headers = request?.headers ?? {};
			const host = typeof headers.host === "string" ? headers.host : "";
			if (host !== "" && host !== "127.0.0.1:3080") return 403;
			const origin = typeof headers.origin === "string" ? headers.origin : "";
			if (origin !== "" && origin !== "http://127.0.0.1:3080") return 403;
			return headers.cookie === "dsh_session=ok" ? undefined : 401;
		},
	});
}

/**
 * One request/response pair for driving a registered route handler by hand —
 * the same seam the existing /team-link/export traversal case uses. A Node
 * IncomingMessage always carries `method` and a response always has writeHead
 * / setHeader / end, so this stub carries them too (the route code under test
 * is exercised through the real handler, never a re-implementation).
 */
function makeRouteCall({ method = "GET", url, headers = {} } = {}) {
	const req = { method, url, headers };
	const res = {
		statusCode: undefined,
		headers: undefined,
		body: "",
		writeHead(code, responseHeaders) { this.statusCode = code; this.headers = responseHeaders; return this; },
		setHeader(name, value) { this.headers = { ...(this.headers ?? {}), [name]: value }; },
		end(text) { if (text !== undefined) this.body += String(text); return this; },
	};
	return { req, res };
}

/** Drive one route handler to completion and report what it answered. */
async function callRoute(route, options) {
	const { req, res } = makeRouteCall(options);
	await route.handler(req, res);
	return res;
}

/** One macrotask of slack: enough for cordis' async fiber work and for the
 * attach-time policy chain (which is fire-and-forget by design) to settle. */
const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

/**
 * Bounded wait for the attach-time chain to log its outcome line (🔵 #3 的三处判据都用它)。
 * 策略持久化自持化 §3.1 档 4 让这条链多做一次**真实 fs I/O**（折叠落定后把合并结果原子写回
 * 文件），所以「猜几个 tick」变成了一场竞态 —— 等的是**那行日志本身**，仍然是有界的。
 */
async function waitForChain(env, count) {
	for (let i = 0; i < 500 && env.log.lines.info.filter((line) => line.includes("post-attach policy chain finished")).length < count; i += 1) await tick();
	return env.log.lines.info.filter((line) => line.includes("post-attach policy chain finished")).length;
}

/**
 * Build a full plugin environment on a fresh cordis Context.
 *
 * `lateSettings` exists for U9 (§9.1.3/§9.1.4): the settings stub is created but
 * NOT provided before `apply`, so the run reproduces the production order
 * (plugin activates first, the settings provider finishes its `[Service.init]`
 * later). `provideSettings()` then does what the provider does once it is
 * active — `ctx.provide`, which is what fires the plugin's
 * `ctx.inject(["settings"], …)` callback. `lateWebServer` is the same fixture
 * for the second site of that race (the export route), and `noInject` drops
 * `ctx.inject` before `apply` to cover the documented "ctx.inject unavailable"
 * branch.
 *
 * §10.2.1's `commands` service rides that same optional channel. It is provided
 * here (synchronously, like the settings stub) by default, so the ordinary cases
 * exercise the fast path — the shape the real host has; `omitCommands` is the
 * degradation fixture (plugin loads, one warn, every other tool face unaffected)
 * and `lateCommands` + `provideCommands()` the late-provider one.
 *
 * §10.2.2's `agentPresets` is provided by default for the same reason (the real
 * host has it and `dsh-webhook` calls it unconditionally). `omitAgentPresets` is
 * the DEFECT-1 degradation fixture: it is the ONE branch that may skip the preset
 * face, and it has to leave one warn per created session when it does.
 */
function setup({
	sessions = [],
	eventsBySession = {},
	askScript = [],
	targetStatus = "idle",
	contextText = "SNIPPET",
	omitContext = false,
	goals,
	extraAgents = [],
	selfStatus,
	useSettings = false,
	lateSettings = false,
	lateWebServer = false,
	noInject = false,
	settingsSeed,
	settingsRegisterThrows = false,
	legacyRegisterThrows = false,
	legacyGetThrows = false,
	settingsUpdateThrows = false,
	/** 批 1（FR-7 红相夹具）：把 `scope.update` 的落盘推迟这么多毫秒 —— 真宿主的设置写入是异步的，
	 * 于是「快路径折叠在 `apply` 返回之后才落定」那个窗口才在套件里真的出现。默认 0 = 桩的历史行为。 */
	settingsUpdateDelayMs = 0,
	/** 批 2: agent 作用域的 systemPrompt 面（U1 的降级夹具 = omitSystemPrompt；见 makeSystemPrompt）。 */
	omitSystemPrompt = false,
	systemPromptOptions = undefined,
	/** 批 2: 会话投影读数（FR-2 的资源行）；omitProjections 是「服务缺席」那一档。 */
	projectionsReadings = undefined,
	omitProjections = false,
	projectionsThrows = false,
	selfCwd,
	omitUserQuestions = false,
	surfaceReadHook,
	webServerWithoutRegister = false,
	omitCommands = false,
	lateCommands = false,
	omitAgentPresets = false,
	agentPresetsOptions = undefined,
	omitWorkspaceRegistry = false,
	omitSessionTitle = false,
	sessionTitleOptions = undefined,
	omitAgentDefaultModel = false,
	agentDefaultModelOptions = undefined,
	workspaceRegistryOptions = undefined,
	failCreateAt = -1,
	createdHook = undefined,
	actionLog = [],
	pendingSeed = undefined,
	createDelayMs = 0,
	omitResume = false,
	resumeDelayMs = 0,
	connectionStub = undefined,
	omitConnection = false,
	connectionWithoutRejection = false,
	lateConnection = false,
	omitAgentsCreate = false,
	policyHome = undefined,
	policySeed = undefined
} = {}) {
	const ctx = new Context();
	// Every plugin log line lands in `log.lines` instead of the console: the
	// service-attach red line (§5.3) is asserted on the lines themselves.
	const log = makeLogger();
	ctx.logger = log.service;
	if (noInject) ctx.inject = undefined;
	const prepared = [];
	let failWith = null;
	const resolver = {
		async prepare(agent, content, references, signal) {
			if (failWith !== null) throw failWith;
			prepared.push({ references });
			return {
				content,
				additionalContext: omitContext ? undefined : { id: "injected-1", role: "user", source: { kind: "session-reference" }, content: [{ type: "text", text: contextText }] },
			};
		},
	};
	// 批 2（FR-1/FR-2）: 两个新面 —— agent 作用域的 systemPrompt（段注册）与会话投影（资源行）。
	// 真宿主两个都在场，所以默认提供；两个 omit 旋钮各是 U1 / §9 的一条降级到达路径。
	const systemPrompt = makeSystemPrompt(systemPromptOptions ?? {});
	const attachSystemPrompt = (agent) => {
		if (!omitSystemPrompt) agent.ctx = { ...(agent.ctx ?? {}), systemPrompt: systemPrompt.service };
		return agent;
	};
	const projectionsStub = makeSessionProjections({ readings: projectionsReadings ?? {}, omit: omitProjections, throws: projectionsThrows });
	const registeredTools = [];
	const routes = [];
	const { agent: senderAgent, calls: senderCalls } = makeSenderAgent(selfStatus, selfCwd ?? CWD);
	const { agent: targetAgent, calls: targetCalls } = makeTargetAgent(targetStatus);
	const runnerAgent = { id: "session-runner", status: "running", session: hostShapedSession({ header: { id: "session-runner", cwd: CWD } }) };
	// Extra agents are full message sinks (same shape as the target stub) so a
	// fan-out can be asserted target by target; `extraCalls` records what each
	// one received. `cwd` and `origin` default to the historic stub shape; a
	// fixture can place a peer in another workspace or shape it as a subagent,
	// which is what the no-agent hint list filters on.
	const extraCalls = new Map();
	const extraAgentObjects = extraAgents.map((entry) => {
		const calls = { injected: [], steered: [], followedup: [] };
		extraCalls.set(entry.id, calls);
		return {
			id: entry.id,
			status: entry.status,
			session: { header: { id: entry.id, cwd: entry.cwd ?? CWD, ...(entry.origin === undefined ? {} : { origin: entry.origin }) } },
			inject(message) { calls.injected.push(message); },
			steer(message) { calls.steered.push(message); },
			followup(message) { calls.followedup.push(message); },
		};
	});
	// `hidden` simulates a closed session (A4): the registration stays, but the
	// agent registry no longer resolves that id.
	const hidden = new Set();
	// §10.2 ②: sessions born from `agents.create` join the SAME live roster, so a
	// worker the command just built is immediately addressable, listable and
	// drivable — exactly as the real registry sees it after publication.
	const createdAgents = [];
	const createInFlight = { max: 0, now: 0, calls: [] };
	// §11.9.4 L1's fixture: `resumeRecords` is the persisted-session list the resume
	// face loads from (a `hidden` id is still a persisted session — that is exactly
	// what "盘上有会话但无活代理" means), and `omitResume` models the documented
	// failure mode where no factory is registered.
	const resumeRecords = [];
	const resumeCalls = [];
	const resumedAgents = [];
	// ★ AGENTS.md §四：夹具的会话对象必须**是宿主真实形状**（stateOf 会走 session.snapshotEvents()）。
	// 这是造型动作，不是给插件开后门：插件自己捏的替身对象不经过这里（stub 仍会逐字抛错）。
	const hostShapeAll = (agent) => { if (agent?.session && typeof agent.session.snapshotEvents !== "function") agent.session = hostShapedSession(agent.session); return agent; };
	[senderAgent, targetAgent, runnerAgent, ...extraAgentObjects, ...createdAgents].forEach(hostShapeAll);
	const agentFactory = makeAgents(createdAgents, hidden, { failAt: failCreateAt, onCreated: createdHook, actionLog, createDelayMs, inFlight: createInFlight, resumeRecords, resumeCalls, resumeDelayMs, resumedAgents, systemPrompt: omitSystemPrompt ? undefined : systemPrompt.service });
	const agents = {
		get(id) {
			if (hidden.has(id)) return undefined;
			if (id === senderAgent.id) return senderAgent;
			if (id === targetAgent.id) return targetAgent;
			if (id === runnerAgent.id) return runnerAgent;
			return extraAgentObjects.find((candidate) => candidate.id === id) ?? createdAgents.find((candidate) => candidate.id === id);
		},
		/** Every live agent, in registration order — the registry face the
		 * no-agent refusal's hint list reads. A `hidden` id is a closed session:
		 * the fixture keeps its registration, so list() must not advertise it. */
		list() { return [senderAgent, targetAgent, runnerAgent, ...extraAgentObjects, ...createdAgents].filter((agent) => !hidden.has(agent.id)); },
		/** Live top-level agents. A subagent is created under an owning agent, so it
		 * is never a root — the hint list and the delivery guard share both this
		 * membership and the coarse `origin` class. */
		roots() { return [senderAgent, targetAgent, runnerAgent, ...extraAgentObjects.filter((agent) => agent.session?.header?.origin !== "subagent")].filter((agent) => !hidden.has(agent.id)); },
		/** §10.2.2 create face: records the options (the lineage assertions read
		 * them) and publishes a live root agent under the requested session id.
		 * `omitAgentsCreate` (批次 2 §4.2 (c) / U10) models a host whose registry has
		 * no programming-create face at all: the synthetic successor cannot be built,
		 * and the tool must say so instead of opening a box that cannot be honoured. */
		...(omitAgentsCreate ? {} : { create: agentFactory.create }),
	};
	if (!omitResume) agents.resume = agentFactory.resume;
	// The persisted-session list the resume face loads from: the declared sessions
	// plus every stub agent's own session (a stub agent stands for a session that
	// exists on disk — that is what makes "hidden ⇒ still resumable" the honest
	// fixture for §11.9.4).
	resumeRecords.push(...sessions, ...[senderAgent, targetAgent, runnerAgent, ...extraAgentObjects].map((agent) => ({ header: { id: agent.id, cwd: agent.session?.header?.cwd ?? CWD }, live: !hidden.has(agent.id), persisted: true })));
	const uq = makeUserQuestions([...askScript]);
	const settings = useSettings || lateSettings
		? makeSettings(pendingSeed === undefined ? settingsSeed : { ...(settingsSeed ?? {}), "team-link": { ...((settingsSeed ?? {})["team-link"] ?? {}), pendingCreates: [...((settingsSeed ?? {})["team-link"]?.pendingCreates ?? []), ...(Array.isArray(pendingSeed) ? pendingSeed : [pendingSeed])] } }, { settingsRegisterThrows, legacyRegisterThrows, legacyGetThrows, settingsUpdateThrows, settingsUpdateDelayMs })
		: undefined;
	ctx.provide("sessionReferenceResolver", resolver);
	ctx.provide("tools", { register(tool) { registeredTools.push(tool); return () => {}; } });
	const query = makeQuery(sessions, eventsBySession, surfaceReadHook);
	/** §10.2.8.9 ②'s `gone` probe reads the complete logical corpus. The declared `sessions:`
	 * list is what `listSessions` asserts over, and every fixture agent is a session too —
	 * a LIVE one (its stub) or a PERSISTED one (`hidden` ⇒ 盘上有会话、无活代理，即 `resumeRecords`
	 * 里同一行). Reading the union is what keeps the §10.2.8.9 ② boundary honest: 现任还在盘上、
	 * 只是没有活代理（seated-dead）必须算出 EXISTS，**不许**误判成 gone 而释放团队名。 */
	query.corpusSessionIds = () => [...new Set([...(query.records ?? []).map((record) => record.header?.id), ...resumeRecords.map((record) => record.header?.id)])];
	ctx.provide("sessionQuery", query);
	ctx.provide("agents", agents);
	// 批 2: 段注册要 agent 作用域的 systemPrompt —— 每个 agent 出厂就带着它（真宿主如此）。
	for (const agent of [senderAgent, targetAgent, runnerAgent, ...extraAgentObjects]) attachSystemPrompt(agent);
	if (!omitProjections) ctx.provide("sessionProjections", projectionsStub.service);
	// `omitUserQuestions` models a shell without the confirmation service (the
	// M2 retirement cleanup and the M1 send gates must both degrade, not crash).
	if (!omitUserQuestions) ctx.provide("userQuestions", uq.service);
	// `lateWebServer` models the second site of the same race (§9.1.3): the
	// header export route is taken from the runtime channel too.
	// `webServerWithoutRegister` (评审 round-3 🔵 #4) models the other reason code
	// of that seam: a service that IS there but cannot take a route — the branch
	// whose wording must come from the same single read.
	const webServerService = webServerWithoutRegister ? {} : { register(route) { routes.push(route); return () => {}; } };
	if (!lateWebServer) ctx.provide("webServer", webServerService);
	// 批次 1 (§4.1): the export route's SECOND gate service. It is provided by
	// default (the shape the real host has — the platform's own routes read it),
	// so every pre-existing case above keeps exercising the fenced fast path.
	// `omitConnection` / `lateConnection` are the two degradation fixtures of the
	// mount-time gate, `connectionWithoutRejection` is its second reason code, and
	// `connectionStub` lets a case install the platform's own rule (makeFencedConnection).
	const connection = connectionStub ?? makeConnection();
	const connectionService = connectionWithoutRejection ? {} : connection.service;
	if (!omitConnection && !lateConnection) ctx.provide("connection", connectionService);
	if (settings !== undefined && !lateSettings) ctx.provide("settings", settings.service);
	// The `goals` service is optional by design (§3.1): absent here means the
	// degraded path, present means a goal view (or `undefined` for "no goal").
	if (goals !== undefined) ctx.provide("goals", { get(agent) { return goals[agent.id]; } });
	// §10.2.1: the `commands` service is OPTIONAL — it rides the same ordered
	// injection as `settings`/`webServer`, never the module-level `inject`. It is
	// provided by default so the whole suite exercises the normal host shape, and
	// it is mounted as a REAL plugin fiber (like `provideSettingsFiber`), which
	// both proves the fast path really goes through the service and keeps the
	// provider's lifetime owned by cordis.
	const commands = makeCommands();
	if (!omitCommands && !lateCommands) ctx.provide("commands", commands.service());
	// §10.2.2's template service. Provided by default (the shape the real host has:
	// `dsh-webhook`'s `createWebhookSession` calls it unconditionally), so the
	// ordinary cases exercise the resolve → `meta.agentPreset` → `setup` mount path;
	// `omitAgentPresets` is the degradation fixture (the whole preset face is gone,
	// so one warn per created session must say so and the session must still exist);
	// `agentPresetsOptions` forwards into makeAgentPresets (its `pinSurface` knob
	// models WHICH host generation the preset pin API belongs to — see the stub).
	const agentPresets = makeAgentPresets(agentPresetsOptions ?? {});
	if (!omitAgentPresets) ctx.provide("agentPresets", agentPresets.service);
	// §10.2.2 模板的另一半（真机缺陷 #2）：会话建完要**挂进工作区**，否则侧边栏按
	// 工作区分组时列不出它。与 agentPresets 同款——可选服务、创建时 `ctx.get`、默认
	// 提供（真实宿主有它）；`omitWorkspaceRegistry` 是降级 fixture，`normalize` 是
	// 「meta.cwd 真的来自 registry 的 path」的可观测 fixture。
	const workspaceRegistry = makeWorkspaceRegistry(workspaceRegistryOptions ?? {});
	if (!omitWorkspaceRegistry) ctx.provide("workspaceRegistry", workspaceRegistry.service);
	// §10.2.2 模板的**第四块**（真机缺陷 #4）：会话建完要**命名**，否则它显示成工作区名、
	// 侧边栏里互相认不出来。同一款可选服务：默认提供（真宿主有它，`dsh-webhook` 第 8 步
	// 无条件调它），`omitSessionTitle` / `sessionTitleOptions.refuseRename` 是它的两档降级
	// fixture（服务缺席 / 服务在但改名失败）——两档都只留一行 warn、不阻断创建。
	const sessionTitle = makeSessionTitle(sessionTitleOptions ?? {});
	if (!omitSessionTitle) ctx.provide("sessionTitle", sessionTitle.service);
	// §10.2.2 模板的**第三块**（真机缺陷 #3）：`resolveRequest` 在调用方没给 model 时
	// **也**解析宿主的缺省模型选择，把它写进 `agentOptions` 并装成初始模型选择（模板
	// 第 9 步）。同一款可选服务：默认提供（真宿主有它），`omitAgentDefaultModel` 是
	// 「服务缺席 ⇒ 拒绝创建」的 fixture，`agentDefaultModelOptions` 造「服务在、但读不出
	// 可用的 provider/model」那一档。
	const agentDefaultModel = makeAgentDefaultModel(agentDefaultModelOptions ?? {});
	if (!omitAgentDefaultModel) ctx.provide("agentDefaultModel", agentDefaultModel.service);
	// --- 策略持久化自持化（设计档 §3.2）: 每个夹具一个**私有** DSH_HOME ---------
	// 文件后端在 settings 缺席时接管落点，所以夹具必须各占一个 home —— 共用一个会
	// 让后建的夹具读到前一个夹具的 teams（真机上正是「换个工作区团队就没了」的反面）。
	// 目录落在本进程独有的 `TEST_ROOT/policy/` 下，随本套件末尾的 `rmSync(TEST_ROOT)` 一起清掉；
	// `policyHome: false` 是 U7 的第三支：既无 DSH_HOME 也无 homedir ⇒ 路径解析失败。
	policyHomeSeq += 1;
	const policyDir = policyHome === false ? null : path.join(TEST_ROOT, "policy", String(policyHomeSeq));
	// 守卫判 **`policyDir`** 而不是入参 `policyHome`（代码评审修复轮 🔵#6）：`policyHome: false`
	// 时 `policyDir` 才是 null，而旧守卫 `policyHome !== null` 在这一支是**真**（`false !== null`），
	// 于是「既无路径又给了种子」会一路走到 `path.join(null, …)` 抛 TypeError。现在两种输入在
	// setup 里就明确互斥：没有路径就没有落点可种，种子被跳过。
	if (policyDir !== null && policySeed !== undefined) {
		mkdirSync(path.join(policyDir, "team-link"), { recursive: true });
		// `policySeed` 也可以是**原文**（字符串）：U11 的损坏档夹具要的正是**一份坏 JSON**，而
		// 这一步发生在 `apply(ctx)` 之前 —— 只有这样 `loadPolicyFile` 才读得到它。
		writeFileSync(path.join(policyDir, "team-link", "policy.json"), typeof policySeed === "string" ? policySeed : JSON.stringify(policySeed, null, 2), "utf8");
	}
	__testing.setPolicyHomeInject(policyDir === null ? { env: {}, homedir: () => "" } : { env: { DSH_HOME: policyDir }, homedir: () => policyDir });
	apply(ctx);
	// 夹具之后的**任何** store（例如 `__testing.rotationFor(ctx, extras)` 现场新建的那一个）
	// 都必须解析不出路径 —— 测试进程永远不许碰到真实的 ~/.dsh。
	__testing.setPolicyHomeInject({ env: {}, homedir: () => "" });
	const tool = (name) => registeredTools.find((candidate) => candidate.name === name);
	/** U9 handle: the settings provider going active AFTER the plugin loaded. */
	const provideSettings = async () => {
		ctx.provide("settings", settings.service);
		await new Promise((resolve) => { setTimeout(resolve, 0); });
	};
	/** Same handle for the webServer provider (the export route's race). */
	const provideWebServer = async () => {
		ctx.provide("webServer", webServerService);
		await new Promise((resolve) => { setTimeout(resolve, 0); });
	};
	/** ... and the same handle for the fence provider (批次 1 §4.1: the route waits
	 * for BOTH services, so a case can bring them up one at a time). */
	const provideConnection = async () => {
		ctx.provide("connection", connectionService);
		await new Promise((resolve) => { setTimeout(resolve, 0); });
	};
	/** 评审 round-2 🟡 #1 handle: mount the settings stub as a REAL cordis plugin
	 * fiber, so `fiber.dispose()` retires the service through cordis itself (which
	 * deactivates the plugin's `ctx.inject(["settings"], …)` fiber — the event the
	 * store's lifetime binding must react to). Mounting a fresh stub afterwards
	 * models the provider coming back with a new service instance. No hand-rolled
	 * "disposed" switch is involved: the stub only loses its backing store because
	 * the effect below runs when that fiber is torn down. */
	const provideSettingsFiber = async (stub = settings) => {
		const fiber = ctx.plugin({
			name: "settings-provider-stub",
			apply(providerCtx) {
				providerCtx.provide("settings", stub.service);
				providerCtx.effect(() => () => stub.markDead(), "settings-provider-stub: provider teardown");
			},
		});
		await fiber.await();
		await tick();
		return fiber;
	};
	/** §10.2.1 handle: the commands provider going active AFTER the plugin loaded
	 * (the optional ordered injection's whole retry story). */
	const provideCommands = async () => {
		ctx.provide("commands", commands.service());
		await tick();
	};
	/** One `CommandInvocation` exactly as the registry builds it (§10.2.1). */
	const invoke = (rawInput, agent = senderAgent) => ({ commandId: "cmd-test", agent, rawInput, attachments: [], signal: new AbortController().signal });
	/** G2 handle: the provider-side peak of concurrent `agents.create` calls. */
	const maxCreateInFlight = () => createInFlight.max;
	return { policyHome: policyDir, systemPrompt, projections: projectionsStub, ctx, prepared, setFailWith: (error) => { failWith = error; }, setHiddenAgent: (id, value) => { if (value) hidden.add(id); else hidden.delete(id); }, setScript: (entry) => { uq.script.push(entry); }, registeredTools, routes, senderAgent, senderCalls, targetAgent, targetCalls, uq, tool, settings, log, query, provideSettings, provideSettingsFiber, provideWebServer, provideConnection, connection, provideCommands, agentPresets, workspaceRegistry, sessionTitle, agentDefaultModel, agentFor: (id) => agents.get(id), extraCalls, commands, created: agentFactory.created, creates: agentFactory.creates, actionLog, invoke, maxCreateInFlight, resumeCalls, resumeRecords, resumedAgents, agents };
}

function execFor(agent) {
	return { agent, signal: new AbortController().signal };
}

// ---------------------------------------------------------------------------
// upstream deep-link behavior (cases 1-9, unchanged expectations)
// ---------------------------------------------------------------------------

const sessions = [
	{ header: { id: "session-target", createdAt: 1000, cwd: CWD }, live: true, persisted: true },
	{ header: { id: "session-runner", createdAt: 2000, cwd: CWD }, live: true, persisted: true },
	{ header: { id: "session-cold", createdAt: 3000, cwd: CWD }, live: false, persisted: true },
	{ header: { id: "session-other", createdAt: 4000, cwd: "D:/elsewhere" }, live: false, persisted: true },
];
const previewEvents = [
	{ type: "user/message", seq: 1, time: 1, data: { id: "p1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "帮我优化会话导出功能" }] } },
	{ type: "assistant/message", seq: 2, time: 2, data: { turn: 1, step: 1, message: { id: "p2", role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "text", text: "导出已完成优化。" }] } } },
];
const env = setup({ sessions, eventsBySession: { "session-target": previewEvents } });

// Case 1: web deep link in a direct user prompt → context injected before prompt.
const prompt1 = { id: "m1", role: "user", source: { kind: "user", rpcId: "r1" }, content: [{ type: "text", text: "请参考 http://127.0.0.1:3080/s/session-abc123 继续" }] };
const decision1 = await ctx_waterfall(env.ctx, { messages: [prompt1], turn: 1, step: 1 });
check("decision is enter", decision1.kind === "enter");
check("context injected before prompt", decision1.messages.length === 2 && decision1.messages[0].id === "injected-1" && decision1.messages[1].id === "m1");
check("prompt text normalized to @label", decision1.messages[1].content[0].text === "请参考 @session-abc123 继续");
check("references parsed", env.prepared.length === 1 && env.prepared[0].references[0].sessionId === "session-abc123");

// Case 2: plain message without links → untouched, no prepare call.
const prompt2 = { id: "m2", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "普通消息" }] };
const decision2 = await ctx_waterfall(env.ctx, { messages: [prompt2], turn: 2, step: 1 });
check("plain message untouched", decision2.messages.length === 1 && decision2.messages[0].content[0].text === "普通消息");
check("no extra prepare", env.prepared.length === 1);

// Case 3: context (non-user) message with a link is ignored.
const contextMsg = { id: "c1", role: "user", source: { kind: "plugin" }, content: [{ type: "text", text: "http://127.0.0.1:3080/s/session-xyz" }] };
const decision3 = await ctx_waterfall(env.ctx, { messages: [contextMsg], turn: 3, step: 1 });
check("context message ignored", decision3.messages.length === 1);

// Case 4: malformed canonical URI must not break the turn.
const prompt4 = { id: "m4", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "dsh-session:garbage-not-json 消息" }] };
const decision4 = await ctx_waterfall(env.ctx, { messages: [prompt4], turn: 4, step: 1 });
check("malformed URI keeps turn intact", decision4.kind === "enter" && decision4.messages.length === 1);
check("malformed URI left as text", decision4.messages[0].content[0].text === "dsh-session:garbage-not-json 消息");

// Case 5: prepare failure (self-reference) leaves the message untouched.
env.setFailWith(new Error("SESSION_REFERENCE_SELF_REFERENCE"));
const prompt5 = { id: "m5", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "参考 http://127.0.0.1:3080/s/session-self 会话" }] };
const decision5 = await ctx_waterfall(env.ctx, { messages: [prompt5], turn: 5, step: 1 });
check("prepare failure keeps turn intact", decision5.kind === "enter" && decision5.messages.length === 1);

// Case 6: canonical bare URI works.
env.setFailWith(null);
const uri = "dsh-session:InNlc3Npb24tMDY5Y2I2MmEtNTY4My00MDczLTlhYTMtNmZmZDZiMDc5NTNhIg";
const prompt6 = { id: "m6", role: "user", source: { kind: "user" }, content: [{ type: "text", text: `canonical ${uri} end` }] };
const decision6 = await ctx_waterfall(env.ctx, { messages: [prompt6], turn: 6, step: 1 });
check("canonical URI injected", decision6.messages.length === 2 && decision6.messages[1].content[0].text === "canonical @session-069cb62a-5683-4073-9aa3-6ffd6b07953a end");

// Case 7: dsh:// deep link (the copied format) works.
const prompt7 = { id: "m7", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "参考 dsh://session/session-069cb62a-5683-4073-9aa3-6ffd6b07953a 会话" }] };
const decision7 = await ctx_waterfall(env.ctx, { messages: [prompt7], turn: 7, step: 1 });
check("dsh:// link injected", decision7.messages.length === 2 && decision7.messages[1].content[0].text === "参考 @session-069cb62a-5683-4073-9aa3-6ffd6b07953a 会话");

// Case 8: unrelated dsh:// URI without a session id is left as plain text.
const prompt8 = { id: "m8", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "app dsh://settings/theme 说明" }] };
const decision8 = await ctx_waterfall(env.ctx, { messages: [prompt8], turn: 8, step: 1 });
check("unrelated dsh:// untouched", decision8.messages.length === 1 && decision8.messages[0].content[0].text === "app dsh://settings/theme 说明");

// Case 9: dsh:// inside a markdown link destination is still resolved.
const prompt9 = { id: "m9", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "[看这个](dsh://session/session-abc123) 继续" }] };
const decision9 = await ctx_waterfall(env.ctx, { messages: [prompt9], turn: 9, step: 1 });
const text9 = decision9.messages[1].content[0].text;
check("dsh:// in markdown destination injected", decision9.messages.length === 2 && text9.includes("@session-abc123"));

// ---------------------------------------------------------------------------
// -pro: registration surface
// ---------------------------------------------------------------------------

check("four tools registered", ["team_link_list_sessions", "team_link_export", "team_link_send", "team_link_watch"].every((name) => env.tool(name) !== undefined));
check("export route registered", env.routes.filter((route) => route.kind === "exact" && route.path === "/team-link/export").length === 1);
check("C 批 W1 前置: the read-only team panel route is registered beside it, on the same exact-path shape", env.routes.filter((route) => route.path === "/team-link/panel").length === 1);

// ---------------------------------------------------------------------------
// -pro: list tool
// ---------------------------------------------------------------------------

const listTool = env.tool("team_link_list_sessions");
const listOut = await listTool.execute({}, execFor(env.senderAgent));
check("list shows same-project sessions", listOut.includes("session-target") && listOut.includes("session-runner") && listOut.includes("session-cold"));
check("list hides other-project sessions by default", !listOut.includes("session-other"));
check("list hides self", !listOut.includes("- session-self"));
check("list marks running/idle/cold", listOut.includes("▶ 运行中") && listOut.includes("○ 空闲") && listOut.includes("✕ 未运行"));
check("list includes folded titles", listOut.includes("「目标会话」") && listOut.includes("「跑着呢」"));
check("list shows session topic digest", listOut.includes("主题：") && listOut.includes("帮我优化会话导出功能"));
check("list shows last activity digest", listOut.includes("最近：") && listOut.includes("导出已完成优化。"));
const listAll = await listTool.execute({ includeOtherProjects: true }, execFor(env.senderAgent));
check("list includes other projects on request", listAll.includes("session-other") && listAll.includes("D:/elsewhere"));

// ---------------------------------------------------------------------------
// M1a (§3.1): liveness verdict table — the five states and both boundaries
// ---------------------------------------------------------------------------

const { verdictOf } = __testing;

/** Baseline signal; each case overrides only the field it is about. */
const signalFor = (over = {}) => ({
	agent: "idle",
	lastAssistantAt: null,
	lastInboundAt: null,
	turnStartedAt: null,
	goal: null,
	silenceMs: 0,
	verdict: "ok",
	...over,
});
const goalOf = (phase, activation, extra = {}) => ({ phase, activation, rounds: "3/70", blockedReason: null, ...extra });
const NOW = 1_700_000_000_000;
const verdict = (over, cfg = {}) => verdictOf(signalFor(over), { now: NOW, ...cfg });

check("verdict: no live agent → dead", verdict({ agent: "not-live" }) === "dead");
check("verdict: running with a fresh turn → ok", verdict({ agent: "running", turnStartedAt: NOW - 1000 }) === "ok");
check("verdict: running past 30min → long-running", verdict({ agent: "running", turnStartedAt: NOW - 31 * 60000 }) === "long-running");
check("verdict: running exactly at 30min → ok (strict >)", verdict({ agent: "running", turnStartedAt: NOW - 30 * 60000 }) === "ok");
check("verdict: running without a turn mark → ok", verdict({ agent: "running", turnStartedAt: null }) === "ok");
check("verdict: idle armed-active goal → ok (own cadence, §3.7)", verdict({ goal: goalOf("active", "armed"), silenceMs: 60 * 60000 }) === "ok");
check("verdict: idle active-but-disarmed → goal-disarmed without waiting for silence", verdict({ goal: goalOf("active", "disarmed"), silenceMs: 0 }) === "goal-disarmed");
check("verdict: idle paused goal → ok (silence already explained)", verdict({ goal: goalOf("paused", "disarmed"), silenceMs: 60 * 60000 }) === "ok");
check("verdict: idle blocked goal → ok (waiting on a human)", verdict({ goal: goalOf("blocked", "disarmed"), silenceMs: 60 * 60000 }) === "ok");
check("verdict: idle complete goal → ok", verdict({ goal: goalOf("complete", "disarmed"), silenceMs: 60 * 60000 }) === "ok");
check("verdict: idle silent past 10min with no goal → silent-idle (P1)", verdict({ silenceMs: 11 * 60000 }) === "silent-idle");
check("verdict: idle silent exactly at 10min → ok (strict >)", verdict({ silenceMs: 10 * 60000 }) === "ok");
check("verdict: goals service absent (goal=null) degrades to the no-goal branch", verdict({ goal: null, silenceMs: 11 * 60000 }) === "silent-idle");
check("verdict: goals service absent with recent activity → ok", verdict({ goal: null, silenceMs: 60000 }) === "ok");
check("verdict: phase none (service present, no goal) follows the no-goal branch", verdict({ goal: goalOf("none", "?"), silenceMs: 11 * 60000 }) === "silent-idle");
check("verdict: the silence threshold is configurable", verdictOf(signalFor({ silenceMs: 20 * 60000 }), { now: NOW, silentMin: 30 }) === "ok");

// ---------------------------------------------------------------------------
// M1a (§3.1): list_sessions liveness rows, goal states and the reading stamp
// ---------------------------------------------------------------------------

const NOW_REAL = Date.now();
const ancientEvents = (topic) => [
	{ type: "user/message", seq: 1, time: 1, data: { id: "u1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: topic }] } },
	{ type: "assistant/message", seq: 2, time: 2, data: { turn: 1, step: 1, message: { id: "a1", role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "text", text: "好的" }] } } },
];
const lvIds = ["session-lv-silent", "session-lv-armed", "session-lv-disarmed", "session-lv-paused", "session-lv-blocked", "session-lv-longrun", "session-lv-cold"];
const lvEnv = setup({
	sessions: lvIds.map((id, index) => ({ header: { id, createdAt: 1000 + index, cwd: CWD }, live: id !== "session-lv-cold", persisted: true })),
	eventsBySession: {
		"session-lv-silent": ancientEvents("silent"),
		"session-lv-armed": ancientEvents("armed"),
		"session-lv-disarmed": ancientEvents("disarmed"),
		"session-lv-paused": ancientEvents("paused"),
		"session-lv-blocked": ancientEvents("blocked"),
		"session-lv-longrun": [{ type: "turn/start", seq: 1, time: NOW_REAL - 31 * 60000, data: { turn: 1 } }],
	},
	extraAgents: lvIds.filter((id) => id !== "session-lv-cold").map((id) => ({ id, status: id === "session-lv-longrun" ? "running" : "idle" })),
	goals: {
		"session-lv-armed": { phase: "active", activation: "armed", roundsStarted: 12, maxGoalRounds: 70 },
		"session-lv-disarmed": { phase: "active", activation: "disarmed", roundsStarted: 3, maxGoalRounds: 70 },
		"session-lv-paused": { phase: "paused", activation: "disarmed", roundsStarted: 5, maxGoalRounds: 70 },
		"session-lv-blocked": { phase: "blocked", activation: "disarmed", roundsStarted: 70, maxGoalRounds: 70, blockedReason: { code: "round-limit", message: "round limit reached" } },
	},
});
const lvOut = await lvEnv.tool("team_link_list_sessions").execute({}, execFor(lvEnv.senderAgent));
check("liveness: every listed session carries one 活性 row", (lvOut.match(/^    活性：/gmu) ?? []).length === lvIds.length);
check("liveness: all five verdicts are rendered", ["verdict=silent-idle", "verdict=ok", "verdict=goal-disarmed", "verdict=long-running", "verdict=dead"].every((needle) => lvOut.includes(needle)));
check("liveness: goal phase/activation/rounds are rendered", lvOut.includes("goal=active/armed(12/70)") && lvOut.includes("goal=active/disarmed(3/70)"));
check("liveness: a blocked goal carries its durable blockedReason", lvOut.includes("goal=blocked/disarmed(70/70) blocked=round-limit: round limit reached"));
check("liveness: paused/blocked are shown as ok, never alarmed on", /session-lv-paused[\s\S]*?verdict=ok/u.test(lvOut) && /session-lv-blocked[\s\S]*?verdict=ok/u.test(lvOut));
check("liveness: dead session row is not-live and verdict=dead", /- session-lv-cold \u2014 ✕ 未运行/u.test(lvOut) && /session-lv-cold[\s\S]*?verdict=dead/u.test(lvOut));
check("liveness: the running turn start is shown", lvOut.includes("回合始于"));
check("liveness: the silence duration is shown in minutes", /静默 \d+\.\dmin/u.test(lvOut));
check("liveness: every session row ends with the reading stamp and the staleness window", (lvOut.match(/（读数 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}，>2min 作废）/gu) ?? []).length === lvIds.length);

const noGoalsEnv = setup({
	sessions: [{ header: { id: "session-lv-silent", createdAt: 1000, cwd: CWD }, live: true, persisted: true }],
	eventsBySession: { "session-lv-silent": ancientEvents("silent") },
	extraAgents: [{ id: "session-lv-silent", status: "idle" }],
});
const noGoalsOut = await noGoalsEnv.tool("team_link_list_sessions").execute({}, execFor(noGoalsEnv.senderAgent));
check("liveness: without the goals service the goal face degrades to ? and the list still works", noGoalsOut.includes("goal=?") && !noGoalsOut.includes("列出会话失败"));
check("liveness: without the goals service the no-goal verdict path still fires", noGoalsOut.includes("verdict=silent-idle"));

// ---------------------------------------------------------------------------
// §3.1 read window: the surface reads of the list tool are BOUNDED to
// PREVIEW_SESSIONS rows and run in PARALLEL (production bug: one SERIAL surface
// read per listed session — up to LIST_LIMIT = 50 cold zstd logs — overran the
// 60s tool timeout on a real 26-session workspace).
// ---------------------------------------------------------------------------

const WIN_IDS = Array.from({ length: 14 }, (_, index) => `session-win-${String(index).padStart(2, "0")}`);
// session-win-05 is deliberately unreadable INSIDE the window: one rejecting log
// must degrade that row alone, never the window around it.
const WIN_BROKEN = WIN_IDS[5];
const winEvents = Object.fromEntries(WIN_IDS.slice(0, 12).filter((id) => id !== WIN_BROKEN).map((id) => [id, ancientEvents(`窗口主题 ${id}`)]));
// The probe is the parallelism evidence: all 12 reads are started from one batch,
// so by the time the first of them resolves the counter already reads 12. A
// serial loop resolves its first read with the counter still at 1.
let winStarted = 0;
let winInFlightAtFirstResolve = 0;
const winEnv = setup({
	sessions: WIN_IDS.map((id, index) => ({ header: { id, createdAt: 1000 + index, cwd: CWD }, live: true, persisted: true })),
	eventsBySession: winEvents,
	extraAgents: WIN_IDS.map((id) => ({ id, status: "idle" })),
	surfaceReadHook: async () => {
		winStarted += 1;
		await new Promise((resolve) => setTimeout(resolve, 0));
		if (winInFlightAtFirstResolve === 0) winInFlightAtFirstResolve = winStarted;
	},
});
const winOut = await winEnv.tool("team_link_list_sessions").execute({}, execFor(winEnv.senderAgent));
const winRows = winOut.split(/\n(?=- session-win-)/u).filter((block) => block.startsWith("- session-win-"));
const winRowOf = (id) => winRows.find((block) => block.startsWith(`- ${id} `));

check("§3.1 window: readSurface is called for the first PREVIEW_SESSIONS rows and for no others", winEnv.query.surfaceReads.length === 12 && winEnv.query.surfaceReads.every((id, index) => id === WIN_IDS[index]) && !winEnv.query.surfaceReads.includes(WIN_IDS[12]));
check("§3.1 window: the 12 window reads run in PARALLEL — all of them were in flight before the first resolved", winStarted === 12 && winInFlightAtFirstResolve === 12);
check("§3.1 window: all 14 rows still list, each with exactly one 活性 line (rows past the window degrade, they are not dropped)", winRows.length === WIN_IDS.length && (winOut.match(/^    活性：/gmu) ?? []).length === WIN_IDS.length);
check("§3.1 window: row 13 (index 12) says it was not read instead of showing a verdict", (() => {
	const block = winRowOf(WIN_IDS[12]);
	return block !== undefined && block.includes(`活性：未读（超出快照窗口 12）`) && !block.includes("verdict=") && !block.includes("主题：");
})());
check("§3.1 window: a row past the window keeps its surface-free faces (id, agent state, creation time, reading stamp)", (() => {
	const block = winRowOf(WIN_IDS[13]);
	return block !== undefined && block.includes("○ 空闲") && block.includes("创建于") && /（读数 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}，>2min 作废）/u.test(block);
})());
check("§3.1 window: rows inside the window keep their computed verdict and digest", (() => {
	const tailRow = winRowOf(WIN_IDS[11]);
	return tailRow !== undefined && tailRow.includes("verdict=silent-idle") && tailRow.includes(`主题：窗口主题 ${WIN_IDS[11]}`);
})());
check("§3.1 window: one unreadable log inside the window degrades that row alone (unknown silence on it, the rows around it still read)", (() => {
	const broken = winRowOf(WIN_BROKEN);
	const neighbour = winRowOf(WIN_IDS[6]);
	return broken !== undefined && broken.includes("静默 ?") && neighbour !== undefined && neighbour.includes("verdict=silent-idle") && neighbour.includes(`主题：窗口主题 ${WIN_IDS[6]}`);
})());

// ---------------------------------------------------------------------------
// -pro: export tool
// ---------------------------------------------------------------------------

const exportEvents = [
	{ type: "turn/start", seq: 1, time: 1, data: { turn: 1 } },
	{ type: "user/message", seq: 2, time: 2, data: { id: "m1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "你好，请帮我导出" }] } },
	{ type: "assistant/message", seq: 3, time: 3, data: { turn: 1, step: 1, message: { id: "a1", role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "text", text: "好的，开始导出。" }] } } },
	{ type: "tool/result", seq: 4, time: 4, data: { turn: 1, step: 1, message: { id: "r1", role: "user", source: { kind: "tool", callId: "c1" }, content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "结果文本" }] }] } } },
];
const exportEnv = setup({ sessions, eventsBySession: { "session-target": exportEvents } });
const tmpDir = path.join(TEST_ROOT, "export");
rmSync(tmpDir, { recursive: true, force: true });
const exportTool = exportEnv.tool("team_link_export");
const exportOut = await exportTool.execute({ sessionId: "session-target", outputDir: tmpDir }, execFor(exportEnv.senderAgent));
check("export reports two files", exportOut.includes("已导出会话") && exportOut.includes(".md") && exportOut.includes(".json"));
const mdPath = exportOut.split("\n").map((line) => line.replace("- ", "").trim()).find((line) => line.endsWith(".md"));
const jsonPath = exportOut.split("\n").map((line) => line.replace("- ", "").trim()).find((line) => line.endsWith(".json"));
check("markdown artifact exists", mdPath !== undefined);
const md = mdPath !== undefined ? await readFile(mdPath, "utf8") : "";
check("markdown renders user text", md.includes("你好，请帮我导出"));
check("markdown renders assistant text", md.includes("好的，开始导出。"));
check("markdown renders tool result", md.includes("结果文本") && md.includes("c1"));
check("markdown has header block", md.includes("# 会话导出") && md.includes("session-target"));
const json = jsonPath !== undefined ? JSON.parse(await readFile(jsonPath, "utf8")) : {};
check("json keeps full event log", json.eventCount === 4 && Array.isArray(json.events) && json.events.length === 4);
check("json marks exporter", json.exporter === "dsh-team-link");
const exportMissing = await exportTool.execute({ sessionId: "session-nope", outputDir: tmpDir }, execFor(exportEnv.senderAgent));
check("export of unknown session reports failure", exportMissing.includes("导出失败"));

// 评审 #2: the artifact name is a path, so the session id has to pass the SAME
// filename-safety invariant the download route already applied. A traversal-shaped
// id is the sharp case: before the shared helper it decided both the directory the
// write went to and its extension. The events lookup stays on the raw id — only the
// name is sanitised, so the artifacts keep their `<id>-<timestamp>` readability.
const escEvents = [{ type: "user/message", seq: 1, time: 1, data: { id: "e1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "越界会话" }] } }];
const escEnv = setup({ sessions: [{ header: { id: "../../escaped", createdAt: 1000, cwd: CWD }, live: true, persisted: true }], eventsBySession: { "../../escaped": escEvents } });
const escDir = path.join(TEST_ROOT, "escape");
rmSync(escDir, { recursive: true, force: true });
const escOut = await escEnv.tool("team_link_export").execute({ sessionId: "../../escaped", outputDir: escDir }, execFor(escEnv.senderAgent));
const escFiles = escOut.split("\n").map((line) => line.replace("- ", "").trim()).filter((line) => line.endsWith(".md") || line.endsWith(".json"));
check("评审 #2: the export tool and the download route share one filename invariant — a traversal-shaped id is written inside the export dir under the sanitised name", escFiles.length === 2 && escFiles.every((file) => path.dirname(path.resolve(file)) === escDir && /^\.\._\.\._escaped-\d{8}-\d{6}\.(md|json)$/u.test(path.basename(file))) && !existsSync(path.resolve(escDir, "..", "escaped-")));

const routeEnv = setup({ sessions: [{ header: { id: "../../escaped", createdAt: 1000, cwd: CWD }, live: true, persisted: true }], eventsBySession: { "../../escaped": escEvents } });
const exportRoute = routeEnv.routes.find((route) => route.path === "/team-link/export");
let routeResult;
// 批次 1 (§4.1 ③): the fixture now states its method — a real IncomingMessage
// always carries one, and the route has a method whitelist to answer.
await exportRoute.handler({ method: "GET", url: "/team-link/export?session=../../escaped&format=md" }, { writeHead(code, headers) { routeResult = { code, headers }; }, end() {} });
check("评审 #2: the download header uses the same invariant (no separator can reach content-disposition)", routeResult.code === 200 && routeResult.headers["content-disposition"] === 'attachment; filename=".._.._escaped.md"');

// ---------------------------------------------------------------------------
// -pro: send tool — approve → accept → wake (idle target)
// ---------------------------------------------------------------------------

const sendEnv = setup({ sessions, askScript: ["发送", "接收"] });
const sendTool = sendEnv.tool("team_link_send");
const sendOut = await sendTool.execute({ targetSessionId: "session-target", message: "联调提醒：接口地址已切换" }, execFor(sendEnv.senderAgent));
check("send reports wake delivery", sendOut.includes("已投递") && sendOut.includes("唤醒"));
check("idle target received followup() once", sendEnv.targetCalls.followedup.length === 1 && sendEnv.targetCalls.injected.length === 0 && sendEnv.targetCalls.steered.length === 0);
const delivered = sendEnv.targetCalls.followedup[0];
// The audited admission set of the DSH 0.1.5 session-log migration
// (@deepseek-ai/dsh-session-format-v2-to-v3 `SOURCE_KINDS`). An unknown kind — or
// one extra member on `agent-message` — refuses the WHOLE session log, so the
// delivered shape is pinned here rather than left to a source comment.
const AUDITED_SOURCE_KINDS = new Set(["user", "plugin", "model", "tool", "agent-instructions", "session-reference", "team-message", "goal", "skill-invocation", "skill-catalog", "coordinator", "subagent-report", "subagent-settled", "webhook", "agent-message"]);
check("delivered message is a valid user message", delivered.role === "user" && typeof delivered.id === "string" && delivered.id.startsWith("slp-") && Array.isArray(delivered.content));
check("delivered source is the audited agent-message relay shape", delivered.source.kind === "agent-message" && delivered.source.form === "relay" && delivered.source.senderSessionId === "session-self");
check("delivered source carries exactly the three audited members", Object.keys(delivered.source).length === 3 && AUDITED_SOURCE_KINDS.has(delivered.source.kind));
check("delivered banner names the sender and the relay time", /📨 \[跨会话消息 · 来自会话 .+ · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]/.test(delivered.content[0].text));
check("delivered text embeds the payload", delivered.content[0].text.includes("联调提醒：接口地址已切换"));
check("sender approval asked on sender agent", sendEnv.uq.requests[0].questions[0].id === "send-confirm" && sendEnv.uq.requests[0].agent === sendEnv.senderAgent);
check("receiver confirmation asked on target agent", sendEnv.uq.requests[1].questions[0].id === "receive-confirm" && sendEnv.uq.requests[1].agent === sendEnv.targetAgent);

// ---------------------------------------------------------------------------
// -pro: send tool — running target uses steer
// ---------------------------------------------------------------------------

const steerEnv = setup({ sessions, askScript: ["发送", "接收"], targetStatus: "running" });
const steerOut = await steerEnv.tool("team_link_send").execute({ targetSessionId: "session-target", message: "快停，发现冲突" }, execFor(steerEnv.senderAgent));
check("running target reports current-turn injection", steerOut.includes("已投递") && steerOut.includes("当前回合"));
check("running target received steer() once", steerEnv.targetCalls.steered.length === 1 && steerEnv.targetCalls.injected.length === 0 && steerEnv.targetCalls.followedup.length === 0);

// ---------------------------------------------------------------------------
// -pro: send tool — pairing: one approval each way, then silent auto-relay
// ---------------------------------------------------------------------------

const pairEnv = setup({ sessions, askScript: ["发送", "配对：双向免确认"] });
const pairTool = pairEnv.tool("team_link_send");
const pairOut1 = await pairTool.execute({ targetSessionId: "session-target", message: "建对第一条" }, execFor(pairEnv.senderAgent));
check("pairing send delivers", pairOut1.includes("已投递") && pairEnv.targetCalls.followedup.length === 1);
check("pair option offered on receiver confirm", pairEnv.uq.requests[1].questions[0].options.some((option) => option.label.startsWith("配对")));
const pairOut2 = await pairTool.execute({ targetSessionId: "session-target", message: "配对后免确认直达" }, execFor(pairEnv.senderAgent));
check("paired follow-up skips both gates", pairOut2.includes("已配对") && pairOut2.includes("已投递") && pairEnv.uq.requests.length === 2 && pairEnv.targetCalls.followedup.length === 2);
const revOut = await pairTool.execute({ targetSessionId: "session-self", message: "反向直达" }, execFor(pairEnv.targetAgent));
check("pairing auto-relays in reverse direction", revOut.includes("已配对") && revOut.includes("已投递") && pairEnv.senderCalls.followedup.length === 1 && pairEnv.uq.requests.length === 2);

// ---------------------------------------------------------------------------
// -pro: send tool — receiver rejects and blocks; follow-up blocked silently
// ---------------------------------------------------------------------------

const rejectEnv = setup({ sessions, askScript: ["发送", "拒绝并屏蔽该会话", "发送"] });
const rejectOut = await rejectEnv.tool("team_link_send").execute({ targetSessionId: "session-target", message: "第一条" }, execFor(rejectEnv.senderAgent));
check("rejection reports block", rejectOut.includes("拒绝并屏蔽"));
check("rejected message not delivered", rejectEnv.targetCalls.injected.length === 0 && rejectEnv.targetCalls.followedup.length === 0);
const blockedOut = await rejectEnv.tool("team_link_send").execute({ targetSessionId: "session-target", message: "第二条" }, execFor(rejectEnv.senderAgent));
check("follow-up blocked without receiver ask", blockedOut.includes("已屏蔽") && rejectEnv.uq.requests.length === 2);

// ---------------------------------------------------------------------------
// -pro: send tool — sender cancels; nothing delivered, no receiver ask
// ---------------------------------------------------------------------------

const cancelEnv = setup({ sessions, askScript: ["取消"] });
const cancelOut = await cancelEnv.tool("team_link_send").execute({ targetSessionId: "session-target", message: "算了" }, execFor(cancelEnv.senderAgent));
check("cancel reports refusal", cancelOut.includes("已取消"));
check("canceled message not delivered", cancelEnv.targetCalls.injected.length === 0 && cancelEnv.targetCalls.followedup.length === 0 && cancelEnv.uq.requests.length === 1);

// ---------------------------------------------------------------------------
// -pro: send tool — guard rails
// ---------------------------------------------------------------------------

const guardEnv = setup({ sessions, askScript: [] });
const selfOut = await guardEnv.tool("team_link_send").execute({ targetSessionId: "session-self", message: "自发自收" }, execFor(guardEnv.senderAgent));
check("self-send refused", selfOut.includes("不能是当前会话"));
const deadOut = await guardEnv.tool("team_link_send").execute({ targetSessionId: "session-cold", message: "喂" }, execFor(guardEnv.senderAgent));
check("dead target refused", deadOut.includes("没有活动代理"));

// ---------------------------------------------------------------------------
// no-agent refusal, self-healing (生产事故：目标 id 转录错位一位 →
// 「目标会话 … 没有活动代理」只给了一种解释，调用方无从核对 id，于是把失败
// 当成功继续汇报，而目标会话其实活着)
// ---------------------------------------------------------------------------
// Deliverable shape: ❌ lead + the legacy sentence + the live sessions of the
// caller's OWN workspace + the recovery hint. The list is a registry read only
// (no surface read), which is why a refusal path can afford it.

/** The hint fixture: two live root peers in the CALLER's workspace, one root in
 * another workspace, one subagent. `session-target` / `session-runner` are the
 * always-present roots in CWD — outside this caller's workspace, so they must
 * not be advertised either. */
const hintEnv = setup({
	sessions: [],
	selfCwd: `${CWD}/ws`,
	extraAgents: [
		{ id: "session-peer-a", status: "running", cwd: `${CWD}/ws` },
		{ id: "session-peer-b", status: "idle", cwd: `${CWD}/ws` },
		{ id: "session-elsewhere", status: "idle", cwd: "D:/elsewhere" },
		{ id: "session-child", status: "idle", cwd: `${CWD}/ws`, origin: "subagent" },
	],
});
const hintOut = await hintEnv.tool("team_link_send").execute({ targetSessionId: "session-typo", message: "喂" }, execFor(hintEnv.senderAgent));
check("no-agent: the refusal leads with ❌ 未投递 — a failure may never be read as a queued send", hintOut.startsWith("❌ 未投递：目标会话 session-typo 没有活动代理"));
check("no-agent: the legacy sentence stays word for word", hintOut.includes("（未在本壳中打开或已退出）。仅支持投递到存活会话。"));
check("no-agent: it lists the caller's own workspace, one live session per line with its state", hintOut.includes("当前工作区其他存活会话（共 2 个）：") && hintOut.includes("\n  - session-peer-a（运行中）") && hintOut.includes("\n  - session-peer-b（空闲）"));
check("no-agent: ...and only those — another workspace, a subagent, the caller and the other roots stay out", !hintOut.includes("session-elsewhere") && !hintOut.includes("session-child") && !hintOut.includes("session-self") && !hintOut.includes("session-target") && !hintOut.includes("session-runner"));
check("no-agent: the recovery hint names the id check, the sidebar re-open and list_sessions", hintOut.includes("请对照上列 id 核对目标 id（常见错误：转录错位）") && hintOut.includes("在侧边栏打开目标会话一次使其恢复为活动代理") && hintOut.includes("team_link_list_sessions"));

const hintCapEnv = setup({
	sessions: [],
	selfCwd: `${CWD}/ws`,
	extraAgents: Array.from({ length: 12 }, (_, index) => ({ id: `session-peer-${index}`, status: index === 0 ? "running" : "idle", cwd: `${CWD}/ws` })),
});
const hintCapOut = await hintCapEnv.tool("team_link_send").execute({ targetSessionId: "session-typo", message: "喂" }, execFor(hintCapEnv.senderAgent));
check("no-agent: the hint list stops at 10 and declares the bound instead of hiding it", hintCapOut.includes("当前工作区其他存活会话（共 12 个，仅列前 10 个）：") && (hintCapOut.match(/\n  - session-peer-/gu) ?? []).length === 10);

const hintSoloEnv = setup({ sessions: [], selfCwd: `${CWD}/solo` });
const hintSoloOut = await hintSoloEnv.tool("team_link_send").execute({ targetSessionId: "session-typo", message: "喂" }, execFor(hintSoloEnv.senderAgent));
check("no-agent: with no other live session in the workspace the list degrades to one honest sentence", hintSoloOut.startsWith("❌ 未投递") && hintSoloOut.includes("当前工作区无其他存活会话。") && !hintSoloOut.includes("当前工作区其他存活会话"));

// ---------------------------------------------------------------------------
// -pro: lone-surrogate safety (code-point truncation + well-formed output)
// ---------------------------------------------------------------------------
// A lone surrogate (half of an emoji) in tool output is not cosmetic. The
// orchestrator forwards a tool result verbatim into the next model request, and
// an unpaired UTF-16 surrogate makes that request fail with HTTP 400
// INVALID_REQUEST — permanently: the poisoned text stays in the history, so
// every later turn of that session dies the same way. Observed on all four of
// the logged sessions that carried one over deepseek-official (a local scan of
// 882 session logs found five with a real lone surrogate; the fifth, on qax,
// survived). This list tool's topic/activity preview was the source: `slice(0, 89)`
// cut at code-unit index 88 and the emoji sat exactly there.
//
// The contract pinned below: a returned string carries an astral character
// COMPLETE or not at all — never half of it.

const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const hasLone = (text) => LONE.test(String(text));

/** One-session environment whose surface topic is rewritten per case. */
const loneTopicEvents = [
	{ type: "user/message", seq: 1, time: 1, data: { id: "e1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "" }] } },
];
const loneEnv = setup({
	sessions: [{ header: { id: "session-emoji", createdAt: 5000, cwd: CWD }, live: false, persisted: true }],
	eventsBySession: { "session-emoji": loneTopicEvents },
});
const loneListTool = loneEnv.tool("team_link_list_sessions");
const setLoneTopic = (text) => { loneTopicEvents[0].data.content[0].text = text; };
/** Run the list tool on one topic and return the whole output plus its 主题段. */
const listForTopic = async (topic) => {
	setLoneTopic(topic);
	const out = await loneListTool.execute({}, execFor(loneEnv.senderAgent));
	const line = out.split("\n").find((candidate) => candidate.includes("主题："));
	return { out, preview: line === undefined ? "" : line.slice(line.indexOf("主题：") + "主题：".length) };
};

// (a) property: one emoji walked across EVERY offset 0..120 of the topic, so the
//     limit-90 cut lands on every code unit in turn — including the two halves.
const loneOffsets = [];
for (let n = 0; n <= 120; n += 1) {
	const { out } = await listForTopic(`${"x".repeat(n)}🔵 尾巴`);
	if (hasLone(out)) loneOffsets.push(n);
}
check(`list output carries no lone surrogate at any of 121 cut offsets (bad offsets: ${loneOffsets.length === 0 ? "none" : loneOffsets.join(",")})`, loneOffsets.length === 0);

// (b) the production accident, pinned exactly: 88 x then the emoji puts its high
//     surrogate at code-unit index 88 — the last unit `slice(0, 89)` kept.
const boundaryCase = await listForTopic(`${"x".repeat(88)}🔵尾巴`);
check("production boundary: list output has no lone surrogate", !hasLone(boundaryCase.out));
check("production boundary: the preview segment is exactly 90 code points", [...boundaryCase.preview].length === 90);
check("production boundary: the preview segment keeps the whole emoji, then the ellipsis", boundaryCase.preview.endsWith("🔵…"));

// (c) a topic that ALREADY carries a lone surrogate (a log written by an older
//     build, or any foreign text) must be repaired on the way out, not forwarded:
//     code-point cutting alone cannot fix a source that is already half an emoji.
const prePoisoned = await listForTopic(`${"x".repeat(10)}\uD83D 断开的 emoji`);
check("pre-poisoned topic: repaired, never forwarded", !hasLone(prePoisoned.out));
check("pre-poisoned topic: surrounding text survives the repair", prePoisoned.out.includes("断开的 emoji"));

// (d) the export path: truncate() cuts at MD_BLOCK_LIMIT (16000) with an explicit
//     marker, and the count in that marker is part of the honest rendering.
const longText = `${"x".repeat(15999)}🔵尾巴`;
const truncEnv = setup({
	sessions: [{ header: { id: "session-long", createdAt: 6000, cwd: CWD }, live: false, persisted: true }],
	eventsBySession: { "session-long": [{ type: "user/message", seq: 1, time: 1, data: { id: "l1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: longText }] } }] },
});
const truncDir = path.join(TEST_ROOT, "lone");
rmSync(truncDir, { recursive: true, force: true });
const truncOut = await truncEnv.tool("team_link_export").execute({ sessionId: "session-long", outputDir: truncDir }, execFor(truncEnv.senderAgent));
const truncMdPath = truncOut.split("\n").map((line) => line.replace("- ", "").trim()).find((line) => line.endsWith(".md"));
const truncMd = truncMdPath === undefined ? "" : await readFile(truncMdPath, "utf8");
check("export md artifact written for the oversized text", truncMdPath !== undefined);
check("export md has no lone surrogate", !hasLone(truncMd));
check("export md keeps the whole emoji at the cut", truncMd.includes(`${"x".repeat(15999)}🔵\n…[已截断 2 字符]`));
check("export md counts the cut in code points, not code units", !truncMd.includes("已截断 3 字符"));
rmSync(truncDir, { recursive: true, force: true });

// (e) the approval dialogs and the relayed banner are outward strings too: a lone
//     surrogate in the payload must not reach the sender's dialog, and — worse —
//     must not be written into the TARGET session's log by the relay banner.
const poisonText = `${"y".repeat(5)}\uD83D 断开的负载`;
const poisonEnv = setup({ sessions, askScript: ["发送", "接收"] });
await poisonEnv.tool("team_link_send").execute({ targetSessionId: "session-target", message: poisonText }, execFor(poisonEnv.senderAgent));
check("sender confirm dialog has no lone surrogate", poisonEnv.uq.requests[0] !== undefined && !hasLone(poisonEnv.uq.requests[0].questions[0].question));
check("receiver confirm dialog has no lone surrogate", poisonEnv.uq.requests[1] !== undefined && !hasLone(poisonEnv.uq.requests[1].questions[0].question));
const poisonDelivered = poisonEnv.targetCalls.followedup[0];
check("delivered relay banner has no lone surrogate", poisonDelivered !== undefined && !hasLone(poisonDelivered.content[0].text));
check("delivered relay banner keeps the payload text", poisonDelivered !== undefined && poisonDelivered.content[0].text.includes("断开的负载"));

// (f) the deep-link snapshot is this plugin's MOST direct carrier into the
//     caller's own next request. A lone surrogate inside the referenced session's
//     log must be repaired on the way in — an upstream resolver change is not
//     needed for that, only a well-formed copy of what it hands over.
const linkEnv = setup({ contextText: `${"z".repeat(3)}\uD83D 快照` });
const linkPrompt = { id: "link-1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "参考 dsh://session/session-abc123 继续" }] };
const linkDecision = await ctx_waterfall(linkEnv.ctx, { messages: [linkPrompt], turn: 30, step: 1 });
check("injected snapshot has no lone surrogate", linkDecision.messages.length === 2 && !hasLone(linkDecision.messages[0].content[0].text));
check("injected snapshot keeps its text", linkDecision.messages.length === 2 && linkDecision.messages[0].content[0].text.includes("快照"));

// (g) tool-argument echo: a model that copies a broken id back into
//     targetSessionId must not have that half-emoji echoed into its own history
//     by the refusal text.
const echoEnv = setup({ sessions, askScript: [] });
const echoOut = await echoEnv.tool("team_link_send").execute({ targetSessionId: "session-nope\uD83D", message: "x" }, execFor(echoEnv.senderAgent));
check("a refusal echoing a poisoned target id is repaired", !hasLone(echoOut));
check("a refusal still names the target id it was given", echoOut.includes("session-nope"));

// (h) `additionalContext` is optional in the resolver's contract: a resolver that
//     omits it must not get `undefined` spliced into the outgoing message array.
const noContextEnv = setup({ omitContext: true });
const noContextPrompt = { id: "link-2", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "参考 dsh://session/session-abc123 继续" }] };
const noContextDecision = await ctx_waterfall(noContextEnv.ctx, { messages: [noContextPrompt], turn: 31, step: 1 });
check("a missing snapshot context drops the injection instead of splicing undefined", noContextDecision.messages.length === 1 && noContextDecision.messages[0].id === "link-2");
check("the direct prompt still survives without a snapshot", noContextDecision.messages.length === 1 && noContextDecision.messages[0]?.content?.[0]?.text === "参考 @session-abc123 继续");

// ---------------------------------------------------------------------------
// M1b (§3.2.2 / §3.2.4): team_link_watch registration surface
// ---------------------------------------------------------------------------

const watchEnv = setup({
	sessions: [{ header: { id: "session-target", createdAt: 1000, cwd: CWD }, live: true, persisted: true }],
	useSettings: true,
});
const watchTool = watchEnv.tool("team_link_watch");
const watchExec = () => execFor(watchEnv.senderAgent);
const teamLinkNs = () => watchEnv.settings.namespaces.get("team-link");
check("watch tool registered", watchTool !== undefined);
check("settings stub carries both namespaces (team-link + the pre-rename one)", watchEnv.settings.namespaces.has("team-link") && watchEnv.settings.namespaces.has("session-link-pro"));

const noAgentOut = await watchTool.execute({ action: "register", targets: ["session-target"] }, { signal: new AbortController().signal });
check("register without a live agent is refused", noAgentOut.includes("需要可交互的活动代理"));
/** Argument-schema rejections surface as a thrown ToolArgsError, not a string. */
const rejectsArgs = async (args) => {
	try {
		return await watchTool.execute(args, watchExec());
	} catch (error) {
		return error;
	}
};
const badAction = await rejectsArgs({ action: "nonsense" });
check("the action schema admits only register / list / clear", badAction instanceof Error && badAction.message.includes("action"));
const noTargets = await watchTool.execute({ action: "register" }, watchExec());
check("register requires at least one target", noTargets.includes("需要 targets"));
const selfTarget = await watchTool.execute({ action: "register", targets: ["session-self", "session-target"] }, watchExec());
check("register refuses a self-referencing target list", selfTarget.includes("拒绝自指注册"));
const lowSilent = await watchTool.execute({ action: "register", targets: ["session-target"], silentMinutes: 9 }, watchExec());
check("silentMinutes below 10 is refused", lowSilent.includes("silentMinutes") && lowSilent.includes("注册失败"));
const fracSilent = await rejectsArgs({ action: "register", targets: ["session-target"], silentMinutes: 10.5 });
check("silentMinutes is schema-typed as an integer", fracSilent instanceof Error && fracSilent.message.includes("silentMinutes"));
const lowInterval = await watchTool.execute({ action: "register", targets: ["session-target"], intervalMinutes: 4 }, watchExec());
check("intervalMinutes below 5 is refused", lowInterval.includes("intervalMinutes") && lowInterval.includes("注册失败"));
const highTtl = await watchTool.execute({ action: "register", targets: ["session-target"], ttlHours: 25 }, watchExec());
check("a TTL above 24h is refused", highTtl.includes("ttlHours") && highTtl.includes("注册失败"));
const zeroTtl = await watchTool.execute({ action: "register", targets: ["session-target"], ttlHours: 0 }, watchExec());
check("a non-positive TTL is refused", zeroTtl.includes("ttlHours") && zeroTtl.includes("大于 0"));

const reg1 = await watchTool.execute({ action: "register", targets: ["session-target", "session-target"] }, watchExec());
check("register defaults to silent 10min / interval 5min / TTL 12h and de-duplicates targets", reg1.includes("已注册看门狗 wd-") && reg1.includes("静默 10min") && reg1.includes("巡检 5min") && reg1.includes("TTL 12.00h") && (reg1.match(/session-target/gu) ?? []).length === 1);
const regId = (reg1.match(/(wd-[0-9a-f-]{36})/u) ?? [])[1];
check("registration id uses the wd- prefix", typeof regId === "string" && regId.startsWith("wd-"));
check("the rejected requests wrote nothing to the store", teamLinkNs().data.watchdogs.length === 1);
check("the accepted registration is persisted under the team-link watchdogs key", teamLinkNs().data.watchdogs[0].watcherSession === "session-self" && teamLinkNs().data.watchdogs[0].team === null);

const okBoundary = await watchTool.execute({ action: "register", targets: ["session-target"], silentMinutes: 10, intervalMinutes: 5, ttlHours: 24 }, watchExec());
check("the documented boundaries are accepted (silent 10 / interval 5 / ttl 24)", okBoundary.includes("已注册看门狗") && okBoundary.includes("TTL 24.00h"));
const third = await watchTool.execute({ action: "register", targets: ["session-target"] }, watchExec());
check("a third registration is accepted", third.includes("已注册看门狗"));
const fourth = await watchTool.execute({ action: "register", targets: ["session-target"] }, watchExec());
check("a fourth registration for one session is refused (<=3, §3.2.4)", fourth.includes("最多 3 个") && teamLinkNs().data.watchdogs.length === 3);

const watchList = await watchTool.execute({ action: "list" }, watchExec());
check("list shows every registration with its targets and thresholds", watchList.includes("看门狗注册（共 3 个") && watchList.includes("目标：session-target") && watchList.includes("阈值：静默 10min"));
check("list marks the caller's own registrations and carries the reading stamp", watchList.includes("[自己]") && /（读数 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}，>2min 作废）/u.test(watchList));

const clearIdempotent = await watchTool.execute({ action: "clear", id: "wd-00000000-0000-0000-0000-000000000000" }, watchExec());
check("clear is idempotent for an unknown id", clearIdempotent.includes("已清理 0 个注册") && clearIdempotent.includes("幂等"));
const clearOne = await watchTool.execute({ action: "clear", id: regId }, watchExec());
check("clear removes exactly one own registration", clearOne.includes(`已清理看门狗注册 ${regId}`) && teamLinkNs().data.watchdogs.length === 2);
const clearAll = await watchTool.execute({ action: "clear" }, watchExec());
check("clear without an id removes every own registration", clearAll.includes("（2 个）") && teamLinkNs().data.watchdogs.length === 0);
const clearAgain = await watchTool.execute({ action: "clear" }, watchExec());
check("clear is idempotent when nothing is left", clearAgain.includes("（0 个）"));

// A foreign registration (another session's watchdog) is visible but not clearable.
teamLinkNs().data.watchdogs = [{ id: "wd-foreign", team: "", watcherSession: "session-target", targets: ["session-self"], silentMinutes: 10, intervalMinutes: 5, expiresAt: 2_000_000_000_000, createdAt: 1 }];
const clearForeign = await watchTool.execute({ action: "clear", id: "wd-foreign" }, watchExec());
check("clear refuses another session's registration", clearForeign.includes("只能清除自己的注册") && teamLinkNs().data.watchdogs.length === 1);
const foreignList = await watchTool.execute({ action: "list" }, watchExec());
check("list shows registrations without the own marker and normalizes team null", foreignList.includes("wd-foreign") && !foreignList.includes("wd-foreign [自己]") && foreignList.includes("团队 —"));
teamLinkNs().data.watchdogs = [];

// ---------------------------------------------------------------------------
// M1b (§3.2.3 / §3.7): patrol policy, tick delivery, TTL self-clean
// ---------------------------------------------------------------------------

const WD_NOW = 1_700_000_000_000;
/** The tick body's clock is this plugin's local stamp (§3.2.3), spelled here
 * once so an exact body comparison is possible. */
const stampOf = (ms) => {
	const date = new Date(ms);
	const pad = (n) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};
/** One assistant message at `time` — the whole activity history of a target that
 * has been silent since then. */
const oneShotSurface = (time, text = "在干活") => [{
	type: "assistant/message",
	seq: 1,
	time,
	data: { turn: 1, step: 1, message: { id: "a1", role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "text", text }] } },
}];

/**
 * Build a watchdog environment: the caller (session-self) plus one live idle
 * agent per target, over the settings-backed policy store.
 * @param goals - goal views by session id.
 * @param targets - `{ sessionId: { events, status } }`.
 */
function watchdogEnv({ goals = {}, targets = {}, selfStatus, selfGoal, watchdogs = undefined, teams = undefined, sections = undefined } = {}) {
	const ids = Object.keys(targets);
	const eventsBySession = {};
	for (const id of ids) eventsBySession[id] = targets[id].events;
	const env = setup({
		sessions: ids.map((id, index) => ({ header: { id, createdAt: 1000 + index, cwd: CWD }, live: true, persisted: true })),
		eventsBySession,
		useSettings: true,
		selfStatus,
		goals: { ...goals, ...(selfGoal !== undefined ? { "session-self": selfGoal } : {}) },
		extraAgents: ids.map((id) => ({ id, status: targets[id].status ?? "idle" })),
		// 批 1（FR-3/FR-7）：把一个既有注册直接种进命名空间 —— 这就是「重启后盘上的注册」
		// 那一档夹具（本批的两条新判据面都活在**已有注册**上：workbench digest 只对
		// origin:"auto" 那一条开放，attach 重挂整件事也只在持久化注册上有意义）。
		...(watchdogs === undefined && teams === undefined && sections === undefined ? {} : { settingsSeed: { "team-link": { ...(watchdogs === undefined ? {} : { watchdogs }), ...(teams === undefined ? {} : { teams }), ...(sections === undefined ? {} : { sections }) } } }),
	});
	return { ...env, eventsBySession, watch: env.tool("team_link_watch"), watchdog: __testing.watchdogFor(env.ctx) };
}

const armedGoal = (rounds = 12) => ({ phase: "active", activation: "armed", roundsStarted: rounds, maxGoalRounds: 70 });
const disarmedGoal = (rounds = 3) => ({ phase: "active", activation: "disarmed", roundsStarted: rounds, maxGoalRounds: 70 });

// --- four-state policy ----------------------------------------------------
const policyEnv = watchdogEnv({
	targets: {
		"session-silent": { events: oneShotSurface(1) },
		"session-dead": { events: oneShotSurface(1) },
		"session-armed": { events: oneShotSurface(1) },
		"session-paused": { events: oneShotSurface(1) },
		"session-blocked": { events: oneShotSurface(1) },
		"session-disarmed": { events: oneShotSurface(1) },
		"session-busy": { events: oneShotSurface(WD_NOW - 60_000), status: "running" },
	},
	goals: {
		"session-armed": armedGoal(),
		"session-paused": { phase: "paused", activation: "disarmed", roundsStarted: 5, maxGoalRounds: 70 },
		"session-blocked": { phase: "blocked", activation: "disarmed", roundsStarted: 70, maxGoalRounds: 70, blockedReason: { code: "round-limit", message: "round limit reached" } },
		"session-disarmed": disarmedGoal(),
	},
});
// session-dead has no live agent: hide it from the registry after setup.
policyEnv.setHiddenAgent("session-dead", true);
const silentReg = await policyEnv.watch.execute({ action: "register", targets: ["session-silent", "session-dead"] }, execFor(policyEnv.senderAgent));
const quietReg = await policyEnv.watch.execute({ action: "register", targets: ["session-armed", "session-paused", "session-blocked", "session-busy"] }, execFor(policyEnv.senderAgent));
const disarmedReg = await policyEnv.watch.execute({ action: "register", targets: ["session-disarmed"] }, execFor(policyEnv.senderAgent));
check("three registrations cover the whole four-state matrix", [silentReg, quietReg, disarmedReg].every((out) => out.includes("已注册看门狗")));

await policyEnv.watchdog.patrol({ now: WD_NOW });
// Exactly three ticks: the silent target, the gone target, and the
// active-but-disarmed one — and nothing for armed / paused / blocked / running.
check("only silent-idle, goal-disarmed and dead targets are ticked (§3.2.3)", policyEnv.senderCalls.followedup.length === 3);
const disarmedTick = policyEnv.senderCalls.followedup.find((message) => message.content[0].text.includes("session-disarmed"));
check("goal-disarmed tick carries the diagnosis and the legal resume loop (§3.2.3/§3.7)", disarmedTick !== undefined && disarmedTick.content[0].text === `[watchdog] 目标 session-disarmed 的 goal 处于 active-but-disarmed（可能原因：max-tokens 回合结束 / DSH 重启 / agent error，读数 ${stampOf(WD_NOW)}）。该状态不会自愈：请向用户说明并请求授权 resume；用户同意后调用 update_goal(action:"resume") 恢复续跑。复核用 team_link_list_sessions。`);
check("armed-active / paused / blocked / running targets are never ticked (§3.7 four-state table)", policyEnv.senderCalls.followedup.every((message) => !/session-armed|session-paused|session-blocked|session-busy/u.test(message.content[0].text)));
const silentTick = policyEnv.senderCalls.followedup.find((message) => message.content[0].text.includes("session-silent"));
check("silent-idle tick body is exactly the §3.2.3 constant with status fields only", silentTick !== undefined && silentTick.content[0].text === `[watchdog] 目标 session-silent 失联征兆：verdict=silent-idle 静默 ${((WD_NOW - 1) / 60000).toFixed(1)}min（读数 ${stampOf(WD_NOW)}）。请用 team_link_list_sessions 复核后处置；误报或不再需要盯人可用 team_link_watch clear。`);
const deadTick = policyEnv.senderCalls.followedup.find((message) => message.content[0].text.includes("session-dead"));
check("a target whose agent is gone ticks too (verdict=dead is tickable, §3.2.3)", deadTick !== undefined && /verdict=dead 静默 [\d.]+min（读数 /u.test(deadTick.content[0].text));

// --- U3: source shape and parameter independence ---------------------------
check("tick id uses the slp-wd- prefix", policyEnv.senderCalls.followedup.every((message) => typeof message.id === "string" && message.id.startsWith("slp-wd-")));
check("tick is a user message with one text block", policyEnv.senderCalls.followedup.every((message) => message.role === "user" && Array.isArray(message.content) && message.content.length === 1 && message.content[0].type === "text"));
check("tick source is exactly the audited relay shape (V10)", policyEnv.senderCalls.followedup.every((message) => message.source.kind === "agent-message" && message.source.form === "relay" && Object.keys(message.source).length === 3 && AUDITED_SOURCE_KINDS.has(message.source.kind)));
check("tick senderSessionId is the watcher itself (§3.2.3 note (a))", policyEnv.senderCalls.followedup.every((message) => message.source.senderSessionId === "session-self"));

const paramEnv = watchdogEnv({ targets: { "session-silent": { events: oneShotSurface(1) } } });
const paramA = await paramEnv.watch.execute({ action: "register", targets: ["session-silent"], silentMinutes: 10, intervalMinutes: 5, ttlHours: 12 }, execFor(paramEnv.senderAgent));
const paramB = await paramEnv.watch.execute({ action: "register", targets: ["session-silent"], silentMinutes: 60, intervalMinutes: 30, ttlHours: 24 }, execFor(paramEnv.senderAgent));
await paramEnv.watchdog.patrol({ now: WD_NOW });
const bodies = paramEnv.senderCalls.followedup.map((message) => message.content[0].text);
check("two registrations with different thresholds produce one tick each", paramA.includes("已注册看门狗") && paramB.includes("已注册看门狗") && bodies.length === 2);
check("the two registrations really do differ in every threshold", paramA.includes("TTL 12.00h") && paramB.includes("TTL 24.00h"));
check("the tick body never varies with registration parameters (§3.2.3 常量化)", bodies[0] === bodies[1]);

// --- debounce: one tick per silent period ----------------------------------
await policyEnv.watchdog.patrol({ now: WD_NOW });
check("a second patrol in the same silent period does not tick again", policyEnv.senderCalls.followedup.length === 3);
const laterNow = WD_NOW + 30 * 60000;
policyEnv.eventsBySession["session-silent"] = oneShotSurface(laterNow - 11 * 60000, "回来了");
await policyEnv.watchdog.patrol({ now: laterNow });
check("activity followed by a fresh silent period ticks again (debounce is per silent period)", policyEnv.senderCalls.followedup.length === 4);
check("the fresh tick reports the new silence duration", policyEnv.senderCalls.followedup[3].content[0].text.includes("静默 11.0min"));
check("the still-silent dead target is not re-ticked (still the same silent period)", policyEnv.senderCalls.followedup.filter((message) => message.content[0].text.includes("session-dead")).length === 1);

// The interval floor: a NEW silence period is still reported at most once per
// patrol interval (§3.2.4 "去抖间隔"), so a chatty target cannot produce a
// burst of ticks.
const floorNow = laterNow + 60000;
policyEnv.eventsBySession["session-silent"] = oneShotSurface(floorNow - 11 * 60000, "又坐下了");
await policyEnv.watchdog.patrol({ now: floorNow });
check("a new silence period inside the same patrol interval waits", policyEnv.senderCalls.followedup.length === 4);
await policyEnv.watchdog.patrol({ now: laterNow + 6 * 60000 });
check("once the interval has passed, the new silence is reported", policyEnv.senderCalls.followedup.length === 5);

// --- watcher-side gates ----------------------------------------------------
const busyWatcher = watchdogEnv({ targets: { "session-silent": { events: oneShotSurface(1) } }, selfStatus: "running" });
await busyWatcher.watch.execute({ action: "register", targets: ["session-silent"] }, execFor(busyWatcher.senderAgent));
await busyWatcher.watchdog.patrol({ now: WD_NOW });
check("a running watcher is never interrupted (§3.2.3/V7)", busyWatcher.senderCalls.followedup.length === 0);

const armedWatcher = watchdogEnv({ targets: { "session-silent": { events: oneShotSurface(1) } }, selfGoal: armedGoal(4) });
await armedWatcher.watch.execute({ action: "register", targets: ["session-silent"] }, execFor(armedWatcher.senderAgent));
await armedWatcher.watchdog.patrol({ now: WD_NOW });
check("an armed-active watcher is not ticked — it has its own cadence (A1)", armedWatcher.senderCalls.followedup.length === 0);

// --- observer session gone (A4) -------------------------------------------
const goneEnv = watchdogEnv({ targets: { "session-silent": { events: oneShotSurface(1) } } });
await goneEnv.watch.execute({ action: "register", targets: ["session-silent"] }, execFor(goneEnv.senderAgent));
goneEnv.setHiddenAgent("session-self", true);
await goneEnv.watchdog.patrol({ now: WD_NOW });
check("a missing observer agent produces no tick", goneEnv.senderCalls.followedup.length === 0);
check("the missing observer is marked on the signal face", goneEnv.watchdog.deadWatchers.size === 1);
check("the registration survives a dead observer (kept until its TTL)", goneEnv.settings.namespaces.get("team-link").data.watchdogs.length === 1);
goneEnv.setHiddenAgent("session-self", false);
const goneList = await goneEnv.watch.execute({ action: "list" }, execFor(goneEnv.senderAgent));
check("the signal face reports the dead observer while the registration is kept", goneList.includes("观察者=dead") && goneList.includes("共 1 个"));
await goneEnv.watchdog.patrol({ now: WD_NOW + 60000 });
check("a returning observer resumes delivery inside the TTL", goneEnv.senderCalls.followedup.length === 1);

// --- TTL self-clean --------------------------------------------------------
const ttlEnv = watchdogEnv({ targets: { "session-armed": { events: oneShotSurface(1) } }, goals: { "session-armed": armedGoal() } });
// R2 (M2 review): the expiry assertion used to read `expiresAt > Date.now()`, a
// wall-clock race — with ttlHours 0.001 (3.6s) that comparison only flips once
// real time has passed the expiry, so a loaded box could fail a call that was
// perfectly correct. Capture the clock BEFORE registering instead: `createdAt` is
// stamped from that same clock, so `expiresAt > createdAt` plus `expiresAt >
// captured-at` proves the TTL landed in the future relative to the registration,
// with no dependency on how long the rest of the test then takes.
const ttlRegisteredAt = Date.now();
const ttlReg = await ttlEnv.watch.execute({ action: "register", targets: ["session-armed"], ttlHours: 0.001 }, execFor(ttlEnv.senderAgent));
const ttlEntry = ttlEnv.settings.namespaces.get("team-link").data.watchdogs[0];
check("a fractional TTL is accepted and reflected in the expiry", ttlReg.includes("已注册看门狗") && ttlEntry.expiresAt > ttlEntry.createdAt && ttlEntry.expiresAt > ttlRegisteredAt);
await ttlEnv.watchdog.patrol({ now: ttlEntry.expiresAt + 1 });
check("an expired registration cleans itself up (§3.2.3 TTL)", ttlEnv.settings.namespaces.get("team-link").data.watchdogs.length === 0);
const afterTtl = await ttlEnv.watch.execute({ action: "list" }, execFor(ttlEnv.senderAgent));
check("the expired registration is gone from the list", afterTtl.includes("共 0 个") && !afterTtl.includes(ttlEntry.id));

// The TTL sweep must be reachable behind every watcher gate (audit D1): the
// observer-gone / running / armed-active early returns used to run BEFORE the
// expiry check, so such a registration never cleaned itself up and its empty
// patrol timer span forever. §3.2.3 puts the sweep first.
const expiredEnv = (options) => watchdogEnv({ targets: { "session-silent": { events: oneShotSurface(1) } }, ...options });

const ttlDeadEnv = expiredEnv({});
await ttlDeadEnv.watch.execute({ action: "register", targets: ["session-silent"], ttlHours: 0.001 }, execFor(ttlDeadEnv.senderAgent));
const ttlDeadEntry = ttlDeadEnv.settings.namespaces.get("team-link").data.watchdogs[0];
ttlDeadEnv.setHiddenAgent("session-self", true);
await ttlDeadEnv.watchdog.patrol({ now: ttlDeadEntry.expiresAt + 1 });
check("an expired registration drops itself even when the observer is gone (D1)", ttlDeadEnv.settings.namespaces.get("team-link").data.watchdogs.length === 0);
check("the expired registration's patrol timer is gone with it (D1: no empty timer)", ttlDeadEnv.watchdog.timers.size === 0);
check("the expired registration produces no tick", ttlDeadEnv.senderCalls.followedup.length === 0);

const ttlRunningEnv = expiredEnv({ selfStatus: "running" });
await ttlRunningEnv.watch.execute({ action: "register", targets: ["session-silent"], ttlHours: 0.001 }, execFor(ttlRunningEnv.senderAgent));
const ttlRunningEntry = ttlRunningEnv.settings.namespaces.get("team-link").data.watchdogs[0];
await ttlRunningEnv.watchdog.patrol({ now: ttlRunningEntry.expiresAt + 1 });
check("an expired registration drops itself while the observer is running (D1)", ttlRunningEnv.settings.namespaces.get("team-link").data.watchdogs.length === 0);

const ttlArmedEnv = expiredEnv({ selfGoal: armedGoal(4) });
await ttlArmedEnv.watch.execute({ action: "register", targets: ["session-silent"], ttlHours: 0.001 }, execFor(ttlArmedEnv.senderAgent));
const ttlArmedEntry = ttlArmedEnv.settings.namespaces.get("team-link").data.watchdogs[0];
await ttlArmedEnv.watchdog.patrol({ now: ttlArmedEntry.expiresAt + 1 });
check("an expired registration drops itself while the observer is armed-active (D1)", ttlArmedEnv.settings.namespaces.get("team-link").data.watchdogs.length === 0);
check("the expiry pass delivers no tick either (sweep only, §3.2.3)", ttlArmedEnv.senderCalls.followedup.length === 0);

// --- dispose kills the timers, not the store (plugin lifecycle) ------------
const disposeEnv = watchdogEnv({ targets: { "session-silent": { events: oneShotSurface(1) } } });
check("the controller of a context is reachable through the plugin registry", disposeEnv.watchdog !== undefined && typeof disposeEnv.watchdog.patrol === "function");
const disposeReg = await disposeEnv.watch.execute({ action: "register", targets: ["session-silent"] }, execFor(disposeEnv.senderAgent));
check("registering arms exactly one patrol timer for that registration", disposeReg.includes("已注册看门狗") && disposeEnv.watchdog.timers.size === 1);
// The disposer ctx.effect holds is exactly what start() returns.
const stopPatrol = disposeEnv.watchdog.start();
check("start() (re)arms one timer per persisted registration", disposeEnv.watchdog.timers.size === 1);
await stopPatrol();
check("the effect disposer clears every patrol timer (§3.2.4 / task cleanup rule)", disposeEnv.watchdog.timers.size === 0);
await disposeEnv.watchdog.patrol({ now: WD_NOW });
check("after dispose the patrol is inert (no tick)", disposeEnv.senderCalls.followedup.length === 0);

// ---------------------------------------------------------------------------
// M2 (§3.3.1/§3.3.2): roster — writer policy, version history, retirement, mirror
// ---------------------------------------------------------------------------

const TEAM_TMP = path.join(TEST_ROOT, "team");
const TEAM_WS = path.join(TEAM_TMP, "ws");
rmSync(TEAM_TMP, { recursive: true, force: true });

/** One roster row as the user would write it in the settings UI — a path that can
 * seat a team's first coordinator by hand, and the one that can leave the role
 * vacant (a vacant coordinator refuses every session-side write, §3.3.2). A team
 * created through the tool no longer starts vacant: the creation path seeds the
 * caller (§9.2.2 创建即认领). */
function teamRow({ name = "night-shift", writer = "coordinator", current = "session-self", workspace = TEAM_WS, roles } = {}) {
	return {
		name,
		createdAt: 1_700_000_000_000,
		workspace,
		policy: { writer },
		roles: roles ?? [{
			role: "coordinator",
			current,
			pending: null,
			history: current === null ? [] : [{ session: current, from: 1_700_000_000_000, until: null }],
		}],
	};
}

/** A plugin environment whose `team-link` namespace is seeded with a roster.
 * `selfCwd` points the caller at the throwaway workspace the blackboard lives in. */
function teamEnv({ teams = [], askScript = [], omitUserQuestions = false, selfCwd = TEAM_WS, extraAgents = [], sessions = [], workspaceRegistryOptions = undefined, omitWorkspaceRegistry = false } = {}) {
	const env = setup({ sessions, useSettings: true, askScript, selfCwd, omitUserQuestions, extraAgents, workspaceRegistryOptions, omitWorkspaceRegistry });
	const ns = env.settings.namespaces.get("team-link");
	ns.data.teams = structuredClone(teams);
	return { ...env, ns, store: () => ns.data.teams };
}

/** Argument-schema violations surface as a thrown ToolArgsError, not a string. */
const rejects = async (tool, args, exec) => {
	try {
		return await tool.execute(args, exec);
	} catch (error) {
		return error;
	}
};

const teamStore = (env) => env.store();

// --- upsert-team: creation, validation, workspace capture --------------------
const createEnv = teamEnv({ teams: [] });
const createRoster = createEnv.tool("team_link_roster");
check("M2: the roster and blackboard tools are registered", ["team_link_roster", "team_link_team_read", "team_link_team_append"].every((toolName) => createEnv.tool(toolName) !== undefined));

const listEmpty = await createRoster.execute({ action: "get" }, execFor(createEnv.senderAgent));
check("roster get on an empty registry says so instead of failing", listEmpty.includes("团队注册表（共 0 个团队）") && listEmpty.includes("（无团队"));

const createOut = await createRoster.execute({ action: "upsert-team", team: "night-shift" }, execFor(createEnv.senderAgent));
check("upsert-team creates the team with the default writer policy and the caller's workspace (§3.3.1)", createOut.includes("已创建团队 night-shift") && createOut.includes("policy.writer=coordinator") && teamStore(createEnv).length === 1 && teamStore(createEnv)[0].workspace === TEAM_WS && teamStore(createEnv)[0].createdAt > 0);
check("§9.2.2 创建即认领: the creating session is seeded as the coordinator incumbent in the SAME write (canonical role shape, open tenure noted 创建者自举)", (() => {
	const created = teamStore(createEnv)[0];
	const entry = created.roles.find((candidate) => candidate.role === "coordinator");
	return created.roles.length === 1 && entry !== undefined && entry.current === "session-self" && entry.pending === null
		&& entry.history.length === 1 && entry.history[0].session === "session-self" && entry.history[0].until === null
		&& entry.history[0].note === "创建者自举" && entry.history[0].from === created.createdAt;
})());
check("§9.2.2 创建即认领: the return text says who claimed the role and no longer points the first coordinator at the settings UI", createOut.includes("coordinator 已由创建会话 session-self 认领") && !createOut.includes("首任协调者需由用户经设置 UI 指定"));
const mirrorFile = path.join(TEAM_WS, "team", "night-shift", "roster.md");
check("the roster mirror is written in the same call (§3.3.1 人可读镜像)", existsSync(mirrorFile));
const mirrorText = await readFile(mirrorFile, "utf8");
check("the mirror is readable and names the settings namespace as the source of truth", mirrorText.includes("# 团队 roster：night-shift") && mirrorText.includes("policy.writer：coordinator") && mirrorText.includes("事实源"));

const traversalName = await createRoster.execute({ action: "upsert-team", team: "night/shift" }, execFor(createEnv.senderAgent));
check("upsert-team refuses a name outside [a-z0-9-]+ (path traversal, §3.3.1)", traversalName.includes("非法") && traversalName.includes("路径穿越") && teamStore(createEnv).length === 1 && !existsSync(path.join(TEAM_WS, "team", "night")));
const dotName = await createRoster.execute({ action: "upsert-team", team: ".." }, execFor(createEnv.senderAgent));
check("upsert-team refuses a dotted name too", dotName.includes("非法") && teamStore(createEnv).length === 1);
const upperName = await createRoster.execute({ action: "upsert-team", team: "NightShift" }, execFor(createEnv.senderAgent));
check("the name charset is lowercase-only as specified", upperName.includes("非法") && teamStore(createEnv).length === 1);
const noAgentCreate = await createRoster.execute({ action: "upsert-team", team: "day-shift" }, { signal: new AbortController().signal });
check("upsert-team without a live agent is refused — the workspace must come from a real agentCwd", noAgentCreate.includes("需要可交互的活动代理") && teamStore(createEnv).length === 1);

// --- L2（真机冒烟修复轮）：镜像与新建路径都不许渲染 undefined --------------------
// 现象（真机实测）：`team_link_roster action=upsert-team` 新建的团队，它的 roster.md 里两行是
//   - 形态（mode）：undefined（闭集 sessions / agent-team；默认 sessions）
//   - Lead 会话（leadSessionId）：undefined
// 根因（本轮核实）：镜像渲染器读的是**未归一化**的团队对象，而新建那条路当时没把这两个字段
// 写进记录（既有团队走归一化读面，所以旧团队看不出来）。处置：① 渲染器永不打印 undefined
// （渲染归一化值）；② `upsert-team` 新建时**显式写入**两个默认值，让 settings 与镜像一致。
check("L2 ①: 镜像渲染器永不打印 undefined —— 一个两个形态字段都没有的团队对象（手写的 settings 行 / 新建路径归一化之前的样子）渲染出的是**归一化值** sessions ＋ 空 Lead",
	(() => {
		const bare = __testing.renderRosterMirror({ name: "bare-team", createdAt: 0, workspace: "", policy: { writer: "coordinator" }, roles: [], rotationBackup: null });
		return bare.includes(`- 形态（mode）：sessions（闭集 sessions / agent-team；默认 sessions）`) && bare.includes("- Lead 会话（leadSessionId）：（空；") && !bare.includes("undefined");
	})());
check("L2 ①（闭集外的值）: 同一渲染器对**闭集外**的形态值也按读面的规则落到默认档 —— 镜像里绝不会出现一个读面不会说的档位名",
	(() => {
		const stray = __testing.renderRosterMirror({ name: "stray-team", createdAt: 0, workspace: "", policy: { writer: "coordinator" }, roles: [], rotationBackup: null, mode: "agentTeam" });
		return stray.includes("- 形态（mode）：sessions（") && !stray.includes("agentTeam");
	})());
check("L2 ②: `upsert-team` 新建时**显式写入**两个形态字段的默认值（不是靠 schema 兜底、也不是靠读面归一化）—— 写进 settings 的团队行本身就是完整形状",
	Object.hasOwn(teamStore(createEnv)[0], "mode") && teamStore(createEnv)[0].mode === "sessions" && teamStore(createEnv)[0].leadSessionId === "");
check("L2 ②（新建路径的镜像）: 新建团队后**不经过 set-mode**，镜像里就已经是 sessions 与空 Lead —— 一个 undefined 都没有",
	mirrorText.includes(`- 形态（mode）：sessions（闭集 sessions / agent-team；默认 sessions）`) && mirrorText.includes("- Lead 会话（leadSessionId）：（空；") && !mirrorText.includes("undefined"));
const l2Get = await createRoster.execute({ action: "get", team: "night-shift" }, execFor(createEnv.senderAgent));
const l2Status = await createEnv.tool("team_link_status").execute({ team: "night-shift" }, execFor(createEnv.senderAgent));
check("L2 ★ 负相（覆盖缺口类）: 两个读面（roster get 的形态段 / 状态卡 ⑦ 段）同样**零 undefined 泄漏**，形态照出 sessions —— 它们读的是归一化后的团队行（新字段之前的团队也走这条路），所以本条在旧实现上本就绿：它是给「同类泄漏」上的护栏，**不冒充红相**",
	!l2Get.includes("undefined") && l2Get.includes("- night-shift：形态=sessions") && !l2Status.includes("undefined") && l2Status.includes("- night-shift：形态=sessions"));

// §9.2.2 同步项: the U4 「空缺 → 全拒」 semantics is expressed by a HAND-WRITTEN
// vacant row (what the settings UI produces). A tool-created team can no longer
// reach that state, so the old fixture (create a team, then write to it) would
// now assert the opposite of what it was written for.
const vacantEnv = teamEnv({ teams: [teamRow({ current: null })] });
const vacantRoster = vacantEnv.tool("team_link_roster");
const vacantSetRole = await vacantRoster.execute({ action: "set-role", team: "night-shift", role: "coordinator", session: "session-self" }, execFor(vacantEnv.senderAgent));
check("U4: set-role is refused for every session while coordinator.current is null — the settings UI is the writable path", vacantSetRole.includes("当前空缺") && vacantSetRole.includes("设置 UI") && teamStore(vacantEnv)[0].roles[0].current === null);
const vacantUpsert = await vacantRoster.execute({ action: "upsert-team", team: "night-shift" }, execFor(vacantEnv.senderAgent));
check("U4: an existing team answers upsert-team with the same writer gate", vacantUpsert.includes("当前空缺") && teamStore(vacantEnv).length === 1);
check("§9.2.2: an existing team is never re-seeded — upsert-team left the hand-written vacant row vacant", teamStore(vacantEnv)[0].roles[0].current === null && teamStore(vacantEnv)[0].roles[0].history.length === 0);

// --- U4: writer policy on a seated team -------------------------------------
const permEnv = teamEnv({ teams: [teamRow({ current: "session-self" })] });
const permRoster = permEnv.tool("team_link_roster");
const foreignExec = () => execFor(permEnv.targetAgent);
const foreignSetRole = await permRoster.execute({ action: "set-role", team: "night-shift", role: "coordinator", session: "session-target" }, foreignExec());
check("U4: a non-coordinator session cannot set-role under writer=coordinator", foreignSetRole.includes("只有现任协调者会话 session-self 可写") && teamStore(permEnv)[0].roles[0].current === "session-self");

const ownSetRole = await permRoster.execute({ action: "set-role", team: "night-shift", role: "coordinator", session: "session-target", note: "交接给夜班" }, execFor(permEnv.senderAgent));
check("U4: the incumbent coordinator session can set-role", ownSetRole.includes("已设置") && teamStore(permEnv)[0].roles[0].current === "session-target");
const history1 = teamStore(permEnv)[0].roles[0].history;
check("U4: set-role closes the previous tenure (until=now, note) and appends the new one open (§3.3.2)", history1.length === 2 && history1[0].session === "session-self" && typeof history1[0].until === "number" && history1[0].note === "交接给夜班" && history1[1].session === "session-target" && history1[1].until === null && history1[1].from >= history1[0].until && history1[1].note === undefined);
check("set-role does not migrate pairs — that is rotation's exclusive action (§3.3.2)", !ownSetRole.includes("已迁移") && permEnv.ns.data.pairs === undefined);
const staleWriter = await permRoster.execute({ action: "set-role", team: "night-shift", role: "coordinator", session: "session-self" }, execFor(permEnv.senderAgent));
check("after the hand-over the OLD incumbent can no longer write (the gate follows current)", staleWriter.includes("只有现任协调者会话 session-target 可写"));
const newWriter = await permRoster.execute({ action: "set-role", team: "night-shift", role: "coordinator", session: "session-self" }, foreignExec());
check("the new incumbent writes from its own session id", newWriter.includes("已设置") && teamStore(permEnv)[0].roles[0].current === "session-self");

const anyEnv = teamEnv({ teams: [teamRow({ writer: "any", current: "session-self" })] });
const anySetRole = await anyEnv.tool("team_link_roster").execute({ action: "set-role", team: "night-shift", role: "reviewer", session: "session-target" }, execFor(anyEnv.targetAgent));
check("U4: writer=any admits any session — and set-role creates a role that did not exist", anySetRole.includes("已设置") && teamStore(anyEnv).length === 1 && teamStore(anyEnv)[0].roles.length === 2 && teamStore(anyEnv)[0].roles[1].role === "reviewer" && teamStore(anyEnv)[0].roles[1].current === "session-target");

const idemEnv = teamEnv({ teams: [teamRow({ writer: "any", current: "session-self" })] });
await idemEnv.tool("team_link_roster").execute({ action: "set-role", team: "night-shift", role: "reviewer", session: "session-target", note: "评审岗" }, execFor(idemEnv.senderAgent));
const beforeIdempotent = structuredClone(teamStore(idemEnv)[0]);
const idemOut = await idemEnv.tool("team_link_roster").execute({ action: "upsert-team", team: "night-shift" }, execFor(idemEnv.senderAgent));
check("U4: upsert-team is idempotent — roles, history and createdAt are not reset", idemOut.includes("已存在") && idemOut.includes("幂等") && JSON.stringify(teamStore(idemEnv)[0].roles) === JSON.stringify(beforeIdempotent.roles) && teamStore(idemEnv)[0].createdAt === beforeIdempotent.createdAt && teamStore(idemEnv)[0].workspace === beforeIdempotent.workspace);
check("U4: upsert-team leaves the stored policy alone (the tool has no policy parameter)", JSON.stringify(teamStore(idemEnv)[0].policy) === JSON.stringify({ writer: "any" }));

const captureEnv = teamEnv({ teams: [teamRow({ writer: "any", workspace: "" })] });
const captureOut = await captureEnv.tool("team_link_roster").execute({ action: "upsert-team", team: "night-shift" }, execFor(captureEnv.senderAgent));
check("upsert-team captures the workspace of a settings-created team that has none yet", captureOut.includes("补记") && teamStore(captureEnv)[0].workspace === TEAM_WS);

// --- U4: retirement and its optional trust cleanup --------------------------
const retireEnv = teamEnv({ teams: [teamRow({ current: "session-self" })], askScript: ["清理"] });
retireEnv.ns.data.pairs = [{ a: "session-self", b: "session-target", createdAt: 1 }, { a: "session-child", b: "session-other", createdAt: 2 }];
retireEnv.ns.data.trustedSenders = ["session-self"];
retireEnv.ns.data.rememberTargets = ["session-self", "session-target"];
const retireRoster = retireEnv.tool("team_link_roster");
const retireForeign = await retireRoster.execute({ action: "retire", team: "night-shift", role: "coordinator" }, foreignExec());
check("U4: retire is refused for a non-coordinator session (§3.3.2 v1.3 仅现任协调者会话或用户发起)", retireForeign.includes("只有现任协调者会话 session-self 可以发起退役") && teamStore(retireEnv)[0].roles[0].current === "session-self");
const anyRetireEnv = teamEnv({ teams: [teamRow({ writer: "any", current: "session-self" })] });
const anyRetireForeign = await anyRetireEnv.tool("team_link_roster").execute({ action: "retire", team: "night-shift", role: "coordinator" }, execFor(anyRetireEnv.targetAgent));
check("retire stays with the incumbent coordinator even under writer=any (the clause names the coordinator, not the policy)", anyRetireForeign.includes("只有现任协调者会话 session-self 可以发起退役") && teamStore(anyRetireEnv)[0].roles[0].current === "session-self");
const retireOut = await retireRoster.execute({ action: "retire", team: "night-shift", role: "coordinator", note: "下班交班" }, execFor(retireEnv.senderAgent));
check("U4: retire empties current and records the retirement in the version history", retireOut.includes("已退役") && teamStore(retireEnv)[0].roles[0].current === null && teamStore(retireEnv)[0].roles[0].history.length === 1 && typeof teamStore(retireEnv)[0].roles[0].history[0].until === "number" && teamStore(retireEnv)[0].roles[0].history[0].note === "下班交班");
check("retire does not touch trust data on its own — the cleanup is the user's call", retireEnv.uq.requests.length === 1 && retireEnv.uq.requests[0].questions[0].id === "retire-cleanup" && retireEnv.uq.requests[0].agent === retireEnv.senderAgent);
const retireQuestion = retireEnv.uq.requests[0].questions[0].question;
check("the retirement dialog lists every reference to the retired session, both directions", retireQuestion.includes("session-self ↔ session-target") && !retireQuestion.includes("session-child ↔ session-other") && retireQuestion.includes("trustedSenders") && retireQuestion.includes("rememberTargets") && retireQuestion.includes("pairs"));
check("U4: confirming the dialog cleans exactly the references pointing at the retired session", retireOut.includes("已清理") && retireEnv.ns.data.pairs.length === 1 && retireEnv.ns.data.pairs[0].a === "session-child" && retireEnv.ns.data.trustedSenders.length === 0 && retireEnv.ns.data.rememberTargets.join(",") === "session-target");
check("retire leaves the role vacant and the mirror agrees", teamStore(retireEnv)[0].roles[0].current === null && (await readFile(mirrorFile, "utf8")).length > 0);

const keepEnv = teamEnv({ teams: [teamRow({ current: "session-self" })], askScript: ["保留"] });
keepEnv.ns.data.pairs = [{ a: "session-self", b: "session-target", createdAt: 1 }];
const keepOut = await keepEnv.tool("team_link_roster").execute({ action: "retire", team: "night-shift", role: "coordinator" }, execFor(keepEnv.senderAgent));
check("U4: choosing 保留 keeps every trust reference untouched", keepOut.includes("已保留") && keepEnv.ns.data.pairs.length === 1 && teamStore(keepEnv)[0].roles[0].current === null);

const noRefEnv = teamEnv({ teams: [teamRow({ current: "session-self" })] });
const noRefOut = await noRefEnv.tool("team_link_roster").execute({ action: "retire", team: "night-shift", role: "coordinator" }, execFor(noRefEnv.senderAgent));
check("with nothing pointing at the retired session there is no dialog at all", noRefEnv.uq.requests.length === 0 && noRefOut.includes("无需清理") && teamStore(noRefEnv)[0].roles[0].current === null);

const noUqEnv = teamEnv({ teams: [teamRow({ current: "session-self" })], omitUserQuestions: true });
noUqEnv.ns.data.pairs = [{ a: "session-self", b: "session-target", createdAt: 1 }];
const noUqOut = await noUqEnv.tool("team_link_roster").execute({ action: "retire", team: "night-shift", role: "coordinator" }, execFor(noUqEnv.senderAgent));
check("without the confirmation service retire still completes and reports the skipped cleanup", noUqOut.includes("确认服务（userQuestions）不可用") && noUqOut.includes("已退役") && noUqEnv.ns.data.pairs.length === 1 && teamStore(noUqEnv)[0].roles[0].current === null);

// --- R3 (M2 review): applyRetire's two error branches, purely ---------------
// Both paths were only reachable through a live retire call, so the helpers that
// decide them had no direct coverage. They are pure, so they are pinned here —
// plus one end-to-end call per branch, to prove the tool surfaces the same text.
const retireFixture = (roles) => ({ name: "night-shift", createdAt: 1, workspace: "", policy: { writer: "coordinator" }, roles });
const unknownRole = __testing.applyRetire(retireFixture([{ role: "coordinator", current: "session-self", pending: null, history: [] }]), { role: "reviewer", now: 5 });
check("R3: applyRetire refuses a role the team does not have (and returns no team)", unknownRole.error !== undefined && unknownRole.error.includes("没有角色 reviewer") && unknownRole.team === undefined);
const vacantRole = __testing.applyRetire(retireFixture([{ role: "coordinator", current: null, pending: null, history: [{ session: "session-old", from: 1, until: 4 }] }]), { role: "coordinator", now: 5 });
check("R3: applyRetire refuses an already vacant role (and returns no team)", vacantRole.error !== undefined && vacantRole.error.includes("已经空缺") && vacantRole.team === undefined);
const branchEnv = teamEnv({ teams: [teamRow({ current: "session-self" })] });
const branchRoster = branchEnv.tool("team_link_roster");
const unknownRoleOut = await branchRoster.execute({ action: "retire", team: "night-shift", role: "reviewer" }, execFor(branchEnv.senderAgent));
check("R3: the tool reports the unknown-role branch and changes nothing", unknownRoleOut.includes("退役失败：团队 night-shift 没有角色 reviewer") && teamStore(branchEnv)[0].roles[0].current === "session-self");
await branchRoster.execute({ action: "set-role", team: "night-shift", role: "reviewer", session: "session-target" }, execFor(branchEnv.senderAgent));
await branchRoster.execute({ action: "retire", team: "night-shift", role: "reviewer" }, execFor(branchEnv.senderAgent));
const vacantRetireOut = await branchRoster.execute({ action: "retire", team: "night-shift", role: "reviewer" }, execFor(branchEnv.senderAgent));
check("R3: retiring an already vacant (non-coordinator) role is refused with the vacancy text", vacantRetireOut.includes("退役失败：团队 night-shift 的角色 reviewer 已经空缺（vacant），无需退役") && teamStore(branchEnv)[0].roles.find((entry) => entry.role === "reviewer").current === null);

// --- R1 (M2 review): the retire cleanup must not roll back concurrent writes --
// The cleanup dialog is an unbounded human wait, so everything collected before
// it is a display artifact. The scripted answer below mutates the store WHILE the
// dialog is open — exactly what a second session (or the user in the settings UI)
// does — and the write-back must keep that new pair.
const raceEnv = teamEnv({
	teams: [teamRow({ current: "session-self" })],
	askScript: [async () => {
		const latest = raceEnv.ns.data.pairs;
		raceEnv.ns.data.pairs = [...latest, { a: "session-worker-a", b: "session-worker-b", createdAt: 99 }];
		return "清理";
	}],
});
raceEnv.ns.data.pairs = [{ a: "session-self", b: "session-target", createdAt: 1 }];
raceEnv.ns.data.trustedSenders = ["session-self"];
const raceOut = await raceEnv.tool("team_link_roster").execute({ action: "retire", team: "night-shift", role: "coordinator" }, execFor(raceEnv.senderAgent));
check("R1: a pair created while the dialog was open survives the cleanup (no read-modify-write rollback)", raceEnv.ns.data.pairs.length === 1 && raceEnv.ns.data.pairs[0].a === "session-worker-a" && raceEnv.ns.data.pairs[0].createdAt === 99);
check("R1: the references the dialog actually listed are gone", raceOut.includes("已清理：1 个 pairs") && raceEnv.ns.data.trustedSenders.length === 0);
check("R1: the result states the write-back basis honestly", raceOut.includes("按最新设置视图过滤"));

// --- reads are open, detail carries the version history ---------------------
const detailEnv = teamEnv({ teams: [teamRow({ current: "session-self" })] });
await detailEnv.tool("team_link_roster").execute({ action: "set-role", team: "night-shift", role: "reviewer", session: "session-target", note: "评审岗" }, execFor(detailEnv.senderAgent));
const detailOut = await detailEnv.tool("team_link_roster").execute({ action: "get", team: "night-shift" }, foreignExec());
check("roster get is readable by any session (the write gate does not gate reads)", detailOut.includes("角色 coordinator：现任 session-self") && detailOut.includes("角色 reviewer：现任 session-target") && detailOut.includes("评审岗") && detailOut.includes("→ 现任"));
check("the detail view reports the blackboard root", detailOut.includes(path.join(TEAM_WS, "team", "night-shift")));
const summaryOut = await detailEnv.tool("team_link_roster").execute({ action: "get" }, foreignExec());
check("roster get without a team returns the registry summary only", summaryOut.includes("团队注册表（共 1 个团队）") && !summaryOut.includes("版本史（共"));

// --- the mirror is best-effort: a failure never blocks the settings write ----
const mirrorEnv = teamEnv({ teams: [teamRow({ writer: "any", current: "session-self" })] });
const mirrorLineNote = `${"n".repeat(3)} 备注带 emoji 🔵`;
await mirrorEnv.tool("team_link_roster").execute({ action: "set-role", team: "night-shift", role: "reviewer", session: "session-target", note: mirrorLineNote }, execFor(mirrorEnv.senderAgent));
const writtenMirror = await readFile(mirrorFile, "utf8");
check("the mirror agrees with the settings source of truth (role, incumbent, note)", writtenMirror.includes("### reviewer") && writtenMirror.includes("现任：session-target") && writtenMirror.includes("🔵"));
check("the mirror is well-formed (no lone surrogate leaves the plugin)", !hasLone(writtenMirror));

const blockedRoot = path.join(TEAM_TMP, "blocked-root");
await writeFile(blockedRoot, "not a directory", "utf8");
const blockedEnv = teamEnv({ teams: [teamRow({ name: "blocked-team", writer: "any", workspace: blockedRoot })] });
const blockedMirrorOut = await blockedEnv.tool("team_link_roster").execute({ action: "set-role", team: "blocked-team", role: "reviewer", session: "session-target" }, execFor(blockedEnv.senderAgent));
check("a mirror-write failure is a warning only — the settings change still lands (§3.3.1 best-effort)", blockedMirrorOut.includes("已设置") && blockedMirrorOut.includes("镜像写入失败") && blockedMirrorOut.includes("settings 是本插件的事实源") && teamStore(blockedEnv)[0].roles.some((entry) => entry.role === "reviewer" && entry.current === "session-target"));
check("the failed mirror leaves no half-written file", !existsSync(path.join(blockedRoot, "team", "blocked-team", "roster.md")));
// ---------------------------------------------------------------------------
// M2 (§3.3.3): the team blackboard — decisions ledger + discipline lock
// ---------------------------------------------------------------------------

const boardDir = path.join(TEAM_WS, "team", "night-shift");
const decisionsPath = path.join(boardDir, "decisions.md");
const disciplinePath = path.join(boardDir, "discipline.md");
/** §9 第一批的第三个黑板文件（只追加台账）。夹具与 decisions / discipline 同构：同一
 * 个黑板目录、同一条 500 码点上限、各自独立的 seq。 */
const tasksPath = path.join(boardDir, "tasks.md");
/** Independent re-implementation of the plugin hash, so the tests check the
 * discipline lock against the file content rather than against itself. */
const hashOf = (text) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
const decisionsHashOf = (out) => {
	const start = out.indexOf("--- decisions.md");
	const end = out.indexOf("--- discipline.md");
	if (start === -1 || end === -1) return "";
	const matched = /baseHash=([0-9a-f]{16})/u.exec(out.slice(start, end));
	return matched === null ? "" : matched[1];
};
const disciplineHashOf = (out) => {
	const start = out.indexOf("--- discipline.md");
	if (start === -1) return "";
	const matched = /baseHash=([0-9a-f]{16})/u.exec(out.slice(start));
	return matched === null ? "" : matched[1];
};
/** The tasks block of a team_read result: from its header up to the raw window.
 * The 单行上限 guidance line after it belongs to the whole board, not to tasks —
 * and the raw rows below the marker are asserted separately, so the derived-view
 * assertions must not be able to match text inside them. */
const tasksBlockOf = (out) => {
	const start = out.indexOf("--- tasks.md");
	if (start === -1) return "";
	const end = out.indexOf("（原始行）", start);
	return end === -1 ? out.slice(start) : out.slice(start, end);
};
const tasksHashOf = (out) => {
	const matched = /baseHash=([0-9a-f]{16})/u.exec(tasksBlockOf(out));
	return matched === null ? "" : matched[1];
};

const boardEnv = teamEnv({ teams: [teamRow({ current: "session-self" })] });
const boardRead = boardEnv.tool("team_link_team_read");
const boardAppend = boardEnv.tool("team_link_team_append");
rmSync(decisionsPath, { force: true });
rmSync(disciplinePath, { force: true });

const freshRead = await boardRead.execute({ team: "night-shift" }, execFor(boardEnv.targetAgent));
check("team_read is open to any session and reports absent files honestly instead of failing", freshRead.includes("团队 night-shift 黑板") && freshRead.includes("（文件不存在，按空处理：0 条）") && freshRead.includes("（文件不存在，按空处理）baseHash=") && freshRead.includes("（空）"));
// 三件套（§9 第一批）之后，同一个读面给出的 baseHash 由两个变成三个 —— 这条断言量的是
// 「每个黑板文件都有自己的哈希」，不是那两个文件的文案，所以它跟着文件数一起长。
check("team_read hands back a baseHash for all three files even when they are absent (decisions · discipline · tasks)", (freshRead.match(/baseHash=[0-9a-f]{16}/gu) ?? []).length === 3 && freshRead.includes(`baseHash=${hashOf("")}`));
check("team_read carries the roster summary (writer policy + roles)", freshRead.includes("policy.writer=coordinator") && freshRead.includes("角色 coordinator：现任 session-self"));
// R4 (M2 review): decisions' baseHash is NOT a lock — the ledger is append-only
// and accepts no baseHash at all. Only discipline's hash serializes writers, so
// the tool description and the returned text both have to say which is which.
check("R4: the read tool description marks decisions' baseHash as reference/audit only", boardRead.description.includes("仅供参考/审计") && boardRead.description.includes("decisions 只追加、不接受 baseHash 参数") && boardRead.description.includes("乐观锁"));
check("R4: the returned text labels the absent decisions hash as reference/audit", freshRead.includes("（空内容哈希；仅供参考/审计）"));
check("R4: the returned text labels the absent discipline hash as the optimistic lock", freshRead.includes("（空内容哈希；乐观锁：整文件替换必须携带此值）"));

// --- decisions: append-only ledger with a plugin-assigned seq ----------------
const dec1 = await boardAppend.execute({ team: "night-shift", file: "decisions", line: "统一用 team_link_send 汇报" }, execFor(boardEnv.senderAgent));
const ledger1 = (await readFile(decisionsPath, "utf8")).trim().split("\n");
check("decisions append writes exactly the documented row (§3.3.3)", ledger1.length === 1 && /^1 \| \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \| session-self \| 统一用 team_link_send 汇报$/u.test(ledger1[0]) && dec1.includes("已追加 decisions #1"));
const dec2 = await boardAppend.execute({ team: "night-shift", file: "decisions", line: "冲突升级给协调者" }, execFor(boardEnv.targetAgent));
const ledger2 = (await readFile(decisionsPath, "utf8")).trim().split("\n");
check("decisions seq is monotonic and plugin-assigned, and any session may write it", ledger2.length === 2 && ledger2[1].startsWith("2 | ") && ledger2[1].includes("| session-target | 冲突升级给协调者") && dec2.includes("已追加 decisions #2"));
check("the ledger is append-only — the earlier row is byte-identical", ledger2[0] === ledger1[0]);

const tooLongDecision = await boardAppend.execute({ team: "night-shift", file: "decisions", line: "长".repeat(501) }, execFor(boardEnv.senderAgent));
check("a decisions line past the 500-character cap is refused and nothing is written (§4.1)", tooLongDecision.includes("超过单行上限 500") && tooLongDecision.includes("§4.1") && (await readFile(decisionsPath, "utf8")).trim().split("\n").length === 2);
const atCap = await boardAppend.execute({ team: "night-shift", file: "decisions", line: "长".repeat(500) }, execFor(boardEnv.senderAgent));
check("exactly 500 characters is accepted — the cap is inclusive", atCap.includes("已追加 decisions #3"));
const multiLine = await boardAppend.execute({ team: "night-shift", file: "decisions", line: "第一行\n第二行" }, execFor(boardEnv.senderAgent));
check("a multi-line decision is refused — the ledger is one row per line", multiLine.includes("必须单行") && (await readFile(decisionsPath, "utf8")).trim().split("\n").length === 3);
const emojiDecision = await boardAppend.execute({ team: "night-shift", file: "decisions", line: "🔵".repeat(400) }, execFor(boardEnv.senderAgent));
check("the cap counts code points, not UTF-16 units (400 astral characters = 800 units)", emojiDecision.includes("已追加 decisions #4"));

// A file whose last append was interrupted before its terminator must not merge
// the new row into the old one, and the seq still follows the file's maximum.
await writeFile(decisionsPath, "7 | 2026-01-01T00:00:00.000Z | session-other | 手工补写的行", "utf8");
const repaired = await boardAppend.execute({ team: "night-shift", file: "decisions", line: "补一行" }, execFor(boardEnv.senderAgent));
const repairedRows = (await readFile(decisionsPath, "utf8")).split("\n").filter((row) => row.trim() !== "");
check("an unterminated last row is repaired, not merged, and the seq follows the file's maximum", repaired.includes("已追加 decisions #8") && repairedRows.length === 2 && repairedRows[0].startsWith("7 | ") && repairedRows[1].startsWith("8 | "));

// --- discipline: whole-file replace behind the baseHash optimistic lock ------
const hashA = disciplineHashOf(freshRead);
const disc1 = await boardAppend.execute({ team: "night-shift", file: "discipline", line: "第一版：汇报走 team_link_send", baseHash: hashA }, execFor(boardEnv.senderAgent));
check("discipline replace with team_read's baseHash succeeds (optimistic lock)", disc1.includes("已替换 discipline.md") && (await readFile(disciplinePath, "utf8")) === "第一版：汇报走 team_link_send");
check("the result announces the new baseHash the next writer must carry", disc1.includes(`baseHash ${hashOf("第一版：汇报走 team_link_send")} →`) || disc1.includes(hashOf("第一版：汇报走 team_link_send")));
const staleDisc = await boardAppend.execute({ team: "night-shift", file: "discipline", line: "第二版（并发覆盖）", baseHash: hashA }, execFor(boardEnv.targetAgent));
check("a stale baseHash is refused, the file is untouched, and a re-read is demanded (§3.3.3 乐观锁)", staleDisc.includes("baseHash 不匹配") && staleDisc.includes("重新 team_link_team_read") && (await readFile(disciplinePath, "utf8")) === "第一版：汇报走 team_link_send");
const missingHash = await boardAppend.execute({ team: "night-shift", file: "discipline", line: "第二版" }, execFor(boardEnv.senderAgent));
check("discipline without a baseHash is refused", missingHash.includes("必须携带") && (await readFile(disciplinePath, "utf8")) === "第一版：汇报走 team_link_send");
const reread = await boardRead.execute({ team: "night-shift" }, execFor(boardEnv.senderAgent));
const hashB = disciplineHashOf(reread);
check("team_read hands back the hash of the current content after a change", hashB === hashOf("第一版：汇报走 team_link_send") && hashB !== hashA && decisionsHashOf(reread) === hashOf(await readFile(decisionsPath, "utf8")));
check("R4: with content present the decisions hash still says reference/audit, the discipline hash still says lock", reread.includes("（仅供参考/审计：decisions 只追加、不接受 baseHash 参数）") && reread.includes("baseHash=") && /baseHash=\w+（乐观锁：整文件替换必须携带此值）/u.test(reread));
const disc2 = await boardAppend.execute({ team: "night-shift", file: "discipline", line: "第二版：改由 reviewer 汇总", baseHash: hashB }, execFor(boardEnv.targetAgent));
check("a re-read followed by the fresh baseHash succeeds (the two-worker flow §3.3.3 exists for)", disc2.includes("已替换 discipline.md") && (await readFile(disciplinePath, "utf8")) === "第二版：改由 reviewer 汇总");
const longDiscipline = await boardAppend.execute({ team: "night-shift", file: "discipline", line: `短行\n${"长".repeat(501)}`, baseHash: hashOf("第二版：改由 reviewer 汇总") }, execFor(boardEnv.senderAgent));
check("discipline content carries the same per-line 500-character cap", longDiscipline.includes("第 2 行超过单行上限 500") && (await readFile(disciplinePath, "utf8")) === "第二版：改由 reviewer 汇总");
const clearDiscipline = await boardAppend.execute({ team: "night-shift", file: "discipline", line: "", baseHash: hashOf("第二版：改由 reviewer 汇总") }, execFor(boardEnv.senderAgent));
check("an empty replacement is accepted — discipline is a whole-file replace", clearDiscipline.includes("已替换 discipline.md") && (await readFile(disciplinePath, "utf8")) === "");

// --- the read window, the author field, and the guards ----------------------
const windowEnv = teamEnv({ teams: [teamRow({ writer: "any" })] });
const windowAppend = windowEnv.tool("team_link_team_append");
rmSync(decisionsPath, { force: true });
for (let n = 1; n <= 25; n += 1) {
	await windowAppend.execute({ team: "night-shift", file: "decisions", line: `第 ${n} 条裁决` }, execFor(windowEnv.targetAgent));
}
const windowOut = await windowEnv.tool("team_link_team_read").execute({ team: "night-shift" }, execFor(windowEnv.senderAgent));
check("team_read shows only the trailing 20 decisions of 25 (§3.3.3 K=20)", windowOut.includes("共 25 条，显示 20 条") && windowOut.includes("| 第 6 条裁决") && windowOut.includes("| 第 25 条裁决") && !windowOut.includes("| 第 5 条裁决"));
check("the window keeps the plugin-assigned seq visible", windowOut.includes("6 | ") && windowOut.includes("25 | "));
const anonAppend = await windowAppend.execute({ team: "night-shift", file: "decisions", line: "无会话身份的写入" }, { signal: new AbortController().signal });
check("the blackboard has no write gate: a caller without a session identity still writes, recorded honestly as author=unknown", anonAppend.includes("已追加 decisions #26") && anonAppend.includes("author=unknown") && (await readFile(decisionsPath, "utf8")).includes("| unknown | 无会话身份的写入"));

const unknownRead = await boardRead.execute({ team: "no-such-team" }, execFor(boardEnv.senderAgent));
check("team_read on an unregistered team refuses with the bootstrap hint", unknownRead.includes("不在注册表中") && unknownRead.includes("upsert-team"));
const unknownAppend = await boardAppend.execute({ team: "no-such-team", file: "decisions", line: "x" }, execFor(boardEnv.senderAgent));
check("team_append on an unregistered team refuses", unknownAppend.includes("不在注册表中"));
const badFile = await rejects(boardAppend, { team: "night-shift", file: "roster", line: "x" }, execFor(boardEnv.senderAgent));
check("the file argument is an enum — no other blackboard file can be addressed", badFile instanceof Error && badFile.message.includes("file"));
const pathFile = await rejects(boardAppend, { team: "night-shift", file: "../discipline", line: "x" }, execFor(boardEnv.senderAgent));
check("a path-shaped file argument dies on the same enum (no traversal through file)", pathFile instanceof Error && pathFile.message.includes("file") && !existsSync(path.join(TEAM_WS, "team", "discipline.md")));
const traversalTeam = await boardRead.execute({ team: "../etc" }, execFor(boardEnv.senderAgent));
check("the team name is validated before it ever reaches a path", traversalTeam.includes("非法"));

const noWsEnv = teamEnv({ teams: [teamRow({ workspace: "" })] });
const noWsRead = await noWsEnv.tool("team_link_team_read").execute({ team: "night-shift" }, execFor(noWsEnv.senderAgent));
check("a team with no captured workspace reports the blackboard unusable instead of guessing a root", noWsRead.includes("没有 workspace 记录"));
const noWsAppend = await noWsEnv.tool("team_link_team_append").execute({ team: "night-shift", file: "decisions", line: "x" }, execFor(noWsEnv.senderAgent));
check("team_append refuses the same way without a workspace root", noWsAppend.includes("没有 workspace 记录"));
// ---------------------------------------------------------------------------
// §9 (docs/team-ledger-and-mode-design-2026-09-26.md) 第一批：追加式台账 tasks.md
// —— 写面 U1–U10 / U16 / U18（本块）与读面 U11–U13 / U15 / U17 加 U14 的回归锁。
// ---------------------------------------------------------------------------

	const decisionsPristine = await readFile(decisionsPath, "utf8");
	const disciplinePristine = await readFile(disciplinePath, "utf8");
	rmSync(tasksPath, { force: true });
	const tasksText = async () => (existsSync(tasksPath) ? readFile(tasksPath, "utf8") : "");
	const tasksLines = async () => {
		const text = (await tasksText()).trim();
		return text === "" ? [] : text.split("\n");
	};

// --- U1 / U8 / U6: the whitelist takes tasks, and plan allocates the number --
	const planOne = await boardAppend.execute({ team: "night-shift", file: "tasks", kind: "plan", line: "让 worker-b 复核 §3 的行号" }, execFor(boardEnv.senderAgent));
	check("§9 U1: file=tasks is accepted — the whitelist now has three values", planOne.includes("已追加 tasks #1") && planOne.includes("task=t-1"));
	const planOneRows = await tasksLines();
	check("§9 U8: kind=plan has the plugin allocate t-<max+1> and hands that number back", planOneRows.length === 1 && /^1 \| \d{4}-\d{2}-\d{2}T[\d:.]+Z \| session-self \| plan \| t-1 \| 让 worker-b 复核 §3 的行号$/u.test(planOneRows[0]));
	check("§9 U6: the author column is the calling session id (identity is never invented)", planOneRows[0].includes("| session-self | plan |"));

// --- U2 / U3: append only, per-file seq, and a damaged line never resets it --
	const beforeU2 = await tasksText();
	const claimOne = await boardAppend.execute({ team: "night-shift", file: "tasks", kind: "claim", task: "t-1", line: "接了，预计 10 分钟" }, execFor(boardEnv.targetAgent));
	const afterU2 = await tasksText();
	check("§9 U2: the tasks ledger is append-only — the file is the old bytes plus exactly one new row", afterU2.startsWith(beforeU2) && /^2 \| \d{4}-\d{2}-\d{2}T[\d:.]+Z \| session-target \| claim \| t-1 \| 接了，预计 10 分钟\n$/u.test(afterU2.slice(beforeU2.length)));
	check("§9 U2: the earlier row is byte-identical after the append", beforeU2 === planOneRows[0] + "\n" && afterU2.slice(0, beforeU2.length) === beforeU2);
	const decisionsMaxSeq = Math.max(...(await readFile(decisionsPath, "utf8")).trim().split("\n").map((row) => Number(row.split("|")[0].trim())));
	check("§9 U3: seq counts per FILE — decisions is already at #26 while this fresh ledger starts at #1", decisionsMaxSeq === 26 && planOneRows[0].startsWith("1 | ") && claimOne.includes("已追加 tasks #2"));
	await writeFile(tasksPath, `${await tasksText()}这不是一行台账（不可解析）\n`, "utf8");
	const doneOne = await boardAppend.execute({ team: "night-shift", file: "tasks", kind: "done", task: "t-1", line: "核出 3 处错（依据 lib/index.js:3548）" }, execFor(boardEnv.targetAgent));
	check("§9 U3: an unparsable line is ignored instead of being allowed to reset the counter", doneOne.includes("已追加 tasks #3") && (await tasksLines()).length === 4);

// --- U4: the 500-code-point line cap ----------------------------------------
	const tooLongTask = await boardAppend.execute({ team: "night-shift", file: "tasks", kind: "claim", task: "t-1", line: "长".repeat(501) }, execFor(boardEnv.senderAgent));
	check("§9 U4: a body past 500 code points is refused and nothing is written", tooLongTask.includes("超过单行上限 500") && tooLongTask.includes("§4.1") && (await tasksLines()).length === 4);
	const astralTask = await boardAppend.execute({ team: "night-shift", file: "tasks", kind: "dispute", task: "t-1", line: "🔵".repeat(400) }, execFor(boardEnv.senderAgent));
	check("§9 U4: the cap counts code points — 400 astral characters (800 UTF-16 units) are accepted", astralTask.includes("已追加 tasks #4") && (await tasksLines()).length === 5);
	const exactCapTask = await boardAppend.execute({ team: "night-shift", file: "tasks", kind: "claim", task: "t-1", line: "码".repeat(500) }, execFor(boardEnv.senderAgent));
	check("§9 U4: a body of exactly 500 code points is ACCEPTED — the bound is inclusive, not exclusive", exactCapTask.includes("已追加 tasks #5") && exactCapTask.includes("本次 500 字符") && (await tasksLines()).length === 6);

// --- U5: one row per line ---------------------------------------------------
	const newlineTask = await boardAppend.execute({ team: "night-shift", file: "tasks", kind: "claim", task: "t-1", line: "第一行\n第二行" }, execFor(boardEnv.senderAgent));
	check("§9 U5: a body carrying LF is refused — the ledger is one row per line", newlineTask.includes("必须单行") && newlineTask.includes("kind | task | 正文") && (await tasksLines()).length === 6);
	const crTask = await boardAppend.execute({ team: "night-shift", file: "tasks", kind: "claim", task: "t-1", line: "第一行\r第二行" }, execFor(boardEnv.senderAgent));
	check("§9 U5: a body carrying CR is refused too", crTask.includes("必须单行") && (await tasksLines()).length === 6);
	const emptyTask = await boardAppend.execute({ team: "night-shift", file: "tasks", kind: "claim", task: "t-1", line: "   " }, execFor(boardEnv.senderAgent));
	check("§9 U5: an empty body is refused (§9.3.1 正文非空)", emptyTask.includes("不能为空") && (await tasksLines()).length === 6);

// --- U6: the author column --------------------------------------------------
	const anonTask = await boardAppend.execute({ team: "night-shift", file: "tasks", kind: "claim", task: "t-1", line: "无会话身份的写入" }, { signal: new AbortController().signal });
	const anonRows = await tasksLines();
	check("§9 U6: a caller with no session identity still writes, recorded honestly as author=unknown", anonTask.includes("author=unknown") && anonRows[anonRows.length - 1].includes("| unknown | claim | t-1 |"));
	const injectedTask = await boardAppend.execute({ team: "night-shift", file: "tasks", kind: "retract", task: "t-1", line: "撤回 #4 的第 2 处" }, execFor({ id: "weird|id\n注入" }));
	const injectedRows = await tasksLines();
	check("§9 U6: a session id carrying | or a newline is flattened to _ so it cannot split the row", injectedTask.includes("author=weird_id_注入") && injectedRows[injectedRows.length - 1].includes("| weird_id_注入 | retract | t-1 |"));

// --- U7: the kind closed set ------------------------------------------------
	const badKind = await boardAppend.execute({ team: "night-shift", file: "tasks", kind: "finish", line: "闭集之外" }, execFor(boardEnv.senderAgent));
	check("§9 U7: a kind outside the closed set is refused AND the refusal names all six values", badKind.includes("闭集") && ["plan", "claim", "done", "block", "dispute", "retract"].every((word) => badKind.includes(word)) && (await tasksLines()).length === 8);
	const noKind = await boardAppend.execute({ team: "night-shift", file: "tasks", line: "没有 kind" }, execFor(boardEnv.senderAgent));
	check("§9 U7: a missing kind is refused the same way — the caller is told it is missing and shown the set", noKind.includes("闭集") && noKind.includes("缺失") && noKind.includes("retract") && (await tasksLines()).length === 8);

// --- U9 / U10: allocation is the plugin's; every other kind names a row ------
	const planWithTask = await boardAppend.execute({ team: "night-shift", file: "tasks", kind: "plan", task: "t-9", line: "派活" }, execFor(boardEnv.senderAgent));
	check("§9 U9: kind=plan together with a task is refused (the number is the plugin's to assign)", planWithTask.includes("由插件分配") && planWithTask.includes("不要再传 task") && (await tasksLines()).length === 8);
	const claimNoTask = await boardAppend.execute({ team: "night-shift", file: "tasks", kind: "claim", line: "缺 task" }, execFor(boardEnv.senderAgent));
	check("§9 U10: a non-plan row without a task is refused", claimNoTask.includes("非 plan 必须给 task") && (await tasksLines()).length === 8);
	const badShape = await boardAppend.execute({ team: "night-shift", file: "tasks", kind: "claim", task: "7", line: "形状非法" }, execFor(boardEnv.senderAgent));
	check("§9 U10: a task outside t-<n> is refused and the refusal gives the shape", badShape.includes("形状非法") && badShape.includes("t-<数字>") && (await tasksLines()).length === 8);
	const unregistered = await boardAppend.execute({ team: "night-shift", file: "tasks", kind: "claim", task: "t-99", line: "没登记过的号" }, execFor(boardEnv.senderAgent));
	check("§9 U10: a number never registered in THIS file is refused, and the refusal points at kind=plan", unregistered.includes("从未在本文件登记过") && unregistered.includes("kind=plan") && (await tasksLines()).length === 8);

// --- U16: the allocation scans the whole file, skipping what it cannot parse --
	await writeFile(tasksPath, `${await tasksText()}这不是一行台账（不可解析）\n99 | 2026-01-01T00:00:00.000Z | session-x | 未知kind | t-99 | 手写的坏行\n`, "utf8");
	const planAfterGarbage = await boardAppend.execute({ team: "night-shift", file: "tasks", kind: "plan", line: "掺了坏行之后派的新活" }, execFor(boardEnv.senderAgent));
	const garbageRows = await tasksLines();
	check("§9 U16: with unparsable rows present the allocation is still the highest REGISTERED number + 1", planAfterGarbage.includes("task=t-2") && garbageRows[garbageRows.length - 1].includes("| plan | t-2 |"));
	const garbageRegistered = await boardAppend.execute({ team: "night-shift", file: "tasks", kind: "claim", task: "t-99", line: "坏行里的号不算登记" }, execFor(boardEnv.senderAgent));
	check("§9 U16: a number that only appears inside an unparsable row is NOT registered", garbageRegistered.includes("从未在本文件登记过"));

// --- D9: the allocation path only accepts SAFE integers ----------------------
	// A hand-written 22-digit task number still satisfies `^t-\d+$` and is therefore a
	// REGISTERED number, but `Number` reads it as 1e22 ⇒ `Number.isFinite` stayed true and
	// the old allocation wrote `t-1e+22` — a row this file's own parser then rejects. The
	// fix is to refuse with the reason (never clamp): the file is left byte-identical.
	const d9Before = await tasksText();
	const d9Handwritten = "12345678901234567890 | 2026-01-01T00:00:00.000Z | session-x | plan | t-12345678901234567890 | 手写的超长任务号";
	await writeFile(tasksPath, `${d9Before}${d9Handwritten}\n`, "utf8");
	const d9Refusal = await boardAppend.execute({ team: "night-shift", file: "tasks", kind: "plan", line: "超号之后派的新活" }, execFor(boardEnv.senderAgent));
	check("§9 D9: a task number past the safe-integer range makes kind=plan refuse — with the offending id named, zero writes, and no silent clamp", d9Refusal.includes("分配被拒绝") && d9Refusal.includes("安全整数") && d9Refusal.includes("t-12345678901234567890") && (await tasksText()) === `${d9Before}${d9Handwritten}\n`);
	await writeFile(tasksPath, d9Before, "utf8");
	const d9Recovered = await boardAppend.execute({ team: "night-shift", file: "tasks", kind: "plan", line: "修掉那一行之后派的新活" }, execFor(boardEnv.senderAgent));
	check("§9 D9: ... and with that row gone the very same allocation succeeds again (the refusal was caused by the row, not by a broken fixture)", d9Recovered.includes("已追加 tasks #") && d9Recovered.includes("task=t-3，"));

// --- U18: kind / task handed to the other two files -------------------------
	const decisionsBeforeMisuse = await readFile(decisionsPath, "utf8");
	const misuseDecisions = await boardAppend.execute({ team: "night-shift", file: "decisions", line: "参数误用", kind: "done" }, execFor(boardEnv.senderAgent));
	check("§9 U18: kind with file=decisions is refused and the decisions ledger gets zero writes", misuseDecisions.includes("只对 file=tasks 生效") && misuseDecisions.includes("file=decisions") && (await readFile(decisionsPath, "utf8")) === decisionsBeforeMisuse);
	const disciplineBeforeMisuse = await readFile(disciplinePath, "utf8");
	const misuseDiscipline = await boardAppend.execute({ team: "night-shift", file: "discipline", line: "参数误用", baseHash: hashOf(disciplineBeforeMisuse), task: "t-1" }, execFor(boardEnv.senderAgent));
	check("§9 U18: task with file=discipline is refused and the discipline file gets zero writes", misuseDiscipline.includes("只对 file=tasks 生效") && (await readFile(disciplinePath, "utf8")) === disciplineBeforeMisuse);
	const misuseTaskDecisions = await boardAppend.execute({ team: "night-shift", file: "decisions", line: "参数误用", task: "t-1" }, execFor(boardEnv.senderAgent));
	check("§9 U18: task with file=decisions is refused and the decisions ledger gets zero writes", misuseTaskDecisions.includes("只对 file=tasks 生效") && misuseTaskDecisions.includes("file=decisions") && (await readFile(decisionsPath, "utf8")) === decisionsBeforeMisuse);
	const misuseKindDiscipline = await boardAppend.execute({ team: "night-shift", file: "discipline", line: "参数误用", baseHash: hashOf(disciplineBeforeMisuse), kind: "plan" }, execFor(boardEnv.senderAgent));
	check("§9 U18: kind with file=discipline is refused and the discipline file gets zero writes", misuseKindDiscipline.includes("只对 file=tasks 生效") && misuseKindDiscipline.includes("file=discipline") && (await readFile(disciplinePath, "utf8")) === disciplineBeforeMisuse);
	check("§9 U18: all four combinations are covered — {kind, task} × {decisions, discipline}, every one of them zero-write", [misuseDecisions, misuseTaskDecisions, misuseDiscipline, misuseKindDiscipline].every((out) => out.includes("只对 file=tasks 生效")) && (await readFile(decisionsPath, "utf8")) === decisionsBeforeMisuse && (await readFile(disciplinePath, "utf8")) === disciplineBeforeMisuse);

// --- U1 negatives: the file argument is still an enum, never a path ---------
	const pathTaskFile = await rejects(boardAppend, { team: "night-shift", file: "tasks.md", kind: "plan", line: "x" }, execFor(boardEnv.senderAgent));
	check("§9 U1: a path-shaped file argument dies on the enum — tasks.md is not addressable as a path", pathTaskFile instanceof Error && pathTaskFile.message.includes("file"));
	const traversalTaskFile = await rejects(boardAppend, { team: "night-shift", file: "../tasks", kind: "plan", line: "x" }, execFor(boardEnv.senderAgent));
	check("§9 U1: ../tasks dies on the same enum (no traversal through file)", traversalTaskFile instanceof Error && traversalTaskFile.message.includes("file"));
// --- U11: the read face — the absent file first ------------------------------
	rmSync(tasksPath, { force: true });
	const tasksAbsentRead = await boardRead.execute({ team: "night-shift" }, execFor(boardEnv.senderAgent));
	check("§9 U11: with no tasks file the read face says so honestly instead of failing", tasksAbsentRead.includes("--- tasks.md（只追加台账；显示末 20 条）---") && tasksAbsentRead.includes("（文件不存在，按空处理：0 行）"));
	check("§9 U11: an absent tasks file still hands back its hash, marked append-only (no baseHash parameter)", tasksHashOf(tasksAbsentRead) === hashOf("") && tasksAbsentRead.includes("（空内容哈希；仅供参考/审计：tasks 只追加、不接受 baseHash 参数）"));
	check("§9 U11: the derived view announces itself as a reading, and is empty when there are no rows", tasksAbsentRead.includes("（派生读数：扫描最近 500 行；逐任务给「最后主张」与「未消解存疑」——是读数，不是裁决）") && tasksAbsentRead.includes("（无任务行）") && tasksAbsentRead.includes("（原始行）"));

// §9.3.3 / §9.3.4 的样例台账，全程走真工具：t-1 有接活、有完成主张、有存疑、有撤回；
// t-2 的存疑没人消解；t-3 只登记过；t-4 的存疑被后一条主张消解。
	const ledgerPlan = (line) => boardAppend.execute({ team: "night-shift", file: "tasks", kind: "plan", line }, execFor(boardEnv.senderAgent));
	const ledgerRow = (kind, task, line, agent) => boardAppend.execute({ team: "night-shift", file: "tasks", kind, task, line }, execFor(agent));
	await ledgerPlan("让 worker-b 复核 §3 的行号");
	await ledgerRow("claim", "t-1", "接了，预计 10 分钟", boardEnv.targetAgent);
	await ledgerRow("done", "t-1", "核出 3 处错（依据 lib/index.js:3548）", boardEnv.targetAgent);
	await ledgerRow("dispute", "t-1", "对 #3 存疑：第 2 处我读到的行号不同", boardEnv.senderAgent);
	await ledgerRow("retract", "t-1", "撤回 #3 的第 2 处：是我读数窗口旧了", boardEnv.senderAgent);
	await ledgerPlan("让 reviewer 复核 README");
	await ledgerRow("claim", "t-2", "接了", boardEnv.targetAgent);
	await ledgerRow("dispute", "t-2", "对 #7 存疑：没看到证据", boardEnv.senderAgent);
	await ledgerPlan("待派：整理 CHANGELOG");
	await ledgerPlan("让 worker-b 复核 §9");
	await ledgerRow("claim", "t-4", "接了", boardEnv.targetAgent);
	await ledgerRow("dispute", "t-4", "存疑：范围不对", boardEnv.senderAgent);
	await ledgerRow("block", "t-4", "卡在缺授权", boardEnv.targetAgent);

	const tasksRead = await boardRead.execute({ team: "night-shift" }, execFor(boardEnv.senderAgent));
	const ledgerRows = (await readFile(tasksPath, "utf8")).trim().split("\n");
	const ledgerBlock = tasksBlockOf(tasksRead);
	// L1（真机冒烟修复轮）：派生视图的时间戳是**本地时基**，与本屏末尾「（读数 …）」同一套
	// 本地格式化 —— 期望值因此必须从行里**那个瞬间**独立算出来（本地墙钟），而不是把插件
	// 同样会切的那条 ISO 串再切一遍：后者的期望值与实现同一个来源，任何时基改动都测不出来。
	const localMinute = (value) => {
		const at = new Date(value);
		const pad = (n) => String(n).padStart(2, "0");
		return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
	};
	const stampOfRow = (row) => localMinute(row.split("|")[1].trim());
	const stamp = (index) => stampOfRow(ledgerRows[index]);
	const lineOf = (block, task) => block.split("\n").find((row) => row.startsWith(`- ${task} ·`)) ?? "";

	check("§9 U11: with rows present the read face gives 共 N 行 / 显示 M 条 / baseHash", ledgerBlock.includes("共 13 行，显示 13 条 · baseHash="));
	check("§9 U11: the tasks baseHash is the hash of the file on disk (reference/audit only)", tasksHashOf(tasksRead) === hashOf(await readFile(tasksPath, "utf8")));
	check("§9 U11: the raw window prints the rows verbatim — the reading never replaces them", tasksRead.includes("（原始行）") && tasksRead.includes(ledgerRows[0]) && tasksRead.includes(ledgerRows[12]));
	check("§9 U12: 最后主张 is the LAST claim / done / block row, with that row's own author", lineOf(ledgerBlock, "t-1").includes(`最后主张 done（${stamp(2)} · session-target`));
	check("§9 U12: a task with no claim of any kind says 尚无主张（仅登记） instead of inventing one", lineOf(ledgerBlock, "t-3") === "- t-3 · 1 行 · 尚无主张（仅登记）");
	check("§9 U12: each task's row count is the number of its rows in the scanned window", ledgerBlock.includes("- t-2 · 3 行 ·") && ledgerBlock.includes("- t-4 · 4 行 ·"));
	check("§9 U12: a block is a claim too — the LAST claim row of t-4 is its block (#13), and the derived line names block rather than the earlier claim (#11)", ledgerRows[12].includes("| block | t-4 |") && lineOf(ledgerBlock, "t-4").startsWith(`- t-4 · 4 行 · 最后主张 block（${stamp(12)} · session-target`));
	check("§9 U13: a doubt with nothing after it is rendered as ⚠ 未消解存疑 and is NOT adjudicated", lineOf(ledgerBlock, "t-2") === `- t-2 · 3 行 · 最后主张 claim（${stamp(6)} · session-target）· ⚠ 未消解存疑 1 条`);
	check("§9 U13: a doubt answered by a later claim names the row that answered it — full-line equality, so the tail's own separator is pinned too", lineOf(ledgerBlock, "t-4") === `- t-4 · 4 行 · 最后主张 block（${stamp(12)} · session-target）· 存疑已由 #13 消解`);
	check("§9 U13: ... and a withdrawal counts as an answer too (t-1's doubt is settled by #5) — full-line equality", lineOf(ledgerBlock, "t-1") === `- t-1 · 5 行 · 最后主张 done（${stamp(2)} · session-target · 已由 #5 撤回 · 撤回者 session-self）· 存疑已由 #5 消解`);
	check("§9 U15: a retract does NOT erase the claim — it is still rendered, marked withdrawn, claimant kept", lineOf(ledgerBlock, "t-1").includes(`最后主张 done（${stamp(2)} · session-target · 已由 #5 撤回 · 撤回者 session-self）`));
	check("§9 U15: when the withdrawer is not the claimant BOTH ids appear on the same line", lineOf(ledgerBlock, "t-1").includes("session-target") && lineOf(ledgerBlock, "t-1").includes("撤回者 session-self"));
	check("§9 U15: the withdrawn claim survives as its own raw row — history is never rewritten", ledgerRows[2].includes("| done | t-1 |") && (await readFile(tasksPath, "utf8")).split("\n")[2] === ledgerRows[2]);
	check("§9 U12: the derived view is ordered by task number and gives every task exactly one line", ledgerBlock.split("\n").filter((row) => /^- t-\d+ · /u.test(row)).map((row) => row.slice(2, row.indexOf(" ·"))).join(",") === "t-1,t-2,t-3,t-4");
	check("§9 D1/D8: the 单行上限 guidance line enumerates all three blackboard files (the read face is not a two-file face any more)", tasksRead.includes("file=decisions 只追加") && tasksRead.includes("file=discipline 整文件替换") && tasksRead.includes("file=tasks 只追加一条主张"));

// --- D5 / D6: the sub-cases §9.3.4 rule 1–2 now define (several retracts · mixed doubts)
	// t-5: one doubt answered by a later claim AND one doubt nothing answered ⇒ the ⚠ wins.
	// t-6: two doubts, both answered ⇒ #N is the FIRST answer to the LAST settled doubt.
	// t-7: two withdrawals after one claim ⇒ the LAST one is named, and no count is printed.
	await ledgerPlan("D6 ①：同一任务同时有未消解与已消解存疑");
	await ledgerRow("claim", "t-5", "接了", boardEnv.targetAgent);
	await ledgerRow("dispute", "t-5", "对第一条主张存疑", boardEnv.senderAgent);
	await ledgerRow("done", "t-5", "声称完成（这一条消解了上面的存疑）", boardEnv.targetAgent);
	await ledgerRow("dispute", "t-5", "对第二条主张也存疑（没人回答）", boardEnv.senderAgent);
	await ledgerPlan("D6 ②：多条存疑都已消解");
	await ledgerRow("claim", "t-6", "接了", boardEnv.targetAgent);
	await ledgerRow("dispute", "t-6", "存疑甲", boardEnv.senderAgent);
	await ledgerRow("done", "t-6", "回答甲", boardEnv.targetAgent);
	await ledgerRow("dispute", "t-6", "存疑乙", boardEnv.senderAgent);
	await ledgerRow("claim", "t-6", "回答乙（这是首个应答行）", boardEnv.targetAgent);
	await ledgerRow("done", "t-6", "回答乙之后的又一条（不该被引用）", boardEnv.targetAgent);
	await ledgerPlan("D5：一条主张之后被撤回两次");
	await ledgerRow("claim", "t-7", "接了", boardEnv.targetAgent);
	await ledgerRow("retract", "t-7", "撤回自己（第一条）", boardEnv.targetAgent);
	await ledgerRow("retract", "t-7", "撤回（第二条，取的是它）", boardEnv.senderAgent);

	const d56Read = await boardRead.execute({ team: "night-shift" }, execFor(boardEnv.senderAgent));
	const d56Block = tasksBlockOf(d56Read);
	const d56Rows = (await readFile(tasksPath, "utf8")).trim().split("\n");
	const d56Stamp = (seq) => stampOfRow(d56Rows[seq - 1]);
	check("§9 D6①: with one doubt settled and one still standing the line prints ⚠ (rule 2's if-branch wins over 已由 #N 消解) and never both", d56Block.includes(`- t-5 · 5 行 · 最后主张 done（${d56Stamp(17)} · session-target）· ⚠ 未消解存疑 1 条`) && !lineOf(d56Block, "t-5").includes("存疑已由"));
	check("§9 D6②: with every doubt settled #N is the FIRST answer to the LAST settled doubt (#24) — not its second answer (#25) and not the earlier doubt's answer (#22)", d56Block.includes(`- t-6 · 7 行 · 最后主张 done（${d56Stamp(25)} · session-target）· 存疑已由 #24 消解`));
	check("§9 D5: several withdrawals name the LAST one in #N and print no count segment at all (the undeclared 「此主张后共 N 条撤回行」 is gone)", d56Block.includes(`- t-7 · 4 行 · 最后主张 claim（${d56Stamp(27)} · session-target · 已由 #29 撤回 · 撤回者 session-self）`) && !d56Block.includes("此主张后共") && !d56Block.includes("条撤回行"));
	check("§9.3.4 rule 4: the derived view never renders a claim as a fact — no 状态 wording anywhere in it", !/状态[＝=]/u.test(ledgerBlock) && !ledgerBlock.includes("已完成") && ledgerBlock.includes("最后主张"));
// --- U17: the two boundary annotations ---------------------------------------
	const bigLedger = [];
	for (let n = 1; n <= 505; n += 1) bigLedger.push(`${n} | 2026-01-01T00:00:00.000Z | session-x | plan | t-${n} | 第 ${n} 件`);
	bigLedger.push("这不是一行台账（不可解析）");
	bigLedger.push("9 | 2026-01-01T00:00:00.000Z | session-x | 未知kind | t-99 | 坏行（kind 不在闭集）");
	bigLedger.push("10 | 2026-01-01T00:00:00.000Z | session-x | done | 没有号 | 坏行（task 形状非法）");
	await writeFile(tasksPath, `${bigLedger.join("\n")}\n`, "utf8");
	const bigRead = await boardRead.execute({ team: "night-shift" }, execFor(boardEnv.senderAgent));
	const bigBlock = tasksBlockOf(bigRead);
	check("§9 U17: past the scan limit the read face states how many earlier rows took no part in the derivation", bigBlock.includes("（派生只扫描最近 500 行；更早的 8 行未参与派生）"));
	check("§9 U17: unparsable rows are counted and excluded, never silently dropped", bigBlock.includes("（3 行无法解析，未参与派生）"));
	check("§9 U17: the derivation covers only the scanned window — t-9 is in, t-8 fell outside", lineOf(bigBlock, "t-9") !== "" && lineOf(bigBlock, "t-8") === "");
	check("§9 U17: the raw window is still the last 20 rows, independent of the derivation's 500", bigRead.includes(`共 ${bigLedger.length} 行，显示 20 条`) && bigRead.includes(bigLedger[bigLedger.length - 1]));
// --- L1（真机冒烟修复轮）：派生视图的时基 --------------------------------------
// 现象（真机实测）：同屏两处时间差 8 小时 —— 派生视图写「最后主张 done（… 01:45 …）」，
// 而屏末写「（读数 … 09:45:31）」，因为前者把行里的 UTC ISO 串切了前 16 位、后者走本地
// 格式化。处置：**渲染出来的时间统一到本地时基**（派生视图改走与 `readStamp` 同一套本地
// 格式化），而**原始行**逐字保留 `toISOString()` 的 UTC 值（事实源不动）。
// 下面两条判据与机器时区无关：t-1 / t-2 两行的时间列**前 16 位完全相同**（旧实现渲染出
// 同一条串），但它们是相差 5 小时的两个瞬间（新实现必然渲染成两条串）—— 在 UTC 机器上同样
// 成立。第二行刻意用 `+05:00` 而不是本机时区 +08:00：用一个**恰好等于本机偏移**的值会让
// 那条断言在旧实现上「因为巧合而绿」，新断言就不该有这样的运气。
	const l1Rows = [
		"1 | 2026-09-27T01:45:31.010Z | session-x | plan | t-1 | 派活甲",
		"2 | 2026-09-27T01:45:31.010Z | session-x | claim | t-1 | 接活甲",
		"3 | 2026-09-27T01:45:31.010Z | session-x | plan | t-2 | 派活乙",
		"4 | 2026-09-27T01:45:31.010+05:00 | session-x | claim | t-2 | 接活乙",
		"5 | 手写的坏时间戳 | session-x | claim | t-3 | 接活丙（时间列不是日期）",
	];
	await writeFile(tasksPath, `${l1Rows.join("\n")}\n`, "utf8");
	const l1Read = await boardRead.execute({ team: "night-shift" }, execFor(boardEnv.senderAgent));
	const l1Block = tasksBlockOf(l1Read);
	/** The claim stamp rendered on one derived line — the segment between 「最后主张 <kind>（」
	 * and the following 「 · 」. */
	const l1StampOf = (task) => /最后主张 [a-z]+（(.*?) · /u.exec(lineOf(l1Block, task))?.[1] ?? "";
	check("L1: 派生视图的时间戳是**本地时基**（与本屏末尾「读数」同一套本地格式化），不是行里 UTC ISO 串的前 16 位 —— t-1 的接活瞬间（01:45:31Z）在这里读成本地墙钟", l1StampOf("t-1") === localMinute("2026-09-27T01:45:31.010Z"));
	check("L1: 同一判据在**带偏移**的时间列上照样成立 —— t-2 的接活行写着 +05:00（刻意不用本机偏移），渲染的是那一刻的瞬间；旧实现只切串，偏移被整个忽略 ⇒ 任何机器上都必红", l1StampOf("t-2") === localMinute("2026-09-27T01:45:31.010+05:00"));
	check("L1 ★ 判别钉子（与机器时区无关）：两行时间列的前 16 位一模一样，却是相差 5 小时的两个瞬间 ⇒ 渲染必须不同（旧实现：同一条串）", l1StampOf("t-1") !== "" && l1StampOf("t-1") !== l1StampOf("t-2"));
	check("L1 ★ 负相（覆盖缺口类）：时间列不是日期时**不编造时间**、也不打印 NaN 串 —— 照原样回显该列", l1StampOf("t-3") === "手写的坏时间戳");
	check("L1 ★ 负相（覆盖缺口类）：**原始行**逐字保留 UTC ISO（事实源不动）—— 本轮的时基统一只动渲染，行一个字节没动", l1Read.includes(l1Rows[1]) && l1Read.includes(l1Rows[3]) && (await readFile(tasksPath, "utf8")).includes(l1Rows[3]));
// --- U14: the regression lock ------------------------------------------------
// decisions / discipline 的行为与文案逐字不变：这一块量的是**整段返回文本**（=== 而
// 不是 includes），任何一处文案漂移都会当场变红。本批唯一被允许的文案变更（白名单
// 拒绝由两值改三值，§9.6⑤）在下面用源码级断言单独锁住 —— 它在运行期不可达（枚举
// 先拒），所以只能这么锁，而那正是 file 这一直以来的纵深防御。
	const u14Env = teamEnv({ teams: [teamRow({ writer: "any" })] });
	const u14Append = u14Env.tool("team_link_team_append");
	rmSync(decisionsPath, { force: true });
	const u14DecisionBody = "统一用 team_link_send 汇报";
	const u14Decisions = await u14Append.execute({ team: "night-shift", file: "decisions", line: u14DecisionBody }, execFor(u14Env.targetAgent));
	check("§9 U14: the decisions success text is BYTE-IDENTICAL to the pre-batch copy", u14Decisions === [
		`已追加 decisions #1（author=session-target）→ ${decisionsPath}`,
		"行格式：seq | ISO 时间 | author-session-id | 正文（seq 由插件分配、单调递增；只追加不删除）。",
		`单行上限 500 字符（本次 ${[...u14DecisionBody].length} 字符，§4.1）。`,
		].join("\n"));
	const u14DisciplineBefore = await readFile(disciplinePath, "utf8");
	const u14DisciplineBody = "第一版：汇报走 team_link_send";
	const u14Discipline = await u14Append.execute({ team: "night-shift", file: "discipline", line: u14DisciplineBody, baseHash: hashOf(u14DisciplineBefore) }, execFor(u14Env.senderAgent));
	check("§9 U14: the discipline success text is BYTE-IDENTICAL to the pre-batch copy", u14Discipline === [
		`已替换 discipline.md（author=session-self）→ ${disciplinePath}`,
		`baseHash ${hashOf(u14DisciplineBefore)} → ${hashOf(u14DisciplineBody)}（下次替换必须携带新值）。`,
		"共 1 行；单行上限 500 字符（§4.1）。",
		].join("\n"));
	const tasksSource = await readFile(fileURLToPath(new URL("./lib/index.js", import.meta.url)), "utf8");
	check("§9 U14 §9.6⑤: the whitelist refusal names all three files (the ONE copy change this batch may make)", tasksSource.includes("写入失败：file 必须是 decisions 或 discipline 或 tasks（白名单，不接受任何路径）。"));
	check("§9 U14 §9.6⑤: the two-value whitelist refusal is gone — it can only come back from lib/index.js", !tasksSource.includes("写入失败：file 必须是 decisions 或 discipline（白名单"));

// 收尾：把共享黑板还原成本节开始时的样子（两个旧文件逐字节写回、新文件删掉），后面
// 任何一节都不会观察到本批的夹具。
	await writeFile(decisionsPath, decisionsPristine, "utf8");
	await writeFile(disciplinePath, disciplinePristine, "utf8");
	rmSync(tasksPath, { force: true });

// ---------------------------------------------------------------------------
// M3 (§3.4): broadcast fan-out — one full gate pass per target
// ---------------------------------------------------------------------------

/** Roster of the M3 fixture: a seated coordinator, two live workers, and one
 * vacant role (the §3.4 no-holder path). */
const FAN_ROLES = [
	{ role: "coordinator", current: "session-self", pending: null, history: [{ session: "session-self", from: 1, until: null }] },
	{ role: "worker-a", current: "session-worker-a", pending: null, history: [{ session: "session-worker-a", from: 1, until: null }] },
	{ role: "worker-b", current: "session-worker-b", pending: null, history: [{ session: "session-worker-b", from: 1, until: null }] },
	{ role: "reviewer", current: null, pending: null, history: [] },
];
const pairSelf = (id) => ({ a: "session-self", b: id, createdAt: 1 });
/** M3 fixture: the team above plus two live worker agents that record what they
 * receive, over the settings-backed policy store. */
function fanEnv({ pairs = [], omitUserQuestions = false, askScript = [] } = {}) {
	const env = teamEnv({
		teams: [{ name: "night-shift", createdAt: 1_700_000_000_000, workspace: TEAM_WS, policy: { writer: "coordinator" }, roles: structuredClone(FAN_ROLES) }],
		askScript,
		omitUserQuestions,
		extraAgents: [{ id: "session-worker-a", status: "idle" }, { id: "session-worker-b", status: "idle" }],
	});
	env.ns.data.pairs = structuredClone(pairs);
	env.send = env.tool("team_link_send");
	env.calls = (id) => env.extraCalls.get(id);
	env.workerExec = (id) => execFor(env.agentFor(id));
	return env;
}

// --- U5 (unit): resolveTargets, the §3.4 pseudo-code ------------------------
const { resolveTargets } = __testing;
const unitTeams = [{ name: "night-shift", createdAt: 1, workspace: "", policy: { writer: "coordinator" }, roles: structuredClone(FAN_ROLES) }];
const unitWildcard = resolveTargets("team:night-shift/*", unitTeams, "session-self");
check("U5: resolveTargets passes a session id straight through (first priority)", resolveTargets("session-target", unitTeams, "session-self").rows[0].sessionId === "session-target");
check("U5: resolveTargets resolves team:<name>/<role> to the incumbent", resolveTargets("team:night-shift/worker-a", unitTeams, "session-worker-b").rows[0].sessionId === "session-worker-a");
check("U5: a vacant role returns the typed no-holder row, never [null] (评审 #7)", resolveTargets("team:night-shift/reviewer", unitTeams, undefined).rows[0].outcome === "no-holder" && resolveTargets("team:night-shift/reviewer", unitTeams, undefined).rows[0].detail === "该角色当前空缺");
check("U5: the wildcard is refused for anyone but the incumbent coordinator", resolveTargets("team:night-shift/*", unitTeams, "session-worker-a").error !== undefined && unitWildcard.error === undefined);
check("U5: the wildcard expands to the filled roles only, minus the caller", unitWildcard.rows.length === 2 && unitWildcard.rows.every((row) => row.sessionId === "session-worker-a" || row.sessionId === "session-worker-b"));
check("U5: the wildcard honours the live-member filter of allLiveMembers", resolveTargets("team:night-shift/*", unitTeams, "session-self", { isLive: (id) => id !== "session-worker-b" }).rows.length === 1);
check("U5: resolveTargets refuses an unknown team", resolveTargets("team:ghost/worker-a", unitTeams, "session-self").error !== undefined);
const vacantCoordinatorTeams = [{ name: "night-shift", createdAt: 1, workspace: "", policy: { writer: "coordinator" }, roles: [{ role: "coordinator", current: null, pending: null, history: [] }] }];
check("U5: a vacant coordinator refuses the wildcard even for a caller claiming the role", (resolveTargets("team:night-shift/*", vacantCoordinatorTeams, "session-self").error ?? "").includes("空缺"));

// --- U5 (tool): the wildcard gate, per-target gates, bounds, dedupe --------
const wildEnv = fanEnv();
const workerWildcard = await wildEnv.send.execute({ targets: ["team:night-shift/*"], message: "全队通知" }, wildEnv.workerExec("session-worker-a"));
check("U5: a worker's team-wide broadcast is refused", workerWildcard.includes("全队广播被拒绝") && workerWildcard.includes("现任协调者会话"));
check("U5: the refusal carries the §5.3 curation argument", workerWildcard.includes("策展每个 worker 看到什么") && workerWildcard.includes("flash worker 最稀缺的资源是上下文") && workerWildcard.includes("§5.3"));
check("U5: a refused wildcard delivers nothing at all — fail-closed, no partial fan-out", wildEnv.calls("session-worker-a").followedup.length === 0 && wildEnv.calls("session-worker-b").followedup.length === 0);
const bareTeamExpr = await wildEnv.send.execute({ targets: ["team:night-shift"], message: "x" }, execFor(wildEnv.senderAgent));
check("U5: a bare team: expression is a malformed address, not a session id", bareTeamExpr.includes("寻址表达式 team:night-shift 非法"));
const ghostTeam = await wildEnv.send.execute({ targets: ["team:no-such-team/worker-a"], message: "x" }, execFor(wildEnv.senderAgent));
check("U5: an unregistered team refuses the whole call with a readable error", ghostTeam.includes("发送失败") && ghostTeam.includes("不在注册表中") && ghostTeam.includes("upsert-team"));

const fanA = fanEnv({ pairs: [pairSelf("session-worker-a"), pairSelf("session-worker-b")] });
const fanOut = await fanA.send.execute({ targets: ["team:night-shift/*"], message: "全队通知：接口地址已切到 v2" }, execFor(fanA.senderAgent));
check("U5: the incumbent coordinator's wildcard reaches every filled live role", fanA.calls("session-worker-a").followedup.length === 1 && fanA.calls("session-worker-b").followedup.length === 1);
check("U5: the wildcard skips the vacant role and the caller, so the fan-out is exactly two targets", fanOut.includes("广播 fan-out：2 个目标") && !fanOut.includes("reviewer"));
check("U5: every target gets its own row, labelled with the resolved id and its expression", fanOut.includes("- session-worker-a（via team:night-shift/*） → delivered：") && fanOut.includes("- session-worker-b（via team:night-shift/*） → delivered："));
check("U5: the report ends with the N-delivered / M-refused summary line", fanOut.includes("汇总：2 投递 / 0 拒绝。"));
check("U5: the broadcast really is the relay path — a full banner per target", fanA.calls("session-worker-a").followedup[0].content[0].text.startsWith("📨 [跨会话消息 · 来自会话 session-self") && fanA.calls("session-worker-b").followedup[0].content[0].text.includes("接口地址已切到 v2"));

const p2pEnv = fanEnv({ pairs: [{ a: "session-worker-a", b: "session-worker-b", createdAt: 1 }] });
const p2pOut = await p2pEnv.send.execute({ targets: ["team:night-shift/worker-b"], message: "点对点：请复核 A 方案" }, p2pEnv.workerExec("session-worker-a"));
check("U5: any session may address a role point-to-point", p2pOut.includes("session-worker-b（via team:night-shift/worker-b） → delivered：") && p2pEnv.calls("session-worker-b").followedup.length === 1);
check("U5: the point-to-point row is summarised too", p2pOut.includes("汇总：1 投递 / 0 拒绝。"));

const holderEnv = fanEnv();
const holderOut = await holderEnv.send.execute({ targets: ["team:night-shift/reviewer", "team:night-shift/ghost"], message: "x" }, execFor(holderEnv.senderAgent));
check("U5: a vacant role returns the typed no-holder result", holderOut.includes("- team:night-shift/reviewer → no-holder：该角色当前空缺"));
check("U5: a role that is not in the team resolves the same way, honestly labelled", holderOut.includes("- team:night-shift/ghost → no-holder：团队 night-shift 没有角色 ghost（未注册，等同空缺）"));
check("U5: no-holder counts as neither a delivery nor a failure", holderOut.includes("汇总：0 投递 / 0 拒绝 / 2 空缺目标（no-holder，不计入投递与失败）。"));
check("U5: no-holder delivers nothing", holderEnv.calls("session-worker-a").followedup.length === 0 && holderEnv.calls("session-worker-b").followedup.length === 0);

const closedEnv = fanEnv({ omitUserQuestions: true });
const closedOut = await closedEnv.send.execute({ targets: ["session-worker-a", "session-worker-b"], message: "批量" }, execFor(closedEnv.senderAgent));
check("U5: without the confirmation service EVERY unpaired target fails closed — one row each, no batch shortcut", (closedOut.match(/→ refused：发送失败：跨会话发送需要用户批准，但确认服务（userQuestions）不可用。/gu) ?? []).length === 2);
check("U5: the fail-closed batch reports zero deliveries and delivers nothing", closedOut.includes("汇总：0 投递 / 2 拒绝。") && closedEnv.calls("session-worker-a").followedup.length === 0 && closedEnv.calls("session-worker-b").followedup.length === 0);

const mixEnv = fanEnv({ omitUserQuestions: true, pairs: [pairSelf("session-worker-a")] });
const mixOut = await mixEnv.send.execute({ targets: ["session-worker-a", "session-worker-b"], message: "半配对" }, execFor(mixEnv.senderAgent));
check("U5: one target's gates never decide another's — the paired target still gets its message", mixEnv.calls("session-worker-a").followedup.length === 1 && mixEnv.calls("session-worker-b").followedup.length === 0);
check("U5: the mixed report counts one delivery and one refusal", mixOut.includes("汇总：1 投递 / 1 拒绝。"));

const blockEnv = fanEnv({ pairs: [pairSelf("session-worker-a"), pairSelf("session-worker-b")] });
blockEnv.ns.data.blockedSenders = ["session-self"];
const blockOut = await blockEnv.send.execute({ targets: ["team:night-shift/*"], message: "全队通知" }, execFor(blockEnv.senderAgent));
check("U5: the explicit block is re-checked per target and pairs do not override it", (blockOut.match(/→ refused：未投递：目标会话已屏蔽来自当前会话的消息。/gu) ?? []).length === 2 && blockEnv.calls("session-worker-a").followedup.length === 0);
check("U5: the blocked broadcast reports zero deliveries", blockOut.includes("汇总：0 投递 / 2 拒绝。"));

const deadFanEnv = fanEnv();
const deadFanOut = await deadFanEnv.send.execute({ targets: ["session-nope"], message: "喂" }, execFor(deadFanEnv.senderAgent));
check("U5: a target with no live agent is its own row and its own summary bucket", deadFanOut.includes("- session-nope → no-agent：❌ 未投递：目标会话 session-nope 没有活动代理") && deadFanOut.includes("汇总：0 投递 / 0 拒绝 / 1 无活动代理。"));
check("U5: the no-agent row is the same self-healing refusal as the single-target one (this caller's workspace holds no other live session)", deadFanOut.includes("当前工作区无其他存活会话。") && deadFanOut.includes("请对照上列 id 核对目标 id（常见错误：转录错位）"));

// --- 生产事故：把「1 投递 / 2 拒绝」读成「已广播」 --------------------------
// A batch that lost a target OPENS with a ❌ lead, so its report can never be
// skimmed as the report of a batch that reached everyone; a batch that reached
// everyone keeps its historic shape exactly (header / rows / summary).
const firstLine = (text) => String(text).split("\n")[0];
check("fan-out 失败领先: the all-delivered report keeps its historic first line and gains no ❌", firstLine(fanOut) === "广播 fan-out：2 个目标" && !fanOut.includes("❌") && !fanOut.includes("个目标未投递"));
check("fan-out 失败领先: one delivery + one refusal leads with 1 未投递 / 1 已投递", firstLine(mixOut) === "❌ 1 个目标未投递（1 个已投递）");
check("fan-out 失败领先: a fully refused batch leads with 2 未投递 / 0 已投递", firstLine(closedOut) === "❌ 2 个目标未投递（0 个已投递）");
check("fan-out 失败领先: a dead target leads with 1 未投递 / 0 已投递", firstLine(deadFanOut) === "❌ 1 个目标未投递（0 个已投递）");
check("fan-out 失败领先: the per-target rows and the original summary still follow the lead", mixOut.includes("\n广播 fan-out：2 个目标\n") && mixOut.trimEnd().endsWith("汇总：1 投递 / 1 拒绝。"));
check("fan-out 失败领先: a no-holder target counts as 未投递 in the lead (the message did not reach it) while the summary keeps its own bucket", firstLine(holderOut) === "❌ 2 个目标未投递（0 个已投递）" && holderOut.includes("汇总：0 投递 / 0 拒绝 / 2 空缺目标（no-holder，不计入投递与失败）。"));

const nineEnv = fanEnv();
const nineOut = await nineEnv.send.execute({ targets: Array.from({ length: 9 }, (_, index) => `session-x${index}`), message: "x" }, execFor(nineEnv.senderAgent));
check("U5: more than 8 targets is refused before a single message is delivered (§4.1)", nineOut.includes("发送失败") && nineOut.includes("最多 8 个目标（本次 9 个") && nineEnv.calls("session-worker-a").followedup.length === 0);
const eightEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const eightOut = await eightEnv.send.execute({ targets: ["session-worker-a", ...Array.from({ length: 7 }, (_, index) => `session-y${index}`)], message: "x" }, execFor(eightEnv.senderAgent));
check("U5: exactly 8 targets is accepted and dead ones are reported per row", eightOut.includes("广播 fan-out：8 个目标") && eightEnv.calls("session-worker-a").followedup.length === 1 && eightOut.includes("7 无活动代理"));

const dedupEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const dedupOut = await dedupEnv.send.execute({ targets: ["session-worker-a", "session-worker-a", "team:night-shift/worker-a"], message: "去重" }, execFor(dedupEnv.senderAgent));
check("U5: duplicate targets are delivered once", dedupEnv.calls("session-worker-a").followedup.length === 1);
check("U5: the duplicates are reported in the header and in the summary", dedupOut.includes("广播 fan-out：1 个目标（重复目标已去重 2 个）") && dedupOut.includes("汇总：1 投递 / 0 拒绝 / 2 个重复目标已去重。"));

const argEnv = fanEnv();
const bothOut = await argEnv.send.execute({ targetSessionId: "session-worker-a", targets: ["session-worker-b"], message: "x" }, execFor(argEnv.senderAgent));
check("U5: targets and targetSessionId are mutually exclusive", bothOut.includes("发送失败") && bothOut.includes("互斥"));
const neitherOut = await argEnv.send.execute({ message: "x" }, execFor(argEnv.senderAgent));
check("U5: a send with no address at all is an explicit parameter error", neitherOut.includes("需要 targetSessionId") && neitherOut.includes("targets"));
check("U5: neither rejected call delivered anything", argEnv.calls("session-worker-a").followedup.length === 0 && argEnv.calls("session-worker-b").followedup.length === 0);

// ---------------------------------------------------------------------------
// M3 (§3.4): the envelope banner (V10: source stays at three members)
// ---------------------------------------------------------------------------

const metaEnv = fanEnv({ pairs: [pairSelf("session-worker-a"), pairSelf("session-worker-b")] });
const bannerLine = (id, index = 0) => metaEnv.calls(id).followedup[index].content[0].text.split("\n")[0];
await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "裁决：走 A 方案", meta: { type: "ruling", pri: "P0", ref: "slp-a1b2" } }, execFor(metaEnv.senderAgent));
check("U7: the envelope renders as the banner's first-line compact fields (§3.4 示例格式)", /^📨 \[跨会话消息 · 来自会话 session-self · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · type=ruling pri=P0 ref=slp-a1b2\]$/u.test(bannerLine("session-worker-a")));
check("U7: the envelope leaves the body and the payload alone", metaEnv.calls("session-worker-a").followedup[0].content[0].text.includes("裁决：走 A 方案") && metaEnv.calls("session-worker-a").followedup[0].content[0].text.includes("（如需回复"));
check("U7: source is still exactly the three audited members (V10 红线)", Object.keys(metaEnv.calls("session-worker-a").followedup[0].source).length === 3 && metaEnv.calls("session-worker-a").followedup[0].source.kind === "agent-message" && metaEnv.calls("session-worker-a").followedup[0].source.form === "relay");

await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "只给 pri", meta: { pri: "P2" } }, execFor(metaEnv.senderAgent));
check("U7: a partial envelope renders only the keys the caller gave", /· pri=P2\]$/u.test(bannerLine("session-worker-a", 1)) && !bannerLine("session-worker-a", 1).includes("type=") && !bannerLine("session-worker-a", 1).includes("ref="));
await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "无信封" }, execFor(metaEnv.senderAgent));
check("U7: a send without meta keeps the pre-M3 banner shape exactly", /^📨 \[跨会话消息 · 来自会话 session-self · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]$/u.test(bannerLine("session-worker-a", 2)));
const emptyMetaOut = await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "空 meta 对象", meta: {} }, execFor(metaEnv.senderAgent));
check("U7: an empty envelope object is not an error and renders no field", emptyMetaOut.includes("已投递") && /^📨 \[跨会话消息 · 来自会话 session-self · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]$/u.test(bannerLine("session-worker-a", 3)));

const longRef = "r".repeat(17);
const refOut = await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "长引用", meta: { ref: longRef } }, execFor(metaEnv.senderAgent));
check("U7: a ref past 16 characters is cut at the code-point boundary", bannerLine("session-worker-a", 4).endsWith(`ref=${"r".repeat(16)}]`) && !bannerLine("session-worker-a", 4).includes(longRef));
check("U7: the truncation is reported in the result instead of being swallowed", refOut.includes("meta.ref 超过 16 字符（原 17 字符）") && refOut.includes(`已按码点截断为「${"r".repeat(16)}」`));
const astralRefOut = await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "星面引用", meta: { ref: "🔵".repeat(17) } }, execFor(metaEnv.senderAgent));
check("U7: the ref limit counts code points, so an astral reference is never cut in half", bannerLine("session-worker-a", 5).endsWith(`ref=${"🔵".repeat(16)}]`) && !hasLone(bannerLine("session-worker-a", 5)));
check("U7: the astral truncation is reported too", astralRefOut.includes("meta.ref 超过 16 字符（原 17 字符）"));

const metaDeliveredBefore = metaEnv.calls("session-worker-a").followedup.length;
const badTypeOut = await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "x", meta: { type: "order" } }, execFor(metaEnv.senderAgent));
check("U7: an out-of-enum meta.type is an explicit parameter error", badTypeOut.includes("meta.type 非法") && badTypeOut.includes("ruling / receipt / report / ask"));
const badPriOut = await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "x", meta: { pri: "P9" } }, execFor(metaEnv.senderAgent));
check("U7: an out-of-enum meta.pri is an explicit parameter error", badPriOut.includes("meta.pri 非法") && badPriOut.includes("P0 / P1 / P2"));
const unknownKeyOut = await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "x", meta: { kind: "ruling" } }, execFor(metaEnv.senderAgent));
check("U7: an undefined meta field is refused instead of silently dropped", unknownKeyOut.includes("未定义的字段 kind"));
const badRefOut = await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "x", meta: { ref: 7 } }, execFor(metaEnv.senderAgent));
check("U7: a non-string ref is refused", badRefOut.includes("meta.ref 必须是字符串"));
const emptyRefOut = await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "x", meta: { ref: "" } }, execFor(metaEnv.senderAgent));
check("U7: an empty ref is refused rather than rendered as an empty field", emptyRefOut.includes("不能是空字符串"));
const scalarMetaOut = await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "x", meta: "ruling" }, execFor(metaEnv.senderAgent));
check("U7: a non-object meta is refused", scalarMetaOut.includes("meta 必须是对象"));
const newlineRefOut = await metaEnv.send.execute({ targetSessionId: "session-worker-a", message: "x", meta: { ref: "a\nb" } }, execFor(metaEnv.senderAgent));
check("U7: a ref carrying a newline is refused (the envelope is one line)", newlineRefOut.includes("控制字符或换行"));
check("U7: not one rejected envelope delivered anything", metaEnv.calls("session-worker-a").followedup.length === metaDeliveredBefore);

const sharedEnv = fanEnv({ pairs: [pairSelf("session-worker-a"), pairSelf("session-worker-b")] });
const sharedOut = await sharedEnv.send.execute({ targets: ["team:night-shift/*"], message: "全队裁决", meta: { type: "ruling", pri: "P1", ref: "slp-c3d4" } }, execFor(sharedEnv.senderAgent));
const sharedLines = ["session-worker-a", "session-worker-b"].map((id) => sharedEnv.calls(id).followedup[0].content[0].text.split("\n")[0]);
check("U7: one fan-out shares the same envelope across every target", sharedOut.includes("汇总：2 投递 / 0 拒绝。") && sharedLines.every((line) => line.endsWith("· type=ruling pri=P1 ref=slp-c3d4]")));
check("U7: both fan-out banners are well-formed and carry three-member sources", ["session-worker-a", "session-worker-b"].every((id) => !hasLone(sharedEnv.calls(id).followedup[0].content[0].text) && Object.keys(sharedEnv.calls(id).followedup[0].source).length === 3));

// ---------------------------------------------------------------------------
// M3 (§3.5): busy prediction on delivery
// ---------------------------------------------------------------------------

const busyMarkAt = Date.now() - 5 * 60000 - 30000; // 5.5 minutes ago → "已运行 5 分钟"
const busyEnv = setup({
	sessions: [],
	askScript: ["发送", "接收"],
	targetStatus: "running",
	eventsBySession: { "session-target": [{ type: "turn/start", seq: 1, time: busyMarkAt, data: { turn: 1 } }] },
});
const busyOut = await busyEnv.tool("team_link_send").execute({ targetSessionId: "session-target", message: "停一下，发现冲突" }, execFor(busyEnv.senderAgent));
check("§3.5: a running target's reply states how long its current turn has been running", busyOut.includes("目标回合已运行 5 分钟（steer 注入当前回合）"));
check("§3.5: ... and tells the sender how to get new-turn semantics", busyOut.includes("需新回合语义请等其空闲"));
check("§3.5: the prediction changes nothing about delivery — a running target is still steered", busyEnv.targetCalls.steered.length === 1 && busyEnv.targetCalls.followedup.length === 0);

const noMarkEnv = setup({ sessions: [], askScript: ["发送", "接收"], targetStatus: "running" });
const noMarkOut = await noMarkEnv.tool("team_link_send").execute({ targetSessionId: "session-target", message: "x" }, execFor(noMarkEnv.senderAgent));
check("§3.5: without a readable turn start the steer semantics are still stated, without a number", noMarkOut.includes("起始时间不可读（steer 注入当前回合）") && noMarkOut.includes("需新回合语义请等其空闲") && !/已运行 \d+ 分钟/u.test(noMarkOut));

const idleBusyEnv = setup({ sessions: [], askScript: ["发送", "接收"] });
const idleBusyOut = await idleBusyEnv.tool("team_link_send").execute({ targetSessionId: "session-target", message: "x" }, execFor(idleBusyEnv.senderAgent));
check("§3.5: an idle target keeps the legacy wake sentence unchanged", idleBusyOut.includes("目标空闲，已唤醒目标会话并作为新回合处理（消息与回复稍后出现在目标会话中）") && !idleBusyOut.includes("steer"));

const busyFanEnv = fanEnv({ pairs: [pairSelf("session-worker-a"), pairSelf("session-worker-b")] });
busyFanEnv.agentFor("session-worker-a").status = "running";
const busyFanOut = await busyFanEnv.send.execute({ targets: ["session-worker-a", "session-worker-b"], message: "x" }, execFor(busyFanEnv.senderAgent));
check("§3.5: inside a fan-out the running target's row carries the prediction and the idle one keeps the wake sentence", busyFanOut.includes("目标回合运行中，起始时间不可读（steer 注入当前回合）") && busyFanOut.includes("目标空闲，已唤醒目标会话"));
check("§3.5: and the fan-out still steers the running target and follows up the idle one", busyFanEnv.calls("session-worker-a").steered.length === 1 && busyFanEnv.calls("session-worker-b").followedup.length === 1);

// ---------------------------------------------------------------------------
// U13 (§10.1.2): the sender-side receipt — `output.presentationMeta`
// ---------------------------------------------------------------------------

// The two SOURCE reads the §12.5 cross-half lock below needs. `new URL(…,
// import.meta.url)` (never `import.meta.resolve`, which resolves against the
// process cwd — the ② 收口轮's own lesson) so the run reads the real files from
// any working directory.
const hostSource = await readFile(fileURLToPath(new URL("./lib/index.js", import.meta.url)), "utf8");
const clientSource = await readFile(fileURLToPath(new URL("./lib/client.js", import.meta.url)), "utf8");

/** One dispatch and its card, projected the way the Tool registry does it: the
 * body stashes the card against the frozen `exec.arguments` object and the
 * registry later calls `presentationMeta` with that SAME object (dsh-tools:
 * `tool.execute(exec.arguments, exec)` then
 * `tool.output.presentationMeta(exec.arguments, value)`). Reusing the object here
 * mirrors that identity instead of re-deriving it. */
async function sendWithCard(env, args, exec) {
	const value = await env.send.execute(args, exec);
	return { value, card: env.send.output.presentationMeta(args, value) };
}
/** Deep equality of two JSON values (key order included — a replayed log must
 *  reproduce the identical card). */
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const isCardShape = (card) => card !== null && typeof card === "object" && card.kind === "team-link-send" && card.v === 1;
const outcomesOf = (card) => card.targets.map((target) => `${target.sessionId ?? "-"}:${target.outcome}`).join(",");

const receiptEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
check("U13: team_link_send declares output.presentationMeta — the §10.1.2 carrier (pre-fix: undefined, so the sender row has no structured source at all)", typeof receiptEnv.send.output.presentationMeta === "function");
const receiptArgs = { targetSessionId: "session-worker-a", message: "裁决：走 A 方案", meta: { type: "ruling", pri: "P0", ref: "slp-a1b2" } };
const { value: receiptText, card: receiptCard } = await sendWithCard(receiptEnv, receiptArgs, execFor(receiptEnv.senderAgent));
check("U13: the model-visible text is untouched — the returned value is still one plain sentence", typeof receiptText === "string" && receiptText.startsWith("已投递到 session-worker-a") && receiptText.includes("目标空闲，已唤醒目标会话并作为新回合处理"));
check("U13: ... and output.render still snapshots it as the single text block textOutput produced (same schema, same renderer)", sameJson(receiptEnv.send.output.render(receiptArgs, receiptText), [{ type: "text", text: receiptText }]));
check("U13: the card carries the §10.1.2 discriminators and the sender identity", isCardShape(receiptCard) && receiptCard.senderSessionId === "session-self" && typeof receiptCard.at === "number" && receiptCard.at > 0 && receiptCard.fanout === false);
check("U13: a single-target receipt has exactly one target row, with the id and the delivered outcome", receiptCard.targets.length === 1 && receiptCard.targets[0].sessionId === "session-worker-a" && receiptCard.targets[0].outcome === "delivered");
// 2026-09-20 §10.1.5 修订（用户决定）+ §12.5: the A face renders the per-target
// row from the STRUCTURED fields (the `outcome` token through the client's phrase
// map, plus the §3.5 busy badge) — it no longer copies `target.detail`, so B1's
// old「卡内行 == 报告首行」string equality is RETIRED: it pinned a rendering the
// design has since replaced (`detail` stays on the card as the model-visible fact
// source and as the plain row's text, but it is not a render input for A).
//
// What replaces it is a CROSS-HALF BEHAVIOR LOCK, not another equality between
// two products of one change (§12.3 ⑤: after two facts are同源化, an equality
// between them can never go red — that is exactly what B1's assertion had become).
// The host half MINTS `targets[].outcome`; the client half must PHRASE every token
// it can mint. Both sides are read from SOURCE here — the host's mint sites and the
// client's `OUTCOME_PHRASES` literal — so adding an enum value on the host without
// giving the card a phrase is RED, and the client cannot quietly drop a token
// either (the set equality runs both ways).
//
// Extraction scope (as-of 2026-09-20, `lib/index.js` has 3 such literals):
//   - `outcome: "…"`        — direct row construction (`fanout`'s no-holder and
//     exception rows, `deliverToTarget`'s delivered return);
//   - `outcome === "…"`     — `buildSendCard`'s summary branches, which enumerate
//     the SAME token set as a decidable four-way switch — so a new bucket cannot
//     be added without landing here as well.
// BOUNDARY (honest): a token reaching `targets[].outcome` through a variable that
// appears in NO literal site is invisible to a static read. That path does not
// exist today (the delivered return carries the literal, and every other site is
// one of the two shapes above); if it ever appears, it appears as a comparison or
// a construction at the point the token is chosen.
const hostOutcomeLiterals = new Set([...hostSource.matchAll(/\boutcome[ \t]*(?::|===)[ \t]*"([^"]+)"/gu)].map((match) => match[1]));
const hostOutcomeTokens = [...hostOutcomeLiterals].sort();
const clientOutcomeMap = /const OUTCOME_PHRASES = Object\.freeze\(\{([\s\S]*?)\}\);/u.exec(clientSource);
const clientOutcomePhrases = clientOutcomeMap === null ? [] : [...clientOutcomeMap[1].matchAll(/"([^"]+)":\s*"([^"]+)"/gu)].map((match) => [match[1], match[2]]);
const clientOutcomeTokens = clientOutcomePhrases.map(([outcome]) => outcome).sort();
/** Host tokens the client has NO phrase for — the exact condition that must red. */
const unphrasedOutcomes = hostOutcomeTokens.filter((token) => !clientOutcomeTokens.includes(token));
check(`§12.5 跨半边: both halves were really read (host mints ${hostOutcomeTokens.length} literal outcome tokens, the client phrases ${clientOutcomePhrases.length})`, hostOutcomeTokens.length === 4 && clientOutcomePhrases.length === 4);
check(`§12.5 跨半边行为锁: every outcome token the host can mint has a client phrase — a new enum value without one is RED (unphrased: ${unphrasedOutcomes.length === 0 ? "none" : unphrasedOutcomes.join(",")}; host: ${hostOutcomeTokens.join(",")}; client: ${clientOutcomeTokens.join(",")})`, unphrasedOutcomes.length === 0 && hostOutcomeTokens.join(",") === "delivered,no-agent,no-holder,refused");
check("§12.5 跨半边行为锁: ... and the client phrases no token the host cannot mint — the two sets are EQUAL, so neither half can drift alone", clientOutcomeTokens.join(",") === hostOutcomeTokens.join(","));
// The retired assertion's own boundary is kept, in the form the design still holds:
// `detail` stays on the card (it is the model-visible fact source and the plain
// row's text), while a call-level envelope note is not any target's result line
// and so is not copied into a row.
check("U13: a literal session id is not an addressing expression, so the row carries no expr", receiptCard.targets[0].expr === undefined);
const notedEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const notedArgs = { targetSessionId: "session-worker-a", message: "带长引用", meta: { ref: "r".repeat(17) } };
const { value: notedText, card: notedCard } = await sendWithCard(notedEnv, notedArgs, execFor(notedEnv.senderAgent));
check("B1 边界（保留）: a truncated meta.ref appends its CALL-level note to the TEXT report only — the card's row keeps that target's own sentence", notedText.includes("注意：meta.ref 超过 16 字符（原 17 字符）") && notedCard.targets[0].detail === notedText.split("\n")[0] && !notedCard.targets[0].detail.includes("注意："));
check("B1 边界（保留）: ... and the row still CARRIES `detail` for the model-visible/fallback path, even though A no longer renders it", typeof notedCard.targets[0].detail === "string" && notedCard.targets[0].detail.length > 0 && notedCard.targets[0].detail.startsWith("已投递到 session-worker-a"));
check("B1: ... and the truncated envelope itself still rides the card", sameJson(notedCard.meta, { ref: "r".repeat(16) }));
check("U13: the summary counts the row kinds (delivered/refused/noAgent/noHolder/deduped)", sameJson(receiptCard.summary, { delivered: 1, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 }));
check("U13: the body is carried in full when it is inside the cap (chars = code points, truncated false)", !receiptCard.message.truncated && receiptCard.message.chars === [..."裁决：走 A 方案"].length && receiptCard.message.text === "裁决：走 A 方案");
check("U13: the envelope appears on the card exactly as normalized for the banner (§3.4 three keys only)", sameJson(receiptCard.meta, { type: "ruling", pri: "P0", ref: "slp-a1b2" }));

const noMetaEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const noMetaArgs = { targetSessionId: "session-worker-a", message: "无信封" };
const noMetaValue = await noMetaEnv.send.execute(noMetaArgs, execFor(noMetaEnv.senderAgent));
const noMetaCard = noMetaEnv.send.output.presentationMeta(noMetaArgs, noMetaValue);
check("U13: a send without an envelope carries no meta member at all (not an empty object)", isCardShape(noMetaCard) && !Object.prototype.hasOwnProperty.call(noMetaCard, "meta"));
const emptyMetaEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const emptyMetaArgs = { targetSessionId: "session-worker-a", message: "空信封", meta: {} };
const emptyMetaValue = await emptyMetaEnv.send.execute(emptyMetaArgs, execFor(emptyMetaEnv.senderAgent));
const emptyMetaCard = emptyMetaEnv.send.output.presentationMeta(emptyMetaArgs, emptyMetaValue);
check("U13: `meta: {}` is a legal no-op and stays one on the card (no empty meta member)", emptyMetaCard.kind === "team-link-send" && !Object.prototype.hasOwnProperty.call(emptyMetaCard, "meta"));

// --- truncation (§10.1.2 体积纪律: head 1500 + 3-code-point mark + tail 400) ---
const longTail = "尾".repeat(400);
const longBody = "头".repeat(1500) + "中".repeat(200) + longTail;
const longEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const longArgs = { targetSessionId: "session-worker-a", message: longBody };
const longValue = await longEnv.send.execute(longArgs, execFor(longEnv.senderAgent));
const longCard = longEnv.send.output.presentationMeta(longArgs, longValue);
check("U13: a body past the 2000-code-point cap is truncated and says so", longCard.message.truncated === true && longCard.message.chars === 2100);
check("U13: ... the kept text is head 1500 + the 3-code-point mark + tail 400", [...longCard.message.text].length === 1903 && longCard.message.text.startsWith("头".repeat(1500)) && longCard.message.text.slice(1500, 1503) === "..." && longCard.message.text.endsWith(longTail));
check("U13: ... and `chars` reports the ORIGINAL code-point count, not the kept one", longCard.message.chars !== [...longCard.message.text].length && longCard.message.chars === [...longBody].length);
const atCapEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const atCapArgs = { targetSessionId: "session-worker-a", message: "x".repeat(2000) };
const atCapValue = await atCapEnv.send.execute(atCapArgs, execFor(atCapEnv.senderAgent));
const atCapCard = atCapEnv.send.output.presentationMeta(atCapArgs, atCapValue);
check("U13: exactly 2000 code points is NOT truncated (the cap is inclusive)", atCapCard.message.truncated === false && atCapCard.message.chars === 2000 && atCapCard.message.text === "x".repeat(2000));
const overEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const overArgs = { targetSessionId: "session-worker-a", message: "y".repeat(2001) };
const overValue = await overEnv.send.execute(overArgs, execFor(overEnv.senderAgent));
const overCard = overEnv.send.output.presentationMeta(overArgs, overValue);
check("U13: 2001 code points IS truncated — the boundary is where §10.1.2 says it is", overCard.message.truncated === true && overCard.message.chars === 2001);
// The cut unit is the code point, and the string is repaired before it is cut, so
// an astral character straddling the boundary cannot leave half a surrogate pair
// in the log — the card IS persisted (tool/result.meta).
const astralBody = "🔵".repeat(2600);
const astralEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const astralArgs = { targetSessionId: "session-worker-a", message: astralBody };
const astralValue = await astralEnv.send.execute(astralArgs, execFor(astralEnv.senderAgent));
const astralCard = astralEnv.send.output.presentationMeta(astralArgs, astralValue);
check("U13: an astral body is cut on code points — 1500 + 3 + 400, no half pair", [...astralCard.message.text].length === 1903 && astralCard.message.chars === 2600 && !hasLone(astralCard.message.text));
const poisonedBody = "断开的\uD83D负载";
const poisonedEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const poisonedArgs = { targetSessionId: "session-worker-a", message: poisonedBody };
const poisonedValue = await poisonedEnv.send.execute(poisonedArgs, execFor(poisonedEnv.senderAgent));
const poisonedCard = poisonedEnv.send.output.presentationMeta(poisonedArgs, poisonedValue);
check("U13: a lone surrogate inherited from the argument is repaired before it can be persisted", !hasLone(poisonedCard.message.text) && poisonedCard.message.chars === [...poisonedBody].length);

// --- F2 (差异审计): every OTHER string member of the card ---------------------
// `message.text` was the only member locked above. The card is persisted at
// `tool/result.meta` and never passes `textOutput.render`, so each of its
// strings needs its own gate AND its own lock: a lone surrogate anywhere in the
// persisted meta fails the SENDER session's next model request with HTTP 400 —
// permanently (the section header above). The model-visible text of the same
// call is clean (it goes through `wellFormed` on return), which is exactly why
// these cases are about the card and nothing else.
/** The whole card as the log will hold it: every string member at once. */
const cardHasLone = (card) => hasLone(JSON.stringify(card));

// (a) a LITERAL session id: echoed straight from the caller's own argument.
const poisonIdEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const poisonId = "session-\uD800target";
const poisonIdArgs = { targetSessionId: poisonId, message: "x" };
const poisonIdValue = await poisonIdEnv.send.execute(poisonIdArgs, execFor(poisonIdEnv.senderAgent));
const poisonIdCard = poisonIdEnv.send.output.presentationMeta(poisonIdArgs, poisonIdValue);
check("F2: a lone surrogate in a literal target id is repaired on the card (pre-fix: the card carried it while the text was clean)", isCardShape(poisonIdCard) && !cardHasLone(poisonIdCard) && poisonIdCard.targets[0].sessionId === "session-\uFFFDtarget");
check("F2: ... and the model-visible text of that same call was already clean — the card was the only leaking path", !hasLone(poisonIdValue) && poisonIdValue.includes("session-\uFFFDtarget"));

// (b) an ADDRESSING EXPRESSION: reaches the card as `expr` on the no-holder path
//     (`fanout` stores the caller's expression verbatim for a row with no id).
const poisonExprEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const poisonExpr = "team:night-shift/\uD800";
const poisonExprArgs = { targets: [poisonExpr], message: "x" };
const poisonExprValue = await poisonExprEnv.send.execute(poisonExprArgs, execFor(poisonExprEnv.senderAgent));
const poisonExprCard = poisonExprEnv.send.output.presentationMeta(poisonExprArgs, poisonExprValue);
check("F2: a lone surrogate in a team:<n>/<role> expression is repaired on the card (no-holder row)", isCardShape(poisonExprCard) && !cardHasLone(poisonExprCard) && poisonExprCard.targets[0].sessionId === null && poisonExprCard.targets[0].expr === "team:night-shift/\uFFFD");
check("F2: ... while the same call's text report is clean too (both faces are gated, by different code)", !hasLone(poisonExprValue) && poisonExprCard.targets[0].outcome === "no-holder");

// (c) the envelope: `ref` is caller text, and it is NOT a control character, so
//     `readMeta`'s single-line check lets a lone surrogate through untouched.
const poisonRefEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const poisonRefArgs = { targetSessionId: "session-worker-a", message: "x", meta: { ref: "slp-\uD800" } };
const poisonRefValue = await poisonRefEnv.send.execute(poisonRefArgs, execFor(poisonRefEnv.senderAgent));
const poisonRefCard = poisonRefEnv.send.output.presentationMeta(poisonRefArgs, poisonRefValue);
check("F2: a lone surrogate in meta.ref is repaired on the card (the control-character check does not catch it)", isCardShape(poisonRefCard) && !cardHasLone(poisonRefCard) && poisonRefCard.meta.ref === "slp-\uFFFD");
check("F2: the repaired envelope keeps its other two keys and the §3.4 shape", isCardShape(poisonRefCard) && Object.keys(poisonRefCard.meta).join(",") === "ref");

// --- busy (§3.5) as a structured value -----------------------------------------
const receiptBusyEnv = setup({
	sessions: [],
	askScript: ["发送", "接收"],
	targetStatus: "running",
	eventsBySession: { "session-target": [{ type: "turn/start", seq: 1, time: busyMarkAt, data: { turn: 1 } }] },
});
const busyCardArgs = { targetSessionId: "session-target", message: "停一下" };
const busyCardValue = await receiptBusyEnv.tool("team_link_send").execute(busyCardArgs, execFor(receiptBusyEnv.senderAgent));
const busyCard = receiptBusyEnv.tool("team_link_send").output.presentationMeta(busyCardArgs, busyCardValue);
check("U13: a readable running turn becomes `{running:true, minutes}` — the same reading the sentence prints", sameJson(busyCard.targets[0].busy, { running: true, minutes: 5 }));
const idleCardEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const idleCardArgs = { targetSessionId: "session-worker-a", message: "空闲" };
const idleCardValue = await idleCardEnv.send.execute(idleCardArgs, execFor(idleCardEnv.senderAgent));
const idleCard = idleCardEnv.send.output.presentationMeta(idleCardArgs, idleCardValue);
check("U13: an idle target is `{running:false}` — a followup woke it into a NEW turn, so no minutes", sameJson(idleCard.targets[0].busy, { running: false }));
const unreadableEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
unreadableEnv.agentFor("session-worker-a").status = "running";
const unreadableArgs = { targetSessionId: "session-worker-a", message: "读不到起始时间" };
const unreadableValue = await unreadableEnv.send.execute(unreadableArgs, execFor(unreadableEnv.senderAgent));
const unreadableCard = unreadableEnv.send.output.presentationMeta(unreadableArgs, unreadableValue);
check("U13: an unreadable turn start degrades to `{running:true}` — running without a number, never a made-up one", sameJson(unreadableCard.targets[0].busy, { running: true }));

// --- refusals: a card only where a delivery stage actually ran -----------------
const noAgentEnv = fanEnv();
const noAgentArgs = { targetSessionId: "session-nope", message: "喂" };
const noAgentValue = await noAgentEnv.send.execute(noAgentArgs, execFor(noAgentEnv.senderAgent));
const noAgentCard = noAgentEnv.send.output.presentationMeta(noAgentArgs, noAgentValue);
check("U13: a no-agent single target still gets a card — the row is the refusal, and it has no busy member", isCardShape(noAgentCard) && noAgentCard.targets[0].outcome === "no-agent" && noAgentCard.targets[0].sessionId === "session-nope" && noAgentCard.targets[0].busy === undefined && noAgentCard.summary.noAgent === 1);
check("U13: the no-agent row detail is the same ❌ sentence the text report shows", noAgentCard.targets[0].detail === noAgentValue && noAgentCard.targets[0].detail.startsWith("❌ 未投递"));

const argRefuseEnv = fanEnv();
const bothArgs = { targetSessionId: "session-worker-a", targets: ["session-worker-b"], message: "x" };
const bothValue = await argRefuseEnv.send.execute(bothArgs, execFor(argRefuseEnv.senderAgent));
check("U13: 降级优先 — an argument-level refusal (mutually exclusive addresses) projects NO card, so the client falls back to the model-visible text", sameJson(argRefuseEnv.send.output.presentationMeta(bothArgs, bothValue), {}));
const noAddressArgs = { message: "x" };
const noAddressValue = await argRefuseEnv.send.execute(noAddressArgs, execFor(argRefuseEnv.senderAgent));
check("U13: ... and so does a send with no address at all", sameJson(argRefuseEnv.send.output.presentationMeta(noAddressArgs, noAddressValue), {}));
const badMetaArgs = { targetSessionId: "session-worker-a", message: "x", meta: { type: "nope" } };
const badMetaValue = await argRefuseEnv.send.execute(badMetaArgs, execFor(argRefuseEnv.senderAgent));
check("U13: ... and an invalid envelope (a parameter error, delivery never started)", sameJson(argRefuseEnv.send.output.presentationMeta(badMetaArgs, badMetaValue), {}));
const nineArgs = { targets: Array.from({ length: 9 }, (_, index) => `session-x${index}`), message: "x" };
const nineValue = await argRefuseEnv.send.execute(nineArgs, execFor(argRefuseEnv.senderAgent));
check("U13: ... and a >8 fan-out refused on the raw argument (no card, so nothing claims a receipt for zero deliveries)", sameJson(argRefuseEnv.send.output.presentationMeta(nineArgs, nineValue), {}));

// --- fan-out: one row per resolved target, ≤8, with the summary ---------------
const fanCardEnv = fanEnv({ pairs: [pairSelf("session-worker-a"), pairSelf("session-worker-b")] });
const fanCardArgs = { targets: ["team:night-shift/*"], message: "全队通知" };
const fanCardValue = await fanCardEnv.send.execute(fanCardArgs, execFor(fanCardEnv.senderAgent));
const fanCard = fanCardEnv.send.output.presentationMeta(fanCardArgs, fanCardValue);
check("U13: a fan-out receipt is flagged as one and holds one row per resolved target", isCardShape(fanCard) && fanCard.fanout === true && fanCard.targets.length === 2 && outcomesOf(fanCard) === "session-worker-a:delivered,session-worker-b:delivered");
check("U13: each fan-out row carries the addressing expression it came from", fanCard.targets.every((target) => target.expr === "team:night-shift/*"));
check("U13: every fan-out row detail is the text report's own row sentence", fanCard.targets.every((target) => fanCardValue.includes(`- ${target.sessionId}（via ${target.expr}） → ${target.outcome}：${target.detail}`)));
check("U13: the fan-out summary counts deliveries and dedupes", sameJson(fanCard.summary, { delivered: 2, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 }));
const holderCardEnv = fanEnv();
const holderCardArgs = { targets: ["team:night-shift/reviewer", "session-nope"], message: "x" };
const holderCardValue = await holderCardEnv.send.execute(holderCardArgs, execFor(holderCardEnv.senderAgent));
const holderCard = holderCardEnv.send.output.presentationMeta(holderCardArgs, holderCardValue);
check("U13: a vacant role is a row with sessionId null and the expression kept (no invented id)", holderCard.targets[0].sessionId === null && holderCard.targets[0].outcome === "no-holder" && holderCard.targets[0].expr === "team:night-shift/reviewer");
check("U13: the buckets match the text report's own summary line", holderCard.summary.noHolder === 1 && holderCard.summary.noAgent === 1 && holderCard.summary.delivered === 0 && holderCardValue.includes("汇总：0 投递 / 0 拒绝 / 1 无活动代理 / 1 空缺目标"));
const dedupCardEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const dedupCardArgs = { targets: ["session-worker-a", "session-worker-a", "team:night-shift/worker-a"], message: "去重" };
const dedupCardValue = await dedupCardEnv.send.execute(dedupCardArgs, execFor(dedupCardEnv.senderAgent));
const dedupCard = dedupCardEnv.send.output.presentationMeta(dedupCardArgs, dedupCardValue);
check("U13: deduplicated targets collapse to one row, and the dropped count is on the card", dedupCard.targets.length === 1 && dedupCard.summary.deduped === 2);
const eightCardEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const eightCardArgs = { targets: ["session-worker-a", ...Array.from({ length: 7 }, (_, index) => `session-y${index}`)], message: "x" };
const eightCardValue = await eightCardEnv.send.execute(eightCardArgs, execFor(eightCardEnv.senderAgent));
const eightCard = eightCardEnv.send.output.presentationMeta(eightCardArgs, eightCardValue);
check("U13: 8 expressions resolve to 8 rows here — the ≤8 fan-out bound counts EXPRESSIONS; the card's own ROW bound is 24 (locked in the block below)", eightCard.targets.length === 8 && !Object.prototype.hasOwnProperty.call(eightCard, "targetsTruncated"));
check("U13: the card is lossless JSON, which is what the registry requires before it persists it as tool/result.meta", sameJson(JSON.parse(JSON.stringify(holderCard)), holderCard) && sameJson(JSON.parse(JSON.stringify(fanCard)), fanCard));

// ---------------------------------------------------------------------------
// ② §10.1.5 文本重建的跨半边往返锁（DEFECT-5, 2026-09-20）
//
// The client half rebuilds a minimal card out of the model-visible text when a
// send has no `tool/result.meta` — which is every `team_link_send` issued from
// inside a `run_code` program, because the host projects `presentationMeta` for
// top-level dispatches only (`exec.parent === undefined`, dsh-tools:1191). That
// rebuild reads OUR text, so the one real risk is TEXT-SHAPE DRIFT: reword a
// renderer in `lib/index.js` and the parser silently stops placing the lines
// (the row degrades to plain text — safe, but the feature is gone and nothing
// says so).
//
// This block is the lock against exactly that, and it is deliberately CROSS-HALF:
// it runs the REAL send paths to get the REAL report text and the REAL receipt of
// the SAME call, loads the REAL browser bundle, renders both faces through the
// REAL A component, and holds the rebuilt rows equal to the structured ones. A
// rewording on either side — the host's `已投递到 …`, its `- <label> → <outcome>：`
// rows, its `广播 fan-out：` header or its `汇总：` line, or the client's parser —
// makes the two faces disagree and this block red. Nothing here is a fixture
// copied out of the other half: the text under test is produced by this file's
// own host module at run time.
// ---------------------------------------------------------------------------

/** Load the browser bundle against a stubbed loader/React/DOM (the same shape
 * `client-half.test.mjs` uses) and return the A component plus the real zh copy. */
const roundTripBundle = await readFile(fileURLToPath(new URL("./lib/client.js", import.meta.url)), "utf8");
const roundTripReact = {
	createElement(type, props, ...children) { return { type, props: props === null || props === undefined ? {} : props, children }; },
	useState(initial) { return [initial, () => {}]; },
	useCallback(fn) { return fn; },
	Fragment: Symbol("Fragment"),
};
const roundTripLoaded = { definition: null };
const roundTripRegistrations = [];
const roundTripDicts = new Map();
new Function("window", "document", roundTripBundle)(
	{
		__ModuleLoader__: { load(value) { roundTripLoaded.definition = value; } },
		location: { pathname: "/" },
		isSecureContext: false,
		setTimeout,
		open() {},
	},
	{
		querySelector() { return null; },
		createElement() { return { dataset: {}, style: {}, textContent: "", setAttribute() {}, appendChild() {} }; },
		head: { appendChild() {} },
		body: { appendChild() {}, removeChild() {} },
	},
);
const roundTripClient = roundTripLoaded.definition.factory((specifier) => {
	if (specifier === "react") return roundTripReact;
	throw new Error(`unstubbed client require: ${specifier}`);
});
roundTripClient.apply({
	effect(fn) { const disposer = fn(); return typeof disposer === "function" ? disposer : () => {}; },
	locale: { register(_namespace, lang, dict) { roundTripDicts.set(lang, dict); return () => {}; }, bind() { return (key) => key; } },
	slots: {
		inject(_name, register) { return register(); },
		register(options, component) { roundTripRegistrations.push({ options, component }); return () => {}; },
		entries() { return []; },
	},
	sessions: { list: { getSnapshot() { return { byId: {} }; } }, open() {} },
	inject(_specs, callback) { return callback({ uiConversation: { events: { register() { return () => {}; } } } }); },
});
const roundTripRowView = roundTripRegistrations.find((entry) => entry.options.name === "tool.call.toolview");
check("② 往返: the browser bundle really loaded here and exposed A's row component", roundTripRowView !== undefined && roundTripRowView.options.key === "team_link_send" && roundTripDicts.get("zh") !== undefined);

// Tree helpers, the same shape `client-half.test.mjs` uses: the React stub
// returns plain `{type, props, children}` literals, so one expansion is done for
// a function component and fragments are flattened.
function roundTripFlatten(tree) {
	if (tree === null || tree === undefined || typeof tree !== "object") return tree;
	if (Array.isArray(tree)) return tree.map(roundTripFlatten);
	if (typeof tree.type === "function") return roundTripFlatten(tree.type({ ...tree.props, children: tree.children }));
	if (tree.type === roundTripReact.Fragment) return roundTripFlatten(tree.children);
	const children = tree.children === undefined ? [] : Array.isArray(tree.children) ? tree.children.map(roundTripFlatten) : [roundTripFlatten(tree.children)];
	return { type: tree.type, props: tree.props, children };
}
function roundTripText(tree) {
	if (tree === null || tree === undefined || tree === false) return "";
	if (typeof tree === "string" || typeof tree === "number") return String(tree);
	if (Array.isArray(tree)) return tree.map(roundTripText).join("");
	if (typeof tree === "object" && tree.children !== undefined) return roundTripText(tree.children);
	return "";
}
function roundTripByClass(tree, className) {
	if (tree === null || tree === undefined || typeof tree !== "object") return null;
	if (Array.isArray(tree)) {
		for (const child of tree) {
			const hit = roundTripByClass(child, className);
			if (hit !== null) return hit;
		}
		return null;
	}
	if (tree.props !== undefined && tree.props.className === className) return tree;
	return roundTripByClass(tree.children, className);
}
const roundTripAllByClass = (tree, className) => {
	if (tree === null || tree === undefined || typeof tree !== "object") return [];
	if (Array.isArray(tree)) return tree.flatMap((child) => roundTripAllByClass(child, className));
	const here = tree.props !== undefined && tree.props.className === className ? [tree] : [];
	return [...here, ...roundTripAllByClass(tree.children, className)];
};
const roundTripZh = (key) => (Object.prototype.hasOwnProperty.call(roundTripDicts.get("zh"), key) ? roundTripDicts.get("zh")[key] : key);
/** A's face of one settled block: the REAL content the host wrote, and `meta` only
 * when the caller has a receipt — exactly the two blocks the tool row receives.
 * Expanded once through `roundTripFlatten` (the stub's `createElement` returns an
 * element, not a tree). */
const roundTripRow = (content, meta) => roundTripFlatten(roundTripRowView.component({
	callId: "call-1",
	toolName: "team_link_send",
	t: roundTripZh,
	block: {
		kind: "tool-result", seq: 1, time: 1, callId: "call-1",
		call: { name: "team_link_send", argsRaw: "{}" }, callTime: 0,
		content: [{ type: "text", text: content }], isError: false, subCalls: [],
		...meta === undefined ? {} : { meta },
	},
}));
const roundTripIsCard = (tree) => { const card = roundTripByClass(tree, "dshsl-relay dshsl-send"); return card !== null && card.props["data-slp-send"] === "row"; };
const roundTripIsPlain = (tree) => { const plain = roundTripByClass(tree, "dshsl-plain"); return plain !== null && plain.props["data-slp-send"] === "plain"; };
/** What the design's round trip is about: every target's IDENTITY and outcome
 * PHRASE, in order. The row as a whole also carries the busy badge, which our
 * text does not carry and the rebuild must not invent — so the badge is outside
 * the comparison on purpose (asserted separately, on the client half). */
const roundTripStatements = (tree) => roundTripAllByClass(tree, "dshsl-send-target").map((row) => ({
	identity: roundTripText(roundTripByClass(row, "dshsl-send-targetid")),
	outcome: roundTripText(roundTripByClass(row, "dshsl-send-outcome")),
}));
/** One target's statement, or an EMPTY record when the row is not there — so a red
 * run reports the mismatch and carries on instead of dying mid-suite (③b Y7's
 * lesson: a suite that stops before `assertion total` hides everything after it). */
const roundTripStatementAt = (tree, index) => roundTripStatements(tree)[index] ?? { identity: undefined, outcome: undefined };
const roundTripRowCount = (tree) => roundTripText(roundTripByClass(tree, "dshsl-send-rowhead"));

// Case A — one delivery to a TITLED session: the host's label is `「title」(id)`,
// so the parser has to strip both the title and the channel note to find the id.
const rtSingleEnv = fanEnv({ pairs: [pairSelf("session-target")] });
const rtSingleArgs = { targetSessionId: "session-target", message: "往返：单目标" };
const { value: rtSingleText, card: rtSingleCard } = await sendWithCard(rtSingleEnv, rtSingleArgs, execFor(rtSingleEnv.senderAgent));
const rtSingleStructured = roundTripRow(rtSingleText, rtSingleCard);
const rtSingleRebuilt = roundTripRow(rtSingleText);
check("② 往返: the REAL text of a single-target delivery renders as a card with no receipt and as a card with one", roundTripIsCard(rtSingleStructured) && roundTripIsCard(rtSingleRebuilt) && !roundTripIsPlain(rtSingleRebuilt));
check("② 往返: ... and the rebuilt target identity + phrase EQUAL the structured receipt's own row of the SAME send", sameJson(roundTripStatements(rtSingleRebuilt), roundTripStatements(rtSingleStructured)) && roundTripStatements(rtSingleRebuilt).length === 1 && rtSingleCard.targets[0].outcome === "delivered");
check("② 往返: ... the identity being the session id the host titled (the `「title」(id)` wrapper is stripped, and the host's own label is what the receipt's `sessionId` is)", roundTripStatementAt(rtSingleRebuilt, 0).identity === rtSingleCard.targets[0].sessionId && rtSingleText.startsWith("已投递到 「"));

// Case B — a MIXED fan-out (delivered / refused / no-holder) in one report: three
// buckets, the ❌ lead, and a vacant row whose label is the expression itself.
const rtMixedEnv = fanEnv({ omitUserQuestions: true, pairs: [pairSelf("session-worker-a")] });
const rtMixedArgs = { targets: ["session-worker-a", "session-worker-b", "team:night-shift/reviewer"], message: "往返：混合" };
const { value: rtMixedText, card: rtMixedCard } = await sendWithCard(rtMixedEnv, rtMixedArgs, execFor(rtMixedEnv.senderAgent));
const rtMixedRebuilt = roundTripRow(rtMixedText);
check("② 往返: the REAL text of a mixed fan-out (delivered / refused / no-holder) rebuilds into a card", roundTripIsCard(rtMixedRebuilt) && !roundTripIsPlain(rtMixedRebuilt));
check("② 往返: ... one row per target, with identities and phrases equal to the structured receipt's", sameJson(roundTripStatements(rtMixedRebuilt), roundTripStatements(roundTripRow(rtMixedText, rtMixedCard))) && rtMixedCard.targets.length === 3);
check("② 往返: ... the label stating the same target count the receipt holds", roundTripRowCount(rtMixedRebuilt) === roundTripRowCount(roundTripRow(rtMixedText, rtMixedCard)) && roundTripRowCount(rtMixedRebuilt) === `✦ 工具调用 · team_link_send · ${rtMixedCard.targets.length} 个目标`);
check("② 往返: ... and the receipt really is the mixed one this case claims (all three buckets present, the lead on)", rtMixedCard.summary.delivered === 1 && rtMixedCard.summary.refused === 1 && rtMixedCard.summary.noHolder === 1 && rtMixedText.startsWith("❌ 2 个目标未投递（1 个已投递）"));

// Case C — a `no-agent` row: its detail is a three-line paragraph with an
// indented list of its own, which must stay ONE row (the header's count is the
// cross-check that catches a parser that reads the list as more targets).
const rtDeadEnv = fanEnv();
const rtDeadArgs = { targets: ["session-nope"], message: "往返：无代理" };
const { value: rtDeadText, card: rtDeadCard } = await sendWithCard(rtDeadEnv, rtDeadArgs, execFor(rtDeadEnv.senderAgent));
const rtDeadRebuilt = roundTripRow(rtDeadText);
check("② 往返: a no-agent row's MULTI-LINE refusal paragraph still rebuilds as exactly one row", roundTripIsCard(rtDeadRebuilt) && sameJson(roundTripStatements(rtDeadRebuilt), roundTripStatements(roundTripRow(rtDeadText, rtDeadCard))) && roundTripStatements(rtDeadRebuilt).length === 1 && rtDeadCard.targets[0].outcome === "no-agent");
check("② 往返: ... and the paragraph really did span lines (the case would prove nothing otherwise)", rtDeadText.split("\n").length > 4);

// Case D — duplicates: the count lives in the header AND the summary, and the
// rebuild refuses the report unless the two agree.
const rtDedupeEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const rtDedupeArgs = { targets: ["session-worker-a", "session-worker-a", "team:night-shift/worker-a"], message: "往返：去重" };
const { value: rtDedupeText, card: rtDedupeCard } = await sendWithCard(rtDedupeEnv, rtDedupeArgs, execFor(rtDedupeEnv.senderAgent));
check("② 往返: a deduplicated report round-trips (one row, the dedupe count taken from the header and confirmed by the summary)", roundTripIsCard(roundTripRow(rtDedupeText)) && sameJson(roundTripStatements(roundTripRow(rtDedupeText)), roundTripStatements(roundTripRow(rtDedupeText, rtDedupeCard))) && rtDedupeCard.summary.deduped === 2 && rtDedupeText.includes("汇总：1 投递 / 0 拒绝 / 2 个重复目标已去重。"));

// Case E — the honest boundary. A single-target REFUSAL is real host text this
// build deliberately does NOT rebuild: our refusal sentences name no target, so a
// card would have to invent the one field the design says must not be invented
// (§10.1.5 「缺的字段不造」/「认不出的行原样显示」). It stays the plain row, verbatim.
const rtRefusedEnv = fanEnv({ omitUserQuestions: true });
const rtRefusedArgs = { targetSessionId: "session-worker-a", message: "往返：被拒" };
const rtRefusedValue = await rtRefusedEnv.send.execute(rtRefusedArgs, execFor(rtRefusedEnv.senderAgent));
const rtRefusedRebuilt = roundTripRow(rtRefusedValue);
check("③ 不伪造: a real single-target REFUSAL never becomes a card — our refusal text names no target at all", roundTripIsPlain(rtRefusedRebuilt) && !roundTripIsCard(rtRefusedRebuilt));
check("③ 不伪造: ... and the plain face shows the host's own sentence verbatim (nothing swallowed, nothing rewritten)", roundTripText(roundTripByClass(rtRefusedRebuilt, "dshsl-plain-body")) === rtRefusedValue && rtRefusedValue.startsWith("发送失败：") && !rtRefusedValue.includes("广播 fan-out"));

// The lock's own sensitivity anchor, permanent rather than a one-off mutation: if
// the host's renderers are ever reworded while the client's parser is not, the
// two faces disagree exactly like this. One space out of the row separator is
// enough — the same sentence, reworded, must LOSE the rebuild.
const driftedRow = rtMixedText.split(" → ").join(" -> ");
check("② 往返 敏感性锚点: the very same report with ONE character of drift in the row separator loses the rebuild (the lock above is not vacuous)", roundTripIsCard(roundTripRow(rtMixedText)) && roundTripIsPlain(roundTripRow(driftedRow)) && roundTripText(roundTripByClass(roundTripRow(driftedRow), "dshsl-plain-body")) === driftedRow);
check("② 往返 敏感性锚点: ... and so does a drift in the host's own delivery prefix", roundTripIsCard(rtSingleRebuilt) && roundTripIsPlain(roundTripRow(rtSingleText.replace("已投递到 ", "已投递给 "))) && roundTripIsPlain(roundTripRow(rtSingleText.replace("：目标空闲", "，目标空闲"))));

// --- U13 (§10.1.2 2026-09-19 修正): the card's ROW bound is 24, not the ≤8 -----
// The bound locked just above counts the INPUT expressions. ONE `team:<name>/*`
// is one expression and expands to every filled live member, so a legal broadcast
// can carry more rows than 8 — and the array that is persisted as
// `tool/result.meta` is the card's, which is why the ROW bound has to live here.
// Same discipline as the body's 2000/1500+3+400: 有界呈现 + 如实标注 — the cut is
// stated on the card, the summary still counts the whole set, and the
// model-visible report keeps one row per target (the card is a bounded VIEW, the
// report is the full archive).
/** The card's members BEFORE the row bound, in their original order: a ≤24-row
 * receipt must keep that shape key for key (the bound adds a member only to a
 * card it actually cut). */
const PRE_CAP_CARD_KEYS = "kind,v,at,senderSessionId,message,targets,summary,fanout";

/** §3.4 fixture whose wildcard expansion is `memberCount` rows: the caller is the
 * incumbent coordinator (the wildcard's own gate), and each worker is a filled
 * live role AND paired with the caller, so every row is a real delivery rather
 * than a refusal the test would have to explain. */
function wideFanEnv(memberCount) {
	const roles = [{ role: "coordinator", current: "session-self", pending: null, history: [{ session: "session-self", from: 1, until: null }] }];
	const extraAgents = [];
	const pairs = [];
	for (let index = 0; index < memberCount; index += 1) {
		const id = `session-w${String(index).padStart(2, "0")}`;
		roles.push({ role: `w${index}`, current: id, pending: null, history: [{ session: id, from: 1, until: null }] });
		extraAgents.push({ id, status: "idle" });
		pairs.push(pairSelf(id));
	}
	const env = teamEnv({
		teams: [{ name: "night-shift", createdAt: 1_700_000_000_000, workspace: TEAM_WS, policy: { writer: "coordinator" }, roles }],
		extraAgents,
	});
	env.ns.data.pairs = structuredClone(pairs);
	env.send = env.tool("team_link_send");
	return env;
}

/** The report's own per-target rows, in order (the full archive). */
const reportRows = (text) => text.split("\n").filter((line) => line.startsWith("- "));

const wideEnv = wideFanEnv(30);
const wideArgs = { targets: ["team:night-shift/*"], message: "全队通知：接口地址已切到 v2" };
const wideValue = await wideEnv.send.execute(wideArgs, execFor(wideEnv.senderAgent));
const wideCard = wideEnv.send.output.presentationMeta(wideArgs, wideValue);
check("U13 行数界: one wildcard expression legally expands past the ≤8 expression bound — 30 targets, one report row each", wideEnv.extraCalls.size === 30 && reportRows(wideValue).length === 30);
check("U13 行数界: a >24-row receipt is CUT to exactly 24 rows on the card (pre-fix: all 30 rows were welded into tool/result.meta)", wideCard.targets.length === 24);
check("U13 行数界: ... and the card says so itself — the shown/total facts the client's `sendRowsTruncated`「已截断——仅显示前 {shown} 行」 wording needs", sameJson(wideCard.targetsTruncated, { shown: 24, total: 30 }));
check("U13 行数界: the kept rows are the report's own FIRST 24 in order — a prefix of the archive, never a re-sorted sample", wideCard.targets.every((target, index) => reportRows(wideValue)[index] === `- ${target.sessionId}（via ${target.expr}） → ${target.outcome}：${target.detail}`));
check("U13 行数界: the summary still counts the FULL set — the cut costs rows, never a count", sameJson(wideCard.summary, { delivered: 30, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 }));
check("U13 行数界: the model-visible report keeps one row per target plus the full summary line (card = bounded view, report = full archive)", reportRows(wideValue).length === 30 && wideValue.startsWith("广播 fan-out：30 个目标\n") && wideValue.trimEnd().endsWith("汇总：30 投递 / 0 拒绝。"));
check("U13 行数界: all 30 targets really received the message — the cut is presentation only", [...wideEnv.extraCalls.values()].every((calls) => calls.followedup.length === 1));
check("U13 行数界: the cut rides immediately after the array it describes", Object.keys(wideCard).join(",") === "kind,v,at,senderSessionId,message,targets,targetsTruncated,summary,fanout");
check("U13 行数界: the truncated card is still lossless JSON (what the registry requires before persisting it)", sameJson(JSON.parse(JSON.stringify(wideCard)), wideCard));

// 对照 1: exactly 24 rows is INSIDE the bound — inclusive, like the
// 2000-code-point body cap: no cut, no member, no report change.
const at24Env = wideFanEnv(24);
const at24Args = { targets: ["team:night-shift/*"], message: "全队通知" };
const at24Value = await at24Env.send.execute(at24Args, execFor(at24Env.senderAgent));
const at24Card = at24Env.send.output.presentationMeta(at24Args, at24Value);
check("U13 行数界 对照: exactly 24 rows is NOT truncated — the cap is inclusive", at24Card.targets.length === 24 && !Object.prototype.hasOwnProperty.call(at24Card, "targetsTruncated"));
check("U13 行数界 对照: a ≤24-row card gains NO member at all — the pre-bound shape, key for key (the 2-row fixture asserts the same)", Object.keys(at24Card).join(",") === PRE_CAP_CARD_KEYS && Object.keys(fanCard).join(",") === PRE_CAP_CARD_KEYS);
check("U13 行数界 对照: ... and its counts and report rows are the same 24, with nothing else touched", sameJson(at24Card.summary, { delivered: 24, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 }) && reportRows(at24Value).length === 24);

// ---------------------------------------------------------------------------
// M4 (§3.6): rotation — two-phase hand-over, domain-limited migration, TTL rollback
// ---------------------------------------------------------------------------

const SUCCESSOR = "session-new";
const ROT_SELF = "session-self";
const ROT_OUTSIDE = "session-outside";

/** The M4 roster: a seated coordinator (session-self) and two live workers. */
const rotRoles = () => [
	{ role: "coordinator", current: ROT_SELF, pending: null, history: [{ session: ROT_SELF, from: 1_700_000_000_000, until: null }] },
	{ role: "worker-a", current: "session-worker-a", pending: null, history: [{ session: "session-worker-a", from: 1_700_000_000_000, until: null }] },
	{ role: "worker-b", current: "session-worker-b", pending: null, history: [{ session: "session-worker-b", from: 1_700_000_000_000, until: null }] },
];

/**
 * M4 fixture: the roster above, three live agents (two workers + the successor)
 * and the trust state a rotation operates on. `receiveMode: accept` keeps notice
 * delivery out of the receiver dialog; the notice cases set their mode explicitly.
 */
function rotateEnv({ askScript = [], omitUserQuestions = false, pairs = [], trustedSenders = [], rememberTargets = [], blockedSenders = [], receiveMode = "accept", goals, teams, failCreateAt = -1, omitCommands = false, lateCommands = false, omitAgentPresets = false, agentPresetsOptions = undefined, omitWorkspaceRegistry = false, omitSessionTitle = false, sessionTitleOptions = undefined, omitAgentDefaultModel = false, agentDefaultModelOptions = undefined, omitResume = false, extraAgents = undefined, omitAgentsCreate = false } = {}) {
	const env = setup({
		sessions: [],
		useSettings: true,
		askScript,
		omitUserQuestions,
		selfCwd: TEAM_WS,
		goals,
		// §11.2's auto path calls agents.create; `failCreateAt` is the §11.5 crash
		// window fixture (a create that never settles must keep its intent).
		failCreateAt,
		// Both commands ride the same optional `commands` seam: these two flags are
		// the §11.2 degradation / late-provider fixtures.
		omitCommands,
		lateCommands,
		// §10.2.2's preset face rides the same optional channel: `omitAgentPresets`
		// is the degradation fixture for the auto path too (it creates through the
		// SAME `buildTeamSessionCreateOptions`). `agentPresetsOptions` 是本轮补上的
		// 透传（复活面要 `omitMount` 造「服务在场但组成面只有一半」的形状断层 ——
		// 漏了这行，那个 fixture 会静默退化成「服务完全正常」，判据变空锁）。
		omitAgentPresets,
		agentPresetsOptions,
		// §10.2.2 模板的另一半（真机缺陷 #2）：auto 路径建继任者也走同一个
		// `createRootAgent` ⇒ 工作区挂载同样要在这儿有它的降级 fixture。
		omitWorkspaceRegistry,
		// §10.2.2 模板的第四块（真机缺陷 #4）：同上——命名也是**同一个**注入点。
		omitSessionTitle,
		sessionTitleOptions,
		// §10.2.2 模板的第三块（真机缺陷 #3）：auto 路径的继任者同样要在 `agentOptions`
		// 里带上模型选择，否则「令牌投给了一个跑不起来的持钥者、而旧任已冻结」。
		omitAgentDefaultModel,
		agentDefaultModelOptions,
		// §10.2.2 模板的第四块（真机缺陷 #4）：auto 路径的继任者同样要被命名
		// （同一个 `createRootAgent` ⇒ 同一个注入点），两档降级 fixture 同样转发。
		omitSessionTitle,
		sessionTitleOptions,
		// §11.9.4 L1's two fixtures: `omitResume` is the documented "no factory /
		// no session persistence" failure mode, and the stub's own record/hidden
		// bookkeeping is what the revive cases read.
		omitResume,
		// 批次 2 §4.2 (c): the synthetic successor's capability gate (U10).
		omitAgentsCreate,
		extraAgents: extraAgents ?? [
			{ id: "session-worker-a", status: "idle" },
			{ id: "session-worker-b", status: "idle" },
			{ id: SUCCESSOR, status: "idle" },
		],
	});
	const ns = env.settings.namespaces.get("team-link");
	ns.data.teams = structuredClone(teams ?? [{ name: "night-shift", createdAt: 1_700_000_000_000, workspace: TEAM_WS, policy: { writer: "coordinator" }, roles: rotRoles() }]);
	ns.data.pairs = structuredClone(pairs);
	ns.data.trustedSenders = structuredClone(trustedSenders);
	ns.data.rememberTargets = structuredClone(rememberTargets);
	ns.data.blockedSenders = structuredClone(blockedSenders);
	ns.data.receiveMode = receiveMode;
	return {
		...env,
		ns,
		rotate: env.tool("team_link_rotate"),
		roster: env.tool("team_link_roster"),
		send: env.tool("team_link_send"),
		list: env.tool("team_link_list_sessions"),
		rotation: __testing.rotationFor(env.ctx),
		calls: (id) => env.extraCalls.get(id),
		exec: (id) => execFor(env.agentFor(id)),
		team: () => ns.data.teams[0],
		role: (name = "coordinator") => ns.data.teams[0].roles.find((entry) => entry.role === name),
	};
}

const rotPair = (id) => ({ a: ROT_SELF, b: id, createdAt: 1 });
/** §11.9.4's fixture: declare a session that exists ON DISK but has no live agent
 * in this activation — the shape a plugin reload leaves behind. It is added to the
 * `agents.resume` stub's persisted-session list, so only the recover path can bring
 * it back (`agents.get` keeps answering undefined until then). */
const declareDormantSession = (env, sessionId, extraHeader = undefined) => {
	env.resumeRecords.push({ header: { id: sessionId, cwd: TEAM_WS, ...(extraHeader ?? {}) }, live: false, persisted: true });
	return env;
};
const pairSummary = (env) => (env.ns.data.pairs ?? []).map((pair) => `${pair.a}↔${pair.b}${pair.provisional === true ? "(provisional)" : ""}`).sort().join(" ");
/** The token of a prepare result. 🔵-1's discipline applies here too: `undefined`
 * is not a value the tool-call bridge accepts (`arguments` must be a lossless JSON
 * object), so a prepare that produced no token would turn the claim call below
 * into a harness-level INVALID_ARGS crash instead of a clean refusal. The empty
 * string keeps the call well-formed and lets the plugin answer it. */
const tokenOf = (text) => (String(text).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u) ?? [""])[0];

// --- prepare (Phase A): token, snapshot, freeze broadcast --------------------

const rotA = rotateEnv({
	askScript: [["session-worker-a"]],
	pairs: [rotPair("session-worker-a"), rotPair("session-worker-b"), rotPair(ROT_OUTSIDE), { a: "session-worker-a", b: "session-worker-b", createdAt: 2 }],
	trustedSenders: [ROT_SELF, "session-worker-a"],
	rememberTargets: [ROT_SELF, "session-worker-b"],
});
check("M4: the rotation tool is registered", rotA.rotate !== undefined && rotA.list !== undefined);

const rotPrep = await rotA.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR, note: "INJECT_ME 载荷" }, execFor(rotA.senderAgent));
const rotToken = tokenOf(rotPrep);
check("M4 prepare: the incumbent gets the hand-over package and a fresh one-time token", rotPrep.includes("换届包已就绪") && typeof rotToken === "string" && rotToken.length === 36);
check("M4 prepare: the token is bound to (team, role, successor) with the 30-minute TTL (§3.6.1 原则 1)", (() => {
	const pending = rotA.role().pending;
	return pending.session === SUCCESSOR && pending.token === rotToken && pending.team === "night-shift" && pending.role === "coordinator" && pending.expiresAt - pending.createdAt === 30 * 60000 && Array.isArray(pending.migratedPairs) && pending.migratedPairs.length === 0;
})());
check("M4 prepare: rotationBackup snapshots the pre-rotation trust state (撤销依据)", (() => {
	const backup = rotA.team().rotationBackup;
	return backup !== null && backup.at > 0 && backup.pairs.length === 4 && backup.trustedSenders.length === 2 && backup.rememberTargets.length === 2 && backup.roster.roles.length === 3;
})());
check("M4 prepare: the guidance names the TTL, the model-drafted hand-over and the goal hint (§3.6.2)", rotPrep.includes("30 分钟内有效") && rotPrep.includes("机制与判断分离") && rotPrep.includes("/goal resume") && rotPrep.includes("armed-active = 内建心跳"));
check("M4 prepare: the result states that only the mask is rendered from now on", rotPrep.includes(`tok-${rotToken.slice(0, 4)}…${rotToken.slice(-4)}`));

const freezeMsg = rotA.calls("session-worker-a").followedup[0];
check("M4 prepare: rotation-freeze is the §4.2 constant check-list", freezeMsg !== undefined && freezeMsg.content[0].text.includes("[rotation-freeze]") && freezeMsg.content[0].text.includes("停掉本会话的哨兵/看门狗与后台 job") && freezeMsg.content[0].text.includes("确认没有在飞的动作") && freezeMsg.content[0].text.includes("状态已冻结") && freezeMsg.content[0].text.includes("等待交接结果通知"));
check("M4 prepare: the freeze reaches every other team member, and no sender-side approval was asked", rotA.calls("session-worker-a").followedup.length === 1 && rotA.calls("session-worker-b").followedup.length === 1 && rotA.uq.requests.length === 0);
check("M4 红线: a notice rides the audited three-member source (V10)", Object.keys(freezeMsg.source).length === 3 && freezeMsg.source.kind === "agent-message" && freezeMsg.source.form === "relay" && freezeMsg.source.senderSessionId === ROT_SELF);
check("M4 红线: no model-supplied text can reach a notice body (机制与判断分离)", !freezeMsg.content[0].text.includes("INJECT_ME") && !rotA.calls("session-worker-b").followedup[0].content[0].text.includes("INJECT_ME"));

const rotMirror = await readFile(mirrorFile, "utf8");
const rotGet = await rotA.roster.execute({ action: "get", team: "night-shift" }, execFor(rotA.senderAgent));
check("M4 令牌掩码: the roster.md mirror renders only the masked token (M2 评审 #3)", rotMirror.includes(`tok-${rotToken.slice(0, 4)}…${rotToken.slice(-4)}`) && !rotMirror.includes(rotToken));
check("M4 令牌掩码: roster get renders only the masked token too, and names the binding", rotGet.includes("掩码") && rotGet.includes(`tok-${rotToken.slice(0, 4)}…${rotToken.slice(-4)}`) && rotGet.includes("绑定 team=night-shift role=coordinator") && !rotGet.includes(rotToken));
check("M4 令牌掩码: the plaintext token exists exactly once — in the prepare result", rotPrep.includes(rotToken) && !rotMirror.includes(rotToken) && !rotGet.includes(rotToken));

// --- the third no-agent path: a plugin notice (§3.6.2 internal broadcast) -----
// The notice path builds its sender from an id alone, so there is no session
// identity and therefore no workspace to filter by: the refusal lists the live
// sessions it can see and excludes the caller — that is all it can honestly do.
// (Placed after the mirror assertions above: this prepare writes the same
// `roster.md` mirror and would otherwise re-render it under another token.)
const rotHintEnv = rotateEnv({
	teams: [{
		name: "night-shift",
		createdAt: 1_700_000_000_000,
		workspace: TEAM_WS,
		policy: { writer: "coordinator" },
		roles: [...rotRoles(), { role: "worker-c", current: "session-gone", pending: null, history: [{ session: "session-gone", from: 1_700_000_000_000, until: null }] }],
	}],
});
const rotHintPrep = await rotHintEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rotHintEnv.senderAgent));
check("no-agent: a notice to a member with no live agent carries the same ❌ 未投递 refusal", rotHintPrep.includes("  - session-gone → no-agent：❌ 未投递：目标会话 session-gone 没有活动代理"));
check("no-agent: with no session identity in the notice path the hint list skips the workspace filter (only the caller is excluded)", rotHintPrep.includes("当前工作区其他存活会话") && rotHintPrep.includes("session-target（空闲）") && !rotHintPrep.includes("session-gone（"));

// --- claim (Phase B): the single dialog, domain-limited migration -----------

const rotClaim = await rotA.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: rotToken, note: "夜班接班" }, rotA.exec(SUCCESSOR));
check("M4 claim: ONE dialog lists every in-domain candidate as a multi-select option (逐项勾选 + 整批确认)", (() => {
	const ask = rotA.uq.requests[0];
	return ask !== undefined && ask.questions.length === 1 && ask.questions[0].multiSelect === true && ask.questions[0].options.map((option) => option.label).join(",") === "session-worker-a,session-worker-b";
})());
check("M4 claim: the dialog states the blast radius — bypassed gates, dropped out-of-domain pairs", (() => {
	const detail = rotA.uq.requests[0].questions[0].detail;
	return detail.includes("绕过两道批准门") && detail.includes(ROT_OUTSIDE) && detail.includes("对端不在本团队域内");
})());
check("M4 claim: the checked pair is migrated as a ratified channel, the unchecked one is not", rotClaim.includes("已获在场确认") && rotClaim.includes("勾选 1 / 候选 2 条") && rotClaim.includes("session-worker-a ↔ session-self → 已迁移为 session-worker-a ↔ session-new（正式通道）") && rotClaim.includes("session-worker-b ↔ session-self → 未迁移（未勾选）"));
check("M4 claim: a pair whose counterpart is outside the roster is never migrated (§3.6.1 原则 2)", rotClaim.includes(`${ROT_OUTSIDE} ↔ session-self → 未迁移（对端不在本团队域内（§3.6.1 原则 2））`));
check("M4 claim: the resulting trust state is exactly kept + migrated", pairSummary(rotA) === "session-new↔session-worker-a session-worker-a↔session-worker-b");
check("M4 claim: revocation is symmetric — pairs/trustedSenders/rememberTargets of the retiree all go (§3.6.1 原则 3)", !rotA.ns.data.pairs.some((pair) => pair.a === ROT_SELF || pair.b === ROT_SELF) && !rotA.ns.data.trustedSenders.includes(ROT_SELF) && !rotA.ns.data.rememberTargets.includes(ROT_SELF) && rotClaim.includes("pairs 3 条已全部清除（其中迁移 1 条）") && rotClaim.includes("trustedSenders 移除 1 项") && rotClaim.includes("rememberTargets 移除 1 项"));
check("M4 claim: the roster settles — current, closed/open tenure with the note, rotationAt, pending cleared", (() => {
	const entry = rotA.role();
	return entry.current === SUCCESSOR && entry.pending === null && entry.provisional === null && entry.rotationAt > 0 && entry.history.length === 2 && entry.history[0].session === ROT_SELF && typeof entry.history[0].until === "number" && entry.history[0].note === "夜班接班" && entry.history[1].session === SUCCESSOR && entry.history[1].until === null;
})());
check("M4 claim: rotation-done is broadcast with the ratified status, from the new incumbent", (() => {
	const done = rotA.calls("session-worker-a").followedup[1];
	return done !== undefined && done.content[0].text.includes("[rotation-done]") && done.content[0].text.includes("信任迁移状态：已批准") && done.content[0].text.includes(`旧任 ${ROT_SELF} → 新任 ${SUCCESSOR}`) && done.source.senderSessionId === SUCCESSOR;
})());
check("M4 claim: a ratified migration opens no rollback window", rotClaim.includes("迁移的 pairs 已是正式通道（无回退窗口）") && rotA.role().provisional === null);

// --- M4 代码评审 #4: the mirror must not keep advertising a cleared pending ---

const rotClaimMirror = await readFile(mirrorFile, "utf8");

check("评审 #4: after a claim the roster mirror renders the post-clear roster — no pending line, no masked token left behind", /### coordinator[\s\S]*?- pending：（无）/u.test(rotClaimMirror) && !rotClaimMirror.includes("tok-"));

// --- M4 代码评审 #6: the outgoing holder hears the hand-over completed --------

check("评审 #6: the retiree (no longer a member after the claim) still receives rotation-done", (() => {
	const done = rotA.senderCalls.followedup.filter((message) => message.content[0].text.includes("[rotation-done]"));
	return done.length === 1 && done[0].content[0].text.includes(`旧任 ${ROT_SELF} → 新任 ${SUCCESSOR}`) && done[0].source.senderSessionId === SUCCESSOR && Object.keys(done[0].source).length === 3;
})());

const rotSend = await rotA.send.execute({ targetSessionId: "session-worker-a", message: "交接后的正式通道" }, rotA.exec(SUCCESSOR));
check("M4: a delivery over the migrated channel is a plain paired delivery (no provisional suffix)", rotSend.includes("已投递到") && rotSend.includes("已配对通道") && !rotSend.includes("provisional"));

const rotAgain = await rotA.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: rotToken }, rotA.exec(SUCCESSOR));
check("U6: a token is single-use — a replay after a completed claim is refused (成功即作废)", rotAgain.includes("没有 pending") && rotAgain.includes("成功即作废"));

// --- prepare preconditions and the anti-storm rate limit --------------------

const gateEnv = rotateEnv();
const notIncumbent = await gateEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, gateEnv.exec("session-worker-a"));
check("U6: prepare is refused for every session but the incumbent (§3.6.2 前置)", notIncumbent.includes("只有该角色的现任会话 session-self 可以发起换届") && gateEnv.role().pending === null);
const selfRot = await gateEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: ROT_SELF }, execFor(gateEnv.senderAgent));
check("U6: a self-succession is refused (it would revoke and re-grant the same session's trust)", selfRot.includes("继任者不能是现任自己") && selfRot.includes("retire") && gateEnv.role().pending === null);
const noSuccessor = await gateEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator" }, execFor(gateEnv.senderAgent));
check("U6: prepare without a successor is refused with the §3.6.4 pointer", noSuccessor.includes("需要 successor") && noSuccessor.includes("§3.6.4") && noSuccessor.includes("team_link_roster action=retire"));
const rotGhostTeam = await gateEnv.rotate.execute({ action: "prepare", team: "no-such-team", role: "coordinator", successor: SUCCESSOR }, execFor(gateEnv.senderAgent));
check("U6: an unknown team refuses prepare", rotGhostTeam.includes("不在注册表中"));
const ghostRole = await gateEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "ghost", successor: SUCCESSOR }, execFor(gateEnv.senderAgent));
check("U6: an unknown role refuses prepare", ghostRole.includes("没有角色 ghost"));
const starRole = await gateEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "*", successor: SUCCESSOR }, execFor(gateEnv.senderAgent));
check("R6: the addressing grammar's reserved word is refused as a role name here too", starRole.includes("寻址文法保留字"));
const rotBadAction = await rejects(gateEnv.rotate, { action: "rotate" }, execFor(gateEnv.senderAgent));
check("U6: the action set is closed to the two phases", rotBadAction instanceof Error);

const rateEnv = rotateEnv();
const firstPrep = await rateEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rateEnv.senderAgent));
const secondPrep = await rateEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rateEnv.senderAgent));
check("U6: a second prepare inside the 10-minute window is refused (防换届风暴)", firstPrep.includes("换届包已就绪") && secondPrep.includes("换届速率限制") && secondPrep.includes("rateLimit(team, role, 10min)") && secondPrep.includes("窗口剩余约"));
const { rotationRateLimited } = __testing;
const RL_NOW = 1_700_000_000_000;
check("U6: the rate limit is a pure function of the pending and rotation timestamps", rotationRateLimited({ pending: { createdAt: RL_NOW - 60000, expiresAt: RL_NOW + 29 * 60000 }, rotationAt: 0 }, RL_NOW).limited === true
	&& rotationRateLimited({ pending: { createdAt: RL_NOW - 11 * 60000, expiresAt: RL_NOW + 19 * 60000 }, rotationAt: 0 }, RL_NOW).limited === false
	&& rotationRateLimited({ pending: null, rotationAt: RL_NOW - 60000 }, RL_NOW).limited === true
	&& rotationRateLimited({ pending: null, rotationAt: RL_NOW - 11 * 60000 }, RL_NOW).limited === false
	&& rotationRateLimited(null, RL_NOW).limited === false);

// --- claim preconditions: token, successor identity, binding, expiry --------

const rotClaimEnv = rotateEnv({ pairs: [rotPair("session-worker-a"), rotPair("session-worker-b")] });
const rotTokenC = tokenOf(await rotClaimEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rotClaimEnv.senderAgent)));
const rotWrongToken = await rotClaimEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: "00000000-0000-0000-0000-000000000000" }, rotClaimEnv.exec(SUCCESSOR));
check("U6: a wrong token is refused and nothing moves", rotWrongToken.includes("令牌不匹配") && rotClaimEnv.role().current === ROT_SELF && pairSummary(rotClaimEnv) === "session-self↔session-worker-a session-self↔session-worker-b");
const rotMaskedToken = await rotClaimEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: __testing.maskToken(rotTokenC) }, rotClaimEnv.exec(SUCCESSOR));
check("U6: the masked rendering is not a token (the mask is a rendering, not a credential)", rotMaskedToken.includes("令牌不匹配") && rotMaskedToken.includes("掩码形式"));
const rotWrongSession = await rotClaimEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: rotTokenC }, execFor(rotClaimEnv.senderAgent));
check("U6: only the pending's successor session may claim (§3.6.1 原则 1)", rotWrongSession.includes("只有 pending 指定的继任者会话 session-new 可以认领") && rotClaimEnv.role().current === ROT_SELF);

const rotBindRoleEnv = rotateEnv();
rotBindRoleEnv.role().pending = { session: SUCCESSOR, token: "bind-token", team: "night-shift", role: "worker-a", expiresAt: Date.now() + 600000, createdAt: Date.now() };
const rotMismatchRole = await rotBindRoleEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: "bind-token" }, rotBindRoleEnv.exec(SUCCESSOR));
check("U6: a token bound to another role is refused (绑定三元组)", rotMismatchRole.includes("令牌绑定不匹配") && rotMismatchRole.includes("role=worker-a"));
const rotBindTeamEnv = rotateEnv();
rotBindTeamEnv.role().pending = { session: SUCCESSOR, token: "bind-token-2", team: "day-shift", role: "coordinator", expiresAt: Date.now() + 600000, createdAt: Date.now() };
const rotMismatchTeam = await rotBindTeamEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: "bind-token-2" }, rotBindTeamEnv.exec(SUCCESSOR));
check("U6: ... and a token bound to another team is refused too", rotMismatchTeam.includes("令牌绑定不匹配") && rotMismatchTeam.includes("team=day-shift"));

const rotExpiredEnv = rotateEnv({ pairs: [rotPair("session-worker-a"), rotPair("session-worker-b")] });
rotExpiredEnv.role().pending = { session: SUCCESSOR, token: "expired-token", team: "night-shift", role: "coordinator", expiresAt: Date.now() - 1000, createdAt: Date.now() - 31 * 60000, migratedPairs: [] };
const rotExpiredClaim = await rotExpiredEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: "expired-token" }, rotExpiredEnv.exec(SUCCESSOR));
check("U6: an expired token is refused, the pending is cancelled and the old incumbent stays current (评审 #4)", rotExpiredClaim.includes("令牌已过期") && rotExpiredClaim.includes("冻结解除") && rotExpiredEnv.role().pending === null && rotExpiredEnv.role().current === ROT_SELF && rotExpiredEnv.ns.data.pairs.length === 2);
const rotCancelMsg = rotExpiredEnv.calls("session-worker-a").followedup.at(-1);
check("U6 常量文案: rotation-cancelled says 旧任仍为 current / 令牌过期未认领 / 解除冻结", rotCancelMsg !== undefined && rotCancelMsg.content[0].text.includes("[rotation-cancelled]") && rotCancelMsg.content[0].text.includes(`旧任 ${ROT_SELF} 仍为 current`) && rotCancelMsg.content[0].text.includes("令牌过期未认领") && rotCancelMsg.content[0].text.includes("解除冻结"));

// --- the unattended path: provisional trust and the 24h rollback ------------

const rotProvEnv = rotateEnv({ omitUserQuestions: true, pairs: [rotPair("session-worker-a"), rotPair("session-worker-b")] });
const rotProvToken = tokenOf(await rotProvEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rotProvEnv.senderAgent)));
const rotProvClaimAt = Date.now();
const rotProvClaim = await rotProvEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: rotProvToken }, rotProvEnv.exec(SUCCESSOR));
check("U6: with no confirm service every in-domain pair migrates, and it is provisional", rotProvClaim.includes("确认服务（userQuestions）不可用") && pairSummary(rotProvEnv) === "session-new↔session-worker-a(provisional) session-new↔session-worker-b(provisional)");
check("U6: the provisional pairs carry the 24h rollback deadline", (() => {
	const pair = rotProvEnv.ns.data.pairs.find((entry) => entry.b === "session-worker-a");
	// R8 (M4 round 2, test-hygiene rider): the deadline is asserted against the pair's
	// OWN createdAt (the claim's clock, which is what expiresAt was derived from)
	// instead of against the wall clock captured just before the call. The old form
	// required the tool's `now` to equal that capture to the millisecond, so a single
	// clock tick between the two reads turned it red — measured 1/12 runs on pristine
	// HEAD (flake, not a behavior change).
	return pair.provisional === true && pair.expiresAt - pair.createdAt === 24 * 3600000 && pair.createdAt >= rotProvClaimAt;
})());
check("U6: the roster keeps the open ratification window, and the claim says 待批准(24h)", (() => {
	const entry = rotProvEnv.role();
	return entry.current === SUCCESSOR && entry.pending === null && entry.provisional !== null && entry.provisional.session === SUCCESSOR && entry.provisional.expiresAt > rotProvClaimAt && rotProvClaim.includes("信任迁移状态：待批准(24h)") === false;
})());
check("U6 常量文案: the done notice of an unattended rotation says 待批准(24h)", rotProvEnv.calls("session-worker-a").followedup[1].content[0].text.includes("信任迁移状态：待批准(24h)"));

const rotProvSend = await rotProvEnv.send.execute({ targetSessionId: "session-worker-a", message: "临时通道" }, rotProvEnv.exec(SUCCESSOR));
check("U6 provisional 可见面: a delivery over a provisional channel carries the §3.6.2 suffix", rotProvSend.includes("（provisional 通道，24h 内未批准自动回退）"));
check("U6 provisional 可见面: the banner keeps the §3.4 envelope shape (no provisional field)", (() => {
	const msg = rotProvEnv.calls("session-worker-a").followedup.at(-1);
	return !msg.content[0].text.split("\n")[0].includes("provisional") && Object.keys(msg.source).length === 3;
})());

const rotListEnv = (() => {
	const env = setup({ sessions: [{ header: { id: "session-worker-a", createdAt: 1000, cwd: CWD }, live: true, persisted: true }], useSettings: true, selfCwd: CWD, extraAgents: [{ id: "session-worker-a", status: "idle" }] });
	const ns = env.settings.namespaces.get("team-link");
	ns.data.pairs = [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 1, provisional: true, expiresAt: Date.now() + 3600000 }];
	return { ...env, ns };
})();
const rotListOut = await rotListEnv.tool("team_link_list_sessions").execute({}, execFor(rotListEnv.senderAgent));
check("U6 provisional 可见面: list_sessions marks the unratified channel on the session row (§3.6.2 评审 #3)", rotListOut.includes("provisional 配对 1 条") && rotListOut.includes("24h 内未批准自动回退"));
check("U6 provisional 可见面: the marker sits before the reading stamp, so the row still ends with the stamp", /- session-worker-a[^\n]*provisional 配对 1 条（换届临时信任：24h 内未批准自动回退，见 team_link_roster）（读数 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}，>2min 作废）/u.test(rotListOut));

// 🔵 §9.6 ⑧ (计数口径): the count must agree with the delivery side. 评审 #8 made
// an expired provisional record "no pair" for gate purposes; counting it here
// would advertise a bypass channel that has already closed.
const rotListExpiredEnv = (() => {
	const env = setup({ sessions: [{ header: { id: "session-worker-a", createdAt: 1000, cwd: CWD }, live: true, persisted: true }], useSettings: true, selfCwd: CWD, extraAgents: [{ id: "session-worker-a", status: "idle" }] });
	const ns = env.settings.namespaces.get("team-link");
	ns.data.pairs = [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 1, provisional: true, expiresAt: Date.now() - 1000 }];
	return { ...env, ns };
})();
const rotListExpiredOut = await rotListExpiredEnv.tool("team_link_list_sessions").execute({}, execFor(rotListExpiredEnv.senderAgent));
check("🔵 §9.6 ⑧: a provisional pair past its deadline is not counted as a live provisional channel (same liveness predicate as the delivery side)", rotListExpiredOut.includes("session-worker-a") && !rotListExpiredOut.includes("provisional 配对"));

const rotRollbackNow = rotProvClaimAt + 24 * 3600000 + 60000;
const rotRollbackSweep = await rotProvEnv.rotation.sweep({ now: rotRollbackNow });
check("U6: at the 24h mark the sweep deletes the provisional pairs (评审 #5)", rotRollbackSweep.expired.length === 1 && rotProvEnv.ns.data.pairs.length === 0 && pairSummary(rotProvEnv) === "");
check("U6: history records the unratified rollback and the window closes", (() => {
	const entry = rotProvEnv.role();
	const last = entry.history.at(-1);
	return last.session === SUCCESSOR && last.note === "provisional 未批准过期" && last.until === rotRollbackNow && entry.provisional === null && entry.pending === null;
})());
check("U6: the new incumbent stays current after the rollback — the rotation fact stands (评审 #5 终态)", rotProvEnv.role().current === SUCCESSOR);
const rotExpiredMsg = rotProvEnv.calls("session-worker-a").followedup.at(-1);
check("U6 常量文案: rotation-expired states the rollback, the retained incumbent and the return to the gates", rotExpiredMsg.content[0].text.includes("[rotation-expired]") && rotExpiredMsg.content[0].text.includes("24h 内未获批准，已自动回退") && rotExpiredMsg.content[0].text.includes(`${SUCCESSOR} 仍为 current`) && rotExpiredMsg.content[0].text.includes("正常过门"));
const rotRollbackSend = await rotProvEnv.send.execute({ targetSessionId: "session-worker-a", message: "回退之后" }, rotProvEnv.exec(SUCCESSOR));
check("U6: after the rollback the channel is gone — a send goes through the normal gates again", rotRollbackSend.includes("确认服务（userQuestions）不可用") && !rotRollbackSend.includes("provisional 通道"));

// --- §3.6.1 原则 4 的无人值守分支：读到「超时」的调用方必须被告知变更已经落盘 -------------
//
// 真机（2026-09-20 15:03，v038d-probe 队）：逐项勾选对话框无人应答，外层工具桥在 ~120s 用
// `{name:"AbortError", code:"ABORTED"}` 中止了这次嵌套调用 —— **调用方读到的只有「超时」**，
// 而 claim 已经走完无人值守分支并落盘（roster 落定、14 条 pairs 转 provisional）。
// 「对话框超时」与「调用失败」在调用方读数上同形，后果却相反（已换届 vs 未换届）⇒ 超时这条
// 路径的读数必须**自报**：已按设计以 provisional 迁移 + 具体到期时刻 + 批准路径（谁批、在哪批）。
// 下面两条各复现一个入口：① 调用方中止（真机那个形状）；② 插件的 3 分钟计时器到点。
/** 报告里的某一行（按行首标签取）。判据落在**那一行自己**身上：调用方可能只读得到它。 */
const reportLine = (text, label) => (String(text).split("\n").find((line) => line.startsWith(label)) ?? "");
/** 报告里两处**独立渲染**的到期时刻：迁移行那个数来自 pair 自己的 `expiresAt`（同一份事实的
 * 另一个读面），窗口句那个数来自 `now + TTL`。超时读数必须与它们**同一个值**——那不是把
 * 数字再抄一遍，而是钉住「自报的到期时间 == 迁移真正落下的那个时刻」。 */
const expiryBefore = (text) => (String(text).match(/到期 (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/u) ?? [])[1];
const windowExpiry = (text) => (String(text).match(/provisional 回退窗口：(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) 到期/u) ?? [])[1];
const timeoutReadingOf = (text) => {
	const reading = reportLine(text, "批准状态：");
	const expiry = expiryBefore(text);
	return reading.includes("未获应答") && reading.includes("这不是「调用失败」") && reading.includes("已按设计") && reading.includes("provisional") && reading.includes("已落盘")
		&& expiry !== undefined && reading.includes(expiry) && windowExpiry(text) === expiry
		&& reading.includes("人类") && reading.includes("设置 UI");
};

/**
 * 「批准状态：」那行里，从「——这不是「调用失败」」往后的**同一段话**。
 *
 * 两次 claim 相隔几毫秒，而回退窗口的到期时刻是**秒精度** —— 跨过秒边界时两行的时刻
 * 就不同，于是「只差『发生了什么』那半句」这条逐字比对会假红（24 次跑批实测 2 次）。
 * 这里把时刻本身归一化成占位符：判据要比的是「除了原因那半句两行一字不差」，时刻
 * 不同正是那条断言**不**要看的东西。
 */
const approvalTailOf = (text) => {
	const line = reportLine(text, "批准状态：");
	return line.slice(line.indexOf("——这不是「调用失败」")).replace(expiryBefore(text) ?? "\u0000", "<到期时刻>");
};
const dialogAbortEnv = rotateEnv({ pairs: [rotPair("session-worker-a"), rotPair("session-worker-b")] });
const dialogAbortToken = tokenOf(await dialogAbortEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(dialogAbortEnv.senderAgent)));
const dialogAbortController = new AbortController();
let markDialogOpen;
const dialogOpened = new Promise((resolve) => { markDialogOpen = resolve; });
dialogAbortEnv.uq.script.push((request) => {
	markDialogOpen();
	return new Promise((_resolve, reject) => {
		request.signal.addEventListener("abort", () => reject(Object.assign(new Error("tool call aborted"), { name: "AbortError", code: "ABORTED" })));
	});
});
const dialogAbortPending = dialogAbortEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: dialogAbortToken }, { agent: dialogAbortEnv.agentFor(SUCCESSOR), signal: dialogAbortController.signal });
await dialogOpened;
dialogAbortController.abort();
const dialogAbortOut = await dialogAbortPending;

check("缺口1 前提（后果为真）: 调用方中止**不会**取消无人值守分支——roster 照常落定、两条 pairs 真的成了 provisional 通道（自报的后果必须是真的，否则那条读数只是在说话）",
	dialogAbortEnv.role().current === SUCCESSOR && dialogAbortEnv.role().pending === null && dialogAbortEnv.role().provisional !== null && pairSummary(dialogAbortEnv) === "session-new↔session-worker-a(provisional) session-new↔session-worker-b(provisional)");
check("缺口1 超时读数自报真实后果（调用方中止）: 「批准状态」那一行**自己**写明——未获应答（超时）、这不是「调用失败」、全部候选已按设计以 provisional 迁移并已落盘、回退窗口的**具体到期时刻**、以及批准路径（谁批=人类 / 在哪批=设置 UI）",
	timeoutReadingOf(dialogAbortOut));

// ② 计时器入口：3 分钟是人等待的预算，测试不等它——把这次调用里所有 ≥1 分钟的等待压成一个
// tick（插件照旧调它自己的常量，覆写的是**宿主计时器**，不是插件逻辑）。
const dialogTimeoutEnv = rotateEnv({ pairs: [rotPair("session-worker-a"), rotPair("session-worker-b")] });
const dialogTimeoutToken = tokenOf(await dialogTimeoutEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(dialogTimeoutEnv.senderAgent)));
dialogTimeoutEnv.uq.script.push((request) => new Promise((_resolve, reject) => {
	request.signal.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORTED" })));
}));
const realSetTimeout = globalThis.setTimeout;
let dialogTimeoutOut;
globalThis.setTimeout = (fn, ms, ...rest) => {
	if (!(typeof ms === "number" && ms >= 60000)) return realSetTimeout(fn, ms, ...rest);
	const timer = realSetTimeout(fn, 0, ...rest);
	// 对话框预算在生产里是 unref 的（等一个人不该把壳吊住）；这里那个被压缩过的计时器
	// 恰恰是本轮唯一还活着的 handle，所以桩把它重新 ref 住（否则 node 以 exit 13 收场）。
	timer.unref = () => timer;
	return timer;
};
try {
	dialogTimeoutOut = await dialogTimeoutEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: dialogTimeoutToken }, dialogTimeoutEnv.exec(SUCCESSOR));
} finally {
	globalThis.setTimeout = realSetTimeout;
}
check("缺口1 超时读数自报真实后果（计时器到点）: 同一个读数构造器、同三段后果——计时器入口与调用方中止入口在读数上只差「发生了什么」那半句",
	dialogTimeoutEnv.role().current === SUCCESSOR && timeoutReadingOf(dialogTimeoutOut)
		&& reportLine(dialogTimeoutOut, "批准状态：").includes("分钟内未获应答")
		&& approvalTailOf(dialogTimeoutOut) === approvalTailOf(dialogAbortOut));

// 与「真的失败」分流：同一条无应答形状里只有 abort/timeout 算超时；一次**自己抛错**的对话框
// 仍逐字走既有失败文案，且两条读数不相等、超时那三个判据词一个都不出现在失败读数里。
const dialogFailEnv = rotateEnv({ askScript: [() => { throw new Error("dialog exploded"); }], pairs: [rotPair("session-worker-a"), rotPair("session-worker-b")] });
const dialogFailToken = tokenOf(await dialogFailEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(dialogFailEnv.senderAgent)));
const dialogFailOut = await dialogFailEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: dialogFailToken }, dialogFailEnv.exec(SUCCESSOR));
const dialogFailReading = reportLine(dialogFailOut, "批准状态：");
check("缺口1 互不混淆（失败 ≠ 超时）: 对话框自己抛错（非 abort/timeout）**逐字**仍走既有失败文案（那 30 个字一句未改），且与超时读数不同形——不相等，也不带超时那三个判据词",
	dialogFailReading === "批准状态：换届确认对话框失败（dialog exploded）——按无人值守路径处理：全部域内 pairs 以 provisional 迁移，24h 内未批准自动回退。（全部 2 条域内候选以 provisional 迁移。）"
		&& dialogFailReading !== reportLine(dialogAbortOut, "批准状态：") && !dialogFailReading.includes("未获应答") && !dialogFailReading.includes("这不是「调用失败」") && !dialogFailReading.includes("已落盘"));

// --- claim idempotency (the crash window between migration and settlement) --

const rotReplayEnv = rotateEnv({ pairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5 }] });
rotReplayEnv.role().current = SUCCESSOR;
rotReplayEnv.role().pending = {
	session: SUCCESSOR,
	token: "replay-token",
	team: "night-shift",
	role: "coordinator",
	expiresAt: Date.now() + 600000,
	createdAt: Date.now(),
	migratedPairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5, provisional: false, expiresAt: 0 }],
};
const rotReplayOut = await rotReplayEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: "replay-token" }, rotReplayEnv.exec(SUCCESSOR));
check("U6: a replay returns the recorded migration list instead of migrating again (claim 幂等)", rotReplayOut.includes("claim 重放") && rotReplayOut.includes("不重复迁移") && rotReplayOut.includes("session-worker-a ↔ session-new"));
check("U6: the replay leaves the trust state byte-for-byte alone (no duplicate pair, no second revocation)", pairSummary(rotReplayEnv) === "session-new↔session-worker-a" && rotReplayEnv.ns.data.pairs.length === 1);
check("U6: the replay finishes the bookkeeping — the pending is gone", rotReplayEnv.role().pending === null);
check("U6: the replay re-emits rotation-done so a crash cannot leave the team frozen", rotReplayEnv.calls("session-worker-a").followedup.at(-1).content[0].text.includes("[rotation-done]"));

const rotStaleEnv = rotateEnv();
rotStaleEnv.role().current = "session-worker-a";
rotStaleEnv.role().pending = { session: SUCCESSOR, token: "stale-token", team: "night-shift", role: "coordinator", expiresAt: Date.now() + 600000, createdAt: Date.now(), migratedPairs: [{ a: SUCCESSOR, b: "session-worker-b", createdAt: 5, provisional: false, expiresAt: 0 }] };
const rotStaleOut = await rotStaleEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: "stale-token" }, rotStaleEnv.exec(SUCCESSOR));
check("U6: a replay whose role was re-assigned clears the leftover silently instead of broadcasting a false rotation-done", rotStaleOut.includes("现任已另行变更") && rotStaleEnv.role().pending === null && rotStaleEnv.calls("session-worker-a").followedup.length === 0);

// --- the internal broadcast path: block list, sweep mode, constant bodies ---

const rotBlockedEnv = rotateEnv({ pairs: [rotPair("session-worker-a"), rotPair("session-worker-b")], blockedSenders: [ROT_SELF] });
const rotBlockedPrep = await rotBlockedEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rotBlockedEnv.senderAgent));
check("M4 广播路径: the explicit block still beats an internal notice (no sender gate, but no override either)", rotBlockedPrep.includes("rotation-freeze") && (rotBlockedPrep.match(/已屏蔽来自当前会话的消息/gu) ?? []).length === 2 && rotBlockedEnv.calls("session-worker-a").followedup.length === 0 && rotBlockedEnv.calls("session-worker-b").followedup.length === 0);

// The confirmation service IS available here: the point of the case is that the
// sweep must not USE it (no dialog is opened, no patrol blocked), which the
// request log proves far better than a refusal text.
const rotAskEnv = rotateEnv({ receiveMode: "ask" });
rotAskEnv.role().pending = { session: SUCCESSOR, token: "ask-token", team: "night-shift", role: "coordinator", expiresAt: Date.now() - 1000, createdAt: Date.now() - 31 * 60000, migratedPairs: [] };
const rotAskSweep = await rotAskEnv.rotation.sweep({ now: Date.now() });
check("M4 广播路径: a sweep-originated notice never opens a dialog — an ask receiver is skipped with a readable row", rotAskSweep.lines.join("\n").includes("不弹确认框") && rotAskEnv.uq.requests.length === 0 && rotAskEnv.calls("session-worker-a").followedup.length === 0 && rotAskEnv.role().pending === null);

const { freezeNotice: rotFreezeNotice, doneNotice: rotDoneNotice, cancelledNotice: rotCancelledNotice, expiredNotice: rotExpiredNotice, maskToken: rotMaskToken, teamMembers: rotTeamMembers, planRotationMigration: rotPlanMigration, applyRotationTrust: rotApplyTrust, rotateGate: rotRotateGate, readRoleName: rotReadRoleName } = __testing;
const rotFreezeText = rotFreezeNotice("night-shift", "coordinator", ROT_SELF, SUCCESSOR, 1700000000000);
check("M4 常量文案: rotation-freeze is the §4.2 check-list (停哨兵/后台 job → 确认无在飞 → 冻结回报 → 等待交接)", rotFreezeText.includes("停掉本会话的哨兵/看门狗与后台 job") && rotFreezeText.includes("确认没有在飞的动作") && rotFreezeText.includes("状态已冻结") && rotFreezeText.includes("等待交接结果通知"));
check("M4 常量文案: rotation-done carries the ratified/provisional status verbatim", rotDoneNotice("t", "coordinator", "a", "b", "已批准", 1).includes("信任迁移状态：已批准") && rotDoneNotice("t", "coordinator", "a", "b", "待批准(24h)", 1).includes("信任迁移状态：待批准(24h)"));
check("M4 常量文案: rotation-expired names the rollback, the retained incumbent and the honesty clause", rotExpiredNotice("t", "coordinator", SUCCESSOR, 1).includes("已自动回退") && rotExpiredNotice("t", "coordinator", SUCCESSOR, 1).includes("仍为 current") && rotDoneNotice("t", "coordinator", "a", "b", "待批准(24h)", 1).includes("不可回收"));
check("M4 常量文案: an interpolated id is scrubbed to a single line before it enters a notice body", !rotFreezeText.includes("\n") && rotFreezeNotice("team", "co\nordinator", ROT_SELF, SUCCESSOR, 1).includes("co_ordinator"));
check("M4 令牌掩码: the mask is tok-head4…tail4 (§3.6.2 example shape)", rotMaskToken("1a2b3c4d-0000-4000-8000-9f0e1d2c") === "tok-1a2b…1d2c" && rotMaskToken("abc") === "tok-…");
check("M4: a prepare gate follows the incumbent, whatever the writer policy says", rotRotateGate({ name: "t" }, { role: "coordinator", current: "s1" }, "s2").error !== undefined && rotRotateGate({ name: "t" }, { role: "coordinator", current: "s1" }, "s1").ok === true && rotRotateGate({ name: "t" }, { role: "coordinator", current: null }, "s1").error.includes("空缺"));

const rotPureTeam = {
	name: "night-shift", createdAt: 1, workspace: "", policy: { writer: "coordinator" }, rotationBackup: null,
	roles: [
		{ role: "coordinator", current: ROT_SELF, pending: null, rotationAt: 0, provisional: null, history: [] },
		{ role: "worker-a", current: "session-worker-a", pending: null, rotationAt: 0, provisional: null, history: [] },
		{ role: "vacant", current: null, pending: null, rotationAt: 0, provisional: null, history: [] },
	],
};
check("M4: teamMembers is the filled roles only, deduplicated", rotTeamMembers(rotPureTeam).join(",") === `${ROT_SELF},session-worker-a`);
const rotPlan = rotPlanMigration({ pairs: [rotPair("session-worker-a"), rotPair(ROT_OUTSIDE), { a: ROT_SELF, b: SUCCESSOR, createdAt: 3 }, { a: "session-worker-a", b: "session-worker-b", createdAt: 4 }] }, { members: new Set(rotTeamMembers(rotPureTeam)), retiree: ROT_SELF, successor: SUCCESSOR });
check("M4: the migration plan keeps in-domain counterparts only and reports the drops", rotPlan.candidates.length === 1 && rotPlan.candidates[0].other === "session-worker-a" && rotPlan.dropped.length === 2 && rotPlan.dropped.some((item) => item.reason.includes("团队域")) && rotPlan.dropped.some((item) => item.reason.includes("继任者")));
const rotTrustOut = rotApplyTrust({ pairs: [rotPair("session-worker-a"), rotPair(ROT_OUTSIDE)], trustedSenders: [ROT_SELF, "x"], rememberTargets: [ROT_SELF, "y"] }, { retiree: ROT_SELF, successor: SUCCESSOR, chosen: rotPlan.candidates, now: 5, provisional: true });
check("M4: applyRotationTrust migrates the chosen pair provisionally and revokes both lists symmetrically", rotTrustOut.pairs.length === 1 && rotTrustOut.pairs[0].a === SUCCESSOR && rotTrustOut.pairs[0].b === "session-worker-a" && rotTrustOut.pairs[0].provisional === true && rotTrustOut.pairs[0].expiresAt === 5 + 24 * 3600000 && rotTrustOut.trustedSenders.join(",") === "x" && rotTrustOut.rememberTargets.join(",") === "y" && rotTrustOut.removed.length === 2);
check("R6: readRoleName is the single gate for role names — it refuses the reserved word, not ordinary ones", rotReadRoleName("*").error !== undefined && rotReadRoleName("reviewer").value === "reviewer");

// --- M3 review riders: R5 (fan-out isolation) and R6 (reserved word) --------

const rotR5Env = fanEnv({ pairs: [pairSelf("session-worker-a"), pairSelf("session-worker-b")] });
rotR5Env.agentFor("session-worker-b").status = "running";
rotR5Env.agentFor("session-worker-b").steer = () => { throw new Error("steer exploded: R5"); };
const rotR5Out = await rotR5Env.send.execute({ targets: ["session-worker-a", "session-worker-b"], message: "R5" }, execFor(rotR5Env.senderAgent));
check("R5: a throwing target becomes its own refused row instead of killing the whole fan-out", rotR5Out.includes("- session-worker-b → refused：发送失败：投递到该目标时异常（steer exploded: R5），其余目标不受影响。"));
check("R5: the other targets keep their deliveries and the summary line is still produced", rotR5Out.includes("- session-worker-a → delivered") && rotR5Env.calls("session-worker-a").followedup.length === 1 && rotR5Out.includes("汇总：1 投递 / 1 拒绝。"));

const rotStarEnv = teamEnv({ teams: [teamRow({ writer: "any", current: "session-self" })] });
const rotStarOut = await rotStarEnv.tool("team_link_roster").execute({ action: "set-role", team: "night-shift", role: "*", session: "session-target" }, execFor(rotStarEnv.senderAgent));
check("R6: set-role refuses the addressing grammar's reserved word and creates no such role", rotStarOut.includes("寻址文法保留字") && rotStarEnv.store()[0].roles.every((entry) => entry.role !== "*"));

// --- M4 代码评审修复 #1/#2/#3/#5/#7 ----------------------------------------

// #1: the settled signal is `current === pending.session`, empty marker included.
// A rotation with no in-domain candidate migrates nothing, so its migratedPairs
// marker stays empty; a crash between the settlement and the pending clear then
// leaves exactly this state, and the replay must not run the migration path again
// (there the retiree reads as the successor itself, which would revoke the
// successor's own pairs and re-grant them provisionally, unattended).

const rotEmptyReplayEnv = rotateEnv({ pairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5 }] });
rotEmptyReplayEnv.role().current = SUCCESSOR;
rotEmptyReplayEnv.role().pending = { session: SUCCESSOR, token: "empty-marker-token", team: "night-shift", role: "coordinator", expiresAt: Date.now() + 600000, createdAt: Date.now(), migratedPairs: [] };
const rotEmptyReplayOut = await rotEmptyReplayEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: "empty-marker-token" }, rotEmptyReplayEnv.exec(SUCCESSOR));
check("评审 #1: an empty migratedPairs marker next to current=successor replays instead of migrating", rotEmptyReplayOut.includes("claim 重放") && rotEmptyReplayOut.includes("不重复迁移") && !rotEmptyReplayOut.includes("对称撤销"));
check("评审 #1: ... the successor's own pairs survive the replay byte-for-byte", pairSummary(rotEmptyReplayEnv) === "session-new↔session-worker-a" && rotEmptyReplayEnv.ns.data.pairs.length === 1);
check("评审 #1: ... and the replay still finishes the bookkeeping and re-emits rotation-done", rotEmptyReplayEnv.role().pending === null && rotEmptyReplayEnv.calls("session-worker-a").followedup.at(-1).content[0].text.includes("[rotation-done]"));
// #4: the replay is the step that finishes the bookkeeping, so it must rewrite the
// mirror — otherwise roster.md keeps showing a pending the settings no longer have.
const rotReplayMirrorEnv = rotateEnv({ pairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5 }] });
rotReplayMirrorEnv.role().current = SUCCESSOR;
rotReplayMirrorEnv.role().pending = { session: SUCCESSOR, token: "mirror-replay-token", team: "night-shift", role: "coordinator", expiresAt: Date.now() + 600000, createdAt: Date.now(), migratedPairs: [] };
await rotReplayMirrorEnv.roster.execute({ action: "upsert-team", team: "night-shift" }, rotReplayMirrorEnv.exec(SUCCESSOR));
const rotReplayMirrorBefore = await readFile(mirrorFile, "utf8");
check("评审 #4 前置: the mirror truthfully renders the leftover pending (masked) before the replay", rotReplayMirrorBefore.includes("tok-mirr…oken") && rotReplayMirrorBefore.includes("已迁移 0 条"));
await rotReplayMirrorEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: "mirror-replay-token" }, rotReplayMirrorEnv.exec(SUCCESSOR));
const rotReplayMirrorAfter = await readFile(mirrorFile, "utf8");
check("评审 #4: the replay rewrites the mirror — the leftover pending leaves no line behind", !rotReplayMirrorAfter.includes("tok-") && /### coordinator[\s\S]*?- pending：（无）/u.test(rotReplayMirrorAfter));

// #1 (sweep half): the same state at expiry is bookkeeping, not an unclaimed token.
const rotSettledSweepEnv = rotateEnv();
rotSettledSweepEnv.role().current = SUCCESSOR;
rotSettledSweepEnv.role().pending = { session: SUCCESSOR, token: "settled-sweep-token", team: "night-shift", role: "coordinator", expiresAt: Date.now() - 1000, createdAt: Date.now() - 31 * 60000, migratedPairs: [] };
const rotSettledSweep = await rotSettledSweepEnv.rotation.sweep({ now: Date.now() });
check("评审 #1: the sweep reads a settled roster (empty marker included) as settled — pending goes silently, no rotation-cancelled", rotSettledSweep.cancelled.length === 0 && rotSettledSweep.lines.length === 0 && rotSettledSweepEnv.role().pending === null && rotSettledSweepEnv.calls("session-worker-a").followedup.length === 0);

const rotSettledExpiredEnv = rotateEnv({ pairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5 }] });
rotSettledExpiredEnv.role().current = SUCCESSOR;
rotSettledExpiredEnv.role().pending = { session: SUCCESSOR, token: "settled-expired-token", team: "night-shift", role: "coordinator", expiresAt: Date.now() - 1000, createdAt: Date.now() - 31 * 60000, migratedPairs: [] };
const rotSettledExpiredOut = await rotSettledExpiredEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: "settled-expired-token" }, rotSettledExpiredEnv.exec(SUCCESSOR));
check("评审 #1: an expired token on a settled roster refuses with the truth — no false '旧任仍为 current', no cancelled broadcast, pending cleared", rotSettledExpiredOut.includes("已经落定") && rotSettledExpiredOut.includes("静默清除 pending") && !rotSettledExpiredOut.includes("仍为 current") && rotSettledExpiredEnv.calls("session-worker-a").followedup.length === 0 && rotSettledExpiredEnv.role().pending === null);

// #2: 补批准 (settings UI flips the pair's provisional flag) keeps the role window
// open, so the window expires with nothing to roll back. Recording "provisional
// 未批准过期" and broadcasting "迁移的 pairs 已删除" would both be false statements.
const rotRatifiedEnv = rotateEnv({ omitUserQuestions: true, pairs: [rotPair("session-worker-a"), rotPair("session-worker-b")] });
const rotRatifiedToken = tokenOf(await rotRatifiedEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rotRatifiedEnv.senderAgent)));
const rotRatifiedAt = Date.now();
await rotRatifiedEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: rotRatifiedToken }, rotRatifiedEnv.exec(SUCCESSOR));
for (const pair of rotRatifiedEnv.ns.data.pairs) pair.provisional = false;
check("评审 #2 前置: 补批准 flips the pairs only — the role window is still open", rotRatifiedEnv.role().provisional !== null && rotRatifiedEnv.ns.data.pairs.every((pair) => pair.provisional === false));
const rotRatifiedSweep = await rotRatifiedEnv.rotation.sweep({ now: rotRatifiedAt + 24 * 3600000 + 60000 });
check("评审 #2: a ratified window closes silently — no rotation-expired, no '未批准过期' history entry", rotRatifiedSweep.expired.length === 0 && rotRatifiedSweep.closed.length === 1 && rotRatifiedEnv.role().provisional === null && rotRatifiedEnv.role().history.every((record) => record.note !== "provisional 未批准过期") && rotRatifiedEnv.calls("session-worker-a").followedup.every((message) => !message.content[0].text.includes("[rotation-expired]")));
check("评审 #2: ... the ratified channels are kept and the sweep says why it closed the window", rotRatifiedEnv.ns.data.pairs.length === 2 && pairSummary(rotRatifiedEnv) === "session-new↔session-worker-a session-new↔session-worker-b" && rotRatifiedSweep.lines.join("\n").includes("provisional 窗口静默关闭"));

// #3: an internal notice never waits on a receiver dialog — prepare/claim included.
const rotAskNoticeEnv = rotateEnv({ receiveMode: "ask" });
const rotAskNoticePrep = await rotAskNoticeEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rotAskNoticeEnv.senderAgent));
check("评审 #3: an ask-mode member receives the internal freeze as a skipped row — no dialog, no wait", rotAskNoticeEnv.uq.requests.length === 0 && rotAskNoticeEnv.calls("session-worker-a").followedup.length === 0 && rotAskNoticeEnv.calls("session-worker-b").followedup.length === 0 && rotAskNoticePrep.includes("rotation-freeze"));
check("评审 #3: the skipped row is recorded per target and names the two ways to receive it later", (rotAskNoticePrep.match(/→ refused：未投递：目标会话的接收策略为逐条确认（ask），而插件内部通知/gu) ?? []).length === 2 && rotAskNoticePrep.includes("不弹确认框"));
const rotAskNoticeClaim = await rotAskNoticeEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: tokenOf(rotAskNoticePrep) }, rotAskNoticeEnv.exec(SUCCESSOR));
check("评审 #3: the claim's own rotation-done notice takes the same non-blocking path", rotAskNoticeEnv.uq.requests.length === 0 && rotAskNoticeClaim.includes("通知广播（rotation-done，新任为发送方）：0 投递"));

// #5: nothing to migrate means nobody was asked — the verdict word must not say
// "已批准" (and must not claim a rollback window that was never opened).
const rotNoneEnv = rotateEnv();
const rotNonePrep = await rotNoneEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rotNoneEnv.senderAgent));
const rotNoneClaim = await rotNoneEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: tokenOf(rotNonePrep) }, rotNoneEnv.exec(SUCCESSOR));
check("评审 #5: a rotation with no in-domain candidate opens no dialog and claims no approval", rotNoneEnv.uq.requests.length === 0 && rotNoneClaim.includes("无域内待迁移对：未弹确认框") && !rotNoneClaim.includes("已获在场确认") && rotNoneClaim.includes("回退窗口：本次换届没有新建任何通道"));
check("评审 #5: ... the done notice carries the same verdict word instead of 已批准", rotNoneEnv.calls("session-worker-a").followedup.at(-1).content[0].text.includes("信任迁移状态：无待迁移对") && !rotNoneEnv.calls("session-worker-a").followedup.at(-1).content[0].text.includes("24h 内未获批准将自动回退"));
check("评审 #5: ... and the roster opened no provisional window", rotNoneEnv.role().provisional === null && rotNoneEnv.role().current === SUCCESSOR && rotNoneEnv.role().pending === null);

// #7: team_read is a third lazy trigger, so a frozen team that only reads the
// board still gets its notice (the patrol timer only exists per registration).
const rotReadSweepEnv = rotateEnv({ pairs: [rotPair("session-worker-a")] });
rotReadSweepEnv.role().pending = { session: SUCCESSOR, token: "read-sweep-token", team: "night-shift", role: "coordinator", expiresAt: Date.now() - 1000, createdAt: Date.now() - 31 * 60000, migratedPairs: [] };
const rotReadSweepOut = await rotReadSweepEnv.tool("team_link_team_read").execute({ team: "night-shift" }, execFor(rotReadSweepEnv.senderAgent));
check("评审 #7: team_read triggers the expiry sweep — the stranded pending is cleared and rotation-cancelled is broadcast", rotReadSweepEnv.role().pending === null && rotReadSweepEnv.calls("session-worker-a").followedup.some((message) => message.content[0].text.includes("[rotation-cancelled]")));
check("评审 #7: ... and the read itself still returns the board (the sweep is not a substitute for it)", rotReadSweepOut.includes("黑板（根：") && rotReadSweepOut.includes("roster（概要"));

// --- M4 代码评审 round 2 修复 #8/#9/#10 (§3.6.2) ---------------------------

// #8 (投递侧守门): a rotation-granted pair stops being a pair at its 24h deadline,
// not only when the next sweep happens to delete the row. Treated as a pair, the
// expired channel would keep bypassing BOTH approval gates — the "24h 自动回退"
// promise silently false for exactly the window between deadline and sweep.

const ROT_PAIR_NOW = 1_700_000_000_000;
check("评审 #8: pairRecordBetween reads a past-deadline provisional record as NO pair (boundary included), and a session re-paired afterwards is not shadowed by the dead row", (() => {
	const dead = { a: "s1", b: "s2", createdAt: 1, provisional: true, expiresAt: ROT_PAIR_NOW - 1 };
	const atDeadline = { ...dead, expiresAt: ROT_PAIR_NOW };
	const live = { a: "s1", b: "s2", createdAt: 2, provisional: false, expiresAt: 0 };
	return __testing.pairRecordBetween({ pairs: [dead] }, "s1", "s2", ROT_PAIR_NOW) === null
		&& __testing.pairRecordBetween({ pairs: [atDeadline] }, "s1", "s2", ROT_PAIR_NOW) === null
		&& __testing.pairRecordBetween({ pairs: [dead] }, "s2", "s1", ROT_PAIR_NOW) === null
		&& __testing.pairRecordBetween({ pairs: [dead, live] }, "s1", "s2", ROT_PAIR_NOW) === live
		&& __testing.pairRecordBetween({ pairs: [{ ...dead, expiresAt: ROT_PAIR_NOW + 1 }] }, "s1", "s2", ROT_PAIR_NOW) !== null;
})());

const rotExpiredPairEnv = rotateEnv({
	pairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5, provisional: true, expiresAt: Date.now() - 1000 }],
	receiveMode: "reject",
	rememberTargets: ["session-worker-a"],
});
const rotExpiredPairSend = await rotExpiredPairEnv.send.execute({ targetSessionId: "session-worker-a", message: "窗口已过" }, rotExpiredPairEnv.exec(SUCCESSOR));
check("评审 #8: a delivery over an expired provisional pair walks the ordinary gates again — the receiver's reject policy bites", rotExpiredPairSend.includes("接收策略为全部拒绝") && !rotExpiredPairSend.includes("provisional 通道") && rotExpiredPairEnv.calls("session-worker-a").followedup.length === 0);

const rotDemotedPairEnv = rotateEnv({
	pairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5, provisional: true, expiresAt: Date.now() - 1000 }],
	askScript: ["发送"],
});
const rotDemotedPairSend = await rotDemotedPairEnv.send.execute({ targetSessionId: "session-worker-a", message: "退回过门" }, rotDemotedPairEnv.exec(SUCCESSOR));
check("评审 #8: ... and the sender-side gate is walked too — the confirmation dialog is raised, and the delivery is a plain (non-paired) one", rotDemotedPairEnv.uq.requests.length === 1 && rotDemotedPairSend.includes("已投递到") && !rotDemotedPairSend.includes("已配对通道") && !rotDemotedPairSend.includes("provisional 通道"));

const rotLivePairEnv = rotateEnv({
	pairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5, provisional: true, expiresAt: Date.now() + 3600000 }],
	receiveMode: "reject",
	rememberTargets: ["session-worker-a"],
});
const rotLivePairSend = await rotLivePairEnv.send.execute({ targetSessionId: "session-worker-a", message: "窗口内" }, rotLivePairEnv.exec(SUCCESSOR));
check("评审 #8 对照: a provisional pair still INSIDE its window keeps the fast path — the guard is the deadline, not the provisional flag", rotLivePairSend.includes("provisional 通道，24h 内未批准自动回退") && rotLivePairEnv.calls("session-worker-a").followedup.length === 1);

// #8 (清扫侧): the user can hand-delete the role's provisional window (or the whole
// role/team row) in the settings UI and keep the pairs it granted. The doomed-pair
// deletion must not sit behind the "did any role need bookkeeping?" guard.
const rotOrphanSweepEnv = rotateEnv({ pairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5, provisional: true, expiresAt: Date.now() - 1000 }] });
check("评审 #8 前置: the role carries no provisional window and no pending — the window was hand-deleted, the channel was not", (rotOrphanSweepEnv.role().provisional ?? null) === null && rotOrphanSweepEnv.role().pending === null && rotOrphanSweepEnv.ns.data.pairs.length === 1);
const rotOrphanSweep = await rotOrphanSweepEnv.rotation.sweep({ now: Date.now() });
check("评审 #8: the sweep deletes the expired provisional pairs anyway — the rollback needs no role bookkeeping", rotOrphanSweep.cancelled.length === 0 && rotOrphanSweep.expired.length === 0 && rotOrphanSweep.closed.length === 0 && rotOrphanSweep.lines.length === 0 && rotOrphanSweepEnv.ns.data.pairs.length === 0);

const rotOrphanTeamEnv = rotateEnv({ pairs: [{ a: SUCCESSOR, b: "session-worker-b", createdAt: 5, provisional: true, expiresAt: Date.now() - 1000 }] });
rotOrphanTeamEnv.ns.data.teams = [];
const rotOrphanTeamSweep = await rotOrphanTeamEnv.rotation.sweep({ now: Date.now() });
check("评审 #8: ... and the same holds when the whole role/team row is gone from the registry", rotOrphanTeamSweep.lines.length === 0 && rotOrphanTeamEnv.ns.data.pairs.length === 0);

const rotOrphanKeepEnv = rotateEnv({ pairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5, provisional: true, expiresAt: Date.now() + 3600000 }] });
const rotOrphanKeepSweep = await rotOrphanKeepEnv.rotation.sweep({ now: Date.now() });
check("评审 #8 对照: a provisional pair still inside its window is not deleted early (the sweep is not a blanket purge)", rotOrphanKeepSweep.lines.length === 0 && rotOrphanKeepEnv.ns.data.pairs.length === 1);

// #9: applySetRole must invalidate an in-flight token when it seats the very
// session that token prepared. Left alive, the successor's own claim reads
// `current === pending.session` as "the previous claim already settled" and
// replays: it reports the hand-over as landed while the symmetric revocation never
// ran — the retiree keeps a 免门 channel alive, and the design's "成功即作废" is
// bypassed for exactly the case it was written for.

const rotSetRoleFixture = {
	name: "night-shift", createdAt: 1, workspace: "", policy: { writer: "coordinator" }, rotationBackup: null,
	roles: [{ role: "coordinator", current: "s1", pending: { session: "s2", token: "t", team: "night-shift", role: "coordinator", expiresAt: 9, createdAt: 1 }, rotationAt: 0, provisional: null, rotationStatus: "", history: [] }],
};
check("评审 #9: seating the pending's successor clears the token; seating anyone else keeps it", (() => {
	const cleared = __testing.applySetRole(rotSetRoleFixture, { role: "coordinator", session: "s2", now: 5 });
	const kept = __testing.applySetRole(rotSetRoleFixture, { role: "coordinator", session: "s3", now: 5 });
	return cleared.clearedPending === true && cleared.team.roles[0].pending === null && cleared.team.roles[0].current === "s2"
		&& kept.clearedPending === false && kept.team.roles[0].pending !== null && kept.team.roles[0].pending.token === "t" && kept.team.roles[0].current === "s3";
})());

const rotSuccessionEnv = rotateEnv({ pairs: [rotPair("session-worker-a"), rotPair("session-worker-b")] });
const rotSuccessionToken = tokenOf(await rotSuccessionEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rotSuccessionEnv.senderAgent)));
check("评审 #9 前置: prepare left a pending bound to the successor", rotSuccessionEnv.role().pending.session === SUCCESSOR && rotSuccessionEnv.role().current === ROT_SELF);
const rotSuccessionSet = await rotSuccessionEnv.roster.execute({ action: "set-role", team: "night-shift", role: "coordinator", session: SUCCESSOR }, execFor(rotSuccessionEnv.senderAgent));
check("评审 #9: the set-role clears the token and says so (the successor is now the incumbent by an explicit writer action, not by a claim)", rotSuccessionEnv.role().pending === null && rotSuccessionEnv.role().current === SUCCESSOR && rotSuccessionSet.includes("已设置") && rotSuccessionSet.includes("已作废在飞令牌"));
const rotSuccessionClaim = await rotSuccessionEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: rotSuccessionToken }, rotSuccessionEnv.exec(SUCCESSOR));
check("评审 #9: the token is then refused as 「没有 pending」 instead of being replayed as an already-settled rotation", rotSuccessionClaim.includes("没有 pending") && !rotSuccessionClaim.includes("claim 重放"));
check("评审 #9: ... so no symmetric revocation was silently skipped — the retiree's pairs are untouched and the only notice is the prepare's freeze", pairSummary(rotSuccessionEnv) === "session-self↔session-worker-a session-self↔session-worker-b" && rotSuccessionEnv.calls("session-worker-a").followedup.length === 1 && rotSuccessionEnv.calls("session-worker-a").followedup.every((message) => !message.content[0].text.includes("[rotation-done]")));

// #10: the replay reads the verdict word the claim recorded instead of re-deriving
// it. A dialog answered with every candidate unchecked is ratified (已批准) yet
// migrates no pair and opens no window — the old derivation replayed that same
// rotation as 无待迁移对.

const rotUncheckedEnv = rotateEnv({ askScript: [[]], pairs: [rotPair("session-worker-a")] });
const rotUncheckedToken = tokenOf(await rotUncheckedEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rotUncheckedEnv.senderAgent)));
const rotUncheckedClaim = await rotUncheckedEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: rotUncheckedToken }, rotUncheckedEnv.exec(SUCCESSOR));
check("评审 #10 前置: the dialog was answered with nothing checked — ratified, no pair migrated, no window opened", rotUncheckedClaim.includes("已获在场确认") && rotUncheckedClaim.includes("勾选 0 / 候选 1 条") && rotUncheckedEnv.role().provisional === null && rotUncheckedEnv.ns.data.pairs.filter((pair) => pair.a === SUCCESSOR || pair.b === SUCCESSOR).length === 0);
check("评审 #10: the claim records its verdict word on the role, in the same write as the settlement", rotUncheckedEnv.role().rotationStatus === "已批准");
check("评审 #10: the settled rotation's done notice carries 已批准", rotUncheckedEnv.calls("session-worker-a").followedup.at(-1).content[0].text.includes("信任迁移状态：已批准"));

// The crash window of §3.6.2: the settlement (with its marker, its recorded word
// and the settled roster) landed, the pending clear did not. The replay reads the
// recorded word back.
rotUncheckedEnv.role().pending = { session: SUCCESSOR, token: rotUncheckedToken, team: "night-shift", role: "coordinator", expiresAt: Date.now() + 600000, createdAt: Date.now(), migratedPairs: [] };
const rotUncheckedReplay = await rotUncheckedEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: rotUncheckedToken }, rotUncheckedEnv.exec(SUCCESSOR));
check("评审 #10: the replay of that rotation re-emits the SAME word — it does not degrade to 无待迁移对", rotUncheckedReplay.includes("claim 重放") && rotUncheckedEnv.calls("session-worker-a").followedup.at(-1).content[0].text.includes("信任迁移状态：已批准") && !rotUncheckedEnv.calls("session-worker-a").followedup.at(-1).content[0].text.includes("无待迁移对"));

// fallback 对照: a settings row written before the field existed carries no word,
// and the replay still works through the derivation (the same end-to-end path the
// existing #1 replay cases take).
const rotLegacyStatusEnv = rotateEnv({ pairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5 }] });
rotLegacyStatusEnv.role().current = SUCCESSOR;
rotLegacyStatusEnv.role().pending = { session: SUCCESSOR, token: "legacy-status-token", team: "night-shift", role: "coordinator", expiresAt: Date.now() + 600000, createdAt: Date.now(), migratedPairs: [{ a: SUCCESSOR, b: "session-worker-a", createdAt: 5, provisional: false, expiresAt: 0 }] };
await rotLegacyStatusEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: "legacy-status-token" }, rotLegacyStatusEnv.exec(SUCCESSOR));
check("评审 #10 fallback 对照: a role row without the recorded word (pre-field settings row) still replays through the derivation", rotLegacyStatusEnv.role().rotationStatus === "" && rotLegacyStatusEnv.calls("session-worker-a").followedup.at(-1).content[0].text.includes("信任迁移状态：已批准"));
check("评审 #10: rotationStatus is a declared role field — a settings round-trip keeps the word instead of stripping it", (() => {
	const roundTrip = __testing.normalizeTeams([{ name: "night-shift", roles: [{ role: "coordinator", current: "s1", pending: null, rotationAt: 0, provisional: null, rotationStatus: "无待迁移对", history: [] }] }]);
	const withoutWord = __testing.normalizeTeams([{ name: "night-shift", roles: [{ role: "coordinator", current: "s1", pending: null, rotationAt: 0, provisional: null, history: [] }] }]);
	return roundTrip[0].roles[0].rotationStatus === "无待迁移对" && withoutWord[0].roles[0].rotationStatus === "";
})());

// --- §5.3 红线: the plugin never re-arms a goal itself ----------------------

const rotGoalEnv = rotateEnv({ goals: { [SUCCESSOR]: { phase: "active", activation: "disarmed", roundsStarted: 3, maxGoalRounds: 70 } }, pairs: [rotPair("session-worker-a")], askScript: [["session-worker-a"]] });
let rotResumeCalls = 0;
rotGoalEnv.ctx.get("goals").resume = () => { rotResumeCalls += 1; };
const rotGoalPrep = await rotGoalEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(rotGoalEnv.senderAgent));
const rotGoalClaim = await rotGoalEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: tokenOf(rotGoalPrep) }, rotGoalEnv.exec(SUCCESSOR));
check("M4 红线: a whole rotation never calls goals.resume — the successor is only ADVISED (§3.7 合规回路)", rotResumeCalls === 0 && rotGoalClaim.includes("换届完成") && rotGoalPrep.includes("/goal resume"));

// ---------------------------------------------------------------------------
// §11.9.6 交接文档契约（③a）：三层结构 · 五硬节缺项阶梯 · 与 claim 同一事实源
// ---------------------------------------------------------------------------
//
// 这一组只钉「契约层」：纯校验器、渲染器与写入器。工具入口处的端到端证明
// （auto + 空正文 ⇒ 零建会话零令牌零 freeze，用提供方侧计数读数）属于 §11 的
// auto 编排，落在下一组断言里——本组先把「阶梯怎么判、文档长什么样」锁住。

const HANDOFF_WS = path.join(TEAM_TMP, "handoff-ws");
/** 本组自己的源码读数（`hostSource` 在文件末尾才定义，这里不能借它：顶层 const
 * 的 TDZ 会让整跑直接崩）。 */
const handoffSource = await readFile(fileURLToPath(new URL("./lib/index.js", import.meta.url)), "utf8");

/** 每个节的正文样例行，测试侧的单一来源：**硬节与软节的名单改一个名字，这里就
 * 必须同改**（下面第一条断言就是这把锁）。 */
const HANDOFF_LINE = {
	mission: "角色对团队负责什么：把夜班协调职责交到下一位手上，保证在飞事项不丢。",
	"in-flight": "- 夜间巡检脚本（session-worker-a）：已跑 3 轮，下一步补日志。",
	commitments: "- 答应 session-worker-b 周三前给出信任现状说明。",
	unknowns: "- 不知道 session-worker-c 是否还在跑：没有人回报过。",
	"task-and-goal": "- 当前 goal：phase=active、activation=disarmed（没有 armed 的 goal 可续）→ 上任第一件事 /goal resume。",
	"first-actions": "- 先 /goal resume，再读 decisions.md 末 20 条。",
	"team-map": "- coordinator / worker-a / worker-b；worker-c 状态未知。",
	conventions: "- 黑板 decisions.md 只追加；换届只走 team_link_rotate。",
};

/** 按 §11.9.6 的正文写法拼一份交接正文，`omit` 里的节整个不写。 */
function handoffBody(omit = [], override = {}) {
	const lines = [];
	for (const [name, line] of Object.entries(HANDOFF_LINE)) {
		if (omit.includes(name)) continue;
		lines.push(`## ${name}`, override[name] ?? line, "");
	}
	return lines.join("\n");
}

const handoffAll = handoffBody();

check("§11.9.6 同改锁: 硬节/软节名单、脚手架、提示语与测试样例是同一套名字（名单改一个名字，这条就红）", (() => {
	const declared = [...__testing.HANDOFF_HARD_SECTIONS, ...__testing.HANDOFF_SOFT_SECTIONS];
	const scaffold = __testing.handoffScaffold();
	return sameJson(declared, Object.keys(HANDOFF_LINE))
		&& __testing.HANDOFF_HARD_SECTIONS.every((name) => typeof __testing.HANDOFF_SECTION_HINTS[name] === "string" && __testing.HANDOFF_SECTION_HINTS[name] !== "")
		&& sameJson(Object.keys(__testing.HANDOFF_SECTION_HINTS), [...__testing.HANDOFF_HARD_SECTIONS])
		&& declared.every((name) => scaffold.includes(`## ${name}`))
		&& __testing.HANDOFF_HARD_SECTIONS.every((name) => scaffold.includes(__testing.HANDOFF_SECTION_HINTS[name]));
})());

check("§11.9.6 解析: 标题层级 / 大小写 / 下划线 / 尾冒号都折成同一个节名（模型真写了就不该因样式被拒）", (() => {
	const names = ["## Task and Goal:", "### task_and_goal", "# TASK-AND-GOAL", "  ##   task-and-goal  "].map((heading) => {
		const parsed = __testing.parseHandoffBody(`${heading}\n正文一行`);
		return parsed.sections.length === 1 ? parsed.sections[0].name : `（未识别：${heading}）`;
	});
	const homed = __testing.parseHandoffBody("开场白一段\n\n## mission\n职责");
	return names.every((name) => name === "task-and-goal") && homed.preamble.join("").includes("开场白") && homed.sections[0].name === "mission" && homed.sections[0].lines.join("").trim() === "职责";
})());

// --- 缺项阶梯（§11.9.6 的第一张表） -----------------------------------------

const handoffMissing = __testing.readHandoffArgument(undefined, { auto: true });
check("§11.9.6 阶梯: auto + 正文缺失 → 拒绝（工具入口），文案给出五硬节脚手架并明说零建会话/零令牌/零 freeze", handoffMissing.error !== undefined && handoffMissing.error.includes("零建会话、零令牌、零 freeze") && __testing.HANDOFF_HARD_SECTIONS.every((name) => handoffMissing.error.includes(`## ${name}`)) && __testing.HANDOFF_SOFT_SECTIONS.every((name) => handoffMissing.error.includes(`## ${name}`)));

const handoffBlank = ["", "   ", "\n\t\n"].map((value) => __testing.readHandoffArgument(value, { auto: true }));
check("§11.9.6 阶梯: auto + 正文为空或纯空白 → 同样拒绝（空白正文等于没有正文）", handoffBlank.every((result) => result.error !== undefined && result.error.includes("交接正文缺失或为空")));

const handoffHardGaps = __testing.HANDOFF_HARD_SECTIONS.map((name) => {
	const result = __testing.readHandoffArgument(handoffBody([name]), { auto: true });
	const head = (result.error ?? "").split("\n")[0];
	const others = __testing.HANDOFF_HARD_SECTIONS.filter((other) => other !== name);
	return result.error !== undefined && head.includes(`${name}（缺）`) && !others.some((other) => head.includes(other)) && head.includes("零建会话、零令牌、零 freeze");
});
check(`§11.9.6 阶梯: 硬节缺 → 逐条点名（五个硬节各缺一次，每次只点名缺的那个：${handoffHardGaps.filter(Boolean).length}/5 通过）`, handoffHardGaps.every(Boolean));

const handoffEmptySection = __testing.readHandoffArgument(handoffBody([], { unknowns: "   " }), { auto: true });
check("§11.9.6 阶梯: 硬节在场但正文为空 → 同样拒绝（结构门查的是「在场 / 非空 / 有界」）", handoffEmptySection.error !== undefined && (handoffEmptySection.error.split("\n")[0]).includes("unknowns（空）") && !(handoffEmptySection.error.split("\n")[0]).includes("mission"));

const handoffSoftGap = __testing.readHandoffArgument(handoffBody(["team-map", "conventions"]), { auto: true });
check("§11.9.6 阶梯: 软节缺 → 放行 + 警告（点名缺哪些软节）", handoffSoftGap.error === undefined && handoffSoftGap.body === handoffBody(["team-map", "conventions"]) && handoffSoftGap.warnings.some((line) => line.includes("缺软节：team-map、conventions")));

const handoffComplete = __testing.readHandoffArgument(handoffAll, { auto: true });
check("§11.9.6 阶梯: 五个硬节齐全 → 放行，警告行如实说「结构完整」", handoffComplete.error === undefined && handoffComplete.warnings.some((line) => line.includes("结构完整") && line.includes("硬节 5/5") && line.includes("软节 3/3")));

const handoffTodo = __testing.readHandoffArgument(handoffBody([], Object.fromEntries(__testing.HANDOFF_HARD_SECTIONS.map((name) => [name, "TODO"]))), { auto: true });
check("§11.9.6 诚实原则: 内容质量不被检查——五节全是 TODO 也放行（presence 门防遗忘、不防敷衍）", handoffTodo.error === undefined && handoffTodo.warnings.some((line) => line.includes("结构完整")));

const handoffExplicit = __testing.readHandoffArgument(undefined, { auto: false });
check("§11.9.6 阶梯: 显式 successor + 无正文 → 放行 + 警告（M4 现语义不收紧：那个会话有自己的生命与上下文）", handoffExplicit.error === undefined && handoffExplicit.body === "" && handoffExplicit.warnings.some((line) => line.includes("显式指定的继任者有自己的会话与上下文")));
// 🟡-6: 拒绝文案的路径标签按**当次调用**渲染，不按写这个分支时设想的路径。缺项阶梯的
// **缺硬节**那条只要正文有过、就与「哪条 successor 形态」无关（`readHandoffArgument`
// 的同一条分支同时服务两种形态），所以它才是「同一段代码、两种路径」的真判据；而
// 「正文缺失」那条今天只有 auto 分支会产出拒绝（显式 successor + 无正文 = 放行 + 警告，
// §11.9.6），所以显式形态在这条上没有拒绝可断言 —— 这里就把这件事本身断出来。
const handoffRefuseAuto = __testing.readHandoffArgument(undefined, { auto: true });
const handoffRefuseExplicit = __testing.readHandoffArgument(undefined, { auto: false });
const handoffMissingHardAuto = __testing.readHandoffArgument(handoffBody(["unknowns"]), { auto: true });
const handoffMissingHardPathLabels = [];
for (const flag of [true, false]) {
	const parsed = __testing.readHandoffArgument(handoffBody(["unknowns"]), { auto: flag });
	const head = (parsed.error ?? "").split("\n")[0];
	handoffMissingHardPathLabels.push(head.includes(flag ? "prepare 被拒绝（successor:\"auto\" + 交接正文缺硬节）" : "prepare 被拒绝（显式 successor + 交接正文缺硬节）"));
}
check("🟡-6 路径文案: 拒绝文案里的路径标签由**当次调用的 successor 形态**渲染——同一条「缺硬节」分支在 auto 下写 successor:\"auto\"、在显式 successor 下写「显式 successor」，都不被标成对方那条路径"
	+ (handoffMissingHardPathLabels.every(Boolean) ? "" : `（实测：auto=${show(handoffMissingHardPathLabels[0])} 显式=${show(handoffMissingHardPathLabels[1])}）`),
(handoffRefuseAuto.error ?? "").includes("prepare 被拒绝（successor:\"auto\" + 交接正文缺失或为空）")
	&& handoffRefuseExplicit.error === undefined
	&& (handoffMissingHardAuto.error ?? "").includes("prepare 被拒绝（successor:\"auto\" + 交接正文缺硬节）")
	&& handoffMissingHardPathLabels.every(Boolean));

// --- 文档定位与三层渲染 ------------------------------------------------------

const handoffEnv = rotateEnv({ teams: [{ name: "night-shift", createdAt: 1_700_000_000_000, workspace: HANDOFF_WS, policy: { writer: "coordinator" }, roles: rotRoles() }] });
const HANDOFF_TOKEN = "11111111-2222-3333-4444-555555555555";
const HANDOFF_NOW = Date.now();
const handoffFacts = __testing.rotationFactRows({
	retiree: ROT_SELF,
	successor: SUCCESSOR,
	candidates: [{ pair: { a: ROT_SELF, b: "session-worker-a", createdAt: 1 }, other: "session-worker-a" }],
	dropped: [{ pair: { a: ROT_SELF, b: ROT_OUTSIDE, createdAt: 1 }, other: ROT_OUTSIDE, reason: "对端不在本团队域内（§3.6.1 原则 2）" }],
	removedCount: 3,
	trustedSenderCount: 1,
	rememberTargetCount: 1,
});
const handoffDocPath = __testing.handoffDocumentPath(handoffEnv.team(), "coordinator", HANDOFF_NOW);
check("§11.9.6 定位: 文档落在黑板目录、文件名 handoff-<role>-<时间戳>.md（时间戳即天然不冲突，故不需要 baseHash 锁）", path.dirname(handoffDocPath) === path.join(HANDOFF_WS, "team", "night-shift") && /^handoff-coordinator-\d{8}-\d{6}\.md$/u.test(path.basename(handoffDocPath)));

const handoffWrite = await __testing.writeHandoffDocument(handoffEnv.team(), {
	roleName: "coordinator",
	previous: ROT_SELF,
	successor: SUCCESSOR,
	token: HANDOFF_TOKEN,
	preparedAt: HANDOFF_NOW,
	body: handoffAll,
	report: __testing.handoffBodyReport(handoffAll),
	facts: handoffFacts,
});
check("§11.9.6 写入: 交接文档落盘（整文件写；黑板单行 500 码点上限不适用于契约文档）", handoffWrite.ok === true && handoffWrite.path === handoffDocPath && existsSync(handoffDocPath));
const handoffText = await readFile(handoffDocPath, "utf8");
const HANDOFF_HEADER_NEEDLES = ["schema: team-link/handoff/1", "team: night-shift", "role: coordinator", `previous: ${ROT_SELF}`, `successor: ${SUCCESSOR}`, "preparedAt: ", "claimedAt: ", `tokenMask: tok-${HANDOFF_TOKEN.slice(0, 4)}…${HANDOFF_TOKEN.slice(-4)}`, "rotationStatus: ", "integrity: 结构完整：硬节 5/5"];
const handoffHeaderMissing = HANDOFF_HEADER_NEEDLES.filter((line) => !handoffText.includes(line));
check(`§11.9.6 头部: schema / team / role / 前后任 id / preparedAt / claimedAt / 令牌掩码 / rotationStatus / 完整性判定 一项不少${handoffHeaderMissing.length === 0 ? "" : `（缺：${JSON.stringify(handoffHeaderMissing)}）`}`, handoffHeaderMissing.length === 0);
check("§11.9.6 头部: 头部只给掩码——明文令牌不进任何落盘文件（§3.6.2 评审 #3 的纪律）", !handoffText.includes(HANDOFF_TOKEN) && handoffText.includes("tok-1111…5555"));
check("§11.9.6 头部: claimedAt 位置说明「本文件写于 prepare 之前、claim 时不复验、不追写」", handoffText.includes("本文件写于 prepare 之前") && handoffText.includes("claim 时不复验文档，本文件不追写"));
const HANDOFF_FACT_NEEDLES = [
	__testing.freezeNotice("night-shift", "coordinator", ROT_SELF, SUCCESSOR, HANDOFF_NOW),
	...handoffFacts.migration,
	...handoffFacts.dropped,
	handoffFacts.revocation[0],
	__testing.provisionalGuidance({ now: HANDOFF_NOW, successor: SUCCESSOR, provisional: true, status: "" }),
];
const handoffFactMissing = HANDOFF_FACT_NEEDLES.filter((line) => !handoffText.includes(line));
check(`§11.9.6 事实段: 与 claim 同一事实源——freeze 正文用投出去的那条常量、迁移/未迁移/对称吊销行用同一个构造器、provisional 回退窗口用同一个函数${handoffFactMissing.length === 0 ? "" : `（缺：${JSON.stringify(handoffFactMissing)}）`}`, handoffFactMissing.length === 0);
check("§11.9.6 事实段: 写于 prepare 之前的那几行如实标注（freeze 投递结果 / 上一份交接文档 / 下一份尚未写入）", handoffText.includes("本文件先于广播写入") && handoffText.includes("上一份：（无——这是本团队本角色落盘的第一份交接文档）") && handoffText.includes("下一份：（尚未写入"));
check("§11.9.6 正文: 模型的判断被原样保留（插件不删改写）", handoffText.includes(HANDOFF_LINE.mission) && handoffText.includes(HANDOFF_LINE["task-and-goal"]) && handoffText.includes("/goal resume"));

const handoffWrite2 = await __testing.writeHandoffDocument(handoffEnv.team(), {
	roleName: "coordinator",
	previous: SUCCESSOR,
	successor: "session-newer",
	token: "99999999-8888-7777-6666-555555555555",
	preparedAt: HANDOFF_NOW + 60000,
	body: handoffAll,
	report: __testing.handoffBodyReport(handoffAll),
	facts: handoffFacts,
});
const handoffText2 = await readFile(handoffWrite2.path, "utf8");
check("§11.9.6 事实段: 第二份文档把上一份的路径写进事实段（时间戳文件名天然不冲突）", handoffWrite2.ok === true && handoffWrite2.path !== handoffWrite.path && handoffText2.includes(`上一份：${handoffDocPath}`) && handoffWrite2.previousDocument === handoffDocPath);

const handoffSoftDoc = await readFile(handoffWrite2.path, "utf8");
check("§11.9.6 跨轮一致: 头部的完整性判定与校验器的读数同源——软节缺谁，头部与警告行说的是同一批名字", (() => {
	const report = __testing.handoffBodyReport(handoffBody(["team-map"]));
	// 🔵-1: a rename in the section list makes the body above stop being a legal
	// body, so `readHandoffArgument` answers `{ error }` and has no `warnings` at
	// all. Reading `.warnings.join(...)` unguarded then THROWS, which aborts the
	// whole run seven assertions early — the red is real but it is not CLEAN: it
	// hides every later assertion instead of reporting itself. The guard below
	// turns that same state into one honest FAIL and lets the rest of the suite
	// run to its own `assertion total` line.
	const parsed = __testing.readHandoffArgument(handoffBody(["team-map"]), { auto: true });
	const warning = (parsed.warnings ?? []).join("\n");
	const integrity = __testing.handoffIntegrityLine(report);
	return integrity.includes("硬节 5/5") && integrity.includes("软节缺 1/3（team-map）") && warning.includes("team-map") && !warning.includes("conventions");
})() && handoffSoftDoc.length > 0);
// The crash above is only reachable through `body` no longer being a legal body;
// that state has to be asserted on its own, or 🔵-1's guard would turn the crash
// into a silent pass on the line that mattered.
const handoffSoftGapArgs = __testing.readHandoffArgument(handoffBody(["team-map"]), { auto: true });
check("🔵-1 对照: 改名后那份正文就是「缺硬节」而不是「缺软节」——上面那条因此报 FAIL（而不是把整轮掀翻），这条把同一个状态单独说清楚", handoffSoftGapArgs.error === undefined ? handoffSoftGapArgs.warnings.some((line) => line.includes("team-map")) : handoffSoftGapArgs.error.includes("交接正文缺硬节"));

// --- 「不可两处口径」的源码级锁 ----------------------------------------------
// §11.9.6 要求事实段与 claim 返回文案同一事实源。行为上两者在同一次换届里被
// 一起断言（下一组），这里钉的是**结构**：这些行模板在模块里只准出现一次。
check("§11.9.6 同源锁: 迁移/未迁移/对称撤销/回退窗口四类行模板在 lib/index.js 里各只出现一次（写第二处口径就跑红）", ["→ 未迁移（未勾选）→ 已随退役清理；今后该对端走正常首问门。", "对称撤销（§3.6.1 原则 3）：退役者 ", "provisional 回退窗口：", "（域内没有待迁移的 pairs）"].every((needle) => (handoffSource.split(needle).length - 1) === 1));

// ---------------------------------------------------------------------------
// §11.2 successor:"auto"（③a 主路径）：自建继任者 · 写交接文档 · 铸令牌 · followup 投递
// ---------------------------------------------------------------------------

/** 这一组自己的 policy 门面（文件后面那一个定义在更晚处，顶层 const 的 TDZ 让这里
 * 借不到它）：形状与它逐字相同——只有 get/update，够 sweep 与启动清扫用。 */
const handoffPolicy = (env) => ({
	get: () => ({ ...env.ns.data, teams: env.ns.data.teams ?? [], pairs: env.ns.data.pairs ?? [], watchdogs: env.ns.data.watchdogs ?? [], trustedSenders: env.ns.data.trustedSenders ?? [], blockedSenders: env.ns.data.blockedSenders ?? [], rememberTargets: env.ns.data.rememberTargets ?? [], receiveMode: env.ns.data.receiveMode ?? "ask", pendingCreates: env.ns.data.pendingCreates ?? [] }),
	update: async (patch) => { Object.assign(env.ns.data, structuredClone(patch)); },
});
const handoffTeam = (workspace) => [{ name: "night-shift", createdAt: 1_700_000_000_000, workspace, policy: { writer: "coordinator" }, roles: rotRoles() }];

const autoEnv = rotateEnv({ askScript: ["创建并交班"], pairs: [rotPair("session-worker-a"), rotPair("session-worker-b"), rotPair(ROT_OUTSIDE)], trustedSenders: [ROT_SELF], rememberTargets: [ROT_SELF] });
const autoOut = await autoEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: "auto", handoff: handoffAll }, execFor(autoEnv.senderAgent));
const autoId = autoEnv.role().pending?.session ?? "（没有 pending）";
// A session born from `agents.create` is not one of the setup's pre-built stubs, so
// its message log lives in the factory's own record (`created[i].calls`) — reading
// it from `env.calls()` would report "nothing was delivered" for a session that
// was driven. The §10.2 batch cases use the same accessor.
const autoCreatedCalls = autoEnv.created[0]?.calls;
const autoDoc = await __testing.latestHandoffDocument(autoEnv.team(), "coordinator");
const autoDocText = autoDoc.path === null ? "" : await readFile(autoDoc.path, "utf8");
/** §11.5 的持久证据读数：**最新那一份**交接文档的头部是否认这次换届的继任者。 */
const autoDocNames = await __testing.handoffDocumentNamesLatest(autoEnv.team(), "coordinator", autoId);
const autoFollowup = autoCreatedCalls?.followedup?.[0];

check("U22 确认: 自动换届必过一次确认框（新建 1 个会话 + 交班的爆炸半径：id / cwd / 模型情形 / 保守成本口径 / 信任面 / 取消=零副作用）", (() => {
	const ask = autoEnv.uq.requests[0];
	if (ask === undefined || ask.questions.length !== 1) return false;
	const question = ask.questions[0];
	const text = `${question.question}\n${question.detail}`;
	return question.id === "rotation-auto"
		&& question.options.map((option) => option.label).join(",") === "创建并交班,取消"
		&& text.includes(autoId) && text.includes(TEAM_WS) && text.includes("保守成本口径") && text.includes("零创建、零令牌、零 freeze")
		&& text.includes("本次确认不迁移任何 pairs");
})());
check("U20 自建继任者: 一个根会话被建出来，id 形如 team-link-<team>-<role>-<uuid8>，meta 恰 {cwd, agentPreset}（不含 origin/parentSession/delegationDepth/parentAgent）—— auto 路径不指定 preset，故这里是宿主缺省解析出来的那一个（DEFECT-1：它必须真的挂上，否则继任者跑不起来）", autoEnv.creates.length === 1 && /^team-link-night-shift-coordinator-[A-Za-z0-9_-]{8}$/u.test(autoId) && sameJson(Object.keys(autoEnv.creates[0].meta).sort(), ["agentPreset", "cwd"]) && autoEnv.creates[0].meta.cwd === TEAM_WS && autoEnv.creates[0].meta.agentPreset === STUB_DEFAULT_PRESET);
check("U20 生命周期: AgentHandle 由插件持有（§10.2.5——它是「插件自建」这句话的可检事实，也是 §11.5 点名孤儿会话的判据）", __testing.teamSessionFor(autoEnv.ctx).hasHandle(autoId) === true && autoEnv.agentFor(autoId) !== undefined && autoCreatedCalls !== undefined);
check("U20 令牌: 令牌绑定到插件自建的继任者（pending.session 就是它），30 分钟 TTL", autoEnv.role().pending !== null && autoEnv.role().pending.session === autoId && autoEnv.role().pending.team === "night-shift" && autoEnv.role().pending.role === "coordinator" && autoEnv.role().pending.expiresAt - autoEnv.role().pending.createdAt === 30 * 60000);
check("U20 交接文档: 已落盘（团队 workspace 的黑板目录）且头部指向前任/继任者、令牌只以掩码出现", autoDoc.path !== null && path.dirname(autoDoc.path) === path.join(TEAM_WS, "team", "night-shift") && autoDocText.includes(`previous: ${ROT_SELF}`) && autoDocText.includes(`successor: ${autoId}`) && autoDocText.includes(`tokenMask: tok-${autoEnv.role().pending.token.slice(0, 4)}…${autoEnv.role().pending.token.slice(-4)}`) && !autoDocText.includes(autoEnv.role().pending.token));
check("U20 交接文档: 正文就是这次调用提供的五个硬节（模型写判断、插件写机制）", autoDocText.includes(HANDOFF_LINE.mission) && autoDocText.includes(HANDOFF_LINE.unknowns) && autoOut.includes(autoDoc.path));
const autoFreezeProbe = {
	freezeA: autoEnv.calls("session-worker-a").followedup.length,
	freezeB: autoEnv.calls("session-worker-b").followedup.length,
	notice: (autoEnv.calls("session-worker-a").followedup[0]?.content?.[0]?.text ?? "").includes("[rotation-freeze]"),
	backup: autoEnv.team().rotationBackup !== null,
	pairs: pairSummary(autoEnv),
};
check(`U20 冻结未被跳过: 既有 M4 机制原样走完（rotation-freeze 到其余成员、rotationBackup 快照、pairs 一条未动——信任迁移仍要 claim）`
	+ (autoFreezeProbe.freezeA === 1 && autoFreezeProbe.freezeB === 1 && autoFreezeProbe.notice && autoFreezeProbe.backup && autoFreezeProbe.pairs === "session-self↔session-outside session-self↔session-worker-a session-self↔session-worker-b" ? "" : `（实测：${show(autoFreezeProbe)}）`),
autoFreezeProbe.freezeA === 1 && autoFreezeProbe.freezeB === 1 && autoFreezeProbe.notice && autoFreezeProbe.backup && autoFreezeProbe.pairs === "session-self↔session-outside session-self↔session-worker-a session-self↔session-worker-b");
check("U21 投递: followup 驱动（不是 inject），正文含令牌明文与「立即 claim」，并带上交接正文与文档路径", autoFollowup !== undefined && autoCreatedCalls.injected.length === 0 && autoCreatedCalls.followedup.length === 1 && autoFollowup.content[0].text.includes(autoEnv.role().pending.token) && autoFollowup.content[0].text.includes("team_link_rotate action=claim") && autoFollowup.content[0].text.includes(autoDoc.path) && autoFollowup.content[0].text.includes(HANDOFF_LINE["task-and-goal"]) && autoFollowup.content[0].text.includes("/goal resume"));
check("U21 红线: 交接消息的 source 仍恰三成员 {kind, form, senderSessionId}，发送方是旧任", autoFollowup !== undefined && sameJson(Object.keys(autoFollowup.source).sort(), ["form", "kind", "senderSessionId"]) && autoFollowup.source.kind === "agent-message" && autoFollowup.source.form === "relay" && autoFollowup.source.senderSessionId === ROT_SELF);
check("U24 无新日志事件: 整条自动路径只经 settings 写 + agents.create + followup 三个出口（提供方侧动作日志里没有第四种动作）", autoEnv.actionLog.every((entry) => entry === "create" || entry === "followup") && autoEnv.actionLog.includes("create") && autoEnv.actionLog.includes("followup"));
check("U20 意图闭环: prepare 成功后台账里的 pending-create 意图被回填（否则启动清扫会把已就位的继任者当成孤儿）", autoId !== "（没有 pending）" && (autoEnv.ns.data.pendingCreates ?? []).length === 0 && (autoEnv.ns.data.pendingCreates ?? []).every((entry) => entry.sessionId !== autoId));

// --- 评审 #4：事实段的**计数**是读数，必须取自写文档那一刻 ---------------------------
// `autoHandover` 的确认框横跨一次不封顶的人工等待，所以「弹框之前那次 `view`」可能早已不是
// 写文档瞬间的 store。本轮取方案 ①（确认之后、写文档之前**重读一次** `policy.get()`）：一次
// 读的成本，换来的是「文档里的数目 == `prepare` 即将快照的那份状态」；而 §11.9.6 的指针式
// 口径留给的是**写文档时不可能知道**的东西（freeze 的逐目标结果），不是这几个可读的数目。
// 判据做成行为锁：人在对话框挂起时给退役者**又加一条** pair，文档事实段里的对称撤销行必须
// 认这条新记录——删掉那次重读，它就会报对话框前那个旧数目（3）。
const autoFactsEnv = rotateEnv({
	askScript: [],
	pairs: [rotPair("session-worker-a"), rotPair("session-worker-b"), rotPair(ROT_OUTSIDE)],
	trustedSenders: [ROT_SELF],
	rememberTargets: [ROT_SELF],
	teams: handoffTeam(path.join(HANDOFF_WS, "facts")),
});
autoFactsEnv.setScript(() => {
	// 人在确认框开着的时候又给退役者加了一条通道（三条 → 四条）。
	autoFactsEnv.ns.data.pairs.push({ a: ROT_SELF, b: "session-midbox", createdAt: 9 });
	return ["创建并交班"];
});
const autoFactsOut = await autoFactsEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: "auto", handoff: handoffAll }, execFor(autoFactsEnv.senderAgent));
const autoFactsDoc = await __testing.latestHandoffDocument(autoFactsEnv.team(), "coordinator");
const autoFactsText = autoFactsDoc.path === null ? "" : await readFile(autoFactsDoc.path, "utf8");
check("评审 #4 事实段计数取自写文档那一刻: 确认期间新加的 pair 进得了「对称撤销」行的计数（pairs 4 条），trustedSenders / rememberTargets 同样如实——删掉「确认后重读 policy.get()」那次读，这条立刻红（它会报对话框前的旧数目 3）", autoFactsDoc.path !== null && autoFactsText.includes(`退役者 ${ROT_SELF} 持有的 pairs 4 条已全部清除`) && autoFactsText.includes("trustedSenders 1 项与 rememberTargets 1 项一并清除") && !autoFactsText.includes(`退役者 ${ROT_SELF} 持有的 pairs 3 条`) && autoFactsOut.includes("自建继任者"));

// --- DEFECT-1 ③a（§11.4.2 复用 §10.2.2 的同一个 create 函数）-------------------
// 影响面比 ② 更大：同一个 `buildTeamSessionCreateOptions` 造继任者 ⇒ 若它跳过
// preset，换届会失败在「继任者跑不起来 ⇒ 无法 claim」这一步，而令牌已经投给它、
// 旧任已经冻结（信任迁移路径上的失败）。所以这里断言的不是「继任者建出来了」，
// 而是**同一件事的两个读数**：meta 里记着的 preset 与它真被挂上的 preset 同源、
// 恰一次，且那条 mount 绑的就是这个继任者自己的 setup 上下文。
check("DEFECT-1 ③a 继任者: `successor:\"auto\"` 建出的会话**同样有 persona-prefix 来源** —— resolve(undefined)（宿主缺省）→ meta.agentPreset === 实际挂载的那个 preset，且每个继任者恰挂一次", presetBoundOnce(autoEnv) && autoEnv.creates.length === 1 && autoEnv.agentPresets.resolved.length === 1 && autoEnv.agentPresets.resolved[0] === undefined && autoEnv.agentPresets.mounts.length === 1 && autoEnv.agentPresets.mounts[0].agentId === autoId && autoEnv.agentPresets.mounts[0].id === autoEnv.creates[0].meta.agentPreset);
check("DEFECT-1 ③a 判据是「能用」: 那条 mount 的 agentCtx 就是继任者自己的 setup 上下文（同一个对象）——不是「建出来了」的同义反复", autoEnv.created.length === 1 && autoEnv.created[0].agent.id === autoId && autoEnv.created[0].agent.setupCtx.agentId === autoId && autoEnv.agentPresets.mounts[0].ctx === autoEnv.created[0].agent.setupCtx);
// The degradation branch, on the SAME function: a missing service must not make
// the rotation fail (the intent/token/document contract stays intact), but it
// must not be silent either.
const autoNoPresetEnv = rotateEnv({ askScript: ["创建并交班"], omitAgentPresets: true, teams: handoffTeam(path.join(HANDOFF_WS, "nopreset")) });
const autoNoPresetOut = await autoNoPresetEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: "auto", handoff: handoffAll }, execFor(autoNoPresetEnv.senderAgent));
check("DEFECT-1 ③a 降级: agentPresets 缺席时继任者照常自建、换届不因此失败（不因服务缺失让整条创建失败），并恰留一行 warn 点名它没有 persona-prefix 组装源", autoNoPresetEnv.creates.length === 1 && autoNoPresetEnv.agentPresets.mounts.length === 0 && autoNoPresetEnv.log.lines.warn.filter((line) => line.includes("agentPresets service unavailable")).length === 1 && autoNoPresetOut.includes("自建继任者"));

// --- DEFECT-2 ③a（§11.4.2 复用 §10.2.2 的同一个创建路径）-----------------------
// 与 DEFECT-1 同一条影响面：继任者也是 `createRootAgent` 建的 ⇒ 它同样要**挂进工作
// 区**，否则换届之后用户在侧边栏里同样找不到新协调者，只能靠 `list_sessions` 或深链。
// 判据与 ② 逐字共用（`workspaceBoundOnce`：按会话 id 配对，不看位置）。
check("DEFECT-2 ③a 继任者: `successor:\"auto\"` 建出的会话同样挂进了工作区 —— workspace 恰建一次、`attachSession` 恰一次且 id === 继任者 id、`meta.cwd` 就是那份 workspace 的 path、成员名单里有它", workspaceBoundOnce(autoEnv) && autoEnv.workspaceRegistry.creates.length === 1 && autoEnv.workspaceRegistry.creates[0] === TEAM_WS && autoEnv.workspaceRegistry.attached.length === 1 && autoEnv.workspaceRegistry.attached[0].sessionId === autoId && autoEnv.workspaceRegistry.detached.length === 0);
check("DEFECT-2 ③a 与 ② 同源: 两条路径的挂载读数是**同一个函数**产出的（`createRootAgent` 是全模块唯一的创建落点，auto 路径没有自己的第二份实现）", workspaceBindingOf(autoEnv).length === 1 && workspaceBindingOf(autoEnv)[0].id === autoId && autoEnv.creates.length === 1);
const autoNoWsEnv = rotateEnv({ askScript: ["创建并交班"], omitWorkspaceRegistry: true, teams: handoffTeam(path.join(HANDOFF_WS, "noworkspace")) });
const autoNoWsOut = await autoNoWsEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: "auto", handoff: handoffAll }, execFor(autoNoWsEnv.senderAgent));
check("DEFECT-2 ③a 降级: workspaceRegistry 缺席时继任者照常自建、换届不因此失败（令牌、交接文档、投递照旧），并**恰留一行 warn** 点名它未挂进工作区（信任迁移路径上的降级也要如实说）", autoNoWsEnv.creates.length === 1 && autoNoWsEnv.workspaceRegistry.attached.length === 0 && autoNoWsEnv.workspaceRegistry.creates.length === 0 && workspaceServiceWarns(autoNoWsEnv).length === 1 && workspaceServiceWarns(autoNoWsEnv).every((line) => line.includes("未挂进工作区")) && autoNoWsOut.includes("自建继任者") && autoNoWsOut.includes("投递（§11.4.5）"));

// --- DEFECT-3 ③a（§11.4.2 复用 §10.2.2 的同一个创建函数）------------------------
// 与 DEFECT-1/2 同一条影响面，但后果更重：`successor:"auto"` 的继任者也是
// `createRootAgent` 建的 ⇒ 它同样必须带模型选择，否则**令牌已经投给了一个跑不起来的
// 持钥者、而旧任已经冻结**（信任迁移路径上的失败：继任者无法 claim）。
// 判据与 ② 逐字共用（`modelSelectionBoundOnce`：按会话 id 配对，不看位置）。
const autoModelRows = modelSelectionOf(autoEnv);
/** 一整条读数的诊断（判据不成立时印出来，而不是只印一句「不等」）。 */
const autoModelProbe = { rows: autoModelRows, id: autoId, serviceCalls: autoEnv.agentDefaultModel.calls.length, agentOptionsKeys: Object.keys(autoEnv.creates[0]?.agentOptions ?? {}).sort().join(",") };
check(`DEFECT-3 ③a 继任者: \`successor:"auto"\` 建出的会话**同样带模型选择** —— agentOptions 里那一对就是 \`currentSelection()\` 的读数，且模型选择钩子装在这一个继任者自己的 setup 上下文上`
	+ (modelSelectionBoundOnce(autoEnv) && autoModelRows[0]?.id === autoId && autoModelRows[0]?.setupAgentId === autoId ? "" : `（实测：${show(autoModelProbe)}）`),
modelSelectionBoundOnce(autoEnv) && autoEnv.creates.length === 1 && autoModelRows[0]?.id === autoId && autoModelRows[0]?.setupAgentId === autoId);
// 服务缺席在 auto 路径上是**拒绝**（与 ② 同口径）：create 抛错 ⇒ `prepare` 失败，
// **不铸令牌、不广播 freeze、不写交接文档**，已写的 pending-create 意图保留（§11.5）。
const autoNoModelWs = path.join(HANDOFF_WS, `nomodel-${Date.now()}`);
const autoNoModelEnv = rotateEnv({ askScript: ["创建并交班"], omitAgentDefaultModel: true, teams: handoffTeam(autoNoModelWs) });
const autoNoModelOut = await autoNoModelEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: "auto", handoff: handoffAll }, execFor(autoNoModelEnv.senderAgent));
check("DEFECT-3 ③a 服务缺席 fail-visible: 继任者创建失败 ⇒ 零建会话、零令牌、零 freeze、零交接文档，错误文案点名 agentDefaultModel 与后果（令牌绝不投给一个跑不起来的持钥者）", autoNoModelEnv.creates.length === 0 && autoNoModelEnv.role().pending === null && autoNoModelEnv.calls("session-worker-a").followedup.length === 0 && autoNoModelEnv.calls("session-worker-b").followedup.length === 0 && !existsSync(autoNoModelWs) && autoNoModelOut.includes("agentDefaultModel") && autoNoModelOut.includes("继任者会话创建失败") && autoNoModelOut.includes("未铸令牌、未广播 freeze"));
check("DEFECT-3 ③a 服务缺席: 已写的 pending-create 意图**保留**并如实报为可收编线索（§11.5 部分成功不回滚）——拒绝不是无声的", (autoNoModelEnv.ns.data.pendingCreates ?? []).length === 1 && autoNoModelOut.includes("pending-create"));

// --- DEFECT-4 ③a（§11.4.2 复用 §10.2.2 的同一个创建路径）------------------------
// 与 DEFECT-1/2/3 同一条影响面：继任者也是 `createRootAgent` 建的 ⇒ 它同样必须有一个
// **可区分**的标题，否则换届之后用户在侧边栏里同样认不出那个新协调者（而它正是**持钥者**）。
// 判据与 ② 逐字共用（`sessionTitledOnce` / `sessionTitleOf`：按会话 id 配对，不看位置）
// ——这也是「注入点只有一处」的行为侧证据：auto 路径没有自己的第二份命名实现。
check("DEFECT-4 ③a 继任者: `successor:\"auto\"` 建出的会话同样被命名成 `<team> · <role>`（同一个注入点，auto 路径没有自己的第二份实现）", sessionTitledOnce(autoEnv) && autoEnv.creates.length === 1 && at(sessionTitleOf(autoEnv), 0, {}).id === autoId && at(sessionTitleOf(autoEnv), 0, {}).title === "night-shift · coordinator");
const autoTitleBody = autoEnv.uq.requests[0]?.questions[0]?.question ?? "";
check("DEFECT-4 ③a 确认框说明设了什么标题: 自动换届的确认框写出继任者将得到的那个标题（同一份值既进框、又交给创建路径的 rename），并写明「想改随时在壳里重命名」", autoTitleBody.includes("night-shift · coordinator") && autoTitleBody.includes("想改随时在壳里重命名"));
check("DEFECT-4 ③a 回执说明设了什么标题: 交班摘要如实写出真正设成的标题（取自 rename 的返回值）", autoOut.includes("已命名为「night-shift · coordinator」"));
const autoNoTitleEnv = rotateEnv({ askScript: ["创建并交班"], omitSessionTitle: true, teams: handoffTeam(path.join(HANDOFF_WS, "notitle")) });
const autoNoTitleOut = await autoNoTitleEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: "auto", handoff: handoffAll }, execFor(autoNoTitleEnv.senderAgent));
check("DEFECT-4 ③a 降级: sessionTitle 缺席时继任者照常自建、换届不因此失败（令牌、交接文档、投递照旧），恰留一行 warn 点名未设标题的后果（信任迁移路径上的降级也要如实说）", autoNoTitleEnv.creates.length === 1 && autoNoTitleEnv.sessionTitle.renames.length === 0 && sessionTitleServiceWarns(autoNoTitleEnv).length === 1 && sessionTitleServiceWarns(autoNoTitleEnv)[0].includes("工作区名") && autoNoTitleOut.includes("自建继任者") && autoNoTitleOut.includes("投递（§11.4.5）"));

// --- U22: 拒/取消/无确认服务 —— 三条都是「零副作用」 ---------------------------

const autoRefuseEnv = rotateEnv({ askScript: ["创建并交班"], teams: handoffTeam(path.join(HANDOFF_WS, "refuse")) });
const autoRefuse = await autoRefuseEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: "auto" }, execFor(autoRefuseEnv.senderAgent));
check("U28 阶梯（入口）: auto + 正文缺失 → 拒绝于工具入口：零建会话（提供方侧 create 计数）/ 零令牌（pending 为 null）/ 零 freeze（成员零投递）/ 零文档 / 连确认框都不弹", autoRefuse.includes("零建会话、零令牌、零 freeze") && __testing.HANDOFF_HARD_SECTIONS.every((name) => autoRefuse.includes(`## ${name}`)) && autoRefuseEnv.creates.length === 0 && autoRefuseEnv.role().pending === null && autoRefuseEnv.calls("session-worker-a").followedup.length === 0 && autoRefuseEnv.calls("session-worker-b").followedup.length === 0 && autoRefuseEnv.uq.requests.length === 0 && (autoRefuseEnv.ns.data.pendingCreates ?? []).length === 0 && !existsSync(path.join(HANDOFF_WS, "refuse")));

const autoNoConfirmEnv = rotateEnv({ omitUserQuestions: true, teams: handoffTeam(path.join(HANDOFF_WS, "noconfirm")) });
const autoNoConfirm = await autoNoConfirmEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: "auto", handoff: handoffAll }, execFor(autoNoConfirmEnv.senderAgent));
check("U22 无确认服务: fail-closed——不建、不铸令牌、不 freeze（确认框是必经之门，不是可选提示）", autoNoConfirm.includes("确认服务（userQuestions）不可用") && autoNoConfirm.includes("fail-closed") && autoNoConfirmEnv.creates.length === 0 && autoNoConfirmEnv.role().pending === null && autoNoConfirmEnv.calls("session-worker-a").followedup.length === 0 && !existsSync(path.join(HANDOFF_WS, "noconfirm")));

const autoCancelEnv = rotateEnv({ askScript: ["取消"], teams: handoffTeam(path.join(HANDOFF_WS, "cancel")) });
const autoCancel = await autoCancelEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: "auto", handoff: handoffAll }, execFor(autoCancelEnv.senderAgent));
check("U22 取消: 零创建、零令牌、零 freeze、零交接文档（选「取消」就是什么都不做）", autoCancel.includes("未自动换届") && autoCancel.includes("零创建、零令牌、零 freeze、零交接文档") && autoCancelEnv.creates.length === 0 && autoCancelEnv.role().pending === null && autoCancelEnv.calls("session-worker-a").followedup.length === 0 && (autoCancelEnv.ns.data.pendingCreates ?? []).length === 0 && !existsSync(path.join(HANDOFF_WS, "cancel")));

// --- 🟡-3 / 🟡-4: 同改面的**双向**锁（名单四处一处写 · 键表接受集 == 宣传集）-------
// 差异审计的两个变异：单独把工具 handoff 参数说明（或投递正文）里的 `unknowns` 改成
// `unknownz` → 735 全绿；`TEAM_ROTATE_KEYS` 加一个能被解析却从不被宣传的键 → 735 全绿。
// 两条的共同形状是「同一份事实两处写、只锁了一处」。修法是让宣传面**从真源渲染**，
// 并在这里把「渲染自真源」这件事本身钉住：留一份手抄的完整名单，无论它出现在哪一处，
// 都会让下面的计数断言立刻跑红。
const HANDOFF_SOURCE = await readFile(fileURLToPath(new URL("./lib/index.js", import.meta.url)), "utf8");
check("🟡-3 同改锁（前置）: 本组读的就是 lib/index.js 本身（读错文件会让下面三条变成空转）", HANDOFF_SOURCE.length > 100000 && HANDOFF_SOURCE.includes("export const __testing"));
const HANDOFF_SECTIONS_INLINE = __testing.HANDOFF_HARD_SECTIONS.join(" / ");
const handoffInlineCount = HANDOFF_SOURCE.split(HANDOFF_SECTIONS_INLINE).length - 1;
const handoffSourceLiteral = `const HANDOFF_HARD_SECTIONS = [${__testing.HANDOFF_HARD_SECTIONS.map((name) => `"${name}"`).join(", ")}];`;
check(`🟡-3 同改锁: 五个硬节的完整名单在 lib/index.js 里**一处都不许手抄**（实测 ${handoffInlineCount} 处）——唯一那处是真源数组 \`HANDOFF_HARD_SECTIONS\`，其余每一处都是 \`handoffSectionsInline()\` 的运行时产物`, handoffInlineCount === 0 && HANDOFF_SOURCE.includes(handoffSourceLiteral));
/** 两处宣传面的**运行时**读数：变异把任一处改成手抄或改坏一个节名，这里立刻不等。 */
const handoffTool = autoEnv.tool("team_link_rotate");
const handoffFaces = [
	["工具 description", handoffTool.description.includes(`硬节用这几个标题：${HANDOFF_SECTIONS_INLINE}，`)],
	["handoff 参数 description", handoffTool.parameters.properties.handoff.description.includes(`五个硬节各以一个标题开头：${HANDOFF_SECTIONS_INLINE}（`)],
	["投递正文（旧任 → 继任者）", (autoFollowup?.content?.[0]?.text ?? "").includes(`五个硬节：${HANDOFF_SECTIONS_INLINE}；`)],
];
check(`🟡-3 四处同改锁: 三个宣传面在**运行时**渲染出的就是真源那一份名单（工具 description / handoff 参数 / 投递正文各查一次；任一处手抄或改坏一个节名即红）${handoffFaces.every(([, ok]) => ok) ? "" : `（缺：${JSON.stringify(handoffFaces.filter(([, ok]) => !ok).map(([name]) => name))}）`}`, handoffFaces.every(([, ok]) => ok));const handoffFourFaces = [
	["真源数组", HANDOFF_SOURCE.includes(`const HANDOFF_HARD_SECTIONS = [`)],
	["提示表", __testing.HANDOFF_HARD_SECTIONS.every((name) => typeof __testing.HANDOFF_SECTION_HINTS[name] === "string" && __testing.HANDOFF_SECTION_HINTS[name] !== "")],
	["投递正文", HANDOFF_SOURCE.includes("五个硬节：\" + handoffSectionsInline()")],
	["工具 description / handoff 参数", HANDOFF_SOURCE.includes("硬节用这几个标题：\" + handoffSectionsInline()") && HANDOFF_SOURCE.includes("五个硬节各以一个标题开头：\" + handoffSectionsInline()")],
];
check(`🟡-3 四处宣传面: 真源 / 提示表 / 投递正文 / 工具参数各自都在，且后两者逐字渲染真源（不是各自手抄）${handoffFourFaces.every(([, ok]) => ok) ? "" : `（缺：${JSON.stringify(handoffFourFaces.filter(([, ok]) => !ok).map(([name]) => name))}）`}`, handoffFourFaces.every(([, ok]) => ok));
// 变异 M7a/M7b 的**咬合点**：改坏任一处宣传面 ⇒ 它不再渲染真源（上一条钉住这一点）；
// 而如果改的是散文里的裸名字，就会留下一个本不该存在的拼法。下面这几个变体都**不是**
// 任何正常中英文散文会出现的词，也**不是**源码里合规的同义写法（`commitment` 单数、
// `task_and_goal` 这类会被 `normalizeHandoffSection` 折叠成同一节的写法都刻意不收，
// 收了就是假红——那条折叠本身还有它自己的断言在管）。
const handoffDriftNames = ["unknownz", "missionz", "inflight", "taskandgoal", "firstactions"];
const handoffDriftSeen = handoffDriftNames.filter((name) => HANDOFF_SOURCE.includes(name));
check(`🟡-3 同改锁: 五个硬节名没有第二个拼法（常见的漏改变体一个都不许出现：${handoffDriftNames.join(" / ")}）`, handoffDriftSeen.length === 0);
// 🟡-4: 反向锁。审计的变异是「`TEAM_ROTATE_KEYS` 加一个能被解析却从不被宣传的键」。
// 修法两步：① 广告（`TEAM_ROTATE_KEY_HINT`）现在**从 `TEAM_ROTATE_KEYS` 渲染**，两个
// 集合在结构上同源；② 但同源**不能自己证明自己**——集合相等是渲染出来的，真正会被这
// 个变异打穿的是「解析器接受了一个不在表里的键」，所以反向锁落在**解析器的行为**上：
// 任何不在广告里的键都必须被拒、且拒绝文案印的就是广告那一份。②是操作性的：把解析器
// 换成「任何 `k=v` 都收」的写法（审计 M5b 加的那个键要走的路）这里立刻咬住。
const rotKeyHints = [...__testing.TEAM_ROTATE_KEY_HINT.matchAll(/([A-Za-z][A-Za-z0-9-]*)=/gu)].map((match) => match[1]);
const rotKeyAccepted = __testing.TEAM_ROTATE_KEYS;
const rotKeyUnknown = "shard";
const rotKeyUnknownOut = __testing.readTeamRotateCommand(`coordinator ${rotKeyUnknown}=night-shift`);
const rotKeyProbe = {
	advertised: rotKeyHints.join(","),
	accepted: rotKeyAccepted.join(","),
	advertisedInHelp: __testing.readTeamRotateCommand("coordinator team=night-shift").value?.team === "night-shift",
	advertisedAccepted: rotKeyAccepted.every((key) => rotKeyHints.includes(key)),
	acceptedAdvertised: rotKeyHints.every((key) => rotKeyAccepted.includes(key)),
	unknownRefused: rotKeyUnknownOut.error !== undefined && !rotKeyAccepted.includes(rotKeyUnknown),
	unknownNamedInRefusal: (rotKeyUnknownOut.error ?? "").includes(`「${rotKeyUnknown}=」`) && (rotKeyUnknownOut.error ?? "").includes(__testing.TEAM_ROTATE_KEY_HINT),
	emptyRefused: __testing.readTeamRotateCommand("coordinator team=").error !== undefined,
};
check(`🟡-4 双向锁: 被宣传的键集 == 被接受的键集（结构上同源：广告由 \`TEAM_ROTATE_KEYS\` 渲染），且**反向是操作性的**——任何不在广告里的键（${rotKeyUnknown}）都被解析器拒绝并在拒绝文案里点名，而不是被默默接受`
	+ (rotKeyProbe.advertised === rotKeyProbe.accepted && rotKeyProbe.advertisedInHelp && rotKeyProbe.unknownRefused && rotKeyProbe.unknownNamedInRefusal && rotKeyProbe.emptyRefused ? "" : `（实测：${show(rotKeyProbe)}）`),
rotKeyProbe.advertised === rotKeyProbe.accepted && rotKeyAccepted.length > 0 && rotKeyHints.length === rotKeyAccepted.length && rotKeyProbe.advertisedAccepted && rotKeyProbe.acceptedAdvertised && rotKeyProbe.advertisedInHelp && rotKeyProbe.unknownRefused && rotKeyProbe.unknownNamedInRefusal && rotKeyProbe.emptyRefused);
check("🟡-4 单向锁（既有，保留）: 未知键仍被点名拒绝，且拒绝文案里印的就是广告那份键表", (() => {
	const out = __testing.readTeamRotateCommand("coordinator shard=night-shift");
	return out.error !== undefined && out.error.includes("未知参数「shard=」") && out.error.includes(__testing.TEAM_ROTATE_KEY_HINT);
})());

// --- U23: 30 分钟未认领 / 崩溃窗口 / 文档写失败 --------------------------------

/**
 * 跨激活相（🟡-2 的核心）：**同一份落盘状态** + **空 handle 注册表**。
 *
 * 「插件重载」到底是什么，这里逐项照抄，一项不省：交接文档还在磁盘上（换
 * 激活不会删它）、settings 命名空间里的 roster/pending 原样在盘上、而
 * `teamSession.handles` 随着旧激活一起没了（新窗口的注册表是空的）。所以
 * fixture 是：新 env（新激活窗口）+ 把旧窗口的落盘快照灌进去 + 新控制器上
 * `hasHandle` 一律 false。修复前这里必红——旧判据只有 `hasHandle` 这一问。
 *
 * 快照必须在 `autoSweep` **之前**取：清扫本身会清掉那个 pending（那是它的正常
 * 工作），而「重载」要的是**清扫之前**的那份盘上状态。
 */
const autoDiskSnapshot = { teams: structuredClone(autoEnv.ns.data.teams), pairs: structuredClone(autoEnv.ns.data.pairs), trustedSenders: [...(autoEnv.ns.data.trustedSenders ?? [])], rememberTargets: [...(autoEnv.ns.data.rememberTargets ?? [])], blockedSenders: [...(autoEnv.ns.data.blockedSenders ?? [])], pendingCreates: structuredClone(autoEnv.ns.data.pendingCreates ?? []) };
const autoSweep = await autoEnv.rotation.sweep({ now: Date.now() + 31 * 60000 });
check("U23 未认领: 30 分钟超时走既有 rotation-cancelled（旧任仍为现任、冻结解除），并额外点名插件自建的继任者", autoSweep.cancelled.length === 1 && autoSweep.cancelled[0].caller === autoId && autoEnv.role().current === ROT_SELF && autoEnv.role().pending === null && autoSweep.lines.some((line) => line.includes(autoId) && line.includes("可收编或关闭") && line.includes("§11.5")) && autoEnv.calls("session-worker-a").followedup.at(-1).content[0].text.includes("[rotation-cancelled]"));

// --- §11.5 的判据必须跨激活成立（🟡-2）-------------------------------------------
// 现象（差异审计实测）：判据是内存态 `hasHandle`，而**插件重载会清空 handle 注册表**
// ——盘上的 pending 仍在、清扫照跑、点名行却静默消失（同窗口 4 行 → 换激活后 3 行）。
// 而那正是设计要防的「没人知道的孤儿」窗口。修法是让判据**先读持久证据**：交接文档
// 头部的 `successor:` 行（落盘、重载不动），再退到落盘的 pending-create 意图，内存
// handle 只作附加佐证。下面三条把三层来源与「重载相」分别钉住。
check("🟡-2 持久证据: 交接文档头部的 `successor:` 行按逐字匹配认人（正文里的同名文本不作数——头部才是落盘的指派记录）", __testing.handoffDocumentNamesSuccessor(`---\nsuccessor: session-x\n---\n`, "session-x") === true && __testing.handoffDocumentNamesSuccessor(`---\nsuccessor: session-x\n---\n`, "session-xy") === false && __testing.handoffDocumentNamesSuccessor(`---\nsuccessor: session-x\n---\n`, "session-") === false && __testing.handoffDocumentNamesSuccessor(`successor: session-x\n`, "") === false && __testing.handoffDocumentNamesSuccessor(`## mission\nthe successor: session-x was named\n`, "session-x") === false);
check("🟡-2 持久证据: 最新那份交接文档的头部 `successor:` 认得这次换届的继任者（重载后它仍在磁盘上，这正是跨激活判据的来源）", (() => {
	return autoDocNames.error === null && autoDocNames.named === true && autoDoc.path !== null && path.dirname(autoDoc.path) === path.join(TEAM_WS, "team", "night-shift");
})());
// 判据必须**只认最新那一份**：旧文档里的 id 属于已被取代的换届（一个 token 若还
// pending，它必然是最后一次 prepare 的），拿旧文档认人就是假阳。
const autoDocStaleMatch = await __testing.handoffDocumentNamesLatest(autoEnv.team(), "coordinator", "session-never-created");
check("🟡-2 持久证据: 只有最新那一份文档能认人——换一个不在任何文档里的 id，判据为否（旧文档里的 id 不许冒充现在的继任者）", autoDocStaleMatch.error === null && autoDocStaleMatch.named === false && autoDocNames.named === true && !autoDocText.includes("session-never-created"));
/** 重载窗口的继任者 id **从盘上那一行读**，不从 `autoId` 抄：`autoId` 是测试进程里
 * 「刚才那次 prepare」的内存读数，而重载相要证明的恰恰是「没有内存读数也认得出」。 */
const autoReloadId = autoDiskSnapshot.teams[0].roles[0].pending?.session ?? "（快照里没有 pending）";
/**
 * 重载相的环境：**一个全新的 Context + 一份全新的 settings 存根**，灌的就是那份落盘
 * 快照。为什么不能用 `rotateEnv`：它的 settings 存根把 `register(namespace)` 与「种入
 * state」绑在一起，而新策略存储自己会再 register 一次 ⇒ state 被重置成空 —— 那样测的
 * 就不是「重载后还认不认得出」，而是「另一个空命名空间」。这里在注册之后把快照灌进去，
 * 重放的是真实的启动顺序（先有服务，再有数据）。
 */
const reloadCtx = new Context();
const reloadState = { teams: structuredClone(autoDiskSnapshot.teams), pairs: structuredClone(autoDiskSnapshot.pairs), trustedSenders: [...autoDiskSnapshot.trustedSenders], rememberTargets: [...autoDiskSnapshot.rememberTargets], blockedSenders: [...autoDiskSnapshot.blockedSenders], pendingCreates: structuredClone(autoDiskSnapshot.pendingCreates) };
reloadCtx.provide("settings", {
	register(_namespace, _schema, options = {}) {
		return { get: () => ({ ...structuredClone(options.base ?? {}), ...structuredClone(reloadState) }), update: async (patch) => { Object.assign(reloadState, structuredClone(patch)); } };
	},
});
// 重载后的一切：agents 表是空的（旧激活的 handle 连同旧激活一起没了），所以
// `broadcastNotice` 的逐目标行只会是 no-agent —— 点名行就是这次清扫唯一的产出。
reloadCtx.provide("agents", { get: () => undefined, list: () => [] });
reloadCtx.provide("sessionQuery", {});
reloadCtx.provide("tools", { register: () => () => {} });
reloadCtx.logger = { warn() {}, info() {}, error() {} };
const reloadRotation = __testing.rotationFor(reloadCtx, { hasHandle: () => false });
const reloadSweep = await reloadRotation.sweep({ now: Date.now() + 31 * 60000 });
const reloadMentions = reloadSweep.lines.filter((line) => line.includes(autoReloadId));
const reloadNaming = reloadMentions.filter((line) => line.includes("可收编或关闭"));
const reloadProbe = {
	snapshotHadPending: autoDiskSnapshot.teams[0].roles[0].pending?.session === autoReloadId,
	documentOnDisk: autoDocNames.named === true && autoDocNames.error === null,
	cancelled: reloadSweep.cancelled.length,
	naming: reloadNaming.length,
	evidenceNamed: reloadNaming.some((line) => line.includes("落盘的交接文档头部 successor 行")),
	pendingCleared: reloadState.teams[0].roles[0].pending === null,
	currentKept: reloadState.teams[0].roles[0].current === ROT_SELF,
};
check(`🟡-2 跨激活: 空 handle 注册表 + 同一份落盘状态 ⇒ 点名行仍在，且它自己说出判据来自落盘的交接文档（不看本激活窗口的内存态）`
	+ (reloadProbe.snapshotHadPending && reloadProbe.documentOnDisk && reloadProbe.cancelled === 1 && reloadProbe.naming === 1 && reloadProbe.evidenceNamed && reloadProbe.pendingCleared && reloadProbe.currentKept ? "" : `（实测：${show(reloadProbe)}）`),
reloadProbe.snapshotHadPending && reloadProbe.documentOnDisk && reloadProbe.cancelled === 1 && reloadSweep.cancelled[0].caller === autoReloadId && reloadProbe.naming === 1 && reloadProbe.evidenceNamed && reloadProbe.pendingCleared && reloadProbe.currentKept);
/** 三层来源各司其职：落盘文档 > 落盘 intent > 内存 handle。三者的差别是可检的
 * （`evidence` 字段），而 `handle` 只在持久来源一个都没命中时才作数——它是最不
 * 耐久的那一条，所以它不能替持久证据说话。反面同批钉住：三条都不命中就是
 * 「不是本插件建的」，点名行不许出现（手工路径的 U23 对照另有断言）。 */
const reloadTeam = reloadState.teams[0];
/** `handle` 那一条要在**没有落盘文档**的目录上测：否则命中的是文档（上一条），
 * 而不是 handle——借用一份不属于这次换届的文档来断言是假绿。 */
const bareTeam = { ...reloadTeam, workspace: path.join(TEAM_TMP, "ownership-probe-ws") };
const handleEvidence = await __testing.successorOwnershipOf({ team: bareTeam, role: "coordinator", sessionId: "session-handle-only", pendingCreates: [], hasHandle: () => true });
const documentEvidence = await __testing.successorOwnershipOf({ team: reloadTeam, role: "coordinator", sessionId: autoReloadId, pendingCreates: [], hasHandle: () => false });
const absentEvidence = await __testing.successorOwnershipOf({ team: bareTeam, role: "coordinator", sessionId: "session-never-created", pendingCreates: [], hasHandle: () => false });
const intentEvidence = await __testing.successorOwnershipOf({ team: bareTeam, role: "coordinator", sessionId: "session-never-created", pendingCreates: [{ sessionId: "session-never-created" }], hasHandle: () => false });
const ownershipProbe = { handle: handleEvidence, document: documentEvidence, intent: intentEvidence, absent: absentEvidence };
check(`🟡-2 三层来源各司其职: 落盘文档 > 落盘 intent > 内存 handle，且四者互不冒充（handle 只在内存态为真时兜底，三条持久路径都不命中就是「不是本插件建的」）`
	+ (documentEvidence.evidence === "handoff-document" && intentEvidence.evidence === "pending-create-intent" && absentEvidence.evidence === "none" && handleEvidence.evidence === "handle" ? "" : `（实测：${show(ownershipProbe)}）`),
handleEvidence.pluginCreated === true && handleEvidence.evidence === "handle" && documentEvidence.pluginCreated === true && documentEvidence.evidence === "handoff-document" && intentEvidence.pluginCreated === true && intentEvidence.evidence === "pending-create-intent" && absentEvidence.pluginCreated === false && absentEvidence.evidence === "none" && __testing.ownershipEvidenceLabel("handoff-document") !== __testing.ownershipEvidenceLabel("handle"));

const manualUnclaimedEnv = rotateEnv({ askScript: [], pairs: [rotPair("session-worker-a")] });
const manualUnclaimedPrep = await manualUnclaimedEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(manualUnclaimedEnv.senderAgent));
const manualUnclaimedSweep = await manualUnclaimedEnv.rotation.sweep({ now: Date.now() + 31 * 60000 });
check("U23 对照: 手工路径（显式 successor）的取消报告不点名任何「插件新建的会话」——那句话只在插件真的建过会话时出现", manualUnclaimedPrep.includes("换届包已就绪") && manualUnclaimedSweep.cancelled.length === 1 && manualUnclaimedSweep.cancelled[0].caller === SUCCESSOR && !manualUnclaimedSweep.lines.some((line) => line.includes("可收编或关闭")));

const autoCrashEnv = rotateEnv({ askScript: ["创建并交班"], failCreateAt: 0 });
const autoCrash = await autoCrashEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: "auto", handoff: handoffAll }, execFor(autoCrashEnv.senderAgent));
const autoCrashRow = (autoCrashEnv.ns.data.pendingCreates ?? [])[0];
check("U23 崩溃窗口: create 失败即止——未铸令牌、未 freeze，pending-create 意图留在盘上（§11.5 复用 §10.2.6 的意图）", autoCrash.includes("继任者会话创建失败") && autoCrash.includes("意图保留") && autoCrashEnv.role().pending === null && autoCrashEnv.calls("session-worker-a").followedup.length === 0 && autoCrashRow !== undefined && autoCrashRow.team === "night-shift" && autoCrashRow.role === "coordinator" && autoCrashRow.expiresAt > autoCrashRow.createdAt);
const autoCrashSweep = await __testing.sweepPendingCreates(autoCrashEnv.ctx, handoffPolicy(autoCrashEnv), Date.now() + 6 * 60000);
check("U23 崩溃窗口: 该意图被启动清扫报进「可收编清单」（含 id 与手工收编指引），且报告即记录（行被清除）", autoCrashSweep.reported.length === 1 && autoCrashSweep.lines[0].includes(autoCrashRow.sessionId) && autoCrashSweep.lines[0].includes("打开收编") && (autoCrashEnv.ns.data.pendingCreates ?? []).length === 0);

const blockedDocRoot = path.join(TEAM_TMP, "blocked-handoff-root");
await writeFile(blockedDocRoot, "not a directory", "utf8");
const autoDocFailEnv = rotateEnv({ askScript: ["创建并交班"], teams: handoffTeam(blockedDocRoot) });
const autoDocFail = await autoDocFailEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: "auto", handoff: handoffAll }, execFor(autoDocFailEnv.senderAgent));
const autoDocFailId = autoDocFailEnv.creates[0]?.sessionId;
check("U28 文档写失败: abort-before-prepare——不铸令牌（pending 为 null）、不广播 freeze（成员零投递），已建会话如实报为孤儿且不回滚", autoDocFail.includes("abort-before-prepare") && autoDocFail.includes("如实报为孤儿") && autoDocFail.includes(autoDocFailId) && autoDocFailEnv.role().pending === null && autoDocFailEnv.calls("session-worker-a").followedup.length === 0 && autoDocFailEnv.creates.length === 1 && (autoDocFailEnv.ns.data.pendingCreates ?? []).length === 1);

// --- U20/U21/U24: 一次完整的自动换届（auto → claim），信任迁移一步未跳 ---------
const autoFullEnv = rotateEnv({ askScript: ["创建并交班", ["session-worker-a"]], pairs: [rotPair("session-worker-a"), rotPair("session-worker-b"), rotPair(ROT_OUTSIDE), { a: "session-worker-a", b: "session-worker-b", createdAt: 2 }], trustedSenders: [ROT_SELF], rememberTargets: [ROT_SELF] });
const autoFullPrep = await autoFullEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: "auto", handoff: handoffAll }, execFor(autoFullEnv.senderAgent));
const autoFullId = autoFullEnv.role().pending?.session ?? "（没有 pending）";
const autoFullDoc = await __testing.latestHandoffDocument(autoFullEnv.team(), "coordinator");
const autoFullDocText = autoFullDoc.path === null ? "" : await readFile(autoFullDoc.path, "utf8");
const autoFullClaim = await autoFullEnv.rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: tokenOf(autoFullPrep) }, autoFullEnv.exec(autoFullId));
check("U20/U21 同源: 同一份事实同时出现在交接文档（prepare 时刻）与 claim 返回（落定时刻）——候选行→迁移行说的是同一个对端，行模板出自同一个构造器", autoFullDocText.includes(`session-worker-a ↔ ${ROT_SELF} → 待 claim 逐项勾选（域内候选；迁移与否在继任者 ${autoFullId} 认领时落定）`) && autoFullDocText.includes(`session-outside ↔ ${ROT_SELF} → 未迁移（对端不在本团队域内（§3.6.1 原则 2））→ 已随退役清理。`) && autoFullClaim.includes(`session-worker-a ↔ ${ROT_SELF} → 已迁移为 session-worker-a ↔ ${autoFullId}（正式通道）`) && autoFullClaim.includes(`session-worker-b ↔ ${ROT_SELF} → 未迁移（未勾选）→ 已随退役清理；今后该对端走正常首问门。`) && autoFullClaim.includes(`session-outside ↔ ${ROT_SELF} → 未迁移（对端不在本团队域内（§3.6.1 原则 2））→ 已随退役清理。`));
// The migrated pair is stored with the successor first (`a`), exactly as
// `applyRotationTrust` writes it — the expectation is computed here instead of
// hard-coded so a diff can never be mistaken for an ordering difference.
const autoFullExpectedPairs = [`${autoFullId}↔session-worker-a`, "session-worker-a↔session-worker-b"].sort().join(" ");
const autoFullProbe = {
	asks: autoFullEnv.uq.requests.length,
	claimId: autoFullEnv.uq.requests[1]?.questions?.[0]?.id,
	multi: autoFullEnv.uq.requests[1]?.questions?.[0]?.multiSelect,
	pairs: pairSummary(autoFullEnv),
	expected: autoFullExpectedPairs,
	retireeGone: !autoFullEnv.ns.data.pairs.some((pair) => pair.a === ROT_SELF || pair.b === ROT_SELF),
	trusted: autoFullEnv.ns.data.trustedSenders.includes(ROT_SELF),
	remembered: autoFullEnv.ns.data.rememberTargets.includes(ROT_SELF),
	current: autoFullEnv.role().current === autoFullId,
	pending: autoFullEnv.role().pending,
	done: (autoFullEnv.calls("session-worker-a").followedup.at(-1)?.content?.[0]?.text ?? "").includes("[rotation-done]"),
};
check(`U24 红线: 自动换届没有跳过 claim 的任何一步——令牌校验 + 单个多选对话框 + 域限定迁移 + 对称吊销 + roster 落定 + rotation-done`
	+ (autoFullProbe.asks === 2 && autoFullProbe.claimId === "rotation-migrate" && autoFullProbe.multi === true && autoFullProbe.pairs === autoFullExpectedPairs && autoFullProbe.retireeGone && !autoFullProbe.trusted && !autoFullProbe.remembered && autoFullProbe.current && autoFullProbe.pending === null && autoFullProbe.done ? "" : `（实测：${show(autoFullProbe)}）`),
autoFullProbe.asks === 2 && autoFullProbe.claimId === "rotation-migrate" && autoFullProbe.multi === true && autoFullProbe.pairs === autoFullExpectedPairs && autoFullProbe.retireeGone && !autoFullProbe.trusted && !autoFullProbe.remembered && autoFullProbe.current && autoFullProbe.pending === null && autoFullProbe.done);
check("U24 无新日志事件: 一次完整的自动换届（prepare + claim）里，宿主动作仍只有 create/followup 两种（settings 写不在这个日志里，它是另一个出口）", autoFullEnv.actionLog.every((entry) => entry === "create" || entry === "followup"));
// DEFECT-1 的 ③a 端到端对照：认领并落定的那个继任者，就是被挂载过 preset 的那个
// 会话（信任迁移路径上「会建 ≠ 能用」的那一面）。
check("DEFECT-1 ③a 全流程: auto → claim 里认出并落定的那个继任者就是被挂载过 preset 的那个会话，且它自己恰挂一次（否则令牌投给的是一个跑不起来的持钥者）", presetBoundOnce(autoFullEnv) && autoFullEnv.agentPresets.mounts.filter((entry) => entry.agentId === autoFullId).length === 1 && autoFullEnv.creates.filter((options) => options.sessionId === autoFullId).length === 1 && autoFullEnv.role().current === autoFullId);

// --- §11.2 宣传面 = 实现面（命令/描述教的语法必须真能用） ----------------------
const autoTool = autoEnv.tool("team_link_rotate");
const autoToolDesc = autoTool.description;
const autoNoSuccessorEnv = rotateEnv();
const autoNoSuccessorText = await autoNoSuccessorEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator" }, execFor(autoNoSuccessorEnv.senderAgent));
check("§11.2 宣传面=实现面: description / successor 参数说明 / 「缺 successor」的拒绝文案三处教的都是实现支持的那条语法（successor:\"auto\" + handoff 五硬节），没有一处教用户用不支持的写法", autoToolDesc.includes('successor 可以写 "auto"') && autoToolDesc.includes("handoff") && autoToolDesc.includes("§11.9.6") && autoTool.parameters.properties.successor.description.includes('"auto"') && autoTool.parameters.properties.handoff !== undefined && autoTool.parameters.properties.handoff.description.includes("mission") && autoNoSuccessorText.includes('"auto"') && autoNoSuccessorText.includes("§11.2") && autoNoSuccessorText.includes("§3.6.4"));

// ---------------------------------------------------------------------------
// §11.9.3 诊断面（U25）：两道派生词 · 三道门文案富化 · roster get 注记 · 启动清扫
// ---------------------------------------------------------------------------
//
// 这一组把「活性只出现在活着的读面」钉死，并且把**三道门本体仍是纯函数**这件事
// 也钉死——富化全部发生在有 ctx 的工具层（gate 本体一字未动，连签名都没变）。
// 两个派生词刻意不落盘：所以本组还有一条「roster.md 里一个活性词都不许有」的断言。

const diagEnv = rotateEnv();
check("U25 纯函数: 三道门的签名与返回形状一字未动——它们拿不到 ctx，也读不到活性（富化在工具层）", __testing.writerGate.length === 2 && __testing.retireGate.length === 2 && __testing.rotateGate.length === 3 && sameJson(Object.keys(__testing.writerGate(handoffTeam(TEAM_WS)[0], "session-other")), ["error"]) && __testing.writerGate(handoffTeam(TEAM_WS)[0], "session-self").ok === true);

const diagRoles = rotRoles();
check("U25 派生词: vacant（current=null，用户显式表达的空缺）与 seated-dead（有席位但无活代理）在读取时由既有状态派生——刻意空缺上**不加**死亡诊断（两者指向的第一动作不同）", (() => {
	const live = () => true;
	const dead = () => false;
	const seated = diagRoles[0];
	const vacant = { ...seated, current: null };
	const suffix = __testing.recoveryLadderSuffix(seated, dead);
	return __testing.VACANT_LABEL === "vacant" && __testing.SEATED_DEAD_LABEL === "seated-dead"
		&& __testing.recoveryLadderSuffix(seated, live) === ""
		&& __testing.recoveryLadderSuffix(vacant, dead) === ""
		&& __testing.recoveryLadderSuffix(null, dead) === ""
		&& suffix.includes("seated-dead") && suffix.includes(ROT_SELF) && suffix.includes("能通讯、不能改身份")
		&& suffix.includes(__testing.recoveryLadderText());
})());

// Three gates. `session-self` is the seated coordinator; hiding it is exactly what
// a closed session (A4) — or a plugin reload — leaves behind. The enrichment is
// asserted on the TOOL surface, where a ctx exists. `diagLiveEnv` is the control
// group: the same roster with a LIVE incumbent must produce the pre-§11.9 words.
const diagLiveEnv = rotateEnv();
diagEnv.setHiddenAgent("session-self", true);
const diagSetRole = await diagEnv.roster.execute({ action: "set-role", team: "night-shift", role: "worker-a", session: SUCCESSOR }, diagEnv.exec("session-worker-a"));
check("U25 writerGate 富化: set-role 对「有席位但无活代理」的现任给出命名诊断（seated-dead + 恢复梯子），而不是只说「只有现任 X 可写」", diagSetRole.includes("只有现任协调者会话 session-self 可写") && diagSetRole.includes("活性诊断") && diagSetRole.includes("seated-dead") && diagSetRole.includes("team_link_recover action=revive") && diagSetRole.includes("team_link_recover action=reappoint") && diagSetRole.includes("设置 UI") && diagEnv.role("worker-a").current === "session-worker-a");
check("U25 writerGate 富化（第二处调用点）: upsert-team 对既有团队的拒绝同样走同一个包装器；对照是「现任活着、只是调用者不是他」——那种拒绝一个诊断字都不该多", (await diagEnv.roster.execute({ action: "upsert-team", team: "night-shift" }, execFor(diagEnv.agentFor("session-worker-a")))).includes("活性诊断") && !(await diagLiveEnv.roster.execute({ action: "upsert-team", team: "night-shift" }, execFor(diagLiveEnv.agentFor("session-worker-a")))).includes("活性诊断") && !(await diagLiveEnv.roster.execute({ action: "set-role", team: "night-shift", role: "worker-a", session: SUCCESSOR }, diagLiveEnv.exec("session-worker-a"))).includes("活性诊断"));

const diagRetire = await diagEnv.roster.execute({ action: "retire", team: "night-shift", role: "coordinator" }, execFor(diagEnv.agentFor("session-worker-a")));
check("U25 retireGate 富化: 非现任发起退役 + 现任无活代理 → 诊断点明「在侧边栏重开」是第一动作", diagRetire.includes("只有现任协调者会话 session-self 可以发起退役") && diagRetire.includes("活性诊断") && diagRetire.includes("在侧边栏重新打开该会话") && diagEnv.role("coordinator").current === ROT_SELF);

const diagPrepare = await diagEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR, handoff: handoffAll }, diagEnv.exec("session-worker-a"));
check("U25 rotateGate 富化: 死现任下发起换届会被拒，且拒的是同一句原话 + 诊断——否则成员会把「能给死会话投票」当成真的", diagPrepare.includes("只有该角色的现任会话 session-self 可以发起换届") && diagPrepare.includes("活性诊断") && diagPrepare.includes("seated-dead") && diagEnv.role().pending === null);

const diagGet = await diagEnv.roster.execute({ action: "get", team: "night-shift" }, execFor(diagEnv.senderAgent));
check("U25 roster get 注记: 现任无活代理的角色行带一行注记 + 恢复指引（概要行与详情行各一次——两次读数同源，不是两套口径）；活着的角色行保持干净", diagGet.includes("现任 session-self（自") && diagGet.includes("活性诊断") && /角色 worker-a：现任 session-worker-a/u.test(diagGet) && !/角色 worker-b：[^\n【]*\n【活性诊断】/u.test(diagGet) && /角色 coordinator：[^\n【]*\n【活性诊断】/u.test(diagGet));

// roster.md is a FILE on disk: landing a reading there makes it stale the instant
// it lands, and one reload would land a whole wave of them (§10.2.5).
const diagMirror = await readFile(path.join(TEAM_WS, "team", "night-shift", "roster.md"), "utf8");
check("U25 roster.md 刻意不加: 落盘镜像里一个活性词都没有（vacant 保留——它是用户显式表达的持久状态，不是读数）", !diagMirror.includes("seated-dead") && !diagMirror.includes("活性诊断") && !diagMirror.includes("无活代理") && !diagMirror.includes("恢复梯子") && diagMirror.includes("现任：") && diagMirror.includes("角色")
	&& ["coordinator", "worker-a", "worker-b"].every((role) => diagMirror.includes(`### ${role}`)));

// The startup row: the first thing a user sees after a reload took the whole
// plugin-created roster down. Vacant roles are deliberately NOT in it — that is a
// design decision, not an alarm.
const diagStartupEnv = rotateEnv({
	teams: [
		{ name: "night-shift", createdAt: 1_700_000_000_000, workspace: TEAM_WS, policy: { writer: "coordinator" }, roles: [...rotRoles().slice(0, 1), { role: "worker-c", current: "session-dead", pending: null, history: [] }] },
		{ name: "day-shift", createdAt: 1_700_000_000_000, workspace: TEAM_WS, policy: { writer: "coordinator" }, roles: [{ role: "coordinator", current: null, pending: null, history: [{ session: "session-self", from: 1, until: 2 }] }] },
	],
});
const diagStartup = await __testing.sweepPendingCreates(diagStartupEnv.ctx, handoffPolicy(diagStartupEnv));
check("U25 启动清扫: 新增一行「各团队 current 无活代理的角色」——跨团队列出，带 id 与恢复梯子；刻意空缺（current=null）不误报", diagStartup.reported.length === 0 && diagStartup.lines.length === 1 && diagStartup.lines[0].includes("night-shift") && diagStartup.lines[0].includes("worker-c") && diagStartup.lines[0].includes("session-dead") && diagStartup.lines[0].includes("seated-dead") && diagStartup.lines[0].includes("team_link_recover") && !diagStartup.lines[0].includes("day-shift") && !diagStartup.lines[0].includes("coordinator"));

const diagQuietEnv = rotateEnv();
const diagQuiet = await __testing.sweepPendingCreates(diagQuietEnv.ctx, handoffPolicy(diagQuietEnv));
check("U25 启动清扫: 全员活着 → 零行（清单只在真有悬空指针时出现，不是每次都刷屏）", diagQuiet.lines.length === 0 && diagQuiet.reported.length === 0);

// ---------------------------------------------------------------------------
// §11.9.4 L1 revive（U26）：同一个会话复活 · 适用域 · fail-closed · 三处留痕
// ---------------------------------------------------------------------------
//
// `agents.resume` 桩的语义与本组绑死：桩按 `resumeRecords`（盘上会话清单）载入，
// 对**已经活着**的 id 拒绝（真实 registry 也拒——单写者），并把复活出来的代理发布
// 进**同一个** `agents.get` 注册表。于是「复活后 writerGate 按 id 比对直接放行」
// 是实测的，而不是被假设的。

const REVIVE_ROOT = path.join(TEAM_TMP, "revive-ws");
/** 上一轮插件自建的会话 id（§10.2.2 的文法），本进程没有它的 AgentHandle——
 * 那正是「重载之后」的形态，也是 L1 存在的理由。 */
const REVIVE_PLUGIN_ID = "team-link-night-shift-coordinator-deadbeef";
const reviveTeam = (roles) => [{ name: "night-shift", createdAt: 1_700_000_000_000, workspace: REVIVE_ROOT, policy: { writer: "coordinator" }, roles: [reviveCallerRole(), ...roles] }];
/** The caller a §11.9.5 **initiator domain** accepts: a LIVE member role. Most of
 * this block's revives are issued by "session-target" — the harness' own target
 * agent, so it is live in every one of these fixtures — and before the domain check
 * that was enough, because `caller` only fed the audit trail. §11.9.5 makes the
 * initiator a hard set ({该角色最近一任前任} ∪ {团队现任成员}), so the caller has to
 * BE one. Seeding it as a role here instead of editing six call sites keeps the
 * fixture honest: an unaffiliated session really is refused, and the two Y2 cases
 * below seed exactly that and assert the refusal. */
const reviveCallerRole = () => ({ role: "auditor", current: "session-target", pending: null, history: [{ session: "session-target", from: 1_700_000_000_000, until: null }] });
/** 读盘上文件，不存在时回一个可读的占位串（写失败的断言应当红在断言上，不是崩在 readFile 上）。 */
async function readOrMissing(file) {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		return `（读取失败：${error?.code ?? error}）`;
	}
}
const reviveEnv = rotateEnv({
	askScript: ["执行恢复"],
	teams: reviveTeam([
		{ role: "coordinator", current: REVIVE_PLUGIN_ID, pending: null, history: [{ session: REVIVE_PLUGIN_ID, from: 1_700_000_000_000, until: null }] },
		{ role: "worker-a", current: "session-worker-a", pending: null, history: [{ session: "session-worker-a", from: 1_700_000_000_000, until: null }] },
	]),
});
reviveEnv.setHiddenAgent(REVIVE_PLUGIN_ID, true);
declareDormantSession(reviveEnv, REVIVE_PLUGIN_ID);
const reviveTool = reviveEnv.tool("team_link_recover");
const revivePre = reviveEnv.role("coordinator");
const reviveOut = await reviveTool.execute({ action: "revive", team: "night-shift", role: "coordinator" }, execFor(reviveEnv.agentFor("session-worker-a")));
const revivePost = reviveEnv.role("coordinator");
const reviveMirror = await readOrMissing(path.join(REVIVE_ROOT, "team", "night-shift", "roster.md"));
const reviveDecisions = await readOrMissing(path.join(REVIVE_ROOT, "team", "night-shift", "decisions.md"));

check("U26 入口: team_link_recover 注册出来，恰两个封闭动词，参数面只有 action/team/role——**没有**任何能承载继任者 id 的参数", reviveTool !== undefined
	&& sameJson(reviveTool.parameters.properties.action.enum, ["revive", "reappoint"])
	&& sameJson(Object.keys(reviveTool.parameters.properties).sort(), ["action", "role", "team"])
	&& sameJson(reviveTool.parameters.required, ["action", "team"])
	&& __testing.RECOVERY_ACTIONS.size === 2 && __testing.RECOVERY_ACTIONS.has("revive") && __testing.RECOVERY_ACTIONS.has("reappoint")
	&& !Object.keys(reviveTool.parameters.properties).some((key) => /successor|target|session/iu.test(key)));
// The closed verb set is enforced TWICE, and the test asserts both halves: the
// registered parameter schema refuses any third value at the tool boundary (the
// `ToolArgsError` below), and `RECOVERY_ACTIONS` refuses it at the handler — so
// neither an unknown verb nor a roster-field write can be smuggled in as one.
const reviveBadVerb = await rejects(reviveTool, { action: "set-role", team: "night-shift", role: "coordinator", session: "session-self" }, execFor(reviveEnv.agentFor("session-worker-a")));
check("U26 动词封闭: 第三个动词（以及任何 roster 字段写入的伪装）在**参数边界**就被拒（ToolArgsError + enum 恰两项 + 处理层同一份动词集）——「恢复」不会退化成第二把更松的 roster 编辑器", reviveBadVerb instanceof Error
	&& reviveBadVerb.code === "INVALID_ARGS"
	&& sameJson(reviveTool.parameters.properties.action.enum, ["revive", "reappoint"])
	&& __testing.RECOVERY_ACTIONS.size === 2
	&& !("session" in reviveTool.parameters.properties));

// ⚠️ 这条原本钉的是 `Object.keys(resumeCalls[0]).length === 1`（**只有** `resumeSessionId`）
// —— 那个「恰好一个键」的形状**就是 DEFECT-5 本身**：宿主自己的 resume 要的是三样
// （`resumeSessionId` + `agentOptions` + `setup`，`dsh-api-session-controller:406-410`），
// 少了两样复活出来的代理就没有模型选择、也没有 preset 组装源。判据已改为**逐字钉那三个键**
// （见下面的 DEFECT-5 组）。
check("U26 revive: 插件自建会话（id 文法 team-link-<team>-<role>-<uuid8>，重载后已无 handle）→ resume 同一个 id，身份不变、roster 不动、信任零改动", reviveEnv.resumeCalls.length === 1 && at(reviveEnv.resumeCalls, 0, {}).resumeSessionId === REVIVE_PLUGIN_ID && Object.keys(at(reviveEnv.resumeCalls, 0, {})).sort().join(",") === "agentOptions,resumeSessionId,setup" && revivePost.current === revivePre.current && revivePost.pending === null && sameJson(revivePost.history, revivePre.history) && (reviveEnv.ns.data.pairs ?? []).length === 0 && reviveOut.includes("已恢复（revive）") && reviveOut.includes("身份不变"));
check("U26 revive: 复活出来的代理真的进了同一个注册表——writerGate 按 id 比对直接放行，不需要放宽任何门", reviveEnv.agentFor(REVIVE_PLUGIN_ID) !== undefined && __testing.agentIsLive(reviveEnv.ctx, REVIVE_PLUGIN_ID) === true && __testing.writerGate(reviveEnv.team(), REVIVE_PLUGIN_ID).ok === true && __testing.writerGate(reviveEnv.team(), "session-worker-a").error !== undefined);
check("U26 生命周期: handle 归插件（与 agents.create 同一条生命周期纪律），并如实声明卸载/重载会再次拆掉它", __testing.teamSessionFor(reviveEnv.ctx).hasHandle(REVIVE_PLUGIN_ID) === true && reviveOut.includes("运行时所有权归本插件") && reviveOut.includes("可再次 revive"));

// §11.9.5②: the preconditions are re-observed from the host, from a clean window,
// so this case is about the CONDITION and not about the rate limit.
const reviveAliveEnv = rotateEnv({ askScript: ["执行恢复"], teams: reviveTeam([{ role: "coordinator", current: "session-worker-a", pending: null, history: [] }]) });
const reviveAlive = await reviveAliveEnv.tool("team_link_recover").execute({ action: "revive", team: "night-shift", role: "coordinator" }, execFor(reviveAliveEnv.agentFor("session-target")));
// The raw namespace row is the SEED (nothing wrote the store in this case), so
// "no write happened" is asserted on the raw row: no rotation stamp, no recovery
// row, no dialog, no resume.
check("U26 TOCTOU/幂等: 现任已经活着的再恢复 → 拒绝并说明原因（条件由宿主观测，不由调用方主张），零 resume、零写入（连限速戳都不落）、连确认框都不弹", reviveAlive.includes("有活动代理") && reviveAlive.includes("恢复只用于") && reviveAlive.includes("条件由宿主观测") && reviveAlive.includes("team_link_rotate action=prepare") && reviveAliveEnv.resumeCalls.length === 0 && !reviveAliveEnv.role().rotationAt && reviveAliveEnv.role().recoveries === undefined && reviveAliveEnv.uq.requests.length === 0);

const reviveHumanEnv = rotateEnv({ askScript: ["执行恢复"], teams: reviveTeam([{ role: "coordinator", current: "session-worker-a", pending: null, history: [{ session: "session-worker-a", from: 1_700_000_000_000, until: null }] }]) });
reviveHumanEnv.setHiddenAgent("session-worker-a", true);
const reviveHuman = await reviveHumanEnv.tool("team_link_recover").execute({ action: "revive", team: "night-shift", role: "coordinator" }, execFor(reviveHumanEnv.agentFor("session-target")));
check("U26 适用域（D7）: 人类自建会话（非 team-link-<t>-<r>-<uuid8> 且无 handle）→ 只给深链指引，零 resume、零写入——resume 的 ownerCtx 是插件根 ctx，对它会把它生命周期从 UI 转给插件，比现状更差", reviveHuman.includes("不是本插件创建的会话") && reviveHuman.includes("在侧边栏重新打开会话 session-worker-a") && reviveHuman.includes("ownerCtx") && reviveHumanEnv.resumeCalls.length === 0 && (reviveHumanEnv.role().recoveries ?? []).length === 0 && reviveHumanEnv.uq.requests.length === 0);

const reviveNoResumeEnv = rotateEnv({ askScript: ["执行恢复"], teams: reviveTeam([{ role: "coordinator", current: REVIVE_PLUGIN_ID, pending: null, history: [{ session: REVIVE_PLUGIN_ID, from: 1_700_000_000_000, until: null }] }]), omitResume: true });
reviveNoResumeEnv.setHiddenAgent(REVIVE_PLUGIN_ID, true);
const reviveNoResume = await reviveNoResumeEnv.tool("team_link_recover").execute({ action: "revive", team: "night-shift", role: "coordinator" }, execFor(reviveNoResumeEnv.agentFor("session-target")));
check("U26 fail-closed: 无 factory / 无 sessionPersistence（agents.resume 缺失）→ 报告原因且零改动（roster 未动、信任未动、没有放弃所有权的代理），并给出 reappoint / 侧边栏 / 设置 UI 三条退路", reviveNoResume.includes("没有可用的 ctx.agents.resume") && reviveNoResume.includes("fail-closed") && reviveNoResume.includes("roster 未动、信任未动、没有任何放弃所有权的代理") && reviveNoResume.includes("reappoint") && reviveNoResume.includes("设置 UI") && (reviveNoResumeEnv.role().recoveries ?? []).length === 0 && reviveNoResumeEnv.role().current === REVIVE_PLUGIN_ID && reviveNoResumeEnv.uq.requests.length === 0);

const reviveNoConfirmEnv = rotateEnv({ omitUserQuestions: true, teams: reviveTeam([{ role: "coordinator", current: REVIVE_PLUGIN_ID, pending: null, history: [] }]) });
reviveNoConfirmEnv.setHiddenAgent(REVIVE_PLUGIN_ID, true);
const reviveNoConfirm = await reviveNoConfirmEnv.tool("team_link_recover").execute({ action: "revive", team: "night-shift", role: "coordinator" }, execFor(reviveNoConfirmEnv.agentFor("session-target")));
check("U26 无确认服务: fail-closed、零 resume、零写入，且文案点明与 claim 的刻意不对称（pair 可自动回退、身份不可）与「刻意没有 provisional」", reviveNoConfirm.includes("确认服务（userQuestions）不可用") && reviveNoConfirm.includes("fail-closed") && reviveNoConfirm.includes("刻意没有 provisional") && reviveNoConfirmEnv.resumeCalls.length === 0 && (reviveNoConfirmEnv.role().recoveries ?? []).length === 0);

// Y7（③b 差异审计）: the `?? []` guard the sibling assertions above already carry.
// Without it a break anywhere upstream turns this line into a TypeError that ABORTS
// the run before `assertion total` — the audit saw exactly that (`5 FAIL`, no
// total), which is what makes a red run unreadable. `at()` is the shared form of
// that guard (see its definition); the recoveries array is a role-row field whose
// absence is itself the defect being asserted.
check("U26 留痕①版本史: 恢复记录落进 role 行的 recoveries（verb/from/to/at/by/note），note 用固定措辞并具名发起者，且**同一笔**更新占用限速戳 rotationAt", (revivePost.recoveries ?? []).length === 1 && at(revivePost.recoveries, 0, {}).verb === "revive" && at(revivePost.recoveries, 0, {}).from === REVIVE_PLUGIN_ID && at(revivePost.recoveries, 0, {}).to === REVIVE_PLUGIN_ID && at(revivePost.recoveries, 0, {}).by === "session-worker-a" && at(revivePost.recoveries, 0, {}).at > 0 && String(at(revivePost.recoveries, 0, {}).note).includes("recovery(revive, vacant-due-to-death,") && String(at(revivePost.recoveries, 0, {}).note).includes("requester=session-worker-a") && revivePost.rotationAt === at(revivePost.recoveries, 0, {}).at);check("U26 留痕②roster.md: 镜像渲染恢复记录（与 roster get 同源），且镜像里仍然没有任何活性读数——版本史备注用的是设计自己的理由词 vacant-due-to-death，不是 seated-dead", reviveMirror.includes("恢复记录") && reviveMirror.includes(`revive　${REVIVE_PLUGIN_ID} → ${REVIVE_PLUGIN_ID}`) && reviveMirror.includes("vacant-due-to-death") && reviveMirror.includes("requester=session-worker-a") && !reviveMirror.includes("seated-dead") && !reviveMirror.includes("活性诊断"));
check("U26 留痕③decisions.md: 追加一行团队账本（黑板没有写权限门，所以死锁下也能落账）——seq 单调、author 具名", /^1 \| \d{4}-\d{2}-\d{2}T/u.test(reviveDecisions) && reviveDecisions.includes("| session-worker-a | recovery revive team=night-shift role=coordinator") && reviveDecisions.includes(`from=${REVIVE_PLUGIN_ID}`) && reviveDecisions.includes(`to=${REVIVE_PLUGIN_ID}`) && reviveDecisions.includes("seated-dead"));
check("U26 roster get: 恢复记录也在工具读面上（与镜像同一批名字——一个事实一处口径）", (await reviveEnv.roster.execute({ action: "get", team: "night-shift" }, execFor(reviveEnv.agentFor("session-worker-a")))).includes("恢复记录（共 1 条"));

// §11.9.5⑦'s anti-storm window, and §11.9.5⑥'s refusal to "fix" the jam by
// weakening the team.
const reviveRateEnv = rotateEnv({ askScript: ["执行恢复"], teams: reviveTeam([{ role: "coordinator", current: REVIVE_PLUGIN_ID, pending: null, rotationAt: Date.now() - 60000, history: [] }]) });
reviveRateEnv.setHiddenAgent(REVIVE_PLUGIN_ID, true);
const reviveRateOut = await reviveRateEnv.tool("team_link_recover").execute({ action: "revive", team: "night-shift", role: "coordinator" }, execFor(reviveRateEnv.agentFor("session-target")));
check("U26 限速: 10 分钟窗口内的第二次恢复被拒（并给出剩余时间），零 resume、零写入、连确认框都不弹——防对话框轰炸", reviveRateOut.includes("恢复速率限制") && reviveRateOut.includes("窗口剩余约") && reviveRateEnv.resumeCalls.length === 0 && (reviveRateEnv.role().recoveries ?? []).length === 0 && reviveRateEnv.uq.requests.length === 0);
check("U26 ⑥红线: 恢复不改权限模型——writer=coordinator 原样留着（绝不把 writer 降级为 any 当作「修复」）", reviveEnv.ns.data.teams[0].policy.writer === "coordinator" && reviveOut.includes("policy.writer 未动（仍是 coordinator）") && reviveOut.includes("绝不把 writer 降级为 any"));

const revivePendEnv = rotateEnv({ askScript: ["执行恢复"], teams: reviveTeam([{ role: "coordinator", current: REVIVE_PLUGIN_ID, pending: { session: SUCCESSOR, token: "tok", team: "night-shift", role: "coordinator", expiresAt: Date.now() + 600000, createdAt: Date.now(), migratedPairs: [] }, history: [] }]) });
revivePendEnv.setHiddenAgent(REVIVE_PLUGIN_ID, true);
const revivePendOut = await revivePendEnv.tool("team_link_recover").execute({ action: "revive", team: "night-shift", role: "coordinator" }, execFor(revivePendEnv.agentFor("session-target")));
check("U26 ⑧先清扫 + 不插队: 有未过期在飞令牌 → 拒绝并告知道期时间（让 sweep 或 claim 先走），零 resume、零写入", revivePendOut.includes("已有在飞的换届令牌") && revivePendOut.includes("过期被清扫") && revivePendEnv.resumeCalls.length === 0 && revivePendEnv.role().pending !== null);

const reviveVacantEnv = rotateEnv({ askScript: ["执行恢复"], teams: reviveTeam([{ role: "coordinator", current: null, pending: null, history: [{ session: REVIVE_PLUGIN_ID, from: 1, until: 2 }] }]) });
const reviveVacant = await reviveVacantEnv.tool("team_link_recover").execute({ action: "revive", team: "night-shift", role: "coordinator" }, execFor(reviveVacantEnv.agentFor("session-target")));
check("U26 刻意空缺 ≠ 死亡空缺: current=null 时 revive 说清「没有 id 可复活」并把用户指向 reappoint / 设置 UI——两种空缺拿到不同的第一动作", reviveVacant.includes("刻意空缺") && reviveVacant.includes("没有 id 可复活") && reviveVacant.includes("reappoint") && reviveVacant.includes("设置 UI") && reviveVacantEnv.resumeCalls.length === 0);

// 批次 2 §4.2 (a) 的语义变更（旧断言在这里被推翻，本轮改写而不是删掉）：
// 这条曾经钉「本工具只为 coordinator 恢复」。§11.9.1 只论证过「死的 coordinator
// 必须可救」，从未论证「死的 worker 不许救活」——而重载拆掉的是**所有**插件自建
// 会话。现在同一个调用不再被角色门拒绝，它走到的是**下一步**（该角色现任是活人 ⇒
// 恢复的前提不成立），所以这条锁改成咬「拒绝理由不再是角色」这件事。
const reviveScopeOut = await reviveTool.execute({ action: "revive", team: "night-shift", role: "worker-a" }, execFor(reviveEnv.agentFor("session-worker-a")));
// 实质判据要在**没有限速干扰**的新环境里读：`reviveEnv` 上刚刚成功恢复过一次，同一个
// 角色的第二次调用会先撞上 10 分钟窗口（那是另一条断言的面）。
const reviveRoleFaceEnv = rotateEnv({
	askScript: ["执行恢复"],
	teams: reviveTeam([
		{ role: "coordinator", current: "session-target", pending: null, history: [] },
		{ role: "worker-a", current: "session-worker-a", pending: null, history: [{ session: "session-worker-a", from: 1_700_000_000_000, until: null }] },
	]),
	extraAgents: [{ id: "session-worker-a", status: "idle" }],
});
const reviveRoleFace = await reviveRoleFaceEnv.tool("team_link_recover").execute({ action: "revive", team: "night-shift", role: "worker-a" }, execFor(reviveRoleFaceEnv.agentFor("session-target")));
check("U26 角色面（批次 2 §4.2 (a) 改写）: 非 coordinator 角色不再被角色门拒绝——同一个调用现在走到实质判据（该角色现任有活代理 ⇒ 无需恢复），文案里不再有「本工具只为 coordinator 角色恢复」", (() => {
	const ok = !reviveScopeOut.includes("本工具只为 coordinator 角色恢复") && reviveScopeOut.includes("有活动代理") && reviveRoleFace.includes("有活动代理") && !reviveRoleFace.includes("只为 coordinator") && reviveRoleFaceEnv.resumeCalls.length === 0;
	return ok || (console.log(`     实测读数 {scope:${JSON.stringify(reviveScopeOut.slice(0, 120))}, roleFace:${JSON.stringify(reviveRoleFace.slice(0, 160))}, resumes:${reviveEnv.resumeCalls.length}/${reviveRoleFaceEnv.resumeCalls.length}}`), false);
})());

// --- Y3 的**对称件**（§11.9.9 点名的那条「半空锁」）：`revive` 侧的身份复检也必须是
// 一条**行为锁**，而不是被活性那条的文案顺带覆盖住的空锁 -------------------------
//
// 设计原文（§11.9.9）：`reappoint` 的身份复检已在修复轮落成行为锁（下面 Y3），但
// `revive` 侧**同款**的那条复检没有任何断言单独咬住它——它对「现任被改任给另一个会话」
// 同样为假，所以任何只 grep 拒绝文案的断言都可能照样绿（同源化把锁变成空锁，第七次）。
// 这里按 Y3 的形状补上对称的两条，**两条各咬各的复检**，不得互相顶替：
//   ① 对话框期间现任被改任给**另一个（同样是死的）**会话 ⇒ 活性复检读的是**本次调用
//      在 preflight 捕获的那个 incumbent**，而那个是死的 ⇒ 活性复检响不了 ⇒ 只有身份
//      复检能拒绝。删掉身份复检，这次调用会一路 `resume`（下面 fixture 里那个会话在盘上、
//      可被复活，所以红相是「真的复活了」而不是「抛了个别的错」）。
//   ② 现任 id **没变**、只是被人重新打开了 ⇒ 由**活性**复检拒绝，且它必须只说活性
//      （把身份那句抄过来，这条红）。
const reviveRaceRoles = () => [
	{ role: "coordinator", current: REVIVE_PLUGIN_ID, pending: null, rotationAt: 0, history: [{ session: REVIVE_PLUGIN_ID, from: 1_700_000_000_000, until: null }] },
	{ role: "worker-a", current: "session-worker-a", pending: null, rotationAt: 0, history: [{ session: "session-worker-a", from: 1_700_000_000_000, until: null }] },
];
const reviveRaceEnv = rotateEnv({
	askScript: [],
	extraAgents: [{ id: "session-worker-a", status: "idle" }, { id: "session-replacement-dead", status: "idle" }],
	teams: reviveTeam(reviveRaceRoles()),
});
// 新现任也没有活动代理（死活不论——评审给的是「另一个（死活不论）的会话 id」，这里取死的那一种，
// 因为它才是**只有身份复检能拒绝**的那一格）。
reviveRaceEnv.setHiddenAgent("session-replacement-dead", true);
declareDormantSession(reviveRaceEnv, REVIVE_PLUGIN_ID);
reviveRaceEnv.setScript(() => {
	// 人在这段时间里把该角色改任给了另一个会话（不是打开它，是**换人**）。
	reviveRaceEnv.role("coordinator").current = "session-replacement-dead";
	return ["执行恢复"];
});
const reviveRace = await reviveRaceEnv.tool("team_link_recover").execute({ action: "revive", team: "night-shift", role: "coordinator" }, execFor(reviveRaceEnv.agentFor("session-worker-a")));
check("Y3-sym（revive 身份复检·行为锁）: 对话框期间现任被改任成**另一个（死的）**会话 → 只能由**身份**复检拒绝（活性复检看的是本次调用那个死的 incumbent，响不了）；删掉身份复检这条立即红——它会一路 resume 出 resumeCalls=1", reviveRace.includes("（revive，写前复检）") && reviveRace.includes(`该角色的现任已不是 ${REVIVE_PLUGIN_ID}`) && reviveRace.includes("现在是 session-replacement-dead") && reviveRace.includes("别把令牌式的身份主张当成当前事实") && !reviveRace.includes("已经有活动代理了") && reviveRaceEnv.resumeCalls.length === 0 && (reviveRaceEnv.role().recoveries ?? []).length === 0 && !reviveRaceEnv.role().rotationAt);

// 对照组（Y7「干净红」纪律：这条与身份复检**不是**同一个判据，别把它当重复删掉）:
// 现任 id **没变**、只是复活了 → 由**活性**复检拒绝并说「已经有活动代理了」，
// 且它的话**不是**身份复检那一句。把身份复检的话抄过来，这条红。
const reviveRaceAliveEnv = rotateEnv({
	askScript: [],
	// 被 unhide 成「活的」需要它**注册在册**（hidden ⇒ `agents.get() === undefined`），
	// 所以这一格里 incumbent 必须是 stub agent 之一，`setHiddenAgent(…, false)` 才真的生效。
	extraAgents: [{ id: REVIVE_PLUGIN_ID, status: "idle" }, { id: "session-worker-a", status: "idle" }],
	teams: reviveTeam(reviveRaceRoles()),
});
reviveRaceAliveEnv.setHiddenAgent(REVIVE_PLUGIN_ID, true);
declareDormantSession(reviveRaceAliveEnv, REVIVE_PLUGIN_ID);
reviveRaceAliveEnv.setScript(() => {
	// 反例：现任 **id 没变**，只是有人把它在侧边栏重新打开了。
	reviveRaceAliveEnv.setHiddenAgent(REVIVE_PLUGIN_ID, false);
	return ["执行恢复"];
});
const reviveRaceAlive = await reviveRaceAliveEnv.tool("team_link_recover").execute({ action: "revive", team: "night-shift", role: "coordinator" }, execFor(reviveRaceAliveEnv.agentFor("session-worker-a")));
check("Y7-sym（revive 活性对照·干净红）: 现任 id 没变、只是复活了 → 由**活性**复检拒绝并说「已经有活动代理了」（与身份复检那句**不是同一句**；把身份复检的话抄过来，这条红）", reviveRaceAlive.includes("（revive，写前复检）") && reviveRaceAlive.includes("已经有活动代理了") && reviveRaceAlive.includes("它本来就不需要恢复") && !reviveRaceAlive.includes("现任已不是") && !reviveRaceAlive.includes("别把令牌式的身份主张当成当前事实") && reviveRaceAliveEnv.resumeCalls.length === 0 && (reviveRaceAliveEnv.role().recoveries ?? []).length === 0);

// --- Y2（③b 差异审计）：§11.9.5 的**发起域**必须真在实现里 ---------------------
//
// 审计实测：`caller` 原本只用于留痕，**与团队无关的活会话、甚至没有会话身份的调用者**
// 都能发起并铸令牌。设计（§11.9.5，正文 469 行）把它写成硬集合，所以这里把「谁可以
// 发起」落成可执行的判据，而不是文档里的一句话。域外的拒绝必须**指出设置 UI 仍是
// 永远可用的出口**（R2 级）——否则被挡住的会话会以为整件事做不了。
//
// 三半各自把守：① 非成员**活**会话被拒；② **无会话身份**被拒；③ 该角色的**最近一任
// 前任**可以发起（发起权不依赖信任、只依赖身份资格）——三半缺一，这条锁就退化成
// 「有个人在 roster 里就行」。
const reviveGuestEnv = rotateEnv({
	askScript: ["执行恢复"],
	// The guest is a REAL live session in this workspace — the whole point is that it
	// is alive and simply not a member (§11.9.5: 域外的**活**会话被拒), not that it
	// failed to resolve.
	extraAgents: [{ id: "session-outside", status: "idle" }, { id: "session-worker-a", status: "idle" }],
	teams: reviveTeam([
		{ role: "coordinator", current: REVIVE_PLUGIN_ID, pending: null, history: [{ session: REVIVE_PLUGIN_ID, from: 1_700_000_000_000, until: null }] },
		{ role: "worker-a", current: "session-worker-a", pending: null, history: [{ session: "session-worker-a", from: 1_700_000_000_000, until: null }] },
	]),
});
reviveGuestEnv.setHiddenAgent(REVIVE_PLUGIN_ID, true);
declareDormantSession(reviveGuestEnv, REVIVE_PLUGIN_ID);
const reviveGuest = await reviveGuestEnv.tool("team_link_recover").execute({ action: "revive", team: "night-shift", role: "coordinator" }, execFor(reviveGuestEnv.agentFor("session-outside")));
check("Y2 发起域: 与团队无关的**活**会话发起恢复 → 拒绝，并点名「现任成员集合 / 该角色前任 / 调用会话」三样 + 设置 UI（R2 级）这个永远可用的出口；零 resume、零写入（承诺限定在**本次调用自身**——B2）、连确认框都不弹", reviveGuest.includes("恢复被拒绝（发起域，§11.9.5）") && reviveGuest.includes("现任成员") && reviveGuest.includes("session-outside") && reviveGuest.includes("session-worker-a") && reviveGuest.includes("也不是该角色的前任 （无前任记录）") && reviveGuest.includes("设置 UI") && reviveGuest.includes("本次恢复调用自身零写入") && reviveGuestEnv.resumeCalls.length === 0 && (reviveGuestEnv.role().recoveries ?? []).length === 0 && !reviveGuestEnv.role().rotationAt && reviveGuestEnv.uq.requests.length === 0);

// A caller with NO session identity at all is the sharpest form of the same hole:
// `caller === undefined` used to sail straight through into the dialog (and, with
// a scripted answer, into a real `resume`).
const reviveAnonymous = await reviveGuestEnv.tool("team_link_recover").execute({ action: "revive", team: "night-shift", role: "coordinator" }, { signal: new AbortController().signal });
check("Y2 发起域: 连会话身份都没有的调用者（`agent === undefined`）同样被拒——域判据由宿主从 roster 读，不由调用方主张；零 resume、零写入", reviveAnonymous.includes("恢复被拒绝（发起域，§11.9.5）") && reviveAnonymous.includes("没有会话身份") && reviveAnonymous.includes("设置 UI") && reviveGuestEnv.resumeCalls.length === 0 && reviveGuestEnv.uq.requests.length === 0 && (reviveGuestEnv.role().recoveries ?? []).length === 0);

// The predecessor half. The caller is a REAL live session (which is why it must
// NOT be hidden: a hidden agent resolves to `undefined`, so `agentSessionId` would
// report "（无会话身份）" — a different refusal than the one under test) that is no
// longer on the team: it held this role before, and `history` is what says so.
const reviveExEnv = rotateEnv({
	askScript: ["执行恢复"],
	extraAgents: [{ id: "session-previous-holder", status: "idle" }],
	teams: reviveTeam([
		{ role: "coordinator", current: REVIVE_PLUGIN_ID, pending: null, history: [{ session: "session-previous-holder", from: 1, until: 1_700_000_000_000 }, { session: REVIVE_PLUGIN_ID, from: 1_700_000_000_000, until: null }] },
	]),
});
reviveExEnv.setHiddenAgent(REVIVE_PLUGIN_ID, true);
declareDormantSession(reviveExEnv, REVIVE_PLUGIN_ID);
const reviveEx = await reviveExEnv.tool("team_link_recover").execute({ action: "revive", team: "night-shift", role: "coordinator" }, execFor(reviveExEnv.agentFor("session-previous-holder")));
check("Y2 发起域（另一半）: 该角色的**最近一任前任**可以发起——发起权不依赖信任、只依赖身份资格（这条同时是反例：没有它，「只有成员能发起」这个更严的误读也会全绿）", reviveEx.includes("已恢复（revive）") && reviveExEnv.resumeCalls.length === 1 && at(reviveExEnv.resumeCalls, 0, {}).resumeSessionId === REVIVE_PLUGIN_ID && (reviveExEnv.role().recoveries ?? []).length === 1 && at(reviveExEnv.role().recoveries, 0, {}).by === "session-previous-holder");

check("Y2 宣传面=实现面（批次 2 改写）: 工具描述写的是「两个动词都受理任意角色、差别在动词语义上」这句实现面的话，发起域在描述里有落点，且旧窄域措辞一处不剩", reviveTool.description.includes("两个动词都受理任意角色") && reviveTool.description.includes("发起域") && !reviveTool.description.includes("本工具只为 coordinator 角色恢复（请求的是") && !reviveTool.description.includes("`revive` 只受理 coordinator") && reviveTool.parameters.properties.role.description.includes("两个动词都受理任意角色") && __testing.RECOVERY_ACTIONS.has("reappoint"));

const reviveDiagEnv = rotateEnv({ askScript: [], teams: reviveTeam([
	{ role: "coordinator", current: REVIVE_PLUGIN_ID, pending: null, history: [] },
	{ role: "worker-a", current: "session-worker-a", pending: null, history: [] },
]) });
reviveDiagEnv.setHiddenAgent(REVIVE_PLUGIN_ID, true);
const reviveDiag = await reviveDiagEnv.tool("team_link_recover").execute({ action: "revive", team: "night-shift" }, execFor(reviveDiagEnv.agentFor("session-target")));
check("U26 诊断读态: 不带 role → 每角色一行（现任 + 活性 + 在飞令牌）+ 恢复入口 + 硬死锁只有一格，**零副作用**（无确认框、无 resume、无写入）", reviveDiag.includes("恢复诊断") && reviveDiag.includes("零副作用") && reviveDiag.includes("角色 coordinator") && reviveDiag.includes("seated-dead（无活代理）") && reviveDiag.includes("角色 worker-a") && reviveDiag.includes("有活代理") && reviveDiag.includes("（无在飞令牌）") && reviveDiag.includes("硬死锁只有一格") && reviveDiagEnv.uq.requests.length === 0 && reviveDiagEnv.resumeCalls.length === 0 && (reviveDiagEnv.role().recoveries ?? []).length === 0);

// ---------------------------------------------------------------------------
// DEFECT-5（真机 2026-09-30）：revive 面必须走同一条「能跑起来」的组装时序
// ---------------------------------------------------------------------------
// 真机现象（用户原话）：「worker会话重启后报错 —— 处理失败 / 本轮运行失败 prompt variable
// "{{model}}" has no value for this assembly (section "deployment:persona-prefix")」。
// **取证链（每条都可复核）**：策略档 `~/.dsh/team-link/policy.json` 的 recoveries 行
// 记着团队 `mal-analyze-cli-20260929` 的 worker-1..4 在本机 12:47:46 / 12:50:28 /
// 12:50:33 / 12:50:38 各被 `team_link_recover action=revive` 复活过；四个会话日志里
// **复活后的第一回合**（12:50:54 / :55 / :55 / :55，turn 14 / 18 / 18 / 22）逐字报
// 同一个错。同一晚未被 revive 过的 threat-intel worker 四条日志里这个错 **0 命中**。
//
// **根因与 DEFECT-1 / DEFECT-3 是同一个缺陷类，只是换了一条路径**：`recoverRevive` 调
// `ctx.agents.resume({ resumeSessionId })`，一个键都没多给——
//   - 没有 `agentOptions` ⇒ 复活出来的 agent **没有任何模型选择**，而 `{{model}}` 的唯一
//     来源就是 `context.agent?.options.model`（`dsh-agent-loop:1565`）⇒ 首回合死在
//     `deployment:persona-prefix` 的 `{{model}}` 上（DEFECT-3 的机制在这里原样复现）；
//   - 没有 `setup` ⇒ **preset 组装源没挂**，而 `standard` preset 正是这个 agent 的**工具面**
//     （`dsh-web-app/presets/standard.patch.yml`：bash/pwsh/fs/jobs/plan-mode/… 全在组成里）
//     ⇒ 就算模型那一关过了，复活出来的 worker 也拿不回它自己的工具面（DEFECT-1 的机制）。
// 宿主**自己**的 resume（`dsh-api-session-controller:399-410`）给的正是三样：
// `resumeSessionId` + `agentOptions: {provider, model} = agentDefaultModel.currentSelection()` +
// `setup: composeAgent(presetForObservation(observation)).setup`（存下来的 preset → mount）。
// 本组把这三样逐个钉住，外加两档降级与一条 fail-closed。

const REVIVE_STORED_PRESET = "coder";
/** DEFECT-5 的端到端读数，按**会话 id** 配对（不按位置）：复活那次 resume 调用交给了宿主
 * 哪几个键、`agentOptions` 是哪一对、preset 挂的是不是**这个会话自己存下来的**那一个、
 * 模型选择钩子挂在谁的 setup 上下文上。 */
function resumeCompositionOf(env) {
	return env.resumeCalls.map((options) => {
		const id = options.resumeSessionId;
		const agent = env.resumedAgents.find((item) => item.id === id);
		const mounted = env.agentPresets.mounts.filter((entry) => entry.agentId === id);
		return {
			id,
			keys: Object.keys(options).sort().join(","),
			provider: options.agentOptions?.provider,
			model: options.agentOptions?.model,
			hook: typeof agent?.setupCalls?.["agent/request"],
			setupAgentId: agent?.setupCtx?.agentId,
			mounts: mounted.length,
			mountedId: mounted[0]?.id ?? null,
		};
	});
}
const defect5Team = (history) => reviveTeam([{ role: "coordinator", current: REVIVE_PLUGIN_ID, pending: null, history }]);
const defect5History = [{ session: REVIVE_PLUGIN_ID, from: 1_700_000_000_000, until: null }];
const defect5Revive = (env) => env.tool("team_link_recover").execute({ action: "revive", team: "night-shift", role: "coordinator" }, execFor(env.agentFor("session-target")));

const defect5Env = rotateEnv({ askScript: ["执行恢复"], teams: defect5Team(defect5History) });
defect5Env.setHiddenAgent(REVIVE_PLUGIN_ID, true);
declareDormantSession(defect5Env, REVIVE_PLUGIN_ID, { agentPreset: REVIVE_STORED_PRESET });
const defect5Out = await defect5Revive(defect5Env);
const defect5Rows = resumeCompositionOf(defect5Env);
check("DEFECT-5 ① revive 的 resume 面 = 宿主自己那三样（`resumeSessionId` + `agentOptions` + `setup`）：缺了 `agentOptions`，复活出来的 agent 就没有 `{{model}}` 的值 ⇒ 首回合必死在 persona-prefix（真机 12:50:54 那四条日志）", defect5Out.includes("已恢复（revive）") && defect5Rows.length === 1 && defect5Rows[0].id === REVIVE_PLUGIN_ID && defect5Rows[0].keys === "agentOptions,resumeSessionId,setup" && defect5Rows[0].provider === STUB_DEFAULT_PROVIDER && defect5Rows[0].model === STUB_DEFAULT_MODEL && defect5Env.agentDefaultModel.calls.length === 1);
check("DEFECT-5 ② preset 组装源：复活的 agent 拿到的是**它自己存下来的** `header.agentPreset`（不是宿主缺省）——mount 恰一次，且挂在**这个会话自己**的 setup 上下文上（工具面与人设都在这支组成里）", defect5Rows.length === 1 && defect5Rows[0].mounts === 1 && defect5Rows[0].mountedId === REVIVE_STORED_PRESET && defect5Rows[0].setupAgentId === REVIVE_PLUGIN_ID && defect5Env.agentPresets.resolved[0] === REVIVE_STORED_PRESET);
const defect5Hook = await probeModelHook(defect5Env.resumedAgents[0], { provider: STUB_DEFAULT_PROVIDER, model: STUB_DEFAULT_MODEL, reasoningEffort: "high" });
check("DEFECT-5 ③ 判据是「能用」不是「装了」：模型选择钩子挂在复活这具 agent 自己的 setup 上，且带的就是缺省那一对（同名路由 ⇒ 抹掉继承来的 reasoningEffort）", defect5Rows.length === 1 && defect5Rows[0].hook === "function" && defect5Hook.installed === true && defect5Hook.out.provider === STUB_DEFAULT_PROVIDER && defect5Hook.out.model === STUB_DEFAULT_MODEL && defect5Hook.out.reasoningEffort === undefined);

// 缺省回落：老会话 / 手工会话的 header 里没有 `agentPreset` ⇒ 按宿主缺省解析（同一句
// 「缺省也解析」的口径），**不是**「读不到就干脆不挂」——那正是 DEFECT-1 的形状。
const defect5DefaultEnv = rotateEnv({ askScript: ["执行恢复"], teams: defect5Team(defect5History) });
defect5DefaultEnv.setHiddenAgent(REVIVE_PLUGIN_ID, true);
declareDormantSession(defect5DefaultEnv, REVIVE_PLUGIN_ID);
const defect5DefaultOut = await defect5Revive(defect5DefaultEnv);
const defect5DefaultRows = resumeCompositionOf(defect5DefaultEnv);
check("DEFECT-5 ④ header 里没有 preset ⇒ 缺省也解析（resolve(undefined) → mount 缺省那一个），复活照常成功", defect5DefaultOut.includes("已恢复（revive）") && defect5DefaultRows.length === 1 && defect5DefaultRows[0].mounts === 1 && defect5DefaultRows[0].mountedId === STUB_DEFAULT_PRESET && defect5DefaultEnv.agentPresets.resolved[0] === undefined);

// 降级（不是 fail-closed）：`agentPresets` 是可服务，缺席只留一行具名 warn —— 与 create 面同口径。
const defect5NoPresetEnv = rotateEnv({ askScript: ["执行恢复"], omitAgentPresets: true, teams: defect5Team(defect5History) });
defect5NoPresetEnv.setHiddenAgent(REVIVE_PLUGIN_ID, true);
declareDormantSession(defect5NoPresetEnv, REVIVE_PLUGIN_ID);
const defect5NoPresetOut = await defect5Revive(defect5NoPresetEnv);
const defect5NoPresetRows = resumeCompositionOf(defect5NoPresetEnv);
check("DEFECT-5 ⑤ preset 服务缺席 ⇒ 降级但绝不静默：复活照常成功（`agentOptions` 照样带着缺省那一对），零 mount，恰留一行 warn 点名这个会话没有 persona-prefix 组装源", defect5NoPresetOut.includes("已恢复（revive）") && defect5NoPresetRows.length === 1 && defect5NoPresetRows[0].provider === STUB_DEFAULT_PROVIDER && defect5NoPresetRows[0].model === STUB_DEFAULT_MODEL && defect5NoPresetEnv.agentPresets.mounts.length === 0 && defect5NoPresetEnv.log.lines.warn.filter((line) => line.includes("agentPresets service unavailable") && line.includes(REVIVE_PLUGIN_ID)).length === 1);
// 同一形状断层在**两个面上必须同一句判词**（代码评审第 2 轮）：创建面拒绝 ⇒ 复活面也拒绝 ——
// 降级只留给「服务整个缺席」那一档。理由与创建面同源：没有组装源的代理正是 DEFECT-1
// 「会建 ≠ 能用」的形状，而复活面存在的意义就是「只把能跑起来的会话救回来」。
const defect5HalfPresetEnv = rotateEnv({ askScript: ["执行恢复"], agentPresetsOptions: { omitMount: true }, teams: defect5Team(defect5History) });
defect5HalfPresetEnv.setHiddenAgent(REVIVE_PLUGIN_ID, true);
declareDormantSession(defect5HalfPresetEnv, REVIVE_PLUGIN_ID);
const defect5HalfPresetOut = await defect5Revive(defect5HalfPresetEnv);
check("DEFECT-5 ⑤b 服务在场但组成面只有一半（缺 `mount`）⇒ 与创建面同一句判词：**显式拒绝**（零 resume 调用、零写入、零 warn 降级），不是「照常复活、只是没组装源」", defect5HalfPresetOut.includes("恢复失败（revive，fail-closed）") && defect5HalfPresetOut.includes("组成面形状断层") && defect5HalfPresetOut.includes("mount=undefined") && defect5HalfPresetEnv.resumeCalls.length === 0 && (defect5HalfPresetEnv.role().recoveries ?? []).length === 0 && defect5HalfPresetEnv.log.lines.warn.filter((line) => line.includes("agentPresets service unavailable")).length === 0);

// fail-closed：没有可解析的缺省模型 ⇒ 拒绝恢复（与 create 面同一条口径「宁可不建/不复活一个
// 跑不起来的代理」）——**零 resume、零写入、零留痕**，报告点名原因与出路。
const defect5NoModelEnv = rotateEnv({ askScript: ["执行恢复"], omitAgentDefaultModel: true, teams: defect5Team(defect5History) });
defect5NoModelEnv.setHiddenAgent(REVIVE_PLUGIN_ID, true);
declareDormantSession(defect5NoModelEnv, REVIVE_PLUGIN_ID);
const defect5NoModelOut = await defect5Revive(defect5NoModelEnv);
check("DEFECT-5 ⑥ 模型选择解析不出来 ⇒ 拒绝恢复（fail-closed）：零 resume、零写入、零留痕，报告点名 `agentDefaultModel`、后果（`{{model}}` 无值 ⇒ 首回合死在 persona-prefix）与出路", defect5NoModelOut.includes("恢复失败（revive，fail-closed）") && defect5NoModelOut.includes("agentDefaultModel") && defect5NoModelOut.includes("{{model}}") && defect5NoModelEnv.resumeCalls.length === 0 && (defect5NoModelEnv.role().recoveries ?? []).length === 0 && !defect5NoModelEnv.role().rotationAt && defect5NoModelEnv.ns.data.teams[0].policy.writer === "coordinator");

// 存量 preset 解析不出来 ⇒ 显式失败（**不**静默换成另一个组成源）：一个跑着**别的**工具面、
// 却顶着这个名字的会话比一次可读的失败更难查——与 create 面「preset= 指了个解析不出来的 id
// ⇒ 拒绝创建、不静默降级」同口径。
const defect5GoneEnv = rotateEnv({ askScript: ["执行恢复"], teams: defect5Team(defect5History) });
defect5GoneEnv.setHiddenAgent(REVIVE_PLUGIN_ID, true);
declareDormantSession(defect5GoneEnv, REVIVE_PLUGIN_ID, { agentPreset: "gone-preset" });
const defect5GoneOut = await defect5Revive(defect5GoneEnv);
check("DEFECT-5 ⑦ 存量 preset 解析不出来 ⇒ 显式失败且点名那个 preset（不静默降级成宿主缺省那支组成），零留痕、且**失败后不留下一枚活代理**（真工厂是 setup 抛错即回滚发布；夹具同批对齐）", defect5GoneOut.includes("恢复失败（revive，fail-closed）") && defect5GoneOut.includes("gone-preset") && (defect5GoneEnv.role().recoveries ?? []).length === 0 && defect5GoneEnv.agentPresets.mounts.length === 0 && defect5GoneEnv.agentFor(REVIVE_PLUGIN_ID) === undefined && __testing.agentIsLive(defect5GoneEnv.ctx, REVIVE_PLUGIN_ID) === false);
// ⑥ 与 ⑦ 的差别要如实标出来（代码评审 🟡#2）：⑥ 档失败在**调用之前**（零 resume 调用），
// ⑦ 档的失败发生在 `setup` 里 ⇒ resume **已被调用**、在组装阶段回滚。两档都零复活零写入，
// 但不是同一种「零 resume」。
check("DEFECT-5 ⑦ 口径: 存量 preset 的解析发生在 setup 里 ⇒ resume 调用已在飞（`resumeCalls.length === 1`）但**没有**代理被发布；与 ⑥ 的「零 resume 调用」不是同一档（文档同批按此改写）", defect5GoneEnv.resumeCalls.length === 1 && defect5GoneEnv.resumeCalls[0].resumeSessionId === REVIVE_PLUGIN_ID && defect5NoModelEnv.resumeCalls.length === 0 && defect5GoneEnv.resumedAgents.length === 0);

// ---------------------------------------------------------------------------
// §11.9.4 L2 reappoint（U27/U29）：候选由插件算 · 人类在环 · 逐字复用 prepare/claim
// ---------------------------------------------------------------------------
//
// 这一组盯的是「reappoint = 人类对话授权的 prepare」这句话的每一半：候选由宿主从
// **活成员**算出（调用方给不出继任者 id），人类必须在对话框里勾选，随后逐字走既有
// M4（令牌绑定三元组 + rotationBackup + freeze 广播），claim 一步不改。

const REAP_ROOT = path.join(TEAM_TMP, "reap-ws");
const reapTeam = (roles) => [{ name: "night-shift", createdAt: 1_700_000_000_000, workspace: REAP_ROOT, policy: { writer: "coordinator" }, roles, rotationBackup: null }];
const REAP_DEAD = "team-link-night-shift-coordinator-deadbeef";
/** One seeded role row in the SHAPE the store round-trips (every canonical field
 * present, `recoveries` included): a hand-written partial row would leave fields
 * `undefined` and every "nothing was written" assertion would then be testing
 * `undefined` instead of the intended `null`/`0`. */
const seededRole = (role, current, extra = {}) => ({
	role,
	current,
	pending: null,
	rotationAt: 0,
	provisional: null,
	rotationStatus: "",
	history: current === null ? [] : [{ session: current, from: 1_700_000_000_000, until: null }],
	recoveries: [],
	...extra,
});
const reapRoles = () => [
	reviveCallerRole(),
	seededRole("coordinator", REAP_DEAD),
	seededRole("worker-a", "session-worker-a"),
	seededRole("worker-b", "session-worker-b"),
];

/** `REAP_DEAD` is REGISTERED as a stub agent in every reappoint fixture and then
 * hidden: "hidden" models a registry entry that is no longer resolvable (A4 — a
 * closed session), which is the fixture the TOCTOU races have to flip mid-dialog.
 * Without the registration, hiding would be a no-op and so would unhiding. */
const reapAgents = () => [{ id: REAP_DEAD, status: "idle" }, { id: "session-worker-a", status: "idle" }, { id: "session-worker-b", status: "idle" }, { id: SUCCESSOR, status: "idle" }];

const reapEnv = rotateEnv({
	askScript: [["session-worker-b"]],
	pairs: [{ a: REAP_DEAD, b: "session-worker-a", createdAt: 1 }, { a: REAP_DEAD, b: "session-worker-b", createdAt: 2 }, { a: REAP_DEAD, b: ROT_OUTSIDE, createdAt: 3 }, { a: "session-worker-a", b: "session-worker-b", createdAt: 4 }],
	trustedSenders: [REAP_DEAD],
	rememberTargets: [REAP_DEAD],
	teams: reapTeam(reapRoles()),
	extraAgents: reapAgents(),
});
reapEnv.setHiddenAgent(REAP_DEAD, true);
const reapTool = reapEnv.tool("team_link_recover");
// ★ FR-10（批 5）: attach 后置链现在会按队补挂 auto 工作台注册 ⇒ 命名空间在**恢复动作之前**就已经
// 多了 `watchdogs` 这一项。U29 的红线管的是**恢复路径**，所以判据是**快照对比**：恢复前后顶层键集
// 与 `watchdogs` 内容逐字不变（恢复一个字都不许加/删），而 attach 那一笔不参与判定。
// 绝对键集仍由紧随其后的那条「base = 九项」钉住 —— 两条各管一件事，互不替对方背书。
// 快照必须取在**后置链落定之后**：FR-10 的补挂是 fire-and-forget 的一次微任务，若在它落笔前取
// 快照，「恢复期间」这个窗口就会把 attach 的那一笔也算进去（那是假红，不是恢复路径写的）。
await waitForChain(reapEnv, 1);
await tick();
const reapKeysBefore = JSON.stringify(Object.keys(reapEnv.ns.data).sort());
const reapWatchdogsBefore = JSON.stringify(reapEnv.ns.data.watchdogs ?? null);
const reapOut = await reapTool.execute({ action: "reappoint", team: "night-shift", role: "coordinator" }, execFor(reapEnv.agentFor("session-worker-a")));

check("U27 候选由插件算（批次 2 改写：候选集 = 活成员 ∪ 常驻合成候选）: 选项 = 本队**活成员**（排除死现任那个角色自己）+ 恒定在末尾的「自建继任者（新建会话）」，调用方没有任何参数能指定继任者 id；且是**单选**——`multiSelect` 曾经为 true 而调用方只取 `picked[0]`，人类勾的第二位会被静默丢弃（差异审计 B3：盒子不许承诺代码不会做的选择）", (() => {
	const ask = reapEnv.uq.requests[0];
	return ask !== undefined
		&& ask.questions.length === 1
		&& ask.questions[0].id === "recovery-confirm"
		&& ask.questions[0].multiSelect === undefined
		&& ask.questions[0].options.map((option) => option.label).join(",") === `session-target,session-worker-a,session-worker-b,${__testing.SELF_SUCCESSOR_LABEL}`
		&& ask.questions[0].question.includes("本队活成员 ∪ 插件自建继任者（常驻）")
		&& ask.questions[0].question.includes(__testing.SELF_SUCCESSOR_LABEL)
		&& !Object.keys(reapTool.parameters.properties).some((key) => /successor|target|session/iu.test(key));
})());
check("U27 人类在环: 确认框写清爆炸半径（谁在任、谁是发起者、接下来铸令牌+快照+广播冻结、信任迁移不在本次）与边界声明", (() => {
	const ask = reapEnv.uq.requests[0];
	const text = `${ask.questions[0].question}\n${ask.questions[0].detail}`;
	return text.includes(REAP_DEAD) && text.includes("session-worker-a") && text.includes("seated-dead") && text.includes("rotationBackup") && text.includes("rotation-freeze") && text.includes("信任迁移不在本次") && text.includes("attended-only") && text.includes("绝不把 policy.writer 降级为 any");
})());

check("U27 逐字复用 prepare: 令牌绑定 (team, role, successor) 三元组、30 分钟 TTL、rotationBackup 快照落下、freeze 广播到其余成员——一步未跳", (() => {
	const pending = reapEnv.role().pending;
	const backup = reapEnv.team().rotationBackup;
	return pending !== null && pending.session === "session-worker-b" && pending.team === "night-shift" && pending.role === "coordinator" && pending.expiresAt - pending.createdAt === 30 * 60000
		&& backup !== null && backup.pairs.length === 4 && backup.trustedSenders.length === 1 && backup.rememberTargets.length === 1
		&& reapEnv.calls("session-worker-b").followedup.some((message) => message.content[0].text.includes("[rotation-freeze]"))
		&& reapOut.includes("换届包已就绪");
})());
check("U27 不新增令牌类型: 铸出来的就是 M4 的 pending（同一字段、同一令牌形状、同一 TTL 语义），且明文令牌与 M4 同款纪律——明文只在这一次返回里出现一次，此后一律掩码", (() => {
	const token = reapEnv.role().pending?.token ?? "（无）";
	const reveal = `令牌（一次性，30 分钟内有效）：${token}`;
	return reapOut.includes(reveal) && /^[0-9a-f-]{36}$/u.test(token)
		&& reapOut.split(reveal).length - 1 === 1
		&& reapOut.includes(`掩码形式 tok-${token.slice(0, 4)}…${token.slice(-4)}`);
})());
check("U27 留痕: reappoint 也落三处——版本史备注 recovery(reappoint,...) + rotationAt 限速戳、roster.md 镜像、decisions.md 追加（继任者具名）", (() => {
	const entry = reapEnv.role();
	return (entry.recoveries ?? []).length === 1 && at(entry.recoveries, 0, {}).verb === "reappoint" && at(entry.recoveries, 0, {}).from === REAP_DEAD && at(entry.recoveries, 0, {}).to === "session-worker-b" && at(entry.recoveries, 0, {}).by === "session-worker-a" && String(at(entry.recoveries, 0, {}).note).includes("recovery(reappoint, vacant-due-to-death,") && entry.rotationAt === at(entry.recoveries, 0, {}).at;
})());
const reapMirror = await readOrMissing(path.join(REAP_ROOT, "team", "night-shift", "roster.md"));
const reapDecisions = await readOrMissing(path.join(REAP_ROOT, "team", "night-shift", "decisions.md"));
check("U27 留痕②③: 镜像含恢复行（且不含活性词）；decisions.md 追加了带队名/角色/继任者的审计行", reapMirror.includes("恢复记录（team_link_recover，共 1 条）") && reapMirror.includes("reappoint") && reapMirror.includes("session-worker-b") && !reapMirror.includes("seated-dead") && reapDecisions.includes("recovery reappoint team=night-shift role=coordinator") && reapDecisions.includes("to=session-worker-b"));
check("U27 ⑥红线: 恢复没有把 writer 降级（policy.writer 仍是 coordinator），也没有改任何 policy 字段", reapEnv.ns.data.teams[0].policy.writer === "coordinator" && reapOut.includes("policy.writer 未动（仍是 coordinator）"));

// The candidate answer is a set of LABELS the dialog returned; the picked session
// is then re-checked against the live candidate set (and against liveness) before
// anything is minted.
const reapOutsideEnv = rotateEnv({ askScript: [["session-not-a-member"]], teams: reapTeam(reapRoles()) });
reapOutsideEnv.setHiddenAgent(REAP_DEAD, true);
const reapOutside = await reapOutsideEnv.tool("team_link_recover").execute({ action: "reappoint", team: "night-shift", role: "coordinator" }, execFor(reapOutsideEnv.agentFor("session-worker-a")));
check("U27 ③候选封闭: 对话框返回了一个不在候选集里的 label → 拒绝为「没有勾选任何候选人」，零令牌、零 freeze、零写入", reapOutside.includes("没有勾选任何候选人") && reapOutsideEnv.role().pending === null && reapOutsideEnv.team().rotationBackup === null && (reapOutsideEnv.role().recoveries ?? []).length === 0 && reapOutsideEnv.calls("session-worker-a").followedup.length === 0);

const reapNoConfirmEnv = rotateEnv({ omitUserQuestions: true, teams: reapTeam(reapRoles()) });
reapNoConfirmEnv.setHiddenAgent(REAP_DEAD, true);
const reapNoConfirm = await reapNoConfirmEnv.tool("team_link_recover").execute({ action: "reappoint", team: "night-shift", role: "coordinator" }, execFor(reapNoConfirmEnv.agentFor("session-worker-a")));
check("U27 ②fail-closed: 无确认服务 → 拒绝且**不写任何状态**（零令牌、零 rotationBackup、零 freeze、零恢复记录、连限速戳都不落）", reapNoConfirm.includes("确认服务（userQuestions）不可用") && reapNoConfirm.includes("fail-closed") && reapNoConfirmEnv.role().pending === null && reapNoConfirmEnv.team().rotationBackup === null && (reapNoConfirmEnv.role().recoveries ?? []).length === 0 && reapNoConfirmEnv.calls("session-worker-a").followedup.length === 0 && !reapNoConfirmEnv.role().rotationAt);

const reapCancelEnv = rotateEnv({ askScript: [[]], teams: reapTeam(reapRoles()) });
reapCancelEnv.setHiddenAgent(REAP_DEAD, true);
const reapCancel = await reapCancelEnv.tool("team_link_recover").execute({ action: "reappoint", team: "night-shift", role: "coordinator" }, execFor(reapCancelEnv.agentFor("session-worker-a")));
check("U27 取消: 什么都不勾 → 零令牌、零 freeze、零写入（取消就是什么都不做）", reapCancel.includes("未改任（reappoint）") && reapCancelEnv.role().pending === null && reapCancelEnv.team().rotationBackup === null && (reapCancelEnv.role().recoveries ?? []).length === 0);

// TOCTOU: the dialog spans an unbounded human wait, so the incumbent's liveness is
// re-read when the box CLOSES (and again before the pen). `makeUserQuestions`' ask
// script may hold a FUNCTION, which runs while the dialog is still pending — that
// is the exact instant the race has to be reproduced at.
const reapRevivedEnv = rotateEnv({ askScript: [], teams: reapTeam(reapRoles()), extraAgents: reapAgents() });
reapRevivedEnv.setHiddenAgent(REAP_DEAD, true);
reapRevivedEnv.setScript(() => {
	// The human reopened the dead incumbent while the box was open.
	reapRevivedEnv.setHiddenAgent(REAP_DEAD, false);
	return ["session-worker-a"];
});
const reapRevived = await reapRevivedEnv.tool("team_link_recover").execute({ action: "reappoint", team: "night-shift", role: "coordinator" }, execFor(reapRevivedEnv.agentFor("session-worker-a")));
check("U27 TOCTOU（对话框弹出时 → 落笔前复检）: 现任在确认期间复活 → 中止（条件由宿主重读，不由对话框里那次观察主张），零令牌、零 freeze、零写入", reapRevived.includes("现任已复活，无需恢复") && reapRevived.includes("写前复检") && reapRevivedEnv.role().pending === null && !reapRevivedEnv.team().rotationBackup && (reapRevivedEnv.role().recoveries ?? []).length === 0 && reapRevivedEnv.calls("session-worker-a").followedup.length === 0);

// --- Y3（③b 差异审计）: 身份复检必须**自己是**一条会红的锁 -----------------------
//
// 审计实测：把 `reapIncumbent` 里那条**身份**复检（现任 id 变了没有）整个删掉，
// 820 条断言**全绿** —— 因为同一句「现任已复活，无需恢复」由**幸存的活性**复检
// 路径产出，而那条断言只 grep 文案。「同源化把锁变成空锁」这是第七次出现。
//
// 判据必须把它和活性复检**分开**，且要顺着「活着的最严复检先响」这条实现事实：
// ① 现任 id 变了但**新现任是死的** ⇒ 活性复检不可能响（`isLive(新现任) === false`），
//    所以只有身份复检能拒绝——把身份复检删掉，这次调用会一路铸出令牌；
// ② 现任 id **没变**且活着 ⇒ 活性复检响，且它必须**只**说活性（不能复用身份那句话），
//    否则两条路径又变成同源产物。两条合起来 = 身份复检被删必须红。
const reapRaceLiveEnv = rotateEnv({ askScript: [], teams: reapTeam(reapRoles()), extraAgents: reapAgents().concat([{ id: "session-replacement-dead", status: "idle" }]) });
reapRaceLiveEnv.setHiddenAgent(REAP_DEAD, true);
reapRaceLiveEnv.setHiddenAgent("session-replacement-dead", true);
reapRaceLiveEnv.setScript(() => {
	// 人在这段时间里把该角色改任给了另一个**没有活动代理**的会话。（注意 `reapTeam`
	// 的第一行是发起者自己的 `auditor` 席位——要改的是 `role("coordinator")` 那一行。）
	reapRaceLiveEnv.role("coordinator").current = "session-replacement-dead";
	return ["session-target"];
});
const reapRaceLive = await reapRaceLiveEnv.tool("team_link_recover").execute({ action: "reappoint", team: "night-shift", role: "coordinator" }, execFor(reapRaceLiveEnv.agentFor("session-worker-a")));
check("Y3 身份复检（行为锁）: 现任在确认期间被改任成**另一个死了的**会话 → 只能由**身份**复检拒绝（活性复检对新现任为假，响不了）；删掉身份复检这条立即红——它会一路铸出令牌", reapRaceLive.includes("（reappoint，写前复检）") && reapRaceLive.includes("该角色的现任已不是 team-link-night-shift-coordinator-deadbeef") && reapRaceLive.includes("现在是 session-replacement-dead") && reapRaceLive.includes("本次的身份主张已过期") && !reapRaceLive.includes("现任已复活，无需恢复") && reapRaceLiveEnv.role().pending === null && !reapRaceLiveEnv.team().rotationBackup && (reapRaceLiveEnv.role().recoveries ?? []).length === 0);

// 对照组（Y7「干净红」纪律：这条与身份复检**不是**同一个判据，别把它当重复删掉）:
// 现任 id **没变**、只是复活了 → 由**活性**复检拒绝并说「现任已复活，无需恢复」，
// 且它的话**不是**身份复检那一句。把身份复检的话抄过来，这条红。
const reapRaceLive2Env = rotateEnv({ askScript: [], teams: reapTeam(reapRoles()), extraAgents: reapAgents() });
reapRaceLive2Env.setHiddenAgent(REAP_DEAD, true);
reapRaceLive2Env.setScript(() => {
	// 反例（对照组）：现任 **id 没变**，只是有人把它重新打开了。
	reapRaceLive2Env.setHiddenAgent(REAP_DEAD, false);
	return ["session-target"];
});
const reapRaceLive2 = await reapRaceLive2Env.tool("team_link_recover").execute({ action: "reappoint", team: "night-shift", role: "coordinator" }, execFor(reapRaceLive2Env.agentFor("session-worker-a")));
check("Y7 干净红对照: 现任 id 没变、只是复活了 → 由**活性**复检拒绝并说「现任已复活，无需恢复」（与身份复检那句**不是同一句**；把身份复检的话抄过来，这条红）", reapRaceLive2.includes("现任已复活，无需恢复") && reapRaceLive2.includes("已经有活动代理了") && !reapRaceLive2.includes("本次的身份主张已过期") && reapRaceLive2Env.role().pending === null);

// --- Y4（③b 差异审计）: 红线⑧「进入即先跑既有过期清扫」必须被真断言咬住 ----------
//
// 审计实测：把入口 `rotation.sweep(...)` 换成 `{ lines: [] }` → 820 **全绿**，而 README
// 声称八条硬约束「每条都落成会红的断言」。这条把⑧落成**行为**：一个过期的 pending
// 必须在恢复**自己的**前置检查之前被清扫掉——sweep 被短路，那次清扫就不会发生，
// 过期令牌会留在 store 里，而且恢复会被前置检查以「已有在飞的换届令牌」**误拒**
// （对过期令牌说「让它被认领」是错的，这也正是⑧存在的理由）。
// The seed is `reapRoles()` with ONE row replaced: the coordinator, carrying a token
// that expired long ago. `reapRoles()` is [auditor, coordinator, worker-a, worker-b]
// — the auditor row (the caller's own seat, and the one §11.9.5's initiator domain
// reads) must survive the splice, so the replacement covers indices 1..1 rather than
// `slice(1)`, which would have dropped it as well.
const sweepRoles = reapRoles().map((row, index) => (index === 1
	? seededRole("coordinator", REAP_DEAD, { pending: { session: SUCCESSOR, token: "tok-expired", team: "night-shift", role: "coordinator", expiresAt: 1, createdAt: 1 - 30 * 60000, migratedPairs: [] } })
	: row));
const reapSweepEnv = rotateEnv({
	askScript: [["session-target"]],
	teams: reapTeam(sweepRoles),
	extraAgents: reapAgents(),
});
reapSweepEnv.setHiddenAgent(REAP_DEAD, true);
const reapSweepOut = await reapSweepEnv.tool("team_link_recover").execute({ action: "reappoint", team: "night-shift", role: "coordinator" }, execFor(reapSweepEnv.agentFor("session-worker-a")));
check("Y4 红线⑧（行为锁）: 过期的 pending 在**恢复自己**的前置检查之前就被入口 sweep 清掉——恢复**没有**被那句「已有在飞的换届令牌」误拒，而且答案里带着清扫自己的取消行（过期令牌的清除是**这一趟**真发生的）；把入口 `rotation.sweep(...)` 换成 `{lines: []}`，本条立即红（没有取消行，且前置检查会对过期令牌说不）", reapSweepOut.includes("恢复入口先跑既有过期清扫（§11.9.5⑧）：") && /- 令牌过期取消：团队 night-shift 的角色 coordinator/u.test(reapSweepOut) && reapSweepOut.includes("换届包已就绪") && !reapSweepOut.includes("已有在飞的换届令牌") && reapSweepEnv.role("coordinator").pending !== null && reapSweepEnv.role("coordinator").pending.token !== "tok-expired" && reapSweepEnv.role("coordinator").rotationAt > 0 && (reapSweepEnv.role("coordinator").recoveries ?? []).length === 1);

const reapDeadCandidateEnv = rotateEnv({ askScript: [], teams: reapTeam(reapRoles()), extraAgents: reapAgents() });
reapDeadCandidateEnv.setHiddenAgent(REAP_DEAD, true);
reapDeadCandidateEnv.setScript(() => {
	// The candidate died while the box was open.
	reapDeadCandidateEnv.setHiddenAgent("session-worker-a", true);
	return ["session-worker-a"];
});
const reapDeadCandidate = await reapDeadCandidateEnv.tool("team_link_recover").execute({ action: "reappoint", team: "night-shift", role: "coordinator" }, execFor(reapDeadCandidateEnv.agentFor("session-worker-b")));
check("U27 TOCTOU（候选侧）: 候选在确认期间死亡 → 中止（否则写入它会原地再造一个死结），零令牌、零 freeze、零写入", reapDeadCandidate.includes("已经没有活动代理了") && reapDeadCandidate.includes("原地再造一个死结") && reapDeadCandidateEnv.role().pending === null && (reapDeadCandidateEnv.role().recoveries ?? []).length === 0);

const reapAllDeadEnv = rotateEnv({
	askScript: [["session-worker-a"]],
	teams: reapTeam([
		// The caller's qualification is the OTHER half of §11.9.5's initiator domain:
		// it is this role's **最近一任前任**, so the domain admits it. It has to be
		// exactly that here, and it cannot be a live member: every live member would
		// be a candidate, and "候选集为空" is the question this case asks. (A dead
		// caller is not an option either — a hidden agent resolves to `undefined`, so
		// it has no session identity at all and is refused by the domain first.)
		seededRole("coordinator", REAP_DEAD, { history: [{ session: "session-transient", from: 1, until: 1_700_000_000_000 }, { session: REAP_DEAD, from: 1_700_000_000_000, until: null }] }),
		seededRole("worker-a", "session-worker-a"),
		seededRole("worker-b", "session-worker-b"),
	]),
	extraAgents: [{ id: "session-transient", status: "idle" }],
});
// Every seat in the roster loses its agent — the shape of "插件重载 = 全队 teardown".
// The caller itself is live but is NOT a roster incumbent any more (it handed this
// role over), which is what keeps the candidate set empty while the domain still
// admits the call.
for (const id of [REAP_DEAD, "session-worker-a", "session-worker-b", "session-target"]) reapAllDeadEnv.setHiddenAgent(id, true);
const reapAllDead = await reapAllDeadEnv.tool("team_link_recover").execute({ action: "reappoint", team: "night-shift", role: "coordinator" }, execFor(reapAllDeadEnv.agentFor("session-transient")));
// 批次 2 §4.2 (c) 的语义变更（旧断言在这里被推翻）：这条曾经钉「候选集为空 ⇒ 一条
// 死路 + 三条人工指引」。事故当场的候选长度是 **1 不是 0**（唯一活人是协调者自己），
// 而设计要点恰是「候选用尽时必须有出口」——合成候选**常驻**，所以这条 box 现在真的
// 弹出来了，唯一的候选就是「自建继任者」；脚本给的是已经不存在的旧 label ⇒ 按「没有
// 勾选任何候选人」拒绝，本次调用自身零写入（B2 的口径）。
check("U27 全队皆死（重载团灭，批次 2 改写）: 全队没有活成员时不再是一条死路——对话框照常弹出，且**唯一**候选就是常驻的「自建继任者」；脚本给的旧 label 匹配不上 ⇒ 拒绝为未勾选，零令牌、零 freeze、零写入", reapAllDead.includes("没有勾选任何候选人") && reapAllDeadEnv.uq.requests.length === 1 && reapAllDeadEnv.uq.requests[0].questions[0].options.map((option) => option.label).join(",") === __testing.SELF_SUCCESSOR_LABEL && reapAllDeadEnv.role().pending === null && reapAllDeadEnv.team().rotationBackup === null && (reapAllDeadEnv.role().recoveries ?? []).length === 0);

// §11.9.1's F7: `writer=any` has no deadlock, so recovery points at the EXISTING
// path instead of becoming a second, looser roster editor.
const reapAnyEnv = rotateEnv({ askScript: [["session-worker-a"]], teams: [{ name: "night-shift", createdAt: 1_700_000_000_000, workspace: REAP_ROOT, policy: { writer: "any" }, roles: reapRoles() }] });
reapAnyEnv.setHiddenAgent(REAP_DEAD, true);
const reapAny = await reapAnyEnv.tool("team_link_recover").execute({ action: "reappoint", team: "night-shift", role: "coordinator" }, execFor(reapAnyEnv.agentFor("session-worker-a")));
check("U27 窄域对照: verify recovery never silently becomes set-role; the tool still walks its own two verbs with the human box", reapAny.includes("已按 §11.9.4 L2 铸好换届包") && reapAnyEnv.role().pending !== null && reapAnyEnv.ns.data.teams[0].policy.writer === "any");

// A pending token already in flight blocks recovery (it must be claimed or swept
// first), and the entry sweep runs before anything is read (§11.9.5⑧).
const reapPendEnv = rotateEnv({ askScript: [["session-worker-a"]], teams: reapTeam([{ role: "coordinator", current: REAP_DEAD, pending: { session: SUCCESSOR, token: "tok", team: "night-shift", role: "coordinator", expiresAt: Date.now() + 600000, createdAt: Date.now(), migratedPairs: [] }, history: [] }, ...reapRoles().slice(1)]) });
reapPendEnv.setHiddenAgent(REAP_DEAD, true);
const reapPend = await reapPendEnv.tool("team_link_recover").execute({ action: "reappoint", team: "night-shift", role: "coordinator" }, execFor(reapPendEnv.agentFor("session-worker-a")));
check("U27 不插队: 有未过期在飞令牌 → 拒绝并告知道期时间，零新令牌、连确认框都不弹", reapPend.includes("已有在飞的换届令牌") && reapPendEnv.role().pending.session === SUCCESSOR && reapPendEnv.uq.requests.length === 0 && reapPendEnv.calls("session-worker-a").followedup.length === 0);

// --- Y1（③b 差异审计）：宣传面 = 实现面，两个动词的域**不同**且各自被钉住 --------
//
// 审计实测：描述与 README 声称「本工具只受理 coordinator」，而 `reappoint` 接受**任意
// 角色**——窄域检查只在 `reviveIncumbent` 里。裁定是**改描述、不改行为**（授权从不源自
// coordinator 身份，唯一来源是对话框里人类那一下点击；「死的是 worker」时 reappoint
// 正是那条人改任路径）。所以这条锁必须**双向**：非 coordinator 角色在 `reappoint` 下
// 真铸出令牌（有人给它加回 coordinator 守卫 → 红），而在 `revive` 下仍被窄域拒
// （有人把窄域整个删掉 → 红）。
const reapWorkerRoles = () => [
	seededRole("coordinator", "session-coordinator-live"),
	seededRole("worker-a", REAP_DEAD),
	seededRole("worker-b", "session-worker-b"),
];
const reapWorkerEnv = rotateEnv({
	askScript: [["session-worker-b"]],
	teams: reapTeam(reapWorkerRoles()),
	extraAgents: [{ id: "session-coordinator-live", status: "idle" }, { id: REAP_DEAD, status: "idle" }, { id: "session-worker-b", status: "idle" }],
});
reapWorkerEnv.setHiddenAgent(REAP_DEAD, true);
const reapWorkerOut = await reapWorkerEnv.tool("team_link_recover").execute({ action: "reappoint", team: "night-shift", role: "worker-a" }, execFor(reapWorkerEnv.agentFor("session-worker-b")));
// The freeze broadcast goes to the team's OTHER live members — the successor is
// excluded by construction (it is the one being handed the role), so the delivery to
// prove is the one that landed on `session-coordinator-live`'s sink.
check("Y1 reappoint 无角色窄域（行为锁）: 死的是 **worker** 时 reappoint 照常完成——真铸出绑定 (team, worker-a, successor) 的三元组令牌、真落 rotationBackup、真广播 freeze（有人给它加回 coordinator 守卫，这条当场红）", reapWorkerOut.includes("已按 §11.9.4 L2 铸好换届包") && reapWorkerEnv.role("worker-a").pending !== null && reapWorkerEnv.role("worker-a").pending.role === "worker-a" && reapWorkerEnv.role("worker-a").pending.session === "session-worker-b" && reapWorkerEnv.team().rotationBackup !== null && reapWorkerOut.includes("换届包已就绪") && reapWorkerEnv.calls("session-coordinator-live").followedup.some((message) => message.content[0].text.includes("[rotation-freeze]")) && reapWorkerEnv.ns.data.teams[0].policy.writer === "coordinator");
const reapWorkerScope = await reapWorkerEnv.tool("team_link_recover").execute({ action: "revive", team: "night-shift", role: "worker-a" }, execFor(reapWorkerEnv.agentFor("session-worker-b")));
// 批次 2 §4.2 (a) 把这条对照**反转**了：旧锁咬的是「同角色走 revive 仍被窄域拒」
// （删除窄域即红），现在窄域本身被设计与 owner 裁定删除，于是锁换成新语义——同一个
// 非 coordinator 角色走 `revive` 不再被**角色**拒绝（它被实质判据拒：worker-a 的现任
// session-worker-b 还活着），而 `reappoint` 的域一字未动。
check("Y1 对照（批次 2 改写）: 同一个非 coordinator 角色走 `revive` 不再被角色门拒绝——它落到实质判据上（这条环境里先是 10 分钟限速窗口：它也是实质判据，不是角色门），零 resume、零新增留痕", !reapWorkerScope.includes("本工具只为 coordinator 角色恢复") && !reapWorkerScope.includes("只为 coordinator") && reapWorkerScope.includes("恢复") && reapWorkerEnv.resumeCalls.length === 0 && (reapWorkerEnv.role("worker-a").recoveries ?? []).length === 1 && at(reapWorkerEnv.role("worker-a").recoveries, 0, {}).verb === "reappoint");
// The README half of the same lock lives in the §11.2/§11.9 文档面 block below —
// `handoffReadme` is not initialized yet at this point, and the TDZ error that used
// to sit here is exactly the kind of unclean red the Y7 sweep exists to prevent.
// §11.9.5①: the whole surface stays two verbs, and the second one does not grow a
// "write any roster field" cousin.
check("U29 红线: 恢复路径不新增日志事件类型——宿主动作仍只有既有的几种（settings 写 + 确认框 + 广播投递 + resume，本轮没有第四种），writerGate 原样，恢复期间 policy 的顶层键集与 watchdogs 内容**逐字不变**", reapEnv.actionLog.every((entry) => entry === "create" || entry === "followup" || entry === "resume") && __testing.writerGate.length === 2
		// ★ FR-10（批 5）: attach 后置链会按队补挂 auto 工作台注册 ⇒ 命名空间在恢复**之前**就已经多了
		// `watchdogs` 这一项。它**不是恢复路径写的**，所以判据取**快照对比**（reapKeysBefore /
		// reapWatchdogsBefore，都在恢复动作之前取）：恢复期间键集一字未动、watchdogs 内容一字未改。
		// 旧写法把「绝对键集」写在恢复路径的判据里 ⇒ FR-10 一挂上就会红（假红），把 attach 的承诺
		// 与恢复路径的红线搅在一起；绝对键集现在只由下一条（base = 九项）钉。
		&& JSON.stringify(Object.keys(reapEnv.ns.data).sort()) === reapKeysBefore
		&& JSON.stringify(reapEnv.ns.data.watchdogs ?? null) === reapWatchdogsBefore);
check("U29 schema: 恢复没有新增任何顶层 policy key（recoveries 是 role 行内字段）——八项一个不多", sameJson(Object.keys(reapEnv.settings.namespaces.get("team-link").base).sort(), ["blockedSenders", "pairs", "pendingCreates", "receiveMode", "rememberTargets", "sections", "teams", "trustedSenders", "watchdogs"]) && reapEnv.role().recoveries !== undefined && reapEnv.ns.data.recoveries === undefined);

// --- 缺口1 的第三半：claim 的超时读数**不得**与 fail-closed 同形 -----------------------
//
// 放在这里是因为对照物就在上面：`reviveNoConfirm` / `reapNoConfirm` 是两条**真正的失败
// 路径**（无确认服务 ⇒ fail-closed）的实证文案。要求是「超时不许与失败同形」，所以判据用
// 那份真文案来做差集，而不是拿一句转述去比。同时钉住那两条**一字未改**。
const timeoutApprovalReading = reportLine(dialogAbortOut, "批准状态：");
const failClosedPhrase = "确认服务（userQuestions）不可用——恢复必须有人在对话框里点一下；无确认即不执行（fail-closed，§11.9.5②）。刻意没有 provisional / 无人值守变体：pair 迁移可被自动回退，身份不可。";
check("缺口1 互不混淆（超时 ≠ fail-closed）: claim 的超时读数与两条 fail-closed 读数（revive / reappoint，均无确认服务）既不相等、也不共享它们的判据语；而那两条 fail-closed 文案本轮**一字未改**，且仍自带「confirm 服务缺席 ⇒ 不执行」的可分性",
	timeoutApprovalReading !== "" && timeoutApprovalReading !== reviveNoConfirm && timeoutApprovalReading !== reapNoConfirm
		&& !timeoutApprovalReading.includes("fail-closed") && !timeoutApprovalReading.includes("刻意没有 provisional") && !timeoutApprovalReading.includes("恢复必须有人在对话框里点一下")
		&& reviveNoConfirm.includes(failClosedPhrase) && reapNoConfirm.includes(failClosedPhrase));

// ---------------------------------------------------------------------------
// §11.2 `/team_rotate <role>`（③a 的人类入口）：命令只做机制，正文由模型起草
// ---------------------------------------------------------------------------

const cmdRotEnv = rotateEnv({ askScript: [] });
const cmdRotDefinition = cmdRotEnv.commands.command("team_rotate");
check("§11.2 命令面: /team_rotate 通过同一个可选 commands seam 注册（描述写明命令只做机制、正文由模型起草、新建会话仍要过确认框）", cmdRotDefinition !== undefined && cmdRotDefinition.description.includes("§11.2") && cmdRotDefinition.description.includes("正文必须由模型起草") && cmdRotDefinition.description.includes("§11.4.1") && cmdRotDefinition.input.hint.includes("<role>") && cmdRotDefinition.recordInput === true);
check("§11.2 命令面: 注册留一行 info（与 /team_session 同一条 seam，各自一行）", cmdRotEnv.log.lines.info.some((line) => line.includes("/team_rotate registered through the optional commands service")));

const cmdRotParsed = __testing.readTeamRotateCommand("coordinator team=night-shift");
// 宣传面 → 实现面：hint 里写到的每一个 `key=` 都必须真的被解析器接受（上一轮的教训
// 是反方向：hint 教了一条端到端不可用的写法）。这条把 hint 变成被断言的对象。
const cmdRotHintKeys = [...cmdRotDefinition.input.hint.matchAll(/([a-z]+)=/gu)].map((match) => match[1]);
const cmdRotHintAcceptable = cmdRotHintKeys.length > 0 && cmdRotHintKeys.every((key) => __testing.readTeamRotateCommand(`coordinator ${key}=x`).error === undefined);
check("§11.2 文法: /team_rotate <role> [team=<name>] 解析成两部分；缺角色名、多角色名、未知 key、带引号的值都被拒绝（拒绝文案只列真正支持的语法），且 hint 里写的每个 key 都真被接受", cmdRotParsed.value.role === "coordinator" && cmdRotParsed.value.team === "night-shift" && cmdRotHintAcceptable && __testing.readTeamRotateCommand("").error.includes("/team_rotate <role>") && __testing.readTeamRotateCommand("a b").error.includes("只接受一个角色名") && __testing.readTeamRotateCommand("coordinator n=2").error.includes("未知参数") && __testing.readTeamRotateCommand("coordinator n=2").error.includes("team=<name>（可选）") && __testing.readTeamRotateCommand('coordinator team="night-shift"').error.includes("不要带引号"));

const cmdRotOut = await cmdRotDefinition.handler(cmdRotEnv.invoke("coordinator", cmdRotEnv.senderAgent));
const cmdRotFollowup = cmdRotEnv.senderCalls.followedup[0];
check("§11.2 命令: 现任执行 → 用 followup 驱动自己的会话（H3 的自身唤醒），并把摘要回报给 UI", cmdRotOut.kind === "success" && cmdRotEnv.senderCalls.followedup.length === 1 && cmdRotOut.text.includes("已把") && cmdRotOut.text.includes("team_rotate"));
check("§11.2 命令: 命令本身零副作用——没有建会话、没有 pending、没有 pairs 改动、没有写黑板（机制全在工具侧）", cmdRotEnv.creates.length === 0 && cmdRotEnv.role().pending === null && (cmdRotEnv.ns.data.pairs ?? []).length === 0 && cmdRotOut.text.includes("确认之前不会创建任何会话、不铸令牌、不广播 freeze"));
check("§11.2 命令: 投出去的指令教的语法就是工具真正接受的那条——五个硬节标题 + successor=\"auto\" + handoff= + 立即确认框；源仍恰三成员", cmdRotFollowup !== undefined && __testing.HANDOFF_HARD_SECTIONS.every((name) => cmdRotFollowup.content[0].text.includes(`## ${name}`)) && cmdRotFollowup.content[0].text.includes('action="prepare"') && cmdRotFollowup.content[0].text.includes('successor="auto"') && cmdRotFollowup.content[0].text.includes("handoff=") && cmdRotFollowup.content[0].text.includes("确认框") && sameJson(Object.keys(cmdRotFollowup.source).sort(), ["form", "kind", "senderSessionId"]) && cmdRotFollowup.source.senderSessionId === "session-self");
check("§11.2/H3 诚实面: 摘要与指令都说清 H3 尚未真机验证，并指向工具入口兜底（不把未验的东西说成已验）", cmdRotOut.text.includes("H3 待验") && cmdRotOut.text.includes("工具入口") && cmdRotFollowup.content[0].text.includes("§11.9.6"));

const cmdRotGuestOut = await cmdRotDefinition.handler(cmdRotEnv.invoke("coordinator", cmdRotEnv.agentFor("session-worker-a")));
check("§11.2 命令: 非现任发起 → 拒绝并点名真正的现任（工具侧的 rotateGate 会再判一次）", cmdRotGuestOut.kind === "error" && cmdRotGuestOut.text.includes("不是该角色的现任") && cmdRotGuestOut.text.includes("现任是 session-self") && cmdRotEnv.senderCalls.followedup.length === 1);

const cmdRotUnknownTeam = await cmdRotDefinition.handler(cmdRotEnv.invoke("coordinator team=no-such"));
const cmdRotEmptyEnv = rotateEnv({ teams: [] });
const cmdRotEmptyRegistry = await cmdRotEmptyEnv.commands.command("team_rotate").handler(cmdRotEmptyEnv.invoke("coordinator"));
check("§11.2 命令: 未知团队 → 拒绝并给出下一步（upsert-team）；空注册表是另一件事（不写成「团队 undefined 不存在」）", cmdRotUnknownTeam.kind === "error" && cmdRotUnknownTeam.text.includes("不在注册表中") && cmdRotUnknownTeam.text.includes("upsert-team") && cmdRotEmptyRegistry.kind === "error" && cmdRotEmptyRegistry.text.includes("还没有注册任何团队") && !cmdRotEmptyRegistry.text.includes("undefined"));

const cmdRotMultiEnv = rotateEnv({ teams: [...handoffTeam(TEAM_WS), { name: "day-shift", createdAt: 1_700_000_000_000, workspace: TEAM_WS, policy: { writer: "coordinator" }, roles: rotRoles() }] });
const cmdRotMultiOut = await cmdRotMultiEnv.commands.command("team_rotate").handler(cmdRotMultiEnv.invoke("coordinator"));
check("§11.2 命令: 同名角色在多个团队都现任 → 拒绝并要求 team=<name>（不猜）", cmdRotMultiOut.kind === "error" && cmdRotMultiOut.text.includes("请用 team=<name>") && cmdRotMultiOut.text.includes("night-shift") && cmdRotMultiOut.text.includes("day-shift"));
const cmdRotPickOut = await cmdRotMultiEnv.commands.command("team_rotate").handler(cmdRotMultiEnv.invoke("coordinator team=day-shift"));
check("§11.2 命令: team=<name> 消歧后正常投递（指令里的团队名就是指定的那一个）", cmdRotPickOut.kind === "success" && cmdRotPickOut.text.includes("团队 day-shift") && cmdRotMultiEnv.senderCalls.followedup.at(-1).content[0].text.includes('team="day-shift"'));

const cmdRotLimitedEnv = rotateEnv({ askScript: [], pairs: [rotPair("session-worker-a")] });
await cmdRotLimitedEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(cmdRotLimitedEnv.senderAgent));
const cmdRotLimitedOut = await cmdRotLimitedEnv.commands.command("team_rotate").handler(cmdRotLimitedEnv.invoke("coordinator"));
check("§11.2 命令: 速率限制窗口内不空转——直接说清原因（复用 rotationRateLimited 的同一句话）且不投递任何指令", cmdRotLimitedOut.kind === "error" && cmdRotLimitedOut.text.includes("换届速率限制窗口") && cmdRotLimitedOut.text.includes("该角色已有 pending") && cmdRotLimitedOut.text.includes("本命令未投递任何指令") && cmdRotLimitedEnv.senderCalls.followedup.length === 0);

const cmdRotNoServiceEnv = rotateEnv({ omitCommands: true });
check("§11.2 命令降级: 没有 commands 服务时两个命令都不注册、整跑仍只留一行 seam warn，其余工具面照常", cmdRotNoServiceEnv.commands.definitions.length === 0 && cmdRotNoServiceEnv.log.lines.warn.filter((line) => line.includes("commands service unavailable at activation")).length === 1 && ["team_link_list_sessions", "team_link_send", "team_link_roster", "team_link_rotate"].every((toolName) => cmdRotNoServiceEnv.tool(toolName) !== undefined));

const cmdRotLateEnv = rotateEnv({ lateCommands: true });
check("§11.2 命令降级: 迟到的 commands 提供方经 ordered injection 一次挂上两条命令，窗口内不再多留一行", cmdRotLateEnv.commands.definitions.length === 0 && cmdRotLateEnv.log.lines.warn.filter((line) => line.includes("commands service unavailable at activation")).length === 1);
await cmdRotLateEnv.provideCommands();
check("§11.2 命令降级: 服务到位后 /team_session 与 /team_rotate 都注册（同一个 seam，一次恢复）", cmdRotLateEnv.commands.command("team_session") !== undefined && cmdRotLateEnv.commands.command("team_rotate") !== undefined && cmdRotLateEnv.commands.definitions.length === 2 && cmdRotLateEnv.log.lines.warn.filter((line) => line.includes("commands service unavailable")).length === 1);

// --- §11.2 文档面 = 实现面（README 教的语法必须在实现里存在，反之亦然） --------
// 上一轮的真实教训：hint / 报错文案宣传的「位置参数写角色名」曾经端到端不可用。
// 这条把 README 也纳入同一判据——命令名、auto 语法、五个硬节、诚实原则四样都在
// 实现里有着落，改名字改语法时忘掉文档就会在这里红。
const handoffReadme = await readFile(fileURLToPath(new URL("./README.md", import.meta.url)), "utf8");
check("§11.2 文档面=实现面: README 写的两条入口与 auto 语法都能在实现里找到对应物（/team_rotate 文法 · successor:\"auto\" · handoff · 五个硬节 · 「不把关内容质量」的诚实原则）", handoffReadme.includes("`/team_rotate <role> [team=<name>]`") && handoffReadme.includes('successor:"auto"') && handoffReadme.includes("handoff") && __testing.HANDOFF_HARD_SECTIONS.every((name) => handoffReadme.includes(name)) && handoffReadme.includes("不把关内容质量") && cmdRotDefinition !== undefined && cmdRotDefinition !== undefined);
// §11.9 宣传面 = 实现面：README 教的两个动词、诊断词与「绝不降级 writer」都必须在
// 实现里有着落；两个派生词必须与实现里的常量逐字一致（镜像文案与代码分叉即红）。
check("§11.9 文档面=实现面: README 的两个动词 / 两个派生词 / 八条硬约束的措辞都能在实现里找到对应物，且派生词与代码常量逐字一致", ["team_link_recover", "action=reappoint", "vacant-due-to-death", "attended-only", "绝不把 `policy.writer` 降级为 `any`", "claim 一步不改", "`revive`"].every((needle) => handoffReadme.includes(needle)) && handoffReadme.includes(`\`${__testing.VACANT_LABEL}\``) && handoffReadme.includes(`\`${__testing.SEATED_DEAD_LABEL}\``) && reviveTool !== undefined);
// Y1 的双向锁（宣传面 = 实现面）: README **与**工具描述都必须说「两个动词的域不同」——
// 旧文案那句「本工具只受理 coordinator」正是被审计抓到的分叉（reappoint 其实受理任意
// 角色）。这条同时钉住「不再漂回去」：任何一侧重新写成整个工具只服务 coordinator，即红。
// 批次 2 §4.2 (a) 把这条锁的**内容**换了（锁本身还在，方向还在）：旧版要求两侧都说
// 「revive 仅 coordinator」——那是窄域时代的实现面。现在实现面是「两个动词都受理任意
// 角色，差别在动词语义上」，所以这条双向锁改成咬这句话，并且继续咬「旧窄域措辞一处
// 不剩」（任何一侧漂回窄域叙述，这里立刻红）。
check("Y1 文档面=实现面（双向锁，批次 2 改写）: README 与工具描述都说「两个动词都受理任意角色、差别在动词语义上」，且两侧都不再出现「`revive` 只受理 `coordinator`」或「本工具只受理 coordinator」那种窄域措辞", handoffReadme.includes("两个动词都受理任意角色") && !handoffReadme.includes("`revive` 只受理 `coordinator`") && !handoffReadme.includes("本工具只受理 `coordinator`") && reviveTool.description.includes("两个动词都受理任意角色") && !reviveTool.description.includes("`revive` 只受理 coordinator") && !reviveTool.description.includes("窄域：只恢复 coordinator 角色"));
// Y2 的文档面: 发起域也必须同时出现在 README 与工具描述里——「谁可以发起」这条设计条款
// 若只在设计文档里存在，就是下一轮审计的同一个洞。
check("Y2 文档面=实现面: 发起域（现任成员 ∪ 该角色最近一任前任，域外拒绝且指向设置 UI）同时写在 README 与工具描述里", handoffReadme.includes("现任成员") && handoffReadme.includes("最近一任前任") && handoffReadme.includes("设置 UI") && reviveTool.description.includes("发起域") && reviveTool.description.includes("现任成员"));
// 同改清单锁（② 轮「同一清单两处写、只改了一处」的教训）：README 里的工具计数必须
// 等于**实际注册的工具数**——加一个工具而忘了改 README（或反过来）在这里立刻变红。
const README_TOOL_COUNT = /(\d+) 个工具 \+ 2 条 \/ 命令/u.exec(handoffReadme)?.[1];
check("§11.9 文档面=实现面（工具计数同改锁）: README 架构图里写的工具数 == 实际注册的工具数（加/删工具而不同改文档即红）", README_TOOL_COUNT !== undefined && Number(README_TOOL_COUNT) === diagEnv.registeredTools.length && diagEnv.registeredTools.length === 10 && diagEnv.registeredTools.some((tool) => tool.name === "team_link_recover") && diagEnv.registeredTools.some((tool) => tool.name === "team_link_status"));

// ---------------------------------------------------------------------------
// §9 收尾修复（0.3.7）: U9 settings 时序锁 / U10 创建即认领 / U11 降级红线
// ---------------------------------------------------------------------------



// --- U9: the settings seam is a TIMING contract, not a snapshot (§9.1.3) -----
// Every environment above provides `settings` BEFORE `apply()`, so all of them
// can only ever exercise the fast path. Production does the opposite — the
// settings provider finishes its `[Service.init]` (load settings.yaml, then
// publish) after this plugin activates — and the pre-fix store read
// `ctx.get("settings")` exactly once, at apply time, then fell back to process
// memory silently and permanently (teams / watchdogs / pairs never reached
// disk). This case reproduces the production ORDER: apply first, provider later.
// The provider side is a real cordis Context, so `provide` after the fact is
// what fires the plugin's `ctx.inject(["settings"], …)` callback — the stub is
// not allowed to shortcut that (§9.1.4).

const lateEnv = setup({
	sessions: [],
	lateSettings: true,
	// §10.2.1's second optional-service race is deliberately NOT part of this
	// case: `commands` is provided synchronously here so the window's warn count
	// stays exactly what the settings seam's own contract asserts (the commands
	// window has its own cases below).
	lateCommands: true,
	selfCwd: TEAM_WS,
	// Pre-loaded into the legacy namespace by the stub's own register (the state a
	// provider would have read from settings.yaml), so the one-time rename
	// migration — which now runs from `attach` — has something to migrate. That
	// is the evidence that the call site really moved off apply time.
	settingsSeed: { "session-link-pro": { receiveMode: "accept", trustedSenders: ["session-legacy"] } },
});
check("U9 前置: at activation the provider is not active yet — nothing registered, one line per seam and no info line (§10.2.1's commands seam speaks for itself)", lateEnv.settings.namespaces.size === 0 && lateEnv.log.lines.warn.length === 2 && lateEnv.log.lines.warn[0].includes("settings not active at activation") && lateEnv.log.lines.warn[1].includes("commands service unavailable at activation") && lateEnv.log.lines.info.length === 0);
await lateEnv.provideSettings();
check("U9: the store attaches once the provider goes active and says so in exactly one info line", lateEnv.settings.namespaces.has("team-link") && lateEnv.log.lines.info.filter((line) => line.includes('policy store attached to settings namespace "team-link"')).length === 1);
check("U9: the one-time legacy migration runs from the attach, not from apply (session-link-pro → team-link)", lateEnv.settings.namespaces.get("team-link")?.data.receiveMode === "accept" && (lateEnv.settings.namespaces.get("team-link")?.data.trustedSenders ?? []).join(",") === "session-legacy");
const lateRoster = lateEnv.tool("team_link_roster");
const lateCreateOut = await lateRoster.execute({ action: "upsert-team", team: "night-shift" }, execFor(lateEnv.senderAgent));
check("U9: a write after the late attach lands in the settings namespace — persistence, not process memory", (lateEnv.settings.namespaces.get("team-link")?.data.teams ?? []).length === 1 && lateEnv.settings.namespaces.get("team-link")?.data.teams[0].name === "night-shift" && lateCreateOut.includes("已创建团队 night-shift"));
check("U9: the lazy retries stay silent — still one line per seam for the whole startup window", lateEnv.log.lines.warn.length === 2);

// The same race, second site (§9.1.3 第三处): the export route is taken from the
// runtime channel too, so it must be mounted on a late webServer instead of being
// lost to one apply-time snapshot.
const lateWsEnv = setup({ sessions: [], lateWebServer: true });
check("U9 对照 (webServer): with no active webServer the route is not mounted, and the degradation is announced instead of silent", lateWsEnv.routes.length === 0 && lateWsEnv.log.lines.warn.some((line) => line.includes("webServer service unavailable at activation")));
await lateWsEnv.provideWebServer();
check("U9 对照 (webServer): the same late-attach pattern mounts the export route once the provider appears", lateWsEnv.routes.filter((route) => route.kind === "exact" && route.path === "/team-link/export").length === 1);

// Data consistency across the same window (§9.1.3 数据一致性, defensive redundancy):
// the memory engine can only be written before the attach. If that happens, the
// write must be folded into settings rather than silently dropped.
const memWindowEnv = setup({ sessions: [], lateSettings: true, lateCommands: true, selfCwd: TEAM_WS });
const memWindowOut = await memWindowEnv.tool("team_link_roster").execute({ action: "upsert-team", team: "night-shift" }, execFor(memWindowEnv.senderAgent));
check("U9 对照 (数据一致性): a write inside the startup window is served by the memory engine (no settings namespace exists yet)", memWindowOut.includes("已创建团队 night-shift") && memWindowEnv.settings.namespaces.size === 0);
await memWindowEnv.provideSettings();
process.stderr.write("DBG memWindow ALL=" + JSON.stringify({ warn: memWindowEnv.log.lines.warn, info: memWindowEnv.log.lines.info.map((l) => l.slice(0, 160)) }, null, 1) + "\n");
check("U9 对照 (数据一致性): the window's write is folded into the settings namespace at attach instead of being dropped, with one line saying so", (memWindowEnv.settings.namespaces.get("team-link")?.data.teams ?? []).length === 1 && memWindowEnv.log.lines.warn.some((line) => line.includes("unattached startup window")) && memWindowEnv.log.lines.info.filter((line) => line.includes("policy store attached")).length === 1);

// 差异审计修复轮 · 🟡-1: the SAME fold, on the ONE policy key the ② round added.
// `policyIsAtDefaults` (lib/index.js) names all eight `DEFAULT_POLICY` keys, so it
// licenses the wholesale write above — but a predicate is only half of a write
// surface: the patch `adoptMemoryWindow` hands to `update()` is the other half, and
// it still carried the seven pre-② keys. The window's own comment already says
// 「Fields added to DEFAULT_POLICY belong here in the same change」; the sibling
// write surface did not follow it, so a §10.2.6 `pending-creates` intent written in
// the startup window was dropped at the fold — exactly the durable row the next
// boot's sweep exists to report (the audit's probe read `pendingCreates=undefined`
// here, and the sweep then had nothing to hand over). This case is that window
// end-to-end: plugin first, settings AND commands afterwards, one failed create
// leaves an unresolved intent in the memory engine, then the provider arrives.
const pendingFoldEnv = setup({ sessions: [], lateSettings: true, lateCommands: true, askScript: ["创建"], selfCwd: TEAM_WS, failCreateAt: 1 });
check("U9 对照 (pendingCreates): both providers are late, so the whole batch runs inside the memory-only window (one line per seam, nothing registered, no command yet)", pendingFoldEnv.log.lines.warn.length === 2 && pendingFoldEnv.log.lines.warn[0].includes("settings not active at activation") && pendingFoldEnv.log.lines.warn[1].includes("commands service unavailable at activation") && pendingFoldEnv.settings.namespaces.size === 0 && pendingFoldEnv.commands.command("team_session") === undefined);
await pendingFoldEnv.provideCommands();
check("U9 对照 (pendingCreates) 前置: the late commands seam registers through the same ordered injection, with no extra line for the window", pendingFoldEnv.commands.command("team_session") !== undefined && pendingFoldEnv.log.lines.warn.length === 2);
const pendingFoldOut = await pendingFoldEnv.commands.command("team_session").handler(pendingFoldEnv.invoke("n=2 team=night-shift roles=worker-a,worker-b task=窗口内建队"));
const pendingFoldId = at(pendingFoldEnv.creates, 1, {}).sessionId;
check("U9 对照 (pendingCreates) 前置: worker-b's create fails, so its intent is never resolved — the write the fold has to carry is the ONLY in-memory intent", pendingFoldEnv.creates.length === 2 && pendingFoldOut.kind === "error" && pendingFoldEnv.settings.namespaces.size === 0);
await pendingFoldEnv.provideSettings();
await tick();
const pendingFoldNs = pendingFoldEnv.settings.namespaces.get("team-link");
check("U9 对照 (pendingCreates) 前置: the fold itself happened — the window's roster write reached the namespace (so a missing intent below cannot be blamed on a fold that never ran)", (pendingFoldNs?.data.teams ?? []).map((team) => team.name).join(",") === "night-shift" && pendingFoldEnv.log.lines.warn.some((line) => line.includes("unattached startup window")));
check("U9 对照 (pendingCreates): a §10.2.6 intent written inside the startup window SURVIVES the fold into the settings namespace — the durable orphan record the next boot's sweep reports is not dropped by adopting the window", (pendingFoldNs?.data.pendingCreates ?? []).length === 1 && (pendingFoldNs?.data.pendingCreates ?? [])[0].sessionId === pendingFoldId && (pendingFoldNs?.data.pendingCreates ?? [])[0].role === "worker-b" && (pendingFoldNs?.data.pendingCreates ?? [])[0].team === "night-shift");
check("U9 对照 (pendingCreates): the folded rows are the window's own normalized rows — every field of the intent survived, not just its presence", (pendingFoldNs?.data.pendingCreates ?? []).length === 1 && (pendingFoldNs?.data.pendingCreates ?? []).every((entry) => entry.createdAt > 0 && entry.expiresAt > entry.createdAt && entry.by === "session-self" && Object.keys(entry).sort().join(",") === "by,createdAt,expiresAt,role,sessionId,team"));
check("U9 对照 (pendingCreates): the fold is the wholesale write {@link policyIsAtDefaults} licenses, so it carries all NINE policy keys（FR-9 的 sections 是第九个）— the new one beside the seven that pre-date ②, with the window's roster and the pair granted for the one worker that WAS created inside them", sameJson(Object.keys(pendingFoldNs?.data ?? {}).sort(), ["blockedSenders", "pairs", "pendingCreates", "receiveMode", "rememberTargets", "sections", "teams", "trustedSenders", "watchdogs"]) && (pendingFoldNs?.data.teams ?? []).length === 1 && (pendingFoldNs?.data.pairs ?? []).length === 1 && at(pendingFoldNs?.data.pairs, 0, {}).b === at(pendingFoldEnv.creates, 0, {}).sessionId);

// --- U10 (§3.3.2 创建即认领 / §9.2.2): bootstrap, no hijack, gates untouched ---
const u10Env = teamEnv({ teams: [] });
const u10Roster = u10Env.tool("team_link_roster");
const u10Create = await u10Roster.execute({ action: "upsert-team", team: "night-shift" }, execFor(u10Env.senderAgent));
check("U10: the creation path seeds the creating session as coordinator.current, in the same write", u10Create.includes("coordinator 已由创建会话 session-self 认领") && teamStore(u10Env)[0].roles.length === 1 && teamStore(u10Env)[0].roles[0].current === "session-self");
const u10ForeignUpsert = await u10Roster.execute({ action: "upsert-team", team: "night-shift" }, execFor(u10Env.targetAgent));
check("U10: a non-incumbent cannot hijack an existing team through upsert-team — the seed never runs twice and the gate still refuses", u10ForeignUpsert.includes("只有现任协调者会话 session-self 可写") && teamStore(u10Env)[0].roles.length === 1 && teamStore(u10Env)[0].roles[0].current === "session-self");
const u10SetRole = await u10Roster.execute({ action: "set-role", team: "night-shift", role: "coordinator", session: "session-target", note: "夜班接手" }, execFor(u10Env.senderAgent));
check("U10: the creating session can write immediately — set-role goes through (the bootstrap really unlocks M2–M4)", u10SetRole.includes("已设置") && teamStore(u10Env)[0].roles[0].current === "session-target");
const u10RolesAfterHandover = JSON.stringify(teamStore(u10Env)[0].roles);
const u10Idempotent = await u10Roster.execute({ action: "upsert-team", team: "night-shift" }, execFor(u10Env.targetAgent));
check("U10: upsert-team on an existing team is still idempotent — roles/version history byte-identical, no re-seed for the new incumbent", u10Idempotent.includes("已存在") && u10Idempotent.includes("幂等") && JSON.stringify(teamStore(u10Env)[0].roles) === u10RolesAfterHandover);
const u10ExtraArg = await rejects(u10Roster, { action: "upsert-team", team: "day-shift", coordinator: "session-target" }, execFor(u10Env.senderAgent));
check("U10: the tool surface has no `coordinator` parameter (§9.2.2 不新增 API 面；B 批只加了 set-mode 自己的两个参数 mode / leadSessionId), and an undeclared id cannot seed the role — the seed is always the calling session", Object.keys(u10Roster.parameters.properties).sort().join(",") === "action,leadSessionId,mode,note,role,session,team" && teamStore(u10Env).find((team) => team.name === "day-shift")?.roles[0].current === "session-self" && !String(u10ExtraArg).includes("session-target"));
check("U10: a HAND-WRITTEN vacant row (settings UI) still answers 「空缺 → 设置 UI」 for set-role and for upsert-team — writerGate is untouched", vacantSetRole.includes("当前空缺") && vacantSetRole.includes("设置 UI") && vacantUpsert.includes("当前空缺"));
const u10VacantRetire = await vacantRoster.execute({ action: "retire", team: "night-shift", role: "coordinator" }, execFor(vacantEnv.senderAgent));
check("U10: ... and retire on that vacant row is refused the same way — retireGate is untouched", u10VacantRetire.includes("当前空缺") && u10VacantRetire.includes("设置 UI"));

// --- U11 (§5.3 红线): no settings at all ⇒ full function, exactly one line ----
const bareEnv = setup({ sessions: [{ header: { id: "session-lv-silent", createdAt: 1000, cwd: TEAM_WS }, live: true, persisted: true }], eventsBySession: { "session-lv-silent": ancientEvents("silent") }, extraAgents: [{ id: "session-lv-silent", status: "idle" }], omitCommands: true, selfCwd: TEAM_WS });
check("U11: with no settings service the whole tool surface still registers", ["team_link_list_sessions", "team_link_export", "team_link_send", "team_link_watch", "team_link_roster", "team_link_team_read", "team_link_team_append", "team_link_rotate"].every((toolName) => bareEnv.tool(toolName) !== undefined));
check("U11: one line per unattached seam for the activation window — the settings line first, §10.2.1's commands line second, no info line, no silent fallback", bareEnv.log.lines.warn.length === 2 && bareEnv.log.lines.warn[0].includes("settings not active at activation") && bareEnv.log.lines.warn[1].includes("commands service unavailable at activation") && bareEnv.log.lines.info.length === 0);
const bareRoster = bareEnv.tool("team_link_roster");
const bareCreate = await bareRoster.execute({ action: "upsert-team", team: "day-shift" }, execFor(bareEnv.senderAgent));
const bareSetRole = await bareRoster.execute({ action: "set-role", team: "day-shift", role: "coordinator", session: "session-target" }, execFor(bareEnv.senderAgent));
const bareAppend = await bareEnv.tool("team_link_team_append").execute({ team: "day-shift", file: "decisions", line: "内存引擎下的裁决" }, execFor(bareEnv.senderAgent));
const bareRead = await bareEnv.tool("team_link_team_read").execute({ team: "day-shift" }, execFor(bareEnv.senderAgent));
check("U11: M2 stays fully usable on the memory engine (create → set-role → 黑板 append → read back)", bareCreate.includes("已创建团队 day-shift") && bareSetRole.includes("已设置") && bareAppend.includes("已追加 decisions #1") && bareRead.includes("内存引擎下的裁决"));
check("U11: the lazy retries never add a line — still one line per seam after a full M2 round trip", bareEnv.log.lines.warn.length === 2 && bareEnv.log.lines.info.length === 0);
const bareList = await bareEnv.tool("team_link_list_sessions").execute({}, execFor(bareEnv.senderAgent));
check("U11: the goals degradation is unchanged — a missing service renders goal=? and the list still works", bareList.includes("goal=?") && !bareList.includes("列出会话失败"));

// The documented second branch: a context without `ctx.inject` (§9.1.3 ②) says so
// in its own line, and the lazy retry is then the whole recovery path.
const lazyEnv = setup({ sessions: [], lateSettings: true, noInject: true, lateCommands: true, selfCwd: TEAM_WS });
check("U11: without ctx.inject the memory fallback is announced in a second, explicit line, and §10.2.1's commands seam adds its own", lazyEnv.log.lines.warn.length === 3 && lazyEnv.log.lines.warn[1].includes("ctx.inject unavailable") && lazyEnv.log.lines.warn[2].includes("commands service unavailable at activation"));await lazyEnv.provideSettings();
check("U11 前置: with nothing registered for injection the late provider is not picked up on its own", lazyEnv.settings.namespaces.size === 0);
const lazyOut = await lazyEnv.tool("team_link_roster").execute({ action: "upsert-team", team: "night-shift" }, execFor(lazyEnv.senderAgent));
check("U11: the first tool call retries lazily and attaches (§9.1.3 ③) — the write lands in settings and one info line is left", lazyOut.includes("已创建团队 night-shift") && (lazyEnv.settings.namespaces.get("team-link")?.data.teams ?? []).length === 1 && lazyEnv.log.lines.info.filter((line) => line.includes("policy store attached")).length === 1);
check("U11: ... and the retry did not repeat the activation warn (still three lines: the window, the missing ctx.inject and the commands seam)", lazyEnv.log.lines.warn.length === 3);

// --- F1 (差异审计 · 唯一实质分歧): a provider that is ACTIVE but refuses ----
// `register` is the second arrival path of the same "not attached" warn. When
// the provider is already active, attachFrom() answers `"attached"` — or
// `"refused"` when the provider answered but `register` threw (评审 round-2
// 🔵 #2 turned its boolean into a reason code) — so the activation branch below
// never runs and — pre-fix — nothing latched a one-shot gate: each get()/update()
// re-entered the register catch and the warn had no upper bound (audit probe:
// 3 get + 1 upsert ⇒ 11 warns). §9.1.3 ③ puts both paths behind the same
// `attachWarned` gate, counted over the whole startup window (U11). The
// assertions below count only this plugin's settings lines, so the webServer
// warn of an unrelated branch cannot mask a missing gate.
const settingsWarnsOf = (lines) => lines.filter((line) => line.includes("dsh-team-link: settings "));

// This fixture is the audit's own shape: the provider IS active when the plugin
// activates (so the fast path reaches `attach` and the refusal is the first thing
// the store ever sees), while the assertions after it drive the lazy retries.
const refusingEnv = setup({ sessions: [], useSettings: true, lateCommands: true, settingsRegisterThrows: true, selfCwd: TEAM_WS });
check("F1 前置: the refusal is announced once when the active provider refuses register", settingsWarnsOf(refusingEnv.log.lines.warn).length === 1 && settingsWarnsOf(refusingEnv.log.lines.warn)[0].includes("settings register failed") && refusingEnv.log.lines.info.length === 0);
const refusingRoster = refusingEnv.tool("team_link_roster");
const refusingOut = await refusingRoster.execute({ action: "upsert-team", team: "night-shift" }, execFor(refusingEnv.senderAgent));
check("F1 前置: with no scope attached the store stays usable on the memory engine", refusingOut.includes("已创建团队 night-shift") && refusingEnv.settings.namespaces.size === 0);
check("F1: after three lazy get() retries and one update(), the whole startup window still carries exactly one settings warn — no warn storm", refusingOut.includes("已创建团队 night-shift") && settingsWarnsOf(refusingEnv.log.lines.warn).length === 1 && refusingEnv.log.lines.info.length === 0);

// The mirror image, so the gate is asserted on BOTH arrival paths: here the
// provider only becomes active after apply, so the activation branch writes the
// line first and the lazy retries must stay quiet behind the same gate.
const lateRefusingEnv = setup({ sessions: [], lateSettings: true, lateCommands: true, settingsRegisterThrows: true, selfCwd: TEAM_WS });
check("F1 对照: the activation warn is the only line before the provider goes active", settingsWarnsOf(lateRefusingEnv.log.lines.warn).length === 1 && lateRefusingEnv.log.lines.warn[0].includes("settings not active at activation"));
await lateRefusingEnv.provideSettings();
const lateRefusingRoster = lateRefusingEnv.tool("team_link_roster");
const lateRefusingOut = await lateRefusingRoster.execute({ action: "upsert-team", team: "night-shift" }, execFor(lateRefusingEnv.senderAgent));
check("F1 对照: the register failure that arrives second does NOT add a line — same gate, one line for the window", lateRefusingOut.includes("已创建团队 night-shift") && settingsWarnsOf(lateRefusingEnv.log.lines.warn).length === 1 && lateRefusingEnv.log.lines.info.length === 0);

// --- 评审 #4: an unavailable LEGACY namespace must not be swallowed ----------
// The pre-rename namespace is best-effort, but "best-effort" ≠ silent: if it
// cannot be registered, the pre-rename trust data will not be migrated, and that
// has to be visible. Only `session-link-pro` is refused here, so the current
// namespace still attaches normally.
const legacyEnv = setup({ sessions: [], useSettings: true, legacyRegisterThrows: true, selfCwd: TEAM_WS });
check("评审 #4: the current namespace still attaches while the legacy one is refused", legacyEnv.settings.namespaces.has("team-link") && !legacyEnv.settings.namespaces.has("session-link-pro") && legacyEnv.log.lines.info.filter((line) => line.includes("policy store attached")).length === 1);
check("评审 #4: ... and the unavailable legacy namespace leaves one line naming it and the skipped migration", legacyEnv.log.lines.warn.length === 1 && legacyEnv.log.lines.warn[0].includes(`legacy namespace "session-link-pro" unavailable`) && legacyEnv.log.lines.warn[0].includes("不会自动迁移"));

// --- 评审 round-2 🔵 #3: the attach-time chain is observable end to end -------
// `void adoptMemoryWindow().then(() => migrateLegacyPolicy()).catch(…)` used to
// be fire-and-forget with a silent catch, and `migrateLegacyPolicy`'s early read
// failure returned with no line at all — so neither "migrated" nor "skipped" nor
// "failed" could be read off the store. Each attach now names both steps in one
// info line, and the read failure that used to be swallowed leaves a warn.
// The chain deliberately stays fire-and-forget on the fast path, so the fixture
// installed synchronously above needs one yield before its line can be read.
await tick();
check("🔵 #3: the attach-time chain names both steps' outcomes in one info line (migrated path)", lateEnv.log.lines.info.some((line) => line.includes("post-attach policy chain finished") && line.includes("memory window: none (no writes while unattached)") && line.includes("legacy migration: migrated")));
check("🔵 #3: the skipped path is named, not left to inference — and 🔵 #5: a REFUSED legacy register now reads as refused instead of as 「没有旧命名空间」", legacyEnv.log.lines.info.some((line) => line.includes("post-attach policy chain finished") && line.includes("legacy migration: legacy namespace refused (register failed)")));
// The branch that had no line whatsoever: the legacy namespace registers but
// cannot be read. Pre-fix this fixture produced a completely silent skip.
const unreadableLegacyEnv = setup({ sessions: [], useSettings: true, legacyGetThrows: true, selfCwd: TEAM_WS });
await tick();
check("🔵 #3: a legacy namespace that cannot be READ leaves a warn naming the skipped migration (pre-fix: no line at all)", unreadableLegacyEnv.log.lines.warn.some((line) => line.includes(`legacy namespace "session-link-pro" could not be read`) && line.includes("本次未迁移")) && unreadableLegacyEnv.log.lines.info.some((line) => line.includes("legacy migration: legacy read failed")));

// --- 评审 round-2 🟡 #1: a disposed provider must not leave a dead scope ------
// §9.1.3 binds the settings scope to the fiber of the context that produced it —
// the rule the webServer site already follows (`target.effect(() => webServer
// .register(…))`). Without the binding, a late `ctx.inject(["settings"], …)`
// attach outlives its provider: `scope` stays non-null while dead, every
// `update()` throws into the caller's「写入设置失败」path and every `get()`
// silently answers from stale process memory — and no retry can ever re-attach,
// because the retry is gated on `scope === null`. The provider below is a real
// cordis plugin fiber (see `provideSettingsFiber`): it is retired by disposing
// that fiber, never by a hand-flipped flag.
const deadEnv = setup({ sessions: [], lateSettings: true, selfCwd: TEAM_WS });
check("🟡 #1 前置: the provider is late — activation leaves the one warn and nothing registered", deadEnv.log.lines.warn.length === 1 && deadEnv.settings.namespaces.size === 0);
const firstProvider = await deadEnv.provideSettingsFiber();
const deadRoster = deadEnv.tool("team_link_roster");
const beforeDispose = await deadRoster.execute({ action: "upsert-team", team: "night-shift" }, execFor(deadEnv.senderAgent));
check("🟡 #1 前置: with the provider up the store attaches on the late path and the write lands in its namespace", beforeDispose.includes("已创建团队 night-shift") && (deadEnv.settings.namespaces.get("team-link")?.data.teams ?? []).map((team) => team.name).join(",") === "night-shift" && deadEnv.log.lines.info.filter((line) => line.includes("policy store attached")).length === 1);

await firstProvider.dispose();
await tick();
// 策略持久化自持化（设计档 §3.1）改了这条行的**对象**：provider 掉线后 store 回落的不再是
// 「纯内存」，而是文件后端（能解析出路径时）。措辞与断言**同改**（本仓纪律 ⑤：描述面不许
// 与实现面矛盾）—— 锁的仍然是「掉线就说一行、且这一行必须点名回落落点」。
check("🟡 #1: disposing the provider's fiber releases the scope — one line names the 回落落点 (the file backend, not bare process memory)", deadEnv.log.lines.info.some((line) => line.includes("settings scope released with its owner fiber") && line.includes("回落落点：文件后端") && line.includes(path.join("team-link", "policy.json"))));

const whileDetached = await deadRoster.execute({ action: "upsert-team", team: "detached-team" }, execFor(deadEnv.senderAgent));
check("🟡 #1: after the provider is gone the store is UNATTACHED rather than attached-to-a-dead-scope — the write is served by the memory engine instead of failing against the dead scope", whileDetached.includes("已创建团队 detached-team") && !whileDetached.includes("写入设置失败"));
check("🟡 #1: ... and nothing was written through the dead scope (its namespace still holds exactly the pre-disposal state)", (deadEnv.settings.namespaces.get("team-link")?.data.teams ?? []).map((team) => team.name).join(",") === "night-shift");

// The provider comes back as a restarted provider would: a FRESH service
// instance (a new stub), which is what makes "re-attached to the new provider"
// observable rather than merely "still holding the old one".
const revived = makeSettings({ "team-link": { teams: [teamRow({ name: "carried-team", writer: "any" })] } });
await deadEnv.provideSettingsFiber(revived);
check("🟡 #1: when the provider returns, the lazy path re-attaches — a second attach line, against the new provider", deadEnv.log.lines.info.filter((line) => line.includes('policy store attached to settings namespace "team-link"')).length === 2 && revived.namespaces.has("team-link"));
const revivedRead = await deadRoster.execute({ action: "get" }, execFor(deadEnv.senderAgent));
check("🟡 #1: reads now come from the new provider's namespace — stale process memory no longer masquerades as the store's state", revivedRead.includes("carried-team") && !revivedRead.includes("detached-team"));
const afterRevival = await deadRoster.execute({ action: "upsert-team", team: "after-team" }, execFor(deadEnv.senderAgent));
check("🟡 #1: ... and writes follow the live provider too (persistence is not pinned to the first scope)", afterRevival.includes("已创建团队 after-team") && (revived.namespaces.get("team-link")?.data.teams ?? []).map((team) => team.name).join(",") === "carried-team,after-team");
// Every attach states what happened to the memory-only window, including the
// case where it is deliberately NOT adopted — a window write that settings
// outranks is named, not dropped in silence (🔵 #3).
await waitForChain(deadEnv, 2);
check("🔵 #3: every attach reports the window outcome — the un-adopted window write is named, not silently dropped", deadEnv.log.lines.info.filter((line) => line.includes("post-attach policy chain finished")).length === 2 && deadEnv.log.lines.info.some((line) => line.includes("memory window: not folded (settings namespace already in use)")));

// --- 评审 round-3 🟡 #1: the one-shot gate counts WINDOWS, not the process ----
// `detach()` ends an unattached window (its scopes died with their owner fiber),
// so the next window has to be able to speak for itself. Pre-fix the gate stayed
// latched for the process lifetime: a provider that came BACK and then REFUSED
// `register` produced no warn at all — the only trace was the release line's
// "memory-only until it attaches again", which cannot distinguish 仍在等 from
// 被拒绝 (silent refusal is the original ③ defect). The provider side is a real
// cordis plugin fiber, as in the 🟡 #1 case above: window 1 attaches against a
// working provider, that fiber is disposed, and window 2 is a provider that
// answers but refuses.
const windowGateEnv = setup({ sessions: [], lateSettings: true, selfCwd: TEAM_WS });
check("🟡 #1 前置: window 1 announces itself once (the activation line) and registers nothing", settingsWarnsOf(windowGateEnv.log.lines.warn).length === 1 && settingsWarnsOf(windowGateEnv.log.lines.warn)[0].includes("settings not active at activation") && windowGateEnv.settings.namespaces.size === 0);
const windowGateProvider1 = await windowGateEnv.provideSettingsFiber();
check("🟡 #1 前置: window 1 attaches against the provider that returns, still at one warn for that window", windowGateEnv.log.lines.info.filter((line) => line.includes('policy store attached to settings namespace "team-link"')).length === 1 && settingsWarnsOf(windowGateEnv.log.lines.warn).length === 1);
await windowGateProvider1.dispose();
await tick();
check("🟡 #1 前置: disposing that fiber ends window 1 — scopes released with one line, store unattached again", windowGateEnv.log.lines.info.some((line) => line.includes("settings scope released with its owner fiber")) && windowGateEnv.log.lines.info.filter((line) => line.includes("policy store attached")).length === 1);
await windowGateEnv.provideSettingsFiber(makeSettings({}, { settingsRegisterThrows: true }));
check("🟡 #1: window 2's refusal is announced — the gate re-opened together with the window (pre-fix: zero lines, a silently refused window)", settingsWarnsOf(windowGateEnv.log.lines.warn).length === 2 && settingsWarnsOf(windowGateEnv.log.lines.warn)[1].includes("settings register failed"));
const windowGateWrite = await windowGateEnv.tool("team_link_roster").execute({ action: "upsert-team", team: "second-window" }, execFor(windowGateEnv.senderAgent));
check("🟡 #1: ... and window 2 is still exactly ONE warn — the lazy retries behind the refusal add nothing (窗口内语义未变)", windowGateWrite.includes("已创建团队 second-window") && settingsWarnsOf(windowGateEnv.log.lines.warn).length === 2 && windowGateEnv.log.lines.info.filter((line) => line.includes("policy store attached")).length === 1);

// --- 评审 round-3 🔵 #3: the memory-window flag dies with its window ---------
// The flag exists to fold writes made before the attach. Pre-fix it was never
// cleared, so a SECOND, brand-new provider was fed the same (already resolved)
// memory state again — a second fold plus a second 「该窗口理论不可达」 warn: the
// flag's lifetime claimed a window that had already been resolved.
const refoldEnv = setup({ sessions: [], lateSettings: true, selfCwd: TEAM_WS });
await refoldEnv.tool("team_link_roster").execute({ action: "upsert-team", team: "window-one" }, execFor(refoldEnv.senderAgent));
// 策略持久化自持化（设计档 §3.1 档 4）把这个标记从「memory-only startup window」改成
// 「unattached startup window」：未挂载设置服务的那个窗口如今由**文件后端**支撑，
// 继续叫它 memory-only 会与实现面矛盾（本仓纪律 ⑤）。判据（折叠一次、只一行 warn、
// 匹配 chain token）一字未松。
const refoldFolds = () => refoldEnv.log.lines.warn.filter((line) => line.includes("unattached startup window"));
const refoldProvider = await refoldEnv.provideSettingsFiber();

await waitForChain(refoldEnv, 1);
check("🔵 #3 前置: window 1's memory write is folded into the namespace exactly once, with one warn and the matching chain token", (refoldEnv.settings.namespaces.get("team-link")?.data.teams ?? []).map((team) => team.name).join(",") === "window-one" && refoldFolds().length === 1 && refoldEnv.log.lines.info.some((line) => line.includes("memory window: folded into settings")));
await refoldProvider.dispose();
await tick();
// A brand-new provider whose namespace is empty — the shape that used to be
// re-fed the previous window's memory state.
const refoldFresh = makeSettings();
await refoldEnv.provideSettingsFiber(refoldFresh);
await tick();
await waitForChain(refoldEnv, 2);
check("🔵 #3: the flag does not outlive its window — the new provider is NOT re-fed the resolved state (no second fold, no second 「理论不可达」 warn)", refoldFresh.namespaces.has("team-link") && (refoldFresh.namespaces.get("team-link")?.data.teams ?? []).length === 0 && refoldFolds().length === 1 && (refoldEnv.log.lines.info.filter((line) => line.includes("post-attach policy chain finished")).at(-1) ?? "").includes("memory window: none (no writes while unattached)"));

// --- 评审 round-3 🔵 #5: 「旧命名空间被拒」≠「根本没有旧命名空间」 ---------
// The refused case is `legacyEnv` above (its chain line now names the refusal).
// This is the other half of the same value set: a legacy namespace that REGISTERS
// fine but holds nothing reads as "no legacy data" — the token the refused case
// used to collapse into.
const emptyLegacyEnv = setup({ sessions: [], useSettings: true, selfCwd: TEAM_WS });
await tick();
check("🔵 #5: a legacy namespace that registers but holds nothing reads as 「no legacy data」 — the skip tokens are distinct values, not one", emptyLegacyEnv.log.lines.info.some((line) => line.includes("post-attach policy chain finished") && line.includes("legacy migration: no legacy data")));

// --- 评审 round-3 🔵 #4: the webServer line's wording comes from the ONE read --
// Same reason-code shape as `attachFrom`: a service that IS there without
// `register()` is named as such, so no second `ctx.get("webServer")` is needed to
// pick the wording (a second read could observe a different moment and describe a
// state that was never true).
const registerlessWsEnv = setup({ sessions: [], webServerWithoutRegister: true });
const registerlessWarns = registerlessWsEnv.log.lines.warn.filter((line) => line.includes("webServer service unavailable at activation"));
check("🔵 #4: a webServer without register() is named by its reason code — 「no register()」, not 「not yet active」", registerlessWarns.length === 1 && registerlessWarns[0].includes("(no register())") && registerlessWsEnv.routes.length === 0);

// ---------------------------------------------------------------------------
// §10.2 ② /team_session 自动建队（U16 / U17 / U18 / U19）
// ---------------------------------------------------------------------------

/**
 * One §10.2 ② environment: the §10.2.1 command face plus the §10.2.2 create
 * face. `commands` is reached the way the plugin reaches it (optional ordered
 * injection → `ctx.get("commands")`), and the command handler is driven with a
 * real `CommandInvocation` so the assertions cover the handler and not a
 * re-implementation of it.
 */
function teamSessionEnv({ teams = [], sessions = [], askScript = [], extraAgents = [], omitUserQuestions = false, omitCommands = false, lateCommands = false, omitAgentPresets = false, agentPresetsOptions = undefined, omitWorkspaceRegistry = false, omitSessionTitle = false, sessionTitleOptions = undefined, omitAgentDefaultModel = false, agentDefaultModelOptions = undefined, workspaceRegistryOptions = undefined, failCreateAt = -1, selfCwd = TEAM_WS, createdHook = undefined, actionLog = [], pendingSeed = undefined } = {}) {
	const env = setup({ sessions, useSettings: true, askScript, selfCwd, extraAgents, omitUserQuestions, omitCommands, lateCommands, omitAgentPresets, agentPresetsOptions, omitWorkspaceRegistry, omitSessionTitle, sessionTitleOptions, omitAgentDefaultModel, agentDefaultModelOptions, workspaceRegistryOptions, failCreateAt, createdHook, actionLog, pendingSeed });
	const ns = env.settings.namespaces.get("team-link");
	ns.data.teams = structuredClone(teams);
	return {
		...env,
		ns,
		// Read through the namespace on every call: the stub's `update()` assigns
		// the patched keys, so a `data.teams` captured at setup time goes stale the
		// moment the command writes one (the same reason `teamStore` re-reads).
		store: () => env.settings.namespaces.get("team-link").data.teams ?? [],
		pairs: () => env.settings.namespaces.get("team-link").data.pairs ?? [],
		pending: () => env.settings.namespaces.get("team-link").data.pendingCreates ?? [],
		run: (rawInput, agent = env.senderAgent) => env.commands.command("team_session").handler(env.invoke(rawInput, agent)),
		/** Give the created workers a PERSISTED session row: `list_sessions` lists
		 * what the session store knows (`ctx.sessionQuery`), which is exactly why a
		 * freshly created live agent is already addressable before its first
		 * checkpoint — the §10.2.5 「盘上有会话但无活代理 ⇒ dead」 reading needs both
		 * halves present, so both are fixtures here. */
		seedSessionRecords: (ids) => {
			env.query.records = ids.map((sessionId, position) => ({ header: { id: sessionId, createdAt: 1000 + position, cwd: TEAM_WS }, live: true, persisted: true }));
		},
	};
}

/**
 * The session id a run created for one ROLE. The lookup is by role — the id
 * grammar is `team-link-<team>-<role>-<uuid8>`, so the role segment is what
 * identifies the row — instead of by position in `creates`, which silently
 * returns whatever was created first and would keep passing if the batch were
 * reordered (a positional helper that names itself after the role misleads).
 */
const plannedId = (env, team, role) => env.creates.find((options) => new RegExp(`^team-link-${team}-${role}-[0-9a-f]{8}$`, "u").test(options.sessionId))?.sessionId;

// --- U16a (§10.2.1): the command face is registered through the OPTIONAL seam --
const cmdEnv = teamSessionEnv();
check("U16: /team_session is registered through the optional commands service (name + human-facing descriptor)", cmdEnv.commands.command("team_session") !== undefined && cmdEnv.commands.command("team_session").description.includes("自动建队") && typeof cmdEnv.commands.command("team_session").handler === "function");
check("U16: the definition declares a hint (CommandInputDescriptor has no other grammar field) and no attachment channel — 且 hint 说的是**修订后的**文法：参数仍在（n= / roles= / task=），位置角色名那一段（[role…]）已随 §10.2.8.2 废除，hint 里不得再有「位置参数写角色名」", cmdEnv.commands.command("team_session").input.hint.includes("n=") && cmdEnv.commands.command("team_session").input.hint.includes("roles=") && cmdEnv.commands.command("team_session").input.hint.includes("task=") && cmdEnv.commands.command("team_session").input.hint.includes("正文") && !cmdEnv.commands.command("team_session").input.hint.includes("位置参数") && !cmdEnv.commands.command("team_session").input.hint.includes("位置角色") && !cmdEnv.commands.command("team_session").input.hint.includes("[role…]") && cmdEnv.commands.command("team_session").input.attachments === false);
check("U16: registration leaves one info line (the optional seam attached on the fast path)", cmdEnv.log.lines.info.some((line) => line.includes("/team_session registered through the optional commands service")));
check("U16 红线: the module-level inject array is still the four original entries — commands did NOT grow it", JSON.stringify((await import("./lib/index.js")).inject) === JSON.stringify(["sessionReferenceResolver", "tools", "sessionQuery", "agents"]));

// --- the degradation path: no commands service at all -------------------------
const noCmdEnv = teamSessionEnv({ omitCommands: true });
check("U16 降级: with no commands service the plugin still loads, leaves exactly one warn, and the command is absent", noCmdEnv.log.lines.warn.filter((line) => line.includes("commands service unavailable at activation")).length === 1 && noCmdEnv.commands.definitions.length === 0 && noCmdEnv.commands.command("team_session") === undefined);
check("U16 降级: ... and the rest of the tool surface is untouched (all eight tools registered)", ["team_link_list_sessions", "team_link_export", "team_link_send", "team_link_watch", "team_link_roster", "team_link_team_read", "team_link_team_append", "team_link_rotate"].every((toolName) => noCmdEnv.tool(toolName) !== undefined));
// The late-provider story: the injection is the retry, and it registers once the
// service appears (no second warn for the window that then resolved).
const lateCmdEnv = teamSessionEnv({ lateCommands: true });
check("U16 降级: a late commands provider is picked up by the ordered injection (the command appears, no extra warn for the resolved window)", lateCmdEnv.commands.definitions.length === 0 && lateCmdEnv.log.lines.warn.filter((line) => line.includes("commands service unavailable")).length === 1);
await lateCmdEnv.provideCommands();
check("U16 降级: ... and BOTH commands of the shared seam register exactly once when it arrives (§11.2 的 /team_rotate 与 /team_session 走同一个可选 seam，各自注册一次)", lateCmdEnv.commands.command("team_session") !== undefined && lateCmdEnv.commands.command("team_rotate") !== undefined && lateCmdEnv.commands.definitions.length === 2);

// --- U16b: parsing — the grammar the hint advertises -------------------------
const { readTeamSessionCommand, teamSessionPlan, teamSessionDialogText, teamSessionId, withTeamSessionPairs } = __testing;
const parsedFull = readTeamSessionCommand("n=2 team=night-shift roles=worker-a,worker-b task=做接口 model=deepseek/deepseek-v4 preset=coder");
check("U16 解析: the full form parses into its parts (n / team / roles / task / model split into provider+model / preset)", parsedFull.error === undefined && parsedFull.value.n === 2 && parsedFull.value.team === "night-shift" && parsedFull.value.roles.join(",") === "worker-a,worker-b" && parsedFull.value.task === "做接口" && parsedFull.value.provider === "deepseek" && parsedFull.value.model === "deepseek-v4" && parsedFull.value.preset === "coder");
const parsedBare = readTeamSessionCommand("night-shift worker-a worker-b");
check("U16 解析: **裸 token 归正文**（R1(a) 的静默结束）—— `night-shift worker-a worker-b` 三个 token 全部进 task，roles 仍然是 undefined（角色只能由 roles= 声明，位置角色名已废除 §10.2.8.2）；废除后的 `bare` 桶恒空，是「不可能再落进去」的可检不变量，不是被遗忘的字段", parsedBare.error === undefined && parsedBare.value.roles === undefined && parsedBare.value.team === undefined && parsedBare.value.n === undefined && parsedBare.value.task === "night-shift worker-a worker-b" && parsedBare.value.bare.length === 0 && readTeamSessionCommand("team=t task=统一任务").value.task === "统一任务");
// §10.2.8.2 的两条读法（原先的注释还在讲废除前的语义，必须同批改掉，否则文档与实现
// 互相矛盾）：① **裸 token 是正文的起点**，不再是角色名（旧读法把一具正文里的 284 个裸 token
// 变成 284 个角色，再以「会话个数 284 超过硬顶 8」失败 —— §10.2.8.1 的第二个雷）；② `task=`
// 的取值是**到行尾**（或到下一个已知 key=）的多 token 文本，不再按空格切成一个 token。
check("U16 解析: 参数区只在**行首**且谓词闭合 —— `team=t worker-a worker-b` 里 team 是参数、其后**全部**是正文（正文 = 启动任务，与 task= 同一个槽），roles 仍是 undefined", (() => { const parsed = readTeamSessionCommand("team=t worker-a worker-b"); return parsed.error === undefined && parsed.roles === undefined && parsed.value.team === "t" && parsed.value.task === "worker-a worker-b" && parsed.value.bare.length === 0; })());
check("U16 解析: `task=` runs to the END OF THE LINE, so an unquoted multi-word task is not truncated (pre-fix: task=「fix」 and the words `the`/`bug` landed in the ignored bare bucket)", (() => { const parsed = readTeamSessionCommand("team=t roles=a task=fix the bug"); return parsed.error === undefined && parsed.value.task === "fix the bug" && parsed.value.bare.length === 0; })());
check("U16 解析: a quoted task value is unwrapped — `task=\"fix the bug\"` carries no quote characters (pre-fix: the value kept both quotes)", (() => { const parsed = readTeamSessionCommand("team=t roles=a task=\"fix the bug\""); return parsed.error === undefined && parsed.value.task === "fix the bug" && !parsed.value.task.includes("\""); })());
check("U16 解析: the unwrapping covers every key — `team=\"t\" roles=\"a,b\"` reads like the unquoted form (pre-fix: both values kept their quotes, and roles split to `\"a`/`b\"`)", (() => { const parsed = readTeamSessionCommand("team=\"t\" roles=\"a,b\""); return parsed.error === undefined && parsed.value.team === "t" && parsed.value.roles.join(",") === "a,b"; })());
check("U16 解析: a half-quoted value is REFUSED, never guessed at (task= both sides of the closing quote)", readTeamSessionCommand("team=t roles=a task=\"a\"b").error.includes("引号不成对"));
check("U16 解析: 只有正文时 team= 在**计划阶段**仍然缺失（缺省值是调用会话工作区目录名，由 handler 解析——解析器是纯函数、没有会话）⇒ 以「需要 team（团队名）」拒绝，而不是把正文的第一个词悄悄当成团队名", (() => { const parsed = readTeamSessionCommand("worker-a worker-b"); const planned = teamSessionPlan(parsed.value, []); return parsed.error === undefined && parsed.value.roles === undefined && parsed.value.task === "worker-a worker-b" && planned.error.includes("需要 team（团队名）"); })());
check("U16 解析: `key=` with nothing after it is refused per key (the value may not be empty)", readTeamSessionCommand("team=t task=").error.includes("task= 后面缺少取值") && readTeamSessionCommand("team=t roles= task=x").error.includes("roles= 后面缺少取值"));
const parsedAliases = readTeamSessionCommand("count=2 team=t role=a,b");
check("U16 解析: count=/role= are accepted aliases of n=/roles= (a human types either)", parsedAliases.error === undefined && parsedAliases.value.n === 2 && parsedAliases.value.roles.join(",") === "a,b");
const parsedBareModel = readTeamSessionCommand("team=t n=1 roles=a model=deepseek-v4");
check("U16 解析: a bare model= stays a model id with no provider", parsedBareModel.error === undefined && parsedBareModel.value.model === "deepseek-v4" && parsedBareModel.value.provider === undefined);
check("U16 解析: an unknown key refuses the whole command with its own message", readTeamSessionCommand("team=t n=1 roles=a bogus=1").error.includes("未知参数 bogus="));
check("U16 解析: a duplicated key refuses instead of silently taking the last one", readTeamSessionCommand("team=a team=b n=1").error.includes("重复给了两次"));
check("U16 解析: a malformed model= provider/model split refuses through the plan-level model grammar", readTeamSessionCommand("team=t n=1 roles=a model=a/b/c").value.model === "a/b/c" && readTeamSessionCommand("team=t n=1 roles=a model=deepseek/v4").value.provider === "deepseek");

// --- U16c: the two code constants (§10.2.4) ----------------------------------
const overN = readTeamSessionCommand("team=night-shift n=9 roles=w1,w2,w3,w4,w5,w6,w7,w8,w9");
check("U16 上限: the parser accepts the syntax and the PLAN refuses N > 8 with the constant named", overN.error === undefined && teamSessionPlan(overN.value, []).error.includes("超过命令硬顶 N ≤ 8"));
check("U16 上限: N = 8 is admitted (the constant is a ceiling, not an off-by-one)", teamSessionPlan(readTeamSessionCommand("team=night-shift n=8 roles=w1,w2,w3,w4,w5,w6,w7,w8").value, []).error === undefined);
check("U16 上限: neither bound lives in the settings schema — they are code constants (the namespace declares no such key)", (() => { const declared = JSON.stringify(cmdEnv.settings.namespaces.get("team-link").base ?? {}); return !declared.includes("maxCreates") && !declared.includes("maxMembers") && !declared.includes("n_max"); })());
const overMembers = teamSessionPlan(readTeamSessionCommand("team=night-shift n=2 roles=w24,w25").value, Array.from({ length: 23 }, (_, index) => `w${index + 1}`));
check("U16 上限: the plan refuses a batch that would carry the team past 24 members, naming both counts", overMembers.error !== undefined && overMembers.error.includes("超过每队成员上限 24") && overMembers.error.includes("已登记角色 23 个"));
const atMembers = teamSessionPlan(readTeamSessionCommand("team=night-shift n=1 roles=w24").value, Array.from({ length: 23 }, (_, index) => `w${index + 1}`));
check("U16 上限: landing exactly on 24 members is admitted (the ceiling is inclusive)", atMembers.error === undefined && atMembers.value.members === 24);
check("U16 上限: a role the team has already seated is SKIPPED (按 role 幂等) and does not create a second session", (() => { const plan = teamSessionPlan(readTeamSessionCommand("team=night-shift roles=worker-a,worker-b").value, ["worker-a"]).value; return plan.skipped.join(",") === "worker-a" && plan.creating.join(",") === "worker-b" && plan.sessions[0].sessionId === undefined && plan.sessions[1].sessionId.startsWith("team-link-night-shift-worker-b-"); })());
check("U16 上限: the same role twice in one command refuses (the session ids would collide)", teamSessionPlan(readTeamSessionCommand("team=night-shift roles=a,a").value, []).error.includes("重复出现"));

// --- U16d: the session id grammar (§10.2.2) ----------------------------------
check("U16 会话 id: team-link-<team>-<role>-<uuid8>, with every code point outside the id alphabet dropped", teamSessionId("night-shift", "worker-a", () => "a1b2c3d4-e5f6-7890-abcd-ef1234567890") === "team-link-night-shift-worker-a-a1b2c3d4" && teamSessionId("t", "w", () => "zz") === "team-link-t-w-00000000");
check("U16 会话 id: a role carrying a lone surrogate or a path separator cannot leak into the durable id", !/[\uD800-\uDFFF]/u.test(teamSessionId("t", "w\uD83D", () => "01234567-0000")) && teamSessionId("t", "a/b", () => "01234567") === "team-link-t-a-b-01234567");

// --- U16e: the dialog (§10.2.4) — content, and 取消 ⇒ 零创建零 pairs -----------
const cancelledEnv = teamSessionEnv({ askScript: ["取消"] });
const cancelledOut = await cancelledEnv.run("n=2 team=night-shift roles=worker-a,worker-b task=做接口");
const cancelledQuestion = cancelledEnv.uq.requests[0].questions[0];
check("U16 确认框: cancel creates NOTHING and writes NO pairs (零创建零 pairs)", cancelledEnv.creates.length === 0 && cancelledEnv.pairs().length === 0 && cancelledEnv.store().length === 0 && cancelledOut.text.includes("零创建、零 pairs"));
// 2026-09-22 裁定 A 收紧措辞之后，这两条的**判据面一字未撤**，只是换成框里现在真正写着的那些字：
// cwd 的标签由「工作目录（cwd）」收成 `cwd：`（同义 gloss 是字数，不是事实），成本行去掉「（保守）」
// 与「口径」两个虚词 —— 「成本」这件必备披露仍然在场、仍然按支写。
check("U16 确认框: the body carries the counts, the model/preset, the cwd and the cost口径 —— §10.2.8.10 之后这一行是**回合计数口径**（N＋1：N 个新会话 ＋ 1 条调用方回执），不再是「N 个会话 × 至少一个完整回合」", cancelledQuestion.detail.includes("将创建 2 个 worker 根会话") && cancelledQuestion.detail.includes("cwd：") && cancelledQuestion.detail.includes("成本：3 个回合（2 个新会话 ＋ 1 条调用方回执；按各自模型计费）") && cancelledQuestion.detail.includes("- 模型/预设："));
// 信任授予的判据**逐字**点名整句（含协调者 id）—— 收紧删掉的是括号里的解释（「绕过…两道门，§10.2.3
// 预置配对」），留下的仍是「在它存在之前就写出来」这件事本身；强度不降反升（旧断言咬两个子串，
// 这条咬整句）。
check("U16 确认框: ... and the pairing grant is written out BEFORE it exists (信任授予不得默默发生)", cancelledQuestion.detail.includes("信任授予：与主会话 session-self 建立双向免确认 pairs 配对。") && !cancelledQuestion.detail.includes("本会话默认"));
check("U16 确认框: the options are exactly 创建 / 取消, and the question id matches what the handler reads back", cancelledQuestion.options.map((option) => option.label).join(",") === "创建,取消" && cancelledQuestion.id === "team-session-batch");
// No confirmation service at all is fail-closed, like the M4 claim dialog.
const noUqCmdEnv = teamSessionEnv({ omitUserQuestions: true });
const noUqCmdOut = await noUqCmdEnv.run("n=1 team=night-shift roles=worker-a");
check("U16 确认框: with no userQuestions service the batch is fail-closed (zero creates, and it says why)", noUqCmdEnv.creates.length === 0 && noUqCmdOut.text.includes("fail-closed"));
// An out-of-range batch never reaches a dialog at all.
const refusedEnv = teamSessionEnv({ askScript: ["创建"] });
const refusedOut = await refusedEnv.run("n=9 team=night-shift roles=w1,w2,w3,w4,w5,w6,w7,w8,w9");
check("U16 上限: N > 8 is refused before any dialog or create (the refusal never opens a confirmation)", refusedEnv.uq.requests.length === 0 && refusedEnv.creates.length === 0 && refusedOut.kind === "error" && refusedOut.text.includes("N ≤ 8"));

// --- U16f: the pairs helper is the §10.2.3 (i) grant, in the store's own shape -
check("U16 pairs: one record per new worker, two-way with the coordinator, in the canonical pair shape", (() => { const plan = withTeamSessionPairs({ pairs: [{ a: "session-self", b: "session-other", createdAt: 1, provisional: false, expiresAt: 0 }] }, "session-self", ["session-w1", "session-w2"], 42); return plan.added === 2 && plan.pairs.length === 3 && JSON.stringify(plan.pairs[1]) === JSON.stringify({ a: "session-self", b: "session-w1", createdAt: 42, provisional: false, expiresAt: 0 }) && JSON.stringify(plan.pairs[2]) === JSON.stringify({ a: "session-self", b: "session-w2", createdAt: 42, provisional: false, expiresAt: 0 }); })());
const { pairRecordBetween: probePair, teamSessionFor: sessionControllerFor } = __testing;
check("U16 pairs: the live-channel predicate the helper shares with the send path sees the grant (and ignores an expired provisional row)", probePair({ pairs: [{ a: "session-self", b: "session-w1", createdAt: 42, provisional: false, expiresAt: 0 }] }, "session-self", "session-w1") !== null && probePair({ pairs: [{ a: "session-self", b: "session-w1", createdAt: 42, provisional: true, expiresAt: 1 }] }, "session-self", "session-w1", 2) === null);
check("U16 pairs: an existing channel is not duplicated (the same predicate the send path uses)", withTeamSessionPairs({ pairs: [{ a: "session-w1", b: "session-self", createdAt: 7 }] }, "session-self", ["session-w1"], 42).added === 0);
check("U16 pairs: with no worker there is nothing to grant", withTeamSessionPairs({ pairs: [] }, "session-self", [], 42).added === 0);

// ---------------------------------------------------------------------------
// §10.2.8 三条真机缺陷的验收增量（U30 / U31 / U32 / U33 / U34）
// ---------------------------------------------------------------------------
// ① 输入文法（§10.2.8.2 方案 A）→ U30/U31；② 结果可见性（§10.2.8.3 通道 1）→ U32（客户端半，
// 见 client-half.test.mjs）；③ 确认框边界（§10.2.8.4）→ U33；/team_rotate 回归 → U34
// （既有测试面在上文 §11.2 那条，本文件不另抄一份，只在此处点名它是 U34 的守卫）。

/** 这一次运行真正交给壳的那个问题（ask 收到的那一条）。 */
const askedQuestion = (env) => env.uq.requests[0]?.questions?.[0];
/** 码点，不是 UTF-16 单元 —— U33 的两个预算都按码点定义。 */
const codePointsOf = (text) => [...String(text ?? "")].length;
const newlinesOf = (text) => (String(text ?? "").match(/\n/gu) ?? []).length;
const LONG_CWD = "/very/long/path/" + "d".repeat(110);
const U33_LONG_TEAM = "t".repeat(39);
/** §10.2.8.4 (b) 的**标注两档**（具名常量，由 `__testing` 导出）：N=1 时全档 **21** 码点、
 * 最小档 **11** 码点，各另加 1 换行。夹具断言读的就是**实现那两个常量**，不另抄一份文案 ——
 * 旧实现上这两个导出是 `undefined`，所以一律经 `at()` 取用（Y7 纪律：红相不许把套件打成崩溃，
 * 否则 `assertion total` 都不打印，那轮红相就谎报了自己的规模）。 */
const u33CropTiers = Array.isArray(__testing.TEAM_SESSION_DIALOG_CROP_NOTE_TIERS) ? __testing.TEAM_SESSION_DIALOG_CROP_NOTE_TIERS : [];
const u33FullNote = (dropped) => (typeof at(u33CropTiers, 0) === "function" ? u33CropTiers[0](dropped) : `（已省略 ${dropped} 段自述；必备披露一字未少。）`);
const u33MinimalNote = (dropped) => (typeof at(u33CropTiers, 1) === "function" ? u33CropTiers[1](dropped) : `（已省略 ${dropped} 段自述）`);
/** 段落级标注的**形状**：两档模板都以「（已省略」开头、以「）」结尾，且**独占一行**
 * （`TEAM_SESSION_DIALOG_CROP_NOTE_TIERS` / `teamSessionDialogCropNote` 的产物）。裁定 A 之后框里
 * **没有可裁段**（唯一的 `required: false` 段「会话标题」整段移出了框体）⇒ 交付串里本就不该有这形状的
 * 任何一行，U33 (i)/(ii)/(iii) 三条因此都**正面**量这件事。
 *
 * 2026-09-22 偏差修复轮（独立发散审计 DIVERGENCE #5）：这里原是
 * `u33RequiredBodyOf(detail) === detail` / `!u33HasCropNote(detail)` 这一对 —— 右边是从 `detail`
 * **自己算出来**的（剥掉一个当前永不匹配的正则），所以它在**结构上恒真**，却被注释说成防「假绿」的
 * 守卫 —— 那是把「反正没断言」包装成断言。现在改成对**交付串本身**的正面判定：真有一行标注出现，
 * `u33AnnotationLines` 就非空，断言当场变红（本轮变异验证：把标注人为塞回 ⇒ 这三条红）。 */
const u33CropNoteShape = /^（已省略 [^\n]*）$/u;
/** 交付串里**落进标注形状的那些行** —— 空数组 = 框内没有任何段落级标注。 */
const u33AnnotationLines = (detail) => (typeof detail === "string" ? detail.split("\n").filter((line) => u33CropNoteShape.test(line)) : []);

// --- U33 换槽位（§10.2.8.4 修法表第 0 行，首要、结构性）-----------------------
// 壳把 question 渲进**无高度钳制、且在滚动容器之外**的 <header><h2>，而 detail 在
// Mbwy4a_body{overflow-y:auto} **之内**、底栏 flex-shrink:0 也在滚动区外 ⇒ 正文放 question
// 就把底部的「创建 / 取消」挤出卡片（真机 8 次够不着，§10.2.8.0）。所以这两条读的是**槽位**：
// question 必须是一行话，披露正文必须整段在 detail。
const u33Line = "n=2 team=night-shift roles=worker-a,worker-b task=做接口";
const u33Env = teamSessionEnv({ askScript: ["取消"] });
await u33Env.run(u33Line);
const u33Question = askedQuestion(u33Env);
const u33Plan = teamSessionPlan(readTeamSessionCommand(u33Line).value, []).value;
check("U33 换槽位: 确认框的 question 是**一行话** —— 无换行、码点 ≤ 120（壳把它渲进无高度钳制的 header，长文会把底部动作推出视野）"
	+ (typeof u33Question?.question === "string" && newlinesOf(u33Question.question) === 0 && codePointsOf(u33Question.question) <= 120 ? "" : "（实测：" + show({ cp: codePointsOf(u33Question?.question), nl: newlinesOf(u33Question?.question), text: u33Question?.question }) + "）"),
	typeof u33Question?.question === "string" && u33Question.question.includes("确认创建 2 个 worker 会话") && newlinesOf(u33Question.question) === 0 && codePointsOf(u33Question.question) <= 120);
const u33DetailIsBody = typeof teamSessionDialogText === "function" && u33Question?.detail === teamSessionDialogText(u33Plan, TEAM_WS, "session-self");
check("U33 换槽位: 披露正文**整段**进了 detail（逐字等于 teamSessionDialogText 的产物，≤600 码点且 ≤12 换行 —— 两个预算都是断言）"
	+ (u33DetailIsBody && codePointsOf(u33Question.detail) <= 600 && newlinesOf(u33Question.detail) <= 12 ? "" : "（实测：" + show({ cp: codePointsOf(u33Question?.detail), nl: newlinesOf(u33Question?.detail) }) + "）"),
	u33DetailIsBody && codePointsOf(u33Question.detail) <= 600 && newlinesOf(u33Question.detail) <= 12 && u33Question.detail.startsWith("将创建 2 个 worker 根会话并登记进团队 night-shift（id 形状 ") && u33Question.detail.includes("）：worker-a；worker-b。"));
check("U33 换槽位: options 一字未动（换槽位只搬正文，不碰「创建 / 取消」这对授权面）", u33Question.options.map((option) => option.label).join(",") === "创建,取消" && u33Question.id === "team-session-batch" && u33Question.header === "批量建队确认");

// --- U33 有界呈现（§10.2.8.4 (a) / (b)）-------------------------------------
// 长正文：截断**必须标注**（本仓既有规矩：U13/U14 的 targetsTruncated），并写明完整正文仍会
// 原样投递 —— 否则「任务被截了」是被读出来的，而不是被写出来的。
const u33LongTask = "x".repeat(3000);
const u33LongEnv = teamSessionEnv({ askScript: ["取消"] });
await u33LongEnv.run("n=8 team=night-shift roles=w1,w2,w3,w4,w5,w6,w7,w8 task=" + u33LongTask);
const u33Long = askedQuestion(u33LongEnv);
check("U33 截断标注: 正文被截时写明「共 N 字 / 仅显示前 M 字 / 完整正文会原样投递」（三个数都读得出来），且两个预算不破", u33Long?.detail.includes("共 " + u33LongTask.length + " 字") && u33Long.detail.includes("此处仅显示前 " + __testing.TEAM_SESSION_DIALOG_TASK_CHARS + " 字") && u33Long.detail.includes("完整正文会原样作为启动任务投递") && codePointsOf(u33Long.detail) <= 600 && newlinesOf(u33Long.detail) <= 12 && newlinesOf(u33Long.question) === 0 && codePointsOf(u33Long.question) <= 120);
check("U33 不逐角色展开: 8 个角色只列前 3 个 + 「…等 8 个」，而**总数 8** 仍在正文里（有界呈现，沿用 U13/U14 约定）", u33Long?.detail.includes("共 8 个") && u33Long.detail.includes("仅列前 3 个") && u33Long.detail.includes("…等 8 个") && !u33Long.detail.includes("w5；") && (u33Long.detail.match(/w[1-4]；/gu) ?? []).length === 3);
// §10.2.8.4 (b) 的**前半句**：「只给 **id 形状 ＋ 计数**，全量清单进完成回报」。2026-09-22 的只读审计
// 指出：修法表第 0 行换槽位时把旧实现里那行 `- 会话 id：team-link-<team>-<role>-<uuid8>`
// （`teamSessionIdPrefix()`，见 `git show ee7c48a^:lib/index.js`）**整条删掉**了，于是「id 形状」在框里一处不剩。
// 这条把它钉回来，同时钉住**后半句**：形状是**常量**（全批共用同一个 id 根），逐个会话的 id 清单不进框（那是完成回报的活）。
check("U33 id 形状在场（§10.2.8.4 (b)「只给 id 形状 ＋ 计数」）: 正文里给出 id 的形状 team-link-<team>-<role>-<uuid8> 与本次**总数**，而**不逐个会话展开 id**（全量清单留给完成回报）"
	+ (typeof u33Long?.detail === "string" && u33Long.detail.includes("team-link-<team>-<role>-<uuid8>") && u33Long.detail.includes("共 8 个") && !/team-link-night-shift-w\d/u.test(u33Long.detail) ? "" : "（实测：" + show({ hasShape: typeof u33Long?.detail === "string" && u33Long.detail.includes("team-link-<team>-<role>-<uuid8>"), counts: typeof u33Long?.detail === "string" && u33Long.detail.includes("共 8 个"), idListed: typeof u33Long?.detail === "string" && /team-link-night-shift-w\d/u.test(u33Long.detail) }) + "）"),
	typeof u33Long?.detail === "string" && u33Long.detail.includes("team-link-<team>-<role>-<uuid8>") && u33Long.detail.includes("共 8 个") && !/team-link-night-shift-w\d/u.test(u33Long.detail));

// 长 cwd / 长团队名：可变字段仍可能顶破，所以**逐字段封顶**是必需品，不是防御性代码。这两条读的是
// **字段级**裁剪留下的省略号（`dialogField` 的「…」＝「截断必须标注」这条本仓既有规矩，与 U13/U14
// 同源）。**`team` 封顶由 20 提到 32**（2026-09-22 裁定：带日期的默认团队名 29 码点必须完整显示，
// 见设计档 §10.2.8.9 ①）—— `dialogField` 的封顶**含省略号**（`slice(0, limit - 1) + "…"`），
// 所以 39 字的团队名截成 **31 字 ＋ 「…」＝ 32 码点**，下面这条按**新封顶**逐字量。
// 2026-09-22 裁定 A 之后框里没有可裁的**段**（唯一的自述段整段移出了框体）⇒ 这两条不再断言
// 「段落级标注在场」（那件事现在由**没有标注**这件事实承载，见本节末的 U33c 组），字段级封顶的
// 判据面一字未撤。
const u33CwdEnv = teamSessionEnv({ askScript: ["取消"], selfCwd: LONG_CWD });
await u33CwdEnv.run("n=2 team=night-shift roles=worker-a,worker-b");
const u33Cwd = askedQuestion(u33CwdEnv);
check("U33 长 cwd 字段封顶: cwd 字段被截就留下省略号（字段级裁剪是**标注过的**，不是静默丢字），且两个预算仍不破"
	+ (codePointsOf(u33Cwd?.detail) <= 600 && newlinesOf(u33Cwd?.detail) <= 12 ? "" : "（实测：" + show({ cp: codePointsOf(u33Cwd?.detail), nl: newlinesOf(u33Cwd?.detail) }) + "）"),
	u33Cwd?.detail.includes("cwd：") && u33Cwd.detail.includes("…") && !u33Cwd.detail.includes("d".repeat(40)) && codePointsOf(u33Cwd.detail) <= 600 && newlinesOf(u33Cwd.detail) <= 12 && newlinesOf(u33Cwd.question) === 0 && codePointsOf(u33Cwd.question) <= 120);
const u33TeamEnv = teamSessionEnv({ askScript: ["取消"] });
await u33TeamEnv.run("n=2 team=" + U33_LONG_TEAM + " roles=worker-a,worker-b");
const u33Team = askedQuestion(u33TeamEnv);
// 2026-09-22 会诊 #68 批（U33 口径定档）**＋ 同日裁定 A**：旧文案「已裁剪至 600 码点 / 12 行上限」
// 在交付串恰好超线时**自证矛盾**，两档新文案都不再写它；而裁定 A 移走了框里唯一的可裁段 ⇒ 现在
// **任何**交付串都不带段落级标注。本条按**现在真正的交付形状**写：团队名照旧被封顶（省略号在场）、
// 两个预算照旧都断言、不含那句自证矛盾的话，且**没有**段落级标注（正面断言：标注形状的行数为 0 ——
// 那正是「没有可裁段」的直接后果；偏差修复轮把这条从「绕一层判是否有标注」改成直读交付串本身，
// 理由见 u33AnnotationLines 的注释）。
check("U33 长团队名字段封顶: 39 字的团队名被截且留下省略号，两个预算不破，且交付串里没有段落级标注（裁定 A 之后没有可裁的段）也不含那句自证矛盾的「已裁剪至 …」"
	+ (typeof u33Team?.detail === "string" && u33AnnotationLines(u33Team.detail).length === 0 && !u33Team.detail.includes("已裁剪至") && codePointsOf(u33Team.detail) <= 600 && newlinesOf(u33Team.detail) <= 12 ? "" : "（实测：" + show({ cp: codePointsOf(u33Team?.detail), nl: newlinesOf(u33Team?.detail), annotationLines: u33AnnotationLines(u33Team?.detail), contradictory: typeof u33Team?.detail === "string" && u33Team.detail.includes("已裁剪至") }) + "）"),
	(() => {
		const detail = u33Team?.detail;
		const ok = typeof detail === "string" && detail.includes("t".repeat(31) + "…") && !detail.includes("t".repeat(32)) && u33AnnotationLines(detail).length === 0 && !detail.includes("已裁剪至") && codePointsOf(detail) <= 600 && newlinesOf(detail) <= 12 && codePointsOf(u33Team?.question) <= 120 && newlinesOf(u33Team?.question) === 0;
		return ok || (console.log(`     实测读数 ${show({ teamLine: typeof detail === "string" ? (detail.split("\n").find((line) => line.includes("登记进团队")) ?? "") : null, tRuns: typeof detail === "string" ? (detail.match(/t{2,}/gu) ?? []).map((run) => run.length) : null })}`), false);
	})());
// §10.2.8.4 (b) 的逐字段封顶必须覆盖**用户可任意长的取值**：`model=` / `provider=` 由命令行给出，
// 解析器只定形状（`TEAM_SESSION_MODEL_RE`）不定长度 ⇒ 修前它们**原样内插**进模型行，单这一句
// 就能顶破 600 码点（而 per-field caps 存在的理由正是「**常规与已验证的极端**装得下」—— 不是
// 「任意输入都装得下」：最极端组合下必备块本身就超 600，见 U33 (iii) 与设计档 §10.2.8.4 残余行）。
// 这条用 300 字的 `model=` 直接量它：封顶后模型行带省略号，两个预算仍不破。
const u33ModelEnv = teamSessionEnv({ askScript: ["取消"] });
await u33ModelEnv.run("n=2 team=night-shift roles=worker-a,worker-b task=做接口 model=" + "m".repeat(300));
const u33Model = askedQuestion(u33ModelEnv);
check("U33 长 model= 封顶: 300 字的 model= 取值被逐字段封顶（省略号可辨，不许原样内插），detail 两个预算仍不破，question 仍单行 ≤120 码点"
	+ (u33Model?.detail?.includes("model=" + "m".repeat(39) + "…") === true && codePointsOf(u33Model?.detail) <= 600 && newlinesOf(u33Model?.detail) <= 12 ? "" : "（实测：" + show({ cp: codePointsOf(u33Model?.detail), nl: newlinesOf(u33Model?.detail), modelLine: typeof u33Model?.detail === "string" ? u33Model.detail.split("\n").find((line) => line.startsWith("- 模型/预设：")) : undefined }) + "）"),
	codePointsOf(u33Model?.question) <= 120 && newlinesOf(u33Model?.question) === 0 && typeof u33Model?.detail === "string" && u33Model.detail.includes("model=" + "m".repeat(39) + "…") && !u33Model.detail.includes("m".repeat(60)) && codePointsOf(u33Model.detail) <= 600 && newlinesOf(u33Model.detail) <= 12);
// §10.2.8.4 (b) 的 per-field 上限清单里 `preset=` **有它自己的一格（24，与 provider 同级）**，
// 不再复用角色的 8 码点（2026-09-22 第 2 轮评审 🔵#3：常见 preset id 会被截成认不出，而这一行是
// §10.2.4 的**必备披露**）。写法与上面长 `model=` 那条同构：60 字取值 ⇒ 封顶后带省略号、不许原样内插，
// 两个预算仍不破；「不再复用 8」由**封顶到 24**（23 字 + 省略号）这个读数直接量出来。
const u33PresetEnv = teamSessionEnv({ askScript: ["取消"] });
await u33PresetEnv.run("n=2 team=night-shift roles=worker-a,worker-b task=做接口 preset=" + "p".repeat(60));
const u33Preset = askedQuestion(u33PresetEnv);
check("U33 长 preset= 封顶（自有上限 24，与 provider 同级）: 60 字的 preset= 取值被逐字段封顶（省略号可辨，**不再复用角色的 8 码点**），detail 两个预算仍不破，question 仍单行 ≤120 码点"
	+ (u33Preset?.detail?.includes("preset=" + "p".repeat(23) + "…") === true && codePointsOf(u33Preset?.detail) <= 600 && newlinesOf(u33Preset?.detail) <= 12 ? "" : "（实测：" + show({ cp: codePointsOf(u33Preset?.detail), nl: newlinesOf(u33Preset?.detail), presetLine: typeof u33Preset?.detail === "string" ? u33Preset.detail.split("\n").find((line) => line.startsWith("- 模型/预设：")) : undefined }) + "）"),
	codePointsOf(u33Preset?.question) <= 120 && newlinesOf(u33Preset?.question) === 0 && typeof u33Preset?.detail === "string" && u33Preset.detail.includes("preset=" + "p".repeat(23) + "…") && !u33Preset.detail.includes("p".repeat(30)) && codePointsOf(u33Preset.detail) <= 600 && newlinesOf(u33Preset.detail) <= 12);
const u33BothEnv = teamSessionEnv({ askScript: ["取消"], selfCwd: LONG_CWD });
await u33BothEnv.run("n=8 team=" + U33_LONG_TEAM + " roles=w1,w2,w3,w4,w5,w6,w7,w8 task=" + "y".repeat(500));
const u33Both = askedQuestion(u33BothEnv);
check("U33 两者都长（团队名 + cwd + 8 会话 + 长正文）: 两个预算仍然不破，交付串里没有段落级标注（可裁段已整段移出）也不含那句自证矛盾的「已裁剪至 …」"
	+ (codePointsOf(u33Both?.detail) <= 600 && newlinesOf(u33Both?.detail) <= 12 && u33AnnotationLines(u33Both?.detail).length === 0 ? "" : "（实测：" + show({ cp: codePointsOf(u33Both?.detail), nl: newlinesOf(u33Both?.detail), annotationLines: u33AnnotationLines(u33Both?.detail) }) + "）"),
	typeof u33Both?.detail === "string" && codePointsOf(u33Both.detail) <= 600 && newlinesOf(u33Both.detail) <= 12 && newlinesOf(u33Both.question) === 0 && codePointsOf(u33Both.question) <= 120 && u33AnnotationLines(u33Both.detail).length === 0 && !u33Both.detail.includes("已裁剪至"));

// 必备披露与「压缩只压自述段」：**逐件点名**（新的断言 ①）。判据不是「正文里有没有东西」，而是
// §10.2.4 的必备五件（数量 / 模型 / cwd / 成本 / 信任授予）＋ §10.2.8.7 的角色指引 ＋ 确认则（创建 /
// 取消**两支**）＋ §10.2.8.4 (b) 的角色与 id 形状 ＋ 启动任务预览（含「共 N 字」标注）**九件各在哪一行
// 上都在场** —— 逐件带标签，缺哪件就点名哪件。裁定 A 只收紧措辞，一件不动、一件不少。
const u33Required = [
	["数量", "将创建 8 个 worker 根会话并登记进团队"],
	["模型", "- 模型/预设："],
	["cwd", "cwd："],
	// 2026-09-22 偏差修复轮：这条**逐字**点名成本口径 —— 有任务支那句的「按各自模型计费」曾被漏删，
	// 现在放回，所以这里的 token 也**逐字**含它（缺这半句 ⇒ 这一件当场点名变红）。
	// §10.2.8.10 ① 之后这一行改成**回合计数口径**：N＋1（N 个新会话 ＋ 1 条调用方回执），
	// 「按各自模型计费」逐字保留。
	["成本", "成本：9 个回合（8 个新会话 ＋ 1 条调用方回执；按各自模型计费）"],
	["信任授予", "信任授予：与主会话 session-self 建立双向免确认 pairs 配对"],
	["角色指引", __testing.TEAM_SESSION_ROLE_GUIDANCE],
	["确认则（两支）", "确认则：创建 → 投递启动任务 → 登记 roster 与 pairs；取消则零创建、零 pairs。"],
	["角色与 id 形状", "team-link-<team>-<role>-<uuid8>"],
	["id 计数", "共 8 个"],
	["启动任务预览（含「共 N 字」）", "- 启动任务：共 500 字"],
];
/** 缺哪几件（返回**标签**，失败信息里逐件点名）。空数组 = 九件全在。 */
const u33MissingRequired = (detail) => u33Required.filter(([, token]) => !(typeof detail === "string" && detail.includes(token))).map(([label]) => label);
check("U33 必备披露逐件点名（数量 / 模型 / cwd / 成本 / 信任授予 / 角色指引 / 确认则两支 / 角色与 id 形状 / 启动任务预览）：预算最紧的用例（长团队名 + 长 cwd + 8 会话 + 长正文）里九件全在场"
	+ (u33MissingRequired(u33Both?.detail).length === 0 ? "" : "（缺：" + show(u33MissingRequired(u33Both?.detail)) + "）"),
	u33MissingRequired(u33Both?.detail).length === 0);

// --- 本批新可测面的**受守卫读取**（Y7 纪律：先取值，再判类型）------------------------------
// 本仓的 Y7 纪律写在这一条上：**一个还没实现的可测面被直接调用，会让整跑崩在那一行、连
// `assertion total` 都不打印** —— 那样红相就说不清自己有多大（本批真踩过一次：新测试在旧实现上
// 崩在 `receiptTexts(env)[0].includes(...)`，见 docs/verification-log.md 的「红相」一节）。
// 所以本批所有**新增**的可测面都在这里统一取一次：旧实现上它们是 `undefined`，取值退化成中性量，
// 断言**自己变红**而不是把套件打崩。
/** FAIL 时必须看得见读数（本文件既有惯例：红相要说清自己有多大、错在哪一格）。**声明位置在这一块**
 * 而不是靠近用它的那几组夹具：`probe` 只在**条件为假**时才被求值 ⇒ 在旧实现上它会在**很靠前**的
 * 通道 4 那几条里第一次被走到，声明放在后面就是 TDZ 崩（本批第二次踩同类坑，见 verification-log）。 */
/** §10.2.8.9 ① 的注入缝**成对使用**（评审 round-1 🔵#7）：注入 → 跑 → **finally 还原**。
 * 不这么做的话，一条断言在注入窗口内抛错，注入会泄漏到后面所有夹具（整轮墙钟被钉死，红相还会骗人）。 */
const withInjectedNow = async (now, fn) => {
	const seam = typeof __testing.teamSessionInjectNow === "function" ? __testing.teamSessionInjectNow : undefined;
	if (seam === undefined) return fn();
	seam(now);
	try { return await fn(); } finally { seam(undefined); }
};
const probe = (label, reading) => { console.log(`     实测读数 ${label} ${show(reading)}`); return false; };
const RELEASE_NOTES = __testing.TEAM_SESSION_RELEASE_NOTES ?? {};
const RELEASE_DISCLOSURE = __testing.TEAM_SESSION_RELEASE_DISCLOSURE ?? "";
const RECEIPT_MAX = typeof __testing.TEAM_SESSION_RECEIPT_MAX_POINTS === "number" ? __testing.TEAM_SESSION_RECEIPT_MAX_POINTS : 0;
const ROLE_RECORD = typeof __testing.roleRecord === "function" ? __testing.roleRecord : (fields) => ({ ...fields });
const NORMALIZE_TEAMS = typeof __testing.normalizeTeams === "function" ? __testing.normalizeTeams : (list) => (Array.isArray(list) ? list : []);

// --- U33c 裁定 A 的硬指标：参照夹具 ≤ 6 行且 ≤ **390** 码点（2026-09-22 用户裁定 = A）---------------
// 真机读数（用户实测）：同一个输入 `detail` 收前 **569 码点 / 10 行**（截图那次协调者 id 取满 28 码点
// ⇒ 585），用户判「有点大，文字也太多了，导致选项被积压」⇒ 裁定 A：压掉解释性括号与 § 号、把
// 「会话标题」自述段整段移出框体。判据就是这两条上界，外加「必备五件一件不少」（上一条逐件点名）与
// 「标题读数在完成回报里」（DEFECT-4 ② 那一条）。
// **判据的数字沿革（每一档都有来由，不是随手改）**：≤350（只对 12 码点参照成立）→ **380**（2026-09-22
// 偏差修复轮，审计 DIVERGENCE #3 / #4：把成本行里**被漏删**的「按各自模型计费」放回，+8 码点，换一条
// 必备事实的回归）→ **390**（设计档 §10.2.8.4 的 U33c 行定档值；**本批之前测试里写的是 380，比设计档
// 更严** —— 这次改回 390 不是放宽判据，是让测试与它声称跟随的设计档对齐，并把**每个读数**写下来）。
// **本批读数（§10.2.8.10 的成本行改写之后，逐具实测）**：12 码点 id 参照 **355** · 28 码点 id 参照
// **371** · 释放并认领变体（12 码点 id，短团队名）**348** · 释放变体（28 码点 id ＋ 带日期团队名）
// **382** ≤ 390（余量仅 8 —— 所以成本行只能**缩短**：见 `teamSessionDialogText` 的「一次经申报的改写」）。
// 封顶 20 ⇒ 32（带日期默认名 29 码点须完整显示）这一档的历史读数是 362 / 378（旧成本行）。
// **夹具**：输入 `/team_session 你是新的主管会话` ＋ **12 码点**协调者 id（`session-self`，下面钉住）
// ＋ 工作区目录名 `dsh-session-link-pro`（真机 cwd 与它同长 —— cwd 字段封顶 24 码点，**长度**逐字相同，
// 只是可见前缀不同；这里用仓内临时目录，避免把仓外的绝对路径写进测试）。
/** U33c 的码点上界：设计档 §10.2.8.4 的 U33c 行定档 **390**（判据沿革与逐具读数见上）。 */
const U33C_MAX_POINTS = 390;
const U33C_WS = path.join(TEAM_TMP, "dsh-session-link-pro");
const u33cEnv = teamSessionEnv({ askScript: ["取消"], selfCwd: U33C_WS });
// §10.2.8.9 ①：默认名 = `<basename>-YYYYMMDD` ⇒ 这具**注入「当天」**（与 U35 同一条缝、同一纪律：
// 不靠墙钟），期望逐字就是带日期的默认名。U33c 在 U35 的注入助手之前声明，所以这里直接经守卫取缝。
const U33C_DAY = new Date(2026, 8, 22, 12, 0, 0, 0).getTime();
const U33C_DEFAULT_TEAM = "dsh-session-link-pro-20260922";
const u33cOut = await withInjectedNow(U33C_DAY, () => u33cEnv.run("你是新的主管会话"));
const u33c = askedQuestion(u33cEnv);
const u33cCp = codePointsOf(u33c?.detail);
const u33cLines = newlinesOf(u33c?.detail) + 1;
const u33cOk = codePointsOf(u33cEnv.senderAgent.id) === 12 && typeof u33c?.detail === "string" && u33cCp <= U33C_MAX_POINTS && newlinesOf(u33c.detail) <= 5
	&& u33c.detail.startsWith("将创建 1 个 worker 根会话并登记进团队 " + U33C_DEFAULT_TEAM) && u33c.detail.includes("）：worker-1。")
	&& u33c.detail.includes("- 启动任务：共 8 字：你是新的主管会话")
	&& u33c.detail.includes("成本：2 个回合（1 个新会话 ＋ 1 条调用方回执；按各自模型计费）")
	&& newlinesOf(u33c.question) === 0 && codePointsOf(u33c.question) <= 120
	&& u33cOut.text.includes("零创建、零 pairs");
check(`U33c 参照夹具（/team_session 你是新的主管会话 ＋ 12 码点协调者 id）: 交付 detail **≤ 6 行且 ≤ ${U33C_MAX_POINTS} 码点**（设计档 U33c 行定档值；本批之前这里写 380、比设计档更严，已对齐），团队取工作区目录名＋当天日期（§10.2.8.9 ①，注入当天 ⇒ 逐字 ${U33C_DEFAULT_TEAM}，封顶 32 保证它完整显示）、正文仍是那 8 个字、成本口径那半句仍在（实测 ${u33cCp} 码点 / ${u33cLines} 行；改前 569 / 10）`
	+ (u33cOk ? "" : "（实测：" + show({ cp: u33cCp, lines: u33cLines, detail: u33c?.detail, question: u33c?.question, out: u33cOut.text }) + "）"),
	u33cOk);
// 纯函数读数（同一条 `teamSessionDialogText`，不经 handler）：参照 B（**28 码点** id —— 真机那次取满
// 的协调者 id 长度）与**释放并认领**披露变体 E（28 码点 id ＋ 带日期团队名 ＋ 那句披露）。
// **披露句的码点数（评审 round-1 🔵#2）**：设计档 §10.2.8.9 ② 原写「12 码点」，字面量逐字数 = **11**
// ⇒ 判据按字面量钉 11、以 12 为口径上界（标签与注释一并对齐，见设计档勘误行）。
// 走纯函数而不是再造两具 handler 夹具：这一条量的是**交付串的预算**，行为面（谁被释放、披露是否真
// 出现）由下面的 U36/U37 端到端夹具咬住 —— 两面各咬自己那一面，不互相冒充。
const U33C_ID28 = "team-link-night-shift-coo-12";
const u33cPlan = (team) => teamSessionPlan({ ...readTeamSessionCommand("你是新的主管会话").value, team }, []).value;
const u33cB = teamSessionDialogText(u33cPlan(U33C_DEFAULT_TEAM), U33C_WS, U33C_ID28, null);
const u33cE = teamSessionDialogText(u33cPlan(U33C_DEFAULT_TEAM), U33C_WS, U33C_ID28, { reason: "archived", incumbent: "session-dead" });
/** 披露是**折叠**进「确认则」那一行：E 必须逐字等于 B 在 pairs 之后插入披露句（差一个都不是折叠）。 */
const u33cFolded = u33cB.replace("登记 roster 与 pairs；取消则", "登记 roster 与 pairs" + RELEASE_DISCLOSURE + "；取消则");
check("U33c 参照 B（28 码点 id）与释放披露变体 E（28 码点 id ＋ 带日期团队名 ＋ 那句披露）: 两具都 ≤6 行且 ≤390 码点、披露句逐字在场且**恰 11 码点**（设计档原写 12，勘误见 §10.2.8.9 ②）、披露之外的正文与 B 逐字同一（折叠进「确认则」一行，不是新起一段 —— 新起一段会破「≤6 行」）"
	+ (codePointsOf(u33cB) <= U33C_MAX_POINTS && codePointsOf(u33cE) <= U33C_MAX_POINTS && newlinesOf(u33cB) <= 5 && newlinesOf(u33cE) <= 5 && u33cE === u33cFolded ? "" : "（实测：" + show({ id28: codePointsOf(U33C_ID28), cpB: codePointsOf(u33cB), nlB: newlinesOf(u33cB), cpE: codePointsOf(u33cE), nlE: newlinesOf(u33cE), disclosure: codePointsOf(RELEASE_DISCLOSURE), folded: u33cE === u33cFolded }) + "）"),
	codePointsOf(U33C_ID28) === 28 && codePointsOf(u33cB) <= U33C_MAX_POINTS && newlinesOf(u33cB) <= 5 && codePointsOf(u33cE) <= U33C_MAX_POINTS && newlinesOf(u33cE) <= 5 && codePointsOf(RELEASE_DISCLOSURE) === 11 && u33cE.includes(RELEASE_DISCLOSURE) && u33cE === u33cFolded);
// 参照 F/G/H/I（**无任务形态** —— 设计档 §10.2.8.10 🟡#7 明确要求「补一具「无任务形态」的框体读数」；
// 2026-09-22 **真机复验**时才发现这一形态先前根本没有夹具，而真机那次命令恰好落在它上面 ⇒ 实测
// **399 码点 > 390**。修法不是放宽判据，而是压掉同一张框里的**重复文案**（「- 启动任务：」与
// 「确认则」两行的括号都写「未给正文/task=」，−18）⇒ 现在 381 ≤ 390。判据（390 / 6 行）一字未动。）
const u33cNoTaskPlan = teamSessionPlan({ ...readTeamSessionCommand("n=1 roles=b1").value, team: U33C_DEFAULT_TEAM }, []).value;
const u33cNoTask = (id, release) => teamSessionDialogText(u33cNoTaskPlan, U33C_WS, id, release);
/** 真机会话 id 的形状（**44 码点**：session- 前缀 ＋ 36 字符 uuid）—— 设计档当初记的「真机 28 码点」
 * 是错的，而正确性不受影响：id 字段封顶 28 ⇒ 44 与 28 两具**等长**（只是截断的位置不同）。 */
const U33C_ID44 = "session-" + "a".repeat(36);
const u33cF = u33cNoTask("session-self", null);
const u33cG = u33cNoTask(U33C_ID28, null);
const u33cH = u33cNoTask(U33C_ID44, null);
const u33cI = u33cNoTask(U33C_ID44, { reason: "gone", incumbent: "session-rm-ghost-20260922" });
check("U33c 无任务形态（参照 F/G/H/I）: 12 码点 id **354** · 28 码点 id **370** · **真机形状 44 码点 id 也被 id 字段封顶 28 ⇒ 与 28 码点那一具等长**（370）· 同一具 ＋ 释放披露 **381**（真机那一具就是它）⇒ 四具全部 ≤390 码点且 ≤6 行，且披露的边际成本恰好等于那句披露的码点数"
	+ (codePointsOf(u33cI) === codePointsOf(u33cG) + codePointsOf(RELEASE_DISCLOSURE) && codePointsOf(U33C_ID44) === 44 ? "" : probe("U33c 无任务形态", { id44: codePointsOf(U33C_ID44), F: codePointsOf(u33cF), G: codePointsOf(u33cG), H: codePointsOf(u33cH), I: codePointsOf(u33cI), linesI: newlinesOf(u33cI) + 1 })),
	[codePointsOf(u33cF), codePointsOf(u33cG), codePointsOf(u33cH), codePointsOf(u33cI)].every((n) => n <= U33C_MAX_POINTS) && [u33cF, u33cG, u33cH, u33cI].every((text) => newlinesOf(text) <= 5)
	&& codePointsOf(U33C_ID44) === 44 && codePointsOf(u33cH) === codePointsOf(u33cG) && codePointsOf(u33cI) === codePointsOf(u33cG) + codePointsOf(RELEASE_DISCLOSURE)
	&& !u33cH.includes("a".repeat(28)) && u33cH.includes("（未给正文/task=）") && u33cI.includes(RELEASE_DISCLOSURE) && !u33cG.includes(RELEASE_DISCLOSURE));

// 裁定 A 的**删除面**逐条点名（与上一条的「保留面」互为对照）：用户点名的几类废话与整段自述段在框里
// **一处都不剩**，而正文那 8 个字仍逐字在「- 启动任务：」那一行上（「只去废话」而不是「去字」）。
const u33cRemoved = [
	["标题自述段", "- 会话标题："],
	["标题段的解释", "想改随时在壳里重命名"],
	["标题段的解释（工作区名）", "不设标题时它们会全都显示为工作区名"],
	["§ 号（预置配对那条）", "§10.2.3"],
	["解释性括号（两道门）", "绕过发送方审批与接收方 ask 两道门"],
	["解释性括号（保守）", "（保守）"],
	["教学式说明（模型解析）", "未给 model=/provider"],
	["教学式说明（模型解析，后半句）", "两半都解析并带上宿主缺省模型选择"],
	["cwd 的同义 gloss", "工作目录（cwd）"],
	["未截断时重复一遍投递承诺", "完整正文会原样作为启动任务投递：你是新的主管会话"],
];
const u33cStillPresent = u33cRemoved.filter(([, token]) => typeof u33c?.detail === "string" && u33c.detail.includes(token)).map(([label]) => label);
check(`U33c 裁定 A 的删除面逐条点名: 框里不再有标题自述段 / 解释性括号 / § 号 / 教学式说明（逐条列出，剩几条就红）${u33cStillPresent.length === 0 ? "" : `（还在：${show(u33cStillPresent)}）`}`,
	typeof u33c?.detail === "string" && u33cStillPresent.length === 0 && !u33c.detail.includes("会话标题") && !u33c.detail.includes("保守"));

// --- U33 预算与终态交付（§10.2.8.4 (b)）-------------------------------------------------------
// 病灶（**结构式**，不靠某个输入的读数立论）：被弃路径的终态在**装完 body 之后**才贴上标注、
// **不再过 `dialogFits`** ⇒ 交付 = body ＋ 标注，而框里那句还写着「已裁剪至 600 码点 / 12 行上限」——
// **输出物自述与事实相反**。会诊 #68 定档的修法（标注计价 ＋ 两档自适应 ＋ 终态与拟合同构造）在
// 本批**一字未动**（用户裁定：「不许动 600/12、两档标注与终态预算机制、必备块裁剪逻辑」）。
//
// **2026-09-22 裁定 A 之后可裁段为空**：框里唯一的 `required: false` 段（「会话标题」）整段移出 ⇒
// `optional` 恒为空、`dropped` 恒为 0 ⇒ 交付 = 必备 body **逐字**（不裁剪、也不追加标注）。下面三条
// 断言的就是这个新的事实面：两个中间档夹具**逐字交付且仍在 600/12 里**，机制一夹具（必备 body > 600）
// **逐字交付且超额只由不可裁的必备块引起**（设计档 §10.2.8.4 残余行 · 第一机制，本批不做）。
// 两档标注常量仍由**纯函数**判据咬住（它们现在没有取用点，代码与文案原样保留 —— 一旦某段自述回到框里，
// 取用路径立刻恢复）。
check("U33 标注档位（具名常量）: 两档都在、长度按**实际 `dropped` 位数**算 —— N=1 时全档 21 码点 / 最小档 11 码点，N=10 时各 +1，且**两档自己都不含**「已裁剪至 … 码点 / … 行上限」这句在超额交付上自证矛盾的话"
	+ (u33CropTiers.length === 2 && codePointsOf(u33FullNote(1)) === 21 && codePointsOf(u33MinimalNote(1)) === 11 && codePointsOf(u33FullNote(10)) === 22 && codePointsOf(u33MinimalNote(10)) === 12 && !u33CropTiers.some((tier) => typeof tier === "function" && tier(1).includes("已裁剪至")) ? "" : "（实测：" + show({ tiers: u33CropTiers.length, full1: codePointsOf(u33FullNote(1)), minimal1: codePointsOf(u33MinimalNote(1)), full10: codePointsOf(u33FullNote(10)), minimal10: codePointsOf(u33MinimalNote(10)) }) + "）"),
	u33CropTiers.length === 2 && codePointsOf(u33FullNote(1)) === 21 && codePointsOf(u33MinimalNote(1)) === 11 && codePointsOf(u33FullNote(10)) === 22 && codePointsOf(u33MinimalNote(10)) === 12 && !u33CropTiers.some((tier) => typeof tier === "function" && tier(1).includes("已裁剪至")));

// (i) **中间档夹具**（改前 body 582 ⇒ 交付 594，最小档）：裁定 A 压缩之后交付是 **504**（修复轮把
// 「按各自模型计费」放回后 +8），两个预算仍不破。夹具守卫**正面**断言「框内没有段落级标注」—— 那正是
// 「一字未裁」在**没有可裁段**之后的直接后果（不裁剪 ⇒ 也就没有标注行）；**它是可假的**：真有一行标注
// 出现就红（2026-09-22 偏差修复轮的变异验证就是这么做的：把标注人为塞回 ⇒ 这三条红）。
const u33BandLine = "n=8 team=" + U33_LONG_TEAM + " roles=a,b,c,d,e,f,g,h task=" + "z".repeat(200) + " preset=" + "p".repeat(15) + " model=" + "m".repeat(30);
const u33BandEnv = teamSessionEnv({ askScript: ["取消"], selfCwd: LONG_CWD });
await u33BandEnv.run(u33BandLine);
const u33Band = askedQuestion(u33BandEnv);
const u33BandNotes = u33AnnotationLines(u33Band?.detail);
check("U33 (i) 中间档夹具: 交付 `detail` 里**没有**段落级标注（可裁段已整段移出 ⇒ 无可裁段就没有标注行）且 ≤ 600 码点 / ≤ 12 换行，也不含「已裁剪至 …」这类自证矛盾句"
	+ (typeof u33Band?.detail === "string" && codePointsOf(u33Band.detail) <= 600 && newlinesOf(u33Band.detail) <= 12 && u33BandNotes.length === 0 ? "" : "（实测：" + show({ cp: codePointsOf(u33Band?.detail), nl: newlinesOf(u33Band?.detail), annotationLines: u33BandNotes }) + "）"),
	typeof u33Band?.detail === "string" && u33BandNotes.length === 0 && codePointsOf(u33Band.detail) <= 600 && newlinesOf(u33Band.detail) <= 12 && !u33Band.detail.includes("已裁剪至"));

// (ii) **第二具中间档夹具**（改前 body 592 ⇒ 交付 634 ＝ body ＋ 全档标注，超线 34 ✗）：裁定 A 压缩之后
// 交付是 **514**（修复轮 +8），两个预算都不破。这一具与上一具的区别只在 `model=` 的取值长度
// （30 vs 300 码点，都封顶到 40）⇒ 两具一起钉住「可变字段封顶 ＋ 框内没有段落级标注」这条组合。
const u33EdgeLine = "n=8 team=" + U33_LONG_TEAM + " roles=a,b,c,d,e,f,g,h task=" + "z".repeat(200) + " preset=" + "p".repeat(15) + " model=" + "m".repeat(300);
const u33EdgeEnv = teamSessionEnv({ askScript: ["取消"], selfCwd: LONG_CWD });
await u33EdgeEnv.run(u33EdgeLine);
const u33Edge = askedQuestion(u33EdgeEnv);
const u33EdgeNotes = u33AnnotationLines(u33Edge?.detail);
check("U33 (ii) 第二具中间档夹具: 交付 `detail` 里**没有**段落级标注（那一具改前是 body ＋ 标注 = 634 超线 ✗）且 ≤ 600 码点 / ≤ 12 换行、不含「已裁剪至 600 码点」这类自证矛盾的句子"
	+ (typeof u33Edge?.detail === "string" && codePointsOf(u33Edge.detail) <= 600 && newlinesOf(u33Edge.detail) <= 12 && u33EdgeNotes.length === 0 ? "" : "（实测：" + show({ cp: codePointsOf(u33Edge?.detail), nl: newlinesOf(u33Edge?.detail), annotationLines: u33EdgeNotes, contradictory: typeof u33Edge?.detail === "string" && u33Edge.detail.includes("已裁剪至") }) + "）"),
	typeof u33Edge?.detail === "string" && u33EdgeNotes.length === 0 && codePointsOf(u33Edge.detail) <= 600 && newlinesOf(u33Edge.detail) <= 12 && !u33Edge.detail.includes("已裁剪至"));

// (iii) **机制一夹具**：必备 body > 600（改前 693 ⇒ 交付 705；裁定 A 压缩后 **607**，修复轮 +8 ⇒ **615** ——
// 交付仍**逐字**等于必备 body，因为它没有可裁的段）。
// 39 字团队名 ＋ 8 个 8 码点角色名（其中 3 个**已登记**，触发「（已登记，跳过）」后缀）＋ 3000 字正文 ＋
// 300 字 model= ＋ 60 字 preset= ＋ 长 cwd ＋ **取满 28 码点**的协调者 id。必备块**永不裁剪** ⇒ 这一档
// 仍必然超线，而**没有可裁的段**可省 ⇒ 交付就是必备 body 本身（既没有「标注成为第二个破约者」这种事，
// 也没有静默丢字）。这是设计档 §10.2.8.4 残余行「第一机制」的如实读数，不是本批要「修好」的东西。
const U33_MECH1_ROLES = ["aaaaaaaa", "bbbbbbbb", "cccccccc", "dddddddd", "eeeeeeee", "ffffffff", "gggggggg", "hhhhhhhh"];
const U33_MECH1_COORD = "session-" + "c".repeat(20);
const U33_MECH1_SEATED = U33_MECH1_ROLES.slice(0, 3);
/** 取满 28 码点协调者 id 的调用会话：writerGate 只比 id（不比活性），所以这个替身会把
 * `coordinatorId` 与 `cwd` 两处都读成夹具要的值。 */
const u33Mech1Agent = { id: U33_MECH1_COORD, status: "idle", session: { header: { id: U33_MECH1_COORD, cwd: LONG_CWD } }, inject() {}, steer() {}, followup() {} };
const u33Mech1Env = teamSessionEnv({
	askScript: ["取消"],
	selfCwd: LONG_CWD,
	teams: [teamRow({ name: U33_LONG_TEAM, current: U33_MECH1_COORD, roles: [
		{ role: "coordinator", current: U33_MECH1_COORD, pending: null, history: [{ session: U33_MECH1_COORD, from: 1_700_000_000_000, until: null }] },
		...U33_MECH1_SEATED.map((role) => ({ role, current: null, pending: null, history: [] })),
	] })],
});
await u33Mech1Env.run("n=8 team=" + U33_LONG_TEAM + " roles=" + U33_MECH1_ROLES.join(",") + " task=" + "x".repeat(3000) + " preset=" + "p".repeat(60) + " model=" + "m".repeat(300), u33Mech1Agent);
const u33Mech1 = askedQuestion(u33Mech1Env);
const u33Mech1Notes = u33AnnotationLines(u33Mech1?.detail);
check("U33 (iii) 机制一夹具（必备 body > 600）: 必备块永不裁剪 ⇒ 这一档**必然**超线，而交付里**没有**段落级标注（没有可裁的段 ⇒ 不裁剪、也不追加标注 ⇒ 超额只能由不可裁的必备块引起）"
	+ (typeof u33Mech1?.detail === "string" && codePointsOf(u33Mech1.detail) > 600 && u33Mech1Notes.length === 0 ? "" : "（实测：" + show({ cp: codePointsOf(u33Mech1?.detail), nl: newlinesOf(u33Mech1?.detail), annotationLines: u33Mech1Notes }) + "）"),
	typeof u33Mech1?.detail === "string" && codePointsOf(u33Mech1.detail) > 600 && u33Mech1Notes.length === 0 && !u33Mech1.detail.includes("已裁剪至"));
check("U33 (iii) 机制一的成因可读: 该夹具的 8 个角色里 3 个**已登记**（「（已登记，跳过）」后缀）且必登记的必备块一字不少 —— 超额的成因是**必备块自超**，不是标注；这一条把「跳过」后缀与必备披露连带钉住"
	+ (typeof u33Mech1?.detail === "string" && u33Mech1.detail.includes("（已登记，跳过）") && u33Mech1.detail.includes("3 个角色已登记，跳过") && u33Mech1.detail.includes("将创建 5 个 worker 根会话") && u33Mech1.detail.includes("共 8 个") ? "" : "（实测：" + show({ skipped: typeof u33Mech1?.detail === "string" && u33Mech1.detail.includes("3 个角色已登记，跳过"), creating: typeof u33Mech1?.detail === "string" && u33Mech1.detail.includes("将创建 5 个 worker 根会话") }) + "）"),
	typeof u33Mech1?.detail === "string" && u33Mech1.detail.includes("（已登记，跳过）") && u33Mech1.detail.includes("3 个角色已登记，跳过") && u33Mech1.detail.includes("将创建 5 个 worker 根会话") && u33Mech1.detail.includes("共 8 个"));

// --- U30 输入文法与正文送达（§10.2.8.2 方案 A「参数可省」）--------------------
// R1：参数区只在行首；R2：进入正文后任何「字母＋等号」一律当正文（§10.2.8.1 的病灶正是
// 「同窗 N=3）。」被读成 n=3）。）；R3：失败点名并给出路。默认值：team = 调用会话工作区
// 目录名、n = 1、roles 省略 ⇒ 一个 worker-1。
const U30_BODY = "帮我做 X：同窗 N=3）。pid=384448 与 word= 逐字保留；收尾 a b c。";
const u30Parsed = readTeamSessionCommand(U30_BODY);
check("U30 文法: /team_session 后面直接写正文即成立 —— roles 为空、正文整段进 task（这就是方案 A 的核心语义：正文 = 启动任务，与 task= 同一个槽）", u30Parsed.error === undefined && u30Parsed.value.roles === undefined && u30Parsed.value.n === undefined && u30Parsed.value.team === undefined && u30Parsed.value.task === U30_BODY && u30Parsed.value.bare.length === 0);
// §10.2.8.9 ①（U35）：默认名带日期。夹具**注入「当天」**（teamSessionInjectNow 缝 / 显式 now），
// 不靠墙钟；缝在旧实现上不存在 ⇒ 经守卫取用，缺缝时断言自己红、不把套件打崩（Y7 纪律）。
// 注入**一律走** withInjectedNow（见上）：这里不再留一个「手动 inject / 手动还原」的助手 ——
// 那种写法正是评审 round-1 🔵#7 指出的泄漏面。
/** 本地时区某天正午的时间戳 —— 注入用的「当天」。 */
const u35Noon = (year, month, day) => new Date(year, month - 1, day, 12, 0, 0, 0).getTime();
const U35_DAY1 = u35Noon(2026, 9, 22);
const U35_DAY2 = u35Noon(2026, 9, 23);
const U35_STAMP1 = "20260922";
const U35_STAMP2 = "20260923";
const U30_DEFAULT_TEAM = path.basename(TEAM_WS) + "-" + U35_STAMP1;
const u30Env = teamSessionEnv({ askScript: ["创建"] });
const u30Out = await withInjectedNow(U35_DAY1, () => u30Env.run(U30_BODY));
check("U30 默认值: 裸正文那条行建出**恰 1 个** worker-1，team 取调用会话工作区目录名＋当天日期（§10.2.8.9 ①：<basename>-YYYYMMDD，注入的「当天」）、n 省略即 1", u30Out.kind === "success" && u30Env.creates.length === 1 && u30Env.creates[0].sessionId.startsWith("team-link-" + U30_DEFAULT_TEAM + "-worker-1-") && u30Env.store().length === 1 && u30Env.store()[0].name === U30_DEFAULT_TEAM && u30Env.store()[0].roles.map((entry) => entry.role).sort().join(",") === "coordinator,worker-1");
check("U30 默认值: 目录名不合 [a-z0-9-]+ 时回退 default-<日期> —— 用户没有**敲**这个值，所以不为一个目录名拒绝整条命令（而它是 team 缺省值的唯一可能失败处；三支都注入「当天」，不靠墙钟）", typeof __testing.teamSessionDefaultTeam === "function" && __testing.teamSessionDefaultTeam(path.join(TEAM_TMP, "工作 区"), U35_DAY1) === "default-" + U35_STAMP1 && __testing.teamSessionDefaultTeam(TEAM_WS, U35_DAY1) === U30_DEFAULT_TEAM && __testing.teamSessionDefaultTeam("relative/dir", U35_DAY1) === "dir-" + U35_STAMP1);

// --- U35 默认团队名带日期（§10.2.8.9 ①）---------------------------------------
check("U35 格式: team 省略 ⇒ <basename(cwd)>-YYYYMMDD（注入「当天」= 本地时区 2026-09-22 ⇒ 尾巴恰是 20260922），非法目录名 ⇒ default-YYYYMMDD —— 两支的**日期逐字同一**、整串还合团队名字法 [a-z0-9-]+（日期就是当天，不是别的什么）", typeof __testing.teamSessionDefaultTeam === "function" && __testing.teamSessionDefaultTeam(TEAM_WS, U35_DAY1) === path.basename(TEAM_WS) + "-" + U35_STAMP1 && __testing.teamSessionDefaultTeam(path.join(TEAM_TMP, "工作 区"), U35_DAY1) === "default-" + U35_STAMP1 && /^[a-z0-9-]+-\d{8}$/u.test(__testing.teamSessionDefaultTeam(TEAM_WS, U35_DAY1)) && /^[a-z0-9-]+-\d{8}$/u.test(__testing.teamSessionDefaultTeam(path.join(TEAM_TMP, "工作 区"), U35_DAY1)));
check("U35 同日幂等（纯函数，注入「当天」不靠墙钟）: 同一本地日内两个相距 23:59:59 的时刻 ⇒ **逐字同一**默认名（同一天怎么发都是同一个团队）；跨过午夜 00:00:00 ⇒ 名字变（自然成新团队）", typeof __testing.teamSessionDefaultTeam === "function" && __testing.teamSessionDefaultTeam(TEAM_WS, new Date(2026, 8, 22, 0, 0, 0, 0).getTime()) === __testing.teamSessionDefaultTeam(TEAM_WS, new Date(2026, 8, 22, 23, 59, 59, 999).getTime()) && __testing.teamSessionDefaultTeam(TEAM_WS, new Date(2026, 8, 23, 0, 0, 0, 0).getTime()) !== __testing.teamSessionDefaultTeam(TEAM_WS, new Date(2026, 8, 22, 23, 59, 59, 999).getTime()));
// 命令级三连：同日两条 ⇒ 同一团队且第二条零创建（§10.2.6 幂等一字不动）；注入次日 ⇒ 新团队。
const u35Env = teamSessionEnv({ askScript: ["创建", "创建"] });
const [u35Day1First, u35Day1Second] = await withInjectedNow(U35_DAY1, async () => [await u35Env.run("同日第一条：默认名要带日期"), await u35Env.run("同日第二条：还该指向同一个团队")]);
// 这条必须**在注入次日之前**读 store/creates/requests：它断言的是「同日两条之后」那一刻的状态
// （§10.2.6 命令级幂等），放在跨日那条之后读就会看见跨日命令新建的第二个团队 —— 夹具读态的时点错位，
// 不是被测行为的红。
check("U35 同日幂等（命令级，注入「当天」）: 同日两条同参命令 ⇒ store 里**恰一个**团队 <basename>-20260922、第二条零创建零对话框（默认名带日期之后 §10.2.6 的幂等一字未动）"
	+ (u35Day1First.kind === "success" && u35Day1Second.kind === "success" && u35Day1Second.text.includes("无需创建") && u35Env.uq.requests.length === 1 && u35Env.store().length === 1 && u35Env.store()[0].name === U30_DEFAULT_TEAM && u35Env.creates.length === 1 ? "" : "（实测：" + show({ firstKind: u35Day1First.kind, secondKind: u35Day1Second.kind, secondText: u35Day1Second.text, requests: u35Env.uq.requests.length, store: u35Env.store().map((row) => row.name), creates: u35Env.creates.length }) + "）"),
	u35Day1First.kind === "success" && u35Day1Second.kind === "success" && u35Day1Second.text.includes("无需创建") && u35Env.uq.requests.length === 1 && u35Env.store().length === 1 && u35Env.store()[0].name === U30_DEFAULT_TEAM && u35Env.creates.length === 1);
const u35Day2 = await withInjectedNow(U35_DAY2, () => u35Env.run("跨日再发同一行：这是新团队"));
check("U35 跨日 ⇒ 新团队（命令级，注入「当天」= 2026-09-23）: 同一条行解析到 <basename>-20260923、store 变成**两个**团队，而第一天那行原样还在 —— 跨日不是「换名覆盖」，是自然另起一队", u35Day2.kind === "success" && u35Env.store().length === 2 && u35Env.store().map((row) => row.name).join(",") === U30_DEFAULT_TEAM + "," + path.basename(TEAM_WS) + "-" + U35_STAMP2 && u35Env.creates.length === 2);
// 孤立后果（§10.2.8.9 ①，审计 #3，必须显式声明）：无日期的既有团队仍有效，但默认名永不再解析到它、无迁移。
const u35LegacyEnv = teamSessionEnv({
	askScript: ["创建"],
	teams: [teamRow({ name: path.basename(TEAM_WS), current: "session-other", roles: [
		{ role: "coordinator", current: "session-other", pending: null, history: [{ session: "session-other", from: 1_700_000_000_000, until: null }] },
	] })],
});
const u35LegacyOut = await withInjectedNow(U35_DAY1, () => u35LegacyEnv.run("默认名不再落到无日期的旧团队上"));
check("U35 孤立后果声明: 无日期的既有团队（<basename>）**仍完全有效但无迁移** —— 默认名（<basename>-20260922）不再解析到它：同 cwd 的命令建出**第二个**团队，旧那行的现任与角色一字未动（默认名永不再指向它们）"
	+ (typeof __testing.teamSessionDefaultTeam === "function" && __testing.teamSessionDefaultTeam(TEAM_WS, U35_DAY1) !== path.basename(TEAM_WS) && u35LegacyOut.kind === "success" && u35LegacyEnv.store().length === 2 && u35LegacyEnv.store()[1].name === U30_DEFAULT_TEAM && u35LegacyEnv.store()[0].name === path.basename(TEAM_WS) && u35LegacyEnv.store()[0].roles[0]?.current === "session-other" && u35LegacyEnv.store()[0].roles.length === 1 && u35LegacyEnv.store()[0].roles[0].role === "coordinator" && u35LegacyEnv.store()[0].roles[0].current === "session-other" ? "" : "（实测：" + show({ kind: u35LegacyOut.kind, text: u35LegacyOut.text, store: u35LegacyEnv.store() }) + "）"),
	typeof __testing.teamSessionDefaultTeam === "function" && __testing.teamSessionDefaultTeam(TEAM_WS, U35_DAY1) !== path.basename(TEAM_WS) && u35LegacyOut.kind === "success" && u35LegacyEnv.store().length === 2 && u35LegacyEnv.store()[1].name === U30_DEFAULT_TEAM && u35LegacyEnv.store()[0].name === path.basename(TEAM_WS) && u35LegacyEnv.store()[0].roles[0]?.current === "session-other" && u35LegacyEnv.store()[0].roles.length === 1 && u35LegacyEnv.store()[0].roles[0].role === "coordinator" && u35LegacyEnv.store()[0].roles[0].current === "session-other");
check("U30b 正文逐字保留（§10.2.8.1 的病灶本身）: 正文里的 N=3）。/ pid=384448 / word= 一个都不许被当参数 —— 旧实现在**整条输入**上做 token 扫描，把「同窗 N=3）。」读成 n=3）。并在参数校验阶段就拒掉整条命令", u30Parsed.error === undefined && u30Parsed.value.task.includes("N=3）。") && u30Parsed.value.task.includes("pid=384448") && u30Parsed.value.task.includes("word=") && u30Parsed.value.n === undefined && u30Parsed.value.team === undefined && u30Parsed.value.model === undefined);
check("U30b 正文送达逐字一致: worker 收到的 kickoff 文本里，正文与人类敲的**逐字一致**（零改写、零截断、零转义）", u30Env.created.length === 1 && u30Env.created[0].calls.followedup.length === 1 && u30Env.created[0].calls.followedup[0].content[0].text.includes("- 任务：" + U30_BODY));
check("U30b 正文送达逐字一致: 确认框交出去的正文是**同一段**（截断只发生在预览上，且标注了完整正文仍会原样投递）", typeof askedQuestion(u30Env)?.detail === "string" && askedQuestion(u30Env).detail.includes("- 启动任务：共 " + [...U30_BODY].length + " 字，此处仅显示前 " + __testing.TEAM_SESSION_DIALOG_TASK_CHARS + " 字") && askedQuestion(u30Env).detail.includes("完整正文会原样作为启动任务投递") && askedQuestion(u30Env).question.includes("确认创建 1 个 worker 会话"));
// R1 的两类结束条件，各写正/负相断言。
check("U30 R1(a) 静默结束（负相 ⇒ 归正文）: 裸 token 不含 = ⇒ 参数区在此结束、它自己就是正文的起点 —— 不报错、不当角色名（a b c 与 team=t n=2 a b c 两条都读）", (() => { const parsed = readTeamSessionCommand("a b c"); return parsed.error === undefined && parsed.value.task === "a b c" && parsed.value.roles === undefined; })() && (() => { const parsed = readTeamSessionCommand("team=t n=2 a b c"); return parsed.error === undefined && parsed.value.team === "t" && parsed.value.n === 2 && parsed.value.task === "a b c" && parsed.value.roles === undefined; })());
check("U30 R1(b) 报错（正相）: token 形状合法而取值本地不合法（n=abc）⇒ **整条命令拒绝**，不是静默「归正文」（否则同一行会在两种读法下得到不同的建队结果）", (() => { const parsed = readTeamSessionCommand("n=abc 帮我做 X"); return parsed.error !== undefined && parsed.value === undefined && readTeamSessionCommand("team=t n=abc").error !== undefined; })());
check("U30 既有 key 语义不变: 同一完整参数集下 team= / n= / roles= 的结果与今天一致（各 key 自身的解析规则一字未改 —— 变的只有「裸 token 归正文」这一条）", (() => { const parsed = readTeamSessionCommand("n=2 team=night-shift roles=worker-a,worker-b task=做接口"); const plan = teamSessionPlan(parsed.value, []).value; return parsed.error === undefined && plan.team === "night-shift" && plan.creating.join(",") === "worker-a,worker-b" && plan.task === "做接口" && plan.sessions.length === 2 && parsed.value.bare.length === 0; })());
// §10.2.8.2 的「正文与 `task=` 同现 ⇒ 报错（任务只能给一处）」：2026-09-22 由只读审计给出反例、代码评审复核，
// **两次独立认定「可达」** —— `task=` 的取值在**下一个已知 key=**（`model=`）处被截断，其后的裸 token 走 R1(a)
// 成为正文 ⇒ 同一个「启动任务」槽被给了两处。修法表第 0 行换槽位之后这条行为**零断言**，本批把它钉住
// （**行为一字不改**：实现现在的拒绝就是对的，这两条只是把它锁上）。
check("U30 同现 ⇒ 报错（§10.2.8.2「任务只能给一处」）: `task=` 被后续已知 key 截断、其后又有裸 token ⇒ 与正文同现 ⇒ **整条命令拒绝**并报「任务只能给一处」，且把正文的起点原样点名（否则用户不知道该删哪一处）"
	+ (readTeamSessionCommand("team=t task=a model=m b").error?.includes("任务只能给一处") === true && readTeamSessionCommand("team=t task=a model=m b").error.includes("正文从「b」开始") ? "" : "（实测：" + show(readTeamSessionCommand("team=t task=a model=m b")) + "）"),
	readTeamSessionCommand("team=t task=a model=m b").error !== undefined && readTeamSessionCommand("team=t task=a model=m b").value === undefined && readTeamSessionCommand("team=t task=a model=m b").error.includes("任务只能给一处") && readTeamSessionCommand("team=t task=a model=m b").error.includes("正文从「b」开始") && readTeamSessionCommand("team=t task=a model=m b").error.includes("task="));
check("U30 同现 ⇒ 报错（引号形）: `task=\"q\" 正文` 也被拒 —— 闭引号之后不许再有任何内容（那是「任务只能给一处」的另一条来路：引号形 task 取值之后又跟了正文）"
	+ (readTeamSessionCommand('task="q" 正文').error !== undefined ? "" : "（实测：" + show(readTeamSessionCommand('task="q" 正文')) + "）"),
	readTeamSessionCommand('task="q" 正文').error !== undefined && readTeamSessionCommand('task="q" 正文').value === undefined && readTeamSessionCommand('task="q" 正文').error.includes("task=") && readTeamSessionCommand('task="q" 正文').error.includes("落在闭引号之后"));
// --- U30 默认值第 4 条（§10.2.8.10 ②，2026-09-22 用户裁定 = **反转**）：既无正文也无 `task=`
// ⇒ **仍然驱动**，但投的是一具「最小唤醒」（待命通知），不是编出来的任务 --------------------
// 正文与 `task=` 是**同一个槽**（R2: 正文 = 启动任务）⇒ 两者都没给就是**没有任务**。旧实现在这一支
// 只建会话、不投启动任务（`plan.task === undefined ? [] : created` 那道守卫），代价是**新会话没有回合
// ⇒ 在侧边栏不可见**（§10.2.8.7 观察 3，真机观察 2/3）。用户原话：「改回『投一具最小启动任务』」
// ＋确认「即唤醒会话即可？」⇒ 唤醒通知**不含任务内容**，只说明三件事。
// 判据三条（与设计档 §10.2.8.10 ② 的「U30 反转」逐条对应）：① 会话照建（恰 2 个）② **每个都被
// `followup` 恰一次**（inject / steer 各零次 —— 唤醒必须驱动一个回合，那正是它在侧边栏可见的原因）
// ③ 文本**不含任务内容**、含三件待命措辞。
const noTaskEnv = teamSessionEnv({ askScript: ["创建"] });
const noTaskOut = await noTaskEnv.run("team=t n=2");
const noTaskKickoffs = noTaskEnv.created.map((item) => item.calls.followedup[0]?.content?.[0]?.text ?? "");
check("U30 默认值第 4 条（反转）: `team=t n=2`（既无正文也无 task=）⇒ 会话照建（恰 2 个）**且每个都被 followup 恰一次**（inject / steer 各零次：唤醒必须驱动一个回合，否则新会话没有回合、在侧边栏仍然看不见）"
	+ (noTaskEnv.creates.length === 2 && noTaskEnv.created.every((item) => item.calls.followedup.length === 1 && item.calls.injected.length === 0 && item.calls.steered.length === 0) ? "" : "（实测：" + show({ creates: noTaskEnv.creates.length, followups: noTaskEnv.created.map((item) => item.calls.followedup.length), injected: noTaskEnv.created.map((item) => item.calls.injected.length) }) + "）"),
	noTaskEnv.creates.length === 2 && noTaskEnv.created.length === 2 && noTaskEnv.created.every((item) => item.calls.followedup.length === 1 && item.calls.injected.length === 0 && item.calls.steered.length === 0) && noTaskOut.kind === "success");
check("U30 默认值第 4 条（反转 · 唤醒文本三件逐件点名）: ①「本次命令未给任务」②「你已被创建为团队 t 的角色 worker-N」（每个会话说自己那个角色）③「请等待主会话派活」；且**不编任务**（没有「- 任务：」那一行、也不要求它做任何事）"
	+ (noTaskKickoffs.length === 2 && noTaskKickoffs[0].includes("角色 worker-1") && noTaskKickoffs[1].includes("角色 worker-2") ? "" : "（实测：" + show({ kickoffs: noTaskKickoffs }) + "）"),
	noTaskKickoffs.length === 2 && noTaskKickoffs.every((text) => text.includes("本次命令未给任务") && text.includes("请等待主会话派活") && text.includes("不含任何任务内容") && !text.includes("- 任务：") && !text.includes("请明确回报")) && noTaskKickoffs[0].includes("角色 worker-1") && noTaskKickoffs[1].includes("角色 worker-2"));
// **2026-09-22 真机复验后的文案压缩**（见 docs/verification-log.md 的「真机复验」一节）：「- 启动任务：」
// 的括号与「确认则」的括号**都**写了「未给正文/task=」，而「改投最小唤醒 / 唤醒不含任务」在两行里
// 各说一遍 —— 真机那具无任务框实测 399 码点、超 390，压掉重复（−18）后 381。判据未动。
check("U30 默认值第 4 条（反转 · 措辞同步）: 确认框与完成回报都按**反转后**的那一支写 —— 框里「- 启动任务：（未给正文/task=）」＋「确认则：…投最小唤醒…（唤醒不含任务）」，回报里逐行写「已投最小唤醒（本次未给任务）」，两处都不再出现「不投启动任务」，同一件事也不在两行里重复说"
	+ (typeof noTaskEnv.uq.requests[0]?.questions?.[0]?.detail === "string" && noTaskEnv.uq.requests[0].questions[0].detail.includes("- 启动任务：（未给正文/task=）") && noTaskOut.text.includes("已创建 + 已投最小唤醒（本次未给任务）") ? "" : "（实测：" + show({ detail: noTaskEnv.uq.requests[0]?.questions?.[0]?.detail, report: noTaskOut.text }) + "）"),
	typeof noTaskEnv.uq.requests[0]?.questions?.[0]?.detail === "string" && noTaskEnv.uq.requests[0].questions[0].detail.includes("- 启动任务：（未给正文/task=）") && noTaskEnv.uq.requests[0].questions[0].detail.includes("确认则：创建 → 投最小唤醒 → 登记 roster 与 pairs（唤醒不含任务）；取消则零创建、零 pairs。") && (noTaskOut.text.match(/已创建 \+ 已投最小唤醒（本次未给任务）/gu) ?? []).length === 2 && !noTaskOut.text.includes("不投启动任务") && !noTaskOut.text.includes("已投递启动任务"));
// 同支纪律（§10.2.8.2 默认值第 4 条下的补条，2026-09-22 第 2 轮评审 🟡#1）：**成本行不得与同一张框
// 的另一行自相矛盾** —— 那时无任务支写「不投启动任务」、成本行却无条件写「followup 驱动一次」。
// §10.2.8.10 ① 之后这条纪律换了一种**更强**的满足方式：回执把两支的模型回合数都变成 **N＋1**，
// 于是成本行**不再分支** —— 它说的东西在两支里都成立，也就不可能矛盾。判据因此写成「**两支逐字同
// 形状**」（除计数外一字不差：N 个新会话 ＋ 1 条调用方回执；按各自模型计费），并两侧都咬住
// 「按各自模型计费」这半句（偏差修复轮 DIVERGENCE #4 的回归，逐字保留）与「不再有任何 branch-specific
// 断言」（「followup 驱动一次」「0 次驱动」「不投启动任务」在两支里都不许再出现）。
/** 从确认框正文里取出「成本」那一行（取不到 ⇒ undefined，交给断言判假而不是抛错）。裁定 A 之后这
 * 一行还**并入了信任授予**（同一行两件事实），所以判据按「；信任授予：」切开只读成本那半边。 */
const costLineOf = (text) => (typeof text === "string" ? text.split("\n").find((line) => line.startsWith("成本：")) : undefined);
const costHalfOf = (line) => (line ?? "").split("；信任授予：")[0];
const noTaskDetail = noTaskEnv.uq.requests[0]?.questions?.[0]?.detail;
const noTaskCostLine = costLineOf(noTaskDetail);
const taskCostLine = costLineOf(u30Env.uq.requests[0]?.questions?.[0]?.detail);
const costShapeOf = (count) => `成本：${count + 1} 个回合（${count} 个新会话 ＋ 1 条调用方回执；按各自模型计费）`;
check("U30 默认值第 4 条（措辞同步 · 成本行）: 「成本」那一行**不再分支** —— 两支逐字同形状（N＋1 个回合：N 个新会话 ＋ 1 条调用方回执），「按各自模型计费」逐字保留，而「followup 驱动一次」「0 次驱动」「不投启动任务」在两支里都不再出现；两个预算仍不破"
	+ (noTaskCostLine === undefined || taskCostLine === undefined || costHalfOf(noTaskCostLine) !== costShapeOf(2) || costHalfOf(taskCostLine) !== costShapeOf(1) ? "（实测：" + show({ noTaskCostLine, taskCostLine, noTaskHalf: costHalfOf(noTaskCostLine), taskHalf: costHalfOf(taskCostLine), cp: codePointsOf(noTaskDetail), nl: newlinesOf(noTaskDetail) }) + "）" : ""),
	noTaskCostLine !== undefined && taskCostLine !== undefined && costHalfOf(noTaskCostLine) === costShapeOf(2) && costHalfOf(taskCostLine) === costShapeOf(1) && [noTaskCostLine, taskCostLine].every((line) => line.includes("按各自模型计费") && !line.includes("followup 驱动一次") && !line.includes("0 次驱动") && !line.includes("不投启动任务")) && codePointsOf(noTaskDetail) <= 600 && newlinesOf(noTaskDetail) <= 12);

// --- U31 错误可解释性（R3：失败必须点名）--------------------------------------
check("U31 offender 回显: 任何参数错误都**原样回显**冒犯的那个 token（n=abc / bogus=1 / roles= 逐字回来，不被折断、不被改写）", readTeamSessionCommand("n=abc 帮我做 X").error.includes("n=abc") && readTeamSessionCommand("team=t bogus=1").error.includes("bogus=1") && readTeamSessionCommand("team=t roles=").error.includes("roles="));
check("U31 出路提示: 报错文本给出「想写正文就直接写…也可以用 task=」—— 方案 A 想让用户走的那条路，必须在失败处被指出来", readTeamSessionCommand("n=abc 帮我做 X").error.includes("想写正文就直接写") && readTeamSessionCommand("n=abc 帮我做 X").error.includes("task=") && readTeamSessionCommand("team=t bogus=1").error.includes("想写正文就直接写"));
check("U31 废除的指引不复活: 「位置参数写角色名」这类文案在**任何**参数报错里都不再出现，而新文法（位置角色名已废除、角色只能由 roles= 声明）在未知参数的提示里被宣告", (() => { const errors = ["n=abc 帮我做 X", "team=t bogus=1", "team=t roles="].map((line) => readTeamSessionCommand(line).error ?? ""); return errors.every((text) => !text.includes("位置参数写角色名") && !text.includes("把正文当成角色名") && !text.includes("疑似把正文当角色名")) && readTeamSessionCommand("team=t bogus=1").error.includes("位置角色名已废除") && readTeamSessionCommand("team=t bogus=1").error.includes("roles="); })());
check("U31 废除的指引不复活（源码级反锁）: 「位置参数请写在 task= 之前」与旧的未知参数提示文本都不再出现在 lib/index.js 里（报错文案只可能从那里回来）", !HANDOFF_SOURCE.includes("位置参数请写在 task= 之前") && !HANDOFF_SOURCE.includes("（可用：n / team / roles / preset / model / task；位置参数写角色名"));

// --- U34 /team_rotate 回归（§10.2.8.6）---------------------------------------
// 依据是源码级实测：两条命令**各有自己的解析器**（readTeamRotateCommand 只被自己的 handler
// 调用，readTeamSessionCommand 同理），只共用 commands seam ⇒ §10.2.8.2 的文法换血**不会**
// 波及 /team_rotate 的位置参数（角色名）。它的既有测试面在上文 §11.2 那一组（本轮一字未改），
// 这里只把判据点名，并补一条「同一段文本在两条命令下读法不同」的行为证据。
check("U34 /team_rotate 回归: 位置参数（角色名）的语法与结果不变 —— coordinator / coordinator team=night-shift 照旧解析，缺角色名、多角色名、未知 key 照旧被拒（拒绝文案仍只列它真正支持的语法）", __testing.readTeamRotateCommand("coordinator team=night-shift").value?.role === "coordinator" && __testing.readTeamRotateCommand("coordinator team=night-shift").value?.team === "night-shift" && __testing.readTeamRotateCommand("coordinator").error === undefined && __testing.readTeamRotateCommand("").error.includes("/team_rotate <role>") && __testing.readTeamRotateCommand("a b").error.includes("只接受一个角色名") && __testing.readTeamRotateCommand("coordinator bogus=1").error.includes("未知参数"));
check("U34 /team_rotate 回归: 自由正文在 /team_rotate 下**仍然**按位置角色名读（多 token ⇒「只接受一个角色名」，单 token ⇒ 就是一个角色名），与 /team_session 下「它就是正文」的读法不同 —— 这就是「两个解析器互不调用、只共用 commands seam」的行为证据。★ 本判据是回归守卫：**改前改后都应为绿**（红相＝把 /team_rotate 的解析器也换成新文法，见本轮变异验证）", __testing.readTeamRotateCommand("帮我做 X").error.includes("只接受一个角色名") && __testing.readTeamRotateCommand("collaborator").error === undefined && __testing.readTeamRotateCommand("collaborator").value?.role === "collaborator" && __testing.readTeamRotateCommand("coordinator team=night-shift").value?.team === "night-shift" && __testing.readTeamRotateCommand('coordinator team="x"').error.includes("不要带引号"));

// ---------------------------------------------------------------------------
// §10.2.8.9 ②（释放并认领：U36 / U37）与 §10.2.8.10 ①（调用方回执：U32 通道 4）
// ---------------------------------------------------------------------------
// 两面各咬自己那一面，不互相冒充：U36/U37 走**真 handler**，量的是「谁被释放、版本史写了什么、
// 边界有没有被偷偷放宽」；U32 通道 4 量的是「调用方会话收到了什么」——一条 followup、三成员信封、
// 一行 ≤120 码点。两面的判据都读**真函数 / 真投递**，不抄一份文案进测试。

// --- U32 通道 4（§10.2.8.10 ①）：结算后给调用方会话投一条短回执 -----------------
const receiptTexts = (env) => env.senderCalls.followedup.map((message) => message.content?.[0]?.text ?? "");
/** 信封判据（定死）：**恰一次** followup，且 source **恰三成员**、值就是调用方自己。 */
const receiptEnvelopeOk = (env) => env.senderCalls.followedup.length === 1
	&& Object.keys(env.senderCalls.followedup[0]?.source ?? {}).join(",") === "kind,form,senderSessionId"
	&& env.senderCalls.followedup[0].source.kind === "agent-message"
	&& env.senderCalls.followedup[0].source.form === "relay"
	&& env.senderCalls.followedup[0].source.senderSessionId === "session-self";

const rcOkEnv = teamSessionEnv({ askScript: ["创建"] });
const rcOkOut = await rcOkEnv.run("n=1 team=night-shift roles=worker-a task=做接口");
const rcOkText = receiptTexts(rcOkEnv)[0];
check("U32 通道 4（成功）: 结算后**恰一次** followup 投给调用方会话（这就是「空会话里发命令也能把会话显出来」那一半），信封仍是那条唯一的三成员 relay（senderSessionId = 调用方自己），回执一行、≤120 码点、含团队名与新建数"
	+ (receiptEnvelopeOk(rcOkEnv) && typeof rcOkText === "string" && codePointsOf(rcOkText) <= RECEIPT_MAX && rcOkText.includes("完成：团队 night-shift") && rcOkText.includes("新建 1 个") ? "" : "（实测：" + show({ texts: receiptTexts(rcOkEnv), source: rcOkEnv.senderCalls.followedup[0]?.source, cp: codePointsOf(rcOkText) }) + "）"),
	rcOkOut.kind === "success" && receiptEnvelopeOk(rcOkEnv) && typeof rcOkText === "string" && codePointsOf(rcOkText) <= RECEIPT_MAX && newlinesOf(rcOkText) === 0 && rcOkText.includes("完成：团队 night-shift") && rcOkText.includes("新建 1 个"));
const rcWakeEnv = teamSessionEnv({ askScript: ["创建"] });
await rcWakeEnv.run("n=2 team=night-shift roles=worker-a,worker-b");
/** 一条回执文本，或 `undefined`（**不经下标** —— 旧实现上第二条命令根本不投回执，`[0].includes` 会把
 * 整个套件打崩；这一处正是本批踩到的那个 Y7 坑）。 */
const receiptTextOr = (env) => { const texts = receiptTexts(env); return typeof texts[0] === "string" ? texts[0] : undefined; };
const rcWakeText = receiptTextOr(rcWakeEnv);
check("U32 通道 4（无任务形态）: 回执写出「其中最小唤醒 M 个」，而 M 读的是**真正投出去的那几具**（同一批结果行，不另算一遍）——有任务那一支不写这个括号（M=0 时不冒充唤醒）"
	+ (typeof rcWakeText === "string" && rcWakeText.includes("新建 2 个（其中最小唤醒 2 个）") && typeof rcOkText === "string" && !rcOkText.includes("最小唤醒") ? "" : probe("U32 通道 4（无任务形态）", { wake: rcWakeText, withTask: rcOkText })),
	typeof rcWakeText === "string" && rcWakeText.includes("新建 2 个（其中最小唤醒 2 个）") && typeof rcOkText === "string" && !rcOkText.includes("最小唤醒"));
const rcCancelEnv = teamSessionEnv({ askScript: ["取消"] });
await rcCancelEnv.run("n=1 team=night-shift roles=worker-a task=做接口");
const rcCancelText = receiptTextOr(rcCancelEnv);
check("U32 通道 4（取消）: 取消也算一次结算 ⇒ 照样一条回执（代价如实：连取消也花调用方一个模型回合），文本写明零创建零 pairs 与团队名"
	+ (typeof rcCancelText === "string" && rcCancelText.includes("已取消：团队 night-shift（零创建、零 pairs）") ? "" : probe("U32 通道 4（取消）", { texts: receiptTexts(rcCancelEnv) })),
	receiptEnvelopeOk(rcCancelEnv) && typeof rcCancelText === "string" && rcCancelText.includes("已取消：团队 night-shift（零创建、零 pairs）") && rcCancelEnv.creates.length === 0);
const rcPreParseEnv = teamSessionEnv({ askScript: ["创建"] });
const rcPreParseOut = await rcPreParseEnv.run("n=abc 帮我做 X");
const rcPreParseText = receiptTextOr(rcPreParseEnv);
check("U32 通道 4（解析前失败）: 团队名**尚未解析** ⇒ 回执里不许硬塞一个（「团队 …」会把解析器的失败说成团队的问题），只有「失败：<原因，含出路>」那一支"
	+ (typeof rcPreParseText === "string" && !rcPreParseText.includes("团队") ? "" : probe("U32 通道 4（解析前失败）", { texts: receiptTexts(rcPreParseEnv), out: rcPreParseOut.text })),
	rcPreParseOut.kind === "error" && receiptEnvelopeOk(rcPreParseEnv) && typeof rcPreParseText === "string" && rcPreParseText.startsWith("/team_session 失败：") && !rcPreParseText.includes("团队") && rcPreParseText.includes("原因与出路见本回合命令输出"));
const rcFailEnv = teamSessionEnv({ askScript: ["创建"], failCreateAt: 0 });
const rcFailOut = await rcFailEnv.run("n=1 team=night-shift roles=worker-a task=做接口");
const rcFailText = receiptTextOr(rcFailEnv);
check("U32 通道 4（解析后失败）: 团队名**已解析** ⇒ 回执带上它（同一根判据的另一半），失败态含「原因与出路见本回合命令输出」（回执有界、出路不因截断而丢）"
	+ (typeof rcFailText === "string" && rcFailText.startsWith("/team_session 失败：团队 night-shift，") ? "" : probe("U32 通道 4（解析后失败）", { texts: receiptTexts(rcFailEnv), kind: rcFailOut.kind })),
	rcFailOut.kind === "error" && receiptEnvelopeOk(rcFailEnv) && typeof rcFailText === "string" && rcFailText.startsWith("/team_session 失败：团队 night-shift，") && rcFailText.includes("原因与出路见本回合命令输出") && codePointsOf(rcFailText) <= RECEIPT_MAX);
check("U32 通道 4（无新日志事件）: 回执是一条普通的跨会话消息（同一构造、同一信封），整个 ① 面没有引入任何新的日志事件类型", rcOkEnv.actionLog.every((entry) => entry === "create" || entry === "followup"));

// --- U36 / U37（§10.2.8.9 ②）：现任失联 ⇒ 释放并认领（对 writerGate 的一次窄放宽）-----
/** 一具「带失联现任的既有团队」夹具：现任 id、归档名单、归档读数的形状、服务是否提供、会话库里
 * 有没有它、有没有活动代理，各由参数给 —— 三条读数（归档 / 存在 / 活性）各自成轴，夹具才能把
 * 甲（服务缺席）/ 乙（服务在但读不到）/ 丙（确证）三档分开造出来，也才能造出 TOCTOU 那一具。 */
const GONE_COORD = "session-gone-coord";
const releaseEnvOf = ({ current = GONE_COORD, archived = [], archiveUnreadable = "none", omitWorkspaceRegistry = false, sessions = [], extraAgents = [], roles, writer = "coordinator", askScript = ["创建"] } = {}) => teamSessionEnv({
	sessions,
	extraAgents,
	teams: [teamRow({ current, writer, roles })],
	workspaceRegistryOptions: { archived, archiveUnreadable },
	omitWorkspaceRegistry,
	askScript,
});
const coordOf = (env) => env.store()[0].roles.find((entry) => entry.role === "coordinator");
const closedTenureOf = (env, sessionId) => coordOf(env).history.find((record) => record.session === sessionId);

// (a) 现任**已归档**（宿主公开读数 archivedSessionIds 含它）⇒ 同一道命令里释放并认领。
const relAEnv = releaseEnvOf({ archived: [GONE_COORD] });
const relAOut = await relAEnv.run("n=1 team=night-shift roles=worker-a task=做接口");
check("U36 (a) 现任**已归档** ⇒ 释放并认领: 同一道用户命令里 current 变成调用会话、那一段任期被收口（until=now）并写明「released: coordinator archived」、建队照样成功"
	+ (closedTenureOf(relAEnv, GONE_COORD)?.note !== RELEASE_NOTES.archived ? "（实测：" + show({ coord: coordOf(relAEnv), out: relAOut.text }) + "）" : ""),
	relAOut.kind === "success" && relAEnv.creates.length === 1 && coordOf(relAEnv).current === "session-self" && typeof closedTenureOf(relAEnv, GONE_COORD)?.until === "number" && closedTenureOf(relAEnv, GONE_COORD)?.note === RELEASE_NOTES.archived && coordOf(relAEnv).history.at(-1).session === "session-self" && coordOf(relAEnv).history.at(-1).until === null);
check("U36 (a) 边界⑤: policy.writer **仍是 coordinator** —— 放宽的是这一处证据，不是 gate 本身（绝不许降级成 any）",
	relAEnv.store()[0].policy.writer === "coordinator" && relAEnv.store()[0].roles[0].role === "coordinator");
check("U36 (a) 出席与留痕: 释放发生在**必经确认框**的那条路上（框先开、人先确认），报告如实点名「释放并接管原团队」与理由，pairs 照常只给本次真正建出来的 worker"
	+ (relAEnv.uq.requests.length === 1 && relAOut.text.includes("按 §10.2.8.9 ② 释放并接管原团队") && relAOut.text.includes(RELEASE_NOTES.archived) && relAEnv.pairs().length === 1 && relAEnv.pairs()[0].a === "session-self" ? "" : probe("U36 (a)", { asks: relAEnv.uq.requests.length, pairs: relAEnv.pairs(), rosterLine: relAOut.text.split("\n").find((line) => line.startsWith("- roster：")) })),
	relAEnv.uq.requests.length === 1 && relAOut.text.includes("按 §10.2.8.9 ② 释放并接管原团队") && relAOut.text.includes(RELEASE_NOTES.archived) && relAEnv.pairs().length === 1 && relAEnv.pairs()[0].a === "session-self");

// (b) 现任**已不存在**（两条读数都不是「已归档」，而会话库里没有它）⇒ 同一条路，理由 gone。
const relBEnv = releaseEnvOf({});
const relBOut = await relBEnv.run("n=1 team=night-shift roles=worker-a");
check("U36 (b) 现任**已不存在** ⇒ 同一条路（reason=gone）: 释放照发生，版本史写「released: coordinator gone」——两种证据**各自**能独立放行，且措辞不混（archived 与 gone 是两条不同的证据）"
	+ (relBOut.kind === "success" && coordOf(relBEnv).current === "session-self" && closedTenureOf(relBEnv, GONE_COORD)?.note === RELEASE_NOTES.gone && relBOut.text.includes(RELEASE_NOTES.gone) && !relBOut.text.includes(RELEASE_NOTES.archived) ? "" : probe("U36 (b)", { kind: relBOut.kind, coord: coordOf(relBEnv), out: relBOut.text })),
	relBOut.kind === "success" && coordOf(relBEnv).current === "session-self" && closedTenureOf(relBEnv, GONE_COORD)?.note === RELEASE_NOTES.gone && relBOut.text.includes(RELEASE_NOTES.gone) && !relBOut.text.includes(RELEASE_NOTES.archived));

// (c) 现任**存活**（有活动代理）⇒ 照旧拒绝，既有文案不变，零弹框零写入。
const relCEnv = releaseEnvOf({ current: "session-target" });
const relCOut = await relCEnv.run("n=1 team=night-shift roles=worker-a");
check("U36 (c) 现任**存活** ⇒ 照旧拒绝（既有文案一字不变，也不多一句活性诊断——「现任活着、只是调用者不是他」不是活性问题）：零弹框、零创建、零 pairs、零 roster 改动",
	relCOut.kind === "error" && relCOut.text.includes("只有现任协调者会话 session-target 可写") && !relCOut.text.includes("活性诊断") && relCEnv.uq.requests.length === 0 && relCEnv.creates.length === 0 && relCEnv.pairs().length === 0 && coordOf(relCEnv).current === "session-target" && relCEnv.store()[0].roles.length === 1 && coordOf(relCEnv).history.length === 1);

// (d) 服务**在、读不到**（getter 抛错 / 形状不对）⇒ unknown ⇒ 拒绝（fail-safe 乙）。
const relDThrowsEnv = releaseEnvOf({ archiveUnreadable: "throws" });
const relDThrowsOut = await relDThrowsEnv.run("n=1 team=night-shift roles=worker-a");
const relDShapeEnv = releaseEnvOf({ archiveUnreadable: "not-array" });
const relDShapeOut = await relDShapeEnv.run("n=1 team=night-shift roles=worker-a");
check("U37 (乙) 服务**在、读不到**（getter 抛错 / 不是数组）⇒ unknown ⇒ **拒绝**、零弹框零创建零 pairs，且拒绝文案点出「归档信号读不出」——**不许**把「读不到」当成「未归档」，更不许当成「已归档」"
	+ ([relDThrowsOut.text, relDShapeOut.text].some((text) => !text.includes("只有现任协调者会话")) ? "（实测：" + show({ throws: relDThrowsOut.text, shape: relDShapeOut.text }) + "）" : ""),
	[relDThrowsEnv, relDShapeEnv].every((env) => env.uq.requests.length === 0 && env.creates.length === 0 && env.pairs().length === 0 && coordOf(env).current === GONE_COORD && env.store()[0].roles.length === 1)
	&& relDThrowsOut.kind === "error" && relDThrowsOut.text.includes("只有现任协调者会话") && relDThrowsOut.text.includes("读取失败")
	&& relDShapeOut.kind === "error" && relDShapeOut.text.includes("只有现任协调者会话") && relDShapeOut.text.includes("不是数组"));

// (e) 服务**未提供** ＋ 现任只归档（会话仍在）⇒ 拒绝（甲：归档信号被跳过 ⇒ 只剩 gone 一条，而它没证据）。
const relEEnv = releaseEnvOf({ omitWorkspaceRegistry: true, sessions: [{ header: { id: GONE_COORD, createdAt: 1, cwd: TEAM_WS }, live: false, persisted: true }] });
const relEOut = await relEEnv.run("n=1 team=night-shift roles=worker-a");
check("U37 (甲) 服务**未提供** ＋ 现任只归档（会话仍在）⇒ **拒绝**：归档信号被跳过（缺信号 ≠ 未归档 ≠ 已归档），只剩「会话已不存在」一条判据，而它没给出证据；文案如实说「归档信号缺席」"
	+ (relEOut.text.includes("归档信号缺席") ? "" : "（实测：" + show({ out: relEOut.text }) + "）"),
	relEOut.kind === "error" && relEOut.text.includes("只有现任协调者会话") && relEOut.text.includes("归档信号缺席") && relEEnv.creates.length === 0 && relEEnv.pairs().length === 0 && coordOf(relEEnv).current === GONE_COORD);

// (f) 服务**未提供** ＋ 现任 gone ⇒ 释放照旧成立（甲降级的是「归档信号」，不是整条判据）。
const relFEnv = releaseEnvOf({ omitWorkspaceRegistry: true });
const relFOut = await relFEnv.run("n=1 team=night-shift roles=worker-a task=做接口");
check("U37 (甲) 服务**未提供** ＋ 现任 gone ⇒ **释放成立**：版本史写 gone 那一句、current 换成调用会话、建队成功、pairs 只给本次建出来的 worker",
	relFOut.kind === "success" && coordOf(relFEnv).current === "session-self" && closedTenureOf(relFEnv, GONE_COORD)?.note === RELEASE_NOTES.gone && relFEnv.creates.length === 1 && relFEnv.pairs().length === 1);

// (g) 保留既有角色（用户裁定 a「保留历史」的**唯一断言面**）：其它角色条目逐字不变。
const relGEnv = releaseEnvOf({
	archived: [GONE_COORD],
	roles: [
		// 用**规范形状**种（roleRecord）⇒ 断言量的才是「谁动了谁的账」，而不是「读时归一化补了字段」。
		ROLE_RECORD({ role: "coordinator", current: GONE_COORD, history: [{ session: GONE_COORD, from: 1_700_000_000_000, until: null }] }),
		ROLE_RECORD({ role: "worker-a", current: "session-worker-a", pending: { session: "session-worker-b", token: "tok-1", role: "worker-a" }, rotationAt: 1_700_000_200_000, history: [{ session: "session-worker-a", from: 1_700_000_100_000, until: null }] }),
	],
});
/** 「逐字未动」的对照读数是**插件读到的那一行**（`normalizeTeams` 就是 `policy.get()` 用的那把尺），
 * 而不是种进 settings 的原始字面量 —— 否则量到的是「读时归一化补字段」（pending 的 team/expiresAt/
 * createdAt 就是归一化补的），不是「谁动了谁的账」。 */
const relGBefore = structuredClone(NORMALIZE_TEAMS(relGEnv.store())[0].roles[1]);
await relGEnv.run("n=1 team=night-shift roles=worker-b task=做接口");
check("U36 (g) 保留既有角色与历史: 释放认领之后**其它角色条目逐字未动**（含 pending / rotationAt / 自己的版本史），coordinator 也只是历史里**多出一条**（旧任收口 + 新人开段）；本次批量新建的 worker-b 照常登记为**第三条**角色（释放不改建队语义）"
	+ (JSON.stringify(relGBefore) !== JSON.stringify(relGEnv.store()[0].roles[1]) ? "（实测：" + show({ before: relGBefore, after: relGEnv.store()[0].roles[1] }) + "）" : ""),
	(() => {
		const ok = JSON.stringify(relGBefore) === JSON.stringify(relGEnv.store()[0].roles[1]) && relGEnv.store()[0].roles.length === 3 && relGEnv.store()[0].roles.map((entry) => entry.role).sort().join(",") === "coordinator,worker-a,worker-b" && coordOf(relGEnv).history.length === 2 && coordOf(relGEnv).history[0].session === GONE_COORD && typeof coordOf(relGEnv).history[0].until === "number" && coordOf(relGEnv).history[1].session === "session-self" && coordOf(relGEnv).history[1].until === null;
		return ok || probe("U36 (g)", { roles: relGEnv.store()[0].roles });
	})());

// (h) 触发释放的**框体**：披露折叠进「确认则」一行，两个 U33c 预算不破。
const relHDetail = relAEnv.uq.requests[0]?.questions?.[0]?.detail;
const relHConfirmLine = typeof relHDetail === "string" ? relHDetail.split("\n").find((line) => line.startsWith("确认则：")) : undefined;
check("U36 (h) 触发释放的框体: detail ≤6 行且 ≤390 码点、那句披露（字面量 11 码点）**折在「确认则」那一行**里（不是新起一段——新起一段会破 ≤6 行），且披露只在**既有团队被释放**时才出现（新建团队那一具里没有它）"
	+ (typeof relHConfirmLine === "string" && relHConfirmLine.includes(RELEASE_DISCLOSURE) ? "" : "（实测：" + show({ cp: codePointsOf(relHDetail), lines: newlinesOf(relHDetail) + 1, confirm: relHConfirmLine }) + "）"),
	typeof relHDetail === "string" && codePointsOf(relHDetail) <= U33C_MAX_POINTS && newlinesOf(relHDetail) <= 5 && typeof relHConfirmLine === "string" && relHConfirmLine.includes(RELEASE_DISCLOSURE) && relHConfirmLine.endsWith("；取消则零创建、零 pairs。") && !u30Env.uq.requests[0].questions[0].detail.includes(RELEASE_DISCLOSURE));

// --- §10.2.8.9 ② 的**空批角**（评审 round-1 🟡#1）：证据已确证，但本次没有要建/登记的角色 --------
// 病灶：`release` 这时已经确证，而命令直接走「无需创建」那一支 —— 不说的话，用户会以为接管完成了，
// 实际现任仍是那个失联旧任。判据：**零写入**（没释放、没认领、没动 pairs）＋ **两处都说明白**
// （命令输出与调用方回执），并给出可执行的下一步。
const relEmptyEnv = releaseEnvOf({ archived: [GONE_COORD] });
const relEmptyOut = await relEmptyEnv.run("n=1 team=night-shift roles=coordinator");
const relEmptyReceipt = receiptTextOr(relEmptyEnv);
check("U36 空批角: 现任已确证失联、但本次**没有任何要建/登记的角色** ⇒ 仍然**零写入**（未释放未认领、roster 一字未动、pairs 零条），而**命令输出与回执都必须说出这件事**（不许静默丢弃：那会被读成「接管完成」）"
	+ (typeof relEmptyOut.text === "string" && relEmptyOut.text.includes("未释放、未认领") && typeof relEmptyReceipt === "string" ? "" : probe("U36 空批角", { out: relEmptyOut.text, receipt: relEmptyReceipt })),
	relEmptyOut.kind === "success" && relEmptyEnv.uq.requests.length === 0 && relEmptyEnv.creates.length === 0 && relEmptyEnv.pairs().length === 0 && coordOf(relEmptyEnv).current === GONE_COORD && relEmptyEnv.store()[0].roles.length === 1
	// 走**受守卫的别名**（本块自己声明的纪律：先取值再判类型）—— 直接读 __testing.… 在本块里
	// 是一处漏网的同类问题（评审 round-2 🔵#8）。
	&& relEmptyOut.text.includes("未释放、未认领") && relEmptyOut.text.includes(RELEASE_NOTES.archived) && relEmptyOut.text.includes("新角色")
	&& typeof relEmptyReceipt === "string" && relEmptyReceipt.includes("未释放未认领") && codePointsOf(relEmptyReceipt) <= RECEIPT_MAX);

// --- 变异基线（每条都是「把这一行改坏 ⇒ 这一条当场变红」）------------------------
// 变异 1（fail-safe 乙 ⇒ 「读不到就释放」）：把 (d) 的 unknown 分支改成放行 ⇒ (d) 那两条当场变红。
//   证据是一具**服务在、getter 抛错**的团队：那条路上现任是死是活**未知**，放行等于拿「读不到」
//   当授权（本轮真跑过这次变异，读数记在 docs/verification-log.md）。
// 变异 2（只看现任 ⇒ 看任一历史任）：下面这条夹具的**旧任**已归档、现任活着 ⇒ 一次释放都不许发生。
const relMOldEnv = releaseEnvOf({
	current: "session-target",
	archived: ["session-old"],
	roles: [{ role: "coordinator", current: "session-target", pending: null, history: [
		{ session: "session-old", from: 1_700_000_000_000, until: 1_700_000_100_000 },
		{ session: "session-target", from: 1_700_000_100_000, until: null },
	] }],
});
const relMOldOut = await relMOldEnv.run("n=1 team=night-shift roles=worker-a");
check("U37 变异基线 2（只看现任）: **换届换下的旧任**已归档、现任活着 ⇒ 一次释放都不发生（授权不回溯旧任，与 §4.2/§11 的对称吊销语义一致）；「看任一历史任」的写法会在这里变红"
	+ (relMOldOut.text.includes("只有现任协调者会话 session-target 可写") ? "" : "（实测：" + show({ out: relMOldOut.text, coord: coordOf(relMOldEnv) }) + "）"),
	relMOldOut.kind === "error" && relMOldOut.text.includes("只有现任协调者会话 session-target 可写") && relMOldEnv.creates.length === 0 && coordOf(relMOldEnv).current === "session-target" && coordOf(relMOldEnv).history.length === 2);
// 变异 3（写时复检 / TOCTOU）：现任在**确认框打开期间**复活 ⇒ 落笔前复检发现 ⇒ 中止、零 roster 写入、
// **pairs 也不写**（释放没落笔 ⇒ 调用会话不是现任 ⇒ 不该给任何人写信任通道）。去掉复检那一行会变红。
const relTocEnv = releaseEnvOf({
	archived: [GONE_COORD],
	extraAgents: [{ id: GONE_COORD, status: "idle", cwd: TEAM_WS }],
	askScript: [async () => { relTocEnv.setHiddenAgent(GONE_COORD, false); return "创建"; }],
});
relTocEnv.setHiddenAgent(GONE_COORD, true);
const relTocOut = await relTocEnv.run("n=1 team=night-shift roles=worker-a task=做接口");
check("U37 变异基线 3（写时复检 / TOCTOU）: 现任在确认框打开期间**复活** ⇒ 落笔前复检发现 ⇒ 中止且**零 roster 写入**（未释放、未认领、未登记新角色）、**pairs 也不写**（授权基础没了），报告点名原因与出路；已创建的会话照 §10.2.5 保留"
	+ (relTocOut.text.includes("释放并认领中止（§10.2.8.9 ② 写时复检）") && relTocOut.text.includes("已复活") ? "" : "（实测：" + show({ out: relTocOut.text }) + "）"),
	(() => {
		const tocReceipt = receiptTextOr(relTocEnv);
		const ok = relTocOut.kind === "error" && relTocOut.text.includes("释放并认领中止（§10.2.8.9 ② 写时复检）") && relTocOut.text.includes("已复活") && relTocEnv.store()[0].roles.length === 1 && coordOf(relTocEnv).current === GONE_COORD && relTocEnv.pairs().length === 0 && relTocEnv.creates.length === 1 && relTocOut.text.includes("未建立（§10.2.8.9 ② 写时复检中止")
			// 评审 round-1 🔵#5：回执也要点名这一步，不能只说「批量建队未全部成功」。
			&& typeof tocReceipt === "string" && tocReceipt.includes("释放并认领中止（现任复活 / 证据变化）");
		return ok || probe("U37 变异 3", { kind: relTocOut.kind, pairs: relTocEnv.pairs(), roles: relTocEnv.store()[0].roles, creates: relTocEnv.creates.length, out: relTocOut.text });
	})());

// --- §10.2.8.9 ② 的**第二个触发面**：roster 工具路径（upsert-team，无确认框 ⇒ 只靠证据门）----
const relToolEnv = teamEnv({ teams: [teamRow({ current: GONE_COORD, name: "night-shift" })], workspaceRegistryOptions: { archived: [GONE_COORD] } });
const relToolOut = await relToolEnv.tool("team_link_roster").execute({ action: "upsert-team", team: "night-shift" }, execFor(relToolEnv.senderAgent));
check("U36 第二个触发面（upsert-team）: 模型可发起、**没有确认框**的那条路上，只要确证现任已归档就照放行 —— 一次释放并认领，报告点名理由与「既有角色逐字未动」；没有人类点击可依靠，靠的只有证据门"
	+ (typeof relToolOut === "string" && relToolOut.includes("释放并接管") && coordOf(relToolEnv).current === "session-self" ? "" : "（实测：" + show({ out: relToolOut, coord: coordOf(relToolEnv) }) + "）"),
	typeof relToolOut === "string" && relToolOut.includes("释放并接管") && relToolOut.includes(RELEASE_NOTES.archived) && coordOf(relToolEnv).current === "session-self" && relToolEnv.store()[0].policy.writer === "coordinator");
const relToolRefuseEnv = teamEnv({ sessions: [{ header: { id: GONE_COORD, createdAt: 1, cwd: TEAM_WS }, live: false, persisted: true }], omitWorkspaceRegistry: true, teams: [teamRow({ current: GONE_COORD, name: "night-shift" })] });
const relToolRefuseOut = await relToolRefuseEnv.tool("team_link_roster").execute({ action: "upsert-team", team: "night-shift" }, execFor(relToolRefuseEnv.senderAgent));
check("U36 第二个触发面的边界: 服务**未提供**（甲）＋ 会话仍在（只归档）⇒ 工具路径也照旧拒绝（证据门没有按钮可以绕过），零写入、角色行一字未动",
	(() => {
		const ok = typeof relToolRefuseOut === "string" && relToolRefuseOut.includes("只有现任协调者会话") && relToolRefuseOut.includes("归档信号缺席") && coordOf(relToolRefuseEnv).current === GONE_COORD && relToolRefuseEnv.store()[0].roles.length === 1 && relToolRefuseEnv.store()[0].policy.writer === "coordinator";
		return ok || probe("U36 工具路径边界", { out: relToolRefuseOut, coord: coordOf(relToolRefuseEnv) });
	})());

// ---------------------------------------------------------------------------
// U16 端到端（确认 → 创建 → 配对）与 U18（血统 / 生命周期）与 U17（幂等 / 失败）
// ---------------------------------------------------------------------------

// --- the happy path: 确认 ⇒ 创建 + 配对, in one run --------------------------
const okEnv = teamSessionEnv({ askScript: ["创建"] });
const okOut = await okEnv.run("n=2 team=night-shift roles=worker-a,worker-b task=做接口 model=deepseek/deepseek-v4 preset=coder");
const okIds = okEnv.creates.map((options) => options.sessionId);
check("U16 端到端: confirmation creates exactly the planned sessions and drives each with one kickoff task", okEnv.creates.length === 2 && okIds.every((id) => id.startsWith("team-link-night-shift-")) && okEnv.created.every((item) => item.calls.followedup.length === 1) && okEnv.created.every((item) => item.calls.injected.length === 0));
check("U16 端到端: the pairs declared in the dialog are the pairs actually written (two-way with the coordinator, in the schema's canonical ratified shape)", okEnv.pairs().length === 2 && okEnv.pairs().every((pair) => pair.a === "session-self" && okIds.includes(pair.b)) && okEnv.pairs().every((pair) => pair.provisional === false && pair.expiresAt === 0));
check("U16 端到端: roster carries one row per created role seated on that worker's session id, plus the creation-path coordinator claim", okEnv.store()[0].roles.map((entry) => `${entry.role}=${entry.current}`).sort().join(",") === [...okIds.map((id) => `${id.split("-").slice(4, -1).join("-")}=${id}`), "coordinator=session-self"].sort().join(",") && okEnv.store()[0].roles.every((entry) => entry.history.length === 1 && entry.history[0].until === null));
check("U16 端到端: the summary reports the created ids, the roster write and the pairs, and claims no rollback", okOut.kind === "success" && okIds.every((id) => okOut.text.includes(id)) && okOut.text.includes("已登记 2 个角色") && okOut.text.includes("建立/确认 2 条双向免确认通道") && okOut.text.includes("一律保留、不回滚"));
check("U16 端到端: a run with a CLI-entered model= reaches both agentOptions and the dialog's model line", okEnv.creates.every((options) => options.agentOptions?.provider === "deepseek" && options.agentOptions?.model === "deepseek-v4") && okEnv.creates.every((options) => options.meta.agentPreset === "coder") && okEnv.uq.requests[0].questions[0].detail.includes("model=deepseek-v4"));

// --- U16 端到端（文法面）: a REAL command, through the handler ----------------
// §10.2.8.2 之后，这一组的**输入行自己**就换了语义：裸 token 是正文的起点，不再是角色名。
// 原来那条 `team=night-shift worker-a worker-b task=fix the bug` 在新文法下读成「team 一个参数
// + 正文 `worker-a worker-b task=fix the bug`」⇒ 只建 1 个 worker-1，而正文里的 `task=` **不再
// 被解析**（R2：进入正文后任何「字母＋等号」一律当正文逐字保留）—— 这正是 U30 的判据本身。
// 「两个角色各得一个会话」的那条断言没有消失：它搬到了用 `roles=` 声明的那条行上（下一组）。
const grammarEnv = teamSessionEnv({ askScript: ["创建"] });
const grammarBody = "worker-a worker-b task=fix the bug";
const grammarOut = await grammarEnv.run("team=night-shift " + grammarBody);
check("U16 端到端文法: 裸 token 归正文 —— `team=night-shift worker-a worker-b task=fix the bug` 只建 **1 个** worker-1（角色只能由 roles= 声明），roster 里只有 coordinator 与它", grammarEnv.creates.length === 1 && /^team-link-night-shift-worker-1-[0-9a-f]{8}$/u.test(grammarEnv.creates[0].sessionId) && grammarEnv.store()[0].roles.map((entry) => entry.role).sort().join(",") === "coordinator,worker-1" && grammarOut.kind === "success");
check("U16 端到端文法: 正文里的 `task=` **不被解析**（R2）—— 它连同前面的裸 token 一起逐字进了启动任务，而不是被切成参数", grammarEnv.created.length === 1 && grammarEnv.created[0].calls.followedup.length === 1 && grammarEnv.created[0].calls.followedup[0].content[0].text.includes("任务：" + grammarBody));
const quotedRunEnv = teamSessionEnv({ askScript: ["创建"] });
await quotedRunEnv.run("team=night-shift roles=worker-a task=\"fix the bug\"");
check("U16 端到端文法: a quoted task value reaches the kickoff message with no quote characters left in it", quotedRunEnv.created.length === 1 && quotedRunEnv.created[0].calls.followedup[0].content[0].text.includes("fix the bug") && !quotedRunEnv.created[0].calls.followedup[0].content[0].text.includes("\"fix the bug\""));
check("U16 端到端文法: the confirmation dialog body carries the same whole task text (the human sees what the workers will be told)", quotedRunEnv.uq.requests[0].questions[0].detail.includes("fix the bug"));
// The role→id lookup is by ROLE, not by position (a positional helper that is
// named after the role keeps passing on a reordered batch and hides the swap).
// 两个角色的会话由 `roles=` 声明 —— 这是 §10.2.8.2 之后声明角色的**唯一**拼法。
const grammarRolesEnv = teamSessionEnv({ askScript: ["创建"] });
await grammarRolesEnv.run("team=night-shift roles=worker-a,worker-b");
check("U16 端到端文法: each role resolves to its own session id (the lookup reads the id's role segment, not the create order)", grammarRolesEnv.creates.length === 2 && plannedId(grammarRolesEnv, "night-shift", "worker-a") === grammarRolesEnv.creates[0].sessionId && plannedId(grammarRolesEnv, "night-shift", "worker-b") === grammarRolesEnv.creates[1].sessionId && plannedId(grammarRolesEnv, "night-shift", "worker-a") !== plannedId(grammarRolesEnv, "night-shift", "worker-b"));

// --- U18: 血统 (the meta carries cwd/agentPreset and nothing else) -----------
check("U18 血统: meta carries exactly {cwd, agentPreset} — no origin / parentSession / delegationDepth", okEnv.creates.every((options) => Object.keys(options.meta).sort().join(",") === "agentPreset,cwd") && okEnv.creates.every((options) => options.meta.origin === undefined && options.meta.parentSession === undefined && options.meta.delegationDepth === undefined && options.meta.isSeeded === undefined));
check("U18 血统: no parentAgent and no seed — the session is a ROOT session, not a subagent (§10.3)", okEnv.creates.every((options) => options.parentAgent === undefined && options.seed === undefined && options.inheritedEventCount === undefined));
check("U18 血统: the session ids follow team-link-<team>-<role>-<uuid8> and the cwd is the caller's absolute path", okIds.every((id) => /^team-link-night-shift-worker-[ab]-[0-9a-f]{8}$/u.test(id)) && okEnv.creates.every((options) => path.isAbsolute(options.meta.cwd) && options.meta.cwd === TEAM_WS));
// --- DEFECT-1（§10.2.2 模板 = `dsh-webhook`）: preset 缺省也解析，且总是挂载 ---
// 真机缺陷 #1：`preset=` 没给时整条 preset 路径被跳过 ⇒ 会话**建出来了**却没有
// persona-prefix 的组装源，首回合直接死在 `prompt variable "{{model}}" has no value
// for this assembly (section "deployment:persona-prefix")`。所以这里的判据不是
// 「建出来了」，而是「这个会话既在 `meta` 里记着某个 preset、又真的被挂到那个 preset
// 的组成上，且恰好挂一次」——下面的读数就是判据本身，缺省与显式两个 env 共用。
// `agentPresets` 仍是**可选**服务（不进模块级 inject），但它缺席是**唯一**允许
// 的上游分支，且必须留一行 warn。

const noPresetEnv = teamSessionEnv({ askScript: ["创建"] });
const noPresetOut = await noPresetEnv.run("n=2 team=defect1 roles=worker-a,worker-b task=验缺省 preset");
check("DEFECT-1 缺省也解析: 没给 preset= 时仍然调用 resolve(undefined)（宿主的 defaultId）并把真实 preset id 写进 meta —— 「有才挂」那条分支不存在了", noPresetOut.kind === "success" && noPresetEnv.agentPresets.resolved.length === noPresetEnv.creates.length && noPresetEnv.agentPresets.resolved.every((id) => id === undefined) && noPresetEnv.creates.every((options) => options.meta.agentPreset === STUB_DEFAULT_PRESET) && noPresetEnv.agentPresets.standings.length === noPresetEnv.creates.length && noPresetEnv.agentPresets.standings.every((id) => id === STUB_DEFAULT_PRESET));
check("DEFECT-1 总是挂载: 每个新会话的 preset 各挂**恰一次**，且挂的就是 meta 里那一个（真机现象的反面：persona-prefix 组装源真的接上了）", presetBoundOnce(noPresetEnv) && noPresetEnv.agentPresets.mounts.length === noPresetEnv.creates.length && presetBindingOf(noPresetEnv).every((row) => row.mountedId === STUB_DEFAULT_PRESET));
check("DEFECT-1 判据是「能用」不是「建出来了」: 每条 mount 绑定的 agentCtx 就是**那个会话自己的** setup 上下文（同一个对象、agentId 即会话 id），不是别人的、也不是空上下文", noPresetEnv.created.length === 2 && noPresetEnv.created.every((item) => item.agent.setupCtx?.agentId === item.agent.id && noPresetEnv.agentPresets.mounts.filter((entry) => entry.ctx === item.agent.setupCtx).length === 1));
check("U18 preset= 显式给出: 走的是**同一条**代码（resolve(\"coder\") → meta → mount 恰一次），不是缺省路径之外的第二个分支", okEnv.agentPresets.resolved.length === 2 && okEnv.agentPresets.resolved.every((id) => id === "coder") && presetBoundOnce(okEnv) && okEnv.agentPresets.mounts.every((entry) => entry.id === "coder"));
// The degradation is NAMED and it is the ONLY branch that can skip the preset:
// the session is still created AND driven, and one line per session says what
// the missing composition costs (the setup callback really runs — the stub awaits
// it, as the factory does — so this is the composed path's own line).
const noPresetServiceEnv = teamSessionEnv({ askScript: ["创建"], omitAgentPresets: true });
// ⚠ 2026-09-22（§10.2.8.2 默认值第 4 条落码后改夹具，**判据文本一字未改**）：**五具**夹具原本是**无正文无 task=**
// 它们分别是 DEFECT-1 服务缺席降级（本具）· DEFECT-2 服务缺席降级 · DEFECT-4 服务缺席降级 · DEFECT-4 rename 抛错 · U17 保留（后四处各带一行 INLINE 指针）——
// 的行，而新默认是「只建会话、不投启动任务」——「照建**照驱动**」这条claim 于是失去触发条件。给它们补上 `task=`
// 是**保住原有覆盖**（缺服务时那两件事仍然都要发生），不是把断言改软；新默认自己有专门的断言（U30 默认值第 4 条）。
const noPresetServiceOut = await noPresetServiceEnv.run("n=2 team=defect1 roles=worker-a,worker-b task=验降级仍驱动");
check("DEFECT-1 降级（唯一允许跳过的分支）: agentPresets 服务缺席 ⇒ 零 mount、meta 只剩 cwd、每个新会话恰一行 warn，而会话照建、照驱动（不因服务缺失让整条创建失败）", noPresetServiceEnv.creates.length === 2 && noPresetServiceEnv.agentPresets.mounts.length === 0 && noPresetServiceEnv.creates.every((options) => Object.keys(options.meta).sort().join(",") === "cwd") && presetServiceWarns(noPresetServiceEnv).length === 2 && noPresetServiceEnv.created.every((item) => item.calls.followedup.length === 1) && noPresetServiceOut.kind === "success");
check("DEFECT-1 降级: 那行 warn 说清了后果（没有 persona-prefix 组装源、首回合可能起不来），不是一句无声的「跳过了」", presetServiceWarns(noPresetServiceEnv).length === 2 && presetServiceWarns(noPresetServiceEnv).every((line) => line.includes("persona-prefix")));
// A preset that IS named but cannot be resolved is a REAL failure, not a reason
// to create an uncomposable session: `buildTeamSessionCreateOptions` throws, the
// batch reports it, and no session is created (宁可不建).
const bogusPresetEnv = teamSessionEnv({ askScript: ["创建"] });
const bogusPresetOut = await bogusPresetEnv.run("n=1 team=defect1 roles=worker-a preset=nope");
check("DEFECT-1 不静默降级: preset= 指了一个解析不出来的 id ⇒ 创建失败并如实报出原因（`not found`），零创建", bogusPresetEnv.creates.length === 0 && bogusPresetOut.kind === "error" && bogusPresetOut.text.includes("not found") && bogusPresetOut.text.includes("创建失败"));

// --- DSH 0.2.0-rc.1 宿主换代: preset pin `standingKeyFor` → `acquireScope` -------
// 真机（2026-09-29 15:35 / 15:46 两次，团队 mal-analyze-cli-20260929，n=4）：宿主
// 自动升到 0.2.0-rc.1 后 `/team_session` 连续失败，回执「批量建队未全部成功」，命令
// 输出逐字是 `未创建（创建失败（agentPresets.standingKeyFor is not a function））`，
// worker-2/3/4 按失败即停未尝试、团队零落地。根因：pin API 在现宿主上改名
// `acquireScope`（注册面签名 `async acquireScope(id?): Promise<{ key: ScopeKey } &
// AsyncDisposable`），而本插件的创建路径还在调旧名——默认夹具此前**只有**
// `standingKeyFor`，把「按官方模板写、按自家桩验」的镜像盲区原样留给了真机。
// 四具夹具把宿主 pin 面建模成可切换形状（`makeAgentPresets` 的 `pinSurface`）：
// 现名可用就走现名 / 只有旧名时回退 / 两名都在时仍只走现名 / 两个都没有时显式点名
// 断层（不再是裸 TypeError 当错误文案）。
const pinCurrentEnv = teamSessionEnv({ askScript: ["创建"] });
const pinCurrentOut = await pinCurrentEnv.run("n=2 team=pin-surface roles=worker-a,worker-b task=验现名 pin");
check("pin 换代（现名）: 0.2.0-rc.1 形状（只有 acquireScope）下批量建队照常成立 —— pin 走的就是现名，旧名一次都没被调，preset 绑定判据不变", pinCurrentOut.kind === "success" && pinCurrentEnv.agentPresets.acquired.length === pinCurrentEnv.creates.length && pinCurrentEnv.agentPresets.acquired.every((id) => id === STUB_DEFAULT_PRESET) && pinCurrentEnv.agentPresets.legacyPinned.length === 0 && presetBoundOnce(pinCurrentEnv));
const pinBothEnv = teamSessionEnv({ askScript: ["创建"], agentPresetsOptions: { pinSurface: "both" } });
const pinBothOut = await pinBothEnv.run("n=1 team=pin-surface roles=worker-a");
check("pin 换代（优先现名）: 两代方法都在场时只走 acquireScope，standingKeyFor 一次都不被调（回退是留给 0.1.x 宿主的，不是给新宿主的）", pinBothOut.kind === "success" && pinBothEnv.agentPresets.acquired.length === 1 && pinBothEnv.agentPresets.legacyPinned.length === 0);
const pinLegacyEnv = teamSessionEnv({ askScript: ["创建"], agentPresetsOptions: { pinSurface: "legacy" } });
const pinLegacyOut = await pinLegacyEnv.run("n=1 team=pin-surface roles=worker-a");
check("pin 换代（旧名回退）: 宿主只有 standingKeyFor（0.1.x 一代）时批量建队仍成立 —— 回退分支不是死代码", pinLegacyOut.kind === "success" && pinLegacyEnv.agentPresets.legacyPinned.length === 1 && pinLegacyEnv.agentPresets.acquired.length === 0 && presetBoundOnce(pinLegacyEnv));
const pinNoneEnv = teamSessionEnv({ askScript: ["创建"], agentPresetsOptions: { pinSurface: "none" } });
const pinNoneOut = await pinNoneEnv.run("n=2 team=pin-surface roles=worker-a,worker-b");
check("pin 换代（断层点名）: 两个 pin 方法都没有 ⇒ 创建失败且错误文案点名两代已知形状与断层（含两个方法名），不再是裸 TypeError —— 零创建、零 pairs", pinNoneOut.kind === "error" && pinNoneOut.text.includes("acquireScope") && pinNoneOut.text.includes("standingKeyFor") && pinNoneOut.text.includes("创建失败") && !pinNoneOut.text.includes("is not a function") && pinNoneEnv.creates.length === 0 && pinNoneEnv.pairs().length === 0);
// 组成面**另一半**的形状断层（代码评审 🟡/🔵 同批）：旧守卫只判 `resolve`，`mount` 是在
// `setup` 里裸调的 ⇒ 宿主某代改掉 `mount` 的名字，用户会看到裸 `TypeError: agentPresets.mount
// is not a function` 当错误文案（0.4.2 `standingKeyFor` 换代那两次翻车的原文形状）。判据与
// 复活面同一条：形状断层**显式点名**，且零创建。
const pinNoMountEnv = teamSessionEnv({ askScript: ["创建"], agentPresetsOptions: { omitMount: true } });
const pinNoMountOut = await pinNoMountEnv.run("n=2 team=pin-surface roles=worker-a,worker-b");
check("组成面（mount 缺失·形状断层）: 服务在场但只有 `resolve`、没有 `mount` ⇒ 显式点名断层（两个读数都写出来）且零创建、零 pairs，不再是裸 TypeError", pinNoMountOut.kind === "error" && pinNoMountOut.text.includes("组成面形状断层") && pinNoMountOut.text.includes("mount=undefined") && pinNoMountOut.text.includes("resolve=function") && !pinNoMountOut.text.includes("is not a function") && pinNoMountEnv.creates.length === 0 && pinNoMountEnv.pairs().length === 0);

// 释放面（2026-09-29 同日补）：`standingKeyFor` → `acquireScope` **不是纯改名** ——
// 宿主注册面的实现是 `retain(id)` ＋ 一个 `[Symbol.asyncDispose]` 句柄（`users--` ＋
// `collect()`），文档原话「A revision lease; dispose it after the scoped read
// completes」；官方模板 `dsh-webhook:158` 用 `await using` 取、`:216` 在 `finally` 释放。
// 只改名、不改释放时序 ⇒ 每建一个会话泄一个租约（该 generation 的 `users` 永不归零、
// 永不被回收）。三条判据分别钉住：正常路径还、失败路径也还、旧代不伪造句柄。
check("pin 换代（租约必须释放）: 现宿主形状下**每个**创建的会话都恰好取一次 preset 租约、并恰好释放一次 —— `acquireScope` 返回的是可释放租约，不是可以丢掉的返回值", pinCurrentEnv.agentPresets.acquired.length === pinCurrentEnv.creates.length && pinCurrentEnv.agentPresets.released.length === pinCurrentEnv.creates.length && pinCurrentEnv.agentPresets.released.join(",") === pinCurrentEnv.agentPresets.acquired.join(","));
const pinFailEnv = teamSessionEnv({ askScript: ["创建"], failCreateAt: 0 });
const pinFailOut = await pinFailEnv.run("n=1 team=pin-surface roles=worker-a");
check("pin 换代（失败也要还）: `agents.create` 抛错时租约**仍**被释放（与官方模板同序：释放落在 `finally`，不是「建成功了才还」）—— 泄漏判据不因失败路径放行", pinFailOut.kind === "error" && pinFailEnv.agentPresets.acquired.length === 1 && pinFailEnv.agentPresets.released.length === 1);
check("pin 换代（旧代不伪造释放）: 0.1.x 形状（只有 `standingKeyFor`，返回纯值、没有可释放句柄）下照常建队，且**不**凭空造一个 dispose 去调 —— 释放面只在真取到租约时存在", pinLegacyOut.kind === "success" && pinLegacyEnv.agentPresets.legacyPinned.length === 1 && pinLegacyEnv.agentPresets.acquired.length === 0 && pinLegacyEnv.agentPresets.released.length === 0 && presetBoundOnce(pinLegacyEnv));
const pinHandleProbe = makeAgentPresets();
const pinHandleScope = await pinHandleProbe.service.acquireScope("coder");
await pinHandleScope[Symbol.asyncDispose]();
await pinHandleScope[Symbol.asyncDispose]();
check("pin 换代（句柄幂等 · 控制项）: 同一个 `acquireScope` 句柄重复 dispose 只记一次 released —— 证明上面那条「恰好一次」的读数不是靠重复计数凑出来的（桩真能区分「还了」与「还了两次」）", pinHandleProbe.released.length === 1);

// --- DEFECT-2（§10.2.2 模板的**时序**）：workspace 建 → meta.cwd → attach ------
// 真机缺陷 #2：那个会话**在盘上、cwd 也对**，但**没有工作区归属**——侧边栏按工作区
// 分组时列不出它，用户得手动切工作区才找得到自己刚建出来的 worker。模板
// `createWebhookSession` 做的是**完整时序**：`workspaceRegistry.create`（:96）→
// `meta.cwd = workspace.path`（:103）→ `agents.create` → `workspace.attachSession`
// （:115）。所以判据不是「会话建出来了」，而是「它真的在那份工作区的成员名单里」，
// 且写进 meta 的路径就是 registry 给的那一个。
const wsEnv = teamSessionEnv({ askScript: ["创建"] });
const wsOut = await wsEnv.run("n=2 team=defect2 roles=worker-a,worker-b task=验工作区归属");
check("DEFECT-2 ② 建/取工作区: `workspaceRegistry.create` 每个新会话**恰一次**，路径就是调用会话的 cwd（绝对）", wsOut.kind === "success" && wsEnv.workspaceRegistry.creates.length === wsEnv.creates.length && wsEnv.workspaceRegistry.creates.every((entry) => path.isAbsolute(entry) && entry === TEAM_WS));
check("DEFECT-2 ② 挂进工作区: `attachSession` **恰一次**且 id 就是**这个会话自己的** id —— 不是「建完就不管了」", wsEnv.creates.length === 2 && workspaceBoundOnce(wsEnv) && workspaceBindingOf(wsEnv).every((row) => row.attached === 1));
check("DEFECT-2 ② 判据是「侧边栏看得到」不是「盘上有会话」: 每个新会话真的在那份工作区的成员名单里（membership 才是分组所读的东西）", wsEnv.workspaceRegistry.workspaces.length === 2 && wsEnv.creates.every((options) => wsEnv.workspaceRegistry.workspaces.some((workspace) => workspace.has(options.sessionId))) && wsEnv.workspaceRegistry.detached.length === 0);
// `meta.cwd` 必须取自 registry 的 `path`（模板 :103），不是把调用方 cwd 原样透传——
// 真实 `attachSession` 拿会话 header 里 realpath 过的 cwd 与 workspace 记录比对，
// 两者不同一就会被拒。让 registry 归一化出一个**不同的**路径，这个读数才可观测。
const normWsEnv = teamSessionEnv({ askScript: ["创建"], workspaceRegistryOptions: { normalize: (workspacePath) => `${workspacePath}/` } });
const normWsOut = await normWsEnv.run("n=1 team=defect2 roles=worker-a");
check("DEFECT-2 ② meta.cwd 来自 workspace.path（模板 :103）: registry 归一化后的路径才是写进 meta 与 attach 的那一个，调用方 cwd 不是直通（源码里那句话可被行为观测）", normWsOut.kind === "success" && normWsEnv.workspaceRegistry.creates[0] === TEAM_WS && normWsEnv.creates[0].meta.cwd === `${TEAM_WS}/` && workspaceBoundOnce(normWsEnv));
// 服务缺席是**唯一**允许跳过 workspace 面的分支（§10.3：不许为了它把模块级 inject
// 撑大 ⇒ 走 `ctx.get`）。降级但绝不静默：会话照建照驱动，每个会话一行 warn。
const noWsServiceEnv = teamSessionEnv({ askScript: ["创建"], omitWorkspaceRegistry: true });
const noWsServiceOut = await noWsServiceEnv.run("n=2 team=defect2 roles=worker-a,worker-b task=验降级仍驱动"); // task= 是 2026-09-22 加的：无正文无 task= 的行不再驱动（见本行上方 ⚠ 说明）
check("DEFECT-2 降级（唯一允许跳过的分支）: workspaceRegistry 缺席 ⇒ 零 attach、零工作区创建、meta.cwd 回落到调用方 cwd，而会话照建、照驱动（不因服务缺失让整条创建失败）", noWsServiceEnv.creates.length === 2 && noWsServiceEnv.workspaceRegistry.attached.length === 0 && noWsServiceEnv.workspaceRegistry.creates.length === 0 && noWsServiceEnv.creates.every((options) => options.meta.cwd === TEAM_WS) && noWsServiceEnv.created.every((item) => item.calls.followedup.length === 1) && noWsServiceOut.kind === "success");
check("DEFECT-2 降级不静默: 恰一行 warn/会话，且点名「未挂进工作区，可能不会出现在侧边栏」——正是用户当时找不到会话的那个现象", workspaceServiceWarns(noWsServiceEnv).length === 2 && workspaceServiceWarns(noWsServiceEnv).every((line) => line.includes("未挂进工作区，可能不会出现在侧边栏")));
// 回滚（模板 :135-147）：失败的创建不留下半个已挂载的会话 —— attach 抛错 ⇒
// detach（幂等）+ `handle.dispose()`，**原错误照抛**（回滚失败不许顶替原始失败）。
// 两条 fixture：直接拒绝，以及「已注册之后才抛」的半成品——后者正是 `attached` 标志
// 会漏掉的状态（真实 attachSession 先 rememberSessionPath 再写记录）。
const refuseAttachEnv = teamSessionEnv({ askScript: ["创建"], workspaceRegistryOptions: { refuseAttach: true } });
const refuseAttachOut = await refuseAttachEnv.run("n=1 team=defect2 roles=worker-a");
const refuseAttachId = refuseAttachEnv.creates[0]?.sessionId;
check("DEFECT-2 回滚: attach 失败 ⇒ detachSession **恰一次**（同一个会话 id）+ handle 被 dispose（代理不在注册表里、无 controller handle），批次如实报「创建失败」，零 followup", refuseAttachEnv.creates.length === 1 && refuseAttachEnv.workspaceRegistry.attached.length === 1 && refuseAttachEnv.workspaceRegistry.detached.length === 1 && refuseAttachEnv.workspaceRegistry.detached[0].sessionId === refuseAttachId && refuseAttachEnv.agentFor(refuseAttachId) === undefined && sessionControllerFor(refuseAttachEnv.ctx).hasHandle(refuseAttachId) === false && refuseAttachEnv.created.every((item) => item.calls.followedup.length === 0) && refuseAttachOut.kind === "error" && refuseAttachOut.text.includes("创建失败"));
check("DEFECT-2 回滚: 原错误照抛（回滚不许顶替它），且回滚本身成功时不留回滚失败 warn（attach 失败是唯一那条 warn 之外的噪音才叫问题）", refuseAttachOut.text.includes("stub workspace refused attach") && refuseAttachEnv.log.lines.warn.filter((line) => line.includes("rollback")).length === 0);
const halfAttachEnv = teamSessionEnv({ askScript: ["创建"], workspaceRegistryOptions: { registerThenRefuse: true } });
const halfAttachOut = await halfAttachEnv.run("n=1 team=defect2 roles=worker-a");
const halfAttachId = halfAttachEnv.creates[0]?.sessionId;
check("DEFECT-2 回滚（半成品）: attach 已把会话写进成员名单之后才抛错 ⇒ detach 仍被调用、成员名单里不留它（`attached` 标志在这里是 false——靠它就漏掉了这个半状态）", halfAttachEnv.workspaceRegistry.attached.length === 1 && halfAttachEnv.workspaceRegistry.detached.length === 1 && halfAttachEnv.workspaceRegistry.detached[0].sessionId === halfAttachId && halfAttachEnv.workspaceRegistry.workspaces.every((workspace) => workspace.has(halfAttachId) === false) && halfAttachOut.kind === "error");

// --- DEFECT-3（§10.2.2 模板的第三块）：缺省模型选择也必须解析 -------------------
// 真机缺陷 #3：DEFECT-1 只补了「装配源」（preset 的 resolve + mount），**没补那个变量
// 的值**——`deployment:persona-prefix` 里的 `{{model}}` 取的是
// `context.agent.options.model`（`dsh-agent-loop` 的
// `ctx.systemPrompt.variable("model", (context) => context.agent?.options.model)`），
// 而我们没给 model= 时 `agentOptions` 是**空的** ⇒ 整个 `agentOptions` 都不传 ⇒
// 编程创建的 agent 没有任何模型选择 ⇒ 首回合死在
// `prompt variable "{{model}}" has no value`。官方模板 `resolveRequest`
// （`dsh-webhook/lib/index.js:30-36`）在**没给** model 时也解析：`currentSelection()`
// ⇒ `agentOptions = {provider, model}`，并把同一份 selection 装进 `setup`（第 9 步）。
// 所以判据有两个面，缺一不可：**写进 `agentOptions` 的那一对**，与**装在 setup 上的
// 模型选择**——它们都取自 `currentSelection()` 那一刻的读数。

const modelDefaultEnv = teamSessionEnv({ askScript: ["创建"] });
const modelDefaultOut = await modelDefaultEnv.run("n=2 team=defect3 roles=worker-a,worker-b task=验缺省模型选择");
const defaultModelRows = modelSelectionOf(modelDefaultEnv);
check(`DEFECT-3 ② 缺省也解析: 没给 model= 时 \`agentOptions\` **必带** provider/model（此前整个 agentOptions 都不传），且逐字等于 \`currentSelection()\` 的读数${defaultModelRows.every((row) => row.provider === STUB_DEFAULT_PROVIDER && row.model === STUB_DEFAULT_MODEL) ? "" : `（实测：${show(defaultModelRows)}）`}`, modelDefaultOut.kind === "success" && modelDefaultEnv.creates.length === 2 && modelDefaultEnv.creates.every((options) => options.agentOptions?.provider === STUB_DEFAULT_PROVIDER && options.agentOptions?.model === STUB_DEFAULT_MODEL) && modelDefaultEnv.agentDefaultModel.calls.length === modelDefaultEnv.creates.length);
check("DEFECT-3 ② 模型选择装进 agent（模板第 9 步）: `installTeamSessionModelSelection` 真的被调用 —— 每个新会话的 setup 上下文上都挂着 `agent/request` 钩子，且那个上下文就是**这个会话自己的**", modelDefaultEnv.created.length === 2 && modelSelectionBoundOnce(modelDefaultEnv) && defaultModelRows.every((row) => row.setupAgentId === row.id));
// 「装了」还不够：钩子**带的是哪一对**要可观测。缺省 path 下把继承来的 reasoningEffort
// 抹掉、换路由则原样放行——这正是模板 `installInitialModelSelection` 的语义，也正是
// 「写进 agentOptions 的那一对」与「装在 setup 上的那一对」同源的证据。
const defaultHookSame = await probeModelHook(modelDefaultEnv.created[0]?.agent, { provider: STUB_DEFAULT_PROVIDER, model: STUB_DEFAULT_MODEL, reasoningEffort: "high" });
const defaultHookOther = await probeModelHook(modelDefaultEnv.created[0]?.agent, { provider: "someone-else", model: "other-model", reasoningEffort: "high" });
check(`DEFECT-3 ② 判据是「能用」不是「装了」: 钩子携带的就是缺省那一对（同名路由 ⇒ 抹掉继承来的 reasoningEffort；换路由 ⇒ 原样放行）${defaultHookSame.installed === true && defaultHookOther.installed === true && defaultHookSame.out.reasoningEffort === undefined && defaultHookOther.out.reasoningEffort === "high" ? "" : `（实测：${show({ same: defaultHookSame, other: defaultHookOther })}）`}`, defaultHookSame.installed === true && defaultHookSame.out.provider === STUB_DEFAULT_PROVIDER && defaultHookSame.out.model === STUB_DEFAULT_MODEL && defaultHookSame.out.reasoningEffort === undefined && defaultHookOther.installed === true && defaultHookOther.out.reasoningEffort === "high");
// 显式给了 provider/model ⇒ 走同一条创建路径、行为不变，且**不去问**缺省服务。
check("DEFECT-3 显式 model= 行为不变: agentOptions 就是命令行给的那一对，同样装上模型选择钩子，且缺省服务一次都没被问过（缺省分支不是第二个创建分支）", okEnv.creates.every((options) => options.agentOptions?.provider === "deepseek" && options.agentOptions?.model === "deepseek-v4") && okEnv.created.length === 2 && okEnv.created.every((item) => typeof item.agent.setupCalls?.["agent/request"] === "function") && okEnv.agentDefaultModel.calls.length === 0);
// ② 与 ③a 共用**一个**创建函数（`createRootAgent` → `buildTeamSessionCreateOptions`），
// 所以两条路径的模型选择读数是**同一个形状**、缺省服务各被问了一次——把「同一函数」这件事
// 也钉成读数（auto 路径没有自己的第二份创建实现，也就没有第二处会漏掉模型选择）。
const modelShapeRows = [...modelSelectionOf(modelDefaultEnv), ...modelSelectionOf(autoEnv)];
const modelShape = modelShapeRows.map((row) => [row.provider, row.model, row.hook].join("|"));
check(`DEFECT-3 ②/③a 同源: 两条路径三处创建的选择形状完全一致（provider/model/钩子），且缺省模型服务各被问了一次（② 每会话一次、③a 恰一次）${new Set(modelShape).size === 1 && modelShapeRows.length === 3 ? "" : `（实测：${show({ modelShape, calls: [modelDefaultEnv.agentDefaultModel.calls.length, autoEnv.agentDefaultModel.calls.length] })}）`}`, modelShapeRows.length === 3 && new Set(modelShape).size === 1 && modelDefaultEnv.agentDefaultModel.calls.length === modelDefaultEnv.creates.length && autoEnv.agentDefaultModel.calls.length === 1);
// 服务缺席 ⇒ **拒绝创建**（选定口径，二选一里更硬的那个）：没有它就没有可解析的缺省
// 模型，造出来的 agent 就是跑不起来的。零创建、零 pairs、零 roster 行，报告点名原因。
const noModelServiceEnv = teamSessionEnv({ askScript: ["创建"], omitAgentDefaultModel: true });
const noModelServiceOut = await noModelServiceEnv.run("n=2 team=defect3 roles=worker-a,worker-b");
check("DEFECT-3 ② 服务缺席 fail-visible（选定口径=拒绝创建）: 零创建、零 pairs、零 roster 行，报告点名缺的是 agentDefaultModel 与后果（宁可不建，也不建一个跑不起来的会话）", noModelServiceEnv.creates.length === 0 && noModelServiceEnv.pairs().length === 0 && noModelServiceEnv.store().length === 0 && noModelServiceOut.kind === "error" && noModelServiceOut.text.includes("agentDefaultModel") && noModelServiceOut.text.includes("真机缺陷 #3") && noModelServiceOut.text.includes("创建失败"));
check("DEFECT-3 ② 服务缺席不静默: 拒绝文案说清了「没有它 ⇒ 没有可解析的缺省模型 ⇒ 新会话跑不起来」，并给出两条出路（显式 model= / 让服务可用），不是一句无声的跳过", noModelServiceOut.text.includes("宁可不建") && noModelServiceOut.text.includes("model=<provider>/<model>") && noModelServiceOut.text.includes("service"));
// 服务**在**、但读不出可用的 provider/model：写进 agentOptions 的就是那一对，undefined
// 会原样复现同一个真机缺陷 ⇒ 同样拒绝（这是同一口径的第二种触发方式，不是新增语义）。
const emptyModelEnv = teamSessionEnv({ askScript: ["创建"], agentDefaultModelOptions: { provider: "", model: "" } });
const emptyModelOut = await emptyModelEnv.run("n=1 team=defect3 roles=worker-a");
check("DEFECT-3 ② 服务在但读不出可用的 provider/model ⇒ 同样拒绝创建（写进 agentOptions 的就是 currentSelection() 那一对，空值会原样复现同一个真机缺陷）", emptyModelEnv.creates.length === 0 && emptyModelOut.kind === "error" && emptyModelOut.text.includes("currentSelection") && emptyModelOut.text.includes("真机缺陷 #3"));
// 服务只服务**缺省分支**：显式给了 model= 时它缺席不该拦住创建（拒绝不是一刀切）。
const explicitNoServiceEnv = teamSessionEnv({ askScript: ["创建"], omitAgentDefaultModel: true });
const explicitNoServiceOut = await explicitNoServiceEnv.run("n=1 team=defect3 roles=worker-a model=deepseek/deepseek-v4");
check("DEFECT-3 服务只服务缺省分支: 显式给了 model= 时 agentDefaultModel 缺席不影响创建（拒绝只针对解析不出缺省的那条路）", explicitNoServiceEnv.creates.length === 1 && explicitNoServiceOut.kind === "success" && explicitNoServiceEnv.creates[0].agentOptions?.provider === "deepseek" && explicitNoServiceEnv.creates[0].agentOptions?.model === "deepseek-v4");

// ---------------------------------------------------------------------------
// DEFECT-4（真机缺陷 #4）：编程创建的会话必须有一个**可区分**的默认标题
// ---------------------------------------------------------------------------
// 真机现象（用户原话）：「可以看到新的会话，不过**会话名称都是 `dsh-session-link-pro`**」
// ——新建的 worker 标题全是**工作区名**，侧边栏里互相无法区分。根因是插件**刻意不设标题**
// （当时的理由是「命名是用户可见的交互决定，三个 worker 该叫什么？设计没给就不自造」）；
// **这个判断是错的**：不设标题**不等于**不替用户决定——**默认值（工作区名）本身就是一个
// 很糟的决定**。官方模板 `dsh-webhook` 第 8 步是
// `ctx.sessionTitle.rename(handle.agent.session, resolved.title)`（`lib/index.js:119`）。
//
// 修法：按**已有的结构化信息**派生标题（不新造随机数、不读工作区名）：`<team> · <role>`；
// 缺一宁可回落到 `<team>` 或会话 id 的短前缀，**绝不回落成工作区名**（那正是本缺陷）。
// 判据按**会话 id 配对**逐会话核对（`sessionTitleOf`）——「rename 被调用过几次」这种计数
// 对「两个会话都被命名成同一个常量」照样全绿，是空锁。
const wsTitleRows = sessionTitleOf(wsEnv).map((row) => ({
	...row,
	expected: row.id === plannedId(wsEnv, "defect2", "worker-a") ? "defect2 · worker-a" : row.id === plannedId(wsEnv, "defect2", "worker-b") ? "defect2 · worker-b" : null,
}));
check(`DEFECT-4 ② 逐会话命名（按 role 派生）: 每个新会话各被命名一次，且标题就是它自己的 \`<team> · <role>\`——不是工作区名、不是会话 id${wsTitleRows.length === 2 && wsTitleRows.every((row) => row.renames === 1 && row.expected !== null && row.title === row.expected) ? "" : `（实测：${show(wsTitleRows)}）`}`, wsTitleRows.length === 2 && wsTitleRows.every((row) => row.renames === 1 && row.expected !== null && row.title === row.expected && row.title !== path.basename(TEAM_WS)));
// 判据 ④（可区分性）：同一批里不同 role 的标题**两两不同**；而且**同名 role 换一个团队**
// 也不再同名——这正是 `<team> · <role>` 相对「只写 role」的价值，也是用户真正要的那件事。
const crossTeamEnv = teamSessionEnv({ askScript: ["创建"] });
const crossTeamOut = await crossTeamEnv.run("n=2 team=alpha roles=worker-a,worker-b");
const distinctTitleRows = [...sessionTitleOf(wsEnv), ...sessionTitleOf(crossTeamEnv)];
const distinctTitles = distinctTitleRows.map((row) => row.title);
check(`DEFECT-4 ② 可区分性: 同一批里不同 role 的标题两两不同，同名 role 在两个团队之间也不同名（${distinctTitleRows.length} 个标题全不重复，且无一等于工作区名或会话 id）${new Set(distinctTitles).size === distinctTitles.length ? "" : `（实测：${show(distinctTitles)}）`}`, distinctTitleRows.length === 4 && new Set(distinctTitles).size === 4 && distinctTitleRows.every((row) => typeof row.title === "string" && row.title !== path.basename(TEAM_WS) && row.title !== row.id) && crossTeamOut.kind === "success");
// 判据 ⑤（**缺口2**：DEFECT-4 的派生边界）：团队名只受 `[a-z0-9-]+` 约束、**没有长度上限**，
// 而宿主按 `maxTitleBytes: 80`（UTF-8 字节；`dsh-base/cordis.patch.yml:60`）**剪尾巴**——
// 被剪掉的恰好是 role 段，于是同一队两个 role 撞成同一个前缀：可区分性在这一档整段失效
// （修前实测：79 字节的团队名把两个标题都剪成 `…-then-some ` 这一模一样的前缀）。
// 修法：**团队段过长就截团队**（保留可辨识前缀 + 省略号），**role 段一个字节都不许少**。
const LONG_TEAM = "team-with-an-extremely-long-name-that-eats-the-whole-title-budget-and-then-some";
const longTeamEnv = teamSessionEnv({ askScript: ["创建"] });
const longTeamOut = await longTeamEnv.run(`n=2 team=${LONG_TEAM} roles=worker-a,worker-b`);
/** 上游 `dsh-session-title` 的截断语义（`truncateTitleUtf8`，`lib/index.js:33-45`）：保留能装进
 * 预算的最长码点前缀、**不追加任何标记**。于是「写进 rename 的标题」与「落盘的标题」只在这份
 * 派生值**自己**超预算时才不同——而那时被剪掉的正是尾巴（role）。这条判据因此断言两件事：
 * 落盘值两两不同，且**派生值本身**已在预算之内（上游那一剪根本咬不到 role）。 */
const upstreamTitle = (title) => {
	if (typeof title !== "string") return null;
	let used = 0;
	let out = "";
	if (Buffer.byteLength(title, "utf8") <= 80) return title;
	for (const character of title) {
		const bytes = Buffer.byteLength(character, "utf8");
		if (used + bytes > 80) break;
		out += character;
		used += bytes;
	}
	return out;
};
const longTitleRows = sessionTitleOf(longTeamEnv).map((row) => ({
	...row,
	role: row.id === plannedId(longTeamEnv, LONG_TEAM, "worker-a") ? "worker-a" : "worker-b",
}));
check(`缺口2 超长团队名下 role 段活下来: 同队两个 role 的标题**两两不同且都非空**，各自仍以**自己的完整 role** 结尾，团队段被截（保留可辨识前缀 + 省略号），且**派生值本身**就落在宿主的 80 字节预算内（上游那一剪再也咬不到 role）${new Set(longTitleRows.map((row) => upstreamTitle(row.title))).size === longTitleRows.length ? "" : `（实测：${show(longTitleRows.map((row) => ({ title: row.title, landed: upstreamTitle(row.title) })))}）`}`,
	longTitleRows.length === 2 && longTeamOut.kind === "success"
		&& longTitleRows.every((row) => typeof row.title === "string" && row.title !== "" && row.title.endsWith(row.role))
		&& longTitleRows.every((row) => Buffer.byteLength(row.title, "utf8") <= 80 && row.title.startsWith(LONG_TEAM.slice(0, 20)) && row.title.includes("…") && row.title !== row.id)
		&& upstreamTitle(at(longTitleRows, 0, {}).title) !== upstreamTitle(at(longTitleRows, 1, {}).title));
// 降级（服务缺席）：标题是**呈现面**——一个改不了名的新会话仍然是能用的 worker ⇒ **一行
// warn、不阻断创建**。这与 preset / 模型选择那两处的 fail-fast 口径**故意不同**：那两处
// 决定的是会话**能不能跑**（缺了首回合就死），标题只决定它在侧边栏里长什么样。
const noTitleEnv = teamSessionEnv({ askScript: ["创建"], omitSessionTitle: true });
const noTitleOut = await noTitleEnv.run("n=2 team=defect4 roles=worker-a,worker-b task=验降级仍驱动"); // task= 是 2026-09-22 加的：无正文无 task= 的行不再驱动（见上文 ⚠ 说明）
check("DEFECT-4 ② 服务缺席降级不阻断创建: sessionTitle 缺席 ⇒ 零 rename，而两个会话照建、照驱动、照登记（团队里 worker-a/worker-b 两个角色都在，外加创建路径认领的 coordinator），批次仍报成功（其余面一字不变）", noTitleEnv.creates.length === 2 && noTitleEnv.sessionTitle.renames.length === 0 && noTitleEnv.created.every((item) => item.calls.followedup.length === 1) && noTitleEnv.store().length === 1 && at(noTitleEnv.store(), 0, { roles: [] }).roles.map((entry) => entry.role).sort().join(",") === "coordinator,worker-a,worker-b" && noTitleOut.kind === "success");
check("DEFECT-4 ② 降级不静默: 一个会话一行 warn，点名「未设标题」的后果（宿主默认标题很可能是工作区名、同一批 worker 在侧边栏里会无法区分）与出路（可在壳里改），并把**打算用的**那个标题如实写出来", sessionTitleServiceWarns(noTitleEnv).length === 2 && sessionTitleServiceWarns(noTitleEnv).every((line) => line.includes("未设标题") && line.includes("工作区名") && line.includes("无法区分") && line.includes("手动")) && sessionTitleServiceWarns(noTitleEnv).some((line) => line.includes("defect4 · worker-a")) && sessionTitleServiceWarns(noTitleEnv).some((line) => line.includes("defect4 · worker-b")));
// 第二档降级：服务在、但 rename 抛错（标题为空 / 会话不在册 / 服务已 dispose）。
const refuseRenameEnv = teamSessionEnv({ askScript: ["创建"], sessionTitleOptions: { refuseRename: true } });
const refuseRenameOut = await refuseRenameEnv.run("n=1 team=defect4 roles=worker-a task=验降级仍驱动"); // task= 是 2026-09-22 加的：无正文无 task= 的行不再驱动（见上文 ⚠ 说明）
check("DEFECT-4 ② rename 抛错 ⇒ 同样只降级: 恰一行 warn/会话（点名 rename failed 与后果），会话照建照驱动、批次仍报成功（异常不许从呈现面漏出去炸掉建队）", refuseRenameEnv.creates.length === 1 && refuseRenameEnv.sessionTitle.renames.length === 0 && refuseRenameEnv.created.every((item) => item.calls.followedup.length === 1) && sessionTitleRenameWarns(refuseRenameEnv).length === 1 && sessionTitleRenameWarns(refuseRenameEnv)[0].includes("工作区名") && refuseRenameOut.kind === "success");
// 口径说明（任务第 5 条）：确认框与回执都要说明**设了什么标题**、用户想改随时可改。
//
// **2026-09-22 裁定 A 把这条判据搬家（移动，不是删除，强度不降）**：那一整段「- 会话标题：…」自述
// 段整段移出了框体，改由**完成回报**承载 ⇒ 同一读数（逐会话、取自 `rename` 的返回值）、同一句话
// （「想改随时在壳里重命名」）与同一条解释（「不再…显示为工作区名」）现在落在 `command/done` 的完成
// 清单里。**配对方式不变**：按每个会话的 title 读回它的 role，再要求回执行里出现「<role> → <title>」，
// 所以「两个会话被命名成同一个常量」这种空锁照样红；另加一条**反向锁**：框体 detail 里不再有
// 「会话标题」段（移走这件事本身是可检的，不是靠不写断言默认的）。
const titleTextEnv = teamSessionEnv({ askScript: ["创建"] });
const titleTextOut = await titleTextEnv.run("n=2 team=title-dialog roles=worker-a,worker-b");
const titleTextBody = titleTextEnv.uq.requests[0]?.questions[0]?.detail ?? "";
const titleTextRows = sessionTitleOf(titleTextEnv);
const titleTextLine = typeof titleTextOut?.text === "string" ? titleTextOut.text.split("\n").find((line) => line.startsWith("- 标题（DEFECT-4）：")) : undefined;
const titleTextPairs = titleTextRows.map((row) => `${row.id === plannedId(titleTextEnv, "title-dialog", "worker-a") ? "worker-a" : "worker-b"} → ${row.title}`);
check(`DEFECT-4 ② 完成回报说明设了什么标题（裁定 A：这一段已从框体移到完成回报，**强度不降**）: 每个新会话逐行写出**真正设成**的标题（与交给 rename 的那一份是同一个读数），并写明「想改随时在壳里重命名」与「不再全部显示为工作区名」${titleTextPairs.length === 2 && titleTextPairs.every((pair) => typeof titleTextLine === "string" && titleTextLine.includes(pair)) ? "" : `（实测：${show({ titleTextPairs, titleTextLine })}）`}`,
	titleTextRows.length === 2 && typeof titleTextLine === "string" && titleTextPairs.every((pair) => titleTextLine.includes(pair))
		&& titleTextLine.includes("worker-a → title-dialog · worker-a") && titleTextLine.includes("worker-b → title-dialog · worker-b")
		&& titleTextLine.includes("想改随时在壳里重命名") && titleTextLine.includes("工作区名")
		&& !titleTextBody.includes("会话标题") && !titleTextBody.includes("想改随时在壳里重命名"));
check("DEFECT-4 ② 回执说明设了什么标题: 完成清单逐会话列出**真正设成**的标题，并说明可随时改（不再让用户自己去侧边栏发现它们全同名）", titleTextOut.kind === "success" && titleTextOut.text.includes("worker-a → title-dialog · worker-a") && titleTextOut.text.includes("worker-b → title-dialog · worker-b") && titleTextOut.text.includes("想改随时"));
// 这条锁住「回执是**读数**而不是复述」：标题取自 `rename` 的返回值，而不是拿 team/role
// 重算一遍。rename 抛错时回执必须如实写「未设标题」——若改成重算，它就会谎报一个标题，
// 这条当场红。
check("DEFECT-4 ② 回执是读数不是复述: rename 失败时回执**不谎报**标题（该行如实写「未设标题」，而不是拿 team/role 重算一个出来）", refuseRenameOut.text.includes("未设标题") && !refuseRenameOut.text.includes("defect4 · worker-a"));

// --- DEFECT-3 收尾 · 裁定 1：「半条路由」——只给一半，缺的那一半从缺省读数补齐 ---------
// 真机缺陷 #3 的**同一个缺陷类的另一半**：`model=X` 而漏写 `provider=` 的人类用户拿到的
// 是一个**跑不起来的会话**（`agentOptions = {model}` 会被 `dsh-agent-loop` 以
// 「has no provider/model」拒绝），失效形态与 DEFECT-1/3 一模一样。所以规则不是「两侧都没给
// 才解析」，而是「**任一侧**缺失就补齐缺的那一半」：两侧都缺 ⇒ 一对全取缺省（上一组）、
// 两侧都给 ⇒ 完全不问服务（再上一组）、只给一半 ⇒ 从**同一次** `currentSelection()` 的
// 读数补齐缺的那一半（本节三条）。
//
// 两条半边各走一条真正到得了的路：`model=` 侧是**端到端**（`model=deepseek-v4` 就是
// `/team_session` 的文法能表达的形状），provider 侧在文法里不可达（`model=` 只会给出
// 「两侧都给」或「只给 model」）⇒ 直接驱动 §10.2.2 那个**真实的**创建选项构造器
// （`buildTeamSessionCreateOptions`，② 与 ③a 共用的唯一落点），而不是复刻一个解析器。
const halfModelEnv = teamSessionEnv({ askScript: ["创建"] });
const halfModelOut = await halfModelEnv.run("n=1 team=defect3 roles=worker-a model=deepseek-v4");
const halfModelRow = at(modelSelectionOf(halfModelEnv), 0, {});
check(`DEFECT-3 收尾 裁定 1（只给 model=）: 缺的 provider 从 currentSelection() 补齐 —— 写进 agentOptions 的是**可运行的一对**（给的 model 原样保留 + 补上的 provider 就是缺省读数），服务**恰被问一次**（补的是「那一次」读数，不是两次）${halfModelRow.provider === STUB_DEFAULT_PROVIDER && halfModelRow.model === "deepseek-v4" ? "" : `（实测：${show(halfModelRow)}）`}`, halfModelOut.kind === "success" && halfModelEnv.creates.length === 1 && halfModelEnv.creates[0].agentOptions?.provider === STUB_DEFAULT_PROVIDER && halfModelEnv.creates[0].agentOptions?.model === "deepseek-v4" && halfModelEnv.agentDefaultModel.calls.length === 1 && halfModelRow.hook === "function" && halfModelRow.setupAgentId === halfModelRow.id);
const halfModelHook = await probeModelHook(halfModelEnv.created[0]?.agent, { provider: STUB_DEFAULT_PROVIDER, model: "deepseek-v4", reasoningEffort: "high" });
check(`DEFECT-3 收尾 裁定 1（只给 model=）判据是「能用」: 装进 agent 的那个模型选择钩子携带的就是**补齐后的那一对**（同路由 ⇒ 抹掉继承来的 reasoningEffort；换路由 ⇒ 原样放行），不是只挂了个函数${halfModelHook.installed === true && halfModelHook.out.reasoningEffort === undefined ? "" : `（实测：${show(halfModelHook)}）`}`, halfModelHook.installed === true && halfModelHook.out.provider === STUB_DEFAULT_PROVIDER && halfModelHook.out.model === "deepseek-v4" && halfModelHook.out.reasoningEffort === undefined);
const { buildTeamSessionCreateOptions: buildCreateOptions } = __testing;
const halfProviderEnv = teamSessionEnv();
const halfProviderEntry = { sessionId: "team-link-defect3-worker-p-00000000", role: "worker-p" };
const halfProviderOptions = await buildCreateOptions(halfProviderEnv.ctx, { preset: undefined, provider: "someone-else", model: undefined }, halfProviderEntry, TEAM_WS);
const halfProviderBound = [];
await halfProviderOptions.setup({ agentId: halfProviderEntry.sessionId, on(event, listener) { halfProviderBound.push({ event, listener }); return () => {}; } });
const halfProviderHook = at(halfProviderBound, 0, {});
const halfProviderResolved = typeof halfProviderHook.listener === "function" ? await halfProviderHook.listener({ agent: { session: { requestHeader: () => undefined } } }, async () => ({ provider: "someone-else", model: STUB_DEFAULT_MODEL, reasoningEffort: "high" })) : {};
check(`DEFECT-3 收尾 裁定 1（只给 provider、未给 model）: 同款处理 —— 缺的 model 从同一次 currentSelection() 补齐，agentOptions 与装进 agent 的钩子都是那一对（provider 原样保留）${halfProviderOptions.agentOptions?.model === STUB_DEFAULT_MODEL ? "" : `（实测：${show(halfProviderOptions.agentOptions)}）`}`, halfProviderEnv.agentDefaultModel.calls.length === 1 && halfProviderOptions.agentOptions?.provider === "someone-else" && halfProviderOptions.agentOptions?.model === STUB_DEFAULT_MODEL && halfProviderHook.event === "agent/request" && typeof halfProviderHook.listener === "function" && halfProviderResolved.provider === "someone-else" && halfProviderResolved.model === STUB_DEFAULT_MODEL && halfProviderResolved.reasoningEffort === undefined);

// --- DEFECT-3 收尾 · 裁定 2（两处确认框文案按实现改准）与裁定 3（不可达空分支的形态锁）---
// 裁定 2：两处对话框的**模型行**各有一句已被实现推翻的话——`teamSessionDialogText` 在
// `model=` 缺省时写「（本会话默认）」，`rotationAutoDialogText` 写「本路径不指定
// provider/model（新会话继承默认选择）」。两句都不成立：DEFECT-3 证明不带 `agentOptions`
// 的 agent 走不到宿主的缺省；收尾（裁定 1）之后**只给一半**也会被解析补齐。判据落在
// **人在框里真正读到的正文**上，不是落在源码措辞上。
const dialogPlan = (model, provider) => ({ team: "defect3-dialog", creating: [{ role: "worker-a" }], skipped: [], sessions: [{ role: "worker-a", sessionId: "team-link-defect3-dialog-worker-a-00000000", skip: false }], task: undefined, preset: undefined, model, provider });
const dialogNoRoute = teamSessionDialogText(dialogPlan(undefined, undefined), TEAM_WS, "session-self");
const dialogHalfRoute = teamSessionDialogText(dialogPlan("deepseek-v4", undefined), TEAM_WS, "session-self");
const dialogFullRoute = teamSessionDialogText(dialogPlan("deepseek-v4", "deepseek"), TEAM_WS, "session-self");
// 裁定 A 收紧措辞之后，这条判据改成**按模型槽**读（`- 模型/预设：` 那一行），比原来读整串更严：
// 同一行里还写着 `preset=宿主缺省`，整串级的「不含宿主缺省」断言会被它误伤，按槽读就不会。三种形状
// 的判据面一字未撤：两侧都没给 ⇒ 只写「宿主缺省」；只给一半 ⇒ **点名缺的是哪一半**；两侧都给 ⇒
// 原样列出那一对、且**模型槽里一个字都不提缺省解析**（那条路根本不问服务）。
const modelSlotOf = (detail) => (typeof detail === "string" ? detail.split("\n").find((line) => line.startsWith("- 模型/预设：")) : undefined);
/** 模型槽里**属于模型的那一段** —— 同一行还挂着 ` · preset=…`，而 preset 的缺省**本来就**写作
 * 「宿主缺省」（DEFECT-1），所以「两侧都给时不提缺省解析」必须只在模型那一段上判。 */
const modelValueOf = (slot) => (typeof slot === "string" ? slot.replace(/^-\s*模型\/预设：/u, "").split(" · preset=")[0] : undefined);
const dialogNoModelSlot = modelSlotOf(dialogNoRoute);
const dialogHalfModelSlot = modelSlotOf(dialogHalfRoute);
const dialogFullModelSlot = modelSlotOf(dialogFullRoute);
check("裁定 2 ②: 批量确认框的模型行三种形状都如实——两侧都没给（只写「宿主缺省」，那句被裁定 A 压掉的教学式说明不再出现）/ 只给一半（**点名缺的是哪一半**）/ 两侧都给（原样列出那一对、且模型槽里不提缺省解析，因为那条路根本不问服务）；「（本会话默认）」那种被真机推翻的说法不再出现"
	+ (typeof dialogNoModelSlot === "string" && dialogNoModelSlot.includes("- 模型/预设：宿主缺省") && typeof dialogHalfModelSlot === "string" && dialogHalfModelSlot.includes("model=deepseek-v4（provider 取宿主缺省）") && typeof dialogFullModelSlot === "string" && dialogFullModelSlot.includes("- 模型/预设：model=deepseek-v4（provider=deepseek）") ? "" : "（实测：" + show({ noRoute: dialogNoModelSlot, halfRoute: dialogHalfModelSlot, fullRoute: dialogFullModelSlot }) + "）"),
	!dialogNoRoute.includes("本会话默认") && !dialogNoRoute.includes("两半都解析并带上宿主缺省模型选择")
		&& typeof dialogNoModelSlot === "string" && dialogNoModelSlot.includes("- 模型/预设：宿主缺省") && !dialogNoModelSlot.includes("本会话默认")
		&& typeof dialogHalfModelSlot === "string" && dialogHalfModelSlot.includes("model=deepseek-v4（provider 取宿主缺省）")
		&& typeof dialogFullModelSlot === "string" && modelValueOf(dialogFullModelSlot) === "model=deepseek-v4（provider=deepseek）" && modelValueOf(dialogFullModelSlot) === dialogFullModelSlot.replace(/^-[^：]*：/u, "").split(" · preset=")[0]
		&& !dialogFullRoute.includes("两半都解析并带上宿主缺省模型选择") && !dialogHalfRoute.includes("两半都解析并带上宿主缺省模型选择"));
const autoDialogBody = autoEnv.uq.requests[0]?.questions?.[0]?.question ?? "";
check("裁定 2 ③a: 自动换届确认框的模型行不再说「本路径不指定 provider/model」（实现现在会解析并带上宿主缺省的模型选择），并点名不解析的后果（真机缺陷 #3 的 `{{model}}`）", autoDialogBody.includes("解析并带上宿主缺省模型选择") && !autoDialogBody.includes("本路径不指定 provider/model") && autoDialogBody.includes("真机缺陷 #3") && autoDialogBody.includes("{{model}}"));
check("裁定 2 ③a 反锁: 那句已不成立的话在 lib/index.js 里**一处都不剩**（源码级：它只可能从这两处对话框文案回来）", !HANDOFF_SOURCE.includes("本路径不指定 provider/model"));
// 裁定 3：`agentOptions` 无条件传（与模板 `dsh-webhook:106` 的
// `agentOptions: resolved.agentOptions,` 同形）。解析/补齐之后「空对象」已经**不可达**，
// 所以这条**没有行为断言能咬住**（改回条件式，所有行为读数一字不变）——如实锁形态本身。
// （形态锁的读数按 `\r\n` 写：本仓库的源码是 CRLF，只认 `\n` 的正则会在 CRLF 树上空过——
// 这条锁第一版就是这么红的，报出来的是 `unconditional: false` 而不是别的。）
const createOptionsShape = {
	noDeadBranch: !HANDOFF_SOURCE.includes("Object.keys(agentOptions)"),
	unconditional: /(?:^|[\r\n])\t*agentOptions,[\r\n]/u.test(HANDOFF_SOURCE),
};
check(`裁定 3 形态锁: 创建选项里不再有「agentOptions 为空就不传」那条不可达分支，改为无条件传（与模板 \`dsh-webhook:106\` 同形）${createOptionsShape.noDeadBranch && createOptionsShape.unconditional ? "" : `（实测：${show(createOptionsShape)}）`}`, createOptionsShape.noDeadBranch && createOptionsShape.unconditional);
// --- U18: 生命周期 (the handle belongs to the plugin's OWN context) ----------
const controller = sessionControllerFor(okEnv.ctx);
check("U18 生命周期: the batch controller lives on the plugin's own context (not a command-handler temp ctx) and owns its handles", controller !== undefined && controller.rootCtx === okEnv.ctx && okIds.every((id) => controller.hasHandle(id)) && okIds.every((id) => controller.handleFor(id).agent.id === id));
check("U18 生命周期: an unrelated context has no controller (the ownership is per activation, not global)", sessionControllerFor(new Context()) === undefined);
check("U18 生命周期: a created worker is immediately a live registry member (addressable by team_link_send, before any checkpoint)", okIds.every((id) => okEnv.agentFor(id) !== undefined));
// §10.2.5 recovery path, asserted through the EXISTING probe: once the session
// row exists (its first checkpoint) and the plugin's agent for it is gone
// (unload / reload), the row reads `dead` — no new mechanism, and no roster-only
// status word that could disagree with the registry.
okEnv.seedSessionRecords(okIds);
const okListLive = await okEnv.tool("team_link_list_sessions").execute({}, execFor(okEnv.senderAgent));
check("U18 生命周期: the listed rows of the new sessions read ok while their agent is live", okIds.every((id) => okListLive.includes(id)) && okListLive.split("\n").filter((line) => okIds.some((id) => line.startsWith(`- ${id}`))).every((line) => line.includes("○ 空闲")) && okListLive.split("\n").filter((line) => line.includes("活性：")).every((line) => line.includes("verdict=ok")));
for (const id of okIds) okEnv.setHiddenAgent(id, true);
const okListDead = await okEnv.tool("team_link_list_sessions").execute({}, execFor(okEnv.senderAgent));
check("U18 生命周期: after the plugin's agent is gone (unload/reload) the same rows read 未运行 + verdict=dead — 盘上有会话但无活代理", okListDead.split("\n").filter((line) => okIds.some((id) => line.startsWith(`- ${id}`))).every((line) => line.includes("✕ 未运行")) && okListDead.split("\n").filter((line) => line.includes("活性：")).every((line) => line.includes("verdict=dead")));

// ---------------------------------------------------------------------------
// U17: 驱动方式（followup 在 create 之后）· 幂等 · 失败即停
// ---------------------------------------------------------------------------

// --- the kickoff message: §10.2.3's `source` triple + the driving call --------
const kickoff = at(at(okEnv.created, 0, {})?.calls?.followedup, 0, {});
check("U17 驱动: the kickoff task is delivered with `followup` (never `inject` — that is 「投递不唤醒」)", okEnv.created.every((item) => item.calls.followedup.length === 1 && item.calls.injected.length === 0 && item.calls.steered.length === 0));
check("U17 驱动: the kickoff message is a relay whose source is EXACTLY the three audited members (V10)", Object.keys(kickoff.source ?? {}).length === 3 && kickoff.source?.kind === "agent-message" && kickoff.source?.form === "relay" && kickoff.source?.senderSessionId === "session-self" && kickoff.role === "user" && typeof kickoff.id === "string" && kickoff.id.startsWith("slp-"));
check("U17 驱动: the body names the team, the role, the task, the cwd and how to report back (服从来自 prompt，不来自血统)", (() => { const text = at(kickoff.content, 0, {}).text ?? ""; return text.includes("团队 night-shift") && text.includes("worker-a") && text.includes("做接口") && text.includes(TEAM_WS) && text.includes("team_link_send") && text.includes("汇报") && text.includes("session-self"); })());
// 规范原文「Setup composes, it never drives」: every create resolves BEFORE the
// first followup of the batch (the action log is the factory's own order).
check("U17 驱动: every create resolves before any kickoff followup runs (create 全部完成 → 才驱动)", (() => { const lastCreate = okEnv.actionLog.lastIndexOf("create"); const firstFollow = okEnv.actionLog.indexOf("followup"); return lastCreate !== -1 && firstFollow !== -1 && lastCreate < firstFollow; })());

// --- 按 role 幂等: a re-run of the same command ---------------------------------
const idemCmdEnv = teamSessionEnv({ askScript: ["创建"] });
await idemCmdEnv.run("n=2 team=night-shift roles=worker-a,worker-b");
const idemPairsAfterFirst = idemCmdEnv.pairs().length;
const idemRolesAfterFirst = JSON.stringify(idemCmdEnv.store()[0].roles);
const idemOut2 = await idemCmdEnv.run("n=2 team=night-shift roles=worker-a,worker-b");
check("U17 幂等: re-running the same command creates NOTHING (同 team 同 role 已存在则跳过) and says so", idemCmdEnv.creates.length === 2 && idemOut2.kind === "success" && idemOut2.text.includes("零创建、零 pairs") && idemOut2.text.includes("幂等"));
check("U17 幂等: ... and the roster and the pairs are byte-identical afterwards (the skipped roles did not re-seat or re-grant)", JSON.stringify(idemCmdEnv.store()[0].roles) === idemRolesAfterFirst && idemCmdEnv.pairs().length === idemPairsAfterFirst);
// A MIXED batch: one new role plus one already seated. The new one is created,
// the seated one is skipped, and only the new one gets a pair.
const mixRunEnv = teamSessionEnv({ askScript: ["创建", "创建"] });
await mixRunEnv.run("n=1 team=night-shift roles=worker-a");
const mixOut2 = await mixRunEnv.run("n=2 team=night-shift roles=worker-a,worker-b");
const mixNewId = at(mixRunEnv.creates, 1, {}).sessionId;
check("U17 幂等: a mixed batch creates only the missing role, skips the seated one, and pairs only what it created", mixRunEnv.creates.length === 2 && mixOut2.kind === "success" && mixOut2.text.includes("worker-a：跳过（已登记）") && mixOut2.text.includes(`worker-b → ${mixNewId}：已创建`) && mixRunEnv.pairs().length === 2 && mixRunEnv.pairs().every((pair) => [at(mixRunEnv.creates, 0, {}).sessionId, mixNewId].includes(pair.b)));

// --- 部分失败: 失败即停 · 已建者保留 · 如实报告 -------------------------------
const failEnv = teamSessionEnv({ askScript: ["创建"], failCreateAt: 1 });
const failOut = await failEnv.run("n=3 team=night-shift roles=worker-a,worker-b,worker-c task=做接口"); // task= 是 2026-09-22 加的：无正文无 task= 的行不再驱动（见上文 ⚠ 说明）
const failFirstId = at(failEnv.creates, 0, {}).sessionId;
check("U17 失败即停: the k-th create failing stops the loop — the third session is never attempted", failEnv.creates.length === 2 && failOut.kind === "error" && failOut.text.includes("未尝试") && failOut.text.includes("失败即停"));
check("U17 保留: the sessions already created are KEPT (nothing is rolled back) and the first one is still driven", failEnv.created.length === 1 && failEnv.created[0].calls.followedup.length === 1 && failEnv.agentFor(failFirstId) !== undefined && failOut.text.includes(`worker-a → ${failFirstId}：已创建 + 已投递启动任务`));
check("U17 报告: the summary is an honest list — one row per planned worker, each naming its own outcome", failOut.text.includes("worker-b") && failOut.text.includes("创建失败") && failOut.text.includes("worker-c") && failOut.text.split("\n").filter((line) => line.startsWith("- worker-")).length === 3);
check("U17 报告: the roster records only what was created (created-in-this-batch roles; the coordinator row is the creation-path claim)", failEnv.store()[0].roles.map((entry) => entry.role).sort().join(",") === "coordinator,worker-a");
// The two ways the report tells the human what to do about the rest: a roster
// write that FAILED names the repair call, and a stopped batch names the rows it
// never attempted. (A successful partial write is this case's actual path — the
// repair line is the OTHER branch, asserted below on a team the caller may not
// write to.)
check("U17 报告: the report names every planned worker with its own outcome and never claims a rollback", ["worker-a", "worker-b", "worker-c"].every((role) => failOut.text.includes(role)) && failOut.text.includes("保留、不回滚") && failOut.text.includes("失败即停"));
check("U17 报告: the pairs are granted for the created worker ONLY (a channel to a session that does not exist is never written)", failEnv.pairs().length === 1 && failEnv.pairs()[0].b === failFirstId);
// The batch that fails on its FIRST create leaves nothing behind but the trace.
const failAllEnv = teamSessionEnv({ askScript: ["创建"], failCreateAt: 0 });
const failAllOut = await failAllEnv.run("n=2 team=night-shift roles=worker-a,worker-b");
check("U17 失败即停: a first-create failure creates nothing, writes no pairs and no roster, and reports both rows", failAllEnv.created.length === 0 && failAllEnv.pairs().length === 0 && failAllEnv.store().length === 0 && failAllOut.kind === "error" && failAllOut.text.includes("worker-b") && failAllOut.text.includes("未尝试"));

// --- §10.2.4 既有 team 的权限: NO bypass was added ----------------------------
// The pre-existing `writerGate` still guards an EXISTING team: a non-incumbent
// is refused before the dialog opens and before any session exists, so the batch
// never even reaches `create`.
// §10.2.8.9 ② 之后这条夹具要**如实**把现任建模成「还在盘上」：`session-other` 不是活代理
// （没有 agent），但它在会话库里有行 ⇒ 两条宿主读数都不是「已归档/已不存在」⇒ 照旧拒绝
// （设计 (c)「现任存活 ⇒ 照旧拒绝」。判据一字未动，只是夹具把前提补齐了——不补齐就变成
// 「现任已不存在」，那是另一条判据 (b)/U36 的事）。
const foreignCmdEnv = teamSessionEnv({ sessions: [{ header: { id: "session-other", createdAt: 4000, cwd: TEAM_WS }, live: false, persisted: true }], teams: [teamRow({ current: "session-other" })], askScript: ["创建"] });
const foreignCmdOut = await foreignCmdEnv.run("n=1 team=night-shift roles=worker-a", foreignCmdEnv.senderAgent);
check("U17 权限: a non-incumbent on an EXISTING team is refused by the existing writerGate, before any dialog or create", foreignCmdOut.kind === "error" && foreignCmdOut.text.includes("只有现任协调者会话 session-other 可写") && foreignCmdEnv.uq.requests.length === 0 && foreignCmdEnv.creates.length === 0);
check("U17 权限: ... and that refusal leaves the namespace untouched (no session, no pair, no new role row)", foreignCmdEnv.store()[0].roles.map((entry) => entry.role).join(",") === "coordinator" && foreignCmdEnv.pairs().length === 0 && foreignCmdEnv.store().length === 1);

// ---------------------------------------------------------------------------
// U18 孤儿防护: pending-create 意图（TTL + 启动清扫 + 可收编清单）
// ---------------------------------------------------------------------------

// The intent is written BEFORE the create and resolved AFTER it (the controller's
// own bookkeeping mirrors the durable row), so the window between "we intended to
// create this session" and "it exists" is covered on both faces.
const pendingEnv = teamSessionEnv({ askScript: ["创建"], failCreateAt: 1 });
const pendingOut = await pendingEnv.run("n=2 team=night-shift roles=worker-a,worker-b");
const pendingFirstId = at(pendingEnv.creates, 0, {}).sessionId;
check("U18 意图: a created worker's intent is resolved, while the one whose create FAILED keeps its durable row (the crash window's evidence)", pendingEnv.pending().length === 1 && at(pendingEnv.pending(), 0, {}).sessionId === at(pendingEnv.creates, 1, {}).sessionId && at(pendingEnv.pending(), 0, {}).team === "night-shift" && at(pendingEnv.pending(), 0, {}).role === "worker-b" && at(pendingEnv.pending(), 0, {}).expiresAt > at(pendingEnv.pending(), 0, {}).createdAt);
check("U18 意图: the resolved worker has no row left (成功回填)", !pendingEnv.pending().some((entry) => entry.sessionId === pendingFirstId) && pendingOut.text.includes(pendingFirstId));
check("U18 意图: the controller's in-memory map stops tracking an intent the moment its create fails (the durable row is the surviving record)", sessionControllerFor(pendingEnv.ctx).handles.has(pendingFirstId) === true && !pendingEnv.pending().some((entry) => entry.sessionId === pendingFirstId));
// An old intent (TTL passed) is reported as an ADOPTABLE session by the startup
// sweep, and the report is honest about not knowing whether it exists.
const staleEnv = teamSessionEnv({
	teams: [],
	askScript: [],
	// Seeded before the plugin's own startup sweep runs? No — the sweep runs inside
	// `apply`, so this row is written by hand into the namespace the store reads,
	// which is exactly the state a crashed run leaves behind.
});
staleEnv.ns.data.pendingCreates = [{ team: "night-shift", role: "worker-a", sessionId: "team-link-night-shift-worker-a-deadbeef", createdAt: Date.now() - 600000, expiresAt: Date.now() - 300000, by: "session-self" }];
const { sweepPendingCreates: sweepPending } = __testing;
/** A minimal policy facade over a namespace's data, for the sweep's own tests. */
const sweepPolicy = (env) => ({
	get: () => ({ ...env.ns.data, teams: env.ns.data.teams ?? [], pairs: env.ns.data.pairs ?? [], watchdogs: env.ns.data.watchdogs ?? [], trustedSenders: env.ns.data.trustedSenders ?? [], blockedSenders: env.ns.data.blockedSenders ?? [], rememberTargets: env.ns.data.rememberTargets ?? [], receiveMode: env.ns.data.receiveMode ?? "ask", pendingCreates: env.ns.data.pendingCreates ?? [] }),
	update: async (patch) => { Object.assign(env.ns.data, structuredClone(patch)); },
});
const staleSweep = await sweepPending(staleEnv.ctx, sweepPolicy(staleEnv));
check("U18 清扫: an intent past its TTL is reported as an ADOPTABLE session, with the id a human can go find", staleSweep.reported.length === 1 && staleSweep.lines.length === 1 && staleSweep.lines[0].includes("team-link-night-shift-worker-a-deadbeef") && staleSweep.lines[0].includes("打开收编") && staleSweep.lines[0].includes("写于创建之前"));
check("U18 清扫: ... and it never claims the session exists or does not — the row is handed over, not judged (asymmetric report)", staleSweep.lines[0].includes("可能已创建但未登记，也可能根本没建成") && staleSweep.lines[0].includes("插件不删任何会话"));
check("U18 清扫: the reported intent is cleared from the namespace (the report IS the record; a stale row must not be reported twice)", (staleEnv.ns.data.pendingCreates ?? []).length === 0);
const freshSweepEnv = teamSessionEnv({ askScript: [] });
freshSweepEnv.ns.data.pendingCreates = [{ team: "t", role: "r", sessionId: "session-x", createdAt: Date.now(), expiresAt: Date.now() + 600000, by: "" }];
const freshSweep = await sweepPending(freshSweepEnv.ctx, sweepPolicy(freshSweepEnv));
check("U18 清扫: an intent still inside its TTL is left alone (a create in flight is not an orphan)", freshSweep.reported.length === 0 && freshSweep.lines.length === 0 && (freshSweepEnv.ns.data.pendingCreates ?? []).length === 1);
// The startup path itself: the plugin runs the sweep on activation, so a row a
// crashed run left on disk is reported without anyone calling the sweep. The row
// is seeded into the namespace BEFORE `apply` (the state that crashed run left).
const startupStale = { team: "night-shift", role: "worker-a", sessionId: "team-link-night-shift-worker-a-c0ffee01", createdAt: Date.now() - 900000, expiresAt: Date.now() - 600000, by: "session-self" };
const startupEnv = teamSessionEnv({ askScript: [], pendingSeed: startupStale });
await tick();
check("U18 清扫: the plugin's own activation runs the sweep — a stale row left on disk is reported without any manual call", startupEnv.log.lines.warn.some((line) => line.includes("pending-create 启动清扫") && line.includes("team-link-night-shift-worker-a-c0ffee01") && line.includes("打开收编")));
check("U18 清扫: ... and the reported row is resolved in the namespace (the report is the record)", (startupEnv.ns.data.pendingCreates ?? []).length === 0);
const healthyEnv = teamSessionEnv({ askScript: [] });
check("U18 清扫: a healthy boot stays quiet — no expired row means no line at all", healthyEnv.log.lines.warn.filter((line) => line.includes("pending-create")).length === 0);

// --- §10.2.7 文档漂移修正: the prepare text no longer denies the API ----------
const driftEnv = await rotateEnv({ pairs: [rotPair("session-worker-a")] });
const driftPrep = await driftEnv.rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(driftEnv.senderAgent));
check("U18 文档漂移: prepare's fallback text no longer claims 「本插件不能编程创建会话」 and names the real status instead", !driftPrep.includes("本插件不能编程创建会话") && driftPrep.includes("agents.create") && driftPrep.includes("§10.2.5") && driftPrep.includes("§11"));

// ---------------------------------------------------------------------------
// U19 红线回归（§10.3 / 演练 8 的准确判据）+ G2 并发纪律（§10.2.6）
// ---------------------------------------------------------------------------
//
// U19 的四条不是「再跑一遍既有断言」，而是**把红线的判据本身钉成断言**：
//   1) 本轮新增代码不往会话日志写任何自定义事件类型；
//   2) 投递消息的 `source` 仍恰三成员；
//   3) 模块级 `inject` 仍 4 项；
//   4) 既有 schema 与投递双门零改动。
//
// L1 的判据（自选，理由写在这里；差异审计修复轮 🔵-1 把措辞改成诚实版，断言一字未改）：
// **源码级「本模块自己不动日历」+ 运行时「状态只落既有出口」双证据**。措辞的三处更正：
//   ① 插件对会话**确有**写入面——`ctx.agents.create`（本文件的 create 桩即是它的形状）与
//      `agent.followup`；所以断言锁的是「本模块**自己**没有 append/emit 面」，不是「插件不写会话」；
//   ② `ctx.*` 全表的会话接触是 `ctx.sessionQuery` 的**四个读**方法
//      （`listSessions` / `readSession` / `readSurface` / `readTitleSnapshots`——此前写作三个，漏了
//      第一个），它们**都是读**；
//   ③ 结论仍成立，但理由不是「静态正则证明得了这一点」——正则**证明不了**上游那两条路径用的是什么
//      事件类型。红线之所以不破，是因为那两条路径产生的事件类型由**上游定义**（`agents.create` 与
//      `followup` 的形状是上游 API，不是本插件拼的事件信封），本插件无从发明一个新类型；这条断言
//      的作用是**锁**住「本模块不得自己长出写入面」，审计的变异 M6（往模块里放一个日志写入 API →
//      1 红）证明的正是这个锁真的会咬。运行时那条读的是**桩**，结构上观察不到新事件类型——它是
//      旁证（路径确实只经 settings + create + followup），不是新类型的判据。
// The host module is read from the test file's OWN location (`import.meta.url`),
// not from `import.meta.resolve("./lib/index.js")` — the latter resolves against
// the process cwd, so the run would silently read nothing under another cwd.
// (Both source reads live up in the U13 block: the §12.5 cross-half lock there
// needs them, and one read per file is enough for the whole run.)
// DEFECT-2 源码锁：整模块只有**一处** attach/detach 调用点（② 与 ③a 共用同一个
// `createRootAgent`，不存在第二个挂载点），`agents.create(` 仍是那**一处**。
check("DEFECT-2 源码锁: 全模块 `.attachSession(` / `.detachSession(` 各**恰一处**（② 与 ③a 共用同一条创建路径，不存在第二个挂载点），`agents.create(` 仍恰一处", (hostSource.match(/\.attachSession\(/gu) ?? []).length === 1 && (hostSource.match(/\.detachSession\(/gu) ?? []).length === 1 && (hostSource.match(/agents\.create\(/gu) ?? []).length === 1);
// DEFECT-4 源码锁：`sessionTitle` 只有**一处**取用点、`.rename(` 恰一处 —— ② 与 ③a 共用
// `createRootAgent` 里的那一个注入点，不是各写一遍；而且它走 `ctx.get`（可选服务），
// 模块级 `inject` 仍是那 4 项（U19 另有断言咬住）。正则同时认 `ctx.get(` 与 `ctx.get?.(`
// 两种拼法，所以「换个写法再开第二个取用点」也躲不过；注释里因此不写这两种字面量。
check("DEFECT-4 源码锁: `ctx.get(\"sessionTitle\")` 恰一处、`.rename(` 恰一处（② 与 ③a 共用同一个注入点，不存在各写一遍的第二处）", (hostSource.match(/ctx\.get\??\.\("sessionTitle"\)/gu) ?? []).length === 1 && (hostSource.match(/\.rename\(/gu) ?? []).length === 1);
const importList = [...hostSource.matchAll(/^import .*? from "([^"]+)";$/gmu)].map((match) => match[1]);
// 策略持久化自持化（设计档 §3.2/§3.4）新增两个**已审计**模块：`node:fs`（同步读 policy.json）与 `node:os`（homedir 兜底）—— 两者都不是会话日志写入面，U19 的红线（不得自己长出日志写入 API）不受影响；
// 同一次改动把清单从六个模块变成八个，列表与文案里的计数**同改**（本仓纪律 ①）。
const HOST_IMPORTS = ["@deepseek-ai/dsh-session-reference", "@deepseek-ai/dsh-tools", "schemastery", "node:crypto", "node:fs/promises", "node:fs", "node:os", "node:path"];
// `appendFile(`/`writeFile(` are deliberately NOT in this list: they are the
// blackboard's own file writes (`team/<name>/decisions.md`), not session log
// writes — the red line is about event types, not about the plugin touching disk.
check("U19 日志事件: the host module itself never appends or emits a session-log event — no `ctx.session` write seam (the only `ctx.*` session contact is the read-only `sessionQuery`, `sessionReferenceResolver` and `agents`), no `session.append` / appendEvent / writeEvent / logEvent / `ctx.emit` anywhere in the module (源码级锁；插件间接写会话只经上游的 `agents.create` / `agent.followup`)", !/ctx\.session(?![A-Za-z])/u.test(hostSource) && !/\.append(Event)?\(/u.test(hostSource) && !/\b(appendEvent|writeEvent|logEvent|emitEvent)\b/u.test(hostSource) && !/\bctx\.emit\(/u.test(hostSource) && !/\bsession\.append/u.test(hostSource));
check("U19 日志事件: ... and the module's whole import surface is the eight audited modules — a whitelist, so a new dependency cannot slip a log-write API in (`@deepseek-ai/dsh-session-reference` is upstream's deep-link parser, not a session-log writer)", sameJson(importList, HOST_IMPORTS) && importList.every((specifier) => HOST_IMPORTS.includes(specifier)));
// The runtime half, on a REAL batch (2 workers, the §10.2.6 default shape): drive
// the command, then replay its own `agent/pre-step` listener. The listener is the
// one seam that could inject a session-log event; it must only hand the payload
// back (upstream deep-link behavior) and leave zero log lines. Meanwhile every
// durable state of the run is accounted for by the two stores below.
// 🔵-1: what this case can and cannot show — the agent side here is a STUB, so it
// is structurally incapable of observing a NEW event type; what it pins is that the
// whole ② path ends in exactly the two upstream outlets (settings namespace +
// `create`/`followup`) and leaves no third one. The type-level claim rests on the
// source lock above, not on this replay.
const u19ConcurrencyEnv = setup({ sessions: [], useSettings: true, askScript: ["创建"], selfCwd: TEAM_WS, createDelayMs: 20 });
await u19ConcurrencyEnv.commands.command("team_session").handler(u19ConcurrencyEnv.invoke("n=2 team=night-shift roles=worker-a,worker-b task=并发纪律"));
const u19Creates = u19ConcurrencyEnv.creates.length;
const u19Followups = u19ConcurrencyEnv.created.reduce((total, item) => total + item.calls.followedup.length, 0);
const u19Replayed = await ctx_waterfall(u19ConcurrencyEnv.ctx, { messages: [{ id: "u19", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "参考 dsh://session/session-abc123 继续" }] }], turn: 1, step: 1 });
const u19InfoKinds = u19ConcurrencyEnv.log.lines.info.map((line) => line.includes("/team_session registered through the optional commands service") ? "cmd-session"
	: line.includes("/team_rotate registered through the optional commands service") ? "cmd-rotate"
		: line.includes('policy store attached to settings namespace "team-link"') ? "attach"
			: line.includes("post-attach policy chain finished") ? "chain"
				: `unexpected: ${line}`).sort().join(",");
check(`U19 日志事件: one real batch (2 workers) writes nothing new to any session log — the only state it leaves is the settings namespace, the creates and the followups`
	+ (u19Creates === 2 && u19Followups === 2 && (u19ConcurrencyEnv.settings.namespaces.get("team-link").data.pairs ?? []).length === 2 && u19Replayed.kind === "enter" && u19Replayed.messages.length === 2 && u19ConcurrencyEnv.log.lines.warn.length === 0 && u19InfoKinds === "attach,chain,cmd-rotate,cmd-session" && u19ConcurrencyEnv.log.lines.error.length === 0 ? "" : `（实测：creates=${u19Creates} followups=${u19Followups} warn=${u19ConcurrencyEnv.log.lines.warn.length} info=${u19InfoKinds}）`),
u19Creates === 2 && u19Followups === 2 && (u19ConcurrencyEnv.settings.namespaces.get("team-link").data.pairs ?? []).length === 2 && u19Replayed.kind === "enter" && u19Replayed.messages.length === 2 && u19ConcurrencyEnv.log.lines.warn.length === 0 && u19InfoKinds === "attach,chain,cmd-rotate,cmd-session" && u19ConcurrencyEnv.log.lines.error.length === 0);

// --- G2 (§10.2.6 并发): create 与 followup 串行（或 ≤2） ----------------------
// The bound is read from the PROVIDER side (the `agents` service stub), which is
// what a real factory sees. Each create costs 20ms here, so a batch that fanned
// out would report a peak of 2; the implementation's single awaited loop reports
// a peak of 1 — inside the design's `≤2`, and the measured value is printed with
// the failure so a red run names the number it saw instead of only the bound.
check(`U19 并发: with the creates deliberately slowed, the host never has more than 2 agents.create in the air at once (measured peak ${u19ConcurrencyEnv.maxCreateInFlight()} ≤ 2, N=2 — §10.2.6 串行或 ≤2)`, u19ConcurrencyEnv.maxCreateInFlight() <= 2);
check("U19 并发: ... and it is in fact exactly serial (peak 1): the batch is one awaited loop, so no worker's create overlaps another's", u19ConcurrencyEnv.maxCreateInFlight() === 1);
check("U19 并发: the serial loop is visible in the source too — one call site, awaited inside the batch loop, with no parallel combinator over the creates", (hostSource.match(/agents\.create\(/gu) ?? []).length === 1 && /for \(const entry of plan\.sessions\)/u.test(hostSource) && !/Promise\.all\(plan\.sessions/u.test(hostSource));

// --- U19 (2): the delivered message's `source` is still EXACTLY three members -
check("U19 source: the batch's kickoff relay still carries exactly the three audited members — {kind, form, senderSessionId}, no fourth member", sameJson(Object.keys(kickoff.source).sort(), ["form", "kind", "senderSessionId"]) && kickoff.source.kind === "agent-message" && kickoff.source.form === "relay" && kickoff.source.senderSessionId === "session-self");
check("U19 source: ... and the live batch's own kickoffs carry the same triple (the reused fixture and the fresh run agree)", u19ConcurrencyEnv.created.every((item) => sameJson(Object.keys(item.calls.followedup[0].source).sort(), ["form", "kind", "senderSessionId"])) && u19ConcurrencyEnv.created.every((item) => item.calls.followedup[0].source.senderSessionId === "session-self"));

// --- U19 (3): the module-level inject array is still the four original entries -
const U19_INJECT = ["sessionReferenceResolver", "tools", "sessionQuery", "agents"];
const indexModule = await import("./lib/index.js");
check("U19 inject: the module-level inject array is still the four original entries — ② grew it with nothing (optional deps ride ctx.inject)", sameJson(indexModule.inject, U19_INJECT));
check("U19 inject: ... and the host module really is the four-entry shape: `apply`, the four-entry array and `__testing` (plus the plugin `name`) are its whole export surface", sameJson(Object.keys(indexModule).sort(), ["__testing", "apply", "inject", "name"]));

// --- U19 (4): the existing schema and the delivery gates are untouched --------
// Schema: the ② round declared ONE new key (`pendingCreates`, §10.2.6's durable
// intent) beside the seven that pre-date it — the two batch bounds are code
// constants (U16 asserts that), so the red line is that no further key appeared.
// The declared surface is read from the REGISTERED namespace's base (what the
// provider actually takes), not from a hand-copied list.
const U19_POLICY_KEYS = ["blockedSenders", "pairs", "pendingCreates", "receiveMode", "rememberTargets", "sections", "teams", "trustedSenders", "watchdogs"];
const u19Base = u19ConcurrencyEnv.settings.namespaces.get("team-link").base;
// 批 1（FR-3a）: the WORKED surface gained `watchdogs` — 因为 `/team_session` 现在会经**既有的**
// `watchdogs` 键自动注册一条工作台注册（§7.1「既有键的加性扩展」）。上半句（**声明面** = 八个键）
// 一字未动，这条判据要钉的「没有新顶层键」因此仍成立：新增的是既有数组里一行的 `origin` 字段。
check("U19 schema: the registered policy namespace still declares exactly its **nine** keys —— ② 的 pendingCreates 与 FR-9 的 sections 加在更早的七项之上，其余一个不多", sameJson(Object.keys(u19Base).sort(), U19_POLICY_KEYS) && sameJson(Object.keys(u19ConcurrencyEnv.settings.namespaces.get("team-link").data).sort(), ["pairs", "pendingCreates", "teams", "watchdogs"]));
const sendToolU19 = u19ConcurrencyEnv.tool("team_link_send");
const sendParams = sendToolU19.parameters;
check("U19 schema: team_link_send's argument surface is unchanged (mutually-exclusive addressing, the message, the §3.4 envelope) — and the real key is `message`, not `text`", sameJson(Object.keys(sendParams.properties).sort(), ["message", "meta", "targetSessionId", "targets"]) && sameJson(sendParams.required, ["message"]) && sendParams.type === "object" && sendParams.properties.message.type === "string" && sendParams.properties.targets.type === "array" && sendParams.properties.targetSessionId.type === "string");
// The read-only half of the same red line, on the OTHER module: the client face
// cannot write a session event either — its bundle has no import at all (the
// client-half suite asserts nothing else may be added to it).
// (`clientSource` is read once, in the U13 block, for the §12.5 cross-half lock.)
check("U19 日志事件: the client half is a pure reader too — its bundle imports nothing at all, so ① cannot reach a log-write API from there either", [...clientSource.matchAll(/^import .*$/gmu)].length === 0 && !/\bappendEvent\b/u.test(clientSource));
// Gates: the three concrete behaviors that ARE 「投递双门」, each re-asserted
// through the same fixtures the standalone cases use.
check("U19 双门: a working pair still bypasses BOTH gates (second send raises no dialog at all)", pairOut2.includes("已配对") && pairOut2.includes("已投递") && pairEnv.uq.requests.length === 2 && pairEnv.targetCalls.followedup.length === 2);
check("U19 双门: without a pair the sender-side dialog is still raised and the receiver-side dialog is still raised，两次都在（nothing was collapsed into one）", cancelEnv.uq.requests.length === 1 && cancelEnv.uq.requests[0].questions[0].id === "send-confirm" && sendEnv.uq.requests.length === 2 && sendEnv.uq.requests[1].questions[0].id === "receive-confirm");
check("U19 双门: the receiver's ask option list still carries the pairing grant verbatim, and the sequential upgrade really takes — the send AFTER the pair asks for nothing", sendEnv.uq.requests[1].questions[0].options.map((option) => option.label).join(",") === "接收,总是接收该会话,配对：双向免确认,拒绝并屏蔽该会话");
// The dialog count is the honest witness for "the batch's own path walks the
// EXISTING gates": one dialog for the whole batch (the §10.2.4 confirmation),
// and not one more — the §10.2.3 (i) pairs it writes are exactly what keeps the
// kickoffs off the gates.
const u19GateEnv = teamSessionEnv({ askScript: ["创建"] });
await u19GateEnv.run("n=2 team=night-shift roles=worker-a,worker-b task=门");
check("U19 双门: a whole batch raises exactly ONE dialog — the §10.2.4 confirmation itself; its pairs (not a new bypass) are what keeps the kickoffs off the two gates", u19GateEnv.uq.requests.length === 1 && u19GateEnv.pairs().length === 2 && u19GateEnv.created.every((item) => item.calls.followedup.length === 1));

// ---------------------------------------------------------------------------
// 批次 2 (§4.2): 恢复能力加宽两格 —— (a) revive 放开角色门 · (c) reappoint 常驻「自建继任者」
// ---------------------------------------------------------------------------
// 变异基线（修复前必红）:
//  (a) `reviveIncumbent` 的角色门把「身份不变的复活」限制在 coordinator 一格上 ⇒ 插件
//      自建的死 worker 被拒（红相在下面 U7 与两处既有断言的改写记录里）；
//  (c) `reapCandidateRoles` 只返回活成员 ⇒ 全队只剩协调者一个活人时，唯一的候选是
//      「把 worker 角色改任给协调者」，而候选真的为空时连对话框都不弹（红相见 U9/U10）。

const REVIVE_WORKER_ID = "team-link-night-shift-worker-a-0f0f0f0f";
// --- U7 (§4.2 (a)): 插件自建的**非 coordinator** 角色可以 revive -----------------
const reviveWorkerEnv = rotateEnv({
	askScript: ["执行恢复"],
	teams: reviveTeam([
		{ role: "coordinator", current: "session-target", pending: null, history: [] },
		{ role: "worker-a", current: REVIVE_WORKER_ID, pending: null, history: [{ session: REVIVE_WORKER_ID, from: 1_700_000_000_000, until: null }] },
	]),
	pairs: [{ a: "session-target", b: REVIVE_WORKER_ID, createdAt: 1 }],
	trustedSenders: [REVIVE_WORKER_ID],
	rememberTargets: [REVIVE_WORKER_ID],
	extraAgents: [{ id: REVIVE_WORKER_ID, status: "idle" }],
});
reviveWorkerEnv.setHiddenAgent(REVIVE_WORKER_ID, true);
declareDormantSession(reviveWorkerEnv, REVIVE_WORKER_ID);
const reviveWorkerTrustBefore = pairSummary(reviveWorkerEnv);
const reviveWorkerOut = await reviveWorkerEnv.tool("team_link_recover").execute({ action: "revive", team: "night-shift", role: "worker-a" }, execFor(reviveWorkerEnv.agentFor("session-target")));
check("U7 (a): 插件自建的**非 coordinator** 角色（worker-a）现在可以 revive —— 角色门删除后它走到 resume，身份不变（同一个会话 id）", reviveWorkerOut.includes("已恢复（revive）") && reviveWorkerEnv.resumeCalls.length === 1 && at(reviveWorkerEnv.resumeCalls, 0, {}).resumeSessionId === REVIVE_WORKER_ID && reviveWorkerEnv.role("worker-a").current === REVIVE_WORKER_ID);
check("U7 (a): ... 复活出来的代理真的进了注册表（writerGate 按 id 比对直接放行），roster 的 current 一字未动", reviveWorkerEnv.agentFor(REVIVE_WORKER_ID) !== undefined && at(reviveWorkerEnv.role("worker-a").recoveries, 0, {}).verb === "revive" && at(reviveWorkerEnv.role("worker-a").recoveries, 0, {}).by === "session-target" && at(reviveWorkerEnv.role("worker-a").recoveries, 0, {}).from === REVIVE_WORKER_ID && at(reviveWorkerEnv.role("worker-a").recoveries, 0, {}).to === REVIVE_WORKER_ID);
check("U7 (a): ... 且信任零改动——pairs / trustedSenders / rememberTargets 一个字节都没碰（revive 是身份不变的操作，放开角色面不移动红线一寸）", pairSummary(reviveWorkerEnv) === reviveWorkerTrustBefore && (reviveWorkerEnv.ns.data.trustedSenders ?? []).join(",") === REVIVE_WORKER_ID && (reviveWorkerEnv.ns.data.rememberTargets ?? []).join(",") === REVIVE_WORKER_ID && reviveWorkerEnv.ns.data.teams[0].policy.writer === "coordinator");

// --- U8 (§5 B3): 所有权门原样不动——人类自建 id 的 worker 仍被拒 ---------------
const reviveHumanWorkerEnv = rotateEnv({
	askScript: ["执行恢复"],
	teams: reviveTeam([
		{ role: "coordinator", current: "session-target", pending: null, history: [] },
		{ role: "worker-a", current: "session-worker-a", pending: null, history: [{ session: "session-worker-a", from: 1_700_000_000_000, until: null }] },
	]),
	extraAgents: [{ id: "session-worker-a", status: "idle" }],
});
reviveHumanWorkerEnv.setHiddenAgent("session-worker-a", true);
const reviveHumanWorkerOut = await reviveHumanWorkerEnv.tool("team_link_recover").execute({ action: "revive", team: "night-shift", role: "worker-a" }, execFor(reviveHumanWorkerEnv.agentFor("session-target")));
check("U8 (B3): 人类自建 id 的 **worker** 仍被所有权门拒绝（角色门删除**没有**连带删掉适用域），文案给出侧边栏那条零成本正解，且零 resume、零写入", reviveHumanWorkerOut.includes("不是本插件创建的会话") && reviveHumanWorkerOut.includes("侧边栏") && reviveHumanWorkerOut.includes("reappoint") && reviveHumanWorkerEnv.resumeCalls.length === 0 && (reviveHumanWorkerEnv.role("worker-a").recoveries ?? []).length === 0);

// --- U9 (§4.2 (c)): threat-intel 形夹具——coordinator 活、b/c 是人类 id 的死会话 --
// 事故现场的形状就是这条：唯一的活人是协调者自己，两个 worker 车道都是人类自建 id。
// 旧实现的候选集只排除被恢复的角色本身 ⇒ 唯一可选路径是「把 b 改任给协调者」。
const TI_ROOT = path.join(TEAM_TMP, "threat-intel-ws");
const TI_DEAD_B = "session-c02a7edb-dead";
const TI_DEAD_C = "session-4c0d96ca-dead";
const threatEnv = rotateEnv({
	askScript: [[__testing.SELF_SUCCESSOR_LABEL]],
	teams: [{
		name: "threat-intel",
		createdAt: 1_700_000_000_000,
		workspace: TI_ROOT,
		policy: { writer: "coordinator" },
		rotationBackup: null,
		roles: [seededRole("coordinator", "session-ti-coord"), seededRole("b", TI_DEAD_B), seededRole("c", TI_DEAD_C)],
	}],
	extraAgents: [{ id: "session-ti-coord", status: "idle" }, { id: TI_DEAD_B, status: "idle" }, { id: TI_DEAD_C, status: "idle" }],
});
threatEnv.setHiddenAgent(TI_DEAD_B, true);
threatEnv.setHiddenAgent(TI_DEAD_C, true);
const tiOut = await threatEnv.tool("team_link_recover").execute({ action: "reappoint", team: "threat-intel", role: "b" }, execFor(threatEnv.agentFor("session-ti-coord")));
const tiDialog = threatEnv.uq.requests[0];
const tiMinted = at(threatEnv.creates, 0, {}).sessionId;
check("U9 (c): 事故形状下对话框照常弹出，且选项里**含**常驻的「自建继任者」——候选集 = 活成员（这里是协调者自己）∪ 合成候选，不再是「只有一个已就座的人可选」", tiDialog !== undefined && tiDialog.questions[0].options.map((option) => option.label).join(",") === `session-ti-coord,${__testing.SELF_SUCCESSOR_LABEL}` && tiOut.includes("已按 §11.9.4 L2 铸好换届包"));
check("U9 (c): 选中合成候选后 `agents.create` 真被调用，且铸出来的 id 是 §10.2.2 模板形 team-link-<team>-<role>-<uuid8>（与被恢复的角色同名段）", threatEnv.creates.length === 1 && typeof tiMinted === "string" && /^team-link-threat-intel-b-[0-9a-f]{8}$/u.test(tiMinted) && tiMinted !== TI_DEAD_B);
check("U9 (c): prepare.successor 就是这个新铸的 id，令牌绑定三元组 (threat-intel, b, <minted>)、TTL 30 分钟——prepare 逐字跑，令牌类型未新增", threatEnv.role("b").pending !== null && threatEnv.role("b").pending.session === tiMinted && threatEnv.role("b").pending.team === "threat-intel" && threatEnv.role("b").pending.role === "b" && threatEnv.role("b").pending.expiresAt - threatEnv.role("b").pending.createdAt === 30 * 60000 && threatEnv.team().rotationBackup !== null);
check("U9 (c): 新建的会话是**根会话**——meta 里没有 origin / parentSession / delegationDepth / parentAgent 任何血统字段", threatEnv.creates[0]?.meta?.origin === undefined && threatEnv.creates[0]?.meta?.parentSession === undefined && threatEnv.creates[0]?.meta?.parentAgent === undefined);
check("U9 (c): 三处留痕齐全——① 版本史 recoveries(verb=reappoint, to=<minted>)；② roster.md 镜像；③ decisions.md 追加（带队名/角色/继任者）", at(threatEnv.role("b").recoveries, 0, {}).verb === "reappoint" && at(threatEnv.role("b").recoveries, 0, {}).from === TI_DEAD_B && at(threatEnv.role("b").recoveries, 0, {}).to === tiMinted && at(threatEnv.role("b").recoveries, 0, {}).by === "session-ti-coord" && String(at(threatEnv.role("b").recoveries, 0, {}).note).includes("recovery(reappoint, vacant-due-to-death,"));
// The trails and the hand-over document are read from DISK (the mirror and the
// ledger are the durable half of §11.9.5⑦; the document is what the successor
// actually receives).
const tiMirror = await readOrMissing(path.join(TI_ROOT, "team", "threat-intel", "roster.md"));
const tiDecisions = await readOrMissing(path.join(TI_ROOT, "team", "threat-intel", "decisions.md"));
const tiDocument = await __testing.latestHandoffDocument(threatEnv.team(), "b");
const tiDocumentText = tiDocument.path === null ? "" : await readOrMissing(tiDocument.path);
check("U9 (c) 留痕②③: roster.md 镜像写明恢复记录与继任者 id（且不含活性词——落盘文件不烙读数）；decisions.md 追加了 recovery reappoint 行", tiMirror.includes("恢复记录（team_link_recover，共 1 条）") && tiMirror.includes(tiMinted) && !tiMirror.includes("seated-dead") && tiDecisions.includes("recovery reappoint team=threat-intel role=b") && tiDecisions.includes(`to=${tiMinted}`));
check("U9 (c) 交接文档: 插件真写了一份 handoff-b-*.md（§11.9.6 头部 + 事实段 + 正文），头部 successor 就是新铸的 id，previous 是死前任，且掩码令牌与 prepare 返回的是同一枚", tiDocument.path !== null && tiDocumentText.includes(`successor: ${tiMinted}`) && tiDocumentText.includes(`previous: ${TI_DEAD_B}`) && tiDocumentText.includes("事实段") && tiDocumentText.includes(`tokenMask: ${__testing.maskToken(threatEnv.role("b").pending.token)}`));

// 交接正文本身（§4.2 (c) ④）: 判据读的是**真函数**（__testing 导出），不是把正文抄
// 一份进测试——抄一份就锁不住漂移。
// Y7 纪律（本仓库的脏红教训）：一个还没实现的可测面被直接调用，会让整跑在那一行崩掉、
// 连 `assertion total` 都不打印——那样红相就说不清自己有多大。所以先取，再判类型。
const buildSelfBody = __testing.selfBuiltHandoffBody;
const selfBody = typeof buildSelfBody !== "function" ? "" : buildSelfBody({
	teamName: "threat-intel",
	roleName: "b",
	incumbent: TI_DEAD_B,
	caller: "session-ti-coord",
	cwd: TI_ROOT,
	goal: { readable: false, reason: `该角色的前任会话 ${TI_DEAD_B} 没有活动代理——goals 按 agent 取读数，所以取不到` },
	trust: { pairs: 2, trustedSenders: 1, rememberTargets: 0 },
});
const selfReport = __testing.handoffBodyReport(selfBody);
check("U9 (c) 交接正文: 插件从 roster 事实生成的正文**五硬节全在场且非空**（与 HANDOFF_HARD_SECTIONS 逐字同名），读不到的项如实标未知、没有编造", selfReport.missingHard.length === 0 && selfReport.emptyHard.length === 0 && __testing.HANDOFF_HARD_SECTIONS.every((name) => selfBody.split("\n").includes(`## ${name}`)) && selfBody.includes("前任已死，进行中工作不可读") && selfBody.includes("**未知**") && selfBody.includes("不可读，本节不做推测") && selfBody.includes(TI_DEAD_B));
check("U9 (c) 交接正文: commitments 节只报**存在性与数量**（不复制任何密钥素材），并写明信任不在本次迁移、靠 claim 逐项勾选", selfBody.includes("pairs：2 条") && selfBody.includes("trustedSenders：1 条") && selfBody.includes("rememberTargets：0 条") && selfBody.includes("不在本次迁移") && selfBody.includes("team_link_rotate action=claim"));
check("U9 (c) 对话框代价声明: 选「自建继任者」的代价写在框里（空上下文的新会话、历史不迁移、信任靠 claim 逐项勾选），候选集口径改为「活成员 ∪ 自建继任者（常驻）」", (() => {
	const question = String(tiDialog?.questions?.[0]?.question ?? "");
	const option = String(tiDialog?.questions?.[0]?.options?.at(-1)?.description ?? "");
	const reading = `{questionHasCost:${question.includes("空上下文的新会话")}, hasNoMigrate:${question.includes("历史/对话**不迁移**")}, hasUnion:${question.includes("活成员 ∪ 插件自建继任者（常驻）")}, optionHasCost:${option.includes("空上下文的新会话")}, optionIsSynthetic:${option.includes(__testing.SELF_SUCCESSOR_LABEL)}}`;
	const ok = question.includes("空上下文的新会话") && question.includes("历史/对话**不迁移**") && question.includes("活成员 ∪ 插件自建继任者（常驻）") && option.includes("空上下文的新会话") && option.includes(__testing.SELF_SUCCESSOR_LABEL);
	return ok || (console.log(`     实测读数 ${reading}`), false);
})());

// --- U10 (§4.2 (c) ①，**批次 4 收窄**): 闸门只关「自建继任者」这条支路 ----------
// 语义变更（差异审计第 5 条 / N1）：闸门原先在**动词入口**，于是无 `agents.create` 的宿主上
// 「改任给活成员」被整动词一并拒掉——那是本批之前不存在的回归，而旧断言恰好把它钉成了判据
// （「零弹框」）。旧断言按新语义**改写**（不是删除），红相读数见 verification-log 批次 4。
// 新语义两条：① 弹框照开、候选里只列活成员、选中后 prepare 照常跑完；② 仅当活成员候选也为 0
// 时才 fail-closed 且零弹框（紧跟其后的那条）。
const noCreateEnv = rotateEnv({ askScript: [["session-worker-b"]], omitAgentsCreate: true, teams: reapTeam(reapRoles()), extraAgents: reapAgents() });
noCreateEnv.setHiddenAgent(REAP_DEAD, true);
const noCreateOut = await noCreateEnv.tool("team_link_recover").execute({ action: "reappoint", team: "night-shift", role: "coordinator" }, execFor(noCreateEnv.agentFor("session-worker-a")));
check("U10 (c，批次 4 收窄): 宿主没有 agents.create 时**弹框照开**、候选里只列活成员（不出现「自建继任者」），选中活成员后 prepare 逐字跑完、零创建——活成员改任这条路不需要该服务（N1：只降级该面子面）", (() => {
	const ask = noCreateEnv.uq.requests[0];
	const labels = ask === undefined ? [] : ask.questions[0].options.map((option) => option.label);
	const question = String(ask?.questions?.[0]?.question ?? "");
	const ok = noCreateEnv.uq.requests.length === 1
		&& labels.join(",") === "session-target,session-worker-a,session-worker-b"
		&& !labels.includes(__testing.SELF_SUCCESSOR_LABEL)
		&& question.includes("本宿主没有可用的 agents.create")
		&& !question.includes("活成员 ∪ 插件自建继任者")
		&& noCreateOut.includes("已按 §11.9.4 L2 铸好换届包")
		&& noCreateOut.includes("不在候选里")
		&& noCreateEnv.creates.length === 0
		&& noCreateEnv.role().pending !== null
		&& noCreateEnv.role().pending.session === "session-worker-b"
		&& noCreateEnv.team().rotationBackup !== null;
	return ok || (console.log(`     实测读数 ${JSON.stringify({ labels, dialogs: noCreateEnv.uq.requests.length, creates: noCreateEnv.creates.length, pending: noCreateEnv.role().pending?.session ?? null })}`), false);
})());
// ② 两条路同时不存在（无 agents.create + 零活成员候选）⇒ 仍是 fail-closed 报告 + 零弹框。
// 夹具：唯一的活会话 session-target 已不是任何角色的现任（它是 coordinator 的**前任**），
// 于是活成员候选恰为 0——这正是「零弹框」在新语义下唯一还存在的那一格。
const noCreateNoLiveEnv = rotateEnv({
	askScript: [[__testing.SELF_SUCCESSOR_LABEL]],
	omitAgentsCreate: true,
	teams: reapTeam([
		seededRole("coordinator", REAP_DEAD, { history: [{ session: "session-target", from: 1_700_000_000_000, until: 1_700_000_100_000 }, { session: REAP_DEAD, from: 1_700_000_100_000, until: null }] }),
		seededRole("worker-a", "session-dead-a"),
		seededRole("worker-b", "session-dead-b"),
	]),
// no extraAgents: the only live sessions are the setup's own stubs, and none of them
// seats a role — so `reapCandidateRoles` finds zero live candidates.
});
const noCreateNoLiveOut = await noCreateNoLiveEnv.tool("team_link_recover").execute({ action: "reappoint", team: "night-shift", role: "coordinator" }, execFor(noCreateNoLiveEnv.agentFor("session-target")));
check("U10 (c) 收窄的另一半: **仅当活成员候选也为 0** 时 fail-closed——零弹框、零创建、零令牌、零 freeze、零写入，并给出三条既有路径", (() => {
	const ok = noCreateNoLiveOut.includes("没有可用的 agents.create")
		&& noCreateNoLiveOut.includes("任何可改任的活成员")
		&& noCreateNoLiveOut.includes("team_link_rotate action=prepare")
		&& noCreateNoLiveOut.includes("设置 UI")
		&& noCreateNoLiveOut.includes("本次恢复调用自身零写入")
		&& noCreateNoLiveEnv.uq.requests.length === 0
		&& noCreateNoLiveEnv.creates.length === 0
		&& noCreateNoLiveEnv.role().pending === null
		&& noCreateNoLiveEnv.team().rotationBackup === null
		&& (noCreateNoLiveEnv.role().recoveries ?? []).length === 0;
	return ok || (console.log(`     实测读数 ${JSON.stringify({ dialogs: noCreateNoLiveEnv.uq.requests.length, creates: noCreateNoLiveEnv.creates.length, out: String(noCreateNoLiveOut).slice(0, 160) })}`), false);
})());

// --- U11 (§4.2 (c) 回归): 合成候选常驻**不**削弱取消语义 -----------------------
check("U11 (c 回归): 候选集里多了常驻的合成候选之后，「什么都不勾选 = 什么都不做」一字未变——对话框里确实有合成候选，而本次调用零令牌、零 freeze、零写入", reapCancel.includes("未改任（reappoint）") && reapCancelEnv.uq.requests[0].questions[0].options.map((option) => option.label).includes(__testing.SELF_SUCCESSOR_LABEL) && reapCancelEnv.role().pending === null && reapCancelEnv.team().rotationBackup === null && (reapCancelEnv.role().recoveries ?? []).length === 0);

// --- §4.2 收敛性红利: 合成继任者的 id 就是 revive 的适用域 ---------------------
check("§4.2 收敛性: 候选集的合成项由插件常驻产出（label 是插件常量、单选项恰一条 LIVE + 一条合成），而 `reapCandidateRoles` 的活成员部分仍按活性过滤", (() => {
	if (typeof __testing.reapCandidateRoles !== "function" || typeof __testing.candidateLabel !== "function") return false;
	const rows = __testing.reapCandidateRoles(threatEnv.team(), "b", (id) => id === "session-ti-coord");
	return rows.length === 2 && rows[0].session === "session-ti-coord" && rows[0].synthetic === false && rows[1].synthetic === true && rows[1].label === __testing.SELF_SUCCESSOR_LABEL && __testing.candidateLabel(rows[0]) === "session-ti-coord" && __testing.candidateLabel(rows[1]) === __testing.SELF_SUCCESSOR_LABEL;
})());


// ---------------------------------------------------------------------------
// 批次 4（审计 A–D 收口）：合成链路**补投递** · task-and-goal 接 goals 读数
// ---------------------------------------------------------------------------
// 变异基线（修复前必红）:
//  (C) `appointSelfBuiltSuccessor` 止于审计留痕 ⇒ 刚建出的继任者**从未收到**令牌与交接
//      文档（对照 `successor:"auto"` 的结尾是 `handle.agent.followup(…)`，见 §11.4.5），
//      即：新建的继任者空转（审计第 9 条）；
//  (D) `selfBuiltHandoffBody` 把 `task-and-goal` 硬编码成「未知」，而它算出的 goals 读数只
//      落到了 `in-flight` ⇒ 该节**声明的数据源从未被消费**（审计第 8 条）。
// 两条判据都读**真函数/真投递**，不抄一份进测试。

// --- C (§11.4.5): 投递令牌与交接正文给刚建出的继任者 -------------------------
// `threatEnv` 就是 U9 的那条合成链路：它已经跑完（`prepare` 落盘、三处留痕、文档写出），
// 所以这里读的是那条链路**投出去的**东西，而不是重跑一遍。
const tiCreated = at(threatEnv.created, 0, {});
const tiFollowups = tiCreated?.calls?.followedup ?? [];
const tiDelivered = at(tiFollowups, 0, undefined);
check("C: 新建的继任者真的收到了令牌与交接正文——一次 followup（不是 inject：任务需要驱动），正文含明文令牌、交接文档路径与五硬节正文", tiFollowups.length === 1 && tiDelivered !== undefined && typeof tiDelivered.content?.[0]?.text === "string" && tiDelivered.content[0].text.includes(String(threatEnv.role("b").pending.token)) && tiDelivered.content[0].text.includes(tiDocument.path) && tiDelivered.content[0].text.includes("## task-and-goal") && tiDelivered.content[0].text.includes("## mission"));
check("C: ... 且这条投递走的是那条被审计的三成员 source（kind/form/senderSessionId），没有第四个成员", tiDelivered !== undefined && Object.keys(tiDelivered.source).join(",") === "kind,form,senderSessionId" && tiDelivered.source.kind === "agent-message" && tiDelivered.source.form === "relay" && tiDelivered.source.senderSessionId === "session-ti-coord");
check("C: ... 回执如实报出投递这一步（§11.4.5），而不是把「铸好了令牌」当成「已经交给它了」", tiOut.includes("投递（§11.4.5）：已用 followup 把令牌与交接正文投给") && tiOut.includes(String(tiMinted)));

// --- D (§4.2 (c) ④): task-and-goal 接 goals 读数 ------------------------------
/** One `## <name>` section of a hand-over body, up to the next `## ` heading. */
const handoffSection = (body, name) => {
	const parts = String(body).split(/^## /mu);
	const hit = parts.find((part) => part.startsWith(`${name}\n`));
	return hit === undefined ? "" : hit;
};
const selfBodyWithGoal = typeof buildSelfBody !== "function" ? "" : buildSelfBody({
	teamName: "threat-intel",
	roleName: "b",
	incumbent: TI_DEAD_B,
	caller: "session-ti-coord",
	cwd: TI_ROOT,
	goal: { readable: true, text: "phase=active · activation=armed · rounds=3/8" },
	trust: { pairs: 2, trustedSenders: 1, rememberTargets: 0 },
});
check("D: goals 有读数时 task-and-goal 填的就是那份读数（不再是硬编码的「未知」）——这一节声明的数据源真的被消费了", (() => {
	const section2 = handoffSection(selfBodyWithGoal, "task-and-goal");
	const ok = section2.includes("phase=active · activation=armed · rounds=3/8") && !section2.includes("**未知**") && section2.includes("停工时刻的快照") && section2.includes(TI_DEAD_B);
	return ok || (console.log(`     实测读数 ${JSON.stringify(section2.slice(0, 160))}`), false);
})());
check("D 对照（真的读不到时）: 没有读数的那一支仍然如实标未知并给出原因——「读不到才标未知」的另一半", (() => {
	const section2 = handoffSection(selfBody, "task-and-goal");
	return section2.includes("**未知**") && section2.includes("请由人类，或在场的旧任，补写这一节") && section2.length > 0;
})());
check("D unknowns 对照: goal 有读数之后，unknowns 不再声称「前任的 goal 未知」，改说这份读数**覆盖不到**的那一部分（读数只到 phase / activation / rounds）", (() => {
	const section2 = handoffSection(selfBodyWithGoal, "unknowns");
	return !section2.includes("前任的 goal：") && section2.includes("正文与后续意图") && handoffSection(selfBody, "unknowns").includes("前任的 goal：");
})());

// ---------------------------------------------------------------------------
// 批次 1 (§4.1): the download route behind the platform's trust fence
// ---------------------------------------------------------------------------
// 变异基线（修复前必红）: the route served a full session export to a request the
// platform's own fence REFUSES (cross-site Host/Origin), and every method was
// served like GET. The pre-fix readings are the ones the assertions below
// measure — they are the reason this batch exists (§6 U1/U2/U6).

const FENCE_EVENTS = [{ type: "user/message", seq: 1, time: 1, data: { id: "f1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "栅栏夹具正文" }] } }];
const FENCE_SESSION = { header: { id: "session-fence", createdAt: 1000, cwd: CWD }, live: true, persisted: true };
const fenceEnv = setup({ sessions: [FENCE_SESSION], eventsBySession: { "session-fence": FENCE_EVENTS }, connectionStub: makeFencedConnection() });
const fenceRoute = fenceEnv.routes.find((route) => route.path === "/team-link/export");

// U1 (a) — the decision itself, as a pure function on the frozen `__testing`
// surface (§4.1 ②'s 可测面): no HTTP fixture is needed to read the verdict.
const exportGateRejection = __testing.exportGateRejection;
// A SEPARATE instance for the pure-function case: `calls` below is the witness
// that the ROUTE consulted the fence, and the direct calls here would otherwise
// be counted as if the handler had made them.
const fencedService = makeFencedConnection().service;
check("U1（纯函数）: the `connection + req → 状态码|null` decision is a pure function on the frozen `__testing` surface — cross-site Host 403, unauthenticated 401, authenticated `null`, and a fence that is absent or THROWS is 503 (fail-closed)",
	typeof exportGateRejection === "function"
	&& exportGateRejection(fencedService, { headers: { host: "evil.example:3080" } }) === 403
	&& exportGateRejection(fencedService, { headers: { host: "127.0.0.1:3080" } }) === 401
	&& exportGateRejection(fencedService, { headers: { host: "127.0.0.1:3080", cookie: "dsh_session=ok" } }) === null
	&& exportGateRejection(undefined, { headers: {} }) === 503
	&& exportGateRejection({}, { headers: {} }) === 503
	&& exportGateRejection({ requestRejection() { throw new Error("fence exploded"); } }, { headers: {} }) === 503
	&& Object.isFrozen(__testing));

// U1 (b) — the same verdict through the REAL handler, with the platform's own
// rule (Host/Origin → 403) installed in the connection stub.
const crossSite = await callRoute(fenceRoute, {
	method: "GET",
	url: "/team-link/export?session=session-fence&format=json",
	headers: { host: "evil.example:3080", origin: "http://evil.example", "sec-fetch-site": "cross-site" },
});
check("U1: a cross-site request no longer receives data — 403 with the official body, no session id, no session text, and `sessionQuery.readSession` was never called",
	crossSite.statusCode === 403 && crossSite.body === "forbidden"
	&& !crossSite.body.includes("栅栏夹具正文") && !crossSite.body.includes("session-fence")
	&& fenceEnv.query.readSessionCalls.length === 0);
check("U1: ... and the refusal came from the PLATFORM fence: the route handed the request to `connection.requestRejection` verbatim (the first call it saw carries the cross-site Host)",
	fenceEnv.connection.calls.length === 1 && fenceEnv.connection.calls[0]?.headers?.host === "evil.example:3080");
const unauthenticated = await callRoute(fenceRoute, {
	method: "GET",
	url: "/team-link/export?session=session-fence&format=json",
	headers: { host: "127.0.0.1:3080" },
});
check("U1: ... the fence's 401 branch is written back the same way (same-origin but no authentication cookie) and still reads no session at all",
	unauthenticated.statusCode === 401 && unauthenticated.body === "unauthorized"
	&& fenceEnv.connection.calls.length === 2 && fenceEnv.query.readSessionCalls.length === 0);

// The second layer (§4.1 ②: 请求期纵深). Mount-time gating alone would leave the
// window where the fence service is torn down after the route mounted; the
// handler re-reads it, so that window is fail-closed too.
const tornEnv = setup({ sessions: [FENCE_SESSION], eventsBySession: { "session-fence": FENCE_EVENTS }, connectionStub: makeFencedConnection() });
const tornRoute = tornEnv.routes.find((route) => route.path === "/team-link/export");
const savedRejection = tornEnv.connection.service.requestRejection;
delete tornEnv.connection.service.requestRejection;
const torn = await callRoute(tornRoute, { method: "GET", url: "/team-link/export?session=session-fence&format=json", headers: { host: "127.0.0.1:3080", cookie: "dsh_session=ok" } });
tornEnv.connection.service.requestRejection = savedRejection;
check("U1 对照（请求期纵深）: with the fence gone AFTER the mount the handler re-checks and ends with 503 instead of serving — no unguarded route exists in any timing (§5 B2)",
	torn.statusCode === 503 && torn.body === "unavailable" && tornEnv.query.readSessionCalls.length === 0);

// U5 — the trusted, authenticated caller is unaffected (the fence tightens the
// route, it does not replace it).
const trusted = await callRoute(fenceRoute, {
	method: "GET",
	url: "/team-link/export?session=session-fence&format=md",
	headers: { host: "127.0.0.1:3080", cookie: "dsh_session=ok" },
});
check("U5: a trusted, authenticated request is served exactly as before — 200, the same content-disposition filename invariant, and this time the session really was read",
	trusted.statusCode === 200 && trusted.headers?.["content-disposition"] === 'attachment; filename="session-fence.md"'
	&& trusted.body.includes("栅栏夹具正文") && fenceEnv.query.readSessionCalls.join(",") === "session-fence");

// U6 — the method whitelist (§4.1 ③), mirroring the official open-in-app shape:
// 405 plus `allow`, and the download never runs.
const postEnv = setup({ sessions: [FENCE_SESSION], eventsBySession: { "session-fence": FENCE_EVENTS }, connectionStub: makeFencedConnection() });
const postRoute = postEnv.routes.find((route) => route.path === "/team-link/export");
const posted = await callRoute(postRoute, {
	method: "POST",
	url: "/team-link/export?session=session-fence&format=json",
	headers: { host: "127.0.0.1:3080", cookie: "dsh_session=ok" },
});
check("U6: a non-GET method is refused with 405 (and `allow: GET`) instead of being served like a download — and nothing was read",
	posted.statusCode === 405 && posted.headers?.allow === "GET" && postEnv.query.readSessionCalls.length === 0);

// U2 — mount-time gating: webServer in, connection out ⇒ NO route at all, with
// exactly one line naming why (§4.1 ①, §5 B1/B2).
const noConnEnv = setup({ sessions: [], omitConnection: true });
const noConnWarns = noConnEnv.log.lines.warn.filter((line) => line.includes("webServer service unavailable at activation"));
check("U2: with a webServer but NO connection the route is NOT registered — there is no unguarded route to find — and exactly one line says which service is missing",
	noConnEnv.routes.length === 0 && noConnWarns.length === 1 && noConnWarns[0].includes("(no connection service)"));
check("U2: ... the export tool keeps working regardless (§4.1: 只降级该面子面)",
	noConnEnv.tool("team_link_export") !== undefined);
const noRejectionEnv = setup({ sessions: [], connectionWithoutRejection: true });
const noRejectionWarns = noRejectionEnv.log.lines.warn.filter((line) => line.includes("webServer service unavailable at activation"));
check("U2 对照: a connection WITHOUT `requestRejection` is the second reason code — still no route, one line naming the missing fence itself",
	noRejectionEnv.routes.length === 0 && noRejectionWarns.length === 1 && noRejectionWarns[0].includes("(connection without requestRejection())"));

// U3 — neither service ever arrives: the pre-existing degradation red line
// (no route, one warn) still holds through the new two-service gate.
const lateBothEnv = setup({ sessions: [], lateWebServer: true, lateConnection: true });
const lateBothWarns = () => lateBothEnv.log.lines.warn.filter((line) => line.includes("webServer service unavailable at activation"));
check("U3: with NEITHER service active nothing is mounted and the one line for the window still stands (the pre-existing late-attach red line)",
	lateBothEnv.routes.length === 0 && lateBothWarns().length === 1);
await lateBothEnv.provideWebServer();
check("U4 前置: webServer alone is still not enough — the route waits for the fence instead of mounting unguarded",
	lateBothEnv.routes.length === 0 && lateBothWarns().length === 1);
await lateBothEnv.provideConnection();
check("U4: once BOTH services are up the route mounts (the late-attach pattern now waits for the pair, and the window still left exactly one line)",
	lateBothEnv.routes.some((route) => route.path === "/team-link/export") && lateBothWarns().length === 1);

// §4.1 红线 B1: the fence rides the OPTIONAL service seam like `webServer` does —
// putting it in the module-level array would gate the whole plugin on it.
const stage1Module = await import("./lib/index.js");
check("§4.1 红线 B1: `connection` is NOT in the module-level inject array — the fence is an optional service, so a host without it loses the route and nothing else",
	sameJson(stage1Module.inject, ["sessionReferenceResolver", "tools", "sessionQuery", "agents"]));

// ===========================================================================
// A 批（可观测批）· 阶段 3：台账收件视图 + 派生回执（team_link_team_read 新块）
// 设计档 §4.3 / §4.4，判据 U10 / U11 / U14 / U12 与 U7 的 team_read 那一半。
// ===========================================================================

const TR_TMP = path.join(TEAM_TMP, "inbox");
const TR_WS = path.join(TR_TMP, "ws");
const TR_TEAM = "inbox-team";
const TR_AT = 1_700_000_000_000;
/** banner 形状照 §3.4 逐字（`ref=` 就在首行里）——收件视图抽的就是它。 */
const trBanner = (sender, ref) => `📨 [跨会话消息 · 来自会话「${sender}」(${sender}) · 2026-09-26 21:19:00 · type=report ref=${ref}]`;
const trCall = (seq, callId, time, args) => ({ type: "tool/call", seq, time, data: { turn: 1, step: 1, callId, name: "team_link_send", arguments: JSON.stringify(args) } });
const trCardResult = (seq, callId, at, ref, targets) => ({
	type: "tool/result", seq, time: at + 1, data: {
		turn: 1, step: 1,
		meta: { kind: "team-link-send", v: 1, at, senderSessionId: "session-self", meta: { ref }, message: { text: "…", truncated: false, chars: 1 }, targets, summary: { delivered: 1, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 }, fanout: false },
		message: { id: `r-${callId}`, role: "user", source: { kind: "tool", callId }, content: [] },
	},
});
/** D4（修复轮）: the receipt the SENDER text truncates with `targetsTruncated` — the derived view
 * must report the receipt's OWN total instead of inventing an identity for a target it never saw. */
const trTruncatedResult = (seq, callId, at, ref, total) => ({
	type: "tool/result", seq, time: at + 1, data: {
		turn: 1, step: 1,
		meta: { kind: "team-link-send", v: 1, at, senderSessionId: "session-self", meta: { ref }, message: { text: "…", truncated: false, chars: 1 }, targets: [{ sessionId: "session-worker-b", outcome: "delivered", detail: "已投递" }], targetsTruncated: { total }, summary: { delivered: 1, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 }, fanout: true },
		message: { id: `r-${callId}`, role: "user", source: { kind: "tool", callId }, content: [] },
	},
});
/** D4（修复轮）: 18 个目标 —— 一次投递就足以越过 `TASK_INBOX_MESSAGES`(20) 的逐行渲染上限，
 * 于是「本次还有 N 行未显示」那行必须出现（N 是真实差额，不是静默截断）。 */
const TR_MANY_TARGETS = Array.from({ length: 18 }, (_, index) => `session-many-${String(index).padStart(2, "0")}`);
const trSelfEvents = [
	{ type: "user/message", seq: 1, time: TR_AT - 60000, data: { id: "u1", role: "user", source: { kind: "agent-message", form: "relay", senderSessionId: "session-worker-b" }, content: [{ type: "text", text: `${trBanner("session-worker-b", "t-7")}\n核出 3 处错（依据 lib/index.js:3548）` }] } },
	{ type: "assistant/message", seq: 2, time: TR_AT - 50000, data: { turn: 1, step: 1, message: { id: "a1", role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "收到，我来核" }] } } },
	{ type: "user/message", seq: 3, time: TR_AT - 40000, data: { id: "u2", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "没有 ref 的普通消息" }] } },
	{ type: "user/message", seq: 4, time: TR_AT - 30000, data: { id: "u3", role: "user", source: { kind: "agent-message", form: "relay", senderSessionId: "session-worker-c" }, content: [{ type: "text", text: `${trBanner("session-worker-c", "t-9")}\n${"长".repeat(100)}` }] } },
	trCall(5, "call-1", TR_AT, { targetSessionId: "session-worker-b", message: "复核 §3", meta: { ref: "t-7" } }),
	trCardResult(6, "call-1", TR_AT, "t-7", [{ sessionId: "session-worker-b", outcome: "delivered", detail: "已投递" }]),
	trCall(7, "call-2", TR_AT + 20000, { targets: ["session-worker-c"], message: "第二条（只有实参，没有结构化回执）", meta: { ref: "t-8" } }),
	trCall(12, "call-6", TR_AT + 25000, { targetSessionId: "session-worker-broken", message: "第六条（点名了但会话面读不到）", meta: { ref: "t-11" } }),
	trCall(8, "call-3", TR_AT + 30000, { targetSessionId: "session-worker-d", message: "第三条（未点名）", meta: { ref: "t-9" } }),
	trCall(9, "call-4", TR_AT + 40000, { targetSessionId: "session-worker-e", message: "第四条", meta: { ref: "t-10" } }),
	trCardResult(10, "call-4", TR_AT + 40000, "t-10", [{ sessionId: "session-worker-e", outcome: "refused", detail: "未投递：接收方拒绝" }]),
	// 一条没有任务号的投递（如实计数，不进视图）
	trCall(11, "call-5", TR_AT + 50000, { targetSessionId: "session-worker-b", message: "随口一句，没挂任务号", meta: { ref: "slp-abc" } }),
	// D12（修复轮）: 归组面 = **任何消息文本里第一个 `ref=t-<n>`** —— 这条既不是 banner、
	// 也不是别人发来的（本会话自己那条），照样归到 t-7 上，发送方回落标「（本会话）」。
	{ type: "user/message", seq: 13, time: TR_AT + 80000, data: { id: "u5", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "补充：依据 ref=t-7 那一行" }] } },
	// D4（修复轮）: `run_code` 里发出的那一类投递 —— 桥记的 `tool/ptc-dispatch`，**没有**
	// 结构化回执（于是走实参兜底），目标是 `team:<name>/<role>` 表达式（按当前名册解析）。
	{ type: "tool/ptc-dispatch", seq: 14, time: TR_AT + 90000, data: { turn: 1, step: 1, callId: "ptc-1", name: "team_link_send", arguments: JSON.stringify({ targets: ["team:" + TR_TEAM + "/coordinator"], message: "从 run_code 里发的", meta: { ref: "t-7" } }) } },
	// D4（修复轮）: 回执被行数上限裁过的那一笔（回执自己报了 12 个目标，逐行只带回 1 个）。
	trCall(15, "call-7", TR_AT + 100000, { targetSessionId: "session-worker-b", message: "第七条", meta: { ref: "t-12" } }),
	trTruncatedResult(16, "call-7", TR_AT + 100000, "t-12", 12),
	// D4（修复轮）: 逐行渲染上限（TASK_INBOX_MESSAGES=20）——18 个目标一次投递，超出部分
	// 必须**如实标注**而不是静默丢。
	trCall(17, "call-8", TR_AT + 110000, { targets: TR_MANY_TARGETS, message: "第八条", meta: { ref: "t-12" } }),
	trCardResult(18, "call-8", TR_AT + 110000, "t-12", TR_MANY_TARGETS.map((id) => ({ sessionId: id, outcome: "delivered", detail: "已投递" }))),
];
const trBEvents = [
	{ type: "assistant/message", seq: 1, time: TR_AT + 60000, data: { turn: 1, step: 1, message: { id: "b1", role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: "我这边核完了" }] } } },
];
const trCEvents = [
	{ type: "user/message", seq: 1, time: TR_AT + 70000, data: { id: "c1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "只有入站消息，没有 assistant 事件" }] } },
];
const trEnv = setup({
	sessions: [],
	eventsBySession: { "session-self": trSelfEvents, "session-worker-b": trBEvents, "session-worker-c": trCEvents },
	selfCwd: TR_WS,
	useSettings: true,
});
trEnv.ns = trEnv.settings.namespaces.get("team-link");
trEnv.ns.data.teams = [{
	name: TR_TEAM,
	createdAt: TR_AT,
	workspace: TR_WS,
	policy: { writer: "coordinator" },
	roles: [{ role: "coordinator", current: "session-self", pending: null, history: [{ session: "session-self", from: TR_AT, until: null }] }],
}];
const trTasksPath = path.join(TR_WS, "team", TR_TEAM, "tasks.md");
await mkdir(path.dirname(trTasksPath), { recursive: true });
// t-7 已登记；t-9 / t-10 **从未登记**（收件视图照样分组并标注）。
await writeFile(trTasksPath, [
	"1 | 2026-09-26T21:10:02.123Z | session-self | plan | t-7 | 让 worker-b 复核 §3 的行号",
	"2 | 2026-09-26T21:12:44.001Z | session-worker-b | claim | t-7 | 接了",
].join("\n") + "\n", "utf8");

const readCall = async (args, exec = undefined) => {
	const tool = trEnv.tool("team_link_team_read");
	if (tool === undefined) return "【工具未注册】";
	try {
		return String(await tool.execute(args, exec ?? execFor(trEnv.senderAgent)));
	} catch (error) {
		return `【调用失败：${String(error?.message ?? error)}】`;
	}
};

// --- U10/U11: 默认路径 = 只读调用方自己，目标面零读 -----------------------------
const trMark = trEnv.query.surfaceReads.length;
const trOut = await readCall({ team: TR_TEAM });
const trReads = trEnv.query.surfaceReads.slice(trMark);
check("U11 未点名时目标面**零读**: 默认调用只读调用方自己那一次（surface stub 计数恰 = [session-self]）", trReads.length === 1 && trReads[0] === "session-self");
check("U10 收件视图: 从调用方 surface 抽出 ref=t-<n> **按任务号分组**（谁说的 / 什么时候 / 开头几个字符）", trOut.includes("--- 收件视图（按任务号；来源：本会话最近 20 条消息 · 常量 TASK_INBOX_MESSAGES）---") && trOut.includes("- t-7 ← session-worker-b（") && trOut.includes("）：核出 3 处错（依据 lib/index.js:3548）") && trOut.includes("- t-9 ← session-worker-c（") && /^- t-7 ← .+（\d\d-\d\d \d\d:\d\d）：/mu.test(trOut));
check("U10 截断必标注: 超过 TASK_INBOX_PREVIEW(80) 码点的条目就地标注省略了几个字符", trOut.includes("…（已省略 20 字符）"));
check("U10 无 ref 的消息: **不进视图但如实计数**（不静默丢弃）", trOut.includes("（无 ref 的消息 2 条：未归任务，未参与本视图）"));
check("U10 边界: ref 指向**从未登记**过的号 → 照样分组显示，并标注成因（可能是笔误，也可能是先发后记）", trOut.includes("（该号在台账里未登记 —— 可能是笔误，也可能是先发后记）") && (trOut.match(/该号在台账里未登记/gu) ?? []).length === 1 && !trOut.includes("t-7 ← session-worker-b（09-26 21:19）：核出 3 处错（依据 lib/index.js:3548）\n（该号在台账里未登记"));

// --- U14: 派生回执三态（未点名 ⇒ 一律「未读」）---------------------------------
check("U14 未点名: 每一行都标「未读」并给出点名骨架（目标面这一次真的没读）", trOut.includes("- t-7 → session-worker-b（") && trOut.includes("：未读（未点名读该会话；要读 → readIds=[\"session-worker-b\"]）") && trOut.includes("- t-8 → session-worker-c（") && trOut.includes("：未读（未点名读该会话；要读 → readIds=[\"session-worker-c\"]）") && trOut.includes("- t-9 → session-worker-d（"));
check("U14 无任务号的投递如实计数: 没挂 t-<n> 的那一笔不进视图（但有计数行）", trOut.includes("（无任务号的投递 1 次：没有挂到 t-<n> 上，未参与本视图）"));
check("U14 非 delivered 的投递**不冒充**反应读数: 回执 outcome=refused 的那一行如实写「未投递」", trOut.includes("- t-10 → session-worker-e（") && trOut.includes("：未投递（outcome=refused）"));

// --- U14 三态（点名后）：✅ 有反应 / ⚠ 无后续反应 / 未读 ------------------------
const trMark2 = trEnv.query.surfaceReads.length;
const trNamed = await readCall({ team: TR_TEAM, readIds: ["session-worker-b", "session-worker-c", "session-worker-broken", "session-worker-b"] });
const trNamedReads = trEnv.query.surfaceReads.slice(trMark2);
check("U14 ✅ 有反应: 点名的目标面里，投递时刻之后有 assistant 事件 ⇒ 标「有反应」并给出那个时刻", trNamed.includes("- t-7 → session-worker-b（") && /✅ 有反应（\d\d-\d\d \d\d:\d\d 起有 assistant 事件）/u.test(trNamed));
check("U14 ⚠ 无后续反应: 点名的目标面里，投递时刻之后**没有** assistant 事件 ⇒ 标「无后续反应」（只陈述事实，不下结论）", trNamed.includes("：⚠ 无后续反应（该时刻之后无 assistant 事件）"));
check("U14 未读: 没点名的目标（session-worker-d）仍然是「未读」——点名只把被点的那几个变贵", trNamed.includes("- t-9 → session-worker-d（") && trNamed.includes("：未读（未点名读该会话"));
check("U7 成本不变量（team_read 半边）: 自读占 1 个额 + 点名 3 个（去重后）= 4 次 ≤ min(12, 1+|readIds|)=4；同一个 id 不重复读", trNamedReads.length === 4 && trNamedReads[0] === "session-self" && trNamedReads.slice(1).join(",") === "session-worker-b,session-worker-c,session-worker-broken");
check("U14 点名但读不到: 目标面读取失败 ⇒ 标「未读」，**不用空数据算读数**", trNamed.includes("- t-11 → session-worker-broken（") && trNamed.includes("：未读（点名的会话面读取失败——不用空数据算读数）"));
const trMark3 = trEnv.query.surfaceReads.length;
const trMany = await readCall({ team: TR_TEAM, readIds: Array.from({ length: 15 }, (_, index) => `session-tr-${index}`) });
const trManyReads = trEnv.query.surfaceReads.slice(trMark3);
check("U7 成本不变量（team_read 上限）: 15 个点名也只读 1（自读）+ 11（目标面上限）= 12 = min(12, 1+15)，且**零额外**", trManyReads.length === 12 && trManyReads[0] === "session-self");
check("U14 超额的点名**不静默丢**: 超出读额的 4 个被逐个点名标「本次未读」", trMany.includes("readIds 超出目标面读额（自读占 1 个额，最多 11 个）") && trMany.includes("session-tr-11") && trMany.includes("session-tr-14") && trMany.includes("本次未读"));

// --- D4 / D5 / D7 / D12（分歧审计修复轮）: 未覆盖的实现分支逐条钉住 -------------
// 七条断言各自锚在一个**具体的**读数上（不是「跑通了」）：D4 四条（载体不同 / 寻址方式不同 /
// 回执被裁 / 行数越界）、D12 一条（文本归组面）、D5 一条（形状非法）、D7 一条（标注）。
// D7 那一条钉的是「按当前名册解析」这个**标注**，它在修复轮之前不存在 —— 所以它只会在旧实现上红。
const trRowOf = (prefix) => trOut.split("\n").find((line) => line.startsWith(prefix));
const trRosterRow = trRowOf(`- t-7 → team:${TR_TEAM}/coordinator（session-self）`) ?? "";
check("D4 载体: `run_code` 里发出的那一类投递（桥记的 `tool/ptc-dispatch`）同样是**投递事实**——没有结构化回执就按实参兜底出一行，不因为载体不同而漏掉一笔投递",
	trRosterRow !== "" && trOut.includes("--- 派生回执（我发出去之后，对方动了没有；"));
check("D4 实参兜底: 没有结构化回执时按**实参**解析 `team:<name>/<role>` —— 表达式与它解析出的那个会话一并显示，三态照常判",
	trRosterRow.includes(`- t-7 → team:${TR_TEAM}/coordinator（session-self）（`) && trRosterRow.includes(`：未读（未点名读该会话；要读 → readIds=["session-self"]）`));
check("D7 读数不失准: 按**当前名册**解析出来的行如实标注「按当前名册解析」（换届之后它未必是投递当时那一个）；同一批里按字面 id 解析的行**不带**该标注",
	trRosterRow.includes(" · 按当前名册解析（该表达式按读取时的名册解析，未必是投递当时那一个）") && !(trRowOf("- t-7 → session-worker-b（") ?? " · 按当前名册解析").includes("按当前名册解析"));
check("D4 回执截断行: 回执自己报的总数 > 逐行带回的目标数 ⇒ 只报告**回执自己报的总数**，不给一个没见过的目标编身份",
	trOut.includes("- t-12 → （回执共报了 12 个目标，超出逐行渲染上限；明细见该次调用的返回文本——本视图不编目标身份）"));
check("D4 行上限: 逐行渲染上限 = TASK_INBOX_MESSAGES(20) —— 恰好渲染 20 行，其余**如实标注**「本次还有 N 行未显示」（N = 真实差额，不是静默截断）",
	(trOut.match(/^- t-\d+ → /gmu) ?? []).length === 20 && trOut.includes("（本次还有 6 行未显示：一行 = 一次投递里的一个目标；同一屏界常量 TASK_INBOX_MESSAGES）"));
check("D12 归组面: 归组只认「消息文本里第一个 `ref=t-<n>`」——**非 banner** 的普通消息（本会话自己发的那条）同样归组，发送方如实回落标「（本会话）」",
	/^- t-7 ← （本会话）（\d\d-\d\d \d\d:\d\d）：补充：依据 ref=t-7 那一行$/mu.test(trOut));
const trNonArrayMark = trEnv.query.surfaceReads.length;
const trNonArray = await readCall({ team: TR_TEAM, readIds: "session-worker-b" });
check("D5 readIds 非数组: 工具面直接拒绝（数组是硬形状，不是靠实现里的兜底分支），且该次调用**零读**——拒绝发生在任何 surface 读之前",
	trNonArray.startsWith("【调用失败：") && trNonArray.includes("readIds") && trNonArray.includes("must be an array") && trEnv.query.surfaceReads.length === trNonArrayMark);

// --- U12: 既有四块零回归（唯一新增是收件视图 / 派生回执块）-----------------------
const trHeaders = ["--- roster（概要；事实源 = 设置 team-link 的 teams 键）---", "--- decisions.md（只追加；此处显示末 20 条）---", "--- discipline.md（整文件替换，带 baseHash 乐观锁）---", "--- tasks.md（只追加台账；显示末 20 条）---", "--- 收件视图（按任务号；", "--- 派生回执（我发出去之后，对方动了没有；"];
check("U12 零回归: 既有四块（roster / decisions / discipline / tasks）仍在且顺序不变，新块**唯一新增**并排在 tasks 之后", trHeaders.every((needle, index) => trOut.includes(needle) && (index === 0 || trOut.indexOf(needle) > trOut.indexOf(trHeaders[index - 1]))) && (trOut.match(/baseHash=[0-9a-f]{16}/gu) ?? []).length === 3 && trOut.includes("（原始行）"));
check("U12 零回归: 派生读数（最后主张 / 未消解存疑）与原始行窗口一字未动地留在 tasks 块里", trOut.includes("（派生读数：扫描最近 500 行；逐任务给「最后主张」与「未消解存疑」——是读数，不是裁决）") && trOut.includes(`- t-7 · 2 行 · 最后主张 claim（${localMinute("2026-09-26T21:12:44.001Z")} · session-worker-b）`) && trOut.includes("| plan | t-7 | 让 worker-b 复核 §3 的行号"));

// ===========================================================================
// A 批（可观测批）· 阶段 2：只读团队状态卡 team_link_status（六段 + 参数边界 + U13）
// 设计档 §4.2，判据 U8 / U9 / U13 与 U7 的 status 那一半。
// ===========================================================================

/** Y7-safe invoker for the NEW tool: on the pre-implementation module it is not
 * registered at all, so reading `.execute` would throw — the text below makes the
 * assertion RED instead of aborting the run. */
async function statusCall(env, args, exec = undefined) {
	const tool = env.tool("team_link_status");
	if (tool === undefined) return "【团队状态卡工具未注册】";
	try {
		return String(await tool.execute(args, exec ?? execFor(env.senderAgent)));
	} catch (error) {
		return `【参数被拒：${String(error?.message ?? error)}】`;
	}
}

const ST_TMP = path.join(TEAM_TMP, "status");
const ST_WS = path.join(ST_TMP, "ws");
const ST_BARE_WS = path.join(ST_TMP, "ws-bare");
const ST_TOTEN = "1a2b3c4d-5e6f-7890-abcd-ef1234567890";
const ST_TEAM = "status-card";
const ST_IDS = Array.from({ length: 14 }, (_, index) => `session-st-${String(index).padStart(2, "0")}`);
/** 一个 surface 的全部消息共用**同一个时间戳**：锚 T0 之后一条消息都没有 ——
 * 正是 §4.2 触发条件的前半个（N == 0）。 */
const stSameStampEvents = [
	{ type: "user/message", seq: 1, time: 7, data: { id: "s1", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "同一时刻" }] } },
	{ type: "assistant/message", seq: 2, time: 7, data: { turn: 1, step: 1, message: { id: "s2", role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "text", text: "同一时刻" }] } } },
];
const stTeamRow = (name, workspace) => ({
	name,
	createdAt: 1_700_000_000_000,
	workspace,
	policy: { writer: "coordinator" },
	roles: [
		{
			role: "coordinator",
			current: "session-self",
			pending: { session: "session-new", token: ST_TOTEN, team: name, role: "coordinator", createdAt: 1_700_000_000_000, expiresAt: 1_700_001_800_000, migratedPairs: [] },
			history: [{ session: "session-old", from: 1, until: 2, note: "交班" }, { session: "session-self", from: 2, until: null }],
		},
		{ role: "worker", current: null, pending: null, history: [] },
	],
});
/** 状态卡的夹具单独搭（不走 teamEnv）：teamEnv 不转发 eventsBySession，而本卡要的
 * 正是**真的**消息事件（注记的 T0 / N 都从它们里数）。其余与 teamEnv 同源：settings
 * 引擎开启，然后把 teams 种进同一个命名空间。 */
const stEnv = setup({
	sessions: ST_IDS.map((id, index) => ({ header: { id, createdAt: 1000 + index, cwd: ST_WS }, live: true, persisted: true })),
	eventsBySession: Object.fromEntries(ST_IDS.map((id) => [id, stSameStampEvents])),
	extraAgents: ST_IDS.map((id) => ({ id, status: "idle" })),
	selfCwd: ST_WS,
	useSettings: true,
});
stEnv.ns = stEnv.settings.namespaces.get("team-link");
stEnv.ns.data.teams = structuredClone([stTeamRow(ST_TEAM, ST_WS), stTeamRow("bare-team", ST_BARE_WS)]);
stEnv.ns.data.watchdogs = [{ id: "wd-test", team: "", watcherSession: "session-self", targets: ["session-st-00"], silentMinutes: 10, intervalMinutes: 5, expiresAt: 1_700_003_600_000, createdAt: 1_700_000_000_000 }];

const stTasksPath = path.join(ST_WS, "team", ST_TEAM, "tasks.md");
await mkdir(path.dirname(stTasksPath), { recursive: true });
await writeFile(stTasksPath, [
	"1 | 2026-09-26T21:10:02.123Z | session-lead | plan | t-7 | 让 worker-b 复核 §3 的行号",
	"2 | 2026-09-26T21:12:44.001Z | session-wb | claim | t-7 | 接了，预计 10 分钟",
	"3 | 2026-09-26T21:19:31.552Z | session-wb | done | t-7 | 核出 3 处错（依据 lib/index.js:3548）",
	"4 | 2026-09-26T21:21:08.900Z | session-lead | dispute | t-7 | 对 43 存疑：第 2 处的行号我读到的不一样",
	"5 | 2026-09-26T21:24:55.310Z | session-wb | retract | t-7 | 撤回 43 的第 2 处",
	"6 | 2026-09-26T21:30:00.000Z | session-lead | plan | t-8 | 第二件事",
	"7 | 2026-09-26T21:31:00.000Z | session-wb | claim | t-8 | 接了",
].join("\n") + "\n", "utf8");

const stMark = stEnv.query.surfaceReads.length;
const stOut = await statusCall(stEnv, { team: ST_TEAM, tasksTail: 3 });
const stReads = stEnv.query.surfaceReads.slice(stMark);

check("U8 段①角色: 每位角色一行给出「在位/空缺」与**版本史末条**（只给最后一段任期，不是整段史）", stOut.includes("--- 团队与角色（" + ST_TEAM + "；来源：设置 team-link 的 teams 键）---") && stOut.includes("角色 coordinator：现任 session-self（自 ") && stOut.includes("角色 worker：空缺（vacant）") && stOut.includes("· 版本史末条：session-self ") && stOut.includes("→ 现任") && !stOut.includes("session-old"));
check("U8 段②换届 pending: 角色/继任者/到期齐全，且 token **掩码**（完整令牌一个字都不出现）", stOut.includes("--- 换届 pending（在飞令牌；token 一律掩码）---") && stOut.includes(ST_TEAM + "/coordinator → 继任者 session-new") && stOut.includes("到期 2023-") && stOut.includes("token " + __testing.maskToken(ST_TOTEN) + "（掩码") && !stOut.includes(ST_TOTEN));
check("U8 段③看门狗: 谁盯谁 / 阈值 / 到期（来源 policy.watchdogs）", stOut.includes("--- 看门狗（policy.watchdogs；") && stOut.includes("wd-test") && stOut.includes("观察者 session-self（空闲）") && stOut.includes("目标 session-st-00") && stOut.includes("静默阈 10min") && stOut.includes("巡检 5min"));
check("U8 段④会话面: id / 代理状态 / 创建时间 / provisional 标记（本条不读日志）", stOut.includes("--- 会话面（同工作区其他会话：") && stOut.includes("- session-st-00 — ○ 空闲 · 创建于 ") && !stOut.includes("provisional 配对 0 条"));
check("U8 段⑤活性（有界）: 前 12 行给真实 verdict，第 13 行起如实标注**本卡**的窗口", (stOut.match(/^- session-st-\d\d：verdict=/gmu) ?? []).length === 12 && stOut.includes("--- 活性（有界：与 team_link_list_sessions 同一顺序读前 12 行）---") && stOut.includes("session-st-12：未读（本卡只读了前 12 行）") && stOut.includes("session-st-13：未读（本卡只读了前 12 行）"));
check("U8 段⑥台账尾: 指定条数如实显示，并给出 baseHash 的审计口径", stOut.includes("--- 台账尾（tasks.md 末 3 条；tasksTail 默认 5、上限 20）---") && stOut.includes("- " + ST_TEAM + "/tasks.md：共 7 行，显示 3 条") && stOut.includes("baseHash=") && stOut.includes("仅供参考/审计：tasks 只追加、不接受 baseHash 参数") && stOut.includes("| plan | t-8 | 第二件事") && !stOut.includes("| plan | t-7 | 让 worker-b"));
check("U8 整卡: 六段齐 + 读数戳 + 当前会话（本工作区）", ["团队与角色", "换届 pending", "看门狗", "会话面", "活性（有界", "台账尾"].every((needle) => stOut.includes(needle)) && /团队状态卡（读数 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}，>2min 作废）/u.test(stOut) && stOut.includes("当前工作区：" + ST_WS + "（当前会话：session-self）"));
check("U7 成本不变量（status 半边）: 状态卡本次 surface 读数 ≤ PREVIEW_SESSIONS=12（与列表工具同一个有界读窗）", stReads.length === 12);

// --- 参数与边界 ---------------------------------------------------------------
const stUnknown = await statusCall(stEnv, { team: "no-such-team" });
check("U8 边界: team 不存在 → 拒绝并**列出已知团队名**（不编造、不静默空卡）", stUnknown.includes("状态卡读取失败") && stUnknown.includes("no-such-team") && stUnknown.includes(ST_TEAM) && stUnknown.includes("bare-team"));
const stTooMany = await statusCall(stEnv, { team: ST_TEAM, tasksTail: 21 });
check("U8 边界: tasksTail 超上限（21 > 20）→ 拒绝并给出有效区间 1..20", stTooMany.includes("状态卡读取失败") && stTooMany.includes("tasksTail 越界") && stTooMany.includes("1..20"));
const stZero = await statusCall(stEnv, { team: ST_TEAM, tasksTail: 0 });
check("U8 边界: tasksTail 非正 → 拒绝（同一区间口径）", stZero.includes("状态卡读取失败") && stZero.includes("1..20"));
const stNoTail = await statusCall(stEnv, { team: ST_TEAM });
check("U8 默认值: 省略 tasksTail ⇒ 末 5 条（默认值写进段标题）", stNoTail.includes("--- 台账尾（tasks.md 末 5 条；tasksTail 默认 5、上限 20）---"));
const stAggregate = await statusCall(stEnv, {});
check("U8 聚合: 省略 team ⇒ 本工作区全部团队各一段（两个团队都在，标题报总数）", stAggregate.includes("--- 团队与角色（共 2 个团队；") && stAggregate.includes("- " + ST_TEAM + " —") && stAggregate.includes("- bare-team —"));
const stNoIdentity = await statusCall(stEnv, { team: ST_TEAM }, { signal: new AbortController().signal });
check("U8 无会话身份: 照常出卡，「当前会话」改为如实标注（当前会话未知）——不编造身份", stNoIdentity.includes("（当前会话未知）") && stNoIdentity.includes("--- 团队与角色") && !stNoIdentity.includes("当前会话：undefined"));

// --- U9: 全只读（调用前后 settings 与磁盘文件逐字节不变）------------------------
const stSettingsBefore = JSON.stringify(stEnv.ns.data);
const stFileBefore = await readFile(stTasksPath, "utf8");
const stDiskBefore = createHash("sha256").update(stFileBefore, "utf8").digest("hex");
const stWriteProbe = await statusCall(stEnv, { tasksTail: 5 });
const stFileAfter = await readFile(stTasksPath, "utf8");
check("U9 零写入: 调用前后 settings 命名空间逐字节不变（不新增键、不改 teams/watchdogs/pending）", JSON.stringify(stEnv.ns.data) === stSettingsBefore);
check("U9 零写入: 磁盘上的 tasks.md 逐字节不变（连换届过期清扫都不跑——那会写）", stFileAfter === stFileBefore && createHash("sha256").update(stFileAfter, "utf8").digest("hex") === stDiskBefore && stWriteProbe.includes("台账尾"));

// --- U13: 反面预警注记（N == 0 且 M > 0 才出现；零额外读）------------------------
check("U13 触发: 本读窗消息全在同一时刻（N == 0）而台账同期新增行（M > 0）⇒ 打注记，且只陈述两个计数", stOut.includes("--- 反面预警注记 ---") && /⚠ 窗口内 0 条消息 \/ 台账同期新增 \d+ 行 —— 会话可能已停止说话只写行（读数，不是裁决）。/u.test(stOut) && stOut.includes("台账同期新增 7 行"));
// N > 0: 换一组「锚之后还有消息」的 surface —— 同一批 session 的新 surface 直接换掉 stub 的事件表。
const stLaterEnv = setup({
	sessions: ST_IDS.map((id, index) => ({ header: { id, createdAt: 1000 + index, cwd: ST_WS }, live: true, persisted: true })),
	eventsBySession: Object.fromEntries(ST_IDS.map((id) => [id, ancientEvents("锚之后还有消息")])),
	extraAgents: ST_IDS.map((id) => ({ id, status: "idle" })),
	selfCwd: ST_WS,
	useSettings: true,
});
stLaterEnv.settings.namespaces.get("team-link").data.teams = structuredClone([stTeamRow(ST_TEAM, ST_WS), stTeamRow("bare-team", ST_BARE_WS)]);
const stLater = await statusCall(stLaterEnv, { team: ST_TEAM });
check("U13 不触发（N > 0）: 读窗里有锚之后的消息 ⇒ 不打注记（连那一段标题都不出现）", !stLater.includes("反面预警注记") && stLater.includes("--- 活性（有界"));
const stNoLedger = await statusCall(stEnv, { team: "bare-team" });
check("U13 不触发（M == 0）: 换一个没有台账的团队 ⇒ N == 0 但 M == 0 ⇒ 不打注记", !stNoLedger.includes("反面预警注记") && stNoLedger.includes("（文件不存在，按空处理：0 行）"));
// --- D9（修复轮）: 这半句原先**恒真**（`slice(length)` 永远是空数组），换成真实计数：
// 打注记的那一次与不打注记的那一次，各自的 surface 读数**恰都是有界读窗的 12 行** ——
// 两个计数相等即证明注记本身零读；哪一次多读一个会话，这条就会红。
const stNoteMark = stEnv.query.surfaceReads.length;
const stNoteCall = await statusCall(stEnv, { team: ST_TEAM, tasksTail: 3 });
const stNoteReads = stEnv.query.surfaceReads.slice(stNoteMark);
const stLaterMark = stLaterEnv.query.surfaceReads.length;
const stLaterCall = await statusCall(stLaterEnv, { team: ST_TEAM });
const stLaterReadsAgain = stLaterEnv.query.surfaceReads.slice(stLaterMark);
check("U13 零额外读: 打注记的那一次与不打注记的那一次，surface 读数**逐次相等**（各恰 12 = 同一个有界读窗），注记本身零读",
	stNoteReads.length === 12 && stLaterReadsAgain.length === 12 && stNoteReads.length === stLaterReadsAgain.length && stNoteCall.includes("反面预警注记") && !stLaterCall.includes("反面预警注记"));

// --- D1 / §8.1 A5（修复轮）: 注记的**第三态**「无时间戳 ⇒ 无法计算」--------------
// 读窗**非空**，但窗内没有一条**带时间戳的** surface 消息 ⇒ 锚 T0 取不到。此时打的是
// 「无法计算」那一句（诚实优于沉默），**不是**计数注记，也**不是**整段消失 —— 台账里
// 的行照常显示（证明「M 有行可数」不是它沉默的原因）。
const stNoStampEvents = [{ type: "turn/start", seq: 1, time: 1_700_000_000_000, data: { turn: 1 } }];
const ST_NOSTAMP_WS = path.join(ST_TMP, "ws-nostamp");
const stNoStampEnv = setup({
	sessions: ST_IDS.slice(0, 3).map((id, index) => ({ header: { id, createdAt: 1000 + index, cwd: ST_NOSTAMP_WS }, live: true, persisted: true })),
	eventsBySession: Object.fromEntries(ST_IDS.slice(0, 3).map((id) => [id, stNoStampEvents])),
	extraAgents: ST_IDS.slice(0, 3).map((id) => ({ id, status: "idle" })),
	selfCwd: ST_NOSTAMP_WS,
	useSettings: true,
});
stNoStampEnv.ns = stNoStampEnv.settings.namespaces.get("team-link");
stNoStampEnv.ns.data.teams = [stTeamRow("nostamp-team", ST_NOSTAMP_WS)];
const stNoStampTasks = path.join(ST_NOSTAMP_WS, "team", "nostamp-team", "tasks.md");
await mkdir(path.dirname(stNoStampTasks), { recursive: true });
await writeFile(stNoStampTasks, Array.from({ length: 3 }, (_, index) => `${index + 1} | 2026-09-26T21:${String(10 + index).padStart(2, "0")}:02.123Z | session-lead | plan | t-${index + 1} | 第 ${index + 1} 件事`).join("\n") + "\n", "utf8");
const stNoStamp = await statusCall(stNoStampEnv, { team: "nostamp-team" });
check("D1/A5 注记第三态: 读窗非空但窗内**没有带时间戳的** surface 消息（锚 T0 取不到）⇒ 打「无法计算」那一句并**不打**计数注记（不猜，也不沉默）",
	stNoStamp.includes("--- 反面预警注记 ---") && stNoStamp.includes("（反面预警注记无法计算：本读窗内没有带时间戳的 surface 消息——不猜。）") && !stNoStamp.includes("台账同期新增") && stNoStamp.includes("共 3 行，显示 3 条"));

// --- D2①（修复轮）: 读窗为空 ⇒ 注记**整段不打印** ------------------------------
// 本工作区里没有别的会话（读窗 0 行）：没有可对比的两边，连那一段标题都不出现 ——
// 这与「打一句无法计算」是两件不同的事，判据各钉一条。
const ST_NOWIN_WS = path.join(ST_TMP, "ws-nowin");
const stNoWinEnv = setup({ sessions: [], extraAgents: [], selfCwd: ST_NOWIN_WS, useSettings: true });
stNoWinEnv.ns = stNoWinEnv.settings.namespaces.get("team-link");
stNoWinEnv.ns.data.teams = [stTeamRow("nowin-team", ST_NOWIN_WS)];
const stNoWinTasks = path.join(ST_NOWIN_WS, "team", "nowin-team", "tasks.md");
await mkdir(path.dirname(stNoWinTasks), { recursive: true });
await writeFile(stNoWinTasks, Array.from({ length: 3 }, (_, index) => `${index + 1} | 2026-09-26T21:${String(10 + index).padStart(2, "0")}:02.123Z | session-lead | plan | t-${index + 1} | 第 ${index + 1} 件事`).join("\n") + "\n", "utf8");
const stNoWin = await statusCall(stNoWinEnv, { team: "nowin-team" });
check("D2① 读窗为空: 本工作区没有其他会话（读窗 0 行）⇒ 注记**整段不打印**（连标题都不出现），即使台账里有行可数",
	!stNoWin.includes("反面预警注记") && stNoWin.includes("共 3 行，显示 3 条") && stNoWin.includes("--- 活性（有界"));

// --- D10（修复轮）: 聚合口径的 M = **所示各团队**同期新增行数之**和** -----------
const ST_AGG_WS = path.join(ST_TMP, "agg", "ws");
const stAggEnv = setup({
	sessions: ST_IDS.slice(0, 2).map((id, index) => ({ header: { id, createdAt: 1000 + index, cwd: ST_AGG_WS }, live: true, persisted: true })),
	eventsBySession: Object.fromEntries(ST_IDS.slice(0, 2).map((id) => [id, stSameStampEvents])),
	extraAgents: ST_IDS.slice(0, 2).map((id) => ({ id, status: "idle" })),
	selfCwd: ST_AGG_WS,
	useSettings: true,
});
stAggEnv.ns = stAggEnv.settings.namespaces.get("team-link");
stAggEnv.ns.data.teams = [stTeamRow("agg-a", ST_AGG_WS), stTeamRow("agg-b", ST_AGG_WS)];
for (const [name, count] of [["agg-a", 3], ["agg-b", 2]]) {
	const file = path.join(ST_AGG_WS, "team", name, "tasks.md");
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, Array.from({ length: count }, (_, index) => `${index + 1} | 2026-09-26T21:${String(10 + index).padStart(2, "0")}:02.123Z | session-lead | plan | t-${index + 1} | 第 ${index + 1} 件事`).join("\n") + "\n", "utf8");
}
const stAggNote = await statusCall(stAggEnv, {});
check("D10 聚合口径（上限）: 省略 team ⇒ 注记里的 M = **所示各团队** tasks.md 同期新增行数之**和**（3 + 2 = 5；既不是只数第一个团队，也不逐团队各打一段）",
	stAggNote.includes("--- 反面预警注记 ---") && stAggNote.includes("台账同期新增 5 行") && stAggNote.includes("agg-a/tasks.md：共 3 行") && stAggNote.includes("agg-b/tasks.md：共 2 行"));

// ===========================================================================
// A 批（可观测批）· 阶段 1：读窗 readIds / offset / 成本不变量 / 尾巴提示
// 设计档 docs/observability-batch-design-2026-09-26.md §4.1，判据 U1–U6 与 U7 的
// list_sessions 那一半（team_read / team_link_status 两半在各自阶段补齐）。
// ===========================================================================

/** Y7-safe invoker（本仓既有纪律）: the PRE-implementation tool has no `readIds` /
 * `offset` parameter at all, so `defineTool` refuses the call BEFORE the body runs
 * (an argument-schema violation is thrown, not returned). That rejection is turned
 * into text here so the new assertions go RED on the old implementation instead of
 * aborting the run before its own `assertion total` line. */
async function listCall(env, args) {
	try {
		return String(await env.tool("team_link_list_sessions").execute(args, execFor(env.senderAgent)));
	} catch (error) {
		return `【参数被拒：${String(error?.message ?? error)}】`;
	}
}

const RW_IDS = Array.from({ length: 14 }, (_, index) => `session-rw-${String(index).padStart(2, "0")}`);
const rwEnv = setup({
	sessions: RW_IDS.map((id, index) => ({ header: { id, createdAt: 1000 + index, cwd: CWD }, live: true, persisted: true })),
	eventsBySession: Object.fromEntries(RW_IDS.map((id) => [id, ancientEvents(`读窗主题 ${id}`)])),
	extraAgents: RW_IDS.map((id) => ({ id, status: "idle" })),
});
/** The rows of one listing, split exactly the way the §3.1 window test does. */
const rwRows = (out) => out.split(/\n(?=- session-rw-)/u).filter((block) => block.startsWith("- session-rw-"));
const rwRowOf = (out, id) => rwRows(out).find((block) => block.startsWith(`- ${id} `));
/** Everything from the tail's first line on — the batch's ONE format addition. */
const rwTailOf = (out) => out.slice(out.indexOf("读窗："));

const rwDefault = await listCall(rwEnv, {});
/** The surface stub ACCUMULATES across calls (it is the list of every id read, in
 * call order), so each path's cost is read as a DELTA — one mark per call. */
const rwMarks = [rwEnv.query.surfaceReads.length];
check("U1 默认调用: 读窗就是前 12 行（surfaceReads 恰 12 个且逐个按序），与现状一字未改", rwEnv.query.surfaceReads.length === 12 && rwEnv.query.surfaceReads.every((id, index) => id === RW_IDS[index]));
check("U1 默认调用: 每行结构逐字保持（id — 代理状态 · 创建于 … （读数 …，>2min 作废）），14 行全在", rwRows(rwDefault).length === 14 && /^- session-rw-0\d — ○ 空闲 · 创建于 .+（读数 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}，>2min 作废）$/mu.test(rwRowOf(rwDefault, RW_IDS[3])));
check("U1 默认调用: 窗口内 12 行给出真实 verdict，窗口外 2 行标未读（既有口径逐字）", (rwDefault.match(/^    活性：verdict=/gmu) ?? []).length === 12 && (rwRowOf(rwDefault, RW_IDS[12]) ?? "").includes("活性：未读（超出快照窗口 12）") && (rwRowOf(rwDefault, RW_IDS[13]) ?? "").includes("活性：未读（超出快照窗口 12）"));
check("U1 默认调用: 末尾新增「未读 Y 行 + 怎么读」提示段（本次唯一的格式新增），且它在最后一行之后", rwDefault.includes("未读 2 行（读窗 12/共 14 行）") && rwDefault.includes("读第 13–24 行 → offset=12") && rwDefault.includes("或点名 → readIds=[") && rwDefault.indexOf("读窗：") > rwDefault.lastIndexOf("- session-rw-13"));
check("U1 默认调用: 提示段给的是**真的**未读 id（可复制的参数），不是占位符", rwTailOf(rwDefault).includes(`readIds=["${RW_IDS[12]}", "${RW_IDS[13]}"]`) && !rwTailOf(rwDefault).includes("<id>"));

const rwPage = await listCall(rwEnv, { offset: 12 });
const rwPageReads = rwEnv.query.surfaceReads.slice(rwMarks[0]);
rwMarks.push(rwEnv.query.surfaceReads.length);
check("U2 offset=12: 读的是第 13 行起的那一页（恰两行），前 12 行本次不再是「已读」那一批", rwPageReads.length === 2 && rwPageReads[0] === RW_IDS[12] && rwPageReads[1] === RW_IDS[13]);
check("U2 offset=12: 被翻到的那两行给出真实 verdict，窗口外的 12 行改标未读", (rwRowOf(rwPage, RW_IDS[13]) ?? "").includes("活性：verdict=silent-idle") && (rwRowOf(rwPage, RW_IDS[5]) ?? "").includes("活性：未读（超出快照窗口 12）") && (rwPage.match(/^    活性：verdict=/gmu) ?? []).length === 2);
check("U2 offset=12: 尾巴如实报出本页读窗（读窗 2/共 14 行）并给下一页/点名的下一步", rwPage.includes("读窗：offset=12 起的 2 行") && rwPage.includes("未读 12 行（读窗 2/共 14 行）") && rwPage.includes(`readIds=["${RW_IDS[0]}"`));

const rwNamed = await listCall(rwEnv, { readIds: [RW_IDS[13]] });
const rwNamedReads = rwEnv.query.surfaceReads.slice(rwMarks[1]);
rwMarks.push(rwEnv.query.surfaceReads.length);
check("U3 readIds: 窗口外的 id 被点名后给出真实 verdict（不再是「未读」）", (rwRowOf(rwNamed, RW_IDS[13]) ?? "").includes("活性：verdict=silent-idle") && !(rwRowOf(rwNamed, RW_IDS[13]) ?? "").includes("未读（超出快照窗口"));
check("U3 readIds: 点名优先占额、其余按原顺序补足到 12（本行 = 被点名的那个 + 前 11 行）", rwNamedReads.length === 12 && rwNamedReads[0] === RW_IDS[13] && rwNamedReads.slice(1).every((id, index) => id === RW_IDS[index]));
check("U3 readIds: 返回体标明本次是点名读（读窗来源写在提示段里）", rwNamed.includes(`读窗：点名读 1 个（${RW_IDS[13]}）+ 默认窗补足`) && rwNamed.includes("【参数被拒") === false);

// 边界（§4.1 逐条给行为）: 重复 id 去重后计数；本就在默认窗内的 id 只占一个额、不重复读。
const rwDup = await listCall(rwEnv, { readIds: [RW_IDS[13], RW_IDS[13]] });
const rwDupReads = rwEnv.query.surfaceReads.slice(rwMarks[2]);
check("U3 边界: readIds 含重复 id → 去重后计数（仍是 1 个点名），且不会重复读同一个会话", rwDup.includes(`读窗：点名读 1 个（${RW_IDS[13]}）`) && rwDupReads.length === 12 && new Set(rwDupReads).size === 12);
const rwInside = await listCall(rwEnv, { readIds: [RW_IDS[0]] });
const rwInsideReads = rwEnv.query.surfaceReads.slice(rwMarks[2] + rwDupReads.length);
check("U3 边界: 点名的 id 本就在默认窗内 → 只占一个额、不重复读（12 个 id 各读一次，窗口内容不变）", rwInsideReads.length === 12 && new Set(rwInsideReads).size === 12 && rwInsideReads.filter((id) => id === RW_IDS[0]).length === 1 && (rwRowOf(rwInside, RW_IDS[0]) ?? "").includes("活性：verdict="));

// U4/U5/U6: every refusal happens BEFORE any session log is touched — 零读。
const rwBefore = rwEnv.query.surfaceReads.length;
const rwTooMany = await listCall(rwEnv, { readIds: RW_IDS.slice(0, 13) });
check("U4 readIds 超上限: 13 个（> 12）→ 拒绝，且明说上限与「本次零读」的出路", rwTooMany.includes("列出会话失败") && rwTooMany.includes("最多 12 个") && rwTooMany.includes("去重后 13 个"));
check("U4 readIds 超上限: 该次调用**零读**（surface stub 计数不动）", rwEnv.query.surfaceReads.length === rwBefore);
const rwUnknown = await listCall(rwEnv, { readIds: [RW_IDS[3], "session-not-in-this-list"] });
check("U5 readIds 含未知/非本列表 id: 拒绝并**指出那个 id**，指路先复制正确的 id", rwUnknown.includes("列出会话失败") && rwUnknown.includes("session-not-in-this-list") && rwUnknown.includes("不属于本次列表") && rwUnknown.includes("team_link_list_sessions"));
check("U5 readIds 含未知 id: 同样**零读**", rwEnv.query.surfaceReads.length === rwBefore);
const rwBoth = await listCall(rwEnv, { readIds: [RW_IDS[0]], offset: 0 });
check("U6 互斥: readIds 与 offset 同现 → 拒绝（明说互斥与成本上限同源）", rwBoth.includes("列出会话失败") && rwBoth.includes("互斥"));
const rwFrac = await listCall(rwEnv, { offset: 1.5 });
check("U6 offset 非整数: 拒绝并指出收到的值", rwFrac.includes("列出会话失败") && rwFrac.includes("必须是整数") && rwFrac.includes("1.5"));
const rwNeg = await listCall(rwEnv, { offset: -1 });
check("U6 offset 为负数: 拒绝（是整数但越界）并给有效区间 0..13", rwNeg.includes("列出会话失败") && rwNeg.includes("有效区间 0..13") && rwNeg.includes("本次列表共 14 行"));
const rwFar = await listCall(rwEnv, { offset: 99 });
check("U6 offset 超界: 拒绝并给有效区间", rwFar.includes("列出会话失败") && rwFar.includes("有效区间 0..13"));
check("U6 三类拒绝一律**零读**（拒绝发生在任何 surface 读之前）", rwEnv.query.surfaceReads.length === rwBefore);
// U7（list_sessions 那一半）: the invariant is a NUMBER per call, so each path's
// measured count is asserted against it — 默认 12 · offset 2 · 点名 12 · 重复去重 12 ·
// 点名窗内 12，没有任何一条路径越过 PREVIEW_SESSIONS。
const rwCounts = [rwEnv.query.surfaceReads.slice(0, rwMarks[0]).length, rwPageReads.length, rwNamedReads.length];
check("U7 成本不变量（按工具分账 · list_sessions 三路径 ≤ 12，stub 计数逐一断言）: 默认 12 / offset 2 / 点名 12，逐条 ≤ PREVIEW_SESSIONS=12", rwCounts.every((count) => Number.isInteger(count) && count <= 12) && rwCounts[0] === 12 && rwCounts[1] === 2 && rwCounts[2] === 12);


// ===========================================================================
// B 批（形态批）· 阶段 1：形态字段 + normalizeTeams 降级 + 读面形态段（只读）
// 设计档 docs/team-mode-batch-design-2026-09-26.md §4.1 / §4.3，判据 U1 / U11。
// ===========================================================================

const MD_TMP = path.join(TEAM_TMP, "mode");
const MD_WS = path.join(MD_TMP, "ws");
const MD_LEAD = "session-md-lead";
const MD_MEMBERS = [
	{ id: MD_LEAD, name: "lead", role: "lead", status: "running", diagnostics: [] },
	{ id: "session-md-coder", name: "coder", role: "teammate", status: "inactive", model: "m", diagnostics: [] },
];
/** §4.3 的结论句（与插件里的常量逐字相同的那半句；断言按它切出矩阵区域）。 */
const MD_CONCLUSION = "结论：agent-team 档应叫「单会话兜底档」";
/** D7① 逐行锁：能力矩阵的**八行原文**（事实源 = 父档 §2.3 的表；D4 起第 7 行是**已核**口径
 * —— 2026-09-27 真机实测「宿主 agentTeams 服务已挂载」，旧的「未复核」限定词已作废）。
 * 改这条锁 = 改事实源，两处必须同改。 */
const MD_MATRIX_ROWS = [
	"| 跨会话投递（team_link_send） | ✅ 主用途 | ❌ 成员是子代理，不是可投递目标 |",
	"| 双门批准 / 配对 | ✅ | ❌ 用不上（宿主那套没有独立信任模型） |",
	"| 换届（rotate）/ 恢复（recover） | ✅ | ❌ 没有可换届的会话；Lead 会话没了团队就散了 |",
	"| 看门狗（watch） | ✅ | ❌ teammate 不是根代理，盯不了 |",
	"| 黑板（decisions / discipline / tasks） | ✅ | ⚠️ 仍可用，但只有 Lead 一方读写 |",
	"| roster 身份 / 版本史 | ✅ | ⚠️ 只记「本团队是 agent-team 档 + Lead 是谁」 |",
	"| 团队状态卡（只读） | ✅ | ⚠️ 成员部分读宿主投影（2026-09-27 已核：本部署已挂载该服务 ⇒ 探针 available=true） |",
	"| 会话深链 / 导出 | ✅ | ✅ 与形态无关 |",
];

/** 宿主 `agentTeams` 替身：**只给两个读方法**，其余方法调用即抛错并记账 ——
 * 「只读宿主」（红线 1）因此由**行为**钉住，而不是靠注释。形状按实测的宿主读面
 * （`tryMembership(agent)` / `listMembers(agent)`，两者都以**活动代理本人**为凭据）。 */
function makeAgentTeams({ members = MD_MEMBERS, isMember = true, listThrows = false } = {}) {
	const calls = { tryMembership: 0, listMembers: 0, writes: [] };
	const service = {
		tryMembership(agent) { calls.tryMembership += 1; return isMember ? { root: agent, id: "team-md", role: "lead", name: "lead" } : undefined; },
		// 两条**不同**的失败形状各由一条断言钉住（D2②）：`isMember:false` ⇒ tryMembership 返回
		// undefined（调用方不在宿主团队里，读面根本走不到 listMembers）；`listThrows:true` ⇒ 读面两个
		// 方法都在、凭据也认，但 listMembers 自己抛错（**读取抛错**档）。
		listMembers(agent) { calls.listMembers += 1; if (listThrows) throw new Error("宿主 listMembers 读取抛错"); if (!isMember) throw new Error("not a team member"); return members; },
	};
	for (const name of ["spawnTeammate", "sendMessage", "createTask", "getTask", "listTasks", "updateTask", "waitForChange", "interrupt"]) {
		service[name] = () => { calls.writes.push(name); throw new Error(`宿主写调用 ${name} 被禁止（红线 1：只读宿主）`); };
	}
	return { service, calls };
}

/** Y7-safe invoker（本仓既有纪律）: 旧实现没有 `set-mode` 这个动词，`defineTool`
 * 会在**参数 schema** 上直接拒绝（抛错，不是返回字符串）—— 收成一段文本，让新判据在旧实现上
 * 报 FAIL 而不是把整轮打崩。 */
async function rosterCall(env, args, exec = undefined) {
	const tool = env.tool("team_link_roster");
	if (tool === undefined) return "【roster 工具未注册】";
	try { return String(await tool.execute(args, exec ?? execFor(env.senderAgent))); }
	catch (error) { return `【参数被拒：${String(error?.message ?? error)}】`; }
}

// --- U1: 形态默认 + 闭集外降级留痕 -------------------------------------------
// 四条行：① 老 settings 行（**没有** mode / leadSessionId 两个键）② 闭集外的值
// ③ 正常的 agent-team 行 ④ agent-team 但 Lead 为空。
const mdLegacyRow = teamRow({ name: "legacy-team", workspace: MD_WS });
const mdBadRow = { ...teamRow({ name: "bad-mode-team", workspace: MD_WS }), mode: "agentTeam" };
const mdHostRow = { ...teamRow({ name: "host-team", workspace: MD_WS }), mode: "agent-team", leadSessionId: MD_LEAD };
const mdNoLeadRow = { ...teamRow({ name: "nolead-team", workspace: MD_WS }), mode: "agent-team", leadSessionId: "" };
const mdAgentTeams = makeAgentTeams();
const mdEnv = teamEnv({
	teams: [mdLegacyRow, mdBadRow, mdHostRow, mdNoLeadRow],
	sessions: [{ header: { id: MD_LEAD, createdAt: 1000, cwd: MD_WS }, live: true, persisted: true }],
	extraAgents: [{ id: MD_LEAD, status: "running" }],
	selfCwd: MD_WS,
});
mdEnv.ctx.provide("agentTeams", mdAgentTeams.service);
const mdRawBefore = JSON.stringify(mdEnv.ns.data.teams);
const mdGet = await rosterCall(mdEnv, { action: "get" }, execFor(mdEnv.senderAgent));
const mdDetail = await rosterCall(mdEnv, { action: "get", team: "host-team" }, execFor(mdEnv.senderAgent));
/** 同一个夹具、**不提供**宿主投影：§4.3 的第二种文案与红线 2 的读路径降级。 */
const mdNoHostEnv = teamEnv({
	teams: [mdLegacyRow, mdBadRow, mdHostRow, mdNoLeadRow],
	sessions: [{ header: { id: MD_LEAD, createdAt: 1000, cwd: MD_WS }, live: true, persisted: true }],
	extraAgents: [{ id: MD_LEAD, status: "running" }],
	selfCwd: MD_WS,
});
const mdNoHostGet = await rosterCall(mdNoHostEnv, { action: "get" }, execFor(mdNoHostEnv.senderAgent));

check("B/U1 形态默认（零迁移）: 老 settings 行（连模式字段都没有）读出来是 sessions，且**读取本身不改 settings**——盘上那一行仍然没有 mode / leadSessionId 两个键，整份 teams 逐字节不变",
	mdGet.includes("- legacy-team：形态=sessions") && JSON.stringify(mdEnv.ns.data.teams) === mdRawBefore && mdEnv.ns.data.teams[0].mode === undefined && mdEnv.ns.data.teams[0].leadSessionId === undefined);
check("B/U1 闭集外降级 + 留痕: mode=「agentTeam」（闭集外）落 sessions，并在读面上留一行点名**原值**与**闭集**，而 settings 里的原值不被改写",
	mdGet.includes("- bad-mode-team：形态=sessions") && mdGet.includes("形态降级留痕") && mdGet.includes("agentTeam") && mdGet.includes("闭集 sessions / agent-team") && mdEnv.ns.data.teams[1].mode === "agentTeam");
check("B/U1 纯函数: normalizeTeams 自己就完成降级——闭集外 ⇒ sessions（并留痕）；空串 / 非字符串 ⇒ sessions（= 未写，不记降级）；合法 agent-team 与 Lead 指针原样保留",
	__testing.normalizeTeams([{ name: "a-team", mode: "agentTeam" }, { name: "b-team", mode: "" }, { name: "c-team", mode: 7 }, { name: "d-team", mode: "agent-team", leadSessionId: "session-x" }]).map((team) => team.mode + "/" + team.leadSessionId).join(",") === "sessions/,sessions/,sessions/,agent-team/session-x");
check("B/U11 形态 + Lead: agent-team 行显示它的 Lead 指针；Lead 为空时如实标「未知」**不编造**",
	mdGet.includes("- host-team：形态=agent-team · Lead=" + MD_LEAD) && mdGet.includes("- nolead-team：形态=agent-team · Lead 未知"));
check("B/U11 名册可读（文案一）: 宿主 agentTeams 投影在场时如实标来源，并逐行给出成员（Lead / teammate + 状态）——且投影是**读时现算**（settings 里零成员字段）",
	mdGet.includes("来源：宿主 agentTeams 投影（本部署可读）") && mdGet.includes("- lead（Lead，running）") && mdGet.includes("- coder（teammate，inactive") && mdAgentTeams.calls.listMembers >= 1 && JSON.stringify(mdEnv.ns.data.teams).includes("session-md-coder") === false);
// D7①: 这条锁原先只钉「4 个 ❌ ＋ 3 个 ⚠️ ＋ 其中两行原文」，其余六行的**文本漂移不会红**
// —— 一条真盲区。现在逐行锁八行原文（含表头恰 9 行、行数不多不少），任何一行的字面改动都红。
check("B/U11 完整能力矩阵（D7① 逐行锁八行原文）: 矩阵区恰 9 行（表头 ＋ 八行），八行逐字与父档 §2.3 相同、顺序一致、一行不多一行不少（含第 7 行的**已核**口径），四件 ❌ / 三件 ⚠️ / 一件与形态无关，并给出「单会话兜底档」那句结论",
	(() => {
		const start = mdGet.indexOf("| 能力 | 多会话档 | agent-team 档 |");
		const end = mdGet.indexOf(MD_CONCLUSION);
		if (start === -1 || end === -1 || end < start) return false;
		const matrix = mdGet.slice(start, end);
		const rows = matrix.split(/\r?\n/u).filter((line) => line.startsWith("| ") && line.endsWith(" |"));
		const body = rows.filter((line) => line !== "| 能力 | 多会话档 | agent-team 档 |");
		return rows.length === 9 && body.length === 8 && body.every((line, index) => line === MD_MATRIX_ROWS[index])
			&& (matrix.match(/❌/gu) ?? []).length === 4 && (matrix.match(/⚠️/gu) ?? []).length === 3
			&& mdGet.includes("多会话不可用时才切，切过去就等于放弃跨会话的全部能力。");
	})());
check("B/U11 名册不可读（文案二）: 宿主没有该投影时如实标不可读**并点名原因**，而形态 + Lead + 能力矩阵照旧可读（红线 2 的读路径降级，不是拒绝）",
	mdNoHostGet.includes("成员名册不可读（本部署未提供该投影）—— 仍可读 Lead 与形态") && mdNoHostGet.includes("不可读原因") && mdNoHostGet.includes("- host-team：形态=agent-team · Lead=" + MD_LEAD) && mdNoHostGet.includes("| 能力 | 多会话档 | agent-team 档 |"));
check("B/U11 聚合与点名: 省略 team 时形态段覆盖**每一个**团队（一行一个），点名 team 时给同一套形态段与结论",
	["legacy-team", "bad-mode-team", "host-team", "nolead-team"].every((name) => mdGet.includes("- " + name + "：形态=")) && mdDetail.includes(MD_CONCLUSION) && mdDetail.includes("- host-team：形态=agent-team · Lead=" + MD_LEAD));
check("B/U11 只读宿主: 形态段对宿主**零写调用**（替身里每个写方法一被调用就抛错并记账），同时投影确实被读了（否则这条只是「什么都没发生」）",
	mdAgentTeams.calls.writes.length === 0 && mdAgentTeams.calls.tryMembership >= 1 && mdAgentTeams.calls.listMembers >= 1);
check("B/U11 零回归锁: 读面既有内容一字未少（注册表头行 / 角色现任行 / 详情块 / 黑板根 / 读数戳）——本批只**追加**形态段",
	mdDetail.includes("团队注册表（共 4 个团队）") && mdDetail.includes("角色 coordinator：现任 session-self") && mdDetail.includes("团队 host-team 详情：") && mdDetail.includes("黑板目录：") && /（读数 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}，>2min 作废）/u.test(mdDetail));



// ===========================================================================
// B 批（形态批）· 阶段 2：set-mode 第五动词（宿主探测 · 双重门 · Lead 校验与默认 ·
// decisions 一行 · 幂等 · fail-closed）
// 设计档 docs/team-mode-batch-design-2026-09-26.md §4.2 / §4.4，判据 U2–U7 / U10 / U11b。
// ===========================================================================

const SM_WS = path.join(MD_TMP, "sm-ws");
const SM_TEAM = "sm-team";
const SM_OTHER = "session-sm-other";
const smBoard = path.join(SM_WS, "team", SM_TEAM);
const smDecisions = path.join(smBoard, "decisions.md");
const SM_TRUST_PAIRS = [{ a: "session-self", b: SM_OTHER, createdAt: 1 }];
const SM_TRUST_SENDERS = ["session-self"];
const SM_TRUST_TARGETS = [SM_OTHER];

/** 切档夹具：一条团队行（形态可指定）、一个**可读**的宿主投影替身、一份非空的信任数据
 * （U10 的对照物：切档**一行都不许写**它）。 */
function modeSetEnv({ mode = undefined, lead = undefined, askScript = ["切换"], omitUserQuestions = false, agentTeams = makeAgentTeams(), current = "session-self", writer = "coordinator", workspace = SM_WS } = {}) {
	const row = { ...teamRow({ name: SM_TEAM, workspace, current, writer }), ...(mode === undefined ? {} : { mode }), ...(lead === undefined ? {} : { leadSessionId: lead }) };
	const env = teamEnv({
		teams: [row],
		askScript,
		omitUserQuestions,
		selfCwd: SM_WS,
		sessions: [{ header: { id: SM_OTHER, createdAt: 1000, cwd: SM_WS }, live: true, persisted: true }],
		extraAgents: [{ id: SM_OTHER, status: "idle" }],
	});
	env.ns.data.pairs = structuredClone(SM_TRUST_PAIRS);
	env.ns.data.trustedSenders = [...SM_TRUST_SENDERS];
	env.ns.data.rememberTargets = [...SM_TRUST_TARGETS];
	if (agentTeams !== undefined && agentTeams !== null) env.ctx.provide("agentTeams", agentTeams.service);
	env.agentTeams = agentTeams;
	env.row = () => env.ns.data.teams[0];
	env.trust = () => JSON.stringify([env.ns.data.pairs ?? [], env.ns.data.trustedSenders ?? [], env.ns.data.rememberTargets ?? []]);
	return env;
}
/** decisions.md 的当前内容（不存在 = 空串），用于「恰好一行」与「零新增」两类断言。 */
const smDecisionsText = async () => {
	try { return await readFile(smDecisions, "utf8"); } catch { return ""; }
};

// --- U2: 正常路径（确认框选「切换」⇒ 落笔 + decisions 恰好一行）---------------
const smOk = modeSetEnv();
const smTrustBefore = smOk.trust();
const smOkDecBefore = await smDecisionsText();
const smOkOut = await rosterCall(smOk, { action: "set-mode", team: SM_TEAM, mode: "agent-team" }, execFor(smOk.senderAgent));
const smOkDecisions = await smDecisionsText();
check("B/U2 落笔: 确认框答「切换」后 settings 的 teams 行写入 mode=agent-team 与 Lead（**省略 leadSessionId ⇒ 默认取调用方自己的会话 id**）",
	smOk.row().mode === "agent-team" && smOk.row().leadSessionId === "session-self" && smOkOut.includes("已切换形态：团队 " + SM_TEAM + " —— sessions → agent-team（Lead=session-self）"));
check("B/U2 形态史恰好一行: decisions.md 新增**恰一行**（旧内容逐字节是它的前缀），正文逐字是「形态 → agent-team（Lead=<id>）」",
	smOkDecBefore === "" && smOkDecisions.startsWith(smOkDecBefore) && (smOkDecisions.match(/\n$/u) ?? []).length === 1
		&& smOkDecisions.slice(smOkDecBefore.length).split(/\r?\n/u).filter((line) => line !== "").length === 1
		&& /^1 \| \d{4}-\d{2}-\d{2}T[\d:.]+Z \| session-self \| 形态 → agent-team（Lead=session-self）$/u.test(smOkDecisions.slice(smOkDecBefore.length).trim()));
check("B/U2 确认框正文: 明示「省略即默认取本次调用会话」＋ 三件不迁移（信任 / 成员名册 / 任务归属）＋ 当前 teammate 行 ＋「不阻断」那句（§4.4 提示式）",
	(() => {
		const ask = smOk.uq.requests[0];
		if (ask === undefined) return false;
		const body = String(ask.questions[0].question);
		return body.includes("默认取本次调用会话自己") && body.includes("切换后不会迁移：") && body.includes("① 信任") && body.includes("② 成员名册") && body.includes("③ 任务归属")
			&& body.includes("当前 teammate（若可读）：lead（Lead，running）") && body.includes("请确认它们的结论已落到黑板或文件 —— 本提示不阻断切换。")
			&& ask.questions[0].options.map((option) => option.label).join(",") === "切换,取消";
	})());
check("B/U2 返回体: 附新档的能力矩阵与那句结论（人不必再去读一次设计档）",
	smOkOut.includes("能力矩阵（新档 agent-team") && smOkOut.includes("| 跨会话投递（team_link_send） | ✅ 主用途 | ❌ 成员是子代理，不是可投递目标 |") && smOkOut.includes(MD_CONCLUSION));

// --- U3: 无确认服务 ⇒ fail-closed（零写入）------------------------------------
const smNoUq = modeSetEnv({ omitUserQuestions: true });
const smNoUqBefore = JSON.stringify(smNoUq.ns.data.teams);
const smNoUqDecBefore = await smDecisionsText();
const smNoUqOut = await rosterCall(smNoUq, { action: "set-mode", team: SM_TEAM, mode: "agent-team" }, execFor(smNoUq.senderAgent));
check("B/U3 无确认服务 ⇒ fail-closed 且**零写入**（settings 逐字节不变 + decisions.md 零新增 + 零弹框）",
	smNoUqOut.includes("确认服务（userQuestions）不可用") && smNoUqOut.includes("fail-closed") && smNoUqOut.includes("本次零写入")
		&& JSON.stringify(smNoUq.ns.data.teams) === smNoUqBefore && smNoUq.row().mode === undefined && (await smDecisionsText()) === smNoUqDecBefore);

// --- U4: 取消 / 超时 ⇒ 零写入 -------------------------------------------------
const smCancel = modeSetEnv({ askScript: ["取消"] });
const smCancelBefore = JSON.stringify(smCancel.ns.data.teams);
const smCancelDecBefore = await smDecisionsText();
const smCancelOut = await rosterCall(smCancel, { action: "set-mode", team: SM_TEAM, mode: "agent-team" }, execFor(smCancel.senderAgent));
check("B/U4 取消: 确认框答「取消」⇒ 拒绝且**零写入**（settings / decisions 都不动，形态仍是 sessions）",
	smCancelOut.includes("切换未执行") && smCancelOut.includes("取消") && smCancelOut.includes("本次零写入") && JSON.stringify(smCancel.ns.data.teams) === smCancelBefore && smCancel.row().mode === undefined && (await smDecisionsText()) === smCancelDecBefore);

const smTimeout = modeSetEnv({ askScript: [] });
smTimeout.uq.script.push((request) => new Promise((_resolve, reject) => {
	request.signal.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORTED" })));
}));
const smTimeoutBefore = JSON.stringify(smTimeout.ns.data.teams);
const smTimeoutDecBefore = await smDecisionsText();
const realSetTimeoutSm = globalThis.setTimeout;
let smTimeoutOut;
globalThis.setTimeout = (fn, ms, ...rest) => {
	if (!(typeof ms === "number" && ms >= 60000)) return realSetTimeoutSm(fn, ms, ...rest);
	const timer = realSetTimeoutSm(fn, 0, ...rest);
	timer.unref = () => timer;
	return timer;
};
try {
	smTimeoutOut = await rosterCall(smTimeout, { action: "set-mode", team: SM_TEAM, mode: "agent-team" }, execFor(smTimeout.senderAgent));
} finally {
	globalThis.setTimeout = realSetTimeoutSm;
}
check("B/U4 超时: 确认框 3 分钟未获应答（计时器到点）⇒ 拒绝且**零写入**，并如实说明是超时",
	smTimeoutOut.includes("切换未执行") && smTimeoutOut.includes("分钟内未获应答（超时；无人在场）") && smTimeoutOut.includes("本次零写入")
		&& JSON.stringify(smTimeout.ns.data.teams) === smTimeoutBefore && smTimeout.row().mode === undefined && (await smDecisionsText()) === smTimeoutDecBefore);

// --- U5: writer gate（双重门的第一道，原样不动）-------------------------------
const smForeign = modeSetEnv();
const smForeignBefore = JSON.stringify(smForeign.ns.data.teams);
const smForeignDecBefore = await smDecisionsText();
const smForeignOut = await rosterCall(smForeign, { action: "set-mode", team: SM_TEAM, mode: "agent-team" }, execFor(smForeign.targetAgent));
check("B/U5 writer gate: 非现任协调者调用 ⇒ 沿用既有拒绝文案（同一个门），且**零写入**、零弹框",
	smForeignOut.includes("只有现任协调者会话 session-self 可写") && JSON.stringify(smForeign.ns.data.teams) === smForeignBefore && smForeign.uq.requests.length === 0 && (await smDecisionsText()) === smForeignDecBefore);
const smVacant = modeSetEnv({ current: null });
const smVacantOut = await rosterCall(smVacant, { action: "set-mode", team: SM_TEAM, mode: "agent-team" }, execFor(smVacant.senderAgent));
check("B/U5 writer gate: 现任空缺 ⇒ 会话路径一律拒绝（设置 UI 仍是兜底），且零写入",
	smVacantOut.includes("当前空缺") && smVacantOut.includes("设置 UI") && smVacant.row().mode === undefined && smVacant.uq.requests.length === 0);

// --- U6（D8 放宽后）: 幂等 = 同档同 Lead **且账上已有这一档的形态史行** ------------
// 判据由「同档同 Lead」放宽成「同档同 Lead ＋ 账上那一行在不在」：账上**在** ⇒ 零写幂等；
// 账上**缺** ⇒ 补记一行再返回（否则 US6「每次切换留一行」会被幂等分支永久破坏，
// 而 decisions 写失败时给出的指路「重发本次切换以补记」也就不可执行 —— 那正是 D8）。
const smIdem = modeSetEnv({ mode: "agent-team", lead: "session-self" });
const smIdemBefore = JSON.stringify(smIdem.ns.data.teams);
const smIdemDecBefore = await smDecisionsText();
const smIdemOut = await rosterCall(smIdem, { action: "set-mode", team: SM_TEAM, mode: "agent-team" }, execFor(smIdem.senderAgent));
check("B/U6 幂等（agent-team，账上已有该行）: 同档同 Lead 且 decisions.md 里已有这一档的行（U2 那次真切换写的）⇒ 返回「已是该档」，**不弹框**（确认服务零请求）、**零写入**（settings 与 decisions 都逐字节不变）",
	smIdemDecBefore.includes("形态 → agent-team（Lead=session-self）") && smIdemOut.includes("已是该档") && smIdem.uq.requests.length === 0 && JSON.stringify(smIdem.ns.data.teams) === smIdemBefore && (await smDecisionsText()) === smIdemDecBefore);
const smIdemSessions = modeSetEnv();
const smIdemSessionsBefore = JSON.stringify(smIdemSessions.ns.data.teams);
const smIdemSessionsDecBefore = await smDecisionsText();
const smIdemSessionsOut = await rosterCall(smIdemSessions, { action: "set-mode", team: SM_TEAM, mode: "sessions" }, execFor(smIdemSessions.senderAgent));
const smIdemSessionsDecAfter = await smDecisionsText();
check("B/U6 幂等（sessions，账上缺该行 ⇒ 补记）: 本来就是多会话档、settings 一个字没写、也不弹框；账上没有「形态 → sessions」这一行 ⇒ 按 D8 **补记恰好一行**，且返回体如实说明这是补记",
	smIdemSessionsDecBefore.includes("形态 → agent-team（Lead=session-self）") && !smIdemSessionsDecBefore.includes("形态 → sessions")
		&& smIdemSessionsOut.includes("已是该档") && smIdemSessionsOut.includes("形态史补记") && smIdemSessions.uq.requests.length === 0
		&& JSON.stringify(smIdemSessions.ns.data.teams) === smIdemSessionsBefore
		&& smIdemSessionsDecAfter.startsWith(smIdemSessionsDecBefore) && smIdemSessionsDecAfter.slice(smIdemSessionsDecBefore.length).split(/\r?\n/u).filter((line) => line !== "").length === 1
		&& / 形态 → sessions$/u.test(smIdemSessionsDecAfter.trim()));
const smIdemAgain = await rosterCall(smIdemSessions, { action: "set-mode", team: SM_TEAM, mode: "sessions" }, execFor(smIdemSessions.senderAgent));
check("B/U6 幂等（补记之后）: 账上已有这一行 ⇒ 再发一次仍为零写幂等（decisions 逐字节不变、settings 不变、不弹框）——「已有该行」才是零写的那一支",
	smIdemAgain.includes("已是该档") && smIdemAgain.includes("已有") && smIdemSessions.uq.requests.length === 0
		&& JSON.stringify(smIdemSessions.ns.data.teams) === smIdemSessionsBefore && (await smDecisionsText()) === smIdemSessionsDecAfter);

// --- U7: 参数边界（闭集 / 显式空串 / 形状 / 在场 / 误用）------------------------
const smBadMode = modeSetEnv();
const smBadModeBefore = JSON.stringify(smBadMode.ns.data.teams);
const smBadModeOut = await rosterCall(smBadMode, { action: "set-mode", team: SM_TEAM, mode: "agentTeam" }, execFor(smBadMode.senderAgent));
check("B/U7 闭集: mode 非法 ⇒ 拒绝并**列出两个值**（拒绝对话框都不弹），零写入",
	smBadModeOut.includes("切换失败") && smBadModeOut.includes("闭集") && smBadModeOut.includes("sessions / agent-team") && smBadModeOut.includes("agentTeam") && smBadMode.uq.requests.length === 0 && JSON.stringify(smBadMode.ns.data.teams) === smBadModeBefore);
const smEmptyLead = modeSetEnv();
const smEmptyLeadOut = await rosterCall(smEmptyLead, { action: "set-mode", team: SM_TEAM, mode: "agent-team", leadSessionId: "" }, execFor(smEmptyLead.senderAgent));
check("B/U7 显式空串: leadSessionId: \"\" ⇒ 拒绝（agent-team 档没有 Lead 就没有意义），零写入、零弹框",
	smEmptyLeadOut.includes("切换失败") && smEmptyLeadOut.includes("显式空串") && smEmptyLead.uq.requests.length === 0 && smEmptyLead.row().mode === undefined);
const smShapeLead = modeSetEnv();
const smShapeLeadOut = await rosterCall(smShapeLead, { action: "set-mode", team: SM_TEAM, mode: "agent-team", leadSessionId: "-bad id!" }, execFor(smShapeLead.senderAgent));
check("B/U7 形状: leadSessionId 不符合 ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ⇒ 拒绝并回显收到的值，零写入、零弹框",
	smShapeLeadOut.includes("切换失败") && smShapeLeadOut.includes("形状非法") && smShapeLeadOut.includes("-bad id!") && smShapeLead.uq.requests.length === 0 && smShapeLead.row().mode === undefined);
const smGoneLead = modeSetEnv();
const smGoneLeadOut = await rosterCall(smGoneLead, { action: "set-mode", team: SM_TEAM, mode: "agent-team", leadSessionId: "session-typo-1" }, execFor(smGoneLead.senderAgent));
check("B/U7 在场校验: leadSessionId 形状合法但**不在本次会话列表快照**里 ⇒ 拒绝并指路先复制正确的 id（防转录错位），零写入",
	smGoneLeadOut.includes("切换失败") && smGoneLeadOut.includes("session-typo-1") && smGoneLeadOut.includes("team_link_list_sessions") && smGoneLeadOut.includes("转录错位") && smGoneLead.uq.requests.length === 0 && smGoneLead.row().mode === undefined);
const smMisuse = modeSetEnv();
const smMisuseOut = await rosterCall(smMisuse, { action: "set-mode", team: SM_TEAM, mode: "sessions", leadSessionId: SM_OTHER }, execFor(smMisuse.senderAgent));
check("B/U7 参数误用: mode=sessions 同时给 leadSessionId ⇒ 拒绝（多会话档没有 Lead 这个角色，参数不许静默生效），零写入",
	smMisuseOut.includes("切换失败") && smMisuseOut.includes("只对 agent-team 档生效") && smMisuse.uq.requests.length === 0 && smMisuse.row().mode === undefined);

// --- U10: 信任一行不动 --------------------------------------------------------
check("B/U10 信任不动: 切档前后 pairs / trustedSenders / rememberTargets **逐字节不变**（红线 3：信任不自动迁移）",
	smOk.trust() === smTrustBefore && (smOk.ns.data.pairs ?? []).length === 1 && smOk.ns.data.trustedSenders.length === 1 && smOk.ns.data.rememberTargets.length === 1);

// --- U11b: 写路径探测（宿主不可用 ⇒ 刺眼拒绝；切回来不探测）--------------------
// `agentTeams: null` = **不提供**宿主投影（参数默认值只在 undefined 时生效，所以这里必须显式传 null）。
const smNoHost = modeSetEnv({ agentTeams: null });
const smNoHostBefore = JSON.stringify(smNoHost.ns.data.teams);
const smNoHostDecBefore = await smDecisionsText();
const smNoHostOut = await rosterCall(smNoHost, { action: "set-mode", team: SM_TEAM, mode: "agent-team" }, execFor(smNoHost.senderAgent));
check("B/U11b 写路径刺眼报错: 宿主 Agent Teams 不可用 ⇒ 切**到** agent-team 被拒绝 + **指路怎么开** + 零写入 + 零弹框（绝不把 agent-team 请求当多会话执行）",
	smNoHostOut.includes("切换被拒绝") && smNoHostOut.includes("agentTeams") && smNoHostOut.includes("@deepseek-ai/dsh-experimental-agent-team-profile") && smNoHostOut.includes("dsh.profile.bundles") && smNoHostOut.includes("零写入")
		&& JSON.stringify(smNoHost.ns.data.teams) === smNoHostBefore && smNoHost.uq.requests.length === 0 && (await smDecisionsText()) === smNoHostDecBefore);
const smBack = modeSetEnv({ mode: "agent-team", lead: "session-self", askScript: ["切换"] });
const smBackOut = await rosterCall(smBack, { action: "set-mode", team: SM_TEAM, mode: "sessions" }, execFor(smBack.senderAgent));
check("B/U11b 切回不探测: 切**回** sessions **不探测**宿主（回默认档永远可用）⇒ 照常成功、Lead 指针清空、decisions 记一行",
	smBackOut.includes("已切换形态：团队 " + SM_TEAM + " —— agent-team → sessions") && smBack.row().mode === "sessions" && smBack.row().leadSessionId === "" && /形态 → sessions$/mu.test((await smDecisionsText()).trim()));

// --- 宣传面=实现面: 第五个动词进了工具面 --------------------------------------
const smTool = mdEnv.tool("team_link_roster");
check("B/宣传面=实现面: roster 的 action 闭集与描述都写上了第五个动词 set-mode，且参数面给出 mode / leadSessionId",
	smTool.parameters.properties.action.enum.join(",") === "get,upsert-team,set-role,retire,set-mode" && smTool.description.includes("set-mode") && smTool.parameters.properties.mode !== undefined && smTool.parameters.properties.leadSessionId !== undefined);



// ===========================================================================
// B 批（形态批）· 阶段 3：状态卡形态段（U13）· 不悄悄降级（U8）· 只读宿主（U9）·
// 形态诊断行（U14）· 既有动词与 rotate/recover 零回归（U12）
// 设计档 §4.3 / §5 红线 1–2 / §5 红线 6，判据 U8 / U9 / U12 / U13 / U14。
// ===========================================================================

/** 某个工作区/团队自己的 decisions.md（新夹具各自一份，免得拿别人的账当自己的空档）。 */
const decTextOf = async (ws, team) => {
	try { return await readFile(path.join(ws, "team", team, "decisions.md"), "utf8"); } catch { return ""; }
};

// --- U8: 不悄悄降级（宿主不可用 ⇒ 刺眼报错 + 指路；且没有任何多会话路径被执行）---
check("B/U8 不悄悄降级: 拒绝文案点名缺的是宿主 Agent Teams 能力、给出开启路径，且**没有任何多会话路径被执行**——零投递、零建会话、零弹框、形态仍是 sessions（红线 2：绝不把 agent-team 请求当多会话执行）",
	smNoHostOut.includes("切换被拒绝") && smNoHostOut.includes("Agent Teams") && smNoHostOut.includes("dsh.profile.bundles")
		&& !smNoHostOut.includes("已切换形态")
		&& smNoHost.senderCalls.injected.length === 0 && smNoHost.senderCalls.steered.length === 0 && smNoHost.senderCalls.followedup.length === 0
		&& smNoHost.creates.length === 0 && smNoHost.uq.requests.length === 0 && smNoHost.ns.data.teams[0].mode === undefined);

// --- U9: 只读宿主（set-mode 全流程对宿主零写调用）-----------------------------
check("B/U9 只读宿主（成功路径）: 整条切档路径对宿主**零写调用**（替身里每个写方法一被调用就抛错并记账），只碰了投影的两个**读**面",
	smOk.agentTeams.calls.writes.length === 0 && smOk.agentTeams.calls.tryMembership >= 1 && smOk.agentTeams.calls.listMembers >= 1);
check("B/U9 只读宿主（拒绝路径）: 被 writer gate 拒绝的那次同样零写调用（门在探测与弹框之前就拦下了）",
	smForeign.agentTeams.calls.writes.length === 0 && smForeign.agentTeams.calls.listMembers === 0 && smForeign.agentTeams.calls.tryMembership === 0
		&& smVacant.agentTeams.calls.writes.length === 0);

// --- U13: 状态卡显示形态段 ----------------------------------------------------
const st3Ws = path.join(MD_TMP, "st3-ws");
const st3Lead = "session-st3-lead";
const st3AgentTeams = makeAgentTeams();
const st3Env = teamEnv({
	teams: [{ ...teamRow({ name: "st3-team", workspace: st3Ws }), mode: "agent-team", leadSessionId: st3Lead }],
	selfCwd: st3Ws,
	sessions: [{ header: { id: st3Lead, createdAt: 1000, cwd: st3Ws }, live: true, persisted: true }],
	extraAgents: [{ id: st3Lead, status: "running" }],
});
st3Env.ctx.provide("agentTeams", st3AgentTeams.service);
const st3SettingsBefore = JSON.stringify(st3Env.ns.data);
const st3Out = await statusCall(st3Env, { team: "st3-team" });
check("B/U13 状态卡形态段: 状态卡追加第 ⑦ 段「形态」——形态 + Lead + 名册投影（文案一）+ **完整能力矩阵** + 结论，而 A 批的六段一字未少",
	st3Out.includes("--- 形态（⑦") && st3Out.includes("- st3-team：形态=agent-team · Lead=" + st3Lead)
		&& st3Out.includes("来源：宿主 agentTeams 投影（本部署可读）") && st3Out.includes("| 能力 | 多会话档 | agent-team 档 |") && st3Out.includes(MD_CONCLUSION)
		&& ["团队与角色", "换届 pending", "看门狗", "会话面", "活性（有界", "台账尾"].every((needle) => st3Out.includes(needle)));
check("B/U13 状态卡只读: 形态段与 A 批六段一样**零写入**（调用前后 settings 逐字节不变，形态未被自动改写）",
	JSON.stringify(st3Env.ns.data) === st3SettingsBefore && st3Env.ns.data.teams[0].mode === "agent-team" && st3AgentTeams.calls.writes.length === 0);

// --- U14: 形态诊断行（只提示，绝不自动切）--------------------------------------
const st3SoleWs = path.join(MD_TMP, "st3-sole-ws");
const st3Sole = teamEnv({ teams: [teamRow({ name: "sole-team", workspace: st3SoleWs })], selfCwd: st3SoleWs, sessions: [], extraAgents: [] });
const st3SoleSettingsBefore = JSON.stringify(st3Sole.ns.data);
const st3SoleOut = await rosterCall(st3Sole, { action: "get" }, execFor(st3Sole.senderAgent));
const st3SoleStatus = await statusCall(st3Sole, { team: "sole-team" });
check("B/U14 诊断行（出现）: 除自己外没有其他可达会话 ⇒ 读面（roster get 与状态卡）各附一行，文案点名 set-mode 这条路，并写明**只提示**",
	st3SoleOut.includes("⚠ 多会话通道看起来不可用（列表里没有其他会话）—— 你可以让协调者切到 agent-team 档（team_link_roster action=set-mode）")
		&& st3SoleOut.includes("只提示：本插件绝不自动切档") && st3SoleStatus.includes("team_link_roster action=set-mode）") && st3SoleStatus.includes("只提示"));
const smGet = await rosterCall(smOk, { action: "get" }, execFor(smOk.senderAgent));
check("B/U14 诊断行（不出现）: 列表里有别的会话 ⇒ 一行都不打（同一个渲染器，判据只有一条）",
	mdGet.includes("多会话通道看起来不可用") === false && smGet.includes("多会话通道看起来不可用") === false);
check("B/U14 只提示、绝不自动切: 出诊断行的那两次读**零写入**——settings 逐字节不变、形态一个字没改、decisions 零新增（红线 6）",
	JSON.stringify(st3Sole.ns.data) === st3SoleSettingsBefore && st3Sole.ns.data.teams[0].mode === undefined && (await decTextOf(st3SoleWs, "sole-team")) === "" && st3Sole.ns.data.teams[0].leadSessionId === undefined);

// --- U12: 既有四动词与 rotate / recover 零回归 --------------------------------
const rgEnv = modeSetEnv();
const rgBefore = JSON.stringify(rgEnv.ns.data.teams);
const rgUpsert = await rosterCall(rgEnv, { action: "upsert-team", team: SM_TEAM }, execFor(rgEnv.senderAgent));
const rgSetRole = await rosterCall(rgEnv, { action: "set-role", team: SM_TEAM, role: "reviewer", session: SM_OTHER, note: "评审岗" }, execFor(rgEnv.senderAgent));
const rgRetire = await rosterCall(rgEnv, { action: "retire", team: SM_TEAM, role: "reviewer" }, execFor(rgEnv.senderAgent));
check("B/U12 零回归（既有四动词）: upsert-team / set-role / retire 的语义与文案一字未改——同一个 action 闭集里只多了第五个动词",
	rgBefore !== "" && rgUpsert.includes("已存在") && rgUpsert.includes("幂等") && rgSetRole.includes("已设置") && rgSetRole.includes("未迁移 pairs") && rgRetire.includes("已退役") && rgEnv.row().roles.some((entry) => entry.role === "reviewer" && entry.current === null));
// D7③ 如实标注：这两条 arity 断言（@writerGate.length === 2@ 等）是**函数元数变更探测器**，
// 不是**行为锁** —— 有人给这三个门加/减一个形参时会红，而它红的理由与门的行为对不对无关。
// 保留它（形参面漂移同样值得一次人工确认），但这里不再把它读成「门没被改过」的证据；
// 真正钉住门的是上面那几条行为断言与动词闭集锁。
check("B/U12 零回归（rotate / recover）: 两个工具的动词闭集锁定，三道门函数的**形参个数**同上（元数探测器，见上三行的标注——它不是行为锁）",
	__testing.writerGate.length === 2 && __testing.retireGate.length === 2 && __testing.rotateGate.length === 3
		&& rgEnv.tool("team_link_rotate").parameters.properties.action.enum.join(",") === "prepare,claim"
		&& rgEnv.tool("team_link_recover").parameters.properties.action.enum.join(",") === "revive,reappoint");
check("B/U12 只动两个键: 切档只改 mode / leadSessionId —— 团队行的键集恰是规范形状（多出来的正是那两个），roles / policy / workspace / createdAt 逐字节不变",
	Object.keys(smOk.ns.data.teams[0]).sort().join(",") === "createdAt,leadSessionId,mode,name,policy,roles,rotationBackup,workspace"
		&& JSON.stringify(smOk.ns.data.teams[0].policy) === JSON.stringify({ writer: "coordinator" })
		&& smOk.ns.data.teams[0].roles.length === 1 && smOk.ns.data.teams[0].roles[0].current === "session-self");

// ===========================================================================
// 分歧审计修复轮 `DIVERGENCE(8)`（2026-09-27）· 代码与断言面：D1 / D2 / D3 / D5 / D6 / D8
// 设计口径：B 档 §4.2（幂等放宽为「同档同 Lead ＋ 账上有该行」）/ §4.3(3)（首行按分支准确化）/
// §3.3.1（镜像与设置变更同一事务）/ §4.4（确认框的两档 teammate 行）；父档 §2.3 第 7 行改**已核**口径。
// ===========================================================================

// --- D1: 拒绝文案通用化 ＋ 补设置 UI 兜底路 -----------------------------------
// 旧文案断言「本部署的 profile 未启用该组合包」—— 而真机 desktop profile **已经装载**它，真机走到的是
// 「服务在场但调用方不是成员」那一支。所以「怎么开」只对**确实缺席**的 profile 有意义，必须写成通用
// 表述；同时补一条永远可用的兜底路（设置 UI 是超级写者）—— 防假阴性把用户卡死。
check("D1 拒绝文案通用化: 「怎么开」不再断言「本部署没装载」，改成按**当前活动 profile** 的 dsh.profile.bundles 自查（该组合包确实缺席时才适用），并明说「已经在那里 ⇒ 拦住本次切换的是别的原因」",
	smNoHostOut.includes("当前活动的 profile") && smNoHostOut.includes("dsh.profile.bundles")
		&& smNoHostOut.includes("@deepseek-ai/dsh-experimental-agent-team-profile")
		&& smNoHostOut.includes("本部署") === false && smNoHostOut.includes("本部署未装载") === false);
check("D1 设置 UI 兜底路: 拒绝文案补上「用户经设置 UI 直接改 team-link.teams[].mode / leadSessionId」这条永远可用的路",
	smNoHostOut.includes("兜底路（永远可用）") && smNoHostOut.includes("用户经设置 UI 永远是超级写者")
		&& smNoHostOut.includes("team-link.teams[].mode") && smNoHostOut.includes("leadSessionId"));

// --- D2: 名册投影不可读的分支（服务在场）＋ D5: 确认框的不可读档 ---------------
/** D2/D5 夹具：同一个团队行（agent-team + Lead），只换宿主替身。 */
const mdProbeEnv = (agentTeams, askScript = []) => {
	const built = teamEnv({
		teams: [mdHostRow],
		askScript,
		sessions: [{ header: { id: MD_LEAD, createdAt: 1000, cwd: MD_WS }, live: true, persisted: true }],
		extraAgents: [{ id: MD_LEAD, status: "running" }],
		selfCwd: MD_WS,
	});
	built.ctx.provide("agentTeams", agentTeams.service);
	return built;
};
// 分支①「调用方非成员」：服务在、凭据不认（tryMembership 返回 undefined ⇒ 根本走不到 listMembers）。
// 这一支此前**零断言**，而它正是真机最可能走到的那一支。
const mdNonMember = makeAgentTeams({ isMember: false });
const mdNonMemberEnv = mdProbeEnv(mdNonMember);
const mdNonMemberOut = await rosterCall(mdNonMemberEnv, { action: "get" }, execFor(mdNonMemberEnv.senderAgent));
check("D2 分支①「调用方非成员」: 首行是**中性**的「成员名册不可读」，不再谎称「本部署未提供该投影」（首行与原因行不许自相矛盾）；紧随的原因行点名调用方不在宿主团队里，形态 + Lead + 能力矩阵照旧",
	mdNonMemberOut.includes("成员名册不可读") && mdNonMemberOut.includes("本部署未提供该投影") === false
		&& mdNonMemberOut.includes("（不可读原因：") && mdNonMemberOut.includes("不是宿主团队的成员")
		&& mdNonMember.calls.listMembers === 0
		&& mdNonMemberOut.includes("- host-team：形态=agent-team · Lead=" + MD_LEAD) && mdNonMemberOut.includes("| 能力 | 多会话档 | agent-team 档 |"));
// 分支②「读取抛错」：两个读方法都在、凭据也认，但 listMembers 自己抛错。此前同样**零断言**。
const mdThrow = makeAgentTeams({ listThrows: true });
const mdThrowEnv = mdProbeEnv(mdThrow);
const mdThrowOut = await rosterCall(mdThrowEnv, { action: "get" }, execFor(mdThrowEnv.senderAgent));
check("D2 分支②「读取抛错」: 同样用中性首行 ＋ 原因行（原因里带宿主抛出的错），形态 + Lead + 能力矩阵照给 —— 读路径如实降级，不是拒绝",
	mdThrowOut.includes("成员名册不可读") && mdThrowOut.includes("本部署未提供该投影") === false
		&& mdThrowOut.includes("（不可读原因：") && mdThrowOut.includes("宿主 agentTeams 投影读取失败")
		&& mdThrow.calls.listMembers === 1 && mdThrowOut.includes("| 能力 | 多会话档 | agent-team 档 |"));
check("D2 首行按分支准确化（反向锁）: 只有**服务缺席**那一支才说「本部署未提供该投影」，且原因行点名是服务缺席（两行互相印证：不再无条件先打那一句）。**收尾修复轮 R1 同批改写**：原因行的措辞随 `probeAgentTeams` 一起软化（旧文案「宿主没有提供 agentTeams 服务（本次运行的 profile 没有装载…）」把服务缺席断言成 profile 没装载），本锁改为咬新措辞",
	mdNoHostGet.includes("成员名册不可读（本部署未提供该投影）—— 仍可读 Lead 与形态") && mdNoHostGet.includes("（不可读原因：服务 agentTeams 当前不可见")
		&& mdNoHostGet.includes("也可能尚未激活完成") && mdNoHostGet.includes("（不可读原因："));
// D5（§4.4 的第二档）：确认框正文里「当前 teammate」那一行的**不可读**档。
const d5Env = mdProbeEnv(makeAgentTeams({ isMember: false }), ["切换"]);
const d5Out = await rosterCall(d5Env, { action: "set-mode", team: "host-team", mode: "agent-team" }, execFor(d5Env.senderAgent));
check("D5 确认框正文（名册不可读档）: 「当前 teammate（若可读）：（成员名册不可读）」如实说出不可读，而「不会迁移的三件事」与「本提示不阻断切换」两句照旧 —— §4.4 的两档此前只断言了可读档",
	(() => {
		const ask = d5Env.uq.requests[0];
		if (ask === undefined) return false;
		const body = String(ask.questions[0].question);
		return body.includes("当前 teammate（若可读）：（成员名册不可读）") && body.includes("切换后不会迁移：")
			&& body.includes("① 信任") && body.includes("② 成员名册") && body.includes("③ 任务归属")
			&& body.includes("请确认它们的结论已落到黑板或文件 —— 本提示不阻断切换。");
	})());
check("D5 两档对照: 名册**可读**时同一句照旧逐个列成员（U2 那次确认框），不可读时写「（成员名册不可读）」—— 同一处代码的两个分支，不是两套口径；两次切换都照常落笔",
	String(smOk.uq.requests[0]?.questions[0]?.question ?? "").includes("当前 teammate（若可读）：lead（Lead，running）")
		&& d5Out.includes("已切换形态") && d5Env.ns.data.teams.find((entry) => entry.name === "host-team").mode === "agent-team");

// --- D3: roster.md 镜像补 mode / Lead 两行，set-mode 落笔后重写镜像 -----------
const mrWs = path.join(MD_TMP, "mirror-ws");
const mrEnv = modeSetEnv({ askScript: ["切换"], workspace: mrWs });
const mrOut = await rosterCall(mrEnv, { action: "set-mode", team: SM_TEAM, mode: "agent-team" }, execFor(mrEnv.senderAgent));
const mrMirrorPath = path.join(mrWs, "team", SM_TEAM, "roster.md");
const mrMirror = await readOrMissing(mrMirrorPath);
check("D3 镜像补两行: set-mode 也是一次**设置变更** ⇒ 落笔后与既有调用点同形地重写 roster.md 镜像（返回体带「镜像已更新」），镜像里出现「形态（mode）」与「Lead 会话（leadSessionId）」两行（值 = 本次落笔的值）",
	mrOut.includes("已切换形态") && mrOut.includes("镜像已更新：" + mrMirrorPath)
		&& mrMirror.includes("- 形态（mode）：agent-team") && mrMirror.includes("- Lead 会话（leadSessionId）：session-self")
		&& mrMirror.includes("- policy.writer：coordinator"));
const mrBackEnv = modeSetEnv({ askScript: ["切换"], workspace: mrWs, mode: "agent-team", lead: "session-self" });
const mrBackOut = await rosterCall(mrBackEnv, { action: "set-mode", team: SM_TEAM, mode: "sessions" }, execFor(mrBackEnv.senderAgent));
const mrMirrorBack = await readOrMissing(mrMirrorPath);
check("D3 镜像跟着事实走: 切回 sessions 的同一次调用又重写一遍镜像 ——「形态（mode）：sessions」＋ Lead 行如实写成**空**（多会话档没有 Lead 角色），镜像不比事实活得久",
	mrBackOut.includes("已切换形态") && mrMirrorBack.includes("- 形态（mode）：sessions")
		&& mrMirrorBack.includes("- Lead 会话（leadSessionId）：（空；"));
const mrBlockedEnv = modeSetEnv({ askScript: ["切换"], workspace: blockedRoot });
const mrBlockedOut = await rosterCall(mrBlockedEnv, { action: "set-mode", team: SM_TEAM, mode: "agent-team" }, execFor(mrBlockedEnv.senderAgent));
check("D3 镜像仍 best-effort: 镜像写不动（workspace 指向一个**文件**）时 set-mode 照旧**落笔成功**（settings 落笔 ＋ 一句「镜像写入失败」告警 ＋ 形态史的失败如实标注），语义与既有调用点一字不差 —— 镜像坏掉绝不把整次切换变成失败",
	mrBlockedOut.includes("已切换形态") && mrBlockedOut.includes("镜像写入失败") && mrBlockedOut.includes("settings 是本插件的事实源")
		&& mrBlockedOut.includes("形态史未写") && mrBlockedEnv.row().mode === "agent-team");

// --- D6: 「只改这两个键」的准确口径（整份数组回写）----------------------------
const mtWs = path.join(MD_TMP, "multi-ws");
const mtFilled = { ...teamRow({ name: "other-filled", workspace: mtWs, current: "session-other" }), mode: "agent-team", leadSessionId: "session-other-lead" };
const mtBare = teamRow({ name: "other-bare", workspace: mtWs, current: "session-other" });
const mtEnv = teamEnv({
	teams: [teamRow({ name: SM_TEAM, workspace: mtWs }), mtFilled, mtBare],
	askScript: ["切换"],
	selfCwd: mtWs,
	sessions: [{ header: { id: SM_OTHER, createdAt: 1000, cwd: mtWs }, live: true, persisted: true }],
	extraAgents: [{ id: SM_OTHER, status: "idle" }],
});
// 宿主探测要过（否则整次切换在探测那一关就被拒，测不到「整份数组回写」这一条）。
mtEnv.ctx.provide("agentTeams", makeAgentTeams().service);
const mtOut = await rosterCall(mtEnv, { action: "set-mode", team: SM_TEAM, mode: "agent-team" }, execFor(mtEnv.senderAgent));
const mtFilledAfter = mtEnv.ns.data.teams[1];
const mtBareAfter = mtEnv.ns.data.teams[2];
check("D6 多团队夹具（准确口径）: 切档只改**本团队行**的 mode / leadSessionId；其余团队行因整份数组回写被**补默认值**（夹具里缺这两个键 ⇒ sessions / 空串），而**已有值一个字不被覆盖**（与既有 upsert-team 同形，语义无变化）",
	mtBare.mode === undefined && mtBare.leadSessionId === undefined
		&& mtOut.includes("已切换形态") && mtEnv.ns.data.teams[0].mode === "agent-team" && mtEnv.ns.data.teams[0].leadSessionId === "session-self"
		&& mtFilledAfter.mode === "agent-team" && mtFilledAfter.leadSessionId === "session-other-lead"
		&& mtBareAfter.mode === "sessions" && mtBareAfter.leadSessionId === ""
		&& mtFilledAfter.roles[0].current === "session-other" && mtBareAfter.roles[0].current === "session-other");

// --- D8: 可执行的补记路径（decisions 写失败 ⇒ 按指路重发 ⇒ 账上确实出现该行）----
const nbWs = path.join(MD_TMP, "noboard-ws");
const nbEnv = modeSetEnv({ askScript: ["切换"], workspace: "" });
const nbOut1 = await rosterCall(nbEnv, { action: "set-mode", team: SM_TEAM, mode: "agent-team" }, execFor(nbEnv.senderAgent));
check("D8 前置（写失败）: 团队没有 workspace ⇒ settings 落笔成功而**形态史未写**，返回体给出可执行的指路（补上路径后重发本次切换以补记）",
	nbEnv.row().mode === "agent-team" && nbEnv.row().leadSessionId === "session-self" && nbOut1.includes("已切换形态")
		&& nbOut1.includes("形态史未写") && nbOut1.includes("重发本次切换以补记"));
// 用户经设置 UI 补上 workspace（这里就是改这一个字段；设置 UI 是超级写者）。
nbEnv.ns.data.teams[0].workspace = nbWs;
const nbOut2 = await rosterCall(nbEnv, { action: "set-mode", team: SM_TEAM, mode: "agent-team" }, execFor(nbEnv.senderAgent));
const nbDec = await decTextOf(nbWs, SM_TEAM);
check("D8 指路可执行（本轮修复的核心）: 按指路重发 ⇒ 幂等分支命中但账上缺那一行 ⇒ **补记恰好一行**，账上确实出现「形态 → agent-team（Lead=session-self）」，返回体如实说明这是补记（US6「每次切换留一行」不再被幂等分支永久破坏）",
	nbOut2.includes("已是该档") && nbOut2.includes("形态史补记")
		&& nbDec.split(/\r?\n/u).filter((line) => line !== "").length === 1 && /形态 → agent-team（Lead=session-self）$/u.test(nbDec.trim()));
// fail-closed 的两条：拿不准就**不补记**，并把「为什么没写」如实说回来（猜就是造假账）。
const fbWs = path.join(MD_TMP, "readfail-ws");
await mkdir(path.join(fbWs, "team", SM_TEAM, "decisions.md"), { recursive: true });
const fbEnv = modeSetEnv({ mode: "agent-team", lead: "session-self", workspace: fbWs });
const fbOut = await rosterCall(fbEnv, { action: "set-mode", team: SM_TEAM, mode: "agent-team" }, execFor(fbEnv.senderAgent));
check("D8 fail-closed①（账读不出来）: decisions.md 读不出来（夹具：同名**目录** ⇒ EISDIR）⇒ 无法核实账上有没有这一行 ⇒ **不补记**，返回体如实说明「不补记」且**不出现成功措辞**",
	fbOut.includes("已是该档") && fbOut.includes("不补记") && fbOut.includes("无法读取")
		&& fbOut.includes("形态史补记（恰好一行）") === false);
const nbEmpty = modeSetEnv({ mode: "agent-team", lead: "session-self", workspace: "" });
const nbEmptyOut = await rosterCall(nbEmpty, { action: "set-mode", team: SM_TEAM, mode: "agent-team" }, execFor(nbEmpty.senderAgent));
check("D8 fail-closed②（没有 workspace）: 幂等分支同样**不补记**（黑板根目录未知 ⇒ 无从核实），返回体如实说明并给出「补写路径后重发」的路",
	nbEmptyOut.includes("已是该档") && nbEmptyOut.includes("不补记") && nbEmptyOut.includes("重发本次切换以补记"));

// ===========================================================================
// B 批**收尾修复轮**（2026-09-27）· 代码评审 R1–R6（R7 仅留档，本轮不动）：
// R1 诊断话术软化（D1 同类漏改的一处）· R2 同一判据只取一次 · R3 TOCTOU 后镜像与形态史同源 ·
// R4 形态史语义明示（返回体措辞与 README / B 档 §4.2 同批）· R5 无会话身份时不判、不猜。
// 设计口径：B 档 docs/team-mode-batch-design-2026-09-26.md §4.2 / §4.3(3) / §6 U6。
// ===========================================================================

// --- R1: 诊断话术不再替宿主下结论（旧文案把「服务看不见」断言成「profile 没装载」）----
check("R1 写路径拒绝文案软化: 「服务缺席」那一支只说**服务当前不可见**并列出两种可能（可能未装载该组合包 / 也可能尚未激活完成），不再断言「本次运行的 profile 没有装载」—— 拒绝本身照旧刺眼（拒绝 + 指路 + 零写入），只是**不替宿主下结论**",
	smNoHostOut.includes("切换被拒绝") && smNoHostOut.includes("服务 agentTeams 当前不可见")
		&& smNoHostOut.includes("也可能尚未激活完成") && smNoHostOut.includes("没有装载") === false
		&& smNoHostOut.includes("怎么开：") && smNoHostOut.includes("本次**零写入**"));
check("R1 写读同源（读路径的原因行）: 同一条 reason 在名册投影的「（不可读原因：…）」行里逐字相同 —— 只有一份字面量，两条路不许各写一份",
	mdNoHostGet.includes("（不可读原因：服务 agentTeams 当前不可见") && mdNoHostGet.includes("也可能尚未激活完成")
		&& mdNoHostGet.includes("没有装载") === false);

// --- R2: 同一个判据只取一次（可用性门与确认框正文的投影曾各探一次）----------------
const r2Ws = path.join(MD_TMP, "r2-ws");
const r2Probe = makeAgentTeams();
const r2Env = modeSetEnv({ askScript: ["切换"], workspace: r2Ws, agentTeams: r2Probe });
const r2Out = await rosterCall(r2Env, { action: "set-mode", team: SM_TEAM, mode: "agent-team" }, execFor(r2Env.senderAgent));
check("R2 同一判据只取一次: 切到 agent-team 的整条路径上宿主投影只被**探测一次**（tryMembership / listMembers 各恰 1 次）—— 可用性门的结果直接复用为确认框正文的投影，不再对同一判据探两次",
	r2Out.includes("已切换形态") && r2Probe.calls.tryMembership === 1 && r2Probe.calls.listMembers === 1
		&& r2Env.uq.requests.length === 1);
const r2BackWs = path.join(MD_TMP, "r2-back-ws");
const r2BackProbe = makeAgentTeams();
const r2BackEnv = modeSetEnv({ mode: "agent-team", lead: "session-self", askScript: ["切换"], workspace: r2BackWs, agentTeams: r2BackProbe });
const r2BackOut = await rosterCall(r2BackEnv, { action: "set-mode", team: SM_TEAM, mode: "sessions" }, execFor(r2BackEnv.senderAgent));
check("R2 ★ 负相（复用不改切回方向的语义；两种实现上都绿 —— 覆盖缺口类，不冒充红相）: 切**回** sessions 没有前置探测 ⇒ 现读一次投影，确认框正文的「当前 teammate」行照旧逐个列成员（复用只发生在「切到 agent-team」那一向）",
	(() => {
		const ask = r2BackEnv.uq.requests[0];
		if (ask === undefined) return false;
		return String(ask.questions[0].question).includes("当前 teammate（若可读）：lead（Lead，running）");
	})() && r2BackProbe.calls.tryMembership === 1 && r2BackOut.includes("已切换形态：团队 " + SM_TEAM + " —— agent-team → sessions"));

// --- R3: TOCTOU 复检后镜像与形态史**同源**（曾在确认框期间改 workspace 时分家）------
// 用户在确认框打开期间经设置 UI 改 workspace（设置 UI 是超级写者）：镜像用复检后的行，
// 形态史原先用**对话框前**那一行 ⇒ 镜像写新路径、账写旧路径。这里把两者钉在同一行上。
const r3OldWs = path.join(MD_TMP, "r3-old-ws");
const r3NewWs = path.join(MD_TMP, "r3-new-ws");
// 对话框脚本在 ask() 里执行（此时 r3Env 已初始化）：正是「对话框期间设置变了」那一瞬。
const r3Env = modeSetEnv({ askScript: [() => { r3Env.ns.data.teams[0].workspace = r3NewWs; return "切换"; }], workspace: r3OldWs });
const r3Out = await rosterCall(r3Env, { action: "set-mode", team: SM_TEAM, mode: "agent-team" }, execFor(r3Env.senderAgent));
const r3NewMirror = await readOrMissing(path.join(r3NewWs, "team", SM_TEAM, "roster.md"));
const r3NewDecisions = await readOrMissing(path.join(r3NewWs, "team", SM_TEAM, "decisions.md"));
const r3OldDecisions = await readOrMissing(path.join(r3OldWs, "team", SM_TEAM, "decisions.md"));
check("R3 TOCTOU 后镜像与形态史**同源**: 确认框期间 workspace 被改 ⇒ 两者都落在**复检后**的那一行：新路径下 roster.md 与 decisions.md 都在（且写着本次落笔的值），旧路径下**一个文件都没生成** —— 「镜像写新、形态史写旧」的账/镜像分家不再可能",
	r3Out.includes("已切换形态") && r3Out.includes("镜像已更新：" + path.join(r3NewWs, "team", SM_TEAM, "roster.md"))
		&& r3NewMirror.includes("- 形态（mode）：agent-team") && r3NewDecisions.includes("形态 → agent-team（Lead=session-self）")
		&& r3OldDecisions.includes("读取失败") === true && r3Env.ns.data.teams[0].workspace === r3NewWs);

// --- R4: 形态史语义（「首次声明也算一行」—— 文档与返回体措辞同批同源）--------------
check("R4 形态史语义明示（返回体）: 「已是该档」那一支如实说明形态史记的是「**声明过这一档**」、不是「档位发生变化」—— 与 README / B 档 §4.2 的新口径同源；旧措辞「形态史记的是「切换」，不是「重复声明」」在实现里**零残留**（首次声明也会补记一行）",
	smIdemOut.includes("已是该档") && smIdemOut.includes("声明过这一档") && smIdemOut.includes("档位发生变化")
		&& smIdemOut.includes("重复声明") === false);

// --- R5: 无会话身份时**不判、不猜**（旧实现退化为按 process.cwd() 过滤）-------------
const r5AnonExec = { signal: new AbortController().signal };
const r5AnonGet = await rosterCall(st3Sole, { action: "get" }, r5AnonExec);
check("R5 无会话身份（roster get）: 调用方没有会话身份 ⇒ 诊断行的判据是 **null（不判）**，与 sessionIdSnapshot 的失败语义对齐 —— 读面照出形态段，但**不打**「⚠ 多会话通道看起来不可用」（旧实现退化成按 process.cwd() 过滤，于是凭空打出基于猜测的告警）",
	r5AnonGet.includes("- sole-team：形态=sessions") && r5AnonGet.includes("--- 能力矩阵")
		&& r5AnonGet.includes("多会话通道看起来不可用") === false);
check("R5 无会话身份（状态卡 ⑦ 段）: 同一条纪律收敛到状态卡 —— 没有身份时不判（判据 = null），⑦ 段照出、身份如实标「（当前会话未知）」，但**不打**诊断行",
	stNoIdentity.includes("--- 形态（⑦") && stNoIdentity.includes("（当前会话未知）")
		&& stNoIdentity.includes("多会话通道看起来不可用") === false);
check("R5 反面对照（有身份时判据照样生效）: 同一个夹具**带**会话身份时诊断行照旧出现 —— 「不判」只针对**没有身份**那一支，不是把判据整体关掉",
	st3SoleOut.includes("多会话通道看起来不可用") && st3SoleStatus.includes("多会话通道看起来不可用"));
// ---------------------------------------------------------------------------
// 策略持久化自持化（设计档 docs/policy-persistence-design-2026-09-27.md）
// S1 文件后端：§3.2 路径解析 / §3.3 文件 schema / §3.4 原子写 / §3.1 第 2、3 档落点。
// 判据：U1（无服务时写→读回一致且文件存在）· U2（半写 .tmp 不影响读取）·
// U7（DSH_HOME 缺失退回 homedir；两者皆缺 ⇒ 内存 + 一行 warn）。
// ---------------------------------------------------------------------------

// U1 —— 无 settings 服务时的第 2 档落点：写进文件、读得回来。
const u1Env = setup({ sessions: [], selfCwd: TEAM_WS });
const u1Roster = u1Env.tool("team_link_roster");
const u1Out = await u1Roster.execute({ action: "upsert-team", team: "threat-intel" }, execFor(u1Env.senderAgent));
const u1File = path.join(u1Env.policyHome, "team-link", "policy.json");
let u1Doc = null;
try { u1Doc = JSON.parse(await readFile(u1File, "utf8")); } catch { u1Doc = null; }
check("U1 文件后端: 无 settings 服务时一次写入落在 <DSH_HOME>/team-link/policy.json（不是工作区）",
	u1Out.includes("已创建团队 threat-intel") && existsSync(u1File) && !existsSync(path.join(TEAM_WS, "team-link", "policy.json")));
check("U1 文件后端: 文件 schema 是 {schema,savedAt,foldedAt,policy}，policy 键集**镜像** settings 命名空间的八个键",
	u1Doc !== null && u1Doc.schema === 1 && typeof u1Doc.savedAt === "string" && Number.isFinite(Date.parse(u1Doc.savedAt))
		&& u1Doc.foldedAt === null && u1Doc.policy !== null
		&& Object.keys(u1Doc.policy).sort().join(",") === ["blockedSenders", "pairs", "pendingCreates", "receiveMode", "rememberTargets", "sections", "teams", "trustedSenders", "watchdogs"].sort().join(","));
check("U1 文件后端: 读回一致 —— 磁盘上的 roster 与本次 `roster get` 看到的是同一份",
	u1Doc !== null && Array.isArray(u1Doc.policy.teams) && u1Doc.policy.teams.length === 1 && u1Doc.policy.teams[0].name === "threat-intel"
		&& (await u1Roster.execute({ action: "get" }, execFor(u1Env.senderAgent))).includes("threat-intel"));
check("U1 文件后端: 落点目录在**全局** home 下（团队按名字全局寻址，不随工作区搬家）",
	existsSync(TEAM_WS) && u1File.startsWith(u1Env.policyHome + path.sep) && !u1File.startsWith(TEAM_WS + path.sep)
		&& !existsSync(path.join(TEAM_WS, "team-link")));

// U2 —— 原子写：读只认 `policy.json`，半写的 `.tmp` 不参与。
const u2Env = setup({ sessions: [], selfCwd: TEAM_WS });
const u2Dir = path.join(u2Env.policyHome, "team-link");
mkdirSync(u2Dir, { recursive: true });
const u2Stray = path.join(u2Dir, "policy.json.tmp");
writeFileSync(u2Stray, "{\"schema\":1,\"policy\":{\"teams\":[{\"name\":\"HALF-WRITTEN", "utf8");
const u2Roster = u2Env.tool("team_link_roster");
const u2Seed = await u2Roster.execute({ action: "upsert-team", team: "night-shift" }, execFor(u2Env.senderAgent));
const u2File = path.join(u2Dir, "policy.json");
let u2Doc = null;
try { u2Doc = JSON.parse(await readFile(u2File, "utf8")); } catch { u2Doc = null; }
check("U2 原子写: 半写的 policy.json.tmp 不影响读取 —— 读只认 policy.json（真值是完整的）",
	u2Seed.includes("已创建团队 night-shift") && u2Doc !== null && u2Doc.policy.teams.length === 1
		&& u2Doc.policy.teams[0].name === "night-shift"
		&& !(await u2Roster.execute({ action: "get" }, execFor(u2Env.senderAgent))).includes("HALF-WRITTEN"));
check("U2 原子写: 一次成功写入之后不留 .tmp 残骸（写完即 rename）", !existsSync(u2Stray));

// U7 —— 路径解析的三支：DSH_HOME → homedir → 内存 + warn。
const u7FromEnv = __testing.resolvePolicyFilePath({ env: { DSH_HOME: "C:/dsh-home" }, homedir: () => "C:/Users/whoever" });
const u7MissingEnv = __testing.resolvePolicyFilePath({ env: {}, homedir: () => "C:/Users/whoever" });
const u7MissingHome = __testing.resolvePolicyFilePath({ env: {}, homedir: () => "" });
check("U7 路径: DSH_HOME 在场时优先用它（homedir 不参与）",
	u7FromEnv.ok === true && u7FromEnv.file === path.join("C:/dsh-home", "team-link", "policy.json")
		&& !u7FromEnv.file.includes("whoever"));
check("U7 路径: DSH_HOME 缺失时退回 homedir/.dsh/team-link/policy.json",
	u7MissingEnv.ok === true && u7MissingEnv.file === path.join("C:/Users/whoever", ".dsh", "team-link", "policy.json"));
check("U7 路径: 两者皆缺 ⇒ 解析失败（第 3 档，进程内存 + warn），不猜任何目录",
	u7MissingHome.ok === false && u7MissingHome.reason === "路径解析失败" && typeof u7MissingHome.file === "undefined");
// 同样三支的 **store 级**读数：夹具声明「既无 DSH_HOME 也无 homedir」。
const u7NoPathEnv = setup({ sessions: [], selfCwd: TEAM_WS, policyHome: false });
const u7NoPathWarns = u7NoPathEnv.log.lines.warn;
const u7NoPathGet = await u7NoPathEnv.tool("team_link_roster").execute({ action: "get" }, execFor(u7NoPathEnv.senderAgent));
check("U7 路径: 解析失败时 warn 说出原因，且没有任何一行再宣称落点或持久化",
	u7NoPathWarns.filter((line) => line.includes("路径解析失败")).length === 1
		&& !u7NoPathWarns.some((line) => line.includes("落点：文件后端"))
		&& !u7NoPathWarns.some((line) => line.includes("no persistence meanwhile")));
check("U7 路径: 解析失败时读面照常可用（不拒绝，只是没有落点可指）", u7NoPathGet.includes("共 0 个团队"));
// ---------------------------------------------------------------------------
// 策略持久化自持化 S2 折叠与可核：§3.1 档 4 折叠 + §3.3 裁决 + §3.4 只写一处 + §3.5 三态落点行。
// 判据：U3（文件有数据 → 并入服务）· U4（两边都有 → 服务胜 + 归档 + 留痕）·
// U5（roster get / status 的首行三态）· U6（服务在场时文件一个字节都不动）。
// ---------------------------------------------------------------------------

/** A policy file document as §3.3 defines it (normalizePolicy fills the rest). */
const policyDoc = (policy, foldedAt = null) => ({ schema: 1, savedAt: "2026-09-27T00:00:00.000Z", foldedAt, policy });

// U3 —— 文件里已有状态 + 设置服务晚挂 ⇒ 折叠并入服务（§3.1 档 4 的正例）。
const u3Env = setup({ sessions: [], lateSettings: true, selfCwd: TEAM_WS, policySeed: policyDoc({ teams: [teamRow({ name: "file-team" })] }) });
const u3Before = await u3Env.tool("team_link_roster").execute({ action: "get" }, execFor(u3Env.senderAgent));
check("U3 折叠: 服务缺席时读面看到的是**文件里**那一份（不是内存默认值）", u3Before.includes("file-team"));
await u3Env.provideSettingsFiber();
await waitForChain(u3Env, 1);
const u3Ns = (u3Env.settings.namespaces.get("team-link")?.data.teams ?? []).map((team) => team.name);
const u3After = await u3Env.tool("team_link_roster").execute({ action: "get" }, execFor(u3Env.senderAgent));
const u3Doc = JSON.parse(await readFile(path.join(u3Env.policyHome, "team-link", "policy.json"), "utf8"));
check("U3 折叠: 文件里那一份在服务晚挂后并入了设置命名空间（档 4 的正例）", u3Ns.join(",") === "file-team" && u3After.includes("file-team"));
check("U3 折叠: 折叠后文件里是**合并后**的那一份，并盖上 foldedAt（下次重启读到的就是它）",
	u3Doc.policy.teams.map((team) => team.name).join(",") === "file-team" && typeof u3Doc.foldedAt === "string" && u3Doc.foldedAt !== null);
check("U3 折叠: 折叠只留一行 warn（不搞 warn 风暴，§5.3 红线）", u3Env.log.lines.warn.filter((line) => line.includes("unattached startup window")).length === 1);
check("U3 折叠: 落点已切到服务（设置服务在场时文件不再落点）", u3After.split("\n")[0] === "存储：设置服务（team-link 命名空间）");

// U4 —— 两边都非默认 ⇒ §3.3 裁决：服务胜 + 文件归档 + 一行留痕，**不静默合并**。
const u4Env = setup({
	sessions: [],
	lateSettings: true,
	selfCwd: TEAM_WS,
	settingsSeed: { "team-link": { teams: [teamRow({ name: "service-team" })] } },
	policySeed: policyDoc({ teams: [teamRow({ name: "file-team" })] }),
});
const u4SeedBytes = await readFile(path.join(u4Env.policyHome, "team-link", "policy.json"), "utf8");
await u4Env.provideSettingsFiber();
await waitForChain(u4Env, 1);
const u4Ns = (u4Env.settings.namespaces.get("team-link")?.data.teams ?? []).map((team) => team.name);
const u4Dir = path.join(u4Env.policyHome, "team-link");
const u4Archives = readdirSync(u4Dir).filter((name) => /^policy\.superseded-.*\.json$/u.test(name));
const u4Doc = JSON.parse(await readFile(path.join(u4Dir, "policy.json"), "utf8"));
check("U4 裁决: 服务非默认时服务胜出，文件那一份**不**被并入（没有静默合并）", u4Ns.join(",") === "service-team");
check("U4 裁决: 被胜出的那一份被归档成 policy.superseded-<ts>.json，且内容逐字是原来那份",
	u4Archives.length === 1 && (await readFile(path.join(u4Dir, u4Archives[0]), "utf8")) === u4SeedBytes
		&& JSON.parse(u4SeedBytes).policy.teams.map((team) => team.name).join(",") === "file-team");
check("U4 裁决: 归档之后主文件立刻改成服务的视图并盖 foldedAt（不留过期快照）",
	u4Doc.policy.teams.map((team) => team.name).join(",") === "service-team" && typeof u4Doc.foldedAt === "string");
check("U4 裁决: 留痕一行说清「服务胜出 + 文件归档了」",
	u4Env.log.lines.info.some((line) => line.includes("折叠裁决") && line.includes(u4Archives[0]) && line.includes("服务胜出"))
		&& u4Env.log.lines.info.some((line) => line.includes("memory window: not folded (settings namespace already in use)")));

// U5 —— §3.5 三态首行：roster get 与 team_link_status 都要说得出状态存在哪。
// ★ t-13 🟡2（task-16 B）：这里原来写的是 `teamEnv([teamRow(...)])` —— 数组传给了「选项对象」形参，
// 名册其实是**空的**（夹具在撒谎：它自称有 served-team，实际一个团队都没有）。改对之后 U5 的覆盖才变真：
// 名册非空 ⇒ 段①数出 1 个团队、调用方是该队现任协调者 ⇒ 状态卡第 2 行多出 FR-4 的重钉行（下面两处随之更新）。
const u5ServiceEnv = teamEnv({ teams: [teamRow({ name: "served-team" })] });
const u5ServiceRoster = (await u5ServiceEnv.tool("team_link_roster").execute({ action: "get" }, execFor(u5ServiceEnv.senderAgent))).split("\n");
const u5ServiceStatus = (await statusCall(u5ServiceEnv, {})).split("\n");
const u5FileRoster = (await u1Env.tool("team_link_roster").execute({ action: "get" }, execFor(u1Env.senderAgent))).split("\n");
const u5FileStatus = (await statusCall(u1Env, {})).split("\n");
const u5MemoryRoster = (await u7NoPathEnv.tool("team_link_roster").execute({ action: "get" }, execFor(u7NoPathEnv.senderAgent))).split("\n");
const u5MemoryStatus = (await statusCall(u7NoPathEnv, {})).split("\n");
check("U5 落点行: 服务在场 ⇒ 两个读面的**首行**都是「存储：设置服务（team-link 命名空间）」",
	u5ServiceRoster[0] === "存储：设置服务（team-link 命名空间）" && u5ServiceStatus[0] === "存储：设置服务（team-link 命名空间）");
check("U5 落点行: 文件后端在场 ⇒ 首行是「存储：文件 <绝对路径>」",
	u5FileRoster[0] === `存储：文件 ${u1File}` && u5FileStatus[0] === `存储：文件 ${u1File}` && path.isAbsolute(u1File));
check("U5 落点行: 落点未定/不可用 ⇒ 首行是 ⚠ 三态行，且**带原因码**（R2 可核，红线）",
	u5MemoryRoster[0] === "⚠ 存储：仅进程内存（重启即失）—— 原因：路径解析失败"
		&& u5MemoryStatus[0] === "⚠ 存储：仅进程内存（重启即失）—— 原因：路径解析失败");
check("U5 落点行: 首行之下就是各自原来的第一行（落点行是新增，不是替换）",
	u5ServiceRoster[1].startsWith("团队注册表") && u5FileRoster[1].startsWith("团队注册表")
		// 名册非空 + 调用方是现任协调者 ⇒ 第 2 行是 FR-4 的重钉行，卡标题顺延到第 3 行（首行仍是落点行）。
		&& u5ServiceStatus[1].startsWith("角色重钉：") && u5ServiceStatus[2].includes("团队状态卡"));
// 分歧审计修复轮 🔵#9：段①标题那一处「来源：…」也报落点，而它此前是**写死**的「设置
// team-link 的 teams 键」—— 文件后端部署里于是出现两个互相打架的落点（首行「存储：文件
// …」、下一段「来源：设置 …」）。判据与首行同源，三态各说一句。
check("U5 落点行: 状态卡段①的「来源」**跟随落点** —— 设置 / 文件 / 内存三态各说一句（🔵#9）",
	u5ServiceStatus.some((line) => line === "--- 团队与角色（共 1 个团队；来源：设置 team-link 的 teams 键）---")
		&& u5FileStatus.some((line) => line === `--- 团队与角色（共 1 个团队；来源：文件 ${u1File} 的 teams 键）---`)
		&& u5MemoryStatus.some((line) => line === "--- 团队与角色（共 0 个团队；来源：进程内存的 teams 键（重启即失））---"));
check("U5 落点行: 落点不是设置服务时，段①**不再**说「来源：设置」（首行与段①不许互相打架）",
	!u5FileStatus.some((line) => line.includes("来源：设置")) && !u5MemoryStatus.some((line) => line.includes("来源：设置")));

// U6 —— 只写一处：服务在场时文件**一个字节都不动**（不读、不写、不建）。
const u6Env = setup({ sessions: [], useSettings: true, selfCwd: TEAM_WS });
await u6Env.tool("team_link_roster").execute({ action: "upsert-team", team: "service-only" }, execFor(u6Env.senderAgent));
check("U6 只写一处: 设置服务在场时**不建** team-link 目录、不建 policy.json（状态只在设置服务）",
	!existsSync(path.join(u6Env.policyHome, "team-link")) && u6Env.settings.namespaces.get("team-link") !== undefined);
const u6Env2 = setup({
	sessions: [],
	useSettings: true,
	selfCwd: TEAM_WS,
	settingsSeed: { "team-link": { teams: [teamRow({ name: "service-team" })] } },
	policySeed: policyDoc({ teams: [teamRow({ name: "file-team" })] }),
});
const u6File = path.join(u6Env2.policyHome, "team-link", "policy.json");
const u6Before = await readFile(u6File, "utf8");
await u6Env2.tool("team_link_roster").execute({ action: "upsert-team", team: "service-added" }, execFor(u6Env2.senderAgent));
const u6After = await readFile(u6File, "utf8");
const u6Ns = (u6Env2.settings.namespaces.get("team-link")?.data.teams ?? []).map((team) => team.name);
check("U6 只写一处: 服务在场时文件**一个字节都没动**（连读都不读 —— 否则文件那一侧会被并进来）",
	u6After === u6Before && u6Ns.join(",") === "service-team,service-added" && !u6Ns.includes("file-team"));
// ---------------------------------------------------------------------------
// 策略持久化自持化 S3 迁移与可核：§3.6 一次性迁移。
// 判据：U8（遗留命名空间迁移**一行不动** —— 文件后端不得改写它的判定）·
// U9（导入之后「团队在 + 落点行指向文件」两件事同时可核）。
// 代码**从不**读宿主配置：迁移的输入是人工放进 <home>/team-link/policy.json 的那份文档，
// 下面两个夹具就是它的可复现等价物（真机上的等价命令见 CHANGELOG 的本节）。
// ---------------------------------------------------------------------------

// U8 —— 遗留命名空间（session-link-pro）的迁移不因文件后端而改变。
// 注意旧命名空间的词汇是**信任数据**（pairs / trustedSenders / blockedSenders /
// rememberTargets / receiveMode）—— teams 不在迁移范围里，这是既有实现（见 migrateLegacyPolicy）。
// ① 文件先折叠进服务之后，旧命名空间那份**照旧迁移**（这一步没被折叠挡掉）。
const u8Env = setup({
	sessions: [],
	lateSettings: true,
	selfCwd: TEAM_WS,
	settingsSeed: { "session-link-pro": { trustedSenders: ["session-legacy-sender"], pairs: [rotPair("session-worker-a")] } },
	policySeed: policyDoc({ teams: [teamRow({ name: "file-team" })] }),
});
await u8Env.provideSettingsFiber();
await waitForChain(u8Env, 1);
const u8Chain = u8Env.log.lines.info.find((line) => line.includes("post-attach policy chain finished")) ?? "";
const u8Ns = u8Env.settings.namespaces.get("team-link")?.data ?? {};
const u8Legacy = u8Env.settings.namespaces.get("session-link-pro")?.data ?? {};
const u8Doc = JSON.parse(await readFile(path.join(u8Env.policyHome, "team-link", "policy.json"), "utf8"));
check("U8 遗留命名空间: 文件后端不挡掉迁移 —— 链上两件事都发生（折叠并入 + 旧命名空间迁移）",
	u8Chain.includes("memory window: folded into settings") && u8Chain.includes("legacy migration: migrated"));
check("U8 遗留命名空间: 迁移进来的信任数据与折叠进来的 roster 都在服务命名空间里（两边各管各的，没有互相踩）",
	(u8Ns.teams ?? []).map((team) => team.name).join(",") === "file-team"
		&& (u8Ns.trustedSenders ?? []).join(",") === "session-legacy-sender" && (u8Ns.pairs ?? []).length === 1);
check("U8 遗留命名空间: 一次性迁移的收尾照旧（旧命名空间归零）—— 这一步「一行不动」",
	(u8Legacy.trustedSenders ?? []).length === 0 && (u8Legacy.pairs ?? []).length === 0 && u8Env.settings.namespaces.has("session-link-pro"));
check("U8 遗留命名空间: 折叠后的文件里是**合并后**的那一份（信任数据也一并落下），并盖上 foldedAt",
	(u8Doc.policy.teams ?? []).map((team) => team.name).join(",") === "file-team"
		&& (u8Doc.policy.trustedSenders ?? []).join(",") === "session-legacy-sender" && typeof u8Doc.foldedAt === "string");

// ② 反面：服务侧**信任数据已在用**时，旧命名空间那份按既有规则「留在原处」并留痕。
const u8bEnv = setup({
	sessions: [],
	lateSettings: true,
	selfCwd: TEAM_WS,
	settingsSeed: { "session-link-pro": { trustedSenders: ["session-legacy-sender"] } },
	policySeed: policyDoc({ teams: [teamRow({ name: "file-team" })], trustedSenders: ["session-file-sender"] }),
});
await u8bEnv.provideSettingsFiber();
await waitForChain(u8bEnv, 1);
const u8bChain = u8bEnv.log.lines.info.find((line) => line.includes("post-attach policy chain finished")) ?? "";
const u8bNs = u8bEnv.settings.namespaces.get("team-link")?.data ?? {};
const u8bLegacy = u8bEnv.settings.namespaces.get("session-link-pro")?.data ?? {};
check("U8 遗留命名空间: 文件与服务都已有信任数据时不静默合并 —— 旧命名空间那份被「已在用」挡住、留在原处、并在链上留痕",
	u8bChain.includes("legacy migration: kept (current namespace in use)")
		&& (u8bNs.trustedSenders ?? []).join(",") === "session-file-sender"
		&& (u8bLegacy.trustedSenders ?? []).join(",") === "session-legacy-sender"
		&& u8bEnv.log.lines.info.some((line) => line.includes("legacy policy namespace") && line.includes("kept untouched")));
// U9 —— 一次性迁移**可核**：把那份文档放进 <home>/team-link/policy.json 之后，
//「团队在」与「落点指向那个文件」两件事都必须当场读得出来。
const u9SeedDoc = policyDoc({ teams: [teamRow({ name: "threat-intel" })] });
const u9Env = setup({ sessions: [], selfCwd: TEAM_WS, policySeed: u9SeedDoc });
const u9File = path.join(u9Env.policyHome, "team-link", "policy.json");
const u9Roster = (await u9Env.tool("team_link_roster").execute({ action: "get" }, execFor(u9Env.senderAgent))).split("\n");
const u9Status = (await statusCall(u9Env, {})).split("\n");
check("U9 迁移可核: 导入之后 `roster get` 真的看得见 threat-intel（不是「已导入」的承诺，是当场读数）",
	u9Roster.some((line) => line.startsWith("- threat-intel ")) && u9Status.some((line) => line.includes("threat-intel")));
check("U9 迁移可核: 落点行 = 「存储：文件 <绝对路径>」，两个读面都指同一个真文件（可核 = 能顺着它去看）",
	u9Roster[0] === `存储：文件 ${u9File}` && u9Status[0] === `存储：文件 ${u9File}` && existsSync(u9File));
check("U9 迁移可核: 仅仅**导入**不产生任何写 —— 磁盘上仍是人工放进去的那一份（savedAt 一字未动）",
	JSON.parse(await readFile(u9File, "utf8")).savedAt === u9SeedDoc.savedAt
		&& (await readdirSync(path.join(u9Env.policyHome, "team-link"))).length === 1);

// U10 —— **快路径折叠**（分歧审计修复轮 🟡#5；设计档 §3.1 档 4 + §4）。
// 现象：`loadPolicyFile()` 过去只有一处调用（`if (scope === null)`），所以设置服务在
// activation 就已在场时**文件从不被读** —— 文件后端时期写下的团队在「服务一开始就在场」
// 的下一次启动里不可见（正是设计档 §1 现象的形状），而 U6 第二条断言把它锁成了规格。
// 裁定：快路径也要折叠，规则与档 4 完全同一条、走同一条代码路径。
//
// 第二条边界（服务非默认 ⇒ 文件逐字节不变）**不另造**：那就是 U6 第二条断言本身
// （`u6Env2` 夹具：服务非默认 + 文件有状态），此处只做交叉引用。
const u10FoldSeedDoc = policyDoc({ teams: [teamRow({ name: "file-team" })] });
const u10FoldEnv = setup({ sessions: [], useSettings: true, selfCwd: TEAM_WS, policySeed: u10FoldSeedDoc });
const u10FoldFile = path.join(u10FoldEnv.policyHome, "team-link", "policy.json");
const u10FoldChain = await waitForChain(u10FoldEnv, 1);
const u10FoldRoster = (await u10FoldEnv.tool("team_link_roster").execute({ action: "get" }, execFor(u10FoldEnv.senderAgent))).split("\n");
const u10FoldDoc = JSON.parse(await readFile(u10FoldFile, "utf8"));
const u10FoldArchives = readdirSync(path.join(u10FoldEnv.policyHome, "team-link")).filter((name) => /^policy\.superseded-.+\.json$/u.test(name));
check("U10 快路径折叠: 服务在 activation 就已挂上且为默认时，文件里那一份照样并入命名空间（修复前文件从不被读 ⇒ 团队不可见）",
	u10FoldChain === 1 && u10FoldRoster.some((line) => line.startsWith("- file-team "))
		&& (u10FoldEnv.settings.namespaces.get("team-link")?.data.teams ?? []).map((team) => team.name).join(",") === "file-team");
check("U10 快路径折叠: 折叠后落点是设置服务（首行如实说是服务，不是文件）",
	u10FoldRoster[0] === "存储：设置服务（team-link 命名空间）");
check("U10 快路径折叠: 并入之前文件那一侧被**原样归档**（policy.superseded-*.json 逐字是导入那一份）",
	u10FoldArchives.length === 1 && await readFile(path.join(u10FoldEnv.policyHome, "team-link", u10FoldArchives[0]), "utf8") === JSON.stringify(u10FoldSeedDoc, null, 2));
check("U10 快路径折叠: 折叠后文件里是**合并后**的那一份并盖上 foldedAt（下次服务缺席时读到的是它）",
	u10FoldDoc.policy.teams[0]?.name === "file-team" && typeof u10FoldDoc.foldedAt === "string" && Number.isFinite(Date.parse(u10FoldDoc.foldedAt)));
check("U10 快路径折叠: 留痕两行 —— 折叠那一行只出现一次（§5.3 不搞 warn 风暴）+ 链上「folded into settings」",
	u10FoldEnv.log.lines.warn.filter((line) => line.includes("policy store attached on the fast path with a state from the file backend")).length === 1
		&& u10FoldEnv.log.lines.info.some((line) => line.includes("post-attach policy chain finished") && line.includes("memory window: folded into settings"))
		&& u10FoldEnv.log.lines.info.some((line) => line.includes("折叠存档") && line.includes(u10FoldArchives[0])));

// ---------------------------------------------------------------------------
// 代码评审修复轮（2026-09-27）判据：U11 损坏档守卫 · U12 写失败 warn 按段复位 ·
// 🔵#3 `foldedAt` 盖戳门 · 🔵#4 `refused` 是一个真实的未挂载窗口。
// ---------------------------------------------------------------------------

// U11 —— 损坏档守卫（🟡#1）：载入判定为损坏 ⇒ **一律不覆盖**那份文件。
// 现象：`loadPolicyFile` 解析失败时不写并留了一行 warn 说「本次不会覆盖该文件」，但
// `persistPolicyFile` 毫无守卫 ⇒ 文件后端下**下一次任何写入**都会用原子 rename 把损坏文件
// 整个替换掉，落点行还会从「⚠ 仅进程内存」翻成「存储：文件」（`policyPlacement` 只看
// `fileUsable`）。这里 seed 的是**半截 JSON**（原文写盘，夹具在 `apply` 之前落盘）。
const u11BrokenBytes = '{ "schema": 1, "policy": { "teams": [';
const u11Env = setup({ sessions: [], selfCwd: TEAM_WS, policySeed: u11BrokenBytes });
const u11File = path.join(u11Env.policyHome, "team-link", "policy.json");
const u11SeedBytes = await readFile(u11File, "utf8");
const u11RosterTool = u11Env.tool("team_link_roster");
const u11Out = await u11RosterTool.execute({ action: "upsert-team", team: "after-corruption" }, execFor(u11Env.senderAgent));
await u11RosterTool.execute({ action: "upsert-team", team: "after-corruption-2" }, execFor(u11Env.senderAgent));
const u11AfterBytes = await readFile(u11File, "utf8");
const u11Roster = (await u11RosterTool.execute({ action: "get" }, execFor(u11Env.senderAgent))).split("\n");
const u11Status = (await statusCall(u11Env, {})).split("\n");
check("U11 损坏档: 载入判坏之后触发写入，磁盘上那份文件**逐字节不变**（修复前：原子 rename 把它整个替换成合并结果）",
	u11SeedBytes === u11BrokenBytes && u11AfterBytes === u11BrokenBytes
		&& u11Out.includes("已创建团队 after-corruption"));
check("U11 损坏档: 落点行报**第 5 个原因**「文件损坏（不覆盖；请人工处理）」—— 不翻成「存储：文件」",
	u11Roster[0] === "⚠ 存储：仅进程内存（重启即失）—— 原因：文件损坏（不覆盖；请人工处理）"
		&& u11Status[0] === u11Roster[0]);
check("U11 损坏档: 判坏在载入留痕里说出口，且写路径**每一次**写都再如实留一行（不静默、也不吞掉第二次以后）",
	u11Env.log.lines.warn.some((line) => line.includes("is not valid JSON") && line.includes("文件损坏（不覆盖；请人工处理）"))
		&& u11Env.log.lines.warn.filter((line) => line.includes("was judged corrupt at load") && line.includes("该文件**未被覆盖**")).length === 2
		&& u11Env.log.lines.warn.filter((line) => line.includes("policy file write failed")).length === 0);
check("U11 损坏档: 状态本身不受影响（写进内存、读面看得见两个团队），只有落点降级 —— 段①也如实说「进程内存」",
	u11Roster.some((line) => line.startsWith("- after-corruption "))
		&& u11Status.some((line) => line === "--- 团队与角色（共 2 个团队；来源：进程内存的 teams 键（重启即失））---"));

// U12 —— 写失败 warn **按段复位**（🟡#2）：`fileWriteWarned` 过去是进程级一次性门，第一段
// 失败 warn 过之后**再下一次失败完全静默**（与 `attachWarned` 按窗口复位的范式不一致）。
// 夹具用「把 policy.json 变成一个非空目录」让 `rename(tmp, file)` 必失败，解开即写成功。
const u12Env = setup({ sessions: [], selfCwd: TEAM_WS });
const u12File = path.join(u12Env.policyHome, "team-link", "policy.json");
const u12Block = () => { rmSync(u12File, { recursive: true, force: true }); mkdirSync(u12File, { recursive: true }); writeFileSync(path.join(u12File, "blocker"), "x", "utf8"); };
const u12Unblock = () => rmSync(u12File, { recursive: true, force: true });
const u12WriteWarns = () => u12Env.log.lines.warn.filter((line) => line.includes("policy file write failed"));
const u12RosterTool = u12Env.tool("team_link_roster");
u12Block();
await u12RosterTool.execute({ action: "upsert-team", team: "u12-fail-1" }, execFor(u12Env.senderAgent));
await u12RosterTool.execute({ action: "upsert-team", team: "u12-fail-2" }, execFor(u12Env.senderAgent));
const u12WarnsInOneSegment = u12WriteWarns().length;
// 同一时刻的落点行 —— 证明那两次写**真的失败了**（控制项的前提，不然「只报一行」是空转的绿）。
const u12FailPlacement = (await u12RosterTool.execute({ action: "get" }, execFor(u12Env.senderAgent))).split("\n")[0];
u12Unblock();
await u12RosterTool.execute({ action: "upsert-team", team: "u12-ok" }, execFor(u12Env.senderAgent));
let u12OkDoc = null;
try { u12OkDoc = JSON.parse(await readFile(u12File, "utf8")); } catch { u12OkDoc = null; }
u12Block();
await u12RosterTool.execute({ action: "upsert-team", team: "u12-fail-3" }, execFor(u12Env.senderAgent));
check("U12 ★ 负相（控制项：这道门本来就有，红相里这条本就绿 —— 覆盖缺口类，不冒充红相）: 同一段里连续两次失败只报一行 warn",
	u12WarnsInOneSegment === 1 && u12FailPlacement === "⚠ 存储：仅进程内存（重启即失）—— 原因：文件不可写");
check("U12 写失败: 中间那次**写入成功**之后新的一段失败**又报一行**（修复前这道门是进程级一次性的 ⇒ 第二次失败完全静默）",
	u12OkDoc !== null && u12OkDoc.policy.teams.map((team) => team.name).join(",") === "u12-fail-1,u12-fail-2,u12-ok"
		&& u12WriteWarns().length === 2);

// 🔵#3 —— `foldedAt` 盖戳门：`syncFileFromService` 过去**无条件**盖新戳，于是
// 「最近一次 attach 时刻」冒充「折叠落定时刻」。这里的启动链上**没有折叠发生**（未挂载期间
// 无写入 ⇒ memory window: none），所以 foldedAt 必须逐字节保持上一次真正落定的那个值。
const b3SeedFoldedAt = "2026-09-01T00:00:00.000Z";
const b3Env = setup({ sessions: [], lateSettings: true, selfCwd: TEAM_WS, policySeed: policyDoc({ teams: [] }, b3SeedFoldedAt) });
await b3Env.provideSettingsFiber();
const b3ChainCount = await waitForChain(b3Env, 1);
const b3ChainLine = b3Env.log.lines.info.find((line) => line.includes("post-attach policy chain finished")) ?? "";
const b3Doc = JSON.parse(await readFile(path.join(b3Env.policyHome, "team-link", "policy.json"), "utf8"));
const b3Roster = (await b3Env.tool("team_link_roster").execute({ action: "get" }, execFor(b3Env.senderAgent))).split("\n");
check("🔵#3 foldedAt 盖戳门: 本次链上没有折叠发生（memory window: none）时**不重盖** foldedAt —— 它继续指上一次真正落定的折叠，不是「最近一次 attach」（修复前：无条件盖新戳）",
	b3ChainCount === 1 && b3Doc.foldedAt === b3SeedFoldedAt);
check("🔵#3 ★ 负相（控制项：不冒充红相）: 上面那条的夹具确实落在「没有折叠」这一支上（链上 memory window: none、落点已切到服务）—— 判据是活的，不是恒假",
	b3ChainLine.includes("memory window: none (no writes while unattached)")
		&& b3Roster[0] === "存储：设置服务（team-link 命名空间）");

// 🔵#4 —— `refused` 也是**真实的未挂载窗口**：服务在场但**拒绝注册**、后来才挂上。
// 旧判据 `activationReason !== "attached" && activationReason !== "refused"` 把它排除出去，
// 于是留痕说成「服务从一开始就在场」（快路径措辞）并顺手给本进程自己写的镜像多归档一份。
const b4Env = setup({ sessions: [], useSettings: true, settingsRegisterThrows: true, selfCwd: TEAM_WS });
const b4RosterTool = b4Env.tool("team_link_roster");
const b4Out = await b4RosterTool.execute({ action: "upsert-team", team: "refused-window-team" }, execFor(b4Env.senderAgent));
// 这个窗口里的写入走的是**文件后端**（服务还在拒注册）：先把这一点钉住，再让同一个服务
// 「改口」—— 下一读触发惰性重试，链上才真的有折叠可并入。
const b4WindowRoster = (await b4RosterTool.execute({ action: "get" }, execFor(b4Env.senderAgent))).split("\n");
b4Env.settings.stopRefusing();
await b4RosterTool.execute({ action: "get" }, execFor(b4Env.senderAgent));
const b4ChainCount = await waitForChain(b4Env, 1);
const b4FoldWarns = b4Env.log.lines.warn.filter((line) => line.includes("policy store attached"));
const b4Archives = readdirSync(path.join(b4Env.policyHome, "team-link")).filter((name) => /^policy\.superseded-.+\.json$/u.test(name));
check("🔵#4 ★ 负相（控制项：夹具必须真的挂上了，否则下面两条是空转的红 —— 本条在红相里也绿）: 拒注册之后新到的服务挂上、窗口里的写入折叠并入命名空间",
	b4Out.includes("已创建团队 refused-window-team") && b4ChainCount === 1
		&& b4WindowRoster[0].includes("存储：文件")
		&& (b4Env.settings.namespaces.get("team-link")?.data.teams ?? []).map((team) => team.name).join(",") === "refused-window-team");
check("🔵#4 refused 窗口: 折叠留痕如实说「服务在场但拒绝注册」—— 不说成「服务从一开始就在场」的那句快路径措辞（修复前：走的是快路径措辞）",
	b4FoldWarns.length === 1
		&& b4FoldWarns[0].includes("after the active provider REFUSED the register")
		&& b4FoldWarns[0].includes("不是「服务从一开始就在场」")
		&& b4FoldWarns[0].includes("attached on the fast path") === false);
check("🔵#4 refused 窗口: 不给本进程自己写的镜像多归档一份（判据与「只有真·快路径才存档」同源 —— 修复前会多出一份 superseded）",
	b4Archives.length === 0);
// ---------------------------------------------------------------------------
// 代码评审**第 2 轮**（2026-09-27）判据：🟡#1 attach 后置链 catch 支的盖戳门 ·
// 🔵#2 `policy: []` 也算损坏档 · 🔵#3 两因并存时并陈。
// 判据分工：每条一个红相 + 一条 ★ 负相（控制项：钉住夹具真的落在那一支上，
// 免得红相是空转的）。
// ---------------------------------------------------------------------------

// 🟡#1 —— 链在 `memoryOutcome` 产出**之前**断掉时，catch 那一支**不得**盖新 `foldedAt`。
// 旧实现那里是无参的 `syncFileFromService()`，而盖戳门是 `options.foldHappened !== false`
// （对 `undefined` 取真）⇒ 照盖，于是 `foldedAt` 冒充「最近一次 attach 时刻」。
//
// 夹具怎么让链真的断掉：链上每一步都吞掉了自己的错误（`adoptMemoryWindow` 有内部 catch、
// `migrateLegacyPolicy` 有内部 catch），所以第一段 promise 只可能**它自己那两行留痕抛出去**
// 才拒绝。这里注入一个「前两行 warn 会抛」的日志槽（正是日志出口坏掉的形状）：折叠那行
// warn 先抛 → 被 `adoptMemoryWindow` 的内部 catch 接住并再报一行 → 那一行又抛 ⇒ promise
// 拒绝 ⇒ 走链的 catch 支。留痕恢复正常后，catch 支与随后的回写照常跑完。
const h1SeedFoldedAt = "2026-09-01T00:00:00.000Z";
const h1Env = setup({ sessions: [], lateSettings: true, selfCwd: TEAM_WS, policySeed: policyDoc({ teams: [teamRow({ name: "file-team" })] }, h1SeedFoldedAt) });
const h1File = path.join(h1Env.policyHome, "team-link", "policy.json");
const h1RealWarn = h1Env.log.service.warn;
let h1Armed = 2;
h1Env.log.service.warn = (message) => {
	if (h1Armed > 0) {
		h1Armed -= 1;
		throw new Error("policy log sink blew up (test injection)");
	}
	h1RealWarn(message);
};
await h1Env.provideSettingsFiber();
for (let i = 0; i < 500 && h1Env.log.lines.warn.filter((line) => line.includes("post-attach policy chain failed")).length < 1; i += 1) await tick();
// 回写是 fire-and-forget：等它**真的落到磁盘上**再读。判据用 `savedAt` —— 种子档的
// savedAt 是 policyDoc() 里那个固定时刻，回写必刷新它；内容本身两侧相同（折叠进去的就是
// 文件里那一份），所以拿内容当「写过了」的证据会立刻假绿。
// 代码评审第 3 轮实测补的守卫（夹具自身的竞速，不是插件缺陷）：轮询读与链尾回写在同一
// 窗口并发时，Windows 会偶发把回写那次原子 `rename` 拒成 EPERM（目标文件正被本循环的
// readFile 句柄持有）⇒ 回写被拒、`savedAt` 永不刷新、两条断言假红。所以**回写在飞
// （`policy.json.tmp` 在场）时不打开目标文件**：先等 `.tmp` 出现、再等它消失，只在回写
// 肯定不在飞的时候读（前 10 拍只 stat 不 open —— 回写紧跟「chain failed」那一行启动，
// 那时它要么已在飞、要么已完成，两条都安全）。
let h1SawTmp = false;
for (let i = 0; i < 500; i += 1) {
	if (existsSync(`${h1File}.tmp`)) {
		h1SawTmp = true;
		await tick();
		continue;
	}
	if (h1SawTmp || i >= 10) {
		let probe = null;
		try { probe = JSON.parse(await readFile(h1File, "utf8")); } catch { probe = null; }
		if (probe !== null && probe.savedAt !== "2026-09-27T00:00:00.000Z") break;
	}
	await tick();
}
let h1Doc = null;
try { h1Doc = JSON.parse(await readFile(h1File, "utf8")); } catch { h1Doc = null; }
check("🟡#1 catch 支盖戳门: 链在折叠结果产出**之前**断掉时**不盖新 foldedAt** —— 文件里那个戳逐字节保留（修复前：catch 支无参调用 ⇒ 照盖新戳，把「最近一次 attach 时刻」冒充「折叠落定时刻」）",
	h1Doc !== null && h1Doc.savedAt !== "2026-09-27T00:00:00.000Z" && h1Doc.foldedAt === h1SeedFoldedAt);
check("🟡#1 ★ 负相（控制项：不冒充红相）: 上面那条的夹具确实走的是**链的 catch 支**（那一行 warn 在、链尾那行「chain finished」不在），且回写照跑 —— 合并结果已落盘（判据是活的，不是恒假）",
	h1Env.log.lines.warn.filter((line) => line.includes("post-attach policy chain failed")).length === 1
		&& h1Env.log.lines.info.filter((line) => line.includes("post-attach policy chain finished")).length === 0
		&& h1Doc !== null && h1Doc.savedAt !== "2026-09-27T00:00:00.000Z" && h1Doc.policy.teams.map((team) => team.name).join(",") === "file-team");

// 🔵#2 —— `{"schema":1,"policy":[]}` 也是损坏档：数组不是命名空间镜像（`normalizePolicy`
// 会把它读成一份全默认的空视图）。旧的判据 `typeof doc.policy !== "object"` 对数组不设防
// （`typeof [] === "object"`）⇒ 它被当成合法空档、`fileUsable` 置真、落点行翻成
// 「存储：文件 …」，**下一次任何写入**都用原子 rename 把它整个替换掉 —— 正是 U11 要防的
// 「损坏档被覆盖」。
const b2SeedBytes = `{ "schema": 1, "policy": [] }`;
const b2Env = setup({ sessions: [], selfCwd: TEAM_WS, policySeed: b2SeedBytes });
const b2File = path.join(b2Env.policyHome, "team-link", "policy.json");
const b2SeedOnDisk = await readFile(b2File, "utf8");
const b2Out = await b2Env.tool("team_link_roster").execute({ action: "upsert-team", team: "after-array-policy" }, execFor(b2Env.senderAgent));
const b2RosterLines = (await b2Env.tool("team_link_roster").execute({ action: "get" }, execFor(b2Env.senderAgent))).split("\n");
const b2AfterBytes = await readFile(b2File, "utf8");
check("🔵#2 数组 policy: `{\"schema\":1,\"policy\":[]}` 判为损坏档 ⇒ 落点行报**第 5 个原因**（修复前：`typeof [] === \"object\"` ⇒ 被当合法空档，落点翻成「存储：文件」）",
	b2RosterLines[0] === `⚠ 存储：仅进程内存（重启即失）—— 原因：文件损坏（不覆盖；请人工处理）`
		&& b2Out.includes("已创建团队 after-array-policy"));
check("🔵#2 数组 policy: 判坏之后一次写，磁盘上那份文件**逐字节不变**（不覆盖 —— 修复前那次 upsert 直接用原子 rename 把它整个替换掉了）",
	b2AfterBytes === b2SeedBytes);
check("🔵#2 ★ 负相（控制项：不冒充红相）: 夹具真的把那份数组档原样落在磁盘上（读到的就是 seed 那几字节），且团队状态本身照常可写可读 —— 判坏的只是**落点**，不是状态",
	b2SeedOnDisk === b2SeedBytes
		&& b2RosterLines.some((line) => line.startsWith("- after-array-policy ")));

// 🔵#3 —— 两因并存时**并陈**：服务在场却注册不出本命名空间（`no-register`）**且**文件侧也
// 出过事（这里是损坏）。旧形状是 `no-register` 单方面胜出，用户看不到「你的文件坏了、
// 需要人工处理」这条**唯一的行动信号**。
const twoEnv = setup({ sessions: [], useSettings: true, settingsRegisterThrows: true, selfCwd: TEAM_WS, policySeed: b2SeedBytes });
const twoRosterLines = (await twoEnv.tool("team_link_roster").execute({ action: "get" }, execFor(twoEnv.senderAgent))).split("\n");
const twoStatusLines = (await statusCall(twoEnv, {})).split("\n");
check("🔵#3 两因并存: 服务在场却拒注册 **且** 文件损坏 ⇒ 落点行**并陈**两条原因，roster 与 status 逐字同形（修复前：`no-register` 独占一行，把「文件损坏、请人工处理」整条吞掉）",
	twoRosterLines[0] === `⚠ 存储：仅进程内存（重启即失）—— 原因：no-register；另：文件损坏（不覆盖；请人工处理）`
		&& twoStatusLines[0] === twoRosterLines[0]);
const oneEnv = setup({ sessions: [], useSettings: true, settingsRegisterThrows: true, selfCwd: TEAM_WS });
const oneNoRegisterLines = (await oneEnv.tool("team_link_roster").execute({ action: "get" }, execFor(oneEnv.senderAgent))).split("\n");
const onePathLines = (await u7NoPathEnv.tool("team_link_roster").execute({ action: "get" }, execFor(u7NoPathEnv.senderAgent))).split("\n");
const oneUnwritableLines = (await u12Env.tool("team_link_roster").execute({ action: "get" }, execFor(u12Env.senderAgent))).split("\n");
const oneCorruptLines = (await u11Env.tool("team_link_roster").execute({ action: "get" }, execFor(u11Env.senderAgent))).split("\n");
check("🔵#3 ★ 负相（控制项：不冒充红相）: 并陈**只**发生在两因并存时 —— 四种单因形态逐字不变（no-register / 路径解析失败 / 文件不可写 / 文件损坏 各一行，无「另：」）",
	oneNoRegisterLines[0] === `⚠ 存储：仅进程内存（重启即失）—— 原因：no-register`
		&& onePathLines[0] === `⚠ 存储：仅进程内存（重启即失）—— 原因：路径解析失败`
		&& oneUnwritableLines[0] === `⚠ 存储：仅进程内存（重启即失）—— 原因：文件不可写`
		&& oneCorruptLines[0] === `⚠ 存储：仅进程内存（重启即失）—— 原因：文件损坏（不覆盖；请人工处理）`);
// ---------------------------------------------------------------------------
// 代码评审**第 3 轮**（2026-09-27）判据：🟡#1 `fold failed` 之后链尾不回写 ·
// 🟡#2 `detach()` 同步置「未挂载窗口」判据。
// ---------------------------------------------------------------------------

// 🟡#1 —— `adoptMemoryWindow` 的 catch 支（`fold failed`）**不抛** ⇒ `.then` 链继续走到
// `syncFileFromService`，其门在文件后端部署里全过 ⇒ 内存被整份替换成**服务视图**（折叠失败
// ⇒ 服务里没有窗口数据）并写回文件 —— 窗口数据从内存与文件**两边同时消失**，且无归档、还盖
// 新 `foldedAt`（与 §3.4「宁可漏盖不冒盖」相反）。夹具让 `scope.update` 在 register 成功后
// 抛错（`settingsUpdateThrows`）⇒ 折叠必失败；判据钉三件事：① 文件里那份**逐字节不变**
// ② `foldedAt` 不重盖 ③ 留痕说「仍在落点里、未并入」与文件实况一致 —— 链上
// `memory window: fold failed` 与「窗口数据仍在文件里」一起作控制，钉住夹具真落在那一支。
const g1SeedFoldedAt = "2026-09-01T00:00:00.000Z";
const g1Env = setup({ sessions: [], lateSettings: true, settingsUpdateThrows: true, selfCwd: TEAM_WS, policySeed: policyDoc({ teams: [teamRow({ name: "file-team" })] }, g1SeedFoldedAt) });
const g1File = path.join(g1Env.policyHome, "team-link", "policy.json");
const g1SeedBytes = await readFile(g1File, "utf8");
await g1Env.provideSettingsFiber();
const g1ChainCount = await waitForChain(g1Env, 1);
const g1ChainLine = g1Env.log.lines.info.find((line) => line.includes("post-attach policy chain finished")) ?? "";
const g1AfterBytes = await readFile(g1File, "utf8");
let g1Doc = null;
try { g1Doc = JSON.parse(g1AfterBytes); } catch { g1Doc = null; }
check("🟡#1 fold failed 不回写: 折叠失败（scope.update 抛错）后链尾**不把服务视图写回文件** —— ① 文件里那份逐字节不变（窗口数据仍在落点里）② foldedAt 不重盖 ③ 留痕说「仍在落点里、未并入」与文件实况一致（修复前：内存与文件两边同时抹掉窗口数据，且无归档、还盖新 foldedAt）",
	g1ChainCount === 1 && g1ChainLine.includes("memory window: fold failed")
		&& g1AfterBytes === g1SeedBytes
		&& g1Doc !== null && g1Doc.foldedAt === g1SeedFoldedAt
		&& g1Doc.policy.teams.map((team) => team.name).join(",") === "file-team"
		&& g1Env.log.lines.warn.some((line) => line.includes("failed to fold the unattached startup window") && line.includes("仍在落点") && line.includes("本次未能并入设置命名空间")));

// 🟡#2 —— `detach()` 重开了 warn 门（`attachWarned`），却没重开「未挂载窗口」判据
// （`unattachedWindowKind` / `enteredUnattachedWindow` 只在 activation 写一次）。于是
// 「provider 掉线触发 detach → 窗口内有写入 → provider 回来再 attach」这条链上，折叠留痕
// 用的还是 activation 那一次写下的措辞（对一个真实发生过的 detach 窗口是假陈述），归档判据
// `!enteredUnattachedWindow` 读的也是 activation 的旧值。夹具走真实 cordis：provider fiber
// dispose ⇒ scope 随其 owner fiber 释放 ⇒ 窗口写入落文件后端 ⇒ 新 provider（空命名空间）
// 回来 ⇒ 折叠发生。判据钉两件事：折叠留痕如实说「provider 被 detach 后又回来」（不说快路径
// 措辞、也不说成 startup window）＋ 不给本进程自己写的镜像多归档一份（与 🔵#4 同一条裁定）。
const g2Env = setup({ sessions: [], lateSettings: true, selfCwd: TEAM_WS });
const g2Provider1 = await g2Env.provideSettingsFiber();
await g2Provider1.dispose();
await tick();
const g2DetachedWrite = await g2Env.tool("team_link_roster").execute({ action: "upsert-team", team: "detach-window-team" }, execFor(g2Env.senderAgent));
const g2Provider2 = makeSettings();
await g2Env.provideSettingsFiber(g2Provider2);
const g2ChainCount = await waitForChain(g2Env, 2);
// 措辞四支的前缀两种都认：晚挂/拒注册支是 "policy store attached …"，detach 支是
// "policy store re-attached …"（第 3 轮 🟡#2 的新前缀）。
const g2FoldWarns = g2Env.log.lines.warn.filter((line) => line.includes("policy store attached") || line.includes("policy store re-attached"));
const g2Archives = readdirSync(path.join(g2Env.policyHome, "team-link")).filter((name) => /^policy\.superseded-.+\.json$/u.test(name));
check("🟡#2 detach 窗口判据: 折叠留痕如实说「provider 被 detach 后又回来」—— 不说快路径措辞、也不说成 startup window（修复前：判据不随 detach 复位，走的还是 activation 写下的那一句）；且不给本进程自己写的镜像多归档一份（detach 也是未挂载窗口，判据与 🔵#4 同源）",
	g2DetachedWrite.includes("已创建团队 detach-window-team") && g2ChainCount === 2
		&& (g2Provider2.namespaces.get("team-link")?.data.teams ?? []).map((team) => team.name).join(",") === "detach-window-team"
		&& g2FoldWarns.length === 1
		&& g2FoldWarns[0].includes("re-attached after its settings owner was detached")
		&& g2FoldWarns[0].includes("provider 被 detach 后又回来")
		&& g2FoldWarns[0].includes("attached on the fast path") === false
		&& g2FoldWarns[0].includes("startup window") === false
		&& g2Archives.length === 0);
// B6（③b 差异审计）: `tmpDir` is the export block's output directory and it is
// re-created at the END of the run, so `rmSync` at import time cleans the PREVIOUS
// run but leaves the current run's two files behind — every suite run leaked two
// gitignored files. The teardown below owns it now, together with the escape dir
// and the three team fixtures. (有界修复轮 A 项之后，这些目录全在本进程独有的
// `TEST_ROOT`（os.tmpdir() 之下）里，工作树一个字节都不落。)
// ===========================================================================
// C 批（客户端面 · C1）· §3.0 跨半边取数通道：只读路由 GET /team-link/panel
// 设计档 docs/client-panel-batch-design-2026-09-27.md §3.0/§3.1/§3.2/§3.4；
// 判据 W1–W3 · W5–W7 · W9（W4 = C2 阶段；W8 = 两套件逐条绿）。
// 断言名以判据号开头：实现之前这一段整批 FAIL，就是本节的红相读数。
// ===========================================================================

const PN_TMP = path.join(TEAM_TMP, "panel");
const PN_WS = path.join(PN_TMP, "ws");
const PN_TEAM = "panel-team";
const PN_LEAD = "session-pn-lead";
const PN_CODER = "session-pn-coder";
const PN_TOTEN = "9f8e7d6c-5b4a-3928-1706-ffe5dd4cc3bb";
const PN_NOW_MS = Date.now();
const PN_PEERS = Array.from({ length: 14 }, (_, index) => "session-pn-" + String(index).padStart(2, "0"));
const PN_ALL = [PN_LEAD, PN_CODER, ...PN_PEERS];
/** 读窗内的行要读得出**真 verdict**，所以每条 surface 都是「刚刚」的消息（静默 < 10min）。 */
const pnRecentEvents = (id) => [
	{ type: "user/message", seq: 1, time: PN_NOW_MS - 3 * 60000, data: { id: id + "-u", role: "user", source: { kind: "user" }, content: [{ type: "text", text: "面板夹具 " + id }] } },
	{ type: "assistant/message", seq: 2, time: PN_NOW_MS - 2 * 60000, data: { turn: 1, step: 1, message: { id: id + "-a", role: "assistant", source: { kind: "model", provider: "p", model: "m" }, content: [{ type: "text", text: "收到" }] } } },
];
/** 团队行：一个在任协调者 + **已过期**的在飞换届令牌 + 一个空缺角色。过期令牌是 W9 的
 * 探针 —— `team_read` 的惰性清扫会把它清掉，所以「渲染前后字节与 mtime 不变」这句话
 * 只有在清扫**没被走到**时才成立。 */
const pnTeamRow = {
	name: PN_TEAM,
	createdAt: 1700000000000,
	workspace: PN_WS,
	policy: { writer: "coordinator" },
	roles: [
		{ role: "coordinator", current: "session-self", pending: { session: "session-pn-next", token: PN_TOTEN, team: PN_TEAM, role: "coordinator", createdAt: 1700000000000, expiresAt: PN_NOW_MS - 60000, migratedPairs: [] }, history: [{ session: "session-self", from: 1700000000000, until: null }] },
		{ role: "worker", current: null, pending: null, history: [] },
	],
	mode: "sessions",
	leadSessionId: "",
};
/** 种进 `policy.json` 的一份真状态：团队 + 看门狗 + 一条**已过期**的 provisional 配对
 * （W9 的第二个探针：清扫同样会删它）。 */
const pnSeedDoc = policyDoc({
	teams: [pnTeamRow],
	watchdogs: [{ id: "wd-panel", team: PN_TEAM, watcherSession: "session-self", targets: [PN_PEERS[0]], silentMinutes: 10, intervalMinutes: 5, createdAt: PN_NOW_MS, expiresAt: PN_NOW_MS + 3600000 }],
	pairs: [{ a: "session-self", b: PN_PEERS[0], createdAt: 1, provisional: true, expiresAt: PN_NOW_MS - 1000 }],
});
function pnSetup(extra = {}) {
	return setup({
		sessions: PN_ALL.map((id, index) => ({ header: { id, createdAt: 1000 + index, cwd: PN_WS }, live: true, persisted: true })),
		eventsBySession: Object.fromEntries(PN_ALL.map((id) => [id, pnRecentEvents(id)])),
		extraAgents: PN_ALL.map((id) => ({ id, status: "idle", cwd: PN_WS })),
		selfCwd: PN_WS,
		useSettings: true,
		policySeed: pnSeedDoc,
		...extra,
	});
}
const pnEnv = pnSetup();
const pnChain = await waitForChain(pnEnv, 1);
const pnFile = path.join(pnEnv.policyHome, "team-link", "policy.json");
const pnTasksPath = path.join(PN_WS, "team", PN_TEAM, "tasks.md");
await mkdir(path.dirname(pnTasksPath), { recursive: true });
await writeFile(pnTasksPath, [
	"1 | 2026-09-26T21:10:02.123Z | session-lead | plan | t-7 | 让 worker-b 复核 §3 的行号",
	"2 | 2026-09-26T21:12:44.001Z | session-wb | claim | t-7 | 接了，预计 10 分钟",
	"3 | 2026-09-26T21:19:31.552Z | session-wb | done | t-7 | 核出 3 处错（依据 lib/index.js:3548）",
	"4 | 2026-09-26T21:21:08.900Z | session-lead | dispute | t-7 | 对 43 存疑：第 2 处的行号我读到的不一样",
	"5 | 2026-09-26T21:24:55.310Z | session-wb | retract | t-7 | 撤回 43 的第 2 处",
	"6 | 2026-09-26T21:30:00.000Z | session-lead | plan | t-8 | 第二件事",
	"7 | 2026-09-26T21:31:00.000Z | session-wb | claim | t-8 | 接了",
].join("\n") + "\n", "utf8");

const pnRouteOf = (env) => env.routes.find((route) => route.path === "/team-link/panel");
/** 驱动路由 handler 本身（与导出的既有夹具同一条缝）：绝不重新实现一份路由。 */
async function pnCallOn(env, query = "", options = {}) {
	const route = pnRouteOf(env);
	if (route === undefined) return { missing: true, status: 0, headers: {}, json: null, body: "" };
	const res = await callRoute(route, { method: options.method ?? "GET", url: "/team-link/panel" + query, headers: options.headers ?? {} });
	let json = null;
	try { json = JSON.parse(res.body); } catch { json = null; }
	return { missing: false, status: res.statusCode, headers: res.headers ?? {}, json, body: res.body };
}
const pnCall = await pnCallOn(pnEnv, "?session=session-self");
/** `setup` 只建 store，不建 `ns` 句柄（那是 `teamEnv` 的便利层）；这里按同一读法取。 */
const pnNs = (env) => env.settings.namespaces.get("team-link");
const pnSeg = (payload, key) => (payload === null || payload === undefined ? undefined : payload[key]);
const pnRowsOf = (call) => (pnSeg(call === null || call === undefined ? null : call.json, "sessions")?.rows ?? []);

check("W1 前置: 夹具真的折叠过（文件后端的团队已并入设置命名空间）—— 否则后面读到的是一份空状态", pnChain === 1 && (pnNs(pnEnv).data.teams ?? []).map((team) => team.name).join(",") === PN_TEAM);

// --- W1：同一道栅栏（挂载期成对门 + 请求期逐例同判 + 非 GET 405 + 拒时零读）------
const pnFenceEnv = pnSetup({ sessions: [{ header: { id: "session-fence", createdAt: 1, cwd: PN_WS }, live: true, persisted: true }], eventsBySession: { "session-fence": pnRecentEvents("session-fence") }, connectionStub: makeFencedConnection() });
const pnFencePanelRoute = pnRouteOf(pnFenceEnv);
const pnFenceExportRoute = pnFenceEnv.routes.find((route) => route.path === "/team-link/export");
const pnFenceCases = [
	{ label: "无 token（未登录浏览器）", headers: { host: "127.0.0.1:3080" }, expect: 401, word: "unauthorized" },
	{ label: "Host 不符（DNS rebinding）", headers: { host: "evil.example:3080", cookie: "dsh_session=ok" }, expect: 403, word: "forbidden" },
	{ label: "跨站 Origin", headers: { host: "127.0.0.1:3080", origin: "http://evil.example", cookie: "dsh_session=ok" }, expect: 403, word: "forbidden" },
];
/** Y7 安全调用：路由缺席（实现之前）时给一个「什么都没发生」的读数，而不是把整轮掀翻。 */
const pnCallRouteSafe = async (route, options) => (route === undefined || route === null ? { statusCode: 0, body: "", headers: {} } : await callRoute(route, options));
const pnFenceMark = pnFenceEnv.query.surfaceReads.length;
const pnFenceRows = [];
for (const fenceCase of pnFenceCases) {
	const panelRes = await pnCallRouteSafe(pnFencePanelRoute, { method: "GET", url: "/team-link/panel?session=session-self", headers: fenceCase.headers });
	const exportRes = await pnCallRouteSafe(pnFenceExportRoute, { method: "GET", url: "/team-link/export?session=session-fence&format=md", headers: fenceCase.headers });
	pnFenceRows.push({ label: fenceCase.label, expect: fenceCase.expect, word: fenceCase.word, panel: panelRes.statusCode, export: exportRes.statusCode, panelBody: panelRes.body });
}
check("W1: 面板路由与导出路由在**同一道栅栏**下逐例同判（同一请求、同一裁决，面板的拒绝正文用平台那三个词）",
	pnFenceRows.length === 3 && pnFenceRows.every((row) => row.panel === row.expect && row.export === row.expect && row.panelBody === row.word));
check("W1: 被栅栏拒的面板请求**零数据外泄**（连一次 surface 读都没发生；导出路由那条缝的既有判据是 readSession 为零）—— 且那三条拒绝真的来自这条路由（路由缺席时不算通过）",
	pnFenceEnv.query.surfaceReads.length === pnFenceMark && pnFenceRows.every((row) => row.panel !== 0));
const pnFenceAllowed = await pnCallRouteSafe(pnFencePanelRoute, { method: "GET", url: "/team-link/panel?session=session-self", headers: { host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080", cookie: "dsh_session=ok" } });
check("W1 对照（★ 负相：不冒充）: 同一台栅栏、同一条路由，同源已登录时**照常服务** —— 上面三条拒绝因此不是「什么都拒」的空断言",
	pnFenceAllowed.statusCode === 200 && pnFenceAllowed.body.includes("placementLine"));
const pnPostPanel = await pnCallOn(pnEnv, "?session=session-self", { method: "POST", headers: { host: "127.0.0.1:3080", cookie: "dsh_session=ok" } });
check("W1: 同源已登录的非 GET 请求照旧 405 + allow: GET（面板与导出同形，且发生在任何读之前）",
	pnPostPanel.status === 405 && String(pnPostPanel.headers.allow) === "GET");
const pnNoConnEnv = pnSetup({ omitConnection: true });
const pnNoRejEnv = pnSetup({ connectionWithoutRejection: true });
check("W1: 挂载期成对门也覆盖面板路由 —— 栅栏缺席 / 没有 requestRejection 时**一条路由都不存在**（不是「挂上了再在请求期补门」）；而两个服务都在时它确实在（所以这句不是「反正都没挂」）",
	pnRouteOf(pnEnv) !== undefined && pnNoConnEnv.routes.length === 0 && pnNoRejEnv.routes.length === 0);

// --- W2：落点行与宿主**同源**（同一函数，不是各写一份字符串） -------------------
const pnPlacement = pnCall.json === null || pnCall.json === undefined ? "" : String(pnCall.json.placementLine ?? "");
const pnRosterFirst = String(await pnEnv.tool("team_link_roster").execute({ action: "get", team: PN_TEAM }, execFor(pnEnv.senderAgent))).split("\n")[0];
const pnStatusFirst = String(await pnEnv.tool("team_link_status").execute({ team: PN_TEAM }, execFor(pnEnv.senderAgent))).split("\n")[0];
check("W2: 面板顶部那一行与 roster / status 两个读面的首行**逐字同一串**（三面共用 policy.placementLine()）",
	pnPlacement !== "" && pnPlacement === pnRosterFirst && pnPlacement === pnStatusFirst && pnPlacement.includes("存储："));
check("W2: ... 而客户端半边**一个字节都不自造**这个三态（lib/client.js 里没有「存储：」字面量，也没有第二条格式化逻辑）",
	!clientSource.includes("存储：") && !clientSource.includes("仅进程内存（重启即失）"));

// --- W3：六段齐全 + 每段的降级载体在数据里（R4 的正例与反例） -------------------
const PN_SEGMENTS = ["teams", "pending", "watchdogs", "tasksTail", "sessions"];
check("W3: 六段齐全 —— 落点行 + 五段；每一段都由宿主渲染好 lines，客户端只显示不重算",
	typeof pnCall.json?.placementLine === "string" && PN_SEGMENTS.every((key) => pnSeg(pnCall.json, key)?.present === true && Array.isArray(pnSeg(pnCall.json, key)?.lines) && pnSeg(pnCall.json, key).lines.length > 0));
check("W3: 每段都带降级字段（present / lines；缺失时是 unavailable.reason）—— R4 的载体是数据，不是文案",
	PN_SEGMENTS.every((key) => typeof pnSeg(pnCall.json, key)?.present === "boolean" && Array.isArray(pnSeg(pnCall.json, key)?.lines)));
check("W3: 团队段逐字复述宿主状态卡那一套（在位/空缺 + 版本史末条），换届段的 token 一律掩码",
	(pnSeg(pnCall.json, "teams")?.lines ?? []).some((line) => line.includes("角色 coordinator：现任 session-self")) && (pnSeg(pnCall.json, "teams")?.lines ?? []).some((line) => line.includes("角色 worker：空缺（vacant）")) && (pnSeg(pnCall.json, "pending")?.lines ?? []).join("|").includes(__testing.maskToken(PN_TOTEN)) && !(pnSeg(pnCall.json, "pending")?.lines ?? []).join("|").includes(PN_TOTEN));
const pnAnon = await pnCallOn(pnEnv, "");
check("W3 反例（R4）: 面板拿不到会话身份时，「会话面/读窗」段如实说自己缺什么（present:false + unavailable.reason 点名会话身份），其余五段照常出",
	pnAnon.json?.sessions?.present === false && typeof pnAnon.json?.sessions?.unavailable?.reason === "string" && pnAnon.json.sessions.unavailable.reason.includes("会话身份") && pnAnon.json.teams.present === true && pnAnon.json.placementLine === pnCall.json?.placementLine);
check("W3 反例（对照）: 同一台宿主**有**会话身份时同一段是 present:true —— 上一句拒的是缺数据，不是「这一段本来就不给」",
	pnSeg(pnCall.json, "sessions")?.present === true && pnRowsOf(pnCall).length === PN_ALL.length);

// --- W5 / W9：零写（面板读路径绝不走 team_read 的惰性清扫） ---------------------
const pnSettingsBefore = JSON.stringify(pnNs(pnEnv).data);
const pnBytesBefore = await readFile(pnFile, "utf8");
const pnMtimeBefore = (await stat(pnFile)).mtimeMs;
const pnTasksBefore = await readFile(pnTasksPath, "utf8");
const pnRender = await pnCallOn(pnEnv, "?session=session-self");
const pnBytesAfter = await readFile(pnFile, "utf8");
const pnMtimeAfter = (await stat(pnFile)).mtimeMs;
check("W5/W9: 渲染一次面板前后 policy.json 的**字节与 mtime 都不变**，settings 命名空间也逐字节不变（夹具里带着**已过期**的换届令牌与**已过期**的 provisional 配对：惰性清扫若被走到，这里必红）",
	pnRender.status === 200 && pnBytesAfter === pnBytesBefore && pnMtimeAfter === pnMtimeBefore && JSON.stringify(pnNs(pnEnv).data) === pnSettingsBefore);
check("W9: 台账文件逐字节不变（面板只读黑板，不落任何东西）—— 以一次真的 200 渲染为前提，不是「什么都没调用所以什么都没变」",
	pnRender.status === 200 && (await readFile(pnTasksPath, "utf8")) === pnTasksBefore);
check("W9 ★ 病灶锁（结构锁）: 面板读路径的实现里没有惰性清扫调用 —— 不冒充红相，先把「判据真的成立于源码」钉住",
	typeof __testing.buildPanelPayload === "function" && !String(__testing.buildPanelPayload).includes("sweep") && !String(__testing.buildPanelPayload).includes("expire"));
const pnSweepEnv = pnSetup();
await waitForChain(pnSweepEnv, 1);
const pnSweepFile = path.join(pnSweepEnv.policyHome, "team-link", "policy.json");
const pnSweepBefore = await readFile(pnSweepFile, "utf8");
await pnSweepEnv.tool("team_link_team_read").execute({ team: PN_TEAM }, execFor(pnSweepEnv.senderAgent));
const pnSweepAfter = await readFile(pnSweepFile, "utf8");
check("W9 ★ 负相（控制项：本夹具真的能检出「读路径写了一次」）: 同一款夹具走**会写**的那条读路（team_read 的惰性清扫）时，过期令牌被清掉、落点文件随之改变 —— 上面那条「不变」因此不是因为夹具里没东西可清",
	pnSweepAfter !== pnSweepBefore || (pnNs(pnSweepEnv).data.teams[0].roles[0].pending ?? null) === null);

// --- W6：台账尾与派生读数与 team_read **同源同形** ----------------------------
const pnReadOut = String(await pnEnv.tool("team_link_team_read").execute({ team: PN_TEAM }, execFor(pnEnv.senderAgent)));
const pnTailSeg = pnSeg(pnCall.json, "tasksTail");
const pnRawTailRows = (pnTailSeg?.lines ?? []).filter((line) => line.includes("| plan |") || line.includes("| claim |") || line.includes("| done |"));
check("W6: 台账尾的原始行与 team_read 的原始行逐字同源（同一读法 blackboardLines + 同一批行）",
	pnRawTailRows.length > 0 && pnRawTailRows.every((line) => pnReadOut.includes(line.trim())));
/** 评审修复轮 🔵#4：面板的派生行**带上了团队归属头**（- <team>/tasks.md： 开场，续行四空格缩进，
 * 与同一段台账尾的排版同形）—— 这是面板**加的那一层**；剥掉它之后，行体仍必须逐字是宿主渲染器
 * （tasksDerivedLines / renderTaskView）的字节。这条判据因此比旧版**更紧**：它同时钉住「有归属」
 * 与「行体没被客户端改写」两件事，而不是把归属当成可以省的装饰。 */
const pnDerivedBody = (line) => line.replace(/^    /, "").replace(/^- [^\s/]+\/tasks\.md：/, "");
check("W6: 派生读数**逐字同形** —— 面板每一行「最后主张 / 未消解存疑」剥掉面板自己的团队归属头（- <team>/tasks.md： 与四空格续行缩进）之后，原样出现在 team_read 的输出里（同一渲染器 renderTaskView）",
	Array.isArray(pnTailSeg?.derived) && pnTailSeg.derived.length > 0 && pnTailSeg.derived.every((line) => pnReadOut.includes(pnDerivedBody(line))) && pnTailSeg.derived.some((line) => line.includes("最后主张")) && pnTailSeg.derived.some((line) => line.includes("未消解存疑")));
check("W6 ★ 负相（不冒充）: 上面那句不是「因为两边都是空」—— team_read 自己确实给出了这一对措辞，面板给出的「最后主张」行也不止一行",
	pnReadOut.includes("最后主张") && pnReadOut.includes("未消解存疑") && (pnTailSeg?.derived ?? []).filter((line) => line.includes("最后主张")).length >= 2);

// --- W4（C2）：形态三态徽标 ＋ 档位结论；投影读不到**不冒充** -------------------
const PN_MODE_TEAM = "pn-mode-team";
const pnModeSeedDoc = policyDoc({
	teams: [pnTeamRow, { ...pnTeamRow, name: PN_MODE_TEAM, mode: "agent-team", leadSessionId: PN_LEAD }],
	pairs: pnSeedDoc.policy.pairs,
});
/** 宿主投影替身：**只给两个读方法**（写方法一被调用就抛错并记账 —— 红线「只读宿主」）。 */
const pnModeTeams = makeAgentTeams({ members: [{ id: PN_LEAD, name: "lead", role: "lead", status: "running" }, { id: PN_CODER, name: "coder", role: "teammate", status: "inactive", model: "m" }] });
const pnModeEnv = pnSetup({ policySeed: pnModeSeedDoc });
await waitForChain(pnModeEnv, 1);
pnModeEnv.ctx.provide("agentTeams", pnModeTeams.service);
const pnModeCall = await pnCallOn(pnModeEnv, "?session=session-self");
const pnNoHostEnv = pnSetup({ policySeed: pnModeSeedDoc });
await waitForChain(pnNoHostEnv, 1);
const pnNoHostCall = await pnCallOn(pnNoHostEnv, "?session=session-self");
const pnRowOf = (call, id) => (pnSeg(call.json, "sessions")?.rows ?? []).find((row) => row.id === id);
const pnBadgeOf = (call, id) => (pnRowOf(call, id) === undefined ? null : pnRowOf(call, id).badge ?? null);
const pnBadgeText = (call, id) => (pnBadgeOf(call, id) === null ? "" : String(pnBadgeOf(call, id).label));

check("W4: 三态徽标 —— Lead（settings 的 Lead 指针）/ 成员（宿主投影）/ 多会话（既非 Lead 也不在名册里）三态各就各位，且 form.badges 与行上的徽标同源同形",
	pnBadgeText(pnModeCall, PN_LEAD) === "agent-team·Lead" && pnBadgeText(pnModeCall, PN_CODER) === "agent-team·成员" && pnBadgeText(pnModeCall, PN_PEERS[0]) === "多会话"
		&& pnSeg(pnModeCall.json, "form")?.badges?.[PN_LEAD]?.state === "agent-team-lead" && pnSeg(pnModeCall.json, "form")?.badges?.[PN_CODER]?.state === "agent-team-member");
check("W4: 段顶一句**档位结论**，措辞**复用** team-mode §4.3 的「单会话兜底档」（同一个常量 TEAM_MODE_CONCLUSION，不是第二份文案）",
	typeof pnSeg(pnModeCall.json, "form")?.conclusion === "string" && pnSeg(pnModeCall.json, "form").conclusion.includes("单会话兜底档") && pnSeg(pnModeCall.json, "form").conclusion.includes(PN_MODE_TEAM) && pnSeg(pnModeCall.json, "form").lines[0] === pnSeg(pnModeCall.json, "form").conclusion);
check("W4: 只读宿主 —— 形态段对宿主**零写调用**，同时投影确实被读了（否则这条只是「什么都没发生」）",
	pnModeTeams.calls.writes.length === 0 && pnModeTeams.calls.tryMembership >= 1 && pnModeTeams.calls.listMembers >= 1);
check("W4 反例（投影读不到**不冒充**）: 宿主投影缺席时，非 Lead 的会话**不**被写成「多会话」，而是如实说「档位未判定 ＋ 原因」；Lead 那一格仍由 settings 的指针给（不因投影缺席而少一格）",
	pnBadgeText(pnNoHostCall, PN_PEERS[0]).includes("未判定") && pnBadgeText(pnNoHostCall, PN_PEERS[0]).includes("agentTeams") && pnBadgeText(pnNoHostCall, PN_PEERS[0]) !== "多会话" && pnBadgeText(pnNoHostCall, PN_LEAD) === "agent-team·Lead");
check("W4 对照（★ 负相：不冒充）: 同一台宿主、投影可读时同一格是「多会话」—— 上面那句拒的是缺投影，不是「这一格本来就不给」",
	pnBadgeText(pnModeCall, PN_PEERS[0]) === "多会话" && pnBadgeText(pnNoHostCall, PN_PEERS[0]) !== "多会话");

// --- W7：读窗（未读行显示为未读）+ 只读翻页 -------------------------------------
const pnRows = pnRowsOf(pnCall);
const pnRowHas = (row, needle) => Array.isArray(row?.lines) && row.lines.some((line) => line.includes(needle));
const pnVerdictRows = pnRows.filter((row) => pnRowHas(row, "verdict="));
const pnUnreadRows = pnRows.filter((row) => pnRowHas(row, "未读"));
// 预算不变量（§3.0 ④）：**一次渲染 = 一次路由调用 = 与工具面同一个「≤12 次面读」**。
const pnBudgetMark = pnEnv.query.surfaceReads.length;
await pnCallOn(pnEnv, "?session=session-self");
const pnBudgetReads = pnEnv.query.surfaceReads.length - pnBudgetMark;
check("W7: 读窗内的行有真 verdict、窗口外的行**显示为未读**（两集合都不空、不相交，合起来正是全部会话面行）；且这一次渲染的**面读预算恰 12 次**（16 个会话面行 ⇒ 与工具面同一个 ≤12 的不变量）",
	pnVerdictRows.length === 12 && pnUnreadRows.length === PN_ALL.length - 12 && pnVerdictRows.every((row) => !pnRowHas(row, "未读")) && pnUnreadRows.every((row) => !pnRowHas(row, "verdict=")) && pnBudgetReads === 12);
check("W7: 未读行那句「未读」点名的是**本面板**的窗口（不借列表工具的措辞，也不给一个没读过的 verdict）",
	pnUnreadRows.length > 0 && pnUnreadRows.every((row) => row.lines.some((line) => line.includes("未读") && line.includes("本面板"))));
const pnTail = pnSeg(pnCall.json, "sessions")?.tail;
check("W7: 段尾给出**只读**翻页的确切参数（与列表工具同一段 listReadTail：未读行数 + offset）",
	Array.isArray(pnTail) && pnTail.some((line) => line.includes("未读") && line.includes("offset=12")));
const pnMark2 = pnEnv.query.surfaceReads.length;
const pnPage2 = await pnCallOn(pnEnv, "?session=session-self&offset=12");
const pnReads2 = pnEnv.query.surfaceReads.length - pnMark2;
check("W7: 翻页只读 —— offset=k 只换一个读窗（第二页读到剩下的行、预算照旧 ≤12），且这一次同样零写",
	pnPage2.status === 200 && pnReads2 === PN_ALL.length - 12 && pnRowsOf(pnPage2).filter((row) => pnRowHas(row, "verdict=")).length === PN_ALL.length - 12 && (await readFile(pnFile, "utf8")) === pnBytesBefore && (await stat(pnFile)).mtimeMs === pnMtimeBefore);
const pnBadPage = await pnCallOn(pnEnv, "?session=session-self&offset=999");
check("W7 边界: offset 越界 ⇒ 4xx + 可读的原因（面板会把它显示成「面板数据不可用」），而不是静默给一页空数据",
	pnBadPage.status === 400 && typeof pnBadPage.json?.error === "string");

// ---------------------------------------------------------------------------
// C 批评审修复轮（🟡#1–#2 · 🔵#3–#4）：**判据先写、实现后到** —— 本段在实现之前整段 FAIL，
// 红相读数见交付报告。判据名以评审号开头（🟡#n / 🔵#n），红绿两相读的是同一个名字。
// ---------------------------------------------------------------------------

// 🟡#2 翻页不回卷：「读更多」的语义必须是**当前页之后**。旧实现取「第一个未读行的序号」，
// 而第 0 行永远不在第二页的读窗里 ⇒ 第二页起 nextOffset 恒等于 0 ⇒ 唯一的翻页控件指回
// 第一页（13–24 个会话时两页循环；>24 个时第 25 行起在 UI 上不可达 —— 客户端没有手输 offset）。
// 夹具：36 个会话面行 ⇒ 三页（12 + 12 + 12），逐页读一遍；而且第二、三页里**仍有未读行**
// —— 这正是 🔵#3 的病灶面（分页那一页上「未读」句自称「前 12 行」与实况相反）。
const PN_PG_COUNT = 36;
const pnPgIds = Array.from({ length: PN_PG_COUNT }, (_, index) => "session-pg-" + String(index).padStart(2, "0"));
const pnPgEnv = pnSetup({
	sessions: pnPgIds.map((id, index) => ({ header: { id, createdAt: 2000 + index, cwd: PN_WS }, live: true, persisted: true })),
	eventsBySession: Object.fromEntries(pnPgIds.map((id) => [id, pnRecentEvents(id)])),
	extraAgents: pnPgIds.map((id) => ({ id, status: "idle", cwd: PN_WS })),
});
await waitForChain(pnPgEnv, 1);
const pnPgOf = (call) => (pnSeg(call.json, "sessions")?.page ?? null);
/** 本页**真的读过**的行（读窗内的行才有 verdict；窗口外的行显示为未读）。 */
const pnReadIdsOf = (call) => pnRowsOf(call).filter((row) => pnRowHas(row, "verdict=")).map((row) => row.id);
const pnUnreadLinesOf = (call) => pnRowsOf(call).filter((row) => pnRowHas(row, "未读")).flatMap((row) => row.lines.filter((line) => line.includes("未读")));
const pnPg1 = await pnCallOn(pnPgEnv, "?session=session-self");
const pnPg2 = await pnCallOn(pnPgEnv, "?session=session-self&offset=12");
const pnPg3 = await pnCallOn(pnPgEnv, "?session=session-self&offset=24");
const pnPgSeen = [...new Set([...pnReadIdsOf(pnPg1), ...pnReadIdsOf(pnPg2), ...pnReadIdsOf(pnPg3)])];
check("🟡#2 翻页不回卷: 三页 fixture（36 个会话面行）逐页声明的 nextOffset 一律**向前**（默认窗 → 12 → 24），末页为 null（按钮消失）—— 旧实现的「第一个未读行」在第二页起恒为 0（第 0 行不在本页读窗内）",
	pnPgOf(pnPg1)?.nextOffset === 12 && pnPgOf(pnPg2)?.nextOffset === 24 && pnPgOf(pnPg3)?.nextOffset === null
		&& pnPgOf(pnPg1)?.offset === 0 && pnPgOf(pnPg2)?.offset === 12 && pnPgOf(pnPg3)?.offset === 24);
// ★ 覆盖缺口（**补强于实现之后，无红相读数，如实标注**）：上面那条与下面这条都读 nextOffset，
// 但这一条走的是**客户端唯一那条翻页路径** —— 从第一页起只按 nextOffset 一路点下去（客户端
// 没有手输 offset 的口），于是「第 25 行起在 UI 上可达」这句话才是真的对上界面的。
const pnWalkOffsets = [];
const pnWalkReadIds = [...pnReadIdsOf(pnPg1)];
let pnWalkNext = pnPgOf(pnPg1)?.nextOffset ?? null;
while (pnWalkNext !== null && pnWalkOffsets.length < 6) {
	pnWalkOffsets.push(pnWalkNext);
	const pnWalkCall = await pnCallOn(pnPgEnv, "?session=session-self&offset=" + String(pnWalkNext));
	pnWalkReadIds.push(...pnReadIdsOf(pnWalkCall));
	pnWalkNext = pnPgOf(pnWalkCall)?.nextOffset ?? null;
}
const pnWalkUnique = [...new Set(pnWalkReadIds)];
check("🟡#2 第 25 行起可达（沿**按钮链**走，★ 无红相读数：补强于实现之后）: 从第一页起只按 nextOffset 走下去 ⇒ 恰好 12 → 24 → null（步数有界、次次严格前进、不自环），沿途读窗的并集正是全部 36 行 —— 旧实现第二步就回到 0（自环）⇒ 第 25 行起在 UI 上不可达",
	pnWalkOffsets.join(",") === "12,24" && pnWalkNext === null && pnWalkUnique.length === PN_PG_COUNT
		&& pnReadIdsOf(pnPg1).length === 12 && pnReadIdsOf(pnPg2).length === 12 && pnReadIdsOf(pnPg3).length === 12
		&& pnWalkUnique.every((id) => pnPgIds.includes(id)) && pnPgSeen.length === pnWalkUnique.length);
check("🟡#2 ★ 负相（控制项：两页 fixture 的末页也隐藏按钮）: 16 行那条老夹具（pnEnv）上第一页给 offset=12、第二页（上一段已取过的 pnPage2）nextOffset=null（末页不再指回任何一页）",
	pnSeg(pnCall.json, "sessions")?.page?.nextOffset === 12 && pnSeg(pnPage2.json, "sessions")?.page?.nextOffset === null);

// 🔵#3 降级句在分页路径上不准：「未读（本面板只读了前 12 行）」在 offset=12 那一页是**假话**
// （本次读的是 13–24 行）。分页那一页必须换中性措辞，点名**本次这一页**。
check("🔵#3 降级句随页走: 第一页的 24 行未读句仍是「只读了前 12 行」；第二页同样有 24 行未读（第 1–12 与第 25–36 行），但那句话点名**本次这一页**（本次只读了 12 行），不再自称前 12 行 —— 旧实现两页同一句，分页路径上那句话与实况相反",
	pnUnreadLinesOf(pnPg1).length === 24 && pnUnreadLinesOf(pnPg1).every((line) => line.includes("只读了前 12 行"))
		&& pnUnreadLinesOf(pnPg2).length === 24 && pnUnreadLinesOf(pnPg2).every((line) => line.includes("本次只读了") && !line.includes("只读了前 12 行")));

// 🔵#4 派生读数在多团队时失去归属：tasksDerivedLines() 的行原先被顺序拼进同一个数组，一个
// 团队名都不带（对照同一段里那三处 `- <team>/tasks.md：…` 头）⇒ 两支队伍的「最后主张 /
// 未消解存疑」在面板上分不出谁是谁。夹具：两支队伍、各自一份 tasks.md。
const PN_WS2 = path.join(PN_TMP, "ws2");
const PN_TEAM2 = "panel-team-2";
const pnTwoSeedDoc = policyDoc({ teams: [pnTeamRow, { ...pnTeamRow, name: PN_TEAM2, workspace: PN_WS2 }], pairs: pnSeedDoc.policy.pairs });
const pnTwoEnv = pnSetup({ policySeed: pnTwoSeedDoc });
await waitForChain(pnTwoEnv, 1);
const pnTasks2Path = path.join(PN_WS2, "team", PN_TEAM2, "tasks.md");
await mkdir(path.dirname(pnTasks2Path), { recursive: true });
await writeFile(pnTasks2Path, [
	"1 | 2026-09-26T21:10:02.123Z | session-lead | plan | t-1 | 另一队的事",
	"2 | 2026-09-26T21:12:44.001Z | session-wb | claim | t-1 | 接了",
	"3 | 2026-09-26T21:13:00.000Z | session-wb | done | t-1 | 收工",
].join("\n") + "\n", "utf8");
const pnTwoCall = await pnCallOn(pnTwoEnv, "?session=session-self");
const pnTwoDerived = pnSeg(pnTwoCall.json, "tasksTail")?.derived ?? [];
const pnAttrHead = (teamName) => "- " + teamName + "/tasks.md：";
const pnTwoReadOut = String(await pnTwoEnv.tool("team_link_team_read").execute({ team: PN_TEAM2 }, execFor(pnTwoEnv.senderAgent)));
check("🔵#4 派生行带团队归属: 多团队（两支）时每支队伍的派生块都以自己的「- <team>/tasks.md：」头开场（与同一段台账尾的三处头同形）—— 旧实现把两支队伍的派生行顺序拼进同一个数组、一个团队名都不带，面板上分不出谁是谁",
	pnTwoDerived.filter((line) => line.startsWith(pnAttrHead(PN_TEAM))).length === 1
		&& pnTwoDerived.filter((line) => line.startsWith(pnAttrHead(PN_TEAM2))).length === 1
		&& pnTwoDerived.filter((line) => line.includes("最后主张")).length >= 2);
/** 一支队伍在派生数组里的**整块**（归属头 + 其后的四空格续行；下一个归属头即块尾）。 */
const pnDerivedBlockOf = (derived, teamName) => {
	const head = pnAttrHead(teamName);
	const start = derived.findIndex((line) => line.startsWith(head));
	if (start === -1) return [];
	const block = [derived[start]];
	for (let index = start + 1; index < derived.length; index += 1) {
		if (derived[index].startsWith("- ")) break;
		block.push(derived[index]);
	}
	return block;
};
const pnTwoBlock = pnDerivedBlockOf(pnTwoDerived, PN_TEAM2);
check("🔵#4 归属头只是**面板加的那一层**: 第二队那一块的行体（归属头之后的每一行）逐字出现在**它自己**那份 team_read 输出里 —— 行体仍是宿主渲染器 renderTaskView 的字节，面板一个字节都没改写；且那一块确实带「最后主张」（不是空块）",
	pnTwoBlock.length >= 2 && pnTwoBlock.slice(1).some((line) => line.includes("最后主张"))
		&& pnTwoBlock.slice(1).every((line) => pnTwoReadOut.includes(pnDerivedBody(line))));

// ===========================================================================
// C 批 · C3（🔵 **登记 4 条 / 本批执行 3 条**，① 已在上一批修完；本段 = ②③④）：快路径归档留痕**条件化** · 「快路径 ＋ fold failed」
// 新夹具 · `setup()` 形参排版。归属：docs/policy-persistence-design-2026-09-27.md §8。
// ===========================================================================

// C3-b —— 「快路径 ＋ fold failed」：这一支**此前没有任何判据**（旧判据只覆盖晚挂路径）。
// 夹具：服务在 activation 就在场（快路径）＋ 命名空间为默认（文件那一份是唯一真值）
// ＋ `scope.update` 抛错 ⇒ 折叠必失败。旧实现在折叠**之前**就归档并留痕说「随后文件会被
// 改写成合并结果」，而链尾在 fold failed 时**根本不回写** ⇒ 那句承诺不兑现，还多出一份
// 冗余归档（无数据丢失，主文件原样保留）。现在归档挪到 `update()` 成功之后：没有折叠落定
// 就没有归档、也没有那句承诺。
const c3SeedFoldedAt = "2026-09-01T00:00:00.000Z";
const c3SeedDoc = policyDoc({ teams: [teamRow({ name: "c3-team" })] }, c3SeedFoldedAt);
const c3Env = setup({ sessions: [], useSettings: true, settingsUpdateThrows: true, selfCwd: TEAM_WS, policySeed: c3SeedDoc });
const c3File = path.join(c3Env.policyHome, "team-link", "policy.json");
const c3SeedBytes = await readFile(c3File, "utf8");
const c3Chain = await waitForChain(c3Env, 1);
const c3Lines = [...c3Env.log.lines.info, ...c3Env.log.lines.warn];
const c3Archives = readdirSync(path.join(c3Env.policyHome, "team-link")).filter((name) => name.indexOf("policy.superseded-") === 0);
let c3Doc = null;
try { c3Doc = JSON.parse(await readFile(c3File, "utf8")); } catch { c3Doc = null; }
check("C3-b 快路径 + fold failed（新夹具）: 折叠失败 ⇒ ① 文件里那份**逐字节不变**（窗口数据仍在落点里）② foldedAt 不重盖 ③ 留痕说得出是 fold failed（夹具真落在那一支）④ **归档数目与留痕一致，且两者都必须是 0** —— 没有折叠落定就没有归档、也没有那句留痕（旧实现会在折叠**之前**先归档一份并留下「折叠存档」那行）",
	c3Chain === 1 && c3Lines.some((line) => line.includes("memory window: fold failed")) && (await readFile(c3File, "utf8")) === c3SeedBytes && c3Doc !== null && c3Doc.foldedAt === c3SeedFoldedAt
		&& c3Archives.length === 0 && c3Lines.filter((line) => line.includes("折叠存档")).length === c3Archives.length);
check("C3-a 快路径归档留痕**条件化**: 没有折叠落定时**没有任何一行**承诺「随后文件会被改写成合并结果」（旧实现在折叠之前就打了那句，而这一支的回写被跳过 —— 承诺与实况相反）",
	!c3Lines.some((line) => line.includes("随后文件会被改写成合并结果")));
const c3OkEnv = setup({ sessions: [], useSettings: true, selfCwd: TEAM_WS, policySeed: c3SeedDoc });
await waitForChain(c3OkEnv, 1);
const c3OkLines = [...c3OkEnv.log.lines.info, ...c3OkEnv.log.lines.warn];
const c3OkArchives = readdirSync(path.join(c3OkEnv.policyHome, "team-link")).filter((name) => name.indexOf("policy.superseded-") === 0);
check("C3-a/b ★ 负相（控制项：不冒充）: 同一份种子、同一款夹具，`update` 不抛错时**照旧**归档并留下「折叠存档」那行（本轮只把它挪到 update 成功之后）—— 上面那条「零归档」拒的是「没折叠」，不是「这一段本来就不归档」",
	c3OkArchives.length === 1 && c3OkLines.some((line) => line.includes("折叠存档")) && c3OkLines.some((line) => line.includes("随后文件会被改写成合并结果")));

// C3-c —— `setup()` 形参排版（纯排版，行为一字不动）：判据取「签名区不是一整行 1900 字符」。
// 判据要读的是**本套件自己**的源码（`setup()` 住在这里，不在 lib/index.js）。
const c3TestSource = await readFile(fileURLToPath(new URL("./host-half.test.mjs", import.meta.url)), "utf8");
const c3HostLines = c3TestSource.split("\n");
const c3SetupStart = c3HostLines.findIndex((line) => line.indexOf("function setup({") === 0);
const c3SetupEnd = c3HostLines.findIndex((line, index) => index >= c3SetupStart && c3SetupStart !== -1 && line.indexOf("} = {}) {") !== -1);
const c3SetupSpan = c3SetupStart === -1 || c3SetupEnd === -1 ? [] : c3HostLines.slice(c3SetupStart, c3SetupEnd + 1);
check("C3-c `setup()` 形参排版: 签名不再压成一整行 —— 形参一行一个（签名区 ≥ 20 行、每行 ≤ 120 字符）",
	c3SetupSpan.length >= 20 && c3SetupSpan.every((line) => line.length <= 120));

// ===========================================================================
// C 批分歧审计修复轮（🔵#5）：收敛后的状态词在 `agent === null` 一格是**行为修正**，不是
// 静默漂移。收敛前那两份各写一份：列表工具写
// `running ? "▶ 运行中" : agent !== undefined ? "○ 空闲" : "✕ 未运行"` ⇒ `null` 走「○ 空闲」；
// 状态卡写 `agent === undefined ? "✕ 未运行" : agent.status === …` ⇒ 遇 `null` 直接抛。
// 收敛后两种「没有这个代理」都判「✕ 未运行」。判据读**真函数**（`__testing.agentStateLabel`，
// 不抄一份进测试），并把「行为修正」这句标记钉在 `agentStateLabel` 自己的源码块里 ——
// 否则它只是一句无法复核的散文。
// ===========================================================================
const agentStateAt = hostSource.indexOf("function agentStateLabel(agent) {");
const agentStateBlock = agentStateAt === -1
	? ""
	: hostSource.slice(hostSource.lastIndexOf("/**", agentStateAt), hostSource.indexOf("\n}", agentStateAt));
check("🔵#5 null 判据: 状态词对三种输入逐字 —— 已定义（running / idle）与 `undefined` 两档保持原样，`null` 一档 = 「✕ 未运行」（**行为修正**：旧列表工具那一档写「○ 空闲」、旧状态卡那一格会抛）；且「行为修正」这句标记就落在 `agentStateLabel` 自己的源码块里",
	typeof __testing.agentStateLabel === "function"
		&& __testing.agentStateLabel({ status: "running" }) === "▶ 运行中"
		&& __testing.agentStateLabel({ status: "idle" }) === "○ 空闲"
		&& __testing.agentStateLabel(undefined) === "✕ 未运行"
		&& __testing.agentStateLabel(null) === "✕ 未运行"
		&& agentStateBlock.includes("行为修正")
		&& agentStateBlock.includes("=== null"));

// ===========================================================================
// 批 1 · 团队自治与资源真值 —— FR-3 工作台 digest ＋ FR-7 attach 重挂
// 归属：docs/2026-10-09-team-autonomy-design.md §5（FR-3/FR-7）· §6（伪代码）·
// §7（origin/team 的加性 schema）· §8（U9–U12/U14/U15）。
//
// 本块自持的口径（设计档 §5.1 的状态机，逐条对照）：
//  · E1「刚转空闲」＝ 上一次巡逻读到 running、这一次不是（**迁移**，不需要目标说一个字）；
//  · E2「空闲待派」＝ 空闲 ∧ 手上无在飞任务（无 goal / paused / blocked / complete；
//    armed 的 active goal 是**自续跑**，属「在飞」⇒ 进不了本组，也不因它投递）；
//  · 「需处置」＝ TICKABLE_VERDICTS 三态（silent-idle / goal-disarmed / dead），**优先级最高**
//    —— 一个目标只进一个组（同一段正文里既「需处置」又「空闲待派」是自相矛盾）；
//  · 可行动内容 ＝ 空闲待派 ∪ 刚转空闲 ∪ 需处置 非空（「谁在跑」单独不构成打扰理由）；
//  · 同一注册两条摘要：间隔 ≥10min **且** 状态指纹有变化，否则零投递（U9「无事不许打扰」）。
//  · 投递面**只对 auto 注册**开放（origin:"auto"，即 /team_session 自动挂的那一条）：手工注册的
//    既有行为逐字不变（consult #26 D3「手工 register 的 watchIdle 默认值 = false（既有行为逐字不变）」），
//    它仍走原来那条告警通道。
// ===========================================================================

/** 一条 auto 注册行（§7.1 的形状：origin 与 team 是 auto 那一档的两个标记）。 */
const wbRow = ({ id = "wd-auto-0001", team = "wb-team", watcherSession = "session-self", targets = [], silentMinutes = 10, intervalMinutes = 10, createdAt = 1_700_000_000_000, expiresAt = 1_700_000_000_000 + 12 * 3600000, origin = "auto" } = {}) =>
	({ id, team, watcherSession, targets, silentMinutes, intervalMinutes, createdAt, expiresAt, origin });
/** 两条通道的取数器：告警 tick 以 `[watchdog]` 开场，工作台摘要以 `[workbench]` 开场。 */
const alarmsOf = (env) => env.senderCalls.followedup.filter((message) => message.content[0].text.startsWith("[watchdog]"));
const digestOf = (env) => env.senderCalls.followedup.filter((message) => message.content[0].text.startsWith("[workbench]"));
const textOfFirst = (list) => (at(list, 0) === undefined ? "" : at(list, 0).content[0].text);
const pausedGoal = { phase: "paused", activation: "disarmed", roundsStarted: 3, maxGoalRounds: 70 };

// --- FR-3a / U11: /team_session 建队成功处自动注册一条覆盖全队的看门狗 --------------
const wbEnv = teamSessionEnv({ askScript: ["创建", "创建"] });
const wbOut = await wbEnv.run("n=2 team=wb-team roles=worker-a,worker-b task=做接口");
const wbNs = wbEnv.settings.namespaces.get("team-link").data;
const wbAutoRows = () => (wbNs.watchdogs ?? []).filter((entry) => entry.origin === "auto");
const wbWorkerIds = wbEnv.creates.map((entry) => entry.sessionId);
check("U11 auto 注册: 建队成功处自动挂**一条**覆盖全队的看门狗 —— origin=auto / team=团队名 / 观察者=调用者 / targets 覆盖全队成员（两个新建 worker 都在，且不含观察者自己）",
	wbAutoRows().length === 1 && wbAutoRows()[0].team === "wb-team" && wbAutoRows()[0].watcherSession === "session-self"
		&& wbWorkerIds.length === 2 && wbWorkerIds.every((id) => wbAutoRows()[0].targets.includes(id)) && !wbAutoRows()[0].targets.includes("session-self"));
check("U11 auto 注册: 完成回报如实点名这条注册（id ＋「自动注册」＋ 不占手工额度的口径），读者不必去翻 settings",
	wbOut.kind === "success" && wbOut.text.includes("工作台") && wbOut.text.includes(wbOut.text.match(/wd-[0-9a-f-]{36}/u)?.[0] ?? "（没有 id）") && wbOut.text.includes("自动注册") && wbOut.text.includes("不占手工额度"));
const wbAutoId = wbAutoRows()[0]?.id ?? "";
const wbSecond = await wbEnv.run("n=2 team=wb-team roles=worker-a,worker-b task=再来一次");
check("U11 auto 注册: 同一个 (观察者, 团队) 再建一次 ⇒ **顺延/更新同一条**（不按次累积：一条注册覆盖全队，而不是每次建队多一条；TTL 顺延）",
	wbSecond.kind === "success" && wbAutoRows().length === 1 && wbAutoRows()[0].id === wbAutoId && wbAutoRows()[0].expiresAt >= (wbAutoRows()[0].createdAt ?? 0));
const wbWatchTool = wbEnv.tool("team_link_watch");
const wbManualReg = () => wbWatchTool.execute({ action: "register", targets: ["session-target"] }, execFor(wbEnv.senderAgent));
const wbM1 = await wbManualReg();
const wbM2 = await wbManualReg();
const wbM3 = await wbManualReg();
check("U11 额度: auto 那条**不占**手工 3 条额度 —— auto 在场时手工第 3 条仍被接受（修复前：额度把 auto 一起数进去 ⇒ 手工第 3 条就被拒）",
	[wbM1, wbM2, wbM3].every((out) => out.includes("已注册看门狗")) && (wbNs.watchdogs ?? []).length === 4 && wbAutoRows().length === 1);
const wbM4 = await wbManualReg();
check("U11 额度: 手工第 4 条才被拒 —— 额度数的是**手工**那几条（拒绝文案仍点名这个上限：最多 3 个）",
	wbM4.includes("最多 3 个") && (wbNs.watchdogs ?? []).length === 4 && wbAutoRows().length === 1);

// --- U9（负相）：全队都没有可行动内容 ⇒ 零投递 ------------------------------------
const wbQuietEnv = watchdogEnv({
	targets: {
		"session-busy": { events: oneShotSurface(WD_NOW - 60_000), status: "running" },
		"session-armed": { events: oneShotSurface(WD_NOW - 60_000) },
	},
	goals: { "session-armed": armedGoal() },
	watchdogs: [wbRow({ id: "wd-auto-quiet", targets: ["session-busy", "session-armed"] })],
});
await wbQuietEnv.watchdog.patrol({ now: WD_NOW });
check("U9 无事不打扰: 全队都没有可行动内容（一个在跑、一个 armed 自续跑）⇒ **零投递**（告警通道与工作台通道都是一条不投）",
	wbQuietEnv.senderCalls.followedup.length === 0);

// --- U9（正相）/ U10（两半）：分组摘要 ＋ 忙时照投 ＋ 告警抑制原样 -----------------
const wbRunTargets = {
	"session-silent": { events: oneShotSurface(1) },
	"session-free": { events: oneShotSurface(WD_NOW - 120_000) },
	"session-busy": { events: oneShotSurface(WD_NOW - 60_000), status: "running" },
};
const wbRunEnv = watchdogEnv({
	targets: wbRunTargets,
	selfStatus: "running",
	watchdogs: [wbRow({ id: "wd-auto-run", targets: ["session-silent", "session-free", "session-busy"] })],
});
await wbRunEnv.watchdog.patrol({ now: WD_NOW });
const wbRunDigest = at(digestOf(wbRunEnv), 0);
const wbRunText = textOfFirst(digestOf(wbRunEnv));
check("U9 有可行动内容就投（正相）: 一条摘要同时给出三组与各自的 id（分组摘要，不是每个目标一条）—— 运行中 / 空闲待派（带静默读数）/ 需处置（带 verdict）",
	wbRunText.startsWith("[workbench] 团队 wb-team 工作台（读数 ") && wbRunText.includes("运行中：session-busy")
		&& wbRunText.includes("空闲待派：session-free（静默 2.0min）") && wbRunText.includes("需处置：session-silent（verdict=silent-idle 静默 "));
check("U10 半 1（D-A1 准）: 观察者 **running** 时工作台摘要**照投**（修复前：整个 patrol 在观察者门后直接 return ⇒ 忙时零信号，而「它一边实施一边收不到提醒」正是事故根因）",
	wbRunDigest !== undefined && wbRunDigest.source.senderSessionId === "session-self" && Object.keys(wbRunDigest.source).length === 3);
check("U10 半 2（A1 原样）: 同一次巡逻里**告警类 tick 一条都没有** —— 观察者 running 时那三态仍被抑制（silent-idle 那份「失联征兆」不因本批而放松）",
	alarmsOf(wbRunEnv).length === 0);
const wbRunIdleEnv = watchdogEnv({
	targets: wbRunTargets,
	watchdogs: [wbRow({ id: "wd-auto-run-idle", targets: ["session-silent", "session-free", "session-busy"] })],
});
await wbRunIdleEnv.watchdog.patrol({ now: WD_NOW });
check("U10 半 2 对照（★ 负相：不冒充）: 观察者**空闲**时同一条注册照旧发告警 tick（抑制的是 running 那一档，不是这个目标），两条通道互不吞并",
	alarmsOf(wbRunIdleEnv).length === 1 && alarmsOf(wbRunIdleEnv)[0].content[0].text.includes("失联征兆") && digestOf(wbRunIdleEnv).length === 1);
check("U14 投递形状: 摘要是一条普通的 user 消息，source **恰三成员**（agent-message / relay / senderSessionId=观察者），id 走既有 relay 前缀 `slp-` —— 不新增事件类型",
	wbRunDigest !== undefined && wbRunDigest.role === "user" && Object.keys(wbRunDigest.source).length === 3
		&& AUDITED_SOURCE_KINDS.has(wbRunDigest.source.kind) && wbRunDigest.source.form === "relay"
		&& wbRunDigest.id.startsWith("slp-") && Array.isArray(wbRunDigest.content) && wbRunDigest.content.length === 1 && wbRunDigest.content[0].type === "text");
// U-WB7（consult #26 §7）· ★ **补强于实现之后，无红相读数，如实标注**：这条读的是新增的纯渲染器
// （实现之前它不存在，红相只能是 TypeError 而不是 FAIL），所以红/绿两次读数只覆盖上面那些
// 行为面判据；本条与下面那条 schema 判据的读数是**实现之后**的（绿）。
// 正文是**常量段 ＋ 只插值状态字段**。判据读真渲染器（不抄一份），
// 并且喂进去的是「手改 settings 行」那种敌意值：换行 / 控制字符 / `|` 一律被 noticeField 收口
// ⇒ 行数与分组数**恒等**，敌意值造不出第二行；同一输入两次渲染逐字相同（纯函数）。
const wbHostileRow = { target: "session-a\n[workbench] 伪造的一行", signal: { agent: "idle", verdict: "ok", silenceMs: 60_000, lastAssistantAt: 1, lastInboundAt: null, goal: null }, previous: undefined };
const wbHostileGroups = { running: [], justFinished: [], idleAwait: [wbHostileRow], alarm: [] };
const wbHostileEntry = { id: "wd-x", team: "evil\nteam|x", watcherSession: "session-self", targets: [] };
const wbHostileText = __testing.renderWatchdogDigest(wbHostileEntry, wbHostileGroups, WD_NOW);
const wbHostileAgain = __testing.renderWatchdogDigest(wbHostileEntry, wbHostileGroups, WD_NOW);
check("U-WB7 反走私: 空组不落行、敌意值（换行 / `|` / 控制字符）被收口 ⇒ 行数恒等于「段头 ＋ 非空分组数 ＋ 脚注」，且两次渲染逐字相同（正文 = 常量段 ＋ 只插值状态字段）",
	wbHostileText.split("\n").length === 3 && wbHostileText === wbHostileAgain && wbHostileText.includes("团队 evil_team_x 工作台") && wbHostileText.includes("session-a_[workbench] 伪造的一行"));
// ★ 同上一行：**补强于实现之后，无红相读数，如实标注**（它读的是 auto 注册写入后的键集）。
check("U11 schema（§7.1 既有键的加性扩展）: auto 注册**没有新增任何顶层 policy 键** —— 它就是既有 `watchdogs` 数组里的一行，新增的只是这一行的 `origin` 字段（归一化缺省 = manual）",
	sameJson(Object.keys(wbEnv.settings.namespaces.get("team-link").base).sort(), ["blockedSenders", "pairs", "pendingCreates", "receiveMode", "rememberTargets", "sections", "teams", "trustedSenders", "watchdogs"]) && wbAutoRows().length === 1);

// --- E1「刚转空闲」：running → 空闲的迁移 ------------------------------------------
const wbFinishEnv = watchdogEnv({
	targets: { "session-worker": { events: oneShotSurface(WD_NOW - 120_000), status: "running" } },
	watchdogs: [wbRow({ id: "wd-auto-finish", targets: ["session-worker"] })],
});
await wbFinishEnv.watchdog.patrol({ now: WD_NOW });
check("E1 前置: 目标正在跑的那一次巡逻不投摘要（「运行中」单独不构成可行动内容 —— 这是 U9 的另一半）",
	wbFinishEnv.senderCalls.followedup.length === 0);
wbFinishEnv.agentFor("session-worker").status = "idle";
await wbFinishEnv.watchdog.patrol({ now: WD_NOW + 60_000 });
const wbFinishText = textOfFirst(digestOf(wbFinishEnv));
check("E1 刚转空闲: running → 空闲的**迁移**进「刚转空闲」组（谁刚干完，不需要目标自己说一句话）",
	digestOf(wbFinishEnv).length === 1 && wbFinishText.includes("刚转空闲：session-worker"));
check("E1 文案分离（US-A5）: 这一条摘要**不含**「失联」二字，也不把刚干完的目标塞进「需处置」—— 空闲待派与失联是两种话",
	wbFinishText !== "" && !wbFinishText.includes("失联") && !wbFinishText.includes("需处置"));

// --- E2「空闲待派」＋ 在飞（armed 自续跑）的对照 -----------------------------------
const wbAwaitEnv = watchdogEnv({
	targets: {
		"session-idle": { events: oneShotSurface(WD_NOW - 120_000) },
		"session-busy": { events: oneShotSurface(WD_NOW - 60_000), status: "running" },
		"session-armed": { events: oneShotSurface(WD_NOW - 60_000) },
	},
	goals: { "session-armed": armedGoal() },
	watchdogs: [wbRow({ id: "wd-auto-await", targets: ["session-idle", "session-busy", "session-armed"] })],
});
await wbAwaitEnv.watchdog.patrol({ now: WD_NOW });
const wbAwaitText = textOfFirst(digestOf(wbAwaitEnv));
check("E2 空闲待派: 空闲且手上无在飞任务 ⇒ 进「空闲待派」组并附静默读数（首次巡逻没有上一轮读数 ⇒ 不算迁移，但「有人闲着」本身就是可行动内容）",
	digestOf(wbAwaitEnv).length === 1 && wbAwaitText.includes("空闲待派：session-idle（静默 2.0min）") && wbAwaitText.includes("运行中：session-busy"));
check("E2 对照（在飞 = armed 自续跑）: armed 的 active goal 是它自己的在飞工作 ⇒ 不进任何组、也不因它投递（「别催」那一档）",
	wbAwaitText !== "" && !wbAwaitText.includes("session-armed"));

// --- 去抖：同一注册 ≥10min 且状态指纹变了才再打扰 --------------------------------
const wbDebounceEnv = watchdogEnv({
	targets: {
		"session-paused": { events: oneShotSurface(WD_NOW - 180_000) },
		"session-paused-2": { events: oneShotSurface(WD_NOW - 240_000) },
	},
	goals: { "session-paused": pausedGoal, "session-paused-2": pausedGoal },
	watchdogs: [wbRow({ id: "wd-auto-debounce", targets: ["session-paused", "session-paused-2"] })],
});
await wbDebounceEnv.watchdog.patrol({ now: WD_NOW });
check("去抖（首投）: paused（已解释过的沉默）也算「空闲待派」—— 空闲且无在飞任务，正是这两个条件",
	digestOf(wbDebounceEnv).length === 1 && textOfFirst(digestOf(wbDebounceEnv)).includes("空闲待派：session-paused（静默 3.0min）、session-paused-2（静默 4.0min）"));
await wbDebounceEnv.watchdog.patrol({ now: WD_NOW + 60_000 });
check("去抖: 10min 窗口内不重复投递", digestOf(wbDebounceEnv).length === 1);
await wbDebounceEnv.watchdog.patrol({ now: WD_NOW + 11 * 60_000 });
check("去抖: 过了 10min 而**状态指纹一字未变** ⇒ 仍然零投递（「无事不许打扰」：把时间窗当许可，会把一条常驻的「有人闲着」变成每 10 分钟一次的打扰）",
	digestOf(wbDebounceEnv).length === 1);
wbDebounceEnv.agentFor("session-paused-2").status = "running";
await wbDebounceEnv.watchdog.patrol({ now: WD_NOW + 12 * 60_000 });
const wbChurnText = textOfFirst(digestOf(wbDebounceEnv).slice(1));
check("去抖对照（★ 负相：不冒充）: 状态指纹真的变了（一个成员转回运行中）且 ≥10min 已过 ⇒ 新的一条，且分组跟着变",
	digestOf(wbDebounceEnv).length === 2 && wbChurnText.includes("运行中：session-paused-2") && wbChurnText.includes("空闲待派：session-paused（静默 15.0min）"));

// --- 投递面 = auto 那一档：手工注册的既有行为逐字不变 ------------------------------
const wbManualEnv = watchdogEnv({
	targets: { "session-silent": { events: oneShotSurface(1) }, "session-free": { events: oneShotSurface(WD_NOW - 120_000) } },
	watchdogs: [wbRow({ id: "wd-manual-0001", origin: "manual", targets: ["session-silent", "session-free"] })],
});
await wbManualEnv.watchdog.patrol({ now: WD_NOW });
check("投递面 = auto 那一档（consult #26 D3「手工 register 的 watchIdle 默认值 = false（既有行为逐字不变）」）: 手工注册照旧只发告警 tick、**不发**工作台摘要",
	alarmsOf(wbManualEnv).length === 1 && digestOf(wbManualEnv).length === 0);
check("投递面（对照）: 同一款 fixture、同一个目标集合，仅把 origin 换成 auto ⇒ 摘要就出现了（上一句拒的是**投递面**，不是「这个状态本来就不投」）",
	digestOf(wbAwaitEnv).length >= 1 && alarmsOf(wbAwaitEnv).length === 0);

// --- FR-7（U12）: attach 重挂 -----------------------------------------------------
// ★ t-8 复验 🟡（task-9 C）：`expiresAt` 必须相对**真实墙钟** —— 旧夹具用的是 2023-11-15 的常量，
// 按真实时间早已过期，它们拿到定时器靠的是「全过期 ⇒ 留一个清扫专用定时器」那条兜底支
// （复验者实测：只删兜底 ⇒ 8 红）。改成 now+12h 之后，这些行走的是**活的**那一支，兜底支不再替它们背书。
const wbRearmRow = (id) => wbRow({ id, team: "wb-rearm", targets: ["session-target"], createdAt: Date.now(), expiresAt: Date.now() + 12 * 3600_000 });
// 红相机制 1（晚挂）：activation 时既没有服务、也没有文件 ⇒ apply 那一刻注册表不可读。
const wbRearmLateRow = wbRearmRow("wd-rearm-late");
const wbRearmLateEnv = setup({ sessions: [], lateSettings: true, selfCwd: TEAM_WS, settingsSeed: { "team-link": { watchdogs: [wbRearmLateRow] } } });
const wbRearmLateW = __testing.watchdogFor(wbRearmLateEnv.ctx);
check("U12 重挂（窗口）: 晚挂部署里 activation 那一刻**零定时器** —— 服务不在场、文件也不在场，`policy.watchdogs` 是空的（这就是「重启后是哑的」那个窗口）",
	wbRearmLateW !== undefined && wbRearmLateW.timers.size === 0);
await wbRearmLateEnv.provideSettings();
await waitForChain(wbRearmLateEnv, 1);
check("U12 重挂（正相）: 服务挂上之后，`policy.watchdogs` 的**每一项都有定时器**（修复前：整条持久化注册在进程里永远不会被巡逻 —— 巡检定时器只在注册工具那一处挂过）",
	wbRearmLateW.timers.size === 1 && wbRearmLateW.timers.has(wbRearmLateRow.id));
// 红相机制 2（快路径折叠）：服务在 activation 就在场且为默认，注册表在**文件**里 —— 折叠是异步的，
// 所以 apply 那一刻读到的命名空间还是默认值，重挂只能挂在链尾。
const wbRearmFoldRow = wbRearmRow("wd-rearm-fold");
const wbRearmFoldEnv = setup({ sessions: [], useSettings: true, selfCwd: TEAM_WS, policySeed: policyDoc({ watchdogs: [wbRearmFoldRow] }), settingsUpdateDelayMs: 5 });
await waitForChain(wbRearmFoldEnv, 1);
check("U12 重挂（快路径折叠）: 文件里那条注册在折叠落定之后也有定时器（修复前：activation 时读到的命名空间还是默认值 ⇒ 折叠进来的注册没有定时器）",
	__testing.watchdogFor(wbRearmFoldEnv.ctx).timers.has(wbRearmFoldRow.id));
// 对照（改前改后都应为绿）：文件后端重启 —— activation 时文件已经读进内存，`start()` 直接挂得上。
const wbRearmFileRow = wbRearmRow("wd-rearm-file");
const wbRearmFileEnv = setup({ sessions: [], selfCwd: TEAM_WS, policySeed: policyDoc({ watchdogs: [wbRearmFileRow] }) });
check("U12 对照（★ 负相：不冒充）: 文件后端重启时 activation 那次 `start()` 本来就挂得上 —— 这证明上面两条红的不是「重挂」整件事，而是**晚读窗口**（服务晚挂 / 折叠在飞）",
	__testing.watchdogFor(wbRearmFileEnv.ctx).timers.has(wbRearmFileRow.id));

// --- U15: 红线（零新硬依赖 / 零新写入面） -----------------------------------------
const wbInject = (await import("./lib/index.js")).inject;
const wbGateAt = hostSource.indexOf("function writerGate(");
const wbGateBlock = wbGateAt === -1 ? "" : hostSource.slice(wbGateAt, hostSource.indexOf("\n}", wbGateAt));
check("U15 红线: 模块级 inject 恒 4 项；writerGate / retireGate / rotateGate 的函数元数一字未动；writerGate 的函数体里零命中本批新增的任何标识符（函数体是否逐字节不变由 `git diff lib/index.js` 复核）",
	JSON.stringify(wbInject) === JSON.stringify(["sessionReferenceResolver", "tools", "sessionQuery", "agents"])
		&& __testing.writerGate.length === 2 && __testing.retireGate.length === 2 && __testing.rotateGate.length === 3
		&& wbGateBlock.length > 0 && !/watchdog|digest|origin|工作台/u.test(wbGateBlock));

// ===========================================================================
// 有界修复轮（task-3）· 评审 #2–#7 + 验证者 🟡2/🟡3/🔵5/🔵7
// 归属：批 1 交付评审与独立验证的修复单；口径与上面批 1 的块完全一致。
// A 项（并发安全临时目录）落在文件头上（TEST_ROOT）与 setup()/teardown 里；
// 本段是 B/C/E/G 的**覆盖补强**与 F 的新判据。
// ★ 性质如实标注：B/C/E/G 补的是**批 1 已经实现、但此前没有判据**的行为 —— 它们**没有独立的
// 红相读数**（实现之前它们连读面都没有）；本轮的红/绿两次读数落在 F（新判据：变异取红）与
// D（U-WB7 / U11 schema 两条历史判据的变异自证）上。
// ===========================================================================

// --- B（评审 #3）: 手工 3 条满额之后再建队 ⇒ auto 行照写、回报成功 -------------------
const wbCapEnv = teamSessionEnv({ askScript: ["创建"] });
const wbCapWatch = wbCapEnv.tool("team_link_watch");
const wbCapRegs = [];
for (let index = 0; index < 3; index += 1) wbCapRegs.push(await wbCapWatch.execute({ action: "register", targets: ["session-target"] }, execFor(wbCapEnv.senderAgent)));
const wbCapOut = await wbCapEnv.run("n=1 team=wb-cap roles=worker-a task=满额之后再建队");
const wbCapAuto = (wbCapEnv.settings.namespaces.get("team-link").data.watchdogs ?? []).filter((entry) => entry.origin === "auto");
check("B 额度边界（评审 #3）: 手工 3 条已满额时建队 —— auto 注册**照写**（额度只数手工那几条），回报仍是成功且点名它（锁住「将来给 auto 路径加额度检查」这条回归：那种改动会让这条断言红）",
	wbCapRegs.every((out) => out.includes("已注册看门狗")) && wbCapOut.kind === "success" && wbCapAuto.length === 1
		&& wbCapOut.text.includes("工作台（FR-3a）：已自动注册看门狗") && wbCapOut.text.includes(wbCapAuto[0].id));

// --- C（评审 #4）: 顺延断言收紧为**严格变大** -------------------------------------
const wbTtlEnv = teamSessionEnv({ askScript: ["创建", "创建"] });
const wbTtlRow = () => (wbTtlEnv.settings.namespaces.get("team-link").data.watchdogs ?? []).filter((entry) => entry.origin === "auto")[0];
// 第二次必须**真的再建一个会话**才会走到 arming（全部已登记的那条「无需创建」早退支不重挂 ——
// 见交付报告 §三.6 的边界登记），所以第一次 worker-a、第二次 worker-b。
await wbTtlEnv.run("n=1 team=wb-ttl roles=worker-a task=第一次");
const wbTtlId = wbTtlRow()?.id;
const wbTtlBefore = wbTtlRow()?.expiresAt;
const wbTtlSecond = await wbTtlEnv.run("n=1 team=wb-ttl roles=worker-b task=第二次");
check("C 顺延（评审 #4）: 第二次建队把同一条 auto 注册的 TTL **严格顺延**（expiresAt 变大、id 不变）—— 旧断言 `expiresAt >= createdAt` 对任何一行都恒真，锁不住顺延",
	wbTtlSecond.kind === "success" && wbTtlRow() !== undefined && wbTtlRow().id === wbTtlId && typeof wbTtlBefore === "number" && wbTtlRow().expiresAt > wbTtlBefore);
// 对照（确定性，注入时钟）：纯规划器同一行、now 前进 1ms ⇒ expiresAt 恰好多 1ms。
const wbTtlPlan1 = __testing.planAutoWatchdog([], { watcherSession: "session-self", team: "wb-ttl", targets: ["session-a"], now: 1_000_000 });
const wbTtlPlan2 = __testing.planAutoWatchdog([wbTtlPlan1.entry], { watcherSession: "session-self", team: "wb-ttl", targets: ["session-a"], now: 1_000_001 });
check("C 顺延（对照 · 注入时钟）: 规划器把「创建」与「顺延」分得开 —— created 标志翻转、id 逐字不变、expiresAt 恰好多 1ms（这条不依赖墙钟）",
	wbTtlPlan1.created === true && wbTtlPlan2.created === false && wbTtlPlan2.entry.id === wbTtlPlan1.entry.id && wbTtlPlan2.entry.expiresAt === wbTtlPlan1.entry.expiresAt + 1 && wbTtlPlan2.entry.origin === "auto");

// --- E①（task-5 B：改成**有判别力**的断言）: 失败 ⇒ 一行 warn、当次不重试、下个窗口重投 ---
//
// ★ 缺陷与修法（t-4 复验 🟡1）：旧夹具的目标在「失败」与「重投」两趟之间换了组
// （idleAwait → alarm，因为静默跨过了阈值），指纹本来就变了 ⇒ 即便失败分支
// **把签名当成功记住**，重投也照样发生 —— 断言对着它声称的机制没有判别力
// （复验者的判别实验：那条变异下旧断言照旧全绿）。
//
// 现在两处同时钉住：
//   ① 夹具换成**指纹稳定**的目标（paused goal ⇒ 恒「空闲待派」；指纹只由分组 id 组成，
//      静默时长不进指纹）⇒ 重投只可能来自「失败那一支没有记签名」；
//   ② 直接读失败后那条记录的签名位（`digested.get(id).signature === null`）。
// 变异红相（把失败分支改成 `{ at: now, signature }`）见交付报告：①②会红，第三条（成功路径
// 对照）也会红 —— 那一步**根本没投出去**，它的前提已不成立。它的反向变异是「成功分支不记
// 签名」（那时 +22min 那趟会多投一条 ⇒ 本条红）。两条路的分野落在签名位上。
const wbFailEnv = watchdogEnv({
	targets: { "session-paused": { events: oneShotSurface(WD_NOW - 120_000) } },
	goals: { "session-paused": pausedGoal },
	watchdogs: [wbRow({ id: "wd-auto-fail", targets: ["session-paused"] })],
});
const wbFailOriginal = wbFailEnv.senderAgent.followup;
wbFailEnv.senderAgent.followup = () => { throw new Error("boom: followup refused"); };
await wbFailEnv.watchdog.patrol({ now: WD_NOW });
check("E① 投递失败（task-5 B）: 失败当场留一行 warn、不冒泡成 patrol 失败，且**没有把这次状态记成「已投」**（签名位空着 —— 这是下一趟能重投的唯一来源）",
	wbFailEnv.log.lines.warn.some((line) => line.includes("watchdog digest to session-self failed") && line.includes("boom: followup refused"))
		&& digestOf(wbFailEnv).length === 0 && wbFailEnv.watchdog.digested.get("wd-auto-fail")?.signature === null);
await wbFailEnv.watchdog.patrol({ now: WD_NOW + 60_000 });
check("E① 当次不重试: 同一去抖窗口内的下一次巡逻**不再重投**（失败不变成每个巡逻窗口一条 warn 的风暴）",
	digestOf(wbFailEnv).length === 0 && wbFailEnv.log.lines.warn.filter((line) => line.includes("watchdog digest to session-self failed")).length === 1);
wbFailEnv.senderAgent.followup = wbFailOriginal;
await wbFailEnv.watchdog.patrol({ now: WD_NOW + 11 * 60_000 });
check("E① 下一窗口重投（★ 有判别力：两趟分组逐字相同）: 过了去抖窗之后真的重投 —— 若失败分支改成「记住签名」，这一条必红；到这一刻目标仍恒为「空闲待派」（不换组）",
	digestOf(wbFailEnv).length === 1 && textOfFirst(digestOf(wbFailEnv)).includes("空闲待派：session-paused（静默 13.0min）"));
// 对照（成功路径）：成功那一次**会**把签名记下来 ⇒ 之后同样的状态（≥10min 已过）零重投。
// 它锁的是「成功 = 不重复」那半边（反向变异＝成功分支不记签名 ⇒ +22min 那趟多投一条 ⇒ 本条红）。
await wbFailEnv.watchdog.patrol({ now: WD_NOW + 22 * 60_000 });
check("E① 对照（成功路径）: 成功投递把签名记住了 ⇒ 同样的状态再过 10min 也零重投（与失败路径的分野就落在签名位上）",
	digestOf(wbFailEnv).length === 1 && wbFailEnv.watchdog.digested.get("wd-auto-fail")?.signature !== null);

// --- E②（评审 #6）: 「无在飞任务」的 blocked / complete 两档 -----------------------
const wbGoalRow = (phase, goal) => ({ target: `session-${phase}`, previous: undefined, signal: { agent: "idle", verdict: "ok", silenceMs: 60_000, lastAssistantAt: 1, lastInboundAt: null, goal } });
const wbGoalGroups = __testing.classifyWatchdogTargets([
	wbGoalRow("blocked", { phase: "blocked", activation: "disarmed", rounds: "1/70", blockedReason: null }),
	wbGoalRow("complete", { phase: "complete", activation: "disarmed", rounds: "2/70", blockedReason: null }),
	wbGoalRow("paused", { phase: "paused", activation: "disarmed", rounds: "3/70", blockedReason: null }),
	wbGoalRow("none", null),
	wbGoalRow("active", { phase: "active", activation: "armed", rounds: "4/70", blockedReason: null }),
]);
check("E②（评审 #6）: 「无在飞任务」= 无 goal 或非 active —— blocked / complete / paused / 无 goal 四档都进「空闲待派」（批 1 的 E2 夹具当时只钉了 paused 一档）",
	wbGoalGroups.idleAwait.map((row) => row.target).join(",") === "session-blocked,session-complete,session-paused,session-none" && wbGoalGroups.alarm.length === 0);
check("E② 对照（在飞 = armed 自续跑）: active 那一行**不进任何组**（它有自己的节奏，别催）",
	["running", "justFinished", "idleAwait", "alarm"].every((key) => !wbGoalGroups[key].some((row) => row.target === "session-active")));

// --- E③（评审 #6）: 观察者 running 时 E1 迁移仍执行 --------------------------------
const wbE1Key = "wd-auto-e1run\nsession-worker";
const wbE1Env = watchdogEnv({ targets: { "session-worker": { events: oneShotSurface(WD_NOW - 120_000), status: "running" } }, selfStatus: "running", watchdogs: [wbRow({ id: "wd-auto-e1run", targets: ["session-worker"] })] });
await wbE1Env.watchdog.patrol({ now: WD_NOW });
check("E③ 前置（评审 #6）: 观察者 running 的那一次巡逻也把 agent 状态记进 lastAgentState（忙时那一帧不记，迁移就永远丢帧）",
	wbE1Env.watchdog.lastAgentState.get(wbE1Key) === "running" && digestOf(wbE1Env).length === 0);
wbE1Env.agentFor("session-worker").status = "idle";
await wbE1Env.watchdog.patrol({ now: WD_NOW + 60_000 });
check("E③ 观察者 running 时 E1 迁移仍执行: 迁移照样进「刚转空闲」且摘要照投，watermark 跟着更新（readTargetRows + rememberAgentStates 不吃观察者门）",
	digestOf(wbE1Env).length === 1 && textOfFirst(digestOf(wbE1Env)).includes("刚转空闲：session-worker") && wbE1Env.watchdog.lastAgentState.get(wbE1Key) === "idle");

// --- E④（验证者 🟡2）: 观察者 **armed-active** 时摘要照投、告警 0 条 -----------------
const wbArmedEnv = watchdogEnv({
	targets: { "session-silent": { events: oneShotSurface(1) }, "session-free": { events: oneShotSurface(WD_NOW - 120_000) } },
	selfGoal: armedGoal(),
	watchdogs: [wbRow({ id: "wd-auto-armed", targets: ["session-silent", "session-free"] })],
});
await wbArmedEnv.watchdog.patrol({ now: WD_NOW });
check("E④ 观察者 armed-active（验证者 🟡2）: 摘要**照投**（D-A1 的另一半 —— 不只是 running 那一档），同一趟**告警 0 条**（A1 抑制原样）",
	digestOf(wbArmedEnv).length === 1 && alarmsOf(wbArmedEnv).length === 0 && textOfFirst(digestOf(wbArmedEnv)).includes("需处置：session-silent"));

// --- F（评审 #7 🔵）: patrol 驱动的换届清扫去抖（<1min 跳过） -----------------------
const wbSweepEnv = watchdogEnv({ targets: { "session-free": { events: oneShotSurface(WD_NOW - 120_000) } }, watchdogs: [wbRow({ id: "wd-auto-sweep", targets: ["session-free"] })] });
const wbSweepRotation = __testing.rotationFor(wbSweepEnv.ctx);
const wbSweepCalls = [];
const wbSweepOriginal = wbSweepRotation.sweep;
wbSweepRotation.sweep = async () => { wbSweepCalls.push(1); return { lines: [] }; };
await wbSweepEnv.watchdog.patrol({ now: WD_NOW });
check("F 清扫去抖（评审 #7）: 第一次 patrol 照跑清扫（去抖不是「不跑」—— 它必须真的清过一次）", wbSweepCalls.length === 1);
await wbSweepEnv.watchdog.patrol({ now: WD_NOW + 30_000 });
check("F 清扫去抖: 30s 之后的同一条注册巡逻**不再重复清扫**（FR-7 之后 N 条注册 = N 个定时器 ⇒ 去抖把 N 次冗余压回 1 次）", wbSweepCalls.length === 1);
await wbSweepEnv.watchdog.patrol({ now: WD_NOW + 90_000 });
check("F 清扫去抖对照（★ 负相：不冒充）: 过了 1min ⇒ 照跑（上一句拒的是冗余，不是把清扫关掉）", wbSweepCalls.length === 2);
wbSweepRotation.sweep = wbSweepOriginal;

// --- G①（验证者 🟡3）: armTeamWatchdog 的失败隔离 --------------------------------
const wbIsoEnv = teamSessionEnv({ askScript: ["创建"] });
const wbIsoWatchdog = __testing.watchdogFor(wbIsoEnv.ctx);
const wbIsoSchedule = wbIsoWatchdog.schedule;
wbIsoWatchdog.schedule = () => { throw new Error("boom: schedule refused"); };
const wbIsoOut = await wbIsoEnv.run("n=1 team=wb-iso roles=worker-a task=建队");
wbIsoWatchdog.schedule = wbIsoSchedule;
// ★ t-14 B（评审 #3 🟡）：这条判据原来只钉「写入失败」那半句 —— 而夹具打的正是 schedule 抛错，
// 于是它把「已落盘、只是本进程没挂定时器」误报成「写入失败」。现在两段文案分开钉：
// ① 行**真的写进 settings 了**（读命名空间，不看报文）；② 报文如实说「已写入但定时器未挂上」；
// ③ 一行 warn 点名；④ 命令本身照旧成功（失败隔离不变）。
const wbIsoAuto = () => (wbIsoEnv.settings.namespaces.get("team-link").data.watchdogs ?? []).filter((entry) => entry.origin === "auto");
check("G① 写入段与挂表段分开报（t-14 B）: schedule 抛错时那条 auto 注册**已经落盘**（命名空间里读得到），报文如实说「已写入 <id>：首挂失败（…），已由 rearm 补上」——不再谎称「写入失败」；命令照旧成功、会话已建、roster 已写",
	wbIsoOut.kind === "success" && wbIsoOut.text.includes("工作台（FR-3a）：已写入 ") && wbIsoOut.text.includes("首挂失败") && wbIsoOut.text.includes("已由 rearm 补上")
		&& wbIsoAuto().length === 1 && wbIsoOut.text.includes(wbIsoAuto()[0].id) && wbIsoEnv.creates.length === 1
		&& wbIsoEnv.store().some((team) => team.name === "wb-iso") && !wbIsoOut.text.includes("未注册（写入失败"));
check("G① 留痕与补救（t-14 B）: 该分支留**恰一行** warn 点名「已写入，但定时器未挂上」与补救结果；夹具里 rearm 真的把定时器补上了（timers 里有这条 id）—— 报文与事实一致",
	wbIsoEnv.log.lines.warn.filter((line) => line.includes("已写入，但定时器未挂上")).length === 1
		&& wbIsoEnv.log.lines.warn.some((line) => line.includes(wbIsoAuto()[0]?.id ?? "wd-") && line.includes("已由 rearm 补上"))
		&& wbIsoWatchdog.timers.has(wbIsoAuto()[0]?.id ?? "wd-"));
// 两条分支各自的文案（单元级 · 判据直接驱动真函数，夹具给最小 policy/watchdog 替身）：
const wbIsoUnitCtx = { logger: { warn: () => {} } };
const wbIsoUnitPolicy = (update) => ({ get: () => ({ watchdogs: [] }), update });
const wbIsoUnitWatchdog = (schedule) => ({ schedule, rearm: () => {}, timers: new Map() });
const wbIsoUnitRequest = { watcherSession: "session-self", team: "wb-iso-unit", targets: ["session-target"], now: 1_700_000_000_000 };
const wbIsoWriteFail = await __testing.armTeamWatchdog(wbIsoUnitCtx, wbIsoUnitPolicy(async () => { throw new Error("update refused"); }), wbIsoUnitWatchdog(() => {}), wbIsoUnitRequest);
const wbIsoArmFail = await __testing.armTeamWatchdog(wbIsoUnitCtx, wbIsoUnitPolicy(async () => {}), wbIsoUnitWatchdog(() => { throw new Error("schedule refused"); }), wbIsoUnitRequest);
check("G① 分支①（update 失败）: 文案「写入失败（…）——本次没有落盘」，不带 entry（没落盘就没有注册可报）",
	wbIsoWriteFail.entry === undefined && String(wbIsoWriteFail.error).includes("写入失败") && String(wbIsoWriteFail.error).includes("本次没有落盘") && !String(wbIsoWriteFail.error).includes("定时器未挂上"));
check("G① 分支②（schedule 失败，rearm 也没能补上）: 文案「已写入但定时器未挂上（…）」且 **entry 在场**（写入确实落盘了），绝不出现「写入失败」",
	wbIsoArmFail.entry !== undefined && String(wbIsoArmFail.error).includes("已写入但定时器未挂上") && wbIsoArmFail.armed === false && !String(wbIsoArmFail.error).includes("写入失败"));

// --- G②（验证者 🟡3）: 另两条 attach 窗口（refused / detached）也重挂 --------------
const wbRearmRefusedRow = wbRearmRow("wd-rearm-refused");
const wbRearmRefusedEnv = setup({ sessions: [], selfCwd: TEAM_WS, useSettings: true, settingsRegisterThrows: true, settingsSeed: { "team-link": { watchdogs: [wbRearmRefusedRow] } } });
const wbRearmRefusedW = __testing.watchdogFor(wbRearmRefusedEnv.ctx);
check("U12 重挂（refused 窗口 · 前置）: 服务在场但拒注册 ⇒ 那一刻零定时器（scope 没挂上，注册表读不到）", wbRearmRefusedW.timers.size === 0);
wbRearmRefusedEnv.settings.stopRefusing();
await wbRearmRefusedEnv.tool("team_link_roster").execute({ action: "get" }, execFor(wbRearmRefusedEnv.senderAgent));
await waitForChain(wbRearmRefusedEnv, 1);
check("U12 重挂（refused 窗口）: 惰性重试真的把服务挂上之后，持久化注册拿到定时器", wbRearmRefusedW.timers.has(wbRearmRefusedRow.id));
const wbRearmDetachedRowA = wbRearmRow("wd-rearm-detach-a");
const wbRearmDetachedEnv = setup({ sessions: [], lateSettings: true, selfCwd: TEAM_WS });
const wbRearmDetachedW = __testing.watchdogFor(wbRearmDetachedEnv.ctx);
const wbRearmProviderA = await wbRearmDetachedEnv.provideSettingsFiber(makeSettings({ "team-link": { watchdogs: [wbRearmDetachedRowA] } }));
await waitForChain(wbRearmDetachedEnv, 1);
check("U12 重挂（detached 窗口 · 第一次挂上）: 晚挂的服务第一次挂上 ⇒ 它带来的注册拿到定时器", wbRearmDetachedW.timers.has(wbRearmDetachedRowA.id));
await wbRearmProviderA.dispose();
await tick();
check("U12 重挂（detached 窗口 · 掉线期间）: provider 掉线不拆定时器（拆掉就等于把注册变成哑的；巡逻每次都重新读 policy.get()）", wbRearmDetachedW.timers.has(wbRearmDetachedRowA.id));
const wbRearmDetachedRowB = wbRearmRow("wd-rearm-detach-b");
await wbRearmDetachedEnv.provideSettingsFiber(makeSettings({ "team-link": { watchdogs: [wbRearmDetachedRowB] } }));
await wbRearmDetachedEnv.tool("team_link_roster").execute({ action: "get" }, execFor(wbRearmDetachedEnv.senderAgent));
await waitForChain(wbRearmDetachedEnv, 2);
check("U12 重挂（detached 窗口 · 再挂上）: 新 provider 带来的注册也被挂上 ⇒ 两条注册都有定时器（每一次 attach 都对着**当时**的视图重挂）",
	wbRearmDetachedW.timers.has(wbRearmDetachedRowA.id) && wbRearmDetachedW.timers.has(wbRearmDetachedRowB.id));

// --- G③（验证者 🔵7）: watch list 的来源那一格逐字钉住 ----------------------------
const wbListOut = await wbWatchTool.execute({ action: "list" }, execFor(wbEnv.senderAgent));
check("G③（验证者 🔵7）: watch list 的手工行逐字带「 · 来源 manual」（改前它一个来源字都不带）", wbListOut.includes("· 来源 manual"));
check("G③（验证者 🔵7）: auto 行的来源那一格是完整那句（不占手工额度 + 投工作台摘要），两档不会看混",
	wbListOut.includes("· 来源 auto（建队时自动注册，不占手工额度，投工作台摘要）"));
// ===========================================================================
// 批 2 · FR-1 协调者宪章段 ＋ FR-2 会话资源段（合并注册 / 生命周期 / 降级）
// 归属：docs/2026-10-09-team-autonomy-design.md §5（FR-1/FR-2）· §6（伪代码）·
// §7.2/§7.4 · §8（U1–U6/U15）· §9（边界）。
// 两条评审裁定（第二轮设计评审 #2/#9，task-7 转述）也在这一段里钉住。
//
// ★ 宿主读数面（2026-10-09 实读宿主 asar 核对，非推测）——夹具按同一形状建模：
//   contextPressure v5 { contextWindow?, pressureTokens?, surfaceTokens, … } ·
//   tokenUsage v2 { totals{uncachedInputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}, last{turn,step,buckets} } ·
//   sessionStats v1 { turns, steps, … } ⇒ **turns 在场**（批 2 的先行核实结论）。
// ===========================================================================

/** 一条角色行（规范形状；与 teamRow 同一套字段）。 */
const wb2Role = (role, current) => ({
	role, current, pending: null, rotationAt: 0, provisional: null, rotationStatus: "",
	history: current === null ? [] : [{ session: current, from: 1_700_000_000_000, until: null, note: "" }],
});
/** 一支队伍（协调者 session-self + worker-a session-worker-a）。 */
const wb2Team = (name = "wb2-team", roles = undefined) => ({
	name, createdAt: 1_700_000_000_000, workspace: TEAM_WS, policy: { writer: "coordinator" },
	mode: "sessions", leadSessionId: "",
	roles: roles ?? [wb2Role("coordinator", "session-self"), wb2Role("worker-a", "session-worker-a")],
});
/** 批 2 的夹具：名册直接种进命名空间（服务在 activation 就在场 ⇒ apply 那一刻就读得到 ⇒ 注册钩子②当场跑）。 */
const wb2Env = ({ teams = [wb2Team()], extraAgents = [{ id: "session-worker-a", status: "idle", cwd: TEAM_WS }], projections = undefined, ...rest } = {}) => setup({
	sessions: [], useSettings: true, selfCwd: TEAM_WS, extraAgents,
	settingsSeed: { "team-link": { teams } },
	...(projections === undefined ? {} : { projectionsReadings: projections }),
	...rest,
});
/** 一条投影读数（形状按宿主 asar 核对的三个 key）。 */
const wb2Readings = (overrides = {}) => ({
	contextPressure: { contextWindow: 1_000_000, pressureTokens: 250_000, surfaceTokens: 200_000 },
	tokenUsage: { totals: { uncachedInputTokens: 100, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 400 }, last: { turn: 7, step: 3 } },
	sessionStats: { turns: 7, steps: 21 },
	...overrides,
});

// --- U2：注册参数逐字 —— 只对活代理、只对现任、宪章只给协调者 -----------------------
const wb2EnvBase = wb2Env({ projections: wb2Readings() });
const wb2Sections = __testing.sectionsFor(wb2EnvBase.ctx);
const wb2LiveRecords = wb2EnvBase.systemPrompt.live();
const wb2SectionsRecords = wb2EnvBase.systemPrompt.sections;
check("U2 注册: 名册里的两个活现任各拿到**恰一个**段 —— name=team-link:role、order 取 getSectionOrder(\"TEAM_POLICY\")（夹具答 900）、text 是**函数**",
	wb2Sections !== undefined && wb2Sections.registered.size === 2 && wb2LiveRecords.length === 2
		&& wb2LiveRecords.every((record) => record.name === "team-link:role" && record.order === 900 && typeof record.text === "function"));
/** 按注册表里的顺序取「那个会话的段」：注册表是 sessionId -> plan，段记录是同序 push 的。 */
// 段的**归属**按注册顺序读：planSections 先过一遍协调者、再过 worker —— 所以 [0] 是协调者的段、[1] 是
// worker 的段。注意不能用「文本里含 sessionId」去认领：worker 的义务行点名的是**角色**（worker-a）
// 而不是会话 id（session-worker-a），按 id 找会一个都匹配不上。下面两条各自带内容守卫。
const wb2Records = wb2EnvBase.systemPrompt.sections;
// Y7 纪律：红相里这些记录可能**根本不存在**（注册机制被停掉时）—— 一律经 at() 安全读，
// 让断言自己变红而不是让整轮崩溃（崩溃会让红相读数说谎：后面的断言一条都不打印）。
const wb2TextAt = (list, index) => { const record = at(list, index); return record === undefined ? "" : record.text({}); };
const wb2CoordText = () => wb2TextAt(wb2Records, 0);
const wb2WorkerText = () => wb2TextAt(wb2Records, 1);
check("U2 宪章只给现任协调者: 协调者那一段是宪章（含「职责边界」与「你是团队 wb2-team 的协调者」）＋资源行；worker 那段是义务行（点名角色与向谁汇报 + 不要静默等待），**不含**宪章",
	wb2Records.length === 2 && wb2CoordText().startsWith("你是团队 wb2-team 的协调者（现任会话 session-self）") && wb2CoordText().includes("职责边界")
		&& wb2WorkerText().startsWith("你是团队 wb2-team 的角色 worker-a") && wb2WorkerText().includes("向本队协调者汇报") && wb2WorkerText().includes("不要静默等待")
		&& !wb2WorkerText().includes("职责边界"));
// --- task-11（t-9 存疑 #2 的裁定）: worker 义务行走**角色寻址**，不含裸会话 id ----------
// 红相（见交付报告）：把义务行改回嵌裸 id（或按 coordinatorId 渲染）⇒ 本条红。
check("task-11 角色寻址: worker 版段里**不含任何裸会话 id 形状**（session-… / team-link-… 都不许出现），且含 team:<团队>/coordinator 角色寻址 —— 而协调者版**不受影响**（它点名的是它自己）",
	wb2WorkerText() !== "" && !/session-[0-9a-zA-Z_-]+|team-link-[0-9a-zA-Z_-]+/u.test(wb2WorkerText())
		&& wb2WorkerText().includes("team:wb2-team/coordinator")
		&& wb2CoordText().includes("现任会话 session-self"));
check("U2 注册: 缺席的现任**不注册**（名册里有 worker-b 但无活代理 ⇒ 它那一格没有段，且不产生多余 warn）",
	(() => { const env = wb2Env({ teams: [wb2Team("wb2-team", [wb2Role("coordinator", "session-self"), wb2Role("worker-b", "session-absent")])] }); return __testing.sectionsFor(env.ctx).registered.size === 1 && env.log.lines.warn.filter((line) => line.includes("角色/资源段未注册")).length === 0; })());

// --- U6：资源行与 stateOf 一致（逐项）＋缺字段⇒未知 ---------------------------------
const wb2ResourceLine = (text) => text.split("\n").find((line) => line.startsWith("[team-link 会话资源]")) ?? "";
const wb2SelfLine = wb2ResourceLine(wb2CoordText());
check("U6 资源行: 窗口 / 压力（含百分比）/ 累计 / 轮次逐项与 stateOf 读数一致（夹具给的就是那三个 key 的读数）",
	wb2SelfLine.includes("窗口 1.00M") && wb2SelfLine.includes("压力 250.0K（25.0%）")
		&& wb2SelfLine.includes("累计 ≈1.0K") && wb2SelfLine.includes("第 7 轮"));
check("U6 纯读: 资源行只读那三个 key（calls 逐个点名：contextPressure / tokenUsage / sessionStats，按会话点名），桩上不存在任何写方法 ⇒ 评审裁定 #2 的「直读、零缓存」",
	new Set(wb2EnvBase.projections.calls.map((call) => call.key)).size === 3
		&& ["contextPressure", "tokenUsage", "sessionStats"].every((key) => wb2EnvBase.projections.calls.some((call) => call.key === key))
		&& wb2EnvBase.projections.calls.length >= 3
		&& wb2EnvBase.projections.calls.every((call) => call.sessionId === "session-self" || call.sessionId === "session-worker-a")
		&& Object.keys(wb2EnvBase.projections.service).join(",") === "stateOf");
check("U6 缺字段 ⇒ 未知（不显示 NaN / undefined）: 三个投影都在场但字段缺 —— 窗口/压力/累计/轮次各自说「未知」或「轮次未知」",
	(() => {
		const env = wb2Env({ projections: { contextPressure: {}, tokenUsage: {}, sessionStats: {} } });
		const text = wb2TextAt(env.systemPrompt.live(), 0);
		return text.includes("窗口 未知") && text.includes("压力 未知（未知）") && text.includes("累计 ≈未知") && text.includes("轮次未知") && !/NaN|undefined/u.test(text);
	})());
check("U6 turns 核实（正相）: sessionStats.turns 在场 ⇒ 渲染「第 N 轮」（批 2 的先行核实结论：宿主 v1 投影确实带 turns）",
	wb2SelfLine.includes("第 7 轮"));
check("U6 turns 核实（反相/§9 降级）: sessionStats 缺席或 turns 不可读 ⇒ 「轮次未知」，绝不编数",
	(() => { const env = wb2Env({ projections: wb2Readings({ sessionStats: undefined }) }); return wb2TextAt(env.systemPrompt.live(), 0).includes("轮次未知"); })()
		&& (() => { const env = wb2Env({ projections: wb2Readings({ sessionStats: {} }) }); return wb2TextAt(env.systemPrompt.live(), 0).includes("轮次未知"); })());
check("U6 三种不可读各说各的: 服务缺席 / 投影未注册 / 读取抛错 —— 三种原因都写进行里，且都是字符串不抛错",
	(() => { const absent = wb2Env({ omitProjections: true }); const unreg = wb2Env(); const thrown = wb2Env({ projectionsThrows: true });
		return wb2TextAt(absent.systemPrompt.live(), 0).includes("不可读（sessionProjections 缺席）")
			&& wb2TextAt(unreg.systemPrompt.live(), 0).includes("不可读（投影未注册）")
			&& wb2TextAt(thrown.systemPrompt.live(), 0).includes("不可读（投影读取抛错"); })());

// --- 评审 #3：行数预算 --------------------------------------------------------------
check("评审 #3 行数预算: 宪章段 ≤8 行（当前 7 行）、资源行**恰 1 行**（无换行）",
	__testing.renderCharterLines("t", "s").split("\n").length <= 8
		&& __testing.renderCharterLines("t", "s").split("\n").length === 7
		&& __testing.renderResourceLine(wb2EnvBase.ctx, wb2EnvBase.senderAgent).split("\n").length === 1);
check("评审 #3 行数预算（合成）: 协调者那一段整段**恰 8 行**（宪章 7 + 资源 1；预算上界 9）",
	wb2CoordText().split("\n").length === 8);

// --- U1：降级（三种到达路径）＋ 对照（恰好一行 warn） -------------------------------
const wb2WarnCount = (env) => env.log.lines.warn.filter((line) => line.includes("角色/资源段未注册")).length;
check("U1 降级（a · 无 agent.ctx.systemPrompt）: 零注册 + **恰好一行** warn，不抛错；那一行点名回退路径（工具返回重钉）",
	(() => { const env = wb2Env({ omitSystemPrompt: true }); return __testing.sectionsFor(env.ctx).registered.size === 0 && wb2WarnCount(env) === 1 && env.log.lines.warn.some((line) => line.includes("回退到「工具返回重钉」路径")); })());
check("U1 降级（b · 面在、没有 section 方法）: 同上（零注册 + 恰一行）",
	(() => { const env = wb2Env({ systemPromptOptions: { omitSection: true } }); return __testing.sectionsFor(env.ctx).registered.size === 0 && wb2WarnCount(env) === 1; })());
check("U1 降级（c · 没有 getSectionOrder）: 同上（零注册 + 恰一行）—— 两条必备面缺任何一条都不注册",
	(() => { const env = wb2Env({ systemPromptOptions: { omitOrder: true } }); return __testing.sectionsFor(env.ctx).registered.size === 0 && wb2WarnCount(env) === 1; })());
check("U1 降级（d · section 注册抛错）: 零注册 + 恰一行 warn（同一个一次性门，不搞 warn 风暴）",
	(() => { const env = wb2Env({ systemPromptOptions: { sectionThrows: true } }); return __testing.sectionsFor(env.ctx).registered.size === 0 && wb2WarnCount(env) === 1; })());
check("U1 对照（★ 负相：不冒充）: 面齐全时**零** warn 且两段都在 —— 上面四条拒的是「面不可用」，不是「这一段本来就不注册」",
	wb2WarnCount(wb2EnvBase) === 0 && wb2Sections.registered.size === 2);

// --- U5：函数型 text 同步、恒返回字符串、异常吞掉降级为空串 -------------------------
const wb2RecordCoord = at(wb2SectionsRecords, 0, { text: () => "" });
const wb2Rendered = wb2RecordCoord.text({});
check("U5 text 恒返回字符串且**同步**: 直接调用拿到的就是 string（不是 Promise），两次渲染逐字相同（同一输入同一输出）",
	typeof wb2Rendered === "string" && !(wb2Rendered instanceof Promise) && wb2RecordCoord.text({}) === wb2Rendered && wb2Rendered.length > 0);
check("U5 异常吞掉降级为空串: 渲染体里抛出的异常**不冒泡**（装配不会因此失败），降级为空串 + 经 onError 留痕",
	// ★ t-8 复验 🟡（task-9 D）：整块包一层 try —— 守卫若被摘掉，这里会抛 Error("hostile plan")，
	// 裸抛会让整轮中止、后面的断言一条都不打印（红相读数说谎，违 Y7 纪律）。包起来之后红相是一条
	// 干净的 FAIL 行。
	(() => {
		try {
			const reported = [];
			const hostile = { team: "t", sessionId: "s", role: "coordinator", kind: "coordinator", coordinatorId: "s" };
			const text = __testing.renderRoleAndResources({ get: () => undefined }, { session: { header: { id: "s" } } }, { ...hostile, get kind() { throw new Error("hostile plan"); } }, (error) => reported.push(String(error)));
			return text === "" && reported.length === 1 && reported[0].includes("hostile plan");
		} catch {
			return false;
		}
	})());
check("U5 渲染体不吃宿主抛错: 投影 stateOf 抛错 ⇒ 行内如实说「不可读（投影读取抛错…）」，整段照旧是字符串",
	(() => { const env = wb2Env({ projectionsThrows: true }); const text = wb2TextAt(env.systemPrompt.live(), 0); return typeof text === "string" && text.includes("投影读取抛错") && !text.includes("职责边界\n\n"); })());

// --- U3：换现任 ⇒ 旧段 dispose、新段注册（零残留） ---------------------------------
const wb2SwapEnv = wb2Env({
	teams: [wb2Team("wb2-team", [wb2Role("coordinator", "session-self"), wb2Role("worker-a", "session-worker-a"), wb2Role("worker-b", "session-worker-b")])],
	extraAgents: [{ id: "session-worker-a", status: "idle", cwd: TEAM_WS }, { id: "session-worker-b", status: "idle", cwd: TEAM_WS }],
	projections: wb2Readings(),
});
const wb2Swap = __testing.sectionsFor(wb2SwapEnv.ctx);
const wb2SwapOut = await wb2SwapEnv.tool("team_link_roster").execute({ action: "set-role", team: "wb2-team", role: "coordinator", session: "session-worker-b" }, execFor(wb2SwapEnv.senderAgent));
check("U3 换现任: 旧现任的段被 **dispose**（disposer 真被调用）且注册表里不再有它 —— 宪章不会挂在卸任者身上",
	wb2SwapOut.includes("已设置：团队 wb2-team 的角色 coordinator") && at(wb2SwapEnv.systemPrompt.sections, 0, {}).disposed === 1 && !wb2Swap.registered.has("session-self"));
check("U3 换现任: 新现任拿到段、**宪章内容跟着换人**，旁观者（worker-a）逐字未动、活段数仍等于活现任数（一次 sync 之内完成换段，零残留）",
	wb2Swap.registered.has("session-worker-b") && wb2Swap.registered.get("session-worker-b").kind === "coordinator"
		// 换现任之后名册里剩两个活现任（worker-a 与新的协调者 worker-b）：活段数 == 活现任数。
		&& wb2SwapEnv.systemPrompt.live().length === 2 && wb2SwapEnv.systemPrompt.live().every((record) => record.disposed === 0)
		&& wb2TextAt(wb2SwapEnv.systemPrompt.sections, 3).startsWith("你是团队 wb2-team 的协调者（现任会话 session-worker-b）")
		&& at(wb2SwapEnv.systemPrompt.sections, 1, {}).disposed === 0 && wb2TextAt(wb2SwapEnv.systemPrompt.sections, 1).startsWith("你是团队 wb2-team 的角色 worker-a"));

// --- U4：代理消失 ⇒ disposer 被调用（不泄漏） -------------------------------------
const wb2GoneEnv = wb2Env({ projections: wb2Readings() });
const wb2Gone = __testing.sectionsFor(wb2GoneEnv.ctx);
wb2GoneEnv.setHiddenAgent("session-worker-a", true);
await wb2GoneEnv.tool("team_link_roster").execute({ action: "upsert-team", team: "wb2-team" }, execFor(wb2GoneEnv.senderAgent));
check("U4 代理消失: 名册还留着它，但代理没了 ⇒ 段被 dispose、注册表里零残留（不泄漏）",
	wb2GoneEnv.systemPrompt.sections.some((record) => record.disposed === 1) && !wb2Gone.registered.has("session-worker-a") && wb2Gone.registered.size === 1);

// --- 评审裁定 #9：rearm 跳过过期条目 ----------------------------------------------
const wb2ExpiredRow = { id: "wd-expired-0001", team: null, watcherSession: "session-self", targets: ["session-target"], silentMinutes: 10, intervalMinutes: 5, expiresAt: 1_000, createdAt: 500, origin: "manual" };
const wb2LiveRow = { id: "wd-live-0001", team: null, watcherSession: "session-self", targets: ["session-target"], silentMinutes: 10, intervalMinutes: 5, expiresAt: Date.now() + 12 * 3600_000, createdAt: Date.now(), origin: "manual" };
// ★ t-8 复验 🟡（task-9 C）：**两条活行**。只有一条活行时，「expired 恒 true」这个变异与正确实现
// 观察等价（兜底支挑的就是 expiresAt 最大那条 = 那条活行 ⇒ 定时器集合一样）⇒ 全绿。两条活行之下，
// 恒 true 只剩兜底支的**一条**定时器 ⇒ 与「两条活行都挂上」区分得开。
const wb2LiveRow2 = { ...wb2LiveRow, id: "wd-live-0002", expiresAt: Date.now() + 6 * 3600_000 };
const wb2RearmEnv = setup({ sessions: [], useSettings: true, selfCwd: TEAM_WS, settingsSeed: { "team-link": { watchdogs: [wb2ExpiredRow, wb2LiveRow, wb2LiveRow2] } } });
const wb2RearmTimers = __testing.watchdogFor(wb2RearmEnv.ctx).timers;
check("#9（评审裁定）rearm 按 expiresAt 过滤: 过期条目不挂定时器、**两条活条目都挂上**（修复前：逐条 schedule ⇒ 过期那条也有定时器；「expired 恒 true」下只剩兜底那一条 ⇒ 本条红）",
	!wb2RearmTimers.has(wb2ExpiredRow.id) && wb2RearmTimers.has(wb2LiveRow.id) && wb2RearmTimers.has(wb2LiveRow2.id) && wb2RearmTimers.size === 2);
const wb2AllExpiredEnv = setup({ sessions: [], useSettings: true, selfCwd: TEAM_WS, settingsSeed: { "team-link": { watchdogs: [wb2ExpiredRow] } } });
const wb2AllExpiredW = __testing.watchdogFor(wb2AllExpiredEnv.ctx);
check("#9 对照（★ 负相：跳过 ≠ 不清理）: 全部过期时仍留**一个**清扫专用定时器（否则那些行永远清不掉），它一跑就把过期行收掉",
	wb2AllExpiredW.timers.size === 1 && wb2AllExpiredW.timers.has(wb2ExpiredRow.id));
await wb2AllExpiredW.patrol({ now: Date.now() });
check("#9 清扫: 那次巡逻真的把过期行清掉了（policy 里零注册 + 定时器清空）",
	wb2AllExpiredEnv.settings.namespaces.get("team-link").data.watchdogs.length === 0 && wb2AllExpiredW.timers.size === 0);
// ★ t-14 A（评审 #2 🟡 · 真行为缺陷）：**多条**全过期时清扫必须持续推进。
// 机理：定时器回调走的是 `patrol({ id: entry.id })`（单条巡逻），全过期时兜底只给最新那条挂清扫
// 定时器 ⇒ 它被收掉（stopTimer）之后，其余过期行**再也没有定时器**，永远留在 policy 里。
// 判据按定时器回调的真实形状逐步驱动（不是一次性 patrol 全量 —— 那会绕开这个形状）。
const wb2ExpiredA = { ...wb2ExpiredRow, id: "wd-expired-a", expiresAt: 1_000 };
const wb2ExpiredB = { ...wb2ExpiredRow, id: "wd-expired-b", expiresAt: 2_000 };
const wb2TwoExpiredEnv = setup({ sessions: [], useSettings: true, selfCwd: TEAM_WS, settingsSeed: { "team-link": { watchdogs: [wb2ExpiredA, wb2ExpiredB] } } });
// ★ 先等 attach 后置链落定：链尾会调一次 notifyAttached()（⇒ rearm），若它落在测量窗内会把
// 「removeWatchdog 有没有接棒」这件事遮住（本轮实测：它恰好在我第一趟 patrol 的间隙补挂了 a）。
await waitForChain(wb2TwoExpiredEnv, 1);
const wb2TwoExpiredW = __testing.watchdogFor(wb2TwoExpiredEnv.ctx);
const wb2TwoRows = () => wb2TwoExpiredEnv.settings.namespaces.get("team-link").data.watchdogs;
check("#9 对照（t-14 A · 前置）: 两条全过期时兜底只挂**一个**清扫定时器（挑最新那条 b）—— 这就是停摆的形状",
	wb2TwoExpiredW.timers.size === 1 && wb2TwoExpiredW.timers.has(wb2ExpiredB.id));
await wb2TwoExpiredW.patrol({ now: Date.now(), id: wb2ExpiredB.id });
check("#9 对照（t-14 A · 核心判据）: 清扫定时器那条被收掉之后，**剩下那条过期行必须接棒**（removeWatchdog 尾部幂等 rearm）—— 修复前这里 timers=0 且 a 永远留在 policy 里",
	!wb2TwoRows().some((entry) => entry.id === wb2ExpiredB.id) && wb2TwoExpiredW.timers.has(wb2ExpiredA.id));
await wb2TwoExpiredW.patrol({ now: Date.now(), id: wb2ExpiredA.id });
check("#9 对照（t-14 A · 收尾）: 接棒那条也跑完之后 —— **两条都被清掉**、定时器归零（★ 这一趟是我**手动驱动**的：停摆与否由上一句判定 —— 修复前生产里压根不会有第二趟，因为没人给剩下那条挂定时器）",
	wb2TwoRows().length === 0 && wb2TwoExpiredW.timers.size === 0);

// --- U15 红线：inject / 三道门 / relay 字面量 --------------------------------------
const wb2RelayAt = hostSource.indexOf("function relayUserMessage(");
const wb2RelayBlock = wb2RelayAt === -1 ? "" : hostSource.slice(wb2RelayAt, hostSource.indexOf("\n}", wb2RelayAt));
check("U15 红线（批 2 复核）: 模块级 inject 恒 4 项 · 三道门元数未动 · 本批一个字都没碰 relayUserMessage（它仍恰三成员）",
	JSON.stringify(indexModule.inject) === JSON.stringify(["sessionReferenceResolver", "tools", "sessionQuery", "agents"])
		&& __testing.writerGate.length === 2 && __testing.retireGate.length === 2 && __testing.rotateGate.length === 3
		&& wb2RelayBlock.length > 0 && !/team-link:role|sections|renderRoleAndResources/u.test(wb2RelayBlock));
// --- B（task-9 · t-8 验证者探针 → 仓库断言）: 换届 claim 的段生命周期 ----------------
// 这条路径此前**零覆盖**（复验者实测：把 A 那一行移到写入之后，出货套件照旧全绿）。判据读真控制器：
// prepare（现任发起）→ claim（继任者凭令牌）→ 段必须换人。
// 红相＝A 未修（那一次 sync 落在 policy.update 之前）：见交付报告 §二 —— 探针读数 before/after。
const wb3TeamRow = {
	name: "night-shift", createdAt: 1_700_000_000_000, workspace: TEAM_WS, policy: { writer: "coordinator" },
	mode: "sessions", leadSessionId: "",
	roles: [wb2Role("coordinator", ROT_SELF), wb2Role("worker-a", "session-worker-a")],
};
const wb3Env = setup({
	sessions: [], useSettings: true, selfCwd: TEAM_WS,
	extraAgents: [{ id: "session-worker-a", status: "idle", cwd: TEAM_WS }, { id: SUCCESSOR, status: "idle", cwd: TEAM_WS }],
	settingsSeed: { "team-link": { teams: [wb3TeamRow] } },
	projectionsReadings: wb2Readings(),
	askScript: [["session-worker-a"]],
});
const wb3Sections = __testing.sectionsFor(wb3Env.ctx);
const wb3SelfRecord = at(wb3Env.systemPrompt.sections, 0, { disposed: -1, text: () => "" });
const wb3WorkerRecord = at(wb3Env.systemPrompt.sections, 1, { disposed: -1, text: () => "" });
const wb3WorkerTextBefore = wb3WorkerRecord.text({});
const wb3WorkerPlanBefore = wb3Sections.registered.get("session-worker-a");
const wb3Before = { self: wb3Sections.registered.has(ROT_SELF), succ: wb3Sections.registered.has(SUCCESSOR) };
const wb3Rotate = wb3Env.tool("team_link_rotate");
const wb3Prep = await wb3Rotate.execute({ action: "prepare", team: "night-shift", role: "coordinator", successor: SUCCESSOR }, execFor(wb3Env.senderAgent));
const wb3Claim = await wb3Rotate.execute({ action: "claim", team: "night-shift", role: "coordinator", token: tokenOf(wb3Prep) }, execFor(wb3Env.agentFor(SUCCESSOR)));
const wb3Current = () => (wb3Env.settings.namespaces.get("team-link").data.teams[0].roles.find((entry) => entry.role === "coordinator") ?? {}).current ?? null;
const wb3SuccRecord = wb3Env.systemPrompt.sections.find((record) => record.disposed === 0 && record.text({}).includes(SUCCESSOR) && record.text({}).includes("协调者"));
check("B 换届 claim 的段生命周期（t-8 复验 🟡 → 仓库断言）: claim 成功之后 —— ① 旧现任的协调者段被 **dispose**；② 继任者拿到**协调者版**段（宪章点名继任者）；③ 旁观 worker 段逐字未动、注册对象都没换；④ 注册表里旧现任零残留",
	wb3Env.agentFor(SUCCESSOR) !== undefined && wb3Claim.length > 0 && wb3Current() === SUCCESSOR
		&& wb3Before.self === true && wb3Before.succ === false
		&& wb3SelfRecord.disposed === 1 && !wb3Sections.registered.has(ROT_SELF)
		&& wb3Sections.registered.get(SUCCESSOR)?.kind === "coordinator" && wb3SuccRecord !== undefined
		&& wb3WorkerRecord.disposed === 0 && wb3WorkerRecord.text({}) === wb3WorkerTextBefore && wb3Sections.registered.get("session-worker-a") === wb3WorkerPlanBefore);
// ===========================================================================
// 批 3 · FR-5 第⑧段 + 判读行 / FR-6 轮换标记 / FR-4 四处重钉 / FR-9 总开关
// 判据：U7（禁用词）· U8（轮换四边界）· U13（零写）· U16（首行/第2行/描述八段）·
// U17（总开关三处 + 键集 + README 同批）· U18（四处重钉：现任含 / 非现任缺席）。
// 父侧裁定口径：宿主投影不含压缩阈值 ⇒ 判读行不做「低于阈值」比较；「预算耗尽」只许否定式。
// ===========================================================================

/** 批 3 夹具：调用会话就是 wb4-team 的现任协调者（settings 直接种名册与开关）。 */
const wb4Env = ({ readings = wb2Readings(), sections = undefined, extraAgents = [], sessions = [], eventsBySession = {}, teams = undefined, omitProjections = false, projectionsThrows = false } = {}) => setup({
	sessions, eventsBySession, useSettings: true, selfCwd: TEAM_WS, extraAgents, omitProjections, projectionsThrows,
	settingsSeed: { "team-link": { teams: teams ?? [wb2Team("wb4-team")], ...(sections === undefined ? {} : { sections }) } },
	projectionsReadings: readings,
});
const wb4CharterLine = (team) => __testing.charterReinforceLine(team);
/** README 的键集描述（U17 的「同批更新」判据读它）。 */
const readmeSource = await readFile(fileURLToPath(new URL("./README.md", import.meta.url)), "utf8");
const wb4StatusLines = async (env) => String(await env.tool("team_link_status").execute({}, execFor(env.senderAgent))).split("\n");
const wb4SectionOf = (lines, head) => {
	const start = lines.findIndex((line) => line.startsWith(head));
	if (start === -1) return [];
	const out = [];
	for (let index = start; index < lines.length; index += 1) {
		if (index > start && lines[index].startsWith("--- ")) break;
		out.push(lines[index]);
	}
	return out;
};

// --- U16：首行仍是落点行、第 2 行是重钉行、描述改成八段 ----------------------------
const wb4EnvBase = wb4Env();
const wb4Status = await wb4StatusLines(wb4EnvBase);
const wb4StatusText = wb4Status.join("\n");
check("U16 首行与第 2 行: 首行仍是 placementLine（可核落点，R2 红线），第 2 行是 FR-4 的角色重钉（调用方是现任协调者）",
	wb4Status[0].startsWith("存储：") && wb4Status[1] === wb4CharterLine("wb4-team") && wb4Status[2].includes("团队状态卡"));
check("U16 描述: team_link_status 的工具描述由「七段」改「八段」并列出新段（⑧ 资源/预算）",
	(() => { const desc = String(wb4EnvBase.tool("team_link_status").description ?? ""); return desc.includes("八段") && desc.includes("⑧") && !desc.includes("七段"); })());

// --- U18：四处重钉（现任含 / 非现任缺席） -----------------------------------------
const wb4CreateEnv = wb4Env({ teams: [] });
const wb4CreateOut = String(await wb4CreateEnv.tool("team_link_roster").execute({ action: "upsert-team", team: "wb4-fresh" }, execFor(wb4CreateEnv.senderAgent)));
check("U18 重钉点①（upsert-team 创建分支）: 创建即认领 ⇒ 回报带一行宪章要点", wb4CreateOut.includes(wb4CharterLine("wb4-fresh")));
const wb4BuildEnv = teamSessionEnv({ askScript: ["创建"] });
const wb4BuildOut = await wb4BuildEnv.run("n=1 team=wb4-build roles=worker-a task=建队");
check("U18 重钉点②（/team_session 完成回报）: 调用方成为现任协调者 ⇒ 回报带一行宪章要点", wb4BuildOut.kind === "success" && wb4BuildOut.text.includes(wb4CharterLine("wb4-build")));
const wb4ForeignEnv = wb4Env({ teams: [wb2Team("wb4-other", [wb2Role("coordinator", "session-someone-else")])] });
const wb4ForeignStatus = await wb4StatusLines(wb4ForeignEnv);
check("U18 重钉点③（team_link_status 第 2 行）· 非现任缺席: 调用方不是现任协调者 ⇒ 第 2 行没有重钉行（首行仍是落点行）",
	wb4ForeignStatus[0].startsWith("存储：") && !wb4ForeignStatus.join("\n").includes("角色重钉："));
// 该 fixture 必须**同时**种名册 —— FR-4 的判据是「观察者是该队现任协调者」，没有名册就永远是 false。
const wb4DigestEnv = watchdogEnv({ targets: { "session-free": { events: oneShotSurface(WD_NOW - 120_000) } }, teams: [wb2Team("wb4-team")], watchdogs: [wbRow({ id: "wd-auto-fr4", team: "wb4-team", targets: ["session-free"] })] });
await wb4DigestEnv.watchdog.patrol({ now: WD_NOW });
const wb4DigestText = textOfFirst(digestOf(wb4DigestEnv));
check("U18 重钉点④（digest 脚注）· 现任含: 观察者是该队现任协调者（名册里 coordinator=session-self）⇒ 摘要脚注带一行宪章要点",
	wb4DigestText.includes(wb4CharterLine("wb4-team")) && wb4DigestText.includes("角色重钉："));
const wb4DigestOtherEnv = watchdogEnv({ targets: { "session-free": { events: oneShotSurface(WD_NOW - 120_000) } }, watchdogs: [wbRow({ id: "wd-auto-fr4b", team: "wb4-nobody", targets: ["session-free"] })] });
await wb4DigestOtherEnv.watchdog.patrol({ now: WD_NOW });
// ★ t-13 🟡1（task-16 A）：上面那条钉的是「队**不在**名册里」——它证明不了现任比对。下面这条才是：
// 队在场、coordinator 是**别人** ⇒ 脚注必须缺席（变异：把 isIncumbentCoordinator 改成恒真 ⇒ 本条红）。
const wb4DigestForeignEnv = watchdogEnv({ targets: { "session-free": { events: oneShotSurface(WD_NOW - 120_000) } }, teams: [wb2Team("wb4-team", [wb2Role("coordinator", "session-someone-else")])], watchdogs: [wbRow({ id: "wd-auto-fr4c", team: "wb4-team", targets: ["session-free"] })] });
await wb4DigestForeignEnv.watchdog.patrol({ now: WD_NOW });
check("U18 重钉点④ · 非现任缺席（队**在场**、现任是别人）: 名册里有 wb4-team 但它的 coordinator 不是观察者 ⇒ 脚注不带重钉行（这一条才钉住现任比对）",
	textOfFirst(digestOf(wb4DigestForeignEnv)).includes("[workbench]") && !textOfFirst(digestOf(wb4DigestForeignEnv)).includes("角色重钉："));
check("U18 重钉点④ · 非现任缺席（该队根本不在名册里）: 对照项 —— 两种情况都缺席",
	textOfFirst(digestOf(wb4DigestOtherEnv)).includes("[workbench]") && !textOfFirst(digestOf(wb4DigestOtherEnv)).includes("角色重钉："));
// --- 第 ⑧ 段：逐项读数 + U7 判读行 + 行数预算 -------------------------------------
const wb4Section = wb4SectionOf(wb4Status, "--- 资源/预算");
const wb4Verdict = at(wb4Section, wb4Section.length - 1, "");
check("第 ⑧ 段: 段头 + 会话行 + 判读行，整段 ≤12 行（评审行数预算；本夹具 1 个会话 ⇒ 3 行）",
	wb4Section.length === 3 && wb4Section.length <= __testing.BUDGET_SECTION_MAX_LINES && wb4Section[0].startsWith("--- 资源/预算（⑧") && wb4Verdict.startsWith("预算判读："));
check("第 ⑧ 段逐项与投影一致: 压力 25.0%（窗口 1.00M） · 累计 ≈1.0K · 第 7 轮",
	wb4Section.some((line) => line.includes("session-self") && line.includes("压力 25.0%") && line.includes("窗口 1.00M") && line.includes("累计 ≈1.0K") && line.includes("第 7 轮")));
// --- U7 白名单（批 6 起**三句**）＋ U24（FR-14 的范围界定句） -------------------------
// 三句**逐字**白名单：① 读数不可得支（前缀 —— 原因码是变量）② 读数可得支 ③ FR-14 的范围界定句。
// ③ 逐字抄自设计档 §5 FR-14 原句（55 码点、四个 em dash）：抄错、改写、删掉都要能被 U24 咬住。
const WB4_VERDICT_A_PREFIX = "预算判读：读数不可得，不作判读";
const WB4_VERDICT_B = "预算判读：未见收口理由：本系统按压力自动压缩，结构上不存在『预算耗尽』。";
const WB4_VERDICT_SCOPE = "（本节只判上下文/预算；宿主工具闸门——如写入自动评审 429——属另一类，见工具报错原文，不在本节口径内。）";
const WB4_VERDICT_WHITELIST = [WB4_VERDICT_A_PREFIX, WB4_VERDICT_B, WB4_VERDICT_SCOPE];
const WB4_FORBIDDEN = ["预算耗尽", "收口", "阈值"];
/** 禁词的**程序化**分布读数：每一处出现在全卡的哪个位置、是否落在给定白名单句内（不肉眼）。 */
const forbiddenScan = (card, word, whitelist) => {
	const spans = [];
	for (const sentence of whitelist) {
		let mark = card.indexOf(sentence);
		while (mark !== -1) {
			spans.push([mark, mark + sentence.length]);
			mark = card.indexOf(sentence, mark + sentence.length);
		}
	}
	const hits = [];
	let mark = card.indexOf(word);
	while (mark !== -1) {
		hits.push(mark);
		mark = card.indexOf(word, mark + word.length);
	}
	return { hits, outside: hits.filter((index) => !spans.some(([start, end]) => index >= start && index < end)) };
};
/** 指纹 = 每个禁词的「全卡出现次数 / 落在白名单外的次数」（读数写进断言名，失败即可读）。 */
const forbiddenFingerprint = (card, whitelist) => WB4_FORBIDDEN.map((word) => {
	const scan = forbiddenScan(card, word, whitelist);
	return word + ":" + scan.hits.length + "/" + scan.outside.length;
}).join(" ");
check("U7 判读行（读数可得）: 否定式结论 ——「未见收口理由：本系统按压力自动压缩，结构上不存在『预算耗尽』。」**后接 FR-14 的范围界定句**（判读行 = ② + ③ 两句逐字拼接）；且不做「低于阈值」的比较",
	wb4Verdict === WB4_VERDICT_B + WB4_VERDICT_SCOPE && !wb4Verdict.includes("阈值"));
check("U7 禁用词（程序化计数，不肉眼）: 「预算耗尽」与「收口」全卡各**恰一次**、且每一处都落在三句白名单内（都在那条判读行里）；「阈值」在判读行内零命中 —— 指纹 " + forbiddenFingerprint(wb4StatusText, WB4_VERDICT_WHITELIST),
	(() => {
		const budget = forbiddenScan(wb4StatusText, "预算耗尽", WB4_VERDICT_WHITELIST);
		const closed = forbiddenScan(wb4StatusText, "收口", WB4_VERDICT_WHITELIST);
		return budget.hits.length === 1 && budget.outside.length === 0
			&& closed.hits.length === 1 && closed.outside.length === 0
			&& forbiddenScan(wb4StatusText, "阈值", WB4_VERDICT_WHITELIST).outside.length === 0
			&& !wb4Verdict.includes("阈值")
			&& wb4Verdict.split("预算耗尽").length - 1 === 1 && wb4Verdict.split("收口").length - 1 === 1;
	})());
check("U7 白名单扩到三句（批 6 / FR-14）: 新增第三句之后三个禁词的**程序化指纹**在「原两句白名单」与「新三句白名单」下逐字相同 —— 新增句一个禁词都没引入，也没有把任何一处禁词挪到白名单外 —— 旧 " + forbiddenFingerprint(wb4StatusText, [WB4_VERDICT_A_PREFIX, WB4_VERDICT_B]) + " · 新 " + forbiddenFingerprint(wb4StatusText, WB4_VERDICT_WHITELIST),
	WB4_FORBIDDEN.every((word) => !WB4_VERDICT_SCOPE.includes(word))
		&& forbiddenFingerprint(wb4StatusText, [WB4_VERDICT_A_PREFIX, WB4_VERDICT_B]) === forbiddenFingerprint(wb4StatusText, WB4_VERDICT_WHITELIST));
check("U24 ①逐字范围句: 判读行**含** FR-14 的逐字原句（含四个 em dash）、紧接在既有白名单句之后，且三处范围标记都在（「只判上下文/预算」·「属另一类」·「不在本节口径内」）—— 既有两句一字未改（逐字等号在前半句上）",
	wb4Verdict.endsWith(WB4_VERDICT_SCOPE) && wb4Verdict === WB4_VERDICT_B + WB4_VERDICT_SCOPE
		&& WB4_VERDICT_SCOPE.includes("只判上下文/预算") && WB4_VERDICT_SCOPE.includes("属另一类") && WB4_VERDICT_SCOPE.includes("不在本节口径内"));
check("U24 ①b 两支都带（范围界定是**判读行**的属性，与读数是否可得无关）: 读数不可得支同样接这一句 —— 既有那句「读数不可得，不作判读（原因…）」逐字不变，只在末尾多这一句",
	await (async () => {
		const section = wb4SectionOf(await wb4StatusLines(wb4Env({ omitProjections: true })), "--- 资源/预算");
		const verdict = at(section, section.length - 1, "");
		return verdict.startsWith(WB4_VERDICT_A_PREFIX) && verdict.endsWith(WB4_VERDICT_SCOPE);
	})());
check("U24 ②不引入禁词（程序化计数）: 范围句单看对三个禁词的指纹恒为 0；并入之后**全卡指纹**与原两句白名单下逐字相同 —— 新句指纹 " + forbiddenFingerprint(WB4_VERDICT_SCOPE, WB4_VERDICT_WHITELIST),
	WB4_FORBIDDEN.every((word) => !WB4_VERDICT_SCOPE.includes(word))
		&& forbiddenScan(WB4_VERDICT_SCOPE, "预算耗尽", WB4_VERDICT_WHITELIST).hits.length === 0
		&& forbiddenScan(WB4_VERDICT_SCOPE, "收口", WB4_VERDICT_WHITELIST).hits.length === 0
		&& forbiddenScan(WB4_VERDICT_SCOPE, "阈值", WB4_VERDICT_WHITELIST).hits.length === 0
		&& forbiddenFingerprint(wb4StatusText, [WB4_VERDICT_A_PREFIX, WB4_VERDICT_B]) === forbiddenFingerprint(wb4StatusText, WB4_VERDICT_WHITELIST));
check("U7 判读行（读数不可得）: 整行如实标不可读并给原因码，判读行改说「读数不可得，不作判读」",
	await (async () => {
		const env = wb4Env({ omitProjections: true });
		const lines = await wb4StatusLines(env);
		const section = wb4SectionOf(lines, "--- 资源/预算");
		return section.some((line) => line.includes("不可读（原因：sessionProjections 缺席）")) && at(section, section.length - 1, "").startsWith("预算判读：读数不可得，不作判读");
	})());

check("§9 第 ⑧ 段原因码②（投影未注册，t-13 🔵4）: 服务在场但三个 key 都返回 undefined ⇒ 整行如实标「不可读（原因：投影未注册）」",
	await (async () => {
		const env = wb4Env({ readings: {} });
		const section = wb4SectionOf(await wb4StatusLines(env), "--- 资源/预算");
		return section.some((line) => line.includes("不可读（原因：投影未注册）")) && at(section, section.length - 1, "").startsWith("预算判读：读数不可得，不作判读");
	})());
check("§9 第 ⑧ 段原因码③（投影读取抛错，t-13 🔵4）: stateOf 抛错 ⇒ 整行如实标「不可读（原因：投影读取抛错：…）」，且**不抛出去**（卡片照常出）",
	await (async () => {
		const env = wb4Env({ projectionsThrows: true });
		const lines = await wb4StatusLines(env);
		const section = wb4SectionOf(lines, "--- 资源/预算");
		return section.some((line) => line.includes("不可读（原因：投影读取抛错：")) && at(section, section.length - 1, "").startsWith("预算判读：读数不可得，不作判读");
	})());

check("§9 第 ⑧ 段原因码④（非活动会话，task-18 C②）: 会话面里有这条 id 但没有活动代理（拿不到真会话）⇒ 如实标「不可读（原因：非活动会话）」，**不构造替身**也不编读数",
	await (async () => {
		const env = wb4Env({ sessions: [{ header: { id: "session-ghost", createdAt: 1000, cwd: TEAM_WS }, live: false, persisted: true }] });
		const lines = await wb4StatusLines(env);
		const section = wb4SectionOf(lines, "--- 资源/预算");
		return section.some((line) => line.includes("session-ghost：不可读（原因：非活动会话）"));
	})());
check("§9 第 ⑧ 段原因码④ 对照: 同一张卡上**活会话**（调用方自己）仍给真实读数 —— 两种会话在同一段里分得开",
	await (async () => {
		const env = wb4Env({ sessions: [{ header: { id: "session-ghost", createdAt: 1000, cwd: TEAM_WS }, live: false, persisted: true }] });
		const section = wb4SectionOf(await wb4StatusLines(env), "--- 资源/预算");
		return section.some((line) => line.includes("session-self") && line.includes("压力 25.0%")) && section.some((line) => line.includes("非活动会话"));
	})());

// --- task-20：让**非调用方**的活会话进第 ⑧ 段读窗 ⇒ 集中归一 hostShapeAll 承重 -----------
// 读窗来自 sessionQuery 的**会话记录**（不是 agents），所以必须同时种 `sessions` 记录与活代理；
// 只种 extraAgents 的话第 ⑧ 段仍然只有 session-self（复核者探针实测，t-19 🔵1）。
const WB20_PEER = "session-wb20-peer";
const wb20Env = () => wb4Env({
	sessions: [{ header: { id: WB20_PEER, createdAt: 1000, cwd: TEAM_WS }, live: true, persisted: true }],
	extraAgents: [{ id: WB20_PEER, status: "idle" }],
});
const wb20Section = wb4SectionOf(await wb4StatusLines(wb20Env()), "--- 资源/预算");
check("task-20 前置: 非调用方的活会话确实进了第 ⑧ 段读窗（不是只有 session-self）—— 同时种会话记录与活代理",
	wb20Section.filter((line) => line.startsWith("- ")).length === 2 && wb20Section.some((line) => line.startsWith("- " + WB20_PEER + "：")));
check("task-20 ① 非调用方的活会话给出**真实读数**: 压力 25.0%（窗口 1.00M） · 累计 ≈1.0K · 第 7 轮 —— 它的会话对象必须是**宿主真实形状**，而它只由夹具的集中归一 hostShapeAll 造型（改成 no-op ⇒ 本条必红）",
	wb20Section.some((line) => line.startsWith("- " + WB20_PEER + "：") && line.includes("压力 25.0%") && line.includes("窗口 1.00M") && line.includes("累计 ≈1.0K") && line.includes("第 7 轮") && !line.includes("不可读")));
// --- U8：轮换四边界（严格大于）+ turns 不可读的降级 --------------------------------
const wb4Cand = (turns, tokens) => __testing.rotateCandidateOf({ available: true, sessionId: "s", turns, totalTokens: tokens });
check("U8 轮换四边界（turns）: 99 / 100 **不算**候选、101 算（阈值 100 取严格大于）",
	wb4Cand(99, 0) === null && wb4Cand(100, 0) === null && wb4Cand(101, 0) !== null);
check("U8 轮换四边界（tokens）: 199.9M / 200M **不算**候选、200.1M 算（阈值 2 亿取严格大于）",
	wb4Cand(0, 199_900_000) === null && wb4Cand(0, 200_000_000) === null && wb4Cand(0, 200_100_000) !== null);
check("U8 turns 不可读 ⇒ 只按 tokens 标记，且标签写明「轮次未知」（如实标注，不编轮次）",
	wb4Cand(undefined, 200_100_000).label === "轮换候选（轮次未知 / tokens≈200.10M）");
check("U8 E2E: 卡片行尾确实挂上标记，并给出那句现成命令（只标记、不自动）",
	await (async () => {
		const env = wb4Env({ readings: wb2Readings({ sessionStats: { turns: 101, steps: 303 } }) });
		const lines = await wb4StatusLines(env);
		const section = wb4SectionOf(lines, "--- 资源/预算");
		return section.some((line) => line.includes("⚠ 轮换候选（turns=101 / tokens≈1.0K）"))
			&& section.some((line) => line.includes("team_link_rotate action=prepare successor:auto"));
	})());

// --- U13：零写（第 ⑧ 段在场也不破「全只读」合同） ---------------------------------
const wb4NsBefore = JSON.stringify(wb4EnvBase.settings.namespaces.get("team-link").data);
await wb4StatusLines(wb4EnvBase);
check("U13 零写: 第 ⑧ 段在场时，调用前后 settings 命名空间**逐字节不变**（纯读：只读 sessionProjections 与 policy）",
	JSON.stringify(wb4EnvBase.settings.namespaces.get("team-link").data) === wb4NsBefore);

// --- U17：总开关（role / resources 各自关断，resources 三处全缺） ------------------
const wb4NoRoleEnv = wb4Env({ sections: { role: false } });
const wb4NoRoleText = (await wb4StatusLines(wb4NoRoleEnv)).join("\n");
const wb4NoRoleSection = __testing.sectionsFor(wb4NoRoleEnv.ctx);
const wb4NoRoleRecords = wb4NoRoleEnv.systemPrompt.live();
check("U17 role=false: 工具返回面零重钉行；提示段里没有宪章/义务行（只剩资源行）——「不想被提醒」时角色文本三处都关",
	!wb4NoRoleText.includes("角色重钉：") && wb4NoRoleRecords.length >= 1
		&& wb4NoRoleRecords.every((record) => !record.text({}).includes("职责边界") && !record.text({}).includes("你是团队") && record.text({}).includes("[team-link 会话资源]"))
		&& wb4NoRoleSection.registered.size >= 1);
const wb4NoResEnv = wb4Env({ sections: { resources: false } });
const wb4NoResStatus = await wb4StatusLines(wb4NoResEnv);
const wb4NoResText = wb4NoResStatus.join("\n");
check("U17 resources=false 三处 ①②: 第 ⑧ 段**整段不出现**（连段头都不出现），提示段里零资源行",
	!wb4NoResText.includes("--- 资源/预算") && !wb4NoResText.includes("[team-link 会话资源]")
		&& wb4NoResEnv.systemPrompt.live().every((record) => !record.text({}).includes("[team-link 会话资源]")));
const wb4NoResDigestEnv = watchdogEnv({ targets: { "session-free": { events: oneShotSurface(WD_NOW - 120_000) } }, teams: [wb2Team("wb4-team")], sections: { resources: false }, watchdogs: [wbRow({ id: "wd-auto-nores", team: "wb4-team", targets: ["session-free"] })] });
await wb4NoResDigestEnv.watchdog.patrol({ now: WD_NOW });
const wb4NoResDigestText = textOfFirst(digestOf(wb4NoResDigestEnv));
check("U17 resources=false 三处 ③: digest 脚注里也没有资源行（但摘要正文与角色重钉照常）",
	wb4NoResDigestText.includes("[workbench]") && !wb4NoResDigestText.includes("[team-link 会话资源]") && wb4NoResDigestText.includes("角色重钉："));
const wb4BothOffEnv = wb4Env({ sections: { role: false, resources: false } });
check("U17 两处都关 ⇒ 零段注册: 没有段可挂（注册表为空），也不产生多余 warn",
	__testing.sectionsFor(wb4BothOffEnv.ctx).registered.size === 0 && wb4BothOffEnv.systemPrompt.sections.length === 0 && wb4BothOffEnv.log.lines.warn.filter((line) => line.includes("角色/资源段未注册")).length === 0);
check("U17 键集与 README 同批: PolicyConfig 声明面 = 九项（新增 sections）；README 的键集描述同批写成九项（U17 的红线面）",
	sameJson(Object.keys(wb4EnvBase.settings.namespaces.get("team-link").base).sort(), ["blockedSenders", "pairs", "pendingCreates", "receiveMode", "rememberTargets", "sections", "teams", "trustedSenders", "watchdogs"])
		&& /九个键|9 个键|九项/.test(readmeSource) && readmeSource.includes("sections"));

// --- U17 续：清掉的 auto 注册同进程不自愈 ------------------------------------------
const wb4ClearEnv = teamSessionEnv({ askScript: ["创建"] });
await wb4ClearEnv.run("n=1 team=wb4-clear roles=worker-a task=建队");
const wb4ClearAuto = () => (wb4ClearEnv.settings.namespaces.get("team-link").data.watchdogs ?? []).filter((entry) => entry.origin === "auto");
const wb4ClearFirst = wb4ClearAuto()[0]?.id;
// ★ t-13 🔵3（task-16 C）: **前置守卫** —— auto 行不存在时 clear 会退化成 no-op，而下面的「不自愈」
// 断言照样绿（假绿）。先把「确实有一条 auto 注册」钉住。
check("U17 clear 前置（t-13 🔵3）: 建队确实写了一条 auto 注册（否则 clear 退化成 no-op、下面的不自愈断言会假绿）",
	typeof wb4ClearFirst === "string" && wb4ClearFirst.startsWith("wd-") && wb4ClearAuto().length === 1);
const wb4ClearOut = String(await wb4ClearEnv.tool("team_link_watch").execute({ action: "clear", id: wb4ClearFirst }, execFor(wb4ClearEnv.senderAgent)));
check("U17 clear 前置（对照）: clear 真的删掉了那一条（读数点名 id，不是 no-op）",
	wb4ClearOut.includes("已清理看门狗注册 " + wb4ClearFirst) && wb4ClearAuto().length === 0);
await wb4StatusLines(wb4ClearEnv);
await __testing.watchdogFor(wb4ClearEnv.ctx).patrol({ now: Date.now() });
check("U17 清掉的 auto 注册**同进程不自愈**: clear 之后状态卡与一轮巡逻都不把它挂回来（没有任何懒自愈支路 —— 只有下一次 /team_session 建队才会重挂，那是显式写路径）",
	wb4ClearAuto().length === 0 && __testing.watchdogFor(wb4ClearEnv.ctx).timers.size === 0);
// ===========================================================================
// 批 5 · FR-10 attach 按队补挂 / FR-11 patrol 段同步 / FR-12 arm-team / FR-13 跨工作区读窗
// 判据：U20（attach 补挂 + 幂等）· U21（现任晚启动，一个巡检间隔内拿到段）·
// U22（arm-team：现任可用且幂等 / 非现任与队不在名册拒绝）· U23（跨工作区读窗两条支）。
// 归属：docs/2026-10-09-team-autonomy-design.md §5（FR-10…FR-13）· §8（U20–U23）·
// §9 的两条边界行（补挂失败 fail-open / 跨工作区读窗 fail-visible）。
// ★ 本节四条判据各有一条**定向变异**能把它单独打红（红相读数见交付报告），不是靠别处的耦合顺手变红。
// ===========================================================================

const B5_WS = path.join(TEAM_TMP, "b5-ws");
/** 名册行（规范形状；与 teamRow / wb2Team 同一套字段）。 */
const b5Team = (name, workspace, roles, writer = "coordinator") => ({ name, createdAt: 1_700_000_000_000, workspace, policy: { writer }, mode: "sessions", leadSessionId: "", roles });
/** 命名空间里的注册行（**落盘形状**，不是归一化后的读面）。 */
const b5Watchdogs = (env) => env.settings.namespaces.get("team-link").data.watchdogs ?? [];
const b5Auto = (env) => b5Watchdogs(env).filter((entry) => entry.origin === __testing.WATCHDOG_ORIGIN_AUTO);
/** 段体提取：段头可能带前置标注行（【读窗=…】），所以按**含**匹配而不是 startsWith。 */
const b5SectionOf = (card, head) => {
	const list = String(card).split("\n");
	const start = list.findIndex((line) => line.includes(head));
	if (start === -1) return [];
	const out = [];
	for (let index = start; index < list.length; index += 1) {
		if (index > start && list[index].includes("--- ")) break;
		out.push(list[index]);
	}
	return out;
};

// --- U20: attach 按队补挂（FR-10）----------------------------------------------
const U20_TEAM = "u20-legacy";
const u20Env = watchdogEnv({
	teams: [b5Team(U20_TEAM, B5_WS, [wb2Role("coordinator", "session-self"), wb2Role("worker-a", "u20-worker-a"), wb2Role("worker-b", "u20-worker-b")])],
});
await waitForChain(u20Env, 1);
await tick();
const u20Rows = b5Auto(u20Env);
const u20RowId = at(u20Rows, 0, {}).id;
/** 落过的 `watchdogs` 补丁数（U20 的「缺失才写」读数：创建那次恰一次，第二次提醒零次）。 */
const u20WatchdogWrites = () => u20Env.settings.namespaces.get("team-link").updates.filter((patch) => Object.prototype.hasOwnProperty.call(patch, "watchdogs")).length;
check("U20 attach 补挂: 名册里一个**无 auto 注册**的队 ⇒ attach 之后恰有一条 origin=auto —— watcher=该队现任协调者、team=队名、targets=除观察者外的全队成员（名册序）、巡检=auto 档 10min、TTL 在场，并且**拿到定时器**（不只是落一行账）",
	u20Rows.length === 1 && at(u20Rows, 0, {}).watcherSession === "session-self" && at(u20Rows, 0, {}).team === U20_TEAM
		&& Array.isArray(at(u20Rows, 0, {}).targets) && at(u20Rows, 0, {}).targets.join(",") === "u20-worker-a,u20-worker-b"
		&& at(u20Rows, 0, {}).intervalMinutes === 10 && at(u20Rows, 0, {}).silentMinutes === 10 && at(u20Rows, 0, {}).expiresAt > Date.now()
		&& typeof u20RowId === "string" && u20RowId.startsWith("wd-")
		&& u20Env.watchdog.timers.has(u20RowId));
// 幂等那一半：fast-path 上 attach 后置链会**提醒两次**（onAttach 登记时的即时一次 + 链尾一次），
// 两次 ensure 之后仍恰一条 —— 定向变异（删掉 ensureTeamAutoWatchdogs 里「已有行就跳过」那段）
// 实测落下 2 条 ⇒ 本条红，所以「恰一条」不是空锁。
check("U20 幂等: **再 attach 一次不新增** —— 后置链两次提醒（登记时 + 链尾）之后仍恰一条、id 未变、**并且第二次提醒一个字都没写**（缺失才写：`watchdogs` 补丁恰一次 = 创建那次）；链尾那一行 info 在场，证明第二次提醒真的发生过（否则本条会退化成「只挂了一次」的空锁）",
	b5Auto(u20Env).length === 1 && at(b5Auto(u20Env), 0, {}).id === u20RowId && u20WatchdogWrites() === 1
		&& u20Env.log.lines.info.filter((line) => line.includes("post-attach policy chain finished")).length === 1);
// 对照（负相，不冒充）：**缺席观察者**那一支 —— 名册里有队但没有现任协调者 ⇒ 一行都不写、
// 且不拖 attach 链（设计档 §9 的 fail-open 边界行）。
const U20_VACANT = "u20-vacant";
const u20VacantEnv = watchdogEnv({ teams: [b5Team(U20_VACANT, B5_WS, [wb2Role("coordinator", null), wb2Role("worker-a", "u20-worker-a")])] });
await waitForChain(u20VacantEnv, 1);
await tick();
check("U20 对照（fail-open）: 现任空缺的队 ⇒ 零注册、attach 链照常跑完（链尾 info 仍打出），不抛错、不拖链",
	b5Watchdogs(u20VacantEnv).length === 0
		&& u20VacantEnv.log.lines.info.filter((line) => line.includes("post-attach policy chain finished")).length === 1
		&& u20VacantEnv.log.lines.warn.filter((line) => line.includes("attach 按队补挂工作台注册失败")).length === 0);

// --- U21: patrol 每轮段同步 · 覆盖「现任协调者晚启动」（FR-11）---------------------
const U21_TEAM = "u21-late";
const U21_INCUMBENT = "u21-coordinator";
// 队里唯一的非现任成员**没有活代理**（只有名册行）—— 于是 attach 那一刻段注册器真的是空的；
// 晚启动的正是现任协调者本人（U21 要覆盖的那一档）。
const u21Env = watchdogEnv({
	teams: [b5Team(U21_TEAM, B5_WS, [wb2Role("coordinator", U21_INCUMBENT), wb2Role("worker-a", "u21-worker-absent")])],
});
await waitForChain(u21Env, 1);
await tick();
const u21Sections = __testing.sectionsFor(u21Env.ctx);
check("U21 前置①: 现任协调者的代理**还没出现**（attach 之后才启动）—— auto 注册照写（FR-10：现任不 live 也照写，它是补挂的对象而不是条件），而段注册器此刻为空（全仓没有代理出现钩子，这正是 FR-11 要补的缺口）",
	b5Auto(u21Env).length === 1 && at(b5Auto(u21Env), 0, {}).watcherSession === U21_INCUMBENT
		&& u21Sections.registered.size === 0 && u21Env.systemPrompt.live().length === 0);
const u21Created = await u21Env.agents.create({ sessionId: U21_INCUMBENT, meta: { cwd: B5_WS } });
check("U21 前置②: 代理确实出现了（活代理 + systemPrompt 面都在），但段仍然为空 —— 没有钩子，只有下一轮巡逻能补上",
	u21Created?.agent?.id === U21_INCUMBENT && u21Env.agentFor(U21_INCUMBENT) !== undefined
		&& typeof u21Env.agentFor(U21_INCUMBENT)?.ctx?.systemPrompt?.section === "function" && u21Sections.registered.size === 0);
await u21Env.watchdog.patrol({ now: Date.now() });
const u21Text = (() => { const record = at(u21Env.systemPrompt.live(), 0); return record === undefined ? "" : record.text({}); })();
check("U21 一个巡检间隔内拿到段（红相＝摘掉 patrol 里那句 sections.sync ⇒ 本条红）: 一轮巡逻之后晚启动的现任补上了 —— 注册表里 kind=coordinator、team 正确、段文本是协调者版宪章（点名团队与现任会话）；同时**没有**多挂一格（那条缺席的 worker 名册行不会被凭空注册）",
	u21Sections.registered.get(U21_INCUMBENT)?.kind === "coordinator" && u21Sections.registered.get(U21_INCUMBENT)?.team === U21_TEAM
		&& u21Text.startsWith("你是团队 " + U21_TEAM + " 的协调者（现任会话 " + U21_INCUMBENT + "）")
		&& u21Sections.registered.size === 1 && u21Env.systemPrompt.live().length === 1);

// --- U22: team_link_watch action=arm-team（FR-12）-------------------------------
const U22_TEAM = "u22-arm";
const U22_VACANT = "u22-vacant";
const U22_OUTSIDE = "u22-outside";
const u22Env = watchdogEnv({
	targets: { [U22_OUTSIDE]: { events: oneShotSurface(WD_NOW) } },
	teams: [
		b5Team(U22_TEAM, B5_WS, [wb2Role("coordinator", "session-self"), wb2Role("worker-a", "u22-worker-a"), wb2Role("worker-b", "u22-worker-b")]),
		b5Team(U22_VACANT, B5_WS, [wb2Role("coordinator", null), wb2Role("worker-a", "u22-other-worker")]),
	],
});
await waitForChain(u22Env, 1);
await tick();
const u22Tool = u22Env.tool("team_link_watch");
check("U22 描述面（模型可见）: 新动词进 action 枚举，描述正文同时写清「幂等补挂自己队」「非现任 / 队不在名册 ⇒ 拒绝并点名原因」「不占这 3 条手工额度」三件事 —— 描述面与实现面同一批更新（本仓「描述与代码不一致」的教训）",
	u22Tool.parameters.properties.action.enum.join(",") === "register,list,clear,arm-team"
		&& u22Tool.parameters.properties.team !== undefined
		&& u22Tool.description.includes("arm-team") && u22Tool.description.includes("幂等")
		&& u22Tool.description.includes("非现任") && u22Tool.description.includes("不占这 3 条手工额度"));
// 起点 = 「建队早于本功能的老团队 / 被 clear 过」的零注册态：用**既有 clear 命令**腾空（不直接改数据）。
const u22Cleared = String(await u22Tool.execute({ action: "clear" }, execFor(u22Env.senderAgent)));
check("U22 前置: clear 之后该队零注册（起点干净 —— 否则「新增一条」会被 attach 补挂的旧行顶替而假绿）",
	u22Cleared.includes("已清理") && b5Watchdogs(u22Env).length === 0);
const u22OutsideExec = execFor(u22Env.agentFor(U22_OUTSIDE));
const u22RefuseImplicit = String(await u22Tool.execute({ action: "arm-team" }, u22OutsideExec));
const u22RefuseExplicit = String(await u22Tool.execute({ action: "arm-team", team: U22_TEAM }, u22OutsideExec));
const u22RefuseUnknown = String(await u22Tool.execute({ action: "arm-team", team: "u22-nope" }, execFor(u22Env.senderAgent)));
const u22RefuseVacant = String(await u22Tool.execute({ action: "arm-team", team: U22_VACANT }, execFor(u22Env.senderAgent)));
check("U22 拒绝①（非现任 · 省略 team）: 点名原因（当前会话不是任何队的现任协调者 + 名册里各队的现任是谁），零写入",
	u22RefuseImplicit.includes("不是名册里任何团队的现任协调者") && u22RefuseImplicit.includes(U22_OUTSIDE)
		&& u22RefuseImplicit.includes("session-self") && b5Watchdogs(u22Env).length === 0);
check("U22 拒绝②（非现任 · 点名 team；红相＝放行非现任 ⇒ 本条红）: 点名该队现任会话与当前调用会话，零写入",
	u22RefuseExplicit.includes("补挂失败") && u22RefuseExplicit.includes("只有团队 " + U22_TEAM + " 的现任协调者会话 session-self")
		&& u22RefuseExplicit.includes(U22_OUTSIDE) && b5Watchdogs(u22Env).length === 0);
check("U22 拒绝③（队不在名册）: 点名「不在名册中」并列出已知团队，零写入",
	u22RefuseUnknown.includes("不在名册中") && u22RefuseUnknown.includes(U22_TEAM) && u22RefuseUnknown.includes(U22_VACANT)
		&& b5Watchdogs(u22Env).length === 0);
check("U22 拒绝④（coordinator 空缺）: 点名空缺 + writer gate 语义 + 指路设置 UI，零写入",
	u22RefuseVacant.includes("coordinator 角色当前空缺") && u22RefuseVacant.includes("writer gate 语义沿用")
		&& u22RefuseVacant.includes("设置 UI") && b5Watchdogs(u22Env).length === 0);
// 边界（设计档 FR-12 原文「非现任 ⇒ 拒绝」是无条件的，比 writerGate 紧一档）：writer=any 的队也只
// 受理它的现任协调者 —— 拒绝理由必须按档说，不能对 writer=any 的队念一句 coordinator 档的话。
const U22_ANY = "u22-any";
const u22AnyEnv = watchdogEnv({
	targets: { [U22_OUTSIDE]: { events: oneShotSurface(WD_NOW) } },
	teams: [b5Team(U22_ANY, B5_WS, [wb2Role("coordinator", "session-self"), wb2Role("worker-a", "u22-any-worker")], "any")],
});
await waitForChain(u22AnyEnv, 1);
await tick();
const u22AnyRowsBefore = b5Watchdogs(u22AnyEnv).length;
const u22AnyRefuse = String(await u22AnyEnv.tool("team_link_watch").execute({ action: "arm-team", team: U22_ANY }, execFor(u22AnyEnv.agentFor(U22_OUTSIDE))));
check("U22 边界（writer=any 的队）: 仍然只受理现任（比 writerGate 紧一档，且理由按档说 —— 不念那句 coordinator 档的话），零写入",
	u22AnyRefuse.includes("补挂失败") && u22AnyRefuse.includes("只有团队 " + U22_ANY + " 的现任协调者会话 session-self")
		&& u22AnyRefuse.includes("紧一档") && !u22AnyRefuse.includes("policy.writer=coordinator 时非现任拒写")
		&& b5Watchdogs(u22AnyEnv).length === u22AnyRowsBefore);

const u22First = String(await u22Tool.execute({ action: "arm-team" }, execFor(u22Env.senderAgent)));
const u22RowsFirst = b5Auto(u22Env);
check("U22 现任可用: 一条命令补挂 —— 恰一条 origin=auto（watcher=调用方=该队现任、targets=除它之外的队员），返回值点名注册 id 与目标（复用 FR-10 的 ensure，不另写一份；红相＝摘掉 arm-team 分支 ⇒ 本条红）",
	u22First.includes("已补挂工作台注册 wd-") && u22RowsFirst.length === 1
		&& at(u22RowsFirst, 0, {}).watcherSession === "session-self" && at(u22RowsFirst, 0, {}).team === U22_TEAM
		&& at(u22RowsFirst, 0, {}).targets.join(",") === "u22-worker-a,u22-worker-b"
		&& u22First.includes("u22-worker-a, u22-worker-b") && u22First.includes("幂等"));
const u22Second = String(await u22Tool.execute({ action: "arm-team" }, execFor(u22Env.senderAgent)));
check("U22 幂等: 第二次调用**不新增**（条数仍 1、id 未变）；判据钉的是「条数 + id」，返回值里那句「幂等：本次未新增」只作旁证（文案不能自证）",
	u22Second.includes("已有工作台注册") && u22Second.includes("幂等：本次未新增")
		&& b5Auto(u22Env).length === 1 && at(b5Auto(u22Env), 0, {}).id === at(u22RowsFirst, 0, {}).id);

// --- U23: 跨工作区读窗（FR-13）--------------------------------------------------
const U23_TEAM = "u23-cross";
const U23_TEAM_WS = path.join(TEAM_TMP, "u23-team-ws");
const U23_CALLER_WS = path.join(TEAM_TMP, "u23-caller-ws");
const U23_TEAM_PEER = "u23-team-peer";
const U23_CALLER_PEER = "u23-caller-peer";
/** 两个工作区各一条**活的**会话：调用方在 U23_CALLER_WS、团队在 U23_TEAM_WS —— 「列错人」
 * 在夹具里因此是**可见**的（不是靠另一个人根本不存在来冒充）。 */
const b5CrossEnv = (extra = {}) => setup({
	sessions: [
		{ header: { id: U23_TEAM_PEER, createdAt: 1000, cwd: U23_TEAM_WS }, live: true, persisted: true },
		{ header: { id: U23_CALLER_PEER, createdAt: 2000, cwd: U23_CALLER_WS }, live: true, persisted: true },
	],
	useSettings: true,
	selfCwd: U23_CALLER_WS,
	extraAgents: [{ id: U23_TEAM_PEER, status: "idle" }, { id: U23_CALLER_PEER, status: "idle" }],
	settingsSeed: { "team-link": { teams: [b5Team(U23_TEAM, U23_TEAM_WS, [wb2Role("coordinator", "session-self")])] } },
	...extra,
});
const b5StatusCard = async (env, team = U23_TEAM) => String(await env.tool("team_link_status").execute(team === null ? {} : { team }, execFor(env.senderAgent)));
const u23Env = b5CrossEnv();
await waitForChain(u23Env, 1);
await tick();
const u23Card = await b5StatusCard(u23Env);
const u23Note = "【读窗=团队工作区 " + U23_TEAM_WS + "】";
check("U23 支Ⅰ（宿主支持 cwd 子句：真签名 filterSessions(clauses, signal)，本仓 sessionQuery 夹具逐字镜像）: 段④/⑤/⑧ 只列**该队工作区**的会话 —— 团队工作区那条在场、调用方工作区那条**一个字都不出现**；段头如实标注读窗属于哪个工作区且**不带**降级后缀（红相＝把调用方窗口当成团队窗口 ⇒ 本条红）",
	u23Card.includes(u23Note + "--- 会话面（该队工作区其他会话")
		&& u23Card.includes(u23Note + "--- 活性")
		&& u23Card.includes(u23Note + "（第 ⑧ 段同一读窗）")
		&& u23Card.includes(U23_TEAM_PEER) && !u23Card.includes(U23_CALLER_PEER)
		&& !u23Card.includes("宿主不支持按工作区取窗")
		&& b5SectionOf(u23Card, "--- 会话面（该队工作区其他会话").some((line) => line.includes(U23_TEAM_PEER)));
// 对照（夹具不空转）：同一条会话走**列表工具**（调用方工作区口径）时看得见 —— 证明卡上看不见它
// 不是因为「它不存在 / 不可读」，而是因为读窗按团队工作区取。
const u23CallerList = String(await u23Env.tool("team_link_list_sessions").execute({}, execFor(u23Env.senderAgent)));
check("U23 对照（负相，不冒充）: 调用方工作区那条会话在**列表工具**里看得见、团队工作区那条看不见 —— 两张卡的口径差正是「按团队 workspace 取窗」这一件事本身",
	u23CallerList.includes(U23_CALLER_PEER) && !u23CallerList.includes(U23_TEAM_PEER));
// 支Ⅱ：宿主**没有** filterSessions 这个面（§9「宿主不支持按工作区取窗」的降级行）。
const u23NoFaceEnv = b5CrossEnv();
await waitForChain(u23NoFaceEnv, 1);
await tick();
delete u23NoFaceEnv.query.filterSessions;
const u23NoFaceCard = await b5StatusCard(u23NoFaceEnv);
// 支Ⅱ 的第二条到达路径：面在、但**不认 cwd 子句**（回了别的工作区的行）。
const u23IgnoreEnv = b5CrossEnv();
await waitForChain(u23IgnoreEnv, 1);
await tick();
u23IgnoreEnv.query.filterSessions = async () => u23IgnoreEnv.query.records;
const u23IgnoreCard = await b5StatusCard(u23IgnoreEnv);
const u23Degraded = "【读窗=团队工作区 " + U23_TEAM_WS + "；宿主不支持按工作区取窗 ⇒ 已就地过滤】";
check("U23 支Ⅱ（宿主无该面 / 面在不认子句，两条降级路径各一个夹具）: 仍然**不得列错人**（调用方工作区那条一个都不出现），且段头**如实标注**窗口口径与降级原因（fail-visible 不 fail-silent；红相＝去掉标注 ⇒ 本条红）",
	u23NoFaceCard.includes(u23Degraded + "--- 会话面（该队工作区其他会话") && u23NoFaceCard.includes(U23_TEAM_PEER) && !u23NoFaceCard.includes(U23_CALLER_PEER)
		&& u23NoFaceCard.includes(u23Degraded + "（第 ⑧ 段同一读窗）")
		&& u23IgnoreCard.includes(u23Degraded + "--- 会话面（该队工作区其他会话") && u23IgnoreCard.includes(U23_TEAM_PEER) && !u23IgnoreCard.includes(U23_CALLER_PEER));

// 支Ⅲ（task-28，lead 裁定 ③）: 「取不到团队 workspace」的**两条到达路径**也必须如实标注 ——
// 回退到调用方工作区是允许的，**静默**回退不是（这是 FR-13 使命的同一类风险，只是换了一条触发路径）。
const U23_NOWS = "u23-nows";
const U23_ELSEWHERE_WS = path.join(TEAM_TMP, "u23-elsewhere-ws");
const U23_ELSEWHERE_PEER = "u23-elsewhere-peer";
const b5CrossSessions = [
	{ header: { id: U23_CALLER_PEER, createdAt: 1000, cwd: U23_CALLER_WS }, live: true, persisted: true },
	{ header: { id: U23_ELSEWHERE_PEER, createdAt: 2000, cwd: U23_ELSEWHERE_WS }, live: true, persisted: true },
];
const b5CrossAgents = [{ id: U23_CALLER_PEER, status: "idle" }, { id: U23_ELSEWHERE_PEER, status: "idle" }];
// Ⅲ-a：该队**没有** workspace 记录（老团队 / 手写名册行的形状）⇒ 窗口只能是调用方工作区。
const u23NoWsEnv = setup({
	sessions: b5CrossSessions, useSettings: true, selfCwd: U23_CALLER_WS, extraAgents: b5CrossAgents,
	settingsSeed: { "team-link": { teams: [b5Team(U23_NOWS, "", [wb2Role("coordinator", "session-self"), wb2Role("worker-a", "u23-nows-worker")])] } },
});
await waitForChain(u23NoWsEnv, 1);
await tick();
const u23NoWsCard = await b5StatusCard(u23NoWsEnv, U23_NOWS);
check("U23 支Ⅲ-a（团队无 workspace 记录，task-28）: 回退这一支**也如实标注**（说清是回退 + 原因「该队无 workspace 记录」），段④/⑤/⑧ 三处都带这句，段头**不再**声称「该队工作区」（它跟着标注一起说成该队工作区就是把标注用成谎话）；窗口仍是调用方工作区那条，别的工作区一个都不出现 —— 红相＝去掉这句标注 ⇒ 本条红",
	u23NoWsCard.includes("【读窗=调用方工作区 " + U23_CALLER_WS + "（回退：该队无 workspace 记录）】--- 会话面（同工作区其他会话")
		&& u23NoWsCard.includes("（回退：该队无 workspace 记录）】--- 活性")
		&& u23NoWsCard.includes("（回退：该队无 workspace 记录）】（第 ⑧ 段同一读窗）")
		&& u23NoWsCard.includes(U23_CALLER_PEER) && !u23NoWsCard.includes(U23_ELSEWHERE_PEER)
		&& !u23NoWsCard.includes("该队工作区"));
// Ⅲ-b：聚合卡且所示团队的工作区**不止一个**（同一个 fetch 的另一条触发路径，同批补上，不留静默支）。
const u23MixedEnv = setup({
	sessions: b5CrossSessions, useSettings: true, selfCwd: U23_CALLER_WS, extraAgents: b5CrossAgents,
	settingsSeed: { "team-link": { teams: [
		b5Team("u23-mix-a", U23_TEAM_WS, [wb2Role("coordinator", "session-self")]),
		b5Team("u23-mix-b", U23_ELSEWHERE_WS, [wb2Role("coordinator", "session-self")]),
	] } },
});
await waitForChain(u23MixedEnv, 1);
await tick();
const u23MixedCard = await b5StatusCard(u23MixedEnv, null);
check("U23 支Ⅲ-b（聚合卡：所示团队的工作区不止一个，task-28 同批）: 同一类回退也如实标注（原因换成「工作区不止一个」），段头说「同工作区」（窗口确实是调用方工作区），别的工作区一个都不出现（红相＝去掉这句标注 ⇒ 本条同样红）",
	u23MixedCard.includes("【读窗=调用方工作区 " + U23_CALLER_WS + "（回退：所示 2 个团队的工作区不止一个）】--- 会话面（同工作区其他会话")
		&& u23MixedCard.includes("（回退：所示 2 个团队的工作区不止一个）】（第 ⑧ 段同一读窗）")
		&& u23MixedCard.includes(U23_CALLER_PEER) && !u23MixedCard.includes(U23_ELSEWHERE_PEER)
		&& !u23MixedCard.includes("该队工作区"));

rmSync(escDir, { recursive: true, force: true });
rmSync(tmpDir, { recursive: true, force: true });
rmSync(TEAM_TMP, { recursive: true, force: true });
// A 项：把本进程的临时根整个收掉（前三个 rmSync 保留原语义，这一行收尾不影响它们）。
rmSync(TEST_ROOT, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
// §9.6 ⑧: the run states its own assertion total, so the README figure (and any
// future changelog figure) is checkable against the run instead of remembered.
console.log(`assertion total: ${assertions} (failed: ${failures})`);
process.exit(failures === 0 ? 0 : 1);

/** Drive the agent/pre-step waterfall the way the loop does. */
async function ctx_waterfall(ctx, payload) {
	return ctx.waterfall({}, "agent/pre-step", payload, () => Promise.resolve({ kind: "enter", messages: [...payload.messages] }));
}

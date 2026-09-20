// Unit smoke test for the dsh-team-link host half: drives the
// registered agent/pre-step listener through a real cordis waterfall with a
// stubbed sessionReferenceResolver (upstream deep-link behavior, unchanged),
// then exercises the three -pro tools against stubbed services.
// Run after the node_modules junctions are in place (see README).
import { Context } from "@deepseek-ai/cordis";
import { existsSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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

// ---------------------------------------------------------------------------
// shared stubs
// ---------------------------------------------------------------------------

const CWD = "C:/dev/demo";

function makeSenderAgent(status, cwd = CWD) {
	const calls = { injected: [], steered: [], followedup: [] };
	const agent = {
		id: "session-self",
		status,
		session: { header: { id: "session-self", cwd } },
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
		session: { header: { id: "session-target", cwd: CWD } },
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
 * at all.
 *
 * `markDead()` (评审 round-2 🟡 #1) models a provider that is gone: the scopes it
 * handed out stop serving. No test flips it by hand — the provider is mounted
 * through a real cordis plugin fiber (see `provideSettingsFiber`) and the fiber's
 * own teardown effect is what retires the stub.
 */
function makeSettings(seed = {}, { settingsRegisterThrows = false, legacyRegisterThrows = false, legacyGetThrows = false } = {}) {
	const namespaces = new Map();
	let alive = true;
	const guard = () => { if (!alive) throw new Error("settings provider disposed (its fiber was torn down)"); };
	return {
		namespaces,
		markDead() { alive = false; },
		service: {
			register(namespace, _schema, options = {}) {
				if (settingsRegisterThrows) throw new Error("register refused by stub");
				if (legacyRegisterThrows && String(namespace) === "session-link-pro") throw new Error("legacy namespace refused by stub");
				guard();
				const isLegacy = String(namespace) === "session-link-pro";
				const state = { base: structuredClone(options.base ?? {}), data: structuredClone(seed[String(namespace)] ?? {}) };
				namespaces.set(String(namespace), state);
				return {
					get() {
						guard();
						if (isLegacy && legacyGetThrows) throw new Error("legacy namespace unreadable by stub");
						return { ...structuredClone(state.base), ...structuredClone(state.data) };
					},
					async update(patch) { guard(); Object.assign(state.data, structuredClone(patch)); },
				};
			},
		},
	};
}

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
				// state changes between the dialog opening and the write-back).
				const choice = typeof next === "function" ? await next() : next;
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
 * `resolve` (+ `standingKeyFor`) BEFORE `agents.create`, then `mount(agentCtx,
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
function makeAgentPresets({ defaultId = STUB_DEFAULT_PRESET, known = [STUB_DEFAULT_PRESET, "coder", "reviewer"] } = {}) {
	const resolved = [];
	const standings = [];
	const mounts = [];
	const notFound = (id) => new Error(`agent-presets: preset "${id}" not found (available: ${known.join(", ")})`);
	const service = {
		async resolve(id) {
			resolved.push(id);
			const wanted = id ?? defaultId;
			if (!known.includes(wanted)) throw notFound(wanted);
			return { id: wanted };
		},
		async standingKeyFor(id) {
			standings.push(id);
			return { agentPreset: id };
		},
		async mount(agentCtx, id) {
			if (agentCtx === undefined || agentCtx === null || typeof agentCtx.agentId !== "string") {
				throw new Error("agent-presets: refusing to compose an unscoped context; the scope key is what joins an agent to its preset");
			}
			if (!known.includes(id)) throw notFound(id);
			mounts.push({ agentId: agentCtx.agentId, id, ctx: agentCtx });
			return { id };
		},
	};
	return { service, resolved, standings, mounts, defaultId };
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
function makeWorkspaceRegistry({ refuseAttach = false, registerThenRefuse = false, normalize = (workspacePath) => workspacePath } = {}) {
	const creates = [];
	const attached = [];
	const detached = [];
	const workspaces = [];
	const service = {
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
function makeAgents(extraAgents, hidden, { failAt = -1, onCreated = undefined, actionLog = undefined, createDelayMs = 0, inFlight = undefined, resumeRecords = [], resumeCalls = [], resumeDelayMs = 0, resumedAgents = [] } = {}) {
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
			if (typeof sessionId !== "string" || !resumeRecords.some((record) => record.header?.id === sessionId)) {
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
				session: { header: { id: sessionId, cwd: CWD }, requestHeader: () => undefined },
				inject(message) { calls.injected.push(message); },
				steer(message) { calls.steered.push(message); },
				followup(message) { calls.followedup.push(message); actionLog?.push("followup"); },
			};
			created.push({ agent, calls, options });
			extraAgents.push(agent);
			// A resumed session is LIVE again, so it stops being "hidden": that is
			// exactly the observation §11.9.4 rests on ("复活后 writerGate 按 id 比对
			// 直接放行"), and it has to move together with the publication above or the
			// A4 fixture would keep reporting the session as closed.
			hidden.delete(sessionId);
			resumedAgents.push(agent);
			if (typeof options.setup === "function") {
				const setupCalls = { requests: [] };
				// The fixture's stand-in for the agent's SCOPE identity. The real
				// service binds `scopeOf(agentCtx)`, and that binding IS the agent's
				// persona-prefix composition source; without an identity on the
				// context this stub could only answer "did some mount happen", which
				// is the exact confusion DEFECT-1 is about (「建出来了」 ≠ 「能用」).
				const agentCtx = { agentId: options.sessionId, on(event, listener) { setupCalls[event] = listener; return () => {}; } };
				await options.setup(agentCtx, agent);
				agent.setupCalls = setupCalls;
				agent.setupCtx = agentCtx;
			}
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
				const agentCtx = { agentId: options.sessionId, on(event, listener) { setupCalls[event] = listener; return () => {}; } };
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
		/** Mutable persisted-session rows: `listSessions` reads this list, so a case
		 * can add the row a runtime-created session gets at its first checkpoint. */
		records: sessions,
		async listSessions(_signal) { return query.records; },
		async readTitleSnapshots(ids, _signal) {
			return ids.map((id) => ({ status: "fulfilled", value: { session: { id }, title: id === "session-target" ? "目标会话" : id === "session-runner" ? "跑着呢" : undefined } }));
		},
		async readSession(id) {
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

/** One macrotask of slack: enough for cordis' async fiber work and for the
 * attach-time policy chain (which is fire-and-forget by design) to settle. */
const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

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
function setup({ sessions = [], eventsBySession = {}, askScript = [], targetStatus = "idle", contextText = "SNIPPET", omitContext = false, goals, extraAgents = [], selfStatus, useSettings = false, lateSettings = false, lateWebServer = false, noInject = false, settingsSeed, settingsRegisterThrows = false, legacyRegisterThrows = false, legacyGetThrows = false, selfCwd, omitUserQuestions = false, surfaceReadHook, webServerWithoutRegister = false, omitCommands = false, lateCommands = false, omitAgentPresets = false, omitWorkspaceRegistry = false, workspaceRegistryOptions = undefined, failCreateAt = -1, createdHook = undefined, actionLog = [], pendingSeed = undefined, createDelayMs = 0, omitResume = false, resumeDelayMs = 0 } = {}) {	const ctx = new Context();
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
	const registeredTools = [];
	const routes = [];
	const { agent: senderAgent, calls: senderCalls } = makeSenderAgent(selfStatus, selfCwd ?? CWD);
	const { agent: targetAgent, calls: targetCalls } = makeTargetAgent(targetStatus);
	const runnerAgent = { id: "session-runner", status: "running", session: { header: { id: "session-runner", cwd: CWD } } };
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
	const agentFactory = makeAgents(createdAgents, hidden, { failAt: failCreateAt, onCreated: createdHook, actionLog, createDelayMs, inFlight: createInFlight, resumeRecords, resumeCalls, resumeDelayMs, resumedAgents });
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
		 * them) and publishes a live root agent under the requested session id. */
		create: agentFactory.create,
	};
	if (!omitResume) agents.resume = agentFactory.resume;
	// The persisted-session list the resume face loads from: the declared sessions
	// plus every stub agent's own session (a stub agent stands for a session that
	// exists on disk — that is what makes "hidden ⇒ still resumable" the honest
	// fixture for §11.9.4).
	resumeRecords.push(...sessions, ...[senderAgent, targetAgent, runnerAgent, ...extraAgentObjects].map((agent) => ({ header: { id: agent.id, cwd: agent.session?.header?.cwd ?? CWD }, live: !hidden.has(agent.id), persisted: true })));
	const uq = makeUserQuestions(askScript);
	const settings = useSettings || lateSettings
		? makeSettings(pendingSeed === undefined ? settingsSeed : { ...(settingsSeed ?? {}), "team-link": { ...((settingsSeed ?? {})["team-link"] ?? {}), pendingCreates: [...((settingsSeed ?? {})["team-link"]?.pendingCreates ?? []), ...(Array.isArray(pendingSeed) ? pendingSeed : [pendingSeed])] } }, { settingsRegisterThrows, legacyRegisterThrows, legacyGetThrows })
		: undefined;	ctx.provide("sessionReferenceResolver", resolver);
	ctx.provide("tools", { register(tool) { registeredTools.push(tool); return () => {}; } });
	const query = makeQuery(sessions, eventsBySession, surfaceReadHook);
	ctx.provide("sessionQuery", query);
	ctx.provide("agents", agents);
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
	// so one warn per created session must say so and the session must still exist).
	const agentPresets = makeAgentPresets();
	if (!omitAgentPresets) ctx.provide("agentPresets", agentPresets.service);
	// §10.2.2 模板的另一半（真机缺陷 #2）：会话建完要**挂进工作区**，否则侧边栏按
	// 工作区分组时列不出它。与 agentPresets 同款——可选服务、创建时 `ctx.get`、默认
	// 提供（真实宿主有它）；`omitWorkspaceRegistry` 是降级 fixture，`normalize` 是
	// 「meta.cwd 真的来自 registry 的 path」的可观测 fixture。
	const workspaceRegistry = makeWorkspaceRegistry(workspaceRegistryOptions ?? {});
	if (!omitWorkspaceRegistry) ctx.provide("workspaceRegistry", workspaceRegistry.service);
	apply(ctx);
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
	return { ctx, prepared, setFailWith: (error) => { failWith = error; }, setHiddenAgent: (id, value) => { if (value) hidden.add(id); else hidden.delete(id); }, setScript: (entry) => { uq.script.push(entry); }, registeredTools, routes, senderAgent, senderCalls, targetAgent, targetCalls, uq, tool, settings, log, query, provideSettings, provideSettingsFiber, provideWebServer, provideCommands, agentPresets, workspaceRegistry, agentFor: (id) => agents.get(id), extraCalls, commands, created: agentFactory.created, creates: agentFactory.creates, actionLog, invoke, maxCreateInFlight, resumeCalls, resumeRecords, resumedAgents, agents };
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
check("export route registered", env.routes.length === 1 && env.routes[0].kind === "exact" && env.routes[0].path === "/team-link/export");

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
const tmpDir = path.resolve(".test-tmp");
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
const escDir = path.resolve(".test-tmp-escape");
rmSync(escDir, { recursive: true, force: true });
const escOut = await escEnv.tool("team_link_export").execute({ sessionId: "../../escaped", outputDir: escDir }, execFor(escEnv.senderAgent));
const escFiles = escOut.split("\n").map((line) => line.replace("- ", "").trim()).filter((line) => line.endsWith(".md") || line.endsWith(".json"));
check("评审 #2: the export tool and the download route share one filename invariant — a traversal-shaped id is written inside the export dir under the sanitised name", escFiles.length === 2 && escFiles.every((file) => path.dirname(path.resolve(file)) === escDir && /^\.\._\.\._escaped-\d{8}-\d{6}\.(md|json)$/u.test(path.basename(file))) && !existsSync(path.resolve(escDir, "..", "escaped-")));

const routeEnv = setup({ sessions: [{ header: { id: "../../escaped", createdAt: 1000, cwd: CWD }, live: true, persisted: true }], eventsBySession: { "../../escaped": escEvents } });
const exportRoute = routeEnv.routes.find((route) => route.path === "/team-link/export");
let routeResult;
await exportRoute.handler({ url: "/team-link/export?session=../../escaped&format=md" }, { writeHead(code, headers) { routeResult = { code, headers }; }, end() {} });
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
const truncDir = path.resolve(".test-tmp-lone");
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
function watchdogEnv({ goals = {}, targets = {}, selfStatus, selfGoal } = {}) {
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

const TEAM_TMP = path.resolve(".test-tmp-team");
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
function teamEnv({ teams = [], askScript = [], omitUserQuestions = false, selfCwd = TEAM_WS, extraAgents = [] } = {}) {
	const env = setup({ sessions: [], useSettings: true, askScript, selfCwd, omitUserQuestions, extraAgents });
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

const boardEnv = teamEnv({ teams: [teamRow({ current: "session-self" })] });
const boardRead = boardEnv.tool("team_link_team_read");
const boardAppend = boardEnv.tool("team_link_team_append");
rmSync(decisionsPath, { force: true });
rmSync(disciplinePath, { force: true });

const freshRead = await boardRead.execute({ team: "night-shift" }, execFor(boardEnv.targetAgent));
check("team_read is open to any session and reports absent files honestly instead of failing", freshRead.includes("团队 night-shift 黑板") && freshRead.includes("（文件不存在，按空处理：0 条）") && freshRead.includes("（文件不存在，按空处理）baseHash=") && freshRead.includes("（空）"));
check("team_read hands back a baseHash for both files even when they are absent", (freshRead.match(/baseHash=[0-9a-f]{16}/gu) ?? []).length === 2 && freshRead.includes(`baseHash=${hashOf("")}`));
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
// B1 (差异审计): the row detail is the per-target result sentence — the same
// source the text report prints — but the report may append a CALL-level note
// ("注意：meta.ref 超过 16 字符…", see the U7 case above) that is not a per-target
// result line and so is deliberately NOT copied into the row. The claim is
// therefore "identical until the envelope note"; the boundary is pinned from
// both sides right below.
check("U13: the row detail is the SAME sentence the text report prints (identical while no envelope note is appended)", receiptCard.targets[0].detail === receiptText && !receiptText.includes("注意："));
check("U13: a literal session id is not an addressing expression, so the row carries no expr", receiptCard.targets[0].expr === undefined);
// B1's other side: with a truncated envelope ref the report grows a call-level
// note, and the row must NOT — the note is not that target's result line, and the
// fan-out path keeps it out of every row the same way (`report.lines.push`).
const notedEnv = fanEnv({ pairs: [pairSelf("session-worker-a")] });
const notedArgs = { targetSessionId: "session-worker-a", message: "带长引用", meta: { ref: "r".repeat(17) } };
const { value: notedText, card: notedCard } = await sendWithCard(notedEnv, notedArgs, execFor(notedEnv.senderAgent));
check("B1: a truncated meta.ref appends its note to the TEXT report (the U7 behavior the card deliberately does not copy)", notedText.includes("注意：meta.ref 超过 16 字符（原 17 字符）"));
check("B1: ... while the row detail stays the per-target sentence — the report's FIRST line, with the note left out", notedCard.targets[0].detail === notedText.split("\n")[0] && !notedCard.targets[0].detail.includes("注意：") && notedCard.targets[0].detail !== notedText);
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
function rotateEnv({ askScript = [], omitUserQuestions = false, pairs = [], trustedSenders = [], rememberTargets = [], blockedSenders = [], receiveMode = "accept", goals, teams, failCreateAt = -1, omitCommands = false, lateCommands = false, omitAgentPresets = false, omitWorkspaceRegistry = false, omitResume = false, extraAgents = undefined } = {}) {
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
		// SAME `buildTeamSessionCreateOptions`).
		omitAgentPresets,
		// §10.2.2 模板的另一半（真机缺陷 #2）：auto 路径建继任者也走同一个
		// `createRootAgent` ⇒ 工作区挂载同样要在这儿有它的降级 fixture。
		omitWorkspaceRegistry,
		// §11.9.4 L1's two fixtures: `omitResume` is the documented "no factory /
		// no session persistence" failure mode, and the stub's own record/hidden
		// bookkeeping is what the revive cases read.
		omitResume,
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
const declareDormantSession = (env, sessionId) => {
	env.resumeRecords.push({ header: { id: sessionId, cwd: TEAM_WS }, live: false, persisted: true });
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
const reviveTeam = (roles) => [{ name: "night-shift", createdAt: 1_700_000_000_000, workspace: REVIVE_ROOT, policy: { writer: "coordinator" }, roles }];
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

check("U26 revive: 插件自建会话（id 文法 team-link-<team>-<role>-<uuid8>，重载后已无 handle）→ resume 同一个 id，身份不变、roster 不动、信任零改动", reviveEnv.resumeCalls.length === 1 && reviveEnv.resumeCalls[0].resumeSessionId === REVIVE_PLUGIN_ID && Object.keys(reviveEnv.resumeCalls[0]).length === 1 && revivePost.current === revivePre.current && revivePost.pending === null && sameJson(revivePost.history, revivePre.history) && (reviveEnv.ns.data.pairs ?? []).length === 0 && reviveOut.includes("已恢复（revive）") && reviveOut.includes("身份不变"));
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

check("U26 留痕①版本史: 恢复记录落进 role 行的 recoveries（verb/from/to/at/by/note），note 用固定措辞并具名发起者，且**同一笔**更新占用限速戳 rotationAt", revivePost.recoveries.length === 1 && revivePost.recoveries[0].verb === "revive" && revivePost.recoveries[0].from === REVIVE_PLUGIN_ID && revivePost.recoveries[0].to === REVIVE_PLUGIN_ID && revivePost.recoveries[0].by === "session-worker-a" && revivePost.recoveries[0].at > 0 && revivePost.recoveries[0].note.includes("recovery(revive, vacant-due-to-death,") && revivePost.recoveries[0].note.includes("requester=session-worker-a") && revivePost.rotationAt === revivePost.recoveries[0].at);
check("U26 留痕②roster.md: 镜像渲染恢复记录（与 roster get 同源），且镜像里仍然没有任何活性读数——版本史备注用的是设计自己的理由词 vacant-due-to-death，不是 seated-dead", reviveMirror.includes("恢复记录") && reviveMirror.includes(`revive　${REVIVE_PLUGIN_ID} → ${REVIVE_PLUGIN_ID}`) && reviveMirror.includes("vacant-due-to-death") && reviveMirror.includes("requester=session-worker-a") && !reviveMirror.includes("seated-dead") && !reviveMirror.includes("活性诊断"));
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

const reviveScopeOut = await reviveTool.execute({ action: "revive", team: "night-shift", role: "worker-a" }, execFor(reviveEnv.agentFor("session-worker-a")));
check("U26 窄域: 本工具只为 coordinator 恢复，别的角色明确拒绝并说清为什么（硬死锁只有一格，别的格子有既有的活路：retire + set-role）", reviveScopeOut.includes("本工具只为 coordinator 角色恢复") && reviveScopeOut.includes("硬死锁只有一格") && reviveScopeOut.includes("retire + set-role"));

const reviveDiagEnv = rotateEnv({ askScript: [], teams: reviveTeam([
	{ role: "coordinator", current: REVIVE_PLUGIN_ID, pending: null, history: [] },
	{ role: "worker-a", current: "session-worker-a", pending: null, history: [] },
]) });
reviveDiagEnv.setHiddenAgent(REVIVE_PLUGIN_ID, true);
const reviveDiag = await reviveDiagEnv.tool("team_link_recover").execute({ action: "revive", team: "night-shift" }, execFor(reviveDiagEnv.agentFor("session-target")));
check("U26 诊断读态: 不带 role → 每角色一行（现任 + 活性 + 在飞令牌）+ 恢复入口 + 硬死锁只有一格，**零副作用**（无确认框、无 resume、无写入）", reviveDiag.includes("恢复诊断") && reviveDiag.includes("零副作用") && reviveDiag.includes("角色 coordinator") && reviveDiag.includes("seated-dead（无活代理）") && reviveDiag.includes("角色 worker-a") && reviveDiag.includes("有活代理") && reviveDiag.includes("（无在飞令牌）") && reviveDiag.includes("硬死锁只有一格") && reviveDiagEnv.uq.requests.length === 0 && reviveDiagEnv.resumeCalls.length === 0 && (reviveDiagEnv.role().recoveries ?? []).length === 0);

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
const reapOut = await reapTool.execute({ action: "reappoint", team: "night-shift", role: "coordinator" }, execFor(reapEnv.agentFor("session-worker-a")));

check("U27 候选由插件算: 对话框的选项就是本队**活成员**（排除死现任那个角色自己），调用方没有任何参数能指定继任者 id", (() => {
	const ask = reapEnv.uq.requests[0];
	return ask !== undefined
		&& ask.questions.length === 1
		&& ask.questions[0].id === "recovery-confirm"
		&& ask.questions[0].multiSelect === true
		&& ask.questions[0].options.map((option) => option.label).join(",") === "session-worker-a,session-worker-b"
		&& ask.questions[0].question.includes("由插件从**本队活成员**算出")
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
	return entry.recoveries.length === 1 && entry.recoveries[0].verb === "reappoint" && entry.recoveries[0].from === REAP_DEAD && entry.recoveries[0].to === "session-worker-b" && entry.recoveries[0].by === "session-worker-a" && entry.recoveries[0].note.includes("recovery(reappoint, vacant-due-to-death,") && entry.rotationAt === entry.recoveries[0].at;
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

const reapDeadCandidateEnv = rotateEnv({ askScript: [], teams: reapTeam(reapRoles()), extraAgents: reapAgents() });
reapDeadCandidateEnv.setHiddenAgent(REAP_DEAD, true);
reapDeadCandidateEnv.setScript(() => {
	// The candidate died while the box was open.
	reapDeadCandidateEnv.setHiddenAgent("session-worker-a", true);
	return ["session-worker-a"];
});
const reapDeadCandidate = await reapDeadCandidateEnv.tool("team_link_recover").execute({ action: "reappoint", team: "night-shift", role: "coordinator" }, execFor(reapDeadCandidateEnv.agentFor("session-worker-b")));
check("U27 TOCTOU（候选侧）: 候选在确认期间死亡 → 中止（否则写入它会原地再造一个死结），零令牌、零 freeze、零写入", reapDeadCandidate.includes("已经没有活动代理了") && reapDeadCandidate.includes("原地再造一个死结") && reapDeadCandidateEnv.role().pending === null && (reapDeadCandidateEnv.role().recoveries ?? []).length === 0);

const reapAllDeadEnv = rotateEnv({ askScript: [["session-worker-a"]], teams: reapTeam(reapRoles()) });
for (const id of [REAP_DEAD, "session-worker-a", "session-worker-b"]) reapAllDeadEnv.setHiddenAgent(id, true);
const reapAllDead = await reapAllDeadEnv.tool("team_link_recover").execute({ action: "reappoint", team: "night-shift", role: "coordinator" }, execFor(reapAllDeadEnv.agentFor("session-target")));
check("U27 全队皆死（重载团灭）: 候选集为空 → 明确说「没有活着的其他角色成员」并给出 revive / 侧边栏 / 设置 UI 三条路，零副作用、连确认框都不弹", reapAllDead.includes("没有活着的其他角色成员") && reapAllDead.includes("team_link_recover action=revive") && reapAllDead.includes("侧边栏") && reapAllDead.includes("设置 UI") && reapAllDead.includes("零副作用") && reapAllDeadEnv.uq.requests.length === 0 && reapAllDeadEnv.role().pending === null);

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

// §11.9.5①: the whole surface stays two verbs, and the second one does not grow a
// "write any roster field" cousin.
check("U29 红线: 恢复路径不新增日志事件类型——宿主动作仍只有既有的几种（settings 写 + 确认框 + 广播投递 + resume，本轮没有第四种），writerGate 原样，policy 的顶层键一个不多", reapEnv.actionLog.every((entry) => entry === "create" || entry === "followup" || entry === "resume") && __testing.writerGate.length === 2 && sameJson(Object.keys(reapEnv.ns.data).sort(), ["blockedSenders", "pairs", "receiveMode", "rememberTargets", "teams", "trustedSenders"]));
check("U29 schema: 恢复没有新增任何顶层 policy key（recoveries 是 role 行内字段）——八项一个不多", sameJson(Object.keys(reapEnv.settings.namespaces.get("team-link").base).sort(), ["blockedSenders", "pairs", "pendingCreates", "receiveMode", "rememberTargets", "teams", "trustedSenders", "watchdogs"]) && reapEnv.role().recoveries !== undefined && reapEnv.ns.data.recoveries === undefined);

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
// 同改清单锁（② 轮「同一清单两处写、只改了一处」的教训）：README 里的工具计数必须
// 等于**实际注册的工具数**——加一个工具而忘了改 README（或反过来）在这里立刻变红。
const README_TOOL_COUNT = /(\d+) 个工具 \+ 2 条 \/ 命令/u.exec(handoffReadme)?.[1];
check("§11.9 文档面=实现面（工具计数同改锁）: README 架构图里写的工具数 == 实际注册的工具数（加/删工具而不同改文档即红）", README_TOOL_COUNT !== undefined && Number(README_TOOL_COUNT) === diagEnv.registeredTools.length && diagEnv.registeredTools.length === 9 && diagEnv.registeredTools.some((tool) => tool.name === "team_link_recover"));

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
check("U9 对照 (webServer): the same late-attach pattern mounts the export route once the provider appears", lateWsEnv.routes.length === 1 && lateWsEnv.routes[0].kind === "exact" && lateWsEnv.routes[0].path === "/team-link/export");

// Data consistency across the same window (§9.1.3 数据一致性, defensive redundancy):
// the memory engine can only be written before the attach. If that happens, the
// write must be folded into settings rather than silently dropped.
const memWindowEnv = setup({ sessions: [], lateSettings: true, lateCommands: true, selfCwd: TEAM_WS });
const memWindowOut = await memWindowEnv.tool("team_link_roster").execute({ action: "upsert-team", team: "night-shift" }, execFor(memWindowEnv.senderAgent));
check("U9 对照 (数据一致性): a write inside the startup window is served by the memory engine (no settings namespace exists yet)", memWindowOut.includes("已创建团队 night-shift") && memWindowEnv.settings.namespaces.size === 0);
await memWindowEnv.provideSettings();
check("U9 对照 (数据一致性): the window's write is folded into the settings namespace at attach instead of being dropped, with one line saying so", (memWindowEnv.settings.namespaces.get("team-link")?.data.teams ?? []).length === 1 && memWindowEnv.log.lines.warn.some((line) => line.includes("memory-only startup window")) && memWindowEnv.log.lines.info.filter((line) => line.includes("policy store attached")).length === 1);

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
const pendingFoldId = pendingFoldEnv.creates[1].sessionId;
check("U9 对照 (pendingCreates) 前置: worker-b's create fails, so its intent is never resolved — the write the fold has to carry is the ONLY in-memory intent", pendingFoldEnv.creates.length === 2 && pendingFoldOut.kind === "error" && pendingFoldEnv.settings.namespaces.size === 0);
await pendingFoldEnv.provideSettings();
await tick();
const pendingFoldNs = pendingFoldEnv.settings.namespaces.get("team-link");
check("U9 对照 (pendingCreates) 前置: the fold itself happened — the window's roster write reached the namespace (so a missing intent below cannot be blamed on a fold that never ran)", (pendingFoldNs?.data.teams ?? []).map((team) => team.name).join(",") === "night-shift" && pendingFoldEnv.log.lines.warn.some((line) => line.includes("memory-only startup window")));
check("U9 对照 (pendingCreates): a §10.2.6 intent written inside the startup window SURVIVES the fold into the settings namespace — the durable orphan record the next boot's sweep reports is not dropped by adopting the window", (pendingFoldNs?.data.pendingCreates ?? []).length === 1 && (pendingFoldNs?.data.pendingCreates ?? [])[0].sessionId === pendingFoldId && (pendingFoldNs?.data.pendingCreates ?? [])[0].role === "worker-b" && (pendingFoldNs?.data.pendingCreates ?? [])[0].team === "night-shift");
check("U9 对照 (pendingCreates): the folded rows are the window's own normalized rows — every field of the intent survived, not just its presence", (pendingFoldNs?.data.pendingCreates ?? []).length === 1 && (pendingFoldNs?.data.pendingCreates ?? []).every((entry) => entry.createdAt > 0 && entry.expiresAt > entry.createdAt && entry.by === "session-self" && Object.keys(entry).sort().join(",") === "by,createdAt,expiresAt,role,sessionId,team"));
check("U9 对照 (pendingCreates): the fold is the wholesale write {@link policyIsAtDefaults} licenses, so it carries all EIGHT policy keys — the new one beside the seven that pre-date ②, with the window's roster and the pair granted for the one worker that WAS created inside them", sameJson(Object.keys(pendingFoldNs?.data ?? {}).sort(), ["blockedSenders", "pairs", "pendingCreates", "receiveMode", "rememberTargets", "teams", "trustedSenders", "watchdogs"]) && (pendingFoldNs?.data.teams ?? []).length === 1 && (pendingFoldNs?.data.pairs ?? []).length === 1 && (pendingFoldNs?.data.pairs ?? [])[0].b === pendingFoldEnv.creates[0].sessionId);

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
check("U10: the tool surface has no `coordinator` parameter (§9.2.2 不新增 API 面), and an undeclared id cannot seed the role — the seed is always the calling session", Object.keys(u10Roster.parameters.properties).sort().join(",") === "action,note,role,session,team" && teamStore(u10Env).find((team) => team.name === "day-shift")?.roles[0].current === "session-self" && !String(u10ExtraArg).includes("session-target"));
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
check("🟡 #1: disposing the provider's fiber releases the scope — one line says the store is memory-only again", deadEnv.log.lines.info.some((line) => line.includes("settings scope released with its owner fiber") && line.includes("memory-only")));

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
const refoldFolds = () => refoldEnv.log.lines.warn.filter((line) => line.includes("memory-only startup window"));
const refoldProvider = await refoldEnv.provideSettingsFiber();
await tick();
check("🔵 #3 前置: window 1's memory write is folded into the namespace exactly once, with one warn and the matching chain token", (refoldEnv.settings.namespaces.get("team-link")?.data.teams ?? []).map((team) => team.name).join(",") === "window-one" && refoldFolds().length === 1 && refoldEnv.log.lines.info.some((line) => line.includes("memory window: folded into settings")));
await refoldProvider.dispose();
await tick();
// A brand-new provider whose namespace is empty — the shape that used to be
// re-fed the previous window's memory state.
const refoldFresh = makeSettings();
await refoldEnv.provideSettingsFiber(refoldFresh);
await tick();
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
function teamSessionEnv({ teams = [], askScript = [], omitUserQuestions = false, omitCommands = false, lateCommands = false, omitAgentPresets = false, omitWorkspaceRegistry = false, workspaceRegistryOptions = undefined, failCreateAt = -1, selfCwd = TEAM_WS, createdHook = undefined, actionLog = [], pendingSeed = undefined } = {}) {
	const env = setup({ sessions: [], useSettings: true, askScript, selfCwd, omitUserQuestions, omitCommands, lateCommands, omitAgentPresets, omitWorkspaceRegistry, workspaceRegistryOptions, failCreateAt, createdHook, actionLog, pendingSeed });
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
check("U16: the definition declares a hint (CommandInputDescriptor has no other grammar field) and no attachment channel", cmdEnv.commands.command("team_session").input.hint.includes("n=") && cmdEnv.commands.command("team_session").input.hint.includes("roles=") && cmdEnv.commands.command("team_session").input.hint.includes("task=") && cmdEnv.commands.command("team_session").input.attachments === false);
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
check("U16 解析: positional role names are collected into `bare` AND folded into `roles`, in the order written", parsedBare.error === undefined && parsedBare.value.bare.join(",") === "night-shift,worker-a,worker-b" && parsedBare.value.roles.join(",") === "night-shift,worker-a,worker-b" && readTeamSessionCommand("team=t task=统一任务").value.task === "统一任务");
// The gaps this batch closes, at the parser level. Both were RED before:
// positional names reached `bare` and stopped there (the plan never read it), and
// `task=` was split on whitespace with only a whole-token quote pair stripped.
check("U16 解析: the positional bucket is not a dead end — `team=t worker-a worker-b` puts both roles in the request the plan reads", (() => { const parsed = readTeamSessionCommand("team=t worker-a worker-b"); return parsed.roles === undefined && parsed.value.roles.join(",") === "worker-a,worker-b"; })());
check("U16 解析: `task=` runs to the END OF THE LINE, so an unquoted multi-word task is not truncated (pre-fix: task=「fix」 and the words `the`/`bug` landed in the ignored bare bucket)", (() => { const parsed = readTeamSessionCommand("team=t roles=a task=fix the bug"); return parsed.error === undefined && parsed.value.task === "fix the bug" && parsed.value.bare.length === 0; })());
check("U16 解析: a quoted task value is unwrapped — `task=\"fix the bug\"` carries no quote characters (pre-fix: the value kept both quotes)", (() => { const parsed = readTeamSessionCommand("team=t roles=a task=\"fix the bug\""); return parsed.error === undefined && parsed.value.task === "fix the bug" && !parsed.value.task.includes("\""); })());
check("U16 解析: the unwrapping covers every key — `team=\"t\" roles=\"a,b\"` reads like the unquoted form (pre-fix: both values kept their quotes, and roles split to `\"a`/`b\"`)", (() => { const parsed = readTeamSessionCommand("team=\"t\" roles=\"a,b\""); return parsed.error === undefined && parsed.value.team === "t" && parsed.value.roles.join(",") === "a,b"; })());
check("U16 解析: a half-quoted value is REFUSED, never guessed at (task= both sides of the closing quote)", readTeamSessionCommand("team=t roles=a task=\"a\"b").error.includes("引号不成对"));
check("U16 解析: team= stays REQUIRED — a line of positional role names alone is refused by the plan with the missing team named, not silently seated under the first name", (() => { const parsed = readTeamSessionCommand("worker-a worker-b"); const planned = teamSessionPlan(parsed.value, []); return parsed.error === undefined && parsed.value.roles.join(",") === "worker-a,worker-b" && planned.error.includes("需要 team（团队名）"); })());
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
check("U16 确认框: the body carries the counts, the model/preset, the cwd and the conservative cost口径", cancelledQuestion.question.includes("将创建 2 个 worker 根会话") && cancelledQuestion.question.includes("工作目录（cwd）：") && cancelledQuestion.question.includes("成本口径（保守）") && cancelledQuestion.question.includes("2 个会话 × 至少一个完整回合"));
check("U16 确认框: ... and the pairing grant is written out BEFORE it exists (信任授予不得默默发生)", cancelledQuestion.question.includes("建立 pairs 配对——双向免确认通道") && cancelledQuestion.question.includes("预置配对") && cancelledQuestion.question.includes("绕过发送方审批与接收方 ask 两道门"));
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
check("U16 端到端: a run with a CLI-entered model= reaches both agentOptions and the dialog's model line", okEnv.creates.every((options) => options.agentOptions?.provider === "deepseek" && options.agentOptions?.model === "deepseek-v4") && okEnv.creates.every((options) => options.meta.agentPreset === "coder") && okEnv.uq.requests[0].questions[0].question.includes("model=deepseek-v4"));

// --- U16 端到端（文法面）: a REAL command, through the handler ----------------
// The gaps of this batch are end-to-end or they are nothing: the parser's
// positional bucket was never read by the plan, so a plan-level assertion is the
// only honest one. Each case below enters the real command face and asserts on
// what the run actually created.
const grammarEnv = teamSessionEnv({ askScript: ["创建"] });
const grammarOut = await grammarEnv.run("team=night-shift worker-a worker-b task=fix the bug");
check("U16 端到端文法: positional role names alone create exactly those sessions (pre-fix: the plan refused with 「需要角色列表」 and nothing was created)", grammarEnv.creates.length === 2 && grammarEnv.creates.map((options) => options.sessionId).every((id) => /^team-link-night-shift-worker-[ab]-[0-9a-f]{8}$/u.test(id)) && grammarEnv.store()[0].roles.map((entry) => entry.role).sort().join(",") === "coordinator,worker-a,worker-b" && grammarOut.kind === "success");
check("U16 端到端文法: the unquoted multi-word task reaches the kickoff message whole (pre-fix: the worker was driven with 「fix」)", grammarEnv.created.length === 2 && grammarEnv.created.every((item) => item.calls.followedup.length === 1 && item.calls.followedup[0].content[0].text.includes("fix the bug")));
const quotedRunEnv = teamSessionEnv({ askScript: ["创建"] });
await quotedRunEnv.run("team=night-shift roles=worker-a task=\"fix the bug\"");
check("U16 端到端文法: a quoted task value reaches the kickoff message with no quote characters left in it", quotedRunEnv.created.length === 1 && quotedRunEnv.created[0].calls.followedup[0].content[0].text.includes("fix the bug") && !quotedRunEnv.created[0].calls.followedup[0].content[0].text.includes("\"fix the bug\""));
check("U16 端到端文法: the confirmation dialog body carries the same whole task text (the human sees what the workers will be told)", quotedRunEnv.uq.requests[0].questions[0].question.includes("fix the bug"));
// The role→id lookup is by ROLE, not by position (a positional helper that is
// named after the role keeps passing on a reordered batch and hides the swap).
check("U16 端到端文法: each role resolves to its own session id (the lookup reads the id's role segment, not the create order)", plannedId(grammarEnv, "night-shift", "worker-a") === grammarEnv.creates[0].sessionId && plannedId(grammarEnv, "night-shift", "worker-b") === grammarEnv.creates[1].sessionId && plannedId(grammarEnv, "night-shift", "worker-a") !== plannedId(grammarEnv, "night-shift", "worker-b"));

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
const noPresetServiceOut = await noPresetServiceEnv.run("n=2 team=defect1 roles=worker-a,worker-b");
check("DEFECT-1 降级（唯一允许跳过的分支）: agentPresets 服务缺席 ⇒ 零 mount、meta 只剩 cwd、每个新会话恰一行 warn，而会话照建、照驱动（不因服务缺失让整条创建失败）", noPresetServiceEnv.creates.length === 2 && noPresetServiceEnv.agentPresets.mounts.length === 0 && noPresetServiceEnv.creates.every((options) => Object.keys(options.meta).sort().join(",") === "cwd") && presetServiceWarns(noPresetServiceEnv).length === 2 && noPresetServiceEnv.created.every((item) => item.calls.followedup.length === 1) && noPresetServiceOut.kind === "success");
check("DEFECT-1 降级: 那行 warn 说清了后果（没有 persona-prefix 组装源、首回合可能起不来），不是一句无声的「跳过了」", presetServiceWarns(noPresetServiceEnv).length === 2 && presetServiceWarns(noPresetServiceEnv).every((line) => line.includes("persona-prefix")));
// A preset that IS named but cannot be resolved is a REAL failure, not a reason
// to create an uncomposable session: `buildTeamSessionCreateOptions` throws, the
// batch reports it, and no session is created (宁可不建).
const bogusPresetEnv = teamSessionEnv({ askScript: ["创建"] });
const bogusPresetOut = await bogusPresetEnv.run("n=1 team=defect1 roles=worker-a preset=nope");
check("DEFECT-1 不静默降级: preset= 指了一个解析不出来的 id ⇒ 创建失败并如实报出原因（`not found`），零创建", bogusPresetEnv.creates.length === 0 && bogusPresetOut.kind === "error" && bogusPresetOut.text.includes("not found") && bogusPresetOut.text.includes("创建失败"));

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
const noWsServiceOut = await noWsServiceEnv.run("n=2 team=defect2 roles=worker-a,worker-b");
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
const kickoff = okEnv.created[0].calls.followedup[0];
check("U17 驱动: the kickoff task is delivered with `followup` (never `inject` — that is 「投递不唤醒」)", okEnv.created.every((item) => item.calls.followedup.length === 1 && item.calls.injected.length === 0 && item.calls.steered.length === 0));
check("U17 驱动: the kickoff message is a relay whose source is EXACTLY the three audited members (V10)", Object.keys(kickoff.source).length === 3 && kickoff.source.kind === "agent-message" && kickoff.source.form === "relay" && kickoff.source.senderSessionId === "session-self" && kickoff.role === "user" && typeof kickoff.id === "string" && kickoff.id.startsWith("slp-"));
check("U17 驱动: the body names the team, the role, the task, the cwd and how to report back (服从来自 prompt，不来自血统)", (() => { const text = kickoff.content[0].text; return text.includes("团队 night-shift") && text.includes("worker-a") && text.includes("做接口") && text.includes(TEAM_WS) && text.includes("team_link_send") && text.includes("汇报") && text.includes("session-self"); })());
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
const mixNewId = mixRunEnv.creates[1].sessionId;
check("U17 幂等: a mixed batch creates only the missing role, skips the seated one, and pairs only what it created", mixRunEnv.creates.length === 2 && mixOut2.kind === "success" && mixOut2.text.includes("worker-a：跳过（已登记）") && mixOut2.text.includes(`worker-b → ${mixNewId}：已创建`) && mixRunEnv.pairs().length === 2 && mixRunEnv.pairs().every((pair) => [mixRunEnv.creates[0].sessionId, mixNewId].includes(pair.b)));

// --- 部分失败: 失败即停 · 已建者保留 · 如实报告 -------------------------------
const failEnv = teamSessionEnv({ askScript: ["创建"], failCreateAt: 1 });
const failOut = await failEnv.run("n=3 team=night-shift roles=worker-a,worker-b,worker-c");
const failFirstId = failEnv.creates[0].sessionId;
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
const foreignCmdEnv = teamSessionEnv({ teams: [teamRow({ current: "session-other" })], askScript: ["创建"] });
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
const pendingFirstId = pendingEnv.creates[0].sessionId;
check("U18 意图: a created worker's intent is resolved, while the one whose create FAILED keeps its durable row (the crash window's evidence)", pendingEnv.pending().length === 1 && pendingEnv.pending()[0].sessionId === pendingEnv.creates[1].sessionId && pendingEnv.pending()[0].team === "night-shift" && pendingEnv.pending()[0].role === "worker-b" && pendingEnv.pending()[0].expiresAt > pendingEnv.pending()[0].createdAt);
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
const hostSourcePath = fileURLToPath(new URL("./lib/index.js", import.meta.url));
const hostSource = await readFile(hostSourcePath, "utf8");
// DEFECT-2 源码锁：整模块只有**一处** attach/detach 调用点（② 与 ③a 共用同一个
// `createRootAgent`，不存在第二个挂载点），`agents.create(` 仍是那**一处**。
check("DEFECT-2 源码锁: 全模块 `.attachSession(` / `.detachSession(` 各**恰一处**（② 与 ③a 共用同一条创建路径，不存在第二个挂载点），`agents.create(` 仍恰一处", (hostSource.match(/\.attachSession\(/gu) ?? []).length === 1 && (hostSource.match(/\.detachSession\(/gu) ?? []).length === 1 && (hostSource.match(/agents\.create\(/gu) ?? []).length === 1);
const importList = [...hostSource.matchAll(/^import .*? from "([^"]+)";$/gmu)].map((match) => match[1]);
const HOST_IMPORTS = ["@deepseek-ai/dsh-session-reference", "@deepseek-ai/dsh-tools", "schemastery", "node:crypto", "node:fs/promises", "node:path"];
// `appendFile(`/`writeFile(` are deliberately NOT in this list: they are the
// blackboard's own file writes (`team/<name>/decisions.md`), not session log
// writes — the red line is about event types, not about the plugin touching disk.
check("U19 日志事件: the host module itself never appends or emits a session-log event — no `ctx.session` write seam (the only `ctx.*` session contact is the read-only `sessionQuery`, `sessionReferenceResolver` and `agents`), no `session.append` / appendEvent / writeEvent / logEvent / `ctx.emit` anywhere in the module (源码级锁；插件间接写会话只经上游的 `agents.create` / `agent.followup`)", !/ctx\.session(?![A-Za-z])/u.test(hostSource) && !/\.append(Event)?\(/u.test(hostSource) && !/\b(appendEvent|writeEvent|logEvent|emitEvent)\b/u.test(hostSource) && !/\bctx\.emit\(/u.test(hostSource) && !/\bsession\.append/u.test(hostSource));
check("U19 日志事件: ... and the module's whole import surface is the six audited modules — a whitelist, so a new dependency cannot slip a log-write API in (`@deepseek-ai/dsh-session-reference` is upstream's deep-link parser, not a session-log writer)", sameJson(importList, HOST_IMPORTS) && importList.every((specifier) => HOST_IMPORTS.includes(specifier)));
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
const U19_POLICY_KEYS = ["blockedSenders", "pairs", "pendingCreates", "receiveMode", "rememberTargets", "teams", "trustedSenders", "watchdogs"];
const u19Base = u19ConcurrencyEnv.settings.namespaces.get("team-link").base;
check("U19 schema: the registered policy namespace still declares exactly its eight keys — the ② round's own pendingCreates plus the seven that pre-date it, and nothing else", sameJson(Object.keys(u19Base).sort(), U19_POLICY_KEYS) && sameJson(Object.keys(u19ConcurrencyEnv.settings.namespaces.get("team-link").data).sort(), ["pairs", "pendingCreates", "teams"]));
const sendToolU19 = u19ConcurrencyEnv.tool("team_link_send");
const sendParams = sendToolU19.parameters;
check("U19 schema: team_link_send's argument surface is unchanged (mutually-exclusive addressing, the message, the §3.4 envelope) — and the real key is `message`, not `text`", sameJson(Object.keys(sendParams.properties).sort(), ["message", "meta", "targetSessionId", "targets"]) && sameJson(sendParams.required, ["message"]) && sendParams.type === "object" && sendParams.properties.message.type === "string" && sendParams.properties.targets.type === "array" && sendParams.properties.targetSessionId.type === "string");
// The read-only half of the same red line, on the OTHER module: the client face
// cannot write a session event either — its bundle has no import at all (the
// client-half suite asserts nothing else may be added to it).
const clientSource = await readFile(fileURLToPath(new URL("./lib/client.js", import.meta.url)), "utf8");
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

rmSync(escDir, { recursive: true, force: true });
rmSync(TEAM_TMP, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
// §9.6 ⑧: the run states its own assertion total, so the README figure (and any
// future changelog figure) is checkable against the run instead of remembered.
console.log(`assertion total: ${assertions} (failed: ${failures})`);
process.exit(failures === 0 ? 0 : 1);

/** Drive the agent/pre-step waterfall the way the loop does. */
async function ctx_waterfall(ctx, payload) {
	return ctx.waterfall({}, "agent/pre-step", payload, () => Promise.resolve({ kind: "enter", messages: [...payload.messages] }));
}

// Unit smoke test for the dsh-team-link browser half: loads the client
// bundle against a stubbed module loader/React and drives the relay-card gate.
//
// The gate is the risky part. A DSH 0.1.5 cross-session relay is published as
// `source = { kind: "agent-message", form: "relay", senderSessionId }` — the only
// shape the session-log migration admits — and upstream emits that SAME shape for
// adjacent-agent messages (bare-UUID ids, body `Agent <id> sent a message: …`).
// Kind + form alone therefore dresses foreign messages as this plugin's cards;
// these cases pin the `slp-` id discriminator (and its banner fallback) in place.
// Run after the node_modules junctions are in place (see README).
import { readFile } from "node:fs/promises";

let failures = 0;
/** Assertions executed in this run, printed at the end so the README figure is
 * checkable against the run instead of remembered (same rule as the host half,
 * §9.6 ⑧. */
let assertions = 0;
function check(label, cond) {
	assertions += 1;
	console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
	if (!cond) failures += 1;
}

// ---------------------------------------------------------------------------
// bundle harness: run lib/client.js against a stubbed loader, React and document
// ---------------------------------------------------------------------------

const SOURCE = await readFile(new URL("./lib/client.js", import.meta.url), "utf8");

/** The component instance whose hooks are being read, if any. Outside `mount()`
 * it stays null and every hook degrades to its initial value with no-op setters —
 * which is what keeps the plain `component(props)` calls below working. */
let currentInstance = null;
/** Elements whose `focus()` was called: §4.3.7's focus-return assertion reads
 * this instead of trusting the props. */
const focusCalls = [];

/** Minimal React stand-in: createElement returns an inspectable plain tree, plus a
 * tiny hook runtime so the stateful faces under test (the sidebar entry, the
 * dialog) can be DRIVEN — the entry opens on click, the search narrows the list,
 * a copy flashes — instead of being inspected at their initial state only. */
const React = {
	createElement(type, props, ...children) {
		const element = { type, props: props === null || props === undefined ? {} : props, children };
		const ref = element.props.ref;
		if (ref !== null && ref !== undefined && typeof ref === "object") ref.current = element;
		element.focus = () => { focusCalls.push(element); };
		return element;
	},
	useState(initial) {
		const value = typeof initial === "function" ? initial() : initial;
		if (currentInstance === null) return [value, () => {}];
		const instance = currentInstance;
		const index = instance.hookIndex++;
		if (!(index in instance.hooks)) instance.hooks[index] = value;
		return [instance.hooks[index], (next) => {
			instance.hooks[index] = typeof next === "function" ? next(instance.hooks[index]) : next;
			instance.render();
		}];
	},
	useRef(initial) {
		if (currentInstance === null) return { current: initial };
		const instance = currentInstance;
		const index = instance.hookIndex++;
		if (!(index in instance.hooks)) instance.hooks[index] = { current: initial };
		return instance.hooks[index];
	},
	useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
	useCallback(fn) { return fn; },
	Fragment: Symbol("Fragment"),
};

/** Render one component through a live hook instance. `instance.tree` is the
 * component's own element tree, re-read after every state update its handlers
 * trigger. */
function mount(Comp, props) {
	const instance = { hooks: [], hookIndex: 0, tree: null };
	instance.render = () => {
		instance.hookIndex = 0;
		const previous = currentInstance;
		currentInstance = instance;
		try {
			instance.tree = Comp(props);
		} finally {
			currentInstance = previous;
		}
	};
	instance.render();
	return instance;
}

/** Walk an UNFLATTENED element tree (function-typed elements stay unexpanded, so
 * their own state can be driven afterwards). */
function rawFind(tree, test) {
	if (tree === null || tree === undefined || typeof tree !== "object") return null;
	if (Array.isArray(tree)) {
		for (const child of tree) {
			const hit = rawFind(child, test);
			if (hit !== null) return hit;
		}
		return null;
	}
	if (test(tree)) return tree;
	return rawFind(tree.children, test);
}

/** First node in a FLATTENED tree with this element type ("modal", "div", …). */
function treeByType(tree, type) {
	if (tree === null || tree === undefined || typeof tree !== "object") return null;
	if (Array.isArray(tree)) {
		for (const child of tree) {
			const hit = treeByType(child, type);
			if (hit !== null) return hit;
		}
		return null;
	}
	if (tree.type === type) return tree;
	return treeByType(tree.children, type);
}

function createElementStub() {
	return { dataset: {}, style: {}, textContent: "", setAttribute() {}, appendChild() {} };
}

/** The shell's SEED module of pure atoms (§4.3.5: required, never declared in
 * `dsh.client.inject`). `Modal` renders body + footer into one inspectable tree
 * the way the real, body-portaled one does; `writeClipboard` records instead of
 * writing; `relativeTime` is the official bucketing contract (unit + n). */
const clipboardWrites = [];
const primitivesStub = {
	Modal(props) {
		return {
			type: "modal",
			props,
			children: [props.children === undefined ? null : props.children, props.footer === undefined ? null : props.footer],
		};
	},
	relativeTime(at, now) {
		const minutes = Math.floor((now - at) / 60000);
		if (minutes < 1) return { unit: "now", n: 0 };
		if (minutes < 60) return { unit: "minutes", n: minutes };
		const hours = Math.floor(minutes / 60);
		if (hours < 24) return { unit: "hours", n: hours };
		const days = Math.floor(hours / 24);
		if (days < 30) return { unit: "days", n: days };
		const months = Math.floor(days / 30);
		return months < 12 ? { unit: "months", n: months } : { unit: "years", n: Math.floor(months / 12) };
	},
	writeClipboard(text) { clipboardWrites.push(text); return Promise.resolve(true); },
	IconLinkOutline16(props) { return { type: "icon16", props, children: [] }; },
	IconLinkOutline14(props) { return { type: "icon14", props, children: [] }; },
};

const styleTags = [];
const documentStub = {
	querySelector() { return null; },
	createElement: createElementStub,
	head: { appendChild(tag) { styleTags.push(tag); } },
	body: { appendChild() {}, removeChild() {} },
};

let definition = null;
const windowStub = {
	__ModuleLoader__: { load(value) { definition = value; } },
	location: { pathname: "/" },
	isSecureContext: false,
	setTimeout,
	open() {},
};

// The bundle is a plain script that only talks to the loader at load time.
new Function("window", "document", SOURCE)(windowStub, documentStub);
check("client bundle registers its module definition", definition !== null && definition.id === "dsh-team-link");
check("client bundle exposes a factory", definition !== null && typeof definition.factory === "function");

let primitivesAvailable = true;
const required = [];
const moduleExports = definition.factory((specifier) => {
	required.push(specifier);
	if (specifier === "react") return React;
	if (specifier === "@deepseek-ai/dsh-client-ui-primitives") {
		if (primitivesAvailable === true) return primitivesStub;
		throw new Error("seed module not served by this shell");
	}
	throw new Error(`unstubbed require: ${specifier}`);
});
check("factory only requires react", required.length === 1 && required[0] === "react");

// ---------------------------------------------------------------------------
// plugin context stub: capture the slot registrations apply() performs
// ---------------------------------------------------------------------------

const registrations = [];
/** Dictionary registered per language: `ctx.locale.register(ns, lang, dict)`.
 * Captured so the assertions can read the REAL copy (a key renamed in lib/ and
 * not here would show up as the key name itself). */
const localeDicts = new Map();
/** The Definition this plugin hands to the uiConversation registry (§10.1.3 D);
 * U15 drives it the way the assembler does. `definitionRegistrations` counts the
 * calls into the registry, so an apply() that must NOT register anything (F3's
 * missing-service cases) can be told apart from one that did. */
let registeredDefinition = null;
let definitionRegistrations = 0;
const uiConversationStub = {
	events: {
		register(definition) { definitionRegistrations += 1; registeredDefinition = definition; return () => {}; },
	},
};
/** The three client services §4.3.5 reads at runtime. `sessions` deliberately
 * carries NO `open()`: the real ISessions face (dsh-api-session-controller
 * contract/sessions.d.ts) has none — that absence IS the §4.4 defect, and a stub
 * that invented the method would hide it. */
const sessionsServiceStub = { list: { getSnapshot() { return { ids: [], byId: {}, phase: "ready" }; } } };
const workspacesServiceStub = { list: { getSnapshot() { return { items: [], archivedSessionIds: [] }; } } };
const uiWorkspaceServiceStub = { openSession() {} };

/** The scoped context cordis hands an `inject` callback: every service the
 * callback asked for, readable both as a property and through `get` (the real
 * nested context carries the parent's services, a fact §4.3.5 relies on). */
function scopedContext(overrides = {}) {
	const scope = {
		uiConversation: uiConversationStub,
		sessions: sessionsServiceStub,
		workspaces: workspacesServiceStub,
		uiWorkspace: uiWorkspaceServiceStub,
		...overrides,
	};
	scope.get = (name) => scope[name];
	return scope;
}

/** The same three services through `ctx.get` — the immediate, time-point read. */
function serviceGet(name, overrides = {}) {
	if (overrides[name] === null) return undefined;
	if (Object.prototype.hasOwnProperty.call(overrides, name)) return overrides[name];
	if (name === "sessions") return sessionsServiceStub;
	if (name === "workspaces") return workspacesServiceStub;
	if (name === "uiWorkspace") return uiWorkspaceServiceStub;
	return undefined;
}

const ctx = {
	effect(fn) { const disposer = fn(); return typeof disposer === "function" ? disposer : () => {}; },
	locale: {
		register(_namespace, lang, dict) { localeDicts.set(lang, dict); return () => {}; },
		bind() { return (key) => key; },
	},
	slots: {
		inject(_name, register) { return register(); },
		register(options, component) { registrations.push({ options, component }); return () => {}; },
		entries() { return []; },
	},
	sessions: sessionsServiceStub,
	get(name) { return serviceGet(name); },
	// cordis: `inject` runs the callback on the context that holds the services.
	// The stub is the "already active" case.
	inject(_specs, callback) { return callback(scopedContext()); },
};

moduleExports.apply(ctx);
const nodeSlot = registrations.find((entry) => entry.options.name === "conversation.chat.node");
const headerSlot = registrations.find((entry) => entry.options.name === "conversation.session.header.actions");
const sessionToolsSlot = registrations.find((entry) => entry.options.name === "sidebar.footer.action");
check("relay card shadows the keyed context slot", nodeSlot !== undefined && nodeSlot.options.key === "context" && nodeSlot.options.priority === -100);
check("header action strip still registered", headerSlot !== undefined);
check("styles injected once", styleTags.length === 1 && String(styleTags[0].textContent).includes(".dshsl-relay{"));

// ---------------------------------------------------------------------------
// relay-card gate
// ---------------------------------------------------------------------------

const t = (key) => key;
// The shell hands a chat-node renderer `{...ownerProps, node}` where the node is
// `{key, kind, id, target, data}` — `id` is the durable message id, and the context
// node's `data` is `{kind, seq, time, content, source, provenance, form}`.
const render = (data, id) => nodeSlot.component({ node: id === undefined ? { data } : { id, data }, t });
const isCard = (tree) => tree !== null && typeof tree === "object" && tree.props !== undefined && tree.props.className === "dshsl-relay";
const isDelegated = (tree) => !isCard(tree) && tree.props !== undefined && tree.props.style !== undefined && tree.props.style.fontSize === "11px";
const headOf = (tree) => tree.children[0];
const bodyTextOf = (tree) => tree.children[1].children.join("");
/** Text of a delegated node: the plain fallback renders one text child. */
const delegatedTextOf = (tree) => tree.children.join("");
const headSpan = (tree, className) => headOf(tree).children.filter((child) => child !== null && child !== undefined && child.props !== undefined && child.props.className === className)[0];
const spanText = (span) => span.children.join("");
const textOf = (blocks) => [{ type: "text", text: blocks.join("\n\n") }];

const BANNER = "📨 [跨会话消息 · 来自会话 ";
const FOOTER = "（如需回复，可让本会话调用 team_link_send 工具发回）";
const relayBody = (sessionId, when, payload) => [BANNER + sessionId + (when === undefined ? "" : ` · ${when}`) + "]", "", payload, "", FOOTER].join("\n");

// 1. pre-0.1.5 history: the retired kind, with its `sentAt` provenance.
const legacyWhen = "2026-01-02T03:04:05.000Z";
const legacy = render({
	source: { kind: "team-link", plugin: "dsh-team-link", fromSession: "session-a", senderSessionId: "session-a", form: "relay", sentAt: legacyWhen },
	content: textOf([relayBody("session-a", undefined, "老日志正文")]),
}, "slp-11111111-1111-1111-1111-111111111111");
check("legacy kind still renders as a card", isCard(legacy));
check("legacy card reads senderSessionId", spanText(headSpan(legacy, "dshsl-relay-sender")).includes("session-a"));
check("legacy card still reads sentAt", spanText(headSpan(legacy, "dshsl-relay-when")) === new Date(legacyWhen).toLocaleString());
check("legacy card strips the banner wrapper", bodyTextOf(legacy) === "老日志正文");

// 2. current shape: `slp-` node id + the audited three-member source. The time is
//    the durable event time the context node already carries.
const eventTime = new Date(2026, 1, 14, 9, 30, 0).valueOf();
const stamped = render({
	time: eventTime,
	source: { kind: "agent-message", form: "relay", senderSessionId: "session-b" },
	content: textOf([relayBody("session-b", "2026-02-14 09:30:00", "新格式正文")]),
}, "slp-22222222-2222-2222-2222-222222222222");
check("published relay shape renders as a card", isCard(stamped));
check("published card reads senderSessionId", spanText(headSpan(stamped, "dshsl-relay-sender")).includes("session-b"));
check("published card shows the durable event time", spanText(headSpan(stamped, "dshsl-relay-when")) === new Date(eventTime).toLocaleString());
check("published card strips the banner wrapper", bodyTextOf(stamped) === "新格式正文");

// 3. THE TRAP: an upstream adjacent-agent message uses the same kind/form pair
//    (bare UUID id, `Agent <id> sent a message:` body). It must stay untouched.
const upstream = render({
	source: { kind: "agent-message", form: "relay", senderSessionId: "session-c" },
	content: textOf(["Agent session-c sent a message: 上游相邻代理消息"]),
}, "33333333-3333-4333-8333-333333333333");
check("upstream agent-message is NOT dressed as a relay card", isDelegated(upstream));
check("upstream message text passes through", delegatedTextOf(upstream).includes("上游相邻代理消息"));

// 4. Any other plugin's injected context keeps the default rendering.
const foreign = render({ source: { kind: "plugin", plugin: "other-plugin", form: "notice", summary: "s" }, content: textOf(["其他插件的上下文"]) }, "slp-lookalike");
check("foreign plugin context is delegated", isDelegated(foreign));

// 5. The `slp-` gate reads `node.id` (the context `data` has no id of its own).
const nodeIdOnly = render({
	source: { kind: "agent-message", form: "relay", senderSessionId: "session-h" },
	content: textOf(["正文没有 banner，只有 node.id 是 slp-"]),
}, "slp-44444444-4444-4444-4444-444444444444");
check("node.id drives the gate", isCard(nodeIdOnly) && bodyTextOf(nodeIdOnly).includes("只有 node.id") && spanText(headSpan(nodeIdOnly, "dshsl-relay-sender")).includes("session-h"));

// 6. Either identification signal is enough: a render path whose id is missing,
//    or is not the message id at all, still gets its card from the banner.
const noId = render({ source: { kind: "agent-message", form: "relay", senderSessionId: "session-d" }, content: textOf([relayBody("session-d", "2026-02-14 10:00:00", "无 id 正文")]) });
check("id-less relay with our banner still renders as a card", isCard(noId) && bodyTextOf(noId) === "无 id 正文");
check("banner stamp is the last-resort time", spanText(headSpan(noId, "dshsl-relay-when")) === new Date(2026, 1, 14, 10, 0, 0).toLocaleString());
const oddId = render({ source: { kind: "agent-message", form: "relay", senderSessionId: "session-f" }, content: textOf([relayBody("session-f", "2026-02-14 11:00:00", "非消息 id 正文")]) }, "node-7");
check("non-message-id relay with our banner still renders as a card", isCard(oddId) && bodyTextOf(oddId) === "非消息 id 正文");
const noIdForeign = render({ source: { kind: "agent-message", form: "relay", senderSessionId: "session-e" }, content: textOf(["Agent session-e sent a message: 无 id 上游消息"]) });
check("id-less foreign relay stays delegated", isDelegated(noIdForeign));
const oddIdForeign = render({ source: { kind: "agent-message", form: "relay", senderSessionId: "session-g" }, content: textOf(["Agent session-g sent a message: 非 slp id 上游消息"]) }, "node-8");
check("upstream relay under a non-slp id stays delegated", isDelegated(oddIdForeign));

// 7. Degenerate nodes never throw and never turn into cards.
const bare = render({});
check("empty node delegates", isDelegated(bare));
const noSource = render({ content: textOf(["没有 source"]) }, "slp-x");
check("source-less node delegates", isDelegated(noSource));

// 8. The banner stamp is anchored to the END of the head line, so a session title
//    that itself looks like a date (or a very long title) cannot win the parse.
const dateLikeTitle = render({ source: { kind: "agent-message", form: "relay", senderSessionId: "session-i" }, content: textOf([relayBody("「2026-01-01 12:00:00 的讨论」session-i", "2026-03-03 08:08:08", "标题含日期")]) }, "slp-55555555-5555-5555-5555-555555555555");
check("a date-like title does not win the stamp", spanText(headSpan(dateLikeTitle, "dshsl-relay-when")) === new Date(2026, 2, 3, 8, 8, 8).toLocaleString());
const longTitle = render({ source: { kind: "agent-message", form: "relay", senderSessionId: "session-j" }, content: textOf([relayBody(`「${"很长的标题".repeat(90)}」session-j`, "2026-04-04 09:09:09", "标题很长")]) }, "slp-66666666-6666-6666-6666-666666666666");
check("a long title still yields the stamp", spanText(headSpan(longTitle, "dshsl-relay-when")) === new Date(2026, 3, 4, 9, 9, 9).toLocaleString());
const noStamp = render({ source: { kind: "agent-message", form: "relay", senderSessionId: "session-k" }, content: textOf([relayBody("session-k", undefined, "旧 banner 没有时间")]) }, "slp-77777777-7777-7777-7777-777777777777");
check("a stamp-less banner shows no time", headSpan(noStamp, "dshsl-relay-when") === undefined);

// 8b. R7 (M3 review): the head line may carry the §3.4 envelope AFTER the stamp
//     (`… 23:42:05 · type=ruling pri=P0 ref=slp-a1b2]`). The stamp must still be
//     read, and the envelope fields must not leak into the card body.
const metaCard = render({ source: { kind: "agent-message", form: "relay", senderSessionId: "session-m" }, content: textOf([relayBody("session-m", "2026-05-05 10:10:10 · type=ruling pri=P0 ref=slp-a1b2", "带信封正文")]) }, "slp-dddddddd-dddd-dddd-dddd-dddddddddddd");
check("R7: a banner carrying envelope meta still yields its stamp", spanText(headSpan(metaCard, "dshsl-relay-when")) === new Date(2026, 4, 5, 10, 10, 10).toLocaleString());
check("R7: the envelope fields stay in the banner and out of the card body", bodyTextOf(metaCard) === "带信封正文");
const metaTitle = render({ source: { kind: "agent-message", form: "relay", senderSessionId: "session-n" }, content: textOf([relayBody("「2026-01-01 12:00:00 的讨论」session-n", "2026-05-06 11:11:11 · type=report pri=P2", "标题含日期且带信封")]) }, "slp-eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");
check("R7: the envelope-aware regex still lets the true stamp win over a date-like title", spanText(headSpan(metaTitle, "dshsl-relay-when")) === new Date(2026, 4, 6, 11, 11, 11).toLocaleString());
check("R7: a relay without meta keeps its exact previous parse", spanText(headSpan(noId, "dshsl-relay-when")) === new Date(2026, 1, 14, 10, 0, 0).toLocaleString());

// ---------------------------------------------------------------------------
// header actions: copy + export side by side
// ---------------------------------------------------------------------------

const header = headerSlot.component({ sessionId: "session-xyz", t });
check("header strip renders copy + export", Array.isArray(header.children) && header.children.length === 2);
const renderChild = (element) => element.type(element.props);
check("copy button carries the session aria-label", String(renderChild(header.children[0]).props["aria-label"]) === "copyLink");
check("export button carries the export label", String(renderChild(header.children[1]).props.title) === "exportSession");

// ---------------------------------------------------------------------------
// 9. lone-surrogate safety: the shortened session id cuts on code points
// ---------------------------------------------------------------------------

// `id.slice(0, 14)` can keep a trailing HIGH surrogate and `id.slice(-8)` can
// start on a LOW one whenever a pair straddles either index — the same
// code-unit cut that poisons a host tool result. This path is display-only: a
// browser text node goes through the DOM's USVString conversion (which maps a
// lone surrogate to U+FFFD) and the string never re-enters a model request, so
// the old form was cosmetically wrong rather than session-killing. Pinned
// anyway, because it IS reachable with a non-ASCII id and the code-point cut is
// a no-op for the ASCII ids the harness mints.
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const headHigh = "session-xxxxx🔵"; // the emoji's high half lands on code-unit index 13
const astralId = headHigh + "y".repeat(4) + "🔵" + "z".repeat(7); // and a low half 8 units from the end
const astralCard = render({ source: { kind: "agent-message", form: "relay", senderSessionId: astralId }, content: textOf([relayBody(astralId, undefined, "emoji id")]) }, "slp-88888888-8888-8888-8888-888888888888");
const astralSender = spanText(headSpan(astralCard, "dshsl-relay-sender"));
check("astral session id renders as a card", isCard(astralCard));
check("astral session id shortens without a lone surrogate", !LONE.test(astralSender));
check("astral session id keeps 14 head + 8 tail code points", [...astralSender.replace("来自 ", "")].length === 14 + 1 + 8);
check("astral session id keeps the whole head emoji", astralSender.startsWith("来自 session-xxxxx🔵"));
const asciiId = "session-" + "a".repeat(32);
const asciiCard = render({ source: { kind: "agent-message", form: "relay", senderSessionId: asciiId }, content: textOf([relayBody(asciiId, undefined, "ascii id")]) }, "slp-99999999-9999-9999-9999-999999999999");
check("ASCII session id shortening is unchanged", spanText(headSpan(asciiCard, "dshsl-relay-sender")) === "来自 session-aaaaaa…aaaaaaaa");
const shortIdCard = render({ source: { kind: "agent-message", form: "relay", senderSessionId: "session-b" }, content: textOf([relayBody("session-b", undefined, "短 id")]) }, "slp-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
check("short id still passes through unchanged", spanText(headSpan(shortIdCard, "dshsl-relay-sender")) === "来自 session-b");
// A row written by an older build (or any foreign row claiming this shape) can
// already carry a lone surrogate. The DOM would repair it via USVString
// conversion; this harness has no DOM, so the repair is asserted where it is
// visible — the rendered body text itself.
const poisonedLegacy = render({ source: { kind: "team-link", fromSession: "session-p", sentAt: legacyWhen }, content: textOf([relayBody("session-p", undefined, "断开的\uD83D 负载")]) }, "slp-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
check("a lone surrogate in a legacy row body is repaired", !LONE.test(bodyTextOf(poisonedLegacy)));
check("the repaired legacy body keeps its text", bodyTextOf(poisonedLegacy).includes("断开的") && bodyTextOf(poisonedLegacy).includes("负载"));
// A SHORT (unshortened, <= 26 code units) id is returned verbatim by the
// shortener, so the repair has to sit on the rendered value, not only on the cut.
const rawHalfId = "session-\uD83Dq";
const poisonedRawId = render({ source: { kind: "team-link", fromSession: rawHalfId, sentAt: legacyWhen }, content: textOf([relayBody(rawHalfId, undefined, "短 id 带半截")]) }, "slp-cccccccc-cccc-cccc-cccc-cccccccccccc");
check("a short poisoned sender id is repaired", rawHalfId.length <= 26 && !LONE.test(spanText(headSpan(poisonedRawId, "dshsl-relay-sender"))));
// The delegation fallback renders OTHER plugins' context text — still this file's
// output, so it goes through the same repair.
const foreignHalf = render({ source: { kind: "plugin", plugin: "other-plugin", form: "notice" }, content: textOf(["外来的\uD83D 半截文本"]) }, "node-9");
check("a lone surrogate in delegated foreign context is repaired", isDelegated(foreignHalf) && !LONE.test(delegatedTextOf(foreignHalf)));
check("the delegated foreign text is otherwise untouched", delegatedTextOf(foreignHalf).includes("半截文本"));

// ---------------------------------------------------------------------------
// U14 (§10.1.1 A): the sender's own tool row — `tool.call.toolview` keyed by
// the WIRE TOOL NAME, rendered from the §10.1.2 receipt, plain text otherwise.
// ---------------------------------------------------------------------------

/** Render a React-stub tree the way React would: the stub's createElement only
 * BUILDS elements, so the one expansion React performs for a function component
 * is done here (`type({...props, children})`). Fragments are flattened too. */
function flatten(tree) {
	if (tree === null || tree === undefined || typeof tree !== "object") return tree;
	if (Array.isArray(tree)) return tree.map(flatten);
	if (typeof tree.type === "function") return flatten(tree.type({ ...tree.props, children: tree.children }));
	if (tree.type === React.Fragment) return flatten(tree.children);
	const children = tree.children === undefined ? [] : Array.isArray(tree.children) ? tree.children.map(flatten) : [flatten(tree.children)];
	return { type: tree.type, props: tree.props, children };
}
/** Flat text of a React-stub tree (strings and numbers, in child order). */
function treeText(tree) {
	if (tree === null || tree === undefined || tree === false) return "";
	if (typeof tree === "string" || typeof tree === "number") return String(tree);
	if (Array.isArray(tree)) return tree.map(treeText).join("");
	if (typeof tree === "object" && tree.children !== undefined) return treeText(tree.children);
	return "";
}
/** First node in the tree whose props carry this className. */
function treeByClass(tree, className) {
	if (tree === null || tree === undefined || typeof tree !== "object") return null;
	if (Array.isArray(tree)) {
		for (const child of tree) {
			const hit = treeByClass(child, className);
			if (hit !== null) return hit;
		}
		return null;
	}
	if (tree.props !== undefined && tree.props.className === className) return tree;
	return treeByClass(tree.children, className);
}
/** All nodes in the tree whose props carry this className (target rows). */
function treeAllByClass(tree, className) {
	if (tree === null || tree === undefined || typeof tree !== "object") return [];
	if (Array.isArray(tree)) return tree.flatMap((child) => treeAllByClass(child, className));
	const here = tree.props !== undefined && tree.props.className === className ? [tree] : [];
	return [...here, ...treeAllByClass(tree.children, className)];
}
const isSendCard = (tree) => {
	const card = treeByClass(tree, "dshsl-relay dshsl-send");
	return card !== null && card.props["data-slp-send"] === "row";
};
const isSendPlain = (tree) => {
	const plain = treeByClass(tree, "dshsl-plain");
	return plain !== null && plain.props["data-slp-send"] === "plain";
};

const toolViewSlot = registrations.find((entry) => entry.options.name === "tool.call.toolview");
// Both send faces are registered by the same apply(): A (the tool row) and D (the
// top-level node). They are looked up together because §10.1.5's information split
// is a property OF THE PAIR — every assertion below has to be able to see both.
const relayNodeSlot = registrations.find((entry) => entry.options.name === "conversation.chat.node" && entry.options.key === "context");
const topSlot = registrations.find((entry) => entry.options.name === "conversation.chat.node" && entry.options.key === "team-link-send");
check("U14: the plugin claims the keyed tool view slot for its own wire tool name", toolViewSlot !== undefined);
// The dispatch is a plain keyed lookup against the wire tool name, and a typo
// falls back to the generic tool row with NO error anywhere — so the literal is
// the thing worth pinning, together with the near-misses it must not be.
check("U14: the slot key is the wire tool name VERBATIM (a typo would silently fall back to the generic row)", toolViewSlot.options.key === "team_link_send");
check("U14: ... and no near-miss claims that tool row (the tool view slot holds exactly one key)", ["team-link-send", "team_link_send ", "Team_link_send", "team_link_send2"].every((near) => registrations.filter((entry) => entry.options.name === "tool.call.toolview").every((entry) => entry.options.key !== near)) && registrations.filter((entry) => entry.options.name === "tool.call.toolview").length === 1);

const sendBlock = (meta, text = "已投递到 session-worker-a（已配对通道，免确认自动投递）：目标空闲，已唤醒目标会话并作为新回合处理。") => ({
	kind: "tool-result",
	seq: 42,
	time: 1_700_000_000_000,
	callId: "call-1",
	call: { name: "team_link_send", argsRaw: "{\"message\":\"x\"}" },
	callTime: 1_699_999_999_000,
	content: [{ type: "text", text }],
	isError: false,
	meta,
	subCalls: [],
});
const runningBlock = () => ({ callId: "call-1", name: "team_link_send", argsRaw: "{\"message\":\"x\"}", turn: 1, step: 1, time: 1_700_000_000_000, subCalls: [] });
/** The real copy of the zh dictionary (a missing key falls back to the key name,
 * so an assertion naming the copy pins the key too). */
const tZh = (key) => (localeDicts.get("zh") !== undefined && Object.prototype.hasOwnProperty.call(localeDicts.get("zh"), key) ? localeDicts.get("zh")[key] : key);
const renderSendRow = (block, toolName = "team_link_send") => flatten(toolViewSlot.component({ callId: "call-1", toolName, block, t: tZh }));
/** D's face of one receipt: the assembler hands the chat-node renderer a node
 * whose `data.card` is the receipt (U15's `buildViewNode` builds exactly that). */
const renderTopCard = (card) => flatten(topSlot.component({ node: { data: { card } }, t: tZh }));

/** A §10.1.2 receipt as the host half mints it (the client never trusts more). */
const SEND_CARD = {
	kind: "team-link-send",
	v: 1,
	at: new Date(2026, 8, 19, 12, 0, 0).valueOf(),
	senderSessionId: "session-self",
	meta: { type: "ruling", pri: "P0", ref: "slp-a1b2" },
	message: { text: "裁决：走 A 方案", truncated: false, chars: 9 },
	targets: [
		{ sessionId: "session-worker-a", expr: "team:night-shift/*", outcome: "delivered", detail: "已投递到 session-worker-a：目标空闲，已唤醒目标会话。", busy: { running: false } },
		{ sessionId: "session-worker-b", expr: "team:night-shift/*", outcome: "refused", detail: "未投递：目标会话用户未确认接收。" },
		{ sessionId: null, expr: "team:night-shift/reviewer", outcome: "no-holder", detail: "该角色当前空缺" },
	],
	summary: { delivered: 1, refused: 1, noAgent: 0, noHolder: 1, deduped: 2 },
	fanout: true,
};

const cardRow = renderSendRow(sendBlock(SEND_CARD));
const cardTop = renderTopCard(SEND_CARD);
check("U14: a settled call carrying a receipt renders as the send card, not a plain row", isSendCard(cardRow) && !isSendPlain(cardRow));
// §10.1.5 两面的信息分工: A carries the minimal label + the per-target rows and
// NOTHING of D's blocks (no title/time head, no body, no summary, no foot).
check("U14: A is the receiver's card with the outbound accent and the row face flag", treeByClass(cardRow, "dshsl-relay dshsl-send") !== null && treeByClass(cardRow, "dshsl-relay dshsl-send").props["data-slp-send"] === "row");
check("U14: A carries NO title/time head, NO body, NO summary and NO foot (those are D's — one block, one face)", treeByClass(cardRow, "dshsl-relay-head") === null && treeByClass(cardRow, "dshsl-relay-body") === null && treeByClass(cardRow, "dshsl-send-summary") === null && treeByClass(cardRow, "dshsl-relay-foot") === null && treeByClass(cardRow, "dshsl-send-env") === null);
check("U14: A's minimal label is the tool name plus the target count, and nothing else", treeText(treeByClass(cardRow, "dshsl-send-rowhead")) === "✦ 工具调用 · team_link_send · 3 个目标");
const detailRows = treeAllByClass(cardRow, "dshsl-send-target");
// 2026-09-20 §10.1.5 修订（用户决定）: a row renders from the STRUCTURED fields —
// the target identity, the SHORT phrase of its `outcome`, and the busy badge — and
// NOT from `target.detail`. The three receipts below carry three DIFFERENT detail
// sentences, so a row that still printed the detail would not match this text at
// all (that is the lock the retired "card row == report first line" equality was
// replaced by, §12.5).
check("U14: A renders one row per target from the structured fields — target identity + the outcome's short phrase, never `target.detail`", detailRows.length === 3 && detailRows.map((row) => treeText(row)).join("|") === [
	"session-worker-a（via team:night-shift/*） 已送达",
	"session-worker-b（via team:night-shift/*） 未送达——接收方拒绝",
	"team:night-shift/reviewer 未送达——该角色当前空缺",
].join("|"));
check("U14: ... and no row prints its target's `detail` sentence (the model-visible report line is not a card input anymore)", !treeText(detailRows[0]).includes("已投递到 session-worker-a：") && !treeText(detailRows[1]).includes("未投递：") && !treeText(detailRows[2]).includes("当前空缺。"));
const phrasesOfCardRow = detailRows.map((row) => treeText(treeByClass(row, "dshsl-send-outcome")));
const OUTCOME_PHRASE_KEYS = ["sendResultDelivered", "sendResultRefused", "sendResultNoAgent", "sendResultNoHolder"];
check("U14: every outcome the host mints renders its OWN non-empty short phrase — four keys, four distinct sentences, no key leaking as text", phrasesOfCardRow.every((phrase) => typeof phrase === "string" && phrase !== "" && !phrase.startsWith("sendResult")) && new Set(OUTCOME_PHRASE_KEYS.map((key) => tZh(key))).size === 4 && OUTCOME_PHRASE_KEYS.every((key) => tZh(key) !== key));
check("U14: ... and every outcome is carried as a data attribute (a refused row is visually distinct)", detailRows.map((row) => treeByClass(row, "dshsl-send-outcome").props["data-outcome"]).join(",") === "delivered,refused,no-holder");
check("U14: ... with the target identity in its own span (a long id is shortened, the expression stays readable)", detailRows.map((row) => treeText(treeByClass(row, "dshsl-send-targetid"))).join("|") === "session-worker-a（via team:night-shift/*）|session-worker-b（via team:night-shift/*）|team:night-shift/reviewer");
// D carries the blocks A does not: title + sender + time, the envelope, the body
// and the summary counts — and none of the per-target rows.
check("U15: D carries the title, the sender session and the delivery time", treeText(treeByClass(cardTop, "dshsl-relay-head")).includes("已发出跨会话消息") && treeText(treeByClass(cardTop, "dshsl-relay-head")).includes("session-self") && treeText(treeByClass(cardTop, "dshsl-relay-head")).includes(new Date(SEND_CARD.at).toLocaleString()));
check("U15: ... the §3.4 envelope as its compact k=v fields", treeText(treeByClass(cardTop, "dshsl-send-env")) === "type=ruling pri=P0 ref=slp-a1b2");
check("U15: ... the body that was sent, and no truncation note on an untruncated one", treeText(treeByClass(cardTop, "dshsl-relay-body")).includes("裁决：走 A 方案") && !treeText(treeByClass(cardTop, "dshsl-relay-body")).includes("正文已截断"));
check("U15: ... and the summary counts, plus dedupe when there is one", treeText(treeByClass(cardTop, "dshsl-send-summary")) === "汇总：1 投递 / 1 拒绝 / 0 无活动代理 / 1 空缺目标 · 2 个重复目标已去重");
check("U15: D carries NO per-target row and no target identity (逐目标明细行 is A's)", treeAllByClass(cardTop, "dshsl-send-target").length === 0 && treeByClass(cardTop, "dshsl-send-rowhead") === null && !treeText(cardTop).includes("session-worker-a") && !treeText(cardTop).includes("team:night-shift/*"));
const busyRow = renderSendRow(sendBlock({ ...SEND_CARD, targets: [{ sessionId: "session-worker-a", outcome: "delivered", detail: "已投递", busy: { running: true, minutes: 7 } }], summary: { delivered: 1, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 } }));
check("U14: a running target's row carries the §3.5 busy prediction as a BADGE with its minutes", treeText(busyRow).includes("忙碌 · 已运行 7 分钟"));
const busyUnknownRow = renderSendRow(sendBlock({ ...SEND_CARD, targets: [{ sessionId: "session-worker-a", outcome: "delivered", detail: "已投递", busy: { running: true } }], summary: { delivered: 1, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 } }));
check("U14: an unreadable turn start says busy without inventing a number", treeText(busyUnknownRow).includes("忙碌") && !treeText(busyUnknownRow).includes("忙碌 ·") && !/已运行 \d+ 分钟/u.test(treeText(busyUnknownRow)));
check("U14: ... and neither busy badge restates the steer mechanism — that sentence is the model-visible report's, not the card's", [busyRow, busyUnknownRow].every((tree) => !treeText(tree).includes("steer") && !treeText(tree).includes("起始时间不可读")));
const truncatedRow = renderTopCard({ ...SEND_CARD, message: { text: "头" + "..." + "尾", truncated: true, chars: 2100 } });
check("U15: a truncated body says so and states the ORIGINAL code-point count", treeText(treeByClass(truncatedRow, "dshsl-relay-body")).includes("（正文已截断，原文 2100 码点）"));
const emptyBodyRow = renderTopCard({ ...SEND_CARD, message: { text: "", truncated: false, chars: 0 } });
check("U15: an empty body falls back to the same（空）marker the receiver's card uses", treeText(treeByClass(emptyBodyRow, "dshsl-relay-body")).includes("（空）"));
const noEnvelopeRow = renderTopCard({ ...SEND_CARD, meta: undefined });
check("U15: a receipt without an envelope renders no envelope span at all", treeByClass(noEnvelopeRow, "dshsl-send-env") === null);
const noTargetsRow = renderSendRow(sendBlock({ ...SEND_CARD, targets: [], summary: { delivered: 0, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 } }));
check("U14: A with an empty target list still renders its label (count 0) and no rows", treeText(treeByClass(noTargetsRow, "dshsl-send-rowhead")) === "✦ 工具调用 · team_link_send · 0 个目标" && treeAllByClass(noTargetsRow, "dshsl-send-target").length === 0);
const renamedRow = renderSendRow(sendBlock(SEND_CARD), "team_link_send_v2");
check("U14: A's label names the tool the slot was dispatched for (props.toolName, not a hard-coded literal)", treeText(treeByClass(renamedRow, "dshsl-send-rowhead")).includes("team_link_send_v2"));

// --- the fallback: no receipt — the model-visible text, never a half card ----
const runningRow = renderSendRow(runningBlock());
check("U14: an in-flight call has no receipt yet and renders the plain row", isSendPlain(runningRow) && !isSendCard(runningRow));
check("U14: the plain row names the call and says it is still running", treeText(runningRow).includes("工具调用") && treeText(runningRow).includes("team_link_send") && treeText(runningRow).includes("调用中…"));
// One consequence of the §10.1.5 text rebuild (below) is visible right here: a
// fixture whose text IS one of the two shapes our host half mints no longer
// reaches the plain face at all — it is rebuilt into A's minimal card. That is
// the point of the round, so this block now says which text it means instead of
// relying on `sendBlock`'s default, and the two assertions that used to pin
// 「无 meta ⇒ 纯文本」 verbatim are RETIRED by the rebuild block below (they pinned
// a contract the design has replaced: 无 meta 时可重建 ⇒ 卡).
const FALLBACK_TEXT = "回退正文：这不是本插件报告形状里的任何一句。";
const fallbackRow = renderSendRow(sendBlock(undefined, FALLBACK_TEXT));
check("U14: a settled call with NO meta and a text that is NOT one of our report shapes falls back to plain text", isSendPlain(fallbackRow) && !isSendCard(fallbackRow));
check("U14: ... and the fallback shows the model-visible result verbatim, with the degradation named", treeText(treeByClass(fallbackRow, "dshsl-plain-body")) === FALLBACK_TEXT && treeText(fallbackRow).includes("无结构化回执"));
check("U14: a result with no text blocks still renders the plain row (no empty card, no crash)", isSendPlain(renderSendRow({ ...sendBlock(undefined), content: [] })));

// --- anything this build cannot read is NOT a structured card ----------------
const foreignMeta = renderSendRow(sendBlock({ kind: "fs-search", v: 1, results: [] }, FALLBACK_TEXT));
check("U14: another tool's meta is not dressed as our card (the discriminator is ours)", isSendPlain(foreignMeta) && !isSendCard(foreignMeta));
const malformed = [
	["not an object", "nope"],
	["null", null],
	["an array", []],
	["a wrong version", { ...SEND_CARD, v: 2 }],
	["a missing message", { ...SEND_CARD, message: undefined }],
	["a missing sender", { ...SEND_CARD, senderSessionId: "" }],
	["a non-numeric time", { ...SEND_CARD, at: "yesterday" }],
	["targets that are not an array", { ...SEND_CARD, targets: {} }],
	["a target with an unknown outcome type", { ...SEND_CARD, targets: [{ sessionId: "s", outcome: 7, detail: "d" }] }],
	["a target without a detail sentence", { ...SEND_CARD, targets: [{ sessionId: "s", outcome: "delivered" }] }],
	["a target id that is neither a string nor null", { ...SEND_CARD, targets: [{ sessionId: 5, outcome: "delivered", detail: "d" }] }],
	["no summary", { ...SEND_CARD, summary: undefined }],
];
check(`U14: none of the ${malformed.length} unreadable receipt shapes becomes a card`, malformed.every(([, meta]) => isSendPlain(renderSendRow(sendBlock(meta, FALLBACK_TEXT))) ));
check("U14: ... and each of them still shows the model-visible text instead", malformed.every(([, meta]) => treeText(renderSendRow(sendBlock(meta, FALLBACK_TEXT))).includes("回退正文")));
const hostile = { kind: "team-link-send", get v() { throw new Error("hostile getter"); } };
check("U14: a receipt with a throwing getter degrades to the plain row instead of taking the transcript down", isSendPlain(renderSendRow(sendBlock(hostile, FALLBACK_TEXT))));
check("U14: the reader is total — it never throws for any of these shapes", malformed.every(([, meta]) => {
	try {
		renderSendRow(sendBlock(meta, FALLBACK_TEXT));
		return true;
	} catch {
		return false;
	}
}));

// ---------------------------------------------------------------------------
// DEFECT-5 / §10.1.5 文本重建（2026-09-20）: a send with NO receipt but with a
// model-visible text OUR OWN host half minted is rebuilt into A's minimal card.
//
// Why it is needed (measured, not inferred): `presentationMeta` is projected only
// for a TOP-LEVEL dispatch — `exec.parent === undefined`
// (`dsh-tools/lib/types/index.js:1191`) — so a `team_link_send` issued from inside
// a `run_code` program never gets a `tool/result.meta`. The bridge logs
// `tool/ptc-dispatch` with exactly
// `{rootCallId, parentCallId, subCallId, name, arguments, isError, content}`
// (no `meta`), and the chat package's `childResult` mints no `meta` on the block
// either. A read-only scan of all 1311 session logs in the store found 733 such
// dispatches with ZERO `meta`, against 11 `tool/result` events that DO carry a
// card — i.e. every program-issued send was the grey fallback row while the
// directly-issued ones had cards.
//
// The fixtures below are the host's two report shapes, copied VERBATIM out of
// `lib/index.js` (`deliverToTarget`'s success sentence; `fanout`'s lead, header,
// rows and summary). The lock that keeps those copies HONEST is cross-half and
// lives in `host-half.test.mjs`: it renders the REAL text a REAL send produced
// and compares the rebuilt card's rows against the structured receipt of that
// same send. These copies exist so the client half can pin the parser's own
// behaviour without importing the host.
// ---------------------------------------------------------------------------

/** The single-target success sentence, as `deliverToTarget` writes it. */
const REBUILT_DELIVERED_TEXT = "已投递到 session-worker-a（已配对通道，免确认自动投递）：目标空闲，已唤醒目标会话并作为新回合处理（消息与回复稍后出现在目标会话中）。";
/** A two-target fan-out report: one delivered, one refused, with the ❌ lead. */
const REBUILT_FANOUT_TEXT = [
	"❌ 1 个目标未投递（1 个已投递）",
	"广播 fan-out：2 个目标",
	`- session-worker-a（via team:night-shift/*） → delivered：${REBUILT_DELIVERED_TEXT}`,
	"- session-worker-b（via team:night-shift/*） → refused：发送失败：跨会话发送需要用户批准，但确认服务（userQuestions）不可用。",
	"汇总：1 投递 / 1 拒绝。",
].join("\n");
/** `renderSendRow` for a settled block with NO receipt at all. */
const renderRebuiltRow = (text) => renderSendRow(sendBlock(undefined, text));
/** The four statements A draws, in render order (label, then one entry per row). */
const rebuiltRowsOf = (tree) => treeAllByClass(tree, "dshsl-send-target").map((row) => ({
	identity: treeText(treeByClass(row, "dshsl-send-targetid")),
	outcome: treeText(treeByClass(row, "dshsl-send-outcome")),
	token: treeByClass(row, "dshsl-send-outcome").props["data-outcome"],
}));
/** One row's statement, or an EMPTY record when the row is not there — so a red
 * run reports the mismatch and carries on instead of dying mid-suite. A suite that
 * stops before `assertion total` hides every assertion after it (③b Y7 的教训). */
const rebuiltRowAt = (tree, index) => rebuiltRowsOf(tree)[index] ?? { identity: undefined, outcome: undefined, token: undefined };

const rebuiltDelivered = renderRebuiltRow(REBUILT_DELIVERED_TEXT);
check("DEFECT-5: a settled call with no receipt whose text IS our delivered sentence renders a CARD, not the grey fallback row", isSendCard(rebuiltDelivered) && !isSendPlain(rebuiltDelivered));
check("DEFECT-5: ... its minimal label still names the tool and the true target count", treeText(treeByClass(rebuiltDelivered, "dshsl-send-rowhead")) === "✦ 工具调用 · team_link_send · 1 个目标");
check("DEFECT-5: ... and its one row is the target identity plus the outcome's short phrase", JSON.stringify(rebuiltRowsOf(rebuiltDelivered)) === JSON.stringify([{ identity: "session-worker-a", outcome: "已送达", token: "delivered" }]));
// The channel note is between the label and the separator, so the id has to be
// read past it; a titled label puts the title (user text, possibly containing the
// separator) in front of the id.
const rebuiltTitled = renderRebuiltRow("已投递到 「目标会话」(session-target)（provisional 通道，24h 内未批准自动回退）：目标空闲，已唤醒目标会话并作为新回合处理（消息与回复稍后出现在目标会话中）。");
check("DEFECT-5: a titled label with a channel note still resolves to the session id (both wrappers are stripped)", rebuiltRowAt(rebuiltTitled, 0).identity === "session-target");
const rebuiltTitledColon = renderRebuiltRow("已投递到 「会议：方案」(session-x)：目标空闲，已唤醒目标会话并作为新回合处理（消息与回复稍后出现在目标会话中）。");
check("DEFECT-5: a title containing the separator does not steal it — the id is still session-x", rebuiltRowAt(rebuiltTitledColon, 0).identity === "session-x" && rebuiltTitledColon !== null && isSendCard(rebuiltTitledColon));
const rebuiltNoTitle = renderRebuiltRow("已投递到 session-y：目标空闲，已唤醒目标会话并作为新回合处理（消息与回复稍后出现在目标会话中）。");
check("DEFECT-5: an untitled, un-noted label is the bare session id", rebuiltRowAt(rebuiltNoTitle, 0).identity === "session-y");
// ② 往返（客户端侧）: the identity goes through the SAME shortening helper on both
// faces, so a long id round-trips as well — and it is the SHORT form, not the raw
// label, that both faces must state.
const REBUILT_LONG_ID = "session-6eba9a3f-1234-5678-9abc-d5d8f4cb1234";
const longRebuiltRow = renderRebuiltRow(`已投递到 ${REBUILT_LONG_ID}（已配对通道，免确认自动投递）：目标空闲，已唤醒目标会话并作为新回合处理（消息与回复稍后出现在目标会话中）。`);
const longStructuredRow = renderSendRow(sendBlock({ ...SEND_CARD, targets: [{ sessionId: REBUILT_LONG_ID, expr: undefined, outcome: "delivered", detail: "已投递到 x" }], summary: { delivered: 1, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 } }));
check("② 往返（客户端侧）: a long id rebuilds to the SAME short display form the structured row renders — and not to the raw label", rebuiltRowAt(longRebuiltRow, 0).identity === rebuiltRowAt(longStructuredRow, 0).identity && rebuiltRowAt(longRebuiltRow, 0).identity !== REBUILT_LONG_ID && rebuiltRowAt(longRebuiltRow, 0).identity.includes("…"));

const rebuiltFanout = renderRebuiltRow(REBUILT_FANOUT_TEXT);
check("DEFECT-5: a fan-out report with no receipt renders a CARD with one row per target", isSendCard(rebuiltFanout) && !isSendPlain(rebuiltFanout));
check("DEFECT-5: ... its label states the report's own target count", treeText(treeByClass(rebuiltFanout, "dshsl-send-rowhead")) === "✦ 工具调用 · team_link_send · 2 个目标");
check("DEFECT-5: ... and each row carries the identity the report labelled, with its outcome's phrase and token", JSON.stringify(rebuiltRowsOf(rebuiltFanout)) === JSON.stringify([
	{ identity: "session-worker-a（via team:night-shift/*）", outcome: "已送达", token: "delivered" },
	{ identity: "session-worker-b（via team:night-shift/*）", outcome: "未送达——接收方拒绝", token: "refused" },
]));
check("DEFECT-5: ... while the ❌ lead, the fan-out header and the summary stay off A (A owns the rows, and nothing else)", !treeText(rebuiltFanout).includes("汇总：") && !treeText(rebuiltFanout).includes("个目标未投递") && !treeText(rebuiltFanout).includes("广播 fan-out"));
// The vacant-role row has no session id at all: its label IS the addressing
// expression, and that is what the structured card carries too (`sessionId:null`).
const rebuiltVacant = renderRebuiltRow([
	"❌ 1 个目标未投递（0 个已投递）",
	"广播 fan-out：1 个目标",
	"- team:night-shift/reviewer → no-holder：该角色当前空缺",
	"汇总：0 投递 / 0 拒绝 / 1 空缺目标（no-holder，不计入投递与失败）。",
].join("\n"));
check("DEFECT-5: a vacant-role row rebuilds as the expression itself with the no-holder phrase", JSON.stringify(rebuiltRowsOf(rebuiltVacant)) === JSON.stringify([{ identity: "team:night-shift/reviewer", outcome: "未送达——该角色当前空缺", token: "no-holder" }]));
// A row's detail may be a MULTI-LINE paragraph (the `no-agent` refusal joins
// three sentences with newlines and indents its own list). Those lines are the
// row's, not new rows: the row count must still match the header's declaration.
const rebuiltMultiLine = renderRebuiltRow([
	"❌ 1 个目标未投递（0 个已投递）",
	"广播 fan-out：1 个目标",
	"- session-nope → no-agent：❌ 未投递：目标会话 session-nope 没有活动代理（未在本壳中打开或已退出）。仅支持投递到存活会话。",
	"当前工作区无其他存活会话。",
	"提示：请对照上列 id 核对目标 id（常见错误：转录错位）；也可先调 team_link_list_sessions 查询。",
	"汇总：0 投递 / 0 拒绝 / 1 无活动代理。",
].join("\n"));
check("DEFECT-5: a multi-line row detail is one row, not three (the report's own indented list does not become target rows)", JSON.stringify(rebuiltRowsOf(rebuiltMultiLine)) === JSON.stringify([{ identity: "session-nope", outcome: "未送达——目标会话没有活动代理", token: "no-agent" }]));
const rebuiltDeduped = renderRebuiltRow([
	"广播 fan-out：1 个目标（重复目标已去重 2 个）",
	"- session-worker-a → delivered：已投递到 session-worker-a：目标空闲。",
	"汇总：1 投递 / 0 拒绝 / 2 个重复目标已去重。",
].join("\n"));
check("DEFECT-5: an all-delivered report carries NO ❌ lead and still rebuilds", isSendCard(rebuiltDeduped) && rebuiltRowsOf(rebuiltDeduped).length === 1);
const rebuiltNoted = renderRebuiltRow(`${REBUILT_DELIVERED_TEXT}\n注意：meta.ref 超过 16 字符（原 17 字符），已按码点截断。`);
check("DEFECT-5: a trailing 注意 note does not stop the rebuild (the note stays the model-visible report's)", isSendCard(rebuiltNoted) && rebuiltRowAt(rebuiltNoted, 0).identity === "session-worker-a" && !treeText(rebuiltNoted).includes("meta.ref"));

// --- ③ 不伪造: what the rebuild cannot place stays a PLAIN row, verbatim ------
// The rebuild is all-or-nothing. A single-target REFUSAL names no target at all
// in our text, a reworded report is not a shape this build reads, and a report
// whose own numbers disagree is not trustworthy — each of them must fall to the
// plain face with every line intact, never to a half-invented card.
const UNPLACEABLE = [
	["a single-target refusal (our text names no target there at all)", "未投递：目标会话用户未在 3 分钟内确认接收。"],
	["a no-agent refusal (the refusal paragraph, not a report)", "❌ 未投递：目标会话 session-nope 没有活动代理（未在本壳中打开或已退出）。仅支持投递到存活会话。\n当前工作区无其他存活会话。\n提示：请对照上列 id 核对目标 id。"],
	["an addressing/meta rejection", "发送失败：targets（广播 fan-out）与 targetSessionId（单目标）互斥——一次调用只能用一种寻址方式。"],
	["a report whose row separator was reworded", REBUILT_FANOUT_TEXT.split(" → ").join(" -> ")],
	["a report whose summary disagrees with its own rows", REBUILT_FANOUT_TEXT.replace("汇总：1 投递 / 1 拒绝。", "汇总：2 投递 / 0 拒绝。")],
	["a report whose ❌ lead disagrees with its own rows", REBUILT_FANOUT_TEXT.replace("❌ 1 个目标未投递（1 个已投递）", "❌ 2 个目标未投递（0 个已投递）")],
	["a report missing its summary line", REBUILT_FANOUT_TEXT.split("\n").slice(0, -1).join("\n")],
	["a report whose header count disagrees with its rows", REBUILT_FANOUT_TEXT.replace("广播 fan-out：2 个目标", "广播 fan-out：3 个目标")],
	["a report with an outcome token the summary cannot bucket", REBUILT_FANOUT_TEXT.replace(" → refused：", " → delayed：")],
	["a report with a line the shape has no place for", `${REBUILT_FANOUT_TEXT}\n这是多出来的一行。`],
	["a delivered sentence with an unreadable label", "已投递到 「没有闭合引号的标题(session-x)：目标空闲。"],
];
check(`③ 不伪造: none of the ${UNPLACEABLE.length} texts this build cannot place becomes a card`, UNPLACEABLE.every(([, text]) => isSendPlain(renderRebuiltRow(text)) && !isSendCard(renderRebuiltRow(text))));
check("③ 不伪造: ... and every one of them is shown VERBATIM on the plain face (nothing swallowed, nothing rewritten)", UNPLACEABLE.every(([, text]) => treeText(treeByClass(renderRebuiltRow(text), "dshsl-plain-body")) === text));
check("③ 不伪造: ... and the rebuild never throws for any of them, nor for junk input", UNPLACEABLE.every(([, text]) => {
	try { renderRebuiltRow(text); return true; } catch { return false; }
}) && [undefined, null, 7, "", "\n\n", "❌", "广播 fan-out：x 个目标", "汇总：。", "- → ："].every((text) => {
	try {
		const tree = renderSendRow(sendBlock(undefined, text));
		return tree !== null && tree !== undefined;
	} catch {
		return false;
	}
}));
// No field is invented. Our text carries no turn-start time, so a row whose
// detail reports one must NOT grow a busy badge the structured card would have
// needed `target.busy` for.
const rebuiltBusyish = renderRebuiltRow([
	"广播 fan-out：1 个目标",
	"- session-worker-a → delivered：已投递到 session-worker-a：目标正在运行，消息将在步边界注入当前回合。目标回合已运行 7 分钟（steer 注入当前回合）；需新回合语义请等其空闲。",
	"汇总：1 投递 / 0 拒绝。",
].join("\n"));
check("③ 不伪造: the rebuild reads no `busy` out of the mechanism sentence — no badge is invented, and the sentence itself stays off the card", isSendCard(rebuiltBusyish) && !treeText(rebuiltBusyish).includes("忙碌") && !treeText(rebuiltBusyish).includes("已运行 7 分钟") && !treeText(rebuiltBusyish).includes("steer"));
const rebuiltIsNotATarget = treeAllByClass(rebuiltBusyish, "dshsl-send-target").length === 1;
check("③ 不伪造: ... and the report's own sentence is not mistaken for a second row", rebuiltIsNotATarget);
// A rebuilt card is A's alone: D is driven by the receipt's discriminator through
// the definition match, so it can never be produced from text. (Asserted further
// down, beside the definition driver, where those fixtures exist.)

// --- ① 有 meta 时永远走结构化路径 --------------------------------------------
// The rebuild is a DEGRADATION, never a second opinion. The decoy below carries a
// perfectly readable receipt AND a text that parses into a DIFFERENT card (2
// targets instead of 3); if the two sources were ever consulted in the other
// order, the decoy would win and this is red. Making the whole rebuild a
// constant `null` must leave this assertion green — that is the property that
// keeps the fallback from overriding structure.
const decoyText = REBUILT_FANOUT_TEXT;
const decoyRow = renderSendRow(sendBlock(SEND_CARD, decoyText));
check("① 有 meta 时永远走结构化路径: a readable receipt decides the card even when the model-visible text would rebuild into a DIFFERENT one", JSON.stringify(rebuiltRowsOf(decoyRow)) === JSON.stringify([
	{ identity: "session-worker-a（via team:night-shift/*）", outcome: "已送达", token: "delivered" },
	{ identity: "session-worker-b（via team:night-shift/*）", outcome: "未送达——接收方拒绝", token: "refused" },
	{ identity: "team:night-shift/reviewer", outcome: "未送达——该角色当前空缺", token: "no-holder" },
]) && treeText(treeByClass(decoyRow, "dshsl-send-rowhead")) === "✦ 工具调用 · team_link_send · 3 个目标");
// The other direction of the same rule: an UNREADABLE receipt is exactly the
// 「meta 不可读」 case §10.1.5 hands to the rebuild.
check("① 有 meta 时永远走结构化路径: an UNREADABLE receipt falls through to the rebuild instead of to the plain row", isSendCard(renderSendRow(sendBlock({ kind: "fs-search", v: 1 }, REBUILT_DELIVERED_TEXT))) && isSendCard(renderSendRow(sendBlock({ ...SEND_CARD, v: 2 }, REBUILT_DELIVERED_TEXT))));

// --- the receipt's row bound (round-1 🔵 #2) ---------------------------------
// `meta` is CORE-OPAQUE and persisted, so a hand-edited log or a heterogeneous
// implementation can carry any number of `targets`, and A draws one row per
// entry — an unbounded transcript row. The bound cannot be the host's fan-out
// cap of 8 EXPRESSIONS: `resolveTargetList` caps the input list, but ONE
// `team:<name>/*` entry expands to every filled live role (`resolveTargets`) and
// `buildSendCard` copies every resolved row without a cap, so a legal broadcast
// can exceed 8 rows — refusing those outright would degrade a real card. The row
// count is therefore bounded at render time (option (b) of the review) and the
// truncation is stated on A, which is the face that owns the rows.
const overCapTargets = Array.from({ length: 30 }, (_, i) => ({ sessionId: `session-worker-${i}`, outcome: "delivered", detail: `已投递到 session-worker-${i}` }));
const overCapCard = { ...SEND_CARD, targets: overCapTargets, summary: { delivered: 30, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 } };
const overCapRow = renderSendRow(sendBlock(overCapCard));
check("评审 #2: a receipt with MORE targets than the row cap still renders as a card — the send is not thrown away for being large", isSendCard(overCapRow));
check("评审 #2: ... but A draws a BOUNDED number of rows, not one per target", treeAllByClass(overCapRow, "dshsl-send-target").length === 24 && overCapTargets.length === 30);
check("评审 #2: ... and the truncation is stated on the card, explicitly", treeText(treeByClass(overCapRow, "dshsl-send-rows-trunc")) === "（已截断——仅显示前 24 行）");
check("评审 #2: ... while the label still states the TRUE target count (the bound hides rows, not the total)", treeText(treeByClass(overCapRow, "dshsl-send-rowhead")) === "✦ 工具调用 · team_link_send · 30 个目标");
const overCapTop = renderTopCard(overCapCard);
check("评审 #2: ... and D renders the same receipt with no truncation note (the note belongs to A, the row-owning face)", overCapTop !== null && treeByClass(overCapTop, "dshsl-relay dshsl-send").props["data-slp-send"] === "top" && treeByClass(overCapTop, "dshsl-send-rows-trunc") === null && treeText(treeByClass(overCapTop, "dshsl-send-summary")).includes("30 投递"));
const atCapRow = renderSendRow(sendBlock({ ...SEND_CARD, targets: Array.from({ length: 24 }, (_, i) => ({ sessionId: `session-worker-${i}`, outcome: "delivered", detail: "已投递" })), summary: { delivered: 24, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 } }));
check("评审 #2 对照: the cap is inclusive — a receipt at exactly 24 rows renders all 24 with NO truncation note", treeAllByClass(atCapRow, "dshsl-send-target").length === 24 && treeByClass(atCapRow, "dshsl-send-rows-trunc") === null);
check("评审 #2 对照: ... and an ordinary 3-target receipt is untouched by the bound", treeAllByClass(cardRow, "dshsl-send-target").length === 3 && treeByClass(cardRow, "dshsl-send-rows-trunc") === null);

// --- §10.1.2 行数界, the HOST half of the contract (U14, 2026-09-19 收尾轮) ---
// The host half caps its OWN rows at the same 24 AS IT WRITES the receipt and
// states the cut as `targetsTruncated: { shown, total }` (`lib/index.js`
// `buildSendCard`). A client that only counts rows therefore reads a
// host-produced card as "24 rows — not over the cap": it raises no truncation
// note at all, and its label reports the DRAWN 24 for a 30-target delivery.
// The mark is the only carrier of that fact, so A reads it (the receipt is
// core-opaque and persisted — the mark is as untrusted as the rest of `meta`)
// and the label takes `total` as the number it owes. Both ways a receipt can be
// over the row bound then show up on the face that owns the rows.
const hostCutTargets = Array.from({ length: 24 }, (_, i) => ({ sessionId: `session-worker-${i}`, outcome: "delivered", detail: `已投递到 session-worker-${i}` }));
const hostCutCard = { ...SEND_CARD, targets: hostCutTargets, targetsTruncated: { shown: 24, total: 30 }, summary: { delivered: 30, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 } };
const hostCutRow = renderSendRow(sendBlock(hostCutCard));
check("U14 跨轮: a HOST-cut receipt (24 rows + the `targetsTruncated` mark) still renders as a card", isSendCard(hostCutRow) && !isSendPlain(hostCutRow));
// ① 有 meta 时永远走结构化路径, the control that makes the claim checkable: every
// meta-bearing fixture of this suite still cards when the text beside it is the
// decoy report. Turning the whole §10.1.5 rebuild into a constant `null` must
// leave this green — `host-half.test.mjs` runs the red phase for that direction.
check("① 有 meta 时永远走结构化路径: every meta-bearing fixture still renders a card beside a decoy text (the rebuild is never consulted for a readable receipt)", [SEND_CARD, overCapCard, hostCutCard, { ...SEND_CARD, message: { text: "", truncated: false, chars: 0 } }].every((card) => isSendCard(renderSendRow(sendBlock(card, decoyText)))));
check("U14 跨轮: ... A states the truncation explicitly, at the mark's shown count", treeText(treeByClass(hostCutRow, "dshsl-send-rows-trunc")) === "（已截断——仅显示前 24 行）");
check("U14 跨轮: ... and the label states the TRUE total (30) from the mark, not the 24 rows the host had already drawn", treeText(treeByClass(hostCutRow, "dshsl-send-rowhead")) === "✦ 工具调用 · team_link_send · 30 个目标");
check("U14 跨轮: ... with exactly the 24 rows the host kept being what is drawn", treeAllByClass(hostCutRow, "dshsl-send-target").length === 24);
check("U14 跨轮: both ways a receipt can be over the row bound are visible on A — the host's own mark and the render-time cap for a receipt this file did not mint", treeText(treeByClass(hostCutRow, "dshsl-send-rows-trunc")) !== "" && treeText(treeByClass(overCapRow, "dshsl-send-rows-trunc")) === "（已截断——仅显示前 24 行）" && treeText(treeByClass(overCapRow, "dshsl-send-rowhead")) === "✦ 工具调用 · team_link_send · 30 个目标");
// The mark is core-opaque like the rest of `meta`, and it is a display
// statement only: a shape this build cannot read is DROPPED (the card still
// renders and the label falls back to the rows it actually has) — it must never
// be able to put a non-number into the label or invent a note.
const unreadableMarkRow = renderSendRow(sendBlock({ ...SEND_CARD, targets: hostCutTargets, targetsTruncated: { shown: "24", total: 30 }, summary: { delivered: 30, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 } }));
check("U14 跨轮: an unreadable mark is dropped, not trusted (the label falls back to the rows it has, and no note is invented)", isSendCard(unreadableMarkRow) && treeText(treeByClass(unreadableMarkRow, "dshsl-send-rowhead")) === "✦ 工具调用 · team_link_send · 24 个目标" && treeByClass(unreadableMarkRow, "dshsl-send-rows-trunc") === null);
// The number in 「仅显示前 N 行」 is the number of rows ACTUALLY drawn, never a
// count the mark merely asserts: here a hand-edited `shown` says 5 while the
// card draws 24, so 24 is what the sentence may state.
const lyingMarkRow = renderSendRow(sendBlock({ ...SEND_CARD, targets: overCapTargets, targetsTruncated: { shown: 5, total: 30 }, summary: { delivered: 30, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 } }));
check("U14 跨轮: ... the note counts the rows drawn, never a number the mark merely asserts", treeText(treeByClass(lyingMarkRow, "dshsl-send-rows-trunc")) === "（已截断——仅显示前 24 行）" && treeText(treeByClass(lyingMarkRow, "dshsl-send-rowhead")) === "✦ 工具调用 · team_link_send · 30 个目标");
// 对照: the visible text of a card with NO mark and ≤ 24 rows is byte-for-byte
// what it was before this round — no note, and the label is its own row count
// (the two shapes the 评审 #2 block above already pins, restated here as the
// control for the mark path).
check("U14 跨轮 对照: a 3-target card and a no-mark 24-row card carry NO truncation note and label their own row count", treeByClass(cardRow, "dshsl-send-rows-trunc") === null && treeText(treeByClass(cardRow, "dshsl-send-rowhead")) === "✦ 工具调用 · team_link_send · 3 个目标" && treeByClass(atCapRow, "dshsl-send-rows-trunc") === null && treeText(treeByClass(atCapRow, "dshsl-send-rowhead")) === "✦ 工具调用 · team_link_send · 24 个目标");

// ---------------------------------------------------------------------------
// U15 (§10.1.3 D): this plugin's own Conversation Definition and the top-level
// node it produces — matched on EXISTING tool/call + tool/result events only.
// ---------------------------------------------------------------------------

// (`relayNodeSlot` / `topSlot` are looked up above, beside the tool row: §10.1.5
// is a property of the PAIR of faces, so both are needed by the A assertions too.)
check("U15: the top-level node renderer is registered under its own kind, beside the receiver's context card", topSlot !== undefined && relayNodeSlot !== undefined && topSlot.options.key !== relayNodeSlot.options.key);
check("U15: ... at the §10.1.3 priority, in this plugin's locale namespace", topSlot.options.priority === -90 && topSlot.options.locale === "dsh-team-link");
check("U15: the two coexist on the same keyed slot (a second entry at the SAME key would throw; these are different keys)", registrations.filter((entry) => entry.options.name === "conversation.chat.node").length === 2);
check("U15: the definition reaches the uiConversation registry, and its kind is the card's discriminator (def / slot / data cannot drift apart)", registeredDefinition !== null && registeredDefinition.kind === "team-link-send" && registeredDefinition.kind === topSlot.options.key);
check("U15: the definition declares the chat view target together with a buildViewNode (the registry requires the pair)", registeredDefinition.target === "chat" && typeof registeredDefinition.buildViewNode === "function");
check("U15: the definition owns no Location-data publication and no new event source — it is a reader of the existing log", registeredDefinition.buildLocationData === undefined);

const callEvent = (name, callId, seq = 10, time = 1_700_000_000_000) => ({ type: "tool/call", seq, time, data: { turn: 1, step: 1, callId, name, arguments: "{\"message\":\"x\"}" } });
const resultEvent = (callId, meta, seq = 11, time = 1_700_000_001_000, name = "team_link_send") => ({
	type: "tool/result",
	seq,
	time,
	data: { turn: 1, step: 1, message: { source: { callId, name, role: "tool" }, content: [{ type: "text", text: "已投递" }] }, meta },
});

check("U15: a tool/call for THIS tool is claimed as a start, keyed by the call id", JSON.stringify(registeredDefinition.match(callEvent("team_link_send", "call-9"))) === JSON.stringify({ id: "call-9", role: "start" }));
check("U15: a tool/call for any other tool is NOT claimed (the kind never fires on foreign calls)", ["send_message", "team_link_list_sessions", "bash"].every((name) => registeredDefinition.match(callEvent(name, "call-9")) === null));
check("U15: no other event type is claimed — the definition reads existing events, it does not invent one", ["user/message", "assistant/message", "turn/start", "turn/end", "command/run", "team-link-send"].every((type) => registeredDefinition.match({ type, seq: 1, time: 1, data: {} }) === null));
check("U15: a tool/result carrying our receipt is claimed as the update for that call", JSON.stringify(registeredDefinition.match(resultEvent("call-9", SEND_CARD))) === JSON.stringify({ id: "call-9", role: "update" }));
check("U15: a tool/result with no receipt is NOT claimed (no engine Context for every tool call in the session)", registeredDefinition.match(resultEvent("call-9", undefined)) === null && registeredDefinition.match(resultEvent("call-9", { kind: "fs-search" })) === null);
check("U15: a malformed event never throws the match (the reader is total)", [null, undefined, 7, {}, { type: "tool/call" }, { type: "tool/result" }].every((event) => {
	try {
		return registeredDefinition.match(event) === null || typeof registeredDefinition.match(event) === "object";
	} catch {
		return false;
	}
}));

/** Drive the definition the way the assembler does: `start` for the call, then
 * `update` for each later match, with the Context grown as it goes (the start
 * event is always `matches[0]`, per the registry's own invariant). */
function driveDefinition(events) {
	let context = { key: "team-link-send\u0000call-1", kind: "team-link-send", id: "call-1", matches: [], start: undefined, state: undefined };
	for (const event of events) {
		const match = registeredDefinition.match(event);
		if (match === null) continue;
		const entry = { event, role: match.role, location: { kind: "step", turn: {}, step: {} } };
		const isStart = match.role === "start";
		context = { ...context, matches: [...context.matches, entry], start: isStart ? entry : context.start };
		if (isStart) context.state = registeredDefinition.start(context, entry);
		else if (context.state !== undefined) context.state = registeredDefinition.update(context, entry);
	}
	return { context, node: registeredDefinition.buildViewNode(context) };
}

const fullRun = driveDefinition([callEvent("team_link_send", "call-1"), resultEvent("call-1", SEND_CARD)]);
const fullRunFace = flatten(topSlot.component({ node: fullRun.node, t: tZh }));
check("U15: a settled send produces a top-level node", fullRun.node !== null && fullRun.node.kind === "team-link-send");
check("U15: the node is a full chat view node — key/kind/id/target/anchorSeq/location/visibility/data", fullRun.node.key === fullRun.context.key && fullRun.node.id === "call-1" && fullRun.node.target === "chat" && fullRun.node.anchorSeq === 10 && fullRun.node.visibility === "visible" && fullRun.node.location !== undefined && fullRun.node.data !== undefined);
check("U15: the node renders the SUMMARY face — counts, title/time and body, and NOT one per-target row (those stay in the tool row)", treeByClass(fullRunFace, "dshsl-send-summary") !== null && treeAllByClass(fullRunFace, "dshsl-send-target").length === 0 && !treeText(fullRunFace).includes("未投递：目标会话用户未确认接收。") && !treeText(fullRunFace).includes("session-worker-b") && !treeText(fullRunFace).includes("team:night-shift/*"));
check("U15: ... and the summary counts, the body and the time are on it", treeText(fullRunFace).includes("汇总：1 投递 / 1 拒绝 / 0 无活动代理 / 1 空缺目标") && treeText(fullRunFace).includes("裁决：走 A 方案") && treeText(fullRunFace).includes(new Date(SEND_CARD.at).toLocaleString()));
check("U15: the top-level card is flagged as the top face (a different face from the tool row's)", treeByClass(fullRunFace, "dshsl-relay dshsl-send").props["data-slp-send"] === "top");

// ---------------------------------------------------------------------------
// F1 (差异审计 / §10.1.5 两面的信息分工): every statement appears EXACTLY ONCE
// after the two faces are unioned. The blocks are disjoint by construction — A
// renders the label + the per-target rows, D renders head + body + summary — and
// this is the assertion that goes red the moment one of them creeps back onto
// the other face (the pre-F1 pair printed head/body/summary/foot verbatim twice).
// ---------------------------------------------------------------------------

/** The statements one face prints, in render order: A's label and then one entry
 * per target row, plus (for D) the head, the body and the summary. The removed
 * foot class is scanned too, so re-adding that sentence cannot slip past the
 * union check. */
function faceStatements(tree) {
	const out = [];
	const rowhead = treeByClass(tree, "dshsl-send-rowhead");
	if (rowhead !== null) out.push(treeText(rowhead));
	for (const row of treeAllByClass(tree, "dshsl-send-target")) out.push(treeText(row));
	for (const className of ["dshsl-relay-head", "dshsl-relay-body", "dshsl-send-summary", "dshsl-relay-foot"]) {
		const block = treeByClass(tree, className);
		if (block !== null) out.push(treeText(block));
	}
	return out;
}
const rowStatements = faceStatements(cardRow);
const topStatements = faceStatements(cardTop);
const rowFaceText = treeText(cardRow);
const topFaceText = treeText(cardTop);
/** A statement of one face that also appears anywhere in the other face — the
 * union would then carry that sentence twice. Sub-4-character fragments are not
 * statements and are ignored. */
const restated = rowStatements.filter((text) => text.length >= 4 && topFaceText.includes(text))
	.concat(topStatements.filter((text) => text.length >= 4 && rowFaceText.includes(text)));
check(`F1 差异审计: the union of the two faces prints every statement exactly once (restated: ${restated.length === 0 ? "none" : restated.join(" || ")})`, restated.length === 0);
check("F1 差异审计: between them the two faces carry every block of the receipt — A the label + 3 rows, D the head + body + summary", rowStatements.length === 4 && topStatements.length === 3);
check("F1 差异审计: ... and neither face restates a block of the other (no head/body/summary/foot on A, no label or row container on D)", [treeByClass(cardRow, "dshsl-relay-head"), treeByClass(cardRow, "dshsl-relay-body"), treeByClass(cardRow, "dshsl-send-summary"), treeByClass(cardRow, "dshsl-relay-foot"), treeByClass(cardTop, "dshsl-send-rowhead"), treeByClass(cardTop, "dshsl-send-targets")].every((node) => node === null));

// ---------------------------------------------------------------------------
// 2026-09-20 §10.1.5 修订: the CARD half of the outcome enum.
//
// A's row now renders `target.outcome` through the module-scope `OUTCOME_PHRASES`
// map instead of copying `target.detail`. That makes the map the contract between
// the two halves — the host MINTED the tokens, this map must PHRASE them — and
// the lock on it is a BEHAVIOR one (a new enum value without a phrase is red),
// never an equality between two products of the same change (the shape that can
// never go red, §12.3 ⑤). The text's own truth is the running module: the row
// below is rendered with an outcome that is deliberately NOT a host token, and
// the client must show it as-is rather than swallow it or invent a phrase.
// ---------------------------------------------------------------------------
// The map's keys are read out of the SOURCE literal (the same way the host half
// reads it), so this assertion is about what the file declares — not about a list
// copied into the test.
const outcomeMapSource = /const OUTCOME_PHRASES = Object\.freeze\(\{([\s\S]*?)\}\);/u.exec(SOURCE);
const outcomeMapPairs = outcomeMapSource === null ? [] : [...outcomeMapSource[1].matchAll(/"([^"]+)":\s*"([^"]+)"/gu)].map((match) => [match[1], match[2]]);
check(`§12.5 跨半边锁（客户端侧）: the outcome→phrase map is a real literal in the bundle (parsed ${outcomeMapPairs.length} pairs)`, outcomeMapPairs.length === 4);
check("§12.5 跨半边锁（客户端侧）: the map declares exactly the four tokens the host mints, in that order, and every phrase key is declared in BOTH dictionaries", outcomeMapPairs.map(([outcome]) => outcome).join(",") === "delivered,refused,no-agent,no-holder" && outcomeMapPairs.every(([, key]) => typeof localeDicts.get("zh")?.[key] === "string" && typeof localeDicts.get("en")?.[key] === "string"));
check("§12.5 跨半边锁（客户端侧）: the phrase keys the map declares are the strings the RENDERER asks for (a key sitting in the map with no `t(\"…\")` call is a phrase the card can never print)", outcomeMapPairs.every(([, key]) => SOURCE.includes(`"${key}"`)));
const unknownOutcomeRow = renderSendRow(sendBlock({ ...SEND_CARD, targets: [{ sessionId: "session-worker-a", outcome: "blocked", detail: "这是报告句，不该上卡" }], summary: { delivered: 0, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 } }));
check("§12.5: a token OUTSIDE the map (a newer host) renders as the token itself — the card never swallows it and never invents a phrase", treeText(treeByClass(unknownOutcomeRow, "dshsl-send-outcome")) === "blocked" && !treeText(unknownOutcomeRow).includes("这是报告句，不该上卡"));

const runningRun = driveDefinition([callEvent("team_link_send", "call-1")]);
check("U15: an in-flight send produces NO node yet (there is no receipt to draw)", runningRun.node === null);
const noCardRun = driveDefinition([callEvent("team_link_send", "call-1"), resultEvent("call-1", undefined)]);
check("U15: a call whose result carries no receipt produces no node (and no half card)", noCardRun.node === null);
// DEFECT-5, the same boundary from the rebuild's side: D is driven by the
// receipt's discriminator through this definition, so a card REBUILT from text
// can never acquire a top-level face. A result the rebuild happily turns into A's
// card on the row is still not claimed here.
check("③ 不伪造: a receipt-less result is still NOT claimed by D's definition (a rebuilt card has no top-level face)", registeredDefinition.match(resultEvent("call-1", undefined)) === null && driveDefinition([callEvent("team_link_send", "call-1"), resultEvent("call-1", undefined)]).node === null);

// --- window truncation: only the tool/result is in the loaded history -------
const truncated = driveDefinition([resultEvent("call-1", SEND_CARD, 42)]);
check("U15: with the tool/call outside the window the fallback still produces the node", truncated.node !== null && truncated.node.kind === "team-link-send" && truncated.context.start === undefined);
check("U15: ... anchored on the result event that is actually loaded", truncated.node !== null && truncated.node.anchorSeq === 42 && truncated.node.location !== undefined);
// The wire shape carries no tool name on a result (`ToolMessageSource` is exactly
// `{kind, callId}`), so with the call head out of window the receipt's own
// discriminator is the only claim available — and a meta that is NOT our card
// never becomes a node.
const truncatedForeign = driveDefinition([resultEvent("call-1", { kind: "other-tool" }, 42)]);
check("U15: a lone result WITHOUT our receipt stays unrendered — no node is invented for a foreign call", truncatedForeign.node === null);
check("U15: a node built from a Context the assembler never gave a state does not throw", driveDefinition([{ type: "tool/result", seq: 1, time: 1, data: null }]).node === null);

// --- degrade, never throw (client failure must not take the session down) ---
check("U15: a node with an unreadable payload renders NOTHING instead of throwing", [null, {}, { data: null }, { data: {} }, { data: { card: { kind: "team-link-send" } } }].every((node) => {
	try {
		return topSlot.component({ node, t: tZh }) === null;
	} catch {
		return false;
	}
}));
check("U15: the renderer stays total for a hostile getter too", (() => {
	try {
		return topSlot.component({ node: { get data() { throw new Error("hostile"); } }, t: tZh }) === null;
	} catch {
		return false;
	}
})());

// --- the degradation contract: a broken registry is "no top-level row" ------
// §10.1.5 降级优先: the uiConversation face is a newer public surface, so a shell
// whose registry refuses the definition (or lacks the service entirely) must
// cost the top-level card and NOTHING else — apply() must still complete, and
// the trace is one browser-console line (never a session-log event, §10.3).
/** Apply the bundle again against a fresh context and report what happened.
 * `refuseRegister`/`refuseInject` make the slot service reject one entry — the
 * shape B3 is about (a taken key or an undeclared slot name). */
function applyWith(overrides = {}) {
	const { refuseRegister, refuseInject, ...ctxOverrides } = overrides;
	const fresh = [];
	const warnings = [];
	const definitionsBefore = definitionRegistrations;
	const context = {
		effect(fn) { const disposer = fn(); return typeof disposer === "function" ? disposer : () => {}; },
		locale: { register(_namespace, lang, dict) { localeDicts.set(lang, dict); return () => {}; }, bind() { return (key) => key; } },
		slots: {
			inject(name, register) {
				if (typeof refuseInject === "function" && refuseInject(name)) throw new Error(`slots.inject refused: ${name}`);
				return register();
			},
			register(options, component) {
				if (typeof refuseRegister === "function" && refuseRegister(options)) throw new Error(`slots.register refused: ${options.name}`);
				fresh.push({ options, component });
				return () => {};
			},
			entries() { return []; },
		},
		sessions: sessionsServiceStub,
		get(name) { return serviceGet(name); },
		// cordis `inject`: the default models "every service is there"; the cases
		// below override it to model a shell that lacks a service — §4.3.5's three,
		// or `uiConversation`.
		inject(_specs, callback) { return callback(scopedContext()); },
		...ctxOverrides,
	};
	const realWarn = console.warn;
	console.warn = (...args) => warnings.push(args.map((value) => String(value)).join(" "));
	// The style tag is module-scope and already installed: keep the "injected
	// once" invariant true for these extra applies too.
	const realQuery = documentStub.querySelector;
	documentStub.querySelector = () => ({});
	let thrown = null;
	try {
		moduleExports.apply(context);
	} catch (error) {
		thrown = error;
	} finally {
		documentStub.querySelector = realQuery;
		console.warn = realWarn;
	}
	return { fresh, warnings, thrown, registered: registeredDefinition, definitionCalls: definitionRegistrations - definitionsBefore };
}

const refusing = applyWith({ inject(_specs, callback) { return callback({ uiConversation: { events: { register() { throw new Error("registry refused"); } } } }); } });
check("U15: a registry that REFUSES the definition does not throw out of apply()", refusing.thrown === null);
check("U15: ... it costs only the top-level card, and says so once in the browser console", refusing.warnings.length === 1 && refusing.warnings[0].includes("uiConversation.events.register") && refusing.warnings[0].includes("top-level message card stays off"));
check("U15: ... while every other registration still lands (the header strip, the tool row, both chat rows, the §4.3 sidebar entry)", refusing.fresh.length === 5 && refusing.fresh.filter((entry) => entry.options.name === "conversation.chat.node").length === 2 && refusing.fresh.some((entry) => entry.options.name === "tool.call.toolview" && entry.options.key === "team_link_send"));
// --- F3 (差异审计): the missing service costs the TOP-LEVEL CARD only --------
// Pre-F3 the module-level `inject` array carried `uiConversation`, so a shell
// without that service never ran `apply()` at all: the header strip, the export
// button, the deep-link opener, the tool row and the receiver's card all went
// with it. The fix is the DYNAMIC injection above — the client context has
// cordis's `ctx.inject` (registry mixin, `cordis/lib/index.js:743`), and a
// callback whose deps are unmet simply never runs.
const serviceless = applyWith({ inject(_specs, callback) { return callback({}); } });
check("F3: a shell without the uiConversation service loses ONLY the top-level card — no definition is registered, the other registrations all land", serviceless.thrown === null && serviceless.warnings.length === 0 && serviceless.fresh.length === 5 && serviceless.definitionCalls === 0 && serviceless.fresh.some((entry) => entry.options.name === "tool.call.toolview") && serviceless.fresh.some((entry) => entry.options.name === "conversation.chat.node" && entry.options.key === "context"));
// The real cordis shape when the service is absent (or not yet provided): the
// injected callback is never called at all and nothing throws.
const waiting = applyWith({ inject() { return undefined; } });
check("F3: ... and a context whose inject callback never fires (the real cordis shape without the service) still applies to completion with the same registrations", waiting.thrown === null && waiting.warnings.length === 0 && waiting.fresh.length === 5 && waiting.definitionCalls === 0);
const injectless = applyWith({ inject: undefined });
check("U15: a client context that cannot inject at all is still applied to completion", injectless.thrown === null && injectless.warnings.length === 0 && injectless.fresh.length === 5 && injectless.definitionCalls === 0);
check("F3: the module-level inject array is back to the three services apply() cannot live without — uiConversation is NOT one of them (a hard dependency here would kill the whole client half)", moduleExports.inject.join(",") === "slots,sessions,locale" && moduleExports.inject.indexOf("uiConversation") === -1);
check("F3: the definition still reaches the registry through the dynamic injection when the service IS there (the §10.1.5 contract is a fallback, not a removal)", moduleExports.inject.indexOf("uiConversation") === -1 && registeredDefinition !== null && registeredDefinition.kind === "team-link-send");

// --- B3 (差异审计): one refused slot registration costs that row alone -------
// All FOUR slot registrations share one apply(): before the guard, the first
// `slots.register` to throw aborted every registration after it (and the
// deep-link opener). That includes the header strip, which was the last
// unguarded one (round-1 🔵 #3) and — running first — the most costly to lose.
const names = (result) => result.fresh.map((entry) => entry.options.name === "conversation.chat.node" ? `${entry.options.name}:${entry.options.key}` : entry.options.name).sort().join(",");
const toolRowRefused = applyWith({ refuseRegister: (options) => options.name === "tool.call.toolview" });
check("B3: a refused tool row does not abort apply()", toolRowRefused.thrown === null);
check("B3: ... and the two chat rows, the header strip and the §4.3 entry still land (4 of 5, minus the refused one)", names(toolRowRefused) === "conversation.chat.node:context,conversation.chat.node:team-link-send,conversation.session.header.actions,sidebar.footer.action" && toolRowRefused.warnings.length === 1 && toolRowRefused.warnings[0].includes("tool.call.toolview") && toolRowRefused.warnings[0].includes("other slots are unaffected"));
check("B3: ... and the top-level definition is unaffected by a slot refusal (the faces degrade independently)", toolRowRefused.definitionCalls === 1);
const relayRowRefused = applyWith({ refuseRegister: (options) => options.name === "conversation.chat.node" && options.key === "context" });
check("B3: a refused receiver card costs that row alone — the tool row and the top-level card still land", relayRowRefused.thrown === null && names(relayRowRefused) === "conversation.chat.node:team-link-send,conversation.session.header.actions,sidebar.footer.action,tool.call.toolview" && relayRowRefused.warnings.length === 1 && relayRowRefused.warnings[0].includes("conversation.chat.node") && relayRowRefused.definitionCalls === 1);
const topRowRefused = applyWith({ refuseRegister: (options) => options.name === "conversation.chat.node" && options.key === "team-link-send" });
check("B3: a refused top-level row costs that row alone — the two other registrations still land", topRowRefused.thrown === null && names(topRowRefused) === "conversation.chat.node:context,conversation.session.header.actions,sidebar.footer.action,tool.call.toolview" && topRowRefused.warnings.length === 1 && topRowRefused.warnings[0].includes("team-link-send"));
const injectRefused = applyWith({ refuseInject: (name) => name === "tool.call.toolview" });
check("B3: a THROWING `slots.inject` is caught too (the tool row is the only casualty)", injectRefused.thrown === null && names(injectRefused) === "conversation.chat.node:context,conversation.chat.node:team-link-send,conversation.session.header.actions,sidebar.footer.action" && injectRefused.warnings.length === 1 && injectRefused.warnings[0].includes("slots.inject refused"));
// The header strip is the FOURTH registration and the first to run: unguarded, a
// refusal there aborted the tool row, both chat rows and the deep-link opener
// (round-1 🔵 #3 — the asymmetry B3 exists to remove).
const headerRefused = applyWith({ refuseRegister: (options) => options.name === "conversation.session.header.actions" });
check("B3: a refused HEADER strip costs that row alone — all three §10.1 registrations still land", headerRefused.thrown === null && names(headerRefused) === "conversation.chat.node:context,conversation.chat.node:team-link-send,sidebar.footer.action,tool.call.toolview" && headerRefused.warnings.length === 1 && headerRefused.warnings[0].includes("conversation.session.header.actions") && headerRefused.warnings[0].includes("other slots are unaffected"));
check("B3: ... and the top-level definition still registers (the strip is not on the definition's path)", headerRefused.definitionCalls === 1);

// --- dictionary parity (the copy both faces render comes from one place) -----
const zhKeys = Object.keys(localeDicts.get("zh")).sort().join(",");
const enKeys = Object.keys(localeDicts.get("en")).sort().join(",");
check("U14: the zh and en dictionaries declare the same key set (a missing translation would silently render the key name)", zhKeys === enKeys && zhKeys.includes("sendRowTargets") && !zhKeys.includes("sendRecipients") && !zhKeys.includes("sendFoot"));
// The 2026-09-20 修订 moved A's row copy onto the outcome phrases and the busy
// badge, so the keys the OLD row rendered are gone from BOTH dictionaries and the
// new pair is in both — a key left behind by the rewrite is a dead dictionary
// entry (the same「一处事实」discipline the retired equality assertion was about).
const outcomePhraseKeysPresent = OUTCOME_PHRASE_KEYS.every((key) => zhKeys.includes(key) && enKeys.includes(key));
check("U14: the row's new copy is declared in BOTH dictionaries, and the retired row keys are gone from both (no dead entry left by the rewrite)", outcomePhraseKeysPresent && ["sendResultDelivered", "sendResultRefused", "sendResultNoAgent", "sendResultNoHolder", "sendBusyBadge", "sendBusyBadgeUnknown"].every((key) => zhKeys.includes(key) && enKeys.includes(key)) && ["sendBusyMinutes", "sendBusyUnknown", "outcomeDelivered", "outcomeRefused", "outcomeNoAgent", "outcomeNoHolder"].every((key) => !zhKeys.includes(key) && !enKeys.includes(key)));

// ---------------------------------------------------------------------------
// §4.3 sidebar「会话工具」(session tools) — the entry, the dialog, the actions.
// The design doc is the single source of truth for this UI (§4.3.1–§4.3.7);
// every assertion names the clause it pins.
// ---------------------------------------------------------------------------

const tools = moduleExports.__testing;
check("§4.3 可测面: the bundle exposes the frozen client testing surface the pure rules are judged through", tools !== undefined && tools !== null && typeof tools.visibleSessionRows === "function" && typeof tools.emptySessionToolsState === "function");
// Y7 discipline: this file must also run against a build WITHOUT the §4.3 surface
// (the red phase), so every call into it is type-guarded first — a crash would
// hide the assertion count instead of reporting the missing face.
const t9 = tools === undefined || tools === null ? {} : tools;
const pure = (name) => (...args) => (typeof t9[name] === "function" ? t9[name](...args) : undefined);
const visibleSessionRows = pure("visibleSessionRows");
const filterSessionRows = pure("filterSessionRows");
const sessionToolsBoundNote = pure("sessionToolsBoundNote");
const sessionDotState = pure("sessionDotState");
const relativeTimeText = pure("relativeTimeText");
const makeSessionToolsDialog = pure("makeSessionToolsDialog");
const makeSessionToolsEntry = pure("makeSessionToolsEntry");
const navCalls = [];
/** A scene: the two snapshots §4.3.2 reads plus the navigation face. */
function scene(list, workspaceState) {
	return {
		sessions: { list: { getSnapshot: () => list, subscribe: () => () => {} } },
		workspaces: { list: { getSnapshot: () => workspaceState, subscribe: () => () => {} } },
		uiWorkspace: { openSession(id) { navCalls.push(id); } },
	};
}
/** Every className in a flattened subtree, in document order. */
function allClasses(tree) {
	if (tree === null || tree === undefined || typeof tree !== "object") return [];
	if (Array.isArray(tree)) return tree.flatMap(allClasses);
	const here = tree.props !== undefined && typeof tree.props.className === "string" ? [tree.props.className] : [];
	return [...here, ...allClasses(tree.children)];
}
/** Open the entry the way a user does (click) and mount the dialog it rendered. */
function openDialog(entry) {
	const button = entry.tree.children[0];
	button.props.onClick();
	const element = entry.tree.children[1];
	if (element === null || element === undefined) return null;
	return { element, instance: mount(element.type, element.props) };
}
/** One dialog over one scene, mounted and ready to be driven. */
function dialogOver(list, workspaceState) {
	return mount(makeSessionToolsDialog(scene(list, workspaceState), primitivesStub), { t: tZh, onClose() {} });
}
const fill = (template, key, value) => String(template).split("{" + key + "}").join(String(value));
const rowOf = (id, over = {}) => ({ id, displayTitle: "会话 " + id, updatedAt: 2000, running: false, retainedBy: { mainView: 0 }, blank: false, ...over });
const curOf = (id, over = {}) => rowOf(id, { displayTitle: "当前 " + id, updatedAt: 3000, retainedBy: { mainView: 1 }, ...over });
const listOf = (ids, byId, phase = "ready") => ({ ids, byId, phase });
const NO_WORKSPACES = { items: [], archivedSessionIds: [] };
const popularList = listOf(["session-cur", "session-a", "session-b"], { "session-cur": curOf("session-cur"), "session-a": rowOf("session-a"), "session-b": rowOf("session-b") });

// The whole §4.3 block below needs the surface to exist. The RED phase runs this
// file against a build without it, so the guard is explicit: the missing faces are
// reported as failures FIRST (never as a crash), and the detailed assertions then
// run only where they can actually judge something.
const sessionToolsSurfacePresent = typeof t9.makeSessionToolsEntry === "function" && typeof t9.makeSessionToolsDialog === "function" && typeof t9.visibleSessionRows === "function" && typeof t9.filterSessionRows === "function" && typeof t9.sessionToolsBoundNote === "function" && typeof t9.sessionDotState === "function" && typeof t9.relativeTimeText === "function" && typeof t9.emptySessionToolsState === "function" && sessionToolsSlot !== undefined;
check("§4.3 红相守卫: the「会话工具」entry is registered into the official sidebar.footer.action slot", sessionToolsSlot !== undefined);
check("§4.3 红相守卫: the entry component factory exists (makeSessionToolsEntry)", typeof t9.makeSessionToolsEntry === "function");
check("§4.3 红相守卫: the dialog component factory exists (makeSessionToolsDialog)", typeof t9.makeSessionToolsDialog === "function");
check("§4.3 红相守卫: the selection/ordering rule exists (visibleSessionRows)", typeof t9.visibleSessionRows === "function");
check("§4.3 红相守卫: the search rule exists (filterSessionRows)", typeof t9.filterSessionRows === "function");
check("§4.3 红相守卫: the three-sentence emptiness rule exists (emptySessionToolsState)", typeof t9.emptySessionToolsState === "function");
check("§4.3 红相守卫: the bounded-presentation rule exists (sessionToolsBoundNote)", typeof t9.sessionToolsBoundNote === "function");
check("§4.3 红相守卫: the two-state status dot rule exists (sessionDotState)", typeof t9.sessionDotState === "function");
check("§4.3 红相守卫: the relative-time wording helper exists (relativeTimeText)", typeof t9.relativeTimeText === "function");
if (sessionToolsSurfacePresent) {
	// --- U12: registration, and the refusal to register a fake button -----------
	check("U12: the「会话工具」entry is registered into the official sidebar.footer.action slot", sessionToolsSlot !== undefined);
	check("U12: ... exactly once", registrations.filter((entry) => entry.options.name === "sidebar.footer.action").length === 1);
	check("U12: ... with the design's id and order (0 = AFTER the usage card's -10, in the same flex row to its right — not below it)", sessionToolsSlot.options.id === "team-link-session-tools" && sessionToolsSlot.options.order === 0 && sessionToolsSlot.options.order > -10);
	check("U12: ... in this plugin's locale namespace (that is where its t comes from)", sessionToolsSlot.options.locale === "dsh-team-link");
	check("U12: ... and the slot/id/order/limit are the literals the design names (the testing surface IS the registration's own literal)", t9.SESSION_TOOLS_SLOT === "sidebar.footer.action" && t9.SESSION_TOOLS_ID === "team-link-session-tools" && t9.SESSION_TOOLS_ORDER === 0 && t9.SESSION_TOOLS_LIMIT === 50);
	check("U12: the gap rule names every service §4.3.5 requires — nothing present means all three are reported, everything present means none", JSON.stringify(pure("sessionToolsGaps")(undefined, primitivesStub)) === JSON.stringify(["sessions", "workspaces", "uiWorkspace"]) && JSON.stringify(pure("sessionToolsGaps")(scene(popularList, NO_WORKSPACES), primitivesStub)) === "[]");

	const missingServices = applyWith({
		get(name) { return name === "sessions" ? sessionsServiceStub : undefined; },
		inject() { return undefined; },
	});
	check("U12: with any of the three services missing the entry is NOT registered at all (a fake button is worse than no button)", missingServices.thrown === null && missingServices.fresh.every((entry) => entry.options.name !== "sidebar.footer.action"));
	check("U12: ... and exactly ONE console line names what is missing (§4.3.6)", missingServices.warnings.length === 1 && missingServices.warnings[0].includes("sidebar.footer.action") && missingServices.warnings[0].includes("missing workspaces, uiWorkspace") && missingServices.warnings[0].includes("NOT registered"));
	check("U12: ... while every other face of this plugin still registers (N1: one face lost, never the plugin)", names(missingServices) === "conversation.chat.node:context,conversation.chat.node:team-link-send,conversation.session.header.actions,tool.call.toolview");

	const lateServices = applyWith({
		get() { return undefined; },
		inject(_specs, callback) { return callback(scopedContext()); },
	});
	check("U12: a shell whose services are not active yet lands the entry when they complete — and still owes only ONE line for the one window", lateServices.warnings.length === 1 && lateServices.fresh.some((entry) => entry.options.name === "sidebar.footer.action"));

	primitivesAvailable = false;
	const noPrimitives = applyWith();
	primitivesAvailable = true;
	check("U12: a shell whose seed module carries no Modal does not register the entry either — no dialog, no entry", noPrimitives.fresh.every((entry) => entry.options.name !== "sidebar.footer.action") && noPrimitives.warnings.length === 1 && noPrimitives.warnings[0].includes("ui-primitives(Modal)"));
	check("U12: ... and loses nothing else", names(noPrimitives) === "conversation.chat.node:context,conversation.chat.node:team-link-send,conversation.session.header.actions,tool.call.toolview");
	check("U12: this half's module graph is exactly react plus the seed module — no injected package is required from the bundle", [...new Set(required)].sort().join(",") === ["@deepseek-ai/dsh-client-ui-primitives", "react"].join(","));

	// --- §4.3.1: the entry's two faces (wide row vs 56px rail) ------------------
	const emptyScope = scene(listOf([], {}, "ready"), NO_WORKSPACES);
	const entryFactory = makeSessionToolsEntry(emptyScope, primitivesStub);
	const wideEntry = mount(entryFactory, { wide: true, t: tZh });
	const wideButton = wideEntry.tree.children[0];
	check("§4.3.1: the entry is a real button carrying the label as aria-label and title", wideButton.type === "button" && wideButton.props.type === "button" && wideButton.props.className === "dshsl-st-entry" && wideButton.props["aria-label"] === tZh("sessionTools") && wideButton.props.title === tZh("sessionTools"));
	check("§4.3.1: ... announcing the dialog it opens (aria-haspopup / aria-expanded)", wideButton.props["aria-haspopup"] === "dialog" && wideButton.props["aria-expanded"] === "false");
	check("§4.3.1: the wide column renders the glyph AND the text label (【设置】's wide face)", wideButton.props["data-wide"] === "true" && wideButton.children.filter((child) => child !== null).length === 2 && wideButton.children[1].props.className === "dshsl-st-label" && treeText(wideButton.children[1]) === tZh("sessionTools"));
	const railEntry = mount(entryFactory, { wide: false, t: tZh });
	const railButton = railEntry.tree.children[0];
	check("§4.3.1: the collapsed 56px rail renders the glyph ALONE — the label moves into aria-label/title", railButton.props["data-wide"] === "false" && railButton.children.filter((child) => child !== null).length === 1 && railButton.props["aria-label"] === tZh("sessionTools") && railButton.props.title === tZh("sessionTools"));

	// --- §4.3.2: the dialog, opened from the entry ------------------------------
	const opened = openDialog(wideEntry);
	check("§4.3.1: clicking the entry opens the dialog and flips aria-expanded", opened !== null && wideEntry.tree.children[0].props["aria-expanded"] === "true");
	const openedTree = flatten(opened.instance.tree);
	const modal = treeByType(openedTree, "modal");
	check("§4.3.2: the dialog is the official body-portaled Modal (an anchored panel would be clipped by the 56px rail)", modal !== null && modal.props.title === tZh("sessionTools") && modal.props.closeLabel === tZh("sessionToolsClose") && typeof modal.props.onClose === "function");
	check("§4.3.2: ... carrying the description sentence, which states the non-goal (read/copy/export only)", modal.props.description === tZh("sessionToolsDescription") && modal.props.description.includes("不改名"));
	check("§4.3.2: the body follows the design's order — header count, search, list/empty, bounded note, live line — with the footer last", JSON.stringify(allClasses(modal)) === JSON.stringify(["dshsl-st-count", "dshsl-st-search", "dshsl-st-empty", "dshsl-st-live", "dshsl-st-foot", "dshsl-st-range", "dshsl-st-close"]));
	check("§4.3.2: the header carries the current count", treeText(treeByClass(openedTree, "dshsl-st-count")) === fill(tZh("sessionToolsCount"), "count", 0));
	check("§4.3.2: the search box is a labelled search input", treeByClass(openedTree, "dshsl-st-search").props.type === "search" && treeByClass(openedTree, "dshsl-st-search").props["aria-label"] === tZh("sessionToolsSearch"));

	// --- U13 (§4.3.6, N7): the three emptinesses are three different sentences ---
	const loadingTree = flatten(dialogOver(listOf(["session-cur"], { "session-cur": curOf("session-cur") }, "pending"), NO_WORKSPACES).tree);
	const loadingText = treeText(treeByClass(loadingTree, "dshsl-st-empty"));
	check("U13: an unread list says「读取中…」and never presents itself as an empty list", loadingText === tZh("sessionToolsLoading") && treeByClass(loadingTree, "dshsl-st-list") === null);

	const noMatchDialog = dialogOver(popularList, NO_WORKSPACES);
	treeByClass(flatten(noMatchDialog.tree), "dshsl-st-search").props.onChange({ target: { value: "zzz" } });
	const noMatchTree = flatten(noMatchDialog.tree);
	const noMatchText = treeText(treeByClass(noMatchTree, "dshsl-st-empty"));
	check("U13: a search that matches nothing says so WITH the query — and is not shown as an empty list", noMatchText === fill(tZh("sessionToolsNoMatch"), "query", "zzz") && noMatchText.includes("zzz") && treeByClass(noMatchTree, "dshsl-st-list") === null);

	// The third sentence fires when the visible set is EMPTY. It is genuinely empty
	// when every row is dropped by §4.3.2's rule — here: the whole account archived.
	const noneText = treeText(treeByClass(flatten(dialogOver(listOf(["session-cur", "session-b"], { "session-cur": curOf("session-cur"), "session-b": rowOf("session-b") }), { items: [], archivedSessionIds: ["session-cur", "session-b"] }).tree), "dshsl-st-empty"));
	// G 语义变更（批次 4 / owner 裁定 ③ / §4.3.2）: the list is about the OTHER sessions,
	// so the current one is dropped. The old assertion here pinned the opposite reading
	// (「当前会话和其他会话一样」⇒ 单独在场时画出那一行）—— it is rewritten, not deleted,
	// and its replacement states both halves: the only-current list is EMPTY, while a
	// list with other sessions is not.
	const onlyCurrentTree = flatten(dialogOver(listOf(["session-cur"], { "session-cur": curOf("session-cur") }), NO_WORKSPACES).tree);
	check("G: 只剩当前会话 ⇒ 显示「暂无其他会话」并一行都不画（丢弃当前会话，而不是把它列出来）", (() => {
		const emptyNode = treeByClass(onlyCurrentTree, "dshsl-st-empty");
		const rows = treeAllByClass(onlyCurrentTree, "dshsl-st-row");
		const ok = treeText(emptyNode) === tZh("sessionToolsNone") && rows.length === 0 && treeText(treeByClass(onlyCurrentTree, "dshsl-st-count")) === fill(tZh("sessionToolsCount"), "count", 0);
		return ok || (console.log(`     实测读数 ${JSON.stringify({ empty: treeText(emptyNode), rows: rows.map((row) => row.props["data-session"]) })}`), false);
	})());
	const otherSessionsTree = flatten(dialogOver(popularList, NO_WORKSPACES).tree);
	check("G 对照: 有**其他**会话时列表照常非空、不显示空态句——丢弃的只是当前会话本身", treeByClass(otherSessionsTree, "dshsl-st-empty") === null && treeAllByClass(otherSessionsTree, "dshsl-st-row").length === 2 && treeAllByClass(otherSessionsTree, "dshsl-st-row").every((row) => row.props["data-session"] !== "session-cur"));
	check("U13: a range with no OTHER session says「暂无其他会话」(the third sentence)", noneText === tZh("sessionToolsNone"));
	check("U13: the three sentences are three DIFFERENT sentences and none of them leaks a dictionary key (N7)", new Set([loadingText, noMatchText, noneText]).size === 3 && [loadingText, noMatchText, noneText].every((text) => typeof text === "string" && text.length > 0 && text.indexOf("sessionTools") !== 0));
	check("U13: ... and they are the sentences the design names", loadingText.includes("读取中") && noMatchText.includes("没有匹配") && noneText.includes("暂无其他会话"));

	// --- U13/§4.3.6 (N6): a bounded presentation must SAY it is bounded ----------
	const manyIds = Array.from({ length: 60 }, (_, i) => "session-" + String(i).padStart(3, "0"));
	const manyById = {};
	manyIds.forEach((id, i) => { manyById[id] = rowOf(id, { updatedAt: 1000 + i }); });
	const manyTree = flatten(dialogOver(listOf(manyIds, manyById), NO_WORKSPACES).tree);
	check("U13: over the display cap the list says「共 N 个，仅显示前 M 个（搜索可收窄）」with the TRUE total", treeText(treeByClass(manyTree, "dshsl-st-bound")) === fill(fill(tZh("sessionToolsBound"), "total", 60), "shown", 50));
	check("U13: ... draws exactly the cap's rows, and the header count is the number actually drawn", treeAllByClass(manyTree, "dshsl-st-row").length === 50 && treeText(treeByClass(manyTree, "dshsl-st-count")) === fill(tZh("sessionToolsCount"), "count", 50));
	const atCapIds = manyIds.slice(0, 50);
	const atCapTree = flatten(dialogOver(listOf(atCapIds, Object.fromEntries(atCapIds.map((id) => [id, manyById[id]]))), NO_WORKSPACES).tree);
	check("U13 对照: at exactly the cap there is NO annotation — the note reports a cut, not a size", treeByClass(atCapTree, "dshsl-st-bound") === null && treeAllByClass(atCapTree, "dshsl-st-row").length === 50);
	check("U13 对照: an ordinary short list carries no annotation either, and the rule agrees", treeByClass(noMatchTree, "dshsl-st-bound") === null && sessionToolsBoundNote({ total: 3, shown: 3 }) === null && sessionToolsBoundNote({ total: 60, shown: 50 }) !== null);

	// --- §4.3.2: the range, its default, and what it filters --------------------
	// 批次 4 (G): the current session is dropped from EVERY range, so the workspace-range
	// fixture needs a second IN-workspace session — otherwise the range assertion below
	// would pass for the wrong reason (an empty list narrows trivially).
	const ws = { items: [{ workspaceId: "ws-1", path: "/ws/team", title: "工作区甲", sessionIds: ["session-cur", "session-a"] }], archivedSessionIds: [] };
	const wsList = listOf(["session-cur", "session-a", "session-b"], { "session-cur": curOf("session-cur", { cwd: "/ws/team" }), "session-a": rowOf("session-a", { cwd: "/ws/team" }), "session-b": rowOf("session-b") });
	const wsDialog = dialogOver(wsList, ws);
	const wsTree = flatten(wsDialog.tree);
	const rangeGroup = treeByClass(wsTree, "dshsl-st-range");
	check("§4.3.2: the range defaults to「当前工作区」, and the footer offers「全部工作区」beside it", rangeGroup.children[0].props["aria-pressed"] === "true" && rangeGroup.children[1].props["aria-pressed"] === "false" && treeText(rangeGroup.children[0]) === tZh("sessionToolsRangeCurrent") && treeText(rangeGroup.children[1]) === tZh("sessionToolsRangeAll"));
	check("§4.3.2: the current-workspace range really narrows — the in-workspace session shows, the outside one does not, and the current session is not listed either (批次 4)", treeAllByClass(wsTree, "dshsl-st-row").length === 1 && treeAllByClass(wsTree, "dshsl-st-row")[0].props["data-session"] === "session-a" && treeText(treeByClass(wsTree, "dshsl-st-count")) === fill(tZh("sessionToolsCount"), "count", 1));
	check("§4.3.2: the range control is a labelled group (a11y) and the switch is one click", rangeGroup.props.role === "group" && typeof rangeGroup.props["aria-label"] === "string");
	rangeGroup.children[1].props.onClick();
	const allTree = flatten(wsDialog.tree);
	check("§4.3.2: switching to「全部工作区」lists the outside session and appends its workspace name to the time line", treeAllByClass(allTree, "dshsl-st-row").length === 2 && treeText(treeByClass(allTree, "dshsl-st-time")).includes("工作区甲"));
	check("§4.3.2: ... and the pressed state follows the switch", treeByClass(allTree, "dshsl-st-range").children[1].props["aria-pressed"] === "true");

	// --- §4.3.2/§4.3.3: the selection rule and the row ---------------------------
	const ruleList = listOf(
		["session-cur", "session-a", "session-sub", "session-arch", "session-blank", "session-new"],
		{
			"session-cur": curOf("session-cur"),
			"session-a": rowOf("session-a", { updatedAt: 5000 }),
			"session-sub": rowOf("session-sub", { origin: "subagent" }),
			"session-arch": rowOf("session-arch"),
			"session-blank": rowOf("session-blank", { blank: true }),
			"session-new": { id: "session-new", displayTitle: "本地新会话", updatedAt: 1, running: false, retainedBy: {}, blank: false },
		},
	);
	const ruleRows = visibleSessionRows(ruleList, { items: [], archivedSessionIds: ["session-arch"] }, "session-cur", "all");
	check("§4.3.2: subagent rows, archived rows, blank rows and (批次 4) the CURRENT session are dropped; a row that exists only locally is kept", JSON.stringify(ruleRows.map((row) => row.id)) === JSON.stringify(["session-a", "session-new"]));
	check("§4.3.2: ... ordered by updatedAt descending", ruleRows.map((row) => row.updatedAt).join(",") === "5000,1");
	check("§4.3.2 (批次 4 对照): 只有把 `currentId` 传进来才丢——同一份 list 用 undefined 当 currentId 时 `session-cur` 仍在（丢的是**当前会话**这条事实，不是这个 id 本身）", JSON.stringify(visibleSessionRows(ruleList, { items: [], archivedSessionIds: ["session-arch"] }, undefined, "all").map((row) => row.id)) === JSON.stringify(["session-a", "session-cur", "session-new"]));
	check("§4.3.2: the search matches the title and the id, case-insensitively, and a blank query filters nothing", filterSessionRows(ruleRows, "NEW").length === 1 && filterSessionRows(ruleRows, "session-a").length >= 1 && filterSessionRows(ruleRows, "   ").length === ruleRows.length);
	check("§4.3.2: the current session is the one the main view retains (the official convention, retainedBy.mainView)", pure("currentSessionIdOf")(ruleList) === "session-cur" && pure("currentSessionIdOf")(listOf(["session-a"], { "session-a": rowOf("session-a") })) === undefined);

	const rowTree = flatten(dialogOver(popularList, NO_WORKSPACES).tree);
	const rowNodes = treeAllByClass(rowTree, "dshsl-st-row");
	check("§4.3.3: one row per visible session, each addressable by its session id (当前会话不在其中——批次 4)", rowNodes.length === 2 && rowNodes.map((row) => row.props["data-session"]).join(",") === "session-a,session-b");
	const firstRow = rowNodes[0];
	const openButton = treeByClass(firstRow, "dshsl-st-open");
	check("§4.3.3: the row's clickable face is one real button — Enter/Space open the session, no keydown shim to forget", openButton !== null && openButton.type === "button" && openButton.props.type === "button" && typeof openButton.props.onClick === "function");
	check("§4.3.3: ... and it carries the title (in the accessible name and on the element)", openButton.props["aria-label"] === fill(tZh("sessionToolsOpenLabel"), "title", "会话 session-a") && treeText(treeByClass(firstRow, "dshsl-st-title")) === "会话 session-a" && treeByClass(firstRow, "dshsl-st-title").props.title === "会话 session-a");
	check("§4.3.3: the relative time comes from the OFFICIAL bucketing helper, worded by this plugin's dictionary", treeText(treeByClass(firstRow, "dshsl-st-time")).length > 0 && relativeTimeText(primitivesStub, Date.now() - 5 * 60000, Date.now(), tZh) === "5分钟" && relativeTimeText(primitivesStub, Date.now(), Date.now(), tZh) === "刚刚" && relativeTimeText(undefined, 0, Date.now(), tZh) === tZh("sessionToolsTimeUnknown"));
	check("§4.3.3: the status dot is EXACTLY two states — running / idle — across the whole input matrix", (() => {
		const matrix = [{ running: true }, { running: false }, { running: true, blank: true }, { running: false, retainedBy: { mainView: 1, subagent: 2 } }, {}, { running: true, origin: "subagent" }].map((row) => sessionDotState(row));
		return new Set(matrix).size === 2 && matrix.every((state) => state === "running" || state === "idle");
	})());
	check("§4.3.3: ... and the dot's state is readable as text, not by colour alone", firstRow.props["data-state"] === "idle" && treeText(treeByClass(firstRow, "dshsl-st-sr")) === tZh("sessionToolsIdle"));
	const sessionRunningRow = treeAllByClass(flatten(dialogOver(listOf(["session-r"], { "session-r": rowOf("session-r", { running: true }) }), NO_WORKSPACES).tree), "dshsl-st-row")[0];
	check("§4.3.3: ... a running session reads「运行中」while an idle one reads「空闲」", sessionRunningRow.props["data-state"] === "running" && treeText(treeByClass(sessionRunningRow, "dshsl-st-sr")) === tZh("sessionToolsRunning") && treeText(treeByClass(sessionRunningRow, "dshsl-st-sr")) !== tZh("sessionToolsIdle"));
	const rowActions = treeAllByClass(firstRow, "dshsl-st-act");
	check("§4.3.3: the row carries exactly two actions — copy and export — each named with the session's own title", rowActions.length === 2 && rowActions[0].props["aria-label"] === fill(tZh("sessionToolsCopyLabel"), "title", "会话 session-a") && rowActions[1].props["aria-label"] === fill(tZh("sessionToolsExportLabel"), "title", "会话 session-a") && treeText(rowActions[0]) === tZh("sessionToolsCopy") && treeText(rowActions[1]) === tZh("sessionToolsExport"));
	const cssText = String(styleTags[0].textContent);
	check("§4.3.3: the two actions are hidden until the row is hovered or focused — the reveal is one stylesheet rule", cssText.includes(".dshsl-st-row:hover .dshsl-st-actions,.dshsl-st-row:focus-within .dshsl-st-actions{opacity:1}") && cssText.includes(".dshsl-st-actions{display:flex;align-items:center;gap:4px;flex:none;opacity:0"));

	// --- §4.3.4: the three actions ----------------------------------------------
	const liveDialog = dialogOver(popularList, NO_WORKSPACES);
	// 批次 4 (G): the current session is no longer row 0 — the visible rows are now
	// [session-a, session-b], so the row under test is index 0 (it used to be 1).
	treeAllByClass(treeAllByClass(flatten(liveDialog.tree), "dshsl-st-row")[0], "dshsl-st-act")[0].props.onClick();
	await new Promise((resolve) => setImmediate(resolve));
	const liveTree = flatten(liveDialog.tree);
	const copiedAction = treeAllByClass(treeAllByClass(liveTree, "dshsl-st-row")[0], "dshsl-st-act")[0];
	check("§4.3.4: copying writes the SAME deep link the conversation-header button emits", clipboardWrites.length === 1 && clipboardWrites[0] === "dsh://session/session-a");
	check("§4.3.4: ... the button flashes「已复制 ✓」and its accessible name switches with it", treeText(copiedAction) === tZh("sessionToolsCopied") && copiedAction.props["data-copied"] === "true" && copiedAction.props["aria-label"] === fill(tZh("sessionToolsCopiedLabel"), "title", "会话 session-a"));
	const liveRegion = treeByClass(liveTree, "dshsl-st-live");
	check("§4.3.4: ... and the result is announced in a live region that carries the link", liveRegion.props.role === "status" && liveRegion.props["aria-live"] === "polite" && treeText(liveRegion) === fill(tZh("sessionToolsCopiedNote"), "link", "dsh://session/session-a"));
	check("§4.3.4: ... and only that row's copy button changes (the other rows are untouched)", treeAllByClass(treeAllByClass(liveTree, "dshsl-st-row")[1], "dshsl-st-act")[0].props["data-copied"] === "false" && clipboardWrites.length === 1);

	const exportDialog = dialogOver(popularList, NO_WORKSPACES);
	const hrefBefore = windowStub.location.href;
	treeAllByClass(treeAllByClass(flatten(exportDialog.tree), "dshsl-st-row")[0], "dshsl-st-act")[1].props.onClick();
	check("§4.3.4: exporting NAVIGATES to the host route, with the parameter encoded and the format pinned", windowStub.location.href === "/team-link/export?session=" + encodeURIComponent("session-a") + "&format=md");
	windowStub.location.href = hrefBefore;

	const populatedEntry = mount(makeSessionToolsEntry(scene(popularList, NO_WORKSPACES), primitivesStub), { wide: true, t: tZh });
	const populatedDialog = openDialog(populatedEntry);
	navCalls.length = 0;
	treeByClass(treeAllByClass(flatten(populatedDialog.instance.tree), "dshsl-st-row")[0], "dshsl-st-open").props.onClick();
	check("§4.3.3: clicking the row opens THAT session through the public navigation face (uiWorkspace.openSession)", navCalls.length === 1 && navCalls[0] === "session-a");
	check("§4.3.3: ... and the dialog closes — the navigation itself is the answer, and closing hands focus back", populatedEntry.tree.children[1] === null);

	const hostileScope = {
		sessions: { list: { getSnapshot() { throw new Error("service died"); } } },
		workspaces: { list: { getSnapshot() { throw new Error("service died"); } } },
		uiWorkspace: { openSession() { throw new Error("navigation died"); } },
	};
	const hostileDialog = mount(makeSessionToolsDialog(hostileScope, primitivesStub), { t: tZh, onClose() {} });
	let hostileThrew = false;
	let hostileTree = null;
	const realWarnHostile = console.warn;
	console.warn = () => {};
	try {
		hostileTree = flatten(hostileDialog.tree);
		treeByClass(hostileTree, "dshsl-st-search").props.onChange({ target: { value: "x" } });
		hostileTree = flatten(hostileDialog.tree);
	} catch (error) {
		hostileThrew = true;
	} finally {
		console.warn = realWarnHostile;
	}
	check("§4.3.6 降级: a service that dies mid-flight degrades to a READING instead of taking the session down", hostileThrew === false && hostileTree !== null && treeByClass(hostileTree, "dshsl-st-empty").props["data-empty"] === "sessionToolsLoading" && treeAllByClass(hostileTree, "dshsl-st-row").length === 0);

	// --- §4.3.7: keyboard, focus return and reduced motion ----------------------
	const focusEntry = mount(entryFactory, { wide: true, t: tZh });
	const focusDialog = openDialog(focusEntry);
	check("§4.3.7: the official Modal owns Escape — its onClose IS the entry's close handler (one close path for Esc, the mask, the button and a successful open)", focusDialog !== null && focusDialog.element.props.onClose === focusEntry.tree.children[1].props.onClose);
	focusCalls.length = 0;
	focusDialog.instance.tree.props.onClose();
	check("§4.3.7: closing returns focus to the entry, and the dialog is gone", focusCalls.length === 1 && focusEntry.tree.children[1] === null && focusEntry.tree.children[0].props["aria-expanded"] === "false");
	check("§4.3.7: reduced motion is respected — the reveal's transition is dropped under the media query", cssText.includes("@media (prefers-reduced-motion: reduce){.dshsl-st-actions{transition:none}}"));

	// --- dictionary parity for the new copy -------------------------------------
	const zhDict = localeDicts.get("zh");
	const enDict = localeDicts.get("en");
	const sessionToolsKeys = Object.keys(zhDict).filter((key) => key.indexOf("sessionTools") === 0 && key.indexOf("sessionToolsTime") !== 0);
	check("§4.3: every §4.3 sentence is declared in BOTH dictionaries (a missing translation would render the key name)", sessionToolsKeys.length >= 20 && sessionToolsKeys.every((key) => typeof enDict[key] === "string") && sessionToolsKeys.every((key) => zhDict[key] !== key && enDict[key] !== key));
	check("§4.3: the time buckets are declared per unit, like the official surface's own words", ["sessionToolsTimeNow", "sessionToolsTimeMinutes", "sessionToolsTimeHours", "sessionToolsTimeDays", "sessionToolsTimeMonths", "sessionToolsTimeYears", "sessionToolsTimeUnknown"].every((key) => typeof zhDict[key] === "string" && typeof enDict[key] === "string"));

}

// ---------------------------------------------------------------------------
// U14 (§4.4, work face ④): a deep link really switches the main view. The defect
// was a SILENT no-op — ctx.sessions.open(id), a method the sessions SERVICE does
// not have. The judgement is the CURRENT SESSION ID, read the way the app itself
// reads it (retainedBy.mainView), never "some function was called".
// ---------------------------------------------------------------------------

const deepRowOf = (id) => ({ id, displayTitle: "目标会话 " + id, updatedAt: 2, running: false, retainedBy: { mainView: 0 }, blank: false });
/** The deep-link judgement reader: the row the main view retains (ui-workspace's
 * own mainSessionId). */
const currentSessionId = (list) => Object.values(list.byId).find((row) => (row.retainedBy || {}).mainView > 0)?.id;
/** A boot context for /s/<id>: the fixture's navigation stub MODELS the real
 * service — opening a session moves mainView onto it — so "the id moved" is a
 * fact about the plugin's call, not about the stub's bookkeeping. */
function deepLinkEnv(targetId, options = {}) {
	const byId = { "session-here": { id: "session-here", displayTitle: "当前会话", updatedAt: 1, running: false, retainedBy: { mainView: 1 }, blank: false } };
	if (options.present !== false) byId[targetId] = deepRowOf(targetId);
	const list = { ids: Object.keys(byId), byId, phase: "ready" };
	const nav = [];
	const slotNames = [];
	const sessionsService = { list: { getSnapshot: () => list } };
	const workspacesService = { list: { getSnapshot: () => ({ items: [], archivedSessionIds: [] }) } };
	const uiWorkspace = options.withoutNavigation === true ? undefined : {
		openSession(id) {
			if (options.navigationThrows === true) throw new Error("navigation died");
			nav.push(id);
			for (const key of Object.keys(byId)) byId[key].retainedBy = { mainView: key === id ? 1 : 0 };
		},
	};
	const scope = { uiConversation: uiConversationStub, sessions: sessionsService, workspaces: workspacesService, uiWorkspace };
	scope.get = (name) => scope[name];
	const context = {
		effect(fn) { const disposer = fn(); return typeof disposer === "function" ? disposer : () => {}; },
		locale: { register() { return () => {}; }, bind() { return (key) => key; } },
		slots: { inject(_name, register) { return register(); }, register(options) { slotNames.push(options.name); return () => {}; }, entries() { return []; } },
		sessions: sessionsService,
		get(name) { return name === "sessions" ? sessionsService : name === "workspaces" ? workspacesService : name === "uiWorkspace" ? uiWorkspace : undefined; },
		inject(_specs, callback) { return callback(scope); },
	};
	return { context, list, byId, nav, slotNames };
}
function applyCapturingWarnings(context) {
	const lines = [];
	const realWarn = console.warn;
	console.warn = (...args) => lines.push(args.map((value) => String(value)).join(" "));
	let thrown = null;
	try {
		moduleExports.apply(context);
	} catch (error) {
		thrown = error;
	} finally {
		console.warn = realWarn;
	}
	return { lines, thrown };
}

const pathnameBefore = windowStub.location.pathname;
windowStub.location.pathname = "/s/session-target";

const deepA = deepLinkEnv("session-target");
moduleExports.apply(deepA.context);
check("U14: the deep link focuses the linked session at boot through the public navigation face", deepA.nav.join(",") === "session-target");
check("U14 判据: ... and the CURRENT SESSION ID really changed to the target (retainedBy.mainView is the judgement)", currentSessionId(deepA.list) === "session-target");
check("U14 对照: ... while the session the app booted on no longer holds the main view (so the assertion is about movement)", deepA.byId["session-here"].retainedBy.mainView === 0);
check("U14: the deep link is applied once, not once per retry", deepA.nav.length === 1);

const pendingTimers = [];
const realSetTimeout = windowStub.setTimeout;
windowStub.setTimeout = (fn, ms) => { pendingTimers.push({ fn, ms }); return 0; };
windowStub.location.pathname = "/s/session-late";
const deepB = deepLinkEnv("session-late", { present: false });
moduleExports.apply(deepB.context);
check("U14: a deep link to a session the list has not reported yet focuses nothing YET — it waits (the existing retry loop is kept)", deepB.nav.length === 0 && pendingTimers.length === 1 && pendingTimers[0].ms === 200);
check("U14 对照: ... and the current session is still the one the app booted with", currentSessionId(deepB.list) === "session-here");
deepB.byId["session-late"] = deepRowOf("session-late");
deepB.list.ids.push("session-late");
pendingTimers[0].fn();
check("U14: ... and the frame is focused the moment it appears in the list", deepB.nav.join(",") === "session-late" && currentSessionId(deepB.list) === "session-late");
windowStub.setTimeout = realSetTimeout;

windowStub.location.pathname = "/s/session-target";
const deepC = deepLinkEnv("session-target", { withoutNavigation: true });
const appliedC = applyCapturingWarnings(deepC.context);
check("U14 降级: a shell without uiWorkspace loses the FOCUS step only — the deep link opens and nothing throws", appliedC.thrown === null && deepC.nav.length === 0);
check("U14 降级: ... and §4.3's own rule holds in that same shell (no uiWorkspace ⇒ no「会话工具」entry, everything else applied)", deepC.slotNames.indexOf("sidebar.footer.action") === -1 && deepC.slotNames.length === 4);

windowStub.location.pathname = "/s/session-target";
const deepD = deepLinkEnv("session-target", { navigationThrows: true });
const appliedD = applyCapturingWarnings(deepD.context);
check("U14: a navigation that fails leaves exactly ONE trace line and does not break the open flow", appliedD.thrown === null && appliedD.lines.filter((line) => line.includes("uiWorkspace.openSession")).length === 1 && deepD.nav.length === 0);
check("U14: ... and the current session is untouched by a failed focus", currentSessionId(deepD.list) === "session-here");

const codeLinesOf = (text) => text.split("\n").map((line) => line.trim()).filter((line) => line !== "" && line.indexOf("//") !== 0 && line.indexOf("*") !== 0);
check("U14 病灶锁: the silent CALL is gone from the bundle's code (the sessions face has no open() to call)", !codeLinesOf(SOURCE).some((line) => line.indexOf("ctx.sessions.open(") !== -1));
check("U14: ... and the focus goes through the published navigation action, taken at runtime with ctx.inject", SOURCE.includes('ctx.inject(["uiWorkspace"], focus)') && SOURCE.includes("navigation.openSession(id)"));

windowStub.location.pathname = pathnameBefore;

console.log("");
if (failures === 0) console.log("ALL PASS");
else console.log(`${failures} FAILURE(S)`);
console.log(`assertion total: ${assertions} (failed: ${failures})`);
process.exitCode = failures === 0 ? 0 : 1;
// dsh-team-link — browser half (client bundle).
//
// Rendered in the web shell as a static client package (`dsh.client`
// declaration in package.json; served by dsh-client-modules at
// /plugins/dsh-team-link/client.js). Upstream affordances kept in
// full:
//  1. a "copy session link" button in the conversation header action strip,
//     copying `dsh://session/<sessionId>` — the same link the host half
//     understands when pasted into any conversation; and
//  2. the deep-link opener: when the page boots at `/s/<sessionId>`, select
//     that session once the session list has loaded.
// New in -pro:
//  3. an "export session" button in the same action strip, downloading the
//     readable markdown rendering of the current conversation through the
//     host half's /team-link/export web route; and
//  4. the relay card: cross-session messages this session RECEIVED, rendered as
//     a bordered card instead of a folded grey context line (keyed
//     `conversation.chat.node` on `key: "context"`, priority -100).
// New in the §10.1 A/D round (collab-enhancements design) — the SENDER's side:
//  5. A: `tool.call.toolview` keyed `team_link_send`, so this session's own tool
//     row renders the §10.1.2 receipt as the same card. Three situations, in
//     this order (§10.1.5, the DEFECT-5 text rebuild):
//       (a) the settled block carries a readable receipt → the card is drawn
//           from `meta`, ALWAYS (the rebuild below never runs);
//       (b) no receipt (or one this build cannot read) but the model-visible
//           text still matches a shape THIS plugin's host half mints → a
//           MINIMAL card rebuilt from that text (target identities, outcome
//           phrases, the counts) — this is the path a `team_link_send` issued
//           from inside `run_code` lands on, because the host projects
//           `presentationMeta` for top-level dispatches only
//           (`dsh-tools/lib/types/index.js:1191`), so a program-issued call
//           never has one;
//       (c) neither → the plain row showing the model-visible text verbatim.
//     The audit record stays where it was, at the tool call itself.
//     A also reads the host half's `targetsTruncated: {shown,total}` mark: the
//     host caps `targets` at 24 rows as it writes the receipt, so counting the
//     rows here could never see a host-produced card as truncated — the mark is
//     what makes the cut visible on A, and `total` is the number the label owes.
//  6. D: a top-level node for the same call, produced by this plugin's own
//     `uiConversation.events` definition matching the EXISTING `tool/call` +
//     `tool/result` events, rendered by a same-kind `conversation.chat.node`
//     entry. No session-log event is written, and the model context is untouched:
//     visibility is added on the client only.
window.__ModuleLoader__.load({
	id: "dsh-team-link",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");

		// --- styles (module scope, mirroring compiled client bundles) ---
		const CSS_ID = "dsh-team-link/client.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_ID) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-team-link";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = [
				".dshsl-copy{display:grid;place-items:center;width:28px;height:28px;flex:none;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:14px;line-height:1;padding:0}",
				".dshsl-copy:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
				".dshsl-copy:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}",
				".dshsl-copy[data-copied=\"true\"]{color:var(--dsw-alias-state-success-primary)}"
,
				".dshsl-relay{margin:8px 0;border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-state-business-primary);border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);padding:10px 12px}",
				".dshsl-relay-head{display:flex;align-items:center;gap:8px;min-width:0;font-size:12px;color:var(--dsw-alias-state-business-primary);font-weight:600}",
				".dshsl-relay-when{margin-left:auto;flex:none;color:var(--dsw-alias-label-tertiary);font-weight:400;font-size:11px}",
				".dshsl-relay-sender{color:var(--dsw-alias-label-secondary);font-weight:400;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;min-width:0;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".dshsl-relay-body{margin-top:8px;font-size:13px;line-height:1.65;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word}",
				".dshsl-relay-foot{margin-top:6px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
				// §10.1 sender-side cards: the same card, accent flipped to the
				// outbound side, plus the pieces only a receipt has.
				".dshsl-send{border-left-color:var(--dsw-alias-state-success-primary)}",
				// §10.2.8.3 通道 1: the /team_session result row — the same card chrome, plus a
				// dim monospace echo of the raw input a human typed.
				".dshsl-ts-args{color:var(--dsw-alias-label-tertiary);font-weight:400;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;min-width:0;max-width:46%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".dshsl-send-env{margin-left:6px;color:var(--dsw-alias-label-tertiary);font-weight:400;font-size:11px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
				".dshsl-send-trunc{color:var(--dsw-alias-label-tertiary);font-size:11px}",
				".dshsl-send-targets{margin-top:8px;display:flex;flex-direction:column;gap:3px}",
				".dshsl-send-rowhead{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
				".dshsl-send-target{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}",
				".dshsl-send-targetid{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:600;color:var(--dsw-alias-label-primary)}",
				".dshsl-send-outcome{flex:none;font-weight:600;color:var(--dsw-alias-label-primary)}",
				".dshsl-send-outcome[data-outcome=\"refused\"],.dshsl-send-outcome[data-outcome=\"no-agent\"],.dshsl-send-outcome[data-outcome=\"no-holder\"]{color:var(--dsw-alias-state-warn-primary)}",
				".dshsl-send-summary{margin-top:8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
				".dshsl-send-rows-trunc{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
				".dshsl-plain{margin:4px 0;padding:6px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-secondary)}",
				".dshsl-plain-head{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:11px}",
				".dshsl-plain-body{margin-top:6px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}",
				".dshsl-st-entry{display:flex;align-items:center;gap:8px;width:100%;border:none;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;line-height:1;padding:8px;text-align:left}",
				".dshsl-st-entry:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
				".dshsl-st-entry:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}",
				".dshsl-st-entry[data-wide=\"false\"]{justify-content:center;padding:8px 0}",
				// §4.3.1's entry, plus the two classes a review found dangling (a class
				// with no rule is appearance by luck, not by contract): `.dshsl-st` is
				// what this plugin hands the official Modal's content region
				// (`contentClassName`, primitives `lib/index.js:2616`), `.dshsl-st-label`
				// is its wide-state text. The first is the flex-shrink guard the official
				// `.body` already carries (`Modal.module.css:92`) one level up, so
				// over-long content ellipsises inside the fixed 380px card instead of
				// widening it; the second is `.dshsl-st-title`'s elision treatment for
				// the label sitting next to the glyph.
				".dshsl-st{min-width:0}",
				".dshsl-st-glyph{font-size:14px;line-height:1}",
				".dshsl-st-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".dshsl-st-count{margin:0 0 8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
				".dshsl-st-search{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;padding:6px 8px}",
				".dshsl-st-list{list-style:none;margin:8px 0 0;padding:0;max-height:46vh;overflow:auto}",
				".dshsl-st-row{display:flex;align-items:center;gap:8px;border-radius:6px}",
				".dshsl-st-row:hover{background:var(--dsw-alias-interactive-bg-hover)}",
				".dshsl-st-open{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;border:none;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font:inherit;text-align:left;padding:6px 8px}",
				".dshsl-st-open:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}",
				".dshsl-st-dot{flex:none;width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-label-tertiary)}",
				".dshsl-st-dot[data-state=\"running\"]{background:var(--dsw-alias-state-success-primary)}",
				".dshsl-st-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;color:var(--dsw-alias-label-primary)}",
				".dshsl-st-time{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
				".dshsl-st-actions{display:flex;align-items:center;gap:4px;flex:none;opacity:0;transition:opacity .12s ease}",
				".dshsl-st-row:hover .dshsl-st-actions,.dshsl-st-row:focus-within .dshsl-st-actions{opacity:1}",
				".dshsl-st-act{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;padding:3px 6px}",
				".dshsl-st-act:hover{border-color:var(--dsw-alias-label-tertiary);color:var(--dsw-alias-label-primary)}",
				".dshsl-st-act:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:1px}",
				".dshsl-st-act[data-copied=\"true\"]{color:var(--dsw-alias-state-success-primary)}",
				".dshsl-st-empty{margin:12px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
				".dshsl-st-bound{margin:8px 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary)}",
				".dshsl-st-live{margin:4px 0 0;min-height:14px;font-size:11px;color:var(--dsw-alias-state-success-primary)}",
				".dshsl-st-foot{display:flex;align-items:center;gap:8px}",
				".dshsl-st-range{display:flex;gap:4px}",
				".dshsl-st-range button{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;padding:4px 8px}",
				".dshsl-st-range button[aria-pressed=\"true\"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
				".dshsl-st-close{margin-left:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;padding:4px 10px}",
				".dshsl-st-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}",
				"@media (prefers-reduced-motion: reduce){.dshsl-st-actions{transition:none}}"
			].join("");
			document.head.appendChild(tag);
		}

		// --- link + route builders ---
		/** `dsh://` deep link for one session id — the format the copy button emits and
		 * the host half resolves when it is pasted back into any conversation. */
		function dshDeepLink(sessionId) {
			return "dsh://session/" + encodeURIComponent(sessionId);
		}
		/** Host-half export route for one session id (markdown download). */
		function exportUrl(sessionId) {
			return "/team-link/export?session=" + encodeURIComponent(sessionId) + "&format=md";
		}

		// --- copy fallback for non-secure contexts ---
		function fallbackCopy(text) {
			try {
				const ta = document.createElement("textarea");
				ta.value = text;
				ta.setAttribute("readonly", "");
				ta.style.position = "fixed";
				ta.style.opacity = "0";
				document.body.appendChild(ta);
				ta.select();
				document.execCommand("copy");
				document.body.removeChild(ta);
				return true;
			} catch {
				return false;
			}
		}

		// --- the copy button (upstream, unchanged behavior) ---
		function CopySessionLinkButton({ sessionId, t }) {
			const [copied, setCopied] = React.useState(false);
			const copy = React.useCallback(() => {
				const link = dshDeepLink(sessionId);
				const flash = () => {
					setCopied(true);
					window.setTimeout(() => setCopied(false), 1600);
				};
				if (navigator.clipboard !== void 0 && window.isSecureContext === true) {
					navigator.clipboard.writeText(link).then(flash, () => {
						if (fallbackCopy(link)) flash();
					});
				} else if (fallbackCopy(link)) flash();
			}, [sessionId]);
			const label = copied ? t("copied") : t("copyLink");
			return React.createElement("button", {
				type: "button",
				className: "dshsl-copy",
				"data-copied": copied ? "true" : "false",
				title: label,
				"aria-label": label,
				onClick: copy
			}, copied ? "\u2713" : "\uD83D\uDD17");
		}

		// --- the export button (new in -pro): markdown download via host route ---
		function ExportSessionButton({ sessionId, t }) {
			const label = t("exportSession");
			const download = React.useCallback(() => {
				try {
					const anchor = document.createElement("a");
					anchor.href = exportUrl(sessionId);
					anchor.rel = "noopener";
					document.body.appendChild(anchor);
					anchor.click();
					anchor.remove();
				} catch {
					window.open(exportUrl(sessionId), "_blank", "noopener");
				}
			}, [sessionId]);
			return React.createElement("button", {
				type: "button",
				className: "dshsl-copy",
				title: label,
				"aria-label": label,
				onClick: download
			}, "\u2B07");
		}

		// --- header action strip: copy + export side by side ---
		function HeaderActions({ sessionId, t }) {
			return React.createElement(React.Fragment, null,
				React.createElement(CopySessionLinkButton, { sessionId: sessionId, t: t }),
				React.createElement(ExportSessionButton, { sessionId: sessionId, t: t }));
		}

		/**
		 * §4.4: focus the deep-linked session through the PUBLIC navigation face.
		 *
		 * The call this replaced — `ctx.sessions.open(id)` — was a silent no-op:
		 * `ISessions` (dsh-api-session-controller, contract/sessions.d.ts) has no
		 * `open` at all. The `open()` in that package belongs to a Session object
		 * and means "load its history", which is another thing entirely; on the
		 * SERVICE the property was `undefined`, the call threw a TypeError, and the
		 * `try/catch` around it swallowed it. The list was polled, the frame
		 * arrived, and the app simply stayed where it was.
		 *
		 * `uiWorkspace.openSession(target)` is the published navigation action
		 * (dsh-client-ui-workspace, navigation.d.ts) and is what the official shell
		 * itself calls. It is taken through `ctx.inject` at RUNTIME, like every
		 * other optional service in this half: a shell without it loses the FOCUS
		 * step alone — the deep link still opens, exactly as before.
		 *
		 * @param ctx - the client root context.
		 * @param id - the deep-linked session id (already known to be in the list).
		 */
		function focusDeepLinkedSession(ctx, id) {
			const consequence = "the deep-linked session was not focused (the app stays on its default view)";
			const focus = function (holder) {
				var navigation = holder === null || holder === undefined ? undefined : holder.uiWorkspace;
				if (navigation === null || navigation === undefined || typeof navigation.openSession !== "function") return;
				try {
					navigation.openSession(id);
				} catch (error) {
					reportDegrade("uiWorkspace.openSession", consequence, error);
				}
			};
			try {
				if (typeof ctx.inject === "function") {
					ctx.inject(["uiWorkspace"], focus);
					return;
				}
			} catch (error) {
				reportDegrade("uiWorkspace injection", consequence, error);
				return;
			}
			// No `ctx.inject` at all (an older context): read the service directly and
			// accept that its absence costs the focus step and nothing else.
			focus(ctx);
		}

		// --- deep-link opener: /s/<sessionId> selects that session at boot ---
		function openDeepLinkedSession(ctx) {
			const match = window.location.pathname.match(/^\/s\/([^/]+)$/);
			if (match === null) return;
			let id;
			try {
				id = decodeURIComponent(match[1]);
			} catch {
				return;
			}
			if (typeof id !== "string" || id.length === 0) return;
			let tries = 0;
			const attempt = () => {
				if (tries >= 50) return;
				tries += 1;
				let snapshot = null;
				try {
					snapshot = ctx.sessions.list.getSnapshot();
				} catch {
					/* sessions service not ready yet — retry */
				}
				if (snapshot !== null && snapshot.byId !== void 0 && Object.prototype.hasOwnProperty.call(snapshot.byId, id)) {
					focusDeepLinkedSession(ctx, id);
					return;
				}
				window.setTimeout(attempt, 200);
			};
			attempt();
		}

		// --- relay card (new in -pro): prominent rendering for cross-session messages ---
		// Registered on the keyed "conversation.chat.node" slot at priority -100 so it
		// shadows the chat package's default context renderer (lowest priority renders).
		// Non-relay context messages are delegated back to the shadowed chat renderer.

		var CHAT_NODE_SLOT = "conversation.chat.node";
		var RELAY_PRIORITY = -100;

		/**
		 * Lone-surrogate repair for anything this half puts on screen. `String.prototype.toWellFormed`
		 * is native on current browsers; the regex is the fallback. A DOM text node
		 * would repair a lone surrogate anyway (USVString conversion maps it to
		 * U+FFFD), but doing it here keeps the invariant true of what this file
		 * PRODUCES rather than of what the DOM silently fixes.
		 */
		var LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
		function wellFormed(value) {
			var text = typeof value === "string" ? value : String(value === null || value === undefined ? "" : value);
			return typeof text.toWellFormed === "function" ? text.toWellFormed() : text.replace(LONE_SURROGATE, "\uFFFD");
		}

		/**
		 * Short display form for a session id (keeps head and tail visible). Cuts on
		 * code-point boundaries only: `slice(0, 14)` can keep a trailing HIGH
		 * surrogate and `slice(-8)` can start on a LOW one when a pair straddles
		 * either index. This path is display-only — a DOM text node goes through the
		 * browser's USVString conversion, which maps a lone surrogate to U+FFFD, and
		 * the string never re-enters a model request — so the old form was
		 * cosmetically wrong rather than session-killing. Note the cheap
		 * `id.length` guard stays a code-unit check on purpose: it only decides
		 * whether to shorten at all, and the cut itself is what must be codepoint-safe.
		 */
		function shortSessionId(id) {
			if (typeof id !== "string" || id.length <= 26) return String(id);
			var chars = Array.from(id);
			return chars.slice(0, 14).join("") + "…" + chars.slice(-8).join("");
		}

		/** Drop the host-side banner wrapper lines the card already surfaces itself. */
		function stripRelayWrapper(text) {
			var out = typeof text === "string" ? text : "";
			if (out.indexOf("📨") === 0) {
				var nl = out.indexOf("\n");
				if (nl !== -1 && out.slice(0, nl).indexOf("[跨会话消息") !== -1) out = out.slice(nl + 1);
			}
			var at = out.lastIndexOf("（如需回复");
			if (at !== -1) out = out.slice(0, at);
			return out.trim();
		}

		/** True when a node carries this plugin's own relay banner (id-less fallback). */
		function hasRelayBanner(text) {
			if (typeof text !== "string" || text.indexOf("📨") !== 0) return false;
			var nl = text.indexOf("\n");
			return (nl === -1 ? text : text.slice(0, nl)).indexOf("[跨会话消息") !== -1;
		}

		/**
		 * Delivery time of one relay, as the host half wrote it into the banner head
		 * (`… · YYYY-MM-DD HH:mm:ss]`). `source` cannot carry it: the migration admits
		 * exactly `{kind, form, senderSessionId}`. The stamp is anchored to the end of
		 * the head line — a session title that happens to look like a date sits earlier
		 * on that line and must not win. Parsed field by field so the stamp keeps
		 * meaning the local time of the machine that sent it.
		 *
		 * R7 (M3 review): since 0.3.3 the head line may carry the §3.4 envelope AFTER
		 * the stamp (`… 23:42:05 · type=ruling pri=P0 ref=slp-a1b2]`), so the stamp is
		 * followed either by the closing bracket or by ` · <fields>` and then the
		 * bracket. It is NOT allowed to be followed by arbitrary text: the date-like
		 * title above still loses, which is what the anchoring buys.
		 */
		function relayStampOf(text) {
			if (typeof text !== "string") return "";
			var nl = text.indexOf("\n");
			var head = nl === -1 ? text : text.slice(0, nl);
			var match = /(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?: · [^\n\]]*)?\]\s*$/.exec(head);
			if (match === null) return "";
			var when = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
			return isNaN(when.valueOf()) ? "" : when.toLocaleString();
		}

		/** Render non-relay context nodes through the chat package's own renderer. */
		function delegateContextNode(ctx, props) {
			try {
				var entries = ctx.slots.entries(CHAT_NODE_SLOT);
				var fallback = null;
				for (var i = 0; i < entries.length; i += 1) {
					var entry = entries[i];
					var priority = (entry.options && entry.options.priority) || 0;
					if (entry.options && entry.options.key === "context" && priority > RELAY_PRIORITY) { fallback = entry; break; }
				}
				if (fallback !== null && fallback.component != null) {
					var chatT = ctx.locale && typeof ctx.locale.bind === "function" ? ctx.locale.bind("chat") : props.t;
					var forwarded = Object.assign({}, props, { t: chatT });
					return React.createElement(fallback.component, forwarded);
				}
			} catch (e) {
				/* fall through to the plain rendering below */
			}
			var data = props.node && props.node.data;
			var blocks = Array.isArray(data && data.content) ? data.content : [];
			var plain = blocks.filter(function (b) { return b && b.type === "text" && typeof b.text === "string"; }).map(function (b) { return b.text; }).join("\n");
			// Other plugins' context text is not ours, but this file still puts it on
			// screen — repaired for the same reason as the relay body below.
			return React.createElement("div", { style: { fontSize: "11px", opacity: 0.7, whiteSpace: "pre-wrap" } }, wellFormed(plain));
		}

		// --- §10.1 A: the sender's OWN tool row, rendered from the receipt ------
		// The receiver's card above renders a context message; this half renders
		// `team_link_send` itself, so the audit record stops being a grey
		// third-level line inside the collapsed tool tree. The card's data is the
		// §10.1.2 receipt the host half persists as `tool/result.meta` — never a
		// parse of the result text, so a wording change cannot break the render.

		/** ⚠ The slot key must be the WIRE TOOL NAME, verbatim: the dispatch is a
		 * plain keyed lookup and a typo silently falls back to the generic tool
		 * row — no error anywhere (slot contract: "a typo simply never renders").
		 * U14 pins this literal. */
		var SEND_TOOL_KEY = "team_link_send";
		/** §10.1.2 card discriminator, shared by the receipt reader and the D node. */
		var SEND_CARD_KIND = "team-link-send";
		/** §10.1.5 A draws ONE row per target, and that count is NOT bounded by the
		 * host's fan-out cap: `resolveTargetList` caps the INPUT expressions at 8,
		 * but a single `team:<name>/*` entry expands to every filled live role
		 * (`resolveTargets`) — so a legal broadcast can carry more rows than 8. The
		 * DISPLAY is therefore bounded here, at the size of the design's own
		 * per-team member cap (§10.2.4 每队成员总数 ≤24: one full-team broadcast
		 * still renders whole), and a receipt past it says so on the card instead of
		 * drawing unbounded rows (round-1 🔵 #2).
		 *
		 * This is the SECOND half of the §10.1.2 row contract, not the only one:
		 * the host half caps its own rows at this same 24 as it writes them and
		 * states the cut as `targetsTruncated: { shown, total }`, so a host-produced
		 * card arrives exactly AT this bound and a count of `card.targets` can never
		 * see it as truncated. What is left for this half is what the comments below
		 * call the defensive path: the receipt is core-opaque and persisted, so a
		 * hand-edited log or a heterogeneous implementation can carry any number of
		 * rows at all. Both halves meet in `SendCardView`, which raises the note for
		 * either source (A owns the rows, so A owns the note — §10.1.5). */
		var SEND_CARD_ROW_LIMIT = 24;
		/** §10.2.8.3 通道 1: the slash-command name the result node matches. It must equal the
		 * host half's `TEAM_SESSION_COMMAND` verbatim — the match is a plain string compare on
		 * the `command/run` payload, so a typo silently renders nothing (the same failure shape
		 * U14 pins for the tool key). */
		var TEAM_SESSION_COMMAND = "team_session";

		/** Render `{name}` placeholders of a locale template (no plural rules are
		 * needed for the handful of numeric fields a receipt has). */
		function fillTemplate(template, values) {
			var out = String(template);
			for (var key in values) {
				if (Object.prototype.hasOwnProperty.call(values, key)) out = out.split("{" + key + "}").join(String(values[key]));
			}
			return out;
		}

		/** A counter of the receipt's `summary`, as a displayable number. */
		function countOf(value) {
			return typeof value === "number" && isFinite(value) ? value : 0;
		}

		/**
		 * §10.1.2 outcome → the SHORT localized phrase A's row prints (the
		 * 2026-09-20 §10.1.5 修订: A renders from structured fields, not from
		 * `target.detail`).
		 *
		 * This object is the CARD half of the outcome enum, and it is a contract
		 * rather than a convenience: the host half mints `targets[].outcome`, the
		 * model-visible report renders it as a long sentence, and this map renders
		 * the same token as one short human phrase. `host-half.test.mjs` reads this
		 * literal out of THIS file and holds the host's minted literal set equal to
		 * its keys — a new enum value on the host side without a phrase here is red
		 * (the lock B1's retired "card row == report first line" equality was
		 * replaced by, §12.5).
		 */
		const OUTCOME_PHRASES = Object.freeze({
			"delivered": "sendResultDelivered",
			"refused": "sendResultRefused",
			"no-agent": "sendResultNoAgent",
			"no-holder": "sendResultNoHolder"
		});

		/** The short phrase for one §10.1.2 outcome; an unknown token (a NEWER
		 * host sending a bucket this build does not know) is shown as-is rather
		 * than swallowed, and outside the map it owes no phrase — the cross-half
		 * lock is what stops a new token from reaching the card un-phrased. */
		function outcomePhrase(t, outcome) {
			var key = OUTCOME_PHRASES[outcome];
			return typeof key === "string" ? t(key) : wellFormed(String(outcome));
		}

		/**
		 * The host half's row-cut mark of §10.1.2 (`targetsTruncated: {shown,total}`),
		 * normalized — or `undefined` when there is nothing readable to read.
		 *
		 * The host half caps `targets` at `SEND_CARD_ROW_LIMIT` ROWS before it writes
		 * the receipt, and that cut is invisible to a client that only counts rows
		 * (the rows arrive exactly at the bound). The mark is the fact that survives
		 * it: `total` is how many targets the delivery really had, `shown` is how
		 * many of them the receipt carries. Without this read a host-produced card
		 * for a 30-target broadcast would state 24 targets and draw no truncation
		 * note at all (the cross-round gap U14 pins).
		 *
		 * It is an OPTIONAL member of a core-opaque, persisted payload, so it gets
		 * the same treatment as `meta` in the reader below — an unreadable shape is
		 * DROPPED rather than allowed to reject the whole card (the card still
		 * renders from its rows, and `SendCardView` still bounds them). Both members
		 * are display facts, so a non-finite one makes the mark unreadable: nothing
		 * else in this reader coerces either, and a coerced number would be a number
		 * the receipt never stated.
		 */
		function readTargetsTruncated(value) {
			if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
			if (typeof value.shown !== "number" || !isFinite(value.shown)) return undefined;
			if (typeof value.total !== "number" || !isFinite(value.total)) return undefined;
			return { shown: value.shown, total: value.total };
		}

		/**
		 * Shape reader for the §10.1.2 receipt. Returns `null` — never a partial
		 * card — the moment anything does not match, so every degradation lands on
		 * the same plain fallback. `meta` is core-opaque: it may come from another
		 * tool, an older or newer build, or a hand-edited log, so nothing in it is
		 * trusted. The read is total: a hostile getter cannot make it throw. The
		 * number of rows the receipt may DRAW is a separate, render-time concern
		 * (`SEND_CARD_ROW_LIMIT`): the reader keeps the receipt whole so the label's
		 * target count stays the honest total — and keeps the host's own
		 * `targetsTruncated` mark for the same reason, since a receipt the host half
		 * already cut must still be able to say so.
		 */
		function readSendCard(value) {
			try {
				if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
				if (value.kind !== SEND_CARD_KIND || value.v !== 1) return null;
				if (typeof value.at !== "number" || !isFinite(value.at)) return null;
				if (typeof value.senderSessionId !== "string" || value.senderSessionId === "") return null;
				var message = value.message;
				if (message === null || typeof message !== "object") return null;
				if (typeof message.text !== "string" || typeof message.chars !== "number") return null;
				if (!Array.isArray(value.targets)) return null;
				var targets = [];
				for (var i = 0; i < value.targets.length; i += 1) {
					var row = value.targets[i];
					if (row === null || typeof row !== "object" || Array.isArray(row)) return null;
					if (typeof row.outcome !== "string" || typeof row.detail !== "string") return null;
					if (row.sessionId !== null && typeof row.sessionId !== "string") return null;
					targets.push(row);
				}
				var summary = value.summary;
				if (summary === null || typeof summary !== "object") return null;
				return {
					kind: SEND_CARD_KIND,
					v: 1,
					at: value.at,
					senderSessionId: value.senderSessionId,
					meta: value.meta !== null && typeof value.meta === "object" && !Array.isArray(value.meta) ? value.meta : undefined,
					message: { text: message.text, truncated: message.truncated === true, chars: message.chars },
					targets: targets,
					targetsTruncated: readTargetsTruncated(value.targetsTruncated),
					summary: summary,
					fanout: value.fanout === true
				};
			} catch (e) {
				return null;
			}
		}

		// --- §10.1.5 无结构化回执时的「文本重建」(DEFECT-5, 2026-09-20) ----------
		//
		// Why this exists (measured, not inferred). `presentationMeta` is projected
		// only for a TOP-LEVEL dispatch — `exec.parent === undefined`
		// (`dsh-tools/lib/types/index.js:1191`) — so a `team_link_send` issued from
		// inside a `run_code` program never gets a `tool/result.meta`: the bridge
		// logs `tool/ptc-dispatch` with exactly
		// `{rootCallId, parentCallId, subCallId, name, arguments, isError, content}`
		// (no `meta` member at all), and the chat package builds that call's block
		// through `childResult`, which does not copy a `meta` either
		// (`dsh-client-ui-chat/lib/client.js`, `conversation-nodes/tool.js`). A scan
		// of every session log in the store found 720+ such dispatches and ZERO
		// carrying `meta`, against 11 `tool/result` events that DO carry the card —
		// i.e. the program-issued send was always a grey fallback row while the
		// directly-issued one always had a card.
		//
		// The degradation order is a HARD rule, not a preference: a readable `meta`
		// always wins (see `SendToolCallView`), and the rebuild below is reached only
		// when there is none. Two consequences the tests pin:
		//   - `readSendCard` is the ONLY source of a card when a receipt exists, so
		//     making this whole section a constant `null` must leave every
		//     meta-bearing case rendering exactly what it rendered before;
		//   - the rebuild never invents a field. It reads the target identities, the
		//     outcome tokens and the counts off the text; everything our text does
		//     not carry (`at`, `senderSessionId`, `message`, `busy`, `detail`) is
		//     simply absent from the result rather than guessed. The card it returns
		//     feeds A only (D is driven by the receipt's `kind` through the
		//     definition match, so a rebuilt card can never produce a top-level node).
		//
		// The shapes below are the host half's, verbatim (`lib/index.js`): a
		// delivered single target is
		//   `已投递到 <sessionLabel>（<channelNote>）：<detail>`
		// and a fan-out report is an optional `❌ N 个目标未投递（M 个已投递）` lead,
		// the `广播 fan-out：N 个目标…` header, one `- <label> → <outcome>：<detail>`
		// row per target (whose detail may itself span lines — the `no-agent`
		// refusal is a multi-line paragraph) and a `汇总：…。` line, optionally
		// followed by `注意：…` notes.
		//
		// Anything outside those two shapes — a single-target REFUSAL (our text does
		// not name a target there at all), an addressing/`meta` rejection, a
		// truncated or reworded report — is NOT half-rebuilt: the whole row falls to
		// (c), the plain face, which shows every line verbatim. That is the design's
		// 「解析失败 ⇒ 纯文本行；不抛错、不吞行、不伪造」 read as an all-or-nothing
		// contract, and it is why each cross-check below returns `null` instead of
		// dropping the line it could not place.

		/** Fan-out header: `广播 fan-out：N 个目标[（重复目标已去重 N 个）]`. */
		var REBUILD_FANOUT_HEAD = /^广播 fan-out：(\d+) 个目标(?:（重复目标已去重 (\d+) 个）)?$/u;
		/** The failure lead `fanout()` puts in front of a batch that lost a target. */
		var REBUILD_FAILURE_LEAD = /^❌ (\d+) 个目标未投递（(\d+) 个已投递）$/u;
		/** One per-target row: `<label> → <outcome token>：<detail>`. */
		var REBUILD_TARGET_ROW = /^- (.+?) → ([^：]+)：(.*)$/u;
		/** `汇总：…。` — the trailing full stop is part of the host's line. */
		var REBUILD_SUMMARY = /^汇总：(.*)。$/u;
		/** The `注意：…` notes `withMetaNotes` / the fan-out tail may append. */
		var REBUILD_NOTE = /^注意：/u;
		/** A single delivered target's first line, prefix only. */
		var REBUILD_DELIVERED = /^已投递到 (.+)$/u;
		/** `targetLabel`'s expression form: `<sessionId>（via <expr>）`. */
		var REBUILD_VIA = /^(.+)（via (.+)）$/u;

		/**
		 * The `汇总：` parts, in the exact order `fanout()` pushes them. The last
		 * member is whether the part is unconditional: `投递` and `拒绝` are always
		 * printed, the other three only when their count is non-zero. Order matters
		 * and is enforced — a report whose buckets are reordered is not a shape this
		 * build can count, and is left to the plain face.
		 */
		var REBUILD_SUMMARY_PARTS = [
			["delivered", /^(\d+) 投递$/u, true],
			["refused", /^(\d+) 拒绝$/u, true],
			["noAgent", /^(\d+) 无活动代理$/u, false],
			["noHolder", /^(\d+) 空缺目标（no-holder，不计入投递与失败）$/u, false],
			["deduped", /^(\d+) 个重复目标已去重$/u, false]
		];

		/** `summary` counts of one `汇总：` body, or null when any part is not one
		 * of the five this build knows (in order, first two mandatory). */
		function rebuiltSummary(body) {
			var parts = body.split(" / ");
			var stats = {};
			var at = 0;
			for (var i = 0; i < parts.length; i += 1) {
				var found = -1;
				for (var j = at; j < REBUILD_SUMMARY_PARTS.length; j += 1) {
					if (REBUILD_SUMMARY_PARTS[j][1].test(parts[i])) { found = j; break; }
				}
				if (found === -1) return null;
				stats[REBUILD_SUMMARY_PARTS[found][0]] = Number(REBUILD_SUMMARY_PARTS[found][1].exec(parts[i])[1]);
				at = found + 1;
			}
			for (var k = 0; k < REBUILD_SUMMARY_PARTS.length; k += 1) {
				var key = REBUILD_SUMMARY_PARTS[k][0];
				if (stats[key] === undefined) {
					if (REBUILD_SUMMARY_PARTS[k][2]) return null;
					stats[key] = 0;
				}
			}
			return stats;
		}

		/**
		 * One fan-out row's label, back into the identity the STRUCTURED card
		 * carries (`targetLabel(row)`, `lib/index.js`): `<id>`, `<id>（via <expr>）`
		 * or — for the vacant-role row, which has no resolved id — the addressing
		 * expression itself. Only a `team:` address can lack a session id
		 * (`resolveTargetList` resolves everything else to one), so the `team:`
		 * prefix is what separates the two, and a label matching neither shape is
		 * refused rather than stored as a guessed id.
		 */
		function rebuiltIdentity(label) {
			var via = REBUILD_VIA.exec(label);
			if (via !== null) {
				return via[1] === "" || via[2] === "" ? null : { sessionId: via[1], expr: via[2] };
			}
			if (label === "") return null;
			if (label.indexOf("team:") === 0) return { sessionId: null, expr: label };
			return { sessionId: label, expr: undefined };
		}

		/**
		 * The target half of a delivered sentence — everything before the
		 * `已投递到 ` detail separator — as the session id `sessionLabel(id, title)`
		 * was handed. That helper mints `id` or `「title」(id)`, optionally followed
		 * by the §3.6.2 channel note in fullwidth parentheses
		 * (`（已配对通道，免确认自动投递）` / `（provisional 通道，24h 内未批准自动回退）`).
		 *
		 * The channel note is stripped by SHAPE, not by matching those two strings:
		 * hard-coding host copy here would be a second place for it to live. A title
		 * is user text and may contain the separator or fullwidth parentheses, so
		 * the caller walks the separator left to right and takes the first prefix
		 * that parses (see `rebuiltDeliveredId`).
		 */
		function rebuiltSessionLabel(head) {
			var label = head;
			if (label.charAt(label.length - 1) === "）") {
				var open = label.lastIndexOf("（");
				if (open <= 0) return null;
				label = label.slice(0, open);
			}
			if (label.charAt(0) === "「") {
				var close = label.lastIndexOf("」(");
				if (close === -1 || label.charAt(label.length - 1) !== ")") return null;
				label = label.slice(close + 2, label.length - 1);
			}
			return label === "" ? null : label;
		}

		/** The session id inside a delivered sentence: the first `：`-terminated
		 * prefix that parses as a `sessionLabel` is the separator (a title's own
		 * `：` produces a prefix this helper refuses, so it is skipped). */
		function rebuiltDeliveredId(body) {
			for (var at = body.indexOf("："); at !== -1; at = body.indexOf("：", at + 1)) {
				var id = rebuiltSessionLabel(body.slice(0, at));
				if (id !== null) return id;
			}
			return null;
		}

		/** A single delivered target, rebuilt. The trailing lines may only be
		 * `注意：…` notes; anything else means the text is not a shape this build
		 * reads, and the row falls to the plain face. */
		function rebuiltDelivered(lines) {
			var head = REBUILD_DELIVERED.exec(lines[0]);
			if (head === null) return null;
			for (var i = 1; i < lines.length; i += 1) {
				if (!REBUILD_NOTE.test(lines[i])) return null;
			}
			var sessionId = rebuiltDeliveredId(head[1]);
			if (sessionId === null) return null;
			return {
				kind: SEND_CARD_KIND,
				v: 1,
				rebuiltFromText: true,
				// One target, and the only outcome this sentence can mean. The other
				// buckets are not read from anywhere — they are zero because the row
				// list is exactly one entry, which is arithmetic on what was read.
				targets: [{ sessionId: sessionId, expr: undefined, outcome: "delivered" }],
				summary: { delivered: 1, refused: 0, noAgent: 0, noHolder: 0, deduped: 0 },
				fanout: false
			};
		}

		/**
		 * A fan-out report, rebuilt. Every structural fact is CROSS-CHECKED against
		 * the others before a card is returned, so a report that merely looks like
		 * ours cannot pass: the row count must equal the header's declared count,
		 * the summary's four buckets must equal the rows' own tallies, the dedupe
		 * count must agree with the header, and the `❌` lead must be present
		 * exactly when a row is not `delivered` and must repeat the same two
		 * numbers. Any mismatch — or any row whose label has no identity, or any
		 * outcome token outside the four the summary can bucket — returns `null`,
		 * and the plain face shows the whole report instead.
		 */
		function rebuiltReport(lines) {
			var at = 0;
			var lead = null;
			var first = REBUILD_FAILURE_LEAD.exec(lines[0]);
			if (first !== null) {
				lead = { undelivered: Number(first[1]), delivered: Number(first[2]) };
				at = 1;
			}
			var head = at < lines.length ? REBUILD_FANOUT_HEAD.exec(lines[at]) : null;
			if (head === null) return null;
			var declared = Number(head[1]);
			var headDeduped = head[2] === undefined ? 0 : Number(head[2]);
			at += 1;
			var targets = [];
			while (at < lines.length && lines[at].indexOf("- ") === 0) {
				var row = REBUILD_TARGET_ROW.exec(lines[at]);
				if (row === null) return null;
				var identity = rebuiltIdentity(row[1]);
				if (identity === null) return null;
				targets.push({ sessionId: identity.sessionId, expr: identity.expr, outcome: row[2] });
				at += 1;
				// A row's detail may span lines (the `no-agent` refusal is a
				// paragraph). Continuation lines belong to the row already pushed and
				// are neither rendered nor needed: A draws identity + phrase, and the
				// report sentence stays the model-visible record.
				while (at < lines.length && lines[at].indexOf("- ") !== 0 && !REBUILD_SUMMARY.test(lines[at]) && !REBUILD_NOTE.test(lines[at])) at += 1;
			}
			if (targets.length === 0 || targets.length !== declared) return null;
			if (at >= lines.length) return null;
			var summaryLine = REBUILD_SUMMARY.exec(lines[at]);
			if (summaryLine === null) return null;
			at += 1;
			while (at < lines.length) {
				if (!REBUILD_NOTE.test(lines[at])) return null;
				at += 1;
			}
			var stats = rebuiltSummary(summaryLine[1]);
			if (stats === null) return null;
			// The rows' own tally, cross-checked against the summary's. The token set
			// is NOT re-declared here: `OUTCOME_PHRASES` is already the card half of
			// the outcome enum and the §12.5 cross-half lock holds it equal to the set
			// the host can mint, so this reads that same literal. The four bucket
			// comparisons below spell out the token→bucket pairing (`no-agent` is
			// counted as `noAgent`), and the total check is what makes a token outside
			// the four — including one a newer host added a phrase for — refuse the
			// whole report instead of silently leaving a row uncounted.
			var tally = {};
			for (var i = 0; i < targets.length; i += 1) {
				var token = targets[i].outcome;
				if (OUTCOME_PHRASES[token] === undefined) return null;
				tally[token] = (tally[token] === undefined ? 0 : tally[token]) + 1;
			}
			var counted = 0;
			var pairs = [["delivered", "delivered"], ["refused", "refused"], ["no-agent", "noAgent"], ["no-holder", "noHolder"]];
			for (var p = 0; p < pairs.length; p += 1) {
				var bucket = tally[pairs[p][0]] === undefined ? 0 : tally[pairs[p][0]];
				if (bucket !== stats[pairs[p][1]]) return null;
				counted += bucket;
			}
			if (counted !== targets.length) return null;
			// The dedupe count lives in BOTH the header and the summary, and only ever
			// when there was one: the two must agree, and a `0` clause is refused
			// because this build's host never prints one.
			if (stats.deduped !== headDeduped || (head[2] !== undefined) !== (headDeduped > 0)) return null;
			var delivered = tally["delivered"] === undefined ? 0 : tally["delivered"];
			var undelivered = targets.length - delivered;
			if ((lead !== null) !== (undelivered > 0)) return null;
			if (lead !== null && (lead.undelivered !== undelivered || lead.delivered !== delivered)) return null;
			return {
				kind: SEND_CARD_KIND,
				v: 1,
				rebuiltFromText: true,
				targets: targets,
				summary: stats,
				fanout: true
			};
		}

		/**
		 * §10.1.5 「文本重建」: the minimal card for a send that has no receipt,
		 * rebuilt from the model-visible text our OWN host half wrote. Returns
		 * `null` — never a partial card — the moment the text is not one of the two
		 * shapes we mint, so the caller's plain fallback stays the only other
		 * outcome. Total by construction (a non-string or any surprise yields
		 * `null`); it is also wrapped, because a renderer that throws takes the
		 * whole transcript down (§10.1.5 降级优先).
		 *
		 * It deliberately returns a REDUCED object: `targets` carry only the
		 * identity and the outcome token (no `detail` — A does not render it and the
		 * rebuild must not invent a sentence), `summary` only what the report
		 * states, and no `at` / `senderSessionId` / `message` at all, because our
		 * text carries none of them.
		 */
		function readSendCardFromText(value) {
			try {
				if (typeof value !== "string") return null;
				var lines = value.split("\n");
				while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
				if (lines.length === 0) return null;
				// The report first: its first line is either the `❌` lead or the
				// `广播 fan-out：` header, and the delivered sentence starts with
				// neither — the two shapes cannot be confused for one another.
				var report = rebuiltReport(lines);
				return report === null ? rebuiltDelivered(lines) : report;
			} catch (e) {
				return null;
			}
		}

		/** The §3.4 envelope of the card, as the banner's compact `k=v` fields. */
		function envelopeFields(meta) {
			if (meta === null || meta === undefined) return "";
			var parts = [];
			if (typeof meta.type === "string") parts.push("type=" + meta.type);
			if (typeof meta.pri === "string") parts.push("pri=" + meta.pri);
			if (typeof meta.ref === "string") parts.push("ref=" + meta.ref);
			return parts.join(" ");
		}

		/** One target's §10.1.2 busy prediction as the row's compact badge, or null
		 * when the target has none. `busy` is `{running:false}` for an idle target
		 * (a followup woke it into a NEW turn), so only a running one is a badge.
		 * The COPY is short on purpose: this is the card's half of the same reading
		 * the model-visible report renders as the long «…（steer 注入当前回合）»
		 * sentence — a person reading the card gets the state, not the mechanism. */
		function busyBadge(target, t) {
			var busy = target.busy;
			if (busy === null || typeof busy !== "object" || busy.running !== true) return null;
			return typeof busy.minutes === "number" && isFinite(busy.minutes)
				? fillTemplate(t("sendBusyBadge"), { minutes: busy.minutes })
				: t("sendBusyBadgeUnknown");
		}

		/** Head line of D (`dshsl-send` top face): title, sender, delivery time. */
		function sendCardHead(card, t) {
			var when = new Date(card.at);
			var whenText = isNaN(when.valueOf()) ? "" : when.toLocaleString();
			var envelope = envelopeFields(card.meta);
			return React.createElement("div", { className: "dshsl-relay-head" },
				"\uD83D\uDCE4 ",
				t("sendTitle"),
				React.createElement("span", { className: "dshsl-relay-sender", title: wellFormed(card.senderSessionId) }, wellFormed(shortSessionId(card.senderSessionId))),
				envelope !== "" ? React.createElement("span", { className: "dshsl-send-env" }, envelope) : null,
				whenText !== "" ? React.createElement("span", { className: "dshsl-relay-when" }, whenText) : null);
		}

		/** D's body, with the §10.1.2 truncation stated on the card. */
		function sendCardBody(card, t) {
			return React.createElement("div", { className: "dshsl-relay-body" },
				wellFormed(card.message.text) || t("relayEmpty"),
				card.message.truncated === true
					? React.createElement("span", { className: "dshsl-send-trunc" }, " " + fillTemplate(t("sendTruncated"), { chars: countOf(card.message.chars) }))
					: null);
		}

		/** D's summary line: the counts every receipt carries, plus dedupe when > 0. */
		function sendCardSummary(card, t) {
			var summary = card.summary || {};
			var text = fillTemplate(t("sendSummary"), {
				delivered: countOf(summary.delivered),
				refused: countOf(summary.refused),
				noAgent: countOf(summary.noAgent),
				noHolder: countOf(summary.noHolder)
			});
			if (countOf(summary.deduped) > 0) text = text + " · " + fillTemplate(t("sendDeduped"), { deduped: countOf(summary.deduped) });
			return text;
		}

		/**
		 * The number of targets A's label states (§10.1.2 「标签显示真值总数」): the
		 * delivery's real row count, NEVER the number of rows drawn.
		 *
		 * Which one that is depends on who cut the rows:
		 *   - a receipt from this plugin's host half carries the host's
		 *     `targetsTruncated` mark when — and only when — the host cut it, and
		 *     `total` is then how many targets the delivery really had (the host
		 *     counts every resolved target before it cuts the rows, `lib/index.js`
		 *     `buildSendCard`). Counting `card.targets` here would print 24 for a
		 *     30-target broadcast;
		 *   - a receipt WITHOUT the mark carries every row it knows about (that
		 *     includes a hand-edited log whose rows are over the limit), so its
		 *     length IS the total — the render-time row bound below is a bound on
		 *     what is DRAWN, and must not turn into a wrong number in the label.
		 */
		function sendCardTargetTotal(card) {
			var mark = card.targetsTruncated;
			return mark === undefined ? card.targets.length : mark.total;
		}

		/** A's minimal label (§10.1.5 A): the wire tool name and the target count —
		 * no title, no time, no body, no summary. Those are D's, and each of them
		 * is rendered on exactly ONE of the two faces. The count is the TRUE total
		 * (`sendCardTargetTotal`), not the number of rows drawn. */
		function sendCardRowLabel(card, toolName, t) {
			return React.createElement("div", { className: "dshsl-send-rowhead" },
				"\u2726 ",
				t("sendPlainTitle"),
				" · ",
				wellFormed(toolName === undefined || toolName === null ? SEND_TOOL_KEY : String(toolName)),
				" · ",
				fillTemplate(t("sendRowTargets"), { count: sendCardTargetTotal(card) }));
		}

		/** One target as A's row names it (§10.1.5: 「目标（`expr` 或短 id）」): the
		 * id in its short display form, plus the addressing expression it came from
		 * when that is something else — the shape the host half's report line
		 * builds (`targetLabel`), with the id shortened the way the receiver's card
		 * shortens a sender. A `no-holder` row has no id, so its expression IS the
		 * target. */
		function targetIdentity(target) {
			if (target.sessionId !== null && target.sessionId !== undefined) {
				var id = wellFormed(shortSessionId(target.sessionId));
				return target.expr !== undefined ? id + "（via " + wellFormed(target.expr) + "）" : id;
			}
			return target.expr !== undefined ? wellFormed(target.expr) : "\u2014";
		}

		/**
		 * §10.1 sender-side card, in the two shapes §10.1.5 splits ("每一块信息
		 * 只准出现一次"). The faces carry DISJOINT blocks, not the same blocks
		 * twice:
		 *   - `detail === true` is A, the tool row: the minimal label (tool name +
		 *     TRUE target count) plus one row per target (the target identity, the
		 *     SHORT phrase of its §10.1.2 `outcome`, and the §3.5 busy badge when it
		 *     has one) — and nothing else; the rows are capped at
		 *     `SEND_CARD_ROW_LIMIT`, and a receipt that is over the cap — the
		 *     host's own `targetsTruncated` mark, or a foreign/hand-edited one the
		 *     render-time bound catches — states the truncation on A (the face that
		 *     owns the rows);
		 *   - `detail === false` is D, the top-level node: title + sender/time +
		 *     body + summary counts — and no per-target row.
		 * A row renders from the STRUCTURED fields only (2026-09-20 修订): the
		 * `outcome` token through `OUTCOME_PHRASES`, the `busy` prediction, and the
		 * identity. `target.detail` — the pre-composed sentence the MODEL sees — is
		 * deliberately NOT a render input here (it carries delivery mechanism, e.g.
		 * 「steer 注入当前回合」, and runs 2–3 lines per target); it stays in the
		 * receipt as the model-visible fact source and as the plain row's text.
		 * U14/U15 assert the split structurally and assert that no statement of
		 * one face occurs anywhere in the other.
		 */
		function SendCardView(props) {
			var card = props.card;
			var detail = props.detail === true;
			var t = typeof props.t === "function" ? props.t : function (key) { return key; };
			if (detail) {
				// The rows are bounded HERE as well as on the host half, and the note
				// is raised for either source (§10.1.5 A owns the per-target rows, so
				// the note lives on A and nowhere else):
				//  - `meta` is core-opaque and persisted, so a hand-edited log or a
				//    heterogeneous implementation can carry any number of rows at all
				//    — this is the defence for those (round-1 🔵 #2);
				//  - a receipt from THIS plugin's host half arrives already cut, at
				//    exactly this same limit, so counting the rows can never see it
				//    as truncated. Its `targetsTruncated` mark is the only carrier of
				//    that fact, and without it a 30-target broadcast would show no
				//    truncation at all (the cross-round gap U14 pins).
				// The number in 「仅显示前 N 行」 is what is DRAWN, never a count the
				// mark merely asserts: the sentence has to stay true of the card it
				// is on even when the mark was hand-edited.
				var overflow = card.targets.length > SEND_CARD_ROW_LIMIT;
				var shown = overflow ? card.targets.slice(0, SEND_CARD_ROW_LIMIT) : card.targets;
				var rows = shown.map(function (target, index) {
					// §10.1.5 修订: identity + the outcome's short phrase + the busy
					// badge. The row never prints `target.detail` (see the doc comment
					// above); the outcome span keeps its class and its `data-outcome`
					// token (the refused / no-agent / no-holder row is styled from it),
					// while its TEXT is the human phrase.
					var badge = busyBadge(target, t);
					return React.createElement("div", { className: "dshsl-send-target", key: "target-" + index },
						React.createElement("span", { className: "dshsl-send-targetid" }, targetIdentity(target)),
						" ",
						React.createElement("span", { className: "dshsl-send-outcome", "data-outcome": target.outcome }, outcomePhrase(t, target.outcome)),
						badge !== null ? React.createElement("span", { className: "dshsl-send-trunc" }, " " + badge) : null);
				});
				var truncated = overflow || card.targetsTruncated !== undefined;
				return React.createElement("div", { className: "dshsl-relay dshsl-send", "data-slp-send": "row" },
					sendCardRowLabel(card, props.toolName, t),
					React.createElement("div", { className: "dshsl-send-targets" }, rows),
					truncated ? React.createElement("div", { className: "dshsl-send-rows-trunc" }, fillTemplate(t("sendRowsTruncated"), { shown: shown.length })) : null);
			}
			return React.createElement("div", { className: "dshsl-relay dshsl-send", "data-slp-send": "top" },
				sendCardHead(card, t),
				sendCardBody(card, t),
				React.createElement("div", { className: "dshsl-send-summary" }, sendCardSummary(card, t)));
		}

		/** Model-visible text of a settled tool block (what the fallback shows). */
		function blockText(block) {
			var content = block !== null && block !== undefined && Array.isArray(block.content) ? block.content : [];
			return content
				.filter(function (part) { return part !== null && part !== undefined && part.type === "text" && typeof part.text === "string"; })
				.map(function (part) { return part.text; })
				.join("\n");
		}

		/**
		 * Degradation shape of A (§10.1.1): the row the sender sees when there is
		 * no receipt to draw a card from — an in-flight call, a call whose result
		 * carries no `meta` (every log written before §10.1), or a `meta` this
		 * build cannot read. It states the call and shows the model-visible result
		 * verbatim, so the fallback is the generic row's information, never a
		 * half-drawn card.
		 */
		function PlainSendRow(props) {
			var t = typeof props.t === "function" ? props.t : function (key) { return key; };
			var block = props.block;
			var settled = block !== null && block !== undefined && block.kind === "tool-result";
			var text = settled ? blockText(block) : "";
			return React.createElement("div", { className: "dshsl-plain", "data-slp-send": "plain" },
				React.createElement("div", { className: "dshsl-plain-head" },
					"\u2726 ",
					t("sendPlainTitle"),
					" · ",
					wellFormed(String(props.toolName === undefined ? SEND_TOOL_KEY : props.toolName)),
					" · ",
					settled ? t("sendPlainSettled") : t("sendPlainRunning")),
				text !== "" ? React.createElement("div", { className: "dshsl-plain-body" }, wellFormed(text)) : null);
		}

		/**
		 * §10.1.1 A. Three situations, in this order (§10.1.5):
		 *   1. a SETTLED block carrying a readable receipt → the card is drawn from
		 *      `meta`. This branch is first and unconditional: the text rebuild below
		 *      is a degradation, never a second opinion, so a receipt that exists
		 *      decides the render even when the model-visible text would parse into a
		 *      different card;
		 *   2. no receipt (or one this build cannot read) but the model-visible text
		 *      matches one of the two shapes our own host half mints → a minimal card
		 *      rebuilt from that text. This is the path every `team_link_send` issued
		 *      from inside `run_code` takes (see the section comment above);
		 *   3. neither — running, empty text, a refusal sentence, anything this
		 *      build cannot place → the plain row, showing the model-visible text
		 *      verbatim. Nothing is swallowed and nothing is invented.
		 * This function never throws: a renderer that dies takes the whole transcript
		 * down with it (§10.1.5 降级优先).
		 */
		function SendToolCallView(props) {
			var card = null;
			try {
				var block = props.block;
				if (block !== null && block !== undefined && block.kind === "tool-result") {
					card = readSendCard(block.meta);
					if (card === null) card = readSendCardFromText(blockText(block));
				}
			} catch (e) {
				card = null;
			}
			return card === null
				? React.createElement(PlainSendRow, props)
				: React.createElement(SendCardView, { card: card, detail: true, toolName: props.toolName, t: props.t });
		}

		// --- §10.1.3 D: the same send as a TOP-LEVEL conversation node ---------
		// A: the audit record at the tool call itself; D: a top-level node so the
		// send is visible without expanding the tool tree. D adds NO session-log
		// event (a new event type is forbidden, §10.3): it is a client-side
		// `uiConversation` definition matching the EXISTING `tool/call` and
		// `tool/result` events, plus a same-kind `conversation.chat.node` entry.
		//
		// H2 (design §10.5) — resolved from source: the chat package's
		// `chatNode` / `contextLocation` helpers are MODULE-LOCAL
		// (`dsh-client-ui-chat/lib/client.js` defines them at 4158/4170 and exports
		// only {EMPTY_CHAT_SNAPSHOT, apply, inject, isRunningTool, isSettledTool} at
		// 8398-8402), and the conversation service documents that cross-plugin value
		// imports are forbidden in client bundles. So the helpers are unreachable and
		// this takes the design's documented fallback: the node literal is built by
		// hand against the PUBLIC shape of ChatConversationViewNode
		// (`{key, kind, id, target, anchorSeq, location, visibility, data}`), with
		// `location`/`anchorSeq` derived exactly the way `chatNode` derives them.
		// The second half of H2 (does `events.register` accept an EXTERNAL
		// definition?) is answered by the registry source: it keys definitions by
		// `definition.kind` alone and throws only on a duplicate kind — no package
		// restriction — and `team-link-send` is claimed by nobody in the shipped
		// packages.

		/** Sequenced number of an event, or 0 when the log carries none. */
		function eventSeq(event) {
			return event !== null && event !== undefined && typeof event.seq === "number" && isFinite(event.seq) ? event.seq : 0;
		}
		/** Unix ms of an event, or 0. */
		function eventTime(event) {
			return event !== null && event !== undefined && typeof event.time === "number" && isFinite(event.time) ? event.time : 0;
		}
		/** The `data` of an event, or null. */
		function eventData(event) {
			return event !== null && event !== undefined && event.data !== null && typeof event.data === "object" ? event.data : null;
		}
		/** Call id of a `tool/result` event — the same field the chat package pairs
		 * its own tool tree on (`data.message.source.callId`). */
		function toolResultCallId(event) {
			const data = eventData(event);
			const message = data === null ? null : data.message;
			const source = message === null || message === undefined ? null : message.source;
			const callId = source === null || source === undefined ? undefined : source.callId;
			return typeof callId === "string" && callId !== "" ? callId : null;
		}

		/** The receipt carried by a `tool/result` event, or null. */
		function resultCardOf(event) {
			const data = eventData(event);
			return data === null ? null : readSendCard(data.meta);
		}

		/**
		 * Window-truncation fallback (design §10.1.5): `tool/call` scrolled out of
		 * the loaded history, so only `tool/result` events remain. The receipt IS the
		 * identification then — and it is the ONLY one available: a result's `source`
		 * is exactly `{kind, callId}` (`dsh-llm` message.d.ts), so the wire carries no
		 * tool name to attribute an orphaned result by. A result whose `meta` is not
		 * our card is therefore not ours.
		 */
		function sendStateFromMatches(context) {
			const matches = context !== null && context !== undefined && Array.isArray(context.matches) ? context.matches : [];
			for (let index = 0; index < matches.length; index += 1) {
				const event = matches[index] === null || matches[index] === undefined ? undefined : matches[index].event;
				if (event === null || event === undefined || event.type !== "tool/result") continue;
				const card = resultCardOf(event);
				if (card === null) continue;
				return { callId: toolResultCallId(event), seq: eventSeq(event), time: eventTime(event), card: card };
			}
			return null;
		}

		/**
		 * This plugin's Conversation business Definition (design §10.1.3).
		 *
		 * `match` claims ONLY existing event types: a `tool/call` whose wire name is
		 * this plugin's tool (as the start) and a `tool/result` carrying one of our
		 * receipts (as an update). Gating the result on the receipt rather than on
		 * its call id is deliberate: an unmatched result simply never becomes a node
		 * (a result without a receipt has nothing to draw), while matching every
		 * tool result would create an engine Context for every tool call in every
		 * session. A result whose `tool/call` fell outside the window still creates
		 * its Context here — that is the rebuild path above.
		 */
		var sendNodeDefinition = {
			kind: SEND_CARD_KIND,
			target: "chat",
			match: function (event) {
				try {
					if (event === null || typeof event !== "object") return null;
					if (event.type === "tool/call") {
						const data = eventData(event);
						if (data === null || data.name !== SEND_TOOL_KEY) return null;
						return typeof data.callId === "string" && data.callId !== "" ? { id: data.callId, role: "start" } : null;
					}
					if (event.type === "tool/result") {
						if (resultCardOf(event) === null) return null;
						const callId = toolResultCallId(event);
						return callId === null ? null : { id: callId, role: "update" };
					}
					// Everything else — including every event type this plugin has
					// nothing to say about — is not claimed.
					return null;
				} catch (e) {
					return null;
				}
			},
			start: function (_context, match) {
				const event = match === null || match === undefined ? undefined : match.event;
				const data = eventData(event);
				return {
					callId: data === null ? undefined : data.callId,
					seq: eventSeq(event),
					time: eventTime(event),
					card: null
				};
			},
			update: function (context, match) {
				const event = match === null || match === undefined ? undefined : match.event;
				const card = resultCardOf(event);
				if (card === null) return context.state;
				return { callId: toolResultCallId(event), seq: eventSeq(event), time: eventTime(event), card: card };
			},
			buildViewNode: function (context) {
				// A definition that throws (or returns a malformed node) must never
				// reach further than "this row does not render" (§10.1.5).
				try {
					const state = context !== null && context !== undefined && context.state !== null && typeof context.state === "object" ? context.state : sendStateFromMatches(context);
					if (state === null || state === undefined) return null;
					const card = readSendCard(state.card);
					if (card === null) return null;
					const start = context.start === null || context.start === undefined ? null : context.start;
					const startEvent = start === null ? null : start.event;
					const first = Array.isArray(context.matches) && context.matches.length > 0 ? context.matches[0] : undefined;
					const anchor = startEvent !== null ? eventSeq(startEvent) : state.seq !== undefined ? state.seq : first !== undefined && first !== null ? eventSeq(first.event) : 0;
					const location = start !== null && start.location !== undefined ? start.location : first !== undefined && first !== null && first.location !== undefined ? first.location : { kind: "unresolved" };
					// The literal `chatNode` builds (see the H2 note above).
					return {
						key: context.key,
						kind: SEND_CARD_KIND,
						id: context.id,
						target: "chat",
						anchorSeq: anchor,
						location: location,
						visibility: "visible",
						data: { kind: SEND_CARD_KIND, callId: state.callId, at: state.time, card: card }
					};
				} catch (e) {
					return null;
				}
			}
		};

		/**
		 * §10.1.3 D's renderer. It draws the SUMMARY face of the card — the title,
		 * the sender and the time, the body and the result counts — while the tool
		 * row carries the per-target rows (§10.1.5: 每一块信息只准出现一次, so the
		 * recipients are NOT restated here — A's rows own the target identities).
		 * A node with no readable receipt renders NOTHING (`null`) instead of
		 * throwing.
		 */
		function TopLevelSendCard(props) {
			var card = null;
			try {
				var node = props.node;
				var data = node === null || node === undefined ? undefined : node.data;
				card = data === null || data === undefined ? null : readSendCard(data.card);
			} catch (e) {
				card = null;
			}
			if (card === null) return null;
			return React.createElement(SendCardView, { card: card, detail: false, t: props.t });
		}

		/**
		 * One console line for a client-side degradation (§10.1.5 降级优先). The
		 * browser console is not the session log, so nothing here writes an event
		 * of any kind (§10.3); it exists so a degraded face is diagnosable instead
		 * of silently missing.
		 */
		function reportDegrade(where, consequence, error) {
			try {
				if (typeof console !== "undefined" && console !== null && typeof console.warn === "function") {
					console.warn("[dsh-team-link] " + where + " failed — " + consequence + ":", error);
				}
			} catch (e) {
				/* a console that itself throws must not matter either */
			}
		}

		/**
		 * Register one slot entry so that a refusal costs THAT row alone, never the
		 * registrations after it (差异审计 B3). Both halves can throw —
		 * `slots.inject` on an undeclared slot name, `slots.register` on a key
		 * another entry already holds — and all of this plugin's registrations share
		 * one `apply()`, so an unguarded throw aborts everything after it: the tool
		 * row and the receiver's card would disappear together with the failure of
		 * whatever threw first.
		 *
		 * @param name - the SLOT name, passed to `slots.inject` verbatim.
		 * @param label - how the console line names this entry; two entries share
		 *   the `conversation.chat.node` slot, so the key has to be in it for the
		 *   line to say which row was lost.
		 * @param consequence - what the caller loses when this entry cannot be
		 *   mounted. Defaults to the row-renderer fallback; a slot with no fallback
		 *   (the sidebar entry, whose absence is simply an absence) passes its own.
		 */
		function guardedSlot(ctx, name, label, register, consequence) {
			const lost = consequence === undefined ? "that row falls back to the generic renderer (the other slots are unaffected)" : consequence;
			try {
				ctx.slots.inject(name, function () {
					try {
						return register();
					} catch (error) {
						reportDegrade(label, lost, error);
						return undefined;
					}
				});
			} catch (error) {
				reportDegrade(label, lost, error);
			}
		}

		/**
		 * Register D's Definition through the `uiConversation` face — DYNAMICALLY,
		 * with `ctx.inject`, so the service is not a hard dependency of this half
		 * (差异审计 F3). The client context does have cordis's `ctx.inject`
		 * (`cordis/lib/index.js:743` mixes the `registry` mixin — `inject`/`plugin`
		 * — into every Context, so it is not itself an injected service; and
		 * `Context.inject(deps, callback)` at `:1599` starts the callback as a
		 * nested plugin whose `inject` map gates it: with the service absent the
		 * callback simply never runs, and nothing throws). First-party client
		 * plugins use exactly this shape for an optional service
		 * (`dsh-client-ui-conversation/lib/client.js:16794`,
		 * `ctx.inject(["commandUi"], (scope) => …)`), while `uiConversation` itself
		 * stays a MODULE-level dependency in the packages that cannot render
		 * without it (`dsh-client-ui-plan`, `…-deliverables`, `…-goal`,
		 * `…-workflow-run`). Three failure modes are all "no top-level row", never
		 * a broken session (§10.1.5 降级优先): the service is absent (an older
		 * shell), the registry rejects the definition, or the context cannot inject
		 * at all. The trace is one console line — the browser console is not the
		 * session log, so no event of any kind is written.
		 *
		 * With the service already provided, `ctx.inject` runs this callback
		 * synchronously (`Fiber` constructor → `_refresh()` → `_setEpoch` →
		 * `_updateState`, `cordis/lib/index.js:1097-1099`), which is why the caller
		 * can still rely on "the definition is registered before its view": the
		 * `conversation.chat.node` entry for D is registered after this call
		 * returns.
		 */
		function registerSendNode(ctx) {
			const consequence = "the top-level message card stays off (the tool row is unaffected)";
			try {
				if (typeof ctx.inject !== "function") return;
				ctx.inject(["uiConversation"], function (scoped) {
					try {
						var service = scoped === null || scoped === undefined ? undefined : scoped.uiConversation;
						var events = service === null || service === undefined ? undefined : service.events;
						if (events === undefined || typeof events.register !== "function") return undefined;
						return events.register(sendNodeDefinition);
					} catch (error) {
						reportDegrade("uiConversation.events.register", consequence, error);
						return undefined;
					}
				});
			} catch (error) {
				reportDegrade("uiConversation injection", consequence, error);
			}
		}

		/**
		 * §10.2.8.3 通道 1 的渲染器：命令名、人真正敲进去的那一行、以及**结果正文** ——
		 * 成功与失败都渲染（这正是缺陷② 的范围：看不到结果时，成功与失败在体验上是同一
		 * 件事）。节点坏掉只渲染 null，不抛。
		 */
		function TeamSessionCommandCard(props) {
			// The WHOLE body is guarded: a node whose accessors throw (a hand-edited payload,
			// another implementation's shape) must render NOTHING instead of throwing into
			// React — §10.1.5's 「客户端失败不得影响会话」.
			try {
				var node = props.node;
				var data = node === null || node === undefined ? undefined : node.data;
				if (data === null || data === undefined || data.kind !== TEAM_SESSION_NODE_KIND) return null;
				return teamSessionCardTree(props, data);
			} catch (e) {
				return null;
			}
		}

		/** The card tree itself, split out so the guard above wraps EVERY read. */
		function teamSessionCardTree(props, data) {
			var t = typeof props.t === "function" ? props.t : function (key) { return key; };
			var outcome = data.outcome === null || data.outcome === undefined ? null : data.outcome;
			var state = outcome === null ? "running" : outcome.kind === "error" ? "error" : "ok";
			var label = outcome === null ? t("teamSessionRunning") : outcome.kind === "error" ? t("teamSessionFailed") : t("teamSessionDone");
			var text = outcome === null || typeof outcome.text !== "string" ? "" : wellFormed(outcome.text);
			var args = previewArgs(data.args);
			return React.createElement("div", {
				className: "dshsl-relay dshsl-ts",
				"data-slp-team-session": state
			},
			React.createElement("div", { className: "dshsl-relay-head" },
			React.createElement("span", null, "/" + TEAM_SESSION_COMMAND),
			args === "" ? null : React.createElement("span", { className: "dshsl-ts-args", title: wellFormed(String(data.args === undefined ? "" : data.args)) }, wellFormed(args)),
			React.createElement("span", { className: "dshsl-relay-when" }, label)),
			text === "" ? null : React.createElement("div", { className: "dshsl-relay-body" }, text));
		}

		/**
		 * 通道 1 的 Definition 走 uiConversation 面的**动态**注册（与
		 * {@link registerSendNode} 同形、同理由：差异审计 F3 —— uiConversation 不是模块级
		 * 依赖）。失败模式一律只是「这一行不渲染」，绝不炸会话；留痕是浏览器 console 的
		 * 一行（浏览器 console 不是会话日志，§10.3 红线不变）。
		 */
		function registerTeamSessionNode(ctx) {
			const consequence = "the /team_session result row stays off (every other face is unaffected)";
			try {
				if (typeof ctx.inject !== "function") return;
				ctx.inject(["uiConversation"], function (scoped) {
					try {
						var service = scoped === null || scoped === undefined ? undefined : scoped.uiConversation;
						var events = service === null || service === undefined ? undefined : service.events;
						if (events === undefined || typeof events.register !== "function") return undefined;
						return events.register(teamSessionDefinition);
					} catch (error) {
						reportDegrade("uiConversation.events.register (team_session)", consequence, error);
						return undefined;
					}
				});
			} catch (error) {
				reportDegrade("uiConversation injection (team_session)", consequence, error);
			}
		}

		// --- §10.2.8.3 通道 1: the §10.2 ② command's RESULT as a top-level node ----
		// 缺陷② 是「命令失败了界面上什么都看不到」：command/run 与 command/done 是
		// LOG-ONLY 事件（不进模型面），它们的落点只在发命令的输入框里。§10.2.8.3 规定按
		// 通道优先级取**可用的第一条**——通道 1（复用 D 模式）**经核实可用**，所以这里
		// 就是它，不降级。四条核实（源码级，逐条可复核）：
		//   ① 注册形状：uiConversation.events.register 按 definition.kind 唯一认领
		//      （dsh-client-ui-conversation/lib/client.js:2302 只拒**同 kind**），所以一个新的
		//      kind 与 chat 包自带的 kind:"command" 并存不冲突；
		//   ② 事件可达：引擎对**每个**输入事件调用**所有** definition 的 match
		//      （同包 :1847-1864），上下文按 (kind, id) 分键（:1885），而 command/run 与
		//      command/done 都在已知词表里（dsh-api-session-controller/lib/client.js:145-146），
		//      输入源不按事件类型过滤（同包 :1626-1673）；
		//   ③ 不进模型上下文：两者都是 log-only（dsh-commands execute() 的直写日志，
		//      其 README：「The command lifecycle stays out of model history」）；
		//   ④ 不新增任何日志事件类型（§10.3 红线）：本节点只**读**既有的事件。
		//
		// 归属（如实标注）：壳可能本来就画出那一行 —— chat 包自己也注册了一个
		// kind:"command" 的 definition（dsh-client-ui-chat/lib/client.js:5856）并为它注册了
		// 「command」chat 节点（:3743-3751、:5905）。本插件无法查询「壳渲染了什么」，所以按
		// 设计实现通道 1 自带的顶层节点（命令名 + 入参 + **结果正文**），并把「可能与壳的
		// 通用行并存」记为本条的实机观察项。
		var TEAM_SESSION_NODE_KIND = "team-link-team-session";
		var TEAM_SESSION_ARGS_PREVIEW = 120;
		/** commandIds this client saw a team_session command/run for. It is the ONLY way a
		 * command/done can be attributed: that event carries no `name` (dsh-commands writes
		 * commandId / kind / text only), so claiming EVERY done would build a Context for
		 * every command in every session. Bounded, and replay-safe: the engine feeds events
		 * in seq order, so the run is always seen before its done (a window that starts
		 * mid-command claims nothing — honest degradation). */
		var teamSessionRuns = [];
		function noteTeamSessionRun(commandId) {
			if (teamSessionRuns.indexOf(commandId) !== -1) return;
			teamSessionRuns.push(commandId);
			if (teamSessionRuns.length > 64) teamSessionRuns.shift();
		}
		/** The commandId of a command lifecycle event, or null. */
		function commandIdOf(event) {
			const data = eventData(event);
			const id = data === null ? undefined : data.commandId;
			return typeof id === "string" && id !== "" ? id : null;
		}
		/** One bounded single line of the raw input a human typed — the ONLY identity the
		 * client can trust here: re-parsing our host grammar in the browser would be a
		 * second implementation of it. */
		function previewArgs(text) {
			const flat = String(text === undefined || text === null ? "" : text).replace(/\s+/gu, " ").trim();
			const chars = [...flat];
			return chars.length <= TEAM_SESSION_ARGS_PREVIEW ? flat : chars.slice(0, TEAM_SESSION_ARGS_PREVIEW - 1).join("") + "…";
		}
		/** §10.2 ② 的结果节点 —— 见上方块注释（成功与失败走同一个 Definition）。 */
		var teamSessionDefinition = {
			kind: TEAM_SESSION_NODE_KIND,
			target: "chat",
			match: function (event) {
				try {
					if (event === null || typeof event !== "object") return null;
					if (event.type === "command/run") {
						const data = eventData(event);
						if (data === null || data.name !== TEAM_SESSION_COMMAND) return null;
						const id = commandIdOf(event);
						if (id === null) return null;
						noteTeamSessionRun(id);
						return { id: id, role: "start" };
					}
					if (event.type === "command/done") {
						const id = commandIdOf(event);
						return id !== null && teamSessionRuns.indexOf(id) !== -1 ? { id: id, role: "update" } : null;
					}
					return null;
				} catch (e) {
					return null;
				}
			},
			start: function (_context, match) {
				const event = match === null || match === undefined ? undefined : match.event;
				const data = eventData(event);
				return {
					commandId: commandIdOf(event),
					seq: eventSeq(event),
					time: eventTime(event),
					args: data === null || typeof data.args !== "string" ? "" : data.args,
					outcome: null
				};
			},
			update: function (context, match) {
				const event = match === null || match === undefined ? undefined : match.event;
				const data = eventData(event);
				const previous = context !== null && context !== undefined && context.state !== null && typeof context.state === "object" ? context.state : {};
				return {
					commandId: commandIdOf(event),
					seq: previous.seq === undefined ? eventSeq(event) : previous.seq,
					time: previous.time === undefined ? eventTime(event) : previous.time,
					args: typeof previous.args === "string" ? previous.args : "",
					outcome: data === null ? null : { kind: typeof data.kind === "string" ? data.kind : "success", text: typeof data.text === "string" ? data.text : "" }
				};
			},
			/** A node whose state is unreadable renders NOTHING and never throws: §10.1.5's
			 * 「客户端失败不得影响会话」 holds for this node as well. */
			buildViewNode: function (context) {
				try {
					const state = context !== null && context !== undefined && context.state !== null && typeof context.state === "object" ? context.state : null;
					if (state === null) return null;
					const start = context.start === null || context.start === undefined ? null : context.start;
					const startEvent = start === null ? null : start.event;
					const first = Array.isArray(context.matches) && context.matches.length > 0 ? context.matches[0] : undefined;
					const anchor = startEvent !== null ? eventSeq(startEvent) : state.seq !== undefined ? state.seq : first !== undefined && first !== null ? eventSeq(first.event) : 0;
					const location = start !== null && start.location !== undefined ? start.location : first !== undefined && first !== null && first.location !== undefined ? first.location : { kind: "unresolved" };
					return {
						key: context.key,
						kind: TEAM_SESSION_NODE_KIND,
						id: context.id,
						target: "chat",
						anchorSeq: anchor,
						location: location,
						visibility: "visible",
						data: {
							kind: TEAM_SESSION_NODE_KIND,
							commandId: state.commandId,
							at: state.time,
							args: state.args,
							outcome: state.outcome
						}
					};
				} catch (e) {
					return null;
				}
			}
		};

		/** Build the relay card renderer bound to one plugin context. */
		function makeRelayCardView(ctx) {
			return function RelayCardView(props) {
				var node = props.node;
				var data = node && node.data;
				var source = data && data.source;
				var blocks = Array.isArray(data && data.content) ? data.content : [];
				var text = blocks.filter(function (b) { return b && b.type === "text" && typeof b.text === "string"; }).map(function (b) { return b.text; }).join("\n");
				// The durable message id lives on the chat node itself (`node.id`); the
				// context node's `data` carries seq/time/content/source and no id.
				var relayId = node !== null && node !== undefined && typeof node.id === "string" ? node.id
					: data !== null && data !== undefined && typeof data.id === "string" ? data.id : undefined;
				// Cross-session relays are published as `{kind: "agent-message", form: "relay",
				// senderSessionId}` — the only shape the DSH 0.1.5 session-format migration
				// admits. Upstream emits that SAME shape for adjacent-agent messages (bare-UUID
				// ids, body `Agent <id> sent a message: …`), so kind + form alone would dress
				// foreign messages as our cards. Two signals identify our own deliveries — the
				// `slp-` id the host half mints, and the banner it writes — and either one
				// suffices, so an id-less (or unusually-ided) render path still gets its card.
				// The legacy `kind: "team-link"` stays recognized: history written
				// before the change carries it, together with the `sentAt` the card reads.
				var isOwnRelay = (relayId !== undefined && relayId.indexOf("slp-") === 0) || hasRelayBanner(text);
				var isPublishedRelay = source !== undefined && source !== null &&
					source.kind === "agent-message" && source.form === "relay" && isOwnRelay;
				var isRelaySource = source !== undefined && source !== null &&
					(source.kind === "team-link" || isPublishedRelay);
				if (!isRelaySource) {
					return delegateContextNode(ctx, props);
				}
				var t = typeof props.t === "function" ? props.t : function (key) { return key; };
				var senderId = typeof source.senderSessionId === "string" && source.senderSessionId !== "" ? source.senderSessionId : source.fromSession;
				// Old rows carried `sentAt`; the published shape has no room for it, so the
				// card falls back to the durable event time the context node already has,
				// and finally to the stamp the host half writes into the banner.
				var legacy = typeof source.sentAt === "string" ? new Date(source.sentAt) : null;
				var stamped = data !== null && data !== undefined && typeof data.time === "number" && isFinite(data.time) ? new Date(data.time) : null;
				var whenText = legacy !== null && !isNaN(legacy.valueOf()) ? legacy.toLocaleString()
					: stamped !== null && !isNaN(stamped.valueOf()) ? stamped.toLocaleString()
						: relayStampOf(text);
				return React.createElement("div", { className: "dshsl-relay", "data-slp-relay": "true" },
					React.createElement("div", { className: "dshsl-relay-head" },
						"📡 ",
						t("relayTitle"),
						senderId !== undefined && senderId !== null ? React.createElement("span", { className: "dshsl-relay-sender", title: wellFormed(String(senderId)) }, "来自 " + wellFormed(shortSessionId(senderId))) : null,
						whenText !== "" ? React.createElement("span", { className: "dshsl-relay-when" }, whenText) : null),
					React.createElement("div", { className: "dshsl-relay-body" }, wellFormed(stripRelayWrapper(text)) || t("relayEmpty")),
					React.createElement("div", { className: "dshsl-relay-foot" }, t("relayReply")));
			};
		}

		// ---------------------------------------------------------------------
		// §4.3 sidebar「会话工具」(session tools) — the entry at the sidebar foot.
		// The design doc (docs/hardening-and-recovery-design-2026-09-21.md §4.3)
		// is the SINGLE source of truth for this UI; the §4.4 deep-link fix lives
		// in `openDeepLinkedSession` above.
		// ---------------------------------------------------------------------
		//
		// The official session-row「…」menu has no extension slot and lives in a
		// built artifact (design §2.3), so "copy this session's deep link" and
		// "export this session" for ANY session ride the one slot the sidebar
		// already declares for arbitrary plugins: `sidebar.footer.action` (list
		// kind, root scope, owner props exactly `{wide}`). `order: 0` sorts this entry
		// AFTER the usage card (`order: -10`) — and "after" means to its RIGHT inside
		// the SAME flex row, never below it: list entries render in ascending `order`,
		// and the official `.footerActions` is a `display:flex` row that never wraps
		// (no `flex-wrap` anywhere in the sidebar package), while a child cannot change
		// its parent's wrapping (design §4.3.1, corrected against the 2026-09-21 owner
		// screenshot). 【设置】 is the one that sits below: the shell renders this
		// slot's row before the settings seat.
		//
		// Two design facts shape the rest:
		//  1. the rail is 56px wide, so an anchored panel would be clipped: the list
		//     lives in the official, body-portaled `Modal` instead (§4.3.2);
		//  2. `workspaces` / `uiWorkspace` are NOT module-level dependencies — a
		//     shell without them loses THIS entry and nothing else, and says so in
		//     exactly one console line (§4.3.5/§4.3.6, N1).
		
		var SESSION_TOOLS_SLOT = "sidebar.footer.action";
		var SESSION_TOOLS_ID = "team-link-session-tools";
		var SESSION_TOOLS_ORDER = 0;
		/** Display cap of the dialog's list. §4.3.6 (N6): a bounded presentation has
		 * to SAY that it is bounded — the trailing
		 * 「共 N 个，仅显示前 M 个（搜索可收窄）」 line is what pays for this number. */
		var SESSION_TOOLS_LIMIT = 50;
		
		/** The shell SEED module of pure atoms. §4.3.5: deliberately NOT declared in
		 * `dsh.client.inject` — it is seeded beside react (a replacing package such
		 * as dsh-better-sidebar requires it while declaring nothing). Loaded lazily
		 * and guarded, so a shell without it costs this entry alone instead of
		 * throwing out of `apply()` and taking every other face down. */
		function loadSessionToolsPrimitives(require) {
			try {
				return typeof require === "function" ? require("@deepseek-ai/dsh-client-ui-primitives") : null;
			} catch (error) {
				return null;
			}
		}
		
		/** One console line when this entry is not registered (§4.3.6: a missing
		 * service is a trace, never a button that does nothing). Deliberately
		 * one-shot: the same absence is checked twice (the immediate read and the
		 * late completion), and one window owes one line. */
		function warnSessionToolsGaps(gaps) {
			try {
				if (typeof console !== "undefined" && console !== null && typeof console.warn === "function") {
					console.warn("[dsh-team-link] " + SESSION_TOOLS_SLOT + " entry NOT registered — missing " + gaps.join(", ") + " (every other face of this plugin is unaffected)");
				}
			} catch (e) {
				/* a console that itself throws must not matter either */
			}
		}
		
		/** Read one service off a context. `ctx.get` only returns a provider that is
		 * already active (README §七), so "absent here" means "not yet";
		 * `registerSessionTools` rides the optional-service seam for the late case. */
		function sessionToolsRead(holder, name) {
			try {
				return holder === null || holder === undefined || typeof holder.get !== "function" ? undefined : holder.get(name);
			} catch (error) {
				return undefined;
			}
		}
		
		/** The three services this entry renders from (§4.3.5). */
		function sessionToolsScopeOf(holder) {
			return {
				sessions: sessionToolsRead(holder, "sessions"),
				workspaces: sessionToolsRead(holder, "workspaces"),
				uiWorkspace: sessionToolsRead(holder, "uiWorkspace"),
			};
		}
		
		/** §4.3.5's runtime optionality, as a list of what is missing. `Modal` is
		 * part of the same judgement: without it there is no dialog, and §4.3.6's
		 * rule ("no fake button") applies to it exactly as it does to a service. */
		function sessionToolsGaps(scope, primitives) {
			var gaps = [];
			if (primitives === null || primitives === undefined || typeof primitives.Modal !== "function") gaps.push("ui-primitives(Modal)");
			if (scope === null || scope === undefined) return ["sessions", "workspaces", "uiWorkspace"].concat(gaps);
			var sessions = scope.sessions;
			if (sessions === null || sessions === undefined || sessions.list === null || sessions.list === undefined || typeof sessions.list.getSnapshot !== "function") gaps.push("sessions");
			var workspaces = scope.workspaces;
			if (workspaces === null || workspaces === undefined || workspaces.list === null || workspaces.list === undefined || typeof workspaces.list.getSnapshot !== "function") gaps.push("workspaces");
			var navigation = scope.uiWorkspace;
			if (navigation === null || navigation === undefined || typeof navigation.openSession !== "function") gaps.push("uiWorkspace");
			return gaps;
		}
		
		/** One snapshot read that never throws: a service that dies mid-render must
		 * not take the session down with it. */
		function readSnapshot(source) {
			try {
				return source === null || source === undefined || typeof source.getSnapshot !== "function" ? null : source.getSnapshot();
			} catch (error) {
				return null;
			}
		}
		
		/** Read a bare observable source with the pull model. The subscribing hook
		 * is the one this shell ships (the renderer uses it the same way); a shell
		 * without it still renders from a single read instead of not rendering. */
		function useSnapshot(source) {
			if (source !== null && source !== undefined && typeof React.useSyncExternalStore === "function" && typeof source.subscribe === "function" && typeof source.getSnapshot === "function") {
				return React.useSyncExternalStore(function (notify) {
					try {
						return source.subscribe(notify);
					} catch (error) {
						/* a source that refuses to be observed costs freshness, not the dialog */
						return function () {};
					}
				}, function () {
					// Through the total read: a service that dies mid-flight must read as
					// "not read yet", never as an empty list (and never as a crash).
					return readSnapshot(source);
				}, function () {
					return null;
				});
			}
			return readSnapshot(source);
		}
		
		/** The session the main view still retains — the official「current session」
		 * convention (§4.3.2). There is no public getter: ui-workspace reads
		 * `retainedBy.mainView` the same way (its `mainSessionId`). */
		function currentSessionIdOf(list) {
			if (list === null || list === undefined || list.byId === undefined || list.byId === null) return undefined;
			var ids = sessionRowIds(list);
			for (var i = 0; i < ids.length; i += 1) {
				var row = list.byId[ids[i]];
				if (row !== undefined && row !== null && row.retainedBy !== undefined && row.retainedBy !== null && (row.retainedBy.mainView || 0) > 0) return ids[i];
			}
			return undefined;
		}
		
		/** Every known session id: the host list order first, then any row that only
		 * exists locally (a live Client generation can be catalogued before the host
		 * list echoes it). */
		function sessionRowIds(list) {
			var ids = [];
			var seen = {};
			var i;
			if (Array.isArray(list.ids)) {
				for (i = 0; i < list.ids.length; i += 1) {
					if (typeof list.ids[i] === "string" && seen[list.ids[i]] !== true) {
						seen[list.ids[i]] = true;
						ids.push(list.ids[i]);
					}
				}
			}
			var keys = list.byId === null || list.byId === undefined ? [] : Object.keys(list.byId);
			for (i = 0; i < keys.length; i += 1) {
				if (seen[keys[i]] !== true) {
					seen[keys[i]] = true;
					ids.push(keys[i]);
				}
			}
			return ids;
		}
		
		/** The workspace the current session belongs to — §4.3.2's default range.
		 * Membership first (the official grouping rule), then the path the row
		 * carries; null when neither identifies one. */
		function currentWorkspaceOf(workspaceState, list, currentId) {
			var items = workspaceState !== null && workspaceState !== undefined && Array.isArray(workspaceState.items) ? workspaceState.items : [];
			if (currentId !== undefined) {
				var i;
				for (i = 0; i < items.length; i += 1) {
					if (Array.isArray(items[i].sessionIds) && items[i].sessionIds.indexOf(currentId) !== -1) return items[i];
				}
				var row = list !== null && list !== undefined && list.byId !== undefined && list.byId !== null ? list.byId[currentId] : undefined;
				var cwd = row !== undefined && row !== null && typeof row.cwd === "string" ? row.cwd : "";
				if (cwd !== "") {
					for (i = 0; i < items.length; i += 1) {
						if (items[i].path === cwd) return items[i];
					}
				}
			}
			return null;
		}
		
		/** True when one row belongs to a workspace: membership first, the
		 * comparable path second — the two signals the official browser groups by. */
		function sessionInWorkspace(workspace, row, id) {
			if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.indexOf(id) !== -1) return true;
			var cwd = typeof row.cwd === "string" ? row.cwd : "";
			return cwd !== "" && typeof workspace.path === "string" && cwd === workspace.path;
		}
		
		/** The workspace label of one row, or "" when it has none — only the
		 * 「全部工作区」 range renders it, where rows would otherwise be
		 * indistinguishable. */
		function workspaceTitleOf(items, row, id) {
			var cwd = typeof row.cwd === "string" ? row.cwd : "";
			var i;
			for (i = 0; i < items.length; i += 1) {
				if (Array.isArray(items[i].sessionIds) && items[i].sessionIds.indexOf(id) !== -1) return workspaceLabelOf(items[i]);
			}
			for (i = 0; i < items.length; i += 1) {
				if (cwd !== "" && items[i].path === cwd) return workspaceLabelOf(items[i]);
			}
			return "";
		}
		
		function workspaceLabelOf(workspace) {
			var title = workspace === null || workspace === undefined ? undefined : workspace.title;
			if (typeof title === "string" && title !== "") return title;
			return workspace !== null && workspace !== undefined && typeof workspace.path === "string" ? workspace.path : "";
		}
		
		/** Flatten one `SessionSummary` into the row the view renders (pure). */
		function sessionRowOf(id, row, workspaceTitle) {
			var title = "";
			if (typeof row.displayTitle === "string" && row.displayTitle !== "") title = row.displayTitle;
			else if (typeof row.title === "string" && row.title !== "") title = row.title;
			else title = String(id);
			return {
				id: String(id),
				title: wellFormed(title),
				updatedAt: typeof row.updatedAt === "number" && isFinite(row.updatedAt) ? row.updatedAt : 0,
				running: row.running === true,
				cwd: typeof row.cwd === "string" ? row.cwd : "",
				workspaceTitle: workspaceTitle,
			};
		}
		
		/**
		 * §4.3.2's visibility rule and ordering, as a pure function — the whole
		 * selection rule lives here, so the dialog only renders what it is handed.
		 * The official session browser's rule (`sessionVisible`, ui-workspace
		 * client.js) drops subagent children and archived sessions and keeps a blank
		 * row only when it IS the current one; this panel adds its own clause on top
		 * (owner 裁定 ③, design §4.3.2): **the CURRENT session is dropped too**,
		 * because the panel's purpose is the OTHER sessions — the current one's copy
		 * and export already sit on the conversation header, and listing it would make
		 * 「暂无其他会话」 contradict what the list shows. Ordering is `updatedAt`
		 * descending with the id as the deterministic tie-break (its `orderByRecency`).
		 */
		function visibleSessionRows(list, workspaceState, currentId, range) {
			if (list === null || list === undefined || list.byId === undefined || list.byId === null) return [];
			var archivedIds = workspaceState !== null && workspaceState !== undefined && Array.isArray(workspaceState.archivedSessionIds) ? workspaceState.archivedSessionIds : [];
			var items = workspaceState !== null && workspaceState !== undefined && Array.isArray(workspaceState.items) ? workspaceState.items : [];
			var workspace = range === "workspace" ? currentWorkspaceOf(workspaceState, list, currentId) : null;
			var byId = list.byId;
			var ids = sessionRowIds(list);
			var rows = [];
			for (var i = 0; i < ids.length; i += 1) {
				var id = ids[i];
				var row = byId[id];
				if (row === undefined || row === null) continue;
				if (row.origin === "subagent") continue;
				if (archivedIds.indexOf(id) !== -1) continue;
				// 差异审计第 7 条 / owner 裁定 ③ (§4.3.2): this panel is about the OTHER
				// sessions. Dropping the current one makes the official 「a blank row survives
				// only when it IS the current one」 clause degenerate into 「every blank row is
				// dropped」 — that is stated here rather than left as a silent consequence,
				// and the empty-state sentence below then tells the truth about this list.
				if (id === currentId) continue;
				if (row.blank === true) continue;
				if (workspace !== null && !sessionInWorkspace(workspace, row, id)) continue;
				rows.push(sessionRowOf(id, row, workspaceTitleOf(items, row, id)));
			}
			rows.sort(function (a, b) {
				if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
				return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
			});
			return rows;
		}
		
		/** §4.3.2's search: case-insensitive over the title and the id. */
		function filterSessionRows(rows, query) {
			var needle = String(query === null || query === undefined ? "" : query).trim().toLowerCase();
			if (needle === "") return rows;
			return rows.filter(function (row) {
				return row.title.toLowerCase().indexOf(needle) !== -1 || row.id.toLowerCase().indexOf(needle) !== -1;
			});
		}
		
		/**
		 * §4.3.6 + N7: the three emptinesses are three DIFFERENT sentences, and
		 * this pure function decides which one is true.
		 *
		 * `base` is the row count of the selected range BEFORE the search runs: a
		 * search that matches nothing is a different fact from "there is no other
		 * session to show", and printing one sentence for both is exactly the
		 * confusion N7 exists to prevent. Loading wins over both — a list that has
		 * not been read must never be reported as an empty one.
		 */
		function emptySessionToolsState(state) {
			if (state.loading === true) return { key: "sessionToolsLoading", params: {} };
			if (state.shown > 0) return null;
			var query = String(state.query === null || state.query === undefined ? "" : state.query).trim();
			if (query !== "" && state.base > 0) return { key: "sessionToolsNoMatch", params: { query: query } };
			return { key: "sessionToolsNone", params: {} };
		}
		
		/** N6: the bounded-presentation annotation, or null when nothing was cut. */
		function sessionToolsBoundNote(state) {
			if (state.total <= state.shown) return null;
			return { key: "sessionToolsBound", params: { total: state.total, shown: state.shown } };
		}
		
		/**
		 * §4.3.3's status dot: EXACTLY two states, running and idle, both read from
		 * the one public fact `SessionSummary.running`. There is deliberately no
		 * third state: 「无活动代理」(seated-dead) is a HOST-side fact (`agents.get`),
		 * and no client face carries agent liveness — `SessionSummary` has no
		 * liveness field, none of `SessionProjectionMap`'s keys does either, and
		 * this browser half has no cross-half data channel. A third state could only
		 * be invented, so it is not drawn (design §4.3.3; the official sidebar's own
		 * dot carries no liveness either).
		 */
		function sessionDotState(row) {
			return row.running === true ? "running" : "idle";
		}
		
		/** One row's relative time, bucketed by the OFFICIAL helper so two surfaces
		 * dating the same session agree; the words stay in this plugin's dictionary,
		 * which is where the primitives' contract puts them. */
		function relativeTimeText(primitives, at, now, t) {
			if (at > 0 && primitives !== null && primitives !== undefined && typeof primitives.relativeTime === "function") {
				var bucket = primitives.relativeTime(at, now);
				var unit = bucket === null || bucket === undefined ? "" : bucket.unit;
				var n = bucket === null || bucket === undefined ? 0 : bucket.n;
				if (unit === "now") return t("sessionToolsTimeNow");
				if (unit === "minutes") return fillTemplate(t("sessionToolsTimeMinutes"), { n: n });
				if (unit === "hours") return fillTemplate(t("sessionToolsTimeHours"), { n: n });
				if (unit === "days") return fillTemplate(t("sessionToolsTimeDays"), { n: n });
				if (unit === "months") return fillTemplate(t("sessionToolsTimeMonths"), { n: n });
				if (unit === "years") return fillTemplate(t("sessionToolsTimeYears"), { n: n });
			}
			return at > 0 ? new Date(at).toLocaleString() : t("sessionToolsTimeUnknown");
		}
		
		/** The entry's glyph, mirroring 【设置】's rail row EXACTLY: that row renders
		 * `IconSettingsOutline16` at `size: 16` in the wide column and
		 * `IconSettingsOutline14` at `size: 18` in the 56px rail
		 * (`dsh-client-ui-settings-general/lib/client.js:543`, as-of 2026-09-21). So
		 * the 14-glyph drawn at 18px below is DELIBERATE, not a typo to be "fixed"
		 * into 14@14 — unifying them would make this glyph visibly smaller than
		 * 【设置】's in the same rail. A seed module that ships without these icons
		 * falls back to a text glyph — a missing icon must not cost the row. */
		function sessionToolsIcon(primitives, wide) {
			var icon = primitives === null || primitives === undefined ? undefined : primitives[wide ? "IconLinkOutline16" : "IconLinkOutline14"];
			return typeof icon === "function" ? icon : null;
		}
		
		/** The copy/export half of one row, so the row's own render stays readable. */
		function sessionRowActions(props) {
			var t = props.t;
			var row = props.row;
			var copied = props.copied === true;
			var stop = function (event) {
				if (event !== undefined && event !== null && typeof event.stopPropagation === "function") event.stopPropagation();
			};
			return React.createElement("span", { className: "dshsl-st-actions" },
				React.createElement("button", {
					type: "button",
					className: "dshsl-st-act",
					"data-copied": copied ? "true" : "false",
					"aria-label": copied ? fillTemplate(t("sessionToolsCopiedLabel"), { title: row.title }) : fillTemplate(t("sessionToolsCopyLabel"), { title: row.title }),
					title: t("sessionToolsCopy"),
					onClick: function (event) {
						stop(event);
						props.onCopy(row);
					},
				}, copied ? t("sessionToolsCopied") : t("sessionToolsCopy")),
				React.createElement("button", {
					type: "button",
					className: "dshsl-st-act",
					"aria-label": fillTemplate(t("sessionToolsExportLabel"), { title: row.title }),
					title: t("sessionToolsExport"),
					onClick: function (event) {
						stop(event);
						props.onExport(row);
					},
				}, t("sessionToolsExport")));
		}
		
		/**
		 * One session row (§4.3.3): dot + title + relative time form ONE focusable
		 * button, so Tab reaches it and Enter/Space open the session; the two actions
		 * sit BESIDE that button rather than inside it — a button nested in a
		 * `role="button"` row is interactive content inside interactive content. The
		 * row's `:focus-within` gives the same behaviour the design asks for (focus
		 * lands in the row ⇒ the actions appear).
		 */
		function SessionToolsRow(props) {
			var t = props.t;
			var row = props.row;
			var dot = sessionDotState(row);
			return React.createElement("li", { className: "dshsl-st-row", "data-session": row.id, "data-state": dot },
				React.createElement("button", {
					type: "button",
					className: "dshsl-st-open",
					"aria-label": fillTemplate(t("sessionToolsOpenLabel"), { title: row.title }),
					onClick: function () {
						props.onOpen(row);
					},
				},
					React.createElement("span", { className: "dshsl-st-dot", "data-state": dot, "aria-hidden": "true" }),
					React.createElement("span", { className: "dshsl-st-title", title: row.title, "data-running": row.running === true ? "true" : "false" }, row.title),
					React.createElement("span", { className: "dshsl-st-time" }, props.timeText),
					React.createElement("span", { className: "dshsl-st-sr" }, dot === "running" ? t("sessionToolsRunning") : t("sessionToolsIdle"))),
				sessionRowActions({ t: t, row: row, copied: props.copied === true, onCopy: props.onCopy, onExport: props.onExport }));
		}
		
		/**
		 * §4.3.2's dialog, as the official body-portaled `Modal` (a 56px rail would
		 * clip an anchored panel). Everything it renders is derived from the two
		 * snapshots it is handed plus its own query/range, so the three empty states
		 * and the bounded-presentation line are properties of this component, not of
		 * whatever the services happened to return.
		 */
		function makeSessionToolsDialog(scope, primitives) {
			return function SessionToolsDialog(props) {
				var t = typeof props.t === "function" ? props.t : function (key) { return key; };
				var onClose = typeof props.onClose === "function" ? props.onClose : function () {};
				var queryState = React.useState("");
				var query = String(queryState[0] === null || queryState[0] === undefined ? "" : queryState[0]);
				var setQuery = queryState[1];
				var rangeState = React.useState(null);
				var rangeChoice = rangeState[0];
				var setRangeChoice = rangeState[1];
				var copiedState = React.useState(null);
				var copiedId = copiedState[0];
				var setCopiedId = copiedState[1];
				var noteState = React.useState("");
				var note = String(noteState[0] === null || noteState[0] === undefined ? "" : noteState[0]);
				var setNote = noteState[1];
				// §4.3.2's two data sources, read through the subscription this face owns:
				// without it「读取中…」would be the last word once the list arrives.
				var list = useSnapshot(scope.sessions.list);
				var workspaceState = useSnapshot(scope.workspaces.list);
				var currentId = currentSessionIdOf(list);
				// §4.3.2's default range is the CURRENT WORKSPACE. When no workspace can be
				// identified the range falls back to「全部工作区」: filtering by an unknown
				// workspace would print a false「暂无其他会话」, and a false empty is worse
				// than a wider list.
				var autoRange = currentWorkspaceOf(workspaceState, list, currentId) === null ? "all" : "workspace";
				var activeRange = rangeChoice === "workspace" || rangeChoice === "all" ? rangeChoice : autoRange;
				var base = visibleSessionRows(list, workspaceState, currentId, activeRange);
				var matched = filterSessionRows(base, query);
				var shown = matched.slice(0, SESSION_TOOLS_LIMIT);
				var empty = emptySessionToolsState({
					loading: list === null || list.phase !== "ready",
					query: query,
					base: base.length,
					total: matched.length,
					shown: shown.length
				});
				var bound = sessionToolsBoundNote({ total: matched.length, shown: shown.length });
				var now = Date.now();
				
				function openRow(row) {
					var navigation = scope.uiWorkspace;
					try {
						if (navigation === null || navigation === undefined || typeof navigation.openSession !== "function") return;
						navigation.openSession(row.id);
						// The session is the main view now: leaving the dialog over it would hide
						// exactly what was asked for, and closing is what hands focus back to the
						// entry (§4.3.7).
						onClose();
					} catch (error) {
						reportDegrade("uiWorkspace.openSession", "the session was not focused (the dialog stays open)", error);
					}
				}
				
				/** §4.3.4: the SAME link format the conversation-header button copies. */
				function copyRow(row) {
					var link = dshDeepLink(row.id);
					var settled = function (ok) {
						if (ok !== true) return;
						if (typeof setCopiedId === "function") setCopiedId(row.id);
						if (typeof setNote === "function") setNote(fillTemplate(t("sessionToolsCopiedNote"), { link: link }));
						window.setTimeout(function () {
							if (typeof setCopiedId === "function") setCopiedId(null);
						}, 1600);
					};
					try {
						if (typeof primitives.writeClipboard === "function") {
							var written = primitives.writeClipboard(link);
							if (written !== null && written !== undefined && typeof written.then === "function") {
								written.then(settled, function () {
									settled(fallbackCopy(link));
								});
								return;
							}
							settled(written === true);
							return;
						}
					} catch (error) {
						/* fall through to the local fallback below */
					}
					settled(fallbackCopy(link));
				}
				
				/** §4.3.4: NAVIGATE to the host route — same-origin, so the browser's
				 * cookie rides along and the §4.1 fence is met exactly as it is meant to
				 * be; the parameter is encoded. Never fetch+blob: that would add a CORS
				 * face and force credentials to be carried by hand. */
				function exportRow(row) {
					try {
						window.location.href = exportUrl(row.id);
					} catch (error) {
						reportDegrade("export navigation", "the export download did not start", error);
					}
				}
				
				var body = [
					React.createElement("p", { className: "dshsl-st-count" }, fillTemplate(t("sessionToolsCount"), { count: shown.length })),
					React.createElement("input", {
						className: "dshsl-st-search",
						type: "search",
						value: query,
						placeholder: t("sessionToolsSearch"),
						"aria-label": t("sessionToolsSearch"),
						onChange: function (event) {
							var next = event === null || event === undefined || event.target === undefined || event.target === null ? "" : event.target.value;
							if (typeof setQuery === "function") setQuery(String(next === null || next === undefined ? "" : next));
						},
					})
				];
				if (empty !== null) {
					body.push(React.createElement("p", { className: "dshsl-st-empty", "data-empty": empty.key }, fillTemplate(t(empty.key), empty.params)));
				} else {
					body.push(React.createElement("ul", { className: "dshsl-st-list" }, shown.map(function (row) {
						return React.createElement(SessionToolsRow, {
							key: row.id,
							t: t,
							row: row,
							copied: copiedId === row.id,
							timeText: relativeTimeText(primitives, row.updatedAt, now, t) + (activeRange === "all" && row.workspaceTitle !== "" ? " · " + row.workspaceTitle : ""),
							onOpen: openRow,
							onCopy: copyRow,
							onExport: exportRow,
						});
					})));
				}
				if (bound !== null) body.push(React.createElement("p", { className: "dshsl-st-bound", "data-bound": "true" }, fillTemplate(t(bound.key), bound.params)));
				body.push(React.createElement("p", { className: "dshsl-st-live", role: "status", "aria-live": "polite" }, note));
				
				var footer = React.createElement("div", { className: "dshsl-st-foot" },
					React.createElement("span", { className: "dshsl-st-range", role: "group", "aria-label": t("sessionToolsRange") },
						React.createElement("button", { type: "button", "aria-pressed": activeRange === "workspace" ? "true" : "false", onClick: function () {
							if (typeof setRangeChoice === "function") setRangeChoice("workspace");
						} }, t("sessionToolsRangeCurrent")),
						React.createElement("button", { type: "button", "aria-pressed": activeRange === "all" ? "true" : "false", onClick: function () {
							if (typeof setRangeChoice === "function") setRangeChoice("all");
						} }, t("sessionToolsRangeAll"))),
					React.createElement("button", { type: "button", className: "dshsl-st-close", onClick: function () {
						onClose();
					} }, t("sessionToolsClose")));
				
				return React.createElement(primitives.Modal, {
					open: true,
					onClose: onClose,
					title: t("sessionTools"),
					description: t("sessionToolsDescription"),
					closeLabel: t("sessionToolsClose"),
					contentClassName: "dshsl-st",
					footer: footer,
				}, body);
			};
		}
		
		/**
		 * The entry itself (§4.3.1): the wide column renders the glyph plus its label
		 * — the same visual language as 【设置】 — while the 56px rail renders the glyph
		 * alone with the label moved to `aria-label`/`title`. Click, Enter and Space
		 * all open the dialog: a real `<button>` gives the keyboard half for free.
		 */
		function makeSessionToolsEntry(scope, primitives) {
			var Dialog = makeSessionToolsDialog(scope, primitives);
			return function SessionToolsEntry(props) {
				var wide = props.wide === true;
				var t = typeof props.t === "function" ? props.t : function (key) { return key; };
				var openState = React.useState(false);
				var opened = openState[0] === true;
				var setOpened = openState[1];
				var button = typeof React.useRef === "function" ? React.useRef(null) : { current: null };
				var label = t("sessionTools");
				var Icon = sessionToolsIcon(primitives, wide);
				
				/** §4.3.7: closing (Esc, the close button, or an open that succeeded)
				 * hands focus back to the entry that owns the dialog. */
				function close() {
					if (typeof setOpened === "function") setOpened(false);
					var node = button === null || button === undefined ? null : button.current;
					if (node !== null && node !== undefined && typeof node.focus === "function") {
						try {
							node.focus();
						} catch (error) {
							/* returning focus is best-effort */
						}
					}
				}
				
				return React.createElement(React.Fragment, null,
					React.createElement("button", {
						type: "button",
						className: "dshsl-st-entry",
						"data-wide": wide ? "true" : "false",
						title: label,
						"aria-label": label,
						"aria-haspopup": "dialog",
						"aria-expanded": opened ? "true" : "false",
						ref: button,
						onClick: function () {
							if (typeof setOpened === "function") setOpened(!opened);
						},
					},
						Icon === null
							? React.createElement("span", { className: "dshsl-st-glyph", "aria-hidden": "true" }, "\uD83D\uDD17")
							: React.createElement(Icon, { size: wide ? 16 : 18 }),
						wide ? React.createElement("span", { className: "dshsl-st-label" }, label) : null),
					opened ? React.createElement(Dialog, { t: t, onClose: close }) : null);
			};
		}
		
		/**
		 * §4.3.5's runtime optionality, both halves of it: `ctx.inject` for the
		 * services (cordis starts the callback as a nested plugin whose inject map
		 * gates it, so the entry appears the moment all three are there, in any
		 * order) and ONE honest console line when they are not (§4.3.6). The
		 * immediate read is what makes that line possible at all: a callback whose
		 * dependencies are unmet simply never runs, so `ctx.inject` alone could
		 * never report the absence the design requires.
		 */
		function registerSessionTools(ctx, require) {
			var primitives = loadSessionToolsPrimitives(require);
			var warned = false;
			var consequence = "the「会话工具」entry is not mounted (every other face of this plugin is unaffected)";
			var attempt = function (scope) {
				var gaps = sessionToolsGaps(scope, primitives);
				if (gaps.length > 0) {
					if (!warned) {
						warned = true;
						warnSessionToolsGaps(gaps);
					}
					return false;
				}
				guardedSlot(ctx, SESSION_TOOLS_SLOT, SESSION_TOOLS_SLOT + " (" + SESSION_TOOLS_ID + ")", function () {
					return ctx.slots.register({
						name: SESSION_TOOLS_SLOT,
						id: SESSION_TOOLS_ID,
						order: SESSION_TOOLS_ORDER,
						locale: "dsh-team-link"
					}, makeSessionToolsEntry(scope, primitives));
				}, consequence);
				return true;
			};
			if (attempt(sessionToolsScopeOf(ctx))) return;
			try {
				if (typeof ctx.inject !== "function") return;
				ctx.inject(["sessions", "workspaces", "uiWorkspace"], function (scoped) {
					attempt(sessionToolsScopeOf(scoped));
				});
			} catch (error) {
				reportDegrade("sidebar.footer.action injection", consequence, error);
			}
		}
		
		// --- plugin ---
		function apply(ctx) {
			ctx.effect(() => {
				const disposeEn = ctx.locale.register("dsh-team-link", "en", {
					copyLink: "Copy session link",
					copied: "Link copied",
					exportSession: "Export session (markdown)",
					relayTitle: "Cross-session message",
					relayEmpty: "(empty)",
					relayReply: "Reply with the team_link_send tool",
					sendTitle: "Sent cross-session message",
					sendTruncated: "(body truncated, {chars} code points originally)",
					sendRowTargets: "{count} targets",
					sendRowsTruncated: "(truncated — showing the first {shown} rows)",
					sendSummary: "Summary: {delivered} delivered / {refused} refused / {noAgent} no agent / {noHolder} vacant",
					sendDeduped: "{deduped} duplicates dropped",
					sendBusyBadge: "busy · {minutes} min in",
					sendBusyBadgeUnknown: "busy",
					sendResultDelivered: "delivered",
					sendResultRefused: "not delivered — refused by the receiver",
					sendResultNoAgent: "not delivered — the target session has no live agent",
					sendResultNoHolder: "not delivered — the role is vacant",
					sendPlainTitle: "Tool call",
					teamSessionRunning: "running…",
					teamSessionDone: "done",
					teamSessionFailed: "failed",
					sendPlainRunning: "running…",
					sendPlainSettled: "no structured receipt — showing the model-visible result",
					sessionTools: "Session tools",
					sessionToolsDescription: "Copy a session's deep link, export it as markdown, or open it. Reading, copying and exporting only — no renaming, forking or archiving.",
					sessionToolsSearch: "Search sessions",
					sessionToolsCount: "{count} sessions",
					sessionToolsLoading: "Reading…",
					sessionToolsNoMatch: "No session matches “{query}”",
					sessionToolsNone: "No other sessions",
					sessionToolsBound: "{total} in total, showing the first {shown} (narrow it with the search)",
					sessionToolsRange: "Range",
					sessionToolsRangeCurrent: "Current workspace",
					sessionToolsRangeAll: "All workspaces",
					sessionToolsClose: "Close",
					sessionToolsCopy: "Copy link",
					sessionToolsCopied: "Copied ✓",
					sessionToolsCopiedNote: "Copied {link}",
					sessionToolsCopyLabel: "Copy the session link for “{title}”",
					sessionToolsCopiedLabel: "Copied the session link for “{title}”",
					sessionToolsExport: "Export session",
					sessionToolsExportLabel: "Export “{title}” as markdown",
					sessionToolsOpenLabel: "Open session “{title}”",
					sessionToolsRunning: "Running",
					sessionToolsIdle: "Idle",
					sessionToolsTimeNow: "now",
					sessionToolsTimeMinutes: "{n}min",
					sessionToolsTimeHours: "{n}h",
					sessionToolsTimeDays: "{n}d",
					sessionToolsTimeMonths: "{n}mo",
					sessionToolsTimeYears: "{n}y",
					sessionToolsTimeUnknown: "time unknown"
				});
				const disposeZh = ctx.locale.register("dsh-team-link", "zh", {
					copyLink: "复制会话链接",
					copied: "已复制链接",
					exportSession: "导出会话（markdown）",
					relayTitle: "跨会话消息",
					relayEmpty: "（空）",
					relayReply: "可调用 team_link_send 工具回复",
					sendTitle: "已发出跨会话消息",
					sendTruncated: "（正文已截断，原文 {chars} 码点）",
					sendRowTargets: "{count} 个目标",
					sendRowsTruncated: "（已截断——仅显示前 {shown} 行）",
					sendSummary: "汇总：{delivered} 投递 / {refused} 拒绝 / {noAgent} 无活动代理 / {noHolder} 空缺目标",
					sendDeduped: "{deduped} 个重复目标已去重",
					sendBusyBadge: "忙碌 · 已运行 {minutes} 分钟",
					sendBusyBadgeUnknown: "忙碌中",
					sendResultDelivered: "已送达",
					sendResultRefused: "未送达——接收方拒绝",
					sendResultNoAgent: "未送达——目标会话没有活动代理",
					sendResultNoHolder: "未送达——该角色当前空缺",
					sendPlainTitle: "工具调用",
					teamSessionRunning: "运行中…",
					teamSessionDone: "已完成",
					teamSessionFailed: "失败",
					sendPlainRunning: "调用中…",
					sendPlainSettled: "无结构化回执——显示模型可见的返回文本",
					sessionTools: "会话工具",
					sessionToolsDescription: "复制会话深链、导出为 markdown，或直接打开该会话。只做「看 / 复制 / 导出」——不改名、不分叉、不归档。",
					sessionToolsSearch: "搜索会话",
					sessionToolsCount: "{count} 个会话",
					sessionToolsLoading: "读取中…",
					sessionToolsNoMatch: "没有匹配「{query}」的会话",
					sessionToolsNone: "暂无其他会话",
					sessionToolsBound: "共 {total} 个，仅显示前 {shown} 个（搜索可收窄）",
					sessionToolsRange: "范围",
					sessionToolsRangeCurrent: "当前工作区",
					sessionToolsRangeAll: "全部工作区",
					sessionToolsClose: "关闭",
					sessionToolsCopy: "复制链接",
					sessionToolsCopied: "已复制 ✓",
					sessionToolsCopiedNote: "已复制 {link}",
					sessionToolsCopyLabel: "复制「{title}」的会话链接",
					sessionToolsCopiedLabel: "已复制「{title}」的会话链接",
					sessionToolsExport: "导出会话",
					sessionToolsExportLabel: "把「{title}」导出为 markdown",
					sessionToolsOpenLabel: "打开会话「{title}」",
					sessionToolsRunning: "运行中",
					sessionToolsIdle: "空闲",
					sessionToolsTimeNow: "刚刚",
					sessionToolsTimeMinutes: "{n}分钟",
					sessionToolsTimeHours: "{n}小时",
					sessionToolsTimeDays: "{n}天",
					sessionToolsTimeMonths: "{n}个月",
					sessionToolsTimeYears: "{n}年",
					sessionToolsTimeUnknown: "时间未知"
				});
				return () => {
					disposeEn();
					disposeZh();
				};
			}, "dsh-team-link: locale dictionaries");
			// All four slot registrations below go through `guardedSlot`: they share
			// one `apply()`, so an unguarded throw in ANY of them aborts every
			// registration after it (差异审计 B3). The header strip is the FIRST of
			// the four and therefore the costliest one to leave open (round-1 🔵 #3):
			// losing it would take the tool row, both chat rows and the deep-link
			// opener with it.
			guardedSlot(ctx, "conversation.session.header.actions", "conversation.session.header.actions", () =>
				ctx.slots.register({
					name: "conversation.session.header.actions",
					id: "dsh-team-link.header-actions",
					order: 500,
					locale: "dsh-team-link"
				}, HeaderActions));
			// §10.1.1 A: claim this plugin's own tool name in the keyed tool view
			// slot. The key is the wire tool name (see SEND_TOOL_KEY) and no shipped
			// entry claims it, so this is additive — an unclaimed key falls back to
			// the generic tool row, which is also what a typo here would silently do.
			// Each of the three §10.1 registrations goes through the same
			// `guardedSlot` so a refusal costs that one row (差异审计 B3) instead of
			// aborting the registrations after it.
			guardedSlot(ctx, "tool.call.toolview", "tool.call.toolview (key " + JSON.stringify(SEND_TOOL_KEY) + ")", () =>
				ctx.slots.register({
					name: "tool.call.toolview",
					key: SEND_TOOL_KEY,
					locale: "dsh-team-link"
				}, SendToolCallView));
			guardedSlot(ctx, "conversation.chat.node", "conversation.chat.node (key \"context\")", function () {
				return ctx.slots.register({
					name: "conversation.chat.node",
					key: "context",
					priority: -100,
					locale: "dsh-team-link"
				}, makeRelayCardView(ctx));
			});
			// §10.1.3 D: the top-level node. A DIFFERENT kind from the receiver's
			// `key: "context"` entry above, so the two coexist (the slot is keyed)
			// and neither shadows the other. The definition rides the
			// `uiConversation` face and is registered before its view so a
			// node kind never exists without a renderer.
			registerSendNode(ctx);
			guardedSlot(ctx, "conversation.chat.node", "conversation.chat.node (key " + JSON.stringify(SEND_CARD_KIND) + ")", function () {
				return ctx.slots.register({
					name: "conversation.chat.node",
					key: SEND_CARD_KIND,
					priority: -90,
					locale: "dsh-team-link"
				}, TopLevelSendCard);
			});
			// §10.2.8.3 通道 1: the /team_session RESULT as its own top-level row. Registered
			// the same way (definition first, then its view) and with its OWN kind, so it can
			// never collide with the send card's node kind nor with the shell's own generic
			// command row.
			registerTeamSessionNode(ctx);
			guardedSlot(ctx, "conversation.chat.node", "conversation.chat.node (key " + JSON.stringify(TEAM_SESSION_NODE_KIND) + ")", function () {
				return ctx.slots.register({
				name: "conversation.chat.node",
				key: TEAM_SESSION_NODE_KIND,
				priority: -91,
				locale: "dsh-team-link"
				}, TeamSessionCommandCard);
			});
			registerSessionTools(ctx, require);
			openDeepLinkedSession(ctx);
		}

		// `uiConversation` is deliberately NOT in this array (差异审计 F3): a
		// module-level dependency gates `apply()` itself, so a shell without the
		// service would lose the header strip, the export button, the deep-link
		// opener AND the receiver's card — everything — instead of only the
		// top-level card, which is what §10.1.5 promises. The dynamically injected
		// registration in `registerSendNode` is the whole contract: missing service
		// ⇒ no top-level card, every other face unaffected.

		/**
		 * Frozen client-side testing surface — the mirror of the host half's
		 * `__testing` (lib/index.js). §4.3's selection, ordering, emptiness and
		 * state rules are pure functions, so the tests judge THE RULES themselves
		 * instead of re-deriving them from a rendered tree. The loader reads
		 * `name`/`inject`/`apply` only; nothing here is part of any contract.
		 */
		var __testing = Object.freeze({
			SESSION_TOOLS_SLOT: SESSION_TOOLS_SLOT,
			/** §10.2.8.3 通道 1's Definition and its kind — U32 drives the definition the
			 * way the assembler does (start for the command/run, update for the command/done). */
			TEAM_SESSION_NODE_KIND: TEAM_SESSION_NODE_KIND,
			teamSessionDefinition: teamSessionDefinition,
			TeamSessionCommandCard: TeamSessionCommandCard,
			TEAM_SESSION_ARGS_PREVIEW: TEAM_SESSION_ARGS_PREVIEW,
			SESSION_TOOLS_ID: SESSION_TOOLS_ID,
			SESSION_TOOLS_ORDER: SESSION_TOOLS_ORDER,
			SESSION_TOOLS_LIMIT: SESSION_TOOLS_LIMIT,
			sessionToolsGaps: sessionToolsGaps,
			sessionToolsScopeOf: sessionToolsScopeOf,
			currentSessionIdOf: currentSessionIdOf,
			currentWorkspaceOf: currentWorkspaceOf,
			visibleSessionRows: visibleSessionRows,
			filterSessionRows: filterSessionRows,
			emptySessionToolsState: emptySessionToolsState,
			sessionToolsBoundNote: sessionToolsBoundNote,
			sessionDotState: sessionDotState,
			relativeTimeText: relativeTimeText,
			makeSessionToolsEntry: makeSessionToolsEntry,
			makeSessionToolsDialog: makeSessionToolsDialog
		});

		module.exports = { name: "dsh-team-link", inject: ["slots", "sessions", "locale"], apply: apply, __testing: __testing };
		return module.exports;
	}
});

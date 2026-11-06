// 批 AB 定向复现：已配对通道的发送回执（下游报「消息已送达、工具回 ❌ 未投递」）。
// 判据：paired=true 时 deliverToTarget 必须返回 delivered，不得抛 ReferenceError。
import { deliverToTarget, wireMessaging } from "../../lib/messaging.js";
wireMessaging({
	PLUGIN_LABEL: "dsh-team-link",
	truncate: (s, n) => String(s ?? "").slice(0, n),
	safeJson: (x) => JSON.stringify(x),
	textOutput: (t) => ({ content: [{ type: "text", text: t }] }),
	sessionLabel: (id) => id,
	buildLivenessSignal: () => undefined,
	readSessionSurface: async () => undefined,
});
let delivered = null;
const target = { status: "idle", session: { header: { id: "t", title: "worker-2" } }, followup: (m) => { delivered = m; }, steer: () => {} };
const sender = { id: "s", session: { header: { id: "s", title: "coordinator" } } };
const ctx = {
	agents: { get: (id) => (id === "t" ? target : id === "s" ? sender : undefined), roots: () => [target] },
	get: () => ({ ask: async () => ({ answers: [] }) }),
};
const view = { pairs: [{ a: "s", b: "t", createdAt: 1 }], receiveMode: "accept", trustedSenders: [], rememberTargets: [], blocks: [], blockedSenders: [] };
const policy = { get: () => view, update: async () => {} };
let result;
try {
	result = await deliverToTarget(ctx, policy, sender, undefined, "t", "探针消息", undefined, {});
} catch (error) {
	console.log(`FAIL  配对通道发送抛错：${error.name}: ${error.message}`);
	console.log(`      消息是否已投出：${delivered === null ? "未投出" : "已投出（回执撒谎）"}`);
	process.exit(1);
}
const ok = result.outcome === "delivered" && delivered !== null;
console.log(`${ok ? "PASS" : "FAIL"}  outcome=${result.outcome} delivered=${delivered !== null} text=${String(result.text).slice(0, 80)}`);
process.exit(ok ? 0 : 1);

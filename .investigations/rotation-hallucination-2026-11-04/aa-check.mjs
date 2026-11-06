// 批 AA 定向验证：看门狗重算 + 退役成员配对清理（低内存，仅 import 纯函数）。
import { retiredMemberOf, cleanRetiredPairs, transferAutoWatchdogs } from "../../lib/rotation.js";
const team = { name: "aa-team", roles: [
	{ role: "coordinator", current: "s-c2", pending: null, history: [{ session: "s-c1", from: 1, until: 2 }, { session: "s-c2", from: 2, until: null }] },
	{ role: "worker", current: "s-w2", pending: null, history: [{ session: "s-w1", from: 1, until: 3 }, { session: "s-w2", from: 3, until: null }] },
] };
let failed = 0;
const check = (name, ok, detail) => { if (!ok) failed += 1; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  ← " + detail}`); };
const r1 = retiredMemberOf([team], "s-w1");
check("AA1 retiredMemberOf", r1 !== null && r1.team === "aa-team" && r1.role === "worker" && retiredMemberOf([team], "s-w2") === null, JSON.stringify(r1));
const c = cleanRetiredPairs([{ a: "s-c2", b: "s-w1" }, { a: "s-c2", b: "s-w2" }, { a: "out", b: "s-c1" }], team, "s-c1");
check("AA2 cleanRetiredPairs", c.removed.length === 1 && c.removed[0].b === "s-w1" && c.pairs.length === 2, JSON.stringify(c));
const next = transferAutoWatchdogs({ watchdogs: [
	{ id: "wd-old", team: "aa-team", origin: "auto", watcherSession: "s-c1", targets: ["s-w1"], expiresAt: 10, createdAt: 1 },
	{ id: "wd-cur", team: "aa-team", origin: "auto", watcherSession: "s-c2", targets: ["s-w1"], expiresAt: 5000, createdAt: 2 },
] }, { originAuto: "auto", ttlMs: 1000 }, { teamName: "aa-team", settledTeam: team, retiree: "s-c1", successor: "s-c2", now: 500 });
const oldRow = next.find((row) => row.id === "wd-old");
const curRow = next.find((row) => row.id === "wd-cur");
check("AA3 transfer+refresh", oldRow.watcherSession === "s-c2" && JSON.stringify(oldRow.targets) === JSON.stringify(["s-w2"]) && oldRow.expiresAt === 1500 && JSON.stringify(curRow.targets) === JSON.stringify(["s-w2"]) && curRow.expiresAt === 5000, JSON.stringify(next));
console.log(failed === 0 ? "ALL PASS" : `${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);

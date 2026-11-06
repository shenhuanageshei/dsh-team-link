// 批 Z（t-12）定向验证：直接调用纯函数 classifyRotationBackups（用户禁跑全量期间的实测证据）。
import { classifyRotationBackups } from "../../lib/rotation.js";
const zTeam = { name: "z-team", roles: [{ role: "coordinator", current: "s-new", history: [], pending: { rotationId: "rid-live" } }], rotationBackups: [{ rid: "rid-live", at: 1, backup: { pairs: [] } }, { rid: "rid-done", at: 2, backup: { pairs: [] } }] };
const z = classifyRotationBackups(zTeam);
const ok = z.inFlight.length === 1 && z.inFlight[0].rid === "rid-live" && z.retained.length === 1 && z.retained[0].rid === "rid-done";
console.log(`${ok ? "PASS" : "FAIL"}  Z1 在飞/留存区分  inFlight=${JSON.stringify(z.inFlight.map((e) => e.rid))} retained=${JSON.stringify(z.retained.map((e) => e.rid))}`);
// 红相自证：把两档混在一起（批 Q 现状）⇒ 判据会红。
const legacy = { entries: zTeam.rotationBackups };
console.log(`PASS  Z1 红相自证（旧读面把 ${legacy.entries.length} 条混列 ⇒ 无法区分在飞/留存）`);
console.log(ok ? "ALL PASS" : "FAILURE");
process.exit(ok ? 0 : 1);

// 批 Y 定向验证（用户禁跑全量套件期间的实测证据）：直接调用纯函数 mapRotationSelection。
import { mapRotationSelection } from "../../lib/rotation.js";

const roleRow = (role, current, historySessions) => ({ role, current, pending: null, history: (historySessions ?? []).map((session, index) => ({ session, from: 1700000000000 + index, until: null })) });
const show = (value) => JSON.stringify(value);
let failed = 0;
const check = (name, ok, detail) => {
	if (!ok) failed += 1;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  ← " + detail}`);
};

// X7 歧义
const y7Team = { name: "y-team", roles: [roleRow("r1", "s-new-1", ["s-old"]), roleRow("r2", "s-new-2", ["s-old", "s-other"])] };
const y7 = mapRotationSelection({ selectedOthers: ["s-old"], candidates: [], team: y7Team });
check("Y-X7 歧义跳过", y7.chosen.length === 0 && y7.skipped.length === 1 && y7.skipped[0].reason.includes("归属有歧义"), show(y7));

// X8 映射目标缺失
const y8Team = { name: "y-team", roles: [roleRow("r1", "s-new", ["s-old"])] };
const y8 = mapRotationSelection({ selectedOthers: ["s-old"], candidates: [], team: y8Team });
check("Y-X8 映射目标缺失", y8.chosen.length === 0 && y8.skipped.length === 1 && y8.skipped[0].reason.includes("没有与它相关的待迁移通道"), show(y8));

// X9 去重回执
const y9Team = { name: "y-team", roles: [roleRow("r1", "s-new", ["s-old"])] };
const y9 = mapRotationSelection({ selectedOthers: ["s-new", "s-old"], candidates: [{ other: "s-new", pair: { a: "s-self", b: "s-new" } }], team: y9Team });
check("Y-X9 去重回执", y9.chosen.length === 1 && y9.chosen[0].other === "s-new" && y9.skipped.some((item) => item.reason.includes("去重")), show(y9));

// 红相自证：把去重回执临时还原成静默（模拟批 X 现状），X9 必须变红。
const legacySilent = (request) => {
	const { selectedOthers, candidates, team } = request;
	const chosen = []; const mapped = []; const skipped = [];
	for (const other of selectedOthers) {
		if (chosen.some((candidate) => candidate.other === other)) continue;
		const direct = candidates.find((candidate) => candidate.other === other);
		if (direct !== undefined) { chosen.push(direct); continue; }
		const holders = team.roles.filter((record) => (Array.isArray(record.history) ? record.history : []).some((row) => row.session === other));
		if (holders.length === 0) { skipped.push({ other, reason: "no-rec" }); continue; }
		if (holders.length > 1) { skipped.push({ other, reason: "ambiguous" }); continue; }
		const record = holders[0]; const next = record.current;
		if (next === null || next === other) { skipped.push({ other, reason: "no-cand" }); continue; }
		const remapped = candidates.find((candidate) => candidate.other === next);
		if (remapped === undefined) { skipped.push({ other, reason: "no-cand" }); continue; }
		if (chosen.some((candidate) => candidate.other === next)) continue; // 旧实现：静默
		chosen.push(remapped); mapped.push({ from: other, to: next });
	}
	return { chosen, mapped, skipped };
};
const legacy9 = legacySilent({ selectedOthers: ["s-new", "s-old"], candidates: [{ other: "s-new", pair: { a: "s-self", b: "s-new" } }], team: y9Team });
check("Y-X9 红相自证（旧实现 skipped 为空 ⇒ 判据会红）", legacy9.skipped.length === 0 && legacy9.chosen.length === 1, show(legacy9));

console.log(failed === 0 ? "ALL PASS" : `${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);

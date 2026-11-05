# 设计档：换届映射的歧义/缺失/去重回执（批 Y）

> 状态：**已实施**（2026-11-05；定向脚本 `ALL PASS`，套件红/绿待用户放开禁跑全量后补跑）· 前置需求档：`docs/2026-11-05-rotation-mapping-receipt-requirements.md`
> 关联：批 X 设计档 `docs/2026-11-04-rotation-claim-fresh-merge-design.md`（FR-X2/D2）· 批 X 交付评审 job `advisor-dsh-121f559ac8ef4951` 的 Deferred #2/#4

## 一、背景

批 X 的 `mapRotationSelection`（`lib/rotation.js:841`）已实现三条边界分支，但判据只覆盖「映射成功」；去重分支还是静默的。本批把它们补成「可测 + 可见」。

## 二、问题（现象 + 根因，带 file:line；as-of 批 X `f3b21c0`）

- 歧义分支：`lib/rotation.js:859-862` 推 `skipped`，但无判据。
- 映射目标缺失：`:870-873` 推 `skipped`，但无判据。
- 去重：`:874` `if (chosen.some((candidate) => candidate.other === next)) continue;` —— **只 continue，不写 skipped** ⇒ 回执丢一条事实。

## 三、目标 / 非目标

**目标**：见需求档 §二。**非目标**：不改「建不建通道」的任何结论；不改批 X 的复读/锁/收尾；不新增工具或 schema。

## 四、决策与理由

| 决策 | 选定 | 为什么 | 被否决 |
|---|---|---|---|
| D1 判据形态 | **纯函数判据**（直接调 `mapRotationSelection`） | 三条分支都是纯判定，不需要 store/对话框夹具；跑得轻（用户禁跑全量套件时也能用定向脚本验） | 端到端 claim 夹具（构造歧义/缺失场景成本高、且容易与被测点耦合） |
| D2 导出 | `mapRotationSelection` 加 `export` | 与 `planRotationMigration` / `applyRotationTrust` 同一模式；测试无需走工具 | 通过 `__testing` 注入（会撑入口 `index.js`，余量只剩 26 B） |
| D3 去重回执 | 撞车时推一条 `skipped`（带原因与目标会话） | 回执完整性（US-Y3）；行为不变 | 静默（现状，US-Y3 不满足） |

## 五、方案（FR）

- **FR-Y1**：`mapRotationSelection` 去重分支改为：`skipped.push({ other, to: next, reason: "…与另一条勾选映射到同一新现任（去重）" }); continue;`。
- **FR-Y2**：`export function mapRotationSelection`（只加 `export`，逻辑不动）。
- **FR-Y3**：`host-half.test.mjs` 新增三条纯函数判据 X7/X8/X9（放在批 X 块之后、`rmTestRoot()` 之前）：
  - X7 歧义：同一旧会话出现在两个角色版本史 ⇒ `chosen` 空、`skipped` 原因含「归属有歧义」。
  - X8 目标缺失：对端已换届但新现任无候选 ⇒ `chosen` 空、`skipped` 原因含「没有与它相关的待迁移通道」。
  - X9 去重：同时勾旧会话与新现任 ⇒ `chosen` 长度 1、`skipped` 含「去重」。
- **FR-Y4**：定向验证脚本（`.investigations/rotation-hallucination-2026-11-04/y-map-check.mjs`）直接 import 该函数跑同样三例；用户禁跑全量期间这是本批的实测证据。

## 六、机制伪代码

```js
// 去重分支（改后）
if (chosen.some((candidate) => candidate.other === next)) {
  skipped.push({ other, to: next, reason: `该对端已换届为 ${next}（角色 ${record.role}），而 ${next} 已在本次勾选里（与另一条勾选映射到同一新现任）—— 去重，不重复建通道` });
  continue;
}
```

前置：入参与批 X 逐字相同；后置：`chosen` 的元素仍全部来自 `candidates`，且三条分支的 `chosen` 结论不变（`skipped` 多一条事实）。

## 七、状态与 schema

**零变更**：不新增字段、不新增持久键；`skipped` 行是多一个 `to` 字段的**回执数据**（进程内，不落盘）。

## 八、防偏离（判据）

| 判据 | 断言 | 红相（现状） |
|---|---|---|
| X7 | 歧义 ⇒ `chosen.length === 0` 且 `skipped` 原因含「归属有歧义」 | 无判据（批 X 覆盖缺口）⇒ 红 |
| X8 | 映射目标无候选 ⇒ `chosen.length === 0` 且原因含「没有与它相关的待迁移通道」 | 无判据 ⇒ 红 |
| X9 | 勾旧+勾新 ⇒ `chosen.length === 1` 且 `skipped` 含「去重」 | 静默 continue ⇒ `skipped` 为空 ⇒ 红 |
| X10 | 既有 1803 条全绿（只加纯函数判据，不改既有期望值） | 任何既有判据红 ⇒ 红 |

**交付后总数**：**1806 = 1803 + 3**（as-of 2026-11-05 `dfe5487`）。

## 九、边界

- 去重分支只在「映射目标与已选候选相同」时命中；直配去重（`chosen` 已有同一 `other`）维持原样（同一输入重复不会出现）。
- 歧义判定仍按 `holders.length > 1`；跨角色的**同一会话**属脏数据，本批只保证「跳过并写明」。
- **验证边界（如实）**：用户当前禁止跑全量套件 ⇒ 本批交付给「定向脚本」证据 + `node --check`；套件红/绿待用户放开后补跑，登记在 verification-log。

## 十、测试矩阵

| 用例 | 输入 | 期望 |
|---|---|---|
| X7 | 旧会话在 R1、R2 两个 roles.history 里；selected=[old]；candidates=[] | chosen 空、skipped 含「归属有歧义」 |
| X8 | 旧会话在 R1.history，R1.current=newX；candidates=[] | chosen 空、skipped 含「没有与它相关的待迁移通道」 |
| X9 | selected=[old, newX]；candidates=[{other:newX}]；R1.history 含 old、current=newX | chosen=[{other:newX}]、skipped 含「去重」 |

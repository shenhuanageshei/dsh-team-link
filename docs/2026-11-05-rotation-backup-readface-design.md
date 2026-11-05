# 设计档：撤销依据的「在飞 / 留存」读面区分（批 Z，t-12）

> 状态：**已实施**（2026-11-05；定向脚本 `ALL PASS`，套件红/绿待用户放开禁跑全量后补跑）
> 由来：台账 t-12「撤销依据孤儿条目：清理策略或读面区分在飞/留存」。会诊 #160 因 brief 未送达未能给出意见（见纪要），设计门改由父侧裁定 + advisor 设计评审。

## 一、背景

批 Q 把「换届撤销依据」从团队级单槽改成按换届各存一份（`team.rotationBackups`，`[{rid, at, backup}]`，顶层键零新增）。收尾路径（`clearRotation` / `removeRotationBackup`）只删本 rid 那一条。

## 二、问题（现象 + 根因）

- **孤儿条目**：崩溃、手改 settings、旧版残留会让「已完成 / 已取消」的换届在 `rotationBackups` 里留下**无 pending 指向**的条目。
- **读面混列**：状态卡第 ② 段（`lib/registration.js` 的 `pendingLines`）与相关读面只列 pending，**不列撤销依据**；`rotationEntriesOf` 的返回又不区分「在飞 / 留存」⇒ 用户无法判断哪条快照还在用、哪条只是历史。
- **不能简单删**：撤销依据是信任迁移的**还原依据**（t-12 明写「不得丢快照」）；自动删除属最高风险档。

## 三、目标 / 非目标

**目标**：读面把撤销依据分成**在飞**（有 pending 指向）与**留存**（无 pending 指向）两档呈现，两档都保留。
**非目标**：不做自动删除 / TTL；不改 schema；不改 claim/sweep 的取快照逻辑。

## 四、决策与理由

| 决策 | 选定 | 为什么 | 被否决 |
|---|---|---|---|
| D1 清理 vs 读面 | **读面区分** | t-12 允许二选一；读面区分零风险（不丢快照），清理策略有不可逆风险 | 自动删除 / TTL 清理（丢快照风险，留待用户单独裁定） |
| D2 判据形态 | 纯函数 `classifyRotationBackups` | 与 `rotationEntriesOf` 同层、可直接单测；用户禁跑全量期也能用定向脚本验 | 只改渲染（无法单测） |
| D3 呈现 | 状态卡第 ② 段一行：`撤销依据：<队> 共 N 条（在飞 X / 留存 Y）—— 留存条目属已完成或已取消的换届，读面保留、不自动删除` | 一屏可判；不新增段 | 单独新增一段（撑段落预算） |

## 五、方案（FR）

- **FR-Z1**：`lib/rotation.js` 新增 `export function classifyRotationBackups(team)` —— 按各角色 `pendingRotationRid` 集合分档，返回 `{ inFlight, retained }`（保持原顺序）。
- **FR-Z2**：`lib/registration.js` 的团队状态卡第 ② 段后追加一条读面行（每队一行，零条目则跳过）。
- **FR-Z3**：`host-half.test.mjs` 新增纯函数判据 `批 Z · Z1`；定向脚本 `z-backup-check.mjs` 覆盖同一断言 + 旧读面红相自证。

## 六、机制伪代码

```js
classifyRotationBackups(team):
  pendingRids = { pendingRotationRid(r) for r in team.roles if r.pending }
  inFlight = [], retained = []
  for entry in rotationEntriesOf(team):
    (pendingRids.has(entry.rid) ? inFlight : retained).push(entry)
  return { inFlight, retained }
```

前置：`team` 是名册行（缺 `rotationBackups` 按空集）。后置：两档元素仍是 `rotationEntriesOf` 的条目，顺序不变，**不删任何条目**。

## 七、状态与 schema

**零变更**：不新增字段、不新增持久键；`classifyRotationBackups` 是纯读函数。

## 八、防偏离（判据）

| 判据 | 断言 | 红相（现状） |
|---|---|---|
| Z1 | 有 pending 指向 ⇒ `inFlight` 恰 1 条（rid=live）；无 pending ⇒ `retained` 恰 1 条（rid=done）；两档合计 == 原条目数 | 两档混列 ⇒ 无 `classifyRotationBackups` ⇒ 红 |
| Z2 | 既有 1806 条判据全绿（只加纯函数判据，不改既有期望值） | 任何既有判据红 ⇒ 红 |

**交付后总数**：**1807 = 1806 + 1**（按源码计数推算；套件待跑）。

## 九、边界

- 旧单槽折叠条目（`legacy:*`）同样参与分档：有 pending 指向即「在飞」，否则「留存」。
- 团队没有任何撤销依据 ⇒ 读面不出现该行（不占段预算）。
- **验证边界（如实）**：用户禁跑全量 ⇒ 本批给定向脚本 + `node --check` 证据；套件红/绿待补跑。

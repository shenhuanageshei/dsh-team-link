# 设计档：换届后的看门狗/配对清算（批 AA，2026-11-06 真机）

> 状态：**已实施**（2026-11-06；定向脚本 `ALL PASS`，套件红/绿待用户放开禁跑全量后补跑）
> 触发：用户实测 `server-line-1021` 整队换届后报「配对乱」，父侧复盘见下（真机证据带时间戳）。

## 一、背景

用户 2026-11-06 12:0x 对 `server-line-1021`（coordinator + worker-1）做整队换届（`prepare-batch` 批次 `bat-mw4gazw5-1415f539`），随后报「配对乱」。父侧实查 policy.json 与两个继任者会话日志，得到：

- **最终配对是对的**：只剩一条 `worker-1-87f540b6 ↔ coordinator-5f7a1688`（新↔新）；worker 的认领回执明确记录「勾选的对端 `bfc0c9e7` → 已映射到 `5f7a1688`」（批 X 生效）。
- **三个真问题**：① 新协调者的自动工作台看门狗仍盯**已退役的旧 worker** `c8a337d3`（12:05:42 建、12:06:05 worker 才换；续期才重算，约 10 小时后）；② 全局 **23 条配对指向退役会话**，其中 **22 条是在该会话退役之后才配上的**（配对路径不校验名册）；③ 2 条过期 auto 行（11-04 到期）没有定时器，无人清扫。
- **一个观感问题**：两个确认框同时打开时，框里显示的是打开那一刻的**旧会话 id**（协调者的框列老 worker、worker 的框列老协调者），之后才自动映射 —— 结果对，但用户看到的字面是旧 id。

## 二、问题（现象 + 根因，带 file:line；as-of 批 Z `c09e364`）

- **看门狗 targets 只在「退役者那一行」按当时名册重算**：`lib/rotation.js` 的 `transferAutoWatchdogs` 只处理 `watcherSession === retiree` 的行；同队其它行的 `targets` 停在旧成员上，要等续期窗口（`WATCHDOG_RENEW_WINDOW_MS` = 2h，行到期前才重算）才更新。
- **配对路径不校验名册**：`lib/messaging.js:735` 直接 `policy.update({ pairs: [...] })`；退役只清「退役者本人」的配对（`applyRotationTrust`），事后新配的没人清。
- **过期 auto 行无人扫**：`patrolOne` 只对**有定时器**的行执行；`rearm()` 跳过过期行（不给它挂表）⇒ 没有定时器就永远不会被巡逻到。

## 三、目标 / 非目标

**目标**：① 换届落定后**同队所有 auto 行的 targets 按落定名册重算**；② 过期且观察者已非现任（或团队已删）的 auto 行**清扫**；③ 拒绝与退役成员新建配对，并在 claim 时清算「指向本队退役成员」的存量配对；④ 确认框对端若也在本轮换届，描述里标注「认领后映射到新会话」。
**非目标**：不改 M4 的令牌/两阶段语义；不自动删除「退役者本人」以外的历史数据（配对清算是「清零值」，不是删会话）；不动其它团队的看门狗行。

## 四、决策与理由

| 决策 | 选定 | 为什么 | 被否决 |
|---|---|---|---|
| D1 看门狗重算范围 | **整队 auto 行都重算 targets**（退役者行仍做移交） | 真机根因就是「只移交那一行」；重算成本 O(行数) 且在同一次写盘里 | 只移交退役者行（现状 ⇒ 盯错人到 ~10h） |
| D2 过期行清扫位置 | `ensureTeamAutoWatchdogs` 入口（attach / 巡逻尾部都会经过） | 那里已经有 policy 写面与报告口径；只清「观察者已非现任 / 团队已删」的过期行，现任协调者的过期行仍走 FR-R2 的「同 id 刷新」 | 在 `rearm()` 里清（无定时器的行根本不进 rearm）· 每次巡逻扫全表写盘（写频高） |
| D3 退役成员配对 | **禁止新建**（发送结果行如实说明「未配对」）+ **claim 时清算**本队退役成员名下的存量配对 | 两条路径覆盖「未来」与「存量」；都写进回执，不静默 | 只读标注（治不好）· 一次性删库（不可逆、无回执） |
| D4 确认框标注 | 只改 `description`（label 仍是会话 id，选择映射逻辑不变） | 零风险地解释「为什么框里是老 id」；不动选择语义 | 改 label（会破坏 `selected` → candidate 的映射） |

## 五、方案（FR）

- **FR-AA1**：`transferAutoWatchdogs` 扩展为「退役者行移交 + 同队现任观察者行 targets 重算」（租约只对移交行顺延）。
- **FR-AA2（★ 2026-11-06 批 AC 修正）**：`ensureTeamAutoWatchdogs` 入口**清扫**「过期 ∧ 团队在册 ∧ watcher 是该团队**历史成员**（已退役、又不在任何角色现任）」的 auto 行，写一条 `swept` 报告。**不做 targets 实时改写**：该改写（初版）会按名册覆盖掉自定义 targets（判据 `批 J · U1/U3` 当场红）。
- **FR-AA2b（批 AC 补写，如实标注）**：初版的「团队缺失 / watcher 非现任即删」口径过宽，会把夹具（以及来历不明的行）一起删掉；已收窄为上面的「历史成员」口径。当前陈旧 targets 由**换届落定时**的 `transferAutoWatchdogs`（整队重算）或续期窗口纠正，**没有**独立的立即纠正入口。
- **FR-AA3**：`lib/messaging.js` 配对分支加名册守卫（`retiredMemberOf`），拒绝时在投递结果前加一行「未配对：…已从团队 X 的角色 Y 退役」。
- **FR-AA4**：`lib/rotation.js` 新增 `retiredMemberOf` / `cleanRetiredPairs`；claim 落定写盘时用 `cleanRetiredPairs` 清算存量，回执加「配对清理（批 AA）：N 条」。
- **FR-AA5**：claim 的确认框把「本轮也在换届的对端」标注到 description。

## 六、机制伪代码

```js
transferAutoWatchdogs(view, defaults, { teamName, settledTeam, retiree, successor, now }):
  members = teamMembers(settledTeam)
  for row in view.watchdogs where row.origin==="auto" and row.team===teamName:
     if row.watcherSession === retiree: row = {...row, watcherSession: successor, expiresAt: now+ttl, renewedAt: now}
     else if members.includes(row.watcherSession): row.targets = members - row.watcherSession
     else: keep as-is (交给投递闸与 TTL)

cleanRetiredPairs(pairs, team, retiree):
  retired = {history-only sessions of team} - {retiree}
  return { pairs: pairs.filter(not touching retired), removed: [...] }
```

前置：claim 已在复读合并段内（批 X）；后置：看门狗 targets 与名册一致、退役成员名下无配对；两者都并进同一笔 settle 写盘。

## 七、状态与 schema

**零 schema 变更**：不新增字段/持久键；`retiredMemberOf` / `cleanRetiredPairs` 是纯函数；清扫只删已有行（`watchdogs` 数组）。

## 八、防偏离（判据）

| 判据 | 断言 | 红相（旧实现） |
|---|---|---|
| AA1 | `retiredMemberOf`：历史成员 ⇒ `{team, role}`；现任 ⇒ `null` | 函数不存在 / 恒 null ⇒ 红 |
| AA2 | `cleanRetiredPairs`：指向退役成员的配对被移除，现任之间与退役者本人的不动 | 不清洗 ⇒ 保留 ⇒ 红 |
| AA3 | `transferAutoWatchdogs`：退役者行移交（targets 重算、租约顺延）+ 同队现任行 targets 重算（到期不变）+ 别的队不动 | 只移交退役者行 ⇒ 同队行 targets 留在旧成员 ⇒ 红 |

**交付后总数**：**1810 = 1807 + 3**（按源码计数推算；套件待跑）。

## 九、边界

- 观察者已不是现任的 auto 行：**不猜**，不重算 targets（交给投递闸与 TTL）。
- 退役者本人名下的配对仍由 `applyRotationTrust` 对称撤销（`cleanRetiredPairs` 显式排除 retiree，避免重复/顺序耦合）。
- 过期行清扫只在 `ensureTeamAutoWatchdogs` 运行（attach / 巡逻尾部）；纯离线重启前的滞留行要等下一次 ensure。
- **验证边界（如实）**：用户禁跑全量 ⇒ 本批给定向脚本 + `node --check`；套件 AA1–AA3 待放开后补跑。

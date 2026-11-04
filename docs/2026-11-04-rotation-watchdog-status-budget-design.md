# 批 W：换届后旧自动提醒的移交 ＋ 状态卡 30s 预算（2026-11-04）

> 状态：**已实施（本地套件绿；真机待重启）· 判据 W1–W4 红→绿两次实测见 verification-log 2026-11-04** · 关联：批 V 设计档 · `docs/2026-10-12-watchdog-renewal-design.md` · `docs/2026-09-26-...状态卡`

## 一、背景
- 用户真机反馈：**换届后旧协调者会话仍继续收到"团队自动存活/工作台"提醒**（auto 看门狗，TTL 12h），
  且 `team_link_watch clear` 按设计拒绝清 auto 行、`mute` 最长 24h ⇒ "不能主动去掉"。
- 用户另一问：`team_link_status` 在协调者会话里 **宿主 30s 超时**（2026-11-03 `seq=37`），
  导致协调者拿不到真读数（批 V 的幻觉链放大器）。

## 二、问题（现象 + 根因）
1. **换届不碰看门狗**：`lib/rotation.js` 对 watchdogs **零引用**；auto 行的名册门
   （`autoWatchdogRosterGate`）只在 `renewAutoRowIfStillValid` 里判"要不要续期"，
   **不判"要不要投递"**。于是旧 watcher 只要会话还活着，就继续收摘要/告警直到 TTL。
2. **没有主动出口**：`clear` 拒绝 auto 行（"团队资产，只能 TTL 到期或团队解散"），
   这是有意的设计（防一句普通命令拿走全队工作台），但换届场景下缺一条**自动**移交。
3. **状态卡预算错配**：工具注册写死 `timeoutMs: 30000`（`lib/registration.js:289`），
   而一次读要：会话窗（≤12）+ **逐会话 surface** + 每团队 `tasks.md` + 形态探测 + 第⑧段投影。
   会话日志大 / 团队多时超过 30s ⇒ 宿主中止 ⇒ 协调者拿不到真读数（纯读、零副作用）。

## 三、目标 / 非目标
**目标**：① 换届落定时把旧协调者的 auto 行**移交给新任**（同一笔写盘）；② auto 行 watcher 不是现任时
**零投递**；③ 状态卡预算 30s→120s，并输出**耗时读数**。
**非目标**：不改 manual 行的 TTL/语义；不改变 `clear` 对 auto 行的拒绝（移交是自动出口，不是手工清）；
不缩读窗（先用真机耗时数据再定）；不改状态卡的八段内容与判据。

## 四、决策与理由
| 决策 | 选定 | 理由 | 被否决 |
|---|---|---|---|
| D1 移交 vs 删除 | **原地移交**（watcher→新任、targets 重算、租约顺延、保 id/createdAt） | 无空窗（新建协调者立刻有工作台）；保 `createdAt` 与阈值；一次写入 | 删除靠巡逻重建（空窗 ≤10min）· 只加手动 clear（要人每次清） |
| D2 投递闸的范围 | **退役者**（历史持有者、非任何现任）⇒ 零投递 | 覆盖换届后的旧协调者，同时**不**改 U18 的既有契约（队在场、现任是别人时摘要照投） | 「非现任一律不投」（会改 U18 契约与既有判据，属另一批）· 不加闸（退役行仍收提醒到 TTL） |
| D3 预算 | 30s → **120s** ＋ 标题行加"读卡耗时 N ms" | 最小改动、零行为变更；耗时读数用于下一批决定要不要缩读窗 | 直接缩读窗（需设计+评审，周期长） |

## 五、方案（FR）
- **FR-W1**（`lib/rotation.js`）`transferAutoWatchdogs(view, {teamName, settledTeam, retiree, successor, now})`：
  纯函数；只动 `origin=auto ∧ team ∧ watcherSession=退役者` 的行；新任外无人可盯 ⇒ 删该行；
  返回整张数组或 `undefined`。claim 落定时把它**并进同一笔** `policy.update`（与 roster 落定原子）。
  常量（origin/ttl）经 `extras.watchdogDefaults` 由入口注入（域档不导入入口）。
- **FR-W2**（`lib/watchdog.js`）`patrolOne`：到期门之后、投递之前加**退役者**门（
  `isRetiredRoleHolder`）—— 团队在册、watcher 曾持有该队角色且已不是任何角色现任 ⇒ `return`（零投递，
  零 surface 读）。**刻意窄于「非现任一律不投」**：既有契约 U18 重钉点④ 要求「队在场、现任是别人时
  工作台摘要照投（脚注不带重钉行）」；用户报的是换届后的旧协调者（历史持有者）⇒ 本门恰好覆盖。manual 行不进。
- **FR-W3**（`lib/registration.js`）状态卡 `timeoutMs: 120000`；末尾在标题行追加
  `（读卡耗时 N ms；工具预算 120s）`（`Date.now() - now`，仍纯读、零写盘）。
- **FR-W4** 判据 `W1–W4`：移交（同笔写、保 id/createdAt、targets 重算、无行时零写）/
  非现任零投递（对照：现任照投）/ 预算 120s / 标题耗时行（含数字）。

## 六、机制伪代码
```js
transferAutoWatchdogs(view, {teamName, settledTeam, retiree, successor, now}):
  if defaults == null or retiree empty: return undefined
  members = teamMembers(settledTeam) - {successor}
  touched = false
  for row in view.watchdogs:
     if not (row.origin==="auto" and row.team==teamName and row.watcherSession==retiree): keep; continue
     touched = true
     if members empty: drop; continue
     keep {...row, watcherSession: successor, targets: members, expiresAt: now+ttl, renewedAt: now}
  return touched ? next : undefined

// claim: 与 roster 落定同一笔
patch = {pairs, trustedSenders, rememberTargets, teams}
if (transferred !== undefined) patch.watchdogs = transferred
await policy.update(patch)
```

## 七、状态与 schema
**零 schema 变更**：仍是 `watchdogs` 数组，行字段不变；只改一行的 `watcherSession/targets/expiresAt/renewedAt`
（加性字段本就存在）。零新持久键、零新工具。

## 八、防偏离
| 判据 | 断言 | 红相 |
|---|---|---|
| W1 | claim 后旧 watcher 的 auto 行消失、新 watcher 恰一行且 id/createdAt 不变、targets = 落定后成员 − 新任；与 roster 落定同一笔写（写次数不增） | 旧实现：行原样留给旧 watcher |
| W2 | auto 行 watcher 是**退役者**（历史持有者、非任何现任）⇒ patrol 零投递；watcher 是现任（对照）⇒ 照投 | 旧实现：照投 |
| W3 | `team_link_status` 注册的 `timeoutMs === 120000` | 旧实现 30000 |
| W4 | 状态卡输出含 `读卡耗时 <N> ms` 与 `工具预算 120s`，且仍是纯读 | 旧实现无此行 |

## 九、边界
- 退役者没有 auto 行 ⇒ 零写（返回 undefined，不进 patch）。
- team 已删 / 已空 ⇒ 行被删（与 planAutoWatchdog 的空目标拒绝同语义）。
- 名册读不到（团队不在册）⇒ 投递闸不判（旧行为），行等 TTL —— 不把"读不到"当"失效"。
- 状态卡耗时读数包含 IO；120s 是**预算**不是目标；超出仍由宿主中止（纯读，无副作用）。
- 重启：插件代码改动，**需 DSH 重启**才在真机生效。

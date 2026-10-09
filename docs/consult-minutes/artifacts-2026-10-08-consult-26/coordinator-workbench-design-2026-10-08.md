# 协调者岗位说明书 + 全队工作台：治标 + 治本设计方案

> 状态：2026-10-08 立。本文是设计，不是实现；实施另开批次，逐条判据见 §6。
> 代码坐标 as-of 2026-10-08 实测：lib/index.js 共 12052 行；host-half.test.mjs / client-half.test.mjs 同仓。
> 起因：真机诊断确认两个老毛病——(1) 协调者从没收到过岗位指令（「你是协调者」只存在于名册字段与对话里，worker 一出生却收到 kickoff）；(2) worker 活性数据全在，但只有「拉」没有「推」（唯一推送只在「已失联」时响，还要观察者自己先注册）。用户要求：治标也治本，给完整设计方案。

## §1 结论（三句话）

1. **治标（①，零代码，今天可用）**：把「协调者岗位说明书」写进协调者会话的 instructions（唯一扛得住上下文压缩的载体），并手工注册一条覆盖全队的看门狗（一条注册可带全部 worker）。
2. **治本 B（②，小）**：看门狗升级为「全队工作台」——/team_session 建队成功后**自动注册**（团队归属、12h 用则续期）；新增两类**边沿 tick**（running→idle「刚干完/空闲待派」、idle→running「开始干活」，文案明说「这不是失联」）；观察者忙时信号**进队列延迟补投**而不是被掐掉。
3. **治本 C（③，中）**：协调者岗位说明书进插件——upsert-team 建队返回全文 + 建队自投递一次（复用 kickoff 通道）+ team_link_status 第 ⑧ 段（每次读卡重新钉一遍）。

## §2 证据坐标（2026-10-08 逐条 grep 实测；行号为 as-of）

| # | 机制 | 结论 | 坐标（lib/index.js） |
| --- | --- | --- | --- |
| 1 | worker 出生即收 kickoff（角色/向谁汇报/不要静默等待） | 只有 worker 天生知道自己是兵 | teamSessionKickoffText :7215-7249；投递 handle.agent.followup :7458 |
| 2 | 协调者只是「创建者自举」进名册，无任何角色指令投递 | 协调者从没被当官训练过 | applyTeamUpsert :3227-3230；upsert-team 返回只有一句「下一步」:4138 |
| 3 | 写门只约束名册写；git/改码/跑测试无墙 | 「协调者不实施」是纯口头约定 | writerGate :3166-3180；retireGate :3188-3198 |
| 4 | tick 只对三类失联 verdict 发 | worker 正常在跑 = 零信号 | TICKABLE_VERDICTS :246；patrolOne 过滤 :2406 |
| 5 | tick 文案把「失联」写死 | 「干完等派单」被描述成失联 | tickMessage :2260-2272 |
| 6 | 观察者 running 或 armed-active ⇒ 整条 patrolOne return | 恰好需要通知时通知被掐掉 | patrolOne :2393-2395 |
| 7 | 注册只能自己主动调；上限 3 条/会话（条数不是 target 数） | 没人自动注册；上限不是瓶颈 | team_link_watch :11305-11351；WATCHDOG_MAX_PER_SESSION :249 |
| 8 | 活性数据全在拉面 | 一次调用就全看见 | team_link_status ④⑤ 段 :11147-11170；list_sessions 活性行 :11033-11044 |
| 9 | 派生回执要主动读、点名读 | worker 干完是静默的 | taskMessageBlock :3889、renderReceiptRow :3981-3988 |

**对主会话诊断的两处更正（补强）**：

- **更正 1**：「全仓只有注册工具会启动定时器」不完全——启动清扫会把 settings 里持久化的注册重新挂上（createWatchdog.start :2452）。这恰是自动工作台的好消息：auto 注册持久化在 settings，重启后自动复活，无需再注册。
- **更正 2**：fix ② 原提法「首次调 team_link_status 时自动注册」不可行——team_link_status 的合同是「调用前后 settings 与磁盘逐字节不变」（工具描述 :11070）。自动注册的挂钩改在 /team_session 建队成功后（那里本来就在写 settings，且恰是 worker 出现的时刻）。

## §3 治标（①，零代码，今天可用）

### 3.1 岗位说明书（粘进协调者会话的 instructions / 系统提示）

```text
【团队协调者岗位】你在 roster 里担任 <团队名> 的 coordinator。这是岗位，不是名分：
1. 你只做管理与决策——分解、派活、收结果、验收、复核、评审、设计、推进；不亲自实施（不改代码、不跑测试、不做实现活）；实施一律派给 worker（team_link_send）或明确交还用户。
2. 每回合开工第一步：先读一次团队状态（team_link_status 或 team_link_list_sessions）——谁在跑、谁空闲、谁失联，数据一直在，一次调用就能拿到；不要凭「有没有人回话」猜。
3. 派活带任务号（t-<n>，与台账一致）；worker 回报后验收并给下一步；静默 ≥10 分钟先复核再催办。
4. 建队时插件已自动给你注册「全队工作台」看门狗；若没有，用 team_link_watch register 一条注册带全部 worker（见下）。
5. 每回合收尾自检：还有谁在跑？有没有活该派？有没有结果没验收？
```

### 3.2 手工注册全队看门狗（一条命令）

`team_link_watch register targets=[<w1>,<w2>,<w3>,<w4>] silentMinutes=10`

- 一条注册可带全部 worker（上限 3 是「条数」不是「target 数」，:249）；
- 注册持久化在 settings，重启后由启动清扫自动重挂（:2452）——一次注册，长期有效，TTL 默认 12h。

### 3.3 治标的边界（如实说）

只解决「这一个会话、这一轮之后」：换协调者、换会话、长会话压缩掉 instructions 之后都会退化。所以 ①②③ 三件一起做——治标止血，治本让插件自己扛。

## §4 治本 B（小）：看门狗 → 全队工作台

### 4.1 状态机：两类新「边沿 tick」

在 createWatchdog（:2291）里新增两张 process-local 表（与 ticked / deadWatchers 同生死，重启即忘——沿用 §3.2.3 既定约定）：

- `lastRunState: Map<entryId 加换行加 target, running | idle | not-live>`；
- `pendingTicks: Map<entryId, [{target, kind, at}]>`（观察者忙时的延迟队列，见 4.2）。

每轮 patrol 对每个 target 只读 `ctx.agents.get(target).status`（零日志成本），与上次记录比对：

| 边沿 | 含义 | tick |
| --- | --- | --- |
| running → idle | 刚干完一个回合，转入空闲 | just-finished（空闲待派） |
| idle / not-live → running | 开始干活 | started |
| 首次观测 | 无基线可比 | **只记基线，零 tick**（重启/新注册不刷屏；这也是既有断言「只 tick 三态」继续成立的关键，见 §6 回归 10） |
| 状态未变 | 无 | 零 |

冷却：同一 (entry, target, kind) 至少间隔 `WATCHDOG_TRANSITION_COOLDOWN_MS = 30min` 才再发（防高频跑批刷屏）。

tick 文案（固定常量，插值仅限状态字段——沿用 tickMessage 的纪律；「这不是失联」是必带句）：

- **just-finished**：
  `[watchdog] 目标 <target> 刚结束运行回合、现在空闲（读数 <readStamp>）——这不是失联：代理在场、无运行回合。若它有结果要验收或有新活要派，用 team_link_send；若没有活，忽略即可（静默达阈值后才会再报失联征兆）。`
- **started**：
  `[watchdog] 目标 <target> 开始运行一个回合（读数 <readStamp>）。若这是你派的活，无需动作；若不是，可用 team_link_list_sessions 复核它在做什么。`

实现：新增 `transitionTickMessage(watcherSession, target, kind, now)`，信封与 tickMessage 完全同构（id 前缀沿用 slp-wd-；source 恰三成员 relay；role=user）。**tickMessage 与 TICKABLE_VERDICTS 一字不动**（它们的逐字断言 :1811/:1814 继续钉住——「失联」与「空闲待派」用两类新 tick 区分，而不是改旧文案）。

### 4.2 忙时延迟补投（不再掐掉）

现状（:2393-2395）：观察者 running 或 goal armed-active ⇒ 整条 patrolOne return ⇒ 信号蒸发。

改为：忙时照跑「边沿检测 + 记基线」（只读 agents.get，零日志成本），事件进 pendingTicks；观察者回到空闲的下一轮 patrol 统一补投，补投文案带原观察时刻（`（信号观察于 <readStamp(at)>；本会话当时在忙，现在补投。）`），超过 `WATCHDOG_PENDING_TICK_MAX_MS = 60min` 的丢弃并留一行 warn。TTL 到期或观察者消失时清空该 entry 的 pending（forget() 扩展）。忙时**不**跑 verdict 巡检（读 surface 的贵路径照旧跳过）。

### 4.3 自动注册：全队工作台

挂钩点：/team_session 命令 handler（registerTeamSessionCommand :8198），在 pairs 段之后、完成清单之前：

- 条件：`!pairsAborted && workerIds.length > 0`（§10.2.8.9 ② 写时复检中止的「零写入」纪律**包含** watchdogs）。
- 动作：`applyTeamWorkbench(policy.get().watchdogs, { caller: coordinatorId, team: plan.team, targets: workerIds, now })`（纯函数，入 __testing）→ `policy.update({ watchdogs })` → `watchdog.schedule(entry)`（立即挂定时器，不等重启）。
- 语义（幂等，用则续）：
  - 已有该观察者的 auto 工作台（auto=true 且同 watcher+team）⇒ target 并集 + `expiresAt = now + 12h` 续期；
  - 否则新建一条：`{ id: wd-<uuid>, team, watcherSession: caller, targets: 未被该观察者任何注册覆盖的新 worker, silentMinutes: 10, intervalMinutes: 5, expiresAt: now+12h, createdAt: now, auto: true }`；
  - 新 worker 全被既有注册覆盖 ⇒ 零新增，完成清单如实说。
- 上限：auto 工作台不占 WATCHDOG_MAX_PER_SESSION（那是**手工**注册上限）；每 (watcher, team) 至多一条 auto。
- 披露：完成清单加一行 `- 全队工作台（自动看门狗）：已注册 wd-…（盯 N 个 worker，12h 到期，team_link_watch clear 可清；信号含「空闲待派」与「失联」两类）`；失败如实报「可手动 register」。确认框**不加行**（九件事实是裁定锁死的形状与预算；工作台是对观察者自己会话的、可撤销、TTL 有界的通知，不构成新信任面，完成回报披露足够）。
- 接线：registerTeamSessionCommand 增加 watchdog 形参（apply() 调用点 :11845 传入）。

### 4.4 schema 与工具面

- WatchdogConfig（:878-887）加 `auto: z.boolean().default(false)`（与 rotationStatus 同款的「声明字段带默认」纪律——手编 settings 行读回即规范形状）。
- team_link_watch：register 上限检查只数手工条（`own.filter(e => e.auto !== true).length`）；新增可选参数 `team`（[a-z0-9-]+，复用 readTeamName）——手工注册也可挂团队归属，补「预置会话组队」场景没有 /team_session 挂钩的缺口；list 输出 auto 条目加 `· 自动（全队工作台）` 标记；工具描述与实现同一次编辑更新（文档卫生 5）。
- team_link_status ③ 段：watchdogLines（:2948-2962）加 auto 标记；③ 段头注（:11144）「与团队只是弱关联」改为「自动注册的工作台带团队归属」。
- 状态卡 ⑤ 段、list_sessions 活性行不动（那是拉面，本来就好用——问题不在读面，在没人推）。

### 4.5 边界（如实说）

- 完全发生在协调者忙窗内的「起跑+跑完」（起前基线 idle、忙窗结束还是 idle）边沿不可见——worker 的 team_link_send 回报是这条缝隙的兜底；设计不为此加日志读（那会破 patrol 零日志成本）。
- 手工注册与 auto 工作台可能重叠覆盖同一 target ⇒ 该 target 收到两份 tick（各自去抖）。现状手工注册本来就不查重，本批不扩大手术，文档如实声明。
- agent-team 档不适用（teammate 不是根代理，看门狗盯不了——README 能力矩阵已有此格）。

## §5 治本 C（中）：协调者岗位说明书进插件

### 5.1 常量与渲染

`COORDINATOR_CHARTER_LINES`（Object.freeze 行数组，%team% 占位由 `coordinatorCharterLines(teamName)` 插值）：

```text
【岗位说明书 · 你是协调者，不是执行者】
你在团队 %team% 的 roster 里担任 coordinator。这是岗位，不是名分：
① 你只做管理与决策：分解任务、派活（team_link_send）、收结果、验收、复核、评审、设计、推进；不亲自实施（git、改代码、跑测试这类实施活派给 worker，或明确交还用户）。
② 每回合开工先读 team_link_status（团队状态卡）或 team_link_list_sessions：谁在跑、谁空闲、谁失联——一次调用就能拿到；不要凭「有没有人回话」猜。
③ worker 空闲待派就派活；静默超阈值（≥10min）先复核再催办；worker 干完要验收并给下一步，不要静默收场。
④ 需要盯人用 team_link_watch（一条注册可带全部 worker）；建队时插件已自动注册全队工作台，「空闲待派」与「失联」两类信号都会推到你这里。
⑤ 本说明书每次读 team_link_status 都会重新出现——上下文再压缩，每读一次卡就重新钉一遍。
```

### 5.2 upsert-team：两处落点

创建分支（applied.created，:4129-4138 之后）：

1. 返回文本追加岗位说明书全文（首行「已创建团队…」保持不动，既有断言继续钉住）。
2. 自投递一次：`ctx.agents.get(caller)?.followup(coordinatorCharterMessage(team.name, caller, now))`——信封复用 kickoff 同款（id 前缀 slp-charter-；source 恰三成员 `{kind: agent-message, form: relay, senderSessionId: caller}`；role=user；客户端 isOwnRelay 靠 slp- 前缀识别，lib/client.js:1628）。try/catch 失败留 warn、返回文本仍带全文（降级但绝不静默）。
   - 与 §11.2 命令「用 followup 驱动自己的会话（H3）」同一既有模式，不新增宿主事件类型（U19/U29 类「动作日志类型」断言继续成立）。
   - 幂等：既有团队分支（applied.created=false）零投递、零追加。

### 5.3 team_link_status：第 ⑧ 段

- 对每个 shown team：`selfId === 该团队 coordinator 角色的 current` 时渲染 `--- 岗位说明书（coordinator charter；仅对现任协调者渲染）---` + charterLines(team.name)；非现任不渲染（① 段已点名现任是谁，不重复）。
- 工具描述「七段」→「八段」**同一次编辑**改（文档卫生 1：计数与列表同改；:11070）。
- 全只读合同不动：⑧ 段是纯渲染，settings/磁盘零写。

## §6 测试计划（host-half.test.mjs；断言名供 grep）

1. **W1 自动工作台注册**：/team_session 成功后 settings.watchdogs 恰多一条 auto=true、team=plan.team、watcher=调用方、targets=全部新 worker、TTL=12h；watchdog.schedule 恰一次。
2. **W2 自动工作台幂等**：同 (watcher, team) 第二次建队 ⇒ target 并集 + expiresAt 续期，注册条数不变；新 worker 已被其他注册覆盖 ⇒ 零新增。
3. **W3 上限豁免**：手工注册满 3 条后建队仍能自动注册（auto 不计手工额度）；手工 register 的第 4 条仍被拒。
4. **W4 边沿 tick**：首次 patrol 零 tick（只记基线）；running→idle 恰一条 just-finished；idle→running 恰一条 started；状态未变零 tick；冷却窗内同边沿不重发。
5. **W5 忙时补投**：watcher running 时事件入 pending、零 followup；下一轮空闲 patrol 补投且带「观察于」时刻。
6. **W6 补投上限**：pending 超 60min 丢弃零投递 + warn；TTL 到期/观察者消失清空 pending。
7. **W7 文案锁**：just-finished 含「这不是失联」；两段文案逐字与常量一致；信封恰三成员、role=user、id 前缀 slp-wd-。
8. **W8 charter 返回与自投递**：upsert-team 创建返回含「不亲自实施」；self-followup 恰一次（信封恰三成员、id 前缀 slp-charter-）；既有团队分支零投递。
9. **W9 charter 状态卡**：现任协调者读卡见第 ⑧ 段（含「每读一次卡就重新钉一遍」）；非现任不渲染；工具描述含「八段」。
10. **回归（必须仍绿）**：:1809「只 tick 三态」（首次观测零 tick 保证）；:1811/:1814 tickMessage 逐字断言（tickMessage 未动）；U16/U17/U19/U30/U32 建队链路；U29 类「顶层键/动作日志类型」锁（新增写仍在 settings 命名空间内、无新宿主动作类型）；状态卡全只读断言。
11. **纪律**：修复前必红 / 修复后全绿各两次实测读数（AGENTS.md 三）。

## §7 文档同步（与实现同一次编辑）

- README.md：「工具一览」表（:296 起）watch / roster（upsert-team 创建返回含岗位说明书）/ status（八段）三行更新；「三、跨会话看门狗」小节补「全队工作台」、两类边沿 tick 与忙时补投；「设计文档索引」表（:1227 起）加本档一行；发布时更新 :1251「最近一次发布」。
- CHANGELOG.md：按「未发布」条目格式新增一条（版本号**不**现在 bump——仓库策略是发布时收口，CHANGELOG.md:3）。
- 工具描述与行为同编辑：team_link_watch / team_link_status / team_link_roster 三处 description。

## §8 实施顺序与部署

1. 治标 ①：把 §3.1 粘进协调者会话 instructions + §3.2 注册看门狗（零代码，先止血）。
2. 治本 B（§4）：schema + 状态机 + 自动注册 + 工具面。
3. 治本 C（§5）：charter 常量 + upsert-team + 状态卡 ⑧。
4. 全量测试 + 文档同步（§6/§7）。

部署：本仓是 link: 接线（AGENTS.md 四）——改完重启桌面即生效，无拷贝步骤；测试 `node host-half.test.mjs && node client-half.test.mjs`（不用 node --test，沙箱 spawn EPERM）。

## §9 会诊挂载点（主会话填写）

用户要求「用会诊出」。会诊工具只存在于主会话（子代理无 consult 面），纪要落地后由主会话：

1. 把 N 条意见逐条处置（采纳 / 驳回附理由 / 挂起）写进 docs/consult-minutes/2026-10-08-consult-<id>-minutes.md 的裁定层；
2. 与本档不一致的裁定，按会诊纪律 STOP 并向用户报告后，再决定是否修订本档 §4/§5。

（若会诊已在飞：本档即实施蓝本；若未启动：主会话先 consult_start。）

## §10 明确不做

- team_link_status 内自动注册（破全只读合同）——不做（§2 更正 2）。
- 状态双写、文件/settings 两条落点——不碰（AGENTS.md 七）。
- set-role 换任时自动给新协调者注册工作台：**扩展项**（对预置会话组队有价值，但会动 set-role 的「顶层键」类断言；不放进本批核心，避免爆炸半径）。
- tickMessage / TICKABLE_VERDICTS 文案改动——不做（逐字断言钉着；「失联」与「空闲待派」由新增两类 tick 区分，而不是改旧文案）。
- 给 worker 增投任何指令——不做（worker 已有 kickoff）。

（本文档即实施蓝本；证据账本按需补记进 docs/verification-log.md，只追加。）


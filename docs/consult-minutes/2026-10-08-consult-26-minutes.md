# 会诊纪要 —— consult #26（原始层，机制落盘）

- 日期：2026-10-08
- 会诊 id：26
- 模型：deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, kimi-api:kimi-k3, opencode-go-plan:mimo-v2.6-pro
- 平台 job：consult-3
- 结果：3/4 交付（其中 3 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #26 finished — 3 of 4 replied (1 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #26 finished — 3 of 4 replied (1 failed)]
effective: 3 of 4 (1 failed · 0 without content)
权限面如实（A30-10）：**本部署无法保证只读（平台面无法收窄）**——「只读」仅为**弱证**：`toolFilter.allow` 白名单**下发**（平台不保证模型面可见）；**模型面证据**须读子会话 `request/header` 事件（本部署实测 = [run_code] 单元素 ⇒ 残余绕行口在场，子会话实为 `danger-full-access`）。
models: deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, kimi-api:kimi-k3, opencode-go-plan:mimo-v2.6-pro
job: consult-3
minutes: docs/consult-minutes/2026-10-08-consult-26-minutes.md
requiresReport: true

--- replies (raw, unjudged — verify with your own tools) ---

[1] opencode-go-plan:mimo-v2.6-pro — failed
(consultation failed: child ended: error — 子代理面不可诊断（no diagnostic, and the child session log gave no turn/end reason — 本部署无法取得该证据：子会话 id / 会话档 / 解压任一不可得）)

[2] zai-coding-cn:glm-5.3 — ok
# dsh-team-link 协调者失位与活性盲区 · 治标+治本完整设计方案（会诊独立意见）

本轮所有行号为 2026-10-08 实读 `lib/index.js`（0.4.2）的 as-of 读数；每条机制断言都先经本轮重读复核，未沿用上轮记忆。

## 0. 对上一轮 ①②③ 提案的处置（会诊纪律：逐条裁定）

| 原案 | 裁定 | 理由（含本轮新证据） |
|---|---|---|
| ① 零代码：把岗位说明书写进会话 instructions + 注册全队看门狗 | **采纳，修正一处** | 修正：**不要写进仓库 AGENTS.md**。AGENTS.md 是全体代理共读的（worker 也读），「协调者禁止实施」写在那里会被 worker 错套到自己头上。落点应是**该协调者会话自己的 instructions**——那是唯一只对该会话生效、且扛得住压缩的载体。注册配方可行：注册本无 targets 数量上限（`buildWatchdogRegistration` 仅要求 ≥1 且禁自指，lib/index.js:2227-2231），「3」是每会话注册条数（:249） |
| ② 看门狗升级为「全队工作台」 | **采纳，加三道约束** | (a) 新信息走**每巡逻一条 digest 摘要**，不开每目标新 tick 支路——`tickMessage` 的反走私不变式（正文全常量、仅插值状态字段，lib/index.js:2252-2259）原样保留；(b) 告警类 tick 的 A1 抑制（观察者 running/armed-active 不打断，:2372-2395 注释明载是审计裁定）**原样不动**，只给 digest 开「running 也投」的口子——宿主语义本就支持「目标运行中→注入当前回合」（:11052），而这正是「协调者忙着实施、恰好需要被叫停」的那一刻；(c) digest 只在**有可行动内容**时投，全队 ok 且无状态迁移 ⇒ 零投递 |
| ③ 协调者 charter：upsert-team/status 返回带章程 + 建队时经 kickoff 通道投递一次 | **部分采纳** | 「upsert-team 返回带章程」「status 带提醒」采纳。「复用 kickoff 通道投递一次」**其实多余**：协调者就是命令/工具的调用者，`/team_session` 完成回报与工具返回本就直接落进它的历史——真正的洞不是「从没收到过」，是「长会话压缩后淡出」。治法是**高频小剂量重钉**（status 每次一行 + digest 脚注），不是再投一次大文本。另新增上轮漏掉的第四注入点：`/team_session` 完成回报（建队主路径，协调者必经） |
| （上轮未提）硬权限墙 | **明确不做，如实记因** | 插件无从拦截 git/文件/测试操作——`writerGate`（:3166-3180）只管插件自己的写面，宿主没有供插件否决其它工具的钩子。软墙（章程+提醒）已是插件侧上限；硬墙属宿主特性请求，单独立项，不混入本批 |

## 1. 根因 → 机制 → 修法映射（本轮实读复核）

| # | 根因 | 证据（as-of） | 修法落点 |
|---|---|---|---|
| R1a | 协调者从未收到任何角色指令；worker 有 kickoff（角色/汇报/「不要静默等待」），建队只回一句「下一步」 | kickoff：lib/index.js:7215-7249；创建者静默自举：3227-3231；「下一步」单行：4138 | P2 章程四注入点 |
| R1b | 无硬墙：writerGate 只管插件写面 | 3166-3180 | 不做，记边界（§6） |
| R1c | 仓库纪律推动「自己实测自己干」 | AGENTS.md 一、六 | P0 会话 instructions 对冲（明确豁免句） |
| R1d | 心跳醒来只见「核对/推进」，无强制派单清单 | 宿主侧 schedule，非本插件产物（全仓唯一 `watchdog.schedule` 在 :11346） | P0 改心跳指令文本；插件侧无权改 |
| R2a | 活性全靠拉：status ⑤/list_sessions 只在点名读窗内给 verdict | 11147-11170；11033-11044 | P1 digest 推送 |
| R2b | 唯一推送只报「已失联」：`TICKABLE_VERDICTS={silent-idle,goal-disarmed,dead}`，`ok`/`long-running` 零信号；且必须手动注册（注册是全仓唯一启动定时器处） | 246；2406；11327-11346 | P1 自动注册 + digest |
| R2c | 观察者一忙 tick 即被掐：running→return、armed-active→return | 2393-2395（A1/A4 注释 2372-2381） | P1 digest 例外（§4.6） |
| R2d | 完成是静默的；回执要点名读；tick 文案把一切写成「失联征兆」 | 回执四态：3970-3989；文案：2265 | P1「空闲待派/刚转空闲」语义 + digest 分组文案 |

## 2. 设计原则

1. **角色认知必须可压缩存活** ⇒ 靠高频工具返回重钉，不靠一次性大文本。
2. **活性从拉改推，且推不得在观察者最忙时静默** ⇒ digest 例外穿透 A1。
3. **信号语义分离**：失联（要处置）≠ 空闲待派（要派活）≠ 运行中（别催）。
4. **最小差分**：告警 tick、去抖水印、TTL、反走私不变式、§七单写落点全部原样。
5. **可测**：新断言全部具名可 grep，红绿两次读数入账（AGENTS.md 一、三）。

## 3. P0 治标（今天可用，零代码）

**3.1 协调者会话 instructions 粘贴块**（落该会话的 instructions，不是 AGENTS.md）：

> 你是本团队的协调者。职责：拆解、派活（team_link_send 带 ref=t-<n>）、验收（结论/证据/下一步齐备才算完成）、决策与整合、维护黑板台账。**默认禁止亲手实施**（写代码/改文件/跑长命令/git 操作），除非全员不可用或用户明确要求；「必须实测」的仓库纪律由 worker 执行、你只验收证据。每个回合开工先跑一次 team_link_status，先读「活性」段再决定派谁/催谁。有空闲 worker 且手头有活 ⇒ 派发，不要自己做。等待时不静默：全员忙 ⇒ 等最近一次推送；全员闲且无方向 ⇒ 向用户要方向。

**3.2 看门狗一次注册全队**（无 targets 上限，实测 ：2227-2231）：
`team_link_watch action=register targets=[w1,w2,w3,w4] silentMinutes=10 intervalMinutes=10 ttlHours=24`

**3.3 心跳指令模板**（改该会话宿主侧 schedule 的指令文本）：醒来后①跑 `team_link_status`；②有空闲 worker 且台账有未派活 ⇒ `team_link_send` 派出并记台账；③有失联征兆 ⇒ 按处置；④无事 ⇒ 一句话向用户报状态。**禁止自己开新实施工作。**

## 4. P1 治本-A：看门狗 → 全队工作台（digest）

**4.1 目标行为**：观察者不必拉，就能周期性收到一条分组摘要——谁在跑 / 谁空闲待派 / 谁刚干完（running→idle）/ 谁需处置（三告警态）。

**4.2 数据结构**（向后兼容）：watchdog entry 增 `origin: "manual"|"auto"`（缺省视为 manual，存量 policy 行零迁移）；已存在的 `team: null` 字段（:2241）在 auto 注册时填团队名——字段早就在，只是从没用过。用户 3 条上限的 `own` 过滤（:11325）改为**只数 manual**，auto 不占额度。

**4.3 自动注册两个触发点**（皆有先例：rotation sweep 搭 lazy 调用，:2429-2432）：
- **A. `/team_session` 批量建队完成且 ≥1 成功**：watcher=协调者（caller，注册本要求 exec.agent.id，:11320）、targets=本次新建各会话、team=plan.team、origin=auto、silent=10/interval=10/ttl=12h。
- **B. 懒自愈**：`team_link_status` 时调用者恰为某团队现任协调者，且没有任何 live 注册（manual 或 auto）覆盖该团队任一成员 ⇒ 补一条 auto 注册，targets=该团队现役非协调者角色现任。非协调者调用 ⇒ 零写入。用户手动 clear 掉 auto 注册后，本进程内记一条抑制标记不再自愈（进程内即可，重启复活——与 `ticked`/`deadWatchers` 同款取舍，:2284-2289）。

**4.4 digest 文案**（常量，仅插值状态字段，沿反走私不变式）：

```
[workbench] 团队 <team> 工作台（读数 <stamp>）
运行中：<id>(…), <id>(…)
空闲待派：<id>（静默 x.xmin）, <id>(…)
刚转空闲：<id>
需处置：<id>（verdict=silent-idle 静默 x.xmin）…
角色提醒：你是协调者——派活/评审/决策，不亲手实施。复核 team_link_status；不需要盯人可 team_link_watch clear <id>。
```

消息 id 前缀 `slp-wb-`（客户端卡片按 `slp-` 茎识别，:258-259 ⇒ 现有渲染直接吃到）。

**4.5 迁移检测**：进程内 `lastAgentState` map（按 注册×目标）；`prev=running ∧ now=idle ∧ verdict=ok` ⇒ 进「刚转空闲」组。这就是「worker 干完活」的推送信号——不用 worker 多发一个字。

**4.6 抑制策略**（对 A1 的精确让步，不推翻审计）：
- 告警 tick（silent-idle/goal-disarmed/dead）：**原样**走 running/armed 抑制与既有去抖；
- digest：观察者 not-live ⇒ 不投（无处落，A4 同理）；running/armed ⇒ **照投**（注入当前回合正是宿主语义 :11052，且恰是纠偏时刻）；去抖：同一注册两条 digest 间隔 ≥10min，且仅当有可行动内容（空闲待派∪刚转空闲∪需处置 非空），否则零投递。

**4.7 防噪预算**：每巡逻每注册至多 1 条 digest；无新读成本（surface 读取与今日 patrolOne 完全同面）；TTL 沿用注册自清（:2383-2386）。

**4.8 §七合规**：注册仍走 `policy.update({watchdogs})`（:11342 同通道）——单写落点、placement 首行（R2 红线）均不动。

**4.9 边界**：agent-team 档下成员不在会话注册表（`ctx.agents` 面），targets 解析为空 ⇒ 不自动注册、返回里如实一行说明；多团队协调者每队一条 auto，digest 各自独立。

## 5. P2 治本-B：协调者章程

**5.1 常量** `COORDINATOR_CHARTER(team, cwd)`：全文即 §3.1 粘贴块的插件化版本（含「验收标准：结论/证据/下一步」「等待不静默」），一次写死在常量区。

**5.2 四个注入点**：
1. `upsert-team` 创建分支（:4129-4138 的 `lines`）追加章程全文（创建即认领的那一刻 = 角色诞生点）；
2. `/team_session` 完成回报追加章程（建队主路径，协调者必经；上轮漏掉的这个点其实是覆盖率最高的一个）；
3. `team_link_status`：当 selfId ∈ 所示团队的现任协调者时，在**第 2 行**（placementLine 必须仍是首行，R2 红线 ：11131）插一行紧凑提醒：`角色提醒：你是团队 X 的协调者——派活/评审/决策，不亲手实施；先读本卡「活性」再派活。` 非协调者调用 ⇒ 无此行，零噪声；
4. digest 脚注（§4.4）——推送到达的那一刻同步重钉。

**5.3 为什么不再走 kickoff 通道**：worker kickoff 用 `handle.agent.followup(relayUserMessage(...))`（:7458、7935-7946）是因为新会话没有别的输入口；协调者是调用方，命令/工具返回天然在其历史里。一次性再投一份大文本不解决压缩淡出，§5.2-3/4 的高频小剂量才解决。

## 6. 明确不做（记入设计档「不做」节）

硬墙（无宿主钩子，插件无法否决 git/文件/测试操作）；自动切 agent-team 档（红线 6 既有）；改宿主侧心跳（非插件产物，P0 文本对冲）；任何双写状态（§七）。

## 7. 测试计划（全部具名，可 grep；红→绿两次读数入 verification-log）

`host-half.test.mjs` 新增：**U-WB1** auto 注册写入（origin/team/watcher/targets 断言 + manual 额度仍 0）；**U-WB2** 懒自愈正/反两支（协调者补、非协调者零写入）；**U-WB3** digest 投递（fixture：1 idle-ok + 1 running ⇒ 一条 digest 含「空闲待派」「运行中」与两 id；观察者 running 仍投）；**U-WB4** 无事零投；**U-WB5** 刚转空闲行 + 水印去抖；**U-WB6** 告警支原样（旧「失联征兆」断言不红）；**U-WB7** 文案常量静态断言（无调用方可注入的模板参数）；**U-CH1** upsert-team 创建支含章程关键字；**U-CH2** status 首行仍 placementLine、第 2 行提醒仅在现任协调者时在场；**U-CH3** 完成回报含章程。`client-half.test.mjs`：`slp-wb-` 前缀经 `slp-` 茎进卡片渲染。桩面警示（AGENTS.md §四）：本设计**零新宿主 API**（followup/policy.update 均既有调用），无 standingKeyFor 类断层风险，但实现时仍须静态比对 `ctx.agents.get(...).followup` 调用面与宿主一致。

## 8. 上线与验证

`link:` 接线 ⇒ 改完重启即生效；重启前确认无在飞作业、先 `git stash create` 上保险（§八）；U-WB/U-CH 红/绿两读数 + 设计档 `docs/coordinator-charter-workbench-design-2026-10-08.md` + verification-log 追加；README 变更史一行（工作台摘要/协调者章程属用户可见能力）。

## 9. 风险表

| 风险 | 缓解 |
|---|---|
| digest 打断正在实施的回合 | 正是设计意图（纠偏时刻）；≥10min 去抖 + actionable-only + 可 clear + TTL |
| clear 后自愈复活惹恼用户 | 进程内抑制标记；文档明示重启复活 |
| status 加行破坏首行红线 | U-CH2 专测首行 |
| agent-team 档误注册 | targets 空 ⇒ 不注册 + 如实一行 |
| 大团队 digest 过长 | 行数=targets 数，targets bounded by /team_session≤8 + 手补角色；每行有界 |

## 10. 排期建议

P0 立即（用户可自行粘贴）；P1（中，~1 批：注册面+digest+测试）先行；P2（小，~半批：常量+四注入点）随 P1 同批或紧随——P1/P2 无相互依赖，可并行实做、一次重启收口。

[3] deepseek-official:deepseek-v4-pro — ok
设计文档已落盘并回读验证通过。最后一处锚点检查的 `false` 是误报——「coordinator-workbench」只存在于文件名，不在正文里；其余四个内容锚点全部在场。

```dsh-ui
{"title":"交付：治标+治本完整设计方案","gap":12,"items":[{"type":"callout","tone":"success","title":"交付物","content":"docs/coordinator-workbench-design-2026-10-08.md（197 行，无 BOM、无 U+FFFD，写后回读通过）。全部机制断言基于逐段读 lib/index.js（12052 行）实测坐标，每条例证都带 as-of 行号。"},{"type":"table","columns":["方案","内容","改动量"],"rows":[["① 治标","§3：协调者岗位说明书全文（粘进会话 instructions，扛上下文压缩）+ 一条覆盖全队的 team_link_watch register","零代码，今天可用"],["② 治本 B","§4：看门狗→全队工作台。自动注册（/team_session 挂钩、auto 字段、12h 用则续期）+ 两类边沿 tick（just-finished「这不是失联」/ started）+ 忙时延迟补投队列","小（schema+状态机+工具面）"],["③ 治本 C","§5：COORDINATOR_CHARTER 常量 + upsert-team 建队返回全文与自投递（slp-charter- 信封，复用 H3 self-followup 模式）+ team_link_status 第⑧段（七段→八段同编辑改）","中"]]},{"type":"table","columns":["对主会话诊断的更正","要点"],"rows":[["更正 1","「只有注册工具启动定时器」不准确——启动清扫 lib/index.js:2452 会重挂持久化注册 ⇒ auto 工作台重启自动复活，是好消息"],["更正 2","「首次调 team_link_status 自动注册」不可行——该工具合同是全只读（描述 :11070）；挂钩改在 /team_session 建队成功处"]]},{"type":"steps","steps":[{"title":"§9 会诊挂载点（需主会话处理）","desc":"本子代理没有 consult 工具（consult 仅顶层可用）。文档已预留 §9：主会话先 consult_start，纪要落地后逐条处置写进 docs/consult-minutes/2026-10-08-consult-<id>-minutes.md，不一致裁定按纪律 STOP 报告用户后再修订 §4/§5。"},{"title":"实施顺序（文档 §8）","desc":"① 止血（粘 instructions + 手工注册）→ ② 治本 B（schema+状态机+自动注册）→ ③ 治本 C（charter 三落点）→ 测试（W1–W9 断言名已列 + 回归清单，修复前必红/修复后全绿两次）+ 文档同步（README 工具一览/看门狗节/设计索引、CHANGELOG 未发布条目、三处工具描述同编辑）。"}]}]}
```

**关键设计裁定（供你采纳或驳回）：**
- 边沿 tick 用「首次观测只记基线、零 tick」保证既有断言 `host-half.test.mjs:1809`（只 tick 三态）继续绿；`tickMessage`/`TICKABLE_VERDICTS` 一字不动，其逐字断言（:1811/:1814）继续钉住。
- auto 工作台不占手工注册上限 3 条，每 (watcher, team) 至多一条；写时复检中止（pairsAborted）时零写入纪律包含 watchdogs。
- charter 自投递复用 kickoff 信封（source 恰三成员 relay、role=user、`slp-` 前缀走客户端既有识别），不新增宿主事件类型，U19/U29 类类型锁不破。

**给主会话的下一步建议**：启动会诊（若未启动）→ 按会诊纪律处理纪要并回报用户 → 得到认可后按文档 §8 顺序实施。

[4] kimi-api:kimi-k3 — ok
设计档已落盘并回读校验通过（178 行、无 BOM、无替换字符、锚点全在、与写入原文逐字一致）。

---

## 交付：完整设计方案已就绪（治标+治本），待主会话发起会诊

**先说限制**：`consult_start`（会诊）不在我的工具表里 —— 我是子代理，权限范围在建号时锁死，会诊只有顶层代理能发起。所以我把方案做成了**会诊可直接裁定**的形状：决策点全部抽成 D1–D8 逐条给选项+推荐（见下表），主会话把设计档路径 + 这张表喂给 `consult_start` 即可。

设计档：[coordinator-charter-liveness-design-2026-10-08.md](docs/coordinator-charter-liveness-design-2026-10-08.md)（§1 机制实勘 / §2 宿主能力地基 / §4 治标 / §5–6 治本 / §8 决策点 / §9 批次 / §10 测试断言清单 / §11 文档同步）

**本次实勘比原诊断多挖到一块地基，直接升级了③**：宿主 `dsh-system-prompt` 服务的 section **支持函数型 text、每次装配重新求值**，且支持 `agent.ctx` 按会话作用域注册（`TEAM_POLICY=600` 槽位就是宿主自己的 agent-team 插件在用）——本部署 node_modules 里有两个同形先例（`dsh-file-reference-local:364-372` 的全 agent 安装/释放生命周期、`dsh-experimental-tool-agent-team` 的 `team:policy` 段）。这意味着「你是协调者」可以做成**扛上下文压缩、且永远按 roster 最新状态实时渲染**的系统提示段：角色一移交，下回合自动消失；一落到某会话，下回合自动出现 —— 零记账、重启零迁移。原诊断设想的「靠工具返回重钉」降级为兜底面。

三层方案一句话版：

- **① 治标（今天可用，零代码）**：协调者会话 instructions 写死岗位说明书（§4.1 给了可直接粘贴的原文）+ 手工注册一条带全部 worker 的看门狗（不占满 3 条上限）。
- **② 治本一半（插件小批）**：看门狗升级「全队工作台」—— 新 tick 类 `idle-await`（「它最后说话了、之后无人找它、无自续跑 goal」= 干完待派，**不动 verdictOf 五态契约**，去抖键加 kind 层，文案与「失联」严格区分）；`/team_session` 成批后**自动注册**（同团队复用一条、追加 targets、TTL 顺延，失败隔离）；工作台类 tick 在协调者忙/有 goal 时**放行**（事故根因正是忙时被掐）；报警类两道门原样保留。
- **③ 治本另一半（插件中批）**：协调者 charter 系统提示段（§6.1 机制 + §6.2 文案 + §6.3 降级面），另明确划线：**不做硬墙**（插件拦不住协调者调 bash，那是宿主工具门的能力面）。

```dsh-ui
{"title":"会诊裁定表（D1–D8，已附推荐）","gap":10,"items":[{"type":"table","columns":["#","决策点","选项","推荐"],"rows":[["D1","idle-await 在协调者 running / goal armed-active 时是否放行","都放行 / 只放 running / 都不放","都放行——事故根因就是忙时收不到"],["D2","建队自动注册看门狗默认开关","默认开 / 配置项 / 默认关","默认开——「没人注册」是根因之一"],["D3","手工 register 的 watchIdle 默认值","false（既有行为逐字不变）/ true","false"],["D4","team_link_status 加 charter 提醒行","加 / 不加","加（降级面顺带重钉）"],["D5","worker 段（「你向 X 汇报，不要静默等待」）是否同批做","同批 / 后续批","同批——同机制零边际成本，治 kickoff 被压缩冲淡"],["D6","silent-idle 文案「失联征兆」改称「静默超时」","改 / 保留","改——与「干完待派」严格区分"],["D7","自动注册 TTL 策略","同团队新批次顺延 12h / 固定不续","顺延"],["D8","goal 服务缺席（goal=null）时 idle-await 是否命中","命中 / 不命中","命中——worker 通常无 goal，缺席≠有 goal"]]},{"type":"callout","tone":"info","title":"实施批次（§9）与验收（§10）","content":"批1=②看门狗（改动集中在 lib/index.js 2224-2273 / 2349-2415 / 11305-11351 / 8303-8334 四段+常量区）；批2=③charter；批3=文档同步。§10 已给出 12 条可 grep 的断言名（charter-render-coordinator / idle-await-classifier-matrix / auto-watch-on-batch 等），每批按 AGENTS.md §三要「修复前必红 / 修复后全绿」两次实测读数。"}]}
```

**建议主会话下一步**：以设计档 §8 的 D1–D8 为 brief 核心发起会诊（症状+已试+入口文件 ~150 词），裁定后按 §9 批次排单；若想先止血，§4 的 instructions 原文与看门狗注册命令今天就能直接给用户。
```

## §2 逐问裁定（**主代理写**）

**有效数 3 / 4**：`opencode-go-plan:mimo-v2.6-pro` 失败（子代理面不可诊断），下表只记它失败、不裁定内容。

| 来源 | 关键意见 | 处置 | 理由 / 证据 |
| --- | --- | --- | --- |
| [1] mimo-v2.6-pro | （无内容） | **失败** | digest 原文：child ended: error，取不到子会话证据 |
| [2] glm-5.3 | 宪章**不要**写进 `AGENTS.md`（worker 也读，会错套） | **采纳** | 落点＝协调者会话自己的载体；列为红线 |
| [2] | 注册本无 targets 数量上限，「3」是**注册条数** | **采纳** | 与父侧实测一致（`lib/index.js:2227-2231`、`:249`） |
| [2] | 新信息走**每巡逻一条 digest**，不开每目标新 tick 支路 | **采纳** | 保住 `tickMessage` 的反走私不变式（`:2252-2259`） |
| [2] | 告警 tick 的 A1 抑制原样，只给工作台 digest 开「忙时也投」 | **采纳**（改审计行为 ⇒ 列 **D-A1**） | 根因正是「忙时被掐」（`:2393-2395`） |
| [2] | 宪章四注入点：upsert-team / `/team_session` 完成回报 / status 第 2 行 / digest 脚注 | **采纳** | 与父侧层 1 合并；status 只加行不写盘 ⇒ 不破只读合同 |
| [2] | 不再经 kickoff 通道补投大文本 | **采纳** | 压缩淡出靠高频小剂量重钉 |
| [2] | **在 `team_link_status` 里「懒自愈」补注册** | **驳回** | 与状态卡合同冲突：「全只读：调用前后 settings 与磁盘文件逐字节不变（不写、不缓存）」（`:11070`）；[3] 独立同指 |
| [2] | 硬墙不做 | **采纳（父侧随后更正其理由）** | `writerGate` 只管插件写面不假；但「宿主无否决钩子」**不成立**——`tools.restrict` 在 agent 作用域可用且可撤销，见 §3 更正 6 |
| [3] deepseek-v4-pro | 自动注册挂 `/team_session` 建队成功处，不放 status | **采纳** | 同只读合同；注册要求 `exec.agent.id` |
| [3] | 「启动清扫会重挂持久化注册 ⇒ auto 重启自动复活」 | **驳回（父侧实测否证）** | `patrol()` 只被定时器回调调用；`schedule()` 全仓仅一处（`:11346`）⇒ 重启后注册是**哑的**。新增 L2-a2 并把既有手工注册的同一缺陷登记待修 |
| [3] | 边沿 tick「首次观测只记基线、零 tick」，保既有断言 | **采纳** | 防回归（判据 U7） |
| [3] | auto 不占手工 3 条上限，每 (watcher, team) 至多一条 | **采纳** | `own` 过滤改只数 manual |
| [3] | charter 走 `slp-charter-` 信封自投递 | **部分采纳** | 信封形状可行；但「再投一次大文本」与 [2] 冲突 ⇒ 只保留**返回面**落点 |
| [3] | 擅自写入 `docs/coordinator-workbench-design-2026-10-08.md` | **产物迁出** | 会诊本应只读（§4 教训 1） |
| [4] kimi-k3 | `section` / `context` 的 `text` 可为**函数**、每次装配求值 | **采纳（父侧已复核源码）** | `assemble()`：`text: typeof section.text === "function" ? section.text(context) : section.text` ⇒ 父侧「变量 + 段」简化为「函数型 text 一段」；函数仍须同步 |
| [4] | 按 `agent.ctx` 作用域注册、用 `TEAM_POLICY = 600` 槽位 | **采纳** | 父侧独立实测同一结论；先例 `dsh-experimental-tool-agent-team` / `dsh-file-reference-local` |
| [4] | `idle-await` 新 tick 类，**不碰** `verdictOf` 五态契约 | **采纳** | 新增类不改五态 |
| [4] | 工作台类 tick 忙时放行；报警类两门原样 | **采纳**（同 D-A1） | 与 [2] 一致 |
| [4] | 同团队复用一条、追加 targets、TTL 顺延 | **采纳** | —— |
| [4] | D1–D8 决策表 | **采纳为待裁定清单**（并入 D-A1…D-A6） | 决策权在用户 |
| [4] | 擅自写入 `docs/coordinator-charter-liveness-design-2026-10-08.md` | **产物迁出** | 同上 |

## §3 分歧与父侧裁定（**主代理写**）

**分歧 1 —— 「懒自愈」注册 vs 状态卡只读合同。** [2] 主张在 `team_link_status` 里补注册；[3] 指出该卡是全只读。
**裁定：[3] 对**。合同原文在场（`lib/index.js:11070`）；自动注册改挂 `/team_session` 建队成功处。

**分歧 2 —— 「重启后自动复活」。** [3] 断言启动清扫会重挂持久化注册。**裁定：驳回（父侧实测否证）**——
`patrol()` 只在定时器回调里被调用，`schedule()` 全仓唯一调用点是注册工具（`lib/index.js:11346`）⇒
持久化注册在重启后**没有任何定时器**（哑）。设计新增 L2-a2「attach 统一重挂」，并登记既有缺陷一条。

**分歧 3 —— 工作台 digest 是否「观察者忙时也投」。** [2][4] 主张放行；这与已审计的 A1 抑制冲突。
**裁定：倾向采纳，但属改动已审计行为 ⇒ 列 D-A1 交用户**；未获批前按现状（不投）。

**分歧 4 —— 宪章载体：系统提示段 vs 工具返回重钉。** **裁定：两者都要**——提示段为主干（扛压缩、按 roster 实时渲染），
工具返回与 digest 脚注为降级面与重钉。

**分歧 5 —— 子会话产出文件是否入库。** **裁定：不算本仓设计档**，已迁至
`docs/consult-minutes/artifacts-2026-10-08-consult-26/`；§1 原始层里出现的 `docs/` 旧路径以本裁定为准。

### 待用户裁定（决策点收敛）

| # | 决策点 | 推荐 |
| --- | --- | --- |
| D-A1 | 工作台 digest 在观察者 running / armed-active 时**也投**（穿透 A1） | 准 |
| D-A2 | 是否先落「P0 零代码止血」（协调者会话 instructions 粘贴块 + 手工注册全队看门狗） | 先落 |
| D-A3 | 宪章主干走 `agent.ctx.systemPrompt.section`（宿主内部面：需接受新依赖 + 降级面） | 接受 |
| D-A4 | 自动注册挂钩点＝`/team_session` 成功处（**不在** status 卡） | 准 |
| D-A5 | worker 侧角色段（「你向 X 汇报 / 不要静默等待」）是否同批做 | 同批 |
| D-A6 | 硬墙：**技术可行**（`agent.ctx.tools.restrict({deny})`，默认关）还是不做 | 本批不做，登记为可选特性 + 三条待实测 |

**更正 6（父侧，2026-10-08）**：上表「硬墙不做」的**理由**由父侧更正——原文写「宿主没有供插件否决其它工具的钩子」，
本轮实读 `dsh-tools` 源码否证：`restrict(filter)` 明确要求 `agent.ctx`（作用域化），支持 `allow/deny`，并返回可撤销的 disposer。
⇒ 结论从「做不到」改为「**做得到，但有三个未测前置**（PTC 内层解析 / 可撤销性 / 与 scoped 注册的交互）」，
本批仍**不做**（它会连带堵死「用户让它自己做」的路），只登记为可选特性。设计档同步见 §4 层 4 与 §11。

## §4 教训（**主代理写**）

1. **会诊子会话在本部署不是只读**（digest 自述：白名单仅「下发」，子会话实测 `danger-full-access`），
   且**真的写了两份 18–20KB 的档进仓** ⇒ 纪律：**会诊前后各跑一次 `git status`**；子会话产出先当「外来物」，
   裁定前不进 `docs/` 根。
2. **父侧 v0.2 有一条机制断言不完整**：只看到 `variable()` 是动态面，漏了 `section.text` 也支持函数型
   ⇒ 机制断言必须读**装配处**的源码（`assemble()`），不从单一 API 推断全局。
3. **父侧原案 L2-a 违反了自己产品的合同**：想在 `team_link_status` 里自动注册，而该卡明写「全只读」
   ⇒ 复用某个面之前，先读**那个面自己的合同文本**。
4. 有效数 3/4：一条子会话失败且**不可诊断**，如实登记，不补编它的意见。

## §5 不可验清单（**主代理写**）

- **（2026-10-08 更正）** 原写「测试桩里没有对应面 ⇒ 套件无法端到端验」，实测后收窄：夹具的假 agent 是裸对象
  （`host-half.test.mjs:56` / `:600` / `:655` 都没有 `.ctx`），所以
  **降级路径今天就天然可测**；**注册 / 作用域 / 释放三条**只需给假 agent 加一个
  `ctx.systemPrompt.{section,getSectionOrder}` 桩即可断言（夹具在本仓，属可测）。
  **真正不可验的只剩**：活体 Agent 的 `agent.ctx` 是否真的把段路由到该会话自己的作用域（宿主行为）⇒ 真机冒烟。
  **（同日再更正）** 本条风险进一步下降：本部署**用户插件已有三个先例**在用这条路
  （`dsh-thincoder-suite/lib/eng.mjs` 的 agent 作用域挂载 + 同款特征探测守卫、`dsh-vision-bridge` 的函数型 context、
  `dsh-genui` 的段注册）⇒ 从「未验证的宿主内部面」降为「**本机有活先例，仍需真机冒烟确认本插件自己注册生效**」。
  设计仍把它写成**可降级**层（L3-d），不是必需层。
- 「工作台 digest 忙时也投」的真实纠偏效果：离线不可验，需目标团队真机 A/B（D-A1 批准后）。
- [1] `mimo-v2.6-pro` 的失败原因不可诊断（digest 原文；本部署取不到子会话证据）。
- [2][4] 写入的两份档：父侧只核过标题与若干关键断言，**未逐字复核**（已迁入 artifacts，作参考不作依据）。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-10-08 | 机制落盘（§0 汇总 + §1 原始层） |
| 2026-10-08 | 主代理补写 §2–§5（逐问裁定 / 分歧裁定 / 教训 / 不可验）；子会话产出迁入 `artifacts-2026-10-08-consult-26/` |
| 2026-10-08 | §5 更正：不可验面收窄（降级路径现成可测；注册/作用域/释放仅需夹具加桩）；同批把判据可测性分级写进设计档 §9 |
| 2026-10-08 | §5 再度更正：本机三个用户插件已有 `systemPrompt.section/context` 活先例 ⇒ D-A3 风险降级；设计档新增 §4 层 3 · L3-f |
| 2026-10-08 | **§2/§3 更正 6**：「宿主无否决钩子」被实读否证（`tools.restrict` 在 agent 作用域可用且可撤销）⇒ D-A6 由「做不到」改为「做得到但有三个未测前置」；设计档新增 §4 层 4。§1 原始层保持逐字不动 |

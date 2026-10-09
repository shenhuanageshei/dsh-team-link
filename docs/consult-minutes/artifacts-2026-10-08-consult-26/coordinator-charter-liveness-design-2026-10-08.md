# 协调者 charter 与活性推送设计（2026-10-08）

> 状态：**待会诊裁定**（决策点见 §8，逐条给选项与推荐）。
> 触发：真机事故 —— 手工建队的协调者会话 ① 不知道自己是协调者（自己开干实施）；
> ② 不知道 worker 在跑还是在闲（活性全靠拉、唯一推送只在已失联时响且它一忙就被掐掉）。
> 本文所有代码坐标为 2026-10-08 实勘读数（as-of 括注），行号漂移时以函数名重新定位。

## §1 问题机制（实勘结论，坐标即证据）

**Q1 协调者为什么自己开干** —— 「协调者」在插件侧只是名册字段，从来不是一条发给它的指令：

- worker 一出生就收到 kickoff（角色 / 向谁汇报 / 不要静默等待）：`teamSessionKickoffText`（lib/index.js:7215-7249），经 `handle.agent.followup` 投递（:7458）。
- 协调者是用户手工建的会话：`applyTeamUpsert` 只把创建者会话播种进 roster（:3227-3231，note「创建者自举」），建队返回仅一句「下一步」（:4138）——**全程没有任何角色指令注入协调者会话**。
- `writerGate`（:3166-3180）/ `retireGate`（:3188-3198）只约束插件写操作（名册 / 黑板）；对 git、改代码、跑测试**零约束**——「协调者不实施」至今是纯口头约定。
- 长会话被压缩后，连对话里那句「你是主管」也会淡掉 —— 唯一扛压缩的载体是系统提示 / instructions。

**Q2 为什么不知道 worker 在没在干活** —— 活性面是「拉」的，唯一的「推」恰好在最需要的时刻被掐掉：

- 拉：`team_link_status` 会话面 + 活性两段（:11147-11170）、`team_link_list_sessions` 活性行（:11039-11044），数据一次调用全有。
- 推：看门狗 tick 是唯一推送，但 ① 必须手工注册（全仓唯一 `watchdog.schedule` 调用在 register 路径 :11346；开机再水化在 `start()` :2451-2460）；② 只对 `TICKABLE_VERDICTS = {silent-idle, goal-disarmed, dead}`（:246）发 tick —— **worker 正常在跑 / 干完等派单 = 零信号**；③ 观察者「运行中」或 goal armed-active 时 `patrolOne` 直接 return（:2393-2395）——协调者越忙越收不到；④ tick 文案把静默一律写成「失联征兆」（:2265），「干完等派单」被误述成「失联」。
- 事故现场读数（2026-10-08 18:19:58 点名读）：w1 闲 9.0min、w4 闲 5.7min、w2/w3 在跑 —— 两个 worker 干完等派单，协调者毫不知情。

## §2 已核实的宿主能力（设计地基；全部读本部署 node_modules 原文）

1. **system-prompt 段可以是函数，每次装配都重新求值**：`dsh-system-prompt/lib/index.js` 的 `assemble()` —— `text: typeof section.text === "function" ? section.text(context) : section.text`；`renderPrompt` 丢弃空文本段。⇒ 一段「按 roster 实时渲染、不是协调者就自动空串隐藏」的系统提示段**在机制上成立**。
2. **可按 agent 作用域注册**：`PromptLayer` 报错文案明示「for a per-agent override, register through that agent's `agent.ctx`」；`section()` 返回 disposer。`SECTION_ORDERS.TEAM_POLICY = 600`（PLAN_POLICY 之后、工具段之前）——宿主自己的 `dsh-experimental-tool-agent-team` 就用这个槽位（`name: "team:policy"`）。
3. **本部署就有两个同形先例**：`dsh-file-reference-local/lib/index.js:364-372` —— `for (const agent of ctx.agents.list()) installPrompt(agent)` + `ctx.on("agent/created")` 安装 + `agent/disposed` 释放，且 text 就是函数（`text: () => … === void 0 ? "" : PROMPT`）；`dsh-experimental-tool-agent-team` 在 `install(agent, …)` 里 `agent.ctx.systemPrompt.section({…})`。
4. **插件侧现状**：`inject = ["sessionReferenceResolver","tools","sessionQuery","agents"]`（lib/index.js:100）——不含 systemPrompt，故走**可选服务**路径（`agent.ctx.get?.("systemPrompt")`，与 :7685 取 agentPresets 同一套路），缺席 ⇒ 一条 warn + 降级（§6.3），绝不硬炸。
5. **活性信号面够分出新 tick 类，且零新增读面成本**：`buildLivenessSignal`（:620-647）已给出 `lastAssistantAt / lastInboundAt / turnStartedAt / silenceMs / goal`；`patrolOne` 每个目标已构建 signal（:2399-2405），新分类器复用同一份。`verdictOf`（:592-609）是 §3.1 五态契约，所有读面共用 —— **不动它**，新分类器放看门狗层。
6. **去抖键天然可扩展**：`recentlyTicked / markTicked`（:2349-2358）键为 `${id}\n${target}`、水位为 `lastActivityOf(signal)` —— 键里加一层 kind 即可让两类 tick 独立去抖；worker 再说话水位前进，新的「等派单期」允许再 tick。
7. **tick id 前缀 `slp-wd-`（:259）被客户端卡片识别** —— 新 tick 类**沿用同一前缀**，种类只进正文 ⇒ 客户端零改动。
8. **`/team_session` 完成回报**（:8304-8334）是自动注册的天然挂载点：pairs 授予（:8294-8303）之后、行渲染之前，created worker id 与 coordinatorId 都在手。
9. **`policy.get()` 同步可读**（patrol :2425 已在用）⇒ charter 的 text 函数每次装配调它，成本可忽略。
10. **注册条数上限 `WATCHDOG_MAX_PER_SESSION = 3`（:249）按「注册条数」计**，一条注册的 targets 不限 —— 自动注册必须「同团队复用一条、追加 targets」，不能每批建一条。

## §3 方案总览（治标 + 治本）

| 层 | 内容 | 性质 | 规模 |
|---|---|---|---|
| ① | 协调者会话 instructions 写死岗位说明书 + 手工注册覆盖全队的看门狗 | 治标（今天可用，零代码） | 纯操作 |
| ② | 看门狗升级「全队工作台」：新 tick 类「干完待派」+ 建队自动注册 + 忙时也送达（工作台类）+ 报警文案区分失联/静默 | 治本一半（插件，小） | 1 批 |
| ③ | 协调者 charter 系统提示段（按 roster 实时渲染、每回合重新钉）+ 降级面 | 治本另一半（插件，中） | 1 批 |

① 与 ②③ 不互斥：① 今天就止血；②③ 落地后 ① 的 instructions 可留可撤（建议留一句「以系统提示 team-link 段为准」）。

## §4 ① 治标：零代码临时措施

**4.1 协调者会话 instructions（直接可用原文）**：

```text
你是本团队的协调者（coordinator），只做管理 / 协调 / 决策 / 评审 / 派单。
- 禁止实施：改代码、跑测试、git 操作、写文档一律用 team_link_send 派给 worker 会话。
- 每回合开工先跑一次 team_link_status，用读数（谁在跑 / 谁空闲 / 静默多久）派单，不凭「有没有人找我说话」判断。
- worker 回报经 team_link_send 到达；完成 / 阻塞要追问证据；团队裁决写黑板（team_link_team_append）。
- worker 失联先 team_link_list_sessions 点名读复核，再处置；换届走 team_link_rotate。
```

**4.2 手工看门狗**：`team_link_watch action=register`，targets = 全部 worker 会话 id（**一条注册带全部目标**，不占满 3 条上限），silentMinutes=10。

## §5 ② 看门狗升级「全队工作台」

### 5.1 新 tick 类 `idle-await`（干完待派）

- **分类器**（新纯函数 `idleAwaitOf(signal)`，看门狗层，**不动 verdictOf**）：
  `verdict === "ok"`（⇒ 静默未超阈值，超出归 silent-idle 报警管）**且** `agent === "idle"` **且** `lastAssistantAt !== null` **且**（`lastInboundAt === null` 或 `lastAssistantAt > lastInboundAt`）**且** goal 为 null 或 `phase === "none"`。
  —— 「它最后说话了、之后无人找它、没有会自己续跑的 goal」= 干完等派单。goal active-armed（会自己续跑）与 paused/blocked/complete（已解释过的静默，:605 注释的既有口径）都排除。
  边界收益：刚被最小唤醒、只回了一句「收到待命」的 worker 同样命中 —— 正是事故里 w1/w4 的状态。
- **去抖**：键改 `${id}\n${kind}\n${target}`，水位沿用 `lastActivityOf` —— 两类 tick 互不压制；同一「等派单期」只 tick 一次；worker 再说一句（水位前进）后进入新期，允许再 tick。
- **文案**（插件常量，插值只有状态字段，与 `tickMessage` :2260-2273 同一纪律）：
  `[watchdog] 目标 <id> 干完待派：末条助手消息 <时刻>，已空闲 <X.Xmin>（读数 <时刻>）。它说完了、在等下一步——这不是失联：请派单（team_link_send）或确认它已收尾；不需要这类提醒可 team_link_watch clear。`
- **注册面**：`buildWatchdogRegistration`（:2224）加 `kinds` 字段（闭集 `alarm` / `idle-await`）；手工 register 加可选参数 `watchIdle`（默认 false ⇒ `["alarm"]`，**既有行为逐字不变**）；持久化旧行读时归一化补 `kinds: ["alarm"]`、`auto: false`（与 roles 读面同一套路）。

### 5.2 观察者「忙时掐掉」的分类处置（决策点 D1）

现状 `patrolOne`（:2393-2395）：watcher running ⇒ return；watcher goal armed-active ⇒ return（A1：它有自己的节奏）。
提案：**报警类（silent-idle / goal-disarmed / dead）两道门原样保留**（§3.2.3 红线不动）；**工作台类（idle-await）两道门都放行** —— 它等的就是协调者忙的那一刻；`followup` 对运行中会话 = 注入当前回合（与 team_link_send 同一语义），对空闲会话 = 唤醒新回合，两类时刻都「推得到」。

### 5.3 建队自动注册（决策点 D2 / D7）

- 挂载点：`/team_session` 完成回报路径，pairs 授予之后（:8303 后）、行渲染之前；条件：本批有 created worker 且调用会话是现任协调者（pairsAborted 时不注册 —— 授权基础不在，与 pairs 同一口径）。
- 形状：`{ team: plan.team（该字段自 :2241 起一直为 null，首次启用）, watcherSession: coordinatorId, targets: created worker ids, kinds: ["alarm","idle-await"], auto: true, silentMinutes: 10, intervalMinutes: 5, ttl: 12h }`。
- **同团队复用**：后续批次找「同 watcher + 同 team + auto===true」的既有注册 ⇒ 原地并 targets、TTL 顺延为 now+12h、重新 schedule；找不到才新建。⇒ 一个团队永远最多吃 1 条注册额度（3 条上限里给手工留 2 条）。
- **失败隔离**：自动注册失败（policy.update 抛错）⇒ 批次**不**因此失败，完成回报如实写一行「看门狗：自动注册失败（原因）——可手工 team_link_watch register」。
- 完成回报新增一行（成功 / 复用 / 失败三态如实）：`- 看门狗：已自动注册 wd-…（盯 N 个 worker：静默 10min 报警 + 干完待派提醒；TTL 12h，<到期时刻>）`。
- 退役 / 换届不级联清理（TTL 兜底，与既有「注册按观察者会话登记、与团队弱关联」口径一致，见 :11144 注释）；观察者 dead 时 `deadWatchers` 标记机制原样适用。

### 5.4 报警文案区分（决策点 D6 的措辞面）

- silent-idle 不再写「失联征兆」⇒ `静默超时`：「既无助手消息也无入站超过阈值，可能是卡住，也可能是干完没人理 —— 先 team_link_list_sessions 点名读复核」。
- dead 保留「失联」（代理不存在 = 真失联）；goal-disarmed 文案原样（已是专属文案）。

## §6 ③ 协调者 charter（系统提示段）

### 6.1 机制（核心创新点：扛上下文压缩 + 永远按 roster 最新状态渲染）

- **安装**：apply 里 `for (const agent of ctx.agents.list()) installCharter(agent)` + `ctx.on("agent/created")` 装、`agent/disposed` 释放（dsh-file-reference-local:364-372 同形）；`installCharter` 内部 `const sp = agent.ctx.get?.("systemPrompt")`，缺席 ⇒ 一次 warn（「charter 段不可用，降级为建队文案 + 状态卡提醒」）并跳过。
- **段**：`{ name: "team-link:charter", order: sp.getSectionOrder("TEAM_POLICY"), text: () => renderCharter(policy.get(), sessionId) }`。
  `renderCharter` 为**纯函数**（可测）：该会话是某团队现任协调者 ⇒ 渲染协调者 charter；是某团队在册 worker ⇒ 渲染 worker 段（D5）；都不是 ⇒ `""`（自动隐藏）。
  —— 换届 / set-role / 退役 / recover **零记账**：text 每次装配重算，角色一移走下回合系统提示里就没有这段，角色一落到某会话下回合就出现。重启零迁移：policy 是持久化的，插件激活后第一次装配自然渲染。
- **每 agent 只装一次**，fiber 存 WeakMap（agent ⇒ disposer），`agent/disposed` 时释放 —— 与看门狗 timer 同守「插件卸载 = 背景痕迹全拆」（:11858-11861 的既有纪律）。

### 6.2 charter 文案（渲染结果，<…> 为插值）

协调者段：
```text
[team-link] 你是团队 <team> 的现任协调者（coordinator）会话。本段由 dsh-team-link 按 roster 实时渲染，每回合都在系统提示里；角色移交或退役后自动消失。
- 职责边界：只做管理 / 协调 / 决策 / 评审 / 派单；实施类工作（改代码、跑测试、git 操作、写文档）一律用 team_link_send 派给 worker，不亲自动手。
- 每回合开工先跑 team_link_status，用读数派单（谁在跑 / 谁空闲 / 谁静默超时），不凭「有没有人找我说话」判断。
- 当前 worker：<role> → <sessionId>（逐行列出；空缺角色也列出并标注）。
- 看门狗：<已注册 wd-…（静默 10min + 干完待派提醒）/ 未注册——建议 team_link_watch register 覆盖全部 worker>。
- worker 失联先 team_link_list_sessions 点名读复核；换届 team_link_rotate；写不动黑板时先 team_link_roster action=get 查 policy.writer 与自己在位状态。
```
worker 段（D5 采纳时）：
```text
[team-link] 你是团队 <team> 的 worker（角色 <role>），向协调者会话 <id> 汇报。本段由 dsh-team-link 按 roster 实时渲染。
- 完成或阻塞都用 team_link_send 回报协调者：结论 / 证据 / 下一步；不要静默等待。
- 团队约定与裁决：team_link_team_read 读；policy.writer=coordinator 时黑板只能读。
```

### 6.3 降级面（systemPrompt 缺席时）

- upsert-team 建队返回（:4131-4138）追加 charter 块（工具结果即进调用者上下文，即时但可被压缩）；
- `team_link_status` 首段加一行「你是团队 X 的现任协调者 —— 职责：派单不实施」（拉路径顺带重钉）。

### 6.4 明确不做（划线）

- **不做硬墙**：插件拦不住协调者会话调 bash / 写文件（那是宿主工具门的能力面，本仓够不着）。charter 是规范层，不是强制层 —— 写进文档，免得有人以为有了硬约束。
- **不改 `verdictOf` 五态契约**（§3.1，所有读面共用）；新分类器只在看门狗层。
- **不动 tick id 前缀**（客户端卡片认 `slp-` 干，:259）—— 客户端零改动。
- **不做双写 / 不新增持久状态**：kinds/auto 进既有 policy.watchdogs 行（读时归一化兜底旧行）；charter 零持久化（每装配重算）。
- **不给 agent-team 档渲染 charter**（该档 Lead 能力面不同，§4.3 能力矩阵口径不动；后续真要再做单独一批）。

## §7 与既有「心跳唤醒」的协同

协调者会话自己的 30 分钟 schedule 心跳照旧 —— 但③落地后，心跳唤醒的每一回合装配都带 charter 段，「醒来找活干」的冲动被规范成「先 team_link_status 再派单」；②落地后，两次心跳之间的「worker 干完」由 idle-await tick 即时推送，不再等心跳撞运气。

## §8 决策点（交会诊逐条裁定；附推荐）

| # | 决策点 | 选项 | 推荐 |
|---|---|---|---|
| D1 | idle-await tick 是否在 watcher running / goal armed-active 时放行 | A 两类都放行（推荐）/ B 只放 running / C 都不放（维持 A1） | A —— 事故根因就是「忙时收不到」 |
| D2 | 自动注册默认开 / 关 | A 默认开（推荐）/ B 配置项 / C 默认关 | A —— 「没人自动注册它」是根因之一 |
| D3 | 手工 register 的 watchIdle 默认值 | A false（推荐，既有行为逐字不变）/ B true | A |
| D4 | team_link_status 是否加 charter 提醒行 | A 加（降级面，推荐）/ B 不加 | A |
| D5 | worker 段是否同批做 | A 同批（推荐：同机制零边际成本，治 kickoff 被压缩冲淡）/ B 后续批 | A |
| D6 | silent-idle 文案改称「静默超时」 | A 改（推荐）/ B 保留「失联征兆」 | A |
| D7 | 自动注册 TTL 顺延策略 | A 同团队新批次顺延 12h（推荐）/ B 固定不续 | A |
| D8 | goal 服务缺席（goal=null）时 idle-await 是否命中 | A 命中（推荐：worker 通常无 goal；缺席 ≠ 有 goal）/ B 不命中 | A |

## §9 实施批次

- **批 1（②，小）**：`idleAwaitOf` + tickMessage 双文案 + 去抖键加 kind + patrolOne 分类门 + buildWatchdogRegistration 加 kinds/auto/team + 手工 register 加 watchIdle + /team_session 自动注册与完成回报行 + host-half 断言。预计改动集中在 lib/index.js 的 2224-2273 / 2349-2415 / 11305-11351 / 8303-8334 四段 + 常量区。
- **批 2（③，中）**：`renderCharter` 纯函数 + installCharter（agent 生命周期三面）+ 降级面（建队返回块 + status 提醒行）+ host-half 断言。
- **批 3（文档）**：README 工具表（watch 新参数 / 自动注册 / charter 段）+ 变更史；verification-log 追加两批的必红 / 全绿读数；本档状态行改「已落地」。
- 每批都要「修复前必红 / 修复后全绿」两次实测读数（AGENTS.md §三）。

## §10 测试计划（host-half.test.mjs；断言名即可 grep 的锚）

- `charter-render-coordinator`：种 team（coordinator=S1，两 worker）⇒ renderCharter(policy, S1) 含团队名 / 职责边界 / 两 worker id；renderCharter(policy, S2) === ""；renderCharter(policy, S3 路人） === ""。
- `charter-live-flip`：applySetRole 把 coordinator 换给 S2 ⇒ 同一 policy 上 S1 渲染变 ""、S2 变 charter —— **不重装任何 fiber**（动态 text 的判据）。
- `charter-worker-face`（D5）：worker 会话渲染 worker 段，含「向 <coordinatorId> 汇报」。
- `charter-degraded`：agent.ctx.get("systemPrompt") 缺席 ⇒ installCharter 不抛、恰好一条 warn、零 fiber 残留。
- `idle-await-classifier-matrix`：六格 —— 干完待派（true）/ running（false）/ 末条是入站（false）/ goal active-armed（false）/ goal paused（false）/ 静默超阈值即 verdict=silent-idle（false，归报警）。
- `idle-await-tick-copy`：tick 正文含「干完待派」且**不含**「失联征兆」；silent-idle 正文含「静默超时」不含「失联征兆」（D6）；dead 仍含「失联」。
- `tick-debounce-per-kind`：同目标先 idle-await tick 后 silent-idle tick（构造水位/静默演进）⇒ 两条都送达；同种同水位 ⇒ 第二条压住。
- `idle-await-gates`：watcher running ⇒ alarm 不送 / idle-await 送（D1=A）；armed-active 同。
- `auto-watch-on-batch`：/team_session 成批 ⇒ policy.watchdogs 恰 +1（kinds 双类、auto=true、team 写入、targets=created ids）+ 完成回报含「已自动注册」行 + timer 已 arm。
- `auto-watch-rebatch-extends`：同团队第二批 ⇒ 注册数不变、targets 并入、expiresAt 顺延。
- `auto-watch-failure-isolated`：policy.update 注入失败 ⇒ 批次仍 success，回报含「自动注册失败」行。
- `manual-register-default-unchanged`：不带 watchIdle 的手工注册 ⇒ kinds === ["alarm"]（回归锁）。

## §11 文档同步清单（落地时同批改）

- README.md：工具表 team_link_watch 行（watchIdle 参数 + 自动注册）+ 能力段加「协调者 charter 系统提示段」；变更史一条。
- docs/verification-log.md：两批的必红 / 全绿读数各一组（命令 + 原文）。
- 本档：状态行「待会诊裁定」⇒ 裁定结果与落地读数。
- AGENTS.md：不动（无新规则；本设计全部落在既有纪律内）。

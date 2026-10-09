# 协调者角色约束 + worker 活性主动推送 · 设计（v1.0，**仅存史**）

> **已被取代（2026-10-09）**：本档是 consult #26 单批的旧稿，**不再作为设计依据**。
> 现行权威设计＝@@docs/2026-10-09-team-autonomy-design.md@@（两批合并、按必备九章重写）；
> 需求＝@@docs/2026-10-09-team-autonomy-requirements.md@@。本档保留仅为追溯 consult #26 的原始分析。

> **状态（2026-10-08）**：会诊 #26 **已结案**（4 投 **3 有效**，1 失败且不可诊断）；逐条裁定见会诊纪要
> `docs/consult-minutes/2026-10-08-consult-26-minutes.md` §2–§3，摘要见 **§11**；**待用户裁定 D-A1…D-A6**（§11 末）。
> **v1.0**：并入会诊处置（§11）· 实施合同（§12）· A/B 验收配方（§13）· 会诊产物处置（§14）。
> **本稿定位**：本仓**唯一权威设计档**（会诊子会话擅自写入的两份档已移入
> `docs/consult-minutes/artifacts-2026-10-08-consult-26/`，**不作依据**）。
> `[实测]` / `[待核]` / `[旁证]` 三级标注仍是硬纪律：**待核项不得当结论用**。
>
> 目标团队现场：`2026-10-08`（workspace `D:\workspace\mal-analyze-cli`，1 coordinator + 4 worker，
> 形态 = sessions）。协调者会话 `session-bd04f40b-dca7-4dff-b487-452813ca8f60` 是**用户手工创建**的
> 普通会话（不是插件新建的 worker 根会话）。

## 1. 问题（用户原话）

> 「1. 为什么它老是自己开始干活，明明我指定它是主管协调会话
> 2. 每次都要我手动提醒它安排其他worker会话并行干活，它根本不知道其他worker在没在干活」

两条症状指向同一件事的两面：**协调者的身份没有载体**（不写在任何它能反复读到的指令面上），
**worker 的状态没有推送**（数据都在，但从不到它眼前）。

## 2. 根因（逐条带证据坐标）

| # | 根因 | 机制 | 证据坐标 |
| --- | --- | --- | --- |
| R1 | **协调者没有角色指令** | 插件对新建 worker 会投 kickoff（写明角色 / 向主会话汇报 / 不要静默等待）；协调者是用户手工会话，插件只在 roster 里把「创建者」登记成 coordinator，**从不向它注入任何角色文本** | kickoff `lib/index.js:7215-7249`；创建者自举 `lib/index.js:3227-3230`；建队只回一句「下一步」`lib/index.js:4138` |
| R2 | **权限拦不住实施** | 写门只约束 roster / 黑板这类**插件写操作**；git、改源码、跑测试不属于它的管辖面 | `writerGate` `lib/index.js:3161-3177`；退役门 `3189-3195` |
| R3 | **worker 完成是静默事件** | 只有 worker 自己 `team_link_send` 回话，协调者才有事件；没有「回合结束 / 运行→空闲」的推送 | 投递路径 `lib/index.js:5766`；派生回执（要主动读）`3889`、`3981-3988` |
| R4 | **看门狗是「失联报警」不是「工作台」** | 须手动注册（全仓只有注册工具会启动定时器）；只对 `silent-idle` / `goal-disarmed` / `dead` 发 tick；观察者 running 或 goal armed-active 时整个 patrol 直接 return | `TICKABLE_VERDICTS` `lib/index.js:246`、`2406`；唯一 `watchdog.schedule` 调用 `11346`；观察者门 `2393-2395` |
| R5 | **活性只能「拉」** | 运行中 / 空闲 / 静默时长 / 最近一句都在状态卡与 list_sessions 里，但要协调者每回合主动调 | 状态卡会话面 `lib/index.js:11147-11170`；活性行 `11033-11044`；`team_link_list_sessions` 同源 |
| R6 | **tick 文案误导** | 「干完活等派单」的空闲 worker 会被描述成「失联征兆」，模型容易判成故障而不是「该派活」 | tick 文案 `lib/index.js:2265` |
| R7 | **纪律反向推动** | `AGENTS.md` 通篇「必须实测 / 必须回读 / 0 命中要用真能区分的检查」；加上 30 分钟心跳把它叫醒找活干 ⇒ 一遇「读数没人给」，它自己上手最快 | `AGENTS.md` 一、六；[实测] 该会话心跳 |

### 2.1 现状基线读数（2026-10-08 实测，两台仪器）

**方法（可复跑）**：`team_link_export({ sessionId, format: "json", outputDir: <临时目录> })` 导出会话 →
按 `tool/call` 事件的名字计数（PTC 会话的内层工具名从 `arguments` 里的 `tools.<name>(` 提取）。
口径：**impl = pwsh / write / edit**（实施与排查）· **coord = team_link_send / team_link_team_append**（派活与记账）·
**state = team_link_status / list_sessions / team_read / roster**（看谁在干活）。

| 协调者会话 | 工具调用 | impl | coord | state | team_link_status |
| --- | --- | --- | --- | --- | --- |
| `2026-10-08`（`session-bd04f40b…`，15:27–18:44） | 225 | **29**（pwsh 17 + edit 12） | 138（send 65 + append 73） | **5**（最后一次在 **16:00**） | **0 次** |
| `pulsethreat-1008`（`session-e4f5424d…`，17:39–18:45） | 115 个 run_code | **120**（pwsh 79 + write 37 + edit 4） | 32（append 22 + send 10） | 21 | 1 次 |

**两条读数直接对应两个症状**：
1. **它自己干**：第二台 impl:coord ≈ **3.8 : 1**；第一台 29:138 略好，但 16:00–16:30 一个半小时窗口内就 17 次 impl。
2. **它不知道谁在干活**：第一台全程只读了 **5 次**状态，**16:00 之后 2 小时 44 分零状态读**；专用状态卡
   `team_link_status` 在 1271 个事件里**一次都没调过**。

**边界（如实）**：impl 只计 pwsh/write/edit（`read`/`grep`/`glob` 归 inspection，未计入）；
第二台是 PTC 会话，内层调用可能同一条脚本里出现多次 ⇒ 它的计数**不是** run_code 调用数。

## 3. 可行手段盘点（能力面，实施前必须逐条对源码）

| 手段 | 状态 | 事实 | 坐标 / 证据 |
| --- | --- | --- | --- |
| 向任意活会话投一条消息并唤醒 | [实测] 已在用 | 看门狗 tick、kickoff、换届交接、rotate 指令四条路径都走 `agent.followup(...)` | `lib/index.js:2409` / `7458` / `4926` / `8476` |
| 读会话代理状态（运行中/空闲） | [实测] 已在用 | `ctx.agents.get(id)` ⇒ `status` | 状态卡 `lib/index.js:11020-11023` |
| 读会话回合/末条时间 | [实测] 已在用 | `ctx.sessionQuery.readSurface(id)` | `buildLivenessSignal` `lib/index.js:579-607` |
| 创建会话时挂 persona 组装源 | [实测] 已在用 | `agentPresets.resolve` → `acquireScope`/`standingKeyFor` → `mount`（**只覆盖插件新建的会话**） | `lib/index.js:7694-7738` |
| 插件服务面 | [实测] | 模块级 `inject` **恒 4 项**；其余服务 `ctx.get` 晚挂取用 | `lib/index.js:2855`；README「依赖的宿主服务」 |
| **系统提示「段」**（静态） | **[实测] 可写，且可按会话作用域** | `systemPrompt.section({ name, order, text })` 注册一个有序提示段；用 **`agent.ctx`** 调用即**只作用于该会话**（同名段在内层作用域遮蔽外层） | 源码 `dsh-system-prompt/lib/index.js`（`section()`、`SECTION_ORDERS.TEAM_POLICY = 600`）；**先例**：宿主 Agent Teams 的 `install()` 逐字如下 —— `const scoped = agent.ctx; scoped.systemPrompt.section({ name: "team:policy", order: scoped.systemPrompt.getSectionOrder("TEAM_POLICY"), text: POLICY })`（`dsh-experimental-tool-agent-team/lib/index.js`） |
| **系统提示「动态上下文」**（每次装配重算） | **[实测] 可写** | `systemPrompt.context({ name, order, text })` ＋ `systemPrompt.variable(name, provider)`：provider **每次装配都求值**，段文本可写 `{{变量名}}` 引用它 | 先例 `dsh-subagent/lib/index.js` 的 `applyChildComposition()`；`dsh-agent-loop/lib/index.js` 注册 `{{provider}}` / `{{model}}` / `{{cwd}}` 三个变量 |
| **每个 Agent 自带作用域** | [实测] | Agent 构造：`this.scope = createScope(loopCtx, this); this.ctx = this.scope.ctx`；`ctx.agents.get(id)` 返回该 Agent ⇒ 插件能拿到它的 `ctx` | `dsh-agent-loop/lib/index.js` Agent 构造函数；`AgentLoop` 的 `static inject` 含 `systemPrompt` |
| **段 / 上下文的 `text` 可为函数** | **[实测] 每次装配求值** | 装配处源码：`text: typeof section.text === "function" ? section.text(context) : section.text`（contexts 同形）⇒ 宪章与脉冲可以**一段搞定**，不必拆「变量 + 段」；该函数仍**必须同步** | `dsh-system-prompt/lib/index.js` 的 `assemble()` |
| 宿主「agent 指令」消息类型 | [旁证 · 已被上两行取代] | 会话日志 source kind 白名单含 `agent-instructions`；角色载体改走系统提示段后，本条只登记备查 | `host-half.test.mjs:1440`（复刻 `dsh-session-format-v2-to-v3` 的 SOURCE_KINDS） |

**[实测] 「系统提示面」可写，且能按会话作用域写** ⇒ 治本主干改为**提示层**（§4 层 3）：
角色宪章与团队脉冲都能做成「**每次装配都重算**」的系统提示段，不靠消息反复到达。
**证据方法（可复跑）**：`run_code` 进程是 Electron 的 asar-aware Node ——
`fs.readFileSync("…/resources/app.asar/dsh/node_modules/@deepseek-ai/<pkg>/lib/index.js", "utf8")` 可直读 harness 源码；
反之 `read` / `glob` / `rg` 对 asar 一律失败（`read` 报 `Cannot mix BigInt and other types`），
带 `position` 的 `fs.readSync` 也失败（`ENOENT ... not found in app.asar`）。本档三行 [实测] 均由该方法取得。

## 4. 候选方案（分三层，逐层可独立落地）

### 层 0 · 宿主层（零插件改动，今天就可用）
- **L0-a 协调者岗位说明书写进会话 instructions**：把「你是协调者：只做管理 / 协调 / 决策 / 评审 / 设计；
  禁止实施（改源码、跑测试、git 提交）；每回合开工先查 worker 状态」写进协调者会话的 instructions。
  系统提示不参与上下文压缩 ⇒ **唯一能长久生效的载体**。
- **L0-b 专用 preset**：给协调者建一个 preset，任何需要「协调者」的会话挂它。
- 代价：**用户侧配置**，插件改不了别人的会话；只解决「角色」，不解决「状态可见」。

### 层 1 · 插件 · 契约层（治标 + 治本一半）
- **L1-a 工具返回里回显 charter**：`upsert-team`、`team_link_status`、`team_link_team_read` 的返回首段
  加一句分寸固定的「你是协调者（现任 <id>）：…禁止…」（只在调用方确实是该团队 coordinator 现任时加）。
  优点：零新机制、零成本；缺点：只在它**调过团队工具**之后才被提醒。
- **L1-b 建队时向协调者自己投一条 charter**（复用 kickoff 通道）：新队诞生 / 换届认领后，
  向 coordinator 投一条 ≤ 若干行的岗位说明书。
  代价：真实消息，协调者上下文永久 +1 条 user +1 条 assistant；可能与 §10.2.8.10 之后「回执也算回合」的成本纪律冲突，需评估。

### 层 2 · 插件 · 脉冲层（治本另一半：把「报警器」改成「工作台」）
- **L2-a 自动注册**：在 **`/team_session` 建队成功处**自动注册一条覆盖全队成员的看门狗
  （一个注册可带全部 targets —— `targets` 是数组；每会话 3 条上限是**注册条数**，不是目标数）。
  **不得挂在 `team_link_status` 上**：该卡自己的合同写着「全只读：调用前后 settings 与磁盘文件逐字节不变」
  （`lib/index.js:11070`）——自动注册是写操作，放进去就是自己破自己的合同。
- **L2-a2 重启后必须重挂（父侧实测，会诊有一条断言被否证）**：`schedule()` 全仓只在注册工具里被调用一处
  （`lib/index.js:11346`），`patrol()` 只被定时器回调调用 ⇒ **持久化在 policy 里的注册在 DSH 重启后是哑的**。
  ⇒ auto 注册必须在 attach 时统一重挂；这同时修掉**既有手工注册**的同一个缺陷（登记为新缺陷）。
- **L2-b 事件化推送**：除现有三种失联状态外，增加两类**状态变更**事件：
  ①「worker 从 running → 空闲」；②「worker 空闲且无在飞任务超过阈值」。
  判据可由 `ctx.agents.get(id).status` + `readSurface` 末条时间推出，**不引入新的日志事件类型**。
- **L2-c 脉冲正文**：一条紧凑表（谁在跑 / 谁空闲多久 / 每人最近一句 / 我在等谁），
  与 charter 首行同体投出 ⇒ 一次推送同时治「忘了身份」与「不知道谁在干活」。
- **L2-d 防刷屏与成本上界**（硬要求）：只在**状态变更**时发（不按固定周期发）；同一目标同一状态
  去抖（复用 `recentlyTicked` 的 watermark 机制）；每会话每 N 分钟上限；注册带 TTL；
  协调者 running 时**不打断**（保留现有观察者门）。

### 层 3 · 插件 · 提示层（★ 治本主干；2026-10-08 源码级已证）

> 依据 §3 的三条 [实测]：系统提示段可按**会话作用域**注册，宿主 Agent Teams 用的就是这条路。
> 这条把「角色」与「活性可见」都变成**每次装配都重算的系统提示**，不再依赖消息反复到达。

- **L3-a 协调者宪章（治 A 主干）**：对 roster 里现任 coordinator 的 Agent 注册
  `section({ name: "team-link:coordinator-charter", order: TEAM_POLICY, text: CHARTER })`。
  效果：**该会话每次请求都带宪章**，不参与上下文压缩、不随对话漂移、零消息成本。
- **L3-b 团队脉冲（治 B 主干）**：`variable("team_link_pulse", provider)` ＋
  `section({ name: "team-link:team-pulse", order: TEAM_POLICY + 1, text: "{{team_link_pulse}}" })`；
  provider 每次装配现算一行「谁在跑 / 谁空闲多久 / 我在等谁」⇒ **不唤醒会话、不消耗回合**。
- **L3-c 生命周期**：注册句柄归属**该 Agent 的作用域**；插件仍须在 Agent 消失 / 角色换届时
  **显式释放并重挂**，避免宪章挂在卸任者身上。
- **L3-d 降级（硬要求）**：`agent.ctx.systemPrompt` 属宿主内部面（本仓既有调用面之外的**新依赖**）
  ⇒ 必须**特征探测 + 降级**：探测失败即回退层 1 / 层 2 的消息路径并如实 warn。
- **L3-f 本机先例（2026-10-08 实测，直接降低 D-A3 的风险）**：本部署的**用户插件**已经在用同一条路——
  ① `@dsh-external/dsh-thincoder-suite/lib/eng.mjs` 的 `attachEngineeringSection(agent)`：
  `if (!agent?.ctx?.systemPrompt?.section) return null` → `agent.ctx.systemPrompt.section({ name, order, text })`，
  注释逐字写着「`agent.ctx 是 agent-scoped Context——section 只影响该 agent 的系统提示词装配`」
  （**与本设计同一形状，连特征探测守卫都一样**）；② `dsh-vision-bridge/lib/auto.js` 用
  `ctx.systemPrompt.context({ …, text: (assembly) => … })` 证明**函数型 text**在真实插件里可用；
  ③ `dsh-genui` 用 `ctx.systemPrompt.section({ name: "genui:fence", order: getSectionOrder("STRUCTURED_OUTPUT"), … })`。
  ⇒ 这不只是宿主自家包的用法，而是**本机三个用户插件都在跑**的路径。
- **L3-e 与消息层的分工**：提示层保证「它一睁眼就看得见」；消息层（层 2）只管「**该睁眼了**」（状态变更唤醒）。

### 4.1 协调者宪章正文（草案 v0，≤ 8 行 —— 系统提示每回合都在，行数即成本）

`@
你是团队 <team> 的协调者（现任会话 <id>）。职责边界：
1. 你只做：管理 / 协调 / 决策 / 评审 / 设计。**不实施**：不改源码、不跑测试、不执行 git 提交、不做排查。
2. 实施一律派给团队成员（team:<team>/<role>，用 team_link_send 派活）；单点实现可派 eng_coder。
3. 每回合开工先看团队脉冲（本提示下方）：谁在跑 / 谁空闲 / 我在等谁。
4. 成员「空闲」= 待派工，不是故障；只有失联（silent-idle / dead）才需要复核。
5. 派活与收活都记账（team_link_team_append file=tasks，kind=plan/claim/done），不靠对话记忆。
6. 用户直接命令你实施时先确认：这活该派还是该自己做（只有用户明确说「你自己做」才自己做）。
`@

### 4.2 团队脉冲正文（草案 v0，每次装配现算）

`[团队脉冲 <HH:MM:SS>] 在跑 2/4：w2(0.2min) w3(0.4min)；空闲 2/4：w1(9.0min) w4(5.7min)；在飞 t-11(w2) t-12(w3)；待认领 t-13；无后续反应 1 条`

**硬约束（源码级，2026-10-08 补）**：`assemble()` 对 variable provider 是**同步调用**
（`for (const [name, provider] of ...) variables[name] = provider(context);` —— 无 `await`）
⇒ provider **不得返回 Promise**，只能读**内存态**（`ctx.agents.get(id).status`）。
需要日志面（静默时长 / 最近一句 / 在飞任务）的部分，必须由**定时器预先算好放进内存缓存**，provider 只读缓存（≤ 一次 Map 查询）。
并且 provider **必须恒返回字符串**：`interpolate()` 对「未注册的变量名」与「undefined 值」都是**抛错**
（`unknown prompt variable "{{x}}"` / `prompt variable "…" is undefined`）—— 抛错等于该会话整次装配失败。

### 4.3 事件模型（推送层；只负责「该睁眼了」）

| 事件 | 判据 | 动作 | 去抖 |
| --- | --- | --- | --- |
| **E1 成员由运行转空闲** | `status` running → 非 running | 推送一行脉冲 | 每成员每次转换一次 |
| **E2 成员空闲且无在飞任务** | E1 的空闲态 + tasks.md 无该成员未完成行 + 静默 > T1（默认 10min） | 推送「待派工」 | 同成员同状态一次 |
| **E3 成员失联** | 现有 verdict `silent-idle` / `goal-disarmed` / `dead` | 沿用现有 tick（**文案改为区分「失联」与「空闲待派」**） | 现有 watermark |

投递门（沿用现有，不放松）：观察者 running / armed-active 时不发；注册带 TTL；全部可 `clear`。

### 层 4 · 可选硬墙（默认关；2026-10-08 更正上一版的「不做」）

上一版照抄会诊断言「宿主没有供插件否决其它工具的钩子」——**该断言父侧未复核，本轮实测否证**：
`dsh-tools` 的 `restrict(filter)` 文档原文 `requires a scoped context (agent.ctx)`、支持 `allow` / `deny` 掩码、
返回 `the exact disposer that lifts this restriction` ⇒ **插件可以在指定会话的作用域里挂上 / 摘掉它的工具面**。

- **可行形态**：`agent.ctx.tools.restrict({ deny: ["pwsh","write","edit","bash"] })`（只对协调者会话；默认关，可按会话开）。
- **三条必须实测的前置（未测不得实施）**：
  1. **PTC 内层解析**：本部署走 `run_code` 内的 `tools.<name>(...)`。**2026-10-08 已推进一半**：
     运行时收到的工具表由**宿主在启动时下发**（`dsh-ptc-runtime-node/lib/process.js:1012 makeNamespaces(data,…)`
     ← `data.namespaces`）⇒ 内层工具面**就是宿主按该 agent 的工具面算出来的**，看起来会吃 `restrict`；
     但 `restrict` 是否参与那次计算**仍未实测**（这是唯一剩下的一步）。若不能，deny `run_code` 等于把团队工具一起废掉（它是工具总线）。
  2. **可撤销性**：disposer 是否在会话存活期内可靠摘除（否则「临时禁」变「永久禁」）。
  3. **与既有闸门交互**：`allow` 模式下 scoped 注册（`team_link_*`）是否仍可见（注释称 `scoped registrations remain visible`，需实测）。
- **父侧建议**：本批**不做**，只登记为可选特性 + 三条待实测 —— 硬墙会连带堵死「用户让它自己做」的路。

## 5. 红线与约束（不得触碰；实施前逐条核对）

1. `writerGate` **函数体逐字节不变**（README §十「红线由哪些断言把守」）。
2. 模块级 `inject` **恒 4 项**；新服务一律 `ctx.get` 晚挂取用。
3. 投递消息 `source` **恰三成员**（`agent-message` / `relay` / `senderSessionId`）。
4. **不引入任何新的会话日志事件类型**。
5. 状态**一个时刻只写一处**（settings ↔ `policy.json`，`AGENTS.md` §七）。
6. 读窗成本不变量（`PREVIEW_SESSIONS`）不得被脉冲机制突破。
7. 脉冲必须**可关**（注册 / 清除对称），且误报要能一句话解释。

## 6. 投给会诊 #26 的三个问题

- **A 角色约束**：`协调者不实施` 怎么扛住上下文压缩？（宿主 instructions / preset / 插件 charter 回显 /
  周期脉冲 / 工具级硬门？各自代价与失效面）
- **B 活性推送**：worker 活性怎么改成主动推送？（事件模型选哪些事件、推什么字段、如何防刷屏与成本上界、
  与现有 watchdog 的关系是扩展还是新机制）
- **C 兼容边界**：与 sessions·agent-team 两形态、§7 落点、writerGate、读窗预算、以及本仓「红线断言」
  如何不冲突。

> **时间差声明（文档卫生）**：本节是 2026-10-08 **18:36 投出的原文**，其中 **A 的候选集合不含「层 3 · 提示层」**
> —— 那一发现（18:43 源码级）比会诊**晚 7 分钟**。会诊结论回来对照时，凡「A 无解 / 只能靠消息反复提醒」
> 一类判断，**必须先对 §4 层 3 复核**才可采纳或驳回。

## 7. 待定 / 风险（编号留用）

- **D1（已结案 2026-10-08 18:43）** `systemPrompt` 能否注册「一段提示」——**[实测] 能，且可按会话作用域注册**（§3、§4 层 3）。剩余风险转为「宿主内部面」的降级要求（层 3 · L3-d）。
- **D2** `followup` 唤醒 = 消耗一个协调者回合；脉冲频率与「唤醒成本」的平衡点未定。
- **D3** 用户手工会话的 preset 不可由插件改（`agentPresets` 只在创建/复活路径生效）。
- **D4** 「空闲」的定义：无在飞任务 ≠ 空闲（worker 可能在等审批 / 等外部异步）。判据未定。
- **D5** charter 的**强制力边界**：插件能做的是「提醒 + 可观测」，做不了「禁止」；是否要加工具级硬门
  （例如协调者调用实施类工具时要求二次确认）需要用户裁定——这与「不引入新信任面」的红线有张力。

## 8. 会诊处置（已并入 §11）

> 本节原为待填占位；会诊 #26 结案后，**处置写在 §11（摘要）与会诊纪要 §2–§3（逐条，22 条）**。
> 保留本节仅为编号连续。

## 9. 判据（草案 U1–U12；红相 / 绿相读数在实施批里给）

| # | 判据 | 面 |
| --- | --- | --- |
| U1 | 特征探测失败（无 `agent.ctx.systemPrompt`）⇒ 不注册、不抛错、warn **恰好一行**，功能回退消息路径 | 降级 |
| U2 | 注册参数逐字正确（name / order = `TEAM_POLICY` / text）；且**只**对 roster 现任 coordinator 注册 | 作用域 |
| U3 | 换届后：旧会话的段被 dispose、新会话被挂上（零残留） | 生命周期 |
| U4 | Agent 消失 ⇒ disposer 被调用（注册表不泄漏） | 生命周期 |
| U5 | 脉冲 provider 为**同步**且恒返回字符串；抛错 / 空数据不使装配失败 | 健壮性 |
| U6 | 脉冲内容与 `ctx.agents` 状态一致（运行 / 空闲计数逐项） | 正确性 |
| U7 | E1 / E2 只在**状态变更**时推送；重复状态零推送 | 防刷屏 |
| U8 | coordinator 自身 running 时零推送（观察者门保留） | 防打断 |
| U9 | 无注册时：零推送、零额外会话日志读 | 关闭态 |
| U10 | 不新增会话日志事件类型；投递 source 仍恰三成员 | 红线 |
| U11 | 模块级 `inject` 恒 4 项；writerGate 函数体逐字节不变 | 红线 |
| U12 | 每装配最多一次缓存查询（不读会话日志） | 成本 |

**可测性分级（2026-10-08 对夹具实测后补，原判断偏悲观）**：
- **U1（降级）今天就可测**：夹具里的假 agent 是裸对象（`{ id, status, session, followup }`，见 `host-half.test.mjs:56` / `:600` / `:655`），
  **没有 `.ctx`** ⇒ 现成夹具天然走降级分支。
- **U2–U4 需一处夹具扩展**（本仓自有夹具 ⇒ 属可测）：给假 agent 加
  `ctx: { systemPrompt: { section(), getSectionOrder() } }` 桩，即可断言「注册参数逐字」「只对现任协调者注册」「换届 / 消失时 dispose」。
- **真正不可验的只剩一条**：活体 Agent 的 `agent.ctx` 是否真把段路由到**该会话自己的作用域**（宿主行为）⇒ 只能真机冒烟。

## 10. 分批实施（草案；每批先红后绿 + 独立复核）

- **批次 1（治标，风险最低）**：层 1-a（工具返回回显 charter）＋ 层 2-a（自动注册覆盖全队的看门狗）。
- **批次 2（治本主干 · 角色）**：层 3-a 宪章段 ＋ 层 3-c/d 生命周期与降级（判据 U1–U4、U11）。
- **批次 3（治本主干 · 可见性）**：层 3-b 脉冲段（同步 provider ＋ 内存缓存）＋ 层 2-b/c 事件推送（判据 U5–U10、U12）。
- 每批产出一份 `docs/verification-log.md` 读数；批 3 完成后在目标团队（`2026-10-08`）上做一次真机 A/B。

## 11. 会诊 #26 处置要点（v1.0 摘要；全文见会诊纪要 §2–§3）

**有效数 3/4**（`opencode-go-plan:mimo-v2.6-pro` 失败、无内容）。三条有效意见的关键处置：

| 项 | 处置 | 要点 |
| --- | --- | --- |
| `section.text` 支持函数型、每次装配求值 | **采纳（父侧复核）** | §3 新增一行；宪章 / 脉冲改用函数型 text，函数仍须同步 |
| 自动注册挂 `/team_session` 成功处，**不**挂 status | **采纳** | 状态卡「全只读」合同（`lib/index.js:11070`）⇒ 见 L2-a |
| 「重启后持久化注册会自动复活」 | **驳回（父侧实测否证）** | `schedule()` 全仓 1 处、`patrol()` 仅定时器回调 ⇒ 哑注册；新增 L2-a2 |
| 工作台 digest「观察者忙时也投」 | **待用户裁定 D-A1** | 改的是已审计的 A1 抑制；根因确实在「忙时被掐」 |
| 宪章不要写进 `AGENTS.md` | **采纳** | AGENTS.md 全体代理共读，会误伤 worker |
| 硬墙（工具级否决） | **更正：技术可行，列可选特性（默认关）** | 宿主 `tools.restrict({allow/deny})` 是 **agent 作用域**、**可撤销**的面（`tools.restrict() requires a scoped context (agent.ctx) … returns the exact disposer`）⇒ 不是「无钩子」；本批仍不做，见 §4 层 4 |
| 会诊子会话擅自写入 2 份设计档 | **产物迁出** | 移至 `docs/consult-minutes/artifacts-2026-10-08-consult-26/` |

**待用户裁定**：D-A1 忙时也投（推荐准）· D-A2 是否先落 P0 零代码止血 · D-A3 宪章主干走 `agent.ctx.systemPrompt.section`
（宿主内部面，需接受新依赖 + 降级）· D-A4 自动注册挂钩点（推荐 `/team_session`）· D-A5 worker 段是否同批 · **D-A6 硬墙：本批不做，还是作为可选特性（默认关）落地**——我上一版的「宿主无否决钩子」已更正为「技术可行」，见 §4 层 4。

## 12. 实施合同（草案：批次 / 改动面 / 判据 / check）

> 待 D-A1…D-A6 裁定后冻结。每批一律：**先红后绿**两次读数入 `docs/verification-log.md`；提交前
> `git stash create` + `git update-ref refs/wip/<名>` 上保险；重启前确认无在飞作业（`AGENTS.md` §八）。

| 批 | 内容 | 预估改动面 | 判据 | check |
| --- | --- | --- | --- | --- |
| **1 · 止血 + 看门狗最小改造** | ① 零代码：协调者会话 instructions 贴宪章 + 一条手工注册全队看门狗（一条 targets 全队）；② 代码：auto 注册挂 `/team_session` 成功处、auto 不占手工额度、**attach 统一重挂**（L2-a2）、事件模型 E1/E2 边沿分组、告警文案区分「失联 / 空闲待派」 | `lib/index.js`：watchdog schema `:872-890` · `createWatchdog :2291-2430` · `patrolOne :2382-2415` · watch 工具 `:11305-11351` · 常量区 `:246-253` · `/team_session` 完成路径（`:7440-7470` 邻近） | U1/U7/U8/U9/U10/U11 + 回归：既有三态断言不红 | `node host-half.test.mjs`（红/绿两次）· `node client-half.test.mjs` |
| **2 · 宪章提示层（治本主干）** | 对 roster 现任 coordinator 的 `agent.ctx.systemPrompt.section({name:"team-link:coordinator-charter", order: TEAM_POLICY, text: 函数型})`；生命周期（agent 出现 / 消失 / 换届重挂与释放）；特征探测 + 降级 | 新增常量与注册器；`upsert-team` / `team_link_status` / `team_link_team_read` 返回面各一行 | U1–U4、U11 | 同上 + 真机冒烟（重启后确认段在场、换届后不残留） |
| **3 · 团队脉冲 + 重钉** | 函数型 text 的脉冲段（**同步**，数据来自 patrol 预算进内存的缓存）＋ status 第 2 行提醒（仅现任协调者）＋ digest 脚注 | patrol 增加缓存刷新；status 渲染加行（**不得写盘**） | U5–U10、U12 | 同上 + 目标团队真机 A/B |

## 13. A/B 验收配方（可复跑；口径同 §2.1）

1. **取基线**（上线前，已做到）：`team_link_export` 导出协调者会话 → 计数 `tool/call` 分类
   （impl = pwsh/write/edit；coord = team_link_send/team_link_team_append；state = status/list_sessions/team_read/roster）。
2. **上线后 24h 复测同一口径**，对照下表：

| 指标 | 基线（2026-10-08） | 通过线（草案） |
| --- | --- | --- |
| M2 自己实施（impl）调用数 | mal 29 / pulsethreat 120 | 相对基线下降 **≥ 50%** |
| M1 状态读（state） | mal 5（16:00 后 2h44m 为 0）| **不再出现 > 2h 的零状态读**；脉冲段在场时以脉冲为准 |
| M3 空闲 → 派活延迟 | **未测**（需从台账 + 投递记录派生） | 待定，先采集不断言 |

3. **解释纪律**：M1/M2 是**行为读数**，不是裁决；下降可能来自任务变简单 —— 判读时须同时看
   「本批是否引入了新的可行动信息」（digest 在场）与「台账行数是否同比例变化」，避免把「活少」当成「治好了」。

## 14. 会诊子会话产物的处置（可核）

- 两份子会话擅自写入的设计档已移至 `docs/consult-minutes/artifacts-2026-10-08-consult-26/`，
  **不计入本仓设计档**；本档是唯一权威设计。
- 处置理由与教训见会诊纪要 §2 末两条、§3 分歧 5、§4 教训 1。

## 15. 决策请求（人话版；与 §11 末的 D-A1…D-A6 同源）

> 供用户直接阅读/勾选；每条＝**前因后果 + 建议 + 代价**。技术细节见 §4 / §9 / §12。

- **D-A1 忙时也提醒？** 旧规矩是「协调者正忙就别打扰」（防打断）；但它恰恰在「自己忙不該忙的活」时最该被叫住 ⇒ 提醒被掐在最有用的时刻。**建议准**；配套：仅可行动信息、≥10min 去抖、可关。代价：改一条已审计行为。
- **D-A2 零代码止血先落？** ① 协调者会话指令里写死职责边界；② 一条覆盖全队的看门狗。**建议先落**（今天生效）。代价：① 仅对该会话；② 看门狗有既有缺陷——重启后不重挂（等代码批修）。
- **D-A3 职责写进系统提示段？** 写对话里会被压缩冲掉（这正是「过一阵又犯」的机制）。系统提示段每回合重渲染 ⇒ 压缩不掉、换届自动换人。**建议接受**。本机已有三个用户插件先例（见 §4 层 3 · L3-f），风险已降级；代价：接口换代需跟随（有降级路径）。
- **D-A4 自动注册挂哪儿？** 状态卡自称「全只读」，在里面写注册＝自破合同 ⇒ 挂 `/team_session` 建队成功处。**建议准**。代价：无。
- **D-A5 worker 段同批做？** worker 的入职通知同样会被冲淡 ⇒ 久了不汇报。**建议同批**。代价：无。
- **D-A6 硬墙？** **父侧更正**：宿主 `tools.restrict` 在 agent 作用域可用且可撤销 ⇒ **不是做不到**；但三个前置未测（PTC 内层、可撤销性、与 scoped 注册交互），且硬墙会堵死「用户让它自己做」的路。**建议本批不做、登记为可选特性（默认关）**。

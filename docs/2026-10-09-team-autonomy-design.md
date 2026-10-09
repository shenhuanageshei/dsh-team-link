# 设计档 · 团队自治与资源真值（dsh-team-link）

> **状态**：v1.0 待用户确认（2026-10-09）。配套需求档：`docs/2026-10-09-team-autonomy-requirements.md`。
> **章节口径**：`METHODOLOGY.md`「设计文档的成文流程与必备章节」（事实源见全局 `~/.dsh/AGENTS.md` 第三节）。
> **两批合并**：consult #26（角色/活性）+ consult #28（资源真值/轮换）。
> **行号约定**：全部为 **as-of 2026-10-09** 的 `lib/index.js`（12053 行）读数，只作定位，不承诺永久有效。

## §0 三句话结论（白话）

1. **这事是什么**：给团队加三层「**看得见**」——协调者每回合看得见自己的岗位说明；每个会话每回合看得见自己的资源余量；协调者不轮询就能看见"谁在跑/谁闲/谁该换"。
2. **对用户意味着什么**：不用再反复提醒它"你是主管"；worker 再也编不出"我预算耗尽了"（那句话会被一行读数当场证伪）；会话太长时你看得见标记并有现成换人命令。
3. **建议怎么办**：本批**只读 + 注册**，不新增任何写路径与事件类型；分 3 批实施，每批先红后绿。**12 个决策点在本档 §11，逐条给了前因后果与建议**。

```mermaid
flowchart LR
  subgraph 数据源["宿主只读数据源"]
    A1["ctx.agents.get(id).status"]
    A2["sessionProjections.stateOf()<br/>tokenUsage / contextPressure / sessionStats"]
    A3["policy.watchdogs 注册表"]
  end
  subgraph 落点["三个可见面"]
    B1["FR-1/2 系统提示段<br/>（每回合重算，扛压缩）"]
    B2["FR-5 状态卡第 ⑧ 段<br/>+ 判读行（拉）"]
    B3["FR-3 工作台 digest<br/>（推，带 A1 例外）"]
  end
  A1 --> B1 & B2 & B3
  A2 --> B1 & B2
  A3 --> B3
  B1 --> C["协调者/worker 下一个回合"]
  B2 --> C
  B3 --> C
  B1 --> D["FR-6 轮换标记与指引"]
```

## §1 背景

- **事实 1**：团队 `2026-10-08`（1 协调者 + 4 worker）跑了一天一夜，用户先后**三次**纠正协调者"你只负责管理，不要自己实施"。实测基线：协调者会话 225 次工具调用里**自己实施 29 次**、派活记账 138 次、**看 worker 状态只有 5 次**（16:00 之后 2 小时 44 分零状态读；专用状态卡 `team_link_status` **一次都没调过**）。另一支队 `pulsethreat-1008` 更极端：自己实施 120 次 vs 派活 32 次。
- **事实 2**：worker 会话 `team-link-2026-10-08-worker-4` 在 2026-10-09 10:49 向协调者报告「**②四档现场读全、实现未动——预算收口，交接防半成品**」；协调者采信，此后无人再派活。同一时刻它的实测用量是 **131,056,092 累计 token / 32 轮 / 303 步**。
- **事实 3**：这套插件从来没有向**任何**会话注入过角色或资源读数（唯一的角色文本发给新建 worker 的 kickoff，一次性、会被压缩冲淡）。

## §2 问题（现象 + 根因，带 `file:line`）

### 2.1 现象域 A：协调者失位与活性盲区

| # | 根因 | 证据（as-of 2026-10-09） |
| --- | --- | --- |
| A1 | **协调者没有任何角色注入**：worker 新建时会收到 kickoff（角色、向谁汇报、不要静默等待），协调者是用户手工建的会话，插件只在 roster 里把"创建者"登记成 coordinator，**从不向它注入任何角色文本** | kickoff：`lib/index.js:7215-7249`；创建者自举：`:3223-3231`；建队只回一行「下一步」：`:4138` |
| A2 | **权限拦不住实施**：写门只约束 roster/黑板这类**插件写操作**；git、改源码、跑测试不属它管辖 | `writerGate` `lib/index.js:3161-3177` |
| A3 | **活性只能"拉"**：运行中/空闲/静默时长/最近一句都在状态卡与 `list_sessions` 里，没有机制自动送到协调者眼前 | 状态卡会话面 `:11147-11170`；活性行 `:11033-11044` |
| A4 | **唯一的"推"只在"已失联"时响**：只对 `silent-idle` / `goal-disarmed` / `dead` 发 tick；worker 正常在跑 = 零信号；且必须**手动注册**（全仓唯一启动定时器处） | `TICKABLE_VERDICTS` `:246`、`:2406`；唯一 `watchdog.schedule` 调用 `:11346` |
| A5 | **它自己一忙，tick 反而被掐掉** | patrol 观察者门 `:2393-2395` |
| A6 | **tick 文案把"空闲待派"写成"失联征兆"** | `:2265` |
| A7 | **既有缺陷**：持久化在 policy 里的看门狗注册，**DSH 重启后是哑的**（没有任何定时器被重挂） | `schedule()` 仅 `:11346` 一处调用；`patrol()` 只被定时器回调调用（`:2314-2318`） |

### 2.2 现象域 B：资源真值缺失 ⇒ "预算耗尽"幻觉

| # | 根因 | 证据 |
| --- | --- | --- |
| B1 | **全 harness 不向模型注入任何预算文本**（不是 worker 特有） | 父侧与两份独立会诊复验：worker-2 会话 `system/message` 与 `request/context` 中预算字样 **0 命中**；唯一数字是 `contextWindow: 1000000` |
| B2 | **压缩阈值是估算口径**：`threshold = floor(min(window×0.8, window − maxTokens − headroom))`；qax 路由代入 = `min(800000, 1000000−393216−65536)` = **541,248** | `dsh-compaction-basic` 的 `resolveCompactSpec`（as-of 2026-10-09） |
| B3 | **本地估算器对中文系统性低估**（一手事件）：同一条压缩事件里 `shadowedTokenCount = 205,127`，而同操作的 API 实际 `cacheReadTokens = 387,200` ⇒ **≈1.89×** | worker-2 解码会话 `compaction` 事件（父侧 2026-10-09 11:3x 复核） |
| B4 | **溢出救援接不上**：失败码全是 `pi-ai stream idle timeout after 300000ms` / `TRANSPORT`，而溢出分支只认 `CONTEXT_WINDOW_EXCEEDED` ⇒ 救援一次都没触发（5 次重试后回合失败） | worker-2 会话：`CONTEXT_WINDOW_EXCEEDED` **0 次**；`llm/retry` 5 次 |
| B5 | **没有任何人可证伪"预算耗尽"**：状态卡七段里**没有**资源读数，协调者只能采信 | `team_link_status` 描述 `lib/index.js:11070` |
| B6 | **轮换没有触发者**：`team_link_rotate` 本就支持任意角色 + `successor:"auto"`（自建继任者 + 五硬节交接 + 令牌 + freeze），但没有任何"该换人了"的信号 | `lib/index.js:4953-4969` |

> **父子关系的诚实表述**：**"预算耗尽"这个词是模型自己编的**（环境无据）；但**触发它的痛是真的**（B2–B4：真实请求体已达 39 万–百万 token、网关 300s 不出字、重试失败、有一次 `kind=max-tokens` 回合死亡）。
> 结论：**错误的解释 + 真实的痛**。设计要同时治两件事——把痛读数化，并让错误的解释当场可证伪。

## §3 目标 / 非目标

**目标**：US-A1…A8、US-B1…B7（见需求档 §二）全部有对应 FR 与可失败判据。
**非目标**：见需求档 §四（硬墙 / 自动轮换 / worker 提示瘦身 / 团队级成本账 / 改宿主 / 部署配置修改）。

## §4 决策与理由（每条含被否决的备选）

| # | 选定 | 为什么 | 被否决的备选及否决理由 |
| --- | --- | --- | --- |
| D1 | 角色与资源都做成**按会话作用域的系统提示段**（`agent.ctx.systemPrompt.section`，**函数型 text**） | 每回合重算 ⇒ 扛压缩、零消息成本；宿主自家 Agent Teams 用同一条路；本机另有三个用户插件先例 | ① 写进仓库 `AGENTS.md`——worker 也读，会错套到自己头上；② 走 kickoff 再投一次大文本——一次性、仍会被压缩冲淡，且**教模型说预算**（反向效果） |
| D2 | 自动注册挂在 **`/team_session` 建队成功处** | 那是天然写盘时刻，且注册要求 `exec.agent.id` | 挂在 `team_link_status` 里"懒自愈"——该卡合同写着「**全只读**：调用前后 settings 与磁盘逐字节不变」（`:11070`），写操作进去＝自破合同 |
| D3 | 工作台 digest **在观察者 running 时也投**（穿透 A1 抑制） | 事故根因正是"它一边实施一边收不到提醒"；宿主语义本就支持注入当前回合 | 保留原抑制——等于把提醒掐在最有用的时刻；**但这是改一条已审计行为，列 D-A1 交用户** |
| D4 | 轮换＝**标记 + 指引**，命令复用 `team_link_rotate` | 轮换会广播 freeze、建新会话，本质是人的一次决策；命令本就存在 | 自动轮换——会打断在飞的活、且与"看门狗只管报警"的边界冲突 |
| D5 | 撞墙判据用**引擎同源公式**；轮换线用**绝对刻度** | 两者回答不同问题："下一步会不会被压缩/撞墙" vs "这个会话该不该换人" | 只用绝对刻度（会与真实压缩行为脱节）／只用窗口分数（1M 是市场数字，与真实窗口关系未知） |
| D6 | **"预算耗尽"只允许出现在判读行，且只能是"不成立"** | 把模型自述降级为可核对行；同时避免插件文案"教"模型说这个词 | 在 kickoff 里写"别说预算耗尽"——等于把词喂给它 |
| D7 | 本批**不做**硬墙（`tools.restrict`） | 技术可行（已实读源码），但会连带堵死"用户让它自己做"；且 PTC **内层**解析是否吃 `restrict` 未实测 | 现在就做——三个前置未测，做错等于把团队工具一起废掉（`run_code` 是工具总线） |

## §5 方案（FR-x）

| FR | 交付单元 | 落点 | 覆盖用户故事 |
| --- | --- | --- | --- |
| **FR-1** | **协调者宪章段**（每回合重算） | `agent.ctx.systemPrompt.section({name:"team-link:role", order: sp.getSectionOrder("TEAM_POLICY"), text: fn})`（**以 §6 的探测写法为准**：order 一律取 `getSectionOrder(...)`，不用裸常量），只对 roster 现任 coordinator 注册 | US-A1/A2 |
| **FR-2** | **会话资源段**（worker 自见；与 FR-1 **合并为一次注册**） | 同一函数型 text：coordinator 版＝宪章＋资源；worker 版＝资源＋汇报义务。**注册钩子两条路径（评审 #5 钉死）**：① `upsert-team` 的 **worker 角色创建分支**；② **`attach` 时扫 roster 成员重建**（覆盖重启后的既有 worker）。两条都只对**活代理**注册，缺席即跳过并如实标注 | US-A7/B2 |
| **FR-3** | **工作台 digest**（推） | 看门狗升级：自动注册 + 事件化（E1 运行→空闲 / E2 空闲且无在飞任务 / E3 失联）+ 分组摘要 + 语义分离文案 | US-A3/A4/A5 |
| **FR-4** | **工具返回面重钉** | `upsert-team` 创建分支 / `/team_session` 完成回报 / `team_link_status` 第 2 行（仅现任协调者）/ digest 脚注 | US-A2 |
| **FR-5** | **状态卡第 ⑧ 段「资源/预算」+ 判读行** | `team_link_status` 追加一段（复用既有有界读窗，**纯读**） | US-B1/B3 |
| **FR-6** | **轮换标记与指引** | 第 ⑧ 段行尾 `⚠ 轮换候选（turns=N / tokens≈M）` + 一句现成命令 | US-B4/B5 |
| **FR-7** | **attach 重挂**（既有缺陷修复） | 插件 attach 时遍历 `policy.watchdogs` 逐个 `schedule()` | US-A6 |
| **FR-8** | **文档同步** | 状态卡描述「七段→八段」同次编辑；README 服务表加 `sessionProjections`（晚挂/降级）；CHANGELOG；工具一览 | NF-4 |
| **FR-9** | **总开关**（评审 #1 补） | 新增策略键 `policy.sections = { role: bool, resources: bool }`（缺省 true）：`role=false` ⇒ 不注册宪章段；`resources=false` ⇒ 资源行在段 / ⑧ 段 / digest 脚注**三处全缺**。digest 侧关断＝既有 `team_link_watch clear` ＋ 进程内抑制标记（防 auto 自愈复活） | US-A8 |

### 5.1 状态迁移（成员状态 → 推送判定）

```mermaid
stateDiagram-v2
  [*] --> Running
  Running --> Idle: 回合结束
  Idle --> Running: 收到派活 / 唤醒
  Idle --> AwaitTask: 空闲 且 无在飞任务
  AwaitTask --> Running: 协调者派活
  Running --> Suspect: 无活动超静默阈值
  Idle --> Suspect: 同上
  Suspect --> Running: 恢复活动
```

> 图例：**E1**＝`Running → Idle`（"刚干完"）；**E2**＝`Idle → AwaitTask`（"空闲待派"，措辞与"失联"严格分离）；**E3**＝`→ Suspect`（走原有告警 tick，A1 抑制原样）。
>
> **E2 门槛口径（2026-10-09 doc-sync，评审 #1 + 复核 🟡1 收敛）**：E2 的条件**只有**「空闲 ∧ 无在飞任务」——**不带静默门槛**。
> 为什么删掉原先图上的「静默 > 10min」：一旦静默 ≥ `silentMinutes`（默认 10），该目标先被判 `silent-idle` 进 **alarm 组**（优先级更高），`idleAwait` 会**恒空、E2 永不可达**。
> ⇒ **E2 与 E3 的互斥由 alarm 优先级保证**（不是靠门槛）；投递侧的 ≥10min 去抖仍由 §6 的 `debounced(entry, now)` 承担。**本项改档不改码**。

### 5.2 轮换时序（标记 → 人工发起 → 两阶段交接）

```mermaid
sequenceDiagram
  participant P as patrol（插件）
  participant C as 协调者
  participant R as team_link_rotate
  participant N as 继任者会话
  P->>C: 状态卡行尾标记「⚠ 轮换候选（turns=N / tokens≈M）」
  C->>R: prepare(successor:"auto", handoff 五硬节)
  R->>N: 自建继任者 + 投递令牌与交接正文
  R-->>C: 全队广播 rotation-freeze
  N->>R: claim(token)：逐项确认信任迁移
  R-->>C: rotation-done + 落定 roster
```

## §6 机制伪代码（签名 + 前置/后置）

```js
/** FR-1/FR-2：给一个活代理注册角色/资源段。前置：agent 为活代理对象。
 *  后置：返回 disposer（幂等）；无 systemPrompt 面 ⇒ 返回 no-op + 一行 warn（fail-visible）。 */
function registerRoleSection(ctx, agent, charterText) {          // charterText: coordinator 版含宪章；worker 版为 null
  const sp = agent?.ctx?.systemPrompt;
  if (typeof sp?.section !== "function") return warnAndNoop("systemPrompt.section 缺席");
  const text = (assembly) => renderRoleAndResources(ctx, assembly?.agent, charterText);
  return sp.section({ name: "team-link:role", order: sp.getSectionOrder("TEAM_POLICY"), text });
}

/** 函数型 text 的渲染体：必须同步、必须恒返回字符串（返回 undefined 会让整次装配抛错）。 */
function renderRoleAndResources(ctx, agent, charterText) {
  const lines = [];
  if (charterText) lines.push(charterText);                       // FR-1
  const line = renderResourceLine(ctx, agent);                    // FR-2
  if (line !== "") lines.push(line);
  return lines.join("\n");
}

/** FR-2：一行资源读数。前置：agent?.session 可取；投影服务可能缺席。
 *  后置：恒返回字符串（不可读 ⇒ 明说不可读，绝不编数）。纯读，零写入。 */
function renderResourceLine(ctx, agent) {
  const sp = ctx.get?.("sessionProjections");
  if (typeof sp?.stateOf !== "function") return "[team-link 会话资源] 不可读（sessionProjections 缺席）";
  const p = sp.stateOf(agent.session, "contextPressure");         // { contextWindow?, pressureTokens?, surfaceTokens }
  const u = sp.stateOf(agent.session, "tokenUsage");              // { totals{...}, last{turn,step} }
  if (p === undefined && u === undefined) return "[team-link 会话资源] 不可读（投影未注册）";
  return `[team-link 会话资源] 窗口 ${fmt(p?.contextWindow)} · 压力 ${pct(p)}% · 压缩阈值 ${fmt(threshold(p))}（自动压缩开） · 累计 ≈${fmt(sum(u))} · 第 ${u?.last?.turn ?? "?"} 轮`;
}

/** FR-5：判读行——「预算耗尽」只允许出现在这里，且只能是"不成立"。 */
function verdictLine(pressure, threshold) {
  if (threshold === undefined) return "预算判读：阈值不可读（口径未知，不作判读）。";
  return pressure < threshold
    ? "预算判读：未到压缩阈值，自动压缩未触发——「预算耗尽」不成立。"
    : "预算判读：已到压缩阈值——宿主即将自动压缩，无需停手；确需换人请走 team_link_rotate。";
}

/** FR-3：patrolOne 的扩展（尾段）。前置：entry 为注册项；watcher 可能是 running。
 *  后置：至多投一条 digest；无"可行动内容"⇒ 零投递；告警类 tick 走原路径不变。 */
async function patrolOneWithDigest(entry, now) {
  const alarm = await patrolOneAlarmPath(entry, now);              // 原样保留 A1 抑制 + 去抖
  if (watcherNotLive(entry)) return;                               // A4：无处落
  const groups = classifyTargets(entry, now);                      // running / idleAwait / justFinished / alarm
  if (!actionable(groups)) return;                                 // 全队 ok 且无迁移 ⇒ 零投递
  if (debounced(entry, now)) return;                               // ≥10min 且状态未变
  watcher.followup(relayUserMessage(renderDigest(entry, groups))); // 沿用既有三成员 source
}
```

## §7 状态与 schema（谁写谁读）

### 7.1 持久化：`policy.watchdogs[]`（既有键的**加性**扩展）

| 字段 | 类型 | 谁写 | 谁读 | 说明 |
| --- | --- | --- | --- | --- |
| `id` / `watcherSession` / `targets` / `silentMinutes` / `intervalMinutes` / `expiresAt` / `createdAt` | 既有 | watch 工具 / auto 注册 | patrol / status 卡 / watch list | **形状不变** |
| `team` | 既有（此前恒 null） | auto 注册填团队名 | digest 文案 / status 卡 | 复用既有字段 |
| `origin` | `"manual" | "auto"`（缺省视为 manual） | 注册方 | 额度判定 / status 卡 | **新增**：`origin:"auto"` 不占手工 3 条额度（`:249`） |

> 落点纪律：仍走 `policy.update({watchdogs})`（单写落点，`AGENTS.md` §七）；**不新增任何持久化文件**。

> **`createdAt` 语义（2026-10-09 doc-sync，复核 🔵6）**：auto 行在**顺延（二次 arm）时会被重写为当次时刻** ⇒ 它表示「**最近一次 arm 时刻**」，不是「首次创建时刻」；TTL 顺延与状态卡显示都按这个语义用。若要「首次创建」需另加字段（本批不做）。

### 7.2 进程内（不落盘，重启即失——与既有 `ticked`/`deadWatchers` 同款取舍）

| 结构 | 谁写 | 谁读 | 说明 |
| --- | --- | --- | --- |
| `sections: Map<sessionId, disposer>` | 注册器 | 注销器 / attach 清扫 | 段注册句柄 |
| `lastAgentState: Map<regId+target, "running"|"idle">` | patrol | patrol | 判"刚转空闲" |
| `pulseCache: { at, text }` | patrol（定时刷新） | 函数型 text | 让 provider **同步**可读 |
| `digested: Map<regId+target, { at, signature }>` | patrol（投递成功才记；失败记 `signature: null`） | patrol / 判据 U9 | 投递去抖的**状态指纹**闸；失败那支记 null ⇒ 下个窗口重投（t-5 补判别力断言） |

### 7.3 只读投影（宿主）

`ctx.sessionProjections.stateOf(session, key)`：`tokenUsage`（v2）/ `contextPressure`（v5）/ `contextBreakdown`（v5）/ `sessionStats`（含 `turns`，**批 2 夹具先行核实** —— 缺席时按 §9「读数缺席（turns）」降级，评审 #3）。
**只读**：不写、不缓存、不改宿主状态。

### 7.4 开关（新增策略键 —— 本批唯一触碰红线的点）

| 字段 | 类型 | 谁写 | 谁读 | 说明 |
| --- | --- | --- | --- | --- |
| `policy.sections.role` | boolean（缺省 true） | 用户（设置 UI / `policy.json` 超级写者） | 注册器 | false ⇒ 不注册宪章段 |
| `policy.sections.resources` | boolean（缺省 true） | 同上 | 段渲染 / 第 ⑧ 段 / digest 脚注 | false ⇒ 资源行**三处全缺** |

> **红线代价（如实）**：README §十 的红线之一是「`PolicyConfig` 的键集」被断言钉住；新增这两个键**必须同批更新那条断言与 README 的键集描述**，并由 **U17** 覆盖 —— 这是本批**唯一**触碰红线的改动。
> digest 的关断**不新增键**：沿用既有 `team_link_watch clear` ＋ 进程内抑制标记（clear 掉的 auto 注册在同进程内不再自愈；重启后复活 —— 与既有 `ticked`/`deadWatchers` 同款取舍）。

## §8 防偏离（可失败的机械判据）

| # | 判据（可 grep、可失败） | 归属 |
| --- | --- | --- |
| U1 | 无 `agent.ctx.systemPrompt` ⇒ **零注册 + 恰好一行 warn**，不抛错 | FR-1/2 |
| U2 | 注册参数逐字：name/order(=TEAM_POLICY)/text 为函数；**只**对 roster 现任 coordinator 注册宪章 | FR-1 |
| U3 | 换届后旧会话段被 dispose、新会话被挂上（零残留） | FR-1 |
| U4 | 代理消失 ⇒ disposer 被调用（不泄漏） | FR-1 |
| U5 | 函数型 text **同步**且恒返回字符串；异常被吞并降级为空串（**不得**让装配抛错） | FR-1/2 |
| U6 | 资源行与 `stateOf` 一致（窗口/压力/阈值/累计/轮次逐项）；缺字段 ⇒ 显示「未知」而非 NaN | FR-2 |
| U7 | 判读行两种措辞都**不含**「预算耗尽／收口」字样（唯一例外：判读行里的"不成立"） | FR-5 |
| U8 | 轮换标记四边界（99/100/101 轮；199.9M/200.0M/200.1M）只在一侧出现 | FR-6 |
| U9 | digest 只在"有可行动内容"时投；全队 ok 且无迁移 ⇒ **零投递** | FR-3 |
| U10 | digest 在观察者 running 时**仍投**（若 D-A1 获批）；告警类 tick 的 A1 抑制**原样** | FR-3 |
| U11 | auto 注册不占手工额度；手工 ≥3 条后仍可 auto | FR-3 |
| U12 | attach 重挂：重启后 `policy.watchdogs` 每项都有定时器（**红相**＝摘掉重挂 ⇒ 断言红） | FR-7 |
| U13 | 零写入：第 ⑧ 段在场时「调用前后 settings 与磁盘逐字节不变」原断言仍绿 | FR-5 |
| U14 | 不新增事件类型；投递 `source` 恰三成员（`host-half.test.mjs:1440` 原样绿） | NF-1 |
| U15 | 模块级 `inject` 恒 4 项；`writerGate` 函数体逐字节不变 | NF-2/3 |
| U16 | 状态卡首行仍是 placementLine（`:11131`）；"七段"描述同次编辑改"八段" | FR-8 |
| U17 | **总开关**：`sections.role=false` ⇒ 零段注册；`sections.resources=false` ⇒ 资源行**三处全缺**；`watch clear` 掉的 auto 注册**同进程内不自愈**；**且 `PolicyConfig` 键集断言与 README 红线描述同批更新**（本批唯一触碰红线的点） | FR-9 |

**负向断言（必须存在）**：U1（缺席不许抛）、U5（渲染异常不许冒泡）、U7（禁用词）、U9（无事不许打扰）、U12（不许只在注册时挂定时器）。

## §9 边界

| 面 | 情形 | 行为（失败方向） |
| --- | --- | --- |
| 空集 | 无 worker / roster 无现任协调者 / 无投影服务 / 无 watchdogs | 不注册、不推送、读数行明说「不可读」；**fail-visible（如实标注），不 fail-closed，也不编数** |
| 畸形 | `contextWindow` 缺失、`pressureTokens` 非数、target 会话已被删 | 显示「未知」；被删会话的 target **不跳过**——它会被读成 dead 并**列进「需处置」**，在 digest 里如实标注（2026-10-09 改口径，复核 🔵8） |
| 并发 | 两个注册同时写 `policy.update`；patrol 与换届清扫同刻 | 沿用既有 read-modify-write 与去抖；注册失败 ⇒ 返回失败文案、**不静默** |
| 重启 | policy 里的注册、进程内的 `sections`/`lastAgentState`/`pulseCache` 全失 | **FR-7 重挂定时器**；段注册在代理出现时重建；投影由宿主重建 |
| 读数缺席（turns） | `sessionStats` 未注册或 `turns` 不可读（批 2 夹具先行核实，见 §7.3） | 第 ⑧ 段落为「轮次未知」，FR-6 **只按 tokens 标记**（轮次判据挂起）；如实标注，**不编数** |
| 开关关闭 | `sections.*=false` 或用户 `watch clear` | 零段注册 / 资源行三处全缺 / auto 注册不自愈；**不抛错、不静默改回** |
| 升级 | 宿主换代（API 改名/面消失） | 全部新面**特征探测**；缺失 ⇒ 降级到"工具返回重钉"路径 + 一行 warn（沿 preset 换代两次翻车的教训） |
| 失败方向 | 段注册失败 / digest 投递失败 / 投影读取抛错 | 段：warn + 不注册（会话照常跑）；digest：warn + 不重试（下个巡逻窗口再说）；投影：行内标「不可读」 |

## §10 实施批次（每批先红后绿 + 独立复核）

| 批 | 内容 | 判据 |
| --- | --- | --- |
| **批 1** | FR-3 最小改造（auto 注册 + E1/E2 事件 + digest 文案分离）+ **FR-7 重挂缺陷修复** | U9–U12、U14、U15 |
| **批 2** | FR-1/FR-2 提示段（合并注册，含生命周期与降级）＋ **核实 `sessionStats.turns` 投影**（夹具先行；缺席则按 §9 降级行落地） | U1–U6、U15 |
| **批 3** | FR-5/FR-6 第 ⑧ 段 + 判读行 + 轮换标记；FR-4 工具返回重钉；FR-8 文档同步；**FR-9 总开关**；**D-B6 三条宿主缺陷登记** | U7、U8、U13、U16、U17 |

## §11 十二个决策点（人话版：前因后果 + 建议）

> **已裁定（2026-10-09，用户）**：D-A1 准 · D-A2 先落 · D-A3 接受 · D-A4 准 · D-A5 同批 · **D-A6 挂起**（保留协调者现有的动手能力）·
> D-B1 准 · D-B2 合并 · D-B3 只标记 · D-B4 并入 · **D-B5 做** · D-B6 登记。
> 逐条裁定与实施口径见 §12。

### 批次 A（consult #26）

**D-A1｜它自己忙着的时候，插件要不要也把提醒发进去？**
前因后果：现在有条老规矩——协调者正跑着就不打扰（当年为了防打断）。可你要治的恰恰是"它忙着干不该它干的活"，提醒在最该出现的时刻被这条规矩掐掉了。
建议：**准**。配套（只在有可行动信息时发、≥10 分钟去抖、可 clear、TTL）。代价：改一条已审计行为，可能打断它的思路。

**D-A2｜先上一套不改代码的止血？**
前因后果：宪章段与自动注册都要写代码，而你现在每次还在手动提醒它派活。
建议：**先落**——把宪章原文粘进协调者会话的 instructions（会话级、只对它生效），再手工注册一条覆盖全队的看门狗。代价：① 只对该会话生效；② 看门狗有重启即哑的老毛病（FR-7 修）。

**D-A3｜"你是协调者"写进这个会话的系统提示段？（宿主内部面）**
前因后果：写对话里会被压缩冲掉；写系统提示段则每回合重算。这条依赖宿主的 `agent.ctx.systemPrompt`。
建议：**接受**。理由：本机已有三个用户插件在用（其中给本会话提供工具的 thincoder 就是按 agent 作用域挂段，连"接口不在就降级"的守卫都一样）；代价：换代要跟着改，有降级路径兜底。

**D-A4｜自动注册挂哪儿？**
前因后果：有人提议挂在"它调用状态卡"时顺手注册；但那张卡承诺"全只读，调用前后磁盘一字节不变"。
建议：**准**——挂 `/team_session` 建队成功处（本来就是写盘时刻）。代价：无。

**D-A5｜worker 的角色义务段同批做？**
前因后果：worker 的 kickoff 同样会被压缩冲淡，久了就不汇报（"干完不吭声"的另一半原因）。
建议：**同批**（同一机制、边际成本≈0）。代价：无。

**D-A6｜要不要做"硬墙"（直接摘掉它跑命令/改文件的工具）？**
前因后果：**我要更正上一轮**——我照抄会诊说"宿主没有否决钩子"，实读源码后**否证**：`tools.restrict({deny})` 在 agent 作用域可用、还能撤销。但两个坑：本部署工具调用走 `run_code` 总线，能否拦到**内层**未实测；硬墙也会把"你偶尔让它自己做"一起堵死。
建议：**本批不做**，登记为可选特性 + 三条待实测。代价：只靠软约束。

### 批次 B（consult #28）

**D-B1｜"预算耗尽"这个词在工具文案里怎么处理？**
前因后果：worker 编了这个词，协调者只能采信——因为没有任何一行读数能戳穿它。
建议：**准**——该词只允许出现在判读行、且只能是"不成立"；其余文案一律用"压力/阈值"说话。代价：无。

**D-B2｜资源段与宪章段合并注册？**
前因后果：两段都靠同一套"按会话作用域注册 + 生命周期"，拆两套要两次特征探测、两套 dispose。
建议：**合并**（一次探测、一套生命周期、一个开关）。代价：无。

**D-B3｜轮换是自动还是标记？阈值用 > 还是 ≥？**
前因后果：轮换会广播 freeze、建新会话，本质是人的一次决策；自动做会打断在飞的活。
建议：**只做标记 + 指引**（不自动）；阈值用 **`>`**（200M 整、100 轮整不算候选），实现前定死并钉进判据 U8。代价：需要你或协调者手动发一条命令。

**D-B4｜预算推送要不要单独做一条？**
前因后果：预算不是"事件性问题"（不像失联），而拉 + 自见两面已经闭环。
建议：**并入** D-A1 的工作台 digest（若批），本批不单独做。代价：无。

**D-B5｜部署配置要不要现在改？（不在本仓）**
前因后果：qax 路由的压缩阈值是 541,248（**估算口径**），而实测低估 ≈1.89× ⇒ 真实约 80 万–100 万才触发压缩，正好撞网关声明的 1M 窗口；真出事时失败码是超时，溢出救援接不上。
建议：**建议立刻做**——给 qax 两条路由配 `compaction-basic.modelPolicies`（降 `thresholdRatio` 或加 `headroomTokens`），并把声明的 1M 改成网关实测值。代价：改部署配置需要你点头（我可以给具体补丁片段）。

**D-B6｜宿主缺陷怎么办？**
前因后果：中文估算低估 ≈1.9×、大包超时没被识别为"疑似溢出"、真实 usage 没回灌压力环——这三条都长在宿主，不在本仓。
建议：**登记 + 上报**，不在本仓修（本仓修不了，也不该修）。代价：无。

## §12 决策裁定结果与实施口径（2026-10-09）

| # | 裁定 | 实施口径（本档如何落） |
| --- | --- | --- |
| D-A1 | **准** | FR-3：digest 在观察者 running / armed-active 时**照投**；告警类 tick 的 A1 抑制**原样不动**。判据 U10 钉这两半。 |
| D-A2 | **先落** | 批 0（零代码）：① 宪章原文粘进协调者会话 instructions；② 手工注册一条覆盖全队的看门狗。**不进代码改动面**，由用户在会话里执行。 |
| D-A3 | **接受** | FR-1/FR-2 走 `agent.ctx.systemPrompt.section`；**必须**特征探测 + 降级（U1），并在 README 服务表登记为"晚挂/缺席降级"。 |
| D-A4 | **准** | FR-3 的自动注册挂 `/team_session` 建队成功处；**禁止**放进 `team_link_status`（其"全只读"合同是红线，判据 U13）。 |
| D-A5 | **同批** | FR-2 的 worker 版文本（资源行 + 汇报义务）与宪章段**同一次注册**（D-B2 合并）。 |
| D-A6 | **挂起（保留能力）** | 本批**不做** `tools.restrict` 硬墙；**不削弱协调者现有的任何工具**。设计保留为"可选特性（默认关）"，三条待实测（PTC 内层解析 / disposer 可撤销性 / 与 scoped 注册的交互）留在 §4-D7 与本行。 |
| D-B1 | **准** | FR-5 判读行；"预算耗尽／收口"只允许出现在判读行且只能是"不成立"（U7）。 |
| D-B2 | **合并** | FR-1 与 FR-2 共用一次特征探测、一个 `section`、一套 disposer（U2/U4 同批钉）。 |
| D-B3 | **只标记** | FR-6 只做行尾标记 + 指引；阈值符号取 **`>`**（200M 整 / 100 轮整**不算**候选），钉进 U8。 |
| D-B4 | **并入** | 资源行随 digest 脚注出现；**不新增**独立推送支路（U9/U10 不变）。 |
| D-B5 | **做** | 部署面（**不在本仓**）：给 profile 的 `compaction-basic` 加 `config.modelPolicies` 校准 qax 两条路由；补丁片段见实施计划 §4。属"用户侧配置变更"，需单独确认后落地。 |
| D-B6 | **登记** | 三条宿主缺陷写入 `docs/verification-log.md` 的登记面（CJK 估算低估 / 大包 idle-timeout 未识别为疑似溢出 / 真实 usage 未回灌压力环），**不在本仓修**。**实施口径（评审 #4）**：登记动作挂在**批 3**（与 FR-8 文档同步同批）。 |

## §13 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-10-09 | v1.0 首次成文（按 `METHODOLOGY.md` 必备九章重写；两批合并；含 12 决策点人话版） |
| 2026-10-09 | **v1.1**：并入用户对 12 个决策点的裁定（§12）；D-A6 由「本批不做」改记「**挂起（保留协调者动手能力）**」；D-B5 由「建议」改记「**做**」（部署面，另附补丁片段） |
| 2026-10-09 | **v1.2（评审 advisor-dsh-46 后按「全按建议改」修订）**：FR-9 总开关＋U17（#1）· 行数预算口径（#2）· turns 降级与批 2 先行核实（#3）· D-B6 派批 3（#4）· worker 注册钩子两条路径（#5）· §13→§12 章节重排与 order 写法统一（#6/#7）。**审判 token 对 v1.1 签发，本条修订全部采纳评审员自己的建议，口径未扩大** |
| 2026-10-09 | **v1.3（doc-sync 窗口）**：① §5.1 E2 门槛口径澄清（去静默门槛 + E2/E3 互斥由 alarm 优先级保证，改档不改码）；② §7.2 补 `digested` 行；③ 新增 `createdAt` 语义（最近一次 arm 时刻）；④ §9「跳过 target」措辞改为「列进需处置」；⑤ 实施计划同步 N1/N2（版本引用、批 3 判据补 U17）；⑥ verification-log 记批 1 交付读数与"同树并发跑 check 会假红"纪律 |
| 2026-10-09 | **v1.2 的副作用（事故）**：父侧在评审 PASS 后直接改了被审文档且未重审 ⇒ 令牌的文档集指纹失配（`0a503b5c…` → `e5e216ca…`）⇒ 批 1 派单秒级失败（`eng-dsh-29`，子会话只有 header、工作区零改动）。处置＝重审取新 token 后重派；纪律已写入实施计划 §6 |

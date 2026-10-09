# 会诊纪要 —— consult #28（原始层，机制落盘）

- 日期：2026-10-09
- 会诊 id：28
- 模型：deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, kimi-api:kimi-k3, opencode-go-plan:mimo-v2.6-pro
- 平台 job：consult-5
- 结果：3/4 交付（其中 3 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #28 finished — 3 of 4 replied (1 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #28 finished — 3 of 4 replied (1 failed)]
effective: 3 of 4 (1 failed · 0 without content)
权限面如实（A30-10）：**本部署无法保证只读（平台面无法收窄）**——「只读」仅为**弱证**：`toolFilter.allow` 白名单**下发**（平台不保证模型面可见）；**模型面证据**须读子会话 `request/header` 事件（本部署实测 = [run_code] 单元素 ⇒ 残余绕行口在场，子会话实为 `danger-full-access`）。
models: deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, kimi-api:kimi-k3, opencode-go-plan:mimo-v2.6-pro
job: consult-5
minutes: docs/consult-minutes/2026-10-09-consult-28-minutes.md
requiresReport: true

--- replies (raw, unjudged — verify with your own tools) ---

[1] opencode-go-plan:mimo-v2.6-pro — failed
(consultation failed: child ended: error — 子代理面不可诊断（no diagnostic, and the child session log gave no turn/end reason — 本部署无法取得该证据：子会话 id / 会话档 / 解压任一不可得）)

[2] deepseek-official:deepseek-v4-pro — ok
# 独立意见（会诊子会话 · deepseek-v4-pro）：预算幻觉判别 + 会话资源读数 + 轮换触发设计

> 本轮全部行号为 2026-10-09 11:0x 实读 as-of 读数：插件仓 `lib/index.js`（12053 行）、`host-half.test.mjs`（9374 行）、宿主 asar 内 `@deepseek-ai/dsh-*` 源码、真机 `team-link-2026-10-08-worker-4-34504f2d` 会话日志（1791 事件）。本子会话**未写任何文件**（吸取 consult #26 教训，全程只读）。

## 0. 一句话结论

父侧诊断**成立且可加强**：worker 的「预算收口」**是幻觉**——宿主没有、也不可能给它任何预算真值（实测 0 命中），而宿主有自动压缩兜底，结构上不存在「预算耗尽」。**修法是双管齐下**：① 把宿主的资源真值（压力/阈值/累计/轮数）做成**可核对读数**，让「预算耗尽」成为一句**当场可证伪**的话；② 用**读数（拉）**+ **本人提示段（每回合在眼前）**+ **轮换候选标记**三个落点，把幻觉的温床（无真值 + 交接压力）抽掉。**不建议**新增任何推送机制或自动轮换——本批可以做到**零新增事件类型、零新投递路径、零写**。

## 1. 父侧证据逐条复核（我的实测读数）

| 父侧声称 | 我的复核 | 结论 |
|---|---|---|
| worker-4 自称「预算收口」无环境依据 | 会话日志中 93 行含「预算/budget」：user/message 6（工作区 AGENTS.md）、assistant/message 38（**模型自己的话**）、tool/result 29、request/header 2、tool/call 13、agent/inbox/spliced 5；**system/message 与 request/context 中恰 0 行**。原文在场：turn 31 step 7 的 `team_link_send`「②四档现场读全、实现未动——预算收口，交接防半成品」 | **确认** |
| 它唯一能看到的是 `contextWindow=1000000` | `request/context` = `{provider:qax, model:deepseek-v4-flash, contextWindow:1000000}`；另有 `request/header.config.maxTokens:393216`（**输出预留**，不是预算读数） | **确认，且补一条**：它还看得到 `maxTokens=393216`，这很可能就是「预算」这个词的触发点 |
| 宿主有自动压缩，结构上不存在预算耗尽 | 实测触发机制**两条路**：① 主动——`agent/pre-step` 钩子（`dsh-compaction-basic/lib/index.js:839-852`）每步前 `compactIfNeeded(agent,"pressure")`；② 被动——`agent/request-error` 收到 `CONTEXT_WINDOW_EXCEEDED_CODE`（`:861-887`）即压缩+重试（maxOverflowRetries）。主动路压缩失败 = **warn + 继续回合**（`:843-850`），不杀死会话 | **确认** |
| 阈值公式 | `resolveCompactSpec`（`:124-147`）逐字：`messageBudget = contextWindow − reservedCompletion`；`pressureBudget = messageBudget − headroom(65536)`；`thresholdTokens = floor(min(window×0.8, pressureBudget))`；`retain = messageBudget×0.16`。**worker-4 实例**：1000000−393216−65536 ⇒ **实际压缩阈值 ≈ 541K**（约 54% 窗口，因输出预留大） | **确认，且拿到精确公式** |
| `ctx.tokenMeter` 三个投影可经 `sessionProjections.stateOf(session,key)` 读 | 实测：`dsh-token-meter/lib/index.js` 注册 `tokenUsage`（state v2：`totals{uncachedInput,cacheRead,cacheWrite,output}` + `last{turn,step}`，`:413`）、`contextPressure`（v5：`contextWindow/pressureTokens/sampledSurfaceTokens/surfaceTokens`，视图含 `projectedTokens`，`:468-515`）、`contextBreakdown`（v5：`systemTokens/toolsTokens/messageTokens`，`:209`）。`dsh-session-projection/lib/index.js:127-132`：`stateOf(session,key)` 同步、key 未注册返回 undefined。**另发现**：`dsh-session-stats` 注册 `sessionStats` 投影含 **`turns`**（`steps/llmMs/…/turns`）——>100 轮判据**直接可读**，不用数日志 | **确认，且补一个投影** |
| 提示段函数型 text 每次装配求值 | `dsh-system-prompt/lib/index.js:342` 逐字确认；**关键补充**：装配上下文 `assembleContextFor(agent,signal) = {agent, scope, signal}`（`dsh-agent/lib/index.js`）⇒ 函数型 text 里 **`context.agent.session` 拿得到** ⇒ 提示段可以同步读**自己会话**的投影。宿主压缩引擎自己也用 `ctx.tokenMeter.measure(agent.session)`（`dsh-compaction-basic:918-919`）⇒ 卡片与压缩引擎**同一套计价** | **确认，且拿到可用性证据** |

父侧「无环境依据」诊断**全部经我独立复核成立**；另有两条补强：`maxTokens` 预留是真值之一；计价口径是「固定密度估算（4 字符/token）+ 提供商上报采样」混合，**读数必须标注口径**，否则下一轮幻觉就会从「预算」转移到「这些数字不准」。

## 2. 根因补全（幻觉的机制，比「没有真值」多一层）

1. **无真值面**：worker 的提示里没有任何「你用了多少、还剩多少」的数字（实测 0 命中）。
2. **交接压力 + 数字暗示**：它的上下文里有 `contextWindow: 1000000` 和 `maxTokens: 393216` 两个裸数字，加上「长会话要交接收尾」的任务压力，模型会**用最像的那个词**（预算）去圆一个它其实没有数据支撑的决定——它**想**收尾，于是**编**了一个收尾理由。
3. **协调者无法证伪**：协调者手里也没有任何预算读数（状态卡七段里没有），所以「预算收口」这种话**一次通过、无需举证**。这是双向的洞：worker 没真值可说，协调者没真值可查。
4. **与「失联 vs 空闲」同构**：这正是 consult #26 里 `silent-idle` 被写成「失联征兆」的同一类病——**把模型的自述当成状态事实**。治法相同：让状态**可读、可核**，而不是信自述。

## 3. 判别机制（可证伪规则；建议直接写进卡片文案）

一个「预算耗尽/收口」主张，对照三件地面真值：

| 真值 | 来源 | 判读 |
|---|---|---|
| 当前压力 / 投影压力 | `contextPressure`：`pressureTokens`（提供商上报的输入采样）/ `projectedTokens`（压力+界面−采样界面） | 相对 `thresholdTokens`（**不是**窗口 100%）算百分比 |
| 压缩阈值与自动压缩 | `thresholdTokens = floor(min(window×0.8, window−预留输出−headroom))`；`auto` 默认 true（`dsh-compaction-basic:66`） | 低于阈值且 auto 开 ⇒ **「无收口理由」** |
| 累计用量 / 轮数 | `tokenUsage.totals` 求和、`sessionStats.turns` | 只用于轮换判据（§5），**不是**预算判据——会话累计用量与「还能不能跑下一步」无关 |

**判读行（建议逐字）**：`预算判读：压力 X%（压缩阈值 Y%，自动压缩开）——「预算耗尽」不成立：宿主会在下一步前自动压缩。` 只有当 `projectedTokens ≥ thresholdTokens` 时才换措辞：`压力已到压缩阈值——宿主即将自动压缩，无需停手；若确实要交接，走 team_link_rotate 而非「预算收口」。`

**为什么这个判读是防幻觉的核心**：它把「预算」从模型自述降级为**卡片上的一个可核对行**——协调者一读卡就知道 worker 的话真伪；worker 自己的提示段里也是同一个数字，它无法自洽地声称耗尽。**「预算耗尽」这个词从此在工具文案里只允许出现在「判读：不成立」之后**。

## 4. 读数落点（三面；推荐 1 必做 + 2 强烈建议 + 3 顺带）

**① 工具面（拉，必做，成本最低）**：`team_link_status` 追加**第 ⑧ 段「资源/预算」**。每会话一行（复用既有 `readWindow` 有界读窗，只读活代理：`ctx.agents.get(id)` 拿 `agent.session` → `stateOf(agent.session,"contextPressure"/"tokenUsage"/"sessionStats")`）：
`- <id>：压力 12%（阈值 54%）· 累计 ≈ 41M · 轮 87（读数 <turn>.<step>）`＋跨行判读。读数标注口径一行：「压力=提供商上报；界面/工具=固定密度估算；累计=上报采样累计（会话全寿命）」。无活动代理/服务缺席 ⇒ 如实标「不可读」，**不编数**（沿 `goal=?` 先例）。**零写入**：投影读取不改 settings/磁盘（`U9` 断言继续绿）；「不缓存」合同不破——那是宿主投影服务自己的缓存，卡片不新增任何插件侧状态。
> 已知成本：`readWindow` ≤12 会话 × 3 投影的同步 `stateOf`（缓存后 O(1)），与既有 surface 读取同量级；沿用「超出窗口如实标未读」。**注意**：工具描述里「七段」要同一次编辑改成「八段」（无测试钉「七段」，0 命中，安全）。

**② 提示段（push 到本人眼前，强烈建议，治本主干）**：对 roster 成员的活代理，经 `agent.ctx.systemPrompt.section({name:"team-link:session-resources", order: TEAM_POLICY, text: (ctx) => …})` 注册**函数型 text**，每装配读**自己**会话的投影（`context.agent.session` 已证可用），渲染 ≤2 行：
`[team-link 会话资源] 窗口 1.0M · 压力 X% · 压缩阈值 Y%（自动压缩开）· 累计 ≈ Z · 第 N 轮。` 特征探测失败（无 `sessionProjections` 或 key 未注册）⇒ **不注册段 + 一行 warn**。生命周期与 consult #26 批 2 的宪章段**同一套注册/释放机制**（agent 出现/消失/换届重挂）——**建议与宪章段合并为同一段的一次注册**（coordinator 版=宪章+资源，worker 版=资源+汇报义务），一次特征探测、一套 dispose，不要两套生命周期。这是根因 1 的正解：worker 每回合都看见自己的压力百分比，它无法再自洽地说「预算耗尽」。

**③ 脉冲/看门狗（顺带，本批不建议新增）**：预算**不做**新 tick 类。若 consult #26 的工作台 digest 获批落地，digest 常量里加一组「资源」行（沿用 digest 的反走私不变式、`slp-wb-` 前缀、去抖与 TTL）即可；**不批也不影响本批**。理由：预算不是事件性问题（不像失联），拉+自见两面已经闭环，推送只会多一条「打断正在实施的回合」的支路。

## 5. 轮换触发与交接

- **触发读数（零新机制）**：`sessionStats.turns > 100` 或 `Σ tokenUsage.totals > 200M`（用户口径），由卡片 ⑧ 段行尾标 `⚠ 轮换候选（turns=143 / tokens≈231M）`，并附一句指引：`team_link_rotate action=prepare successor:"auto" + handoff（五硬节）`。
- **交接复用既有工具，不改**：`team_link_rotate`（`lib/index.js:4953-4969`）已支持 `successor:"auto"` 自建继任根会话 + 五硬节交接文档 + 30 分钟令牌 + 全队 freeze 广播 + claim 双确认/24h 回退——这就是「超长会话轮换」的现成机器。本批**只加触发标记，不加自动轮换**：自动轮换 = 定时器里做写操作 + 广播 + 建会话，违反「看门狗只管报警」的边界，且 freeze 会打断正在干活的团队；轮换本质是**用户/协调者的一次决策**，标记+指引已足够。
- **worker 自见面的轮数/累计**：提示段②里带 `第 N 轮 · 累计 Z` ⇒ 轮到阈值时 worker 自己就能提出「该轮换了」并给出事实（而不是编「预算收口」）。
- **交接文档与预算的关系（重要）**：handoff 五硬节里应有「**为何轮换**」字段——填真原因（轮数/累计达标），**明令禁止**填「预算耗尽」（它是可证伪的假理由；卡片判读行就是证据）。

## 6. 五条约束逐条核对（全部有实测依据）

| 约束 | 合规方式 | 证据 |
|---|---|---|
| 不新增会话日志事件类型 | 本批**零写入**：投影读取是纯读；提示段注册走 `systemPrompt.section`（宿主既有面）；轮换标记只出现在卡片文本 | `stateOf` 只读（`dsh-session-projection:127-132`） |
| 投递 source 恰三成员 | 本批**零新投递路径**；digest（若做）沿用 `followup(relayUserMessage(...))` 既有三成员形状 | `lib/index.js:10776`（source 仍恰三成员 `{kind,form,senderSessionId}` 是既有裁定） |
| 模块级 `inject` 恒 4 项 | `sessionProjections` 走**执行时 `ctx.get`** 晚挂（与 `agentPresets`/`workspaceRegistry` 同款先例），缺席 ⇒ ⑧ 段如实标注 + 提示段不注册 | `lib/index.js:100`（inject 恰 4 项）；README「依赖的宿主服务」同款晚挂条目 |
| `writerGate` 函数体逐字节不变 | 本批**不碰任何写路径**（不写 roster/policy/黑板/设置） | `lib/index.js:3166-3180` 不进入改动面 |
| 现有 `host-half.test.mjs` 断言不破 | ⑧ 段为**追加**且全读；夹具假 agent 是裸对象、无投影服务 ⇒ 天然走「如实不可读」降级支；`U8 聚合`（:7658）`U9 零写入`（:7662-7669）两侧都不触 | 实测夹具形状 `host-half.test.mjs:56-63` |

## 7. 防偏离：具名断言清单（全部可 grep，红/绿两次读数入 verification-log）

- **U-BG1 降级**：无 `sessionProjections` 服务 ⇒ ⑧ 段输出一行「资源读数不可读（sessionProjections 服务缺席）」；卡不炸、U8/U9 原样绿。
- **U-BG2 读数形状**：有桩服务（夹具加 `sessionProjections.stateOf` 桩）⇒ 行含 `压力 X%（阈值 Y%）· 累计 · 轮`；`pressureTokens`/`contextWindow` 缺失 ⇒ 输出「窗口未知」而非 NaN/undefined。
- **U-BG3 判读行**：`projectedTokens < thresholdTokens` ⇒ 「无收口理由」；`≥` ⇒ 「即将自动压缩」；**两种措辞都不含「预算耗尽/收口」字样**。
- **U-BG4 轮换候选**：turns=99/101 与 tokens=199.9M/200.1M 四边界各一条断言——只在一侧出现「轮换候选」。
- **U-BG5 零写入**：⑧ 段在场时 U9 原断言不改仍绿（settings/磁盘逐字节不变）。
- **U-BG6 提示段**：函数型 text 渲染文本含窗口/压力/阈值/累计/轮、无 `{{变量}}` 残留；特征探测失败 ⇒ 零注册 + 一行 warn；仅 roster 成员活代理注册。
- **U-BG7 口径**：百分比 = `pressureTokens/contextWindow×100` 取整；卡片口径行逐字在场（防「数字不准」的下一次幻觉）。
- **回归**：既有三态 verdict、`placementLine` 首行、inject-4、AUDITED_SOURCE_KINDS（`host-half.test.mjs:1440`）断言全部原样绿。
- **真机冒烟（本批唯一真机项）**：重启后 ⑧ 段读数为 worker-4 型会话输出非零压力百分比；提示段在 worker 会话 `request/header` 内嵌工具描述中可见（沿 DEFECT-5 的取证法）。

## 8. 不做清单 / 风
… [reply capped at 8000 chars — the uncapped text is in the minutes' §1.1]

[3] zai-coding-cn:glm-5.3 — ok
证据链已闭环。作为被委派的子代理，我按在飞工作（新批次：上下文预算 / 压缩 / 用量 / 生命周期）做了独立复核——全部读数为本轮实测，未改动仓库任何文件（`git status` 仍只有 2026-10-08 那三个未跟踪文档）。

## 交付：新批次根因链的独立复核（全部一手读数）

**先说限制**：我的委派提示没有随问题文本送达，以上是按最新在飞批次重建的任务面；会诊/作业工具（`consult_*` / `job_output`）不在子代理权限面，**新会诊截至 2026-10-09 11:05（本机）仍未落纪要**（[docs/consult-minutes](docs/consult-minutes) 目录无新文件）——无法核实它是在跑还是启动失败；qax 网关的**真实**上下文上限无法静态验出（需活体探测，未做）。

### ① 四名 worker 全部「以为」自己有 100 万上下文

会话日志 `request/context` 事件（逐帧解 zstd 实读）：团队 `2026-10-08` 四名 worker 全部是 `{provider:"qax", model:"deepseek-v4-flash", contextWindow:1000000}`。来源是宿主配置 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 llm-pi-ai 段（`qax` → `ai-gateway.qianxin-inc.cn`，`deepseek-v4-flash/pro` 声明 `contextWindow: 1000000, maxTokens: 393216`）——**声明值，从未对网关实测**。

### ② 请求头里确实一个字的预算信息都没有

worker-1 的 `request/header` 共 123,687 字符（工具表+系统提示），检索 `budget`/`token`/`剩余`/`预算` 仅命中工具描述里的无关词；`dsh-token-meter` 源码 0 处提示词注入（无 systemPrompt/reminder/budget 面）。**模型侧对自身余量完全盲**。

### ③ 压缩触发的算术（源码级）

`dsh-compaction-basic/lib/index.js:124-146`：`threshold = min(contextWindow×0.8, contextWindow − maxTokens − headroom)`。代入 qax 路由 = **min(800,000, 1,000,000−393,216−65,536) = 541,248 个「估算」token**；且压力测量用本地启发式估算器（`CHARS_PER_TOKEN=4`），**不消费 API 回报的真实 usage**。

### ④ 估算器对中文内容系统性低估 —— 有一手铁证

三次全量压缩的摘要调用本身会把同一批内容回放给 API，其 `usage` 就是真实尺寸：

| 压缩事件 | 估算器计价（shadowedTokenCount） | API 实测（cacheRead） | 低估倍数 |
|---|---|---|---|
| w1 @10-09 02:16Z | 213,406 | 378,880 | ≈1.78× |
| w2 @10-08 15:20Z | 205,127 | 387,200 | ≈1.89× |
| w2 @10-08 20:57Z | 271,880 | 417,792 | ≈1.54× |

⇒ 估算器报 541k 触发时，**真实请求体大概率已在 84 万–100 万 token**，正好撞网关真实上限。

### ⑤ 撞限后的救援通道接不上

溢出强制压缩只挂在 `agent/request-error` 且 `code === "CONTEXT_WINDOW_EXCEEDED"`（`dsh-compaction-basic:861-887`）；该码的判定在 `dsh-llm-pi-ai/lib/index.js:1402-1411`——靠错误文本识别或「usage 超过**声明的** contextWindow」。而四名 worker 实际收到的失败全部被归类 `TIMEOUT`（`pi-ai stream idle timeout after 300000ms`）/`TRANSPORT`/`SERVER`，走的是普通 5 次重试（每次重发整包），**溢出救援一次都没触发**。

### ⑥ 现场损伤（四名 worker 全量扫档）

| worker | 回合/时长 | 重试 | 全量压缩 | 其他 |
|---|---|---|---|---|
| w1 | 20 回合 / 19.5h | 8 次（TIMEOUT 4 + TRANSPORT 4） | 1 次（02:16Z，压掉 497 节点） | 剪枝 16 次/6.3 万 tok |
| w2 | 23 回合 | 4 次 | **2 次**（15:20Z / 20:57Z） | **1 回合 `kind=max-tokens` 死亡**（08:43Z）；今晨 03:02Z 仍在收信 |
| w3 | 23 回合 | 0 | 0 | 干净 |
| w4 | 32 回合 | 2 次（SERVER） | 0 | 干净 |

副作用与待裁设计直连：全量压缩把整段历史压成一条摘要，worker 的 kickoff 角色简报**只靠摘要运气存活**——这正是 [coordinator-charter-and-pulse-design-2026-10-08.md](docs/coordinator-charter-and-pulse-design-2026-10-08.md) 层 3（提示层「不参与压缩」）要治的东西；脉冲段（L3-b）顺带就是「预算/压力行」的天然载体。

### 今天可用的三档处置（零代码 → 配置 → 宿主）

1. **配置（立刻）**：desktop profile 补 `compaction-basic` 的 `modelPolicies` 精确覆盖（qax 两条路由调低 `thresholdRatio` 或加大 `headroomTokens`；挂载点在 `dsh-base/cordis.patch.yml` 的 `compaction-basic`，当前**零配置**走默认值）；同时把 qax 模型的声明 `contextWindow` 改成网关实测值。
2. **插件侧（并入本批设计）**：脉冲/章程段带一行估算压力与最近一次 API 实测 usage，治「模型对余量盲」。
3. **宿主侧（登记不在本仓）**：CJK 估算校准、大包 idle-timeout 识别为疑似溢出、真实 usage 回灌压力环——`~/.dsh/.dsh-usage-stats.json`（source: session-logs，byModel 有 glm-5.3 的 34.7 亿 input 实测）证明数据**事后有**，只是没进活体环。

未动仓库、未写任何文件；新会诊结果出来后，以上读数可直接与其回复对账。

[4] kimi-api:kimi-k3 — ok
证据链已闭合。以下是本会诊的独立意见。

---

# 会诊意见：worker 的 `contextWindow: 1000000` 与「无 harness 预算文本」

## 裁定：主会话的根因证据**成立**，且两条都比我预期的更硬——但有一处重要的范围修正

我独立复验了全部证据（未采信主会话历史中的任何读数，全部重新取证）。**「无预算文本」不是 worker 特有，是全 harness 的事实**：主会话、协调者、worker 的模型可见面都没有任何 token 预算信息，预算只活在 GUI 里。

## 一、独立复验读数（全部 [实测]，带坐标）

| # | 声称 | 复验结果 | 坐标 |
|---|---|---|---|
| E1 | worker 看到 `contextWindow: 1000000` | ✅ 成立，且定位到来源：**部署模型目录**声明，非 harness 常量。worker-2 会话日志恰 1 处 `request/context`：`{"provider":"qax","model":"deepseek-v4-flash","contextWindow":1000000}` | `profiles/desktop/cordis.patch.yml:253-256`（qax 网关 `deepseek-v4-flash`：window 1M、maxTokens 393,216）；日志 `team-link-2026-10-08-worker-2-c1672114/session.v4.jsonl.zstd` event#15 |
| E2 | 无 harness 预算文本 | ✅ 成立，且**全 harness 无例外**：① systemPrompt 全部 50 处注册（section/context/variable）无一带预算；② runtime-context 快照的贡献者（sandbox-policy / user-approval / time-context / subagent）均不含预算——worker-2 实收的 4 份快照只有 file policy + approval policy 两段；③ worker 的 28,855 字符系统提示实测零预算行；④ 唯一预算展示是 GUI 客户端文案 `"{percent} of context used"`（`dsh-client-ui-conversation/lib/client.js:14899`）+ `~X / Y tokens`（:17106）；⑤ 用户插件 `dsh-context` 只注册 GUI 侧 `sessionProjections`，不碰系统提示 | `dsh-system-prompt/lib/index.js:135`；`dsh-agent-loop/lib/index.js:218` |
| E3 | compaction 对 team worker 是否生效 | ✅ **生效**。自动压缩挂全局 `agent/pre-step`（pressure）与 `agent/request-error`（overflow）两个钩子；worker 是插件创建的**根会话**（header：`agentPreset:"standard"`、`delegationDepth:0`），事件上冒到根上下文即被同一引擎处理。worker-2 实测：压缩 **2 次**（turn 14、18）+ tool-result prune 12 次；协调者会话：压缩 1 次（turn 155/174）+ prune 11 次 | `dsh-compaction-basic/lib/index.js:839-887` |
| E4 | 触发阈值 | 默认 `thresholdRatio=0.8`、`headroomTokens=65,536`、`retainRatio=0.16`、`auto=true`、`maxOverflowRetries=1`（本部署未配置，走默认）。公式 `threshold=floor(min(window×0.8, window−reserved−65536))`。qax/deepseek-v4-flash：`min(800,000, 1,000,000−393,216−65,536)` = **541,248 token** | `dsh-compaction-basic/lib/index.js:59-87`（默认）、`:124-147`（公式）、`DEFAULT_THRESHOLD_RATIO=.8` |
| E5 | usage accounting | harness 核心只有**单会话** tokenMeter（pressure/surface 投影，`dsh-token-meter`）；**跨会话/成本账不是核心能力**——本机的 `.dsh-usage-*.json` 是用户插件 `@kenz1117/dsh-ui-usage-billing` 从 session log 聚合写的（`lib/index.js:6914`）。参考读数：10-08 单日 8,318 调用 / 25.4 亿 input token / ¥257（cache hit 97.5%） | `dsh-token-meter/lib/index.js:613-614`；`~/.dsh/.dsh-usage-stats.json` |
| E6 | teammate lifecycle | team-link 的 worker **不是**宿主 Agent Teams 的 teammate，而是与主会话同权的完整根会话：完整插件栈、完整 28.8KB 系统提示（含 openpencil/undo/genui 等全量用户插件段）、jsonl.zstd 持久化、重启后插件 attach 重建。harness 没有独立的「teammate 预算/生命周期」子系统 | 会话 header；`dsh-experimental-agent-team` 是另一套未被子系统采用的体系 |

## 二、对主会话结论的三处修正/补强

1. **范围修正（最重要）**：「worker 看不到预算」不应表述为 team/worker 缺陷——**harness 从不向任何模型注入预算文本**。这反而简化了修法：插件要补的不是「worker 特供」，而是一个对任意会话都成立的能力，协调者会话同样受益（协调者也盲）。
2. **1M 声明的真实后果不是「不压缩」，是「压缩来得太晚」**：541K token 阈值 ≈  worker 跑完大半辈子才第一次压缩（worker-2 在 turn 14/23 才首压）。压缩的 summarize 调用走**会话同模型**（未配 summarizationProvider），即每次压缩 = 一次 ~50 万 token 上下文的 qax 计费调用。且若 qax 网关真实窗口 < 541K（未验证，见待核），压力路径永远来不及，每次越界只能靠 overflow 恢复（重试预算仅 1 次），再往上就是请求硬失败。
3. **worker 继承全量桌面提示栈**：每个 worker 每请求固定烧 ~7-8K token 的系统提示（28.8KB，含与团队工作无关的 openpencil/genui/undo 等段）。这是团队形态的固定成本放大器（5 会话 × 每步），也是干扰面。

## 三、对新批次的可执行建议

1. **预算可见性不需要等 harness**——插件已有validated机制：10-08 设计档 §3 [实测] 的 agent 作用域 `systemPrompt.context({text: fn})`（每次装配求值）。provider 里调 `ctx.tokenMeter.measure(agent.session)`（compaction-basic 同款内部面，`dsh-compaction-basic/lib/index.js:919`），输出一行 `context ~X / threshold 541K / retain 97K`。tokenMeter 属内部服务面 ⇒ 沿用 L3-d 纪律：特征探测 + 失败降级 + 如实 warn。这把 L3-b 团队脉冲从「谁在跑」升级为「谁在跑 + 谁快炸了」。
2. **阈值不要用 contextWindow 的分数**：部署目录的 1M 是市场数字，与 provider 真实窗口的关系 [待核]。脉冲/看门狗的报警线用**绝对刻度**（如 measured>200K 提示、>400K 建议轮换），与 harness 的 541K 压缩阈值解耦。
3. **把压缩变成可调度信号**：脉冲 provider 能算出「距 541K 阈值还差多少」⇒ 协调者可在压缩前主动轮换 worker（把 ~50 万 token 的总结调用成本换成一次 kickoff 成本），这是团队形态独有的优化，主会话做不到。
4. **团队级成本账**：harness 不会代劳（E5）。若本批要做成本治理，插件侧从 tokenMeter 投影或 session log 聚合（usage-billing 插件的读法可借鉴，它读的就是同一批 jsonl）。
5. **worker 提示瘦身（可选，收益立现）**：scoped section 同名遮蔽（`dsh-system-prompt` 支持按 agent 作用域 shadow）可把 openpencil/genui 等与团队工作无关的段在 worker 会话里盖掉，每请求立省数千 token。

## 四、待核与边界（如实）

- **qax 网关真实窗口未验证**：worker-2 日志中 5 次 `llm/retry` 全属 EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT 族，无 CONTEXT_WINDOW_EXCEEDED；不能据此断言真实窗口是 1M 还是更小（也可能是会话没活到撞墙）。
- worker-2 两次压缩触发时的 tokenMeter 实测读数未直接取得（compaction 事件不携带 measurement）；「turn 14/18 触发」与 541K 阈值的一致性是配置算术推断，非直接测量。
- 只解码了 worker-2 与协调者两个会话（worker-1/3/4 未核，同构预期）；解码产物留在 `C:\Users\huangchaowen\.dsh\death-forensics\consult-w2-session.jsonl`（13.8MB 明文，主会话可直接复核，用完可删）。
- `dsh-context` GUI 注释镜像的 0.8 与我读到的 `DEFAULT_THRESHOLD_RATIO=.8` 双源一致。

**一句话结论**：根因两条都成立，但「无预算文本」是全 harness 的事实而非 worker 缺陷；真正的团队特有风险是「部署声明的 1M 窗口把自动压缩推到 54 万 token」，而这恰好给了插件一个主会话没有的机会——用已有 L3 机制把 tokenMeter 读数做成每次装配重算的脉冲行，在 harness 压缩之前由协调者主动轮换。
```

### §1.1 未截断全文（**仅当有回复超 8000 字软顶时出现**；机制写）

#### [2] deepseek-official:deepseek-v4-pro（9051 字）

```text
# 独立意见（会诊子会话 · deepseek-v4-pro）：预算幻觉判别 + 会话资源读数 + 轮换触发设计

> 本轮全部行号为 2026-10-09 11:0x 实读 as-of 读数：插件仓 `lib/index.js`（12053 行）、`host-half.test.mjs`（9374 行）、宿主 asar 内 `@deepseek-ai/dsh-*` 源码、真机 `team-link-2026-10-08-worker-4-34504f2d` 会话日志（1791 事件）。本子会话**未写任何文件**（吸取 consult #26 教训，全程只读）。

## 0. 一句话结论

父侧诊断**成立且可加强**：worker 的「预算收口」**是幻觉**——宿主没有、也不可能给它任何预算真值（实测 0 命中），而宿主有自动压缩兜底，结构上不存在「预算耗尽」。**修法是双管齐下**：① 把宿主的资源真值（压力/阈值/累计/轮数）做成**可核对读数**，让「预算耗尽」成为一句**当场可证伪**的话；② 用**读数（拉）**+ **本人提示段（每回合在眼前）**+ **轮换候选标记**三个落点，把幻觉的温床（无真值 + 交接压力）抽掉。**不建议**新增任何推送机制或自动轮换——本批可以做到**零新增事件类型、零新投递路径、零写**。

## 1. 父侧证据逐条复核（我的实测读数）

| 父侧声称 | 我的复核 | 结论 |
|---|---|---|
| worker-4 自称「预算收口」无环境依据 | 会话日志中 93 行含「预算/budget」：user/message 6（工作区 AGENTS.md）、assistant/message 38（**模型自己的话**）、tool/result 29、request/header 2、tool/call 13、agent/inbox/spliced 5；**system/message 与 request/context 中恰 0 行**。原文在场：turn 31 step 7 的 `team_link_send`「②四档现场读全、实现未动——预算收口，交接防半成品」 | **确认** |
| 它唯一能看到的是 `contextWindow=1000000` | `request/context` = `{provider:qax, model:deepseek-v4-flash, contextWindow:1000000}`；另有 `request/header.config.maxTokens:393216`（**输出预留**，不是预算读数） | **确认，且补一条**：它还看得到 `maxTokens=393216`，这很可能就是「预算」这个词的触发点 |
| 宿主有自动压缩，结构上不存在预算耗尽 | 实测触发机制**两条路**：① 主动——`agent/pre-step` 钩子（`dsh-compaction-basic/lib/index.js:839-852`）每步前 `compactIfNeeded(agent,"pressure")`；② 被动——`agent/request-error` 收到 `CONTEXT_WINDOW_EXCEEDED_CODE`（`:861-887`）即压缩+重试（maxOverflowRetries）。主动路压缩失败 = **warn + 继续回合**（`:843-850`），不杀死会话 | **确认** |
| 阈值公式 | `resolveCompactSpec`（`:124-147`）逐字：`messageBudget = contextWindow − reservedCompletion`；`pressureBudget = messageBudget − headroom(65536)`；`thresholdTokens = floor(min(window×0.8, pressureBudget))`；`retain = messageBudget×0.16`。**worker-4 实例**：1000000−393216−65536 ⇒ **实际压缩阈值 ≈ 541K**（约 54% 窗口，因输出预留大） | **确认，且拿到精确公式** |
| `ctx.tokenMeter` 三个投影可经 `sessionProjections.stateOf(session,key)` 读 | 实测：`dsh-token-meter/lib/index.js` 注册 `tokenUsage`（state v2：`totals{uncachedInput,cacheRead,cacheWrite,output}` + `last{turn,step}`，`:413`）、`contextPressure`（v5：`contextWindow/pressureTokens/sampledSurfaceTokens/surfaceTokens`，视图含 `projectedTokens`，`:468-515`）、`contextBreakdown`（v5：`systemTokens/toolsTokens/messageTokens`，`:209`）。`dsh-session-projection/lib/index.js:127-132`：`stateOf(session,key)` 同步、key 未注册返回 undefined。**另发现**：`dsh-session-stats` 注册 `sessionStats` 投影含 **`turns`**（`steps/llmMs/…/turns`）——>100 轮判据**直接可读**，不用数日志 | **确认，且补一个投影** |
| 提示段函数型 text 每次装配求值 | `dsh-system-prompt/lib/index.js:342` 逐字确认；**关键补充**：装配上下文 `assembleContextFor(agent,signal) = {agent, scope, signal}`（`dsh-agent/lib/index.js`）⇒ 函数型 text 里 **`context.agent.session` 拿得到** ⇒ 提示段可以同步读**自己会话**的投影。宿主压缩引擎自己也用 `ctx.tokenMeter.measure(agent.session)`（`dsh-compaction-basic:918-919`）⇒ 卡片与压缩引擎**同一套计价** | **确认，且拿到可用性证据** |

父侧「无环境依据」诊断**全部经我独立复核成立**；另有两条补强：`maxTokens` 预留是真值之一；计价口径是「固定密度估算（4 字符/token）+ 提供商上报采样」混合，**读数必须标注口径**，否则下一轮幻觉就会从「预算」转移到「这些数字不准」。

## 2. 根因补全（幻觉的机制，比「没有真值」多一层）

1. **无真值面**：worker 的提示里没有任何「你用了多少、还剩多少」的数字（实测 0 命中）。
2. **交接压力 + 数字暗示**：它的上下文里有 `contextWindow: 1000000` 和 `maxTokens: 393216` 两个裸数字，加上「长会话要交接收尾」的任务压力，模型会**用最像的那个词**（预算）去圆一个它其实没有数据支撑的决定——它**想**收尾，于是**编**了一个收尾理由。
3. **协调者无法证伪**：协调者手里也没有任何预算读数（状态卡七段里没有），所以「预算收口」这种话**一次通过、无需举证**。这是双向的洞：worker 没真值可说，协调者没真值可查。
4. **与「失联 vs 空闲」同构**：这正是 consult #26 里 `silent-idle` 被写成「失联征兆」的同一类病——**把模型的自述当成状态事实**。治法相同：让状态**可读、可核**，而不是信自述。

## 3. 判别机制（可证伪规则；建议直接写进卡片文案）

一个「预算耗尽/收口」主张，对照三件地面真值：

| 真值 | 来源 | 判读 |
|---|---|---|
| 当前压力 / 投影压力 | `contextPressure`：`pressureTokens`（提供商上报的输入采样）/ `projectedTokens`（压力+界面−采样界面） | 相对 `thresholdTokens`（**不是**窗口 100%）算百分比 |
| 压缩阈值与自动压缩 | `thresholdTokens = floor(min(window×0.8, window−预留输出−headroom))`；`auto` 默认 true（`dsh-compaction-basic:66`） | 低于阈值且 auto 开 ⇒ **「无收口理由」** |
| 累计用量 / 轮数 | `tokenUsage.totals` 求和、`sessionStats.turns` | 只用于轮换判据（§5），**不是**预算判据——会话累计用量与「还能不能跑下一步」无关 |

**判读行（建议逐字）**：`预算判读：压力 X%（压缩阈值 Y%，自动压缩开）——「预算耗尽」不成立：宿主会在下一步前自动压缩。` 只有当 `projectedTokens ≥ thresholdTokens` 时才换措辞：`压力已到压缩阈值——宿主即将自动压缩，无需停手；若确实要交接，走 team_link_rotate 而非「预算收口」。`

**为什么这个判读是防幻觉的核心**：它把「预算」从模型自述降级为**卡片上的一个可核对行**——协调者一读卡就知道 worker 的话真伪；worker 自己的提示段里也是同一个数字，它无法自洽地声称耗尽。**「预算耗尽」这个词从此在工具文案里只允许出现在「判读：不成立」之后**。

## 4. 读数落点（三面；推荐 1 必做 + 2 强烈建议 + 3 顺带）

**① 工具面（拉，必做，成本最低）**：`team_link_status` 追加**第 ⑧ 段「资源/预算」**。每会话一行（复用既有 `readWindow` 有界读窗，只读活代理：`ctx.agents.get(id)` 拿 `agent.session` → `stateOf(agent.session,"contextPressure"/"tokenUsage"/"sessionStats")`）：
`- <id>：压力 12%（阈值 54%）· 累计 ≈ 41M · 轮 87（读数 <turn>.<step>）`＋跨行判读。读数标注口径一行：「压力=提供商上报；界面/工具=固定密度估算；累计=上报采样累计（会话全寿命）」。无活动代理/服务缺席 ⇒ 如实标「不可读」，**不编数**（沿 `goal=?` 先例）。**零写入**：投影读取不改 settings/磁盘（`U9` 断言继续绿）；「不缓存」合同不破——那是宿主投影服务自己的缓存，卡片不新增任何插件侧状态。
> 已知成本：`readWindow` ≤12 会话 × 3 投影的同步 `stateOf`（缓存后 O(1)），与既有 surface 读取同量级；沿用「超出窗口如实标未读」。**注意**：工具描述里「七段」要同一次编辑改成「八段」（无测试钉「七段」，0 命中，安全）。

**② 提示段（push 到本人眼前，强烈建议，治本主干）**：对 roster 成员的活代理，经 `agent.ctx.systemPrompt.section({name:"team-link:session-resources", order: TEAM_POLICY, text: (ctx) => …})` 注册**函数型 text**，每装配读**自己**会话的投影（`context.agent.session` 已证可用），渲染 ≤2 行：
`[team-link 会话资源] 窗口 1.0M · 压力 X% · 压缩阈值 Y%（自动压缩开）· 累计 ≈ Z · 第 N 轮。` 特征探测失败（无 `sessionProjections` 或 key 未注册）⇒ **不注册段 + 一行 warn**。生命周期与 consult #26 批 2 的宪章段**同一套注册/释放机制**（agent 出现/消失/换届重挂）——**建议与宪章段合并为同一段的一次注册**（coordinator 版=宪章+资源，worker 版=资源+汇报义务），一次特征探测、一套 dispose，不要两套生命周期。这是根因 1 的正解：worker 每回合都看见自己的压力百分比，它无法再自洽地说「预算耗尽」。

**③ 脉冲/看门狗（顺带，本批不建议新增）**：预算**不做**新 tick 类。若 consult #26 的工作台 digest 获批落地，digest 常量里加一组「资源」行（沿用 digest 的反走私不变式、`slp-wb-` 前缀、去抖与 TTL）即可；**不批也不影响本批**。理由：预算不是事件性问题（不像失联），拉+自见两面已经闭环，推送只会多一条「打断正在实施的回合」的支路。

## 5. 轮换触发与交接

- **触发读数（零新机制）**：`sessionStats.turns > 100` 或 `Σ tokenUsage.totals > 200M`（用户口径），由卡片 ⑧ 段行尾标 `⚠ 轮换候选（turns=143 / tokens≈231M）`，并附一句指引：`team_link_rotate action=prepare successor:"auto" + handoff（五硬节）`。
- **交接复用既有工具，不改**：`team_link_rotate`（`lib/index.js:4953-4969`）已支持 `successor:"auto"` 自建继任根会话 + 五硬节交接文档 + 30 分钟令牌 + 全队 freeze 广播 + claim 双确认/24h 回退——这就是「超长会话轮换」的现成机器。本批**只加触发标记，不加自动轮换**：自动轮换 = 定时器里做写操作 + 广播 + 建会话，违反「看门狗只管报警」的边界，且 freeze 会打断正在干活的团队；轮换本质是**用户/协调者的一次决策**，标记+指引已足够。
- **worker 自见面的轮数/累计**：提示段②里带 `第 N 轮 · 累计 Z` ⇒ 轮到阈值时 worker 自己就能提出「该轮换了」并给出事实（而不是编「预算收口」）。
- **交接文档与预算的关系（重要）**：handoff 五硬节里应有「**为何轮换**」字段——填真原因（轮数/累计达标），**明令禁止**填「预算耗尽」（它是可证伪的假理由；卡片判读行就是证据）。

## 6. 五条约束逐条核对（全部有实测依据）

| 约束 | 合规方式 | 证据 |
|---|---|---|
| 不新增会话日志事件类型 | 本批**零写入**：投影读取是纯读；提示段注册走 `systemPrompt.section`（宿主既有面）；轮换标记只出现在卡片文本 | `stateOf` 只读（`dsh-session-projection:127-132`） |
| 投递 source 恰三成员 | 本批**零新投递路径**；digest（若做）沿用 `followup(relayUserMessage(...))` 既有三成员形状 | `lib/index.js:10776`（source 仍恰三成员 `{kind,form,senderSessionId}` 是既有裁定） |
| 模块级 `inject` 恒 4 项 | `sessionProjections` 走**执行时 `ctx.get`** 晚挂（与 `agentPresets`/`workspaceRegistry` 同款先例），缺席 ⇒ ⑧ 段如实标注 + 提示段不注册 | `lib/index.js:100`（inject 恰 4 项）；README「依赖的宿主服务」同款晚挂条目 |
| `writerGate` 函数体逐字节不变 | 本批**不碰任何写路径**（不写 roster/policy/黑板/设置） | `lib/index.js:3166-3180` 不进入改动面 |
| 现有 `host-half.test.mjs` 断言不破 | ⑧ 段为**追加**且全读；夹具假 agent 是裸对象、无投影服务 ⇒ 天然走「如实不可读」降级支；`U8 聚合`（:7658）`U9 零写入`（:7662-7669）两侧都不触 | 实测夹具形状 `host-half.test.mjs:56-63` |

## 7. 防偏离：具名断言清单（全部可 grep，红/绿两次读数入 verification-log）

- **U-BG1 降级**：无 `sessionProjections` 服务 ⇒ ⑧ 段输出一行「资源读数不可读（sessionProjections 服务缺席）」；卡不炸、U8/U9 原样绿。
- **U-BG2 读数形状**：有桩服务（夹具加 `sessionProjections.stateOf` 桩）⇒ 行含 `压力 X%（阈值 Y%）· 累计 · 轮`；`pressureTokens`/`contextWindow` 缺失 ⇒ 输出「窗口未知」而非 NaN/undefined。
- **U-BG3 判读行**：`projectedTokens < thresholdTokens` ⇒ 「无收口理由」；`≥` ⇒ 「即将自动压缩」；**两种措辞都不含「预算耗尽/收口」字样**。
- **U-BG4 轮换候选**：turns=99/101 与 tokens=199.9M/200.1M 四边界各一条断言——只在一侧出现「轮换候选」。
- **U-BG5 零写入**：⑧ 段在场时 U9 原断言不改仍绿（settings/磁盘逐字节不变）。
- **U-BG6 提示段**：函数型 text 渲染文本含窗口/压力/阈值/累计/轮、无 `{{变量}}` 残留；特征探测失败 ⇒ 零注册 + 一行 warn；仅 roster 成员活代理注册。
- **U-BG7 口径**：百分比 = `pressureTokens/contextWindow×100` 取整；卡片口径行逐字在场（防「数字不准」的下一次幻觉）。
- **回归**：既有三态 verdict、`placementLine` 首行、inject-4、AUDITED_SOURCE_KINDS（`host-half.test.mjs:1440`）断言全部原样绿。
- **真机冒烟（本批唯一真机项）**：重启后 ⑧ 段读数为 worker-4 型会话输出非零压力百分比；提示段在 worker 会话 `request/header` 内嵌工具描述中可见（沿 DEFECT-5 的取证法）。

## 8. 不做清单 / 风险 / 文档卫生

**不做**：自动轮换；预算新 tick 类/新投递；在 `team_link_list_sessions` 同步加预算行（复用状态卡即可，避免双面成本）；把「预算」写进 worker kickoff 文案（kickoff 是一次性消息，会被压缩冲淡，且有「教模型说预算」的反效果——**只在判读行里出现该词**）。

**风险与对策**：① 数字口径被质疑（估算 vs 上报）→ 口径行逐字（U-BG7）；② 提示段每装配多 ~60-100 token/回合 → 两行封顶、只有 roster 成员注册、可随宪章段统一开关；③ `stateOf` 返回的是活值、不可改 → 卡片只格式化（宿主文档明令）；④ 累计 token 是全寿命折叠——被压缩掉的旧消息**仍在 totals 里**（这是对的：轮换看的就是全寿命量）。

**文档卫生（与实现同批）**：状态卡描述「七段→八段」一次编辑同改计数与段清单；README「依赖的宿主服务」表加 `sessionProjections`（晚挂、缺席降级、用途=资源读数）；CHANGELOG 未发布条目；README 工具一览同步。

## 9. 给父侧的建议与决策点

- **D-B1**：⑧ 段判读行是否按 §3 措辞落（含「该词只允许出现在判读行」的文案纪律）——**推荐准**。
- **D-B2**：提示段与 consult #26 宪章段**合并注册/合并生命周期**（一次特征探测、一套 dispose）——**推荐合并**；若批 2 未落地，本批提示段自带最小生命周期（建队时注册 + attach 清扫 roster 成员 + 代理消失 dispose）。
- **D-B3**：轮换判据落点=卡片行尾标记（不自动）——**推荐准**；`>200M` 与 `>100 轮` 用 `>`（200M 整、100 轮整不算候选）还是 `≥`，请在实现前定死并钉进 U-BG4。
- **D-B4**：预算推送是否并入 consult #26 的 digest（获批后）——**推荐并入，本批不单独做**。
- **待核（父侧实现前补一处）**：`contextPressure` 的 `pressureTokens` 只在请求采样时更新（`dsh-token-meter:487-495`）⇒ 卡片压力是「截至最近一次请求」的读数，措辞须带 `（读数 <turn>.<step>）` 时间戳，别把滞后读数说成实时值。
```

## §2 逐问裁定（**主代理写**）

**有效数 3 / 4**（`opencode-go-plan:mimo-v2.6-pro` 失败，不可诊断）。父侧对关键断言逐条复核，**含一手事件复核**（见 §2 末）。

| 来源 | 关键意见 | 处置 | 理由 / 复核 |
| --- | --- | --- | --- |
| [1] mimo | （无内容） | **失败** | digest 原文：child ended: error |
| [2] deepseek | 判读行（可证伪规则）：低于压缩阈值且 auto 开 ⇒ 输出「无收口理由」 | **采纳（D-B1）** | 与父侧「让自述可核」同向 |
| [2] | 读数落点：状态卡追加第 ⑧ 段「资源/预算」，每会话一行 | **采纳** | 复用既有有界读窗；零写入 |
| [2] | 提示段（函数型 text 读`自己`会话投影），与 #26 宪章段**合并注册/合并生命周期** | **采纳（D-B2）** | 函数型 text 已由父侧源码复核 |
| [2] | **不做**新 tick 类 / 新投递路径；预算推送并入 #26 的 digest（若批） | **采纳（D-B4）** | 预算不是事件性问题 |
| [2] | 轮换只做**标记 + 指引**，复用 `team_link_rotate successor:"auto"`，不自动轮换 | **采纳（D-B3）** | 三家一致；自动轮换违反看门狗边界 |
| [2] | 压力读数滞后（只在请求采样时更新）⇒ 措辞带 `（读数 <turn>.<step>）` | **采纳** | 与父侧「读数带时点」同族 |
| [2] | 断言清单 U-BG1…U-BG7（降级/形状/判读/轮换边界/零写入/提示段/口径） | **采纳** | 可 grep、可失败 |
| [2] | 补 `sessionStats.turns` 投影（>100 轮可直接读） | **采纳（待核投影在场）** | 父侧未复核该投影；列 §5 |
| [2] | `maxTokens=393216` 是「预算」一词的触发暗示之一 | **采纳** | 与 [3][4] 一致 |
| [3] glm | 四名 worker 全是 `contextWindow: 1000000`（部署声明值） | **采纳** | 与 [4] 独立一致；父侧亦见 `request/context` |
| [3] | 请求头零预算文本（123,687 字符检索） | **采纳** | 与 [4] 全 harness 结论一致 |
| [3] | 压缩阈值算术 `min(window×0.8, window−maxTokens−headroom) = 541,248` | **采纳** | 父侧独立读同源码行 |
| [3] | **估算器对中文系统性低估 1.5–1.9×（三行证据表）** | **采纳（父侧一手复核成立）** | 见本节末「一手复核」 |
| [3] | 撞限救援接不上：失败码是 TIMEOUT/TRANSPORT/SERVER，非 `CONTEXT_WINDOW_EXCEEDED` | **采纳（父侧复核成立）** | w2 解码会话：`CONTEXT_WINDOW_EXCEEDED` **0 次**；`llm/retry` 5 次，failure.message = `pi-ai stream idle timeout after 300000ms` ×4 + `terminated/TRANSPORT` ×1 |
| [3] | 三档处置：配置（profile 的 compaction `modelPolicies` + 声明窗口改实测值）/ 插件 / 宿主 | **采纳**：插件档并入本批；**配置档与宿主档不在本批实施**，上报用户 + 登记 | 配置在部署面（非本仓）；宿主缺陷属上游 |
| [3] | 自述「未改动仓库任何文件」 | **核实成立** | `git status` 仍只有三个未跟踪文档 |
| [4] kimi | 「无预算文本」是**全 harness 事实**，不是 worker 缺陷 ⇒ 修法对任意会话成立 | **采纳（范围修正）** | 父侧原表述收窄 |
| [4] | E1–E6 复验（含 `.dsh-usage-stats.json` 来自用户插件而非 harness） | **采纳** | 成本账非核心能力 |
| [4] | worker 是**完整根会话**，继承全量桌面提示栈（每请求 ≈7–8K token 固定成本） | **采纳** | 新发现的成本/干扰面；**提示瘦身列非目标**（另批） |
| [4] | 「1M 声明的真实后果是压缩来得太晚」 | **采纳** | 与 [3] 低估证据合起来才是真风险 |
| [4] | 阈值用**绝对刻度**（200K 提示 / 400K 轮换）而非窗口分数 | **部分采纳 → 父侧分层裁定** | 见 §3 分歧 1：撞墙判据用引擎同源公式，轮换建议线用绝对刻度 |
| [4] | 把压缩变成可调度信号（压缩前主动轮换） | **采纳** | 作为轮换标记的判据之一 |
| [4] | 团队级成本账 / worker 提示瘦身 | **待定 → 非目标** | 范围控制；登记不实施 |
| [4] | 待核：qax 网关真实窗口未验证 | **采纳为待核** | 列 §5 |
| [4] | 解码产物落在 `.dsh/death-forensics/consult-w2-session.jsonl`（仓外） | **核实存在（15.6 MB）**，父侧已用它复核 | 仓外留痕，可删 |

**一手复核（父侧，2026-10-09 11:3x）**：在 `consult-w2-session.jsonl` 内定位到 [3] 表格所引的**同一事件**（w2，10-08 15:20Z 压缩）：
`{"shadowedTokenCount":205127, "usage":{"inputTokens":606,"outputTokens":6412,"totalTokens":394218,"cacheReadTokens":387200}}`
⇒ **估算 205,127 vs 实际 cacheRead 387,200 ≈ 1.89×**，[3] 的低估claim **成立**。该事件同时证明：压缩摘要调用本身以 `maxTokens: 65536` 发出、正文走 `cacheReadTokens`。

## §3 分歧与父侧裁定（**主代理写**）

**分歧 1 —— 阈值用什么口径。** [2] 主张用与压缩引擎同源的 `thresholdTokens` 公式；[4] 主张用绝对刻度（与 1M 的市场数字解耦）。
**父侧裁定：分层，两个都在，各自标注口径**——
① **撞墙判据**用引擎同源公式（`min(window×0.8, window−maxTokens−headroom)`），因为那才是「下一步会不会被压缩/会不会撞墙」；
② **轮换建议线**用绝对刻度（用户口径 **>200M 累计 token 或 >100 轮**；[4] 另提 200K/400K 压力提示，作为可选第二线）。
不采纳「只留一种刻度」的任一版本——两者回答的是不同问题。

**分歧 2 —— 父侧原诊断「纯幻觉、零环境依据」。** [3][4] 的复核结论要求**父侧更正**：
**标签是模型编的（环境里确实零预算文本），但触发它的痛是真实的**——真实请求体已达 39 万–百万 token、网关 300s idle timeout、5 次重试失败、w2 有一次 `kind=max-tokens` 回合死亡。
⇒ 结论改写为：**「错误的解释 + 真实的痛」**。设计要做的是**把痛读数化**（并让「预算耗尽」这类解释当场可证伪），而不是宣布痛不存在。

**分歧 3 —— 自动轮换。** 三家一致：本批**不做**（看门狗只管报警；freeze 会打断全队）。**采纳**。

**分歧 4 —— 估算器低估是否成立。** [3] 单源 → **父侧一手复核成立**（同一事件里 205,127 vs 387,200）⇒ 升为**双源 + 原始事件**。

### 待用户裁定（新增决策点）

| # | 决策点 | 推荐 |
| --- | --- | --- |
| D-B1 | 判读行措辞（「预算耗尽」只允许出现在判读行且只能是「不成立」） | 准 |
| D-B2 | 提示段与 #26 宪章段合并注册 / 合并生命周期 | 合并 |
| D-B3 | 轮换=标记+指引（不自动）；阈值符号用 `>` 还是 `≥`（**实现前定死**） | `>`，标记不动作 |
| D-B4 | 预算推送并入 #26 的 digest（不单独做） | 并入 |
| D-B5 | **部署配置档**（非本仓）：给 qax 两条路由配 `compaction-basic.modelPolicies`（降 `thresholdRatio` 或加 `headroomTokens`）并核对声明窗口 | 建议立刻做 |
| D-B6 | 宿主缺陷（CJK 估算校准 / 大包 idle-timeout 识别为疑似溢出 / 真实 usage 回灌压力环） | 登记并上报，不在本仓修 |

## §4 教训（**主代理写**）

1. **我把「模型的说法无据」推成了「现象不存在」——这是同一类错误的镜像。** 上一轮我对用户下的结论是「零环境依据 ⇒ 纯幻觉」；
   本轮复核证明：**词**是模型编的，**痛**是真的（39 万–百万真实 token / 网关超时 / 回合死亡）。
   ⇒ 纪律：**「没有 X 的文本」≠「没有 X 的问题」**；否定一个自述时，必须同时问「它想终止的是什么」。
2. **会诊子会话有信息面盲区，要如实标注而非当错误**：[3] 说「新会诊未落纪要」、[4] 说「网关真实窗口未验」——都是它们看不到的面。
3. **本轮三家都遵守了「未写仓库」**（`git status` 干净，仅仓外留了一个解码文件）——与 #26 的擅自写入形成对照，说明「会诊前提示只读」有效。
4. **一手事件的取证价值**：一份仓外解码文件同时替三条独立声称（低估倍数 / 错误码族 / 压缩事件形状）做了证伪或证实——比任何自述都硬。

## §5 不可验清单（**主代理写**）

- **qax 网关的真实上下文窗口**：@[待核]`。部署声明 1,000,000，从未对网关实测；会话里的 5 次失败全是 TIMEOUT/TRANSPORT/SERVER，**不能据此断言真实窗口**（也可能只是没活到撞墙）。
- **`sessionStats.turns` 投影在本部署是否存在**：@[待核]`（[2] 声称 `dsh-session-stats` 注册了 `turns`；父侧未复核）。若不成立，轮数需从 `turnBoundary` 投影或会话日志另取。
- **提示段在 worker 会话里的实际渲染**：需**真机冒烟**（本仓夹具只能验注册参数与降级分支，验不了宿主装配）。
- **低估倍数的普适性**：@[证据薄弱]`——只有 3 个样本（且都是中文重上下文）；不要把它写成「所有中文会话都低估 1.8×」。
- **只解码了 worker-2 与协调者两个会话**：worker-1/3/4 的逐事件形状未核（[3] 做了全量扫档但方式是汇总读数）。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-10-09 | 机制落盘（§0 汇总 + §1 原始层） |
| 2026-10-09 | 主代理补写 §2–§5：逐问裁定（含**一手事件复核**：估算 205,127 vs 实际 cacheRead 387,200）· 分歧裁定（父侧更正「纯幻觉」为「错误的解释 + 真实的痛」）· 4 条教训 · 5 条不可验 |

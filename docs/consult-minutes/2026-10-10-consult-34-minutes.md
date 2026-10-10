# 会诊纪要 —— consult #34（原始层，机制落盘）

- 日期：2026-10-10
- 会诊 id：34
- 模型：deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, kimi-api:kimi-k3, opencode-go-plan:mimo-v2.6-pro
- 平台 job：consult-1
- 结果：3/4 交付（其中 3 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #34 finished — 3 of 4 replied (1 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #34 finished — 3 of 4 replied (1 failed)]
effective: 3 of 4 (1 failed · 0 without content)
权限面如实（A30-10）：**本部署无法保证只读（平台面无法收窄）**——「只读」仅为**弱证**：`toolFilter.allow` 白名单**下发**（平台不保证模型面可见）；**模型面证据**须读子会话 `request/header` 事件（本部署实测 = [run_code] 单元素 ⇒ 残余绕行口在场，子会话实为 `danger-full-access`）。
models: deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, kimi-api:kimi-k3, opencode-go-plan:mimo-v2.6-pro
job: consult-1
minutes: docs/consult-minutes/2026-10-10-consult-34-minutes.md
requiresReport: true

--- replies (raw, unjudged — verify with your own tools) ---

[1] opencode-go-plan:mimo-v2.6-pro — failed
(consultation failed: child ended: error — 子代理面不可诊断（no diagnostic, and the child session log gave no turn/end reason — 本部署无法取得该证据：子会话 id / 会话档 / 解压任一不可得）)

[2] deepseek-official:deepseek-v4-pro — ok
证据链全部闭环。写会诊报告。

---

# 会诊意见 · 提示缓存保真批独立复核

## 三句话结论

1. **四个问题的答案**：`context()` 是正确且唯一正确的落点；「不击穿缓存」假设**成立**（但要改说成「变化点移到尾部」）；order=125 破例**可接受**；`registerOne` 改一处**确实同时覆盖**协调者与 worker 会话。
2. **对用户的影响**：资源行搬家后缓存命中率应回到 ~99%（同会话无段基线），代价是会话历史**每步多出一条快照消息**——这是「每步自见」的固有成本，不是设计失误。
3. **建议**：方案通过，但设计档要改四处（见文末清单），且实施前对桌面 0.2.0-rc.1 宿主做一次 live 检查（`getContextOrder` 闭集 + `context()` 在场）。

## 证据口径（先声明，避免把 0.1.1 的结论当 0.2.0 的事实）

我读到的宿主源码来自 `C:\Users\huangchaowen\.dsh\dsh-browser\node_modules\.pnpm\...\` 检出，版本 **0.1.1-rc.1**；桌面宿主 0.2.0-rc.1 源码在 `resources\app.asar` 归档内，本会话**没有可执行脚本通道**、grep 不搜二进制，故未能独立复读 asar。但这**不影响四条结论**，原因有二：① 设计档引用的真机会话事件（快照以 `user/message` 落在 seq 11/33、文本自称 supersedes）本身就是桌面 0.2.0-rc.1 宿主行为的直接证据；② 0.2.0-rc.1 新增的 `getSectionOrder`/`SECTION_ORDERS`（诊断已实测 order 600）与 0.1.1-rc.1 里宿主自带包用**字面量 110/115/120** 注册 context 的事实完全吻合。下文的行号除特别注明外均为 0.1.1-rc.1 源码实读。

---

## ① `context()` 是正确落点——是；且是**唯一**能把动态文本移出可缓存前缀的通道

宿主系统提示服务的全部贡献通道（`dsh-system-prompt/lib/index.js` 实读）：

| 通道 | 渲染位置 | 放资源行会怎样 |
| --- | --- | --- |
| `section()`（含 persona，order 0 的 `deployment:persona`） | 系统提示（surface node 0，**前缀内**） | 变一次 ⇒ 变化点之后的**全部历史**按全价重算（现状） |
| `variable()` | 插值进 section / context 的 `{{name}}` 占位 | 用在 section 里 = 段文本照样变，**同病**；用在 context 里 = 与函数型 text 等价，多一层间接 |
| `tools()` | 工具 schema，位于前缀**更靠前**处 | 更糟，且污染每个工具描述 |
| `suppressRuntimeContext()` | **不是通道**——它把 `contexts` 整个清空（`assemble()` :276 `runtimeContextSuppressed ? [] : ...`，:288） | 只构成**风险**（见 ④） |
| `context()` | 动态运行时上下文快照 → 以 `user/message` **追加在尾部** | ✅ 变化点落在请求末尾 |

**一个设计档没说透的点**：问题原话里「section 的 order 值域」这条备选是死路，设计档 §4.2 的 C′ 只驳了「取整/降频」，没驳「把段重排到系统提示**末尾**」。就算把资源行排到系统提示最后一段，变化点仍在**全部历史之前**——失效的是几十万 token 的历史，系统提示自身的后缀救不回来（诊断里 cacheRead 钉在 37,312 已经证明前缀结构是「工具+系统提示+历史」）。**order 调不动这个账，只有搬出前缀一条路。**

另一个没进备选表的通道：`ctx.on("agent/pre-step")` 监听器（time-context 的机制，`dsh-time-context/lib/index.js:363-393`）。它也能往尾部塞消息，缓存性质与 `context()` 等价，但它**没有去重**（每步无条件发，需自带节流）且绕过了宿主的快照框架（排序、「supersedes」导语、快照替换感知）。`context()` 把这些免费拿到，是严格更优。

**旁证（有分量的）**：宿主自己就是拿 `context()` 放**每代理动态策略语句**的——sandbox:policy(110)、approval:policy(115)、subagent:delegation(120)。`dsh-subagent/lib/types/child-agent.js:96-98` 的注释原话：*"A runtime-context contribution rather than a system-prompt section, so the deployment's system prompt stays uniform across parents and children."* 宿主把「让系统提示保持逐字节不变」当作这条通道的设计意图本身。团队链接的资源行是同一类内容。

## ② 「不击穿 KV 缓存」假设——成立；但机制要说准，且设计档漏了两个新后果

**机制证据链（宿主源码实读，不再只有间接证据）**：

1. `dsh-agent-loop/lib/index.js:497-500`（`preStep`）：每步先 `systemPrompt.assemble()`，把 `contexts` 渲染成**一个合并快照**（`joinContextSections`），交给 `runtimeContext.project()`；
2. `:63-82`（投影）：**只有合并快照文本与上一条不同才返回新消息**（`:66` `if (this.retained?.text === snapshot) return;`）——所以资源行每步变 ⇒ 每步一条新快照；
3. `:554`：快照以 `user/message`、`surfaceOp: "append"` 追加在**已认领消息（真实用户消息）之后、本步执行之前**——即请求尾部倒数第二的位置。

⇒ 变化点从「系统提示 36.7% 处」移到「尾部」，失效区间从「系统提示后缀+全部历史」缩到「快照消息+当前用户消息」。**time-context 那句 "Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries"（README.md:69）与 `context()` 通道同源**：两者都是「尾部追加消息」这同一个位置性质，不是两套机制——time-context 只是另一条注册 API（pre-step 监听器）+ 自带节流。设计档 §9.1 把二者说成「机制不同、不足以证明」**低估了证据**。

**措辞必须改**：§9.1 现在写「`context()` 落点**不使 KV Cache 失效**」——技术上不准确：任何变化都会使**变化点之后**的缓存失效；本方案的收益是「变化点移到尾部 ⇒ 失效区间≈1–2 条消息」。建议把 §9.1 从「唯一未证实的假设」**升级为「已由宿主源码证实 + U8 真机复核」**（U8 保留，作为端到端判据）。

**设计档漏掉的两个新后果（这是本复核最有增量价值的部分）**：

1. **每步一条快照消息 = O(步数) 的历史增长**。合并快照包含**全部** context 段（sandbox+approval+[worker 的 delegation]+资源行），一条约 150–400 token。资源行每步变 ⇒ 快照每步变 ⇒ 会话每步**持久化**一条新 `user/message`（`surfaceOp:"append"`，老快照不删，直到压缩才被 shadow——time-context README:37 同款语义）。100 步会话 ≈ 额外 2–4 万 token 历史。这**不影响命中率**（追加进历史后就成了稳定前缀的一部分），但要写进 §9 边界。
2. **温和的自反馈**：资源行报的「累计/压力」把快照消息自身的 token 也算进去 ⇒ 读数每步被自己抬一点点。增量极小（每条快照 ≈ 窗口的 0.02%），会收敛，但要如实标注，否则 U4「逐项一致」的判读会被「为什么压力永远在涨」这类问题纠缠。

另外注意 `project()` 的去重是**整条合并快照文本**比对：资源行一变，连宿主的 policy 语句一起重发——这是通道的固有语义，与谁注册无关，写进边界即可。

## ③ order=125 破例——可接受；宿主自家先例比想象中更硬

三条实证：

1. `context()` 的校验**只有** `Number.isFinite(order)`（`dsh-system-prompt/lib/index.js:197`），125 合法；排序是 `assembly.contexts` 的纯数值 sort（:276），并列时稳定按注册序兜底，不会崩。
2. **宿主自己的包上一代就用字面量**：`dsh-sandbox-policy/lib/index.js:121` `order: 110`；`dsh-user-approval/lib/index.js:95` `order: 115`；`dsh-subagent/lib/types/child-agent.js:129` `order: 120`（注释明写 "Order 120: after the sandbox:policy (110) and approval:policy (115) sentences"）。字面量是这个 API 家族的历史惯例，不是插件发明。
3. 破例是**被逼的**：`getContextOrder` 只解析闭集、无 team-link 键 ⇒ 要么字面量、要么放弃 FR-2。设计档双处登记 + U3 钉死 `order === 125` + §9 换代复核清单，纪律齐全。

**残余风险**（可接受，建议补一句到 §4.3）：未来宿主若新增恰好占 125 的 context 键，发生并列 ⇒ 稳定排序按注册序兜底，不崩但语义位次会漂。实施前对桌面 0.2.0-rc.1 做一次 live 检查（一个 scratch 插件调 `sp.getContextOrder("SANDBOX_POLICY")` 等三键 + `typeof sp.context === "function"`），把「闭集仍只有三条、125 无人占用」从引用读数升级为当次实测。

## ④ 改一处覆盖两类会话——成立；worker 特有因素设计档漏了五条

**覆盖性证据**：worker 的 `agent.ctx` 就是子代理的 scoped ctx，宿主自己正是在这个 ctx 上注册 delegation context（`child-agent.js:129` `childCtx.systemPrompt.context({ name: 'subagent:delegation', order: 120, ... })`）⇒ 同一个 `sp` 对象对 worker 提供 `context()`；而插件现有 section 已经注册到 worker 会话（诊断 9 个会话里 7 个 worker 都带段）⇒ 注册路径本身已被真机证明可达 worker。`registerOne` 按 `plan.kind` 只差文本，`sync()` 的「同一条」判据对 context 同样适用。**一次改、双覆盖，成立。**

**漏掉的 worker 特有因素**：

1. **快照组成不同**：worker 的合并快照额外含 delegation 句（order 120）。资源行每步变 ⇒ 整条合并快照（含 delegation）每步重发——worker 侧每步新增历史比协调者略大。属 ② 的同一后果，但设计档 §7.2「没有第三处落点」旁边应点名这条。
2. **U8 必须显式覆盖 worker**：诊断里 worker 带段命中率（0.5%）比协调者（7.6%）**更差**——修后判据若只量协调者会话，会漏掉最受伤的一类。建议 U8 拆两行：协调者 ≥95% **且** worker ≥95%。
3. **`suppressRuntimeContext` 的静默失效面**：若某 agent 的 persona 配置 `includeRuntimeContext: false`（`dsh-persona/lib/index.js:41` 会调 `suppressRuntimeContext()`），注册**照常成功**、装配时 `contexts` 被整个清空——资源行**无声消失，且 FR-3 的面探测抓不到**（API 上无法查询抑制状态）。概率低（默认 true），但要作为已知静默失效模式写进 §9：届时资源行退到 digest 脚注+状态卡第 ⑧ 段，功能收窄但不撒谎。
4. **lineage seed**：worker 会话可从父会话 fork 种子历史（`childSessionMeta` 的 `seedLength`），快照仍追加在子会话尾部，无特殊处理——§9 边界补一句「种子历史不受影响」即可。
5. **可达性缺口对两类同权**：重启/新 spawn 的 worker 没被 sync 到 ⇒ 没有 context ⇒ **安全方向**（不击穿缓存），与现状一致（NF-1）。不回归，但 FR-6 文档里别把 worker 写成「必在场」。

## 设计档建议修改清单

```dsh-ui
{"title":"设计档需改四处（实施前）","gap":12,"items":[{"type":"table","columns":["位置","改什么","理由"],"rows":[["§4.2 C′","补一条被否决项：把资源行**重排到系统提示末尾**也不行——变化点仍在全部历史之前，order 救不了","问题① 的「order 值域」备选要显式关闭"],["§9.1","从「唯一未证实的假设」升级为「宿主源码已证实（0.1.1-rc.1 同构 + 真机会话事件佐证）」；措辞改为「变化点移到尾部 ⇒ 失效区间≈快照+当前用户消息」","证据强度被低估；「不使 KV Cache 失效」技术上不准确"],["§9 边界","补两条新后果：每步一条持久化快照消息（O(步数) 历史增长，压缩时被 shadow）+ 压力读数对快照自身的温和自反馈","② 的核心增量；诚实登记「每步自见」的固有成本"],["§9 边界 + §4.3","补 suppressRuntimeContext 静默失效模式；order=125 加一条「实施前对 0.2.0-rc.1 做 live 检查（三键 getContextOrder + context() 在场）」","③④ 的残余风险显式化"]]},{"type":"callout","tone":"success","title":"总评","content":"方案方向正确、落点正确、破例可接受、双类会话覆盖成立。**通过，附条件**：实施前完成上述 live 检查，U8 拆出 worker 行，设计档按清单改四处。U8 若红，退回 digest-only 的退路仍然成立且已经过本次复核。"}]}
```

## 逐题结论（供裁定入账）

- **① 落点**：`context()` 正确且唯一。section/persona/variables/tools 全部落在前缀内，order 调不动历史失效；suppressRuntimeContext 是清空开关不是通道；pre-step 监听器是等价但更差的手搓版。宿主自家三个 policy context 就是这条通道的官方用法。
- **② 假设**：**成立**，证据已从「间接」升级为「宿主源码实读 + 真机会话事件」：快照只在文本变化时以 `user/message` 追加在请求尾部 ⇒ 失效区间≈1–2 条消息。措辞要改成位置性质，两个新后果（每步快照增长、自反馈）须入 §9。
- **③ order=125**：**可接受**。校验只有 `Number.isFinite`；宿主上一代自家包就用字面量 110/115/120；破例是闭集解析逼出来的，登记与判据齐全。残余风险：未来撞键 + 实施前 live 检查。
- **④ 双类覆盖**：**成立**。worker 的 `agent.ctx.systemPrompt` 与宿主注册 `subagent:delegation` 是同一个 scoped 服务，插件现有 section 已真机到达 worker。设计漏了五条 worker 特有因素（快照含 delegation、U8 必须含 worker 行、suppressRuntimeContext 静默面、lineage seed、可达性同权）。

**遗留限制**：桌面 0.2.0-rc.1 的 asar 我无脚本通道可解（grep 不搜二进制、无 exec），`getContextOrder` 闭集与 `context()` 在 0.2.0-rc.1 的在场性依赖设计档既有读数 + 本次跨版本比对，已列为实施前 live 检查项。

[3] zai-coding-cn:glm-5.3 — ok
所有证据已收集完毕。撰写会诊意见。

---

# 会诊意见 · dsh-team-link 提示缓存保真批（四问独立评审）

**三句话结论**：①`context()` 是正确且唯一正确的落点，宿主没有任何其它通道能承载"每步变化还想让模型看见"的文本；②「不击穿 KV 缓存」这个假设**成立，且现在有直接证据**（不再是 time-context 的间接推证）——但设计漏算了一个二阶代价：**每次读数变化会在会话历史里追加一条完整快照消息**，资源行每步都变 ⇒ 每个请求都追加，长会话历史线性膨胀；③order=125 不是破例，是宿主**成文契约的规定用法**（"External contributions may use any finite order"）；④一条 `registerOne` 确实同修两类会话，但设计漏了三个 worker 侧因素（抑制器静默吞贡献、worker 恰是追加膨胀的最大受害者、验收指针 US-C7→U9 悬空且缺 worker 形夹具）。

以下全部读数来自本机实读：宿主侧 = `D:\DSH-Desktop-Official\resources\app.asar`（行号以 `asar@L` 记，包源码以明文存于 asar 内，可 grep 复核）；插件侧 = 本仓 `lib/index.js`。

---

## ① `context()` 是正确落点吗？—— 是，且其它候选逐一排除

宿主给动态模型可见文本的通道一共就这些，逐一判定：

| 通道 | 实读证据 | 判定 |
| --- | --- | --- |
| `section()`（无论 order 取多少） | asar@L285318：「A prompt change that **replaces a system node in place** makes the request differ from that node's first token — in full when the node is node 0 — so the provider prefix cache **misses from there**」 | ✗ 任何 order 值都救不了：就算挂到最高 order（persona-suffix 10200），系统提示仍然**整体在全部历史之前**，一行变 ⇒ 全部历史重读。实测 glm 侧 miss 正是这个形状 |
| `variable()` | `PromptSection.interpolate`（asar@L1019798）——变量是**插值进 section 文本**的 | ✗ 落点还是系统提示，同上 |
| persona（`dsh-persona`） | asar@L890220：persona 就是 order 0 / 10200 的 **section** | ✗ 同上；且 persona 是身份件不是遥测件，全局挂还会与提示注册表撞车失败（asar@L890132） |
| `suppressRuntimeContext()` | asar@L1000827：它是**抑制器**，不是贡献通道 | ✗ 不是落点，反而是本设计的风险项（见④） |
| `followup()/steer()/inject()` | asar@L293357：`inject()` 追加模型可见上下文、不唤醒驱动 | △ 唯一形近的备选，但无去重、无 supersede 框架、无节流，全要自管——设计 B′ 的否决理由成立 |
| **`context()`** | asar@L1001467：assemble 把 contexts 独立于系统提示排序产出；asar@L286521-286522：agent loop 每请求把它渲染成快照并交给 `RuntimeContextProjection.project()` | ✓ 宿主自家的 sandbox/approval/subagent 三条动态事实全走这里（asar@L907468 / L988224 / L1055011），是宿主为"会变的事实"修的官道 |

结论：**设计 §4.1 的选择成立**。补一个设计没写的好处：这条通道是 provider 无关的（不依赖 catalog 里 `systemPromptUpdate: 'in-history'` 这种路由能力），对 glm 与 deepseek 一致正确。

## ② 「context() 不击穿 KV 缓存」成立吗？—— 成立，且可把 §9.1 从"待测假设"升级为"已证机制"

这次我把宿主的完整机制链读出来了，四步，全部带行号：

1. **assemble 分离产出**（`@deepseek-ai/dsh-system-prompt`，asar@L1001467-1001469）：contexts 按 `order` 升序排序、各自调 `text(context)`，与系统提示文本分开返回；`runtimeContextSuppressors` 非空则整列为空。
2. **每请求渲染快照**（`dsh-agent-loop`，asar@L286521-286522）：`renderContextSections(assembly)` → `joinContextSections(...)` → `this.runtimeContext.project(text, sections)`。
3. **内容去重 + 追加提交**（`RuntimeContextProjection`，asar@L285946-285949）：`if (this.retained?.text === snapshot) return;` —— **文本没变 ⇒ 什么都不做**；变了 ⇒ 以 `surfaceOp: "append"` 提交一条 owned `user/message`（asar@L285881/285892）。重启后从日志回放恢复 `retained`（asar@L285921-285933），compaction 替换会清掉被遮蔽的旧快照（asar@L285937）。
4. **宿主对缓存的成文承诺**（asar@L966790，dsh-session 包）：「**Appended surface entries preserve reusable prefixes.** A `replace` operation invalidates reuse from the first shadowed message」——快照永远走 append，从不走 replace；审批策略包的文档同样写明「Unchanged requests retain the earlier snapshot without adding another message」（asar@L1054708）。

另外两条独立佐证：(a) 9 会话实测里，宿主自己的 time-context 快照（seq 11/33 的 user/message）在场的基线区间命中率 96–99% —— 追加消息本身不断缓存，这是真机数据；(b) 本次会诊会话自身就在跑这条机制：我的上下文里 turn 1 step 1 与 step 32 各有一条快照，间隔 10m28s，正是 time-context 的 10 分钟节流。

**所以：②的答案是把 §9.1 的假设判定为成立，U8 保留为部署层验收（机制对 ≠ 部署对），但"间接证据"的措辞可以换成上面这条直接链。**

### ⚠ 但设计漏了一个二阶代价：快照是**每请求按内容去重**的，而资源行每个请求都在变

`project()` 的去重是**整条快照文本**比对（所有 context 贡献拼接后的全文，asar@L285948-285949），不是分贡献去重。宿主自家三条事实几乎不变、time-context 10 分钟一变，所以宿主设计里快照是**稀有事件**；资源行每步变（压力/累计随每个请求前进）⇒ **每个请求都追加一条新快照**，而且每条都是全文快照——头部套语 + sandbox/approval 常量文本 + 资源行，估 ~150–250 token，其中资源行自己只占 ~50。

量化（用实测会话）：pulse·worker-1 带段区间 246 个请求 ⇒ ~246 条追加 ≈ 4–6 万 token 永久进入历史；这些旧快照随后每个请求按 cache-read 价重读。相比现状（3.6 亿 token 全价）仍是 ~100 倍改善，**U8（≥95%）大概率仍绿**——但它与 US-C2 的字面要求其实不对齐：需求写的是"每**回合**看得见"（requirements §US-C2），不是"每步"。两个可选处理：

- **A（推荐，改动小）**：照设计发货（每步渲染、无插件侧缓存），但在 §9 增补"历史增长预算"一行 + U8 加一条辅助读数（数每会话 owned 快照条数 / 请求比）；若实测 >1 条/3 请求，另立小批加"回合门"。
- **B（更贴 US-C2 字面）**：渲染体里按 `sessionStats.turns` 门控——同一回合内返回上一条字符串，回合号前进才现算新行。代价：违背设计 §6.2 自设的"纯读：不写、不缓存"，需要把那条约束改写（它本是为 section 热路径写的）；闭包状态在重注册时自然复位。

无论 A/B，NF-5（否决"取整降频仍留系统提示"）都不受影响——那是给"留在前缀里"的方案写的，这里文本已在追加通道，节流只影响历史膨胀不影响缓存正确性。

### 另一个必须修的实现细节：`assembly?.agent` 不存在

设计 §6.2 写 `text: (assembly) => renderResourceContext(ctx, assembly?.agent ?? agent, ...)`。宿主类型（asar@L1018298）：`interface AssembleContext { scope?: ScopeKey; signal?: AbortSignal; }` —— **没有 `agent` 字段**，`assembly?.agent` 恒为 undefined（现行 section 代码 lib/index.js:3578 同病，靠 `?? agent` 兜底才一直没炸）。不算红，但伪代码应改为直接闭包捕获注册时的 `agent`（现行代码实际就是这么工作的），免得后人以为那条通路真的会被走到。

## ③ order 用字面 125 —— 可接受，且这根本不是破例

宿主文档（asar@L1000801，dsh-system-prompt README）原文：**"Repository-owned contributors resolve centrally allocated positions through `ctx.systemPrompt.getSectionOrder(name)`; runtime-context contributors use `getContextOrder(name)`. External contributions may use any finite order."** —— 闭集 `CONTEXT_ORDERS`（110/115/120，asar@L1001163-1001166）是给**仓库自有贡献方**用的；team-link 是外部插件，**任意有限 order 就是宿主契约的规定用法**。校验确实只有 `Number.isFinite(order)`（asar@L1001386，与设计 §4.3 引的 @58975105 一致）。

两个小改进：

1. **措辞与注释**：把 §4.3 的"经申报的例外"改成"宿主契约的规定用法"，并同步改 lib/index.js:3091-3093 那条"order 一律取 getSectionOrder(...)，不用裸常量"的**注释原文**——现在这条注释与代码现实矛盾（文档卫生第 5 条：描述面与实现一致）。
2. **取值**：125 可用；若想给宿主未来的 context 键留位，130/150 更稳（contexts 的排序在 asar@L1001467 只有 `a.order - b.order`，等值时按注册序稳定排，没有 section 那套按名次序的兜底——撞值无害但没必要撞）。这是化妆级建议，不阻塞。

## ④ 一条 registerOne 同修两类会话 —— 机制上成立，但有三个 worker 侧因素被漏掉

**成立的部分**（实读）：`planSections` 把协调者与 worker 排进同一张 `wanted` 表（lib/index.js:3522-3542，kind 只差字段），`registerOne` 是唯一漏斗（lib/index.js:3558-3586），`renderRoleAndResources` 只在文本上按 `plan.kind` 分叉（lib/index.js:3200-3203）。FR-1/FR-2 的拆分保住这个形状：`renderRoleText` 保留 kind 分叉、context 注册 kind 无关 ⇒ **改一处，两类会话同时拿到"恒定段 + 追加资源行"**。

**漏掉的三个因素**：

1. **抑制器会静默吞掉贡献（对 worker 尤其相关）**：任何 persona/preset 行设 `includeRuntimeContext: false` 会调 `suppressRuntimeContext()`（asar@L890423），把该 agent 作用域的**全部** context 贡献移除（asar@L1000827），team-link 的 `resources=true` 照样注册但**永远不可见**——不抛错、不留痕。设计 §9 边界表没有这一行。建议补进 §9（fail-visible 的哲学下至少要文档化），并指出 digest 脚注 + 状态卡第 ⑧ 段这两处出口不受抑制器影响，天然是兜底。
2. **worker 恰是②中追加膨胀的最大受害者**：worker 干的是多步实施轮（几十步一轮），每步一条快照；实测里最重的正是 worker（pulse·worker-1 246 请求 / 0.5% 命中）。US-C7 的立意是"把 worker 一起修好"，若发货后 worker 会话历史膨胀显著，最先抱怨的也是 worker。②的 A/B 处置对 worker 收益最大。
3. **验收面有一个悬空指针 + 缺 worker 形夹具**：需求档 US-C7 写"验收指向 **U9**"，但设计档 §8 只定义到 U8——**U9 不存在**。本仓 U 编号是按批复用的（host-half.test.mjs 里至少四个批次各有自己的 U9），所以批 C 加一个 U9 不冲突，但必须**定义它**，比如：「kind=worker 的计划同时注册两个面；worker 义务行跨步逐字节恒定；worker 会话的 context 记录里含资源行」。现有 U1/U3 的红相构造若只造了 coordinator 形，FR-5 的桩改造要顺手补 worker 形断言——否则"同修两类"只是代码路径上的推定，没有机械判据钉住。

**顺带一提（不阻塞）**：设计 §2.3 那个"未解释项"（deepseek-flash 上代价小得多）现在有了有据假设——DeepSeek 官方适配器文档（asar@L856170）写明 catalog 声明 `systemPromptUpdate: 'in-history'` 的路由上，系统提示变化会**追加在缓存历史之后**而非原地替换 node 0。查一眼该 catalog 条目即可把 §2.3 从"未解释"升为"已解释"，也算给本批论点（提示变化的位置是 provider 路由属性）再钉一颗钉子。

---

## 建议的设计档修订清单（最小集）

| # | 改什么 | 去哪改 |
| --- | --- | --- |
| 1 | §9.1 假设改判"成立"，换上②的直接证据链（L285946-285949 / L285881 / L966790 / L1054708）；U8 保留为部署验收 | design §9.1、§8 U8 |
| 2 | §9 新增"快照追加节奏与历史增长"边界 + ②的 A/B 处置（推荐 A + U8 辅助读数：快照条数/请求比） | design §9、§8 |
| 3 | §6.2 删 `assembly?.agent`（AssembleContext 无此字段，asar@L1018298），改为闭包捕获 | design §6.2；实施时同改现行 3578 的注释 |
| 4 | §4.3 从"破例"改为"宿主契约规定用法"（asar@L1000801），order 可留 125 或取 130；同步修 lib/index.js:3091-3093 的注释原文 | design §4.3、lib/index.js |
| 5 | §9 边界表加一行：`includeRuntimeContext:false` 抑制器会静默移除 context 贡献；两处兜底出口不受影响 | design §9 |
| 6 | 定义批 C 的 U9（worker 形两面包夹具断言），消掉需求档 US-C7→U9 悬空指针 | design §8、requirements §US-C7 |
| 7 | （可选）查 deepseek-flash catalog 的 `systemPromptUpdate`，把 §2.3 未解释项闭环 | design §2.3 |

以上 1–6 都是文档与判据层修订，不动方案的选型：**落点选 `context()` 本身，四问全部支持。**

[4] kimi-api:kimi-k3 — ok
证据齐了。以下是本次会诊的独立意见。

---

# 会诊意见：提示缓存保真批（批 C）设计四问

> 取证说明（如实）：本会话**无代码执行能力**，宿主 asar 未挂载为目录，故宿主源码级声称（`CONTEXT_ORDERS` 闭集、`Number.isFinite` 校验、「两条 loop-owned surface message」措辞）采自设计档与 consult-28 纪要中**已实读登记**的读数，我不重复断言。**但决定性机制证据全部是我本次直接从会话日志明文读得的一手证据**：`C:\Users\huangchaowen\.dsh\death-forensics\consult-w2-session.jsonl`（worker-2 / c1672114 的 13.8MB 明文，consult-28 留存，主会话可直接复核）。插件代码（`lib/index.js`、`host-half.test.mjs`）为我逐行实读。

## 一句话结论

**四问全部通过，且第 ② 问比设计档自己的估计更强**：`context()` 落点「不击穿 KV 缓存」不是只有间接证据——worker-2 的会话日志里 **1575 处 surfaceOp 全部是 `append`、零例外**，宿主自己的 time-context 以 ~10 分钟节奏往尾部追加新消息、同会话缓存命中 92%–99.8%，这就是同一机制族在两个 provider 上的**直接实证**。设计档 §9.1 的「唯一未证实的假设」可以**升格为「已证」**，U8 降级为廉价保险。

---

## ① `context()` 是正确落点吗？—— 是，且是**唯一合格**的落点

先把排除法做绝（用户点名的几个候选逐个过）：

| 候选 | 判定 | 理由 |
| --- | --- | --- |
| **section 调大 order 值** | ❌ 机制上不可能奏效 | 定量：系统提示 29,383 字符、断裂点在 36.7%；但系统提示**之后**还有整段消息历史（d7ca53f8 在 seq 1523 的 prompt 是 361,668 token）。把段移到系统提示最末尾，省下的只是系统提示尾部 ~18.6K 字符，**其后几十万 token 历史照样每步全价重算**。系统提示面内的任何 order 都治不了 |
| **persona**（部署前/后缀段） | ❌ | 同为 section 族、同一张系统提示 surface，同上 |
| **variables** | ❌（未逐字实读其插值时机，如实标注） | 与 section/context 并列为 systemPrompt 面的第三种注册（consult-28 E2：全 harness 50 处注册含三者），按命名与分层属**系统提示模板**面 —— 只要解析进系统提示，同上。**该不确定性不影响结论**：它若不在系统提示面，宿主就没理由把它注册在 `systemPrompt` 命名空间下 |
| **suppressRuntimeContext** | 不是通道，是**抑制开关**（本仓 0 命中；宿主面未实读，如实标注） | 即使存在，语义也是「不投快照」，不是贡献入口。它真正的意义是 ④ 的**风险项**（见下），且已被实测排除：worker-2 实收 4 份快照 |
| **time-context 式 pre-step listener 自建** | ❌ 重复造轮子 | `context()` 就是往那张快照里贡献内容的**正式 API**，自带排序与去重；另起 listener 是把宿主已提供的机制重写一遍 |
| digest 脚注 / followup 注入 / 删段 | ❌ | 设计档 §4.2 的 A′/B′/D′ 否决理由我逐条复核，**全部成立**（digest 的 10min 去抖确实会把「每步自见」退化成「可能永远不见」） |

**结论**：`context()` 是唯一同时满足「插件可达 + 尾部追加 + 每次装配重算 + 宿主负责排序去重」的通道。选定正确。

## ② 「不击穿 KV 缓存」假设成立吗？—— **成立，证据可升级为直接证据**

设计档 §9.1 说自己只有间接证据。**我这次从 worker-2 明文日志里拿到了直接证据**，四条：

1. **追加语义是字面字段，不是推断**：4 份 runtime-context 快照（seq 11 / 104 / 1539 / 2835）的 `user/message` 事件**全部带 `"surfaceOp":"append"`**；全日志 **1575 处 surfaceOp 无一处 replace/remove/update/patch**。「supersedes earlier snapshots ⇒ 早先快照仍在」这一推断也被直接证实：4 份旧快照**全部留在日志里**，无任何移除事件。
2. **同机制族的每步级动态尾部消息与高命中共存**：37 条 time-context 消息以 ~10 分钟节奏（turn 18 的 step 26/71/123/155/205）追加进尾部；紧随其后的请求命中 **95.3%（step 3：58,799/56,064）、92.6%（step 4）、99.8%/99.8%（turn 6 step 18/19：313,343/312,704）**。**这就是「每步往尾部塞一条变化文本不击穿缓存」的实测定理**，且在 glm-5.3 侧同样成立——结论.md 里所有无段基线（96%–99%）本来就带着这些 time-context 追加。
3. **快照发射节奏 = 内容变化 / 压缩后重发，非每装配必发**：4 份快照内容只变过一次（seq 11→104 文件策略变化）；seq 1539 与 2835 内容与前一份**逐字相同**却重发——时间点精确对齐 consult-26 记录的 worker-2 **两次全量压缩**（turn 14：seq 1539 紧接 turn 14 起点 seq 1532；turn 18：seq 2835 ∈ 该回合）。⇒ 压缩把历史里的旧快照摘要掉之后，**宿主会自发把当前快照重发到尾部**。这条对 ④ 的 worker 压缩因子是决定性的好消息。
4. **我此刻自己的会话就是活样本**：我是 delegated subagent，我的上下文顶部就带着同一格式快照（含 file policy / approval / subagent-scope 三段）⇒ 连委派会话都有这条通道，worker（根会话）更不可能缺。

**残余必须如实登记的未知（设计档目前漏记的一笔账）**：资源行**每步都变** ⇒ 快照按「变即重发」语义会**每步往历史里追加一条** ~60–80 token 的消息。500 步 ≈ 3–4 万 token ≈ 1M 窗口的 3–4%。这些消息一旦追加即静态、**全部可缓存**（不花全价），且会被压缩折掉——代价是**历史膨胀**，不是缓存击穿。量上与 time-context 同族（宿主自己已经在付这笔钱的 ~1/3 版）。**建议在设计档 §9 补这一行账**，否则评审会以「设计对成本沉默」打回。

⇒ 退路（digest-only）几乎用不上；但设计「不把任何东西塞回系统提示」的退路纪律**完全正确**，保留。

## ③ order 字面 125 的破例 —— **可接受**

- 破例的**必要性**成立：`getContextOrder()` 只解析三键闭集，无键可用时字面常量是唯一出路；校验仅 `Number.isFinite`，125 合法。
- **语义**合适：排在宿主三条（110/115/120）之后，读数居快照末尾。
- **碰撞后果至多良性**：若宿主日后新增内置 context 恰好取 125（110/115/120 的下一个自然数**正是 125**，这概率不低），平局只影响两条独立上下文行的**相对顺序**，两者照常渲染——无功能损害。
- 两个**可选**打磨（非通过条件）：① 写成 `sp.getContextOrder?.("TEAM_RESOURCES") ?? 125`，把「宿主日后开放官方键则自动收养」的意图写进代码而非仅写进文档——但宿主几乎不会为第三方插件内置键，这只是表态；② U3 钉死 `order === 125` 作为常量跟踪（本仓惯例），宿主改排序时红得明明白白。
- 纪律项已满足：设计档 §4.3/§7.2 双处点名「本仓唯一一处裸 order 常量」。**通过。**

## ④ 改一处真能同时覆盖两类会话吗？—— 真覆盖；worker 特有因素三条，全部有解

**覆盖性（直接证据链）**：

- `planSections`（lib/index.js:3522-3542）对 coordinator 与全部角色现任**同表产计划**；`registerOne`（:3558-3586）按 `sessionId` 无差别注册；`renderRoleAndResources`（:3194-3214）**仅在文本上分叉**（宪章 vs 义务行），资源行两类都挂。
- **最硬的反向证明**：worker 会话的缓存**本来就是被这条路径打穿的**（worker-1 带段 145 请求命中 0.5%）——段能经 `registerOne` 到达 worker，改后的 `context()` 走同一个函数，必然同样到达。
- **通道在两类会话都在场**：worker-2 实收 4 份快照；协调者 d7ca53f8 也有快照（seq 11/33，结论.md 已录）。

**worker 特有因素盘点（设计漏掉/需补强的）**：

| # | 因素 | 判定 |
| --- | --- | --- |
| 1 | **worker 压缩更频繁**（长会话；w2 压了 2 次） | ✅ **通道自愈，实测**：宿主在两次全量压缩后都自发重发了快照（②-3）。team-link 的贡献作为已注册 context 会随重发一并装配。建议加一条**真机判据**：一次全量压缩**之后**的快照，`source.sections` 数组里仍可 grep 到 `team-link:resources`（快照的 sections 数组带名字，机械可证——我上面就是这么 grep 的） |
| 2 | **suppressRuntimeContext 类抑制**（用户点名） | ✅ 本部署实测未抑制（worker 4 份快照为证）；但仍值得一条**双会话日志断言**把「将来宿主默认变了」变成红测试，而不是 silently 丢功能 |
| 3 | **历史膨胀对 worker 更重**（会话更长、步数更多） | 有界且可缓存（②的账），但 U8 应钉**双读数**：至少一名 coordinator **和**一名 worker 各自的改后命中率 ≥95% —— 现设计 U8 只写「同型团队会话（glm-5.3）」，按用户「两类同修」的明确裁定应写明两类各一 |
| 4 | 换届/轮换（worker 专属生命周期事件） | ✅ 既有覆盖：轮换 = 旧会话消失 + 新会话出现，走同一 sync 的 dispose（U4/U7）+ 注册 |
| 5 | 重启后既有 worker 的段重建 | ✅ attach 钩子②重建，且注册是进程内的——**老版本挂的旧段随进程消失，零迁移**，升级无残留 |

**夹具可行性**（FR-5）：`makeSystemPrompt`（host-half.test.mjs:180-203）扩展点干净。按 AGENTS.md §四「桩必须镜像宿主调用面」的规矩，桩应补上 `context()` 记录器 **和** `getContextOrder()`（即使插件不调用后者——桩镜像的是宿主面，不是自家调用面，这正是本仓踩过的那个坑的原文要求）。

---

## 给设计档的修订清单（按严重度）

| # | 级别 | 修订 |
| --- | --- | --- |
| 1 | 🟡 | **§9.1 假设升格为「已证」**：补坐标 —— `consult-w2-session.jsonl` seq 11/104/1539/2835 全 `surfaceOp:"append"`；全日志 1575 处 surfaceOp 零非追加；time-context 37 条 ~10min 追加与 92–99.8% 命中共存；U8 保留为保险而非判据 |
| 2 | 🟡 | **§9 补历史膨胀账**：每步一条尾部快照 ≈60–80 tok/步，500 步 ≈3–4 万 tok（1M 窗 3–4%），静态可缓存、压缩可折；与 time-context 同族 |
| 3 | 🟡 | **U8 钉双读数**：coordinator + worker 各一；另加两条机械日志断言（两类会话快照含 `team-link:resources`；一次全量压缩后仍在） |
| 4 | 🔵 | §4.1 表格「落点（实测）」列证据强度升级为「实测落点 + `surfaceOp:"append"` 字面字段」 |
| 5 | 🔵 | ③ 可选写成 `getContextOrder?.("TEAM_RESOURCES") ?? 125`；FR-5 的桩补 `getContextOrder()`（镜像纪律） |

无 🔴。四问的裁定：**① 落点正确且唯一；② 假设成立（证据比设计档自评更强）；③ 破例可接受；④ 一处同修覆盖两类，worker 特有的压缩/抑制/膨胀三因子全部有实测解或可机械验证的判据。设计可进实施计划，按上表 5 处修订后我无异议。**
```

## §2 逐问裁定（**主代理写**）

**有效回复 3 条**（mimo-v2.6-pro 失败、无内容 ⇒ 见 §5）。逐条处置：**每条恰一个处置**。

### 2.1 四问的收敛结论（三方一致，无分歧）

| 问 | 三方结论 | 处置 |
| --- | --- | --- |
| ① `context()` 是不是正确落点 | **是，且唯一**（其余通道逐一排除） | **采纳** |
| ② 「不击穿 KV 缓存」假设成不成立 | **成立**，且证据强度**高于设计档自评** | **采纳**（§9.1 升格为「已证机制」） |
| ③ order 字面 125 破例可接受吗 | **可接受**；glm-5.3 进一步指出**这根本不是破例** | **采纳**（并改值 130，见 §3） |
| ④ 改一处能否同修两类会话 | **能**；但设计各漏了 worker 侧因素 | **采纳**（U8 拆双读数 + U9 补钉） |

### 2.2 逐条意见与处置

| # | 来源 | 意见 | 处置 | 理由 / 落地 |
| --- | --- | --- | --- | --- |
| D1 | deepseek-v4-pro | §4.2 要显式关闭「把资源行**重排到系统提示末尾**」这条备选：order 调不动这个账（失效的是系统提示**之后**的全部历史） | **采纳** | 三方都独立指出；已补进 §4.2 新备选 E′ |
| D2 | deepseek-v4-pro | §9.1 措辞不准：不是「不使 KV Cache 失效」，而是「**变化点移到尾部** ⇒ 失效区间≈快照+当前用户消息」 | **采纳** | 技术上正确；已重写 §9.1 |
| D3 | deepseek-v4-pro / glm-5.3 / kimi-k3 | **设计漏了二阶代价**：快照按「整条文本变即追加」去重，资源行每步变 ⇒ **每步往历史追加一条持久化快照消息**（O(步数) 增长） | **采纳** | §9 新增「快照追加节奏与历史增长」边界行 + U8 辅助读数 |
| D4 | deepseek-v4-pro | **温和自反馈**：资源行报的累计/压力把快照自身也计入 | **采纳** | 同上，§9 如实标注（每条 ≈ 窗口 0.02%，收敛） |
| D5 | glm-5.3 | **`assembly?.agent` 不存在**：宿主 `AssembleContext = { scope?, signal? }`，该字段恒 undefined（现行 `lib/index.js:3578` 同病，靠 `?? agent` 兜底） | **采纳** | §6.2 改为闭包捕获注册时的 agent；实施时同改 3578 的注释 |
| D6 | glm-5.3 | **`getContextOrder` 闭集是给「仓库自有贡献方」的**；宿主 README 原文「External contributions may use any finite order」⇒ 字面 order 是**规定用法**不是破例 | **采纳** | §4.3 整节重写；并同改 `lib/index.js:3091-3093` 那条与实现矛盾的注释（文档卫生第 5 条） |
| D7 | glm-5.3 | 取值 125 易与宿主未来 110/115/120 的下一个自然数撞位，建议 130/150 | **采纳** | 改 `RESOURCE_CONTEXT_ORDER = 130`；U3 钉 130 |
| D8 | glm-5.3 / kimi-k3 / deepseek-v4-pro | **`suppressRuntimeContext()` 静默失效面**：persona 设 `includeRuntimeContext:false` ⇒ 注册成功但贡献被整列清空、不抛不留痕；FR-3 的面探测抓不到 | **采纳** | §9 新增一行边界；并写明两处兜底出口（digest 脚注 + 状态卡第 ⑧ 段）不受抑制器影响 |
| D9 | glm-5.3 | 需求档 US-C7 → U9 **悬空**（设计档当时只定义到 U8） | **采纳（已独立修复）** | 该悬空在会诊派出后、settle 前已由我补上 U9；本纪要确认其定义在场 |
| D10 | deepseek-v4-pro | §2.3「未解释项」（deepseek-flash 代价小得多）可用 catalog 的 `systemPromptUpdate` 闭环 | **采纳并已闭环** | 见 §3 末条：宿主文档原文 + 本会话 `request/context` 实测双证 |
| K1 | kimi-k3 | §9.1 可直接升级：worker-2 日志 **1575 处 `surfaceOp` 全为 `append`、零非追加**；4 份快照全留存；37 条 time-context 追加与 92–99.8% 命中共存 | **采纳** | 这是一手真机证据，比宿主源码引用更硬；已写入 §9.1 |
| K2 | kimi-k3 | 快照追加 ≈60–80 tok/步（500 步 ≈3–4 万 tok） | **采纳** | 与 D3 合并；区间按三方估算如实标注（60–400，取值待实测） |
| K3 | kimi-k3 | FR-5 的桩**必须同时补 `getContextOrder()`**——桩镜像的是宿主面而不是自家调用面（AGENTS.md §四原文要求） | **采纳** | 这条最容易被漏，且正是本仓踩过的坑；已写进 FR-5 |
| K4 | kimi-k3 | ③ 可选写成 `getContextOrder?.("TEAM_RESOURCES") ?? 125` | **不采纳** | 宿主闭集里没有也不会有第三方键（glm-5.3 同判），这个写法会造出一条「看着官方、实际永不解析」的路径，比裸常量更误导；改为**具名常量 + 注释引宿主契约原文**，语义更清楚（kimi 本人也标为「表态、非通过条件」） |
| K5 | kimi-k3 | worker 压缩更频繁，但宿主**压缩后会自动重发快照**（自愈，实测两次对齐全量压缩） | **采纳** | 为 worker 长会话提供良性证据；加一条机械真机判据：一次全量压缩后的快照 `sections` 里仍可 grep 到 `team-link:resources` |
| G-opt | glm-5.3 / kimi-k3 | 实施前对桌面 0.2.0-rc.1 宿主做 live 检查（`context()` 在场 + 闭集仍三条） | **采纳（部分已做）** | 我此前对**桌面宿主本体** `resources\app.asar` 的实读已给出 `context(context){…}`（含 `Number.isFinite(order)` 校验）与 `CONTEXT_ORDERS = {110,115,120}`；**运行时 real call** 未做，列入 §5 不可验清单 |
| B-opt | glm-5.3 | 二阶代价的两种处置：**A**＝照设计发货 + 记账 + 辅助读数；**B**＝按 `sessionStats.turns` 门控成「每回合一行」 | **A 采纳；B 未采纳（用户 2026-10-10 裁定 A）** | 三方一致倾向 A；B 更贴 US-C2 字面但需放松 §6.2「不缓存」约束，且会让回合内读数变陈（长回合内压力增长恰是最需要看见的时刻）。**用户原话：「A。然后走工程模式，评审->实施」**；B 作未采纳项记录在设计档 §9.2，日后启用走「另立小批 + 设计档更新」正规路径 |

---

## §3 分歧与父侧裁定（**主代理写**）

**会诊内部无分歧**：三条有效回复对四问的判断完全一致，仅在「二阶代价的处置」上给出 A/B 两个选项（非对立）。

**父侧（本轮主代理）裁定**：

| 裁定 | 内容 | 依据 |
| --- | --- | --- |
| R-1 | 落点选 `systemPrompt.context()`，**四问全部照会诊结论执行** | 三方一致 + 宿主文档原文 |
| R-2 | `order` 取 **130**（非 125） | 避开 110/115/120 的下一个自然数；避开撞位是零成本 |
| R-3 | §4.3 从「经申报的破例」改判为「**宿主契约的规定用法**」，并同改 `lib/index.js:3091-3093` 注释 | 宿主 README 原文 + 文档卫生第 5 条 |
| R-4 | §9.1 从「唯一未证实的假设」改判为「**已证机制**」，U8 保留为**部署层**验收 | 宿主源码链（三方）+ worker-2 日志 1575 处 append（kimi 一手） |
| R-5 | 二阶代价按 **A** 发货（记账 + 辅助读数），B 挂起 | 见 §2.2 B-opt |
| R-6 | **§2.3 未解释项闭环**：诊断里的 provider 差异＝**路由属性**，不是 provider 好坏 | 宿主文档原文 + 本会话实测（下） |

**R-6 的双证（本轮新增读数）**：

1. 宿主文档原文（桌面 `resources\app.asar` 实读）：「…a system node in place makes the request differ from that node's first token — in full when the node is node 0 — so the provider **prefix cache misses from there**; when the prepared call declares `systemPromptUpdate: 'in-history'`, a non-empty prompt change inside a continuing request series is **appended after the cached history**, so the prefix through that history stays reusable.」——**这句话同时是本批根因的宿主原话，也是差异的解释。**
2. 本会话 `request/context` 事件实测：`seq 15` = `deepseek-official/deepseek-flash`，`systemPromptUpdate:"in-history"` **在场**；`seq 36` = `zai-coding-cn/glm-5.3`，该字段**缺席**。

⇒ 结论：**glm-5.3 路由走「原地替换 node 0」⇒ 变化点起前缀全断（实测 0.5%–8.7%）；deepseek-flash 路由声明 `in-history` ⇒ 提示变更追加在缓存历史之后 ⇒ 前缀仍可复用（实测 81.6%–96.3%）。** 本批方案（把动态文本搬出系统提示）对**两种路由都正确**，且在 glm 类路由上是数量级收益。

---

## §4 教训（**主代理写**）

| # | 教训 | 具体错在哪 |
| --- | --- | --- |
| 1 | **证据够了就要停手，但「够」的标准是本方自定的**——我把已经拿在手里的证物当成了间接证据 | 我读到了 `runtime-context.js` 的「两条 loop-owned surface message」，却**没有继续读 `project()` 的实现**（一行 `if (this.retained?.text === snapshot) return;` + `surfaceOp:"append"` 就能定案）。结果写了一个「待测假设」的 hedge，而三方会诊各自几分钟就把它证死了 |
| 2 | **只在缓存轴上核算，漏了 token/历史轴** | 搬家只算「前缀不再断」，没算「追加通道会**持久化**一条条快照」⇒ O(步数) 历史增长是本次会诊最有增量的发现，三方独立提出 |
| 3 | **伪代码继承了被改代码里的不可靠模式** | 我照抄了现行 `lib/index.js:3578` 的 `assembly?.agent`，而宿主 `AssembleContext` 根本没有 `agent` 字段。它一直没炸，**只因为后面有 `?? agent` 兜底**——这类「靠兜底活着的死路径」是审计盲区 |
| 4 | **把自己的常规当成了例外** | 我把字面 order 写成「经申报的破例」，而宿主 README 明写外部贡献方「may use any finite order」——闭集是给**仓库自有**贡献方的。**先读对方的契约原文，再宣布自己的例外** |
| 5 | **跨档指针没在同一次编辑里落地** | 需求档 US-C7 指向 U9，而设计档当时只到 U8（悬空）。我在会诊 settle 前独立补上了，但纪律上它本该在同一批编辑里出现（文档卫生第 2 条：指针可解析） |

---

## §5 不可验清单（**主代理写**）

| # | 不可验项 | 为什么不可验 / 谁能验 |
| --- | --- | --- |
| 1 | **mimo-v2.6-pro 一条意见都没有** | 平台面报「子代理面不可诊断（no diagnostic，子会话日志无 turn/end reason）」。⇒ 本纪要的「三方一致」是 **3/4**，不是全票；缺失的那一票**不可补**（重开即新会诊） |
| 2 | **「只读」只是弱证** | 会诊自带声明：本部署无法收窄子会话权限面，`toolFilter.allow` 白名单只保证**下发**、不保证模型面可见；实测子会话 request/header 的 tools = `[run_code]` 单元素 ⇒ 残余绕行口在场，子会话实为 `danger-full-access`。**本纪要中的一切「实读」都需按此折扣理解** |
| 3 | **桌面 0.2.0-rc.1 asar 的行号级引用未逐条复核** | deepseek-v4-pro 与 kimi-k3 各自声明**未能独立复读** asar；glm-5.3 报的 `asar@L…` 行号我**未逐条复核**（我只复核了被引用的那句原文确实存在于 app.asar 中） |
| 4 | **`context()` 的运行时在场性** | 我只有**静态**实读（app.asar 文本里有 `context(context){…}` 与 `CONTEXT_ORDERS` 三键）；真正的 real call 需一个 scratch 插件在桌面宿主里跑一次 —— 本轮未做，列入实施计划的第一步（零风险、可先做） |
| 5 | **「每步一条快照」的实际 token 量** | 三方估算分歧：60–80 / 150–250 / 150–400 tok/条。**只能部署后实测**（U8 的辅助读数即为此设） |
| 6 | **U8「命中率 ≥95%」是预期不是读数** | 部署后才可验；本纪要不得把它当既成事实引用 |

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-10-10 | 机制落盘（§0 汇总 + §1 原始层）；裁定层待主代理补写 |
| 2026-10-10 | **裁定层补写**（§2 逐条处置 17 条：15 采纳 / 1 不采纳 / 1 挂起待用户裁决；§3 父侧裁定 R-1…R-6；§4 教训 5 条；§5 不可验 6 条）。同批按采纳清单修订设计档：§2.3 闭环（路由属性双证）、§4.2 补 E′/F′/G′、§4.3 改判为「宿主契约规定用法」+ order 125→130、§5 FR-5 补 `getContextOrder` 桩、§6.2 删 `assembly?.agent` 死路径、§7.2 记账 + worker 快照组成、§8 U3 改钉 130 / U8 拆双读数 / 新增 U10–U11、§9 新增 5 行边界、§9.1 升格为「已证机制」+ 新增 §9.2 B 选项 |

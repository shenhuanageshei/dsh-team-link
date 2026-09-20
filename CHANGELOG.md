# Changelog

本文件记录 `dsh-team-link` 的变更史。版本号策略：`package.json` 的版本号**随发布统一 bump**——开发期累积的条目先记为「未发布」，发布时一次性收口（例如 0.3.1–0.3.6 的条目在 0.3.7 发布时一并落定）。

格式：每个版本按 **修了什么 → 为什么 → 怎么验证** 组织。凡涉及行为修复的条目都附**变异验证**证据（修复前必红 / 修复后全绿），这是本仓库的验收文化。

---

## 0.3.8 — 2026-09-20（当前版本）— ① 发送方可见性（§10.1）· ② `/team_session` 自动建队（§10.2）· ③ 自动换届交接（§11）

> ① 让**发送方自己**也看到自己发出的跨会话消息卡片（此前只有接收方有卡片，发送方只看到一行藏在可折叠工具树里的灰字）。② 一条命令建 N 个 worker 根会话并登记进 roster。③ 让换届能自动建继任者并交接，另加一个**两动词、attended-only** 的团队恢复工具与活性诊断面。设计与裁决记录：`docs/collab-enhancements-design-2026-09-19.md` §10.1 / §10.2 / §11 / **§12（真机验证结果）**、`docs/consult-minutes/2026-09-19-consult-37-minutes.md`、`2026-09-20-consult-43-minutes.md`。
>
> **发布状态**：三项的宿主半边都需 DSH 重启才在真机生效。**演练 8（①）已通过真机验证**（§12.1）；**演练 9（②）/ 演练 10（③）/ H1 / H3** 待另一次重启窗口（DEFECT-1/2 的修复要重启才生效，见 §12.4）。

### ✨ 新增
- **A：`tool.call.toolview`（key 逐字 `team_link_send`）**——发送方的工具行从通用灰行变成与接收方同款的出站卡片。**逐目标行 = 目标身份 + `outcome` 短句 + （忙碌时）徽标**：`outcome` → 固定短语（走 locale，zh/en 两套键），**不再原样搬运模型可见的 `detail` 报告句**——那句含「已投递到 …」「目标处于空闲」「steer 注入当前回合」这类**投递机制电报**，让人看的卡片偏机制而非结论且一个目标占 2–3 行（例：80 字符 → 44 字符）；`detail` **仍留在 meta 里**（模型可见文本的事实源 + 降级兜底），只出现在**模型可见的报告**中。用户 2026-09-20 决定，见设计 §10.1.5 / §12.5。
- **D：自有 conversation node definition（kind `team-link-send`）+ 顶层摘要卡**——在会话流**顶层**多一条「发给谁 / 正文 / 汇总计数 / 时间」。**不写任何日志事件、不动模型上下文**。
- **数据链：`output.presentationMeta` → `tool/result.meta`**——卡片读**结构化回执**，不再 regex 解析工具返回文本；持久化后可回放重建同一张卡。
- **② `/team_session`（设计 §10.2）**——一条命令建 N 个 worker **根会话**（N ≤ 8、每队成员 ≤ 24，两个**代码常量**，刻意不进 settings schema）→ 逐个 create 后 `followup` 投递启动任务 → 按 role 幂等登记进 roster → 与主会话建立 pairs 双向免确认通道。批量动作前有**一次**写明「数量 / 模型 / 预设 / cwd / 保守成本口径 / 将建立的信任」的确认框，**取消即零创建零 pairs**，无确认服务即 fail-closed。命令走**可选** `ctx.inject(["commands"])`（模块级 `inject` 仍 4 项），**服务缺席 / 迟到 / 无 `register()`** 三种降级都只丢这条命令。会话 `meta` 恰 `{cwd, agentPreset}`（`origin` / `parentSession` / `delegationDepth` / `parentAgent` 一律不写 ⇒ 根会话），`AgentHandle` 由**插件根 ctx** 的控制器持有。
- **② schema 新增（唯一一处，已裁定）**：`PolicyConfig.pendingCreates`——§10.2.6 的 pending-create 意图必须持久化，否则重启后启动清扫扫不到任何东西。§10.3 原文「schema 均不改」措辞过宽，已改准为「**既有 key 的语义与形状不改；新增须为设计明确要求的闭环所需并在文档与 CHANGELOG 记录**」；既有八个 key 的名字、形状与语义一字未动。
- **② 生命周期（设计 §10.2.5，设计要求必须写进文档）**：**插件卸载/重载 = 全队 teardown**——`AgentHandle` 由插件持有，拆插件即拆掉这些代理，**而会话仍在盘上**。这不是事故，是生命周期事实。恢复路径三步、不新增机制：`team_link_list_sessions` 如实读成 `✕ 未运行` + `verdict=dead` → 在侧边栏**逐个打开**把会话拉回活的代理 → 用 `team_link_roster action=set-role` 重新登记。`/team_session` 的返回文案也带同一条提示。README 的 ② 段落与本条同批补齐。

### ✨ 新增（③ 自动换届交接 · 设计 §11）
- **③a 主路径**：`team_link_rotate action=prepare` 新增 **`successor:"auto"`**（+ 可选 `handoff` 正文）——插件自建**根会话**续任、写**三层交接文档**（头 YAML / 事实段（**与 claim 返回文案同一事实源**）/ 正文 **5 硬节** `mission`·`in-flight`·`commitments`·`unknowns`·`task-and-goal`），再把令牌与正文 **followup** 投给继任者、由它自行 **claim**（**claim 逐字未动**，未新增令牌类型）。**缺项阶梯**：auto + 空正文 → **拒绝于工具入口（零建会话 / 零令牌 / 零 freeze）**；硬节缺 → 拒绝并点名；软节缺 → 放行 + 警告；显式 successor 无正文 → 放行 + 警告；文档写失败 → **abort-before-prepare**。便捷命令 **`/team_rotate <role>`**（走可选 `commands` 注入，**只对现任开放**）。
- **③b 恢复工具 `team_link_recover`**——**恰两个封闭动词**：`revive`（复活**同一**会话：身份 / roster / 信任**零改动**；**只对插件自建会话**，人类自建只输出深链指引）与 `reappoint`（**人类对话授权的 prepare**：候选由**插件**从 live 成员算出、**模型不得指定** → 逐字走既有 prepare + claim）。**attended-only：刻意不设 provisional / 无人值守变体**（pair 迁移可被 sweep 自动回退，**incumbency 不可**），无确认服务 → fail-closed。**八条反后门约束全部落成断言**：封闭动词 / 候选插件算 / `revive` 只绑当前 `current` / `writerGate` 原样不动 / **绝不把 `writer` 降级为 `any`** / 限速 + 三处留痕 / 进入先跑过期清扫 / TOCTOU 双复检（对话框弹出时与落笔前各重查活性）。
- **③b 活性诊断面**：三道门（`writerGate` / `rotateGate` / `retireGate`）**本体仍是纯函数**，由**有 ctx 的工具层**富化拒绝文案（旧文案对死现任是误导性的）；`roster get` 现任行加注记；启动清扫新增「current 无活代理的角色」一行；**`roster.md` 刻意不加**（落盘文件不烙活性读数）。两个派生词 `vacant`（刻意空缺，`current=null`）与 `seated-dead`（悬空指针）**不落盘**。

### 🐞 真机验证暴露的三个缺陷（均已修，待复验窗口）
- **DEFECT-1（高）**：编程创建的会话**跑不起来**——`prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")`。根因：`buildTeamSessionCreateOptions` 只在给了 `preset=` 时才写 `meta.agentPreset` 并 mount ⇒ **缺省时新建 agent 没有 persona-prefix 组装源**；而官方模板 `createWebhookSession` 是「**总是** resolve（缺省也解析）并 mount」。修法：对齐模板（缺省也解析 + 无条件 mount；服务缺席降级为一行 warn 且不阻断创建）。**H4 假设由此被真机推翻**（**会建 ≠ 能用**）。
- **DEFECT-2（中高）**：编程创建的会话**未挂进工作区** ⇒ 用户侧边栏看不到（须手动切工作区）。根因：模板在 `agents.create` 后调 `await workspace.attachSession(sessionId)`，我们**全库 0 处**。
- **两个缺陷是同一个模式**：**模板有一组「创建后必须做的事」，实现只做了一部分**（漏了 preset 解析/挂载、漏了 workspace 挂载）。
- **DEFECT-3（高）**：**DEFECT-1 只修了一半**——补上了 preset（组装源），却**没给装配里引用的 `{{model}}` 赋值**。**机制证明**：`{{model}}` 取的是 **agent 自己的 `options.model`**（`dsh-agent-loop/lib/index.js:1534` 的 `ctx.systemPrompt.variable("model", (context) => context.agent?.options.model)`）⇒ **宿主缺省根本不在那条路径上**；而 `buildTeamSessionCreateOptions` 在未给 model 时让 `agentOptions` 为空、`installTeamSessionModelSelection` 首行返回 ⇒ 编程创建的 agent **没有任何模型选择** ⇒ 首回合报 `prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")`。**这一处「故意不做」是父侧批准的**（理由写的是「缺省时宿主自己的 defaultModel 已生效」）——**真机把它推翻了**。
  **修法**：对齐模板 `resolveRequest:30-36`——未给（或**只给了一半**）时用 `ctx.agentDefaultModel.currentSelection()` **解析/补齐**并写进 `agentOptions`，再把同一份选择交给 `installTeamSessionModelSelection`；服务缺席 ⇒ **拒绝创建**（fail-visible——宁可不建，也不建一个跑不起来的会话）。**② 与 ③a 两条路径各自断言**（`successor:"auto"` 建的继任者同样受影响，而那是**信任迁移路径**）。
  **教训（已写进设计 §10.2.2）**：凡列入「故意不做」清单的条目都是**判断**，必须**在真机上被证伪过**、否则显式标注为「未验证的假设」。**「我认为宿主会兜底」不是判据。** DEFECT-1 与 DEFECT-3 是**同一份清单上的同一次失误的两次爆发**。
- **教训（已写进设计 §12）**：① **模板引用必须带「时序清单」**，不能只引形状——§10.2.2 只写了 `meta` 的形状，实现逐字写对却漏了后续步骤；② **断言可能成为缺陷的同谋**——修复删掉的那条旧断言「无 `agentPresets` ⇒ 会话照常可用」正把缺陷固化成了期望行为；③ **探针的前置条件本身也要被验证**——H1 默认「会话已经能被看到」，而真机暴露的正是它根本不在该工作区的列表里。

### 🔧 修复（差异审计与代码评审发现）
- **F2（仓库自身良构红线）**：`targets[].sessionId` / `expr` / `senderSessionId` / 信封 `type|pri|ref` **未经 `wellFormed`**——会把孤立代理项写进会话日志。已全部过闸 + 6 条回归锁（此前代码注释与 README 的「永远良构」自述**不成立**，已改）。
- **F1**：A/D 两面曾逐字重复 head/body/summary/foot。已按「每块信息只准出现一次」分工（D = 标题+时间+正文+汇总；A = 标签+逐目标行）。
- **F3**：客户端**模块级** inject 新增 `uiConversation`，会把设计承诺的「只不渲染」放大成「整个客户端半边不加载」。已改回 3 项 + 动态注入。
- **B3 / 评审 #3**：四条客户端注册全部过 `guardedSlot`（一条抛错不影响其余）。
- **评审 #1**：文件头注释曾称空闲目标「queued without being woken (inject)」，实际是 `followup`；已改。
- **评审 #2**：客户端对 `targets` 行数设界（24）+ 显式截断标注（宿主侧同源缺口见下）。
- **差异审计修复轮 🟡-1（本轮的实质 bug）**：**启动窗口内的 pending-create 意图在并入设置命名空间时被丢掉**。起因是同源形状：许可「整份写入当前命名空间」的谓词 `policyIsAtDefaults` 在 ② 轮加上了 `pendingCreates`，而**兄弟写面**——`adoptMemoryWindow` 交给 `update()` 的那笔补丁——仍是先前七个 key（文件自己的注释就写着「Fields added to DEFAULT_POLICY belong here in the same change」，写面没跟）。后果：窗口内写下的 §10.2.6 意图并入后消失，**下一次启动的清扫清单里就没有这条本该交还给人的孤儿记录**（审计插桩读到 `pendingCreates=undefined`）。修法：补上第八个 key，并在谓词与写面的注释里把「两半必须同批同名」写死。**教训与 ① 的跨轮缺口同源**：新 key 加进了谓词，漏了兄弟写面。
- **差异审计修复轮 🟡-2（描述与实现不符）**：README 的 ② 段落此前声称本轮修掉了一个「旧命名空间迁移会**把当前命名空间整片抹掉**」的缺陷。审计逐行核对基线后判定**该机制不成立**：写**当前**命名空间的那笔补丁基线**就已只含**那五个信任字段，写「整份 `DEFAULT_POLICY`」的是**旧命名空间**那次重置（语义是「重置旧命名空间使迁移不重复」），且 `dsh-settings` 的 `update()` 是 **patch 合并**（另有独立 `replace`），缺 `teams` 的补丁不可能抹掉 roster。已把 README 改写成实际发生的事（谓词与写面覆盖新增的 `pendingCreates`），并为该改动补上断言与条目。
- **差异审计修复轮 🔵-1（证据措辞）**：此前 CHANGELOG / README / 测试注释称「插件对会话只有 `sessionQuery` 的三个读方法，故可静态证明无写入面」。实测是**四个**读方法（漏了 `listSessions`），且插件**确有**会话写入面（`ctx.agents.create` / `agent.followup`）。红线仍成立，但理由换成诚实的版本：那两条既有路径用的是**上游定义**的事件类型，本插件无从发明新类型；**静态正则证明不了这一点**——它锁的是「本模块不得自己长出写入面」（审计变异 M6：往模块里放一个日志写入 API → 1 红），运行时那条读的是**桩**、结构上观察不到新事件类型。断言本身保留，全部措辞已改。
- **差异审计修复轮 🔵-2（有意保留的偏差，已写入代码注释）**：§10.2.3 的模板是 `createUserMessage({content, source})`，实现是手写字面量。裁定：**保持手工构造**——`createUserMessage` 来自 `@deepseek-ai/dsh-llm`，而本模块导入面是**六项白名单**且经 U19 锁住；两条消息实体逐字相同，差别只在上游构造函数产出被**深冻结**（`brandString` 是恒等函数）。不为一行深冻结把导入面扩到 7 项。理由与该回退条件已写进 `teamSessionKickoffMessage` 的注释。
- **差异审计修复轮 🔵-3（状态行/条目不同步）**：README 的设计档索引行仍写「② `/team_session` 自动建队（未实施）」——已改为**已实现**（并标注与 ① 同样「未发布、未真机未验证」）；本小节此前标题只写「发送方可见性」且**没有 ② 的任何条目**——已补。
- **差异审计修复轮 🔵-4（计数）**：U19 一节的断言数是 **17**（此前写 16）；「② 收口轮的 WIP 实际是 640」被实推翻——那次 WIP 提交自带的 README 记的是 **639**（`506 + 133`，内部自洽），640 只是 `656 − 16` 的算术推演。本文件的计数一律以套件自报的那两行为准。

### 🧱 宿主侧行数界（设计 §10.1.2 修正后补）
- `buildSendCard` 对 `targets` 封顶 **24 行**，并写入 `targetsTruncated: {shown,total}`；裁的是**呈现**——`summary` 计数与文本报告仍**全量**（卡是有界呈现，报告是全量档案）。
- 背景：输入侧的 ≤8 只约束**表达式**，而一个 `team:<n>/*` 会在宿主侧展开成**全队成员的行**——所以「持久化卡片必须有界」这条原设计**在宿主侧并不成立**，本轮补上。

### 🔗 跨轮交互缺口（已定位并修复）
- **症状**：宿主先裁到 24 行并写 `targetsTruncated`，而客户端判超限是「自己数行数 > 24」——对**自产卡永远不触发**：A 面看不到截断标注，标签显示的是**已画出的 24 行**而不是真值 30。属**静默失真**（把有界呈现当成全量呈现）。
- **怎么发现的**：实施方在下一轮收尾时**主动对照自己上一轮的成果**上报；父代理用 `grep targetsTruncated lib/client.js`（**0 命中**）独立复现。两轮各自都正确，缺口只存在于两轮的**交互**里。
- **修法**：客户端新增 `readTargetsTruncated`（坏可选成员只丢该成员，不否决整张卡）+ `sendCardTargetTotal`（有标记取 `total`，无标记取实际行数）；A 面**两类超限都出标注**；标注里的 `{shown}` 取**实际画出的行数**——不采信外来 `mark.shown`，否则一张手改卡会在画着 24 行时宣称「仅显示前 5 行」。设计 §10.1.2 / U14 已把这条契约写死。

### 🧾 本期后续轮次（③ 的审计修复 · 真机缺陷 · A 面改人话）
- **③a 差异审计的修复轮**（审计 0 🔴 / 6 🟡 / 7 🔵）：令牌过期时的「额外报告插件自建继任者」**不再依赖内存态 handle**——那个判据在插件重载后恒为假，**恰是设计要防的「没人知道的孤儿」窗口里点名行静默消失**；改为**持久证据优先**（交接文档头部的 `successor:` 行 → 落盘的 `pending-create` 意图 → `hasHandle` 降为附加佐证），且点名行**自报判据来源**。同批：五硬节名收成**一个真源**（四处任一处改名而其余不跟**必红**）；命令键表改成**双向行为锁**（不在广告里的键必须被解析器拒绝）；改名不再让套件崩溃而是**干净地红**（并顺带发现另三处同类）。
- **③b 差异审计的修复轮**（审计 0 🔴 / 7 🟡 / 8 🔵）：**发起域落地**（{该角色最近一任前任} ∪ {团队现任成员}；域外拒绝**零副作用**，连确认框都不弹）；工具描述改准（`revive` 仅 coordinator、`reappoint` 任意角色——**授权从不源自 coordinator 身份**）；**两处空锁改成行为锁**（删掉身份复检 / 删掉入口过期清扫，都必须红）；补 `?? []` 护栏并收口 9 处深链访问（**任何 break 之后套件都能跑到底并打印 `assertion total`**）；死代码合并、候选对话框改**单选**（原多选却只取第一位 = 静默丢弃）、多处注释里一句**被实测推翻的信念**改准（schemastery 不 strip 未声明字段）。
- **合并代码评审（PASS：1 🟡 + 3 🔵）的收尾修复**：① **`revive` 侧的身份复检从「半空锁」落成与 `reappoint` 逐字对称的行为锁**（`Y3-sym` / `Y7-sym`，两条互不顶替）——**红相实测**：把该复检整段注释掉 → `835 (failed: 1)`，**唯一红的就是新锁、所有既有 revive 断言仍绿**，这正是「半空锁」的实证；② 四处机械拼接的排版残留清理，附**三层「纯空白」证明**（正则命中 4 → 0、逐处空白剥离后逐字相等、**全文件字节账** `478574（起始）+ 8（本项插入的 4 个 CRLF）+ 951（#4 那段净差）= 479533 = 实测字节数`）；③ `autoHandover` 的事实段计数改为**确认之后、写文档之前重读一次**再算（使「文档里的数目 == `prepare` 即将快照的那份状态」），并加行为断言（对话框期间往 pairs 加一条 ⇒ 文档必须写 **4 条**而非 3 条；删掉重读即回落成 3 ⇒ 红）。
- **A 面改从结构化字段渲染一句人话**（用户决定）：A 面**不再原样搬运模型可见的报告句**（含「已投递到 …」「目标处于空闲」「steer 注入当前回合」这类**投递机制电报**，让人看的卡片偏机制而非结论，且一个目标就占 2–3 行），改由 `outcome` / `busy` / 目标身份渲染短句；`detail` **仍留在 meta 里**（模型可见文本的事实源 + 降级兜底）。原「卡内行 == 报告首行」的字符串等式锁**作废**，换成**跨半边行为锁**（新增 `outcome` 枚举值而无客户端短语 → 必红）。

### 🧪 验证
- `node host-half.test.mjs` → **848**（failed: 0）；`node client-half.test.mjs` → **146**（failed: 0）（**0.3.8 收口时点**；合计 **994**）。基线演进：host 506 → … → 675 → 831 → 848；client 46 → … → 138 → **146**。
  > **计数口径**：一律以套件**自报的那两行**为准；本文件历轮的时点计数（如 675 / 813）保留原文不改，最新值见本行与 README 徽章、第十节。
- **U19 红线回归**（② 收口轮补，**17 条**断言——此前误记为 16，差异审计修复轮 🔵-4 已改；判据是在 U19 小节内逐个数 `check(` 调用点（修复轮**之外**另加的 7 条见下一条，两者不要相加））：① 无新增日志事件类型；② 投递 `source` 恰三成员；③ 模块级 `inject` 仍 4 项；④ 既有 schema 形状与投递双门零改动（含「整批恰弹一次对话框」）。① 的判据经差异审计修复轮 🔵-1 改写为**诚实版**：插件对会话的写入面**存在**（`ctx.agents.create` / `agent.followup`），`sessionQuery` 是**四个**读方法（`listSessions` / `readSession` / `readSurface` / `readTitleSnapshots`），所以那条源码断言锁的是「**本模块不得自己长出写入面**」（审计变异 M6：往模块里放一个日志写入 API → 1 红），而**不是**「静态正则证明了事件类型」——那两条路径的事件类型由**上游**定义，正则证明不了这一点；运行时那条读的是**桩**，结构上观察不到新事件类型，是旁证而非判据。
- **并发纪律**：§10.2.6 要求 create 与 followup 串行（或 ≤2）——实测**已在树上**（单条 `await` 串行循环、`agents.create(` 全模块恰一调用点），故未新增队列，只补断言：提供方侧在飞峰值 **实测 1 ≤ 2**。
- **schema 新增（唯一一处，已裁定）**：`PolicyConfig.pendingCreates`——§10.2.6 的 pending-create 意图必须持久化，否则重启后启动清扫扫不到任何东西。§10.3 原文「schema 均不改」措辞过宽，已改准为「**既有 key 的语义与形状不改；新增须为设计明确要求的闭环所需并在文档与 CHANGELOG 记录**」；既有八个 key 一个字未动。**差异审计修复轮 🟡-1 让这条从「声明」变成「被断言的行为」**：谓词与它许可的整份写入如今都点满八个 key，并入窗口时八个一起写。
- 变异证据（单点回退，修复前必红）：正文截断去掉 → 5 红；结构化 busy 去掉 → 3 红；槽位 key 改近形 → 3 红；不读回执 → 12 红；窗口截断回退去掉 → 2 红；**F2** 的 `sessionId` / `expr` 孤立代理项 → 各 1 红；**评审 #2** 渲染上限去掉 → 2 红；**评审 #3** header 注册去掉护栏 → 2 红；**宿主行数界**去掉 → 3 红；**客户端读标注**路径去掉 → 3 红；**🟡-1 的写面那一行**（`pendingCreates: [...memory.pendingCreates]` 去掉）→ 1 红。
- **差异审计修复轮（本轮实测，红→绿）**：新增 7 条断言（`U9 对照 (pendingCreates)` 一组）。**红相**：先插断言、`lib/index.js` 的写面**一字未改**跑一次 → `663 (failed: 3)`，三条同时红（「窗口内的意图并入后仍在」「并入的行逐字段完整」「并入恰是那八个 key」），而同一组的三条前置断言当场全绿（两个 provider 都迟到 ⇒ 整批在内存窗口内跑；commands 迟到挂载不额外留行；worker-b 的 create 失败 ⇒ 意图未被回填）——前置全绿是**关键对照**：它证明红色不是「路径没走到」。**绿相**：把 `pendingCreates` 补进 `adoptMemoryWindow` 的补丁后 → `663 (failed: 0)`（宿主侧唯一改动，客户端 `138 (failed: 0)` 同期无损）。审计侧另有独立复现（`%TEMP%` 副本插探针：`AUDIT after fold: teams=["night-shift"] pendingCreates=undefined`）。
- **② 收口轮的 WIP 断言数**：**639**（`506 + 133`，那次 WIP 提交自带的 README 记的就是 639，内部自洽）。此前「WIP 实际是 640」的说法是 `656 − 16` 的算术推演，已作废（差异审计修复轮 🔵-4）。
- **代码评审 round-1 收口轮（文法面，红→绿）**：评审发现 `/team_session` 的**位置参数（bare token）被解析却从未被消费**——而 `description` / `input.hint` / 解析器注释 / **plan 自己的报错文案**都在宣传这条路径，用户照报错提示输入仍会得到同一个报错；同时 `task=` 与自身注释矛盾（按空白切分 ⇒ 未加引号的多词任务把词**静默丢进被忽略的 `bare`**，而 `task="…"` 又把引号留进值里）。**修复**：位置参数真正折进 `roles`（`team=` 仍是**必需** key——「首个裸 token 兼作团队名」与「用户忘了 `team=`」无法区分，猜错的代价是把会话登记到别的团队名下）；`task=` 改为读到**下一个已知 `key=`**（保住既有 `task=做接口 model=… preset=…` 次序），`key="value"` 统一剥引号、**半引号一律拒绝**。**红相**（拿 `HEAD:lib/index.js` 原始字节对比）：修复前 `roles=undefined` / `task="fix"` / `bare=["the","bug"]` / `team="t"` 带引号；修复后 `roles=["worker-a","worker-b"]` / `task="fix the bug"` / `bare=[]`。**端到端**（真跑命令，不是只查解析层）：`team=night-shift worker-a worker-b task=fix the bug` → 创 2 会话、roster 落 `coordinator,worker-a,worker-b`、kickoff 正文含完整 `fix the bug`；缺 `team=` 时明确报错。**绿相**：`675 (failed: 0)`（新增 11 条）。同批：README 架构图「11 个工具」→「**8 个工具 + 1 条 `/team_session` 命令**」；死代码 helper `plannedId` 改为**真按 role 查**并投入使用（另删同一处零引用的死常量 `TEAM_SESSION_ROLES`）。
- **真机验证**：**演练 8（①）已通过**（2026-09-20，证据见设计 §12.1：A 面是卡片、D 面顶层摘要卡存在、F1 信息分工成立、导出 3611 事件无自创类型且 `source` 恰三成员）；宿主侧其余改动需 DSH 重启生效 ⇒ **演练 9 / 演练 10 / H1 / H3** 排在用户批准的**下一次重启窗口**（§12.4）。另：真机还暴露并修复了两个缺陷（DEFECT-1/2），其修复同样**需重启才生效**。

---

## 0.3.7 — 2026-09-18

> 收尾修复轮。修两个在**真实部署中实测到**的功能性阻塞，并收掉一轮代码评审的分歧。设计与裁决记录：`docs/team-upgrade-design-2026-09-17.md` §9、`docs/consult-minutes/2026-09-18-consult-36-minutes.md`。

### 🔴 ① settings 持久化静默失效：团队状态从不落盘

**症状**（真实部署实测）：`team_link_watch register` 返回成功、`list` 也能看到条目，但 `profile/settings.yaml` 的 mtime 与全文**毫无变化**；日志里也没有任何本插件的 warn。后果：teams / watchdogs / pairs / rotation **全部只活在进程内存里**，每次 DSH 重启清零。盘上从来没有 `team-link:` 段——也就是说**自 0.2.x 起信任数据从未落盘**，「改名迁移已完成」这个当时写进交付报告的结论是错的。

**根因**（源码链）：cordis 的 `ctx.get(name, strict = true)` 只返回**提供方 fiber 已 active** 的服务（`cordis/lib/index.js:762-771`：`if (strict && impl.fiber.state !== 2) return;`），而 settings provider 要先完成 `[Service.init]`（读盘 → publish）才 active。插件却在 `apply` 期**一次性**取服务，取不到就静默退回内存引擎——此后**无重试、无重绑定、无日志**（只有 `register` 抛错那条路径才 warn，而日志里从未出现该 warn，故该路径也被排除）。

**修法**（三件套）：

1. **快路**：立刻试一次 `ctx.get("settings")`——提供方已 active（或同步 stub）时零额外延迟挂载，既有测试语义不变；
2. **可选有序注入**：没拿到就留**一行 warn**，并登记 `ctx.inject(["settings"], cb)`——provider 转为 active 时回调 attach。它**不是硬依赖**（服务永远不出现时插件照常加载并降级）；`ctx.inject` 本身不可用时再留第二行 warn；
3. **运行期惰性重试**：`get()` / `update()` 每次发现未挂载就再试一次；成功即挂载并记一行 info（`policy store attached to settings namespace "team-link"`）。失败**不重复告警**——「未挂载告警」有**两条到达路径**（激活时未 active / active 但 `register()` 抛错），二者共用同一个一次性门，故**每个未挂载窗口有且仅有一行 warn**。

**同类第二处一并修**：`registerExportRoute` 原先同样在 apply 期取 `ctx.get("webServer")` 时点快照（它当时能用，只因 webServer 恰好先于本插件 active——日志里从未出现该处 warn 即为此反证）。改用同一「晚挂 + 重试」模式，**降级语义一字不变**：始终没有 webServer 就只有一行 warn、头部导出按钮不可用，而 `team_link_export` 工具照常工作。

**启动窗口的数据一致性**（防御性冗余）：attach 之前 `update()` 只能写进进程内存，而这个窗口理论上不可达。真发生时，attach 会把这些内存写入按与改名迁移同形的规则并入设置命名空间（**仅当**设置侧仍是默认值——settings 始终是事实源），并留一行 warn，不静默丢写；并入**先于**改名迁移执行，迁移的「当前命名空间已在用」判据因此看到最终状态。

**明确不采用**的做法：把 `settings` / `webServer` 加进 `inject` 数组：`inject` 是**硬依赖**，依赖缺失时 cordis 令整个插件 fiber 不激活，与「服务缺失时插件完整降级」这条红线相抵；而 `ctx.inject` 与 `inject` 在确定性上等价（同样等 provider 完成 `[Service.init]`），故取零功能回归者。

### 🔴 ② 建队引导死锁：团队建了却永远写不进首任协调者

**症状**：模型能成功 `upsert-team` 建出团队，但**永远**设不进首任协调者，团队到手即只读，M2–M4 全部功能不可达。

**根因**：`upsert-team` 的**创建**路径本就不该过写权限门（否则没人能建第一个团队），但 `set-role` **必然**过门——而门在「`writer=coordinator` 且现任空缺」时**拒绝一切会话路径**。于是创建路径与写权限门之间形成了一个死锁。工具文案当时把用户推向「设置 UI」，但插件并没有提供该设置段，人路径实际是手改 `settings.yaml`——而 ① 又让手改同样读不到。

**修法**：`upsert-team` 在**创建**路径把**调用会话**播种为该团队的 coordinator 现任（经 `roleRecord` 产出规范形状，`history` 记「创建者自举」）。已存在团队的 `roles` 一律不改（幂等契约与「非现任不能借 upsert-team 劫持」同时保住），**不新增任何工具参数**（种子只来自 `exec.agent.id`），`writerGate` / `retireGate` **一行未动**——**手写**的空缺行仍然全拒并指向设置 UI（那是用户显式表达的状态）。

### 配套修复

- **导出文件名安全不变式**：web 导出路由对 `sessionId` 有净化（`replace(/[^\w.-]/gu, "_")`），而 `exportSession` 把原始 id 直接拼进产物路径。抽成共享 helper `fileSafeSessionId()`，两条路径复用。
- **旧命名空间 register 失败必须留痕**：原先 `catch { legacyScope = null; }` 静默吞掉——best-effort ≠ 静默，现在留一行 warn 点名旧命名空间不可用、旧数据不会自动迁移。
- **两个记录项**：`host-half.test.mjs` 结尾输出断言总数（README 计数从此可对跑）；`team_link_list_sessions` 的 provisional 计数与投递侧口径对齐（过期记录不再计入「provisional 配对 N 条」——按投递侧判据它已不再是通道）。

### 代码评审加固（同日追加，仍属 0.3.7）

- **provider 生命周期归属**：晚挂拿到的 scope 与其**注入 fiber 同生共死**（`owner.effect(() => () => detach(), …)`，与 webServer 站点 `target.effect(…)` 同一条规则）。provider fiber 被 dispose 时 scope 归零并记一行 info，store 回到未挂载态、provider 回归时由惰性重试重挂。此前只有捕获没有归属：scope 非 null 却已死，`update()` 每次抛错、而 `get()` **静默改答陈旧内存**。
- **一次性门的单位是「窗口」**：`detach()` 同时**复位**该门——否则第二个未挂载窗口里的**拒绝**会零告警（与 ① 的原始缺陷同形）。窗口**内**的惰性重试仍被同一门挡住，不会成为告警风暴。
- **事后链留痕**：attach 之后的（内存窗口并入 → 改名迁移）两步各自返回结论，统一记一行 info（`post-attach policy chain finished — …`）；`migrateLegacyPolicy` 的早退分支不再一行日志都没有；`refused` 与「根本没有旧命名空间」从同形变为两个可区分取值。
- **内存窗口旗标**：结论记录后清零（避免后续窗口重复并入同一份已解决的内存态、重复记「该窗口理论不可达」warn）；只有 `fold failed` 保持置位——那些写入确实仍在内存里，下次挂载必须重试。
- **消除二次读**：激活分支的 warn 文案取自**第一次读**返回的理由码（`attached` / `refused` / `no-register` / `not-active`），不再第二次读服务（两次读之间服务可能出现，那样文案会描述一个已不成立的状态）；webServer 站点同样改理由码（`mounted` / `no-register` / `not-active`）。
- **死参数清理**：`attach()` 的第三参数 `unavailableDetail` 无人传，连同那条描述不存在路由的注释一并删除。

### 红线与不变量

`PolicyConfig` schema、投递门、`source` 三成员、`writerGate` / `retireGate`、`inject` 数组（仍 4 项）**全部零改动**；`goals.resume` 仍为**零调用**（换届只建议继任者自行 resume）。

### 验证

- `node host-half.test.mjs` → **506 项全绿**；`node client-half.test.mjs` → **46 项全绿**（基线 447 + 46 = 493）。
- **变异验证**：把 lib 的三处修复逐条回退 → `506 (failed: 4)`；把 `createPolicyStore` 换回真正的修复前形状（0.3.6 版：静默内存回退 + apply 当场跑迁移）→ `506 (failed: 16)`。还原即全绿（每次都按 sha256 校验还原）。
- **真机验证（重启后）**：`team_link_watch register` 后 `profile/settings.yaml` **首次出现 `team-link:` 段**（mtime 变化、10498 → 10838 字节），修复前同样操作 mtime 一动不动——这同时把根因链中原本标注为「推断」的一环变成实证；零手工建队 `drill-verify` → 返回「coordinator 已由创建会话认领」→ **紧接着 `set-role` 成功**（修复前这一步必被写权限门拒绝）。
- **独立复核**：一轮差异审计（explore 子代理，只读）独立复现了上述计数与红绿证据，并逐项核对了 inject 恰 4 项、`migrateLegacyPolicy` 唯一调用点在 attach 内、两个门一行未动、越界改动为零；三轮代码评审全部 PASS。

### 未验证 / 显式推迟（如实标注）

- **provider 在本插件 fiber 存活期间消失、而 scope 取自本插件自身 ctx 时不释放**——与 webServer 站点同形，不属红线，记为已知残留；
- **外部手改 `settings.yaml` 是否触发 watcher**：README 曾标为未验证，**2026-09-18 已实测**（外部删除 `team-link:` 段后 `roster get` 立刻回到 0 团队）；
- 两个 🔵 卫生项显式推迟并留档（store 返回对象里的死导出 `migrateLegacyPolicy`；webServer 站点的一次性门是进程寿命级），见设计 §9.6 ⑪；
- §7-4 的夜班日志历史取证（复核一次静默事件的具体触发器）未做——设计里本就标为可选取证。

---

## 0.3.6 — 2026-09-18（发布前收口于 0.3.7）

修两个真实使用缺陷。背景是一次协调者实测：把目标 id 打错一位（`75ae9099` → `75ae9095`），发送返回「没有活动代理」，于是 ① 调用方没有任何可核对的线索；② 该失败被当成普通回执、继续向上汇报「已发送」——而目标会话其实活着。

- **修 1 · no-agent 文案自愈化**（单目标 / fan-out / 插件内部通知三条路径共用 `deliverToTarget`）：拒绝文案首前缀改为 **`❌ 未投递`**（失败不许被读成已排队），保留原句「目标会话 `<id>` 没有活动代理」，并**新增同工作区存活会话列表**（`ctx.agents.list()` 纯注册表读取——零 surface 读取、无性能代价；过滤 = 根代理 + `origin !== "subagent"` + `cwd === 调用者 agentCwd` + 非自身；每行 `id（运行中/空闲）`，上限 **10** 个，超出时注明「共 N 个，仅列前 10 个」；无匹配输出「当前工作区无其他存活会话。」）与**核对提示行**（对照 id / 刚重启 DSH 时在侧边栏打开目标会话一次 / 先调 `team_link_list_sessions`）。执行上下文无会话身份时跳过 cwd 过滤、只排除自身。
- **修 2 · fan-out 失败领先**：只要存在任一目标 outcome ≠ `delivered`，返回文案**第一行**即为 `❌ N 个目标未投递（M 个已投递）`；**全部投递成功时文案形状一字不变**。no-holder 计入该行但汇总里仍保持独立桶、用词只说「未投递」不说「失败」。
- **行为面改动如实标注**：插件内部通知（rotation-freeze / -done / -cancelled / -expired）当收件人已无活动代理时同一行也会带 ❌ 前缀；`deliverToTarget` 是三条路径的共同出口，**未改动任何投递门与投递语义**。
- **验证**：`host-half` 431 → **447** 项（新增 16 项，当次实测），`client-half` 46 项不变（合计 477 → **493**）；既有断言仅 1 项随文案更新（no-agent 行前缀），其余 430 项零回归。

## 0.3.5 — 2026-09-18（发布前收口于 0.3.7）

修 `team_link_list_sessions` 在真实工作区的超时（生产实测：26 个会话的工作区里该工具超过 60s 工具预算；roster / watch 等其他工具正常）。

- **根因**：surface 读取对**列表每一行**（`LIST_LIMIT` = 50）逐个串行执行，而每个冷会话 = 一次 zstd 日志解压 + 一次表面投影。stub 实测（每次读 250ms）：26 会话串行 **6655ms**、修复后 **256ms**。
- **修法三件**：**有界**（恢复只读前 `PREVIEW_SESSIONS` = **12** 行，第 13 行起活性行降级为「未读（超出快照窗口 12）」，行本身照旧列出并经如实标注）；**并行**（这 12 次读取改 `Promise.allSettled`，一行不可读只降级该行）；**回归锁**（新增 7 项断言：调用次数恰为 12、12 次在首次 resolve 前已全部在飞、降级文案形状、窗口外行仍保留无 surface 的面等）。
- **代价（如实标注）**：窗口外的行不再给出 verdict——其中 `dead` 仍可从行首的「✕ 未运行」读出（运行状态来自 agent 注册表，不经日志），而 `goal-disarmed` 在窗口外不可得，需要时单读该会话（`team_link_export`）。
- **验证**：把 lib 改回串行无界的旧形状后 7 项中 3 项当场变红，还原即全绿；活性信号的计算逻辑（verdict 判定表）逐字未动。`host-half` 424 → **431** 项。

## 0.3.4 — 2026-09-18（发布前收口于 0.3.7）

两阶段换届 rotation（设计 §3.6 全节 + §3.6.1 四原则 + §4.1 + §5.1 U6 + §5.3 红线）。

- **`prepare`（Phase A，仅该角色现任会话）**：10 分钟速率限制防换届风暴；生成一次性令牌（`randomUUID()`，绑定 `(team, role, successor)`，30 分钟 TTL，成功认领即作废）；把 `pairs` / `trustedSenders` / `rememberTargets` / roster 全量快照进 `rotationBackup`；向全部在任成员广播 `[rotation-freeze]` 固定冻结清单；返回一次性明文令牌 + 掩码 + 交接指引。
- **`claim`（Phase B，仅 pending 指定的继任者凭令牌）**：单个多选对话框列出全部「退役者↔同 team 成员」候选 pairs 逐项勾选（对端在团队外的不进候选但点名）；在场确认 = ratified → 正式迁移；超时 / 无确认服务 / 失败 = 无人值守 → 全部域内候选以 provisional 迁移并开 **24h** 回退窗口；迁移 = 删旧 pair + 新建 `{a: 新任, b: 对端, provisional, expiresAt}`；**对称撤销** = 退役者持有的 pairs / trustedSenders / rememberTargets 同步清除；落定与迁移在**同一笔写入**，随后才清 pending——崩溃在两者之间时同一令牌重放只补收尾、不重复迁移。
- **到期清扫**（挂看门狗同一巡逻定时器 + 每次 roster / rotate / team_read 惰性检查）：30 分钟未认领 → 清 pending + `[rotation-cancelled]`（旧任仍为 current）；24h 未批准 → 删迁移出的 pairs + 版本史记 `provisional 未批准过期` + `[rotation-expired]`（新任保持 current，信任回退为过门）。
- **内部广播路径**：四种通知正文是**插件常量**（只插值团队/角色/会话 id/读数/状态词，且先过单行清洗）；免发送方审批但**照走接收方 inbound 策略与 `blockedSenders`**；一律不弹确认框。
- **令牌掩码**：镜像与 `roster get` 的 pending 一律渲染 `tok-<前4>…<后4>`，明文只在 prepare 的一次性返回里出现。
- **provisional 可见面**：send 返回文案后缀、`rotation-done` 状态词、roster get 的 pending/provisional 行、`list_sessions` 的「provisional 配对 N 条」标记；banner 与 `source`（仍恰好三成员）都不加字段。
- **补批准入口 = 设置 UI**：24h 内把该 pair 的 `provisional` 置 `false` 即转正式。
- **评审修复轮（7 项）**：**#1**（🔴）幂等判据从「迁移清单非空」改为 `current === pending.session`——域内无候选时标记本为空数组，旧判据会把已落定 roster 当未认领令牌，重放会走完整迁移、把继任者自己当退役者吊销其正式 pairs；**#2** 补批准后窗口静默关闭；**#3** 内部通知的 ask 分支改为逐目标 refused 行（不再 await 3 分钟确认）；**#4** claim 的镜像改用清 pending 后的数组渲染；**#5** 域内无候选时启用独立状态词 `无待迁移对`；**#6** `rotation-done` / `-cancelled` 的收件人并集加入 `rotationBackup.roster` 里的旧任；**#7** README 清扫措辞改条件表述 + `team_read` 加惰性 sweep。
- **第二修复轮（3 项）**：**#8**（🟡）过期 provisional pair 的 TTL 执行缺口——投递侧守门（`pairRecordBetween` 视过期记录为无 pair）+ 清扫侧把 doomed pairs 的计算与删除提到角色记账判据之前；**#9**（🟡）`set-role` 把角色交给 pending 继任者时清 pending（令牌随身份显式变更失效）；**#10**（🔵）`rotationStatus` 显式记状态词供重放直读；**R8** 顺带修掉一处既有墙钟竞态断言。
- **验证**：净增 74 项（311 → 385）→ 修复轮 +20（405）→ 第二修复轮 +19（424）；`client-half` 42 → 46。三轮修复共 22 项断言做过变异验证（挖洞后分别红 16 / 10 / 10 项，还原即全绿）。

## 0.3.3 — 2026-09-18（发布前收口于 0.3.7）

广播 fan-out + 结构化信封 banner + busy 预判（设计 §3.4 / §3.5 / §4.1 / §5.1 U5、U7）。

- **`targets`**（与 `targetSessionId` 互斥）：寻址优先级「会话 id 直达 > `team:<name>/<role>` > `team:<name>/*`」。`team:<name>/*` **仅该团队现任协调者可发**（策展理由）；角色空缺 → 类型化 `no-holder`（不算投递也不算失败）；团队不在 roster 或形状非法 → 整次调用拒绝（不做「半发」）；fan-out **不放宽任何门**；单次 ≤**8** 目标；重复 id 去重。
- **`meta` 信封**：`{type?, pri?, ref?}` 渲染进 banner 首行紧凑字段；`ref` 超 16 字符按码点截断并注明；枚举外的值 / 未定义字段 / 非对象 / 空 ref / 含换行 ref 一律明确参数错误；**`source` 仍是恰好三成员**。
- **busy 预判**：投递后追加目标忙碌状态（运行中 → 「目标回合已运行 N 分钟（steer 注入当前回合）；需新回合语义请等其空闲」，`N` 读不到时只给 steer 语义）。
- **顺带 4 项 M2 评审质量修复**：**R1** retire 信任清理改为对话框确认后**重新读再按最新视图过滤写回**（读-改-写窗口缩到毫秒级）；**R2** TTL 断言不再依赖墙钟；**R3** 补 `applyRetire` 两条错误分支断言；**R4** `team_read` 的 `decisions` baseHash 标注为「仅供参考/审计」。
- **验证**：`host-half` 净增 76 项（235 → 311），`client-half` 42 项不变（合计 353）。

## 0.3.2 — 2026-09-18（发布前收口于 0.3.7）

roster（团队身份注册表）+ 团队黑板（设计 §3.3 全节 + §4.1 + §5.1 U4）。

- 新增 `team_link_roster`（get / upsert-team / set-role / retire）、`team_link_team_read`、`team_link_team_append`；设置命名空间新增 `teams` 键。
- **写权限**：`writer=coordinator`（默认）时只有该团队 coordinator 现任会话可写，现任空缺时会话路径一律拒绝；`writer=any` 时任何会话可写；读永远开放。
- **`retire`**：current 置空 + 版本史记退役；随后可选**一个**确认对话框列出全部指向退役会话的 `pairs` / `trustedSenders` / `rememberTargets`，确认才清理（无确认服务则跳过清理、仅退役并说明）。
- **镜像**：每次 roster 变更在同一调用内 best-effort 写 `<workspace>/team/<name>/roster.md`（失败只告警——settings 始终是事实源）。
- **黑板**：`decisions.md` 只追加（`seq | ISO 时间 | author-session-id | 正文`，seq 单调递增）、`discipline.md` 整文件替换（必须携带 `baseHash`），两者单行上限 **500** 字符（按码点）；黑板**无写权限门**，写入者记在行内 author。团队名 `[a-z0-9-]+` 白名单 + file 枚举白名单（一律 `path.join`，防路径穿越）。
- **验证**：净增 67 项（168 → 235），`client-half` 42 项不变（合计 277）；变异验证：把写权限门与 baseHash 乐观锁各打一个洞后红 8 项，还原即全绿。

## 0.3.1 — 2026-09-18（发布前收口于 0.3.7）

活性面 + 跨会话看门狗最小版（设计 §3.1 / §3.2 / §3.7）。

- `list_sessions` 每个会话行新增 `活性：` 信号行（verdict 五态、goal phase/activation/轮次与 blockedReason、静默时长、读数时间戳）；goal 状态经 `ctx.get("goals")` **可选注入**（服务缺失显示 `?`，插件功能完整降级）。
- 新增 `team_link_watch`（register / list / clear）：只能给自己注册、拒绝自指、单会话 ≤3 个、`silentMinutes>=10` / `intervalMinutes>=5` / `ttlHours<=24`（默认 12，到点自清）。
- **四态巡逻**：观察者运行中或自身 armed-active 不 tick；目标 armed-active 不 tick；目标 active-but-disarmed **立即** tick 且载荷带诊断与合规 resume 回路；paused/blocked/complete 不 tick；无 goal 且静默超阈才 tick。
- tick 的 `source` 仍是恰好三成员（id 前缀 `slp-wd-`），正文是**插件常量模板**；去抖与「观察者=dead」为进程内状态、不持久化；巡逻定时器随 dispose 清理。
- **验证**：净增 93 项（75 → 168），`client-half` 42 项不变（合计 210）。

## 0.3.0 — 2026-09-17

**更名** `dsh-team-link`（原 `dsh-session-link-pro`）：包名 / cordis 名 / client bundle id / 工具名（`team_link_list_sessions` / `team_link_export` / `team_link_send`）/ 设置命名空间（`team-link`，含旧数据一次性迁移）/ 导出路由（`/team-link/export`）。

**不变量**：`slp-` 消息 id 前缀、`dsh://` 深链协议、上游深链解析行为、双门投递语义——一律保持。

**GitHub 仓库名**于 2026-09-18 一并改为 `dsh-team-link`（旧地址自动重定向）。

## 0.2.4 — 2026-09-17

修「孤立代理项」截断 bug（详见 README 第八节）：

- `preview()` / `truncate()` 改为**按码点截断**（原 `slice()` 按 UTF-16 code unit 切，emoji 落在刀口上只剩一半，会**永久毒死**调用方会话）；「已截断 N 字符」计数口径随之变为码点；
- 新增 `wellFormed()` 并消毒列表正文、export 的 md+JSON、send 的两处批准提问正文、投递到目标会话的 banner、拒绝文本里回显的 `targetId`、深链注入的会话快照与三个工具的 `output.render` 出口；
- 顺带修「resolver 省略可选 `additionalContext` 时把 `undefined` 塞进消息数组」；
- 客户端 `shortSessionId()` 改码点截断，卡片正文 / 发送方 id / 委托回退文本渲染前消毒。
- **验证**：`host-half` 新增 20 项、`client-half` 新增 11 项；把两个 lib 文件换回 0.2.3 时 host 红 13 项、client 红 5 项，换回修复版即 117 项全绿。

## 0.2.3 — 2026-09-17

适配 DSH 0.1.5 会话格式迁移：

- 投递消息 `source` 改为受审计的 `{ kind: "agent-message", form: "relay", senderSessionId }`（旧 `kind: "team-link"` 会让整份会话日志无法迁移/打不开）；
- 卡片判定改从 chat node 的 `node.id` 读消息 id（context 的 `data` 里没有 id），叠加 `slp-` 与正文 banner 双信号，避免把上游相邻代理消息误渲染成本插件卡片；
- 时间改为优先用 context node 的事件时间，正文 banner 承载投递时间兜底；
- 宿主包从 `dependencies` 移到 `peerDependencies`，区间补上 `^0.1.5-rc.1` 分支（`^0.1.0-rc.6` 按 semver 预发布规则匹配不到 `0.1.5-rc.1`）；
- 新增 `client-half.test.mjs`；导出路由文件名净化、策略写入去重。

## 0.2.2 — 2026-09-17

配对通道（双向免确认）；醒目 📡 消息卡片（keyed slot 影子渲染 + 委托回退）；消息 `source` 补 `form: relay` + `senderSessionId` 元数据。

## 0.2.1 — 2026-09-17

空闲目标投递改用 `followup` 唤醒（原 `inject` 只排队不唤醒，用户确认后目标无反应）。

## 0.2.0 — 2026-09-16

初版 fork：会话深链 + 会话列表 / 导出 + 批准式跨会话消息。

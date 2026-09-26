# dsh-team-link 与 dsh Agent Teams 的对比

> **状态**：✅ 事实核对完成（本页只写现状与差异，不含未实施的方案）· ✅ 第 7 节四问**会诊已回、用户已拍板、裁定已入档**（纪要 `docs/consult-minutes/2026-09-26-consult-9-minutes.md`；拍板结论见 §7 末）· 🚧 第 9 节仍是**未复核**的源码级线索。
>
> **出处标记（本页唯一口径）**：
> - `[实测]` = 本会话亲自核对：本仓 `lib/index.js` 行号、部署副本四个包的 `package.json`、本仓 README、`0 命中` 的 grep 读数。
> - `[README]` = 宿主**随包发布的 README 原文**（本会话逐字读过；≠ 已读源码）。
> - `[会诊]` = **会诊 #9 提供、本会话未复核**的宿主源码文件级引文（清单见第 9 节）。
>
> **版本事实（两处并列，不合并）**：部署中 profile 副本 = **0.1.7-rc.1**（`[实测]`，四个包 `package.json`）；会诊报告称宿主 checkout `app.asar\dsh\node_modules\@deepseek-ai\` 为 **0.1.7-rc.2**（`[会诊]`，本会话**无法访问该路径**，故未复核——见第 9 节）。
>
> **本插件侧出处**：`lib/index.js`（as-of 3eba6c1）、`README.md`、`docs/` 既有设计档。

## 0. 一句话

内置 Agent Teams 是**一个会话内部的团队**：Lead 会话 + 它生出来的 teammate 子代理，一个进程，一套继承来的权限 —— 管的是「同一间办公室里怎么分工」。dsh-team-link 是**会话之间的团队**：几个平级、各自独立生死的会话，靠一套显式信任关系连起来 —— 管的是「几间独立办公室之间怎么互信、怎么换人」。

## 1. 两套模型各自是什么

### 1.1 内置 Agent Teams（部署副本 0.1.7-rc.1；源码级引文见第 9 节）

- 团队 = 一个 Lead 会话 + 它创建的具名 teammate。`TeamId` 就等于 Lead 的 `SessionId`，**没有「创建团队」这一步**：第一条成员/消息/任务记录就是团队的诞生。`[README]` 核心 README「Team 身份与 roster」\| `[会诊]` `lib/types/types.js`（`TeamId(id) = id` 恒等）、`lib/types/roster.js`（`tryMembership`：header 带 `parentSession` 的 direct child 才是 teammate）。
- teammate 是**子代理**：fresh（不带 Lead 记忆）或 fork（继承 Lead 已完成轮次）；名字永久保留、永不复用。`[README]` 核心 README「Teammate」\| `[会诊]` 名字规则：lower-kebab-case、≤64 字符、`lead` 保留、失败成员也占名额（`roster.js` `TEAM_MEMBER_NAME_TAKEN`）。
- 协作账本（`team/member`、`team/task`、`team/message/queued|delivered`）只写进 **Lead 会话日志**，「从不进入会话表面」，因此**不占模型 token**；读的时候按需回放成快照。`[README]` 核心 README「模型体验」\| `[会诊]` `lib/types/journal.js` 注释原文 "Team events never enter the conversation surface"。
- 消息走**持久邮箱**：先 flush `queued` 再投递，只有目标确实持久持有该消息身份才记 `delivered`；崩溃/重载后按序重投未投递的 —— **不丢不重**。`[README]` 核心 README「持久 mailbox」并明确：该保证是**进程内**重试加目标会话去重，**不是**跨进程 exactly-once。上限：每目标待投递 64 条、单条 64KB。`[README]` 最小工作配置表\| `[会诊]` `lib/types/mailbox.js`、`lib/types/invariant.js`。
- 九个工具 Lead 与 teammate 完全相同：`spawn_teammate` / `send_message` / `list_agents` / `wait_agent` / `interrupt_agent` / `team_task_*`×4；工具的模型面 target 是**成员名**而非会话 id。`[README]` 工具包 README「模型能做什么」\| `[会诊]` spawn/interrupt 在服务层强制 Lead-only。
- `wait_agent` 只回答「有没有变化 / 或超时」，**不带任何内容**，调用方随后自己重读状态；时长 10s–1h，无活跃 peer 时给 `noProgress` 短路。`[README]` 工具包 README「成功与失败的表现」\| `[会诊]` `lib/types/activity.js`、`WAIT_VALUE_SCHEMA`。
- 官方明确的**不支持面**：teammate 需要独立工作目录、**多个进程协调同一支团队**、任务 owner 自动释放；同源限制还有「扁平且不可变的 roster」与「单进程、共享 checkout」。`[README]` 核心 README「何时选择」「已知限制与延期工作」。
- 定位：**实验性，不承诺稳定性**，孵化期 schema 可自由变更。`[README]` 核心 README「已知限制」原文：「实验原型，无稳定性承诺——孵化期间约定仍可自由变更」。
- 投影与界面：协作记录「从不进入会话表面」，但成员身份与阶段会作为**会话投影**（`agentTeam`）发布给客户端，官方 Team 面板读它。`[README]` 核心 README「浏览器投影」。

### 1.2 dsh-team-link（本仓，`[实测]`）

- 团队 = `teams` 键里的一条记录：团队名 → 角色 → **会话**，带版本史（退役 ≠ 删除），落盘在插件 settings，**不挂在任何会话身上**。
- 成员是**对等会话**：各自独立的 agent 循环、各自的 UI 窗口、各自生死。
- 有**显式信任模型**：双门批准（发送方 + 接收方各一次）、配对通道、一次性令牌换届、退役者信任对称吊销、24h 可回退。
- 有**跨会话看门狗**：盯住别的会话，对方失联而观察者空闲时，向观察者**自己的**会话投一条 tick（正文为插件常量）。
- 黑板：`decisions.md`（只追加裁决账本）+ `discipline.md`（整文件替换，乐观锁）。
- 明确不做：会话内自 tick 定时器、进模型上下文的共享总线、自由 mesh、跨会话分布式锁、自动派活协商、sidecar 索引。

### 1.3 常规 agent team 框架（对照位，**一般性描述，未逐版本核实**）

拉进来做参照：多数 agent 编排框架把多个角色塞进**同一个进程、同一个编排器**里，成员之间靠函数调用或共享 memory 传消息；成员通常没有独立会话、没有跨进程信任问题，团队随主程序生死。它们与本仓的差别，与第 3 节那三条结构性原因同源。

## 2. 逐项对照

| # | 维度 | 内置 Agent Teams | dsh-team-link | 依据 |
|---|---|---|---|---|
| 1 | 团队边界 | Lead 会话 + 其子代理，单根树 | 平级会话之间，无父子 | `[README]` 核心 README「Team 身份与 roster」/ `[实测]` 本仓 README §四 |
| 2 | 身份与家谱挂在哪 | Lead 会话日志（`TeamId = Lead SessionId`） | 插件 settings 的 `teams` 键 | `[README]` 同上 / `[实测]` 本仓 README §四 |
| 3 | 一起死还是各自死 | 运行时 dispose（HMR/进程关闭）释放 roster 里 live 的 direct child 及其后代；**Lead 的非 Team continuable child 不受影响** | 每个会话独立生死；角色由 roster 指向某个会话 | `[README]` 核心 README「Dispose」/ `[实测]` 本仓 README §五 |
| 4 | 换人（现任死了/废了） | **没有换届概念**：持久状态要有人重开 Lead 会话才回放得动；恢复只对账未终结的 provisioning 成员 | `revive` / `reappoint` 两个封闭动词 + 令牌换届 + 信任迁移 | `[README]` 核心 README「Team 身份与 roster」「持久性模型」/ `[实测]` 本仓 README §五、§十 |
| 5 | 跨进程 | 官方不支持（「多个进程需要协调同一支团队」→ 不要选择）；保证是进程内重试 + 去重，非跨进程 exactly-once | 跨会话、跨进程是它的全部意义 | `[README]` 核心 README「何时选择」「持久 mailbox」 |
| 6 | 信任 | **没有独立信任**：每个服务方法都接收确切的实时调用方 `Agent`，只有 Lead 能 spawn / reassign / interrupt | 双门 + 配对 + 令牌 + 对称吊销 | `[README]` 核心 README「显式权限」/ `[实测]` 本仓 README §一 §五 |
| 7 | 投递面（能发给谁） | 成员名（进程内 mailbox；离线排队、恢复后到达）；**模型面 target 是名字，不是会话 id** | **仅根代理**：子代理不是可投递目标 | `[README]` 工具包 README「模型能做什么」/ `[实测]` lib/index.js:3441-3470、:3548-3550 |
| 8 | 消息会不会丢 | 不会：持久队列，不丢不重，离线成员恢复后收队列（**进程内保证**） | **未投递即退出、内容不保留**，靠发送方善后 | `[README]` 核心 README「持久 mailbox」/ `[实测]` 本仓 README §一 |
| 9 | 状态变更的 token 成本 | **零**（账本只进日志、不进模型历史） | 没有独立状态面：状态只能靠「发一条消息」表达 | `[README]` 核心 README「模型体验」/ `[实测]` 本仓现状 |
| 10 | 共享工作台 | 任务板：CAS revision · 依赖 DAG · owner · 写作用域重叠警告（八种动作，reassign 仅 Lead，delete 有依赖者拒绝） | **没有任务板**：只有 decisions 账本 + discipline 纪律 | `[README]` 核心 README「共享任务板」+ `[会诊]` `task-board.js` 动作表 / `[实测]` 本仓 README §四 |
| 11 | 唤醒机制 | `wait_agent`：只回「有无变化/超时」，**不带内容**（10s–1h） | `team_link_watch`：向观察者自己的会话投一条常量 tick | `[README]` 工具包与核心 README / `[实测]` 本仓 README §三 |
| 12 | 人看到的界面 | 成员列表 + 共享任务看板 + 可打开成员会话 | 会话列表弹窗 + 消息卡片 | `[README]` profile README「获得的功能」/ `[实测]` 本仓 README §二 |
| 13 | 人要不要在环 | 不要：Lead 即授权者（但组合包**默认关闭**、需人先开启；固定策略要求用户明确请求才建 teammate） | 要：唯一的新授权点是**人类点击**（fail-closed） | `[README]` profile README「仅显式启用」+ 工具包 README「何时选择」/ `[实测]` 本仓 README §五 |
| 14 | 规模上限 | `maxMembers=16`（失败成员占名额）、`maxTasks=256`（部署期校验的配置默认） | `list_sessions` 只并行读**前 12 个**会话，第 13 行起活性未判定 | `[README]` 核心 README 限制表 / `[实测]` lib/index.js:116 |

## 3. 差异是结构决定的，不是口味

三条原因，前一条比后一条更硬：

1. **身份挂在哪**：内置挂在 Lead 会话（`TeamId = SessionId`），本插件挂在插件 settings。→ 决定了「Lead 换人」这本账**谁记得了**。
2. **进程边界**：内置在单进程内（官方明说），本插件跨会话跨进程。→ 决定了权限能不能继承：同一进程里的父子可以继承，跨进程的平级不行。
3. **权限模型**：内置的 child 没有独立身份，所以**不需要**信任；本插件每个成员都是一个独立 root，所以**必须**显式建立信任。

推论：把任一条差异当成「谁更好」都会走偏。它们的适用面是**正交**的。

## 4. 我们不可被替代的地方

1. **跨进程 / 跨团队 root 的协调** —— 内置官方划出界外的那一格。
2. **平级会话之间的信任** —— 双门批准、配对、对称吊销；内置没有对应物（它不需要）。
3. **身份的生死与任何一个会话脱钩** —— 换届换人、退役留痕、家谱可查，不依赖某个会话被重开。
4. **人在环的授权点** —— 换届与恢复都要人点一下；内置刻意不做（Lead 即授权者）。
5. **不需要对方配合的活性信号** —— verdict 五态 + 静默时长 + goal 状态，看的是「别人有没有在动」。

## 5. 内置值得我们学的五点（只记事实与判断，不含已决定的方案）

1. **状态与内容分开**：账本进日志、不进上下文 → 状态变化零 token；本插件的「状态」只有消息一种表达方式。`[README]` 核心 README「模型体验」。
2. **拉取代替推送**：读的是当前快照，而不是重放全部事件。`[README]` 核心 README「等待与中断」：等待只报告是否超时，调用方随后重新读取当前状态。
3. **闹钟不带内容**：唤醒与内容解耦（`wait_agent` 只回答有无变化）。`[README]` 同上。
4. **持久邮箱**：不丢不重、离线可收；本插件投递失败即退出。`[README]` 核心 README「持久 mailbox」。
5. **共享任务板**：CAS revision、依赖、写作用域警告 —— 外置的「我们在干什么」。`[README]` 核心 README「共享任务板」。

## 6. 两套共存时的边界（现状 + 三件候选小事）

**现状**（都可验证，`[实测]`）：

- 本插件投递面**只列根代理**：拿 teammate 的会话 id 去发会被拒（`lib/index.js:3548`、`:3550`）。文案已说明「可能是子代理」，但**不指出它的 Lead 是谁**，也不给替代路径。
- 本插件的会话/团队视图**完全不提**宿主那套：核对（2026-09-26，范围 `lib/`、`README.md`）时，`spawn_teammate` / `Agent Teams` / `team_task_` / `list_agents` 四个词 **0 命中**——本页是仓库里第一次提到它们。
- 模型在一句话里同时握着两套工具，而没有任何一处告诉它该选哪套。

**三件候选小事**（未实施，待裁定）：

1. 一张「什么时候用哪套」的判定表（本页即素材）。
2. **拒绝时指路**：说清目标属于哪支 Agent Team、它的 Lead 是谁、该怎么转达。
3. **界面互指**：本插件的会话列表里标出「这个会话是一支 Agent Team 的 Lead（N 个成员）」。`[README]` 宿主把成员身份作为 `agentTeam` 会话投影发布给客户端；该投影能否被本插件客户端读到 —— `[会诊]` 称已核实可读（链路：API 会话帧 → 客户端 sessions store 的 `projectionsBySession[sid].values` → 官方面板 `client.js:239`），**本会话未复核**（见第 9 节）。前提：宿主启用了 Agent Teams 组合包；本插件客户端目前未接入该 store。

## 7. 待决议题（会诊回，裁定层待本仓流程回填）

- **Q1 任务板 + 多消息队列如何映射**：状态归谁？如何避免任务板沦为唯一事实源？共享状态如何做到**可反驳**？→ 会诊 2/2 主张：**做台账、不抄 CAS 看板**；台账＝只追加 + 带署名 + 可反驳即同一条写入路径；映射用既有 `meta.ref` 约定，不建物理队列。范围变更（新增第三个黑板文件）待用户点头。
- **Q2 投递要不要持久队列**：→ 会诊 2/2 明确**不做**，写成「有意识的分道」；理由之一：排队消息可能在换届/吊销**之后**送达，信任决策针对的是过去的时刻。翻案前置条件见纪要 §2 #13。
- **Q3 团队形态由人随时切换**（多会话 ↔ agent team，可来回切）：→ 会诊 2/2 主张：名册**必须分区**、agent-team 形态下只存**指针**、拒绝时**刺眼**、对宿主团队**只读不写**；切回多会话时**信任不自动回迁**。
  - **用户口径（2026-09-26，裁定输入）**：形态是**团队级**属性，不是派活时的按任务通道 —— ① 可一开始就指定「这个团队用 agent-team 形态」；② **多会话不可用**时由人**主动**切过去；插件只报「多会话通道不可用，你可以切」的诊断，**绝不自动切**。
- **Q4 主会话并发接多路回报 + 人持续新输入**：→ 会诊 2/2 主张**本轮零新机制**，只做三件约定（派活即落账 / 回报必带 `ref` / 协调员纪律写进 `discipline.md`）；**明确不做**自动合并摘要、不改拉取、不做人类分拣台 —— 合并器＝无署名二手摘要，会直接杀死会话间的互核。

**用户拍板（2026-09-26，三项全按建议）**：① 台账新增第三个黑板文件 `tasks.md`（与 `decisions.md` 同构：只追加 + 读时投影，**不做状态机**）；② 形态切换＝「人说一声 → 人类确认框 → 落笔 + 模式史留痕」，设置 UI 永远可作兜底，**无确认服务即 fail-closed**；③ teammate 的成果收尾走**提示式**（列出未外化的成果，不阻断切换）。方案本体见 [`team-ledger-and-mode-design-2026-09-26.md`](team-ledger-and-mode-design-2026-09-26.md)（状态：**已拍板、尚未实施**）。

留档口径：纪要落 `docs/consult-minutes/2026-09-26-consult-9-minutes.md`（§2 逐条处置 19 条 · §3 父侧裁定 · §4 教训 · §5 不可验清单）；本页第 7 节只做摘要，裁定以纪要为准。

## 8. 本页不写什么

- 不写未实施的方案：第 6 节三件小事与第 7 节四问的结论都只是**候选 / 会诊主张**，尚未落码。
- 不写「内置不好」：两者解决的问题不同，第 3 节已说明差异是结构性的、适用面正交。
- 不把宿主**源码级**结论写成事实：本页标 `[README]` 的行只保证「随包 README 是这么写的」；标 `[会诊]` 的行**本会话未复核**。源码级结论的独立复核见第 9 节待办。

## 9. 会诊 #9 提供的源码级线索（**未复核**）与一处版本冲突

会诊 #9 的一份回复（`deepseek-official:deepseek-v4-pro`）给出了宿主 checkout 的文件级出处，并**越界改写了本页**（会诊契约为只读）。本会话的处置：**不采用它改写的正文**，只把它的出处作为**未复核线索**留在这里，供后续独立复核。

**线索清单**（未复核）：`lib/types/types.js`（`TeamId` 恒等）、`roster.js`（`tryMembership` / `TEAM_MEMBER_NAME_TAKEN` / `TEAM_LEAD_REQUIRED` / `recoverFor`）、`journal.js`（"Team events never enter the conversation surface"）、`mailbox.js`（`sendAdmitted` / `checkpointDelivered` / `recoverFor`）、`invariant.js`（delivered-twice 违反）、`activity.js` + `WAIT_VALUE_SCHEMA`、`task-board.js` / `task-graph.js` / `task-view.js`、`types/index.js`（`disposeRuntime` / `DEFAULT_MAX_MEMBERS` / `DEFAULT_MAX_TASKS`）、工具包 `lib/index.js`（`install()` 作用域注册 + POLICY）、客户端投影链路 `dsh-client-ui-workspace/lib/client.js:448` 与 `dsh-experimental-client-ui-agent-team/lib/client.js:239`。

**版本冲突（未解）**：该回复称宿主 checkout 的四个包为 **0.1.7-rc.2**；本会话实测**部署副本为 0.1.7-rc.1**（`[实测]`，四个 `package.json`）。本会话**无法访问** `D:\DSH-Desktop\resources\app.asar\dsh\` 做复核（read 报内部错误、rg 报路径不存在）。**在复核之前，本页一律以部署副本 rc.1 为准。**

**已由本会话独立佐证的少数几条**（不是靠该回复，而是随包 README 原文）：dispose 只释放 live direct child 及其后代、非 Team continuable child 不受影响；「不丢不重」是进程内保证、非跨进程 exactly-once。这两条已并入第 2 节并标 `[README]`。

**另案**：该越界写入直接造成本会话的一次编辑冲突（`FS_STALE_VERSION`）。属平台侧问题（consult 子进程的工具面是否收窄），记入纪要 §4 教训与 §5 不可验清单。

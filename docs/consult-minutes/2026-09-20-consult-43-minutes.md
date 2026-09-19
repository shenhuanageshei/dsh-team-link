# 会诊纪要 —— consult #43（原始层，机制落盘）

- 日期：2026-09-20
- 会诊 id：43
- 模型：deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, codex-cli:gpt-6-astra, kimi-api:kimi-k3
- 平台 job：consult-4
- 结果：3/4 交付（其中 3 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #43 finished — 3 of 4 replied (1 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #43 finished — 3 of 4 replied (1 failed)]
effective: 3 of 4 (1 failed · 0 without content)
models: deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, codex-cli:gpt-6-astra, kimi-api:kimi-k3
job: consult-4
minutes: docs/consult-minutes/2026-09-20-consult-43-minutes.md
requiresReport: true
exemption: unattended — 用户 2026-09-20 00:1x 明言“我睡觉了，你继续推进”，并授权睡觉期间自行推进；期间无人可汇报，故会诊 digest 到达后按 unattended 豁免继续推进而非停下等批示。所有处置仍会逐条写入纪要裁定层 §2–§5，用户醒来后可见。

--- replies (raw, unjudged — verify with your own tools) ---

[1] codex-cli:gpt-6-astra — failed
(consultation failed: codex-cli PROCESS_ERROR: codex 进程失败（非零退出且无有效输出）)

[2] zai-coding-cn:glm-5.3 — ok
# §11 自动换届交接 · 三问设计评审（只读）

先交代我核过的证据面：`writerGate`/`retireGate`（lib/index.js#L1746-L1778）、M4 全量 rotation 控制器（prepare/claim/replayClaim/sweep，#L4605-L5016）、`deliverToTarget` 的死目标守门与 no-agent 修复文案（#L2909-L2962）、`teamMembers`（#L4247）、看门狗可 tick 判据含 `dead`（#L117）、§3.6 主设计、§10.2/§11 增补设计、README 的「空缺全拒 + 设置 UI 超级写者」语义（README.md#L450-L454）、`dsh-commands` 的 `CommandResult`/`command/run|done`「log-only, never model surface」（types.d.ts#L33-L53、types/types.d.ts#L100-L119）、`dsh-agent` 的 `Agent.followup`/`AgentRegistry`（runtime-types.d.ts#L176-L210、index.d.ts#L130-L199）。以下每个判断都锚在这些面上。

---

## Q1【角色现任无人】自愈 / 可诊断 + 一键恢复

### 0. 事实核对（比题设略乐观的两点，先摆出来）

- **死结是「写死」不是「通讯死」**：投递路径（send/pairs/内部通知）不过 `writerGate`——团队还能说话，只是 roster/黑板写不进。诊断面要把这个差别说出来，避免成员误判为全瘫。
- **死法有时序三分**，其中一种已有出口：incumbent 死在 **prepare 之后、claim 之前** 时，claim 的门只看「caller === pending.session + 令牌」（#L4738-L4743），**不看旧任活性**——继任者照样 claim，换届照常落定，团队自然解锁。真正的死结窗口是：死在 prepare 前（无令牌）、令牌 30 分钟过期被清扫（current 回指死者）、死在 claim 落定后（本问主案）。

### ① 要不要显式「vacant-due-to-death」状态？——**不要持久化状态，要「读取时判定 + 命名诊断」**

理由三条，每条都来自既有不变量：

1. **roster 是记录，不是活性镜像**。既有原则「a dead member keeps its no-agent row — the roster is the record」（#L4523）已经裁过一次：活性是移动快照（读数 2 分钟即陈旧），把「死」写进 roster 等于把陈旧当事实落盘。
2. **插件重载会集体翻状态**。§10.2.5 声明卸载/重载 = 全队 teardown；若死亡要落盘，一次重载会把所有插件属会话的角色全部写成 vacant——而其中大部分下一分钟就能被人在侧边栏点开复活。自动写入破坏的恰恰是最容易恢复的路径。
3. **「刻意空缺」与「死亡空缺」语义必须可分**。`current=null` 是用户在设置 UI 里的**显式表达**（README：「手写出来的空缺行仍然全拒——那是用户显式表达的状态」），其错误文案指引「去设置 UI 指定现任」；死亡空缺的正确第一动作却是「**在侧边栏点开那个会话**」。合并两者会让两种场景都拿到错误指引。

**做法**：活性判定复用 `ctx.agents.get(incumbent) === undefined`（与 verdict=dead 同源），在**两个读取面**命名它——(a) `roster get` 的工具返回里，coordinator 现任无活代理时加一行「⚠ 现任无人（vacant-due-to-death）：建议先在侧边栏重新打开该会话；或 team_link_roster action=recover（需确认）；或设置 UI 手改」；(b) `writerGate` 拒绝文案的**调用方富化**（gate 本体保持纯函数，由有 ctx 的工具层传入 incumbent-dead 标志），把「只有现任可写」升级为「现任无活代理，这是死亡空缺，恢复梯子见 …」。roster.md 镜像刻意**不**加（它是状态渲染，不是活性渲染，维持纯度）。`list_sessions` 已天然标 dead，零新增。

### ② 谁有权恢复——**三级恢复梯子，人在环是唯一新授权点**

| 梯级 | 动作 | 授权来源 | 代价 |
|---|---|---|---|
| **R0 重开** | 人类在侧边栏点开死亡现任的会话 → 同 id 复活 → `writerGate` 按 id 比对直接放行 | 纯 UI 动作，零插件参与 | 一次点击；信任/pairs/身份**全保留** |
| **R1 recover 动作** | `team_link_roster action=recover, team, target=<存活成员 id \| "vacant">` | **人类确认框**（userQuestions，fail-closed） | 身份换人，信任**不迁移** |
| **R2 设置 UI** | 手改 teams 键（现状已有的超级写者） | 人类直接编辑 | yaml 手工，无审计增强 |

- **旧任不能恢复**：它的信任已被对称吊销、已不是任何角色的 current——让它凭「我以前是」复权，等于让换届变成「可逆于一次死亡」，这正是 rotation 要消灭的「退役者永久保送」的变体。它仍可当**信使**（普通过门投递提醒人类），但无特权。
- **不需要「临时复权令牌」**：令牌是无人在环的承载凭证，而本场景**本质上必须有人在环**（见④的 A4 论证）——一个绕过 writerGate 的 bearer capability 且无人类门，恰好是后门的形状。确认框本身就是授权，令牌是多余的秘密面。
- **发起权**：限**本队存活成员**（`teamMembers(team)` 里的活代理）。它们是撞墙的人；非成员无合法利害，让它走 R2。

### ③ 防后门（最担心的一条）——六条性质，核心论证是一条

**核心论证：任何「人类确认框把关」的动作，其权限上界就是设置 UI 超级写者**——后者本来就能改一切且无审计。R1 只是把既有的人类权限收窄成一个更窄、更可审计、更顺手的形式，因此它**不可能新增**后门；后门只可能来自绕开人类的那部分。据此：

1. **触发条件由宿主观测，不由调用方主张**：recover 执行时插件自己重查 `ctx.agents.get(incumbent) === undefined`（确认框弹出时与**落笔写入前各查一次**）。现任活着 → 条件不成立 → 拒绝。于是它**无法替代** set-role/rotation 成为换人旁路。
2. **无人类确认服务 → fail-closed 拒绝**，且**刻意不设 provisional 无人值守变体**（与 M4 claim 的关键差异，必须写进设计）：rotation 的 provisional 之所以敢无人值守，是因为 pair 迁移可被 sweep 自动回退；而 incumbency 不可自动回退——错误现任写下的黑板/roster 已成事实，回退撤销不了已发生的写。授予可逆才能无人值守，身份不可逆所以必须人在环。
3. **窄域**：只动 coordinator 一个角色；target 只能是**当前存活的本队成员**或显式 vacant；不迁移任何信任（新任从首问门起步，要全量信任事后走正式 rotation）；不改 policy。
4. **复用反风暴**：沿用 10 分钟速率限制形态；幂等判据 `current === target` → 重放返回既有结果不重复写（对齐 replayClaim 的判据风格）。
5. **审计**：闭 tenure 记 `note: recovery(vacant-due-to-death, requester=<id>)`；写前快照进 `rotationBackup`（对齐「任何时刻可一键撤销」原则 4）；向成员广播一条**固定文案**内部通知（沿用 rotation 通知路径——它是投递消息，不是新日志事件类型，不踩 §10.3 红线）。确认框正文必须三方具名：死亡的现任 id、发起成员 id、拟任 id。
6. **对称撤销做成可选项**：确认框加一个勾选「同时清理死任的 pairs/trustedSenders/rememberTargets」（默认勾选，复用 `applyRotationTrust`，successor 置空）。不勾的情形留给「打算重开死者」的人类。不自动吊销的理由：R0 路径下那些通道还有用；但默认勾选保住 §3.6.1 原则 3 的对称性，不让每次死亡恢复都漏出僵尸通道。

**滥用面分析**：模型层无法伪造条件（没有任何工具面能杀别人的 agent——`agent.cancel` 是句柄能力，不经模型暴露）；能让现任死亡的唯一现实途径是插件重载/关壳，这本身已是人类/配置动作，其后还要过一次人类确认框——攻击者需要的社会工程成本已高于「直接骗人在设置 UI 改现任」。残余风险收敛为**确认框文案的清晰度**。

### ④ 失败模式与边界

| # | 场景 | 行为 / 边界 |
|---|---|---|
| F1 | 死在 prepare→claim 窗口内 | **不适用 R1**：继任者直接 claim 即解锁（见 0）。令牌过期被清扫后 current 回指死者 → 才进 R1 |
| F2 | 确认框期间现任被重开复活 | 写入前复查找活 → 中止并报告「现任已复活，无需恢复」。残余竞态（复检后、落笔前一瞬复活）：后果 = 一次人类确认过的 re-point 落地，历史有注，非安全洞，可用 set-role 纠正 |
| F3 | target 在确认与写入之间死亡 | 写入前复检 target 活性，死则拒绝（否则原地再造一个死结） |
| F4 | 无人在场（夜间） | R1 fail-closed；团队进入「可通讯、不可写」的等待态。**这是刻意取舍**：A4（死会话只有人能唤醒）+ 写不可逆 ⇒ 恢复天然是人的动作。缓解是**诊断的可达性**：现有 watchdog 本就把 `dead` 列为可 tick 判据（#L117）——成员盯协调者，死后收到 tick、去写、撞见命名过的拒绝文案、去唤人类，整条发现链零新机制 |
| F5 | 全员皆死（重载团灭了插件属会话） | 没有活发起者，R1 够不着——指引降级为「在侧边栏打开任意一个团队会话」（打开死亡现任本身 = R0，直接解锁）。这条必须写进文档 |
| F6 | 该角色 pending 未过期 | 拒绝并告知道期时间（≤30 分钟），先让 sweep 清（recover 入口本身已挂在「每次 roster 触碰先 sweep」的钩上，真正阻塞的只有未过期窗口）。避免与在飞令牌互踩（P3 的教训：身份显式变更要杀令牌，反之亦然） |
| F7 | `writer=any` 的队 | 无死结，recover 拒绝并指出「用 set-role 即可」 |
| F8 | 死的是非 coordinator 角色 | 无写死结（writerGate 只看 coordinator）；send 走 `team:<name>/<role>` 别名吃到 no-agent 拒绝文案（已含「侧边栏重开」指引，#L2917-L2921）。活协调者可 set-role 换人。R1 明确只管 coordinator |
| F9 | 死继任者 + provisional 已回退 | sweep 仍会滚回 pairs（插件内写不过 writerGate），但 rotation-expired 广播的发送方 = 死者 → 各接收端按 refused/no-agent 落行——**通知面部分缺发是既有语义**，文档如实声明；roster 仍指向死者 → 进 R1，恢复后可再走正式 rotation |
| F10 | 两个成员同时请求 | 两次确认框；第二笔写入发现 `current` 已变 → 幂等报告。速率限制兜底 |

**净结论（Q1）**：不新增持久状态、不新增传感器、不新增令牌；新增的是「**读取时的命名诊断 + 一个窄域、人类确认、fail-closed、幂等、限速的 recover 动作**」，外加把既有 watchdog-dead-tick 与 no-agent 文案串成发现链。与 §10.3 红线全部相容（无 schema 改动、无新日志事件类型、inject 不动）。

---

## Q2 交接文档的内容契约

**原则先行**：§3.6.2 的「机制与判断分离」在这里的落法是——**插件只能把关结构（节在场、非空、有界），不能把关内容质量**。契约 gate 的是「沉默缺项」，不 gate「写得烂」：缺项是静默失败的来源，烂文是可见的、继任者可以质疑的。这条要诚实写进设计（presence 门防遗忘，不防敷衍）。

### 字段级最小结构

**头部元数据（插件写，§11.4.3 已有，补两个字段）**：team / role / from（旧任 id）/ to（继任者 id）/ 时间 / 令牌掩码 / **contract 标记**（`v1(mission|in-flight|commitments|unknowns)`，给未来读者一个可验证的节清单）/ **完整性判定**（哪些硬节在场、哪些软节缺——审计面）。

**正文（旧任模型提供；同一份文本同时是 followup 投递物，验证只做一次）**，四个**硬节**：

| 节 | 内容 | 为什么缺了会丢关键上下文 |
|---|---|---|
| `mission` | 该角色对团队负责什么（1–3 句） | roster 只有角色名，没有角色**意义**；缺了 = 继任者不知道自己的职责边界 |
| `in-flight` | 在飞工作清单，每项：事项 / 相关成员 / 当前状态 / 下一步 | 这是交接的本体；机器状态（黑板/goal）只有碎片，缺了 = 在飞工作被静默丢弃——换届最贵的事故 |
| `commitments` | 未兑现承诺（对成员或人类的） | 承诺活在旧任的工作记忆里，任何盘面都查不到；缺了 = 团队信用无声违约 |
| `unknowns` | 我不知道/没覆盖什么（负面空间声明） | 把「沉默」变成信息：缺了 = 缺席被误读为完备 |

三个**软节**（缺则警告，不拦）：`first-actions`（有机器兜底——prepare 返回文案已注入「goal resume/新建 goal」建议，§3.6.2）；`team-map`（黑板已承载大半）；`conventions`（团队纪律与伤疤，E4 所说最贵的重建物，但无法机器判定其在场价值）。

### 缺项处理阶梯（关键：验证点必须在**任何副作用之前**）

| 情形 | 处置 |
|---|---|
| `successor:"auto"` + handoff 缺失/为空 | **拒绝于工具入口**（零建会话、零令牌、零 freeze）——错误文案里给出四硬节的脚手架模板，模型一回合可自纠。理由：auto 路径造出的是零上下文的全新根会话，handoff 是它得到的**全部**；空 handoff 的自动换届 = 造一个失忆的持钥者，比拒绝更糟 |
| handoff 在，硬节缺 | 同上拒绝，点名缺哪些节 |
| 软节缺 | 放行；prepare 返回列警告，头部元数据记录 |
| 显式 successor（既有会话）+ 无 handoff | **放行 + 警告**（M4 现语义不回收紧——那个会话有自己的生命与上下文，钥匙交接是合法低配）；不写文档文件，prepare 返回如实说明 |
| 硬节在场但明显薄（如 mission < 20 码点） | 警告入档，放行——判断归模型 |
| 文档写入失败（auto 路径） | **abort-before-prepare**：不铸令牌、不广播 freeze，已建会话按 §11.5 如实报告为孤儿。理由：文档落档是你方 2026-09-19 的显式决策，且这是全流程最便宜的干净失败点（§11.3 时序里写文档本就在 prepare 前） |
| claim 时 | **不复验文档**（它是审计件不是执行件）；claim 不因文档被删而阻塞 |

**残余失败模式**（如实声明）：① 模型用套话灌满硬节过门——presence 门防不住，缓解是文档对继任者与人类可见、可质疑；② 正文超长——followup 携带头部 + 截断标记 + 「余文见 `<路径>`」（继任者是根会话，有文件读权，这条退路干净）；③ 节标记必须用**稳定常量**（如固定小节名），校验按标记匹配、内容任意语言。

---

## Q3 H3 的退路

### 0. 事实核对（H3 的风险面比文档写的窄）

- `CommandResult` 只进 UI、`command/run|done` 是 log-only never-model-surface——**已证**（types.d.ts 原文）。
- `CommandInvocation.agent` 是完整 Agent（含 followup/steer）——**已证**。
- `Agent.followup` 是普通方法，接口层**没有 self 禁令**，且「A wake submitted while already idle always opens its turn boundary」（runtime-types.d.ts#L176-L192）——所以 H3 的悬念不在「允不允许」，在**回合与来源语义**：自发源消息（`senderSessionId=` 自己的三成员 source）模型读起来是否自然、命令 handler 的 UI 请求链与被唤醒回合的交错是否干净（followup 不吃 `invocation.signal`，回合与 UI 请求解耦，这点反而安全）。冒烟一次的成本很低，**首选仍是照 §11.2 实施 H3**。

### 1. 你提议的拆分（命令做机械、正文下回合补）——**依赖一个唤醒信道，先把它拆出来**

「旧任模型下一回合补上」需要有人唤醒旧任。只有三个信道：

| 信道 | 性质 |
|---|---|
| self-followup | **就是 H3**，循环依赖，不算退路（steer 同理——任何「命令 handler 自驱」都落在同一条待验假设上） |
| 人类粘贴一句话 
… [reply capped at 8000 chars — the uncapped text is in the minutes' §1.1]

[3] deepseek-official:deepseek-v4-pro — ok
评审材料已全部读完：插件实现（`lib/index.js` 5560 行，rotation 控制器 / writerGate / retireGate / list_sessions）、`docs/collab-enhancements-design-2026-09-19.md` §11 全文、主文档 §3.6、以及 DSH 源码侧的 `dsh-commands`（CommandResult）、`dsh-agent`（AgentHandle / create / resume / followup 运行面）。以下是只读评审。

---

# §11 评审：三个设计问题（只读评审）

**依据**（均逐行核对）：[lib/index.js](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js)（重点行见各条）；[collab-enhancements-design-2026-09-19.md](D:/DSH-Portable/plugins/dsh-team-link/docs/collab-enhancements-design-2026-09-19.md) §11；[team-upgrade-design-2026-09-17.md](D:/DSH-Portable/plugins/dsh-team-link/docs/team-upgrade-design-2026-09-17.md) §3.6；[dsh-commands types.d.ts](D:/DSH-Portable/profile/profiles/web/node_modules/@deepseek-ai/dsh-commands/lib/types/types.d.ts)；[dsh-agent index.d.ts](D:/DSH-Portable/profile/profiles/web/node_modules/@deepseek-ai/dsh-agent/lib/types/index.d.ts) 与 [runtime-types.d.ts](D:/DSH-Portable/profile/profiles/web/node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts)。

**先修正问题陈述里的一处前提**：砖态范围不是「roster/黑板全卡死」。`team_link_team_append`（decisions 追加 / discipline 整文件替换）**不过 writerGate**——工具描述自己写明「写黑板没有权限门」（:2270），代码里也无 gate 调用（:2333-2364）。所以「现任死亡」卡死的是：roster 变更（set-role/retire/既有团队 upsert）、换届（prepare/claim）、`/team_session` 登记。团队仍可经 decisions.md（追加型账本）与 `team_link_send`（过正常门）通讯。这影响 Q1 的机制设计（审计可落黑板、诊断可借黑板），也在 Q1③ 中用来防止「顺手给黑板加门」式的范围蔓延。

---

## Q1 角色「现任无人」的自愈（最重要）

**问题确认无误**：claim 落定是**永久**的——`settleRotation` 把 `current = pending.session` 写进同一笔 settings 更新（:4382-4403），且 M4 的 24h 回退**明确保留新任 current**（`expiredNotice` 原文「仍为 current（换届事实已成立，降格需用户显式操作）」:4464-4467）。此后若继任者死（或插件重载拆掉全部插件自建代理），`writerGate` 只认 `caller === incumbent`（:1756-1757）——一个死会话永远满足不了这条 ⇒ 会话路径全部拒绝。**前提成立**。

### ① 显式状态 vs 读取时判定：不新增持久状态，但把「读取时判定」升级为「在每个决策点判定」

| 判据 | 结论 |
|---|---|
| liveness 的性质 | `ctx.agents.get(id) === undefined` 是**进程内、瞬态、观察者相对**的事实（插件自己的 live registry；DSH 官方也声明 "Ambient presence is neither liveness proof nor authorization"，dsh-agent index.d.ts:193-197）。把它持久化 = 把一次观察写进事实源 |
| 持久化后的失效模式 | 插件重载后**全体**自建会话都 dead（§10.2.5 生命周期事实）——持久标记会全体变「vacant-due-to-death」，且**没有可靠的清除者**（谁负责把「已复活」写回去？复活与清标记之间的竞态怎么定？） |
| 与 schema 红线的关系 | roster 的 teams 键住在 settings 命名空间、经 schema 往返；加字段 = 改 schema = 踩 §10.3「schema 不改」红线，而且该命名空间**用户可手改**——一个用户可改的持久观察字段不提供任何完整性 |
| 既有词汇已够区分 | roster 已有「vacant」（`current=null`，retire 有意制造，:1875-1885）承载**有意空缺**；「seated-dead」（current 非空但无活代理）与它的区分**在读取时用既有 dead 判定即可派生**，不需要第三个持久状态 |

**结论**：不加持久状态。但「靠 list_sessions 判定」不够——list_sessions 是**人去看才存在**的诊断面，而砖态的第一次暴露通常是**某次被拒绝的写**。所以做三件事（都是渲染/文案层，零 schema 变更）：

1. **三个决策点渲染活性**：`roster get` 与 `roster.md` 镜像的「现任」行、以及 writerGate/rotateGate/retireGate 的**拒绝文案**，都附上活代理判定。今天这三个拒绝文案对「死现任」是**误导性**的（「只有现任协调者会话 X 可写」——但 X 写不了；:1751/:1757/:4287 同款）。改为：`现任 X 无活代理（dead）——写操作卡死，可 team_link_roster action=recover 恢复（需在场确认）`。
2. **两个诊断词派生而非存储**：`vacant（有意退役）` = current 为 null；`seated-dead（无活代理）` = `agents.get(current) === undefined`。两个词都从既有状态读出。
3. **启动清扫并入**：现有启动清扫只报 `pending-create` 孤儿（:5485-5492）；扩一行「各团队 current 无活代理的角色清单」（重载后全体自建代理皆死的场景下，这是用户看到的第一个信号）。

「无人读就无人发现」这一盲区**不靠持久状态修**：门拒绝时刻即诊断时刻（每次被拒的写都带诊断与恢复指针）；主动巡检只在团队**有看门狗**时搭既有 patrol 便车（patrol 定时器仅随注册存在，:1569-1573），无看门狗的团队不做定时巡检——这是边界，不是缺陷。

### ② 谁有权发起恢复：分层，且**不需要临时复权令牌**

| 主体 | 结论 | 理由 |
|---|---|---|
| 任意存活 roster 成员（v1 建议） | **可发起** | 发起权本身低风险：真正的权力在**人类确认对话框**（userQuestions 的答案只能由 UI 的人类给出，模型不能自答自己的对话框——与 claim 同一机制）。成员域是最小可辩护的发起域 |
| 旧任（已退役、信任已吊销） | **机制上仍能调用工具**（吊销只清通道，不清工具面；会话仍活、工具注册在插件根 ctx 上），但 **v1 不给发起权** | 它已不在 roster 成员域；revive 的对象是现任（继任者）、reappoint 的候选是成员——都与它无关。若实测 UX 需要，放宽为「任何活会话可发起」也安全（权力仍收在对话框），但 v1 收紧更干净 |
| 人类 | **设置 UI 保持既有超级写者**；新增的 recover 对话框即人类入口 | 不新增设置面；「对话框确认」就是人类授权本身 |
| 「临时复权」令牌 | **不需要，且应显式拒绝** | 令牌只有在**无人值守**场景才换得来价值（M4 用它是因为继任者可能无人值守 claim）；而恢复必须是 **attended** 的——无人值守恢复 = 常驻自任命机器 = 你最担心的那个后门。人类确认即凭证 |

### ③ 防滥用设计（你最担心的一点）：恢复是「两个封闭动词 + 一次人类确认」，不是第二把写门钥匙

机制：`team_link_roster action=recover`（或独立注册 `team_link_recover`，理由与 rotate 独立注册相同：演员与前置条件不同）。带 `team[, role]`；不带 role 时输出诊断（每角色一行：现任 + 活性 + 最近任期 + 可恢复方式），**零副作用**。两个恢复动词：

- **revive（复活）**：current 无活代理 → 确认框 → `ctx.agents.resume({ resumeSessionId: current, ... })`（dsh-agent index.d.ts:280-287 证实该 API 存在，语义「load persisted session and resume an agent on it」）。**身份不变、roster 不动、信任零改动**——复活不是换人，writerGate 不需要放行任何东西。
- **reappoint（改任）**：候选 = **插件计算**的当前存活 roster 成员（排除 dead current 本身）→ 人类逐项确认 → **复用 claim 的同一套** `applyRotationTrust` + `settleRotation`（域限定迁移 + 对称吊销，:4339-4403）→ 历史记「recovery」备注 + `rotationStatus` 记恢复词 → 广播 done 变体 → decisions.md 追加审计行（写黑板无门，砖态下也能落账）。

八条硬约束（把「绕过 writerGate 的后门」逐条封死）：

1. **封闭动词**：恢复只有 revive / reappoint 两个动词；**不接受**任意 roster 字段写入、不改 `policy.writer`、不换除 current 外的任何字段。reappoint 本质是「无令牌的 claim」——它继承 claim 的全部边界（域限定、对称吊销、正式通道），**不能授予任何 claim 授不了的东西**。
2. **attended-only**：两个动词都必须过人类确认框；**没有 provisional、没有 TTL、没有无人值守降级**；无确认服务 → fail-closed（与 §11.4.1 同款）。这是与 M4 claim 的**刻意不对称**：claim 允许无人值守是因为「回退窗口」；恢复修复的正是「无人可写」，无人值守自愈就是把「超级写者」常驻化。
3. **候选不可由模型指定**：reappoint 的候选列表由插件从 live 成员计算、以对话框选项呈现（与 claim 的逐项勾选同形态），模型只传 team/role，不传继任者 id。
4. **revive 绑定身份**：revive 只能复活该角色**当前的** current（一次性）；不存在「复活任意历史会话」的动词——那会让吊销形同虚设（退役者永远进不了 revive 的对象位）。
5. **writerGate 原样不动**：恢复后写权限依旧只属于 roster 认定的现任。恢复控制器与 rotation 控制器并列成为**唯二**的 policy 写者，不新增任何「超级写者会话」。
6. **恢复不自动降级 writer**：绝不把 `writer=coordinator` 改成 `any` 当「修复」——那是对团队的静默弱化。
7. **限速 + 审计**：复用/仿照 `rotationRateLimited`（:4264-4277）的窗口防对话框轰炸；每次恢复在版本史、roster.md 镜像、decisions.md 三处留痕。
8. **先清扫再动作**：recover 进入即跑既有过期清扫（roster 触达即扫的既有模式 :2057-2061），避免与在飞 pending 交错。

### ④ 失败模式与边界

| 失败模式 | 表现 | 边界/处置 |
|---|---|---|
| 假死（竞态） | recover 动作瞬间目标其实已活（人类正在侧边栏打开） | 动作前重查 liveness；对已注册 id 的 resume 会拒绝 → 如实报告「已活，无需恢复」，零副作用 |
| 无 factory / 无 sessionPersistence | resume 无法执行（index.d.ts:280-283：factory 缺失或 persistence 未配置即拒） | fail-closed 报告原因；退回 reappoint 或设置 UI 或侧边栏深链指引（§3.6.4 半自动退路） |
| **复活夺权**（本评审新增的重要边界） | resume 的 ownerCtx 是插件根 ctx ⇒ 复活后该代理的**运行时所有权归插件**，卸载即拆。对人类自建会话做 revive = 把它的生命周期从 UI 转给插件，比现状（插件重载不影响人类会话）**更差** | **v1 的 revive 只对插件自建会话**（§11 自建的继任者，本来就是插件所有）；人类自建会话的恢复走「深链指引，请人类侧边栏打开」 |
| 重载后再死 | 复活/任命后插件重载，全体自建代理又拆掉 | 生命周期事实（§10.2.5）；恢复可重复执行；启动清扫列出全部 dead 角色 |
| 任命后原会话复活 | dead current 被人类侧边栏打开，以非成员身份回来，inbox 照跑 | 其信任已在 reappoint 时对称吊销；按孤儿报告（复用 pending-create 可收编清单）；插件不自动关闭任何会话（§11.4.7） |
| 全队皆死（重载后） | reappoint 候选集为空 | 只剩 revive / 设置 UI；错误文本明说「没有存活成员可改任」 |
| 无看门狗团队 | 无人读 roster 就无人发现 | 门拒绝=检测时刻；主动检测只在有 watchdog 时搭 patrol 便车（:1570-1572 定时器仅随注册存在） |
| 恢复对话框无人应答 | 人类不在场 | 无自动路径（约束 2）；失败即报告，不留下任何半状态 |
| 死在 prepare→claim 窗口 | current 死时 pending 在飞 | 进入即清扫：过期 pending 照常 rotation-cancelled；未过期的先复活旧任再走原流程 |
| 跨进程/单写者 | 另一 DSH 进程或侧边栏已打开目标会话（H1 同款风险） | resume 失败即如实报告；指引「若侧边栏已打开则无需 recover」 |

---

## Q2 交接文档的内容契约

§11.4.3 只有「头部元数据 + 模型正文」，确实不足。建议**三层结构 + 分层缺项政策**。核心原则沿用 §3.6.2 的「**机制与判断分离**」：插件写一切**机制事实**（它拥有的事实源），模型只写**判断**。

| 层 | 字段（最小集） | 写者 | 缺项/失败政策 |
|---|---|---|---|
| **头（YAML）** | `schema: team-link-handoff-v1`、`team`、`role`、旧任 id、新任 id、`preparedAt`、`claimedAt`、**令牌掩码**（永不明文）、`rotationStatus`（已批准/待批准(24h)/无待迁移对/recovery）、历史备注 | 插件（机器生成，逐字段校验） | 插件自身故障：写失败**不阻断换届**（部分成功不回滚：正文已随令牌投给继任者，磁盘副本是冗余）——降级 = 大声报告 + 下次 roster 触达重试；但**结构非法（控制字符等）必须 fail-closed 不落盘** |
| **事实段** | 迁移 pairs 清单（含 provisional 标记与到期时刻）、未迁移/随退役清理清单、对称吊销明细（trustedSenders/rememberTargets 移除项）、freeze/done 广播摘要（**含 no-agent 未投递名单**）、provisional 回退窗口截止与补批准路径、上/下一份交接文档路径 | 插件（与 claim 返回文案**同一事实源**，不可两处口径） | 同上层 |
| **正文** | 六个必含节：**§任务与当前目标**（角色当前 goal 相位/rounds/armed 状态——上任首动就是 /goal resume，文档必须说清有没有 goal 可续）；**§在飞与交接瞬间**（未完成的承诺、冻结清单余项、看门狗注册、在途消息）；**§纪律与协议指针**（discipline.md/decisions.md 路径 + baseHash + 文档之外的口头纪律）；**§信任与通道现状**（谁已配对/谁 provisional/谁走首问门——插件事实给出「是什么」，模型补充「为什么、下一步该信谁」）；**§已知风险与陷阱**；**§上任第一步清单** | 旧任模型 | 见下 |

**缺项政策（三层，与题面三选项的取舍）**：

1. **正文全缺（`handoff` 参数缺失或空）→ 拒绝换届**：fail-closed，明示「请补交接正文」。理由：§11 的全部意义就是防「换届丢上下文」；一份空正文的换届正是它要防的事故。代价只是一次重试（已建的会话进 §11.5 孤儿清单，已有机制覆盖）。
2. **正文存在但缺必含节（结构 lint：节标记 + 每节非平凡长度）→ 警告 + 降级，不拒绝**：把缺项清单写进 §11.4.1 的确认框（「正文缺少 §在飞、§下一步」），**人类决定**继续或取消。理由：插件无法判定语义质量，草稿缺陷不该卡死一次人类已确认的换届；但缺陷**必须可见，绝不静默接受**——且要在文档内落一条「正文缺项：…」横幅，让继任者与事后审计都看见。
3. **语义
… [reply capped at 8000 chars — the uncapped text is in the minutes' §1.1]

[4] kimi-api:kimi-k3 — ok
评审完成。以下为三题的只读设计评审（机制、边界、失败模式；无代码）。所有关键论断均已对源码/设计文档取证，引用格式为 `文件:行号`。

---

# §11 自动换届交接 — 三题设计评审

## 0. 前提复核（评审依赖的事实，逐条核实）

| # | 事实 | 出处 |
|---|---|---|
| F1 | `writerGate`：`policy.writer=coordinator`（默认）时仅 coordinator **现任**可写；空缺时会话路径**全拒**，明示「用户经设置 UI 永远是超级写者」 | [index.js:1746-1760](D:\DSH-Portable\plugins\dsh-team-link\lib\index.js) |
| F2 | `retireGate` 独立于 writer 策略：任何团队（含 writer=any）退役都只有现任 coordinator 会话能发起 | index.js:1768-1778 |
| F3 | `rotateGate`（prepare）：只有**该角色自己的现任**会话可发起；coordinator 也**不能**替 worker 角色发起换届 | index.js:4282-4290 |
| F4 | claim 落定后 provisional 过期回退**只删 pairs**：「新任保持 current（换届事实已成立，降格需用户显式操作）」 | index.js:4464-4466；主设计 §3.6.2 评审 #5 |
| F5 | 活性判定是**读取时**计算：`ctx.agents.get(id) === undefined` → `not-live` → verdict `dead`；广播的 `alsoNotify` 也只并活代理 | index.js:483-510、4529 |
| F6 | DSH 重启后所有代理死亡，「请在侧边栏打开目标会话一次使其恢复为活动代理」——**resume 后 session id 不变、pairs 按 session id 键控，零信任手术即全恢复** | index.js:2920 |
| F7 | DSH 源码原话：「Ambient presence is neither liveness proof nor authorization」 | dsh-agent/lib/types/index.d.ts:197 |
| F8 | §3.6.2 伪代码的 prepare 授权本来就是 `exec.agent.id === roster[role].current **\|\| userInitiated**`——「用户发起」是设计内生的第二授权源，实现版把它窄化成了「设置 UI」 | 主设计 §3.6.2:321-323 |
| F9 | 命令 handler 拿不到模型上下文：`CommandResult = {kind, text}`，"rendered directly by the dispatching UI"；`command/run`/`command/done` 是 log-only、"never model surface" | dsh-commands types.d.ts:32-41、index.d.ts:117-125 |
| F10 | 但 `CommandInvocation.agent` 是**完整 Agent**，且 `Agent.followup`（"Queue an ordinary follow-up turn **and wake the driver**"）与 `Agent.steer`（"**An idle driver starts a turn**"）都在公开类型面上 | dsh-commands index.d.ts:23；dsh-agent runtime-types.d.ts:192、200 |
| F11 | 命令 handler 做机械大件已被 ② 实证：`/team_session` 在 handler 里完成确认框 + `agents.create` + roster 登记 + pairs 写入（writerGate 用 `invocation.agent.id` 过门） | index.js:4099-4154 |
| F12 | 黑板写**无权限门**（读有）；死锁面只在 roster 写 / rotation / retire | index.js:2270 |
| F13 | `pending` 全量存设置（含完整 token，仅渲染掩码）；`pendingCreates` 意图 + 启动清扫 + 可收编清单已落地 | index.js:4623、564-573、4204-4223 |

**死锁的精确边界**（Q1 问题的 scope 修正）：死锁 ⇔ `policy.writer=coordinator`（默认）**且死的是 coordinator**。死的是 worker 时链条仍在：活 coordinator 可 `retire` 该角色（F2 只查 coordinator）→ 清理死 pairs → `set-role` 新 worker → 走首问门重建——丢信任拓扑但不死锁。writer=any 团队任何会话可 `set-role` 补 coordinator，也不死锁。**所以 Q1 的硬死锁只有一格：默认策略 + coordinator 现任死亡。**

---

## Q1【最重要】角色「现任无人」的自愈

### 0. 先修正问题框架：死亡 ≠ 需要换信任

roster 的 `current` 指向的是**会话 id**，pairs 也按会话 id 键控（F6）。「代理死亡」只意味着没人能唤醒它；**在侧边栏重开该会话 = 原 id 复活 = 全部信任通道原样恢复**，一次信任手术都不用做。真正的洞不是「死了怎么办」，而是：

1. **用户不知道可以重开**（可诊断性缺口）；
2. **不该/不能重开时**（会话损坏、前任是临时会话、用户就是想换掉它）没有任何会话可达的路径（机制缺口）。

因此恢复机制是**三级阶梯**，逐级升级、逐级别更贵：

| 级 | 手段 | 信任手术 | 何时用 |
|---|---|---|---|
| L1 | 侧边栏重开原会话（resume） | 零 | 默认首选——死亡绝大多数是重载/重启假象 |
| L2 | **break-glass recover**（本评审的新机制） | 走完整 M4 claim | 现任不会/不应再回来 |
| L3 | 设置 UI 直接改 teams 键 | 手工 | L2 的前置条件也不满足时（永远可用） |

### ① 显式「vacant-due-to-death」状态？——**不要持久化新状态，要读取时判定 + 可诊断面**

**结论：不加持久化的显式状态。** 四条理由：

1. **死亡是宿主持有的易变事实**（agent 注册表在不在），不是插件的持久事实。落盘一个「vacant」标记，用户一侧边栏重开它就过期——而清除它又得靠每次读取重查活性，标记立即冗余。**过期标记比没有更坏**：若门按标记行事，复活的原任会被自己的角色错误拒绝、或他人被错误放行。
2. 读取时判定**已经存在且零成本**：F5 三处都在用同一个 `agents.get` 读数，无新机制。
3. §10.3 红线：新增持久化 key 需「闭环必需的持久性」。死亡检测恰恰**不需要**持久性；需要持久性的部分（history 备注、roster.md 镜像、pending 槽） already 都在。
4. 「现任无人」的两种形态在现有数据里本就可区分：`current === null`（retire 的刻意空缺）与 `current = S ∧ agents.get(S) === undefined`（悬空指针）。recover 两种都受理，确认框里说明是哪种即可。

**唯一值得做的「显式」是显式证据与显式诊断，不是显式状态**：

- **诊断下沉到报错**：三道门（writerGate / rotateGate / retireGate）保持纯函数不动；**工具层**在门拒绝且能读到「现任无活代理」时，给报错追加一行恢复指引（L1→L2→L3 阶梯）。这把每一次失败的写都变成一次诊断。
- **roster get / team_read 的 roster 概要**对 dead 现任加一行注记（现在是静默的——roster 只渲染 id，活性要去 list_sessions 才看得到）。
- **明确否决**「巡逻主动告警 coordinator 死亡」：插件重载 = 全队代理同时死亡（§10.2.5），巡逻一告警就是**每次重载一场误报风暴**；且 `broadcastNotice` 对无发送方身份的通知按设计不发送（index.js:4520-4521）。读面暴露 + 人类节奏即可。

### 恢复机制：`team_link_rotate action=recover` —— 「人类对话授权的 prepare」

**核心洞察（F8）**：原设计的 prepare 授权本来就有 `|| userInitiated`，实现把它窄化成了设置 UI 手工编辑。recover 不是发明新授权，而是**把「用户发起」做成工具面一等公民**：机器守门 + 人类一次点击，替代手工改 JSON。

机制（全部复用既有件，无新状态时序）：

1. **机器前置**（全硬校验，任一不满足即拒、不弹框）：
   - `current === null` **或** `agents.get(current) === undefined`（A4 事实，不可伪造）；
   - 该角色**无在飞 pending**（有就让它 claim 或过期清扫，不插队）；
   - 速率限制：与 `rotationRateLimited` 同窗口，另加 recover 专属更长冷却（建议每 team 60 分钟——破窗应当罕见）；
   - **发起者资格**（见 ②）。
2. **人类授权**：一次 `userQuestions.ask`（与 M4 claim 同服务同形态），框内**必须**写明：团队/角色、现任死亡证据（「会话 S 无活代理，读数 T」）、**全队活性概览**（「N/M 成员当前无活代理——若刚重载插件/重启 DSH，请先走 L1 侧边栏重开」）、发起者是谁、提议的继任者（含 **auto**，复用 §11.4.2 自建）、自荐高亮、以及「随后将广播冻结、继任者凭令牌 claim、按 M4 语义迁移并对称吊销」。**无确认服务 / 取消 / 超时 → fail-closed**，报错指向 L3 设置 UI。
3. **写时复检（TOCTOU）**：对话框横跨任意长的人工等待——`policy.update` 前**重读活性**，原任已复活则中止（「S 已恢复活性，请走正常 prepare」）。这与 retire-cleanup 对话框「写前重读视图」是同一防御（index.js:2235-2247）。
4. **然后逐字走 prepare 的机制**：铸令牌绑定 (team, role, successor)、`rotationBackup` 快照（此刻快照的是死亡现任的信任遗存，claim 时对它的「对称吊销」实为纯清理）、广播冻结——**通知文案用独立措辞**（「recovery：现任 S 死亡，由 I 发起、用户确认」），全队知情。
5. **claim 逐字不动**（红线 §11.6）：令牌、域限定迁移、对称吊销、确认框或 provisional+24h 全部保留。人类在 recover 框点过一次，claim 时还会再过一次对话框（或无人值守走 provisional）——**两道人类关卡 + 24h 回退网，不合并、不省略**。

### ② 谁有权发起

把「发起」「授权」「执行」三权拆开答：

- **授权**只有一个来源：**人类在 recover 对话框里那一下点击**（fail-closed）。这与全插件的信任授予模型一致（claim 迁移、/team_session 配对授权、§11.4.1 建会话确认，全是这一个模式）。
- **发起**（触发弹框的资格）：**在世**会话，且 ∈ {该角色**最近一任前任**（history 里最后一条 `until ≠ null` 的 tenure）} ∪ {**团队现任成员**（teamMembers）}。理由：
  - **旧任可以发起**——它虽被对称吊销（pairs/trustedSenders/rememberTargets 清零），但发起权从不依赖信任，只依赖身份资格；它有最完整的上下文，且「回聘旧任」是最自然的恢复（旧任提议自己继任，claim 时从死亡继任者的遗存里按域限定规则迁移重建——被第一次换届丢弃的旧 pairs **不**复活，走首问门重建，见 ④ 边界）。拒绝它发起反而把最常见的恢复人挡在门外。
  - 任意**外部会话**不可发起——在弹框之前就被资格门拒掉。
  - **人类会话**：工具门无法机器区分「人类驱动会话」，所以人类因素**只**经由对话框与命令门进入——这是如实声明，不是漏洞。
- **「临时复权」令牌**：**不需要新令牌**——pending 本身就是那张临时复权令牌（绑定三元组、一次性、30 分钟 TTL、全量落盘 F13）。recover 改变的只是**铸币权**的守门（死亡事实 + 资格 + 人类点击，替代现任身份），铸出来的币与 prepare 完全同构。这保持了单一机制、单一审计面。
- **执行**（claim）：只有 pending 指定的继任者本人凭令牌——逐字既有语义。

### ③ 防「绕过 writerGate 的后门」——分层论证

这是您最担心的面，逐条威胁过：

1. **recover 确实写 roster，它不是「没有门」，而是「另一道更严的门」**。writerGate 守通用 roster 写（身份门）；recover 的门 = 死亡事实（不可伪造，宿主事实）+ 发起资格 + **人类点击** + 双速率限制 + 写时复检 + 全队广播 + 版本史备注。设计原则：**每条写路径都有自己的门，recover 不是 writerGate 的缺口而是与 M4 claim 同级的人类在环授权**。
2. **伪造死亡**：不可能经本插件——成员没有任何 API 拆掉别的会话的代理（插件持有的 handle 只在卸载时统一 dispose，模型面无 dispose 入口）。等自然死亡窗口（DSH 重启后全员死亡）确实会来，但窗口里每次 recover 都要过人类弹框，且框内有全队活性概览 + 「先走 L1」提示。
3. **链式提权**（最险的一条）：成员篡位 coordinator → prepare 给同伙 → 迁移 pairs。每一环都撞墙：recover 弹框（人类看自荐与证据）→ claim 令牌（只有被指定者能 claim）→ claim 自己的对话框或 provisional+24h 回退（第二道人类关卡）→ 每一步**全队广播 + 版本史留痕**（ stealth 不可能）。对照 F7：本设计**刻意不从活性推导授权**——活性只开门禁（允许提议），授权永远在人的点击上。
4. **效应最小特权**：recover 只能作用于「死的那个角色」——不能碰 policy、不能碰其他角色、不删 history（只追加）、不恢复第一次换届前的旧 pairs。它没有 set-role 的通用性，比 writerGate 的授权面**更窄**。
5. **诚实残余风险**：人类无脑点确认则一切门皆失效——但这是全插件统一的授权模型，recover 不新增这一风险类别；缓解 = 弹框内容硬性清单（①所列各项缺一不弹）+ 冷却 + 透明广播。

### ④ 失败模式与边界

| # | 失败模式 | 行为 |
|---|---|---|
| a | 无确认服务 / 取消 / 超时 | fail-closed，零变更，报错指向 L3 设置 UI |
| b | 无合格发起者在世（单人团队、coordinator 死亡、无前任） | 工具面如实不可达 → L3；这是**声明的边界**，不是缺陷 |
| c | 现任其实活着 | recover 拒：「recover 仅用于现任无代理/空缺；正常换届走 prepare」 |
| d | 有在飞 pending | 拒：等 claim 或 30 分钟过期清扫 |
| e | 弹框期间现任复活（TOCTOU） | 写时复检中止，零变更 |
| f | recover 已 prepare、插件重载于 claim 前 | 令牌 30 分钟过期 → 既有 sweep 取消并解冻；自建继任者进 §11.5 可收编报告；可重发 recover（冷却内被拒则等） |
| g | 继任者 claim 后**又**死（问题递归一层） | recover 可再次发起；每轮都过人类点击；双冷却封顶churn。**recover 不预防复发，它把每次发作从「设置 UI 手术」降为「一次弹框」** |
| h | 恶意发起者刷弹框 | 冷却 + 每次尝试全队广播（透明即威慑）；弹框疲劳为残余风险 |
| i | 黑板/ workspace / 团队行被手删 | 不在 recover 范围（schema normalize 兜底，L3 修复） |

**边界声明**：① recover 不保证复原**第一次换届前**的信任拓扑（那批 pairs 在第一次 claim 时已按域限定规则丢弃；从 rotationBackup「整体还原」绕过了对端同意模型，v1 不做——若做 v2，必须套 provisional+24h 外壳才符合原则 4）；② recover 对 writer=any 团队与死 worker 不是必需（既有 retire/set-role 链可达），但机制对各角色一致开放以保持权力模型干净——**recover 的授权从不源自 coordinator 身份**（否则就是给 coordinator 新增了「轮换他人角色」的权力，而 F3 刻意没给它）；③ 死协调者 + writer=coordinator 是唯一硬死锁格，其他格 recover 是「保信任拓扑的更优解」而非「唯一解」。

---

## Q2 交接文档的内容契约

**双重受众先摆正**（这决定缺项策略的严厉度）：正文经 §11.4.5 的 followup **进入继任者模型上下文**（活着的交接），落盘文档是**审计 + 人类可读 + 事后重读**（§11.4.3）。同源一份正文、两处承载。所以「空正文」伤害的是继任者本身（拒绝级），「缺小节」伤害的是文档质量（警告级）。

##
… [reply capped at 8000 chars — the uncapped text is in the minutes' §1.1]
```

### §1.1 未截断全文（**仅当有回复超 8000 字软顶时出现**；机制写）

#### [2] zai-coding-cn:glm-5.3（9708 字）

```text
# §11 自动换届交接 · 三问设计评审（只读）

先交代我核过的证据面：`writerGate`/`retireGate`（lib/index.js#L1746-L1778）、M4 全量 rotation 控制器（prepare/claim/replayClaim/sweep，#L4605-L5016）、`deliverToTarget` 的死目标守门与 no-agent 修复文案（#L2909-L2962）、`teamMembers`（#L4247）、看门狗可 tick 判据含 `dead`（#L117）、§3.6 主设计、§10.2/§11 增补设计、README 的「空缺全拒 + 设置 UI 超级写者」语义（README.md#L450-L454）、`dsh-commands` 的 `CommandResult`/`command/run|done`「log-only, never model surface」（types.d.ts#L33-L53、types/types.d.ts#L100-L119）、`dsh-agent` 的 `Agent.followup`/`AgentRegistry`（runtime-types.d.ts#L176-L210、index.d.ts#L130-L199）。以下每个判断都锚在这些面上。

---

## Q1【角色现任无人】自愈 / 可诊断 + 一键恢复

### 0. 事实核对（比题设略乐观的两点，先摆出来）

- **死结是「写死」不是「通讯死」**：投递路径（send/pairs/内部通知）不过 `writerGate`——团队还能说话，只是 roster/黑板写不进。诊断面要把这个差别说出来，避免成员误判为全瘫。
- **死法有时序三分**，其中一种已有出口：incumbent 死在 **prepare 之后、claim 之前** 时，claim 的门只看「caller === pending.session + 令牌」（#L4738-L4743），**不看旧任活性**——继任者照样 claim，换届照常落定，团队自然解锁。真正的死结窗口是：死在 prepare 前（无令牌）、令牌 30 分钟过期被清扫（current 回指死者）、死在 claim 落定后（本问主案）。

### ① 要不要显式「vacant-due-to-death」状态？——**不要持久化状态，要「读取时判定 + 命名诊断」**

理由三条，每条都来自既有不变量：

1. **roster 是记录，不是活性镜像**。既有原则「a dead member keeps its no-agent row — the roster is the record」（#L4523）已经裁过一次：活性是移动快照（读数 2 分钟即陈旧），把「死」写进 roster 等于把陈旧当事实落盘。
2. **插件重载会集体翻状态**。§10.2.5 声明卸载/重载 = 全队 teardown；若死亡要落盘，一次重载会把所有插件属会话的角色全部写成 vacant——而其中大部分下一分钟就能被人在侧边栏点开复活。自动写入破坏的恰恰是最容易恢复的路径。
3. **「刻意空缺」与「死亡空缺」语义必须可分**。`current=null` 是用户在设置 UI 里的**显式表达**（README：「手写出来的空缺行仍然全拒——那是用户显式表达的状态」），其错误文案指引「去设置 UI 指定现任」；死亡空缺的正确第一动作却是「**在侧边栏点开那个会话**」。合并两者会让两种场景都拿到错误指引。

**做法**：活性判定复用 `ctx.agents.get(incumbent) === undefined`（与 verdict=dead 同源），在**两个读取面**命名它——(a) `roster get` 的工具返回里，coordinator 现任无活代理时加一行「⚠ 现任无人（vacant-due-to-death）：建议先在侧边栏重新打开该会话；或 team_link_roster action=recover（需确认）；或设置 UI 手改」；(b) `writerGate` 拒绝文案的**调用方富化**（gate 本体保持纯函数，由有 ctx 的工具层传入 incumbent-dead 标志），把「只有现任可写」升级为「现任无活代理，这是死亡空缺，恢复梯子见 …」。roster.md 镜像刻意**不**加（它是状态渲染，不是活性渲染，维持纯度）。`list_sessions` 已天然标 dead，零新增。

### ② 谁有权恢复——**三级恢复梯子，人在环是唯一新授权点**

| 梯级 | 动作 | 授权来源 | 代价 |
|---|---|---|---|
| **R0 重开** | 人类在侧边栏点开死亡现任的会话 → 同 id 复活 → `writerGate` 按 id 比对直接放行 | 纯 UI 动作，零插件参与 | 一次点击；信任/pairs/身份**全保留** |
| **R1 recover 动作** | `team_link_roster action=recover, team, target=<存活成员 id \| "vacant">` | **人类确认框**（userQuestions，fail-closed） | 身份换人，信任**不迁移** |
| **R2 设置 UI** | 手改 teams 键（现状已有的超级写者） | 人类直接编辑 | yaml 手工，无审计增强 |

- **旧任不能恢复**：它的信任已被对称吊销、已不是任何角色的 current——让它凭「我以前是」复权，等于让换届变成「可逆于一次死亡」，这正是 rotation 要消灭的「退役者永久保送」的变体。它仍可当**信使**（普通过门投递提醒人类），但无特权。
- **不需要「临时复权令牌」**：令牌是无人在环的承载凭证，而本场景**本质上必须有人在环**（见④的 A4 论证）——一个绕过 writerGate 的 bearer capability 且无人类门，恰好是后门的形状。确认框本身就是授权，令牌是多余的秘密面。
- **发起权**：限**本队存活成员**（`teamMembers(team)` 里的活代理）。它们是撞墙的人；非成员无合法利害，让它走 R2。

### ③ 防后门（最担心的一条）——六条性质，核心论证是一条

**核心论证：任何「人类确认框把关」的动作，其权限上界就是设置 UI 超级写者**——后者本来就能改一切且无审计。R1 只是把既有的人类权限收窄成一个更窄、更可审计、更顺手的形式，因此它**不可能新增**后门；后门只可能来自绕开人类的那部分。据此：

1. **触发条件由宿主观测，不由调用方主张**：recover 执行时插件自己重查 `ctx.agents.get(incumbent) === undefined`（确认框弹出时与**落笔写入前各查一次**）。现任活着 → 条件不成立 → 拒绝。于是它**无法替代** set-role/rotation 成为换人旁路。
2. **无人类确认服务 → fail-closed 拒绝**，且**刻意不设 provisional 无人值守变体**（与 M4 claim 的关键差异，必须写进设计）：rotation 的 provisional 之所以敢无人值守，是因为 pair 迁移可被 sweep 自动回退；而 incumbency 不可自动回退——错误现任写下的黑板/roster 已成事实，回退撤销不了已发生的写。授予可逆才能无人值守，身份不可逆所以必须人在环。
3. **窄域**：只动 coordinator 一个角色；target 只能是**当前存活的本队成员**或显式 vacant；不迁移任何信任（新任从首问门起步，要全量信任事后走正式 rotation）；不改 policy。
4. **复用反风暴**：沿用 10 分钟速率限制形态；幂等判据 `current === target` → 重放返回既有结果不重复写（对齐 replayClaim 的判据风格）。
5. **审计**：闭 tenure 记 `note: recovery(vacant-due-to-death, requester=<id>)`；写前快照进 `rotationBackup`（对齐「任何时刻可一键撤销」原则 4）；向成员广播一条**固定文案**内部通知（沿用 rotation 通知路径——它是投递消息，不是新日志事件类型，不踩 §10.3 红线）。确认框正文必须三方具名：死亡的现任 id、发起成员 id、拟任 id。
6. **对称撤销做成可选项**：确认框加一个勾选「同时清理死任的 pairs/trustedSenders/rememberTargets」（默认勾选，复用 `applyRotationTrust`，successor 置空）。不勾的情形留给「打算重开死者」的人类。不自动吊销的理由：R0 路径下那些通道还有用；但默认勾选保住 §3.6.1 原则 3 的对称性，不让每次死亡恢复都漏出僵尸通道。

**滥用面分析**：模型层无法伪造条件（没有任何工具面能杀别人的 agent——`agent.cancel` 是句柄能力，不经模型暴露）；能让现任死亡的唯一现实途径是插件重载/关壳，这本身已是人类/配置动作，其后还要过一次人类确认框——攻击者需要的社会工程成本已高于「直接骗人在设置 UI 改现任」。残余风险收敛为**确认框文案的清晰度**。

### ④ 失败模式与边界

| # | 场景 | 行为 / 边界 |
|---|---|---|
| F1 | 死在 prepare→claim 窗口内 | **不适用 R1**：继任者直接 claim 即解锁（见 0）。令牌过期被清扫后 current 回指死者 → 才进 R1 |
| F2 | 确认框期间现任被重开复活 | 写入前复查找活 → 中止并报告「现任已复活，无需恢复」。残余竞态（复检后、落笔前一瞬复活）：后果 = 一次人类确认过的 re-point 落地，历史有注，非安全洞，可用 set-role 纠正 |
| F3 | target 在确认与写入之间死亡 | 写入前复检 target 活性，死则拒绝（否则原地再造一个死结） |
| F4 | 无人在场（夜间） | R1 fail-closed；团队进入「可通讯、不可写」的等待态。**这是刻意取舍**：A4（死会话只有人能唤醒）+ 写不可逆 ⇒ 恢复天然是人的动作。缓解是**诊断的可达性**：现有 watchdog 本就把 `dead` 列为可 tick 判据（#L117）——成员盯协调者，死后收到 tick、去写、撞见命名过的拒绝文案、去唤人类，整条发现链零新机制 |
| F5 | 全员皆死（重载团灭了插件属会话） | 没有活发起者，R1 够不着——指引降级为「在侧边栏打开任意一个团队会话」（打开死亡现任本身 = R0，直接解锁）。这条必须写进文档 |
| F6 | 该角色 pending 未过期 | 拒绝并告知道期时间（≤30 分钟），先让 sweep 清（recover 入口本身已挂在「每次 roster 触碰先 sweep」的钩上，真正阻塞的只有未过期窗口）。避免与在飞令牌互踩（P3 的教训：身份显式变更要杀令牌，反之亦然） |
| F7 | `writer=any` 的队 | 无死结，recover 拒绝并指出「用 set-role 即可」 |
| F8 | 死的是非 coordinator 角色 | 无写死结（writerGate 只看 coordinator）；send 走 `team:<name>/<role>` 别名吃到 no-agent 拒绝文案（已含「侧边栏重开」指引，#L2917-L2921）。活协调者可 set-role 换人。R1 明确只管 coordinator |
| F9 | 死继任者 + provisional 已回退 | sweep 仍会滚回 pairs（插件内写不过 writerGate），但 rotation-expired 广播的发送方 = 死者 → 各接收端按 refused/no-agent 落行——**通知面部分缺发是既有语义**，文档如实声明；roster 仍指向死者 → 进 R1，恢复后可再走正式 rotation |
| F10 | 两个成员同时请求 | 两次确认框；第二笔写入发现 `current` 已变 → 幂等报告。速率限制兜底 |

**净结论（Q1）**：不新增持久状态、不新增传感器、不新增令牌；新增的是「**读取时的命名诊断 + 一个窄域、人类确认、fail-closed、幂等、限速的 recover 动作**」，外加把既有 watchdog-dead-tick 与 no-agent 文案串成发现链。与 §10.3 红线全部相容（无 schema 改动、无新日志事件类型、inject 不动）。

---

## Q2 交接文档的内容契约

**原则先行**：§3.6.2 的「机制与判断分离」在这里的落法是——**插件只能把关结构（节在场、非空、有界），不能把关内容质量**。契约 gate 的是「沉默缺项」，不 gate「写得烂」：缺项是静默失败的来源，烂文是可见的、继任者可以质疑的。这条要诚实写进设计（presence 门防遗忘，不防敷衍）。

### 字段级最小结构

**头部元数据（插件写，§11.4.3 已有，补两个字段）**：team / role / from（旧任 id）/ to（继任者 id）/ 时间 / 令牌掩码 / **contract 标记**（`v1(mission|in-flight|commitments|unknowns)`，给未来读者一个可验证的节清单）/ **完整性判定**（哪些硬节在场、哪些软节缺——审计面）。

**正文（旧任模型提供；同一份文本同时是 followup 投递物，验证只做一次）**，四个**硬节**：

| 节 | 内容 | 为什么缺了会丢关键上下文 |
|---|---|---|
| `mission` | 该角色对团队负责什么（1–3 句） | roster 只有角色名，没有角色**意义**；缺了 = 继任者不知道自己的职责边界 |
| `in-flight` | 在飞工作清单，每项：事项 / 相关成员 / 当前状态 / 下一步 | 这是交接的本体；机器状态（黑板/goal）只有碎片，缺了 = 在飞工作被静默丢弃——换届最贵的事故 |
| `commitments` | 未兑现承诺（对成员或人类的） | 承诺活在旧任的工作记忆里，任何盘面都查不到；缺了 = 团队信用无声违约 |
| `unknowns` | 我不知道/没覆盖什么（负面空间声明） | 把「沉默」变成信息：缺了 = 缺席被误读为完备 |

三个**软节**（缺则警告，不拦）：`first-actions`（有机器兜底——prepare 返回文案已注入「goal resume/新建 goal」建议，§3.6.2）；`team-map`（黑板已承载大半）；`conventions`（团队纪律与伤疤，E4 所说最贵的重建物，但无法机器判定其在场价值）。

### 缺项处理阶梯（关键：验证点必须在**任何副作用之前**）

| 情形 | 处置 |
|---|---|
| `successor:"auto"` + handoff 缺失/为空 | **拒绝于工具入口**（零建会话、零令牌、零 freeze）——错误文案里给出四硬节的脚手架模板，模型一回合可自纠。理由：auto 路径造出的是零上下文的全新根会话，handoff 是它得到的**全部**；空 handoff 的自动换届 = 造一个失忆的持钥者，比拒绝更糟 |
| handoff 在，硬节缺 | 同上拒绝，点名缺哪些节 |
| 软节缺 | 放行；prepare 返回列警告，头部元数据记录 |
| 显式 successor（既有会话）+ 无 handoff | **放行 + 警告**（M4 现语义不回收紧——那个会话有自己的生命与上下文，钥匙交接是合法低配）；不写文档文件，prepare 返回如实说明 |
| 硬节在场但明显薄（如 mission < 20 码点） | 警告入档，放行——判断归模型 |
| 文档写入失败（auto 路径） | **abort-before-prepare**：不铸令牌、不广播 freeze，已建会话按 §11.5 如实报告为孤儿。理由：文档落档是你方 2026-09-19 的显式决策，且这是全流程最便宜的干净失败点（§11.3 时序里写文档本就在 prepare 前） |
| claim 时 | **不复验文档**（它是审计件不是执行件）；claim 不因文档被删而阻塞 |

**残余失败模式**（如实声明）：① 模型用套话灌满硬节过门——presence 门防不住，缓解是文档对继任者与人类可见、可质疑；② 正文超长——followup 携带头部 + 截断标记 + 「余文见 `<路径>`」（继任者是根会话，有文件读权，这条退路干净）；③ 节标记必须用**稳定常量**（如固定小节名），校验按标记匹配、内容任意语言。

---

## Q3 H3 的退路

### 0. 事实核对（H3 的风险面比文档写的窄）

- `CommandResult` 只进 UI、`command/run|done` 是 log-only never-model-surface——**已证**（types.d.ts 原文）。
- `CommandInvocation.agent` 是完整 Agent（含 followup/steer）——**已证**。
- `Agent.followup` 是普通方法，接口层**没有 self 禁令**，且「A wake submitted while already idle always opens its turn boundary」（runtime-types.d.ts#L176-L192）——所以 H3 的悬念不在「允不允许」，在**回合与来源语义**：自发源消息（`senderSessionId=` 自己的三成员 source）模型读起来是否自然、命令 handler 的 UI 请求链与被唤醒回合的交错是否干净（followup 不吃 `invocation.signal`，回合与 UI 请求解耦，这点反而安全）。冒烟一次的成本很低，**首选仍是照 §11.2 实施 H3**。

### 1. 你提议的拆分（命令做机械、正文下回合补）——**依赖一个唤醒信道，先把它拆出来**

「旧任模型下一回合补上」需要有人唤醒旧任。只有三个信道：

| 信道 | 性质 |
|---|---|
| self-followup | **就是 H3**，循环依赖，不算退路（steer 同理——任何「命令 handler 自驱」都落在同一条待验假设上） |
| 人类粘贴一句话 | H3-free |
| 继任者反向访谈（先建会话，让新会话主动 team_link_send 向旧任索要交接） | H3-free，但交接正文只能以**消息**形态流动——插件写文档需要一个模型可调的写入口，恰好违背 §11.4.3 自己的论证（「不新增模型可调的黑板写入口」），且「文档落档」的用户决策落空 |

所以 H3 失败时，**唯一既保住 Q2 契约、又保住「文档落档」决策的信道是人类粘贴**。于是最优退路不是「退回纯工具入口」，而是：

### 2. 推荐退路：**机械命令（thin wrapper）**

`/team_rotate <role>`（H3 失败分支的形态）= ① 校验发起会话确为该角色现任（拒绝要趁早，省一次空回合）→ ② 一次确认框（§11.4.1 同款：将新建 1 个会话、模型/cwd/成本口径）→ ③ `agents.create` 建继任者根会话（§10.2.2/§10.2.5 全套，插件持柄、pending-create 意图先行）→ ④ **不铸令牌、不写文档**，CommandResult 返回：「继任者 `<id>` 已建好。请在现任会话里说：『起草 `<role>` 交接并调用 team_link_rotate prepare，successor=`<id>`，handoff=…』」。

- **比「退回工具入口」好在哪**：§11.0 认定的唯一真实手工前提是「继任者会话必须先存在」——这条命令恰好消掉它；而判断路径（旧任起草正文 → prepare(auto) → claim）与 §11 主路径**完全同构**，零新状态、零新时序、零第二实现（不违反 thinness：命令永远只是 §11 工具路径的薄壳，防两条流程漂移）。
- **v1.5 可选润色**：用 ① 的客户端卡片 machinery 给 CommandResult 加一个「发给现任」按钮——点击即以**普通 user message** 把那句话发进现任会话。普通消息不过 H3，纯 UI 糖。

### 3. 「现在铸令牌、下回合补正文」的新时序——**不值得**，四条成本

1. **30 分钟令牌 TTL 对撞人类迟延**：正文要等人类去催旧任，催晚了 = rotation-cancelled + 一个 §11.5 孤儿会话——失败模式比收益多。
2. **破坏 Q2 的零副作用验证点**：正文未到就铸令牌/建会话，等于把「结构验证先于一切副作用」的阶梯整个推翻，auto 路径重新打开「造失忆持钥者」的窗口。
3. **文档可能永不落地**：正文靠人催才有，用户「交接文档落黑板留档」的决策变成概率事件。
4. **rotation controller 多一个中间态**（prepared-without-body）：要定义它与 sweep/重放/P3 身份互踩的关系——为一个便捷命令引入四个新测试面，工程上不成比例。

### 4. 结论

H3 保留为首选（API 面看大概率成立，冒烟判据三条：① 命令后本会话是否真的开了回合且消息模型可见；② 自发源三成员 source 的渲染是否自然；③ 命令在回合进行中提交时 followup 是否排队至当前回合收敛后）。失败分支从「v1 仅保留工具入口」**升级为「机械命令 + 返回粘贴句」**；「铸令牌后补正文」的两阶段时序明确否决，理由如上四条。

---

## 红线核对（三问合计的增量面）

- 无 settings schema 改动（Q1 刻意无状态化）；无新日志事件类型（recovery 通知走既有内部广播 = 投递消息）；inject 不动；`source` 仍恰三成员；确认框均具名爆炸半径（对齐 §10.3「批量动作一处人类确认」的精神）。
- 模型可调面净增一处：`team_link_roster action=recover`（窄域 + 条件宿主判定 + 人在环 fail-closed）——这是本评审唯一主张扩的写面，且其权限上界严格小于既有的设置 UI 超级写者。
```

#### [3] deepseek-official:deepseek-v4-pro（11525 字）

```text
评审材料已全部读完：插件实现（`lib/index.js` 5560 行，rotation 控制器 / writerGate / retireGate / list_sessions）、`docs/collab-enhancements-design-2026-09-19.md` §11 全文、主文档 §3.6、以及 DSH 源码侧的 `dsh-commands`（CommandResult）、`dsh-agent`（AgentHandle / create / resume / followup 运行面）。以下是只读评审。

---

# §11 评审：三个设计问题（只读评审）

**依据**（均逐行核对）：[lib/index.js](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js)（重点行见各条）；[collab-enhancements-design-2026-09-19.md](D:/DSH-Portable/plugins/dsh-team-link/docs/collab-enhancements-design-2026-09-19.md) §11；[team-upgrade-design-2026-09-17.md](D:/DSH-Portable/plugins/dsh-team-link/docs/team-upgrade-design-2026-09-17.md) §3.6；[dsh-commands types.d.ts](D:/DSH-Portable/profile/profiles/web/node_modules/@deepseek-ai/dsh-commands/lib/types/types.d.ts)；[dsh-agent index.d.ts](D:/DSH-Portable/profile/profiles/web/node_modules/@deepseek-ai/dsh-agent/lib/types/index.d.ts) 与 [runtime-types.d.ts](D:/DSH-Portable/profile/profiles/web/node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts)。

**先修正问题陈述里的一处前提**：砖态范围不是「roster/黑板全卡死」。`team_link_team_append`（decisions 追加 / discipline 整文件替换）**不过 writerGate**——工具描述自己写明「写黑板没有权限门」（:2270），代码里也无 gate 调用（:2333-2364）。所以「现任死亡」卡死的是：roster 变更（set-role/retire/既有团队 upsert）、换届（prepare/claim）、`/team_session` 登记。团队仍可经 decisions.md（追加型账本）与 `team_link_send`（过正常门）通讯。这影响 Q1 的机制设计（审计可落黑板、诊断可借黑板），也在 Q1③ 中用来防止「顺手给黑板加门」式的范围蔓延。

---

## Q1 角色「现任无人」的自愈（最重要）

**问题确认无误**：claim 落定是**永久**的——`settleRotation` 把 `current = pending.session` 写进同一笔 settings 更新（:4382-4403），且 M4 的 24h 回退**明确保留新任 current**（`expiredNotice` 原文「仍为 current（换届事实已成立，降格需用户显式操作）」:4464-4467）。此后若继任者死（或插件重载拆掉全部插件自建代理），`writerGate` 只认 `caller === incumbent`（:1756-1757）——一个死会话永远满足不了这条 ⇒ 会话路径全部拒绝。**前提成立**。

### ① 显式状态 vs 读取时判定：不新增持久状态，但把「读取时判定」升级为「在每个决策点判定」

| 判据 | 结论 |
|---|---|
| liveness 的性质 | `ctx.agents.get(id) === undefined` 是**进程内、瞬态、观察者相对**的事实（插件自己的 live registry；DSH 官方也声明 "Ambient presence is neither liveness proof nor authorization"，dsh-agent index.d.ts:193-197）。把它持久化 = 把一次观察写进事实源 |
| 持久化后的失效模式 | 插件重载后**全体**自建会话都 dead（§10.2.5 生命周期事实）——持久标记会全体变「vacant-due-to-death」，且**没有可靠的清除者**（谁负责把「已复活」写回去？复活与清标记之间的竞态怎么定？） |
| 与 schema 红线的关系 | roster 的 teams 键住在 settings 命名空间、经 schema 往返；加字段 = 改 schema = 踩 §10.3「schema 不改」红线，而且该命名空间**用户可手改**——一个用户可改的持久观察字段不提供任何完整性 |
| 既有词汇已够区分 | roster 已有「vacant」（`current=null`，retire 有意制造，:1875-1885）承载**有意空缺**；「seated-dead」（current 非空但无活代理）与它的区分**在读取时用既有 dead 判定即可派生**，不需要第三个持久状态 |

**结论**：不加持久状态。但「靠 list_sessions 判定」不够——list_sessions 是**人去看才存在**的诊断面，而砖态的第一次暴露通常是**某次被拒绝的写**。所以做三件事（都是渲染/文案层，零 schema 变更）：

1. **三个决策点渲染活性**：`roster get` 与 `roster.md` 镜像的「现任」行、以及 writerGate/rotateGate/retireGate 的**拒绝文案**，都附上活代理判定。今天这三个拒绝文案对「死现任」是**误导性**的（「只有现任协调者会话 X 可写」——但 X 写不了；:1751/:1757/:4287 同款）。改为：`现任 X 无活代理（dead）——写操作卡死，可 team_link_roster action=recover 恢复（需在场确认）`。
2. **两个诊断词派生而非存储**：`vacant（有意退役）` = current 为 null；`seated-dead（无活代理）` = `agents.get(current) === undefined`。两个词都从既有状态读出。
3. **启动清扫并入**：现有启动清扫只报 `pending-create` 孤儿（:5485-5492）；扩一行「各团队 current 无活代理的角色清单」（重载后全体自建代理皆死的场景下，这是用户看到的第一个信号）。

「无人读就无人发现」这一盲区**不靠持久状态修**：门拒绝时刻即诊断时刻（每次被拒的写都带诊断与恢复指针）；主动巡检只在团队**有看门狗**时搭既有 patrol 便车（patrol 定时器仅随注册存在，:1569-1573），无看门狗的团队不做定时巡检——这是边界，不是缺陷。

### ② 谁有权发起恢复：分层，且**不需要临时复权令牌**

| 主体 | 结论 | 理由 |
|---|---|---|
| 任意存活 roster 成员（v1 建议） | **可发起** | 发起权本身低风险：真正的权力在**人类确认对话框**（userQuestions 的答案只能由 UI 的人类给出，模型不能自答自己的对话框——与 claim 同一机制）。成员域是最小可辩护的发起域 |
| 旧任（已退役、信任已吊销） | **机制上仍能调用工具**（吊销只清通道，不清工具面；会话仍活、工具注册在插件根 ctx 上），但 **v1 不给发起权** | 它已不在 roster 成员域；revive 的对象是现任（继任者）、reappoint 的候选是成员——都与它无关。若实测 UX 需要，放宽为「任何活会话可发起」也安全（权力仍收在对话框），但 v1 收紧更干净 |
| 人类 | **设置 UI 保持既有超级写者**；新增的 recover 对话框即人类入口 | 不新增设置面；「对话框确认」就是人类授权本身 |
| 「临时复权」令牌 | **不需要，且应显式拒绝** | 令牌只有在**无人值守**场景才换得来价值（M4 用它是因为继任者可能无人值守 claim）；而恢复必须是 **attended** 的——无人值守恢复 = 常驻自任命机器 = 你最担心的那个后门。人类确认即凭证 |

### ③ 防滥用设计（你最担心的一点）：恢复是「两个封闭动词 + 一次人类确认」，不是第二把写门钥匙

机制：`team_link_roster action=recover`（或独立注册 `team_link_recover`，理由与 rotate 独立注册相同：演员与前置条件不同）。带 `team[, role]`；不带 role 时输出诊断（每角色一行：现任 + 活性 + 最近任期 + 可恢复方式），**零副作用**。两个恢复动词：

- **revive（复活）**：current 无活代理 → 确认框 → `ctx.agents.resume({ resumeSessionId: current, ... })`（dsh-agent index.d.ts:280-287 证实该 API 存在，语义「load persisted session and resume an agent on it」）。**身份不变、roster 不动、信任零改动**——复活不是换人，writerGate 不需要放行任何东西。
- **reappoint（改任）**：候选 = **插件计算**的当前存活 roster 成员（排除 dead current 本身）→ 人类逐项确认 → **复用 claim 的同一套** `applyRotationTrust` + `settleRotation`（域限定迁移 + 对称吊销，:4339-4403）→ 历史记「recovery」备注 + `rotationStatus` 记恢复词 → 广播 done 变体 → decisions.md 追加审计行（写黑板无门，砖态下也能落账）。

八条硬约束（把「绕过 writerGate 的后门」逐条封死）：

1. **封闭动词**：恢复只有 revive / reappoint 两个动词；**不接受**任意 roster 字段写入、不改 `policy.writer`、不换除 current 外的任何字段。reappoint 本质是「无令牌的 claim」——它继承 claim 的全部边界（域限定、对称吊销、正式通道），**不能授予任何 claim 授不了的东西**。
2. **attended-only**：两个动词都必须过人类确认框；**没有 provisional、没有 TTL、没有无人值守降级**；无确认服务 → fail-closed（与 §11.4.1 同款）。这是与 M4 claim 的**刻意不对称**：claim 允许无人值守是因为「回退窗口」；恢复修复的正是「无人可写」，无人值守自愈就是把「超级写者」常驻化。
3. **候选不可由模型指定**：reappoint 的候选列表由插件从 live 成员计算、以对话框选项呈现（与 claim 的逐项勾选同形态），模型只传 team/role，不传继任者 id。
4. **revive 绑定身份**：revive 只能复活该角色**当前的** current（一次性）；不存在「复活任意历史会话」的动词——那会让吊销形同虚设（退役者永远进不了 revive 的对象位）。
5. **writerGate 原样不动**：恢复后写权限依旧只属于 roster 认定的现任。恢复控制器与 rotation 控制器并列成为**唯二**的 policy 写者，不新增任何「超级写者会话」。
6. **恢复不自动降级 writer**：绝不把 `writer=coordinator` 改成 `any` 当「修复」——那是对团队的静默弱化。
7. **限速 + 审计**：复用/仿照 `rotationRateLimited`（:4264-4277）的窗口防对话框轰炸；每次恢复在版本史、roster.md 镜像、decisions.md 三处留痕。
8. **先清扫再动作**：recover 进入即跑既有过期清扫（roster 触达即扫的既有模式 :2057-2061），避免与在飞 pending 交错。

### ④ 失败模式与边界

| 失败模式 | 表现 | 边界/处置 |
|---|---|---|
| 假死（竞态） | recover 动作瞬间目标其实已活（人类正在侧边栏打开） | 动作前重查 liveness；对已注册 id 的 resume 会拒绝 → 如实报告「已活，无需恢复」，零副作用 |
| 无 factory / 无 sessionPersistence | resume 无法执行（index.d.ts:280-283：factory 缺失或 persistence 未配置即拒） | fail-closed 报告原因；退回 reappoint 或设置 UI 或侧边栏深链指引（§3.6.4 半自动退路） |
| **复活夺权**（本评审新增的重要边界） | resume 的 ownerCtx 是插件根 ctx ⇒ 复活后该代理的**运行时所有权归插件**，卸载即拆。对人类自建会话做 revive = 把它的生命周期从 UI 转给插件，比现状（插件重载不影响人类会话）**更差** | **v1 的 revive 只对插件自建会话**（§11 自建的继任者，本来就是插件所有）；人类自建会话的恢复走「深链指引，请人类侧边栏打开」 |
| 重载后再死 | 复活/任命后插件重载，全体自建代理又拆掉 | 生命周期事实（§10.2.5）；恢复可重复执行；启动清扫列出全部 dead 角色 |
| 任命后原会话复活 | dead current 被人类侧边栏打开，以非成员身份回来，inbox 照跑 | 其信任已在 reappoint 时对称吊销；按孤儿报告（复用 pending-create 可收编清单）；插件不自动关闭任何会话（§11.4.7） |
| 全队皆死（重载后） | reappoint 候选集为空 | 只剩 revive / 设置 UI；错误文本明说「没有存活成员可改任」 |
| 无看门狗团队 | 无人读 roster 就无人发现 | 门拒绝=检测时刻；主动检测只在有 watchdog 时搭 patrol 便车（:1570-1572 定时器仅随注册存在） |
| 恢复对话框无人应答 | 人类不在场 | 无自动路径（约束 2）；失败即报告，不留下任何半状态 |
| 死在 prepare→claim 窗口 | current 死时 pending 在飞 | 进入即清扫：过期 pending 照常 rotation-cancelled；未过期的先复活旧任再走原流程 |
| 跨进程/单写者 | 另一 DSH 进程或侧边栏已打开目标会话（H1 同款风险） | resume 失败即如实报告；指引「若侧边栏已打开则无需 recover」 |

---

## Q2 交接文档的内容契约

§11.4.3 只有「头部元数据 + 模型正文」，确实不足。建议**三层结构 + 分层缺项政策**。核心原则沿用 §3.6.2 的「**机制与判断分离**」：插件写一切**机制事实**（它拥有的事实源），模型只写**判断**。

| 层 | 字段（最小集） | 写者 | 缺项/失败政策 |
|---|---|---|---|
| **头（YAML）** | `schema: team-link-handoff-v1`、`team`、`role`、旧任 id、新任 id、`preparedAt`、`claimedAt`、**令牌掩码**（永不明文）、`rotationStatus`（已批准/待批准(24h)/无待迁移对/recovery）、历史备注 | 插件（机器生成，逐字段校验） | 插件自身故障：写失败**不阻断换届**（部分成功不回滚：正文已随令牌投给继任者，磁盘副本是冗余）——降级 = 大声报告 + 下次 roster 触达重试；但**结构非法（控制字符等）必须 fail-closed 不落盘** |
| **事实段** | 迁移 pairs 清单（含 provisional 标记与到期时刻）、未迁移/随退役清理清单、对称吊销明细（trustedSenders/rememberTargets 移除项）、freeze/done 广播摘要（**含 no-agent 未投递名单**）、provisional 回退窗口截止与补批准路径、上/下一份交接文档路径 | 插件（与 claim 返回文案**同一事实源**，不可两处口径） | 同上层 |
| **正文** | 六个必含节：**§任务与当前目标**（角色当前 goal 相位/rounds/armed 状态——上任首动就是 /goal resume，文档必须说清有没有 goal 可续）；**§在飞与交接瞬间**（未完成的承诺、冻结清单余项、看门狗注册、在途消息）；**§纪律与协议指针**（discipline.md/decisions.md 路径 + baseHash + 文档之外的口头纪律）；**§信任与通道现状**（谁已配对/谁 provisional/谁走首问门——插件事实给出「是什么」，模型补充「为什么、下一步该信谁」）；**§已知风险与陷阱**；**§上任第一步清单** | 旧任模型 | 见下 |

**缺项政策（三层，与题面三选项的取舍）**：

1. **正文全缺（`handoff` 参数缺失或空）→ 拒绝换届**：fail-closed，明示「请补交接正文」。理由：§11 的全部意义就是防「换届丢上下文」；一份空正文的换届正是它要防的事故。代价只是一次重试（已建的会话进 §11.5 孤儿清单，已有机制覆盖）。
2. **正文存在但缺必含节（结构 lint：节标记 + 每节非平凡长度）→ 警告 + 降级，不拒绝**：把缺项清单写进 §11.4.1 的确认框（「正文缺少 §在飞、§下一步」），**人类决定**继续或取消。理由：插件无法判定语义质量，草稿缺陷不该卡死一次人类已确认的换届；但缺陷**必须可见，绝不静默接受**——且要在文档内落一条「正文缺项：…」横幅，让继任者与事后审计都看见。
3. **语义质量（内容错误/误导）→ 不判定**：机制/判断分离的边界。第二道人工关口是 claim 对话框，事后审计靠磁盘文档。

**体积与卫生纪律**（对齐 §10.1.2 的既有数值纪律，改的是数值不是风格）：正文总量上限（建议 4000 码点，分节各 ≤1000，超限截断 + 显式标注，同款 `truncated` 语义）；整篇过 `wellFormed`；令牌只进掩码；文件名时间戳天然去重（§11.4.3 已定）。**发现路径补一条**：路径目前只在 rotate 返回文案与换届汇总里（§11.4.3）——会话一滚就丢。建议**往 decisions.md 追加一行指针**（写黑板无门，且是团队共同账本），并在 roster get/镜像里渲染「最近交接文档路径」。

---

## Q3 H3 的退路

**事实核查（比 §11.2 的表述更精确）**：

- `CommandResult` 确认为 `{kind:'success'; text?; sourceEventSeq?} | {kind:'error'; text}`，注释原文 "**Expected command outcome rendered directly by the dispatching UI**"（[types.d.ts:32-41](D:/DSH-Portable/profile/profiles/web/node_modules/@deepseek-ai/dsh-commands/lib/types/types.d.ts)）——进不了模型上下文。另见 `command/run`/`command/done` 事件定义为 "**Log-only (never model surface)**"（:89-119）。§11.2 的前提成立；唯一小更新是 success 变体还带 `sourceEventSeq`，但它指向「更早的权威域事件」——交接文档是文件不是事件，且 §10.3 禁新事件类型，**此路不通**。
- 但 `CommandInvocation.agent` 是**活代理的完整运行面**：`followup(message)` 的官方语义正是「Queue an ordinary follow-up turn and wake the driver. **The item becomes the sole ordinary message of its own turn**」（[runtime-types.d.ts:186-200](D:/DSH-Portable/profile/profiles/web/node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts)）——**恰好就是「下一回合补正文」需要的语义**。自驱动的先例在 V1（goal 驱动器对自己的会话 followup）与插件自身的 watchdog tick（:1409-1410）都成立。H3 的残余风险只是**行为验证**（从 UI dispatch 路径里 followup 的唤醒是否如预期），而非 API 存在性——失败概率低，且失败模式良性（见下）。

**比「退回工具入口」更好的替代：两段式拆分（机械现在做，正文下一回合补）**——评审**推荐采纳**，并取代 §11.2 的「只 nudge」原案：

1. **Stage 1（命令 handler，纯机械）**：rotateGate 预校验（快速失败）→ §11.4.1 确认框（此时只覆盖「建 1 个会话」）→ `agents.create` 根会话（复用 §10.2.2/§11.4.2）→ `invocation.agent.followup(指令)`，指令携带**建好的会话 id** + Q2 的正文契约 + 「调用 `team_link_rotate action=prepare, successor=<id>, handoff=<正文>`」→ CommandResult 给人类一句摘要（命令自带顶层 CommandNode 行，可见性免费）。
2. **Stage 2（模型下一回合）**：模型起草正文 → 调 prepare（此处才铸令牌、才写完整交接文档、才广播 freeze）→ 后续与 §11.3 原时序完全一致。

**关键设计决定：命令绝不提前铸令牌**。若命令连 prepare 一起做，冻结会先于正文存在；模型若没续上，团队白冻结 30 分钟 + 落一份空正文文档（违反 Q2 契约）。机械/判断的切点必须在 prepare 之前——这同时让「模型不续」的失败**零代价**：没有令牌、没有冻结、团队不卡死，只有一个孤儿会话（§11.5 已覆盖报告）。

**可行性**：高。Stage 1 全部复用已实现面（② 的 create、M4 的 prepare、userQuestions）；Stage 2 就是既有工具入口。**新时序成本**：只是 §11.3 时序图里现任与插件之间多一条自 followup 消息——不是新机制，是既有机制的又一次使用。

**风险与处置**：

| 风险 | 评估 | 处置 |
|---|---|---|
| 模型不调 prepare | 零令牌零冻结，团队**不卡死**（本设计的安全性质所在） | 孤儿会话进清单 + 汇报 |
| 模型换了别的 successor id | 仍属合法 M4 语义（现任本就对任何继任者 id 有主张权）；自建会话变孤儿 | 指令明示 id；可选幂等：同 team+role 的 fresh `pending-create` 判重复用 id（② 的按 role 幂等模式） |
| **H3 失败**（followup 抛错或被宿主拒） | 概率低（运行面公开、无守卫；先例存在）；失败模式**良性**：唯一依赖 H3 的步骤就是那条自 followup | catch 后把**同一份指令文本**写进 CommandResult 返回给人类（转贴即降级为 §3.6.4 半自动）——比原案的降级（纯 no-op + 错误文本）强一档 |
| 回合预算 | 自 followup 是普通 user/message，**不消耗 goal 轮**（V2/V3：非 goal 消息只 defer 不吞轮） | 无需处理 |
| 双触发 | 人类连敲两次 → 两次确认框 + 两个会话 | 每次都有确认框；孤儿可收编 |
| 运行中收到命令 | followup 语义：成为**自己的下一回合**（不打断当前回合） | 正合需求，无需分支 |

**对比三个候选**：原案（只 nudge，无机械产出）与两段式**承担完全相同的 H3 假设**，却少交付全部机械步骤——两段式是原案的严格支配；「命令全自动（模板正文）」违反机制/判断分离，且冻结先于正文；「退回工具入口」是 H3 全灭时的底线，而两段式在 H3 失败时**自动降级到半自动**（§3.6.4），不是退回。**结论：值得为它加这一条时序（一条消息的代价），并把「两段式」写成 `/team_rotate` 的主设计，H3 只决定「指令是 followup 投出还是写进返回文本」，不再决定命令是否废掉。**

---

## 三个问题的评审结论

| # | 结论 |
|---|---|
| Q1 | **不新增持久「死现任」状态**：liveness 在读取时判定，但把判定焊进三个决策点（roster get / 镜像 / 各 gate 拒绝文案）+ 两个派生诊断词。恢复 = 两个封闭动词（revive 限插件自建会话 / reappoint 复用 claim 迁移）**+ 强制人类确认、无无人值守路径、无令牌**——人类确认就是反后门锚点；writerGate 与 policy.writer 一律不动。 |
| Q2 | 交接文档 = 插件写头与事实段（机制）+ 模型写六节正文（判断）。**全缺 → 拒绝；结构缺项 → 确认框明示 + 人类裁决；语义质量 → 不判定**。发现路径补 decisions.md 指针。 |
| Q3 | 采纳**两段式**：命令做「建会话 + 自 followup 指令」，正文与 prepare 由模型下一回合完成；命令**绝不**提前铸令牌。H3 失败时降级为半自动而非退回工具入口。 |
```

#### [4] kimi-api:kimi-k3（12377 字）

```text
评审完成。以下为三题的只读设计评审（机制、边界、失败模式；无代码）。所有关键论断均已对源码/设计文档取证，引用格式为 `文件:行号`。

---

# §11 自动换届交接 — 三题设计评审

## 0. 前提复核（评审依赖的事实，逐条核实）

| # | 事实 | 出处 |
|---|---|---|
| F1 | `writerGate`：`policy.writer=coordinator`（默认）时仅 coordinator **现任**可写；空缺时会话路径**全拒**，明示「用户经设置 UI 永远是超级写者」 | [index.js:1746-1760](D:\DSH-Portable\plugins\dsh-team-link\lib\index.js) |
| F2 | `retireGate` 独立于 writer 策略：任何团队（含 writer=any）退役都只有现任 coordinator 会话能发起 | index.js:1768-1778 |
| F3 | `rotateGate`（prepare）：只有**该角色自己的现任**会话可发起；coordinator 也**不能**替 worker 角色发起换届 | index.js:4282-4290 |
| F4 | claim 落定后 provisional 过期回退**只删 pairs**：「新任保持 current（换届事实已成立，降格需用户显式操作）」 | index.js:4464-4466；主设计 §3.6.2 评审 #5 |
| F5 | 活性判定是**读取时**计算：`ctx.agents.get(id) === undefined` → `not-live` → verdict `dead`；广播的 `alsoNotify` 也只并活代理 | index.js:483-510、4529 |
| F6 | DSH 重启后所有代理死亡，「请在侧边栏打开目标会话一次使其恢复为活动代理」——**resume 后 session id 不变、pairs 按 session id 键控，零信任手术即全恢复** | index.js:2920 |
| F7 | DSH 源码原话：「Ambient presence is neither liveness proof nor authorization」 | dsh-agent/lib/types/index.d.ts:197 |
| F8 | §3.6.2 伪代码的 prepare 授权本来就是 `exec.agent.id === roster[role].current **\|\| userInitiated**`——「用户发起」是设计内生的第二授权源，实现版把它窄化成了「设置 UI」 | 主设计 §3.6.2:321-323 |
| F9 | 命令 handler 拿不到模型上下文：`CommandResult = {kind, text}`，"rendered directly by the dispatching UI"；`command/run`/`command/done` 是 log-only、"never model surface" | dsh-commands types.d.ts:32-41、index.d.ts:117-125 |
| F10 | 但 `CommandInvocation.agent` 是**完整 Agent**，且 `Agent.followup`（"Queue an ordinary follow-up turn **and wake the driver**"）与 `Agent.steer`（"**An idle driver starts a turn**"）都在公开类型面上 | dsh-commands index.d.ts:23；dsh-agent runtime-types.d.ts:192、200 |
| F11 | 命令 handler 做机械大件已被 ② 实证：`/team_session` 在 handler 里完成确认框 + `agents.create` + roster 登记 + pairs 写入（writerGate 用 `invocation.agent.id` 过门） | index.js:4099-4154 |
| F12 | 黑板写**无权限门**（读有）；死锁面只在 roster 写 / rotation / retire | index.js:2270 |
| F13 | `pending` 全量存设置（含完整 token，仅渲染掩码）；`pendingCreates` 意图 + 启动清扫 + 可收编清单已落地 | index.js:4623、564-573、4204-4223 |

**死锁的精确边界**（Q1 问题的 scope 修正）：死锁 ⇔ `policy.writer=coordinator`（默认）**且死的是 coordinator**。死的是 worker 时链条仍在：活 coordinator 可 `retire` 该角色（F2 只查 coordinator）→ 清理死 pairs → `set-role` 新 worker → 走首问门重建——丢信任拓扑但不死锁。writer=any 团队任何会话可 `set-role` 补 coordinator，也不死锁。**所以 Q1 的硬死锁只有一格：默认策略 + coordinator 现任死亡。**

---

## Q1【最重要】角色「现任无人」的自愈

### 0. 先修正问题框架：死亡 ≠ 需要换信任

roster 的 `current` 指向的是**会话 id**，pairs 也按会话 id 键控（F6）。「代理死亡」只意味着没人能唤醒它；**在侧边栏重开该会话 = 原 id 复活 = 全部信任通道原样恢复**，一次信任手术都不用做。真正的洞不是「死了怎么办」，而是：

1. **用户不知道可以重开**（可诊断性缺口）；
2. **不该/不能重开时**（会话损坏、前任是临时会话、用户就是想换掉它）没有任何会话可达的路径（机制缺口）。

因此恢复机制是**三级阶梯**，逐级升级、逐级别更贵：

| 级 | 手段 | 信任手术 | 何时用 |
|---|---|---|---|
| L1 | 侧边栏重开原会话（resume） | 零 | 默认首选——死亡绝大多数是重载/重启假象 |
| L2 | **break-glass recover**（本评审的新机制） | 走完整 M4 claim | 现任不会/不应再回来 |
| L3 | 设置 UI 直接改 teams 键 | 手工 | L2 的前置条件也不满足时（永远可用） |

### ① 显式「vacant-due-to-death」状态？——**不要持久化新状态，要读取时判定 + 可诊断面**

**结论：不加持久化的显式状态。** 四条理由：

1. **死亡是宿主持有的易变事实**（agent 注册表在不在），不是插件的持久事实。落盘一个「vacant」标记，用户一侧边栏重开它就过期——而清除它又得靠每次读取重查活性，标记立即冗余。**过期标记比没有更坏**：若门按标记行事，复活的原任会被自己的角色错误拒绝、或他人被错误放行。
2. 读取时判定**已经存在且零成本**：F5 三处都在用同一个 `agents.get` 读数，无新机制。
3. §10.3 红线：新增持久化 key 需「闭环必需的持久性」。死亡检测恰恰**不需要**持久性；需要持久性的部分（history 备注、roster.md 镜像、pending 槽） already 都在。
4. 「现任无人」的两种形态在现有数据里本就可区分：`current === null`（retire 的刻意空缺）与 `current = S ∧ agents.get(S) === undefined`（悬空指针）。recover 两种都受理，确认框里说明是哪种即可。

**唯一值得做的「显式」是显式证据与显式诊断，不是显式状态**：

- **诊断下沉到报错**：三道门（writerGate / rotateGate / retireGate）保持纯函数不动；**工具层**在门拒绝且能读到「现任无活代理」时，给报错追加一行恢复指引（L1→L2→L3 阶梯）。这把每一次失败的写都变成一次诊断。
- **roster get / team_read 的 roster 概要**对 dead 现任加一行注记（现在是静默的——roster 只渲染 id，活性要去 list_sessions 才看得到）。
- **明确否决**「巡逻主动告警 coordinator 死亡」：插件重载 = 全队代理同时死亡（§10.2.5），巡逻一告警就是**每次重载一场误报风暴**；且 `broadcastNotice` 对无发送方身份的通知按设计不发送（index.js:4520-4521）。读面暴露 + 人类节奏即可。

### 恢复机制：`team_link_rotate action=recover` —— 「人类对话授权的 prepare」

**核心洞察（F8）**：原设计的 prepare 授权本来就有 `|| userInitiated`，实现把它窄化成了设置 UI 手工编辑。recover 不是发明新授权，而是**把「用户发起」做成工具面一等公民**：机器守门 + 人类一次点击，替代手工改 JSON。

机制（全部复用既有件，无新状态时序）：

1. **机器前置**（全硬校验，任一不满足即拒、不弹框）：
   - `current === null` **或** `agents.get(current) === undefined`（A4 事实，不可伪造）；
   - 该角色**无在飞 pending**（有就让它 claim 或过期清扫，不插队）；
   - 速率限制：与 `rotationRateLimited` 同窗口，另加 recover 专属更长冷却（建议每 team 60 分钟——破窗应当罕见）；
   - **发起者资格**（见 ②）。
2. **人类授权**：一次 `userQuestions.ask`（与 M4 claim 同服务同形态），框内**必须**写明：团队/角色、现任死亡证据（「会话 S 无活代理，读数 T」）、**全队活性概览**（「N/M 成员当前无活代理——若刚重载插件/重启 DSH，请先走 L1 侧边栏重开」）、发起者是谁、提议的继任者（含 **auto**，复用 §11.4.2 自建）、自荐高亮、以及「随后将广播冻结、继任者凭令牌 claim、按 M4 语义迁移并对称吊销」。**无确认服务 / 取消 / 超时 → fail-closed**，报错指向 L3 设置 UI。
3. **写时复检（TOCTOU）**：对话框横跨任意长的人工等待——`policy.update` 前**重读活性**，原任已复活则中止（「S 已恢复活性，请走正常 prepare」）。这与 retire-cleanup 对话框「写前重读视图」是同一防御（index.js:2235-2247）。
4. **然后逐字走 prepare 的机制**：铸令牌绑定 (team, role, successor)、`rotationBackup` 快照（此刻快照的是死亡现任的信任遗存，claim 时对它的「对称吊销」实为纯清理）、广播冻结——**通知文案用独立措辞**（「recovery：现任 S 死亡，由 I 发起、用户确认」），全队知情。
5. **claim 逐字不动**（红线 §11.6）：令牌、域限定迁移、对称吊销、确认框或 provisional+24h 全部保留。人类在 recover 框点过一次，claim 时还会再过一次对话框（或无人值守走 provisional）——**两道人类关卡 + 24h 回退网，不合并、不省略**。

### ② 谁有权发起

把「发起」「授权」「执行」三权拆开答：

- **授权**只有一个来源：**人类在 recover 对话框里那一下点击**（fail-closed）。这与全插件的信任授予模型一致（claim 迁移、/team_session 配对授权、§11.4.1 建会话确认，全是这一个模式）。
- **发起**（触发弹框的资格）：**在世**会话，且 ∈ {该角色**最近一任前任**（history 里最后一条 `until ≠ null` 的 tenure）} ∪ {**团队现任成员**（teamMembers）}。理由：
  - **旧任可以发起**——它虽被对称吊销（pairs/trustedSenders/rememberTargets 清零），但发起权从不依赖信任，只依赖身份资格；它有最完整的上下文，且「回聘旧任」是最自然的恢复（旧任提议自己继任，claim 时从死亡继任者的遗存里按域限定规则迁移重建——被第一次换届丢弃的旧 pairs **不**复活，走首问门重建，见 ④ 边界）。拒绝它发起反而把最常见的恢复人挡在门外。
  - 任意**外部会话**不可发起——在弹框之前就被资格门拒掉。
  - **人类会话**：工具门无法机器区分「人类驱动会话」，所以人类因素**只**经由对话框与命令门进入——这是如实声明，不是漏洞。
- **「临时复权」令牌**：**不需要新令牌**——pending 本身就是那张临时复权令牌（绑定三元组、一次性、30 分钟 TTL、全量落盘 F13）。recover 改变的只是**铸币权**的守门（死亡事实 + 资格 + 人类点击，替代现任身份），铸出来的币与 prepare 完全同构。这保持了单一机制、单一审计面。
- **执行**（claim）：只有 pending 指定的继任者本人凭令牌——逐字既有语义。

### ③ 防「绕过 writerGate 的后门」——分层论证

这是您最担心的面，逐条威胁过：

1. **recover 确实写 roster，它不是「没有门」，而是「另一道更严的门」**。writerGate 守通用 roster 写（身份门）；recover 的门 = 死亡事实（不可伪造，宿主事实）+ 发起资格 + **人类点击** + 双速率限制 + 写时复检 + 全队广播 + 版本史备注。设计原则：**每条写路径都有自己的门，recover 不是 writerGate 的缺口而是与 M4 claim 同级的人类在环授权**。
2. **伪造死亡**：不可能经本插件——成员没有任何 API 拆掉别的会话的代理（插件持有的 handle 只在卸载时统一 dispose，模型面无 dispose 入口）。等自然死亡窗口（DSH 重启后全员死亡）确实会来，但窗口里每次 recover 都要过人类弹框，且框内有全队活性概览 + 「先走 L1」提示。
3. **链式提权**（最险的一条）：成员篡位 coordinator → prepare 给同伙 → 迁移 pairs。每一环都撞墙：recover 弹框（人类看自荐与证据）→ claim 令牌（只有被指定者能 claim）→ claim 自己的对话框或 provisional+24h 回退（第二道人类关卡）→ 每一步**全队广播 + 版本史留痕**（ stealth 不可能）。对照 F7：本设计**刻意不从活性推导授权**——活性只开门禁（允许提议），授权永远在人的点击上。
4. **效应最小特权**：recover 只能作用于「死的那个角色」——不能碰 policy、不能碰其他角色、不删 history（只追加）、不恢复第一次换届前的旧 pairs。它没有 set-role 的通用性，比 writerGate 的授权面**更窄**。
5. **诚实残余风险**：人类无脑点确认则一切门皆失效——但这是全插件统一的授权模型，recover 不新增这一风险类别；缓解 = 弹框内容硬性清单（①所列各项缺一不弹）+ 冷却 + 透明广播。

### ④ 失败模式与边界

| # | 失败模式 | 行为 |
|---|---|---|
| a | 无确认服务 / 取消 / 超时 | fail-closed，零变更，报错指向 L3 设置 UI |
| b | 无合格发起者在世（单人团队、coordinator 死亡、无前任） | 工具面如实不可达 → L3；这是**声明的边界**，不是缺陷 |
| c | 现任其实活着 | recover 拒：「recover 仅用于现任无代理/空缺；正常换届走 prepare」 |
| d | 有在飞 pending | 拒：等 claim 或 30 分钟过期清扫 |
| e | 弹框期间现任复活（TOCTOU） | 写时复检中止，零变更 |
| f | recover 已 prepare、插件重载于 claim 前 | 令牌 30 分钟过期 → 既有 sweep 取消并解冻；自建继任者进 §11.5 可收编报告；可重发 recover（冷却内被拒则等） |
| g | 继任者 claim 后**又**死（问题递归一层） | recover 可再次发起；每轮都过人类点击；双冷却封顶churn。**recover 不预防复发，它把每次发作从「设置 UI 手术」降为「一次弹框」** |
| h | 恶意发起者刷弹框 | 冷却 + 每次尝试全队广播（透明即威慑）；弹框疲劳为残余风险 |
| i | 黑板/ workspace / 团队行被手删 | 不在 recover 范围（schema normalize 兜底，L3 修复） |

**边界声明**：① recover 不保证复原**第一次换届前**的信任拓扑（那批 pairs 在第一次 claim 时已按域限定规则丢弃；从 rotationBackup「整体还原」绕过了对端同意模型，v1 不做——若做 v2，必须套 provisional+24h 外壳才符合原则 4）；② recover 对 writer=any 团队与死 worker 不是必需（既有 retire/set-role 链可达），但机制对各角色一致开放以保持权力模型干净——**recover 的授权从不源自 coordinator 身份**（否则就是给 coordinator 新增了「轮换他人角色」的权力，而 F3 刻意没给它）；③ 死协调者 + writer=coordinator 是唯一硬死锁格，其他格 recover 是「保信任拓扑的更优解」而非「唯一解」。

---

## Q2 交接文档的内容契约

**双重受众先摆正**（这决定缺项策略的严厉度）：正文经 §11.4.5 的 followup **进入继任者模型上下文**（活着的交接），落盘文档是**审计 + 人类可读 + 事后重读**（§11.4.3）。同源一份正文、两处承载。所以「空正文」伤害的是继任者本身（拒绝级），「缺小节」伤害的是文档质量（警告级）。

### 字段级最小结构

**头部元数据（插件写，机器生成，模型不可控）**：

| 字段 | 说明 |
|---|---|
| team / role / 前任 id / 继任者 id | 四元组 |
| prepareAt（ISO）+ 令牌**掩码** `tok-xxxx…yyyy` | 明文令牌只允许存在于 followup 一次 |
| workspace / 黑板根 / roster.md 路径 | **指针**，不复制内容（防过期副本） |
| 前任 model/preset ↔ 继任者 preset/cwd | 成本与能力口径的留痕 |
| 上一份同角色 handoff 文档名（可发现则填） | 交接链，v1 可空 |

**正文（模型写，模板由工具描述提供，插件校验）**——必填 5 节 + 推荐 3 节：

| 节 | 必填 | 缺了会失去什么 |
|---|---|---|
| 1. 当前焦点 | ✅ | 继任者不知道「接着干什么」：goal 状态、正在做的事、下一步 |
| 2. 未了事项与在飞承诺 | ✅（可写「无」） | 对端 + 待办 + 期限逐条；丢承诺 = 团队失信。含看门狗注册等**随旧任死亡的周期任务**（继任者需重新注册） |
| 3. 团队成员与对端 | ✅ | roster.md 指针 + 每成员一行（角色→会话 id→分工）；瞎发消息 |
| 4. 纪律与现行例外 | ✅（可写「无例外」） | discipline.md 指针 + 当前生效的偏离；重蹈违规 |
| 5. 信任与通道 | ✅（可写「无」） | 预期迁移的对端清单（应对得上 claim 对话框）、已知 provisional 状态与 24h 期限 |
| 6. 近期决策摘要 | 推荐 | decisions.md 尾部摘要或「读最近 N 条」指引；重翻已决争议 |
| 7. 风险、坑、用户偏好 | 推荐 | 自由文本；重复已知的错 |
| 8. 上任首批动作 | 推荐（插件给默认骨架） | claim → 建 goal（armed-active = 内建心跳，§3.6.2 已有此提示）→ 向全队报到；防「claim 完呆坐」 |

### 缺项策略（拒绝 / 警告 / 降级阶梯）

| 情况 | 处置 | 理由 |
|---|---|---|
| **正文为空**（trim 后） | **拒绝 prepare**，且在确认框/建会话/冻结**之前** fail-fast | 无交接的自动换届违背 §11 全部初衷；这不是「质量差」，是「没交接」 |
| **正文含完整令牌**（子串扫描 pending.token；`tok-` 模式给警告） | **拒绝**（让模型删了再来） | 明文令牌落盘 = 掩码机制作废；令牌只允许「followup 一次」 |
| **超长**（建议整文上限 ~8000 码点量级） | **拒绝并要求压缩，不截断** | 截断是悄悄丢判断；压缩是模型做的判断（机制与判断分离） |
| **缺必填小节**（标题匹配） | **警告 + 如实标注**：文档内该节写「（本节缺）」、followup 点名、换届汇总点名 |  prose 质量是判断不是机制；为散文卡住一次换届 = 用可用性换文档质量。继任者已从 followup 拿到正文全文 |
| 控制字符 | wellFormed 机械处理（既有件） | 全插件统一 |

**机制落点**：校验全部发生在 `prepare(successor:"auto")` 的**最前**（validate → §11.4.1 确认框 → create → 写文档 → freeze → followup），任何拒绝都是零创建零冻结。模板放进 prepare 的 `handoff` 参数描述里——模型填骨架比自由发挥合规率高，且插件的小节检查随之廉价（标题匹配）。验收增量建议补一条 U25：空正文/含令牌/超长拒绝 + 缺节警告标注。

---

## Q3 H3 的退路

### H3 前提复核：比 §11.8 写的乐观——有**两个**候选机制

F9 确认：命令返回值进不了模型上下文，这条死了。但 F10：`CommandInvocation.agent` 是完整 Agent，而类型面上**两个**方法都满足「推一把」：

- `followup(msg)`：排队一个普通后续回合并唤醒驱动（runtime-types.d.ts:192）；
- `steer(msg)`：**空闲驱动会开一个回合**（runtime-types.d.ts:200）。

命令契约只说「执行而不把命令发给模型」，**没有任何条文禁止 handler 驱动自己的 agent**；`execute()` 的 `command/done` 在 handler 返回即落定，回合在其后独立展开——时序干净。所以冒烟方案应是：**首选 followup，steer 为同 UX 的内置 plan B**。冒烟四项：① 空闲时推 → 开回合、模型照指令起草并调工具；② 回合进行中推 → 排队为下一回合、无串扰；③ `command/done` 先落定、回合后独立运行（不受 `invocation.signal` 撤销牵连）；④ 源字段三成员红线 + 「发件人=自己」的文案前缀（§10.1.4 的自回环顾虑用文案与「模型的回应是工具调用而非自答」来化解）。

### 评估「命令做机械半（建会话/出令牌），正文下一回合补」

**机械半从命令 handler 做，已被 ② 实证可行**（F11：确认框/建会话/登记/pairs 全在 handler 里跑通过）。但这个提案有一个结构性死穴：

> **「下一回合」不会自己知道欠了一份正文。** CommandResult 进不了模型上下文（F9）——除非人类再开口催。所以该提案的真实形态 = **人类催一次 + 一套新的两阶段时序**，而它的「更好」恰恰要省的就是这一催。

若按原样做（命令侧 prepare 出令牌 + 广播冻结，模型后补正文），代价单：

1. **新的中间持久态**「已 prepare 未交付」：令牌已铸、**冻结已广播、正文缺席**——全队停哨兵干等一个可能永远不来的回合；唯一兜底是 30 分钟 TTL。§11 单调用设计里 freeze→claim 是秒级，这里 freeze 时长 = 人类+模型延迟。
2. 若反过来「先铸令牌不广播冻结」，则改动 M4 prepare 语义本体（冻结是 prepare 的组成）——撞 §11.6 红线。
3. 机制被**劈给两个行为者**（命令做一半、工具做一半），第二半要求模型「知道要调某个新动作」——而模型恰恰无从得知。
4. 新工具动作/新模式 + 新文案 + 新测试 + 新失败窗口，换一个「斜杠菜单可发现性」。

**裁决：这个形态的「两阶段 prepare」不值得引入新时序。**

### 但提案里藏着一个**无新时序**的干净变体，值得收编

把「机械半」收窄为**只建继任者 + 写骨架交接文档**（不 prepare、不铸令牌、不冻结），正文由旧任模型下一回合调**既有** `prepare(successor:<已建id>, handoff:正文)`——零新 rotation 状态、零新令牌语义：

**H3 失败时的退路阶梯**（按序采用）：

1. **L1 引导壳命令**：`/team_rotate <role>` 保留，但降级为**校验 + 指路**——handler 做现任校验（rotateGate 等价）、活性检查，然后返回一段**写给人类看**的 CommandResult：「请对本会话说：把 coordinator 交给一个新会话（附你的交接要点）」。零新状态、保留斜杠菜单可发现性、校验前置、报错清晰。成本近零，严格优于裸「退回工具入口」。
2. **L2 预建变体**（若 L1 实践中太绕）：命令建继任者（复用 ② 的 create 全套：pending-create 意图、上限、确认框写明「将建 1 个会话供换届」）+ 写骨架交接文档 → CommandResult 指路 → 模型走标准 prepare。孤儿由既有 pending-create 清扫 + §11.5 报告覆盖；**冻结窗口完全不受影响**（prepare 仍在工具调用里原子完成）。
3. **两阶段 prepare**：明确**推迟**，仅当 L1/L2 实战证明单调用太重再议；且若真做，冻结必须留在 claim 侧阶段，不能拆 prepare 语义。

**风险提示（即使 H3 成立）**：推送指令以 user/message 进旧任上下文（透明可审计，优点）；旧任可能在回合中（排队，无碍）或有 armed goal（正常交错）；命令打在**非**现任会话 → 校验即拒（好事）。这些都不构成新时序。

---

## 交付摘要

| 题 | 一句话结论 |
|---|---|
| Q1① | **不落显式状态**；读取时活性判定（已有）+ 诊断下沉到三道门的报错与 roster 读面；否决巡逻主动告警（重载误报风暴） |
| Q1 机制 | 三级阶梯：L1 侧边栏重开（零手术，首选）→ L2 `action=recover`（死亡事实 + 前任/成员发起 + **人类弹框授权** + 写时复检 + 逐字复用 prepare/claim）→ L3 设置 UI；**不需要新令牌**（pending 即复权令牌），recover 只是 prepare 的第二铸币门（§3.6.2 的 `userInitiated` 扶正） |
| Q1③ | 无后门链：活性只开「提议权」，授权永远在人类点击；claim 对话框/provisional+24h 为第二道关；全队广播 + 版本史使 stealth 不可能；效应限死在死的那个角色 |
| Q2 | 头部 5 字段（插件写）+ 正文 5 必填 3 推荐（模板进工具描述）；**空正文/含令牌明文/超长 = 拒绝，缺小节 = 警告 + 三处标注** |
| Q3 | H3 有 followup **和** steer 两个类型面候选；「两阶段 prepare」不值得新时序；退路 = L1 引导壳命令（近零成本）→ L2 预建继任者 + 标准 prepare（无新 rotation 状态）；两阶段 prepare 推迟 |
```

## §2 逐问裁定（**主代理写**）

> 3/4 交付（glm-5.3 / deepseek-v4-pro / kimi-k3；codex-cli 进程失败无内容）。三条均为源码级完整评审，**且三条都纠正了我送审的问题前提**。逐条一个处置。

### Q1 —— 角色「现任无人」的自愈

| # | 来源 | 意见（要点） | 处置 | 理由 / 落点 |
|---|---|---|---|---|
| K1 | kimi | **死锁边界精确化**：硬死锁**只有一格**——`policy.writer=coordinator`（默认）**且死的是 coordinator**。死 worker 时活协调者可 `retire`+`set-role` 重建（丢信任拓扑但不死锁）；`writer=any` 则任何会话都能补位 | **采纳** | 我原题设写成「团队卡死」过宽。落点：§11 新增小节「死锁的精确边界」 |
| D1 | deepseek | **黑板写不过 `writerGate`**（工具描述与代码 `:2270`/`:2333-2364` 均无门）⇒ 锁住的是 roster 变更 / rotation / `/team_session` 登记；`team_link_send` 与 decisions.md 仍通 | **采纳** | 同上。诊断文案必须说清「能通讯、不能改身份」，否则成员会误判全瘫 |
| K2 | kimi | **最关键的重新框定：死亡 ≠ 需要信任手术**。`current` 是**会话 id**、pairs 也按会话 id 键控 ⇒ **在侧边栏重开该会话 = 原 id 复活 = 全部通道原样回来**，零信任手术。真正的洞是两个：① 用户不知道可以重开（可诊断性）；② 不该/不能重开时没有会话可达的路径 | **采纳** | 我的题设默认「信任已迁移 ⇒ 只能换人」，漏掉了最便宜的零手术路径。落点：§11 恢复**分两级**，revive 为第一级 |
| G1 | glm | 死法有时序三分，其一**已有出口**：死在 prepare 后 claim 前时，claim 的门只看「caller === pending.session + 令牌」（`:4738-4743`）、**不看旧任活性** ⇒ 继任者照常 claim、团队自然解锁 | **采纳** | 落点：§11.5 失败表新增此行（现有实现已支持，只需写真） |
| G2 | glm | **不持久化「vacant-due-to-death」状态**：roster 是记录不是活性镜像（既有原则「a dead member keeps its no-agent row」`#L4523`）；插件重载会**集体**翻状态（§10.2.5）而其中多数下一分钟就能被点开复活；「刻意空缺」(`current=null`) 与「死亡空缺」语义必须可分，否则两种场景都拿到错误指引 | **采纳** | 三条理由都成立 |
| D2 | deepseek | **不新增持久状态**（独立得出同一结论）：liveness 是进程内、瞬态、**观察者相对**的事实（DSH 自己的话 "Ambient presence is neither liveness proof nor authorization"）；持久化后没有可靠的清除者；且该命名空间用户可手改 ⇒ 一个用户可改的持久观察字段不提供完整性 | **采纳** | 与 G2 独立同源 |
| D3 | deepseek | **把「读取时判定」升级为「每个决策点判定」**：三个决策点渲染活性（`roster get` 现任行 / `roster.md` 镜像 / 三道门的拒绝文案）；今天三道门对「死现任」的文案是**误导性**的（说「只有现任 X 可写」而 X 写不了） | **采纳（`roster.md` 例外见 §3(a)）** | 落点：§11 诊断面三条 |
| D4 | deepseek | 两个**派生**诊断词（不落盘）：`vacant`=current 为 null；`seated-dead`=current 非空但 `agents.get(current)===undefined` | **采纳** | 零 schema 变更 |
| D5 | deepseek | **启动清扫并入一行**：列出「各团队 current 无活代理的角色」——重载后全体自建代理皆死的场景下这是用户看到的第一个信号 | **采纳** | 落点：§11 诊断面 |
| G3 | glm | 恢复**三级阶梯**：R0 侧边栏重开（零手术）/ R1 人类确认的 recover 动作 / R2 设置 UI 超级写者 | **采纳** | 与 K2 同源 |
| D6 | deepseek | 机制 = **两个封闭动词**：**revive**（`ctx.agents.resume` 复活**同一**会话，身份不变、roster 不动、信任零改动）与 **reappoint**（候选=插件算出的存活成员 → 人类确认 → **复用 claim 的** `applyRotationTrust`+`settleRotation`） | **采纳** | 落点：§11 恢复机制 |
| D7 | deepseek | **关键边界（revive 夺权）**：`resume` 的 ownerCtx 是插件根 ctx ⇒ 复活后该代理的**运行时所有权归插件**，卸载即拆；对**人类自建**会话做 revive 比现状**更差** ⇒ **v1 的 revive 只对插件自建会话**，人类自建走「深链指引，请在侧边栏打开」 | **采纳** | 我原设计完全没想到这条。落点：§11 revive 的适用域 |
| K3 | kimi | 机制 = **`rotate action=recover` =「人类对话授权的 prepare」**；核心洞察：原设计 §3.6.2 的 prepare 授权本来就是 `agent.id === current `**`\|\| userInitiated`**，实现把「用户发起」窄化成了设置 UI 手工编辑 ⇒ recover 不是发明新授权，而是**把「用户发起」做成工具面一等公民**，随后**逐字走 prepare 的机制**、claim **逐字不动**（两道人类关卡 + 24h 回退网，不合并） | **采纳** | 与 D6 合并成两级（见 §3(c)） |
| G4 | glm | **不需要「临时复权令牌」**：令牌只在**无人值守**场景才换得价值，而恢复**必须有人在场**；绕过 writerGate 且无人类门的 bearer capability 恰好是后门的形状 | **采纳** | 三条独立一致 |
| D8 | deepseek | 同理：**不需要临时复权令牌**；「对话框确认」就是人类授权本身；无人值守恢复 = 常驻自任命机器 = 你最担心的后门 | **采纳** | 同上 |
| K4 | kimi | 不需要新令牌——**pending 本身就是那张临时复权令牌**（绑定三元组、一次性、30 分钟 TTL、全量落盘）⇒ 单一机制、单一审计面 | **采纳** | 落点：§11 说明「不新增令牌类型」 |
| G5 | glm | 发起权限**本队存活成员**（它们是撞墙的人；非成员无合法利害） | **部分采纳** | 见 §3(b)：与 K5 合并 |
| K5 | kimi | 三权拆开：**授权**唯一来源=人类在对话框那一下点击；**发起**={该角色最近一任前任} ∪ {团队现任成员}；**旧任可以发起**——发起权从不依赖信任、只依赖身份资格，且它上下文最完整、「回聘旧任」是最自然的恢复；但它被第一次换届丢弃的旧 pairs **不复活**（走首问门重建） | **采纳** | 见 §3(b) 的分歧裁定 |
| D9 | deepseek | 发起限「本队存活成员」（v1 不给旧任发起权，但承认机制上它仍能调用工具） | **部分采纳** | 同上 |
| G6 | glm | **触发条件由宿主观测、不由调用方主张**：执行时自己重查 `agents.get(incumbent)===undefined`，且**对话框弹出时与落笔写入前各查一次**（TOCTOU） | **采纳** | 与 D/K 一致 |
| G7 | glm | **fail-closed，且刻意不设 provisional 无人值守变体**（与 M4 claim 的关键差异）：claim 敢无人值守是因为 pair 迁移可被 sweep 自动回退；而 **incumbency 不可自动回退**——错误现任写下的黑板/roster 已成事实 | **采纳** | 三条独立一致；这是本问最重要的安全不对称 |
| D10 | deepseek | 八条硬约束封死后门：封闭动词（只 revive/reappoint）/ attended-only 无 provisional / **候选由插件计算、模型不得指定** / revive 只绑当前 current（不能复活任意历史会话，否则吊销形同虚设）/ `writerGate` 原样不动 / **绝不把 writer 降级为 any 当「修复」** / 限速+三处留痕 / 先清扫再动作 | **采纳** | 落点：§11 防滥用节 |
| G8 | glm | 六条防后门性质 + **核心论证：任何「人类确认框把关」的动作，其权限上界就是设置 UI 超级写者**（后者本来就能改一切且无审计）⇒ 恢复只是把既有人类权限收窄成更窄、更可审计的形式，**不可能新增**后门；后门只可能来自绕开人类的那部分 | **采纳** | 与 D10/K6 同构；这是回答「会不会变成后门」的骨架论证 |
| K6 | kimi | 分层论证：每条写路径都有自己的门，**recover 不是 writerGate 的缺口，而是与 M4 claim 同级的人类在环授权**；伪造死亡不可能经本插件（模型面无 dispose 入口）；链式提权每环都撞墙；诚实残余风险=人类无脑点确认（全插件统一授权模型，不新增风险类别） | **采纳** | 同上 |
| G9 | glm | **明确否决「巡逻主动告警 coordinator 死亡」**：插件重载 = 全队代理同时死亡 ⇒ 巡逻一告警就是**每次重载一场误报风暴**；且 `broadcastNotice` 对无发送方身份的通知按设计不发送 | **采纳** | 与 D3 的「读面暴露 + 人类节奏」一致 |
| D11 | deepseek | 完整失败模式表（假死竞态 / 无 factory 或 persistence / **revive 夺权** / 复活后再死 / 任命后原会话以非成员身份回来 / 全队皆死候选集为空 / 无看门狗团队 / 对话框无人应答 / 死在 prepare→claim 窗口 / 跨进程单写者） | **采纳** | 落点：§11.5 失败表 |
| G10 | glm | 失败模式表 F1–F10（含 F5「全员皆死」→ 指引降级为「在侧边栏打开任意一个团队会话」；F7 `writer=any` 无死结；F8 死的是非 coordinator 角色不死锁；F9 死继任者 + provisional 已回退时通知面部分缺发是既有语义） | **采纳** | 与 D11/K7 合并 |
| K7 | kimi | 失败表 a–i + **边界声明**：恢复**不保证复原第一次换届前的信任拓扑**（那批 pairs 已在第一次 claim 时按域限定丢弃；从 `rotationBackup` 整体还原绕过了对端同意模型，v1 不做，v2 要做必须套 provisional+24h 外壳）；恢复对 `writer=any` 与死 worker 非必需但机制一致开放（**授权从不源自 coordinator 身份**，否则等于给 coordinator 新增「轮换他人角色」的权力，而 `rotateGate` 刻意没给它） | **采纳** | 同上 |

### Q2 —— 交接文档的内容契约

| # | 来源 | 意见（要点） | 处置 | 理由 / 落点 |
|---|---|---|---|---|
| G11 | glm | **原则**：插件只能把关**结构**（节在场/非空/有界），不能把关**内容质量**；presence 门防**遗忘**、不防**敷衍**——这句要诚实写进设计 | **采纳** | 三条独立一致 |
| D12 | deepseek | 三层结构：**头 YAML（插件写）** + **事实段（插件写，与 claim 返回文案同一事实源——「不可两处口径」）** + **正文（旧任模型写）** | **采纳** | 事实段这条是新增的好想法（避免两处口径分叉） |
| G12 | glm | 四个**硬节**：`mission` / `in-flight` / `commitments` / `unknowns`；三个**软节**：`first-actions` / `team-map` / `conventions` | **采纳** | 与 D13/K8 合并见 §3(d) |
| D13 | deepseek | 正文**六个必含节**：任务与当前目标（含 goal 相位/rounds/armed——上任首动就是 `/goal resume`）/ 在飞与交接瞬间 / 纪律与协议指针（含 baseHash）/ 信任与通道现状 / 已知风险与陷阱 / 上任第一步清单 | **采纳** | 同上 |
| K8 | kimi | **双重受众**先摆正：正文经 followup **进入继任者上下文**（活着的交接），落盘文档是**审计+人类可读+事后重读** ⇒「空正文」伤害继任者本身（拒绝级），「缺小节」伤害文档质量（警告级） | **采纳** | 这个区分是缺项政策严厉度的依据 |
| G13 | glm | 缺项阶梯：**验证点必须在任何副作用之前**；`successor:"auto"` + handoff 缺失/空 → **拒绝于工具入口**（零建会话、零令牌、零 freeze，并给出四硬节脚手架模板）；硬节缺 → 拒绝并点名；软节缺 → 放行 + 警告；**显式 successor + 无 handoff → 放行 + 警告**（M4 现语义不回收紧）；文档写失败 → **abort-before-prepare** | **采纳** | 落点：§11.4 新增「交接文档校验」小节 |
| D14 | deepseek | 缺项政策同构（空正文拒绝 / 缺必含节警告+降级由人类决定）；**claim 时不复验文档**（它是审计件不是执行件） | **采纳** | 同上 |
| K9 | kimi | 空正文=拒绝级、缺节=警告级（双重受众推导） | **采纳** | 同上 |

### Q3 —— H3 的退路

| # | 来源 | 意见（要点） | 处置 | 理由 / 落点 |
|---|---|---|---|---|
| G14 | glm | **H3 的风险面比文档写的窄**：`Agent.followup` 接口层**没有 self 禁令**，且「A wake submitted while already idle always opens its turn boundary」⇒ 悬念不在「允不允许」而在**回合与来源语义**；**首选仍是照 §11.2 实施 H3**，冒烟一次成本很低 | **采纳** | 与我自己的源码核对一致（`invocation.agent` 是活 Agent、无护栏） |
| G15 | glm | 我提议的「命令做机械部分、正文下回合补」**依赖一个唤醒信道**，而信道只有三个：self-followup（**就是 H3 本身，循环依赖，不算退路**）、人类粘贴一句话、其余同理 ⇒ 该拆分**不能作为退路** | **采纳** | 直接否决了我原本的退路构想 |
| K10 | kimi | 命令 handler 做机械大件**已被 ② 实证**（`/team_session` 在 handler 里完成确认框 + `agents.create` + roster 登记 + pairs 写入，且用 `invocation.agent.id` 过 `writerGate`） | **采纳** | 落点：§11.2 注明「先例：② 已实证」 |
| F1 | codex-cli | 进程失败，无内容 | **failed（不构成 pending）** | — |

## §3 分歧与父侧裁定（**主代理写**）

**(a) `roster.md` 镜像要不要渲染活性？** glm：**不要**（它是状态渲染、不是活性渲染，维持纯度）；deepseek：**要**（给现任行加注记）。**裁定：采纳 glm。** 理由是 `roster.md` 是**落盘文件**——把活性写进文件等于把一个**读数瞬间**烙进持久物，下一分钟就陈旧；而活性是瞬态的（G2/D2 的共同前提）。**活性只出现在「活着的读面」**：`roster get` 的工具返回、三道门的拒绝文案、启动清扫报告。

**(b) 旧任能否发起恢复？** glm：**不能**（它信任已被对称吊销，「凭我以前是」复权正是换届要消灭的变体的翻版）；deepseek：机制上能、v1 不给；kimi：**能**——发起权从不依赖信任、只依赖身份资格，且它上下文最完整、「回聘旧任」是最自然的恢复，但它被丢弃的旧 pairs **不复活**。**裁定：采纳 kimi，但把 glm 的顾虑写成硬约束。** 关键区分是 **「发起 ≠ 授权 ≠ 复权」**：旧任可以*发起*（弹出一个对话框），**授权唯一来源仍是人类那一下点击**；而它若被选为继任者，走的是 M4 claim 的域限定迁移（**从死亡继任者的遗存里重建**），**旧 pairs 一律不复活**。glm 真正反对的是「凭旧身份直接复权」，而 kimi 的机制里不存在这个动作。⇒ 三者在这种读法下相容，取其中**最保守的机制、最宽的发起域**：机制上比 glm 更严（不新增任何复权路径），发起域上比 glm 更宽（不把一个最有用的恢复人挡在门外）。

**(c) 恢复的机制形状：`roster action=recover` / `rotate action=recover` / 独立工具？** 三家各一形状。**裁定：合并为「两级 + 一个入口」，入口取独立工具 `team_link_recover`，恰两个封闭动词**：

| 级 | 动词 | 机制 | 何时用 |
|---|---|---|---|
| **L1** | `revive` | **复活同一会话**（`ctx.agents.resume`，身份不变、roster 不动、信任零改动）——**只对插件自建会话**（D7 的生命周期边界）；人类自建会话改为「深链指引，请在侧边栏打开」 | 死亡绝大多数是重载/重启假象 |
| **L2** | `reappoint` | **人类对话授权的 prepare**（K3）：铸令牌绑定三元组 → 逐字走 prepare（快照/冻结广播）→ 继任者凭令牌 claim（**claim 逐字不动**）⇒ 两道人类关卡 + 24h 回退网 | 现任不会/不应再回来 |

- 为什么独立工具（采纳 deepseek 的理由）：**演员与前置条件都与 rotate/roster 不同**，而「两个封闭动词」这一条反后门性质需要一个**可审计的单一落点**。
- 为什么不是 `rotate action=recover`（kimi）：kimi 的「单一机制」诉求由 **reappoint 复用 prepare/claim 核心**满足——机制仍只有一套，入口独立不破坏它。
- **不新增令牌类型**（K4）：L2 用的就是 pending/token 本身。

**(d) 交接文档的节数：4 硬（glm）vs 6 必含（deepseek/kimi）？** **裁定：合并为 5 硬 + 4 软**——取 glm 四节（它们各自的缺失会**静默**丢掉一类上下文，这正是硬节标准）+ deepseek/kimi 的「任务与当前目标（含 goal 相位）」作为第五节（**继任者的第一个动作就是 `/goal resume`，文档必须说清有没有 goal 可续**）；其余（`first-actions` / `team-map` / `conventions` / 信任现状的「为什么」部分）归软节。

**规模观察**：本轮 3/4 交付、1 条 codex 进程失败（非超时）。三条回复均为**源码级**，且**各自独立纠正了我的问题前提**——尤其 K2（死亡 ≠ 信任手术）与 D7（revive 夺权）是我完全没想到的。**本轮会诊的净收益大于前两轮之和。**

## §4 教训（**主代理写**）

1. **我的问题前提被三条回复各自纠正**——三处都是我审题时想当然：① 把「roster 写不了」扩大成「团队卡死」（D1/K1：黑板无门、send 仍通）；② 把「现任无人」默认成「必须换人」（K2：`current` 是会话 id，**重开即原 id 复活、零信任手术**）；③ 把「旧任已被吊销」等同于「它不该碰恢复」（K5：发起 ≠ 授权 ≠ 复权）。**教训：送审的题设本身也要当成待验假设**，而不是把问题描述当既成事实交给评审。
2. **一个问题的「唯一正解」往往是三家各贡献一半**：K2 给最便宜的路径（零手术）、D7 给那条路径的**例外**（插件自建 vs 人类自建）、D6 给动词形状、K3 给授权口径、glm 给不变式与失效论证。**合并比选一边更有价值**——§3(b)(c)(d) 三处都因此做了合并。
3. **「写不进去」与「不能通讯」必须分开表述**。我在日志里几处写成「团队卡死」，实际是「身份与信任面锁死、通讯面仍通」。**表述过强会让诊断误导使用者**（glm 特别强调诊断面要说出这个差别）。

## §5 不可验清单（**主代理写**）

- `ctx.agents.resume` 在真机上的行为（L1 revive 的核心）：`dsh-agent` 类型面证实存在（“load persisted session and resume an agent on it”），但**未真机验证**——尤其**ownerCtx 归插件**这一条（D7 据此把 revive 限定在插件自建会话）；
- `writerGate` 拒绝文案的「调用方富化」（gate 本体保持纯函数）是否足以覆盖全部三条门路径（writer / rotate / retire）；
- L2 `reappoint` 复用 M4 prepare/claim 后，`rotationBackup` 里那份「死亡现任的信任遗存」在对称吊销时是**纯清理**——逻辑上成立，**未实测**；
- 「巡逻不告警」这条否证的**误报风暴规模**（插件重载触发全队死亡时）——按 glm 的论证推断，未实测；
- codex-cli 的 Q2/Q3 回复：进程失败，**部分永不可得**；
- **全部真机项**（与 ① 演练 8、② 演练 9、③ 演练 10 同一次重启窗口）。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-09-20 | 机制落盘（§0 汇总 + §1 原始层）；裁定层待主代理补写 |

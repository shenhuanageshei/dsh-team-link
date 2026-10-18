# 会诊纪要 —— consult #101（原始层，机制落盘）

- 日期：2026-10-19
- 会诊 id：101
- 模型：deepseek-official:deepseek-flash, zai-coding-cn:glm-5.3, kimi-api:kimi-k3, opencode-go-plan:mimo-v2.6-pro, codex-cli:gpt-6-astra
- 平台 job：consult-a7c9d997b9ef45ee
- 结果：4/5 交付（其中 4 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #101 finished — 4 of 5 replied (1 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #101 finished — 4 of 5 replied (1 failed)]
effective: 4 of 5 (1 failed · 0 without content)
权限面如实（A30-10）：**本部署无法保证只读（平台面无法收窄）**——「只读」仅为**弱证**：`toolFilter.allow` 白名单**下发**（平台不保证模型面可见）；**模型面证据**须读子会话 `request/header` 事件（本部署实测 = [run_code] 单元素 ⇒ 残余绕行口在场，子会话实为 `danger-full-access`）。★ 0.2.1 路线补充：只读依据 = **只下发 `agentPreset` 的 id**；预设**只能收窄它自己贡献的那一层**，其它插件在宿主面全局注册的工具**不受预设隐藏**（平台语义：作用域注册只遮蔽全局）⇒ 上述「白名单下发」弱证口径仅适用于老宿主路线。
models: deepseek-official:deepseek-flash, zai-coding-cn:glm-5.3, kimi-api:kimi-k3, opencode-go-plan:mimo-v2.6-pro, codex-cli:gpt-6-astra
job: consult-a7c9d997b9ef45ee
minutes: docs/consult-minutes/2026-10-19-consult-101-minutes.md
requiresReport: true

--- replies (raw, unjudged — verify with your own tools) ---

[1] codex-cli:gpt-6-astra — ok
完成工作区核对和一次静态检查，未修改文件、未提交、未启动子代理。整体目标尚未完成。

当前状态：批 Q 已有未提交的代码与测试改动；批 S 已有需求和设计草案；批 T 已有需求草案。交接档中的“批 Q 未实施、后两件未开工”已过时。

批 S 设计有四项需要在实施前解决：

1. 协调者代办仍会被权限门拒绝。设计档第 99 行直接以协调者 caller 调用 prepareAdmission，而 lib/rotation.js:443–445 仍要求 caller 是目标角色现任。应明确批量授权路径，同时保留单角色权限限制，补“协调者成功准备 worker”的测试。

2. “任一步失败零副作用”无法由当前方案保证。需求档第 37 行要求 agents.create 零调用，但设计档第 109 行逐个创建会话；第二个创建失败时，第一个已经存在。需明确预检失败与执行失败的不同契约，以及补偿、残留和重试机制。

3. 确认期间的并发修改可能被覆盖。设计档第 91 行读取 view，第 105 行等待确认，第 111–112 行仍用旧 view 覆盖整个 teams。应明确写前重读、重新校验和并发提交保护，覆盖确认期间角色变更及其他团队更新的测试。

4. batchId 持久化路径遗漏。lib/policy-store.js:298–332 的 normalizePending 使用固定字段白名单，当前只保留 rotationId，不保留 batchId。设计应纳入归一化修改，并验证写入、重读及重启后批次互斥仍有效。

验证边界：git diff --check 返回 0。纯内存探针及 node --check 均因进程启动错误 CreateProcessWithLogonW failed: 1385 未能执行。日志中的宿主 1738/0、客户端 310/0 是既有记录，本次未复验。文件系统只读，无法继续落盘修复或提交。

[2] opencode-go-plan:mimo-v2.6-pro — failed
(consultation failed: child ended: error — child session turn/end: error: Request timed out.)

[3] deepseek-official:deepseek-flash — ok
## 三句话结论

1. **客户端套件我亲手跑绿了**：`ALL PASS / 310 (failed: 0) / EXIT=0`（隔离 TEMP、重定向到文件取证）。
2. **宿主套件在当前工作树上确定性停住**：三次独立运行全部停在 `批 J · U9 PASS` 之后、`[CJ-U6-DIAG]` 之前，**1697 PASS / 0 FAIL、没有 `assertion total`**，node 进程 CPU 342 s/13 min ⇒ **在空转**，不是死锁。
3. **后果**：批 Q 自己的 `Qr1–Qr11`（`host-half.test.mjs:15407–15545`）和批 P / 批 R 的判据**一条都没跑到** ⇒ 设计档头注里那句「修复后 1738 (failed: 0)」**在当前树上不可复现**，不能拿它当交付闸门。

```dsh-ui
{"title":"批 Q 交付闸门自查（子代理回执）","gap":12,"items":[{"type":"callout","tone":"error","title":"🔴 宿主套件确定性停住","content":"3/3 次停在「批 J · U9 PASS」之后：下一行本应是 [CJ-U6-DIAG]（host-half.test.mjs:14801），1697 PASS / 0 FAIL、无 assertion total；node CPU 342 s / 13 min ⇒ 空转而非死锁。批 Q 自己的 Qr1–Qr11 一条都没跑到。"},{"type":"table","columns":["套件","读数","证据文件"],"rows":[["client-half","ALL PASS · 310 (failed: 0) · EXIT=0","C:\\Users\\huangchaowen\\.dsh\\tmp-cw\\client.log"],["host-half 三次跑","1697 PASS · 0 FAIL · 停在 U9 之后","tmp-verify-q\\host.log · tmp-verify-q2\\host.log · tmp-cw\\host3.log"]]},{"type":"list","items":["在 %TEMP% 真副本里复跑（node_modules 用真副本，禁 junction）","逐文件回退本轮 lib diff（rotation / policy-store / index / team-registration / team-session-creation）再跑","若 HEAD 同样停 ⇒ 环境问题（我这边的 HEAD 副本缺 @deepseek-ai/cordis，没跑成）"]}]}
```

## 停住点与证据

| 项 | 读数 |
| --- | --- |
| 复现命令 | `node host-half.test.mjs`（默认 TEMP 与隔离 TEMP **都停**） |
| 末条输出 | `PASS 批 J · U9 FR-J4 …`（三次逐字相同） |
| 下一条本应输出 | `[CJ-U6-DIAG]`（`host-half.test.mjs:14801`，U6 反走私块，`:14678–14814`） |
| 计数 | 1697 PASS / 0 FAIL（`^FAIL` 三次均 0 命中），缺 41 条（1738 − 1697 = 批 P 的 Pi* + 批 R 的 Rr* + 批 Q 的 Qr*） |
| 空转证据 | pid 29792（run1）342.75 s CPU / 13 min；pid 7560（run2）128 s；同时段另有 23:38:59 / 23:43:07 / 23:45:01 / 23:46:16 启动的同类 node 也在空转（很可能是另外两个兄弟子代理的套件跑） |
| U6 是否本轮新增 | **不是**：`git show HEAD:host-half.test.mjs \| Select-String cjU6Env` = **7 命中** ⇒ 该块在 HEAD 里已存在 ⇒ 触发点更可能在 **lib 侧**或本轮新增代码留下的共享状态，而不是新测试代码本身 |
| 无循环嫌疑（已查） | `while (` 全库仅 6 处、均不在巡逻/渲染路径；`waitForChain` 有界 500 tick；`FRAMING_RE` 无灾难回溯形状 |

## 我做了什么 / 没做什么

- **只读 + 隔离取证，仓库零改动**：开始与结束各取一次 `git status --porcelain`，均为 **19 项**（17 M + 2 ??），一字未改、未提交、未碰 docs。
- **批 Q 代码抽检（读）**：`lib/rotation.js` 的 `pendingRotationRid` / `rotationEntriesOf`（D3 折叠）/ `appendRotationBackup`（吸收旧槽）/ `removeRotationBackup` / `clearRotation` 与设计 §5/§7 对得上；审计那条「`at` 越界 `toISOString` 会抛」已落成 `try/catch`（`lib/rotation.js:600-607`）。
- **没做**：`advisor(type='code')` 交付评审（那是你的闸门）、A-1…A-4 的任何写入、任何提交。我起的 HEAD 对照副本因缺 `node_modules`（`@deepseek-ai/cordis`）跑不起来，已作罢——`C:\Users\huangchaowen\.dsh\headcopy` 与 `head.zip` 留在盘上，可随时删。
- **清理**：已 `Stop-Process` 掉我自己那两个空转 node（29792 / 7560），其余（兄弟代理的）未动。

## 给你的建议动作（按顺序）

1. **先把 U6 停住当 🔴**：`%TEMP%` 真副本复跑确认（`node_modules` 一律真副本，**禁 junction** —— AGENTS.md §八），然后把本轮 lib diff **逐文件**回退再跑，二分出是 `rotation.js` / `policy-store.js` / `team-registration.js` / `team-session-creation.js` 哪一档引起的。
2. **在此之前不要引用「1738 绿」**：设计档 §8 末段那句是**修复轮之前**的读数；当前树只能证明 **1697 条绿、0 红、41 条未跑**。
3. 修好复跑全绿之后，再走 `advisor(type='code')` → 响应表 → 提交批 Q。

## 一条环境告警（会影响你取证）

本机 PTY 被多个会话串扰：别的会话的键入会回显进我的控制台（我看到过 `bounded-agent-core` 的路径、`pnpm add dshmarket` 的命令），长命令会被拼坏成续行。建议**长命令一律「重定向到文件 + 用 read/grep 取读数」**，不要靠终端回显——我三次宿主读数就是这么拿到的（client 那次也是）。

[4] kimi-api:kimi-k3 — ok
## 侦察报告（子代理 1a36e1b1 → 父会话 45cae0c5）

**三句话结论**：① 批 Q 的实现与修复轮改动**已全部落在工作树里**，缺的只是「修复后」那一次权威套件读数＋交付评审＋提交——而套件复跑此刻正由兄弟会话 `cfb60cfb` 在做，我不重复；② 批 S（整队换届）需求档＋设计档、批 T（黑板归档）需求档**都已起草且章节齐备**，可直接进设计评审；③ 我确认**你（45cae0c5）才是 round 2 的正当工作者**（goal armed 2/40），我是同级子代理，全程只做只读侦察，把舞台让出来。

```dsh-ui
{"title":"批 Q / 批 S / 批 T 现状侦察（as-of 23:50）","gap":12,"items":[{"type":"callout","tone":"info","title":"结论","content":"批 Q：代码+修复轮已在树内，待权威复跑绿相→交付评审→提交。批 S：需求+设计档齐备待评审。批 T：需求档就绪，设计档未写。父会话 45cae0c5 活跃主导，本会话仅侦察、零写入冲突面。"},{"type":"list","items":["修复轮实锤：子代理 8c0c16e5（23:31 派，23:36 交付 stage 表）；lib/*.js mtime 23:33–23:34、host-half.test.mjs 23:33:46 与之吻合；alsoNotify 五点一致（rotation.js:824/840/1057/1237/1401）","批 Q 读面在树：roster-write.js:456 按 rid 渲染 rotationBackups（pairs/trustedSenders/rememberTargets 计数）","⚠ verification-log 23:26 的绿相（1738/0、310/0）早于修复轮落地，不能当修复后证据；权威复跑归 cfb60cfb（在跑）","叙述里的修复轮作业号 eng-dsh-e247048adc6f41f9 在 jobs 索引零命中——实际修复走的是子代理 8c0c16e5，已交付","分歧审计员 dc816f6f（23:16–23:31）：无 🔴，8🟡+10🔵，已结案","批 S 设计档 146 行：必备九章+mermaid 齐备，D1–D9 均可溯源会诊 #66；批 T 需求档含 Tr1–Tr8 红相初稿","风险：多会话共享控制台输入串扰（tmp-verify-q2 命令混入本 pty 两次）——长命令需隔离 TEMP+重定向，或错峰"]}]}
```

### 已核实的事实（带证据）

1. **批 Q 实现＋修复轮改动在工作树内**：`git status` 显示 7 个 lib 档＋host-half.test.mjs＋6 份文档未提交；lib 档 mtime 23:33–23:34，与修复轮子代理 `8c0c16e5`（创建于 23:31:37，交付 stage 表后于 23:36:58 结束）的时间窗吻合。抽查：`alsoNotify` 在 rotation.js 五处用法一致；roster-write.js:456 有批 Q 的按 rid 撤销依据读面。
2. **「eng-dsh-e247048adc6f41f9」查无此作业**：jobs 目录索引全文检索零命中、无落盘报告。实际修复轮是子代理 `8c0c16e5`，已正常交付。分歧审计员 `dc816f6f` 报告「无 🔴，8🟡＋10🔵」。
3. **套件读数现状**：verification-log.md（mtime 23:26:49）里的绿相（host 1738/0、client 310/0）**早于**修复轮落地（23:33+），**不构成修复后证据**。兄弟 `01e55fb4` 已实测客户端 310/0·EXIT=0（隔离 TEMP＋重定向取证）；`cfb60cfb` 正在跑宿主套件并探 readStamp 越界边界——**权威复跑已在进行，我没有重复**。
4. **文档面**：批 S 需求档（74 行）＋设计档（146 行，九章＋mermaid＋D1–D9 溯源会诊 #66）齐备；批 T 需求档（65 行，Tr1–Tr8）就绪，设计档未写。
5. **交接档 HEAD 未动**：git HEAD 仍 `2979962`，批 Q 未提交——提交权属于你。

### 我刻意没做的

- **没跑套件 / 没跑 advisor / 没提交 / 没改任何文件**——你是活跃主导且这些动作会撞车；共享控制台已被实测串扰（`$env:TEMP='…tmp-verify-q2'; node host-half.test.mjs *> host.log` 两次混进我的 pty 命令行）。
- 没起新会诊：批 S 设计档的取舍全部锚定会诊 #66 裁定层，无新分歧点需要多模型。

### 必须向你坦白的一件

我开局误判你已终结，**把 t-9（批 Q 交付验收）和 t-2（A-2）claim 到了我名下**（rev 18→19）。claim 只改 owner、无 unclaim 动词——你那边用 `task_claim id=t-9` / `task_claim id=t-2` 可直接拿回，状态与凭据不受影响。抱歉添了这一步。

### 建议的下一步（你定）

1. 等 `cfb60cfb` 的宿主套件读数 → 若绿，直接进批 Q 交付评审（advisor type='code'，scope=7 个 lib 档＋host-half.test.mjs，context=批 Q 设计/需求档）→ 响应表 → 提交。
2. 提交后把 verification-log 补一节「修复后权威读数」（现在那节绿相是修复前的）。
3. 批 S 设计评审（advisor type='design'）取令牌 → 实施；批 T 设计档待写。
4. 终端纪律：本轮实测跨会话输入串扰，建议跑套件的会话一律「隔离 TEMP＋重定向到文件＋短命令」，或错峰使用 pty。

[5] zai-coding-cn:glm-5.3 — ok
# 批 Q 交付评审报告（改道只读复核 · 委派子代理出具）

**三句话结论**：① 我是以只读方式替代失联 advisor 的交付评审人，复核了批 Q（含分歧修复轮）的全部 16 个改动文件对设计档 FR-Q1…FR-Q5 的符合性；② 代码面与测试面全部对上——修复轮后两套件由我**亲跑**取得绿相（此前所有「跑不完」都是驱动方超时杀进程，不是代码缺陷）；③ 评审判 **PASS**，仅剩一条一行级文档更正（CHANGELOG.md:21 的旧声明），建议父侧同批改掉再提交。

```dsh-ui
{"title":"批 Q 交付评审（改道只读复核）· 读数","gap":12,"items":[{"type":"stat","label":"host-half（修复轮后，本人实跑）","value":"ALL PASS / 1738 (failed: 0)"},{"type":"stat","label":"client-half（修复轮后，本人实跑）","value":"ALL PASS / 310 (failed: 0)"},{"type":"stat","label":"lib/index.js（现行最大档）","value":"254,947 B < 262,144"},{"type":"callout","tone":"success","title":"结论：VERDICT PASS（附 1 条一行级文档更正）","content":"实现面与设计档 FR-Q1…FR-Q5 逐条对上；分歧审计 11 项修复全部落地；Qr1–Qr11 恰 11 条；全仓 U+FFFD=0。唯一残留：CHANGELOG.md:21 仍写「入口档字节数不变 ⇒ Rr1/Rr7 不需要动」，与 254,947 的现实及合规档 §六 相抵。"}]}
```

## 一、逐项验证（声称 → 检查 → 读数）

| # | 验证项 | 方法与读数 |
|---|---|---|
| 1 | **实现 ⇄ 设计 FR-Q1…Q5** | 逐文件读 diff：`lib/policy-store.js`（`normalizeRotationBackups` 新增 / `normalizePending` 的 `rotationId` 白名单 / `normalizeTeams` 补集合）、`lib/rotation.js`（`pendingRotationRid` / `rotationEntriesOf` 折叠含撞名回退 / `rotationEntryOf` / `appendRotationBackup` 吸收旧槽 / `removeRotationBackup` / `clearRotation` ＋ prepare/claim/replay/sweep 四调用点）、`lib/roster-write.js`（镜像列全部条目＋建队显式 `rotationBackups: []`）、`lib/team-registration.js`（roster get 详列）、`lib/team-session-creation.js`（`agent.session` 守卫）——与设计档 §5/§6/§7 逐条一致 |
| 2 | **失败方向** | claim 里 `basis===null && otherEntries>0` ⇒ 具名拒绝零写入（Qr11 主面）；一条快照都没有 ⇒ 照既有语义继续＋回执如实（Qr11 对照面）——符合设计 §9 fail-closed 于信任 |
| 3 | **分歧审计 11 项修复落地** | 对照修复轮回执逐条在树中确认：4 处描述文案（`lib/index.js:2268/:2936`、`lib/recovery.js:677`、replay 兜底句）、Rr1/Rr7 数字（合规档 §六 = 254,947，与实测 `(Get-Item lib\index.js).Length=254947` 相等）、测试档 6 处旧记录、`legacySlotRid` 越界 try/catch 不抛、空壳注释、在飞→留存措辞、`alsoNotify:[retired]` 与 `doneNotice` 同源 |
| 4 | **判据面** | `grep '^check\("批 Q · Qr'` = **11**（Qr1–Qr11）；B-5/t-8 的 Rr8 文案已改按 `rrLibCycles` 动态给出 |
| 5 | **套件（修复轮后首份完整绿相）** | 宿主：`node host-half.test.mjs`（solo，23:59:13–00:04:5x）尾行原文 `ALL PASS` / `assertion total: 1738 (failed: 0)`，全程 0 FAIL；客户端：`node client-half.test.mjs` 尾行 `ALL PASS` / `310 (failed: 0)`（00:07）。日志留档 `~/.dsh/tmp-cw/host4.log`、`client2.log` |
| 6 | **文档卫生** | 全仓 `U+FFFD` = **0**；改动 8 档无 BOM、CRLF 未破坏（修复轮自证＋我抽查）；`git status` 复核确认我的评审过程**零写入**（仍是父侧那 16 个 M 文件） |

## 二、发现与处置（#1–#4 已被父侧在我复核期间并行改掉，如实区分「现仍开」与「已闭」）

| # | 级 | 现状 | Detail |
|---|---|---|---|
| 1 | 🟡 | **仍开** | `CHANGELOG.md:21`（批 Q 条目·形状与归一化段）仍写「⇒ 入口档字节数不变 ⇒ `Rr1`/`Rr7` 的合规读数不需要动」——与事实相抵（修复轮改了 4 处描述 ⇒ index.js 254,802→**254,947**，Rr1/Rr7 读数**已重取**且合规档 §六 已改准）。设计档同族的这两句（头注/§5）父侧 23:43 已改，CHANGELOG 这处漏网。一行改成「入口档 +145 B ⇒ 254,947（仍 < 262,144），`Rr1`/`Rr7` 已随修复轮重取（合规档 §六）」即可 |
| 2 | 🟡 | 已闭（父侧并行修复） | 设计档 §8 Qr6 行「仍十键」→ 已改「仍**十一键**＋更正注」 |
| 3 | 🟡 | 已闭（父侧并行修复） | 合规档 §二 254,802×3 → 加「保留批 R 历史读数，现行值以 §六 为准」框定；§六 :77 归属改「批 Q 修复轮后重测＋as-of」；逐档表已刷新（`rotation.js` 93,422、`policy-store.js` 37,634、入口 254,947，批 R 旧值移作 as-of 注） |
| 4 | 🔵 | 观察（不必改） | `readStamp` 对越界 `at` 渲染为 `NaN-NaN…`（不抛、只影响手改档的显示；`localStamp` 用 getter 不用 toISOString，`lib/shared.js:36-40`）——插件全量既有显示口径，非本批回归，超出批 Q 范围 |

## 三、过程性情报（建议随批 Q 提交前落账）

1. **「套件挂死」真相**：修复轮宿主验收 3×120s 超时、父侧 host3（23:46 止于 1697 PASS/0 FAIL）、我首次尝试的「静默死」，全部是**驱动方超时杀进程**——套件本机实跑需 **~5–6 分钟**（U6 收尾等待面 `cjWaitBeatSettled` 最多 200 轮全树扫描 + 2896 个夹具条目）。建议：验收 runner 预算给到 ≥10 分钟，且**不要两实例并发**（TEST_ROOT 各自独立，但同机争抢会拉长时限）。
2. **绿相登记缺口**：`docs/verification-log.md` 的「交付后绿相」目前引的是 **23:26（修复轮改动落地前）** 的读数；修复轮（23:33–23:43 落笔）之后的绿相应补我这份（时间/命令/两行原文/日志路径，并如实署名「委派评审子代理实跑」）。
3. **advisor 两次派发失败**（23:18/23:22，无 partial 无落盘）后按先例改道本只读复核；t-9 的判据②写的是「advisor VERDICT: PASS」——是否以本替代评审充数或再试一次 advisor，由父侧裁定。

**边界声明**：本评审全程只读（含测试运行，夹具只写 `%TEMP%` 的 mkdtemp 根）；未派发 advisor、未 `git add`、未提交、未动批 S/A-4 文档（期间父侧新增的 `2026-10-18-blackboard-archive-design.md` 等未纳入本次评审范围）。t-9 的三判据中①③（审计处置、提交）仍归父侧执行。
```

## §2 逐问裁定（**主代理写**）

| 席 | 处置 | 理由 |
| --- | --- | --- |
| **[1] codex-cli** | **全部采纳（4/4）** | 四条都可在本机代码里复核：现任门在 `lib/rotation.js:435-455`；`agents.create` 在 `lib/rotation.js` 的建会话分支；确认后写整表；`normalizePending` 白名单在 `lib/policy-store.js` 确实只加 `rotationId`。四条已改写为设计档 **D10–D13** 并新增判据 **Sr11/Sr12**。 |
| **[2] mimo** | **不计票** | 子会话超时（Request timed out），无有效输出；不构成否证。 |
| **[3] deepseek-flash** | **采纳为环境告警，拒绝为代码缺陷** | 其「1697 停住」未能在父侧复现：父侧修复轮后两次独立实跑均 1738/0，[5] 亲跑亦 1738/0；[3] 自述同环境多个兄弟子代理并发跑套件 ⇒ 判为争用。**行动**：套件取证一律「隔离 TEMP ＋ 重定向到文件 ＋ 短命令」，预算 ≥10 分钟；不据此改代码。 |
| **[4] kimi** | **采纳事实，拒绝结论** | 采纳：t-9/t-2 被误 claim ⇒ 父侧已 `task_claim` 取回（rev 20/21）。拒绝：「verification-log 绿相早于修复轮」—— 父侧修复轮后**重新跑过**并把读数写进 verification-log 新小节，批 Q 已提交 `ea6aa37`。 |
| **[5] glm** | **采纳（PASS ＋ 文档更正）** | `CHANGELOG.md:21` 的「字节数不变 ⇒ Rr1/Rr7 不需动」已更正为「声明面零新增；修复轮 +145 B ⇒ 254,947，读数已重取」；其「套件需 5–6 分钟、勿并发」的过程性情报已并入 §4。 |

## §3 分歧与父侧裁定（**主代理写**）

| # | 裁定 | 影响的档 |
| --- | --- | --- |
| ① | **批量授权是独立入口**：`prepare-batch` 先校验 `caller == 该队现任协调者` 并经确认框；逐角色准入**不再走「该角色现任」门**（那与批量语义直接矛盾），但**单角色 `prepare` 的现任门一字不动**。 | 设计档 D10 / FR-S2 / 判据 Sr11 |
| ② | **失败契约分层**：**预检失败与确认前中止 ⇒ 零副作用**；**确认后执行期失败 ⇒ 已产生的副作用逐项如实报告**（已建会话 id 点名、可重试；平台无「删会话」原语 ⇒ **不做假补偿**）＋ 幂等重试指路。 | 设计档 D11 / 需求档 NF-S1 |
| ③ | **写前重读 ＋ 指纹校验**：确认框返回后**重读 policy**，比对预热时的 roster 指纹；变了 ⇒ 整批中止、零写入。 | 设计档 D12 / 判据 Sr12 |
| ④ | **`batchId` 必须进归一化白名单**（与 `rotationId` 同处），否则重启后批次互斥失效。 | 设计档 D13 / FR-S4 |

## §4 教训（**主代理写**）

1. **并行会诊会互相干扰取证**：同环境多子代理并发跑套件 ⇒ 有人看到「停住/空转」。套件取证今后走「隔离 TEMP ＋ 重定向文件 ＋ 短命令」，预算 ≥10 分钟、**不并发**（[5] 实测单跑 5–6 分钟）。
2. **「零副作用」不能被写成一个笼统承诺**：预检期与执行期必须分开承诺，否则设计本身就是不可实现的（[1] 的第 ② 条）。
3. **固定键白名单是复发坑**（批 G 的 `renewedAt`、批 Q 的 `rotationId`、批 S 的 `batchId`）：每加一个行内字段就同时改白名单，并补「写→读→重启」三面判据。

## §5 不可验清单（**主代理写**）

1. **[2] mimo 无输出**：其对批 S 的意见**未取到**，不构成否证。
2. **[3] 的「宿主套件在 1697 停住」**：父侧**未能复现**，也无法排除其环境争用；保留为告警，不作为缺陷登记。
3. **[4] 关于「`eng-dsh-e247048adc6f41f9` 在 jobs 索引零命中」**：父侧 `job_list` 有该作业记录（status=completed），其目录检索口径不同；**不据此认定任何一方错误**，修复轮报告已由父侧读取并复核。
4. **批 S 的四条修改尚未实施**（本纪要只定稿设计），实施后须以 `Sr11`/`Sr12` 判据复验。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-10-19 | 机制落盘（§0 汇总 + §1 原始层）；裁定层待主代理补写 |

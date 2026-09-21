# dsh-team-link 加固与恢复设计（2026-09-21）

- **状态**：待设计评审（评审由 owner 发起；本档写完不自行触发）
- **范围**：四个工作面 —— ① 导出路由接入信任栅栏 · ② 恢复能力加宽 · ③ 侧栏「会话工具」入口 · ④ 深链聚焦调用修复
- **依据**：本机真机实测（DSH `0.1.6-alpha.2` / Windows）+ 代码逐条复核（as-of `ba89ec9`）+ 会诊 #62
- **相关档**：`docs/consult-minutes/2026-09-21-consult-62-minutes.md`（意见原始层与裁定层）· `docs/verification-log.md`（证据账本）· `docs/collab-enhancements-design-2026-09-19.md` §11.9（恢复机制原设计，本档在其上增补）
- **评审轮次**：R1 = **FAIL** —— 评审员**无法读取本档**（其工作区是本会话工作区 `dsh-session-link-pro`，而本档在 `dsh-team-link` 仓，绝对路径被其工具拒绝）⇒ **设计任一维度均未被评价**；已按响应表把三份文档摆进评审工作区的 `review-stage-2026-09-21/` 并修订 §9（A2 caveat + A7），R2 = **PASS**（7 条 🟡/🔵 咨询项、无 🔴，已签发 design token，经 `eng_coder` 的 `designToken` 参数传递）；7 条经逐条核实**全部属实**，已按 owner 裁定（甲）改入本档 ⇒ **待 R3 验正**

## 文档地图与状态

| 节 | 内容 | 状态 |
|---|---|---|
| §1 | 需求三层（目标 / 用户故事 / 非功能） | 已定 |
| §2 | 现象与根因（四条，均带实测或实读证据） | 已定 |
| §3 | 目标与非目标 | 已定 |
| §4 | 具体方案与机制（含 §4.4 的全部 UI/交互决定） | 已定 |
| §5 | 边界与防偏离（红线） | 已定 |
| §6 | 验收标准（U1–U14，必红/必绿矩阵） | 已定 |
| §7 | 明确不做 | 已定 |
| §8 | 会诊 #62 意见处置摘要 | 已定 |
| §9 | 显式假设与待验项 | **待验，不许当已知事实** |
| §10 | 跨文档同步清单 | 随实现同批执行 |
| §11 | 实施分批 | 已定 |

行号一律是 **as-of ba89ec9** 的定位括注；判据以**锚文本**为准，不以行号为准。

---

## 1. 需求

### 1.1 总体目标

把 dsh-team-link 当前的四项已确认缺口一次补齐，且**不牺牲任何既有红线**：

1. **关闭一个真实的安全暴露面**：插件的 HTTP 路由必须与其他路由所有者一样，先经平台的信任栅栏与浏览器鉴权；
2. **让恢复能力覆盖真实故障形**：活着的协调者应当能救回死掉的 worker 车道，而不必依赖人手逐个点侧栏；
3. **把两个既有动作带到侧栏**：复制会话深链与导出会话，在侧栏即可对任意会话发起，不必先进入该会话；
4. **修掉一处静默失效**：深链打开会话时「聚焦到该会话」这一步当前从未生效。

### 1.2 功能用户故事

| 编号 | 用户故事 | 覆盖工作面 |
|---|---|---|
| US1 | 作为**部署者**，当任何网页经 DNS rebinding 或跨站请求我的本地 DSH 时，插件路由**不得**凭 Host/Origin 放行；被拒即可 | ① |
| US2 | 作为**部署者**，当浏览器已登录（同源、带 cookie）时，导出下载照常可用 | ① |
| US3 | 作为**部署者**，当宿主不提供信任栅栏时，我宁可**没有这条路由**，也不要一条无门路由 | ① |
| US4 | 作为**协调者**，当某 worker 角色的现任会话是**插件自建**且代理已死时，我能用 `revive` 把它复活（身份不变、信任零改动） | ② |
| US5 | 作为**协调者**，当全队只剩我一个活人（候选为空或已就座）时，我能让插件**新建一个继任者会话**完成改任，而不是把 worker 角色硬塞给我自己 | ② |
| US6 | 作为**使用者**，我能在侧栏直接对任意会话「复制链接」与「导出会话」，不必先进去 | ③ |
| US7 | 作为**使用者**，当列表很长时，我能就地搜索收窄，并且界面**如实告诉我只显示了多少** | ③ |
| US8 | 作为**使用者**，我用深链打开一个会话时，界面应当**真的切到那个会话** | ④ |

### 1.3 非功能标准

- **N1 只降级该面子面**：任何服务缺失，只丢对应的一个面（路由 / 入口 / 一个动作），其余功能照常，且**留一行痕**。不得把可选服务写成模块级 `inject` 硬依赖。
- **N2 变异验证文化**：每条行为变更都要有「**修复前必红 / 修复后全绿**」的读数（本仓既有验收文化，见 `docs/verification-log.md`）。
- **N3 描述面与实现同批同步**：工具 `description`、参数说明、README、诊断文案与代码改动**同一次变更**内对齐。
- **N4 授权轴不动**：不新增模型可见参数、不改 `policy.writer`、动词集保持封闭、人类确认不可绕过。
- **N5 不改官方文件**：不修改 `node_modules` 下任何官方包（DSH 升级即失效，且属旁路，与本生态「未声明槽位注册即抛错」的纪律相悖）。
- **N6 有界呈现必须带标注**：任何截断/上限都必须在界面上写出「共 N、显示前 M」。
- **N7 空态与会话态可区分**：「还没读到」「搜不到」「真的没有」必须是三句不同的话。

---

## 2. 现象与根因

### 2.1 ① 导出路由没有信任栅栏（安全）

**现象（本机实测，2026-09-21）**：对运行中的 `http://127.0.0.1:3080`：

| 请求 | 无 token | `Host: evil.example:3080` |
|---|---|---|
| `GET /`（核心） | 401 | 401 |
| `GET /open-in-app/apps`（内置插件，同一 webServer） | 401 | 403 |
| `GET /thincoder-suite/api/config` | 200 | 200 |
| `GET /team-link/export?session=bogus` | 404 | 404 |

进一步：`GET /team-link/export?session=<真实会话 id>&format=json` 在**无 token、无 cookie**、且同时给出 `Host: evil.example:3080` + `Origin: http://evil.example` + `Sec-Fetch-Site: cross-site` 时，返回 **200 与 7,487,057 字节**的完整会话事件流（顶层键 `exporter/exportedAt/session/title/eventCount/events`）；同一组标记下 `/open-in-app/apps` 返回 403。

**根因**：路由在 `lib/index.js:8019` 注册（`mount` 内），其 handler（`:8022`）在进入业务逻辑前**没有任何** `connection.requestRejection` 调用。平台契约明确「路由所有者自负其责」（`@deepseek-ai/dsh-host-webserver` README：No server-wide TLS, authentication, or origin policy），栅栏由 `dsh-client-connection` 提供：

- `requestRejection(request)` —— `dsh-client-connection/lib/index.js:553`：先 Host/Origin 栅栏（不通过 → `403`），再浏览器鉴权（不通过 → `401`），通过 → `undefined`；
- 同包 `:608-614` 是**官方自己的路由写法**（RPC 通道）：`res.writeHead(rejection)` + `res.end(rejection === 401 ? "unauthorized" : "forbidden")`。

**这不是「平台能力缺失」，也不是被记录下来的取舍**：全仓 `.md` 检索 `requestRejection` / 鉴权 / DNS 均为 0 命中——它是**未文档化的缺陷**。

### 2.2 ② 恢复能力的两处缺口

**现有机制**（`docs/collab-enhancements-design-2026-09-19.md` §11.9.4/§11.9.5，README 亦有同源表述）：`team_link_recover` 恰两个封闭动词。

- `revive`（`lib/index.js:7327`）：用 `ctx.agents.resume`（`:7390`）复活**同一个会话**。两道门：**只受理 coordinator 角色**（`:7334-7336`）与**只受理插件自建会话**（`:7351`，id 形如 `team-link-<team>-<role>-<uuid8>`，或本进程仍持有其 `AgentHandle`）。
- `reappoint`（`:7470`）：候选由插件从**本队活成员**算出（`reapCandidateRoles`，`:7079-7083`），人类勾选后逐字走既有 M4 `rotation.prepare`（`:7520`）。

**真实故障形（团队 threat-intel）**：roster（`D:\workspace\threat-intel\team\threat-intel\roster.md`）为 coordinator = `session-13f57fec-…`（活）· b = `session-c02a7edb-…`（dead）· c = `session-4c0d96ca-…`（dead）。b/c 的 id 是 **人类自建形**（`session-<uuid>`），因此：

- `revive` 在 b/c 上**两道门同时拒**（角色门 + 适用域门）；
- `reappoint` 的候选集只排除被恢复的角色本身，于是**全队唯一活人 coordinator 自己成了唯一候选**——唯一可选路径是「把 worker 角色改任给协调者」，即一个会话同时坐两格。这不是想要的恢复。

**缺口归纳**：（i）角色门把「身份不变的复活」限制在一个角色上，而它是**范围最小化选择、不是安全属性**（§11.9.1 只论证了「coordinator 死必须可救」，从未论证「worker 死不许救活」）；（ii）候选用尽时**没有出口**——错误文案自己点名了「全队代理都拆了」，却只给「去侧栏逐个打开」这一条人工路。

### 2.3 ③ 侧栏会话入口缺失

**现象**：会话行的「…」菜单只有三项（重命名 / 分叉会话 / 归档会话），没有复制链接与导出。

**根因（三条，全部实读）**：

1. 该菜单硬编码在官方包 `dsh-client-ui-workspace/lib/client.js:1113-1129`（`sessionMenuItems`），`onSelect` 只认 `rename/fork/archive`（`:1186-1191`）；
2. **没有可用的槽位**：`dsh-client-ui-slots` 的槽位词表里没有会话行菜单槽；且「向未声明的槽位注册在加载期直接抛错」「声明即独占」是引擎的硬校验；
3. `sidebar.workspaces` 是 `kind:'single'`（官方 sidebar 契约 `contract/slots.d.ts:56-60`），第三方无法并入。

⇒ 该包是 `node_modules` 里的**构建产物**（无 `src`），改它等于旁路官方文件（违反 N5），且会被升级静默还原。

**可行替代（本设计选它）**：侧栏底部存在一个**官方声明、允许任意插件注册**的 list 型槽位 `sidebar.footer.action`：

- 声明：`dsh-client-ui-sidebar/lib/client.js:474-477`（`kind:'list', scope:'root'`）；契约 `contract/slots.d.ts:71-79`；
- 渲染：`:363-372` —— `footArea > footerActions{renderSlot("sidebar.footer.action", {wide})}` **排在** `settingsArea{renderSlot("sidebar.settings", {wide})}` **之前** ⇒ 该槽位天然位于【设置】**上方**；
- owner props 只有 `{ wide: boolean }`（`slots.d.ts:127-130`），收起态的表单由条目自己渲染；
- 排序：list 型按 `order` **升序**（渲染器 `dsh-client-ui-renderer/lib/client.js:1193`）；
- **同槽位已有占用者**：`@kenz1117/dsh-ui-usage-billing` 以 `id:'usage-billing', order:-10` 注册——即用户侧栏里那张「今日消耗金额」卡片。

### 2.4 ④ 深链聚焦是静默空调用

**现象**：用 `dsh://session/<id>` 深链打开一个会话时，界面**不会**切到该会话。

**根因**：`lib/client.js:198` 调用 `ctx.sessions.open(id)`——`ISessions` 的公开面（`@deepseek-ai/dsh-api-session-controller` 契约 `contract/sessions.d.ts:43-159`）**没有** `open` 方法（同文件 `:1746` 的 `Session.open()` 是历史加载，另一回事）。该调用被 `try/catch` 包住（`:197-201`）⇒ **静默失败**。

**正确调用**：`ctx.uiWorkspace.openSession(target)`（`@deepseek-ai/dsh-client-ui-workspace` 契约 `navigation.d.ts:13`；官方内部用法见其 `client.js:2902-2904`）。

---

## 3. 目标与非目标

### 3.1 目标

1. 导出路由对未受信请求一律拒绝，且**在任何服务时序下都不存在无门路由**（US1–US3）。
2. `revive` 的角色面放开到任意角色，**所有权门原样不动**（US4）。
3. `reappoint` 在候选用尽时可让插件**新建继任者**，逐字复用既有 M4（US5）。
4. 侧栏底部新增「会话工具」入口，弹窗内可搜索、列会话、逐行复制链接与导出（US6/US7）。
5. 深链聚焦改用公开导航 API（US8）。

### 3.2 非目标

- 不做会话的**写操作**（改名 / 分叉 / 归档 / 删除）——本入口只做「看 + 复制 + 导出」。
- 不做右键菜单、不做会话行内菜单、不改任何官方文件。
- 不取代或屏蔽既有的会话头部按钮与 `team_link_export` 工具（本入口只增益**可发现性**）。
- 不给 `team_link_recover` 增加任何模型可见参数；不新增令牌类型；不改 `policy.writer`。
- 不动 `dsh-thincoder-suite`（owner 明确排除，由另一会话处理）。

---

## 4. 具体方案与机制

### 4.1 ① 导出路由接入信任栅栏（fail-closed）

**落点**：`registerExportRoute` 的 `mount(target)`（`lib/index.js:8013-8059`）。三处改动，**语义是收紧不是放弃**：

1. **挂载期收紧（双服务齐才挂）**
   - `mount(target)` 在读到 `webServer` 之后，再读 `const connection = target.get?.("connection")`；
   - 新增两个 reason code：`no-connection`（webServer 在、connection 不在）与 `no-rejection`（`typeof connection.requestRejection !== "function"`）；
   - **两者一律不注册路由**，并沿用既有的「一次窗口一行 warn」模式（`:8070-8075`）留痕；
   - 晚挂载从 `ctx.inject(["webServer"], …)`（`:8077`）改为 `ctx.inject(["webServer", "connection"], …)`——cordis 在依赖齐备时才回调，天然给出「双到齐才挂」；
   - `describeMountFailure`（`:8062`）扩两个新 reason 的措辞。

2. **请求期纵深（handler 首句再取一次）**
   - handler（`:8022`）进入业务逻辑前：实时 `target.get?.("connection")`；取不到或没有 `requestRejection` ⇒ 立即 **503 + 结束**（不吐数据）；取到则 `const rejection = connection.requestRejection(req)`，非 `undefined` 即写回该状态码并结束，响应体与官方一致（`401 → "unauthorized"`、否则 `"forbidden"`）。
   - 这一层覆盖「挂载后 connection 被拆」的窗口；与第 1 层叠加，任何时序下都不存在无门路由。
   - **可测面**：把「connection + req → 状态码 | null」的判定抽成**纯函数**，挂进既有的冻结导出面 `__testing`（`lib/index.js:8169`）——U1 可直接单测它，判据不依赖 HTTP 夹具。

3. **方法白名单**：`req.method !== "GET"` ⇒ `405`（对齐官方 `open-in-app` 的写法）。

**红线遵守**：`connection` **不写进模块级 `inject`**（`:98` 保持四成员不变）——那会把插件激活整体押在该服务上，与「服务缺失只丢该面子面」的 N1 直接冲突。README 的降级表（`README.md:808-817`，`webServer` 行在 `:815`）新增一行 `connection`。

**为什么不照抄官方正例的 inject 写法**：`open-in-app` 是核心包，与 webServer 同生共死，把 `connection` 写进 `inject` 对它无代价；本插件是第三方 bundle，**必须能在无 webServer / 无 connection 的宿主上完整降级**。

### 4.2 ② 恢复能力加宽（两格，第三格不做）

**(a) `revive` 放开角色门**（`:7334-7336` 删除该分支）

- **保留不动**：`:7351` 的所有权门（插件自建判定，两半：本进程 handle 或 id 文法）、`:7360` 的 `resume` 可用性检查、`:7363` 的在场确认框、`:7379-7408` 的两次写前复检。
- **理由**：`revive` 是**身份不变**操作——不写 roster、不铸令牌、不动 pairs/trustedSenders/rememberTargets、不改 `policy.writer`。放开角色面**不向「通用 roster 编辑器」移动一寸**；而重载拆掉的是**所有**插件自建会话，不只 coordinator 的。死 worker 原有的 `retire + set-role` 出口保留，本项只是多了一条**不丢信任拓扑**的路。

**(c) `reappoint` 常驻「自建继任者」候选**

- 候选列表**额外追加一项合成候选**：`自建继任者（新建会话）`。它**始终存在**，而不是「仅 0 活候选时出现」——因为本次事故的候选长度是 **1 不是 0**（唯一活人 coordinator），条件式触发根本不会激活。
- 选中后的链路**逐字复用**既有机制，不新造：
  1. 能力闸门（对齐 `:2774-2776`，**但只约束「自建继任者」这条支路**，不是整个动词的入口）：无 `agents.create` ⇒ **弹框照开，只是候选里不出现「自建继任者」**（只列活成员）；**仅当连一个活成员候选都没有**时才 fail-closed 报告且零弹框。**理由（N1）**：活成员改任那条路径**不需要** `agents.create`，它在无该服务的宿主上本可用 —— 把闸门放到动词入口会把它一并拒掉，那是本批之前不存在的**回归**（审计第 5 条，根因是本条措辞含糊，实现方照字面落地）；
  2. 按 §10.2.2 模板铸 id（与 `/team_session`、`successor:"auto"` 同源，即 `createTeamSession`，`:8108`）；
  3. `rotation.prepare`（`:7520`）**逐字跑**：一次性令牌绑定 (team, role, successor) → `rotationBackup` 快照 → `rotation-freeze` 广播；
  4. 交接文档由**插件从 roster 事实自动生成**最小五硬节（硬节常量见 `:2626`）——**不给 recover 增加 `handoff` 参数**（参数面保持封闭）。各节的最小内容与数据来源如下（读不到就**如实标未知**，不编造——§11.9.6 的诚实原则）：
     - `mission`：团队名 + 角色名 + 前任会话 id（全部来自 roster 事实）；
     - `in-flight`：**如实标「前任已死，进行中工作不可读」**——除非该角色有可读的 goal / 表面；
     - `commitments`：该角色在 roster 上的信任指针（pairs / trustedSenders / rememberTargets 的**存在性与数量**，不复制任何密钥素材）；
     - `unknowns`：显式列出上面读不到的项——本节是**主要内容**而非兜底；
     - `task-and-goal`：从 goals 服务读该角色会话的 goal，读不到则标未知。
  5. 审计行 `verb=reappoint, to=<minted>`；继任者凭令牌 `claim`（既有第二道人类关卡原样留在下游）。
- 对话框文案如实声明代价：**继任者是空上下文的新会话**，历史不迁移；信任靠 `claim` 逐项勾选迁移。
- **候选集语义变更**：`reapCandidateRoles` 的「候选 = 活成员」需改写为「**活成员 ∪ 插件自建继任者（常驻）**」——这是本方案最大的一笔文档债，须在 §10 同步清单里落到 README 与设计档。

**(b) 不做：对人类自建会话开放 `revive`**

- 技术上可行（确认框与代价声明 `:7363`/`:7370-7371` 已就绪），但**结果劣化**：`resume` 的 ownerCtx 是插件根 ctx，复活后该代理的运行时所有权归插件、插件卸载即拆；对人类会话做 revive 会把它的生命周期从 UI 转给插件，**严格劣于**现状。确认框让人类**同意**一个更差的状态，并不能让状态不变差。
- 现状拒绝文案（`:7352-7358`）已给出零成本正解：**在侧边栏重新打开该会话**（同一 id 复活，身份/信任/pairs 原样）。真要开，前置是宿主 API 支持 `resume({ownerCtx})`，不是本插件再加一道确认。

**收敛性红利**：(a)+(c) 合起来 ⇒ **此后每次恢复的终态都是插件自建 id**，而插件自建 id 正是 `revive` 的适用域 ⇒ 未来同类死亡都有 L1 可走。

### 4.3 ③ 侧栏「会话工具」入口（UI 与交互）

> 本节是全案 UI/交互决定的**唯一事实源**；实现任务的描述必须转述本节，而不是只引用聊天。

#### 4.3.1 位置与形态

| 项 | 决定 |
|---|---|
| 槽位 | `sidebar.footer.action`（官方 list 型，root scope）——**不改任何官方文件** |
| 条目 id / order | 建议 `id: "team-link-session-tools", order: 0` |
| 与既有占用者的关系 | 消耗卡片 `usage-billing` 是 `order: -10`；升序排列 ⇒ 本入口排在它**后面**。**但「后面」是同一 flex 行里的右侧，不是下方**：官方 `.footerActions` 是 `display:flex`（方向默认 row），且**官方 sidebar 全档 `flex-wrap` 出现 0 次** ⇒ 不换行；插件**无法从子元素侧改变父级换行**（改父级 = 改官方文件，违反 N5）。**真机读数（2026-09-21，owner 截图）**：入口确实渲染在消耗卡**右侧**，【设置】在其**下方**。本行据此更正 —— 原稿写「之下」，是对官方布局的错误推断。**owner 已裁定保持此布局**（2026-09-21，在知悉「改到下方物理上不可达、唯一出路是改官方文件」之后）。 |
| 宽态（`wide: true`） | 图标 + 文字「会话工具」（与【设置】行同一视觉语言） |
| 收起态（`wide: false`，56px 轨道） | **只渲染图标**，文字转为 `aria-label` / `title`（与【设置】同一行为） |
| 触发 | 点击（或 Enter/Space）打开弹窗 |

#### 4.3.2 弹窗

| 项 | 决定 |
|---|---|
| 容器 | 官方 **`Modal`**（居中、挂到 body）——**不是**锚定面板：收起态轨道仅 56px，锚定面板会被裁切 |
| 结构 | 头部（标题 + 当前计数）→ 搜索框 → 会话列表（可滚动）→ 有界呈现标注 → 底部（范围切换 + 关闭） |
| 数据源 | `ctx.sessions.list`（`ObservableSnapshot<SessionListState>`）取 id / 标题 / `updatedAt` / `running`；`ctx.workspaces.list` 限定工作区 |
| 当前会话 | 约定：`retainedBy.mainView > 0` 的那一行（**无公开 getter**，这是官方内部同款约定） |
| 可见性规则 | 沿用官方会话浏览器，并加一条本面板自己的口径：丢弃 `origin === 'subagent'`、丢弃已归档、**丢弃当前会话**。理由：本面板的用途是「**其他**会话」（当前会话的复制/导出已在会话头部按钮上），把它列进来会让「暂无其他会话」这句话与实际行为**不一致**（owner 裁定 ③） |
| 排序 | `updatedAt` 倒序 |
| 默认范围 | **当前工作区**；底部可切「全部工作区」 |

#### 4.3.3 列表行

- 左侧：**运行状态点** —— **恰两态**：运行中 / 空闲（唯一数据源 `SessionSummary.running`）+ 标题（超长省略）+ 相对时间；切到「全部工作区」时时间行追加工作区名。
  - **「无活动代理」（seated-dead）刻意不做**：那是**宿主侧**事实（宿主半边读 `ctx.agents.get(id) !== undefined`），而客户端公开面里 `SessionSummary` **没有 liveness 字段**、`SessionProjectionMap` 的三个键（`sessionListMetadata` / `imageLimits` / `modelSelection`）**也无 liveness**，且本插件客户端半边**没有任何跨半边取数通道**（`rpc.` / `fetch.register` 命中 0）⇒ 要在浏览器侧产生第三态，只能**编造读数**，或**为它新增一条 host→client 通道**（新增设计面，本版不做）。
  - 官方侧栏自己的状态点同样只有「运行 / 等待交互 / 未读」三类、**不含 liveness** —— 本决定与官方口径一致。这条是本档 R3 之后由实现方撞出、经架构师复核确认的**设计更正**（原稿把宿主侧词汇写进了客户端面）。
- 右侧：**两个动作**——「复制链接」「导出会话」。**默认隐藏，鼠标悬停该行（或该行获得键盘焦点）才浮现**——常驻会让列表看起来像按钮墙，打断扫读。
- 点击行本身 = 打开该会话（走 4.3.5 的公开导航 API）。

#### 4.3.4 动作与反馈

| 动作 | 行为 |
|---|---|
| 复制链接 | 写剪贴板 `dsh://session/<id>`（**与会话头部按钮同一格式**），按钮短暂变「已复制 ✓」，并在下方给无障碍可见的一行说明 |
| 导出会话 | `window.location.href = "/team-link/export?session=" + encodeURIComponent(id) + "&format=md"` —— 用**导航**而非 fetch+blob：同源自动带 cookie，天然通过 §4.1 的栅栏，且零 CORS 面。**参数必须编码**（与现有 `lib/client.js:97` 一致；会话 id 现字符集虽安全，但插件铸造的 team/role 段约束更松） |

#### 4.3.5 数据与导航所依赖的公开面

- 读会话：`ctx.sessions.list` / `useSessions`（`@deepseek-ai/dsh-api-session-controller` 客户端契约）：`SessionSummary` 含 `id / title / displayTitle / updatedAt / running`。
- 读工作区：`ctx.workspaces.list`（`@deepseek-ai/dsh-api-workspace-controller` 客户端契约）。
- 导航：`ctx.uiWorkspace.openSession(target)`（`navigation.d.ts:13`）。
- 需在 `package.json` 的 `dsh.client.inject` 中声明：
  - **不需要声明**：`@deepseek-ai/dsh-client-ui-primitives` 是 **shell 的 seed 模块**（证据：`dsh-better-sidebar` 的 `client.js` 引用它，而其 `dsh.client.inject` 不含它；seed 表实读 `dsh-web-frontend/dist/assets/index-8VXBH-f-.js:126`）。
  - **必须写进 `dsh.client.inject`（非 seed）**：`@deepseek-ai/dsh-client-ui-workspace`（导航）、`@deepseek-ai/dsh-api-session-controller`、`@deepseek-ai/dsh-api-workspace-controller`。
  - **运行时可选性（N1 的落点）**：三个非 seed 包在**已发布的 web 组合里恒在**（本插件客户端半边本就依赖 `dsh-client-ui-conversation`）；但**服务是否可用**逐项运行时判定——`ctx.inject(["sessions","workspaces","uiWorkspace"], …)` 齐备才注册入口，缺任一项 ⇒ **入口不注册 + 一行 warn**（§4.3.6），客户端半边其余部分（深链、发送卡片）照常工作。

#### 4.3.6 状态与边界（逐条设计）

| 情况 | 表现 | 依据 |
|---|---|---|
| 正在读取 | 列表位置显示「读取中…」 | N7：**不得**显示空列表 |
| 搜索无匹配 | 「没有匹配「xx」的会话」 | N7：与「真的没有」区分 |
| 真的没有其他会话 | 「暂无其他会话」 | N7 |
| 结果超过显示上限 | 列表末尾一行：「共 N 个，仅显示前 M 个（搜索可收窄）」 | N6：**有界呈现必须带标注** |
| 会话/工作区服务不可用 | **入口不注册**（一行 warn），而不是渲染一个点了没反应的假按钮 | N1 + 「假按钮比没有按钮更坏」 |
| 收起态 | 只渲染图标 | §4.3.1 |
| 收起 + Windows 标题栏模式 | 整个 `footArea` 被官方 CSS 隐藏（含【设置】）⇒ 本入口一并不可见 | **已知限制**，owner 已决定接受：展开侧栏即可用 |

#### 4.3.7 键盘与无障碍

- Tab 进入入口；Enter / Space 打开；Esc 关闭并把焦点还给入口；列表行可聚焦（焦点即浮现动作）；动作按钮有独立无障碍名（含会话标题）；复制结果通过 `aria-live` 播报；尊重 `prefers-reduced-motion`。

### 4.4 ④ 深链聚焦改用公开导航

- 把 `lib/client.js:198` 的 `ctx.sessions.open(id)` 换成 `ctx.uiWorkspace.openSession(...)`（`navigation.d.ts:13`）；保持既有的「等待会话出现在 `sessions.list` 再聚焦」重试循环（`:188-206`）不变。
- 失败路径仍只记一行痕、不打断打开流程（现状即如此，语义不变）。
- 需在 `dsh.client.inject` 中声明 `dsh-client-ui-workspace`（非 seed）；并**运行时**经 `ctx.inject(["uiWorkspace"], …)` 取用——缺席时只丢「聚焦」这一步，不阻断打开（与 §4.3.5 的可选性规则同一口径）。

---

## 5. 边界与防偏离

| # | 红线 | 落地方式 |
|---|---|---|
| B1 | 不把 `connection` / `webServer` 写进模块级 `inject` | 两服务走同一条可选服务缝（`ctx.get` + `ctx.inject` + 一行 warn） |
| B2 | 无门路由在任何时序下都不存在 | 挂载期双服务齐 + 请求期实时复检，两层都 fail-closed |
| B3 | `revive` 的所有权门不动 | 仅删角色门；`:7351` 原样 |
| B4 | 绝不把 `policy.writer` 降级为 `any` 当作「修复」 | 恢复链路无任何 `policy` 写入 |
| B5 | `team_link_recover` 参数面封闭 | 不新增参数；交接文档由插件从 roster 生成 |
| B6 | 候选由插件算，模型不得指定继任者 id | 合成候选的 label 由插件产出、答案按 label 回读 |
| B7 | 不改官方文件 | 只用已声明的槽位与公开服务 |
| B8 | 本入口不做会话写操作 | 动作集恰为「复制链接 / 导出会话 / 打开会话」 |
| B9 | 描述面与实现同批 | §10 清单 |

---

## 6. 验收标准

判据分两类：**必红**（修复前必须实测为红，证明判据真的看住了那一面）与**必绿**（实现后必须全绿）。测试面：`host-half.test.mjs` 与 `client-half.test.mjs`。**基线（2026-09-21 实跑）**：`node host-half.test.mjs` → **889 (failed: 0)**；`node client-half.test.mjs` → **170 (failed: 0)**——「必红」以这条基线为起点量。

| # | 判据 | 修复前 | 修复后 |
|---|---|---|---|
| U1 | 带 `Host: evil.example:3080` + 跨站标记请求导出路由 → 403（或 401），**响应体为 `forbidden`/`unauthorized` 且不含任何会话数据**，且 `sessionQuery.readSession` **从未被调用**；同一判定另作纯函数经 `__testing` 单测（§4.1） | **必红**（实测 200 + 7.4MB） | 绿 |
| U2 | webServer 在、connection 缺 → **不注册路由**（`routes.length === 0`）且**恰一行 warn** | **必红**（现状会注册） | 绿 |
| U3 | webServer 与 connection 都缺 → 无路由 + 一行 warn（既有红线保持） | 绿（既有断言） | 绿 |
| U4 | 两者晚到齐 → 路由挂载（既有 late-attach 断言扩展） | — | 绿 |
| U5 | 受信请求 + 已鉴权 → 200 且 `content-disposition` 文件名不变式保持 | 绿 | 绿 |
| U6 | 非 GET 方法 → 405 | **必红**（现无方法检查） | 绿 |
| U7 | 插件自建的**非 coordinator** 角色 seated-dead → `revive` 成功（`resume` 收到该 id、审计行写入、信任零改动） | **必红**（现被角色门拒） | 绿 |
| U8 | 人类自建 id 的 worker → `revive` **仍拒**，且文案含侧边栏指引 | 绿（既有 Y3-sym 对称锁） | 绿 |
| U9 | 照 threat-intel 形（coordinator 活、b/c 人类 id dead）→ `reappoint role=b` 弹框**含**「自建继任者」；选中后 `agents.create` 被调、`prepare.successor = team-link-threat-intel-b-<uuid8>`、三处留痕（版本史 / roster.md / decisions.md） | **必红**（现只能选 coordinator 或报错） | 绿 |
| U10 | 无 `agents.create` 的宿主：**弹框照开且候选里不含「自建继任者」**（只列活成员）；**仅当活成员候选也为 0** 时才 fail-closed 文案 + 零弹框；**活成员改任路径不受影响** | **必红**（原实现会被整动词闸门一并拒掉） | 绿 |
| U11 | 不勾选任何候选 → 零令牌、零 freeze、零写入 | 绿（既有） | 绿 |
| U12 | 侧栏入口：服务齐备时注册一次；服务缺失时**不注册**且一行 warn | **必红**（入口尚不存在） | 绿 |
| U13 | 弹窗三态文案互不相同：读取中 / 无匹配 / 暂无其他会话；超过上限时出现「共 N，显示前 M」 | **必红** | 绿 |
| U14 | 深链打开会话后，**当前会话 id 真的变为目标 id**（`retainedBy.mainView` 判定） | **必红**（现状静默空调用） | 绿 |

**实测结果（2026-09-21）**：批 1 → host **903 (failed: 0)**（U1–U6 绿，红相 **10**）· 批 2 → host **920 (failed: 0)**（U7–U11 绿，红相 **21**）· 批 3 → client **257 (failed: 0)**（U12–U14 绿，红相 **27** 与 **7**），host 仍 **920**。**真机**：侧栏入口已在 3080 页面渲染（owner 截图，宽态）。**真机复验点 1 的拒绝面已闭合（2026-09-21，owner 重启后由架构师复跑）**：**红相（重启前）** 本路由在跨站标记下仍 **200 + 5,479,970 B**，而内置 `/open-in-app/apps` 403、核心 `/` 401 ⇒ 栅栏在树里、宿主半边待重启；**绿相（重启后）** 本路由 **403（响应体 `forbidden`，9 B）**、内置 `/open-in-app/apps` **403**、核心 `/` **401**，且**同源无 token 时本路由 401**（栅栏过、鉴权拦）—— 与设计的两段语义逐字相符；**真实会话 id 与 bogus id 结果相同**（均 403）⇒ 拒绝发生在任何 `readSession` 之前。**该点自身的正路径仍未验**：§6 的点 1 判据含两半 —— 拒绝面（上方读数）已闭合，而「**同源带 cookie 的浏览器请求 → 200 全量**」这一半**尚无读数**（需一次已登录浏览器的下载复验）。**仍未闭合**：真机复验点 3 的收起 / 标题栏两态（无浏览器驱动面）。

**真机复验点**（不以单元测试代替）：

1. §2.1 的三条 curl 组合重放 → 与 `/open-in-app/apps` 同判（403）；同源带 cookie 的浏览器请求 → 200 全量；
   - **拒绝面已闭合**（2026-09-21 重启后复跑，读数见上方「实测结果」段与 `docs/verification-log.md` 的「批次 4 · H 真机复验点 1 · 绿相（重启后）」一节）；**「同源带 cookie → 200 全量」这一半仍无读数** ⇒ 点 1 整体**未闭合**。
2. `reappoint` 用 threat-intel 的真实 roster 形做一次演练（可复刻夹具，不必动真实团队）；
   - **未闭合**：本批**未执行**这次演练 —— 批 2 / 批 4 关于 `reappoint` 的判据都是**单元夹具**（`threatEnv` 形），没有用 threat-intel 的真实 roster 形（coordinator 活 · b/c 为人类自建 id · 双死）在真机上跑过一次；如实记为未闭合。
3. 侧栏入口在 3080 页面上的实际渲染（宽态 / 收起态 / 标题栏收起态三种），并核对与消耗卡片、【设置】的相对位置。
   - **宽态 ✓（2026-09-21，owner 截图）**：入口**已渲染**，位于消耗卡**右侧**、【设置】**上方** —— 与 §4.3.1 更正后的描述一致。
   - **收起态 ✓（2026-09-21，owner 目视）**：56px 轨道下**只剩图标**、与使用卡同一行、【设置】在其下方 —— 与 §4.3.1 的「只渲染图标 + `aria-label`」逐条相符。
   - **未闭合**：**标题栏收起态**（`[data-windows-titlebar]` + 侧栏收起 ⇒ 官方隐藏整个 `footArea`）尚未在真机核对（见 §9 A1）。该态下入口按设计**一并不可见**，这正是 §4.3.6 已记录的**已知限制**。

---

## 7. 明确不做

1. 不做右键菜单（会话行在 DOM 上**没有任何身份标记**——实读该包零 `data-*`；截右键认不出是哪个会话）。
2. 不做会话行内菜单（无槽位，见 §2.3）。
3. 不修改 `node_modules` 下任何官方包（含「打补丁改构建产物」——降级为不可选的旁路，理由见 §2.3 与 §8）。
4. 不做会话写操作（改名/分叉/归档/删除）。
5. 不新增 `team_link_recover` 参数、不新增令牌类型、不改动词集。
6. 不把 `reappoint` 已就座候选「排除」——**本次不改该语义**（见 §9 A2）。
7. 不动 `dsh-thincoder-suite`。

---

## 8. 会诊 #62 意见处置摘要

会诊 4 模型 2 交付（`codex-cli:gpt-6-astra` 进程失败、`fangzhou-codingplan:kimi-k3` 超时）。完整逐条处置见 `docs/consult-minutes/2026-09-21-consult-62-minutes.md` §2–§3；本节只留**改变了本设计**的部分：

- **采纳（两模型独立同判）**：栅栏走可选服务缝、不写模块级 `inject`；`revive` 只放开角色门、保留所有权门；`reappoint` 增加自建继任者；Q3 因无槽位只能另辟入口。
- **采纳并合成**：挂载期收紧（一模型主张）**与**请求期实时复检（另一模型主张）合成**两层**，而不是二选一。
- **不采纳原式**：一模型给出的候选触发谓词 `candidates.every(c => team.roles.some(r => r.current === c.session))` **恒真**（候选本就由 `team.roles` 映射而来），整式退化为「永远出现 auto」⇒ 采纳其**意图**（常驻合成候选），不采纳该表达式。
- **不采纳**：对人类自建会话开放 `revive`（理由见 §4.2 末）。
- **坐标勘误**：一模型把「晚挂 + 降级契约」标为 `lib/index.js:742`——实读 `:742` 是 pendingCreates 解析里的 `role` 取值行；该契约在 `:8070-8082` 与 `:7986-7996`。本档一律使用复核过的坐标。

---

## 9. 显式假设与待验项

> 以下**不是已知事实**，实现前或实现中必须实测；与结果不符时回本档修订，不闷头跑。

| # | 假设 / 待验 | 若不成立的后果 | 验证方式 |
|---|---|---|---|
| A1 | 本部署的页面上**未**设 `data-windows-titlebar`（或设了也可接受） | 收起侧栏时入口不可见（owner 已接受该限制） | 打开 3080 页面，检查 `document.documentElement` 属性 |
| A2 | `reappoint` 的既有语义允许「一个会话坐两个角色」（继任者原角色不被清空）——本次**不改**。**另加 caveat**：threat-intel 那次 `reappoint` 的**真实返回文案从未被看到**（候选集由 roster 推出，不是当时的工具输出） | 若判定必须排除「已就座候选」，需一次独立的语义变更设计；若当时的真实返回与推断不符，(c) 的触发形需重定 | 读 `prepare` 对 `roles` 的写入范围；另找一次真实 `reappoint` 输出留痕——找不到就按「未见过」如实记入结果 |
| A3 | 客户端可稳定订阅 `ctx.sessions.list` 并拿到 `retainedBy` | 「当前会话 / 当前工作区」判定需换方案 | 真机渲染验证（U12/U13） |
| A4 | `Modal` 在 56px 轨道下不被裁切（挂 body） | 收起态需改为别的容器 | 真机验证（§6 复验点 3） |
| A5 | `ctx.inject(["webServer","connection"], …)` 在两者齐备时确实回调 | U2/U4 的时序判据需重设计 | 单元夹具（可注入 stub 两服务） |
| A6 | 导出走 `location` 导航可由同源 cookie 通过新栅栏 | 需改为带凭据的 fetch 或另定 | §6 真机复验点 1（同源带 cookie） |
| A7 | 放宽 `revive` 角色门（§4.2 (a)）与**既有测试断言不冲突**——**未跑测试**，属实现期必验项（会诊纪要 §5 第 6 条） | 若有既有断言把「非 coordinator 一律拒」钉死，批次 2 必须同批改写该断言，并在 `docs/verification-log.md` 记下这次语义变更 | 跑 `node host-half.test.mjs` 与 `node client-half.test.mjs`，对照既有 recover 家族断言 |

**实证回填（2026-09-21，批次 1/2 交付后）**：**A5 ✔ 成立** —— 批次 1 的套件断言证明双服务齐备时 `ctx.inject(["webServer","connection"], …)` 回调并挂载，两者晚到齐同样挂载（该批的 late-attach 断言）。**A7 ✔ 风险确实发生、且处理方式正确** —— 批 2 撞上既有 recover 家族断言，做法是**按新语义改写 6 条**（不是删除），host 读数 903 → 920 逐字对上。**A1/A3/A4/A6 仍未闭合**（真机面，见 §6 真机复验点）。

---

## 10. 跨文档同步清单

以下文档必须与实现**同批**修改（违反 = 本仓文档卫生不达标）：

| 文档 | 改什么 |
|---|---|
| `README.md` | 降级表（`:808-817`）加 `connection` 行；§11.9.4 恢复叙述同步 (a)/(c)；文档地图（`:841-845`）登记本档，并**修正既有失真**（`:842` 仍写 ③b `team_link_recover`「**未实施**」与「**三项都未发布、未真机验证**」）；版本徽章（`:8`，现为 `version-0.3.7`）刷到实际版本；架构图（`:78-92`）补侧栏入口与栅栏。**已实跑核对**：tests 徽章（`:7` 的 `889 + 170`）**数字与实跑一致**（`node host-half.test.mjs` → 889、`node client-half.test.mjs` → 170，均 failed: 0）——**但 `:825` 把这两个数标成了「0.3.8 收口时点」，标签是错的**（父设计 `docs/collab-enhancements-design-2026-09-19.md` 记的 0.3.8 收口是 host 836 / client 146）⇒ 这一趟把**标签口径**一并纠正为「实跑时点」；CHANGELOG 里 0.3.8 的 `874 + 146` 是**当时**的时点计数，该文件自述「历轮时点计数保留原文不改」，两者不冲突 |
| `docs/team-upgrade-design-2026-09-17.md` | §9.1.3（晚挂/降级契约的归属节，`:600` 起；`:663-664` 记 `registerExportRoute` 为「同类竞态的第三处（会诊 O6）」，`:664` 记下被否决的「把 webServer 写进 inject」备选——即本档红线 B1 的出处）——增补**双服务 fail-closed 的挂载语义**，与本档 §4.1 同源 |
| `CHANGELOG.md` | 新版本条目：四条工作面 + 变异证据 |
| `docs/verification-log.md` | 逐条 U1–U14 的红相/绿相读数 |
| `docs/collab-enhancements-design-2026-09-19.md` | §11.9.4/§11.9.5 增补：(a) 角色面放开、(c) 候选集语义变更（「活成员 ∪ 插件自建继任者」） |
| `lib/index.js` 内 | `team_link_recover` 工具 `description`（`:7605`/`:7608`）、参数文案（`:7612`/`:7614`）、诊断行（`:7587`） |
| 本档 | §9 待验项结论回填；§6 结果回填 |

---

## 11. 实施分批

| 批次 | 内容 | 面 | 理由 |
|---|---|---|---|
| **批次 1** | §4.1 导出路由栅栏（含 warn/字段/文档同步） | `lib/index.js` + `host-half.test.mjs` + README | 独立、最小、安全优先；与其他批无耦合 |
| **批次 2** | §4.2 恢复加宽 (a)+(c)（含宣传面同批） | `lib/index.js` + `host-half.test.mjs` + README/设计档 | 与批次 1 同文件、不同机制；一批做完便于一次评审 |
| **批次 3** | §4.3 侧栏「会话工具」入口 + §4.4 深链聚焦修复 | `lib/client.js` + `client-half.test.mjs` + `package.json`(client inject) | 纯客户端面；④ 与 ③ 同文件，同批做 |

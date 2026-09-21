# Changelog

本文件记录 `dsh-team-link` 的变更史。版本号策略：`package.json` 的版本号**随发布统一 bump**——开发期累积的条目先记为「未发布」，发布时一次性收口（例如 0.3.1–0.3.6 的条目在 0.3.7 发布时一并落定）。

格式：每个版本按 **修了什么 → 为什么 → 怎么验证** 组织。凡涉及行为修复的条目都附**变异验证**证据（修复前必红 / 修复后全绿），这是本仓库的验收文化。

---

## 0.3.9 — 未发布（加固与恢复）— ① 导出路由信任栅栏 · ② 恢复能力加宽 · ③ 侧栏「会话工具」入口 · ④ 深链聚焦修复

> 设计（唯一事实源）：`docs/hardening-and-recovery-design-2026-09-21.md` §4.1–§4.4（含 §5 红线 B1–B9 与 §6 判据 U1–U14）；逐条**红相/绿相读数**见 `docs/verification-log.md`。四条工作面按 §11 分三批实施，本条目随批次追加。
> **发布状态**：①② 属宿主半边，需 DSH 重启才在真机生效；③④ 属浏览器半边（客户端 bundle 重建 + 刷新页面）。真机复验点 1 的**拒绝面已闭合**（2026-09-21 重启后复跑，原始读数见 `docs/verification-log.md`「批次 4 · H 真机复验点 1 · 绿相（重启后）」一节）；**仍未闭合的真机面**（如实列出）：① 点 1 的「**同源带 cookie → 200 全量**」正路径**无读数**；② **点 2**（`reappoint` 用 threat-intel 真实 roster 形演练）**从未执行** —— 现有判据都是单元夹具形；③ 点 3 的**标题栏收起态**未核对。而点 3 的**宽态**与**收起态**已由 owner 在 3080 页面上真机确认（宽态：位于消耗卡**右侧**、【设置】上方；收起态：56px 轨道下只剩图标、与使用卡同一行）。与 0.3.8 同口径，**不把未验的东西说成已验**。

### 批次 1 —— §4.1：导出路由接入平台信任栅栏（两层 fail-closed）

**修了什么**：`GET /team-link/export` 此前是一个**没有任何信任检查**的路由——任何能连上本机端口的请求（DNS rebinding / 跨站页面）都能拉走整份会话事件流。本批把它接上平台自己的栅栏 `connection.requestRejection`（Host/Origin → 403、浏览器鉴权 → 401），并**两层都 fail-closed**：

1. **挂载期**：路由只在**同时**拿到 `webServer` 与 `connection`（且后者有 `requestRejection`）时才注册；新增两个 reason code `no-connection` / `no-rejection`，与既有 `not-active` / `no-register` 一样——**不注册路由 + 一行 warn**（点名缺的是哪一个）。晚挂从 `ctx.inject(["webServer"])` 改成 `ctx.inject(["webServer", "connection"])`，两个提供方任意顺序到齐才挂载。
2. **请求期**：handler 的**第一句**实时复检栅栏；取不到（服务缺席、方法缺失、或**挂载之后被拆**）⇒ `503` + 不吐数据；取到则把它的状态码**原样写回**，响应体与官方 `client-connection` 的 RPC 通道一致（401 `unauthorized` / 403 `forbidden`）。这一层覆盖挂载期判不到的那个窗口。
3. **方法白名单**：非 `GET` ⇒ `405` + `allow: GET`（对齐官方路由写法），任何会话都不读。

**为什么**：平台契约明确「路由所有者自负其责」（`dsh-host-webserver`：不做 server-wide 认证/来源策略），栅栏由 `dsh-client-connection` 提供给**每个**路由所有者；本插件此前全库 0 处调用它——这是一处**未文档化的安全缺陷**，不是被记录下来的取舍。

**怎么验证（变异验证）**：

- **修复前必红**（本批新增 14 条断言，基线 889 不动）：`node host-half.test.mjs` → `assertion total: 903 (failed: 10)`。10 条 FAIL 恰是本次要修的每一面：U1 纯函数不存在 / 跨站请求真的拿到 200 + 会话正文且 `readSession` 被调用 / 路由从未把请求交给平台栅栏 / 401 分支无人写回 / 挂载后栅栏消失仍照常吐数据 / U6 非 GET 被当 GET 服务 / U2「webServer 在、connection 缺」仍然注册了路由（无门路由真实存在）/ `no-rejection` 分支不存在 / U4 只到 webServer 就挂载。
- **修复后全绿**：`node host-half.test.mjs` → `assertion total: 903 (failed: 0)`；`node client-half.test.mjs` → `170 (failed: 0)`（未触及浏览器半边）。
- **红线 B1**：`connection` **没有**进模块级 `inject`（仍恒为四项），仍走 `ctx.get` + `ctx.inject` 的可选服务缝；断言直接读导出数组。
- 新增可测面：`__testing.exportGateRejection(connection, req)` —— `connection + req → 状态码|null` 的**纯函数**判定（U1 不必依赖 HTTP 夹具；接受 `null` = 放行、`503` = 无栅栏可问）。

**如实标注（设计未规定的一处实现选择）**：`503` 这一支的响应体写的是 `unavailable`，而 401/403 严格照官方（`unauthorized` / `forbidden`）。理由写进了代码注释：403 的含义是「栅栏说了不」，503 的含义是「**没有栅栏来裁决**」——把后者写成 `forbidden` 等于报告一个从未发生过的信任判定。

**同批同步的面**：`README.md`（§二 导出段新增「下载路由走平台信任栅栏」一段、§七 契约的服务清单、依赖服务降级表新增 `connection` 行、架构图的导出路由节点）；本条目。

### 批次 2 —— §4.2：恢复能力加宽两格（(a) `revive` 放开角色门 · (c) `reappoint` 常驻「自建继任者」）

**修了什么**：

1. **(a) 删除 `reviveIncumbent` 的角色门**——`revive` 现在受理**任意角色**（所有权门、`resume` 可用性检查、在场确认框、两次写前复检**一律不动**）。
2. **(c) `reappoint` 的候选集改为「活成员 ∪ 插件自建继任者（常驻）」**——合成候选 `自建继任者（新建会话）` **始终在列**（不是「仅 0 活候选时才出现」：事故当场的候选长度是 **1 不是 0**）。选中它时逐条复用既有链路：能力闸门（**批次 4 收窄到这条支路**：宿主无 `agents.create` ⇒ 弹框照开、候选里**不出现**「自建继任者」；**仅当活成员候选也为 0** 时才 fail-closed 报告且零弹框——活成员改任那条路不需要该服务）→ 按 §10.2.2 铸 id（`team-link-<team>-<role>-<uuid8>`）→ 交接文档由**插件从 roster 事实**生成五硬节（读不到的项——前任的进行中工作与 goal、未提交的改动——**如实标未知**，不编造）→ `prepare` 逐字跑 → 审计行 `verb=reappoint`。原有的「候选集为空 ⇒ 一条死路」分支因此**不可达并被删除**。

**为什么**：(a) `revive` 是**身份不变**的操作（不写 roster、不铸令牌、不动 pairs/trustedSenders/rememberTargets、不碰 `policy`），放开角色面不向「通用 roster 编辑器」移动一寸；而重载拆掉的是**所有**插件自建会话，不只 coordinator 的——§11.9.1 只论证过「死的 coordinator 必须可救」，从未论证「死的 worker 不许救活」。(c) 候选用尽时原本**没有出口**：全队只剩协调者一个活人时，唯一可选路径是「把一个 worker 角色硬塞给协调者」。

**怎么验证（变异验证）**：

- **修复前必红**：把**本批的新测试**跑在**批次 1 的 `lib/index.js`** 上（隔离夹具 `.test-tmp/s2-red/`：新测试 + 新 README + 旧实现）⇒ `assertion total: 920 (failed: 21)`，21 条 FAIL 全部落在本批断言上：U7 两条（插件自建的死 worker 被角色门拒）、U8（**连所有权门的文案都读不到**——角色门先拒，这正是「角色门挡在适用域之前」的实证）、U9 **九条**（对话框里没有合成候选、没有创建、没有交接文档、没有三处留痕；同组那条「新建的会话是根会话、meta 无血统字段」在修复前**本来就为真**——旧实现从不 `create`，`creates` 为空——所以它**不在**红相里，批次 4 重跑实测定档）、U10（无 `agents.create` 时既没有闸门也没有零弹框）、U11 与收敛性两条，以及**六条被本批语义变更推翻的既有断言**（U26 角色面 / Y1 对照 / Y1 文档面=实现面（双向锁）/ Y2 宣传面 / U27 候选由插件算 / U27 全队皆死）= 2+1+9+1+2+6 = **21**，与 `920 (failed: 21)` 逐字对上（原文记「U9 十条 / 五条」是**计数勘误**，加总 22 与实测差一条，批次 4 已按实跑读数改准——见 `docs/verification-log.md` 批次 2 的「计数勘误」小节）——设计 §9 A7 点名的「既有断言可能把非 coordinator 一律拒钉死」**实测成立**，本批按新语义改写这六条而不是删除（每条都留了改写说明）。**红相是干净的**：套件跑到底并打印了 `assertion total`（首版红跑因直接调用尚未存在的 `__testing.selfBuiltHandoffBody` 而崩在那一行、连总数都不打印，已按本仓 Y7 纪律加类型护栏——那正是 Y7 存在的理由）。
- **修复后全绿**：`node host-half.test.mjs` → `assertion total: 920 (failed: 0)`（新增 **17** 条，`920 − 903`）；`node client-half.test.mjs` → `170 (failed: 0)`（未触碰）。
- **红线回归**：所有权门原样（U8）、`writerGate`/三道门本体未动、`policy.writer` 未动、`claim` 一字未改、不新增令牌类型、**不新增参数**（`handoff` 没有进 recover 的参数面——交接正文由插件生成）、模块级 `inject` 仍 4 项。

**如实标注（设计没有逐字规定、由实现定夺的两处）**：

- **自建继任者的工作目录**：优先用**团队自己的 `workspace`**（该队的 roster 镜像与交接文档就在它下面），团队没记录时回落**发起会话的 cwd**；两者都取不到绝对路径 ⇒ fail-closed（零创建）。`process.cwd()` 一律不用（与 `successor:"auto"` 同一条边界）。设计 §4.2 (c) 未规定 cwd 的取法。
- **交接文档与 `prepare` 的先后**：按 **§11.9.6 的 abort-before-prepare**（文档失败 ⇒ 不铸令牌）排在 `prepare` **之前**，也就是与 `successor:"auto"` 同序；§4.2 (c) 的编号（③ prepare → ④ 文档）是**元素清单**而不是时序，本批取了与既有 auto 路径一致的时序。

**同批同步的面**：`lib/index.js` 的 `team_link_recover` description（两个动词的角色面 + 候选集 + 合成候选链路 + 代价声明）、`action`/`role` 参数文案、诊断行；`README.md` 的工具表、§11.9.4 恢复叙述（角色面 + 自建继任者段）、八条硬约束的 ③；`docs/collab-enhancements-design-2026-09-19.md` §11.9.4/§11.9.5 的两处增补。

### 批次 3 —— §4.3 侧栏「会话工具」入口 · §4.4 深链聚焦修复

**修了什么**：

1. **§4.3 入口**：侧栏底部新增「会话工具」——注册进官方 list 槽位 `sidebar.footer.action`（`id: team-link-session-tools`、`order: 0`）⇒ 入口落在**同一 flex 行内、位于消耗卡片 `order: -10` 的右侧**（`order: 0` 升序 ⇒ 排在它之后、【设置】之前）；**不是「下方」**：官方 `.footerActions` 是 `display:flex`（方向默认 row），且官方 sidebar 全档 `flex-wrap` 出现 **0** 次 ⇒ **不换行**，而插件**无法从子元素侧改变父级换行**（改父级 = 改官方文件，违反设计 §1.3 的红线 N5），2026-09-21 真机读数（owner 截图）与之一致——**原稿把「排在后面」写成上下排布，是对官方布局的错误推断，本行按设计 §4.3.1 更正**。本入口**不改任何官方文件**。宽态 = 图标 + 文字「会话工具」，收起态（56px 轨道）**只渲染图标**（文字转 `aria-label`/`title`）；点击 / Enter / Space 打开官方 **`Modal`**（居中、挂 body——锚定面板会被 56px 轨道裁切）。
2. **弹窗（§4.3.2）**：标题 + 当前计数 → 搜索框 → 会话列表（可滚动）→ 有界呈现标注 → 底部（范围切换 + 关闭）。数据源 = `ctx.sessions.list` / `ctx.workspaces.list`：丢弃 `origin === 'subagent'`、丢弃已归档、blank 行只保留当前会话（官方会话浏览器同款规则），按 `updatedAt` 倒序；当前会话 = `retainedBy.mainView > 0` 的那一行；**默认范围 = 当前工作区**，可切「全部工作区」。
3. **列表行（§4.3.3）**：状态点 **恰两态**（运行中 / 空闲，唯一数据源 `SessionSummary.running`）+ 标题（超长省略）+ 相对时间（用官方 `relativeTime` 分桶、本插件字典给词；「全部工作区」时追加工作区名）；「复制链接」「导出会话」**默认隐藏，悬停该行或焦点落在该行内才浮现**（CSS `opacity` + `:focus-within`）；点行本身 = 打开该会话。
4. **三个动作（§4.3.4）**：复制 = 剪贴板 `dsh://session/<id>`（与会话头部按钮**同一格式**）+ 短暂「已复制 ✓」+ `aria-live` 播报；导出 = **导航** `GET /team-link/export?session=…&format=md`（同源自动带 cookie、天然过 §4.1 的栅栏、零 CORS 面；参数必须编码）；打开 = `ctx.uiWorkspace.openSession(id)`（**运行时**经 `ctx.inject(["uiWorkspace"], …)` 取用）。
5. **状态与边界（§4.3.6）**：三种空态**三句不同的话**（读取中… / 没有匹配「xx」的会话 / 暂无其他会话）；超过显示上限时末尾写明「**共 N 个，仅显示前 M 个（搜索可收窄）**」；`sessions` / `workspaces` / `uiWorkspace`（以及 seed 模块的 `Modal`）缺任一项 ⇒ **入口不注册 + 一行 warn**，绝不渲染假按钮。
6. **键盘与无障碍（§4.3.7）**：Tab / Enter / Space 可用；关闭（Esc / 关闭按钮 / 成功打开）**把焦点还给入口**；动作按钮带独立无障碍名（含会话标题）；尊重 `prefers-reduced-motion`。
7. **§4.4 深链聚焦**：把 `ctx.sessions.open(id)` 换成 `ctx.uiWorkspace.openSession(id)`，并**保留**「等会话出现在 `sessions.list` 再聚焦」的重试循环；服务缺席只丢「聚焦」这一步，失败只留一行痕。
8. **`package.json` 的 `dsh.client.inject`** 增三项：`@deepseek-ai/dsh-client-ui-workspace`、`@deepseek-ai/dsh-api-session-controller`、`@deepseek-ai/dsh-api-workspace-controller`。**seed 模块 `@deepseek-ai/dsh-client-ui-primitives` 刻意不声明**（与 `react` 同级由 shell 注入）。

**为什么**：官方会话行的「…」菜单**没有扩展槽位**、且硬编码在 `node_modules` 的构建产物里（设计 §2.3）——改它等于旁路官方文件且会被升级静默还原；侧栏底部那个 list 型槽位是官方**声明允许任意插件注册**的座位。而深链聚焦是一处**静默空调用**（§2.4）：`ISessions` 公开面**没有** `open` 方法（同名的 `Session.open()` 是历史加载，另一回事），调用抛出的 TypeError 被 `try/catch` 吞掉 ⇒ 列表轮询到了、界面却停在原地。

**怎么验证（变异验证）**：

- **修复前必红（整批）**：隔离夹具 `.test-tmp/s3-red/`（本批新测试 + `git show 8d40343:lib/client.js`）⇒ `node .test-tmp/s3-red/client-half.test.mjs` → `assertion total: 193 (failed: 27)`。27 条 FAIL 全部落在本批断言上：9 条 §4.3 红相守卫（入口未注册 / 入口与弹窗工厂不存在 / 五条纯规则不存在）+ `§4.3 可测面` + 9 条被新语义推翻的既有计数断言（`fresh.length` 4→5、`names()` 多一行）+ 7 条 U14。
- **U14 单独红相（设计 §6 点名的那条）**：`.test-tmp/s34-red/`（当前实现**只**把 §4.4 那一行还原成 `ctx.sessions.open(id)`）⇒ `257 (failed: 7)`，其中判据那条即「**深链打开后当前会话 id 不变**」——以 `retainedBy.mainView` 判定，主视图仍留在启动时那个会话上（另有 4 条 U14 与 1 条病灶锁同时红）。
- **修复后全绿**：`node client-half.test.mjs` → `assertion total: 257 (failed: 0)`（新增 **87** 条 = 257 − 170：10 条红相守卫/可测面 + 77 条 §4.3/§4.4 断言；另有 **9 条既有断言**在同一批里按新语义改写——`fresh.length` 4→5 与 `names()` 多一行，见下条变异验证）；`node host-half.test.mjs` → `920 (failed: 0)`（本批未触碰宿主半边）。
- **红线**：不改官方文件；本插件**模块级** `inject` 仍恒三项（`slots` / `sessions` / `locale`）——三个新依赖只进 `dsh.client.inject`（模块图）与运行时 `ctx.inject`（服务）；本入口的动作集恰为「复制链接 / 导出会话 / 打开会话」，**不做任何会话写操作**。

**同批同步的面**：`README.md`（§二 新增「侧栏「会话工具」入口」小节与三种空态表、深链段的聚焦修复指针、§九「浏览器半边的模块声明」、§十 读数与口径、设计文档索引登记本档并修正 ③b「未实施」的既有失真、版本徽章 0.3.7→0.3.8、测试徽章 889+170→920+257、架构图加侧栏入口节点与导出边）；本条目；`docs/verification-log.md` 的批次 3 条目。

**如实标注（设计未逐字规定、由实现定夺的地方）**：

> **后续变更（批次 4 G，2026-09-21）**：**列表已改为丢弃当前会话**（见下文「批次 4」第 7 条 / 设计 §4.3.2 的可见性规则）——下面这条「列表包含当前会话」的说明**已被取代**，**不再**是当前行为；**原文保留**（本文件不改写历史条目）。当前行为的验收点：工作区里只剩当前会话时显示「暂无其他会话」且一行都不画。（同批「弹窗」条目里那句「blank 行只保留当前会话」同属被取代的旧口径。）

- **列表包含当前会话**：§4.3.2 的可见性规则里没有任何"排除当前会话"的话，且它明确要求"blank 行只保留当前会话"（以当前会话**在列表里**为前提）⇒「暂无其他会话」这句出现在**可见集为空**时（例如整个工作区都已归档）；工作区里只剩当前会话时，列表如实显示那一行、不报空。
- **打开成功后关闭弹窗**：导航本身就是回答，且关闭会把焦点还给入口；只有打开**失败**（导航抛错）才保留弹窗并留一行痕。
- **行的结构**：行是 `<li>`，其可点面是一个真正 `<button>`（Enter/Space 免费可用），两个动作按钮是它的**兄弟**而不是嵌在它里面——`role="button"` 里嵌按钮是把交互内容套进交互内容；"焦点即浮现动作"由 `:focus-within` 承担，行为与设计一致。
- **当前工作区的取法**：设计没规定它从哪来。实现用"当前会话的工作区成员关系优先、其次 `cwd` 匹配"，两者都认不出时**回落到「全部工作区」**——按一个未知的工作区过滤会给出**假的**「暂无其他会话」。
- **列表上限 50**：设计只规定"有界必须标注"、没有给数；取 50（与 `team_link_list_sessions` 的 `LIST_LIMIT` 同量级）。
- **入口图标**用 seed 模块的 `IconLinkOutline16` / `IconLinkOutline14`（与【设置】行同一对尺寸）；设计只说「图标 + 文字」，未指定字形。
- **真机复验点 3（3080 页面上的宽态 / 收起态 / 标题栏收起态渲染，以及与消耗卡片、【设置】的相对位置）未执行**：本批只做单元面，客户端 bundle 需重建 + 刷新页面。与 0.3.8 及批次 1–2 同口径，**不把未验的说成已验**。

### 批次 4 —— 收口轮：闸门收窄 · 合成链路补投递 · `task-and-goal` 接数据源 · 列表丢弃当前会话 · 计数勘误 · 跨档同步

> 起因：一次**只读分歧审计**（对批次 1–3 的交付与文档做逐条对照）报出 10 条，本轮逐条落地其中可执行的部分。审计未改任何文件。

**修了什么**：

1. **A 能力闸门收窄到「自建继任者」支路**（审计第 5 条 / N1）：`reappoint` 的能力闸门原先在**动词入口**——无 `agents.create` 的宿主上，**连「改任给活成员」也一并被拒**（那是本批之前不存在的回归）。现在：无该服务 ⇒ **弹框照开，只是候选里不出现「自建继任者」**（只列活成员）；**仅当活成员候选也为 0** 时才 fail-closed 报告且**零弹框**。对话框里同步写明能力缺口（N1：只降级该面子面，并留痕）。
2. **B 恢复面文案与实现对齐**（审计第 3 条 / N3）：`recoveryBoundaryText()` 第 ③ 项由「候选由插件从**活成员**计算」改为「**活成员 ∪ 常驻的「自建继任者（新建会话）」**」；同批核过工具 `description` 的能力闸门段/合成链路段与 `recoveryDiagnosticLines` 的恢复入口行，三处一并改准。另修正交接正文 `mission` 节里一句**收窄之后就不成立**的话（原文「全队没有可改任的活成员」）。
3. **C 合成链路补投递**（审计第 9 条，功能性缺口）：`appointSelfBuiltSuccessor` 原先**止于审计留痕**——令牌铸了、文档写了、留痕三处齐全，**却从未交给刚建出的继任者**（对照 `successor:"auto"` 的结尾是 `handle.agent.followup(…)`，§11.4.5）⇒ 新建的继任者**空转**，30 分钟后被超时清扫取消。现在补上同一条投递（`followup`，不是 `inject`；消息 `source` 仍恰三成员），并在回执里如实报出投递结果（失败有自己的文案与出口）。
4. **D 五硬节的 `task-and-goal` 接数据源**（审计第 8 条）：`selfBuiltHandoffBody` 原先把该节**硬编码成「未知」**，而它算出的 goals 读数只落到 `in-flight` ⇒ **该节声明的数据源从未被消费**。现在该节渲染 goals 读数，**读不到才**标未知（§4.2 (c) ④）；`unknowns` 同步改为「读数覆盖不到的那一部分」，不再在读到读数时仍声称 goal 未知。
5. **E 计数勘误**（审计第 4 条，本仓红线）：批次 2 的红相明细**自相矛盾**——U9 记 10 但其中「新建的会话是根会话（meta 无血统字段）」在修复前**本来就为真**（旧实现从不 `create`，`creates` 为空 ⇒ 判据恒真），语义变更那一组列了 6 个名字却记 5 条，加总 22 与实测 21 差一条。**按重跑实测定档**为 U7 2 + U8 1 + U9 **9** + U10 1 + U11/收敛性 2 + 语义变更 **6** = **21**，计数与列表同一次编辑改准（`docs/verification-log.md` 批次 2 的「计数勘误」小节留原始读数与逐条名单）。
6. **F 跨档同步**（审计第 2、6 条 / 设计 §10 清单）：`docs/team-upgrade-design-2026-09-17.md` §9.1.3 增补**双服务 fail-closed 的挂载语义**（批次 1 要求做、当时未做）；`docs/collab-enhancements-design-2026-09-19.md` §11.9.5 ③ 的**条目本体**由旧规则（「候选由插件从 live 成员计算」）改为新规则，③ 的注解与 §11.9.4 增补第 2 条、验收表 U27 行同批对齐（同一条事实不再有两处口径）。
7. **G 客户端列表丢弃当前会话**（审计第 7 条 / owner 裁定 ③）：`visibleSessionRows` 现在**丢弃当前会话**——本面板的用途是「**其他**会话」（当前会话的复制/导出已在会话头部按钮上），把它列进来会让「暂无其他会话」这句话与实际行为不一致。副作用如实写明：官方那条「blank 行只在它是当前会话时保留」随之退化为「blank 行一律丢」。验收点：工作区里**只剩当前会话**时显示「暂无其他会话」且一行都不画。
8. **H 真机复验点 1**（审计第 10 条）：对运行中的 `127.0.0.1:3080` 重放了 §6 点名的三条请求 × 两种标记（无 token / `Host: evil.example:3080`），原始读数见 `docs/verification-log.md` 批次 4 · 客户端与文档收口一节的表。**结论：运行中的进程仍是修复前的宿主半边**（本插件路由在跨站标记下仍 200 + 5.48 MB 会话数据，而 `/` 与 `/open-in-app/apps` 同判 401/403）——批次 1 的栅栏**在树里，但需 DSH 重启才在真机生效**（本节开头的发布状态行早已如实声明）。故**真机点 1 的红相实测留证完成，绿相留待父侧在一次重启窗口里复跑同六条**。

**为什么**：A 是**回归**（闸门位置错，把不依赖该服务的那条路也拒了）；B/F 是**描述面与实现面分叉**（本仓 N3 红线）；C/D 是**功能缺口**（继任者收不到令牌 ⇒ 空转；一节声明的数据源从未实现）；E 是**计数与列表不一致**（本仓文档卫生红线）；G 是 owner 裁定 ③（列表口径）。

**怎么验证（变异验证）**：

- **修复前必红（宿主半边）**：隔离夹具 `.test-tmp/s1-red/`（**本轮测试文件** + `git show HEAD:lib/index.js` + 当前 `lib/client.js` + `README.md`，在夹具目录里跑）⇒ `node host-half.test.mjs` → **`927 (failed: 7)`**，7 条恰是本轮每一条判据，逐条读数：A 两条（`{"labels":[],"dialogs":0,"creates":0,"pending":null}` + 返回文案「本宿主没有可用的 agents.create……连确认框都不弹」= 整动词被拒）；C 三条（继任者 `followedup.length === 0`）；D 两条（`task-and-goal` 逐字为「**未知**」）。
- **修复前必红（浏览器半边）**：隔离夹具 = 当前 `client-half.test.mjs` + 当前 `lib/client.js` **只把 §4.3.2 的可见性那一行还原**（其余一字未动）⇒ **`259 (failed: 14)`**：其中 7 条是 G 的语义判据（核心读数 `{"empty":"","rows":["session-cur"]}`——修复前那一行真的被画出来了），另 7 条是**按行序号索引**的跟随断言（列表从 3 行变 2 行，索引随事实走）。
- **修复后全绿**：`node host-half.test.mjs` → **`927 (failed: 0)`**（净 +7 条断言，其中 1 条是改写旧 U10）；`node client-half.test.mjs` → **`259 (failed: 0)`**（基线 920 / 257；浏览器半边**净 +2 条**断言、另**改写 10 条**既有断言的表达式来跟上「列表 3 行变 2 行」这条事实）。
- **E 的实跑重算**：批次 2 的红相用原取法重跑（`.test-tmp/s2-red/` = `git show 8d40343:host-half.test.mjs` + `git show b48b34e:lib/index.js` + `git show 8d40343:lib/client.js` + `git show 8d40343:README.md`）⇒ `920 (failed: 21)`，并逐条点名了那 21 条 FAIL（U9 组里那条血统字段断言实测为 `PASS`）。

**如实标注（设计未逐字规定、由实现定夺的地方）**：

- **D 的「读到读数」那一支在生产里不可达**：本动词的前提就是前任**没有活动代理**，而 goals 按 agent 取读数 ⇒ `ctx.agents.get(incumbent)` 必为 `undefined`。这一支是按 §4.2 (c) ④ 的契约实现的（「读不到**才**标未知」），判据直接驱动**真函数**（与既有 U9 交接正文断言同一条纪律）。
- **投递在合成链路里的位置**：作为第 ⑧ 步排在审计留痕之后；§4.2 (c) 的编号是元素清单不是时序，`successor:"auto"` 的顺序是 prepare → 清 pending → followup，两种排法都不违反「令牌落盘之后才投递」。
- **真机复验点 1 的绿相未闭合**（需重启，本轮不重启）；**真机复验点 3**（收起态 / 标题栏收起态）仍未在真机核对，与批次 3 同口径留给父侧。

**同批同步的面**：`README.md`（§二 恢复段「选自建继任者时发生什么」、§4.3 数据源行、tests 徽章 927+259、§十 当前读数）；`docs/team-upgrade-design-2026-09-17.md` §9.1.3；`docs/collab-enhancements-design-2026-09-19.md` §11.9.4 增补第 2 条 / §11.9.5 ③ 及其注解 / U27 行；`docs/verification-log.md`（批次 2 计数勘误 + 批次 4 两小节）；本条目。
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
- **DEFECT-4（中）**：编程创建的会话**全部叫工作区名**（真机原话：「会话名称都是 `dsh-session-link-pro`」）⇒ 侧边栏里**互相无法区分**。根因：把官方模板第 ⑧ 步 `sessionTitle.rename` 判成了「不做」，理由是「命名是**用户可见的交互决定**、设计没给就不自造」。**该理由不成立**——**不设标题不等于不替用户决定**：**默认值（工作区名）本身就是一次很糟的决定**。修法：按**已有的结构化信息**派生可区分的默认标题（`<team> · <role>`；只有 team ⇒ `<team>`；否则会话 id 前缀；**不读 cwd、不造随机数**），走 `ctx.get("sessionTitle")`；服务缺席或 rename 抛错 ⇒ **一行具名 warn、不阻断创建**——与 preset/模型选择那两处的 fail-fast **口径不同且是有意的**：那两处决定会话**能不能跑**，标题只决定它**长什么样**。**② 与 ③a 两条路径同批**（注入点仍只有一处）。判据含一条**可区分性**：同一批里不同 role 的标题**两两不同**。
  **派生边界（同日补）**：上游 `dsh-session-title` 按 `maxTitleBytes: 80`（字节）**剪尾巴、不追加标记、不拒绝**，而团队名只受 `[a-z0-9-]+` 约束、**没有长度上限** ⇒ 原样交出会**把 role 段剪没**、同队两 role 撞名（实测 `distinct: 1 of 2`）⇒ **团队段先截、role 段完整**（UTF-8 安全截断 + 省略号；团队段连前缀都放不住才退成「只有 role」，**不是**工作区名、也不留空的 `<team> · `）；**未给团队名新增任何长度约束**。边界如实：role 自身 >76 字节时任何方案都装不下，此时给非空省略号前缀。
- **无人值守 `claim` 的读数歧义（真机观测到、同日修）**：真机上 `claim` 的确认框**无人应答**（外层工具桥在 ~118.5s 以 `AbortError/ABORTED` 结算），**调用方只读到「tool call aborted」**，**而变更其实已经提交**（落在设计规定的「全部 provisional 迁移」分支）。**根因**：`abort` 被当成「对话框**失败**」（`timedOut` 只由插件自己的 3 分钟计时器置位）⇒ **超时与失败在读数上完全同形、后果却不同**（已换届 vs 未换届）。**修法（只改读数，不动 attended-only 本体）**：`ROTATION_DIALOG_CAUSES`（`unavailable`/`no-answer`/`timeout`/`failed`）+ `dialogNoAnswerError(error, signal)`（把 abort/timeout 归入「**无人应答**」，`signal.aborted` 是权威半）+ `unattendedClaimReading(...)`（**唯一**渲染点，`provisionalGuidance` 复用）；超时读数**自报真实后果**（未获应答 / **这不是「调用失败」** / 已按设计以 provisional 迁移**并已落盘** / 重试或等待都不会撤销它 / **具体到期时刻** / **批准路径**＝人类在设置 UI 置 `provisional: false`）。**真正的失败路径（无确认服务 fail-closed / 令牌无效 / 域外 / 写失败）文案逐字未改**，并由断言互不混淆地钉住；`team_link_rotate` 的 claim 描述另补「超时不是失败」，使调用方**调用前**即可读到。
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
- `node host-half.test.mjs` → **874**（failed: 0）；`node client-half.test.mjs` → **146**（failed: 0）（**0.3.8 收口时点**；合计 **1020**）。基线演进：host 506 → … → 675 → 831 → 848 → 855 → 868 → **874**；client 46 → … → 138 → **146**。
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

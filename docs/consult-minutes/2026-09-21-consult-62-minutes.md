# 会诊纪要 —— consult #62（原始层，机制落盘）

- 日期：2026-09-21
- 会诊 id：62
- 模型：deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, codex-cli:gpt-6-astra, fangzhou-codingplan:kimi-k3
- 平台 job：consult-1
- 结果：2/4 交付（其中 2 条有内容 —— **交付数 ≠ 有效数**，R-43）
- requiresReport：true
- 写者：`lib/consult.mjs` 的 `settleAndDeliver`（**只写 §0 汇总与 §1 原始层**；裁定层由主代理写）

## §0 汇总

[consult #62 finished — 2 of 4 replied (2 failed)]

## §1 原始层（机制写——digest 全文，逐字）

```text
[consult #62 finished — 2 of 4 replied (2 failed)]
effective: 2 of 4 (2 failed · 0 without content)
models: deepseek-official:deepseek-v4-pro, zai-coding-cn:glm-5.3, codex-cli:gpt-6-astra, fangzhou-codingplan:kimi-k3
job: consult-1
minutes: docs/consult-minutes/2026-09-21-consult-62-minutes.md
requiresReport: true
exemption: unattended — 用户在线并明确要求开会诊产出整体优化方案；此标记仅为免去纪要阻塞，方案仍会交用户拍板

--- replies (raw, unjudged — verify with your own tools) ---

[1] codex-cli:gpt-6-astra — failed
(consultation failed: codex-cli PROCESS_ERROR: codex 进程失败（非零退出且无有效输出）)

[2] deepseek-official:deepseek-v4-pro — ok
# 评审结论：整体可实施方案

我已通读三个目标的实现、正例（open-in-app）、宿主 connection 服务、slot 词表与两套测试基建。总体判断：**Q1 必须修（真安全洞）→ Q2 两窄门各放一格、第三格不放 → Q3 无 slot 可用，短期只能把「改构建产物」升级为可复现 host-patch，上游方案另列**。三处都走本仓库「先必红 → 后全绿 → 文档同步」纪律，同一批次按依赖顺序落地。

```dsh-ui
{"title":"三问裁决摘要","gap":14,"items":[{"type":"table","columns":[{"label":"问题","span":1},{"label":"裁决","span":2},{"label":"关键落点","span":2}],"rows":[["Q1 鉴权","必须修，fail-closed","栅栏走可选服务缝、每请求实时取 connection，缺席=503 不服务；不进 inject 数组"],["Q2 恢复","(a)+(c) 做，(b) 搁置","revive 放开角色面（仍限插件自建会话）；reappoint 常驻 auto 合成候选（0 候选才出现不够，本次事故候选=1）"],["Q3 菜单","短期 host-patch，长期上游 hole","无任何槽位可用；Menu 只吃描述符不吃组件，上游开 hole 必须是「描述符贡献」契约而非渲染槽"]]},{"type":"callout","tone":"info","title":"已验证的关键事实","content":"**Q1**：requestRejection=Host/Origin 栅栏 403 → 登录 cookie 401（dsh-client-connection/lib/index.js:553-556,608-614）；正例 open-in-app 把 connection 写进 inject（lib/index.js:1213-1217）并在 handler 首句调用（:1316-1328）。**Q2**：revive 两道门在 lib/index.js:7334 与 :7351；reapCandidateRoles(:7079-7083) 排除的只是被恢复角色本身，threat-intel 实际候选=[coordinator]（长度 1，不是 0）。**Q3**：slot 词表无会话行菜单槽；sidebar.workspaces 是 kind:'single'（dsh-client-ui-sidebar contract/slots.d.ts:56-60）；workspace 包无 src（只有 lib 构建产物）；Menu 只接受 MenuEntry 描述符、无自定义条目组件（primitives Menu.d.ts:3-26,74）。"}]}
```

---

## Q1 鉴权：栅栏走可选服务缝，但语义从 fail-open 改成 fail-closed

**核心判断**：不要动 `const inject = [...]`（lib/index.js:98）——把 connection 写成模块级硬依赖会让整个插件激活都押在它身上，直接违反 §9.1.3「缺服务只丢该面子面、其余照常 + 留痕」的红线。正确姿势是把 **connection 与 webServer 走同一条可选服务缝**，区别只有一点：webServer 缺席 = 不挂路由（无门）；**connection 缺席 = 路由存在但拒绝服务**（有门但 503）。这样「无门路由」在任何时序下都不可能存在。

**改动点**

1. `registerExportRoute` 的 handler 首句加栅栏（lib/index.js:8022 之前），闭包里的 `ctx` 就是 apply 的插件根 ctx：
```js
const connection = ctx.get("connection");            // 每请求实时取，晚挂载服务不可缓存
if (typeof connection?.requestRejection !== "function") {
  res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
  res.end("export route refused: no connection fence on this host");
  return;                                            // fail-closed：无栅栏不吐数据
}
const rejection = connection.requestRejection(req);
if (rejection !== undefined) {
  res.writeHead(rejection, { "content-type": "text/plain; charset=utf-8" });
  res.end(rejection === 401 ? "unauthorized" : "forbidden");   // 与 client-connection 的 body 一致
  return;
}
```
2. 顺手加 method 白名单（对齐 open-in-app）：`if (req.method !== "GET") → 405`。
3. 激活时若 `ctx.get("connection")` 缺席：一条 warn（沿用 §9.1.3「一次窗口一条」的 `warned` 模式，见 :8070-8082 的既有写法），措辞写明「路由已挂但 503 拒服务，直到 connection 出现」——降级 + 留痕两不误；导出工具不受影响。
4. 仓库文化收尾：把「connection + req → {status}|null」抽成纯函数挂进 `__testing`（lib/index.js:8169 的导出面），host-half 直接单测它。

**判据（先红后绿）**

- **必红**：host-half.test.mjs 的 `setup()` 在 webServer stub 旁（:762）加默认 `ctx.provide("connection", { requestRejection: fixture })`，新增 `omitConnection` / `connectionRejects` fixture 开关。新测试 A：`{url, headers: {host: "evil.example:3080", origin: "http://evil.example", "sec-fetch-site": "cross-site"}}` → 期望 403 且 body 为空、`surfaceReadHook`（makeQuery 的探针）从未被调 → 当前代码返回 200 + 7.4MB 事件流，**红**。测试 B：同源无 cookie → 401。
- **修复后全绿**：现有路由测试（host-half.test.mjs:1124-1128）必须给 req 补受信头才保住 200 断言——这是本次变更的配套测试改动，记进 verification-log。
- **实测复现**：原攻击命令 → 403 零字节；浏览器同源带 cookie → 200 attachment；`omitConnection` fixture → warn 一条 + handler 503。

**风险与取舍**：fail-closed 的代价是 connection 缺席时 HTTP 下载不可用（工具导出照常）——降级的是功能而非安全，红线不破。每请求一次 `ctx.get` 开销可忽略；缓存引用会在晚挂载后永远 503。401/403 语义与 core 逐字对齐，不存在「插件比宿主更松」的差分。

---

## Q2 恢复：两道窄门各放一格，第三格不放

**逐候选裁决**（三格对应你在 reviwe 中的 (a)(b)(c)）：

| 候选 | 裁决 | 理由（一行版） |
|---|---|---|
| (a) revive 放开任意角色 | ✅ 做 | revive 是身份不变操作（不写 roster、不铸令牌），角色面放宽根本不触碰「通用 roster 编辑器」红线；reload 拆掉的是**所有**插件自建会话，不只 coordinator 的 |
| (b) revive 对人类会话开放 | ⏸ 搁置 | 技术可行（确认框与代价声明 :7363/:7370-7371 已就绪），但被「侧栏重开同一会话」**严格支配**——同人类、同 id、零所有权转移；收益只剩 headless 宿主 |
| (c) reappoint 自建继任者 | ✅ 做，但触发条件要改 | 事故里候选长度是 **1**（只有 coordinator）不是 0，所以「0 活候选才出现 auto」根本不触发；auto 必须是**常驻合成候选** |

**(a) 改动点**：删/放宽 `reviveIncumbent` 的角色门（lib/index.js:7334-7336），`:7351` 的 pluginCreated 门原样不动；同步工具 description（:7605、:7608）与 README §11.9.4 文案。**判据**：host-half 新增「插件自建 id 的 worker seated-dead → revive 成功（resume 被调、审计行写入、信任零改动）」「human id 的 worker → 仍拒并给深链指引」；现有「revive 拒绝非 coordinator」断言按新语义改写并记入 verification-log。**风险**：几乎为零——死 worker 的旧出口（retire+set-role）保留，只是多了一条不丢信任拓扑的路。

**(c) 改动点**：`reapIncumbent`（lib/index.js:7480-7484）在候选列表**常驻追加**一个合成候选「自建继任者（新会话，id 形如 team-link-`<team>`-`<role>`-`<uuid8>`）」；确认后走既有 §10.2.2 铸会话链（`createTeamSession`，apply 里 :8108）拿新 id，再 `rotation.prepare({successor: 新id})` 逐字复用（:7520 不动），token/claim/两道人类关卡零改动。注意 `reapIncumbent` 的 deps 要补传 `teamSession`（registerRecoveryTools 手里有，:7600/7653）。合成项的 label 由插件算，模型依旧不能指定继任者 id（约束③不破）。**判据**：host-half 新增「候选=0 的队 → 对话框含 auto」「候选=1（只剩 coordinator）的队 → auto 也在，勾选后 agents.create 以模板 id 被调、prepare 铸令牌、coordinator 未变成继任者」「不勾选 → 零写入」。**风险**：新会话空上下文（无历史无信任），信任靠 claim 逐项勾选迁移——这正是 rotate-auto 的既有语义，无新令牌类型；对话框文案须如实声明「空会话、上下文不迁移」。

**(b) 为什么搁置**：revive-human 的唯一真收益是 headless/无 GUI 宿主（用户无法点侧栏）。若坚持要做，形状已齐：放开 :7351 门 + 确认框加一行「生命周期转给插件」勾选 + **审计 verb 区分（如 revive-human）**——否则版本史把两种所有权语义混成一行，这违反仓库的诚实审计文化。默认不做。

**组合后的事故路径**：`team_link_recover action=reappoint team=threat-intel role=b` → 对话框含「自建继任者」→ 新会话被铸、人类打开深链 claim。活 coordinator 无需兼职两角色。

---

## Q3 侧栏菜单：无槽可用，短期 host-patch、长期上游「描述符贡献」hole

**已核死的事实**：hole 词表没有会话行菜单槽位；`sidebar.workspaces` 是 `kind:'single'`（dsh-client-ui-sidebar contract/slots.d.ts:56-60），行内 `SessionNodeItem` 整个由 WorkspaceBrowser 渲染；向未声明槽位注册在加载期直接抛错（slots README「Declaration discipline」）；workspace 包**无 src**（只有 lib 构建产物）；且 Menu 只接受 MenuEntry 描述符（id/label/icon/danger/submenu，Menu.d.ts:3-26）、**不吃自定义组件**——这决定了上游即便开 hole，也不能是普通渲染槽，必须是「条目贡献描述符」的契约。

**短期落法（本仓可做，把「改构建产物」升级为可复现操作）**

- 在 team-link 仓库放 `scripts/patch-workspace-menu.mjs` + `patches/workspace-menu.patch`：锚点是 `sessionMenuItems` 数组（lib/client.js:1113-1129）与 `onSelect`（:1186-1191）。
- patch 内容：追加两项 `{id:"copySessionLink", …}`、`{id:"exportSession", …}`；onSelect 里加 `copySessionLink` → `navigator.clipboard.writeText("dsh://session/"+encodeURIComponent(node.id))`（含非安全上下文 fallback），`exportSession` → `window.location.href = "/team-link/export?session="+encodeURIComponent(node.id)+"&format=md"`——用 location 导航而非 fetch+blob，浏览器同源带 cookie 天然过 Q1 栅栏，零 CORS 面。
- 脚本对每个锚点做**上下文行存在性校验**，锚点漂移 = 应用失败报错，而不是静默错位。

**改构建产物的长期代价（如实）**：① 该行为在 874/146 测试面之外——变异文化对此行为失效，唯一把关是 patch 脚本的锚点校验；② 任何 `pnpm install` / harness 升级静默还原，必须把「重放 patch」写进升级清单；③ 语义进入了通用包（upstream-hostile），且菜单 label 绕过 workspace 包的 i18n；④ 两行 URL 构造（dshDeepLink/exportUrl 在 team-link client.js:92-98）在 shell 包里重复一份，有漂移风险。**验证**：重跑脚本 → 重启 web shell → 刷新 3080 页面 → 菜单出现两项、复制产出 `dsh://session/<id>`、导出开始下载 `<id>.md`；再模拟 `pnpm install` 还原 → 重放脚本 → 恢复。

**替代：上游声明 list 型 hole 的完整改法**（PR 描述级，team-link 侧随后注册）

1. dsh-client-ui-workspace 源码 `contract/slots.d.ts`：`SlotMap` 增 `'sidebar.workspaces.sessionMenu': { kind:'list'; scope:'root'; owner:{ sessionId:SessionId; title:string; node:SessionNode } }`，由 WorkspaceBrowser 条目声明（hole 只有一个声明者，README 规则）。
2. SessionNodeItem 的 Menu 改为 `items: [...收集到的扩展描述符, ...内置三项]`。因为 Menu 只吃描述符，hole 条目不能渲染 ReactNode——owner props 需要携带渲染期收集器（每次渲染清空 → 渲染 hole 条目（条目渲染 null、只贡献描述符）→ 按 `order` 排序拼进 items）。这是该 hole 与既有渲染槽的本质差异，文档必须写明「list 型、条目渲染 null 只贡献描述符」；或者更诚实的选型：**不开 slot，在 slots 包加一个命令式 `registerSessionMenuEntry(owner, descriptor)` 注册面**，避免用渲染契约硬套描述符语义。
3. team-link 侧届时把 dshDeepLink/exportUrl 包成两个带插件前缀 id 的描述符注册，locale 走自带字典。
4. 版本链路：workspace 包发版 → harness 升级依赖 → team-link 升要求版本；此前 host-patch 兜底。

---

## 执行顺序与文档同步清单

```dsh-ui
{"title":"落地批次","gap":12,"items":[{"type":"steps","steps":[{"title":"批次 1 — Q1（先，安全洞）","desc":"host-half 先写必红测试（evil 头 403/零字节/未读会话）→ 实现 fail-closed 栅栏 → 全绿 + 实测复现"},{"title":"批次 2 — Q2（同一 lib/index.js）","desc":"(a) 放角色门 + (c) 常驻 auto 候选；配套改写旧断言；verification-log 记语义变更"},{"title":"批次 3 — Q3（独立 UI 层）","desc":"patch 脚本 + 锚点校验 + 3080 页面验证；上游 hole 方案作为 PR 描述存档"}]},{"type":"list","title":"文档同步（违反 = 仓库文化不达标）","items":["team-upgrade-design-2026-09-17.md：§9.1.3 增「connection 栅栏（fail-closed）」小节","collab-enhancements-design-2026-09-19.md：§11.9.4/§11.9.5 增 (a
… [reply capped at 8000 chars — the uncapped text is in the minutes' §1.1]

[3] zai-coding-cn:glm-5.3 — ok
研究完成。所有引用的行均已对照实际代码进行核实。以下是评审意见。

---

# dsh-team-link v0.3.8 三问评审：整体可实施优化方案

**事实复核（均已读档确认）**：export handler（[lib/index.js:8019](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js#L8019)–8057）确实零鉴权，`readSession` 任意 id 直出全量事件；open-in-app 正例的围栏在 [dsh-host-open-in-app/lib/index.js:1213](D:/DSH-Portable/profile/profiles/web/node_modules/@deepseek-ai/dsh-host-open-in-app/lib/index.js#L1213)（`inject=["webServer","connection","subprocess"]`）与 :1316-1323（`requestRejection` → 直写状态码）；`requestRejection` 的契约是「Host/Origin 栅栏 + 浏览器登录 cookie，返回状态码或 undefined」（[rpc-host.d.ts:28](D:/DSH-Portable/profile/profiles/web/node_modules/@deepseek-ai/dsh-client-connection/lib/types/rpc-host.d.ts#L28)–31）。Q2 的两道门（:7334 角色门、:7351 pluginCreated 门）与候选集（:7079-7083、:7481-7484）与题述一致；threat-intel roster 实读确认 b/c 均为 `session-<uuid>` 人类 id。Q3 硬编码确认在 [dsh-client-ui-workspace/lib/client.js:1113](D:/DSH-Portable/profile/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js#L1113)–1129 / :1186-1191（0.1.6-alpha.2，无 src）。**一个重要勘误**：`D:\DSH-Portable\profile\profiles\web` 不是源码 checkout（无 `packages/`、无 `apps/`，只有 node_modules + profile），所以「上游改法」意味着向 deepseek-harness 仓提 PR，本机无法重建该包。

**总体顺序**：Q1 先行（安全洞、改动小、独立成commit）→ Q2 的 (a)+(c)（行为面，一批做完文档同步）→ Q3 先提上游 PR、补丁只作为可弃的过渡层。三处都走仓库的「修复前必红 / 修复后全绿」纪律。

---

## Q1 鉴权：借平台的 `connection` 围栏，晚挂保留、挂载条件收紧为 fail-closed

### 改动点

| # | 位置 | 改什么 |
|---|---|---|
| 1 | [lib/index.js:8013](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js#L8013) `mount(target)` | 再读 `const connection = target.get?.("connection")`；新增两个 reason code：`"no-connection"`（webServer 在、connection 不在）与 `"no-rejection"`（`typeof connection.requestRejection !== "function"`）。**这两种情况一律不注册路由**（区别于现在的「能挂就挂」）。 |
| 2 | [lib/index.js:8022](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js#L8022) handler 首行 | 逐字镜像 open-in-app :1316-1323：`const rejection = connection.requestRejection(req); if (rejection !== undefined) { res.statusCode = rejection; res.end(); return; }`。顺带补 `req.method !== "GET"` → 405（与 open-in-app 同款）。 |
| 3 | [lib/index.js:8077](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js#L8077) | `ctx.inject(["webServer"], …)` 改为 `ctx.inject(["webServer", "connection"], …)`——cordis 的 inject 等全部依赖就绪才回调，天然给出「双到齐才挂」的语义。 |
| 4 | [lib/index.js:8062](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js#L8062) `describeMountFailure` + :8074 warn 文案 | 扩两个新 reason 的措辞；warn 明说「路由未挂载（fail-closed），导出工具照常」。 |
| 5 | 文档同批 | [README.md:815](D:/DSH-Portable/plugins/dsh-team-link/README.md#L815) 的降级表加 `connection` 行并改写 `webServer` 行语义；§9.1.3 注释块（:7986-7996）补一段；CHANGELOG + verification-log。 |

关键论证：**这不破红线，反而把红线写得更严**。红线是「服务缺失 → 降级 + 一行 warn + 工具照常」，不是「webServer 在就必须有路由」。降级的锚点本来就是「头部 ⬇ 按钮失效、`team_link_export` 工具可用」——把挂载条件从「有 webServer」收紧为「有 webServer **且** 有可用的信任围栏」，降级面没有扩大半格，只是从「可能无门」变成「宁可不门」。快路径 :8064-8066 的语义也自动变对：root ctx 上两服务齐才挂，否则进入 inject 等待。

### 判据（修复前必红 / 修复后全绿）

1. **变异红（主断言）**：[host-half.test.mjs:662](D:/DSH-Portable/plugins/dsh-team-link/host-half.test.mjs#L662) `setup()` 增 `connectionService` 参数（默认给可编程 `requestRejection`）。用 :1125 既有的「直调 handler」模式构造 evil 请求（headers 带 `host: evil.example:3080` / `origin: http://evil.example`），fake connection 返回 403 → 断言 `statusCode===403` 且 body 空。**修复前 handler 根本不问 connection，返回 200 → 红**。
2. **降级矩阵**：(a) webServer 有 + connection 无 → 断言 `routes.length===0` 且恰一行 warn（**修复前 routes.length===1 → 红**）；(b) 双无 → 原断言（:925 一带）不变，红线保持；(c) late 双到齐（复用 :758-762、:809-811 的 late seam）→ 挂载。
3. **回归**：`requestRejection` 返回 undefined 的合法请求 → 200 + `content-disposition`（沿用 :1125 的文件名不变式断言）。
4. **真机复验**：重放你实测的三头组合 → 与 `/open-in-app/apps` 同判（403），无 cookie → 401；同源带 cookie → 200 全量 7,487,057 字节。

### 风险与取舍

- **否决「手写 Host/Origin 检查」**：重造围栏且拿不到 cookie 鉴权与 `trustedHosts` 配置——安全只有一个小家（open-in-app 注释原话），借它。
- **否决「URL 里塞一次性 token」**：token 进 URL 会落历史/日志，且签发通道本身仍需围栏；同源 + cookie 是平台既定形态，够用。
- **否决「把 webServer/connection 写进模块级 inject 数组」**：那是把服务变成**必需**，插件加载被绑死——正是本插件 :742 契约（晚挂 + 降级）刻意回避的。open-in-app 可以那么写是因为它是核心包、与 webServer 同生共死。
- 残余风险：某些组合永远不提供 `connection` ⇒ 路由永不挂（一行 warn）。这是接受的取舍：**fail-closed 优于无门路由**，且导出能力本身无损。行为变化要在 README:815 写明。

---

## Q2 恢复：裁定 (a) 站得住、(b) 不站住、(c) 站得住且是真正补洞的那个

| 候选 | 裁定 | 一句话理由 |
|---|---|---|
| (a) revive 放开到任意角色 | **采纳（限插件自建域）** | 角色门是范围最小化选择，不是安全属性；所有权门（:7351）才是真不变式 |
| (b) revive 对人类自建会话开放 + 确认代价 | **不采纳** | 拒绝理由是**结果劣化**（ownerCtx 转插件 ⇒ 重载即拆），确认框解决「同意」不解决「劣化」 |
| (c) reappoint 0 活候选时自建继任者 | **采纳（触发条件加宽一格）** | 唯一能闭合 threat-intel 退化形的改法，且让系统收敛到「可 revive 的 id」 |

### (a) 改动点

- [lib/index.js:7334](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js#L7334)–7336：删角色门，**保留** :7351 的 `pluginCreated` 门与 :7360 的 resume 可用性检查、:7363 确认框、:7379-7408 双重复检——一条不动。
- 论证：§11.9.1「硬死锁只有一格」（[design 文档:450](D:/DSH-Portable/plugins/dsh-team-link/docs/collab-enhancements-design-2026-09-19.md#L450)）论证的是「coordinator 死必须可救」，从没论证「worker 死不许救活」；对插件自建的死亡 worker，revive（身份不变、roster 不动、信任零改动）严格优于文案里承认的替代路 `retire + set-role`（丢信任拓扑）。授权来源不变（人类点击，§11.9.5），writerGate 不动，`revive` 仍只绑**当前** current——不向「通用 roster 编辑器」移动一寸。
- **宣传面同批改**（这是 Y1 的教训，verification-log:200 明文写过）：工具描述 [lib/index.js:7605](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js#L7605)、:7608（「revive 只受理 coordinator」整段）、:7612/:7614 参数文案、诊断行 :7587、README §11.9.4、design doc §11.9.4 附录段。

判据：新夹具「插件自建的死亡 worker 会话（`team-link-<team>-<worker>-<uuid8>`）+ 活 coordinator 发起」→ 确认 → `resume` 收到该 id、审计行 `verb=revive`。**修复前被 :7334 拒 → 红**。负向锁：人类 id 的 worker 仍拒且文案含侧边栏指引（现有 Y3-sym 对称锁 :225 保持绿）。

### (b) 不采纳——但把拒绝理由说透

设计文档 :479（会诊 D7）的拒绝不是权限顾虑，是**所有权事实**：`resume` 的 ownerCtx 是插件根 ctx，对人类会话做 revive 会把它的生命周期从 UI 转给插件，「严格劣于现状」。确认框让人类**同意**一个更差的状态，并不能让状态不变差。现状拒绝文案（:7352-7358）已经给出零成本正解：侧边栏重开同 id 会话 = L1 人类版，身份/信任原样回来。**若未来要开，前置条件是宿主 API 支持 `resume({ownerCtx})`，不是本插件加一道确认。** threat-intel 案例里 b/c 的正解就是这一条——工具指路即可，人不在场时由 (c) 兜底。

### (c) 改动点

- [lib/index.js:7481](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js#L7481)–7484 的「0 候选即报错」分支改造。**触发条件建议比题述更准一格**：`candidates.length === 0 || candidates.every(c => team.roles.some(r => r.current === c.session))`——后者覆盖 threat-intel 退化形（唯一活人已坐在 coordinator 格上，改任 worker 给他 = 角色堆叠）。谓词全部从 roster 读出，模型零输入。
- 能力闸门前置（复用 rotate auto 的 :2774-2776）：无 `agents.create` → fail-closed 报告，**不弹框**。
- [lib/index.js:7245](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js#L7245) `askRecoveryCandidates` 的选项列表末位追加「自建继任者（successor=auto 语义：插件铸造 `team-link-<team>-<role>-<uuid8>` 根会话）」——候选仍由插件算、答案仍按标签回读（§11.9.5③ 的结构性性质保持）。
- 选中后：铸 id（§10.2.2 模板，与 `/team_session`、rotate auto 同源）→ [lib/index.js:7520](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js#L7520) `rotation.prepare` **逐字**跑（令牌三元组、rotationBackup、freeze 广播一样不跳）→ 审计行 `verb=reappoint, to=<minted>`。
- **交接文档**：successor=auto 的五硬节闸门（:2626）本为「无上下文继任者」设的，恢复自建的继任者同样无上下文——建议由**插件从 roster 事实自动生成**最小五硬节恢复文档（角色、死亡前任 id、信任快照指针），而不是给 recover 加 `handoff` 参数。参数面保持封闭是本仓库的硬纪律。

判据：夹具照 threat-intel roster 原样（coordinator 活、b/c 人类死）→ `reappoint role=b` 弹框含 auto 选项 → 选中 → `agents.create` 被调、`prepare.successor = team-link-threat-intel-b-<uuid8>`、黑板/镜像/版本史三处留痕。**修复前该夹具只能选 coordinator（角色堆叠）或直接报错 → 红**。无 create 夹具 → fail-closed 文案 + 零弹框。限速自动继承（`recoveryRateLimited` :7053 与换届同窗）。

风险与取舍：恢复工具从此有一个「创建」动词——有界（人类点选 + 插件铸 id + prepare 逐字 + claim 二道人类关卡原样在下游）。§11.9.5③ 的「候选=活成员」定义要改写为「活成员 ∪ 插件自建继任者（仅退化触发）」，这是本方案最大的一笔文档债；(a)+(c) 合起来的收敛性值得写进 design 附录：**从此每次恢复的终态都是插件自建 id ⇒ 未来死亡都可 revive**。

---

## Q3 侧栏菜单：两段式——短期「零逻辑接缝补丁」，长期「上游 list 型 hole」

先钉死三个事实：slots 只有 single/list/keyed/chain 四种 kind，未声明槽位注册即抛错（[slots README:28/:46](D:/DSH-Portable/profile/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-slots/README.md#L28)）；ui-workspace 只声明了 directoryFlow 子槽；本机没有该包源码，**改上游 = 给 deepseek-harness 仓提 PR**。team-link 自己的注册形态在 [lib/client.js:1392](D:/DSH-Portable/plugins/dsh-team-link/lib/client.js#L1392)–1398（`ctx.slots.register({name,id,order,locale}, Component)` + `guardedSlot`），现成件在 :92-98（链接/导出 URL）、:119-166（两个按钮）。

### 短期（本部署内）：10 行「事件接缝」补丁，逻辑零外流

- **补丁内容**（只动 [dsh-client-ui-workspace/lib/client.js:1113](D:/DSH-Portable/profile/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/cl
… [reply capped at 8000 chars — the uncapped text is in the minutes' §1.1]

[4] fangzhou-codingplan:kimi-k3 — failed
(consultation failed: consultation timed out after 20min (consultTimeoutMs))
```

### §1.1 未截断全文（**仅当有回复超 8000 字软顶时出现**；机制写）

#### [2] deepseek-official:deepseek-v4-pro（8326 字）

```text
# 评审结论：整体可实施方案

我已通读三个目标的实现、正例（open-in-app）、宿主 connection 服务、slot 词表与两套测试基建。总体判断：**Q1 必须修（真安全洞）→ Q2 两窄门各放一格、第三格不放 → Q3 无 slot 可用，短期只能把「改构建产物」升级为可复现 host-patch，上游方案另列**。三处都走本仓库「先必红 → 后全绿 → 文档同步」纪律，同一批次按依赖顺序落地。

```dsh-ui
{"title":"三问裁决摘要","gap":14,"items":[{"type":"table","columns":[{"label":"问题","span":1},{"label":"裁决","span":2},{"label":"关键落点","span":2}],"rows":[["Q1 鉴权","必须修，fail-closed","栅栏走可选服务缝、每请求实时取 connection，缺席=503 不服务；不进 inject 数组"],["Q2 恢复","(a)+(c) 做，(b) 搁置","revive 放开角色面（仍限插件自建会话）；reappoint 常驻 auto 合成候选（0 候选才出现不够，本次事故候选=1）"],["Q3 菜单","短期 host-patch，长期上游 hole","无任何槽位可用；Menu 只吃描述符不吃组件，上游开 hole 必须是「描述符贡献」契约而非渲染槽"]]},{"type":"callout","tone":"info","title":"已验证的关键事实","content":"**Q1**：requestRejection=Host/Origin 栅栏 403 → 登录 cookie 401（dsh-client-connection/lib/index.js:553-556,608-614）；正例 open-in-app 把 connection 写进 inject（lib/index.js:1213-1217）并在 handler 首句调用（:1316-1328）。**Q2**：revive 两道门在 lib/index.js:7334 与 :7351；reapCandidateRoles(:7079-7083) 排除的只是被恢复角色本身，threat-intel 实际候选=[coordinator]（长度 1，不是 0）。**Q3**：slot 词表无会话行菜单槽；sidebar.workspaces 是 kind:'single'（dsh-client-ui-sidebar contract/slots.d.ts:56-60）；workspace 包无 src（只有 lib 构建产物）；Menu 只接受 MenuEntry 描述符、无自定义条目组件（primitives Menu.d.ts:3-26,74）。"}]}
```

---

## Q1 鉴权：栅栏走可选服务缝，但语义从 fail-open 改成 fail-closed

**核心判断**：不要动 `const inject = [...]`（lib/index.js:98）——把 connection 写成模块级硬依赖会让整个插件激活都押在它身上，直接违反 §9.1.3「缺服务只丢该面子面、其余照常 + 留痕」的红线。正确姿势是把 **connection 与 webServer 走同一条可选服务缝**，区别只有一点：webServer 缺席 = 不挂路由（无门）；**connection 缺席 = 路由存在但拒绝服务**（有门但 503）。这样「无门路由」在任何时序下都不可能存在。

**改动点**

1. `registerExportRoute` 的 handler 首句加栅栏（lib/index.js:8022 之前），闭包里的 `ctx` 就是 apply 的插件根 ctx：
```js
const connection = ctx.get("connection");            // 每请求实时取，晚挂载服务不可缓存
if (typeof connection?.requestRejection !== "function") {
  res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
  res.end("export route refused: no connection fence on this host");
  return;                                            // fail-closed：无栅栏不吐数据
}
const rejection = connection.requestRejection(req);
if (rejection !== undefined) {
  res.writeHead(rejection, { "content-type": "text/plain; charset=utf-8" });
  res.end(rejection === 401 ? "unauthorized" : "forbidden");   // 与 client-connection 的 body 一致
  return;
}
```
2. 顺手加 method 白名单（对齐 open-in-app）：`if (req.method !== "GET") → 405`。
3. 激活时若 `ctx.get("connection")` 缺席：一条 warn（沿用 §9.1.3「一次窗口一条」的 `warned` 模式，见 :8070-8082 的既有写法），措辞写明「路由已挂但 503 拒服务，直到 connection 出现」——降级 + 留痕两不误；导出工具不受影响。
4. 仓库文化收尾：把「connection + req → {status}|null」抽成纯函数挂进 `__testing`（lib/index.js:8169 的导出面），host-half 直接单测它。

**判据（先红后绿）**

- **必红**：host-half.test.mjs 的 `setup()` 在 webServer stub 旁（:762）加默认 `ctx.provide("connection", { requestRejection: fixture })`，新增 `omitConnection` / `connectionRejects` fixture 开关。新测试 A：`{url, headers: {host: "evil.example:3080", origin: "http://evil.example", "sec-fetch-site": "cross-site"}}` → 期望 403 且 body 为空、`surfaceReadHook`（makeQuery 的探针）从未被调 → 当前代码返回 200 + 7.4MB 事件流，**红**。测试 B：同源无 cookie → 401。
- **修复后全绿**：现有路由测试（host-half.test.mjs:1124-1128）必须给 req 补受信头才保住 200 断言——这是本次变更的配套测试改动，记进 verification-log。
- **实测复现**：原攻击命令 → 403 零字节；浏览器同源带 cookie → 200 attachment；`omitConnection` fixture → warn 一条 + handler 503。

**风险与取舍**：fail-closed 的代价是 connection 缺席时 HTTP 下载不可用（工具导出照常）——降级的是功能而非安全，红线不破。每请求一次 `ctx.get` 开销可忽略；缓存引用会在晚挂载后永远 503。401/403 语义与 core 逐字对齐，不存在「插件比宿主更松」的差分。

---

## Q2 恢复：两道窄门各放一格，第三格不放

**逐候选裁决**（三格对应你在 reviwe 中的 (a)(b)(c)）：

| 候选 | 裁决 | 理由（一行版） |
|---|---|---|
| (a) revive 放开任意角色 | ✅ 做 | revive 是身份不变操作（不写 roster、不铸令牌），角色面放宽根本不触碰「通用 roster 编辑器」红线；reload 拆掉的是**所有**插件自建会话，不只 coordinator 的 |
| (b) revive 对人类会话开放 | ⏸ 搁置 | 技术可行（确认框与代价声明 :7363/:7370-7371 已就绪），但被「侧栏重开同一会话」**严格支配**——同人类、同 id、零所有权转移；收益只剩 headless 宿主 |
| (c) reappoint 自建继任者 | ✅ 做，但触发条件要改 | 事故里候选长度是 **1**（只有 coordinator）不是 0，所以「0 活候选才出现 auto」根本不触发；auto 必须是**常驻合成候选** |

**(a) 改动点**：删/放宽 `reviveIncumbent` 的角色门（lib/index.js:7334-7336），`:7351` 的 pluginCreated 门原样不动；同步工具 description（:7605、:7608）与 README §11.9.4 文案。**判据**：host-half 新增「插件自建 id 的 worker seated-dead → revive 成功（resume 被调、审计行写入、信任零改动）」「human id 的 worker → 仍拒并给深链指引」；现有「revive 拒绝非 coordinator」断言按新语义改写并记入 verification-log。**风险**：几乎为零——死 worker 的旧出口（retire+set-role）保留，只是多了一条不丢信任拓扑的路。

**(c) 改动点**：`reapIncumbent`（lib/index.js:7480-7484）在候选列表**常驻追加**一个合成候选「自建继任者（新会话，id 形如 team-link-`<team>`-`<role>`-`<uuid8>`）」；确认后走既有 §10.2.2 铸会话链（`createTeamSession`，apply 里 :8108）拿新 id，再 `rotation.prepare({successor: 新id})` 逐字复用（:7520 不动），token/claim/两道人类关卡零改动。注意 `reapIncumbent` 的 deps 要补传 `teamSession`（registerRecoveryTools 手里有，:7600/7653）。合成项的 label 由插件算，模型依旧不能指定继任者 id（约束③不破）。**判据**：host-half 新增「候选=0 的队 → 对话框含 auto」「候选=1（只剩 coordinator）的队 → auto 也在，勾选后 agents.create 以模板 id 被调、prepare 铸令牌、coordinator 未变成继任者」「不勾选 → 零写入」。**风险**：新会话空上下文（无历史无信任），信任靠 claim 逐项勾选迁移——这正是 rotate-auto 的既有语义，无新令牌类型；对话框文案须如实声明「空会话、上下文不迁移」。

**(b) 为什么搁置**：revive-human 的唯一真收益是 headless/无 GUI 宿主（用户无法点侧栏）。若坚持要做，形状已齐：放开 :7351 门 + 确认框加一行「生命周期转给插件」勾选 + **审计 verb 区分（如 revive-human）**——否则版本史把两种所有权语义混成一行，这违反仓库的诚实审计文化。默认不做。

**组合后的事故路径**：`team_link_recover action=reappoint team=threat-intel role=b` → 对话框含「自建继任者」→ 新会话被铸、人类打开深链 claim。活 coordinator 无需兼职两角色。

---

## Q3 侧栏菜单：无槽可用，短期 host-patch、长期上游「描述符贡献」hole

**已核死的事实**：hole 词表没有会话行菜单槽位；`sidebar.workspaces` 是 `kind:'single'`（dsh-client-ui-sidebar contract/slots.d.ts:56-60），行内 `SessionNodeItem` 整个由 WorkspaceBrowser 渲染；向未声明槽位注册在加载期直接抛错（slots README「Declaration discipline」）；workspace 包**无 src**（只有 lib 构建产物）；且 Menu 只接受 MenuEntry 描述符（id/label/icon/danger/submenu，Menu.d.ts:3-26）、**不吃自定义组件**——这决定了上游即便开 hole，也不能是普通渲染槽，必须是「条目贡献描述符」的契约。

**短期落法（本仓可做，把「改构建产物」升级为可复现操作）**

- 在 team-link 仓库放 `scripts/patch-workspace-menu.mjs` + `patches/workspace-menu.patch`：锚点是 `sessionMenuItems` 数组（lib/client.js:1113-1129）与 `onSelect`（:1186-1191）。
- patch 内容：追加两项 `{id:"copySessionLink", …}`、`{id:"exportSession", …}`；onSelect 里加 `copySessionLink` → `navigator.clipboard.writeText("dsh://session/"+encodeURIComponent(node.id))`（含非安全上下文 fallback），`exportSession` → `window.location.href = "/team-link/export?session="+encodeURIComponent(node.id)+"&format=md"`——用 location 导航而非 fetch+blob，浏览器同源带 cookie 天然过 Q1 栅栏，零 CORS 面。
- 脚本对每个锚点做**上下文行存在性校验**，锚点漂移 = 应用失败报错，而不是静默错位。

**改构建产物的长期代价（如实）**：① 该行为在 874/146 测试面之外——变异文化对此行为失效，唯一把关是 patch 脚本的锚点校验；② 任何 `pnpm install` / harness 升级静默还原，必须把「重放 patch」写进升级清单；③ 语义进入了通用包（upstream-hostile），且菜单 label 绕过 workspace 包的 i18n；④ 两行 URL 构造（dshDeepLink/exportUrl 在 team-link client.js:92-98）在 shell 包里重复一份，有漂移风险。**验证**：重跑脚本 → 重启 web shell → 刷新 3080 页面 → 菜单出现两项、复制产出 `dsh://session/<id>`、导出开始下载 `<id>.md`；再模拟 `pnpm install` 还原 → 重放脚本 → 恢复。

**替代：上游声明 list 型 hole 的完整改法**（PR 描述级，team-link 侧随后注册）

1. dsh-client-ui-workspace 源码 `contract/slots.d.ts`：`SlotMap` 增 `'sidebar.workspaces.sessionMenu': { kind:'list'; scope:'root'; owner:{ sessionId:SessionId; title:string; node:SessionNode } }`，由 WorkspaceBrowser 条目声明（hole 只有一个声明者，README 规则）。
2. SessionNodeItem 的 Menu 改为 `items: [...收集到的扩展描述符, ...内置三项]`。因为 Menu 只吃描述符，hole 条目不能渲染 ReactNode——owner props 需要携带渲染期收集器（每次渲染清空 → 渲染 hole 条目（条目渲染 null、只贡献描述符）→ 按 `order` 排序拼进 items）。这是该 hole 与既有渲染槽的本质差异，文档必须写明「list 型、条目渲染 null 只贡献描述符」；或者更诚实的选型：**不开 slot，在 slots 包加一个命令式 `registerSessionMenuEntry(owner, descriptor)` 注册面**，避免用渲染契约硬套描述符语义。
3. team-link 侧届时把 dshDeepLink/exportUrl 包成两个带插件前缀 id 的描述符注册，locale 走自带字典。
4. 版本链路：workspace 包发版 → harness 升级依赖 → team-link 升要求版本；此前 host-patch 兜底。

---

## 执行顺序与文档同步清单

```dsh-ui
{"title":"落地批次","gap":12,"items":[{"type":"steps","steps":[{"title":"批次 1 — Q1（先，安全洞）","desc":"host-half 先写必红测试（evil 头 403/零字节/未读会话）→ 实现 fail-closed 栅栏 → 全绿 + 实测复现"},{"title":"批次 2 — Q2（同一 lib/index.js）","desc":"(a) 放角色门 + (c) 常驻 auto 候选；配套改写旧断言；verification-log 记语义变更"},{"title":"批次 3 — Q3（独立 UI 层）","desc":"patch 脚本 + 锚点校验 + 3080 页面验证；上游 hole 方案作为 PR 描述存档"}]},{"type":"list","title":"文档同步（违反 = 仓库文化不达标）","items":["team-upgrade-design-2026-09-17.md：§9.1.3 增「connection 栅栏（fail-closed）」小节","collab-enhancements-design-2026-09-19.md：§11.9.4/§11.9.5 增 (a)/(c) 语义与常驻 auto 候选、revive-human 搁置理由","verification-log.md：每条变更记「修复前必红（测试名+红输出）/ 修复后全绿（计数）」证据行","README：工具 description（revive 角色面、reappoint auto 候选）与实现同步"]}]}
```

一个提醒给父 agent：Q2 的 (c) 是我对触发条件的**修正**（0 候选 → 常驻候选），这是解 threat-intel 事故的关键——按原文「0 活候选时才允许」实现会再次对同一事故失效，因为 coordinator 活着让候选集长度恒为 1。若与设计文档既有措辞冲突，请以本次裁决为准回写 §11.9.5。
```

#### [3] zai-coding-cn:glm-5.3（10696 字）

```text
研究完成。所有引用的行均已对照实际代码进行核实。以下是评审意见。

---

# dsh-team-link v0.3.8 三问评审：整体可实施优化方案

**事实复核（均已读档确认）**：export handler（[lib/index.js:8019](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js#L8019)–8057）确实零鉴权，`readSession` 任意 id 直出全量事件；open-in-app 正例的围栏在 [dsh-host-open-in-app/lib/index.js:1213](D:/DSH-Portable/profile/profiles/web/node_modules/@deepseek-ai/dsh-host-open-in-app/lib/index.js#L1213)（`inject=["webServer","connection","subprocess"]`）与 :1316-1323（`requestRejection` → 直写状态码）；`requestRejection` 的契约是「Host/Origin 栅栏 + 浏览器登录 cookie，返回状态码或 undefined」（[rpc-host.d.ts:28](D:/DSH-Portable/profile/profiles/web/node_modules/@deepseek-ai/dsh-client-connection/lib/types/rpc-host.d.ts#L28)–31）。Q2 的两道门（:7334 角色门、:7351 pluginCreated 门）与候选集（:7079-7083、:7481-7484）与题述一致；threat-intel roster 实读确认 b/c 均为 `session-<uuid>` 人类 id。Q3 硬编码确认在 [dsh-client-ui-workspace/lib/client.js:1113](D:/DSH-Portable/profile/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js#L1113)–1129 / :1186-1191（0.1.6-alpha.2，无 src）。**一个重要勘误**：`D:\DSH-Portable\profile\profiles\web` 不是源码 checkout（无 `packages/`、无 `apps/`，只有 node_modules + profile），所以「上游改法」意味着向 deepseek-harness 仓提 PR，本机无法重建该包。

**总体顺序**：Q1 先行（安全洞、改动小、独立成commit）→ Q2 的 (a)+(c)（行为面，一批做完文档同步）→ Q3 先提上游 PR、补丁只作为可弃的过渡层。三处都走仓库的「修复前必红 / 修复后全绿」纪律。

---

## Q1 鉴权：借平台的 `connection` 围栏，晚挂保留、挂载条件收紧为 fail-closed

### 改动点

| # | 位置 | 改什么 |
|---|---|---|
| 1 | [lib/index.js:8013](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js#L8013) `mount(target)` | 再读 `const connection = target.get?.("connection")`；新增两个 reason code：`"no-connection"`（webServer 在、connection 不在）与 `"no-rejection"`（`typeof connection.requestRejection !== "function"`）。**这两种情况一律不注册路由**（区别于现在的「能挂就挂」）。 |
| 2 | [lib/index.js:8022](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js#L8022) handler 首行 | 逐字镜像 open-in-app :1316-1323：`const rejection = connection.requestRejection(req); if (rejection !== undefined) { res.statusCode = rejection; res.end(); return; }`。顺带补 `req.method !== "GET"` → 405（与 open-in-app 同款）。 |
| 3 | [lib/index.js:8077](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js#L8077) | `ctx.inject(["webServer"], …)` 改为 `ctx.inject(["webServer", "connection"], …)`——cordis 的 inject 等全部依赖就绪才回调，天然给出「双到齐才挂」的语义。 |
| 4 | [lib/index.js:8062](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js#L8062) `describeMountFailure` + :8074 warn 文案 | 扩两个新 reason 的措辞；warn 明说「路由未挂载（fail-closed），导出工具照常」。 |
| 5 | 文档同批 | [README.md:815](D:/DSH-Portable/plugins/dsh-team-link/README.md#L815) 的降级表加 `connection` 行并改写 `webServer` 行语义；§9.1.3 注释块（:7986-7996）补一段；CHANGELOG + verification-log。 |

关键论证：**这不破红线，反而把红线写得更严**。红线是「服务缺失 → 降级 + 一行 warn + 工具照常」，不是「webServer 在就必须有路由」。降级的锚点本来就是「头部 ⬇ 按钮失效、`team_link_export` 工具可用」——把挂载条件从「有 webServer」收紧为「有 webServer **且** 有可用的信任围栏」，降级面没有扩大半格，只是从「可能无门」变成「宁可不门」。快路径 :8064-8066 的语义也自动变对：root ctx 上两服务齐才挂，否则进入 inject 等待。

### 判据（修复前必红 / 修复后全绿）

1. **变异红（主断言）**：[host-half.test.mjs:662](D:/DSH-Portable/plugins/dsh-team-link/host-half.test.mjs#L662) `setup()` 增 `connectionService` 参数（默认给可编程 `requestRejection`）。用 :1125 既有的「直调 handler」模式构造 evil 请求（headers 带 `host: evil.example:3080` / `origin: http://evil.example`），fake connection 返回 403 → 断言 `statusCode===403` 且 body 空。**修复前 handler 根本不问 connection，返回 200 → 红**。
2. **降级矩阵**：(a) webServer 有 + connection 无 → 断言 `routes.length===0` 且恰一行 warn（**修复前 routes.length===1 → 红**）；(b) 双无 → 原断言（:925 一带）不变，红线保持；(c) late 双到齐（复用 :758-762、:809-811 的 late seam）→ 挂载。
3. **回归**：`requestRejection` 返回 undefined 的合法请求 → 200 + `content-disposition`（沿用 :1125 的文件名不变式断言）。
4. **真机复验**：重放你实测的三头组合 → 与 `/open-in-app/apps` 同判（403），无 cookie → 401；同源带 cookie → 200 全量 7,487,057 字节。

### 风险与取舍

- **否决「手写 Host/Origin 检查」**：重造围栏且拿不到 cookie 鉴权与 `trustedHosts` 配置——安全只有一个小家（open-in-app 注释原话），借它。
- **否决「URL 里塞一次性 token」**：token 进 URL 会落历史/日志，且签发通道本身仍需围栏；同源 + cookie 是平台既定形态，够用。
- **否决「把 webServer/connection 写进模块级 inject 数组」**：那是把服务变成**必需**，插件加载被绑死——正是本插件 :742 契约（晚挂 + 降级）刻意回避的。open-in-app 可以那么写是因为它是核心包、与 webServer 同生共死。
- 残余风险：某些组合永远不提供 `connection` ⇒ 路由永不挂（一行 warn）。这是接受的取舍：**fail-closed 优于无门路由**，且导出能力本身无损。行为变化要在 README:815 写明。

---

## Q2 恢复：裁定 (a) 站得住、(b) 不站住、(c) 站得住且是真正补洞的那个

| 候选 | 裁定 | 一句话理由 |
|---|---|---|
| (a) revive 放开到任意角色 | **采纳（限插件自建域）** | 角色门是范围最小化选择，不是安全属性；所有权门（:7351）才是真不变式 |
| (b) revive 对人类自建会话开放 + 确认代价 | **不采纳** | 拒绝理由是**结果劣化**（ownerCtx 转插件 ⇒ 重载即拆），确认框解决「同意」不解决「劣化」 |
| (c) reappoint 0 活候选时自建继任者 | **采纳（触发条件加宽一格）** | 唯一能闭合 threat-intel 退化形的改法，且让系统收敛到「可 revive 的 id」 |

### (a) 改动点

- [lib/index.js:7334](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js#L7334)–7336：删角色门，**保留** :7351 的 `pluginCreated` 门与 :7360 的 resume 可用性检查、:7363 确认框、:7379-7408 双重复检——一条不动。
- 论证：§11.9.1「硬死锁只有一格」（[design 文档:450](D:/DSH-Portable/plugins/dsh-team-link/docs/collab-enhancements-design-2026-09-19.md#L450)）论证的是「coordinator 死必须可救」，从没论证「worker 死不许救活」；对插件自建的死亡 worker，revive（身份不变、roster 不动、信任零改动）严格优于文案里承认的替代路 `retire + set-role`（丢信任拓扑）。授权来源不变（人类点击，§11.9.5），writerGate 不动，`revive` 仍只绑**当前** current——不向「通用 roster 编辑器」移动一寸。
- **宣传面同批改**（这是 Y1 的教训，verification-log:200 明文写过）：工具描述 [lib/index.js:7605](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js#L7605)、:7608（「revive 只受理 coordinator」整段）、:7612/:7614 参数文案、诊断行 :7587、README §11.9.4、design doc §11.9.4 附录段。

判据：新夹具「插件自建的死亡 worker 会话（`team-link-<team>-<worker>-<uuid8>`）+ 活 coordinator 发起」→ 确认 → `resume` 收到该 id、审计行 `verb=revive`。**修复前被 :7334 拒 → 红**。负向锁：人类 id 的 worker 仍拒且文案含侧边栏指引（现有 Y3-sym 对称锁 :225 保持绿）。

### (b) 不采纳——但把拒绝理由说透

设计文档 :479（会诊 D7）的拒绝不是权限顾虑，是**所有权事实**：`resume` 的 ownerCtx 是插件根 ctx，对人类会话做 revive 会把它的生命周期从 UI 转给插件，「严格劣于现状」。确认框让人类**同意**一个更差的状态，并不能让状态不变差。现状拒绝文案（:7352-7358）已经给出零成本正解：侧边栏重开同 id 会话 = L1 人类版，身份/信任原样回来。**若未来要开，前置条件是宿主 API 支持 `resume({ownerCtx})`，不是本插件加一道确认。** threat-intel 案例里 b/c 的正解就是这一条——工具指路即可，人不在场时由 (c) 兜底。

### (c) 改动点

- [lib/index.js:7481](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js#L7481)–7484 的「0 候选即报错」分支改造。**触发条件建议比题述更准一格**：`candidates.length === 0 || candidates.every(c => team.roles.some(r => r.current === c.session))`——后者覆盖 threat-intel 退化形（唯一活人已坐在 coordinator 格上，改任 worker 给他 = 角色堆叠）。谓词全部从 roster 读出，模型零输入。
- 能力闸门前置（复用 rotate auto 的 :2774-2776）：无 `agents.create` → fail-closed 报告，**不弹框**。
- [lib/index.js:7245](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js#L7245) `askRecoveryCandidates` 的选项列表末位追加「自建继任者（successor=auto 语义：插件铸造 `team-link-<team>-<role>-<uuid8>` 根会话）」——候选仍由插件算、答案仍按标签回读（§11.9.5③ 的结构性性质保持）。
- 选中后：铸 id（§10.2.2 模板，与 `/team_session`、rotate auto 同源）→ [lib/index.js:7520](D:/DSH-Portable/plugins/dsh-team-link/lib/index.js#L7520) `rotation.prepare` **逐字**跑（令牌三元组、rotationBackup、freeze 广播一样不跳）→ 审计行 `verb=reappoint, to=<minted>`。
- **交接文档**：successor=auto 的五硬节闸门（:2626）本为「无上下文继任者」设的，恢复自建的继任者同样无上下文——建议由**插件从 roster 事实自动生成**最小五硬节恢复文档（角色、死亡前任 id、信任快照指针），而不是给 recover 加 `handoff` 参数。参数面保持封闭是本仓库的硬纪律。

判据：夹具照 threat-intel roster 原样（coordinator 活、b/c 人类死）→ `reappoint role=b` 弹框含 auto 选项 → 选中 → `agents.create` 被调、`prepare.successor = team-link-threat-intel-b-<uuid8>`、黑板/镜像/版本史三处留痕。**修复前该夹具只能选 coordinator（角色堆叠）或直接报错 → 红**。无 create 夹具 → fail-closed 文案 + 零弹框。限速自动继承（`recoveryRateLimited` :7053 与换届同窗）。

风险与取舍：恢复工具从此有一个「创建」动词——有界（人类点选 + 插件铸 id + prepare 逐字 + claim 二道人类关卡原样在下游）。§11.9.5③ 的「候选=活成员」定义要改写为「活成员 ∪ 插件自建继任者（仅退化触发）」，这是本方案最大的一笔文档债；(a)+(c) 合起来的收敛性值得写进 design 附录：**从此每次恢复的终态都是插件自建 id ⇒ 未来死亡都可 revive**。

---

## Q3 侧栏菜单：两段式——短期「零逻辑接缝补丁」，长期「上游 list 型 hole」

先钉死三个事实：slots 只有 single/list/keyed/chain 四种 kind，未声明槽位注册即抛错（[slots README:28/:46](D:/DSH-Portable/profile/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-slots/README.md#L28)）；ui-workspace 只声明了 directoryFlow 子槽；本机没有该包源码，**改上游 = 给 deepseek-harness 仓提 PR**。team-link 自己的注册形态在 [lib/client.js:1392](D:/DSH-Portable/plugins/dsh-team-link/lib/client.js#L1392)–1398（`ctx.slots.register({name,id,order,locale}, Component)` + `guardedSlot`），现成件在 :92-98（链接/导出 URL）、:119-166（两个按钮）。

### 短期（本部署内）：10 行「事件接缝」补丁，逻辑零外流

- **补丁内容**（只动 [dsh-client-ui-workspace/lib/client.js:1113](D:/DSH-Portable/profile/profiles/web/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js#L1113)–1129 与 :1186-1191 两块）：数组追加 `{id:"team-link-copy", label:"复制会话链接"}` / `{id:"team-link-export", label:"导出会话"}`；onSelect 加两个分支，各只发一个 `window.dispatchEvent(new CustomEvent("dsh-team-link:session-menu", {detail:{action, sessionId: node.id}}))`。
- **全部业务逻辑在 team-link**：lib/client.js 的既有 apply 里加一个 window 监听，action=copy → 复用 `dshDeepLink`+`fallbackCopy`；action=export → 复用 `exportUrl` 下载。补丁里没有一行插件逻辑——它的维护面就是那两个字面量数组。
- **落地形式与保险**：以 diff（patch-package 式）落仓，锁死目标文件版本 `0.1.6-alpha.2` + 内容哈希校验，升级后哈希不匹配就**响亮失败**而不是静默跳过。
- 判据：client-half.test.mjs 给监听器加纯逻辑测试（构造 CustomEvent → 断言剪贴板 fallback / anchor href）；补丁本身用「重放 :1113 区域字符串包含两个新 id」的形态锁（仓库已有 CRLF 容错形态锁的先例，verification-log:236）。

### 长期（正解）：上游声明一个 list 型 hole——完整改法

1. **deepseek-harness `packages/client/ui-workspace/src`**：SessionRow 声明子槽 `workspace.session.menu`（list kind），SlotMap 经 `declare module` augmentation。
2. **关键设计决策（要在 PR 里说清的那个分叉）**：Menu 原语消费的是**数据数组**（`items` + `onSelect(id)`），组件形 hole 与它不匹配。两条路：**(i)** 给 dsh-client-ui-primitives 的 Menu 加逐项 onSelect/渲染器——动公共原语，改动面大；**(ii)（推荐）** 该 hole 的 entry options 携带受控描述符 `{item:{id, label|localeKey, icon}, onSelect({sessionId,node,row})}`，SessionRow 读 entries 合并进 `sessionMenuItems`、onSelect 优先派发 entry 处理器。这要求 slots 的 KindOptions 为这个 hole 开一个受控字段——「声明即授权」模型要为此背书，属于需要上游设计评审的一步，正是 PR 里该论证的核心。
3. ui-workspace README 表加一行（对齐 directoryFlow 的写法），版本 alpha.3。
4. **team-link 侧**：peerDeps + `dsh.client.inject` 增 `@deepseek-ai/dsh-client-ui-workspace`；[lib/client.js:1392](D:/DSH-Portable/plugins/dsh-team-link/lib/client.js#L1392) 附近加两个 `guardedSlot` 注册（`locale:"dsh-team-link"`，label 走本插件词表——补丁方案里做不到的 i18n 这里自然解决）；client-half.test.mjs 断言注册形态；上游版本落地后**删补丁**。

### 「改构建产物」的长期代价（如实清单）

每次 `0.1.6-alpha.x` 滚动都要重做；内部标识符（`Rows_module_css_default`、`react_jsx_runtime` 等）是构建产物、无稳定性承诺，上游重构即碎；**冲突是静默的**——上游加第 4 个菜单项或改 onSelect 协议时，补丁可能仍然 apply 成功而行为已经错了；与本生态「未声明槽位抛错」的纪律相悖（那条纪律存在的意义就是防这种旁路）；部署成私有分叉，上游无法复现你遇到的 bug。**所以补丁必须定位为可弃过渡层，且始终与上游 PR 并行推进，不是替代。**

**诚实替代（要说清）**：这两个动作**已经**以头部按钮形态存在（conversation.session.header.actions 里的 🔗 与 ⬇）。菜单只增益可发现性——如果上游评审周期长，短期价值/风险比可能根本不值得动构建产物，「什么都不打、等 hole」是合法选项。

---

## 落地顺序与文档义务（一次列全）

1. **Q1**（独立、最小、安全优先）：代码 + 测试红绿 + README:815 表改写 + §9.1.3 + verification-log + CHANGELOG。
2. **Q2(a)+(c)**：一批完成（共享文档面）：design doc §11.9.4 附录（含 D7 边界为何不动）、工具描述/诊断行同批改、README §11.9.4、verification-log 变异证据。
3. **Q3**：先发上游 issue/PR（含 list-hole 的 (i)/(ii) 设计分叉论证）；补丁只在确认需要过渡时落，且带版本哈希锁。
4. 每步真机复验点：Q1 的三头 curl 组合对齐 `/open-in-app/apps`；Q2 用 threat-intel roster 原样做演练；Q3 在 `pnpm run dev:web` 环境验证菜单项与头部按钮行为一致。

**三问共同的取舍底线**：Q1 不牺牲降级红线（收紧而非放弃）、Q2 不新增模型参数、不碰 policy.writer、动词集封闭不破（(a)(c) 都只是放宽「谁/什么 id 可进入既有动词」）、Q3 不把业务逻辑放进构建产物——三处加宽全部落在「宿主观测 + 人类确认」的既有授权轴上，没有一条向「通用编辑器」移动。
```

## §2 逐问裁定（**主代理写**）

> 每条意见**恰一条处置**——采纳 / 不采纳（**必附理由**）/ 待定。所有坐标均由主代理实读复核；**未复核的坐标一律不写进方案**。

### §2.1 Q1 导出路由鉴权

| # | 出处 | 意见 | 处置 | 理由 |
|---|---|---|---|---|
| 1 | [2] | 栅栏走可选服务缝、**不写进模块级 inject**、每请求实时取 `connection`、缺席返回 503 | **采纳（并合成）** | 与 [3] 的挂载期收紧合成，见 §3 分歧 1。 |
| 2 | [2] | handler 首句用 `requestRejection`，401/403 响应体与 client-connection 逐字一致 | **采纳** | 实读 `dsh-client-connection/lib/index.js:608-614`：`res.writeHead(rejection); res.end(rejection === 401 ? "unauthorized" : "forbidden")` —— 照抄即「插件不比宿主松」。 |
| 3 | [2][3] | 补 `req.method !== "GET"` → 405 | **采纳** | 与正例 open-in-app 同款，零成本。 |
| 4 | [2] | 把「connection + req → 状态码\|null」抽成纯函数挂进 `__testing` | **采纳** | 实读 `lib/index.js:8169` `export const __testing = Object.freeze({...})` 存在，是既有测试面。 |
| 5 | [3] | `mount(target)` 新增 reason code `no-connection` / `no-rejection`，两者**一律不注册路由** | **采纳** | 与既有 reason-code 机制（`lib/index.js:8013-8018`）同形；降级面不扩大半格——「无路由 + 工具照常」本就是 :7995 写下的既有降级语义。 |
| 6 | [3] | `ctx.inject(["webServer","connection"], …)` | **采纳** | cordis 双到齐才回调，天然给出「双到齐才挂」；快路径 `:8064-8066` 语义自动变对。 |
| 7 | [3] | README 降级表加 `connection` 行 | **采纳** | 实读 `README.md:808-817` 是一张逐服务列出降级语义的表（`settings`/`webServer` 都在），缺 `connection` 行即文档债。 |
| 8 | [3] | 否决「手写 Host/Origin 检查」「URL 塞一次性 token」「写进模块级 inject 数组」 | **采纳（作为否决）** | 三条理由均复核成立：手写栅栏拿不到 cookie 鉴权与 `trustedHosts`；token 进 URL 会落历史/日志且签发通道本身仍需栅栏；写进 `inject` 把插件激活绑死在服务上，与 `lib/index.js:98` 的 inject 与 README:815 的晚挂契约直接冲突。 |

### §2.2 Q2 恢复

| # | 出处 | 意见 | 处置 | 理由 |
|---|---|---|---|---|
| 1 | [2][3] | **(a)** `revive` 放开到任意角色，**保留** `:7351` 的 pluginCreated 门 | **采纳** | 两模型独立同判。实读两门性质不同：`:7334` 角色门是**范围最小化**（§11.9.1 只论证「coordinator 死必须可救」，从未论证「worker 死不许救活」），`:7351` 所有权门才是**安全不变式**。放宽前者不写 roster、不铸令牌、不动 `writerGate`、仍只绑当前 `current`。 |
| 2 | [2] | **(b)** 搁置：被「侧栏重开同一会话」**严格支配** | **采纳** | 同一人类动作、同一 id、零所有权转移。 |
| 3 | [3] | **(b)** 不采纳，且「确认框解决『同意』不解决『劣化』」；真要开的前置是宿主 API 支持 `resume({ownerCtx})` | **采纳（并作最终裁定）** | 该表述比 [2] 更准，据此把 (b) 定为**不采纳**（而非搁置）。 |
| 4 | [2][3] | **(c)** `reappoint` 增加「自建继任者（auto）」候选，复用 rotate 的 auto 链，`:7520` 的 `rotation.prepare` 逐字不动 | **采纳** | 实读 `:2774-2776` auto 能力闸门（admission 先查 + `agents.create` 检查）与 `:7520` prepare 调用点均在位。 |
| 5 | [3] | 触发条件 `candidates.length===0 \|\| candidates.every(c => team.roles.some(r => r.current===c.session))` | **不采纳（原式）** | **该谓词恒真**：候选本就由 `team.roles` 映射而来（`:7079-7083`），每个候选的 session 必然是某个 role 的 `current` ⇒ `every(...)` 恒 `true` ⇒ 整式退化为「永远出现 auto」。按 [2] 的**常驻合成候选**采纳其意图，不采纳这行代码。 |
| 6 | [3] | 候选谓词要覆盖「唯一活人已坐在别的格上」（角色堆叠） | **待定** | 实读 `:7520` 的 `prepare` 只改目标 role 的 `current`、不动继任者原角色 ⇒ **角色堆叠是既有设计而非本事故特有**（任何复用现成成员的 reappoint 都会堆叠）。是否为恢复场景排除已就座候选是一次语义变更，须先在设计件里明确，不在本批。 |
| 7 | [3] | 交接文档由插件从 roster 事实**自动生成**最小五硬节，不给 recover 加 `handoff` 参数 | **采纳** | 与 §11.9.5① 封闭动词/封闭参数面一致；实读五硬节常量在 `:2626`。 |
| 8 | [3] | 工具描述 `:7605`/`:7608`、诊断行 `:7587`、参数文案 `:7612`/`:7614` 同批改 | **采纳** | 这是仓库自己写下的 Y1 教训（描述与实现同批同步）。 |

### §2.3 Q3 侧栏菜单

| # | 出处 | 意见 | 处置 | 理由 |
|---|---|---|---|---|
| 1 | [2][3] | 短期以 **patch** 形式改构建产物，脚本带锚点存在性校验，漂移即**响亮失败**而非静默错位 | **采纳** | 手改 node_modules 不可复现；带校验的补丁至少可重放。 |
| 2 | [3] | 补丁只做**事件接缝**：菜单项 dispatch 一个 `CustomEvent`，业务逻辑（深链 / 导出 URL / 剪贴板）留在 team-link | **采纳** | 比 [2] 把实现内联进补丁更符合本仓分层；补丁维护面缩到两个字面量，且逻辑仍在插件测试面内。 |
| 3 | [2] | 补丁内容内联实现（`clipboard` + `window.location.href`） | **部分不采纳** | 采纳其「用 `location` 导航而非 fetch+blob」的判断（同源带 cookie 天然过 Q1 栅栏、零 CORS 面）；但**实现位置**按 [3] 留在插件侧。 |
| 4 | [3] | 长期：上游声明 list 型 hole，且因 Menu 只吃描述符 ⇒ hole 必须是「受控描述符贡献」而非渲染槽 | **采纳** | 实读 `dsh-client-ui-primitives/lib/types/Menu.d.ts:3-26`：`MenuEntry = MenuItem \| MenuSeparator \| MenuLabel`、`onSelect(id)` —— 确实只吃数据不吃组件。 |
| 5 | [3] | 「什么都不打、等 hole」是**合法选项**——两个动作已以头部按钮存在，菜单只增益**可发现性** | **采纳** | 这是本方案的首要取舍项，交由用户定，见 §5 与方案正文。 |
| 6 | [2] | 上游版本链路：workspace 包发版 → harness 升依赖 → team-link 升 peerDep，此前补丁兜底 | **采纳** | 与 `package.json` 的 peerDependencies 形态一致。 |

## §3 分歧与父侧裁定（**主代理写**）

**分歧 1 —— Q1 的 fail-closed 落点。** [2]：挂载期不收紧，请求期「无栅栏 → 503」。[3]：挂载期收紧（缺 connection 即**不注册路由**）。
**裁定：分层合成，不是二选一。** 挂载期要求双服务齐（[3]：让「无门路由」在**任何时序**下都不存在），handler 首句再实时取一次栅栏并对缺席 fail-closed（[2]：覆盖 connection 挂上之后又被拆掉的窗口）。两处都 fail-closed，合起来是纵深防御；单独任一条都留一个时序缝。

**分歧 2 —— Q2(c) 的触发条件。** 见 §2.2 第 5 行：[3] 的谓词恒真，不采纳原式；按 [2] 的「常驻合成候选」采纳意图。

**分歧 3 —— Q3 的逻辑落点。** [2] 内联进补丁 vs [3] 留在插件。**裁定：[3]。** 补丁越薄越可弃，逻辑越靠插件越进测试面。

**分歧 4 —— 坐标。** [3] 的「本插件 `:742` 契约（晚挂 + 降级）」**不成立**：实读 `lib/index.js:742` 是 pendingCreates 解析里的 `role` 取值行；晚挂 + 降级契约在 `:8070-8082`（warn 与 `ctx.inject`）与 `:7986-7996`（docblock）。方案中一律使用主代理复核过的坐标。

## §4 教训（**主代理写**）

1. **「交付数 ≠ 有效数」再现**：4 模型 2 交付——`codex-cli:gpt-6-astra` PROCESS_ERROR（非零退出且无有效输出），`fangzhou-codingplan:kimi-k3` 20min 超时。⇒ 这两条路由当前不可作为门禁依赖；且**失败发生在面板层，与题面质量无关**（同一题面下 2 条给出高质量回答）。
2. **「转发坐标必须自己读过」在会诊层再次成立**：本次**转发前逐条实读**，当场抓到 [3] 的一条错坐标（`:742`）。上一轮（子代理报告）的教训同样适用于大模型输出——**模型越自信，坐标越容易被照抄**。
3. **模型给的谓词要代进代码跑一遍**：[3] 的候选谓词「看起来更精确」，实则恒真。这类表达式是最容易被整段照抄进实现的形态。
4. **两份独立回复在 6 个实质判断上收敛**（Q1 走可选服务缝不写 inject、Q2 的 (a) 采纳/(b) 不采纳/(c) 采纳、Q3 无槽可用需补丁或上游），**分歧只在落点与触发条件**（§3 四条）。收敛点可信度高，分歧点才是需要父侧裁定的地方。

## §5 不可验清单（**主代理写**）

1. **补丁应用到构建产物后的实际菜单行为**——未打补丁、未跑浏览器；[2][3] 对该行为的描述均为设计，非读数。
2. **「`pnpm install` 会还原该构建产物」**——两模型都断言，主代理**未实测**。
3. **上游是否接受「受控描述符贡献」型 hole**——无上游信息，纯提案。
4. **`ctx.get("connection")` 在本插件根 ctx、且 connection 晚挂出现时的实际解析结果**——本机 connection 始终在位，**缺席态未构造出来**。「absent → 不挂载 / 503」的判据目前只有代码推理与既有 `webServer` 同形先例支撑。
5. **threat-intel 那次 `reappoint` 的真实返回文案**——主代理只从 roster 推出候选集（[coordinator]），未看到当时的工具输出原文。
6. **Q2(a) 放宽角色门后是否与既有断言冲突**——未跑测试，属实现期必验项。

## §6 历史行

| 日期 | 变更 |
|---|---|
| 2026-09-21 | 机制落盘（§0 汇总 + §1 原始层）；裁定层待主代理补写 |
| 2026-09-21 | 主代理补写裁定层 §2–§5；结论 2/4 交付，坐标经逐条实读复核（抓到 1 处错坐标 :742） |

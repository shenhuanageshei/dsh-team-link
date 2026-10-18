# 上架合规档 —— dsh-team-link（DSH STORE 契约）

> **为什么有这份档**：DSH STORE 的**上架自动检查**（`AI-Scarlett/DSH-Store`，每 8 小时复检固定 commit）在
> [issue #1380](https://github.com/AI-Scarlett/DSH-Store/issues/1380) 里开单要上游补三样东西：
> ① **明确声明 Node / DSH 兼容范围** ② **写清依赖、权限、外部服务与失败边界** ③ **把运行文件纳入固定 Commit 与 manifest `files`**。
> 本档是 ② 的正式回答（同时登记 ① 的落点与 ③ 的现状）。
> **商家明确声明**：那是一条**契约**判定，**不是安全漏洞指控、也不代表项目质量有问题**。
>
> 行号/字节一律 as-of **2026-10-15 工作树**；对照商城口径见该 issue 的「检测结果」表。

---

## 一、兼容范围（商城判定 ①）

| 项 | 声明 | 落点 / 证据 |
| --- | --- | --- |
| **Node.js** | **`>=22`** | `package.json` 的 `engines.node`。**为什么是这个下限**：本插件**真机验证**只覆盖过宿主自带的 Node **v24.14.1**（桌面 DSH 的运行时）；我们没有在 18/20 上跑过哪怕一次，所以**不写我们没验过的更低下限**（承诺宽了就是假话）。**降下限的条件**：在 Node 20 / 22 上实跑两套件全绿，然后同批改这里与本节。 |
| **DSH（宿主）** | 见 `package.json` 的 `peerDependencies`：`@deepseek-ai/dsh-*` 的 `^0.1.0-rc.6 \|\| ^0.1.5-rc.1 \|\| ^0.2.0-rc.1`，`@deepseek-ai/cordis` `^4.0.1` | 宿主加载器在挂载插件**之前**跑兼容闸门：`peerDependencies` 里**任一条** `semver.satisfies` 不满足 ⇒ **整个 bundle 被静默丢弃**（工具凭空消失）。⇒ **每次宿主换代都要复核本表与 `peerDependencies` 的区间**（纪律见 [`AGENTS.md`](../AGENTS.md) §四） |
| 模块形态 | **ESM**（`"type": "module"`）· 入口 `lib/index.js` · 浏览器半边 `lib/client.js`（`exports` 显式列出四项） | `package.json` |

---

## 二、依赖（商城判定 ② 的前半）

| 类别 | 内容 | 说明 |
| --- | --- | --- |
| **运行时依赖（npm）** | **恰好 1 个**：`schemastery@^3.0.0` | **用途**：插件选项（`team-link` 命名空间的配置 schema）校验 —— 与宿主/`cordis` 自己用的**同一个** schema 库，不是自选的外来依赖。**许可**：MIT。**为什么不内联**：手写一个等价的 schema 校验器会引入**行为差异**（边界/强制转换），而它正是配置面的安全阀；保留 + 在此声明比内联更可审。 |
| **宿主提供的包**（不在本仓 `dependencies` 里） | `@deepseek-ai/dsh-tools` · `@deepseek-ai/dsh-session-reference` · `@deepseek-ai/cordis` 等 | 由**宿主**在运行时提供；本仓编译期不解析它们（见 [`AGENTS.md`](../AGENTS.md) §四） |
| **开发/测试依赖** | **零**：两套件是**纯 Node 脚本**（`node host-half.test.mjs` / `node client-half.test.mjs`），不需要测试框架 | ⇒ 本仓**不存在** `devDependencies`，也没有 `prepare` / 构建步骤（**无构建产物、无安装期脚本**）。`scripts.test` 只是这两条命令的封装。 |
| 固定 commit 的运行文件 | `files` 白名单：`lib` · `cordis.patch.yml` · `dsh-open.cmd` · `register-protocol.ps1` · `LICENSE` · `README.md` · `CHANGELOG.md` · `docs` | ★ **批 R 已达标**：`lib/` 共 **25** 个 `.js` —— 宿主半边 **24 档**（入口 `lib/index.js` **254,802 字节** ＋ **23** 个域档）＋ 浏览器半边 `lib/client.js`（**156,665 字节**）；**最大单档字节 = 254,802**（`lib/index.js`）**< 商城上限 262,144**；历史 **1,093,629 → 现 254,802** ⇒ 见 §六「达标状态」。★ **2026-10-18 批 Q 修复轮后读数**：入口档因 4 处描述文案更正为 **254,947 字节**（仍 < 262,144）；★ **2026-10-19 批 S 后读数**：入口档 **261,760 字节**（批量动作的入口路由 / 参数 / 描述 ＋ 批量执行面的装配缝；仍 < 262,144）；本节保留批 R 当时的读数作历史，**现行值以 §六 为准**。 |

---

## 三、权限与外部服务（商城判定 ② 的中段）

| 面 | 本插件的行为 | 证据（可 grep） |
| --- | --- | --- |
| **网络** | **零**：不发起任何 HTTP / WebSocket / DNS 请求；没有 `fetch` / `http` / `net` 的导入 | **宿主说明符**仍恰 **8 个**（按 `lib/` 宿主半边文件集**汇总**、内部相对导入 `./<域>.js` **不计入**；判据 `Rr3①` 与 `U19`-同族 + 各批零新依赖锁），逐字为 `@deepseek-ai/dsh-session-reference` / `@deepseek-ai/dsh-tools` / `schemastery` / `node:crypto` / `node:fs/promises` / `node:fs` / `node:os` / `node:path` |
| **子进程** | **零**：不 `spawn` / `exec` / `fork` | 同上（导入面即证据） |
| **文件系统（写）** | 只写**三处自家地盘**：① 状态落点 `<DSH_HOME 或 ~/.dsh>/team-link/policy.json`（**只在宿主没有 settings 服务时**）② 崩溃现场心跳 `<同目录>/forensics/<bootId>/heartbeat.json` ③ 团队黑板 `<团队 workspace>/team/<队名>/{decisions,tasks,discipline}.md` 与换届交接文档 | `AGENTS.md` §七（状态落点单一）+ 批 K 的写面负向锁（`U13`：变更路径全在 `forensics/` 之下） |
| **文件系统（读宿主）** | **不读宿主的配置、崩溃记录与其它目录**：崩溃现场那一档**连宿主崩溃日志的目录名在代码里都零出现**（负向锁） | 批 K `U13` 判据 |
| **外部服务 / 凭证** | **无**：不需要 API key、不需要账号、不连任何第三方服务 | —— |
| **能力面（宿主 API）** | 经由宿主服务：`agents`（建/复活会话）· `userQuestions`（人类确认框）· `settings`（状态落点）· `sessionQuery` / 会话投影（只读读数）· `agentPresets` / `permissionPresets`（会话组装）· `commands` | 各批设计档 §7「谁写谁读」表；**换代必复核**清单见 `AGENTS.md` §四（`acquireScope` / `context` / `getContextOrder` / `agent/pre-step` 四处已入清单） |

---

## 四、失败边界（商城判定 ② 的后段）

**总口径**：**「观测面」一律 fail-open**（绝不因为本插件让任何一次工具调用或回合失败）；**「写面与信任面」一律 fail-closed**（拿不准就不写，并把「为什么没写」如实说回来）。

| 档 | 失败朝向 | 典型出口 |
| --- | --- | --- |
| 段 / 上下文装配 · 自愈检查 | **fail-open** | 只留一行 warn，`next()` 的决定逐字不变 |
| 心跳（崩溃现场） | **fail-open** | 写不进去只留一行 warn，巡逻不抛；`statfs` 读不到时那两格**是 `null`**（不编造） |
| 看门狗巡逻 / 摘要 / 两条告警 | **fail-open** | 投递失败只留一行 warn，巡逻不崩 |
| 状态落点写（`policy.json` / settings） | **fail-closed 于覆盖** | 文件损坏 ⇒ **不覆盖**、落内存、落点行报第 5 个原因码；改名失败 ⇒ 保留原 errno 抛出 + 一行限量留痕 |
| 团队名册写（roster / 换届 / 删队 / 切档） | **fail-closed** | 写权限门 + **人类确认框**（无确认服务 / 取消 / 超时 ⇒ **零写入**）；刻意**没有**无人值守变体（不可逆动作没有这个余地） |
| 跨会话投递 | **fail-closed 于「未投递」** | 「未投递」绝不写成「已发送」（设计红线 A4） |
| 会话创建 / 复活 | **fail-closed 于组装源** | 组装不出可运行的人设/模型 ⇒ **拒绝创建/复活**（宁可不建，也不建一个跑不起来的） |

**崩溃安全**：状态写入走**唯一临时名 → `fsync` → `rename`**（批 L）；崩在中间留下的半写临时文件**永远不会被读成状态**，且**任何失败路径都会 best-effort 清掉自己的临时文件**（批 L 交付评审 🔵#1 修复：写/`sync` 抛也清）。

---

## 五、安装 / 启动 / 卸载证据（商城判定 ③）

| 场景 | 状态 | 证据 |
| --- | --- | --- |
| **一次性 Profile 的装 / 启 / 卸** | **待补**（用户 2026-10-15 已就绪重启时机） | 计划：新建一个空 profile → 从**本地路径**（`link:`）装入 → 启动 DSH 并确认工具面在场（`team_link_status` 出卡）→ 卸载 → 启动确认工具面消失且**无残留目录**；三段输出原文记进 [`docs/verification-log.md`](verification-log.md) |
| **现状（本机长期部署）** | **已验证但非「一次性 profile」形态** | 本插件自 2026-09 起在本机 desktop profile 持续运行：工具面 11 个、套件**现行 1758 + 310** 条断言（2026-10-19 批 S 分歧修复轮后实测；批 S 交付时为 1753 + 310，批 Q 交付时为 1738 + 310，批 R 收口时点为 **1727 + 310**，见 [`README.md`](../README.md) §十与 [`docs/verification-log.md`](verification-log.md)）；★ **`Rr4` 现读绿**（`fdfc832` 之后环 = `[]`）—— 旧文「唯一红项是 `Rr4`」**作废**（as-of：批 R 收口时点曾红）；批 K 的崩溃现场读数已在真机取出 |

---

## 六、达标状态（原「未达标项」；批 R 收口后逐条改准）

**商城口径**：单文件 **≤ 262,144 字节**（自动审查上限）。
**最大单档字节 = 261,720**（`lib/index.js`；**现行值 = 2026-10-19 批 S 分歧修复轮后重测**，与判据 `Rr1` 的**同一读数**；as-of 链：批 R 收口时点为 **254,802** → 批 Q 修复轮后 **254,947**（4 处描述文案更正）→ 批 S 后 **261,760**（批量动作的入口路由 / 参数 / 描述 ＋ 批量执行面的装配缝）→ 批 S 分歧修复轮后 **261,720**（新增守卫全部下沉 `lib/rotation.js`，入口档以三处注释压缩抵掉参数传递，净 −40 B）；仍 **< 262,144**，余量 **424 字节**）。

| # | 商城口径 | 现状 | 判据 / 说明 |
| --- | --- | --- | --- |
| 1 | 单文件 **≤ 262,144 字节** | **已达标**：`lib/` 共 **25** 个 `.js` —— 宿主半边 **24 档**（入口 `lib/index.js` **261,720 字节** ＋ **23** 个域档，逐档见下表）＋ 浏览器半边 `lib/client.js`（**156,665 字节**）；**历史 1,093,629 → 现 261,720**（历史值是拆分前 `lib/index.js` 的**工作树字节**：blob **1,077,286 B** ＋ **16,343** 个 CRLF；旧版本档写的 **1,092,693** 是差 **936 B** 的旧读数，批 R 按实测改准；批 Q 修复轮后为 254,947，批 S 后为 261,760，批 S 分歧修复轮后为 261,720） | 判据 `Rr1`（遍历 `lib/*.js`、逐档打印实数字节）；域档清单见设计档 §5/§6 |
| 2 | 「固定源扫描不完整」/「未观察的能力信号未知」 | 很可能是 #1 的**连带结果**（单文件过大 ⇒ 自动扫描做不完）；#1 已达标，等商城复检判定 | 本档**不猜死**：复检结论按新开单另行跟进 |
| 3 | 「运行时或可选依赖需要单独的供应链审查」 | 运行时依赖**恰 1 个** `schemastery`（已在 §二声明用途 / 许可 / 不内联的理由） | 若商城仍要求单独审查材料，按 §二扩写（固定版本 + 完整性哈希） |

**逐档字节（现行值 = 2026-10-19 批 S **分歧修复轮**后重测；`Rr1` 的同一份读数。本批三档变动：`index.js` 261,760 → **261,720**（入口只减不增）、`rotation.js` 140,582 → **143,899**、`handover.js` 66,033 → **66,531**。as-of：批 Q 修复轮后为 `index.js` 254,947 / `rotation.js` 93,422 / `handover.js` 55,761 / `roster-write.js` 55,060 / `team-registration.js` 49,631 / `policy-store.js` 37,634；批 R 收口时点为 `index.js` 254,802 / `rotation.js` 81,812 / `shared.js` 22,325 / `policy-store.js` 34,955 等，见 git 历史）**

| 档 | 字节 | 档 | 字节 |
| --- | --- | --- | --- |
| `lib/index.js`（入口） | 261,720 | `lib/rotation.js` | 143,899 |
| `lib/registration.js` | 67,282 | `lib/team-session-surface.js` | 66,464 |
| `lib/policy-store-lifecycle.js` | 65,731 | `lib/handover.js` | 66,531 |
| `lib/messaging.js` | 62,510 | `lib/team-session-creation.js` | 61,103 |
| `lib/read-surface.js` | 59,206 | `lib/recovery.js` | 59,037 |
| `lib/roster-write.js` | 55,715 | `lib/watchdog-helpers.js` | 55,028 |
| `lib/team-session-command.js` | 52,038 | `lib/watchdog.js` | 51,357 |
| `lib/team-registration.js` | 50,591 | `lib/policy-store.js` | 38,803 |
| `lib/team-tools.js` | 33,169 | `lib/forensics.js` | 32,980 |
| `lib/sections.js` | 32,034 | `lib/ledger.js` | 26,070 |
| `lib/shared.js` | 25,270 | `lib/sections-lifecycle.js` | 19,126 |
| `lib/team-ledger-tools.js` | 17,366 | `lib/block.js` | 14,609 |
| `lib/client.js`（浏览器半边） | 156,665 | — | — |

**判据终态（2026-10-18 更正：`Rr4` 已绿，旧登记作废但保留为 as-of）**

★ **现行读数：`Rr4`（模块图无环）现读绿，环 = `[]`** —— `fdfc832` 把 `ROTATION_TTL_MS` / `ROTATION_RATE_LIMIT_MS` / `ROTATION_TOKEN_LABEL` / `pairKey` / `fmtWindowRest` 从 `lib/rotation.js` 下沉到 `lib/shared.js` 之后，`lib/shared.js` 已无任何 `from "./rotation.js"` 行，`lib/rotation.js` 只剩**单向** `import … from "./shared.js"`；`host` 在批 Q 时点为 **`1738 (failed: 0)`**，批 S 新增 15 条后为 **1753**，批 S 分歧修复轮再新增 5 条后为 **1758 (`failed: 0`)**（两次实测均已落 [`docs/verification-log.md`](verification-log.md) 的「批 S（整队换届）红相与绿相」节与其后的「批 S 分歧审计修复轮」节；[README](../README.md) §十 为同一读数）。

**as-of（批 R 收口时点，曾经为真，勿再当现状引用）**：当时 `lib/shared.js` 与 `lib/rotation.js` **互导**、静态导入图里有一个**真实的 2 环**（自 `R-5` 起就在），收口单写域不含 `lib/**` ⇒ 判据按设计原口径保持严格、当时为红；修法即上面的下沉，已由 `fdfc832` 完成。**在这一处修掉之前，本档不宣称「模块图无环」。**

---

## 七、本档的维护纪律

- 本档**随每次「上架相关」变动同批更新**（`files` / `engines` / 依赖 / 权限面 / 失败边界）。
- 商城**每 8 小时**自动复检固定 commit ⇒ 修完推送即生效，**不需要**人工回复确认。
- 本档进 [`README.md`](../README.md) 的「设计文档索引」。

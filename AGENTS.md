# AGENTS.md — 本仓的工作规则（给在本仓工作的 AI 代理）

> **给 AI 代理的操作规则**，不是项目介绍：README 面向用户（能力 / 用法 / 装法 / 变更史），过程纪律与内部裁定放这里与 `docs/`。
> 已入库（同日）：别的 agent 与会话都能读到，也随仓库一起有远端备份。

## 一、三条验证纪律（2026-09-27 立；由两批实测事故逼出来）

1. **每条「有断言」的声称，必须附可 grep 到的断言名；每条读数必须附命令与原文。**
   起因：A 批交付声称「三态都有断言」，而 grep 无法计算 host-half.test.mjs 命中 0 —— 声称比实测多走了一步；
   而恒真或不存在的断言永远是绿的，测试自己看不见。
2. **声称要带范围，复核要区分「活声称」与「更正注记」。**
   起因（双向）：一边写「本档零命中」实为「能力矩阵那一行零命中」；另一边复核放宽范围时差点把更正注记当成没改。
3. **「0 命中」这类结论，必须用真能区分的检查得出。**
   起因：用 Select-String -SimpleMatch 配竖线分隔的模式去查残留 = 搜一个含竖线的字面量，报出假的「0 残留」；
   换成程序化逐行扫描后立刻抓出两处真残留。

## 二、文档分层（别把对内的账写进对外的门面）

- **README.md = 给用户看的项目介绍**：能力、怎么用、怎么装、变更史。我们自己的过程纪律、事故复盘、内部裁定一律不写进去。
- **内部过程 → 工作文档**：`docs/verification-log.md`（证据账本，只追加）、各批 `docs/*-design-*.md`（设计与裁定）、本文件（规则）。
- 视觉产物（海报/图）改动后要**自己**渲染回读；调视觉工具只用于逐字 OCR 与精确坐标，且工具读数必须与事实源对账，源里没有的内容一律当编造丢弃。

## 三、怎么跑测试（本仓）

    node host-half.test.mjs      # 宿主套件
    node client-half.test.mjs    # 客户端套件

不要用 `node --test`（沙箱下 spawn EPERM）。修复必须给「修复前必红 / 修复后全绿」两次实测读数。

## 四、部署（改完代码怎么让它生效）

**接线 = `link:`（目录链接直指本仓目录）**：desktop profile 的 `package.json` 写
`"dsh-team-link": "link:D:/workspace/dsh-plugins/dsh-team-link"`，且 `<profile>/node_modules/dsh-team-link`
是指向本仓的目录链接（本机实测为符号链接 `SymbolicLink`：`fsutil reparsepoint query` → reparse tag
`0xA000000C`；旧措辞的 `junction` 即指这条链接）⇒ **改完代码重启即生效**，没有拷贝步骤。

**不要再退回 `file:`**：那是 pnpm 硬拷贝，DSH 加载的是 `.pnpm` 里那份拷贝，「改代码 → 重启」**看着正常但跑旧版**
（本项目真机踩过：连重启两次没生效，靠 sha256 比对才揪出来）。历史脚本 `deploy-desktop.ps1` 已随该接线退役删除。

宿主包（`@deepseek-ai/dsh-tools` / `dsh-session-reference`）由宿主提供，不需要在本仓 node_modules 里解析。

**宿主换代必复核 peer 区间（2026-09-29 立）**：DSH **0.2.0-rc.1** 起，加载器在挂载任何插件**之前**先跑一道兼容性闸门
（`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility()`；桌面宿主由 `dsh-desktop-host/lib/index.js` 的
`loadProfileDirectory()` 逐 bundle 调用）：对 `peerDependencies` 里**每一个** `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`
条目做 `semver.satisfies(运行时版本, 区间, { includePrerelease: true })`，**任一条不满足就把整个 bundle 静默丢弃**
—— 只往宿主 stderr 打一行（`reportSkippedBundles()`），**GUI 零提示**，症状是「插件的工具凭空消失」。
运行时版本取 `@deepseek-ai/dsh-app-boot/package.json` 的 `version`（**不是**桌面壳自己的版本号）。
⇒ **宿主小版本换代（0.1 → 0.2 → …）之后必须复核 `package.json` 的 peer 区间并补上新分支**，否则升级即静默下线。
判据与读数见 [`docs/verification-log.md`](docs/verification-log.md) 的「2026-09-29 DSH 0.2.0-rc.1 兼容性闸门」一节；
用户面的支持矩阵见 [`README.md`](README.md) 的「宿主版本支持」一节。

**宿主换代还必复核运行时 API 面（2026-09-29 同日补立）**：peer 区间过闸只证明「装得上」，**不证明「用得了」**——
同一次 0.2.0-rc.1 换代还把 `agentPresets` 的 preset pin 方法从 `standingKeyFor` 改名成了 `acquireScope`（对宿主
`app.asar` 文本检索 `standingKeyFor` 零命中），闸门全绿、工具全在，`/team_session` 却在创建第一个 worker 时以
`agentPresets.standingKeyFor is not a function` 失败（真机两次，团队零落地）。⇒ 换代复核必须**同时**静态核对
本仓实际调用的宿主服务方法名（创建路径的模板时序尤其如此），且**测试桩不得只镜像自家实现的调用面**——桩只提供
插件正在调的方法，就把「宿主已改名」这层断层永久挡在套件外面（本次即如此）。判据与读数见
[`docs/verification-log.md`](docs/verification-log.md) 的「2026-09-29 DSH 0.2.0-rc.1 preset pin 换代」一节。

## 五、网络与推送

- GitHub 直连常报 Recv failure: Connection was reset；本机代理可用时按命令临时指定（**不改全局配置**）：
  `git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push origin main`
- 部署不依赖 GitHub（走本地路径），推送失败不阻塞交付。

## 六、写文件的纪律（Windows 编码坑，2026-09-27 立）

- **绝不用 Windows PowerShell 5.1 的 `Set-Content` / `Out-File -Encoding utf8` 写配置或源码** —— 它写出来的是**带 BOM** 的 UTF-8（`EF BB BF`）。BOM 会污染 JSON / YAML / 脚本 / git 规则：JSON.parse 可能失败、PowerShell 自己解析脚本报错、git exclude 首行失效。
- **正确做法**：Node `fs.writeFileSync(p, text, "utf8")`，或 **pwsh 7 的 `-Encoding utf8NoBOM`**（本机未装 pwsh 7 ⇒ 走 Node）。改**仓库内**文件优先用 write / edit 编辑工具，不要用 shell 拼字符串重写整档。
- **事故（2026-09-27）**：用 `Set-Content -Encoding utf8` 写了 desktop profile 的 `package.json` ⇒ 带 BOM ⇒ 被另一会话发现修复（`link:` 声明本身正确，原样保留）；同日 `.git/info/exclude` 也被这样写进 BOM。
- **收尾动作**：任何配置文件写完后**回读前 3 字节**确认不是 `EF BB BF`；写 `*.json` 的另要求 `JSON.parse` 通过。

## 七、状态的落点（settings ↔ 插件自己的文件）

- **一个时刻只写一处**：`settings`（命名空间 `team-link`）在场时状态**只在 settings 里**，插件一个字节都不碰文件；
  `settings` 不在场时，同一份状态原子写到 `<DSH_HOME 或 ~/.dsh>/team-link/policy.json`。**不要改成双写** —— 设计档
  [`docs/policy-persistence-design-2026-09-27.md`](docs/policy-persistence-design-2026-09-27.md) §7 已把双写列为明确不做。
- **落点可核是红线**：`team_link_roster action=get` 与 `team_link_status` 的**首行**必须继续给出三态之一
  （`存储：设置服务（team-link 命名空间）` / `存储：文件 <绝对路径>` / `⚠ 存储：仅进程内存（重启即失）—— 原因：…`）。
  改读面时**先确认首行还在**：它是「状态此刻存在哪」唯一的用户可见出口。
- **损坏档 = 插件不覆盖、落内存、如实报因（代码评审修复轮 🟡#1）**：`policy.json` 读不出 / 非法 JSON / 没有 `policy`
  对象时，插件**一律不覆盖**那份文件（每一次写都直接在留痕里说「未落盘、该文件未被覆盖」），状态落进程内存，
  落点行报**第 5 个原因码** `文件损坏（不覆盖；请人工处理）`。**人工处置是唯一出口**：**修好或移走该文件**，
  然后**重启进程**（每个 store 只读一次文件，改好了不重启不会自动生效）。不要试图「让插件自己恢复」——
  它没有那份信息，也猜不出你想保留什么。
- **settings 之后再挂上**：文件里的内容按设计档 §3.3 折叠并入（服务非默认 ⇒ 服务胜，文件那一份归档为
  `policy.superseded-<ts>.json` 并留痕），**并立刻把合并结果写回文件、盖 `foldedAt`**。回写挂在 attach 后置链的**末尾**
  （旧命名空间迁移之后）—— 写早了，文件会缺迁移进来的那一份信任数据。
- **settings 在 activation 就已在场**（分歧审计修复轮 🟡#5）：落点规则**完全同上**，只是折叠触发得更早 ——
  命名空间**还是默认**时，文件里那一份照样并入（并入**前**原样归档成 `policy.superseded-<ts>.json`）；
  命名空间**非默认**时一律设置胜，文件那一份**连读都不读**。改这条时注意：晚挂路径（服务后才挂）的折叠行为**保持不动**。
- **迁移前置（同一轮增补）**：手工导入之前先确认命名空间此刻是空的 —— 否则按上面那条「设置胜」，导入的文件会安静地躺在磁盘上不生效。

### 一次性数据迁移（手工，代码**不读**宿主配置）

代码里永远不要去读 `<profile>/cordis.patch.yml`。迁移是一次性手工动作，由父侧/实做者执行：

1. 读出宿主配置里 `team-link.config.teams` 的内容（本仓不代劳，见上）；
2. 写成 `<DSH_HOME 或 ~/.dsh>/team-link/policy.json`，形状 `{ "schema": 1, "savedAt": "<ISO>", "foldedAt": null, "policy": { …与 settings 命名空间同键集… } }`；
3. **可核（别跳过）**：在该会话里跑 `team_link_roster action=get` —— 期望**首行**是 `存储：文件 <绝对路径>`，且名册里**看得见**迁移过来的团队（如 `threat-intel`）。
   这两步读数各抄一条进 `docs/verification-log.md`（迁移前 / 迁移后）。
4. 导入本身**不产生任何写**（`savedAt` 应保持你写进去的那一个）；此后由插件按上面的折叠规则接手。

> 夹具里已有这条路径的**可复现等价物**（`U9 迁移可核:` 三条断言）：`setup({ policySeed: policyDoc({ teams: [teamRow({ name: "threat-intel" })] }) })`
> 之后断言「团队看得见」＋「首行 = `存储：文件 <绝对路径>`」＋「磁盘上仍是你放进去的那一份」。改迁移逻辑时先改这条。

## 八、两条 2026-09-27 事故/后果备忘

- **DSH 重启会打断在飞的 `eng_coder` 后台作业**，而它的**半成品会留在工作区**（本轮 `eng-dsh-7` 就被重启打断在「判据已写、实现未做」的红状态）。
  ⇒ **重启前先确认没有在跑的作业**；一旦被打断，按平台规则**不要自动重派**（评估工作区 → 交用户裁决）。另外：**动手前先给未提交的工作上保险**
  （`git stash create` + `git update-ref refs/wip/<名字>` 不碰工作树 ✓）。
- **本部署的状态事实源是 `policy.json`，不是设置 UI 的 `teams` 键**：宿主没有可用的 `settings.register()`（落点行原因码 `no-register`），
  插件的状态落在 `<DSH_HOME>/team-link/policy.json`。**改团队状态请用工具**（`team_link_roster` 等）；
  **在设置 UI 里改 `teams` 键不会生效**（插件不读宿主配置）。roster 的恢复梯子里那句「设置 UI 直接改 teams 键」在本部署**不可用**。

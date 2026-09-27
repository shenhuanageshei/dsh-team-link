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

**接线 = `link:`（junction 直指本仓目录）**：desktop profile 的 `package.json` 写
`"dsh-team-link": "link:D:/DSH-Portable/plugins/dsh-team-link"`，且 `<profile>/node_modules/dsh-team-link`
是指向本仓的 junction ⇒ **改完代码重启即生效**，没有拷贝步骤。

**不要再退回 `file:`**：那是 pnpm 硬拷贝，DSH 加载的是 `.pnpm` 里那份拷贝，「改代码 → 重启」**看着正常但跑旧版**
（本项目真机踩过：连重启两次没生效，靠 sha256 比对才揪出来）。历史脚本 `deploy-desktop.ps1` 已随该接线退役删除。

宿主包（`@deepseek-ai/dsh-tools` / `dsh-session-reference`）由宿主提供，不需要在本仓 node_modules 里解析。

## 五、网络与推送

- GitHub 直连常报 Recv failure: Connection was reset；本机代理可用时按命令临时指定（**不改全局配置**）：
  `git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push origin main`
- 部署不依赖 GitHub（走本地路径），推送失败不阻塞交付。

## 六、写文件的纪律（Windows 编码坑，2026-09-27 立）

- **绝不用 Windows PowerShell 5.1 的 `Set-Content` / `Out-File -Encoding utf8` 写配置或源码** —— 它写出来的是**带 BOM** 的 UTF-8（`EF BB BF`）。BOM 会污染 JSON / YAML / 脚本 / git 规则：JSON.parse 可能失败、PowerShell 自己解析脚本报错、git exclude 首行失效。
- **正确做法**：Node `fs.writeFileSync(p, text, "utf8")`，或 **pwsh 7 的 `-Encoding utf8NoBOM`**（本机未装 pwsh 7 ⇒ 走 Node）。改**仓库内**文件优先用 write / edit 编辑工具，不要用 shell 拼字符串重写整档。
- **事故（2026-09-27）**：用 `Set-Content -Encoding utf8` 写了 desktop profile 的 `package.json` ⇒ 带 BOM ⇒ 被另一会话发现修复（`link:` 声明本身正确，原样保留）；同日 `.git/info/exclude` 也被这样写进 BOM。
- **收尾动作**：任何配置文件写完后**回读前 3 字节**确认不是 `EF BB BF`；写 `*.json` 的另要求 `JSON.parse` 通过。

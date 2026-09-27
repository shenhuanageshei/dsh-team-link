# AGENTS.md — 本仓的工作规则（**本地文件，不入库、不推送**）

> 给在本仓工作的 AI 代理看的操作规则。**它不是项目文档**：README 是给用户的项目介绍，
> 本文件是我们自己的过程纪律；`.gitignore` 已忽略它，只存在于本机。

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

坑：desktop profile 用 pnpm file: 依赖装本插件，pnpm 把整包**拷贝**到
`<profile>/node_modules/.pnpm/dsh-team-link@file+.../node_modules/dsh-team-link`，**DSH 加载的是那份拷贝**
—— 所以「改代码 → 重启」不生效，必须刷新拷贝后再重启。

    powershell -ExecutionPolicy Bypass -File deploy-desktop.ps1 -DryRun   # 先看
    powershell -ExecutionPolicy Bypass -File deploy-desktop.ps1           # 克隆 fast-forward + 刷拷贝 + 校验 sha256

脚本正文是纯 ASCII：Windows PowerShell 5.1 会把无 BOM 的 UTF-8 当 GBK 读，中文会乱码甚至语法报错。

## 五、网络与推送

- GitHub 直连常报 Recv failure: Connection was reset；本机代理可用时按命令临时指定（**不改全局配置**）：
  `git -c http.proxy=http://127.0.0.1:7897 -c https.proxy=http://127.0.0.1:7897 push origin main`
- 部署不依赖 GitHub（走本地路径），推送失败不阻塞交付。

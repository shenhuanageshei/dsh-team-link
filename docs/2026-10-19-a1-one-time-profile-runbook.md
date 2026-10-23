# A-1 执行手册 · 一次性 Profile 的装 / 启 / 卸证据（FR-R4）

> 目的：给商城审方提供**可复核**的三段证据 —— 在**一次性（throwaway）profile** 里从本地路径装入、启动 DSH 确认工具面在场、卸载后确认消失且无残留。
> 现状：**未执行**（需要一次真实的 DSH 启动 ⇒ 重启/新实例时机由用户决定；全局记忆 §三）。本手册把可确定的部分先定死，把「怎么起一个一次性 profile」列为**实施首步待解**。

## 一、已知事实（本机实测，2026-10-19）

| 项 | 读数 |
| --- | --- |
| 长期部署 profile | `C:\Users\huangchaowen\.dsh\profiles\desktop`（存在；`package.json` 私有 profile，dependencies 里 `@dsh-external/dsh-thincoder-suite` 等） |
| 本插件接线 | `desktop/node_modules/dsh-team-link` = **SymbolicLink** → `D:\workspace\dsh-plugins\dsh-team-link` |
| 声明方式 | profile `package.json` 的 `dependencies` 写 `"dsh-team-link": "link:D:/workspace/dsh-plugins/dsh-team-link"`（**不是** `file:` —— 那会硬拷贝、跑旧版） |
| 宿主闸门 | DSH 0.2.0-rc.1 起，加载器先跑 `evaluatePluginCompatibility()`：**任一** peer 条目不满足 ⇒ 整个 bundle **静默丢弃**（GUI 零提示，症状 = 工具凭空消失）⇒ 一次性 profile 的宿主版本必须落在本仓 peer 区间内（见 `package.json`） |

## 二、执行步骤（时机由用户点头后一次跑完）

1. **建一次性 profile**：`<新目录>`（建议 `%TEMP%\dsh-a1-profile`，**不碰** `~/.dsh/profiles/desktop`），写一个最小 `package.json`：`{ "name": "dsh-profile-a1", "private": true, "dependencies": { "dsh-team-link": "link:D:/workspace/dsh-plugins/dsh-team-link" } }`；装出 `node_modules/dsh-team-link` 链接。
2. **启动**：用该 profile 起一次 DSH（**实施首步待解**：`dsh` CLI 的 profile 选择方式 —— 参数名/环境变量；本轮已确认 `C:\Users\huangchaowen\.bun\bin\dsh.exe` 是 bun shim、在仓目录下直接调用报 `Cannot find module …/dsh/lib/bin.js`，需先定位可用的启动入口）。
3. **在场证据**：在一次性 profile 的会话里调 `team_link_status` —— 期望**首行**给存储三态之一、团队卡正常出；工具面 11 个可见。把**命令与原文**抄进 `docs/verification-log.md`。
4. **卸载**：删 `dependencies` 里那一行并移除 `node_modules/dsh-team-link` 链接（对链接路径单独删，**不要** `rm -rf` 父目录 —— 见 `AGENTS.md` §八 的 junction 事故）。
5. **消失证据**：重启同一个一次性 profile ⇒ `team_link_status` **不在**工具面；profile 目录下**无残留** `dsh-team-link`（`Test-Path` 为 False；任何 `team-link` 状态目录也不该被创建）。
6. **落账**：三段输出原文 ＋ 命令 ＋ 退出码写进 `docs/verification-log.md` 的「一次性 Profile」一节；随后删除一次性 profile 目录。

## 三、风险与回退

- **只读一方向**：全程不写 `~/.dsh/profiles/desktop`、不改全局配置；一次性 profile 放 `%TEMP%`，失败即删。
- **启动会打断在跑作业吗**：若走「新实例 + 独立 profile」，不打断当前会话；若必须重启现有 DSH，则按 `AGENTS.md` §八 先清点在飞作业再报用户。
- **闸门排查**：若工具面缺席，先核对宿主运行时版本（`@deepseek-ai/dsh-app-boot/package.json`）是否满足本仓 `peerDependencies` 的任一区间，再看宿主 stderr 的 `reportSkippedBundles()`。

## 四、需要用户决定

1. **时机**：一次真实的 DSH 启动（新实例或重启），约 1–2 分钟；若重启会打断在飞作业，我会先报清单。
2. 若允许，我按上面 1–6 一次跑完并把三段原文落进 verification-log。

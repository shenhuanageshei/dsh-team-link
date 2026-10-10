# 批 D 真机验收现场（注册生命周期与自动提示）

> 本目录是**批 D**（设计档 `docs/2026-10-10-registration-lifecycle-design.md`）的真机验收现场。
> 代码、判据与文档已全部入库（commit `912eb10`）；**只剩设计档 §8 的 U9 一项真机读数未取**，原因见下。

## 为什么还没取到（一句话）

U9 要验的是「**重启之后不跑任何命令**，团队会话自己就带上角色文本与资源行」——它**必须等一次 DSH 重启**。
重启按全局 `~/.dsh/AGENTS.md` §三 由**用户**决定时机（重启会打断所有在跑作业与会话）：
2026-10-11 01:28 实测有 **12+ 个会话正在运行**（`threat-intel` / `bounded-agent-core` / `mal-analyze-cli`
三个工作区，其中 8 个是当晚刚建的 worker），因此**没有自作主张重启**。

## 重启之后怎么跑（一条命令）

```powershell
node .investigations/registration-lifecycle-2026-10-11/scripts/verify-D.mjs `
  "$env:USERPROFILE\.dsh\sessions\--D-workspace-mal-analyze-cli--\<会话名>\session.v4.jsonl.zstd" `
  "<本次重启时刻，ISO UTC，如 2026-10-11T02:00:00Z>"
```

**跑之前别做两件事**：① 不要跑任何 `team_link_roster`（尤其 `upsert-team`）；② 不要跑 `team_link_watch clear`。
前者会让读数**空转**（那是批 D 之前的旧通路，脚本 ③ 会把它抓出来并拒判），后者是 FR-2 自己要防的动作。

脚本会自己给出 `✅ PASS` / `⚠ 无法判` / `❌ FAIL`，并把③（窗口内有没有名册写入）与逐字读数一并列出。
**它宁可说「无法判」也不会给假 PASS** —— 这是它被重写过三次才定下来的性质（见下）。

## 这个脚本踩过的三个坑（都写进代码注释了）

| # | 坑 | 后果 | 修法 |
| --- | --- | --- | --- |
| 1 | 快照文本在 `data.content`，我写成了 `data.message.content` | ② 恒报 0 条 | 分清 `user/message` 与 `system/message` 两条字段路径 |
| 2 | ③ 只扫**本会话**日志 | **会假 PASS** —— 名册写入发生在**协调者**会话里，被注册者自己的日志里看不见 | 改成扫同工作区全部候选会话 |
| 3 | 扫同工作区时按 mtime 取最新 12 个 | 把**更早**发生名册写入的会话挤掉（协调者那条就被漏了） | 改用 `decodeSince`：帧边界**不解压**就能走，只解压尾部窗口内的帧 ⇒ 全扫且快（2585 帧只解 12 帧） |

> 另：`解码` 必须逐帧走帧头 —— Node 自带的 `zstdDecompressSync` 只出**第一帧**，直接解会丢掉 99% 的事件。

## 另一半（看门狗）的两条工具读数

脚本最后会提醒，另跑：

1. `team_link_watch action=list` —— 该队的 auto 注册应当在列
2. 在现任协调者会话里跑一次 `team_link_watch action=clear`，再跑一次 `list` —— **auto 注册仍应在列**（FR-2）

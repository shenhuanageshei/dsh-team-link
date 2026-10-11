# 框定 token 取证现场（批 E / 批 F 的立案证据）

> 2026-10-11 立项。用户报告：`dsh://session/team-link-bac-1009-coordinator-40301798`「每次用发团队消息时都有几率失败」。
> 本目录是父侧的取证现场；结论已写进 `docs/2026-10-11-token-sanitize-{requirements,design}.md`（批 E）
> 与 `docs/2026-10-11-append-longtext-requirements.md`（批 F）。

## ★ 本目录的两条纪律（都是 2026-10-11 用自伤换来的）

1. **原串绝不逐字出现** —— 那个框定 token 是**特殊 token**，逐字写进源码/文档/脚本/工具参数，
   本身就会提高「写这一动作」被判 `MALFORMED_RESPONSE` 的概率。**构造它必须用码点**（`String.fromCharCode(0xFF5C)`）。
   父侧 2026-10-11 因此**自伤两次**（两次都是刚把原串写进脚本之后的下一个回合）。
2. **体检工具的输出也必须遮蔽** —— 把原串"打出来给人看"等于自己把它喂进上下文。
   `scrub-sources.mjs` 打印时统一替换成 `[BARS]`。

**当前状态**：全仓（`lib/` · `host-half.test.mjs` · `docs/` · 本目录）**0 处**逐字写出（用码点拼的匹配式独立复核过）。

## 一句话证据

跨 4 个工作区 **11 个会话 / 29 次** `MALFORMED_RESPONSE`；其中 **15 次（52%）** 发生在 `team_link_team_append`，
**15/15 都带那个 token**；JSON 断点固定在 `position 24`（第一个属性边界）；
**11/11 个失败会话的上下文里都含该 token**（69 条已入库助手消息）⇒ **会自传播**（实测连死 4 个回合）。

## 脚本（各有分工）

| 脚本 | 干什么 | 用法 |
| --- | --- | --- |
| `tally-malformed.mjs` | 跨会话统计失败次数，并**按失败时正在调的工具**分档 | `node tally-malformed.mjs <sessions 根> "<工作区过滤正则>"` |
| `token-variants.mjs` | 枚举 token 的**形态**（决定消毒规则匹配什么）—— 用码点统计两竖线的包夹词 | 同上 |
| `dump-failures.mjs` | 对每次失败做**字符级** `JSON.parse` 诊断：报出错位置与前后文 | 同上，第三个参数可只看某工具 |
| `scrub-sources.mjs` | 把工作产物里**写死**的原串改写成码点构造（默认体检、`--write` 才落盘） | `node scrub-sources.mjs <目录...> [--write]` |

## 复现口径

- 会话日志是**多帧 zstd**：Node 自带的 `zstdDecompressSync` 只出**第一帧**，必须逐帧走帧头（各脚本里都有那段）。
- 失败事件在日志里的形状：`turn/end` 且 `data.reason.error.code === "MALFORMED_RESPONSE"`；
  它前面一条 `assistant/attempt` 带**原始流**（`data.stream`），工具名与参数都在里面 —— 这是能定位到字符级的原因。

## 待办

- **批 E**（消毒面）：设计评审 **PASS**（2026-10-11；9 条意见已逐条折入 —— 其中 🟡#1 修正了正则把前缀写成必需、🟡#3 补入了 deep-link 快照这条出口，即 **FR-7**）。**实施中**，按设计档 §5 的 FR-1…FR-7。
- **批 F**（长文本压力）：用户 **2026-10-11 已拍板「先做甲」**（上限 **500 → 2000**）；设计档已出
  `docs/2026-10-11-append-longtext-design.md`。**尚未开工**，等设计评审。

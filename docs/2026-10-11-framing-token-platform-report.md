# 观测报告（给 DSH / 适配器侧）· 框定 token 漏进工具参数会让整个回合不可恢复地失败

> 2026-10-11 · 由 dsh-team-link 维护侧起草 · **本报告不改本仓任何东西**，只陈述观测与建议。
> 触发场景：用户报告某个团队会话「每次发团队消息都有几率失败」，错误逐字为
> `DeepSeek Messages stream: tool input is invalid JSON`（`code: MALFORMED_RESPONSE`）。

## 一、一句话

**DeepSeek 的框定 token（全角竖线 U+FF5C 包夹的包裹结构，即工具调用边界的特殊 token）有时会出现在工具调用的参数内容里；
流式解析器据此判定"又一次工具调用开始"，参数串被截断 ⇒ JSON 解析失败 ⇒ 回合直接结束。**
更麻烦的是：**它留在上下文里会自传播**。

## 二、证据（可复核）

### 2.1 量级与分布

跨 4 个工作区、**11 个会话、29 次** `MALFORMED_RESPONSE`。按「失败时正在调的工具」分：

| 工具 | 次数 | 其中参数带 token |
| --- | --- | --- |
| `team_link_team_append` | **15** | **15 / 15（100%）** |
| （回溯未抓到 attempt，未归因） | 7 | — |
| `validate_dsh_ui` | 5 | — |
| `team_link_send` | 1 | — |
| `eng_coder` | 1 | — |

⇒ **不是某个插件特有的问题**：至少三个不同的工具面都出现过；只是"参数要写长文本"的那类工具占比最高。

### 2.2 字符级定位

15 次失败里，JSON **断在同一位置**：
`Expected ':' after property name in JSON at position 24 (line 1 column 25)`。
坏串形态（用码点表示，避免复述特殊 token）：

```
{ "file" : "decisions" <U+003C U+002F U+FF5C U+FF5C D S M L U+FF5C U+FF5C> : "★S8 第 1 步失败…"
```

即：**第一个属性的值正常写完，紧接着冒出框定 token，之后才是第二个属性的值**。
⇒ 模型是在一个**属性边界**处漏出框定 token 的。

### 2.3 自传播（这是最值得修的一点）

**11 个有失败的会话，11 个的上下文里都含该 token**（共 **69 条已入库的 `assistant/message`** ＋ 2 条 `tool/result`）。
⇒ 模型看得见自己上一轮的产物 ⇒ 复现 ⇒ 再死。
实测：某会话 **turn 51→54 连死 4 次**；另一会话 62/63 又连死 2 次。

### 2.4 复现口径

- 会话日志：`<DSH_HOME>/sessions/<workspace-slug>/<session>/session.v4.jsonl.zstd`（**多帧 zstd**，Node 自带解压只出第一帧，需逐帧走帧头）。
- 失败事件：`turn/end` 且 `data.reason.error.code === "MALFORMED_RESPONSE"`。
- **原始流**：紧邻其前的 `assistant/attempt` 事件带 `data.stream`，工具名与参数增量都在里面 —— 这是能定位到字符级的原因。
- 本仓已归档四个扫描脚本：`.investigations/token-sanitize-2026-10-11/scripts/`（`tally-malformed.mjs` / `token-variants.mjs` / `dump-failures.mjs` / `scrub-sources.mjs`）。

## 三、建议（按性价比排序）

| # | 建议 | 为什么 | 难度 |
| --- | --- | --- | --- |
| **1** | **参数内容里的框定 token 不应被当成边界** —— 解析器应在"已进入某个 block 的 arguments 缓冲"时忽略边界判定，或把该 token 视为普通字符 | **这是根因**。参数内容是数据（模型意图），不是控制流 | 需适配器侧改动 |
| **2** | **落盘/回灌时对特殊 token 做转义或剥离**（写入会话日志、或作为上下文回灌时） | 切断 **§2.3 的自传播**。即使模型偶发漏出，也不会把下一个回合也拖死 | 中等 |
| **3** | **失败不应不可恢复**：`MALFORMED_RESPONSE` 目前**结束整个回合**；建议退化为「丢弃这次工具调用 + 回一句"工具参数解析失败，请重试并避免特殊字符"」，让模型自己改写 | 现在是"一次手抖 = 一个回合报废"；可恢复错误能把损失降到一次调用 | 中等 |
| **4** | **给 `turn/end` 的错误补一条结构化提示**（如 `retryable` / `hint`），并让 GUI 提示"该会话上下文可能已被污染，建议开新会话" | 用户现在看到的是一个红条，**不知道重试会继续失败** | 低 |

## 四、我们能做与不能做

- **本仓（dsh-team-link）能做的**：把**经过本插件**的文本全部消毒（工具结果、跨会话投递、提示词段、摘要、状态卡、deep-link 快照、黑板落盘）——
  已立项为 **批 E**（`docs/2026-10-11-token-sanitize-design.md`），**它只堵传播面，不修根因**。
- **本仓不能做的**：**触发层在流式解析器里**（建议 1/2/3）。
- **给用户的临时建议**（本仓已写入设计档 §0/§9）：会话一旦中招，**重试几乎必然复现** ⇒ **开新会话**；并且**不要让 agent 去 grep 这个 token**（那正是父侧自伤三次的动作）。

## 五、附：为什么本报告不写出那个 token 的原串

**它本身是特殊 token**：逐字写进文档/脚本/工具参数，会提高**写这个动作**被判 `MALFORMED_RESPONSE` 的概率。
本仓因此立了一条纪律（`docs/2026-10-11-token-sanitize-design.md` §6.1 与 `AGENTS.md` §四）：
**构造它必须用码点（`String.fromCharCode(0xFF5C)`）；体检工具的输出也必须遮蔽。**
本报告即按该纪律写成；如需原串，请按上述码点自行复现（全角竖线不是 ASCII 的 `|`）。

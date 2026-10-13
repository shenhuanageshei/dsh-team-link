# 批 L · 名册文件的并发写保护 —— 设计档

> **规格档**。需求档 [`docs/2026-10-13-policy-atomic-write-requirements.md`](2026-10-13-policy-atomic-write-requirements.md)。
> 行号一律 as-of **2026-10-13 工作树（commit `f24f167`）**，实施按**符号名**定位。
> ★ 本档全文不写出框定 token 的原串（批 E 立的仓规）；新测试标识符统一用 **`Aw` 中缀**。

---

## 0. 结论与图（给用户与实施者先看）

**三句话**：① 事故根因是**所有写入者共用一个固定名的临时文件**（`<file>.tmp`），两个进程同时写就互相截断、交错；② 修法是**让每次写的临时文件名唯一**（进程号 + 随机后缀），并在 `rename` 上补**有界重试**；③ 判据要能**真红**：在同一实现上，「判据甲」（要求唯一名）红 而「判据乙」（要求固定名）绿 —— 修复后两者互换。

```mermaid
flowchart TD
    A["policy.update()（任一名册/信任/看门狗写点）"] --> B{"fileCorrupted?"}
    B -- 是 --> C["不落盘；warn；回 false（既有行为，本批不动）"]
    B -- 否 --> D["persistPolicyFile()"]
    D --> E["writePolicyFileAtomic(file, text)"]
    E --> F["临时名 = file + '.tmp-' + pid + '-' + 随机 8 hex<br/>（★ 本批唯一改动点）]
    F --> G["open(tmp,'w') → writeFile → fsync → close"]
    G --> H{"rename(tmp → file)"}
    H -- 成功 --> I["返回 true"]
    H -- 失败 --> J{"还有重试额度?"}
    J -- 有 --> K["短延迟后重试（≤3 次）"] --> H
    J -- 无 --> L["清理残余临时文件（best-effort）<br/>抛给 persistPolicyFile → warn + 落点降级"]
```

---

## 1. 背景

2026-10-13 上午，两名协调者（`team-link-bac-1009-coordinator-e3d1aa13`、`team-link-mal-analyze-1011-coordinator-c768c616`）同时报「团队名册丢了」。父侧取证：`~/.dsh/team-link/policy.json` **不可解析**，但**完整部分含全部 10 个团队**（含两队各 5 个角色）、68 组配对、12 个看门狗注册 ⇒ **数据没丢，是文件读不出来**。原始坏文件已留存为 `policy.json.corrupt-2026-10-13T02-36-07-303Z`。

---

## 2. 问题（根因，带 file:line）

**根因唯一**：`lib/index.js:1895-1906` 的 `writePolicyFileAtomic` 把临时文件名**写死**：

```js
const tmp = `${file}.tmp`;      // :1897  ← 全部写入者共用同一个临时文件
const handle = await open(tmp, "w");  // :1898  ← "w" 截断：后者清零前者正在写的文件
await rename(tmp, file);        // :1905  ← 无重试
```

**现场签名（实测，逐字节吻合）**：`834,388 − 834,315 = 73` ⇒ 「甲写完的 **834,315** 字节」之上，**乙从偏移 834,315 起写了 73 字节**。⇒ 同一 inode 上两个写者交错。

**唯一写路径的核对**（需求档 §2.3 已列）：`policy.json` **只有** `writePolicyFileAtomic` 一条写路径；`writeFileSync` / `createWriteStream` **零命中**；`appendFile` 只写黑板。⇒ 排除其他嫌疑人。

**放大因素**：文件已涨到 **814 KB**（10 团队 + 68 配对 + 12 看门狗）⇒ 写得越久，两进程时间窗重叠概率越大。

---

## 3. 目标

**做完之后**：多进程同时写名册时，文件**要么是甲的完整版、要么是乙的完整版**（`rename` 的原子性保证），**永远不会出现两者交错的字节**。

**非目标**（需求档 §五，逐条对应）：
1. **不做自动修复**（读到损坏档仍走「不覆盖 + 人工处置」，`POLICY_REASON_CORRUPT` 一字不改）。
2. **不改落点语义**（settings 在场走 settings、不在场走文件；不双写）。
3. **不引入跨进程文件锁**（无新依赖）。
4. **不改各写点的调用语义**（谁写、写什么、什么时候写，全不动）。
5. **不碰黑板的 `appendFile` 路径**。

---

## 4. 决策与理由

| # | 决策 | 理由 | 被否决的备选 |
| --- | --- | --- | --- |
| **D1** | **临时文件名唯一化**：`${file}.tmp-${process.pid}-${8 位随机 hex}` | 唯一名 ⇒ 两个写入者**不可能**碰同一 inode ⇒ 撕裂的物理前提消失。这是**最小改动**（一个常量表达式）。 | ① 文件锁（新依赖、跨平台行为不一）· ② 全局串行队列（进程内队列挡不住跨进程，而本次正是跨进程）· ③ 改用数据库（范围爆炸） |
| **D2** | **`rename` 补有界重试（≤3 次，短延迟）** | Windows 上目标被另一进程占用时 `rename` 会抛 `EPERM`/`EBUSY`；现有调用方**无重试** ⇒ 一次偶发失败就是「这段状态没落盘」。重试把它变成「大概率成功」。 | ① 不重试（保留现状 —— 偶发丢写）· ② 无限重试（可能挂住热路径） |
| **D3** | **失败仍走既有 warn + 落点降级**（不新增错误类型） | 既有 `persistPolicyFile` 的 catch（`:1944-1952`）已把失败如实反映成「⚠ 仅进程内存」；新增错误类型只会让落点行分叉。 | 新增专用原因码 |
| **D4** | **随机后缀用既有 `createHash`**（`node:crypto`，已在 8 条白名单内） | **零新依赖**（NF-L1）；不用 `Date.now()` 单变量（同毫秒并发会撞名）。 | `randomUUID()`（也在 `node:crypto` 内，但会把 UUID 的连字符带进文件名；hex 更省事） |
| **D5** | **残余临时文件 best-effort 清理**（重试耗尽后 `unlink`） | 失败路径不清会把 `.tmp-*` 越积越多；但清理**本身失败不许掩盖**原始错误。 | 不清理（积累垃圾文件） |
| **D6** | **不做「启动时扫描残留临时文件」** | 唯一名之后前缀可辨（`.tmp-`），扫一遍很便宜 —— 但它**不解决本次的故障**（本次是撕裂内容、不是残留文件），且引入新写面。**留作后续候选**，本批不做。 | 本批顺手加清扫 |

---

## 5. 方案（FR-L1…FR-L3）

| FR | 内容 | 落点（符号名 · 行号 as-of） |
| --- | --- | --- |
| **FR-L1** | **唯一临时名**：写入前算出 `${file}.tmp-${pid}-${token}`；`token` = `createHash("sha256").update(`${process.pid}:${Date.now()}:${Math.random()}`).digest("hex").slice(0, 8)` | `writePolicyFileAtomic`（`lib/index.js:1895`） |
| **FR-L2** | **有界重试**：`rename` 失败 ⇒ 最多重试 3 次（含首次），每次间隔 25ms；仍失败 ⇒ 清理临时文件（D5）并**抛给调用方**（既有 catch 接管） | 同上（新 helper 与它同闭包） |
| **FR-L3** | **留痕**：重试发生时**不静默** —— 首次退避时 `ctx.logger?.warn?.(…)` 一行（含 `file` 与 errno），只报一次/段（沿用既有「一段一行」范式） | 同上 + `persistPolicyFile`（`:1925`）的既有 catch |

**改动的文件面**：`lib/index.js`（一个函数 + 一个新 helper + **一处既有注释改准**）· `host-half.test.mjs`（新判据块）· 本批两份档 + `CHANGELOG.md` + `README.md`（工具面未变，只改实现说明）。

★ **顺带的文档卫生更正（同批做，属文档卫生第 5 条「描述面与实现一致」）**：`lib/index.js:1909-1911` 的 `renderPolicyFileDocument` JSDoc 逐字写着「**八个键**每次写全」，而 `DEFAULT_POLICY` 今天是**十键**（`blocks` 与 `pendingCreates` 都是后来加的）。本批把它改成**按事实的说法**（不写死数字，或写「十键」并指名权威读数位置）。⇒ 这条**不影响行为**，但会误导下一个读它的人。

---

## 6. 机制伪代码（前置 / 后置）

```js
/**
 * 前置：file 是绝对路径；text 是完整文档字节；调用方已确保不在损坏档分支。
 * 后置：目标文件内容**恰为** text（或抛错且目标文件保持调用前的完整版本）。
 *       成功路径不留下任何 .tmp-* 文件；失败路径 best-effort 清理。
 * 不抛：否 —— 失败抛给调用方（persistPolicyFile 的既有 catch 接管）。
 */
async function writePolicyFileAtomic(file, text) {
    await mkdir(path.dirname(file), { recursive: true });
    const token = createHash("sha256")
        .update(`${process.pid}:${Date.now()}:${Math.random()}`)
        .digest("hex").slice(0, 8);
    const tmp = `${file}.tmp-${process.pid}-${token}`;   // ★ FR-L1：唯一
    const handle = await open(tmp, "w");
    try { await handle.writeFile(text, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    let last = null;
    for (let attempt = 1; attempt <= 3; attempt++) {      // ★ FR-L2：有界重试
        try { await rename(tmp, file); return; }
        catch (error) {
            last = error;
            if (attempt === 1) warnOncePerWindow(file, error);  // ★ FR-L3
            await sleep(25);
        }
    }
    try { await unlink(tmp); } catch { /* best-effort；不掩盖 last */ }   // ★ D5
    throw last;
}
```

**新增符号**：`sleep`（`new Promise(r => setTimeout(r, ms))`）· `warnOncePerWindow`（复用既有「一段一行」布尔门，与 `fileWriteWarned` 同范式）· `unlink` 需从既有 `node:fs/promises` **补充到 import 列表**（★ 见 §7：这不增加**条数**，只在既有那一行的解构里加一个名字 —— 实测既有第 8 条是 `import { appendFile, mkdir, open, readFile, readdir, rename, writeFile } from "node:fs/promises"`）。
**前置（对 `sleep`）**：ms 为正有限数。**后置**：至少等待 ms。**不抛**。

---

## 7. 状态与 schema

**零 schema 变更**：本批不新增/删除任何状态字段（`policy.json` 的 `schema` 常量 `POLICY_FILE_SCHEMA`（`:1689`）保持 1）。

| 项 | 变更 |
| --- | --- |
| `policy.json` 形状 | **一字不改** |
| 磁盘上新增的文件 | **仅**瞬态 `.tmp-<pid>-<token>`（成功即被 `rename` 消费；失败路径清理） |
| 谁写谁读 | 不变：`persistPolicyFile` 写、`loadPolicyFile` 读 |
| import 面 | **条数不变（8 条）**；`node:fs/promises` 那一行的**解构列表**加一个 `unlink` ⇒ **NF-L1 的两个既有锁（`批 H · NF-H5` / `批 I · U17`）判的是「条数与说明符」**，加一个已在该模块内的名字**不改变**这两个读数 —— 但**必须在设计档与交付报告里点名**，不得让读者以为 import 面没动过 |

---

## 8. 防偏离（判据与红相构造）

**判据统一在 `host-half.test.mjs` 新增「批 L」块，标识符 `Aw` 中缀。**

| # | 判据 | 红相（怎么让它红） |
| --- | --- | --- |
| **U1** | **唯一临时名（正向）**：`writePolicyFileAtomic` 的源码里，`tmp` 的赋值**不是**常量拼接 —— 实取该函数源码文本，断言它同时含 `process.pid` 与一次哈希调用，且**不含** `` `${file}.tmp` `` 这一字面量 | 把实现回退成固定的 `` `${file}.tmp` `` ⇒ **本条红** |
| **U2 = U1 的反向锁** | **固定名（反向）**：断言源码文本**含** `` `${file}.tmp` `` ⇒ **在修复后的实现上必红** | 修复后**本条必须红**；不红说明 U1 是恒真 |
| **U3** | **重复写不撕裂（行为面）**：连续两次 `policy.update` ⇒ 文件字节**恰等于**第二次的 `JSON.stringify(…,2)+"\n"`；**且**目录里**没有**残留 `.tmp-*` | 把两次写改成交替覆盖同一临时文件（模拟旧实现）⇒ 内容混入前一次的尾巴 ⇒ 本条红 |
| **U4** | **rename 失败有重试**：注入 `rename` 前两次抛（第 3 次成功）⇒ ① 文件**最终内容正确** ② 失败计数 = 2 ③ **恰一行** warn（一段内不重复） | 去掉重试 ⇒ 文件内容停在旧版 ⇒ 本条红 |
| **U5** | **重试耗尽后的失败方向**：注入 `rename` 恒抛 ⇒ ① `persistPolicyFile` 回 `false` ② 落点行仍可核（`⚠ …`）③ **没有残留** `.tmp-*`（best-effort 清理生效）④ 抛出的错误**保留原始 errno** | 去掉清理 ⇒ ③ 红；把错误吞成 `undefined` ⇒ ④ 红 |
| **U6** | **零 schema / 零形状变更**：写出的文档键集与既有的**十键**（权威读数：`host-half.test.mjs:7312` 的 `U19_POLICY_KEYS` = `blockedSenders` / `blocks` / `pairs` / `pendingCreates` / `receiveMode` / `rememberTargets` / `sections` / `teams` / `trustedSenders` / `watchdogs`）逐字一致；`POLICY_FILE_SCHEMA`（`:1689`）仍为 1 | 顺手加字段 ⇒ 键集断言红 |
| **U7** | **零新依赖（条数锁）**：顶层 `^import` 仍**恰 8 条**，八个说明符逐字是白名单那一份（含 §7 点名的 `unlink` 加入方式） | 新增第二条 `import` 行 ⇒ 本条红 |

**两次实测读数（实施方必须给）**：修复前 ⇒ **U1 红 / U2 绿**；修复后 ⇒ **U1 绿 / U2 红**，且 U3–U7 全绿。

---

## 9. 边界

| 情形 | 行为 |
| --- | --- |
| **同一进程内并发两次写** | 两次各得唯一临时名 ⇒ 各自完整；`rename` 后者胜 ⇒ 最终是后者的完整版（不撕裂） |
| **跨进程并发写**（本次事故场景） | 同上 —— **本批要消除的正是这一格** |
| **目标文件被占用（Windows）** | `rename` 偶发失败 ⇒ 重试 ≤3 次；仍失败 ⇒ 如实报错 + 落点降级（不静默） |
| **磁盘满 / 只读** | `open` 或 `writeFile` 抛 ⇒ 走既有 catch ⇒ `⚠ 仅进程内存`（本批不新增分支） |
| **崩溃在 write 与 rename 之间** | 留下的**唯一名** `.tmp-*` **不会被读**（读只认 `policy.json`）⇒ 状态是上一次完整版本（安全） |
| **损坏档** | **本批一字不改**：`fileCorrupted` ⇒ `persistPolicyFile` 直接回 `false`（`:1930-1933`），不覆盖、不自动修复 |
| **失败方向** | **fail-closed 于状态**（不假装写成功）、**fail-open 于可用性**（内存态继续服务，落点行降级）—— 与既有语义一致 |
| **重启** | 修好的文件在**下一个进程**被读到（每进程只读一次是既有事实）⇒ 本批的落地判据必须包含「重启后名册回来」 |

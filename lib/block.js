// ---------------------------------------------------------------------------
// 屏蔽作用域域（block · messaging 的第一片）—— 批 R（上架合规）第 9 小单从 lib/index.js **原样搬出**
// ---------------------------------------------------------------------------
// 归属：docs/2026-10-15-store-compliance-design.md §4 D1/D2/D4 · §5 FR-R1 · §6（拆分契约）·
//       §8 Rr3/Rr4/Rr8；领域自身的设计档 docs/2026-10-12-block-scope-design.md §6（批 I）。
// ★ 本档是什么：批 I「屏蔽的作用域」的**九个函数** —— 三个读原语与规范化（blockPair /
//   blockEntryBetween / isBlocked）、三个写路径（blockSender / unblockPair / clearLegacy）、
//   两条拒收文案（blockedDeliveryText / blockDecisionText）与一条分组读面（blockListLines），
//   连同各自的文档注释与那条小节横幅。工具面（team_link_block 的注册与 execute）**不在本档**
//   —— 它早在第 6 小单就搬进了 lib/registration.js（本档只是它经缝拿到的那几个实现）。
// ★ 搬的是**一个连续切片**：入口 lib/index.js 第 1605–1745 行（141 行；工作树 9,842 B，EOL 归一到
//   LF 后 9,702 B）。机检口径：① 该切片在本档正文里**逐字节出现恰一次**（不插 export 前缀、
//   不改缩进、不动行尾注释）；② 入口搬迁后对它**零命中**（含 EOL 归一口径）；③ 九个函数声明段
//   本身合计 7,390 B（含各自尾随空行）。
// ★ 装配缝：**本档没有 wire***（与 lib/ledger.js / lib/sections.js 同形 —— 那两档也没有缝）。
//   为什么：本子族对外部裸名**零依赖**。机检口径（剥掉 // 注释与字符串字面量后按裸词边界逐个
//   检索切片）：出现的非关键字标识符只有三类 —— ① 九个被搬函数自己的名字（块内互调）② 各自的
//   形参 / 局部量（policy · view · selfId · senderId · a · b · entry · lines · remaining …）
//   ③ 内建 Date。**一个入口侧绑定都没有** ⇒ 没有可注入之物。按 §6「被搬的函数只带它自己的
//   依赖」与 D4「不改一行逻辑」，这里**不造**一条永不执行的空缝：先例里缝只服务「域要读入口
//   那条绑定」的档（registration / team-registration / team-ledger-tools / forensics）。
// ★ 被钉符号核对（本仓 hostSource 文本锁钉住的 9 个：writePolicyFileAtomic / renameThroughSeam /
//   POLICY_FILE_SCHEMA / WATCHDOG_DIGEST_DEBOUNCE_MS / TICKABLE_VERDICTS / agentStateLabel /
//   writerGate / relayUserMessage / buildTeamSessionCreateOptions）：**九个一个都没搬**，仍逐字节
//   住在入口；本档对它们**零命中**（可执行代码面与注释面都没有 —— 上面这一行是点名核对，不是
//   引用）⇒ 那些「按函数自身锚点切片」的源码锁读数一字不变，本档也没有任何一条经缝与它们接触。
// ★ 依赖方向（Rr4「模块图无环」的实测口径）：本档**零 import** —— 既没有宿主导入（宿主说明符
//   集合仍是白名单那 8 个 ⇒ Rr3 读数不变），也没有内部相对导入；新增的模块图边只有「入口 → 本档」
//   一条单向边 ⇒ 不可能成环。lib/client.js 与浏览器半边一个字节未动。
// ★ 搬运纪律（D4）：本档新增的只有 ① 本段档头 ② 尾部那一条 export { … };；**切片本身一个字符
//   都没动**（含行首制表符缩进、行尾注释与空行）。之所以用尾部一条 export 而不是在九行 function
//   前各插一个 export 前缀：前者让被搬正文保持**逐字节**，机检因此不需要任何「先剥前缀再比」的
//   转换 —— 这也是本单「逐字节等价」读数最干净的口径。
// ★ 留给下一小单（三个子族仍在入口，本单一个字都没动它们）：投递路径（deliverToTarget / fanout /
//   建卡家族 / readMeta 信封 · 实测闭包 50 个符号 56,226 B，且**跨界**拉进活性读面 ⇒ 不是
//   「最自成一体的一个」）· 列表读窗（readListReadWindow / listReadTail · 闭包 6 个符号 5,344 B）
//   · 导出（exportSession / 三档渲染 + 下载路由 · 闭包 13 个符号 8,261 B，但下载路由与面板路由
//   共用 lib/index.js 的 registerReadRoutes 一个函数体，搬它要拆函数 ⇒ 不属「纯机械搬运」）。
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 批 I · 屏蔽的作用域（docs/2026-10-12-block-scope-design.md §6）
// ---------------------------------------------------------------------------

/**
 * 规范化一对（设计档 §6 / D2）：**小 id 在前** ⇒ A↔B 与 B↔A 是同一条。
 *
 * 写入（{@link blockSender}）与解除（{@link unblockPair}）**共用这一处** —— 两处各写一份
 * 规范化，就会出现「A 屏蔽 B 写了一条、B 屏蔽 A 又写了一条」的两条并存态，解除时只解掉
 * 其中一条（U3 的红相）。
 */
function blockPair(a, b) {
	return a <= b ? { a, b } : { a: b, b: a };
}

/** 这一对里**含有**两个 id 的那一条配对屏蔽条目，或 null（接收方视角，双向，D2）。 */
function blockEntryBetween(view, selfId, senderId) {
	return view.blocks.find((entry) => (entry.a === selfId && entry.b === senderId) || (entry.a === senderId && entry.b === selfId)) ?? null;
}

/**
 * FR-I3 判定（接收方视角）。前置：`senderId` 非空；`selfId` = 本会话 id（由调用点**已有的**
 * 身份读取路径给出，见设计档 §10.2）。后置：`blocked === true` ⇒ 拒收。命中条件（**并集**，
 * NF-I3）：
 *  ① `blocks` 里存在同时含 `selfId` 与 `senderId` 的条目（**双向**，D2 保证只存一条）；
 *  ② 旧格式 `blockedSenders` 含 `senderId`（**保留原保护**，D3 —— 不静默放开）。
 * `legacyHit` 只对「旧格式命中」为真，供文案标注「范围偏大」（FR-I5）；`entry` 是命中的那种
 * 配对条目（旧格式命中时为 null），供文案报出「谁挡的」与解除参数。
 * ★ 只读，不写。
 */
function isBlocked(policyView, selfId, senderId) {
	const entry = blockEntryBetween(policyView, selfId, senderId);
	const legacy = policyView.blockedSenders.includes(senderId);
	return { blocked: entry !== null || legacy, legacyHit: entry === null && legacy, entry };
}

/**
 * FR-I2 写入：配对化。前置：对话框已选「拒绝并屏蔽该会话」；`senderId` 非空；
 * `selfId` = **点屏蔽的那一方**（当事接收方）。后置：`blocks` 恰多一条规范化条目
 * `{ a, b, by: selfId, since }`（**幂等**：已存在则不重复追加）；**`by` 必填**（D2/D7：
 * 没有它就没法判定谁能解）；`blockedSenders` **一个字节不动**（D3：旧名单只读不写）。
 */
async function blockSender(policy, selfId, senderId) {
	const target = blockPair(selfId, senderId);
	const current = policy.get().blocks;
	if (current.some((entry) => entry.a === target.a && entry.b === target.b)) return;
	await policy.update({ blocks: [...current, { ...target, by: selfId, since: new Date().toISOString() }] });
}

/**
 * FR-I4 解除（D7 ← 用户 A2 裁定「甲」）。前置：`selfId` = 调用方会话 id（**必填**）；
 * `a` / `b` 为这一对的两个会话 id（工具参数形态**定为这一种**，没有第二形态）。
 * 权限：**只有 `entry.by` 那一方能解** —— 被屏蔽的一方、以及第三方（既非 a 也非 b）
 * **一律拒绝 + 零写入**。
 * 后置：`blocks` 去掉那一条（**只去一条**，别的对与旧名单都不动）；若这一对不在 `blocks`
 * 里、或 `selfId !== entry.by` ⇒ **不做任何写入**，返回结构化拒绝（调用方据此渲染
 * 「如实拒绝 + 列出当前全部屏蔽」，不是静默成功 —— U7/U14）。
 *
 * @returns `{ok:true, entry, remaining}` 或 `{ok:false, reason:"absent"|"not-owner", entry, caller, blocks}`。
 */
async function unblockPair(policy, selfId, a, b) {
	const view = policy.get();
	const target = blockPair(a, b);
	const entry = view.blocks.find((item) => item.a === target.a && item.b === target.b);
	if (entry === undefined) return { ok: false, reason: "absent", entry: null, caller: selfId, blocks: view.blocks };
	if (entry.by !== selfId) return { ok: false, reason: "not-owner", entry, caller: selfId, blocks: view.blocks };
	const remaining = view.blocks.filter((item) => !(item.a === target.a && item.b === target.b));
	await policy.update({ blocks: remaining });
	return { ok: true, entry, remaining };
}

/**
 * FR-I4 清旧格式（A1 ← 用户裁定：**按发送方逐条清**，不做批量；D8 ← 用户甲′裁定：
 * **被该条目挡住的发送方本人不得清自己的条目**，其余任何会话可清）。
 * 前置：`selfId` = 调用方会话 id；`sender` 非空且是字符串。
 * 后置：① `selfId === sender` ⇒ **拒绝 + 零写入**（受益方不能自己动手，保住 D7 的底线）；
 *        ② `blockedSenders` 里那一条消失、其余条目与**其它所有键逐字节不动**（补丁只含
 *        `blockedSenders` 一个键）；
 *        ③ 旧名单里**没有**这个 sender ⇒ 如实拒绝 + 零写入，并列出当前旧名单（U12）。
 * ★ 逐条清、**不批量**：批量会在一次调用里放开全部旧保护（A1 明确否决）。
 *
 * @returns `{ok:true, remaining}` 或 `{ok:false, reason:"absent"|"beneficiary", blockedSenders, caller}`。
 */
async function clearLegacy(policy, selfId, sender) {
	const view = policy.get();
	if (selfId === sender) return { ok: false, reason: "beneficiary", blockedSenders: view.blockedSenders, caller: selfId };
	if (!view.blockedSenders.includes(sender)) return { ok: false, reason: "absent", blockedSenders: view.blockedSenders, caller: selfId };
	const remaining = view.blockedSenders.filter((item) => item !== sender);
	await policy.update({ blockedSenders: remaining });
	return { ok: true, remaining };
}

/**
 * FR-I5 的一条拒绝文案（投递路径的**收件检查**那一处）：点名「**谁挡的**」＋「**怎么解**」。
 * 旧格式那一支还要说明**范围偏大**（NF-I3：旧的全局名单挡的是该发送方对**所有**会话的投递，
 * 不是只挡这一对）并给出**可执行**的清除指引（工具名 + 动作 + 参数示例）。
 */
function blockedDeliveryText(hit, receiverId, senderId) {
	if (hit.entry !== null) {
		const entry = hit.entry;
		return `未投递：当前会话与目标会话 ${receiverId} 之间已屏蔽（配对屏蔽，由 ${entry.by} 发起；只挡这两个会话之间的投递，双向）。解除：只有发起屏蔽的一方（${entry.by}）可以解除 —— 由它调用 team_link_block action=unblock a=${entry.a} b=${entry.b}。`;
	}
	return `未投递：目标会话已屏蔽来自当前会话的消息（旧格式全局屏蔽：范围偏大 —— 它挡住的是 ${senderId} 对**所有**会话的投递，而不是只挡这一对）。解除：由其它任一会话调用 team_link_block action=clear-legacy sender=${senderId}（被该条目挡住的发送方本人不能清自己的条目）。`;
}

/**
 * FR-I5 的第二条拒绝文案（对话框选「拒绝并屏蔽该会话」的那一处）：点名谁挡的（目标会话的
 * 用户）与怎么解（`team_link_block action=unblock`，且**只有发起屏蔽的一方**能动）。
 */
function blockDecisionText(receiverId, receiverLabel, senderId) {
	const pair = blockPair(receiverId, senderId);
	return `未投递：目标会话 ${receiverLabel} 的用户拒绝并屏蔽了来自当前会话的消息（配对屏蔽：只挡这两个会话之间的投递，双向；只有发起屏蔽的一方可以解除 —— 由 ${receiverId} 调用 team_link_block action=unblock a=${pair.a} b=${pair.b}）。`;
}

/**
 * FR-I4 / U15：屏蔽的**分组读面** —— `team_link_block action=list` 的正文，也是两处解除
 * 拒绝文案里「列出当前全部屏蔽」的那一段（**同一处渲染**，不抄第二份）。
 *
 * 两组**分开呈现**，因为两者的语义与出口都不同：
 *  · 【配对屏蔽】一对一对，双向，只有 `by` 那一方能解（D7）；
 *  · 【旧格式屏蔽】**范围偏大（旧格式）** —— 旧条目只按发送方落盘、没有接收方维度，
 *    所以它挡住的是该发送方对**所有**会话的投递；出口是按发送方**逐条**清（A1），
 *    且**被该条目挡住的发送方本人不能清自己的条目**（D8）。
 * 两条指引都写成**可执行**的形式（工具名 + 动作 + 参数示例，设计档 §10.4）。
 */
function blockListLines(view) {
	const lines = [`当前屏蔽（配对屏蔽 ${view.blocks.length} 条 / 旧格式屏蔽 ${view.blockedSenders.length} 条）：`];
	lines.push("【配对屏蔽】（两个会话之间的一对，**双向**：A↔B 之后 A→B 与 B→A 都拒；只有发起屏蔽的一方可以解除）");
	if (view.blocks.length === 0) lines.push("  （无）");
	for (const entry of view.blocks) {
		lines.push(`  - ${entry.a} ↔ ${entry.b} · 由 ${entry.by} 发起 · since ${entry.since === "" ? "（未记）" : entry.since}`);
		lines.push(`    解除：team_link_block action=unblock a=${entry.a} b=${entry.b}（只有发起屏蔽的一方 ${entry.by} 能解；被屏蔽方与第三方调用会被拒绝且零写入）`);
	}
	lines.push("【旧格式屏蔽 · 范围偏大（旧格式）】旧条目只按发送方落盘、没有接收方维度 ⇒ 它挡住的是该发送方对**所有**会话的投递，而不是只挡一对。出口是按发送方**逐条**清（不做批量清）：");
	if (view.blockedSenders.length === 0) lines.push("  （无）");
	for (const sender of view.blockedSenders) {
		lines.push(`  - ${sender}`);
		lines.push(`    清除：team_link_block action=clear-legacy sender=${sender}（**被该条目挡住的发送方本人不能清自己的条目**，其余任何会话可清）`);
	}
	return lines;
}

export { blockDecisionText, blockEntryBetween, blockListLines, blockPair, blockSender, blockedDeliveryText, clearLegacy, isBlocked, unblockPair };

# Agent Note: Google 的 thinkingLevel 由模型自己的级别表决定，不再靠 id 正则

Status: implemented

## Problem

`gemini-4-hydrogen` 在 `thinkingLevelMap` 里声明了 `xhigh: "xhigh"`，但三个函数对它
给出互相矛盾的答案：

```text
getSupportedThinkingLevels   -> [low, medium, high, xhigh]   # UI 会列出 xhigh
usesGoogleThinkingLevel      -> false                        # 走 thinkingBudget
resolveGoogleThinkingLevel(m,"xhigh") -> throw               # ResolvedGoogleThinkingLevel 没有 xhigh
```

`streamSimple` 先 `clampThinkingLevel`（认为 xhigh 合法，原样返回）再
`resolveGoogleThinkingLevel`（立刻抛），抛出点在流函数体内、拿流之前，于是
`Agent.handleRunFailure` 把它收成一条 `stopReason: "error"` 的 assistant 消息。用户
看到的是「回合失败」，不是「级别被降级」。`max` 也撞：clamp 降到 `xhigh`，然后同样抛。

根因是判断依据与数据来源分裂：`usesGoogleThinkingLevel` 按 id 正则认人
（`gemini-3(?:\.\d+)?-(?:pro|flash)`、`gemini-flash-latest`、`gemma-?4`），
而 UI 列什么级别来自 `thinkingLevelMap`。`gemini-4-*` 落不进正则：

- `gemini-4-hydrogen` 声明 xhigh，撞出硬错；
- `gemini-4-argon` / `gemini-4-carbon` 只声明 low/medium/high，请求实际发的是
  `thinkingBudget: -1`（AUTO），声明的级别被静默忽略。

同一批模型，一个报错一个静默。

## Decision

`usesGoogleThinkingLevel` 先看 `thinkingLevelMap`：只要表里有一个值是 Google 级别控制
接受的级别名（`minimal|low|medium|high|xhigh`，大小写不敏感），就走 `thinkingLevel`。
id 正则退化成「没有级别表的旧数据」的兜底。

配套三处：

- `ResolvedGoogleThinkingLevel` 从排除 `xhigh|max` 收窄为只排除 `max`，
  `GOOGLE_SDK_THINKING_LEVEL_MAP` 与 `toGoogleThinkingLevel` 加上 `XHIGH`
  （SDK 3.3.0 的 `ThinkingLevel.XHIGH` 已存在）。`max` 没有对应的 Google 值，
  `clampThinkingLevel` 会在进入 resolve 之前把它降到 `xhigh`。
- `gemini-2.x` 强制留在 budget 路径：那一代的 `thinkingLevel` 字段不存在，把级别写进
  请求等于写了个模型不读的字段。
- **不**用级别表上线，但**不用**「有表就走级别」这一条来判 Claude 模型：
  `antigravity` 目录里 `claude-sonnet-4-6` 的级别表是 `{max: "max"}`，那个值不在
  Google 的级别名集合里，所以它仍留在 budget 路径。判据是「值是不是 Google 级别名」，
  不是「表存不存在」——map 的 value 在别的 provider 下是 `max`/`none` 这类它自己的词。

## Alternatives considered

- **在生成器里把 `gemini-4-hydrogen` 的 `xhigh` 抹成 `null`**：改一处 override 就能从
  「报错」变「降到 high」，但这是在生成器里撒谎——models.dev 那条数据是对的，而下一个
  声明 xhigh 的新模型会重演。
- **让 `resolveGoogleThinkingLevel` 对 `xhigh`/`max` 降级而不是抛**：最小改动，但它是
  刻意留着抓错误元数据的哨兵；放松后下一次同类错配会变成静默降级。
- **继续按 id 匹配，只把 `/gemini-3(?:\.\d+)?-(?:pro|flash)/` 扩成也认 `gemini-4-*`**：
  只修当下这一代，下个代号再来一次；而且 argon/carbon 那种「只声明 low/medium/high」
  的情况照样要靠猜后缀。
- **把 `xhigh` 也映射到 `HIGH`**：Google 有独立的 `XHIGH` 值，映射到 high 等于把用户
  选的最高档悄悄降一档。

## Consequences

- `gemini-4-*` 的 xhigh 请求带上 `thinkingConfig.thinkingLevel = "XHIGH"`；argon/carbon
  的 low/medium/high 落到请求上。
- 定期从 models.dev 生成、声明了级别表的模型自动走级别控制，不必再维护 id 清单。
- `getGoogleBudget` 的两张表补了 `xhigh`（与各自的 `high` 同值）。内置目录里没有
  预算型模型声明 xhigh，这一条只为手写 `models.json` 的场景服务：没有它，
  `Record<ResolvedGoogleThinkingLevel, number>` 会缺键。
- 回归测试在 `packages/ai/test/google-thinking-level-map.test.ts`，两个适配器各跑一遍
  hydrogen 的 xhigh、hydrogen 的 max→xhigh、argon 的 low/medium/high。

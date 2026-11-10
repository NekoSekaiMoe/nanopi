# Agent Note: ls / find 的 limit 小于 1 一律按 1 处理

Status: implemented

## Problem

`ls` 和 `find` 的 schema 都声明 `limit` 是普通 number，没有下界：

- `core/tools/ls.ts`：`effectiveLimit = limit ?? DEFAULT_LIMIT`。`limit: 0` 时
  循环第一轮 `results.length >= 0` 就成立，`results` 为空，工具返回
  `(empty directory)`——目录里明明有文件。
- `core/tools/find.ts`：同一行写法。`limit: 0` 变成 `--max-results 0`，fd 返回空
  列表，工具返回 `No files found matching pattern`。

两个都是"模型传了一个看起来合法的数字，工具报了假事实"。比报错更糟：模型没有
任何线索去怀疑结论，会据此认定目录空、文件不存在。

## Decision

`effectiveLimit = limit === undefined ? DEFAULT_LIMIT : Math.max(1, Math.floor(limit))`。
小于 1 的数、以及小数（`0.5` → `1`）都落在下界上，负数和 0 不再让工具静默返回空结果。
两处各写一遍，没有抽公共函数：两个文件的目录不同，为一个两行的表达式建立
`find → ls` 的 import 关系不值得。

schema 描述同步写清边界（`values below 1 mean 1`），模型在参数层面就能看到契约，
而不是靠试错发现。

## Alternatives considered

**校验失败，报错让模型重传。** 契约更严格，但一个越界参数换一次完整往返，
而"至少要一条结果"是能无歧义执行的意图。`grep`/`read` 的同类参数也是宽松语义。

**`limit: 0` 返回全部结果。** 这是 SQL 的 `LIMIT 0` 的反面（SQL 里 `LIMIT 0` 就是零行），
两种直觉各有先例；选"视为 1"是因为它和默认值的语义连续（默认是"给多少条上限"），
而且不会因为一个 0 把大目录整个倒给模型。

**抽成 `clampLimit(requested, fallback)` 放公共模块。** 只有一个调用点两处复用，
表达式本身一行，抽象收益低于跨文件耦合的成本。

## Consequences

- 行为变化只在 `limit < 1` 或非整数上；默认路径和正常上限完全不变。
- 输出里的 notice 用的是钳制后的值（`1 entries limit reached`），模型据此放大
  `limit` 时拿到的是真实生效的数字。
- 回归测试在 `test/tools.test.ts`（`limit below 1` 两条，find 和 ls 各一），
  把修复回退后两条都失败。

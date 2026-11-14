# Agent Note: SKU 预算钉值不改成动态

Status: rejected — 动态钉会把「涨了要付账」这条唯一的机制换成一条自动跟着涨的线，而它要防的 `+1` 本来就已经不红。见 shinytale/nanopi#680。

## Problem

`packages/coding-agent/test/sku-prompt-budget.test.ts` 里 `PINNED = { minimal: 405, base: 1540 }`
是 58768f055 当天在源码树上的读数，写死成字面量。shinytale/nanopi#680 里问了能不能改成动态的：
钉住的数字会漂（#681 就是 `find`/`ls` 的 `limit` 描述各加一句让 base 从 1540 变 1554），
每次都要人肉改常量。

## Proposal

（被否决的原方案，保留以便对照。）把 `PINNED = { minimal: 405, base: 1540 }` 换成运行时算出来的
基线：`baseline = measure(SKU).total`、或与 `HEAD~` 的读数比较、或按 `estimateTextTokens` 与
宿主平台浮动。这样工具声明涨价时不必人肉改常量，测试也不会因为 1540 变 1554 而红。

## 为什么动态钉留不住这条语义

钉值唯一的作用是**让涨价变成一次要人做决定的事**：`expect(total).toBe(PINNED.base)` 红了，
改常量的人在 diff 里写下为什么。钉值一旦自己跟着走，红就不会出现，也就没有人做这个决定。

三个具体的动态来源，各自是怎么漏的（本机实测，`estimateTextTokens` = `ceil(len / 3.5)`）：

- **跟今天读数走**：`baseline = measure(SKU).total` 的断言恒真。`find` 138→145 这类改动
  直接通过，一句注释都不留。
- **跟 `HEAD~` 走**：`git diff` 比的是已提交的树。改了工具声明、还没提交的那次运行拿到的
  基线和改完的 HEAD 是同一棵树，diff 恒为 0。要让它有意义就得拿工作区的脏树自比，
  可那样它就是「跟今天读数走」。
- **按宿主平台 / `esbuild` 产物 / 估算器的浮点算**：这些不是漂移源。三个值在本机复现得
  一模一样：base 1540（prompt 381 + 声明 1159），minimal 405（184 + 221），
  base 只装 read/bash/edit/write 时 866。其中 `estimateTextTokens` 只是 `ceil(len / 3.5)`，
  输入固定则输出固定。给一个不漂的东西加容差，只是把门放宽。

## 阈值形式能挡住什么，又丢什么

`toBe(PINNED)` 在 1540 变 1541 时就红。#681 退掉的两句 `values below 1 mean 1`
是 46 个字符摊在两个声明上，恰好 14 token；如果当时写的是 `toBeLessThanOrEqual(1560)`，
它不会被拦下。更粗的 `toBeGreaterThan(TARGET.base)`（900）则更糟：base 今天的 1540 离 900
还有 640 的余量，这条断言在任何涨价面前都是空的，它只记录「愿望没达成」。

`toBe` 的严格不是洁癖——它有 640 token 的余量可以挥霍，从 1540 涨到 1541 就是「有人动了
prompt 或 schema」这件事本身，值不值得付账由看 diff 的人判断。阈值化会把这个判断换成
「在容差内」。

## Decision

钉值保持字面量，涨价靠改常量时在提交里说明。#681 已经这么走过一遍：改的是描述
（`find`/`ls` 回到不含 `values below 1 mean 1` 的写法），常量没动，`packages/coding-agent/test/tools.test.ts`
里那两条 `limit below 1` 的回归测试继续守着行为。

涨了要不要付账仍由人定。想让那条语义留在模型视野里，就把 `PINNED.base` 改成 1554 并在
提交里写明理由——这是「付账」，和「自动跟着涨」是两件事。

## Alternatives considered

- **`expect(total).toBeLessThanOrEqual(PINNED.base)`——只许降不许涨**。最强理由：不用人
  改常量就不会漂，方向也永远正确。否决理由：`find` 那 7 个 token 是描述变清楚了换来的，
  合理；一刀切禁止也拦不住恰好同价的对换（改 A 便宜 7、改 B 贵 7），却把「这笔值得」
  的判断权一起封死。
- **分工具钉住 `byTool`**。最强理由：红了能直接看出是哪个声明动的，`breaks the declaration
  cost down per tool` 那条已经在做这件事。否决理由：`byTool` 抓的是分配，抓不到总量；
  而 `read` 143 / `grep` 254 这些数字会随描述措辞频繁跳，维护成本高于收益。总量那条
  红了再看 `byTool` 就够了。
- **把 1540 换成 1554 并写明理由**。这是「付账」，不是动态化；与本记录不冲突，要不要付
  由维护者定。

## Consequences

- 改工具声明或 prompt 后跑 `sku-prompt-budget`，红了是预期行为，重点是看清 `byTool` 里谁动了。
- 钉值不声称自己「永远新鲜」：它是某一天的读数，上下文在 `58768f055` 的提交信息里。

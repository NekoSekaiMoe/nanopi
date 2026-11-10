# Agent Note: find 的路径 pattern 补 `**/` 前缀，这是 fd 的锚定语义

Status: implemented

## Problem

`find` 有两个 glob 实现：有 fd 时走 `fd --glob --full-path`，没有 fd 时走
`compileFindGlob` 的进程内走查。两边都给带斜杠的 pattern 补 `**/` 前缀。

#669 里先后有两个 PR 认定这个前缀有问题，前提都不成立。

**#671 的前提（已回退）**：`**` 匹配零或多级目录，所以 `**/src/**/*.ts` 会吃掉一级，
`src/**/*.ts` 漏掉 `src/` 直属的 `.ts` 文件。实测 minimatch 11.0.5：

```
minimatch("src/direct.ts",      "**/src/**/*.ts")  true
minimatch("src/sub/nested.ts",  "**/src/**/*.ts")  true
```

`**` 只在路径以 `/` 或 `..` 开头时才必须吃一段；相对路径没有那种起始段，前缀对
直属文件和子目录一视同仁。删前缀是空操作：`src/**/*.ts`、`src/*.ts`、`**/src/**/*.ts`、
`**/*.ts`、`*.ts`、`src/**`、`deep/src/*.ts`、`nested/*.ts` 八个 pattern 上，
改前改后命中集合完全相同。它挂的回归测试因此是假的 —— 把 `find.ts` 退回 #671 之前
照样通过。副作用是注释里写了字面 `src/**/*.ts`，`*/` 提前闭合注释块，`find.ts`
整体 PARSE_ERROR（#674 已修）。

**#672 的前提（已合并，实际收益与描述不同）**：`compileFindGlob` 没对齐 fd 的
`--full-path` 前缀，所以 `src/*.ts` 在 fallback 路径下只命中根直属的 `src/`，
`deep/src/far.ts` 消失。对 `src/*.ts` 这个**不带前导斜杠**的形态同样不成立：
补前缀本来就是既有行为，fallback 一直命中 `deep/src/far.ts`。实测九个 pattern，
改前改后唯一不同的形态是**带前导斜杠**的 `/src/*.ts`：

```
before #672  /src/*.ts -> (none)
after  #672  /src/*.ts -> src/direct.ts, deep/src/far.ts
```

原因是 #672 多加了一行 `rooted = normalized.startsWith("/") ? normalized.slice(1) : normalized`。
这行是真实的行为变化，但它和 PR 描述的 bug 不是同一个东西。

## Decision

保留两组前缀（`anchored` 与 #672 的 `rooted` + `anchored`），`src/**/*.ts` 覆盖直属
文件这个行为不变。

前缀表达的是**锚定**：路径 pattern 从搜索根的任意深度开始匹配，不是只匹配搜索根的
直属子目录。`src/*.ts` 因此也命中 `deep/src/far.ts`。fd 的 `--full-path` 匹配绝对
路径，前缀吃掉的是 `/repo/` 那一段，行为相同。这条语义继承自 fd，是现状，不是理想
契约 —— 对多数人来说 `src/*.ts` 命中 `deep/src/far.ts` 是意外，但改它要同时动两个
实现并回答「path pattern 匹配 basename 还是路径」，属于口径决策。

测试：`matches a root-level path pattern the way fd's full-path expansion does`
（#672 引入）同时钉住 `src/*.ts` 的锚定和 `src/**/*.ts` 对直属文件的覆盖，两种实现
下都通过，是保护而非修复。

## Alternatives considered

**按 #671 删前缀。** 实测空操作；附带注释改动还会让文件无法解析。

**把锚定收窄成「相对搜索根，不越出锚点」。** 更符合直觉，但要同时改 fd 与 walker，
并回答中间 `**` 是否允许跨目录、`**/` 开头如何显式表达任意深度。

**固定下载一个 fd 版本。** 上游 pi 的做法，解决 fd 10.5.1 对路径 pattern 零结果的
版本退化，与本条无关。

## Consequences

- `find.ts` 的 `compileFindGlob` 保留前缀与注释（注释用间接措辞描述 `**` 的零级
  匹配，避免再次提前闭合注释块）。
- `/src/*.ts` 现在能命中，是 #672 带来的真实变化；没有单独测试钉住它。
- 回归测试不再声称「回退实现即失败」，因为 `**/` 前缀的增删对
  `src/**/*.ts` 没有可观测影响。

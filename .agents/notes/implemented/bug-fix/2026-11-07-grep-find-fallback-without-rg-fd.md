# Agent Note: grep 和 find 在没有 rg/fd 时改用进程内遍历

Status: implemented

## Problem

`grep` 和 `find` 两个工具的全部实现就是 spawn 外部二进制。拿不到路径就整体报废：

- `core/tools/grep.ts` 里 `ensureTool("rg")` 返回 undefined 时直接 reject
  `"ripgrep (rg) is not available and could not be downloaded"`。
- `core/tools/find.ts` 对 `fd` 同样。
- `utils/tools-manager.ts` 在 `NANOPI_OFFLINE=1` 时连尝试都不做，直接返回
  undefined。

于是这三种情况里两个核心只读工具一起消失：`--offline` / `NANOPI_OFFLINE=1`、
公司网络封了 GitHub Releases、容器镜像没预装 rg。剩下能用的只有 `bash`，
而它还可能被 shell guard 挡住。用户看到的还是一句既不说是网络问题、也不给
出路的错误。

## Decision

`ensureTool` 返回 undefined 时不再失败，改走进程内遍历：
`core/tools/fallback-walker.ts` 用 `ignore`（已在依赖里，`skills.ts` 在用）
加 `node:fs/promises` 自己走目录树，`grep` 用 `RegExp` 逐行匹配，`find` 用
`minimatch` 匹配路径。

三件事必须跟二进制保持一致，否则工具契约会在两条路径之间漂移：

- **ignore 规则**：`.gitignore` / `.ignore` / `.fdignore` 逐目录累积。嵌套
  文件里的规则要按它所在目录重新定根（`prefixIgnorePattern`），父级规则继续
  生效——第一版给每个目录建了独立 matcher，于是根目录的 `build/*` 在
  `build/` 里不再起作用，测试当场抓到。目录被 `ignore.ignores(dir)` 排除后
  整棵子树不再打开，`.git` 和 `node_modules` 各只付一次 `readdir`。
- **glob 语义**：ripgrep 的 `--glob '*.ts'` 匹配文件名，`src/a.ts` 也算；直接
  丢给 minimatch 会被读成"只在根目录"。没有斜杠的 pattern 前面补 `**/`，
  带斜杠的按路径原样匹配。`find` 同理，只是它默认就按 basename 匹配。
- **符号链接**：只 `lstat`，不跟随。跟了就会在环上死循环，而且 fd 默认也不跟。

两条路径共用一份记账逻辑（`recordMatch`：全局上限、每文件预算、提前停止），
所以 `limit=`、per-file 预算、`trimmedFiles`、`stoppedEarly` 这些 notice 在
fallback 下说的是同一件事，不是另一套。

**提示模型的部分**是输出末尾的一条 notice（`details.fallback = true`）：
"ripgrep (rg) was not found, so this search used a slower in-process walker
with the same ignore rules. Call grep normally; install ripgrep to make
searches faster"。写"照常调用"是因为错误的替代方案是模型自己去拼
`find | xargs grep`，那会绕开 ignore 规则和截断。没有匹配时也带这条 notice，
否则最需要知道降级的场景（搜不到东西）恰好是唯一不说的场景。

## Alternatives considered

**把 ripgrep 编进进程**（omp 的 `pi-natives` 路线）。正确，但 nanopi 是单文件
分发 + 6 平台 × 双 AVX2，为此背 8 万行 Rust 不成立。

**只把错误信息改清楚**（告诉用户 `pkg install ripgrep`）。成本近乎零，但
`NANOPI_OFFLINE=1` 的用户明确表示不要网络，换不来工具可用。

**spawn 系统 `grep` / `find` 兜底**。这两个命令到处都有，但语义差得远：
系统 `grep` 不认 `.gitignore`，`-r` 会跟进符号链接，`--include` 与 rg 的
`--glob` 不是一回事，输出格式也没法对齐行号。要么重写一遍解析，要么让工具
契约随 PATH 上的实现漂移。

**在 walker 里也实现 `--hidden` 之外的其他 rg 选项**（`-uu`、`--no-ignore` 等）。
现在没有调用方，加开关等于给一个慢路径堆参数面。

## Consequences

- 降级路径是纯 JS：比 rg 慢一个数量级，且一次只跑一个文件的匹配。大仓库上
  明显，但正确性不打折——`limit`、ignore、truncation 行为一致。
- `GrepToolDetails` / `FindToolDetails` 多了一个可选 `fallback`，渲染层目前
  没读它：notice 已经在文本里，TUI 再标一次是重复。
- `docs/environment-variables.md` 和 `docs/containerization.md` 不再暗示镜像
  必须带 ripgrep 才能用只读工具。
- 回归测试在 `test/tools.test.ts`（`grep tool without ripgrep` /
  `find tool without fd`，靠 spy `ensureTool` 强制走降级路径，因为 CI 镜像
  预装了真实二进制）和 `test/fallback-walker.test.ts`（嵌套规则、negation、
  符号链接、提前停止）。

# Agent Note: find 的进程内回退按 fd 的 --full-path 展开匹配

Status: implemented

## Problem

`find` 有两条执行路径：有 fd 时走 `fd --glob --full-path`，没有 fd 时走
`fallback-walker.ts` 的进程内遍历。两条路径对"带斜杠的 pattern"匹配的字符串不同：

- fd 侧 `--full-path` 把 pattern 拿去匹配**绝对候选路径**，所以 `find.ts`
  的 `--full-path` 分支给不以 `/`、`**/` 开头、也不等于 `**` 的 pattern 补一个
  `**/` 前缀（`src/*.ts` → `**/src/*.ts`）。
- 回退侧 `compileFindGlob` 把 pattern 拿去匹配**相对搜索根的路径**。这里不补前缀是
  对的（`src/*.ts` 对 `src/direct.ts` 直接成立），但补了 `**/` 前缀的锚定逻辑没有和
  fd 侧对齐，`src/` 这类**搜索根直属**的目录因此在两条路径下命中集合不同。

后果是同一个 pattern 在 fd 缺失的机器上少给结果。`src/*.ts` 在回退路径下只会命中
根直属的 `src/*.ts`，`deep/src/*.ts` 和更深的同名目录一起消失——而 fd 路径会把它们
全部返回。这类差异比 `limit: 0` 更隐蔽：输出看起来完全正常，只是少了几行，
模型不会怀疑。

## Decision

回退侧的锚定规则和 fd 侧的 `--full-path` 前缀规则逐字对齐，包括"根`/`要不要剥"：

```ts
const rooted = normalized.startsWith("/") ? normalized.slice(1) : normalized;
const anchored = rooted.startsWith("**/") || rooted === "**" ? rooted : `**/${rooted}`;
```

匹配的候选是 `relativeToRoot(searchPath, filePath)`。`src/*.ts` 变成
`**/src/*.ts`，`minimatch` 下 `**` 匹配零到多层目录，所以搜索根自身那层
`src/` 和任意深度的 `src/` 一起命中——正是绝对路径匹配在 fd 里得到的结果。

无斜杠的 pattern 分支不动：fd `--glob` 默认按 basename 匹配，回退侧按
`path.basename` 匹配，两边本来就一致。

## Alternatives considered

**把回退侧改成拼绝对的 `searchPath` 再匹配（真正复刻 `--full-path`）。**
理论上最忠实，但把搜索根的绝对路径卷进 glob，Windows 的盘符和分隔符、pattern 里
用户自己写的 `/` 都要额外转义，`minimatch` 还得开 `windowsPathsNoEscape`。
补 `**/` 前缀在相对路径上得到同一个命中集合，成本低一个量级。

**回退侧保持现状，只在文档里写明"两种路径结果可能不同"。**
等于把差异变成契约。fd 是否安装取决于环境（离线模式、CI 镜像、Termux），
同一条命令在不同机器给出不同答案是难排查的那类 bug，不值得为了省三行代码留着。

**抽一个 `fdFullPathPattern(pattern)` 给两侧共用。**
两侧的输入语义不同（绝对候选 vs 相对候选），共用函数要么返回前缀后的 pattern
（回退侧还得再改），要么返回布尔（省不下什么）。规则只有三行，各自内联更清楚。

## Consequences

- 回退路径的命中集合向 fd 靠拢；`src/**/*.ts`、`src/*.ts`、`**/src/**/*.ts`、
  `**/*.ts`、`*.ts`、`src/**`、`deep/src/*.ts` 七个 pattern 两条路径输出完全一致。
- `pattern` 以 `/` 开头时剥掉前导斜杠：相对候选路径不可能以 `/` 开头，剥掉和不剥
  在没有 `**/` 前缀语义下等价，剥掉只是让锚定规则在两侧读起来一样。
- 回归测试在 `packages/coding-agent/test/tools.test.ts`（`find tool without fd`
  里的 `root-level path pattern`）：断言 `src/*.ts` 同时命中根直属与深层同名目录。
  把 `compileFindGlob` 回退成旧的 `/**` 锚定写法，这条测试失败。

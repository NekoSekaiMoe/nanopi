# Agent Note: CNB NPC 流水线的 git hooks 与 2c4g 资源规格

Status: implemented

## Problem

CNB 上的提交长期没有 `Change-Id`，此前的排查把它归为「平台不支持」。
实际原因在环境本身：husky 只在 `pnpm prepare` 里执行，而 NPC 容器（`cnbcool/default-npc:latest`）
里既没装依赖也没跑过 prepare，`core.hooksPath` 为空，hook 解析到 `.git/hooks`，
那里只有 `*.sample`。`.husky/commit-msg` 在这类环境里从未执行，因此
`Change-Id` / `Signed-off-by` 都不会被注入——与 CNB 平台本身无关，本地 clone
不装依赖时同样如此。

同时，NPC 流水线没有在 `.cnb.yml` 里声明 runner，走平台默认分配（amd64 默认 8c16g），
对一个只做 agent 对话 + git 操作的容器是浪费。

## Decision

`.cnb.yml` 增加 `$:` 下的 NPC 事件流水线（`issue.comment@npc` 与
`pull_request.comment@npc` 各一份），两处都：

- `runner.cpus: 2` —— 即 2c4g（内存 = 核数 x 2GiB）。不指定 tags，沿用默认架构节点。
- `docker.image: cnbcool/default-npc:latest`，显式写出以贴近系统默认配置。
- `npc:go` 之前插入 `install git hooks` stage：`pnpm install --frozen-lockfile`
  后接 `pnpm prepare`。必须用不带 `--ignore-scripts` 的安装，否则根 `prepare`
  （`husky`）同样被跳过，回到原问题。`pnpm exec husky` 只设置
  `core.hooksPath=.husky/_`；`.husky/commit-msg` 与 `.husky/pre-commit` 都不 source
  `husky.sh`，所以 hook 一旦挂上就按仓库现有脚本执行。

`main.push` 的 `mirror-to-github` 已经是 `cpus: 2`，未改动。

## Alternatives considered

- **只 `git config core.hooksPath .husky`，跳过依赖安装**：不需要 node_modules 就能
  让 `commit-msg` 生效，但同一目录下的 `pre-commit` 会一起激活，而它执行
  `pnpm run check`，没有依赖时必然失败并拦住 agent 的提交。要么装依赖，要么削弱
  pre-commit，后者等于擅自放宽已有的门禁。
- **在流水线里 `git filter-branch` / 重写历史补齐 Change-Id**：平台没有改 commit
  message 的接口，且会破坏 GitHub 镜像的 fast-forward（PR #2 刚去掉 force push），
  对 6900+ 个既有提交只覆盖 0.8%，属于重写历史。
- **改用自托管 runner 拿固定的 2c4g 规格**：需要组织级 runner 接入，改动面远大于
  一次 `cpus` 声明。
- **保持不声明 runner，靠平台默认分配**：默认 amd64 节点是 8c16g，NPC 场景用不上。

## Consequences

- NPC 提交从此带上 `Change-Id`（`.husky/commit-msg` 是 Gerrit 3.13.1 原版，对
  已有 `Signed-off-by` 的提交会把 `Change-Id` 插在其前，不改写其他 trailer；
  `squash!` / `fixup!` 开头的提交被跳过，符合预期）。
- 代价：每次 NPC 会话都要跑一遍 `pnpm install`（monorepo，上百 MB），
  且 `pre-commit` 会在每次 agent 提交时执行 `pnpm run check`（biome + tsc +
  browser smoke），在 2c4g 上耗时明显。当前接受，因为这是仓库对本地提交的既有要求；
  若太慢，可考虑给 NPC 事件单独放宽 pre-commit，但那是另一个决定。
- `install git hooks` stage 失败会让整条 NPC 流水线中断（不会静默退回无 hook 状态）。
  若 `cnbcool/default-npc:latest` 里没有 `pnpm`，第一次触发即可看到明确报错。
- 与 [buildconfig-gated builtin sidecars](2026-10-11-sidecar-builtins.md) 无关；
  此处只动流水线资源与 hook 注入。

## Update 2026-11-06 (#542): 核时口径与 Job 超时

`cpus: 2` 已在 `aa3c286e0` 落地，但当时只说「用不上 8c16g」，没说它是账单口径：
NPC 事件按**云原生开发**用量计费（1600 核时/月的免费额度），同一个会话在 8c16g
上就是 4 倍核时。所以这两条流水线的 `cpus` 不是性能参数，是花钱开关，改它前先看
[定价](https://docs.cnb.cool/zh/pricing.md)。

同一处补两件当时漏掉的事：

- `runner.tags: cnb:arch:amd64` —— 原先只写 `cpus: 2`，落在默认标签 `cnb:arch:default`
  上。默认架构哪天变了，「2 核」的意图就没了依据，也看不出是哪天变的。显式写死，
  与 `main.push` 的 `mirror-to-github` 一致。
- Job 级 `timeout` 的取舍，详见下一节。

## Update 2026-11-06 (#544): 撤掉 Job 级 timeout

上一版写了 `timeout: 6h`，想用「Job 跑满 6h 就停」来限制会话时长，这个理解是错的。
`npc:go` 的 `timeout` 只作用于 **agent 的每一次工具执行**（单次超时与连续无输出），
会话整体时长受流水线超时（20h）约束，Job 的 `timeout` 管不到它。

于是 6h 的实际效果只有两个，都不好：

1. 单次工具执行和**无输出阈值都放宽到 6h**，agent 卡死时 2c4g 要空转到 6h
   才释放（12 核时），比默认的 10 分钟无输出宽松 36 倍。
2. 它在**声明的那一刻就没法只改一半**：平台的 `timeout` 同时是 Job 最长执行时间，
   而 NPC 会话就挂在这个 Job 里，所以任何小于会话时长的值都可能把会话掐断
   （1h 版就是这么伤到 `pre-commit` 的 `pnpm run check` 的）。

现在的做法：两条 NPC 流水线都**不声明** Job 级 `timeout`，回到平台默认——
单次工具执行最长 2h、连续无输出 10 分钟。会话想跑多久就跑多久，上限是平台
20h 的流水线超时。「别冻配额」这件事交给无输出超时兜，而不是靠 Job 时长。

代价要记清楚：`pre-commit` 跑 `pnpm run check`，在 2c4g 上如果连续 10 分钟不吐一个字，
这步会被判定无输出超时而中断。这是默认值，不是本仓库引入的；真要放宽，
只能先确认有没有「只改无输出阈值、不动 Job 最长时长」的入口，平台的 Job
`timeout` 做不到，改回来就等于重新背上上面第 2 条的副作用。

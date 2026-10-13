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

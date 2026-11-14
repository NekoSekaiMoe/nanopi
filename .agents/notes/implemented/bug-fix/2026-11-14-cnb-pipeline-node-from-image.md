# Agent Note: CNB 流水线的 node 一律取自 node:24 镜像，不再 apt 装

Status: implemented

## Problem

`cnb-knt-1k7c8jnjn`（main 的 push，mirror-to-github 流水线）红在第一个 stage：

```
Get:7 node-acorn ... / Get:8 node-cjs-module-lexer ... 404 Not Found
E: Failed to fetch https://mirrors.cloud.tencent.com/debian/pool/main/n/
   node-cjs-module-lexer/node-cjs-module-lexer_1.2.3%2bdfsg-1_all.deb  404  Not Found
E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?
sh: line 3: node: command not found
Finished, code: 127, duration: 35.5s
```

两件事叠在一起：默认构建镜像里没有 node，所以每个 stage 现用
`apt-get update && apt-get install nodejs -y` 装；而 Debian 镜像源对某个依赖包返回
404（同一份 `Packages` 索引里还列着它），apt 整体失败，`set -e` 让整条 stage 以 127
结束。同一次构建的 `report-failure` 钩子（endStages）也栽在同一个 apt 上，返回 100
——`allowFailure: true` 让它没改掉构建结论，但那次失败谁都上报不了。

这不是「镜像源抖一下」。三个结构性问题各自都会让流水线红：

1. **apt 装的 node 版本不对。** `trixie` 的 `nodejs` 是 20.19.2，而仓库的
   `engines.node` 是 `>=24.0.0`（见 [node 24 floor](../process/2026-10-27-node-24-floor.md)）。
   `pnpm install -g pnpm` 在这一套装得上也只是勉强，npm 自己会警告
   `cli npm v12.2.2 does not support Node.js v20.19.2`。
2. **apt 装的 node 没有类型剥离**，`process.features.typescript === false`，
   笔记门禁那三条 `.ts` 校验脚本跑不了——`.cnb.yml` 里已经为此给
   `verify-agent-notes` 单独指了 `node:24` 镜像，同一份配置里两套 node 来源并存。
3. **每次构建都要重装一次 node。** 一条 push 流水线三个 stage 各
   `apt-get update` 一遍（10 MB 索引 + 30 MB 包），在 2c4g 上是纯等待；而且这把
   构建的可用性押在了第三方镜像源上。

## Decision

**`.cnb.yml` 里凡是跑 node 脚本的流水线，都用 `docker.image: node:24`；stage 里
不再 `apt-get install nodejs`。**

- `main.push` 的 `mirror-to-github`：pipeline 级 `docker: { image: node:24 }`，
  `check-commit-trailers`、`mirror main and tags` 两个 stage 去掉 apt。
- `main.pull_request.target` 的 `merge-result`：同上；`verify-agent-notes` 去掉自己
  那份 `image: node:24`（现在整条流水线都是它）。
- `x-notify-failure`（endStages 钩子）：`image: node:24`，只留
  `npm install -g @cnbcool/cnb-cli`。
- 这些 stage 的 `set -euo pipefail` 一律降成 `set -eu`：`node:24` 的 `/bin/sh` 是
  dash，不认 `pipefail`，脚本会以 `Illegal option -o pipefail` 当场退出
  （`cnb-68q-1k7c6nhcs` 的 `verify-agent-notes` 就是这么「接了门禁但从未跑过」的）。
  这些脚本里没有管道，`set -eu` 就是全部需要的语义。

`node:24` 的 tag 不 pin patch：它是 CI 运行时，不是产物输入，跟着 minor 走即可；
`Dockerfile` 与 workflow 的 `24.22.2` 决定的是发布产物和 GitHub 侧验证面，不受影响。

镜像换了但 git 不受影响：CNB 的 git 凭据来自 `/etc/gitconfig` 里的
`credential.helper=store --file=/workspace/.git/.git-credentials`，
是 runner 按仓库注入的，跟容器里装没装 node 无关。实测在 `node:24` 里
`git fetch origin` 照常成功，`mirror main and tags` 那一步的跨仓 fetch 也不受影响。

## Alternatives considered

**继续 apt 装，加 `--fix-missing` 或重试。** 治不了根：404 说明那份索引与仓库内容
不一致，`--fix-missing` 只会跳过缺的包、留下一个装不全的 node；重试要等镜像源自己
修好。而且 apt 装到的 node 20 依然不满足 `engines.node`、依然没有类型剥离。

**换 `mirrors.tencent.com` 之外的 apt 源。** 只是把同一个赌注押到另一个第三方上，
问题 1 和问题 3 一分未解。

**用 `docker.build` 加本地 Dockerfile，把 node 与 cnb-cli 一起预烤。** 每次改动
Dockerfile 才重建，确实更快，但为装一个 CLI 维护一份镜像（还要接到制品库）不划算；
`node:24` 是官方镜像，拉取本来就有节点缓存。

**把 `node:24` pin 成 `node:24.22.2`。** 与 `Dockerfile`、workflow 的 `node-version`
对齐看着整齐，但那三处的用途是「验证发布产物在声明的运行时上可用」，CI 的运行时
跟着 patch 走反而能更早发现 patch 级回归。真要统一应该反过来改发布面，那是另一个决定。

**只修 `check-commit-trailers` 一个 stage。** 三个 stage 加 endStages 是同一份 apt
命令抄了四遍，只修一处就是等着下一份抄错。

## Consequences

- 流水线少装一次 node：一条 push 构建大约省 3×40s 的 apt 时间，也不再依赖
  Debian 镜像源对该仓库的可用性。
- `report-failure` 钩子从此跑在 node 24 上，不会再因为 node 20 装不上而静默失效。
  这次失败本来就是它上报的素材，它自己也红了，等于没人接手。
- 所有 CNB 侧 stage 的脚本只能用 `set -eu`。`pipefail` 在 dash 下不可用，写上去
  就是当场退出；需要管道的脚本得显式 `bash -c` 或改写成 node 脚本（仓库对 shell
  脚本的既有偏好是后者，见 [shell scripts to node](../process/2026-10-18-shell-scripts-to-node.md)）。
- `node:24` 镜像里没有 `apt` 装不到的东西也少了：现在 stage 里能直接用的只有
  node/npm/git 与镜像自带工具，需要别的就换镜像或单独指 `image`。
- `verify-agent-notes` 不再单独声明镜像，它与同流水线其他 stage 共享运行时；将来
  若这条流水线换掉 `docker.image`，笔记门禁会跟着失去类型剥离能力，届时
  `scripts/verify-agent-notes.mjs` 的 `typescriptArguments()` 会报出
  「需要一个能剥类型的 node」，不会静默跳过。

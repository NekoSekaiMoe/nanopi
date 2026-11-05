# Agent Note: bundle 发到 AtomGit 的发行仓库

Status: implemented

## Problem

发布产物只有 GitHub 一条出口：`build-binaries.yml` 在 tag 上产
`nanopi.js`/`nanopi-base.js`/`nanopi-minimal.js`/`SHA256SUMS` 并开 GitHub Release，
`nightly.yml` 每天重建一次 bundle 但只把包发到 GitHub Packages、镜像发到 GHCR，
bundle 本身不上任何 registry。国内用户下载要过 GitHub Releases，慢或者根本不通；
仓库的源码在 AtomGit（`atomgit.com/NanoPi/NanoPi`）上有镜像，但镜像里没有产物，
「国内镜像与下载」这句话就没有下半截（#481）。

平台侧要先说清楚，因为它决定了通知链：**AtomGit 的 Release 没有可用的免登录 API**
（`/api/v5/repos/<slug>/releases` 匿名读返 `[]`，带 `private-token` 才能读），也没有
能上传 Release 附件的内置任务。所以「发到 AtomGit」只能是把文件放进一个 git 仓库，
走 raw 链接下载。

## Decision

发行仓库是 `atomgit.com/nanopi/releases-assets`，布局是「一次发布一个目录 + 一份
主分支 README」：

```
README.md                       # 当前指向哪个 tag，下载与校验命令
assets/<tag>/nanopi.js
assets/<tag>/nanopi-base.js
assets/<tag>/nanopi-minimal.js
assets/<tag>/SHA256SUMS
assets/<tag>/RELEASE_NOTES.md   # 正式版是 release-notes.mjs 的产物
assets/<tag>/nanopi-<version>-source.tar.gz   # 只有正式版
```

资产名与 GitHub Release 逐字相同，换源不改文件名，`install.js --sku` 才有意义。
`SHA256SUMS` 由脚本按要发的文件现算，格式就是 `sha256sum -c` 认的那一种。

`scripts/publish-atomgit.mjs` 是唯一的写入方：它在一个临时 checkout 里组装目录、
写 README 与 SHA256SUMS、提交、`tag -f`、推送。两条约束写死在脚本里：

- **只推 tag，不推 main（正式版）**。补发历史版本时主分支不能退回去：README 说
  「当前是哪个 tag」，主分支只跟着最新一次发布走。
- **tag 可以 force 移动**。nightly 当天重跑、正式版手动补发都落在同一个 tag 名上，
  这个 tag 是「这个版本现在长什么样」，不是历史记录；历史在提交里。

nightly 与正式版都由 `.cnb.yml` 里的 `x-atomgit-release` 锚点跑，`main` 下的
`crontab: 0 16 * * *`（Asia/Shanghai，对应 GitHub 那次 00:00 UTC）发 `nightly`，
`$` 下的 `tag_push` 用 `CNB_BRANCH` 发正式版。两条都自己构建：正式版的产物流在
GitHub 上，tag 被 mirror 带回 CNB 时只有源码树。三个口味共用一次
`pnpm install` + `build:offline`，只有 bundle 那一步看 `NANOPI_BUILD_FLAVOR`。

读取侧是 raw 链接，没有 API、不用登录：

```
https://atomgit.com/nanopi/releases-assets/raw/main/nightly/nanopi.js
https://atomgit.com/nanopi/releases-assets/raw/main/nightly/SHA256SUMS
```

`install.js --mirror=<该目录的 URL>` 就是为这条路径加的：镜像不解析 `latest`，
所以 tag 写在 URL 里，`--version` 在给了 `--mirror` 时被忽略。

正式版的 GitHub Release 仍由 `build-binaries.yml` 产出。CNB 的 `tag_push` 在发完
AtomGit 之后用 `GH_KEY` 跑一次 `gh workflow run build-binaries.yml -f tag=<tag>`：
tag 已经存在（触发要求 tag 先存在，`--ref main` 只提供工作流文件），被推迟的只是
「有人去点一下」。GitHub 那边的 `nightly.yml` 不在这次改动里，nightly 的 bundle
只在 AtomGit 上。

## Alternatives considered

- **用 AtomGit Release 附件**：语义最正，但匿名 API 读不到 release 列表，创建/上传
  附件也没有 CNB 侧可用的内置任务或插件；能走的只有页面手点。那不是一个每天自动
  跑的东西。
- **把 bundle 塞进源码镜像仓的 `dev` 分支**：`atomgit.com/NanoPi/NanoPi` 已经在镜像
  源码，`git clone` 就能拿到。但每天一个 10 MiB 的 blob 会把国内用户的 clone 越拖
  越慢，而且 `install.js` 要的是单个文件的 raw 链接，与源码树的更新节奏无关。
- **资产放在 `nightly/`、`v20261031.1.0/` 两个固定目录，tag 只做标记**：主分支上要
  同时维护两份目录，旧文件还得自己删。tag 本身就能当目录名，一份布局省掉一套清理。
- **在 GitHub 侧（`nightly.yml` / `build-binaries.yml`）直接推 AtomGit**：产物在
  GitHub 上，只有一步之遥。但那要求 CNB 的 `CNB_KEY` 反向进 GitHub 的 secret 库，
  而且 CNB 侧的 `tag_push` 本来就要存在（nightly 在 CNB 上），两套触发只会让「这次
  发布到底谁写的发行仓库」更难追。
- **正式版也从 CNB 侧构建并跳过 `build-binaries.yml`**：等于把发布流程搬到 CNB，
  tag、Release、npm、GHCR 全在 GitHub 那一侧，搬一半比不搬更糟。
- **把 nightly 的 bundle 也挂 GitHub Release（`nightly` tag）**：可变引用去改一个
  已发布的 Release，与 `build-binaries.yml` 里「已发布的 Release 拒绝被改动」的约定
  冲突。

## Consequences

- 国内下载路径存在了，代价是每次发布多一份约 15 MiB 的存储（三个口味）和一次构建。
  正式版因此在 GitHub 与 CNB 各构建一次，两份产物同为 tag 上那个提交的构建结果；
  换掉其中任何一条都等于改发布流程，不在这次改动范围内。
- 发行仓库的写权限来自密钥仓库 `shinytale/keys` 的 `ATOMGIT_KEY`
  （`.cnb.yml` 的 `imports` 注入），token 由 `.cnb.yml` 的
  `--token-env ATOMGIT_KEY` 指给脚本，走 `GIT_ASKPASS`，不进 argv、不进
  `.git-credentials`。
- `--token-env` 是 `--push` 的必需参数，不是可选项：脚本不猜凭据躺在哪个环境变量
  里。少了它直接报错，因为一个「没带 token 的 push」不会立刻失败——`GIT_TERMINAL_PROMPT=0`
  把它变成 git 的 `could not read Username`，看起来像 URL 写错了——失败点离「少传了
  一个参数」太远。凭据的名字放在 `.cnb.yml` 里也更好查：换密钥库里的变量名时，
  改的是看得见的那一行。
- **cron 不随代码生效**：只有「本次推送的变更包含 `.cnb.yml`」才会自动同步定时任务。
  这条改动合进 main 时刚好满足，但以后单独改 cron 表达式要记得去
  「云原生构建 → 定时任务」点一次同步。
- 发行仓库的 `main` 只留最新一份；要旧版本走 tag（`assets/<tag>/`）或源码镜像仓。
- 验证：`node --test scripts/publish-atomgit.test.mjs`（四条：nightly 三个口味 +
  checksums + tag 移动、正式版带源码包与原始 release notes、缺口味直接报错、不带
  `--push` 不上传）。本地用 `file://` bare 仓库跑过整条链路；真机推送（AtomGit
  HTTPS + token）只能靠第一次流水线确认。

Related: [Single-file nanopi.js release artifact](2026-10-11-single-file-release-artifact.md)
（产物集与 sidecar 清单）、[Tag 镜像与 main 分开处理](2026-10-16-tag-mirroring-between-github-and-cnb.md)
（正式版的 tag 怎么到 CNB）、[镜像凭据由 scripts/mirror.mjs 自己落盘](2026-10-27-mirror-credential-in-script.md)
（同一套「凭据不进 argv」的写法）。

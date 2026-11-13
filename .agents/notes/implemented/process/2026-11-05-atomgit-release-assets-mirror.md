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
README.md                       # 当前指向哪个目录，下载与校验命令
v20261114.0.0/nanopi.js
v20261114.0.0/nanopi-base.js
v20261114.0.0/nanopi-minimal.js
v20261114.0.0/SHA256SUMS
v20261114.0.0/RELEASE_NOTES.md                # 正式版是 release-notes.mjs 的产物
v20261114.0.0/nanopi-20261114-source.tar.gz   # 只有正式版
nightly/…                                     # nightly 的同一组文件
```

目录名不是 tag，是 bundle 里烘焙的那一段 URL：正式版写的是
`v<package version>`（`v20261114.0.0`，跟着 lockstep 的 `.0.0`），nightly 写的是
`nightly`（见 `atomgitSidecarTarballUrls`）。发布目录必须与它逐字相同，否则 bundle
第一次下载 sidecar 就 404。早先发布把文件平铺在 `assets/` 下，两份 URL 都与它对
不上；脚本现在见到 `assets/` 会清掉。

资产名与 GitHub Release 逐字相同，换源不改文件名，`install.js --sku` 才有意义。
`SHA256SUMS` 由脚本按要发的文件现算，格式就是 `sha256sum -c` 认的那一种。

`scripts/publish-atomgit.mjs` 是唯一的写入方：它在一个临时 checkout 里组装目录、
写 README 与 SHA256SUMS、提交、`tag -f`、推送。两条约束写死在脚本里：

- **主分支快进到最新一次发布，tag 跟着指过去**。README 说「当前是哪个版本」，
  主分支只跟着最新一次发布走；补发历史版本时它以一次新提交盖在上面，不回退。
- **tag 可以 force 移动**。nightly 当天重跑、正式版手动补发都落在同一个 tag 名上，
  这个 tag 是「这个版本现在长什么样」，不是历史记录；历史在提交里。
- **临时 checkout 从远端 main 起步**。脚本先 `ls-remote` 看远端有没有 main，有就
  `fetch` + `reset --hard FETCH_HEAD`，没有才把这次提交当成第一个。早先用空
  `git init` 起步，本地是根提交、与远端毫无关系，所以**除了仓库的第一次发布，之后
  每次推送都被拒绝成 non-fast-forward**：GitHub Release 正常，AtomGit 却停在上一版。

**发布在 GitHub Actions 里跑，不在 CNB 上。** 产物本来就在 GitHub 那边产：
nightly 的 bundle 由 `nightly.yml` 的 `build` job 构建，正式版的三个口味由
`build-binaries.yml` 的 `build` job 构建并在 `stage-github-release` 里校验过。
两条流水线各加一个 `publish-atomgit` job，把已有的 artifact 交给
`scripts/publish-atomgit.mjs`（`actions/download-artifact` → `--input release-assets`），
不再有第二次构建，也就不会出现「GitHub Release 上的包和 AtomGit 上的包不是同一次
构建」这种没人查得出来的偏差。

CNB 上没有任何发布触发。曾经有一条 `crontab: 0 16 * * *` 跑 `x-atomgit-nightly`
兜底 GitHub 的 schedule，已去掉（#497）：它在 CNB 上把同一批 bundle 重新构建一遍，
只为了一个「GitHub 那边可能不跑了」的假设，代价是每天一次双份构建和一条天天报错的
定时任务。正式版同样没有对应的触发（原来的 `tag_push` 与 `web_trigger` 已删）：那需要
在 CNB 上重新构建一遍，只会多一份可能与 GitHub Release 不一致的包。

`--commit <sha>` 是必需参数，写进 README 的 `Current:` 那行和 nightly 的 release
notes：只写「nightly」回答不了「国内下载到的是哪个提交」，而这个仓库里
`nightly.yml` 的 cron 可能已经停了好几天。

读取侧是 raw 链接，没有 API、不用登录：

```
https://atomgit.com/nanopi/releases-assets/raw/main/nightly/nanopi.js
https://atomgit.com/nanopi/releases-assets/raw/main/nightly/SHA256SUMS
```

`install.js --mirror=<该目录的 URL>` 就是为这条路径加的：镜像不解析 `latest`，
所以 tag 写在 URL 里，`--version` 在给了 `--mirror` 时被忽略。

正式版的 GitHub Release 与 AtomGit 是同一个 job 的两步：`build-binaries.yml` 在
`stage-github-release` 之后、公开 Release 之前发 AtomGit。AtomGit 那一步失败会让
这条流水线失败，`cleanup-draft-github-release` 随之删掉草稿 Release——国内下载路径
和 GitHub Release 一起停，不会留下一个「发了一半」的版本。

## Alternatives considered

- **用 AtomGit Release 附件**：语义最正，但匿名 API 读不到 release 列表，创建/上传
  附件也没有 CNB 侧可用的内置任务或插件；能走的只有页面手点。那不是一个每天自动
  跑的东西。
- **把 bundle 塞进源码镜像仓的 `dev` 分支**：`atomgit.com/NanoPi/NanoPi` 已经在镜像
  源码，`git clone` 就能拿到。但每天一个 10 MiB 的 blob 会把国内用户的 clone 越拖
  越慢，而且 `install.js` 要的是单个文件的 raw 链接，与源码树的更新节奏无关。
- **资产放在 `nightly/`、`v20261031.1.0/` 两个固定目录，tag 只做标记**：主分支上要
  同时维护两份目录，旧文件还得自己删。tag 本身就能当目录名，一份布局省掉一套清理。
- **放在 CNB 上跑（`tag_push` + CNB 的 crontab）**：第一版就是这么做的，实测下来
  两个问题。一是同一次发布构建两遍：正式版在 `build-binaries.yml` 里已经构建并校验
  过，CNB 又用同一棵源码树构建一次，两份产物只要有一分不同，AtomGit 与 GitHub
  Release 就对不上，而没有任何东西会发现；二是 CNB 的 `tag_push` 依赖 tag 被
  `sync-to-cnb` 镜像回来，链路比「tag 就在 GitHub 上打」长一环。当时留在 CNB 的只剩
  nightly 的兜底 cron，那一份后来也被证明是同一类双份构建，一并去掉（#497）。
- **nightly 也发 GitHub Release（`nightly` tag）**：可变引用去改一个已发布的
  Release，与 `build-binaries.yml` 里「已发布的 Release 拒绝被改动」的约定冲突。
- **把 nightly 的 bundle 也挂 GitHub Release（`nightly` tag）**：可变引用去改一个
  已发布的 Release，与 `build-binaries.yml` 里「已发布的 Release 拒绝被改动」的约定
  冲突。

## Consequences

- 国内下载路径存在了，代价是每次发布多一份约 15 MiB 的存储（三个口味）。产物不再
  构建两遍：两条流水线都复用自己 job 里已经校验过的 artifact。
- 发行仓库的写权限来自 `ATOMGIT_KEY`：现在只有 GitHub 侧用得上，存在仓库 secret 里
  （fork 上没有，所以那一步会跳过）。脚本仍要求 `--token-env` 指名变量，走
  `GIT_ASKPASS`，不进 argv、不进 `.git-credentials`。
- `--token-env` 是 `--push` 的必需参数，不是可选项：脚本不猜凭据躺在哪个环境变量
  里。少了它直接报错，因为一个「没带 token 的 push」不会立刻失败——`GIT_TERMINAL_PROMPT=0`
  把它变成 git 的 `could not read Username`，看起来像 URL 写错了——失败点离
  「少传了一个参数」太远。
- **GitHub 的 schedule 会静默停**：账户额度用尽或仓库 60 天没有活动时它就不跑了。
  `nightly.yml` 现在是 nightly 唯一的触发（CNB 的兜底 cron 已去掉，见 #497），所以
  停了就是停了：要补只能手动 `workflow_dispatch`，或者重新加一条兜底并接受双份构建。
- 发行仓库的 `main` 只留最新一份；要旧版本走 tag（`assets/<tag>/`）或源码镜像仓。
- 验证：`node --test scripts/publish-atomgit.test.mjs`（七条：nightly 三个口味 +
  checksums + tag 移动、正式版带源码包与原始 release notes、缺口味直接报错、
  缺 `--token-env`、`--token-env` 指向的变量为空、缺 `--commit`、不带 `--push`
  不上传）。本地用 `file://` bare 仓库跑过整条链路；真机推送（AtomGit HTTPS +
  token）与 GitHub / CNB 的触发只能靠第一次发布确认。

Related: [TUI sidecar tarball mirrored here](2026-11-06-tui-sidecar-mirror-and-prebuilds.md)
（同一批里还发 `nanopi-sidecars-<version>.tgz`）、[Single-file nanopi.js release artifact](2026-10-11-single-file-release-artifact.md)
（产物集与 sidecar 清单）、[Tag 镜像与 main 分开处理](2026-10-16-tag-mirroring-between-github-and-cnb.md)
（正式版的 tag 怎么到 CNB）、[镜像凭据由 scripts/mirror.mjs 自己落盘](2026-10-27-mirror-credential-in-script.md)
（同一套「凭据不进 argv」的写法）、[job 级 if 读不到 env/secrets](../bug-fix/2026-11-06-job-if-cannot-read-env-or-secrets.md)
（两条流水线的 publish-atomgit 为什么用 needs 输出当没配 key 时的闸门）。

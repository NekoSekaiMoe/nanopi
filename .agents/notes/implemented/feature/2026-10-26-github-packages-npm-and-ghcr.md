# Agent Note: 用 GitHub Packages 发 npm 包，用 GHCR 发容器镜像

Status: implemented — `build-binaries.yml` 在 tag 上多发两个渠道：`npm.pkg.github.com` 的 npm
包，`ghcr.io` 的镜像。GitHub Release 那条腿保持不变。

## Problem

分发现状只有 GitHub Release 一条腿：`nanopi.js` / `nanopi-base.js` / `nanopi-minimal.js`、
sidecars tarball、source archive、`install.js` 引导脚本。npm 发布在 2026-10 的流程重构里被整段
删掉，`@nanopi` 在公共 registry 上是 404。于是：

- `npm install -g @nanopi/pi-coding-agent` 装不上，而 `README.md` 和
  `packages/coding-agent/docs/containerization.md` 仍在教这条命令。
- 想在 Docker / CI 里跑 nanopi 的人得自己写 Dockerfile、自己装 node。

维护者要的是 GitHub 的两条包托管渠道（GitHub Packages 的 npm registry + 容器 registry），
文档即规格：

- `docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-npm-registry`
- `docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-container-registry`

按文档实现，换了 scope 名字和 consumer 那一步的代价，换掉了"没有渠道"这个更大的洞。

## 按文档得到的几个事实

这几条决定了实现形状，写下来省得下次重新查：

1. **npm 包名必须带 owner 前缀**：`package.json` 的 `name` 必须是 `@<owner>/<repo>` 或
   `@<owner>/<name>`，否则 `npm publish` 直接拒。所以发到 GitHub Packages 的 tarball 里，
   `@nanopi/pi-coding-agent` 这个名字不能用，得是 `@nekosekaimoe/nanopi`。
2. **scope 级的 registry 映射**：`.npmrc` 写 `@nekosekaimoe:registry=https://npm.pkg.github.com`。
   影响面是"`@nekosekaimoe` 这个 scope 只从 GitHub 装"，不是所有 npm 包。
3. **consumer 要 token**：GitHub 的 npm registry 不支持匿名读，公开包也一样。安装方得有
   `read:packages` 的 PAT（或本仓库 Actions 里的 `GITHUB_TOKEN`），写进 `.npmrc`。
4. **容器 registry 是 `ghcr.io`**，`docker.pkg.github.com` 已废弃。
5. **GH Packages 的 provenance 没写成支持**：npm 文档里 `npm publish --provenance` 只对公共
   registry 描述；GitHub 的 npm registry 文档对 provenance 只字未提。所以 GH Packages 侧的发布
   不带 `--provenance`（带了大概率被拒），provenance 留给日后回 npmjs。

## 实现

### npm 包：`publish-github-packages` job

- 跑在 `stage-github-release` 之后、`publish-github-release` 之前：包先上 registry，再删 draft
  release，这样发布流程中途失败时不会留下"release 公开了但装不上"的状态。
- 用 `scripts/make-github-package.mjs` 把 npm 包的产物重打包成 GitHub scope 下的名字：
  `packages/coding-agent/dist` 原样拷进 tarball，`package.json` 只改 `name`（改成
  `@nekosekaimoe/nanopi`）、去掉 `publishConfig.registry`，其余字段照抄。
  - 只发 `cli` 一个包：只有它的 `bin` 能给出 `nanopi` 命令。五个内部包各自的 `name` 也都得
    换成 GitHub scope，连 resolver 的 `@nanopi/pi-*` 字符串一起改，收益是零——用户装的是一个 CLI。
- `.npmrc` 用 `NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}` + `permissions: packages: write`，
  不需要额外 secret。仓库级的 `permissions: {}` 是默认，job 里显式给。
- 幂等：`npm view` 查到同名同版本就跳过，重跑 tag 不会炸。

### 镜像：`build-ghcr-image` job

- `Dockerfile` 在仓库根目录：`FROM node:24-bookworm-slim`，装 `git` / `ripgrep` / `bash` /
  `ca-certificates`（agent 的 bash/grep/find 工具靠它们），非 root 用户 `nanopi`，
  `ENTRYPOINT ["node", "/opt/nanopi/nanopi.js"]`。
- bundle 从构建 job 的 `release-assets` artifact 里取，不在镜像里重新构建：产物已经过 smoketest。
- tag 与 release tag 对齐；`latest` 只在 semver tag 上推，不把 `v20261023dev` 这类预发布盖上去。
- 只出 `full` 一套：`base`/`minimal` 的差异是 bundle 内部裁剪，镜像能提供的增量（node 运行时
  + git/ripgrep）对三者完全相同，三套 tag 只是把维护面乘三。
- 镜像跑在容器里，容器里的 prompt 会去找 `git`/`rg`，所以这里不能只塞 bundle。

### 文档

`packages/coding-agent/docs/containerization.md` 的 Dockerfile 示例改成基于
`ghcr.io/nekosekaimoe/nanopi`，并给 npm 的 GitHub-scope 命令和 `.npmrc` 前置配置。README 里的
`npm install -g @nanopi/pi-coding-agent` 换成 GitHub scope 名字 + 一行 `.npmrc` 说明。

## Alternatives considered

### 只记决策、不实现（本 PR 的初版）

初版是 rejected 笔记，理由是 scope 被锁死、consumer 要配 token、provenance 会丢，然后等维护者
回答三个问题。被否的理由是：这三条都不是"不能做"，是"做了有代价"。而没有渠道的代价更大——文档
教一条 404 的命令，容器用户得自己写 Dockerfile。把取舍写进文档 + 少发四个内部包，比继续等更划算。

### 用 PAT 喂 `NODE_AUTH_TOKEN` 绕开 npmjs 2FA

不采用，理由不变：这会把 `--provenance` 挡死，而 provenance 是"tarball 出自本仓库 CI"的唯一
凭据。但这条和 GitHub Packages 无关——GH Packages 本身就不提供 provenance（见上面事实 5），
所以这里不是"用 provenance 换发布按钮"，而是"这条渠道本来就没有 provenance"。日后回 npmjs 时，
`scripts/publish.mjs` 的 `--provenance` 写法原样可用。

### 五个内部包一起发 GitHub Packages

见"实现"第一条：internal 包是按源码路径映射的，改名要同时改 resolver 的 `@nanopi/pi-*` 字符串，
换来的只是让读源码的人能从 GH Packages 装到它们。不发。

### bundle 也从 GHCR 的 `base`/`minimal` 口味各出一套 tag

不采用：镜像的增量内容与口味无关，维护面乘三换不来新东西。

## Acceptance criteria

- tag 发布后 `docker run --rm ghcr.io/nekosekaimoe/nanopi:<tag> --version` 能出版本号。
- `.npmrc` 配好后 `npm install -g @nekosekaimoe/nanopi@<version>` 能装上并跑 `nanopi --version`。
- `docs/containerization.md` 与 README 里的安装命令与实际可用渠道一致。
- 发布仍是 `build-binaries.yml` 的一步，不在本地手工 `npm publish` / `docker push`。

## Risks

- `@nekosekaimoe` scope 一旦发到 GH Packages，就只属于这个 owner；日后想搬回 npmjs 只能换名
  （或者两个名字并存）。这是选 GitHub Packages 时接受的代价。
- 镜像多一条维护面：node 基础镜像的安全更新、tag 与 release tag 的对齐。因为只在 tag 上构建，
  基础镜像更新只在下次发版时进来。
- CNB ↔ GitHub 双向镜像下发布 workflow 只存在于 GitHub 侧，CNB 侧没有 tag 触发，所以两个新渠道
  也只能在 GitHub 侧发。

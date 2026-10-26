# Agent Note: GitHub Packages（npm registry + GHCR 镜像）作为分发渠道

Status: rejected — 走 GitHub Packages 的前提（维护者的 npm 2FA 永久不可解）没确认，且这条捷径会挡掉 npm provenance；先回 npmjs。

## Problem

分发现状只有一条腿：GitHub Release 上的 `nanopi.js` 单文件 bundle（`full` / `base` /
`minimal` 三个口味）、sidecars tarball、source archive 和 `install.js` 引导脚本。npm 发布在
2026-10 的流程重构里被整段删掉（`scripts/publish.mjs` 还在，但没有任何 workflow 调用；`@nanopi`
scope 在公共 registry 上 404）。没有容器镜像，仓库里也没有 Dockerfile。

于是三件事做不到：

- `npm install -g @nanopi/pi-coding-agent` 装不上（`packages/coding-agent/README.md` 和
  `docs/containerization.md` 仍在教这条命令）。
- 想在 Docker / CI 里跑 nanopi 的人，得自己写 Dockerfile、自己装 node。
- 每个发布点都得从 GitHub Release 拉，中国大陆网络下经常拉不动。

## Proposal

两条分发补位，都用 GitHub 的包托管：

1. **npm package** 发到 `npm.pkg.github.com`。`.npmrc` 里
   `@nanopi:registry=https://npm.pkg.github.com` + `//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}`，
   `publishConfig.registry` 固定，`permissions: packages: write` 就够了，不需要额外 secret。
2. **容器镜像** 发到 `ghcr.io/<owner>/nanopi`，tag 与 release tag 对齐。注意 GitHub 文档里
   "container registry → ghcr.io" 和 "Docker registry → docker.pkg.github.com"
   是两套东西，后者已废弃，按 ghcr.io 写。

## Alternatives considered

### GitHub Packages npm registry 直接接管现有 `scripts/publish.mjs`

最强论据是改动面最小：`scripts/publish.mjs` 已经在跑 `pnpm publish <tarball> --access public
--provenance`，只是没有 workflow 调用它；接进 `build-binaries.yml` 就完事。

否掉它的理由不是"麻烦"，是它把问题搬了个位置而不是解决：

- **名字仍然是 `@nanopi` 不是 `@NekoSekaiMoe`。** GitHub Packages 把整个 scope 映射到仓库
  owner 名下，`@nanopi/pi-coding-agent` 只可能落在 `NekoSekaiMoe` 的 package 页下。今天之所以
  不叫 `@nekosekaimoe/...`，是因为 GitHub 上 npm 包与 registry 已经解耦，npmjs 侧可以任意
  scope。发了 GH scope 之后，这个名字永远属于 GitHub，日后搬不回来。
- **安装方要额外配置 registry 和 token。** 从 GitHub Packages 装公开包一样要
  `~/.npmrc` 里挂 token（GitHub 的 registry 不支持匿名读），`npm install -g` 这条"一行装好"
  的招牌在文档里就要变成三段配置。
- **provenance 是硬门槛。** `--provenance` 走 sigstore 的公开透明日志，发布需要 OIDC；用
  `NODE_AUTH_TOKEN` / `npm_token` 这类 PAT 发布会被 provenance 校验挡下（npm 与 GitHub 的
  registry 一致）。要么放弃 provenance，要么把 workflow 的短时 token 通过 `.npmrc` 传进去。

### 用一次性 npm 自动化 token 喂 `NODE_AUTH_TOKEN`，绕开维护者的 npm 2FA

这是最容易想到也最危险的捷径。维护者提到"做不了 npm 2FA"，而 GitHub Packages 的
`NODE_AUTH_TOKEN` 通常被理解成"随便一个 PAT 就行"，看起来正好绕开。

不采用：这直接把 `--provenance` 挡死（上面的理由同样适用）。provenance 是"这个 tarball 确实
由这个仓库的这次 CI 构建出来"的唯一凭据；为了绕开一次 2FA 交互把它丢掉，等于用供应链安全换一个
发布按钮。

### 干脆连 npmjs 一起恢复（先确认维护者那边的实际阻碍）

如果维护者的 npm 2FA 只是"某次登录卡住"而不是"账号级别的永久障碍"，那 `scripts/publish.mjs`
+ `--provenance` + OIDC 的路径是现成的：`build-binaries.yml` 加一个 job，
`permissions: id-token: write`，`NODE_AUTH_TOKEN` 用 `secrets.NPM_TOKEN`（granular token，
勾 2FA bypass 但用途单一），`--provenance` 在 GitHub Actions 里自动生效。这条路能把"
`npm install -g` 装不上"和"scope 名字被锁"两个问题同时解决，不需要 GitHub Packages。

### GHCR 镜像作为独立渠道

镜像本身的价值不受 npm 路线影响：`FROM node:24-bookworm-slim` + 打好的 `nanopi.js`，比仓库
文档里 `npm install -g @nanopi/pi-coding-agent` 的 Dockerfile 更可靠（后者依赖 npm 包）。

但它的成本不在 Dockerfile，在"谁来更新"：

- 现成的发布产物已经是 `nanopi.js`，镜像只是把它塞进 `node:24-slim`；**镜像的唯一增量内容
  是"已经装好的 node + bundle + 非 root 用户 + git/ripgrep"**，这部分 `install.js` 一行
  `curl` 也能解决。
- 镜像要不要在 tag 时构建，取决于仓库双镜像（CNB ↔ GitHub）的 tag 镜像规则：tag 只在 GitHub
  侧打，`build-binaries.yml` 在 GitHub 侧跑，GHCR 推送可行；但如果镜像要同时从 CNB 拉，
  就得等 CNB 侧的 tag 镜像同步。

## Decision

两件都不在今天落地，按下面的顺序确认后再说：

1. 维护者的 npm 2FA 状态：能恢复 npmjs 发布吗？能 → 回 npmjs + provenance，不做 GitHub
   Packages npm。
2. 如果不能：接受 `@nanopi` 这个名字永久锁在 GitHub scope 吗？接受 → 做 GH Packages npm，
   配 provenance；不接受 → 只做 GHCR 镜像 + `install.js`，文档里的 `npm install -g` 删掉。
3. GHCR 镜像无论哪条路都值得做，但要先定镜像的内容边界（只装 bundle，还是带 git/ripgrep
   的开发镜像），以及它是否要跟随三个口味（`full` / `base` / `minimal` 三套 tag）。

## Acceptance criteria

- `docs/containerization.md` 与 `packages/coding-agent/README.md` 里的安装命令，与实际可用的
  渠道一致（现状是两者都在教一条 404 的命令）。
- 任一渠道落地后，发布流程是 `build-binaries.yml` 里的一步，不在本地手工 `pnpm publish`。
- 若采用 GitHub Packages npm，consumer 侧安装步骤要写清 registry + token 两段配置。

## Risks

- `@nanopi` scope 一旦发到 GitHub Packages，就永久绑定该 owner；日后想搬回 npmjs 只能换名。
- 镜像会让维护面多一条：node 基础镜像的安全更新、镜像 tag 与 release tag 的对齐。
- CNB ↔ GitHub 双向镜像下，发布 workflow 只在一侧存在（`build-binaries.yml` 只在 GitHub），
  任何"CNB 侧也能发"的设想都要先解决这个不对称。

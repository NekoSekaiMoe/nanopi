# Agent Note: Debian `Architecture: all` 打包接入正式发布与 nightly

Status: implemented

## Problem

nanopi 已经把主要运行时约束跟在 Debian testing 的 `nodejs` 上，但发行产物只有裸单文件 bundle、`install.js`、GitHub Packages npm 包和容器镜像，没有原生的 `.deb` 安装包，Debian/Ubuntu 用户无法通过 `apt`/`dpkg` 管理版本、升级和卸载，也拿不到标准包元数据（`nodejs (>= 24)` 依赖、`fd-find`/`ripgrep`/`git` 推荐关系）。

需要解决四个跨文件约束：

1. 单文件 `nanopi.js`（`full` 口味）在构建期已经内嵌所有 6 个平台的 `tui-native` prebuild 与通用 `photon_rs_bg.wasm`，并在首次启动按用户解压到 `~/.cache/nanopi/standalone/<version>` 和 `~/.nanopi/agent/bin`。如果打包时强行拆成 `amd64`/`arm64` 多个 `.deb`，只是把同一份文件打两遍。
2. 正式发布用 `v<YYYYMMDD>`（或 `v<YYYYMMDD>.1.0`）打 tag，nightly 每天在不变更仓库 `debian/changelog` 的情况下产出包；而 Debian 原生格式 `3.0 (native)` 不允许版本号带 `-` 修订号，且 nightly 必须在版本排序上严格大于刚发布的基础版本、小于下一次修订/日期版本。
3. CI 的 `build-binaries.yml` 与 `nightly.yml` 跑在 `ubuntu-latest`（Ubuntu 24.04，只有 `debhelper 13`），且 Node 24 由 `actions/setup-node` 装在 toolcache 里，不是通过 `apt` 的 `nodejs` 包安装的；不能在 runner 上跑 `dpkg -i`（会被缺少 `nodejs (>= 24)` 包拦截），也不能依赖 `debhelper-compat (= 14)`。
4. `nightly.yml` 不建 GitHub Release，它的公共下载通道只有 AtomGit 发行仓库；正式版与 nightly 的 `.deb` 必须走同一套校验和清单。

## Decision

新增仓库根目录 `debian/` 与构建脚本 `scripts/build-deb.mjs`，从正式发布（`build-binaries.yml`）和每日构建（`nightly.yml`）一起产出 `nanopi_<version>_all.deb` 并同步推送至 AtomGit（`scripts/publish-atomgit.mjs`）：

- **包布局与运行时**：`debian/control` 声明 `Architecture: all`、`Depends: ${misc:Depends}, nodejs (>= 24)`、`Recommends: ca-certificates, fd-find, git, ripgrep`、`Suggests: bubblewrap`，`Build-Depends: debhelper-compat (= 13)`（同时兼容 Debian Bookworm/Trixie/Forky 与 Ubuntu 24.04 runner）。`debian/rules` 把 `nanopi.js` 装到 `/usr/share/nanopi/nanopi.js`，通过 `override_dh_fixperms` 在 `dh_fixperms` 把 `*.js` 压成 `0644` 之后恢复其 `0755` 执行权限，并用相对软链 `/usr/bin/nanopi -> ../share/nanopi/nanopi.js` 暴露命令（实测 Node 24 沿真实路径解析 `.js` 扩展名执行 ESM，且 `resolveHostEntry()` 通过 `process.argv[1]` 拉起子代理无需额外 shell 垫片）。
- **构建入口与版本定标**：`debian/rules` 声明 `DEB_RULES_REQUIRES_ROOT ?= no` 与 `NEXT_TELEMETRY_DISABLED = 1`，支持 `NANOPI_DEB_BUNDLE` 复用 CI 已构建并冒烟测试过的 `nanopi.js`；未设置时检查工作区 `node_modules/.modules.yaml`、`packages/coding-agent/node_modules`、`node_modules/.bin/tsc` 与 `node_modules/esbuild` 是否已就绪，已安装时带 `--skip-install` 调用 `node scripts/build-single-file.mjs --offline-model-data --out debian/tmp-build`（避免 `sudo` / `sbuild` / 离线环境下 `pnpm install` 因 `HOME` store 路径不一致删掉现有 `node_modules` 或联网失败），否则走完整安装。`scripts/build-single-file.mjs` 与 `scripts/pnpm-command.mjs` 通过 `resolvePnpmCommand()` 依次探测可用 `PATH` 中的 `pnpm`、与当前 `node` 同目录的 `pnpm`、仓库 `node_modules/pnpm/bin/pnpm.mjs`、以及 Debian `node-corepack` 提供的 `corepack pnpm`（默认设 `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`），避免 `dpkg-buildpackage` / `debuild` / `sudo` 的精简 `PATH` 或断裂全局软链导致 `ENOENT`（退出码 `127`）。`scripts/build-deb.mjs` 在临时目录组装 `debian/` 与文档、按当次构建生成顶层 `debian/changelog` 项并以 `SOURCE_DATE_EPOCH` 调用 `dpkg-buildpackage -b -us -uc -d`（`-d` 跳过 `dpkg-checkbuilddeps` 对纯 C/C++ `build-essential` 工具链的要求，`dh` 仍要求 `debhelper`），保持工作区 `debian/changelog` 干净。版本映射：
  - 正式 tag：`v<YYYYMMDD>` → `<YYYYMMDD>.0.0`（如 `20261205.0.0`），`v<YYYYMMDD>.1.0` → `<YYYYMMDD>.1.0`，与 `package.json`、`nanopi --version` 和 AtomGit 目录名一致。
  - nightly：`<base>+nightly.<YYYYMMDD>`（如 `20261128.0.0+nightly.20261129`），满足 `dpkg --compare-versions` 的单调顺序 `20261128.0.0 < 20261128.0.0+nightly.20261129 < 20261128.1.0 < 20261205.0.0` 且符合 `3.0 (native)`。
- **CI 与分发契约**：
  - `build-binaries.yml` 的 `build` job 从源码压缩包解出的目录运行 `scripts/build-deb.mjs`，将 `nanopi_<version>_all.deb` 写入 `SHA256SUMS` 与 draft/public GitHub Release；`scripts/create-source-archive.mjs` 校验 `debian/` 与 `scripts/build-deb.mjs` 落在源码归档内。
  - `nightly.yml` 每天构建 `nanopi_<base>+nightly.<date>_all.deb` 并通过 artifact 交给 `publish-atomgit`。
  - `scripts/publish-atomgit.mjs` 要求输入目录恰好存在一个 `nanopi_*_all.deb`，将其写入对应目录、`SHA256SUMS`、nightly notes 和根 `README.md`。
  - 两个工作流的冒烟测试用 `dpkg-deb --info`、`dpkg-deb --contents` 与 `dpkg-deb -x` 解包后在独立 `HOME` 下运行 `/usr/bin/nanopi --version` 和 `--help`。

## Alternatives considered

- **把 `nanopi.js` 直接安装为 `/usr/bin/nanopi` 文件，不经 `/usr/share/nanopi/`**：少一个软链。否决：15+ MiB 的 JS 资产直接落在 `/usr/bin` 不符合 Debian 打包习惯，且失去 `.js` 扩展名后其它直接调用脚本的工具不易识别其文件类型；相对软链 `../share/nanopi/nanopi.js` 在 Debian 上是标准做法。
- **用 `dpkg-deb --build` 手拼控制目录，不加 `debian/` 与 `debhelper`**：不依赖 `debhelper` 也不受 `debian/changelog` 约束。否决：用户明确要求 `debian/` 文件夹；绕开 `dh` 会丢失标准文档压缩、权限修正、`md5sums`、`misc:Depends` 与 `dpkg-buildpackage` 本地直接构建能力。
- **用无版本号文件名 `nanopi-all.deb` 或仅在 nightly 用无版本号文件名**：Mirror 原始链接可写死。否决：违背 Debian 标准文件名 `nanopi_<version>_all.deb` 且不利于同时下载多个版本的包文件校验；AtomGit 主页 `README.md` 随每次发布重写当前 `.deb` 下载命令。
- **nightly 版本用 `~nightly.<date>`（排在 `<base>` 之前）**：与 npm 的 semver prerelease 约定一致。否决：`package.json` 在正式发布后已经处在 `<base>`（如 `20261128.0.0`），装过正式版的用户再装隔天的 nightly 时，`~nightly` 会被 `dpkg` 判为降级；`+nightly.<date>` 既符合时间先后又严格小于 `<base>` 的下一个同日修订或下一日期版本。
- **每次发布在 git 里提交更新 `debian/changelog`**：历史最完整。否决：会在发布流程里引入第三处必须手工同步的版本文件，且 `nightly` 仍需要动态写临时 changelog；在打包脚本的临时工作目录里生成顶层条目可以统一处理正式版与 nightly。

## Consequences

- 从下一个日期发布及下一次 nightly 起，GitHub Release（正式版）与 AtomGit（正式版与 nightly）都会随 `SHA256SUMS` 一起提供 `nanopi_<version>_all.deb`。
- `checks.yml`、`build-binaries.yml` 与 `nightly.yml` 的系统依赖安装需额外安装轻量的 `debhelper`。
- `scripts/publish-atomgit.mjs` 将缺少 `nanopi_*_all.deb` 视为失败，防止流水线改动意外漏掉 `.deb` 包。
- 验证：`scripts/build-deb.test.mjs`（校验版本归一化、changelog 生成、并在存在 `dpkg-buildpackage`/`dh` 时实测构建并解包执行 `/usr/bin/nanopi`）、`scripts/pnpm-command.test.mjs`（校验精简 `PATH`/失效软链下对 `node_modules/pnpm/bin/pnpm.mjs` 与 `corepack` 的回退）、`scripts/publish-atomgit.test.mjs`（校验 AtomGit 清单与 `SHA256SUMS`）、`node scripts/lint-workflows.mjs` 与 `pnpm run check`。

Related: [bundle 发到 AtomGit 的发行仓库](./2026-11-05-atomgit-release-assets-mirror.md)、[Single-file nanopi.js release artifact](./2026-10-11-single-file-release-artifact.md)、[engines.node 的迭代跟着 Debian 走](./2026-11-02-node-floor-follows-debian.md)。

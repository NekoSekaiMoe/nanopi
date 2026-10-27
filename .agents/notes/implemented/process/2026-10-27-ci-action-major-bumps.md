# Agent Note: CI action 大版本属于「可验证」批次，前提是不触发新的默认行为

Status: implemented

## Problem

[依赖升级按可验证分批](./2026-10-27-renovate-minor-major-split.md) 把剩余的
major 分成「要改代码」「动 vendor 产物」「基础设施」三类。基础设施那条列了
github artifact actions 与 `pnpm/action-setup`，看起来和依赖无关，实际上有一个
真正的判断点：action 的 major 常常只是换运行时（`node20` → `node24`），但也可能
顺手改掉某个输入的默认值，而 worktree 里的 workflow 不会因为版本号跳了一档就
报错——它会在下一次发版时静默地少传/多传文件。

`build-binaries.yml` 的用法是：`build` 上传 `release-assets/*`，
`smoke-test-single-file`、`stage-github-release` 等三个 job 用同一个名字下回来。
这里的输入是 `name` / `path` / `if-no-files-found` / `retention-days`，没有
`include-hidden-files`，也没有 `archive`。

## Decision

先落这两个，因为它们确实不需要改 YAML 语义：

- `actions/upload-artifact` v4.6.2 → v7.0.0
- `actions/download-artifact` v4.3.0 → v7.0.0

逐条核对的结果：

- v7 的 `upload-artifact` 新增 `archive: false` 直传单文件、包体转 ESM，两者都要
  显式打开才生效；`include-hidden-files` 的默认值仍是 `false`（v4.4 起就是），
  所以 `release-assets/*` 的可见文件集合没变。
- v7 的 `download-artifact` 只换了运行时到 `node24`。README 里点名的一条是
  **要求 runner ≥ 2.327.1**；本仓库的这四个 job 全是 `*-latest` 托管 runner，
  不设自托管，这条不构成阻塞。
- 两边的输入名都没改，所以 `name` + `path` 的配对原样保留。

`pnpm/action-setup` 一并从 `@v4` 升到 `@v6.1.0` 并锁 sha（`npm-audit.yml` 是唯一
没锁 sha 的 workflow）。它顺带修掉一处已有的错位：`version: 12.3.1` 与
`package.json` 里的 `pnpm: 12.15.0` 不一致，#303 改了其它 workflow 的
`npm install -g pnpm@12.15.0` 时漏了这个文件。v6.1.0 是第一个支持 pnpm v12 的版本
（v6.0.0 只到 v11），本仓库锁的正是 v12.15.0，所以不能停在 v6.0.x。

## Alternatives considered

- **换到 `pnpm/setup`**：v6.1.0 的 README 说 pnpm v11+ 可以考虑后继 action，但它
  要求 `version` 解析到 v11+ 并自带运行时安装，等于把 `actions/setup-node` 也换掉。
  这次只做版本升级，不换 action。
- **跟着把 `actions/setup-node` 的 `node-version` 提到 24（issue 里的「node v24」）**：
  那是 `engines.node` 的下限问题，要同时改 `package.json`、各 workflow 的
  `node-version` 和本地工具链，验证面比 action 版本大得多，单独一条。
- **artifact actions 只升到 v6**：v6 只是预备 node24，v7 才是默认 node24，而
  v7 的输入集是 v4.6.2 的超集，没有迁移成本，没有理由停在中间。

## Consequences

- 这四个 job 只在打 tag 时跑，`pnpm run check` 覆盖不到；验证靠输入集的静态核对，
  真正的确认要等下一次发版。
- 剩余的基础设施项：`engines.node` 到 v24。它不在这一批里。

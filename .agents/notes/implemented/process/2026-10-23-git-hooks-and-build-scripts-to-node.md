# Agent Note: git hook 与原生构建脚本统一为 Node

Status: implemented

## Problem

`2026-10-18-shell-scripts-to-node` 把仓库脚本换成了 `.mjs`，但留了两类尾巴：

- 三个 `.sh` 文件在换完之后还留在仓库里，且都没有调用点 ——
  `packages/coding-agent/scripts/migrate-sessions.sh`、
  `packages/tui/native/{darwin,linux}/build.sh`。对应的 `.mjs` 已经存在，
  但 `packages/tui/package.json` 当时仍指向 `build.sh`，等于 Node 版本没人跑。
  留着两份实现意味着改一处要记得改另一处。
- `.husky/commit-msg` 与 `.husky/pre-commit` 是 shell 脚本。

## Decision

- 删掉那三个 `.sh`。`packages/tui/package.json` 的 `build:native:{darwin,linux}`
  改为 `node native/<os>/build.mjs`，与 `build:native:win32` 一致。
- `.husky/` 下逻辑移到 `commit-msg.mjs` / `pre-commit.mjs`，hook 本身留下
  两行 sh shim：

  ```sh
  #!/usr/bin/env sh
  exec node "$(dirname "$0")/commit-msg.mjs" "$@"
  ```

**这个 shim 不是可选的。** husky 9 为每个 hook 生成
`.husky/_/<hook>`（内容为 `#!/usr/bin/env sh` + `. "$(dirname "$0")/h"`），
而 `h` 最后一行是 `sh -e "$s"` —— hook 文件始终被 `sh` 解释。把 hook 直接写成
`.mjs` 后，husky 找不到 `.husky/<hook>`，git 静默跳过，提交就丢了 `Change-Id`。
实测：`sh -e .husky/commit-msg.mjs` 在 `import` 一行报
`Syntax error: word unexpected`。

## Verification

`commit-msg.mjs` 与原 Gerrit 3.13.1 shell 脚本做过逐字节对比（归一化 40 位
hash 后 diff）：23 个用例覆盖无 trailer、已有 `Change-Id`、已有
`Signed-off-by`、`squash!`/`fixup!`、`gerrit.createChangeId=false|always`、
`gerrit.reviewUrl`（带/不带尾斜杠）、纯注释、`>8` scissors（首行/中途/无尾
换行）、非 ASCII、无尾换行，全部一致。

`pre-commit.mjs` 在真实 git 仓库 + husky shim 下验证了通过（提交成功并带
`Change-Id`）与失败（`pnpm run check` 非零时提交中止）两条路径。

`build.mjs` 用假编译器断言了完整参数数组：linux 的 20 个 flag 顺序与
`build.sh` 一致，darwin 两个 target 同样一致；缺少编译器 / 缺 xcb 头文件
时给出与原脚本相同的报错。本机无编译器，未做真实编译（prebuilds 本来就是
提交进仓库的，CI 也不编译）。

## Consequences

- 删 `.sh` 不改变行为，`scripts/create-source-archive.mjs` 的必需路径清单
  本来只列 `.mjs`。
- `migrate-sessions.mjs` 用 Node 读首行代替 `head`/`jq`，不再依赖 `jq`。
- 代价：这两个 hook 现在要求跑 hook 的机器上有 `node`。husky 本身就要
  `pnpm install`，且 `pre-commit` 会跑 `pnpm run check`，所以这不构成新的
  约束。

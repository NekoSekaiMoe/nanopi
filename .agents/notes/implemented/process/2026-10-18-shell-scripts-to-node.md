# Agent Note: 仓库脚本统一为 Node，删掉 .sh / .ps1 / .bat

Status: implemented

## Problem

同一件事在仓库里有两套写法。`test.sh` 只有 bash 版，Windows 开发者跑不了；
`nanopi-test` 有三份（`.sh`、`.ps1`、`.bat`），三份都要跟着 `--no-env` 的
环境变量名单手工同步。原 `nanopi-test.sh` 里还有一段真实的 bug：

```sh
RESOLVER_URL="$(node -p '...pathToFileURL(process.argv[1]).href' "$SCRIPT_DIR/packages/coding-agent/scripts/source-resolver.ts")"
node --import "$TS_IMPORT_URL" --import "$RESOLVER_URL" .../cli.ts
```

传进去的是模块 specifier，不是路径，所以 `argv[1]` 是 `undefined`，
`pathToFileURL` 抛错，命令替换失败；`set -e` 在赋值里不触发，
`RESOLVER_URL` 变成空串，最后只挂了 `ts-import.mjs`。
没有 `source-resolver.ts` 时，`src/extras/ask-lite` 的 `./x.js` specifier
解析不到源码，从仓库外的任意目录运行必然 `ERR_MODULE_NOT_FOUND`。

同时，任何要「探测编译器 / SDK、构造参数数组、按退出码决定是否继续」的脚本，
在 shell 里都只能靠 `set -euo pipefail` 和 `${arr[@]+"${arr[@]}"}` 这类
写法维持正确性，改一处要通读全篇。

## Decision

仓库里不再有 `.sh` / `.ps1` / `.bat` / `.pwsh`（`.husky/` 下的两个 git hook
除外，git 直接执行它们，改成 Node 需要额外的 shim）。

- 入口是带 `#!/usr/bin/env node` 的 `.mjs`，pnpm script 写成
  `node path/to/script.mjs`。Windows 上 `node` 是真正的可执行文件，
  pnpm 不需要 shim，所以 `node foo.mjs` 是跨平台写法，`./foo.mjs` 不是。
- 共享工具在 `scripts/lib/node-runner.mjs`：`runNode`（在 POSIX 上 `execve`
  替换进程，保留退出码与信号语义）、`typescriptPreloadArguments`、
  `environmentWithout`（子进程环境里删 key，等于 `unset`）、`exitStatus`。
- `nanopi-test.mjs` 取代三件套，`--no-env` 只在子进程环境里删掉
  `packages/ai/src/env-api-keys.ts` 列的变量，不再要求各平台各维护一份。
- `test.mjs` 用 `spawnSync` 显式构造 `env -i` 的那份白名单环境，
  并保留「只删自己创建的临时目录、删前校验 `.nanopi-test-owned`」的约束。
- `scripts/update-source-imports-to-ts.mjs` 只负责收集文件列表，
  改写仍然交给 `perl -0pi`：Node 逐文件读写比单次 Perl 慢一个数量级。
- `packages/tui/native/{darwin,linux}/build.mjs` 复用 `win32/build.mjs` 的形状：
  数组参数、`spawnSync` 检查状态、临时目录清理挂在 `process.on("exit")`。

## Alternatives considered

- **保留 `.sh` 并补 Windows 的 `.cmd`/`.ps1`**：问题里的维护成本不变，
  反而更多份。`.ps1` 还要处理 `ExecutionPolicy`，`puppeteer` 式的
  `bash` 依赖在 Windows CI 上也不存在。
- **全部改成 `.ts` 由 `ts-import.mjs` 运行**：这些脚本要在依赖装好之前
  跑（`build-single-file.mjs` 会先 `pnpm install`），`ts-import.mjs` 依赖
  esbuild，装不上的时候脚本连参数检查都过不去。`.mjs` + `node:` 内置模块
  没有这一层循环依赖。
- **`build.sh`/`create-source-archive.sh` 直接调 `bash`**：等于把问题搬进
  Node，且 Windows 上 `bash` 不保证存在。
- **`update-source-imports-to-ts` 全用 Node 重写**：可读性更好，但要对
  `packages/*/src` 下约 1500 个 `.ts` 逐个 `readFileSync` + `replace`，
  比一次 `perl -0pi` 慢一个数量级，而这个脚本是频繁运行的一次性工具。

## Consequences

- `AGENTS.md`、`CONTRIBUTING.md`、`README`、`.nanopi/skills/*`、
  `.github/workflows/build-binaries.yml` 里的调用点都改成 `node <script>.mjs`；
  `scripts/local-release.mjs`、`scripts/release.mjs` 内部改用
  `process.execPath` 调用。
- `create-source-archive.mjs` 的必需路径清单里，`build-single-file.sh` /
  `linux/build.sh` 已换成 `build.mjs`，发布归档里不会再混进 shell 脚本。
- 行为变化：`auto-nanopi.mjs` 的 `--stable` 在 Windows 上会找
  `nanopi.cmd` / `nanopi.exe`；`migrate-sessions.mjs` 用 Node 读首行来代替
  `head`/`jq`，不再依赖 `jq`。
- 代价：这些脚本现在要求运行环境有 Node（版本与仓库 `engines` 一致），
  而 `.sh` 版本在极简容器里只需要 bash + node。`update-source-imports-to-ts.mjs`
  仍然要求 `perl`。
- 验证：`pnpm run check` 通过；`node nanopi-test.mjs --version` 从仓库外
  可运行（旧 `.sh` 在该环境因上述 resolver bug 直接失败）。

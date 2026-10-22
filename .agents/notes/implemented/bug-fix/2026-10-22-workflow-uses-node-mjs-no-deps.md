# Agent Note: GitHub workflow 里跑 .mjs，不引入 TS 依赖

Status: implemented

## Problem

`mirror-main.mjs` 要被两侧调用：CNB 的 `.cnb.yml` `push main` stage 和 GitHub 的
`sync-to-cnb.yml`。后者的 checkout 不装依赖 —— 它只做镜像，跑 `pnpm install`
既慢又会把 lockfile 校验变成镜像的前置条件。

仓库里其他脚本多是 `.mjs`（`check-commit-trailers.mjs`、`check-pinned-deps.mjs`），
但把一个 `.ts` 脚本拿去给 workflow 用，就得在那里补 `ts-import.mjs`：
它的预加载依赖 `esbuild`，而 `esbuild` 只在 `pnpm install` 之后才存在。

## Decision

镜像脚本写成纯 `.mjs`（只有 `node:child_process` 等内置模块），两侧调用点都是
`node scripts/mirror-main.mjs --remote <url>`，不需要任何工作区依赖。

这也是脚本里**没有**用 `scripts/lib/node-runner.mjs` 的原因：那个 helper 没有外部依赖，
但它服务的对象是 `ts-import.mjs` 相关的加载链路，镜像脚本不需要这层抽象，
直接 `execFileSync` 更短。测试是 `scripts/mirror-main.test.mjs`，走仓库既有的
`pnpm run test:scripts`。

## Alternatives considered

- **写成 `.ts`，workflow 里加 `pnpm install` 再跑。** 一致性更好（`typecheck` 覆盖到它），
  代价是镜像 stage 从 10 秒级涨到「装依赖」的量级，并且依赖安装失败会让镜像红。
- **写成 `.ts`，用 `node --experimental-strip-types` 直接跑。** 只对 erasable 语法有效，
  且 Node 版本行为不一（Debian 的 node 构建里 `process.features.typescript === false`），
  这正是仓库需要 `ts-import.mjs` 的原因。
- **复用 `scripts/lib/node-runner.mjs`。** 其 `environmentWithout` 等 helper 对镜像脚本
  没有用处，多一跳导入只增加耦合。

## Consequences

- `scripts/mirror-main.mjs` 不在 `tsc --noEmit` 的覆盖范围内（`scripts/*.mjs` 普遍如此），
  正确性靠 `scripts/mirror-main.test.mjs` 和 biome 的 lint 兜底。
- 改动这个脚本时不需要重新构建，改完直接推 CNB 就生效；对「修一条流水线」这类场景，
  这一点比类型检查更重要。

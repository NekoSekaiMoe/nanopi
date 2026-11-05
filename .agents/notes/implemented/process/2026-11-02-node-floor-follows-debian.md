# Agent Note: engines.node 的迭代跟着 Debian 走，Renovate 不许碰

Status: implemented

## Problem

Renovate 打出 `renovate/all-dependencies` 分支，里面把 7 个 `package.json` 的
`engines.node` 从 `>=24.0.0` 改成了 `"v26.13.0"`。

那个字符串不是「26.13.0 或更新」，而是一个精确范围。`semver.validRange("v26.13.0")`
得到 `26.13.0`，实测 `24.22.2` 不满足、`26.14.0` 也不满足。`v` 前缀被 semver 容错
吃掉，不报错，只安静地变成 pin。

根因是 `renovate.json` 的 `"rangeStrategy": "pin"`。这条是为「直接外部依赖必须
精确版本」配的（`scripts/check-pinned-deps.mjs` 强制），而 `engines` 不在那份检查
管辖内，pin 策略顺手把它也当依赖版本钉到了当轮最高已发布版本。

更麻烦的是这个错位查不出来：`engines` 本身不做任何事（`pnpm-workspace.yaml` 没开
`engineStrict`），CI 跑的是 `.github/workflows/*` 里的 `node-version: 24.22.2`，
`Dockerfile` 是 `node:24.22.2-bookworm-slim`，esbuild `target: "node24"`，
`@types/node` 是 24.19.2——全部绿灯。声明和验证面已经劈叉，但没有任何一处会红。
见 [node 24 is the floor](./2026-10-27-node-24-floor.md) 里那套「四处一起改」的
原则，这条分支正好把它反过来做。

`engines.node` 的下限到底是几个意思？这个仓库有很具体的答案：主要分发渠道是
Debian testing 的 `nodejs` 包，没有第二套运行时在跑。

## Decision

**Node 下限跟着 Debian testing 走，不跟 Node 上游走。** Debian 的 `nodejs` 包在
testing 里换大版本，就说明下游用户手里的 node 换了版本 —— 那一刻才值得动下限。
Node 上游发 26 与我们无关，只要 Debian 还在 24。

落到配置上：

```json
{
  "matchDepTypes": ["engines"],
  "allowedVersions": "/^>=24\\.0\\.0$/"
}
```

放进 `renovate.json` 的 `packageRules`。`matchDepTypes` 只命中 `engines`，不动任何
真实依赖；`allowedVersions` 让「范围写死」这件事本身成为拦截条件——写了别的就判为
不允许的更新，不产生 PR，也就不会每轮重开再被人手动关一次。这一项后来从
`enabled: false` 改过来，好让 `@types/node` 的 major 规则能引用同一个值，
见 [运行时版本声明只有一个源](./2026-11-05-runtime-version-declarations-single-source.md)。

下限真要动的时候，按 [node 24 floor](./2026-10-27-node-24-floor.md) 那五处一起改：
`engines.node`、workflow 的 `node-version`（现在是 `24.22.2`）、esbuild `target`、`@types/node`、
文档里的「Node.js N or newer」。不动 `engines` 单点。

## Alternatives considered

- **`rangeStrategy: "replace"` + 只放开 engines 范围**：能让 Renovate 写成
  `>=26.13.0` 而不是钉成一点，形式上可读。但决定权交回给了 Node 上游的发版节奏
  ——Debian testing 还在 24 的时候，`>=26` 会让每一个 Debian 用户装不上（开
  `engine-strict` 时硬失败），所以这条路要的不是换个 range 写法，是换个判定依据。
- **什么都不配，看到 PR 手动关**：可行，但 Renovate 每轮都会重开，且没人保证每次
  都认出来 —— 这条本身就是 `rangeStrategy: "pin"` 的副作用，靠人肉兜副作用不算配置。
- **把 `rangeStrategy` 从 `pin` 改回默认**：会同时放过所有直接外部依赖的精确版本，
  撞 `scripts/check-pinned-deps.mjs`。为一个 `engines` 字段放弃整条依赖纪律不划算。
- **`ignoreDeps: ["node"]`**：Node 的 docker 底图也是 `matchPackageNames: ["node"]`
  的 Renovate 目标，用 `ignoreDeps` 会连底图 patch 一起关掉 —— 底图 patch 是要跟的。

## Consequences

- `engines.node` 从此是纯人工决策点，Renovate dashboard 上不再出现它。
  代价是：Debian testing 真的换了大版本时，没人提醒，得自己看包版本。
- `engines` 声明与 `@types/node` 之间那层「类型库不得新于运行时」的约束后来
  变成了配置：`@types/node` 的 major 升级被同一条规则引用的
  `allowedVersions` 拦下，见
  [运行时版本声明只有一个源](./2026-11-05-runtime-version-declarations-single-source.md)。
- 本条只解决「谁来决定」，「怎么改」仍归
  [node 24 floor](./2026-10-27-node-24-floor.md)。

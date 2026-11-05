# Agent Note: engines.node 改回 enabled: false，并加一道 CI 断言兜底

Status: implemented

## Problem

`shinytale/nanopi#516`：`a6350b548`（Renovate 分组 PR，GitHub
`NekoSekaiMoe/nanopi#17` 的 `renovate/npm-dependencies` 分支）把 8 个
`package.json` 的 `engines.node` 从 `>=24.0.0` 改成了 `v26.13.0`，CI 全绿、automerge
没拦、人工点了合并。`shinytale/nanopi#513` 已把值还原，但配置里的漏洞还在。

漏洞是 `7aacf33b8` 引入的回归：它把 `engines` 规则从 `enabled: false` 换成了

```json
{
  "matchDepTypes": ["engines"],
  "allowedVersions": "/^>=24\\.0\\.0$/"
}
```

A/B 实证（逐个 diff 核过）：

- `enabled: false` 期间，11-02~11-04 落地的 8 个 Renovate PR（pin node、各 action
  digest、`pnpm`、pnpm/action-setup）没有任何一个碰过 `engines.node`。
- 换成 `allowedVersions` 后，`117f0c9ca` 修好非法配置、Renovate 恢复运行的
  第一轮分组 PR（`3727ec7bb`）就把 8 处全钉成了 `v26.13.0`。PR 分支的 base
  `470e96009` 已含修复、`renovate.json` 合法、分支自身没改配置，排除「没同步」和
  「停摆期间陈旧分支」两个解释。

机制上 `allowedVersions` 拦的对象不对：它筛的是 datasource 返回的候选版本号
（`26.13.0`、`24.19.2` 这类纯版本号），而这次 `engines.node` 的改动是
`rangeStrategy: "pin"` 做的范围改写——直接把 `>=24.0.0` 替换成精确版本
`v26.13.0`，产出的是 `currentValue` 的替换，不经过「候选升级版本」那道筛选。
字段在分支生成阶段就被写好，后面没有第二道关卡再读 `allowedVersions` 撤掉它。
且 `/^>=24\.0\.0$/` 匹配的是字面串 `>=24.0.0`，候选是纯版本号，没有任何候选能命中。
这一层是推断（要 `LOG_LEVEL=debug` 的 lookup 日志坐实），但 A/B 对照已足够定位回归点。

放大因素：`packageRules[0]` 的 `groupName` + `automerge: true` 把改写裹进组 PR
没有单独复核点；`engines` 不触发任何校验（`pnpm-workspace.yaml` 没开
`engineStrict`），CI 的 `node-version` 仍是 `24.22.2`、`Dockerfile` 是
`node:24.22.2-bookworm-slim`、esbuild `target: "node24"`、`@types/node` 是
`24.19.2`；`scripts/check-pinned-deps.mjs` 当时只查 `dependencies` /
`devDependencies` / `optionalDependencies` 三段，不读 `engines`。从 PR 生成到合并
全程绿灯。

## Decision

**改回 `enabled: false`，并给 `pnpm run check` 加一道 `engines.node` 断言。**

`renovate.json` 的 `engines` 规则：

```json
{
  "matchDepTypes": ["engines"],
  "enabled": false
}
```

`enabled: false` 直接关掉 Renovate 对 `engines` depType 的提取/改写能力，从源头掐断，
是 11-02~11-04 八个 PR 实证有效的写法。

兜底：`scripts/check-pinned-deps.mjs` 本来已递归遍历全部 `package.json`，在遍历里
加一段——凡带 `engines` 段的，`engines.node` 必须严格等于 `>=24.0.0`（常量
`expectedEnginesNode`），否则退出码 1、`pnpm run check` 变红。这是兜「Renovate
之外的人误改」，不是根治：Renovate 仍可能每轮提 PR，但 CI 会红、automerge 不会合。
`scripts/check-pinned-deps.test.mjs` 带 6 个回归用例（精确版本、不同范围、多处同时报、
无 engines 段不强制、与 pinned-deps 报错并存），标注 `#516`。

**澄清一处笔误**：`7aacf33b8` 的提交说明与
[运行时版本声明只有一个源](../process/2026-11-05-runtime-version-declarations-single-source.md)
都说「换成 `allowedVersions` 是为了让 `@types/node` 的 major 规则引用同一个值」。
核对 `470e96009` 的配置，`@types/node` 规则用的是自己独立的取反正则
`!/^(?:0|[1-9]\d*)\./`，不读 `engines` 的值；两条规则只匹配各自的 depType，互不引用。
这个「引用」在配置里不存在，是语义对齐被写成了隐含依赖。改回 `enabled: false`
不会破坏 `@types/node` 的拦截，下次 Node 迁移也不该照着「有依赖」这个前提改配置。

**顺带查清「CI 绿却没自动合并」**：不是这次才坏，是从未真正生效。所有 Renovate
PR（GitHub #3~#17）的合并提交 author 都是 `dabao1955`（人工），不是 `renovate[bot]`；
PR #17 时间线里 `12:23:50 auto_merge_enabled` → `12:23:56 auto_merge_disabled` →
`12:24:06 merged by dabao1955`，正是人开着 GitHub native auto-merge、等不到结果
又手动合掉的痕迹。`shinytale/nanopi#419` 已经诊断过一次根因：Renovate 的
automerge 只等分支保护点名的必选检查，名字对不上就永远判定「还差一条」。PR #17
head `3727ec7bb` 的 `build-check-test` 是 `success`，但 combined commit status 是
`pending`——检查跑在 Actions（check-runs）里，`status` 通道没有任何记录。配置是
`automergeType: "pr"` + `platformAutomerge: false`（Renovate 自己合，不用 GitHub
native auto-merge），而 timeline 里出现的 `auto_merge_enabled/disabled` 是 GitHub
native auto-merge 的事件，说明有人在手动开它、它又在等一条不会来的检查。
仓库侧能改的（workflow 名对齐 `Checks / build-check-test`）在 #420 已做；剩下的
是 GitHub ruleset 里的必选检查名，只有仓库管理员能在网页改，仓库读不到也写不了。
所以「修法」分两半：`enabled: false` + CI 断言是仓库内能做的；automerge 真正生效
仍需管理员把 ruleset 必选检查改成 `Checks / build-check-test`，并用
`gh pr checks <PR>` 核对一字不差。

## Alternatives considered

- **只把 `allowedVersions` 正则改成能匹配候选版本**：比如放开纯版本号。治不了根——
  改写走的是 `rangeStrategy` 的 currentValue 替换，不进候选筛选；而且放开后
  Renovate 反而有资格把 `engines` 往上升。
- **只改 `rangeStrategy`**：`pin` 是「直接外部依赖必须精确版本」的全局纪律
  （`check-pinned-deps.mjs` 强制），动它会放过所有依赖；给 `engines` 单独配
  `rangeStrategy: "replace"` 也仍会把范围写成 `>=26.13.0`，判据跟着 Node 上游走，
  违背「下限跟着 Debian testing 走」的决定（见
  [engines.node 的迭代跟着 Debian 走](../process/2026-11-02-node-floor-follows-debian.md)）。
- **只加 CI 断言、不动 `renovate.json`**：能挡住合并，但 Renovate 每轮都会提一个
  必红的 PR，噪声不断，且依赖「CI 一定跑」这个前提。两道一起做才既掐源头又兜底。
- **接着用 `enabled: false` 但删掉 `@types/node` 的独立规则**：没必要。两条规则
  管的是不同 depType，删掉会放行 `@types/node` 的 major，把运行时类型库抬到 26，
  与 [node 24 floor](../process/2026-10-27-node-24-floor.md) 的不变量冲突。

## Consequences

- `engines.node` 重新成为纯人工决策点，Renovate 不再提取/改写它；代价仍是
  Debian testing 换大版本时没人自动提醒，得自己盯（这条代价在旧篇已承认过）。
- `pnpm run check` 现在会因 `engines.node` 被误改而红。将来做 Node 大版本迁移时，
  必须同步改 `expectedEnginesNode` 常量，否则五处一起改的那次 PR 会被自己拦下——
  这是有意的：它保证「改 engines」这件事一定连带一次显式决策，而不是被 Renovate
  或某次顺手编辑悄悄带过。
- `@types/node` 的 major 拦截不受影响，仍由独立的取反正则负责。
- 验证：`node --test scripts/check-pinned-deps.test.mjs` 6 项全绿；
  `node scripts/check-pinned-deps.mjs` 对当前仓库 8 处 `>=24.0.0` 返回 0；
  `pnpm run check` 全绿。
- automerge 不会因这次改动自己变好。管理员若不改 GitHub ruleset 的必选检查名，
  下一个依赖 PR 仍会「绿了不合、等人手点」。这是仓库外的一步，已在 Decision 里写清。

# Agent Note: Renovate 的冷却期必须与 pnpm 的对齐，否则依赖 PR 一定带着一条 Artifact 失败

Status: implemented

## Problem

`shinytale/nanopi#568`：GitHub 的依赖 PR `NekoSekaiMoe/nanopi#23` 同时出现两条报错。

CI 侧：

```text
Error: ERR_PNPM_OUTDATED_LOCKFILE
  ╰─▶ Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date
      * in importers["."]: @biomejs/biome (lockfile: 2.6.5, manifest: 2.6.6)
```

PR 侧：

```text
### ⚠️ Artifact update problem
File name: pnpm-lock.yaml
Error: ERR_PNPM_NO_MATURE_MATCHING_VERSION
  ╰─▶ 43 versions do not meet the minimumReleaseAge constraint
        @biomejs/biome@2.6.6 was published at 2026-11-06T13:28:30.795Z,
      within the minimumReleaseAge cutoff (2026-11-06T02:36:19.547Z)
```

两条是同一个原因的两面。pnpm 的 `minimumReleaseAge: 1440`（`pnpm-workspace.yaml`，
见 [minimumReleaseAge 的单位是分钟](./2026-11-06-minimum-release-age-is-minutes.md)）
在**装**的时候生效，而 Renovate 完全不读它：Renovate 拿自己那套 `minimumReleaseAge`
（当时是 `null`）判定候选版本，把 `package.json` 钉到刚发布 13 小时的 biome 2.6.6，
再用 pnpm 去刷 lockfile。pnpm 拒绝，Artifact 步骤失败，lockfile 没被写下来，于是
PR 分支上 `package.json` 是新的、`pnpm-lock.yaml` 是旧的，CI 的
`pnpm install --frozen-lockfile` 再报一次 `ERR_PNPM_OUTDATED_LOCKFILE`。

在 `/tmp/pr23`（PR 的树）上复现，两条各自独立：

- `pnpm install --lockfile-only` → `ERR_PNPM_NO_MATURE_MATCHING_VERSION`，43 条。
- `git checkout` 回带旧 lock 的树再 `pnpm install --frozen-lockfile` → `ERR_PNPM_OUTDATED_LOCKFILE`。

关键事实是**第二条不是第一条的后果**：它是 lockfile 没写下来的结果，而 lockfile 写不
下来是因为第一条。修 CI 报的错（重跑 `--lockfile-only`）在这棵树上仍然是错的——
同一条命令，同样被冷却期拒绝。

还有第二个更窄的窗口：同一版本的主包与平台子包常常差几分钟发布。实测 biome 2.6.6
主包 `13:28:30`、`@biomejs/cli-linux-x64@2.6.6` `13:31:32`，差 3 分钟。Renovate 只按
主包的发布时间算年龄，主包刚好跨过冷却线时子包仍在窗内，lockfile 照样写不下去。

## Decision

`renovate.json` 的 npm 组补上冷却期，值取到与 pnpm 同值再多垫一段：

```json
{
  "matchManagers": ["npm"],
  "groupName": "npm dependencies",
  "minimumReleaseAge": "1 day",
  "minimumReleaseAgeBuffer": "30 minutes"
}
```

- `1 day` = 1440 分钟，与 `pnpm-workspace.yaml` 的 `minimumReleaseAge: 1440` 同值。
  两侧单独写、可以各自变，但同一轮里必须让 Renovate 等得不比 pnpm 少。
- `minimumReleaseAgeBuffer: "30 minutes"` 是 Renovate 的默认值，这里显式写出来。它正是
  为「主包与平台子包发布有先后」这个场景加的：Renovate 等到
  `minimumReleaseAge + buffer` 才提议，而 pnpm 那边仍只用 `minimumReleaseAge`，
  于是子包发布晚于主包 30 分钟内的组合也能过。biome 的 3 分钟落在这个窗里。
- 两个值由 `scripts/check-renovate-release-age.mjs` 在 CI 里对齐（进了 `pnpm run check`，
  也就进了 `build-check-test`）。判据是
  `renovate.minimumReleaseAge + renovate.minimumReleaseAgeBuffer >= pnpm.minimumReleaseAge`，
  任一侧改成更短就红。

单位在这一步是主要风险，所以脚本对两侧各用各的严格度：pnpm 那侧只接受数字（它的单
位是分钟，写成 `"1 day"` 会被 pnpm 判为无效），Renovate 那侧只接受**带单位**的时长字
符串。后者是因为 `ms` 库把纯数字当毫秒：`"1440"` 是 1.44 秒。看着 pnpm 的
`1440` 照抄一份进 `renovate.json` 是这里最自然的错误，而它不会报错、只会让冷却期
退回「等于没有」。

效果上是 PR 会晚一天出现：版本发布后满 `1 day + 30 minutes` 那一轮 Renovate 才建分
支。这本来就是 pnpm 那侧已经在要求的等待，只是从「PR 建出来、锁写不下去、红一天」
换成了「晚一天建 PR、建出来就是绿的」。

## Alternatives considered

- **只修 CI，让 lockfile 跟上 `package.json`（重跑 `--lockfile-only` 并提交）**：在这棵
  树上跑不动——`pnpm install --lockfile-only` 本身就是被 `ERR_PNPM_NO_MATURE_MATCHING_VERSION`
  拒绝的那条命令。要它跑得动只能给 43 个条目写 `minimumReleaseAgeExclude`，等于给
  一次常规升级开 43 条安全豁免，冷却期名存实亡。而且下一轮 Renovate 又会提一个同样
  太新的版本，同样的问题重演。
- **`skipArtifactsUpdate: true`**：Renovate 不再跑 lockfile 更新，PR 只改 `package.json`，
  让 CI 去装。看起来最省事，但它把一个「本地与 CI 各装各的」的窗口留在 main 上：
  PR 里没有 lockfile diff 可评审，`frozen-lockfile` 在 CI 里照样红，红线只是从 Artifact
  步骤挪到了 `pnpm install` 那一步。跳过校验不会让不一致消失。
- **`suppressNotifications: ["artifactErrors"]`**：只把警告藏起来。PR 上不再显示
  Artifact update problem，可 lockfile 还是没写下来，CI 还是红。把一个可见的失败改成
  一个看不见的失败。
- **把 pnpm 的 `minimumReleaseAge` 降到 0 让两边同时「不等」**：立刻能合，但等于把
  供应链冷却期删掉。那是安全策略，不是让 CI 变绿的手段。
- **`prCreation: "not-pending"` 或 `internalChecksFilter` 调成 `none`**：前者是让 Renovate
  等检查完成再开 PR，后者是「连 pending 的版本也照提」。这两个方向都反了：
  `internalChecksFilter: "none"` 会让 Renovate 在冷却窗内就提议（正是要防的），
  `not-pending` 在没有分支级检查时靠 `prNotPendingHours`（默认 25 小时）兜底，等待时间
  与两侧冷却期无关，纯粹多一层时序。
- **只在 `renovate.json` 设冷却期，不在 CI 里断言**：能修好这一次。代价是两边的关系
  只活在这篇笔记里：以后有人只想改 pnpm 那侧（比如按 36 小时的旧结论调回去），
  Renovate 就像这次一样被留在更短的值上，而暴露方式是「某天依赖 PR 又红了」。
  断言让这条关系在改的那一刻就红。
- **用一个共享的常量文件给两侧供值**：Renovate 的配置文件只能是 JSON（或 JSON5），
  `pnpm-workspace.yaml` 只能是 YAML，中间要插一层生成步骤。为了一个数字引入生成器
  不值得；断言是同一件事的更便宜的写法。

## Consequences

- 依赖 PR 会晚 `1 day + 30 minutes` 出现。原本 pnpm 那侧就在要求这个等待，所以对
  main 的时间线没有影响，差别只在这段时间里不再挂着一个必红的 PR。
- Renovate 每轮会在日志里记一条 `renovate/stability-days` 的 pending 检查，等满时间
  才转绿。因为 `platformAutomerge: true` 交给 GitHub 原生 auto-merge
  （见 [renovate 的自动合并方式](../bug-fix/2026-11-05-renovate-platform-automerge.md)），
  pending 期间不会误合。
- 两侧的值现在是一对必须同向变的事实。改任一侧都要看另一个：调长 pnpm 那侧不会
  触发断言（Renovate 等得更久是安全的，只是 PR 更晚），调短 pnpm 那侧会让断言红。
  这条不对称是有意的——断言守的是「Renovate 不能比 pnpm 早」，不是「必须相等」。
- 断言只读 `renovate.json` 与 `pnpm-workspace.yaml` 两份文件，不需要装依赖，也不跑
  Renovate，因此能在 `build-check-test` 的第一层拦住。
- `renovate.json` 的 customize 值是字符串，pnpm 的是数字。两侧的格式差异没有任何
  代码共享，只靠断言比对。这是刻意留的耦合点：想让它们自动一致，就得引入生成步骤。

## Verification

- `node scripts/check-renovate-release-age.mjs` 在当前树上退出码 0。
- `node --test scripts/check-renovate-release-age.test.mjs`：7 个用例覆盖
  相等通过、更短红、buffer 计入总等待、无单位红、npm 规则缺失红、规则没设冷却期红、
  pnpm 侧写成字符串红。
- 手动把 `minimumReleaseAge` 改成 `"1 hour"`、buffer 改成 `"0 minutes"`：退出码 1，报出
  `冷却期不对齐：Renovate 等 1 hour + 0 minutes = 60 分钟，pnpm 要 1440 分钟`。
- 在 `/tmp/pr23`（`NekoSekaiMoe/nanopi#23` 的树）上复现了 Problem 里那两条报错；
  `pnpm install --lockfile-only` 与 `pnpm install --frozen-lockfile` 分别失败，
  说明它们同为冷却期的两个观察面。
- 用 renovate 44.220.0 的 `toMs` 核对单位换算：`"1440"` → 1440 毫秒，`"1 day"` →
  86400000，`"30 minutes"` → 1800000。
- `pnpm run check` 的各分项（`check:biome-schema`、`check:pinned-deps`、
  `check:renovate-release-age`、`check:runtime-deps`、`check:ts-imports`、
  `check:entry-graphs`、`typecheck`、`check:browser-smoke`）逐个退出码 0；
  汇总跑在 `check:openai-client-size` 处停下，原因是本地没跑 `pnpm run build`、
  `packages/ai/dist` 不存在，与本次改动无关。

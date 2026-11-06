# Agent Note: biome.json 的 $schema 由 Renovate 的 customManager 一起升，CI 兜住失手

Status: implemented

> **已被完全取代（2026-11-06，`shinytale/nanopi#561`）**：本篇的 customManager 提取是好的，但它配套的 `packageRule` 自带 `groupName`，于是 `biome.json` 的 `$schema` 更新落在独立的 `renovate/biome-schema` 分支，而 `branchConcurrentLimit`/`prConcurrentLimit` 都是 1，它排不进 npm 组那个 PR：锁文件先合进 main、`$schema` 仍停在旧版。文中「depName 相同就会落在同一分支」的说法是错的，Renovate 的分组判据是 groupName。现在改为 `$schema` 指向安装包自带的 schema，版本号不再有第二份，本篇的两条 `renovate.json` 配置与 `$schema` 正则均已删除。见 [biome.json 的 $schema 指向安装包](../process/2026-11-06-biome-schema-points-at-installed-package.md)。

## Problem

`shinytale/nanopi#545`：`biome.json` 的 `$schema` 指向
`https://biomejs.dev/schemas/<版本>/schema.json`，这个版本号是仓库里唯一记录「配置
按哪个 CLI 写的」的地方。`@biomejs/biome` 升级时它不动，配置文件就变成按旧版本的
schema 写的。

这件事不会自己暴露：#533 之前的实测是，2.6.5 的 CLI 读 2.6.4 的 schema，biome 只
打一行 info，`biome check` 退出码 0。所以「版本升了、schema 落后」能一路绿到有人
翻日志才发现，`#532` 就是这样攒下来的。

Renovate 也没有内置办法：`@biomejs/biome` 的 npm 包里**没有** `schema` 字段（registry
manifest 只有 `_id,bin,bugs,dist,engines,…`），Renovate 的 npm manager 只认
`package.json` 的依赖清单，`biome.json` 不在它的视野里。

## Decision

在 `biome.json` 这一侧解决问题，不要求改 `biome.json` 的写法，也不依赖自建
Renovate runner。两层：

1. `renovate.json` 加一条 `customManagers`（`custom.regex`）：

   - `managerFilePatterns: ["/^biome.json$/"]`
   - `matchStrings: ["\"\\$schema\":\\s+\"https://biomejs\\.dev/schemas/(?<currentValue>\\d+\\.\\d+\\.\\d+)/schema\\.json\""]`
   - `depNameTemplate: "@biomejs/biome"`，datasource `npm`

   也就是把 `biome.json` 的 `$schema` 版本号当成 `@biomejs/biome` 的一条依赖提取
   出来。因为 depName 与 `package.json` 里那条依赖同名，npm 组的 `matchManagers:
   ["npm"]` 与这条的 `matchFileNames: ["biome.json"]` 在 Renovate 拿 depName 取
   分组交集时命中的是同一个包，于是 Renovate 同一轮把 `biome.json` 里的数字改掉，
   和 `package.json` / lockfile 落在同一个分支、同一个 PR，不再有「版本单独一轮
   先合了」的空窗。

2. 配套一条 `packageRules`：`matchManagers: ["custom.regex"]` +
   `matchFileNames: ["biome.json"]` + `rangeStrategy: "replace"`。

   `rangeStrategy` 必须显式写成 `replace`：全局是 `pin`，pin 的语义是「把精确版本
   写进依赖清单」，对非 `package.json` 文件它会去加 `pnpm.overrides`、往根
   `package.json` 塞一条 dep——那是改依赖清单，不是改 schema 链接。

3. `scripts/check-biome-schema.mjs` 进 `pnpm run check`，也就进了
   `build-check-test`：读 `biome.json` 的 `$schema` 版本，与 `biome --version` 比对，
   不等就红，提示 `pnpm exec biome migrate --write`。它兜的是提取失效的情况——有人
   重排了 `$schema` 那一行、或者手工升了 `package.json` 里的 biome。

## Alternatives considered

- **在 `renovate.json` 里写 `postUpgradeTasks: "pnpm exec biome migrate --write"`**：
  这是最常见的答案，在这个仓库不成立。托管版 Renovate（GitHub App）默认禁用
  `postUpgradeTasks`，要用得自建 runner；就算自建，Renovate 建分支时写的是精确版本
  `@biomejs/biome@2.6.6`，而仓库里 `minimumReleaseAge` 那套冷却期会让 1 天前刚发的
  包 `pnpm install` 失败，整条依赖 PR 全红。customManager 不跑命令，没有这个前提。
- **`.github/workflows` 里加一步 `biome migrate --write` 并自动提交**：需要一个能推
  分支的 token，而且它只能在事后补，PR 已经被看到是红的；`renovate.json` 这条在
  Renovate 生成分支时就写好了。
- **让 `$schema` 指向 `latest` 或去掉它**：指向 `latest` 会让编辑器永远按最新版
  校验，配置里用了旧版才有的键就报错；去掉就失去编辑器补全。两者都是拿开发体验换
  「不用维护」。
- **只留 CI 断言，不做自动更新**：也能保证合进 main 的树是自洽的，但每次 biome
  升级都要人补一条命令，而 `minimumReleaseAge` 让 PR 有一天的窗口，期间红的是整组
  npm PR——这正是要消掉的摩擦。

## Consequences

- biome 升级时 `biome.json` 的 `$schema` 跟随，同一个 PR 里改完，人不用补命令。
  代价是 `renovate.json` 多两条配置，且它们与 `biome.json` 里 `$schema` 那一行的
  字面格式耦合：正则只认 `"$schema": "https://biomejs.dev/schemas/<x.y.z>/schema.json"`
  这一种写法。换成别的写法不会报错，只会静默退化成「不自动升」——由 CI 断言接住。
- CI 跑 `biome --version` 而不是读 `node_modules/@biomejs/biome/package.json`：pnpm
  的 `node_modules/@biomejs/biome` 是链到 `.pnpm` 的软链，问 CLI 拿到的就是
  `pnpm run check` 里真正执行的那个版本。
- 断言红时的处理路径只有一条命令：`pnpm exec biome migrate --write`。它同时改
  `$schema` 和按新 schema 迁移 `biome.json` 的内容，比手改版本号正确。

## Verification

- 本地用 2.6.5 的 CLI 跑 `node scripts/check-biome-schema.mjs`，退出码 0；把
  `$schema` 手动改成 `2.6.4` 后退出码 1、报出两边版本；把 URL 换成非
  `biomejs.dev/schemas/<x.y.z>/schema.json` 的形态后退出码 1、报格式错。
- `renovate.json` 新增的 `matchStrings` 在 `biome.json` 上实测命中，`currentValue`
  为 `2.6.5`，depName 解析为 `@biomejs/biome`。
- 下一条 biome 升级 PR 应能在 diff 里看到 `biome.json` 的 `$schema` 与
  `pnpm-lock.yaml` 同时变化；若只看到 lockfile，说明 customManager 没命中。

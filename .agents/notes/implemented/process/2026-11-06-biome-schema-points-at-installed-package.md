# Agent Note: biome.json 的 $schema 指向安装包，不再记第二份版本号

Status: implemented

> **完全取代** [biome.json 的 $schema 由 Renovate 的 customManager 一起升](./2026-11-06-biome-schema-follows-renovate.md)
> （同日的 #545）。那套方案的提取是好的，但它漏掉了「两条分组规则不合并成一条分支」
> 这件事，而这个洞不可能靠再补一条 packageRule 补住——只能把版本号从仓库里删掉。

## Problem

`shinytale/nanopi#561`：Renovate 的依赖 PR（GitHub `NekoSekaiMoe/nanopi#23`，分支
`renovate/npm-dependencies`）把 `@biomejs/biome` 从 2.6.5 抬到 2.6.6、`pnpm-lock.yaml`
跟着改了，而 `biome.json` 的 `$schema` 还停在
`https://biomejs.dev/schemas/2.6.5/schema.json`，CI 因此红在 `check:biome-schema`。

#545 已经给 `renovate.json` 加了 `custom.regex` customManager 提取那个版本号，也加了
配套的 `packageRule`。用 renovate 44.221.6 本地 `--platform=local --dry-run` 复现，
提取本身是好的：`biome.json` 被切成一个 dep，`currentValue` 读出 `2.6.5`，
`newVersion` 是 `2.6.6`。漏的地方在分组：

```json
{ "matchManagers": ["custom.regex"], "matchFileNames": ["biome.json"],
  "groupName": "@biomejs/biome schema", "groupSlug": "biome-schema" }
```

这条规则**自带 groupName**。Renovate 的分组判据是「同一个 groupName 落到同一个
branch」，不是「同一个 depName 落到同一个 branch」——#545 的笔记写的是后者，那是错的。
于是同一次升级被切成两条分支：

- `renovate/npm-dependencies`：`package.json` + `pnpm-lock.yaml`
- `renovate/biome-schema`：只改 `biome.json` 那一行

实测（dry-run，同一份树只改这条规则的 groupName）：

| groupName | Returning N branch(es) | biome.json 那条 dep 的 branchName |
| --- | --- | --- |
| `@biomejs/biome schema`（现状） | 2 | `renovate/biome-schema` |
| `npm dependencies` | 1 | `renovate/npm-dependencies` |

而 `renovate.json` 里 `branchConcurrentLimit` 与 `prConcurrentLimit` 都是 `1`：两条
分支抢同一个坑，npm 组先到先占，单独那条 `renovate/biome-schema` 一直排不上。结果是
lock 升了、`$schema` 没升，正是 #561 看到的现象。

## Decision

`biome.json` 的 `$schema` 改成指向安装包自带的那份 schema，仓库里不再有第二个地方
记录 biome 的版本号：

```json
{ "$schema": "./node_modules/@biomejs/biome/configuration_schema.json" }
```

这样「CLI 是哪个版本」和「配置按哪个版本的 schema 写」在结构上不可能对不上：两者都
来自 lockfile 里那一个版本。biome 官方文档 `$schema` 一节把这种写法列在第一位，带
版本号的 URL 是「编辑器读不到本地文件时」的退路。

配套改动：

- 删掉 `renovate.json` 里那条 customManager 和它对应的 packageRule。没有版本号要
  同步了，留着只会让人以为还需要它们。`regex` manager 那条给 GitHub Actions 的保留。
- `scripts/check-biome-schema.mjs` 从「比对两个版本号」简化成「断言 `$schema` 就是这个
  常量」，并加 `scripts/check-biome-schema.test.mjs` 覆盖三种输入（本地路径通过、
  带版本号 URL 红、字段缺失红）。
- 新增 `biome.json` 时本该跑 `biome migrate --write` 的场景一并消失：实测把
  `$schema` 指向本地包后，2.6.6 的 `biome migrate` 对这份配置报 `no migration needed`。

## Alternatives considered

- **把 packageRule 的 groupName 改成 `npm dependencies`**：能修好 #561 这一次，改动
  也只有两个字段（dry-run 实测合并成 1 条分支）。但它依赖「有人记得新加的 biome 规则
  必须复用 npm 组那个 groupName」这条口头约定：将来再给 `biome.json` 加一条规则、或
  有人重命名 npm 组，同样的漏会静默复发，而 CI 只会在依赖 PR 红了之后才报。根因是
  「版本号有两个事实源」，分组只是它暴露出来的方式。
- **只保留 CI 断言，不做自动同步**：断言已经在了（#545 加的），它保证了 main 上的树
  自洽，代价是每次 biome 升级都要人补一次 `biome migrate --write`。这次就是这么红
  的：依赖 PR 红 → 人工介入。指向本地 schema 之后这条人工步骤直接不存在。
- **`$schema` 指向 `https://biomejs.dev/schemas/latest/schema.json`**：仓库里确实不再
  记版本，但编辑器与 CI 都会按**最新**版本校验，配置里用了旧版才有的键立刻报错，
  且报错时机取决于上游发版，比版本漂移更难查。本地路径没有这个问题：它跟着 lockfile。
- **删掉 `$schema`**：失去编辑器补全与 inline 文档。`$schema` 指向本地文件时，编辑器
  （VS Code 的 JSON language service 与 Biome 自己的 LSP）都能解析相对路径，代价为零。
- **改用 `postUpgradeTasks: "pnpm exec biome migrate --write"`**：托管版 Renovate
  （GitHub App）默认禁用，要用得自建 runner；且那套冷却期会让刚发的包装不上。理由与
  [#545 的笔记](./2026-11-06-biome-schema-follows-renovate.md) 里记的一致，这里不重复。

## Consequences

- biome 升级时 `biome.json` 一个字节都不用改，`$schema` 永远跟着实际装的版本走。
  仓库里少了一条 customManager、一条 packageRule、一个 `check:biome-schema` 里
  `biome --version` 的子进程。
- 代价：`$schema` 依赖 `node_modules` 存在。未安装依赖时编辑器解析不到 schema，退化
  成没有补全——不影响 `biome check`（实测缺 `node_modules` 时 `biome check` 退出码 0），
  也不影响 CI（CI 永远先装依赖）。
- 断言只剩一条判据（`$schema` 必须等于常量），因此它不再能发现「配置写了需要
  migrate 的键」这类退化。那类改动有别的出口：未知键会让 `biome check` 直接硬错，
  废弃键只是 info 但不是缺陷，#545 那版也没管。
- 指向本地文件的写法让 VS Code 与 JetBrains 都能直接读到 schema，「schema 版本落后」
  这个故障类从仓库里消失，`#532`、`#545`、`#561` 三次都属于这个类。

## Verification

- `PATH=node_modules/.bin:$PATH node scripts/check-biome-schema.mjs` 在当前树上退出码 0；
  `$schema` 换成 `https://biomejs.dev/schemas/2.6.6/schema.json` 后退出码 1 并报出常量
  与当前值；删掉字段后退出码 1。
- `node --test scripts/check-biome-schema.test.mjs` 三个用例全绿。
- `biome check --error-on-warnings .` 全仓 1196 个文件 0 error（2.6.5 的 CLI，`$schema`
  指向本地包）。
- 用 2.6.6 的 CLI 对改后的配置跑 `biome migrate --write`：`no migration needed`，
  文件没有变化。对改前的配置跑同一个命令：把 `$schema` 从 2.6.5 改写成 2.6.6。
- `renovate.json` 用 `renovate-config-validator` 校验通过；本地 dry-run 里 `biome.json`
  不再是任何 dep 的 `packageFile`。

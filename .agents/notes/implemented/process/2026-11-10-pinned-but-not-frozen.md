# Agent Note: 依赖钉住靠 package.json 的精确版本，不靠 Renovate 的 rangeStrategy: pin

Status: implemented

## Problem

`renovate.json` 从 `45c3118b2` 起就带着全局 `"rangeStrategy": "pin"`。这条配置的意图是
「钉住依赖」，但 Renovate 的 `pin` 不是「不许动」的意思：

- `pin` 的语义是 **reinstall（其实是 pin）**：它决定 PR 里写哪种 pin 写法——范围当前
  写法、精确版本、还是宽松写法——**不决定新值越过多少 minor**。
- 所以 `pin` 挡不住漂移：Renovate 照样把任何新版本写进 `package.json`，只是写的是精确
  写法而不是 `^x.y.z`。
- 它反而会被读成「依赖不许动」，于是有人想放开升级时先看见的是这一行，而不是真正决定
  漂移速度的那几条。

这台仓库真正在挡漂移的从来不是它：`scripts/check-pinned-deps.mjs` 拦的是 `package.json`
里的范围写法（每个直接外部依赖必须是精确版本），`minimumReleaseAge: 1440` 拦的是刚发布
的版本，`pinDigest` 管的是 GitHub Actions 的 sha。`rangeStrategy: pin` 只是把上面几条
的意图抄了一份，抄歪了。

## Decision

全局 `rangeStrategy: "pin"` 删掉，换成两处显式配置：

- 顶层 `pinDigest: true`：GitHub Actions 的 `uses: owner/repo@<sha>` 由 customManager
  提取，固定的是 sha 而不是版本号。这是「哈希钉住」的那一半，与 npm 的版本写法无关，
  从「全局 pin」里拆出来单列。
- npm 组 `rangeStrategy: "replace"`：依赖的新值就地替换当前写法，明确表示「这里写的是
  精确版本，由 `check:pinned-deps` 维持」，而不是靠 Renovate 的 pin 维持。

`package.json` 里的精确版本不动，`check:pinned-deps` 仍然在 `pnpm run check` 里，它才是
「钉住」的执行者。

漂移由别的开关限制，不靠这一行：

- `config:recommended` 的 major automerge 默认关闭，major 不会自动合进 main；
- npm 组的 `minimumReleaseAge: "1 day"` + `minimumReleaseAgeBuffer: "30 minutes"`
  （见 [renovate 的冷却期必须与 pnpm 对齐](./2026-11-07-renovate-must-wait-as-long-as-pnpm.md)）；
- `branchConcurrentLimit` / `prConcurrentLimit` 都是 1，一轮只进来一个 PR。

## Alternatives considered

- **保留全局 `rangeStrategy: "pin"`**：它现在的输出——精确版本写进 `package.json`——
  与 `check:pinned-deps` 的要求一致，看不出问题。问题在语义：同一件事有两个执行者时，
  弱的那个会被当成强的那个。这次就是有人照着这一行判断「依赖被钉死了」，而实际决定权在
  `minimumReleaseAge` 和 major automerge。
- **改成 `rangeStrategy: "in-range-only"`**：看着最像「不漂移」，但它的语义是「只升
  范围内的版本」，而精确版本里没有范围，结果是所有升级都不再出现——没人改配置也不会红，
  Renovate 只是安静地不再提升级。比 pin 更糟：pin 至少还在提。
- **改成 `"bump"`**：那就是把范围写法写回 `package.json`（`^x.y.z`），`check:pinned-deps`
  立刻红。方向相反。
- **给 `renovate.json` 加注释说明 `pin` 的语义**：JSON 没有注释位，只能塞进 `description`。
  塞了之后那条 `description` 要同时解释「这行不是你以为的意思」，而它本来是个不该留的
  歧义源。删掉歧义比解释歧义便宜。
- **`lockFileMaintenance` 保持 `enabled: false`**：钉住的是 `package.json` 的版本声明，
  lockfile 里的间接依赖（`pnpm-lock.yaml` 的传递依赖）不在其列。关掉之后它们不再有升级
  路径。开启它，让 Renovate 定期把 lockfile 重解一遍，不碰 `package.json`。

## Consequences

- 依赖升级仍然会发生，频率由 `minimumReleaseAge` 与 major automerge 决定，不由版本写法
  决定。行为上没有变慢也没有变快，只是「为什么这样配」不再被一行误导性的 `pin` 掩盖。
- GitHub Actions 的 sha 固定从「全局 pin 顺带管着」变成显式的 `pinDigest: true`。这一项
  一直被 customManager 的 regex 与版本注释管着，本次只是把它写明。
- `lockFileMaintenance` 开启后，Renovate 会周期性开一条 lockfile-only 的 PR。它与 npm 组
  共用 `branchConcurrentLimit: 1`，所以会在依赖 PR 之间排队，不会同时挂两条。
- `check:pinned-deps` 与 `check:renovate-release-age` 都不读 `rangeStrategy`，本次改动不
  影响这两条断言；`renovate.json` 用 `JSON.parse` 校验过是合法 JSON。

## Verification

- `node -e "JSON.parse(require('fs').readFileSync('renovate.json','utf8'))"` 通过。
- `node scripts/check-pinned-deps.mjs`、`node scripts/check-renovate-release-age.mjs` 在当前
  树上退出码 0（两者都不读 `rangeStrategy`，这里是确认没被连带改坏）。
- 逐个检查 `package.json`（7 个工作区包 + `src/extras/*`）：直接外部依赖全部是精确版本，
  所以 `rangeStrategy: "replace"` 的实际输出就是原样替换，不会引入 `^`。

# Agent Note: 绿了不合的真因是 platformAutomerge: false，改回 true 交给 GitHub 原生 auto-merge

Status: implemented

## Problem

`shinytale/nanopi#516` 让「顺便看一下 renovate pr ci 绿却没有自动合并的原因」，
`shinytale/nanopi#419`、`#420`、`#518` 连续诊断过三次，结论都是「分支保护/ruleset
的必选检查名对不上（`ci / build-check-test` vs `Checks / build-check-test`），仓库侧
能做的做完了，剩下只有管理员能在 GitHub 网页改 ruleset，仓库读不到也写不了」。
于是每次都把球踢给用户。yast 在 #419 里回「何意味，加一个 action 自动合并很难吗」，
在 #518 合并后直接要求「那个 pr 没自动合你开一个 pr 修一下」。

现象（GitHub 侧实测）：`renovate.json` 的 npm 组与 Actions 组从 `45c3118b2` 起就
`automerge: true` / `automergeType: "pr"`，但 GitHub `NekoSekaiMoe/nanopi#3~#17`
的合并提交 author 全是 `dabao1955`（人工），没有一条是 `renovate[bot]`。#17 时间线
`12:23:50 auto_merge_enabled` → `12:23:56 auto_merge_disabled` → `12:24:06 merged
by dabao1955`：人开着 GitHub 原生 auto-merge 等不到结果，6 秒后关掉手点合并。

## 实测证据（推翻 #419/#420 的诊断）

GitHub API 匿名可读（公开仓库），查到的与旧笔记写的不一样：

- **ruleset 不是读不到**：`GET /repos/.../rulesets` 返回 ruleset `26337009`（名 `a`、
  `enforcement: active`、`~DEFAULT_BRANCH`）。`GET .../rulesets/26337009` 的
  `required_status_checks` 只有一条：`context: "build-check-test"`、
  `integration_id: 15368`（指向 GitHub Actions app），
  `strict_required_status_checks_policy: true`。创建于 2026-11-02 02:00，即 #419/#420
  期间管理员已经把分支保护换成了 ruleset。旧笔记写的 `ci / build-check-test`、
  #420 说的「改名后要同步改成 `Checks / build-check-test`」都不是仓库里真实的值。
- **必选检查名早就对得上**：#17 head `3727ec7bb` 的
  `GET .../check-runs` 有 `build-check-test`（`success`，app `github-actions`/15368）
  与 `CodeRabbit`（`skipped`）。check-run 的 `name` 就是裸 job 名
  `build-check-test`，与 ruleset 的 `context` 一字不差。GitHub 侧的合并闸门是满足的。
- **combined commit status 是 `pending`、0 条**，因为 GitHub Actions 的结果只落在
  Checks API（check-runs），不写 Status API。但这一点并**不是** Renovate 不合的原因：
  读 Renovate 源码 `lib/modules/platform/github/index.ts::getBranchStatus`，它在
  check-runs 非空时按 `commitStatus.state===success || statuses.length===0` 判
  `isCommitStatusOk`，再要求所有 check-run conclusion 属于
  `success/neutral/skipped` 才返回 `green`。#17 的 `statuses.length===0` 且两条
  check-run 都满足 → `getBranchStatus` 返回 `green`。「combined status pending 挡住
  automerge」这个直觉是错的，别再拿来当结论。

## Decision

**把两个 automerge 组的 `platformAutomerge` 从 `false` 改回 `true`。**
`automerge: true`、`automergeType: "pr"`、`groupName` 拆分等都保持不变。

`platformAutomerge` 默认就是 `true`（Renovate
`configuration-options`：`Controls if platform-native auto-merge is used`，
`default: true`，github 在 supportedPlatforms 里）。是 #419 的决定「让 Renovate
自己在 CI 之后合，不用 GitHub native auto-merge」把它显式关掉了，关掉之后：

- `getPlatformPrOptions` 里 `usePlatformAutomerge = automerge && (pr|branch) &&
  platformAutomerge` 为 false，Renovate 创建 PR 时**不会**调 GitHub 的
  `enablePullRequestAutoMerge` mutation；
- 合并走 `checkAutoMerge`（`lib/workers/repository/update/pr/automerge.ts`），
  而 `lib/workers/repository/update/branch/index.ts` 只在
  `config.ignoreTests === true || !commitSha`（这一轮没产生新 commit）时才调它；
  `checkAutoMerge` 还要 `pr.cannotMergeReason` 为空、`getBranchStatus()==='green'`、
  `scm.isBranchModified` 为假，最后由 `platform.mergePr` 过 ruleset。任何一个时序
  不满足就是 `BranchNotGreen`/`PlatformRejection`，这一轮不合，下一轮再来。
- 实测结果就是「从未有一条 bot 合并」：自合并路径依赖 Renovate 轮询时 PR 恰好
  up-to-date 且无新 commit，而分组 PR 每轮常在更新分支，条件很难凑齐。

`platformAutomerge: true` 时 Renovate 走另一条路：

- `getPlatformPrOptions` 给 `usePlatformAutomerge=true`，`createPr` 末尾
  `tryPrAutomerge` 调 `enableAutoMergeMutation`（源码 `github/index.ts`），把合并
  交给 GitHub；有新的分支 commit 时 `branch/index.ts` 调
  `reattemptPlatformAutomerge` 重新 enable，不靠「恰好没 commit」那一轮。
- GitHub 原生 auto-merge 评估的是 ruleset 点名的 check-run（`build-check-test`
  success 即可）+ ruleset 其它规则，条件满足就自动合，不受 Renovate 轮询节奏影响。
- #17 timeline 里能 `auto_merge_enabled` 成功，说明仓库 Settings 的
  `Allow auto-merge` 是开着的；`tryPrAutomerge` 也会检查 `config.autoMergeAllowed`，
  关了就静默跳过（这条是合并前要核对的唯一仓库外前提，匿名 API 读不到该设置位）。

顺带纠正文档：`checks.yml` 文件头旧注释把必选检查说成「`<工作流名> / <job 名>`
全名、改名后必须同步改 ruleset」，与实测不符。改后写清「ruleset 匹配的是 check-run
的 name 即 job 名 `build-check-test`，与工作流 `name:`/文件名无关；真正决定绿了能不
能合的是 `platformAutomerge`」。文件名 `checks.yml`、工作流名 `Checks` 保留不动——
它们只是 #420 的命名统一，不是闸门。

## Alternatives considered

- **继续按 #419/#420 的说法改 ruleset 必选检查名**：实测 ruleset 的 `context` 已是
  `build-check-test`、与 check-run 名一致，没有「对不上」可改。而且匿名 API 能读
  ruleset，「仓库读不到也写不了」这个前提本身是错的。再把用户叫去改设置，下一次
  绿了还是不合。
- **把 `automergeType` 改成 `branch`（CI 绿了直推 main）**：能绕开 PR 合并路径，但
  #420 笔记已否过——它绕开了 PR 记录，且历史上已从 branch 改成 pr（见
  [依赖升级按可验证分两批](../process/2026-10-27-renovate-minor-major-split.md)）；
  ruleset 的 `non_fast_forward` 也会拦直推。
- **给 `checks.yml` 加一步往 Status API 写 commit status**：治不了根。
  `getBranchStatus` 在 check-runs 全绿、`statuses` 为空时本就返回 `green`（源码
  已核），自合并路径卡的是轮询时序/`mergePr`，不是 combined status 的 `pending`。
- **再加一个「自己的 action」自动合并**：#419 里已否过——它自己也得先过必选检查，
  真要绕过分支保护就得往 Actions 塞一把能推 main 的 PAT/App 钥匙，拿安全换几秒。
  仓库里已有 PR Gate、merge-result，多一层只会多一个可坏的环节。
- **什么都不改，继续人工合**：现状，4+ 次手工合并，正是这次要修的东西。

## Consequences

- 两个 automerge 组（npm、Actions sha）现在由 GitHub 原生 auto-merge 合：check-run
  `build-check-test` 变绿、ruleset 其它规则满足后自动合，不再等人手点。
- 这条改动只动 `renovate.json` 与文档/注释，仓库内可落地、可复核，不需要管理员改
  ruleset。代价是合并动作从「Renovate 用 App token 合」变成「GitHub 合」，提交
  author 会是 GitHub 的合并行为而非 `renovate[bot]`——这是原生 auto-merge 的正常
  表现，不再是「没自动合」的证据。
- **合并前唯一要核对的仓库外前提**：GitHub 仓库 Settings 的 `Allow auto-merge`
  必须为开。`tryPrAutomerge` 在 `config.autoMergeAllowed` 为假时会静默跳过，症状会
  退回「绿了不合」。匿名 API 读不到该设置位，#17 能 `auto_merge_enabled` 说明当时
  是开的；若合并后仍不合，第一步查这个开关，第二步 `gh pr checks <PR>` 看
  `build-check-test` 是否 success，而不是再去看 ruleset 名字。
- `strict_required_status_checks_policy: true` 仍要求 PR 与 base 同步；GitHub 原生
  auto-merge 会在落后时等待/合并 base，比 Renovate 自合并的「恰好没新 commit」窗口
  宽松，但不等于完全不受 rebase 影响。
- #419、#420、#518 的旧诊断留在 git 历史里，本笔记与
  [必选检查的名字带着工作流名](../process/2026-11-02-required-checks-name-carries-workflow-name.md)、
  [engines.node 改回 enabled: false](2026-11-05-engines-allowedversions-regression.md)
  就地同步，避免下次照着「必选检查名对不上/要管理员改设置」再走一遍。

## Verification

- GitHub API 实测（本笔记 Problem / 实测证据两节）：ruleset `26337009` 的 context、
  #17 head 的 check-runs 与 combined status、#3~#17 合并 author、#17 timeline。
- `renovate.json` 两组 `platformAutomerge: true`，仍是合法 JSON。
- `renovate.json` 字段语义对照 Renovate main 分支源码：
  `lib/config/options/index.ts`（`platformAutomerge` 默认 true）、
  `lib/modules/platform/github/index.ts`（`getBranchStatus`、`tryPrAutomerge`、
  `enableAutoMergeMutation`）、
  `lib/workers/repository/update/pr/automerge.ts`（`checkAutoMerge`）、
  `lib/workers/repository/update/branch/index.ts`（`!commitSha` 才调 checkAutoMerge、
  `reattemptPlatformAutomerge`）、
  `lib/workers/repository/update/pr/index.ts`（`getPlatformPrOptions`）。
- 合并后观察下一条 Renovate PR：`build-check-test` 变绿后应出现 `auto_merge_enabled`
  且由 GitHub 自动合并，不再出现 `merged by dabao1955`。

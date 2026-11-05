# Agent Note: 必选检查的名字带着工作流名，所以 CI 工作流不能叫 ci.yml / CI

Status: implemented

> **已被推翻（2026-11-05，`shinytale/nanopi#518` 之后重查）**：本篇把「绿了不合」
> 归因为「分支保护必选检查名 `ci / build-check-test` 与工作流全名对不上」，并据此
> 把工作流改名 `checks.yml` / `name: Checks`、要求管理员同步改 ruleset。GitHub API
> 实测不支持这条因果：ruleset `26337009` 的 `context` 是裸 `build-check-test`、
> `integration_id=15368`（GitHub Actions），与 check-run 名（job 名）一字不差，
> 且 ruleset 匿名可读；改名与「同步改 ruleset」都不是必要的。真因是
> `renovate.json` 的 `platformAutomerge: false` 让合并依赖 Renovate 自合并的轮询
> 时序，已改回 `true` 交给 GitHub 原生 auto-merge。改名本身保留（命名统一，无害），
> 但本篇关于「必选检查名带工作流名、改名才能对上」的结论不再成立。见
> [绿了不合的真因是 platformAutomerge: false](../bug-fix/2026-11-05-renovate-platform-automerge.md)。

## Problem

`renovate.json` 从 `45c3118b2` 起就在给 npm 依赖和 GitHub Actions 的 sha 开
`automerge`（`automergeType: "pr"`、`platformAutomerge: false`，让 Renovate 自己在
CI 之后合）。实际跑下来一次都没自动合过：4 个 Renovate PR 全是 `dabao1955`
手工点的 merge，第 2 个起它的分支其实是「把 1 个新 action 的 sha 重新算一遍」——
分组后整份 workflow 文件的 regex 一起重算，把上一个 PR 刚推上去的 sha 也带上。

表面看是「CI 绿了但没合」。真实原因是名字对不上：GitHub 上一条检查的**全名**是
`<工作流名> / <job 名>`，而分支保护里记的是 `ci / build-check-test` —— 是小写的
`ci`，不是工作流 `name: CI` 的大写。`ci.yml` 这个**文件名**被当成了工作流名。
Renovate 的 automerge 只等分支保护点名的那几条检查（不是「这个 head 上所有检查」），
一个跑得再绿也匹配不上的检查等于没有，于是它每轮都判定「还差一条」，PR 就一直躺着。

`x-access-token` 这侧读不到仓库的 ruleset，这条因果链只有 `dabao1955` 能核。
能核的是症状与名字的关系：`Checks / build-check-test`（期望）与
`ci / build-check-test`（实际）。

## Decision

工作流改名成 `checks.yml`、`name: Checks`：

- 必选检查名随之变成 `Checks / build-check-test`，与文件名对得上，不再靠「某个
  地方记住了小写的 ci」这种巧合。
- 文件名与 `name:` 用同一个词，同一个概念只剩一个名字。
- 文件头写明「不能改回 ci.yml / CI」以及为什么，免得下一次格式化把它改回去。

改名是一次性的同步动作：GitHub 的 ruleset / 分支保护里的必选检查也得改成
`Checks / build-check-test`。只改仓库不改设置，所有 PR 会卡在一条永不出现的检查上。

顺带把 `renovate.json` 里 GitHub Actions 那组拆掉（`groupName: null`）：sha 固定
改一个 action 时整份文件的 regex 都会重算，分组会让 Renovate 每合一次就重建上一次
的 PR 分支，而重建出来的分支不带 automerge。

## Alternatives considered

- **把工作流 `name:` 改成小写 `ci`**：让检查名变成 `ci / build-check-test`，与既有
  分支保护一致，零设置改动。但「小写的 ci 是工作流名」还是同一个巧合，下一份配置
  写 `CI` 就又对不上，而且这个名字是在 GitHub 上唯一定下来的，从仓库里看不出来。
- **什么都不改，等人手动合**：现状。4 个 PR、4 次手工合并，每次都还得重新 rebase
  下一个 action 的 sha。
- **改成 `automergeType: "branch"`（CI 绿了直推 main）**：绕开分支保护就不会再撞
  名字。但它也绕开了 PR 这条记录，而且这里历史上已经从 branch 改成过 pr（见
  [依赖升级按可验证分两批](./2026-10-27-renovate-minor-major-split.md)），改回去是
  在同一个坑里来回走。

## Consequences

- 合并顺序是有依赖的：先在 GitHub 上把必选检查改成 `Checks / build-check-test`，
  再让这个 PR 合并。否则从合并那一刻起所有 PR 都等一条不存在的检查。
- 设置侧的真相仍只在 GitHub 仓库设置里，仓库里能查到的只有这条约束本身。再出现
  「绿了不合」时，第一步该比对的是 `gh pr checks` 里的名字与分支保护里的名字，
  而不是 Renovate 的日志。
- 工作流改名不影响 `push` 触发、`concurrency` 分组与各 job 内容，也不影响
  `.cnb.yml`（CNB 侧不跑 GitHub Actions）。

## Verification

- `git grep -n "workflows/ci.yml"` 只剩零命中；`.agents/notes` 里两处旧路径同步改成
  `checks.yml`。
- `renovate.json` 仍是合法 JSON，Actions 组的 `groupName` / `groupSlug` 为 `null`。
- PR 合并后看第一条 Renovate PR：分支保护里的 `Checks / build-check-test` 变绿之后
  自动 merge。

# Agent Note: 失败的构建报成 Issue，由 @CodeBuddy 接手

Status: implemented

## Problem

Issue #319：CNB 上的红没人管。翻 10-25 之后的记录，`merge-result` 在 PR #255、#294、
#313 上留的红在 PR 合并之后仍然挂着：

```
cnb/tq0-1k5s2s3de #255  error [14.7s]   merged
cnb-d5k-1k5tfrn64 #294  error [13.5s]   merged
cnb-b8j-1k5tkk317 #313  error [15.9s]   merged
```

#313 是典型：#311 只是把 `docs/assets/linux-do.png` 挪进 `packages/coding-agent/docs/`，
`check-merge-result` 的基线取错（#314）报了「删掉一个文件」。修 #314 的那个 NPC 会话
（`cnb-q3u-1k5tkr1aj`，19 分钟）顺手把整条流水线在本机重跑了一遍——不是因为平台把
失败丢给了它，而是因为有人恰好在那个时候提了另一个 Issue。红的与修它的中间隔的就是
「下一个会话碰巧看这儿」。

平台能给的信号只有 PR 上的状态，而这条状态写的是**合并预演的结果**，不是源分支自己的
结论：它既写不回源分支，也没有事件能读懂它。CNB 没有「构建失败时跑一段」的事件，
`endStages` 是唯一在 stages 失败后仍会执行的东西。

## Decision

每条 pipeline 的 `endStages` 挂一段 `report-failure`（`.cnb.yml` 的
`x-notify-failure` 锚点），跑 `scripts/report-failed-check.mjs`：

- **判不判**由脚本读构建状态决定：`cnb build get-build-logs --sn $CNB_PIPELINE_ID`
  返回 `error` 才继续。`endStages` 不继承 stages 的结论，所以「全挂上」是安全的。
- **报给谁**：一条普通 Issue，标题 `CI 红：<分支>`，正文第一行 `@CodeBuddy`。
  Issue 是唯一能拉起 NPC 的载体——`issue.comment@npc` 在默认分支最新提交上跑，
  而这个仓库的 `issue.comment@npc` 会先 `pnpm install` + `pnpm prepare` 装 hooks，
  源分支的 checkout 承载不了（PR 的源分支同理）。
- **报几次**：正文里埋 `<!-- failed-check <sha> -->`，同一条分支的同一个提交只报一次；
  新提交又失败就在同一个 Issue 上追加评论，不刷屏。
- **钩子不能改结论**：`allowFailure: true`，脚本自己出错也只打印。

## Consequences

- 失败从「下一个碰巧路过的人」变成「Issue 里排队」。一条分支一条 Issue，修完整条
  分支红了再红就追加，人工关掉即可。
- 代价是每条流水线多一个 30 秒的 job（装 node + cnb-cli + 读构建状态），绿的构建
  也照跑，因为 `endStages` 判断不了前面是绿还是红。可以接受：这些 pipeline 本来
  就是几十秒到分钟级。
- 这条钩子自己也在被报的范围内（它挂在 NPC 流水线的 `endStages` 上），但它的
  `allowFailure` 与「读不到状态就退出 0」把自激锁住了。另外 Issue 评论超过 100 条
  之后 `@npc` 不再触发，所以一条分支反复红到 100 次会停在「有人看得见但 NPC 不接管」
  的状态——比悄悄红着强。
- `CNB_TOKEN` 在 `endStages` 里的写权限靠 `env.CNB_TOKEN_SCOPE` 声明，这一项要是
  平台不认，Issue 就开不出来；表现是日志里 `errcode` 而非构建变红，能一眼看出来。

## Alternatives considered

- **让 PR 的 `pull_request.comment@npc` 去修**：PR 的源代码是源分支，装不了本仓库
  的 NPC 依赖（hooks 就没装过，提交会丢 `Change-Id`）；而且要人为在 PR 里再 @ 一次，
  等于没解决「没人管」。
- **复用上一条同类 Issue，把新失败写成评论**：可以，但「哪条分支」得靠标题或正文
  约定反查，而 CNB 的 Issue 搜索会误匹配；一条分支一条 Issue 更好读，关闭也直观。
- **`cnb:apply` 触发一条 `api_trigger` 的 NPC 流水线**：`cnb:apply` 不在
  `endStages` 的可用事件里（它列的是 push/PR/tag/crontab 等），走不通。
- **不管 GitHub 侧**：那边的 CI 本来就会在 PR 上留结论，而且失败的推送根本到不了
  GitHub（镜像在 CNB 侧，失败就断了），不需要镜像式处理。

## Verification

`scripts/report-failed-check.test.mjs` 用假 `cnb` 钉住四件事：绿的构建不出 Issue、
失败的构建开一条带 `@CodeBuddy` 的 Issue、同一提交不重报、新提交追加到既有 Issue。
`node --test scripts/report-failed-check.test.mjs` 6 passed；`pnpm run check` 除
`packages/coding-agent/src/utils/sidecars.ts:205` 的既有类型错误（#317 在修，干净
checkout 同样复现）外全绿。

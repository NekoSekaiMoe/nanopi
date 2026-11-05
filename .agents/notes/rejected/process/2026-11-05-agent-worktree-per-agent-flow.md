# Agent Note: 每 agent 一棵 git worktree 的流程（被否，只剩「合回前自检」待议）

Status: rejected — 「每个 agent 自己开 worktree、review 完修完再合回分支」在 nanopi 里已有三分之二是现成的（`isolated` 建树、PR 流程、pre-commit 体检），真缺的只有「子 agent 的 worktree 分支合回主树之前先自检」这一步；写进 `AGENTS.md` 当全局规则、或强制主会话每 session 一棵树，代价都大于收益。本文件只作占位，提案正文等新 issue 开出来后搬过去。

## Problem

ISSUE #501（承自 shinytale/nanopi#499 的后续）里已经否掉整包吸收 `pi-task-governor` / `pi-smart-flow`。讨论中间提出的替代形态是「每个 agent 自己弄一棵 git worktree，review 完、修完再合并到对应分支，体检前再检查一遍」。

这条形态不能当全局规则写下来的原因，是它把三件已经各自成立的事拼成了一套强制流程：

- **worktree 隔离**：`pi-subagent-mini` 的 `isolated: true` 已经是 `git worktree add -b subagent/<jobId>`（`packages/coding-agent/src/extras/pi-subagent-mini/src/index.ts` 的 `createWorktree`），建、删都由工具负责，模型不用自己发明目录。
- **review 完修完再合并**：在 nanopi 里这就是 PR：worktree 一条分支 → PR → 评审 → 改 → 合。平台已经有这条路径。
- **体检前再检查一遍**：`.husky/pre-commit` 已经跑 `pnpm run check`，`.husky/commit-msg` 补 `Change-Id` / `Signed-off-by`。再加一道同名检查等于第三次跑同一批命令。

## Proposal（被否的原方案，保留以便对照）

把上面三步写成 `AGENTS.md` 的强制流程：每个 agent（含主会话）动手前先 `git worktree add`，改动只在树内提交，review 与修复完成后才允许合回目标分支，合并前重跑一次体检。

真实缺口只有一条，且只发生在 `isolated` 子代理身上：

`removeWorktree(job, baseCwd, merged)` 在 job `completed` 时直接 `git merge --no-edit subagent/<jobId>`。合并是「整段 accept」——脏树、半成品、没过 check 的改动一并进主树，父 agent 看不到改动清单，也不参与判断。

要补的就是这一步：合回前先自检

- `git status --porcelain` 干净（子 agent 自己没留下未提交的残渣）
- 改动文件清单进报告（父 agent 看得见这次合了什么）
- `pnpm run check` 通过

任一条不满足就不合并，把失败原因和改动清单交给父 agent 决定（保留分支或丢弃）。边界清晰，不碰主会话的工作树布局。

## Alternatives considered

### 写进 `AGENTS.md` 当全局规则

最强理由是「规则只有写在模型每次都读的地方才生效」，而这确实能保证每个 agent 都开树。

否决：它把一条**只在子代理无人值守场景才需要**的约束，摊到所有人所有任务上。主会话本来就独占工作区，再开一棵树只是把路径换个地方；而「先开树再干活」会让每次小改动多一层 git 状态需要维护、`pnpm` 安装需要共享、编辑器与 LSP 的根目录要对。规则的成本按 session 计，收益只按 `isolated` 子任务计。

### 强制主会话每 session 一棵树

最强理由是彻底隔离：多会话同 cwd 时谁也不会碰到别人的未提交改动。

否决：`AGENTS.md` 的 Git 规则已经用「只 commit 自己改的文件」处理了同一件事，代价是一句话；换成一棵树就是把解法从「约定」升级成「基础设施」，而这个仓库的日常是单人单会话。另外 NPC / CI 场景本来就每次全新容器，树是多余的。

### 把 `isolated` 改成默认开

最强理由是省掉调用方每次显式传参，隔离变成默认正确行为。

否决：`isolated` 的语义不只是隔离，还包含「完成即合并、非完成即删分支」这个自动收尾。默认开启等于让每个子任务都直接落进主树，与「先自检再合并」正好相反；而且非 git 目录、只读侦察类子任务（`read` / `grep` 型）根本不需要树。默认值应留空。

## 待议

「合回前自检」这一条单独立项讨论，判据是：有没有人真的被脏树 / 半成品合进主树坑过。没有这个证据之前不排期，本文件只占位。

# Agent Note: Change-Id 只能本地生成，CI 只报告

Status: implemented

## Problem

仓库要求每个提交带 `Change-Id`，实现是 `.husky/commit-msg`（Gerrit 3.13.1 原版脚本）。但这条要求实际从未被强制过：

- `refs/heads/main` 的 6938 个提交里只有 58 个（0.8%）带 `Change-Id`，时间戳紧挨着有、无交替。也就是说它一直靠「提交时那台机器恰好装了 hook」续命。
- CNB 上直推的 `43d44de87`（GitHub 镜像 CI 本身的改动）同样没有 `Change-Id`，说明连维护者自己也没走这条路径。
- `.cnb.yml` 只做 GitHub 镜像，对提交信息零校验；`Signed-off-by` 同样没有任何 gate。

「从 Init 开始每个提交都有」这个诉求需要先分辨清楚能做到哪一步：CNB 不执行本地 git hook，也没有修改已推送提交信息的 API（`cnb git get-commit` 只有只读 `verification`；commit annotations 是 key-value 元数据，不是 trailer）。在流水线里重写历史再推，GitHub 侧会拒绝非 fast-forward —— 而双方普通 push 正是刻意的设计（见 `.cnb.yml` 顶部注释）。因此「补齐历史」只能重写已发布历史，代价远大于收益。

## Decision

两条腿：本地 hook 负责**生成**，CI 负责**报告**。

`.husky/commit-msg` 保持原样（Gerrit 脚本，追加 `Change-Id` + 按需 `Signed-off-by`），由 `pnpm prepare` 经 husky 设置 `core.hooksPath` 注入。这是唯一能真正写入 trailer 的位置。

`scripts/check-commit-trailers.mjs <before> <after>` 在 `.cnb.yml` 的 `check-commit-trailers` stage 里跑，范围是 `git rev-list --no-merges <before>..<after>`。`<before>` 取 `CNB_BEFORE_SHA`：第一次推送该分支时平台给全 0，此时退回 `--max-parents=0`（根提交，即 Init），覆盖到「从 Init 起」这个上界。force push 丢掉旧 tip 时同样退回根提交，而不是误报整个历史。

**缺 `Change-Id` 只打印、不 fail。** 原因是它不可由 CI 修复：本地没装 hook 的贡献者（或直接推 CNB 的维护者）是唯一能补的人，硬失败只是给所有人一个他们无法自行解除的红灯。日志里给出 `git commit --amend -s` 的准确命令替代拦截。`Signed-off-by` 已在 merge base 上的多数提交里存在，暂不作为硬性 gate。

镜像 stage 在 push 前断言 `git merge-base --is-ancestor HEAD FETCH_HEAD`，非 fast-forward 时 `exit 1`。「push 失败」之前一直表现为日志看起来成功、GitHub 上还是旧内容。

`AGENTS.md` 的 Committing 段加一条：提交用 `git commit -s`，或依赖 `.husky/commit-msg`，两者都产生 `Change-Id` + `Signed-off-by`；并说明 CI 补不了。

## Alternatives considered

- **在 CNB 流水线里 `git filter-branch` 重写历史再 push。** 能真正补齐从 Init 起的 `Change-Id`，但会重写 6880 个已发布提交，而 GitHub 镜像明确不接受非 fast-forward（`.cnb.yml` 刻意去掉 `--force` 就是为了避免和 GitHub 侧推回 CNB 的 workflow 互相覆盖）。收益是一个没人消费的 trailer，代价是历史重写 + 镜像流程作废。
- **CI 里 `base64` 提交信息 + webhook 回写。** 需要引入额外服务保存凭证并承接重写逻辑，且平台无 API 写回 commit message，最终仍要走 force push —— 被上一条否掉。
- **把缺失 `Change-Id` 设为硬失败。** 规则的意图被守住，但执行成本落在无法修复它的人身上：本地未装 hook 的贡献者拿不到任何自助手段，维护者直推 CNB 也会被自己的 gate 拦下（`43d44de87` 就是先例）。报告 + 可复制命令是当前唯一自洽的强度。
- **顺带改为校验 Conventional Commits subject + 强制 `Signed-off-by`。** 更贴近仓库实际约定（`feat(ai,tui): …`），但 `Signed-off-by` 的硬 gate 会先炸维护者的直推，采纳时机不对；本次只做 `Change-Id` 报告。
- **修 `.husky/commit-msg` 里 `^[a-z][a-z]*! ` 的 squash 判断。** 只匹配 `feat! `，而本仓库的 `feat(scope): …` 不匹配，`squash!`/`fixup!` 也被匹配不上（`#` 注释行先被 `git stripspace` 剥掉）。属于真实缺陷，但它只在「hook 真的执行」时才可见 —— 而当前多数机器上并不执行，因此不在本次范围内。

## Consequences

- CNB push 的日志里会稳定出现一行 `Checked N commit(s); M without Change-Id`，M 长期非 0 就是「本地 hook 没生效」的信号。
- 「从 Init 起每个提交都有 Change-Id」在 CNB 侧永远无法达成，只能保证 Init 之后新增的提交能被检查到。这是平台能力边界，不是实现取舍。
- 本地 clone 需要 `pnpm install` 才会注入 hook；`--ignore-scripts` 安装或直接推 CNB 都不会有 hook，只能靠 CI 报告的这行日志发现。
- 镜像 stage 多一次 `git fetch` 和一次 ancestor 判定；非 fast-forward 会在 push 前就失败，不再出现「日志成功、远端未更新」。

Related: [single-file release artifact](2026-10-11-single-file-release-artifact.md)（同一类「发布流程与镜像」的工具链改动）。

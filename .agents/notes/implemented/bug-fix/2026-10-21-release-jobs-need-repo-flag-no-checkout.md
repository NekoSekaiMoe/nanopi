# Agent Note: 发版流水线的 gh 调用用 `-R` 定位仓库，不补 checkout

Status: implemented

## Problem

tag push 确实触发了 `build-binaries.yml`：`build` 和 `smoke-test-single-file` 都跑完了，
但 Release 从来没出现过。现场是 tag 打上去、Actions 有记录、没有 draft、也没有公开 release。

原因不是触发条件，是 `stage-github-release` 一开始就失败。gh 的 `release create` 在
`RepoOverride == ""` 时会执行 `git tag --list <tag> --format=%(contents)` 去取 tag 注解
（见 `cli/cli` 的 `gitTagInfo`），用来决定「用 tag 注解当 release notes」这个选项。这一步用
本地 git 跑，而 `stage-github-release`、`publish-github-release`、
`cleanup-draft-github-release` 三个 job 都没有 `actions/checkout`，工作区里没有 `.git`，
于是：

```
fatal: not a git repository (or any of the parent directories): .git
```

`gitTagInfo` 的 error 被丢弃（`tagDescription, _ = ...`），但子进程的 stderr 照样打印。
真正致命的是更早的仓库定位：`gh` 的 `BaseRepo` 来自 `RemoteSet`，`git remote -v` 在非仓库
目录里同样退出 128，`opts.BaseRepo()` 返回 error，`createRun` 直接返回，命令什么都不做。

`GH_REPO` 只能救一半：`OverrideBaseRepoFunc` 在 `--repo` / `-R` 为空时读 `GH_REPO` 顶替
`BaseRepo`，但 `opts.RepoOverride` 仍是空串，`if opts.RepoOverride == ""` 那段本地 git 分支
照跑。所以设了 `GH_REPO` 也躲不过非仓库目录。

这条路径从 workflow 落地起就没成功过，tag push 和 `workflow_dispatch` 都命中同一段代码。
`.nanopi/skills/release.md` 里「打 tag 就会出 release」的说法与实际不符。

## Decision

三个 job 的 gh 调用显式带 `-R ${{ github.repository }}`（每个 step 的 env 里定成
`GH_REPO_FLAG`，避免在 run 块里重复），不新增 checkout：

- `gh release view` / `delete` / `create` / `edit` 一律带 `-R`。
- `-R` 非空 ⇒ `opts.RepoOverride` 非空 ⇒ `gh` 跳过 `gitTagInfo`、`git rev-parse --show-toplevel`、
  `gh repo set-default` 那一整套本地 git 探测，仓库信息全部走 API。
- `GH_REPO` 保留：`-R` 优先于它，留着只是让 `gh` 在没有 `-R` 的子命令上仍有默认仓库。

判定标准不变：`--verify-tag` 查的是远端 tag 存在性（GraphQL），与本地无关，所以
「draft 建好 → 资产名集合核对 → `--draft=false` 发布」这条链在无 checkout 下完整可用。

## Alternatives considered

- **给三个 job 加 `actions/checkout`。** 最贴近 gh 默认假设，但 checkout 只为了给三个纯 API
  调用提供一个 `.git`，还会带进一份与构建无关的源码；`cleanup-draft-github-release` 是失败兜底
  路径，它出错的概率应当尽量低，多加一个 action 就是多加一次失败机会。`build` 里已有 checkout，
  但跨 job 不共享工作区，救不了它们。
- **只设 `GH_REPO`，不加 `-R`。** 如上，`RepoOverride` 仍为空，本地 git 分支照跑，实测不解决。
- **`gh release create` 去掉 `--notes-file`，改用 `--generate-notes` 走 Release Notes API。**
  与缺陷无关（缺陷在仓库定位，不在 notes），而且 release notes 由
  `scripts/release-notes.mjs` 从 CHANGELOG 提取，换成 API 生成等于改发版内容。
- **在每个 step 里 `git init` 造一个空仓库。** 能让 git 命令不报错，但 `git tag --list` 为空，
  `--verify-tag` 之外的 tag 相关行为全部退化，属于用假环境骗过检查。

## Consequences

- 三个 job 不再依赖工作区是否是一个 git 仓库，`workflow_dispatch` 的恢复路径同样修好。
- 代价：`-R` 是硬编码在 workflow 里的，`fork` 后跑 release 需要同步改；但这份流水线本来就只服务
  本仓库的 tag 发布，可接受。
- 这条缺陷的失败方式是「静默」：job 报红但结论是「tag 没触发」。日后调试「push 了 tag 却没
  release」时，先看 Actions 里 `build-binaries.yml` 有没有那次运行，再看 `stage-github-release`。

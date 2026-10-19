# Agent Note: main 镜像按内容判定，不再用 ancestor 断言当门

Status: implemented

## Problem

`cnb-d52-1k59036gg`（`#62` 合并后的 push）的 `push main` 立刻失败，没有 push、也没有远端输出：

```
[+795ms 00:00:21] fast-forward: ef9a16abadef46f98d7610bc99ddc27a26e9b8ca is ahead of https://github.com/NekoSekaiMoe/nanopi.git main
[+57ms  00:00:21] exit code: 1, signal: -1, duration: 852ms
```

`fast-forward` 那行是 `#62` 之前 `push main` 的输出（`#62` 已把这段改成在 fetch 之后判定），
之后没有任何远端输出：stage 以 signal 结束。这次失败与 `#62` 的改动无关 —— 同一条链路在
`#58` 之后就没再通过过，`#62` 只是又踩了一次。

根因不在 push protection（树里早已没有明文），而在上一条决策给的条件永远不成立：

1. `2026-10-19-push-protection-mirror-diverges-main` 修好第一次推送之后，GitHub 的 main 是
   「GitHub tip 上的合成提交」，CNB 的 main 是 `4c28fa80b → 08b8333f5 → …` 这条原历史。
   两侧树相同，sha 及祖先关系永久分叉。
2. 下一次镜像的 `guard` 要求 `git merge-base --is-ancestor FETCH_HEAD HEAD`，而这个分支只在
   「远端 tip 是本地 HEAD 的祖先」时成立（即 CNB 是 GitHub 的严格上游），此时它恒假。
3. 于是走到「上次推的是合成提交」那个分支，推 `git commit-tree HEAD^{tree} -p HEAD -p FETCH_HEAD`：
   一个以 HEAD 为父的合并提交。远端要收下它就必须收下 HEAD 的整个祖先链，`08b8333f5` 也在里面，
   push protection 于是再拦一次；而这条链在 GitHub 侧永远不可能被接受，所以它每次都会拦。
   等 `git fetch` 补回 `--depth` 限制之外的对象（runner 的 clone 是浅的，fetch 时才补齐历史）
   之后，这次 push 直接以 signal 结束，日志里连 GH013 都没留下。

## Decision

`.cnb.yml` 的 `push main` 去掉「已知被拦提交名单」那一整套分支判断，改成按内容判定：

1. `FETCH_HEAD^{tree}` 与 `HEAD^{tree}` 相同：没有可推的，打印后 `exit 0`。
2. 否且 `FETCH_HEAD` 是 HEAD 的祖先：快进，`git push HEAD:refs/heads/main`。
3. 否则推 `git commit-tree HEAD^{tree} -p FETCH_HEAD`。单父，父是远端 tip，树取本地 HEAD 的，
   历史虽分叉但内容一致；push protection 扫的是本次通告的提交集合，这条链上不含 `08b8333f5`。
4. 推送后照旧回读远端树逐字节比对。

合并提交（`-p HEAD -p FETCH_HEAD`）不能再用：父是 HEAD 就等于把待推区间原样交出去，
上面第 3 条的分支条件再看历史包含关系毫无意义。`scripts/github-push-protection-blocked.txt`
与 `secret_patterns` 随之删除 —— 名单的作用是「哪些历史提交会拖累推送」，而新逻辑根本不推历史。

`.github/workflows/sync-to-cnb.yml` 同步加一条「远端树相同即 no-op」：CNB 侧收到的是合成提交，
GitHub 侧的 `merge-base --is-ancestor` 同样恒假，否则反方向镜像会永久红。

## Alternatives considered

- **继续维护名单，只修「名单里的提交正是 HEAD 时 `exit 1`」。** 名单本来就不能让 GitHub 收下
  `08b8333f5`，它只能阻止推送；而反方向 workflow 会把推送拒掉的分支重新带回 CNB，来回震荡。
  名单解决的是「报错不可读」，不是「推得出去」。
- **在 GitHub 上逐条 unblock，然后普通 push 完整历史。** 一次性操作，但每次推新区间都要再点一遍，
  且要求 CNB 领先 GitHub —— 现在两侧已经分叉，完整历史是非 fast-forward。
- **让 GitHub 侧接受 force push，两侧 sha 重新对齐。** 双向镜像刻意都不用 force（见
  [Change-Id 与镜像守卫](../process/2026-10-13-change-id-trailer-and-ci-mirror-guard.md)），
  对齐的代价是任一侧都可能覆盖另一侧。
- **保留 ancestor 断言，只在分叉时 fail 让人介入。** 只要 GitHub 还停在派生历史上，每次 push
  都会命中，等于把镜像永久关掉。

## Consequences

- 两侧 main 的 sha 永久不同，内容相同。任何依赖「sha 一致」的检查（例如按 commit 比对两侧状态）
  都不成立；能比的只有树，`.cnb.yml` 与 `sync-to-cnb.yml` 现在都按树比。
- `git log` 在 GitHub 侧看不到 CNB 的 merge commit 与 Change-Id，只有合成提交的信息行。
  「可读的完整历史」是这次取舍付出的东西，换来的是镜像不再被历史里的凭据拦死。
- 树里重新出现 `GOCSPX-…` / `*.apps.googleusercontent.com` 明文时，合成提交的树同样带明文，
  push protection 会照常拦下；此时报错回到「改源码」这条正路上，不再有名单可以绕过。
- 合成提交的 commit message 只有 `Merge CNB main <sha>` 一行，`CNB_COMMIT` 是定位两侧对应关系的
  唯一线索，日志里要保留。

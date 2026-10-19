# Agent Note: 历史里的 push protection 命中让镜像永久卡死，改用合成提交让远端接管

Status: superseded by
[按内容判定 main 镜像](2026-10-19-mirror-main-by-content-not-ancestry.md)

## Problem

`#58` 把 Antigravity 的 OAuth 凭据在树上改成了 base64，构建 `cnb-dp5-1k58ubofs` 仍然挂在
`push main`（GH013，同样四条 `Google OAuth Client ID / Secret`），`push tags` 顺带 skip。

改树没用，因为 GitHub 的 push protection 扫的是**这次推送要传的整个提交区间**，不是推送后的树：

```
remote:   —— Google OAuth Client Secret ——
remote:     locations:
remote:       - commit: 08b8333f5  path: packages/ai/src/auth/oauth/antigravity.ts:28
```

`08b8333f5` 是引入明文的那次提交，`507ac5daf`（MR #54）与 `4c28fa80b`（MR #55）把它带进 main，
三个提交都在 CNB 侧 main 上。GitHub 侧 main 还停在 `4c28fa80b` 之前，所以每次推送的区间都包含它们，
每次都被判非 fast-forward。`#58` 的决策笔记把这条写成「若将来重放该提交会再次被拦」，
实际不是「将来」：只要远端 main 落后于它们，这已经发生，并且不会自己好。

两侧都不 force push 是刻意的（见 [Change-Id 与镜像守卫](../process/2026-10-13-change-id-trailer-and-ci-mirror-guard.md)），
所以「把 08b8333f5 从历史里抹掉」不是选项：要么在 GitHub 上逐条 unblock（一次性、且文字还留在历史里），
要么让远端 main 变成一个**不含这些提交**的新提交。

## Decision

> 本文的名单方案已废弃：分支 1 推的合成提交会在下一次镜像被分支 2「接回」成以 `HEAD` 为父的
> 合并提交，`08b8333f5` 又回到待推区间，GH013 每次都重来。改为按树内容判定，见
> [按内容判定 main 镜像](2026-10-19-mirror-main-by-content-not-ancestry.md)。

`.cnb.yml` 的 `push main` 里加一个「已知被拦提交」名单 `scripts/github-push-protection-blocked.txt`，
推送前判断这三件事，据此选推送对象：

1. **待推区间里还有名单上的提交**（`rev-list --no-walk <名单> | rev-list --stdin --not FETCH_HEAD`
   非空），并且**树上已经没有明文**（`git grep -E 'GOCSPX-…|…apps\.googleusercontent\.com'` 无命中）。
   此时不推 `HEAD`，而是用 `git commit-tree HEAD^{tree} -p FETCH_HEAD` 现造一个提交推上去：
   远端拿到的树与 `HEAD` 逐字节相同，但不带着 `08b8333f5`。
2. **上一次推的就是这种合成提交**，所以远端 main 不在本地历史里、推 `HEAD` 会被判非 fast-forward。
   这时推 `commit-tree HEAD^{tree} -p HEAD -p FETCH_HEAD`，一个合并提交把两侧历史接起来。
   合成提交的 sha 不会出现在 `git log` 里（它不作为父提交被引用），第一次接回之后就不再产生。
3. 其余情况照原样 `git push HEAD:refs/heads/main`，推送成功后回读远端树比对（这条守卫不动）。

三个分支在临时仓库里对真实 git 跑过：阻塞→合成提交、分叉→合并提交、纯净→普通推送，以及
「名单里的提交正是 HEAD」时 `exit 1` 拒绝镜像。

## Alternatives considered

- **在 GitHub 上点 unblock-secret 放行。** 四个链接、每遇到新提交还要再点一次，而且字面量仍留在
  随后的历史里。它解的是「这次推送」，不是「每次推送都带它」这个结构。
- **`git filter-branch` / `filter-repo` 抹掉 `08b8333f5`。** 会重写已发布的 main，与两侧镜像刻意
  不用 force push 的设计直接冲突，代价是整条镜像链路。
- **把远端 main 判非 fast-forward 时直接 `exit 1` 等人处理（现状加强版）。** 现象更早暴露，但每次
  都得人来处理，且处理手段仍然是「推一个不含这些提交的提交」。
- **不记名单，只判断守卫失败就合成提交。** 任何原因导致的非 fast-forward（远端有人直推、
  replay 用掉的树）都会被静默改写成合成提交，把「该报警的情形」变成「正常路径」。名单让这个
  入口只对已知的、已在 CNB main 上的提交开启。
- **合成提交用 `-p HEAD -p FETCH_HEAD` 一次到位（跳过上面的分支 1）。** 那样远端会收到
  `08b8333f5`，正是要避开的东西。

## Consequences

- 名单里的三条只记录「规则 + 文件 + 行号」，不贴凭据；这个文件自己也在推送区间里，
  贴了就是新的命中。
- 名单里的提交一旦被远端历史收下（例如有人 force 推了完整历史），对应行就应当删掉：
  判断条件自然会变成「不在待推区间」，留着无害但会误导。
- 树里重新出现明文时，分支 1 的前置条件不成立，脚本会照常把 GH013 原样抛出来。这是刻意的：
  名单只对「已经修好的历史」生效。
- 第一次修完之后，远端 main 的历史与本地分叉：远端是「GitHub tip → 合成提交」，本地仍带着
  `08b8333f5`。下一次镜像推一个合并提交（树取本地 HEAD，父提交是 `HEAD` 与远端 tip）衔接，
  此后两侧 sha 不同、内容相同（推送后回读比对保证）。这与「双向镜像、都不 force」的既有约束一致。
- 合成提交不带 `08b8333f5`，从它派生的提交也不带。所以只有「把 `08b8333f5` 或其两个 merge 提交
  本身塞进待推区间」才会再命中名单 —— 也就是远端 main 仍然落后于它们的时候。

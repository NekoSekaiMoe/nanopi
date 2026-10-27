# Agent Note: 合并结果检查的基线取不到时退回第一父

Status: implemented

## Problem

issue #314：`cnb-b8j-1k5tkk317`（PR #313）明明只是个改名，`check-merge-result`
却报「这次合并删掉了 `docs/assets/linux-do.png`」，PR 被判红。

现场（runner 日志）：

```
Updating 2bee5e9c0..b886d95b7
Fast-forward
 rename {docs/assets => packages/coding-agent/docs/images}/linux-do.png (100%)
this change drops 1 file(s) that 2bee5e9c0f7103ccae87b9a79a6faeffaa5d6067 still has:
  docs/assets/linux-do.png
```

`2bee5e9c0` 与 `b886d95b7` 是同一个 PR 源分支的两端：前者是 `pull_request.target`
构建那一刻的 main tip，后者是 PR 的 head。基线取值的那一步出了岔子。

`check-merge-result-cnb.mjs` 走的是「把 PR 分支合进目标分支」，合并成功后 HEAD 是
合并提交、`HEAD^1` 是目标分支 tip，判定脚本默认就拿这个第一父当基线——这条路是对的。
可它发生在 `pull_request.target` 构建里，而这类构建的工作树是 `git-clone-yyds` 复制
出来的快照：`git for-each-ref` 只有 2 个 ref，日志里 `git fetch origin <分支>` 也没建
任何远端跟踪分支。也就是说「基线」在这棵树里没有任何名字，只有 git 对象本身（`HEAD^1`）。

`check-merge-result.mjs` 的 `--base` 分支却按「名字」办事：

```js
const base = explicitBase ?? git(["rev-parse", `${head}^1`]);
try {
	git(["rev-parse", "--verify", `${base}^{commit}`]);
} catch {
	console.error(`${base} is missing; fetch it first (...)`);
	process.exit(2);
}
```

名字解析不出来就 `exit 2`，而 `exit 2` 在 `set -euo pipefail` 的 stage 里和红没区别。
合并、改名、目标分支的变化全都对，红的只是「基线叫什么」。

## Decision

基线一律以提交为准，名字只当索引用：

- `--base` 给的是提交（sha 或任何解析得到的写法）就用它。调用方（CNB 脚本、GitHub
  workflow）手上有「这次合并从哪儿长出来的」，比 `HEAD` 的父更可信，而且普通提交与
  合并提交两种形态它都认得。
- `--base` 解析不到时**退回 `HEAD` 的第一父**并打印一行说明，而不是 `exit 2`。
  `check-merge-result-cnb.mjs` 刚做完合并，第一父就是它抓到的目标分支 tip，这个退路
  在 CI 里永远成立。
- 第一父也取不到（根提交、浅 clone 的第一层）才 `exit 2`——那才是真的没有可比的东西。

测试跟着挪：原来直接拿 `main` 当基线的几个用例改成先 `pinBase()` 打 tag，标签名与
分支名各走各的；新增两条钉住退路（ref 名在本地解析不到 → 绿并提示；连第一父都没有
→ `exit 2`）。

## Consequences

- CNB 与 GitHub 两侧都不再依赖「远端跟踪分支存在」这个前提：那是 `fetch` 的副作用，
  不是平台保证。
- 覆盖率没降：基线消失这类现场（浅 clone、ref 名写错）现在退到第一父接着判，
  而不是整条检查作废。真正判不了的情况——`HEAD` 没有父——仍然红。
- 基线**指向哪儿**这件事，判定脚本不再替调用方猜。`main` 这个名字在这棵树里可能根本
  不存在，也可能指到别处；能证明「这是合进来的那一刻」的只有调用方手上的 git 对象。

## Alternatives considered

- **在工作树里补 refspec，让 `refs/remotes/origin/main` 真的存在。** 要改的是
  `git-clone-yyds` 的行为，配置层面改不到；而且「名字存不存在」本来就不该决定一条
  检查的结论。
- **`--base` 解析不到就直接成功（跳过检查）。** 等于给了一个「基线丢了我就不查」的
  开关，比红更糟。
- **判定脚本自己 `git fetch` 目标分支。** 引入网络与凭据，还要在 `pull_request.target`
  这种不可信事件里跑；调用方已经在做这件事了。
- **按 ref 名核对「它是不是 `HEAD^1`」，不一致就退回。** 试过：CNB 上这个 ref 名
  有的构建里有、有的没有（`cnb-5hu-1k5s7n78g` 与 `cnb-tq0-1k5s2s3de` 同一份脚本，
  前者看到的是 `refs/remotes/pr/head`，后者是 sha），同一个改动两种绿法。名字怎么来
  的比结论更不可控，不做。

## Verification

`scripts/check-merge-result.test.mjs` 覆盖：ref 名解析不到 → 退回第一父、绿、打印
提示；没有第一父 → `exit 2`；原有 11 条判据全部保持（白名单、合并提交自证、回退仍红、
改名仍红、`deletes` 逐条生效）。`pnpm run check` 全绿。

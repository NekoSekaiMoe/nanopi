# Agent Note: Tag 镜像与 main 分开处理

Status: implemented

## Problem

两侧镜像（`.cnb.yml` 的 `mirror-to-github`、`.github/workflows/sync-to-cnb.yml`）都只推
`HEAD:refs/heads/main`，tag 从来不进同步范围。实测 GitHub 329 个 tag、CNB 328 个，唯一差异是
`v20261013` 只在 GitHub 一侧；CNB 上没有 GitHub 没有的 tag。从 CNB clone 的人拿不到 release tag，
`git describe` 和 `create-source-archive.sh` 的 tag/package 版本校验在 CNB 侧都失效。

`v20261013` 的落点不是偶然：`build-binaries.yml` 由 tag push 触发，而它只存在于 GitHub 侧
（`.cnb.yml` 没有 tag 触发）。release 只能在 GitHub 打 tag，CNB 永远收不到这个事件。

天真做法（把 tag 并入现有 push）会撞上三件事：

1. **main 的守卫语义不适用。** main 是「fast-forward 断言 + push 后树比对」，tag 是不可变引用，
   没有 fast-forward 概念。共用一套守卫等于两边都不成立。
2. **两侧会被同名 tag 永久钉死。** 两个方向都没有 force，一旦同一 tag 名在两侧指向不同 commit，
   谁都推不动，只能人介入。需要的是「已存在且指向不同 commit 就显式报错」，而不是静默跳过或覆盖。
3. **fetch tag 会污染判据。** 把远端 tag fetch 进 `refs/tags/` 之后，本地的「哪些 tag 要推」清单
   会把刚 fetch 下来的远端 tag 算成自己的，远端不存在的 tag 就永远判不出来。

## Decision

两个镜像脚本各加一个独立的 tag stage/step，与 main 的 stage 并列，不共享守卫。

**只镜像 annotated tag。** 判定用 `git for-each-ref --format='%(objectname) %(objecttype) %(refname)' refs/tags`
配 `awk '$2 == "tag"'`：peel 出 `objecttype == tag` 的才是 annotated。轻量 tag 不推，因为轻量 tag
和 annotated tag 在同 commit 上是不同对象，两侧形制不同会让「指向同一 commit」的判定失去意义。
release 流程相应改为 `git tag -a`（`.nanopi/skills/release.md` 已写明）。

**远端 tag 落到独立命名空间 `refs/remote-tags/tags/*`**，不写 `refs/tags/`。这样本地 `refs/tags/`
始终是「要推的集合」这一份真值，比较对象是 `refs/remote-tags/tags/$name`，不会自我污染。
`--prune-tags` 被排除：它按本地 tag 名单去清远端，语义正好相反。

**冲突守卫：已存在且指向不同 commit 就 `exit 1`。** 先比对象 id（`rev-parse refs/tags/$name`），
相等即跳过；不相等时再比 `^{commit}`，同 commit 不同形制（对侧是轻量 tag）只打印跳过、不报错。
只有 `^{commit}` 也不同才报错并打印两侧对象与 commit。整个流程不出现 force。

**push 后回读比对。** 与 main 同理：push 退出码为 0 不能证明落上去的是本地这个对象，
所以重新 fetch 后用 `rev-parse` 逐字节比一次，不一致 `exit 1`。

**脚本只用 POSIX 语法。** CNB 的文档写明「流水线默认使用 `sh`，登录调试使用 `bash`」，而
`sh`（dash）不认三个上面顺手的写法：`set -o pipefail`（直接 `Illegal option`）、`${pending// /}`
（`Bad substitution`）、`< <(...)`（`redirection unexpected`）。因此本 stage 用 `set -eu`、
`[ -z "$(echo "$pending" | tr -d ' ')" ]` 判空、`while read` 从临时文件读（用管道会让循环落进
子 shell，`pending` 留不到循环外）。两个脚本在 `sh -n` 与 `bash -n` 下都能过，行为矩阵
（首发 / 幂等 / 多条 pending / 轻量 tag 跳过 / 冲突报错）在两种解释器下逐条一致。

注意现有 `push main` stage 已经是 `set -euo pipefail` 并稳定成功，说明当前容器实际提供了
bash——但那是未在文档中承诺的行为，新代码不押在它上面。

release 的归属保持 GitHub：tag 在 GitHub 打，`build-binaries.yml` 在 GitHub 跑，CNB 是消费方。
改的是「tag 也会跟着 main 的 push 过去」，不是「release 挪到 CNB」。

## Alternatives considered

- **把 tag 并进现有 push stage（两侧各加一句 `git push --follow-tags`）。** `--follow-tags` 只推
  annotated tag，看起来够用，但它没有守卫：同名 tag 指向不同 commit 时行为取决于服务端，要么被拒
  （日志里看不出是什么被拒），要么在有 force 的未来变体里静默覆盖。而且 main 的 fast-forward 断言
  和树比对都是 main 专用，混在一起后 tag 失败会连带把 main 镜像标记为失败。
- **把 release 固定到 CNB 侧，tag 只从 CNB 出。** 与「发布资产只在 GitHub Releases 产出、
  `build-binaries.yml` 只在 GitHub」冲突；要么把整条发布流水线搬到 CNB，要么在 CNB 上打 tag
  再让 GitHub 的 workflow 去别处触发——两者都比「GitHub 打 tag，镜像带回 CNB」代价大。
- **只同步 tag，不加冲突守卫。** 两个方向都没有 force，同名 tag 指向不同 commit 时推送被服务端
  拒绝，但失败信息是泛泛的 `failed to push some refs`，看不出是哪个 tag、哪两个 commit。诊断成本
  落在人身上，且无法在同步前发现。实测里 `vconf` 这类命名冲突会直接卡住整条 stage。
- **用 `git ls-remote --tags <remote>` 读远端，不 fetch。** 省一次 fetch，但 `ls-remote` 只给名字和
  对象 id，拿不到「两侧同 commit」所需的 `^{commit}` 本地解析（浅/部分克隆下更不可靠），
  而且和 main 的「fetch 后回读比对」不一致，两种远端读取方式并存反而更难维护。
- **只支持 annotated tag，就让轻量 tag 在两侧报错。** 更严格，但现存 328 个 CNB tag 里就有轻量形态
  （`v1.1.0`、`v0.12.1` 没有 peeled 行，`v0.0.1`、`v0.7.8` 有），入场即红会把历史形制当成新错误。

## Consequences

- release tag 推上 GitHub 后，下一次 push 到 `main` 会把它带到 CNB；CNB clone 从此能拿到 tag。
  代价是 tag 到达 CNB 有一拍延迟，取决于 main 何时再被推。
- 增量成本：每次 main push 各多一次 fetch、一次本地 ref 扫描，以及（有 pending 时）push 后多一次 fetch。
  没有 pending 时只多一次 fetch。
- `refs/tags/` 在所有镜像脚本里都必须理解为「本地要推的集合」，不要从中读远端状态。新增脚本时
  沿用 `refs/remote-tags/tags/*` 这一约定。
- 镜像脚本的解释器按 `sh` 对待。不要在 `.cnb.yml` 里新增 `pipefail`、`${var//pat/repl}`、
  process substitution 这类 bash 专有写法，除非该 stage 显式 `bash -c`。
- 同名 tag 在两侧指向不同 commit 会让 stage 失败，打印两侧对象 id 与 commit，由人决定方向。
  与 main 的 non-fast-forward 失败同类：镜像不替维护者做历史决策。
- 附带修掉一个形制不一致：CNB 上 `v0.0.1`/`v0.7.8` 是 annotated、`v1.1.0`/`v0.12.1` 是轻量。
  新推的 tag 一律 annotated，依赖 `^{commit}` 的脚本行为不再随 tag 来源变化。已有 328 个 tag 的形制
  不回改（那需要 force）。

Related: [Change-Id 只能本地生成，CI 只报告](2026-10-13-change-id-trailer-and-ci-mirror-guard.md)（同一对镜像脚本的 main 守卫部分）。

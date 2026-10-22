# Agent Note: main 镜像把传输层失败当失败，并重试

Status: implemented

## Problem

`cnb-j3q-1k5h2p94k`（#153 合并后的 push）的 `push main` 失败在 push 这一步：

```
fast-forward: f3d2e45f02527c148bc5fcd2b298a24abc192929 is ahead of ... main
fatal: unable to access 'https://github.com/NekoSekaiMoe/nanopi.git/':
  GnuTLS, handshake failed: The TLS connection was non-properly terminated.
Finished, code: 128, duration: 6.1s
```

同一段脚本在 `cnb-fnt-1k5h2osdc`（16 分钟前，同一 runner 规格、同样快进）是成功的，
`git fetch` 与 `git push` 之间没有任何本地判定 —— 也就是说这次失败与树、与历史、
与 push protection 都无关，是到 GitHub 的 TLS 连接被中途掐断。

问题在于脚本对这种失败的处置：`set -euo pipefail` 下 128 直接把 stage 判红，
一次公网抖动就让镜像停在旧内容上，且要等下一次 push 才补。镜像是一个幂等动作，
重试的语义是安全的，缺的只是「区分可重试与不可重试」。

## Decision

main 的镜像逻辑抽到 `scripts/mirror-main.mjs`，`.cnb.yml` 的 `push main` 与
`.github/workflows/sync-to-cnb.yml` 的 `Push main to CNB` 都只是取凭据后调用它，
调用点不再各写一份判定。

脚本沿用在 [main 镜像按内容判定](../../implemented/bug-fix/2026-10-19-mirror-main-by-content-not-ancestry.md)
里的三条规则（树相同即 no-op、远端 tip 是祖先则快进、否则推单父合成提交，
推送后回读远端树）、外加 `2026-10-19` 系列的 push protection 约束；本次只加一层重试：

- `git fetch` / `git push` / 回读 `git fetch` 各自最多试 3 次，退避 5s、10s。
- 重试范围是这三个远端命令本身。树比对、ancestor 判定留在重试之外：它们要么成功
  要么结论确定，重试只会把同一个错误说三遍。
- 子进程带 `timeout: 60s` 与 `GIT_TERMINAL_PROMPT=0`：连接被挂住时不能无限等，
  认证失败时不能挂在交互提示上（CI 没有 tty）。

`.github/workflows/sync-to-cnb.yml` 里原有的 ancestor 断言被删掉，改由脚本统一的
内容判定处理；两个方向此前对同一个分叉状态给出不同的判定（一侧 exit 0，一侧 exit 1），
`sync-to-cnb` 那条分支因此永远不会被走到。

## Alternatives considered

- **在内联 bash 里包一层 `for i in 1 2 3; do git push ... && break; done`。**
  能补上重试，但 `.cnb.yml` 与 `sync-to-cnb.yml` 是两份逐字抄写的同构脚本，改一处
  必须记得改另一处 —— 这正是本次两条链路判定不一致的来源。
- **只对 `git push` 重试。** 失败也可能发生在开头的 `git fetch`（同一个 TLS 栈、
  同一个对端），只包 push 等于把一半的抖动留在原地。
- **把非快进、树不一致也纳入重试。** 这些是内容层面的判定，重试不改变结果，
  只会把真实的镜像错误延迟 15 秒并淹没在重试日志里。
- **改用 SSH 或 `https://` + HTTP/1.1 绕开 GnuTLS。** runner 上的 git 链接的是
  GnuTLS，换协议要引入部署密钥；抖动来自公网链路，重试的收益比换协议直接。

## Consequences

- 单次传输抖动不再让镜像红：镜像在 3 次尝试内自愈，日志里留下
  `git push failed (attempt 1/3): ...` 供事后判断抖动频率。
- stage 的失败含义收窄到真正需要人介入的情形：认证失败、远端拒绝、
  推送后树不一致。
- `scripts/mirror-main.mjs` 里的退避是同步睡眠（`Atomics.wait`），单次 stage
  最长多花约 15 秒；镜像 stage 本身在 10 秒量级，可接受。
- `scripts/mirror-main.test.mjs` 覆盖三条路径：快进后收敛为 no-op、分叉时推单父
  合成提交且树一致、远端不存在时退出非 0。测试用裸仓库当远端，因为往非裸仓库的
  当前分支推会被 `receive.denyCurrentBranch` 拒绝，那不是本脚本的失败面。

Related: [main 镜像按内容判定](2026-10-19-mirror-main-by-content-not-ancestry.md)（本文接续的判定规则）、
[Change-Id 与镜像守卫](../process/2026-10-13-change-id-trailer-and-ci-mirror-guard.md)（同一对镜像脚本的 check 部分）。

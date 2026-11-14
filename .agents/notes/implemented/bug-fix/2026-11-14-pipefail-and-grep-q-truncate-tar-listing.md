# Agent Note: `tar | grep -q` 在 pipefail 下把「找到 .node」判成失败

Status: implemented

## Problem

nightly 的 "Collect TUI native prebuilds" 步骤（`.github/workflows/nightly.yml`）
检查 sidecar 包里有没有预编译产物，写法是：

```bash
set -euo pipefail
tar -tzf "${tarball}" | grep -q '\.node$' || {
  echo "::error::sidecar tarball carries no prebuilt .node file"
  exit 1
}
```

包里有六个 `.node`，步骤照样红：

```
tar: stdout: write error
Error: sidecar tarball carries no prebuilt .node file
```

`grep -q` 命中第一条就 `exit`，此时 `tar` 还在往管道里写剩下的清单，对端已关闭，
`tar` 拿到 EPIPE/SIGPIPE（GNU tar 把它报成 `stdout: write error`、退出 2）。`pipefail`
取管道最后一个非零状态，于是整条管道算失败，`||` 分支执行——「找到了」被读成「没找到」。

会不会炸取决于清单和管道缓冲（Linux 上 64 KiB）谁先结束：sidecar 包只有六个 `.node`、
目录层数固定，清单常常几百字节就写完了，`tar` 在 `grep` 退出前已经收工，于是看起来
「有时正常、有时红」。实测（`scripts/build-coding-agent-single-file.test.mjs` 里那两个用例）：
把 `.node` 排在清单开头、再塞够把清单撑过 64 KiB 的条目，旧写法 100% 报错。

## Decision

先取完清单再匹配，管道不进判定：

```bash
entries="$(tar -tzf "${tarball}")"
grep -q '\.node$' <<< "${entries}" || {
  echo "::error::sidecar tarball carries no prebuilt .node file"
  exit 1
}
```

`$( )` 会等 `tar` 退出，没有对端提前关闭的窗口；`grep -q` 从 herestring 读，
提前退出只影响它自己。命令替换后 `set -e` 仍然生效，`tar` 自己失败（坏包、文件不存在）
依旧是红的。

`scripts/build-coding-agent-single-file.test.mjs` 加了两条回归测试：从
`nightly.yml` 里把这一步的 `run` 脚本取出来（用 `yaml` 解析，不靠缩进正则），在临时
目录里造包真跑一遍。一条断言有 `.node` 时退出 0 且 tgz 被搬进 `release-assets/`，
一条断言没有 `.node` 时退出 1 并打出错误信息。测试**执行**这一步而不是正则匹配源码：
缺陷在 `tar` 与 `grep` 的竞争里，源码断言看不见。

## Alternatives considered

- **只把 `grep -q` 换成 `grep -c` / `grep '\.node$' >/dev/null`。** `-c` 会读完整个
  输入，理论上够。但这条纪律靠「记得 `-q` 会提前退出」维持，下一个人写 `| grep -q` 又
  回到原地；而且 `tar: stdout: write error` 这类噪声仍会出现在日志里。
- **去掉 `pipefail`。** `pipefail` 是这个仓库所有 `run:` 块的标准写法（`.cnb.yml` 与
  `.github/workflows/*.yml` 一以贯之），为了一个管道去掉它，等于把同一步里其它命令的
  失败也一起放过去。
- **`tar -tzf ... > files.txt` 再 `grep -q ... files.txt`。** 要多管一个临时文件的生命
  周期（runner 上无所谓，但脚本里多一处 `rm`、失败路径多一处泄漏）。命令替换拿到的是
  同一份内容，且随 shell 作用域销毁。
- **不在测试里真跑 shell，只断言 `nightly.yml` 里有 `entries="$(tar ...)"`。** 那种测试
  钉的是实现怎么写的，不是行为对不对；下一个用等价写法修好的人会被它判红。

## Consequences

- 收益：nightly 的这一步不再取决于清单长度与管道缓冲的竞争；两条用例在旧写法上红、
  新写法上绿，改动前后都验证过。
- 代价：整个清单进了一次 shell 变量。sidecar 包的清单是空文件条目，量级几十 KB，
  与 64 KiB 缓冲无关地安全。
- 留下的缺口：仓库里没有第二个 `| grep -q` 了（`rg 'grep -q'` 只剩刚写的这处和新用例），
  但 `lint-workflows` 的 shellcheck 不报 SC2312/管道早期退出，同类问题下次仍要靠人看。
  若再遇到，往 `scripts/lint-workflows.mjs` 加一条自定义检查比散着改可靠。

Related: [sidecar tgz 的落盘位置与镜像契约](../bug-fix/2026-11-10-sidecar-tarball-path-and-mirror-contract.md)
（同一步骤的上一次修复），[TUI sidecar 镜像与预编译产物](../process/2026-11-06-tui-sidecar-mirror-and-prebuilds.md)
（这一步要校验的东西是什么）。

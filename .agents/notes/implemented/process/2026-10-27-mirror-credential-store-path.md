# Agent Note: 镜像凭据必须落在 store helper 真正读的路径

Status: implemented

## Problem

[脚本自己落盘凭据](./2026-10-27-mirror-credential-in-script.md) 之后，CNB 的
`mirror main and tags` 每一次都失败（`cnb-76s-1k5teihr9` 是其中一次）：

```
fast-forward: ed320ee... is ahead of https://github.com/NekoSekaiMoe/nanopi.git main
fatal: could not read Username for 'https://github.com': terminal prompts disabled
```

根因是一行路径：凭据写在 `$XDG_CONFIG_HOME/git-credentials`，而
`git credential-store` 的默认读路径是 `$XDG_CONFIG_HOME/git/credentials`。写的那份
没人读，`fill` 一个字段都取不到，退回匿名。报错方向还误导人——`git` 只是「没有
username」，看不出是凭据没取到、还是取到了但主机不匹配。

## Decision

凭据相关逻辑从入口搬到 `scripts/mirror-credentials.mjs`，并由测试直接验证「store
能取回凭据」，旧测试只断言失败路径不打印 token、不留下目录，与仓库里已有的
`/etc/gitconfig` 恰好凑成「能过」，路径写错这件事完全隐形。

- 凭据文件：`<tmpdir>/git/credentials`，0600，`XDG_CONFIG_HOME` 指向 `<tmpdir>`。
- 全局配置：`<tmpdir>/gitconfig`，内容 `[credential]\n\thelper = store`，用
  `writeFileSync` 写，不经 `git config`。
- 系统级配置：同样指向 `<tmpdir>/gitconfig`（`git` 会拼成 `<dir>/gitconfig`，
  指一个存在的文件即可）。
- 退出时删整个 `<tmpdir>`。

## Alternatives considered

- **只改文件名到 `git/credentials`，其余不动**：能修好（实测 `credential fill` 通过），
  但凭据逻辑仍散在入口的 40 行里，测试只能断言「文件在哪」，不能断言「git 能用」。
- **`credential.helper = store --file <path>`**：把路径写进配置，就不依赖 XDG 的
  目录规则。多一层引号解析（路径含空格时），收益是少建一个 `git/` 子目录。
- **`GIT_ASKPASS` 回显 token**：多一个可执行文件，且 `askpass` 只在 git 决定交互时
  才被调用，失败形态比 store 难诊断。

## Consequences

- 新增回归测试 `scripts/mirror.test.mjs` 的 `installed credentials are what the
  store helper returns`：把 `installCredential` 跑在一个子进程里，再让
  `git credential fill` 回答一次。把凭据文件挪回 `git-credentials` 时这条测试失败，
  即它确实盯住这次的 bug。
- `scripts/mirror.mjs` 只剩参数解析与退出码，凭据生命周期在
  `scripts/mirror-credentials.mjs`（导出 `installCredential` / `clearCredential`）。
- 仍未真机验证的部分：带真实 token 推 GitHub。本次修复可在下一次 `main` push 的
  流水线里确认。

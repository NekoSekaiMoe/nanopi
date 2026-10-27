# Agent Note: 镜像凭据由 scripts/mirror.mjs 自己落盘

Status: implemented

## Problem

两条镜像流水线（`.cnb.yml` 的 `mirror main and tags`、
`.github/workflows/sync-to-cnb.yml` 的 `Push main and tags to CNB`）都靠内联
bash 先准备凭据再调脚本：

```sh
git config --global credential.helper store
printf 'https://x-access-token:%s@github.com\n' "$GH_KEY" > ~/.git-credentials
node scripts/mirror.mjs main --remote "$remote"
```

两个远端对匿名读都返 401（CNB 对海外 IP），所以 fetch 也必须带凭据，凭据不能
塞进 `--remote` 的 URL（那会让 token 出现在每条 git 命令的 argv 和报错里）。
剩下的写法问题有三处：

- `~/.git-credentials` 与 `--global` 配置比这次推送活得久。CI 里靠 runner 一次性
  兜底，但它同时也是「以后有人在本机照抄这段」的样板，抄出来的就是常驻凭据。
- 凭据的**写法**依赖 shell：单引号、`printf` 的 `%s`、文件名。AGENTS.md 只允许
  Node 脚本承担这类逻辑（`.sh` 已经全删），这两段是漏网的。
- 「缺 secret」的表现为第一次 `git fetch` 卡在 401 上，报错里看不出是少了环境变量；
  而 `.cnb.yml` 里 GH_KEY / `sync-to-cnb.yml` 里 CNB_KEY 用的用户名不一样，
  这一点也只写在各自的行里。

## Decision

入口 `scripts/mirror.mjs` 收两个新参数：`--token-env <VAR>` 与
`--token-user <name>`（必须同时给）。给了就：

1. 从 `process.env[VAR]` 取 token，取不到直接 `exit 2` 并点名变量，不静默走匿名。
2. 建一个 `mkdtemp` 私有目录（0700），把 `<protocol>//<user>:<token>@<host><path>`
   写进其中的凭据文件（0600）。
3. `XDG_CONFIG_HOME` 指向该目录，于是 store helper 读的就是
   `$XDG_CONFIG_HOME/git/credentials`；`GIT_CONFIG_GLOBAL` 与 `GIT_CONFIG_SYSTEM`
   都指到该目录里的一个临时 gitconfig（写一行 `credential.helper = store`），
   调用方的全局/系统配置不会把 helper 改回别处。
4. `process.on("exit")` 删掉整个目录——成功、判定失败（退出码 1）、异常都覆盖。

workflow 只剩两行调用，secret 通过 `env:` 传入：

```sh
node scripts/mirror.mjs main --remote "$remote" --token-user x-access-token --token-env GH_KEY
node scripts/mirror.mjs tags --remote "$remote" --token-user x-access-token --token-env GH_KEY
```

## Alternatives considered

- **继续在 workflow 里 `git config --global credential.helper store`**：改动最小，
  但凭据仍然越过进程生命周期（上面第一条），且写法留在 shell 里。
- **`GIT_CONFIG_GLOBAL=<file>` 的配置里写 `helper = store --file <path>`**：不需要
  动 `XDG_CONFIG_HOME`，但凭据文件路径要进 git 配置的引号里，路径含空格或引号时
  是另一个解析层。让 store 走默认位置、只把 `XDG_CONFIG_HOME` 指到临时目录更短。
- **`GIT_ASKPASS` 接一个回显 token 的脚本**：多一个可执行文件，且 `askpass` 只在
  git 决定要交互时才被调用，判定条件比 store 隐晦。
- **`GIT_CONFIG_SYSTEM` 直接指临时目录**（git 会拼成 `<dir>/gitconfig`）：第一次
  实现就是它，实测目录已存在但 `gitconfig` 不存在时 `git` 以
  `fatal: error processing config file(s)` 退出——指一个不存在的文件才是「空配置」。
- **保留旧的 `--remote` 带凭据的调用方式**：`mirror-main.mjs` / `mirror-tags.mjs`
  本来就不该知道凭据，现在入口统一处理，库代码零改动。

## Consequences

- 凭据只活在一次 `node scripts/mirror.mjs` 的时长内；runner/本机都不会留下
  `~/.git-credentials`。同一 stage 里 main 与 tags 是两次调用，各自建一次凭据。
- 缺 token、`--token-user` 与 `--token-env` 只给一个是用法错误（退出码 2），
  失败信息点名环境变量。
- 代价：传 `--token-env` 时子 git 进程拿到的是临时 `GIT_CONFIG_GLOBAL` /
  `GIT_CONFIG_SYSTEM` / `XDG_CONFIG_HOME`。CI 的 runner 本来就没有有价值的全局配置，
  但「在本机用 secret 手动跑一次镜像」这条路径会丢掉调用方的 git 别名与
  `insteadOf` 之类的设置。镜像脚本不依赖它们，接受。
- 验证：`node --test scripts/mirror.test.mjs`（新增缺 token、参数必须成对、
  失败路径不打印 token 且不留临时目录三条用例）；`pnpm run check` 通过。
- 真机未验：带真实 token 的 HTTPS 推送（GitHub / CNB）只能靠下一次 main push
  的流水线确认；本地用 `file://` 远端只覆盖了非凭据路径。

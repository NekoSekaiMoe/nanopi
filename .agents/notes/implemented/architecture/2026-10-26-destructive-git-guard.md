# Agent Note: 破坏性 git 命令的判定层与 worktree 感知

Status: implemented

## Problem

`AGENTS.md` 写着「Never run: `git reset --hard`、`git stash`、`git clean -fd`、`git add -A`…」，
那是写给人的规矩，没有执行层：`bash` 工具拿到命令直接 spawn。这个仓库里被咬的场景是现成的——
`pi-subagent-mini` 的 `isolated: true` 才给子 agent 单独 worktree，默认不隔离时它和主 agent
共用一个 checkout，而多个 nanopi 会话同 cwd 并行也是常态。一句模型「顺手」发出的 `git stash`
抹掉的是别人的未提交改动，且 git 无法恢复。

issue #200 要定两件事：判定放在哪一层，以及怎么判定才不漏。

## Decision

判定放在 `PermissionGate`（`packages/extra/src/permissions.ts`），不在 `bash` 工具里另建一套拦截。

理由：`bash` 内建的硬拦在授权模式（`--yolo`）、headless `-p`/json 运行里都不存在，
而它需要的「问人」能力恰好只有 gate 有——四档授权 + 一次模型判断 + webui SSE 卡片。
两份判定逻辑会长成两份语义，gate 已经是这个仓库里唯一的判定路径。

判定本身是「命令碰到哪个 checkout 的索引与工作树」，不是「命令是不是某个字符串」：

- 全局 flag（`-C`、`--work-tree`）决定 checkout；`-C` 指向别的 checkout 时算**隔离**，不拦。
- `git worktree add <dir>` 与 `git worktree remove <dir>` 判为隔离，这正是子 agent
  `isolated: true` 用的形式，也是这个 guard 想推荐的写法。
- 其余子命令按 hazards 表判定；`reset --hard`/`--merge`/`--keep`、无 pathspec 的 `reset`、
  `stash`（`list`/`show`/`branch` 除外）、`clean -f`、`add -A`/`.`、`checkout .`、
  `restore`、`commit --no-verify`、`push --force`。`add -u`、`clean -n`、`stash list`
  这类安全形式不拦。
- 一个 checkout = 一个 `(repoDir, commonGitDir)` 对；linked worktree 与主 checkout 共享
  `commonGitDir` 但 `repoDir` 不同，所以「在别的 worktree 里 reset」是隔离，
  「在这个 worktree 里 reset」仍是 hazard。

shell 层（`git-guard.ts` 的 `collectGitInvocations`）负责找出真正执行的 git 调用：
按 `;`/`&&`/`||`/`|`/`&`/换行/`( )` 切分并跟踪引号，进入 `$(...)`、反引号、`bash -c '…'`，
跟踪 `cd`，剥掉 `sudo`/`env`/`FOO=bar` 前缀，并丢掉重定向目标。
**只有明确看不懂的形态才放弃判定**（`bash script.sh`、`cd $DIR`、未闭合引号），
放弃等于不拦（漏一次提示），而不是拦（`plan-shell.ts` 的选择）。两者目标不同：
plan 模式要保证只读，所以看不懂就拒；guard 要避免误伤，所以看不懂就放过。

被拦时的工具结果里追加一行 `Blocked by the git guard: <原因>…`，并提示造一个自己的 worktree。
模型看不见 prompt 之外的拒绝原因，而这正是硬拦唯一的优点：下一次调用就能读到规矩。

默认开启，`/gitguard off` 关闭（`ExtraSettings.gitGuard`，项目/全局 settings.json 均可写）。

## Alternatives considered

- **`bash` 工具内建拦截**：管得住非授权模式，但要在 `bash` 里重建提问/授权 UI，
  而且会与 gate 形成两条判定路径。issue #200 自己也把这条列为「最不值得走」，
  仅在「非 yolo 会话也要拦」时才需要——而那种场景下 gate 本来就在。
- **`bash` operations 后端包装（sandbox 那条路）**：`registerBashOperations` 只包装 `exec()`，
  拿到的是字符串且没有权限 UI，最后还是要在里面另建一套提问机制，比 gate 更远。
- **纯正则/子串匹配**：issue 列出的 `cd x && git stash`、`bash -c '…'`、`$(…)`、
  `git -C path reset --hard`、换行多命令全都漏。真实方案的底线是轻量 shell 解析，成本落在
  `git-guard.ts` 的一个切分器 + 一个扫描器，比维护一张永不完整的正则表便宜。
- **硬拦（不可覆盖）**：`git stash` 有时正是用户想要的。做成 gate 的一类，
  用户/模型判断可以放行，是「强制走授权」而不是「禁止」。
- **默认关（oh-my-pi 的做法）**：这个仓库的定位是个人工作流工具，但同名 checkout 多会话并行
  是常态而不是例外；默认关等于这个防护对最常出事的场景不生效。开箱默认开 + 一个开关。
- **把 `git stash` 的「允许本次会话」也一并豁免**：那等于用户点了「允许 bash」之后
  所有破坏性命令都静默通过。hazard 有意绕过 session 级允许，并单独成为 judge 的 class key
  （`bash::git::<hazard>`），否则一次 `bash::git` 的模型判断会把 `git reset --hard` 一起放行。

## Consequences

- 判定按 checkout 粒度，不看分支：`git checkout <branch>` 不拦（git 自己会拒绝覆盖本地改动），
  但 `git checkout .` 拦。任何「切分支就安全」的直觉在这里都不成立——索引与工作树是 per-worktree 的。
- `cd <某个 worktree> && git stash` 仍会被拦：`cd` 只按字符串解析，若据此推断目录存在并算作隔离，
  正好是「静默漏判」这条路。要声明隔离请用 `git worktree add` 或 `git -C <dir>`，
  两者都绑在路径上，也是这个 guard 想引导的写法。
- 解析器盖住的 shell 形态就是它声明的那些；新增形态（例如 `eval`、函数、alias）需要显式实现或
  显式放弃，不要用「大概也能过」的方式蒙混。
- `PermissionCallInfo.hazard` 是 gate 与调用方之间新增的契约；webui 卡片目前只展示 `summary`，
  hazard 通过拒绝原因与工具结果抵达模型，没有单独渲染。
- headless `-p`/json 运行没有 gate（沿用现有「无法提问则放行」的约定），guard 在这些场景不生效；
  并行写者的风险在那里仍然靠 `isolated: true` 的 worktree 解决。

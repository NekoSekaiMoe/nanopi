# Agent Note: 笔记的三条校验是门禁，四问那条仍然只是提醒

Status: implemented

## Problem

`.agents/skills/write-notes-like-deepseek/scripts/` 里有三条校验脚本（tree / format /
archived），但两条流水线都没有它们（#728）。要跑得自己在本地敲三行
`node .agents/skills/write-notes-like-deepseek/scripts/verify-*.ts`。

没人跑，所以腐化是攒出来的。整理笔记树那次（#727）一次修掉 11 条错：
`rejected/performance/` 是脚本不认的第 7 个 class、4 条死链、3 篇 `Status:` 折行
挤掉空行、2 篇节名不在白名单、1 篇缺 `## Consequences`，另有 5 处过时路径。
这 11 条没有一条需要人做判断——都是「文件放错目录」「头部写错」，脚本一看就知道。

同时期的 `scripts/check-agent-notes.mjs`（四问提醒）反过来是故意恒 0 的：它判的是
「这次 diff 该不该配一篇笔记」，那要人回答，脚本只能拿行数当代理。
见 [笔记的触发条件是四问](2026-11-05-note-triggers-are-four-questions.md)。

两件事被混在一句话里：「笔记检查」既指机械可判的结构校验，也指判不了的自律提醒。
混着的后果是两边都不合适——结构错因为有「提醒」的名分被放行，提醒因为要跟结构
错一起红而被误当成阻断。

## Decision

**按「能不能机械判」切开，一半门禁、一半提醒。**

能机械判的三条进 CI，失败即红：

- `verify-agent-note-tree.ts` — lifecycle/class 封闭集、`{lifecycle}/{class}/file.md`
  深度、文件名 `yyyy-mm-dd-topic.md`、禁 `INDEX.md`、活跃笔记内部相对链接有效。
- `verify-agent-note-format.ts` — 头部四行布局、`Status:` 与 lifecycle 一致且唯一、
  首节 `## Problem`、per-lifecycle 必需节、`implemented` 禁提案式标题。
- `verify-archived-agent-notes.ts` — 归档头部布局、`manifest.json` 的 sha256、
  相对基线的 append-only。

判不了的那条留在提醒位：`check-agent-notes.mjs` 退出码仍恒 0，挂在同一条流水线的
同一个入口里，被门禁带着跑，但不决定结论。

**命令只有一处定义。** 入口是 `scripts/verify-agent-notes.mjs`，挂进
`pnpm run check` 的末段（`verify:agent-notes`），所以四个调用点都只跑那一条：

| 调用点 | 基线 ref |
| --- | --- |
| `.husky/pre-commit.mjs` | 不传；归档退化成磁盘哈希自校验 |
| `.github/workflows/checks.yml` 的 `Check` | `AGENT_NOTE_ARCHIVE_BASE_REF` ← `pull_request.base.sha`，push 用 `github.event.before` |
| `.cnb.yml` 的 `pull_request.target` → `verify-agent-notes` | `--base "$CNB_PULL_REQUEST_TARGET_SHA"` |

三条 `verify-*.ts` 的路径写进两份流水线就一定会漂（顺序、路径、基线变量名各改各的），
而且漂了没人看得出来——两边都绿着。所以调用点只给「变更前的提交」，其余全在入口里。
GitHub 侧没有再开一个 job：`build-check-test` 是 ruleset 的必选检查，多一个 job 就多
一个要单独接进 ruleset 的东西，而这条检查不需要装依赖、跑在已有的 Node 上。

**基线必须是变更前的提交。** `verify-archived-agent-notes.ts` 的 append-only 是拿
`AGENT_NOTE_ARCHIVE_BASE_REF` 的 `manifest.json` 与当前逐条比；不传时它落到 `HEAD`，
等于自己跟自己比。CI 上两个平台各自给得出这个 ref，本地则给不出——本地不传是
对的，不该为了对齐 CI 编一个假基线。现在归档是 0 篇，这条红线暂时碰不到，
第一封印片落地就会碰。

**传进来的基线可能不是 commit。** 新分支 push 的 `before` 是全 0；CNB 上目标分支
那个 SHA 也可能在只带 FETCH_HEAD 的工作树里解析不到。两种情况都当作「没给」，
并在 CI 上打一行 warning——比让 `git show <全0>:...` 失败、被 `verify-archived`
当成「基线里没有 manifest」放过去要诚实。

**CNB 那一步单独指 `node:24` 镜像。** 默认构建镜像里没有 node，其他 stage 都是
`apt-get install nodejs` 现装，装到的是 Debian 的包，`process.features.typescript`
是 `false`——它不能剥类型，而三条校验脚本是 `.ts`。走 `ts-import.mjs` 要 esbuild，
那要先 `pnpm install` 整个工作区；为三条只读文件的检查不值得，所以直接换镜像。
入口脚本自己也兜了这一层：有类型剥离就直接跑，没有就找 `ts-import.mjs`，再没有就
报清楚「需要一个能剥类型的 node」，不让人对着 `Unknown file extension ".ts"` 猜。

**新增的 stage 要等这次改动合进 main 才生效。** `pull_request.target` 的流水线配置取自
**目标分支**（不是源分支），所以 PR 自己的 CI 跑的还是 main 上那份 `.cnb.yml`。上线顺序
是「先合、后红」：合进去之后的第一个 PR 才会跑 `verify-agent-notes`。

那一步还得先 `git config --global --add safe.directory ${CNB_BUILD_WORKSPACE:-/workspace}`：换了
容器的任务，工作区文件的所有者与当前用户常常不一致，git 会以 dubious ownership
拒绝执行，而 `verify-archived` 读不到 git 时是**静默**跳过 append-only 的——正好
跳掉这道门禁唯一的增量部分，且日志里看不出任何异样。

## Alternatives considered

**四条全做成门禁。** 四问那条判不了，做成门禁只有一条路：拿行数当代理。200 行的
机械 rename 该静音，3 行的默认值改动该写——行数与「值不值得记」的相关性弱到
把它变成阻断只会教人绕路。这也是当初它被写成恒 0 的原因，那条理由没变。

**四条全留在提醒位。** 就是改动前的现状，代价有数据：#727 之前攒了 11 条结构错，
没有一条需要判断。结构错的判定甚至可以写成正则，让它在提醒位放着，等于承认
「文件放错目录」也要靠自觉。

**让提醒的退出码跟着门禁走（合并成一个结论）。** 提醒红的时候人分不清是「笔记放错了」
还是「该写笔记没写」，而后者不是错。分开才使得住：红了就是去改文件，看一眼提醒
就是去想过四问。

**两边流水线各写一遍三条命令。** 短期内不会出事，长期一定漂。漂的表现是「一边绿
一边红」，而定位成本远高于抽一层入口——入口脚本本身只有几十行，不跑任何业务逻辑。

**CNB 侧不接，只接 GitHub。** GitHub 的 `build-check-test` 有现成的 ruleset，
CNB 侧还要在仓库设置里把 main 设成保护分支才拦得住合并。但只在 GH 上拦，CNB
上开的 PR 合进去之前一路绿灯——而 CNB 是这个仓库的主战场。

## Consequences

- 结构错现在会拦住提交流程，包括本地 `git commit`（pre-commit 最后一步）。
  代价是 pre-commit 多跑一次三次读文件的检查（毫秒级，无依赖）。
- `scripts/check-agent-notes.mjs` 的语义没变，仍然恒 0；它现在被门禁入口带着跑，
  所以 `--base` 也由入口转交，不再由流水线各写一份。
- 两边 CI 的基线 ref 名字不同（`pull_request.base.sha` / `CNB_PULL_REQUEST_TARGET_SHA`），
  这是平台差异，写在流水线里而不是脚本里——脚本只认 `--base`，不认平台变量。
- 归档的 append-only 从此真的会被查。第一封印片落地时如果流水线红，先看是不是
  基线取错，而不是「脚本坏了」。
- Skill 文档里那句「`templates/verify-notes.yml` 可作模板」本仓库做不到：安装只取了
  `SKILL.md` + `references/` + `scripts/`，没有 `templates/`。改成指向本仓库实际的
  两个调用点，不再指一个不存在的文件。
- CNB 侧那条 Stage 的脚本用 `set -eu`，不用 `set -euo pipefail`：`node:24` 镜像里
  `/bin/sh` 是 dash，dash 没有 `pipefail`，`set -o pipefail` 会让脚本在第一步就以
  `Illegal option -o pipefail` 退出——门禁看起来接了，实际上从未跑过一次，而红的
  理由又跟笔记无关，最容易被当成「流水线坏了」。那条脚本里没有管道，`set -eu`
  就是它需要的全部语义。

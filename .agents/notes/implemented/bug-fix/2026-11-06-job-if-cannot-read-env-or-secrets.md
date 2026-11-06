# Agent Note: job 级 if 读不到 env/secrets，用 needs 输出当闸门

Status: implemented

## Problem

`shinytale/nanopi#530`：`build-binaries.yml` 整份工作流被 GitHub 判为
`Invalid workflow file`，报在 `Line 364, Col 9`:

```
Unrecognized named-value: 'env'. Located at position 1 within expression:
env.ATOMGIT_KEY != ''
```

`if: ${{ env.ATOMGIT_KEY != '' }}` 写在 `publish-atomgit` 这个 **job** 上。
GitHub 对 `jobs.<id>.if` 的表达式上下文有白名单，只有 `github`、`needs`、
`vars`、`inputs` 可用；`env`、`secrets`、`steps`、`matrix` 都只到 **step 级**
`steps.<id>.if` 才开放。工作流顶层那句注释「GitHub 不允许在 `if:` 里直接读
secrets，所以先落到 env 再判断——env 可以，而 job 的 if 看得见 env」后半句是错的：
把 secret 摊到工作流级 `env` 并不能让 job 级 `if` 读到它，反而让整份 YAML 解析失败，
连带所有 job 都不跑（`Line 1` 指的就是整份文件，不是某一行）。

同一个提交 `c170bb35c`（"发 AtomGit 的活交给 GitHub Actions"）把同一段写法复制进了
`nightly.yml:147`，所以两条发布流水线其实都是坏的，只是 #530 报了其中一条。
`actionlint` 对两份文件的报错一致：

```
context "env" is not allowed here. available contexts are "github", "inputs",
"needs", "vars".
```

## Decision

用一个零依赖的闸门 job 把「secret 是否配置」翻成 `needs` 输出，再让发布 job 读它：

```yaml
jobs:
  check-atomgit-key:
    runs-on: ubuntu-latest
    permissions: {}
    outputs:
      has_key: ${{ steps.check.outputs.has_key }}
    steps:
      - id: check
        env:
          ATOMGIT_KEY: ${{ secrets.ATOMGIT_KEY }}
        run: |
          set -euo pipefail
          if [[ -n "${ATOMGIT_KEY:-}" ]]; then
            echo "has_key=true" >> "$GITHUB_OUTPUT"
          else
            echo "has_key=false" >> "$GITHUB_OUTPUT"
          fi

  publish-atomgit:
    needs: [stage-github-release, check-atomgit-key]
    if: ${{ needs.check-atomgit-key.outputs.has_key == 'true' }}
```

`build-binaries.yml` 与 `nightly.yml` 各一份（`needs` 里另一项分别是
`stage-github-release` 和 `build`）。这不是新造的模式：`issue-analysis.yml` 的
`authorize` job 早就用 `needs.authorize.outputs.should_run == 'true'` 给 `analyze`
job 做同样的闸门。

具体约束：

- **job 级 `if` 只用 `needs`**：这是白名单里唯一能承载「上一步算出来的布尔值」的
  上下文。输出名用下划线 `has_key`（与 `should_run` 一致），不用连字符——属性名带
  `-` 在表达式里容易和减号混。
- **secret 只落在要用到它的 step 的 `env` 里**：`check-atomgit-key` 的检查步和
  `publish-atomgit` 的发布步各读一次 `secrets.ATOMGIT_KEY`。删掉工作流级的 `env`
  映射，那把 key 不再对每个 job 可见。
- **闸门 job `permissions: {}`**：它只写 `$GITHUB_OUTPUT`，不调 API、不 checkout。
- **发布 job 仍与原子图一致**：`build-binaries.yml` 的 `publish-atomgit` 依旧在
  `stage-github-release` 之后、`cleanup-draft-github-release` 之前；`nightly.yml`
  依旧在 `build` 之后。没配 key（典型是 fork）时 `has_key=false`，发布 job 整体跳过，
  其余发布流程照常——原注释承诺的行为不变。

## Alternatives considered

- **把判断塞进发布 job 的第一步，用 step 级 `if: env.ATOMGIT_KEY != ''`**：step 级
  确实能读 `env`（`actionlint` 已验证）。但要给其余每个 step 都补一遍同样的 `if`，
  job 本身仍会占一个 runner、仍算「已运行」，而且 `actions/download-artifact`、
  `checkout` 这些准备步骤得单独处理。语义上要的是「这一步发不发生」，不是「job 里
  某几步跳不跳」。
- **`if: ${{ secrets.ATOMGIT_KEY != '' }}` 直接写 job 级**：`secrets` 和 `env` 一样
  不在白名单里，同样解析失败。顶层旧注释「先落到 env 再判断」就是想绕这个，绕错了
  方向。
- **把 `ATOMGIT_KEY` 做成 `vars`（仓库变量）**：`vars` 在 job 级 `if` 里可用，但
  `vars` 是明文、对有读权限的人可见，把写发行仓库的凭据放进变量是拿安全换一行
  表达式。secret 必须留在 `secrets`。
- **删掉闸门，让发布步自己 `if` 判空、不配 key 就 `exit 0`**：job 照样跑、照样下载
  artifact、照样 checkout，fork 上还会暴露「有一条会往别人仓库推的步骤」在跑；
  与「那一步跳过」的承诺不符。

## Consequences

- 两份工作流从「整份解析失败」恢复成可解析；`actionlint .github/workflows/*.yml`
  全绿（0 报错）。`build-binaries.yml` 的 tag 发布、`workflow_dispatch` 恢复路径，
  以及 `nightly.yml` 的 cron 都重新可用。
- 代价：每条流水线多一个约几秒的 `check-atomgit-key` job（一个 `run`，无 checkout、
  无依赖）。发布 job 依赖它，`stage-github-release`/`build` 与它并行，不延长关键路径。
- 顶层 `env.ATOMGIT_KEY` 删除后，发布步的 `env` 改为直接 `${{ secrets.ATOMGIT_KEY }}`；
  `scripts/publish-atomgit.mjs` 的 `--token-env ATOMGIT_KEY` 不变，读到的还是同名变量。
- 这类错误 `pnpm run check` 抓不到（biome 只覆盖 `*.ts`，不碰 `.github/workflows/*.yml`），
  且失败发生在工作流解析阶段、不产生 check-run。验证手段是 `actionlint`；日后改 job 级
  `if` 先拿它过一遍，别等 tag 推上去才发现整条流水线没跑。

## Verification

- `actionlint 1.7.7` 对修改前报 `build-binaries.yml:364` 与 `nightly.yml:147` 两处
  `context "env" is not allowed here`；对修改后 `.github/workflows/*.yml` 全量无输出。
- 反例对照：job 级 `if: ${{ env.X != '' }}` 仍被 `actionlint` 拒；step 级同样表达式通过，
  确认是上下文层级问题而非表达式语法。
- `python3 yaml.safe_load` 与 `yq`（jq-wrapper）对两份文件均解析通过。
- `node --experimental-strip-types .agents/skills/write-notes-like-deepseek/scripts/verify-agent-note-tree.ts`：
  `ok: 127 note(s)`。

Related: [bundle 发到 AtomGit 的发行仓库](../process/2026-11-05-atomgit-release-assets-mirror.md)
（这一步为什么存在、凭据怎么交给脚本）、[发版流水线的 gh 调用用 `-R` 定位仓库](2026-10-21-release-jobs-need-repo-flag-no-checkout.md)
（同一条 release 流水线里另一处「GitHub 侧专有约束」）。

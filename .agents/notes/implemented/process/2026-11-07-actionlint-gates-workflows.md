# Agent Note: actionlint + shellcheck 进 `build-check-test`

Status: implemented

## Problem

工作流的语法错误一直是「写坏了没人知道」：`shinytale/nanopi#530` 与 `#569` 是同一份
缺陷报了两遍，`build-binaries.yml` 与 `nightly.yml` 的 job 级 `if: ${{ env.ATOMGIT_KEY != '' }}`
读了白名单外的上下文，两份文件整份解析失败。失败发生在 GitHub 解析 YAML 的阶段：

- 不产生 check-run，ruleset 点名的 `build-check-test` 根本没被触发，PR 照样绿；
- 整份文件的所有 job 都不跑，`nightly.yml` 的 cron 连续几天没有记录；
- `pnpm run check` 抓不到，biome 只覆盖 `*.ts`；
- 本地没有任何哨兵，错误要等 tag 推上去、或有人去看 Actions 列表才发现。

也就是说 ci 门禁对「CI 自己的配置」是空白的。#530 修完之后的复盘结论就是「把
actionlint 加进 checks.yml 是最省的一条」，这件事在 #569 落地。

顺带暴露的第二个洞：`run:` 块里的 shell 没有静态检查。`build-binaries.yml` 的三个发布
job 把 `-R <repo>` 塞进 `GH_REPO_FLAG` 再靠无引号展开拆词，`checks.yml` 自己用
`sudo ln -s $(which fdfind) ...`——都能跑，但都在依赖「未加引号的展开会按空格切」。
第三处 `$(which ...)` 一旦命令不存在就是空串，行为从「报错」变成「静默做错事」。

## Decision

`build-check-test` 的第一个实际步骤（checkout 之后、装依赖之前）跑 `actionlint`，
并让它调用 `shellcheck`。两者都从 GitHub Releases 下载，版本与 sha256 钉在 step 的
`env` 里：

```yaml
- name: Lint workflows
  env:
    ACTIONLINT_VERSION: 1.7.12
    ACTIONLINT_SHA256: 8aca8db...
    SHELLCHECK_VERSION: 0.11.0
    SHELLCHECK_SHA256: b7af85e...
  run: |
    fetch actionlint.tar.gz "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/..." "${ACTIONLINT_SHA256}"
    fetch shellcheck.tar.gz "https://github.com/koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/..." "${SHELLCHECK_SHA256}"
    "${tools}/actionlint" -shellcheck "${tools}/shellcheck-v${SHELLCHECK_VERSION}/shellcheck" -pyflakes=
```

具体约束：

- **不新增 job**：`build-check-test` 是 ruleset 的必选检查，加一个并行的 job 不会让
  PR 更早地卡住——必选检查绿不绿只看那一条。放在同一个 job 的第一步，工作流写坏时
  十几秒就红，不用等一轮 build/check/test。
- **不引第三方 action**（`raven-actions/actionlint` 之类）：它自己也是 `uses:`，也要
  钉 sha，还要装 Node 依赖；而下载两个静态二进制 + 校验和只有 20 行，`curl` 与
  `sha256sum` 在 runner 上本来就有。
- **钉 sha256，而不只钉 tag**：release 资产不经 npm，Renovate 的 `custom.regex` 管不到
  `curl` 的 URL，钉了版本也不会有人替我们升；校验和至少保证「拿到的就是当时验证过的
  那两个文件」。升级时三处一起改（`*_VERSION`、URL 里的版本、`*_SHA256`）。
- **`-pyflakes=`**：仓库里没有 Python 步骤，装了只是多一次 `pipx install`。
- **`shellcheck` 用官方 0.11.0，不用 runner 预装的那份**：ubuntu-24.04 镜像自带 0.9.0，
  版本随镜像变，同一份工作流在镜像升级前后可能一绿一红。钉死之后 lint 结果只由仓库决定。
- **`shellcheck` 是真门禁**：11 条既有报错（8 条 SC2086、1 条 SC2046，另外两条是
  `checks.yml` 里的 `$(which)`）在这一个 PR 里一起改掉，不留 ignore。做法是
  `-R "${GH_REPO}"`（两个独立参数）与 `"$(command -v fdfind)"`，不改行为。

## Alternatives considered

- **只在本地跑、靠人记得跑**：就是现状。#530 的错误在仓库里躺了三天，改动它的人
  本地没有任何提示；「记得跑」不是机制。
- **用 `actionlint` 的 `-ignore` 把既有报错压掉，先只拦解析错误**：`-ignore` 是按消息
  正则过滤的，既有的 SC2086 会全被放行，包括以后新写的同类错误。而这次要改的 11 处
  都是几行的事，压掉比改掉更贵。
- **`shellcheck disable` 指令留在 `run:` 块里**：actionlint 会读 `# shellcheck disable=`
  注释，能用。但这里没有误报——未加引号的 `$GH_REPO_FLAG` 是真实的脆弱点，禁掉等于
  把唯一的提醒删了。
- **自己写一个 Node 脚本解析 YAML + 检查 `if:` 上下文**：`python3 yaml.safe_load` 只能
  验语法合法，GitHub 的表达式上下文白名单、`uses:` 的 sha 形态、`needs` 的输出引用都
  要自己维护一份规则表，等于重写 actionlint。
- **把 actionlint 加进 `pnpm run check`**：会让每个开发者的本机都依赖一个 Go 二进制，
  而 `check` 现在的契约是「有 node 就能跑」。工作流只在 CI/推送前有意义，放 CI 更贴合。

## Consequences

- 以后改 `.github/workflows/*.yml` 写错表达式上下文、拼错 `needs.<job>`、`run:` 块里
  漏引号，都会在那条必选检查上变红，而不是等发布流水线静默不跑。
- 代价：`build-check-test` 多约 5~10 秒（两个 tarball，几 MB）。这与后面 `pnpm install`
  的几十秒不是同一量级，且失败发生在装依赖之前。
- 升级路径是人工的：Renovate 不认 `curl` 的 URL，也不认 `env` 里的版本号。两个版本
  落后不会有任何提示——它们只在「actionlint 认不出 GitHub 的新语法」或「shellcheck 修了
  误报」时才需要动，可以等真遇到再升。
- shellcheck 版本钉死后，`actionlint` 报的 SC 编号不会随镜像漂移；但同时意味着新版本
  shellcheck 的新规则不会自动生效。
- `GH_REPO_FLAG` 这个变量没了，`build-binaries.yml` 的三个发布 job 现在每个调用点直接写
  `-R "${GH_REPO}"`。语义没变（仍是 `opts.RepoOverride` 非空），见
  [发版流水线的 gh 调用用 `-R` 定位仓库](../bug-fix/2026-10-21-release-jobs-need-repo-flag-no-checkout.md)。

## Verification

- 修改前：`actionlint 1.7.12` + `shellcheck 0.11.0` 对 `.github/workflows/*.yml` 报 9 条
  SC2086/SC2046；对修完的树全量无输出（exit 0）。
- 反例对照：在临时仓库里放一份 job 级 `if: ${{ env.FOO != '' }}`，同一命令报
  `context "env" is not allowed here`，确认门禁真能拦住 #530 那类错误。
- `Lint workflows` 的 `run` 块本身过 `shellcheck`（`-s bash`）无输出；把 `env` 按
  CI 的值注入后本地执行一遍，两个 tarball 校验和都 OK。
- `pnpm run check` 通过。

Related: [job 级 if 读不到 env/secrets](../bug-fix/2026-11-06-job-if-cannot-read-env-or-secrets.md)
（这条门禁要防的具体缺陷）、[必选检查的名字带工作流名](2026-11-02-required-checks-name-carries-workflow-name.md)
（为什么 lint 不能自己单开一个 job）。

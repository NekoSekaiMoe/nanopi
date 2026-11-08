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

### 第一版把门禁挂在了第三方 CDN 上

#569 的落地方式是：`Lint workflows` 步骤里 `curl` 两个 GitHub Releases 的 tarball，
用 `sha256sum -c` 校验后 `tar -xzf`，再跑 `actionlint -shellcheck .../shellcheck`。

问题是这一步的成败不取决于仓库。#607 里同一步连续失败，日志只有：

```
curl: (22) The requested URL returned error: 504
curl: (22) The requested URL returned error: 504
```

`curl -fsSL --retry 3` 四次都是 504，`-f` 让 curl 以 22 退出，整个必选检查
`build-check-test` 变红。工作流本身一个字都没改。也就是说门禁把「workflow 写坏了」
和「GitHub 的发版 CDN 抖了一下」变成了同一种红色，还捎带让所有 PR 卡在必选检查上。

## Decision

两个检查器改成 npm 依赖，跟着 `pnpm install --frozen-lockfile` 一起进 runner；
`Lint workflows` 只剩一行 `node scripts/lint-workflows.mjs`，逻辑全在脚本里：

```json
"check:workflows": "node scripts/lint-workflows.mjs",
"devDependencies": {
  "actionlint": "2.0.6",
  "shellcheck-wasm": "0.3.3"
}
```

- **`actionlint@2.0.6`** 是 rhysd/actionlint 编译成 wasm 的版本（Go 1.21 的 wasm
  后端，`main.wasm` 2 MB），导出 `createLinter()`，用法是
  `lint(text, path) -> {file,line,column,message,kind}[]`。表达式上下文白名单、
  `uses:` 的 sha 形态、`needs` 引用都在里面，与命令行版同源。
- **`shellcheck-wasm@0.3.3`** 是 ShellCheck 0.11.0 的 GHC wasm 构建，
  `createShellCheck()` + `lintWithOptions(script, {shell:"bash", severity:"style"})`，
  返回的 `code` 就是 SC 编号。0.11.0 正好是 #569 钉的那个版本，所以既有的 9 条
  SC 结论、报错编号都不变。
- **wasm 版不 spawn 外部进程**，所以 shell 检查要自己接：脚本用仓库本来就有的
  `yaml` 依赖找出所有 `run:` 块（不管在 `jobs.<id>.steps[*]` 还是别处），按块交给
  shellcheck；`shell: pwsh` 之类的块跳过。
- **`${{ ... }}` 先替换再检查**：GitHub 在脚本交给 bash 之前就展开了表达式，直接喂
  给 shellcheck 会把 `"${RELEASE_TAG}"` 后面的 `}}` 看成多余的括号（真实报错是
  SC2296）。脚本把每段 `${{ ... }}` 换成等长的下划线，长度不变、行号列号不变。
- **每份输入一个子进程**（`node scripts/lint-workflows.mjs --lint-worker`）。两个
  wasm 都有「同一实例不能连着用」的毛病，实测：
  - shellcheck-wasm 同一实例第二次调用撞上 GHC 运行时自己的
    `schedule: re-entered unsafely`，之后整个实例都坏；
  - actionlint 的 JS 绑定在 `RunActionlint` 之后先 `WasmFree` 再读结果字符串，
    读的是已释放的线性内存。下一个文件往前挪了堆，上一个文件报的错就被冲掉：实测
    `publish-image.yml` 的错误在单独跑时出现、放在其他文件之后读到的是 0 条。
    这个洞比前一个更危险——它会把报错静默吞掉。
- **在 `pnpm install` 之后跑**：脚本 import 的是 node_modules 里的两个包。这是这条
  门禁唯一变慢的地方（原来几百毫秒，现在要等依赖装完），换来的是「装依赖能过、这一步
  就能过」，与任何外部地址无关。
- **同时接进 `pnpm run check`**（`check:workflows`）：本地也能跑，不用等 CI。

## Alternatives considered

- **给 `curl` 加重试/退回镜像**：问题不在重试次数。504 是 CDN 侧的网关超时，
  四次都没过；再加重试只是把红的时间往后推，同时把「工作流写坏了」的信号继续裹在
  网络噪声里。镜像站同样会挂，还要再信一个第三方。
- **`github-actionlint@1.7.12`**：它是个下载器——第一次运行去 GitHub Releases 下
  官方二进制并缓存到 `~/.github-actionlint`。实测在没有网的环境里就是
  `Download failed: 504`，与现状同一个洞，只是多了一层 npm 包。
- **`node-actionlint@1.2.2`**：wasm 版，但已停更（2021），内置的 actionlint 落后
  当前语法规则（连 `docker/setup-*` 的 `@sha` 都不按现代格式解析），装上就是
  永远有假报错。仓库里没有 `ignore` 的位置给它。
- **`shellcheck-binaries@0.8.0`**：真二进制，但包体 152 MB（7 个平台全打进去），
  为了每次 CI 跑一遍 shellcheck 让所有人装 152 MB 不划算。`shellcheck-wasm` 的
  17 MB 只多在一个 GPL-3.0 的 wasm 文件上，仓库是 MIT、只是 dev 依赖。
- **自己写一个 Node 脚本解析 YAML + 检查 `if:` 上下文**：`python3 yaml.safe_load` 只能
  验语法合法，GitHub 的表达式上下文白名单、`uses:` 的 sha 形态、`needs` 的输出引用都
  要自己维护一份规则表，等于重写 actionlint。
- **把 actionlint 加进 `pnpm run check`**：见下面 Consequences——当时拒绝的理由是「本机
  依赖一个 Go 二进制」，现在它是 npm 依赖，这条理由消失了，所以这次不再排除。
- **继续用 `actionlint` 的 `-ignore` 压既有报错**：`-ignore` 按消息正则过滤，既有的
  SC2086 会全被放行，包括以后新写的同类错误。这次仍然保留「全部改掉、不留 ignore」。
- **在 JS 里复用同一个 wasm 实例、用队列串行调用**：串行解决不了内存被释放的问题
  （actionlint）和运行时重入的问题（shellcheck）。worker_threads 也不行：
  实例状态在模块级，坏掉只能整进程丢。

## Consequences

- 门禁不再依赖 `github.com` 的发版 CDN：`pnpm install` 能过，这一步就能过。要真的
  让 workflow 变红，只能是 workflow 自己有问题。
- 代价：`build-check-test` 的 lint 从「装依赖之前 1 秒」变成「装依赖之后十几秒」
  （12 个工作流 + 60 个 `run:` 块，每块一个 node 进程）。失败信号也随之后移——
  workflow 写坏了要等依赖装完才红，而不是 10 秒内。装依赖本来就是这一步的前置，
  没在关键路径上新增顺序。
- 版本升级由 Renovate 负责：`actionlint` 与 `shellcheck-wasm` 都是普通 devDependency，
  跟着 npm 组走 automerge，不再需要人工改 URL 里的版本号和 sha256。
- 行为上的差异有两处，都是收紧而不是放松：
  - shellcheck 的 `--enable=all` 口径由 wasm 版默认带着，SC 编号与 0.11.0 一致；
  - `run:` 块的分行方式改为「按 step 的 `shell:` 分流」，`shell: pwsh` 的块不再喂给
    shellcheck（原来 actionlint 也是跳过，效果相同）。
- 这篇笔记替代了 #569 那版「从 Releases 下两个二进制、钉 sha256」的落地方式；
  被否掉的老路写在这里，#569 的正文不再重复。

## Verification

- `node scripts/lint-workflows.mjs` 对当前树：`workflow lint ok`（exit 0）。
- 反例对照（都 exit 1）：
  - `run:` 块里 `echo $UNQUOTED` → `workflow.yml:8:6: SC2086`，行号与工作流一致；
  - `uses: actions/checkout`（缺 `@ref`）→ actionlint 的 `invalid format because ref
    is missing`；
  - job 级 `if: ${{ env.FLAG != '' }}` → `context "env" is not allowed here`，
    正是 #530 那条；
  - 把 `publish-image.yml` 里 `docker/setup-buildx-action@` 的 `@` 换成某个字符 →
    同一份文件里报出来的错与单独跑时一致（这条同时验证了子进程隔离：不隔离时，
    它排在别的文件后面会被读成 0 条）。
- `node --test scripts/lint-workflows.test.mjs`：6 条全过，覆盖上面四种情形、
  `shell: pwsh` 跳过、`${{ }}` 预处理。
- `node scripts/check-pinned-deps.mjs` 通过（两个新依赖是精确版本）。
- 两个脚本文件过 `biome check --error-on-warnings`（仓库的 `files.includes` 只管
  `packages/**`，`scripts/*.mjs` 不在 biome 的检查范围里，这里是按同一份配置单独校的）。

Related: [job 级 if 读不到 env/secrets](../bug-fix/2026-11-06-job-if-cannot-read-env-or-secrets.md)
（这条门禁要防的具体缺陷）、[必选检查的名字带工作流名](2026-11-02-required-checks-name-carries-workflow-name.md)
（为什么 lint 不能自己单开一个 job）。

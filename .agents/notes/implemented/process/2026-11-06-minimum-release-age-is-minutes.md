# Agent Note: minimumReleaseAge 的单位是分钟，2 是 2 分钟不是 2 天

Status: implemented

> **后续（2026-11-07，`shinytale/nanopi#568`）**：本篇 `## Alternatives considered` 里
> 「同时在 `renovate.json` 里设 `minimumReleaseAge`：这次不做，等有人确认 PR 红 36 小时真的
> 碍事再单独加」——确认了。GitHub 的依赖 PR `NekoSekaiMoe/nanopi#23` 就是那个窗口：Renovate
> 提议刚发布 13 小时的 `@biomejs/biome@2.6.6`，pnpm 的冷却期拒绝写 lockfile，PR 上挂一条
> Artifact update problem、CI 里一条 `ERR_PNPM_OUTDATED_LOCKFILE`。现在两侧对齐（Renovate
> `1 day` + `30 minutes` buffer，pnpm `1440` 分钟），并由
> `scripts/check-renovate-release-age.mjs` 在 CI 里断言。阈值同期从 2160 调到 1440
> （`04db1f603`），本篇正文里的 2160 是当时的判断，保留不改。见
> [Renovate 的冷却期必须与 pnpm 对齐](./2026-11-07-renovate-must-wait-as-long-as-pnpm.md)。

## Problem

`pnpm-workspace.yaml` 里写着：

```yaml
# 2 天冷却期，挡住刚发布的供应链投毒版本。
minimumReleaseAge: 2
```

注释说「2 天」，解析出来是 2 **分钟**。pnpm 把这个设置的单位定为分钟，默认值
`1440` 才是一天（pnpm 文档：`Default: 1440`，`Type: number (minutes)`）。所以这条
配置不但没有 2 天的冷却期，反而比默认的 1 天松得多：只要一个版本发布了 2 分钟以上，
pnpm 就认为它够老。

实测（pnpm 12.18.0，同一个 `react@0.0.0-experimental-5b610964-20261106`，发布 29 分钟）：

- `minimumReleaseAge: 2` → 装上了。
- `minimumReleaseAge: 1440` → `ERR_PNPM_NO_MATURE_MATCHING_VERSION`，报
  「was published at 2026-11-06T16:19:15.622Z, within the minimumReleaseAge cutoff」，
  截止时间正好是当前时间减 24 小时。

也就是说这个仓库自从写进这行起，供应链冷却期实际是 2 分钟。投毒版本被下架的中位
时间是小时级，2 分钟等于没有。注释和配置对不上这件事本身不会报错，`pnpm install`
也不提示——只有当你手动把值改成真正想用的小时数，才会发现 lockfile 里有一批「按
2 分钟装进来的」版本过不了校验。

## Decision

改成 36 小时，并显式写出单位：

```yaml
minimumReleaseAge: 2160  # 36 小时
```

选 36 小时不选 24 或 48：36 小时覆盖一个工作日加一个隔夜，Renovate 的自动合并
（[renovate npm 组](../bug-fix/2026-11-05-renovate-platform-automerge.md)）在版本发布后的
第二个工作日就能合，比 48 小时少卡一整天；比 24 小时多一个隔夜的安全窗，撞在周末
或节前发布的版本不至于一进窗就被合。投毒版本通常在数小时内被发现并下架，36 小时
足够让它落在窗内。

阈值一抬，当前 lockfile 里立刻有 9 条过期：`@anthropic-ai/sdk@1.6.0`、
`@aws-sdk/client-bedrock-runtime@3.1163.0`、`@aws-sdk/token-providers@3.1163.0`、
`@google/genai@3.0.0`、`@isaacs/nonrecursive-glob-match@1.1.0`、`lucide-react@1.69.0`、
`minimatch@11.0.5`、`openai@7.52.0`、`undici@8.12.4`。它们是这几天 Renovate 按 2 分钟的
旧阈值正常升进来的（其中 `@google/genai@3.0.0` 见
[genai 3.0.0 的穷尽检查](../bug-fix/2026-11-06-google-genai-3-malformed-response.md)），
不是可疑包。三个处理方式里选了第三个：

1. **把阈值降回能过校验的值**：等于让「现在装得动」决定安全策略，下次还会退。
2. **重跑 `pnpm install` 把这些版本解析到更老的、已过冷却期的版本**：会把
   `@google/genai` 拉回 2.x，刚刚做完的升级白做，且未来每次抬阈值都要重演一遍降级。
3. **`minimumReleaseAgeExclude` 按版本号逐条豁免这 9 条**：lockfile 不动，阈值是
   真实生效的 36 小时，新出现的版本仍然要被冷却。

`minimumReleaseAgeExclude` 匹配的是 `<包名>@<版本>`，不是包名——`react@19.3.1` 的豁免
不会放过 `react@20.0.0`。这一点很重要：写包名等于给这个包永久免检，写版本号只给
那一个已存在的版本放行。

同时打开 `minimumReleaseAgeExcludePrune: true`：豁免条目在 lockfile 不再解析到它
时自动清掉。没有这个开关，那 9 条会永远躺在配置里，半年后没人说得清哪些还有必要。
实测 `pnpm install` 会删掉不再被解析的条目；仍在用的条目连同它的注释原样保留。

## Alternatives considered

- **改成 1440（1 天，即 pnpm 默认）**：pnpm 的默认值是最省事的选择，但它把「用多久
  的窗」交给上游默认，而不是本项目对投毒发现时间的判断。36 小时是显式选择，写出来
  才有人能质疑它。
- **保留 `minimumReleaseAge: 2` 只改注释为「2 分钟」**：把文档改成符合现状，2 分钟
  等于关掉这个功能，那不如删掉配置，至少不会让读配置的人误以为有保护。
- **改用 `minimumReleaseAgeStrict: false` 让 install 在无解时回退**：strict 默认在
  显式配置 `minimumReleaseAge` 后就是 `true`，回退的确能让装动，但也会让新版本的
  冷却在「没有成熟版本可用」时静默失效——正是要防的那条缝。
- **`trustLockfile: true` 跳过 lockfile 校验**：能绕过这 9 条，但注释明说它适用于
  「每个提交都来自可信作者」的封闭项目，而这个仓库接收外部 PR。跳过校验等于让任何
  人在本地用更宽的策略写出的 lockfile 一路进 main。
- **同时在 `renovate.json` 里设 `minimumReleaseAge: "36 hours"`**：Renovate 会挂一个
  `renovate/stability-days` 的 pending 检查，版本没满 36 小时就不建 PR，于是没有
  「开着红 PR」的窗口。这次不做，因为它改的是依赖 PR 的节奏而不是冷却期本身，会和
  自动合并的时序判断混在同一个改动里；等有人确认「PR 红 36 小时」真的碍事，再单独
  加这一条，值必须与这里一致。

## Consequences

- 冷却期从 2 分钟变成 36 小时，是真实生效的行为变化，落在 Renovate 上：Renovate
  不读 pnpm 的配置，会照常把 `package.json` 钉到刚发布的版本，然后用 pnpm 解析
  lockfile——那一步在冷却窗内直接失败。实测同一个仓库形态（`package.json` 钉住一个
  30 分钟前发布的版本 + `minimumReleaseAge: 2160`）：

  ```text
  Error: ERR_PNPM_NO_MATURE_MATCHING_VERSION
    ╰─▶ 1 version does not meet the minimumReleaseAge constraint
  ```

  所以依赖升级不会一发布就进 PR，等满 36 小时的那一轮才建出来。代价是这 36 小时内
  依赖升级「迟到」，Renovate 日志里会留一条 lockfile 更新失败的记录；收益是升级落地
  前真的过了一个冷却窗。若哪天觉得迟得太久，改这里的一个数字就够，不必动 lockfile。
- 那 9 条豁免是历史欠账，不是政策。清理靠 `minimumReleaseAgeExcludePrune`：将来
  同包升级到新版本时，旧版本条目在写 lock 的那一刻消失。实测被清掉的是条目本身，
  条目上挂的注释会留下来（`# 这条要清掉` 那行还在，下面已经没东西了），所以别往这个
  列表里写解释性注释，理由写在这个笔记里。没有东西可清时文件不动，不会每次 install
  都重写。
- 单位踩坑的通用教训写在这里而不是散在注释里：pnpm 里凡是带「时间」的配置，
  默认值和单位要一起读（`minimumReleaseAge` 分钟、`trustPolicyIgnoreAfter` 分钟），
  只照注释抄数字就会像这次一样静默失效。

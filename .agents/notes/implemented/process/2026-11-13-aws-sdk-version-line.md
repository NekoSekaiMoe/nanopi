# Agent Note: aws-sdk 的版本线要自己钉住，否则单文件里有两份 @smithy/core

Status: implemented

## Problem

`shinytale/nanopi#709`：`full` 的单文件产物从 `v20261107` 的 8.79 MiB 涨到 main 的
9.17 MiB，+0.38 MiB，期间没人为体积加过东西。

按 esbuild metafile 的去重输出来看，涨的全部是 aws-sdk：

```text
                                v20261107        main
@smithy/core@3.39.0             205,447 B       177,079 B
@smithy/core@3.40.0                    -       205,298 B
```

`@aws-sdk/*` 加 `@smithy/*` 合起来 437 KiB → 745 KiB。同一段时间 `@google/genai` 3.0 →
3.2 只涨了 3.4 KiB，自己代码涨了 20 KiB 量级。

两份 `@smithy/core` 是这么来的。aws-sdk 整族包互相声明 `^3.x`，而 `^3.x` 在 3.x 上跨
minor，于是 pnpm 可以合法地装出两条线：一条是直接依赖
（`@aws-sdk/client-bedrock-runtime`）要的新线，一条是上游**精确固定**的旧快照拖着的。
`513164bee`（renovate "Update npm dependencies"）把 `client-bedrock-runtime` 提到
3.1166.0，顺带把大部分 `@smithy/*` 与 `@aws-sdk/*` 推到 `@smithy/core@3.40.0`，但
`@aws-sdk/credential-provider-sso@3.973.25` 对 `@aws-sdk/token-providers` 写的是精确版本
`3.1162.0`，而 3.1162.0 声明 `@smithy/core@^3.38.0`——它锚在 3.39.0 上，于是两条线、
两份 smithy/core，bundle 里两份都进。

问题不在于「升级了依赖」，而在于**没有任何东西看着这件事**：`pnpm-lock.yaml` 里多一个
快照，`scripts/check-openai-client-size.mjs` 只看 `openai`，构建照绿，只有 release 产物
默默重了 0.38 MiB，等到发版才被人看出来。

## Decision

`pnpm-workspace.yaml` 的 `overrides` 里钉住跨线的那两个包：

```yaml
  '@aws-sdk/token-providers': 3.1167.0
  '@smithy/core': 3.40.0
```

`token-providers` 的三份快照（3.1162 / 3.1166 / 3.1167）收成 3.1167.0，
`@smithy/core` 的两份（3.39.0 / 3.40.0）收成 3.40.0。两者都满足树上所有声明范围
（`@smithy/core` 全族下界最高是 `^3.40.0`，`token-providers` 的消费者全是 `^3.1162.0`
起），所以不需要动任何 `package.json`，也不需要 `minimumReleaseAgeExclude`：3.40.0 与
3.1167.0 都在 main 上跑过一段时间。

**不钉的部分**：`@aws-sdk/core` 3.980.0/3.981.0、`credential-provider-*` 等十几对精确
兄弟包仍然分叉。它们和 `token-providers` 一样是上游的精确固定造成的，钉它们等于每来
一次上游同步就补一批 override，而它们是按 client 划分的代码，trimmed flavor 按 API 集
就把它们剪掉了（`base` 不带 bedrock 那两个 API）。真正吃字节的是公共底座
`@smithy/core`，而它的所有声明范围从 `^3.33.2` 起，一份就能满足全家——这一条是可以
长期守住的。

`scripts/check-aws-sdk-version-line.mjs`（进了 `pnpm run check`）读 `pnpm-lock.yaml`，
只允许 `@aws-sdk/core`、`credential-provider-*`、`nested-clients`、
`signature-v4-multi-region`、`types`、`xml-builder` 分叉，`@smithy/*` 与
`token-providers` 一旦再分叉就红，报出「谁出现了哪几个版本」。选锁文件而不是构建产物，
是因为 `pnpm run check` 要在没 `pnpm run build` 的 checkout 上也能跑
（同 `check-openai-client-size.mjs` 在 #567 的教训）。

## Alternatives considered

- **只钉 `@smithy/core`**：够修这一次。留 `token-providers` 三份快照在树里，就留着一个
  随时会再长出第三种 `@smithy/core` 下界的入口——下次那是 3.41 和 3.40 并列，而 override
  钉的是 3.40.0，pnpm 会把新线降回 3.40.0，看起来「没事」，直到有人顺手把 override 抬
  上去，旧线又露出来。把 token-providers 一起收掉，等于从根上让它只有一条线。
- **钉全部 aws-sdk 分叉**：`@aws-sdk/core` 那对要钉在 3.980.0 还是 3.981.0 都要赌一个
  上游没测过的组合，而且每次上游同步都要补。收益接近零：这些包按 client 分区，进不了
  trimmed 产物。
- **把 `@aws-sdk/client-bedrock-runtime` 降回 3.1165.0**：只是把差异推到另一边，下一次
  renovate 又提上来。而且锁住一个安全补丁级别的上游版本，是拿依赖更新换体积。
- **在 esbuild 侧去重**：bundle 里两份 `@smithy/core` 是两条独立的解析路径，要让 esbuild
  合并得靠 alias 或 `dedupe` 指到同一个目录。`dedupe` 只对同名同版本生效，这里版本不
  同；alias 则等于在构建期撒谎说 `3.40.0` 可以满足 `^3.38.0` 的消费者——那是 pnpm 该做的
  事，做在构建期会让 `pnpm install` 装的东西和发出去的产物不一致。
- **加大体量预算而不是消重**：`scripts/check-openai-client-size.mjs` 是绊线不是锁，但这
  次的 +0.38 MiB 不是「SDK 正常演进几个 KiB」，是同一份代码装了两遍。给一份重复代码
  抬预算，等于把绊线的方向搞反。
- **让 renovate 一次升完整个 aws-sdk 家族**：`@aws-sdk/*` 的发布本来就不同步（这次
  `client-bedrock-runtime` 和 `credential-provider-sso` 相差好几轮），renovate 再怎么分组
  也只能每轮升到当时的最新，分叉依旧。

## Consequences

- `full` 单文件 9,613,605 B → 9,412,987 B，-200,618 B（-0.191 MiB），9.17 → 8.98 MiB。
  这是同一台机器、同一份 `pnpm run build` + `scripts/build-coding-agent-single-file.mjs`
  的前后对比。回到 8.79 MiB 不可能：`@google/genai` 3.0 → 3.2 等真实升级还在里面。
- lock 里少一个 `@smithy/core` 快照、两个 `token-providers` 快照，import 图里少一份
  ~200 KB 的模块，顺带少一次模块求值（`@smithy/core` 在 bedrock 路径上是热模块）。
- `overrides` 是「我们替上游做的一个断言」：断言 `token-providers@3.1167.0` 能被
  `credential-provider-sso@3.973.25`（声明 3.1162.0）接受。方向是**向上**，版本更高的
  patch 级，行为面就是补丁；但要记得它存在——上游哪天撤销某个 API 时，这里会先咬人。
  两个版本都在 main 上跑过，不是从没装过的组合。
- pnpm 在写 lock 时顺手清掉了 `minimumReleaseAgeExclude` 里已经过期的五条豁免
  （`minimumReleaseAgeExcludePrune` 的正常行为），与本改动同批落盘。
- 新检查是 `pnpm run check` 的一环，因此也在 `build-check-test` 里。它只读锁文件，不跑
  pnpm、不装依赖。

## Verification

- `node scripts/build-coding-agent-single-file.mjs`（`full`，同一棵树）：
  改前 9,613,605 B / 改后 9,412,987 B。
- esbuild metafile 去重后 `@smithy/core` 从两份变一份；`@aws-sdk/*` + `@smithy/*` 总字节
  回落约 200 KB。
- `node scripts/check-aws-sdk-version-line.mjs`：改前退出码 1，报
  `@aws-sdk/token-providers: 3.1162.0, 3.1166.0, 3.1167.0` 与
  `@smithy/core: 3.39.0, 3.40.0`；改后退出码 0。
- `node --test scripts/check-aws-sdk-version-line.test.mjs`：4 个用例覆盖单份通过、双份
  smithy/core 红、分叉 token-providers 红、上游精确固定的兄弟包放行。
- `pnpm install --frozen-lockfile` 在改后的 lock 上干净通过（含 36 小时冷却期校验）。

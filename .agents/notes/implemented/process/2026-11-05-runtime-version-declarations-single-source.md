# Agent Note: 运行时版本声明只有一个源，Renovate 在它外面拦，`@types/node` 与 `protobufjs` 都不许抢跑

Status: implemented

> **已被部分取代（2026-11-05，`shinytale/nanopi#516`）**：本篇 `## Decision` 里把 `engines` 规则从 `enabled: false` 换成 `allowedVersions` 的那条，以及「`@types/node` 的 major 规则引用同一个值」这个理由，已被实测推翻：`allowedVersions` 拦不住 `rangeStrategy: pin` 对 `engines.node` 的范围改写，而那两条规则在配置里并不互相引用。`engines` 规则已改回 `enabled: false`，并加了 CI 断言。见 [engines.node 改回 enabled: false](../bug-fix/2026-11-05-engines-allowedversions-regression.md)。本篇其余关于 `protobufjs`、`allowBuilds`、`@types/node` 不抢跑的结论仍成立。

## Problem

Renovate 打出来的 grouped PR 同时升了 `@types/node` 24.19.2 → 26.6.6 和
`protobufjs` override 7.6.6 → 8.8.1，两条都够格自动合，也都会被错判成「只是版本号替换」。

第一条约错位不在 `@types/node` 自己：它只比 `engines.node`（`>=24.0.0`）新了两个 major，
而 CI 的 `node-version`、`Dockerfile` 底图、esbuild `target` 还是 24。类型库变新会把
24 上没有的 API 放进 tsc 的视野，代码编得过、在声明的运行时上跑不了。更难的地方是
这个错位永远不会红：`engines` 不做任何事，CI 只验证 24，`scripts/check-pinned-deps.mjs`
只管版本号格式。`renovate.json` 里原有的 `matchDepTypes: ["engines"]` + `enabled: false`
只挡住了「Renovate 改写 `engines`」，挡不住「Renovate 单方面把 `@types/node` 抬走」——
它把唯一该变的那个声明冻住了，却没冻住依赖它的那一半，于是错位反而更容易发生。

第二条不是版本问题，是「这条依赖没有独立生命周期」：`protobufjs` 不在任何
`package.json` 里，只由 `pnpm-workspace.yaml` 的 `overrides` 钉住，唯一消费者是
`@google/genai`，而后者自己声明 `protobufjs: ^7.5.4`。override 到 8.8.1 是上游没验证过
的组合；`8.6.5` 的 `#2336`（编码时省略隐式标量默认值）在解码路径上实测无影响，但那个
结论依赖「仓库不 import `@google/genai/tokenizer`」这条当前事实，不是上游保证。

两条都指向同一个结构问题：运行时版本其实只有一处真声明（`engines.node`），
其余（workflow、底图、esbuild target、`@types/node`）都是它的副本，而 Renovate 只看
得到副本里的某一个。

## Decision

**`engines.node` 是唯一的运行时版本声明，Renovate 只能读它、不能写它。** 七个
`package.json` 里的值保持 `>=24.0.0`，`renovate.json` 那条从 `enabled: false` 改成

```json
{
  "matchDepTypes": ["engines"],
  "allowedVersions": "/^>=24\\.0\\.0$/"
}
```

理由：`enabled: false` 会让 Renovate 连「改写 `engines` 的能力」带整个人工决策点一起
藏起来，而 `allowedVersions` 是同一件事——写了别的就被判为不允许的更新、不产生 PR——
但留下了 `allowedVersions` 这个可被下一条规则引用的值：`@types/node` 的 major 规则
用 `!/^(?:0|[1-9]\d*)\./` 把所有精确版本判为越界，于是它的 major 升级永远不落地。
两条规则合起来就是那句不变量的配置化写法：**`@types/node` 的 major 不可能超过
`engines.node` 的 major**。

在这之上不写 `enabled: false`：那条规则不产生 PR，但 Renovate 照常把被拦下的版本
记进日志，Node 大版本迁移时有人能看见「`@types/node` 26 被挡了」这件事，然后按
[node 24 floor](./2026-10-27-node-24-floor.md) 的五处一起改。

**`protobufjs` 不许独立升级。** 它没有升级路径可开（不在任何 `package.json` 里），
所以 `renovate.json` 里给它补一条 `enabled: false` 把意图写在明处：只有在
`@google/genai` 把 `^7.5.4` 放开时，`pnpm-workspace.yaml` 的 `overrides` 才跟着那条
声明一起撤掉或抬高。想试 v8 就得单独一条 PR 加一条覆盖 tokenizer 解码路径的测试，
不搭 Renovate 的 grouped automerge。

**`allowBuilds.protobufjs` 从 `true` 改成 `false`。** 7.6.6 的 `postinstall`
（`scripts/postinstall.js`）只在依赖方声明的版本不满足它自己 `versionScheme: "~"` 时
往 stderr 打一行警告，脚本本身不写任何文件；实测删掉该目录重装，`dist/protobuf.js`
的 md5 与跑过脚本时逐字节相同。不能直接删这一行——pnpm 12 把「装了但没审批的构建
脚本」当 hard fail（`ERR_PNPM_IGNORED_BUILDS`），`--frozen-lockfile` 直接装不上。
`false` 是 pnpm 认的「明确拒绝」，安装照常，脚本不跑。

## Alternatives considered

- **把 `@types/node` 一起抬到 26（五处一起改）**：那是一次真迁移，得同时改
  `engines`、8 处 workflow `node-version`、`Dockerfile` 底图、esbuild `target`，还要
  重新验证发布产物。值得做的那天做，但理由必须是「Debian testing 的 nodejs 换了」，
  不是「Renovate 提了 PR」。见
  [engines.node 的迭代跟着 Debian 走](./2026-11-02-node-floor-follows-debian.md)。
- **对 `@types/node` 用 `enabled: false`**：最省事，也最像现有 `engines` 规则。
  问题是它同时关掉了「有人在推 major」这个信号，将来 `@types/node` 26 被悄悄拦住
  半年也没人知道。留一条不产生 PR 的拦截规则，代价是每年要读一次 Renovate 日志。
- **`extractVersion` 把运行时版本从 workflow 里抠出来当 `engines` 的 currentValue**：
  能让 Renovate 自己发现 `node-version` 与 `engines` 的错位（`extractVersion` 会强制
  把 currentValue 改成提取结果）。放弃：它会反过来让 Renovate 认为「`engines` 落后于
  workflow」，进而每轮都想把 `engines` 写成 `24.22.2` 再被 `allowedVersions` 拦掉，
  日志噪声比收益大，且 `engines` 的真实判据是 Debian，不是我们自己 workflow 里那个 pin。
- **给 `protobufjs` 写 `ignoreDeps: ["protobufjs"]`**：效果等价，但 `ignoreDeps` 是全局
  名单，将来 `@google/genai` 放开范围、需要跟一轮 `protobufjs` 升级时，这条会静默地
  把它一起吞掉。写在 `packageRules` 里带 `description` 的那条，读的时候一定看得到条件。
- **`pnpm-workspace.yaml` 里删掉 `allowBuilds.protobufjs` 这一行**：看起来最干净，
  实测 pnpm 12 的 `ERR_PNPM_IGNORED_BUILDS` 会让 `pnpm install --frozen-lockfile`
  直接失败，CI 第一步就红。`ignoredBuiltDependencies: [protobufjs@7.6.6]` 也不行
  （同样报错），pnpm 12 只认 `allowBuilds` 里的 `false`。
- **添加一个 CI 脚本比对 `@types/node` 的 major 与 `engines.node`**：能做，但它守的
  是「已经落地的版本」，而这次的问题发生在 PR 合入之前；拦在 Renovate 侧的收益早一步，
  且不用维护第二个版本解析器。真要在 CI 里守，应当等五处一起动的那次迁移顺手做。

## Consequences

- `engines.node` 的迁移流程没变，但它的「不可被 Renovate 改写」从 `enabled: false`
  换成了 `allowedVersions`。同一天里同时改 `engines` 与 `@types/node` 的人工 PR 不受
  影响（规则只约束 Renovate）。
- 代价：`@types/node` 的 major 永远不会自己进 main，Node 大版本迁移仍然依赖人去读
  Renovate 日志或自己发现 Debian 换了包。这条在上一篇里已经承认过一次，这里是同一个
  代价的第二种写法。
- `protobufjs` override 留在 7.6.6，`@google/genai` 仍是 `^7.5.4`。将来
  `@google/genai` 放开范围时的动作写进了 `renovate.json` 的 `description` 和
  [runtime major bumps](./2026-10-27-runtime-major-bumps.md) 的 Consequences 里，
  两处说的是同一件事。
- `allowBuilds.protobufjs: false` 会让 pnpm 在 `pnpm approve-builds` 列表里显示它为
  被拒绝项，不会在安装期提示。
- 验证：`pnpm install --frozen-lockfile`（含删掉 `node_modules/.pnpm/protobufjs@7.6.6`
  后重装）、`pnpm run check`、`scripts/*.test.mjs` 169 项全绿。

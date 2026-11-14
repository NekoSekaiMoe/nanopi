# Agent Note: unregisterProvider 要让内置 provider 真的离开目录

Status: implemented

## Problem

`ModelRuntime.unregisterProvider` 只清掉 `extensionProviders` / `nativeExtensionProviders`，
再 `recomposeProvider`。内置 provider 还留在 `builtins` 里，所以重组的源永远是它，
`models.getProvider(id)` 继续有值。

平时看不出来，是因为每次重组之后那行 `void this.refresh({ allowNetwork: false })`
走的是 `rebuildProviders()`：它拿 `providerIds()` 重新铺一遍，而 `providerIds()` 是从
`builtins` 出发的。于是"注销"只在一瞬间成立，紧接着就被同一次刷新抹平。

真正的受害者不是注销本身，而是**基于 `hasProvider` 写成分支的调用方**。Qoder 每日签到
（`modules/qoder/run.ts`）里写着：

```ts
if (!modelRegistry.hasProvider(provider)) { ... "provider not in this build"; continue; }
```

对一个装了 qoder 的构建，`hasProvider("qoder")` 恒为 true，这条分支永远不进；
对没装 qoder 的构建，`listCredentials()` 也拿不到 qoder 凭据，下一行 `!loggedIn.has(provider)`
同样 `continue`。两种构建里这个分支都到不了，是一个死代码，而且它守的条件
（"这个构建注册了它吗"）是构建期事实，不该由一个能在运行时被改动的目录回答。

## Decision

两处一起改：

1. `unregisterProvider` 先 `this.builtins.delete(providerId)`，再重组。注销对目录是真的了，
   同一次 `refresh()` 也不会把它捡回来——`rebuildProviders()` 依旧从 `builtins` 出发。
2. 签到删掉 `hasProvider` 分支，只按 `listCredentials()` 判断。`QoderCheckinSummary.status`
   的 `none` 因此只表示"这个账号没什么可做"，注释同步改成这个说法。

`hasProvider` 本身保留：`ModelRegistry` 对外的"这个 provider 现在有没有被注册"仍然有意义，
只是不该被当成构建开关用。

## Alternatives considered

**只删签到的 `hasProvider` 分支，不动 `unregisterProvider`。** 最小改动，也解决了死代码。
但留下的是一个"写起来像注销、实际是临时隐藏"的 API：下一次有人拿它做真事（登录态清理、
按需卸载 provider），会再踩一次同样的坑，而且更难查——重组发生在同一个 tick 里，
断点都停不住。所以顺手把语义修对。

**给 `unregisterProvider` 加一个"本次刷新不要重建"的开关。** 只在调用点生效，
`refresh()` 的其它触发路径（session reload、模型列表拉取）照样能把 provider 捡回来，
等于把 bug 挪到更难复现的地方。

**让签到的 `hasProvider` 分支变成构建期判断**（读 `build-components.ts` 的
`isProviderIncluded`）。能保住"这个构建有没有它"的语义，但签到模块本身在
`module/qoder-checkin` 被裁掉时不会加载，而加载了就说明构建带有它；多一层判断只增加
一个可能与构建配置不一致的真相来源。

## Consequences

- 注销现在是持久的，`refresh()` / `rebuildProviders()` 不会把它恢复；回归测试
  `packages/coding-agent/test/model-registry.test.ts` 的 "a full reload keeps a provider the process removed out"
  盯着这条。
- 代价是内置 provider 一旦被注销，本次进程内没有公开的恢复路径（重新
  `registerProvider(id, ...)` 会走 `models.json` 覆盖那条路，不是"重新内置"）。
  目前没有调用方需要恢复；真需要时再加显式入口，而不是靠一个副作用把它捡回来。
- 签到少了一个分支，`/qoder-checkin` 在"两个站点都没登录"时仍然走
  `No Qoder account is logged in` 那条提示，行为不变。

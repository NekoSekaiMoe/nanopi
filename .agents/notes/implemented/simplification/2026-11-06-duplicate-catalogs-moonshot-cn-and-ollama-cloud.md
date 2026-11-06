# Agent Note: 重复 catalog 各留一条（`moonshotai-cn`、`ollama-cloud`）

Status: implemented

## Problem

`full` 的模型目录是 34 个 catalog。其中两组是**同一批模型的第二份拷贝**：

- `moonshotai` 与 `moonshotai-cn` 的 6 个模型 id 完全一致（`kimi-k2.6`、
  `kimi-k2.7-code`、`kimi-k3`、`kimi-k3.1-pro` 及两个 highspeed 变体），
  唯一差别是 `baseUrl`：`api.moonshot.ai/v1` 对 `api.moonshot.cn/v1`。
  这 6 条是生成器两次跑同一个上游 key 写出来的两个 shard。
- `ollama-cloud` 与 `ollama-cloud-token-plan` 来自同一个 models.dev 条目
  （`OLLAMA_CLOUD_TOKEN_PLAN_SOURCE = "ollama-cloud"`），25 个 id、
  `https://ollama.com/v1`、`compat`、价格逐字段相同。

`providerSets.all` 与 `providerSets.presets` 把四条都列进去，选择器里于是出现
「同一个模型的两个条目」。体积只有 ~0.1 MiB，成本不在字节：用户要猜哪个能用
自己的 key，而两个都能。

## Decision

**每个重复组只留一个内置 catalog，另一个变成 `models.json` 的一行。**

- `moonshotai-cn` 整个去掉。`EXPLICIT_MODELS_DEV_PROVIDERS` 名单里保留名字，让通用
  OpenAI-compatible 那一遍不要顺手再生成第二份；生成器只保留
  `moonshotai` 一个 variant。中国端点由 `moonshotai` 的 `baseUrl` 覆盖，
  key 仍是 `MOONSHOT_API_KEY`。
- `ollama-cloud` 出 `providerSets.all` / `presets`，`ollama-cloud-token-plan`
  进 `providerSets.all` / `presets` / `core`。留下的那条是订阅套餐的入口：
  除了 `OLLAMA_CLOUD_TOKEN_PLAN_API_KEY` 还有 `/login` 的套餐语义，而
  `ollama-cloud` 只是同一批模型的按量计费 key。它进 `core` 之后 `base`
  从 14 个 catalog 变成 15 个，多出来的正是这个订阅 SKU。

`presets` 与 `all` 的分工不变：两者今天成员相同，分开的理由写在
[build flavors via buildconfig.json](../process/2026-10-11-build-flavors-buildconfig.md)。

## Alternatives considered

- **四条全留，只在选择器里隐藏重复项。** 数据照样打包，隐藏规则是新代码，
  而且每条规则都要回答「这两个为什么是重复的」——答案还是得有人写下来，
  只是从配置搬到了运行时。
- **留 `ollama-cloud`（按量计费）去掉 `ollama-cloud-token-plan`。** id 一致，
  但套餐入口没有它就没有 `/login` 流程，等于用一个订阅 SKU 换同样的体积；
  `base` 正需要这个订阅 SKU。
- **留 `moonshotai-cn` 去掉 `moonshotai`。** 反了：国际端点是默认路径，
  改中国端点只需 `models.json` 里改 `baseUrl` 一行，反过来改的也是那一行，
  但默认值更差。
- **改 models.dev 上游结构，让它只报一个 key。** 上游按计费方式和区域分开
  列是它的结构；我们能决定的是自己打不打包第二份。
- **把去重做成生成期的通用规则（同 baseUrl + 同 id 就直接丢）。** 现在只有
  两组，规则要判断哪一条该留（订阅入口还是按量计费、默认区域还是镜像），
  判错就是悄悄丢掉一个 SKU。写成显式配置更短也更可审。

## Consequences

- `full` 少一个 shard（`moonshotai-cn`，3.7 KiB 交付字节），`ollama-cloud`
  不再生成；选择器里 Ollama Cloud 与 Moonshot 各一条。
- 中国区用户在 `models.json` 里把 `moonshotai` 的 `baseUrl` 指到
  `https://api.moonshot.cn/v1`；按量计费 Ollama 用户加一条
  `{"provider":"ollama-cloud","baseUrl":"https://ollama.com/v1","apiKey":"…"}`。
- `packages/ai/src/providers/moonshotai-cn.ts`、`KnownProvider` 里的
  `"moonshotai-cn"`、`env-api-keys` 与 `model-resolver` 的默认模型条目一起删；
  `packages/ai/test/{providers,supports-xhigh,openai-completions-tool-choice}.test.ts`
  里针对它的断言收敛到剩下的那份 catalog。
- 两条 provider set 的 description 记下理由：`all` 说明「把别人的 catalog
  换成本家列名的 host 不算进来」，`core` 说明 `moonshotai-cn` 为什么缺席，
  下一个加 catalog 的人不用重新推一遍。

# Agent Note: 厂商判定按 hostname 精确匹配，不再用 baseUrl 子串

Status: implemented

## Problem

五处厂商判定写的是 `baseUrl.includes("<host>")`：`openai-completions.ts` 的
`detectCompat`（12 处）、`prompt_cache_key` 开关、`openai-responses.ts` 的
session affinity、`anthropic-messages.ts` 的 OpenRouter 判定、`utils/openrouter-cost.ts`，
外加 `coding-agent/src/core/provider-attribution.ts` 的 `isOpenRouterModel`。
子串命中让一个不受信任的地址继承另一个厂商的请求形状：

- `https://api.openai.com.evil.tld/v1` 命中 `api.openai.com`，于是 `store`、
  `prompt_cache_key`、`reasoning_effort` 全部按 OpenAI 官方发出去；
- `https://proxy.example.com/?to=api.openai.com` 命中路径里的字符串，同上；
- 反向的 `https://evilopenrouter.ai/api` 命中 `openrouter.ai`，于是拿到 OpenRouter 的
  `HTTP-Referer` 与 `X-OpenRouter-Title` 归属头、`sessionAffinityFormat: "openrouter"`、
  以及 OpenRouter 专属的 usage 计费字段解析。

`provider-attribution.ts` 里本来就有正确的 `matchesHost`（`new URL(baseUrl).hostname ===
expected`），但 `isOpenRouterModel` 没调它，另外三处判定也没有共用实现。

## Decision

`packages/ai/src/utils/endpoint.ts` 新增两个 helper，并让原来的 `isSelfHostedEndpoint`
复用同一个解析：

- `hostnameOf(baseUrl)`：`URL.parse` 后的 lowercase hostname，解析失败返回 `undefined`；
- `matchesHostname(baseUrl, domain)`：`hostname === domain || hostname.endsWith("." + domain)`。

后缀比较必须带点。只写 `hostname.endsWith(domain)` 会把 `evilopenrouter.ai` 判成
OpenRouter，把安全项换成了另一个缺陷。

原来写死的完整主机名（`api.together.ai`、`api.moonshot.`、`api.z.ai`）改成了域级匹配
（`together.ai`、`moonshot.cn`、`z.ai`）：同一个厂商的接口前缀不构成安全边界，域才是。
`api.moonshot.` 这种半截字符串本身也是靠子串凑出来的，改成 `moonshot.cn` 后才和
`packages/ai/scripts/generate-models.ts` 的 catalog 一致。`provider` 名字的判断全部保留，
host 只是「provider 字段不对但地址指向该厂商」时的兜底。

`provider-attribution.ts` 删掉自己的 `matchesHost`，改从 `@nanopi/pi-ai/utils/endpoint`
取 `matchesHostname`（该子路径已在 `packages/ai/package.json` 的 exports 里）。

## Alternatives considered

- **在 4 个文件里各保留一份 `matchesHost`**：否。issue 里点名的就是这个，
  四份实现迟早分叉，其中一份漏掉后缀点就是一条绕过。
- **改成 `hostname.endsWith(domain)` 而不加分隔点**：否，见上，`evilopenrouter.ai` 会命中。
- **用 `URL.parse` 后的 `host`（带端口）比较**：否。baseUrl 的端口对厂商判定没有意义，
  而且 `api.x.ai:8443` 会被判成非 xAI。
- **顺手把 `matchesHostname` 变成一个可配置的 provider 规则表**：否，
  和 [2026-11-07](../feature/2026-11-07-openai-compat-provider-quirks.md) 否掉
  `rules/providers/*` 的理由相同，收益只是覆盖更多厂商。

## Consequences

- 判定行为变化：只有 hostname 等于厂商域或它的子域才算命中。经 `models.json` 配到
  代理路径里的地址（`https://proxy/?to=api.openai.com`）不再被当作 OpenAI 官方，
  于是不会再发 `prompt_cache_key` / `store`。这正是要的结果。
- `isSelfHostedEndpoint` 的语义不变，只是内部改用 `hostnameOf`。
- 覆盖：`packages/ai/test/endpoint-hostname.test.ts` 断言子域命中、`api.openai.com.evil.tld`
  与 `evilopenrouter.ai` 不命中、路径/查询里的字符串不命中、非法 URL 不命中。
  `pnpm run check` 与 `node ./test.mjs` 通过。

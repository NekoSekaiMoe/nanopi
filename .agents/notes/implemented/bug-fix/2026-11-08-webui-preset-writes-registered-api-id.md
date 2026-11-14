# Agent Note: webui 的 provider preset 写注册过的 api id，不写列表协议

Status: implemented

## Problem

从 webui 设置页「添加 Provider」加一个账号，能创建、能出现在列表、模型也进了
`/models`，然后一发消息就失败：

```
No API provider registered for api: openai
```

`provider-accounts.ts` 的 preset 表只有一个 `type` 字段（`"openai"` /
`"anthropic"`），`createAccount` 把它原样写进 `models.json` 的 `api`：

```json
{"providers": {"deepseek": {"api": "openai", "baseUrl": "https://api.deepseek.com/v1", ...}}}
```

`type` 本来是**列表协议**：`model-listing.ts` 用它决定探 `{base}/models` 还是
`{base}/v1/models`，以及 key 走 `Authorization: Bearer` 还是 `x-api-key`。
而 `ModelRuntime` 的流式实现按 api id 注册（`api/openai-completions.ts` →
`registerApiProvider({ api: "openai-completions" })`），`composeModelProvider`
最后也按 `model.api` 查注册表。两个名字对不上，账号就成了「能建不能用」。

这个错误只在真的发一次请求时才暴露：`applyModelsJson` 只校验 `api` 在
build 的 API 集合里（`isApiIncluded`），`"openai"` 不在集合里也不会失败，
`modelFromJson` 直接把它当 api 用，模型照常进目录、照常 `available: true`。
`/models` 的 `available` 来自凭证快照，不看 api 是否能流式。

同一张表还漏了另一个洞：`createAccount` 用 preset id 当账号 id，而添加表单没有
账号 ID 字段。于是第二个 OpenAI-compatible 网关必然 409
（`account "openai-compatible" already exists`），除非手改 URL 请求。

## Decision

- `ProviderPresetInfo` 分裂成两个字段：`type` 保留列表协议（页面回传给
  `/providers/discover-models`，决定探测路径和 header），新增 `api` 写
  `models.json`（`openai-completions` / `anthropic-messages`）。
  `createAccount` 写 `choice.api`。
- `toView` 的 `type` 反过来映射：从 `api` id 找回列表协议（`listingProtocol`），
  因为设置页把 `account.type` 送进 discovery。旧文件里已有的 `api: "openai"`
  也按协议读，`anthropic*` 归 `anthropic`、其余归 `openai`。
- 添加表单补「账号 ID」输入框，留空仍用 preset id；同协议再加一个网关时填它。

## Alternatives considered

- **让运行时也注册短名 `openai` / `anthropic`**：这会把一个 api 实现挂两个名字，
  `getApiProvider` 的查表和 `builtinApiProviderInstances` 的身份比较都要跟着放宽，而
  换来的只是让一个错误配置能跑。`models.json` 是用户手写的文件，文档里写的就是
  `openai-completions`，不该让短名变成第二个真理。
- **在 `applyModelsJson` 里把短名映射成 api id**：那等于让配置文件接受两套词汇，
  而 `isApiIncluded` 的语义（"这个 build 带不带这个 api"）会被静默绕过——trimmed
  build 里写 `"openai"` 反而能跑，写 `"openai-completions"` 被跳过。
- **只补表单的账号 ID，不动 api**：第二个洞是独立的，修了也还是 `No API provider
  registered`。

## Consequences

- 新加的账号能真的对话。旧账号（`api: "openai"`）不在迁移范围：它们本来就是坏的，
  而这类文件的合法归宿是用户手改 `api` 或删掉重建；`toView` 只是让它们在页面上
  仍显示正确的协议，不会假装可用。
- `type` 的语义从此固定为「列表协议」。以后加 preset 必须两个字段都写，缺 `api`
  会被类型检查拦下。
- 代价：`ProviderPresetInfo` 多一个必填字段，前端 `ProviderPresetInfo` 的注释也
  跟着点明 `type` 是协议——前端不需要 `api`，它只用于 discovery。

## Testing

- `packages/coding-agent/test/provider-accounts.test.ts` 断言十种 preset 写出的 `api` 是 api id，
  并断言 `toView` 的 `type` 仍是协议。
- `packages/coding-agent/test/webui-provider-account-add.test.ts` 起真服务 + 一个 OpenAI-compatible
  stub 端点：创建后 `models.json` 里是 `openai-completions`，`/models` 列出该模型，
  `/chat` 的流里出现 stub 回的文本且不含 `No API provider registered`；第二个覆盖
  同协议第二个账号（无 id 时 409，带 id 后能对话）。
- 两条用例在修复前都是红的（`expected 'openai' to be 'openai-completions'`）。

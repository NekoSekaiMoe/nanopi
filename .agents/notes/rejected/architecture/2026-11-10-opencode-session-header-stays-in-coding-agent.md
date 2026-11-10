# Agent Note: OpenCode 会话头继续由 coding-agent 注入，不往下沉到 ai 包

Status: rejected — 用户判断：这条对齐项不做。上游把注入点收口在 ai 包的 `withOpenCodeSessionHeader`，nanopi 的 coding-agent 归因层在 `transformHeaders` 里注入；两条路都通到网络，行为等价，重构收益为负。

## Problem

对照 pi v1.3.x（#682 的 1.3.x 盘点）时，`x-opencode-session` 的注入位置是一处结构差异：

- 上游把 `getOpenCodeSessionHeaders` 下沉到 ai 包，由 `withOpenCodeSessionHeader`（`packages/ai/src/providers/opencode-headers.ts`）在 provider 适配器外统一包一层，`opencode` / `opencode-go` 两处 `ProviderStreams` 都套它。
- nanopi 的 ai 包有同一份实现（同样是 `opencode.ts` / `opencode-go.ts` 各套四个适配器），**同时** coding-agent 的归因层 `getSessionHeaders`（`packages/coding-agent/src/core/provider-attribution.ts:69-77`）也注入 `x-opencode-session` + `x-opencode-client`。

也就是说 OpenCode 请求上有两条注入路径。盘点报告一度把它判成 bug——理由是「`transformHeaders` 的产物会被 `prepareRequest` 快照覆盖，头丢了」——这个判读是错的，需要在这篇里钉住真实链路，免得下次再推一遍。

## Proposal

不做这次下沉。保留两条路径，等哪天真要动 header 组装时顺路收口。

### 真实链路：`transformHeaders` 是最后一步，不是被覆盖的那一步

`Models.applyAuth`（`packages/ai/src/models.ts:659-681`）的顺序是：

1. `mergeHeaders(auth.headers, options?.headers)` 得到 per-request headers
2. `if (options?.transformHeaders) headers = await options.transformHeaders(headers ?? {})`
3. 结果写进 `requestOptions.headers`，再传给 `provider.stream(...)`

`transformHeaders` 收工时 headers 才成形，这个对象直接进 provider。没有任何快照在它之后把它盖掉，所以归因层注入的头一路到网络。

实测（`packages/coding-agent/test/sdk-openrouter-attribution.test.ts` 里 `adds OpenCode session headers` 那条）在 fetch 层捕获到的是：

```
x-opencode-session: opencode-session
x-opencode-client:  nanopi
```

两个头都在。ai 包那条路在 `packages/ai/test/opencode-provider-headers.test.ts` 有独立覆盖，同样通。

### 两条路的分工并不对称

ai 包的 `withOpenCodeSessionHeader` 只写 `x-opencode-session`，且 `hasHeader` 大小写不敏感地让调用方覆盖优先。`x-opencode-client: nanopi` 只由 coding-agent 的归因层提供。

所以「下沉」在这里不成立：往 ai 包沉一个不完整的实现，客户端标识这一半仍然得留在 coding-agent；能删掉的只有一行 `session` 注入，代价是把「OpenCode 请求带哪些归因头」这件事拆成两处判断。

## Alternatives considered

### 删掉 coding-agent 那侧，只留 ai 包

最强理由：上游就是这么收口的，一条路径比两条路径好讲——「所有 OpenCode 请求在适配器层统一带上会话头」，编码者不用知道 `transformHeaders` 存在。

否决理由：`x-opencode-client` 会一起丢。要保住它就得在 ai 包再造一套 client 标识注入，等于把一个归因策略从 settings/session 所在的层搬进协议层，而 ai 包现在对「谁在调用我」一无所知。收益是删掉一行重复代码，风险是动到所有 OpenCode 请求的 header 组装面。

### 反过来，删掉 ai 包的 `withOpenCodeSessionHeader`

最强理由：coding-agent 那条路已经能给出两个头，ai 包这份是纯粹的重复，`opencode.ts` / `opencode-go.ts` 各少四行包装。

否决理由：ai 包会被不经过 Models 的调用方（直接 `provider.stream`）使用，那时没有 `transformHeaders` 可挂。这条路径现在没有已知消费者，但 `opencode-provider-headers.test.ts` 的四条用例正是为了守住它，删掉就等于把「ai 包单独可用」的契约收窄，而不只是删重复。

### 两条都留，但抽一层公共的 header 合并

最强理由：重复的是语义不是字符串，能靠一个函数让两处永远一致。

否决理由：它们合并的对象不同——ai 包拼的是 `StreamOptions.headers`，coding-agent 拼的是 `ProviderHeaders` 加 settings 与 model 判定。抽出来要靠一个中间形状粘合两边，比现在多一层间接。

## Consequences

- OpenCode 请求继续有两个头，行为不变。`provider-attribution.ts` 的 `getSessionHeaders` 是 `x-opencode-client` 的唯一来源，改它要同时看 `opencode-headers.ts`。
- 上一条的代价：每次读 header 组装都要读两处才知道最终形态。缓解办法就是这篇——别再拿「上游下沉了」当重构理由重推。
- `transformHeaders` 的时序（`models.ts:675`）是这套判断的依据。如果哪天它被挪到 header 合并之前，这篇的结论要重新核；`sdk-openrouter-attribution.test.ts` 里那条捕获 fetch 层的用例会在那时先红。
- 1.3.x 盘点的结论随之修正：缺口不是「一个真 bug」，是「零个 bug，一条 P3 等价重构」。#682 里 P2 的 `isLegacyWslBashPath` 才是真行为差异，那条单独立项。

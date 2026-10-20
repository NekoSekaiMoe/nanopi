# Agent Note: 响应检查点 + HTTP 增量上下文（Responses / Codex 传输层）

Status: rejected — #119 的收益面只覆盖订阅登录的 Codex 长会话，用户判断量太少，不做。

## Problem

nanopi 跟 OpenAI Responses 通话时，每轮都把完整历史当 `input` 发一遍。"确认送达"的那一轮
留在客户端，下一轮只发新增，这个能力在 Codex WebSocket 那条线已经有了；但状态只活在内存里，
HTTP 的两条 Responses 线完全没有。

具体三个洞：

- **增量只在一条线上有。** 增量 delta 只存在于 `openai-codex-responses.ts` 的
  `buildCachedWebSocketRequestBody()`：拿 `lastRequestBody.input + lastResponseItems` 做前缀比对，
  命中就带 `previous_response_id` 只发尾部，状态在 `CachedWebSocketContinuationState` 里，
  挂在 `websocketSessions` 的连接 entry 上。`openai-responses.ts` / `azure-openai-responses.ts`
  走 HTTP，每轮都是完整 input。
- **状态活不过连接。** `releaseSessionWebSocket()` 在 `!keep` 时关 socket 并清
  `session.connection`（`openai-codex-responses.ts:1258`），`scheduleSessionWebSocketExpiry()`
  的 5 分钟 idle 到点也清（`:1247`）。结果是重连必然退回全量上下文，进程重启必然全量。
- **`store` 是死值。** Chat Completions 由 `compat.supportsStore` 门控写 `store: false`
  （`openai-completions.ts:845`）；`openai-responses.ts:340`、`azure-openai-responses.ts:203`
  无条件写 `false`，没有 compat 门控；`openai-codex-responses.ts:721` 也写 `false`，
  且服务端直接拒 `store: true`（`:1704` 注释）。配置层没有任何地方能让 `store` 变成 `true`。

不做的后果是：跨重连、跨重启的续接永远拿不到，长上下文每次重发。这是"性能没榨到极限"，
不是"功能坏了"——见下面的 Decision 里的判断。

## 提案时的事实

这段增量代码只在一条组合上运行：api 是 `openai-codex-responses`（只有 `openai-codex` 这一个
provider），传输是 WebSocket 且 `transport` 为 `auto`（默认）或 `websocket-cached`——也就是
「ChatGPT 订阅登录、按订阅而非 token 计费」的用法。按 token 计费的 API key 用户真正省钱的是
prompt cache，跟这件事无关；`transport: sse` 的用户断了本来就该全量重发。

`store` 在四处都是死值：Chat Completions 由 `compat.supportsStore` 门控写 `false`
（`openai-completions.ts:845`），HTTP Responses、Azure Responses、Codex 都无条件写 `false`，
配置层没有任何地方能让它变成 `true`。

## Proposal

按四步拆开，每步一个 PR，顺序不能换：

1. **作用域校验 + 失效信号**（纯逻辑，不改变行为）：给检查点加 provider、baseUrl 哈希、key 指纹、
   model、`store` 取值、`windowId`，任一项不匹配就丢弃。先只做记录，不启用续接。
2. **HTTP Responses 的 `previous_response_id`**：先做 `openai-responses.ts`，配合 404 / 服务端
   清空时的一次全量回退。此时仍 `store: false`。
3. **检查点落盘**：让 `CachedWebSocketContinuationState` 跨进程存活。落盘内容瘦到
   `response.id` + 作用域，`lastRequestBody` / `lastResponseItems` 从 session 重建；
   流式中途断用 `open` / `closed` 两条 entry 兜底，只有 `closed` 可续。
4. **`store: true` 的显式开关**：最后做，`compat.supportsStore` 三层（api / provider / model）
   门控，默认关，带隐私说明。

验收标准是：重启后 Codex 长会话的第一轮请求 input item 数量显著少于全量；作用域变更（换 key、
换 baseUrl、压缩、切模型）后 `previous_response_id` 必不出现；`store: true` 在 Codex 路径上
永远发不出去（`stats.storeTrueRequests` 恒为 0）。

## Alternatives considered

### 做（分四步：作用域校验 → HTTP 增量 → 落盘 → `store` 开关）

这是提案本身的路径，最强论据已写在上面的 Proposal 里：落盘确实不需要存请求体（`lastRequestBody`
与 `lastResponseItems` 都能从 session 派生），真正不可推导的只有 `response.id`；`windowId`
现成能覆盖压缩 / 分支 / 模型切换的作废。技术上成立，代码结构也撑得住。

### Why not 做？

收益面只覆盖「订阅登录 + 长会话 + 跨重连/重启」这一个交叉口，而这条线的量本身很小，
用户明确判断"对订阅用户也没啥必要"。为这个窄场景要新引入三块复杂度：session JSONL 新增
`checkpoint` entry 类型（及其兼容、校验、清理）、作用域与失效的落盘契约、`store: true` 的隐私
开关。现状（连接作用域续接 + 断了全量重发）能正常工作，只是没榨到极限，不是坏了。
代价与收益不成比例。

### 只做作用域校验，不做落盘与 `store`

给检查点加 provider / baseUrl / key 指纹 / model / `store` / `windowId` 字段，不匹配就丢弃。
这是最便宜的一步，纯防御。

最强的论据是串号风险真实存在：`previous_response_id` 是 OpenAI 侧的对象 id，绑在「同一个 key +
同一个 baseUrl + 同一个组织」上，把 A 账号的响应 id 发给 B 账号轻则 404、重则把 A 的上下文
泄漏给 B。但内存里的两道现成作用域已经挡住了它：`websocketSessions` 的 key 是
`[cacheSessionId, sessionId, threadId]`（`openai-codex-responses.ts:406`），连接 entry 还要过
`getWebSocketOwnerKey(url, headers)` 的所有权比对（`:1886`，headers 含 token，且请求级 header
已被 `WEBSOCKET_REQUEST_SCOPED_HEADERS` 排除）。换 key、换 baseUrl 都会让 owner key 变化而重建
连接，`continuation` 随之消失。没有落盘就没有跨进程复用旧 id 的通道，这道校验防的是一个不存在
的入口。所以不做。

### HTTP Responses 也走 `previous_response_id`

让 `openai-responses.ts` 与 `azure-openai-responses.ts` 每轮只发新增，能让所有 Responses
用户少发长上下文——覆盖面比 Codex 那条线大得多，这确实是它最强的论据。

否掉它的原因是缺前提：`previous_response_id` 要求服务端能寻回上一轮响应，即 `store: true`；
而按 token 计费的用户已经在吃 prompt cache，重传的 token 有缓存价，再叠一层服务端存储换来的省量
很有限，换来的却是各家网关支持度不一、404 回退路径、隐私开关三件事。覆盖面大不等于收益大。

### 检查点落盘（每个 assistant 响应一条，只存 `response.id`）

像 `UsageEntry` 那样往 session JSONL 追加一条 `{ provider, baseUrlHash, keyFingerprint, model,
store, responseId, windowId }`；流式中途断用 `open` / `closed` 两条 entry 兜底，只有 `closed`
可续；`windowId`（`core/sdk.ts:367` 的 `${sessionId}:${compactions.length}`）负责压缩、分支、
模型切换后作废。一条记录 150–200 字节，比一条 usage 还小。

这是这个方向里性价比最高的形态，设计本身没问题。否掉它的不是设计而是分母：落盘的全部价值都投在
「订阅登录的 Codex 长会话跨重启续接」这一个场景上，而这个场景的量小到不值得新增一种 session
entry 类型。设计留在上面的 Proposal 里就够了，将来真要做不必重新推导。

## Consequences

- 重连、5 分钟 idle 超时、进程重启之后，Codex 那条线仍然全量重发。这是已知代价，不是缺陷。
- `store` 继续是常量 `false`。想加开关的人得先推翻本篇的收益判断，而不是只加个配置项。
- 内存态的 `CachedWebSocketContinuationState` 与 `stats.deltaRequests` /
  `stats.fullContextRequests` 保持不变；`openai-codex-attribution.test.ts` 与
  `openai-codex-stream.test.ts` 里关于 `previous_response_id` 的断言就是现状的守卫。
- 重访条件：出现「订阅登录 + 长会话 + 重连后明显变慢」的真实反馈，或服务端开始对全量重发限流。
  届时按 Proposal 的四步顺序做，先落盘后 `store`，`store` 默认仍关。

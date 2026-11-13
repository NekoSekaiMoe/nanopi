# Agent Note: MCP 测试替身每个 chunk 只读一帧，管道一合并就挂

Status: implemented

## Problem

`packages/coding-agent/test/mcp-lite-reveal.test.ts`（#697 的回归测试）在 CI 上偶发失败：

```
AssertionError: expected [ 'mcp' ] to include 'mcp__demo__echo'
 ❯ test/mcp-lite-reveal.test.ts:104:29
```

测试里的假 MCP server 用 `process.stdin.on("data")` 收帧，但每个 chunk 只解析**第一行**
（`buffer.indexOf("\n")` 找到就 `return`）。客户端这边 `notifications/initialized` 和
`tools/list` 是两次独立的 `stdin.write`，两条帧能否合并成一次 `data` 事件取决于调度：

- 分开到：两条帧都处理，`tools/list` 有回答，工具注册上。
- 合并到一个 chunk：第一个 chunk 里只被处理的是 `notifications/initialized`（没有 id，
  直接丢弃），第二行留在 buffer 里再没人取，`tools/list` 永远没有回答。

后一种情况下 `connect()` 正常返回，卡住的是 `listTools()`：它的 `tools/list` 请求挂到
120s 的 `REQUEST_TIMEOUT_MS` 上，测试里 6s 的轮询窗口必然先超时，于是 `registered` 只有
`mcp`（wrapper 工具），断言失败。

实测：单个进程里并发 16 个连接打这个替身，旧写法 13/16 卡住；8 路并发跑这个测试文件时
每轮都会有一两个进程撞上。所以是替身的 bug，不是被测代码的 bug —— `client.ts` 的
`StdioTransport` 本身就是 `while ((newline = this.buffer.indexOf("\n")) >= 0)`，一次读全部帧。

## Decision

假 server 改成和客户端同样的循环：一个 chunk 里把所有完整帧都消费掉，剩余部分留在 buffer
等下一个 chunk。断言一字未动——测试要证明的还是「服务器答了什么，模型就能声明什么」。

顺带把注释写在假 server 上，说明为什么必须循环：这是唯一会随管道分片边界变化的地方，
下一个人改这段字符串数组时看得见理由。

## Alternatives considered

**给 `listTools` / `connect` 加超时，把 120s 缩到几秒。** 会让失败更快、日志更清楚，但那
是给测试替身的行为兜底：卡住的根因仍然在，只是从「6s 后断言失败」变成「几秒后超时异常」。
真正该修的是丢掉帧的那一行。

**测试里把 `notifications/initialized` 和 `tools/list` 之间插延时，遥控客户端分两次写。**
客户端不该为测试的可测性改协议时序，而且延时长度取决于机器负载，换了个 flaky 为另一个
flaky。

**改用 `@modelcontextprotocol/sdk` 的 in-memory transport 当替身。** 能彻底躲开管道分片，
但要为一个 60 行的假 server 拉一个依赖，并且会绕开本仓库真正在用的 stdio 路径（含
`launchSpec` 的可执行文件解析）。这条路径恰恰是这个测试要覆盖的。

## Consequences

- 收益：这条回归测试不再取决于 pipe 的分片边界；并发 16 连接 0/16 卡住，连跑 24 次单文件
  0 失败。
- 代价：假 server 多了几行循环。没有新增依赖，没有改客户端。
- 留下的缺口：其他用 `process.stdin.on("data")` 的测试替身（`clipboard-command.test.ts`、
  `tools.test.ts` 里那两处）同样一个 chunk 只读一次，只是它们只收一条帧、不需要多帧，
  才没暴露。以后若让它们答多个请求，按同一处修。

# Agent Note: Ctrl+Enter 立刻插队，批次内检查 steer 队列

Status: implemented

## Problem

人能说话，但说完不生效。模型跑长工具调用时，人的输入排进 steer 队列，要等当前 assistant turn 的
工具调用全跑完、下一次 LLM 调用之前才注入（`packages/agent/src/agent-loop.ts` 的轮询点在
`executeToolCalls` 之后）。这期间人以为指令进去了，实际作业还在按旧方向跑。

具体坏例子：模型 spawn 了一个在错误目录跑的 `pnpm check`，人发一句「kill 掉重跑」。这句进了 steer
队列，等作业跑完才被读到——已经晚了，`dist/` 被写脏了。

issue #411 要的是：给这种「立刻插队」一个按键，并且真的能截断当前 loop。

## Decision

两层，缺一层都不成立。

**loop 层：批次内的检查点。** `executeToolCallsSequential` 在发起第 2 个及之后的 tool call 之前轮询
`getSteeringMessages`。轮到的消息如果标了 interrupting，批次就在这里停下：

- 没跑的 call 也要有结果，协议要求一个 call 对一个 result。每个被跳过的 call 发一条
  `tool_execution_end` + error tool result，正文写明「被用户的 steering 打断」并带上那句提示词原文。
- 已经跑完的 call 保留自己的 result。丢掉它们会篡改「确实发生过的事」，也会让历史里出现没有提问的
  toolResult。
- 这条 steer 消息带上 `interruptDelivered`，主循环跳过本回合收尾的那次轮询——消息已被批次消费，再轮询
  一次就让 one-at-a-time 模式一个回合注入两条。

**session 层：谁能标 interrupting。** `Agent` 的 steering 队列改成 `InterruptingMessageQueue`，记住哪些
消息是插队进来的。`drainForPoll()` 只要本次抽出的消息里有插队的，就返回
`{ messages, interrupt: true }`（`SteeringPollResult` 的对象形态）。已经被注入过的消息在「仍在队列里」时
继续带着这个标记，于是后续轮询照旧拿到对象形态、空消息——既不重复注入，也不会主循环多轮询一次。

**按键层。** `app.message.steer` 默认 `ctrl+enter`，`AgentSession.prompt` 增加 `steerInterrupt`。没在跑
的时候 Ctrl+Enter 等同 Enter，压缩期间按普通 steer 排队。

## 为什么不是 abort 再重发

`Ctrl+Enter` 不是 Esc。Esc 走 abort：当前 assistant turn 被砍掉、stopReason 变成 aborted、整轮结果
作废。人想要的通常是「停在这个计划上，别继续往下跑，听我说一句」，而不是「这一轮白干」。

## 边界（写清楚，否则会被当成 bug）

- **并行批次不打断。** 并行路径先同步跑完所有 `prepare`，再 `Promise.all` 执行；批次中间插一条 user
  message 会破坏 `toolCall` / `toolResult` 的配对顺序。这类批次的 steering 只在下一个回合边界生效。
- **正在跑的那个工具不打断。** 检查点在 call 之间，一个 5 分钟的 `bash` 仍然要跑完。想砍掉它用 Esc。
- **模型看到 steering 后仍可能先跑完自己已经规划好的步骤。** 这一层在 loop 之外，改不了。

## Alternatives considered

- **直接 abort 再发 prompt**：语义是「这轮作废」，不是「改方向」。而且 abort 之后要用户自己再发一次，
  多一步。已在上面单独说明。
- **给 `steeringMode` 加一档 `immediate`**：`steeringMode` 现在管「一次注入几条」，不管「何时注入」，
  两个维度混进同一枚举，之后没法单独调。且它是 settings 级全局开关，而「打断」应该是一次按键的意图。
- **异步杀掉正在跑的工具**：需要在 `executePreparedToolCall` 里 race 一个队列监听，工具被 signal
  abort 后结果形态、`afterToolCall` 是否还跑都要重新定义，收益只是省一次工具的时间。

## Consequences

- 代价：sequential 批次每个 call 之前多一次队列轮询（内存操作，无 IO）。
- 代价：被打断的批次会在模型上下文里留下「N 个没跑的 call + 错误结果」，模型要多读几条消息。
- 收益：`Ctrl+Enter` 之后，同一个计划里剩下的 call 不再开跑。
- 收益：`bash_bg` + `bash` 这类「先起后台任务再检查」的多 call 批次，能在检查之前被截断。

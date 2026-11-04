# Message Types

nanopi uses `AgentMessage` values in SDK state, lifecycle events, RPC responses, and persisted session message entries. This page defines those shared messages and their content blocks.

Message timestamps are Unix timestamps in milliseconds. They are different from the ISO 8601 timestamps on [session entries](session-format.md#entry-base).

Source definitions:

- [`packages/ai/src/types.ts`](https://github.com/NekoSekaiMoe/nanopi/blob/main/packages/ai/src/types.ts) defines provider-facing messages and content blocks.
- [`packages/agent/src/types.ts`](https://github.com/NekoSekaiMoe/nanopi/blob/main/packages/agent/src/types.ts) defines the extensible `AgentMessage` union.
- [`packages/coding-agent/src/core/messages.ts`](https://github.com/NekoSekaiMoe/nanopi/blob/main/packages/coding-agent/src/core/messages.ts) adds coding-agent message roles.

## Content blocks

### TextContent

```typescript
interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}
```

`textSignature` contains provider-specific message metadata. Treat it as opaque.

### ImageContent

```typescript
interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
```

`data` is base64-encoded image data. `mimeType` identifies its media type, such as `image/png` or `image/jpeg`.

### ThinkingContent

```typescript
interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}
```

Thinking signatures contain provider-specific replay data. Treat them as opaque. A redacted block can have no visible thinking text while retaining an encrypted payload in `thinkingSignature`.

### ToolCall

```typescript
interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
  thoughtSignature?: string;
  namespace?: string;
}
```

`thoughtSignature` is provider-specific. `namespace` identifies an OpenAI Responses namespace for dynamically loaded or namespaced tools.

## Usage

Assistant messages always contain usage. Tool results can contain usage when the tool performed nested model work.

```typescript
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

When present, `reasoning` is already included in `output`; do not add it again. `cacheWrite1h` is the subset of `cacheWrite` written with one-hour retention.

## Base messages

### SystemMessage

```typescript
interface SystemMessage {
  role: "system";
  content: string | TextContent[];
  sections?: Record<string, string | null>;
  toolsAdded?: Tool[];
  toolsRemoved?: ToolReference[];
  timestamp: number;
}
```

The leading system message declares the initial prompt and tools. Later system messages can append instructions, replace or remove named prompt sections, and add or remove tools. Replaying them in order yields the current state.

### UserMessage

```typescript
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}
```

### AssistantMessage

```typescript
interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  providerThinkingLevel?: string;
  thinkingLevel?: ModelThinkingLevel;
  diagnostics?: AssistantMessageDiagnostic[];
  usage: Usage;
  stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
  deferred?: DeferredHandle;
  errorMessage?: string;
  rawStopReason?: string;
  endTurn?: boolean;
  timestamp: number;
}
```

`responseModel` records a concrete provider response model when it differs from the requested model. `responseId`, `providerThinkingLevel`, `thinkingLevel`, `diagnostics`, and `rawStopReason` preserve provider or runtime details.

`"pending"` is used for a partial assistant message while it streams. The completed message in `message_end` has a terminal stop reason, and nanopi does not persist `"pending"` assistant messages in session JSONL.

A `"deferred"` response has a `DeferredHandle` with the provider data needed to retrieve it:

```typescript
interface DeferredHandle {
  provider: string;
  modelId: string;
  api: string;
  id: string;
  expiresAt?: number;
  pollAfterMs?: number;
  data?: JsonValue;
}
```

### ToolResultMessage

```typescript
interface ToolResultMessage<TDetails = any> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  usage?: Usage;
  nestedCalls?: NestedToolCalls;
  isError: boolean;
  timestamp: number;
}
```

`details` is tool-specific. Optional `usage` reports nested model work performed by the tool and contributes to full-session statistics, but it is not part of the main model-call usage. `nestedCalls` records bounded metadata about calls this tool made to other tools:

```typescript
interface NestedToolCalls {
  calls: NestedToolCallRecord[];
  complete: boolean;
}

interface NestedToolCallRecord {
  id: string;
  name: string;
  arguments?: JsonObject;
  argumentsBytes?: number;
  status: "ok" | "error" | "unfinished";
  durationMs?: number;
  error?: string;
}
```

## Coding-agent messages

The coding-agent package extends `AgentMessage` with four roles.

### BashExecutionMessage

Created by direct shell commands, including the RPC [`bash`](rpc-commands.md#bash) command. It is not an LLM tool result.

```typescript
interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp: number;
}
```

Unless `excludeFromContext` is true, nanopi converts this message to user-role text before the next model request.

### CustomMessage

Created when a module sends a custom message.

```typescript
interface CustomMessage<T = unknown> {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: T;
  timestamp: number;
}
```

nanopi converts its content to a user message for model requests. `display` controls terminal rendering; `details` is not sent to the model.

### BranchSummaryMessage

```typescript
interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string | null;
  timestamp: number;
}
```

nanopi creates this context message from a persisted `branch_summary` entry.

### CompactionSummaryMessage

```typescript
interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}
```

nanopi creates this context message from a persisted `compaction` entry.

## Message codecs

Every role above answers three questions for the rest of the host: what it
becomes in LLM context, how many tokens it costs, and how the transcript draws
it. Those used to be hardcoded `switch (message.role)` statements, so a role
that lived outside `messages.ts` could not reach any of them.

A registry answers all three per message kind
([`core/messages/registry.ts`](https://github.com/NekoSekaiMoe/nanopi/blob/main/packages/coding-agent/src/core/messages/registry.ts)).
A module registers through `registerMessageType()`, which is the same call the
built-in kinds come from:

```typescript
import { registerMessageType } from "@nanopi/pi-coding-agent";

registerMessageType({
  kind: "buildResult",
  toLlm: (message) => [
    {
      role: "user",
      content: [{ type: "text", text: `Build finished: ${message.summary}` }],
      timestamp: message.timestamp,
    },
  ],
  estimateTokens: (message) => Math.ceil(message.summary.length / 4),
});
```

| Field | Effect |
|---|---|
| `kind` | the message `role` this codec owns; registering the same kind again replaces it |
| `customType` | with `kind: "custom"`, narrows one custom type instead of the whole role |
| `toLlm(message)` | the request form; returning `[]` keeps the message out of the request |
| `estimateTokens(message)` | token estimate; absent counts as 0 |
| `renderRun(message, options)` | draws the message in the transcript; absent falls back to `[kind]` |

`convertToLlm()`, `estimateTokens()`
([`core/compaction/compaction.ts`](https://github.com/NekoSekaiMoe/nanopi/blob/main/packages/coding-agent/src/core/compaction/compaction.ts)),
and the interactive transcript all read the session's table. A kind nobody
registered is dropped from the request: guessing a projection would put module
payloads in front of the model without anyone deciding they belong there.

The four provider roles (`system`, `user`, `assistant`, `toolResult`) pass
through untouched — the provider layer is what understands them, and a module
must not be able to re-project the conversation the model already saw.

The app's own kinds (`bashExecution`, `branchSummary`, `compactionSummary`,
`custom`) are registered by
[`core/messages/builtin-codecs.ts`](https://github.com/NekoSekaiMoe/nanopi/blob/main/packages/coding-agent/src/core/messages/builtin-codecs.ts),
so the behavior you read above is one codec per kind, not a special case. A
module can replace a built-in kind's projection for its session, but the kind
itself cannot be unregistered: the app writes those messages itself.

The declaration merging above is still how a role reaches TypeScript; the codec
is how it reaches the runtime. Registering a codec without the merge compiles
and runs, but every `switch (message.role)` in your own code loses exhaustiveness.

## AgentMessage union

In the coding agent, the union is equivalent to:

```typescript
type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;
```

At the lower-level agent package, `AgentMessage` is `Message | CustomAgentMessages[keyof CustomAgentMessages]`. Applications can add roles through TypeScript declaration merging, so consumers should tolerate unknown custom roles when they accept messages from an augmented host.

# Agent Note: Message types become a runtime codec registry

Status: implemented

## Problem

`AgentMessage` is a compile-time union: `Message | CustomAgentMessages[keyof CustomAgentMessages]`
(`packages/agent/src/types.ts`). The only way to add a message type was declaration merging,
which a module cannot do at runtime and a downloaded module cannot do at all.

That left the app's own message kinds — `bashExecution`, `custom`, `branchSummary`,
`compactionSummary` — scattered as hard-coded `switch (message.role)` branches in every
consumer: `convertToLlm`, the interactive transcript, compaction's token estimator, the cut
point search, the markdown/HTML exporters, session projection. Adding a kind meant editing all
of them, and no consumer agreed on what an unknown kind meant: `convertToLlm` dropped it,
compaction priced it at 0 tokens while the provider still paid for it.

The prototype patching in `extras/pi-ui` was the symptom, not the cause. A module could not
say "this is how my message type reaches the model", so it patched the renderers instead.

## Decision

One registry per session maps a message kind to a `MessageTypeCodec`:

```ts
interface MessageTypeCodec<T> {
	kind: string;
	toLlm(message: T): Message[];            // projection into the LLM context
	estimateTokens?(message: T): number;     // compaction budget
	renderRun?(message: T, options): Component | undefined; // interactive transcript
}
```

`MessageTypeRegistry` (`packages/coding-agent/src/core/messages/registry.ts`) holds two layers:
`kinds` keyed by the message `role`, and `customTypes` keyed by a `custom` message's
`customType`, because every module-owned message shares the role `custom`.

Consumers dispatch through the table instead of matching `role`:

- `convertToLlm(messages, codecs)` projects through the codec for each kind.
- `estimateTokens(message, codecs)` / `estimateContextTokens` / `estimateProjectedContextTokens`
  / `findCutPoint` / `prepareCompaction` take the table as an optional argument.
- `InteractiveMode.addMessageToChat` asks the codec for a `renderRun` component before falling
  back to its hand-written rendering.
- `ModuleRegistry.messageCodecs` is the flat table; `AgentSession.messageTypes` exposes it, and
  `createAgentSession`'s `convertToLlm` wrapper passes it to the shared helper.

`loadModules` builds one registry for the whole load set and returns it on `LoadModulesResult`,
so a kind registered by one module is understood by every consumer of the session rather than
only by its owner.

Modules register through two `ModuleApi` methods: `registerMessageType(options)` (projection +
estimate + drawing, returning an `isRegistered`/`unregister` handle) and
`registerMessageRunRenderer(kind, renderer)` (drawing only, for a kind whose projection the app
already defines).

Three rules hold the design together:

- **Provider roles pass through `convertToLlm` untouched.** `system`, `user`, `assistant`,
  `toolResult` are the provider layer's vocabulary; a module must not be able to re-project the
  conversation the model already saw.
- **An unregistered kind stays out of the LLM context.** Guessing a projection would put module
  payloads in front of the model without anyone deciding they belong there, which is exactly the
  silent-context-growth failure the old `0 tokens` estimate already caused.
- **Built-in kinds cannot be unregistered.** The app writes those messages itself; only
  module-registered kinds can be dropped.

## Alternatives considered

**Keep declaration merging and ship a `.d.ts` per module.** The union is compiled in; a module
loaded at runtime cannot extend it. Typing would also not answer the real question — *how* the
message reaches the model — so every consumer still needs a branch.

**Two fields on the message instead of a registry (`llmText`, `excludeFromContext`).** Cheap for
`custom`, but it makes the message carry presentation and projection data, and a message read
back from a session file would still need a per-kind codec to be understood. Compaction would
still have to guess a size.

**Dispatch on a `codec` property attached to each message object.** The message becomes
non-serializable, and session files are JSON.

**Register the codec on the module rather than on the session.** Then `convertToLlm` — a free
function called from the SDK, compaction, and the harness — has no way to find it.

## Consequences

- `pi-ui` can delete its `BashExecutionComponent.prototype.render`,
  `CompactionSummaryMessageComponent`, `BranchSummaryMessageComponent` patches and call
  `registerMessageRunRenderer("bashExecution", ...)` instead.
- Compaction now prices a registered kind by its own codec, so a module can no longer add
  context for free. `custom` messages moved from a hard-coded `case` to the codec registered for
  the type, so `findCutPoint(entries, ..., codecs)` and `prepareCompaction(entries, settings,
  codecs)` grew an optional argument. Callers without a session still get the built-in table.
- The token estimate for a kind is now its codec's `estimateTokens`; a codec that omits it is
  priced at 0.
- Scope stops short of the rest of the audit. `sessionEntryToContextMessages`, the markdown and
  HTML exporters, and `tree-selector` still match `role` by hand; they need a per-kind codec for
  persistence and export before a module-owned kind survives a reload or an export.
- `LoadModulesResult` gained a required `messageTypes` field, so every hand-written
  `ResourceLoader` stub in tests and examples now builds a `MessageTypeRegistry`.

## Testing

`test/message-type-registry.test.ts` covers projection of a registered kind, dropping an
unregistered one, per-kind sizing, built-in kinds surviving registration, and narrowing one
`custom` type without touching the others. `test/compaction.test.ts` and
`test/session-context-edit.test.ts` pass the session table explicitly, which is the evidence that
`custom` sizing now comes from the codec rather than from the estimator.

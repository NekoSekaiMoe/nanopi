# Agent Note: Split ModuleApi into surfaces and register message roles as codecs

Status: implemented

## Problem

Two registries in `packages/coding-agent` were enumerations that a module could
not reach, and both had already grown a second copy.

`ModuleApi` (`src/core/modules/types.ts`, 43 members) was handed to every
factory whole. A module that registers one slash command received
`registerProvider`, `registerVirtualModel`, `setThinkingLevel`, and the rest,
so nothing said which part of the surface it had been written against. During
migration the built-in modules were narrowed by hand and handed their `pi` to
helpers typed against the full `ModuleApi`; the compiler could not tell which
of those helpers were asking for more than their caller had reason to use.

Message roles were three `switch (message.role)` statements, one each in
`convertToLlm` (`src/core/messages.ts`), `estimateTokens` and the compaction
cut points (`src/core/compaction/compaction.ts`). A role registered through
declaration merging in `CustomAgentMessages` appeared in the type system and
nowhere else: `convertToLlm` hit its `never` check, `estimateTokens` returned
0, and compaction treated the message as un-cuttable and not a turn start. To
add a role, or to change what one does, you had to find all three switches.

## Decision

### 1. ModuleApi is a composition of eight surfaces

`ModuleApi` stays the full contract and becomes an intersection:

```typescript
export interface ModuleApi
	extends ModuleEventsSurface, ModuleToolsSurface, ModuleCommandsSurface,
		ModuleRenderingSurface, ModuleActionsSurface, ModuleSessionSurface,
		ModuleModelSurface, ModuleProvidersSurface {}
```

The boundaries are the section comments the file already had. Every surface
also carries `events: EventBus`, through a shared non-exported `ModuleEvents`
base, because cross-module messaging is orthogonal to what a module otherwise
does.

`SessionModule<TSurface>` and `ModuleFactory<TSurface>` take the surfaces a
module declares, defaulting to `ModuleApi`:

```typescript
export default {
	name: "standup-notes",
	factory: (nanopi) => { nanopi.registerCommand("standup", { ... }); },
} satisfies SessionModule<ModuleCommandsSurface>;
```

The type parameter narrows the factory parameter only. The host still calls
`factory(api)` with the full object, and `loadModules` is unchanged. A
surface-composed type is a *view*, not a smaller object: it is assignable to a
`ModuleApi` parameter in neither direction, so passing `pi` to a helper typed
wider than the module's declaration is an error. That is the behavior we want -
widen the module, not the helper.

Built-in modules and extras declare what they use. The declarations are
documentation first and a compiler check second; the check is what caught that
`pi-smart-flow`'s `registerDelegationNudge` reads `getActiveTools`, and that
`pi-fake-codex`'s hook failure path calls `sendUserMessage`.

### 2. Message kinds register a codec

> Superseded in part by
> [message type codec registry](2026-11-04-message-type-codec-registry.md), which
> landed first. `registerMessageCodec()` described below was replaced by the
> per-session `MessageTypeRegistry` + `registerMessageType()` before this branch
> merged; what survived is the surface split above and the token estimate reading
> the registry instead of counting a registered kind as 0.

```typescript
export interface MessageCodec<TMessage extends AgentMessage = AgentMessage> {
	readonly role: string;
	include?(message: TMessage): boolean;
	toLlm?(message: TMessage): Message | undefined;
	estimateTokens?(message: TMessage): number;
	isCutPoint?(message: TMessage): boolean;
	isTurnStart?(message: TMessage): boolean;
}
```

`registerMessageCodec()` / `unregisterMessageCodec()` maintain a
`Map<string, MessageCodec>`. `convertToLlm()`, `estimateTokens()` and
`isCutPointMessage()` / `isTurnStartMessage()` read it. The four coding-agent
roles register through the same call; there is no bootstrap special case.

Lookups miss on `system`, `user`, `assistant`, and `toolResult`. Each call site
supplies its own fallback for those, because they are the provider-facing
messages and their handling lives where the provider types are: `convertToLlm`
passes them through, `estimateTokens` keeps its `assistant` block walk, and
compaction keeps `role !== "toolResult"` / `role === "user"`. A role with no
codec at all therefore degrades exactly as it did before: passed through,
estimated at 0, uncuttable.

The core fallback is a `switch` over the four roles, not `role !== "toolResult"`.
The shorter form looks equivalent and is not: `system` messages are replayed
into context by `sessionEntryToContextMessages`, so treating them as cut points
let a compaction cut land on a system message, which made the cut a split turn
and produced a "Turn Context (split turn)" prefix that the previous code never
wrote. `agent-session-compaction-model-overrides.test.ts` caught it, and
`message-codec.test.ts` now pins `system` as neither a cut point nor a turn
start.

Defaults are deliberately asymmetric. `estimateTokens` falls back to
`chars/4` over whatever `content`, `summary`, `command`, and `output` the
message carries, so a role that names no estimator still costs something.
`isCutPoint` and `isTurnStart` default to `false`, so a new role cannot change
where compaction cuts a session by being registered.

## Alternatives considered

- **Keep `ModuleApi` whole and split only the types (surfaces as documentation
  with no factory parameter)**: it is the no-risk option and we took half of it -
  `ModuleApi` keeps all 43 members. But an unchecked surface records intent
  that nothing verifies, and the migration had already shown the cost of that:
  helpers typed against the full API while callers used five members.
- **Make the surfaces capability checks at load time** (pass a proxy that
  throws when an undeclared member is touched): rejected. It turns a
  compile-time authoring promise into a runtime failure in someone's session,
  doubles the object surface, and breaks legitimate narrowing (a module handing
  `pi` to a shared helper). The declaration is about what the module was
  *written* for, not what the host is willing to *give*.
- **Intersect the declared surface with `ModuleApi` in `ModuleFactory`**
  (`nanopi: TSurface & ModuleApi`): it makes narrower factories assignable in
  both directions but erases the entire point - the compiler would accept any
  member again. Rejected after the built-in migration, when a helper still
  narrow on paper but passing `ModuleApi` onward typechecked.
- **Split each role's behavior into three registries (converter, estimator,
  cut-point) instead of one codec per role**: it lets a module override cost
  without touching conversion. Rejected: three lookups per message on the hot
  prompt path, three places to forget, and the answers belong together - a
  message whose `toLlm` drops it should not also count against the window by
  default.
- **Keep the three switches and add a `default:` case that consults the
  registry only for unknown roles**: smaller diff, and the four built-ins keep
  their fast path. Rejected because it leaves two answers per role: a module
  that registers a codec for `custom` would find the built-in switch wins.
  Overriding a built-in role is a supported use.
- **Route `estimateTokens` for core roles through the registry too** (register
  codecs for `assistant` etc. as well): it would make the table total. Rejected
  because those estimators read provider types (`AssistantMessage`'s block
  union) that belong next to the provider contract, and moving them into
  `core/messages.ts` would put an LLM-message dependency in the coding-agent
  message definitions.

## Merge resolution

This branch was rebased onto a `main` that already carried
[the message type codec registry](2026-11-04-message-type-codec-registry.md). Three
files conflicted and the per-role `registerMessageCodec` table was dropped rather
than kept beside the registry:

- `src/core/messages.ts`: one projection entry point. `convertToLlm(messages, codecs?)`
  resolves through `resolveMessageCodec`, the four provider roles pass through, and a
  kind with no codec is dropped. The `registerMessageCodec` map is gone; the registry
  owns registration.
- `src/core/compaction/compaction.ts`: `estimateTokens(message, codecs?)` consults the
  session table first, which is the part of this note worth keeping — a module's kind is
  priced by its own estimator, and a codec can re-measure a built-in role. Cut points
  stay a `switch` over the known kinds and are now exported so they can be tested. The
  registry has no `isCutPoint`, so registering a kind cannot move a cut.
- `src/core/modules/types.ts`: `registerMessageType` and `registerMessageRunRenderer`
  live on `ModuleRenderingSurface`, and the surface composition is unchanged.

## Consequences

- `estimateTokens()` prices a kind through the session's codec instead of 0. A
  session that contains a kind a module registered now counts that message against
  the context window; a kind nobody registered still counts as 0. This is a behavior
  change, and the intended one: 0 meant compaction ignored content the model was
  paying for.
- Cut points for the four built-in roles are identical to the old switches
  (`bashExecution`, `custom`, `branchSummary`, `compactionSummary`: cut, turn
  start). `convertToLlm` output was diffed message-by-message against the old
  implementation during the port; the JSONL is byte-identical.
- Compaction's `estimateTextAndImageContentChars`,
  `ESTIMATED_IMAGE_CHARS` and the `assistant` block walk stay in
  `compaction.ts`. `core/messages.ts` duplicates `4800` as
  `ESTIMATED_IMAGE_CHARS` for the default estimator; the two numbers must move
  together, and there is no shared constant to hang it on without an import
  cycle.
- A module's role still needs declaration merging against
  `CustomAgentMessages` to reach TypeScript. The codec is the runtime half
  only; registering one without the merge compiles, runs, and takes away the
  exhaustiveness that would have warned you.
- `isCutPointMessage` and `isTurnStartMessage` are exported from `compaction.ts` so
  the cut rules are testable directly.
- Every `module/<name>` factory has an explicit surface list. That list is now
  part of the diff when a module grows a capability; a reviewer sees
  `registerProvider` arrive in a type position before it arrives in a body.

## Testing

- `packages/coding-agent/test/message-codec.test.ts` (issue #453) covers: an unknown role converting
  through its codec, `include()` dropping a message, a codec-less role passing
  through, estimates and cut points reading the codec, replacement on
  re-registration, and override + `unregisterMessageCodec` restoring the
  pass-through.
- `packages/coding-agent/test/module-surface-types.test.ts` pins the negative space with
  `@ts-expect-error`: `ModuleCommandsSurface` has no `registerProvider` or
  `registerTool`, a surface intersection has no `registerCommand`, and a single
  surface is not a `ModuleApi`.
- `pnpm run check` (biome, pinned/runtime deps, ts imports, entry graphs,
  typecheck, browser smoke) passes; the entry-graph budgets for `./modules`
  (110 files) and `./ui` (170) are unchanged.
- Compaction, custom-message, block-images, and the agent-session compaction
  suites pass unchanged.

## Related

Grows out of
[remove the plugin system in favor of programmatic modules](2026-10-13-remove-plugin-system-programmatic-modules.md),
whose `ModuleApi` was already the curated 43-member surface and whose migration
left the helper-typing gap this note closes. The narrow `./modules` subpath it
relies on landed earlier in the same release line.

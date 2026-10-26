# Agent Note: one Gemini stream, two clients

Status: implemented

## Problem

`api/google-generative-ai.ts` and `api/google-vertex.ts` were 471 and 554 lines
of near-identical code. Same `toolCallCounter`, same `for await` over the SDK
stream (block open/close bookkeeping, tool-call id deduplication, usage and cost
mapping, abort and stop-reason handling), same `buildParams`, same `streamSimple`
budget ladder. The real difference is what sits in front of the stream:
Gemini takes an API key, Vertex takes an API key *or* project + location + ADC,
and each adapter names itself in the three errors only it can raise.

Two copies of a 250-line loop means every behavior fix has to be written twice
and reviewed twice, and the two had already drifted: `google-generative-ai`
carried a `2.5-flash-lite` thinking-budget table Vertex lacked, and Vertex had
`@google/genai` typing commentary the other did not.

This is a de-duplication, not a step toward running Claude on Vertex. Claude on
Vertex is a different wire format (Anthropic Messages body on
`:streamRawPredict`, IAM auth) and would be a new adapter, not a branch here.

## Decision

**`api/google-shared-stream.ts` owns the loop; each adapter keeps its client.**

`createGoogleStream(api, adapter)` binds the loop to one adapter and returns
`stream`/`streamSimple`:

- `adapter.createClient(model, context, options)` is the only part an adapter
  writes itself.
- `adapter.assertCredentials(model, options)` runs as `stream()` is called, so
  Gemini still throws `No API key for provider: <provider>` synchronously
  (`StreamFunction`'s contract) while Vertex still defers its
  project/location errors into the stream's error event. The credentials check
  cannot move into `createClient`: the loop compares a custom `fetch` before
  building the client, and `fetch-option.test.ts` pins that order.
- The returned functions are typed `GoogleStreamFunction<api, options>`, a
  `StreamFunction` alias that keeps `Model<"google-vertex">` and
  `GoogleVertexOptions` (`project`, `location`) narrowed. Plain
  `StreamFunction<api, GoogleSharedStreamOptions>` would accept a
  `Model<"google-generative-ai">` from a Vertex call site.

`GoogleSharedStreamOptions` declares `thinkingBudgets` even though the field
belongs to `SimpleStreamOptions`: the object `streamSimple` spreads into `stream`
is typed by the shared options, and dropping the field there would silently drop
user budgets.

The adapter files are now client construction and nothing else (54 and 141
lines).

## Alternatives considered

**One generic `stream(api, model, ...)` export with a runtime `api` argument.**
Keeps a single file but every call site, `ProviderStreams` registration, and the
lazy `api/*.lazy.ts` wrappers would have to pass the discriminator, and the
`Model<api>` narrowing is lost at exactly the places that enforce it.

**An abstract class both adapters extend.** The adapters have no state to share
and only two methods; a class pays for inheritance machinery (and this repo
prefers factory functions) without buying anything a closure does not.

**Leave the duplication and fix only the differences** (add the Vertex budget
table, copy the typing comments). Cheapest today, but it keeps the loop doubled
and the next behavior fix lands twice again.

**Declare `project`/`location` on the shared options** to avoid the
`GoogleStreamFunction` alias. Makes Vertex-only keys visible to the Gemini
adapter's callers and loses the error on a typo.

## Consequences

- One loop to fix. The `2.5-flash-lite` budget table is gone: no model id could
  reach it (`gemini-2.5-flash-lite` matches the `2.5-flash` branch first, at the
  same numbers up to `medium` and 24576 at `high`, which was the flash-lite
  value too). Vertex now uses the Gemini 2.5 tables; the only behavioral change
  is that a Vertex `2.5-flash-lite` at `high` gets 24576 instead of `-1`
  (dynamic).
- Adapter-specific error text moved into `adapter.adapterName`; the strings are
  unchanged, including `Custom fetch is not supported by the Google Vertex
  adapter`.
- Each adapter file now has a two-line binder and a `createClient`; reading one
  tells you everything that differs from the other.
- The shared module is 483 lines against the 877 the two adapters carried
  together (adapters: 1025 → 195). It is not smaller because the loop's
  body is the same code; what went away is the second copy.
- The loop is only as testable as before: `google-raw-stop-reason.test.ts`,
  `google-vertex-api-key-resolution.test.ts`, `fetch-option.test.ts`, and the
  `google-shared-*` suites still drive it through the adapters and the mocked
  `@google/genai`.

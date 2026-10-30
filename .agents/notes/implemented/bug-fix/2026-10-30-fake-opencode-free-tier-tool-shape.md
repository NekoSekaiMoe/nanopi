# Agent Note: pi-fake-opencode replays the CLI's full request shape, tools included

Status: implemented

## Problem

`pi-fake-opencode` passed Zen's free-tier gate by sending three signals: the 2026-10 capture of the composite `User-Agent` (`opencode/1.19.0 ai-sdk/… runtime/bun/…`), well-formed `ses_`/`msg_` ids, and a system message that started with the 1.19.x title-generator prompt. To fit the third, it stripped `tools` outright.

That cost the whole point of an agent: free models answered as chat models and nanopi's tool loop could not run on them. The module also aged badly — version, ids, and prompt were all captured against one release.

[opencode2api](https://github.com/jasonxu114514/opencode2api) is a Go gateway that replays a live official client's traffic to the same gate. Its captures (`internal/gateway/`, `internal/identity/`, `internal/httpx/`) state what the gate actually validates now, and each item is checkable against those captures instead of another round of black-box probing.

## Decision

The module sends the shape a current official CLI sends, on all three signal groups.

**Identity.** `User-Agent` is the 2.x composite form (`opencode/2.1.1 ai-sdk/provider-utils/<sdk> runtime/bun/<v>`; the SDK version varies per protocol upstream, the gate accepts a range). `x-opencode-request` is one ascending `msg_` id per *user turn*, not per HTTP call: the client mints it when the user sends, and repeats it on the tool steps of that turn. `x-opencode-project` is the 40-hex git root commit, or a random id in that shape outside a repo — the free tier ledges quota per project and egress, so one shared literal is one shared bucket.

**Body** (`payload.ts`).

1. Every system/developer message folds into one leading system message: the official CLI system prompt (with its `<env>` block and skill listing, `gateway-prompt.ts`), a separator, then nanopi's own system prompt verbatim. The gate reads the head of the string; the model reads the tail.
2. nanopi's tools are renamed to opaque `clint_<hash>` wire names and the official tool set is appended in the CLI's order (`gateway-tools.ts`). The gate compares the entire tool list, so a client name or schema of our own cannot travel; the hash name keeps the tool *reachable* so the model can still ask for work.
3. `stream: true`, `max_completion_tokens`, no `tool_choice`.

The turn fingerprint for the request id comes from the previous shaped body of the same session: pi-ai builds headers before the body, so the transform that sees the body is the only place the turn is known, and the header transform reads what it recorded.

Assets are captured text (prompt, skill listing, tool order, tool definitions), not code, so a gate change means replacing them rather than re-deriving anything.

## Alternatives considered

- **Keep stripping tools** (the shipped behavior): rejected — it is what made the module useless for agent work, and the reason it stripped them was a limit of the 1.19.x capture, not of the gate. The gate accepts tools when the list is official; the captures prove it.
- **Send only the official tool definitions and drop the client's** (what a naive reading of "must match" suggests): rejected — the model would then call `shell`, `edit`, or `read` with *opencode's* schemas, which do not match nanopi's tool arguments, and nanopi would receive calls it cannot parse. Renaming under opaque wire names keeps both properties: the upstream list is official, the call carries a name nanopi maps back.
- **Restore the client names in streamed responses**: rejected for now, and worth knowing why. `before_provider_request` only sees the outgoing body; the streaming path (the only path nanopi uses here) would need per-chunk rewriting, which the module API does not expose. As it stands the model calls the official tool names, which is exactly how a real opencode session behaves.
- **Keep the 1.19.x title prompt as the pass key**: rejected — it was a 2026-10 artifact of a gate that accepted "any known official prompt". The current gate wants the CLI prompt; the title prompt is one of its own internal requests, not the shape of a session.
- **Replay the client's TLS/HTTP stack** (what opencode2api does with a uTLS `BunTransport`): rejected — a Node transport passes once the three signals are right (established in the 2026-10 experiments and unchanged), so the stack is not a signal.
- **Hardcode `x-opencode-project: "global"`**: rejected — it reads like a cosmetic label, but the quota bucket is keyed on it; `global` is a bucket every non-opencode client shares.

## Consequences

- Free-tier models can call tools again. They do so through the *official* schemas: `shell` rather than nanopi's `bash`, and so on. That is a real fidelity loss, not a cosmetic one, and it is the price of a list the gate accepts.
- The prompt is now ~8.5 KB of CLI text in front of nanopi's own, on every free request. Cached prefixes absorb most of it, but the first request of a session pays for it, and small models weight the CLI's "answer in fewer than 4 lines" style more heavily than a clean prompt.
- The request id now repeats within a turn. Anything that correlated requests by id (logs, telemetry) sees one id per turn rather than one per call, which is what a real client produces.
- Assets rot independently: the prompt, the tool definitions, and the UA versions each need a recapture when the gate moves. Their files say where they came from.
- `buildProjectId` shells out to `git rev-list --max-parents=0 HEAD` once per working directory, with a 2 s timeout and a random fallback, so an odd repo cannot block a request.

## Verification

- `packages/coding-agent/test/fake-opencode-gateway.test.ts`: UA shape, descending session id (low bits `fff - counter`), one request id per turn and a new one on the next, turn fingerprint stable across tool steps, project id shape and caching, spoof scoping, prompt folding (one system message, separator, session prompt preserved), tool renaming plus the official set in order, field renames, and idempotence on a re-sent body.
- Not verified against the live gateway in this change: no free-tier credential was used, so the gate's acceptance rests on opencode2api's captures and its own probing notes rather than on a request from nanopi.

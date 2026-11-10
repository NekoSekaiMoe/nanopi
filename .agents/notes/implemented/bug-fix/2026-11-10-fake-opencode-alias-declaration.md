# Agent Note: pi-fake-opencode declares the tool a mapped official call comes back as

Status: implemented

## Problem

A shaped free-tier request carries two vendors' tools: nanopi's, under opaque
`clint_<digest>` wire names, and the official CLI's, spelled out because the
gate compares the whole list. The injected CLI prompt names the official tools,
so the model calls `shell` or `read` — and what comes back is not that name.

Zen's proxy resolves an official call to a client tool before returning it, and
the resolver only recognizes another client's vocabulary (`Bash`, `Read`,
`Agent`, …). nanopi's tool ids are lowercase (`bash`, `read`), so nothing
matched, the name passed through unchanged, and the response arrived naming a
tool the shaped request does not declare. nanopi then had a call it could not
route, and the history carried it into the next turn where the model imitated
it — opencode2api fixed the same defect in `87e7983` ("restore official tool
names and drop ghost calls") after Claude Code answered
`No such tool available: shell`.

## Decision

`payload.ts` mirrors opencode2api's `OfficialToolCandidates` and acts on both
sides of the mapping.

**Declare the redirect target.** `OFFICIAL_TOOL_CLIENTS` maps an official name
to the client names the upstream resolves it to (`shell`/`bash` → `Bash`,
`read` → `Read`, …). For every official tool whose counterpart this client
declared, `officialTools` emits the official definition a second time under that
counterpart's wire name, right after the plain official entry. The candidate
lists carry the vendor-neutral spelling first and nanopi's own id second, so a
tool declared as `bash` matches and one declared as `Bash` matches too.

**Drop history the request cannot act on.** `dropUnreachableHistory` walks
`tool_calls`, `tool_use` blocks and Responses `function_call` items, rewrites a
name that has a target to that target's wire name, and removes a call naming an
official tool with no target together with its result (`tool_call_id`,
`tool_use_id`, `call_id`). A message left empty by the removal goes too, and a
`tool_choice` pinning a removed name is dropped with it.

Both carry the official schema, so the model fills in the shape it was shown; the
upstream shrinks it to the client tool's own at call time.

## Alternatives considered

- **Declare only the official name and rely on the mapping**: rejected. The
  mapping fires, but its result has to be a declared tool; without the second
  entry the returned `Bash` is as undeclared as the `shell` it replaced.
- **Normalize nanopi's tool ids to the client names the resolver knows**
  (rename `bash` to `Bash` in the tool set): rejected. nanopi's ids are part of
  its tool registry and its prompt; the same effect is available by declaring an
  alias, without renaming a public tool.
- **Drop every official call from history, mapped or not**: too aggressive. A
  mapped call is one the client tool just served, and erasing it makes the next
  turn redo work it can see in its own transcript.
- **Leave the history alone and let the upstream reject it**: rejected. The
  upstream does not reject it, which is exactly the ghost-call problem: the
  entry survives and later turns imitate a name nothing declares.
- **Restore the client name on the response path** (what opencode2api does with
  `ToolRenames` + `RenameStreamReader`): still out of reach. The module API has
  no response hook, and the streaming path is the only one this module uses, so
  the declaration has to be right before the request leaves.

## Consequences

- An official call reaches the nanopi tool the upstream redirected it to, so a
  free-tier model can drive a session's shell, read, edit, and search instead of
  answering around a name it cannot use.
- The arguments still come from the official schema, so a schema that differs
  from nanopi's tool can produce a call its handler rejects. That is the cost of
  a tool list the gate accepts, and it is smaller than a call that never arrives.
- A history entry naming an official tool with no counterpart is erased. A
  cross-vendor transcript loses that step; the alternative was keeping a name
  the request cannot declare.
- The candidate table is a copied constant. When opencode2api's
  `OfficialToolCandidates` changes, `OFFICIAL_TOOL_CLIENTS` has to follow.

## Verification

`packages/coding-agent/test/fake-opencode-gateway.test.ts`: the aliased official
entries appear in the CLI's order with the second declaration adjacent, a
declared `bash` and `read` are each declared twice, a `tool_choice` pinned to a
declared tool is rewritten onto its wire name, and a history carrying `shell`
(mapped) and `execute` (not mapped) keeps the first and drops the second with
its result. Not verified against the live gateway: no free-tier credential was
used, so the mapping is checked against opencode2api's behaviour rather than a
live response.

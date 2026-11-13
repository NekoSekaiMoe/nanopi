# Agent Note: The webui is one conversation in a browser, not a multi-agent chat hub

Status: implemented

## Problem

#704 compares nanopi's webui against pigo's `serve` and finds them shaped
differently: pigo runs a WebSocket hub over *rooms* of declarative Bot
personae, with `@`-routing and a task DAG merged through per-task git
worktrees; nanopi runs one HTTP+SSE conversation over one `AgentSession`.
The comparison is accurate, and the missing half — no personae, no rooms,
no task graph, no editor workbench — reads as unfinished work every time
somebody looks at it from that angle. That misreading has a cost: it invites
"just add the missing piece" patches that each look small and together change
what the product is.

The question #704 raises is therefore not "which endpoints are undocumented"
but "is this difference on purpose", because the answer decides whether the
gap gets documented or filled.

## Decision

The difference is deliberate. `packages/webui` is one user's session in a
browser, and `packages/webui/README.md` now says so in a `## Shape` section
next to the route list, so the boundary is readable without reading this note.

Concretely, the shape is:

- **One conversation on screen.** The server does run turns on several sessions
  concurrently (the turn lock is per session, `/chat` takes `session_id`), and
  `/chat/active` exists so a second tab can see who holds a turn. There is no
  room, no membership, no `@`-routing, and no fan-out to other clients.
- **One HTTP request per turn answered as SSE**, plain JSON for everything
  else. `/terminal` is a WebSocket, but it is a scratch shell, not a second
  chat channel.
- **A plan, not a task graph.** `plan-card` renders what the agent wrote
  through `todo`; it has no dependencies, no ownership, and nothing merges
  worktrees behind it.
- **No personae.** The model is picked per session; instructions come from
  `AGENTS.md` and the resource loader, not from declarative bot files.

The corollary is the part worth enforcing: adding rooms, personae, `@`-routing,
or a worktree-merging task DAG is a product decision, not a patch. It changes
what `nanopi webui` is for, so it needs #704's discussion reopened rather than a
PR that adds an endpoint.

## Why not the other shell

The gap is real — it is only a gap if the target is pigo. The two programs
answer different questions. pigo answers "how do I run a team of agents in a
room and hand work between them"; nanopi answers "how do I drive one agent on
my repository from a browser instead of a terminal". The 5.6k-line CLI already
owns the second question; the webui is that CLI's remote surface. A hub needs a
room model, per-bot credentials and budgets, inter-bot handoff, conflict
resolution between bots editing the same files, and an authorization story for
who may join — none of which exist anywhere in this repository, and none of
which the CLI would use.

The visual layer makes the boundary easy to miss, because the three-column
layout (sidebar | chat | panels) is *also* what a chat app looks like. But the
right column here is a file viewer and a terminal, not a member roster.

## Alternatives considered

### Add a WebSocket transport to replace SSE

Its strongest case: SSE is one-way, so stopping a turn, answering a permission
prompt, and following another tab's progress each need their own request. A
socket would collapse those into one channel and make a shared live view
possible.

Rejected: the request/response split is what makes the server stateless about
clients. `/chat/stop`, `/chat/permission`, and `/chat/user-input` are matched by
`request_id` rather than by connection identity, so a reloaded tab, a second
tab, and a background job reporting in all work without a reconnect protocol.
SSE also survives proxies that break idle WebSockets, which matters because the
daemon binds loopback but is commonly reached through a tunnel. The `?sync=1`
socket transport was deliberately deleted in #595 because it had no caller;
reintroducing one now would need a shared hub on the server side, which is the
design this note declines.

### Reintroduce an editor workbench (Monaco, tabs, PDF viewer)

Its strongest case: the current `file-viewer` is read-only, so a user who wants
to change one line has to go back to the terminal. pigo's Monaco workbench does
that in the browser.

Rejected: editing in the browser duplicates `edit`/`write` — the agent's own
tools — with a second, differently-behaved writer over the same files, and it
needs the diff, format-on-save, and undo semantics that only the CLI side has
today. `POST /fs/write` exists, so a small edit box is a much smaller change
than a workbench; the workbench is not on the table before somebody needs it.

### Record "no multi-bot" as a rejected feature note instead of documenting the shape

Its strongest case: `.agents/notes/rejected/` already holds several "we do not
pick this up" records, and the convention there is a frozen proposal with the
reason in `Status:`.

Rejected as the *primary* record: a rejected proposal documents a proposal that
was considered and dropped, and this was never proposed — the shell was built
this way from the start ([port atomcode's
webui](./2026-10-11-port-atomcode-webui.md)). What a reader needs is the shape
itself, stated as a current fact, which is why the decision lives here and the
one-paragraph version lives in the README. This note is where the "would a
socket/Monaco/hub be better" questions are answered, so the next reader does not
have to redo that comparison.

## Consequences

- The `## Shape` section in `packages/webui/README.md` is the contract a
  contributor reads before adding UI; a PR that crosses one of its bullets
  should say why instead of looking like ordinary work.
- The route list in the same README was reconciled with
  `webui-server.ts` while writing this: the earlier version listed roughly half
  the endpoints (no `/extra/*`, no provider accounts, no `/chat/active`, no
  `/terminal`) and described `/projects/:hash/sessions` as a stale leftover
  when both the flat and nested forms are served. It now matches the code, so
  the next drift is a real defect rather than an ambiguity.
- `plan-card` keeps its name and its meaning: it displays a plan. If a task DAG
  ever arrives it needs its own surface, not a repurposed plan card.
- The cost is real: nanopi webui will keep being compared unfavourably to pigo
  `serve` on collaboration features, and this note is what that comparison
  gets pointed at.

## Testing

Documentation only — no behaviour changed. `pnpm run check` and the agent-note
verifiers cover the mechanics; the route list was checked route by route
against `packages/coding-agent/src/modes/webui/webui-server.ts`.

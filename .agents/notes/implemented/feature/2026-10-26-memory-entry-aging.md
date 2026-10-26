# Agent Note: Age memory entries, and let the list shrink

Status: implemented

## Problem

`pi-memory` was built to refuse: an entry has to be a rule that stays true, be
new, and be confirmed by the user. What it had no answer for is an entry that
was true the day it was written and is not true today.

Issue #214 asks what happens as `AGENTS.md` grows, and the honest answer was
"it only grows". The gates cap each session at three candidates and reject
near-duplicates, so growth is slow, but nothing ever removes a line. A file
nobody prunes becomes a list of rules that were each true once, every one of
them still read into the system prompt of every session. The expensive failure
is not the token count; it is an agent following a rule that stopped applying
six months ago and having no way to tell which line it is.

Two properties of the existing design made this hard:

- A `/remember` that re-confirms an entry is refused as a duplicate, so
  acceptance does not produce a signal. Only a *new* entry moved the file.
- Nothing recorded when an entry was confirmed. `git blame` dates the line, not
  the rule, and a rebase or a squash rewrites every date to today.

## Decision

Each bullet `pi-memory` writes ends with `(kept YYYY-MM-DD)`, and every write
restamps the other bullets in the section it touches.

The stamp rides inside the line rather than in a sidecar file or a per-line
annotation because it survives the operations the file goes through: a rebase,
a squash, a hand edit that deletes a neighbouring bullet, and a reader that is
not `pi-memory` — which sees a bullet ending in a parenthesized date and can
still read it as a sentence. A bullet without a stamp is an old bullet, so the
pre-stamp file needs no migration step.

The restamp is what makes the stamp mean "last confirmed" instead of "last
edited". A user who opens `/remember`, sees three candidates and accepts one
because it is still true — or declines one because it never was — has just
confirmed the section by reading it. `touchSections` writes today's date onto
every bullet in the section that the write landed in. Without it, an entry
could only be re-confirmed by being repeated, and repetition is exactly what
`isDuplicate` refuses.

The invariant this creates is the one thing a write must never break: **a
bullet that this write did not touch keeps its meaning but gains an age.** A
line whose text changes silently is worse than a stale line, so the stamp is
stripped before every comparison (`normalize`, `isDuplicate`) and every
rendering (messages, prompts, the exclusion of a candidate that would have said
the same thing). `restamp` removes a trailing stamp — valid or malformed —
before writing the new one, so a re-stamp cannot produce `(kept a) (kept b)`.

Three surfaces act on the age:

- `/remember --list` prints every bullet with its section and its age in days.
  It is the index `/forget` numbers (`/forget 3,7`).
- `/remember --prune` computes candidates and asks for a confirmation before
  deleting. Deleting a section's last bullet deletes the heading with it: an
  empty heading is a reminder that memory was there, which costs a line and
  says nothing.
- The extraction prompt gains a `"stale"` list. Before asking for new entries,
  the model is shown the entries that look out of date and asked which ones
  this session proved wrong. That is the only reader that can tell "the file
  moved" from "the rule changed", and it is cheaper than a rule engine: the
  session that makes an entry obsolete is the session that should delete it,
  and it is right there.

Staleness has two grades. `missing` is proof: the entry names a path in
backticks and `existsSync` says it is gone. `aged` is a guess: the last
confirmation was 180 days ago. `missing` outranks `aged` in the reason, and
neither deletes anything without a confirmation — the point is to surface the
question, not to answer it.

An unstamped bullet is dated by `git blame --porcelain` on its own line, with
the author time (not the committer time, which a rebase changes). A repository
without git, without history, or without the file tracked reports no age, which
is a different answer from "fresh" and is why the fallback returns an empty map
instead of throwing.

Growth past `SOFT_LIMIT` (80) is reported, not refused: `/remember` says how to
prune rather than blocking the write. A hard limit would make the tool fail at
the moment the user is trying to record something, and the entry that hits the
limit is often the one that replaces five others.

## Alternatives considered

- **A sidecar file (`AGENTS.memory.json`) mapping bullet text to a date.** The
  mapping goes stale the moment a human edits the bullet, and a memory feature
  whose state is a second file that silently disagrees with the first is worse
  than no dates. It also breaks the property that made `pi-memory` cheap to add:
  no new format and no extra loader.
- **Comment annotation above each bullet (`<!-- kept 2026-10-26 -->`).** The
  raw file stays clean for readers, but the annotation is a line that gets
  deleted by anyone who tidies the file, and `listEntries` would have to be
  taught to collect lines it does not own as part of an entry. An annotation
  that can be lost silently can be lost silently.
- **Per-bullet stamps only, no restamp.** Simple, and it still tells age. But
  then the only way to lower an entry's age is to delete and re-add it, so the
  ages measure "when was this last edited", which is what `git blame` already
  said. The restamp is the whole reason the number is worth showing.
- **Hard cap with rejection.** Cheaper to implement than the soft limit plus
  `/forget`, and it bounds the file by construction. Rejected because it puts
  the failure at the worst moment and because a rejection with no deletion path
  leaves the user editing markdown by hand — which is the status quo this issue
  is about.
- **Automatic deletion of `missing` entries.** Tempting, since a missing path
  looks like proof. It is not: a rule about a file can stay correct after the
  file moves, and the right repair is often to update the path rather than to
  lose the rule. Every delete goes through a confirmation.
- **`mtime` of the file as the age of every entry.** One syscall and no git.
  It answers "when was anything in this file written", so one write resets the
  age of a bullet nobody has read in a year — the same false-fresh signal the
  restamp is designed to express, but without the per-section scoping. Kept only
  as what `git blame` degrades to in a file git has never seen.

## Consequences

The file now carries information it did not before: each bullet ends with a
date, and `AGENTS.md` diffs will show re-stamped neighbours next to a new entry.
That is the visible cost of the restamp, and it is the reason the age is
trustworthy.

An entry written before this change is either stamped the first time anything
else in its section is written, or dated by `git blame`, so the feature works on
an existing file without a migration command.

`STALE_DAYS` (180) and `SOFT_LIMIT` (80) are module constants, not settings:
they are guesses, and a guess that is configurable invites tuning instead of
pruning. `buildExtractionPrompt` gained an optional `stale` list, so the
extraction request is unchanged for callers that do not have one.

Tests: `test/suite/memory-store.test.ts` covers stamp round-tripping, the
stamp-stripped comparison, the restamp scoping, deletion and its section
cleanup, `missing` versus `aged`, and `blameDays` against a real temporary git
repository (skipped when git is unavailable). `test/suite/memory-command.test.ts`
covers `/remember --list`, `/forget`, and `/remember --prune` end to end through
the session harness, including the branch where the user confirms nothing.

# Agent Note: the catalog is curated, not everything models.dev lists

Status: implemented

## Problem

Issue #227 asked why the single-file `full` artifact was 12.1 MiB after
`6adcad26b` (#43) was supposed to let any OpenAI-compatible provider work
without a `models.json` entry. The answer was the price of that feature: #43
generated one catalog per models.dev provider that speaks the
OpenAI-compatible protocol, so `providerSets.all` went from 46 ids to 206, and
the model data in the artifact went from 0.9 MiB to 3.33 MiB.

The number that mattered was not 206 but 30: the top thirty catalogs are 70% of
the bytes, and five aggregators (`openrouter`, `nano-gpt`,
`llmgateway-providers`, `edenai`, `kilo`) are 1.04 MiB of it. The tail is the
opposite problem — 24 catalogs carry one or two models each and 16 KiB in
total — so neither a size cutoff nor "keep the big ones" was the right rule.
Working from size alone would have kept `nano-gpt` and dropped `github-copilot`.

The user's rule was simpler and stricter: keep what people have heard of, drop
what they have not, and drop `cerebras`, `baseten` and `together` while we are
at it — those three have hand-written integrations and still read as
"never heard of it" to the person paying the bill for the artifact.

## Decision

**`all` is a curated list of 32 catalogs, and `full` ships it.** A catalog is in
when someone can plausibly type its key on purpose:

- the assistants people reach for first: `openai`, `anthropic`, `google`,
  `xai`, `meta`, `deepseek`, `moonshotai` (+ `-cn`), `zai`/`zhipuai`
  (+ `zai-coding-cn`), the three `qwen-token-plan` ids, `kimi-coding`,
  `xiaomi`, `stepfun`, `stepfun-ai`;
- the subscription plans and aggregators with a real install base:
  `github-copilot`, `openrouter`, `opencode` + `opencode-go`, `vercel-ai-gateway`,
  `ollama-cloud-token-plan`, `antigravity`, `openai-codex`;
- the hosts a large account brings: `amazon-bedrock`, `google-vertex`, `azure`,
  `fireworks`, `groq`, `huggingface`.

Everything else models.dev lists — including `cerebras`, `baseten`, `together`,
`modal`, `nvidia`, `sensenova`, `typesafe`, both Cloudflare providers, the
`siliconflow` and `alibaba-token-plan` regional keys, and the long tail of
resellers — is a `models.json` entry away and ships no data.

**`opencode` and `opencode-go` moved back into the curated list.** An earlier
revision of this note shipped them no data, on the reading that "Zen" was a
reseller. The install base says otherwise: `opencode` is the default vendor
people reach for after the first-party assistants, its catalog carries the free
tier (`*-free` ids with the literal `public` key), and the client fingerprint in
`packages/coding-agent/src/extras/pi-fake-opencode` only unlocks that tier for a
model whose provider is `opencode`/`opencode-go` or whose base URL is
`opencode.ai`. Leaving them out forced a hand-written `models.json` for the one
vendor the built-in integration exists to serve. The two catalogs are 68 KiB
of model data (48 KiB + 20 KiB), which is the price of the decision;
`openrouter` was never dropped.

**The provider modules stay compiled in.** The trim is a catalog decision, not
a feature removal: `builtinProviders()` still registers all 48, a build that
ships a subset swaps in the generated stand-ins (`providerStubs`), and the
runtime filter that already existed for `base` (`isProviderIncluded`) does the
rest. A dropped vendor therefore keeps its exact request shape — `groq` stays
`groq`, `cerebras` keeps its base URL — as a `models.json` entry, which is what
keeps the removal honest. Dropping the modules would have saved another ~0.4
MiB and deleted 18 integrated providers' worth of behavior at the same time.

**`full` and `presets` are the same list.** `full` now names `presets` instead
of `all`, and the two sets carry identical ids. `all` keeps its role as the
record the generator writes and as the set `validateFlavorProviders` checks
reachability against. Keeping them equal is the point: a second list that
drifts is what this note's predecessor
([provider sets](../process/2026-10-19-provider-set-build-component.md)) had to
patch once already.

**`kiro` is added as a first-class provider**, because a subscription nobody can
sign into is not a provider: `/login kiro` runs the AWS builder-id device flow
(client registration, device authorization, then a Kiro API key), and the
client registration is stored on the credential so a refresh needs no second
sign-in. Its catalog is hand-written (models.dev does not know Kiro), the same
way `antigravity`'s is. `KIRO_API_KEY` covers scripted use.

**The model-data manifest carries no per-file hashes.** It records the schema
version, the generation timestamp and the structure hash; the catalog files are
validated against the structure the aggregator declares. The old `files` table
was 17 KiB of path/hash pairs bundled into the single-file artifact, where
nothing reads it — the only reader was the build's own validation of a staged
directory it had just written.

## Alternatives considered

- **Keep every catalog and load them from disk on first use (sidecar).** The
  larger half of the 3.33 MiB, and it keeps "every provider works" true. It
  costs the single-file artifact its single file, needs `--list-models` to
  become async or to pre-read 200 files at startup (measured 700-770ms today),
  and it packages 4.3 MB that the npm build already ships in
  `dist/providers/data/`. Rejected for this round; it is the option to revisit
  if the catalog grows again without a curation answer.
- **Rank by size: keep the top N catalogs plus `core`.** Cheapest to automate
  and wrong on its face: `nano-gpt`, `llmgateway` and `edenai` land in the top
  ten purely because they resell someone else's models, while `github-copilot`
  and `xai` would be cut for being small and well integrated.
- **Generate the set from a popularity signal** (downloads, model counts,
  models.dev ordering). No such signal exists for a 200-line CLI, and a
  generated list would drift silently on the next models.dev update — the
  failure mode would be a vendor disappearing from a build nobody changed.
- **Drop the provider modules too, not just the catalogs.** Saves the ~0.4 MiB
  of registration code and shrinks `types.ts`. Rejected: it turns "we do not
  ship the data" into "we do not support the vendor", while the argument for the
  trim is data volume.
- **Keep `cerebras` / `baseten` / `together` because they have hand-written
  integrations.** They do, and the integration is what makes a `models.json`
  entry for them exact. But a curated list that includes a vendor because of
  internal tidiness rather than user demand is the same ranking failure as
  "top N by bytes".
- **Trim the classifier and image model data only.** 0.3 MiB by estimate, and
  it removes `typesafe`'s whole reason to exist while leaving the chat
  catalogs that are 90% of the bytes.
- **Keep the hash table and stop importing it.** `all.ts` reads one field
  (`generatedAt`); the table was imported as part of the same JSON. Splitting
  the manifest in two files would keep the build-time hashes out of the bundle
  without changing validation. Not worth a second file: validating a staged
  directory the same process just wrote is not a check that needs content
  hashes, and `structureHash` still catches a stale stamp.

## Consequences

Measured with `NANOPI_BUILD_FLAVOR=full node
scripts/build-coding-agent-single-file.mjs`:

```
full   12.1 MiB -> 9.4 MiB   catalogs 3.33 MiB -> 0.30 MiB, 177 catalogs stubbed
```

- The build prints `stubbed catalogs: <n>`, so the trim is visible in the build
  log rather than inferred from a size.
- `--list-models` in `full` shows 32 vendors instead of 206. `/login` shows the
  same 32; a vendor that is not there is one `models.json` entry away, and
  `docs/providers.md` lists the env var for each.
- `base` adds `openrouter`, `opencode` and `opencode-go` to its `core` set, so
  the trimmed flavor's picker has the two aggregators a user is most likely to
  paste a key into. Its model data grows by 348 KiB (68 KiB from the two
  opencode catalogs plus 280 KiB from `openrouter`).
- The npm package still ships `dist/providers/data/` for the catalogs it
  generates; the generator writes only the shipped set, so the artifact and the
  package agree.
- The manifest is 143 bytes instead of 17 KiB. A hand-edited catalog value no
  longer fails validation as long as ids and API groups stay intact — that check
  was the table's only remaining job, and the structure hash plus the id/API
  comparison in `validateModelDataDirectory` covers the failure that matters
  (a stale or mismatched generation).
- Adding a vendor back is one line in two sets and a regenerate. Removing one
  is the same; nothing in the build hardcodes a vendor name.
- `kiro` starts with 8 hand-maintained models and zero costs, so its numbers age
  like `antigravity`'s: they are edited by hand when Kiro ships a model.

## Testing

`packages/ai/test/kiro-oauth.test.ts` drives the flow against a stubbed
`fetch`: registration, the announced device code, pending/slow_down, denial,
cancellation, refresh with the stored client registration, and the refusal to
refresh a credential that has none. `packages/ai/test/model-data-validation.test.ts`
covers the manifest without hashes: a manifest naming files is ignored, and the
id/API/structure checks still fail.

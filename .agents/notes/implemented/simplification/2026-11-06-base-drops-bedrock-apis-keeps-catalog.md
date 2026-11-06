# Agent Note: `base` drops the Bedrock implementations and keeps the catalog

Status: implemented

## Problem

`base` carried the three AWS Bedrock API implementations
(`bedrock-converse-stream`, `bedrock-mantle-anthropic-messages`,
`bedrock-mantle-openai-responses`) without carrying the `amazon-bedrock`
catalog: `apis` was `"all"` and `providers` was `core`, which did not list the
vendor. `runtime-setup.ts` gates its three static Bedrock registrations on
`isApiIncluded("bedrock-*")`, so the implementations were registered while
`model-runtime.ts` filtered the provider out of the runtime. Code paid in full,
data not included, entry point closed. Measured on the base artifact
(6,872 KiB): `@aws-sdk/*` + `@smithy/*` is 798 KiB of input, ~428 KiB of it
pure Bedrock code and the rest a second copy of `@smithy/core` that only the
AWS variant of the `openai` client pulls.

Issue #528 asked which half of the inconsistency to fix. The answer was both,
because they are the same decision seen from two sides: Bedrock stays selectable
(a terminal CLI on a server already has the credentials in the environment), and
the implementation that a `base` user's models would name — the Converse API —
leaves the bundle with the SDK, because that is where 870 KiB is.

## Decision

`buildconfig.json` gets an `apiSets.endpoint` entry: every endpoint
implementation except the cloud-vendor ones. It names the 12 API ids `base` now
ships, including `anthropic-messages` and `openai-responses`, which the Mantle
Bedrock shapes reuse and other providers need anyway. `base` sets
`"apis": "endpoint"`; `full` stays on `all`.

`providerSets.core` gains `amazon-bedrock`, so the catalog `base` already pays
for is reachable: `/login` offers the three auth methods `bedrockAuth.login`
implements (bearer token, AWS profile, credential chain), and the catalog registers once a
credential resolves: `--list-models` with `AWS_BEARER_TOKEN_BEDROCK=dummy` lists
203 Bedrock models from the built artifact, 22 of them usable. The catalog costs ~112 KiB of JSON in the artifact, and its
181 `bedrock-converse-stream` models are skipped at load time by
`provider-composer.ts` — a skipped model is a warning, not an error, and the 22
Mantle models (14 `openai-responses`, 8 `anthropic-messages`) stay usable.

The rule this makes explicit: **a Bedrock model that names the dropped API is a
`models.json` entry away from working, and an entry that names it is skipped
with a warning naming the included APIs.** That is the existing
[skip-models-json-entries-outside-api-set](../bug-fix/2026-10-25-skip-models-json-entries-outside-api-set.md)
behavior, which this change finally puts to use.

Measured with `NANOPI_BUILD_FLAVOR=<flavor> node scripts/build-coding-agent-single-file.mjs`
on the same sources: `base` 7,037,883 → 6,236,472 bytes (−801,411, −782 KiB,
−11.4%); `full` unchanged at 10,213,098 bytes.

## Generator

`packages/ai/scripts/generate-models.ts` needed two changes, and both are about
the same mismatch: the unknown-provider check compared the flavor's set against
the providers a *previous* run left on disk (`readModelDataProviderIds`), which
on a clean checkout is whatever that run happened to write. `base` naming
`amazon-bedrock` while the last run shipped `full`'s files passed; `base` on a
fresh checkout (no `models.dev` entry for it in the recorded list) or after a
`base` run (which did not write a bedrock file, since the check refused) failed.

- The end-of-run check now runs against the catalogs the run itself produced
  (`selectProviderIdsFrom`), so the set is the authority and the message names
  the real typo.
- `processBedrockModels(data)` is one function instead of inline code inside
  `loadModelsDevData`, because the reason it has to exist at all is now
  interesting: a `base` run needs a catalog whose APIs the same build drops.

## Alternatives considered

- **Only add the catalog back (direction B).** Zero size change, one config
  line, and it makes the inconsistency disappear. Rejected as the *whole*
  answer: the 181 converse-stream models would then register against an API the
  build carries, which means paying 1.17 MiB for a host `base`'s description
  does not claim.
- **Only drop the APIs (direction A).** −850 KiB and no new catalog, but then
  the `amazon-bedrock` catalog stays out and `models.json` cannot reach the
  Mantle shapes either. The two Mantle APIs stay in the set, so the vendor is
  one `providerSets.core` entry from half working — exactly the state this note
  ends.
- **Use the `__ALL__`-minus list.** `apiSets` has no exclusion syntax: a set
  lists concrete ids, and `buildconfig.test.mjs` already rejects blending the
  marker with concrete ids. Spelling the 12 ids out is what makes the set
  reviewable in a diff.
- **Drop `openai-responses` / `anthropic-messages` too.** They are not Bedrock
  APIs: `openai-decisions`, `azure`, `github-copilot` and every Anthropic model
  name them. The stub plugin replaces the `.lazy` module and the implementation
  module it is the only reference to, and dropping those two would take those
  providers down with Bedrock.
- **Keep the empty-catalog branch keyed on `selectProviderIds(["*"])`.** That
  call is the one that threw on a fresh checkout; the branch now keys on the
  `__NONE__` marker, which is what it always meant.

## Consequences

- `base` has no Converse API: a `models.json` model with
  `api: "bedrock-converse-stream"` is skipped with a warning naming the 12
  included APIs, and the rest of the provider keeps working.
- The catalog's 181 converse-stream entries ship as data and are filtered out at
  composition. That is ~112 KiB of JSON for 22 usable models; the alternative
  was 870 KiB of code for 203.
- The `base` description and the `core` provider-set description say all of
  this, so the next reader does not re-add `apis: "all"` to make the catalog
  line up.
- `scripts/dist-sku-bedrock-apis.test.mjs` pins the pair: no `bedrock-*` id in
  `base`'s API set, every id in that set has an implementation module, and
  `core` still names `amazon-bedrock`.
- Regenerating the catalog for a flavor needs a source tree without the previous
  run's output (`rm -rf src/models.generated.ts src/providers/*.models.ts
  src/providers/data` first); that is unchanged, and `ensure-model-catalogs`
  still short-circuits when the files exist.

---
name: release
description: Prepare, publish, verify, and recover nanopi releases. Use for release preparation, local release smoke tests, publishing, and failed release CI or announcements.
---

# Releasing nanopi

Run repository commands from the repo root (two directories above this skill), unless instructed otherwise.

**Tag mirroring**: `.cnb.yml` (`push tags`) and `.github/workflows/sync-to-cnb.yml` (`Push tags to CNB`) mirror annotated tags in both directions. Tag on the **GitHub** side: `build-binaries.yml` fires on a tag push and exists only there, and `.cnb.yml` has no tag trigger, so a tag cut on CNB would publish nothing. The next push to `main` carries the tag over to CNB for clones there. Use an **annotated** tag (`git tag -a`): the mirror passes only annotated tags, since a lightweight and an annotated tag on the same commit are different objects. Neither mirror force-pushes: a tag name already pointing to a different commit on the other side fails the run and needs human judgement.

**Date versioning**: every release is tagged `vYYYYMMDD` (release day, e.g. `v20261013`). All packages stay in lockstep at `<YYYYMMDD>.0.0` in package.json (so `nanopi --version`, the sidecars tarball name, and `create-source-archive.mjs`'s tag/package version check all line up); a same-day follow-up release bumps to `<YYYYMMDD>.1.0` with tag `v<YYYYMMDD>.1.0`. Changelog headings use the bare date (`## [20261013]`, `## [20261013.1.0]` for follow-ups) because `scripts/release-notes.mjs extract` matches that form.

**GitHub-only distribution**: releases publish only to GitHub Releases. npm publishing was removed from the flow (the maintainer cannot complete npm 2FA); the `publish-npm` and `announce-nanopi-dev-release` jobs no longer exist in `.github/workflows/build-binaries.yml`. The `npm run release:patch|minor` scripts are obsolete; do not use them.

Release assets, built by CI from the release tag: the source archive, `nanopi.js` (single-file, `full` flavor), `nanopi-base.js` (`base` flavor: `full` without the bundled extras, docs, examples, sidecars, and OAuth flows, the standard tool set, the curated six-vendor catalog in `providerSets.core`), `nanopi-minimal.js` (`minimal` flavor: `base` with only the bash tool registered and the run-mode/permission module dropped), `nanopi-sidecars-<version>.tgz`, and `SHA256SUMS`. Flavor definitions live in the root `buildconfig.json`.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Cut the release**:

   ```bash
   pnpm -r exec npm version <YYYYMMDD>.0.0 --no-git-tag-version
   node scripts/sync-versions.js
   pnpm install --lockfile-only
   ```

   Then in every `packages/*/CHANGELOG.md` that has one, rename `## [Unreleased]` to `## [<YYYYMMDD>]` (no date suffix), commit everything as `Release v<YYYYMMDD>`, tag `v<YYYYMMDD>` on that commit, then add a fresh empty `## [Unreleased]` heading at the top of each changelog and commit as `Add [Unreleased] sections for next cycle` (after the tag, so the tagged tree has no empty sections). Push `main` and the tag to GitHub. Pushing the tag is what starts the release build; the next push to `main` mirrors the tag to CNB.

3. **Local smoke test** (optional but recommended before tagging): build the flavors from the repo and smoke test from outside the repo:

   ```bash
   node scripts/build-single-file.mjs --out /tmp/nanopi-bundles
   NANOPI_BUILD_FLAVOR=base node scripts/build-coding-agent-single-file.mjs --out /tmp/nanopi-bundles/nanopi-base.js
   NANOPI_BUILD_FLAVOR=minimal node scripts/build-coding-agent-single-file.mjs --out /tmp/nanopi-bundles/nanopi-minimal.js

   cd /tmp
   /tmp/nanopi-bundles/nanopi.js --help
   /tmp/nanopi-bundles/nanopi.js --version
   /tmp/nanopi-bundles/nanopi.js --list-models
   /tmp/nanopi-bundles/nanopi.js -p "Say exactly: ok"
   /tmp/nanopi-bundles/nanopi-base.js --help
   /tmp/nanopi-bundles/nanopi-base.js --version
   /tmp/nanopi-bundles/nanopi-minimal.js --help
   /tmp/nanopi-bundles/nanopi-minimal.js --version
   ```

   The minimal bundle registers the bash tool alone; a `--tools read,bash` run is reported as unavailable rather than failing at startup. A flavored build also only registers the providers in its set, so `--list-models` on `nanopi-base.js` / `nanopi-minimal.js` must not name a provider outside the flavor's provider set (`providerSets.core` for `base`, `none` for `minimal`).

   Flavor propagation, and why the smoke test keeps the flavor on one command
   line: the single-file and bundle scripts read `NANOPI_BUILD_FLAVOR` from the
   environment and add no child build step, so `base`/`minimal` builds do not
   touch `dist/`. `pnpm run build` does: `packages/coding-agent` runs
   `copy-assets`, which only honors `--flavor` and deliberately ignores the
   environment variable, because npm/pnpm hand the variable to the child
   process again and an exported flavor would strip `dist/webui` and
   `dist/core/export-html` for later unflavored builds. Do not export
   `NANOPI_BUILD_FLAVOR` in a shell that also runs `pnpm run build`; pass the
   flavor on the command line of the build you mean, as the steps above do.

   Verify startup, model/account listing, and at least one real prompt with the intended default provider. Start each bundle bare in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk. Load and follow [interactive-testing.md](interactive-testing.md) for the tmux workflow; start each release binary from `/tmp`, not the repo root.

4. **CI builds and publishes**: pushing the `vYYYYMMDD` tag triggers `.github/workflows/build-binaries.yml`. It archives the tagged source, builds the single-file bundles from that archive, smoke tests them on Linux/macOS/Windows, stages a draft GitHub Release with the assets above, then publishes it. No npm step runs. Do not rerun the pipeline after the release published.

5. **If a CI step fails**: the cleanup job deletes the staged draft. Inspect the failed job and fix `main`. A pushed tag cannot be rebuilt as-is if it predates the fix, so dispatch the workflow manually with `tag` set to the release tag and `source_ref` pointing at the fixed commit on `main` (Actions page → Build Binaries → Run workflow, or `gh workflow run build-binaries.yml -f tag=<tag> -f source_ref=<sha>`); the tag stays where it is and assets are built from `source_ref`. A published release is never mutated; if the tag itself is wrong, ship the next date release.

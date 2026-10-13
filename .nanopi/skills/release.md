---
name: release
description: Prepare, publish, verify, and recover nanopi releases. Use for release preparation, local release smoke tests, publishing, and failed release CI or announcements.
---

# Releasing nanopi

Run repository commands from the repo root (two directories above this skill), unless instructed otherwise.

**Date versioning**: every release is tagged `vYYYYMMDD` (release day, e.g. `v20261013`). All packages share one version section; changelog headings use the bare date (`## [20261013]`) because `scripts/release-notes.mjs extract` matches that form. Multiple releases on one day append `-2`, `-3` (`v20261013-2` → `## [20261013-2]`).

**GitHub-only distribution**: releases publish only to GitHub Releases. npm publishing was removed from the flow (the maintainer cannot complete npm 2FA); the `publish-npm` and `announce-nanopi-dev-release` jobs no longer exist in `.github/workflows/build-binaries.yml`, and package.json versions are not bumped for releases. The `npm run release:patch|minor` scripts are obsolete; do not use them.

Release assets, built by CI from the release tag: the source archive, `nanopi.js` (single-file, `full` flavor), `nanopi-minimal.js` (single-file, `minimal` flavor: no webui, export templates, docs, examples, or OAuth flows), `nanopi-sidecars-<version>.tgz`, and `SHA256SUMS`.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Cut the release**: in every `packages/*/CHANGELOG.md` that has one, rename `## [Unreleased]` to `## [<YYYYMMDD>]` (no date suffix), commit as `Release v<YYYYMMDD>`, tag `v<YYYYMMDD>` on that commit, then add a fresh empty `## [Unreleased]` heading at the top of each changelog and commit as `Add [Unreleased] sections for next cycle` (after the tag, so the tagged tree has no empty sections). Push `main` and the tag.

3. **Local smoke test** (optional but recommended before tagging): build both flavors from the repo and smoke test from outside the repo:

   ```bash
   ./scripts/build-single-file.sh --out /tmp/nanopi-bundles
   NANOPI_BUILD_FLAVOR=minimal node scripts/build-coding-agent-single-file.mjs --out /tmp/nanopi-bundles/nanopi-minimal.js

   cd /tmp
   /tmp/nanopi-bundles/nanopi.js --help
   /tmp/nanopi-bundles/nanopi.js --version
   /tmp/nanopi-bundles/nanopi.js --list-models
   /tmp/nanopi-bundles/nanopi.js -p "Say exactly: ok"
   /tmp/nanopi-bundles/nanopi-minimal.js --help
   /tmp/nanopi-bundles/nanopi-minimal.js --version
   ```

   Verify startup, model/account listing, and at least one real prompt with the intended default provider. Start each bundle bare in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk. Load and follow [interactive-testing.md](interactive-testing.md) for the tmux workflow; start each release binary from `/tmp`, not the repo root.

4. **CI builds and publishes**: pushing the `vYYYYMMDD` tag triggers `.github/workflows/build-binaries.yml`. It archives the tagged source, builds both single-file bundles from that archive, smoke tests them on Linux/macOS/Windows, stages a draft GitHub Release with the assets above, then publishes it. No npm step runs. Do not rerun the pipeline after the release published.

5. **If a CI step fails**: the cleanup job deletes the staged draft. Inspect the failed job and rerun it, or re-run the whole workflow from the GitHub Actions page (`workflow_dispatch` with `tag` and, for recovery, `source_ref` pointing at a fixed commit). A published release is never mutated; if the tag itself is bad, fix `main` and ship the next date release.

#!/usr/bin/env node
/**
 * One aws-sdk version line, one `@smithy/core`.
 *
 * aws-sdk packages depend on each other with `^3.x` ranges, and `^` on a
 * pre-1.0-style 3.x crosses minors, so two lines of the family can coexist
 * legally: one pulled in by our direct dependency, one dragged along by an
 * upstream package that pinned a version (`@aws-sdk/credential-provider-sso`
 * and `client-bedrock-runtime` pin `@aws-sdk/token-providers` exactly). Each
 * line carries its own `@smithy/core`, and `@smithy/core` is the family's
 * shared runtime chunk: ~200 KB per copy, both copies end up in the single-file
 * build, and nothing in the tree says so. The full flavor grew 8.8 -> 9.2 MiB
 * (#709) exactly that way: a dependency bump moved most packages to
 * `@smithy/core@3.40.0`, one stale `token-providers` snapshot stayed on 3.39.0.
 *
 * `overrides` in pnpm-workspace.yaml is the fix. This check is the tripwire for
 * the next time an upgrade walks around it: it reports every package that the
 * lockfile files under more than one version, so the failure reads as
 * "<package> appears as v1, v2" instead of as a release artifact nobody
 * weighed.
 *
 * Scope is the lockfile, not the build: `pnpm run check` runs on a checkout
 * where `dist` and `binaries` do not exist yet.
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";

/**
 * Packages allowed to appear in several versions.
 *
 * These fork because upstream pinned them exactly: `credential-provider-sso`
 * (and `client-bedrock-runtime` for `token-providers`) name their
 * `credential-provider-*` siblings and `nested-clients` at one exact version,
 * while the rest of the tree takes the `^` ranges they publish. Pinning a whole
 * family of exact pins means minting an override for every package on every
 * upstream release, and these are per-client code, which a trimmed build
 * already drops by API set.
 *
 * `@aws-sdk/core` is the same story one level up: `token-providers@3.1162.0`
 * wants `^3.980.0`, the rest wants `^3.981.0`.
 *
 * What costs bytes is the shared runtime chunk: `@smithy/core`, and with it
 * the `@smithy/*` helpers that all depend on it through `^` ranges. That one
 * must not fork, and it does not need to: every `@smithy/core` range in the
 * family starts at 3.33, so one version satisfies all of them.
 */
const ALLOWED_DUPLICATES = [
	/^@aws-sdk\/(?:core|credential-provider-|nested-clients|signature-v4-multi-region|types|xml-builder)/,
];

const lockfile = parse(readFileSync("pnpm-lock.yaml", "utf8")) ?? {};
const versions = new Map();
for (const entry of Object.keys(lockfile.packages ?? {})) {
	const at = entry.lastIndexOf("@");
	if (at <= 0) continue;
	const name = entry.slice(0, at);
	const version = entry.slice(at + 1);
	if (!name.startsWith("@aws-sdk/") && !name.startsWith("@smithy/")) continue;
	if (!versions.has(name)) versions.set(name, []);
	versions.get(name).push(version);
}

const failures = [];
for (const [name, found] of [...versions].sort(([a], [b]) => a.localeCompare(b))) {
	if (found.length < 2) continue;
	if (ALLOWED_DUPLICATES.some((pattern) => pattern.test(name))) continue;
	failures.push(`${name}: ${found.sort().join(", ")}`);
}

if (failures.length > 0) {
	console.error("aws-sdk/@smithy packages resolved to more than one version:");
	for (const failure of failures) console.error(`  ${failure}`);
	console.error(
		"An extra @smithy/core is a second copy of the aws-sdk runtime chunk in the single-file build. " +
			"Pin the family with `overrides` in pnpm-workspace.yaml (see the comment there), or widen " +
			"ALLOWED_DUPLICATES with the reason the fork is free.",
	);
	process.exit(1);
}

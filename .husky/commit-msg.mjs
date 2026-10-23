#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

// Gerrit 3.13.1 commit-msg hook, ported to Node.
// Adds a Change-Id trailer (or Link when gerrit.reviewUrl is set) unless one is
// already present, honoring gerrit.createChangeId and skipping squash/fixup.

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function capture(args, options) {
	const result = spawnSync("git", args, { encoding: "utf8", ...options });
	if (result.error || result.status !== 0) return undefined;
	return result.stdout;
}

const messageFile = process.argv[2];
if (!messageFile) fail(`${process.argv[1]} requires an argument.`);
if (!statSync(messageFile, { throwIfNoEntry: false })?.isFile()) fail(`file does not exist: ${messageFile}`);

// Read as-is: `git interpret-trailers` drops a scissors section on its own.
const message = readFileSync(messageFile, "utf8");

switch (capture(["config", "--get", "gerrit.createChangeId"])) {
	case "false\n":
		process.exit(0);
		break;
	case "always\n":
		break;
	default: {
		// Do not create a change id for squash/fixup commits.
		if (/^[a-z][a-z]*! /.test(message.split("\n")[0])) process.exit(0);
	}
}

// An empty message after comments are stripped is an error, not something to
// attach a trailer to (this is what the shell version's `test -s` enforced).
const stripped = capture(["stripspace", "--strip-comments"], { input: message });
if (stripped === undefined) fail(`cannot strip comments from ${messageFile}`);
if (stripped.trim() === "") fail(`file is empty: ${messageFile}`);

const referenceHash =
	capture(["rev-parse", "--verify", "HEAD"]) ?? capture(["hash-object", "-t", "tree", "/dev/null"]) ?? "";
const random = capture(["hash-object", "--stdin"], {
	input: `${capture(["var", "GIT_COMMITTER_IDENT"]) ?? ""}${referenceHash}${message}`,
});
if (random === undefined) fail("cannot compute the commit hash for the Change-Id");

const reviewUrl = (capture(["config", "--get", "gerrit.reviewUrl"]) ?? "").replace(/\n$/, "");
const token = reviewUrl ? "Link" : "Change-Id";
const value = reviewUrl ? `${reviewUrl.replace(/\/$/, "")}/id/I${random}` : `I${random}`;
const pattern = reviewUrl ? /.*\/id\/I[0-9a-f]{40}$/ : /.*/;

const trailers = capture(["interpret-trailers", "--no-divider", "--parse"], { input: message });
if (trailers === undefined) fail(`cannot parse trailers from ${messageFile}`);
const alreadyPresent = trailers
	.split("\n")
	.some((line) => line.startsWith(`${token}: `) && pattern.test(line.slice(token.length + 2)));

if (!alreadyPresent) {
	// There must be a Signed-off-by trailer for the insertion below to work, so
	// add a sentinel first, then let git place our trailer before it.
	const withSentinel = capture(["interpret-trailers", "--no-divider", "--trailer", "Signed-off-by: SENTINEL"], {
		input: message,
	});
	if (withSentinel === undefined) fail(`cannot insert Signed-off-by sentinel line in ${messageFile}`);

	// Insert as if it were a Signed-off-by trailer, then strip that prefix and the
	// sentinel. Avoids --in-place (Git 2.8) and --where (Git 2.15) for portability.
	const withTrailer = capture(
		[
			"-c",
			"trailer.where=before",
			"interpret-trailers",
			"--no-divider",
			"--trailer",
			`Signed-off-by: ${token}: ${value}`,
		],
		{ input: withSentinel },
	);
	if (withTrailer === undefined) fail(`cannot insert ${token} line in ${messageFile}`);

	// Gerrit inserts our trailer as if it were a Signed-off-by and then, in one
	// sed pass, strips that prefix and deletes the sentinel line. Keep the blank
	// line that separates the trailer block from the body.
	const prefixed = `Signed-off-by: ${token}: `;
	const updated = `${withTrailer
		.split("\n")
		.filter((line) => line !== "Signed-off-by: SENTINEL")
		.map((line) => (line.startsWith(prefixed) ? line.slice("Signed-off-by: ".length) : line))
		.join("\n")
		.replace(/\n*$/, "")}\n`;

	// Write next to the message and rename over it, so an interrupted run cannot
	// leave a truncated COMMIT_EDITMSG behind.
	const temporary = `${messageFile}.${random}.tmp`;
	try {
		writeFileSync(temporary, updated);
		renameSync(temporary, messageFile);
	} finally {
		rmSync(temporary, { force: true });
	}
}

process.exit(0);

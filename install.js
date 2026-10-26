#!/usr/bin/env node
// Downloads a NanoPi bundle from the latest (or a given) GitHub release.
//
//   curl -fsSL https://raw.githubusercontent.com/NekoSekaiMoe/nanopi/main/install.js | node
//   node install.js --sku=minimal --version=v20261013 --out=./nanopi.js

import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { styleText } from "node:util";

const REPOSITORY = "NekoSekaiMoe/nanopi";
// Keep in sync with the assets staged by .github/workflows/build-binaries.yml
// and with the flavor table in buildconfig.json.
const SKUS = { full: "nanopi.js", base: "nanopi-base.js", minimal: "nanopi-minimal.js" };
const DEFAULT_TIMEOUT_MS = 120_000;

class InstallError extends Error {}

const download = async (url, description) => {
	if (description) process.stderr.write(description + "…");
	const response = await fetch(url, {
		headers: { "user-agent": "nanopi-install" },
		signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
	});
	if (description) process.stderr.write(response.ok ? " done\n" : "\n");
	if (!response.ok) throw new InstallError(`${description || "request"} failed: ${response.status} ${response.statusText} (${url})`);
	return response;
};

const text = async (url, description) => (await download(url, description)).text();

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const parseArguments = (arguments_) => {
	const options = { sku: "full", version: "latest", out: undefined, help: false };
	for (let index = 0; index < arguments_.length; index++) {
		const expression = arguments_[index];
		const equals = expression.indexOf("=");
		const name = equals === -1 ? expression : expression.slice(0, equals);
		// `--flag value` as well as `--flag=value`.
		const value = equals === -1 ? () => arguments_[++index] : () => expression.slice(equals + 1);
		switch (name) {
			case "--sku":
			case "--version":
			case "--out": {
				const result = value();
				if (!result) throw new InstallError(`${name} needs a value`);
				options[name.slice(2)] = result;
				break;
			}
			case "--help":
			case "-h":
				options.help = true;
				break;
			default:
				throw new InstallError(`unknown argument: ${expression}`);
		}
	}
	if (!Object.hasOwn(SKUS, options.sku)) {
		throw new InstallError(`unknown sku: ${options.sku} (expected ${Object.keys(SKUS).join(", ")})`);
	}
	return options;
};

const usage = () => `Usage: install.js [--sku=${Object.keys(SKUS).join("|")}] [--version=<tag>] [--out=<path>]

  --sku       bundle to download: full (default), base, minimal
  --version   release tag, with or without the leading v (default: latest)
  --out       where to write the bundle (default: ./<asset name>)

Examples:
  curl -fsSL https://raw.githubusercontent.com/${REPOSITORY}/main/install.js | node
  curl -fsSL https://raw.githubusercontent.com/${REPOSITORY}/main/install.js | node - --sku=minimal
  node install.js --version=v20261013 --out=./nanopi.js`;

const releaseTag = async (version) => {
	if (version !== "latest") return version.startsWith("v") ? version : `v${version}`;
	const release = JSON.parse(
		await text(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, "Resolving latest release"),
	);
	if (typeof release.tag_name !== "string") throw new InstallError("latest release has no tag_name");
	return release.tag_name;
};

const absoluteUrl = (url) => (url.startsWith("http://") || url.startsWith("https://") ? url : `https://${url}`);

const main = async () => {
	const options = parseArguments(process.argv.slice(2));
	if (options.help) {
		process.stdout.write(`${usage()}\n`);
		return 0;
	}

	const tag = await releaseTag(options.version);
	const asset = SKUS[options.sku];
	const base = `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}`;

	// The checksum file is the release's own record of what was uploaded; without
	// it a truncated bundle would only fail later, as a syntax error at run time.
	const sums = new Map();
	for (const line of (await text(`${base}/SHA256SUMS`, `Fetching SHA256SUMS for ${tag}`)).split("\n")) {
		const match = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
		if (match) sums.set(match[2].trim().replace(/^\.\//, ""), match[1]);
	}

	const url = base + "/" + encodeURIComponent(asset);
	const bytes = new Uint8Array(await (await download(url, `Downloading ${asset} (${tag}, ${options.sku})`)).arrayBuffer());

	const expected = sums.get(asset);
	if (!expected) throw new InstallError(`${asset} is not listed in SHA256SUMS for ${tag}`);
	const actual = sha256(bytes);
	if (actual !== expected) throw new InstallError(`${asset} checksum mismatch: expected ${expected}, got ${actual}`);

	const out = resolve(options.out ?? basename(url));
	writeFileSync(out, bytes);
	chmodSync(out, 0o755);
	process.stdout.write(`${styleText("green", "Downloaded")} ${asset} (${bytes.byteLength} bytes) from ${tag}\n${out}\n`);
	process.stdout.write(`Run it with \`node ${out}\`\n`);
	return 0;
};

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error) => {
		process.stderr.write(`${styleText("red", "nanopi install failed")}: ${error instanceof InstallError ? error.message : error.stack}\n`);
		process.exitCode = 1;
	},
);

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OWNER_SCOPE = "@nekosekaimoe";
const PACKAGE_DIR_NAME = "packages/coding-agent";
const PACKAGE_NAME = `${OWNER_SCOPE}/nanopi`;
// Relative to this script, so the CLI works from any working directory.
const PACKAGE_DIR = fileURLToPath(new URL("../packages/coding-agent", import.meta.url));
// `dist` only exists after a build; the rest ship from the source tree.
const BUILT_ENTRIES = new Set(["dist"]);

const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
if (outFlag === -1 || !args[outFlag + 1]) {
	throw new Error("Usage: node scripts/make-github-package.mjs --out <dir> [--version <version>]");
}
const outDir = resolve(args[outFlag + 1]);
// 发布 nightly 要一个 registry 上唯一的版本号（<发布版本>-nightly.<日期>），
// tarball 里的版本因此不能固定取 package.json。
const versionFlag = args.indexOf("--version");
const versionOverride = versionFlag === -1 ? undefined : args[versionFlag + 1];
if (versionFlag !== -1 && !versionOverride) {
	throw new Error("Usage: node scripts/make-github-package.mjs --out <dir> [--version <version>]");
}

function copyTree(source, target) {
	mkdirSync(target, { recursive: true });
	for (const entry of readdirSync(source, { withFileTypes: true })) {
		const from = join(source, entry.name);
		const to = join(target, entry.name);
		if (entry.isDirectory()) copyTree(from, to);
		else if (entry.isFile()) copyFileSync(from, to);
	}
}

const { name, version, publishConfig, scripts, devDependencies, ...rest } = JSON.parse(
	readFileSync(join(PACKAGE_DIR, "package.json"), "utf8"),
);
const publishedVersion = versionOverride ?? version;
rmSync(outDir, { force: true, recursive: true });
mkdirSync(outDir, { recursive: true });
for (const entry of rest.files) {
	const source = join(PACKAGE_DIR, entry);
	if (!existsSync(source)) {
		if (BUILT_ENTRIES.has(entry)) throw new Error(`${join(PACKAGE_DIR_NAME, entry)} is missing; build before repacking`);
		continue;
	}
	if (statSync(source).isDirectory()) copyTree(source, join(outDir, entry));
	else copyFileSync(source, join(outDir, entry));
}
writeFileSync(join(outDir, "package.json"), `${JSON.stringify({ ...rest, name: PACKAGE_NAME, version: publishedVersion }, null, "\t")}\n`);
console.log(`${PACKAGE_NAME}@${publishedVersion}: ${outDir}`);

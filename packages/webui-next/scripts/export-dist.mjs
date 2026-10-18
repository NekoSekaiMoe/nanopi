import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const out = join(root, "out");
const dist = join(root, "dist");

if (!existsSync(out)) {
	console.error("next export output is missing: run `next build` first");
	process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
cpSync(out, dist, { recursive: true });
console.log("webui-next static export copied to dist/");

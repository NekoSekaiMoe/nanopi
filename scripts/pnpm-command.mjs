import { execFileSync } from "node:child_process";

export function execPnpmSync(args, options = {}) {
	return execFileSync("pnpm", args, { shell: process.platform === "win32", ...options });
}

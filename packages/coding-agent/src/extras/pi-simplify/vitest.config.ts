import { defineConfig } from "vitest/config";

// The workspace config excludes extras/ (they are vendored snapshots), so this
// suite needs its own entry point.
export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["src/**/*.test.ts"],
	},
});

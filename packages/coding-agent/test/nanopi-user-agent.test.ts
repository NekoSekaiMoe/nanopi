import { describe, expect, it } from "vitest";
import { getNanoPiUserAgent } from "../src/utils/nanopi-user-agent.ts";

describe("getNanoPiUserAgent", () => {
	it("formats the nanopi user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getNanoPiUserAgent("1.2.3");

		expect(userAgent).toBe(`nanopi/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^nanopi\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});

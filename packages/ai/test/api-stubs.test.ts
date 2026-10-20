import { describe, expect, it } from "vitest";
import { anthropicMessagesApi } from "../src/api/anthropic-messages.lazy.ts";
import { disabledBedrockConverseStreamApi } from "./disabled-api-imports.ts";

/**
 * An API implementation module the build replaced (scripts/build-apis.mjs) keeps
 * the wrapper's export names and signatures, so the registry still registers the
 * id and `models.json` gets a clear error instead of a module-not-found crash.
 */
describe("API stand-ins", () => {
	it("throws a build-flavor error instead of loading the implementation", () => {
		expect(() => disabledBedrockConverseStreamApi().stream({} as never, {} as never)).toThrow(
			/bedrock-converse-stream is not included in this build/,
		);
	});

	it("keeps the real wrapper untouched outside a flavored build", () => {
		expect(typeof anthropicMessagesApi().stream).toBe("function");
	});
});

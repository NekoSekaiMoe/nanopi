import { describe, expect, it } from "vitest";
import { getModelsPath } from "../src/config.ts";
import { formatNoApiKeyFoundMessage, formatNoModelsAvailableMessage } from "../src/core/auth-guidance.ts";

// Outside a flavored bundle every provider is built in, so the guidance points
// at /login. The no-provider branch is exercised here through the message the
// no-provider build shows its users.
describe("no models guidance", () => {
	it("points a full build at /login", () => {
		expect(formatNoModelsAvailableMessage()).toContain("Use /login");
		expect(formatNoModelsAvailableMessage()).not.toContain(getModelsPath());
	});

	it("names the provider in the missing-key message", () => {
		expect(formatNoApiKeyFoundMessage("openai")).toContain("No API key found for openai.");
		expect(formatNoApiKeyFoundMessage("unknown")).toContain("No API key found for the selected model.");
	});
});

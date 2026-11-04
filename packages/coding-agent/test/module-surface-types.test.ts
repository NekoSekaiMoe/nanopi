import { describe, expect, test } from "vitest";
import type {
	ModuleApi,
	ModuleCommandsSurface,
	ModuleEventsSurface,
	ModuleProvidersSurface,
	ModuleToolsSurface,
	SessionModule,
} from "../src/core/modules/types.ts";

/** A module that declares only the commands surface compiles against it. */
const commandsOnly: SessionModule<ModuleCommandsSurface> = {
	name: "commands-only",
	factory: (nanopi) => {
		nanopi.registerCommand("hello", { handler: async () => {} });
		// @ts-expect-error registerProvider is not part of ModuleCommandsSurface
		nanopi.registerProvider;
		// @ts-expect-error registerTool is not part of ModuleCommandsSurface
		nanopi.registerTool;
	},
};

/** Surfaces compose: a factory may name several. */
const eventsAndTools: SessionModule<ModuleEventsSurface & ModuleToolsSurface> = {
	name: "events-and-tools",
	factory: (nanopi) => {
		nanopi.on("session_start", () => {});
		nanopi.registerTool;
		// @ts-expect-error registerCommand is not part of either surface
		nanopi.registerCommand;
	},
};

/** The default type parameter keeps the whole API. */
const fullSurface: SessionModule = {
	name: "full",
	factory: (nanopi) => {
		nanopi.registerProvider("x", {});
		nanopi.registerCommand("y", { handler: async () => {} });
	},
};

/** The host hands the full API to any factory, whatever surface the module declared. */
type AcceptsSurface<T> = (factory: (nanopi: T) => void) => void;
const hostCallsFactory: AcceptsSurface<ModuleApi> = (factory) => factory({} as ModuleApi);
const declared: SessionModule<ModuleProvidersSurface>["factory"] = () => {};

/** A surface is a subset, so it is not itself a ModuleApi: the host supplies the rest. */
// @ts-expect-error a single surface does not satisfy ModuleApi
const notTheWholeApi: ModuleApi = null as unknown as ModuleProvidersSurface;

describe("module surfaces", () => {
	test("declared surfaces are just types; the host passes the full API", () => {
		expect(commandsOnly.name).toBe("commands-only");
		expect(eventsAndTools.name).toBe("events-and-tools");
		expect(fullSurface.name).toBe("full");
		expect(typeof hostCallsFactory).toBe("function");
		expect(typeof declared).toBe("function");
		expect(notTheWholeApi).toBeNull();
	});
});

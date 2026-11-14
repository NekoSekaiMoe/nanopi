import { describe, expect, it } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type RpcClientPrivate = {
	prompt: (message: string) => Promise<string>;
};

describe("RpcClient promptAndWait", () => {
	it("returns at once when the session handled the prompt itself", async () => {
		const client = new RpcClient();
		const privateClient = client as unknown as RpcClientPrivate;
		// A handled prompt starts no run, so no agent_settled event ever arrives for it.
		privateClient.prompt = async () => "handled";

		const events = await client.promptAndWait("run /status", undefined, 50);

		expect(events).toEqual([]);
	});
});

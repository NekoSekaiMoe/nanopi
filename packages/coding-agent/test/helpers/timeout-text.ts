import type { BashOperations } from "../../src/core/tools/bash.ts";
import { createBashToolDefinition } from "../../src/core/tools/bash.ts";

/**
 * The reported text of a command the tool fails, i.e. the formatted message it throws. A timeout
 * is a failure, so the exit-code assertions read the text the throw carries.
 */
export async function executeFailureText(
	command: string,
	timeout: number,
	operations?: BashOperations,
): Promise<string> {
	const definition = createBashToolDefinition(process.cwd(), operations ? { operations } : undefined);
	try {
		await definition.execute("call", { command, timeout }, undefined, undefined, {
			cwd: process.cwd(),
			model: undefined,
			sessionManager: { getSessionId: () => "test-session", getSessionFile: () => undefined },
		} as never);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected the command to fail");
}

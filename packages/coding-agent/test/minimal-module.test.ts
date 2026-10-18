import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@nanopi/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionModule } from "../src/core/modules/types.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import minimalToolsExtension from "../src/modules/minimal/index.ts";

describe("minimal build tool set", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `nanopi-minimal-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(defaultTools?: string[]) {
		const modules: SessionModule[] = [{ name: "minimal", factory: minimalToolsExtension }];
		const settingsManager = SettingsManager.inMemory(defaultTools ? { defaultTools } : {});
		const resourceLoader = new DefaultResourceLoader({ cwd: tempDir, agentDir, settingsManager, modules });
		await resourceLoader.reload();
		const session = (
			await createAgentSession({
				cwd: tempDir,
				agentDir,
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				settingsManager,
				sessionManager: SessionManager.inMemory(tempDir),
				resourceLoader,
			})
		).session;
		await session.bindModules({ mode: "print" });
		return session;
	}

	it("declares only the shell tools", async () => {
		const session = await createSession();
		expect(session.getActiveToolNames()).toEqual(["bash", "powershell"]);
		expect(session.systemPrompt).not.toContain("- read:");
		session.dispose();
	});

	it("overrides a wider defaultTools setting", async () => {
		const session = await createSession(["read", "edit", "write"]);
		expect(session.getActiveToolNames()).toEqual(["bash", "powershell"]);
		session.dispose();
	});
});

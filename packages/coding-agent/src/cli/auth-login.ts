/**
 * Sign-in from the shell: `nanopi auth login --provider <provider>` drives the
 * same provider flow the TUI and webui use, answering its questions on the
 * terminal instead. Only OAuth is offered here, because an API key is a value
 * the caller already has: `$PROVIDER_API_KEY` or models.json covers it.
 */

import { createInterface } from "node:readline";
import type { AuthEvent, OAuthAuth, ProviderAuthInteraction } from "@nanopi/pi-ai";
import chalk from "chalk";
import { APP_NAME } from "../config.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import { openBrowser } from "../utils/open-browser.ts";
import type { Args } from "./args.ts";
import { AuthCommandError, validateAuthCommandArgs } from "./auth-command.ts";

/** One question a sign-in flow asks; answered by `ask` on a terminal. */
export interface AuthLoginPrompt {
	message: string;
	placeholder?: string;
	options?: readonly { id: string; label: string }[];
}

export interface AuthLoginOptions {
	signal: AbortSignal;
	/** Answers the flow's questions. Default: ask on the terminal. */
	prompt?: (prompt: AuthLoginPrompt) => Promise<string>;
	/** Open printed URLs in the browser. Default true. */
	openBrowser?: boolean;
	/** Stable installation ID for flows that introduce the app; see LoginOptions.getDeviceId. */
	getDeviceId?: () => string;
}

export interface AuthLoginResult {
	provider: string;
	/** Provider display name for the confirmation line. */
	name: string;
}

/** Ask one question on the terminal. EOF and Ctrl+C both abort the sign-in. */
function ask(prompt: AuthLoginPrompt): Promise<string> {
	if (prompt.options && prompt.options.length > 0) {
		const choices = prompt.options
			.map((option, index) => `  ${index + 1}. ${option.label} (${option.id})`)
			.join("\n");
		process.stdout.write(`${prompt.message}\n${choices}\n`);
	} else {
		const hint = prompt.placeholder ? chalk.dim(` (${prompt.placeholder})`) : "";
		process.stdout.write(`${prompt.message}${hint}\n`);
	}
	return new Promise((done) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		rl.on("SIGINT", () => {
			rl.close();
			done("\u0003");
		});
		rl.on("close", () => done(""));
		rl.question("> ", (answer) => {
			rl.close();
			const trimmed = answer.trim();
			const picked = /^\d+$/u.test(trimmed) ? prompt.options?.[Number(trimmed) - 1]?.id : undefined;
			done(picked ?? trimmed);
		});
	});
}

/** Print what the flow reports and, when it names a URL, hand it to the browser. */
function reportEvent(event: AuthEvent, openUrl: boolean): void {
	switch (event.type) {
		case "info":
			console.log(event.message);
			for (const link of event.links ?? []) console.log(chalk.dim(`  ${link.label ?? link.url}: ${link.url}`));
			return;
		case "auth_url":
			console.log(`Open this URL to continue:\n  ${event.url}`);
			if (event.instructions) console.log(chalk.dim(`  ${event.instructions}`));
			if (openUrl) openBrowser(event.url);
			return;
		case "device_code":
			console.log(`Open ${event.verificationUri} and enter the code ${chalk.bold(event.userCode)}`);
			if (event.expiresInSeconds) console.log(chalk.dim(`  The code expires in ${event.expiresInSeconds}s.`));
			if (openUrl) openBrowser(event.verificationUri);
			return;
		case "progress":
			console.log(chalk.dim(event.message));
			return;
	}
}

export async function runAuthLogin(
	args: Args,
	modelRuntime: ModelRuntime,
	options: AuthLoginOptions,
): Promise<AuthLoginResult> {
	const { provider: providerId } = validateAuthCommandArgs(args, "login");
	if (!providerId) throw new AuthCommandError("Login requires --provider <provider>");
	const provider = modelRuntime.getProvider(providerId);
	if (!provider) {
		throw new AuthCommandError(`Unknown provider "${providerId}". Use --list-models to see available providers.`);
	}
	const oauth: OAuthAuth | undefined = provider.auth.oauth;
	if (!oauth?.login) {
		throw new AuthCommandError(
			`Provider "${providerId}" has no OAuth login. Set its API key instead, or run ${APP_NAME} auth check --provider ${providerId}.`,
		);
	}

	// A provider's notice is about the account, not about a step, so it prints before the flow starts asking.
	for (const line of oauth.notice ?? []) console.log(chalk.yellow(line));

	const openUrl = options.openBrowser ?? true;
	const interaction: ProviderAuthInteraction = {
		signal: options.signal,
		notify: (event) => reportEvent(event, openUrl),
		prompt: options.prompt ?? ask,
	};
	try {
		await modelRuntime.login(providerId, "oauth", interaction, { getDeviceId: options.getDeviceId });
	} catch (error) {
		if (error instanceof Error && (error.message === "Login cancelled" || error.message === "\u0003")) {
			throw new AuthCommandError("Login cancelled");
		}
		throw error;
	}
	return { provider: providerId, name: oauth.name };
}

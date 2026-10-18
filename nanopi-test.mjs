#!/usr/bin/env node

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { environmentWithout, fail, runNode } from "./scripts/lib/node-runner.mjs";

// Runs nanopi from this source checkout. `--no-env` runs without any provider
// credentials so the process cannot silently reach a paid API.

const repositoryRoot = dirname(fileURLToPath(import.meta.url));
const cliPath = join(repositoryRoot, "packages/coding-agent/src/cli.ts");
const sourceResolver = join(repositoryRoot, "packages/coding-agent/scripts/source-resolver.ts");

// Kept in sync with packages/ai/src/env-api-keys.ts.
const providerEnvironmentVariables = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"ZAI_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"AI_GATEWAY_API_KEY",
	"OPENCODE_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"HF_TOKEN",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"AWS_PROFILE",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AZURE_OPENAI_API_KEY",
	"AZURE_OPENAI_BASE_URL",
	"AZURE_OPENAI_RESOURCE_NAME",
];

for (const required of [cliPath, sourceResolver]) {
	if (!existsSync(required)) fail(`Missing ${required}; run this from a source checkout`);
}

const args = process.argv.slice(2);
const withoutKeys = args.includes("--no-env");
if (withoutKeys) process.stdout.write("Running without API keys...\n");

runNode(cliPath, args.filter((argument) => argument !== "--no-env"), {
	environment: withoutKeys ? environmentWithout(providerEnvironmentVariables) : process.env,
	preloads: [sourceResolver],
});

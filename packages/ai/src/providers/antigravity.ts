import { antigravityApi } from "../api/antigravity.lazy.ts";
import { envApiKeyAuth, lazyOAuth } from "../auth/helpers.ts";
import { loadAntigravityOAuth } from "../auth/oauth/load.ts";
import { createProvider, type Provider } from "../models.ts";
import { ANTIGRAVITY_MODELS } from "./antigravity.models.ts";

/**
 * Google Antigravity talks to the Cloud Code Assist backend with a Google
 * account rather than an API key. `ANTIGRAVITY_ACCESS_TOKEN` exists for
 * short-lived tokens scripted from `gcloud auth print-access-token`; third-party
 * use of this backend violates Google's terms and can get an account suspended.
 */
export function antigravityProvider(): Provider<"antigravity"> {
	return createProvider({
		id: "antigravity",
		name: "Google Antigravity (unofficial)",
		auth: {
			apiKey: envApiKeyAuth("Antigravity access token", ["ANTIGRAVITY_ACCESS_TOKEN"]),
			oauth: lazyOAuth({
				name: "Google Antigravity",
				isSubscription: true,
				loginLabel: "Sign in with Google (Antigravity)",
				load: loadAntigravityOAuth,
			}),
		},
		models: Object.values(ANTIGRAVITY_MODELS),
		api: antigravityApi(),
	});
}

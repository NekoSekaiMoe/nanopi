const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

/** A private IPv4 address (RFC 1918) or link-local address, which local inference servers listen on. */
function isPrivateIpv4(hostname: string): boolean {
	const parts = hostname.split(".");
	if (parts.length !== 4) return false;
	const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
	if (octets.some((octet) => Number.isNaN(octet) || octet > 255)) return false;
	const [a, b] = octets as [number, number, number, number];
	return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/**
 * The lowercase hostname of a baseUrl, or undefined when it does not parse.
 *
 * Provider detection used `baseUrl.includes("<host>")`, which also matches a
 * substring of an unrelated host (`api.openai.com.evil.tld`) or of the path
 * (`proxy/?to=api.openai.com`), so an attacker-controlled endpoint inherited
 * another provider's request shape and attribution headers.
 */
export function hostnameOf(baseUrl: string): string | undefined {
	try {
		return new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return undefined;
	}
}

/**
 * Whether a baseUrl is served by `domain`, which it must either equal or sit
 * below as a subdomain. A bare suffix test would accept `evilopenrouter.ai`.
 */
export function matchesHostname(baseUrl: string, domain: string): boolean {
	const hostname = hostnameOf(baseUrl);
	if (hostname === undefined) return false;
	const expected = domain.toLowerCase();
	return hostname === expected || hostname.endsWith(`.${expected}`);
}

/**
 * Whether a baseUrl points at a machine the operator runs themselves: a loopback
 * or private-network host (vLLM, SGLang, Ollama, LM Studio). Those servers speak
 * OpenAI-compatible HTTP without OpenAI's own request fields, so assuming the
 * OpenAI defaults sends them `store`, `reasoning_effort` and
 * `max_completion_tokens`, which several reject with HTTP 400.
 */
export function isSelfHostedEndpoint(baseUrl: string): boolean {
	const hostname = hostnameOf(baseUrl);
	return (
		hostname !== undefined &&
		(LOOPBACK_HOSTNAMES.has(hostname) || hostname.endsWith(".local") || isPrivateIpv4(hostname))
	);
}

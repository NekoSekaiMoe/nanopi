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
 * Whether a baseUrl points at a machine the operator runs themselves: a loopback
 * or private-network host (vLLM, SGLang, Ollama, LM Studio). Those servers speak
 * OpenAI-compatible HTTP without OpenAI's own request fields, so assuming the
 * OpenAI defaults sends them `store`, `reasoning_effort` and
 * `max_completion_tokens`, which several reject with HTTP 400.
 */
export function isSelfHostedEndpoint(baseUrl: string): boolean {
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return false;
	}
	return LOOPBACK_HOSTNAMES.has(hostname) || hostname.endsWith(".local") || isPrivateIpv4(hostname);
}

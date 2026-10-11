export function getNanoPiUserAgent(version: string): string {
	const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
	return `nanopi/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}

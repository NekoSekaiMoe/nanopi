export function getNanoPiUserAgent(version: string): string {
	const runtime = `node/${process.version}`;
	return `nanopi/${version} (${process.platform}; ${runtime}; ${process.arch})`;
}

/**
 * Wait for bytes already queued on stdout/stderr to reach the terminal.
 *
 * A zero-length write is appended to the stream queue, so its callback runs
 * only after earlier writes have been flushed. `process.exit()` skips that
 * queue, which can drop terminal restore sequences (cursor, bracketed paste,
 * Kitty keyboard) on the way out.
 */
export async function flushStdout(timeoutMs = 1000): Promise<void> {
	const streams = [process.stdout, process.stderr].filter((stream) => stream.writable && stream.writableLength > 0);
	if (streams.length === 0) return;

	let timer: ReturnType<typeof setTimeout> | undefined;
	let errorListeners: Array<() => void> = [];

	try {
		await Promise.race([
			Promise.all(
				streams.map(
					(stream) =>
						new Promise<void>((resolve) => {
							// A dead terminal can emit EPIPE from a pending write. Keep the
							// process-level error handler from turning shutdown into a crash.
							const onError = () => {};
							stream.on("error", onError);
							errorListeners.push(() => stream.removeListener("error", onError));
							stream.write("", () => resolve());
						}),
				),
			),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
		for (const remove of errorListeners) remove();
		errorListeners = [];
	}
}

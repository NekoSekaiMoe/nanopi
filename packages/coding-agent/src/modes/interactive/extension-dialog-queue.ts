/**
 * Serialize extension dialogs that share the editor slot.
 *
 * Opening a second dialog used to replace the first: the replaced component was removed from
 * the tree and its promise never settled, so the extension awaiting `ui.select()` or
 * `ui.confirm()` hung forever. Running dialogs one at a time keeps each promise paired with
 * the component that resolves it.
 */
export function createDialogQueue(): <T>(open: () => Promise<T>) => Promise<T> {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(open: () => Promise<T>): Promise<T> => {
		const result = tail.then(open, open);
		tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
}

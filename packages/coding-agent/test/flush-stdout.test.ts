import { afterEach, describe, expect, test, vi } from "vitest";
import { flushStdout } from "../src/utils/flush-stdout.ts";

type FakeStream = {
	writable: boolean;
	writableLength: number;
	on: ReturnType<typeof vi.fn>;
	removeListener: ReturnType<typeof vi.fn>;
	write: ReturnType<typeof vi.fn>;
};

function fakeStream(writableLength = 0): FakeStream {
	return {
		writable: true,
		writableLength,
		on: vi.fn(),
		removeListener: vi.fn(),
		write: vi.fn((_chunk: string, callback: () => void) => {
			callback();
		}),
	};
}

describe("flushStdout", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	test("skips writes when nothing is queued", async () => {
		const stdout = fakeStream();
		const stderr = fakeStream();
		vi.spyOn(process, "stdout", "get").mockReturnValue(stdout as unknown as typeof process.stdout);
		vi.spyOn(process, "stderr", "get").mockReturnValue(stderr as unknown as typeof process.stderr);

		await flushStdout();

		expect(stdout.write).not.toHaveBeenCalled();
		expect(stderr.write).not.toHaveBeenCalled();
	});

	test("queues a zero-length write and removes error listeners", async () => {
		const stdout = fakeStream(12);
		const stderr = fakeStream(3);
		vi.spyOn(process, "stdout", "get").mockReturnValue(stdout as unknown as typeof process.stdout);
		vi.spyOn(process, "stderr", "get").mockReturnValue(stderr as unknown as typeof process.stderr);

		await flushStdout();

		expect(stdout.write).toHaveBeenCalledWith("", expect.any(Function));
		expect(stderr.write).toHaveBeenCalledWith("", expect.any(Function));
		expect(stdout.removeListener).toHaveBeenCalledWith("error", expect.any(Function));
		expect(stderr.removeListener).toHaveBeenCalledWith("error", expect.any(Function));
	});

	test("returns after the timeout when a stream never finishes", async () => {
		vi.useFakeTimers();
		const stdout = fakeStream(12);
		stdout.write.mockImplementation(() => undefined);
		const stderr = fakeStream();
		vi.spyOn(process, "stdout", "get").mockReturnValue(stdout as unknown as typeof process.stdout);
		vi.spyOn(process, "stderr", "get").mockReturnValue(stderr as unknown as typeof process.stderr);

		const pending = flushStdout(50);
		await vi.advanceTimersByTimeAsync(50);
		await pending;

		expect(stdout.write).toHaveBeenCalledTimes(1);
		expect(stdout.removeListener).toHaveBeenCalledWith("error", expect.any(Function));
	});
});

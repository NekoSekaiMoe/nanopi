import { describe, expect, test } from "vitest";
import { PairingError, PairingManager } from "../src/pairing.ts";

describe("PairingManager", () => {
	test("verifies the generated code once", () => {
		const manager = new PairingManager();
		const { code } = manager.generate();
		expect(() => manager.verify(code)).not.toThrow();
		// One-time: the second use fails even with the right code.
		expect(() => manager.verify(code)).toThrow(PairingError);
	});

	test("rejects wrong codes and counts attempts", () => {
		const manager = new PairingManager(60_000, 3);
		const { code } = manager.generate();
		for (let i = 0; i < 2; i++) {
			expect(() => manager.verify("wrongcode")).toThrow(/attempts left/);
		}
		expect(() => manager.verify(code)).not.toThrow();
	});

	test("locks after too many attempts", () => {
		const manager = new PairingManager(60_000, 2);
		manager.generate();
		expect(() => manager.verify("aaaaaaaa")).toThrow(/invalid/);
		expect(() => manager.verify("aaaaaaaa")).toThrow(/too many/);
	});

	test("codes are case-insensitive and trimmed", () => {
		const manager = new PairingManager();
		const { code } = manager.generate();
		expect(() => manager.verify(`  ${code.toUpperCase()} `)).not.toThrow();
	});

	test("expired codes are rejected", () => {
		const manager = new PairingManager(1000);
		const { code } = manager.generate();
		expect(() => manager.verify(code, Date.now() + 2000)).toThrow(/expired|already used/);
	});

	test("codes use the unambiguous alphabet and fixed length", () => {
		const manager = new PairingManager();
		const { code } = manager.generate();
		expect(code).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{8}$/);
	});

	test("status reflects generation and consumption", () => {
		const manager = new PairingManager();
		expect(manager.status().active).toBe(false);
		const { code } = manager.generate();
		expect(manager.status().active).toBe(true);
		manager.verify(code);
		expect(manager.status().active).toBe(false);
	});
});

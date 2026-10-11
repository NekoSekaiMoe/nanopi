import assert from "node:assert";
import { describe, it } from "node:test";
import { GREETINGS, randomGreeting } from "./greeting.ts";

describe("randomGreeting", () => {
  it("returns a non-empty line from the pool", () => {
    assert.ok(GREETINGS.length >= 8);
    for (const line of GREETINGS) {
      assert.ok(line.trim().length > 0, `empty greeting: ${JSON.stringify(line)}`);
    }
    for (let i = 0; i < 20; i++) {
      assert.ok(GREETINGS.includes(randomGreeting()));
    }
  });
});

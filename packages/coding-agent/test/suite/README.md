# Coding agent suite tests

Use `test/suite/` for the new harness-based test suite around `AgentSession` and `AgentSessionRuntime`.

Rules:
- Use `test/suite/harness.ts`
- Use the faux provider from `packages/ai/src/providers/faux.ts`
- Do not use real provider APIs, real API keys, network calls, or paid tokens
- Keep these tests CI-safe and deterministic
- Do not use or extend the legacy `test/test-harness.ts` path unless a missing capability forces it

## Task network (`test/suite/tasks/`)

`test/suite/tasks/` holds task-level cases: a seeded workspace, a scripted faux-provider turn
sequence that calls the *real* tools, and an assertion on what those tools did to the disk. They
exist so a prompt or tool-contract change can be judged instead of argued about.

Use them when you change:

- a tool's `description` / `promptSnippet` / `promptGuidelines` (the usage contract the model reads)
- a `prepareLoadout` hook or anything else that changes what a request declares
- the system prompt sections, or how a section diff is emitted
- how a failed tool call is reported back to the model

Writing a task:

```ts
const { harness, record } = await createTaskHarness();
harnesses.push(harness); // cleanup in afterEach
seedFile(harness, "src/a.ts", "…");
harness.setResponses(recordRequests(record, [
  fauxAssistantMessage([fauxToolCall("read", { path: "src/a.ts" })], { stopReason: "toolUse" }),
  fauxAssistantMessage([fauxToolCall("edit", { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] })], { stopReason: "toolUse" }),
  fauxAssistantMessage("done"),
]));
await harness.session.prompt("Change a to b.");
expect(readWorkspaceFile(harness, "src/a.ts")).toContain("b");
```

Rules:

- Assert on what the provider received (`record.requests`) or on the disk, not on `session.systemPrompt`
  alone. A prompt that the session reports but never sends is the bug these tasks look for.
- Assert the refusal, not only the recovery: a permissive tool turns a recovery task green for the
  wrong reason.
- One task per user-shaped request. If a case needs five turns of setup, it belongs in a
  characterization test, not here.
- Never assert on a prompt's exact wording; assert that the declaration carrying it is there.

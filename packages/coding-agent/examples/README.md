# Examples

Example code for the pi-coding-agent SDK and process integration.

## CLI integration

[`rpc-client.ts`](rpc-client.ts) uses the typed `RpcClient` to run nanopi in a child process, stream events, and wait for the run to settle.

Build the coding-agent package before running it from a repository checkout:

```bash
node examples/rpc-client.ts "Explain this repository"
```

## Directories

### [sdk/](sdk/)
Programmatic usage via `createAgentSession()`. Shows how to customize models, prompts, tools, modules, and session management. [06-modules.ts](sdk/06-modules.ts) is the module example: tools and event handlers registered in code.

## Documentation

- [SDK Examples](sdk/README.md)
- [CLI Integration](../docs/cli-integration.md)
- [Modules Documentation](../docs/sdk.md#modules)
- [Skills Documentation](../docs/skills.md)

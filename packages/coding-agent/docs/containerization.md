# Run nanopi in an isolated environment

Use an isolated environment to limit the files, credentials, processes, and network services that generated commands can access or affect.

You can isolate the complete nanopi process or keep nanopi on the host and route selected tools into an isolated environment.

## Choose an isolation method

| Method | Where nanopi runs | What is isolated | Credential handling | Best for |
|---|---|---|---|---|
| Plain Docker | Container | nanopi, built-in tools, `!` commands, and modules | Credentials passed into the container | A straightforward local container boundary |
| Docker Sandboxes | Managed sandbox | nanopi, built-in tools, `!` commands, and modules | Provider credentials remain on the host and are substituted by the proxy | Managed local isolation without exposing the real provider key |
| OpenShell | Local or remote sandbox | nanopi, built-in tools, `!` commands, and modules | Policy-controlled credentials and inference routing | Filesystem, process, network, and credential policies |
| Shell sandbox (`/sandbox`) | On the host, inside `bubblewrap` or `sandbox-exec` | Commands started by the `bash` tool | The host process keeps every credential; the sandbox narrows what a command can write or reach | Blocking writes and network for shell commands without a container |

The method changes where module tools run. When the complete nanopi process runs inside an isolated environment, its module tools run there too.

## Confine shell commands without a container

`/sandbox on` wraps the `bash` tool in `bubblewrap` (Linux) or `sandbox-exec` (macOS). Only the command execution is wrapped: the model keeps the same tool description and output handling, and the host nanopi process stays outside the boundary.

```text
/sandbox on
/sandbox on --network
/sandbox on --engine bwrap --writable /tmp/build
/sandbox
/sandbox off
```

What the sandbox does:

- The working directory is writable. Everything else is read-only, except the extra roots passed with `--writable`.
- `$HOME` inside sandboxed commands is `<agentDir>/sandbox`, so a command cannot rewrite your real dotfiles or `~/.ssh`.
- Network is blocked unless the sandbox was enabled with `--network`.
- Sandboxed commands see the system's read-only roots (`/usr`, `/lib`, `/etc`, and so on), so ordinary toolchains still run.

What it does not do:

- It is not a permission prompt. Approving a call still decides whether a command runs; the sandbox only limits what it can touch afterwards. `--yolo` skips the prompt and the sandbox still applies.
- It only covers the `bash` tool. The `edit` and `write` tools write as the nanopi process, and `!` commands run outside the sandbox because they are your own input.
- macOS `sandbox-exec` filters on resolved absolute paths only, so writes through relative paths outside the working directory are not stopped. Do not treat it as equivalent to `bubblewrap`.
- It does not protect credentials that sit inside a writable root.

Settings live in `<agentDir>/extra/settings.json`, with an optional `.nanopi/extra/settings.json` project override:

```json
{
  "sandbox": {
    "engine": "bwrap",
    "allowNetwork": false,
    "writable": ["/tmp/build"]
  }
}
```

If the launcher is missing, `/sandbox on` refuses to enable it and shell commands keep running unsandboxed; nothing silently falls back once it is on. For a boundary that also covers `edit`, `write`, `!` commands, and modules, use a container or one of the methods above instead.

## Decide what nanopi can access

An isolated process can still affect resources you expose to it:

- A read-write host mount lets nanopi modify those host files.
- Mounting `~/.nanopi/agent` exposes your nanopi credentials, settings, and sessions.
- Environment variables passed into a container are available to processes inside it.
- Network access may allow code or tool output to leave the environment.
- Tool-only isolation does not constrain the host nanopi process or module tools that do not use the isolated backend.

Expose only the working folder, credentials, and network destinations needed for the task. Use read-only mounts or copy files into and out of the environment when you do not want writes to affect the host.

## Run nanopi in plain Docker

Plain Docker provides the simplest whole-process container boundary.

### Build the image

Create `Dockerfile.nanopi`:

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @nanopi/pi-coding-agent

WORKDIR /workspace
ENTRYPOINT ["nanopi"]
```

Build it from the directory containing the file:

```bash
docker build -t nanopi-sandbox -f Dockerfile.nanopi .
```

### Start nanopi

From the working folder you want nanopi to access, run:

```bash
docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v nanopi-agent-home:/root/.nanopi/agent \
  nanopi-sandbox
```

Replace `ANTHROPIC_API_KEY` with the credential required by your provider. The named `nanopi-agent-home` volume keeps container-local settings, credentials, and sessions between runs.

Do not mount the host's `~/.nanopi/agent` unless the container should have access to your host nanopi configuration and credentials.

### Verify the workspace

Inside nanopi, run:

```text
!pwd
```

The command should report `/workspace`. Changes under `/workspace` write through to the mounted host folder. Remove the bind mount or use a read-only mount when that is not acceptable.

## Run nanopi with Docker Sandboxes

[Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) runs the complete nanopi process inside a managed sandbox. Its proxy can keep the real provider credential on the host and substitute it when requests leave the sandbox.

Configure credentials before creating the sandbox. Do not run `/login` inside the sandbox because that writes a real credential into it.

### Use a Claude Pro or Max token

Generate the token with `claude setup-token` on a machine with Claude Code. If an `anthropic` secret is already configured, remove it first so the proxy does not add an API-key header alongside the bearer token:

```bash
sbx secret rm anthropic

sbx secret set-custom \
  --host api.anthropic.com \
  --env ANTHROPIC_OAUTH_TOKEN \
  --placeholder 'sk-ant-oat01-{rand}'
```

`sbx secret set-custom` reads the real token from standard input. The sandbox receives an OAuth-shaped placeholder, which the proxy replaces only for requests to the configured host.

For an Anthropic API key, use `sbx secret set anthropic` instead.

### Start nanopi

Run this from the working folder you want mounted:

```bash
sbx run --kit "docker.io/sbx/nanopi-kit:latest" nanopi
```

For an existing sandbox, run nanopi non-interactively with:

```bash
sbx exec <sandbox-name> -- nanopi -p "list the failing tests"
```

See the [nanopi kit documentation](https://github.com/docker/sbx-kits-contrib/tree/main/nanopi) for other providers, troubleshooting, and image pinning.

## Run nanopi with OpenShell

[NVIDIA OpenShell](https://docs.nvidia.com/openshell/about/overview) provides local or remote sandboxes with filesystem, process, network, credential, and inference policies.

### Select a gateway

Every sandbox requires an active gateway:

```bash
openshell gateway add <gateway-url> --name <name>
openshell gateway select <name>
```

### Create the sandbox

```bash
openshell sandbox create --name nanopi-sandbox --from nanopi -- nanopi
```

nanopi, its built-in tools, `!` commands, and module tools run inside the OpenShell boundary.

### Transfer files to a remote sandbox

A remote gateway does not bind-mount your host working folder. Clone the repository inside the sandbox or transfer files explicitly:

```bash
openshell sandbox upload nanopi-sandbox ./working-folder /workspace
openshell sandbox download nanopi-sandbox /workspace/working-folder ./working-folder-out
```

OpenShell inference routing can keep raw model credentials outside the sandbox. When configured, point nanopi at the corresponding OpenAI-compatible or Anthropic-compatible endpoint exposed by the gateway.

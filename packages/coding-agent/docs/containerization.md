# Run nanopi in an isolated environment

Use an isolated environment to limit the files, credentials, processes, and network services that generated commands can access or affect.

You can isolate the complete nanopi process or keep nanopi on the host and route selected tools into an isolated environment.

## Choose an isolation method

| Method | Where nanopi runs | What is isolated | Credential handling | Best for |
|---|---|---|---|---|
| Plain Docker | Container | nanopi, built-in tools, `!` commands, and extensions | Credentials passed into the container | A straightforward local container boundary |
| Docker Sandboxes | Managed sandbox | nanopi, built-in tools, `!` commands, and extensions | Provider credentials remain on the host and are substituted by the proxy | Managed local isolation without exposing the real provider key |
| OpenShell | Local or remote sandbox | nanopi, built-in tools, `!` commands, and extensions | Policy-controlled credentials and inference routing | Filesystem, process, network, and credential policies |
| Gondolin extension | Host | Built-in tools and `!` commands | Stored nanopi credentials remain on the host, but commands inherit host environment variables | A local micro-VM for tool execution while retaining the host interface |

The method changes where extensions run. When the complete nanopi process runs inside an isolated environment, its extensions run there too. When host nanopi delegates built-in tools through Gondolin, other extension tools still run on the host unless they also delegate their work.

## Decide what nanopi can access

An isolated process can still affect resources you expose to it:

- A read-write host mount lets nanopi modify those host files.
- Mounting `~/.nanopi/agent` exposes your nanopi credentials, settings, extensions, and sessions.
- Environment variables passed into a container are available to processes inside it.
- Network access may allow code or tool output to leave the environment.
- Tool-only isolation does not constrain the host nanopi process or extension tools that do not use the isolated backend.

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

nanopi, its built-in tools, `!` commands, and extension tools run inside the OpenShell boundary.

### Transfer files to a remote sandbox

A remote gateway does not bind-mount your host working folder. Clone the repository inside the sandbox or transfer files explicitly:

```bash
openshell sandbox upload nanopi-sandbox ./working-folder /workspace
openshell sandbox download nanopi-sandbox /workspace/working-folder ./working-folder-out
```

OpenShell inference routing can keep raw model credentials outside the sandbox. When configured, point nanopi at the corresponding OpenAI-compatible or Anthropic-compatible endpoint exposed by the gateway.

## Route tools through Gondolin

[Gondolin](https://github.com/earendil-works/gondolin) is a local Linux micro-VM. Its example extension keeps the nanopi process and file-based provider credentials on the host while routing the built-in tools and user `!` commands into the VM.

Commands inside the VM inherit the host process environment. Provider keys supplied through environment variables can therefore be visible inside the VM. Do not use this pattern as a credential boundary unless you remove sensitive variables or change the extension's environment handling.

Gondolin requires Node.js 23.6 or newer and QEMU installed through your operating-system package manager.

### Install the extension

From a nanopi source checkout:

```bash
mkdir -p ~/.nanopi/agent/extensions
cp -R packages/coding-agent/examples/extensions/gondolin ~/.nanopi/agent/extensions/gondolin
cd ~/.nanopi/agent/extensions/gondolin
npm install --ignore-scripts
```

### Start nanopi

Run nanopi from the working folder you want mounted:

```bash
cd /path/to/working-folder
nanopi -e ~/.nanopi/agent/extensions/gondolin
```

The extension mounts the host working folder at `/workspace` in the VM and overrides `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`. File changes under `/workspace` write through to the host.

Other extension tools still run on the host unless they explicitly delegate their operations. Review the [Gondolin example](../examples/extensions/gondolin/) before adding tools that could bypass the VM boundary.

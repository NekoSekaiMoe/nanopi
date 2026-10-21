# nanopi

nanopi is an extensible AI agent that works from your terminal. Give it a goal and a working folder, and it can inspect files, run commands, edit content, and work through multi-step tasks.

Use nanopi for software development, research notes, writing projects, data files, or hobby work. You can use nanopi as is, prompt it to adapt itself to your workflow, or build other applications powered by nanopi using the SDK.

## Start using nanopi

New to nanopi? Follow the [Quickstart](quickstart.md) to install nanopi, connect a model, and complete your first task.

If nanopi is already installed, choose what you want to do:

- [Use nanopi interactively](usage.md) to add files, run commands, direct ongoing work, and export results.
- [Choose a model](models.md) or connect a subscription, API key, local model, or compatible endpoint.
- [Continue or branch a session](sessions.md) to resume work or explore another approach without losing history.
- [Configure nanopi](configuration.md) for your preferences, working folders, instructions, and reusable resources.
- [Understand how nanopi works](how-nanopi-works.md), including tools, context, sessions, and the agent loop.

## Customize nanopi

nanopi can reuse prompts, load specialized instructions, add tools and commands in code, change its terminal interface, and connect model services.
Use the [Quickstart customization chooser](quickstart.md#choose-how-to-customize-nanopi) to select the smallest mechanism that meets your need: skills and prompt templates are files, while anything executable is a [module](modules.md).

## Automate or embed nanopi

- Use [print mode](cli.md#invocation-and-output) for one-off and scripted tasks.
- Use [JSON event stream mode](json.md) to consume structured events from one run.
- Use [RPC mode](rpc.md) to control a separate nanopi process.
- Use the [TypeScript SDK](sdk.md) to run nanopi inside an application.

## Find reference and setup information

Use the reference pages to look up [CLI options](cli.md), [settings](settings.md), [providers](providers.md), [keybindings](keybindings.md), and [environment variables](environment-variables.md).

For platform-specific help, see [Terminal Setup](terminal-setup.md), [Windows](windows.md), [tmux](tmux.md), [Termux on Android](termux.md), or [Containerization](containerization.md).

## Work safely

nanopi's tools and modules run with the permissions of the nanopi process. Project trust controls which project resources nanopi loads, but it does not sandbox tool calls. Review [Security](security.md) before using untrusted files, repositories, or unattended automation.

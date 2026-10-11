# nanopi Packages

nanopi packages install and distribute extensions, skills, prompt templates, and themes as one unit. Use a package when a customization should be shared through npm or git, or when several resources belong together.

A package is an ordinary directory or npm package. It can expose conventional resource directories, declare explicit paths under the `nanopi` key in `package.json`, and carry its own runtime dependencies.

## Install and manage packages

Install from npm, git, or a local path:

```bash
nanopi install npm:@example/nanopi-tools@1.0.0
nanopi install git:github.com/example/nanopi-tools@v1
nanopi install ./local-package
```

`nanopi list` shows configured packages. Use `nanopi remove <source>` to remove one. See [Command Line](cli.md#package-commands) for every package command and option.

Personal installs are written to `~/.nanopi/agent/settings.json`. Add `--local` or `-l` to write the package declaration to `.nanopi/settings.json`. nanopi reads declarations from that file only after project trust is granted.

Project packages are installed and loaded only after project trust is resolved. Packages can execute extension code and can include skills that instruct the model to run programs. Review third-party package source before installing it. Review project package declarations before granting project trust.

Use `--extension` or `-e` to try a package for one invocation without adding it to settings:

```bash
nanopi -e npm:@example/nanopi-tools
```

## Choose a source

| Source | Example | Behavior |
|---|---|---|
| npm | `npm:@example/nanopi-tools@1.0.0` | Installed under the nanopi npm directory |
| git | `git:github.com/example/nanopi-tools@v1` | Cloned and reconciled to the selected ref |
| URL | `https://github.com/example/nanopi-tools` | Treated as a git source |
| Local | `./nanopi-tools` | Loaded from the resolved path without copying |

Versioned npm specifications are pinned. Git tags and commits are also pinned; package updates reconcile the checkout but do not move a configured ref.

Relative local paths resolve from the settings file that contains them. A file path loads one extension. A directory follows normal package discovery rules.

## Create a package

The simplest package uses conventional directories:

```text
my-nanopi-package/
├── package.json
├── extensions/
├── skills/
├── prompts/
└── themes/
```

Without a `nanopi` manifest, nanopi discovers TypeScript and JavaScript extensions, skill directories, Markdown prompts, and JSON themes from those directories.

Use an explicit manifest when resources live elsewhere or need filtering:

```json
{
  "name": "my-nanopi-package",
  "keywords": ["nanopi-package"],
  "nanopi": {
    "extensions": ["./src/extension.ts"],
    "skills": ["./resources/skills"],
    "prompts": ["./resources/prompts/*.md"],
    "themes": ["./resources/themes/*.json"]
  }
}
```

Paths are relative to the package root. Arrays accept glob patterns and exclusions. List dot-prefixed or symlinked resource roots directly when traversal through a glob would not discover them.

The `nanopi-package` keyword marks an npm package as a nanopi package.

## Declare dependencies

Put runtime packages imported by extensions in `dependencies`. nanopi installs package dependencies when it installs an npm or git source.

nanopi supplies these packages to extensions and skills:

- `@nanopi/pi-ai`
- `@nanopi/pi-agent-core`
- `@nanopi/pi-coding-agent`
- `@nanopi/pi-tui`
- `typebox`

Declare the host-provided packages listed above in `peerDependencies` with a `"*"` range and do not bundle them. nanopi suppresses automatic peer installation for managed npm packages and git packages installed with npm, pnpm, or Bun. Local packages are not installed or modified, so their dependency tree remains the package author's responsibility.

Do not list host-provided packages in `dependencies`. A physical copy can bypass nanopi's extension module mapping in compiled ESM and create duplicate classes, registries, and initialization work. nanopi reports an extension warning when it detects this manifest configuration. Other nanopi packages used as dependencies must be included in the published tarball and referenced through their `node_modules` resource paths.

Installed packages load with separate module roots. Do not rely on two packages sharing one dependency instance or one package resolving another package’s undeclared dependency.

## Select package resources

The object form in settings narrows which resources load from a package:

```json
{
  "packages": [
    {
      "source": "npm:@example/nanopi-tools",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"]
    }
  ]
}
```

For each resource type:

- Omit the property to load everything allowed by the package.
- Use `[]` to load none of that type.
- Use `!pattern` to exclude glob matches.
- Use `+path` to include one exact allowed path.
- Use `-path` to exclude one exact path.

Filters narrow the package manifest. They do not expose resources that the package itself did not declare.

Run `nanopi config` to enable or disable discovered resources and nanopi's built-in extensions. It starts with personal configuration; press Tab to switch scope, or run `nanopi config --local` to start with project overrides.

## Understand scope and identity

The same package can appear in personal and project settings. A project entry normally replaces the personal entry. With `autoload: false`, the project entry instead acts as a filtering delta over the personal package.

nanopi identifies npm packages by package name, git packages by repository URL without the ref, and local packages by resolved absolute path. This prevents the same package from loading twice through equivalent declarations.

Use [Extensions](extensions.md), [Skills](skills.md), [Prompt Templates](prompt-templates.md), and [Themes](themes.md) to design each resource before packaging it.

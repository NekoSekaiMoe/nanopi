# Web Search and Page Reading

`web_search` and `read_page` give nanopi access to the open web without an account. Both ship in the `websearch` module and work on a fresh install: the default chain starts with Firecrawl's keyless channel, which allows a monthly free credit allowance with no sign-up.

## What the tools do

- `web_search` returns ranked results (title, URL, snippet) for a query.
- `read_page` returns one http(s) page as markdown, truncated at 60,000 characters.

Neither tool invents an answer. Every engine returns ranked pages, so the model reads the items for evidence; Tavily's written `answer` is passed through when the provider supplies one.

## Engine chain and failover

The chain is walked in order and the first engine that answers wins:

1. `firecrawl` — search and page fetch, keyless by default
2. `keenable` — search only, keyless by default (anonymous calls are capped per IP)
3. `tavily` — search only, needs a key
4. `exa` — search only, needs a key

Failover is automatic. A failed engine or a spent allowance moves to the next one, and the tool result names the engine that answered, so a silent downgrade cannot happen. Failures are classified:

- Auth (401/403), rate limit (429), and quota (402 or quota wording) failures are tied to the key: the engine rotates to its next key.
- Anything else — a 5xx, a timeout, a rejected request — says nothing about the key, so the chain moves to the next engine directly.

## Multiple keys per engine

`tavily`, `exa`, `firecrawl`, and `keenable` each accept a comma-separated key list. Keys are tried in order, and only auth, rate-limit, or quota failures burn one:

```json
{
  "tavily": { "apiKey": "tvly-first,tvly-second" }
}
```

## Configuration

`websearch.json` lives next to `settings.json` in the agent directory (`~/.nanopi/agent/websearch.json` by default). Every field is optional; a missing or malformed file falls back to the keyless defaults.

```json
{
  "engines": ["firecrawl", "tavily", "keenable"],
  "firecrawl": { "apiKey": "$FIRECRAWL_API_KEY" },
  "tavily": { "apiKey": "tvly-...", "baseUrl": "https://tavily.internal.example" },
  "exa": { "enabled": false },
  "timeoutMs": 20000,
  "deadlineMs": 60000
}
```

| Field | Meaning |
| --- | --- |
| `engines` | Engine order. Defaults to `firecrawl`, `keenable`, `tavily`, `exa` |
| `<engine>.apiKey` | One key, or a comma-separated list. `$VAR` references are resolved |
| `<engine>.baseUrl` | Compatible third-party or self-hosted endpoint |
| `<engine>.enabled` | `false` takes the engine out of the chain |
| `timeoutMs` | Budget for one attempt (default 20000) |
| `deadlineMs` | Budget for a whole call, failovers included (default 60000) |

### Environment variables

Used when the config file names no key for that engine:

| Engine | Variable |
| --- | --- |
| `firecrawl` | `FIRECRAWL_API_KEY` |
| `keenable` | `KEENABLE_API_KEY` |
| `tavily` | `TAVILY_API_KEY` |
| `exa` | `EXA_API_KEY` |

## Cooldown

A key that reports an exhausted quota is recorded in `websearch-state.json` next to the config and tried last on the next call, so a spent allowance is not rediscovered on every search. The file is a cache: deleting it is safe.

## Enabling the tools

`web_search` and `read_page` are `direct` tools, so a build that carries the `websearch` module activates them at session start. To keep them out of a session:

```bash
nanopi --exclude-tools web_search,read_page
```

The `minimal` and `base` build flavors leave the module out entirely.

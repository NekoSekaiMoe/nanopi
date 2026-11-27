# websearch

Keyless web search and page reading in one `web` tool:

- `web` with `action=search` — ranked results from the first engine that answers.
- `web` with `action=fetch` — one http(s) page as markdown, truncated at 60k characters.

Default engine chain: Firecrawl (keyless search + fetch), Keenable (keyless search),
then Tavily and Exa when keys are configured.

## Failover rules

| Failure | Effect |
| --- | --- |
| 401 / 403 / 429, 402, quota wording | burn the key, try the engine's next key |
| 5xx, timeout, rejected request | jump to the next engine, key untouched |
| every engine and key failed | report the full attempt trail from the tool |

Keys are comma-separated per engine and also read from
`FIRECRAWL_API_KEY`, `KEENABLE_API_KEY`, `TAVILY_API_KEY`, and `EXA_API_KEY`.

## Config

`~/.nanopi/agent/websearch.json`:

```json
{
  "engines": ["firecrawl", "keenable", "tavily", "exa"],
  "tavily": { "apiKey": "tvly-one,tvly-two" },
  "exa": { "enabled": false }
}
```

A key that reports an exhausted quota is written to
`~/.nanopi/agent/websearch-state.json` and tried last on the next call.

## Files

- `src/config.ts` — file + env layer, engine ids, defaults.
- `src/engines.ts` — one adapter per provider, plus error classification.
- `src/search.ts` — the chain: key rotation, engine failover, cooldown cache.
- `src/tools.ts` — the `web` tool and its renderer.
- `src/index.ts` — module entry.

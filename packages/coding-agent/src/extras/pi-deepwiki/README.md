# pi-deepwiki

Two tools for public GitHub repositories, backed by the hosted DeepWiki MCP endpoint:

- `deepwiki_wiki_structure` — list a repo's documentation outline.
- `deepwiki_ask_question` — ask a codebase-grounded question about one or several repos.

`/deepwiki <owner/repo> [question]` prefills the editor with the matching tool call.

Set `DEEPWIKI_MCP_URL` to override the endpoint. Public repositories need no credentials.

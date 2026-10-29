# Client API

Each provider keeps its native request and response format. Paths are relative to `PUBLIC_URL`:

| Client            | Base URL                                   |
| ----------------- | ------------------------------------------ |
| Codex             | `/providers/codex/codex/backend-api/codex` |
| OpenAI compatible | `/providers/codex/codex/v1`                |
| Claude Code       | `/providers/claude/claude`                 |

Authenticate with `Authorization: Bearer <client key>` or `x-api-key: <client key>`. **URL & setup** on each connection shows the full URLs and a client snippet.

![Codex URL and setup dialog with account pause controls, base URL and config.toml snippet](screenshots/codex-setup.png)

## Endpoints and transports

| Provider | Endpoints              | Transports                       |
| -------- | ---------------------- | -------------------------------- |
| Codex    | Responses, compact     | HTTP, SSE, WebSockets end to end |
| Claude   | Messages, count_tokens | HTTP, SSE                        |

Codex WebSockets need `supports_websockets = true` in the Codex provider config. OpenAI-compatible clients on the `/v1` URL should keep WebSocket transport off.

Every WebSocket turn rechecks the key, model, daily cap, account access, routing and subscription policy. If a key edit or routing change excludes the socket's pinned account, further turns are rejected. Reconnect to select an account under the updated policy.

Use Claude Code for Claude subscription traffic. Current Claude model IDs work through the proxy; some legacy IDs in the SDK catalog fail or are remapped by the client. See [verification](verification.md) for the tested list.

## Compression

Provider requests accept gzip and zstd bodies, with a 16 MiB limit on both the wire size and the decoded size. HTTP responses negotiate gzip or zstd through `Accept-Encoding`, including SSE with per-event flushing. Codex WebSockets negotiate permessage-deflate.

Upstream, large Codex HTTP requests are sent with zstd and large Claude Messages requests with gzip. Claude Code only compresses requests sent to Anthropic's own hostname, so with a custom base URL it sends plain JSON to the proxy and the proxy compresses the provider hop.

## Request policy

Before dispatch, the service checks the key's providers, accounts, models, expiry, pause state and daily cap. The SDK selector limits every retry to the permitted provider and accounts, so a key can never borrow credentials from another provider or a larger account pool. Daily caps reserve requests atomically.

Raw CLIProxyAPI inference and management endpoints are blocked. SDK management calls run inside the process. The only management routes exposed are the scoped [T3 Code usage hub](accounts-and-keys.md#t3-code-usage-hub) endpoints.

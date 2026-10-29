# ai-funnel

A personal dashboard and gateway for Codex, Claude subscriptions, and OpenCode Zen/Go. Each connection has its own provider URL. Shared client keys control which connections, accounts, and models your devices can use.

The agreed scope and architecture are in [PLAN.md](PLAN.md).

## Run locally

Requires Node 24 or newer and pnpm.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

Open <http://127.0.0.1:4310>. The first start writes your dashboard key to `data/admin-token`. Read that file locally and use the key to unlock the dashboard. The terminal prints the file's location, never its contents. An explicit `ADMIN_TOKEN` environment variable overrides this file.

Frontend edits update through Vite. Restart `pnpm dev` after changing the server.

The UI uses shadcn preset `b13HF9dX9O` with Base UI components. Theme, fonts, and icons are recorded in `components.json` and `src/styles.css`. The header theme control switches between light and dark and remembers the choice on each device.

## Connect your services

### Codex through codex-lb

Choose **Connect provider → Codex**, then enter your codex-lb URL and dashboard password. Supply a username or current two-factor code if your installation requires them. Passwordless upstream dashboards can leave the password empty.

The dashboard loads account identities, status, quota windows, and reset times from codex-lb. An optional codex-lb API key also loads the model catalog. The password is used during login and is never saved. The returned dashboard session is encrypted locally.

Create a shared key and choose the whole Codex pool or specific accounts. ai-funnel creates an upstream codex-lb key with those account and model restrictions. codex-lb continues to own account selection, OAuth refresh, native usage limits, and any existing token/cost policy.

To keep a key already installed on your devices, choose **API keys → Add key → Use existing Codex key**. Register its original value, select its Codex connection, then add the other provider connections you want. Its Codex access remains inherited from codex-lb. You can add narrower model restrictions at the gateway.

### Claude subscriptions through CLIProxyAPI

Connect a CLIProxyAPI server using its management key and a client API key. This adapter targets **management API v8**. Log your Claude subscription accounts into CLIProxyAPI first. That service owns login and refresh; ai-funnel never imports Claude OAuth credentials.

Use a CLIProxyAPI instance dedicated to Claude. Whole-pool access uses its normal routing. Account subsets require unique credential routing prefixes already configured in CLIProxyAPI. Accounts without a prefix cannot be selected individually. A selected subset is pinned deterministically by session ID. Availability changes fail closed instead of expanding the selection.

The usage adapter asks CLIProxyAPI to call Claude's subscription usage endpoint using its existing credential. If that lookup is unavailable, the account still appears and its quotas show **Unavailable**. Discovery success is separate from quota availability.

### OpenCode Zen and Go

Add each Zen or Go credential as a separate connection. The form supplies the upstream API base. Model discovery validates the key. Select several connections when creating a shared key to allow several credentials.

Zen and Go have their own OpenAI and Anthropic routes. There is no automatic switch between them or to another provider. A verified balance/reset API is not implemented, so those limits remain **Quota not reported** with a link to OpenCode Console.

## Configure devices

Choose **URL & setup** in Connections for complete URLs and copyable client configuration. Set `AI_FUNNEL_KEY` on the device to a shared key allowed on that connection.

For a host `https://funnel.example.ts.net`, the route bases are:

| Provider | Client base | Native requests |
| --- | --- | --- |
| Codex | `/providers/codex/<id>/backend-api/codex` | Responses, compact, models |
| Codex compatible | `/providers/codex/<id>/v1` | Responses, compact, models, usage |
| Claude Code | `/providers/claude/<id>` | `/v1/messages`, `/v1/messages/count_tokens`, `/v1/models` |
| Zen OpenAI | `/providers/zen/<id>/openai/v1` | Responses, chat completions, models |
| Zen Anthropic | `/providers/zen/<id>/anthropic/v1` | Messages, count tokens, models |
| Go OpenAI | `/providers/go/<id>/openai/v1` | Responses, chat completions, models |
| Go Anthropic | `/providers/go/<id>/anthropic/v1` | Messages, count tokens, models |

API authentication accepts `Authorization: Bearer <shared-key>` or `x-api-key: <shared-key>`. Provider URLs never contain secrets. Request and response schemas remain owned by each provider, including native upstream errors and SSE. Scoped Claude requests change only the model's routing prefix.

Codex configuration uses `wire_api = "responses"`, `requires_openai_auth = false`, and `supports_websockets = false`. This version supports HTTP and SSE. WebSocket upgrades return HTTP 426. Codex-compatible Chat Completions and unrelated provider paths are not exposed.

Keys can be paused, resumed, or removed. Set account/model access, expiration, and an optional shared daily request limit when creating a key. To change a grant, create a replacement key. Daily request caps count forwarded requests across all providers, including failed upstream attempts and model discovery. They reset at midnight UTC. Requests rejected locally do not consume the cap.

Removing a key revokes its ai-funnel access. Direct use of an existing codex-lb key remains unchanged. Generated upstream codex-lb keys also remain in codex-lb and can be removed there if no longer needed.

## Run inside your tailnet

Build and run the production server on loopback:

```sh
pnpm build
pnpm start
```

Configure Tailscale Serve to forward your private HTTPS hostname to `http://127.0.0.1:4310`. Keep access restricted to your tailnet. ai-funnel does not configure Tailscale or infer who is allowed to reach it.

Set `PUBLIC_URL` in `.env` to that exact HTTPS origin and restart the process. It supplies generated client snippets, the expected dashboard origin for mutations, and secure session cookies. Upstream URLs must be reachable from the server that runs ai-funnel. A remote machine's loopback address refers to that machine.

Use a process supervisor to restart the server after reboots. A container option is included:

```sh
docker compose up --build -d
```

The compose file publishes port 4310 on loopback and stores state in a named volume. Set `PUBLIC_URL` in `.env` before starting it. Get the generated dashboard key locally with:

```sh
docker compose exec ai-funnel cat /app/data/admin-token
```

## Storage and refresh

`data/funnel.sqlite` stores encrypted connections, cached accounts, key policy, and private upstream credentials. `data/master.key` encrypts those records with AES-256-GCM. Generated client key values are shown once, then only their SHA-256 hashes remain. Registered Codex keys must also be retained encrypted because they are forwarded to codex-lb.

Back up the entire data directory together, including the master key and dashboard token. Stop the server while copying SQLite files. Losing the master key makes the stored connections unreadable. Do not commit this directory or expose it through a file server.

Provider metadata refreshes every two minutes. The dashboard reads cached state every 30 seconds. **Refresh** forces a provider read. A connection error preserves cached data, labels it as stale, and pauses automatic refresh until a manual retry or reconnect succeeds. Quota values are provider reports, not a local spending estimate. Unavailable values are never shown as zero.

Activity keeps the latest 2,000 forwarded-request records and displays the most recent 100. Records contain connection, key, model, status, time, and duration. Prompts, response bodies, and credentials are not logged. The dashboard uses seven-day HTTP-only sessions and rejects cross-origin mutations.

## Verify changes

```sh
pnpm build
pnpm test
pnpm exec playwright install chromium
pnpm test:ui
```

Gateway tests use controlled upstream servers to check policy enforcement, credential boundaries, native payloads, SSE, cancellation, and encrypted persistence. Browser tests exercise connection setup, account selection, shared key creation, pausing, reload persistence, mobile layout, reduced motion, and dialog keyboard focus.

The existing codex-lb pool is connected and live-verified. Native model discovery and one complete streaming Responses request passed. See [docs/live-codex.md](docs/live-codex.md) for this local setup. Claude and OpenCode still need live verification. See [docs/verification.md](docs/verification.md) for the inspected UI states and remaining verification boundaries.

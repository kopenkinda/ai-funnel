# ai-funnel

One personal service for Codex and Claude subscriptions. The Go backend embeds [CLIProxyAPI v8.0.47](https://github.com/router-for-me/CLIProxyAPI/tree/v8.0.47) and serves the React dashboard. Codex and Claude accounts log in directly here. You do not need separate codex-lb or CLIProxyAPI deployments.

## Run

For private hosting, see [the Coolify and Tailscale deployment setup](docs/deployment.md).

Build with Go 1.27.3+, Node 24+, and pnpm:

```sh
pnpm install --frozen-lockfile
cp .env.example .env
pnpm build
pnpm start
```

Open <http://127.0.0.1:4310>. Read the dashboard key locally from `DATA_DIR/admin-token`. The default directory is `data/embedded`. An explicit `ADMIN_TOKEN` overrides that file. The service reads `.env` on startup and prints the key's location, never its value.

`pnpm dev` builds the frontend and runs the Go backend. Run `pnpm build:ui` after frontend edits, then refresh the page. Restart after Go changes. Production needs only `bin/ai-funnel`, `dist`, and its data directory. Node is a build tool, not a production backend.

## Add accounts

Choose **Connect provider**, select Codex or Claude, then choose an account source:

- **OAuth** opens the provider's sign-in. If it ends at an unreachable localhost page, paste that complete callback URL into the dashboard.
- **Auth token** accepts an OAuth access token or Claude setup token. Codex normally reads the account ID from the token; you can enter it when needed. A token without refresh credentials works until it expires, then needs replacing.
- **JSON file** imports Codex's `~/.codex/auth.json`, a flat CLIProxyAPI credential file, or Claude Code's `.credentials.json`. Refresh tokens and expiry are retained. Subscription credentials are supported; API-key-only Codex files are rejected.

Imports go directly into the encrypted store and become available without restarting. Re-importing a recognized account retains its ID, key assignments, and pause state. The app does not modify your source file or save a plaintext copy. Token validity is checked by provider requests, not by merely parsing the file.

Use **Connections → Add account** for additional subscription accounts. **URL & setup** lists all accounts, lets you pause or resume each one, and supplies the provider URL and client configuration. **Refresh** reads quotas from each provider; background reads run every two minutes. Unavailable quotas remain unknown, and a failed read retains the previous value with its timestamp. The dashboard refreshes cached metadata every 30 seconds.

Start these accounts from scratch. There is no codex-lb migration or account import from the former companion backend. Existing services and their files are left untouched. The Go backend does not read the old SQLite database.

## API key access

Use the edit action under **API keys** to change a key's name, providers, accounts, models, request cap or expiration. The key value and usage history stay the same. Changes apply to subsequent requests and WebSocket turns.

**Codex → Subscription only** uses accounts while their live subscription windows have allowance remaining, including accounts with purchased credits. Funnel checks before each execution, retry, and WebSocket turn, skips exhausted or unverifiable accounts, and returns 429 when none are eligible. Other keys keep their existing access. Requests already in flight and delayed provider usage reporting can spend some purchased credits near the limit. This is a subscription cutoff, not a hard credit spending cap.

**Archive** revokes a key's access and keeps its settings and lifetime usage. Find it under **Archived** to restore it. Restored keys stay paused until enabled.

Account rows show plan multipliers and exceptional statuses. **Use reset** redeems the displayed banked credit, with its expiry shown underneath. Manual use works independently of automatic resets for both Codex and Claude.

Model access uses the same provider catalog as native model discovery. Keep **All models** enabled for unrestricted model access, including future models. Disable it to select models from the searchable picker. Selected models appear above the picker and can be removed individually.

## Usage and request logs

Usage graphs show token totals and estimated API-equivalent cost for Today, 7d, 30d, 90d, the past year or All time. Both graphs share the selected period and split uncached input, cache reads, cache writes, output and reasoning on hover. Dates use UTC, with hourly points for Today and monthly points for longer histories. The backend uses the SDK's non-overlapping token accounting. Daily aggregates persist independently of the 10,000 retained request records; recent hourly aggregates retain two days. Existing request metadata supplies hourly history on the first upgrade.

Prices are versioned with each request, using the [OpenAI](https://developers.openai.com/api/docs/pricing) and [Claude](https://platform.claude.com/docs/en/about-claude/pricing) public API tables verified on 29 October 2026. Long-context and supported service-tier rates apply. Unknown models or unclassified usage remain unpriced. Cache-write retention is not available in the SDK usage record, so those estimates span the published short- and long-retention prices. These estimates exclude subscription fees and separate tool charges.

Activity supports search, provider/account/key/model/status/transport filters, pagination and request details. Records include account, model, client and upstream transport, latency, TTFT, output speed, tokens and cost. Prompts, response text, raw upstream errors and bearer credentials are not persisted.

**Settings → Use expiring banked resets** enables Codex and Claude redemption during a credit's final five minutes. It defaults off and persists on the server. The scheduler checks every 15 seconds while the service runs, refreshes credit status before redemption, and retries temporary failures or `nothing_to_reset` every 30 seconds until expiry. Claude grants must be usable; grants without an expiry are displayed but never automatically redeemed. Codex uses T3 Code's deterministic request ID. Claude persists one request ID per redemption, reuses it for unconfirmed requests after restarts, and waits for a confirmed count decrease before using another reset from the same grant. Successful redemptions clear the account's local cooldown. Counts and expiry details are available from the banked-reset badge.

## T3 Code usage hub

In **Settings**, generate a hub key. Add a CLIProxyAPI hub in T3 Code with the service's root URL and that management key. Replacing the key invalidates the previous one. The hub exposes `/v0/management/auth-files` and a scoped `/v0/management/api-call` for official Codex/Claude usage endpoints and Codex reset-credit operations. It does not expose raw SDK management, credentials or arbitrary outbound requests.

## Device keys and provider URLs

Create a shared key and select its providers, accounts, and models. You can also register an existing device key value and assign its access here. No restrictions are inherited from another service. Key values are shown once and stored as SHA-256 hashes.

Each provider keeps its own request and response shape:

| Provider         | Base URL                                   |
| ---------------- | ------------------------------------------ |
| Codex            | `/providers/codex/codex/backend-api/codex` |
| Codex compatible | `/providers/codex/codex/v1`                |
| Claude Code      | `/providers/claude/claude`                 |

Use `Authorization: Bearer <shared-key>` or `x-api-key: <shared-key>`. Copy the complete URLs from **URL & setup**. Codex supports Responses and compact; Claude supports Messages and count_tokens. HTTP and SSE are supported. Codex supports end-to-end WebSockets with `supports_websockets = true`. Each WebSocket turn rechecks key, model and daily-limit policies. Changing account assignments requires a reconnect.

Provider requests accept gzip and zstd, with a 16 MiB limit on both wire and decoded bodies. HTTP responses negotiate gzip or zstd through `Accept-Encoding`, including SSE with per-event flushing. Codex WebSockets negotiate permessage-deflate separately. Large upstream Codex HTTP requests use zstd; large Claude Messages requests use gzip. Claude Code currently compresses requests only for Anthropic's hostname, so a custom base URL sends plain JSON to the proxy and the proxy compresses the provider hop. Client configuration files are not modified.

Use Claude Code for Claude subscription traffic. Set `ANTHROPIC_BASE_URL` to the Claude Code base URL above and `ANTHROPIC_AUTH_TOKEN` to your shared client key. Live greeting checks were run with the actual Claude Code CLI through this proxy. Current model IDs worked; the SDK catalog also lists legacy IDs that fail or are remapped by the client. See [the verification results](docs/verification.md).

The app enforces provider, account, model, expiry, pause, and daily request policies before dispatch. The SDK selector filters every retry to the permitted provider and accounts. It cannot borrow credentials from a different provider or a larger account pool. Daily caps reserve authenticated provider requests atomically, including model discovery and failed attempts, and reset at midnight UTC. Raw SDK inference and management endpoints are blocked. SDK management calls run inside the process.

## Storage and deployment

`DATA_DIR/state.enc` contains AES-256-GCM encrypted credentials, account state, key policies, quota snapshots, sessions, and request metadata. `master.key` decrypts it. The SDK uses this encrypted store for login and token refresh; persistent plaintext credential files are not created. Temporary OAuth callback files are kept in the private `oauth-sessions` directory and consumed by the SDK. Files use owner-only permissions. One process can hold a data directory at a time.

Back up the whole data directory while the service is stopped. Losing the master key makes the stored state unreadable. Activity retains 10,000 request metadata records with 50 per page. Lifetime cost and token totals per API key persist independently of those logs. Upgrading backfills the retained request history; older evicted logs cannot be attributed to keys retroactively. Prompts and response bodies are not stored in activity. Dashboard sessions use HTTP-only cookies, and mutations reject foreign origins.

Set `PUBLIC_URL` to the canonical HTTPS origin. For private access, keep the service bound to loopback and forward your Tailscale Serve hostname to port 4310. Public HTTPS through Coolify can run alongside it; set `DASHBOARD_ORIGINS` to the private origin to retain both dashboards. See [deployment configuration](docs/deployment.md). A container also runs a single Go process:

```sh
docker compose up --build -d
```

The compose file publishes loopback port 4310 and keeps state in a named volume. Do not run two services against the same data directory. Runtime data, environment files, and local installation notes are excluded from Git and Docker build contexts.

## Checks

```sh
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:ui
```

`pnpm format` runs Prettier and gofmt. `pnpm lint:fix` applies safe Oxlint fixes. The local `project/no-em-dash` rule rejects literal em dashes in JS/TS/TSX, including comments and UI text. Imported skills and provider logo assets keep their original formatting.

Backend tests run the embedded SDK with controlled executors and isolated state. They check authentication, account selection, native Responses and Messages, streaming, quotas, concurrent limits, and encrypted persistence. They do not prove live provider login or token refresh. Those require signing in to real accounts. See [docs/verification.md](docs/verification.md).

The UI retains shadcn preset `b13HF9dX9O`. Provider SVG sources and licenses are listed in [public/providers/SOURCES.md](public/providers/SOURCES.md). CLIProxyAPI's license is in [LICENSES/CLIProxyAPI.txt](LICENSES/CLIProxyAPI.txt).

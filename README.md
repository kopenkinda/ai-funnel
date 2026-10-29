# ai-funnel

One personal service for Codex, Claude subscriptions, and OpenCode Zen/Go. The Go backend embeds [CLIProxyAPI v8.0.47](https://github.com/router-for-me/CLIProxyAPI/tree/v8.0.47) and serves the React dashboard. Codex and Claude accounts log in directly here. You do not need separate codex-lb or CLIProxyAPI deployments.

## Run

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

For OpenCode, add a Zen or Go key directly. Each credential is a separate connection. Model discovery loads the available choices; credential validity is confirmed by the first inference request. Routing follows the current [OpenCode inference API](https://opencode.ai/v2/docs/console/api/inference/). Balance and reset reporting is not implemented for Zen/Go; use OpenCode Console for billing details.

## Device keys and provider URLs

Create a shared key and select its providers, accounts, and models. You can also register an existing device key value and assign its access here. No restrictions are inherited from another service. Key values are shown once and stored as SHA-256 hashes.

Each provider keeps its own request and response shape:

| Provider         | Base URL                                                      |
| ---------------- | ------------------------------------------------------------- |
| Codex            | `/providers/codex/codex/backend-api/codex`                    |
| Codex compatible | `/providers/codex/codex/v1`                                   |
| Claude Code      | `/providers/claude/claude`                                    |
| Zen              | `/providers/zen/<connection-id>/openai/v1` or `/anthropic/v1` |
| Go               | `/providers/go/<connection-id>/openai/v1` or `/anthropic/v1`  |

Use `Authorization: Bearer <shared-key>` or `x-api-key: <shared-key>`. Copy the complete URLs from **URL & setup**. Codex supports Responses and compact; Claude supports Messages and count_tokens. HTTP and SSE are supported. Codex configuration sets `supports_websockets = false`.

Use Claude Code for Claude subscription traffic. Set `ANTHROPIC_BASE_URL` to the Claude Code base URL above and `ANTHROPIC_AUTH_TOKEN` to your shared client key. Live greeting checks were run with the actual Claude Code CLI through this proxy. Current model IDs worked; the SDK catalog also lists legacy IDs that fail or are remapped by the client. See [the verification results](docs/verification.md).

The app enforces provider, account, model, expiry, pause, and daily request policies before dispatch. The SDK selector filters every retry to the permitted provider and accounts. It cannot borrow credentials from a different provider or a larger account pool. Daily caps reserve authenticated provider requests atomically, including model discovery and failed attempts, and reset at midnight UTC. Raw SDK inference and management endpoints are blocked. SDK management calls run inside the process.

## Storage and deployment

`DATA_DIR/state.enc` contains AES-256-GCM encrypted credentials, account state, key policies, quota snapshots, sessions, and request metadata. `master.key` decrypts it. The SDK uses this encrypted store for login and token refresh; persistent plaintext credential files are not created. Temporary OAuth callback files are kept in the private `oauth-sessions` directory and consumed by the SDK. Files use owner-only permissions. One process can hold a data directory at a time.

Back up the whole data directory while the service is stopped. Losing the master key makes the stored state unreadable. Activity retains 2,000 request metadata records and displays the most recent 100. Prompts and response bodies are not stored in activity. Dashboard sessions use HTTP-only cookies, and mutations reject foreign origins.

Set `PUBLIC_URL` to the exact HTTPS origin provided by Tailscale Serve. Keep the service bound to loopback and forward your private tailnet hostname to port 4310. A container also runs a single Go process:

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

The UI retains shadcn preset `b13HF9dX9O`. Provider SVGs come from [SVGL](https://github.com/pheralb/svgl/tree/main/static/library); its license is included beside the assets. CLIProxyAPI's license is in [LICENSES/CLIProxyAPI.txt](LICENSES/CLIProxyAPI.txt).

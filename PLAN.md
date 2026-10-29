# ai-funnel plan

## Purpose

One personal account pool available across the owner's devices inside a tailnet. Existing codex-lb installations own Codex accounts. Add Claude subscription accounts through CLIProxyAPI and OpenCode Zen/Go credentials. No teams, billing portal, or public account sharing.

## Agreed behavior

- Separate provider URLs preserve native APIs, errors, tool calls, and streaming. Sharing a host does not imply a common response schema.
- Codex uses codex-lb. Claude uses CLIProxyAPI's Messages API. Zen and Go expose separate OpenAI and Anthropic routes.
- One dashboard lists connections, every discovered account, available quota windows, reset times, and freshness. Unknown quota stays unknown. Never add unrelated provider allowances together.
- Shared client keys authorize selected connections, accounts, and models. Existing Codex keys can be registered without changing the key on devices. codex-lb continues to enforce its original restrictions on Codex traffic.
- Credentials stay on the server. Existing services own OAuth and refresh. No copying refresh tokens between services.
- Provider selection is explicit. No silent switches to a different provider or paid balance.

## Implementation

Build a small companion application in this repository. Node 24, TypeScript, SQLite, React, and Vite. Use Node's HTTP and SQLite implementations; avoid a second web framework or ORM. Persist encrypted connection credentials, hashed client keys, grants, cached account metadata, and request metadata. Never store prompts or response content in request logs.

Provider bases:

- `/providers/codex/:connectionId/backend-api/codex` for native Codex HTTP routes.
- `/providers/codex/:connectionId/v1` for codex-lb's compatible API.
- `/providers/claude/:connectionId/v1` for Claude Messages.
- `/providers/zen/:connectionId/openai/v1` and `/providers/zen/:connectionId/anthropic/v1`.
- `/providers/go/:connectionId/openai/v1` and `/providers/go/:connectionId/anthropic/v1`.

The connection ID makes selecting an upstream unambiguous when several Zen/Go credentials or servers are connected. The dashboard supplies complete URLs and client snippets.

Account boundaries:

- Codex account selection is enforced by a dedicated upstream scoped key created through codex-lb. Registered existing keys retain their upstream policy. A gateway restriction never broadens it.
- Claude account subsets require unique configured CLIProxyAPI credential prefixes. Refuse unsupported subsets instead of silently routing through the whole pool. Full-pool routing remains with CLIProxyAPI.
- A Zen/Go connection represents one credential. Select connections to select accounts.
- Shared daily request caps and expiration apply at this gateway. Codex token/cost limits remain owned by codex-lb. Unified token/cost budgets are a later addition, not a claim of the first release.

## Frontend design

An account inventory for checking which account can serve work and when its allowance returns. Left-aligned, with a top navbar, provider filters, and readable account rows. Quota bars are the characteristic visual element. No decorative activity charts or invented usage.

Use shadcn preset `b13HF9dX9O`, requested on 29 October 2026. It selects Luma, zinc neutrals, sky accents, Hugeicons, Space Grotesk body text, and Nunito Sans headings. Use the generated theme tokens and component variants in light and dark themes. Tabular figures make quotas easier to compare. Reserve monospace for copyable configuration.

```
Account pool / Connections / API keys / Activity       Theme / Lock
Account pool                                     Connect provider
Codex / Claude / Zen / Go filters
Account            Short window     Long window
identity + status  remaining/reset  remaining/reset
```

Use a top navbar for Account pool, Connections, API keys, and Activity. Keep theme and lock controls at its right edge. On narrow screens, navigation wraps and account rows stack with quota windows side by side. There is no sidebar or navigation drawer. Keep provider filters, grouped account tables, and an upcoming resets panel. Use shadcn fields, dialogs, buttons, and confirmation dialogs throughout. The login is a single compact card. Show every reported quota window and keep unknown allowances distinct from zero. Respect reduced motion and keyboard focus.

Keep the dashboard focused on account data and actions. Omit the logo and product name, workspace labels, profile initials, privacy badges, setup notes, promotional copy, repeated page titles, and branded footers. Keep connection-specific setup available from each connection.

## Delivery sequence

1. Persistent connections, native proxying, shared key policies, and real upstream adapters.
2. Dashboard with connection setup, account filters, quota/reset display, key creation/import/revocation, connection details, and request activity.
3. Tests using controlled upstream servers for authentication, account isolation, native payloads, errors, streaming, cancellation, and credential handling. Browser checks for core dashboard flows and responsive layout.
4. Document deployment behind Tailscale Serve, backup requirements, known protocol gaps, and how to connect the live services.

## Verification boundaries

Live credentials are not available in the repository. Test adapters against representative upstream responses and record that live account compatibility still needs verification. Sample data is an explicitly labeled frontend-only preview; it never populates live connections or keys.

Initial transport is HTTP with SSE. WebSocket upgrade support must be added and tested before claiming native Codex WebSocket parity. Clients can use the HTTP transport in the meantime. Native paths are allowlisted; management paths cannot be reached with a client key.

## References

- [codex-lb account response](https://github.com/Soju06/codex-lb/blob/main/app/modules/accounts/schemas.py)
- [codex-lb API keys](https://soju06.github.io/codex-lb/api-keys/)
- [CLIProxyAPI management v8](https://help.router-for.me/management/apiv8)
- [OpenCode inference formats](https://opencode.ai/v2/docs/console/api/inference/)

## Progress

- Companion gateway and responsive dashboard implemented.
- Production build, 12 gateway tests, 3 browser flows, and container smoke checks passed.
- Shared browser and desktop/mobile screenshots reviewed. UI findings were fixed.
- Deployment, key behavior, backups, transport limits, and verification boundaries documented in README.md and docs/verification.md.
- Existing codex-lb pool connected and live-verified. Claude, Zen/Go, and tailnet deployment remain the next operational steps.

# ai-funnel plan

## Scope

A personal account pool shared across the owner's devices inside a tailnet. One Go service embeds CLIProxyAPI and serves the existing React dashboard. Codex and Claude subscription accounts log in directly to this service. Additional providers are deferred.

The owner selected the embedded Go service on 29 October 2026 and removed the codex-lb migration requirement. Start with empty local pools. Leave the existing codex-lb service and its account files untouched. Do not import the old companion database or imply its account restrictions carry over.

## Required behavior

- Separate provider URLs preserve native formats, errors, tool calls, and HTTP streaming. No silent cross-provider fallback.
- Account selection, model access, key expiry, pause, and request caps are owned by this service. Every SDK selection and retry remains within the key's provider and account grant.
- OAuth login and refresh are handled by the embedded CLIProxyAPI SDK, pinned to v8.0.47. Credentials persist in an encrypted local store.
- Raw SDK management and inference routes are unavailable externally. Dashboard authentication is separate from device API keys.
- Display provider-reported quota windows, percentages, reset times, and freshness. Keep unknown distinct from exhausted. Do not combine allowances across providers.
- Shared keys can select whole pools or specific accounts. Existing device key strings can be registered with newly selected local permissions.
- No teams, billing portal, or public account sharing.

## Frontend

Keep the completed first design pass: shadcn preset `b13HF9dX9O`, top navbar, light/dark themes, local provider logos, compact usage bars, account details on hover, and dense provider-grouped account tables. Omit workspace branding, badges, demo data, and setup notes.

Account setup offers OAuth, a subscription auth token, or JSON credential import for Codex and Claude. Normalize native Codex auth.json, flat CLIProxyAPI credentials, and Claude Code credential JSON into encrypted account records. Preserve refresh credentials, existing account assignments, and pause state on re-import. Support pasting the localhost callback URL when signing in from a different device. Keep account pause/resume and client configuration in connection details. Unknown accounts are omitted from usage charts and tables, while account access controls still list them.

## Verification

Use isolated encrypted state and controlled SDK executors to test routing, streaming, provider/account isolation, revocation, concurrency, and persistence. Browser checks cover authenticated setup, keys, direct sign-in controls, persistence, and narrow layout. Build and smoke-test the single-process container.

Live quota reads, a Codex Responses probe, and Claude Code greeting requests through the proxy have been verified locally. Claude subscription smoke tests use the actual Claude Code client. Record legacy model failures and client remapping separately from exact-model successes. Browser-based OAuth completion, real token refresh, and tailnet deployment still require operational verification. Do not claim that mocked requests prove those behaviors. Codex supports HTTP/SSE and WebSockets, verified with the native CLI. Claude Code uses HTTP/SSE.

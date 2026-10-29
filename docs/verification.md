# Verification

The backend now embeds CLIProxyAPI v8.0.47 in Go. The React design is retained. The previous Node companion backend and its external-service adapters have been removed. No live accounts or data were migrated.

The Go integration test boots the real embedded SDK with isolated encrypted state and controlled provider executors. It checks dashboard authentication, foreign-origin rejection, blocked raw SDK routes, model discovery, native Codex Responses and Claude Messages, streaming, account restrictions, paused/deleted assignments, cross-provider rejection, concurrent daily limits, quota normalization, and encrypted persistence.

The Oxlint CLI tests check that the custom punctuation rule loads and rejects literal em dashes in comments, strings, templates, and JSX.

A focused storage test checks that the SDK's initial OAuth token-storage object survives an encrypted round trip, including its refresh token. OpenCode forwarding checks preserve the native API path, session header, and SSE response while replacing device credentials and stripping cookies.

Credential-import tests cover native Codex auth.json, Codex JWT identity extraction, flat CLIProxyAPI JSON, Claude Code credential JSON, and pasted Claude setup tokens. The embedded test checks immediate model activation and inference with a controlled executor, encrypted refresh-token persistence, re-import identity and pause preservation, and wrong-provider rejection. No live credential file is used.

Playwright checks dashboard login, account-source choices, invalid-file feedback, Codex auth.json upload into the real backend, additional account access, key creation, reload persistence, and the narrow login layout. A third check covers model-scoped usage, hidden unavailable windows, exhausted allowances, and the banked-reset hover details. The quota request after its fixture import is intercepted. It does not automate a real provider login.

Local build, lint, formatting, Go tests with the race detector, Oxlint tests, source secret scanning, and all three Playwright checks passed. Focused quota tests cover Claude's newer scoped limits with null model IDs, legacy fields, Codex weekly-only accounts, additional pools, relative reset times, and banked-reset counts.

The full multi-stage Docker build failed twice during dependency downloads with unexpected EOF errors. A Linux binary compiled locally was checked in the same runtime stage, which started as one Go process and preserved encrypted state after restart. The full Dockerfile dependency-install stages remain unverified in this environment.

Live quota reads now report Claude's session, weekly, and Fable weekly windows and Codex's weekly allowance and banked resets. Missing windows do not produce usage cards. The owner also completed a live Codex Responses probe through the new service.

On 29 October 2026, the installed Claude Code 2.1.311 client sent `Hi` for every one of the 19 advertised Claude model IDs through the local `/providers/claude/claude` base URL. The tests used Claude Code's default system prompt, disabled tools and customizations, isolated temporary settings, and a temporary shared client key. Proxy activity confirmed the model requests. The key was deleted afterward; credentials and raw client output are not included in this repository.

All 14 current model IDs returned a greeting: Fable 5 and 5.1; Haiku 4.5 and 5.5; Opus 4.5, 4.6, 4.7, 4.8, 5, and 5.5; Sonnet 4.5, 4.6, 5, and 5.5. Two legacy requests, Opus 4 and 4.1, were remapped by Claude Code to Opus 5.5 before reaching the proxy. Three legacy IDs failed: `claude-3-5-haiku-20241022`, `claude-3-7-sonnet-20250219`, and `claude-sonnet-4-20250514`. The proxy returned 503 with the upstream model-not-found error retained in the SDK's cooldown state. These five legacy IDs remain in the SDK model catalog; they are [retired by Anthropic](https://platform.claude.com/docs/en/about-claude/model-deprecations). This is not a claim that all advertised IDs work unchanged.

Browser-based OAuth completion, real credential rotation, OpenCode credentials, and tailnet deployment still need operational verification. The old codex-lb verification does not establish compatibility for this new backend.

The initial transport is HTTP/SSE. Clients must disable Codex WebSockets. Unknown quotas remain unknown; a failed refresh preserves the last snapshot and timestamp. OpenCode balance/reset reporting is not implemented.

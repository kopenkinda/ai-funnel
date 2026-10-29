# Verification

The backend now embeds CLIProxyAPI v8.0.47 in Go. The React design is retained. The previous Node companion backend and its external-service adapters have been removed. The home deployment uses the local service's encrypted state; no codex-lb migration was needed.

The Go integration test boots the real embedded SDK with isolated encrypted state and controlled provider executors. It checks dashboard authentication, foreign-origin rejection, blocked raw SDK routes, model discovery, native Codex Responses and Claude Messages, streaming, account restrictions, paused/deleted assignments, cross-provider rejection, concurrent daily limits, quota normalization, and encrypted persistence.

The Oxlint CLI tests check that the custom punctuation rule loads and rejects literal em dashes in comments, strings, templates, and JSX.

A focused storage test checks that the SDK's initial OAuth token-storage object survives an encrypted round trip, including its refresh token.

Credential-import tests cover native Codex auth.json, Codex JWT identity extraction, flat CLIProxyAPI JSON, Claude Code credential JSON, and pasted Claude setup tokens. The embedded test checks immediate model activation and inference with a controlled executor, encrypted refresh-token persistence, re-import identity and pause preservation, and wrong-provider rejection. No live credential file is used.

Playwright checks dashboard login, account-source choices, invalid-file feedback, Codex auth.json upload into the real backend, additional account access, key creation, reload persistence, and the narrow login layout. Quota checks cover model-scoped usage, hidden unavailable windows, exhausted allowances, and the banked-reset hover details. The quota request after its fixture import is intercepted. It does not automate a real provider login.

Local build, lint, formatting, Go tests with the race detector, Oxlint tests, source secret scanning, and all five Playwright checks passed. Focused quota tests cover Claude's newer scoped limits with null model IDs, legacy fields, Codex weekly-only accounts, additional pools, relative reset times, and banked-reset counts.

The full multi-stage Docker build passed on the home server in Coolify, including dependency downloads and the Go build. Earlier local Docker builds failed during dependency downloads with unexpected EOF errors. The production container runs one Go process and preserves encrypted state in a named volume across deployments.

Live quota reads now report Claude's session, weekly, and Fable weekly windows and Codex's weekly allowance and banked resets. Missing windows do not produce usage cards. The owner also completed a live Codex Responses probe through the new service.

On 29 October 2026, the installed Claude Code 2.1.311 client sent `Hi` for every one of the 19 advertised Claude model IDs through the local `/providers/claude/claude` base URL. The tests used Claude Code's default system prompt, disabled tools and customizations, isolated temporary settings, and a temporary shared client key. Proxy activity confirmed the model requests. The key was deleted afterward; credentials and raw client output are not included in this repository.

All 14 current model IDs returned a greeting: Fable 5 and 5.1; Haiku 4.5 and 5.5; Opus 4.5, 4.6, 4.7, 4.8, 5, and 5.5; Sonnet 4.5, 4.6, 5, and 5.5. Two legacy requests, Opus 4 and 4.1, were remapped by Claude Code to Opus 5.5 before reaching the proxy. Three legacy IDs failed: `claude-3-5-haiku-20241022`, `claude-3-7-sonnet-20250219`, and `claude-sonnet-4-20250514`. The proxy returned 503 with the upstream model-not-found error retained in the SDK's cooldown state. These five legacy IDs remain in the SDK model catalog; they are [retired by Anthropic](https://platform.claude.com/docs/en/about-claude/model-deprecations). This is not a claim that all advertised IDs work unchanged.

Browser-based OAuth completion and real credential rotation still need operational verification. The old codex-lb verification does not establish compatibility for this new backend.

Codex supports HTTP/SSE and WebSockets. Claude Code uses native Messages HTTP/SSE. Unknown quotas remain unknown; a failed refresh preserves the last snapshot and timestamp.

The usage hub was checked against T3 Code's installed client contract. Tests cover its inventory schema, usage-call envelope, rejection of arbitrary URLs and isolation from dashboard administration. Reset scheduling tests use controlled providers and verify the opt-in default, five-minute expiry window, retry throttling, Codex's deterministic redemption IDs and restart deduplication. Claude's grant discovery and redemption contract was checked against the installed Claude Code 2.1.312 and T3 Code clients. Tests cover remaining counts, unusable and non-expiring grants, failed discovery, organization lookup and persistence, setting changes during lookup, ambiguous claims across restarts, multiple redemptions from one grant, stale counts, and clearing local cooldowns. No live reset was consumed during verification.

On 29 October 2026, Codex CLI 0.165.0 returned a greeting through downstream and upstream WebSockets. A native Codex app-server session then completed two turns on the same thread and recalled a word from the first turn. Claude Code 2.1.311 returned a greeting from Sonnet 5.5 through native SSE. The proxy recorded canonical token splits, timings and price estimates for both harnesses. Temporary client keys were deleted after the checks.

Controlled WebSocket tests cover repeated turns, per-turn daily caps and account-assignment changes. Accounting tests cover overlapping OpenAI cache/reasoning counts, independent Claude cache counts, duplicate SDK records, unknown prices and cache-write cost ranges.

The usage/activity Playwright check covers summary token buckets, all six graph periods and their token/cost totals, graph hover details, persisted auto-reset settings, hub-key generation, request search and details, email blur and narrow layout. Storage tests check that history older than 90 days survives new usage and that upgrading existing hourly history neither loses nor duplicates requests on restart. Live hourly totals matched the daily total after upgrade. Headless desktop and mobile screenshots were inspected. Automatic redemption against a real expiring credit remains untested.

Compression checks cover gzip/zstd request decoding, malformed and oversized expanded bodies, model restrictions after decoding, gzip/zstd SSE completion, and permessage-deflate negotiation. A delayed chunked upload protects against committing a status before the SDK finishes reading a request. The Claude upstream gzip wrapper is tested with replay and the original selected transport.

On 29 October 2026, the unmodified Claude Code 2.1.311 harness returned a greeting through a temporary, locally trusted TLS test proxy. It sent a 2,855-byte gzip request and decoded a 627-byte zstd response stream through ai-funnel. Its official-host URL and gzip flag were confined to that test process. Codex 0.165.0 returned a greeting through HTTP with its native request compressed by a test transport from 56,735 to 19,787 bytes using zstd. The custom-provider Codex client itself sent identity encoding. A separate native Codex WebSocket greeting also passed. User Codex config and T3 settings hashes were unchanged, and temporary keys, certificates and configurations were removed.

On 29 October 2026, the home deployment passed private HTTPS checks through Tailscale Serve. A push to `main` triggered the registered GitHub App webhook and a successful Coolify deployment in Exploration / production. The container binds port 4310 only to host loopback, has no public domain, and uses a persistent encrypted data volume. Its runtime limits are 1 GB and two CPUs. Tailscale Funnel is disabled.

The existing dashboard key unlocked the deployed app after the encrypted state transfer and subsequent deployment. Browser checks passed for usage graphs, request logs, email privacy across reload, the private hub URL, and a narrow viewport, with no page errors. Codex CLI 0.165.0 returned `Hi` through the private HTTPS endpoint using downstream and upstream WebSockets. Its temporary key was deleted. The probe used an isolated configuration and left the user's Codex and T3 setup unchanged. The source local service was stopped before the account store moved.

All 41 existing containers remained running without new unhealthy states, and the public codex-lb endpoint continued to return HTTP 200. Public connections to port 4310 failed, and the private hostname sent to the public reverse proxy followed its existing fallback redirect rather than reaching ai-funnel.

Key editing checks cover provider additions/removals, account/model restrictions, rejected invalid edits, clearing caps and expiration, unchanged credentials and pause state, persistence, and WebSocket policy changes through the management endpoint. The editor browser check uses the provider model catalog, selects and removes models, saves and reopens an existing key, and verifies its original credential still works. Desktop and mobile layouts were inspected.

Per-key lifetime accounting checks cover duplicate SDK records, in-flight completion after revocation, history backfill, restart persistence, and keeping totals after source logs are evicted. The key comparison browser check covers independent cost/token ordering, percentage bars, paused and unused keys, email privacy, uncertain cost ranges, unpriced requests, and desktop/mobile layouts.

Key archive checks cover HTTP revocation, rejection on the next turn of an open WebSocket, retained identity and lifetime totals after restart, duplicate credential rejection, and restoration in a paused state. The browser check archives and restores an edited key, verifies its original credential, and checks the archived view on desktop and mobile.

Dashboard routing checks cover login at a direct page URL, refresh on each page, navigation links, browser back and forward, and redirects from the root or unknown paths to usage.

Account row checks cover inline plan multipliers, the free-plan icon, hidden healthy status, plain text exceptions, keyboard-accessible plan tooltips, unknown tiers, email privacy, and mobile overflow. Controlled provider checks verify Claude tier discovery and credential import without live account requests.

Manual reset checks cover dashboard authentication, verified account credits, retry idempotency, paused connections, cooldown clearing, Claude grants with multiple uses or no expiry, and independence from automatic resets. Browser checks select the earliest unexpired credit, show its relative expiry, invoke both providers, and refresh the action afterward.

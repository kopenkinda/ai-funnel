# Verification

Updated on 29 October 2026 for the quota chart layout using shadcn preset `b13HF9dX9O`. Provider adapters and account storage were not changed by this redesign.

## Current checks

- Production TypeScript/Vite build passes.
- All 12 gateway tests pass. These cover authentication, origins, provider/model/account boundaries, expiration, concurrent daily caps, revocation, scoped Codex keys, Claude prefixes, SSE, upstream errors, cancellation, quota normalization, and encrypted storage.
- All 3 Playwright flows pass against isolated fixture services. These cover compact quota cards, account details on hover and focus, omission of unknown accounts, zero limits, provider rows, connection setup, scoped key creation, pausing, reload persistence, removal, mobile overflow, reduced motion, and dialog focus in both tab directions.
- Chromium checks cover theme persistence, mobile top navigation, and a scrollable setup dialog at 390px. No page errors were observed in those checks. The responsive browser flow switches sections through the navbar on mobile.
- A read-only UI check against a connected Codex pool displayed unavailable quotas, an additional 30-day window, and rate limiting. At 826px, account rows stack without page overflow. No console or page errors were observed. Installation-specific notes remain local and are excluded from Git.

The updated development server runs on port 4310. The inline Vite setup now uses the shared Vite configuration so Tailwind and import aliases work in both development and production.

## UI review

The interface uses the CLI-generated Luma components and zinc/sky theme, Hugeicons, Space Grotesk body text, and Nunito Sans headings. `components.json` records the preset configuration. Usage groups connections by provider and shows compact quota cards with horizontal stacked bars and remaining percentages. Unconnected providers have no row. Codex has 5-hour, weekly, and monthly cards. Account names and reset times appear on hover or keyboard focus. Accounts without a reported percentage are omitted from that window's tooltip; exhausted accounts remain visible.

The feed currently supplies quota percentages rather than credit balances. Percentages are averages of reported account limits, as explained in the tooltip. Unknown values are excluded from those averages; zero remains an exhausted limit. A window with no reports has a striped unavailable state. Light, dark, and mobile screenshots were inspected after the change. Tooltips use the active popover colors rather than inverted colors. Theme changes suppress transitions so inherited button colors do not briefly disappear.

Each connected provider also has a compact accounts table below its charts. It shows account identity, status, plan, reported quota percentages, reset times, and a link to the upstream dashboard. Accounts with no quota reports are omitted. Credit balances, purchased allowances, and warm-up controls are not in the current feed and are not displayed. Tables scroll horizontally on narrow screens. Codex, Claude, and OpenCode use local SVGL logos; monochrome logos follow the active theme.

The modal focus check waits for Base UI's scheduled focus movement. In connection setup, Shift+Tab wraps from Copy URL to Close, and Tab wraps back to Copy URL, without duplicating the library's focus management.

The generated Hugeicons spinner needed its props type narrowed to the actual icon component. This corrects an upstream type incompatibility between string-valued SVG dimensions and the icon component's numeric dimensions.

Not checked in this pass: Safari/Firefox, a full screen-reader session, forced colors, clipboard permissions in other browsers, or a fresh Docker build. The earlier Docker baseline built and ran as the non-root Node user without runtime npm dependencies. Production build output still consists of static frontend assets.

## Existing integration boundaries

- The existing codex-lb pool remains the owner of account tokens, refresh, and load balancing. Connecting the pool did not migrate accounts.
- The earlier live codex-lb check verified discovery, quota/reset synchronization, scoped key creation, native models, missing-key rejection, and a streaming Responses request. TOTP was not checked because the installation does not require it.
- Claude targets CLIProxyAPI management v8. Live subscription quotas and routing prefixes still need checking with the installed service.
- Zen/Go discovery and inference still need live credential verification. Balance/reset retrieval is not implemented.
- Codex WebSockets are not implemented. Client configuration uses HTTP Responses with WebSockets disabled.
- Tailscale Serve, tailnet ACLs, the deployment hostname, backups, and long-running deployment remain outside this UI pass.

# Routing

**Settings → Codex routing** and **Claude routing** choose how requests spread across the accounts a key may use. Changes are saved encrypted and apply to the next selection without a restart.

![Settings dialog with Codex and Claude routing strategies, banked reset and usage hub options](screenshots/settings-routing.png)

Both providers default to **Capacity weighted** with sticky sessions on, **Prefer earlier reset** on, and the weekly window as the reset window. Relative availability uses an exponent of 2 and the top 5 accounts.

## Strategies

| Strategy              | Selection                                                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Capacity weighted     | Random draw weighted by remaining weekly percentage times plan capacity.                                                      |
| Relative availability | Weight is remaining capacity per second until the weekly reset, raised to the exponent (default 2), among the top 5 accounts. |
| Usage weighted        | Lowest weekly usage, then lowest 5h usage, then the account used least recently.                                              |
| Round robin           | Rotates through accounts in ID order.                                                                                         |
| Fill first            | Highest 5h usage, then highest weekly usage, so one account drains before the next.                                           |
| Sequential drain      | Smallest plan capacity first, then account ID.                                                                                |
| Reset drain           | Nearest weekly reset by day, then most remaining 5h and weekly allowance.                                                     |
| Single account        | Only the selected account. Requests fail if it is paused, removed, cooling down, or not assigned to the key.                  |

## Plan capacity

Plan capacity follows the account badges:

| Provider | Plan           | Capacity |
| -------- | -------------- | -------- |
| Codex    | Plus, Business | 1        |
| Codex    | Pro 100        | 5        |
| Codex    | Pro 200        | 10       |
| Codex    | Pro 500        | 20       |
| Claude   | Pro, Team      | 1        |
| Claude   | Max 5x         | 5        |
| Claude   | Max 20x        | 20       |
| Any      | Free, unknown  | 1        |

Purchased credits and banked resets do not add capacity.

**Prefer earlier reset** limits Capacity weighted, Usage weighted and Fill first to the accounts whose selected window resets soonest. The weekly window is compared by whole day, the 5h window by exact seconds.

## Quota windows

Routing reads the last quota refresh. Windows shorter than a day count as 5h, and longer ones (weekly or monthly) as weekly. A plan with only a long window uses it for both.

Model-specific windows, such as Codex Spark or Claude Opus weekly limits, apply only to matching models, and the most used matching window counts. Code review and extra-usage windows are ignored. A window whose reset time has passed counts as unused until the next refresh.

Missing quota data counts as unused, so a failed or pending lookup never blocks requests. Accounts with an exhausted window are used only when every permitted account is exhausted, which leaves purchased credits and extra usage as spillover.

## Sticky sessions

Sticky sessions keep a conversation on one account for cache locality. The binding uses the client's session ID, or matching conversation history when there is no ID. Bindings are isolated per API key.

A binding is reused only while the account is still permitted for the key and model, enabled, not cooling down, and not exhausted while another account has allowance. Otherwise the request and its retries move to another permitted account and the session rebinds. **Subscription only** still checks each selected Codex account live and fails closed.

## WebSockets

Routing does not move a Codex WebSocket turn off the account its socket is pinned to. Each turn still checks the key, account availability, single-account routing and subscription policy. Switching single-account routing to a different account rejects further turns on open sockets until the client reconnects.

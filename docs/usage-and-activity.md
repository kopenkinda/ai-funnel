# Usage and activity

## Usage graphs

The **Usage** page graphs token totals and estimated API-equivalent cost for Today, Week, Month, 90d, YTD, Year or All time. Both graphs share the selected period. Hovering a point splits it into uncached input, cache reads, cache writes, output and reasoning. Dates use UTC, with hourly points for Today and monthly points for long histories.

The backend uses the SDK's non-overlapping token accounting. Daily totals are stored separately from the request log, so they outlive evicted requests. Hourly totals cover the last two days.

## Cost estimates

Each request is priced when it completes, using the [OpenAI](https://developers.openai.com/api/docs/pricing) and [Claude](https://platform.claude.com/docs/en/about-claude/pricing) public API price tables as checked on 29 October 2026. The price version is stored with the request. Long-context and supported service-tier rates apply.

Unknown models and unclassified usage stay unpriced and are counted separately. The SDK usage record does not say which cache-write retention was used, so those estimates show a range between the short and long retention prices. Estimates exclude subscription fees and separate tool charges.

## Per-key totals

The **API keys** page compares lifetime cost and tokens per key. These totals are stored independently of the request log and survive log eviction. Upgrading backfilled totals from the retained request history; requests evicted before that cannot be attributed to keys.

## Activity

![Activity log listing requests with account, API key, model, tokens, speed and estimated cost](screenshots/activity.png)

**Activity** lists requests 50 per page with search, provider, account, key and model filters, an **Errors only** toggle, and a details view per request. **Columns** toggles the API key, speed and transport columns; the transport filter appears with its column.

Each record holds the account, key, model, reasoning effort, client and upstream transport, status, latency, time to first token, output speed, tokens and cost. Prompts, response text, raw upstream errors and bearer credentials are never stored.

The service keeps the latest 10,000 request records.

## Privacy mode

Account emails are blurred by default throughout the dashboard. The eye button in the header toggles this, and the choice is stored in the browser.

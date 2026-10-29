import { createServer } from "node:http";

createServer(async (req, res) => {
  for await (const _ of req) {
    /* Consume request body before replying. */
  }
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/dashboard-auth/password/login") {
    res.setHeader("set-cookie", "codex-lb-session=fixture; HttpOnly");
    res.end("{}");
  } else if (req.url === "/api/accounts")
    res.end(
      JSON.stringify({
        accounts: [
          {
            accountId: "fixture-account",
            displayName: "Browser test account",
            email: "test@example.com",
            planType: "pro",
            status: "active",
            usage: {
              primaryRemainingPercent: 73,
              secondaryRemainingPercent: null,
            },
            resetAtPrimary: new Date(Date.now() + 3600000).toISOString(),
          },
          {
            accountId: "exhausted-account",
            displayName: "Exhausted account",
            email: "exhausted@example.com",
            planType: "plus",
            status: "rate_limited",
            usage: {
              primaryRemainingPercent: 0,
              secondaryRemainingPercent: null,
            },
            resetAtPrimary: new Date(Date.now() + 7200000).toISOString(),
          },
          {
            accountId: "unavailable-account",
            displayName: "Unavailable account",
            email: "unavailable@example.com",
            planType: "pro",
            status: "active",
            usage: {
              primaryRemainingPercent: null,
              secondaryRemainingPercent: null,
            },
          },
        ],
      }),
    );
  else if (req.url === "/api/api-keys")
    res.end(JSON.stringify({ id: "fixture-key", key: "private-fixture-key" }));
  else if (req.url === "/v1/models")
    res.end(JSON.stringify({ data: [{ id: "fixture-model" }] }));
  else res.end("{}");
}).listen(4320, "127.0.0.1");

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
} from "node:http";
import { randomUUID } from "node:crypto";
import { Store, hash } from "../server/store.ts";
import { createApp } from "../server/server.ts";
import type { ClientKey, Connection, Grant } from "../server/types.ts";
import { codexAccounts } from "../server/connectors.ts";

const directory = mkdtempSync(join(tmpdir(), "ai-funnel-test-"));
const store = new Store(directory, "test-dashboard-secret");
const app = createApp(store);
let origin = "";
let upstreamOrigin = "";
let captured: { url: string; headers: IncomingHttpHeaders; body: string }[] =
  [];
let cancelObserved: (() => void) | undefined;
const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString();
  captured.push({ url: req.url!, headers: req.headers, body });
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/api-keys" && req.method === "POST")
    return res.end(
      JSON.stringify({
        id: "upstream-key-id",
        key: "private-scoped-codex-key",
      }),
    );
  if (req.url === "/v1/usage") {
    if (req.headers.authorization !== "Bearer sk-clb-existing") {
      res.statusCode = 401;
      return res.end("{}");
    }
    return res.end(JSON.stringify({ limits: [] }));
  }
  if (req.url === "/v1/models")
    return res.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "allowed-model" }, { id: "other-model" }],
      }),
    );
  if (body.includes("upstream-error")) {
    res.statusCode = 429;
    res.setHeader("retry-after", "30");
    return res.end(
      '{"type":"error","error":{"type":"rate_limit_error","message":"native error"}}',
    );
  }
  if (body.includes("cancel-me")) {
    res.setHeader("content-type", "text/event-stream");
    res.write("data: first\n\n");
    res.on("close", () => cancelObserved?.());
    return;
  }
  if (body.includes('"stream":true')) {
    res.setHeader("content-type", "text/event-stream");
    res.setHeader("set-cookie", "upstream-private=never-forward");
    res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
    setTimeout(
      () => res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'),
      25,
    );
    return;
  }
  res.setHeader("x-provider-trace", "native-trace");
  res.end(body || "{}");
});
const admin = {
  authorization: "Bearer test-dashboard-secret",
  "content-type": "application/json",
};
const listen = (server: ReturnType<typeof createServer>) =>
  new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(
        `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      ),
    ),
  );
before(async () => {
  upstreamOrigin = await listen(upstream);
  origin = await listen(app.server);
});
after(async () => {
  app.server.closeAllConnections();
  upstream.closeAllConnections();
  await Promise.all([
    new Promise<void>((r) => app.server.close(() => r())),
    new Promise<void>((r) => upstream.close(() => r())),
  ]);
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
function connection(provider: Connection["provider"] = "codex"): Connection {
  const c: Connection = {
    id: randomUUID(),
    provider,
    name: "Test pool",
    url: upstreamOrigin,
    enabled: true,
    apiKey: "private-upstream-key",
    managementKey: "private-management-key",
    cookie: "private-dashboard-session=secret",
    accounts: [
      {
        id: "account-1",
        name: "Account one",
        email: "",
        plan: "Pro",
        status: "active",
        quotas: [],
      },
    ],
    models: ["allowed-model"],
    syncedAt: null,
    error: null,
    createdAt: new Date().toISOString(),
  };
  store.save("connection", c);
  return c;
}
function client(
  c: Connection,
  overrides: Partial<ClientKey> = {},
  grant?: Partial<Grant>,
) {
  const token = `test-${randomUUID()}`;
  const key: ClientKey = {
    id: randomUUID(),
    name: "Test device",
    hash: hash(token),
    prefix: token.slice(0, 15),
    enabled: true,
    expiresAt: null,
    dailyLimit: null,
    grants: [{ connectionId: c.id, accountIds: null, models: null, ...grant }],
    upstreamKeys: { [c.id]: "private-codex-key" },
    upstreamIds: {},
    imported: false,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    ...overrides,
  };
  store.save("key", key);
  return { token, key };
}
const route = (c: Connection, path = "/v1/responses") =>
  `${origin}/providers/${c.provider}/${c.id}${path}`;
const post = (
  c: Connection,
  token: string,
  value: unknown,
  path?: string,
  extra: Record<string, string> = {},
) =>
  fetch(route(c, path), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...extra,
    },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });

test("dashboard credentials cannot be replaced by a client key, and mutations reject foreign origins", async () => {
  const c = connection();
  const { token } = client(c);
  assert.equal(
    (
      await fetch(`${origin}/api/state`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/session`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://other-site.test",
        },
        body: JSON.stringify({ token: store.adminToken }),
      })
    ).status,
    403,
  );
  const login = await fetch(`${origin}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: store.adminToken }),
  });
  assert.equal(login.status, 200);
  assert.match(login.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
  const state = await fetch(`${origin}/api/state`, {
    headers: { cookie: login.headers.get("set-cookie")!.split(";")[0] },
  });
  assert.equal(state.status, 200);
  const text = await state.text();
  assert.ok(!text.includes("private-upstream-key"));
  assert.ok(!text.includes("private-codex-key"));
  assert.ok(!text.includes("private-management-key"));
  assert.ok(!text.includes("private-dashboard-session"));
});

test("native requests and session headers survive while client and dashboard credentials stay private", async () => {
  const c = connection();
  const { token } = client(c);
  const body =
    '{ "model": "allowed-model", "input": [{"type":"function_call_output","call_id":"abc","output":"ok"}], "unknown_future_field": 7 }';
  const result = await post(c, token, body, undefined, {
    cookie: "funnel_session=browser-secret",
    "session-id": "session-123",
    "x-management-key": "injected",
    "x-forwarded-for": "spoofed",
  });
  assert.equal(result.status, 200);
  assert.equal(await result.text(), body);
  assert.equal(result.headers.get("x-provider-trace"), "native-trace");
  const last = captured.at(-1)!;
  assert.equal(last.body, body);
  assert.equal(last.headers.authorization, "Bearer private-codex-key");
  assert.equal(last.headers["session-id"], "session-123");
  assert.equal(last.headers.cookie, undefined);
  assert.equal(last.headers["x-management-key"], undefined);
  assert.equal(last.headers["x-forwarded-for"], undefined);
});

test("provider, model, expiry and revoked-account boundaries fail closed", async () => {
  const c = connection();
  const other = connection("claude");
  const { token, key } = client(c, {}, { models: ["allowed-model"] });
  const before = captured.length;
  assert.equal(
    (await post(other, token, { model: "allowed-model" }, "/v1/messages"))
      .status,
    403,
  );
  assert.equal((await post(c, token, { model: "not-allowed" })).status, 403);
  key.expiresAt = new Date(Date.now() - 1000).toISOString();
  store.save("key", key);
  assert.equal((await post(c, token, { model: "allowed-model" })).status, 401);
  key.expiresAt = null;
  key.grants[0].accountIds = ["missing-account"];
  store.save("key", key);
  assert.equal((await post(c, token, { model: "allowed-model" })).status, 503);
  assert.equal(captured.length, before);
});

test("the daily cap reserves before concurrent upstream requests", async () => {
  const c = connection();
  const { token } = client(c, { dailyLimit: 1 });
  const results = await Promise.all([
    post(c, token, { model: "allowed-model" }),
    post(c, token, { model: "allowed-model" }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 429]);
  await Promise.all(results.map((r) => r.text()));
});

test("revoking a key during an upload prevents forwarding and cannot restore the key", async () => {
  const c = connection();
  const { token, key } = client(c);
  const body = JSON.stringify({ model: "allowed-model" });
  const received = new Promise<void>((resolve) =>
    app.server.once("request", () => resolve()),
  );
  const completed = new Promise<number>((resolve) => {
    const request = httpRequest(
      route(c),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      },
    );
    request.write(body.slice(0, 5));
    void received.then(() => {
      store.remove("key", key.id);
      request.end(body.slice(5));
    });
  });
  const before = captured.length;
  assert.equal(await completed, 401);
  assert.equal(captured.length, before);
  assert.equal(store.key(key.id), undefined);
});

test("native Claude SSE and upstream errors are preserved without forwarding cookies", async () => {
  const c = connection("claude");
  const { token } = client(c);
  const stream = await fetch(route(c, "/v1/messages"), {
    method: "POST",
    headers: {
      "x-api-key": token,
      "content-type": "application/json",
      "anthropic-beta": "test-beta",
      "x-claude-code-session-id": "claude-session",
    },
    body: JSON.stringify({ model: "allowed-model", stream: true }),
  });
  assert.equal(stream.status, 200);
  assert.equal(stream.headers.get("set-cookie"), null);
  assert.equal(
    await stream.text(),
    'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
  );
  assert.equal(
    captured.at(-1)!.headers.authorization,
    "Bearer private-upstream-key",
  );
  assert.equal(captured.at(-1)!.headers["x-api-key"], undefined);
  const failure = await post(
    c,
    token,
    { model: "allowed-model", messages: "upstream-error" },
    "/v1/messages",
  );
  assert.equal(failure.status, 429);
  assert.equal(failure.headers.get("retry-after"), "30");
  assert.deepEqual(await failure.json(), {
    type: "error",
    error: { type: "rate_limit_error", message: "native error" },
  });
});

test("catalog filtering and route allowlists prevent bypasses into management", async () => {
  const c = connection();
  const { token } = client(c, {}, { models: ["allowed-model"] });
  const catalog = await fetch(route(c, "/v1/models"), {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.deepEqual((await catalog.json()).data, [{ id: "allowed-model" }]);
  for (const path of [
    "/api/accounts",
    "/v1/anything",
    "/v1/%2e%2e/api/accounts",
    "/v1//responses",
  ])
    assert.ok(
      (await post(c, token, { model: "allowed-model" }, path)).status >= 400,
    );
});

test("Codex account selection creates a scoped upstream key and uses it for inference", async () => {
  const c = connection();
  const created = await fetch(`${origin}/api/keys`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({
      name: "Scoped devices",
      grants: [
        {
          connectionId: c.id,
          accountIds: ["account-1"],
          models: ["allowed-model"],
        },
      ],
    }),
  });
  assert.equal(created.status, 201);
  const { token, key } = await created.json();
  const creation = captured.findLast((r) => r.url === "/api/api-keys")!;
  assert.deepEqual(JSON.parse(creation.body).assignedAccountIds, ["account-1"]);
  assert.equal(creation.headers.cookie, c.cookie);
  const response = await post(c, token, { model: "allowed-model" });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(
    captured.at(-1)!.headers.authorization,
    "Bearer private-scoped-codex-key",
  );
  assert.ok(!JSON.stringify(key).includes("private-scoped-codex-key"));
});

test("registering an existing Codex key keeps its original credential and upstream policy", async () => {
  const c = connection();
  const results = await Promise.all(
    [1, 2].map(() =>
      fetch(`${origin}/api/keys`, {
        method: "POST",
        headers: admin,
        body: JSON.stringify({
          name: "Existing devices",
          existingKey: "sk-clb-existing",
          grants: [{ connectionId: c.id, accountIds: null, models: null }],
        }),
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const result = results.find((r) => r.status === 201)!;
  assert.equal((await result.json()).token, null);
  await results.find((r) => r.status === 409)!.text();
  const response = await post(c, "sk-clb-existing", { model: "allowed-model" });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(
    captured.at(-1)!.headers.authorization,
    "Bearer sk-clb-existing",
  );
});

test("unsupported Claude subsets are rejected, and configured subsets cannot override their account route", async () => {
  const c = connection("claude");
  const result = await fetch(`${origin}/api/keys`, {
    method: "POST",
    headers: admin,
    body: JSON.stringify({
      name: "Scoped Claude",
      grants: [{ connectionId: c.id, accountIds: ["account-1"], models: null }],
    }),
  });
  assert.equal(result.status, 400);
  c.accounts[0].prefix = "only-account-one";
  store.save("connection", c);
  const { token } = client(c, {}, { accountIds: ["account-1"] });
  const response = await post(
    c,
    token,
    { model: "allowed-model", max_tokens: 100 },
    "/v1/messages",
  );
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(
    JSON.parse(captured.at(-1)!.body).model,
    "only-account-one/allowed-model",
  );
  assert.equal(
    (
      await post(
        c,
        token,
        { model: "other-account/allowed-model" },
        "/v1/messages",
      )
    ).status,
    403,
  );
});

test("disconnecting a streaming client cancels the upstream request", async () => {
  const c = connection("claude");
  const { token } = client(c);
  const controller = new AbortController();
  const observed = new Promise<void>((resolve) => {
    cancelObserved = resolve;
  });
  const res = await fetch(route(c, "/v1/messages"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "allowed-model", input: "cancel-me" }),
    signal: controller.signal,
  });
  const reader = res.body!.getReader();
  await reader.read();
  controller.abort();
  await Promise.race([
    observed,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Upstream was not cancelled")), 1500),
    ),
  ]);
  cancelObserved = undefined;
});

test("quota normalization preserves unknown and exhausted values, and persistent credentials are encrypted", () => {
  const accounts = codexAccounts([
    {
      accountId: "one",
      displayName: "A",
      planType: "pro",
      usage: { primaryRemainingPercent: 0, secondaryRemainingPercent: null },
      resetAtPrimary: "2026-11-01T10:00:00Z",
    },
  ]);
  assert.equal(accounts[0].quotas[0].remaining, 0);
  assert.equal(accounts[0].quotas[1].remaining, null);
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const bytes = readFileSync(join(directory, "funnel.sqlite")).toString();
  assert.ok(!bytes.includes("private-management-key"));
  assert.ok(!bytes.includes("private-scoped-codex-key"));
  assert.ok(!bytes.includes("sk-clb-existing"));
  assert.ok(
    store
      .logs()
      .every((r) => !JSON.stringify(r).includes("function_call_output")),
  );
});

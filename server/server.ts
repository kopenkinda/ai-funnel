import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { Store, equal, hash } from "./store.ts";
import {
  providers,
  publicConnection,
  type ClientKey,
  type Connection,
  type Grant,
  type Provider,
} from "./types.ts";
import {
  codexAdmin,
  loginCodex,
  syncConnection,
  upstreamJson,
} from "./connectors.ts";
import { credential, proxy, readBody } from "./proxy.ts";
import {
  HttpError,
  optionalString,
  record,
  string,
  strings,
  url as validateUrl,
} from "./validation.ts";

export function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}
const getJson = async (req: IncomingMessage) => {
  try {
    return record(JSON.parse((await readBody(req, 128 * 1024)).toString()));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Supply a valid JSON object.");
  }
};
const cookieToken = (req: IncomingMessage) =>
  /(?:^|;\s*)funnel_session=([^;]+)/.exec(req.headers.cookie || "")?.[1] || "";

export function createApp(
  store: Store,
  options: {
    publicUrl?: string;
    fallback?: (req: IncomingMessage, res: ServerResponse) => void;
  } = {},
) {
  const failures = new Map<string, { count: number; reset: number }>();
  const syncs = new Map<string, Promise<Connection>>();
  const synchronize = (c: Connection) => {
    const existing = syncs.get(c.id);
    if (existing) return existing;
    const work = syncConnection(c)
      .then((next) => {
        // A concurrent pause or removal must survive an in-flight metadata read.
        const current = store.connection(c.id);
        if (current)
          store.save("connection", {
            ...current,
            accounts: next.accounts,
            models: next.models,
            syncedAt: next.syncedAt,
            error: next.error,
          });
        return next;
      })
      .finally(() => syncs.delete(c.id));
    syncs.set(c.id, work);
    return work;
  };

  function grantsFrom(body: Record<string, unknown>): Grant[] {
    if (
      !Array.isArray(body.grants) ||
      !body.grants.length ||
      body.grants.length > 30
    )
      throw new HttpError(400, "Select at least one provider connection.");
    const seen = new Set();
    return body.grants.map((raw) => {
      const g = record(raw);
      const connectionId = string(g.connectionId, "connection", 100);
      const c = store.connection(connectionId);
      if (!c || seen.has(c.id))
        throw new HttpError(400, "Select valid, unique connections.");
      seen.add(c.id);
      const accountIds = strings(g.accountIds, "account");
      const models = strings(g.models, "model");
      if (accountIds?.some((id) => !c.accounts.some((a) => a.id === id)))
        throw new HttpError(
          400,
          "An assigned account was not found. Refresh the connection.",
        );
      if (
        c.provider === "claude" &&
        accountIds &&
        accountIds.some((id) => {
          const a = c.accounts.find((a) => a.id === id)!;
          return (
            !a.prefix ||
            c.accounts.filter((b) => a.prefix === b.prefix).length !== 1
          );
        })
      )
        throw new HttpError(
          400,
          "Claude subsets need unique credential prefixes configured in CLIProxyAPI. Choose the whole pool or configure prefixes first.",
        );
      return { connectionId, accountIds, models };
    });
  }

  const server = createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "same-origin");
    try {
      const rawPath = (req.url || "/").split("?")[0];
      if (/%|\\|(?:^|\/)\.{1,2}(?:\/|$)|\/\//.test(rawPath))
        throw new HttpError(400, "Invalid request path.");
      const u = new URL(req.url || "/", "http://localhost");
      const path = u.pathname;
      if (path === "/healthz" && req.method === "GET")
        return json(res, 200, { status: "ok" });
      const route =
        /^\/providers\/(codex|claude|zen|go)\/([a-zA-Z0-9-]+)(\/.*)$/.exec(
          path,
        );
      if (route) {
        const c = store.connection(route[2]);
        if (!c || c.provider !== route[1])
          throw new HttpError(404, "Provider connection not found.");
        return await proxy(req, res, store, c, route[3], u.search);
      }
      if (!path.startsWith("/api/")) {
        if (options.fallback) return options.fallback(req, res);
        throw new HttpError(404, "Not found.");
      }
      if (req.headers.origin && !["GET", "HEAD"].includes(req.method || "")) {
        const expected = options.publicUrl
          ? new URL(options.publicUrl).origin
          : `http://${req.headers.host}`;
        if (req.headers.origin !== expected)
          throw new HttpError(
            403,
            "Use the dashboard from its configured address.",
          );
      }
      if (path === "/api/session" && req.method === "GET")
        return json(res, 200, {
          authenticated: store.validSession(cookieToken(req)),
        });
      if (path === "/api/session" && req.method === "POST") {
        const address = req.socket.remoteAddress || "local";
        for (const [id, f] of failures)
          if (f.reset < Date.now()) failures.delete(id);
        const failure = failures.get(address) || {
          count: 0,
          reset: Date.now() + 60000,
        };
        if (failure.count >= 8)
          throw new HttpError(
            429,
            "Too many attempts. Try again in one minute.",
          );
        const body = await getJson(req);
        if (
          typeof body.token !== "string" ||
          !equal(body.token, store.adminToken)
        ) {
          failure.count++;
          failures.set(address, failure);
          throw new HttpError(401, "The dashboard key is incorrect.");
        }
        failures.delete(address);
        const secure = options.publicUrl?.startsWith("https:")
          ? "; Secure"
          : "";
        res.setHeader(
          "set-cookie",
          `funnel_session=${store.session()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}`,
        );
        return json(res, 200, { authenticated: true });
      }
      const authorized =
        store.validSession(cookieToken(req)) ||
        equal(credential(req), store.adminToken);
      if (!authorized)
        throw new HttpError(401, "Unlock the dashboard to continue.");
      if (path === "/api/session" && req.method === "DELETE") {
        store.logout(cookieToken(req));
        res.setHeader(
          "set-cookie",
          "funnel_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        );
        return json(res, 200, { authenticated: false });
      }
      if (path === "/api/state" && req.method === "GET")
        return json(res, 200, {
          connections: store
            .list<Connection>("connection")
            .map(publicConnection),
          keys: store.list<ClientKey>("key").map((k) => store.publicKey(k)),
          requests: store.logs(),
          publicUrl: options.publicUrl || "",
        });
      if (path === "/api/connections" && req.method === "POST") {
        const b = await getJson(req);
        if (!providers.includes(b.provider as Provider))
          throw new HttpError(400, "Select a provider.");
        const c: Connection = {
          id: randomUUID(),
          provider: b.provider as Provider,
          name: string(b.name, "connection name", 80),
          url: validateUrl(b.url),
          apiKey: optionalString(b.apiKey, "API key"),
          managementKey: optionalString(b.managementKey, "management key"),
          cookie: "",
          enabled: true,
          accounts: [],
          models: [],
          syncedAt: null,
          error: null,
          createdAt: new Date().toISOString(),
        };
        if (c.provider === "codex" && b.password)
          await loginCodex(
            c,
            string(b.password, "password"),
            optionalString(b.username, "username"),
            optionalString(b.code, "two-factor code"),
          );
        const next = await syncConnection(c);
        if (next.error) throw new HttpError(400, next.error);
        store.save("connection", next);
        return json(res, 201, publicConnection(next));
      }
      const connRoute =
        /^\/api\/connections\/([\w-]+)(?:\/(sync|login))?$/.exec(path);
      if (connRoute) {
        let c = store.connection(connRoute[1]);
        if (!c) throw new HttpError(404, "Connection not found.");
        if (connRoute[2] === "sync" && req.method === "POST")
          return json(res, 200, publicConnection(await synchronize(c)));
        if (
          connRoute[2] === "login" &&
          req.method === "POST" &&
          c.provider === "codex"
        ) {
          const b = await getJson(req);
          await loginCodex(
            c,
            string(b.password, "password"),
            optionalString(b.username, "username"),
            optionalString(b.code, "two-factor code"),
          );
          const current = store.connection(c.id);
          if (!current) throw new HttpError(404, "Connection not found.");
          current.cookie = c.cookie;
          store.save("connection", current);
          return json(res, 200, publicConnection(await synchronize(current)));
        }
        if (!connRoute[2] && req.method === "PATCH") {
          const b = await getJson(req);
          c = store.connection(connRoute[1]);
          if (!c) throw new HttpError(404, "Connection not found.");
          if (typeof b.enabled !== "boolean")
            throw new HttpError(400, "Supply the connection state.");
          c.enabled = b.enabled;
          store.save("connection", c);
          return json(res, 200, publicConnection(c));
        }
        if (!connRoute[2] && req.method === "DELETE") {
          store.remove("connection", c.id);
          return json(res, 200, { deleted: true });
        }
      }
      if (path === "/api/keys" && req.method === "POST") {
        const b = await getJson(req);
        const grants = grantsFrom(b);
        const expiresAt = b.expiresAt
          ? string(b.expiresAt, "expiration date")
          : null;
        if (
          expiresAt &&
          (!Number.isFinite(Date.parse(expiresAt)) ||
            Date.parse(expiresAt) <= Date.now())
        )
          throw new HttpError(400, "Choose a future expiration date.");
        const dailyLimit = b.dailyLimit == null ? null : b.dailyLimit;
        if (
          dailyLimit !== null &&
          (typeof dailyLimit !== "number" ||
            !Number.isSafeInteger(dailyLimit) ||
            dailyLimit < 1)
        )
          throw new HttpError(
            400,
            "Daily request limit must be a positive whole number.",
          );
        const importedToken = optionalString(
          b.existingKey,
          "existing Codex key",
        );
        const token =
          importedToken || `sk-af-${randomBytes(32).toString("base64url")}`;
        if (store.keyByToken(token))
          throw new HttpError(409, "This key is already registered.");
        const key: ClientKey = {
          id: randomUUID(),
          name: string(b.name, "key name", 80),
          hash: hash(token),
          prefix: token.slice(0, 15),
          enabled: true,
          expiresAt,
          dailyLimit: dailyLimit as number | null,
          grants,
          upstreamKeys: {},
          upstreamIds: {},
          imported: !!importedToken,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
        };
        const createdUpstream: { connection: Connection; id: string }[] = [];
        try {
          for (const grant of grants) {
            const c = store.connection(grant.connectionId)!;
            if (c.provider !== "codex") continue;
            if (importedToken) {
              if (grant.accountIds)
                throw new HttpError(
                  400,
                  "An existing Codex key keeps its account assignments in codex-lb. Choose inherited access.",
                );
              await upstreamJson(`${c.url}/v1/usage`, {
                headers: { authorization: `Bearer ${importedToken}` },
              });
              key.upstreamKeys[c.id] = importedToken;
            } else {
              const created = await codexAdmin(c, "/api/api-keys", "POST", {
                name: `ai-funnel: ${key.name}`,
                ...(grant.accountIds
                  ? { assignedAccountIds: grant.accountIds }
                  : {}),
                ...(grant.models ? { allowedModels: grant.models } : {}),
                ...(expiresAt ? { expiresAt } : {}),
              });
              if (
                typeof created.key !== "string" ||
                typeof created.id !== "string"
              )
                throw new HttpError(
                  502,
                  "codex-lb did not return the new scoped key.",
                );
              key.upstreamKeys[c.id] = created.key;
              key.upstreamIds[c.id] = created.id;
              createdUpstream.push({ connection: c, id: created.id });
            }
          }
          if (
            importedToken &&
            !grants.some(
              (g) => store.connection(g.connectionId)?.provider === "codex",
            )
          )
            throw new HttpError(
              400,
              "Select the Codex connection that owns this existing key.",
            );
          if (store.keyByToken(token))
            throw new HttpError(409, "This key is already registered.");
          store.save("key", key);
        } catch (error) {
          for (const created of createdUpstream) {
            try {
              await codexAdmin(
                created.connection,
                `/api/api-keys/${created.id}`,
                "DELETE",
              );
            } catch {
              /* Gateway never accepted the key. Upstream cleanup can be retried in codex-lb. */
            }
          }
          throw error;
        }
        return json(res, 201, {
          key: store.publicKey(key),
          token: importedToken ? null : token,
        });
      }
      const keyRoute = /^\/api\/keys\/([\w-]+)$/.exec(path);
      if (keyRoute) {
        let key = store.key(keyRoute[1]);
        if (!key) throw new HttpError(404, "Client key not found.");
        if (req.method === "PATCH") {
          const b = await getJson(req);
          key = store.key(keyRoute[1]);
          if (!key) throw new HttpError(404, "Client key not found.");
          if (typeof b.enabled !== "boolean")
            throw new HttpError(400, "Supply the key state.");
          key.enabled = b.enabled;
          store.save("key", key);
          return json(res, 200, store.publicKey(key));
        }
        if (req.method === "DELETE") {
          store.remove("key", key.id);
          return json(res, 200, { deleted: true });
        }
      }
      throw new HttpError(404, "Route not found.");
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      const message =
        error instanceof HttpError
          ? error.message
          : "The request could not be completed.";
      const anthropic = /\/providers\/claude\/|\/anthropic\//.test(
        req.url || "",
      );
      const type =
        status === 401
          ? "authentication_error"
          : status === 403
            ? "permission_error"
            : status === 429
              ? "rate_limit_error"
              : status >= 500
                ? "api_error"
                : "invalid_request_error";
      json(
        res,
        status,
        anthropic
          ? { type: "error", error: { type, message } }
          : { error: { type, message } },
      );
    }
  });
  server.on("upgrade", (_req, socket) => {
    socket.end(
      "HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });
  return { server, synchronize };
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Store, hash } from "./store.ts";
import type { ClientKey, Connection, Grant } from "./types.ts";
import { HttpError, record } from "./validation.ts";

export async function readBody(req: IncomingMessage, max = 16 * 1024 * 1024) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, "Request body is too large.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export function credential(req: IncomingMessage): string {
  const authorization = req.headers.authorization;
  const bearer = authorization?.match(/^Bearer (\S+)$/i)?.[1];
  const apiKey = req.headers["x-api-key"];
  if (
    Array.isArray(apiKey) ||
    (authorization && !bearer) ||
    (bearer && apiKey && bearer !== apiKey)
  )
    throw new HttpError(401, "Supply one valid client key.");
  return bearer || apiKey || "";
}

const incomingHeaders =
  /^(content-type|accept|user-agent|anthropic-version|anthropic-beta|openai-beta|session-id|conversation-id|x-codex-turn-state|x-codex-conversation-id|x-codex-parent-thread-id|x-request-id|x-client-request-id|x-session-id|x-parent-session-id|x-claude-code-session-id|x-claude-code-agent-id|x-claude-code-parent-agent-id|x-opencode-session|x-stainless-[a-z-]+)$/;
const outgoingBlocked = new Set([
  "connection",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  "keep-alive",
  "set-cookie",
  "proxy-authenticate",
  "proxy-authorization",
  "upgrade",
  "trailer",
  "te",
  "access-control-allow-origin",
  "access-control-allow-credentials",
]);

export function allowedPath(provider: string, path: string, method: string) {
  const models = method === "GET";
  if (provider === "codex")
    return models
      ? ["/v1/models", "/backend-api/codex/models", "/v1/usage"].includes(path)
      : method === "POST" &&
          /^(\/v1|\/backend-api\/codex)\/responses(\/compact)?$/.test(path);
  if (provider === "claude")
    return models
      ? path === "/v1/models"
      : method === "POST" &&
          ["/v1/messages", "/v1/messages/count_tokens"].includes(path);
  return models
    ? ["/v1/models", "/openai/v1/models", "/anthropic/v1/models"].includes(path)
    : method === "POST" &&
        [
          "/openai/v1/responses",
          "/openai/v1/chat/completions",
          "/anthropic/v1/messages",
          "/anthropic/v1/messages/count_tokens",
        ].includes(path);
}

export function validateGrant(
  key: ClientKey,
  c: Connection,
  grant: Grant,
  model: string | null,
  store: Store,
) {
  if (
    !key.enabled ||
    (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now())
  )
    throw new HttpError(401, "This client key is paused or expired.");
  if (!c.enabled) throw new HttpError(503, "This connection is paused.");
  if (key.dailyLimit !== null && store.countToday(key.id) >= key.dailyLimit)
    throw new HttpError(
      429,
      "This key has reached its daily request limit. It resets at midnight UTC.",
    );
  if (model && grant.models && !grant.models.includes(model))
    throw new HttpError(403, "This key does not allow the requested model.");
  if (
    grant.accountIds &&
    grant.accountIds.some((id) => !c.accounts.some((a) => a.id === id))
  )
    throw new HttpError(
      503,
      "An assigned account is no longer available. Update this key before retrying.",
    );
}

export async function proxy(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  c: Connection,
  path: string,
  search: string,
) {
  if (!allowedPath(c.provider, path, req.method || ""))
    throw new HttpError(404, "This provider route is not available.");
  const token = credential(req);
  const authenticated = token && store.keyByToken(token);
  if (!authenticated)
    throw new HttpError(401, "Supply a valid ai-funnel client key.");
  let body = req.method === "POST" ? await readBody(req) : undefined;
  // Uploading can yield long enough for access to be revoked. Use current policy before reserving.
  const key = store.key(authenticated.id);
  const current = store.connection(c.id);
  if (!key) throw new HttpError(401, "This client key has been removed.");
  if (!current) throw new HttpError(404, "Provider connection not found.");
  c = current;
  const grant = key.grants.find((g) => g.connectionId === c.id);
  if (!grant)
    throw new HttpError(
      403,
      "This key does not allow this provider connection.",
    );
  let model: string | null = null;
  let parsed: Record<string, unknown> | undefined;
  if (body) {
    try {
      parsed = record(JSON.parse(body.toString()));
    } catch {
      throw new HttpError(400, "Supply a JSON request object.");
    }
    if (
      typeof parsed.model !== "string" ||
      !parsed.model ||
      parsed.model.length > 255
    )
      throw new HttpError(400, "Supply a model name.");
    model = parsed.model;
  }
  validateGrant(key, c, grant, model, store);
  if (c.provider === "claude" && model) {
    if (model.includes("/"))
      throw new HttpError(
        403,
        "Use an unprefixed Claude model. Account routing belongs to the key.",
      );
    if (grant.accountIds) {
      const selected = c.accounts.filter((a) =>
        grant.accountIds!.includes(a.id),
      );
      if (
        !selected.length ||
        selected.some(
          (a) =>
            !a.prefix ||
            c.accounts.filter((b) => b.prefix === a.prefix).length !== 1,
        )
      )
        throw new HttpError(
          503,
          "This Claude account selection needs unique routing prefixes in CLIProxyAPI.",
        );
      const session = String(
        req.headers["x-claude-code-session-id"] ||
          req.headers["session-id"] ||
          req.headers["x-opencode-session"] ||
          key.id,
      );
      const account =
        selected[parseInt(hash(session).slice(0, 8), 16) % selected.length];
      if (["paused", "disabled", "error", "limited"].includes(account.status))
        throw new HttpError(503, "The assigned Claude account is unavailable.");
      body = Buffer.from(
        JSON.stringify({ ...parsed, model: `${account.prefix}/${model}` }),
      );
    }
  }
  const upstreamKey =
    c.provider === "codex" ? key.upstreamKeys[c.id] : c.apiKey;
  if (!upstreamKey)
    throw new HttpError(
      503,
      "No upstream credential is assigned to this connection.",
    );
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers))
    if (incomingHeaders.test(name) && typeof value === "string")
      headers.set(name, value);
  headers.set("authorization", `Bearer ${upstreamKey}`);
  headers.set("accept-encoding", "identity");
  const abort = new AbortController();
  const abortClient = () => {
    if (!res.writableFinished) abort.abort();
  };
  res.once("close", abortClient);
  req.once("aborted", abortClient);
  const timeout = setTimeout(() => abort.abort(), 30 * 60 * 1000);
  timeout.unref();
  const start = Date.now();
  let status = 502;
  // Reserve synchronously before yielding so parallel requests cannot exceed the daily cap.
  store.reserve(key);
  key.lastUsedAt = new Date().toISOString();
  store.save("key", key);
  try {
    let upstream: Response;
    try {
      upstream = await fetch(`${c.url}${path}${search}`, {
        method: req.method,
        headers,
        body,
        signal: abort.signal,
        redirect: "manual",
      });
    } catch {
      throw new HttpError(
        abort.signal.aborted ? 504 : 502,
        "The provider connection failed or timed out.",
      );
    }
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      throw new HttpError(
        502,
        "Provider redirects are disabled. Configure its final API URL.",
      );
    }
    status = upstream.status;
    const connectionTokens = (upstream.headers.get("connection") || "")
      .toLowerCase()
      .split(",")
      .map((t) => t.trim());
    for (const [name, value] of upstream.headers)
      if (!outgoingBlocked.has(name) && !connectionTokens.includes(name))
        res.setHeader(name, value);
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-accel-buffering", "no");
    res.statusCode = status;
    if (
      req.method === "GET" &&
      path.endsWith("/models") &&
      grant.models &&
      upstream.ok
    ) {
      const catalog = (await upstream.json()) as Record<string, any>;
      for (const name of ["data", "models"])
        if (Array.isArray(catalog[name]))
          catalog[name] = catalog[name].filter((m: Record<string, any>) =>
            grant.models!.includes(m.id || m.slug),
          );
      res.end(JSON.stringify(catalog));
    } else if (upstream.body) {
      res.flushHeaders();
      await pipeline(Readable.fromWeb(upstream.body as any), res);
    } else res.end();
  } catch (error) {
    if (!res.headersSent)
      status = error instanceof HttpError ? error.status : 502;
    throw error;
  } finally {
    clearTimeout(timeout);
    res.off("close", abortClient);
    req.off("aborted", abortClient);
    if (abort.signal.aborted && !res.writableFinished) status = 499;
    store.log({
      id: randomUUID(),
      at: new Date().toISOString(),
      connectionId: c.id,
      keyId: key.id,
      model,
      status,
      durationMs: Date.now() - start,
    });
  }
}

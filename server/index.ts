import { createReadStream, existsSync, statSync } from "node:fs";
import { resolve, extname, join } from "node:path";
import { createApp } from "./server.ts";
import { Store } from "./store.ts";
import type { Connection } from "./types.ts";
import type { IncomingMessage, ServerResponse } from "node:http";

const dataDir = resolve(process.env.DATA_DIR || "data");
const store = new Store(dataDir, process.env.ADMIN_TOKEN);
let fallback: (req: IncomingMessage, res: ServerResponse) => void;
let closeVite: (() => Promise<void>) | undefined;
if (process.env.NODE_ENV !== "production") {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  fallback = (req, res) => vite.middlewares(req, res);
  closeVite = () => vite.close();
} else {
  const root = resolve("dist");
  if (!existsSync(join(root, "index.html")))
    throw new Error(
      "Build the frontend with pnpm build before starting production.",
    );
  const mime: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
  };
  fallback = (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405);
      res.end();
      return;
    }
    let path = resolve(
      root,
      "." + new URL(req.url || "/", "http://localhost").pathname,
    );
    if (
      !path.startsWith(root + "/") ||
      !existsSync(path) ||
      !statSync(path).isFile()
    )
      path = join(root, "index.html");
    res.setHeader(
      "content-type",
      `${mime[extname(path)] || "application/octet-stream"}; charset=utf-8`,
    );
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    res.setHeader(
      "cache-control",
      extname(path) === ".html" ? "no-cache" : "public, max-age=86400",
    );
    if (req.method === "HEAD") res.end();
    else createReadStream(path).pipe(res);
  };
}
const { server, synchronize } = createApp(store, {
  publicUrl: process.env.PUBLIC_URL,
  fallback,
});
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4310);
server.listen(port, host, () => {
  console.log(`ai-funnel is listening on http://${host}:${port}`);
  console.log(
    `Dashboard key: ${process.env.ADMIN_TOKEN ? "configured through ADMIN_TOKEN" : join(dataDir, "admin-token")}`,
  );
});
const refresh = setInterval(() => {
  for (const c of store.list<Connection>("connection"))
    if (c.enabled && !c.error) void synchronize(c);
}, 120000);
refresh.unref();
const stop = () => {
  clearInterval(refresh);
  server.close(() => {
    void closeVite?.().finally(() => store.close());
    if (!closeVite) store.close();
  });
  server.closeIdleConnections();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

import { DatabaseSync } from "node:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { ClientKey, Connection, PublicKey, RequestLog } from "./types.ts";

export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function equal(a: string, b: string) {
  return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
}

export class Store {
  db: DatabaseSync;
  master: Buffer;
  adminToken: string;
  constructor(directory: string, adminToken?: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const readOrCreate = (name: string, make: () => Buffer) => {
      const path = join(directory, name);
      try {
        return readFileSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        writeFileSync(path, make(), { flag: "wx", mode: 0o600 });
        return readFileSync(path);
      }
    };
    this.master = readOrCreate("master.key", () => randomBytes(32));
    this.adminToken =
      adminToken ||
      readOrCreate("admin-token", () =>
        Buffer.from(randomBytes(32).toString("base64url")),
      )
        .toString()
        .trim();
    if (this.master.length !== 32 || this.adminToken.length < 16)
      throw new Error(
        "Invalid master key or dashboard key. Dashboard keys need at least 16 characters.",
      );
    const path = join(directory, "funnel.sqlite");
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS entities (kind TEXT, id TEXT, payload TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS daily_usage (key_id TEXT, day TEXT, count INTEGER NOT NULL, PRIMARY KEY(key_id,day));
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, at TEXT NOT NULL, payload TEXT NOT NULL);
    `);
  }
  seal(value: unknown) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.master, iv);
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
      "base64",
    );
  }
  open<T>(value: string): T {
    const data = Buffer.from(value, "base64");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.master,
      data.subarray(0, 12),
    );
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        decipher.update(data.subarray(28)),
        decipher.final(),
      ]).toString(),
    );
  }
  save(kind: "connection" | "key", value: Connection | ClientKey) {
    this.db
      .prepare(
        "INSERT INTO entities VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload",
      )
      .run(kind, value.id, this.seal(value));
  }
  list<T>(kind: "connection" | "key"): T[] {
    return this.db
      .prepare("SELECT payload FROM entities WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map((row) => this.open<T>(row.payload as string));
  }
  connection(id: string) {
    return this.list<Connection>("connection").find((c) => c.id === id);
  }
  key(id: string) {
    return this.list<ClientKey>("key").find((k) => k.id === id);
  }
  keyByToken(token: string) {
    const digest = hash(token);
    return this.list<ClientKey>("key").find((k) => k.hash === digest);
  }
  remove(kind: "connection" | "key", id: string) {
    this.db.prepare("DELETE FROM entities WHERE kind=? AND id=?").run(kind, id);
  }
  countToday(id: string) {
    return (
      (this.db
        .prepare("SELECT count FROM daily_usage WHERE key_id=? AND day=?")
        .get(id, new Date().toISOString().slice(0, 10))?.count as number) || 0
    );
  }
  reserve(key: ClientKey) {
    const day = new Date().toISOString().slice(0, 10);
    this.db
      .prepare(
        "INSERT INTO daily_usage VALUES (?,?,1) ON CONFLICT(key_id,day) DO UPDATE SET count=count+1",
      )
      .run(key.id, day);
    this.db
      .prepare("DELETE FROM daily_usage WHERE day < ?")
      .run(new Date(Date.now() - 32 * 86400000).toISOString().slice(0, 10));
  }
  publicKey(key: ClientKey): PublicKey {
    const { hash: _, upstreamKeys: __, upstreamIds: ___, ...rest } = key;
    return { ...rest, requestsToday: this.countToday(key.id) };
  }
  session() {
    const token = randomBytes(32).toString("base64url");
    this.db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());
    this.db
      .prepare("INSERT INTO sessions VALUES (?,?)")
      .run(hash(token), Date.now() + 7 * 86400000);
    return token;
  }
  validSession(token: string) {
    return !!this.db
      .prepare("SELECT 1 FROM sessions WHERE hash=? AND expires>?")
      .get(hash(token), Date.now());
  }
  logout(token: string) {
    this.db.prepare("DELETE FROM sessions WHERE hash=?").run(hash(token));
  }
  log(request: RequestLog) {
    this.db
      .prepare("INSERT INTO requests VALUES (?,?,?)")
      .run(request.id, request.at, JSON.stringify(request));
    this.db
      .prepare(
        "DELETE FROM requests WHERE id IN (SELECT id FROM requests ORDER BY at DESC LIMIT -1 OFFSET 2000)",
      )
      .run();
  }
  logs(): RequestLog[] {
    return this.db
      .prepare("SELECT payload FROM requests ORDER BY at DESC LIMIT 100")
      .all()
      .map((row) => JSON.parse(row.payload as string));
  }
  close() {
    this.db.close();
  }
}

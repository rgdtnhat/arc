import { randomUUID, scryptSync, timingSafeEqual, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

/**
 * Admin authentication for the dashboard.
 *
 * The admin id and password are provided via environment (ADMIN_ID /
 * ADMIN_PASSWORD) so they are NEVER committed to the repo. Only a salted scrypt
 * hash is persisted, to a gitignored file, and the password can be rotated at
 * runtime (change-password) — the new hash overrides the env seed.
 */
interface AdminStore {
  id: string;
  salt: string;
  hash: string;
}

export class AdminAuth {
  private store: AdminStore;
  private readonly sessions = new Map<string, { id: string; at: number }>();
  /** Sessions expire after this long (12h). */
  private readonly ttlMs = 12 * 60 * 60 * 1000;

  constructor(private readonly file: string, seed: { id: string; password: string }) {
    if (existsSync(file)) {
      this.store = JSON.parse(readFileSync(file, "utf8")) as AdminStore;
    } else {
      this.store = AdminAuth.derive(seed.id, seed.password);
      this.persist();
    }
  }

  private static derive(id: string, password: string): AdminStore {
    const salt = randomBytes(16).toString("hex");
    const hash = scryptSync(password, salt, 32).toString("hex");
    return { id, salt, hash };
  }

  private persist() {
    writeFileSync(this.file, JSON.stringify(this.store), { mode: 0o600 });
  }

  private matches(password: string): boolean {
    const attempt = scryptSync(password, this.store.salt, 32);
    const current = Buffer.from(this.store.hash, "hex");
    return attempt.length === current.length && timingSafeEqual(attempt, current);
  }

  /** Returns a session token on success, or null on bad credentials. */
  login(id: string, password: string): string | null {
    if (id !== this.store.id || !this.matches(password)) return null;
    const token = randomUUID();
    this.sessions.set(token, { id, at: Date.now() });
    return token;
  }

  /** Rotate the password for the current session. Requires the current one. */
  changePassword(token: string, current: string, next: string): { ok: boolean; error?: string } {
    /*
     * `session()`, not `sessions.has()`.
     *
     * The map keeps an entry until something prunes it, and only `session()`
     * checks the age — so `has()` answered yes for a token that had already
     * expired. The current password is still required, so this was the second
     * lock rather than the only one; a session that has timed out should not
     * open either.
     */
    if (!this.session(token)) return { ok: false, error: "not authenticated" };
    if (!this.matches(current)) return { ok: false, error: "current password is wrong" };
    if (!next || next.length < 8) return { ok: false, error: "new password must be at least 8 characters" };
    this.store = AdminAuth.derive(this.store.id, next);
    this.persist();
    return { ok: true };
  }

  session(token?: string): { id: string } | null {
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (Date.now() - s.at > this.ttlMs) {
      this.sessions.delete(token);
      return null;
    }
    return { id: s.id };
  }

  logout(token?: string) {
    if (token) this.sessions.delete(token);
  }
}

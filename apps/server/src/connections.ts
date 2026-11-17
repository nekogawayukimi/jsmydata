import type { Connection } from '@jsmydata/sql';

interface Entry {
  conn: Promise<Connection>;
  lastUsed: number;
}

/**
 * Une connexion par session et par serveur, ouverte à la demande,
 * fermée à la déconnexion ou après une période d'inactivité.
 */
export class ConnectionManager {
  private readonly entries = new Map<string, Entry>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly idleMs: number) {
    this.timer = setInterval(() => void this.sweep(), Math.min(60_000, idleMs)).unref();
  }

  private key(sessionId: string, serverId: string) {
    return `${sessionId}\u0000${serverId}`;
  }

  async get(sessionId: string, serverId: string, open: () => Promise<Connection>): Promise<Connection> {
    const k = this.key(sessionId, serverId);
    let entry = this.entries.get(k);
    if (!entry) {
      const conn = open();
      entry = { conn, lastUsed: Date.now() };
      this.entries.set(k, entry);
      conn.catch(() => this.entries.delete(k));
    }
    entry.lastUsed = Date.now();
    return entry.conn;
  }

  /** Remplace la connexion (après une connexion réussie, la connexion de test est conservée). */
  set(sessionId: string, serverId: string, conn: Connection): void {
    const k = this.key(sessionId, serverId);
    const old = this.entries.get(k);
    this.entries.set(k, { conn: Promise.resolve(conn), lastUsed: Date.now() });
    if (old) {
      void old.conn.then((c) => (c !== conn ? c.close() : undefined)).catch(() => undefined);
    }
  }

  async close(sessionId: string, serverId?: string): Promise<void> {
    const prefix = `${sessionId}\u0000`;
    const targets = [...this.entries.keys()].filter((k) =>
      serverId === undefined ? k.startsWith(prefix) : k === this.key(sessionId, serverId),
    );
    await Promise.all(
      targets.map(async (k) => {
        const e = this.entries.get(k);
        this.entries.delete(k);
        await e?.conn.then((c) => c.close()).catch(() => undefined);
      }),
    );
  }

  async sweep(now = Date.now()): Promise<void> {
    for (const [k, e] of this.entries) {
      if (now - e.lastUsed > this.idleMs) {
        this.entries.delete(k);
        await e.conn.then((c) => c.close()).catch(() => undefined);
      }
    }
  }

  get size(): number {
    return this.entries.size;
  }

  async closeAll(): Promise<void> {
    clearInterval(this.timer);
    const all = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(all.map((e) => e.conn.then((c) => c.close()).catch(() => undefined)));
  }
}

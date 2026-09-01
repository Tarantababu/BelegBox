import { randomUUID } from "node:crypto";
import { verifyChain, verifyEntryProof } from "@belegbox/archive";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Db, createPool } from "./client.js";
import { assertRlsEnforced, RlsBypassError } from "./guard.js";
import {
  archiveDocument,
  chainLinks,
  proofForDocument,
  sealArchiveDay,
} from "./archive-store.js";
import { countDocuments, getDocument, insertDocument } from "./documents.js";
import { migrate } from "./migrate.js";
import { insertDoku, listDoku, verifyDokuChain } from "./verfahrensdoku-store.js";

/**
 * These need a real PostgreSQL: Row Level Security, FORCE, triggers and grants
 * are the things under test, and no in-memory substitute implements them. CI
 * runs a postgres service container; locally they skip.
 *
 *   docker compose up -d postgres
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/belegbox pnpm test
 */
const ADMIN_URL = process.env["DATABASE_URL"];
const APP_PASSWORD = "belegbox-test";

const suite = ADMIN_URL ? describe : describe.skip;

let admin: Db;
let app: Db;
let tenantA: string;
let tenantB: string;

async function bootstrap(): Promise<void> {
  admin = new Db(createPool(ADMIN_URL as string, 4));

  await admin.withAdmin(async (client) => {
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'belegbox_app') THEN
          CREATE ROLE belegbox_app LOGIN PASSWORD '${APP_PASSWORD}';
        ELSE
          ALTER ROLE belegbox_app LOGIN PASSWORD '${APP_PASSWORD}';
        END IF;
      END $$;
    `);
    await client.query("GRANT USAGE ON SCHEMA public TO belegbox_app");
    await migrate(client);

    const a = await client.query<{ id: string }>(
      "INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id",
      ["Şahin Döner GmbH", `sahin-${randomUUID().slice(0, 8)}`],
    );
    const b = await client.query<{ id: string }>(
      "INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id",
      ["Yılmaz Elektrotechnik GmbH", `yilmaz-${randomUUID().slice(0, 8)}`],
    );
    tenantA = a.rows[0]?.id as string;
    tenantB = b.rows[0]?.id as string;
  });

  // The application connects as a NON-owner role. That is the arrangement the
  // grants assume, and the only one under which append-only actually holds.
  const url = new URL(ADMIN_URL as string);
  url.username = "belegbox_app";
  url.password = APP_PASSWORD;
  app = new Db(createPool(url.toString(), 6));
}

const doc = (sha: string) => ({
  sourceChannel: "email" as const,
  rawObjectKey: `ab/${sha}`,
  rawSha256: sha,
  sizeBytes: 2048,
  status: "pending" as const,
  filename: "rechnung.xml",
});

const sha = (seed: string) =>
  seed.padStart(64, "0").slice(-64).replace(/[^0-9a-f]/g, "a");

suite("row level security", () => {
  beforeAll(bootstrap, 60_000);
  afterAll(async () => {
    await app?.close();
    await admin?.close();
  });

  it("hides another tenant's document even when the id is known", async () => {
    const digest = sha("1a");
    const { id } = await app.withTenant(tenantA, (tx) => insertDocument(tx, doc(digest)));

    const mine = await app.withTenant(tenantA, (tx) => getDocument(tx, id));
    expect(mine?.id).toBe(id);

    // The exact id, the exact table, a different tenant scope: no row.
    const theirs = await app.withTenant(tenantB, (tx) => getDocument(tx, id));
    expect(theirs).toBeUndefined();
  });

  it("returns no rows at all when no tenant scope is set", async () => {
    await app.withTenant(tenantA, (tx) => insertDocument(tx, doc(sha("2b"))));

    const rows = await app.withAdmin(async (client) => {
      const r = await client.query("SELECT id FROM documents");
      return r.rowCount;
    });
    // current_setting returns NULL, the policy matches nothing. A forgotten
    // scope yields emptiness, never someone else's invoices.
    expect(rows).toBe(0);
  });

  /**
   * The PgBouncer trap. `SET` would persist on the pooled connection and leak
   * into whoever is handed it next; `set_config(..., true)` is transaction-local
   * and cannot.
   */
  it("does not leak the tenant scope onto a reused connection", async () => {
    const digest = sha("3c");
    const { id } = await app.withTenant(tenantA, (tx) => insertDocument(tx, doc(digest)));

    // Exhaust and recycle the pool so a connection that served tenant A comes
    // back for an unscoped query.
    for (let i = 0; i < 12; i++) {
      await app.withTenant(tenantA, (tx) => countDocuments(tx));
    }

    const leaked = await app.withAdmin(async (client) => {
      const r = await client.query("SELECT id FROM documents WHERE id = $1", [id]);
      return r.rowCount;
    });
    expect(leaked).toBe(0);
  });

  it("refuses to write a row belonging to another tenant", async () => {
    await expect(
      app.withTenant(tenantA, async (tx) => {
        await tx.query(
          `INSERT INTO documents (tenant_id, source_channel, raw_object_key, raw_sha256, size_bytes, status)
           VALUES ($1, 'email', 'x/y', $2, 1, 'pending')`,
          [tenantB, sha("4d")],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it("rejects a tenant id that is not a UUID", async () => {
    await expect(
      app.withTenant("'; DROP TABLE documents; --", async () => undefined),
    ).rejects.toThrow(/UUID/);
  });

  it("counts only the calling tenant's documents", async () => {
    await app.withTenant(tenantB, (tx) => insertDocument(tx, doc(sha("5e"))));

    const a = await app.withTenant(tenantA, (tx) => countDocuments(tx));
    const b = await app.withTenant(tenantB, (tx) => countDocuments(tx));
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);

    const total = await admin.withAdmin(async (client) => {
      const r = await client.query<{ n: string }>("SELECT count(*) AS n FROM documents");
      return Number(r.rows[0]?.n ?? 0);
    });
    // A superuser bypasses RLS outright - FORCE binds the table owner, not a
    // superuser, and nothing in the database can constrain one. So the counts
    // add up here while each tenant still sees only its own.
    expect(total).toBeGreaterThanOrEqual(a + b);
  });

  /**
   * The operational invariant behind every other test in this file. RLS is
   * enforcement only for a role that cannot step around it, so the application
   * role must never be a superuser and must never hold BYPASSRLS - both of
   * which someone will eventually grant "temporarily" to unblock a migration.
   */
  it("runs the application as a role that cannot bypass RLS", async () => {
    const row = await admin.withAdmin(async (client) => {
      const r = await client.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        owns_documents: boolean;
      }>(
        `SELECT r.rolsuper, r.rolbypassrls,
                (SELECT c.relowner = r.oid FROM pg_class c WHERE c.relname = 'documents') AS owns_documents
           FROM pg_roles r WHERE r.rolname = 'belegbox_app'`,
      );
      return r.rows[0];
    });

    expect(row?.rolsuper).toBe(false);
    expect(row?.rolbypassrls).toBe(false);
    expect(row?.owns_documents).toBe(false);
  });
});

suite("append-only tables", () => {
  beforeAll(bootstrap, 60_000);
  afterAll(async () => {
    await app?.close();
    await admin?.close();
  });

  it("accepts an audit entry and then refuses to change it", async () => {
    await app.withTenant(tenantA, async (tx) => {
      await tx.query(
        `INSERT INTO audit_log (tenant_id, actor, action, object_type, object_id)
         VALUES ($1, 'test', 'document.archived', 'document', 'x')`,
        [tenantA],
      );
    });

    await expect(
      app.withTenant(tenantA, (tx) =>
        tx.query("UPDATE audit_log SET action = 'tampered' WHERE tenant_id = $1", [tenantA]),
      ),
    ).rejects.toThrow(/permission denied|append-only/i);

    await expect(
      app.withTenant(tenantA, (tx) =>
        tx.query("DELETE FROM audit_log WHERE tenant_id = $1", [tenantA]),
      ),
    ).rejects.toThrow(/permission denied|append-only/i);
  });

  /**
   * The Verfahrensdokumentation is evidence about the process, so the history
   * of its fassungen is itself evidence. A table that let a fassung be edited
   * would destroy exactly what GoBD Rz. 154 asks to be kept.
   */
  it("keeps every fassung of the Verfahrensdokumentation", async () => {
    const hashA = "a".repeat(64);
    const hashB = "b".repeat(64);

    await app.withTenant(tenantA, async (tx) => {
      await insertDoku(tx, {
        version: 1,
        contentHash: hashA,
        prevHash: null,
        facts: { tenant: "a" },
        html: "<p>Fassung 1</p>",
        openItems: 13,
        complete: false,
      });
      await insertDoku(tx, {
        version: 2,
        contentHash: hashB,
        prevHash: hashA,
        facts: { tenant: "a" },
        html: "<p>Fassung 2</p>",
        openItems: 12,
        complete: false,
      });
    });

    await expect(
      app.withTenant(tenantA, (tx) =>
        tx.query("UPDATE verfahrensdokumentationen SET html = 'tampered'"),
      ),
    ).rejects.toThrow(/permission denied|append-only/i);

    await expect(
      app.withTenant(tenantA, (tx) => tx.query("DELETE FROM verfahrensdokumentationen")),
    ).rejects.toThrow(/permission denied|append-only/i);

    const chain = await app.withTenant(tenantA, async (tx) => verifyDokuChain(await listDoku(tx)));
    expect(chain).toEqual({ ok: true });
  });

  it("refuses a fassung that does not chain to its predecessor", async () => {
    // The database enforces the shape; verifyDokuChain catches the rest.
    await expect(
      app.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO verfahrensdokumentationen
             (tenant_id, version, content_hash, prev_hash, facts, html, open_items, complete)
           VALUES (current_tenant_id(), 9, $1, NULL, '{}'::jsonb, '<p/>', 0, true)`,
          ["c".repeat(64)],
        ),
      ),
    ).rejects.toThrow(/chain_start/i);
  });

  /**
   * The grants are the first line; this is the second. Someone will eventually
   * widen a grant to unblock something, so the trigger has to refuse on its own
   * - and it has to refuse a superuser, who ignores both grants and RLS.
   */
  it("refuses to rewrite history even for a superuser with UPDATE granted", async () => {
    await app.withTenant(tenantA, async (tx) => {
      const { id } = await insertDocument(tx, doc(sha("9c")));
      await archiveDocument(tx, id, { archivedAt: new Date("2026-05-01T10:00:00Z") });
      await sealArchiveDay(tx, "2026-05-01");
    });

    await admin.withAdmin(async (client) => {
      await client.query("GRANT UPDATE, DELETE ON archive_chain TO belegbox_app");
    });

    try {
      await expect(
        admin.withAdmin((client) =>
          client.query("UPDATE archive_chain SET merkle_root = $1", ["f".repeat(64)]),
        ),
      ).rejects.toThrow(/append-only/i);

      await expect(
        admin.withAdmin((client) => client.query("DELETE FROM archive_chain")),
      ).rejects.toThrow(/append-only/i);
    } finally {
      await admin.withAdmin(async (client) => {
        await client.query("REVOKE UPDATE, DELETE ON archive_chain FROM belegbox_app");
      });
    }
  });

  it("refuses to delete a document", async () => {
    const { id } = await app.withTenant(tenantA, (tx) => insertDocument(tx, doc(sha("6f"))));
    await expect(
      app.withTenant(tenantA, (tx) => tx.query("DELETE FROM documents WHERE id = $1", [id])),
    ).rejects.toThrow(/append-only/i);
  });

  it("refuses to move an archived document's bytes", async () => {
    const { id } = await app.withTenant(tenantA, async (tx) => {
      const inserted = await insertDocument(tx, doc(sha("7a")));
      await archiveDocument(tx, inserted.id, { archivedAt: new Date("2026-03-01T10:00:00Z") });
      return inserted;
    });

    await expect(
      app.withTenant(tenantA, (tx) =>
        tx.query("UPDATE documents SET raw_sha256 = $2 WHERE id = $1", [id, sha("bb")]),
      ),
    ).rejects.toThrow(/immutable/i);
  });

  it("rejects a tenant rule that claims a form error", async () => {
    const { id } = await app.withTenant(tenantA, (tx) => insertDocument(tx, doc(sha("8b"))));
    await expect(
      app.withTenant(tenantA, (tx) =>
        tx.query(
          `INSERT INTO findings (tenant_id, document_id, layer, code, severity,
                                 message_raw, validator_config_version, engine_version)
           VALUES ($1, $2, 'l4_tenant', 'custom-1', 'form_error', 'x', 'v', 'e')`,
          [tenantA, id],
        ),
      ),
    ).rejects.toThrow(/findings_tenant_rules_never_form_error/);
  });
});

suite("archive writer", () => {
  beforeAll(bootstrap, 60_000);
  afterAll(async () => {
    await app?.close();
    await admin?.close();
  });

  it("archives, seals and proves inclusion end to end", async () => {
    const day1 = new Date("2026-04-01T08:00:00Z");
    const ids = await app.withTenant(tenantA, async (tx) => {
      const out: string[] = [];
      for (let i = 0; i < 5; i++) {
        const { id } = await insertDocument(tx, doc(sha(`90${i}`)));
        await archiveDocument(tx, id, {
          archivedAt: new Date(day1.getTime() + i * 60_000),
        });
        out.push(id);
      }
      return out;
    });

    const { link } = await app.withTenant(tenantA, (tx) => sealArchiveDay(tx, "2026-04-01"));
    expect(link.treeSize).toBe(5);
    expect(link.prevRoot).toBeNull();

    for (const id of ids) {
      const result = await app.withTenant(tenantA, (tx) => proofForDocument(tx, id));
      expect(result, id).toBeDefined();
      // Verified from the proof and the entry alone - no archive access.
      expect(verifyEntryProof(result!.entry, result!.proof), id).toBe(true);
      expect(result!.chainValid).toBe(true);
    }
  });

  it("chains a second day onto the first", async () => {
    await app.withTenant(tenantA, async (tx) => {
      const { id } = await insertDocument(tx, doc(sha("a10")));
      await archiveDocument(tx, id, { archivedAt: new Date("2026-04-02T09:00:00Z") });
    });

    const first = await app.withTenant(tenantA, (tx) => sealArchiveDay(tx, "2026-04-01"));
    expect(first.alreadySealed).toBe(true);

    const second = await app.withTenant(tenantA, (tx) => sealArchiveDay(tx, "2026-04-02"));
    expect(second.link.prevRoot).toBe(first.link.merkleRoot);

    const chain = await app.withTenant(tenantA, (tx) => chainLinks(tx));
    expect(verifyChain(chain).valid).toBe(true);
  });

  // Admitting a document to a sealed day leaves it outside the tree that covers
  // that day: present in the database, absent from the proof.
  it("refuses to archive into a day that is already sealed", async () => {
    await expect(
      app.withTenant(tenantA, async (tx) => {
        const { id } = await insertDocument(tx, doc(sha("a20")));
        await archiveDocument(tx, id, { archivedAt: new Date("2026-04-01T23:00:00Z") });
      }),
    ).rejects.toThrow(/already sealed/i);
  });

  it("refuses to seal backwards", async () => {
    await expect(
      app.withTenant(tenantA, (tx) => sealArchiveDay(tx, "2026-03-31")),
    ).rejects.toThrow(/only moves forward/i);
  });

  it("seals an empty day so the chain has no gaps", async () => {
    const { link } = await app.withTenant(tenantA, (tx) => sealArchiveDay(tx, "2026-04-03"));
    expect(link.treeSize).toBe(0);
    const chain = await app.withTenant(tenantA, (tx) => chainLinks(tx));
    expect(verifyChain(chain).valid).toBe(true);
  });

  it("gives no proof for another tenant's document", async () => {
    const { id } = await app.withTenant(tenantB, async (tx) => {
      const inserted = await insertDocument(tx, doc(sha("b10")));
      await archiveDocument(tx, inserted.id, { archivedAt: new Date("2026-04-05T08:00:00Z") });
      return inserted;
    });
    await app.withTenant(tenantB, (tx) => sealArchiveDay(tx, "2026-04-05"));

    expect(await app.withTenant(tenantB, (tx) => proofForDocument(tx, id))).toBeDefined();
    // Indistinguishable from "no such document" - anything else leaks existence.
    expect(await app.withTenant(tenantA, (tx) => proofForDocument(tx, id))).toBeUndefined();
  });

  it("collapses a byte-identical resend instead of storing it twice", async () => {
    const digest = sha("c10");
    const first = await app.withTenant(tenantA, (tx) => insertDocument(tx, doc(digest)));
    const second = await app.withTenant(tenantA, (tx) => insertDocument(tx, doc(digest)));
    expect(second.duplicate).toBe(true);
    expect(second.id).toBe(first.id);
  });

  it("lets a different tenant hold the same file", async () => {
    const digest = sha("d10");
    await app.withTenant(tenantA, (tx) => insertDocument(tx, doc(digest)));
    const other = await app.withTenant(tenantB, (tx) => insertDocument(tx, doc(digest)));
    expect(other.duplicate).toBe(false);
  });
});

suite("migrations", () => {
  beforeAll(bootstrap, 60_000);
  afterAll(async () => {
    await app?.close();
    await admin?.close();
  });

  it("is idempotent", async () => {
    const result = await admin.withAdmin((client) => migrate(client));
    expect(result.applied).toHaveLength(0);
    expect(result.skipped.length).toBeGreaterThan(0);
  });
});

suite("RLS enforcement guard", () => {
  beforeAll(bootstrap, 60_000);
  afterAll(async () => {
    await app?.close();
    await admin?.close();
  });

  /**
   * Found by running the product, not by testing it. The suite above already
   * asserted that belegbox_app is not a superuser - and the API was still
   * pointed at the postgres superuser in development, so every tenant saw every
   * other tenant's documents while the screen looked entirely convincing.
   *
   * The test checked the role. Nothing checked the connection.
   */
  it("refuses a superuser connection", async () => {
    await expect(assertRlsEnforced(admin)).rejects.toThrow(RlsBypassError);
    await expect(assertRlsEnforced(admin)).rejects.toThrow(/superuser/);
  });

  it("accepts the application role", async () => {
    await expect(assertRlsEnforced(app)).resolves.toBeUndefined();
  });

  it("refuses a role granted BYPASSRLS", async () => {
    await admin.withAdmin((c) => c.query("ALTER ROLE belegbox_app BYPASSRLS"));
    try {
      await expect(assertRlsEnforced(app)).rejects.toThrow(/BYPASSRLS/);
    } finally {
      await admin.withAdmin((c) => c.query("ALTER ROLE belegbox_app NOBYPASSRLS"));
    }
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Db, createPool } from "./client.js";
import { insertDocument } from "./documents.js";
import { migrate } from "./migrate.js";
import { COUNT_CAP, parseAmount, searchDocuments } from "./search.js";

/**
 * Needs a real PostgreSQL: the folding functions, the generated column and the
 * trigram index are what is under test.
 *
 *   DATABASE_URL=postgres://postgres:postgres@localhost:5432/belegbox pnpm test
 */
const ADMIN_URL = process.env["DATABASE_URL"];
const APP_PASSWORD = "belegbox-test";

const suite = ADMIN_URL ? describe : describe.skip;

let admin: Db;
let app: Db;
let tenantA: string;
let tenantB: string;

interface Supplier {
  name: string;
  invoice: string;
  vat: string;
  gross: number;
  issued: string;
}

/**
 * The spellings that actually arrive. Two Turkish names, two German ones, and
 * one that is both - the case this whole design exists for.
 */
const SUPPLIERS: Supplier[] = [
  { name: "Şahin Fleisch GmbH", invoice: "SF-2026-001", vat: "DE100000001", gross: 700.0, issued: "2026-03-04" },
  { name: "Getränke Müller GmbH", invoice: "GM-88213", vat: "DE100000002", gross: 428.4, issued: "2026-03-11" },
  { name: "Yılmaz Elektrotechnik GmbH", invoice: "YE-2026-0231", vat: "DE100000004", gross: 4200.0, issued: "2025-11-20" },
  { name: "Weinhaus Grünberg", invoice: "WG-4471", vat: "DE100000005", gross: 1234.5, issued: "2024-07-09" },
  { name: "Özkan Handel GmbH", invoice: "OEZ-9", vat: "DE100000006", gross: 99.99, issued: "2026-01-02" },
];

async function bootstrap(): Promise<void> {
  admin = new Db(createPool(ADMIN_URL as string, 4));

  await admin.withAdmin(async (client) => {
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
      ["Suche A", `suche-a-${randomUUID().slice(0, 8)}`],
    );
    const b = await client.query<{ id: string }>(
      "INSERT INTO tenants (name, slug) VALUES ($1, $2) RETURNING id",
      ["Suche B", `suche-b-${randomUUID().slice(0, 8)}`],
    );
    tenantA = a.rows[0]?.id as string;
    tenantB = b.rows[0]?.id as string;
  });

  const url = new URL(ADMIN_URL as string);
  url.username = "belegbox_app";
  url.password = APP_PASSWORD;
  app = new Db(createPool(url.toString(), 6));

  await app.withTenant(tenantA, async (tx) => {
    for (const [index, supplier] of SUPPLIERS.entries()) {
      await insertDocument(tx, {
        sourceChannel: "email",
        rawObjectKey: `search/${index}`,
        rawSha256: `${index}`.padStart(64, "e"),
        sizeBytes: 1024,
        status: "clean",
        supplierName: supplier.name,
        invoiceNumber: supplier.invoice,
        supplierVatId: supplier.vat,
        totalGross: supplier.gross,
        issuedAt: supplier.issued,
      });
    }
  });

  // A document belonging to someone else, with a name the tests search for.
  await app.withTenant(tenantB, async (tx) => {
    await insertDocument(tx, {
      sourceChannel: "email",
      rawObjectKey: "search/other",
      rawSha256: "f".repeat(64),
      sizeBytes: 1024,
      status: "clean",
      supplierName: "Şahin Fleisch GmbH",
      invoiceNumber: "SF-2026-999",
      supplierVatId: "DE100000001",
      totalGross: 12.0,
      issuedAt: "2026-03-04",
    });
  });
}

const names = (result: { hits: Array<{ supplier_name: string | null }> }): string[] =>
  result.hits.map((hit) => hit.supplier_name ?? "");

describe("reading a query as an amount", () => {
  it("reads German notation", () => {
    // "4.200,00" is four thousand two hundred, which is what the invoice shows.
    expect(parseAmount("4.200,00")).toBe(4200);
    expect(parseAmount("1.234.567,89")).toBe(1234567.89);
    expect(parseAmount("428,40")).toBe(428.4);
  });

  it("reads plain and English notation", () => {
    expect(parseAmount("4200")).toBe(4200);
    expect(parseAmount("4200.00")).toBe(4200);
    expect(parseAmount(" 99,99 € ")).toBe(99.99);
  });

  it("refuses what is not an amount", () => {
    expect(parseAmount("GM-88213")).toBeNull();
    expect(parseAmount("Müller")).toBeNull();
    expect(parseAmount("")).toBeNull();
  });
});

suite("archive search", () => {
  beforeAll(bootstrap, 60_000);
  afterAll(async () => {
    await app?.close();
    await admin?.close();
  });

  /**
   * The reason this feature is not one ILIKE. The same supplier is written six
   * ways between a Turkish keyboard, a German one, and neither.
   */
  it.each([
    ["Şahin", "Şahin Fleisch GmbH"],
    ["Sahin", "Şahin Fleisch GmbH"],
    ["sahin", "Şahin Fleisch GmbH"],
    ["Müller", "Getränke Müller GmbH"],
    ["Muller", "Getränke Müller GmbH"],
    ["Mueller", "Getränke Müller GmbH"],
    ["Getranke", "Getränke Müller GmbH"],
    ["Getraenke", "Getränke Müller GmbH"],
    ["Yılmaz", "Yılmaz Elektrotechnik GmbH"],
    ["Yilmaz", "Yılmaz Elektrotechnik GmbH"],
    ["Özkan", "Özkan Handel GmbH"],
    ["Ozkan", "Özkan Handel GmbH"],
    ["Oezkan", "Özkan Handel GmbH"],
    ["Grunberg", "Weinhaus Grünberg"],
    ["Gruenberg", "Weinhaus Grünberg"],
  ])("finds %s as an exact match", async (query, expected) => {
    const result = await app.withTenant(tenantA, (tx) => searchDocuments(tx, { q: query }));
    expect(result.mode).toBe("exact");
    expect(names(result)).toContain(expected);
  });

  it("finds a document by invoice number and ranks it first", async () => {
    const result = await app.withTenant(tenantA, (tx) =>
      searchDocuments(tx, { q: "GM-88213" }),
    );
    expect(result.hits[0]?.invoice_number).toBe("GM-88213");
    expect(result.hits[0]?.rank).toBe(0);
  });

  it("finds a document by VAT id", async () => {
    const result = await app.withTenant(tenantA, (tx) =>
      searchDocuments(tx, { q: "DE100000004" }),
    );
    expect(names(result)).toEqual(["Yılmaz Elektrotechnik GmbH"]);
  });

  describe("when nothing matches exactly", () => {
    it("offers near matches rather than an empty list", async () => {
      // The failure this exists to prevent: an empty result read as "we never
      // received an invoice from them".
      const result = await app.withTenant(tenantA, (tx) =>
        searchDocuments(tx, { q: "gruenberq" }),
      );
      expect(result.mode).toBe("similar");
      expect(names(result)).toContain("Weinhaus Grünberg");
    });

    it("says the matches are near ones, never that they are exact", async () => {
      const result = await app.withTenant(tenantA, (tx) =>
        searchDocuments(tx, { q: "muellerr" }),
      );
      expect(result.mode).toBe("similar");
    });

    it("still returns nothing for something that is not there at all", async () => {
      const result = await app.withTenant(tenantA, (tx) =>
        searchDocuments(tx, { q: "Zzyzx Bergbau" }),
      );
      expect(result.hits).toEqual([]);
      expect(result.total).toBe(0);
    });

    it("does not start guessing on a page past the end", async () => {
      // An empty second page means the results ended, not that a different set
      // of documents should be offered under the same query.
      const result = await app.withTenant(tenantA, (tx) =>
        searchDocuments(tx, { q: "Müller", offset: 50 }),
      );
      expect(result.hits).toEqual([]);
      expect(result.mode).toBe("exact");
    });
  });

  describe("amounts", () => {
    it("finds a document by what it cost", async () => {
      const result = await app.withTenant(tenantA, (tx) =>
        searchDocuments(tx, { q: "4.200,00" }),
      );
      expect(result.amount).toBe(4200);
      expect(names(result)).toContain("Yılmaz Elektrotechnik GmbH");
    });

    it("reports nothing as an amount when the query is a name", async () => {
      const result = await app.withTenant(tenantA, (tx) =>
        searchDocuments(tx, { q: "Müller" }),
      );
      expect(result.amount).toBeNull();
    });

    it("filters by range", async () => {
      const result = await app.withTenant(tenantA, (tx) =>
        searchDocuments(tx, { minGross: 500, maxGross: 5000 }),
      );
      // 428,40 falls below the floor and 99,99 well below it.
      expect(names(result).sort()).toEqual([
        "Weinhaus Grünberg",
        "Yılmaz Elektrotechnik GmbH",
        "Şahin Fleisch GmbH",
      ].sort());
    });
  });

  describe("filters", () => {
    it("takes a period from the document's own issue date", async () => {
      // Not received_at: a Steuerberater asking for 2025 means invoices dated
      // 2025, whenever they happened to arrive.
      const result = await app.withTenant(tenantA, (tx) =>
        searchDocuments(tx, { issuedFrom: "2025-01-01", issuedTo: "2025-12-31" }),
      );
      expect(names(result)).toEqual(["Yılmaz Elektrotechnik GmbH"]);
    });

    it("combines a period with a search term", async () => {
      const result = await app.withTenant(tenantA, (tx) =>
        searchDocuments(tx, { q: "GmbH", issuedFrom: "2026-01-01" }),
      );
      expect(names(result)).not.toContain("Yılmaz Elektrotechnik GmbH");
      expect(names(result)).toContain("Şahin Fleisch GmbH");
    });

    it("calls a browse without a term a browse", async () => {
      // So the caller does not report "no matches for your search" when there
      // was no search.
      const result = await app.withTenant(tenantA, (tx) => searchDocuments(tx, {}));
      expect(result.mode).toBe("filtered");
      expect(result.total).toBe(SUPPLIERS.length);
    });
  });

  describe("counting", () => {
    it("reports the total, not the size of the page", async () => {
      const result = await app.withTenant(tenantA, (tx) =>
        searchDocuments(tx, { q: "GmbH", limit: 1 }),
      );
      expect(result.hits).toHaveLength(1);
      expect(result.total).toBeGreaterThan(1);
      expect(result.totalIsLowerBound).toBe(false);
    });

    it("caps the count instead of walking a ten-year archive", async () => {
      const many = Array.from({ length: COUNT_CAP + 5 }, (_, index) => index);
      await app.withTenant(tenantA, async (tx) => {
        for (const index of many) {
          await tx.query(
            `INSERT INTO documents
               (tenant_id, source_channel, raw_object_key, raw_sha256, size_bytes, status,
                supplier_name, invoice_number)
             VALUES (current_tenant_id(), 'email', $1, $2, 10, 'clean', $3, $4)`,
            [`bulk/${index}`, `c${index}`.padStart(64, "0"), `Massenlieferant ${index}`, `M-${index}`],
          );
        }
      });

      const result = await app.withTenant(tenantA, (tx) =>
        searchDocuments(tx, { q: "Massenlieferant", limit: 10 }),
      );
      expect(result.total).toBe(COUNT_CAP);
      expect(result.totalIsLowerBound).toBe(true);
    }, 60_000);
  });

  it("never reaches across tenants", async () => {
    // RLS does this, but the search is the one place a user would notice if it
    // did not - the other tenant's document has the same supplier name.
    const result = await app.withTenant(tenantB, (tx) =>
      searchDocuments(tx, { q: "Sahin" }),
    );
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.invoice_number).toBe("SF-2026-999");
  });
});

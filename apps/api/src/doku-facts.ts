import { getTenant, type TenantClient } from "@belegbox/db";
import { ENGINE_VERSION, MustangClient, type MustangHealth } from "@belegbox/validation";
import type {
  ArchiveFacts,
  DokuInput,
  InboxFacts,
  MigrationFacts,
  RulesetFacts,
  StorageFacts,
  UserFacts,
  ValidatorFacts,
} from "@belegbox/verfahrensdoku";

/**
 * Reads the facts the Verfahrensdokumentation is built from.
 *
 * Everything here is a read of the running system. Nothing is a constant, and
 * nothing is inferred: if the archive has never been sealed, this reports that
 * it has never been sealed rather than describing the mechanism as though it
 * had run.
 */

export interface StorageDescription {
  backend: string;
  bucket: string;
  objectLockMode: string | null;
  retentionYears: number;
}

export interface GatherDeps {
  storage: StorageDescription;
}

/**
 * Asks the sidecar what it is running, before the transaction opens.
 *
 * Deliberately outside: an unreachable sidecar would otherwise hold a database
 * transaction open for the client's whole timeout.
 */
export async function probeValidator(mustang: MustangClient): Promise<MustangHealth | null> {
  try {
    return await mustang.health();
  } catch {
    return null;
  }
}

async function gatherInbox(tx: TenantClient): Promise<InboxFacts> {
  const { rows } = await tx.query<{ address: string; active: boolean }>(
    "SELECT address, active FROM inboxes ORDER BY created_at LIMIT 1",
  );
  const row = rows[0];
  if (!row) {
    return { address: "keine Eingangsadresse eingerichtet", active: false, senderAuthChecked: false };
  }

  // Whether the channel is evidenced is a question about the documents that
  // actually arrived, not about the code path that would run.
  const { rows: authRows } = await tx.query<{ checked: string }>(
    "SELECT count(*) AS checked FROM documents WHERE sender_auth IS NOT NULL",
  );

  return {
    address: row.address,
    active: row.active,
    senderAuthChecked: Number(authRows[0]?.checked ?? 0) > 0,
  };
}

async function gatherUsers(tx: TenantClient): Promise<UserFacts[]> {
  const { rows } = await tx.query<{ email: string; role: string; mfa_enabled: boolean }>(
    "SELECT email, role, mfa_enabled FROM users ORDER BY created_at",
  );
  return rows.map((row) => ({ email: row.email, role: row.role, mfaEnabled: row.mfa_enabled }));
}

async function gatherRuleset(tx: TenantClient): Promise<RulesetFacts | null> {
  const { rows } = await tx.query<{ id: string; template: string; version: number; yaml: string }>(
    `SELECT id, template, version, yaml
       FROM rulesets
      WHERE active
      ORDER BY effective_from DESC
      LIMIT 1`,
  );
  const row = rows[0];
  if (!row) return null;

  // Counted from the stored YAML rather than a column, so the number cannot
  // drift away from the ruleset that is actually loaded.
  const ruleCount = (row.yaml.match(/^\s*-\s+id:/gm) ?? []).length;
  return { id: row.id, template: row.template, version: row.version, ruleCount };
}

async function gatherArchive(tx: TenantClient): Promise<ArchiveFacts> {
  const { rows: docs } = await tx.query<{ count: string }>(
    "SELECT count(*) AS count FROM documents",
  );
  const { rows: chain } = await tx.query<{
    days: string;
    first_day: string | null;
    last_day: string | null;
  }>(
    `SELECT count(*) AS days,
            min(day)::text AS first_day,
            max(day)::text AS last_day
       FROM archive_chain`,
  );
  const { rows: latest } = await tx.query<{ merkle_root: string }>(
    "SELECT merkle_root FROM archive_chain ORDER BY day DESC LIMIT 1",
  );

  return {
    documentCount: Number(docs[0]?.count ?? 0),
    sealedDays: Number(chain[0]?.days ?? 0),
    firstSealedDay: chain[0]?.first_day ?? null,
    lastSealedDay: chain[0]?.last_day ?? null,
    latestRoot: latest[0]?.merkle_root ?? null,
  };
}

async function gatherMigrations(tx: TenantClient): Promise<MigrationFacts[]> {
  const { rows } = await tx.query<{ name: string; applied_at: Date }>(
    "SELECT name, applied_at FROM schema_migrations ORDER BY name",
  );
  return rows.map((row) => ({ name: row.name, appliedAt: row.applied_at }));
}

/**
 * The versions that actually judged this tenant's documents.
 *
 * R-2 put them on every finding for exactly this: the question an auditor asks
 * is what "formally correct" meant when the document was received, not what it
 * would mean today.
 */
async function gatherVersionsInArchive(tx: TenantClient): Promise<string[]> {
  const { rows } = await tx.query<{ v: string }>(
    `SELECT DISTINCT validator_config_version AS v
       FROM findings
      WHERE validator_config_version IS NOT NULL
      ORDER BY 1`,
  );
  return rows.map((row) => row.v);
}

async function gatherValidator(
  health: MustangHealth | null,
  tx: TenantClient,
): Promise<ValidatorFacts> {
  const versionsInArchive = await gatherVersionsInArchive(tx);

  // The versions come from the sidecar rather than from a constant here: this
  // Node process cannot see which configuration the JVM actually loaded. A
  // sidecar that could not be reached is stated as such, because filling in the
  // last known values would put an unverified claim in a document meant as
  // evidence.
  const unreachable = "nicht erreichbar";
  return {
    validatorConfigVersion: health?.validatorConfigVersion ?? unreachable,
    validatorConfigSha256: health?.validatorConfigSha256 ?? unreachable,
    kositVersion: health?.kositVersion ?? unreachable,
    engineVersion: ENGINE_VERSION,
    versionsInArchive,
  };
}

export async function gatherFacts(
  deps: GatherDeps,
  tx: TenantClient,
  opts: {
    version: number;
    previousHash?: string | undefined;
    generatedAt?: Date;
    health: MustangHealth | null;
  },
): Promise<DokuInput> {
  const tenant = await getTenant(tx);
  if (!tenant) throw new Error("tenant not found");

  const [inbox, users, ruleset, archive, migrations, validator] = await Promise.all([
    gatherInbox(tx),
    gatherUsers(tx),
    gatherRuleset(tx),
    gatherArchive(tx),
    gatherMigrations(tx),
    gatherValidator(opts.health, tx),
  ]);

  const storage: StorageFacts = { ...deps.storage };

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      vatId: tenant.vat_id,
      taxNumber: tenant.tax_number,
      country: tenant.country,
      industry: tenant.industry,
      locale: tenant.locale,
      createdAt: tenant.created_at,
      retentionPolicy: tenant.retention_policy,
    },
    inbox,
    users,
    validator,
    ruleset,
    storage,
    archive,
    migrations,
    generatedAt: opts.generatedAt ?? new Date(),
    version: opts.version,
    previousHash: opts.previousHash,
  };
}

/**
 * The Verfahrensdokumentation is the taxpayer's document, not ours.
 *
 * GoBD Rz. 151-155 require the business to describe its own tax-relevant
 * processes: how a document arrives, how it is checked, where it is kept, who
 * may touch it, and how all of that has changed over time. In a
 * Betriebsprüfung the auditor holds the business to this description, not to
 * Belegbox's marketing.
 *
 * Belegbox can therefore only ever generate a *part* of it - the part that runs
 * inside Belegbox - and two rules follow from that, which shape every type in
 * this file:
 *
 *   1. Every statement is backed by a fact read out of the running system, with
 *      its source named. A sentence nobody can trace back to a column, a config
 *      file or a table is not evidence.
 *
 *   2. Where Belegbox's knowledge stops, the document says so. Boilerplate that
 *      covers a process the business does not actually follow is worse evidence
 *      than a blank: it is a written description the auditor can disprove.
 *
 * What this is not: a conformity certificate. Whether a business's process
 * satisfies the GoBD is a judgement for its Steuerberater or Wirtschaftsprüfer.
 * `lint.ts` refuses the wording that would claim otherwise.
 */

/**
 * Where a stated fact came from.
 *
 * Named precisely enough that a reviewer can go and look. This is the same
 * discipline as R-2 on findings: a document that says "retention is ten years"
 * without saying where it read that is an assertion, not a record.
 */
export type FactSource =
  | { kind: "tenant_config"; column: string }
  | { kind: "system_config"; file: string; key: string }
  | { kind: "database"; table: string }
  | { kind: "code"; module: string };

export interface Fact {
  key: string;
  /** German, because the document is read by a German auditor. */
  label: string;
  value: string;
  source: FactSource;
}

/**
 * Something the business must answer itself.
 *
 * Not a defect in the generator - a boundary. Belegbox cannot know who is
 * authorised to release a payment, or whether invoices also arrive on paper.
 * Guessing would put a false statement in a document the business signs.
 */
export interface OpenItem {
  id: string;
  /** Addressed to the business, in German. */
  question: string;
  /** Why it cannot be filled in automatically. */
  why: string;
  sectionId: string;
}

/**
 * Who the section describes.
 *
 * Rendered next to the heading, so the auditor sees at a glance which parts of
 * the process are evidenced by the system and which rest on the business's own
 * statement.
 */
export type Coverage = "belegbox" | "tenant" | "shared";

/**
 * One paragraph, keeping its authored words apart from the data spliced into
 * it.
 *
 * The conformity lint judges what Belegbox wrote, never what a tenant happens
 * to be called. Without this split a business named "Rechtssicher GmbH" could
 * never generate its documentation, because its own name would trip a rule
 * aimed at our marketing. `text` is what the reader sees; `authored` is the
 * literal parts of the template, which is the only thing an author controls.
 */
export interface Prose {
  text: string;
  authored: string;
}

export interface Section {
  /** GoBD's own numbering, so the document is navigable next to the statute. */
  id: string;
  title: string;
  coverage: Coverage;
  /** The paragraph of the GoBD this section answers, where there is one. */
  gobd?: string;
  /** Descriptive prose. Never a conclusion about conformity. */
  body: Prose[];
  facts: Fact[];
  openItems: OpenItem[];
}

export interface TenantFacts {
  id: string;
  name: string;
  vatId: string | null;
  taxNumber: string | null;
  country: string;
  industry: string | null;
  locale: string;
  createdAt: Date;
  retentionPolicy: { invoices_years: number; vouchers_years: number };
}

export interface InboxFacts {
  address: string;
  active: boolean;
  /** SPF/DKIM/DMARC evaluation is what makes the channel evidence. */
  senderAuthChecked: boolean;
}

export interface UserFacts {
  email: string;
  role: string;
  mfaEnabled: boolean;
}

export interface ValidatorFacts {
  validatorConfigVersion: string;
  validatorConfigSha256: string;
  kositVersion: string;
  engineVersion: string;
  /**
   * The configuration versions that actually judged this tenant's documents,
   * read off the stored findings.
   *
   * The version running today is what the system would do now; this is what it
   * did then. An archive judged under two configurations says so, which is the
   * honest answer and the one R-2 exists to make available.
   */
  versionsInArchive: string[];
}

export interface RulesetFacts {
  id: string;
  template: string;
  version: number;
  ruleCount: number;
}

export interface StorageFacts {
  backend: string;
  bucket: string;
  /** COMPLIANCE cannot be lifted by anyone, including the account root. */
  objectLockMode: string | null;
  retentionYears: number;
}

export interface ArchiveFacts {
  documentCount: number;
  sealedDays: number;
  firstSealedDay: string | null;
  lastSealedDay: string | null;
  latestRoot: string | null;
}

export interface MigrationFacts {
  name: string;
  appliedAt: Date;
}

/**
 * Everything the generator is allowed to know.
 *
 * The package reads nothing itself: the caller assembles this from the database
 * and the pinned config, and the generator is a pure function of it. That is
 * what makes the output reproducible - the same input renders the same bytes,
 * and therefore the same hash.
 */
export interface DokuInput {
  tenant: TenantFacts;
  inbox: InboxFacts;
  users: UserFacts[];
  validator: ValidatorFacts;
  ruleset: RulesetFacts | null;
  storage: StorageFacts;
  archive: ArchiveFacts;
  migrations: MigrationFacts[];
  generatedAt: Date;
  version: number;
  /**
   * The previous version's hash.
   *
   * GoBD Rz. 154 requires a change history and the retention of superseded
   * versions. Chaining the hashes makes that history tamper-evident for the
   * same reason the archive day chain is - a rewritten version 3 no longer
   * matches what version 4 says came before it.
   */
  previousHash?: string | undefined;
}

export interface Verfahrensdokumentation {
  version: number;
  generatedAt: string;
  tenantName: string;
  sections: Section[];
  /** Flattened across sections, in document order. */
  openItems: OpenItem[];
  /**
   * False while any open item is unanswered.
   *
   * The document prints this on its first page. A half-finished
   * Verfahrensdokumentation presented as finished is the failure mode this
   * exists to prevent.
   */
  complete: boolean;
  previousHash: string | undefined;
  /** Over the canonical form, not the rendered HTML. See hash.ts. */
  contentHash: string;
}

export class DokuError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DokuError";
  }
}

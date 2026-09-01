import type {
  Coverage,
  DokuInput,
  Fact,
  OpenItem,
  Prose,
  Section,
} from "./types.js";

/**
 * The document's structure follows GoBD Rz. 151, so an auditor can read it
 * beside the statute: allgemeine Beschreibung, Anwenderdokumentation,
 * technische Systemdokumentation, Betriebsdokumentation - plus the change
 * history Rz. 154 asks for separately.
 *
 * Every section declares its coverage. `belegbox` means the facts below it were
 * read out of the running system. `tenant` means Belegbox cannot see the
 * process at all and the business has to describe it. `shared` means the system
 * evidences part of it and the business has to complete the rest.
 *
 * The prose describes mechanisms. It never concludes that a mechanism is
 * sufficient - see lint.ts.
 */

/**
 * Tags a paragraph, separating the words Belegbox wrote from the values it
 * spliced in.
 *
 * Only the literal parts reach the lint. A tenant name, an inbox address or a
 * storage mode is data, and data cannot be an authoring mistake.
 */
export function prose(strings: TemplateStringsArray, ...values: unknown[]): Prose {
  let text = "";
  strings.forEach((literal, index) => {
    text += literal;
    if (index < values.length) text += String(values[index]);
  });
  return { text, authored: strings.join(" ") };
}

/** DD.MM.YYYY in UTC. Fixed rather than locale-derived, so output is stable. */
export function germanDate(at: Date | string): string {
  const date = typeof at === "string" ? new Date(at) : at;
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${date.getUTCFullYear()}`;
}

function germanDateTime(at: Date): string {
  const hh = String(at.getUTCHours()).padStart(2, "0");
  const mm = String(at.getUTCMinutes()).padStart(2, "0");
  return `${germanDate(at)}, ${hh}:${mm} Uhr UTC`;
}

const tenantFact = (key: string, label: string, value: string, column: string): Fact => ({
  key,
  label,
  value,
  source: { kind: "tenant_config", column },
});

const dbFact = (key: string, label: string, value: string, table: string): Fact => ({
  key,
  label,
  value,
  source: { kind: "database", table },
});

const configFact = (
  key: string,
  label: string,
  value: string,
  file: string,
  configKey: string,
): Fact => ({ key, label, value, source: { kind: "system_config", file, key: configKey } });

const codeFact = (key: string, label: string, value: string, module: string): Fact => ({
  key,
  label,
  value,
  source: { kind: "code", module },
});

function ask(sectionId: string, id: string, question: string, why: string): OpenItem {
  return { id, sectionId, question, why };
}

function section(
  id: string,
  title: string,
  coverage: Coverage,
  gobd: string | undefined,
  body: (string | Prose)[],
  facts: Fact[],
  openItems: OpenItem[],
): Section {
  return {
    id,
    title,
    coverage,
    ...(gobd ? { gobd } : {}),
    // A paragraph with no data spliced into it is authored end to end.
    body: body.map((entry) =>
      typeof entry === "string" ? { text: entry, authored: entry } : entry,
    ),
    facts,
    openItems,
  };
}

const UNSET = "nicht hinterlegt";

export function buildSections(input: DokuInput): Section[] {
  const { tenant, inbox, users, validator, ruleset, storage, archive, migrations } = input;

  return [
    section(
      "1",
      "Allgemeine Beschreibung",
      "shared",
      "GoBD Rz. 151",
      [
        prose`Diese Verfahrensdokumentation beschreibt den Umgang mit elektronischen Eingangsrechnungen bei ${tenant.name}, soweit dieser Umgang über Belegbox läuft.`,
        "Belegbox nimmt Rechnungen an einer eigenen E-Mail-Adresse entgegen, prüft sie in zwei getrennten Schritten - Form und Inhalt - und legt das empfangene Original unverändert ab. Die Buchung selbst findet in Belegbox nicht statt; Belegbox erzeugt daraus einen Buchungsstapel im DATEV-Format.",
        "Der Teil des Belegwesens, der außerhalb von Belegbox stattfindet, ist hier nicht beschrieben. Dazu gehören Papierbelege, Kassenbelege, Rechnungen, die auf einem anderen Weg eingehen, sowie alle Schritte in der Buchhaltung nach dem Export. Die offenen Punkte am Ende dieses Abschnitts benennen, was dafür noch zu ergänzen ist.",
      ],
      [
        tenantFact("tenant_name", "Unternehmen", tenant.name, "tenants.name"),
        tenantFact("tenant_vat", "Umsatzsteuer-Identifikationsnummer", tenant.vatId ?? UNSET, "tenants.vat_id"),
        tenantFact("tenant_tax", "Steuernummer", tenant.taxNumber ?? UNSET, "tenants.tax_number"),
        tenantFact("tenant_country", "Sitzland", tenant.country, "tenants.country"),
        tenantFact("tenant_industry", "Branche", tenant.industry ?? UNSET, "tenants.industry"),
        tenantFact("tenant_since", "Mandant angelegt am", germanDate(tenant.createdAt), "tenants.created_at"),
      ],
      [
        ask(
          "1",
          "andere-eingangskanaele",
          "Auf welchen weiteren Wegen gehen Rechnungen ein - Papier, Portal-Download, persönliche Übergabe - und wie werden sie erfasst?",
          "Belegbox sieht ausschließlich, was an der eigenen Eingangsadresse ankommt.",
        ),
        ask(
          "1",
          "kasse",
          "Wird ein Kassensystem eingesetzt, und wo ist dessen Verfahrensdokumentation abgelegt?",
          "Kassenführung nach § 146a AO ist ein eigenes Verfahren, das Belegbox nicht berührt.",
        ),
        ask(
          "1",
          "weiterverarbeitung",
          "Wer übernimmt den DATEV-Export in die Buchführung, und in welchem Rhythmus?",
          "Nach dem Export endet die Spur, die Belegbox aufzeichnen kann.",
        ),
      ],
    ),

    section(
      "2",
      "Belegeingang und Belegidentifikation",
      "belegbox",
      "GoBD Rz. 63 ff.",
      [
        prose`Eingangsrechnungen erreichen Belegbox unter der Adresse ${inbox.address}. Jede eingehende Nachricht wird als Ganzes aufgezeichnet, bevor ihr Inhalt betrachtet wird.`,
        "Aus der Nachricht wird das Rechnungsdokument gelöst: eine XML-Rechnung als Anhang oder die in einer PDF/A-3 eingebettete Rechnung bei ZUGFeRD und Factur-X. Das ursprüngliche Byte-Bild bleibt erhalten und wird nicht normalisiert.",
        "Die Identität eines Belegs ist der SHA-256-Wert seiner Rohbytes. Derselbe Beleg, zweimal geschickt, führt zu einem Eintrag; zwei unterschiedliche Belege können nicht auf denselben Eintrag fallen.",
        inbox.senderAuthChecked
          ? "Zu jeder Nachricht wird das Ergebnis der Absenderprüfung nach SPF, DKIM und DMARC mitgespeichert. Der Postweg ist die Stelle, an der eine gefälschte Rechnung mit ausgetauschter Bankverbindung eintritt; das Prüfergebnis bleibt deshalb Teil des Belegs."
          : "Die Absenderprüfung nach SPF, DKIM und DMARC ist für diesen Mandanten nicht aufgezeichnet.",
      ],
      [
        dbFact("inbox_address", "Eingangsadresse", inbox.address, "inboxes.address"),
        dbFact("inbox_active", "Adresse aktiv", inbox.active ? "ja" : "nein", "inboxes.active"),
        codeFact("inbox_auth", "Absenderprüfung", inbox.senderAuthChecked ? "SPF, DKIM, DMARC" : "nicht aufgezeichnet", "@belegbox/ingest"),
        codeFact("doc_identity", "Belegidentität", "SHA-256 über die Rohbytes", "@belegbox/ingest"),
        dbFact("doc_count", "Aufgezeichnete Belege", String(archive.documentCount), "documents"),
      ],
      [
        ask(
          "2",
          "adresse-bekanntgabe",
          "Wem wurde die Eingangsadresse mitgeteilt, und wie wird sichergestellt, dass Lieferanten sie verwenden?",
          "Ob ein Lieferant an die richtige Adresse schickt, entscheidet sich außerhalb des Systems.",
        ),
      ],
    ),

    section(
      "3",
      "Prüfung des Belegs",
      "belegbox",
      "GoBD Rz. 36 ff.",
      [
        "Die Prüfung läuft in vier Schichten, und die erste Trennung ist die wichtigste: Form und Inhalt werden getrennt beurteilt und getrennt ausgewiesen.",
        "Die Formprüfung führt der offizielle KoSIT-Validator gegen die veröffentlichte Prüfkonfiguration aus - XSD-Schema und Schematron nach EN 16931 und XRechnung. Das Ergebnis ist das Urteil dieses Validators, nicht das von Belegbox.",
        "Die Inhaltsprüfung ist Belegbox' eigene und kann eine formal einwandfreie Rechnung beanstanden. Sie besteht aus fest kodierten fachlichen Regeln und aus Regeln des mandantenbezogenen Regelsatzes. Regeln des Regelsatzes können ausschließlich inhaltliche Befunde erzeugen; ein Formfehler kann dort nicht entstehen.",
        "Maßgeblich für die Auswahl der Regeln ist das Rechnungsdatum des Belegs, nicht der Zeitpunkt der Prüfung. Eine Rechnung aus 2025 wird nach dem Recht von 2025 beurteilt, auch wenn sie 2027 erneut betrachtet wird.",
        "Zu jedem Befund werden die Versionen festgehalten, die ihn erzeugt haben: Prüfkonfiguration, Prüf-Engine und Regelsatz. Damit lässt sich ein Befund später auf denselben Stand zurückführen. Die unten genannten Prüfstände sind die, unter denen die Belege dieses Mandanten tatsächlich beurteilt wurden - nicht der Stand, der heute laufen würde.",
      ],
      [
        configFact("validator_config", "Prüfkonfiguration", validator.validatorConfigVersion, "versions.properties", "validator.config.version"),
        configFact("validator_sha", "Prüfsumme der Prüfkonfiguration", validator.validatorConfigSha256, "versions.properties", "validator.config.sha256"),
        configFact("kosit_version", "KoSIT-Validator", validator.kositVersion, "versions.properties", "kosit.validationtool.version"),
        codeFact("engine_version", "Prüf-Engine", validator.engineVersion, "@belegbox/validation"),
        ruleset
          ? dbFact("ruleset", "Regelsatz", `${ruleset.template}, Version ${ruleset.version}, ${ruleset.ruleCount} Regeln`, "rulesets")
          : dbFact("ruleset", "Regelsatz", "kein mandantenbezogener Regelsatz zugewiesen", "rulesets"),
        codeFact("rule_selection", "Regelauswahl nach", "Rechnungsdatum (BT-2)", "@belegbox/rules-engine"),
        dbFact(
          "versions_in_archive",
          "Prüfstände im Bestand",
          describeVersionsInArchive(validator.versionsInArchive),
          "findings",
        ),
      ],
      [
        ask(
          "3",
          "umgang-mit-befunden",
          "Wer sieht einen inhaltlichen Befund an, in welcher Frist, und wie wird die Klärung mit dem Lieferanten festgehalten?",
          "Belegbox zeichnet den Befund auf; was daraufhin geschieht, ist ein Arbeitsablauf des Unternehmens.",
        ),
        ask(
          "3",
          "freigabe",
          "Wer gibt eine Rechnung sachlich und rechnerisch frei, und ab welchem Betrag ist eine zweite Person beteiligt?",
          "Das interne Kontrollsystem nach GoBD Rz. 100 beschreibt das Unternehmen selbst.",
        ),
      ],
    ),

    section(
      "4",
      "Anwenderdokumentation und Zugriffsrechte",
      "shared",
      "GoBD Rz. 100, 151",
      [
        "Der Zugang zu den Belegen dieses Mandanten ist an ein Benutzerkonto gebunden. Jedes Konto trägt genau eine Rolle, und die Rolle bestimmt, was das Konto sehen und auslösen kann.",
        "Die Trennung zwischen Mandanten wird nicht in der Anwendung entschieden, sondern in der Datenbank: jede Abfrage läuft unter einer Mandantenkennung, und die Datenbank blendet fremde Zeilen aus, bevor die Anwendung sie sieht. Die Anwendung verbindet sich zu diesem Zweck mit einer Rolle, die diese Beschränkung nicht umgehen kann; beim Start wird das geprüft und ein Start mit zu weiten Rechten abgebrochen.",
        "Jeder verändernde Vorgang wird mit Zeitpunkt, handelndem Konto und Vorher-Nachher-Wert in ein Protokoll geschrieben, das nur angehängt und nicht geändert werden kann.",
      ],
      [
        dbFact("user_count", "Benutzerkonten", String(users.length), "users"),
        dbFact(
          "user_roles",
          "Rollenverteilung",
          summariseRoles(users.map((user) => user.role)),
          "users",
        ),
        dbFact(
          "user_mfa",
          "Konten mit zweitem Faktor",
          `${users.filter((user) => user.mfaEnabled).length} von ${users.length}`,
          "users",
        ),
        codeFact("rls", "Mandantentrennung", "Row Level Security in PostgreSQL", "@belegbox/db"),
        codeFact("audit", "Protokollierung", "audit_log, nur anfügbar", "@belegbox/db"),
      ],
      [
        ask(
          "4",
          "rollenzuordnung",
          "Welche Person steht hinter welchem Konto, und wer entscheidet über die Vergabe einer Rolle?",
          "Belegbox kennt die E-Mail-Adresse und die Rolle, nicht die Person und nicht die Vertretungsregelung.",
        ),
        ask(
          "4",
          "austritt",
          "Wie wird ein Konto beim Ausscheiden einer Person gesperrt, und wer prüft das nach?",
          "Der Anstoß dazu kommt aus dem Unternehmen, nicht aus dem System.",
        ),
        ask(
          "4",
          "einweisung",
          "Wie werden Mitarbeitende in den Umgang mit dem System eingewiesen, und wo ist das festgehalten?",
          "GoBD Rz. 151 verlangt eine Anwenderdokumentation; das System kann nur seinen eigenen Teil beisteuern.",
        ),
      ],
    ),

    section(
      "5",
      "Aufbewahrung und Unveränderbarkeit",
      "belegbox",
      "GoBD Rz. 107 ff., § 14b UStG",
      [
        "Das empfangene Original wird unverändert abgelegt - dieselben Bytes, die eingegangen sind, ohne Umwandlung in ein anderes Format.",
        storage.objectLockMode
          ? prose`Die Ablage erfolgt mit S3 Object Lock im Modus ${storage.objectLockMode} und einer Aufbewahrungsfrist bis zum Ende des zehnten Kalenderjahres nach Eingang. Im Modus COMPLIANCE kann die Frist auch vom Kontoinhaber nicht verkürzt und das Objekt bis zu ihrem Ablauf nicht gelöscht oder überschrieben werden.`
          : "Die Ablage erfolgt derzeit ohne Object Lock. Eine technische Sperre gegen Löschen besteht damit nicht.",
        "Zusätzlich wird jeder Tag zu einem Merkle-Baum nach RFC 6962 verdichtet. Die Wurzel eines Tages nimmt die Wurzel des Vortages auf, sodass die Tage eine Kette bilden. Zu jedem einzelnen Beleg lässt sich daraus ein Nachweis erzeugen, dass genau dieser Beleg in genau diesem Tag enthalten war; eine nachträgliche Änderung an einem älteren Beleg bricht die Kette an einer sichtbaren Stelle.",
        "Belege werden nicht gelöscht. Eine Korrektur entsteht als neuer Beleg, der auf den korrigierten verweist.",
      ],
      [
        codeFact("storage_backend", "Ablage", storage.backend, "@belegbox/storage"),
        codeFact("storage_bucket", "Speicherort", storage.bucket, "@belegbox/storage"),
        codeFact("object_lock", "Object Lock", storage.objectLockMode ?? "nicht aktiv", "@belegbox/storage"),
        tenantFact("retention_invoices", "Aufbewahrung Rechnungen", `${tenant.retentionPolicy.invoices_years} Jahre`, "tenants.retention_policy"),
        tenantFact("retention_vouchers", "Aufbewahrung sonstige Belege", `${tenant.retentionPolicy.vouchers_years} Jahre`, "tenants.retention_policy"),
        dbFact("sealed_days", "Versiegelte Archivtage", String(archive.sealedDays), "archive_chain"),
        dbFact(
          "chain_span",
          "Kette umfasst",
          archive.firstSealedDay && archive.lastSealedDay
            ? `${germanDate(archive.firstSealedDay)} bis ${germanDate(archive.lastSealedDay)}`
            : "noch kein Tag versiegelt",
          "archive_chain",
        ),
        dbFact("latest_root", "Jüngste Tageswurzel", archive.latestRoot ?? "noch keine", "archive_chain"),
      ],
      [
        ask(
          "5",
          "auslagerung",
          "In welchem Rechenzentrum liegen die Daten, und liegt für die Auslagerung eine Vereinbarung nach § 146 Abs. 2a AO vor?",
          "Der Ort der Datenverarbeitung und die Vereinbarung darüber sind Sache des Unternehmens.",
        ),
        ask(
          "5",
          "beendigung",
          "Wie wird die Aufbewahrung sichergestellt, wenn das Vertragsverhältnis mit Belegbox endet?",
          "Die Frist nach § 14b UStG läuft unabhängig vom Vertrag weiter.",
        ),
      ],
    ),

    section(
      "6",
      "Technische Systemdokumentation",
      "belegbox",
      "GoBD Rz. 151",
      [
        "Der Stand der Datenbank ist durch eine geordnete Folge von Migrationen bestimmt. Migrationen werden nur vorwärts angewendet; eine bereits ausgelieferte Migration wird nicht mehr geändert.",
        "Die Prüfkomponenten sind auf feste Versionen gebunden. Die Prüfkonfiguration wird beim Abruf gegen ihre Prüfsumme gehalten, damit eine nachträglich ausgetauschte Veröffentlichung auffällt und nicht unbemerkt verändert, was als formal richtig gilt.",
      ],
      [
        dbFact("migration_count", "Angewendete Migrationen", String(migrations.length), "schema_migrations"),
        dbFact(
          "migration_latest",
          "Letzte Migration",
          migrations.length > 0
            ? `${migrations[migrations.length - 1]?.name} (${germanDate(migrations[migrations.length - 1]?.appliedAt ?? new Date(0))})`
            : "keine",
          "schema_migrations",
        ),
        configFact("config_digest", "Prüfsumme der Prüfkonfiguration", validator.validatorConfigSha256, "versions.properties", "validator.config.sha256"),
      ],
      [
        ask(
          "6",
          "notfall",
          "Wie wird der Zugriff auf die Belege wiederhergestellt, wenn das System ausfällt, und wann wurde das zuletzt erprobt?",
          "Eine Wiederherstellung, die nie erprobt wurde, ist eine Annahme.",
        ),
      ],
    ),
  ];
}

/**
 * The pipeline records `unavailable` when the validator could not be reached at
 * the time a document was judged. Left as-is it reads like a missing value; it
 * is in fact a statement about those documents, and the document says which.
 */
function describeVersionsInArchive(versions: string[]): string {
  if (versions.length === 0) return "noch kein Beleg geprüft";
  return versions
    .map((version) =>
      version === "unavailable"
        ? "ohne erreichbaren Validator geprüft"
        : version,
    )
    .join(", ");
}

/** "1 Inhaber, 2 Buchhaltung" - stable order, so the hash does not drift. */
function summariseRoles(roles: string[]): string {
  const labels: Record<string, string> = {
    owner: "Inhaber",
    accountant: "Buchhaltung",
    approver: "Freigabe",
    viewer: "Lesezugriff",
    api: "Schnittstelle",
  };
  const counts = new Map<string, number>();
  for (const role of roles) counts.set(role, (counts.get(role) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([role, count]) => `${count} ${labels[role] ?? role}`)
    .join(", ");
}

export { germanDateTime };

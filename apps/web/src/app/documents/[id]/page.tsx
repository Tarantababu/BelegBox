import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getDocument, getTenant, type Finding } from "../../../lib/api";
import { STATUS_META, VERDICT_META } from "../../../lib/status";
import { Chrome } from "../../nav";
import { PaymentPanel } from "./payment";

export const dynamic = "force-dynamic";

const SEVERITY_CLASS: Record<string, string> = {
  form_error: "bad",
  content_error: "bad",
  warning: "warn",
  info: "",
};

const LAYER_LABEL: Record<string, string> = {
  l1_schema: "L1 · Schema (XSD)",
  l2_schematron: "L2 · Schematron (KoSIT)",
  l3_domain: "L3 · Fachprüfung (Belegbox)",
  l4_tenant: "L4 · Eigenes Regelwerk",
};

function FindingCard({ finding, locale }: { finding: Finding; locale: string }) {
  const explanation = finding.explanation;

  return (
    <div className="sec">
      <p className="lbl">
        {LAYER_LABEL[finding.layer] ?? finding.layer} · {finding.code}
        {finding.btRef ? ` · ${finding.btRef}` : ""}
      </p>

      {/* The raw validator output, verbatim, next to the explanation and never
          instead of it. Showing what the official tool actually said is the
          transparency the product is arguing for. */}
      <pre className="code">{finding.messageRaw}</pre>

      {explanation ? (
        <div className="ai" style={{ marginTop: 12 }}>
          <p className="lbl">Was das bedeutet</p>
          <p>{explanation.observation}</p>
          {explanation.legalBasis ? <p className="basis">{explanation.legalBasis}</p> : null}
          {explanation.nextStep ? <p className="step">{explanation.nextStep}</p> : null}

          {/* The German text travels with every finding so it can be forwarded
              to a supplier or a Steuerberater without the user translating
              their own problem (PRD § 5.4). */}
          {locale !== "de" ? (
            <details>
              <summary>Auf Deutsch — zum Weiterleiten an Lieferant oder Steuerberatung</summary>
              <p>{explanation.german.observation}</p>
              <p className="basis">{explanation.german.legalBasis}</p>
              <p className="disclaimer">{explanation.german.disclaimer}</p>
            </details>
          ) : null}

          {/* Appended by the renderer, not by the template. It cannot be
              switched off, which is the point (StBerG § 2-5). */}
          <p className="disclaimer">{explanation.disclaimer}</p>

          {explanation.fallback ? (
            <p className="disclaimer">
              Für diese Regel gibt es noch keinen geprüften Erklärungstext. Oben
              steht die Rohausgabe des Validators.
            </p>
          ) : null}
          {!explanation.approved ? (
            <p className="disclaimer">
              Entwurfstext — die juristische Prüfung dieser Erklärung steht noch aus.
            </p>
          ) : null}
        </div>
      ) : null}

      {Object.keys(finding.params).length > 0 ? (
        <table className="led" style={{ marginTop: 12 }}>
          <tbody>
            {Object.entries(finding.params).map(([key, value]) => (
              <tr key={key}>
                <td>{key.replace(/_/g, " ")}</td>
                <td>{String(value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

export default async function DocumentDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const tenant = await getTenant();
  if (!tenant) redirect("/login");

  const { id } = await params;
  const doc = await getDocument(id);
  if (!doc) notFound();

  const form = VERDICT_META[doc.verdict.form];
  const content = VERDICT_META[doc.verdict.content];
  const status = STATUS_META[doc.status];

  const errors = doc.findings.filter((f) => f.severity.endsWith("_error"));
  const warnings = doc.findings.filter((f) => f.severity === "warning");
  const rest = doc.findings.filter(
    (f) => !f.severity.endsWith("_error") && f.severity !== "warning",
  );

  return (
    <div className="shell">
      <Chrome tenantName={tenant.name} current="inbox" />

      <Link className="back" href="/inbox">
        ← Eingang
      </Link>

      <div className="pad" style={{ paddingTop: 0 }}>
        <h2>{tenant.locale === "tr" ? status.tr : status.de}</h2>
        <p className="sub">
          {doc.format ? doc.format.replace(/_/g, " ") : "unbekanntes Format"}
          {doc.archivedAt ? " · archiviert" : ""}
        </p>
      </div>

      {/* Two independent judgements, side by side. A document can be
          syntactically perfect and materially wrong, and merging these into one
          score would hide exactly the case the product exists for. */}
      <div className="sec">
        <div className="verdicts">
          <div className={`vd ${form.cls}`}>
            <p className="vt">Formprüfung (KoSIT)</p>
            <p className="vv">{tenant.locale === "tr" ? form.tr : form.de}</p>
          </div>
          <div className={`vd ${content.cls}`}>
            <p className="vt">Inhaltsprüfung (Belegbox)</p>
            <p className="vv">{tenant.locale === "tr" ? content.tr : content.de}</p>
          </div>
        </div>
        {doc.verdict.form === "unknown" ? (
          <p className="note" style={{ marginTop: 10 }}>
            Die Formprüfung konnte nicht ausgeführt werden — der KoSIT-Validator
            war nicht erreichbar. Belegbox rät kein Ergebnis; das Urteil bleibt
            offen, bis die Prüfung durchläuft.
          </p>
        ) : null}
      </div>

      <PaymentPanel id={doc.id} locale={tenant.locale} />

      {[...errors, ...warnings, ...rest].map((finding) => (
        <FindingCard key={finding.id} finding={finding} locale={tenant.locale} />
      ))}

      {doc.findings.length === 0 ? (
        <div className="sec">
          <p className="note">Keine Beanstandungen.</p>
        </div>
      ) : null}

      <div className="sec">
        <p className="lbl">Nachweis</p>
        <table className="led">
          <tbody>
            <tr>
              <td>Profil</td>
              <td>{doc.profileUrn ?? "—"}</td>
            </tr>
            <tr>
              <td>Eingegangen</td>
              <td>{new Date(doc.receivedAt).toLocaleString("de-DE")}</td>
            </tr>
            {doc.findings[0] ? (
              <>
                <tr>
                  <td>Validator-Konfiguration</td>
                  <td>{doc.findings[0].versions.validatorConfig}</td>
                </tr>
                <tr>
                  <td>Prüf-Engine</td>
                  <td>{doc.findings[0].versions.engine}</td>
                </tr>
              </>
            ) : null}
          </tbody>
        </table>
        <p className="note" style={{ marginTop: 10 }}>
          Diese Versionen gehören zum Urteil, damit es sich später
          nachvollziehen lässt.
        </p>
      </div>
    </div>
  );
}

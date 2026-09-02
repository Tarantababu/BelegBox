import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getDocument, getTenant, type Finding } from "../../../lib/api";
import { FORMAT_LOCALE, explanationLanguage, type Key, type Translate } from "../../../lib/i18n";
import { resolveUi } from "../../../lib/i18n/server";
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

const LAYER_KEY: Record<string, Key> = {
  l1_schema: "doc.layer.l1",
  l2_schematron: "doc.layer.l2",
  l3_domain: "doc.layer.l3",
  l4_tenant: "doc.layer.l4",
};

function FindingCard({ finding, t }: { finding: Finding; t: Translate }) {
  const explanation = finding.explanation;
  const layer = LAYER_KEY[finding.layer];

  return (
    <div className="sec">
      <p className="lbl">
        {layer ? t(layer) : finding.layer} · {finding.code}
        {finding.btRef ? ` · ${finding.btRef}` : ""}
      </p>

      {/* The raw validator output, verbatim, next to the explanation and never
          instead of it. Showing what the official tool actually said is the
          transparency the product is arguing for. */}
      <pre className="code">{finding.messageRaw}</pre>

      {explanation ? (
        <div className="ai" style={{ marginTop: 12 }}>
          <p className="lbl">{t("doc.whatItMeans")}</p>
          <p>{explanation.observation}</p>
          {explanation.legalBasis ? <p className="basis">{explanation.legalBasis}</p> : null}
          {explanation.nextStep ? <p className="step">{explanation.nextStep}</p> : null}

          {/* The German text travels with every finding so it can be forwarded
              to a supplier or a Steuerberater without the user translating
              their own problem (PRD § 5.4). Keyed off the language the
              explanation actually came back in - which, for the eight
              interface languages with no reviewed wording, is already German,
              and repeating it under a "in German" heading would be absurd. */}
          {explanation.locale !== "de" ? (
            <details>
              <summary>{t("doc.germanSummary")}</summary>
              <p>{explanation.german.observation}</p>
              <p className="basis">{explanation.german.legalBasis}</p>
              <p className="disclaimer">{explanation.german.disclaimer}</p>
            </details>
          ) : null}

          {/* Appended by the renderer, not by the template. It cannot be
              switched off, which is the point (StBerG § 2-5). */}
          <p className="disclaimer">{explanation.disclaimer}</p>

          {explanation.fallback ? <p className="disclaimer">{t("doc.noTemplate")}</p> : null}
          {!explanation.approved ? <p className="disclaimer">{t("doc.draft")}</p> : null}
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
  const { t, lang } = await resolveUi();

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
      <Chrome tenantName={tenant.name} current="inbox" t={t} />

      <Link className="back" href="/inbox">
        ← {t("nav.inbox")}
      </Link>

      <div className="pad" style={{ paddingTop: 0 }}>
        <h2>{t(status.key)}</h2>
        <p className="sub">
          {doc.format ? doc.format.replace(/_/g, " ") : t("doc.unknownFormat")}
          {doc.archivedAt ? ` · ${t("doc.archived")}` : ""}
        </p>
      </div>

      {/* Two independent judgements, side by side. A document can be
          syntactically perfect and materially wrong, and merging these into one
          score would hide exactly the case the product exists for. */}
      <div className="sec">
        <div className="verdicts">
          <div className={`vd ${form.cls}`}>
            <p className="vt">{t("doc.formCheck")}</p>
            <p className="vv">{t(form.key)}</p>
          </div>
          <div className={`vd ${content.cls}`}>
            <p className="vt">{t("doc.contentCheck")}</p>
            <p className="vv">{t(content.key)}</p>
          </div>
        </div>
        {doc.verdict.form === "unknown" ? (
          <p className="note" style={{ marginTop: 10 }}>
            {t("doc.unknownNote")}
          </p>
        ) : null}
      </div>

      <PaymentPanel id={doc.id} t={t} explainLang={explanationLanguage(lang)} />

      {[...errors, ...warnings, ...rest].map((finding) => (
        <FindingCard key={finding.id} finding={finding} t={t} />
      ))}

      {doc.findings.length === 0 ? (
        <div className="sec">
          <p className="note">{t("doc.noFindings")}</p>
        </div>
      ) : null}

      <div className="sec">
        <p className="lbl">{t("doc.evidence")}</p>
        <table className="led">
          <tbody>
            <tr>
              <td>{t("doc.profile")}</td>
              <td>{doc.profileUrn ?? "—"}</td>
            </tr>
            <tr>
              <td>{t("doc.received")}</td>
              <td>{new Date(doc.receivedAt).toLocaleString(FORMAT_LOCALE)}</td>
            </tr>
            {doc.findings[0] ? (
              <>
                <tr>
                  <td>{t("doc.validatorConfig")}</td>
                  <td>{doc.findings[0].versions.validatorConfig}</td>
                </tr>
                <tr>
                  <td>{t("doc.engine")}</td>
                  <td>{doc.findings[0].versions.engine}</td>
                </tr>
              </>
            ) : null}
          </tbody>
        </table>
        <p className="note" style={{ marginTop: 10 }}>
          {t("doc.versionsNote")}
        </p>
      </div>
    </div>
  );
}

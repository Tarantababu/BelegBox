"use client";

import { useState } from "react";
import { translator, type Dict } from "../../../lib/i18n";

export function CopyBlock({ text, mono, dict }: { text: string; mono?: boolean; dict: Dict }) {
  const t = translator(dict);
  const [copied, setCopied] = useState(false);

  return (
    <>
      <pre className="code" style={mono ? { fontSize: 15, letterSpacing: "0.06em" } : undefined}>
        {text}
      </pre>
      <button
        className="btn"
        style={{ marginTop: 10 }}
        onClick={() => {
          navigator.clipboard?.writeText(text).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            },
            () => setCopied(false),
          );
        }}
      >
        {copied ? t("common.copied") : t("common.copy")}
      </button>
    </>
  );
}

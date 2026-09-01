"use client";

import { useState } from "react";

export function CopyBlock({ text, mono }: { text: string; mono?: boolean }) {
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
        {copied ? "Kopiert" : "Kopieren"}
      </button>
    </>
  );
}

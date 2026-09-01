"use client";

import { useState } from "react";

export function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <>
      <pre className="code">{text}</pre>
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

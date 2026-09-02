import type { Metadata } from "next";
import type { ReactNode } from "react";
import { resolveUi } from "../lib/i18n/server";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await resolveUi();
  return { title: "Belegbox", description: t("meta.description") };
}

/**
 * `lang` and `dir` come from the reader, not from a constant.
 *
 * `lang` is what a screen reader picks a voice from and what the browser
 * hyphenates by; `dir` is the one thing Arabic needs that no amount of
 * translated strings supplies. Setting them here rather than per page means a
 * screen that forgets cannot exist.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const { lang, dir } = await resolveUi();

  return (
    <html lang={lang} dir={dir}>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Fira+Mono:wght@400;500&family=Fira+Sans:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* The reset link is a credential in a URL. Without this it rides along
            in the Referer header of every font and stylesheet request. */}
        <meta name="referrer" content="no-referrer" />
      </head>
      <body>{children}</body>
    </html>
  );
}

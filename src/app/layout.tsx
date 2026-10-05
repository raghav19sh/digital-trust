import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "DigiTrust — Digital Trust Intelligence",
  description:
    "Analyze articles and claims for credibility signals, published fact-checks, source reputation, news coverage, and linguistic red flags.",
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL || "https://digitrust.sharma-raghav.com",
  ),
  robots: { index: true, follow: true },
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
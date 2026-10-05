import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.NEXT_PUBLIC_SITE_URL || "https://digitrust.sharma-raghav.com";
  return ["", "/how-it-works", "/privacy"].map((path) => ({
    url: base + path,
    lastModified: new Date(),
  }));
}
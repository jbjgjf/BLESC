/**
 * What crawlers are told (#249).
 *
 * This is a research pilot with minors, and `blesc.online` is a real
 * deployment. What matters is not the pages' contents, which are behind sign-in,
 * but their URLs appearing in a public index: a searchable `/pilot/join` does
 * not fit a protocol that recruits by invitation code only (§2), and listing
 * `/pilot/triage` or `/educator` maps out the operator surfaces for anyone
 * looking.
 *
 * Two layers, because `robots.txt` is a request and not every crawler honours
 * it: this file, and a `noindex, nofollow` default on the root layout that a
 * page has to override on purpose to be indexed.
 */

import type { MetadataRoute } from "next";

/**
 * Closed on every deployment, pilot or not. Each entry also covers what sits
 * under it (`/pilot` closes `/pilot/join`).
 */
export const PRIVATE_PATHS = [
  "/api/",
  "/pilot",
  "/educator",
  "/oversight",
  "/research",
  "/journal",
  "/chat",
  "/timeline",
  "/insights",
  "/graph",
  "/recall",
  "/reflect",
  "/audit",
  "/sharing",
  "/support-summary",
  "/evaluation",
  "/consent",
  "/guardian",
  "/login",
  "/legal",
  "/demo",
] as const;

export function robotsPolicy(pilotMode: boolean): MetadataRoute.Robots {
  // A pilot deployment has nothing a search engine should list.
  if (pilotMode) return { rules: { userAgent: "*", disallow: "/" } };
  return { rules: { userAgent: "*", allow: "/", disallow: [...PRIVATE_PATHS] } };
}

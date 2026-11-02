/**
 * Sanitise the `?next=` destination before it reaches the router (#488).
 *
 * `/login?next=…` carries where the visitor was going so they land there after
 * signing in. Three places write it — `routeAccess.decideAccess`, `AuthShell`
 * and `pilotGate` — and every one of them encodes a pathname of this app. The
 * two readers (`app/login/page.tsx`, `AuthShell`) handed the raw parameter to
 * `router.replace()`, which trusts whatever it is given.
 *
 * Next's own `useRouter` reference is explicit about the consequence: "You must
 * not send untrusted or unsanitized URLs to `router.push` or `router.replace`,
 * as this can open your site to cross-site scripting (XSS) vulnerabilities. For
 * example, `javascript:` URLs sent to `router.push` or `router.replace` will be
 * executed in the context of your page."
 *
 * So the parameter was not merely an open redirect. A crafted `/login?next=…`
 * link sent to a participant could run script in this origin the moment they
 * signed in — with their session live — or hand them to a look-alike login on
 * another host. Both matter more here than on an ordinary site, because the
 * people following these links are the high-school participants of the pilot
 * and the thing behind the session is their diary.
 *
 * The rule is therefore the narrowest one the writers can satisfy: a
 * same-origin path reference, nothing else. Anything that leaves the origin, or
 * that could be read as a scheme or an authority, falls back to the default.
 *
 * This deliberately does not try to decide whether the path *exists* or whether
 * the visitor may see it. The server gate (`src/proxy.ts`, `routeAccess.ts`)
 * already answers that on arrival, and duplicating it here would be the second
 * copy of a rule that #287 and #526 are about.
 */

/** Characters the browser strips or treats specially, which can smuggle an authority past a prefix test. */
const SMUGGLES_AUTHORITY = /[\u0000-\u001F\u007F]/;

/**
 * Return `value` when it is a safe same-origin path, and `fallback` otherwise.
 *
 * Accepted: `/`, `/journal`, `/educator/roster?tab=alerts`, `/graph#node-3`.
 * Rejected: `https://evil.example`, `//evil.example`, `/\evil.example`,
 * `javascript:alert(1)`, `data:…`, `../journal`, and anything holding a
 * control character.
 */
export function safeNextPath(value: string | null | undefined, fallback = "/"): string {
  if (typeof value !== "string" || value === "") return fallback;

  // A control character anywhere is enough to disqualify it: `"/\u0000/evil"`
  // and `"\u0009//evil"` are read as authorities once the browser has stripped
  // what it ignores, so there is no safe way to keep the rest of the string.
  if (SMUGGLES_AUTHORITY.test(value)) return fallback;

  // Must be an absolute path reference. This is also what rules out every
  // scheme, `javascript:` included: a scheme cannot appear before the slash.
  if (!value.startsWith("/")) return fallback;

  // `//host` is a protocol-relative URL and `/\host` is normalised to it by
  // browsers. Both name another origin while beginning with a slash.
  if (value.length > 1 && (value[1] === "/" || value[1] === "\\")) return fallback;

  return value;
}

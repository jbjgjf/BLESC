/**
 * Where the browser sends `POST /entries` and `/audio/transcriptions` (#345).
 *
 * `NEXT_PUBLIC_API_URL` points the client at FastAPI instead of the route
 * handlers in `src/app/api`. That is right for local development and for the
 * evaluation setup. On a pilot deployment it is a way around the one promise
 * `lib/server/collectionMode.ts` exists to keep: FastAPI has no collection-only
 * gate, so a participant's journal text would go to it — and from there to a
 * model provider — without the gate ever being asked.
 *
 * So a pilot build does not honour the variable. Both values are inlined at
 * build time, which is why they are passed in rather than read here: the
 * caller has to write `process.env.NEXT_PUBLIC_…` as a literal expression for
 * the bundler to replace it.
 */
export function resolveApiBaseUrl(env: {
  /** `process.env.NEXT_PUBLIC_PILOT_MODE` */
  pilotMode: string | undefined;
  /** `process.env.NEXT_PUBLIC_API_URL` */
  apiUrl: string | undefined;
}): { baseUrl: string; ignoredApiUrl: boolean } {
  const configured = (env.apiUrl ?? "").trim();
  if (!configured) return { baseUrl: "/api", ignoredApiUrl: false };
  // The same comparison `next.config.ts` and `opsConfig.ts` make: only "1".
  if (env.pilotMode === "1") return { baseUrl: "/api", ignoredApiUrl: true };
  return { baseUrl: configured, ignoredApiUrl: false };
}

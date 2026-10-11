// Stands in for `src/lib/server/supabaseWriter.ts` under `route-loader.mjs`.
export function serviceRoleClient() {
  return globalThis.__testServiceClient ?? null;
}

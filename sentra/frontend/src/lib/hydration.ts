"use client";

import { useSyncExternalStore } from "react";

/** Nothing to subscribe to — hydration happens once and never reverses. */
const subscribe = () => () => {};

/**
 * False while the server renders and during hydration, true immediately after.
 *
 * Auth-gated shells swap a loader for real content as soon as Supabase resolves
 * the session, and `onAuthStateChange` fires INITIAL_SESSION early enough to
 * land mid-hydration — so without this the client's first render disagrees with
 * the server HTML and React throws a hydration error. Reading it through an
 * external store keeps the check out of an effect, which would otherwise
 * cascade an extra render on every mount.
 */
export function useIsHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

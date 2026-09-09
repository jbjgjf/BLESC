/**
 * Whether an AI surface may render for the signed-in participant (#165).
 *
 * The protocol stops AI replies, generated advice and the personal graph for
 * the length of the collection window. The API side already withholds every
 * external call (`collectionMode.ts`), so nothing a participant does reaches a
 * provider — but a screen that still renders, still argues with them about why
 * it is empty, and still puts a model's reading of their week in front of them
 * is an intervention in the middle of the measurement even when no request
 * leaves the server.
 *
 * So the screens are removed rather than emptied, and removed on the server:
 * `AppNav` sits above these routes and cannot see the pilot context, and a
 * client-side check is a check the client can decline to run.
 *
 * Off entirely unless the deployment is a pilot deployment — same switch as the
 * rest of the gate.
 */

import { collectionOnlyForUser } from "./collectionMode";
import { pilotGateEnforced } from "./pilotGate";
import { serverUser } from "./session";
import { serviceRoleClient } from "./supabaseWriter";

/** Where a participant inside the window is sent instead. The journal is the
 *  one screen the study asks them to use, so it is the honest destination. */
export const COLLECTION_ONLY_DESTINATION = "/journal";

export async function collectionOnlyForCurrentUser(): Promise<boolean> {
  if (!pilotGateEnforced()) return false;

  const session = await serverUser();
  if (!session) return false;

  return collectionOnlyForUser(serviceRoleClient(), session.user.id);
}

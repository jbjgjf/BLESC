/**
 * The ten dry-run invitation codes (#168), in one place.
 *
 * Fixed rather than random so the operator can reproduce them without a stored
 * list. They have the shape of a real code — four groups of five Crockford
 * symbols — because the redeem route normalises what is typed and refuses
 * anything of another length before it hashes. The earlier `DRYRUN-0001` was
 * ten symbols and contained a `U`, which is not in the alphabet: no route
 * would have accepted it.
 */

export const DRY_RUN_STUDY_ID = "22222222-1111-0000-0000-000000000000";

/** `DRYRN-00000-00000-00001` .. `DRYRN-00000-00000-00010`. */
export function dryRunInviteCode(accountId) {
  return `DRYRN-00000-00000-${String(accountId).padStart(5, "0")}`;
}

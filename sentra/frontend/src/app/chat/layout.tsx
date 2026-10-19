/**
 * The same server-side gate as `/journal` (#344).
 *
 * A conversation here produces `chat_sessions` and `chat_messages` rows, and
 * on a pilot deployment those belong to the study. Without this layout a
 * withdrawn or never-enrolled account was redirected away from `/journal` but
 * could still open this screen. `POST /api/chat` asks the same question again;
 * this keeps the screen from offering what the route will refuse.
 *
 * Does nothing unless `PILOT_STUDY_SLUG` is set, at build time as well as at
 * runtime — see `app/journal/layout.tsx`.
 */

import { requirePilotCollection } from "@/lib/server/pilotPageGate";

export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  await requirePilotCollection("/chat");
  return children;
}

"use client";

/**
 * Whether the screen below is running inside a study collection window (#165).
 *
 * The value is computed on the server — `journal/layout.tsx` already resolves
 * the enrollment to decide whether to render at all — and handed down rather
 * than fetched. A client that asked an endpoint "am I in collection mode?"
 * would add a request to every ordinary user's journal to answer a question
 * that is false for all of them, and would answer it late enough to flash the
 * wrong UI first.
 *
 * What it is for: hiding the surfaces the protocol stops during collection —
 * the AI reply, the adaptive follow-up, the personal graph — and showing the
 * fixed self-report in their place.
 *
 * What it is **not** for: security. Every one of those surfaces is refused on
 * the server for a participant inside the window, and this context only
 * decides what is drawn. A participant who edits the flag in their own bundle
 * gets a screen with buttons that return an error, which is the correct
 * outcome for a display flag being wrong.
 */

import { createContext, useContext } from "react";

export type PilotMode = {
  /** Inside an open collection window: no external AI, fixed items only. */
  collectionOnly: boolean;
  /** The self-report version being asked, when one is. */
  selfReportSchemaId: string | null;
};

const DEFAULT: PilotMode = { collectionOnly: false, selfReportSchemaId: null };

const PilotModeContext = createContext<PilotMode>(DEFAULT);

export function PilotModeProvider({ value, children }: { value: PilotMode; children: React.ReactNode }) {
  return <PilotModeContext.Provider value={value}>{children}</PilotModeContext.Provider>;
}

/** Defaults to "not a pilot screen" outside a provider, which is what every
 *  screen in the ordinary app is. */
export function usePilotMode(): PilotMode {
  return useContext(PilotModeContext);
}

"use client";

import { useSyncExternalStore } from "react";

export const DEFAULT_USER_ID = "research_user_01";

const STORAGE_KEY = "precrisis-graph:user-id";
const CHANGE_EVENT = "precrisis-graph:user-id-change";

export function useStoredUserId() {
  const userId = useSyncExternalStore(
    (onStoreChange) => {
      window.addEventListener("storage", onStoreChange);
      window.addEventListener(CHANGE_EVENT, onStoreChange);
      return () => {
        window.removeEventListener("storage", onStoreChange);
        window.removeEventListener(CHANGE_EVENT, onStoreChange);
      };
    },
    () => window.localStorage.getItem(STORAGE_KEY)?.trim() || DEFAULT_USER_ID,
    () => DEFAULT_USER_ID,
  );

  const setUserId = (nextUserId: string) => {
    const normalized = nextUserId.trim() || DEFAULT_USER_ID;
    window.localStorage.setItem(STORAGE_KEY, normalized);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };

  return { userId, setUserId };
}

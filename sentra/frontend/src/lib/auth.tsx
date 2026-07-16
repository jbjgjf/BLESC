"use client";

import type { Session, User } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase/client";

const DEFAULT_PARTICIPANT_CODE = "research_user_01";

type Participant = {
  id: string;
  code: string;
  display_name: string | null;
};

export type EducatorMembership = {
  org_id: string;
  org_name: string;
  role: "educator" | "org_admin";
};

type AuthContextValue = {
  session: Session | null;
  user: User | null;
  participant: Participant | null;
  userId: string;
  isLoading: boolean;
  educatorMemberships: EducatorMembership[];
  isEducator: boolean;
  setUserId: (nextUserId: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshParticipant: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

async function ensureUserProfile(user: User) {
  const { error } = await supabase.from("profiles").upsert({
    id: user.id,
    owner_user_id: user.id,
    email: user.email,
    display_name: user.user_metadata?.display_name ?? user.email ?? null,
  });

  if (error) throw error;
}

async function ensureParticipant(user: User): Promise<Participant> {
  await ensureUserProfile(user);

  const existing = await supabase
    .from("participants")
    .select("id, code, display_name")
    .eq("owner_user_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (existing.error) throw existing.error;
  if (existing.data) return existing.data;

  const created = await supabase
    .from("participants")
    .insert({
      owner_user_id: user.id,
      code: DEFAULT_PARTICIPANT_CODE,
      display_name: "Research participant 01",
    })
    .select("id, code, display_name")
    .single();

  if (created.error) throw created.error;
  return created.data;
}

async function loadEducatorMemberships(user: User): Promise<EducatorMembership[]> {
  const { data, error } = await supabase
    .from("organization_members")
    .select("org_id, role, organizations(name)")
    .eq("member_user_id", user.id)
    .eq("status", "active");
  if (error) {
    // Non-fatal: before the oversight migrations are applied this table may
    // not exist; the app then simply has no educator surfaces.
    console.info("[supabase-auth] educator membership lookup skipped", error.message);
    return [];
  }
  type Row = { org_id: string; role: string; organizations?: { name: string } | { name: string }[] | null };
  return ((data ?? []) as Row[]).map((row) => {
    const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;
    return {
      org_id: row.org_id,
      org_name: org?.name ?? "Organization",
      role: row.role === "org_admin" ? "org_admin" : "educator",
    };
  });
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [participant, setParticipant] = useState<Participant | null>(null);
  const [educatorMemberships, setEducatorMemberships] = useState<EducatorMembership[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refreshParticipant = useCallback(async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      setParticipant(null);
      return;
    }
    setParticipant(await ensureParticipant(data.user));
  }, []);

  useEffect(() => {
    let isMounted = true;

    console.info("[supabase-auth] initialization started");

    supabase.auth.getSession().then(async ({ data }) => {
      if (!isMounted) return;
      setSession(data.session);
      console.info("[supabase-auth] initial session", {
        hasSession: Boolean(data.session),
        userId: data.session?.user.id ?? null,
      });
      if (data.session?.user) {
        const [nextParticipant, memberships] = await Promise.all([
          ensureParticipant(data.session.user),
          loadEducatorMemberships(data.session.user),
        ]);
        setParticipant(nextParticipant);
        setEducatorMemberships(memberships);
      }
      setIsLoading(false);
    }).catch(() => {
      if (!isMounted) return;
      console.info("[supabase-auth] initial session failed");
      setSession(null);
      setParticipant(null);
      setEducatorMemberships([]);
      setIsLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      console.info("[supabase-auth] state change", {
        event: _event,
        hasSession: Boolean(nextSession),
        userId: nextSession?.user.id ?? null,
      });
      setSession(nextSession);
      if (!nextSession?.user) {
        setParticipant(null);
        setEducatorMemberships([]);
        setIsLoading(false);
        return;
      }
      Promise.all([
        ensureParticipant(nextSession.user).then(setParticipant),
        loadEducatorMemberships(nextSession.user).then(setEducatorMemberships),
      ]).finally(() => setIsLoading(false));
    });

    return () => {
      isMounted = false;
      listener.subscription.unsubscribe();
    };
  }, []);

  const setUserId = useCallback(async (nextUserId: string) => {
    if (!session?.user || !participant) return;
    const normalized = nextUserId.trim() || DEFAULT_PARTICIPANT_CODE;
    const { data, error } = await supabase
      .from("participants")
      .update({ code: normalized })
      .eq("id", participant.id)
      .select("id, code, display_name")
      .single();

    if (error) throw error;
    setParticipant(data);
  }, [participant, session?.user]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setSession(null);
    setParticipant(null);
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    session,
    user: session?.user ?? null,
    participant,
    userId: participant?.code ?? DEFAULT_PARTICIPANT_CODE,
    isLoading,
    educatorMemberships,
    isEducator: educatorMemberships.length > 0,
    setUserId,
    signOut,
    refreshParticipant,
  }), [educatorMemberships, isLoading, participant, refreshParticipant, session, setUserId, signOut]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return context;
}

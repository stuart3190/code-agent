import { useCallback, useEffect, useState } from "react";
import { backend, backendConfigured, client, desktopHost } from "./backend.js";

// Tracks the signed-in user via Supabase's auth state. Returns { user, loading, recovery, clearRecovery }.
// `recovery` flips true when the user arrives via a password-reset email link (Supabase signs them in
// with a recovery session and fires PASSWORD_RECOVERY) — the app must show a set-new-password screen
// before treating them as a normal session.
export function useSession() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [recovery, setRecovery] = useState(false);

  // Desktop mode (Phase 23): the panel injects a PAT — the session IS that token.
  const desktop = desktopHost();

  useEffect(() => {
    if (desktop?.token) {
      setUser({ email: desktop.email || "Connected with API token", desktop: true });
      setLoading(false);
      return;
    }
    if (!backendConfigured) { setLoading(false); return; }
    let active = true;
    backend().auth.currentUser().then((u) => { if (active) { setUser(u); setLoading(false); } });
    const { data: sub } = client().auth.onAuthStateChange((evt, session) => {
      if (!active) return;
      if (evt === "PASSWORD_RECOVERY") setRecovery(true);
      setUser(session?.user ?? null);
    });
    return () => { active = false; sub?.subscription?.unsubscribe?.(); };
  }, []);

  const clearRecovery = useCallback(() => setRecovery(false), []);

  return { user, loading, recovery, clearRecovery };
}

import { useEffect, useState } from "react";
import { backend, backendConfigured, client } from "./backend.js";

// Tracks the signed-in user via Supabase's auth state. Returns { user, loading }.
export function useSession() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!backendConfigured) { setLoading(false); return; }
    let active = true;
    backend().auth.currentUser().then((u) => { if (active) { setUser(u); setLoading(false); } });
    const { data: sub } = client().auth.onAuthStateChange((_evt, session) => {
      if (active) setUser(session?.user ?? null);
    });
    return () => { active = false; sub?.subscription?.unsubscribe?.(); };
  }, []);

  return { user, loading };
}

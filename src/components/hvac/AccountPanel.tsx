import { useState } from "react";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

const schema = z.object({
  email: z.string().trim().email("Enter a valid email address").max(255),
  password: z.string().min(8, "Password must be at least 8 characters").max(72),
});

export function SignInForm() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = schema.safeParse({ email, password });
    if (!parsed.success) return setMsg({ tone: "error", text: parsed.error.issues[0]!.message });
    setBusy(true);
    setMsg(null);
    if (mode === "in") {
      const { error } = await supabase.auth.signInWithPassword(parsed.data);
      if (error) setMsg({ tone: "error", text: error.message });
    } else {
      const { data, error } = await supabase.auth.signUp({ ...parsed.data, options: { emailRedirectTo: window.location.origin } });
      if (error) setMsg({ tone: "error", text: error.message });
      else if (!data.session) setMsg({ tone: "info", text: "Check your email to confirm your account, then sign in." });
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Sign in to generate">
      <p className="text-sm font-medium">Sign in to generate a plan</p>
      <p className="text-xs text-muted-foreground">Plan generation uses a paid model, so it needs an account and has daily limits.</p>
      <input className="field" type="email" autoComplete="email" placeholder="Email" aria-label="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input className="field" type="password" autoComplete={mode === "in" ? "current-password" : "new-password"} placeholder="Password" aria-label="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <button className="btn-primary w-full" disabled={busy} type="submit">{busy ? "Please wait…" : mode === "in" ? "Sign in" : "Create account"}</button>
      <button type="button" className="btn-ghost w-full text-sm" onClick={() => { setMode(mode === "in" ? "up" : "in"); setMsg(null); }}>
        {mode === "in" ? "No account? Create one" : "Have an account? Sign in"}
      </button>
      {msg && <p role="status" className={`status status-${msg.tone}`}>{msg.text}</p>}
    </form>
  );
}

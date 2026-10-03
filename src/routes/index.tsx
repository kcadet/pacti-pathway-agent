import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { generateHvacPlan, getHvacUsage, type UsageSummary } from "@/lib/hvac.functions";
import { supabase } from "@/integrations/supabase/client";
import { SignInForm } from "@/components/hvac/AccountPanel";
import { PROFILE, SOURCES, UNKNOWNS } from "@/lib/hvac/core";
import { clearPlan, loadPlan, resultSchema, savePlan, type StoredResult } from "@/lib/hvac/storage";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "PACTI Pathway Agent — HVAC exploration demo" },
      { name: "description", content: "Synthetic-data demo: a mentor-reviewed four-week HVAC exploration plan generated with NVIDIA Nemotron on Nebius Token Factory." },
      { property: "og:title", content: "PACTI Pathway Agent — HVAC exploration demo" },
      { property: "og:description", content: "Turn a synthetic participant's interests into a mentor-reviewed, source-cited HVAC exploration plan." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

function nextResetUtc() {
  const d = new Date();
  const n = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  return `${n.toISOString().slice(0, 10)} 00:00 UTC`;
}

type Status = { tone: "info" | "ok" | "error"; text: string } | null;

function Index() {
  const generate = useServerFn(generateHvacPlan);
  const fetchUsage = useServerFn(getHvacUsage);
  const [email, setEmail] = useState<string | null | undefined>(undefined);
  const [usage, setUsage] = useState<UsageSummary | null>(null);

  async function refreshUsage() {
    try {
      setUsage(await fetchUsage());
    } catch {
      setUsage(null);
    }
  }

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => setEmail(session?.user.email ?? null));
    supabase.auth.getSession().then(({ data }) => setEmail(data.session?.user.email ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (email) void refreshUsage();
    else setUsage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);
  const [result, setResult] = useState<StoredResult | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status>(null);

  useEffect(() => {
    const l = loadPlan(window.localStorage);
    if (l.status === "ok") {
      setResult(l.result);
      setSaved(true);
      setStatus({ tone: "info", text: "Reloaded the plan saved in this browser." });
    } else if (l.status === "invalid") setStatus({ tone: "error", text: "A saved plan in this browser failed validation and was not loaded." });
    else if (l.status === "error") setStatus({ tone: "error", text: "This browser's storage is unavailable, so saved plans can't load." });
  }, []);

  async function onGenerate() {
    setBusy(true);
    setStatus({ tone: "info", text: "Calling NVIDIA Nemotron via Nebius Token Factory…" });
    try {
      const res = await generate({ data: {} });
      if (!res.ok) {
        setStatus({ tone: "error", text: `${res.code}: ${res.message}` });
        return;
      }
      const parsed = resultSchema.safeParse(res.result);
      if (!parsed.success) {
        setStatus({ tone: "error", text: "PLAN_VALIDATION_FAILED: Response failed client validation." });
        return;
      }
      setResult(parsed.data);
      setSaved(false);
      setStatus({ tone: "ok", text: "New plan generated. Review it with a mentor before acting." });
    } catch (e) {
      setStatus({ tone: "error", text: `Request failed: ${e instanceof Error ? e.message : "unknown error"}` });
    } finally {
      // Always re-read server counts (success, retry, limit or provider error) so the page matches the server.
      await refreshUsage();
      setBusy(false);
    }
  }

  function onSave() {
    const r = savePlan(window.localStorage, result);
    if (r.ok) {
      setSaved(true);
      setStatus({ tone: "ok", text: "Saved in this browser only (localStorage). It reloads when you return." });
    } else setStatus({ tone: "error", text: r.reason === "storage" ? "This browser could not save the plan (storage full or blocked)." : "Plan failed validation and was not saved." });
  }

  function onClear() {
    if (clearPlan(window.localStorage)) {
      setSaved(false);
      setStatus({ tone: "info", text: "Browser-saved plan removed." });
    } else setStatus({ tone: "error", text: "Could not clear browser storage." });
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-5">
          <div className="flex items-baseline gap-3">
            <span className="wordmark">PACTI</span>
            <span className="hidden text-sm text-muted-foreground sm:inline">Pathway Agent</span>
          </div>
          <span className="chip">Synthetic data · Hackathon demo</span>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-10">
        <p className="eyebrow">Nebius × NVIDIA Global AI Hackathon · Best Apps and Agents</p>
        <h1 className="mt-3 max-w-3xl font-display text-4xl leading-tight sm:text-5xl">Turn Maya's interests into a mentor‑reviewed HVAC plan.</h1>
        <p className="mt-4 max-w-2xl text-muted-foreground">
          One synthetic participant, one pathway. Generation runs on NVIDIA Nemotron via Nebius Token Factory, grounded in a reviewed O*NET snapshot. Local programs and openings stay unverified.
        </p>

        <div className="mt-10 grid gap-6 lg:grid-cols-[320px_1fr]">
          <aside className="panel h-fit space-y-5">
            <div>
              <p className="label">Profile · synthetic</p>
              <h2 className="mt-1 font-display text-2xl">{PROFILE.name}</h2>
              <p className="text-sm text-muted-foreground">{PROFILE.location}</p>
            </div>
            {([["Interests", PROFILE.interests], ["Skills", PROFILE.skills], ["Values", PROFILE.values]] as const).map(([k, v]) => (
              <div key={k}>
                <p className="label">{k}</p>
                <div className="mt-2 flex flex-wrap gap-2">{v.map((x) => <span key={x} className="tag">{x}</span>)}</div>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">{PROFILE.readiness}</p>
            <div className="border-t border-border pt-5">
              <p className="label">Pathway</p>
              <p className="mt-1 font-medium">HVAC exploration</p>
            </div>
            {email === undefined ? null : email === null ? (
              <SignInForm />
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="truncate">Signed in as {email}</span>
                  <button className="btn-ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
                </div>
                <button className="btn-primary w-full" disabled={busy} onClick={onGenerate}>
                  {busy ? "Generating…" : "Generate HVAC plan with NVIDIA"}
                </button>
                {usage && (
                  <div className="text-xs text-muted-foreground" aria-label="Usage today">
                    <p>Your model calls today: {usage.userCalls} / {usage.userDailyCalls} (retries count)</p>
                    <p>Demo-wide calls today: {usage.projectCalls} / {usage.projectDailyCalls}</p>
                    <p>Demo-wide token budget today: {usage.projectTokens.toLocaleString()} / {usage.projectDailyTokens.toLocaleString()} tokens</p>
                    <p className="mt-1">Token budget, not dollar cost: each call reserves {usage.reservePerCall.toLocaleString()} tokens until Nebius reports actual usage. Counts reset daily at 00:00 UTC (next reset {nextResetUtc()}).</p>
                  </div>
                )}
              </div>
            )}
            <p role="status" aria-live="polite" className={`status status-${status?.tone ?? "info"}`} hidden={!status}>{status?.text}</p>
          </aside>

          <section className="space-y-6">
            {!result ? (
              <div className="panel text-muted-foreground">
                <p className="label">Plan</p>
                <p className="mt-2">No plan yet. Generate one to see fit hypotheses, a four-week plan, and mentor questions. Nothing is pre-filled.</p>
              </div>
            ) : (
              <>
                <div className="panel">
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="meta">Model · {result.model}</span>
                    <span className="meta">{new Date(result.generatedAt).toLocaleString()}</span>
                    <span className="meta">Latency · {(result.latencyMs / 1000).toFixed(1)}s</span>
                    <span className="meta">{result.tokens ? `Tokens · ${result.tokens.input} in / ${result.tokens.output} out / ${result.tokens.total} total` : "Token usage not reported"}</span>
                    <span className="meta">Cost · not calculated (see Nebius billing)</span>
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">{result.dataMode}</p>
                  <h2 className="mt-5 font-display text-2xl">Fit hypotheses</h2>
                  <p className="mt-2">{result.plan.summary}</p>
                  <ul className="mt-3 list-disc space-y-1 pl-5">{result.plan.fitReasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                  <p className="mt-3 text-xs text-muted-foreground">Hypotheses from stated interests, not a validated prediction. Requires mentor review.</p>
                </div>

                <div className="panel">
                  <h2 className="font-display text-2xl">Four-week plan</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Recommendations are suggestions, not sourced facts. Only occupation facts carry an O*NET citation.
                    {result.removedCitations > 0 && ` ${result.removedCitations} unsupported citation tag${result.removedCitations === 1 ? " was" : "s were"} removed.`}
                    {result.attempts > 1 && " The first draft was rejected and regenerated once."}
                    {result.dedupedFacts > 0 && ` ${result.dedupedFacts} repeated occupation fact${result.dedupedFacts === 1 ? " was" : "s were"} shown only once.`}
                  </p>
                  <ol className="mt-4 grid gap-3 sm:grid-cols-2">
                    {result.plan.weeks.map((w) => (
                      <li key={w.week} className="week">
                        <p className="label">Week {w.week}</p>
                        <p className="mt-2 text-xs font-semibold text-primary">Recommendation · uncited</p>
                        <p className="mt-1">{w.recommendation}</p>
                        {w.occupationNote && (
                          <div className="mt-3 border-t border-border pt-2 text-sm">
                            <p className="text-xs font-semibold text-muted-foreground">Occupation fact</p>
                            <p className="mt-1">
                              {w.occupationNote}{" "}
                              {w.sourceIds.map((id) => { const s = result.sources.find((x) => x.id === id); return s ? <a key={id} className="cite" href={s.url} target="_blank" rel="noreferrer">[{s.id}]</a> : null; })}
                            </p>
                          </div>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>

                <div className="panel">
                  <h2 className="font-display text-2xl">Mentor questions</h2>
                  <ul className="mt-3 list-disc space-y-1 pl-5">{result.plan.mentorQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul>
                  <p className="mt-4 text-sm text-muted-foreground">{result.disclaimer}</p>
                  <div className="mt-5 flex flex-wrap items-center gap-3">
                    <button className="btn-secondary" onClick={onSave}>{saved ? "Saved in this browser ✓" : "Save plan in this browser"}</button>
                    {saved && <button className="btn-ghost" onClick={onClear}>Remove browser save</button>}
                    <span className="text-xs text-muted-foreground">Browser-local save only — not synced anywhere.</span>
                  </div>
                </div>
              </>
            )}

            <div className="grid gap-6 md:grid-cols-2">
              <div className="panel">
                <h2 className="font-display text-xl">Evidence</h2>
                {SOURCES.map((s) => (
                  <div key={s.id} className="mt-3 text-sm">
                    <a className="cite font-medium" href={s.url} target="_blank" rel="noreferrer">{s.title}</a>
                    <p className="mt-1">“{s.evidence}”</p>
                    <p className="mt-1 text-xs text-muted-foreground">id {s.id} · snapshot reviewed {s.reviewedOn} · {s.scope} Not retrieved live.</p>
                  </div>
                ))}
              </div>
              <div className="panel">
                <h2 className="font-display text-xl">Still unknown</h2>
                <ul className="mt-3 space-y-2 text-sm">{UNKNOWNS.map((u) => <li key={u} className="unknown">{u}</li>)}</ul>
              </div>
            </div>
          </section>
        </div>
        <p className="mt-12 text-xs text-muted-foreground">Independent hackathon demo. Synthetic data only. No affiliation with or endorsement by NVIDIA or Nebius is implied.</p>
      </main>
    </div>
  );
}

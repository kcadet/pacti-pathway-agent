import { describe, expect, it } from "vitest";
import { PlanError, generatePlan, resolveConfig, validatePlan, validateRequest } from "./core";
import { STORAGE_KEY, clearPlan, loadPlan, savePlan } from "./storage";

const goodPlan = {
  summary: "Exploring HVAC could fit Maya's hands-on interests.",
  fitReasons: ["Hypothesis: mechanical reasoning aligns with system troubleshooting."],
  weeks: [1, 2, 3, 4].map((week) => ({
    week,
    recommendation: `Week ${week}: contact a local HVAC training provider to ask about schedules.`,
    occupationNote: week === 1 ? "HVAC mechanics and installers work on heating, air conditioning, and refrigeration systems." : null,
    sourceIds: week === 1 ? ["onet-hvac"] : [],
  })),
  mentorQuestions: ["Which local programs are currently enrolling?"],
};
const env = { NEBIUS_API_KEY: "test-key" };
const okFetch = (content: unknown, extra: object = {}) =>
  (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, ...extra }),
      { status: 200 },
    )) as unknown as typeof fetch;

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as PlanError).code;
  }
  return "NO_ERROR";
};

describe("config", () => {
  it("requires key", () => expect(() => resolveConfig({})).toThrow(PlanError));
  it("defaults model and base", () => {
    const c = resolveConfig(env);
    expect(c.model).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(c.base.href).toBe("https://api.tokenfactory.nebius.com/v1/");
  });
  it.each(["http://api.tokenfactory.nebius.com/v1/", "https://evil.com/v1/", "https://api.tokenfactory.nebius.com.evil.com/v1/", "https://api.tokenfactory.nebius.com:8443/v1/", "https://api.tokenfactory.nebius.com/v2/"])(
    "rejects endpoint %s",
    (u) => expect(() => resolveConfig({ ...env, NEBIUS_BASE_URL: u })).toThrow(/Nebius Token Factory/),
  );
  it("rejects non-Nemotron model", () => expect(() => resolveConfig({ ...env, NEBIUS_MODEL: "openai/gpt-4o" })).toThrow(/Nemotron/));
});

describe("request validation", () => {
  it("accepts empty / fixed profile", () => {
    expect(() => validateRequest(undefined)).not.toThrow();
    expect(() => validateRequest({})).not.toThrow();
    expect(() => validateRequest({ profile: "synthetic-maya" })).not.toThrow();
  });
  it("rejects custom payloads", () => {
    expect(() => validateRequest({ prompt: "x" })).toThrow();
    expect(() => validateRequest({ profile: "x".repeat(500) })).toThrow();
    expect(() => validateRequest([1])).toThrow();
  });
});

describe("generatePlan", () => {
  it("missing key", async () => expect(await code(generatePlan({ env: {}, fetchImpl: okFetch(goodPlan) }))).toBe("NEBIUS_NOT_CONFIGURED"));
  it("provider HTTP error", async () =>
    expect(await code(generatePlan({ env, fetchImpl: (async () => new Response("no", { status: 401 })) as any }))).toBe("NEBIUS_REQUEST_FAILED"));
  it("timeout", async () => {
    const f = (async () => {
      const e = new Error("t");
      e.name = "TimeoutError";
      throw e;
    }) as any;
    expect(await code(generatePlan({ env, fetchImpl: f }))).toBe("NEBIUS_TIMEOUT");
  });
  it("redirect rejected", async () =>
    expect(await code(generatePlan({ env, fetchImpl: (async () => { throw new TypeError("redirect"); }) as any }))).toBe("NEBIUS_REQUEST_FAILED"));
  it("non-JSON provider body", async () =>
    expect(await code(generatePlan({ env, fetchImpl: (async () => new Response("<html>", { status: 200 })) as any }))).toBe("NEBIUS_RESPONSE_INVALID"));
  it("invalid plan structure", async () =>
    expect(await code(generatePlan({ env, fetchImpl: okFetch({ ...goodPlan, weeks: goodPlan.weeks.slice(0, 3) }) }))).toBe("PLAN_VALIDATION_FAILED"));
  it("unknown source id is stripped", async () => {
    const r = await generatePlan({ env, fetchImpl: okFetch({ ...goodPlan, weeks: goodPlan.weeks.map((w) => ({ ...w, sourceIds: ["made-up"] })) }) });
    expect(r.plan.weeks.every((w) => w.sourceIds.length === 0)).toBe(true);
    expect(r.removedCitations).toBe(4);
  });
  it("success reports actual usage and sends safe request", async () => {
    let seen: any;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return (okFetch(goodPlan) as any)();
    }) as any;
    let t = 1000;
    const r = await generatePlan({ env, fetchImpl: f, now: () => (t += 500) });
    expect(seen.url).toBe("https://api.tokenfactory.nebius.com/v1/chat/completions");
    expect(seen.init.redirect).toBe("manual");
    const body = JSON.parse(seen.init.body);
    expect(body.model).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.max_tokens).toBe(4000);
    expect(r.tokens).toEqual({ input: 10, output: 20, total: 30 });
    expect(r.latencyMs).toBe(500);
    expect(r).not.toHaveProperty("cost");
  });
  it("null tokens when usage missing", async () => {
    const f = (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(goodPlan) } }] }))) as any;
    expect((await generatePlan({ env, fetchImpl: f })).tokens).toBeNull();
  });
  it("validatePlan strips extra fields", () => expect(validatePlan({ ...goodPlan, wage: "$90k" }).plan).not.toHaveProperty("wage"));
});

const missedWeek2 =
  "Search for HVAC training providers in Erie, PA (e.g., Erie County Community College, local trade schools, apprenticeship programs) and compile a list of program names.";

describe("named-entity and citation guardrails", () => {
  it("catches the previously missed provider name", () => {
    const bad = { ...goodPlan, weeks: goodPlan.weeks.map((w) => (w.week === 2 ? { ...w, recommendation: missedWeek2 } : w)) };
    expect(() => validatePlan(bad)).toThrow(/Erie County Community College/);
  });
  it.each(["Call ABC Heating and Cooling Inc.", "Ask UA Local 27 about apprenticeships.", "Talk to Smith Mechanical Services."])("rejects %s", (t) =>
    expect(() => validatePlan({ ...goodPlan, mentorQuestions: [t] })).toThrow(PlanError));
  it("catches Penn State Behrend (regression)", () =>
    expect(() => validatePlan({ ...goodPlan, mentorQuestions: ["Ask about courses at Penn State Behrend."] })).toThrow(/Penn State Behrend/));
  it.each([
    ["Penn State Behrend offers evening classes.", /Penn State Behrend/],
    ["Visit Johnson Controls to see installers at work.", /Johnson Controls/],
    ["Ask whether Great Lakes Comfort hires helpers.", /Great Lakes Comfort/],
    ["Shadow a technician at McKinstry for a day.", /McKinstry/],
    ["Compare options with Lincoln Tech and Triangle Tech.", /Lincoln Tech/],
    ["Talk to Erie Metro Trades about training.", /Metro Trades/],
  ])("rejects suffix-free name in %s", (t, re) =>
    expect(() => validatePlan({ ...goodPlan, recommendationsExtra: 0, mentorQuestions: [t] })).toThrow(re));
  it.each([
    "Contact a local HVAC training provider.",
    "A local community college may offer courses.",
    "The HVAC field involves troubleshooting.",
    "Ask a local HVAC employer about job shadowing.",
    "Week 2: shadow an HVAC technician in Erie County, PA.",
    "Maya could ask a mentor about EPA rules for refrigerants.",
    "Hypothesis: Maya's attention to detail fits diagnostic work.",
    "Research whether a nearby training provider offers evening classes.",
  ])("allows generic %s", (t) =>
    expect(() => validatePlan({ ...goodPlan, mentorQuestions: [t] })).not.toThrow());
  it("retries only once for a suffix-free name, then errors", async () => {
    let calls = 0;
    const bad = { ...goodPlan, mentorQuestions: ["Ask Penn State Behrend about schedules."] };
    const f = (async () => { calls++; return (okFetch(bad) as any)(); }) as any;
    expect(await code(generatePlan({ env, fetchImpl: f }))).toBe("PLAN_NAMED_ENTITY");
    expect(calls).toBe(2);
  });
  it("removes citations from uncited recommendations (as in the earlier live plan)", () => {
    const r = validatePlan({ ...goodPlan, weeks: goodPlan.weeks.map((w) => ({ ...w, occupationNote: null, sourceIds: ["onet-hvac"] })) });
    expect(r.plan.weeks.every((w) => w.sourceIds.length === 0)).toBe(true);
    expect(r.removedCitations).toBe(4);
  });
  it("removes citations from notes the source does not support", () => {
    const notes = ["HVAC technicians earn $60,000 a year.", "Erie has many HVAC openings.", "HVAC work requires EPA 608 certification.", "Teamwork matters."];
    const r = validatePlan({ ...goodPlan, weeks: goodPlan.weeks.map((w, i) => ({ ...w, occupationNote: notes[i], sourceIds: ["onet-hvac"] })) });
    expect(r.plan.weeks.every((w) => w.sourceIds.length === 0)).toBe(true);
  });
  it("keeps a supported citation", () => {
    const r = validatePlan(goodPlan);
    expect(r.plan.weeks[0]?.sourceIds).toEqual(["onet-hvac"]);
    expect(r.removedCitations).toBe(0);
  });
  it("retries once after a named-entity violation, then succeeds", async () => {
    const bad = { ...goodPlan, weeks: goodPlan.weeks.map((w) => (w.week === 2 ? { ...w, recommendation: missedWeek2 } : w)) };
    const bodies: any[] = [];
    let n = 0;
    const f = (async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return (okFetch(n++ === 0 ? bad : goodPlan) as any)();
    }) as any;
    const r = await generatePlan({ env, fetchImpl: f });
    expect(r.attempts).toBe(2);
    expect(r.tokens).toEqual({ input: 20, output: 40, total: 60 });
    expect(bodies[1].messages[bodies[1].messages.length - 1].content).toMatch(/rejected/);
  });
  it("shows a clear error when the retry is also invalid", async () => {
    const bad = { ...goodPlan, weeks: goodPlan.weeks.map((w) => (w.week === 2 ? { ...w, recommendation: missedWeek2 } : w)) };
    let calls = 0;
    const f = (async () => { calls++; return (okFetch(bad) as any)(); }) as any;
    expect(await code(generatePlan({ env, fetchImpl: f }))).toBe("PLAN_NAMED_ENTITY");
    expect(calls).toBe(2);
  });
  it("does not retry provider errors", async () => {
    let calls = 0;
    const f = (async () => { calls++; return new Response("x", { status: 500 }); }) as any;
    expect(await code(generatePlan({ env, fetchImpl: f }))).toBe("NEBIUS_REQUEST_FAILED");
    expect(calls).toBe(1);
  });
});

class MemStore {
  m = new Map<string, string>();
  fail = false;
  getItem(k: string) { if (this.fail) throw new Error("x"); return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { if (this.fail) throw new Error("quota"); this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

describe("persistence", async () => {
  const result = await generatePlan({ env, fetchImpl: okFetch(goodPlan) });
  it("round-trips", () => {
    const s = new MemStore();
    expect(loadPlan(s).status).toBe("empty");
    expect(savePlan(s, result)).toEqual({ ok: true });
    const l = loadPlan(s);
    expect(l.status).toBe("ok");
    if (l.status === "ok") expect(l.result.plan.summary).toBe(goodPlan.summary);
    expect(clearPlan(s)).toBe(true);
    expect(loadPlan(s).status).toBe("empty");
  });
  it("rejects stored citations on uncited recommendations", () => {
    const s = new MemStore();
    s.m.set(STORAGE_KEY, JSON.stringify({ ...result, plan: { ...result.plan, weeks: result.plan.weeks.map((w) => ({ ...w, occupationNote: null, sourceIds: ["onet-hvac"] })) } }));
    expect(loadPlan(s).status).toBe("invalid");
  });
  it.each(["Ask about courses at Penn State Behrend.", "Call Erie County Community College."])("rejects a saved plan naming an organization on reload: %s", (t) => {
    const s = new MemStore();
    s.m.set(STORAGE_KEY, JSON.stringify({ ...result, plan: { ...result.plan, mentorQuestions: [t] } }));
    expect(loadPlan(s).status).toBe("invalid");
    expect(savePlan(new MemStore(), { ...result, plan: { ...result.plan, mentorQuestions: [t] } })).toEqual({ ok: false, reason: "invalid" });
  });
  it("rejects a saved plan citing an unsupported occupation note on reload", () => {
    const s = new MemStore();
    s.m.set(STORAGE_KEY, JSON.stringify({ ...result, plan: { ...result.plan, weeks: result.plan.weeks.map((w) => ({ ...w, occupationNote: "HVAC technicians earn $60,000.", sourceIds: ["onet-hvac"] })) } }));
    expect(loadPlan(s).status).toBe("invalid");
  });
  it("rejects tampered storage", () => {
    const s = new MemStore();
    s.m.set(STORAGE_KEY, JSON.stringify({ ...result, sources: [{ ...result.sources[0]!, url: "https://evil.com" }] }));
    expect(loadPlan(s).status).toBe("invalid");
    s.m.set(STORAGE_KEY, "{not json");
    expect(loadPlan(s).status).toBe("invalid");
  });
  it("reports storage errors", () => {
    const s = new MemStore();
    s.fail = true;
    expect(savePlan(s, result)).toEqual({ ok: false, reason: "storage" });
    expect(loadPlan(s).status).toBe("error");
  });
  it("refuses to save invalid result", () => expect(savePlan(new MemStore(), { nope: 1 })).toEqual({ ok: false, reason: "invalid" }));
});

import { DEFAULT_LIMITS, MemoryLimitStore, resolveLimits, toLimitError, withLimits } from "./limits";

describe("repeated occupation facts", () => {
  const fact = "HVAC mechanics and installers work on heating, air conditioning, and refrigeration systems.";
  const repeated = { ...goodPlan, weeks: goodPlan.weeks.map((w) => ({ ...w, occupationNote: fact, sourceIds: ["onet-hvac"] })) };
  it("keeps only the first appearance", () => {
    const r = validatePlan(repeated);
    expect(r.plan.weeks.map((w) => w.occupationNote)).toEqual([fact, null, null, null]);
    expect(r.plan.weeks.map((w) => w.sourceIds.length)).toEqual([1, 0, 0, 0]);
    expect(r.dedupedFacts).toBe(3);
    expect(r.removedCitations).toBe(0);
  });
  it("treats punctuation/case variants as the same fact", () => {
    const r = validatePlan({ ...repeated, weeks: repeated.weeks.map((w, i) => ({ ...w, occupationNote: i ? fact.toUpperCase().replace(/,/g, "") : fact })) });
    expect(r.dedupedFacts).toBe(3);
  });
  it("rejects a saved plan with repeated facts on reload", async () => {
    const result = await generatePlan({ env, fetchImpl: okFetch(goodPlan) });
    const s = new MemStore();
    s.m.set(STORAGE_KEY, JSON.stringify({ ...result, plan: { ...result.plan, weeks: result.plan.weeks.map((w) => ({ ...w, occupationNote: fact, sourceIds: ["onet-hvac"] })) } }));
    expect(loadPlan(s).status).toBe("invalid");
  });
});

describe("usage limits", () => {
  const cfg = { ...DEFAULT_LIMITS };
  const bad = { ...goodPlan, mentorQuestions: ["Ask Penn State Behrend about schedules."] };
  const run = (store: MemoryLimitStore, user: string, fetchImpl: any, c = cfg) =>
    withLimits(store, user, c, (hooks) => generatePlan({ env, fetchImpl, hooks }));

  it("counts the retry as a second model call", async () => {
    const store = new MemoryLimitStore();
    let n = 0;
    const f = (async () => (okFetch(n++ === 0 ? bad : goodPlan) as any)()) as any;
    const r = await run(store, "u1", f);
    expect(r.attempts).toBe(2);
    expect(store.calls.filter((c) => c.userId === "u1")).toHaveLength(2);
    expect(store.calls.every((c) => c.actual === 30)).toBe(true);
  });
  it("blocks the retry when it would exceed the user's daily calls", async () => {
    const store = new MemoryLimitStore();
    let calls = 0;
    const f = (async () => { calls++; return (okFetch(bad) as any)(); }) as any;
    expect(await code(run(store, "u1", f, { ...cfg, userDailyCalls: 1 }))).toBe("LIMIT_USER_DAILY");
    expect(calls).toBe(1);
  });
  it("stops at the project token ceiling before calling the provider", async () => {
    const store = new MemoryLimitStore();
    let calls = 0;
    const f = (async () => { calls++; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(goodPlan) } }] })); }) as any; // no usage reported
    const c = { ...cfg, userDailyCalls: 100, projectDailyTokens: cfg.reservePerCall * 2 };
    await run(store, "u1", f, c);
    await run(store, "u2", f, c);
    expect(await code(run(store, "u3", f, c))).toBe("LIMIT_PROJECT_BUDGET");
    expect(calls).toBe(2); // unreported usage stays charged at the full reservation
  });
  it("stops at the project daily call limit across users", async () => {
    const store = new MemoryLimitStore();
    const c = { ...cfg, projectDailyCalls: 2 };
    await run(store, "a", okFetch(goodPlan));
    await run(store, "b", okFetch(goodPlan));
    expect(await code(run(store, "c", okFetch(goodPlan), c))).toBe("LIMIT_PROJECT_DAILY");
  });
  it("limits concurrent requests per user and project", async () => {
    const store = new MemoryLimitStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = (async () => { await gate; return (okFetch(goodPlan) as any)(); }) as any;
    const first = run(store, "u1", slow);
    await new Promise((r) => setTimeout(r, 0));
    expect(await code(run(store, "u1", okFetch(goodPlan)))).toBe("LIMIT_USER_CONCURRENT");
    expect(await code(run(store, "u2", okFetch(goodPlan), { ...cfg, projectConcurrent: 1 }))).toBe("LIMIT_PROJECT_CONCURRENT");
    release();
    await first;
    expect(store.runs.filter((r) => r.status === "running")).toHaveLength(0);
  });
  it("releases the run slot after a provider error", async () => {
    const store = new MemoryLimitStore();
    await code(run(store, "u1", (async () => new Response("x", { status: 500 })) as any));
    expect(store.runs[0]!.status).toBe("failed");
    expect(store.calls[0]!.actual).toBeNull(); // charged at reservation
  });
  it("fails closed when the limit store errors", () => {
    expect(toLimitError(new Error("connection refused")).code).toBe("LIMITS_UNAVAILABLE");
    expect(toLimitError(new Error('LIMIT_PROJECT_BUDGET')).code).toBe("LIMIT_PROJECT_BUDGET");
  });
  it("reads configurable limits and never lowers the reservation", () => {
    const l = resolveLimits({ HVAC_DAILY_TOKEN_CEILING: "20000", HVAC_RESERVE_TOKENS_PER_CALL: "10", HVAC_USER_DAILY_CALLS: "abc" });
    expect(l.projectDailyTokens).toBe(20000);
    expect(l.reservePerCall).toBe(DEFAULT_LIMITS.reservePerCall);
    expect(l.userDailyCalls).toBe(DEFAULT_LIMITS.userDailyCalls);
  });
});

describe("approved-account gate", () => {
  it("blocks unapproved users before any model call or budget use", async () => {
    const store = new MemoryLimitStore();
    store.approved = new Set(["ok-user"]);
    let calls = 0;
    await expect(withLimits(store, "stranger", DEFAULT_LIMITS, async () => { calls++; return 1; })).rejects.toMatchObject({ code: "LIMIT_NOT_APPROVED" });
    expect(calls).toBe(0);
    expect(store.calls.length).toBe(0);
    expect(store.runs.length).toBe(0);
    await expect(withLimits(store, "ok-user", DEFAULT_LIMITS, async () => 1)).resolves.toBe(1);
  });
  it("maps the database exception to LIMIT_NOT_APPROVED", () => {
    expect(toLimitError(new Error("ERROR: LIMIT_NOT_APPROVED")).code).toBe("LIMIT_NOT_APPROVED");
  });
});

import { sentenceCase, sentenceCasePlan } from "./core";
describe("sentence capitalization", () => {
  it("capitalizes sentence starts only", () => {
    expect(sentenceCase("contact a local HVAC training provider. then reflect.")).toBe("Contact a local HVAC training provider. Then reflect.");
  });
  it("keeps name validation strict on sentence-cased text", () => {
    const base = { summary: "s", fitReasons: ["r"], mentorQuestions: ["q"], weeks: [1, 2, 3, 4].map((week) => ({ week, recommendation: "visit a local HVAC training provider.", occupationNote: null, sourceIds: [] })) };
    const cased = sentenceCasePlan(base);
    expect(cased.weeks[0]!.recommendation).toBe("Visit a local HVAC training provider.");
    expect(() => validatePlan(cased)).not.toThrow();
    const bad = { ...base, weeks: base.weeks.map((w) => ({ ...w, recommendation: "Visit Penn State Behrend for a tour." })) };
    expect(() => validatePlan(sentenceCasePlan(bad))).toThrow(/Penn State Behrend/);
  });
});

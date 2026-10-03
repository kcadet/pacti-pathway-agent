// Pure, runtime-agnostic HVAC plan logic. No process.env here: env + fetch are injected.
export const SOURCES = [
  {
    id: "onet-hvac",
    title: "O*NET HVAC occupation overview",
    url: "https://www.onetonline.org/link/summary/49-9021.00",
    reviewedOn: "2026-10-01",
    evidence:
      "HVAC mechanics and installers work on heating, air conditioning, and refrigeration systems.",
    scope:
      "Occupation overview only. Does not verify local programs, wages, vacancies, credentials, or eligibility.",
  },
] as const;

export const UNKNOWNS = [
  "Current local training availability in Erie, PA",
  "Provider entry requirements and eligibility",
  "Tuition and funding options",
  "Transport and schedule fit",
  "Current employer openings",
];

export const PROFILE = {
  name: "Maya",
  synthetic: true,
  location: "Erie, PA",
  interests: ["hands-on work", "problem solving", "technology"],
  skills: ["mechanical reasoning", "teamwork", "attention to detail"],
  values: ["stability", "visible results", "learning"],
  readiness: "Demonstration values only; not a validated assessment.",
};

export const DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b";
export const DEFAULT_BASE_URL = "https://api.tokenfactory.nebius.com/v1/";
export const MAX_REQUEST_BYTES = 256;
export const MAX_RESPONSE_BYTES = 100_000;
export const PROVIDER_TIMEOUT_MS = 45_000;

const context = { candidate: PROFILE, pathway: "HVAC exploration", sources: SOURCES, unknowns: UNKNOWNS };
const outputShape = {
  summary: "string",
  fitReasons: ["string"],
  weeks: [1, 2, 3, 4].map((week) => ({
    week,
    recommendation: "string (suggested action; uncited)",
    occupationNote: "string or null (only a fact supported by onet-hvac evidence)",
    sourceIds: ["onet-hvac only when occupationNote is non-null"],
  })),
  mentorQuestions: ["string"],
};

const SYSTEM_PROMPT = [
  "Create a non-binding four-week HVAC exploration plan for a synthetic participant. Return ONLY valid JSON matching the supplied shape.",
  "NEVER name any school, college, training provider, union, apprenticeship sponsor, employer or company. Use generic descriptions such as \"a local HVAC training provider\" or \"a local HVAC employer\".",
  "Use normal sentence capitalization (no Title Case headings): capitalize the first word of each sentence, plus HVAC, Maya, Erie, PA and EPA, and nothing else.",
  "Never invent providers, vacancies, wages, credentials, admissions, or guarantees. Treat unknowns as questions for the mentor.",
  "Each week has: recommendation = a suggested safe exploration or verification step (never unsupervised technical work); it is NOT cited.",
  "occupationNote = optional single factual statement about the HVAC occupation that is directly supported by the supplied evidence (heating, air conditioning and refrigeration systems), or null. sourceIds = [\"onet-hvac\"] only when occupationNote is non-null; otherwise [].",
  "Sources are reference snapshots, not live retrieval. Fit is a hypothesis from expressed interests, not a diagnosis or prediction.",
].join(" ");

export type ErrorCode =
  | "NEBIUS_NOT_CONFIGURED"
  | "NEBIUS_MODEL_INVALID"
  | "NEBIUS_ENDPOINT_INVALID"
  | "NEBIUS_TIMEOUT"
  | "NEBIUS_REQUEST_FAILED"
  | "NEBIUS_RESPONSE_INVALID"
  | "PLAN_VALIDATION_FAILED"
  | "PLAN_NAMED_ENTITY"
  | "REQUEST_INVALID"
  | "RATE_LIMITED"
  | "AUTH_REQUIRED"
  | "LIMIT_USER_DAILY"
  | "LIMIT_PROJECT_DAILY"
  | "LIMIT_PROJECT_BUDGET"
  | "LIMIT_USER_CONCURRENT"
  | "LIMIT_PROJECT_CONCURRENT"
  | "LIMITS_UNAVAILABLE"
  | "LIMIT_NOT_APPROVED";

export class PlanError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
  }
}

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  NEBIUS_NOT_CONFIGURED: "NEBIUS_API_KEY is not set. Add it in Project Settings → Secrets.",
  NEBIUS_MODEL_INVALID: "Configured NEBIUS_MODEL is not an NVIDIA Nemotron model id.",
  NEBIUS_ENDPOINT_INVALID: "NEBIUS_BASE_URL must be an official HTTPS Nebius Token Factory /v1/ endpoint.",
  NEBIUS_TIMEOUT: "Nebius did not respond in time. Try again.",
  NEBIUS_REQUEST_FAILED: "Nebius returned an error.",
  NEBIUS_RESPONSE_INVALID: "Nebius returned an unreadable response.",
  PLAN_VALIDATION_FAILED: "The model's plan did not match the required structure, so it was not shown.",
  PLAN_NAMED_ENTITY: "The model named a specific school, provider or employer twice, so the plan was rejected.",
  REQUEST_INVALID: "Only the fixed synthetic profile request is accepted.",
  RATE_LIMITED: "Demo generation limit reached for now. Try again later.",
  AUTH_REQUIRED: "Sign in to generate a plan.",
  LIMIT_USER_DAILY: "You've reached your daily limit of model calls (retries count). Try again tomorrow (UTC).",
  LIMIT_PROJECT_DAILY: "The demo's daily limit of model calls is reached for everyone. Try again tomorrow (UTC).",
  LIMIT_PROJECT_BUDGET: "The demo's daily token budget is used up, so generation is paused until tomorrow (UTC).",
  LIMIT_USER_CONCURRENT: "You already have a plan generating. Wait for it to finish.",
  LIMIT_PROJECT_CONCURRENT: "Too many plans are generating right now. Try again in a minute.",
  LIMITS_UNAVAILABLE: "Usage limits could not be checked, so generation was not started.",
  LIMIT_NOT_APPROVED: "This account isn't approved for the demo yet, so no plan was generated. Ask the demo owner for access.",
};

export interface Week {
  week: number;
  recommendation: string;
  occupationNote: string | null;
  sourceIds: string[];
}
export interface Plan {
  summary: string;
  fitReasons: string[];
  weeks: Week[];
  mentorQuestions: string[];
}

const text = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0 && s.length <= 1000;
const strings = (a: unknown): a is string[] => Array.isArray(a) && a.length >= 1 && a.length <= 6 && a.every(text);

// Capitalized multi-word names ending in an institution/company word, e.g. "Erie County Community College".
const INSTITUTION_WORDS =
  "Community College|College|University|Institute|Academy|School|Schools|Center|Centre|Inc\\.?|LLC|Corp\\.?|Corporation|Company|Co\\.|Services|Heating|Mechanical|Plumbing|Union|Technical|Tech|CareerLink|Job Corps|Local \\d+";
const NAMED_ENTITY = new RegExp(
  `\\b(?:[A-Z][A-Za-z&'.-]*\\s+){1,5}(?:${INSTITUTION_WORDS})\\b|\\b(?:Local|UA|SMART|IBEW)\\s+\\d+\\b|\\bJob Corps\\b|\\bPA CareerLink\\b`,
);
// Generic phrases that start with a capital only because they begin a sentence are allowed.
const GENERIC_START = /^(?:A|An|The|Any|One|Local|Nearby|Area|Regional)\s+(?:local\s+|nearby\s+|area\s+)?(?:HVAC\s+)?(?:training\s+)?(?:community\s+college|college|school|provider|employer|company|technical school|trade school)\b/i;

// Capitalized words that are allowed because they are part of the synthetic profile, the source,
// or generic acronyms — not organization names.
const ALLOWED_CAPS = new Set([
  "HVAC", "HVACR", "HVAC-R", "O*NET", "ONET", "Maya", "Erie", "County", "PA", "Pennsylvania", "I", "Week",
  "EPA", "AC", "US", "U.S.", "OSHA", "NVIDIA", "Nemotron", "PACTI", "Section", "Hypothesis", "Mentor", "Recommendation",
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
]);
const WORD = /[A-Za-z*][A-Za-z0-9*&'.-]*/g;
const isCap = (w: string) => /^[A-Z]/.test(w);
const isAllowed = (w: string) => ALLOWED_CAPS.has(w.replace(/[.,;:!?'"]+$/, "")) || /^\d/.test(w);
const INNER_CAP = /^[A-Z][a-z]+[A-Z][A-Za-z]*$/; // e.g. "McKinstry", "CoolAir"

/** Heuristic only: finds suffix-free proper-noun runs (e.g. "Penn State Behrend") that are not generic terms. */
function findProperNounRun(value: string): string | null {
  for (const sentence of value.split(/(?<=[.!?:;])\s+|\n+/)) {
    const words = [...sentence.matchAll(WORD)].map((m) => m[0]);
    let run: string[] = [];
    const flush = () => {
      const r = run;
      run = [];
      return r.length >= 2 ? r.join(" ") : null;
    };
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      // The first word of a sentence is capitalized by grammar; only count it if a capitalized word follows it.
      const counts = isCap(w) && !isAllowed(w) && !(i === 0 && !(words[1] && isCap(words[1]) && !isAllowed(words[1])));
      if (counts) {
        if (i > 0 && INNER_CAP.test(w)) return w;
        run.push(w);
      } else {
        const hit = flush();
        if (hit) return hit;
      }
    }
    const hit = flush();
    if (hit) return hit;
  }
  return null;
}

export function findNamedEntity(value: string): string | null {
  const re = new RegExp(NAMED_ENTITY.source, "g");
  for (const m of value.matchAll(re)) {
    if (!GENERIC_START.test(m[0])) return m[0];
  }
  return findProperNounRun(value);
}

/** True only for statements within the onet-hvac evidence scope. */
export function supportedByOnet(note: string): boolean {
  if (!/heating|air[- ]?condition|refrigerat|hvac/i.test(note)) return false;
  return !/\$|\d|%|wage|salary|pay|earn|demand|growth|opening|vacanc|hiring|licen[cs]|certif|credential|guarantee|apprentice|require|program|erie|local/i.test(note);
}

export interface ValidatedPlan {
  plan: Plan;
  removedCitations: number;
  dedupedFacts: number;
}

export function validatePlan(p: any): ValidatedPlan {
  const fail = () => {
    throw new PlanError("PLAN_VALIDATION_FAILED", ERROR_MESSAGES.PLAN_VALIDATION_FAILED);
  };
  if (!p || typeof p !== "object" || !text(p.summary) || !strings(p.fitReasons) || !strings(p.mentorQuestions)) fail();
  if (!Array.isArray(p.weeks) || p.weeks.length !== 4) fail();
  let removedCitations = 0;
  let dedupedFacts = 0;
  const seenFacts = new Set<string>();
  const weeks: Week[] = p.weeks.map((w: any, i: number) => {
    const recommendation = w?.recommendation ?? w?.action;
    if (!w || w.week !== i + 1 || !text(recommendation)) fail();
    let note = w.occupationNote === null || w.occupationNote === undefined || w.occupationNote === "" ? null : w.occupationNote;
    if (note !== null && !text(note)) fail();
    let duplicate = false;
    if (note !== null) {
      const key = note.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (seenFacts.has(key)) {
        duplicate = true;
        note = null; // repeated occupation fact: keep only its first appearance
        dedupedFacts++;
      } else seenFacts.add(key);
    }
    const ids = Array.isArray(w.sourceIds) ? w.sourceIds : [];
    const keep = note !== null && supportedByOnet(note) ? ids.filter((id: unknown) => SOURCES.some((s) => s.id === id)) : [];
    const unique = [...new Set(keep)] as string[];
    if (!duplicate) removedCitations += ids.length - unique.length;
    return { week: i + 1, recommendation, occupationNote: note, sourceIds: unique };
  });
  const plan: Plan = { summary: p.summary, fitReasons: [...p.fitReasons], weeks, mentorQuestions: [...p.mentorQuestions] };
  const all = [plan.summary, ...plan.fitReasons, ...plan.mentorQuestions, ...weeks.flatMap((w) => [w.recommendation, w.occupationNote ?? ""])];
  for (const t of all) {
    const hit = findNamedEntity(t);
    if (hit) throw new PlanError("PLAN_NAMED_ENTITY", `${ERROR_MESSAGES.PLAN_NAMED_ENTITY} (found "${hit}")`);
  }
  return { plan, removedCitations, dedupedFacts };
}

/** Accept only an empty body or {} or the fixed profile marker. */
export function validateRequest(input: unknown): void {
  const bad = () => {
    throw new PlanError("REQUEST_INVALID", ERROR_MESSAGES.REQUEST_INVALID);
  };
  if (input === undefined || input === null) return;
  let size = 0;
  try {
    size = JSON.stringify(input).length;
  } catch {
    bad();
  }
  if (size > MAX_REQUEST_BYTES) bad();
  if (typeof input !== "object" || Array.isArray(input)) bad();
  const keys = Object.keys(input as object);
  if (keys.length === 0) return;
  if (keys.length === 1 && (input as any).profile === "synthetic-maya") return;
  bad();
}

export function resolveConfig(env: Record<string, string | undefined>) {
  const apiKey = env['NEBIUS_API_KEY']?.trim();
  if (!apiKey) throw new PlanError("NEBIUS_NOT_CONFIGURED", ERROR_MESSAGES.NEBIUS_NOT_CONFIGURED);
  const model = env['NEBIUS_MODEL']?.trim() || DEFAULT_MODEL;
  if (!/^nvidia\/[a-z0-9._-]*nemotron[a-z0-9._-]*$/i.test(model))
    throw new PlanError("NEBIUS_MODEL_INVALID", ERROR_MESSAGES.NEBIUS_MODEL_INVALID);
  let base: URL;
  try {
    base = new URL(env['NEBIUS_BASE_URL']?.trim() || DEFAULT_BASE_URL);
  } catch {
    throw new PlanError("NEBIUS_ENDPOINT_INVALID", ERROR_MESSAGES.NEBIUS_ENDPOINT_INVALID);
  }
  if (
    base.protocol !== "https:" ||
    !/^api\.tokenfactory(?:\.[a-z0-9-]+)?\.nebius\.com$/.test(base.hostname) ||
    base.username || base.password || base.port || base.pathname !== "/v1/" || base.search || base.hash
  ) throw new PlanError("NEBIUS_ENDPOINT_INVALID", ERROR_MESSAGES.NEBIUS_ENDPOINT_INVALID);
  return { apiKey, model, base };
}

function extractJson(content: unknown): unknown {
  if (typeof content !== "string") throw new PlanError("NEBIUS_RESPONSE_INVALID", ERROR_MESSAGES.NEBIUS_RESPONSE_INVALID);
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new PlanError("PLAN_VALIDATION_FAILED", ERROR_MESSAGES.PLAN_VALIDATION_FAILED);
  }
}

export interface PlanResult {
  version: 2;
  mode: "live-nebius";
  model: string;
  generatedAt: string;
  latencyMs: number;
  tokens: { input: number; output: number; total: number } | null;
  dataMode: string;
  disclaimer: string;
  sources: { id: string; title: string; url: string; reviewedOn: string; evidence: string; scope: string }[];
  unknowns: string[];
  plan: Plan;
  attempts: number;
  removedCitations: number;
  dedupedFacts: number;
}

/** Hooks let the server enforce usage limits on every model call, including the retry. */
export interface CallHooks {
  /** Called before each provider request; throw a PlanError to stop. Returns a handle passed to afterCall. */
  beforeCall?: (attempt: number) => Promise<unknown>;
  /** Called after each provider response with reported total tokens (null if not reported). */
  afterCall?: (handle: unknown, totalTokens: number | null) => Promise<void>;
}

export const MAX_OUTPUT_TOKENS = 4000;

export async function generatePlan({
  env,
  fetchImpl = fetch,
  now = Date.now,
  timeoutMs = PROVIDER_TIMEOUT_MS,
  hooks = {},
}: {
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  hooks?: CallHooks;
}): Promise<PlanResult> {
  const { apiKey, model, base } = resolveConfig(env);
  const start = now();
  const baseMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: JSON.stringify({ context, outputShape }) },
  ];
  let messages = baseMessages;
  const tokens = { input: 0, output: 0, total: 0 };
  let tokensReported = true;
  let reportedModel = model;
  let validated: ValidatedPlan | null = null;
  let attempts = 0;
  for (attempts = 1; attempts <= 2; attempts++) {
    const handle = hooks.beforeCall ? await hooks.beforeCall(attempts) : undefined;
    let result: any;
    let content: unknown;
    try {
      ({ result, content } = await callProvider({ fetchImpl, base, apiKey, model, messages, timeoutMs }));
    } catch (e) {
      if (hooks.afterCall) await hooks.afterCall(handle, null); // keep the conservative reservation
      throw e;
    }
    const u = result?.usage;
    const reported = u && ["prompt_tokens", "completion_tokens", "total_tokens"].every((k) => Number.isInteger(u[k]) && u[k] >= 0);
    if (hooks.afterCall) await hooks.afterCall(handle, reported ? u.total_tokens : null);
    if (reported) {
      tokens.input += u.prompt_tokens;
      tokens.output += u.completion_tokens;
      tokens.total += u.total_tokens;
    } else tokensReported = false;
    if (typeof result?.model === "string" && result.model.length <= 200) reportedModel = result.model;
    try {
      validated = validatePlan(extractJson(content));
      break;
    } catch (e) {
      if (!(e instanceof PlanError) || attempts === 2) throw e;
      messages = [
        ...baseMessages,
        { role: "assistant", content: typeof content === "string" ? content.slice(0, 20000) : "" },
        { role: "user", content: `Your plan was rejected: ${e.message} Return a corrected plan as JSON only. Use generic descriptions like "a local HVAC training provider" instead of any names.` },
      ];
    }
  }
  const { removedCitations, dedupedFacts } = validated!;
  const plan = sentenceCasePlan(validated!.plan);
  return {
    version: 2,
    mode: "live-nebius",
    model: reportedModel,
    generatedAt: new Date().toISOString(),
    latencyMs: Math.max(0, now() - start),
    tokens: tokensReported ? tokens : null,
    dataMode: "Synthetic participant · reviewed source snapshot · no live retrieval or vacancies.",
    disclaimer:
      "AI-generated exploration guidance. Every claim requires mentor review. No enrollment or application has been submitted.",
    sources: SOURCES.map((s) => ({ ...s })),
    unknowns: [...UNKNOWNS],
    plan,
    attempts,
    removedCitations,
    dedupedFacts,
  };
}

async function callProvider({ fetchImpl, base, apiKey, model, messages, timeoutMs }: {
  fetchImpl: typeof fetch; base: URL; apiKey: string; model: string; messages: { role: string; content: string }[]; timeoutMs: number;
}): Promise<{ result: any; content: unknown }> {
  let response: Response;
  try {
    response = await fetchImpl(new URL("chat/completions", base).toString(), {
      method: "POST",
      // "manual" (not "error"): the Cloudflare Workers runtime rejects redirect: "error". Any 3xx is refused below.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      // Nemotron 3 reasoning is toggled via the chat template (enable_thinking); off so the whole budget goes to the JSON plan.
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: MAX_OUTPUT_TOKENS,
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: "json_object" },
        messages,
      }),
    });
  } catch (e: any) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError")
      throw new PlanError("NEBIUS_TIMEOUT", ERROR_MESSAGES.NEBIUS_TIMEOUT);
    console.error("nebius fetch failed", e?.name, e?.message);
    throw new PlanError("NEBIUS_REQUEST_FAILED", `${ERROR_MESSAGES.NEBIUS_REQUEST_FAILED} (network or redirect)`);
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400))
    throw new PlanError("NEBIUS_REQUEST_FAILED", `${ERROR_MESSAGES.NEBIUS_REQUEST_FAILED} (redirect rejected)`);
  if (!response.ok)
    throw new PlanError("NEBIUS_REQUEST_FAILED", `${ERROR_MESSAGES.NEBIUS_REQUEST_FAILED} (HTTP ${response.status})`);
  const raw = await response.text();
  if (raw.length > MAX_RESPONSE_BYTES) throw new PlanError("NEBIUS_RESPONSE_INVALID", ERROR_MESSAGES.NEBIUS_RESPONSE_INVALID);
  let result: any;
  try {
    result = JSON.parse(raw);
  } catch {
    throw new PlanError("NEBIUS_RESPONSE_INVALID", ERROR_MESSAGES.NEBIUS_RESPONSE_INVALID);
  }
  const choice = result?.choices?.[0];
  if (typeof choice?.message?.content !== "string" && choice?.finish_reason === "length")
    throw new PlanError("NEBIUS_RESPONSE_INVALID", "Nemotron used its whole output budget on reasoning and returned no plan. Try again.");
  return { result, content: choice?.message?.content };
}

/** Capitalizes the first letter of each sentence. Applied only after name validation passed on the raw text. */
export function sentenceCase(s: string): string {
  return s.replace(/(^\s*|[.!?]\s+)([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());
}

/** Returns a sentence-cased copy; falls back to the raw plan if the cased text would no longer validate unchanged. */
export function sentenceCasePlan<P extends { summary: string; fitReasons: string[]; weeks: { recommendation: string; occupationNote: string | null }[]; mentorQuestions: string[] }>(plan: P): P {
  const cased: P = {
    ...plan,
    summary: sentenceCase(plan.summary),
    fitReasons: plan.fitReasons.map(sentenceCase),
    weeks: plan.weeks.map((w) => ({ ...w, recommendation: sentenceCase(w.recommendation), occupationNote: w.occupationNote === null ? null : sentenceCase(w.occupationNote) })),
    mentorQuestions: plan.mentorQuestions.map(sentenceCase),
  };
  try {
    const v = validatePlan(cased);
    return v.removedCitations === 0 && v.dedupedFacts === 0 ? cased : plan;
  } catch {
    return plan;
  }
}

import { z } from "zod";
import { SOURCES, validatePlan } from "./core";

const text = z.string().min(1).max(1000);
const sourceIds = SOURCES.map((s) => s.id) as [string, ...string[]];

export const resultSchema = z.object({
  version: z.literal(2),
  attempts: z.number().int().min(1).max(2),
  removedCitations: z.number().int().nonnegative(),
  dedupedFacts: z.number().int().nonnegative().default(0),
  mode: z.literal("live-nebius"),
  model: z.string().min(1).max(200),
  generatedAt: z.string().datetime(),
  latencyMs: z.number().nonnegative(),
  tokens: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).nullable(),
  dataMode: text,
  disclaimer: text,
  unknowns: z.array(text),
  sources: z.array(
    z.object({
      id: z.enum(sourceIds),
      title: text,
      url: z.literal(SOURCES[0].url),
      reviewedOn: text,
      evidence: text,
      scope: text,
    }),
  ),
  plan: z.object({
    summary: text,
    fitReasons: z.array(text).min(1).max(6),
    mentorQuestions: z.array(text).min(1).max(6),
    weeks: z.array(z.object({ week: z.number().int().min(1).max(4), recommendation: text, occupationNote: text.nullable(), sourceIds: z.array(z.enum(sourceIds)) }).refine((w) => w.occupationNote !== null || w.sourceIds.length === 0, "Citations only on occupation notes")).length(4),
  }),
});

export type StoredResult = z.infer<typeof resultSchema>;
export const STORAGE_KEY = "pacti-hvac-plan-v2";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Runs the same plan guardrails used on generation: named entities and unsupported citations are rejected. */
function checkResult(raw: unknown): StoredResult | null {
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) return null;
  try {
    const { removedCitations, dedupedFacts } = validatePlan(parsed.data.plan);
    if (removedCitations > 0 || dedupedFacts > 0) return null;
  } catch {
    return null;
  }
  return parsed.data;
}

export function loadPlan(store: Store):
  | { status: "empty" }
  | { status: "ok"; result: StoredResult }
  | { status: "invalid" }
  | { status: "error" } {
  let raw: string | null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return { status: "error" };
  }
  if (!raw) return { status: "empty" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { status: "invalid" };
  }
  const result = checkResult(json);
  return result ? { status: "ok", result } : { status: "invalid" };
}

export function savePlan(store: Store, result: unknown): { ok: true } | { ok: false; reason: "invalid" | "storage" } {
  const data = checkResult(result);
  if (!data) return { ok: false, reason: "invalid" };
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(data));
    return { ok: true };
  } catch {
    return { ok: false, reason: "storage" };
  }
}

export function clearPlan(store: Store): boolean {
  try {
    store.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

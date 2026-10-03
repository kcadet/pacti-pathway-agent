import { ERROR_MESSAGES, MAX_OUTPUT_TOKENS, PlanError, type CallHooks, type ErrorCode } from "./core";

/** Server-side usage limits. Values come from env (read inside the handler) with conservative defaults. */
export interface LimitConfig {
  userDailyCalls: number;
  projectDailyCalls: number;
  /** Daily token ceiling across all users. Tokens, not dollars: Nebius does not return a price. */
  projectDailyTokens: number;
  /** Tokens reserved per model call before the provider reports actual usage. */
  reservePerCall: number;
  userConcurrent: number;
  projectConcurrent: number;
  staleSeconds: number;
}

/** Prompt (~1,000) + max output, rounded up. Unreported usage is charged at this full reservation. */
export const DEFAULT_RESERVE_PER_CALL = 1500 + MAX_OUTPUT_TOKENS;

export const DEFAULT_LIMITS: LimitConfig = {
  userDailyCalls: 5,
  projectDailyCalls: 40,
  projectDailyTokens: 150_000,
  reservePerCall: DEFAULT_RESERVE_PER_CALL,
  userConcurrent: 1,
  projectConcurrent: 3,
  staleSeconds: 180,
};

const int = (v: string | undefined, fallback: number, min: number, max: number) => {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

export function resolveLimits(env: Record<string, string | undefined>): LimitConfig {
  return {
    userDailyCalls: int(env["HVAC_USER_DAILY_CALLS"], DEFAULT_LIMITS.userDailyCalls, 0, 1000),
    projectDailyCalls: int(env["HVAC_PROJECT_DAILY_CALLS"], DEFAULT_LIMITS.projectDailyCalls, 0, 10_000),
    projectDailyTokens: int(env["HVAC_DAILY_TOKEN_CEILING"], DEFAULT_LIMITS.projectDailyTokens, 0, 100_000_000),
    // The reservation can be raised but never set below the default, so the budget stays conservative.
    reservePerCall: int(env["HVAC_RESERVE_TOKENS_PER_CALL"], DEFAULT_LIMITS.reservePerCall, DEFAULT_RESERVE_PER_CALL, 100_000),
    userConcurrent: int(env["HVAC_USER_CONCURRENT"], DEFAULT_LIMITS.userConcurrent, 1, 10),
    projectConcurrent: int(env["HVAC_PROJECT_CONCURRENT"], DEFAULT_LIMITS.projectConcurrent, 1, 50),
    staleSeconds: DEFAULT_LIMITS.staleSeconds,
  };
}

/** Durable store operations (backed by database functions in production, in-memory in tests). */
export interface LimitStore {
  beginRun(userId: string, cfg: LimitConfig): Promise<string>;
  reserveCall(runId: string, userId: string, cfg: LimitConfig): Promise<string>;
  settleCall(callId: string, tokens: number | null): Promise<void>;
  endRun(runId: string, status: "done" | "failed"): Promise<void>;
}

const LIMIT_CODES: ErrorCode[] = [
  "LIMIT_NOT_APPROVED",
  "LIMIT_USER_DAILY",
  "LIMIT_PROJECT_DAILY",
  "LIMIT_PROJECT_BUDGET",
  "LIMIT_USER_CONCURRENT",
  "LIMIT_PROJECT_CONCURRENT",
];

/** Maps a store error message (e.g. a database exception) to a limit PlanError. Unknown errors fail closed. */
export function toLimitError(e: unknown): PlanError {
  if (e instanceof PlanError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const code = LIMIT_CODES.find((c) => msg.includes(c));
  return code ? new PlanError(code, ERROR_MESSAGES[code]) : new PlanError("LIMITS_UNAVAILABLE", ERROR_MESSAGES.LIMITS_UNAVAILABLE);
}

/** Runs one generation with a run slot (concurrency) and a reservation per model call (first try and retry). */
export async function withLimits<T>(
  store: LimitStore,
  userId: string,
  cfg: LimitConfig,
  run: (hooks: CallHooks) => Promise<T>,
): Promise<T> {
  let runId: string;
  try {
    runId = await store.beginRun(userId, cfg);
  } catch (e) {
    throw toLimitError(e);
  }
  let ok = false;
  try {
    const result = await run({
      beforeCall: async () => {
        try {
          return await store.reserveCall(runId, userId, cfg);
        } catch (e) {
          throw toLimitError(e);
        }
      },
      afterCall: async (handle, tokens) => {
        if (typeof handle === "string" && tokens !== null) await store.settleCall(handle, tokens).catch(() => {});
      },
    });
    ok = true;
    return result;
  } finally {
    await store.endRun(runId, ok ? "done" : "failed").catch(() => {});
  }
}

/** In-memory store with the same rules as the database functions (used by tests). */
export class MemoryLimitStore implements LimitStore {
  runs: { id: string; userId: string; status: string }[] = [];
  calls: { id: string; runId: string; userId: string; reserved: number; actual: number | null }[] = [];
  /** Approved user ids; null = everyone approved (legacy tests). */
  approved: Set<string> | null = null;
  private n = 0;
  async beginRun(userId: string, cfg: LimitConfig) {
    if (this.approved && !this.approved.has(userId)) throw new Error("LIMIT_NOT_APPROVED");
    const running = this.runs.filter((r) => r.status === "running");
    if (running.filter((r) => r.userId === userId).length >= cfg.userConcurrent) throw new Error("LIMIT_USER_CONCURRENT");
    if (running.length >= cfg.projectConcurrent) throw new Error("LIMIT_PROJECT_CONCURRENT");
    const id = `run-${++this.n}`;
    this.runs.push({ id, userId, status: "running" });
    return id;
  }
  async reserveCall(runId: string, userId: string, cfg: LimitConfig) {
    if (this.calls.filter((c) => c.userId === userId).length >= cfg.userDailyCalls) throw new Error("LIMIT_USER_DAILY");
    if (this.calls.length >= cfg.projectDailyCalls) throw new Error("LIMIT_PROJECT_DAILY");
    const used = this.calls.reduce((s, c) => s + (c.actual ?? c.reserved), 0);
    if (used + cfg.reservePerCall > cfg.projectDailyTokens) throw new Error("LIMIT_PROJECT_BUDGET");
    const id = `call-${++this.n}`;
    this.calls.push({ id, runId, userId, reserved: cfg.reservePerCall, actual: null });
    return id;
  }
  async settleCall(callId: string, tokens: number | null) {
    const c = this.calls.find((x) => x.id === callId);
    if (c && tokens !== null) c.actual = tokens;
  }
  async endRun(runId: string, status: "done" | "failed") {
    const r = this.runs.find((x) => x.id === runId);
    if (r && r.status === "running") r.status = status;
  }
}

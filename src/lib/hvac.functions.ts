import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { ERROR_MESSAGES, PlanError, generatePlan, validateRequest, type ErrorCode, type PlanResult } from "./hvac/core";
import { resolveLimits, withLimits, type LimitStore } from "./hvac/limits";

export type GenerateResponse =
  | { ok: true; result: PlanResult }
  | { ok: false; code: ErrorCode; message: string };

export interface UsageSummary {
  userCalls: number;
  userDailyCalls: number;
  projectCalls: number;
  projectDailyCalls: number;
  projectTokens: number;
  projectDailyTokens: number;
  reservePerCall: number;
}

async function dbStore(): Promise<LimitStore> {
  // Usage tables are writable only through service-role database functions; users cannot reset their own counts.
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const { data, error } = await (supabaseAdmin.rpc as any)(fn, args);
    if (error) throw new Error(error.message);
    return data;
  };
  return {
    beginRun: (u, c) => rpc("hvac_begin_run", { p_user: u, p_user_concurrent: c.userConcurrent, p_project_concurrent: c.projectConcurrent, p_stale_seconds: c.staleSeconds }),
    reserveCall: (r, u, c) => rpc("hvac_reserve_call", { p_run: r, p_user: u, p_reserve: c.reservePerCall, p_user_calls: c.userDailyCalls, p_project_calls: c.projectDailyCalls, p_token_ceiling: c.projectDailyTokens }),
    settleCall: async (id, t) => { await rpc("hvac_settle_call", { p_call: id, p_tokens: t }); },
    endRun: async (id, s) => { await rpc("hvac_end_run", { p_run: id, p_status: s }); },
  };
}

export const generateHvacPlan = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => {
    validateRequest(input);
    return {} as Record<string, never>;
  })
  .handler(async ({ context }): Promise<GenerateResponse> => {
    const env = {
      NEBIUS_API_KEY: process.env["NEBIUS_API_KEY"],
      NEBIUS_MODEL: process.env["NEBIUS_MODEL"],
      NEBIUS_BASE_URL: process.env["NEBIUS_BASE_URL"],
    };
    if (!env.NEBIUS_API_KEY?.trim()) return { ok: false, code: "NEBIUS_NOT_CONFIGURED", message: ERROR_MESSAGES.NEBIUS_NOT_CONFIGURED };
    const cfg = resolveLimits(process.env as Record<string, string | undefined>);
    try {
      const store = await dbStore();
      const result = await withLimits(store, context.userId, cfg, (hooks) => generatePlan({ env, hooks }));
      return { ok: true, result };
    } catch (e) {
      if (e instanceof PlanError) return { ok: false, code: e.code, message: e.message };
      console.error("hvac plan unexpected error", e);
      return { ok: false, code: "NEBIUS_REQUEST_FAILED", message: ERROR_MESSAGES.NEBIUS_REQUEST_FAILED };
    }
  });

export const getHvacUsage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<UsageSummary> => {
    const cfg = resolveLimits(process.env as Record<string, string | undefined>);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await (supabaseAdmin.rpc as any)("hvac_usage", { p_user: context.userId });
    if (error) throw new Error("Usage unavailable");
    const d = data as { userCalls: number; projectCalls: number; projectTokens: number };
    return {
      userCalls: Number(d.userCalls), userDailyCalls: cfg.userDailyCalls,
      projectCalls: Number(d.projectCalls), projectDailyCalls: cfg.projectDailyCalls,
      projectTokens: Number(d.projectTokens), projectDailyTokens: cfg.projectDailyTokens,
      reservePerCall: cfg.reservePerCall,
    };
  });

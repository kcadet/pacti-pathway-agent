CREATE TABLE public.hvac_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE TABLE public.hvac_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.hvac_runs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  usage_day date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  reserved_tokens integer NOT NULL,
  actual_tokens integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX hvac_calls_day_idx ON public.hvac_calls (usage_day, user_id);
CREATE INDEX hvac_runs_status_idx ON public.hvac_runs (status, user_id);

GRANT SELECT ON public.hvac_runs TO authenticated;
GRANT SELECT ON public.hvac_calls TO authenticated;
GRANT ALL ON public.hvac_runs TO service_role;
GRANT ALL ON public.hvac_calls TO service_role;
ALTER TABLE public.hvac_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hvac_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users read own runs" ON public.hvac_runs FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "Users read own calls" ON public.hvac_calls FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- Start a generation run; enforces concurrency. Returns run id, or raises with a LIMIT_* code.
CREATE OR REPLACE FUNCTION public.hvac_begin_run(p_user uuid, p_user_concurrent int, p_project_concurrent int, p_stale_seconds int)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('hvac_limits'));
  UPDATE hvac_runs SET status = 'expired', ended_at = now()
    WHERE status = 'running' AND started_at < now() - make_interval(secs => p_stale_seconds);
  IF (SELECT count(*) FROM hvac_runs WHERE status = 'running' AND user_id = p_user) >= p_user_concurrent THEN
    RAISE EXCEPTION 'LIMIT_USER_CONCURRENT'; END IF;
  IF (SELECT count(*) FROM hvac_runs WHERE status = 'running') >= p_project_concurrent THEN
    RAISE EXCEPTION 'LIMIT_PROJECT_CONCURRENT'; END IF;
  INSERT INTO hvac_runs (user_id) VALUES (p_user) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Reserve one model call (first try or retry) against daily limits. Unsettled calls count at their reserved budget.
CREATE OR REPLACE FUNCTION public.hvac_reserve_call(p_run uuid, p_user uuid, p_reserve int, p_user_calls int, p_project_calls int, p_token_ceiling int)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_day date := (now() AT TIME ZONE 'utc')::date; v_id uuid;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('hvac_limits'));
  IF NOT EXISTS (SELECT 1 FROM hvac_runs WHERE id = p_run AND user_id = p_user AND status = 'running') THEN
    RAISE EXCEPTION 'LIMIT_RUN_INVALID'; END IF;
  IF (SELECT count(*) FROM hvac_calls WHERE usage_day = v_day AND user_id = p_user) >= p_user_calls THEN
    RAISE EXCEPTION 'LIMIT_USER_DAILY'; END IF;
  IF (SELECT count(*) FROM hvac_calls WHERE usage_day = v_day) >= p_project_calls THEN
    RAISE EXCEPTION 'LIMIT_PROJECT_DAILY'; END IF;
  IF (SELECT coalesce(sum(coalesce(actual_tokens, reserved_tokens)), 0) FROM hvac_calls WHERE usage_day = v_day) + p_reserve > p_token_ceiling THEN
    RAISE EXCEPTION 'LIMIT_PROJECT_BUDGET'; END IF;
  INSERT INTO hvac_calls (run_id, user_id, usage_day, reserved_tokens) VALUES (p_run, p_user, v_day, p_reserve) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

-- Record reported tokens; never lowers below what the provider reported. If not reported, the reservation stays.
CREATE OR REPLACE FUNCTION public.hvac_settle_call(p_call uuid, p_tokens int)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE hvac_calls SET actual_tokens = p_tokens WHERE id = p_call AND p_tokens IS NOT NULL AND p_tokens >= 0;
$$;

CREATE OR REPLACE FUNCTION public.hvac_end_run(p_run uuid, p_status text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE hvac_runs SET status = p_status, ended_at = now() WHERE id = p_run AND status = 'running';
$$;

-- Read-only usage summary for display.
CREATE OR REPLACE FUNCTION public.hvac_usage(p_user uuid)
RETURNS json LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT json_build_object(
    'userCalls', (SELECT count(*) FROM hvac_calls WHERE usage_day = (now() AT TIME ZONE 'utc')::date AND user_id = p_user),
    'projectCalls', (SELECT count(*) FROM hvac_calls WHERE usage_day = (now() AT TIME ZONE 'utc')::date),
    'projectTokens', (SELECT coalesce(sum(coalesce(actual_tokens, reserved_tokens)), 0) FROM hvac_calls WHERE usage_day = (now() AT TIME ZONE 'utc')::date)
  );
$$;

REVOKE ALL ON FUNCTION public.hvac_begin_run(uuid,int,int,int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hvac_reserve_call(uuid,uuid,int,int,int,int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hvac_settle_call(uuid,int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hvac_end_run(uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hvac_usage(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hvac_begin_run(uuid,int,int,int) TO service_role;
GRANT EXECUTE ON FUNCTION public.hvac_reserve_call(uuid,uuid,int,int,int,int) TO service_role;
GRANT EXECUTE ON FUNCTION public.hvac_settle_call(uuid,int) TO service_role;
GRANT EXECUTE ON FUNCTION public.hvac_end_run(uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.hvac_usage(uuid) TO service_role;
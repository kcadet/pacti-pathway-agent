CREATE TABLE public.hvac_approved_users (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.hvac_approved_users TO authenticated;
GRANT ALL ON public.hvac_approved_users TO service_role;
ALTER TABLE public.hvac_approved_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own approval" ON public.hvac_approved_users FOR SELECT TO authenticated USING (auth.uid() = user_id);

INSERT INTO public.hvac_approved_users (user_id, note) VALUES ('782a8e4e-4942-417d-9af1-ba0e832107a7', 'demo owner');

CREATE OR REPLACE FUNCTION public.hvac_begin_run(p_user uuid, p_user_concurrent integer, p_project_concurrent integer, p_stale_seconds integer)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hvac_approved_users WHERE user_id = p_user) THEN
    RAISE EXCEPTION 'LIMIT_NOT_APPROVED'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('hvac_limits'));
  UPDATE hvac_runs SET status = 'expired', ended_at = now()
    WHERE status = 'running' AND started_at < now() - make_interval(secs => p_stale_seconds);
  IF (SELECT count(*) FROM hvac_runs WHERE status = 'running' AND user_id = p_user) >= p_user_concurrent THEN
    RAISE EXCEPTION 'LIMIT_USER_CONCURRENT'; END IF;
  IF (SELECT count(*) FROM hvac_runs WHERE status = 'running') >= p_project_concurrent THEN
    RAISE EXCEPTION 'LIMIT_PROJECT_CONCURRENT'; END IF;
  INSERT INTO hvac_runs (user_id) VALUES (p_user) RETURNING id INTO v_id;
  RETURN v_id;
END $function$;

CREATE OR REPLACE FUNCTION public.hvac_reserve_call(p_run uuid, p_user uuid, p_reserve integer, p_user_calls integer, p_project_calls integer, p_token_ceiling integer)
 RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE v_day date := (now() AT TIME ZONE 'utc')::date; v_id uuid;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hvac_approved_users WHERE user_id = p_user) THEN
    RAISE EXCEPTION 'LIMIT_NOT_APPROVED'; END IF;
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
END $function$;

REVOKE ALL ON FUNCTION public.hvac_begin_run(uuid,integer,integer,integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.hvac_reserve_call(uuid,uuid,integer,integer,integer,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hvac_begin_run(uuid,integer,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.hvac_reserve_call(uuid,uuid,integer,integer,integer,integer) TO service_role;
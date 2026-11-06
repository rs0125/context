-- Review and apply to the CallOnGo database, not the WAG/Context database.
-- Projection views restrict the reader's columns. Report calculations live in
-- src/lib/call-performance.ts. No operational rows or triggers are changed.
BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='call_performance_reader') THEN
    CREATE ROLE call_performance_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE rolname='call_performance_reader'
    AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
      OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid))) THEN
    RAISE EXCEPTION 'call_performance_reader must be an unprivileged role without memberships';
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS call_performance;
REVOKE ALL ON SCHEMA call_performance FROM PUBLIC;

CREATE OR REPLACE VIEW call_performance.assignments WITH (security_barrier=true) AS
SELECT a.id,a.entity_type,a.entity_id,a.assignee,a.assigned_at,a.state,a.outcome,a.completed_at,
  a.added_to_db AS staff_marked_added,
  coalesce(length(trim(a.wh_id)) BETWEEN 1 AND 100
    AND lower(trim(a.wh_id)) NOT IN ('na','n/a','none','unknown','tbd','-'),false) AS has_recorded_reference,
  CASE WHEN trim(a.wh_id) ~ '^[1-9][0-9]{0,99}$' THEN trim(a.wh_id) END AS numeric_warehouse_reference,
  EXISTS(SELECT 1 FROM public.bolna_warehouse_matches w
    WHERE w.entity_type=a.entity_type AND w.entity_id=a.entity_id) AS warehouse_matched,
  -- One extra ID reports truncation; multiple phones or warehouses never multiply assignments.
  ARRAY(SELECT DISTINCT w.warehouse_id FROM public.bolna_warehouse_matches w
    WHERE w.entity_type=a.entity_type AND w.entity_id=a.entity_id
    ORDER BY w.warehouse_id LIMIT 26)::text[] AS matched_warehouse_ids,
  EXISTS(SELECT 1 FROM public.bolna_warehouse_matches w
    JOIN public.bolna_warehouse_sync_reviews r USING(phone_last10,warehouse_id)
    WHERE w.entity_type=a.entity_type AND w.entity_id=a.entity_id AND r.resolved_at IS NULL) AS warehouse_match_needs_review
FROM public.bolna_assignments a;

CREATE OR REPLACE VIEW call_performance.callers WITH (security_barrier=true) AS
SELECT u.email,u.name,u.active
FROM public.bolna_app_users u
WHERE u.role='employee' OR EXISTS(SELECT 1 FROM public.bolna_assignments a WHERE a.assignee=u.email);

CREATE OR REPLACE VIEW call_performance.assignment_changes WITH (security_barrier=true) AS
SELECT h.id,h.assignment_id,h.changed_at,u.email AS actor,
  h.before_values='{}'::jsonb AS creation_event,
  CASE WHEN h.before_values->>'state' IN ('open','done','dropped') THEN h.before_values->>'state' END AS before_state,
  CASE WHEN h.after_values->>'state' IN ('open','done','dropped') THEN h.after_values->>'state' END AS after_state,
  CASE WHEN h.before_values->>'outcome' IN ('Available','Unavailable','Unclear') THEN h.before_values->>'outcome' END AS before_outcome,
  CASE WHEN h.after_values->>'outcome' IN ('Available','Unavailable','Unclear') THEN h.after_values->>'outcome' END AS after_outcome,
  CASE WHEN h.before_values->>'added_to_db' IN ('true','false') THEN (h.before_values->>'added_to_db')::boolean END AS before_staff_marked_added,
  CASE WHEN h.after_values->>'added_to_db' IN ('true','false') THEN (h.after_values->>'added_to_db')::boolean END AS after_staff_marked_added,
  CASE WHEN trim(h.before_values->>'wh_id') ~ '^[1-9][0-9]{0,99}$' THEN trim(h.before_values->>'wh_id') END AS before_numeric_warehouse_reference,
  CASE WHEN trim(h.after_values->>'wh_id') ~ '^[1-9][0-9]{0,99}$' THEN trim(h.after_values->>'wh_id') END AS after_numeric_warehouse_reference
FROM public.bolna_assignment_changes h LEFT JOIN public.bolna_app_users u ON u.email=h.actor;

CREATE OR REPLACE VIEW call_performance.coverage WITH (security_barrier=true) AS
SELECT
  (SELECT count(*)::integer FROM public.bolna_effective_manual_attempts) AS manual_attempts,
  (SELECT min(changed_at) FROM public.bolna_assignment_changes) AS first_audit_at,
  (SELECT count(*)::integer FROM public.bolna_assignments a
    WHERE NOT EXISTS(SELECT 1 FROM public.bolna_assignment_changes h WHERE h.assignment_id=a.id)) AS assignments_without_audit,
  (SELECT count(*)::integer FROM public.bolna_app_users WHERE role='employee') AS employee_callers,
  (SELECT count(*)::integer FROM public.bolna_app_users WHERE role='employee' AND callyzer_number IS NOT NULL) AS linked_employee_callers,
  (SELECT count(*)::integer FROM public.callyzer_sync_state) AS callyzer_accounts,
  (SELECT min(last_success_at) FROM public.callyzer_sync_state) AS callyzer_last_success_at,
  (SELECT bool_or(last_error IS NOT NULL) FROM public.callyzer_sync_state) AS callyzer_has_error,
  coalesce(ws.enabled,false) AS warehouse_sync_enabled,
  coalesce(ws.initialized,false) AS warehouse_sync_initialized,
  ws.interval_seconds AS warehouse_sync_interval_seconds,
  ws.last_success_at AS warehouse_last_success_at,
  ws.last_snapshot_at AS warehouse_last_snapshot_at,
  ws.last_error_code IS NOT NULL AS warehouse_sync_has_error,
  coalesce((ws.last_summary->>'hasMore')::boolean,false) AS warehouse_sync_has_more,
  coalesce((ws.last_summary->>'auditReplayLimited')::boolean,false) AS warehouse_audit_replay_limited,
  (SELECT count(*)::integer FROM public.bolna_warehouse_sync_reviews WHERE resolved_at IS NULL) AS warehouse_pending_reviews
FROM (VALUES (1)) AS singleton(id)
LEFT JOIN public.bolna_warehouse_sync_state ws ON ws.id=singleton.id;

REVOKE ALL ON call_performance.assignments,call_performance.callers,
  call_performance.assignment_changes,call_performance.coverage FROM PUBLIC;
GRANT USAGE ON SCHEMA call_performance TO call_performance_reader;
GRANT SELECT ON call_performance.assignments,call_performance.callers,
  call_performance.assignment_changes,call_performance.coverage TO call_performance_reader;
ALTER ROLE call_performance_reader SET default_transaction_read_only=on;
ALTER ROLE call_performance_reader SET statement_timeout='4s';

-- Provision the login/password separately through the existing secret workflow.
-- This file deliberately contains no password and does not enable login.
COMMIT;

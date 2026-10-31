-- What the worker VM's database role may do. Idempotent; run as a superuser against the control-plane database
-- AFTER the role exists (create-db-role.sh creates it and then runs this file).
--
-- The worker reads and writes the job queue directly (mergit_worker/jobs.py) and the pull-request queue
-- (mergit_cp/pr_store.py), and reads the plan and task it is working on. Nothing else. In particular it gets no
-- access to sessions, users, identities, wallets, email_otps, oauth_states or wallet_interest: the worker VM
-- runs model-written code and holds the Docker socket, so it is the machine most likely to be compromised, and
-- a stolen worker credential must not expose sign-in sessions or email addresses.
--
-- If a new worker query needs another table, add it here AND in tests/test_worker_role.py, which runs every
-- statement the worker issues as this role.

DO $$
BEGIN
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO mergit_worker', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO mergit_worker;

-- Start from nothing, so re-running after a tightening takes the old rights away.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM mergit_worker;

GRANT SELECT, UPDATE ON jobs, pr_requests TO mergit_worker;
GRANT SELECT ON plans, tasks TO mergit_worker;

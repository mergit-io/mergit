-- What the worker VM's database role may do. Idempotent; run as the superuser that runs the migrations (postgres),
-- against the control-plane database, AFTER the role exists (create-db-role.sh creates it and then runs this file).
--
-- The worker reads and writes the job queue directly (mergit_worker/jobs.py) and the pull-request queue
-- (mergit_cp/pr_store.py), and reads the plan and task it is working on. Nothing else. In particular it gets no
-- access to sessions, users, identities, wallets, email_otps, oauth_states or wallet_interest: the worker VM
-- runs model-written code and holds the Docker socket, so it is the machine most likely to be compromised, and
-- a stolen worker credential must not expose sign-in sessions or email addresses.
--
-- If a new worker query needs another table, add it here AND in tests/test_worker_role.py, which runs every
-- statement the worker issues as this role.
--
-- The role is mergit_worker unless the session setting mergit.worker_role names another (create-db-role.sh sets it
-- from WORKER_DB_ROLE; the tests use a name of their own). Everything is one DO block so the name can be a parameter
-- whether psql or a driver runs the file.

DO $$
DECLARE
    r text := coalesce(nullif(current_setting('mergit.worker_role', true), ''), 'mergit_worker');
    db text := current_database();
BEGIN
    -- Every role may connect to a new database: PUBLIC has CONNECT by default. Take that away, so only the
    -- superuser and roles given CONNECT by name can open this one.
    EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', db);
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', db, r);
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r);
    -- PUBLIC has CREATE on schema public in Postgres 14 and older (the image is 16, where it does not; stated so a
    -- different version cannot hand the worker the right to make objects).
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', r);

    -- Start from nothing, so re-running after a tightening takes the old rights away. PUBLIC too: the role is a
    -- member of PUBLIC, so a table granted to everyone would be granted to the worker.
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I, PUBLIC', r);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I, PUBLIC', r);

    -- The two lines above cover the tables that exist now. A later migration's tables get the default privileges of
    -- the role that creates them: owner only, unless someone ran ALTER DEFAULT PRIVILEGES. Undo any such default for
    -- this role and for PUBLIC, both the global one and the one for schema public (a schema default cannot revoke a
    -- global one, so both are needed). Default privileges belong to the creating role; with no FOR ROLE this is the
    -- role running this file, which must therefore be the one that runs the migrations (postgres in compose).
    EXECUTE format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM %I, PUBLIC', r);
    EXECUTE format('ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM %I, PUBLIC', r);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I, PUBLIC', r);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I, PUBLIC', r);

    EXECUTE format('GRANT SELECT, UPDATE ON jobs, pr_requests TO %I', r);
    EXECUTE format('GRANT SELECT ON plans, tasks TO %I', r);
END
$$;

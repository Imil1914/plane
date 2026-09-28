-- Database and role of the Git server (Forgejo) in the shared PostgreSQL (plane-db); run by forgejo-db-init before
-- every start of Forgejo and by ppm-restore.sh before a restore. Idempotent, on an empty cluster and on an existing
-- one (RC.1 -> RC.2): the role and database are created when missing; the password always follows FORGEJO_DB_PASSWORD
-- (rotation = new value in the env + `up`). Prints nothing (psql -q, no result rows).
--
-- The password is read from the environment with \getenv — never from a command line — and this session logs no
-- statement: not by type, not on error, not as a slow or sampled statement, not in a sampled transaction — so
-- `ALTER ROLE … PASSWORD` cannot reach the PostgreSQL log whatever the server's logging settings are.
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
SET log_min_duration_statement = -1;
SET log_min_duration_sample = -1;
SET log_transaction_sample_rate = 0;
\getenv forgejo_password FORGEJO_DB_PASSWORD

SELECT format('CREATE ROLE forgejo LOGIN PASSWORD %L', :'forgejo_password')
 WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'forgejo') \gexec
ALTER ROLE forgejo WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'forgejo_password';

SELECT 'CREATE DATABASE forgejo OWNER forgejo ENCODING ''UTF8'' TEMPLATE template0'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'forgejo') \gexec

-- Isolation: each database is reachable only by its owner (and the superuser `plane`); the role forgejo cannot even
-- connect to PPM's database.
REVOKE ALL ON DATABASE forgejo FROM PUBLIC;
REVOKE CONNECT, TEMPORARY ON DATABASE plane FROM PUBLIC;

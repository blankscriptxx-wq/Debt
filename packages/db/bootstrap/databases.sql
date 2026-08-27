-- Development and test databases, owned by the migration role.
SELECT 'CREATE DATABASE solvenda_test OWNER solvenda_owner'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'solvenda_test') \gexec
ALTER DATABASE solvenda_dev OWNER TO solvenda_owner;

\connect solvenda_dev
GRANT USAGE ON SCHEMA public TO solvenda_app, solvenda_platform;
GRANT ALL ON SCHEMA public TO solvenda_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

\connect solvenda_test
GRANT USAGE ON SCHEMA public TO solvenda_app, solvenda_platform;
GRANT ALL ON SCHEMA public TO solvenda_owner;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

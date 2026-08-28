# Tenancy and security

The brief set one constraint above the others: *security must not depend solely
on developers remembering to include a tenant ID in queries*. This document is
how that was met and how it is proved.

## The role layout

Three database roles, created in `bootstrap/roles.sql`, and none of them owns
the schema:

| Role | Used by | Can bypass RLS |
|---|---|---|
| `solvenda_owner` | migrations, schema conformance checks | No |
| `solvenda_app` | all four applications | No |
| `solvenda_platform` | Solvenda Control, under a live access grant | No |

Every one is `NOBYPASSRLS`, the schema owner included. Tables are declared
`FORCE ROW LEVEL SECURITY`, so ownership grants no exemption. This was learned
the hard way: two `SECURITY DEFINER` functions were written early on and both
failed, one silently reporting zero rows verified, because running as the owner
under FORCE RLS sees nothing. Under this configuration, ownership is not a
privilege.

## Binding a tenant

```sql
BEGIN;
SET LOCAL statement_timeout = …;
SELECT set_config('app.tenant_id', $1, true),   -- true = transaction-local
       set_config('app.user_id',   $2, true),
       set_config('app.actor_type',$3, true), …;
```

`app.current_tenant_id()` reads that GUC and returns NULL when it is unset.
Every tenant policy is `USING (tenant_id = app.current_tenant_id())`, so an
unbound connection matches nothing and writes nothing. The binding is
transaction-local, so a connection returned to the pool carries no residue of
the previous request — a property that matters more under connection pooling
than under a per-request connection.

`packages/db` exports `withTenant`, `withPlatform`, `withPublic` and, internally
only, `withOwner`. There is no exported pool. Application code cannot obtain a
connection that is not already bound.

## The four scopes

| Scope | Tables | Policy |
|---|---|---|
| tenant | 47 | `tenant_id = app.current_tenant_id()` |
| global | 11 | readable by all, written under platform context |
| platform | 10 | `app.is_platform_context()` only |
| append-only | 7 (overlay) | UPDATE and DELETE raise, including for the owner |

`app.is_platform_context()` requires two things at once: `current_user` must be
`solvenda_platform` *and* the `app.platform_context` GUC must be set. The
application pool cannot satisfy the first, so no amount of application-level
mischief reaches platform data.

Every table is registered in `app.table_registry` with its scope, and
`schema-conformance.test.ts` walks `information_schema` and fails if any table
in `public` is missing from the registry, missing RLS, missing FORCE, or
missing a `tenant_id` column where its scope requires one. A new table cannot be
merged without a decision about its tenancy, because the build stops.

## The unauthenticated path

The marketing site's contact form is the only write in the platform that happens
with nobody signed in. `withPublic()` binds *nothing* — no tenant, no user, no
platform context — so it inherits the fail-closed behaviour: every tenant table
returns zero rows and refuses every write. The application role is granted
`INSERT` on `platform_enquiries` and no `SELECT`, which means it cannot read
back even the row it just wrote (and cannot use `RETURNING`, which is the point).
Reading enquiries is operator work in Control, under the same access grants and
audit as everything else. Seven tests assert each of those denials.

## Proving it

`tenant-isolation.test.ts` is the release gate. It provisions two real tenants
and then tries to reach one from the other through every shape that appears in
application code: plain selects, joins, aggregates, CTEs, `RETURNING` clauses,
updates, deletes, and writes that attempt to set another tenant's `tenant_id`
explicitly. Each attempt must return nothing or raise. The suite is behavioural
— it asserts what a query *does*, not what a policy says.

## Authentication

- **Passwords**: Argon2id at OWASP parameters, with a length-led policy rather
  than a composition-led one. Long passphrases are encouraged; character-class
  rules are not imposed, because they produce predictable substitutions.
- **Lockout**: counted and compared in SQL. The first implementation compared
  `locked_until > new Date()` in JavaScript, where the driver returns a string
  and the comparison was lexicographic and always false — lockout never engaged.
  Time comparisons now happen in the database.
- **MFA**: TOTP (RFC 6238), enforceable per tenant, and *required* for any
  regulated permission regardless of tenant policy.
- **Sessions**: httpOnly cookies, rotation on privilege change, sliding idle
  window, a bearer token that is never stored (only its hash), and one-command
  revocation of every other session for a user.
- **SSO**: hook points only. SAML and OIDC are not implemented, and that is
  recorded as a first-firm prerequisite rather than implied.

## Authorization

`authorize()` takes a discriminated `Principal` union — user, api_key, workflow,
ai, platform_operator, client — and applies, in order:

1. Status must be active.
2. The permission must be held.
3. If the permission is `regulated`, the principal kind must be `user`.
   API keys, workflow steps and AI capabilities are refused *unconditionally*,
   whatever they have been granted.
4. If the permission is `regulated`, MFA must be satisfied in this session.
5. Every competency the permission names must be recorded against the person.
6. A `platform_operator` is refused every tenant permission. Operator access to
   firm data runs through a separate, time-boxed, audited grant — never by
   holding an ordinary permission.

## Sign-out, and why it is a POST

Sign-out was originally a link. Next prefetches links, so simply *rendering* the
navigation revoked the session and bounced the user to the login screen. It is a
POST form in all three authenticated apps now. The general lesson — that a GET
must not have side effects, and a framework will find out if it does — is why
the browser suites drive real servers rather than asserting against builds.

## What is not built

- SSO (SAML/OIDC) beyond hook points, and WebAuthn.
- Edge rate limiting. The API-key limiter is real; the public contact form's
  throttle is in-process and does not survive a restart or coordinate across
  instances. It says so on the page.
- Field-level encryption for special-category data. Vulnerability records are
  access-controlled and audited, not separately encrypted at rest beyond the
  database's own encryption.
- A penetration test. None has been performed, by anyone.
- UK-only data residency. The chosen hosting can guarantee EU, not UK.

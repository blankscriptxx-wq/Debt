# Implementation log

Chronological record of what was built, what broke, and what remains. Written to
be useful to whoever picks this up next.

---

## W0 — Research and brand

**Done.** Competitor matrix covering Aryza Advize/HubSolv, Turnkey PI, Trustlink,
Logican LogiDebt, CaMS, Trustfolio and Aveni, with an honest read of what the
incumbents do well. Regulatory dossier covering CONC 8, Consumer Duty, FG21/1 and
the FCA/ICO vulnerability data statement, the SFS, IVA Protocol 2025, DRO,
Breathing Space and the Scottish regime — each mapped to an architectural
consequence. Brand book for Solvenda.

**Notable finding.** The original brand, Keel, failed clearance: a live
FCA-authorised UK Banking-as-a-Service platform trades under that name, and KEEL
TECH LTD is on Companies House. Nine alternatives were screened; Solvenda was the
only one with no surfaced UK company or sector conflict.

**Notable finding.** Aveni already performs AI QA across 100% of conversations in
regulated financial services and raised £12m in June 2026. Full-coverage QA is
therefore table stakes, not a differentiator. Our defensible position is owning
the system of record *and* the intelligence layer, so evidence is produced in the
workflow rather than assessed afterwards.

**Not done.** Formal trade-mark clearance. Pricing benchmarks are inference from
market structure, not observed contract values — private vendors do not publish.

---

## W1 — Foundations

**Done.**

*Tenant isolation.* Three database roles, none holding BYPASSRLS. The application
role owns nothing. Every tenant table FORCEs row-level security and carries
`tenant_id NOT NULL DEFAULT app.current_tenant_id()`. Cross-tenant access needs a
different role, an explicit GUC and a stated reason. Proven by 15 behavioural
tests (reads, joins, aggregates, CTEs, forged inserts, tenant moves, updates,
deletes, unbound transactions) and 8 structural tests that apply to every table
that will ever exist.

*Audit ledger.* Append-only via trigger and revoked grants, SHA-256 chained per
tenant, capturing who / what / when / why / source / before / after plus changed
fields. Regulated actions are refused without a stated reason. Credential
material is stripped from payloads before storage. Chain verification reports the
first divergence.

*Auth.* Argon2id (pure WASM — no native build on the deployment target), RFC 6238
TOTP implemented directly, sessions with separate idle and absolute expiry and
only the token hash stored. RBAC over a 46-permission catalogue with nine role
templates.

*The regulated-permission rule.* `authorize()` refuses any regulated permission
to an API key, workflow or AI principal regardless of configuration. Tested
against every regulated permission in the catalogue, including an API key holding
every scope and a workflow explicitly granted the permission.

**What broke, and what it taught us.**

1. `SECURITY DEFINER` gave a function the schema owner's identity — which, under
   FORCE RLS, sees nothing. It failed twice: once for tenant self-read, once for
   chain verification, where it silently reported zero rows checked. Both are now
   ordinary functions running as their caller, with a narrow self-read policy for
   the first. The lesson generalises: under FORCE RLS, ownership grants nothing.
2. The audit chain-head table sat in `public` and so carried a platform-only
   policy the trigger could not satisfy, blocking every audit write. Moved to the
   `app` schema with no grants to either application role.
3. Account lockout never engaged. `locked_until` arrives from the driver as a
   string, so `locked_until > new Date()` compared a string to a Date
   lexicographically and was always false. Time comparisons now happen in SQL.
4. Failed-login counting read-then-wrote, so concurrent attempts could write the
   same value. It increments in the database now.
5. The tamper test initially asserted that an owner-level UPDATE would corrupt
   the ledger. It did not — RLS blocked it. That became its own assertion, and
   genuine tamper detection is now tested through a superuser connection, which
   skips loudly rather than passing silently when unavailable.

**Not done.** SSO/SAML beyond hook points. WebAuthn. Rate limiting at the edge.
Field-level encryption for special category data.

**Tests.** 94 passing against real Postgres.

# Architecture overview

## Shape

```
apps/
  web       Next.js 15  one application, four surfaces, one deployment
              /          the public marketing site
              /app       adviser, team leader and compliance staff
              /portal    the consumer portal, mobile-first
              /control   Solvenda Control, platform operators
              /v1        the public API
packages/
  db            schema, 22 immutable migrations, RLS policies, the only DB access
  auth          sessions, MFA, the permission catalogue, authorize()
  audit         hash-chained append-only ledger, diffing, verification
  core          money, rules engine, case types, SFS, advice, case file, Case Intelligence
  ai            provider abstraction, capability registry, context assembly, proposals
  workflow      trigger → conditions → actions → approvals → follow-up, and its queue
  comms         channel-agnostic communications model and the case timeline
  integrations  adapter contracts, per-tenant registry, API keys, webhooks, simulators
  migration     source profiles, field mapping, dry run, reconciliation
  ui            design tokens and primitives shared by every surface
  testing       tenant fixtures and the assertions the security suites are built from
```

One language across the whole system, one database, and one deployable. The
four surfaces were four applications until they were merged: separate Vercel
projects meant three of them were never deployed, and nothing surfaced that -
the one project that did exist kept building successfully. Postgres is not a
persistence layer here; it is where the security model lives.

## The five decisions everything else follows from

**1. Isolation is enforced by the database, not by application code.**

Every tenant table carries `tenant_id NOT NULL DEFAULT app.current_tenant_id()`
and has row-level security enabled *and forced*. The application connects as
`solvenda_app`, a role that owns nothing and holds `NOBYPASSRLS`, so it cannot
step outside a policy even by accident. `withTenant()` opens a transaction and
sets `app.tenant_id` transaction-locally; when nothing is bound,
`app.current_tenant_id()` returns NULL and every policy evaluates false. A
developer who forgets a `WHERE tenant_id = …` gets zero rows. A developer who
forgets to open a tenant transaction at all gets zero rows.

47 tables are tenant-scoped, 11 are global reference data, 10 are reachable only
under platform context, and 7 are append-only at the trigger level. A schema
conformance test fails the build if a new table appears without a declared scope
and an enforced policy, so the property is maintained by CI rather than by
reviewers noticing.

**2. Every regulated decision belongs to a named human.**

The permission catalogue marks 10 of its 47 permissions `regulated`.
`authorize()` refuses a regulated permission to any non-human principal — API
key, workflow step or AI capability — regardless of how it is configured, and
additionally requires satisfied MFA and a recorded competency. This is not a
policy someone can misconfigure: it is a branch in one function, and it is
tested against every regulated permission with an API key holding every scope
and a workflow explicitly granted the permission.

**3. AI produces proposals, never writes.**

An AI capability declares the fields it may see; context is assembled from that
allowlist and scrubbed of identifiers before it leaves. Output lands as a
proposal. A proposal touching regulated substance can only be resolved by a
person holding `ai:accept_proposal`, with MFA, and the resolution records
accepted / modified / rejected with the diff. The workflow engine follows the
same rule: an action that would write a regulated field emits a proposal
instead.

**4. Configuration beats code.**

Case types are data. Stages, required evidence, eligibility rules, compliance
rules, review cadence and jurisdiction all live in `case_type_definitions` as
JSON validated against a schema. Eight UK solutions ship this way — DMP, IVA,
DRO, bankruptcy, Breathing Space, protected trust deed, sequestration and DAS
— and a firm can add a ninth without a release. A test defines an entirely
novel case type at runtime and drives it through the same engines to prove the
claim. Statutory thresholds are values in a threshold configuration, not
constants in source, and a case records which version was in force when it was
assessed.

**5. The audit record is a by-product of the work.**

Every mutation goes through `auditedMutation`, which writes a `audit_events` row
carrying who, what, when, why, source, before and after, plus the changed field
list and a severity. The rows are hash-chained per tenant (`prev_hash` → `hash`,
under an advisory transaction lock) and the table is append-only at the trigger
level, so a removed or altered row breaks the chain and `verify_audit_chain`
reports where. Nobody has to remember to log anything, which is the only version
of audit that survives contact with a busy afternoon.

## Request path

```
browser
  → Next.js server component or server action
    → session cookie → resolve principal (user, competencies, MFA state)
      → authorize(principal, permission)          ← refuses regulated to non-humans
        → withTenant({ tenantId, userId, … })     ← BEGIN; set_config(…, true)
          → domain function in packages/core
            → auditedMutation(…)                  ← writes the ledger in the same transaction
          → COMMIT
```

The audit write is inside the same transaction as the change it records. A
change that commits without its audit row is not a scenario the code has to
handle, because it cannot occur.

## The case file

The adviser's working surface is a two-pane file: a persistent **spine** on the
left and the section being worked on to its right, at
`/app/cases/[id]/<section>`.

The spine is not a list of tabs. It groups the file by the question being
answered — the client, the money, the advice, the contact — and puts each
section's **evidence state** beside it: verified, declared, waived, expired,
missing, or not required for this case type. Navigation and progress are the
same object, so "where am I" and "what is left" are answered by looking in one
place. A row of equally-weighted tabs is a database schema exposed as
navigation, and it cannot answer the second question at all.

Case Intelligence stands at the head of the spine — health, advice readiness,
what the case needs — rather than behind a tab, because it is the reason to use
this product and it should not be something to remember to open. The overview
section keeps the depth: signals with their sources, the solution comparison,
proposals awaiting a decision.

The spine is derived from the case type's own evidence declarations
(`packages/core/src/case-types/templates.ts`), so a firm adding a case type gets
a correct spine with no code written. A DRO shows an approved-intermediary row
and a DMP does not, because the definitions say so.

Each section is a server component with server actions over one module in
`packages/core/src/case-file/`. The pages resolve the session, read what they
need and hand the input to a domain function; nothing is computed in a page.
That is what lets the rules be tested without a browser, and what stops two
sections disagreeing about the same figure.

### Evidence state

What the spine shows is resolved in one place
(`packages/core/src/evidence/state.ts`) and consumed everywhere, so the spine,
the verification section and the Case Intelligence signals cannot disagree about
what a case is missing.

The distinction it exists to preserve is **declared against verified**. A client
saying they earn £1,800 a month and a payslip showing £1,800 a month are the
same number and not the same fact. So a statement whose lines rest on what the
client said is *declared* however complete it is, and an item confirmed by
telephone is *declared* however it was marked. Consent and vulnerability
assessment are exempt: recording them is what establishes them, and there is no
document either could be checked against.

Two judgements worth naming. A waiver counts as satisfied, because it is a
decision that the item is not needed and second-guessing it here would make one
case read as ready in one surface and not in another. Expired does not, because
evidence that has run out is what a file reviewer most wants to see. And
completeness the software cannot know — "every debt was disclosed" — needs a
person to record it rather than being inferred from rows existing.

Three rules the modules enforce that the schema alone cannot:

- **Household members band on age.** The SFS trigger figures depend on how many
  children there are and how old they are, so a member with neither a date of
  birth nor an age is refused rather than assumed. An assumed age silently
  changes what the client is assessed as being able to afford.
- **Equity is derived on read.** An asset stores its value, the debt secured on
  it and the client's share. The equity DRO eligibility turns on is computed
  from those three, so it cannot drift away from its own inputs.
- **A statement is replaced, never edited.** Saving retires the current version,
  inserts the new one and links the two, inside one transaction — the database
  permits exactly one current statement per case, and "what was the basis of
  that advice" has to keep having an answer.

The advice tab is read-only by design. Recording a decision requires a
rationale, the options considered and why the rejected ones were rejected;
that belongs in its own flow, not in a tab of form fields.

## What runs asynchronously

The workflow engine and the job queue are Postgres-backed
(`FOR UPDATE SKIP LOCKED`), drained by a cron-triggered endpoint rather than a
long-lived process, because the chosen hosting is serverless. A containerised
worker entrypoint is kept in the repository for the workloads that will
eventually need one — call recording and transcription in particular. Runs are
resumable, idempotent per step, and the run history is itself auditable.

## Deliberate omissions

- No message broker. The queue is a table. At the volumes this market runs at,
  the operational cost of a broker exceeds its benefit, and the table is
  transactional with the work it schedules.
- No microservices. One app over one database and one set of packages. The
  isolation that matters here is between tenants, not between services.
- No ORM-level tenancy. Drizzle is used for typing and query building; it is not
  trusted to add a tenant filter, because that is exactly the guarantee the
  database is providing.

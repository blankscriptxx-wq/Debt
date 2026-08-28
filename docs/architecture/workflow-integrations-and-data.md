# Workflow, integrations and the data model

## The workflow engine

Definitions are versioned JSON validated against a schema, and follow the shape
the brief specified: **trigger → conditions → actions → approvals → follow-up**.
Nine step types exist, and the list is deliberately short:

`branch` · `delay` · `ai-capability` · `create-task` · `update-field` ·
`send-communication` · `approval` · `emit-event` · `end`

Two constraints keep the engine on the right side of the regulated line:

**`update-field` writes only through an allowlist.** The target table must be in
`WRITABLE_TABLES`. A workflow cannot reach an arbitrary table because someone
typed one into a definition.

**`update-field` on a regulated field emits a proposal instead of writing.** The
workflow does not have a way to say "but do it anyway", because the check is in
the engine rather than in the definition. A workflow principal is refused
regulated permissions by `authorize()` in any case; this is the second lock on
the same door.

Runs are durable and resumable: state lives in Postgres, steps are idempotent by
key, and the queue claims work with `FOR UPDATE SKIP LOCKED`. The run history is
itself an audit record.

### The approval bug worth recording

Resume-after-approval originally took the step's `next` pointer unconditionally.
A *rejected* approval therefore continued down the approved path — the engine
silently overrode the person the gate existed to capture. Resume now reads the
decision and routes on it, and there is a test for the rejection path
specifically. The general lesson: an approval gate that does not branch on the
answer is not an approval gate, it is a delay.

### The shipped template

`bank-data-received` is the worked example from the brief, tested end to end:
bank data arrives → the AI categorises transactions → declared expenditure is
compared with observed → material differences raise an adviser task → an
approval gate → and only after a human decision does anything regulated change.
It exists as a template a firm can copy and edit, not as a hard-coded path.

## Integrations

The framework is the product; the providers are not. `contracts.ts` defines
capability-shaped adapter interfaces — Open Banking account information, credit
reference, identity verification, e-signature, payments — and a provider
registry with per-tenant installation, configuration and credential storage.
Credentials are held in an envelope-encrypted store reached through
`app.integration_secret`, and the adapter is the only thing that can decrypt.

Five simulators ship: `sandbox-open-banking`, `sandbox-credit-reference`,
`sandbox-identity`, `sandbox-e-signature`, `sandbox-payments`. They are
deterministic, they implement the real contracts, and they are labelled
"simulated" in Solvenda Control, in the case timeline and in the documentation.
No integration is described as live anywhere in the product, because none is.

The public API is versioned (`/v1`), documented by a generated OpenAPI
description, authenticated by scoped API keys with rate limits, and paired with
signed webhooks. The API documentation states which actions no key can ever
perform — the regulated ones — and a test asserts that a key holding every scope
is still refused them.

## Data model

67 tables across 19 immutable, checksummed migrations. The migration runner
verifies checksums on every run and refuses to proceed if an applied file has
changed; that guard fired for real during development when a comment in an
already-applied migration was edited, and the correction had to go into a new
migration instead. That is the behaviour wanted.

The load-bearing shapes:

**Cases and case types.** `case_type_definitions` holds stages, required
evidence, eligibility rules, compliance rules, review cadence and jurisdiction
as validated JSON. `cases` references a definition; `case_stage_history` records
every transition. Adding a solution is a row, not a release.

**Financial position.** `financial_statements` are immutable snapshots with
their lines; correcting a figure supersedes a statement rather than editing it,
so "what did this file look like when that advice was given" always resolves.
`sfs_rulesets` are versioned and tenant-loadable — the shipped figures are
explicitly placeholders, because the real Standard Financial Statement spending
guidelines are licensed content a firm supplies under its own membership.

**Advice.** `advice_decisions` cannot be written without a current financial
statement, an eligibility evaluation, the options considered and a reason for
rejecting each alternative. A trigger, `app.advice_decisions_guard`, refuses any
later edit to the substance: superseding creates a second record and the
original wording survives verbatim.

**Money is always integer pence.** Distribution across creditors uses
largest-remainder, so the parts sum to the whole. No float touches a monetary
value at any point.

**Communications.** One model across email, SMS, letter, portal message,
telephony and internal note, with channel-preference enforcement and a statutory
override for communications a firm is required to send regardless of preference.
Everything authorised lands on the case timeline; internal notes are excluded
from the client's view, and a test asserts that specifically.

**Migration.** Source profiles, field mapping, validation, dry run,
reconciliation and a signed migration report. It runs against a real source
shape rather than an idealised one, because the reason firms stay on software
they dislike is that leaving looks impossible.

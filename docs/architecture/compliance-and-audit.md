# Compliance and audit architecture

The design position is that compliance evidence should be a by-product of the
software working, not a task someone remembers to do. Everything below follows
from that.

## The audit ledger

One table, `audit_events`, carrying every question a supervisor asks:

| Column | Answers |
|---|---|
| `actor_type`, `actor_id`, `actor_label` | **who** |
| `action` (closed vocabulary), `entity_type`, `entity_id` | **what** |
| `occurred_at` | **when** |
| `reason` | **why** |
| `source` | **from where** — console, API, workflow, AI, migration |
| `before`, `after`, `changed_fields` | **before and after** |
| `severity` | how much it matters |

`action` is a closed vocabulary in `packages/audit/src/actions.ts`, each entry
carrying its own severity. A new action has to be declared, which means new
audited behaviour gets a deliberate decision about how serious it is instead of
inheriting whatever string someone typed.

`recordAudit` refuses to write a regulated action without a reason. Not a
default reason — a refusal. The audit trail for regulated activity either
explains itself or does not exist.

## Why it is hash-chained

Each row carries `prev_hash` and `hash`: SHA-256 over a canonical payload,
chained per tenant under an advisory transaction lock so concurrent writers
cannot fork the chain. The table is append-only at the trigger level — UPDATE
and DELETE raise, for the schema owner too.

The point is not that deletion is impossible; a sufficiently privileged
database administrator can do anything. The point is that it is *detectable*.
`verify_audit_chain` walks a tenant's chain and reports the first row where the
recomputed hash disagrees. A tampering test proves this: it modifies a row
through a superuser connection and asserts the verifier finds it. That test
skips loudly rather than passing silently when superuser credentials are
unavailable, because a security test that quietly passes when it cannot run is
worse than no test.

Two findings from building it are worth keeping:

1. The chain-head table originally sat in `public` and so inherited a
   platform-only policy the trigger could not satisfy — which blocked *every*
   audit write. It lives in the `app` schema now, with grants to neither
   application role.
2. The first tamper test asserted that an owner-level UPDATE would corrupt the
   ledger. It did not: RLS blocked the update entirely. That became its own
   assertion, and genuine tamper detection moved to the superuser path.

## Compliance checks

Compliance rules are part of a case type definition, not code. Each is a
declarative expression over case facts, evaluated by a rule engine that is
deliberately not Turing-complete: no loops, no function calls, no way for a rule
to be expensive or non-terminating.

Two properties matter more than expressiveness:

- **A missing fact is null, not false.** "Vulnerability assessment not yet
  recorded" and "vulnerability assessment recorded as none" are different
  states, and a rule engine that collapses them will pass files it should stop.
- **A broken rule blocks rather than passes.** If a rule cannot be evaluated,
  the check does not silently succeed. Failing open is how a compliance gate
  becomes decorative.

## Quality assurance

Manual QA in this market samples 2–5% of interactions. The `qa-review`
capability reviews far more than that and produces structured findings against
the firm's own criteria — but it produces *findings for a reviewer*, not
outcomes. A person signs off. What the AI changes is the size of the population
that gets looked at, not who is accountable for the judgement.

Findings are recorded with the interaction they relate to, so a QA outcome is
traceable to its evidence rather than to a reviewer's memory.

## Consumer Duty and vulnerability

Outcome monitoring is modelled against the four outcomes, and vulnerability is
handled as its own record type with explicit consent to record, disclosure
controls, and the FG21/1 four drivers as the classification. Vulnerability
records are special-category data under UK GDPR and are treated as such in
access control and audit.

The `vulnerability-indicators` capability is marked as touching regulated
fields, so anything it surfaces is a proposal a person resolves. An AI-detected
indicator of vulnerability is a prompt to have a conversation, never a flag that
lands on a client's file on its own.

## What is not built

- **Retention enforcement.** Policies are configuration (`retention_policies`,
  per tenant and data class, with anchor and action). The scheduled deletion and
  anonymisation job that acts on them is not implemented, and neither is legal
  hold.
- **DSAR and erasure tooling.** The data model supports it; there is no
  operator workflow for it.
- **Complaints handling.** Root-cause tagging and the complaints module are
  specified, not built.
- **The QA reviewer workflow.** Sampling rules, review queue, sign-off and
  calibration are partly built. The capability and its prompt are complete and
  tested; the queue a reviewer works through is not finished.
- **Call monitoring.** Depends on telephony credentials that do not exist.

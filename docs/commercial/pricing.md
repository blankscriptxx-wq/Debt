# Commercial model

Solvenda is priced as the system a firm runs on, not as a per-seat tool it
subscribes to. That position has consequences the pricing has to carry: a
platform fee that reflects what the system replaces, seats charged on top of
it, and metering confined to the four things whose cost genuinely varies with
use.

The figures below are the ones in the platform. They are not restated here from
a spreadsheet — `packages/db/src/plans.ts` is the single definition, and the
seeded `plans` rows, Solvenda Control and the public pricing page all read it.
A test asserts the *rendered* figures rather than the stored integers, because
the one pricing error this project has actually made was a fee written in pence
where pounds were meant, and it looked entirely plausible in the source.

## Plans

| | Practice | Firm | Enterprise |
|---|---|---|---|
| Platform fee | £950/mo | £2,850/mo | £7,500/mo |
| Per seat beyond included | £95 | £85 | £70 |
| Included seats | 5 | 20 | 75 |
| Minimum term | 12 months | 24 months | 36 months |
| Support | Standard | Priority | Enterprise, named contact |

**Practice** is a single-office firm establishing itself: case management, the
client portal, workflows and standard reporting, one jurisdiction. The AI layer
is limited to the Case Intelligence narrative — enough to see what the system
does, not enough to build a QA process on.

**Firm** is the intended centre of the market: every case type, the full AI
capability set including AI-assisted QA, compliance monitoring, the creditor and
introducer portals, the public API, and advanced reporting.

**Enterprise** is a group operating at scale across jurisdictions: everything in
Firm plus SSO, custom retention policy, a sandbox tenant, managed migration and
contractual service levels.

## What is metered, and why only this

| Meter | Practice | Firm | Enterprise |
|---|---|---|---|
| AI | Narrative only | £400/mo included, then cost × 1.4 | £2,000/mo included, then cost × 1.25 |
| Open Banking calls | 250/mo, then 45p | 2,500/mo, then 38p | 15,000/mo, then 30p |
| Messages (email, SMS, letter) | 2,000/mo, then 4p | 25,000/mo, then 3p | 150,000/mo, then 2p |
| Document storage | 50 GB, then 60p/GB | 500 GB, then 50p/GB | 2,000 GB, then 40p/GB |

Those four are metered because each one costs us more when a firm does more:
model tokens, provider API calls, message delivery and stored bytes. Everything
else is fixed cost to us and so is fixed price to the firm.

Three things are deliberately *not* metered:

**Cases and clients.** Charging per case gives a firm a financial reason to keep
a file out of the system — a spreadsheet here, a shared drive there. That is
precisely the behaviour that makes a compliance record incomplete, and we are
selling the completeness of that record. A per-case charge would be us billing
for the thing we most need the firm to do.

**Logins.** Seats are charged; sessions are not. A compliance officer who logs
in twice a year to look at one file should not be a line item, and a firm should
never be choosing between visibility and cost.

**Configuration changes.** Adding a case type, changing a workflow, changing a
compliance rule, changing a permission, setting retention policy, turning an AI
capability on or off: all of it is administration a firm does itself, and none
of it is billable. (Configurable forms and custom fields belong in this list and
are specified but not built — they are named in the limitations below rather
than counted here.) This is a deliberate reversal of the incumbent model, where
configuration arrives as a vendor change request. When a firm's process is
shaped by what it can afford to ask for, the software is running the firm rather
than the other way round.

## The margin argument

The AI overage multipliers (1.4× at Firm, 1.25× at Enterprise) are gross-margin
protection on a genuinely variable cost, not a markup on a fixed one. They fall
as the plan gets larger because our own token pricing improves with volume and
because a larger firm has more negotiating position. The included allowances are
set so a firm running at its plan's intended size does not see an overage line
in a normal month — an invoice that fluctuates with how much advisers used the
software teaches advisers not to use the software.

## What sits outside the platform fee

**Implementation and migration** are quoted per engagement against the actual
source system. The honest range is wide: migrating from a well-kept incumbent
database and migrating from fifteen years of spreadsheets are not the same job,
and a single published figure would be wrong for one of them. The migration
*framework* — source profiles, field mapping, validation, dry run,
reconciliation, rollback and a signed migration report — is part of the platform
on every plan; Enterprise includes us operating it.

**Third-party costs stay with the firm.** Open Banking provider fees, credit
reference agency charges, telephony minutes and e-signature envelopes are the
firm's own contracts. We do not resell them, which means we cannot mark them up
and the firm can negotiate them directly. Our metering covers our cost of
carrying the traffic, not the provider's cost of serving it.

**VAT** is excluded throughout.

## Positioning against the incumbents

We are more expensive than a general-purpose CRM a firm has configured itself,
and we intend to be. The comparison that matters is not against software; it is
against what the firm currently spends on the work the platform absorbs:

- a case management system, and the change requests against it
- the manual QA sampling process, which typically reviews 2–5% of interactions
- the analyst time that turns case data into management information
- the file-review hours that a complete, queryable audit record removes
- the adviser time spent reconstructing a case across screens before a call

A firm running 4,000 live plans on the Firm plan with 30 seats pays roughly
£3,700 a month before usage. Whether that is good value is a question about the
five lines above, and we would rather have that conversation than compete on
seat price.

## Discounting and terms

Published prices are the prices. Where a firm negotiates a variation, it is
recorded in `tenant_subscriptions.overrides` against the plan rather than
applied as a private arrangement someone has to remember — the same principle as
everywhere else in the platform: the record is the mechanism, not a note about
the mechanism.

Minimum terms lengthen with plan size because implementation cost does. A
migration that takes three months to do properly cannot be underwritten by a
twelve-month commitment at Enterprise scale.

## Honest limitations of this model

- **These are a reasoned opening position, not observed contract values.** The
  established vendors in this market are private and do not publish. Nobody
  outside them has a verified benchmark, and that includes us. The numbers were
  derived from what the platform replaces, not from what competitors charge.
- **No customer has signed at these prices.** Solvenda has no customers. The
  first three contracts will teach us more about this page than any further
  desk research.
- **Usage allowances are estimates.** They were set from the cost model, not
  from observed consumption, because there is no observed consumption. The
  metering infrastructure (`usage_records`) is built and records against a
  reconstructable period, so the allowances can be corrected from evidence
  rather than re-guessed.
- **Configurable forms and custom fields are not built.** They belong to the
  no-billable-change-requests promise above and are specified rather than
  delivered.
- **Billing is not built.** Plans, subscriptions, overrides and usage records
  are all real configuration and real data. There is no payment collection, no
  invoice generation and no accounting integration. That is a first-firm
  prerequisite, listed as such in the final report.

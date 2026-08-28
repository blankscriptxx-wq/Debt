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

---

## W2 — Domain core

Case types became data. `case_type_definitions` carries stages, required
evidence, eligibility rules, compliance rules, review cadence and jurisdiction
as JSON validated against a schema, and eight UK solutions ship as templates:
DMP, IVA, DRO, bankruptcy, Breathing Space, protected trust deed, sequestration
and DAS. The claim that adding a case type needs no schema change is tested by
defining an entirely novel one at runtime and driving it through the same
engines.

Statutory thresholds live in a threshold configuration rather than in source,
and a case records which version was in force when it was assessed — the
property that matters at a file review two years later, not at the moment of
assessment.

The SFS engine treats statements as immutable snapshots. Correcting a figure
supersedes rather than edits. The shipped trigger figures are explicitly
placeholders; the real spending guidelines are licensed content a firm supplies.

Advice decisions cannot be recorded without a current statement, an eligibility
evaluation, the options considered and a reason for rejecting each. A trigger
refuses later edits to the substance.

**What broke.** The `distributePence` test expectation was wrong — mine, not the
code's. Largest-remainder distribution of £100 across 7/3.5/1.75 shares
correctly gives `[5714, 2857, 1429]`, and I had written what I expected rather
than what the algorithm defines. Worth recording because the failure mode was
trusting my arithmetic over the implementation's.

**Not done.** Cashiering and client money.

## W3 / W4 — Case Intelligence and the AI layer

Case Intelligence composes case health, advice readiness, next best action,
affordability change, declared-vs-observed discrepancies, vulnerability
indicators, compliance risk, engagement, deadlines and creditor changes — each
signal traceable to the records it came from. The browser suite asserts that
every signal displays its sources.

The AI layer went in behind four gates: a per-capability field allowlist, a
declared output schema enforced by strict tool use, proposals rather than
writes, and a full invocation record naming the records the context was built
from. Eight capabilities are built; the rest of the brief's list is specified
with permitted fields and output shapes but not implemented, and is counted as
not implemented.

**What broke.**

1. `extract(month FROM age(…))` returns the *month component*, not total months.
   A review 13 months overdue reported as 1 and the overdue-review signal never
   fired. Now `years * 12 + months`. The bug was invisible in testing because
   every fixture was under a year old.
2. Disengagement only counted clients who had replied at least once. A client
   who has never responded is at least as disengaged as one who stopped, and was
   the case the signal most needed to catch. It now runs from the earliest
   unanswered outbound contact.

**Not done.** Call transcription, document classification and extraction, bank
transaction categorisation, complaint-risk signalling, natural-language search,
management intelligence. Acceptance-rate feedback into capability tuning.

## W5 / W6 — Workflow engine and communications

Nine step types, versioned definitions, durable Postgres-backed runs claimed
with `FOR UPDATE SKIP LOCKED`, idempotency per step, and the brief's bank-data
example shipped as a tested template.

**What broke.** Resume-after-approval took the step's `next` pointer
unconditionally, so a *rejected* approval continued down the approved path. The
engine silently overrode the person the gate existed to capture — the single
most serious defect found in this build, because it defeated a control while
appearing to honour it. Resume now reads the decision and routes on it, with a
test for rejection specifically.

Communications are one model across email, SMS, letter, portal message,
telephony and internal note, with channel-preference enforcement and a statutory
override. Every channel is a simulator.

## W7 — Portals

Adviser console, client PWA and Solvenda Control are built and driven by browser
suites against real servers. Creditor and introducer portals exist as permission
sets and data model only, and are described that way rather than counted.

**What broke.** Four bugs that no unit test would have found, all caught by
driving a real browser:

1. **Sign-out was a GET behind a sidebar link.** Next prefetches links, so
   *rendering the navigation* revoked the session and bounced the user to the
   login screen. Now a POST form in all three authenticated apps.
2. `grid-template-columns: 1fr` is min-content, so a wide table forced the page
   wider than a phone viewport. Fixed with `minmax(0, 1fr)` plus
   `overflow-x: hidden` on html and body.
3. `currentSession` swallowed every error as "not signed in", turning a database
   fault into a silent login loop. It logs and rethrows now.
4. A sign-out button under the 44px touch-target minimum in the client portal.

## W8 / W9 — Compliance, QA and Solvenda Control

Compliance rules are declarative expressions in the case type definition,
evaluated by a deliberately non-Turing-complete engine where a missing fact is
null rather than false and a rule that cannot be evaluated blocks rather than
passes.

Solvenda Control covers tenants, plans, integration providers, AI capabilities,
support access grants, security activity, platform health and — added with the
marketing site — public enquiries.

**What broke.**

1. Plan pricing: `285_000_00` was written intending £2,850 and stored £285,000.
   Exactly the class of error the integer-pence discipline exists to prevent,
   and it was caught only because a test asserted the *displayed* figure rather
   than the stored integer. All plan figures are now asserted as rendered.
2. The seed was not idempotent — it minted a new operator UUID each run and
   collided on the unique email. It looks up by email first now.
3. `app.schema_migrations` was owner-only, so the Control health page failed on
   a permission error. Migration 0017 grants SELECT to `solvenda_platform`.

**Not done.** Retention enforcement (policies are configuration; the deletion
job is not built), legal hold, DSAR/erasure tooling, complaints handling, the QA
reviewer queue and calibration, call monitoring.

## W10 / W11 — Integrations, developer platform, analytics, migration

Capability-shaped adapter contracts with a per-tenant registry and
envelope-encrypted credentials. Five simulators, all labelled as simulated in
the product. Versioned public API with generated OpenAPI, scoped keys, rate
limits and signed webhooks; the documentation states which actions no key can
ever perform, and a test proves a key holding every scope is still refused them.

**What broke.**

1. `app.integration_secret` had EXECUTE revoked from everyone, but the adapter
   genuinely needs it. Migration 0015 grants it — and corrects an overclaiming
   comment in 0014. The migration immutability guard **correctly refused** the
   attempt to edit 0014 in place, which is the guard doing its job.
2. The Anthropic SDK at 0.71 had types too old for adaptive thinking, strict
   tool use and `stop_details`. Upgrading to 0.122 resolved all three.
3. Playwright's `networkidle` never settles against a Next app. Every suite uses
   `domcontentloaded` plus an explicit `waitForSelector`.

## W12 — Marketing site, commercial model, documentation

`apps/www`: eleven pages, no analytics or tracking scripts, every claim paired
with its mechanism, and every page ending with what is not built. The browser
suite asserts that no page carries an unearned claim — certification, customer
count, award or regulatory approval.

Pricing is published. The plan catalogue moved out of the seed script into
`packages/db/src/plans.ts` so the seeded rows, Solvenda Control and the public
page read one definition and cannot drift.

The contact form writes to the database, which required the platform's only
unauthenticated write path. `withPublic()` binds no tenant, no user and no
platform context, and the application role holds INSERT on `platform_enquiries`
and no SELECT — it cannot read back even the row it just wrote. Seven tests
assert each denial.

**What broke.** The first version of the server-validation browser test passed
without testing anything: `type="email"` meant the browser blocked submission
before the server saw it, and the wait selector matched an unrelated heading.
The test now disables the form's own validation before submitting, which is the
case the server is actually defending against.

**Not done.** Billing and invoicing. Domain registration and trade-mark
clearance for Solvenda are outstanding — the brand is provisional.

---

## Final state

- **342 unit and integration tests**, 1 skipped (the tamper test, which skips
  loudly when superuser credentials are absent), against real Postgres.
- **130 browser and API checks** across five suites driving real running
  servers: console 28, client portal 16, Control 20, public API 20,
  marketing 46.
- 19 immutable migrations, 67 tables, 47 permissions of which 10 are regulated.

An earlier commit message in this branch said "333 tests" when the count was
313. The figures above are the accurate ones.

---

## Post-completion: a defect the suites found in each other

Running all five browser suites back to back turned two of them red. The cause
was not a product regression in the usual sense but it exposed one.

`e2e/public-api.mjs` created its test case against whichever client came back
first from `/v1/cases`. That client was Joanne Whitfield — the client the portal
signs in as and the case the console suite searches for. Every API run therefore
attached an empty Breathing Space case to her, which became the most recently
opened open case, which is the one the client portal displays. The portal then
showed a case with no adviser, no solution explanation and no figures, and four
of its assertions failed. The console's overdue-review assertion failed for the
same reason.

Two fixes, because there were two problems.

**The product one.** `loadClientCase` selected the most recently opened open
case and said nothing about the others. A client having two cases at once is
ordinary — a Breathing Space moratorium alongside a DMP referral — and silently
showing one of them to the person they belong to is not defensible. The portal
now names the client's other open cases with their reference and stage. Choosing
what to show first is a design decision; hiding the rest is a bug.

**The test one.** The seed now creates a client with no case (`CL-9000`, Sandbox
Fixture) whose only purpose is to give integration tests somewhere safe to
write, and `make-api-key.mjs` hands its id to the API suite alongside the key.
`e2e/run-all.mjs` wires that up and runs all five suites in one process, so the
arrangement is a script rather than something to remember.

A third thing surfaced while fixing this: the marketing suite could only pass
once an hour, because the contact form throttles per source address and the
suite always presented the same one. It now sends a distinct `x-forwarded-for`
per run — and, since the throttle was clearly working, gained an explicit
assertion that a sixth submission from one source is refused. That check is
driven with submissions that fail validation, so it proves the limit without
depositing five more rows.

**Final counts.** 342 unit and integration tests, 1 skipped. 130 browser and API
checks: console 28, client portal 16, Control 20, public API 20, marketing 46.
Both suites run twice in succession with identical results.

## The adviser case file

Solvenda could read a case and not work one. Every figure in the running
platform came from the seed; grepping for `'use server'` across the console
returned one file, the login page. The data model was strong and nothing could
put anything into it.

Eleven tabs now sit under `/app/cases/[id]` — client details, living
arrangements, employment, assets, debts, income and expenditure, advice,
verification, appointments, checklist and messenger — over one migration
(`0022_case_file.sql`) and one module per subject in `packages/core/src/case-file/`.
The pages stay thin because the domain functions are where the rules live, which
is also what makes them testable without a browser.

Three things were decided rather than defaulted:

**Household composition bands on age, not on a "dependant" flag.** The SFS
trigger figures change with the number and ages of children, so a 17-year-old in
full-time education and a 22-year-old lodger cannot be the same record type.
Entering a member without either a date of birth or an age is refused outright
rather than assumed, because an assumed age silently changes what the client is
assessed as being able to afford.

**Equity is derived, never stored.** An asset holds its value, the debt secured
on it and the client's share; the equity that DRO eligibility turns on is
computed from those three. Storing it would let it drift away from its own
inputs, and the number that decides whether a DRO is available is not a number
to let drift.

**Removing a debt withdraws it.** `status = 'removed'` rather than a delete: a
creditor that turns out not to exist is still something the file should be able
to explain later. Removed debts are excluded from every total.

The advice tab is deliberately read-only. Recording a decision goes through
`recordAdviceDecision`, which requires a rationale, the options considered and
the reasons the rejected ones were rejected — that belongs in a purpose-built
flow, not a tab of form fields beside an address editor.

### Two bugs the work surfaced

**Saving a statement collided with its own uniqueness rule.** `saveStatement`
inserted the new version and then marked the old one superseded. Only one
statement per case may be current, enforced by a partial unique index, so the
insert failed against any case that already had one — every case in the product.
The order is now retire, insert, then link the retired version to its
replacement, all inside the one transaction the save already ran in.
`packages/core/test/statement-entry.test.ts` covers it, and fails with the
original constraint violation if the ordering is put back.

**The suite spoiled the fixtures it shared.** The case file suite does not read a
case, it works one — and working `DMP-0001` moved the totals the console and
client portal suites assert on and reset the review date the overdue-review
signal is derived from. Two suites failed, neither of them the new one. The seed
now creates `DMP-9100` for this suite alone, on the same reasoning that produced
`CL-9000` for the API suite, and the suite's assertions measure movement rather
than absolute totals: it records a figure, adds something, and checks the figure
moved by exactly what was entered. That is both repeatable and the stronger
assertion — four-weekly pay of £500 has to raise monthly household income by
£541.67, not merely display a plausible number.

Three smaller things were wrong and are fixed: the seed's development-database
guard read `PGDATABASE` directly and so refused to run when the variable was
unset, even though the connection would have defaulted to `solvenda_dev`;
`bootstrap/databases.sql` created the test database but assumed the development
one already existed, so it could not rebuild an environment from nothing; and the
"have I already seeded?" check counted every case, which the new fixture would
have made permanently true.

**Counts.** 371 unit and integration tests, 1 skipped. 187 browser and API
checks across seven suites: console 28, client portal 16, Control 22, public API
20, marketing 46, demo sign-in 9, case file 36. The full browser suite runs twice
in succession with identical results, against a database the second run inherits
from the first.

## The case file, redesigned around evidence

The eleven tabs worked and their design was taken from the HubSolv screenshots.
The visual layer was ours — the palette, Inter with tabular figures, the 4px
base, the `regulated` purple. The information architecture was not: eleven
equally-weighted tabs in a horizontal strip, labelled and ordered as HubSolv
labels and orders them. That is the part that counts as the design.

The resemblance was not the worst of it. A row of eleven drawers is a database
schema exposed as navigation — the thing the brief says the incumbents get
wrong — and it made **Case Intelligence, the product's whole argument, a peer of
"Appointments"**.

### What replaced it

A persistent left spine with the work beside it. Three things make it ours
rather than a rearrangement of theirs.

**It is grouped by the question being answered** — the client, the money, the
advice, the contact — not by table name. An adviser asks "do I know enough about
this person yet", not "have I opened the employment_records tab".

**Every row carries evidence state, not a count.** Verified, declared, waived,
expired, missing, or not required for this case type. A count says how much is
there; the state says whether it can be relied on. Each state has a glyph as
well as a colour, because a red dot and a green dot are the same dot to a
significant number of advisers and this status decides whether a regulated
recommendation can be made.

**It is derived from the case type's own declarations**, so a firm adding a case
type gets a correct spine with nobody writing code. A DRO shows an
approved-intermediary row and a DMP does not, because the definitions say so.

Case Intelligence now stands at the head of the spine on every section rather
than behind a tab. The overview keeps the depth — signals with their sources,
the solution comparison, proposals awaiting decision — and is the place you open
for detail rather than the only place any of it appears.

### The bug underneath, which was the larger half

Evidence state was answered by one query: the distinct purposes of granted
consents. So the only evidence that could ever be true was a consent, and
`identity.verified`, `sfs.complete` and `debts.captured` are not consents. The
seed wrote them as consent rows anyway, which is why the product looked correct.
Nothing outside the seed ever wrote them, so a case genuinely worked through the
case file would have shown its evidence outstanding forever, however complete.

Building a spine on that would have displayed the fiction more prominently, so
the two were one piece of work. `packages/core/src/evidence/state.ts` resolves
each requirement against the records that actually decide it, driven by the
requirement's `kind` rather than a table of known keys. The verification section
was the same problem one layer up: it called `syncRequirements` — which existed
and was correct — with a hardcoded list of six checks that were not the case
type's requirements, so acting on a row moved nothing. It now passes the case
type's own evidence, which is what makes that section the place the spine's
states are resolved.

The demonstration data is no longer uniformly complete as a result. One case is
fully verified; one has a debt list confirmed only by telephone, which the spine
reports as declared; one rests entirely on what the client said. That is a
better demonstration as well as a truthful one.

### Three more defects, found by the work

**Saving a statement raced with itself.** The version was read and then
inserted, so two saves a moment apart — a double-clicked button is enough — both
saw the same maximum and the second violated `(case_id, version)`. Retiring the
current statement first was not sufficient either: each transaction retires the
row it can see, neither sees the other's insert, and both land a second
`current`. Saves are now serialised on the case row, and the version is computed
inside the insert. Tested with three concurrent saves, which produce three
contiguous versions and one current.

**A recorded "no indicators identified" had nowhere to live**, since
`vulnerability_records` constrains `driver` to the four FG21/1 drivers. It is a
verification item, which needs no schema change.

**The overview's right rail collapsed on viewport width** while the spine had
taken 300px of its space, so it stayed beside a main column with no room for it.
It is a container query now, measured against the space it actually has.

**Counts.** 398 unit and integration tests, 1 skipped. 194 browser and API
checks across seven suites; the case file suite grew from 36 to 43 and now
asserts the transition the redesign rests on — recording evidence moves the
section to verified, a verbal confirmation drops it to declared, and withdrawing
it returns it to missing. Two consecutive full runs, identical results.

## The trade's words, and the missing regulated action

Two things followed from working the redesigned file rather than looking at it.

**The labels were an overcorrection.** Avoiding HubSolv's interface does not
mean avoiding the profession's vocabulary. "I&E", "SFS", "living arrangements"
and "verification" are what UK debt advisers say; renaming them to "Income and
spending" and "Vulnerability and checks" cost recognition and bought nothing.
The grouping is ours — the client, the money, the advice, the contact — and the
names are the trade's. The brand book already said this: *say what the software
does, in the words a practitioner would use.*

**Advice could not be recorded anywhere.** The section was read-only, on the
argument that a form would be "a path around the guard rather than through it".
That reasoning was wrong: the guard lives in `recordAdviceDecision`, and a form
that calls it goes through the guard by definition. The consequence was that the
regulated core of a debt advice case — the recommendation — existed as a table
of decisions nobody could add to.

Underneath it was a second gap. `recordAdviceDecision` requires an eligibility
evaluation as the basis of the decision, and **nothing outside the tests ever
wrote one**. `evaluateEligibility` is a pure function run on every page load to
draw the comparison, which is right for a display and useless as a record: the
rules, the trigger figures and the client's own figures all move, so "which
solutions were open to this person when that advice was given" cannot be
answered by running it again later. `saveEligibilityEvaluation` writes down the
evaluation the adviser was actually looking at, and the decision points at that
row.

The recorder is deliberately plain: recommend one solution, tick every other
that was genuinely on the table, give a reason for each rejection, a rationale
of at least forty characters, the risks explained, the client's response, and an
override reason where the engine ruled the recommendation out. Nothing posted
from the browser decides anything — eligibility is recomputed server-side at
submit, written down, and the decision recorded against it in one transaction,
so what the adviser saw and what the file says they saw cannot come apart. Every
refusal is shown verbatim rather than summarised, because the wording is what
tells the adviser what to do: submitting an unreasoned recommendation returns
*"a rationale of at least 40 characters is required · the reason for rejecting
'iva' is too brief to be meaningful · 'dmp' did not meet has-surplus"*, all at
once.

Correcting advice supersedes it. While a decision stands the form replaces it
rather than adding a second, requires a reason of at least twenty characters for
what changed, and keeps the original wording exactly — which the database
enforces independently: an `UPDATE` to a decision's substance is refused with
*"the substance of an advice decision is immutable; record a superseding
decision instead"*.

**Counts.** 398 unit and integration tests, 1 skipped. 200 browser and API
checks across seven suites; the case file suite is 49, covering the advice
refusals, a recorded decision and a supersession that keeps its predecessor.

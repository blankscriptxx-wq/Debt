# Solvenda — final report

*A UK debt advice, debt management and personal insolvency platform, built from
an empty repository. Branch `claude/uk-debt-advice-saas-6292ph`.*

---

## 1. What was asked for, and what this is

The brief was to build a standalone SaaS brand and platform for the UK debt
advice, debt management and insolvency industry — AI-native, capable of
competing with Aryza Advize/HubSolv and Trustlink, with the stated objective of
making the current generation of debt-advice CRMs feel outdated.

What exists now is a working multi-tenant platform: one application serving the
marketing site, the adviser console, the client portal and platform
administration, eleven packages, 71 tables across 22 immutable migrations, 371
unit and integration tests against real Postgres, and 187 browser and API checks
driving real running servers. It is a deep, working vertical slice on enterprise foundations, not a
demonstration with a database behind it — but it is not a product a regulated
firm could be onboarded onto tomorrow, and section 12 says exactly why.

The single organising idea: **the compliance evidence and the case intelligence
should be a by-product of the software working, not a task someone remembers to
do.**

---

## 2. Market research and the competitive reading

Full detail in `docs/research/competitor-matrix.md` and
`docs/research/regulatory.md`. The short version.

**The incumbents are mature and should not be underestimated.** Aryza Advize
genuinely covers lead to closure including cashiering, which is the hardest and
least glamorous part of this market. Turnkey is deeply entrenched with insolvency
practitioners and has decades of statutory heritage. Trustlink owns the front of
the funnel and the introducer-to-IP handoff. Trustfolio owns the creditor-side
rails and is better treated as a network to integrate with than a competitor to
displace. Aveni — £12m raised, FCA Supercharged Sandbox — is the most credible
AI-in-regulated-FS player and is the clearest evidence that QA across all
conversations is becoming an expectation rather than a differentiator.

**The opening is architectural, not functional.** Across the incumbents,
consistently: an adviser reconstructs a case by hand across many screens; QA
samples 2–5% of interactions; declared and observed expenditure are compared by
eye if at all; configuration changes arrive as vendor change requests; and the
audit trail is a log rather than a tamper-evident record. Meanwhile CONC 8, the
Consumer Duty and FG21/1 demand evidence at a volume manual process struggles to
produce.

**Where the brief's assumptions were tested rather than accepted.** Three
places I concluded differently:

1. *AI as the differentiator.* It is not, or not for long — model capability is
   a commodity that improves for every vendor at once. The durable asset is the
   audit substrate that makes AI-assisted QA defensible. The AI is the visible
   part; the schema is the moat.
2. *Replacing Trustfolio.* Building competing creditor rails would be a
   distraction. Integration is the correct posture.
3. *Cashiering.* The brief implied full coverage. Client money handling is a
   genuine barrier to replacing Aryza and it is not built. Pretending otherwise
   would have been the most damaging thing in this report.

---

## 3. Product strategy

One journey from lead to closure — referral, onboarding, consent, identity,
vulnerability, Open Banking, credit information, income and expenditure, debts,
affordability, eligibility, solution comparison, advice, documents, signature,
implementation, payments, ongoing management, review, arrears, closure —
configured per case type rather than reimplemented per case type.

Eight UK solutions ship as configuration: DMP, IVA, DRO, bankruptcy, Breathing
Space, protected trust deed, sequestration and DAS. Each carries its own stages,
required evidence, eligibility rules, compliance rules, review cadence and
jurisdiction. Adding a ninth requires no schema change and no release, and that
claim is tested by defining an entirely novel case type at runtime and driving
it through the same engines.

Statutory thresholds are values, not constants, and a case records which version
was in force when it was assessed.

---

## 4. Architecture

Detail in `docs/architecture/`. The five decisions everything follows from:

**Isolation is enforced by the database.** Every tenant table carries
`tenant_id NOT NULL DEFAULT app.current_tenant_id()` with RLS enabled *and
forced*. The app connects as a non-owner role with `NOBYPASSRLS`. Tenant binding
is transaction-local; unbound means `app.current_tenant_id()` is NULL and every
policy evaluates false. A forgotten filter returns zero rows. 47 tenant tables,
11 global, 10 platform-only, 7 append-only, and a conformance test that fails
the build if a new table has no declared scope.

**Every regulated decision belongs to a named human.** 10 of 47 permissions are
marked `regulated`. `authorize()` refuses them to any non-human principal — API
key, workflow, AI — unconditionally, and additionally requires MFA and a
recorded competency.

**AI produces proposals, never writes.** Four gates: field allowlist, declared
output schema, proposal-not-write, full invocation record.

**Configuration beats code.** Case types, workflows, compliance rules,
permissions, retention policy, AI capability enablement and plans are all data.
Configurable forms and custom fields are specified but not built.

**The audit record is a by-product.** Every mutation writes who/what/when/why/
source/before/after in the same transaction as the change, hash-chained per
tenant, append-only at trigger level, with a verifier that locates a break.

---

## 5. Modules

| Module | State |
|---|---|
| Clients, cases, participants, linked cases | Built |
| Creditors (reference registry + tenant records), debts with provenance | Built |
| Documents, consents (granular, versioned, withdrawable) | Built |
| Vulnerability records (special-category handling, disclosure controls) | Built |
| SFS engine: immutable snapshots, versioned rulesets, surplus, diffing | Built |
| Eligibility, solution comparison, advice decision record | Built |
| Case Intelligence | Built |
| AI layer | Built; 8 of ~20 capabilities implemented |
| Workflow engine | Built |
| Communications | Built; every channel is a simulator |
| Compliance checks | Built |
| QA | Capability built; reviewer queue and calibration partial |
| Adviser case file: eleven tabs of data entry over the model | Built |
| Analytics and dashboards | Built |
| Migration framework | Built |
| Public API, webhooks, API keys | Built |
| Platform administration (Solvenda Control) | Built |
| Cashiering and client money | **Not built** |
| Billing and invoicing | **Not built** |
| Retention enforcement, legal hold, DSAR tooling | **Not built** |
| Complaints handling | **Not built** |

---

## 6. Case Intelligence

The defining feature, and the reason an adviser would prefer this to what they
have. Opening a case presents a composed view: case health, advice readiness
(what is missing to advise safely), next best action, outstanding tasks,
affordability change, declared-vs-observed discrepancies, vulnerability
indicators, compliance risk, engagement signals, deadlines, creditor changes,
payment issues, changes since last review, and an AI narrative.

Every signal is traceable to the records that produced it — the browser suite
asserts that each displays its sources — and signals are computed from domain
events rather than inferred by a model reading a screen. The AI narrative sits
on top of the composed view; it is not the view.

Two bugs found here are worth repeating because they show what "works" means.
`extract(month FROM age(...))` returns the month *component*, so a review 13
months overdue reported as 1 and the signal never fired. And disengagement
initially only counted clients who had replied at least once — excluding the
client who has never responded, who is the case the signal most needed to catch.

---

## 7. AI architecture

Detail in `docs/architecture/ai.md`. Eight capabilities: case summary, I&E
discrepancy, advice readiness, vulnerability indicators, duplicate debt, advice
rationale draft, communication draft, QA review.

Every capability inherits a house rule block whose substance is: *you never give
advice to a consumer and you never decide anything; a divergence, an indicator
or a pattern is a question to ask, not a finding.* That last clause is the
difference between "this client is concealing income" and "declared income and
observed credits differ by £340 a month; worth asking about", and only the
second survives a file review.

Provider abstraction with a deterministic stub, so the entire suite runs offline
and in CI with no API key. Per-tenant enablement enforced at the invocation
layer, not hidden in the UI.

The honest cost of this design: it is slower than letting the model write, and
the AI cannot learn from its rejected proposals within the platform.

---

## 8. Compliance architecture

Detail in `docs/architecture/compliance-and-audit.md`.

Compliance rules are declarative expressions in the case type definition,
evaluated by an intentionally non-Turing-complete engine with two properties
that matter more than expressiveness: a missing fact is null rather than false
(so "not yet assessed" and "assessed as none" stay distinct), and a rule that
cannot be evaluated blocks rather than passes.

Advice decisions require a current statement, an eligibility evaluation, the
options considered and a reason for rejecting each. A database trigger refuses
later edits to the substance; superseding creates a second record and the
original wording survives verbatim.

AI-assisted QA reviews far more than a 2–5% sample and produces findings for a
human reviewer. What changes is the size of the population examined, not who is
accountable for the judgement.

---

## 9. Security

Detail in `docs/architecture/tenancy-and-security.md`.

Argon2id with a length-led password policy; TOTP MFA, mandatory for any
regulated permission; httpOnly sessions with rotation, sliding idle window and
hash-only token storage; a permission model where platform operators hold *no*
tenant permissions and reach firm data only through a time-boxed, audited grant.

The cross-tenant isolation suite is the release gate. It provisions two real
tenants and attempts to reach one from the other through plain selects, joins,
aggregates, CTEs, `RETURNING`, updates, deletes and writes that set another
tenant's `tenant_id` explicitly. Every attempt must return nothing or raise.

The only unauthenticated write path — the marketing site's contact form — binds
no tenant, no user and no platform context, and holds INSERT on one table and no
SELECT anywhere. It cannot read back the row it just wrote.

**Not done:** SSO/SAML beyond hook points, WebAuthn, edge rate limiting,
field-level encryption for special-category data, and a penetration test. No
penetration test has been performed, by anyone.

---

## 10. Integrations, workflows, portals, admin, analytics

**Integrations.** A capability-shaped adapter framework with a per-tenant
registry, envelope-encrypted credentials and five deterministic simulators
(Open Banking, credit reference, identity, e-signature, payments). Every one is
labelled simulated in the product. **No integration is live, because no vendor
credentials exist.**

**Workflows.** Nine step types, versioned definitions, durable resumable runs,
`update-field` restricted to an allowlist and forced to emit a proposal when the
target is regulated. The brief's bank-data example ships as a tested template.

**Portals.** Adviser console, client PWA (mobile-first, 44px touch targets, no
horizontal overflow at 390px) and Solvenda Control are built and browser-tested.
Creditor and introducer portals exist as permission sets and data model only.

**Platform administration.** Tenants, plans, providers, AI capabilities, support
access grants, security activity, health, enquiries. The operating principle is
that anything which can safely be configuration is configuration.

**Analytics.** Executive, operations and compliance views over real case data.

**Migration.** Source profiles, field mapping, validation, dry run,
reconciliation, rollback and a signed report.

---

## 11. Commercial model and brand

Detail in `docs/commercial/pricing.md` and `docs/brand/brand-book.md`.

Practice £950/mo + £95/seat (5 included, 12 months). Firm £2,850/mo + £85/seat
(20 included, 24 months). Enterprise £7,500/mo + £70/seat (75 included, 36
months). Metering on AI, Open Banking calls, messages and storage — the four
things whose cost genuinely varies. Cases, logins and configuration changes are
deliberately *not* metered.

The figures are a reasoned opening position derived from what the platform
replaces, not observed contract values: the incumbents are private and nobody
outside them has a benchmark, including us.

**Brand.** "Keel" was the first choice and **failed clearance** — a live
FCA-authorised UK BaaS platform of that name came out of stealth in May 2026,
plus a Companies House registration. Seven further candidates were screened and
conflicted. Solvenda was selected.

**Naming and branding are deferred by decision.** Solvenda is a working
placeholder, not a committed brand: trade-mark clearance (UK IPO classes
9/36/42) and domain registration have not been done and are not being treated as
launch prerequisites. What matters for the deferral is that it stays cheap to
reverse, and it does — see section 16.

The marketing site claims nothing unearned. No certifications, no partnerships,
no customer counts, no regulatory approvals, no awards — and the browser suite
asserts their absence rather than trusting an editorial intention.

---

## 12. What must be true before onboarding the first real regulated firm

Ordered by what would stop a launch.

**Regulatory and legal**
1. The firm holds its own FCA authorisation; Solvenda is not authorised and does
   not give advice. This is stated in the product and on every page of the site.
2. A DPIA covering special-category vulnerability data and AI processing.
3. Data processing agreements, and a decision on the residency gap below.
4. An SFS membership: the shipped trigger figures are placeholders. Real spending
   guidelines are licensed content the firm supplies.

*Naming and branding are deliberately deferred and are not on this list. See
"Naming" below.*

**Security**
6. An independent penetration test. None has been done.
7. Edge rate limiting in front of the public site and the API.
8. SSO (SAML/OIDC) — most firms of scale will require it.
9. Field-level encryption for special-category data.
10. A documented incident response process and a tested backup restore.

**Functional**
11. **Cashiering and client money.** The largest single gap. A firm running DMPs
    cannot operate without it, and it is not built.
12. **Billing.** Plans, subscriptions and usage records exist; payment
    collection, invoicing and accounting integration do not.
13. **At least one live integration per critical category.** Everything is a
    simulator. Open Banking and identity verification are the minimum.
14. **Retention enforcement and legal hold.** Policies are configuration; the job
    that acts on them is not built. This is a statutory obligation, not a
    feature.
15. **Complaints handling** with root-cause tagging.
16. **The QA reviewer queue**, sign-off and calibration — the capability exists,
    the workflow around it is partial.

**Operational**
17. UK data residency. The chosen hosting guarantees EU, not UK. Several firms
    will refuse on this alone; it needs either a hosting change or an explicit,
    documented acceptance.
18. Production disaster recovery with a tested RTO and RPO.
19. A real migration rehearsal against that firm's actual data, not a profile.
20. Support processes, SLAs and an on-call rota matching what the plans promise.
21. A runner for the workflow queue. The engine is durable and tested, but
    nothing outside the test suite claims jobs, so in a deployed environment
    delays never elapse and follow-ups never fire. See `docs/deployment.md`.

---

## 13. Recommended roadmap

**Now → first pilot (3–6 months).** Cashiering and client money. Live Open
Banking and identity adapters. Billing. Retention enforcement. Penetration test.
SSO. Then a single design partner, migrated for real.

**Pilot → general availability (6–12 months).** Complaints. The QA reviewer
workflow end to end. Creditor and introducer portals as real interfaces.
Telephony with recording and transcription — the largest unmeasured compliance
risk in this market sits in calls. Remaining AI capabilities, especially
document extraction and bank transaction categorisation. UK residency.

**Beyond (12–24 months).** Trustfolio-class creditor rails integration. A
regulatory change feed that identifies which live cases a moved threshold
affects. Open Finance beyond account information. Agentic multi-step assistance
behind the same proposal gate — where the work is human review ergonomics, not
the permission model.

Explicitly refused, permanently: automating the regulated advice decision;
consumer-facing AI advice; predictive scoring of consumers (operational
prediction has the same commercial value and none of the fairness exposure).
See `docs/future-advantage.md`.

---

## 14. Honest limitations

- Eleven of roughly twenty AI capabilities are specified but not built.
- Every external integration is a simulator.
- Creditor and introducer portals are data model and permissions, not interfaces.
- Cashiering, billing, complaints, retention enforcement and DSAR tooling are
  absent.
- The workflow queue has no runner outside the tests, so workflow automation is
  functional in principle and inert in a deployment.
- No penetration test, no ISO or SOC audit, no certifications of any kind.
- No customers. No signed contracts. No validation of the pricing.
- Solvenda is not FCA authorised and does not give debt advice.
- The name is a placeholder. Trade-mark clearance and domain registration have
  not been done, by decision rather than oversight, and section 16 states what
  a later rename costs.
- UK-only data residency is not achievable on the chosen hosting.
- SFS trigger figures are placeholders, not licensed content.
- The competitor matrix is a reading of public information, compiled August 2026,
  and carries a review date for that reason.

---

## 15. What I would say if asked whether it meets the objective

The objective was to make the current generation of debt-advice CRMs feel
outdated. On the things that were built, it does: case types as configuration
rather than change requests, a composed case view instead of eleven screens,
tamper-evident audit as a by-product rather than a log, QA across a population
rather than a sample, and a permission model where the line between assisting an
adviser and issuing regulated advice is a branch in one function rather than a
paragraph in a policy.

On completeness, it does not yet compete with Aryza Advize, and the reason is
client money. A firm cannot run DMPs on software that cannot handle
distributions. That is the honest state of it, and it is first on the roadmap
rather than absent from it.

---

## 16. Naming: what deferring it costs

Naming and branding are deferred by decision. That is a reasonable call — the
name is the cheapest thing to change about a platform and the most expensive
thing to argue about early. But "cheap" is not "free", and the cost is worth
stating now rather than discovering it later.

**Brand-neutral already, and deliberately so.** None of the structural
decisions carry the name. The GUC namespace is `app.*`. The CSS class prefixes
are `sv-`, `mk-`, `cp-` and `ct-` — initials, not words. Table names, column
names, permission keys, capability keys, case type keys and audit actions are
all domain vocabulary. A rename touches none of it.

**What a rename would actually touch:**

| Surface | Count | Difficulty |
|---|---|---|
| User-visible copy across the four surfaces | 22 references | Trivial — find and replace |
| Marketing site content | 10 pages | Rewrite, but it is copy either way |
| Workspace package names (`@solvenda/*`) | 16 `package.json` files | Mechanical: rename, update imports, reinstall |
| Database role names (`solvenda_app`, `solvenda_owner`, `solvenda_platform`) | 50 references across `roles.sql` and 22 migrations | **The only real work** |
| Environment variables (`SOLVENDA_*`) and database names | 4 names | Mechanical |

**The database roles are the one genuinely awkward item**, and only because the
migrations are immutable and checksummed — a guard that has already earned its
place by refusing an edit to an applied file. The roles are named in `GRANT`
statements throughout the migration history, and those files cannot be edited in
place. Renaming them means either `ALTER ROLE … RENAME TO` in a new migration
with the old names left in history (which works, and leaves the history
honestly showing what was run at the time), or accepting that the internal role
names simply do not match the eventual brand.

**The recommendation: leave the roles alone whichever name is chosen.** Database
role names are internal identifiers that no customer, auditor or regulator ever
sees. Coupling them to a brand is what created this question in the first place,
and renaming them a second time when the brand changes again would repeat it.
If they are ever touched, rename them to something functional — `app_rw`,
`schema_owner`, `platform_rw` — so the question never recurs.

**What the deferral does not change.** Nothing in this build depends on the
name being settled. The one place it would surface is a customer-facing
document or a signed contract, and there are none. The deferral is safe to hold
until there is a commercial reason to close it — and closing it then needs a
trade-mark attorney and a fortnight, not an engineering project.

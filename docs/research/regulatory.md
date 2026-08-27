# Regulatory dossier

What the platform has to accommodate, and the architectural consequence of each.
This is a working engineering reference compiled from public sources in August
2026. **It is not legal or compliance advice**, it is not a substitute for a
firm's own compliance function, and Solvenda holds no regulatory permissions of
its own. A firm using the platform remains responsible for its own compliance.

---

## 1. FCA Consumer Credit sourcebook, CONC 8 (debt advice)

CONC 8 governs firms giving debt advice or operating debt management plans. It
covers conduct standards, pre-contract information, the content of advice, DMP
operation, and the use of lead generators. CONC 8 was last updated 31 July 2026.

Points with direct architectural consequences:

| Requirement | Consequence in the platform |
|---|---|
| Advice must be suitable for the customer's actual circumstances | Advice decisions cannot be recorded without a current financial statement and a completed eligibility evaluation; the decision record captures options considered and why each was rejected |
| Firms must have policies to identify and appropriately handle particularly vulnerable customers. CONC notes that most customers seeking debt advice may be vulnerable to some degree | Vulnerability is a structured record with its own permission, not a flag; the case cannot reach advice without a vulnerability assessment step being addressed |
| Pre-contract information must be given before a contract is entered into | Document issue and acknowledgement are case-type-configurable required evidence, blocking progression until satisfied |
| Lead generator conduct is in scope | Introducer portal records referral source, consent basis and the introducer's own declarations; referral quality is reported back |

## 2. Consumer Duty (PRIN 2A)

PRIN 2A.9 requires firms to monitor the outcomes their retail customers actually
receive, and boards to review outcomes data, MI, root cause analysis and action
tracking.

Consequence: outcome monitoring is a product surface, not a report someone
assembles quarterly. The four outcomes — products and services, price and value,
consumer understanding, consumer support — each map to measurable signals the
platform already holds:

- **Products and services** — solution distribution by cohort; how often a
  recommended solution is later superseded or breaks down
- **Price and value** — fee-to-benefit where fees apply; case outcomes against
  cost to the client
- **Consumer understanding** — comprehension checkpoints in the client portal;
  reading level of issued communications; question and complaint patterns
- **Consumer support** — time to first contact, resolution times, channel
  accessibility, drop-off points in the journey, vulnerable-cohort comparison

The platform's job is to produce this evidence continuously and let a firm
interrogate it, not to assert that a firm is compliant.

## 3. Vulnerability — FG21/1 and the FCA/ICO joint statement

FG21/1 frames vulnerability through four drivers: **health, life events,
resilience, capability**. Firms are expected to identify, respond and monitor
outcomes for vulnerable customers, with expectations on culture, training and
service design.

The FCA and ICO have jointly addressed firms' handling of vulnerability data.
The critical point for engineering: **vulnerability information is frequently
special category data under UK GDPR**, particularly where it concerns health or
mental capacity. Processing needs both an Article 6 lawful basis and an Article 9
condition. Consumer Duty guidance is explicit that outcome monitoring does not
override data protection obligations and does not require firms to collect new
data about protected characteristics.

Architectural consequences:

- Vulnerability records are modelled against the four FG21/1 drivers, with
  structured indicators, adviser assessment, and support actions taken
- Separate `vulnerability:read` and `vulnerability:write` permissions; the write
  permission is regulated
- Explicit, recorded consent to *record* health-related detail, held separately
  from consent to process the case, and independently withdrawable
- Disclosure controls: what may be shared with a creditor is a deliberate
  decision, not a side effect of a data export
- AI vulnerability *indicators* are proposals for adviser consideration. The
  platform never converts an inferred signal into a recorded vulnerability
  without a human deciding

## 4. Standard Financial Statement

The SFS is the universal income and expenditure format for the UK debt advice
sector, with a single set of spending guidelines and a code of conduct. Access
to the formats and trigger figures requires an SFS membership number issued to
organisations in the debt sector; guidelines are versioned annually (the current
commentary is 2026/27).

Consequences:

- Spending guideline values are **licensed content the firm supplies**, not
  content Solvenda ships. The platform provides a versioned ruleset loader with
  placeholder values, and records which ruleset version was in force for each
  statement
- Financial statements are immutable snapshots. Changing a figure supersedes a
  statement rather than editing it, so an adviser can always answer "what did the
  file look like when this advice was given?"
- Surplus, trigger-figure comparison and category totals are computed and stored
  with the version that produced them

## 5. Solution-specific frameworks

| Solution | Framework | Platform consequence |
|---|---|---|
| **IVA** | IVA Protocol 2025 (Insolvency Service). Flags prior Breathing Space or DMP in the last 24 months, and any previous DRO or bankruptcy | Case type configuration encodes protocol-driven eligibility questions and required disclosures; prior-solution history is a first-class field |
| **DRO** | Debt, asset and surplus income limits, set by regulation and revised periodically | Limits are versioned configuration, never constants in code |
| **Bankruptcy** | Application via the adjudicator; fee payable | Configured as a case type with its own evidence set |
| **Breathing Space** | Debt Respite Scheme: standard (60 days) and mental health crisis variants. Cannot run alongside an active insolvency procedure; standard not available if used in the previous 12 months | Modelled as its own case type with eligibility rules referencing prior-use history and concurrent-procedure checks |
| **Scottish Trust Deed / sequestration / DAS** | Separate Scottish statutory regime | Jurisdiction is a tenant and case attribute; case type availability and rules are jurisdiction-scoped from the outset rather than retrofitted |

## 6. Data protection

| Requirement | Consequence |
|---|---|
| Lawful basis and, for special category data, an Article 9 condition | Consent ledger records purpose, basis, version of the wording shown, timestamp and withdrawal |
| Data minimisation | AI payloads are assembled from an explicit allowlist of fields and redacted before egress; credential material is stripped from audit payloads |
| Storage limitation | Retention policies per data class with automated deletion and legal hold |
| Right of access and erasure | Subject request workflow; erasure that reconciles with an append-only audit ledger by removing personal payloads while preserving the fact and hash of the event |
| Accountability | The audit ledger is the accountability record: who, what, when, why, source, before, after |

Note on erasure versus immutability: these are genuinely in tension. The design
position is that the *event* is immutable but its *personal payload* is
separable, so an erasure request removes the personal data and records that it
did so, without breaking the chain. This approach needs review by a data
protection specialist before first production use — it is recorded as an open
item, not a settled answer.

## 7. What Solvenda must never do

- Claim any FCA authorisation, permission, or regulatory approval
- Claim SFS membership, accreditation or certification it does not hold
- Present AI output as regulated advice
- Allow any non-human principal to record a regulated decision
- Describe an integration as live when it is a sandbox simulator
- State compliance with a standard that has not been independently assessed

---

## Sources

- FCA Handbook, CONC 8 — https://handbook.fca.org.uk/handbook/conc8
- FCA Consumer Duty, PRIN 2A
- FCA FG21/1, guidance on the fair treatment of vulnerable customers
- Joint FCA and ICO statement on vulnerability-related data — https://www.fca.org.uk/publications/corporate-documents/joint-fca-and-ico-statement-regulatory-expectations-regarding-firms
- Standard Financial Statement — https://standard-financial-statement.maps.org.uk
- IVA Protocol 2025 — https://www.gov.uk/government/publications/individual-voluntary-arrangement-iva-protocol/iva-protocol-2025
- Debt Respite Scheme (Breathing Space) — House of Commons Library briefing CBP-9256

Compiled August 2026. Review before first production use and on each Handbook update.

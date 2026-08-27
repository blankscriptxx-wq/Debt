# Competitor matrix — UK debt advice, DMP and insolvency software

Compiled August 2026 from vendor materials, public company records and industry
commentary. Everything here is a reading of publicly available information; none
of it comes from confidential briefings, and where a capability is unclear the
table says "not evidenced" rather than guessing. Feature detail on private
platforms changes quickly, so this document carries a review date.

## The vendors

| Vendor | What it is | Position |
|---|---|---|
| **Aryza Advize** (formerly HubSolv, now part of Aryza Group) | End-to-end debt management and personal insolvency case management: CRM, onboarding, I&E on CFS/SFS, decision engine, proposal generation, cashiering, arrears automation, Open Banking, credit search | The default incumbent for UK DMP and IVA providers. Broadest functional coverage in the market |
| **Aryza Insolv** | Corporate and personal insolvency case management with statutory workflow | Sister product; used where the firm is insolvency-led rather than advice-led |
| **Turnkey IPS (Turnkey PI)** | Long-established insolvency practice software; personal insolvency module covers IVAs, DMPs and Trust Deeds | Deeply entrenched with insolvency practitioners; strong statutory and cashiering heritage |
| **Trustlink** | Lead, dialler and case platform aimed at introducers and IVA firms; bundles credit search with IDV/AML; pushes cases to IP firms | Strong on the front of the funnel and on introducer-to-IP handoff |
| **Logican LogiDebt** | Configurable IVA and debt management case management | Mid-market alternative, emphasises configurability |
| **CaMS** | IVA case management from lead to closure | Focused IVA tool |
| **Trustfolio** | Creditor-side rails: debt solutions provider portal, creditor portal, adviser support portal | Not a competitor so much as the network layer everyone connects to. Owns creditor engagement and voting |
| **Aveni** | AI assurance for regulated financial services: QA across 100% of conversations, Consumer Duty and vulnerability frameworks, agent assurance. £12m raised June 2026; FCA Supercharged Sandbox participant | Not a case management system. The most credible AI-in-regulated-FS player, and the clearest evidence that full-coverage QA is now an expectation rather than a differentiator |

## Capability comparison

Legend: ● strong · ◐ partial · ○ absent or not evidenced

| Capability | Aryza Advize | Turnkey PI | Trustlink | Logican | Trustfolio | Aveni | **Solvenda intent** |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| DMP case management | ● | ◐ | ◐ | ● | ○ | ○ | ● |
| IVA case management | ● | ● | ● | ● | ◐ | ○ | ● |
| DRO / bankruptcy | ◐ | ● | ○ | ◐ | ○ | ○ | ● |
| Scottish Trust Deed / sequestration / DAS | ◐ | ● | ○ | ◐ | ○ | ○ | ● |
| Breathing Space | ◐ | ◐ | ○ | ◐ | ○ | ○ | ● |
| SFS income & expenditure | ● | ● | ◐ | ● | ◐ | ○ | ● |
| Decision / solution engine | ● | ◐ | ◐ | ◐ | ◐ | ○ | ● |
| Open Banking affordability | ● | ◐ | ◐ | ◐ | ○ | ○ | ● |
| Credit reference integration | ◐ | ◐ | ● | ◐ | ○ | ○ | ● |
| Creditor portal / voting rails | ◐ | ◐ | ◐ | ◐ | ● | ○ | ◐ (integrate, not replace) |
| Cashiering and client money | ● | ● | ○ | ◐ | ○ | ○ | ◐ (phase 2) |
| Omnichannel comms incl. WhatsApp | ◐ | ○ | ◐ | ◐ | ○ | ◐ | ● |
| Telephony + recording + transcription | ◐ | ○ | ● | ◐ | ○ | ● | ● |
| Client self-service portal | ◐ | ◐ | ◐ | ◐ | ◐ | ○ | ● |
| No-code workflow builder | ◐ | ◐ | ○ | ◐ | ○ | ○ | ● |
| AI case summarisation | ○ | ○ | ○ | ○ | ○ | ◐ | ● |
| Declared vs observed expenditure analysis | ○ | ○ | ○ | ○ | ○ | ○ | ● |
| QA across 100% of interactions | ○ | ○ | ○ | ○ | ○ | ● | ● |
| Consumer Duty outcome monitoring | ◐ | ◐ | ○ | ◐ | ○ | ● | ● |
| Immutable / tamper-evident audit | ○ | ○ | ○ | ○ | ○ | ◐ | ● |
| Config-driven new case types | ○ | ○ | ○ | ◐ | ○ | n/a | ● |
| Public API + webhooks + sandbox | ◐ | ◐ | ◐ | ◐ | ● | ◐ | ● |
| Self-service platform administration | ◐ | ○ | ○ | ◐ | ◐ | ◐ | ● |
| Migration tooling for incoming firms | ◐ | ◐ | ○ | ◐ | n/a | n/a | ● |

## What the incumbents do well

Underestimating them would be a mistake. Specifically:

1. **Functional completeness.** Aryza Advize genuinely covers lead to closure
   including cashiering, which is the hardest and least glamorous part. A new
   entrant that cannot handle client money and creditor distributions is not a
   replacement for it.
2. **Statutory depth.** Turnkey has decades of accumulated statutory detail —
   the forms, the deadlines, the edge cases in personal insolvency. That
   knowledge is the moat, not the UI.
3. **Network position.** Trustfolio sits between providers and creditors. Any
   platform that ignores those rails makes its customers' lives harder.
4. **Front-of-funnel efficiency.** Trustlink's dialler and lead integration
   reflects a real commercial truth about how IVA volume is actually sourced.
5. **They work.** Firms are running regulated businesses on these systems today.

## Where the market is weak — and what we do about it

**1. Case comprehension is manual.**
An adviser opening a file reconstructs the story by clicking through screens.
Nothing in the market composes "what is happening on this case, what is missing,
what should happen next" into a single view.
→ *Case Intelligence as a first-class object, refreshed by domain events and
traceable to source records — not a chatbot bolted onto a CRM.*

**2. Compliance evidence is assembled after the fact.**
Audit trails exist but are ordinary mutable tables. QA is manual sampling of
3–5% of interactions. Consumer Duty outcome monitoring is largely spreadsheets.
→ *Hash-chained, append-only audit as the substrate; AI-assisted QA across all
interactions with human sign-off; outcome monitoring as a product surface.*

**3. Declared expenditure is never checked against observed expenditure.**
Firms pull Open Banking data and firms capture an SFS, but nothing systematically
compares the two and flags material divergence for an adviser.
→ *Discrepancy detection as a core capability with a proposal-and-approval path,
never an automatic edit to a regulated figure.*

**4. Configuration means a vendor change request.**
New case types, new forms, new fields and new workflows typically require the
vendor. Firms wait quarters for changes that should take an afternoon.
→ *Case types, forms, fields, workflows and compliance rules as tenant
configuration, with a platform admin console that covers them. Adding a case type
must require no schema change — enforced by test.*

**5. The consumer experience is an afterthought.**
Client portals in this market are thin. Clients in financial difficulty are
often mobile-only, frequently vulnerable, and are asked to complete a long,
intimidating process.
→ *A mobile-first PWA treated as a primary product surface with accessibility
and plain English as requirements.*

**6. Vulnerability is a checkbox.**
FG21/1 expects identification, response and outcome monitoring across four
drivers. Most systems offer a flag and a free-text note. The FCA and ICO have
jointly addressed how vulnerability data should be handled — it is frequently
special category data requiring an Article 9 condition.
→ *Vulnerability as a structured, consent-governed, separately-permissioned
record with disclosure controls, not a tick box.*

**7. Nobody has combined the system of record with the intelligence layer.**
This is the strategic gap. Aveni proves AI assurance in regulated financial
services is real and fundable — but it assesses conversations *after* they
happen, because it does not own the case. The incumbents own the case but have
no meaningful intelligence layer.
→ *Own both. Evidence becomes a by-product of the work rather than a separate
assessment exercise, and the AI has the full permitted case context rather than
a transcript.*

## Where we should not compete on day one

Being honest about this matters more than the feature grid:

- **Cashiering and client money.** Regulatorily heavy, operationally unforgiving,
  and a rewrite of a solved problem. Integrate first; build later if the pull is
  real.
- **Creditor network effects.** Trustfolio's position is a network, and networks
  are not displaced by better software. Integrate.
- **Statutory form depth.** Match it case type by case type as firms adopt,
  rather than claiming parity before it exists.

## Review

| Field | Value |
|---|---|
| Compiled | August 2026 |
| Next review | Before any customer-facing use, and at least quarterly |
| Basis | Public vendor materials, Companies House, industry press |
| Known gaps | Private pricing; roadmaps; actual defect rates; contractual terms |

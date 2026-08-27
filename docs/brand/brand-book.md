# Solvenda — brand

## The name

**Solvenda** — from the Latin gerundive *solvenda*, "that which is to be
resolved". It carries solvency and resolution without naming a product, so the
brand is not bound to IVAs, DMPs, or to the UK.

### How it was chosen

The first candidate was **Keel**. It failed clearance: **Keel** is a live,
FCA-authorised UK Banking-as-a-Service platform (Manchester, out of stealth in
May 2026), and **KEEL TECH LTD** is registered at Companies House. Same country,
same sector, financial infrastructure sold to financial firms — a genuine
confusion risk, not a technicality, and far cheaper to avoid now than to rename
after launch.

Nine candidates were screened against Companies House, sector conflicts and
obvious trade-mark collisions:

| Candidate | Outcome |
|---|---|
| Keel | **Rejected.** FCA-authorised UK fintech actively trading under the name |
| Solvra | Rejected. `solvra.uk` is a live UK software company; several other Solvra entities |
| Sextant | Rejected. Multiple UK financial-services Sextant entities, one FCA-registered |
| Datum | Rejected. Datum Finance Ltd, Datum Systems Ltd, plus a SaaS vendor in insurance/financial services |
| Vantera | Rejected. Vantera Partners provides restructuring, turnaround and debt solutions — direct sector conflict |
| Kedge | Rejected. Kedge Capital (UK), Kedge Capital PE LLP |
| Aequora | Rejected. Aequora Limited registered in the UK |
| Landfall | Viable but crowded; several UK entities including Landfall IP |
| **Solvenda** | **Selected.** No UK company found; no software or financial-services conflict surfaced |

### Clearance status — read this before using the name commercially

This screen used public web search. It is **not** a trade-mark clearance search.
Before commercial launch:

- [ ] UK IPO search across classes 9, 36, 41, 42 (registered and pending)
- [ ] EUIPO and WIPO searches for expansion markets
- [ ] Companies House name availability and incorporation
- [ ] Domains: `solvenda.com`, `solvenda.co.uk`, `solvenda.io`, defensive registrations
- [ ] Social handles
- [ ] Instruction of a trade-mark attorney and filing in 9/42 (and 36 if the
      commercial model ever touches regulated activity)

Until those are done the name is **provisional**.

## Positioning

> **Solvenda is the operating system for regulated financial-difficulty services.**

For UK firms giving debt advice, running debt management plans and administering
personal insolvency, who are held back by case-management software that stores
information but does not understand it. Solvenda is an AI-native platform where
compliance evidence and case intelligence are produced by the work itself rather
than assembled afterwards.

Unlike Aryza Advize, Turnkey or Trustlink, Solvenda treats case comprehension,
outcome monitoring and configurability as core architecture rather than as
modules added over time. Unlike horizontal AI assurance tools, Solvenda owns the
system of record — so the intelligence has the full permitted case context, and
the evidence is generated in the workflow rather than assessed after the fact.

**The one-sentence version:** *the compliance evidence should be a by-product of
the software working, not a task someone has to remember to do.*

## Taglines

Primary: **Evidence, by default.**

Supporting lines, by audience:

- Operations — *Every case, understood in seconds.*
- Compliance — *Every decision, attributable.*
- Executive — *The platform your regulator's questions are already answered by.*
- Consumer-facing — *Clear ground, when finances are not.*

## Messaging pillars

1. **Case Intelligence.** An adviser opens a file and understands it immediately:
   health, readiness, what is missing, what to do next, what changed — each
   element traceable to the record that produced it.
2. **AI that assists, never decides.** Full freedom to read, analyse, draft,
   flag and propose. Structurally incapable of recording a regulated decision.
   Not a policy — a branch in the authorisation engine, tested against every
   regulated permission.
3. **Compliance as architecture.** Hash-chained append-only audit. Who, what,
   when, why, source, before, after. QA across every interaction, not a 3–5%
   sample. Consumer Duty outcome monitoring as a live surface.
4. **Configuration, not change requests.** Case types, forms, fields, workflows
   and rules are tenant configuration. A new case type requires no schema change.
5. **A client experience that respects the client.** Mobile-first, accessible,
   plain English, for people who are often in crisis and often on a phone.
6. **Tenant isolation you can explain to a procurement team.** Enforced by
   Postgres row-level security under a role that cannot bypass it — not by
   remembering to add a filter.

## Voice

Plain, precise, unhurried. This is software for people having the hardest
financial conversations of someone's life; swagger reads as ignorance.

- Say what the software does, in the words a practitioner would use
- Never imply regulatory endorsement, and never use compliance language to sell
- Prefer a specific mechanism to an adjective: "hash-chained append-only ledger"
  over "bank-grade security"
- No fabricated certifications, partnerships, customer numbers or awards
- British English throughout

## Product naming architecture

| Name | What it is |
|---|---|
| **Solvenda** | The platform |
| **Solvenda Core** | Clients, cases, creditors, debts, documents, SFS, advice |
| **Solvenda Intelligence** | Case Intelligence and the AI capability layer |
| **Solvenda Flow** | Workflow and automation engine |
| **Solvenda Connect** | Integration framework, marketplace, public API |
| **Solvenda Portal** | Client, creditor and introducer experiences |
| **Solvenda Assure** | Compliance, QA, outcome monitoring, complaints |
| **Solvenda Control** | Platform operator administration |

Modules are named for what they do. No invented category words.

## Visual direction

**Logotype.** Wordmark-led, set in a humanist sans with a subtly extended `S`.
The mark is a single continuous line resolving from irregular to level — drawn
once, readable at 16px, no gradient.

**Typography.**

| Role | Face | Notes |
|---|---|---|
| Interface | Inter | Variable, excellent at small sizes, strong tabular figures for financial tables |
| Numerics | Inter tabular | Every monetary figure uses tabular lining figures so columns align |
| Code / references | JetBrains Mono | Case references, API docs |
| Marketing display | Inter Display | Tighter tracking at large sizes |

Type scale, 1.200 minor third from a 16px base: 12 / 13 / 14 / 16 / 19 / 23 /
28 / 33 / 40 / 48.

**Colour.** Restrained by intent — colour carries meaning in this product, so it
cannot also be decoration.

| Token | Light | Dark | Use |
|---|---|---|---|
| `ink` | `#0B1220` | `#F2F5F9` | Primary text |
| `ink-muted` | `#5A6B84` | `#94A3B8` | Secondary text |
| `surface` | `#FFFFFF` | `#0B1220` | Page |
| `surface-raised` | `#F7F9FC` | `#141C2B` | Cards, table headers |
| `border` | `#E2E8F0` | `#243044` | Hairlines |
| `accent` | `#1F5FD0` | `#5B8FF0` | Primary action, focus |
| `positive` | `#0F7A52` | `#34C48A` | Healthy, complete |
| `attention` | `#9A6300` | `#E0A63A` | Needs adviser attention |
| `critical` | `#B3261E` | `#F2867C` | Breach, failure, deadline passed |
| `regulated` | `#6B3FA0` | `#B48BE0` | Marks a regulated action or record |

`regulated` is a deliberate addition: anywhere the interface is about to take an
action that carries regulatory weight, it is visually distinct from ordinary
work. Every pairing meets WCAG 2.2 AA against its surface; status is never
communicated by colour alone.

**Layout.** 4px spacing base. 12-column fluid grid, 1440px comfortable maximum.
Dense tables with generous row targets on touch. One primary action per view.

**Motion.** 120–180ms, ease-out, transform and opacity only. Motion confirms
that something happened; it does not perform. Honours `prefers-reduced-motion`.

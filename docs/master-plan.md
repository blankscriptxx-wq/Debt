# Solvenda — master implementation plan

Living document. Updated as work completes; `docs/implementation-log.md` records
what was actually done, including what broke and why.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Brand | Solvenda (provisional pending trade-mark clearance) | See `docs/brand/brand-book.md`; Keel failed clearance against a live FCA-authorised UK fintech |
| Stack | TypeScript, Next.js 15, React 19, Postgres 16, Drizzle | One language across four apps; Postgres because the security model lives in the database |
| Hosting | Vercel + managed Postgres, container-portable | User decision. Data-residency limits recorded as a production blocker |
| Tenant isolation | Postgres RLS, FORCEd, non-owner app role | A forgotten filter must return nothing, not another firm's clients |
| Migrations | Hand-written, immutable, checksummed SQL | RLS policies, grants and triggers need precise expression; drift is caught by a conformance test |
| AI provider | Anthropic Claude, behind an abstraction, deterministic stub when no key | The full suite must run offline and in CI |
| External vendors | Adapter interface + sandbox simulator | No live credentials exist; nothing is described as live |

## Workstream status

| # | Workstream | State |
|---|---|---|
| W0 | Research, competitor matrix, regulatory dossier, brand | Complete |
| W1 | Foundations: monorepo, RLS tenant isolation, auth, audit ledger | Complete |
| W2 | Domain core: config-driven case types, SFS engine, advice | Complete |
| W3 | Case Intelligence | Complete |
| W4 | AI layer with approval gates | Complete (8 of ~20 capabilities built; rest specified) |
| W5 | Workflow engine | Complete |
| W6 | Communications centre | Complete (channels are simulators) |
| W7 | Portals | Console, client and Control complete; creditor and introducer are permissions and data model only |
| W8 | Compliance and QA | Partial — see `docs/architecture/compliance-and-audit.md` |
| W9 | Solvenda Control (platform administration) | Complete |
| W10 | Integrations framework and developer platform | Complete (five simulators, no live provider) |
| W11 | Analytics and migration | Complete |
| W12 | Marketing site, commercial model, final report | Complete |

Nothing above is marked complete because a screen exists. Each was driven end to
end against a real database, and the browser suites run against real servers.
Where something is partial, the row says so and `docs/final-report.md` says what
is missing.

## Definition of done

A workstream is complete when all of the following hold. "The UI exists" is not
on the list.

1. The behaviour works end to end against a real database
2. Tests cover the success path, the failure paths and the security properties
3. `pnpm test` is green, including the cross-tenant isolation gate
4. Tenant isolation reviewed: no new table without a declared scope and policy
5. Security reviewed: no regulated action reachable by a non-human principal
6. UX reviewed against the design system where a surface exists
7. `docs/implementation-log.md` updated with what was built and what is missing

## Non-negotiables

- No non-human principal may exercise a regulated permission
- No table without a declared tenancy scope and an enforced policy
- No audit record that cannot answer who / what / when / why / source / before / after
- No claim of certification, authorisation, partnership, customer or award
- No integration described as live while it is a simulator

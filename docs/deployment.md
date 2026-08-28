# Deployment

Four Next.js apps in one pnpm workspace, over one Postgres database. On Vercel
that means **four projects against the same repository**, each with a different
Root Directory, plus a managed Postgres instance they all point at.

## Projects

| App | Root Directory | What it is | Public? |
|---|---|---|---|
| `apps/www` | `apps/www` | Marketing site | Yes |
| `apps/console` | `apps/console` | Adviser and compliance console | Behind sign-in |
| `apps/client` | `apps/client` | Consumer portal | Behind sign-in |
| `apps/admin` | `apps/admin` | Solvenda Control | Behind sign-in |

For each: framework preset **Next.js**, Root Directory as above, and **"Include
source files outside of the Root Directory"** enabled — the apps import
workspace packages from `packages/`, and without that setting the build cannot
see them. Vercel detects `pnpm-workspace.yaml` and installs from the repository
root; the default build command is correct.

`transpilePackages` in each app's `next.config.mjs` already lists the workspace
packages it uses, because they ship TypeScript source rather than built output.
`serverExternalPackages: ['pg']` keeps the driver out of the client bundle.

## Database

The security model is the database, so this is not an implementation detail.
Three roles with different privileges, none able to bypass row-level security:

```
solvenda_owner      migrations only
solvenda_app        all four applications
solvenda_platform   Solvenda Control, under a live access grant
```

`packages/db/bootstrap/roles.sql` creates them. Run it once against a new
database, as a superuser, before the first migration. Then
`pnpm db:migrate`, and `pnpm db:seed` if you want the development fixtures.

A managed Postgres provider that only hands out a single superuser role is not
sufficient. The separation is the control; collapsing it to one role removes the
guarantee that a forgotten tenant filter returns nothing.

## Environment variables

Set per project. `.env.example` is the contract.

| Variable | Needed by | Notes |
|---|---|---|
| `PGHOST`, `PGPORT`, `PGDATABASE` | all four | |
| `PGSSL` | all four | `require` for any managed provider |
| `PGUSER_APP`, `PGPASSWORD_APP` | all four | |
| `PGUSER_PLATFORM`, `PGPASSWORD_PLATFORM` | `admin` | Control only |
| `PGUSER_OWNER`, `PGPASSWORD_OWNER` | none at runtime | Migrations only — do not set on a deployed app |
| `ANTHROPIC_API_KEY` | `console` | Unset falls back to the deterministic stub |
| `SOLVENDA_AI_MODEL` | `console` | Optional; defaults to `claude-opus-5` |
| `PGUSER_SUPER`, `PGPASSWORD_SUPER` | none | Local audit tamper test only. Never set in a deployment |

**`apps/www` needs the database too**, which is not obvious: the contact form
writes through the unauthenticated path. Without the `PGUSER_APP` credentials
the site still builds and every page still renders — the pricing figures are a
build-time import, not a query — but a submitted enquiry returns "We could not
record that", which is at least honest about having failed.

## What is not wired up for a deployed environment

**The workflow queue has no runner.** `packages/workflow` implements durable
jobs claimed with `FOR UPDATE SKIP LOCKED`, and the engine is tested end to end,
but nothing outside the test suite calls `claimJobs`. A deployed instance would
enqueue work that never runs: delays never elapse, follow-ups never fire, and
`reclaimStalled` never recovers an abandoned job.

Closing this needs an authenticated endpoint that drains the queue for a bounded
time, a `crons` entry in the console's `vercel.json` calling it on a schedule,
and a shared secret so nothing else can. It is a contained piece of work and it
is not done. Until it is, treat workflow automation as functional in principle
and inert in deployment.

**Data residency.** Vercel and the managed Postgres providers it integrates with
offer EU regions, not UK-only. Several firms in this market will refuse on that
alone. It needs either a different hosting decision or an explicit, documented
acceptance — see `docs/final-report.md` §12.

**No edge rate limiting.** The API-key limiter is real. The public contact
form's throttle is in-process, so it neither survives a restart nor coordinates
across instances — and on Vercel, where every request may hit a different
instance, it is close to no protection at all. A public deployment needs a rate
limit in front of it.

**Migrations do not run on deploy, by design.** They are immutable and
checksummed, and running them automatically on every push would make a failed
deploy a schema problem. Run `pnpm db:migrate` deliberately.

# Deployment

Four Next.js apps in one pnpm workspace, over one Postgres database. On Vercel
that means **four projects against the same repository**, each with a different
Root Directory, plus a managed Postgres instance they all point at.

## One project

Everything is a single Next.js application at `apps/web`, so there is **one
Vercel project, one domain and one build**:

| Path | Surface |
|---|---|
| `/` | Marketing site — the only public part |
| `/app` | Adviser console |
| `/portal` | Client portal |
| `/control` | Solvenda Control |
| `/v1` | Public API |
| `/api` | Internal endpoints the console calls |

Project settings: framework **Next.js**, Root Directory **`apps/web`**, and
**"Include source files outside of the Root Directory"** enabled, because the
app imports workspace packages from `packages/`. `apps/web/vercel.json` pins the
region to `lhr1`.

This started as four Vercel projects, one per app, and that arrangement failed
in a way worth recording: only the admin project was ever created, so three
quarters of the work built and tested locally and appeared nowhere. A monorepo
with one project per app needs every project to exist and be kept in step, and
nothing tells you when one is missing — the deployments that do exist keep
succeeding.

The four stylesheets are namespaced (`mk-`, `sv-`, `cp-`, `ct-`) over the shared
tokens, so merging them collided with nothing. It also fixed Control's sign-in
page, which used `sv-login` classes that only existed in the console's
stylesheet and had been rendering unstyled.

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

## The development sign-in buttons

Every portal can offer one-click sign-in to a seeded account: six staff roles on
the console, two clients on the portal, the operator on Control. No password, no
second factor.

It is off unless **both** of these are set:

| Variable | Effect |
|---|---|
| `SOLVENDA_DEMO_LOGIN=1` | Turns the buttons on |
| `SOLVENDA_DEMO_LOGIN_ALLOW_PRODUCTION=1` | Additionally required when `NODE_ENV=production` |

Two switches rather than one, deliberately. `next start` and every Vercel
deployment run as production, so enabling this on a deployed instance is a
decision someone has to make twice. **Setting both on a public Control
deployment makes platform administration available to anyone who has the URL** —
there is nothing else in the way.

What it does not do is bypass the session mechanism. A demo sign-in mints a real
session through the same code path as a password sign-in: it expires on both
clocks, it can be revoked, and it is audited, with the audit row saying plainly
that no credentials were checked.

Accounts come from the seed, so a database seeded with `pnpm db:seed` is a
prerequisite. The seed itself now refuses to run unless `PGDATABASE` looks like
a development or test database, or `SEED_ALLOW_NON_DEV=1` is set.

## Operator sign-in

Solvenda Control requires a second factor. An operator account with no enrolled
secret cannot sign in at all — it is refused rather than waved through, which is
the opposite of how it behaved until recently. The seed enrols a fixed TOTP
secret for the development operator and prints the current code.

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

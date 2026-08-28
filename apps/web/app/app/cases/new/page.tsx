import { redirect } from 'next/navigation';
import { sql } from '@solvenda/db';
import { requireSession, query } from '@/lib/console/session';
import {
  createClient, openCase, parseCaseTypeDefinition, CaseworkError,
  type CaseTypeDefinition,
} from '@solvenda/core';
import { AppShell } from '@/components/console/app-shell';
import { loadDashboard } from '@/lib/console/data';
import { Card, Field, Form, PageHeader, Stack } from '@solvenda/ui';

export const dynamic = 'force-dynamic';

const JURISDICTIONS = [
  { key: 'england-wales', label: 'England & Wales' },
  { key: 'scotland', label: 'Scotland' },
  { key: 'northern-ireland', label: 'Northern Ireland' },
];

/**
 * Opening a case.
 *
 * One screen, because in practice this is one conversation: someone has rung
 * up, and the adviser needs a file to put the call in. Splitting it into "make
 * a client, then find them again, then make a case" is three screens for one
 * intention, and leaves half-made clients behind when the second step is
 * abandoned.
 *
 * Which solution to pursue is deliberately not asked here. A case type is
 * picked because it is the process being followed — a referral, a fact find —
 * not because a solution has been chosen; choosing the solution is the advice
 * decision, and it has its own screen, its own permission and its own record.
 */
export default async function NewCasePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; client?: string }>;
}) {
  const session = await requireSession();
  const { error, client: preselected } = await searchParams;

  const [dashboard, caseTypes, clients] = await Promise.all([
    query(session, (db) => loadDashboard(db, session.user.id)),
    query(session, async (db) => {
      const res = await db.execute<{ definition: unknown; version: number }>(sql`
        SELECT DISTINCT ON (key) definition, version FROM case_type_definitions
         WHERE status = 'active' ORDER BY key, version DESC`);
      return res.rows.map((r) => ({
        definition: parseCaseTypeDefinition(r.definition) as CaseTypeDefinition,
        version: r.version,
      }));
    }),
    query(session, async (db) => {
      const res = await db.execute<{ id: string; reference: string; name: string;
                                     jurisdiction: string; cases: string }>(sql`
        SELECT c.id, c.reference, c.first_name || ' ' || c.last_name AS name,
               c.jurisdiction, count(k.id)::text AS cases
          FROM clients c LEFT JOIN cases k ON k.client_id = c.id
         GROUP BY c.id, c.reference, c.first_name, c.last_name, c.jurisdiction
         ORDER BY c.created_at DESC LIMIT 200`);
      return res.rows;
    }),
  ]);

  async function open(form: FormData) {
    'use server';
    const active = await requireSession();
    let destination: string;

    try {
      const caseTypeKey = String(form.get('caseTypeKey') ?? '');
      const chosen = caseTypes.find((t) => t.definition.key === caseTypeKey);
      if (!chosen) throw new CaseworkError('Choose which case type this is.');

      destination = await query(active, async (db) => {
        // A new client and the case are opened in one transaction, so an
        // abandoned second half cannot leave a client nobody meant to create.
        const existing = String(form.get('clientId') ?? '');
        const clientId = existing
          ? existing
          : (await createClient(db, active.context, active.principal, {
              firstName: String(form.get('firstName') ?? ''),
              lastName: String(form.get('lastName') ?? ''),
              dateOfBirth: String(form.get('dateOfBirth') ?? '') || null,
              email: String(form.get('email') ?? '') || null,
              phoneMobile: String(form.get('phoneMobile') ?? '') || null,
              addressPostcode: String(form.get('postcode') ?? '') || null,
              jurisdiction: (String(form.get('jurisdiction') ?? 'england-wales')
                || 'england-wales') as 'england-wales',
            })).id;

        const opened = await openCase(db, active.context, active.principal, {
          clientId,
          caseType: chosen.definition,
          caseTypeVersion: chosen.version,
          source: String(form.get('source') ?? '') || 'direct',
        });
        return `/app/cases/${opened.id}`;
      });
    } catch (cause) {
      console.error('opening a case failed', cause);
      const message = cause instanceof CaseworkError
        ? cause.message
        : 'The case could not be opened. Nothing was changed.';
      redirect(`/app/cases/new?error=${encodeURIComponent(message)}`);
    }

    // Straight into the file: the reason for opening a case is to work it.
    redirect(destination);
  }

  return (
    <AppShell
      firmName={session.tenant.name}
      userName={session.user.fullName}
      counts={{ cases: dashboard.openCases, tasks: dashboard.openTasks,
                approvals: dashboard.pendingApprovals }}
      current="cases"
    >
      <PageHeader eyebrow="Cases" title="Open a case"
                  meta={<span>It opens at the first stage of whichever process you choose.</span>} />

      <Form action={open} submitLabel="Open the case"
            result={error ? { ok: false, message: error } : null}>
        <Stack gap={5}>
          <Card title="Who is it for?"
                subtitle="Pick someone already on file, or enter them here.">
            <Field label="Existing client"
                   hint="Leave as “someone new” to enter their details below.">
              <select className="sv-input" name="clientId" defaultValue={preselected ?? ''}>
                <option value="">— someone new —</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.reference} · {c.jurisdiction.replace(/-/g, ' ')}
                    {Number(c.cases) > 0 ? ` · ${c.cases} case${c.cases === '1' ? '' : 's'}` : ''}
                  </option>
                ))}
              </select>
            </Field>
          </Card>

          <Card title="Or a new client"
                subtitle="Only a name is required. The rest belongs in the case file, where there is room to do it properly.">
            <Field label="First name"><input className="sv-input" name="firstName" /></Field>
            <Field label="Last name"><input className="sv-input" name="lastName" /></Field>
            <Field label="Date of birth">
              <input className="sv-input" name="dateOfBirth" type="date" />
            </Field>
            <Field label="Email"><input className="sv-input" name="email" type="email" /></Field>
            <Field label="Mobile"><input className="sv-input" name="phoneMobile" /></Field>
            <Field label="Postcode"><input className="sv-input" name="postcode" /></Field>
            <Field label="Jurisdiction"
                   hint="Decides which solutions are lawfully available, so it is asked up front rather than assumed.">
              <select className="sv-input" name="jurisdiction" defaultValue="england-wales">
                {JURISDICTIONS.map((j) => (
                  <option key={j.key} value={j.key}>{j.label}</option>
                ))}
              </select>
            </Field>
          </Card>

          <Card title="What kind of case?"
                subtitle="The process being followed, not the solution being recommended. That decision comes later, on its own evidence.">
            <Field label="Case type">
              <select className="sv-input" name="caseTypeKey" defaultValue="">
                <option value="" disabled>Choose…</option>
                {caseTypes.map(({ definition }) => (
                  <option key={definition.key} value={definition.key}>
                    {definition.name} · {definition.jurisdictions
                      .map((j) => j.replace(/-/g, ' ')).join(', ')}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="How did it arrive?">
              <select className="sv-input" name="source" defaultValue="direct">
                {['direct', 'introducer', 'campaign', 'web', 'referral'].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </Field>
          </Card>
        </Stack>
      </Form>
    </AppShell>
  );
}

import { redirect } from 'next/navigation';
import { requireSession, query } from '@/lib/console/session';
import { loadCaseFileHeader, listEmployment } from '@/lib/console/case-file';
import { recordEmployment, EmploymentValidationError } from '@solvenda/core';
import {
  Badge, Card, DataTable, EmptyState, Field, Form, Grid, Money, Stack, SummaryBar,
} from '@solvenda/ui';

export const dynamic = 'force-dynamic';

const STATUSES = ['employed', 'self-employed', 'unemployed', 'retired', 'student',
                  'carer', 'unable-to-work', 'homemaker', 'other'];
const CONTRACTS = ['permanent', 'fixed-term', 'zero-hours', 'agency', 'casual', 'contractor'];
const FREQUENCIES = ['weekly', 'fortnightly', 'four-weekly', 'monthly', 'quarterly', 'annually'];

const sentence = (v: string) => v.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * Where the money comes from.
 *
 * Take-home pay at the frequency the client is actually paid, normalised to
 * monthly for the statement. Treating four-weekly pay as monthly overstates
 * annual income by a month's pay — about 8%, which is the difference between a
 * plan that holds and one that fails in month four.
 */
export default async function EmploymentTab({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;
  const { saved, error } = await searchParams;

  const header = await query(session, (db) => loadCaseFileHeader(db, id));
  if (!header) redirect('/app/cases');
  const records = await query(session, (db) => listEmployment(db, header.clientId));

  const current = records.filter((r) => r.isCurrent);
  const monthlyTotal = current.reduce((t, r) => t + r.monthlyNetPence, 0);
  const varies = current.some((r) => r.incomeVaries);

  async function add(formData: FormData) {
    'use server';
    const active = await requireSession();
    const text = (n: string) => {
      const v = String(formData.get(n) ?? '').trim();
      return v === '' ? null : v;
    };
    const pay = text('netPay');
    try {
      await query(active, (db) => recordEmployment(db, active.context, active.principal, {
        clientId: header!.clientId,
        belongsTo: String(formData.get('belongsTo') ?? 'client') as 'client' | 'partner',
        status: String(formData.get('status') ?? 'employed') as never,
        employerName: text('employerName'),
        jobTitle: text('jobTitle'),
        contractType: text('contractType') as never,
        startedOn: text('startedOn'),
        netPayPence: pay ? Math.round(Number(pay) * 100) : null,
        payFrequency: String(formData.get('payFrequency') ?? 'monthly') as never,
        incomeVaries: formData.get('incomeVaries') === 'on',
        notes: text('notes'),
      }));
    } catch (cause) {
      console.error('case file action failed', cause);
      const message = cause instanceof EmploymentValidationError
        ? cause.message : 'Could not save that employment record.';
      redirect(`/app/cases/${id}/employment?error=${encodeURIComponent(message)}`);
    }
    redirect(`/app/cases/${id}/employment?saved=1`);
  }

  return (
    <Stack gap={5}>
      <Card title="Employment"
            subtitle="Current and past. A partner's employment belongs on the file because the statement is a household one.">
        <DataTable
          rows={records}
          getKey={(r) => r.id}
          empty={<EmptyState title="No employment recorded."
                             detail="Add the client's situation, even where there are no earnings." />}
          columns={[
            { key: 'who', header: 'Whose', render: (r) => sentence(r.belongsTo) },
            {
              key: 'status', header: 'Status',
              render: (r) => (
                <span>
                  <strong>{sentence(r.status)}</strong>
                  {r.employerName && <><br /><span className="sv-muted">{r.employerName}</span></>}
                </span>
              ),
            },
            { key: 'role', header: 'Role', render: (r) => r.jobTitle ?? '—' },
            {
              key: 'contract', header: 'Contract',
              render: (r) => (r.contractType ? sentence(r.contractType) : '—'),
            },
            {
              key: 'pay', header: 'Take-home', numeric: true,
              render: (r) => (r.netPayPence
                ? <span><Money pence={r.netPayPence} /><br />
                    <span className="sv-muted">{r.payFrequency}</span></span>
                : '—'),
            },
            {
              key: 'monthly', header: 'Per month', numeric: true,
              render: (r) => <Money pence={r.monthlyNetPence} />,
            },
            {
              key: 'flags', header: '',
              render: (r) => (
                <>
                  {r.isCurrent && <Badge tone="positive">Current</Badge>}
                  {r.incomeVaries && <Badge tone="attention">Varies</Badge>}
                </>
              ),
            },
          ]}
        />
      </Card>

      <Card title="Add an employment record">
        <Form action={add} submitLabel="Add record"
              result={saved ? { ok: true, message: 'Employment recorded.' }
                    : error ? { ok: false, message: error } : null}>
          <Grid min="220px">
            <Field label="Whose income" required>
              <select className="sv-input" name="belongsTo" defaultValue="client">
                <option value="client">Client</option>
                <option value="partner">Partner</option>
              </select>
            </Field>
            <Field label="Status" required>
              <select className="sv-input" name="status" defaultValue="employed">
                {STATUSES.map((s) => <option key={s} value={s}>{sentence(s)}</option>)}
              </select>
            </Field>
            <Field label="Employer">
              <input className="sv-input" name="employerName" />
            </Field>
            <Field label="Job title">
              <input className="sv-input" name="jobTitle" />
            </Field>
            <Field label="Contract type">
              <select className="sv-input" name="contractType" defaultValue="">
                <option value="">—</option>
                {CONTRACTS.map((c) => <option key={c} value={c}>{sentence(c)}</option>)}
              </select>
            </Field>
            <Field label="Started">
              <input className="sv-input" name="startedOn" type="date" />
            </Field>
            <Field label="Take-home pay"
                   hint="What actually arrives, not the gross figure.">
              <input className="sv-input" name="netPay" type="number" step="0.01" min="0" />
            </Field>
            <Field label="Paid" required>
              <select className="sv-input" name="payFrequency" defaultValue="monthly">
                {FREQUENCIES.map((f) => <option key={f} value={f}>{sentence(f)}</option>)}
              </select>
            </Field>
          </Grid>
          <label className="sv-check">
            <input type="checkbox" name="incomeVaries" />
            <span>Pay varies month to month</span>
          </label>
        </Form>
      </Card>

      <SummaryBar figures={[
        { label: 'Current records', value: current.length },
        { label: 'Household income from work', value: <Money pence={monthlyTotal} />,
          tone: 'positive', detail: 'Per month, normalised' },
        { label: 'Income stability', value: varies ? 'Variable' : 'Stable',
          tone: varies ? 'critical' : 'neutral',
          detail: varies ? 'More than one payslip needed' : 'Single payslip is enough' },
      ]} />
    </Stack>
  );
}

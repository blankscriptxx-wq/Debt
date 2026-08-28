import { redirect } from 'next/navigation';
import { requireSession, query } from '@/lib/console/session';
import { loadCaseFileHeader, listVerificationItems } from '@/lib/console/case-file';
import { setVerificationStatus, syncRequirements, VerificationError } from '@solvenda/core';
import {
  Badge, Card, DataTable, EmptyState, SimulatedNotice, Stack, SummaryBar,
} from '@solvenda/ui';

export const dynamic = 'force-dynamic';

const STATUSES = ['outstanding', 'received', 'verified', 'rejected', 'waived', 'not-applicable'];
const METHODS = ['document', 'open-banking', 'credit-file', 'electronic-check', 'verbal', 'other'];

/** The checks every case needs, until case types carry their own list. */
const BASELINE = [
  { key: 'identity.photo-id', category: 'identity' as const },
  { key: 'identity.date-of-birth', category: 'identity' as const },
  { key: 'address.proof', category: 'address' as const },
  { key: 'income.payslip-or-benefit-award', category: 'income' as const },
  { key: 'income.bank-statements', category: 'income' as const },
  { key: 'debt.creditor-statements', category: 'debt' as const },
];

const sentence = (v: string) =>
  v.replace(/[.-]/g, ' ').replace(/^./, (c) => c.toUpperCase());

const TONE: Record<string, 'positive' | 'attention' | 'critical' | 'neutral'> = {
  verified: 'positive', received: 'neutral', outstanding: 'attention',
  rejected: 'critical', waived: 'attention', 'not-applicable': 'neutral',
};

/**
 * Identity, address and income checks.
 *
 * A waiver cannot be recorded without a reason. That is the same rule the audit
 * ledger applies to regulated actions, for the same argument: someone decided
 * evidence was not needed, and a file review has to be able to see why.
 */
export default async function VerificationTab({
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

  // Idempotent: a case type gaining a requirement surfaces on existing cases,
  // and one losing a requirement leaves completed history alone.
  await query(session, (db) => syncRequirements(db, id, header.clientId, BASELINE));
  const items = await query(session, (db) => listVerificationItems(db, id));

  const verified = items.filter((i) => i.status === 'verified').length;
  const outstanding = items.filter((i) => i.status === 'outstanding').length;
  const waived = items.filter((i) => i.status === 'waived').length;

  async function update(formData: FormData) {
    'use server';
    const active = await requireSession();
    const text = (n: string) => {
      const v = String(formData.get(n) ?? '').trim();
      return v === '' ? null : v;
    };
    try {
      await query(active, (db) => setVerificationStatus(db, active.context, active.principal,
        String(formData.get('itemId') ?? ''), {
          status: String(formData.get('status') ?? 'outstanding') as never,
          method: text('method'),
          waivedReason: text('reason'),
        }));
    } catch (cause) {
      console.error('case file action failed', cause);
      const message = cause instanceof VerificationError
        ? cause.message : 'Could not update that check.';
      redirect(`/app/cases/${id}/verification?error=${encodeURIComponent(message)}`);
    }
    redirect(`/app/cases/${id}/verification?saved=1`);
  }

  return (
    <Stack gap={5}>
      {error && <p className="sv-form__result sv-form__result--error" role="alert">{error}</p>}
      {saved && <p className="sv-form__result sv-form__result--ok" role="status">Check updated.</p>}

      <SimulatedNotice what="An electronic identity check would run through the identity provider adapter, which is a sandbox simulator." />

      <Card title="Checks"
            subtitle="What must be verified comes from the case type; this is what was done about each one.">
        <DataTable
          rows={items}
          getKey={(i) => i.id}
          empty={<EmptyState title="No checks configured." />}
          columns={[
            { key: 'req', header: 'Requirement', render: (i) => sentence(i.requirementKey) },
            { key: 'cat', header: 'Category', render: (i) => sentence(i.category) },
            {
              key: 'status', header: 'Status',
              render: (i) => <Badge tone={TONE[i.status] ?? 'neutral'}>{sentence(i.status)}</Badge>,
            },
            { key: 'method', header: 'Method',
              render: (i) => (i.method ? sentence(i.method) : '—') },
            {
              key: 'why', header: 'Waiver reason',
              render: (i) => <span className="sv-muted">{i.waivedReason ?? '—'}</span>,
            },
            {
              key: 'set', header: '',
              render: (i) => (
                <form action={update} className="sv-inline-form">
                  <input type="hidden" name="itemId" value={i.id} />
                  <select className="sv-input sv-input--sm" name="status"
                          defaultValue={i.status} aria-label="Status">
                    {STATUSES.map((s) => <option key={s} value={s}>{sentence(s)}</option>)}
                  </select>
                  <select className="sv-input sv-input--sm" name="method"
                          defaultValue={i.method ?? ''} aria-label="Method">
                    <option value="">Method…</option>
                    {METHODS.map((m) => <option key={m} value={m}>{sentence(m)}</option>)}
                  </select>
                  <input className="sv-input sv-input--sm" name="reason"
                         placeholder="Reason, if waiving" aria-label="Waiver reason"
                         defaultValue={i.waivedReason ?? ''} />
                  <button type="submit" className="sv-btn sv-btn--primary sv-btn--sm">Set</button>
                </form>
              ),
            },
          ]}
        />
      </Card>

      <SummaryBar figures={[
        { label: 'Verified', value: verified, tone: 'positive' },
        { label: 'Outstanding', value: outstanding,
          tone: outstanding ? 'critical' : 'neutral' },
        { label: 'Waived', value: waived, tone: waived ? 'accent' : 'neutral',
          detail: waived ? 'Each carries a recorded reason' : undefined },
        { label: 'Total checks', value: items.length },
      ]} />
    </Stack>
  );
}

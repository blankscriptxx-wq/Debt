import { redirect } from 'next/navigation';
import { requireSession, query } from '@/lib/console/session';
import { loadCaseFileHeader, loadDebts } from '@/lib/console/case-file';
import { addDebt, removeDebt, DebtValidationError } from '@solvenda/core';
import {
  Badge, Card, DataTable, EmptyState, Field, Form, Grid, Money,
  RegulatedMark, SimulatedNotice, Stack, SummaryBar,
} from '@solvenda/ui';

export const dynamic = 'force-dynamic';

const TYPES = ['unsecured', 'secured', 'priority', 'student-loan', 'court-fine',
               'benefit-overpayment', 'tax', 'child-maintenance', 'business', 'other'];
const PROVENANCE = ['client-declared', 'credit-file', 'creditor-confirmed',
                    'document-extracted', 'open-banking'];

const sentence = (v: string) => v.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * The debts on the case.
 *
 * Provenance is shown on every row rather than hidden in a detail view: a
 * balance the client remembered and a balance the creditor confirmed are not
 * the same evidence, and a proposal built on the first is a different thing.
 * Secured and priority debts are separated in the totals because they behave
 * differently — they cannot go into most solutions, and non-payment costs a
 * home or a vehicle rather than a default notice.
 */
export default async function DebtsTab({
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
  const { debts, totals } = await query(session, (db) => loadDebts(db, id));

  async function add(formData: FormData) {
    'use server';
    const active = await requireSession();
    const text = (n: string) => {
      const v = String(formData.get(n) ?? '').trim();
      return v === '' ? null : v;
    };
    const pounds = (n: string) => Math.round(Number(text(n) ?? 0) * 100);
    try {
      await query(active, (db) => addDebt(db, active.context, active.principal, {
        caseId: header!.caseId,
        clientId: header!.clientId,
        creditorName: String(formData.get('creditorName') ?? ''),
        accountReference: text('accountReference'),
        customerNumber: text('customerNumber'),
        debtType: String(formData.get('debtType') ?? 'unsecured'),
        isPriority: formData.get('isPriority') === 'on',
        balancePence: pounds('balance'),
        arrearsPence: pounds('arrears'),
        contractualPaymentPence: text('payment') ? pounds('payment') : null,
        isJoint: formData.get('isJoint') === 'on',
        isCreditAgreement: formData.get('isCreditAgreement') === 'on',
        inDispute: formData.get('inDispute') === 'on',
        provenance: String(formData.get('provenance') ?? 'client-declared'),
      }));
    } catch (cause) {
      console.error('case file action failed', cause);
      const message = cause instanceof DebtValidationError
        ? cause.message : 'Could not add that debt.';
      redirect(`/app/cases/${id}/debts?error=${encodeURIComponent(message)}`);
    }
    redirect(`/app/cases/${id}/debts?saved=1`);
  }

  async function withdraw(formData: FormData) {
    'use server';
    const active = await requireSession();
    try {
      await query(active, (db) => removeDebt(db, active.context, active.principal,
        String(formData.get('debtId') ?? ''), String(formData.get('reason') ?? '')));
    } catch (cause) {
      console.error('case file action failed', cause);
      const message = cause instanceof DebtValidationError
        ? cause.message : 'Could not withdraw that debt.';
      redirect(`/app/cases/${id}/debts?error=${encodeURIComponent(message)}`);
    }
    redirect(`/app/cases/${id}/debts?saved=1`);
  }

  return (
    <Stack gap={5}>
      <SimulatedNotice what="A credit search would populate this list from the client's file, and the credit reference adapter is a sandbox simulator: no bureau agreement exists, so nothing here has been checked against a real credit file." />

      <Card title="Debts" subtitle="Every balance carries where it came from.">
        <DataTable
          rows={debts}
          getKey={(d) => d.id}
          empty={<EmptyState title="No debts recorded yet."
                             detail="Add them from the client's statements, or run a credit search." />}
          columns={[
            {
              key: 'creditor', header: 'Creditor',
              render: (d) => (
                <span>
                  <strong>{d.creditorName}</strong>
                  {d.isPriority && <> <RegulatedMark>Priority</RegulatedMark></>}
                  <br />
                  <span className="sv-muted">
                    {d.accountReference ?? 'No account reference'}
                    {d.customerNumber ? ` · cust ${d.customerNumber}` : ''}
                  </span>
                </span>
              ),
            },
            { key: 'type', header: 'Type', render: (d) => sentence(d.debtType) },
            { key: 'balance', header: 'Balance', numeric: true,
              render: (d) => <Money pence={d.balancePence} /> },
            { key: 'arrears', header: 'Arrears', numeric: true,
              render: (d) => (d.arrearsPence ? <Money pence={d.arrearsPence} /> : '—') },
            {
              key: 'payment', header: 'Monthly', numeric: true,
              render: (d) => (d.contractualPaymentPence
                ? <Money pence={d.contractualPaymentPence} /> : '—'),
            },
            {
              key: 'source', header: 'Source',
              render: (d) => <Badge
                tone={d.provenance === 'creditor-confirmed' ? 'positive'
                    : d.provenance === 'client-declared' ? 'attention' : 'neutral'}>
                {sentence(d.provenance)}
              </Badge>,
            },
            {
              key: 'flags', header: '',
              render: (d) => (
                <>
                  {d.isJoint && <Badge>Joint</Badge>}
                  {d.isCreditAgreement && <Badge tone="attention">HP / credit agreement</Badge>}
                  {d.inDispute && <Badge tone="critical">Disputed</Badge>}
                  {!d.includedInSolution && <Badge>Excluded</Badge>}
                </>
              ),
            },
            {
              key: 'remove', header: '',
              render: (d) => (
                <form action={withdraw} className="sv-inline-form">
                  <input type="hidden" name="debtId" value={d.id} />
                  <input className="sv-input sv-input--sm" name="reason"
                         placeholder="Reason" aria-label="Reason for withdrawal" required />
                  <button type="submit" className="sv-btn sv-btn--danger sv-btn--sm">
                    Withdraw
                  </button>
                </form>
              ),
            },
          ]}
        />
      </Card>

      <Card title="Add a debt">
        <Form action={add} submitLabel="Add debt"
              result={saved ? { ok: true, message: 'Debt list updated.' }
                    : error ? { ok: false, message: error } : null}>
          <Grid min="220px">
            <Field label="Creditor" required>
              <input className="sv-input" name="creditorName" required />
            </Field>
            <Field label="Account reference">
              <input className="sv-input" name="accountReference" />
            </Field>
            <Field label="Customer number"
                   hint="Often different from the account number, and often what correspondence needs.">
              <input className="sv-input" name="customerNumber" />
            </Field>
            <Field label="Type" required>
              <select className="sv-input" name="debtType" defaultValue="unsecured">
                {TYPES.map((t) => <option key={t} value={t}>{sentence(t)}</option>)}
              </select>
            </Field>
            <Field label="Balance owed" required>
              <input className="sv-input" name="balance" type="number"
                     step="0.01" min="0" required />
            </Field>
            <Field label="Arrears">
              <input className="sv-input" name="arrears" type="number"
                     step="0.01" min="0" defaultValue="0" />
            </Field>
            <Field label="Contractual monthly payment">
              <input className="sv-input" name="payment" type="number" step="0.01" min="0" />
            </Field>
            <Field label="Where this came from" required
                   hint="What the figure rests on changes what can be built on it.">
              <select className="sv-input" name="provenance" defaultValue="client-declared">
                {PROVENANCE.map((p) => <option key={p} value={p}>{sentence(p)}</option>)}
              </select>
            </Field>
          </Grid>
          <label className="sv-check">
            <input type="checkbox" name="isPriority" />
            <span>Priority debt — non-payment risks the home, liberty or essential supply</span>
          </label>
          <label className="sv-check">
            <input type="checkbox" name="isJoint" />
            <span>Joint debt</span>
          </label>
          <label className="sv-check">
            <input type="checkbox" name="isCreditAgreement" />
            <span>Hire purchase or conditional sale — the goods can be repossessed</span>
          </label>
          <label className="sv-check">
            <input type="checkbox" name="inDispute" />
            <span>In dispute</span>
          </label>
        </Form>
      </Card>

      <SummaryBar figures={[
        { label: 'Unsecured creditors', value: totals.unsecuredCount },
        { label: 'Total unsecured', value: <Money pence={totals.unsecuredPence} />,
          tone: 'critical' },
        { label: 'Monthly, unsecured', value: <Money pence={totals.unsecuredMonthlyPence} /> },
        { label: 'Secured creditors', value: totals.securedCount },
        { label: 'Total secured', value: <Money pence={totals.securedPence} />, tone: 'critical' },
        { label: 'Priority debts', value: totals.priorityCount,
          tone: totals.priorityCount ? 'critical' : 'neutral',
          detail: totals.priorityCount ? 'Cannot enter most solutions' : undefined },
      ]} />
    </Stack>
  );
}

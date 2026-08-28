import { redirect } from 'next/navigation';
import { requireSession, query } from '@/lib/console/session';
import { loadCaseFileHeader, listHouseholdMembers } from '@/lib/console/case-file';
import {
  compositionFrom, loadCurrentStatement, saveStatement, StatementEntryError,
  type StatementEntryLine,
} from '@solvenda/core';
import {
  Badge, Card, Field, Form, Grid, Money, Stack, SummaryBar,
} from '@solvenda/ui';

export const dynamic = 'force-dynamic';

/**
 * Income and expenditure.
 *
 * Laid out by SFS category, with the frequency the client actually gave and
 * what backs each figure. Two properties matter more than the layout: saving
 * supersedes rather than edits, so the statement a proposal rested on survives
 * intact; and every total on screen comes from the same `buildStatement` call
 * that writes the database, so the two cannot disagree.
 */

const INCOME = [
  { category: 'wages', label: 'Salary or wages (take home)' },
  { category: 'partner-wages', label: 'Partner salary or wages (take home)' },
  { category: 'other-earnings', label: "Other earnings, including self-employment" },
  { category: 'benefits', label: 'Benefits and tax credits' },
  { category: 'pensions', label: 'Pensions' },
  { category: 'other-income', label: 'Other income' },
];

/** Category keys match the trigger figure set, so exceedances line up. */
const EXPENDITURE = [
  { category: 'food-and-housekeeping', label: 'Food and housekeeping' },
  { category: 'communications-and-leisure', label: 'Communications and leisure' },
  { category: 'personal-costs', label: 'Personal costs' },
  { category: 'travel', label: 'Travel' },
  { category: 'other-costs', label: 'Other costs' },
  { category: 'rent-or-mortgage', label: 'Rent or mortgage' },
  { category: 'utilities', label: 'Gas, electricity and water' },
  { category: 'council-tax', label: 'Council tax' },
  { category: 'insurance', label: 'Insurance' },
  { category: 'childcare', label: 'Childcare and maintenance' },
];

const FREQUENCIES = ['weekly', 'fortnightly', 'four-weekly', 'monthly', 'quarterly', 'annually'];
const EVIDENCE = [
  { value: 'none', label: 'No evidence' },
  { value: 'verbal', label: 'Verbal' },
  { value: 'document', label: 'Document' },
  { value: 'open-banking', label: 'Open Banking' },
  { value: 'waived', label: 'Waived' },
];

export default async function FinancesTab({
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

  const [statement, members] = await Promise.all([
    query(session, (db) => loadCurrentStatement(db, id)),
    query(session, (db) => listHouseholdMembers(db, header.clientId)),
  ]);
  const household = compositionFrom(members);

  const existing = new Map(statement.lines.map((l) => [`${l.section}:${l.category}`, l]));
  const income = statement.lines.filter((l) => l.section === 'income');
  const expenditure = statement.lines.filter((l) => l.section === 'expenditure');
  const totalIncome = income.reduce((t, l) => t + l.amountPence, 0);
  const totalExpenditure = expenditure.reduce((t, l) => t + l.amountPence, 0);

  async function save(formData: FormData) {
    'use server';
    const active = await requireSession();

    const lines: StatementEntryLine[] = [];
    for (const section of ['income', 'expenditure'] as const) {
      const rows = section === 'income' ? INCOME : EXPENDITURE;
      for (const row of rows) {
        const raw = String(formData.get(`${section}:${row.category}:amount`) ?? '').trim();
        if (raw === '' || Number(raw) === 0) continue;
        lines.push({
          section,
          category: row.category,
          label: row.label,
          enteredAmountPence: Math.round(Number(raw) * 100),
          enteredFrequency: String(
            formData.get(`${section}:${row.category}:frequency`) ?? 'monthly') as never,
          evidenceStatus: String(
            formData.get(`${section}:${row.category}:evidence`) ?? 'none') as never,
          explanation: String(
            formData.get(`${section}:${row.category}:explanation`) ?? '').trim() || null,
        });
      }
    }

    try {
      await query(active, (db) => saveStatement(db, active.context, active.principal, {
        caseId: header!.caseId,
        clientId: header!.clientId,
        lines,
        household,
        supersedeReason: String(formData.get('reason') ?? '').trim()
          || 'Income and expenditure updated from the case file',
      }));
    } catch (cause) {
      console.error('case file action failed', cause);
      const message = cause instanceof StatementEntryError
        ? cause.message : 'Could not save the statement. Nothing was changed.';
      redirect(`/app/cases/${id}/finances?error=${encodeURIComponent(message)}`);
    }
    redirect(`/app/cases/${id}/finances?saved=1`);
  }

  const row = (section: 'income' | 'expenditure',
               entry: { category: string; label: string }) => {
    const line = existing.get(`${section}:${entry.category}`);
    const pounds = line ? (line.enteredAmountPence / 100).toFixed(2) : '';
    return (
      <div key={entry.category} className="sv-ie-row">
        <span className="sv-ie-row__label">{entry.label}</span>
        <input className="sv-input" name={`${section}:${entry.category}:amount`}
               type="number" step="0.01" min="0" defaultValue={pounds}
               aria-label={`${entry.label} amount`} />
        <select className="sv-input" name={`${section}:${entry.category}:frequency`}
                defaultValue={line?.enteredFrequency ?? 'monthly'}
                aria-label={`${entry.label} frequency`}>
          {FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}
        </select>
        <select className="sv-input" name={`${section}:${entry.category}:evidence`}
                defaultValue={line?.evidenceStatus ?? 'none'}
                aria-label={`${entry.label} evidence`}>
          {EVIDENCE.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
        </select>
        <input className="sv-input" name={`${section}:${entry.category}:explanation`}
               placeholder="Explanation, if over the guideline"
               defaultValue={line?.explanation ?? ''}
               aria-label={`${entry.label} explanation`} />
      </div>
    );
  };

  return (
    <Form action={save} submitLabel="Save statement"
          result={saved ? { ok: true, message: 'Statement saved as a new version.' }
                : error ? { ok: false, message: error } : null}>
      <Stack gap={5}>
        <Card
          title={statement.id ? `Statement version ${statement.version}` : 'No statement yet'}
          subtitle="Saving creates a new version rather than editing this one, so the statement any advice rested on stays intact."
        >
          <p className="sv-muted" style={{ margin: 0 }}>
            Household: {household.adults} adult{household.adults === 1 ? '' : 's'},{' '}
            {household.children} child{household.children === 1 ? '' : 'ren'} — which bands the
            trigger figures these entries are compared against.
          </p>
        </Card>

        <Card title="Income" subtitle="Take-home figures, at the frequency the client is paid.">
          <div className="sv-ie-head">
            <span>Category</span><span>Amount</span><span>Frequency</span>
            <span>Evidence</span><span>Explanation</span>
          </div>
          {INCOME.map((entry) => row('income', entry))}
        </Card>

        <Card title="Expenditure"
              subtitle="Compared against the SFS trigger figures for this household. Going over is allowed; it needs an explanation, not a refusal.">
          <div className="sv-ie-head">
            <span>Category</span><span>Amount</span><span>Frequency</span>
            <span>Evidence</span><span>Explanation</span>
          </div>
          {EXPENDITURE.map((entry) => row('expenditure', entry))}
        </Card>

        <Card title="Why this statement changed"
              subtitle="Recorded against the superseded version.">
          <Field label="Reason">
            <input className="sv-input" name="reason"
                   placeholder="Annual review, corrected income, new expenditure…" />
          </Field>
        </Card>
      </Stack>

      <SummaryBar figures={[
        { label: 'Total household income', value: <Money pence={totalIncome} />,
          tone: 'positive', detail: 'Per month' },
        { label: 'Total expenditure', value: <Money pence={totalExpenditure} />,
          tone: 'critical', detail: 'Per month' },
        {
          label: 'Balance',
          value: <Money pence={totalIncome - totalExpenditure} showSign />,
          tone: totalIncome - totalExpenditure >= 0 ? 'accent' : 'critical',
          detail: totalIncome - totalExpenditure >= 0
            ? 'Available to creditors' : 'Deficit — no solution is affordable',
        },
        {
          label: 'Evidence',
          value: <Badge tone={statement.lines.some((l) => l.evidenceStatus !== 'none')
            ? 'positive' : 'attention'}>
            {statement.lines.filter((l) => l.evidenceStatus !== 'none').length}
            {' of '}{statement.lines.length}
          </Badge>,
          detail: 'Lines with something behind them',
        },
      ]} />
    </Form>
  );
}

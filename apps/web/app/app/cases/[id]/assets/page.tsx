import { redirect } from 'next/navigation';
import { requireSession, query } from '@/lib/console/session';
import { loadCaseFileHeader, listAssets } from '@/lib/console/case-file';
import { recordAsset, totalAttributableEquity, AssetValidationError } from '@solvenda/core';
import {
  Badge, Card, DataTable, EmptyState, Field, Form, Grid, Money, Stack, SummaryBar,
} from '@solvenda/ui';

export const dynamic = 'force-dynamic';

const TYPES = ['property', 'vehicle', 'savings', 'investment', 'pension', 'business',
               'insurance-policy', 'valuable-item', 'other'];
const OWNERSHIP = ['sole', 'joint', 'beneficial', 'none'];
const BASIS = ['client-estimate', 'professional-valuation', 'trade-guide', 'statement'];

const sentence = (v: string) => v.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * What the client owns.
 *
 * Equity is derived, never stored, so value and secured debt cannot drift apart
 * from the figure eligibility tests. Joint ownership attributes only the
 * client's share, which is what the DRO and bankruptcy limits actually measure,
 * and an exemption carries the reason it was claimed rather than only the
 * conclusion.
 */
export default async function AssetsTab({
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
  const assets = await query(session, (db) => listAssets(db, header.clientId));

  const grossValue = assets.reduce((t, a) => t + a.estimatedValuePence, 0);
  const countedEquity = totalAttributableEquity(assets);
  const exempt = assets.filter((a) => a.exemptionClaimed).length;

  async function add(formData: FormData) {
    'use server';
    const active = await requireSession();
    const text = (n: string) => {
      const v = String(formData.get(n) ?? '').trim();
      return v === '' ? null : v;
    };
    const pounds = (n: string) => Math.round(Number(text(n) ?? 0) * 100);
    try {
      await query(active, (db) => recordAsset(db, active.context, active.principal, {
        clientId: header!.clientId,
        caseId: header!.caseId,
        assetType: String(formData.get('assetType') ?? 'other') as never,
        description: String(formData.get('description') ?? ''),
        estimatedValuePence: pounds('value'),
        securedDebtPence: pounds('securedDebt'),
        ownership: String(formData.get('ownership') ?? 'sole') as never,
        ownershipShareBps: Math.round(Number(text('share') ?? 100) * 100),
        exemptionClaimed: text('exemption'),
        exemptionReason: text('exemptionReason'),
        valuationBasis: String(formData.get('basis') ?? 'client-estimate') as never,
      }));
    } catch (cause) {
      console.error('case file action failed', cause);
      const message = cause instanceof AssetValidationError
        ? cause.message : 'Could not save that asset.';
      redirect(`/app/cases/${id}/assets?error=${encodeURIComponent(message)}`);
    }
    redirect(`/app/cases/${id}/assets?saved=1`);
  }

  return (
    <Stack gap={5}>
      <Card title="Assets"
            subtitle="Equity, not value, is what decides eligibility — and only the client's share of it.">
        <DataTable
          rows={assets}
          getKey={(a) => a.id}
          empty={<EmptyState title="No assets recorded."
                             detail="A DRO has asset limits, so an empty list is itself a finding worth confirming." />}
          columns={[
            {
              key: 'what', header: 'Asset',
              render: (a) => (
                <span>
                  <strong>{a.description}</strong><br />
                  <span className="sv-muted">{sentence(a.assetType)}</span>
                </span>
              ),
            },
            { key: 'value', header: 'Value', numeric: true,
              render: (a) => <Money pence={a.estimatedValuePence} /> },
            { key: 'secured', header: 'Secured against', numeric: true,
              render: (a) => <Money pence={a.securedDebtPence} /> },
            { key: 'equity', header: 'Equity', numeric: true,
              render: (a) => <Money pence={a.equityPence} /> },
            {
              key: 'share', header: 'Client share', numeric: true,
              render: (a) => (
                <span>
                  <Money pence={a.attributableEquityPence} /><br />
                  <span className="sv-muted">{a.ownershipShareBps / 100}%</span>
                </span>
              ),
            },
            {
              key: 'exempt', header: '',
              render: (a) => (a.exemptionClaimed
                ? <Badge tone="attention" title={a.exemptionReason ?? undefined}>Exempt</Badge>
                : null),
            },
          ]}
        />
      </Card>

      <Card title="Record an asset">
        <Form action={add} submitLabel="Add asset"
              result={saved ? { ok: true, message: 'Asset recorded.' }
                    : error ? { ok: false, message: error } : null}>
          <Grid min="220px">
            <Field label="Type" required>
              <select className="sv-input" name="assetType" defaultValue="vehicle">
                {TYPES.map((t) => <option key={t} value={t}>{sentence(t)}</option>)}
              </select>
            </Field>
            <Field label="Description" required
                   hint="Specific enough to identify it. &quot;Vehicle&quot; on its own is not.">
              <input className="sv-input" name="description" required />
            </Field>
            <Field label="Estimated value" required>
              <input className="sv-input" name="value" type="number" step="0.01" min="0" required />
            </Field>
            <Field label="Secured debt against it">
              <input className="sv-input" name="securedDebt" type="number"
                     step="0.01" min="0" defaultValue="0" />
            </Field>
            <Field label="Ownership">
              <select className="sv-input" name="ownership" defaultValue="sole">
                {OWNERSHIP.map((o) => <option key={o} value={o}>{sentence(o)}</option>)}
              </select>
            </Field>
            <Field label="Client share %" hint="50 for a jointly owned home.">
              <input className="sv-input" name="share" type="number"
                     min="0" max="100" step="1" defaultValue="100" />
            </Field>
            <Field label="Valuation basis">
              <select className="sv-input" name="basis" defaultValue="client-estimate">
                {BASIS.map((b) => <option key={b} value={b}>{sentence(b)}</option>)}
              </select>
            </Field>
            <Field label="Exemption claimed"
                   hint="For example, a vehicle needed for work.">
              <input className="sv-input" name="exemption" />
            </Field>
            <Field label="Why the exemption applies"
                   hint="Required whenever one is claimed.">
              <input className="sv-input" name="exemptionReason" />
            </Field>
          </Grid>
        </Form>
      </Card>

      <SummaryBar figures={[
        { label: 'Assets', value: assets.length,
          detail: exempt ? `${exempt} exempt` : undefined },
        { label: 'Gross value', value: <Money pence={grossValue} /> },
        { label: 'Equity counted', value: <Money pence={countedEquity} />, tone: 'accent',
          detail: "Client's share, exemptions excluded" },
      ]} />
    </Stack>
  );
}

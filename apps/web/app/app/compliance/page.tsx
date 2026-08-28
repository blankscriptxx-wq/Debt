import { query } from '@/lib/console/session';
import { withShell } from '@/lib/console/shell';
import { loadCompliance } from '@/lib/console/pages';
import {
  Badge, Card, DataTable, EmptyState, Grid, PageHeader, RegulatedMark, Stack, StatTile,
} from '@solvenda/ui';

export const dynamic = 'force-dynamic';

/**
 * Compliance oversight.
 *
 * The intent is that a compliance officer can answer a supervisor's questions
 * from this page rather than by commissioning an extract: what regulated
 * decisions were made, by whom, on what basis, and can the record be shown to
 * be intact.
 */
export default async function CompliancePage() {
  return withShell('compliance', async (session) => {
    const data = await query(session, (db) => loadCompliance(db));

    return (
      <>
        <PageHeader
          eyebrow="Compliance"
          title="Oversight"
          meta={<span>Everything here is computed from the audit ledger</span>}
        />

        <Stack gap={5}>
          <Card
            title="Audit ledger integrity"
            subtitle="Each entry is SHA-256 chained to its predecessor, per firm"
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
              <Badge tone={data.chainVerified ? 'positive' : 'critical'}>
                {data.chainVerified ? 'Verified' : 'Chain broken'}
              </Badge>
              <span>
                {data.chainEntries.toLocaleString('en-GB')} entries recomputed and checked.
              </span>
            </div>
            {!data.chainVerified && (
              <p style={{ color: 'var(--critical)', marginTop: 'var(--space-3)' }}>
                {data.chainDetail}. History has been altered outside the application. This
                needs investigating before the ledger is relied on.
              </p>
            )}
          </Card>

          <Grid min="200px">
            <StatTile label="Regulated actions this month"
                      value={data.regulatedActionsThisMonth}
                      footnote="Advice, consent, vulnerability, overrides" />
            <StatTile label="Compliance checks overridden"
                      value={data.overriddenChecks}
                      tone={data.overriddenChecks > 0 ? 'attention' : 'neutral'}
                      footnote="Each carries a named person and a reason" />
            <StatTile label="Consents withdrawn" value={data.consentsWithdrawn} />
          </Grid>

          <Card title="Vulnerability by FG21/1 driver"
                subtitle="Health, life events, resilience and capability"
                padded={false}>
            <DataTable
              rows={data.vulnerabilityByDriver}
              getKey={(r) => r.driver}
              empty={<EmptyState title="No active vulnerability records."
                                 detail="This is worth interrogating rather than celebrating: CONC notes that most people seeking debt advice may be vulnerable to some degree." />}
              columns={[
                { key: 'driver', header: 'Driver',
                  render: (r) => r.driver.replace(/-/g, ' ') },
                { key: 'count', header: 'Active records', numeric: true, render: (r) => r.count },
              ]}
            />
          </Card>

          <Card title="Failing compliance checks" padded={false}>
            <DataTable
              rows={data.failingChecks}
              getKey={(r) => r.ruleKey}
              empty={<EmptyState title="No failing checks." />}
              columns={[
                { key: 'rule', header: 'Rule', render: (r) => r.ruleKey },
                { key: 'severity', header: 'Severity', render: (r) => (
                  <Badge tone={r.severity === 'blocking' ? 'critical' : 'attention'}>
                    {r.severity}
                  </Badge>
                )},
                { key: 'count', header: 'Cases', numeric: true, render: (r) => r.count },
              ]}
            />
          </Card>

          <Card
            title="Regulated actions"
            subtitle="Who, what, when, why - the entries a file review asks for"
            actions={<RegulatedMark />}
            padded={false}
          >
            <DataTable
              rows={data.recentRegulatedActions}
              getKey={(r) => r.id}
              empty={<EmptyState title="No regulated actions recorded yet." />}
              columns={[
                { key: 'when', header: 'When',
                  render: (r) => new Date(r.occurredAt).toLocaleString('en-GB',
                    { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) },
                { key: 'action', header: 'Action',
                  render: (r) => r.action.replace(/\./g, ' · ') },
                { key: 'actor', header: 'By', render: (r) => r.actor },
                { key: 'case', header: 'Case', render: (r) => r.caseReference ?? '—' },
                { key: 'reason', header: 'Why', render: (r) => (
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
                    {r.reason ?? '—'}
                  </span>
                )},
              ]}
            />
          </Card>
        </Stack>
      </>
    );
  });
}

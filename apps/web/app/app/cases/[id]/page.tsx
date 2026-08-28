import { notFound } from 'next/navigation';
import { requireSession, query } from '@/lib/console/session';
import { loadCaseDetail } from '@/lib/console/data';
import { ProposalDecision } from '@/components/console/proposal-decision';
import {
  Badge, Card, DataTable, EmptyState, Grid, HealthMeter, Money,
  PageHeader, RegulatedMark, SignalRow, Stack, StatTile,
} from '@solvenda/ui';

export const dynamic = 'force-dynamic';

/**
 * The Case Intelligence view.
 *
 * This page is the product's argument. An adviser opening a file should
 * understand it in seconds: how the case is doing and why, whether it is ready
 * for advice and what is missing, what to do next, what the alternatives are,
 * and what has been suggested that needs their decision. Every element traces
 * back to the records that produced it, so nothing here has to be taken on
 * faith.
 */
export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;

  const detail = await query(session, (db) => loadCaseDetail(db, id));

  if (!detail) notFound();
  const { intelligence: intel } = detail;

  const statement = intel.eligibility.facts;
  const surplus = statement['sfs.surplusPence'];
  const totalDebt = statement['debt.qualifyingPence'];

  return (
    <>

      <div className="sv-case-layout">
        <Stack gap={5}>
          <Card title="Case health" subtitle="Computed from the case record, not inferred">
            <HealthMeter score={intel.health.score} band={intel.health.band}
                         summary={intel.health.summary} />
          </Card>

          <Card title="Advice readiness"
                subtitle={intel.adviceReadiness.ready
                  ? 'Everything needed to advise is present'
                  : `${intel.adviceReadiness.blocking.length} item${intel.adviceReadiness.blocking.length === 1 ? '' : 's'} outstanding`}>
            {intel.adviceReadiness.ready ? (
              <p style={{ margin: 0, color: 'var(--positive)' }}>
                The financial picture, affordability assessment and required evidence are all in
                place. The decision itself remains yours to make and record.
              </p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: '1.1rem' }}>
                {intel.adviceReadiness.blocking.map((item) => (
                  <li key={item.item} style={{ marginBottom: 'var(--space-2)' }}>
                    <strong>{item.item}.</strong>{' '}
                    <span style={{ color: 'var(--ink-muted)' }}>{item.why}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="What to do next"
                subtitle="Derived from the signals below, most pressing first">
            {intel.nextActions.length === 0 ? (
              <EmptyState title="Nothing needs your attention on this case." />
            ) : (
              <ol style={{ margin: 0, paddingLeft: '1.1rem' }}>
                {intel.nextActions.map((action) => (
                  <li key={action.key} style={{ marginBottom: 'var(--space-3)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong>{action.title}</strong>
                      <Badge tone={action.urgency === 'now' ? 'critical'
                                  : action.urgency === 'this-week' ? 'attention' : 'neutral'}>
                        {action.urgency === 'now' ? 'Now'
                         : action.urgency === 'this-week' ? 'This week' : 'When convenient'}
                      </Badge>
                    </div>
                    <p style={{ margin: '4px 0 0', color: 'var(--ink-muted)',
                                fontSize: 'var(--text-sm)' }}>
                      Because: {action.reason}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </Card>

          <Card title="Signals"
                subtitle="Each one names the records it came from"
                padded={false}>
            {intel.signals.length === 0 ? (
              <EmptyState title="No signals raised." />
            ) : (
              <ul className="sv-signal-list">
                {intel.signals.map((signal) => (
                  <SignalRow key={signal.key} severity={signal.severity}
                             title={signal.title} detail={signal.detail}
                             sources={signal.sources} action={signal.suggestedAction} />
                ))}
              </ul>
            )}
          </Card>

          {detail.proposals.length > 0 && (
            <Card
              title="Suggestions awaiting your decision"
              subtitle="Nothing here has been applied. Suggestions affecting regulated information can only be actioned by you."
            >
              <Stack gap={3}>
                {detail.proposals.map((proposal) => (
                  <ProposalDecision key={proposal.id} caseId={id} proposal={{
                    id: proposal.id,
                    proposalType: proposal.proposalType,
                    targetTable: proposal.targetTable,
                    targetField: proposal.targetField,
                    currentValue: proposal.currentValue,
                    proposedValue: proposal.proposedValue,
                    reasoning: proposal.reasoning,
                    confidence: proposal.confidence,
                    touchesRegulatedField: proposal.touchesRegulatedField,
                  }} />
                ))}
              </Stack>
            </Card>
          )}

          <Card title="Solution comparison"
                subtitle="Every solution available in this jurisdiction, and precisely what stands in the way of the others"
                padded={false}>
            <DataTable
              rows={intel.eligibility.assessments}
              getKey={(a) => a.caseTypeKey}
              columns={[
                { key: 'name', header: 'Solution', render: (a) => a.name },
                { key: 'available', header: 'Status', render: (a) =>
                  a.available
                    ? <Badge tone="positive">Available</Badge>
                    : <Badge tone="neutral">Ruled out</Badge> },
                { key: 'why', header: 'Why', render: (a) => (
                  <Stack gap={1}>
                    {a.blockers.map((b) => (
                      <span key={b.key} style={{ fontSize: 'var(--text-sm)' }}>{b.message}</span>
                    ))}
                    {a.warnings.map((w) => (
                      <span key={w.key} style={{ fontSize: 'var(--text-sm)', color: 'var(--attention)' }}>
                        {w.message}{w.authority ? ` (${w.authority})` : ''}
                      </span>
                    ))}
                    {a.available && a.warnings.length === 0 && (
                      <span style={{ color: 'var(--ink-subtle)' }}>Meets every configured rule</span>
                    )}
                  </Stack>
                )},
              ]}
            />
          </Card>

          <Card title="Debts" padded={false}>
            <DataTable
              rows={detail.debts}
              getKey={(d) => d.id}
              empty={<EmptyState title="No debts recorded yet."
                                 detail="A case cannot reach advice without them." />}
              columns={[
                { key: 'creditor', header: 'Creditor', render: (d) => d.creditorName },
                { key: 'balance', header: 'Balance', numeric: true,
                  render: (d) => <Money pence={d.balancePence} /> },
                { key: 'priority', header: 'Priority', render: (d) =>
                  d.isPriority ? <Badge tone="attention">Priority</Badge> : null },
                { key: 'provenance', header: 'Source',
                  render: (d) => <span style={{ fontSize: 'var(--text-sm)',
                                                color: 'var(--ink-muted)' }}>
                    {d.provenance.replace(/-/g, ' ')}
                  </span> },
                { key: 'status', header: 'Status', render: (d) => d.status },
              ]}
            />
          </Card>
        </Stack>

        <Stack gap={5}>
          <Card title="Position">
            <Grid min="130px">
              <StatTile label="Qualifying debt"
                        value={<Money pence={Number(totalDebt ?? 0)} />} />
              <StatTile label="Monthly surplus"
                        tone={Number(surplus ?? 0) < 0 ? 'critical' : 'neutral'}
                        value={surplus === null || surplus === undefined
                          ? '—' : <Money pence={Number(surplus)} />} />
            </Grid>
          </Card>

          <Card title="Tasks" padded={false}>
            {detail.tasks.length === 0 ? (
              <EmptyState title="No open tasks." />
            ) : (
              <ul style={{ margin: 0, padding: 'var(--space-3)', listStyle: 'none' }}>
                {detail.tasks.map((task) => (
                  <li key={task.id} style={{ padding: 'var(--space-2) 0',
                                             borderBottom: '1px solid var(--border)' }}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Badge tone={task.priority === 'urgent' || task.priority === 'high'
                        ? 'attention' : 'neutral'}>{task.priority}</Badge>
                      <span style={{ fontSize: 'var(--text-sm)' }}>{task.title}</span>
                    </div>
                    {task.dueAt && (
                      <p style={{ margin: '2px 0 0', fontSize: 'var(--text-xs)',
                                  color: 'var(--ink-subtle)' }}>
                        Due {new Date(task.dueAt).toLocaleDateString('en-GB')}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Timeline"
                subtitle="Communications, decisions and events in one account"
                padded={false}>
            {detail.timeline.length === 0 ? (
              <EmptyState title="Nothing has happened on this case yet." />
            ) : (
              <ul className="sv-timeline" style={{ padding: 'var(--space-3) var(--space-4)' }}>
                {detail.timeline.slice(0, 18).map((entry) => (
                  <li key={`${entry.kind}-${entry.id}`} className="sv-timeline__item">
                    <span className="sv-timeline__when">
                      {new Date(entry.occurredAt).toLocaleDateString('en-GB',
                        { day: '2-digit', month: 'short' })}
                      <br />
                      {new Date(entry.occurredAt).toLocaleTimeString('en-GB',
                        { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <div>
                      <p className="sv-timeline__title">
                        {formatTitle(entry.title)}
                        {entry.severity === 'regulated' && <> <RegulatedMark /></>}
                        {entry.simulated && <> <Badge tone="attention">Simulated</Badge></>}
                      </p>
                      {entry.detail && <p className="sv-timeline__detail">{entry.detail}</p>}
                      {entry.actorLabel && (
                        <span className="sv-timeline__actor">{entry.actorLabel}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </Stack>
      </div>
    </>
  );
}

const CHANNEL_LABELS: Record<string, string> = {
  sms: 'SMS', whatsapp: 'WhatsApp', email: 'Email', call: 'Call',
  letter: 'Letter', portal: 'Portal message', 'internal-note': 'Internal note',
};

function formatTitle(raw: string): string {
  if (CHANNEL_LABELS[raw.toLowerCase()]) return CHANNEL_LABELS[raw.toLowerCase()]!;
  if (!raw.includes('.')) return raw;
  const words = raw.replace(/[._-]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

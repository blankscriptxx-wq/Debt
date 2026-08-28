import { requireOperator } from '@/lib/session';
import { listEnquiries } from '@/lib/data';
import { ControlShell } from '@/components/shell';
import { Badge, Card, DataTable, EmptyState, PageHeader } from '@solvenda/ui';

export const dynamic = 'force-dynamic';

const TONE: Record<string, 'positive' | 'neutral' | 'attention'> = {
  new: 'attention',
  'in-progress': 'neutral',
  answered: 'positive',
  closed: 'neutral',
  spam: 'neutral',
};

export default async function EnquiriesPage() {
  const session = await requireOperator();
  const enquiries = await listEnquiries(session.operatorId);

  return (
    <ControlShell session={session} current="enquiries">
      <PageHeader
        eyebrow="Commercial"
        title="Enquiries"
        meta={<span>Submitted from the public site through the unauthenticated write path</span>}
      />
      <Card padded={false}>
        <DataTable
          rows={enquiries}
          getKey={(e) => e.id}
          empty={
            <EmptyState
              title="No enquiries yet."
              detail="The contact form on the marketing site writes here. Nothing else can read these rows."
            />
          }
          columns={[
            {
              key: 'who',
              header: 'From',
              render: (e) => (
                <span>
                  <strong>{e.name}</strong>
                  <br />
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
                    {e.organisation || '—'} · {e.email}
                  </span>
                </span>
              ),
            },
            { key: 'type', header: 'About', render: (e) => <Badge>{e.enquiryType}</Badge> },
            {
              key: 'message',
              header: 'Message',
              render: (e) => (
                <span style={{ color: 'var(--ink-muted)' }}>
                  {e.message.length > 160 ? `${e.message.slice(0, 160)}…` : e.message}
                </span>
              ),
            },
            { key: 'from', header: 'Page', render: (e) => e.sourcePath },
            {
              key: 'when',
              header: 'Received',
              render: (e) => new Date(e.submittedAt).toLocaleString('en-GB'),
            },
            {
              key: 'status',
              header: 'Status',
              render: (e) => <Badge tone={TONE[e.status] ?? 'neutral'}>{e.status}</Badge>,
            },
          ]}
        />
      </Card>
    </ControlShell>
  );
}

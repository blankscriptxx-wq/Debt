import { requireOperator } from '@/lib/session';
import { listProviders } from '@/lib/data';
import { ControlShell } from '@/components/shell';
import { Badge, Card, DataTable, EmptyState, PageHeader, Stack } from '@solvenda/ui';

export const dynamic = 'force-dynamic';

export default async function ProvidersPage() {
  const session = await requireOperator();
  const providers = await listProviders(session.operatorId);
  const live = providers.filter((p) => !p.simulated).length;

  return (
    <ControlShell session={session} current="providers">
      <PageHeader eyebrow="Integrations" title="Provider catalogue"
                  meta={<span>{providers.length} providers, {live} of them live</span>} />
      <Stack gap={4}>
        {live === 0 && (
          <div className="ct-warning">
            <strong>Every provider is a sandbox simulator.</strong> No live vendor credentials
            exist on this deployment, so nothing reaches a real third party. This is stated on
            the provider, on each install and on every recorded call, and shown to firms in
            their own console.
          </div>
        )}
        <Card padded={false}>
          <DataTable
            rows={providers} getKey={(p) => p.key}
            empty={<EmptyState title="Catalogue not published." />}
            columns={[
              { key: 'name', header: 'Provider', render: (p) => (
                <span><strong>{p.name}</strong><br />
                  <span style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-muted)' }}>
                    {p.description}
                  </span>
                </span>
              )},
              { key: 'category', header: 'Category',
                render: (p) => <Badge>{p.category.replace(/-/g, ' ')}</Badge> },
              { key: 'mode', header: 'Mode', render: (p) => (
                <Badge tone={p.simulated ? 'attention' : 'positive'}>
                  {p.simulated ? 'Simulated' : 'Live'}
                </Badge>
              )},
              { key: 'installs', header: 'Firms', numeric: true, render: (p) => p.installs },
              { key: 'calls', header: 'Calls', numeric: true, render: (p) => p.calls },
              { key: 'status', header: 'Status', render: (p) => p.status },
            ]}
          />
        </Card>
      </Stack>
    </ControlShell>
  );
}

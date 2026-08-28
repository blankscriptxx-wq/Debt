import { sql } from '@solvenda/db';
import { query } from '@/lib/console/session';
import { withShell } from '@/lib/console/shell';
import { Card, DataTable, EmptyState, Grid, PageHeader, Stack, StatTile } from '@solvenda/ui';

export const dynamic = 'force-dynamic';

/**
 * Quality assurance.
 *
 * The market standard is manual sampling of 3-5% of interactions. The design
 * position here is that AI reviews every interaction and a person signs off the
 * sampled and risk-flagged ones - so coverage stops being the constraint and
 * reviewer time goes where it matters. The review workflow itself is the next
 * piece of work; what is live today is the coverage picture below.
 */
export default async function QualityPage() {
  return withShell('quality', async (session) => {
    const data = await query(session, async (db) => {
      // Human sign-off counts come from the QA review tables, which land with
      // the reviewer workflow. Reporting zero is honest; inventing a number
      // from something adjacent would not be.
      const res = await db.execute<{ interactions: string; calls: string; ai_reviews: string }>(sql`
        SELECT (SELECT count(*) FROM communications)::text AS interactions,
               (SELECT count(*) FROM communications WHERE channel = 'call')::text AS calls,
               (SELECT count(*) FROM ai_invocations
                 WHERE capability_key = 'qa-review')::text AS ai_reviews`);
      return { ...res.rows[0]!, reviewed: '0' };
    });

    const interactions = Number(data.interactions);
    const aiReviews = Number(data.ai_reviews);
    const coverage = interactions === 0 ? 0 : Math.round((aiReviews / interactions) * 100);

    return (
      <>
        <PageHeader
          eyebrow="Quality assurance"
          title="Coverage and review"
          meta={<span>Assessment is a first pass; a person confirms or overrides every finding</span>}
        />

        <Stack gap={5}>
          <Grid min="200px">
            <StatTile label="Interactions recorded" value={interactions} />
            <StatTile label="Calls" value={Number(data.calls)} />
            <StatTile label="AI first-pass reviews" value={aiReviews}
                      footnote={`${coverage}% coverage`} />
            <StatTile label="Human sign-offs" value={Number(data.reviewed)} />
          </Grid>

          <Card title="Where this is going, honestly">
            <p style={{ margin: 0, color: 'var(--ink-muted)' }}>
              The QA capability, its prompt and its output schema exist and are tested. What is
              not yet built is the reviewer workflow around them: sampling rules, the review
              queue, sign-off, calibration between reviewers, and outcome reporting by adviser
              and by cohort. Until that lands, this page reports coverage rather than claiming a
              QA programme.
            </p>
            <p style={{ marginBottom: 0, color: 'var(--ink-muted)' }}>
              The capability is also off by default. A firm switches it on having reviewed the
              prompt, which is the right order.
            </p>
          </Card>
        </Stack>
      </>
    );
  });
}

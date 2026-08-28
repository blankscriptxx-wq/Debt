import { cache } from 'react';
import { requireSession, query } from './session';
import { loadCaseDetail, type CaseDetail } from './data';
import { loadCaseFileHeader, loadTabCounts, type CaseFileHeader } from './case-file';

/**
 * The case, loaded once per request.
 *
 * The spine lives in the layout and the overview lives in a page, and both need
 * the same intelligence and the same evidence. Without this they would each
 * assemble the case independently — twice the queries on the busiest route, and
 * two chances for the spine and the overview to disagree about the same file,
 * which is exactly the failure this redesign exists to remove.
 *
 * `cache` is keyed on the case id and lasts one render pass, so a request that
 * renders the layout and the page runs the work once.
 */
export const caseContext = cache(async (caseId: string): Promise<{
  header: CaseFileHeader; detail: CaseDetail; counts: Record<string, number>;
} | null> => {
  const session = await requireSession();
  const header = await query(session, (db) => loadCaseFileHeader(db, caseId));
  if (!header) return null;

  const [detail, counts] = await Promise.all([
    query(session, (db) => loadCaseDetail(db, caseId)),
    query(session, (db) => loadTabCounts(db, caseId, header.clientId)),
  ]);
  if (!detail) return null;

  return { header, detail, counts };
});

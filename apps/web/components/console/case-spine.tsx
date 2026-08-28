'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { Spine, SpineSection, SpineRow, CaseStanding, type EvidenceTone } from '@solvenda/ui';

export interface SpineRowData {
  slug: string;
  label: string;
  group: string;
  state: EvidenceTone | null;
  detail: string | null;
  count?: number;
}

/**
 * The case spine.
 *
 * A client component only because it needs the current path to mark where the
 * adviser is; everything it renders was resolved on the server. Threading the
 * active slug through all eleven pages instead would mean every new section has
 * to remember to do it.
 */
export function CaseSpine({
  rows, base, standing,
}: {
  rows: readonly SpineRowData[];
  base: string;
  standing: {
    score: number; band: string; summary: string; ready: boolean; blockingCount: number;
  };
}) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const rest = path.startsWith(base) ? path.slice(base.length).replace(/^\//, '') : '';

  // Only counted for the collapsed summary, so a narrow screen still says how
  // much is outstanding without listing it.
  const wanting = rows.filter(
    (r) => r.state === 'missing' || r.state === 'expired' || r.state === 'declared').length;

  const groups: { name: string; rows: SpineRowData[] }[] = [];
  for (const row of rows) {
    const existing = groups.find((g) => g.name === row.group);
    if (existing) existing.rows.push(row);
    else groups.push({ name: row.group, rows: [row] });
  }

  return (
    <Spine
      standing={<CaseStanding {...standing} href={base} />}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      outstanding={wanting}
    >
      {groups.map((group) => (
        <SpineSection key={group.name} title={group.name}>
          {group.rows.map((row) => (
            <SpineRow
              key={row.slug}
              href={`${base}/${row.slug}`}
              label={row.label}
              state={row.state ?? undefined}
              detail={row.detail ?? undefined}
              count={row.count}
              current={rest === row.slug}
            />
          ))}
        </SpineSection>
      ))}
    </Spine>
  );
}

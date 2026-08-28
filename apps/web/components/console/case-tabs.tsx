'use client';

import { usePathname } from 'next/navigation';
import { TabBar } from '@solvenda/ui';

/**
 * Highlights the current tab.
 *
 * A server layout cannot see which child segment rendered, and threading the
 * slug through all eleven pages purely for a highlight would mean every new tab
 * has to remember to do it. Reading the path once here costs one small client
 * component and cannot be got wrong.
 */
export function CaseTabs({
  tabs, base,
}: {
  tabs: readonly { slug: string; label: string; count?: number }[];
  base: string;
}) {
  const path = usePathname();
  const rest = path.startsWith(base) ? path.slice(base.length).replace(/^\//, '') : '';
  const current = tabs.some((t) => t.slug === rest) ? rest : '';
  return <TabBar tabs={tabs} current={current} base={base} />;
}

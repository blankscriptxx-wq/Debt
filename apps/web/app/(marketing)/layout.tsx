import { SiteHeader, SiteFooter } from '@/components/marketing/layout';

/** The public site. A route group, so it adds chrome without adding a path segment. */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      {children}
      <SiteFooter />
    </>
  );
}

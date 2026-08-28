import type { MetadataRoute } from 'next';

/**
 * A small sitemap of pages that each answer a real question.
 *
 * Deliberately not a programmatic long tail: pages generated per keyword to
 * capture search volume are doorway pages, they read as such to the people we
 * are selling to, and search engines have been demoting them for years.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = 'https://solvenda.example';
  const routes = ['', '/platform', '/intelligence', '/compliance', '/security',
                  '/integrations', '/pricing', '/migration', '/developers', '/contact'];
  return routes.map((route) => ({
    url: `${base}${route}`,
    lastModified: new Date(),
    changeFrequency: 'monthly' as const,
    priority: route === '' ? 1 : 0.7,
  }));
}

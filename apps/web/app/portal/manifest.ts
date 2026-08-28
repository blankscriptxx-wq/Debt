import type { MetadataRoute } from 'next';

/** Installable on a phone home screen, which is how most clients will use it. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Your debt advice account',
    short_name: 'My account',
    description: 'See your case and send us what we need.',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#1F5FD0',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
  };
}

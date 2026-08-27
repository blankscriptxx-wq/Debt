import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Your debt advice account',
  description: 'See your case, send us information and keep track of what happens next.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Never block zoom: people who need it need it.
  maximumScale: 5,
  themeColor: '#1F5FD0',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}

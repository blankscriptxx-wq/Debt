import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Solvenda Console',
  description: 'Case management and intelligence for regulated financial-difficulty services.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}

import Link from 'next/link';

export function ClientShell({
  firmName, firstName, current, children,
}: {
  firmName: string; firstName: string;
  current: 'progress' | 'messages' | 'documents';
  children: React.ReactNode;
}) {
  return (
    <div className="cp-shell">
      <header className="cp-header">
        <div>
          <p className="cp-header__firm">{firmName}</p>
          <p className="cp-header__sub">Signed in as {firstName}</p>
        </div>
        <form method="post" action="/sign-out">
          {/* Full-size touch target: the console's compact button is below the
              44px floor a finger needs. */}
          <button type="submit" className="cp-signout">Sign out</button>
        </form>
      </header>

      <main className="cp-main">{children}</main>

      <nav className="cp-nav" aria-label="Sections">
        <Link href="/" aria-current={current === 'progress' ? 'page' : undefined}>Progress</Link>
        <Link href="/messages" aria-current={current === 'messages' ? 'page' : undefined}>Messages</Link>
        <Link href="/documents" aria-current={current === 'documents' ? 'page' : undefined}>Documents</Link>
      </nav>
    </div>
  );
}

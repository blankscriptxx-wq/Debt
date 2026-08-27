import { requireClient, query } from '@/lib/session';
import { loadClientMessages } from '@/lib/data';
import { ClientShell } from '@/components/shell';

export const dynamic = 'force-dynamic';

const CHANNEL: Record<string, string> = {
  email: 'Email', sms: 'Text message', whatsapp: 'WhatsApp',
  call: 'Phone call', letter: 'Letter', portal: 'Message',
};

export default async function MessagesPage() {
  const session = await requireClient();
  const messages = await query(session, (db) => loadClientMessages(db, session.clientId));

  return (
    <ClientShell firmName={session.firmName} firstName={session.firstName} current="messages">
      <h1 className="cp-h1">Messages</h1>
      <p className="cp-lede">
        Everything we have sent you, and everything you have sent us, in one place.
      </p>

      {messages.length === 0 ? (
        <div className="cp-card">
          <p style={{ margin: 0 }}>Nothing here yet.</p>
        </div>
      ) : (
        messages.map((message) => (
          <article key={message.id}
                   className={`cp-message cp-message--${message.direction === 'outbound' ? 'out' : 'in'}`}>
            <p className="cp-message__meta">
              {message.direction === 'outbound'
                ? `From ${message.from ?? session.firmName}`
                : 'From you'}
              {' · '}
              {CHANNEL[message.channel] ?? message.channel}
              {' · '}
              {new Date(message.occurredAt).toLocaleDateString('en-GB',
                { day: 'numeric', month: 'long' })}
            </p>
            {message.subject && (
              <p style={{ margin: '0 0 var(--space-2)', fontWeight: 600 }}>{message.subject}</p>
            )}
            <p className="cp-message__body">{message.body}</p>
          </article>
        ))
      )}
    </ClientShell>
  );
}

// Dev-only: every email template rendered with sample data, as HTML and plain text.
// Routed only when import.meta.env.DEV (see App.tsx), so it is not in production builds.
// The rendering happens on the API (GET /api/dev/emails), from the same templates the app sends.

import React, { useEffect, useMemo, useState } from 'react';
import { buildApiUrl } from '../../lib/api';

interface EmailPreview {
  name: string;
  label: string;
  subject: string;
  html: string;
  text: string;
}

type View = 'html' | 'text';
type Width = 'desktop' | 'phone';

const WIDTHS: Record<Width, number> = { desktop: 680, phone: 375 };

const EmailPreviewPage: React.FC = () => {
  const [emails, setEmails] = useState<EmailPreview[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [view, setView] = useState<View>('html');
  const [width, setWidth] = useState<Width>('desktop');

  useEffect(() => {
    let cancelled = false;
    fetch(buildApiUrl('/dev/emails'))
      .then((res) => {
        if (!res.ok) throw new Error(`The API answered ${res.status}. Is it running in development?`);
        return res.json();
      })
      .then((body) => {
        if (cancelled) return;
        const list: EmailPreview[] = body?.data || [];
        setEmails(list);
        const fromHash = window.location.hash.replace('#', '');
        setSelected(list.some((e) => e.name === fromHash) ? fromHash : list[0]?.name || '');
      })
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, []);

  const current = useMemo(() => emails.find((e) => e.name === selected), [emails, selected]);

  const choose = (name: string) => {
    setSelected(name);
    window.history.replaceState(null, '', `#${name}`);
  };

  const toggle = (active: boolean) =>
    `px-3 py-1.5 rounded-full text-[13px] font-medium ${active ? 'bg-ui-ink text-white' : 'bg-white text-ui-text border border-ui-line'}`;

  return (
    <div className="min-h-screen bg-ui-canvas text-ui-text">
      <div className="max-w-6xl mx-auto px-4 py-6 sm:py-8">
        <header className="mb-5">
          <h1 className="text-[26px] sm:text-[30px] font-extrabold tracking-[-0.02em] text-ui-ink">Email previews</h1>
          <p className="text-[13px] text-ui-muted mt-1">
            Development only. Every template with sample data, as sent (HTML) and its plain-text version.
          </p>
        </header>

        {error && <p className="rounded-xl px-3 py-2 text-[13px] status-tint status-changes">{error}</p>}

        <div className="flex flex-col lg:flex-row gap-4">
          <nav aria-label="Templates" className="lg:w-64 shrink-0">
            <ul className="flex lg:flex-col gap-1.5 overflow-x-auto lg:overflow-visible pb-1">
              {emails.map((email) => (
                <li key={email.name} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => choose(email.name)}
                    aria-current={email.name === selected ? 'page' : undefined}
                    className={`w-full text-left px-3 py-2 rounded-xl text-[13px] whitespace-nowrap lg:whitespace-normal ${
                      email.name === selected ? 'bg-ui-ink text-white font-semibold' : 'bg-ui-card hover:bg-ui-card-hover text-ui-text'
                    }`}
                  >
                    {email.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <section className="flex-1 min-w-0">
            {current && (
              <>
                <div className="rounded-2xl bg-ui-card p-3 sm:p-4 mb-3">
                  <p className="text-[12px] text-ui-muted">Subject</p>
                  <p className="text-[15px] font-semibold text-ui-ink break-words">{current.subject}</p>
                  <p className="text-[12px] text-ui-muted mt-1">
                    Template: <code>{current.name}</code>
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <div className="flex gap-1.5" role="group" aria-label="Version">
                    <button type="button" className={toggle(view === 'html')} aria-pressed={view === 'html'} onClick={() => setView('html')}>
                      HTML
                    </button>
                    <button type="button" className={toggle(view === 'text')} aria-pressed={view === 'text'} onClick={() => setView('text')}>
                      Plain text
                    </button>
                  </div>
                  {view === 'html' && (
                    <div className="flex gap-1.5" role="group" aria-label="Width">
                      <button type="button" className={toggle(width === 'desktop')} aria-pressed={width === 'desktop'} onClick={() => setWidth('desktop')}>
                        Desktop
                      </button>
                      <button type="button" className={toggle(width === 'phone')} aria-pressed={width === 'phone'} onClick={() => setWidth('phone')}>
                        Phone
                      </button>
                    </div>
                  )}
                </div>

                {view === 'html' ? (
                  <div className="rounded-2xl bg-ui-canvas-deep p-2 sm:p-4 overflow-x-auto">
                    <iframe
                      title={`${current.label} (HTML)`}
                      srcDoc={current.html}
                      sandbox=""
                      className="block mx-auto bg-white rounded-lg border-0 max-w-full"
                      style={{ width: WIDTHS[width], height: 900 }}
                    />
                  </div>
                ) : (
                  <pre className="rounded-2xl bg-white p-4 text-[13px] leading-6 whitespace-pre-wrap break-words font-mono text-ui-text">
                    {current.text}
                  </pre>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
};

export default EmailPreviewPage;

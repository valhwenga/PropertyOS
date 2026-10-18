'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Icons } from './icons';

/**
 * A dialog for a form that would otherwise unbalance the page it sits on.
 *
 * The record-a-receipt form is the case this exists for: it belongs to the
 * page header's primary action, but a six-field form cannot live in a header,
 * and pushing it inline moves every record on the page down the moment anybody
 * clicks the button.
 *
 * Escape closes it and so does the backdrop; the close button is reachable by
 * keyboard. Focus moves to the panel on open and returns to whatever was
 * focused before on close, so a keyboard user is not dropped at the top of the
 * document. Deliberately not a focus TRAP: the form posts to a server action
 * and a half-built trap that fights the browser is worse than none.
 */
export function Modal({
  title, description, onClose, children, width = 'md',
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  width?: 'md' | 'lg';
}) {
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);

  useEffect(() => {
    returnTo.current = document.activeElement;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      if (returnTo.current instanceof HTMLElement) returnTo.current.focus();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-6">
      <div
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 bg-ink-900/40"
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`
          relative my-auto w-full ${width === 'lg' ? 'max-w-3xl' : 'max-w-xl'}
          rounded-[var(--radius-card)] border border-ink-100 bg-surface
          shadow-[var(--shadow-raised)] outline-none
        `}
      >
        <div className="flex items-start justify-between gap-4 border-b border-ink-100 px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="text-[length:var(--text-section)] font-semibold text-ink-900">
              {title}
            </h2>
            {description ? (
              <p className="mt-0.5 text-[length:var(--text-table)] text-ink-500">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="
              -mr-1 inline-flex size-8 shrink-0 items-center justify-center
              rounded-[var(--radius-control)] text-ink-500 hover:bg-ink-100 hover:text-ink-900
            "
          >
            <Icons.close className="size-5" />
            <span className="sr-only">Close</span>
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

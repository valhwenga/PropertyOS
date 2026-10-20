'use client';

import { useActionState, useEffect, useState } from 'react';
import { Button, ErrorState } from '@propertyos/ui';
import type { BrandAccent, BrandTypeface, Branding } from '@propertyos/domain';
import { prepareLogo } from '@/lib/fit-image';
import { removeLogoAction, saveAppearanceAction, uploadLogoAction } from './actions';

/**
 * Choosing the accent, the typeface and the logo.
 *
 * The accent and typeface preview themselves on this page as they are
 * selected, before anything is saved: the whole point of a colour is what it
 * looks like, and a radio button labelled "Clay" tells nobody that.
 *
 * The preview is applied to this form's own wrapper rather than to the
 * document, so a choice somebody thinks better of does not leave the rest of
 * the console repainted until they navigate away.
 */
export function AppearanceForm({
  org, branding, accents, typefaces,
}: {
  org: string;
  branding: Branding;
  accents: readonly BrandAccent[];
  typefaces: readonly BrandTypeface[];
}) {
  const [state, action, pending] = useActionState(saveAppearanceAction, null);
  const [accent, setAccent] = useState(branding.accent);
  const [typeface, setTypeface] = useState(branding.typeface);

  // A Server Action resets the form it was submitted from, to the DEFAULTS of
  // the current render — so the radios are uncontrolled and default to what
  // the server last said. The state is what paints the preview and the chosen
  // swatch before anything is saved.
  useEffect(() => { setAccent(branding.accent); }, [branding.accent]);
  useEffect(() => { setTypeface(branding.typeface); }, [branding.typeface]);

  return (
    <form
      action={action}
      data-brand={accent}
      data-typeface={typeface}
      className="space-y-5"
    >
      <input type="hidden" name="org" value={org} />
      {state && !state.ok ? (
        <ErrorState
          title="Not saved"
          detail={state.message ?? ''}
          correlationId={state.correlationId}
        />
      ) : null}

      <fieldset>
        <legend className="text-[length:var(--text-table)] font-medium text-ink-900">
          Accent colour
        </legend>
        <p className="mt-0.5 text-[length:var(--text-meta)] text-ink-500">
          Used for primary buttons, the selected section and links. Every colour here was
          checked for contrast; that is why this is a list rather than a colour picker.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {accents.map((option) => (
            <label
              key={option.key}
              className={`
                flex cursor-pointer items-center gap-3 rounded-[var(--radius-control)] border px-3 py-2
                ${accent === option.key
                  ? 'border-spike-500 bg-spike-50'
                  : 'border-ink-200 hover:bg-ink-50'}
              `}
            >
              <input
                type="radio"
                name="accent"
                value={option.key}
                defaultChecked={branding.accent === option.key}
                onChange={() => setAccent(option.key)}
                className="sr-only"
              />
              <span
                aria-hidden="true"
                className="size-6 shrink-0 rounded-full border border-ink-900/10"
                style={{ background: option.base }}
              />
              <span className="min-w-0">
                <span className="block text-[length:var(--text-table)] font-medium text-ink-900">
                  {option.label}
                </span>
                <span className="block text-[length:var(--text-meta)] text-ink-500">
                  {option.textContrastOnWhite.toFixed(1)}:1 as link text
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="text-[length:var(--text-table)] font-medium text-ink-900">
          Typeface
        </legend>
        <div className="mt-3 space-y-2">
          {typefaces.map((option) => (
            <label
              key={option.key}
              className={`
                flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-control)] border px-3 py-2
                ${typeface === option.key
                  ? 'border-spike-500 bg-spike-50'
                  : 'border-ink-200 hover:bg-ink-50'}
              `}
            >
              <input
                type="radio"
                name="typeface"
                value={option.key}
                defaultChecked={branding.typeface === option.key}
                onChange={() => setTypeface(option.key)}
                className="mt-1"
              />
              <span className="min-w-0">
                <span className="block text-[length:var(--text-table)] font-medium text-ink-900">
                  {option.label}
                </span>
                <span className="block text-[length:var(--text-meta)] text-ink-500">
                  {option.description}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {/* The preview, in the chosen colour and the chosen faces. */}
      <div className="rounded-[var(--radius-card)] border border-ink-100 bg-surface p-4">
        <p className="text-[length:var(--text-meta)] uppercase tracking-[0.08em] text-ink-400">
          Preview
        </p>
        <h3 className="mt-1 text-[length:var(--text-section)] font-semibold text-ink-900">
          Outstanding receivable
        </h3>
        <p className="tabular mt-1 text-[length:var(--text-metric)] font-bold text-ink-900">
          R18,450.00
        </p>
        <div className="mt-3 flex items-center gap-3">
          <span className="
            inline-flex items-center rounded-[var(--radius-control)] bg-spike-500 px-3 py-1.5
            text-[length:var(--text-table)] font-medium text-white
          ">
            Record money received
          </span>
          <span className="text-[length:var(--text-table)] font-medium text-spike-700">
            Full ageing →
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? 'Saving…' : 'Save appearance'}
        </Button>
        {state?.ok ? (
          <p className="text-[length:var(--text-meta)] font-medium text-positive-600">
            Saved. Everyone in this organisation sees it, and so do your residents.
          </p>
        ) : null}
      </div>
    </form>
  );
}

/**
 * The logo, uploaded and removed.
 *
 * Its own form, deliberately: a file upload and a pair of radio groups have
 * different failure modes, and a rejected PNG should not discard a colour
 * somebody just chose.
 */
export function LogoForm({ org, branding }: { org: string; branding: Branding }) {
  const [uploadState, upload, uploading] = useActionState(uploadLogoAction, null);
  const [removeState, remove, removing] = useActionState(removeLogoAction, null);
  // What the browser did to the chosen file, said plainly. Null where it did
  // nothing, which is the common case for a file that already fitted.
  const [fitted, setFitted] = useState<string | null>(null);
  const [fitting, setFitting] = useState(false);

  const problem = (uploadState && !uploadState.ok && uploadState)
    || (removeState && !removeState.ok && removeState) || null;

  /**
   * Scales the chosen picture to fit before it is ever sent.
   *
   * The file input's own list is replaced with the fitted file, so the form
   * still posts one file under one name and the server action is unchanged.
   * If any of this fails — an undecodable file, a browser without
   * DataTransfer — the original file stays in the input and the server
   * answers as it always did. Nothing here decides what is allowed.
   */
  const onChoose = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const chosen = input.files?.[0];
    setFitted(null);
    if (!chosen) return;

    setFitting(true);
    try {
      const prepared = await prepareLogo(chosen);
      if (prepared.file !== chosen && typeof DataTransfer !== 'undefined') {
        const carrier = new DataTransfer();
        carrier.items.add(prepared.file);
        input.files = carrier.files;
      }
      setFitted(prepared.note);
    } catch {
      // Keep the original; the server will say what is wrong with it.
    } finally {
      setFitting(false);
    }
  };

  return (
    <div className="space-y-4">
      {problem ? (
        <ErrorState
          title="Not saved"
          detail={problem.message ?? ''}
          correlationId={problem.correlationId}
        />
      ) : null}

      {branding.hasLogo ? (
        <div className="flex flex-wrap items-center gap-4">
          <div className="rounded-[var(--radius-control)] border border-ink-200 bg-surface p-3">
            <img
              src={`/app/${org}/brand-logo?v=${branding.logoVersion ?? 'current'}`}
              alt="Your logo as it appears in the sidebar"
              className="h-10 w-auto max-w-[12rem] object-contain"
            />
          </div>
          <p className="text-[length:var(--text-meta)] text-ink-500">
            {branding.logoWidth}×{branding.logoHeight} pixels
            {branding.logoFilename ? ` · ${branding.logoFilename}` : ''}
          </p>
          <form action={remove}>
            <input type="hidden" name="org" value={org} />
            <Button type="submit" variant="secondary" disabled={removing}>
              {removing ? 'Removing…' : 'Remove logo'}
            </Button>
          </form>
        </div>
      ) : (
        <p className="text-[length:var(--text-table)] text-ink-500">
          No logo yet. Until one is uploaded, the Spike wordmark stands in.
        </p>
      )}

      <form action={upload} className="space-y-2">
        <input type="hidden" name="org" value={org} />
        <label
          htmlFor="logo"
          className="block text-[length:var(--text-table)] font-medium text-ink-700"
        >
          {branding.hasLogo ? 'Replace it' : 'Upload a logo'}
        </label>
        <input
          id="logo"
          name="logo"
          type="file"
          accept="image/png,image/jpeg"
          onChange={onChoose}
          className="
            block w-full rounded-[var(--radius-control)] border border-ink-200 bg-surface
            px-3 py-2 text-[length:var(--text-table)] text-ink-700
          "
        />
        <p className="text-[length:var(--text-meta)] text-ink-500">
          Any size. A large picture is scaled down here, in your browser, to fit 1024 pixels on
          its longest side, keeping its proportions exactly. PNG or JPEG: SVG is not accepted,
          because an SVG can carry script and this file is shown to your residents.
        </p>
        {fitting ? (
          <p className="text-[length:var(--text-meta)] text-ink-500">Fitting the picture…</p>
        ) : null}
        {fitted ? (
          <p className="text-[length:var(--text-meta)] text-ink-700">{fitted}</p>
        ) : null}
        {/* Deliberately not disabled until a file is chosen: the server says
            "Choose a file first" in words, and a button that is inert for
            reasons a reader cannot see is worse than one that answers. */}
        <Button type="submit" variant="secondary" disabled={uploading}>
          {uploading ? 'Checking the file…' : 'Upload'}
        </Button>
        {uploadState?.ok ? (
          <p className="text-[length:var(--text-meta)] font-medium text-positive-600">
            Saved. It is already in the sidebar, and on statements from now on.
          </p>
        ) : null}
      </form>
    </div>
  );
}

'use client';

import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { useBranding } from '@/lib/theme/BrandingProvider';
import { cn } from '@/lib/utils';

export interface AuthStep {
  title: string;
  hint: string;
}

function Logo({ size = 'md' }: { size?: 'md' | 'lg' }) {
  const { branding } = useBranding();
  const box = size === 'lg' ? 'size-12 text-lg rounded-2xl' : 'size-10 text-sm rounded-xl';
  return branding.logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={branding.logoUrl} alt="" className={cn(box, 'object-contain')} />
  ) : (
    <span aria-hidden="true" className={cn(box, 'grid shrink-0 place-items-center bg-brand font-heading font-bold text-on-brand shadow-raised')}>
      {branding.logoText.slice(0, 2)}
    </span>
  );
}

/**
 * Split layout for sign-in and onboarding. Desktop: a brand panel (product
 * story or step progress) beside the form. Phones: a compact branded header.
 * Brand colors only through the --brand-* variables.
 */
export function AuthShell({
  panelTitle,
  panelBody,
  points,
  steps,
  current,
  footnote,
  mobileHeader,
  children,
  footer,
}: {
  panelTitle: string;
  panelBody?: string;
  points?: { icon: ReactNode; title: string; body: string }[];
  steps?: AuthStep[];
  current?: number;
  footnote?: ReactNode;
  mobileHeader?: ReactNode;
  children: ReactNode;
  /** Sticky action bar under the content (onboarding). */
  footer?: ReactNode;
}) {
  const { branding } = useBranding();

  return (
    <div className="min-h-dvh bg-background lg:grid lg:grid-cols-[minmax(380px,40%)_1fr]">
      {/* Brand panel (desktop) */}
      <aside className="relative hidden overflow-hidden bg-brand-ink text-white lg:flex lg:flex-col lg:justify-between lg:p-12 xl:p-14">
        {/* Depth: soft light and shade layered on the brand color. */}
        {/* Deep brand shade keeps white text legible for any partner color; the brand color glows on top. */}
        <div aria-hidden="true" className="pointer-events-none absolute -start-40 -top-40 size-[34rem] rounded-full bg-brand opacity-70 blur-[120px]" />
        <div aria-hidden="true" className="pointer-events-none absolute -bottom-52 -end-40 size-[30rem] rounded-full bg-brand opacity-50 blur-[120px]" />
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-[radial-gradient(rgb(255_255_255/0.08)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:linear-gradient(to_bottom,black,transparent_75%)]" />
        <div aria-hidden="true" className="pointer-events-none absolute -end-24 top-1/3 size-80 rounded-full border border-current opacity-10" />
        <div aria-hidden="true" className="pointer-events-none absolute -end-10 top-[42%] size-48 rounded-full border border-current opacity-10" />

        <div className="relative flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-white/15 font-heading text-base font-bold ring-1 ring-white/25 backdrop-blur">
            {branding.logoText.slice(0, 2)}
          </span>
          <span className="font-heading text-lg font-semibold tracking-tight">{branding.appName}</span>
        </div>

        <div className="relative max-w-md">
          <h2 className="font-heading text-[34px] leading-[1.15] font-bold tracking-tight xl:text-[40px]">{panelTitle}</h2>
          {panelBody && <p className="mt-4 text-base leading-relaxed opacity-85">{panelBody}</p>}

          {points && (
            <ul className="stagger mt-10 space-y-6">
              {points.map((p) => (
                <li key={p.title} className="flex gap-4">
                  <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-white/15 ring-1 ring-white/20" aria-hidden="true">
                    {p.icon}
                  </span>
                  <span>
                    <span className="block font-semibold">{p.title}</span>
                    <span className="mt-0.5 block text-sm leading-relaxed opacity-80">{p.body}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}

          {steps && (
            <ol className="mt-10 space-y-1">
              {steps.map((s, i) => {
                const n = i + 1;
                const done = current !== undefined && n < current;
                const active = n === current;
                return (
                  <li key={s.title} className="relative flex gap-4 pb-6 last:pb-0">
                    {i < steps.length - 1 && (
                      <span aria-hidden="true" className={cn('absolute start-[21px] top-12 h-[calc(100%-3.25rem)] w-0.5 rounded-full', done ? 'bg-white/70' : 'bg-white/20')} />
                    )}
                    <span
                      aria-hidden="true"
                      className={cn(
                        'grid size-11 shrink-0 place-items-center rounded-full font-heading text-sm font-bold transition-all duration-300',
                        done && 'bg-white text-brand-ink',
                        active && 'bg-white text-brand-ink shadow-raised ring-4 ring-white/20',
                        !done && !active && 'bg-white/10 ring-1 ring-white/30',
                      )}
                    >
                      {done ? <Check className="size-5" /> : n}
                    </span>
                    <span className={cn('pt-1.5 transition-opacity', !active && !done && 'opacity-70')}>
                      <span className="block font-semibold">{s.title}</span>
                      <span className="mt-0.5 block text-sm opacity-80">{s.hint}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        <div className="relative text-sm opacity-75">{footnote}</div>
      </aside>

      {/* Content */}
      <div className="flex min-h-dvh flex-col">
        <header className="flex items-center gap-3 border-b bg-card/90 px-4 py-3 backdrop-blur lg:hidden">
          <Logo />
          <div className="min-w-0 flex-1">{mobileHeader ?? <p className="truncate font-heading font-semibold">{branding.appName}</p>}</div>
        </header>
        <main className="flex flex-1 flex-col">
          <div className="mx-auto flex w-full max-w-[44rem] flex-1 flex-col px-5 py-6 sm:px-8 lg:justify-center lg:py-8">{children}</div>
        </main>
        {footer && (
          <div className="sticky bottom-0 z-10 border-t bg-card/95 backdrop-blur pb-safe">
            <div className="mx-auto flex w-full max-w-[44rem] items-center gap-3 px-5 py-4 sm:px-8">{footer}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export { Logo as AuthLogo };

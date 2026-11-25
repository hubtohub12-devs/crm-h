'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { MailCheck } from 'lucide-react';
import { AuthPage, FormMessage } from '@/components/layout/AuthPage';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { resendVerification, verifyEmailCode, type VerifyResult } from '@/lib/api/endpoints/auth';
import { isApiError } from '@/lib/api/client';

/** Supabase allows one confirmation email a minute: count down instead of erroring. */
const COOLDOWN = 60;

/**
 * "Enter the code we emailed you": confirms a new account and signs the
 * person in. Used right after sign-up (a code was just sent) and from sign-in
 * when the account isn't confirmed yet.
 */
export function VerifyEmailCode({
  email,
  justSent,
  onVerified,
  onBack,
}: {
  email: string;
  justSent: boolean;
  onVerified: (s: VerifyResult) => void;
  /** Already on the sign-in page: go back to its form instead of linking to it. */
  onBack?: () => void;
}) {
  const t = useTranslations('auth');
  const [code, setCode] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [cooldown, setCooldown] = useState(justSent ? COOLDOWN : 0);

  const verify = useMutation({ mutationFn: () => verifyEmailCode(email, code.trim()), meta: { silent: true }, onSuccess: onVerified });
  const resend = useMutation({
    mutationFn: () => resendVerification(email),
    meta: { silent: true },
    onSettled: () => setCooldown(COOLDOWN),
    onSuccess: () => verify.reset(),
  });

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  const valid = /^\d{6,10}$/.test(code.trim());
  const codeError = submitted && !valid ? t('codeRequired') : null;
  const verifyError = verify.error
    ? isApiError(verify.error) && verify.error.code === 'rate_limited' ? t('tooMany') : (verify.error as Error).message
    : null;

  return (
    <AuthPage title={t('checkInboxTitle')}>
      <div className="space-y-5">
        <div className="flex items-start gap-4">
          <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-brand-surface text-brand-ink">
            <MailCheck className="size-6" aria-hidden="true" />
          </div>
          <p className="text-base text-gray-700">{t('checkInbox', { email })}</p>
        </div>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(ev) => {
            ev.preventDefault();
            setSubmitted(true);
            if (valid) verify.mutate();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="code">{t('codeLabel')}</Label>
            <Input
              id="code"
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={10}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              aria-invalid={!!codeError || undefined}
              aria-describedby={codeError ? 'code-error' : undefined}
              className="h-14 text-center font-heading text-2xl font-semibold tracking-[0.4em] tabular-nums"
            />
            {codeError && <p id="code-error" className="text-sm text-red-700">{codeError}</p>}
          </div>
          {verifyError && <FormMessage>{verifyError}</FormMessage>}
          {resend.isSuccess && !verifyError && <FormMessage tone="ok">{t('resent')}</FormMessage>}
          {resend.error && !(isApiError(resend.error) && resend.error.code === 'rate_limited') && <FormMessage>{(resend.error as Error).message}</FormMessage>}
          <Button type="submit" className="h-12 w-full text-base" disabled={verify.isPending || verify.isSuccess}>
            {verify.isPending || verify.isSuccess ? t('confirming') : t('confirmEmail')}
          </Button>
          <Button type="button" variant="outline" className="h-12 w-full tabular-nums" disabled={resend.isPending || cooldown > 0} onClick={() => resend.mutate()}>
            {resend.isPending ? t('sending') : cooldown > 0 ? t('resendIn', { seconds: cooldown }) : t('resendCode')}
          </Button>
        </form>
        <p className="text-sm text-gray-600">{t('checkSpam')}</p>
        {onBack ? (
          <button type="button" onClick={onBack} className="flex min-h-11 w-full items-center justify-center text-sm font-semibold text-brand-ink hover:underline">
            {t('backToSignIn')}
          </button>
        ) : (
          <Link href="/login" className="flex min-h-11 items-center justify-center text-sm font-semibold text-brand-ink hover:underline">
            {t('backToSignIn')}
          </Link>
        )}
      </div>
    </AuthPage>
  );
}

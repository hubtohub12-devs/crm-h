'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { AuthPage, FormMessage } from '@/components/layout/AuthPage';
import { VerifyEmailCode } from '@/components/layout/VerifyEmailCode';
import { PasswordInput } from '@/components/crm/PasswordInput';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { signInWithPassword } from '@/lib/api/endpoints/auth';
import { isApiError } from '@/lib/api/client';
import { useSession } from '@/lib/auth/SessionProvider';
import { EMAIL_RE, safeNext } from '@/lib/auth/safe-next';
import { useBranding } from '@/lib/theme/BrandingProvider';

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  );
}

function Login() {
  const t = useTranslations('auth');
  const { branding } = useBranding();
  const { session, hydrated, signIn } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const next = safeNext(params.get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    if (hydrated && session) router.replace(next);
  }, [hydrated, session, router, next]);

  const login = useMutation({
    mutationFn: () => signInWithPassword(email.trim(), password),
    meta: { silent: true },
    onSuccess: (r) => {
      signIn(r);
      router.replace(next);
    },
  });

  const emailError = submitted && !EMAIL_RE.test(email.trim()) ? t('invalidEmail') : null;
  const code = isApiError(login.error) ? login.error.code : null;
  const loginError = login.error
    ? code === 'email_not_confirmed' ? t('notConfirmed') : code === 'rate_limited' ? t('tooMany') : (login.error as Error).message
    : null;

  if (verifying) {
    return (
      <VerifyEmailCode
        email={email.trim()}
        justSent={false}
        onBack={() => setVerifying(false)}
        onVerified={(s) => {
          signIn(s);
          router.replace(next);
        }}
      />
    );
  }

  return (
    <AuthPage title={t('welcome', { app: branding.appName })} subtitle={t('subtitle')}>
      <form
        noValidate
        className="space-y-4"
        onSubmit={(ev) => {
          ev.preventDefault();
          setSubmitted(true);
          if (EMAIL_RE.test(email.trim()) && password) login.mutate();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="email">{t('emailLabel')}</Label>
          <Input id="email" type="email" autoComplete="email" inputMode="email" autoFocus placeholder={t('emailPlaceholder')}
            value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={!!emailError || undefined}
            aria-describedby={emailError ? 'email-error' : undefined} className="h-12" />
          {emailError && <p id="email-error" className="text-sm text-red-700">{emailError}</p>}
        </div>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="password">{t('passwordLabel')}</Label>
            <Link href={`/forgot-password${email ? `?email=${encodeURIComponent(email.trim())}` : ''}`} className="inline-flex min-h-11 items-center text-sm font-medium text-brand-ink hover:underline">
              {t('forgot')}
            </Link>
          </div>
          <PasswordInput id="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {loginError && (
          <FormMessage>
            {loginError}
            {code === 'email_not_confirmed' && (
              <button type="button" onClick={() => setVerifying(true)} className="ms-1 min-h-11 font-semibold underline">
                {t('enterCode')}
              </button>
            )}
          </FormMessage>
        )}
        <Button type="submit" className="h-12 w-full text-base" disabled={login.isPending}>
          {login.isPending ? t('signingIn') : t('signIn')}
        </Button>
        <p className="text-center text-sm text-gray-600">
          {t('noAccount')}{' '}
          <Link href={`/signup${params.get('next') ? `?next=${encodeURIComponent(next)}` : ''}`} className="inline-flex min-h-11 items-center font-semibold text-brand-ink hover:underline">
            {t('createAccount')}
          </Link>
        </p>
        {process.env.NEXT_PUBLIC_API_MOCKING === 'all' && <p className="rounded-md bg-gray-100 px-3 py-2 text-center text-xs text-gray-700">{t('demoHint')}</p>}
      </form>
    </AuthPage>
  );
}

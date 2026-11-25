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
import { signUpWithPassword } from '@/lib/api/endpoints/auth';
import { isApiError } from '@/lib/api/client';
import { useSession } from '@/lib/auth/SessionProvider';
import { EMAIL_RE, safeNext } from '@/lib/auth/safe-next';

export default function SignupPage() {
  return (
    <Suspense>
      <Signup />
    </Suspense>
  );
}

function Signup() {
  const t = useTranslations('auth');
  const { session, hydrated, signIn } = useSession();
  const router = useRouter();
  const next = safeNext(useSearchParams().get('next'));
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  useEffect(() => {
    if (hydrated && session) router.replace(next);
  }, [hydrated, session, router, next]);

  const signup = useMutation({
    mutationFn: () => signUpWithPassword({ name: name.trim(), email: email.trim(), password }),
    meta: { silent: true },
    onSuccess: (r) => {
      if (r.status === 'signed_in') {
        signIn(r.session);
        router.replace(next);
      } else {
        setSentTo(r.email);
      }
    },
  });

  const errors = {
    name: submitted && !name.trim() ? t('nameRequired') : null,
    email: submitted && !EMAIL_RE.test(email.trim()) ? t('invalidEmail') : null,
    password: submitted && password.length < 8 ? t('passwordTooShort') : null,
  };
  const serverError = signup.error ? (isApiError(signup.error) && signup.error.code === 'rate_limited' ? t('tooMany') : (signup.error as Error).message) : null;

  if (sentTo) {
    return (
      <VerifyEmailCode
        email={sentTo}
        justSent
        onVerified={(s) => {
          signIn(s);
          router.replace(next);
        }}
      />
    );
  }

  return (
    <AuthPage title={t('signupTitle')} subtitle={t('signupSubtitle')}>
      <form
        noValidate
        className="space-y-4"
        onSubmit={(ev) => {
          ev.preventDefault();
          setSubmitted(true);
          if (name.trim() && EMAIL_RE.test(email.trim()) && password.length >= 8) signup.mutate();
        }}
      >
        <Field id="name" label={t('nameLabel')} error={errors.name}>
          <Input id="name" autoComplete="name" autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!errors.name || undefined} className="h-12" />
        </Field>
        <Field id="email" label={t('emailLabel')} error={errors.email}>
          <Input id="email" type="email" inputMode="email" autoComplete="email" placeholder={t('emailPlaceholder')} value={email}
            onChange={(e) => setEmail(e.target.value)} aria-invalid={!!errors.email || undefined} className="h-12" />
        </Field>
        <Field id="password" label={t('passwordLabel')} error={errors.password} hint={t('passwordHint')}>
          <PasswordInput id="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={!!errors.password || undefined} />
        </Field>
        {serverError && <FormMessage>{serverError}</FormMessage>}
        <Button type="submit" className="h-12 w-full text-base" disabled={signup.isPending}>
          {signup.isPending ? t('signingUp') : t('signUp')}
        </Button>
        <p className="text-center text-xs text-gray-600">{t('terms')}</p>
        <p className="text-center text-sm text-gray-600">
          {t('haveAccount')}{' '}
          <Link href="/login" className="inline-flex min-h-11 items-center font-semibold text-brand-ink hover:underline">{t('signIn')}</Link>
        </p>
      </form>
    </AuthPage>
  );
}

function Field({ id, label, error, hint, children }: { id: string; label: string; error: string | null; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {(error || hint) && <p className={error ? 'text-sm text-red-700' : 'text-sm text-gray-600'}>{error ?? hint}</p>}
    </div>
  );
}

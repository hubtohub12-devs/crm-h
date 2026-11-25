'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, Briefcase, Building2, Check, ChevronRight, Gavel, Home as HomeIcon, ListChecks, Plus, Stethoscope, Trash2, Truck, User, Users, Workflow } from 'lucide-react';
import { AuthShell } from '@/components/layout/AuthShell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useTemplates } from '@/hooks/queries/admin';
import { useSession } from '@/lib/auth/SessionProvider';
import { useBranding } from '@/lib/theme/BrandingProvider';
import { createWorkspace } from '@/lib/api/endpoints/admin';
import { invite } from '@/lib/api/endpoints/crm';
import { regionFromCountry, type RegionSettings } from '@/lib/format';
import { isCountryCode } from '@/lib/phone';
import type { WorkspaceRole } from '@/lib/api/types';
import { RegionFields } from '@/components/crm/RegionFields';
import { PhoneInput, toPhoneValue, type PhoneValue } from '@/components/crm/PhoneInput';
import { BootSplash } from '@/components/providers/AppProviders';
import { ErrorState } from '@/components/crm/states';
import { cn } from '@/lib/utils';

const ICONS: Record<string, typeof HomeIcon> = { real_estate: HomeIcon, law: Gavel, distributor: Truck, clinic: Stethoscope, agency: Briefcase, general: Building2 };
const ORDER = ['real_estate', 'law', 'distributor', 'clinic', 'agency', 'general'];

interface InviteRow {
  name: string;
  phone: PhoneValue;
  role: WorkspaceRole;
}

function guessCountry(): string {
  const region = typeof navigator !== 'undefined' ? navigator.language.split('-')[1] : undefined;
  return isCountryCode(region) ? region.toUpperCase() : 'US';
}

export default function OnboardingPage() {
  const t = useTranslations('onboarding');
  const c = useTranslations('common');
  const r = useTranslations('roles');
  const { session, hydrated, me, switchWorkspace } = useSession();
  const { branding } = useBranding();
  const router = useRouter();
  const qc = useQueryClient();
  const templates = useTemplates();

  const [step, setStep] = useState(1);
  const [templateKey, setTemplateKey] = useState('real_estate');
  const [name, setName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [region, setRegion] = useState<RegionSettings>(() => regionFromCountry('US'));
  const [mode, setMode] = useState<'solo' | 'team'>('solo');
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [nameError, setNameError] = useState(false);

  useEffect(() => setRegion(regionFromCountry(guessCountry())), []);
  useEffect(() => {
    if (hydrated && !session) router.replace('/login');
  }, [hydrated, session, router]);
  useEffect(() => {
    if (me?.user.name) setOwnerName((n) => n || me.user.name);
  }, [me?.user.name]);

  const create = useMutation({
    mutationFn: async () => {
      const ws = await createWorkspace({ name: name.trim(), template_key: templateKey, region, seed_samples: false, owner_name: ownerName || undefined });
      let sent = 0;
      for (const row of invites) {
        if (!row.name.trim() || !row.phone.e164) continue;
        await invite({ name: row.name.trim(), phone: row.phone.e164, role: row.role }).catch(() => null);
        sent++;
      }
      return { ws, sent };
    },
    onSuccess: ({ ws, sent }) => {
      qc.clear();
      switchWorkspace(ws.id);
      if (sent) toast.success(t('invitesSent', { count: sent }));
      router.replace('/home?samples=1');
    },
  });

  if (!hydrated || !session) return <BootSplash />;

  const sorted = [...(templates.data ?? [])].sort((a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key));
  const selected = sorted.find((x) => x.key === templateKey);
  const total = 3;

  const steps = [
    { title: t('stepBusiness'), hint: t('stepBusinessHint') },
    { title: t('stepRegion'), hint: t('stepRegionHint') },
    { title: t('stepTeam'), hint: t('stepTeamHint') },
  ];
  const next = () => {
    if (step === 2 && !name.trim()) {
      setNameError(true);
      return;
    }
    setStep((x) => x + 1);
  };

  return (
    <AuthShell
      panelTitle={t('panelTitle')}
      panelBody={t('panelBody')}
      steps={steps}
      current={step}
      footnote={branding.tagline}
      mobileHeader={
        <div>
          <p className="truncate font-heading text-sm font-semibold">{t('title')}</p>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={step} aria-label={t('step', { current: step, total })}>
              <div className="h-full rounded-full bg-brand transition-all duration-500 ease-out" style={{ width: `${(step / total) * 100}%` }} />
            </div>
            <span className="text-xs font-medium text-gray-600 tabular-nums">{t('step', { current: step, total })}</span>
          </div>
        </div>
      }
      footer={
        <>
          {step > 1 ? (
            <Button variant="ghost" className="h-12 px-5" onClick={() => setStep((x) => x - 1)}>
              <ArrowLeft className="size-4 rtl:rotate-180" aria-hidden="true" />
              {c('back')}
            </Button>
          ) : (
            <span className="hidden text-sm text-gray-500 sm:block">{t('step', { current: step, total })}</span>
          )}
          <div className="flex-1" />
          {step < total ? (
            <Button className="h-12 min-w-40 px-8 text-base max-sm:flex-1" disabled={step === 1 && !selected} onClick={next}>
              {c('next')}
              <ArrowRight className="size-4 rtl:rotate-180" aria-hidden="true" />
            </Button>
          ) : (
            <Button className="h-12 min-w-48 px-8 text-base max-sm:flex-1" onClick={() => create.mutate()} disabled={create.isPending}>
              {create.isPending ? t('creating') : t('create')}
              {!create.isPending && <Check className="size-4" aria-hidden="true" />}
            </Button>
          )}
        </>
      }
    >
      <p className="hidden text-sm font-semibold tracking-wide text-brand-ink uppercase lg:block">{t('step', { current: step, total })}</p>

      {step === 1 && (
        <section key="s1" className="animate-rise mt-2 space-y-5">
          <div>
            <h1 className="font-heading text-[26px] font-bold tracking-tight text-gray-900 sm:text-[32px]">{t('businessTitle')}</h1>
            <p className="mt-1.5 text-base text-gray-600">{t('businessHint')}</p>
          </div>
          {templates.isError ? (
            <ErrorState onRetry={() => templates.refetch()} />
          ) : templates.isLoading ? (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="h-[76px] animate-pulse rounded-2xl bg-card shadow-card sm:h-[118px]" />
              ))}
            </div>
          ) : (
            <div role="radiogroup" aria-label={t('businessTitle')} className="stagger grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3">
              {sorted.map((tpl) => {
                const Icon = ICONS[tpl.key] ?? Building2;
                const active = tpl.key === templateKey;
                return (
                  <button
                    key={tpl.key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-describedby={`tpl-${tpl.key}-desc`}
                    onClick={() => setTemplateKey(tpl.key)}
                    className={cn(
                      'lift press relative flex min-h-[76px] flex-col items-start gap-2 rounded-2xl border bg-card p-3 text-start shadow-card outline-none sm:p-3.5',
                      active ? 'border-transparent ring-2 ring-brand' : 'hover:border-gray-300',
                    )}
                  >
                    <span
                      className={cn('grid size-9 shrink-0 place-items-center rounded-xl transition-colors duration-300 sm:size-10', active ? 'bg-brand text-on-brand shadow-raised' : 'bg-brand-surface text-brand-ink')}
                      aria-hidden="true"
                    >
                      <Icon className="size-5" />
                    </span>
                    <span className="min-w-0 pe-5">
                      <span className="block font-heading text-sm leading-tight font-semibold text-gray-900 sm:text-[15px]">{tpl.name}</span>
                      <span id={`tpl-${tpl.key}-desc`} className="mt-0.5 line-clamp-2 hidden text-xs leading-snug text-gray-600 sm:block">{tpl.description}</span>
                    </span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        'absolute end-2.5 top-2.5 grid size-5 place-items-center rounded-full border-2 transition-all duration-200',
                        active ? 'scale-100 border-brand bg-brand text-on-brand' : 'border-gray-300 bg-card',
                      )}
                    >
                      {active && <Check className="size-3" strokeWidth={3} />}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {selected && (
            <div key={selected.key} className="animate-rise space-y-3 rounded-2xl border bg-card p-4 shadow-card">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
                <ListChecks className="size-4 text-brand-ink" aria-hidden="true" />
                {t('willCreate')}
              </p>
              {selected.pipelines.map((p) => (
                <div key={p.name} className="flex flex-wrap items-center gap-1">
                  <Workflow className="me-1 size-3.5 text-gray-500" aria-hidden="true" />
                  <span className="sr-only">{t('stages')}</span>
                  {p.stages.map((st, i) => (
                    <span key={st.name} className="flex items-center gap-1">
                      <span
                        className={cn(
                          'rounded-full px-2.5 py-0.5 text-xs font-semibold',
                          st.kind === 'won' ? 'bg-green-50 text-green-800' : st.kind === 'lost' ? 'bg-gray-100 text-gray-600' : 'bg-brand-surface text-brand-ink',
                        )}
                      >
                        {st.name}
                      </span>
                      {i < p.stages.length - 1 && <ChevronRight className="size-3 text-gray-300 rtl:rotate-180" aria-hidden="true" />}
                    </span>
                  ))}
                </div>
              ))}
              {selected.custom_fields.length > 0 && (
                <p className="truncate text-xs text-gray-600">
                  <span className="font-semibold tracking-wide text-gray-500 uppercase">{t('fields')}</span>
                  {' · '}
                  {selected.custom_fields.map((fd) => fd.label).join(', ')}
                </p>
              )}
            </div>
          )}
        </section>
      )}

      {step === 2 && (
        <section key="s2" className="animate-rise mt-2 space-y-7">
          <div>
            <h1 className="font-heading text-[26px] font-bold tracking-tight text-gray-900 sm:text-[32px]">{t('regionTitle')}</h1>
            <p className="mt-2 text-base text-gray-600">{t('regionHint')}</p>
          </div>
          <div className="space-y-6 rounded-2xl border bg-card p-5 shadow-card sm:p-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ws-name">{t('workspaceName')}</Label>
                <Input
                  id="ws-name"
                  autoFocus
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameError(false);
                  }}
                  placeholder={t('workspaceNamePlaceholder')}
                  aria-invalid={nameError || undefined}
                  aria-describedby={nameError ? 'ws-name-err' : undefined}
                  className="h-12"
                />
                {nameError && <p id="ws-name-err" className="text-sm text-red-700">{t('nameRequired')}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="owner-name">{t('yourName')}</Label>
                <Input id="owner-name" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} autoComplete="name" className="h-12" />
              </div>
            </div>
            <div className="border-t pt-6">
              <RegionFields value={region} onChange={setRegion} idPrefix="onb" />
            </div>
          </div>
        </section>
      )}

      {step === 3 && (
        <section key="s3" className="animate-rise mt-2 space-y-7">
          <h1 className="font-heading text-[26px] font-bold tracking-tight text-gray-900 sm:text-[32px]">{t('teamTitle')}</h1>
          <div role="radiogroup" aria-label={t('teamTitle')} className="stagger grid gap-3 sm:grid-cols-2">
            {(['solo', 'team'] as const).map((m) => {
              const Icon = m === 'solo' ? User : Users;
              const active = mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    setMode(m);
                    if (m === 'team' && !invites.length) setInvites([{ name: '', phone: toPhoneValue('', region.default_phone_country), role: 'agent' }]);
                  }}
                  className={cn(
                    'lift press relative flex items-start gap-4 rounded-2xl border bg-card p-5 text-start shadow-card',
                    active ? 'border-transparent ring-2 ring-brand' : 'hover:border-gray-300',
                  )}
                >
                  <span className={cn('grid size-12 shrink-0 place-items-center rounded-2xl transition-colors duration-300', active ? 'bg-brand text-on-brand shadow-raised' : 'bg-brand-surface text-brand-ink')} aria-hidden="true">
                    <Icon className="size-6" />
                  </span>
                  <span className="pe-6">
                    <span className="block font-heading text-[15px] font-semibold">{m === 'solo' ? t('solo') : t('team')}</span>
                    <span className="mt-0.5 block text-sm text-gray-600">{m === 'solo' ? t('soloHint') : t('teamHint')}</span>
                  </span>
                  <span aria-hidden="true" className={cn('absolute end-3 top-3 grid size-6 place-items-center rounded-full border-2 transition-all', active ? 'border-brand bg-brand text-on-brand' : 'border-gray-300')}>
                    {active && <Check className="size-3.5" strokeWidth={3} />}
                  </span>
                </button>
              );
            })}
          </div>
          {mode === 'team' && (
            <div className="space-y-3">
              {invites.map((row, i) => (
                <div key={i} className="animate-rise space-y-4 rounded-2xl border bg-card p-5 shadow-card">
                  <div className="flex gap-3">
                    <div className="flex-1 space-y-1.5">
                      <Label htmlFor={`inv-name-${i}`}>{t('inviteName')}</Label>
                      <Input id={`inv-name-${i}`} value={row.name} onChange={(e) => setInvites((rows) => rows.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} className="h-11" />
                    </div>
                    <div className="w-36 space-y-1.5">
                      <Label htmlFor={`inv-role-${i}`}>{t('inviteRole')}</Label>
                      <Select value={row.role} onValueChange={(role) => setInvites((rows) => rows.map((x, k) => (k === i ? { ...x, role: role as WorkspaceRole } : x)))}>
                        <SelectTrigger id={`inv-role-${i}`} className="h-11 w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="agent">{r('agent')}</SelectItem>
                          <SelectItem value="manager">{r('manager')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="flex items-end gap-3">
                    <div className="flex-1 space-y-1.5">
                      <Label htmlFor={`inv-phone-${i}`}>{t('invitePhone')}</Label>
                      <PhoneInput id={`inv-phone-${i}`} value={row.phone} onChange={(phone) => setInvites((rows) => rows.map((x, k) => (k === i ? { ...x, phone } : x)))} />
                    </div>
                    <button type="button" aria-label={t('removeInvite')} onClick={() => setInvites((rows) => rows.filter((_, k) => k !== i))} className="press grid size-11 place-items-center rounded-full border text-gray-600 hover:bg-red-50 hover:text-red-700">
                      <Trash2 className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>
              ))}
              <Button type="button" variant="tonal" className="h-11" onClick={() => setInvites((rows) => [...rows, { name: '', phone: toPhoneValue('', region.default_phone_country), role: 'agent' }])}>
                <Plus className="size-4" aria-hidden="true" />
                {t('addInvite')}
              </Button>
            </div>
          )}
          {create.isError && <ErrorState body={(create.error as Error).message} />}
        </section>
      )}
    </AuthShell>
  );
}

import { api, API_BASE } from '../client';
import { adaptMembership, adaptResolvedBranding, adaptUser, adaptWorkspace, type Raw } from '../adapters';
import type { Me, ResolvedBranding, Role } from '../types';

export interface VerifyResult {
  access_token: string;
  refresh_token: string | null;
  expires_at: number | null;
  user_id: string;
  memberships: ReturnType<typeof adaptMembership>[];
}

function toSession(r: Raw): VerifyResult {
  return {
    access_token: r.access_token,
    refresh_token: r.refresh_token ?? null,
    expires_at: r.expires_at ? Number(r.expires_at) * 1000 : null,
    user_id: r.user.id,
    memberships: (r.memberships ?? []).map(adaptMembership),
  };
}

const PUBLIC = { anonymous: true, workspaceId: false } as const;

export async function signInWithPassword(email: string, password: string): Promise<VerifyResult> {
  return toSession(await api.post<Raw>('/auth/login', { email, password }, PUBLIC));
}

export type SignUpResult = { status: 'verify_email'; email: string } | { status: 'signed_in'; session: VerifyResult };

export async function signUpWithPassword(input: { email: string; password: string; name: string }): Promise<SignUpResult> {
  const r = await api.post<Raw>('/auth/signup', input, PUBLIC);
  return r.status === 'signed_in' ? { status: 'signed_in', session: toSession(r) } : { status: 'verify_email', email: r.email };
}

export async function requestPasswordReset(email: string) {
  await api.post('/auth/forgot', { email }, PUBLIC);
}

/** Confirms a new account with the code from the sign-up email; signs the person in. */
export async function verifyEmailCode(email: string, code: string): Promise<VerifyResult> {
  return toSession(await api.post<Raw>('/auth/verify', { email, code }, PUBLIC));
}

export async function resendVerification(email: string) {
  await api.post('/auth/resend', { email }, PUBLIC);
}

/** Needs a session (from the reset or invite link, or a normal sign-in). */
export async function setNewPassword(password: string) {
  await api.post('/auth/reset', { password }, { workspaceId: false });
}

/** Revokes the refresh token on the server. Fire and forget; the local session is cleared regardless. */
export function revokeSession(accessToken: string | null | undefined) {
  if (!accessToken || accessToken.startsWith('mock.')) return;
  void fetch(`${API_BASE}/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${accessToken}` }, keepalive: true }).catch(() => undefined);
}

export async function getMe(workspaceId: string | null): Promise<Me> {
  const r = await api.get<Raw>('/me', undefined, { workspaceId: workspaceId ?? false });
  const user = adaptUser(r.user);
  let role: Role = r.effective_role ?? 'agent';
  if (user.is_super_admin && !r.active_workspace) role = 'super_admin';
  return {
    user,
    workspace: r.active_workspace ? adaptWorkspace(r.active_workspace) : null,
    role,
    memberships: (r.memberships ?? []).map(adaptMembership),
    signedInAs: r.signed_in_as
      ? { id: r.signed_in_as.id, expiresAt: r.signed_in_as.expires_at, by: { id: r.signed_in_as.by.id, name: r.signed_in_as.by.name || r.signed_in_as.by.email || '' } }
      : null,
  };
}

export async function getBranding(params: { workspaceId?: string | null; host?: string }): Promise<ResolvedBranding> {
  const r = await api.get<Raw>(
    '/branding',
    { workspace_id: params.workspaceId ?? undefined, host: params.host },
    { anonymous: !params.workspaceId, workspaceId: false },
  );
  return adaptResolvedBranding(r);
}

import { env } from '../env';
import { ApiError } from '../http';

/**
 * Supabase Auth (GoTrue) over REST. The browser never talks to Supabase
 * directly: our /api/v1/auth/* routes call these, so the API keeps one error
 * shape and tests can swap in a fake.
 */
export interface AuthSession {
  access_token: string;
  refresh_token: string;
  /** epoch seconds */
  expires_at: number;
  user: { id: string; email: string | null; email_confirmed_at?: string | null; user_metadata?: Record<string, unknown> };
}

export interface GoTrue {
  signUp(email: string, password: string, name: string, redirectTo: string): Promise<{ session: AuthSession | null; userId: string | null }>;
  signIn(email: string, password: string): Promise<AuthSession>;
  refresh(refreshToken: string): Promise<AuthSession>;
  recover(email: string, redirectTo: string): Promise<void>;
  resend(email: string, redirectTo: string): Promise<void>;
  /** Confirms a sign-up with the code from the email ({{ .Token }} in the "Confirm signup" template). */
  verifyEmailCode(email: string, code: string): Promise<AuthSession>;
  updatePassword(accessToken: string, password: string): Promise<void>;
  signOut(accessToken: string): Promise<void>;
  /** Service role: invite someone by email (creates the auth user, sends a set-password link). */
  invite(email: string, name: string, redirectTo: string): Promise<{ userId: string }>;
}

/**
 * New-style keys (sb_publishable_…, sb_secret_…) go in `apikey` only; legacy
 * JWT keys also go in Authorization. A user's access token always does.
 */
export function supabaseHeaders(key: string, bearer?: string): Record<string, string> {
  const h: Record<string, string> = { apikey: key, 'content-type': 'application/json' };
  if (bearer) h.authorization = `Bearer ${bearer}`;
  else if (!key.startsWith('sb_')) h.authorization = `Bearer ${key}`;
  return h;
}

function anonKey(): string {
  return process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
}

function baseUrl(): string {
  const url = env.supabaseUrl || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  if (!url) throw new ApiError(503, 'auth_not_configured', 'Sign-in is not configured on this server');
  return url.replace(/\/$/, '');
}

interface GoTrueError { error_code?: string; code?: string | number; msg?: string; message?: string; error?: string; error_description?: string }

/** Maps GoTrue's errors to ours, with messages a person can act on. */
function mapError(status: number, body: GoTrueError): ApiError {
  const code = String(body.error_code ?? body.error ?? body.code ?? '');
  const text = body.msg ?? body.message ?? body.error_description ?? 'Request failed';
  if (code === 'invalid_credentials' || (code === 'invalid_grant' && /credentials/i.test(text))) {
    return new ApiError(401, 'invalid_credentials', 'Email or password is incorrect');
  }
  if (code === 'email_not_confirmed') return new ApiError(403, 'email_not_confirmed', 'Please confirm your email first. Check your inbox for the code.');
  if (code === 'otp_expired' || code === 'otp_disabled' || (status === 403 && /token/i.test(text))) {
    return new ApiError(422, 'invalid_code', 'That code is wrong or has expired. Check the latest email or send a new code.');
  }
  if (code === 'user_already_exists' || code === 'email_exists') return new ApiError(409, 'email_taken', 'An account with this email already exists. Sign in instead.');
  if (code === 'weak_password') return new ApiError(422, 'weak_password', text);
  if (code === 'same_password') return new ApiError(422, 'same_password', 'Choose a password different from your current one');
  if (code === 'over_email_send_rate_limit' || code === 'over_request_rate_limit' || status === 429) {
    return new ApiError(429, 'rate_limited', 'Too many attempts. Please wait a minute and try again.');
  }
  if (code === 'refresh_token_not_found' || code === 'refresh_token_already_used' || code === 'session_not_found' || code === 'bad_jwt' || status === 401) {
    return new ApiError(401, 'unauthorized', 'Your session has ended. Please sign in again.');
  }
  if (code === 'validation_failed' || code === 'email_address_invalid') return new ApiError(422, 'validation_failed', text);
  if (status >= 500) return new ApiError(502, 'auth_unavailable', 'Sign-in service is unavailable. Try again shortly.');
  return new ApiError(status === 400 ? 400 : status, code || 'auth_error', text);
}

async function call<T>(path: string, init: { method?: string; body?: unknown; bearer?: string; service?: boolean }): Promise<T> {
  const key = init.service ? env.supabaseServiceRoleKey : anonKey();
  if (!key) throw new ApiError(503, 'auth_not_configured', 'Sign-in is not configured on this server');
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/auth/v1${path}`, {
      method: init.method ?? 'POST',
      headers: supabaseHeaders(key, init.bearer),
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(502, 'auth_unavailable', 'Sign-in service is unavailable. Try again shortly.');
  }
  const text = await res.text();
  const body = text ? (JSON.parse(text) as unknown) : {};
  if (!res.ok) throw mapError(res.status, body as GoTrueError);
  return body as T;
}

function toSession(r: Record<string, unknown>): AuthSession {
  const expiresAt = typeof r.expires_at === 'number' ? r.expires_at : Math.floor(Date.now() / 1000) + Number(r.expires_in ?? 3600);
  return {
    access_token: String(r.access_token),
    refresh_token: String(r.refresh_token),
    expires_at: expiresAt,
    user: r.user as AuthSession['user'],
  };
}

const supabaseGoTrue: GoTrue = {
  async signUp(email, password, name, redirectTo) {
    const r = await call<Record<string, unknown>>(`/signup?redirect_to=${encodeURIComponent(redirectTo)}`, {
      body: { email, password, data: { name } },
    });
    if (r.access_token) {
      const s = toSession(r);
      return { session: s, userId: s.user.id };
    }
    // Email confirmation on: GoTrue returns the user (or an obfuscated one when the email is taken).
    return { session: null, userId: (r.id as string) ?? ((r.user as { id?: string })?.id ?? null) };
  },
  async signIn(email, password) {
    return toSession(await call('/token?grant_type=password', { body: { email, password } }));
  },
  async refresh(refreshToken) {
    return toSession(await call('/token?grant_type=refresh_token', { body: { refresh_token: refreshToken } }));
  },
  async recover(email, redirectTo) {
    await call(`/recover?redirect_to=${encodeURIComponent(redirectTo)}`, { body: { email } });
  },
  async resend(email, redirectTo) {
    await call(`/resend?redirect_to=${encodeURIComponent(redirectTo)}`, { body: { type: 'signup', email } });
  },
  async verifyEmailCode(email, code) {
    return toSession(await call('/verify', { body: { type: 'email', email, token: code } }));
  },
  async updatePassword(accessToken, password) {
    await call('/user', { method: 'PUT', bearer: accessToken, body: { password } });
  },
  async signOut(accessToken) {
    await call('/logout', { bearer: accessToken }).catch(() => undefined);
  },
  async invite(email, name, redirectTo) {
    const r = await call<{ id: string }>(`/invite?redirect_to=${encodeURIComponent(redirectTo)}`, {
      service: true,
      body: { email, data: { name } },
    });
    return { userId: r.id };
  },
};

let driver: GoTrue = supabaseGoTrue;
export function gotrue(): GoTrue {
  return driver;
}
/** Tests swap in a fake. */
export function setGoTrue(d: GoTrue) {
  driver = d;
}

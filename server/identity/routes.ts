import { z } from 'zod';
import { withService } from '../db';
import { bearerToken, verifyAccessToken } from '../auth';
import { errorResponse, json, readJson } from '../http';
import { sessionPayload } from '../core/identity';
import { gotrue } from './gotrue';

const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);
const password = z.string().min(8, 'Use at least 8 characters').max(72, 'Use at most 72 characters');

/** Where links in auth emails land: this app's /auth/callback on the host the person used. */
export function callbackUrl(req: Request, next?: string): string {
  // The request's own origin, so partner domains get links back to themselves.
  const url = new URL('/auth/callback', new URL(req.url).origin);
  if (next) url.searchParams.set('next', next);
  return url.toString();
}

type Handler = (req: Request) => Promise<Response>;
function route(fn: Handler): Handler {
  return async (req) => {
    try {
      return await fn(req);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export const signUp = route(async (req) => {
  const b = await readJson(req, z.object({ email, password, name: z.string().trim().min(1, 'Enter your name').max(80) }));
  const r = await gotrue().signUp(b.email, b.password, b.name, callbackUrl(req));
  if (r.session) {
    const session = r.session;
    return json(await withService(async (tx) => {
      await tx`update public.users set name = ${b.name} where id = ${session.user.id} and name = ''`;
      return { status: 'signed_in', ...(await sessionPayload(tx, session)) };
    }), 201);
  }
  // Confirmation email sent. Same answer whether or not the email was new, so
  // sign-up can't be used to find out who has an account.
  return json({ status: 'verify_email', email: b.email }, 201);
});

export const signIn = route(async (req) => {
  const b = await readJson(req, z.object({ email, password: z.string().min(1, 'Enter your password').max(72) }));
  const s = await gotrue().signIn(b.email, b.password);
  return json(await withService((tx) => sessionPayload(tx, s)));
});

export const refresh = route(async (req) => {
  const b = await readJson(req, z.object({ refresh_token: z.string().min(10).max(500) }));
  const s = await gotrue().refresh(b.refresh_token);
  return json(await withService((tx) => sessionPayload(tx, s)));
});

/** Always 200: whether an account exists is not revealed. */
export const forgot = route(async (req) => {
  const b = await readJson(req, z.object({ email }));
  try {
    await gotrue().recover(b.email, callbackUrl(req, '/reset-password'));
  } catch (err) {
    if ((err as { code?: string }).code === 'rate_limited') throw err;
  }
  return json({ sent: true });
});

export const resend = route(async (req) => {
  const b = await readJson(req, z.object({ email }));
  try {
    await gotrue().resend(b.email, callbackUrl(req));
  } catch (err) {
    if ((err as { code?: string }).code === 'rate_limited') throw err;
  }
  return json({ sent: true });
});

/** Confirms a new account with the code from the sign-up email and signs the person in. */
export const verifyEmail = route(async (req) => {
  const b = await readJson(req, z.object({ email, code: z.string().trim().regex(/^\d{6,10}$/, 'Enter the code from the email') }));
  const s = await gotrue().verifyEmailCode(b.email, b.code);
  const name = typeof s.user.user_metadata?.name === 'string' ? s.user.user_metadata.name.trim().slice(0, 80) : '';
  return json(await withService(async (tx) => {
    if (name) await tx`update public.users set name = ${name} where id = ${s.user.id} and name = ''`;
    return sessionPayload(tx, s);
  }));
});

/** Sets a new password. Needs the access token from the recovery/invite link (or a normal session). */
export const resetPassword = route(async (req) => {
  const token = bearerToken(req);
  await verifyAccessToken(token);
  const b = await readJson(req, z.object({ password }));
  await gotrue().updatePassword(token, b.password);
  return json({ updated: true });
});

export const signOut = route(async (req) => {
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (token) await gotrue().signOut(token);
  return json({ signed_out: true });
});

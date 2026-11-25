/**
 * Fake /api/v1 for NEXT_PUBLIC_API_MOCKING=all. Response shapes copy the real
 * route handlers (sandbox shapes for Taimoor's routes, `{ data }` for
 * Huzaifa's), plus the fields requested in brief §12.
 */
import { http, HttpResponse } from 'msw';
import { regionFromCountry } from '@/lib/format/settings';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import {
  getDb, persist, seedTemplate, uid, AUTOMATION_KEYS,
  type MContact, type MDeal, type MTask, type MWorkspace, type MockDb,
} from '../db';
import { TEMPLATES } from '../data/templates';
import { AUTOMATION_CATALOG, NOTIFICATION_TYPES } from './catalog';
import { BASE, authorize, body, dayBounds, fail, isResponse, latency, localDay, mockSignInAs, nowIso, paginate, query, signInAsOf, tokenUser, userFromRequest, type Ctx } from './context';

const json = HttpResponse.json;

// Demo-mode saved views (kept in memory for the session).
const mockViews: { id: string; workspace_id: string; user_id: string; name: string; filters: Record<string, string>; shared: boolean }[] = [];

// ------------------------------------------------------------- helpers

function normalizePhone(input: unknown, country = 'US'): string | null {
  if (typeof input !== 'string' || !input.trim()) return null;
  const p = parsePhoneNumberFromString(input.trim(), country as never);
  return p && p.isPossible() ? p.number : null;
}

function canSee(ctx: Ctx, ownerId: string | null) {
  return ctx.isManager || ownerId === ctx.user.id;
}

function brandingFor(db: MockDb, ws: MWorkspace | null, partnerId?: string) {
  const partner = db.partners.find((p) => p.id === (ws?.partner_id ?? partnerId)) ?? db.partners[0];
  return { partner, branding: { ...partner.branding, ...(ws?.branding ?? {}) } };
}

function settingsOf(ws: MWorkspace) {
  return { ...ws.region, timezone: ws.timezone, name: ws.name, branding: ws.branding };
}

function contactOut(c: MContact) {
  const { sample: _s, ...rest } = c;
  return rest;
}

function dealOut(db: MockDb, d: MDeal) {
  const { sample: _s, ...rest } = d;
  const next = db.tasks
    .filter((t) => t.status === 'open' && (t.deal_id === d.id || t.contact_id === d.contact_id))
    .sort((a, b) => a.due_at.localeCompare(b.due_at))[0];
  // value_pkr kept for parity with the sandbox shape.
  const c = db.contacts.find((x) => x.id === d.contact_id);
  return { ...rest, value_pkr: d.value_minor / 100, next_task_due_at: next?.due_at ?? null, contact: c ? { id: c.id, name: c.name, phone_e164: c.phone_e164 } : null };
}

function taskOut(db: MockDb, t: MTask) {
  const c = t.contact_id ? db.contacts.find((x) => x.id === t.contact_id) : null;
  return { ...t, is_overdue: t.status === 'open' && new Date(t.due_at).getTime() < Date.now(), contact: c ? { id: c.id, name: c.name, phone_e164: c.phone_e164 } : null };
}

function activity(db: MockDb, ws: string, contactId: string | null, type: string, actor: string | null, text: string, meta: Record<string, unknown> = {}, dealId: string | null = null) {
  const a = { id: uid(), workspace_id: ws, contact_id: contactId, deal_id: dealId, type, actor_id: actor, body: text, meta, created_at: nowIso() };
  db.activities.unshift(a);
  return a;
}

function notify(db: MockDb, ws: string, userId: string, type: string, title: string, data: Record<string, unknown>, priority: 'normal' | 'urgent' = 'normal') {
  db.notifications.unshift({ id: uid(), workspace_id: ws, user_id: userId, type, priority, title, body: null, data, read_at: null, created_at: nowIso() });
}

function markResponded(c: MContact) {
  const now = nowIso();
  c.first_response_at ??= now;
  c.last_response_at = now;
  c.last_activity_at = now;
  c.updated_at = now;
}

function nextOwner(db: MockDb, ws: MWorkspace): string | null {
  const rules = db.assignment[ws.id];
  if (!rules || rules.mode === 'manual' || !rules.agent_ids.length) return null;
  const pool = rules.agent_ids.filter((id) => db.availability[`${ws.id}:${id}`] !== false);
  if (!pool.length) return null;
  const counts = pool.map((id) => db.contacts.filter((c) => c.workspace_id === ws.id && c.owner_id === id).length);
  return pool[counts.indexOf(Math.min(...counts))];
}

function reportRange(req: Request, tz: string) {
  const q = query(req);
  const today = localDay(nowIso(), tz);
  const to = q.get('to') ?? today;
  const fromDefault = new Date(Date.parse(to) - 29 * 86400_000).toISOString().slice(0, 10);
  const from = q.get('from') ?? fromDefault;
  return { from, to, inRange: (iso: string | null) => !!iso && localDay(iso, tz) >= from && localDay(iso, tz) <= to };
}

function withAuth(
  opts: Parameters<typeof authorize>[1],
  fn: (ctx: Ctx, req: Request, params: Record<string, string>, db: MockDb) => Response | Promise<Response>,
) {
  return async ({ request, params }: { request: Request; params: Record<string, string | readonly string[] | undefined> }) => {
    await latency();
    const ctx = authorize(request, opts);
    if (isResponse(ctx)) return ctx;
    const res = await fn(ctx, request, params as Record<string, string>, getDb());
    persist();
    return res;
  };
}

// ------------------------------------------------------------- handlers

export const allHandlers = [
  // ---------- auth
  // Demo mode: any seeded user's email signs in with password "demo1234".
  http.post(`${BASE}/auth/login`, async ({ request }) => {
    await latency();
    const db = getDb();
    const b = await body<{ email?: string; password?: string }>(request);
    const user = db.users.find((u) => u.email && u.email.toLowerCase() === String(b.email ?? '').trim().toLowerCase());
    if (!user || b.password !== 'demo1234') return fail(401, 'invalid_credentials', 'Email or password is incorrect');
    return json(mockSession(db, user));
  }),

  http.post(`${BASE}/auth/signup`, async ({ request }) => {
    await latency();
    const db = getDb();
    const b = await body<{ email?: string; password?: string; name?: string }>(request);
    const email = String(b.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(422, 'validation_failed', 'Enter a valid email address');
    if (String(b.password ?? '').length < 8) return fail(422, 'validation_failed', 'Use at least 8 characters');
    let user = db.users.find((u) => u.email === email);
    if (user) return fail(409, 'email_taken', 'An account with this email already exists. Sign in instead.');
    user = { id: uid(), name: String(b.name ?? ''), phone: '', email, partner_admin_of: null, is_super_admin: false, created_at: nowIso() };
    db.users.push(user);
    persist();
    // Demo mode skips the confirmation email.
    return json({ status: 'signed_in', ...mockSession(db, user) }, { status: 201 });
  }),

  http.post(`${BASE}/auth/refresh`, async ({ request }) => {
    const db = getDb();
    const b = await body<{ refresh_token?: string }>(request);
    const user = db.users.find((u) => `mock-refresh.${u.id}` === b.refresh_token);
    if (!user) return fail(401, 'unauthorized', 'Your session has ended. Please sign in again.');
    return json(mockSession(db, user));
  }),
  // Demo mode keeps uploaded logos in the browser as data URLs.
  http.post(`${BASE}/branding/upload`, async ({ request }) => {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return fail(422, 'validation_failed', 'Choose an image file');
    if (file.size > 1024 * 1024) return fail(413, 'too_large', 'Images must be 1 MB or smaller');
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    bytes.forEach((b) => (bin += String.fromCharCode(b)));
    return json({ url: `data:${file.type};base64,${btoa(bin)}` }, { status: 201 });
  }),
  http.post(`${BASE}/auth/forgot`, () => json({ sent: true })),
  http.post(`${BASE}/auth/resend`, () => json({ sent: true })),
  // Demo mode signs up without a code; any known email confirms with 123456.
  http.post(`${BASE}/auth/verify`, async ({ request }) => {
    await latency();
    const db = getDb();
    const b = await body<{ email?: string; code?: string }>(request);
    const user = db.users.find((u) => u.email && u.email.toLowerCase() === String(b.email ?? '').trim().toLowerCase());
    if (!user || String(b.code ?? '').trim() !== '123456') return fail(422, 'invalid_code', 'That code is wrong or has expired. Check the latest email or send a new code.');
    return json(mockSession(db, user));
  }),
  http.post(`${BASE}/auth/reset`, () => json({ updated: true })),
  http.post(`${BASE}/auth/logout`, () => json({ signed_out: true })),

  http.get(`${BASE}/me`, async ({ request }) => {
    await latency();
    const db = getDb();
    const user = userFromRequest(request);
    if (!user) return json({ error: 'Unauthorized: Unknown user actor' }, { status: 401 });
    const mems = db.memberships.filter((m) => m.user_id === user.id && m.status === 'active');
    const wsId = request.headers.get('x-workspace-id');
    const visible = (w: MWorkspace) => mems.some((m) => m.workspace_id === w.id) || user.partner_admin_of === w.partner_id || user.is_super_admin;
    let ws = wsId ? db.workspaces.find((w) => w.id === wsId && visible(w)) ?? null : null;
    if (!ws && !wsId) ws = db.workspaces.find((w) => mems[0]?.workspace_id === w.id) ?? (user.partner_admin_of ? db.workspaces.find((w) => w.partner_id === user.partner_admin_of) ?? null : null);
    if (wsId && !ws) return json({ error: 'RLS Forbidden: not a member of this workspace' }, { status: 403 });
    const m = ws ? mems.find((x) => x.workspace_id === ws!.id) : null;
    const role = m?.role ?? (ws && user.partner_admin_of === ws.partner_id ? 'partner_admin' : user.is_super_admin ? 'owner' : 'agent');
    const s = signInAsOf(request);
    const by = s ? db.users.find((u) => u.id === s.ownerId) : null;
    return json({
      user: s ? { ...user, is_super_admin: false } : user,
      active_workspace: ws ? { ...ws, region: undefined } : null,
      effective_role: role,
      memberships: mems
        .filter((x) => !s || x.workspace_id === s.workspaceId)
        .map((x) => ({ ...x, workspace_name: db.workspaces.find((w) => w.id === x.workspace_id)?.name ?? null, template_key: db.workspaces.find((w) => w.id === x.workspace_id)?.template_key ?? null })),
      signed_in_as: s && by ? { id: s.id, expires_at: s.expiresAt, by: { id: by.id, name: by.name, email: by.email } } : null,
    });
  }),

  http.get(`${BASE}/branding`, async ({ request }) => {
    await latency();
    const db = getDb();
    const q = query(request);
    const host = q.get('host');
    const ws = db.workspaces.find((w) => w.id === q.get('workspace_id')) ?? null;
    const domain = host ? db.domains.find((d) => d.domain === host) : null;
    const { partner, branding } = brandingFor(db, ws, domain?.partner_id);
    return json({
      partner: { id: partner.id, name: partner.name, slug: partner.slug, is_house: partner.is_house },
      workspace: ws ? { id: ws.id, name: ws.name, template_key: ws.template_key, locale: 'en' } : null,
      matched_domain: domain?.domain ?? null,
      branding,
    });
  }),

  // ---------- templates & workspaces
  http.get(`${BASE}/templates`, async () => {
    await latency();
    return json({ data: TEMPLATES });
  }),

  http.get(`${BASE}/workspaces`, async ({ request }) => {
    await latency();
    const db = getDb();
    const user = userFromRequest(request);
    if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
    const ids = db.memberships.filter((m) => m.user_id === user.id).map((m) => m.workspace_id);
    return json({ data: db.workspaces.filter((w) => ids.includes(w.id) || w.partner_id === user.partner_admin_of) });
  }),

  http.post(`${BASE}/workspaces`, async ({ request }) => {
    await latency();
    const db = getDb();
    const user = userFromRequest(request);
    if (!user) return json({ error: 'Unauthorized' }, { status: 401 });
    const b = await body<Record<string, unknown>>(request);
    const name = String(b.name ?? '').trim();
    if (!name) return json({ error: 'Workspace name is required' }, { status: 400 });
    const region = regionFromCountry(String(b.country ?? 'US'), {
      currency: b.currency as string, timezone: b.timezone as string, locale: b.locale !== 'en' ? (b.locale as string) : undefined,
      area_unit: b.area_unit as 'sqft', date_format: b.date_format as string, time_format: b.time_format as '12h', default_phone_country: b.default_phone_country as string,
    } as never);
    for (const k of Object.keys(region) as (keyof typeof region)[]) if (region[k] === undefined) delete region[k];
    const full = { ...regionFromCountry(String(b.country ?? 'US')), ...region };
    const ws: MWorkspace = {
      id: uid(), partner_id: (b.partner_id as string) ?? db.partners[0].id, name, template_key: String(b.template_key ?? 'general'), status: 'trialing',
      timezone: full.timezone, created_at: nowIso(), region: full, branding: {}, has_samples: b.seed_samples !== false, plan: null,
    };
    db.workspaces.push(ws);
    db.memberships.push({ id: uid(), user_id: user.id, workspace_id: ws.id, role: 'owner', status: 'active', created_at: nowIso() });
    if (!user.name && typeof b.owner_name === 'string') user.name = b.owner_name;
    seedTemplate(db, ws, ws.template_key);
    db.assignment[ws.id] = { mode: 'manual', agent_ids: [], source_map: {}, fallback: 'round_robin', reassign_after_minutes: null, max_auto_reassigns: 2 };
    for (const key of AUTOMATION_KEYS) db.automations.push({ workspace_id: ws.id, key, enabled: key === 'auto_follow_up', settings: {}, last_run_at: null, runs_7d: 0, failed_7d: 0 });
    db.lead_sources.push({ id: uid(), workspace_id: ws.id, type: 'website_form', name: 'Website form', source_label: 'website', public_key: `ls_${ws.id.slice(0, 8)}`, is_active: true, settings: {}, secret: null, created_at: nowIso() });
    if (ws.has_samples) seedSamples(db, ws, user.id);
    persist();
    return json({ workspace: { ...ws } }, { status: 201 });
  }),

  http.get(`${BASE}/workspaces/:id/settings`, withAuth({}, (ctx) => json({ data: settingsOf(ctx.ws) }))),

  http.patch(`${BASE}/workspaces/:id/settings`, withAuth({ managerOnly: true }, async (ctx, req) => {
    const b = await body<Record<string, unknown>>(req);
    const { name, branding, ...region } = b;
    if (typeof name === 'string' && name.trim()) ctx.ws.name = name.trim();
    if (branding && typeof branding === 'object') ctx.ws.branding = { ...ctx.ws.branding, ...(branding as object) };
    ctx.ws.region = { ...ctx.ws.region, ...(region as object) };
    if (typeof region.timezone === 'string') ctx.ws.timezone = region.timezone;
    return json({ data: settingsOf(ctx.ws) });
  })),

  http.post(`${BASE}/workspaces/:id/clear-samples`, withAuth({ managerOnly: true }, (ctx, _r, _p, db) => {
    const sampleContacts = new Set(db.contacts.filter((c) => c.workspace_id === ctx.ws.id && c.sample).map((c) => c.id));
    const before = db.contacts.length;
    db.contacts = db.contacts.filter((c) => !sampleContacts.has(c.id));
    db.deals = db.deals.filter((d) => !sampleContacts.has(d.contact_id));
    db.tasks = db.tasks.filter((t) => !t.contact_id || !sampleContacts.has(t.contact_id));
    db.activities = db.activities.filter((a) => !a.contact_id || !sampleContacts.has(a.contact_id));
    const convs = new Set(db.conversations.filter((c) => sampleContacts.has(c.contact_id)).map((c) => c.id));
    db.conversations = db.conversations.filter((c) => !convs.has(c.id));
    db.messages = db.messages.filter((m) => !convs.has(m.conversation_id));
    ctx.ws.has_samples = false;
    return json({ data: { removed: before - db.contacts.length } });
  })),

  http.get(`${BASE}/workspaces/:id/members`, withAuth({}, (ctx, _r, _p, db) =>
    json({
      data: db.memberships.filter((m) => m.workspace_id === ctx.ws.id).map((m) => {
        const u = db.users.find((x) => x.id === m.user_id);
        return { ...m, user: u ? { id: u.id, name: u.name, phone: u.phone, email: u.email, locale: 'en' } : null };
      }),
    }),
  )),

  http.post(`${BASE}/workspaces/:id/sign-in-as`, withAuth({}, async (ctx, req, _p, db) => {
    if (signInAsOf(req)) return fail(403, 'not_allowed_while_signed_in_as', 'Return to your own account to do this');
    if (ctx.membership?.role !== 'owner') return fail(403, 'forbidden', 'Only workspace owners can sign in as a teammate');
    const b = await body<{ user_id?: string }>(req);
    const target = db.memberships.find((m) => m.workspace_id === ctx.ws.id && m.user_id === b.user_id && m.status === 'active');
    if (!target || target.user_id === ctx.user.id) return fail(404, 'not_found', 'This person is not an active member of the workspace');
    if (target.role === 'owner') return fail(403, 'forbidden', 'You can’t sign in as another owner');
    for (const [k, v] of mockSignInAs) if (v.ownerId === ctx.user.id && v.workspaceId === ctx.ws.id) mockSignInAs.delete(k);
    const id = uid();
    const expiresAt = new Date(Date.now() + 2 * 3600_000).toISOString();
    mockSignInAs.set(id, { ownerId: ctx.user.id, userId: target.user_id, workspaceId: ctx.ws.id, expiresAt });
    const u = db.users.find((x) => x.id === target.user_id);
    return json({ sign_in_as: { id, expires_at: expiresAt, user: { id: target.user_id, name: u?.name ?? '', email: u?.email ?? null, role: target.role } } }, { status: 201 });
  })),

  http.delete(`${BASE}/workspaces/:id/sign-in-as`, async ({ request, params }) => {
    await latency();
    const owner = tokenUser(request);
    if (!owner) return fail(401, 'unauthorized', 'Missing Authorization: Bearer token');
    let ended = false;
    for (const [k, v] of mockSignInAs) {
      if (v.ownerId === owner.id && v.workspaceId === params.id) {
        mockSignInAs.delete(k);
        ended = true;
      }
    }
    return json({ ended });
  }),

  http.post(`${BASE}/invites`, withAuth({ managerOnly: true }, async (ctx, req, _p, db) => {
    const b = await body<{ name?: string; phone?: string; email?: string; role?: string }>(req);
    const phone = normalizePhone(b.phone, ctx.ws.region.default_phone_country);
    if (!phone && !b.email) return json({ error: 'Phone or email is required' }, { status: 400 });
    let user = db.users.find((u) => (phone && u.phone === phone) || (b.email && u.email === b.email));
    if (!user) {
      user = { id: uid(), name: b.name ?? '', phone: phone ?? '', email: b.email ?? null, partner_admin_of: null, is_super_admin: false, created_at: nowIso() };
      db.users.push(user);
    }
    if (db.memberships.some((m) => m.user_id === user!.id && m.workspace_id === ctx.ws.id)) return json({ error: 'Already a member of this workspace' }, { status: 409 });
    const membership = { id: uid(), user_id: user.id, workspace_id: ctx.ws.id, role: (b.role ?? 'agent') as 'agent', status: 'invited' as const, created_at: nowIso() };
    db.memberships.push(membership);
    return json({ membership }, { status: 201 });
  })),

  http.patch(`${BASE}/memberships/:id`, withAuth({ managerOnly: true }, async (ctx, req, p, db) => {
    const m = db.memberships.find((x) => x.id === p.id && x.workspace_id === ctx.ws.id);
    if (!m) return json({ error: 'Membership not found' }, { status: 404 });
    const b = await body<{ role?: 'owner' | 'manager' | 'agent'; status?: 'active' | 'suspended' }>(req);
    if (b.role) m.role = b.role;
    if (b.status) m.status = b.status;
    return json({ membership: m });
  })),

  // ---------- contacts
  http.get(`${BASE}/contacts/check-duplicate`, withAuth({}, (ctx, req, _p, db) => {
    const q = query(req);
    const e164 = normalizePhone(q.get('phone'), q.get('country') ?? ctx.ws.region.default_phone_country);
    const existing = e164 ? db.contacts.find((c) => c.workspace_id === ctx.ws.id && c.phone_e164 === e164 && !c.deleted_at) : null;
    return json({
      input: q.get('phone'), normalized_e164: e164, duplicate_found: Boolean(existing),
      existing_contact: existing ? { id: existing.id, name: existing.name, phone_e164: existing.phone_e164, owner_id: existing.owner_id, status: existing.status } : null,
    });
  })),

  http.get(`${BASE}/contacts`, withAuth({}, (ctx, req, _p, db) => {
    const q = query(req);
    const text = (q.get('q') ?? '').trim().toLowerCase();
    const digits = text.replace(/\D/g, '');
    const rows = db.contacts
      .filter((c) => {
        if (c.workspace_id !== ctx.ws.id || c.deleted_at || !canSee(ctx, c.owner_id)) return false;
        if (q.get('source') && c.source !== q.get('source')) return false;
        if (q.get('owner') && (q.get('owner') === 'none' ? c.owner_id !== null : c.owner_id !== (q.get('owner') === 'me' ? ctx.user.id : q.get('owner')))) return false;
        if (q.get('status') && c.status !== q.get('status')) return false;
        if (q.get('tag') && !c.tags.includes(q.get('tag')!)) return false;
        if (q.get('stage') && !db.deals.some((d) => d.contact_id === c.id && d.stage_id === q.get('stage') && !d.deleted_at)) return false;
        if (q.get('created_within_days') && Date.now() - Date.parse(c.created_at) > Number(q.get('created_within_days')) * 86400_000) return false;
        if (q.get('awaiting') === 'true' && !(c.last_enquiry_at && (!c.last_response_at || c.last_response_at < c.last_enquiry_at) && !['won', 'lost', 'cold'].includes(c.status))) return false;
        if (text) {
          const hay = `${c.name} ${c.email ?? ''} ${c.tags.join(' ')}`.toLowerCase();
          if (!hay.includes(text) && !(digits.length >= 3 && c.phone_e164.includes(digits))) return false;
        }
        return true;
      })
      .sort((a, b) => (b.created_at === a.created_at ? b.id.localeCompare(a.id) : b.created_at.localeCompare(a.created_at)));
    const limit = Math.min(Math.max(Number(q.get('limit') ?? 20), 1), 100);
    const { page, next } = paginate(rows, q.get('cursor'), limit);
    return json({ data: page.map(contactOut), pagination: { limit, next_cursor: next, total_visible: rows.length } });
  })),

  http.post(`${BASE}/leads/quick-add`, withAuth({}, async (ctx, req, _p, db) => {
    const b = await body<Record<string, unknown>>(req);
    const e164 = normalizePhone(b.phone, ctx.ws.region.default_phone_country);
    if (!e164) return fail(422, 'invalid_phone', 'Phone number is not valid');
    const existing = db.contacts.find((c) => c.workspace_id === ctx.ws.id && c.phone_e164 === e164 && !c.deleted_at);
    if (existing) {
      existing.last_enquiry_at = nowIso();
      activity(db, ctx.ws.id, existing.id, 'system', ctx.user.id, 'Re-enquired via manual entry', { kind: 're_enquiry', source_label: String(b.source_label ?? 'manual') });
      return json({ data: { contact_id: existing.id, status: 'reenquiry', owner_id: existing.owner_id, voice_note_path: null, contact: canSee(ctx, existing.owner_id) ? contactOut(existing) : null } });
    }
    const assign = String(b.assign_to ?? 'me');
    if (!ctx.isManager && assign !== 'me' && assign !== ctx.user.id) return fail(403, 'forbidden', 'Agents can only add leads for themselves');
    const owner = assign === 'me' ? ctx.user.id : assign === 'auto' ? nextOwner(db, ctx.ws) : assign === 'none' ? null : assign;
    const now = nowIso();
    const tags = Array.isArray(b.tags) ? (b.tags as string[]) : typeof b.tags === 'string' && b.tags ? String(b.tags).split(',') : [];
    const c: MContact = {
      id: uid(), workspace_id: ctx.ws.id, name: String(b.name ?? '').trim() || e164, phone_e164: e164, alt_phone: null, email: (b.email as string) || null,
      source: String(b.source_label ?? 'manual'), owner_id: owner, status: 'new', tags, custom: {}, last_activity_at: now, created_at: now, updated_at: now,
      deleted_at: null, last_enquiry_at: now, first_response_at: null, last_response_at: null, sample: false,
    };
    db.contacts.unshift(c);
    activity(db, ctx.ws.id, c.id, 'system', ctx.user.id, `Lead added by hand`, { kind: 'lead_received', source_label: c.source });
    if (b.note) activity(db, ctx.ws.id, c.id, 'note', ctx.user.id, String(b.note));
    if (b.voice) activity(db, ctx.ws.id, c.id, 'note', ctx.user.id, 'Voice note attached', { voice_note_path: `voice-notes/${ctx.ws.id}/${c.id}.webm` });
    if (owner && owner !== ctx.user.id) notify(db, ctx.ws.id, owner, 'lead.assigned', `New lead: ${c.name}`, { contact_id: c.id }, 'urgent');
    const auto = db.automations.find((a) => a.workspace_id === ctx.ws.id && a.key === 'auto_follow_up');
    if (auto?.enabled && owner) {
      const mins = Number(auto.settings.due_in_minutes ?? 15);
      db.tasks.push({ id: uid(), workspace_id: ctx.ws.id, contact_id: c.id, deal_id: null, assigned_to: owner, created_by: null, type: 'call', title: `Call ${c.name.split(' ')[0]}`, notes: null, due_at: new Date(Date.now() + mins * 60_000).toISOString(), status: 'open', completed_at: null, outcome: null, origin: 'automation', parent_task_id: null });
    }
    return json({ data: { contact_id: c.id, status: 'created', owner_id: owner, voice_note_path: null, contact: contactOut(c) } }, { status: 201 });
  })),

  http.post(`${BASE}/contacts`, withAuth({}, async (ctx, req, _p, db) => {
    const b = await body<Record<string, unknown>>(req);
    const e164 = normalizePhone(b.phone ?? b.phone_e164, ctx.ws.region.default_phone_country);
    if (!String(b.name ?? '').trim()) return json({ error: 'Contact name is required' }, { status: 400 });
    if (!e164) return json({ error: 'Invalid phone number' }, { status: 400 });
    const dup = db.contacts.find((c) => c.workspace_id === ctx.ws.id && c.phone_e164 === e164 && !c.deleted_at);
    if (dup) return json({ error: `Duplicate contact phone ${e164} already exists in workspace`, duplicate_contact_id: dup.id }, { status: 409 });
    const now = nowIso();
    const c: MContact = {
      id: uid(), workspace_id: ctx.ws.id, name: String(b.name).trim(), phone_e164: e164, alt_phone: null, email: (b.email as string) ?? null, source: String(b.source ?? 'manual'),
      owner_id: ctx.isManager ? ((b.owner_id as string) ?? ctx.user.id) : ctx.user.id, status: String(b.status ?? 'new'), tags: (b.tags as string[]) ?? [], custom: (b.custom as Record<string, unknown>) ?? {},
      last_activity_at: now, created_at: now, updated_at: now, deleted_at: null, last_enquiry_at: now, first_response_at: null, last_response_at: null, sample: false,
    };
    db.contacts.unshift(c);
    return json({ contact: contactOut(c) }, { status: 201 });
  })),

  http.get(`${BASE}/contacts/:id`, withAuth({}, (ctx, _r, p, db) => {
    const c = db.contacts.find((x) => x.id === p.id && x.workspace_id === ctx.ws.id && !x.deleted_at);
    if (!c) return json({ error: 'Contact not found' }, { status: 404 });
    if (!canSee(ctx, c.owner_id)) return json({ error: 'RLS Forbidden: Not record owner' }, { status: 403 });
    return json({ contact: contactOut(c) });
  })),

  http.patch(`${BASE}/contacts/:id`, withAuth({}, async (ctx, req, p, db) => {
    const c = db.contacts.find((x) => x.id === p.id && x.workspace_id === ctx.ws.id && !x.deleted_at);
    if (!c) return json({ error: 'Contact not found' }, { status: 404 });
    if (!canSee(ctx, c.owner_id)) return json({ error: 'RLS Forbidden: Not record owner' }, { status: 403 });
    const b = await body<Record<string, unknown>>(req);
    if (typeof b.name === 'string') c.name = b.name.trim();
    if (b.email !== undefined) c.email = (b.email as string) || null;
    if (typeof b.status === 'string') c.status = b.status;
    if (typeof b.source === 'string') c.source = b.source;
    if (Array.isArray(b.tags)) c.tags = b.tags.map(String);
    if (b.phone) {
      const e164 = normalizePhone(b.phone, ctx.ws.region.default_phone_country);
      if (!e164) return json({ error: 'Invalid phone' }, { status: 400 });
      c.phone_e164 = e164;
    }
    if (b.custom && typeof b.custom === 'object') c.custom = { ...c.custom, ...(b.custom as object) };
    c.updated_at = nowIso();
    return json({ contact: contactOut(c) });
  })),

  http.delete(`${BASE}/contacts/:id`, withAuth({}, (ctx, _r, p, db) => {
    const c = db.contacts.find((x) => x.id === p.id && x.workspace_id === ctx.ws.id);
    if (!c) return json({ error: 'Contact not found' }, { status: 404 });
    c.deleted_at = nowIso();
    return json({ deleted: true });
  })),

  http.post(`${BASE}/contacts/:id/assign`, withAuth({ managerOnly: true }, async (ctx, req, p, db) => {
    const c = db.contacts.find((x) => x.id === p.id && x.workspace_id === ctx.ws.id);
    if (!c) return fail(404, 'not_found', 'Contact not found');
    const b = await body<{ user_id: string | null }>(req);
    const changed = c.owner_id !== b.user_id;
    c.owner_id = b.user_id;
    if (changed) {
      const name = db.users.find((u) => u.id === b.user_id)?.name ?? 'nobody';
      activity(db, ctx.ws.id, c.id, 'assignment', ctx.user.id, `Assigned to ${name}`, { to: b.user_id });
      if (b.user_id) notify(db, ctx.ws.id, b.user_id, 'lead.assigned', `Lead assigned: ${c.name}`, { contact_id: c.id });
    }
    return json({ data: { contact_id: c.id, owner_id: c.owner_id, changed } });
  })),

  http.post(`${BASE}/contacts/:id/merge`, withAuth({ managerOnly: true }, async (ctx, req, p, db) => {
    const primary = db.contacts.find((x) => x.id === p.id && x.workspace_id === ctx.ws.id);
    const b = await body<{ secondary_contact_id: string }>(req);
    const secondary = db.contacts.find((x) => x.id === b.secondary_contact_id && x.workspace_id === ctx.ws.id);
    if (!primary || !secondary) return json({ error: 'Contact not found' }, { status: 404 });
    primary.tags = Array.from(new Set([...primary.tags, ...secondary.tags]));
    primary.email ??= secondary.email;
    primary.alt_phone ??= secondary.phone_e164;
    primary.custom = { ...secondary.custom, ...primary.custom };
    for (const d of db.deals) if (d.contact_id === secondary.id) d.contact_id = primary.id;
    for (const t of db.tasks) if (t.contact_id === secondary.id) t.contact_id = primary.id;
    for (const a of db.activities) if (a.contact_id === secondary.id) a.contact_id = primary.id;
    secondary.deleted_at = nowIso();
    activity(db, ctx.ws.id, primary.id, 'system', ctx.user.id, `Merged with ${secondary.name}`);
    return json({ contact: contactOut(primary) });
  })),

  http.get(`${BASE}/saved-views`, withAuth({}, (ctx) => json({ data: mockViews.filter((v) => v.workspace_id === ctx.ws.id && (v.user_id === ctx.user.id || v.shared)) }))),
  http.post(`${BASE}/saved-views`, withAuth({}, async (ctx, req) => {
    const b = await body<{ name?: string; filters?: Record<string, string>; shared?: boolean }>(req);
    if (!b.name?.trim()) return fail(422, 'validation_failed', 'Name the view');
    if (b.shared && !ctx.isManager) return fail(403, 'forbidden', 'Only owners and managers can share views with the team');
    const v = { id: uid(), workspace_id: ctx.ws.id, user_id: ctx.user.id, name: b.name.trim(), filters: b.filters ?? {}, shared: Boolean(b.shared) };
    mockViews.push(v);
    return json({ data: v }, { status: 201 });
  })),
  http.delete(`${BASE}/saved-views/:id`, withAuth({}, (ctx, _r, p) => {
    const i = mockViews.findIndex((v) => v.id === p.id && v.user_id === ctx.user.id);
    if (i < 0) return fail(404, 'not_found', 'View not found');
    mockViews.splice(i, 1);
    return json({ data: { removed: true } });
  })),

  http.get(`${BASE}/contacts/:id/summary`, withAuth({}, (ctx, _r, p, db) => {
    const c = db.contacts.find((x) => x.id === p.id && x.workspace_id === ctx.ws.id && !x.deleted_at);
    if (!c) return fail(404, 'not_found', 'Contact not found');
    const acts = db.activities.filter((a) => a.contact_id === c.id);
    const tasks = db.tasks.filter((t) => t.contact_id === c.id);
    const deals = db.deals.filter((d) => d.contact_id === c.id && !d.deleted_at);
    const kind = (d: MDeal) => db.stages.find((st) => st.id === d.stage_id)?.kind ?? 'open';
    const open = deals.filter((d) => kind(d) === 'open');
    const won = deals.filter((d) => kind(d) === 'won');
    const openTasks = tasks.filter((t) => t.status === 'open').sort((a, b) => a.due_at.localeCompare(b.due_at));
    return json({ data: {
      activity: { calls: acts.filter((a) => a.type === 'call').length, notes: acts.filter((a) => a.type === 'note').length, whatsapp: acts.filter((a) => a.type === 'whatsapp').length, stage_changes: acts.filter((a) => a.type === 'stage_change').length, total: acts.length },
      follow_ups: { open: openTasks.length, overdue: openTasks.filter((t) => Date.parse(t.due_at) < Date.now()).length, done: tasks.filter((t) => t.status === 'done').length, next_due_at: openTasks[0]?.due_at ?? null },
      deals: { open_count: open.length, open_value_minor: open.reduce((a, d) => a + d.value_minor, 0), won_count: won.length, won_value_minor: won.reduce((a, d) => a + d.value_minor, 0), lost_count: deals.length - open.length - won.length, currency: deals[0]?.currency ?? ctx.ws.region.currency, oldest_open_stage_at: open.map((d) => d.stage_entered_at).sort()[0] ?? null },
      contact: { created_at: c.created_at, last_activity_at: c.last_activity_at, first_response_at: c.first_response_at, last_response_at: c.last_response_at, last_enquiry_at: c.last_enquiry_at, status: c.status },
    } });
  })),

  http.get(`${BASE}/contacts/:id/timeline`, withAuth({}, (ctx, req, p, db) => {
    const c = db.contacts.find((x) => x.id === p.id && x.workspace_id === ctx.ws.id);
    if (!c) return json({ error: 'Contact not found' }, { status: 404 });
    const items = db.activities.filter((a) => a.contact_id === c.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const q = query(req);
    const limit = Math.min(Number(q.get('limit') ?? 25), 100);
    const { page, next } = paginate(items, q.get('cursor'), limit);
    return json({ data: page, pagination: { limit, next_cursor: next, total: items.length } });
  })),

  http.post(`${BASE}/contacts/:id/notes`, withAuth({}, async (ctx, req, p, db) => {
    const c = db.contacts.find((x) => x.id === p.id && x.workspace_id === ctx.ws.id);
    if (!c) return json({ error: 'Contact not found' }, { status: 404 });
    const b = await body<{ body?: string; deal_id?: string }>(req);
    if (!b.body?.trim()) return json({ error: 'Note body is required' }, { status: 400 });
    c.last_activity_at = nowIso();
    return json({ activity: activity(db, ctx.ws.id, c.id, 'note', ctx.user.id, b.body.trim(), {}, b.deal_id ?? null) }, { status: 201 });
  })),

  http.post(`${BASE}/contacts/:id/calls`, withAuth({}, async (ctx, req, p, db) => {
    const c = db.contacts.find((x) => x.id === p.id && x.workspace_id === ctx.ws.id);
    if (!c) return json({ error: 'Contact not found' }, { status: 404 });
    const b = await body<{ outcome?: string; note?: string; duration_sec?: number; deal_id?: string }>(req);
    markResponded(c);
    if (b.outcome === 'wrong_number') c.status = 'cold';
    else if (c.status === 'new') c.status = 'contacted';
    const label: Record<string, string> = { answered: 'answered', no_answer: 'no answer', busy: 'busy', wrong_number: 'wrong number' };
    const a = activity(db, ctx.ws.id, c.id, 'call', ctx.user.id, `Call: ${label[b.outcome ?? ''] ?? b.outcome ?? 'logged'}${b.note ? ` · ${b.note}` : ''}`, { outcome: b.outcome, duration_sec: b.duration_sec ?? null }, b.deal_id ?? null);
    return json({ activity: a }, { status: 201 });
  })),

  http.post(`${BASE}/exports`, withAuth({}, async (ctx, req, _p, db) => {
    const b = await body<{ entity?: string }>(req);
    const entity = b.entity === 'deals' ? 'deals' : 'contacts';
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    let csv: string;
    let rows: number;
    if (entity === 'contacts') {
      const list = db.contacts.filter((c) => c.workspace_id === ctx.ws.id && !c.deleted_at && canSee(ctx, c.owner_id));
      csv = ['name,phone,email,source,status,tags,created_at', ...list.map((c) => [c.name, c.phone_e164, c.email, c.source, c.status, c.tags.join('|'), c.created_at].map(esc).join(','))].join('\n');
      rows = list.length;
    } else {
      const list = db.deals.filter((d) => d.workspace_id === ctx.ws.id && !d.deleted_at && canSee(ctx, d.owner_id));
      csv = ['title,value,currency,stage,created_at', ...list.map((d) => [d.title, d.value_minor / 100, d.currency, db.stages.find((s) => s.id === d.stage_id)?.name, d.created_at].map(esc).join(','))].join('\n');
      rows = list.length;
    }
    return json({ entity, row_count: rows, file_name: `${ctx.ws.template_key}_${entity}_export.csv`, mime_type: 'text/csv; charset=utf-8', csv_content: csv });
  })),

  // ---------- pipelines & deals
  http.get(`${BASE}/pipelines`, withAuth({}, (ctx, _r, _p, db) =>
    json({ data: db.pipelines.filter((p) => p.workspace_id === ctx.ws.id).map((p) => ({ ...p, stages: db.stages.filter((s) => s.pipeline_id === p.id).sort((a, b) => a.position - b.position) })) }),
  )),

  http.post(`${BASE}/pipelines`, withAuth({ managerOnly: true }, async (ctx, req, _p, db) => {
    const b = await body<{ name?: string }>(req);
    if (!b.name?.trim()) return json({ error: 'Pipeline name is required' }, { status: 400 });
    const pipeline = { id: uid(), workspace_id: ctx.ws.id, name: b.name.trim(), position: db.pipelines.filter((p) => p.workspace_id === ctx.ws.id).length + 1, created_at: nowIso() };
    db.pipelines.push(pipeline);
    const stages = [['New', 'open'], ['In progress', 'open'], ['Won', 'won'], ['Lost', 'lost']] as const;
    stages.forEach(([name, kind], i) => db.stages.push({ id: uid(), workspace_id: ctx.ws.id, pipeline_id: pipeline.id, name, position: i + 1, kind }));
    db.reasons[pipeline.id] = { won: ['Best price'], lost: ['Price too high', 'No response'] };
    return json({ pipeline: { ...pipeline, stages: db.stages.filter((s) => s.pipeline_id === pipeline.id) } }, { status: 201 });
  })),

  http.post(`${BASE}/pipelines/:id/stages`, withAuth({ managerOnly: true }, async (ctx, req, p, db) => {
    const b = await body<{ name?: string; kind?: 'open' | 'won' | 'lost'; position?: number }>(req);
    if (!b.name?.trim()) return json({ error: 'Stage name is required' }, { status: 400 });
    const list = db.stages.filter((s) => s.pipeline_id === p.id).sort((a, b2) => a.position - b2.position);
    const firstClosed = list.find((s) => s.kind !== 'open');
    const position = b.position ?? (firstClosed ? firstClosed.position : list.length + 1);
    for (const s of list) if (s.position >= position) s.position += 1;
    const stage = { id: uid(), workspace_id: ctx.ws.id, pipeline_id: p.id, name: b.name.trim(), position, kind: b.kind ?? 'open' };
    db.stages.push(stage);
    return json({ stage }, { status: 201 });
  })),

  http.patch(`${BASE}/pipelines/:id/stages`, withAuth({ managerOnly: true }, async (_ctx, req, p, db) => {
    const b = await body<{ stage_id: string; name?: string; position?: number; kind?: 'open' | 'won' | 'lost' }>(req);
    const stage = db.stages.find((s) => s.id === b.stage_id && s.pipeline_id === p.id);
    if (!stage) return json({ error: 'Stage not found' }, { status: 404 });
    if (b.name) stage.name = b.name;
    if (b.kind) stage.kind = b.kind;
    if (typeof b.position === 'number') stage.position = b.position;
    return json({ stage });
  })),

  http.delete(`${BASE}/pipelines/:id/stages/:stageId`, withAuth({ managerOnly: true }, (_ctx, req, p, db) => {
    const moveTo = query(req).get('move_to');
    const target = db.stages.find((s) => s.id === moveTo && s.pipeline_id === p.id);
    if (!target) return fail(422, 'move_to_required', 'Choose a stage to move the deals to');
    let moved = 0;
    for (const d of db.deals) if (d.stage_id === p.stageId) { d.stage_id = target.id; moved++; }
    db.stages = db.stages.filter((s) => s.id !== p.stageId);
    return json({ data: { moved_deals: moved } });
  })),

  http.get(`${BASE}/pipelines/:id/reasons`, withAuth({}, (_ctx, _r, p, db) => json({ data: db.reasons[p.id] ?? { won: [], lost: [] } }))),
  http.put(`${BASE}/pipelines/:id/reasons`, withAuth({ managerOnly: true }, async (_ctx, req, p, db) => {
    const b = await body<{ won?: string[]; lost?: string[] }>(req);
    db.reasons[p.id] = { won: (b.won ?? []).filter(Boolean), lost: (b.lost ?? []).filter(Boolean) };
    return json({ data: db.reasons[p.id] });
  })),

  http.get(`${BASE}/deals`, withAuth({}, (ctx, req, _p, db) => {
    const q = query(req);
    const rows = db.deals
      .filter((d) => d.workspace_id === ctx.ws.id && !d.deleted_at && canSee(ctx, d.owner_id))
      .filter((d) => (!q.get('pipeline_id') || d.pipeline_id === q.get('pipeline_id')) && (!q.get('stage_id') || d.stage_id === q.get('stage_id')) && (!q.get('contact_id') || d.contact_id === q.get('contact_id')))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const limit = Math.min(Number(q.get('limit') ?? 20), 100);
    const { page, next } = paginate(rows, q.get('cursor'), limit);
    return json({ data: page.map((d) => dealOut(db, d)), pagination: { limit, next_cursor: next, total_visible: rows.length } });
  })),

  http.post(`${BASE}/deals`, withAuth({}, async (ctx, req, _p, db) => {
    const b = await body<Record<string, unknown>>(req);
    const contact = db.contacts.find((c) => c.id === b.contact_id && c.workspace_id === ctx.ws.id);
    if (!contact) return json({ error: 'Contact not found' }, { status: 404 });
    if (!String(b.title ?? '').trim()) return json({ error: 'Deal title is required' }, { status: 400 });
    const now = nowIso();
    const d: MDeal = {
      id: uid(), workspace_id: ctx.ws.id, pipeline_id: String(b.pipeline_id), stage_id: String(b.stage_id), contact_id: contact.id, title: String(b.title).trim(),
      value_minor: Number(b.value_minor ?? 0), currency: String(b.currency ?? ctx.ws.region.currency), owner_id: ctx.isManager ? ((b.owner_id as string) ?? contact.owner_id ?? ctx.user.id) : ctx.user.id,
      expected_close: (b.expected_close as string) ?? null, lost_reason: null, won_reason: null, custom: (b.custom as Record<string, unknown>) ?? {}, stage_entered_at: now, created_at: now, updated_at: now, deleted_at: null, sample: false,
    };
    db.deals.unshift(d);
    activity(db, ctx.ws.id, contact.id, 'system', ctx.user.id, `Deal created: ${d.title}`, {}, d.id);
    return json({ deal: dealOut(db, d) }, { status: 201 });
  })),

  http.patch(`${BASE}/deals/:id`, withAuth({}, async (ctx, req, p, db) => {
    const d = db.deals.find((x) => x.id === p.id && x.workspace_id === ctx.ws.id && !x.deleted_at);
    if (!d) return json({ error: 'Deal not found' }, { status: 404 });
    if (!canSee(ctx, d.owner_id)) return json({ error: 'RLS Forbidden' }, { status: 403 });
    const b = await body<Record<string, unknown>>(req);
    if (typeof b.title === 'string') d.title = b.title;
    if (typeof b.value_minor === 'number') d.value_minor = b.value_minor;
    if (b.expected_close !== undefined) d.expected_close = (b.expected_close as string) ?? null;
    if (typeof b.owner_id === 'string' && ctx.isManager) d.owner_id = b.owner_id;
    if (b.custom && typeof b.custom === 'object') d.custom = { ...d.custom, ...(b.custom as object) };
    d.updated_at = nowIso();
    return json({ deal: dealOut(db, d) });
  })),

  http.post(`${BASE}/deals/:id/move`, withAuth({}, async (ctx, req, p, db) => {
    const d = db.deals.find((x) => x.id === p.id && x.workspace_id === ctx.ws.id && !x.deleted_at);
    if (!d) return json({ error: 'Deal not found' }, { status: 404 });
    if (!canSee(ctx, d.owner_id)) return json({ error: 'RLS Forbidden' }, { status: 403 });
    const b = await body<{ stage_id: string; lost_reason?: string; won_reason?: string }>(req);
    const stage = db.stages.find((s) => s.id === b.stage_id && s.pipeline_id === d.pipeline_id);
    if (!stage) return json({ error: 'Stage not found in this pipeline' }, { status: 400 });
    if (stage.kind === 'lost' && !b.lost_reason) return json({ error: 'lost_reason is required when moving to a lost stage' }, { status: 422 });
    d.stage_id = stage.id;
    d.stage_entered_at = nowIso();
    d.updated_at = d.stage_entered_at;
    d.lost_reason = stage.kind === 'lost' ? b.lost_reason ?? null : null;
    d.won_reason = stage.kind === 'won' ? b.won_reason ?? null : null;
    const reason = d.lost_reason ?? d.won_reason;
    activity(db, ctx.ws.id, d.contact_id, 'stage_change', ctx.user.id, `Moved to ${stage.name}${reason ? ` · ${reason}` : ''}`, { to_stage_id: stage.id }, d.id);
    if (stage.kind === 'won') {
      for (const m of db.memberships.filter((x) => x.workspace_id === ctx.ws.id && x.user_id !== ctx.user.id)) notify(db, ctx.ws.id, m.user_id, 'deal.won', `Deal won: ${d.title}`, { deal_id: d.id, contact_id: d.contact_id });
    }
    return json({ deal: dealOut(db, d) });
  })),

  // ---------- custom fields
  http.get(`${BASE}/custom-fields`, withAuth({}, (ctx, req, _p, db) => {
    const entity = query(req).get('entity');
    return json({ data: db.fields.filter((f) => f.workspace_id === ctx.ws.id && (!entity || f.entity === entity)).sort((a, b) => a.position - b.position) });
  })),

  http.post(`${BASE}/custom-fields`, withAuth({ managerOnly: true }, async (ctx, req, _p, db) => {
    const b = await body<Record<string, unknown>>(req);
    const key = String(b.key ?? '').trim();
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(key)) return json({ error: 'Key must be lowercase letters, digits and underscores' }, { status: 400 });
    if (db.fields.some((f) => f.workspace_id === ctx.ws.id && f.entity === b.entity && f.key === key)) return json({ error: 'A field with this key already exists' }, { status: 409 });
    const field = {
      id: uid(), workspace_id: ctx.ws.id, entity: b.entity as 'contact', key, label_en: String(b.label_en ?? b.label ?? key), type: String(b.type ?? 'text'),
      options: (b.options as string[]) ?? [], required: Boolean(b.required), position: db.fields.filter((f) => f.workspace_id === ctx.ws.id && f.entity === b.entity).length + 1, hidden: false, created_at: nowIso(),
    };
    db.fields.push(field);
    return json({ custom_field: field }, { status: 201 });
  })),

  http.patch(`${BASE}/custom-fields/:id`, withAuth({ managerOnly: true }, async (ctx, req, p, db) => {
    const f = db.fields.find((x) => x.id === p.id && x.workspace_id === ctx.ws.id);
    if (!f) return json({ error: 'Field not found' }, { status: 404 });
    const b = await body<Record<string, unknown>>(req);
    if (typeof b.label_en === 'string') f.label_en = b.label_en;
    if (Array.isArray(b.options)) f.options = b.options as string[];
    if (typeof b.required === 'boolean') f.required = b.required;
    if (typeof b.hidden === 'boolean') f.hidden = b.hidden;
    if (typeof b.position === 'number') f.position = b.position;
    return json({ custom_field: f });
  })),

  // ---------- tasks
  http.get(`${BASE}/tasks`, withAuth({}, (ctx, req, _p, db) => {
    const q = query(req);
    const due = q.get('due');
    const status = due ? 'open' : q.get('status') ?? 'open';
    const assigned = ctx.isManager ? q.get('assigned_to') ?? 'me' : 'me';
    const { end } = dayBounds(ctx.ws.timezone);
    const now = Date.now();
    const rows = db.tasks
      .filter((t) => t.workspace_id === ctx.ws.id)
      .filter((t) => status === 'all' || t.status === status)
      .filter((t) => (assigned === 'all' ? true : t.assigned_to === (assigned === 'me' ? ctx.user.id : assigned)))
      .filter((t) => !q.get('contact_id') || t.contact_id === q.get('contact_id'))
      .filter((t) => !q.get('deal_id') || t.deal_id === q.get('deal_id'))
      .filter((t) => {
        const at = new Date(t.due_at).getTime();
        if (due === 'overdue') return at < now;
        if (due === 'today') return at >= now && at < end;
        if (due === 'upcoming') return at >= end;
        return true;
      })
      .sort((a, b) => a.due_at.localeCompare(b.due_at));
    const limit = Math.min(Number(q.get('limit') ?? 25), 100);
    const { page, next } = paginate(rows, q.get('cursor'), limit);
    return json({ data: page.map((t) => taskOut(db, t)), next_cursor: next });
  })),

  http.post(`${BASE}/tasks`, withAuth({}, async (ctx, req, _p, db) => {
    const b = await body<Record<string, unknown>>(req);
    const assigned = ctx.isManager ? ((b.assigned_to as string) ?? ctx.user.id) : ctx.user.id;
    const c = b.contact_id ? db.contacts.find((x) => x.id === b.contact_id && x.workspace_id === ctx.ws.id) : null;
    if (b.contact_id && !c) return fail(404, 'contact_not_found', 'Contact not found');
    const type = String(b.type ?? 'call');
    const verb: Record<string, string> = { call: 'Call', whatsapp: 'WhatsApp', meeting: 'Meet', site_visit: 'Viewing with', other: 'Follow up with' };
    const t: MTask = {
      id: uid(), workspace_id: ctx.ws.id, contact_id: c?.id ?? null, deal_id: (b.deal_id as string) ?? null, assigned_to: assigned, created_by: ctx.user.id, type,
      title: String(b.title ?? '').trim() || `${verb[type] ?? 'Follow up with'} ${c?.name.split(' ')[0] ?? ''}`.trim(), notes: (b.notes as string) ?? null,
      due_at: String(b.due_at), status: 'open', completed_at: null, outcome: null, origin: 'manual', parent_task_id: null,
    };
    db.tasks.push(t);
    if (c) activity(db, ctx.ws.id, c.id, 'task', ctx.user.id, `Follow-up scheduled: ${t.title}`, { task_id: t.id, due_at: t.due_at });
    if (assigned !== ctx.user.id) notify(db, ctx.ws.id, assigned, 'task.assigned', `New follow-up: ${t.title}`, { task_id: t.id, contact_id: t.contact_id });
    return json({ data: taskOut(db, t) }, { status: 201 });
  })),

  http.patch(`${BASE}/tasks/:id`, withAuth({}, async (ctx, req, p, db) => {
    const t = db.tasks.find((x) => x.id === p.id && x.workspace_id === ctx.ws.id);
    if (!t || (!ctx.isManager && t.assigned_to !== ctx.user.id)) return fail(404, 'not_found', 'Task not found');
    const b = await body<Record<string, unknown>>(req);
    if (t.status === 'done') return fail(409, 'task_done', "Completed tasks can't be reopened");
    if (typeof b.title === 'string') t.title = b.title;
    if (b.notes !== undefined) t.notes = (b.notes as string) ?? null;
    if (typeof b.type === 'string') t.type = b.type;
    if (typeof b.due_at === 'string') t.due_at = b.due_at;
    if (typeof b.assigned_to === 'string' && ctx.isManager) t.assigned_to = b.assigned_to;
    if (b.status === 'cancelled') t.status = 'cancelled';
    return json({ data: taskOut(db, t) });
  })),

  http.post(`${BASE}/tasks/:id/complete`, withAuth({}, async (ctx, req, p, db) => {
    const t = db.tasks.find((x) => x.id === p.id && x.workspace_id === ctx.ws.id);
    if (!t || (!ctx.isManager && t.assigned_to !== ctx.user.id)) return fail(404, 'not_found', 'Task not found');
    if (t.status !== 'open') return fail(409, 'task_not_open', 'This follow-up is already closed');
    const b = await body<{ outcome?: string; note?: string; next?: { due_at: string; type?: string; title?: string; notes?: string } }>(req);
    t.status = 'done';
    t.completed_at = nowIso();
    t.outcome = b.outcome ?? null;
    const c = t.contact_id ? db.contacts.find((x) => x.id === t.contact_id) : null;
    if (c && ['call', 'whatsapp', 'meeting', 'site_visit'].includes(t.type)) markResponded(c);
    if (c) activity(db, ctx.ws.id, c.id, 'task', ctx.user.id, `Follow-up done: ${t.title}${b.note ? ` · ${b.note}` : ''}`, { task_id: t.id, outcome: b.outcome });
    let next: MTask | null = null;
    if (b.next?.due_at) {
      next = { ...t, id: uid(), type: b.next.type ?? t.type, title: b.next.title ?? t.title, notes: b.next.notes ?? null, due_at: b.next.due_at, status: 'open', completed_at: null, outcome: null, origin: 'task_completion', parent_task_id: t.id };
      db.tasks.push(next);
    }
    return json({ data: { task: taskOut(db, t), next: next ? taskOut(db, next) : null } });
  })),

  // ---------- home
  http.get(`${BASE}/home/summary`, withAuth({}, (ctx, req, _p, db) => {
    const scope = query(req).get('scope') === 'team' ? 'team' : 'me';
    if (scope === 'team' && !ctx.isManager) return fail(403, 'forbidden', 'Team view is for managers');
    const mine = scope === 'me';
    const { start, end } = dayBounds(ctx.ws.timezone);
    const now = Date.now();
    const tasks = db.tasks.filter((t) => t.workspace_id === ctx.ws.id && t.status === 'open' && (!mine || t.assigned_to === ctx.user.id));
    const leads = db.contacts.filter((c) => c.workspace_id === ctx.ws.id && !c.deleted_at && (!mine || c.owner_id === ctx.user.id) && c.last_enquiry_at);
    const awaiting = (c: MContact) => !c.last_response_at || c.last_response_at < c.last_enquiry_at!;
    const todayResponded = leads.filter((c) => Date.parse(c.created_at) >= start && c.first_response_at);
    const secs = todayResponded.map((c) => (Date.parse(c.first_response_at!) - Date.parse(c.created_at)) / 1000).sort((a, b) => a - b);
    return json({
      data: {
        scope, timezone: ctx.ws.timezone, generated_at: nowIso(),
        me: { user_id: ctx.user.id, role: ctx.role, available: db.availability[`${ctx.ws.id}:${ctx.user.id}`] !== false },
        tasks: {
          overdue: tasks.filter((t) => Date.parse(t.due_at) < now).length,
          due_today: tasks.filter((t) => Date.parse(t.due_at) >= now && Date.parse(t.due_at) < end).length,
          upcoming: tasks.filter((t) => Date.parse(t.due_at) >= end).length,
          next: tasks.filter((t) => Date.parse(t.due_at) < end).sort((a, b) => a.due_at.localeCompare(b.due_at)).slice(0, 10).map((t) => {
            const c = db.contacts.find((x) => x.id === t.contact_id);
            return { id: t.id, type: t.type, title: t.title, due_at: t.due_at, assigned_to: t.assigned_to, contact_id: t.contact_id, contact_name: c?.name ?? null, contact_phone: c?.phone_e164 ?? null, is_overdue: Date.parse(t.due_at) < now };
          }),
        },
        leads: {
          new_today: leads.filter((c) => Date.parse(c.last_enquiry_at!) >= start).length,
          awaiting_first_response: leads.filter((c) => c.owner_id && awaiting(c) && now - Date.parse(c.last_enquiry_at!) < 30 * 86400_000).length,
          unassigned: ctx.isManager ? leads.filter((c) => !c.owner_id).length : null,
          recent: leads.sort((a, b) => b.last_enquiry_at!.localeCompare(a.last_enquiry_at!)).slice(0, 5).map((c) => ({
            id: c.id, name: c.name, phone_e164: c.phone_e164, source: c.source, owner_id: c.owner_id, last_enquiry_at: c.last_enquiry_at, first_response_at: c.first_response_at, awaiting_response: awaiting(c),
          })),
        },
        speed_to_lead_today: { median_seconds: secs.length ? Math.round(secs[Math.floor(secs.length / 2)]) : null, responded: secs.length },
        notifications: { unread: db.notifications.filter((n) => n.user_id === ctx.user.id && n.workspace_id === ctx.ws.id && !n.read_at).length },
      },
    });
  })),

  // ---------- notifications
  http.get(`${BASE}/notifications`, withAuth({ allowWhenReadOnly: true }, (ctx, req, _p, db) => {
    const q = query(req);
    const mine = db.notifications.filter((n) => n.user_id === ctx.user.id && n.workspace_id === ctx.ws.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
    const rows = q.get('unread') === 'true' ? mine.filter((n) => !n.read_at) : mine;
    const { page, next } = paginate(rows, q.get('cursor'), Math.min(Number(q.get('limit') ?? 25), 100));
    return json({ data: page.map(({ workspace_id: _w, user_id: _u, ...n }) => n), unread_count: mine.filter((n) => !n.read_at).length, next_cursor: next });
  })),

  http.post(`${BASE}/notifications/read`, withAuth({ allowWhenReadOnly: true }, async (ctx, req, _p, db) => {
    const b = await body<{ ids?: string[]; all?: boolean }>(req);
    let n = 0;
    for (const x of db.notifications) {
      if (x.user_id !== ctx.user.id || x.workspace_id !== ctx.ws.id || x.read_at) continue;
      if (b.all || b.ids?.includes(x.id)) { x.read_at = nowIso(); n++; }
    }
    return json({ data: { marked_read: n } });
  })),

  // TODO(mock): demo data for the status page and API logs (real data comes from api_request_logs).
  http.get(`${BASE}/status`, () => json({ data: demoStatus() })),
  http.get(`${BASE}/dev/logs`, withAuth({ allowWhenReadOnly: true }, (_ctx, req) => json(demoLogs(new URL(req.url))))),
  // TODO(mock): Google Calendar needs real Google OAuth; the demo shows "not set up".
  http.get(`${BASE}/integrations/google`, withAuth({ allowWhenReadOnly: true }, () => json({ data: { configured: false, connected: false, email: null, connected_at: null, last_synced_at: null, last_error: null, synced_count: 0 } }))),
  http.get(`${BASE}/notification-settings`, withAuth({ allowWhenReadOnly: true }, (ctx, _r, _p, db) => json({ data: notificationSettings(db, ctx) }))),
  http.put(`${BASE}/notification-settings`, withAuth({ allowWhenReadOnly: true }, async (ctx, req, _p, db) => {
    const b = await body<{ events?: { type: string; push?: boolean; whatsapp?: boolean }[]; quiet_hours?: boolean; whatsapp_number?: string | null }>(req);
    const key = `${ctx.ws.id}:${ctx.user.id}`;
    const s = (db.notification_settings[key] ??= { events: {}, quiet_hours: true, whatsapp_number: null, devices: 0 });
    for (const e of b.events ?? []) {
      const def = NOTIFICATION_TYPES.find((t) => t.type === e.type);
      const cur = s.events[e.type] ?? { push: true, whatsapp: def?.whatsapp ?? false };
      s.events[e.type] = { push: e.push ?? cur.push, whatsapp: e.whatsapp ?? cur.whatsapp };
    }
    if (typeof b.quiet_hours === 'boolean') s.quiet_hours = b.quiet_hours;
    if (b.whatsapp_number !== undefined) s.whatsapp_number = b.whatsapp_number;
    return json({ data: notificationSettings(db, ctx) });
  })),

  http.post(`${BASE}/push-subscriptions`, withAuth({ allowWhenReadOnly: true }, (ctx, _r, _p, db) => {
    const s = (db.notification_settings[`${ctx.ws.id}:${ctx.user.id}`] ??= { events: {}, quiet_hours: true, whatsapp_number: null, devices: 0 });
    s.devices += 1;
    return json({ data: { id: uid() } }, { status: 201 });
  })),
  http.delete(`${BASE}/push-subscriptions`, withAuth({ allowWhenReadOnly: true }, () => json({ data: { removed: 1 } }))),

  // ---------- inbox
  http.get(`${BASE}/conversations`, withAuth({}, (ctx, _r, _p, db) => {
    const rows = db.conversations
      .filter((c) => c.workspace_id === ctx.ws.id && (ctx.isManager || c.assigned_to === ctx.user.id))
      .sort((a, b) => b.last_message_at.localeCompare(a.last_message_at))
      .map((cv) => {
        const c = db.contacts.find((x) => x.id === cv.contact_id);
        const msgs = db.messages.filter((m) => m.conversation_id === cv.id).sort((a, b) => a.sent_at.localeCompare(b.sent_at));
        return { ...cv, contact: c ? { id: c.id, name: c.name, phone_e164: c.phone_e164 } : null, last_message: msgs.at(-1) ?? null };
      });
    return json({ data: rows });
  })),

  http.get(`${BASE}/conversations/:id/messages`, withAuth({}, (ctx, _r, p, db) => {
    const cv = db.conversations.find((c) => c.id === p.id && c.workspace_id === ctx.ws.id);
    if (!cv) return json({ error: 'Conversation not found' }, { status: 404 });
    return json({ data: db.messages.filter((m) => m.conversation_id === cv.id).sort((a, b) => a.sent_at.localeCompare(b.sent_at)) });
  })),

  http.post(`${BASE}/conversations/:id/messages`, withAuth({}, async (ctx, req, p, db) => {
    const cv = db.conversations.find((c) => c.id === p.id && c.workspace_id === ctx.ws.id);
    if (!cv) return json({ error: 'Conversation not found' }, { status: 404 });
    const b = await body<{ body?: string; type?: 'text' | 'template' }>(req);
    if (!b.body?.trim()) return json({ error: 'Message body is required' }, { status: 400 });
    const m = { id: uid(), workspace_id: ctx.ws.id, conversation_id: cv.id, direction: 'outbound' as const, type: b.type ?? 'text', body: b.body.trim(), media_url: null, wa_message_id: `wamid.mock.${Date.now()}`, status: 'sent', sent_at: nowIso() };
    db.messages.push(m);
    cv.last_message_at = m.sent_at;
    const c = db.contacts.find((x) => x.id === cv.contact_id);
    if (c) markResponded(c);
    return json({ message: m }, { status: 201 });
  })),

  http.post(`${BASE}/conversations/:id/read`, withAuth({ allowWhenReadOnly: true }, (ctx, _r, p, db) => {
    const cv = db.conversations.find((c) => c.id === p.id && c.workspace_id === ctx.ws.id);
    if (cv) cv.unread_count = 0;
    return json({ data: { unread_count: 0 } });
  })),

  http.post(`${BASE}/whatsapp/click-log`, withAuth({}, async (ctx, req, _p, db) => {
    const b = await body<{ contact_id?: string; prefill_text?: string }>(req);
    const c = db.contacts.find((x) => x.id === b.contact_id && x.workspace_id === ctx.ws.id);
    if (!c) return json({ error: 'Contact not found' }, { status: 404 });
    markResponded(c);
    activity(db, ctx.ws.id, c.id, 'whatsapp', ctx.user.id, `WhatsApp opened${b.prefill_text ? `: “${b.prefill_text.slice(0, 80)}”` : ''}`, { click_to_chat: true });
    return json({ wa_url: `https://wa.me/${c.phone_e164.replace('+', '')}?text=${encodeURIComponent(b.prefill_text ?? '')}`, logged: true });
  })),

  http.get(`${BASE}/whatsapp/saved-replies`, withAuth({}, () =>
    json({ data: [
      { id: 'r1', title: 'Thanks', body: 'Thanks for your enquiry! When is a good time to call you?' },
      { id: 'r2', title: 'Details', body: 'Sharing the full details now. Let me know if you have any questions.' },
      { id: 'r3', title: 'Book a meeting', body: 'Would you like to book a meeting this week? I have slots on Tuesday and Thursday.' },
      { id: 'r4', title: 'Follow up', body: 'Just checking in. Are you still interested?' },
    ] }),
  )),
  http.get(`${BASE}/whatsapp/templates`, withAuth({}, () =>
    json({ data: [
      { name: 'welcome_lead', language: 'en', body: 'Hi {{1}}, thanks for contacting us! An advisor will reach out shortly.', params: 1 },
      { name: 'appointment_reminder', language: 'en', body: 'Hi {{1}}, a reminder of your appointment on {{2}}.', params: 2 },
      { name: 'reengage', language: 'en', body: 'Hi {{1}}, are you still looking? We have new options that match your needs.', params: 1 },
    ] }),
  )),

  // ---------- reports
  http.get(`${BASE}/reports/:name`, withAuth({}, (ctx, req, p, db) => {
    const tz = ctx.ws.timezone;
    const { from, to, inRange } = reportRange(req, tz);
    const q = query(req);
    const agentFilter = ctx.isManager ? q.get('agent_id') : ctx.user.id;
    const contacts = db.contacts.filter((c) => c.workspace_id === ctx.ws.id && !c.deleted_at && (!agentFilter || c.owner_id === agentFilter) && (!q.get('source') || c.source === q.get('source')));
    const stagesById = new Map(db.stages.map((s) => [s.id, s]));
    const deals = db.deals.filter((d) => d.workspace_id === ctx.ws.id && !d.deleted_at && (!agentFilter || d.owner_id === agentFilter) && (!q.get('pipeline_id') || d.pipeline_id === q.get('pipeline_id')));
    const users = db.users;
    const team = db.memberships.filter((m) => m.workspace_id === ctx.ws.id && m.status === 'active' && (!agentFilter || m.user_id === agentFilter));
    const median = (xs: number[]) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
    const p90 = (xs: number[]) => (xs.length ? xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))] : null);
    const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

    switch (p.name) {
      case 'sources': {
        const inR = contacts.filter((c) => inRange(c.created_at));
        const bySource = new Map<string, number>();
        const byDay = new Map<string, number>();
        for (const c of inR) {
          bySource.set(c.source, (bySource.get(c.source) ?? 0) + 1);
          const k = `${localDay(c.created_at, tz)}|${c.source}`;
          byDay.set(k, (byDay.get(k) ?? 0) + 1);
        }
        return json({ data: {
          from, to, total: inR.length,
          by_source: [...bySource].map(([source, leads]) => ({ source, leads, new: leads, reenquiries: 0 })).sort((a, b) => b.leads - a.leads),
          by_day: [...byDay].map(([k, leads]) => ({ day: k.split('|')[0], source: k.split('|')[1], leads })).sort((a, b) => a.day.localeCompare(b.day)),
        } });
      }
      case 'speed-to-lead': {
        const inR = contacts.filter((c) => inRange(c.created_at));
        const shape = (list: MContact[]) => {
          const s = list.filter((c) => c.first_response_at).map((c) => (Date.parse(c.first_response_at!) - Date.parse(c.created_at)) / 1000);
          return { leads: list.length, responded: s.length, median_seconds: median([...s]), p90_seconds: p90([...s]), within_5_min: s.filter((x) => x <= 300).length, within_1_hour: s.filter((x) => x <= 3600).length, response_rate_pct: pct(s.length, list.length) };
        };
        return json({ data: {
          from, to, overall: shape(inR),
          by_agent: team.map((m) => ({ agent_id: m.user_id, agent_name: users.find((u) => u.id === m.user_id)?.name ?? null, ...shape(inR.filter((c) => c.owner_id === m.user_id)) })).filter((r) => r.leads > 0),
        } });
      }
      case 'funnel': {
        const pipeline = db.pipelines.find((x) => x.id === q.get('pipeline_id')) ?? db.pipelines.find((x) => x.workspace_id === ctx.ws.id);
        if (!pipeline) return fail(404, 'pipeline_not_found', 'Pipeline not found');
        const stages = db.stages.filter((s) => s.pipeline_id === pipeline.id).sort((a, b) => a.position - b.position);
        const inR = deals.filter((d) => d.pipeline_id === pipeline.id && inRange(d.created_at));
        const pos = (d: MDeal) => stagesById.get(d.stage_id)!;
        const openStages = stages.filter((s) => s.kind === 'open');
        const rows = stages.map((s) => {
          const current = inR.filter((d) => d.stage_id === s.id).length;
          const reached = s.kind === 'open' ? inR.filter((d) => pos(d).kind !== 'open' || pos(d).position >= s.position).length : current;
          return { id: s.id, name: s.name, kind: s.kind, position: s.position, reached, current };
        });
        const won = rows.filter((r) => r.kind === 'won').reduce((a, r) => a + r.current, 0);
        const lost = rows.filter((r) => r.kind === 'lost').reduce((a, r) => a + r.current, 0);
        return json({ data: {
          from, to, pipeline: { id: pipeline.id, name: pipeline.name }, deals: inR.length, won, lost, open: inR.length - won - lost, win_rate_pct: pct(won, won + lost),
          stages: rows.map((r, i) => ({ ...r, conversion_from_previous_pct: i > 0 && r.kind === 'open' && openStages.length ? pct(r.reached, rows[i - 1].reached) : null })),
        } });
      }
      case 'agents': {
        return json({ data: { from, to, agents: team.map((m) => {
          const mine = contacts.filter((c) => c.owner_id === m.user_id);
          const won = deals.filter((d) => d.owner_id === m.user_id && stagesById.get(d.stage_id)?.kind === 'won' && inRange(d.stage_entered_at));
          return {
            agent_id: m.user_id, agent_name: users.find((u) => u.id === m.user_id)?.name ?? null, role: m.role,
            assigned: mine.filter((c) => inRange(c.created_at)).length,
            contacted: mine.filter((c) => inRange(c.first_response_at)).length,
            follow_ups_done: db.tasks.filter((t) => t.workspace_id === ctx.ws.id && t.assigned_to === m.user_id && t.status === 'done' && inRange(t.completed_at)).length,
            overdue: db.tasks.filter((t) => t.workspace_id === ctx.ws.id && t.assigned_to === m.user_id && t.status === 'open' && Date.parse(t.due_at) < Date.now()).length,
            deals_won: won.length,
            won_value_minor: won.reduce((a, d) => a + d.value_minor, 0), currency: ctx.ws.region.currency,
          };
        }) } });
      }
      case 'won-value': {
        const won = deals.filter((d) => stagesById.get(d.stage_id)?.kind === 'won' && inRange(d.stage_entered_at));
        const months = new Map<string, { deals: number; value_minor: number }>();
        for (const d of won) {
          const k = localDay(d.stage_entered_at, tz).slice(0, 7);
          const m = months.get(k) ?? { deals: 0, value_minor: 0 };
          m.deals++;
          m.value_minor += d.value_minor;
          months.set(k, m);
        }
        const list = [...months].map(([month, m]) => ({ month, ...m, currency: ctx.ws.region.currency })).sort((a, b) => a.month.localeCompare(b.month));
        return json({ data: { from, to, currency: ctx.ws.region.currency, total_value_minor: list.reduce((a, m) => a + m.value_minor, 0), total_deals: won.length, months: list } });
      }
      case 'lost-reasons': {
        const lost = deals.filter((d) => stagesById.get(d.stage_id)?.kind === 'lost' && inRange(d.stage_entered_at));
        const map = new Map<string, { deals: number; value_minor: number }>();
        for (const d of lost) {
          const k = d.lost_reason?.trim() || 'Not specified';
          const m = map.get(k) ?? { deals: 0, value_minor: 0 };
          m.deals++;
          m.value_minor += d.value_minor;
          map.set(k, m);
        }
        return json({ data: { from, to, total_deals: lost.length, reasons: [...map].map(([reason, m]) => ({ reason, ...m, currency: ctx.ws.region.currency, share_pct: pct(m.deals, lost.length) })).sort((a, b) => b.deals - a.deals) } });
      }
      default:
        return fail(404, 'not_found', 'Unknown report');
    }
  })),

  // ---------- public lead capture (website form / webhook)
  http.post(`${BASE}/hooks/leads/:key`, async ({ request, params }) => {
    await latency();
    const db = getDb();
    const src = db.lead_sources.find((s) => s.public_key === params.key && s.is_active);
    if (!src) return fail(404, 'not_found', 'Unknown or inactive source');
    const ws = db.workspaces.find((w) => w.id === src.workspace_id)!;
    const b = await body<Record<string, string>>(request);
    if (b._hp) return HttpResponse.json({ ok: true, status: 'accepted', contact_id: null }, { status: 201 });
    const e164 = normalizePhone(b.phone ?? b.mobile, ws.region.default_phone_country);
    if (!e164) return fail(422, 'invalid_phone', 'No usable phone number');
    const existing = db.contacts.find((c) => c.workspace_id === ws.id && c.phone_e164 === e164 && !c.deleted_at);
    if (existing) {
      existing.last_enquiry_at = nowIso();
      activity(db, ws.id, existing.id, 'system', null, `Re-enquired via ${src.name}`, { kind: 're_enquiry', source_label: src.source_label });
      persist();
      return HttpResponse.json({ ok: true, status: 'reenquiry', contact_id: existing.id }, { status: 201 });
    }
    const now = nowIso();
    const owner = nextOwner(db, ws);
    const c: MContact = {
      id: uid(), workspace_id: ws.id, name: (b.name || b.full_name || e164).trim(), phone_e164: e164, alt_phone: null, email: b.email || null, source: src.source_label,
      owner_id: owner, status: 'new', tags: [], custom: {}, last_activity_at: now, created_at: now, updated_at: now, deleted_at: null, last_enquiry_at: now,
      first_response_at: null, last_response_at: null, sample: false,
    };
    db.contacts.unshift(c);
    activity(db, ws.id, c.id, 'system', null, `Lead received from ${src.name}${b.message ? `: ${b.message}` : ''}`, { kind: 'lead_received', source_label: src.source_label });
    for (const m of db.memberships.filter((x) => x.workspace_id === ws.id && (owner ? x.user_id === owner : x.role !== 'agent'))) {
      notify(db, ws.id, m.user_id, owner ? 'lead.assigned' : 'lead.unassigned', `New lead: ${c.name}`, { contact_id: c.id }, 'urgent');
    }
    persist();
    return HttpResponse.json({ ok: true, status: 'created', contact_id: c.id }, { status: 201 });
  }),

  // ---------- lead sources
  http.get(`${BASE}/lead-sources`, withAuth({ managerOnly: true }, (ctx, req, _p, db) =>
    json({ data: db.lead_sources.filter((s) => s.workspace_id === ctx.ws.id).map((s) => leadSourceOut(req, s)) }),
  )),
  http.post(`${BASE}/lead-sources`, withAuth({ managerOnly: true }, async (ctx, req, _p, db) => {
    const b = await body<{ type: string; name: string; source_label?: string; settings?: Record<string, unknown>; meta?: { page_id: string } }>(req);
    if (!b.name?.trim()) return fail(422, 'validation_failed', 'Request is invalid', [{ path: 'name', message: 'Required' }]);
    const defaults: Record<string, string> = { website_form: 'website', webhook: 'webhook', meta_leadgen: 'facebook', manual: 'manual' };
    const s = {
      id: uid(), workspace_id: ctx.ws.id, type: b.type, name: b.name.trim(), source_label: b.source_label || defaults[b.type] || 'manual',
      public_key: `ls_${Math.random().toString(36).slice(2, 10)}`, is_active: true, settings: { ...(b.settings ?? {}), ...(b.meta ? { page_id: b.meta.page_id } : {}) },
      secret: b.type === 'webhook' ? `whsec_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}` : null, created_at: nowIso(),
    };
    db.lead_sources.push(s);
    return json({ data: { ...leadSourceOut(req, s), secret: s.secret ?? undefined } }, { status: 201 });
  })),
  http.patch(`${BASE}/lead-sources/:id`, withAuth({ managerOnly: true }, async (ctx, req, p, db) => {
    const s = db.lead_sources.find((x) => x.id === p.id && x.workspace_id === ctx.ws.id);
    if (!s) return fail(404, 'not_found', 'Lead source not found');
    const b = await body<{ name?: string; is_active?: boolean; rotate_secret?: boolean; settings?: Record<string, unknown> }>(req);
    if (b.name) s.name = b.name;
    if (typeof b.is_active === 'boolean') s.is_active = b.is_active;
    if (b.settings) s.settings = { ...s.settings, ...b.settings };
    let secret: string | undefined;
    if (b.rotate_secret && s.type === 'webhook') {
      secret = `whsec_${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
      s.secret = secret;
    }
    return json({ data: { ...leadSourceOut(req, s), secret } });
  })),

  // ---------- assignment
  http.get(`${BASE}/assignment-rules`, withAuth({}, (ctx, _r, _p, db) => json({ data: assignmentOut(db, ctx.ws) }))),
  http.put(`${BASE}/assignment-rules`, withAuth({ managerOnly: true }, async (ctx, req, _p, db) => {
    const b = await body<Record<string, unknown>>(req);
    db.assignment[ctx.ws.id] = {
      mode: String(b.mode ?? 'manual'), agent_ids: (b.agent_ids as string[]) ?? [], source_map: (b.source_map as Record<string, string[]>) ?? {},
      fallback: String(b.fallback ?? 'round_robin'), reassign_after_minutes: (b.reassign_after_minutes as number) ?? null, max_auto_reassigns: Number(b.max_auto_reassigns ?? 2),
    };
    return json({ data: assignmentOut(db, ctx.ws) });
  })),
  http.put(`${BASE}/availability`, withAuth({ allowWhenReadOnly: true }, async (ctx, req, _p, db) => {
    const b = await body<{ available: boolean; user_id?: string }>(req);
    const target = b.user_id ?? ctx.user.id;
    if (target !== ctx.user.id && !ctx.isManager) return fail(403, 'forbidden', 'Agents can only change their own availability');
    db.availability[`${ctx.ws.id}:${target}`] = b.available;
    return json({ data: { user_id: target, available: b.available } });
  })),

  // ---------- automations
  http.get(`${BASE}/automations`, withAuth({}, (ctx, _r, _p, db) =>
    json({ data: AUTOMATION_CATALOG.map((def) => {
      const row = db.automations.find((a) => a.workspace_id === ctx.ws.id && a.key === def.key);
      return { key: def.key, name: def.name, description: def.description, triggers: def.triggers, enabled: row?.enabled ?? false, settings: { ...def.defaults, ...(row?.settings ?? {}) }, settings_schema: def.settings_schema, last_run_at: row?.last_run_at ?? null, runs_7d: row?.runs_7d ?? 0, failed_7d: row?.failed_7d ?? 0 };
    }) }),
  )),
  http.patch(`${BASE}/automations/:key`, withAuth({ managerOnly: true }, async (ctx, req, p, db) => {
    const def = AUTOMATION_CATALOG.find((d) => d.key === p.key);
    if (!def) return fail(404, 'not_found', 'Unknown automation');
    const b = await body<{ enabled?: boolean; settings?: Record<string, unknown> }>(req);
    let row = db.automations.find((a) => a.workspace_id === ctx.ws.id && a.key === p.key);
    if (!row) {
      row = { workspace_id: ctx.ws.id, key: def.key, enabled: false, settings: {}, last_run_at: null, runs_7d: 0, failed_7d: 0 };
      db.automations.push(row);
    }
    const settings = { ...def.defaults, ...row.settings, ...(b.settings ?? {}) };
    const enabled = b.enabled ?? row.enabled;
    if (enabled && (def.key === 'welcome_message' || (def.key === 'won_notice' && settings.send_thank_you)) && !settings.template_name) {
      return fail(422, 'incomplete_settings', 'Choose a WhatsApp template before switching this on');
    }
    row.settings = settings;
    row.enabled = enabled;
    return json({ data: { key: row.key, enabled: row.enabled, settings: row.settings } });
  })),

  // ---------- imports
  http.post(`${BASE}/imports`, withAuth({}, async (ctx, req, _p, db) => {
    const b = await body<{ rows?: Record<string, string>[]; mapping?: Record<string, string>; duplicate_strategy?: 'skip' | 'update'; file_name?: string; phone_country?: string }>(req);
    const rows = b.rows ?? [];
    if (!rows.length) return json({ error: 'No rows found in import payload' }, { status: 400 });
    const m = b.mapping ?? {};
    const errors: { row: number; phone?: string; reason: string }[] = [];
    let ok = 0;
    rows.forEach((r, i) => {
      const phoneRaw = r[m.phone ?? 'phone'];
      const e164 = normalizePhone(phoneRaw, b.phone_country ?? ctx.ws.region.default_phone_country);
      const name = (r[m.name ?? 'name'] ?? '').trim();
      if (!e164) return errors.push({ row: i + 2, phone: phoneRaw, reason: 'Invalid phone number' });
      if (!name) return errors.push({ row: i + 2, phone: phoneRaw, reason: 'Name is missing' });
      const existing = db.contacts.find((c) => c.workspace_id === ctx.ws.id && c.phone_e164 === e164 && !c.deleted_at);
      const custom: Record<string, unknown> = {};
      for (const [field, col] of Object.entries(m)) if (field.startsWith('custom.') && r[col]) custom[field.slice(7)] = r[col];
      if (existing) {
        if (b.duplicate_strategy !== 'update') return errors.push({ row: i + 2, phone: e164, reason: 'Duplicate phone (skipped)' });
        existing.name = name;
        if (m.email && r[m.email]) existing.email = r[m.email];
        existing.custom = { ...existing.custom, ...custom };
        ok++;
        return;
      }
      const now = nowIso();
      db.contacts.unshift({
        id: uid(), workspace_id: ctx.ws.id, name, phone_e164: e164, alt_phone: null, email: (m.email && r[m.email]) || null, source: (m.source && r[m.source]) || 'import',
        owner_id: ctx.user.id, status: 'new', tags: (m.tags && r[m.tags] ? r[m.tags].split(/[|;,]/).map((t) => t.trim()).filter(Boolean) : []), custom,
        last_activity_at: now, created_at: now, updated_at: now, deleted_at: null, last_enquiry_at: null, first_response_at: null, last_response_at: null, sample: false,
      });
      ok++;
    });
    const job = { id: uid(), workspace_id: ctx.ws.id, file_url: '', file_name: b.file_name ?? 'import.csv', duplicate_strategy: b.duplicate_strategy ?? 'skip', mapping: m, status: 'completed', rows_ok: ok, rows_failed: errors.length, error_report_url: null, errors, created_at: nowIso() };
    db.imports.unshift(job);
    return json({ import_job: job }, { status: 201 });
  })),
  http.get(`${BASE}/imports/:id`, withAuth({}, (_ctx, _r, p, db) => {
    const job = db.imports.find((j) => j.id === p.id);
    return job ? json({ import_job: job }) : json({ error: 'Import not found' }, { status: 404 });
  })),

  // ---------- billing
  http.get(`${BASE}/billing/plans`, async () => {
    await latency();
    return json({ data: [
      { id: 'monthly', name: 'Monthly', billing_type: 'prepaid', period_months: 1, price_per_period_pkr: 49, price_per_month_pkr: 49 },
      { id: 'quarterly', name: 'Quarterly', billing_type: 'prepaid', period_months: 3, price_per_period_pkr: 135, price_per_month_pkr: 45 },
      { id: 'annual', name: 'Annual', billing_type: 'prepaid', period_months: 12, price_per_period_pkr: 470, price_per_month_pkr: 39 },
    ] });
  }),
  http.get(`${BASE}/billing/subscription`, async ({ request }) => {
    await latency();
    const db = getDb();
    const partnerId = request.headers.get('x-partner-id');
    const wsId = request.headers.get('x-workspace-id');
    const workspaces = partnerId ? db.workspaces.filter((w) => w.partner_id === partnerId) : db.workspaces.filter((w) => w.id === wsId);
    const ws = workspaces[0];
    if (!ws) return fail(403, 'forbidden', 'No billing account');
    const plan = ws.plan ?? 'monthly';
    const invoices = db.invoices.filter((i) => (partnerId ? i.partner_id === partnerId : i.workspace_id === wsId));
    const open = invoices.filter((i) => i.status !== 'paid');
    return json({ data: {
      subscription: { id: uid(), status: ws.status === 'trialing' ? 'trialing' : ws.status === 'read_only' ? 'read_only' : 'active', trial_ends_at: ws.status === 'trialing' ? new Date(Date.now() + 20 * 86400_000).toISOString() : null },
      plan: { id: plan, name: plan[0].toUpperCase() + plan.slice(1) }, pending_plan: null, pending_plan_effective: null, trial: null,
      workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, status: w.status })),
      outstanding_minor: open.reduce((a, i) => a + i.total_minor - i.paid_minor, 0), currency: ws.region.currency, overdue_invoices: open.filter((i) => i.due_date < nowIso().slice(0, 10)).map((i) => i.id),
    } });
  }),
  http.post(`${BASE}/billing/subscription`, async ({ request }) => {
    await latency();
    const db = getDb();
    const b = await body<{ plan_id: string }>(request);
    const wsId = request.headers.get('x-workspace-id');
    const partnerId = request.headers.get('x-partner-id');
    for (const w of db.workspaces) if (w.id === wsId || (partnerId && w.partner_id === partnerId)) w.plan = b.plan_id;
    persist();
    return json({ data: { plan_id: b.plan_id }, changed: true });
  }),
  http.get(`${BASE}/billing/invoices`, async ({ request }) => {
    await latency();
    const db = getDb();
    const partnerId = request.headers.get('x-partner-id');
    const wsId = request.headers.get('x-workspace-id');
    const list = db.invoices.filter((i) => (partnerId ? i.partner_id === partnerId : i.workspace_id === wsId)).sort((a, b) => b.issue_date.localeCompare(a.issue_date));
    return json({ data: list.map((i) => ({ ...i, lines: [], payments: [] })) });
  }),
  http.post(`${BASE}/billing/payments`, async ({ request }) => {
    await latency();
    const b = await body<Record<string, unknown>>(request);
    if (!b.proof) return fail(422, 'proof_required', 'Attach the transfer screenshot');
    return json({ data: { id: uid(), status: 'pending' } }, { status: 201 });
  }),
  http.get(`${BASE}/billing/commission-statement`, async ({ request }) => {
    await latency();
    const db = getDb();
    const partnerId = request.headers.get('x-partner-id');
    const ws = db.workspaces.filter((w) => w.partner_id === partnerId);
    const month = query(request).get('month') ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 7);
    const rows = ws.map((w, i) => {
      const collected = (i + 2) * 120000;
      return { workspace_id: w.id, workspace_name: w.name, amount_collected_minor: collected, commission_minor: Math.round(collected * 0.3), currency: w.region.currency, floor_applied: false, status: 'reported' };
    });
    return json({ data: { month, applies: true, rate: 0.3, workspaces: rows, totals: { commission_minor: rows.reduce((a, r) => a + r.commission_minor, 0), currency: ws[0]?.region.currency ?? 'USD' } } });
  }),

  // ---------- partner
  http.get(`${BASE}/partner/workspaces`, async ({ request }) => {
    await latency();
    const db = getDb();
    const user = userFromRequest(request);
    if (!user?.partner_admin_of) return json({ error: 'Forbidden: partner admins only' }, { status: 403 });
    return json({ data: db.workspaces.filter((w) => w.partner_id === user.partner_admin_of).map((w) => ({
      ...w, country: w.region.country, billing_status: w.status, member_count: db.memberships.filter((m) => m.workspace_id === w.id && m.status === 'active').length,
    })) });
  }),
  http.post(`${BASE}/partner/workspaces`, async ({ request }) => {
    await latency();
    const db = getDb();
    const user = userFromRequest(request);
    if (!user?.partner_admin_of) return json({ error: 'Forbidden: partner admins only' }, { status: 403 });
    const b = await body<Record<string, unknown>>(request);
    const region = { ...regionFromCountry(String(b.country ?? 'US')), ...(b.region as object) };
    const ws: MWorkspace = {
      id: uid(), partner_id: user.partner_admin_of, name: String(b.name ?? 'New workspace'), template_key: String(b.template_key ?? 'general'), status: 'trialing',
      timezone: region.timezone, created_at: nowIso(), region, branding: (b.branding as Record<string, unknown>) ?? {}, has_samples: true, plan: 'commission',
    };
    db.workspaces.push(ws);
    seedTemplate(db, ws, ws.template_key);
    db.assignment[ws.id] = { mode: 'manual', agent_ids: [], source_map: {}, fallback: 'round_robin', reassign_after_minutes: null, max_auto_reassigns: 2 };
    seedSamples(db, ws, null);
    persist();
    return json({ workspace: ws }, { status: 201 });
  }),
  http.get(`${BASE}/partner/branding`, async ({ request }) => {
    await latency();
    const db = getDb();
    const user = userFromRequest(request);
    const partner = db.partners.find((p) => p.id === user?.partner_admin_of);
    if (!partner) return json({ error: 'Forbidden: partner admins only' }, { status: 403 });
    return json({ data: partner.branding });
  }),
  http.patch(`${BASE}/partner/branding`, async ({ request }) => {
    await latency();
    const db = getDb();
    const user = userFromRequest(request);
    const partner = db.partners.find((p) => p.id === user?.partner_admin_of);
    if (!partner) return json({ error: 'Forbidden: partner admins only' }, { status: 403 });
    const b = await body<{ branding?: Record<string, unknown> }>(request);
    partner.branding = { ...partner.branding, ...(b.branding ?? {}) };
    persist();
    return json({ partner });
  }),
  http.get(`${BASE}/partner/domains`, async ({ request }) => {
    await latency();
    const db = getDb();
    const user = userFromRequest(request);
    if (!user?.partner_admin_of) return json({ error: 'Forbidden' }, { status: 403 });
    return json({ data: db.domains.filter((d) => d.partner_id === user.partner_admin_of).map(domainOut) });
  }),
  http.post(`${BASE}/partner/domains`, async ({ request }) => {
    await latency();
    const db = getDb();
    const user = userFromRequest(request);
    if (!user?.partner_admin_of) return json({ error: 'Forbidden' }, { status: 403 });
    const b = await body<{ domain?: string }>(request);
    const domain = String(b.domain ?? '').trim().toLowerCase();
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(domain)) return json({ error: 'Enter a valid domain, for example crm.yourcompany.com' }, { status: 400 });
    if (db.domains.some((d) => d.domain === domain)) return json({ error: 'This domain is already connected' }, { status: 409 });
    const d = { id: uid(), partner_id: user.partner_admin_of, domain, verified: false, created_at: nowIso() };
    db.domains.push(d);
    persist();
    return json({ partner_domain: domainOut(d) }, { status: 201 });
  }),
  http.delete(`${BASE}/partner/domains/:id`, async ({ params }) => {
    await latency();
    const db = getDb();
    db.domains = db.domains.filter((d) => d.id !== params.id);
    persist();
    return json({ data: { removed: true } });
  }),
];

// ------------------------------------------------------------- shared shapes

function mockSession(db: MockDb, user: MockDb['users'][number]) {
  return {
    access_token: `mock.${user.id}`,
    refresh_token: `mock-refresh.${user.id}`,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'Bearer',
    user,
    memberships: db.memberships.filter((m) => m.user_id === user.id && m.status === 'active'),
  };
}

function domainOut(d: { id: string; domain: string; verified: boolean }) {
  return { ...d, dns: { type: 'CNAME', name: d.domain, value: 'cname.crm-platform.example' } };
}

function leadSourceOut(req: Request, s: MockDb['lead_sources'][number]) {
  const origin = new URL(req.url).origin;
  const endpoint = `${origin}/api/v1/hooks/leads/${s.public_key}`;
  const { secret: _secret, workspace_id: _w, ...rest } = s;
  return {
    ...rest,
    mapping: {},
    endpoint_url: s.type === 'webhook' || s.type === 'website_form' ? endpoint : null,
    embed_snippet: s.type === 'website_form'
      ? `<form data-crm-lead-form>\n  <input name="name" placeholder="Name" required>\n  <input name="phone" placeholder="Phone" required>\n  <input name="email" type="email" placeholder="Email">\n  <textarea name="message" placeholder="Message"></textarea>\n  <button type="submit">Send</button>\n</form>\n<script src="${origin}/embed/lead-form.js" data-key="${s.public_key}" async></script>`
      : null,
  };
}

function assignmentOut(db: MockDb, ws: MWorkspace) {
  const rules = db.assignment[ws.id] ?? { mode: 'manual', agent_ids: [], source_map: {}, fallback: 'round_robin', reassign_after_minutes: null, max_auto_reassigns: 2 };
  return {
    ...rules,
    members: db.memberships.filter((m) => m.workspace_id === ws.id && m.status === 'active').map((m) => ({
      user_id: m.user_id, name: db.users.find((u) => u.id === m.user_id)?.name ?? null, role: m.role, available: db.availability[`${ws.id}:${m.user_id}`] !== false,
    })),
  };
}

function notificationSettings(db: MockDb, ctx: Ctx) {
  const s = db.notification_settings[`${ctx.ws.id}:${ctx.user.id}`] ?? { events: {}, quiet_hours: true, whatsapp_number: null, devices: 0 };
  return {
    events: NOTIFICATION_TYPES.map((t) => ({ type: t.type, label: t.label, in_app: true, push: s.events[t.type]?.push ?? true, whatsapp: s.events[t.type]?.whatsapp ?? t.whatsapp })),
    quiet_hours: s.quiet_hours, quiet_hours_window: '23:00-08:00', whatsapp_number: s.whatsapp_number, whatsapp_number_effective: s.whatsapp_number ?? ctx.user.phone,
    push: { vapid_public_key: null, devices: s.devices },
  };
}

/** A handful of sample leads, deals and follow-ups for a new workspace. */
function seedSamples(db: MockDb, ws: MWorkspace, ownerId: string | null) {
  const names = ['Alex Morgan', 'Jordan Lee', 'Sam Patel', 'Taylor Brooks', 'Casey Kim'];
  const pipeline = db.pipelines.find((p) => p.workspace_id === ws.id);
  const stages = db.stages.filter((s) => s.pipeline_id === pipeline?.id).sort((a, b) => a.position - b.position);
  names.forEach((name, i) => {
    const now = new Date(Date.now() - i * 3 * 3600_000).toISOString();
    const c: MContact = {
      id: uid(), workspace_id: ws.id, name, phone_e164: samplePhone(ws.region.default_phone_country, i), alt_phone: null, email: null, source: ['website', 'facebook', 'referral', 'manual', 'website'][i],
      owner_id: ownerId, status: 'new', tags: [], custom: {}, last_activity_at: now, created_at: now, updated_at: now, deleted_at: null, last_enquiry_at: now,
      first_response_at: null, last_response_at: null, sample: true,
    };
    db.contacts.push(c);
    if (pipeline && stages[i % Math.max(1, stages.length - 2)]) {
      db.deals.push({
        id: uid(), workspace_id: ws.id, pipeline_id: pipeline.id, stage_id: stages[i % Math.max(1, stages.length - 2)].id, contact_id: c.id, title: `${name.split(' ')[0]}: first deal`,
        value_minor: (i + 1) * 250000, currency: ws.region.currency, owner_id: ownerId, expected_close: null, lost_reason: null, won_reason: null, custom: {},
        stage_entered_at: now, created_at: now, updated_at: now, deleted_at: null, sample: true,
      });
    }
    if (ownerId) {
      db.tasks.push({ id: uid(), workspace_id: ws.id, contact_id: c.id, deal_id: null, assigned_to: ownerId, created_by: ownerId, type: 'call', title: `Call ${name.split(' ')[0]}`, notes: null, due_at: new Date(Date.now() + (i - 1) * 3600_000).toISOString(), status: 'open', completed_at: null, outcome: null, origin: 'manual', parent_task_id: null });
    }
  });
}

const SAMPLE_PREFIX: Record<string, string> = { US: '+1212555', AE: '+97150555', GB: '+447700900', PK: '+92300555', IN: '+9198765', SA: '+96650555', CA: '+1416555' };
function samplePhone(country: string, i: number) {
  return `${SAMPLE_PREFIX[country] ?? '+1212555'}${String(1900 + i).padStart(4, '0')}`;
}

// ------------------------------------------------------------- demo observability

function seeded(n: number) {
  const x = Math.sin(n * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

function demoStatus() {
  const now = Date.now();
  const hourly = Array.from({ length: 24 }, (_, i) => {
    const hour = new Date(Math.floor(now / 3_600_000) * 3_600_000 - (23 - i) * 3_600_000).toISOString();
    const requests = Math.round(80 + seeded(i) * 220 + (i > 8 && i < 20 ? 200 : 0));
    const p50 = Math.round(60 + seeded(i + 50) * 50);
    return { hour, requests, errors: seeded(i + 99) > 0.85 ? Math.round(seeded(i) * 4) + 1 : 0, p50_ms: p50, p95_ms: Math.round(p50 * (2.4 + seeded(i + 7))) };
  });
  const days = (key: string) => Array.from({ length: 30 }, (_, i) => {
    const day = new Date(Math.floor(now / 86_400_000) * 86_400_000 - (29 - i) * 86_400_000).toISOString();
    const r = seeded(i + key.length * 31);
    return { day, uptime: i < 4 ? null : r > 0.94 ? 0.97 : 1, avg_ms: Math.round(40 + r * 60) };
  });
  const keys = ['api', 'database', 'auth', 'storage', 'jobs'] as const;
  return {
    overall: 'degraded',
    checked_at: new Date(now).toISOString(),
    components: [
      { key: 'api', state: 'up', latency_ms: null },
      { key: 'database', state: 'up', latency_ms: 38 },
      { key: 'auth', state: 'up', latency_ms: 112 },
      { key: 'storage', state: 'up', latency_ms: 96 },
      { key: 'jobs', state: 'degraded', latency_ms: null },
    ],
    api: { requests_24h: hourly.reduce((a, h) => a + h.requests, 0), error_rate_24h: 0.0042, p50_ms: 84, p95_ms: 241, hourly },
    history: Object.fromEntries(keys.map((k) => [k, days(k)])),
  };
}

const DEMO_ROUTES: [string, string, number][] = [
  ['GET', '/api/v1/contacts?limit=50', 200], ['GET', '/api/v1/me', 200], ['POST', '/api/v1/leads/quick-add', 201],
  ['GET', '/api/v1/tasks?due=today', 200], ['POST', '/api/v1/deals/7f3c2a10-0000-4000-8000-000000000001/move', 200],
  ['GET', '/api/v1/reports/funnel', 200], ['POST', '/api/v1/auth/login', 401], ['PATCH', '/api/v1/contacts/7f3c2a10-0000-4000-8000-000000000002', 422],
  ['GET', '/api/v1/conversations', 200], ['POST', '/api/v1/webhooks/whatsapp', 200], ['GET', '/api/v1/reports/agents', 500],
];

function demoLogs(url: URL) {
  const status = url.searchParams.get('status') ?? 'all';
  const before = Number(url.searchParams.get('before') ?? 100000);
  const q = (url.searchParams.get('q') ?? '').toLowerCase();
  const rows = Array.from({ length: 300 }, (_, i) => {
    const id = 100000 - i;
    const [method, path, st] = DEMO_ROUTES[Math.floor(seeded(i) * DEMO_ROUTES.length)];
    const signedIn = !path.includes('/auth/') && !path.includes('webhooks');
    return {
      id: String(id), at: new Date(Date.now() - i * 47_000).toISOString(), request_id: `iad1::demo-${id}`, method,
      route: path.split('?')[0].replace(/[0-9a-f-]{36}/, ':id'), path, status: st,
      duration_ms: Math.round(st === 500 ? 2300 : 30 + seeded(i + 3) ** 3 * 900),
      error_code: st === 401 ? 'invalid_credentials' : st === 422 ? 'validation_failed' : st === 500 ? 'internal' : null,
      ip: '203.0.113.0', user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', region: 'iad1',
      user_id: signedIn ? 'u-demo' : null, user_name: signedIn ? 'Sarah Khan' : null, user_email: signedIn ? 'sarah@example.com' : null,
      workspace_id: signedIn ? 'w-demo' : null, workspace_name: signedIn ? 'Skyline Realty' : null,
    };
  }).filter((r) => Number(r.id) < before)
    .filter((r) => status === 'all' || (status === 'errors' ? r.status >= 400 : String(r.status)[0] === status[0]))
    .filter((r) => !q || `${r.path} ${r.error_code ?? ''} ${r.user_email ?? ''}`.toLowerCase().includes(q));
  const page = rows.slice(0, 100);
  return {
    data: page,
    next_before: rows.length > 100 ? page[page.length - 1].id : null,
    summary: {
      requests: 1284, server_errors: 3, client_errors: 41, p50_ms: 84, p95_ms: 241, users: 12,
      slowest_routes: [
        { method: 'GET', route: '/api/v1/reports/agents', requests: 64, errors: 3, p95_ms: 1840 },
        { method: 'GET', route: '/api/v1/reports/funnel', requests: 88, errors: 0, p95_ms: 620 },
        { method: 'POST', route: '/api/v1/leads/quick-add', requests: 132, errors: 2, p95_ms: 410 },
        { method: 'GET', route: '/api/v1/contacts', requests: 512, errors: 0, p95_ms: 260 },
        { method: 'POST', route: '/api/v1/deals/:id/move', requests: 97, errors: 1, p95_ms: 190 },
      ],
    },
  };
}

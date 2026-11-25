import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admin, call, createUser, team } from './helpers';
import { setGoTrue, type GoTrue } from '@/server/identity/gotrue';
import * as signup from '@/app/api/v1/auth/signup/route';
import * as login from '@/app/api/v1/auth/login/route';
import * as refresh from '@/app/api/v1/auth/refresh/route';
import * as forgot from '@/app/api/v1/auth/forgot/route';
import * as verifyEmail from '@/app/api/v1/auth/verify/route';
import * as me from '@/app/api/v1/me/route';
import * as workspaces from '@/app/api/v1/workspaces/route';
import * as settings from '@/app/api/v1/workspaces/[id]/settings/route';
import * as clearSamples from '@/app/api/v1/workspaces/[id]/clear-samples/route';
import * as members from '@/app/api/v1/workspaces/[id]/members/route';
import * as branding from '@/app/api/v1/branding/route';
import * as contacts from '@/app/api/v1/contacts/route';
import * as contact from '@/app/api/v1/contacts/[id]/route';
import * as dupCheck from '@/app/api/v1/contacts/check-duplicate/route';
import * as assign from '@/app/api/v1/contacts/[id]/assign/route';
import * as merge from '@/app/api/v1/contacts/[id]/merge/route';
import * as notes from '@/app/api/v1/contacts/[id]/notes/route';
import * as calls from '@/app/api/v1/contacts/[id]/calls/route';
import * as timeline from '@/app/api/v1/contacts/[id]/timeline/route';
import * as summary from '@/app/api/v1/contacts/[id]/summary/route';
import * as pipelines from '@/app/api/v1/pipelines/route';
import * as stages from '@/app/api/v1/pipelines/[id]/stages/route';
import * as stageDel from '@/app/api/v1/pipelines/[id]/stages/[stageId]/route';
import * as reasons from '@/app/api/v1/pipelines/[id]/reasons/route';
import * as deals from '@/app/api/v1/deals/route';
import * as deal from '@/app/api/v1/deals/[id]/route';
import * as move from '@/app/api/v1/deals/[id]/move/route';
import * as fields from '@/app/api/v1/custom-fields/route';
import * as exportsRoute from '@/app/api/v1/exports/route';
import * as imports from '@/app/api/v1/imports/route';
import * as invites from '@/app/api/v1/invites/route';
import * as memberships from '@/app/api/v1/memberships/[id]/route';
import * as waHook from '@/app/api/v1/webhooks/whatsapp/route';
import * as conversations from '@/app/api/v1/conversations/route';
import * as views from '@/app/api/v1/saved-views/route';
import * as view from '@/app/api/v1/saved-views/[id]/route';
import * as partnerWs from '@/app/api/v1/partner/workspaces/route';
import * as partnerBranding from '@/app/api/v1/partner/branding/route';
import { createHmac } from 'node:crypto';

// ------------------------------------------------------------------ fake Supabase Auth

const accounts = new Map<string, { id: string; password: string; confirmed: boolean }>();
const fakeAuth: GoTrue = {
  async signUp(email, password, name) {
    if (accounts.has(email)) return { session: null, userId: null };
    const id = randomUUID();
    accounts.set(email, { id, password, confirmed: false });
    await admin`insert into auth.users (id, email, raw_user_meta_data) values (${id}, ${email}, ${admin.json({ name })})`;
    return { session: null, userId: id };
  },
  async signIn(email, password) {
    const a = accounts.get(email);
    const { ApiError } = await import('@/server/http');
    if (!a || a.password !== password) throw new ApiError(401, 'invalid_credentials', 'Email or password is incorrect');
    if (!a.confirmed) throw new ApiError(403, 'email_not_confirmed', 'Please confirm your email first.');
    return { access_token: `at-${a.id}`, refresh_token: `rt-${a.id}`, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: a.id, email } };
  },
  async refresh(rt) {
    const id = rt.replace('rt-', '');
    return { access_token: `at2-${id}`, refresh_token: `rt-${id}`, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id, email: null } };
  },
  recover: async () => {},
  resend: async () => {},
  async verifyEmailCode(email, code) {
    const a = accounts.get(email);
    const { ApiError } = await import('@/server/http');
    if (!a || code !== '123456') throw new ApiError(422, 'invalid_code', 'That code is wrong or has expired.');
    a.confirmed = true;
    return { access_token: `at-${a.id}`, refresh_token: `rt-${a.id}`, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: a.id, email, user_metadata: { name: 'Nadia Khan' } } };
  },
  updatePassword: async () => {},
  signOut: async () => {},
  async invite(email, name) {
    const id = randomUUID();
    await admin`insert into auth.users (id, email, raw_user_meta_data) values (${id}, ${email}, ${admin.json({ name })})`;
    return { userId: id };
  },
};
beforeAll(() => setGoTrue(fakeAuth));
afterAll(() => setGoTrue(fakeAuth));

const email = () => `user-${randomUUID().slice(0, 8)}@example.com`;

describe('email auth', () => {
  it('signs up (verify email), creates the profile, then signs in once confirmed', async () => {
    const e = email();
    const r = await call(signup.POST, { method: 'POST', body: { email: e, password: 'correct horse 1', name: 'Nadia Khan' } });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ status: 'verify_email', email: e });
    const [u] = await admin`select name, email, phone from public.users where email = ${e}`;
    expect(u).toEqual({ name: 'Nadia Khan', email: e, phone: null });

    expect((await call(login.POST, { method: 'POST', body: { email: e, password: 'correct horse 1' } })).body.error.code).toBe('email_not_confirmed');
    accounts.get(e)!.confirmed = true;
    expect((await call(login.POST, { method: 'POST', body: { email: e, password: 'wrong' } })).status).toBe(401);
    const ok = await call(login.POST, { method: 'POST', body: { email: e.toUpperCase(), password: 'correct horse 1' } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ access_token: expect.any(String), refresh_token: expect.any(String), user: { name: 'Nadia Khan' }, memberships: [] });

    const rf = await call(refresh.POST, { method: 'POST', body: { refresh_token: ok.body.refresh_token } });
    expect(rf.body.access_token).toMatch(/^at2-/);
  });

  it('confirms a new account with the emailed code and signs in', async () => {
    const e = email();
    await call(signup.POST, { method: 'POST', body: { email: e, password: 'correct horse 1', name: 'Nadia Khan' } });
    expect((await call(verifyEmail.POST, { method: 'POST', body: { email: e, code: 'abc' } })).status).toBe(422);
    const wrong = await call(verifyEmail.POST, { method: 'POST', body: { email: e, code: '000000' } });
    expect(wrong.body.error.code).toBe('invalid_code');
    const ok = await call(verifyEmail.POST, { method: 'POST', body: { email: e.toUpperCase(), code: ' 123456 ' } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ access_token: expect.any(String), user: { name: 'Nadia Khan' }, memberships: [] });
    expect((await call(login.POST, { method: 'POST', body: { email: e, password: 'correct horse 1' } })).status).toBe(200);
  });

  it('rejects weak input and never reveals whether an email exists', async () => {
    expect((await call(signup.POST, { method: 'POST', body: { email: 'nope', password: 'short', name: '' } })).status).toBe(422);
    expect((await call(forgot.POST, { method: 'POST', body: { email: 'nobody@example.com' } })).body).toEqual({ sent: true });
  });
});

describe('onboarding and workspace settings', () => {
  let owner: string;
  let wsId: string;

  it('creates a UAE workspace with region defaults, template and samples', async () => {
    owner = await createUser('Omar');
    const r = await call(workspaces.POST, { method: 'POST', as: owner, body: { name: 'Dubai Homes', template_key: 'real_estate', country: 'AE', seed_samples: true } });
    expect(r.status).toBe(201);
    wsId = r.body.workspace.id;
    expect(r.body.workspace).toMatchObject({ country: 'AE', currency: 'AED', timezone: 'Asia/Dubai', default_phone_country: 'AE', has_samples: true });
    const m = await call(me.GET, { as: owner });
    expect(m.body).toMatchObject({ effective_role: 'owner', active_workspace: { id: wsId }, memberships: [{ workspace_id: wsId, role: 'owner' }] });
    const p = await call(pipelines.GET, { as: owner, ws: wsId });
    expect(p.body.data.map((x: { name: string }) => x.name)).toEqual(['Sales', 'Rentals']);
    const c = await call(contacts.GET, { as: owner, ws: wsId });
    expect(c.body.pagination.total_visible).toBeGreaterThan(3);
    expect(c.body.data[0].phone_e164).toMatch(/^\+971/);
  });

  it('updates region, branding and business phone; branding merges over the partner default', async () => {
    const r = await call(settings.PATCH, {
      method: 'PATCH', as: owner, ws: wsId, params: { id: wsId },
      body: { country: 'GB', business_phone: '020 7946 0958', branding: { primaryColor: '#0e7c66', font: 'Inter', appName: 'Dubai Homes CRM' } },
    });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ country: 'GB', currency: 'GBP', timezone: 'Europe/London', business_phone: '+442079460958', branding: { primaryColor: '#0E7C66', font: 'Inter' } });
    expect((await call(settings.PATCH, { method: 'PATCH', as: owner, ws: wsId, params: { id: wsId }, body: { branding: { primaryColor: 'red' } } })).status).toBe(422);
    const side = await call(settings.PATCH, { method: 'PATCH', as: owner, ws: wsId, params: { id: wsId }, body: { branding: { sidebarColor: '#ffffff' } } });
    expect(side.body.data.branding.sidebarColor).toBe('#FFFFFF');
    expect((await call(settings.PATCH, { method: 'PATCH', as: owner, ws: wsId, params: { id: wsId }, body: { branding: { sidebarColor: 'white' } } })).status).toBe(422);
    expect((await call(settings.PATCH, { method: 'PATCH', as: owner, ws: wsId, params: { id: wsId }, body: { timezone: 'Mars/Base' } })).status).toBe(422);
    const b = await call(branding.GET, { query: { workspace_id: wsId } });
    expect(b.body.branding).toMatchObject({ primaryColor: '#0E7C66', font: 'Inter', appName: 'Dubai Homes CRM' });
    // null removes the override
    await call(settings.PATCH, { method: 'PATCH', as: owner, ws: wsId, params: { id: wsId }, body: { branding: { font: null } } });
    expect((await call(branding.GET, { query: { workspace_id: wsId } })).body.branding.font).not.toBe('Inter');
  });

  it('clears sample data', async () => {
    const r = await call(clearSamples.POST, { method: 'POST', as: owner, ws: wsId, params: { id: wsId } });
    expect(r.body.data.removed).toBeGreaterThan(3);
    expect((await call(contacts.GET, { as: owner, ws: wsId })).body.data).toEqual([]);
  });

  it('invites by email and manages roles; the last owner stays', async () => {
    const r = await call(invites.POST, { method: 'POST', as: owner, ws: wsId, body: { email: email(), name: 'Agent Ana', role: 'agent' } });
    expect(r.status).toBe(201);
    expect(r.body.invited).toBe(true);
    const list = await call(members.GET, { as: owner, ws: wsId, params: { id: wsId } });
    expect(list.body.data.map((x: { user: { name: string } }) => x.user.name)).toEqual(['Omar', 'Agent Ana']);
    const ana = list.body.data[1];
    expect((await call(memberships.PATCH, { method: 'PATCH', as: owner, ws: wsId, params: { id: ana.id }, body: { role: 'manager' } })).body.membership.role).toBe('manager');
    expect((await call(memberships.PATCH, { method: 'PATCH', as: owner, ws: wsId, params: { id: list.body.data[0].id }, body: { role: 'agent' } })).status).toBe(409);
  });
});

describe('contacts, deals and pipelines', () => {
  let t: Awaited<ReturnType<typeof team>>;
  let pipelineId: string;
  let stageIds: Record<string, string>;
  beforeAll(async () => {
    t = await team('Core Realty');
    const p = await call(pipelines.POST, { method: 'POST', as: t.manager, ws: t.ws, body: { name: 'Sales' } });
    pipelineId = p.body.pipeline.id;
    stageIds = Object.fromEntries(p.body.pipeline.stages.map((s: { name: string; id: string }) => [s.name, s.id]));
  });

  it('creates contacts with local numbers, blocks duplicates, and hides other agents\' leads', async () => {
    const a = await call(contacts.POST, { method: 'POST', as: t.ali, ws: t.ws, body: { name: 'Hamza', phone: '0300 1234567' } });
    expect(a.status).toBe(201);
    expect(a.body.contact).toMatchObject({ phone_e164: '+923001234567', owner_id: t.ali, status: 'new' });
    const dup = await call(contacts.POST, { method: 'POST', as: t.sara, ws: t.ws, body: { name: 'H', phone: '+92 300 1234567' } });
    expect(dup.status).toBe(409);
    expect(dup.body.error.details.visible).toBe(false);
    const check = await call(dupCheck.GET, { as: t.sara, ws: t.ws, query: { phone: '03001234567' } });
    expect(check.body).toMatchObject({ duplicate_found: true, existing_contact: { name: null, owner_id: t.ali } });
    expect((await call(contact.GET, { as: t.sara, ws: t.ws, params: { id: a.body.contact.id } })).status).toBe(404);
    expect((await call(contacts.GET, { as: t.sara, ws: t.ws })).body.data).toEqual([]);
    expect((await call(contacts.GET, { as: t.manager, ws: t.ws, query: { q: '1234' } })).body.data).toHaveLength(1);
  });

  it('notes, calls (speed to lead), assignment, timeline, merge', async () => {
    const c = (await call(contacts.POST, { method: 'POST', as: t.manager, ws: t.ws, body: { name: 'Zara', phone: '03211112222', owner_id: t.sara } })).body.contact;
    expect((await call(notes.POST, { method: 'POST', as: t.sara, ws: t.ws, params: { id: c.id }, body: { body: 'Wants 2 beds' } })).status).toBe(201);
    expect((await call(calls.POST, { method: 'POST', as: t.sara, ws: t.ws, params: { id: c.id }, body: { outcome: 'no_answer' } })).status).toBe(201);
    const after = (await call(contact.GET, { as: t.sara, ws: t.ws, params: { id: c.id } })).body.contact;
    expect(after.status).toBe('contacted');
    expect(after.first_response_at).not.toBeNull();
    const as = await call(assign.POST, { method: 'POST', as: t.manager, ws: t.ws, params: { id: c.id }, body: { user_id: t.bilal } });
    expect(as.body.data).toEqual({ contact_id: c.id, owner_id: t.bilal, changed: true });
    const sum = await call(summary.GET, { as: t.manager, ws: t.ws, params: { id: c.id } });
    expect(sum.body.data.activity).toMatchObject({ calls: 1, notes: 1 });
    expect(sum.body.data.contact.first_response_at).not.toBeNull();
    const tl = await call(timeline.GET, { as: t.manager, ws: t.ws, params: { id: c.id } });
    expect(tl.body.data.map((a: { type: string }) => a.type)).toEqual(expect.arrayContaining(['note', 'call', 'assignment']));
    const other = (await call(contacts.POST, { method: 'POST', as: t.manager, ws: t.ws, body: { name: 'Zara (old)', phone: '03211113333', tags: ['vip'] } })).body.contact;
    const merged = await call(merge.POST, { method: 'POST', as: t.manager, ws: t.ws, params: { id: c.id }, body: { secondary_contact_id: other.id } });
    expect(merged.body.contact).toMatchObject({ alt_phone: '+923211113333', tags: ['vip'] });
  });

  it('deals: create, next follow-up, move with reasons, stages and reasons admin', async () => {
    const c = (await call(contacts.POST, { method: 'POST', as: t.ali, ws: t.ws, body: { name: 'Bilqis', phone: '03331234567' } })).body.contact;
    const d = await call(deals.POST, { method: 'POST', as: t.ali, ws: t.ws, body: { contact_id: c.id, pipeline_id: pipelineId, title: 'Villa', value_minor: 1_500_000_00 } });
    expect(d.status).toBe(201);
    expect(d.body.deal).toMatchObject({ stage_id: stageIds.New, currency: 'PKR', value_minor: 1_500_000_00, contact: { name: 'Bilqis' } });
    const id = d.body.deal.id;
    expect((await call(move.POST, { method: 'POST', as: t.ali, ws: t.ws, params: { id }, body: { stage_id: stageIds.Lost } })).body.error.code).toBe('lost_reason_required');
    const won = await call(move.POST, { method: 'POST', as: t.ali, ws: t.ws, params: { id }, body: { stage_id: stageIds.Won, won_reason: 'Best price' } });
    expect(won.body.deal).toMatchObject({ stage_id: stageIds.Won, won_reason: 'Best price' });
    const [job] = await admin`select name from public.jobs where payload ->> 'deal_id' = ${id} and name = 'deal.won'`;
    expect(job).toBeDefined();
    expect((await call(deal.PATCH, { method: 'PATCH', as: t.ali, ws: t.ws, params: { id }, body: { value_minor: 99 } })).body.deal.value_minor).toBe(99);
    expect((await call(deals.GET, { as: t.sara, ws: t.ws, query: { pipeline_id: pipelineId } })).body.data).toEqual([]);

    const st = await call(stages.POST, { method: 'POST', as: t.manager, ws: t.ws, params: { id: pipelineId }, body: { name: 'Viewing' } });
    expect(st.body.stage.position).toBe(3); // before Won
    await call(move.POST, { method: 'POST', as: t.ali, ws: t.ws, params: { id }, body: { stage_id: st.body.stage.id } });
    expect((await call(stageDel.DELETE, { method: 'DELETE', as: t.manager, ws: t.ws, params: { id: pipelineId, stageId: st.body.stage.id } })).status).toBe(422);
    const del = await call(stageDel.DELETE, { method: 'DELETE', as: t.manager, ws: t.ws, params: { id: pipelineId, stageId: st.body.stage.id }, query: { move_to: stageIds.New } });
    expect(del.body.data.moved_deals).toBe(1);
    const rs = await call(reasons.PUT, { method: 'PUT', as: t.manager, ws: t.ws, params: { id: pipelineId }, body: { won: ['Location', 'Location', ''], lost: ['Budget'] } });
    expect(rs.body.data).toEqual({ won: ['Location'], lost: ['Budget'] });
    expect((await call(reasons.PUT, { method: 'PUT', as: t.ali, ws: t.ws, params: { id: pipelineId }, body: { won: [] } })).status).toBe(403);
  });

  it('custom fields, validated on contacts; export and import', async () => {
    const f = await call(fields.POST, { method: 'POST', as: t.manager, ws: t.ws, body: { entity: 'contact', label: 'Budget', type: 'money' } });
    expect(f.body.custom_field).toMatchObject({ key: 'budget', type: 'money' });
    const bad = await call(contacts.POST, { method: 'POST', as: t.ali, ws: t.ws, body: { name: 'X', phone: '03451234567', custom: { budget: 'lots' } } });
    expect(bad.status).toBe(422);
    const imp = await call(imports.POST, {
      method: 'POST', as: t.manager, ws: t.ws,
      body: { mapping: { name: 'Name', phone: 'Mobile', 'custom.budget': 'Budget' }, rows: [
        { Name: 'Imported One', Mobile: '0312 7654321', Budget: '5000000' },
        { Name: '', Mobile: '03127654322' },
        { Name: 'Bad', Mobile: '12' },
        { Name: 'Again', Mobile: '+92 312 7654321' },
      ] },
    });
    expect(imp.body.import_job).toMatchObject({ rows_ok: 1, rows_failed: 3 });
    const [c] = await admin`select custom from public.contacts where phone_e164 = '+923127654321' and workspace_id = ${t.ws}`;
    expect(c.custom).toEqual({ budget: 5000000 });
    const ex = await call(exportsRoute.POST, { method: 'POST', as: t.manager, ws: t.ws, body: { entity: 'contacts' } });
    expect(ex.body.csv_content.split('\n')[0]).toBe('"Name","Phone","Email","Source","Status","Tags","Owner","Budget","Created"');
  });
});

describe('WhatsApp inbox webhook', () => {
  it('stores inbound messages once, creates the lead, and lists the chat', async () => {
    const t = await team('Inbox Co');
    const pnid = `pn-${randomUUID()}`;
    await admin`insert into public.whatsapp_accounts (workspace_id, phone_number_id, waba_id, token_ciphertext, status)
                values (${t.ws}, ${pnid}, 'waba', 'x', 'connected')`;
    const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
      metadata: { phone_number_id: pnid },
      contacts: [{ wa_id: '923009998888', profile: { name: 'Sana' } }],
      messages: [{ id: `wamid.${randomUUID()}`, from: '923009998888', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Is it available?' } }],
    } }] }] });
    const sig = `sha256=${createHmac('sha256', process.env.META_APP_SECRET!).update(payload).digest('hex')}`;
    const send = () => call(waHook.POST, { method: 'POST', rawBody: payload, headers: { 'x-hub-signature-256': sig, 'content-type': 'application/json' } });
    expect((await send()).body.results).toEqual(['stored']);
    expect((await send()).body.results).toEqual(['duplicate']);
    expect((await call(waHook.POST, { method: 'POST', rawBody: payload, headers: { 'x-hub-signature-256': 'sha256=bad' } })).status).toBe(401);
    const list = await call(conversations.GET, { as: t.manager, ws: t.ws });
    expect(list.body.data[0]).toMatchObject({ unread_count: 1, contact: { name: 'Sana', phone_e164: '+923009998888' }, last_message: { body: 'Is it available?', direction: 'inbound' } });
  });
});

describe('partner admin', () => {
  it('creates client workspaces and sets default branding', async () => {
    const [p] = await admin<{ id: string }[]>`insert into public.partners (name, slug) values ('Sky', ${`sky-${randomUUID()}`}) returning id`;
    const pa = await createUser('Partner Pat');
    await admin`update public.users set partner_admin_of = ${p.id} where id = ${pa}`;
    const outsider = await createUser('Nobody');
    expect((await call(partnerWs.GET, { as: outsider })).status).toBe(403);
    const w = await call(partnerWs.POST, { method: 'POST', as: pa, body: { name: 'Client A', region: { country: 'US' } } });
    expect(w.body.workspace).toMatchObject({ partner_id: p.id, currency: 'USD' });
    await call(partnerBranding.PATCH, { method: 'PATCH', as: pa, body: { branding: { appName: 'Sky CRM', primaryColor: '#123456' } } });
    const b = await call(branding.GET, { query: { workspace_id: w.body.workspace.id } });
    expect(b.body).toMatchObject({ partner: { id: p.id }, branding: { appName: 'Sky CRM', primaryColor: '#123456' } });
    const m = await call(me.GET, { as: pa, ws: w.body.workspace.id });
    expect(m.body.effective_role).toBe('partner_admin');
  });
});

describe('internal functions', () => {
  it('signed-in users cannot call enqueue_job or create_notification directly (REST rpc)', async () => {
    const t = await team('Locked Co');
    const tryAs = (sql: string) => admin.begin(async (tx) => {
      await tx.unsafe('set local role authenticated');
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: t.ali, role: 'authenticated' })}, true)`;
      return tx.unsafe(sql);
    });
    await expect(tryAs(`select public.enqueue_job('notification.deliver', '{}'::jsonb, null, now(), null, null)`)).rejects.toThrow(/permission denied/);
    await expect(tryAs(`select public.create_notification('${t.ws}', '${t.sara}', 'lead.assigned', 'x', null, '{}'::jsonb, 'normal', null)`)).rejects.toThrow(/permission denied/);
  });
});

describe('saved views and new list filters', () => {
  it('saves personal and shared views; filters by age and awaiting reply', async () => {
    const t = await team('Views Co');
    const mine = await call(views.POST, { method: 'POST', as: t.ali, ws: t.ws, body: { name: 'My hot leads', filters: { owner: 'me', tag: 'hot' } } });
    expect(mine.status).toBe(201);
    expect((await call(views.POST, { method: 'POST', as: t.ali, ws: t.ws, body: { name: 'Team', filters: {}, shared: true } })).status).toBe(403);
    await call(views.POST, { method: 'POST', as: t.manager, ws: t.ws, body: { name: 'Unassigned this week', filters: { owner: 'none', created_within_days: 7 }, shared: true } });
    const list = await call(views.GET, { as: t.sara, ws: t.ws });
    expect(list.body.data.map((v: { name: string }) => v.name)).toEqual(['Unassigned this week']);
    expect((await call(view.DELETE, { method: 'DELETE', as: t.sara, ws: t.ws, params: { id: mine.body.data.id } })).status).toBe(404);
    expect((await call(view.DELETE, { method: 'DELETE', as: t.ali, ws: t.ws, params: { id: mine.body.data.id } })).status).toBe(200);

    const fresh = (await call(contacts.POST, { method: 'POST', as: t.manager, ws: t.ws, body: { name: 'Fresh', phone: '03001112233' } })).body.contact;
    const old = (await call(contacts.POST, { method: 'POST', as: t.manager, ws: t.ws, body: { name: 'Old', phone: '03001112244' } })).body.contact;
    await admin`update public.contacts set created_at = now() - interval '20 days' where id = ${old.id}`;
    const recent = await call(contacts.GET, { as: t.manager, ws: t.ws, query: { created_within_days: '7' } });
    expect(recent.body.data.map((c: { id: string }) => c.id)).toEqual([fresh.id]);
    await call(calls.POST, { method: 'POST', as: t.manager, ws: t.ws, params: { id: old.id }, body: { outcome: 'answered' } });
    const waiting = await call(contacts.GET, { as: t.manager, ws: t.ws, query: { awaiting: 'true' } });
    expect(waiting.body.data.map((c: { id: string }) => c.id)).toEqual([fresh.id]);
  });
});

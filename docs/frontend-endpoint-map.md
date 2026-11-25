# Frontend endpoint map

What every screen in `docs/CRM_BRIEF.md` (section 8) calls, the state of each endpoint at commit `59002ff`, and what the backend still needs to deliver. Keep this file current: any MSW mock that is still in use must be listed under [Missing](#missing).

> **Out of date (2026-11-23):** the sandbox store (`lib/taimoor/store.ts`), the developer workbench (`/dev/workbench`) and the `/system/inspector` and `/rls/verify` routes have been removed. Every route now runs on Postgres with Supabase auth. Sections below that mention them describe the earlier state.

**Store** says where the route reads and writes today:
- **Sandbox**: Taimoor's in-memory store (`lib/taimoor/store.ts`, saved to `/tmp/taimoor_core_state_v1.json`). Auth is `Bearer taimoor_tok_<userId>` or `x-sandbox-user-id`. With no token it acts as the seeded owner. Errors are `{ error: "text" }`.
- **Postgres**: Huzaifa's routes (`server/http.ts` `userRoute` / `authRoute`). They need a Supabase JWT plus `X-Workspace-Id`. Errors are `{ error: { code, message, details } }`.

**Status:** Ready = usable as is. Needs change = exists, but is missing something the brief requires (see the [backend audit](#2-brief-section-12-backend-audit)). Missing = no endpoint yet; the frontend uses an MSW mock.

## How the frontend talks to the API

- `lib/api/client.ts`: one request function. It adds `Authorization` and `X-Workspace-Id`, and parses **both** error shapes into `ApiError { status, code, message, details }`. Sandbox errors get a code derived from the status (`unauthorized`, `forbidden`, `not_found`, `conflict`, `validation_failed`).
- `lib/api/endpoints/*`: one typed function per endpoint. Each adapts the backend shape to the frontend model in `lib/api/types.ts`, which is the single place to change when a shape changes.
- **Generated types:** `npm run gen:api` writes `lib/api/schema/core.d.ts` from `/api/v1/openapi.json` and `lib/api/schema/huzaifa.d.ts` from `openapi/huzaifa.yaml`. Taimoor's spec has paths but **no response schemas** (every response is `"Successful JSON response"`), so sandbox shapes are typed by hand in `lib/api/types.ts`, taken from `lib/taimoor/types.ts` and the route handlers. Huzaifa's schemas (Task, Notification, HomeSummary, Automation, LeadSource and others) are re-exported from the generated file.
- **Why there's no `openapi-fetch`:** it only adds type safety when the spec has response schemas. With half the spec untyped it would give `unknown` for most calls, so `lib/api` stays a thin typed wrapper. Switch once the shared spec has schemas.

### Mock modes (`NEXT_PUBLIC_API_MOCKING`)

| Value | What is mocked | When to use it |
|---|---|---|
| `missing` | Only the endpoints under [Missing](#missing) | Default whenever a database is configured |
| `all` | Every `/api/v1` call (in-browser fake backend seeded with the 4 test workspaces) | Local development with no Supabase credentials; demos; Playwright |
| `off` | Nothing | Once the backend covers every Missing item |

**Why `all` exists (a deviation from the brief):** the brief allows MSW only for missing endpoints. But no Supabase credentials are checked in, so every Postgres route (home, follow-ups, notifications, reports, automations, lead sources, assignment, billing) returns 500 locally. And the sandbox data (Pakistan, PKR) never matches the Postgres data. Without `all`, half of every screen errors on a fresh checkout. When neither `SUPABASE_DB_URL` nor `DATABASE_URL` is set in development, the default is `all`. The handlers return the **same shapes as the real routes**, plus the fields requested in section 12, so turning mocks off only exercises the adapters.

## 1. Screens → endpoints

### Auth and session

| Screen | Endpoint | Method | Key request | Key response | Store | Status |
|---|---|---|---|---|---|---|
| Login: send code | `/auth/otp/send` | POST | `phone` | `challenge_id, expires_at` (dev: `debug_code`) | Sandbox | Needs change (PK-only phone; sandbox) |
| Login: verify | `/auth/otp/verify` | POST | `phone, code` | `access_token` (`taimoor_tok_*`), `user, memberships` | Sandbox | Needs change (real session, #7) |
| Sign up: confirm email | `/auth/verify` | POST | `email, code` (6–10 digits from the sign-up email) | same as `/auth/login`; `invalid_code` (422) when wrong or expired | Supabase Auth | Ready. Needs `{{ .Token }}` in the Supabase "Confirm signup" email template |
| Session bootstrap | `/me` | GET | — | `user, active_workspace, effective_role, memberships[]` | Sandbox | Needs change (no `is_super_admin`; region fields) |
| Branding | `/branding` | GET | `workspace_id` or `host` | `partner, workspace, matched_domain, branding` | Sandbox | Needs change (#8) |

### Onboarding (8.1)

| Screen | Endpoint | Method | Key request | Key response | Store | Status |
|---|---|---|---|---|---|---|
| Templates | `/system/inspector` → `industry_templates` | GET | — | templates with pipelines and fields | Sandbox | Missing as a public endpoint; using `GET /templates` (mock) |
| Create workspace | `/workspaces` | POST | `name, template_key, seed_samples` (+ region, mocked) | `workspace` | Sandbox | Needs change (region #1, `agency` template #4) |
| Invite team | `/invites` | POST | `phone/email, name, role` | `membership` | Sandbox | Ready |
| Sign in as (owners) | `/workspaces/{id}/sign-in-as` | POST / DELETE | `user_id` | `sign_in_as { id, expires_at, user }`; send `id` as `x-sign-in-as` on later requests | Postgres | Ready |
| Clear sample data | — | — | — | — | — | Missing (`POST /workspaces/{id}/clear-samples`) |

### Home (8.2)

| Block | Endpoint | Method | Key request | Key response | Store | Status |
|---|---|---|---|---|---|---|
| Follow-ups, new leads, counts | `/home/summary` | GET | `scope=me\|team` | `tasks{overdue,due_today,next[]}, leads{new_today,recent[]}, speed_to_lead_today` | Postgres | Ready |
| Pipeline snapshot | `/pipelines` + `/deals` | GET | — | stages; deals with `value_pkr` | Sandbox | Needs change (money #3; no per-stage totals) |
| Team today | `/reports/agents?from=today&to=today` | GET | — | per agent: assigned, contacted, follow-ups done, overdue | Postgres | Ready (calls count is approximated by "contacted") |

### Leads (8.3) and Contact detail (8.4)

| Screen | Endpoint | Method | Key request | Key response | Store | Status |
|---|---|---|---|---|---|---|
| List | `/contacts` | GET | `q, source, owner, tag, status, cursor, limit` | `data[], pagination{next_cursor,total_visible}` | Sandbox | Ready |
| Create (quick add) | `/leads/quick-add` | POST | `name, phone, email, note, assign_to, source_label, tags` (+ `voice`) | `data{contact_id,status,contact}` | Postgres | Needs change (#2 phone) |
| Duplicate check | `/contacts/check-duplicate` | GET | `phone` (+ `country`, requested) | `duplicate_found, existing_contact` | Sandbox | Needs change (#2) |
| Detail | `/contacts/{id}` | GET, PATCH, DELETE | `name, email, tags, status, custom` | `contact` | Sandbox | Ready |
| Timeline | `/contacts/{id}/timeline` | GET | `cursor, limit` | `data[] activities` | Sandbox | Ready |
| Note | `/contacts/{id}/notes` | POST | `body, deal_id` | `activity` | Sandbox | Ready |
| Call log | `/contacts/{id}/calls` | POST | `outcome, note, duration_sec, deal_id` | `activity` | Sandbox | Ready |
| Merge | `/contacts/{id}/merge` | POST | `secondary_contact_id` | `contact` | Sandbox | Ready |
| Assign | `/contacts/{id}/assign` | POST | `user_id` | `data{owner_id,changed}` | Postgres | Ready (different store from the contact, #6) |
| Bulk tag / bulk assign | `/contacts/{id}` PATCH / `/contacts/{id}/assign`, per contact | — | — | — | Mixed | Needs change (no bulk endpoint; frontend loops, max 100) |
| Export | `/exports` | POST | `entity` | CSV text | Sandbox | Ready |
| Custom field defs | `/custom-fields` | GET | `entity` | `data[]` (`label_en`, `type`, `options`) | Sandbox | Ready |
| Team members (owner picker) | `/workspaces/{id}/members` | GET | — | `data[] {user, membership}` | Sandbox | Ready |

### Pipeline (8.5)

| Action | Endpoint | Method | Key request | Key response | Store | Status |
|---|---|---|---|---|---|---|
| Pipelines + stages | `/pipelines` | GET | — | `data[] {…, stages[]}` | Sandbox | Ready |
| Deals | `/deals` | GET | `pipeline_id, stage_id, owner` | `data[]` (`value_pkr`, `stage_entered_at`) | Sandbox | Needs change (money #3; next follow-up not joined) |
| Move | `/deals/{id}/move` | POST | `stage_id, lost_reason` | `deal` | Sandbox | Needs change (`won_reason` not stored) |
| Create deal | `/deals` | POST | `contact_id, pipeline_id, stage_id, title, value_pkr` | `deal` | Sandbox | Needs change (#3) |
| Won/Lost reason presets | — | — | — | — | — | Missing (`GET/PUT /pipelines/{id}/reasons`) |

### Follow-ups (8.6)

| Action | Endpoint | Method | Key request | Key response | Store | Status |
|---|---|---|---|---|---|---|
| Buckets | `/tasks` | GET | `due=today\|overdue\|upcoming, assigned_to, contact_id` | `data[] TaskWithContact, next_cursor` | Postgres | Ready (timezone comes from the workspace on the server) |
| Create | `/tasks` | POST | `contact_id, type, due_at, title` | `data Task` | Postgres | Ready |
| Reschedule | `/tasks/{id}` | PATCH | `due_at` | task | Postgres | Ready |
| Complete + next | `/tasks/{id}/complete` | POST | `outcome, note, next{due_at,type}` | `data{task,next}` | Postgres | Ready |
| Call outcome | `/contacts/{id}/calls` then `/tasks/{id}/complete` | POST | outcome `answered\|no_answer\|busy\|wrong_number` | — | Mixed | Ready (two stores, #6) |

### Inbox (8.7)

| Action | Endpoint | Method | Key request | Key response | Store | Status |
|---|---|---|---|---|---|---|
| List | `/conversations` | GET | — | `data[] {contact, last_message, unread_count, assigned_to}` | Sandbox | Ready (no Mine/Unassigned filter: filtered on the client) |
| Messages | `/conversations/{id}/messages` | GET, POST | `body, type` | `data[]` / `message` | Sandbox | Ready (POST behind `NEXT_PUBLIC_WHATSAPP_CLOUD_API`) |
| Click-to-chat log | `/whatsapp/click-log` | POST | `contact_id, prefill_text` | `wa_url` | Sandbox | Needs change (builds a PK-only `wa.me` URL; the frontend builds its own from E.164) |
| Saved replies / templates | — | — | — | — | — | Missing (`GET /whatsapp/saved-replies`, `GET /whatsapp/templates`) |
| Mark read | — | — | — | — | — | Missing (`POST /conversations/{id}/read`) |

### Notifications (8.8)

| Action | Endpoint | Method | Store | Status |
|---|---|---|---|---|
| List + unread | `GET /notifications?unread=` | GET | Postgres | Ready |
| Mark read | `POST /notifications/read {ids}\|{all:true}` | POST | Postgres | Ready |
| Preferences | `GET/PUT /notification-settings` | GET, PUT | Postgres | Ready |
| Push | `POST/DELETE /push-subscriptions` | POST, DELETE | Postgres | Ready |

### Reports (8.9)

| Report | Endpoint | Store | Status |
|---|---|---|---|
| Leads by source | `GET /reports/sources?from&to&agent_id` | Postgres | Ready |
| Speed to lead | `GET /reports/speed-to-lead` | Postgres | Ready |
| Funnel | `GET /reports/funnel?pipeline_id` | Postgres | Ready |
| Agents | `GET /reports/agents` | Postgres | Ready |
| Won value | `GET /reports/won-value` | Postgres | Needs change (`*_pkr` fields, #3) |
| Lost reasons | `GET /reports/lost-reasons` | Postgres | Needs change (`value_pkr`, #3) |
| Export | Client-side CSV of the loaded report | — | Ready |

### Settings (8.10)

| Page | Endpoint | Store | Status |
|---|---|---|---|
| Workspace and region | `GET/PATCH /workspaces/{id}/settings` | — | **Missing** (#1) |
| Pipelines and stages | `GET/POST /pipelines`, `GET/POST/PATCH /pipelines/{id}/stages` | Sandbox | Needs change (no stage delete, no reorder batch: PATCH per stage) |
| Custom fields | `GET/POST /custom-fields`, `PATCH /custom-fields/{id}` | Sandbox | Ready |
| Team | `GET /workspaces/{id}/members`, `POST /invites`, `PATCH /memberships/{id}` | Sandbox | Ready |
| Lead sources | `GET/POST /lead-sources`, `PATCH /lead-sources/{id}` | Postgres | Ready |
| Assignment | `GET/PUT /assignment-rules`, `PUT /availability` | Postgres | Ready (no per-agent working hours) |
| Automations | `GET /automations`, `PATCH /automations/{key}` | Postgres | Ready |
| Import | `POST /imports {csv_text, mapping, duplicate_strategy}`, `GET /imports/{id}` | Sandbox | Needs change (phone country #2; XLSX parsed on the client) |
| Export | `POST /exports {entity}` | Sandbox | Ready |
| Notifications | `/notification-settings` | Postgres | Ready |
| Branding | `PATCH /partner/branding` (partner), workspace branding via `PATCH /workspaces/{id}/settings` | Sandbox | Needs change (#8; no workspace branding endpoint) |
| Billing | `GET /billing/subscription`, `/billing/plans`, `/billing/invoices`, `POST /billing/payments` | Postgres | Needs change (`*_pkr`, #3) |

### Partner admin (8.12)

| Action | Endpoint | Store | Status |
|---|---|---|---|
| Client workspaces | `GET /partner/workspaces` | Sandbox | Needs change (no status, plan, seats or country: joined from `/billing/subscription` workspaces) |
| Create client workspace | `POST /partner/workspaces` | Sandbox | Needs change (#1 region) |
| Branding | `PATCH /partner/branding` | Sandbox | Needs change (#8) |
| Domains | `POST /partner/domains` | Sandbox | Needs change (no list, delete or verification status endpoint; `*.crm.pk` only) |
| Impersonate | Switch `X-Workspace-Id` (partner admins pass membership checks on both stores) | Both | Ready |
| Billing + commission | `GET /billing/subscription`, `GET /billing/commission-statement` (`X-Partner-Id`) | Postgres | Needs change (#3) |

## 2. Brief section 12: backend audit

| # | Item | Supported today? | Evidence |
|---|---|---|---|
| 1 | Workspace region settings | **No.** Only `timezone` (default `Asia/Karachi`) and `locale: 'en'\|'ur'` | `supabase/migrations/001_core_schema.sql:47`; `lib/taimoor/types.ts` `Workspace` |
| 2 | E.164 for any country | **No.** Normalizer is Pakistan-only ("expected +923XXXXXXXXX") | `lib/taimoor/phone.ts:18-125`; Huzaifa reuses it (`server/core/phone.ts`) |
| 3 | Money as amount + currency | **No.** `deals.value_pkr`, reports `*_pkr`, billing `*_pkr` | `lib/taimoor/types.ts` `Deal.value_pkr`; `openapi/huzaifa.yaml:666,688,721` |
| 4 | Generic templates + Agency | **No.** Keys `society`, `plot_size`, `bayana_date`, `budget_pkr`; templates `real_estate, law, distributor, clinic, general` only; `label_ur` required | `lib/taimoor/templates.ts`; `lib/taimoor/types.ts:4` |
| 5 | ISO UTC + workspace timezone buckets | **Partly.** Huzaifa: yes (`/tasks` due buckets and reports use the workspace timezone). Sandbox: ISO UTC, but no timezone-aware filtering | `openapi/huzaifa.yaml:22,275-278` |
| 6 | One data store | **No.** 36 sandbox routes vs 19 Postgres routes | `docs/for-taimoor.md` §1 |
| 7 | Real auth | **No.** `taimoor_tok_<userId>`, `x-sandbox-user-id`, default owner when no token, fixed code `482910` | `lib/taimoor/auth.ts:24-40`; `app/api/v1/auth/otp/verify/route.ts` |
| 8 | Branding `accent_color`, `support_email`, `hide_modules`, any domain | **No.** `BrandingConfig` has `primaryColor, primaryHover, surfaceTint, inkColor, logoText, supportWhatsapp` | `lib/taimoor/types.ts` `BrandingConfig` |
| 9 | One error shape | **No.** Sandbox `{ error: "text" }`; Postgres `{ error: { code, message, details } }` | `app/api/v1/contacts/route.ts`; `server/http.ts:24` |

## 3. Lists to send to the backend team

### Missing

Each item below is served by an MSW handler in `mocks/handlers/missing.ts` (marked `TODO(backend)`) in **every** mock mode except `off`.

| Endpoint | For | Owner | Shape the frontend expects |
|---|---|---|---|
| `GET /workspaces/{id}/settings` | Region and workspace branding | Taimoor | `{ data: { country, locale, currency, timezone, date_format, time_format, week_starts_on, area_unit, default_phone_country, branding } }` |
| `PATCH /workspaces/{id}/settings` | Settings → Workspace and region; Branding | Taimoor | Partial of the above; returns the same |
| `GET /templates` | Onboarding business type | Taimoor | `{ data: [{ key, name, description, pipelines[{name, stages[{name, kind}]}], custom_fields[{entity,key,label,type,options}] }] }` |
| `POST /workspaces/{id}/clear-samples` | "Clear sample data" banner | Taimoor | `{ data: { removed: n } }` |
| `GET/PUT /pipelines/{id}/reasons` | Won/Lost reason presets | Taimoor | `{ data: { won: string[], lost: string[] } }` |
| `DELETE /pipelines/{id}/stages/{stageId}?move_to=` | Settings → Pipelines | Taimoor | `{ data: { moved_deals: n } }` |
| `GET /whatsapp/saved-replies` | Inbox chips | Taimoor | `{ data: [{ id, title, body }] }` |
| `GET /whatsapp/templates` | Inbox templates sheet | Taimoor | `{ data: [{ name, language, body, params }] }` |
| `POST /conversations/{id}/read` | Inbox unread | Taimoor | `{ data: { unread_count: 0 } }` |
| `GET /partner/branding` | Partner branding editor (only PATCH exists) | Taimoor | `{ data: BrandingConfig }` |
| `GET /partner/domains`, `DELETE /partner/domains/{id}` | Partner domains | Taimoor | `{ data: [{ id, domain, verified, dns: { type, name, value } }] }` |

### Needs change

1. **Region settings on the workspace** (#1), including the `POST /workspaces` and `POST /partner/workspaces` bodies.
2. **International phone numbers** (#2): `normalizePhoneToE164(input, defaultCountry)`; `check-duplicate?phone&country`; imports take `phone_country`. The frontend already sends E.164 (`+14155550123`), which the current normalizer rejects for non-PK numbers.
3. **Money** (#3): add `value_minor` + `currency` to deals; `amount_minor` + `currency` to reports, home and billing. Until then the frontend reads `value_pkr` as a whole-unit amount **in the workspace currency** (see `lib/api/adapters.ts`, `TODO(money)`).
4. **Templates** (#4): generic keys, an `agency` template, optional `label_ur`.
5. **Sandbox → Postgres** (#6): today a lead from `/leads/quick-add` (Postgres) doesn't show in `/contacts` (sandbox), and `/contacts/{id}/assign` (Postgres) doesn't change the sandbox owner.
6. **Real auth** (#7): the OTP verify response should return a Supabase session (`access_token`, `refresh_token`, `expires_at`). The frontend's session module already stores and refreshes these fields.
7. **Branding** (#8): `accentColor`, `supportEmail`, `hideModules`, `faviconUrl`, `logoUrl`.
8. **Errors** (#9): sandbox routes should return `{ error: { code, message } }`.
9. **`/me`**: add `is_super_admin` (from `platform_admins`) so the frontend can gate `/admin` and `/dev/workbench`.
10. **Deals list**: join `next_task_due_at` per deal (the pipeline card shows the next follow-up).
11. **Move deal**: accept and store `won_reason`.
12. **Bulk actions**: `POST /contacts/bulk { ids, action: assign|tag|add_to_pipeline, … }`.

## 4. Conflicts between the brief and the backend

- **Naming:** the brief says "Follow-up", the API says `task` (handled in the UI copy only). The brief's "Leads" screen is `/contacts`.
- **Call outcomes:** the brief has Answered / No answer / Busy / Wrong number. Sandbox `/contacts/{id}/calls` stores free-text `outcome`. The frontend sends `answered | no_answer | busy | wrong_number`, which Huzaifa's `no_answer_retry` automation matches on `no_answer`.
- **Roles:** the brief has `super_admin`. The backend has `platform_admins` (Huzaifa) but nothing in `/me`. The frontend treats super-admin as unknown (false) until `/me` returns it, except in development.
- **Partner admin as role:** the sandbox returns `effective_role: 'partner_admin'` for partner admins. Postgres treats them as `manager`. The frontend uses `/me` (`partner_admin`).
- **Home "calls per agent":** no endpoint counts calls per agent. Team today shows `contacted` from `/reports/agents` in its place.
- **Billing is PKR and Pakistan-specific** (NTN/CNIC identity, JazzCash/Easypaisa). The billing page shows what the API returns and formats amounts with the workspace currency only when the API sends a currency; otherwise PKR, labelled.
- **Urdu:** the backend returns `name_ur`, `label_ur` and `appNameUr`. The frontend ignores them (English only, brief section 3).

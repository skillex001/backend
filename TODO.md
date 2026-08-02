# Budget Bites Backend — Task Tracker

## 🔒 Security Hardening — Hide sensitive details (no code changes) (2026-08-02)
- [x] README.md: remove real Supabase URL, Firebase refs; fix commands; add Security & Env section
- [x] TODO.md: redact real Supabase URLs + deployment IDs (this file, below)
- [x] .gitignore: precise env ignores (keep `.env.example` tracked), add artifact files
- [x] `.env.example`: committed as the safe placeholder template
- [x] `git rm` empty artifact files: `node`, `budget-bites-backend@1.0.0`
- [x] Verify: `node --check server.js` still passes, `git status` shows only intended changes
- [ ] Follow-up: rotate Supabase service-role key (URL was exposed in past git history)

---

## ✅ Implement missing endpoint in current backend: POST /api/admin/users/ensure-profile
- [x] Add Express route
- [x] Ensure profile row exists in `users` table for given authUserId
- [x] Return {success:true, ensured:true/false, user}
- [x] Test with curl: confirm endpoint returns non-404
- [ ] Re-run frontend login flow; confirm profile is ensured and user can proceed

## 🚀 Production Fix: Supabase credentials not in frontend build (2026-08-02)
- [x] Diagnose `[Supabase] VITE_SUPABASE_URL: undefined` on live site
- [x] Fix Vercel project build command: `npm run dev` → `npm run build`
- [x] Cancel stuck deployment
- [x] Redeploy production via `vercel --prod --yes`
- [x] Verify live site contains real Supabase URL + anon key (inlined at build time)
- [x] Verified live site now initializes Supabase (connection URL redacted here)
- [x] Verified data loads from Supabase directly: `Loaded 24 meals, 7 restaurants`

## ✅ Backend URL Fix (2026-08-02)
- [x] User confirmed backend is hosted on Railway
- [x] Updated `VITE_BACKEND_URL` on Vercel (Production + Preview) to the Railway URL
- [x] Redeployed frontend to `https://www.budget-bites.food`
- [x] Verified live site: Railway URL inlined (1x), `localhost:3000` removed (0x)
- [x] Note: Railway's edge network (Hikari) rate-limits rapid API test requests from one IP;
      real browsers are not affected. The app's own rate limiters (signup/payment) are separate.
- [x] If the backend still rejects browser calls, check `CORS_ORIGIN` on Railway is set to
      `https://www.budget-bites.food,https://budget-bites.food` (not localhost:5173)

## ✅ Backend CORS + crash fix (2026-08-02)
- [x] Browser console showed CORS block on live backend from origin `https://www.budget-bites.food`
- [x] Found critical bug in `server.js`: `const supabase = createClient(...)` declared TWICE
      → `SyntaxError: Identifier 'supabase' has already been declared` → backend would crash on deploy
- [x] Fixed duplicate declaration: kept single client with both `auth` + `realtime` config
- [x] Env-var compatibility: accept `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` OR
      `VITE_SUPABASE_URL`/`VITE_SUPABASE_SERVICE_ROLE_KEY`
- [x] CORS: production domains always allowed (`https://www.budget-bites.food`,
      `https://budget-bites.food`, `https://budgetbites-mh1s.vercel.app`) in addition to `CORS_ORIGIN`
- [x] Verified `node --check server.js` passes; exactly 1 `supabase` + 1 `ws` require
- [ ] Push to GitHub (`skillex001/backend`) to trigger Railway redeploy
- [ ] Verify CORS headers on live backend with `Origin: https://www.budget-bites.food`
- [ ] Hard-refresh `https://www.budget-bites.food` → confirm no more CORS/backend errors


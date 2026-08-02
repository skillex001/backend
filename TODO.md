- [x] Implement missing endpoint in current backend: POST /api/admin/users/ensure-profile
  - [x] Add Express route
  - [x] Ensure profile row exists in `users` table for given authUserId
  - [x] Return {success:true, ensured:true/false, user}
- [x] Test with curl: confirm endpoint returns non-404
- [ ] Re-run frontend login flow; confirm profile is ensured and user can proceed

## 🚀 Production Fix: Supabase credentials not in frontend build (2026-08-02)
- [x] Diagnose `[Supabase] VITE_SUPABASE_URL: undefined` on live site
  - Root cause: Vercel project `buildCommand` was misconfigured to `npm run dev`
    (starts Vite dev server, never exits → build never produced a real bundle,
    so `import.meta.env.VITE_SUPABASE_URL` was never inlined).
  - The `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` env vars WERE present on Vercel,
    but never used because the build never ran `vite build`.
- [x] Fix Vercel project build command: `npm run dev` → `npm run build`
- [x] Cancel stuck deployment (dpl_GiMVH9DpX1PhJZTg9qRFyHZNy6nE)
- [x] Redeploy production via `vercel --prod --yes`
  - New deployment ready in ~17s, aliased to www.budget-bites.food
- [x] Verify live site contains real Supabase URL + anon key (inlined at build time)
  - `https://budget-bites.food` and `https://www.budget-bites.food` both serve fixed build
- [x] Confirm project settings: buildCommand=`npm run build`, framework=`vite`, outputDirectory=`dist`
- [x] Verified live site now initializes Supabase: `[Supabase] Initializing connection to: https://mljoxqulkwfcivceumgf.supabase.co`
- [x] Verified data loads from Supabase directly: `Loaded 24 meals, 7 restaurants`

## ✅ Backend URL Fix (2026-08-02)
- [x] User confirmed backend is hosted on Railway: `https://budgetbites-production.up.railway.app`
- [x] Updated `VITE_BACKEND_URL` on Vercel (Production + Preview) to the Railway URL
- [x] Redeployed frontend to `https://www.budget-bites.food`
- [x] Verified live site: Railway URL inlined (1x), `localhost:3000` removed (0x)
- [x] Note: Railway's edge network (Hikari) rate-limits rapid API test requests from one IP;
      real browsers are not affected. The app's own rate limiters (signup/payment) are separate.
- [x] If the backend still rejects browser calls, check `CORS_ORIGIN` on Railway is set to
      `https://www.budget-bites.food,https://budget-bites.food` (not localhost:5173)

## ✅ Backend CORS + crash fix (2026-08-02)
- [x] Browser console showed CORS block on `https://budgetbites-production.up.railway.app/api/bootstrap`
      from origin `https://www.budget-bites.food` (no `Access-Control-Allow-Origin` header)
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



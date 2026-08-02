- [x] Implement missing endpoint in current backend: POST /api/admin/users/ensure-profile
  - [x] Add Express route
  - [x] Ensure profile row exists in `users` table for given authUserId
  - [x] Return {success:true, ensured:true/false, user}
- [x] Test with curl: confirm endpoint returns non-404
- [ ] Re-run frontend login flow; confirm profile is ensured and user can proceed


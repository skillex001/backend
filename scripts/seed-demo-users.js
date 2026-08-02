/**
 * One-time local setup script: creates demo admin/restaurant/rider accounts.
 *
 * This used to be an HTTP endpoint (/api/admin/seed-demo-users) with a
 * hardcoded shared password and no auth check — meaning anyone who found the
 * backend URL could create/re-use an admin account. It is now a CLI-only
 * script (never exposed over HTTP) that generates a random password per
 * account and forces a password change on first login.
 *
 * Usage:
 *   cd backend
 *   node scripts/seed-demo-users.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const rawSupabaseUrl = process.env.VITE_SUPABASE_URL;
const supabaseUrl = rawSupabaseUrl ? rawSupabaseUrl.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '') : '';
const supabaseServiceKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing VITE_SUPABASE_URL or VITE_SUPABASE_SERVICE_ROLE_KEY in backend/.env');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function randomPassword() {
  return crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
}

const demoUsers = [
  { username: 'admin', name: 'Platform Admin', role: 'admin', approved: true },
  { username: 'mamas-kitchen', name: "Mama's Kitchen", role: 'restaurant', restaurantId: 'r1', phone: '0712111111', approved: true },
  { username: 'nyama-choma-spot', name: 'Nyama Choma Spot', role: 'restaurant', restaurantId: 'r2', phone: '0712222222', approved: true },
  { username: 'campus-bites', name: 'Campus Bites', role: 'restaurant', restaurantId: 'r3', phone: '0712333333', approved: true },
  { username: 'samosa-house', name: 'Samosa House', role: 'restaurant', restaurantId: 'r5', phone: '0712555555', approved: true },
  { username: 'rider-kamau', name: 'Rider Kamau', role: 'rider', riderId: 'rd1', phone: '0799111111', approved: true },
  { username: 'rider-otieno', name: 'Rider Otieno', role: 'rider', riderId: 'rd2', phone: '0799222222', approved: true },
];

async function main() {
  const results = [];

  for (const u of demoUsers) {
    const email = `${u.username}@budgetbites.local`;
    const password = randomPassword();

    // Skip if profile already exists (idempotent).
    const { data: existingProfile } = await supabase
      .from('users')
      .select('id')
      .eq('username', u.username)
      .maybeSingle();

    if (existingProfile?.id) {
      results.push({ username: u.username, status: 'already_exists' });
      continue;
    }

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { phone: u.phone || '', name: u.name, role: u.role },
    });

    if (authError) {
      const status = authError.message?.toLowerCase().includes('already')
        ? 'auth_exists_no_profile'
        : 'error';
      results.push({ username: u.username, status, error: authError.message });
      continue;
    }

    const { error: profileError } = await supabase.from('users').upsert({
      id: authData.user.id,
      username: u.username,
      phone: u.phone || null,
      name: u.name,
      role: u.role,
      restaurant_id: u.restaurantId || null,
      rider_id: u.riderId || null,
      approved: u.approved,
      must_change_password: true,
      favourites: [],
    });

    results.push(
      profileError
        ? { username: u.username, status: 'auth_created_profile_failed', error: profileError.message }
        : { username: u.username, status: 'created', password },
    );
  }

  console.log('\n=== Seed results ===');
  for (const r of results) {
    if (r.status === 'created') {
      console.log(`✅ ${r.username}: created. TEMP PASSWORD: ${r.password}  (must be changed on first login)`);
    } else {
      console.log(`- ${r.username}: ${r.status}${r.error ? ` (${r.error})` : ''}`);
    }
  }
  console.log('\nStore these temporary passwords somewhere safe — they will not be shown again.\n');
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Seed script failed:', err);
    process.exit(1);
  });

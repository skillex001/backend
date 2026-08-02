/**
 * Budget Bites Backend Server
 * 
 * Features:
 * - M-Pesa STK Push integration (Safaricom Daraja API)
 * - M-Pesa Callback endpoint (updates Supabase Order status)
 * - Supabase integration using Service Role Key (RLS bypass)
 * - Double-payment prevention using Node Cache
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');

// Initialize Supabase Client with Service Role Key to bypass RLS policies for payment updates
const rawSupabaseUrl = process.env.SUPABASE_URL;
const supabaseUrl = rawSupabaseUrl ? rawSupabaseUrl.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '') : '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function decodeJwtRole(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return payload.role || payload.user_role || null;
  } catch {
    return null;
  }
}

if (!supabaseUrl || !supabaseServiceKey) {
  console.error('❌ Missing SUPABASE_URL or ❌ SUPABASE_SERVICE_ROLE_KEY in .env file');
  process.exit(1);
}

const supabaseJwtRole = decodeJwtRole(supabaseServiceKey);
if (supabaseJwtRole !== 'service_role') {
  console.error(`❌ SUPABASE_SERVICE_ROLE_KEY is invalid for this backend. Detected role: ${supabaseJwtRole || 'unknown'}`);
  console.error('   Use the service_role key from Supabase Dashboard → Settings → API, not the anon key.');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

// Initialize Express
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
// CORS_ORIGIN can be a single origin or a comma-separated list (e.g. "https://app.example.com,https://admin.example.com").
// Falls back to local dev origins only — never defaults to "*", since credentials:true combined with "*" is both
// insecure and rejected by browsers anyway.
const configuredOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
const allowedOrigins = configuredOrigins.length > 0
  ? configuredOrigins
  : ['http://localhost:5173', 'http://127.0.0.1:5173'];

if (configuredOrigins.length === 0 && process.env.NODE_ENV === 'production') {
  console.warn('⚠️  CORS_ORIGIN is not set in production. Falling back to localhost-only origins — set CORS_ORIGIN to your real frontend domain(s).');
}

app.use(cors({
  origin(origin, callback) {
    // Allow non-browser requests (curl, mobile apps, server-to-server, M-Pesa callbacks) which send no Origin header.
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cache for STK push requests (prevents duplicate prompts within 5 minutes)
const stkCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });
// Cache payment outcomes for status polling and eventual order reconciliation
const mpesaResultCache = new NodeCache({ stdTTL: 86400, checkperiod: 600 });

// ===========================================
// M-Pesa Helper Functions
// ===========================================

/**
 * Get M-Pesa OAuth Token
 */
async function getMpesaToken() {
  const env = process.env.MPESA_ENV || 'sandbox';
  const consumerKey = env === 'production' 
    ? process.env.MPESA_PROD_CONSUMER_KEY 
    : process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = env === 'production'
    ? process.env.MPESA_PROD_CONSUMER_SECRET
    : process.env.MPESA_CONSUMER_SECRET;

  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  try {
    const response = await axios.get(
      env === 'production'
        ? 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
        : 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
      {
        headers: {
          Authorization: `Basic ${auth}`,
        },
      }
    );

    return response.data.access_token;
  } catch (error) {
    console.error('M-Pesa Token Error:', error.response?.data || error.message);
    throw new Error('Failed to get M-Pesa token');
  }
}

/**
 * Generate M-Pesa Password (Base64 encoded)
 */
function generatePassword(shortcode, passkey, timestamp) {
  const data = `${shortcode}${passkey}${timestamp}`;
  return Buffer.from(data).toString('base64');
}

/**
 * Format timestamp for M-Pesa (YYYYMMDDHHmmss)
 */
function getTimestamp() {
  const now = new Date();
  return now.toISOString().replace(/[-:T.]/g, '').slice(0, 14);
}

/**
 * Query M-Pesa STK status by CheckoutRequestID
 */
async function queryMpesaStkStatus(checkoutRequestID) {
  const token = await getMpesaToken();
  const timestamp = getTimestamp();
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  const password = generatePassword(shortcode, passkey, timestamp);
  const env = process.env.MPESA_ENV || 'sandbox';

  const response = await axios.post(
    env === 'production'
      ? 'https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query'
      : 'https://sandbox.safaricom.co.ke/mpesa/stkpushquery/v1/query',
    {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestID,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return response.data;
}

/**
 * Format phone number to 2547XXXXXXXX
 */
function formatPhone(phone) {
  let p = phone.replace(/[\s\-\+\(\)]/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (!p.startsWith('254')) p = '254' + p;
  return p;
}

/**
 * Password policy shared with the frontend (src/lib/validation.ts): at least
 * 8 characters, containing both a letter and a number. Enforced here too
 * since this backend uses the service-role key to create/update auth users
 * directly, so it can't rely on client-side validation alone.
 */
function isValidPassword(password) {
  const pw = String(password || '');
  return pw.length >= 8 && /[a-zA-Z]/.test(pw) && /[0-9]/.test(pw);
}

// Lightweight input validation helpers (no external schema library needed for
// this app's small surface area). Guards against type-confusion (e.g. sending
// a number/array where a string is expected) and unreasonably large payloads
// on public, unauthenticated endpoints.
function isNonEmptyString(value, maxLen = 200) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLen;
}

function isValidPhoneNumber(value) {
  if (typeof value !== 'string') return false;
  const digits = value.replace(/[^\d]/g, '');
  return digits.length >= 9 && digits.length <= 15;
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// ===========================================
// Auth Middleware
// ===========================================
// Admin/partner endpoints below use the SERVICE ROLE key (bypasses RLS), so
// this backend — not RLS — is the only thing standing between the internet
// and privileged operations (password resets, approvals, account creation).
// Every /api/admin/* route must run through one of these.

/**
 * Verifies the caller's Supabase access token (sent as `Authorization: Bearer <token>`)
 * and attaches the resolved auth user to `req.authUser`. Does NOT check role.
 */
async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ success: false, message: 'Missing Authorization bearer token' });
    }

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ success: false, message: 'Invalid or expired session' });
    }

    req.authUser = data.user;
    next();
  } catch (error) {
    console.error('requireAuth error:', error);
    return res.status(401).json({ success: false, message: 'Authentication failed' });
  }
}

/**
 * Requires requireAuth to have run first. Confirms the authenticated caller's
 * `public.users` profile has role = 'admin' and is approved.
 */
async function requireAdmin(req, res, next) {
  try {
    const { data: profile, error } = await supabase
      .from('users')
      .select('role, approved')
      .eq('id', req.authUser.id)
      .maybeSingle();

    if (error) throw error;
    if (!profile || profile.role !== 'admin' || !profile.approved) {
      return res.status(403).json({ success: false, message: 'Admin privileges required' });
    }

    next();
  } catch (error) {
    console.error('requireAdmin error:', error);
    return res.status(500).json({ success: false, message: 'Authorization check failed' });
  }
}

/**
 * Requires requireAuth to have run first. Confirms the authenticated caller
 * is only acting on their own account (req.body.authUserId must match).
 * Used by /api/admin/users/ensure-profile, which every user (not just admins)
 * calls right after login to self-heal their own profile row.
 */
function requireSelf(req, res, next) {
  const targetId = req.body?.authUserId;
  if (!targetId || targetId !== req.authUser.id) {
    return res.status(403).json({ success: false, message: 'You may only act on your own account' });
  }
  next();
}

/**
 * Requires requireAuth to have run first. Confirms the authenticated caller is
 * either an approved admin, or the approved owner of the restaurant referenced
 * by req.body.meal.restaurantId. Used by POST /api/meals so one restaurant
 * can't create/edit another restaurant's menu items.
 */
async function requireRestaurantOwnerOrAdmin(req, res, next) {
  try {
    const restaurantId = req.body?.meal?.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ success: false, message: 'meal.restaurantId is required' });
    }

    const { data: profile, error } = await supabase
      .from('users')
      .select('role, approved, restaurant_id')
      .eq('id', req.authUser.id)
      .maybeSingle();
    if (error) throw error;

    const isApprovedAdmin = profile?.role === 'admin' && profile.approved;
    const isOwningRestaurant = profile?.role === 'restaurant' && profile.approved && profile.restaurant_id === restaurantId;
    if (!isApprovedAdmin && !isOwningRestaurant) {
      return res.status(403).json({ success: false, message: 'You may only manage your own restaurant\'s menu' });
    }

    next();
  } catch (error) {
    console.error('requireRestaurantOwnerOrAdmin error:', error);
    return res.status(500).json({ success: false, message: 'Authorization check failed' });
  }
}

// ===========================================
// Rate Limiting
// ===========================================
// These endpoints are unauthenticated and write to the database (account
// creation, partner applications, payment prompts), so they're the routes
// most worth throttling per-IP against scripted abuse/spam.

const signupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many requests from this device. Please try again later.' },
});

const paymentLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: 'Too many payment requests. Please wait a few minutes and try again.' },
});

// ===========================================
// API Routes
// ===========================================

/**
 * Health Check
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', database: 'supabase', timestamp: new Date().toISOString() });
});

/**
 * Initiate M-Pesa STK Push
 * POST /api/mpesa/stkpush
 */
app.post('/api/mpesa/stkpush', paymentLimiter, async (req, res) => {
  const { phone, amount, accountRef, transactionDesc, orderId } = req.body;

  if (!phone || !amount || !orderId) {
    return res.status(400).json({
      success: false,
      message: 'Phone number, amount, and orderId are required',
    });
  }

  const formattedPhone = formatPhone(phone);

  // Check cache to prevent duplicate prompts
  const cacheKey = `stk_${formattedPhone}_${Math.round(amount)}_${orderId}`;
  if (stkCache.has(cacheKey)) {
    return res.status(429).json({
      success: false,
      message: 'Please wait before requesting another STK push',
    });

  }

  try {
    const token = await getMpesaToken();
    const timestamp = getTimestamp();
    const shortcode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;
    const password = generatePassword(shortcode, passkey, timestamp);
    const callbackUrl = process.env.MPESA_CALLBACK_URL;

    const payload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amount),
      PartyA: formattedPhone,
      PartyB: shortcode,
      PhoneNumber: formattedPhone,
      CallBackURL: callbackUrl,
      AccountReference: accountRef || process.env.MPESA_ACCOUNT_REF || 'BudgetBites',
      TransactionDesc: transactionDesc || process.env.MPESA_TRANSACTION_DESC || 'Food Order',
    };

    const env = process.env.MPESA_ENV || 'sandbox';
    const response = await axios.post(
      env === 'production'
        ? 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest'
        : 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
      payload,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (response.data.ResponseCode === '0') {
      const checkoutRequestID = response.data.CheckoutRequestID;

      // Cache request for callback mapping
      stkCache.set(cacheKey, {
        orderId,
        phone: formattedPhone,
        amount,
        checkoutRequestID,
      });

      // Update order in Supabase to record checkout ID
      const { error: dbError } = await supabase
        .from('orders')
        .update({
          mpesa_checkout_request_id: checkoutRequestID,
          mpesa_payment_status: 'pending',
          payment_method: 'mpesa',
        })
        .eq('order_number', orderId);

      if (dbError) {
        console.error('Supabase order update error:', dbError.message);
      }

      return res.json({
        success: true,
        checkoutRequestID,
        message: 'STK push prompt sent to your phone.',
      });
    }

    return res.status(400).json({
      success: false,
      message: response.data.ResponseDescription || 'M-Pesa request failed',
    });

  } catch (error) {
    console.error('M-Pesa STK Error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: error.response?.data?.errorMessage || 'Internal Server Error',
    });
  }
});

/**
 * M-Pesa Callback Endpoint
 * POST /api/mpesa/callback
 * 
 * Safaricom calls this endpoint when the customer enters their PIN.
 */
app.post('/api/mpesa/callback', async (req, res) => {
  try {
    const { Body } = req.body;
    const stkCallback = Body?.stkCallback;

    if (!stkCallback) {
      console.warn('M-Pesa Callback: invalid/missing payload shape');
      return res.status(400).json({ ResultCode: 1, ResultDesc: 'Invalid callback payload' });
    }

    const { CheckoutRequestID, ResultCode, ResultDesc } = stkCallback;
    const callbackMetadata = stkCallback.CallbackMetadata?.Item || [];

    const getMetadataValue = (name) => {
      const item = callbackMetadata.find(i => i.Name === name);
      return item ? item.Value : null;
    };

    const amount = getMetadataValue('Amount');
    const mpesaReceiptNumber = getMetadataValue('MpesaReceiptNumber');
    const phoneNumber = getMetadataValue('PhoneNumber');
    // Log a redacted summary only — never dump the raw callback body (contains full phone number/receipt PII).
    const redactedPhone = phoneNumber ? `***${String(phoneNumber).slice(-4)}` : null;
    console.log(`M-Pesa Callback: checkoutId=${CheckoutRequestID} resultCode=${ResultCode} phone=${redactedPhone} amount=${amount || 'n/a'}`);

    const cacheKey = Object.keys(stkCache.mstore).find(key => {
      const cached = stkCache.get(key);
      return cached?.checkoutRequestID === CheckoutRequestID;
    });

    const cachedData = cacheKey ? stkCache.get(cacheKey) : null;
    const orderId = cachedData?.orderId;

    const paymentSuccess = ResultCode === 0;
    const resultCacheKey = `result_${CheckoutRequestID}`;

    if (paymentSuccess) {
      mpesaResultCache.set(resultCacheKey, {
        success: true,
        terminal: true,
        resultCode: ResultCode,
        resultDesc: ResultDesc || 'Payment confirmed',
        mpesaReceiptNumber,
        amount,
        phoneNumber,
        orderId: orderId || null,
        updatedAt: new Date().toISOString(),
      });

      // 1. Update order status in Supabase (auto-moves to preparing)
      const { error: orderError } = await supabase
        .from('orders')
        .update({
          mpesa_payment_status: 'completed',
          mpesa_receipt_number: mpesaReceiptNumber,
          status: 'preparing', // Auto-accept: restaurant kitchen starts preparing
        })
        .eq('mpesa_checkout_request_id', CheckoutRequestID);

      if (orderError) {
        console.error('Callback: Supabase order update error:', orderError.message);
      }

      // 2. Fetch order to identify recipient for notification
      const { data: orderData } = await supabase
        .from('orders')
        .select('restaurant_id, id')
        .eq('mpesa_checkout_request_id', CheckoutRequestID)
        .single();

      if (orderData) {
        // 3. Notify restaurant owner
        const { data: owners } = await supabase
          .from('users')
          .select('id')
          .eq('restaurant_id', orderData.restaurant_id)
          .eq('approved', true);

        if (owners) {
          const notifications = owners.map(owner => ({
            id: genId('notif'),
            user_id: owner.id,
            message: `💰 Payment Confirmed: Order ${orderId} has been paid via M-Pesa KES ${amount}. Start preparing!`,
            order_id: orderData.id,
            type: 'order',
            read: false,
          }));

          const { error: notifError } = await supabase.from('notifications').insert(notifications);
          if (notifError) console.error('Callback: notification insert error:', notifError.message);
        }
      }

      console.log(`[Callback] Payment verified for order ${orderId}. Receipt: ${mpesaReceiptNumber}`);
    } else {
      mpesaResultCache.set(resultCacheKey, {
        success: false,
        terminal: true,
        resultCode: ResultCode,
        resultDesc: ResultDesc || 'Payment failed',
        mpesaReceiptNumber: null,
        amount,
        phoneNumber,
        orderId: orderId || null,
        updatedAt: new Date().toISOString(),
      });

      // Payment cancelled or failed
      await supabase
        .from('orders')
        .update({
          mpesa_payment_status: 'failed',
          status: 'cancelled', // auto-cancel on failed payment
          decline_reason: ResultDesc,
        })
        .eq('mpesa_checkout_request_id', CheckoutRequestID);

      console.log(`[Callback] Payment failed for order ${orderId}: ${ResultDesc}`);
    }

    if (cacheKey) {
      stkCache.del(cacheKey);
    }

    // Acknowledge Safaricom
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

  } catch (error) {
    console.error('Callback error:', error);
    res.status(500).json({ ResultCode: 1, ResultDesc: 'Internal callback handler error' });
  }
});

/**
 * Query M-Pesa payment status
 * GET /api/mpesa/status/:checkoutRequestID
 */
app.get('/api/mpesa/status/:checkoutRequestID', async (req, res) => {
  const { checkoutRequestID } = req.params;

  if (!checkoutRequestID) {
    return res.status(400).json({ success: false, resultDesc: 'checkoutRequestID is required' });
  }

  const resultCacheKey = `result_${checkoutRequestID}`;
  const cached = mpesaResultCache.get(resultCacheKey);
  if (cached) {
    return res.json({
      success: cached.success,
      terminal: cached.terminal,
      resultCode: cached.resultCode,
      resultDesc: cached.resultDesc,
      mpesaReceiptNumber: cached.mpesaReceiptNumber || null,
    });
  }

  try {
    const data = await queryMpesaStkStatus(checkoutRequestID);
    const resultCodeRaw = data?.ResultCode;
    const resultCode = resultCodeRaw !== undefined && resultCodeRaw !== null ? Number(resultCodeRaw) : null;
    const resultDesc = data?.ResultDesc || 'Pending';
    const success = resultCode === 0;
    const terminal = resultCode !== null && resultCode !== 1032 && resultCode !== 1;

    if (terminal) {
      mpesaResultCache.set(resultCacheKey, {
        success,
        terminal: true,
        resultCode,
        resultDesc,
        mpesaReceiptNumber: null,
        amount: null,
        phoneNumber: null,
        orderId: null,
        updatedAt: new Date().toISOString(),
      });
    }

    return res.json({
      success,
      terminal,
      resultCode,
      resultDesc,
    });
  } catch (error) {
    console.error('M-Pesa status query error:', error.response?.data || error.message);

    // Fallback: infer from persisted order if callback has already updated it.
    const { data: orderRow, error: orderError } = await supabase
      .from('orders')
      .select('mpesa_payment_status, mpesa_receipt_number, decline_reason')
      .eq('mpesa_checkout_request_id', checkoutRequestID)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (orderError || !orderRow) {
      return res.status(502).json({
        success: false,
        terminal: false,
        resultDesc: 'Could not fetch live payment status. Try again shortly.',
      });
    }

    if (orderRow.mpesa_payment_status === 'completed') {
      return res.json({
        success: true,
        terminal: true,
        resultDesc: 'Payment confirmed',
        mpesaReceiptNumber: orderRow.mpesa_receipt_number || null,
      });
    }

    if (orderRow.mpesa_payment_status === 'failed') {
      return res.json({
        success: false,
        terminal: true,
        resultDesc: orderRow.decline_reason || 'Payment failed',
      });
    }

    return res.json({
      success: false,
      terminal: false,
      resultDesc: 'Payment pending',
    });
  }
});

// ===========================================
// Bootstrap + Admin CRUD API
// ===========================================

app.get('/api/bootstrap', async (_req, res) => {
  try {
    // Safety caps so this endpoint can't grow unbounded as the platform scales
    // (only `orders` was capped before). Ordered so the most relevant/newest
    // rows are kept if a table ever exceeds its cap, rather than an arbitrary
    // truncation.
    const RESTAURANTS_LIMIT = 500;
    const MEALS_LIMIT = 2000;
    const RIDERS_LIMIT = 500;

    const [restaurants, meals, riders, landmarks, distances, orders, restaurantApplications, riderApplications] = await Promise.all([
      supabase.from('restaurants').select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(RESTAURANTS_LIMIT),
      supabase.from('meals').select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(MEALS_LIMIT),
      supabase.from('riders').select('*').is('deleted_at', null).order('created_at', { ascending: false }).limit(RIDERS_LIMIT),
      supabase.from('landmarks').select('*'),
      supabase.from('distances').select('*'),
      supabase.from('orders').select('*').order('created_at', { ascending: false }).limit(200),
      supabase.from('restaurant_applications').select('*').order('created_at', { ascending: false }),
      supabase.from('rider_applications').select('*').order('created_at', { ascending: false }),
    ]);

    for (const result of [restaurants, meals, riders, landmarks, distances, orders, restaurantApplications, riderApplications]) {
      if (result.error) throw result.error;
    }

    const data = {
      restaurants: restaurants.data.map(r => ({
        id: r.id,
        name: r.name,
        cuisine: r.cuisine,
        image: r.image,
        rating: r.rating,
        deliveryFee: r.delivery_fee,
        deliveryTime: r.delivery_time,
        isOpen: r.is_open,
        approved: r.approved,
        openTime: r.open_time,
        closeTime: r.close_time,
        gallery: r.gallery,
        isVerified: r.is_verified,
        secretMenuPartner: r.secret_menu_partner,
      })),
      meals: meals.data.map(m => ({
        id: m.id,
        name: m.name,
        price: m.price,
        restaurantId: m.restaurant_id,
        restaurantName: m.restaurant_name,
        kind: m.kind,
        rating: m.rating,
        ratingCount: m.rating_count,
        category: m.category,
        image: m.image,
        description: m.description,
        available: m.available,
        availabilityStatus: m.availability_status,
        timeSlots: m.time_slots,
        orderCount: m.order_count,
        isSecret: m.is_secret,
        prepTimeMinutes: m.prep_time_minutes,
        dailyPrepLimit: m.daily_prep_limit,
        prepLimitUsed: m.prep_limit_used,
      })),
      riders: riders.data.map(r => ({
        id: r.id,
        name: r.name,
        phone: r.phone,
        currentLandmarkId: r.current_landmark_id,
        approved: r.approved,
        available: r.available,
        ratePerKm: r.rate_per_km,
        rating: r.rating,
        ratingCount: r.rating_count,
        totalEarnings: r.total_earnings,
        completedDeliveries: r.completed_deliveries,
        profilePhoto: r.profile_photo,
        isVerified: r.is_verified,
        secretMenuTrusted: r.secret_menu_trusted,
        shiftStart: r.shift_start,
        shiftEnd: r.shift_end,
      })),
      landmarks: landmarks.data.map(l => ({ id: l.id, name: l.name, area: l.area })),
      distances: distances.data.map(d => ({ restaurantId: d.restaurant_id, landmarkId: d.landmark_id, km: d.km })),
      orders: orders.data.map(o => ({
        id: o.order_number,
        items: o.items,
        restaurantName: o.restaurant_name,
        restaurantId: o.restaurant_id,
        subtotal: o.subtotal,
        restaurantFee: o.restaurant_fee,
        riderFee: o.rider_fee,
        total: o.total,
        deliveryFee: o.delivery_fee,
        grandTotal: o.grand_total,
        customerName: o.customer_name,
        customerPhone: o.customer_phone,
        customerLocation: o.customer_location,
        landmarkId: o.landmark_id,
        status: o.status,
        notes: o.notes,
        riderId: o.rider_id,
        riderName: o.rider_name,
        riderPhone: o.rider_phone,
        estimatedDistanceKm: o.estimated_distance_km,
        paymentMethod: o.payment_method,
        mpesaPaymentStatus: o.mpesa_payment_status,
        riderCashCollected: o.rider_cash_collected,
        createdAt: o.created_at,
      })),
      restaurantApplications: restaurantApplications.data.map(a => ({
        id: a.id,
        username: a.username,
        ownerName: a.owner_name,
        restaurantName: a.restaurant_name,
        cuisine: a.cuisine,
        phone: a.phone,
        status: a.status,
        createdAt: a.created_at,
      })),
      riderApplications: riderApplications.data.map(a => ({
        id: a.id,
        username: a.username,
        name: a.name,
        phone: a.phone,
        status: a.status,
        createdAt: a.created_at,
      })),
    };

    res.json({ success: true, data });
  } catch (error) {
    console.error('Bootstrap error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Admin-only: upserts a restaurant row directly (used by AdminPortal after
// apiAdminCreateRestaurantWithAuth creates the owner account). Must stay
// admin-gated — it accepts an arbitrary id/approved/is_verified in the body.
app.post('/api/restaurants', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { restaurant } = req.body;
    const { error } = await supabase.from('restaurants').upsert({
      id: restaurant.id,
      name: restaurant.name,
      cuisine: restaurant.cuisine,
      image: restaurant.image,
      rating: restaurant.rating || 0,
      delivery_fee: restaurant.deliveryFee,
      delivery_time: restaurant.deliveryTime,
      is_open: restaurant.isOpen,
      approved: restaurant.approved,
      open_time: restaurant.openTime,
      close_time: restaurant.closeTime,
      gallery: restaurant.gallery || [],
      is_verified: restaurant.isVerified || false,
    }, { onConflict: 'id' });
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('Create restaurant error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Admin-only: legacy rider row upsert. Currently unused by the frontend (rider
// creation goes through /api/admin/riders/create) but kept for compatibility —
// must stay admin-gated for the same reason as /api/restaurants above.
app.post('/api/riders', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rider } = req.body;
    const { error } = await supabase.from('riders').upsert({
      id: rider.id,
      name: rider.name,
      phone: rider.phone,
      current_landmark_id: rider.currentLandmarkId,
      approved: rider.approved,
      available: rider.available,
      rate_per_km: rider.ratePerKm,
      rating: rider.rating || 0,
      rating_count: rider.ratingCount || 0,
      total_earnings: rider.totalEarnings || 0,
      completed_deliveries: rider.completedDeliveries || 0,
      profile_photo: rider.profilePhoto,
      is_verified: rider.isVerified || false,
      shift_start: rider.shiftStart,
      shift_end: rider.shiftEnd,
    }, { onConflict: 'id' });
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    console.error('Create rider error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * Admin create restaurant auth user + restaurant row using service role.
 * POST /api/admin/restaurants/create
 */
app.post('/api/admin/restaurants/create', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { restaurant, owner } = req.body;

    if (!restaurant || !owner) {
      return res.status(400).json({ success: false, message: 'restaurant and owner are required' });
    }

    const email = `${owner.username}@budgetbites.local`;

    // 1) Create auth user (service-role bypass)
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password: owner.password,
      email_confirm: true,
      user_metadata: {
        name: owner.name || restaurant.name,
        phone: owner.phone,
        role: 'restaurant',
        restaurantId: restaurant.id,
      },
      app_metadata: {
        role: 'restaurant',
      },
    });

    const alreadyRegistered = authError && String(authError.message || '').toLowerCase().includes('already');
    if (authError && !alreadyRegistered) {
      return res.status(500).json({ success: false, message: authError.message });
    }

    // 2) Upsert restaurant row
    const { error: restaurantError } = await supabase.from('restaurants').upsert({
      id: restaurant.id,
      name: restaurant.name,
      cuisine: restaurant.cuisine,
      image: restaurant.image,
      rating: restaurant.rating || 0,
      delivery_fee: restaurant.deliveryFee,
      delivery_time: restaurant.deliveryTime,
      is_open: restaurant.isOpen,
      approved: restaurant.approved,
      open_time: restaurant.openTime,
      close_time: restaurant.closeTime,
      gallery: restaurant.gallery || [],
      is_verified: restaurant.isVerified || false,
    }, { onConflict: 'id' });

    if (restaurantError) throw restaurantError;

    // 3) Upsert users mapping
    const userId = authData?.user?.id;
    if (userId) {
      await supabase.from('users').upsert({
        id: userId,
        username: owner.username,
        email: email,
        phone: owner.phone,
        name: owner.name || restaurant.name,
        role: 'restaurant',
        restaurant_id: restaurant.id,
        approved: true,
        must_change_password: true,
        favourites: [],
      }, { onConflict: 'id' });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Admin create restaurant error:', error);
    return res.status(500).json({ success: false, message: error.message || String(error) });
  }
});

/**
 * Admin create rider auth user + rider row using service role.
 * POST /api/admin/riders/create
 */
app.post('/api/admin/riders/create', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rider, owner } = req.body;

    if (!rider || !owner) {
      return res.status(400).json({ success: false, message: 'rider and owner are required' });
    }

    // Use a deterministic email so repeated attempts hit the same auth user.
    // If your usernames already map to real emails, adjust accordingly.
    const email = `${owner.username}@budgetbites.local`;


    // 1) Create auth user (service-role bypass)
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password: owner.password,
      email_confirm: true,
      user_metadata: {
        name: rider.name,
        phone: rider.phone,
        role: 'rider',
        riderId: rider.id,
      },
      app_metadata: {
        role: 'rider',
      },
    });

    const alreadyRegistered = authError && String(authError.message || '').toLowerCase().includes('already');
    if (authError && !alreadyRegistered) {
      return res.status(500).json({ success: false, message: authError.message });
    }

    // 2) Upsert rider row
    const { error: riderError } = await supabase.from('riders').upsert({
      id: rider.id,
      name: rider.name,
      phone: rider.phone,
      current_landmark_id: rider.currentLandmarkId,
      approved: true,
      available: true,
      rate_per_km: 20,
      rating: 0,
      rating_count: 0,
      total_earnings: 0,
      completed_deliveries: 0,
      profile_photo: rider.profilePhoto,
      is_verified: true,
      shift_start: rider.shiftStart,
      shift_end: rider.shiftEnd,
    }, { onConflict: 'id' });

    if (riderError) throw riderError;

    // 3) (Optional) create/update profile row in `users`
    // Your codebase expects `users` to exist for login/rider mapping.
    const userId = authData?.user?.id;
    if (userId) {
      await supabase.from('users').upsert({
        id: userId,
        username: owner.username,
        phone: rider.phone,
        name: rider.name,
        role: 'rider',
        rider_id: rider.id,
        approved: true,
        must_change_password: true,
        favourites: [],
      }, { onConflict: 'id' });
    }

return res.json({ success: true });
  } catch (error) {
    console.error('Admin create rider error:', error);
    return res.status(500).json({ success: false, message: error.message || String(error) });
  }
});

/**
 * Ensure a row exists in `public.users` for a given Supabase auth user id.
 * Frontend calls this when auth succeeds but profile row is missing.
 *
 * POST /api/admin/users/ensure-profile
 * Body: { authUserId: string }
 */
app.post('/api/admin/users/ensure-profile', requireAuth, requireSelf, async (req, res) => {
  try {
    const { authUserId } = req.body;

    if (!authUserId) {
      return res.status(400).json({ success: false, message: 'authUserId is required' });
    }

    // 1) Check existing profile
    const { data: existing, error: existingError } = await supabase
      .from('users')
      .select('*')
      .eq('id', authUserId)
      .maybeSingle();

    if (existingError) {
      return res.status(500).json({ success: false, message: existingError.message });
    }

    if (existing) {
      return res.json({ success: true, ensured: false, user: existing });
    }

    // 2) Fetch auth user to derive metadata
    const { data: authUser, error: authError } = await supabase.auth.admin.getUserById(authUserId);
    if (authError) {
      return res.status(500).json({ success: false, message: authError.message });
    }

    const meta = authUser?.user?.user_metadata || {};
    const appMeta = authUser?.user?.app_metadata || {};

    const role = meta.role || appMeta.role || 'customer';
    const approved = meta.approved ?? true;

    // Derive username/display name
    let username = meta.username;
    if (!username) {
      const email = authUser?.user?.email || '';
      username = email ? email.split('@')[0] : authUserId;
    }

    const name = meta.name || username;
    const phone = meta.phone || null;

    const patch = {
      id: authUserId,
      username: username || authUserId,
      email: authUser?.user?.email,
      phone,
      name,
      role,
      restaurant_id: role === 'restaurant' ? (meta.restaurantId || meta.restaurant_id || null) : null,
      rider_id: role === 'rider' ? (meta.riderId || meta.rider_id || null) : null,
      approved: approved === true,
      must_change_password: meta.must_change_password ?? meta.mustChangePassword ?? true,
      favourites: [],
      created_at: new Date().toISOString(),
    };

    const { error: upsertError } = await supabase
      .from('users')
      .upsert(patch, { onConflict: 'id' });

    if (upsertError) {
      return res.status(500).json({ success: false, message: upsertError.message });
    }

    const { data: created, error: createdError } = await supabase
      .from('users')
      .select('*')
      .eq('id', authUserId)
      .maybeSingle();

    if (createdError) {
      return res.status(500).json({ success: false, message: createdError.message });
    }

    return res.json({ success: true, ensured: true, user: created });
  } catch (error) {
    console.error('Ensure profile error:', error);
    return res.status(500).json({ success: false, message: error.message || String(error) });
  }
});

app.post('/api/admin/restaurants/verify', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { restaurantId, isVerified } = req.body;
    if (!restaurantId || typeof isVerified !== 'boolean') {
      return res.status(400).json({ success: false, message: 'restaurantId and isVerified are required' });
    }

    const { error } = await supabase
      .from('restaurants')
      .update({ is_verified: isVerified })
      .eq('id', restaurantId);

    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    console.error('Restaurant verify error:', error);
    return res.status(500).json({ success: false, message: error.message || String(error) });
  }
});

// Admin grants/revokes "Secret Menu Partner" status. Revoking cascades: any of that
// restaurant's meals currently marked secret are forced back to non-secret so a
// revoked restaurant can never keep hidden items lingering on the live menu.
app.post('/api/admin/restaurants/secret-menu-partner', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { restaurantId, secretMenuPartner } = req.body;
    if (!restaurantId || typeof secretMenuPartner !== 'boolean') {
      return res.status(400).json({ success: false, message: 'restaurantId and secretMenuPartner are required' });
    }

    const { error } = await supabase
      .from('restaurants')
      .update({ secret_menu_partner: secretMenuPartner })
      .eq('id', restaurantId);
    if (error) throw error;

    if (!secretMenuPartner) {
      const { error: cascadeError } = await supabase
        .from('meals')
        .update({ is_secret: false })
        .eq('restaurant_id', restaurantId)
        .eq('is_secret', true);
      if (cascadeError) throw cascadeError;
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Secret menu partner toggle error:', error);
    return res.status(500).json({ success: false, message: error.message || String(error) });
  }
});

// Admin grants/revokes "Inner Circle" trusted-courier status, required to carry secret-menu orders.
app.post('/api/admin/riders/trusted-courier', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { riderId, secretMenuTrusted } = req.body;
    if (!riderId || typeof secretMenuTrusted !== 'boolean') {
      return res.status(400).json({ success: false, message: 'riderId and secretMenuTrusted are required' });
    }

    const { error } = await supabase
      .from('riders')
      .update({ secret_menu_trusted: secretMenuTrusted })
      .eq('id', riderId);
    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    console.error('Trusted courier toggle error:', error);
    return res.status(500).json({ success: false, message: error.message || String(error) });
  }
});

// Admin grants/revokes a rider's verification badge.
app.post('/api/admin/riders/verify', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { riderId, isVerified } = req.body;
    if (!riderId || typeof isVerified !== 'boolean') {
      return res.status(400).json({ success: false, message: 'riderId and isVerified are required' });
    }

    const { error } = await supabase
      .from('riders')
      .update({ is_verified: isVerified })
      .eq('id', riderId);
    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    console.error('Rider verify error:', error);
    return res.status(500).json({ success: false, message: error.message || String(error) });
  }
});

app.post('/api/admin/users/reset-password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { targetId, role, newPassword } = req.body;
    if (!targetId || !role || !newPassword) {
      return res.status(400).json({ success: false, message: 'targetId, role, and newPassword are required' });
    }
    if (!['restaurant', 'rider'].includes(role)) {
      return res.status(400).json({ success: false, message: 'role must be restaurant or rider' });
    }
    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters and contain both letters and numbers' });
    }

    const idColumn = role === 'restaurant' ? 'restaurant_id' : 'rider_id';
    const { data: profile, error: profileError } = await supabase
      .from('users')
      .select('id')
      .eq(idColumn, targetId)
      .eq('role', role)
      .maybeSingle();

    if (profileError) throw profileError;
    if (!profile?.id) {
      return res.status(404).json({ success: false, message: 'User profile not found for target' });
    }

    const { error: authError } = await supabase.auth.admin.updateUserById(profile.id, {
      password: newPassword,
    });
    if (authError) {
      return res.status(500).json({ success: false, message: authError.message });
    }

    const { error: userUpdateError } = await supabase
      .from('users')
      .update({ must_change_password: true })
      .eq('id', profile.id);

    if (userUpdateError) throw userUpdateError;

    return res.json({ success: true, userId: profile.id });
  } catch (error) {
    console.error('Admin reset password error:', error);
    return res.status(500).json({ success: false, message: error.message || String(error) });
  }
});

function genId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Customer signup using the service-role admin API.
 * Avoids Supabase's client-side email rate limit (the same issue that broke demo seeding).
 * POST /api/customers/signup
 * Body: { phone, password, name }
 */
app.post('/api/customers/signup', signupLimiter, async (req, res) => {
  try {
    const { phone, password, name } = req.body;
    if (!isNonEmptyString(name, 100) || !isValidPhoneNumber(phone) || !isNonEmptyString(password, 200)) {
      return res.status(400).json({ success: false, message: 'A valid phone, password, and name are required' });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters and contain both letters and numbers' });
    }

    const normalizedPhone = String(phone).trim();
    const email = `${normalizedPhone}@budgetbites.local`;

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name: name.trim(), phone: normalizedPhone, role: 'customer' },
      app_metadata: { role: 'customer' },
    });

    if (authError) {
      const already = String(authError.message || '').toLowerCase().includes('already');
      return res.status(already ? 409 : 500).json({
        success: false,
        message: already ? 'An account with this phone number already exists.' : authError.message,
      });
    }

    const userId = authData.user.id;
    const { error: profileError } = await supabase.from('users').upsert({
      id: userId,
      username: normalizedPhone,
      phone: normalizedPhone,
      name: name.trim(),
      role: 'customer',
      approved: true,
      must_change_password: false,
      favourites: [],
      created_at: new Date().toISOString(),
    }, { onConflict: 'id' });

    if (profileError) throw profileError;

    return res.json({
      success: true,
      user: {
        id: userId,
        username: normalizedPhone,
        phone: normalizedPhone,
        name: name.trim(),
        role: 'customer',
        approved: true,
        mustChangePassword: false,
      },
    });
  } catch (error) {
    console.error('Customer signup error:', error);
    return res.status(500).json({ success: false, message: error.message || String(error) });
  }
});

/**
 * Public: submit a restaurant partner application.
 * Creates an UNAPPROVED auth user + users profile row immediately (so the applicant's
 * chosen password is set once, via the service role, and never stored in plaintext),
 * plus a restaurant_applications row for admin review.
 * POST /api/applications/restaurant
 */
app.post('/api/applications/restaurant', signupLimiter, async (req, res) => {
  try {
    const { username, password, ownerName, restaurantName, cuisine, phone } = req.body;
    if (
      !isNonEmptyString(username, 50) ||
      !isNonEmptyString(password, 200) ||
      !isNonEmptyString(ownerName, 100) ||
      !isNonEmptyString(restaurantName, 100) ||
      !isNonEmptyString(cuisine, 50) ||
      !isValidPhoneNumber(phone)
    ) {
      return res.status(400).json({ success: false, message: 'All fields are required and must be valid' });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters and contain both letters and numbers' });
    }

    const email = `${username}@budgetbites.local`;
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name: ownerName, phone, role: 'restaurant', approved: false },
      app_metadata: { role: 'restaurant' },
    });

    if (authError) {
      const already = String(authError.message || '').toLowerCase().includes('already');
      return res.status(already ? 409 : 500).json({
        success: false,
        message: already ? 'That username is already taken. Please choose another.' : authError.message,
      });
    }

    const userId = authData.user.id;
    const { error: profileError } = await supabase.from('users').upsert({
      id: userId,
      username,
      phone,
      name: ownerName,
      role: 'restaurant',
      approved: false,
      must_change_password: true,
      favourites: [],
      created_at: new Date().toISOString(),
    }, { onConflict: 'id' });
    if (profileError) throw profileError;

    const { data: appRow, error: appError } = await supabase
      .from('restaurant_applications')
      .insert({
        id: genId('app-r'),
        user_id: userId,
        username,
        owner_name: ownerName,
        restaurant_name: restaurantName,
        cuisine,
        phone,
        status: 'pending',
      })
      .select()
      .single();
    if (appError) throw appError;

    return res.json({ success: true, application: appRow });
  } catch (error) {
    console.error('Restaurant application error:', error);
    return res.status(500).json({ success: false, message: error.message || String(error) });
  }
});

/**
 * Public: submit a rider partner application. Same pattern as restaurant applications.
 * POST /api/applications/rider
 */
app.post('/api/applications/rider', signupLimiter, async (req, res) => {
  try {
    const { username, password, name, phone } = req.body;
    if (!isNonEmptyString(username, 50) || !isNonEmptyString(password, 200) || !isNonEmptyString(name, 100) || !isValidPhoneNumber(phone)) {
      return res.status(400).json({ success: false, message: 'All fields are required and must be valid' });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters and contain both letters and numbers' });
    }

    const email = `${username}@budgetbites.local`;
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { name, phone, role: 'rider', approved: false },
      app_metadata: { role: 'rider' },
    });

    if (authError) {
      const already = String(authError.message || '').toLowerCase().includes('already');
      return res.status(already ? 409 : 500).json({
        success: false,
        message: already ? 'That username is already taken. Please choose another.' : authError.message,
      });
    }

    const userId = authData.user.id;
    const { error: profileError } = await supabase.from('users').upsert({
      id: userId,
      username,
      phone,
      name,
      role: 'rider',
      approved: false,
      must_change_password: true,
      favourites: [],
      created_at: new Date().toISOString(),
    }, { onConflict: 'id' });
    if (profileError) throw profileError;

    const { data: appRow, error: appError } = await supabase
      .from('rider_applications')
      .insert({
        id: genId('app-rd'),
        user_id: userId,
        username,
        name,
        phone,
        status: 'pending',
      })
      .select()
      .single();
    if (appError) throw appError;

    return res.json({ success: true, application: appRow });
  } catch (error) {
    console.error('Rider application error:', error);
    return res.status(500).json({ success: false, message: error.message || String(error) });
  }
});

/**
 * Admin: approve a pending restaurant application.
 * Creates the real restaurant row and flips the applicant's user profile to approved.
 * POST /api/admin/applications/restaurant/:id/approve
 */
app.post('/api/admin/applications/restaurant/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: app, error: appError } = await supabase
      .from('restaurant_applications')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (appError) throw appError;
    if (!app) return res.status(404).json({ success: false, message: 'Application not found' });
    if (app.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Application already ${app.status}` });
    }

    const restaurantId = genId('r');
    const { error: restaurantError } = await supabase.from('restaurants').upsert({
      id: restaurantId,
      name: app.restaurant_name,
      cuisine: app.cuisine,
      image: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=400&h=300&fit=crop',
      rating: 0,
      delivery_fee: 50,
      delivery_time: '20-30 min',
      is_open: true,
      approved: true,
    }, { onConflict: 'id' });
    if (restaurantError) throw restaurantError;

    if (app.user_id) {
      const { error: userError } = await supabase
        .from('users')
        .update({ approved: true, restaurant_id: restaurantId })
        .eq('id', app.user_id);
      if (userError) throw userError;
    }

    const { error: updateAppError } = await supabase
      .from('restaurant_applications')
      .update({ status: 'approved' })
      .eq('id', id);
    if (updateAppError) throw updateAppError;

    return res.json({ success: true, restaurantId });
  } catch (error) {
    console.error('Approve restaurant application error:', error);
    return res.status(500).json({ success: false, message: error.message || String(error) });
  }
});

/**
 * Admin: reject a pending restaurant application. The applicant's auth user remains
 * unapproved (and therefore cannot log in) — it is not deleted, in case of appeal.
 * POST /api/admin/applications/restaurant/:id/reject
 */
app.post('/api/admin/applications/restaurant/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('restaurant_applications')
      .update({ status: 'rejected' })
      .eq('id', id);
    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    console.error('Reject restaurant application error:', error);
    return res.status(500).json({ success: false, message: error.message || String(error) });
  }
});

/**
 * Admin: approve a pending rider application.
 * POST /api/admin/applications/rider/:id/approve
 */
app.post('/api/admin/applications/rider/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { data: app, error: appError } = await supabase
      .from('rider_applications')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (appError) throw appError;
    if (!app) return res.status(404).json({ success: false, message: 'Application not found' });
    if (app.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Application already ${app.status}` });
    }

    const riderId = genId('rd');
    const { error: riderError } = await supabase.from('riders').upsert({
      id: riderId,
      name: app.name,
      phone: app.phone,
      approved: true,
      available: true,
      rate_per_km: 20,
      rating: 0,
      rating_count: 0,
      total_earnings: 0,
      completed_deliveries: 0,
      is_verified: false,
    }, { onConflict: 'id' });
    if (riderError) throw riderError;

    if (app.user_id) {
      const { error: userError } = await supabase
        .from('users')
        .update({ approved: true, rider_id: riderId })
        .eq('id', app.user_id);
      if (userError) throw userError;
    }

    const { error: updateAppError } = await supabase
      .from('rider_applications')
      .update({ status: 'approved' })
      .eq('id', id);
    if (updateAppError) throw updateAppError;

    return res.json({ success: true, riderId });
  } catch (error) {
    console.error('Approve rider application error:', error);
    return res.status(500).json({ success: false, message: error.message || String(error) });
  }
});

/**
 * Admin: reject a pending rider application.
 * POST /api/admin/applications/rider/:id/reject
 */
app.post('/api/admin/applications/rider/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase
      .from('rider_applications')
      .update({ status: 'rejected' })
      .eq('id', id);
    if (error) throw error;
    return res.json({ success: true });
  } catch (error) {
    console.error('Reject rider application error:', error);
    return res.status(500).json({ success: false, message: error.message || String(error) });
  }
});

app.post('/api/meals', requireAuth, requireRestaurantOwnerOrAdmin, async (req, res) => {
  try {
    const { meal } = req.body;
    if (!isNonEmptyString(meal?.name, 150) || !isPositiveNumber(meal?.price)) {
      return res.status(400).json({ success: false, message: 'meal.name and a valid meal.price are required' });
    }

    // Defense in depth: even if a client is tampered with, only restaurants the
    // admin has granted "Secret Menu Partner" status can persist a secret item.
    let isSecret = meal.isSecret || false;
    if (isSecret) {
      const { data: restaurant, error: restaurantError } = await supabase
        .from('restaurants')
        .select('secret_menu_partner')
        .eq('id', meal.restaurantId)
        .maybeSingle();
      if (restaurantError) throw restaurantError;
      if (!restaurant?.secret_menu_partner) {
        isSecret = false;
      }
    }

    const { error } = await supabase.from('meals').upsert({
      id: meal.id,
      name: meal.name,
      price: meal.price,
      restaurant_id: meal.restaurantId,
      restaurant_name: meal.restaurantName,
      kind: meal.kind,
      rating: meal.rating || 0,
      rating_count: meal.ratingCount || 0,
      category: meal.category,
      image: meal.image,
      description: meal.description,
      available: meal.available,
      availability_status: meal.availabilityStatus,
      time_slots: meal.timeSlots,
      order_count: meal.orderCount || 0,
      is_secret: isSecret,
      prep_time_minutes: meal.prepTimeMinutes,
      daily_prep_limit: meal.dailyPrepLimit,
      prep_limit_used: meal.prepLimitUsed || 0,
    }, { onConflict: 'id' });
    if (error) throw error;
    res.json({ success: true, isSecret });
  } catch (error) {
    console.error('Create meal error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    const { order } = req.body;
    if (
      !order ||
      !Array.isArray(order.items) ||
      order.items.length === 0 ||
      !isNonEmptyString(order.customerName, 100) ||
      !isValidPhoneNumber(order.customerPhone) ||
      !isPositiveNumber(order.grandTotal)
    ) {
      return res.status(400).json({ success: false, message: 'A valid order with items, customerName, customerPhone, and grandTotal is required' });
    }
    const checkoutRequestID = order.mpesaCheckoutRequestID || null;
    const paymentCache = checkoutRequestID ? mpesaResultCache.get(`result_${checkoutRequestID}`) : null;

    // Detect brand-new vs. re-submitted orders BEFORE the upsert below, so we
    // only tally order_count/prep_limit_used once per real order and never
    // double-count on a retried request for an order that already exists.
    const { data: existingOrderRow } = await supabase
      .from('orders')
      .select('id')
      .eq('order_number', order.id)
      .maybeSingle();
    const isNewOrder = !existingOrderRow;

    // Security: the amount M-Pesa actually confirms paid (paymentCache.amount, sourced from
    // Safaricom's own callback metadata) must match what the client claims the order costs
    // (order.grandTotal). Without this check, a tampered client could request an STK push for
    // a smaller amount than the real cart total, pay that, and still have the order accepted
    // as fully paid/"preparing". Allow a small tolerance for currency rounding only.
    const AMOUNT_MISMATCH_TOLERANCE_KES = 1;
    const paymentAmountMismatch = !!(
      paymentCache?.success &&
      typeof paymentCache.amount === 'number' &&
      typeof order.grandTotal === 'number' &&
      Math.abs(paymentCache.amount - order.grandTotal) > AMOUNT_MISMATCH_TOLERANCE_KES
    );
    if (paymentAmountMismatch) {
      console.warn(`Order ${order.id}: M-Pesa paid amount (${paymentCache.amount}) does not match claimed grandTotal (${order.grandTotal}) — flagging as payment mismatch, not accepting as paid.`);
    }

    const mpesaPaymentStatus = paymentAmountMismatch
      ? 'failed'
      : paymentCache
        ? (paymentCache.success ? 'completed' : 'failed')
        : (order.mpesaPaymentStatus || 'pending');
    const resolvedStatus = paymentAmountMismatch
      ? 'cancelled'
      : paymentCache?.success
        ? 'preparing'
        : (paymentCache?.terminal ? 'cancelled' : (order.status || 'pending'));
    const mismatchDeclineReason = paymentAmountMismatch
      ? `Payment amount mismatch: paid KES ${paymentCache.amount}, order total KES ${order.grandTotal}. Flagged for review — not accepted.`
      : null;

    // Defense in depth: an order carrying any secret-menu item may only be assigned
    // to a rider the admin has vetted as an "Inner Circle" trusted courier. If a
    // tampered client tries to sneak an untrusted rider onto a secret order, strip
    // the assignment server-side rather than reject the whole order.
    let riderId = order.riderId || null;
    let riderName = order.riderName || null;
    let riderPhone = order.riderPhone || null;
    const hasSecretItem = Array.isArray(order.items) && order.items.some(item => item?.meal?.isSecret);
    if (hasSecretItem && riderId) {
      const { data: rider, error: riderError } = await supabase
        .from('riders')
        .select('secret_menu_trusted')
        .eq('id', riderId)
        .maybeSingle();
      if (riderError) throw riderError;
      if (!rider?.secret_menu_trusted) {
        riderId = null;
        riderName = null;
        riderPhone = null;
      }
    }

    const { error } = await supabase.from('orders').upsert({
      id: order.id,
      order_number: order.id,
      items: order.items,
      restaurant_name: order.restaurantName,
      restaurant_id: order.restaurantId,
      subtotal: order.subtotal,
      restaurant_fee: order.restaurantFee,
      rider_fee: order.riderFee,
      total: order.total,
      delivery_fee: order.deliveryFee,
      grand_total: order.grandTotal,
      customer_name: order.customerName,
      customer_phone: order.customerPhone,
      customer_location: order.customerLocation,
      landmark_id: order.landmarkId,
      status: resolvedStatus,
      notes: order.notes,
      rider_id: riderId,
      rider_name: riderName,
      rider_phone: riderPhone,
      estimated_distance_km: order.estimatedDistanceKm,
      payment_method: order.paymentMethod || 'mpesa',
      mpesa_checkout_request_id: checkoutRequestID,
      mpesa_payment_status: mpesaPaymentStatus,
      mpesa_receipt_number: paymentCache?.mpesaReceiptNumber || order.mpesaReceiptNumber,
      decline_reason: mismatchDeclineReason || (paymentCache?.success ? null : (paymentCache?.resultDesc || order.declineReason)),
      rider_cash_collected: order.riderCashCollected || false,
      created_at: order.createdAt || new Date().toISOString(),
    }, { onConflict: 'order_number' });

    if (error) throw error;

    // Tally real order counts + today's prep-limit usage onto the meals table
    // (atomic, service-role RPC — see supabase-schema.sql). Only for genuinely
    // new orders, so retries of an existing order never double-count.
    if (isNewOrder) {
      const mealItems = order.items
        .filter(it => it?.meal?.id && isPositiveNumber(it.quantity))
        .map(it => ({ mealId: it.meal.id, quantity: it.quantity }));
      if (mealItems.length > 0) {
        const { error: tallyError } = await supabase.rpc('increment_meal_order_counts', { p_items: mealItems });
        if (tallyError) console.error('Create order: meal order-count tally error:', tallyError.message);
      }
    }

    // Notify the restaurant's owner(s) and all admins that a new order came in.
    // Done here (service role, same request as the order insert) rather than
    // client-side, so the notification insert can never race the order insert
    // and doesn't depend on the notifications RLS policy at all.
    try {
      const { data: owners } = await supabase
        .from('users')
        .select('id')
        .eq('role', 'restaurant')
        .eq('restaurant_id', order.restaurantId)
        .eq('approved', true);
      const { data: admins } = await supabase
        .from('users')
        .select('id')
        .eq('role', 'admin');

      const notifications = [
        ...(owners || []).map(u => ({
          id: genId('notif'),
          user_id: u.id,
          message: `🆕 New order ${order.id} (KES ${order.total}) at ${order.customerLocation || ''}`,
          order_id: order.id,
          type: 'order',
          read: false,
        })),
        ...(admins || []).map(u => ({
          id: genId('notif'),
          user_id: u.id,
          message: `📥 Order ${order.id} placed at ${order.restaurantName}`,
          order_id: order.id,
          type: 'order',
          read: false,
        })),
      ];
      if (notifications.length > 0) {
        const { error: notifError } = await supabase.from('notifications').insert(notifications);
        if (notifError) console.error('Create order: notification insert error:', notifError.message);
      }
    } catch (notifyErr) {
      console.error('Create order: failed to notify recipients:', notifyErr.message);
    }

    res.json({ success: true, orderId: order.id, riderId });
  } catch (error) {
    console.error('Create order error:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ===========================================
// 404 + Global Error Handling
// ===========================================

// Catch requests to unknown routes.
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Not found' });
});

// Final safety net: catches anything thrown/rejected in a route that wasn't handled locally
// (e.g. a bug in a try-catch, a sync throw, or an unexpected library error). Never leaks
// stack traces or internal error details to the client — full detail goes to server logs only.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`Unhandled error on ${req.method} ${req.path}:`, err);
  if (res.headersSent) {
    return next(err);
  }
  res.status(500).json({ success: false, message: 'Internal server error' });
});

// ===========================================
// Start Server
// ===========================================

app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════╗
║     Budget Bites Backend Server            ║
╠════════════════════════════════════════════╣
║  Port: ${PORT}
║  Environment: ${process.env.NODE_ENV || 'development'}
║  M-Pesa: ${process.env.MPESA_ENV || 'sandbox'}
║  Database: Supabase (Live Sync)
╚════════════════════════════════════════════╝
  `);
});

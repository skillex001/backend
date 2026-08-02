/**
 * Diagnostic script: verifies the M-Pesa (Daraja) configuration in .env works.
 * It does NOT print secrets — only masked summaries.
 *
 * Checks:
 *  1. MPESA_ENV value
 *  2. Shortcode sanity (sandbox default is 174379)
 *  3. Callback URL must be HTTPS + publicly reachable (it will be called by Safaricom)
 *  4. OAuth token generation (proves consumer key/secret are valid)
 *
 * Usage:
 *   node scripts/test-mpesa.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');

function mask(v) {
  if (!v) return '(missing)';
  if (typeof v !== 'string' || v.length <= 6) return '(set, suspiciously short)';
  return `(set, len=${v.length}, ends ${v.slice(-4)})`;
}

async function getToken() {
  const env = process.env.MPESA_ENV || 'sandbox';
  const consumerKey = env === 'production' ? process.env.MPESA_PROD_CONSUMER_KEY : process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = env === 'production' ? process.env.MPESA_PROD_CONSUMER_SECRET : process.env.MPESA_CONSUMER_SECRET;
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

  const url = env === 'production'
    ? 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials'
    : 'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';

  const response = await axios.get(url, {
    headers: { Authorization: `Basic ${auth}` },
    timeout: 15000,
  });
  return response.data.access_token;
}

async function main() {
  const env = process.env.MPESA_ENV || 'sandbox';
  const shortcode = process.env.MPESA_SHORTCODE;
  const callbackUrl = process.env.MPESA_CALLBACK_URL;

  console.log('=== M-Pesa Diagnostic ===');
  console.log(`MPESA_ENV:         ${env}`);
  console.log(`Shortcode:         ${shortcode} ${env === 'sandbox' && shortcode !== '174379' ? '⚠️ sandbox usually requires 174379' : ''}`);
  console.log(`Consumer Key:      ${mask(process.env.MPESA_CONSUMER_KEY)}`);
  console.log(`Consumer Secret:   ${mask(process.env.MPESA_CONSUMER_SECRET)}`);
  console.log(`Passkey:           ${mask(process.env.MPESA_PASSKEY)}`);
  console.log(`Callback URL:      ${callbackUrl}`);
  if (callbackUrl && !/^https:\/\//.test(callbackUrl)) {
    console.log('  ❌ Callback URL must be HTTPS for Safaricom to reach it.');
  }

  console.log('\n--- Testing OAuth token generation ---');
  try {
    const token = await getToken();
    console.log(`✅ Token OK (len=${token.length}). Credentials are valid.`);
  } catch (error) {
    const resp = error.response?.data;
    console.log('❌ Token request failed.');
    console.log('   Status:', error.response?.status || error.code);
    console.log('   Body:', JSON.stringify(resp || error.message));
    if (error.response?.status === 401) {
      console.log('   → Consumer key/secret are likely wrong. Re-copy them from https://developer.safaricom.co.ke/');
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Unexpected error:', err.message);
    process.exit(1);
  });


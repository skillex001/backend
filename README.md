# Budget Bites Backend

Node.js + Express backend powering [Budget Bites](https://www.budget-bites.food) — M-Pesa STK Push (Safaricom Daraja API), M-Pesa callbacks, Supabase integration (service-role for order/payment updates), live order notifications, and admin/partner management.

## 🚀 Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up Environment Variables

```bash
cp .env.example .env
```

Then fill in `.env` with your **real** values. Never commit `.env` — it is git-ignored.

- **Supabase** (project URL, service-role key) — Supabase Dashboard → Settings → API
- **M-Pesa Daraja credentials** — https://developer.safaricom.co.ke/

### 3. (Optional) Seed Demo Users

```bash
npm run seed
```

Creates demo admin/restaurant/rider accounts with randomly generated temporary passwords (printed once to the terminal).

### 4. Start Server

```bash
npm run dev      # development (nodemon)
npm start        # production
```

Server runs on `http://localhost:3000`

## 📱 M-Pesa Setup

### For Local Development

1. Install ngrok: https://ngrok.com/
2. Start ngrok: `ngrok http 3000`
3. Copy the HTTPS URL (e.g., `https://abc123.ngrok-free.app`)
4. Update `.env`:
   ```
   MPESA_CALLBACK_URL=https://abc123.ngrok-free.app/api/mpesa/callback
   ```

### For Production

1. Deploy to a hosting service (Railway, Render, etc.)
2. Set `MPESA_CALLBACK_URL` to your production domain
3. Set `CORS_ORIGIN` to your frontend domain(s), comma-separated:
   ```
   CORS_ORIGIN=https://www.budget-bites.food,https://budget-bites.food
   ```

## 🔑 Getting M-Pesa Credentials

1. Go to https://developer.safaricom.co.ke/
2. Create an account
3. Create a new app
4. Get your **Consumer Key** and **Consumer Secret**
5. For production, you'll need:
   - Production credentials (separate from sandbox)
   - Your actual Paybill number
   - Your production passkey

## 📡 API Endpoints

### M-Pesa

- `POST /api/mpesa/stkpush` - Initiate STK push (rate-limited)
- `POST /api/mpesa/callback` - M-Pesa callback (for Safaricom)
- `GET /api/mpesa/status/:checkoutRequestID` - Query payment status

### Orders

- `POST /api/orders` - Create/update order
- `GET /api/bootstrap` - Public bootstrap data (restaurants, meals, riders, landmarks, distances, recent orders, applications)

### Restaurants / Riders / Users (admin)

- `POST /api/admin/restaurants/create` - Admin: create restaurant account
- `POST /api/admin/riders/create` - Admin: create rider account
- `POST /api/admin/users/ensure-profile` - Self: ensure own profile row exists
- `POST /api/admin/users/reset-password` - Admin: reset restaurant/rider password
- `POST /api/admin/applications/restaurant/:id/approve|reject` - Admin
- `POST /api/admin/applications/rider/:id/approve|reject` - Admin
- `POST /api/admin/restaurants/verify` - Admin
- `POST /api/admin/restaurants/secret-menu-partner` - Admin
- `POST /api/admin/riders/verify` - Admin
- `POST /api/admin/riders/trusted-courier` - Admin

### Public Applications

- `POST /api/applications/restaurant` - Submit restaurant partner application
- `POST /api/applications/rider` - Submit rider partner application

### System

- `GET /api/health` - Health check

## 🛡️ Security

- **CORS** is restricted to configured frontend origins (never `*`)
- **Rate limiting** on unauthenticated signup + payment endpoints
- **JWT auth** verified on all admin/partner routes (via Supabase `getUser`)
- **Service-role key** never leaves the server; used only for privileged DB operations
- **Amount-mismatch guard** on M-Pesa order payments
- **Redacted logging** — callback logs never include full phone numbers/receipts
- **Admin-gated** restaurant/rider creation and password resets

## 📝 Environment Variables

See `.env.example` for the full template. All values below must be set in your deployment environment, **never** committed.

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `NODE_ENV` | `development` or `production` |
| `SUPABASE_URL` / `VITE_SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` / `VITE_SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key |
| `CORS_ORIGIN` | Comma-separated allowed frontend origins |
| `MPESA_ENV` | `sandbox` or `production` |
| `MPESA_CONSUMER_KEY` | Daraja consumer key (sandbox) |
| `MPESA_CONSUMER_SECRET` | Daraja consumer secret (sandbox) |
| `MPESA_PROD_CONSUMER_KEY` | Daraja consumer key (production) |
| `MPESA_PROD_CONSUMER_SECRET` | Daraja consumer secret (production) |
| `MPESA_SHORTCODE` | Paybill/Till number |
| `MPESA_PASSKEY` | M-Pesa passkey |
| `MPESA_CALLBACK_URL` | Public HTTPS callback URL |
| `MPESA_ACCOUNT_REF` | Default STK account reference (default: BudgetBites) |
| `MPESA_TRANSACTION_DESC` | Default STK transaction description |

## 🚨 Troubleshooting

### M-Pesa STK Push Fails

1. Check credentials are correct
2. Verify phone format (must be `2547XXXXXXXX`)
3. Check callback URL is publicly accessible over HTTPS
4. Check ngrok is running (local dev)
5. Confirm `MPESA_ENV` matches the credentials you're using (sandbox vs production)

### Supabase Connection Errors

1. Verify `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env` / host
2. Use the **service-role** key (not the anon key) — the server validates the JWT role
3. Ensure the service-role key is rotated in Supabase Dashboard if it has ever leaked

## 📦 Deployment

### Railway

1. Connect the GitHub repo
2. Add environment variables in the Railway dashboard (all values from the table above)
3. Deploy

### Render

1. Create a new Web Service
2. Connect the repo
3. Add environment variables
4. Deploy

## 📞 Support

For issues or questions, contact the project maintainers via the [Budget Bites website](https://www.budget-bites.food).


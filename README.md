# Budget Bites Backend

Node.js + Express backend with M-Pesa STK Push integration and Firebase Firestore.

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Set Up Environment Variables

```bash
cp .env.example .env
```https://ctuogfqjlxfestkbxrde.supabase.co/rest/v1/

Edit `.env` and fill in:

- **Firebase credentials** (from Firebase Console → Project Settings → Service Accounts)
- **M-Pesa Daraja credentials** (from https://developer.safaricom.co.ke/)

### 3. Initialize Database

```bash
npm run setup
```

This creates:
- Admin user account
- Sample restaurants
- Sample meals
- Landmarks
- Platform settings

### 4. Start Server

```bash
npm run dev
```

Server runs on `http://localhost:3000`

## 📱 M-Pesa Setup

### For Local Development

1. Install ngrok: https://ngrok.com/
2. Start ngrok: `ngrok http 3000`
3. Copy the HTTPS URL (e.g., `https://abc123.ngrok.io`)
4. Update `.env`:
   ```
   MPESA_CALLBACK_URL=https://abc123.ngrok.io/api/mpesa/callback
   ```

### For Production

1. Deploy to a hosting service (Heroku, Railway, Render, etc.)
2. Update `MPESA_CALLBACK_URL` to your production domain
3. Update `CORS_ORIGIN` to your frontend domain

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

- `POST /api/mpesa/stkpush` - Initiate STK push
- `POST /api/mpesa/callback` - M-Pesa callback (for Safaricom)
- `GET /api/mpesa/status/:checkoutRequestID` - Query payment status

### Orders

- `GET /api/orders` - Get all orders (with filters)
- `POST /api/orders` - Create new order
- `PATCH /api/orders/:orderId` - Update order status

### Restaurants

- `GET /api/restaurants` - Get all restaurants
- `GET /api/restaurants/:id/menu` - Get restaurant menu

### System

- `GET /api/health` - Health check

## 🔥 Firebase Collections

- `users` - User accounts (admin, restaurant, rider, customer)
- `restaurants` - Restaurant profiles
- `meals` - Menu items
- `orders` - Order records
- `riders` - Rider profiles
- `landmarks` - Delivery locations
- `notifications` - System notifications
- `settings` - Platform configuration

## 🛡️ Security

- CORS is configured to only allow your frontend domain
- M-Pesa callbacks are validated
- Rate limiting on STK push requests
- JWT authentication (implement as needed)

## 📝 Environment Variables

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `FIREBASE_PROJECT_ID` | Firebase project ID |
| `FIREBASE_CLIENT_EMAIL` | Service account email |
| `FIREBASE_PRIVATE_KEY` | Service account private key |
| `MPESA_ENV` | `sandbox` or `production` |
| `MPESA_CONSUMER_KEY` | Daraja consumer key |
| `MPESA_CONSUMER_SECRET` | Daraja consumer secret |
| `MPESA_SHORTCODE` | Paybill number |
| `MPESA_PASSKEY` | M-Pesa passkey |
| `MPESA_CALLBACK_URL` | Public callback URL |

## 🚨 Troubleshooting

### M-Pesa STK Push Fails

1. Check if credentials are correct
2. Verify phone number format (must be 2547XXXXXXXX)
3. Check if callback URL is publicly accessible
4. Check ngrok is running (for local dev)

### Firebase Connection Errors

1. Verify service account credentials
2. Check Firestore is enabled in Firebase Console
3. Ensure service account has Firestore admin permissions

## 📦 Deployment

### Heroku

```bash
heroku create budget-bites-backend
heroku config:set FIREBASE_PROJECT_ID=xxx
heroku config:set FIREBASE_CLIENT_EMAIL=xxx
# ... set all env vars
git push heroku main
```

### Railway

1. Connect GitHub repo
2. Add environment variables in Railway dashboard
3. Deploy

### Render

1. Create new Web Service
2. Connect repo
3. Add environment variables
4. Deploy

## 📞 Support

For issues or questions, contact:
- Email: admin@budgetbites.co.ke
- Phone: +254 700 000 000

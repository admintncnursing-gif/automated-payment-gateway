# 📘 ArchXpay • Complete Setup & Deployment Guide

> **UPI checkout prototype with Google sign-in, merchant application review, API documentation, and Gmail alert matching.**

---

## 📑 Table of Contents

1. [System Overview & Architecture](#1-system-overview--architecture)
2. [Prerequisites Checklist](#2-prerequisites-checklist)
3. [Step 1: Local Installation & Environment Setup](#3-step-1-local-installation--environment-setup)
4. [Step 2: Configuring Gmail IMAP & App Password](#4-step-2-configuring-gmail-imap--app-password)
5. [Step 3: Setting Up Supabase](#5-step-3-setting-up-supabase)
6. [Step 4: Running Locally & Testing](#6-step-4-running-locally--testing)
7. [Step 5: Optional Supabase Edge Checkout API](#7-step-5-optional-supabase-edge-checkout-api)
8. [Step 6: Deploying the complete portal](#8-step-6-deploying-the-complete-portal)
9. [Step 7: Keep the Node server running](#9-step-7-keep-the-node-server-running)
10. [Architecture Details: Intent Schemes & Concurrency](#10-architecture-details-intent-schemes--concurrency)
11. [Troubleshooting & FAQ](#11-troubleshooting--faq)

---

## 1. System Overview & Architecture

ArchXpay creates UPI payment requests and matches configured Gmail alerts to orders. Email matching is not equivalent to bank-authoritative payment confirmation or a regulated payment processor. Verify legal, banking, privacy, and security requirements before accepting real payments.

### Verification Flow

```
[Customer opens Checkout]
       │
       ▼
[Dynamic QR & 1-Tap Intent Generated with Micro-Paise Offset (e.g. ₹1.02)]
       │
       ▼
[Customer pays via PhonePe / GPay / Paytm / Navi / FamPay]
       │
       ▼
[Bank sends Transaction Alert Email to your Gmail inbox]
       │
       ▼
[ArchXpay IMAP daemon detects the merchant's configured Gmail alert]
       │
       ▼
[Regex extracts exact Amount, UTR, and TxnId -> Marks Order 'PAID']
       │
       ▼
[Checkout Paywall auto-detects status -> Displays Green Success Receipt 🎉]
```

---

## 2. Prerequisites Checklist

Ensure you have the following before starting:

- [x] **Node.js**: v22.0.0 or higher installed (`node -v`)
- [x] **NPM**: v9.0.0 or higher (`npm -v`)
- [x] **Gmail Account**: With **2-Step Verification** turned on (for generating an App Password).
- [x] **Supabase Project**: with both checked-in migrations applied and Google Auth enabled.
- [x] **UPI Handle**: Your personal or business UPI ID (e.g., `yourname@fam`, `yourname@okhdfcbank`, `yournumber@paytm`).

---

## 3. Step 1: Local Installation & Environment Setup

1. **Extract or Open the Project Folder**:
   ```bash
   cd payment-gateway
   ```

2. **Install Root Dependencies**:
   ```bash
   npm install
   ```

3. **Create your `.env` file**:
   Copy `.env.example` to `.env`:
   ```bash
   # Windows PowerShell:
   Copy-Item .env.example .env

   # Linux / macOS:
   cp .env.example .env
   ```

---

## 4. Step 2: Configuring Gmail IMAP & App Password

To enable ArchXpay's daemon to detect bank credit alerts in real time:

1. Log into your Google Account at [myaccount.google.com](https://myaccount.google.com/).
2. Navigate to **Security** and confirm that **2-Step Verification** is **ON**.
3. Go directly to **App Passwords**: [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
4. Enter an App Name (e.g., `ArchXpay Daemon`) and click **Create**.
5. Copy the generated **16-character password** (format: `xxxx xxxx xxxx xxxx`).
6. Enable IMAP in Gmail Settings:
   - Go to [mail.google.com](https://mail.google.com) > Click the **Gear icon** (Settings) > **See all settings**.
   - Open the **Forwarding and POP/IMAP** tab.
   - Select **Enable IMAP** and click **Save Changes**.

Enter the Gmail address and App Password on the merchant application form. The password is encrypted by the Node server before it is stored in Supabase; it is not a global `.env` value.

---

## 5. Step 3: Setting Up Supabase

1. Create or open your project at [Supabase](https://supabase.com/).
2. In **Project Settings > API**, copy the project URL, anon key, and service-role key.
3. Configure Google as an Auth provider and set the site's URL plus the local/deployed callback URL in Supabase Auth URL settings.
4. Add the values to the Node server's `.env`. Never put the service-role key in browser code or commit it. Merchant Gmail App Passwords entered in the dashboard are encrypted with server-side secrets.
5. Sign in to the Supabase CLI locally, link this project, and apply all checked-in migrations:
   ```bash
   npx supabase login
   npx supabase link --project-ref your-project-id
   npx supabase db push
   ```

The CLI uses a Supabase personal access token for project management; it is not a database key. The migration makes `shashanksv2009@gmail.com` the super admin when that Google account authenticates. Rotate any service-role key that was exposed in a file or commit.

---

## 6. Step 4: Running Locally & Testing

### Complete `.env` Reference

Your `.env` file should look like this:
```env
PORT=3000
SUPABASE_URL=https://your-project-id.supabase.co
SUPABASE_ANON_KEY=your-supabase-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-key
```

### Start the Server

```bash
npm start
# or in development with auto-reload:
npm run dev
```

You should see:
```text
====================================================
🚀 ArchXpay Platform running at: http://localhost:3000
🔐 Supabase Auth merchant onboarding and review enabled
====================================================
```

### Accessing the Interfaces

- **Merchant portal**: Open [http://localhost:3000](http://localhost:3000), sign in with Google, and submit the merchant application.
- **Admin portal**: Sign in as `shashanksv2009@gmail.com` to review applications and manage roles, permissions, flags, maintenance mode, and logs.
- **Payment APIs**: Available only after a merchant application is approved.

---

## 7. Step 5: Optional Supabase Edge Checkout API

1. Sign in to the Supabase CLI. It will prompt for your personal access token locally:
   ```bash
   npx supabase login
   ```
2. Link this checkout to the project reference from your Supabase URL and push the schema migration:
   ```bash
   npx supabase link --project-ref your-project-id
   npx supabase db push
   ```
3. Deploy the public checkout API if you need it separately from the Express server:
   ```bash
   npx supabase functions deploy payment-gateway --no-verify-jwt
   ```
4. The Edge Function supports public checkout endpoints only. The authenticated merchant/admin portal and persistent Gmail IMAP watcher require the Node server.

---

## 8. Step 6: Deploying the complete portal

Deploy the full repository to a persistent Node.js host such as Railway, Render, or a VPS. Configure the environment variables from Step 4, run `npm ci`, then `npm start`. Do not deploy only the `public/` folder as a static site: the portal depends on authenticated Express APIs and the persistent Node IMAP process. Configure Supabase's OAuth redirect allowlist for the deployed origin.

---

## 9. Step 7: Keep the Node server running

The Express application also runs the Gmail IMAP watcher, so it must stay continuously active.

### Option A: Using PM2 (Recommended for VPS / Cloud Server)

1. Install PM2 globally:
   ```bash
   npm install -g pm2
   ```
2. Start ArchXpay:
   ```bash
   pm2 start server.js --name archxpay
   ```
3. Enable auto-restart on system reboot:
   ```bash
   pm2 startup
   pm2 save
   ```
4. View real-time logs:
   ```bash
   pm2 logs archxpay
   ```

### Option B: Using Docker

Create a `Dockerfile`:
```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]
```
Build and run:
```bash
docker build -t archxpay .
docker run -d --restart always --name archxpay-gateway -p 3000:3000 --env-file .env archxpay
```

---

## 10. Architecture Details: Intent Schemes & Concurrency

### 1. Strict NPCI UPI Intent URI Rule
Implemented in `src/utils/qr.util.js`:
```javascript
upi://pay?pa=${cleanVpa}&pn=${cleanName}&am=${cleanAmount}&tr=${txnRef}&tn=${cleanNote}&cu=INR&mode=00
```
- **Crucial Rule on `pa`**: The `@` symbol in `pa` **MUST NOT** be percent-encoded (`%40`). Major UPI apps (GPay, PhonePe, Paytm) reject `%40` as an invalid handle.
- **`mode=00`**: Mandatory parameter required by strict bank clients like Paytm to prevent rejection.

### 2. Targeted Mobile Deep-Links
Implemented in `public/js/checkout.js`:
- **Universal UPI Selector / FamPay**: `upi://pay?...`
- **Google Pay**: `tez://upi/pay?...` (Uses registered Tez scheme)
- **PhonePe**: `phonepe://pay?...`
- **Paytm**: `intent://pay?...#Intent;scheme=upi;package=net.one97.paytm;end` (Android package targeting, fallback to `paytmmp://` on iOS)
- **Navi**: `intent://pay?...#Intent;scheme=com.naviapp;end`
- **super.money**: `intent://pay?...#Intent;scheme=upi;package=money.super.payments;end`

### 3. Anti-Collision Micro-Paise Offsets
When 2 or more customers pay concurrently, the engine queries active pending orders in the last 15 minutes and offsets the amount by ₹0.01:
- User A: ₹1.00
- User B: ₹1.01
- User C: ₹1.02
When the bank email arrives stating `"₹1.01 received"`, ArchXpay prepares verification for **only** User B's order. User A and User C remain safely isolated.

---

## 11. Troubleshooting & FAQ

| Problem | Cause | Solution |
| :--- | :--- | :--- |
| **`[IMAP] Authentication failed`** | Incorrect Gmail credentials or 2FA issue | Ensure 2-Step Verification is ON and you are using a 16-character **Google App Password**, not your normal Gmail password. |
| **Supabase connection or missing-table errors** | Missing environment variables or schema | Confirm `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`, then run `npx supabase db push`. |
| **PhonePe shows "Payment not allowed"** | Percent-encoded `@` (`%40`) or missing mode | ArchXpay explicitly leaves `@` unencoded and adds `mode=00`. Verify you are running the latest `src/utils/qr.util.js`. |
| **Payments not auto-verifying** | Bank alert email not delivered to Gmail | Verify that the merchant's configured Gmail receives the alert and that IMAP/App Password access remains enabled. |
| **Paywall shows an unavailable order** | Missing or unapproved order | Open a valid `/pay/:orderId` link generated for an approved merchant. |

---

<div align="center">
  <b>ArchXpay • UPI checkout platform</b><br>
  Open Source under the MIT License.
</div>

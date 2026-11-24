require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const { ImapFlow } = require('imapflow');
const crypto = require('crypto');

const store = require('./services/store');
const qrHelper = require('./services/qrHelper');
const watcherManager = require('./services/concurrencyWatcher');
const {
  getAuthUser,
  getClient,
  findPendingOrders,
  hasSupabaseAuthConfig,
  hasSupabaseConfig,
  publicConfig,
  upsertRecord
} = require('./services/supabase');
const { decryptCredential, encryptCredential } = require('./services/credentials');
const { hasPermission, isMerchantApproved, isSuperAdminEmail } = require('./services/authorization');
const { isValidPaymentReference, matchesPaymentReference } = require('./services/paymentVerification');

const app = express();
const PORT = process.env.PORT || 3000;

// Multer Storage Configuration for QR uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `qr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}${ext}`);
  }
});
const upload = multer({ storage });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadDir));
app.use('/api', async (req, res, next) => {
  try {
    await store.ready;
    next();
  } catch (error) {
    next(error);
  }
});

function publicMerchant(merchant) {
  if (!merchant) return null;
  const {
    gmailAppPass,
    gmailAppPassEncrypted,
    gmail_app_pass_encrypted,
    gmail_app_pass,
    password,
    ...safeMerchant
  } = merchant;
  return safeMerchant;
}

function merchantFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    authUserId: row.auth_user_id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    businessName: row.business_name,
    payeeName: row.payee_name,
    upiId: row.upi_id,
    targetApp: row.target_app,
    websiteUrl: row.website_url,
    qrImagePath: row.qr_image_path,
    gmailUser: row.gmail_user,
    gmailAppPass: decryptCredential(row.gmail_app_pass_encrypted || ''),
    apiKey: row.api_key,
    reviewStatus: row.review_status,
    reviewNote: row.review_note,
    isOnboarded: row.is_onboarded,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function loadProfile(user) {
  const client = getClient();
  const { data, error } = await client
    .from('profiles')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw error;
  if (data) return data;

  const isSuperAdmin = isSuperAdminEmail(user.email);
  const { data: created, error: insertError } = await client
    .from('profiles')
    .upsert({
      user_id: user.id,
      email: user.email || '',
      full_name: user.user_metadata?.full_name || user.user_metadata?.name || '',
      role: isSuperAdmin ? 'super_admin' : 'merchant'
    })
    .select('*')
    .single();
  if (insertError) throw insertError;
  return created;
}

async function requireAuth(req, res, next) {
  if (!hasSupabaseAuthConfig() || !hasSupabaseConfig()) {
    return res.status(503).json({ error: 'Supabase Auth and database configuration are required.' });
  }
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (!match) return res.status(401).json({ error: 'Sign in is required.' });
  const user = await getAuthUser(match[1]);
  if (!user) return res.status(401).json({ error: 'Your session is invalid or expired.' });
  const profile = await loadProfile(user);
  if (profile.account_status === 'suspended') {
    return res.status(403).json({ error: 'This account has been suspended. Contact support.' });
  }
  req.authUser = user;
  req.profile = profile;
  next();
}

function requirePermission(permission) {
  return (req, res, next) => {
    const permissions = Array.isArray(req.profile?.permissions) ? req.profile.permissions : [];
    if (hasPermission(req.profile, permission) && (
      req.profile?.role === 'super_admin' ||
      permissions.includes(permission)
    )) {
      return next();
    }
    return res.status(403).json({ error: 'You do not have permission to perform this action.' });
  };
}

async function findMerchantForUser(userId) {
  const { data, error } = await getClient()
    .from('merchants')
    .select('*')
    .eq('auth_user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

function getApprovedOrder(orderId) {
  const order = store.getOrder(orderId);
  const merchant = order ? store.getMerchantById(order.merchantId) : null;
  return isMerchantApproved(merchant) ? { order, merchant } : null;
}

async function getFeatureFlagsForUser(userId) {
  const { data, error } = await getClient()
    .from('feature_flags')
    .select('flag_key,enabled,user_id')
    .or(`user_id.is.null,user_id.eq.${userId}`);
  if (error) throw error;
  const flags = {};
  for (const flag of data || []) {
    if (flag.user_id === userId || !Object.hasOwn(flags, flag.flag_key)) {
      flags[flag.flag_key] = flag.enabled;
    }
  }
  return flags;
}

function requireFeature(flagKey) {
  return async (req, res, next) => {
    const flags = await getFeatureFlagsForUser(req.authUser.id);
    if (flags[flagKey] === false) {
      return res.status(403).json({ error: `The ${flagKey} feature is currently disabled for this account.` });
    }
    next();
  };
}

async function requireApprovedMerchant(req, res, next) {
  const merchant = await findMerchantForUser(req.authUser.id);
  if (!isMerchantApproved(merchant)) {
    return res.status(403).json({
      error: 'Merchant access is not approved.',
      reviewStatus: merchant?.review_status || 'not_submitted'
    });
  }
  req.merchant = store.getMerchantById(merchant.id) || merchantFromRow(merchant);
  if (req.merchant.gmailUser && req.merchant.gmailAppPass) {
    watcherManager.getOrCreate(req.merchant);
  }
  const { data: maintenance, error } = await getClient()
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'maintenance')
    .maybeSingle();
  if (error) throw error;
  if (maintenance?.setting_value?.enabled) {
    return res.status(503).json({
      error: maintenance.setting_value.message || 'The service is temporarily unavailable for maintenance.'
    });
  }
  next();
}

app.get('/api/config', async (req, res) => {
  const config = publicConfig();
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    return res.status(503).json({ error: 'Set SUPABASE_URL and SUPABASE_ANON_KEY in the Vercel production environment.' });
  }
  let maintenance = { enabled: false, message: '' };
  if (hasSupabaseConfig()) {
    const { data, error } = await getClient()
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'maintenance')
    .maybeSingle();
    if (error && error.code !== 'PGRST205') throw error;
    if (!error) maintenance = data?.setting_value || maintenance;
  }
  res.json({
    ...config,
    maintenance,
    backendConfigured: hasSupabaseConfig()
  });
});

// ==============================================================
// 1. AUTHENTICATION ENDPOINTS
// ==============================================================

// Get current merchant profile
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const merchant = await findMerchantForUser(req.authUser.id);
  const featureFlags = await getFeatureFlagsForUser(req.authUser.id);
  res.json({
    success: true,
    user: {
      id: req.authUser.id,
      email: req.authUser.email,
      fullName: req.profile.full_name,
      role: req.profile.role,
      permissions: req.profile.permissions || [],
      accountStatus: req.profile.account_status
    },
    featureFlags,
    merchant: publicMerchant(merchantFromRow(merchant))
  });
});

// ==============================================================
// 2. ONBOARDING WIZARD ENDPOINTS
// ==============================================================

// Upload and Auto-Decode FamPay / UPI QR Image
app.post('/api/merchant/upload-qr', requireAuth, upload.single('qrImage'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded' });
  }

  const filePath = req.file.path;
  const webPath = `/uploads/${path.basename(filePath)}`;

  // Automatically decode QR code to extract UPI ID
  const decoded = await qrHelper.decodeQrImage(filePath);

  res.json({
    success: true,
    qrImagePath: webPath,
    detectedUpiId: decoded.upiId || '',
    detectedPayeeName: decoded.payeeName || '',
    rawQrData: decoded.raw || ''
  });
});

// Test Gmail IMAP Connection Live
app.post('/api/merchant/test-email', requireAuth, async (req, res) => {
  const { gmailUser, gmailAppPass } = req.body;
  if (!gmailUser || !gmailAppPass) {
    return res.status(400).json({ error: 'Gmail address and App Password required' });
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: gmailUser.trim(),
      pass: gmailAppPass.replace(/\s+/g, '')
    },
    logger: false
  });

  try {
    await client.connect();
    let lock = await client.getMailboxLock('INBOX');
    const total = client.mailbox.exists;
    lock.release();
    res.json({
      success: true,
      message: 'Connected successfully to Gmail IMAP!',
      inboxCount: total
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: 'Gmail authentication failed. Please verify 2-Step Verification is enabled and use a 16-character App Password.'
    });
  } finally {
    if (client.usable) await client.logout();
  }
});

// Merchant applications are never approved automatically.
app.post('/api/merchant/complete-onboarding', requireAuth, async (req, res) => {
  const {
    fullName, phone, businessName, payeeName, upiId, targetApp, websiteUrl, gmailUser, gmailAppPass
  } = req.body;
  const normalizedName = String(fullName || '').trim();
  const normalizedPhone = String(phone || '').trim();
  const normalizedBusinessName = String(businessName || '').trim();
  const normalizedPayeeName = String(payeeName || '').trim();
  const normalizedUpiId = String(upiId || '').trim();
  const normalizedTargetApp = String(targetApp || '').trim();
  const normalizedWebsiteUrl = String(websiteUrl || '').trim();
  const normalizedGmailUser = String(gmailUser || '').trim().toLowerCase();
  const normalizedAppPass = String(gmailAppPass || '').replace(/\s+/g, '');

  if (!normalizedName || !/^\+?[1-9]\d{6,14}$/.test(normalizedPhone.replace(/[\s()-]/g, '')) ||
      !normalizedBusinessName || !normalizedPayeeName ||
      !/^[^@\s]+@[^@\s]+$/.test(normalizedUpiId) ||
      !['Website', 'Mobile app', 'Other'].includes(normalizedTargetApp) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedGmailUser) ||
      !/^[a-zA-Z0-9]{16}$/.test(normalizedAppPass)) {
    return res.status(400).json({ error: 'Complete all required merchant, UPI, Gmail, and 16-character App Password fields.' });
  }
  if (/website|web/i.test(normalizedTargetApp)) {
    try {
      const url = new URL(normalizedWebsiteUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported website protocol.');
    } catch {
      return res.status(400).json({ error: 'Enter a valid website URL for the website you will use.' });
    }
  }

  const client = getClient();
  const existing = await findMerchantForUser(req.authUser.id);
  if (existing && ['under_review', 'approved'].includes(existing.review_status)) {
    return res.status(409).json({
      error: existing.review_status === 'approved'
        ? 'Your merchant account is already approved.'
        : 'Your application is already under review.'
    });
  }
  const row = {
    name: normalizedName,
    email: req.authUser.email || '',
    phone: normalizedPhone,
    business_name: normalizedBusinessName,
    payee_name: normalizedPayeeName,
    upi_id: normalizedUpiId,
    target_app: normalizedTargetApp,
    website_url: normalizedWebsiteUrl,
    gmail_user: normalizedGmailUser,
    gmail_app_pass_encrypted: encryptCredential(normalizedAppPass),
    auth_user_id: req.authUser.id,
    review_status: 'pending',
    review_note: '',
    api_key: null,
    is_onboarded: false,
    updated_at: new Date().toISOString()
  };
  const result = existing
    ? await client.from('merchants').update(row).eq('id', existing.id).select('*').single()
    : await client.from('merchants').insert({
      ...row,
      id: `merch_${crypto.randomUUID()}`,
      qr_image_path: '/uploads/default-qr.jpeg'
    }).select('*').single();
  if (result.error) throw result.error;
  const { error: profileError } = await client
    .from('profiles')
    .update({ full_name: normalizedName, updated_at: new Date().toISOString() })
    .eq('user_id', req.authUser.id);
  if (profileError) throw profileError;
  const { error: auditError } = await client.from('audit_logs').insert({
    actor_user_id: req.authUser.id,
    action: existing ? 'merchant.application_resubmitted' : 'merchant.application_submitted',
    target_type: 'merchant',
    target_id: result.data.id
  });
  if (auditError) throw auditError;
  res.status(existing ? 200 : 201).json({
    success: true,
    merchant: publicMerchant(merchantFromRow(result.data))
  });
});

// ==============================================================
// 3. MERCHANT DASHBOARD ENDPOINTS
// ==============================================================

app.get('/api/merchant/dashboard', requireAuth, requireApprovedMerchant, requireFeature('merchant_dashboard'), async (req, res) => {
  const merchant = req.merchant;
  const merchantId = merchant.id;

  const [metricsResult, ordersResult] = await Promise.all([
    getClient().rpc('merchant_metrics', { target_merchant_id: merchantId }),
    getClient()
      .from('orders')
      .select('*')
      .eq('merchant_id', merchantId)
      .order('created_at', { ascending: false })
      .limit(10)
  ]);
  if (metricsResult.error) throw metricsResult.error;
  if (ordersResult.error) throw ordersResult.error;
  const orderRows = ordersResult.data || [];
  const orders = orderRows.map(row => ({
    orderId: row.order_id,
    merchantId: row.merchant_id,
    amount: Number(row.amount),
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    note: row.note,
    status: row.status,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
    paymentDetails: row.payment_details
  }));
  const watcher = watcherManager.get(merchantId);
  const watcherStatus = watcher ? watcher.getStatus() : { connected: false };

  res.json({
    success: true,
    merchant: publicMerchant(merchant),
    metrics: {
      totalVolume: Number(metricsResult.data.totalVolume),
      paidCount: Number(metricsResult.data.paidCount),
      pendingCount: Number(metricsResult.data.pendingCount),
      totalOrders: Number(metricsResult.data.totalOrders)
    },
    watcherStatus,
    recentOrders: orders.slice(0, 10)
  });
});

// Create Hosted Paywall Link
app.post('/api/merchant/create-paywall-link', requireAuth, requireApprovedMerchant, requireFeature('payment_links'), async (req, res) => {
  const merchant = req.merchant;
  const merchantId = merchant.id;
  const { amount, customerName, customerEmail, note } = req.body;

  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0 || numAmount > 9999999999.99) {
    return res.status(400).json({ error: 'A valid payment amount up to ₹9,999,999,999.99 is required.' });
  }

  // Micro-offset concurrency slot allocation:
  const pending = await findPendingOrders(merchantId, new Date(Date.now() - 30 * 60 * 1000));
  const used = new Set(pending.map(o => (o.amount || 0).toFixed(2)));
  let finalAmount = numAmount;
  let offset = 0;
  while (used.has(finalAmount.toFixed(2)) && offset < 50) {
    offset++;
    finalAmount = parseFloat((numAmount + offset * 0.01).toFixed(2));
  }

  // Pre-generate dynamic QR data with isolated exact amount and order ID
  const orderId = `PAY-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
  const { upiUri, qrDataUrl } = await qrHelper.generateDynamicQrDataUrl({
    upiId: merchant.upiId,
    payeeName: merchant.payeeName || merchant.businessName,
    amount: finalAmount,
    note: note || orderId.replace(/[^a-zA-Z0-9]/g, ''),
    orderId
  });

  const order = store.createOrder({
    orderId,
    merchantId,
    amount: finalAmount,
    customerName,
    customerEmail,
    note: note || `Payment #${orderId}`,
    dynamicUpiUrl: upiUri,
    dynamicQrDataUrl: qrDataUrl
  });
  await upsertRecord('orders', order);

  res.json({
    success: true,
    order,
    paywallUrl: `/pay/${order.orderId}`
  });
});

// Regenerate API Key
app.post('/api/merchant/regenerate-api-key', requireAuth, requireApprovedMerchant, async (req, res) => {
  const merchantId = req.merchant.id;
  const newKey = `aura_live_${crypto.randomBytes(16).toString('hex')}`;
  const { data, error } = await getClient()
    .from('merchants')
    .update({ api_key: newKey })
    .eq('id', merchantId)
    .select('*')
    .single();
  if (error) throw error;
  store.putMerchant(merchantFromRow(data));
  const { error: auditError } = await getClient().from('audit_logs').insert({
    actor_user_id: req.authUser.id,
    action: 'merchant.api_key_regenerated',
    target_type: 'merchant',
    target_id: merchantId
  });
  if (auditError) throw auditError;
  res.json({ success: true, apiKey: newKey });
});

// SSE Stream for Merchant Dashboard
app.get('/api/merchant/events', requireAuth, requireApprovedMerchant, (req, res) => {
  const merchant = req.merchant;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const watcher = watcherManager.getOrCreate(merchant);
  if (watcher) {
    watcher.subscribeMerchant(res);
  }
});

app.get('/api/admin/overview', requireAuth, requirePermission('metrics:read'), async (req, res) => {
  const { data, error } = await getClient().rpc('admin_metrics');
  if (error) throw error;
  res.json({ success: true, metrics: data });
});

app.get('/api/admin/applications', requireAuth, requirePermission('applications:manage'), async (req, res) => {
  const { data, error } = await getClient()
    .from('merchants')
    .select('id,name,email,phone,business_name,payee_name,upi_id,target_app,website_url,review_status,review_note,created_at,updated_at,auth_user_id')
    .not('auth_user_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(250);
  if (error) throw error;
  res.json({ success: true, applications: data });
});

app.get('/api/admin/orders', requireAuth, requirePermission('orders:read'), async (req, res) => {
  const { data, error } = await getClient()
    .from('orders')
    .select('order_id,merchant_id,amount,customer_name,customer_email,note,status,created_at,verified_at,payment_details')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  res.json({ success: true, orders: data });
});

app.post('/api/admin/applications/:merchantId/review', requireAuth, requirePermission('applications:manage'), async (req, res) => {
  const { status, note = '' } = req.body;
  if (!['under_review', 'approved', 'denied'].includes(status)) {
    return res.status(400).json({ error: 'Choose under review, approved, or denied.' });
  }
  const client = getClient();
  const { data: current, error: findError } = await client
    .from('merchants')
    .select('*')
    .eq('id', req.params.merchantId)
    .maybeSingle();
  if (findError) throw findError;
  if (!current) return res.status(404).json({ error: 'Merchant application not found.' });
  if (!current.auth_user_id) {
    return res.status(409).json({ error: 'This legacy merchant record is not linked to an authenticated account.' });
  }

  const apiKey = status === 'approved'
    ? current.api_key || `aura_live_${crypto.randomBytes(24).toString('hex')}`
    : null;
  const updates = {
    review_status: status,
    review_note: String(note).trim().slice(0, 1000),
    reviewed_by: req.authUser.id,
    reviewed_at: new Date().toISOString(),
    api_key: apiKey,
    is_onboarded: status === 'approved',
    updated_at: new Date().toISOString()
  };
  const { data: updated, error } = await client
    .from('merchants')
    .update(updates)
    .eq('id', current.id)
    .select('*')
    .single();
  if (error) throw error;
  const merchant = merchantFromRow(updated);
  store.putMerchant(merchant);
  if (status === 'approved') watcherManager.getOrCreate(merchant);
  else watcherManager.remove(merchant.id);
  const { error: auditError } = await client.from('audit_logs').insert({
    actor_user_id: req.authUser.id,
    action: `merchant.application_${status}`,
    target_type: 'merchant',
    target_id: current.id,
    details: { reviewNote: updates.review_note }
  });
  if (auditError) throw auditError;
  res.json({ success: true, merchant: publicMerchant(merchant) });
});

const ADMIN_PERMISSIONS = [
  'applications:manage',
  'metrics:read',
  'orders:read',
  'users:manage',
  'settings:manage',
  'audit:read'
];

app.get('/api/admin/users', requireAuth, requirePermission('users:manage'), async (req, res) => {
  const { data, error } = await getClient()
    .from('profiles')
    .select('user_id,email,full_name,role,account_status,permissions,created_at')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  res.json({ success: true, users: data });
});

app.post('/api/admin/users/invite', requireAuth, async (req, res) => {
  if (req.profile.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only the super admin can invite administrators.' });
  }
  const email = String(req.body.email || '').trim().toLowerCase();
  const permissions = req.body.permissions || [];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      isSuperAdminEmail(email) ||
      !Array.isArray(permissions) ||
      permissions.some(permission => !ADMIN_PERMISSIONS.includes(permission))) {
    return res.status(400).json({ error: 'Provide a valid email address and permission set.' });
  }
  const { data: invited, error: inviteError } = await getClient().auth.admin.inviteUserByEmail(email);
  if (inviteError) throw inviteError;
  const { data: profile, error } = await getClient()
    .from('profiles')
    .upsert({
      user_id: invited.user.id,
      email,
      full_name: invited.user.user_metadata?.full_name || '',
      role: 'admin',
      account_status: 'active',
      permissions
    })
    .select('user_id,email,full_name,role,account_status,permissions,created_at')
    .single();
  if (error) throw error;
  const { error: auditError } = await getClient().from('audit_logs').insert({
    actor_user_id: req.authUser.id,
    action: 'admin.invited',
    target_type: 'profile',
    target_id: invited.user.id,
    details: { email, permissions }
  });
  if (auditError) throw auditError;
  res.status(201).json({ success: true, user: profile });
});

app.patch('/api/admin/users/:userId', requireAuth, async (req, res) => {
  if (req.profile.role !== 'super_admin') {
    return res.status(403).json({ error: 'Only the super admin can manage administrator accounts.' });
  }
  const { role, accountStatus, permissions } = req.body;
  if (!['merchant', 'admin'].includes(role) ||
      !['active', 'suspended'].includes(accountStatus) ||
      !Array.isArray(permissions) ||
      permissions.some(permission => !ADMIN_PERMISSIONS.includes(permission))) {
    return res.status(400).json({ error: 'Invalid role, account status, or permission set.' });
  }
  const { data: target, error: targetError } = await getClient()
    .from('profiles')
    .select('email,role')
    .eq('user_id', req.params.userId)
    .maybeSingle();
  if (targetError) throw targetError;
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.role === 'super_admin' ||
      isSuperAdminEmail(target.email)) {
    return res.status(403).json({ error: 'The designated super-admin account cannot be modified here.' });
  }
  const { data, error } = await getClient()
    .from('profiles')
    .update({ role, account_status: accountStatus, permissions, updated_at: new Date().toISOString() })
    .eq('user_id', req.params.userId)
    .select('user_id,email,full_name,role,account_status,permissions,created_at')
    .single();
  if (error) throw error;
  const { error: auditError } = await getClient().from('audit_logs').insert({
    actor_user_id: req.authUser.id,
    action: 'user.permissions_updated',
    target_type: 'profile',
    target_id: req.params.userId,
    details: { role, accountStatus, permissions }
  });
  if (auditError) throw auditError;
  res.json({ success: true, user: data });
});

app.get('/api/admin/settings', requireAuth, requirePermission('settings:manage'), async (req, res) => {
  const [flags, maintenance] = await Promise.all([
    getClient().from('feature_flags').select('*').order('flag_key'),
    getClient().from('system_settings').select('*').order('setting_key')
  ]);
  if (flags.error) throw flags.error;
  if (maintenance.error) throw maintenance.error;
  res.json({ success: true, featureFlags: flags.data, systemSettings: maintenance.data });
});

app.put('/api/admin/feature-flags', requireAuth, requirePermission('settings:manage'), async (req, res) => {
  const { flagKey, enabled, userId = null } = req.body;
  if (!/^[a-z][a-z0-9_.-]{1,63}$/.test(String(flagKey || '')) ||
      typeof enabled !== 'boolean' ||
      (userId !== null && (typeof userId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)))) {
    return res.status(400).json({ error: 'Provide a valid feature flag key, enabled value, and optional user ID.' });
  }
  const { data, error } = await getClient()
    .from('feature_flags')
    .upsert({
      flag_key: flagKey,
      enabled,
      user_id: userId,
      updated_by: req.authUser.id,
      updated_at: new Date().toISOString()
    }, { onConflict: 'flag_key,user_id' })
    .select('*')
    .single();
  if (error) throw error;
  const { error: auditError } = await getClient().from('audit_logs').insert({
    actor_user_id: req.authUser.id,
    action: 'feature_flag.updated',
    target_type: 'feature_flag',
    target_id: flagKey,
    details: { enabled, userId }
  });
  if (auditError) throw auditError;
  res.json({ success: true, featureFlag: data });
});

app.put('/api/admin/maintenance', requireAuth, requirePermission('settings:manage'), async (req, res) => {
  const { enabled, message = '' } = req.body;
  if (typeof enabled !== 'boolean' || typeof message !== 'string') {
    return res.status(400).json({ error: 'Provide a maintenance enabled value and message.' });
  }
  const settingValue = { enabled, message: message.trim().slice(0, 500) };
  const { data, error } = await getClient()
    .from('system_settings')
    .upsert({
      setting_key: 'maintenance',
      setting_value: settingValue,
      updated_by: req.authUser.id,
      updated_at: new Date().toISOString()
    }, { onConflict: 'setting_key' })
    .select('*')
    .single();
  if (error) throw error;
  const { error: auditError } = await getClient().from('audit_logs').insert({
    actor_user_id: req.authUser.id,
    action: 'maintenance.updated',
    target_type: 'system_setting',
    target_id: 'maintenance',
    details: settingValue
  });
  if (auditError) throw auditError;
  res.json({ success: true, setting: data });
});

app.delete('/api/admin/maintenance', requireAuth, requirePermission('settings:manage'), async (req, res) => {
  const client = getClient();
  const { error } = await client
    .from('system_settings')
    .delete()
    .eq('setting_key', 'maintenance');
  if (error) throw error;
  const { error: auditError } = await client.from('audit_logs').insert({
    actor_user_id: req.authUser.id,
    action: 'maintenance.removed',
    target_type: 'system_setting',
    target_id: 'maintenance',
    details: { enabled: false }
  });
  if (auditError) throw auditError;
  res.json({
    success: true,
    setting: {
      setting_key: 'maintenance',
      setting_value: { enabled: false, message: '' }
    }
  });
});

app.get('/api/admin/audit-logs', requireAuth, requirePermission('audit:read'), async (req, res) => {
  const { data, error } = await getClient()
    .from('audit_logs')
    .select('id,actor_user_id,action,target_type,target_id,details,created_at')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  res.json({ success: true, logs: data });
});

// ==============================================================
// 4. PUBLIC DEVELOPER API & PAYWALL ENDPOINTS
// ==============================================================

// Create checkout order via API Key
app.post('/api/v1/checkout/create', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || (req.headers.authorization && req.headers.authorization.replace('Bearer ', ''));
  if (!apiKey) {
    return res.status(401).json({ error: 'Missing x-api-key header' });
  }

  const { data: merchantRow, error: merchantError } = await getClient()
    .from('merchants')
    .select('*')
    .eq('api_key', apiKey)
    .maybeSingle();
  if (merchantError) throw merchantError;
  if (!isMerchantApproved(merchantRow)) {
    return res.status(403).json({ error: 'Invalid API Key' });
  }
  const merchant = merchantFromRow(merchantRow);
  if (merchant.authUserId) {
    const flags = await getFeatureFlagsForUser(merchant.authUserId);
    if (flags.public_api === false) {
      return res.status(403).json({ error: 'The public_api feature is disabled for this account.' });
    }
  }
  const { data: maintenance, error: maintenanceError } = await getClient()
    .from('system_settings')
    .select('setting_value')
    .eq('setting_key', 'maintenance')
    .maybeSingle();
  if (maintenanceError) throw maintenanceError;
  if (maintenance?.setting_value?.enabled) {
    return res.status(503).json({
      error: maintenance.setting_value.message || 'The service is temporarily unavailable for maintenance.'
    });
  }

  const { amount, customerName, customerEmail, note } = req.body;
  const numAmount = Number(amount);
  if (!Number.isFinite(numAmount) || numAmount <= 0 || numAmount > 9999999999.99) {
    return res.status(400).json({ error: 'A valid payment amount up to ₹9,999,999,999.99 is required.' });
  }

  // Micro-offset concurrency slot allocation:
  const pending = await findPendingOrders(merchant.id, new Date(Date.now() - 30 * 60 * 1000));
  const used = new Set(pending.map(o => (o.amount || 0).toFixed(2)));
  let finalAmount = numAmount;
  let offset = 0;
  while (used.has(finalAmount.toFixed(2)) && offset < 50) {
    offset++;
    finalAmount = parseFloat((numAmount + offset * 0.01).toFixed(2));
  }

  const orderId = `PAY-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
  const { upiUri, qrDataUrl } = await qrHelper.generateDynamicQrDataUrl({
    upiId: merchant.upiId,
    payeeName: merchant.payeeName || merchant.businessName,
    amount: finalAmount,
    note: note || orderId.replace(/[^a-zA-Z0-9]/g, ''),
    orderId
  });

  const order = store.createOrder({
    orderId,
    merchantId: merchant.id,
    amount: finalAmount,
    customerName,
    customerEmail,
    note: note || `Order #${orderId}`,
    dynamicUpiUrl: upiUri,
    dynamicQrDataUrl: qrDataUrl
  });
  await upsertRecord('orders', order);

  // Ensure watcher is active
  watcherManager.getOrCreate(merchant);

  res.json({
    success: true,
    orderId: order.orderId,
    amount: order.amount,
    currency: 'INR',
    status: order.status,
    checkoutUrl: `${req.protocol}://${req.get('host')}/pay/${order.orderId}`,
    dynamicUpiUrl: upiUri,
    dynamicQrDataUrl: qrDataUrl
  });
});

// Get Public Checkout Details
app.get('/api/v1/checkout/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const approved = getApprovedOrder(orderId);
  if (!approved) return res.status(404).json({ error: 'Order not found' });
  const { order, merchant } = approved;

  // If dynamic QR wasn't pre-generated, generate it now
  if (!order.dynamicQrDataUrl && merchant) {
    const { upiUri, qrDataUrl } = await qrHelper.generateDynamicQrDataUrl({
      upiId: merchant.upiId,
      payeeName: merchant.businessName,
      amount: order.amount,
      note: order.note,
      orderId: order.orderId
    });
    order.dynamicUpiUrl = upiUri;
    order.dynamicQrDataUrl = qrDataUrl;
    store.updateOrder(orderId, { dynamicUpiUrl: upiUri, dynamicQrDataUrl: qrDataUrl });
  }

  res.json({
    success: true,
    order: {
      orderId: order.orderId,
      amount: order.amount,
      customerName: order.customerName,
      note: order.note,
      status: order.status,
      dynamicUpiUrl: order.dynamicUpiUrl,
      dynamicQrDataUrl: order.dynamicQrDataUrl,
      verifiedAt: order.verifiedAt,
      paymentDetails: order.paymentDetails
    },
    merchant: {
      businessName: merchant.businessName,
      upiId: merchant.upiId,
      qrImagePath: merchant.qrImagePath
    }
  });
});

// Check payment verification status for an order
app.get('/api/v1/checkout/status/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const approved = getApprovedOrder(orderId);
  if (!approved) return res.status(404).json({ error: 'Order not found' });
  const { order, merchant } = approved;

  if (order.status === 'PAID') {
    return res.json({
      success: true,
      verified: true,
      order
    });
  }

  // Force quick check via watcher
  const watcher = watcherManager.getOrCreate(merchant);
  if (watcher) {
    await watcher.syncAndProcess(15);
  }

  const refreshed = store.getOrder(orderId);
  return res.json({
    success: true,
    verified: refreshed.status === 'PAID',
    order: refreshed
  });
});

// Dedicated SSE Stream for an order checkout
app.get('/api/v1/checkout/events/:orderId', (req, res) => {
  const { orderId } = req.params;
  const approved = getApprovedOrder(orderId);
  if (!approved) return res.status(404).end();
  const { order, merchant } = approved;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const watcher = watcherManager.getOrCreate(merchant);
  if (watcher) {
    watcher.subscribeOrder(orderId, res);
  }
});

// Manual UTR submission on paywall
app.post('/api/v1/checkout/verify-utr', async (req, res) => {
  const { orderId, utr } = req.body;
  const cleanUtr = String(utr || '').trim();
  if (!orderId || !isValidPaymentReference(cleanUtr)) {
    return res.status(400).json({ error: 'Provide an order ID and valid UTR or reference number.' });
  }

  const approved = getApprovedOrder(orderId);
  if (!approved) return res.status(404).json({ error: 'Order not found' });
  const { order, merchant } = approved;

  const watcher = watcherManager.getOrCreate(merchant);
  if (!watcher) return res.status(500).json({ error: 'Watcher not available' });

  await watcher.syncAndProcess(25);

  const normalizedUtr = cleanUtr.toLowerCase();
  const matched = watcher.recentPayments.find(p => {
    return matchesPaymentReference(p, normalizedUtr) &&
           Math.abs(p.amount - order.amount) < 0.01 &&
           !watcher.isPaymentClaimed(p);
  });

  if (matched) {
    watcher.executeOrderMatch(order, matched, 'MANUAL_UTR_CONFIRMATION');
    const updated = store.getOrder(orderId);
    return res.json({
      success: true,
      verified: true,
      order: updated
    });
  }

  return res.json({
    success: false,
    verified: false,
    message: 'UTR not yet detected in inbox. Please allow a few seconds for the bank email alert.'
  });
});

// ==============================================================
// 5. HOSTED PAYWALL ROUTE
// ==============================================================

app.get(['/pay/:orderId', '/checkout/:orderId', '/test/:orderId', '/test'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'paywall.html'));
});

// Fallback to Main Dashboard / Landing SPA
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(`[HTTP] ${req.method} ${req.path} failed:`, err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'The request could not be completed. Check the server logs.' });
});

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 ArchXpay Platform running at: http://localhost:${PORT}`);
  console.log('🔐 Supabase Auth merchant onboarding and review enabled');
  console.log(`====================================================`);
});

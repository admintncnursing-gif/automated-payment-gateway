const fs = require('fs');
const path = require('path');
const {
  connectSupabase,
  hasSupabaseConfig,
  selectAll,
  upsertRecord
} = require('./supabase');

const DB_PATH = path.join(__dirname, '..', 'data', 'store.json');

class Store {
  constructor() {
    this.data = {
      merchants: {},
      orders: {}
    };
    this.loadLocal();
    this.ready = this.initSupabase();
  }

  loadLocal() {
    try {
      if (fs.existsSync(DB_PATH)) {
        const raw = fs.readFileSync(DB_PATH, 'utf-8');
        this.data = JSON.parse(raw);
        if (!this.data.merchants) this.data.merchants = {};
        if (!this.data.orders) this.data.orders = {};
        let needsSave = Boolean(this.data.merchants.merch_default);
        delete this.data.merchants.merch_default;
        for (const [orderId, order] of Object.entries(this.data.orders)) {
          if (order.merchantId === 'merch_default') {
            delete this.data.orders[orderId];
            needsSave = true;
          }
        }
        for (const merchant of Object.values(this.data.merchants)) {
          if (Object.hasOwn(merchant, 'password') ||
              Object.hasOwn(merchant, 'gmailAppPass') ||
              Object.hasOwn(merchant, 'gmailAppPassEncrypted')) {
            needsSave = true;
          }
          delete merchant.password;
          delete merchant.gmailAppPass;
          delete merchant.gmailAppPassEncrypted;
        }
        if (needsSave) this.saveLocal();
      }
    } catch (e) {
      console.warn('[Store] Could not load local store.json, using defaults:', e.message);
    }
  }

  saveLocal() {
    try {
      const dir = path.dirname(DB_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const safeData = {
        ...this.data,
        merchants: Object.fromEntries(Object.entries(this.data.merchants).map(([id, merchant]) => {
          const { password, gmailAppPass, gmailAppPassEncrypted, ...safeMerchant } = merchant;
          return [id, safeMerchant];
        }))
      };
      fs.writeFileSync(DB_PATH, JSON.stringify(safeData, null, 2), 'utf-8');
    } catch (e) {
      console.error('[Store] Local save failed:', e.message);
    }
  }

  async initSupabase() {
    try {
      const connected = await connectSupabase();
      if (!connected) return;
      const merchants = await selectAll('merchants');
      console.log('[Store] Loading data from Supabase...');
      this.applyRemoteData(merchants, await selectAll('orders'));
    } catch (err) {
      console.error('[Store] Supabase sync error:', err.message);
    }
  }

  applyRemoteData(merchants, orders) {
    this.data.merchants = {};
    this.data.orders = {};
    for (const merchant of merchants) {
      this.data.merchants[merchant.id] = merchant;
    }
    for (const order of orders) {
      this.data.orders[order.orderId] = order;
    }
    this.saveLocal();
    console.log(`[Store] Synced from Supabase: ${merchants.length} merchants, ${orders.length} orders.`);
  }

  persistRecord(table, record, operation) {
    if (!hasSupabaseConfig()) return;
    upsertRecord(table, record).catch(err => {
      console.error(`[Store] Supabase ${operation} failed:`, err.message);
    });
  }

  createMerchant(data) {
    const id = `merch_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 6)}`;
    const merchant = {
      id,
      name: data.name || 'Merchant',
      email: data.email.toLowerCase().trim(),
      businessName: data.businessName || `${data.name}'s Store`,
      upiId: data.upiId || '',
      qrImagePath: data.qrImagePath || '/uploads/default-qr.jpeg',
      gmailUser: data.gmailUser || '',
      gmailAppPass: data.gmailAppPass || '',
      apiKey: null,
      authUserId: data.authUserId,
      phone: data.phone || '',
      payeeName: data.payeeName || '',
      targetApp: data.targetApp || '',
      websiteUrl: data.websiteUrl || '',
      reviewStatus: 'pending',
      isOnboarded: false,
      createdAt: new Date().toISOString()
    };
    this.data.merchants[id] = merchant;
    this.saveLocal();

    this.persistRecord('merchants', merchant, 'merchant insert');

    return merchant;
  }

  putMerchant(merchant) {
    this.data.merchants[merchant.id] = merchant;
    this.saveLocal();
    this.persistRecord('merchants', merchant, 'merchant update');
    return merchant;
  }

  getMerchantById(id) {
    return this.data.merchants[id] || null;
  }

  getMerchantByEmail(email) {
    if (!email) return null;
    const clean = email.toLowerCase().trim();
    return Object.values(this.data.merchants).find(m => m.email === clean) || null;
  }

  getMerchantByApiKey(apiKey) {
    if (!apiKey) return null;
    return Object.values(this.data.merchants).find(m =>
      m.apiKey === apiKey && m.reviewStatus === 'approved' && m.isOnboarded
    ) || null;
  }

  updateMerchant(id, updates) {
    const m = this.data.merchants[id];
    if (!m) return null;
    Object.assign(m, updates);
    this.saveLocal();

    this.persistRecord('merchants', m, 'merchant update');

    return m;
  }

  createOrder(data) {
    const orderId = data.orderId || `PAY-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
    const order = {
      orderId,
      merchantId: data.merchantId,
      amount: parseFloat(data.amount),
      customerName: data.customerName || 'Customer',
      customerEmail: data.customerEmail || '',
      note: data.note || `Payment #${orderId}`,
      status: 'PENDING',
      dynamicUpiUrl: data.dynamicUpiUrl || '',
      dynamicQrDataUrl: data.dynamicQrDataUrl || '',
      createdAt: new Date().toISOString(),
      verifiedAt: null,
      paymentDetails: null
    };
    this.data.orders[orderId] = order;
    this.saveLocal();

    this.persistRecord('orders', order, 'order insert');

    return order;
  }

  getOrder(orderId) {
    return this.data.orders[orderId] || null;
  }

  updateOrder(orderId, updates, persist = true) {
    const order = this.data.orders[orderId];
    if (!order) return null;
    Object.assign(order, updates);
    this.saveLocal();

    if (persist) this.persistRecord('orders', order, 'order update');

    return order;
  }

  getOrdersByMerchant(merchantId) {
    return Object.values(this.data.orders)
      .filter(o => o.merchantId === merchantId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  getPendingOrdersByMerchant(merchantId) {
    const now = Date.now();
    const MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes maximum pending window
    return Object.values(this.data.orders)
      .filter(o => {
        if (o.merchantId !== merchantId || o.status !== 'PENDING') return false;
        const age = now - new Date(o.createdAt).getTime();
        return age <= MAX_AGE_MS;
      })
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); // Newest first
  }
}

module.exports = new Store();

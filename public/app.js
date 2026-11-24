document.addEventListener('DOMContentLoaded', () => {
  const views = ['landing', 'auth', 'onboarding', 'dashboard', 'admin'];
  const el = (id) => document.getElementById(id);
  const state = {
    supabase: null,
    user: null,
    profile: null,
    merchant: null,
    featureFlags: {},
    maintenance: { enabled: false, message: '' },
    refreshTimer: null,
    applicationStep: 1
  };
  const toastContainer = el('toastContainer');
  const adminPermissions = [
    'applications:manage',
    'metrics:read',
    'orders:read',
    'users:manage',
    'settings:manage',
    'audit:read'
  ];

  function showView(name) {
    views.forEach((view) => {
      const section = el(`view${view[0].toUpperCase()}${view.slice(1)}`);
      if (section) section.classList.toggle('active', view === name);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function toast(message) {
    const node = document.createElement('div');
    node.className = 'toast';
    node.textContent = message;
    toastContainer.appendChild(node);
    setTimeout(() => node.remove(), 3500);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  async function api(url, options = {}) {
    const sessionResult = state.supabase
      ? await state.supabase.auth.getSession()
      : { data: { session: null } };
    const headers = new Headers(options.headers || {});
    if (sessionResult.data.session?.access_token) {
      headers.set('Authorization', `Bearer ${sessionResult.data.session.access_token}`);
    }
    if (options.body && !(options.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }
    const response = await fetch(url, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }

  function setMaintenance(maintenance) {
    state.maintenance = maintenance || { enabled: false, message: '' };
    const banner = el('maintenanceBanner');
    banner.textContent = state.maintenance.enabled
      ? state.maintenance.message || 'ArchXpay is temporarily under maintenance.'
      : '';
    banner.classList.toggle('hidden', !state.maintenance.enabled);
  }

  function isAdmin() {
    return ['admin', 'super_admin'].includes(state.profile?.role);
  }

  function hasPermission(permission) {
    return state.profile?.role === 'super_admin' ||
      (state.profile?.role === 'admin' && state.profile.permissions?.includes(permission));
  }

  async function signOut() {
    if (state.refreshTimer) clearInterval(state.refreshTimer);
    state.refreshTimer = null;
    await state.supabase.auth.signOut();
    state.user = null;
    state.profile = null;
    state.merchant = null;
    updateNavigation();
    showView('landing');
  }

  function updateNavigation() {
    const login = el('btnNavLogin');
    const start = el('btnNavRegister');
    login.textContent = state.user ? (isAdmin() ? 'Admin' : 'Account') : 'Sign In';
    start.textContent = state.user ? 'Open Dashboard' : 'Get Started Free';
    el('navWatcherStatus').hidden = true;
  }

  function applyFeatureFlags() {
    document.querySelectorAll('[data-feature]').forEach((node) => {
      node.classList.toggle('hidden', state.featureFlags[node.dataset.feature] === false);
    });
  }

  async function refreshIdentity() {
    const { data: { session } } = await state.supabase.auth.getSession();
    if (!session) {
      state.user = null;
      state.profile = null;
      state.merchant = null;
      updateNavigation();
      return;
    }
    const data = await api('/api/auth/me');
    state.user = data.user;
    state.profile = data.user;
    state.merchant = data.merchant;
    state.featureFlags = data.featureFlags || {};
    updateNavigation();
    applyFeatureFlags();
    if (isAdmin()) {
      showView('admin');
      await loadAdmin();
    } else if (state.merchant?.reviewStatus === 'approved' && state.merchant.isOnboarded) {
      showView('dashboard');
      await loadDashboard();
      if (state.refreshTimer) clearInterval(state.refreshTimer);
      state.refreshTimer = setInterval(() => loadDashboard().catch(() => {}), 10000);
    } else {
      showView('onboarding');
      renderApplication();
    }
  }

  function setApplicationInputs(merchant) {
    el('applicationName').value = state.user?.fullName || '';
    el('applicationPhone').value = merchant?.phone || '';
    el('applicationBusiness').value = merchant?.businessName || '';
    el('applicationPayee').value = merchant?.payeeName || '';
    el('applicationUpi').value = merchant?.upiId || '';
    el('applicationTarget').value = merchant?.targetApp || '';
    el('applicationWebsite').value = merchant?.websiteUrl || '';
    el('applicationGmail').value = merchant?.gmailUser || state.user?.email || '';
    el('applicationGmailPass').value = '';
    updateWebsiteField();
    showApplicationStep(1);
  }

  function showApplicationStep(step) {
    state.applicationStep = Math.max(1, Math.min(6, step));
    document.querySelectorAll('[data-application-step]').forEach((node) => {
      node.classList.toggle('active', Number(node.dataset.applicationStep) === state.applicationStep);
    });
    document.querySelectorAll('[data-wizard-step]').forEach((node) => {
      const stepNumber = Number(node.dataset.wizardStep);
      node.classList.toggle('active', stepNumber === state.applicationStep);
      node.classList.toggle('complete', stepNumber < state.applicationStep);
    });
    el('btnApplicationBack').hidden = state.applicationStep === 1;
    el('btnApplicationNext').hidden = state.applicationStep === 6;
    el('btnTestApplicationGmail').hidden = state.applicationStep !== 6;
    el('btnSubmitApplication').hidden = state.applicationStep !== 6;
  }

  function validateApplicationStep() {
    const step = state.applicationStep;
    let field;
    if (step === 1) field = el('applicationName');
    if (step === 2) field = el('applicationPhone');
    if (step === 3) {
      field = el('applicationBusiness').value.trim() ? el('applicationPayee') : el('applicationBusiness');
    }
    if (step === 4) field = el('applicationUpi');
    if (step === 5) field = el('applicationTarget');
    if (step === 6) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(el('applicationGmail').value.trim())) {
        toast('Enter a valid Gmail address.');
        el('applicationGmail').focus();
        return false;
      }
      field = el('applicationGmailPass');
    }
    if (field && !field.value.trim()) {
      field.reportValidity();
      field.focus();
      return false;
    }
    if (step === 2 && !/^\+?[1-9]\d{6,14}$/.test(el('applicationPhone').value.replace(/[\s()-]/g, ''))) {
      toast('Enter a valid mobile number including country code.');
      el('applicationPhone').focus();
      return false;
    }
    if (step === 3 && !el('applicationPayee').value.trim()) {
      el('applicationPayee').focus();
      return false;
    }
    if (step === 4 && !/^[^@\s]+@[^@\s]+$/.test(el('applicationUpi').value.trim())) {
      toast('Enter a valid UPI ID, for example yourupi@fam.');
      el('applicationUpi').focus();
      return false;
    }
    if (step === 5) {
      updateWebsiteField();
      if (el('applicationWebsite').required && !el('applicationWebsite').value.trim()) {
        el('applicationWebsite').focus();
        return false;
      }
    }
    if (step === 6 && !/^[a-zA-Z0-9]{16}$/.test(el('applicationGmailPass').value.replace(/\s+/g, ''))) {
      toast('Enter the 16-character Gmail App Password.');
      el('applicationGmailPass').focus();
      return false;
    }
    return true;
  }

  function updateWebsiteField() {
    const target = el('applicationTarget').value;
    const group = el('websiteUrlGroup');
    const field = el('applicationWebsite');
    const needsWebsite = /website|web/i.test(target);
    group.hidden = !needsWebsite;
    field.required = needsWebsite;
  }

  function renderApplication() {
    const form = el('formMerchantApplication');
    const statusBox = el('applicationStatus');
    const status = state.merchant?.reviewStatus;
    const labels = {
      pending: ['Application received', 'Your application is waiting for administrator review. Payment APIs remain disabled until approval.'],
      under_review: ['Application under review', 'An administrator is reviewing your merchant details. Access remains disabled during review.'],
      denied: ['Application needs updates', state.merchant?.reviewNote || 'Your application was not approved. Update your information and submit again.']
    };
    if (status === 'pending' || status === 'under_review') {
      const [title, description] = labels[status];
      statusBox.innerHTML = `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p><p class="panel-sub">Signed in as ${escapeHtml(state.user.email)}</p>`;
      statusBox.classList.remove('hidden');
      form.classList.add('hidden');
    } else {
      statusBox.classList.add('hidden');
      form.classList.remove('hidden');
      setApplicationInputs(state.merchant);
      if (status === 'denied') {
        el('applicationFeedback').textContent = labels.denied[1];
      }
    }
  }

  async function submitApplication(event) {
    event.preventDefault();
    const button = el('btnSubmitApplication');
    button.disabled = true;
    try {
      const result = await api('/api/merchant/complete-onboarding', {
        method: 'POST',
        body: JSON.stringify({
          fullName: el('applicationName').value.trim(),
          phone: el('applicationPhone').value.trim(),
          businessName: el('applicationBusiness').value.trim(),
          payeeName: el('applicationPayee').value.trim(),
          upiId: el('applicationUpi').value.trim(),
          targetApp: el('applicationTarget').value,
          websiteUrl: el('applicationWebsite').value.trim(),
          gmailUser: el('applicationGmail').value.trim(),
          gmailAppPass: el('applicationGmailPass').value
        })
      });
      state.merchant = result.merchant;
      el('applicationFeedback').textContent = '';
      toast('Application submitted for administrator review.');
      renderApplication();
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function testGmail() {
    const feedback = el('applicationFeedback');
    const button = el('btnTestApplicationGmail');
    button.disabled = true;
    feedback.textContent = 'Testing secure IMAP connection...';
    try {
      const result = await api('/api/merchant/test-email', {
        method: 'POST',
        body: JSON.stringify({
          gmailUser: el('applicationGmail').value.trim(),
          gmailAppPass: el('applicationGmailPass').value
        })
      });
      feedback.textContent = `Gmail connection confirmed (${result.inboxCount} messages in the inbox).`;
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  async function loadDashboard() {
    if (!state.merchant) return;
    const data = await api('/api/merchant/dashboard');
    el('dashBusinessTitle').textContent = data.merchant.businessName;
    el('dashApiKeyDisplay').textContent = data.merchant.apiKey || 'No API key';
    el('metricVolume').textContent = `₹${Number(data.metrics.totalVolume).toFixed(2)}`;
    el('metricPaidCount').textContent = data.metrics.paidCount;
    el('metricQueueLoad').textContent = `${data.metrics.pendingCount} pending payments`;
    renderOrders(data.recentOrders);
    renderCodeSnippet('curl');
  }

  function renderOrders(orders = []) {
    const body = el('ordersTableBody');
    if (!orders.length) {
      body.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:24px;color:#94A3B8;">No transactions yet.</td></tr>';
      return;
    }
    body.innerHTML = orders.map((order) => {
      const paid = order.status === 'PAID';
      const utr = order.paymentDetails?.utr || order.paymentDetails?.txnId || '-';
      return `<tr>
        <td class="font-mono"><strong>${escapeHtml(order.orderId)}</strong></td>
        <td>${escapeHtml(order.customerName || 'Customer')}</td>
        <td><strong>₹${Number(order.amount).toFixed(2)}</strong></td>
        <td class="font-mono">${escapeHtml(utr)}</td>
        <td>${new Date(order.createdAt).toLocaleString()}</td>
        <td>${paid ? '<span class="badge-paid">Verified</span>' : '<span class="badge-pending">Waiting</span>'}</td>
      </tr>`;
    }).join('');
  }

  function renderCodeSnippet(language) {
    const key = state.merchant?.apiKey || 'YOUR_API_KEY';
    const origin = window.location.origin;
    const snippets = {
      curl: `curl -X POST ${origin}/api/v1/checkout/create \\\n  -H "x-api-key: ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"amount":500,"customerName":"Customer","note":"Order 123"}'`,
      node: `const response = await fetch('${origin}/api/v1/checkout/create', {\n  method: 'POST',\n  headers: { 'x-api-key': process.env.AURAPAY_API_KEY, 'Content-Type': 'application/json' },\n  body: JSON.stringify({ amount: 500, customerName: 'Customer', note: 'Order 123' })\n});\nconst checkout = await response.json();\nconsole.log(checkout.checkoutUrl);`,
      python: `import requests\n\ncheckout = requests.post(\n    '${origin}/api/v1/checkout/create',\n    headers={'x-api-key': 'YOUR_API_KEY'},\n    json={'amount': 500, 'customerName': 'Customer', 'note': 'Order 123'},\n).json()\nprint(checkout['checkoutUrl'])`
    };
    el('codeSnippetBox').textContent = snippets[language] || snippets.curl;
  }

  async function createPaywallLink(event) {
    event.preventDefault();
    try {
      const result = await api('/api/merchant/create-paywall-link', {
        method: 'POST',
        body: JSON.stringify({
          amount: el('pwAmount').value,
          customerName: el('pwCustomerName').value,
          note: el('pwNote').value
        })
      });
      const url = new URL(result.paywallUrl, window.location.origin).href;
      el('generatedPaywallUrl').value = url;
      el('btnOpenGeneratedUrl').href = url;
      el('paywallLinkResult').classList.remove('hidden');
      toast('Payment link generated.');
      await loadDashboard();
    } catch (error) {
      toast(error.message);
    }
  }

  async function regenerateApiKey() {
    if (!window.confirm('Regenerate this API key? Existing integrations will stop working.')) return;
    try {
      const result = await api('/api/merchant/regenerate-api-key', { method: 'POST' });
      state.merchant.apiKey = result.apiKey;
      el('dashApiKeyDisplay').textContent = result.apiKey;
      await loadDashboard();
      toast('API key regenerated.');
    } catch (error) {
      toast(error.message);
    }
  }

  function renderMetrics(metrics = {}) {
    const entries = [
      ['Merchant applications', metrics.merchants],
      ['Pending review', metrics.pendingApplications],
      ['Approved merchants', metrics.approvedMerchants],
      ['Paid orders', metrics.paidOrders],
      ['Processed volume', `₹${Number(metrics.paidVolume || 0).toFixed(2)}`],
      ['Active users', metrics.activeUsers]
    ];
    el('adminMetrics').innerHTML = entries.map(([label, value]) =>
      `<div class="metric-card"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-val">${escapeHtml(value ?? 0)}</div></div>`
    ).join('');
  }

  async function loadApplications() {
    if (!hasPermission('applications:manage')) {
      el('adminApplications').innerHTML = '<p class="panel-sub">You do not have application-review permission.</p>';
      return;
    }
    const { applications } = await api('/api/admin/applications');
    const items = applications.filter((item) => item.review_status !== 'approved');
    el('adminApplications').innerHTML = items.length ? items.map((item) => `
      <article class="admin-record">
        <h4>${escapeHtml(item.business_name)} <span class="badge-pending">${escapeHtml(item.review_status)}</span></h4>
        <p>${escapeHtml(item.name)} · ${escapeHtml(item.email)} · ${escapeHtml(item.phone)}</p>
        <p>Payee: ${escapeHtml(item.payee_name)} · UPI: ${escapeHtml(item.upi_id)}</p>
        <p>Use: ${escapeHtml(item.target_app)} ${item.website_url ? `· ${escapeHtml(item.website_url)}` : ''}</p>
        <textarea class="form-control review-note" data-id="${escapeHtml(item.id)}" placeholder="Review note">${escapeHtml(item.review_note)}</textarea>
        <div class="application-actions">
          <button type="button" class="btn-dash-secondary" data-review="under_review" data-id="${escapeHtml(item.id)}">Under review</button>
          <button type="button" class="btn-dash-primary" data-review="approved" data-id="${escapeHtml(item.id)}">Approve</button>
          <button type="button" class="btn-dash-secondary" data-review="denied" data-id="${escapeHtml(item.id)}">Deny</button>
        </div>
      </article>`).join('') : '<p class="panel-sub">No applications need review.</p>';
  }

  async function loadUsers() {
    el('adminUsersPanel').hidden = !hasPermission('users:manage');
    if (!hasPermission('users:manage')) {
      el('adminUsers').innerHTML = '<p class="panel-sub">You do not have user-management permission.</p>';
      return;
    }
    el('formInviteAdmin').hidden = state.profile.role !== 'super_admin';
    const { users } = await api('/api/admin/users');
    el('adminUsers').innerHTML = users.map((user) => {
      const inputs = state.profile.role === 'super_admin'
        ? `<label>Role <select class="form-control user-role" data-id="${escapeHtml(user.user_id)}">
            <option value="merchant" ${user.role === 'merchant' ? 'selected' : ''}>Merchant</option>
            <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
          </select></label>
          <label>Status <select class="form-control user-status" data-id="${escapeHtml(user.user_id)}">
            <option value="active" ${user.account_status === 'active' ? 'selected' : ''}>Active</option>
            <option value="suspended" ${user.account_status === 'suspended' ? 'selected' : ''}>Suspended</option>
          </select></label>
          <div class="permission-list">${adminPermissions.map((permission) =>
            `<label><input type="checkbox" class="user-permission" data-id="${escapeHtml(user.user_id)}" value="${permission}" ${user.permissions?.includes(permission) ? 'checked' : ''}>${permission}</label>`
          ).join('')}</div>
          <button class="btn-dash-secondary" type="button" data-save-user="${escapeHtml(user.user_id)}">Save access</button>`
        : '';
      return `<article class="admin-record"><strong>${escapeHtml(user.full_name || user.email)}</strong><p>${escapeHtml(user.email)} · ${escapeHtml(user.role)} · ${escapeHtml(user.account_status)}</p>${inputs}</article>`;
    }).join('') || '<p class="panel-sub">No registered users.</p>';
  }

  async function loadAdminOrders() {
    if (!hasPermission('orders:read')) {
      el('adminOrdersPanel').hidden = true;
      return;
    }
    el('adminOrdersPanel').hidden = false;
    const { orders } = await api('/api/admin/orders');
    el('adminOrders').innerHTML = orders.map((order) => `
      <article class="admin-record">
        <strong>${escapeHtml(order.order_id)} · ₹${Number(order.amount).toFixed(2)}</strong>
        <p>${escapeHtml(order.status)} · ${escapeHtml(order.customer_name || 'Customer')} · ${new Date(order.created_at).toLocaleString()}</p>
        <p>Merchant: ${escapeHtml(order.merchant_id)} · ${escapeHtml(order.note)}</p>
      </article>`).join('') || '<p class="panel-sub">No orders recorded.</p>';
  }

  async function loadSettings() {
    el('adminSettingsPanel').hidden = !hasPermission('settings:manage');
    el('adminMaintenancePanel').hidden = !hasPermission('settings:manage');
    if (!hasPermission('settings:manage')) {
      return;
    }
    const { featureFlags, systemSettings } = await api('/api/admin/settings');
    const maintenance = systemSettings.find((item) => item.setting_key === 'maintenance')?.setting_value || {};
    el('maintenanceEnabled').checked = Boolean(maintenance.enabled);
    el('maintenanceMessage').value = maintenance.message || '';
    el('adminFlags').innerHTML = featureFlags.map((flag) => `
      <div class="admin-record"><strong>${escapeHtml(flag.flag_key)}</strong>
        <label><input type="checkbox" data-flag="${escapeHtml(flag.flag_key)}" data-user="${escapeHtml(flag.user_id || '')}" ${flag.enabled ? 'checked' : ''}>
        ${flag.enabled ? 'Enabled' : 'Disabled'} ${flag.user_id ? `for ${escapeHtml(flag.user_id)}` : 'system-wide'}</label>
      </div>`).join('') || '<p class="panel-sub">No feature flags configured.</p>';
    setMaintenance(maintenance);
  }

  async function loadAudit() {
    el('adminAuditPanel').hidden = !hasPermission('audit:read');
    if (!hasPermission('audit:read')) {
      el('adminAudit').innerHTML = '<p class="panel-sub">You do not have audit-log permission.</p>';
      return;
    }
    const { logs } = await api('/api/admin/audit-logs');
    el('adminAudit').innerHTML = logs.map((log) =>
      `<article class="admin-record"><strong>${escapeHtml(log.action)}</strong><p>${escapeHtml(log.target_type)} ${escapeHtml(log.target_id)} · ${new Date(log.created_at).toLocaleString()}</p></article>`
    ).join('') || '<p class="panel-sub">No audit events.</p>';
  }

  async function loadAdmin() {
    el('adminRoleLabel').textContent = state.profile.role === 'super_admin'
      ? 'Super admin · system-wide access'
      : 'Administrator · permission-scoped access';
    const tasks = [];
    if (hasPermission('metrics:read')) {
      tasks.push(api('/api/admin/overview').then((data) => renderMetrics(data.metrics)));
    }
    tasks.push(loadApplications(), loadAdminOrders(), loadUsers(), loadSettings(), loadAudit());
    const results = await Promise.allSettled(tasks);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) toast(failed.reason.message);
  }

  async function reviewApplication(event) {
    const button = event.target.closest('[data-review]');
    if (!button) return;
    button.disabled = true;
    try {
      const id = button.dataset.id;
      const note = document.querySelector(`.review-note[data-id="${CSS.escape(id)}"]`).value;
      const result = await api(`/api/admin/applications/${encodeURIComponent(id)}/review`, {
        method: 'POST',
        body: JSON.stringify({ status: button.dataset.review, note })
      });
      toast(`Application ${button.dataset.review.replace('_', ' ')}.`);
      await Promise.all([loadApplications(), loadAdmin()]);
    } catch (error) {
      toast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function saveUser(userId) {
    const role = document.querySelector(`.user-role[data-id="${CSS.escape(userId)}"]`).value;
    const accountStatus = document.querySelector(`.user-status[data-id="${CSS.escape(userId)}"]`).value;
    const permissions = [...document.querySelectorAll(`.user-permission[data-id="${CSS.escape(userId)}"]:checked`)]
      .map((input) => input.value);
    await api(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ role, accountStatus, permissions })
    });
    toast('User access updated.');
    await loadUsers();
  }

  async function start() {
    document.querySelector('.onboarding-progress-bar')?.classList.add('hidden');
    document.querySelector('.carousel-deck')?.classList.add('hidden');
    document.querySelector('.auth-tabs')?.classList.add('hidden');
    el('formSignIn')?.classList.add('hidden');
    el('formSignUp')?.classList.add('hidden');
    document.querySelector('#btnSimulateConcurrent')?.closest('.sub-panel')?.remove();
    el('btnGoogleAuth').addEventListener('click', async () => {
      const { error } = await state.supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin }
      });
      if (error) toast(error.message);
    });
    const config = await api('/api/config');
    setMaintenance(config.maintenance);
    if (!window.supabase?.createClient) throw new Error('Supabase browser client failed to load.');
    state.supabase = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);

    el('brandLogo').addEventListener('click', () => showView('landing'));
    el('btnNavLogin').addEventListener('click', () => {
      if (state.user) refreshIdentity().catch((error) => toast(error.message));
      else showView('auth');
    });
    el('btnNavRegister').addEventListener('click', () => {
      if (state.user) refreshIdentity().catch((error) => toast(error.message));
      else showView('auth');
    });
    el('btnHeroGetStarted').addEventListener('click', () => showView(state.user ? 'onboarding' : 'auth'));
    el('btnHeroDemoCheckout').addEventListener('click', async () => {
      if (!state.user || !state.merchant || state.merchant.reviewStatus !== 'approved') {
        showView(state.user ? 'onboarding' : 'auth');
        return;
      }
      try {
        const result = await api('/api/merchant/create-paywall-link', {
          method: 'POST',
          body: JSON.stringify({ amount: 5, customerName: 'Demo Customer', note: 'Test checkout' })
        });
        window.open(result.paywallUrl, '_blank', 'noopener');
      } catch (error) {
        toast(error.message);
      }
    });
    el('formMerchantApplication').addEventListener('submit', submitApplication);
    el('applicationTarget').addEventListener('change', updateWebsiteField);
    el('btnApplicationNext').addEventListener('click', () => {
      if (validateApplicationStep()) showApplicationStep(state.applicationStep + 1);
    });
    el('btnApplicationBack').addEventListener('click', () => showApplicationStep(state.applicationStep - 1));
    el('btnTestApplicationGmail').addEventListener('click', testGmail);
    el('btnApplicationLogout').addEventListener('click', () => signOut().catch((error) => toast(error.message)));
    el('btnDashLogout').addEventListener('click', () => signOut().catch((error) => toast(error.message)));
    el('btnAdminLogout').addEventListener('click', () => signOut().catch((error) => toast(error.message)));
    el('btnRefreshOrders').addEventListener('click', () => loadDashboard().catch((error) => toast(error.message)));
    el('btnRegenerateDashKey').addEventListener('click', regenerateApiKey);
    el('btnCopyDashKey').addEventListener('click', () =>
      navigator.clipboard.writeText(el('dashApiKeyDisplay').textContent).then(() => toast('API key copied.')));
    el('btnViewApiDocs').addEventListener('click', () => el('modalApiDocs').classList.remove('hidden'));
    el('btnCloseApiDocs').addEventListener('click', () => el('modalApiDocs').classList.add('hidden'));
    el('btnDoneApiDocs').addEventListener('click', () => el('modalApiDocs').classList.add('hidden'));
    document.querySelectorAll('.code-tab').forEach((tab) => tab.addEventListener('click', () => {
      document.querySelectorAll('.code-tab').forEach((item) => item.classList.toggle('active', item === tab));
      renderCodeSnippet(tab.dataset.lang);
    }));
    el('btnOpenCreatePaywallModal').addEventListener('click', () => el('modalCreatePaywall').classList.remove('hidden'));
    el('btnClosePaywallModal').addEventListener('click', () => el('modalCreatePaywall').classList.add('hidden'));
    el('btnCancelPaywallModal').addEventListener('click', () => el('modalCreatePaywall').classList.add('hidden'));
    el('formCreatePaywall').addEventListener('submit', createPaywallLink);
    el('btnCopyGeneratedUrl').addEventListener('click', () =>
      navigator.clipboard.writeText(el('generatedPaywallUrl').value).then(() => toast('Payment link copied.')));
    el('btnRefreshApplications').addEventListener('click', () => loadAdmin().catch((error) => toast(error.message)));
    el('adminApplications').addEventListener('click', reviewApplication);
    el('adminUsers').addEventListener('click', (event) => {
      const button = event.target.closest('[data-save-user]');
      if (button) saveUser(button.dataset.saveUser).catch((error) => toast(error.message));
    });
    el('formInviteAdmin').addEventListener('submit', async (event) => {
      event.preventDefault();
      const permissions = [...document.querySelectorAll('.invite-permission:checked')]
        .map((input) => input.value);
      try {
        await api('/api/admin/users/invite', {
          method: 'POST',
          body: JSON.stringify({ email: el('inviteAdminEmail').value.trim(), permissions })
        });
        el('inviteAdminEmail').value = '';
        toast('Admin invitation sent.');
        await loadUsers();
      } catch (error) {
        toast(error.message);
      }
    });
    el('formFeatureFlag').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api('/api/admin/feature-flags', {
          method: 'PUT',
          body: JSON.stringify({
            flagKey: el('featureFlagKey').value.trim(),
            enabled: el('featureFlagEnabled').checked,
            userId: el('featureFlagUser').value.trim() || null
          })
        });
        el('featureFlagKey').value = '';
        el('featureFlagUser').value = '';
        await loadSettings();
        toast('Feature flag saved.');
      } catch (error) {
        toast(error.message);
      }
    });
    el('adminFlags').addEventListener('change', async (event) => {
      const input = event.target.closest('[data-flag]');
      if (!input) return;
      try {
        await api('/api/admin/feature-flags', {
          method: 'PUT',
          body: JSON.stringify({
            flagKey: input.dataset.flag,
            enabled: input.checked,
            userId: input.dataset.user || null
          })
        });
        toast('Feature flag updated.');
      } catch (error) {
        input.checked = !input.checked;
        toast(error.message);
      }
    });
    el('formMaintenance').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const result = await api('/api/admin/maintenance', {
          method: 'PUT',
          body: JSON.stringify({
            enabled: el('maintenanceEnabled').checked,
            message: el('maintenanceMessage').value
          })
        });
        setMaintenance(result.setting.setting_value);
        toast('Maintenance mode updated.');
      } catch (error) {
        toast(error.message);
      }
    });
    state.supabase.auth.onAuthStateChange((event) => {
      if (['SIGNED_IN', 'TOKEN_REFRESHED', 'INITIAL_SESSION'].includes(event)) {
        refreshIdentity().catch((error) => toast(error.message));
      } else if (event === 'SIGNED_OUT') {
        state.user = null;
        state.profile = null;
        state.merchant = null;
        updateNavigation();
      }
    });
    updateNavigation();
    await refreshIdentity();
  }

  start().catch((error) => {
    console.error('ArchXpay could not start:', error);
    toast(error.message);
  });
});

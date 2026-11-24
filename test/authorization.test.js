const test = require('node:test');
const assert = require('node:assert/strict');
const { hasPermission, isMerchantApproved, isSuperAdminEmail } = require('../services/authorization');

test('merchant API access requires approval and completed onboarding', () => {
  assert.equal(isMerchantApproved({ review_status: 'pending', is_onboarded: true }), false);
  assert.equal(isMerchantApproved({ reviewStatus: 'approved', isOnboarded: false }), false);
  assert.equal(isMerchantApproved({ reviewStatus: 'approved', isOnboarded: true }), true);
});

test('admin permissions are scoped while super admins have all permissions', () => {
  assert.equal(hasPermission({ role: 'merchant', permissions: ['metrics:read'] }, 'metrics:read'), false);
  assert.equal(hasPermission({ role: 'admin', permissions: ['metrics:read'] }, 'metrics:read'), true);
  assert.equal(hasPermission({ role: 'admin', permissions: ['metrics:read'] }, 'users:manage'), false);
  assert.equal(hasPermission({ role: 'super_admin', permissions: [] }, 'users:manage'), true);
});

test('super-admin identity matching is case-insensitive', () => {
  assert.equal(isSuperAdminEmail('ShashankSv2009@gmail.com'), true);
  assert.equal(isSuperAdminEmail('other@example.com'), false);
});

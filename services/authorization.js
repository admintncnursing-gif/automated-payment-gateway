function isMerchantApproved(merchant) {
  return Boolean(
    merchant &&
    (merchant.reviewStatus || merchant.review_status) === 'approved' &&
    (merchant.isOnboarded ?? merchant.is_onboarded) === true
  );
}

function hasPermission(profile, permission) {
  if (profile?.role === 'super_admin') return true;
  return profile?.role === 'admin' &&
    Array.isArray(profile.permissions) &&
    profile.permissions.includes(permission);
}

function isSuperAdminEmail(email) {
  return String(email || '').trim().toLowerCase() === 'shashanksv2009@gmail.com';
}

module.exports = { hasPermission, isMerchantApproved, isSuperAdminEmail };

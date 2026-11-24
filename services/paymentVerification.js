function isValidPaymentReference(reference) {
  return /^[a-z0-9]{6,30}$/i.test(String(reference || '').trim());
}

function matchesPaymentReference(payment, reference) {
  const normalizedReference = String(reference || '').trim().toLowerCase();
  if (!isValidPaymentReference(normalizedReference)) return false;
  return [payment?.utr, payment?.txnId].some(value =>
    typeof value === 'string' && value.trim().toLowerCase() === normalizedReference
  );
}

module.exports = { isValidPaymentReference, matchesPaymentReference };

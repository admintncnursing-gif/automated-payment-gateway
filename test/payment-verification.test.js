const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidPaymentReference, matchesPaymentReference } = require('../services/paymentVerification');

test('payment reference must match a full parsed UTR or transaction ID', () => {
  const payment = { utr: 'AB1234567890', txnId: 'FMPIB12345678', snippet: 'Ref AB1234567890' };
  assert.equal(matchesPaymentReference(payment, 'ab1234567890'), true);
  assert.equal(matchesPaymentReference(payment, 'AB123'), false);
  assert.equal(matchesPaymentReference(payment, ''), false);
  assert.equal(matchesPaymentReference(payment, 'ref AB1234567890'), false);
});

test('payment references reject empty and malformed values', () => {
  assert.equal(isValidPaymentReference(''), false);
  assert.equal(isValidPaymentReference('123'), false);
  assert.equal(isValidPaymentReference('AB123456'), true);
});

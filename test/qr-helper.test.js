const test = require('node:test');
const assert = require('node:assert/strict');
const { buildUpiUri } = require('../services/qrHelper');

test('UPI payment URI uses the merchant VPA and exact positive amount', () => {
  const uri = buildUpiUri({
    upiId: 'merchant@upi',
    payeeName: 'Example Shop',
    amount: 125.5,
    orderId: 'PAY-123456-789'
  });
  assert.match(uri, /pa=merchant@upi/);
  assert.match(uri, /am=125\.50/);
  assert.doesNotMatch(uri, /8789601387/);
});

test('UPI payment URI rejects missing VPA and invalid amounts', () => {
  assert.throws(() => buildUpiUri({ amount: 10 }), /valid merchant UPI ID/);
  assert.throws(() => buildUpiUri({ upiId: 'merchant@upi', amount: 0 }), /valid payment amount/);
});

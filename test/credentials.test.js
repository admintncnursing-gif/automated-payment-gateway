const test = require('node:test');
const assert = require('node:assert/strict');
const { decryptCredential, encryptCredential } = require('../services/credentials');

test('Gmail credentials are encrypted and round-trip with the server key', () => {
  const originalKey = process.env.GMAIL_CREDENTIALS_ENCRYPTION_KEY;
  process.env.GMAIL_CREDENTIALS_ENCRYPTION_KEY = 'ab'.repeat(32);
  try {
    const encrypted = encryptCredential('abcd efgh ijkl mnop');
    assert.notEqual(encrypted, 'abcd efgh ijkl mnop');
    assert.match(encrypted, /^enc:v1:/);
    assert.equal(decryptCredential(encrypted), 'abcd efgh ijkl mnop');
  } finally {
    if (originalKey === undefined) delete process.env.GMAIL_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.GMAIL_CREDENTIALS_ENCRYPTION_KEY = originalKey;
  }
});

test('Gmail credential encryption rejects a missing or malformed server key', () => {
  const originalKey = process.env.GMAIL_CREDENTIALS_ENCRYPTION_KEY;
  const originalServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    delete process.env.GMAIL_CREDENTIALS_ENCRYPTION_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    assert.throws(() => encryptCredential('secret'), /SUPABASE_SERVICE_ROLE_KEY/);
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-secret';
    assert.doesNotThrow(() => encryptCredential('secret'));
    process.env.GMAIL_CREDENTIALS_ENCRYPTION_KEY = 'not-a-valid-key';
    assert.throws(() => encryptCredential('secret'), /64 hexadecimal characters/);
  } finally {
    if (originalKey === undefined) delete process.env.GMAIL_CREDENTIALS_ENCRYPTION_KEY;
    else process.env.GMAIL_CREDENTIALS_ENCRYPTION_KEY = originalKey;
    if (originalServiceKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalServiceKey;
  }
});

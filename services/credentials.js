const crypto = require('crypto');

const PREFIX = 'enc:v1:';

function getEncryptionKey() {
  const configured = process.env.GMAIL_CREDENTIALS_ENCRYPTION_KEY || '';
  if (configured) {
    if (!/^[a-f0-9]{64}$/i.test(configured)) {
      throw new Error('GMAIL_CREDENTIALS_ENCRYPTION_KEY must be 64 hexadecimal characters.');
    }
    return Buffer.from(configured, 'hex');
  }
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!serviceKey) {
    throw new Error('Set SUPABASE_SERVICE_ROLE_KEY before storing encrypted Gmail App Passwords.');
  }
  return crypto.createHash('sha256').update(`archxpay:gmail:${serviceKey}`).digest();
}

function encryptCredential(value) {
  if (!value) return '';
  if (value.startsWith(PREFIX)) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptCredential(value) {
  if (!value || !value.startsWith(PREFIX)) return '';
  const [ivHex, tagHex, encryptedHex] = value.slice(PREFIX.length).split(':');
  if (!ivHex || !tagHex || !encryptedHex) {
    throw new Error('Stored Gmail credential has an invalid encrypted format.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, 'hex')),
    decipher.final()
  ]).toString('utf8');
}

module.exports = { decryptCredential, encryptCredential };

const { createClient } = require('@supabase/supabase-js');
const { decryptCredential, encryptCredential } = require('./credentials');

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const client = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  })
  : null;

function toDatabaseRow(record) {
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`),
      value
    ])
  );
}

function fromDatabaseRow(record) {
  const mapped = Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()),
      value
    ])
  );
  if (mapped.gmailAppPassEncrypted) {
    mapped.gmailAppPass = decryptCredential(mapped.gmailAppPassEncrypted);
    delete mapped.gmailAppPassEncrypted;
  }
  return mapped;
}

function toDatabaseRecord(table, record) {
  const values = { ...record };
  if (table === 'merchants') {
    delete values.password;
    if (Object.hasOwn(values, 'gmailAppPass')) {
      values.gmailAppPassEncrypted = encryptCredential(values.gmailAppPass);
      delete values.gmailAppPass;
    }
  }
  return toDatabaseRow(values);
}

async function connectSupabase() {
  if (!client) {
    console.warn('[Supabase] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required; using the local store.');
    return false;
  }

  const { error } = await client.from('merchants').select('id').limit(1);
  if (error) {
    console.error('[Supabase] Connection check failed:', error.message);
    return false;
  }

  console.log('[Supabase] Connected successfully.');
  return true;
}

function requireClient() {
  if (!client) {
    throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }
  return client;
}

async function selectAll(table) {
  const { data, error } = await requireClient().from(table).select('*');
  if (error) throw error;
  return data.map(fromDatabaseRow);
}

async function upsertRecord(table, record, conflictColumn) {
  const primaryKey = conflictColumn || (table === 'merchants' ? 'id' : 'orderId');
  const { error } = await requireClient()
    .from(table)
    .upsert(toDatabaseRecord(table, record), {
      onConflict: primaryKey.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
    });
  if (error) throw error;
}

async function getAuthUser(accessToken) {
  const authClient = client || (supabaseUrl && anonKey
    ? createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
    : null);
  if (!authClient) {
    throw new Error('Supabase Auth is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.');
  }
  const { data, error } = await authClient.auth.getUser(accessToken);
  return error ? null : data.user;
}

function getClient() {
  return requireClient();
}

async function findPendingOrders(merchantId, since) {
  const { data, error } = await requireClient()
    .from('orders')
    .select('*')
    .eq('merchant_id', merchantId)
    .eq('status', 'PENDING')
    .gte('created_at', since.toISOString());
  if (error) throw error;
  return data.map(fromDatabaseRow);
}

async function updateOrder(orderId, updates) {
  const { error } = await requireClient()
    .from('orders')
    .update(toDatabaseRow(updates))
    .eq('order_id', orderId);
  if (error) throw error;
}

module.exports = {
  connectSupabase,
  getAuthUser,
  getClient,
  findPendingOrders,
  hasSupabaseConfig: () => Boolean(client),
  hasSupabaseAuthConfig: () => Boolean(supabaseUrl && anonKey),
  publicConfig: () => ({
    supabaseUrl: supabaseUrl || '',
    supabaseAnonKey: anonKey || ''
  }),
  selectAll,
  updateOrder,
  upsertRecord
};

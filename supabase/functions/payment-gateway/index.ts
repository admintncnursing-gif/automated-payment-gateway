import { createClient } from "npm:@supabase/supabase-js@2";
import QRCode from "npm:qrcode@1.5.4";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key, x-merchant-id",
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
};

type Merchant = {
  id: string;
  api_key: string;
  name: string;
  email: string;
  business_name: string;
  upi_id: string;
  qr_image_path: string;
  is_onboarded: boolean;
  review_status: string;
  auth_user_id: string | null;
};

type Order = {
  order_id: string;
  merchant_id: string;
  amount: number;
  customer_name: string;
  customer_email: string;
  note: string;
  status: string;
  dynamic_upi_url: string;
  dynamic_qr_data_url: string;
  created_at: string;
  verified_at: string | null;
  payment_details: Record<string, unknown> | null;
};

type CheckoutInput = {
  amount?: unknown;
  customerName?: unknown;
  customerEmail?: unknown;
  note?: unknown;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function apiRow(row: object) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
      value,
    ]),
  );
}

function routePath(url: URL) {
  const marker = "/functions/v1/payment-gateway";
  const markerIndex = url.pathname.indexOf(marker);
  return markerIndex < 0
    ? url.pathname
    : url.pathname.slice(markerIndex + marker.length) || "/";
}

function checkError(error: { message: string } | null) {
  if (error) throw error;
}

async function findOne<T extends object>(table: string, column: string, value: string): Promise<T | null> {
  const { data, error } = await supabase
    .from(table)
    .select("*")
    .eq(column, value)
    .maybeSingle();
  checkError(error);
  return data as T | null;
}

async function findMany<T extends object>(
  table: string,
  filters: Record<string, string>,
  options: { columns?: string; createdSince?: string; orderBy?: string; limit?: number } = {},
) {
  let query = supabase.from(table).select(options.columns || "*");
  for (const [column, value] of Object.entries(filters)) {
    query = query.eq(column, value);
  }
  if (options.createdSince) query = query.gte("created_at", options.createdSince);
  if (options.orderBy) query = query.order(options.orderBy, { ascending: false });
  if (options.limit) query = query.limit(options.limit);

  const { data, error } = await query;
  checkError(error);
  return data as T[];
}

async function createOrder(merchant: Merchant, input: CheckoutInput) {
  if (merchant.review_status !== "approved" || !merchant.is_onboarded) {
    throw new Error("Merchant application is not approved.");
  }
  const baseAmount = Number(input.amount);
  if (!Number.isFinite(baseAmount) || baseAmount <= 0 || baseAmount > 9999999999.99) {
    throw new Error("A valid payment amount up to INR 9,999,999,999.99 is required.");
  }
  const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const pendingOrders = await findMany<{ amount: number }>("orders", {
    merchant_id: merchant.id,
    status: "PENDING",
  }, {
    columns: "amount",
    createdSince: fifteenMinutesAgo,
  });

  const occupiedAmounts = new Set(pendingOrders.map((order: { amount: number }) => Number(order.amount).toFixed(2)));
  let amount = baseAmount;
  for (let offset = 0; occupiedAmounts.has(amount.toFixed(2)) && offset < 50; offset += 1) {
    amount = Number((baseAmount + (offset + 1) * 0.01).toFixed(2));
  }

  const orderId = `PAY-${Date.now().toString().slice(-6)}-${Math.floor(100 + Math.random() * 900)}`;
  const rawNote = input.note ?? `Pay ${orderId}`;
  const note = String(rawNote).replace(/[^a-zA-Z0-9 ]/g, "").trim().slice(0, 24);
  const upiId = String(merchant.upi_id || "").trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(upiId)) {
    throw new Error("Merchant UPI ID is not configured.");
  }
  const payeeName = String(merchant.business_name || "")
    .replace(/&/g, "and")
    .replace(/[^a-zA-Z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const upiUri = `upi://pay?pa=${upiId}&pn=${encodeURIComponent(payeeName)}&am=${amount.toFixed(2)}&tr=${encodeURIComponent(orderId)}&tn=${encodeURIComponent(note)}&cu=INR&mode=00`;
  const qrDataUrl = await QRCode.toDataURL(upiUri, {
    errorCorrectionLevel: "H",
    margin: 2,
    width: 400,
    color: { dark: "#0A0D14", light: "#FFFFFF" },
  });

  const row: Order = {
    order_id: orderId,
    merchant_id: merchant.id,
    amount,
    customer_name: String(input.customerName || "Customer"),
    customer_email: String(input.customerEmail || ""),
    note,
    status: "PENDING",
    dynamic_upi_url: upiUri,
    dynamic_qr_data_url: qrDataUrl,
    created_at: new Date().toISOString(),
    verified_at: null,
    payment_details: null,
  };
  const { data, error } = await supabase.from("orders").insert(row).select("*").single();
  checkError(error);
  return data as Order;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const url = new URL(request.url);
  const path = routePath(url);
  let body: CheckoutInput & { orderId?: unknown; utr?: unknown } = {};

  if (request.method === "POST") {
    try {
      const parsed: unknown = await request.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return jsonResponse({ error: "Request body must be a JSON object." }, 400);
      }
      body = parsed as CheckoutInput & { orderId?: unknown; utr?: unknown };
    } catch {
      return jsonResponse({ error: "Request body must be valid JSON." }, 400);
    }
  }

  try {
    if (path === "/" || path === "/health") {
      return jsonResponse({
        status: "online",
        service: "ArchXpay Gateway on Supabase Edge Functions",
        database: "Supabase",
        timestamp: new Date().toISOString(),
      });
    }

    if ((path === "/api/v1/checkout/create" && ["GET", "POST"].includes(request.method))) {
      const apiKey = request.headers.get("x-api-key")
        || request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      if (!apiKey) return jsonResponse({ error: "Missing x-api-key header" }, 401);
      const merchant = await findOne<Merchant>("merchants", "api_key", apiKey);
      if (!merchant) return jsonResponse({ error: "Invalid API key" }, 403);
      if (merchant.review_status !== "approved" || !merchant.is_onboarded) {
        return jsonResponse({ error: "Merchant account is not approved." }, 403);
      }
      if (merchant.auth_user_id) {
        const { data: flags, error: flagsError } = await supabase
          .from("feature_flags")
          .select("enabled,user_id")
          .eq("flag_key", "public_api")
          .or(`user_id.is.null,user_id.eq.${merchant.auth_user_id}`);
        checkError(flagsError);
        const specificFlag = flags?.find((flag) => flag.user_id === merchant.auth_user_id);
        const systemFlag = flags?.find((flag) => flag.user_id === null);
        if ((specificFlag || systemFlag)?.enabled === false) {
          return jsonResponse({ error: "The public_api feature is disabled for this account." }, 403);
        }
      }
      const { data: maintenance, error: settingsError } = await supabase
        .from("system_settings")
        .select("setting_value")
        .eq("setting_key", "maintenance")
        .maybeSingle();
      checkError(settingsError);
      if (maintenance?.setting_value?.enabled) {
        return jsonResponse({
          error: maintenance.setting_value.message || "The service is temporarily unavailable for maintenance.",
        }, 503);
      }

      const input = request.method === "GET"
        ? { amount: url.searchParams.get("amount") }
        : body;
      const requestedAmount = Number(input.amount);
      if (!Number.isFinite(requestedAmount) || requestedAmount <= 0 || requestedAmount > 9999999999.99) {
        return jsonResponse({ error: "Provide a valid payment amount up to INR 9,999,999,999.99." }, 400);
      }
      const order = await createOrder(merchant, input);
      return jsonResponse({
        success: true,
        orderId: order.order_id,
        orderCode: order.order_id,
        amount: Number(order.amount),
        currency: "INR",
        status: order.status,
        paywallUrl: `/pay/${order.order_id}`,
        dynamicUpiUrl: order.dynamic_upi_url,
        upiUri: order.dynamic_upi_url,
        dynamicQrDataUrl: order.dynamic_qr_data_url,
      }, 201);
    }

    if (path === "/api/v1/checkout/verify-utr" && request.method === "POST") {
      const orderId = String(body.orderId || "");
      const utr = String(body.utr || "").trim();
      if (!orderId || !utr) return jsonResponse({ error: "Order ID and UTR required" }, 400);

      const order = await findOne<Order>("orders", "order_id", orderId);
      if (!order) return jsonResponse({ error: "Order not found" }, 404);
      const merchant = await findOne<Merchant>("merchants", "id", order.merchant_id);
      if (!merchant || merchant.review_status !== "approved" || !merchant.is_onboarded) {
        return jsonResponse({ error: "Order not found" }, 404);
      }
      if (!/^[a-z0-9]{6,30}$/i.test(utr)) {
        return jsonResponse({ error: "Enter a valid UTR or reference number." }, 400);
      }
      if (order.status === "PAID" &&
        [order.payment_details?.utr, order.payment_details?.txnId].some((reference) =>
          typeof reference === "string" && reference.toLowerCase() === utr.toLowerCase()
        )) {
        return jsonResponse({ success: true, verified: true, order: apiRow(order) });
      }
      return jsonResponse({
        success: false,
        verified: false,
        message: "This checkout API cannot verify UTRs. Wait for the merchant's payment verifier to confirm the transaction.",
      });
    }

    const statusMatch = path.match(/^\/api\/v1\/checkout\/status\/([^/]+)$/);
    if (statusMatch && request.method === "GET") {
      const order = await findOne<Order>("orders", "order_id", decodeURIComponent(statusMatch[1]));
      if (!order) return jsonResponse({ error: "Order not found" }, 404);
      const merchant = await findOne<Merchant>("merchants", "id", order.merchant_id);
      if (!merchant || merchant.review_status !== "approved" || !merchant.is_onboarded) {
        return jsonResponse({ error: "Order not found" }, 404);
      }
      return jsonResponse({
        success: true,
        verified: order.status === "PAID",
        order: apiRow(order),
        merchant: {
          businessName: merchant.business_name,
          upiId: merchant.upi_id,
          qrImagePath: merchant.qr_image_path,
        },
      });
    }

    if (path.startsWith("/api/v1/checkout/") && request.method === "GET") {
      const orderId = decodeURIComponent(path.slice("/api/v1/checkout/".length));
      const order = await findOne<Order>("orders", "order_id", orderId);
      if (!order) return jsonResponse({ error: "Order not found" }, 404);
      const merchant = await findOne<Merchant>("merchants", "id", order.merchant_id);
      if (!merchant || merchant.review_status !== "approved" || !merchant.is_onboarded) {
        return jsonResponse({ error: "Order not found" }, 404);
      }
      return jsonResponse({
        success: true,
        order: {
          orderId: order.order_id,
          orderCode: order.order_id,
          amount: Number(order.amount),
          customerName: order.customer_name,
          note: order.note,
          status: order.status,
          upiUri: order.dynamic_upi_url,
          dynamicUpiUrl: order.dynamic_upi_url,
          dynamicQrDataUrl: order.dynamic_qr_data_url,
          verifiedAt: order.verified_at,
          paymentDetails: order.payment_details,
        },
        merchant: {
          businessName: merchant.business_name,
          upiId: merchant.upi_id,
          qrImagePath: merchant.qr_image_path,
        },
      });
    }

    const genericOrderMatch = path.match(/^\/api\/orders\/([^/]+)$/);
    if (genericOrderMatch && request.method === "GET") {
      return jsonResponse({ error: "This endpoint is no longer available." }, 410);
    }

    if ((path === "/api/merchant/profile" || path === "/api/merchant/dashboard")
      && request.method === "GET") {
      return jsonResponse({ error: "Use the authenticated merchant API on the Node server." }, 410);
    }

    return jsonResponse({ error: `Route not found: ${path}` }, 404);
  } catch (error) {
    console.error("[payment-gateway] Request failed:", error);
    return jsonResponse({ error: "Request failed. Check the Edge Function logs." }, 500);
  }
});

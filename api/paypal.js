import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

function getBaseUrl(req) {
  const candidates = [
    process.env.APP_BASE_URL,
    process.env.NEXT_PUBLIC_BASE_URL,
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      const u = new URL(String(c));
      return u.origin;
    } catch (_) {}
  }

  if (req?.headers?.['x-forwarded-host']) {
    return `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host']}`;
  }

  try {
    const origin = req?.headers?.origin;
    if (origin) return new URL(String(origin)).origin;
  } catch (_) {}

  return 'https://dfsworldwidetracking.online';
}

function getSupabaseAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return null;
  return createClient(supabaseUrl, supabaseKey, { db: { schema: 'public' }, auth: { persistSession: false } });
}

async function readJsonBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return null;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function getPayPalBaseUrl() {
  const env = (process.env.PAYPAL_BASE_URL || '').trim();
  if (env) return env.replace(/\/+$/, '');
  return 'https://api-m.sandbox.paypal.com';
}

async function getPayPalAccessToken() {
  try { await import('dotenv/config'); } catch (_) {}

  const clientId = (process.env.PAYPAL_CLIENT_ID || '').trim();
  const clientSecret = (process.env.PAYPAL_CLIENT_SECRET || '').trim();
  if (!clientId || !clientSecret) {
    const e = new Error('PayPal not configured');
    e.statusCode = 500;
    throw e;
  }

  const baseUrl = getPayPalBaseUrl();
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const resp = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {}; }
  if (!resp.ok) {
    const e = new Error(data?.error_description || data?.message || 'Failed to get PayPal access token');
    e.statusCode = resp.status;
    e.details = data;
    throw e;
  }
  if (!data?.access_token) {
    const e = new Error('PayPal access token missing');
    e.statusCode = 502;
    e.details = data;
    throw e;
  }
  return data.access_token;
}

function extractApprovalUrl(order) {
  const links = Array.isArray(order?.links) ? order.links : [];
  const approve = links.find((l) => l?.rel === 'approve') || links.find((l) => String(l?.rel || '').toLowerCase().includes('approve'));
  return approve?.href || null;
}

async function handleCreateOrder(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const debug = req.query?.debug === '1' || req.query?.debug === 'true';

  const body = (req && typeof req.body !== 'undefined') ? req.body : await readJsonBody(req);
  const trackingId = body?.trackingId;
  const amount = (body?.amount === undefined || body?.amount === null) ? 50 : body.amount;
  const currencyType = body?.currencyType || 'USD';

  if (!trackingId || amount === undefined || amount === null) {
    return res.status(400).json({ error: 'Missing required fields: trackingId, amount' });
  }

  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  const currency = String(currencyType || 'USD').toUpperCase();
  const token = await getPayPalAccessToken();
  const baseUrl = getPayPalBaseUrl();
  const appBaseUrl = getBaseUrl(req);

  const orderId = `paypal-${trackingId}-${Date.now()}`;

  const createPayload = {
    intent: 'CAPTURE',
    application_context: {
      return_url: `${appBaseUrl}/payment/?status=success&provider=paypal&tid=${encodeURIComponent(String(trackingId))}`,
      cancel_url: `${appBaseUrl}/payment/?status=cancelled&provider=paypal&tid=${encodeURIComponent(String(trackingId))}`,
      user_action: 'PAY_NOW',
    },
    purchase_units: [
      {
        reference_id: String(trackingId),
        custom_id: String(orderId),
        description: `Payment for shipment tracking: ${trackingId}`,
        amount: {
          currency_code: currency,
          value: value.toFixed(2),
        },
      },
    ],
  };

  const resp = await fetch(`${baseUrl}/v2/checkout/orders`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': cryptoRandomId(),
    },
    body: JSON.stringify(createPayload),
  });

  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {}; }
  if (!resp.ok) {
    return res.status(resp.status || 502).json({ error: data?.message || 'PayPal create order failed', details: data });
  }

  const approvalUrl = extractApprovalUrl(data);

  const debugInfo = debug ? {
    has_service_role: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    paypal_order_id: data?.id || null,
    approvalUrl,
  } : null;

  const supabase = getSupabaseAdminClient();
  if (supabase) {
    const insertPayload = {
      payment_id: data?.id ? String(data.id) : null,
      provider: 'paypal',
      payment_status: 'waiting',
      order_id: String(orderId),
      tracking_id: String(trackingId),
      price_amount: value,
      price_currency: currency.toLowerCase(),
      pay_amount: value,
      pay_currency: currency.toLowerCase(),
      payment_url: approvalUrl,
      invoice_url: approvalUrl,
      raw_response: data,
      paypal_order_id: data?.id ? String(data.id) : null,
      paypal_status: data?.status ? String(data.status) : null,
    };

    // Persist immediately so admin can see it as waiting.
    // Prefer upsert to avoid duplicate rows if create-order is called twice.
    try {
      if (insertPayload.paypal_order_id) {
        const upsertRes = await supabase
          .from('payments')
          .upsert(insertPayload, { onConflict: 'paypal_order_id' })
          .select('id');
        if (debugInfo) {
          debugInfo.db = {
            op: 'upsert',
            rows: Array.isArray(upsertRes?.data) ? upsertRes.data.length : 0,
            error: upsertRes?.error ? {
              message: upsertRes.error.message,
              details: upsertRes.error.details,
              hint: upsertRes.error.hint,
              code: upsertRes.error.code,
            } : null,
          };
        }
      } else {
        const insertRes = await supabase.from('payments').insert(insertPayload).select('id');
        if (debugInfo) {
          debugInfo.db = {
            op: 'insert',
            rows: Array.isArray(insertRes?.data) ? insertRes.data.length : 0,
            error: insertRes?.error ? {
              message: insertRes.error.message,
              details: insertRes.error.details,
              hint: insertRes.error.hint,
              code: insertRes.error.code,
            } : null,
          };
        }
      }
    } catch (e) {
      if (debugInfo) {
        debugInfo.exception = { message: e?.message || String(e), stack: e?.stack || null };
      }
    }
  } else if (debugInfo) {
    debugInfo.db = { op: 'none', error: { message: 'Supabase not configured' } };
  }

  return res.status(200).json({
    success: true,
    provider: 'paypal',
    orderId: data?.id || null,
    status: data?.status || null,
    approvalUrl,
    checkoutUrl: approvalUrl,
    paymentUrl: approvalUrl,
    ...(debugInfo ? { debug: debugInfo } : {}),
  });
}

async function handleCapture(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const debug = req.query?.debug === '1' || req.query?.debug === 'true';

  const body = (req && typeof req.body !== 'undefined') ? req.body : await readJsonBody(req);
  const paypalOrderId = body?.orderId || body?.paypalOrderId;
  if (!paypalOrderId) return res.status(400).json({ error: 'Missing orderId' });

  const token = await getPayPalAccessToken();
  const baseUrl = getPayPalBaseUrl();

  const resp = await fetch(`${baseUrl}/v2/checkout/orders/${encodeURIComponent(String(paypalOrderId))}/capture`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'PayPal-Request-Id': cryptoRandomId(),
    },
  });

  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {}; }
  if (!resp.ok) {
    return res.status(resp.status || 502).json({ error: data?.message || 'PayPal capture failed', details: data });
  }

  const completed = String(data?.status || '').toUpperCase() === 'COMPLETED';

  const debugInfo = debug ? {
    has_service_role: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    paypal_order_id: String(paypalOrderId),
    completed,
  } : null;

  const captureId =
    data?.purchase_units?.[0]?.payments?.captures?.[0]?.id ||
    data?.purchase_units?.[0]?.payments?.authorizations?.[0]?.id ||
    null;

  const payerId = data?.payer?.payer_id || null;
  const payerEmail = data?.payer?.email_address || null;

  const supabase = getSupabaseAdminClient();
  if (supabase) {
    const nowIso = new Date().toISOString();
    const updatePayload = {
      provider: 'paypal',
      payment_status: completed ? 'success' : 'waiting',
      paypal_order_id: String(paypalOrderId),
      paypal_capture_id: captureId ? String(captureId) : null,
      paypal_payer_id: payerId ? String(payerId) : null,
      paypal_payer_email: payerEmail ? String(payerEmail) : null,
      paypal_status: data?.status ? String(data.status) : null,
      paypal_capture_status: data?.purchase_units?.[0]?.payments?.captures?.[0]?.status || null,
      ipn_received: true,
      ipn_received_at: nowIso,
      ipn_data: data,
    };

    try {
      const updateRes = await supabase
        .from('payments')
        .update(updatePayload)
        .eq('paypal_order_id', String(paypalOrderId))
        .select('id');

      const updatedCount = Array.isArray(updateRes?.data) ? updateRes.data.length : 0;
      if (debugInfo) {
        debugInfo.update = {
          updatedCount,
          error: updateRes?.error ? {
            message: updateRes.error.message,
            details: updateRes.error.details,
            hint: updateRes.error.hint,
            code: updateRes.error.code,
          } : null,
        };
      }
      if (updatedCount === 0) {
        // If row wasn't created for some reason, insert one now.
        const minimalInsert = {
          payment_id: String(paypalOrderId),
          provider: 'paypal',
          payment_status: completed ? 'success' : 'waiting',
          order_id: `paypal-${Date.now()}`,
          tracking_id: data?.purchase_units?.[0]?.reference_id || null,
          paypal_order_id: String(paypalOrderId),
          paypal_capture_id: captureId ? String(captureId) : null,
          paypal_payer_id: payerId ? String(payerId) : null,
          paypal_payer_email: payerEmail ? String(payerEmail) : null,
          paypal_status: data?.status ? String(data.status) : null,
          paypal_capture_status: data?.purchase_units?.[0]?.payments?.captures?.[0]?.status || null,
          raw_response: data,
          ipn_received: true,
          ipn_received_at: nowIso,
          ipn_data: data,
        };
        const upsertRes = await supabase.from('payments').upsert(minimalInsert, { onConflict: 'paypal_order_id' }).select('id');
        if (debugInfo) {
          debugInfo.upsert = {
            rows: Array.isArray(upsertRes?.data) ? upsertRes.data.length : 0,
            error: upsertRes?.error ? {
              message: upsertRes.error.message,
              details: upsertRes.error.details,
              hint: upsertRes.error.hint,
              code: upsertRes.error.code,
            } : null,
          };
        }
      }
    } catch (_) {}
  }

  return res.status(200).json({ ok: true, provider: 'paypal', completed, raw: data, ...(debugInfo ? { debug: debugInfo } : {}) });
}

async function verifyWebhookSignature({ headers, body }) {
  const webhookId = (process.env.PAYPAL_WEBHOOK_ID || '').trim();
  if (!webhookId) return { ok: false, reason: 'PAYPAL_WEBHOOK_ID missing' };

  const transmissionId = headers['paypal-transmission-id'];
  const transmissionTime = headers['paypal-transmission-time'];
  const certUrl = headers['paypal-cert-url'];
  const authAlgo = headers['paypal-auth-algo'];
  const transmissionSig = headers['paypal-transmission-sig'];

  if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
    return { ok: false, reason: 'Missing PayPal signature headers' };
  }

  const token = await getPayPalAccessToken();
  const baseUrl = getPayPalBaseUrl();

  const payload = {
    auth_algo: authAlgo,
    cert_url: certUrl,
    transmission_id: transmissionId,
    transmission_sig: transmissionSig,
    transmission_time: transmissionTime,
    webhook_id: webhookId,
    webhook_event: body,
  };

  const resp = await fetch(`${baseUrl}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = {}; }
  if (!resp.ok) return { ok: false, reason: 'verify call failed', details: data };

  const status = String(data?.verification_status || '').toUpperCase();
  return { ok: status === 'SUCCESS', verification_status: data?.verification_status || null, details: data };
}

async function handleWebhook(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const debug = req.query?.debug === '1' || req.query?.debug === 'true';

  const body = (req && typeof req.body !== 'undefined') ? req.body : await readJsonBody(req);
  if (!body) return res.status(400).json({ error: 'Invalid JSON' });

  // Verify signature if possible; if verification fails we still respond 200 to avoid retries during setup,
  // but we won't update DB.
  let verified = null;
  try {
    verified = await verifyWebhookSignature({ headers: req.headers || {}, body });
  } catch (e) {
    verified = { ok: false, reason: e?.message || String(e) };
  }

  if (verified && verified.ok === false) {
    return res.status(200).json({ received: true, verified: false, reason: verified.reason || null, ...(debug ? { debug: { has_service_role: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY) } } : {}) });
  }

  const eventType = String(body?.event_type || '').toUpperCase();
  const resource = body?.resource || {};

  const paypalOrderId =
    resource?.id ||
    resource?.supplementary_data?.related_ids?.order_id ||
    resource?.supplementary_data?.related_ids?.checkout_order_id ||
    null;

  const captureId = resource?.id && (eventType.includes('CAPTURE') ? resource.id : null);

  const supabase = getSupabaseAdminClient();
  if (supabase && paypalOrderId) {
    const nowIso = new Date().toISOString();
    const completed = eventType.includes('PAYMENT.CAPTURE.COMPLETED');

    const updatePayload = {
      provider: 'paypal',
      paypal_order_id: String(paypalOrderId),
      paypal_webhook_event_type: body?.event_type || null,
      paypal_webhook_id: body?.id || null,
      paypal_status: resource?.status || null,
      paypal_capture_id: captureId || null,
      payment_status: completed ? 'success' : undefined,
      ipn_received: true,
      ipn_received_at: nowIso,
      ipn_data: body,
    };

    // Remove undefined fields (supabase-js rejects undefined)
    Object.keys(updatePayload).forEach((k) => updatePayload[k] === undefined && delete updatePayload[k]);

    try {
      const updateRes = await supabase
        .from('payments')
        .update(updatePayload)
        .eq('paypal_order_id', String(paypalOrderId))
        .select('id');

      const updatedCount = Array.isArray(updateRes?.data) ? updateRes.data.length : 0;
      if (updatedCount === 0) {
        const minimalInsert = {
          payment_id: String(paypalOrderId),
          provider: 'paypal',
          payment_status: completed ? 'success' : 'waiting',
          order_id: `paypal-${Date.now()}`,
          tracking_id: null,
          paypal_order_id: String(paypalOrderId),
          paypal_webhook_event_type: body?.event_type || null,
          paypal_webhook_id: body?.id || null,
          paypal_status: resource?.status || null,
          paypal_capture_id: captureId || null,
          raw_response: body,
          ipn_received: true,
          ipn_received_at: nowIso,
          ipn_data: body,
        };
        await supabase.from('payments').upsert(minimalInsert, { onConflict: 'paypal_order_id' });
      }
    } catch (_) {}
  }

  return res.status(200).json({ received: true, verified: true, ...(debug ? { debug: { has_service_role: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY) } } : {}) });
}

function cryptoRandomId() {
  // simple request id for idempotency (no external deps)
  try {
    return crypto.randomUUID();
  } catch (_) {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

export default async function handler(req, res) {
  try { await import('dotenv/config'); } catch (_) {}

  // Ensure compatibility with Vercel-style res helpers when running under plain Node
  if (typeof res.status !== 'function') {
    res.status = (code) => { res.statusCode = code; return res; };
  }
  if (typeof res.json !== 'function') {
    res.json = (obj) => {
      const body = Buffer.from(JSON.stringify(obj));
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Length', String(body.length));
      res.end(body);
    };
  }

  const action = req.query?._action;
  const debug = req.query?.debug === '1' || req.query?.debug === 'true';

  if (action === 'webhook') return handleWebhook(req, res);
  if (action === 'create-order') return handleCreateOrder(req, res);
  if (action === 'capture') return handleCapture(req, res);

  return res.status(400).json({ error: 'Invalid action' });
}

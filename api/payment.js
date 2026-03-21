import crypto from 'crypto';
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";

const CODE_VERSION = 'stripe-db-update-2026-03-21-1';

function getBaseUrl(req) {
  const candidates = [
    process.env.APP_BASE_URL,
    process.env.NEXT_PUBLIC_BASE_URL,
    process.env.STRIPE_BASE_URL,
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      const u = new URL(String(c));
      const host = (u.hostname || '').toLowerCase();
      // Prevent misconfig where STRIPE_BASE_URL is set to Stripe API domain.
      if (host.endsWith('stripe.com')) continue;
      return u.origin;
    } catch (_) {}
  }

  if (req.headers['x-forwarded-host']) {
    return `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host']}`;
  }

  try {
    const origin = req.headers.origin;
    if (origin) return new URL(String(origin)).origin;
  } catch (_) {}

  return 'https://dfsworldwide.vercel.app';
}

function getSupabaseAdminClient() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return null;
  return createClient(supabaseUrl, supabaseKey, { db: { schema: 'public' }, auth: { persistSession: false } });
}

async function handleCreate(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await import('dotenv/config');
  } catch (_) {}

  try {
    const { trackingId, currency, amount, currencyType } = req.body;

    if (!trackingId || !currency || !amount || !currencyType) {
      return res.status(400).json({ error: 'Missing required fields: trackingId, currency, amount, currencyType' });
    }

    const supportedCurrencies = ['BTC', 'ETH', 'BNB'];
    if (!supportedCurrencies.includes(currency)) {
      return res.status(400).json({ error: 'Unsupported currency. Supported: BTC, ETH, BNB' });
    }

    const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
    const NOWPAYMENTS_BASE_URL = process.env.NOWPAYMENTS_BASE_URL || 'https://api-sandbox.nowpayments.io/v1';

    if (!NOWPAYMENTS_API_KEY) {
      return res.status(500).json({ error: 'Payment service not configured' });
    }

    const baseUrl = getBaseUrl(req);

    const priceAmount = parseFloat(amount);
    if (isNaN(priceAmount) || priceAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount. Must be a positive number.' });
    }

    const payCurrency = currency.toLowerCase();

    const paymentData = {
      price_amount: priceAmount,
      price_currency: (currencyType || 'USD').toLowerCase(),
      pay_currency: payCurrency,
      order_id: `tracking-${trackingId}-${Date.now()}`,
      order_description: `Payment for shipment tracking: ${trackingId}`,
      ipn_callback_url: `${baseUrl}/api/payment?_action=ipn`,
      success_url: `${baseUrl}/payment?status=success&tid=${trackingId}`,
      cancel_url: `${baseUrl}/payment?status=cancelled&tid=${trackingId}`
    };

    const response = await fetch(`${NOWPAYMENTS_BASE_URL}/payment`, {
      method: 'POST',
      headers: { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(paymentData)
    });

    let data;
    const responseText = await response.text();
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch (parseError) {
      return res.status(500).json({ error: 'Invalid response from payment service', rawResponse: responseText.substring(0, 200) });
    }

    if (!response.ok) {
      const errorMessage = data.message || data.error || data.description || 'Payment creation failed';
      return res.status(response.status || 500).json({ error: errorMessage, details: data, statusCode: response.status });
    }

    let responseData = data;
    if (data.result && typeof data.result === 'object') responseData = data.result;
    else if (data.data && typeof data.data === 'object') responseData = data.data;
    else if (data.response && typeof data.response === 'object') responseData = data.response;

    const paymentUrl = responseData.pay_url || responseData.invoice_url || responseData.payment_url || responseData.url || responseData.invoiceUrl || responseData.payUrl || responseData.link || responseData.checkout_url || responseData.checkoutUrl || (data.pay_url || data.invoice_url || data.payment_url);
    const paymentId = responseData.payment_id || responseData.id || responseData.paymentId || responseData.invoice_id || (data.payment_id || data.id);
    const payAmount = responseData.pay_amount || responseData.amount || responseData.price_amount || (data.pay_amount || data.amount);
    const responsePayCurrency = responseData.pay_currency || responseData.currency || responseData.payCurrency || (data.pay_currency || data.currency) || payCurrency;
    const walletAddress = responseData.payment_address || responseData.pay_address || responseData.address || responseData.wallet_address || (data.payment_address || data.pay_address || data.address);

    let expirationTime = responseData.expiration_estimate_at || responseData.expires_at || responseData.expiration_at || responseData.expires_at_iso || responseData.expiration_estimate || responseData.expires || (data.expiration_estimate_at || data.expires_at || data.expiration_at || data.expiration_estimate || data.expires);
    if (!expirationTime) {
      const defaultExpiration = new Date();
      defaultExpiration.setMinutes(defaultExpiration.getMinutes() + 30);
      expirationTime = defaultExpiration.toISOString();
    }

    if (!walletAddress && !paymentUrl) {
      return res.status(500).json({ error: 'Payment details not received from payment service', debug: { receivedKeys: Object.keys(responseData || {}), fullResponse: responseData } });
    }

    const saveToDatabase = async () => {
      try {
        const supabaseUrl = process.env.SUPABASE_URL;
        const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
        if (!supabaseUrl || !supabaseKey) return { success: false, error: 'Supabase not configured' };

        const supabase = createClient(supabaseUrl, supabaseKey, { db: { schema: 'public' }, auth: { persistSession: false } });

        let expirationDateTime = null;
        if (expirationTime) {
          let parsedDate = new Date(expirationTime);
          if (isNaN(parsedDate.getTime())) {
            const unixTime = typeof expirationTime === 'number' ? expirationTime : parseInt(expirationTime);
            if (!isNaN(unixTime)) {
              parsedDate = unixTime < 10000000000 ? new Date(unixTime * 1000) : new Date(unixTime);
            }
          }
          if (!isNaN(parsedDate.getTime())) expirationDateTime = parsedDate.toISOString();
        }

        const orderId = paymentData.order_id;
        let extractedTrackingId = trackingId;
        if (orderId && orderId.startsWith('tracking-')) {
          const withoutPrefix = orderId.substring(9);
          const lastDashIndex = withoutPrefix.lastIndexOf('-');
          if (lastDashIndex > 0) {
            const afterLastDash = withoutPrefix.substring(lastDashIndex + 1);
            if (/^\d+$/.test(afterLastDash)) extractedTrackingId = withoutPrefix.substring(0, lastDashIndex);
          }
        }
        const finalTrackingId = extractedTrackingId || trackingId;

        if (!paymentId) throw new Error('Payment ID is required but not provided by NOWPayments');
        if (!orderId) throw new Error('Order ID is required');
        if (!finalTrackingId) throw new Error('Tracking ID is required');
        if (!priceAmount || isNaN(priceAmount)) throw new Error('Valid price amount is required');
        if (!responsePayCurrency) throw new Error('Payment currency is required');

        const paymentRecord = {
          payment_id: String(paymentId),
          order_id: String(orderId),
          tracking_id: String(finalTrackingId),
          price_amount: parseFloat(priceAmount),
          price_currency: String((currencyType || 'USD').toLowerCase()),
          pay_amount: payAmount ? parseFloat(payAmount) : null,
          pay_currency: String(responsePayCurrency),
          wallet_address: walletAddress ? String(walletAddress) : null,
          payment_address: walletAddress ? String(walletAddress) : null,
          payment_status: 'waiting',
          payment_url: paymentUrl ? String(paymentUrl) : null,
          invoice_url: paymentUrl ? String(paymentUrl) : null,
          expiration_time: expirationDateTime || null,
          expiration_estimate_at: expirationDateTime || null,
          raw_response: data || null,
          ipn_received: false,
          ipn_received_at: null,
          ipn_data: null
        };

        const { data: insertData, error: insertError } = await supabase.from('payments').insert(paymentRecord).select();
        if (insertError) return { success: false, error: insertError.message, details: insertError.details, hint: insertError.hint, code: insertError.code };
        if (insertData && insertData.length > 0) return { success: true, insertedId: insertData[0].id, data: insertData[0] };
        return { success: false, error: 'Insert completed but no data returned' };
      } catch (dbException) {
        return { success: false, error: dbException.message || 'Unknown database error' };
      }
    };

    await saveToDatabase();

    return res.status(200).json({
      success: true,
      payment: responseData,
      paymentId,
      paymentUrl,
      payAmount,
      payCurrency: responsePayCurrency,
      walletAddress,
      expirationTime,
      rawResponse: data
    });

  } catch (error) {
    return res.status(500).json({ error: 'Internal server error', message: error.message });
  }
}

async function handleStripeCreate(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try { await import('dotenv/config'); } catch (_) {}

  const debug = req.query?.debug === '1' || req.query?.debug === 'true';

  const { trackingId, amount, currencyType } = req.body || {};
  if (!trackingId || amount === undefined || amount === null) {
    return res.status(400).json({ error: 'Missing required fields: trackingId, amount' });
  }

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return res.status(500).json({ error: 'Stripe not configured' });

  const priceAmount = parseFloat(amount);
  if (isNaN(priceAmount) || priceAmount <= 0) {
    return res.status(400).json({ error: 'Invalid amount. Must be a positive number.' });
  }

  const currency = String(currencyType || 'USD').toLowerCase();
  const baseUrl = getBaseUrl(req);
  const stripe = new Stripe(secretKey);

  try {
    const orderId = `stripe-${trackingId}-${Date.now()}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      success_url: `${baseUrl}/payment?status=success&provider=stripe&session_id={CHECKOUT_SESSION_ID}&tid=${encodeURIComponent(trackingId)}`,
      cancel_url: `${baseUrl}/payment?status=cancelled&provider=stripe&tid=${encodeURIComponent(trackingId)}`,
      client_reference_id: String(trackingId),
      metadata: {
        tracking_id: String(trackingId),
        order_id: String(orderId),
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: Math.round(priceAmount * 100),
            product_data: {
              name: `Shipment Payment (${trackingId})`,
              description: `Payment for shipment tracking: ${trackingId}`,
            },
          },
        },
      ],
    });

    const supabase = getSupabaseAdminClient();
    if (supabase) {
      const paymentRecord = {
        payment_id: String(session.id),
        order_id: String(orderId),
        tracking_id: String(trackingId),
        price_amount: priceAmount,
        price_currency: currency,
        pay_amount: priceAmount,
        pay_currency: currency,
        payment_status: 'waiting',
        payment_url: session.url ? String(session.url) : null,
        invoice_url: session.url ? String(session.url) : null,
        raw_response: session,
        provider: 'stripe',
        stripe_session_id: session.id,
        stripe_payment_intent: session.payment_intent ? String(session.payment_intent) : null,
        stripe_customer_id: session.customer ? String(session.customer) : null,
      };
      const insertRes = await supabase.from('payments').insert(paymentRecord).select('id');
      if (debug) {
        // eslint-disable-next-line no-unused-vars
        const _debug = {
          has_service_role: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
          insertedCount: Array.isArray(insertRes?.data) ? insertRes.data.length : 0,
          error: insertRes?.error ? {
            message: insertRes.error.message,
            details: insertRes.error.details,
            hint: insertRes.error.hint,
            code: insertRes.error.code,
          } : null,
        };
        return res.status(200).json({
          success: true,
          provider: 'stripe',
          checkoutUrl: session.url,
          sessionId: session.id,
          code_version: CODE_VERSION,
          debug: _debug,
        });
      }
    }

    return res.status(200).json({
      success: true,
      provider: 'stripe',
      checkoutUrl: session.url,
      sessionId: session.id,
      code_version: CODE_VERSION,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Stripe session creation failed' });
  }
}

async function handleStripeStatus(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try { await import('dotenv/config'); } catch (_) {}

  const debug = req.query?.debug === '1' || req.query?.debug === 'true';

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) return res.status(500).json({ error: 'Stripe not configured' });

  const sessionId = req.query?.session_id || req.query?.sessionId;
  if (!sessionId) return res.status(400).json({ error: 'Missing session_id' });

  try {
    const stripe = new Stripe(secretKey);
    const session = await stripe.checkout.sessions.retrieve(String(sessionId), { expand: ['payment_intent'] });
    const paid = session.payment_status === 'paid' || session.status === 'complete';

    const debugInfo = debug ? {
      code_version: CODE_VERSION,
      session_id: session.id,
      paid,
      session_payment_status: session.payment_status,
      session_status: session.status,
      has_service_role: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    } : null;

    if (paid) {
      const supabase = getSupabaseAdminClient();
      if (!supabase) {
        if (debugInfo) debugInfo.supabase = { ok: false, reason: 'missing SUPABASE_URL / key' };
      } else {
        try {
          const nowIso = new Date().toISOString();
          const amountTotal = typeof session.amount_total === 'number' ? (session.amount_total / 100) : null;
          const currency = session.currency ? String(session.currency).toLowerCase() : null;
          const trackingId = session.client_reference_id || session.metadata?.tracking_id || null;
          const orderId = session.metadata?.order_id || `stripe-${trackingId || 'unknown'}-${Date.now()}`;
          const paymentIntentId = session.payment_intent?.id || session.payment_intent || null;
          const customerId = session.customer || null;

          const updatePayload = {
            payment_status: 'success',
            provider: 'stripe',
            stripe_session_id: session.id,
            stripe_payment_intent: paymentIntentId ? String(paymentIntentId) : null,
            stripe_customer_id: customerId ? String(customerId) : null,
            stripe_payment_status: session.payment_status,
            stripe_status: session.status,
            price_amount: amountTotal,
            price_currency: currency,
            pay_amount: amountTotal,
            pay_currency: currency,
            ipn_received: true,
            ipn_received_at: nowIso,
            ipn_data: session,
          };

          // Update matching strategy:
          // - Some deployments reported PostgREST errors for filtering by `payment_id`.
          // - Stripe session id is always available, and we also have `order_id` + `tracking_id`.
          const updateAttempts = [];
          const attemptUpdate = async (label, updater) => {
            const r = await updater();
            const count = Array.isArray(r?.data) ? r.data.length : 0;
            updateAttempts.push({
              label,
              updatedCount: count,
              error: r?.error ? {
                message: r.error.message,
                details: r.error.details,
                hint: r.error.hint,
                code: r.error.code,
              } : null,
            });
            return count;
          };

          let updatedCount = 0;
          updatedCount = await attemptUpdate('stripe_session_id', () =>
            supabase.from('payments')
              .update(updatePayload)
              .eq('stripe_session_id', String(session.id))
              .select('id')
          );

          if (updatedCount === 0 && orderId) {
            updatedCount = await attemptUpdate('order_id', () =>
              supabase.from('payments')
                .update(updatePayload)
                .eq('order_id', String(orderId))
                .select('id')
            );
          }

          if (updatedCount === 0 && trackingId) {
            updatedCount = await attemptUpdate('tracking_id', () =>
              supabase.from('payments')
                .update(updatePayload)
                .eq('tracking_id', String(trackingId))
                .select('id')
            );
          }

          if (debugInfo) {
            debugInfo.update = {
              updatedCount,
              attempts: updateAttempts,
            };
          }

          // If the original insert failed (e.g. missing stripe columns) there may be no row to update.
          if (updatedCount === 0) {
            const minimalRecord = {
              payment_id: String(session.id),
              order_id: String(orderId),
              tracking_id: trackingId ? String(trackingId) : String(session.client_reference_id || ''),
              price_amount: amountTotal,
              price_currency: currency,
              pay_amount: amountTotal,
              pay_currency: currency,
              payment_status: 'success',
              payment_url: session.url ? String(session.url) : null,
              invoice_url: session.url ? String(session.url) : null,
              raw_response: session,
              provider: 'stripe',
              stripe_session_id: session.id,
              stripe_payment_intent: paymentIntentId ? String(paymentIntentId) : null,
              stripe_customer_id: customerId ? String(customerId) : null,
              stripe_payment_status: session.payment_status,
              stripe_status: session.status,
              ipn_received: true,
              ipn_received_at: nowIso,
              ipn_data: session,
            };

            const insert1 = await supabase.from('payments').insert(minimalRecord).select('id');
            if (debugInfo) {
              debugInfo.insert = {
                insertedCount: Array.isArray(insert1?.data) ? insert1.data.length : 0,
                error: insert1?.error ? {
                  message: insert1.error.message,
                  details: insert1.error.details,
                  hint: insert1.error.hint,
                  code: insert1.error.code,
                } : null,
              };
            }
          }
        } catch (e) {
          if (debugInfo) {
            debugInfo.exception = {
              message: e?.message || String(e),
              stack: e?.stack || null,
            };
          }
        }
      }
    }

    return res.status(200).json({
      ok: true,
      provider: 'stripe',
      paid,
      sessionId: session.id,
      payment_status: session.payment_status,
      status: session.status,
      payment_intent: session.payment_intent?.id || session.payment_intent || null,
      code_version: CODE_VERSION,
      ...(debugInfo ? { debug: debugInfo } : {}),
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || 'Stripe status check failed' });
  }
}

async function handleIpn(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const NOWPAYMENTS_IPN_SECRET = process.env.NOWPAYMENTS_IPN_SECRET;
    if (!NOWPAYMENTS_IPN_SECRET) return res.status(500).json({ error: 'IPN secret not configured' });

    const rawBody = JSON.stringify(req.body);
    const signature = req.headers['x-nowpayments-sig'] || req.headers['x-nowpayments-signature'];
    if (!signature) return res.status(400).json({ error: 'Missing signature' });

    const expectedSignature = crypto.createHmac('sha512', NOWPAYMENTS_IPN_SECRET).update(rawBody).digest('hex');
    if (signature !== expectedSignature) return res.status(400).json({ error: 'Invalid signature' });

    const paymentData = req.body;
    const orderId = paymentData.order_id || '';
    const trackingIdMatch = orderId.match(/^tracking-(.+?)-/);
    const trackingId = trackingIdMatch ? trackingIdMatch[1] : null;
    const status = paymentData.payment_status;

    console.log('IPN received:', { paymentId: paymentData.payment_id, paymentStatus: status, orderId, trackingId });

    if (status === 'finished') {
      console.log(`Payment ${paymentData.payment_id} completed for tracking ${trackingId}`);
    } else if (status === 'failed' || status === 'expired') {
      console.log(`Payment ${paymentData.payment_id} ${status} for tracking ${trackingId}`);
    } else if (status === 'partially_paid') {
      console.log(`Payment ${paymentData.payment_id} partially paid for tracking ${trackingId}`);
    }

    return res.status(200).json({ received: true });
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
}

async function handleStatus(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try { await import('dotenv/config'); } catch (_) {}

  const paymentId = req.query?.paymentId || req.query?.id || req.query?.pid;
  if (!paymentId) return res.status(400).json({ error: 'Missing paymentId' });

  const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
  const NOWPAYMENTS_BASE_URL = process.env.NOWPAYMENTS_BASE_URL || 'https://api-sandbox.nowpayments.io/v1';
  if (!NOWPAYMENTS_API_KEY) return res.status(500).json({ error: 'Payment service not configured' });

  const headers = { 'x-api-key': NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' };

  async function fetchStatus() {
    const url1 = `${NOWPAYMENTS_BASE_URL}/payment/${encodeURIComponent(paymentId)}`;
    let resp = await fetch(url1, { headers });
    if (resp.ok) return { ok: true, data: await resp.json(), source: url1 };
    const url2 = `${NOWPAYMENTS_BASE_URL}/payment?paymentId=${encodeURIComponent(paymentId)}`;
    resp = await fetch(url2, { headers });
    if (resp.ok) return { ok: true, data: await resp.json(), source: url2 };
    const text = await resp.text();
    return { ok: false, status: resp.status, statusText: resp.statusText, body: text?.slice(0, 400) };
  }

  function extractStatus(data) {
    if (!data || typeof data !== 'object') return null;
    const d = data.result || data.data || data.response || data;
    return d.payment_status || d.status || d.state || d.paymentStatus || (Array.isArray(d) && d[0]?.payment_status) || null;
  }

  try {
    const out = await fetchStatus();
    if (!out.ok) return res.status(out.status || 502).json({ error: 'Failed to fetch status', details: out });
    return res.status(200).json({ payment_status: extractStatus(out.data), raw: out.data });
  } catch (err) {
    return res.status(500).json({ error: 'Internal server error', message: err?.message });
  }
}

export default async function handler(req, res) {
  const action = req.query._action;

  if (action === 'create') return handleCreate(req, res);
  if (action === 'ipn') return handleIpn(req, res);
  if (action === 'stripe-create') return handleStripeCreate(req, res);
  if (action === 'stripe-status') return handleStripeStatus(req, res);
  if (action === 'status' || req.method === 'GET') return handleStatus(req, res);

  return res.status(400).json({ error: 'Invalid action' });
}

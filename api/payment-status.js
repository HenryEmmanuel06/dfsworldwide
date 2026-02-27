export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Load dotenv for local dev if available
  try { await import('dotenv/config'); } catch (_) {}

  const paymentId = req.query?.paymentId || req.query?.id || req.query?.pid;
  if (!paymentId) {
    return res.status(400).json({ error: 'Missing paymentId' });
  }

  const NOWPAYMENTS_API_KEY = process.env.NOWPAYMENTS_API_KEY;
  const NOWPAYMENTS_BASE_URL = process.env.NOWPAYMENTS_BASE_URL || 'https://api-sandbox.nowpayments.io/v1';

  if (!NOWPAYMENTS_API_KEY) {
    return res.status(500).json({ error: 'Payment service not configured' });
  }

  const headers = {
    'x-api-key': NOWPAYMENTS_API_KEY,
    'Content-Type': 'application/json'
  };

  async function fetchStatus() {
    // Try standard endpoint
    const url1 = `${NOWPAYMENTS_BASE_URL}/payment/${encodeURIComponent(paymentId)}`;
    let resp = await fetch(url1, { headers });
    if (resp.ok) return { ok: true, data: await resp.json(), source: url1 };

    // Fallbacks (different deployments sometimes expose alternative shapes)
    const url2 = `${NOWPAYMENTS_BASE_URL}/payment?paymentId=${encodeURIComponent(paymentId)}`;
    resp = await fetch(url2, { headers });
    if (resp.ok) return { ok: true, data: await resp.json(), source: url2 };

    const text = await resp.text();
    return { ok: false, status: resp.status, statusText: resp.statusText, body: text?.slice(0, 400) };
  }

  function extractStatus(data) {
    if (!data || typeof data !== 'object') return null;
    const d = data.result || data.data || data.response || data;
    return (
      d.payment_status || d.status || d.state || d.paymentStatus ||
      (Array.isArray(d) && d[0]?.payment_status) || null
    );
  }

  try {
    const out = await fetchStatus();
    if (!out.ok) {
      return res.status(out.status || 502).json({ error: 'Failed to fetch status', details: out });
    }

    const payment_status = extractStatus(out.data);
    return res.status(200).json({ payment_status, raw: out.data });
  } catch (err) {
    console.error('payment-status error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err?.message });
  }
}

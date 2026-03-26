import { createClient } from "@supabase/supabase-js";
import { sendMail } from "./_lib/mailer.js";

function generateTrackingId() {
  const pad = (n)=> String(n).padStart(2,'0');
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
  const rand = Math.random().toString(36).slice(2,8).toUpperCase();
  return `DFS-${stamp}-${rand}`;
}

function parseCreatedAt(tr) {
  if (tr && tr.created_at) return new Date(tr.created_at);
  const m = /DFS-(\d{12})-/.exec((tr && tr.tracking_id) || '');
  if (m) {
    const s = m[1];
    const y = +s.slice(0,4), mo = +s.slice(4,6)-1, d = +s.slice(6,8), h = +s.slice(8,10), mi = +s.slice(10,12);
    return new Date(y, mo, d, h, mi);
  }
  return null;
}

function parseDeliveryDate(tr) {
  if (tr && tr.delivery_date) return new Date(tr.delivery_date);
  if (tr && tr.estimated_delivery) return new Date(tr.estimated_delivery);
  return null;
}

function computeStage(tr) {
  const created = parseCreatedAt(tr);
  const delivery = parseDeliveryDate(tr);
  let activeIndex = 0;
  let hold = false;
  if (created && delivery) {
    const now = Date.now();
    const totalDuration = Math.max(0, delivery.getTime() - created.getTime());
    const elapsedTime = Math.max(0, now - created.getTime());
    if (totalDuration > 0) {
      const part = totalDuration / 4;
      if (elapsedTime >= part * 3) { activeIndex = 3; hold = true; }
      else if (elapsedTime >= part * 2) { activeIndex = 2; }
      else if (elapsedTime >= part) { activeIndex = 1; }
    } else { activeIndex = 3; hold = true; }
  } else if (created) {
    const elapsedMin = Math.max(0, (Date.now() - created.getTime()) / 60000);
    if (elapsedMin >= 15) { activeIndex = 3; hold = true; }
    else if (elapsedMin >= 10) { activeIndex = 2; }
    else if (elapsedMin >= 5) { activeIndex = 1; }
  }
  const progressPct = Math.min(100, Math.round((activeIndex / 3) * 100));
  const statusHeadline = hold ? 'On Hold' : (tr.status || 'In progress');
  const statusMessage = hold ? 'On Hold' : (tr.status_message || 'In progress');
  return { activeIndex, hold, progressPct, statusHeadline, statusMessage };
}

function getSupabaseAdmin() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
  );
}

async function requireAdmin(req) {
  const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'dfsworldwide.info@gmail.com').toLowerCase();
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    const e = new Error('Unauthorized');
    e.statusCode = 401;
    throw e;
  }

  const supabaseAuth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });

  const { data: userData, error: userErr } = await supabaseAuth.auth.getUser();
  if (userErr || !userData?.user) {
    const e = new Error(userErr?.message || 'Unauthorized');
    e.statusCode = 401;
    throw e;
  }

  const email = (userData.user.email || '').toLowerCase();
  if (email !== ADMIN_EMAIL) {
    const e = new Error('Forbidden');
    e.statusCode = 403;
    throw e;
  }

  return { token, user: userData.user };
}

function parseMoney(val) {
  if (val === undefined || val === null || val === '') return null;
  const n = Number(val);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function computeAmountFromSummary(summaryPrices) {
  // Business rule: only slot 5 and 6 are payable by the user.
  // Slots 1-4 are considered already paid.
  const v5 = summaryPrices[4];
  const v6 = summaryPrices[5];
  const total = (Number.isFinite(v5) ? v5 : 0) + (Number.isFinite(v6) ? v6 : 0);
  return Math.round(total * 100) / 100;
}

function extractSummaryFromBody(body) {
  const b = body || {};
  const titles = [1, 2, 3, 4, 5, 6].map((i) => b[`summary_title_${i}`]);
  const subtitles = [1, 2, 3, 4, 5, 6].map((i) => b[`summary_subtitle_${i}`]);
  const prices = [1, 2, 3, 4, 5, 6].map((i) => parseMoney(b[`summary_${i}_price`]));

  const anyFilled = titles.some((t) => String(t || '').trim() !== '') || prices.some((p) => p !== null) || subtitles.some((s) => String(s || '').trim() !== '');
  const amount = computeAmountFromSummary(prices.map((p) => (p === null ? 0 : p)));

  const summaryPayload = {};
  for (let i = 1; i <= 6; i++) {
    const t = titles[i - 1];
    const st = subtitles[i - 1];
    const pr = prices[i - 1];
    if (t !== undefined) summaryPayload[`summary_title_${i}`] = (t === null ? null : String(t).trim()) || null;
    if (st !== undefined) summaryPayload[`summary_subtitle_${i}`] = (st === null ? null : String(st).trim()) || null;
    if (b[`summary_${i}_price`] !== undefined) summaryPayload[`summary_${i}_price`] = pr;
  }

  return { anyFilled, amount, summaryPayload };
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const action = (req.query._action || '').toString();
    if (action === 'list') {
      try {
        await requireAdmin(req);
        const q = (req.query.q || '').toString().trim();
        const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
        const supabase = getSupabaseAdmin();

        let query = supabase
          .from('tracking')
          .select('tracking_id, recipient_email, recipient_name, created_at, amount, status, delivery_date')
          .order('created_at', { ascending: false })
          .limit(limit);

        if (q) {
          const like = `%${q}%`;
          query = query.or(`tracking_id.ilike.${like},recipient_email.ilike.${like}`);
        }

        const { data, error } = await query;
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ items: data || [] });
      } catch (e) {
        return res.status(e.statusCode || 500).json({ error: e?.message || 'Failed' });
      }
    }

    const tid = (req.query.tid || req.query.id || '').toString().trim();
    if (!tid) return res.status(400).json({ error: 'Missing tid' });
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from('tracking')
      .select('*')
      .ilike('tracking_id', tid)
      .single();
    if (error) return res.status(404).json({ error: 'Tracking ID not found' });

    const stage = computeStage(data);

    // Auto-correct amount on read to ensure payable total follows the slot 5-6 rule.
    try {
      const p5 = parseMoney(data?.summary_5_price);
      const p6 = parseMoney(data?.summary_6_price);
      const computed = computeAmountFromSummary([0, 0, 0, 0, p5 === null ? 0 : p5, p6 === null ? 0 : p6]);
      const existing = (data?.amount === null || data?.amount === undefined || data?.amount === '') ? null : Number(data.amount);
      const existingNum = (existing !== null && Number.isFinite(existing)) ? Math.round(existing * 100) / 100 : null;
      if (existingNum === null || Math.abs(existingNum - computed) > 0.001) {
        await supabase.from('tracking').update({ amount: computed }).eq('tracking_id', data.tracking_id);
        data.amount = computed;
      }
    } catch (_) {}

    // Persist hold status so admin dashboard reflects it (was previously frontend-only).
    // Avoid overriding a terminal status like delivered.
    try {
      const currentStatus = String(data?.status || '').toLowerCase().trim();
      const isDelivered = currentStatus === 'delivered' || currentStatus === 'success' || currentStatus === 'completed';
      const isHold = currentStatus === 'hold' || currentStatus === 'on hold' || currentStatus === 'on_hold';
      if (stage?.hold && !isDelivered && !isHold) {
        await supabase
          .from('tracking')
          .update({ status: 'hold', status_message: 'On Hold' })
          .eq('tracking_id', data.tracking_id);
        data.status = 'hold';
        data.status_message = 'On Hold';
      }
    } catch (_) {}

    return res.status(200).json({ tracking: data, stage });
  }

  const action = (req.query._action || '').toString();
  if (action === 'update') {
    if (req.method !== 'POST' && req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed' });
    try {
      await requireAdmin(req);
      const tracking_id = String(req.body?.tracking_id || req.body?.tid || '').trim();
      if (!tracking_id) return res.status(400).json({ error: 'Missing tracking_id' });

      const { anyFilled, amount, summaryPayload } = extractSummaryFromBody(req.body || {});
      if (!anyFilled) return res.status(400).json({ error: 'At least one summary item is required' });

      const supabaseAdmin = getSupabaseAdmin();
      const { data, error } = await supabaseAdmin
        .from('tracking')
        .update({ ...summaryPayload, amount })
        .eq('tracking_id', tracking_id)
        .select('tracking_id')
        .single();

      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true, tracking_id: data?.tracking_id || tracking_id, amount });
    } catch (e) {
      return res.status(e.statusCode || 500).json({ error: e?.message || 'Failed' });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { user } = await requireAdmin(req);

  // Validate required fields from body
  const {
    from: fromField,
    to: toField,
    port1, port2, port3, port4,
    sender_fullname, shipment_description,
    status, status_message,
    recipient_name, recipient_address, recipient_email,
    delivery_date
  } = req.body || {};

  const required = {
    from: fromField, to: toField, port1, port2, port3, port4, status, status_message,
    recipient_name, recipient_address, recipient_email, delivery_date, sender_fullname, shipment_description
  };
  const missing = Object.entries(required)
    .filter(([k, v]) => v === undefined || v === null || (typeof v === 'string' && v.trim() === ''))
    .map(([k]) => k);
  if (missing.length) {
    return res.status(400).json({ error: 'Missing required fields', missing });
  }

  // basic date validation
  const d = new Date(delivery_date);
  if (isNaN(d.getTime())) {
    return res.status(400).json({ error: 'Invalid delivery_date' });
  }

  // basic email validation
  const emailOk = typeof recipient_email === 'string' && /[^\s@]+@[^\s@]+\.[^\s@]+/.test(recipient_email);
  if (!emailOk) {
    return res.status(400).json({ error: 'Invalid recipient_email' });
  }

  const tracking_id = generateTrackingId();
  const supabaseAdmin = getSupabaseAdmin();

  const { anyFilled, amount: computedAmount, summaryPayload } = extractSummaryFromBody(req.body || {});
  if (!anyFilled) {
    return res.status(400).json({ error: 'At least one summary item is required' });
  }

  let persisted = true;
  let persistError = null;
  try {
    // Expect a table named "tracking" with columns including:
    // tracking_id text, created_by uuid, from_location text, to_location text,
    // port1 text, port2 text, port3 text, port4 text,
    // status text, status_message text, recipient_name text, recipient_address text,
    // delivery_date timestamptz/date, created_at timestamptz default now()
    const { error: insErr } = await supabaseAdmin
      .from('tracking')
      .insert({
        tracking_id,
        created_by: user.id,
        from_location: String(fromField).trim(),
        to_location: String(toField).trim(),
        port1: String(port1).trim(),
        port2: String(port2).trim(),
        port3: String(port3).trim(),
        port4: String(port4).trim(),
        status: String(status).trim(),
        status_message: String(status_message).trim(),
        recipient_name: String(recipient_name).trim(),
        recipient_address: String(recipient_address).trim(),
        recipient_email: String(recipient_email).trim(),
        shipment_description: String(shipment_description).trim(),
        sender_fullname: String(sender_fullname).trim(),
        delivery_date: d.toISOString(),
        ...summaryPayload,
        amount: computedAmount
      });
    if (insErr) { persisted = false; persistError = insErr.message; }
  } catch (e) {
    persisted = false;
    persistError = e?.message || 'Unknown error';
  }

  if (persisted) {
    try {
      const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost:3000";
      const proto = req.headers["x-forwarded-proto"] || (host.includes("localhost") ? "http" : "https");
      const base = "https://dfsworldwidetracking.online";
      const trackUrl = `${base}/tracking?tid=${encodeURIComponent(tracking_id)}`;
      const firstName = String(recipient_name || "").trim().split(/\s+/)[0] || "Customer";
      const prettyDate = new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
      const logoUrl = process.env.MAIL_LOGO_URL || `${base}/assets/images/logo.png`;
      const bannerUrl = "https://dfsworldwidetracking.online/assets/images/mail_banner.png";

      const subject = `Your shipment with tracking number: ${tracking_id}`;
      const statusLine = (String(status_message || "").trim()) || "Just one more check point! your shipment arrives to you soon.";
      const text = `Hi ${firstName},\n\nYour shipment with tracking number: ${tracking_id}.\n\n${statusLine}\n\nYour Shipment Details:\n\nRecipient address: ${String(recipient_address).trim()}\nRecipient name: ${String(recipient_name).trim()}\nDescription: ${String(shipment_description).trim()}\nTracking number: ${tracking_id}\nEstimated delivery: ${prettyDate}\n\nView details: ${trackUrl}\n\nContact centre,\nDFS LOG.`;

      const html = `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f8;padding:24px 0;margin:0;">
        <tr>
          <td align="center">
            <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;box-shadow:0 2px 6px rgba(0,0,0,0.06);overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
              <tr>
                <td style="padding:20px 24px;">
                  <div style="display:flex;align-items:center;gap:12px;">
                    ${logoUrl ? `<img src="${logoUrl}" alt="DFS Worldwide" style="height:28px;display:block;"/>` : `<strong style="font-size:18px;color:#0f172a;">DFS Worldwide</strong>`}
                  </div>
                </td>
              </tr>
              <tr>
                <td style="padding:24px 24px 8px; font-size:15px; line-height:1.65;">
                  <p style="margin:0 0 12px 0;">Hi ${firstName},</p>
                  <p style="margin:0 0 8px 0;">Your shipment with</p>
                  <p style="margin:0 0 16px 0;">tracking number: <strong>${tracking_id}</strong></p>
                  <p style="margin:0 0 16px 0;">Just one more check point! your shipment arrives to you soon.</p>

                  <p style="margin:16px 0 8px 0;"><strong>Your Shipment Details:</strong></p>
                  <p style="margin:0 0 8px 0;"><strong>Recipient address:</strong> ${String(recipient_address).trim()}</p>
                  <p style="margin:0 0 8px 0;"><strong>Recipient name:</strong> ${String(recipient_name).trim()}</p>
                  <p style="margin:0 0 8px 0;"><strong>Description:</strong> ${String(shipment_description).trim()}</p>
                  <p style="margin:0 0 16px 0;"><strong>Tracking number</strong><br/>${tracking_id}</p>
                  <p style="margin:0 0 24px 0;">Estimated delivery: ${prettyDate}</p>
                   <tr>
                <td style="padding:0 24px 24px;color:#374151;font-size:13px;">
                  <p style="margin:12px 0 0 0;">Contact centre,<br/>DFS LOG.</p>
                </td>
              </tr>
                  <div style="margin:20px 0 28px; text-align: center; border-top: 5px solid #212352; padding-top: 20px;">
                    <a href="${trackUrl}" style="display:inline-block;background:#f59e0b;color:#111827;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600;border:1px solid #d97706;">See more details ›</a>
                  </div>
                </td>
              </tr>
              ${bannerUrl ? `
              <tr>
                <td style="padding:0 24px 24px;">
                  <img src="${bannerUrl}" alt="Shipping worldwide" style="width:100%;height:auto;border-radius:6px;display:block;"/>
                </td>
              </tr>` : ``}
             
            </table>
          </td>
        </tr>
      </table>`;

      await sendMail({ to: String(recipient_email).trim(), subject, text, html });
    } catch (_mailErr) {}
  }

  return res.status(200).json({ tracking_id, persisted, warning: persisted ? undefined : persistError });
}

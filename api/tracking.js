import { createClient } from "@supabase/supabase-js";
import { sendMail } from "./_lib/mailer.js";

function generateTrackingId() {
  const pad = (n)=> String(n).padStart(2,'0');
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
  const rand = Math.random().toString(36).slice(2,8).toUpperCase();
  return `DFS-${stamp}-${rand}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'dfsworldwide.info@gmail.com').toLowerCase();
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const supabaseAuth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });

  const { data: userData, error: userErr } = await supabaseAuth.auth.getUser();
  if (userErr || !userData?.user) return res.status(401).json({ error: userErr?.message || 'Unauthorized' });

  const email = (userData.user.email || '').toLowerCase();
  if (email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Forbidden' });

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
  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
  );

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
        created_by: userData.user.id,
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
        delivery_date: d.toISOString()
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

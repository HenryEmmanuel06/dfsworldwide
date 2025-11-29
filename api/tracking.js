import { createClient } from "@supabase/supabase-js";

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
    status, status_message,
    recipient_name, recipient_address, recipient_email,
    delivery_date
  } = req.body || {};

  const required = {
    from: fromField, to: toField, port1, port2, port3, port4, status, status_message,
    recipient_name, recipient_address, recipient_email, delivery_date
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
        delivery_date: d.toISOString()
      });
    if (insErr) { persisted = false; persistError = insErr.message; }
  } catch (e) {
    persisted = false;
    persistError = e?.message || 'Unknown error';
  }

  return res.status(200).json({ tracking_id, persisted, warning: persisted ? undefined : persistError });
}

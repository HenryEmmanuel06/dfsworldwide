import { createClient } from "@supabase/supabase-js";
import { sendTitanMail } from "./_lib/titanMailer.js";

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderBodyHtml(body) {
  const safe = escapeHtml(body || "");
  // Preserve new lines for textarea input
  return safe.replace(/\r\n|\r|\n/g, "<br/>");
}

function buildTemplate({ subject, body }) {
  const base = "https://dfsworldwidetracking.online";
  const headerBg = `${base}/assets/images/Frame%2053.png`;
  const headerLogo = `${base}/assets/images/Group%201000002693.png`;

  const facebook = `${base}/assets/images/akar-icons_facebook-fill.png`;
  const twitter = `${base}/assets/images/prime_twitter.png`;
  const linkedin = `${base}/assets/images/fa-brands_linkedin.png`;
  const instagram = `${base}/assets/images/Group.png`;

  const bodyHtml = renderBodyHtml(body);
  const safeSubject = escapeHtml(subject || "");

  const text = `${subject || ""}\n\n${body || ""}\n\nFollow us on all platform for latest update`;

  const html = `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f8;padding:24px 0;margin:0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;box-shadow:0 2px 6px rgba(0,0,0,0.06);overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#111827;">
          <tr>
            <td style="padding:0;">
              <div style="position:relative;background:#ffffff;">
                <img src="${headerBg}" alt="Header" style="width:100%;height:auto;display:block;" />
                <img src="${headerLogo}" alt="Logo" style="position:absolute;left:18px;top:14px;width:210px;max-width:60%;height:auto;" />
              </div>
            </td>
          </tr>

          <tr>
            <td style="padding:22px 24px 10px;">
              <div style="font-size:18px; font-weight:700; color:#0f172a; margin:0;">${safeSubject}</div>
            </td>
          </tr>

          <tr>
            <td style="padding:0 24px 24px; font-size:14px; line-height:1.7; color:#111827;">
              <div>${bodyHtml}</div>
            </td>
          </tr>

          <tr>
            <td style="background:#0b0b0b;color:#ffffff;text-align:center;padding:18px 18px;">
              <div style="font-size:12px; opacity:0.9; margin-bottom:12px;">Follow us on all platform for latest update</div>
              <div style="display:inline-flex; gap:14px; align-items:center; justify-content:center;">
                <img src="${facebook}" alt="Facebook" style="width:20px;height:20px;display:block;" />
                <img src="${instagram}" alt="Instagram" style="width:20px;height:20px;display:block;" />
                <img src="${twitter}" alt="X" style="width:20px;height:20px;display:block;" />
                <img src="${linkedin}" alt="LinkedIn" style="width:20px;height:20px;display:block;" />
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`;

  return { html, text };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "dfsworldwide.info@gmail.com").toLowerCase();
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  const supabaseAuth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: userData, error: userErr } = await supabaseAuth.auth.getUser();
  if (userErr || !userData?.user) return res.status(401).json({ error: userErr?.message || "Unauthorized" });

  const email = (userData.user.email || "").toLowerCase();
  if (email !== ADMIN_EMAIL) return res.status(403).json({ error: "Forbidden" });

  const { to, subject, body } = req.body || {};

  const toOk = typeof to === "string" && /[^\s@]+@[^\s@]+\.[^\s@]+/.test(to.trim());
  if (!toOk) return res.status(400).json({ error: "Invalid to" });

  const subjectOk = typeof subject === "string" && subject.trim().length > 0;
  if (!subjectOk) return res.status(400).json({ error: "Missing subject" });

  const bodyOk = typeof body === "string" && body.trim().length > 0;
  if (!bodyOk) return res.status(400).json({ error: "Missing body" });

  const tpl = buildTemplate({ subject: subject.trim(), body: body.trim() });

  try {
    const info = await sendTitanMail({
      to: to.trim(),
      subject: subject.trim(),
      text: tpl.text,
      html: tpl.html,
    });

    return res.status(200).json({ ok: true, messageId: info?.messageId || null });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Email send failed" });
  }
}

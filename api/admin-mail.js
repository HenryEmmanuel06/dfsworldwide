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
  const headerBg = `${base}/assets/images/email-bg.png`;
  const headerLogo = `${base}/assets/images/email-logo.png`;

  const facebook = `${base}/assets/images/akar-icons_facebook-fill.png`;
  const twitter = `${base}/assets/images/prime_twitter.png`;
  const linkedin = `${base}/assets/images/fa-brands_linkedin.png`;
  const instagram = `${base}/assets/images/Group.png`;

  const bodyHtml = renderBodyHtml(body);
  const safeSubject = escapeHtml(subject || "");

  const text = `${subject || ""}\n\n${body || ""}\n\nFollow us on all platform for latest update`;

  const html = `<!DOCTYPE html>
<html lang="en" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light only" />
  <meta name="supported-color-schemes" content="light only" />
  <style>
    :root { color-scheme: light only; }
    /* Force footer black bg + white text in Gmail dark mode */
    [data-ogsc] .dfs-footer { background-color: #0b0b0b !important; color: #ffffff !important; }
    [data-ogsb] .dfs-footer { background-color: #0b0b0b !important; }
    [data-ogsc] .dfs-footer-text { color: #ffffff !important; }
    u + .dfs-email-body .dfs-footer { background-color: #0b0b0b !important; color: #ffffff !important; }
    u + .dfs-email-body .dfs-footer-text { color: #ffffff !important; }
    /* iOS/Apple Mail dark mode */
    @media (prefers-color-scheme: dark) {
      .dfs-footer { background-color: #0b0b0b !important; color: #ffffff !important; }
      .dfs-footer-text { color: #ffffff !important; }
    }
  </style>
</head>
<body class="dfs-email-body" style="margin:0;padding:0;background:#f7f7f8;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f8;padding:24px 0;margin:0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;box-shadow:0 2px 6px rgba(0,0,0,0.06);overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#111827;">
          <tr>
            <td background="${headerBg}" style="padding:0;background-image:url('${headerBg}');background-repeat:no-repeat;background-position:center top;background-size:cover;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:20px 24px 140px;">
                    <img src="${headerLogo}" alt="Logo" style="width:210px;max-width:60%;height:auto;display:block;" />
                  </td>
                </tr>
              </table>
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
            <td class="dfs-footer" bgcolor="#0b0b0b" style="background:#0b0b0b !important;background-color:#0b0b0b !important;color:#ffffff;text-align:center;padding:30px 18px 36px;">
              <div class="dfs-footer-text" style="font-size:12px;color:#ffffff !important;opacity:0.9;margin-bottom:20px;">Follow us on all platform for latest update</div>
              <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:0 16px;"><img src="${facebook}" alt="Facebook" style="width:22px;height:22px;display:block;" /></td>
                  <td style="padding:0 16px;"><img src="${instagram}" alt="Instagram" style="width:22px;height:22px;display:block;" /></td>
                  <td style="padding:0 16px;"><img src="${twitter}" alt="X" style="width:22px;height:22px;display:block;" /></td>
                  <td style="padding:0 16px;"><img src="${linkedin}" alt="LinkedIn" style="width:22px;height:22px;display:block;" /></td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

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

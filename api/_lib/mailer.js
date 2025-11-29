import nodemailer from "nodemailer";

let transporter = null;

export async function getTransporter() {
  if (transporter) return transporter;

  try { await import('dotenv/config'); } catch (_) {}

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || "465");
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const secure = port === 465;

  if (!host || !user || !pass) {
    throw new Error("Missing SMTP configuration");
  }

  const primary = { host, port, secure, auth: { user, pass } };
  let t = nodemailer.createTransport(primary);
  try {
    await t.verify();
    try { console.log(`SMTP OK: ${host}:${port} secure=${secure}`); } catch (_) {}
    transporter = t;
    return transporter;
  } catch (e1) {
    try { console.error("SMTP verify failed (primary):", e1?.message || e1); } catch (_) {}
  }

  if (host === 'smtp.gmail.com' && port !== 587) {
    const gmail587 = { host, port: 587, secure: false, auth: { user, pass } };
    t = nodemailer.createTransport(gmail587);
    try {
      await t.verify();
      try { console.log("SMTP OK fallback: smtp.gmail.com:587 secure=false"); } catch (_) {}
      transporter = t;
      return transporter;
    } catch (e2) {
      try { console.error("SMTP verify failed (587 fallback):", e2?.message || e2); } catch (_) {}
    }
  }

  if (host === 'smtp.gmail.com') {
    t = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
    try {
      await t.verify();
      try { console.log("SMTP OK fallback: service=gmail"); } catch (_) {}
      transporter = t;
      return transporter;
    } catch (e3) {
      try { console.error("SMTP verify failed (service=gmail):", e3?.message || e3); } catch (_) {}
    }
  }

  transporter = nodemailer.createTransport(primary);
  return transporter;
}

export async function sendMail({ to, subject, text, html, from }) {
  const tx = await getTransporter();
  const fromAddress = from || process.env.FROM_EMAIL || process.env.SMTP_USER;
  try {
    const info = await tx.sendMail({
      from: fromAddress,
      to,
      subject,
      text,
      html,
    });
    try {
      console.log("Email sent:", info?.messageId || info);
    } catch (_) {}
    return info;
  } catch (e) {
    try {
      console.error("Email send failed:", e?.message || e);
    } catch (_) {}
    throw e;
  }
}

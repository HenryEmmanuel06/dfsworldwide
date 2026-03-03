import nodemailer from "nodemailer";

let transporter = null;

function normalizeEnvValue(v) {
  if (v === undefined || v === null) return v;
  const s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

export async function getTitanTransporter() {
  if (transporter) return transporter;

  try { await import('dotenv/config'); } catch (_) {}

  const host = normalizeEnvValue(process.env.TITAN_HOST);
  const port = Number(process.env.TITAN_PORT || "587");
  const user = normalizeEnvValue(process.env.TITAN_USER);
  const pass = normalizeEnvValue(process.env.TITAN_PASS);
  const secure = port === 465;

  if (!host || !user || !pass) {
    throw new Error("Missing TITAN SMTP configuration");
  }

  const primary = {
    host,
    port,
    secure,
    auth: { user, pass },
    authMethod: "LOGIN",
    ...(secure
      ? {}
      : {
          requireTLS: true,
          tls: {
            servername: host,
          },
        }),
  };

  let t = nodemailer.createTransport(primary);
  try {
    await t.verify();
    transporter = t;
    return transporter;
  } catch (e1) {
    try {
      console.error(`TITAN SMTP verify failed: ${host}:${port} secure=${secure} user=${user}`);
      console.error(e1?.message || e1);
    } catch (_) {}
  }

  if (port === 587) {
    const relaxedTls = {
      host,
      port,
      secure: false,
      auth: { user, pass },
      authMethod: "LOGIN",
      requireTLS: true,
      tls: {
        servername: host,
        rejectUnauthorized: false,
      },
    };
    t = nodemailer.createTransport(relaxedTls);
    try {
      await t.verify();
      transporter = t;
      return transporter;
    } catch (e2) {
      try {
        console.error(`TITAN SMTP verify failed (TLS relaxed): ${host}:${port} user=${user}`);
        console.error(e2?.message || e2);
      } catch (_) {}
    }
  }

  // Some Titan mailboxes require implicit TLS on 465 even if 587 is configured.
  if (port !== 465) {
    const ssl465 = {
      host,
      port: 465,
      secure: true,
      auth: { user, pass },
      authMethod: "LOGIN",
      tls: {
        servername: host,
      },
    };
    t = nodemailer.createTransport(ssl465);
    try {
      await t.verify();
      transporter = t;
      return transporter;
    } catch (e3) {
      try {
        console.error(`TITAN SMTP verify failed (465 ssl fallback): ${host}:465 user=${user}`);
        console.error(e3?.message || e3);
      } catch (_) {}
    }
  }

  transporter = nodemailer.createTransport(primary);
  return transporter;
}

export async function sendTitanMail({ to, subject, text, html, from }) {
  const tx = await getTitanTransporter();
  const fromAddress = from || process.env.TITAN_FROM_EMAIL || process.env.TITAN_USER;

  const info = await tx.sendMail({
    from: fromAddress,
    to,
    subject,
    text,
    html,
  });

  return info;
}

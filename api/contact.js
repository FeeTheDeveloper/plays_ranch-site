const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_CONTACT_EMAIL = "contact@playsranch.com";
const DEFAULT_FROM_EMAIL = "Plays Ranch Programming <contact@playsranch.com>";
const MIN_FORM_AGE_MS = 2500;
const MAX_FORM_AGE_MS = 1000 * 60 * 60 * 6;
const RATE_LIMIT_WINDOW_MS = 1000 * 60 * 15;
const RATE_LIMIT_MAX = 5;

// Best-effort rate limiting for serverless environments.
const rateLimitStore = globalThis.__prpRateLimitStore || new Map();
globalThis.__prpRateLimitStore = rateLimitStore;

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeText(value, { maxLength, multiline = false } = {}) {
  const source = String(value || "").normalize("NFKC").replace(/\u0000/g, "");

  if (multiline) {
    const collapsed = source
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.trim().replace(/\s+/g, " "))
      .filter(Boolean)
      .join("\n");

    return collapsed.slice(0, maxLength);
  }

  return source.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];

  if (typeof forwarded === "string" && forwarded.length) {
    return forwarded.split(",")[0].trim();
  }

  return req.socket?.remoteAddress || "unknown";
}

function enforceRateLimit(ipAddress) {
  const now = Date.now();
  const existing = rateLimitStore.get(ipAddress);
  const recent = existing ? existing.filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS) : [];

  if (recent.length >= RATE_LIMIT_MAX) {
    rateLimitStore.set(ipAddress, recent);
    return false;
  }

  recent.push(now);
  rateLimitStore.set(ipAddress, recent);
  return true;
}

async function readRequestBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string") {
    return JSON.parse(req.body);
  }

  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function validateSubmission(payload) {
  const name = sanitizeText(payload.name, { maxLength: 120 });
  const email = sanitizeText(payload.email, { maxLength: 160 });
  const company = sanitizeText(payload.company, { maxLength: 160 });
  const message = sanitizeText(payload.message, { maxLength: 2500, multiline: true });
  const website = sanitizeText(payload.website, { maxLength: 200 });
  const submittedAt = Number(payload.submittedAt);

  if (website) {
    return { ok: false, spam: true };
  }

  if (!name || name.length < 2) {
    return { ok: false, error: "Enter your name." };
  }

  if (!email || !isValidEmail(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  if (!message || message.length < 20) {
    return { ok: false, error: "Share a bit more detail so PRP can respond properly." };
  }

  if (!Number.isFinite(submittedAt)) {
    return { ok: false, error: "Form session is invalid. Refresh and try again." };
  }

  const formAge = Date.now() - submittedAt;

  if (formAge < MIN_FORM_AGE_MS) {
    return { ok: false, error: "Please take a moment before submitting." };
  }

  if (formAge > MAX_FORM_AGE_MS) {
    return { ok: false, error: "Form session expired. Refresh and try again." };
  }

  return {
    ok: true,
    data: {
      name,
      email,
      company: company || "Not provided",
      message,
    },
  };
}

async function deliverEmail(submission) {
  const apiKey = process.env.RESEND_API_KEY;
  const contactEmail = process.env.CONTACT_EMAIL || DEFAULT_CONTACT_EMAIL;
  const fromEmail = process.env.RESEND_FROM_EMAIL || DEFAULT_FROM_EMAIL;

  if (!apiKey) {
    throw new Error("Email delivery is not configured.");
  }

  const submittedAt = new Date();
  const submittedAtLabel = submittedAt.toISOString();
  const subject = `New PRP contact request from ${submission.name}`;
  const text = [
    "Plays Ranch Programming Corporation LLC contact request",
    "",
    `Name: ${submission.name}`,
    `Email: ${submission.email}`,
    `Company: ${submission.company}`,
    `Submitted: ${submittedAtLabel}`,
    "",
    "Message:",
    submission.message,
  ].join("\n");

  const html = `
    <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #141414;">
      <h2 style="margin-bottom: 16px;">New PRP contact request</h2>
      <p><strong>Name:</strong> ${escapeHtml(submission.name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(submission.email)}</p>
      <p><strong>Company:</strong> ${escapeHtml(submission.company)}</p>
      <p><strong>Submitted:</strong> ${escapeHtml(submittedAtLabel)}</p>
      <p><strong>Message:</strong></p>
      <pre style="white-space: pre-wrap; font-family: Arial, sans-serif;">${escapeHtml(submission.message)}</pre>
    </div>
  `;

  const resendResponse = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [contactEmail],
      reply_to: submission.email,
      subject,
      text,
      html,
    }),
  });

  if (!resendResponse.ok) {
    const errorText = await resendResponse.text();
    throw new Error(`Resend request failed: ${errorText}`);
  }

  return resendResponse.json();
}

async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const ipAddress = getClientIp(req);

  if (!enforceRateLimit(ipAddress)) {
    sendJson(res, 429, { error: "Too many requests. Please wait a few minutes and try again." });
    return;
  }

  let payload;

  try {
    payload = await readRequestBody(req);
  } catch (error) {
    sendJson(res, 400, { error: "Invalid request payload." });
    return;
  }

  const validation = validateSubmission(payload);

  if (!validation.ok && validation.spam) {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!validation.ok) {
    sendJson(res, 400, { error: validation.error });
    return;
  }

  try {
    await deliverEmail(validation.data);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    console.error("Contact form delivery failed:", error);
    sendJson(res, 500, { error: "Delivery failed. Please try again or email contact@playsranch.com directly." });
  }
}

module.exports = handler;
module.exports.default = handler;

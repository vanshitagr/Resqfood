// Outbound notification channels: email, SMS and a generic push/webhook.
//
// Design rules:
//   1. In-app notification is written FIRST and is always the reliable base (see lib.js).
//      Everything here is best-effort delivery on top of it.
//   2. Every channel is opt-in through environment variables. With none configured the app
//      behaves exactly as before - no errors, no retries, no log noise.
//   3. Nothing here can ever reject or throw into a request: each send is fire-and-forget with
//      a timeout, and failures are logged without the provider key or the recipient's details.
//   4. API keys live only on the server. No provider credential is ever sent to the browser.
//
// Severity decides the channel mix, so people are not woken up for routine updates:
//   INFO   -> in-app + push/webhook
//   URGENT -> in-app + push/webhook + email + SMS   (time-critical: expiring, no match, expired)
const cfg = require('./config');

const has = (name) => !!process.env[name];
const emailEnabled = () => has('EMAIL_API_KEY') && has('EMAIL_FROM');
const smsEnabled = () => has('TWILIO_ACCOUNT_SID') && has('TWILIO_AUTH_TOKEN') && has('TWILIO_FROM');
const pushEnabled = () => has('NOTIFY_WEBHOOK_URL');

const enabledChannels = () => ({
  inApp: true,
  email: emailEnabled(),
  sms: smsEnabled(),
  push: pushEnabled(),
});

const timeout = (ms = 5000) => AbortSignal.timeout(ms);
// Logs the failure without the provider key, the message body or the recipient address.
const warn = (channel, err) => console.error(`[notify] ${channel} delivery failed: ${err.message}`);

// ----------------------------------------------------------------- email
// Supports Resend and SendGrid, both over plain HTTPS so there is no extra dependency.
async function sendEmail(to, subject, body) {
  const provider = (process.env.EMAIL_PROVIDER || 'resend').toLowerCase();
  const key = process.env.EMAIL_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (provider === 'sendgrid') {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from },
        subject,
        content: [{ type: 'text/plain', value: body }],
      }),
      signal: timeout(),
    });
    if (!res.ok) throw new Error(`sendgrid responded ${res.status}`);
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text: body }),
    signal: timeout(),
  });
  if (!res.ok) throw new Error(`resend responded ${res.status}`);
}

// ------------------------------------------------------------------- sms
async function sendSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
    // SMS is charged per segment, so urgent alerts are kept short.
    body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: body.slice(0, 300) }),
    signal: timeout(),
  });
  if (!res.ok) throw new Error(`twilio responded ${res.status}`);
}

// ------------------------------------------------------------------ push
// Generic webhook: forward to any push service, Slack bridge or internal queue.
async function sendPush(payload) {
  const res = await fetch(process.env.NOTIFY_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.NOTIFY_WEBHOOK_TOKEN ? { authorization: `Bearer ${process.env.NOTIFY_WEBHOOK_TOKEN}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: timeout(4000),
  });
  if (!res.ok) throw new Error(`webhook responded ${res.status}`);
}

/**
 * Best-effort fan-out. Returns the channel names that were attempted (recorded on the
 * notification row for the audit trail) and never throws.
 */
function dispatch({ user, type, message, donationId, severity }) {
  const attempted = ['inApp'];
  if (process.env.NODE_ENV === 'test') return attempted;

  const subject = `${cfg.APP_NAME}: ${SUBJECTS[type] || 'Update on your donation'}`;
  const link = process.env.PUBLIC_URL ? `\n\n${process.env.PUBLIC_URL}/#/donation/${donationId || ''}` : '';

  if (pushEnabled()) {
    attempted.push('push');
    sendPush({ to: user.email, phone: user.phone, name: user.name, type, severity, message, donationId })
      .catch((e) => warn('push', e));
  }
  if (severity === 'URGENT' && emailEnabled() && user.email) {
    attempted.push('email');
    sendEmail(user.email, subject, `Hi ${user.name},\n\n${message}${link}`).catch((e) => warn('email', e));
  }
  if (severity === 'URGENT' && smsEnabled() && user.phone) {
    attempted.push('sms');
    sendSms(user.phone, `${cfg.APP_NAME}: ${message}`).catch((e) => warn('sms', e));
  }
  return attempted;
}

const SUBJECTS = {
  MATCH: 'Your donation has been matched',
  NO_MATCH: 'No recipient found yet for your donation',
  ACCEPTED: 'A shelter confirmed your donation',
  TASK: 'A new pickup task is available',
  DRIVER: 'A driver has been assigned',
  PICKUP_SOON: 'Pickup is due soon',
  EXPIRING: 'Food is close to its usable time',
  PICKED_UP: 'Your donation has been collected',
  DELIVERED: 'Your donation has been delivered',
  EXPIRED: 'A donation expired before pickup',
  CANCELLED: 'A donation was cancelled',
};

// Time-critical events reach people outside the app; routine ones stay in-app.
const SEVERITY = {
  NO_MATCH: 'URGENT',
  PICKUP_SOON: 'URGENT',
  EXPIRING: 'URGENT',
  EXPIRED: 'URGENT',
  MATCH: 'INFO',
  ACCEPTED: 'INFO',
  TASK: 'INFO',
  DRIVER: 'INFO',
  PICKED_UP: 'INFO',
  DELIVERED: 'INFO',
  CANCELLED: 'INFO',
};

const severityOf = (type) => SEVERITY[type] || 'INFO';

module.exports = { dispatch, severityOf, enabledChannels, SEVERITY };

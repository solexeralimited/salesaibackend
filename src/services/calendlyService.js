// ── calendlyService.js ────────────────────────────────────────────────────────
// NOTE: field names in Calendly's available-times response (e.g. whether each
// slot includes its own scheduling_url) and the exact query-param behavior for
// deep-linking to a specific date on a scheduling page are based on Calendly's
// documented v2 API but have not been exercised against a live account from
// this environment (no network access to calendly.com here). Verify against a
// real Calendly account/plan before relying on this in production.
const axios = require('axios');
const crypto = require('crypto');
const { query } = require('../db');

const CALENDLY_API_BASE = 'https://api.calendly.com';

async function getCalendlyConfig(companyId) {
  const { rows: [company] } = await query(
    'SELECT calendly_api_token, calendly_event_type_uri, calendly_scheduling_url, calendly_webhook_signing_key FROM companies WHERE id = $1',
    [companyId]
  );
  return {
    apiToken: company?.calendly_api_token || process.env.CALENDLY_API_TOKEN,
    eventTypeUri: company?.calendly_event_type_uri || process.env.CALENDLY_EVENT_TYPE_URI,
    schedulingUrl: company?.calendly_scheduling_url || process.env.CALENDLY_SCHEDULING_URL,
    webhookSigningKey: company?.calendly_webhook_signing_key || process.env.CALENDLY_WEBHOOK_SIGNING_KEY,
  };
}

/**
 * Fetch the next available Calendly slots for a company's event type.
 * Calendly's available-times endpoint caps the start/end range at 7 days,
 * so this queries a single 7-day window and returns up to `count` slots.
 */
async function getAvailableSlots(companyId, count = 3) {
  const { apiToken, eventTypeUri } = await getCalendlyConfig(companyId);
  if (!apiToken || !eventTypeUri) {
    console.warn('Calendly not configured for company', companyId);
    return [];
  }

  const startTime = new Date();
  const endTime = new Date(startTime.getTime() + 7 * 24 * 60 * 60 * 1000);

  try {
    const res = await axios.get(`${CALENDLY_API_BASE}/event_type_available_times`, {
      params: {
        event_type: eventTypeUri,
        start_time: startTime.toISOString(),
        end_time: endTime.toISOString(),
      },
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    return (res.data?.collection || []).slice(0, count).map(slot => ({
      startTime: slot.start_time,
      schedulingUrl: slot.scheduling_url || null,
    }));
  } catch (err) {
    console.error('Calendly available-times error:', err.response?.data || err.message);
    return [];
  }
}

/**
 * Build a link for a suggested slot. Uses Calendly's own per-slot
 * scheduling_url when the API returns one (fast-tracks the invitee straight
 * to that time); otherwise falls back to the company's scheduling page
 * deep-linked to the slot's date only (Calendly's public booking-page query
 * params navigate to a date, not a pre-selected exact time).
 */
function buildSlotLink(slot, schedulingUrl) {
  if (slot.schedulingUrl) return slot.schedulingUrl;
  if (!schedulingUrl) return null;
  const date = new Date(slot.startTime);
  const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  const day = date.toISOString().split('T')[0];
  return `${schedulingUrl}?month=${month}&date=${day}`;
}

/**
 * Verify Calendly's webhook signature.
 * Header format: "t=<timestamp>,v1=<hmac_sha256_hex>"
 * Signed payload: "${t}.${rawBody}", HMAC-SHA256 with the webhook signing key.
 */
function verifyWebhookSignature(rawBody, signatureHeader, signingKey) {
  if (!signatureHeader || !signingKey) return false;
  const parts = Object.fromEntries(signatureHeader.split(',').map(p => p.split('=')));
  if (!parts.t || !parts.v1) return false;

  const signedPayload = `${parts.t}.${rawBody}`;
  const expected = crypto.createHmac('sha256', signingKey).update(signedPayload).digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(parts.v1, 'hex'));
  } catch {
    return false;
  }
}

module.exports = { getCalendlyConfig, getAvailableSlots, buildSlotLink, verifyWebhookSignature };

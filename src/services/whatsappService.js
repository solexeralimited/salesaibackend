// ── whatsappService.js ────────────────────────────────────────────────────────
const axios = require('axios');
const { query } = require('../db');

async function getWhatsAppCredentials(companyId) {
  const { rows: [company] } = await query(
    'SELECT whatsapp_phone_number_id, whatsapp_access_token FROM companies WHERE id = $1',
    [companyId]
  );
  const phoneNumberId = company?.whatsapp_phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = company?.whatsapp_access_token || process.env.WHATSAPP_ACCESS_TOKEN;
  return { phoneNumberId, accessToken };
}

async function sendWhatsApp(to, text, companyId) {
  const { phoneNumberId, accessToken } = await getWhatsAppCredentials(companyId);
  if (!phoneNumberId || !accessToken) {
    console.warn('WhatsApp not configured for company', companyId);
    return null;
  }
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      { messaging_product: 'whatsapp', to: to.replace('+', ''), type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    return res.data;
  } catch (err) {
    console.error('WhatsApp send error:', err.response?.data || err.message);
    throw err;
  }
}

async function sendWhatsAppTemplate(to, templateName, components, companyId) {
  const { phoneNumberId, accessToken } = await getWhatsAppCredentials(companyId);
  if (!phoneNumberId || !accessToken) {
    console.warn('WhatsApp not configured for company', companyId);
    return null;
  }
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to.replace('+', ''),
        type: 'template',
        template: { name: templateName, language: { code: 'en_US' }, components },
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );
    return res.data;
  } catch (err) {
    console.error('WhatsApp template error:', err.response?.data || err.message);
    throw err;
  }
}

module.exports = { sendWhatsApp, sendWhatsAppTemplate };

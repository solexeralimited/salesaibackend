// ── whatsappService.js ────────────────────────────────────────────────────────
const axios = require('axios');
const { query } = require('../db');

async function sendWhatsApp(to, text, companyId) {
  const { rows: [company] } = await query(
    'SELECT whatsapp_phone_number_id, whatsapp_access_token FROM companies WHERE id = $1',
    [companyId]
  );
  if (!company?.whatsapp_phone_number_id || !company?.whatsapp_access_token) {
    console.warn('WhatsApp not configured for company', companyId);
    return null;
  }
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v19.0/${company.whatsapp_phone_number_id}/messages`,
      { messaging_product: 'whatsapp', to: to.replace('+', ''), type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${company.whatsapp_access_token}`, 'Content-Type': 'application/json' } }
    );
    return res.data;
  } catch (err) {
    console.error('WhatsApp send error:', err.response?.data || err.message);
    throw err;
  }
}

async function sendWhatsAppTemplate(to, templateName, components, companyId) {
  const { rows: [company] } = await query(
    'SELECT whatsapp_phone_number_id, whatsapp_access_token FROM companies WHERE id = $1',
    [companyId]
  );
  if (!company?.whatsapp_phone_number_id) return null;
  try {
    const res = await axios.post(
      `https://graph.facebook.com/v19.0/${company.whatsapp_phone_number_id}/messages`,
      {
        messaging_product: 'whatsapp',
        to: to.replace('+', ''),
        type: 'template',
        template: { name: templateName, language: { code: 'en' }, components },
      },
      { headers: { Authorization: `Bearer ${company.whatsapp_access_token}`, 'Content-Type': 'application/json' } }
    );
    return res.data;
  } catch (err) {
    console.error('WhatsApp template error:', err.response?.data || err.message);
    throw err;
  }
}

module.exports = { sendWhatsApp, sendWhatsAppTemplate };

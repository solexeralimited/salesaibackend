// emailService.js
const axios = require('axios');
const { query } = require('../db');

async function sendEmail({ to, subject, text, html }, companyId) {
  const { rows: [company] } = await query(
    'SELECT sendgrid_api_key, from_email FROM companies WHERE id = $1',
    [companyId]
  );
  if (!company?.sendgrid_api_key) {
    console.warn('SendGrid not configured for company', companyId);
    return null;
  }
  try {
    await axios.post('https://api.sendgrid.com/v3/mail/send', {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: company.from_email || 'noreply@salesai.app' },
      subject,
      content: [
        ...(text ? [{ type: 'text/plain', value: text }] : []),
        ...(html ? [{ type: 'text/html', value: html }] : []),
      ],
    }, {
      headers: { Authorization: `Bearer ${company.sendgrid_api_key}`, 'Content-Type': 'application/json' },
    });
    return true;
  } catch (err) {
    console.error('Email send error:', err.response?.data || err.message);
    throw err;
  }
}

module.exports = { sendEmail };

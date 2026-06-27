const axios = require('axios');
const { query } = require('../db');

async function notifySlack(company, lead, message) {
  const webhookUrl = company.slack_webhook_url || process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return null;

  const tier = lead.interest_score >= 80 ? '🟢' : lead.interest_score >= 40 ? '🟡' : '🔴';
  const payload = {
    text: `*SalesAI Alert* — ${company.name}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${tier} ${lead.name}* — ${message}\nScore: *${lead.interest_score}* | Stage: *${lead.stage}*`,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'View Lead' },
            url: `${process.env.FRONTEND_URL}/leads/${lead.id}`,
          },
        ],
      },
    ],
  };

  try {
    await axios.post(webhookUrl, payload);
    return true;
  } catch (err) {
    console.error('Slack notification error:', err.message);
  }
}

module.exports = { notifySlack };

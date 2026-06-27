const express = require('express');
const crypto = require('crypto');
const { query } = require('../db');
const { generateAIReply } = require('../services/aiService');
const { sendWhatsApp } = require('../services/whatsappService');
const { calculateScore } = require('../services/scoringService');
const { notifySlack } = require('../services/slackService');

const router = express.Router();

// WhatsApp webhook verification (GET)
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('WhatsApp webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// WhatsApp inbound message (POST)
router.post('/whatsapp', async (req, res) => {
  // Always return 200 immediately to prevent WhatsApp retries
  res.sendStatus(200);

  try {
    const body = JSON.parse(req.body.toString());
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    if (!value?.messages?.length) return;

    const message = value.messages[0];
    const phoneNumber = message.from; // E.164 format
    const text = message.text?.body || '';
    const externalId = message.id;
    const phoneNumberId = value.metadata?.phone_number_id;

    // Find company by WhatsApp phone number ID
    const { rows: [company] } = await query(
      'SELECT * FROM companies WHERE whatsapp_phone_number_id = $1',
      [phoneNumberId]
    );
    if (!company) return console.error('No company found for phone_number_id:', phoneNumberId);

    // Find lead by phone number
    const { rows: [lead] } = await query(
      'SELECT * FROM leads WHERE company_id = $1 AND phone = $2',
      [company.id, `+${phoneNumber}`]
    );
    if (!lead) return console.log('No lead found for phone:', phoneNumber);

    // Find or create conversation
    let { rows: [conv] } = await query(
      'SELECT * FROM conversations WHERE lead_id = $1 AND channel = $2',
      [lead.id, 'whatsapp']
    );
    if (!conv) {
      const result = await query(
        'INSERT INTO conversations (lead_id, company_id, channel) VALUES ($1,$2,$3) RETURNING *',
        [lead.id, company.id, 'whatsapp']
      );
      conv = result.rows[0];
    }

    // Save inbound message
    await query(`
      INSERT INTO messages (conversation_id, company_id, direction, sender_type, content, channel, external_message_id)
      VALUES ($1,$2,'inbound','customer',$3,'whatsapp',$4)
    `, [conv.id, company.id, text, externalId]);

    await query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conv.id]);

    // Update interest score
    await calculateScore(lead, company.id);

    // AI auto-reply if AI mode is active
    if (conv.ai_active) {
      const { rows: history } = await query(
        'SELECT direction, sender_type, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 20',
        [conv.id]
      );
      const aiReply = await generateAIReply({ ...conv, lead_name: lead.name, interest_score: lead.interest_score }, history, company.id);

      await query(`
        INSERT INTO messages (conversation_id, company_id, direction, sender_type, content, channel)
        VALUES ($1,$2,'outbound','ai',$3,'whatsapp')
      `, [conv.id, company.id, aiReply]);

      await sendWhatsApp(`+${phoneNumber}`, aiReply, company.id);

      // Check escalation threshold
      if (lead.interest_score < company.ai_escalation_threshold) {
        await notifySlack(company, lead, `Score dropped to ${lead.interest_score} — escalation triggered`);
      }
    }
  } catch (err) {
    console.error('WhatsApp webhook error:', err);
  }
});

// Email inbound (SendGrid Inbound Parse)
router.post('/email', async (req, res) => {
  res.sendStatus(200);
  try {
    const { from, subject, text, to } = req.body;
    console.log('Email inbound from:', from, 'subject:', subject);
    // Implementation mirrors WhatsApp handler but for email channel
  } catch (err) {
    console.error('Email webhook error:', err);
  }
});

module.exports = router;

const express = require('express');
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
    console.log('WhatsApp webhook received:', JSON.stringify(body).substring(0, 300));

    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    if (!value?.messages?.length) {
      console.log('No messages in webhook payload');
      return;
    }

    const message = value.messages[0];
    const phoneNumber = message.from; // WhatsApp sends without +, e.g. 64273767460
    const text = message.text?.body || '';
    const externalId = message.id;
    const phoneNumberId = value.metadata?.phone_number_id;

    console.log(`Inbound WhatsApp from ${phoneNumber}: "${text}"`);

    // Find company by WhatsApp phone number ID
    const { rows: [company] } = await query(
      'SELECT * FROM companies WHERE whatsapp_phone_number_id = $1',
      [phoneNumberId]
    );
    if (!company) {
      console.error('No company found for phone_number_id:', phoneNumberId);
      return;
    }

    // Try multiple phone formats to find the lead
    const phoneFormats = [
      phoneNumber,                          // 64273767460
      `+${phoneNumber}`,                   // +64273767460
      phoneNumber.replace(/^64/, '0'),     // 0273767460 (NZ local)
      phoneNumber.replace(/^91/, '0'),     // 0XXXXXXXXXX (India local)
    ];

    let lead = null;
    for (const fmt of phoneFormats) {
      const { rows } = await query(
        'SELECT * FROM leads WHERE company_id = $1 AND phone = $2',
        [company.id, fmt]
      );
      if (rows[0]) { lead = rows[0]; break; }
    }

    // If no lead found, create one automatically from inbound
    if (!lead) {
      console.log(`No lead found for phone ${phoneNumber} — creating new lead`);
      const { rows: [newLead] } = await query(`
        INSERT INTO leads (company_id, name, phone, source, stage)
        VALUES ($1, $2, $3, 'whatsapp_inbound', 'replied') RETURNING *
      `, [company.id, `WhatsApp ${phoneNumber}`, `+${phoneNumber}`]);
      lead = newLead;

      await query(
        'INSERT INTO conversations (lead_id, company_id, channel) VALUES ($1,$2,$3)',
        [lead.id, company.id, 'whatsapp']
      );
    }

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
    console.log(`Saving inbound message: conv=${conv.id} company=${company.id} text="${text}" extId=${externalId}`);
    try {
      const insertResult = await query(`
        INSERT INTO messages (conversation_id, company_id, direction, sender_type, content, channel, external_message_id)
        VALUES ($1,$2,'inbound','customer',$3,'whatsapp',$4)
        RETURNING id
      `, [conv.id, company.id, text, externalId]);
      console.log(`Inbound message saved with id=${insertResult.rows[0]?.id}`);
    } catch (insertErr) {
      console.error(`Inbound INSERT failed: ${insertErr.message}`);
    }

    await query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conv.id]);
    await query(
      `UPDATE leads SET stage = 'replied', updated_at = NOW() WHERE id = $1 AND stage = 'contacted'`,
      [lead.id]
    );

    console.log(`Saved inbound message from ${lead.name}`);

    // Update interest score
    await calculateScore(lead, company.id);

    // AI auto-reply if AI mode is active
    if (conv.ai_active) {
      const { rows: history } = await query(
        'SELECT direction, sender_type, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 20',
        [conv.id]
      );

      const aiReply = await generateAIReply(
        { ...conv, lead_name: lead.name, interest_score: lead.interest_score },
        history,
        company.id
      );

      await query(`
        INSERT INTO messages (conversation_id, company_id, direction, sender_type, content, channel)
        VALUES ($1,$2,'outbound','ai',$3,'whatsapp')
      `, [conv.id, company.id, aiReply]);

      await query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [conv.id]);

      await sendWhatsApp(`+${phoneNumber}`, aiReply, company.id);
      console.log(`AI replied to ${lead.name}: ${aiReply.substring(0, 60)}`);

      // Notify if score is below escalation threshold
      if (lead.interest_score < company.ai_escalation_threshold) {
        await notifySlack(company, lead, `Score dropped to ${lead.interest_score} — escalation triggered`);
      }
    }
  } catch (err) {
    console.error('WhatsApp webhook error:', err.message, err.stack);
  }
});

// Email inbound (SendGrid Inbound Parse)
router.post('/email', async (req, res) => {
  res.sendStatus(200);
  try {
    const { from, subject, text } = req.body;
    console.log('Email inbound from:', from, 'subject:', subject);
  } catch (err) {
    console.error('Email webhook error:', err);
  }
});

module.exports = router;

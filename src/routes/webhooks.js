const express = require('express');
const { query } = require('../db');
const { generateAIReply } = require('../services/aiService');
const { sendWhatsApp, sendWhatsAppInteractiveButtons } = require('../services/whatsappService');
const { calculateScore } = require('../services/scoringService');
const { notifySlack } = require('../services/slackService');
const { triggerWorkflow } = require('../services/workflowService');
const { getCalendlyConfig, getAvailableSlots, buildSlotLink, verifyWebhookSignature } = require('../services/calendlyService');

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
    const isButtonReply = message.type === 'button'; // approved template quick-reply
    const isInteractiveReply = message.type === 'interactive' && message.interactive?.type === 'button_reply'; // our own session-window buttons (e.g. slot picker)
    const interactiveReplyId = isInteractiveReply ? message.interactive.button_reply.id : null;
    const text = isButtonReply ? (message.button?.text || '')
      : isInteractiveReply ? (message.interactive.button_reply.title || '')
      : (message.text?.body || '');
    const externalId = message.id;
    const phoneNumberId = value.metadata?.phone_number_id;

    console.log(`Inbound WhatsApp from ${phoneNumber} (${isButtonReply || isInteractiveReply ? 'button' : 'text'}): "${text}"`);

    // Find company by WhatsApp phone number ID, falling back to env var match
    let { rows: [company] } = await query(
      'SELECT * FROM companies WHERE whatsapp_phone_number_id = $1',
      [phoneNumberId]
    );
    if (!company && phoneNumberId === process.env.WHATSAPP_PHONE_NUMBER_ID) {
      // DB column not yet populated but env var matches — use first company
      const { rows } = await query('SELECT * FROM companies LIMIT 1');
      company = rows[0];
    }
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
        'INSERT INTO conversations (lead_id, company_id, channel, ai_active) VALUES ($1,$2,$3,true)',
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
        'INSERT INTO conversations (lead_id, company_id, channel, ai_active) VALUES ($1,$2,$3,true) RETURNING *',
        [lead.id, company.id, 'whatsapp']
      );
      conv = result.rows[0];
    }

    // For button replies, store a self-describing message so both the AI
    // and the human-facing conversation view show it was a quick-reply tap,
    // not free-form text — otherwise the AI sees e.g. "Ask questions" as if
    // it were the customer's entire message, with no context that it came
    // from the quote_ready template's button menu.
    const messageContent = (isButtonReply || isInteractiveReply) ? `[Tapped quick-reply: "${text}"]` : text;

    // Save inbound message
    console.log(`Saving inbound message: conv=${conv.id} company=${company.id} text="${messageContent}" extId=${externalId}`);
    try {
      const insertResult = await query(`
        INSERT INTO messages (conversation_id, company_id, direction, sender_type, content, channel, external_message_id)
        VALUES ($1,$2,'inbound','customer',$3,'whatsapp',$4)
        RETURNING id
      `, [conv.id, company.id, messageContent, externalId]);
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

    // Set when we've already sent a purpose-built reply for this inbound
    // message (e.g. the meeting-slot picker), so the generic AI auto-reply
    // below doesn't also fire and double-message the lead.
    let skipAiAutoReply = false;

    // Handle quick reply button actions from the quote_ready template
    if (isButtonReply) {
      if (text === 'Accept your quote') {
        await query(
          `UPDATE quotes SET status = 'accepted', updated_at = NOW()
           WHERE id = (SELECT id FROM quotes WHERE lead_id = $1 AND status IN ('pending','sent') ORDER BY created_at DESC LIMIT 1)`,
          [lead.id]
        );
        await triggerWorkflow('quote_accepted', lead, company.id);
        // Hand ownership to the lead's assigned rep so someone is
        // accountable for closing — doesn't touch ai_active, so the AI can
        // still handle any follow-up questions in the meantime.
        if (lead.assigned_to) {
          await query(
            `UPDATE conversations SET escalated_to = $2, escalated_at = NOW() WHERE id = $1`,
            [conv.id, lead.assigned_to]
          );
        }
      } else if (text === 'Book a meeting') {
        await query(
          `UPDATE leads SET stage = 'meeting', updated_at = NOW() WHERE id = $1`,
          [lead.id]
        );
        await triggerWorkflow('meeting_requested', lead, company.id);

        const slots = await getAvailableSlots(company.id, 3);
        const { schedulingUrl } = await getCalendlyConfig(company.id);

        if (slots.length > 0) {
          const slotOptions = slots.map(slot => ({
            link: buildSlotLink(slot, schedulingUrl),
            label: new Date(slot.startTime).toLocaleString('en-US', {
              weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: company.timezone || 'Pacific/Auckland',
            }),
          }));

          await query(`UPDATE conversations SET pending_slots = $2::jsonb WHERE id = $1`, [conv.id, JSON.stringify(slotOptions)]);

          await sendWhatsAppInteractiveButtons(
            `+${phoneNumber}`,
            `Here are a few times that work — tap one, or see everything here: ${schedulingUrl || ''}`,
            slotOptions.map((s, i) => ({ id: `slot_${i}`, title: s.label })),
            company.id
          );
          skipAiAutoReply = true;
        } else if (schedulingUrl) {
          await sendWhatsApp(`+${phoneNumber}`, `You can pick a time that works for you here: ${schedulingUrl}`, company.id);
          skipAiAutoReply = true;
        }
        // If Calendly isn't configured at all, fall through to the normal AI reply.
      }
      // 'Ask questions' falls through to AI handling below
    } else if (isInteractiveReply && interactiveReplyId?.startsWith('slot_')) {
      const pendingSlots = conv.pending_slots || [];
      const idx = parseInt(interactiveReplyId.replace('slot_', ''), 10);
      const chosen = pendingSlots[idx];
      const { schedulingUrl } = await getCalendlyConfig(company.id);

      if (chosen?.link) {
        await sendWhatsApp(`+${phoneNumber}`, `Great choice! Tap here to lock in ${chosen.label}: ${chosen.link}`, company.id);
      } else if (schedulingUrl) {
        await sendWhatsApp(`+${phoneNumber}`, `Sorry, that time's no longer available — here's our booking page so you can pick another: ${schedulingUrl}`, company.id);
      }
      skipAiAutoReply = true;
    }

    // Update interest score
    await calculateScore(lead, company.id);

    // AI auto-reply if AI mode is active
    console.log(`conv.ai_active=${conv.ai_active} for conv=${conv.id}`);
    if (conv.ai_active && !skipAiAutoReply) {
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

// Calendly inbound webhook — fires when someone books via the Calendly link
// (either the "see everything" link or the per-slot deep link). Each company
// configures its own Calendly webhook subscription pointed at this URL.
router.post('/calendly/:companyId', async (req, res) => {
  res.sendStatus(200);
  try {
    const { companyId } = req.params;
    const rawBody = req.body.toString();
    const signatureHeader = req.headers['calendly-webhook-signature'];

    const { rows: [company] } = await query('SELECT * FROM companies WHERE id = $1', [companyId]);
    if (!company) {
      console.error('Calendly webhook: no company found for id', companyId);
      return;
    }

    const { webhookSigningKey } = await getCalendlyConfig(companyId);
    if (!verifyWebhookSignature(rawBody, signatureHeader, webhookSigningKey)) {
      console.error('Calendly webhook: signature verification failed for company', companyId);
      return;
    }

    const body = JSON.parse(rawBody);
    if (body.event !== 'invitee.created') {
      console.log('Calendly webhook: ignoring event type', body.event);
      return;
    }

    const invitee = body.payload || {};
    const scheduledEvent = invitee.scheduled_event || {};
    const startTime = scheduledEvent.start_time;
    const email = invitee.email;
    const name = invitee.name;

    if (!startTime) {
      console.error('Calendly webhook: no start_time in payload');
      return;
    }

    // Match to an existing lead by email, or auto-create one — consistent
    // with how unrecognized WhatsApp inbound numbers are handled.
    let lead = null;
    if (email) {
      const { rows } = await query(
        'SELECT * FROM leads WHERE company_id = $1 AND LOWER(email) = LOWER($2)',
        [companyId, email]
      );
      lead = rows[0] || null;
    }
    if (!lead) {
      const { rows: [newLead] } = await query(`
        INSERT INTO leads (company_id, name, email, source, stage)
        VALUES ($1, $2, $3, 'calendly_inbound', 'meeting') RETURNING *
      `, [companyId, name || 'Calendly booking', email || null]);
      lead = newLead;
    }

    const durationMinutes = scheduledEvent.end_time
      ? Math.round((new Date(scheduledEvent.end_time) - new Date(startTime)) / 60000)
      : 30;

    const { rows: [meeting] } = await query(`
      INSERT INTO meetings (lead_id, company_id, title, scheduled_at, duration_minutes, source, calendly_event_uri)
      VALUES ($1,$2,$3,$4,$5,'calendly',$6) RETURNING *
    `, [lead.id, companyId, 'Roofing consultation', startTime, durationMinutes, scheduledEvent.uri || null]);

    await query(`UPDATE leads SET stage = 'meeting', updated_at = NOW() WHERE id = $1`, [lead.id]);
    await triggerWorkflow('meeting_booked', lead, companyId);

    // Best-effort confirmation — only reliable within the 24h WhatsApp
    // session window. Outside that window this will fail silently (logged),
    // since there's no approved template for meeting confirmations yet.
    if (lead.phone) {
      const label = new Date(startTime).toLocaleString('en-US', {
        weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        timeZone: company.timezone || 'Pacific/Auckland',
      });
      await sendWhatsApp(lead.phone, `You're booked in for ${label}! Looking forward to it.`, companyId)
        .catch(e => console.error('Calendly confirmation WhatsApp send failed:', e.message));
    }

    console.log(`Calendly booking created: meeting=${meeting.id} lead=${lead.id}`);
  } catch (err) {
    console.error('Calendly webhook error:', err.message, err.stack);
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

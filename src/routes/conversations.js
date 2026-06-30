const express = require('express');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');
const { generateAIReply } = require('../services/aiService');
const { sendWhatsApp, sendWhatsAppTemplate } = require('../services/whatsappService');
const { sendEmail } = require('../services/emailService');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(authenticate);

// GET /api/conversations — list for company
router.get('/', async (req, res, next) => {
  try {
    const { leadId, channel, status } = req.query;
    let where = 'WHERE c.company_id = $1';
    const params = [req.companyId];

    if (leadId) { params.push(leadId); where += ` AND c.lead_id = $${params.length}`; }
    if (channel) { params.push(channel); where += ` AND c.channel = $${params.length}`; }
    if (status)  { params.push(status);  where += ` AND c.status = $${params.length}`; }

    const { rows } = await query(`
      SELECT c.*, l.name as lead_name, l.phone, l.interest_score, l.score_tier,
        (SELECT content FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message
      FROM conversations c
      JOIN leads l ON c.lead_id = l.id
      ${where}
      ORDER BY c.last_message_at DESC
      LIMIT 100
    `, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/conversations/:id/messages
router.get('/:id/messages', async (req, res, next) => {
  try {
    const { rows: [conv] } = await query(
      'SELECT * FROM conversations WHERE id = $1 AND company_id = $2',
      [req.params.id, req.companyId]
    );
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const { rows: messages } = await query(
      `SELECT m.*, u.name as sender_name
       FROM messages m LEFT JOIN users u ON m.sender_id = u.id
       WHERE m.conversation_id = $1 ORDER BY m.created_at ASC`,
      [req.params.id]
    );
    res.json({ conversation: conv, messages });
  } catch (err) { next(err); }
});

// POST /api/conversations/:id/messages — send message (human override)
router.post('/:id/messages', async (req, res, next) => {
  try {
    const { content, channel = 'whatsapp' } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Content is required' });

    const { rows: [conv] } = await query(
      'SELECT c.*, l.phone, l.email, l.name as lead_name FROM conversations c JOIN leads l ON c.lead_id = l.id WHERE c.id = $1 AND c.company_id = $2',
      [req.params.id, req.companyId]
    );
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const { rows: [msg] } = await query(`
      INSERT INTO messages (conversation_id, company_id, direction, sender_type, sender_id, content, channel)
      VALUES ($1,$2,'outbound','human',$3,$4,$5) RETURNING *
    `, [req.params.id, req.companyId, req.user.id, content, channel]);

    await query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [req.params.id]);

    // Send via appropriate channel
    if (channel === 'whatsapp' && conv.phone) {
      await sendWhatsApp(conv.phone, content, req.companyId).catch(e => console.error('WhatsApp send failed:', e));
    } else if (channel === 'email' && conv.email) {
      await sendEmail({ to: conv.email, subject: 'Re: Your roofing quote', text: content }, req.companyId).catch(e => console.error('Email send failed:', e));
    }

    res.status(201).json(msg);
  } catch (err) { next(err); }
});

// POST /api/conversations/:id/ai-reply — trigger AI to respond
router.post('/:id/ai-reply', async (req, res, next) => {
  try {
    const { rows: [conv] } = await query(
      `SELECT c.*, l.name as lead_name, l.phone, l.email, l.interest_score, l.ai_summary
       FROM conversations c JOIN leads l ON c.lead_id = l.id
       WHERE c.id = $1 AND c.company_id = $2`,
      [req.params.id, req.companyId]
    );
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });

    const { rows: history } = await query(
      'SELECT direction, sender_type, content FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 20',
      [req.params.id]
    );

    const aiReply = await generateAIReply(conv, history, req.companyId);

    const { rows: [msg] } = await query(`
      INSERT INTO messages (conversation_id, company_id, direction, sender_type, content, channel)
      VALUES ($1,$2,'outbound','ai',$3,$4) RETURNING *
    `, [req.params.id, req.companyId, aiReply, conv.channel]);

    await query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [req.params.id]);

    // Send the AI reply via the channel
    if (conv.channel === 'whatsapp' && conv.phone) {
      await sendWhatsApp(conv.phone, aiReply, req.companyId).catch(e => console.error('WhatsApp send failed:', e));
    }

    res.json(msg);
  } catch (err) { next(err); }
});

// POST /api/conversations/:id/template — send an approved WhatsApp template
router.post('/:id/template', async (req, res, next) => {
  try {
    const { template_name = 'quote_ready' } = req.body;

    const { rows: [conv] } = await query(
      `SELECT c.*, l.phone, l.name as lead_name
       FROM conversations c JOIN leads l ON c.lead_id = l.id
       WHERE c.id = $1 AND c.company_id = $2`,
      [req.params.id, req.companyId]
    );
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (!conv.phone) return res.status(400).json({ error: 'Lead has no phone number' });

    const { rows: [company] } = await query('SELECT name FROM companies WHERE id = $1', [req.companyId]);
    const firstName = conv.lead_name.split(' ')[0];

    const components = [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: firstName },
          { type: 'text', text: company?.name || 'our company' },
        ],
      },
    ];

    await sendWhatsAppTemplate(conv.phone, template_name, components, req.companyId);

    const preview = `Hi ${firstName}, your roofing quotation from ${company?.name || 'our company'} is now ready. [Template: ${template_name}]`;
    const { rows: [msg] } = await query(`
      INSERT INTO messages (conversation_id, company_id, direction, sender_type, sender_id, content, channel)
      VALUES ($1,$2,'outbound','human',$3,$4,'whatsapp') RETURNING *
    `, [req.params.id, req.companyId, req.user.id, preview]);

    await query('UPDATE conversations SET last_message_at = NOW() WHERE id = $1', [req.params.id]);

    res.status(201).json(msg);
  } catch (err) { next(err); }
});

// PATCH /api/conversations/:id — update status or toggle AI
router.patch('/:id', async (req, res, next) => {
  try {
    const { status, ai_active, escalated_to } = req.body;
    const { rows } = await query(`
      UPDATE conversations
      SET status = COALESCE($3, status),
          ai_active = COALESCE($4, ai_active),
          escalated_to = COALESCE($5, escalated_to),
          escalated_at = CASE WHEN $5 IS NOT NULL THEN NOW() ELSE escalated_at END
      WHERE id = $1 AND company_id = $2 RETURNING *
    `, [req.params.id, req.companyId, status, ai_active, escalated_to || null]);
    if (!rows[0]) return res.status(404).json({ error: 'Conversation not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;

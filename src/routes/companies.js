const express = require('express');
const { query } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /api/companies/me
router.get('/me', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM companies WHERE id = $1', [req.companyId]);
    if (!rows[0]) return res.status(404).json({ error: 'Company not found' });
    // Redact sensitive keys
    const safe = { ...rows[0] };
    if (safe.whatsapp_access_token) safe.whatsapp_access_token = '***';
    if (safe.sendgrid_api_key) safe.sendgrid_api_key = '***';
    res.json(safe);
  } catch (err) { next(err); }
});

// PATCH /api/companies/me
router.patch('/me', requireRole('admin'), async (req, res, next) => {
  try {
    const allowed = [
      'name','industry','timezone','primary_channel','ai_persona_name',
      'ai_escalation_threshold','ai_max_messages','business_hours',
      'from_email','whatsapp_phone_number_id','whatsapp_access_token',
      'sendgrid_api_key','slack_webhook_url',
    ];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields' });

    const keys = Object.keys(updates);
    const vals = Object.values(updates);
    const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await query(`UPDATE companies SET ${set}, updated_at=NOW() WHERE id=$1 RETURNING *`, [req.companyId, ...vals]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// GET /api/companies/users
router.get('/users', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id,name,email,role,last_login_at,created_at FROM users WHERE company_id=$1 ORDER BY name',
      [req.companyId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;

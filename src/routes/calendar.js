const express = require('express');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /api/calendar/meetings
router.get('/meetings', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const start = from || new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const end = to || new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).toISOString();

    const { rows } = await query(`
      SELECT m.*, l.name as lead_name, l.phone, u.name as assigned_name
      FROM meetings m
      JOIN leads l ON m.lead_id = l.id
      LEFT JOIN users u ON m.assigned_to = u.id
      WHERE m.company_id = $1 AND m.scheduled_at BETWEEN $2 AND $3
      ORDER BY m.scheduled_at ASC
    `, [req.companyId, start, end]);
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /api/calendar/meetings — book a meeting
router.post('/meetings', async (req, res, next) => {
  try {
    const { lead_id, title, scheduled_at, duration_minutes = 30, assigned_to, notes, meeting_url } = req.body;
    if (!lead_id || !scheduled_at) return res.status(400).json({ error: 'lead_id and scheduled_at required' });

    const { rows: [meeting] } = await query(`
      INSERT INTO meetings (lead_id, company_id, assigned_to, title, scheduled_at, duration_minutes, notes, meeting_url)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [lead_id, req.companyId, assigned_to || req.user.id, title || 'Roofing consultation', scheduled_at, duration_minutes, notes, meeting_url]);

    // Update lead stage to 'meeting'
    await query(`UPDATE leads SET stage = 'meeting', updated_at = NOW() WHERE id = $1 AND company_id = $2`, [lead_id, req.companyId]);

    res.status(201).json(meeting);
  } catch (err) { next(err); }
});

// PATCH /api/calendar/meetings/:id
router.patch('/meetings/:id', async (req, res, next) => {
  try {
    const { status, notes, scheduled_at } = req.body;
    const { rows } = await query(`
      UPDATE meetings SET status=COALESCE($3,status), notes=COALESCE($4,notes),
        scheduled_at=COALESCE($5,scheduled_at), updated_at=NOW()
      WHERE id=$1 AND company_id=$2 RETURNING *
    `, [req.params.id, req.companyId, status, notes, scheduled_at]);
    if (!rows[0]) return res.status(404).json({ error: 'Meeting not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// GET /api/calendar/availability — check rep availability
router.get('/availability', async (req, res, next) => {
  try {
    const { date, assigned_to } = req.query;
    if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });

    const { rows } = await query(`
      SELECT scheduled_at, duration_minutes FROM meetings
      WHERE company_id = $1
        AND DATE(scheduled_at) = $2
        AND status NOT IN ('cancelled')
        AND ($3::uuid IS NULL OR assigned_to = $3)
      ORDER BY scheduled_at
    `, [req.companyId, date, assigned_to || null]);
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;

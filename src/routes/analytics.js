const express = require('express');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /api/analytics/dashboard — KPI summary
router.get('/dashboard', async (req, res, next) => {
  try {
    const cid = req.companyId;
    const [leads, meetings, messages, revenue] = await Promise.all([
      query(`SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE score_tier = 'green') as green,
        COUNT(*) FILTER (WHERE score_tier = 'amber') as amber,
        COUNT(*) FILTER (WHERE score_tier = 'red') as red,
        COUNT(*) FILTER (WHERE stage = 'won') as won,
        COUNT(*) FILTER (WHERE stage = 'lost') as lost,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') as new_this_week
        FROM leads WHERE company_id = $1`, [cid]),
      query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status='completed') as completed
        FROM meetings WHERE company_id = $1 AND scheduled_at >= NOW() - INTERVAL '30 days'`, [cid]),
      query(`SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE sender_type='ai') as ai_sent
        FROM messages WHERE company_id = $1 AND created_at >= NOW() - INTERVAL '30 days'`, [cid]),
      query(`SELECT COALESCE(SUM(value),0) as pipeline, COALESCE(SUM(value) FILTER (WHERE status='accepted'),0) as won
        FROM quotes q JOIN leads l ON q.lead_id = l.id WHERE q.company_id = $1`, [cid]),
    ]);

    res.json({
      leads: leads.rows[0],
      meetings: meetings.rows[0],
      messages: messages.rows[0],
      revenue: revenue.rows[0],
    });
  } catch (err) { next(err); }
});

// GET /api/analytics/leads-by-week — last 8 weeks
router.get('/leads-by-week', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT DATE_TRUNC('week', created_at) as week, COUNT(*) as count
      FROM leads WHERE company_id = $1 AND created_at >= NOW() - INTERVAL '8 weeks'
      GROUP BY 1 ORDER BY 1
    `, [req.companyId]);
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/analytics/stage-funnel
router.get('/stage-funnel', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT stage, COUNT(*) as count
      FROM leads WHERE company_id = $1
      GROUP BY stage
      ORDER BY ARRAY_POSITION(ARRAY['new','contacted','replied','meeting','quoted','won','lost'], stage)
    `, [req.companyId]);
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/analytics/channel-performance
router.get('/channel-performance', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT channel, COUNT(*) as message_count,
        COUNT(DISTINCT conversation_id) as conversation_count
      FROM messages WHERE company_id = $1 AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY channel
    `, [req.companyId]);
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /api/analytics/conversion-rate
router.get('/conversion-rate', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT
        COUNT(*) FILTER (WHERE stage = 'won') as won,
        COUNT(*) as total,
        ROUND(COUNT(*) FILTER (WHERE stage = 'won')::numeric / NULLIF(COUNT(*),0) * 100, 1) as rate
      FROM leads WHERE company_id = $1
    `, [req.companyId]);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;

const express = require('express');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// GET /api/quotes — cross-lead quote list for dashboard views
router.get('/', async (req, res, next) => {
  try {
    const { status, from, to, page = 1, limit = 50 } = req.query;
    const params = [req.companyId];
    let where = 'WHERE q.company_id = $1';

    if (status) { params.push(status); where += ` AND q.status = $${params.length}`; }
    if (from) { params.push(from); where += ` AND q.created_at >= $${params.length}`; }
    if (to) { params.push(to); where += ` AND q.created_at <= $${params.length}`; }

    const offset = (page - 1) * limit;
    const { rows } = await query(`
      SELECT q.*, l.name as lead_name, l.phone, l.email, l.stage as lead_stage
      FROM quotes q
      JOIN leads l ON q.lead_id = l.id
      ${where}
      ORDER BY q.updated_at DESC
      LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}
    `, params);

    const { rows: [{ count }] } = await query(`SELECT COUNT(*) FROM quotes q ${where}`, params.slice(0, -2));
    res.json({ quotes: rows, total: parseInt(count), page: parseInt(page), limit: parseInt(limit) });
  } catch (err) { next(err); }
});

module.exports = router;

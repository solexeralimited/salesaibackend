const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const { Readable } = require('stream');
const { body, query: queryValidator, validationResult } = require('express-validator');
const { query } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { calculateScore } = require('../services/scoringService');
const { triggerWorkflow } = require('../services/workflowService');
const { logAudit } = require('../utils/audit');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// All lead routes require authentication
router.use(authenticate);

// GET /api/leads — list with filters
router.get('/', async (req, res, next) => {
  try {
    const { stage, tier, search, assignedTo, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;
    const params = [req.companyId];
    let where = 'WHERE l.company_id = $1';

    if (stage) { params.push(stage); where += ` AND l.stage = $${params.length}`; }
    if (tier) { params.push(tier); where += ` AND l.score_tier = $${params.length}`; }
    if (assignedTo) { params.push(assignedTo); where += ` AND l.assigned_to = $${params.length}`; }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (l.name ILIKE $${params.length} OR l.email ILIKE $${params.length} OR l.company_name ILIKE $${params.length})`;
    }

    const { rows } = await query(`
      SELECT l.*,
        u.name as assigned_name,
        q.value as quote_value, q.reference as quote_reference, q.status as quote_status,
        c.last_message_at, c.channel as conversation_channel, c.id as conversation_id
      FROM leads l
      LEFT JOIN users u ON l.assigned_to = u.id
      LEFT JOIN quotes q ON q.lead_id = l.id
      LEFT JOIN conversations c ON c.lead_id = l.id
      ${where}
      ORDER BY l.updated_at DESC
      LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}
    `, params);

    const { rows: [{ count }] } = await query(`SELECT COUNT(*) FROM leads l ${where}`, params.slice(0, -2));
    res.json({ leads: rows, total: parseInt(count), page: parseInt(page), limit: parseInt(limit) });
  } catch (err) { next(err); }
});

// GET /api/leads/:id
router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT l.*, u.name as assigned_name,
        json_agg(DISTINCT q.*) FILTER (WHERE q.id IS NOT NULL) as quotes,
        json_agg(DISTINCT jsonb_build_object('id',m.id,'score',m.score,'reason',m.reason,'created_at',m.created_at)) 
          FILTER (WHERE m.id IS NOT NULL) as score_history
      FROM leads l
      LEFT JOIN users u ON l.assigned_to = u.id
      LEFT JOIN quotes q ON q.lead_id = l.id
      LEFT JOIN interest_score_history m ON m.lead_id = l.id
      WHERE l.id = $1 AND l.company_id = $2
      GROUP BY l.id, u.name
    `, [req.params.id, req.companyId]);

    if (!rows[0]) return res.status(404).json({ error: 'Lead not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/leads — create single lead
router.post('/', [
  body('name').trim().isLength({ min: 2 }),
  body('phone').optional().isMobilePhone(),
  body('email').optional().isEmail(),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { name, email, phone, company_name, source = 'manual', quote_value, quote_reference, notes, assigned_to } = req.body;

    const { rows: [lead] } = await query(`
      INSERT INTO leads (company_id, name, email, phone, company_name, source, notes, assigned_to)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [req.companyId, name, email, phone, company_name, source, notes, assigned_to || null]);

    if (quote_value && quote_reference) {
      await query(`
        INSERT INTO quotes (lead_id, company_id, reference, value) VALUES ($1,$2,$3,$4)
      `, [lead.id, req.companyId, quote_reference, quote_value]);
    }

    // Create conversation and trigger workflow
    await query(`INSERT INTO conversations (lead_id, company_id, channel) VALUES ($1,$2,'whatsapp')`, [lead.id, req.companyId]);
    await triggerWorkflow('lead_imported', lead, req.companyId);
    await logAudit(req.companyId, req.user.id, 'create', 'lead', lead.id, { name });

    res.status(201).json(lead);
  } catch (err) { next(err); }
});

// PATCH /api/leads/:id
router.patch('/:id', async (req, res, next) => {
  try {
    const allowed = ['name','email','phone','company_name','stage','assigned_to','notes','tags','ai_mode_active'];
    const updates = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });

    const keys = Object.keys(updates);
    const vals = Object.values(updates);
    const set = keys.map((k, i) => `${k} = $${i + 3}`).join(', ');

    const { rows } = await query(
      `UPDATE leads SET ${set}, updated_at = NOW() WHERE id = $1 AND company_id = $2 RETURNING *`,
      [req.params.id, req.companyId, ...vals]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Lead not found' });

    await logAudit(req.companyId, req.user.id, 'update', 'lead', req.params.id, updates);
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// DELETE /api/leads/:id
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { rowCount } = await query('DELETE FROM leads WHERE id = $1 AND company_id = $2', [req.params.id, req.companyId]);
    if (!rowCount) return res.status(404).json({ error: 'Lead not found' });
    await logAudit(req.companyId, req.user.id, 'delete', 'lead', req.params.id);
    res.json({ message: 'Lead deleted' });
  } catch (err) { next(err); }
});

// POST /api/leads/import/csv — bulk CSV upload
router.post('/import/csv', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'CSV file required' });

    const leads = [];
    const errors = [];
    let row = 0;

    await new Promise((resolve, reject) => {
      Readable.from(req.file.buffer.toString())
        .pipe(csv())
        .on('data', (data) => {
          row++;
          if (!data.name) { errors.push({ row, error: 'Missing name' }); return; }
          leads.push({
            name: data.name?.trim(),
            email: data.email?.trim() || null,
            phone: data.phone?.trim() || null,
            company_name: data.company_name?.trim() || data.company?.trim() || null,
            quote_value: parseFloat(data.quote_value) || null,
            quote_reference: data.quote_reference?.trim() || null,
            source: 'csv_import',
          });
        })
        .on('end', resolve)
        .on('error', reject);
    });

    const imported = [];
    for (const l of leads) {
      const { rows: [lead] } = await query(`
        INSERT INTO leads (company_id, name, email, phone, company_name, source)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING *
      `, [req.companyId, l.name, l.email, l.phone, l.company_name, l.source]);
      if (lead) {
        if (l.quote_value) {
          await query(`INSERT INTO quotes (lead_id, company_id, reference, value) VALUES ($1,$2,$3,$4)`,
            [lead.id, req.companyId, l.quote_reference || `CSV-${Date.now()}`, l.quote_value]);
        }
        await query(`INSERT INTO conversations (lead_id, company_id, channel) VALUES ($1,$2,'whatsapp')`, [lead.id, req.companyId]);
        await triggerWorkflow('lead_imported', lead, req.companyId);
        imported.push(lead);
      }
    }

    await logAudit(req.companyId, req.user.id, 'import', 'leads', null, { count: imported.length });
    res.json({ imported: imported.length, skipped: leads.length - imported.length, errors });
  } catch (err) { next(err); }
});

// POST /api/leads/:id/score — manual score recalculation
router.post('/:id/score', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM leads WHERE id = $1 AND company_id = $2', [req.params.id, req.companyId]);
    if (!rows[0]) return res.status(404).json({ error: 'Lead not found' });
    const score = await calculateScore(rows[0], req.companyId);
    res.json({ score });
  } catch (err) { next(err); }
});

module.exports = router;

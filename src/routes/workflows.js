const express = require('express');
const { query } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { triggerWorkflow } = require('../services/workflowService');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM workflows WHERE company_id = $1 ORDER BY updated_at DESC', [req.companyId]);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT * FROM workflows WHERE id=$1 AND company_id=$2', [req.params.id, req.companyId]);
    if (!rows[0]) return res.status(404).json({ error: 'Workflow not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.post('/', requireRole('admin', 'consultant'), async (req, res, next) => {
  try {
    const { name, description, trigger_type, trigger_config, nodes, edges } = req.body;
    if (!name || !trigger_type) return res.status(400).json({ error: 'name and trigger_type required' });

    const nodesJson = typeof nodes === 'string' ? JSON.parse(nodes) : (nodes || []);
    const edgesJson = typeof edges === 'string' ? JSON.parse(edges) : (edges || []);
    const triggerJson = typeof trigger_config === 'string' ? JSON.parse(trigger_config) : (trigger_config || {});

    const { rows: [wf] } = await query(
      `INSERT INTO workflows (company_id, name, description, trigger_type, trigger_config, nodes, edges, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.companyId, name, description, trigger_type,
       JSON.stringify(triggerJson),
       JSON.stringify(nodesJson),
       JSON.stringify(edgesJson),
       req.user.id]
    );
    res.status(201).json(wf);
  } catch (err) { next(err); }
});

router.patch('/:id', requireRole('admin', 'consultant'), async (req, res, next) => {
  try {
    const { name, description, status, trigger_type, trigger_config, nodes, edges } = req.body;
    const nodesJson = nodes ? (typeof nodes === 'string' ? nodes : JSON.stringify(nodes)) : null;
    const edgesJson = edges ? (typeof edges === 'string' ? edges : JSON.stringify(edges)) : null;
    const triggerJson = trigger_config ? (typeof trigger_config === 'string' ? trigger_config : JSON.stringify(trigger_config)) : null;

    const { rows } = await query(`
      UPDATE workflows SET
        name=COALESCE($3,name), description=COALESCE($4,description),
        status=COALESCE($5,status), trigger_type=COALESCE($6,trigger_type),
        trigger_config=COALESCE($7::jsonb,trigger_config),
        nodes=COALESCE($8::jsonb,nodes),
        edges=COALESCE($9::jsonb,edges),
        updated_at=NOW()
      WHERE id=$1 AND company_id=$2 RETURNING *
    `, [req.params.id, req.companyId, name, description, status, trigger_type, triggerJson, nodesJson, edgesJson]);
    if (!rows[0]) return res.status(404).json({ error: 'Workflow not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /api/workflows/:id/test — manually trigger workflow for a lead
router.post('/:id/test', async (req, res, next) => {
  try {
    const { lead_id } = req.body;
    if (!lead_id) return res.status(400).json({ error: 'lead_id required' });
    const { rows: [wf] } = await query('SELECT * FROM workflows WHERE id=$1 AND company_id=$2', [req.params.id, req.companyId]);
    if (!wf) return res.status(404).json({ error: 'Workflow not found' });
    const { rows: [lead] } = await query('SELECT * FROM leads WHERE id=$1 AND company_id=$2', [lead_id, req.companyId]);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    await triggerWorkflow(wf.trigger_type, lead, req.companyId);
    res.json({ message: 'Workflow triggered successfully' });
  } catch (err) { next(err); }
});

router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { rowCount } = await query('DELETE FROM workflows WHERE id=$1 AND company_id=$2', [req.params.id, req.companyId]);
    if (!rowCount) return res.status(404).json({ error: 'Workflow not found' });
    res.json({ message: 'Workflow deleted' });
  } catch (err) { next(err); }
});

module.exports = router;

// knowledgeBase.js
const express = require('express');
const { query } = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const { category, search } = req.query;
    let where = 'WHERE company_id = $1';
    const params = [req.companyId];
    if (category) { params.push(category); where += ` AND category = $${params.length}`; }
    if (search) { params.push(`%${search}%`); where += ` AND (title ILIKE $${params.length} OR content ILIKE $${params.length})`; }
    const { rows } = await query(`SELECT * FROM knowledge_base ${where} ORDER BY category, title`, params);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get('/categories', async (req, res, next) => {
  try {
    const { rows } = await query(`SELECT category, COUNT(*) as article_count FROM knowledge_base WHERE company_id = $1 GROUP BY category ORDER BY category`, [req.companyId]);
    res.json(rows);
  } catch (err) { next(err); }
});

router.post('/', requireRole('admin', 'consultant'), async (req, res, next) => {
  try {
    const { category, title, content, tags } = req.body;
    if (!category || !title || !content) return res.status(400).json({ error: 'category, title and content are required' });
    const { rows: [article] } = await query(
      `INSERT INTO knowledge_base (company_id, category, title, content, tags, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.companyId, category, title, content, tags || [], req.user.id]
    );
    res.status(201).json(article);
  } catch (err) { next(err); }
});

router.patch('/:id', requireRole('admin', 'consultant'), async (req, res, next) => {
  try {
    const { category, title, content, tags } = req.body;
    const { rows } = await query(
      `UPDATE knowledge_base SET category=COALESCE($3,category), title=COALESCE($4,title), content=COALESCE($5,content), tags=COALESCE($6,tags), updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *`,
      [req.params.id, req.companyId, category, title, content, tags]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Article not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const { rowCount } = await query('DELETE FROM knowledge_base WHERE id=$1 AND company_id=$2', [req.params.id, req.companyId]);
    if (!rowCount) return res.status(404).json({ error: 'Article not found' });
    res.json({ message: 'Deleted' });
  } catch (err) { next(err); }
});

module.exports = router;

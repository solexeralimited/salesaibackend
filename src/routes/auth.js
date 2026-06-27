const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { query } = require('../db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

const signToken = (userId) => jwt.sign(
  { userId },
  process.env.JWT_SECRET,
  { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
);

// POST /api/auth/login
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;
    const { rows } = await query(
      `SELECT u.*, c.name as company_name, c.subdomain, c.ai_persona_name, c.primary_channel
       FROM users u JOIN companies c ON u.company_id = c.id
       WHERE u.email = $1`,
      [email]
    );
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    const token = signToken(user.id);
    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        companyId: user.company_id,
        companyName: user.company_name,
        subdomain: user.subdomain,
        aiPersonaName: user.ai_persona_name,
        primaryChannel: user.primary_channel,
      },
    });
  } catch (err) { next(err); }
});

// POST /api/auth/register (creates company + admin user)
router.post('/register', [
  body('companyName').trim().isLength({ min: 2 }),
  body('name').trim().isLength({ min: 2 }),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { companyName, name, email, password } = req.body;
    const subdomain = companyName.toLowerCase().replace(/[^a-z0-9]/g, '-').substring(0, 30);
    const hash = await bcrypt.hash(password, 12);

    const { rows: [company] } = await query(
      `INSERT INTO companies (name, subdomain) VALUES ($1, $2) RETURNING *`,
      [companyName, subdomain]
    );
    const { rows: [user] } = await query(
      `INSERT INTO users (company_id, email, password_hash, name, role) VALUES ($1,$2,$3,$4,'admin') RETURNING *`,
      [company.id, email, hash, name]
    );

    const token = signToken(user.id);
    res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, companyId: company.id, companyName: company.name },
    });
  } catch (err) { next(err); }
});

// GET /api/auth/me
router.get('/me', authenticate, async (req, res) => {
  const { password_hash, ...safe } = req.user;
  res.json({ user: safe });
});

// POST /api/auth/change-password
router.post('/change-password', authenticate, [
  body('currentPassword').isLength({ min: 6 }),
  body('newPassword').isLength({ min: 8 }),
], async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (!(await bcrypt.compare(currentPassword, rows[0].password_hash))) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }
    const hash = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, req.user.id]);
    res.json({ message: 'Password updated' });
  } catch (err) { next(err); }
});

module.exports = router;

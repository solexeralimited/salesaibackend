const jwt = require('jsonwebtoken');
const { query } = require('../db');

/**
 * Verify JWT and attach user + company to req.
 * All protected routes must use this middleware.
 */
const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    const token = header.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Fetch fresh user from DB on each request (detects disabled accounts)
    const { rows } = await query(
      'SELECT u.*, c.ai_escalation_threshold, c.ai_max_messages, c.ai_persona_name FROM users u JOIN companies c ON u.company_id = c.id WHERE u.id = $1',
      [payload.userId]
    );
    if (!rows[0]) return res.status(401).json({ error: 'User not found' });

    req.user = rows[0];
    req.companyId = rows[0].company_id;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
};

/**
 * Role-based access control.
 * Usage: requireRole('admin') or requireRole('admin', 'consultant')
 */
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  if (!roles.includes(req.user.role)) {
    return res.status(403).json({ error: `Role '${req.user.role}' cannot perform this action` });
  }
  next();
};

/**
 * Ensure the requested resource belongs to the authenticated tenant.
 * Pass the company_id field name in the request (default: 'company_id').
 */
const tenantIsolation = (getCompanyId) => async (req, res, next) => {
  try {
    const resourceCompanyId = await getCompanyId(req);
    if (resourceCompanyId && resourceCompanyId !== req.companyId) {
      return res.status(403).json({ error: 'Access denied' });
    }
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = { authenticate, requireRole, tenantIsolation };

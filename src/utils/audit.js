const { query } = require('../db');

async function logAudit(companyId, userId, action, resourceType, resourceId, metadata = {}) {
  try {
    await query(
      `INSERT INTO audit_logs (company_id, user_id, action, resource_type, resource_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [companyId, userId, action, resourceType, resourceId, JSON.stringify(metadata)]
    );
  } catch (err) {
    console.error('Audit log failed:', err.message);
  }
}

module.exports = { logAudit };

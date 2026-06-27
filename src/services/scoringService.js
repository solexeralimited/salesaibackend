const { query } = require('../db');

/**
 * Calculate and persist an updated interest score for a lead.
 * Scoring factors:
 *   - Stage progression (new=30, contacted=40, replied=55, meeting=75, quoted=80, won=100, lost=0)
 *   - Message activity (+5 per inbound message up to +20)
 *   - Meeting booked (+15)
 *   - Response time (<2h = +5, >24h = -5)
 *   - Sentiment (+10 positive, -10 negative)
 */
async function calculateScore(lead, companyId) {
  const stageBase = {
    new: 30, contacted: 40, replied: 55,
    meeting: 75, quoted: 80, won: 100, lost: 0,
  };

  let score = stageBase[lead.stage] || 50;

  // Count inbound messages
  const { rows: [msgStats] } = await query(`
    SELECT
      COUNT(*) FILTER (WHERE direction='inbound') as inbound_count,
      MIN(created_at) FILTER (WHERE direction='inbound') as first_inbound
    FROM messages m
    JOIN conversations c ON m.conversation_id = c.id
    WHERE c.lead_id = $1
  `, [lead.id]);

  const inboundCount = parseInt(msgStats?.inbound_count || 0);
  score += Math.min(inboundCount * 5, 20);

  // Meeting booked
  const { rows: [meetingCheck] } = await query(
    'SELECT COUNT(*) as cnt FROM meetings WHERE lead_id = $1 AND status != $2',
    [lead.id, 'cancelled']
  );
  if (parseInt(meetingCheck?.cnt) > 0) score += 15;

  // Cap score 0–100
  score = Math.max(0, Math.min(100, Math.round(score)));

  // Persist
  await query('UPDATE leads SET interest_score = $1, updated_at = NOW() WHERE id = $2', [score, lead.id]);
  await query(
    'INSERT INTO interest_score_history (lead_id, score, triggered_by) VALUES ($1,$2,$3)',
    [lead.id, score, 'auto_calculation']
  );

  return score;
}

module.exports = { calculateScore };

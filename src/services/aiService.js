const Anthropic = require('@anthropic-ai/sdk');
const { query } = require('../db');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Generate an AI reply for a conversation.
 * @param {Object} conv - Conversation + lead data
 * @param {Array}  history - Array of {direction, sender_type, content} messages
 * @param {string} companyId - Tenant company ID
 */
async function generateAIReply(conv, history, companyId) {
  // Load knowledge base for this company
  const { rows: kbArticles } = await query(
    'SELECT category, title, content FROM knowledge_base WHERE company_id = $1 ORDER BY category',
    [companyId]
  );

  // Load company config
  const { rows: [company] } = await query(
    'SELECT name, ai_persona_name, ai_escalation_threshold, ai_max_messages FROM companies WHERE id = $1',
    [companyId]
  );

  const kbText = kbArticles.length > 0
    ? kbArticles.map(a => `## ${a.category}: ${a.title}\n${a.content}`).join('\n\n')
    : 'No knowledge base articles available.';

  const systemPrompt = `You are ${company?.ai_persona_name || 'Aria'}, a professional sales assistant for ${company?.name || 'a roofing company'}.

Your role is to:
- Answer customer questions about their roofing quote professionally and concisely
- Handle objections using the provided knowledge base
- Book meetings when the customer is ready (provide a booking link placeholder: [BOOKING_LINK])
- Escalate to a human if the customer is very unhappy or asks directly for a person
- Keep messages short (2-4 sentences) — this is WhatsApp, not email
- Never make up warranty details or prices not in the knowledge base

Customer: ${conv.lead_name}
Current interest score: ${conv.interest_score}/100
AI escalation threshold: ${company?.ai_escalation_threshold || 40}

KNOWLEDGE BASE:
${kbText}

RULES:
- If asked "are you a bot/AI/robot", acknowledge it honestly but warmly
- If sentiment is very negative or score < ${company?.ai_escalation_threshold || 40}, say "Let me connect you with a member of our team"
- Never promise specific start dates
- Sign off as "${company?.ai_persona_name || 'Aria'} from ${company?.name || 'RoofPro'}"`;

  // Convert history to Claude message format
  const messages = history.map(m => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.content,
  }));

  // Ensure conversation ends with user message
  if (!messages.length || messages[messages.length - 1].role === 'assistant') {
    messages.push({ role: 'user', content: 'Hello' });
  }

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: systemPrompt,
      messages,
    });
    return response.content[0].text;
  } catch (err) {
    console.error('AI reply error:', err.message);
    return `Hi, thanks for your message. I'm having a brief technical issue — a member of our team will be in touch shortly.`;
  }
}

/**
 * Generate a conversation summary for a lead profile.
 */
async function generateConversationSummary(leadId, companyId) {
  const { rows: messages } = await query(
    `SELECT direction, sender_type, content, created_at FROM messages m
     JOIN conversations c ON m.conversation_id = c.id
     WHERE c.lead_id = $1 AND c.company_id = $2 ORDER BY m.created_at ASC LIMIT 30`,
    [leadId, companyId]
  );

  if (!messages.length) return 'No messages yet.';

  const transcript = messages.map(m =>
    `[${m.sender_type === 'customer' ? 'Customer' : 'AI'}]: ${m.content}`
  ).join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Summarise this sales conversation in 2-3 sentences. Note sentiment, main objection (if any), and likelihood to close.\n\n${transcript}`,
      }],
    });
    return response.content[0].text;
  } catch (err) {
    console.error('Summary error:', err.message);
    return 'Summary unavailable.';
  }
}

/**
 * AI objection handler — returns a suggested reply for a given objection.
 */
async function handleObjection(objection, companyId) {
  const { rows: articles } = await query(
    `SELECT content FROM knowledge_base WHERE company_id = $1 AND category = 'Objection handling' LIMIT 5`,
    [companyId]
  );
  const context = articles.map(a => a.content).join('\n');

  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: `Customer objection: "${objection}"\n\nKnowledge base:\n${context}\n\nWrite a 2-sentence WhatsApp reply that addresses this objection professionally.`,
      }],
    });
    return response.content[0].text;
  } catch (err) {
    return null;
  }
}

module.exports = { generateAIReply, generateConversationSummary, handleObjection };

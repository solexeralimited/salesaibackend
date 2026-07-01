const { query } = require('../db');
const { sendWhatsApp, sendWhatsAppTemplate } = require('./whatsappService');
const { sendEmail } = require('./emailService');
const { notifySlack } = require('./slackService');

/**
 * Trigger all active workflows matching the given event type.
 * @param {string} triggerType - e.g. 'lead_imported', 'score_dropped', 'meeting_booked'
 * @param {Object} lead - Lead object
 * @param {string} companyId
 */
async function triggerWorkflow(triggerType, lead, companyId) {
  try {
    const { rows: workflows } = await query(
      `SELECT * FROM workflows WHERE company_id = $1 AND trigger_type = $2 AND status = 'active'`,
      [companyId, triggerType]
    );

    for (const wf of workflows) {
      await executeWorkflow(wf, lead, companyId);
    }
  } catch (err) {
    console.error('Workflow trigger error:', err.message);
  }
}

async function executeWorkflow(workflow, lead, companyId) {
  const nodes = workflow.nodes || [];
  console.log(`Executing workflow "${workflow.name}" for lead ${lead.name}`);

  for (const node of nodes) {
    try {
      switch (node.type) {
        case 'send_whatsapp':
          if (lead.phone) {
            const { rows: [conv] } = await query(
              'SELECT id FROM conversations WHERE lead_id = $1 AND channel = $2 LIMIT 1',
              [lead.id, 'whatsapp']
            );
            // Check 24h window — use template if no recent inbound message
            const { rows: [lastInbound] } = conv ? await query(
              `SELECT created_at FROM messages WHERE conversation_id = $1 AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1`,
              [conv.id]
            ) : { rows: [] };
            const withinWindow = lastInbound && (Date.now() - new Date(lastInbound.created_at).getTime()) < 24 * 60 * 60 * 1000;

            if (!withinWindow) {
              // Cold lead — send approved template instead of free-form
              const { rows: [company] } = await query('SELECT name FROM companies WHERE id = $1', [companyId]);
              const firstName = lead.name.split(' ')[0];
              const components = [
                { type: 'body', parameters: [
                  { type: 'text', text: firstName },
                  { type: 'text', text: company?.name || 'our company' },
                ]},
              ];
              await sendWhatsAppTemplate(lead.phone, 'quote_ready', components, companyId);
              const preview = `Hi ${firstName}, your roofing quotation from ${company?.name || 'our company'} is now ready. [Template: quote_ready]`;
              if (conv) {
                await query(
                  `INSERT INTO messages (conversation_id, company_id, direction, sender_type, content, channel)
                   VALUES ($1,$2,'outbound','ai',$3,'whatsapp')`,
                  [conv.id, companyId, preview]
                );
              }
            } else {
              const msg = (node.config?.message || 'Hello {{name}}').replace('{{name}}', lead.name.split(' ')[0]);
              await sendWhatsApp(lead.phone, msg, companyId);
              if (conv) {
                await query(
                  `INSERT INTO messages (conversation_id, company_id, direction, sender_type, content, channel)
                   VALUES ($1,$2,'outbound','ai',$3,'whatsapp')`,
                  [conv.id, companyId, msg]
                );
              }
            }
          }
          break;

        case 'send_whatsapp_template': {
          if (lead.phone) {
            const { rows: [company] } = await query('SELECT name FROM companies WHERE id = $1', [companyId]);
            const firstName = lead.name.split(' ')[0];
            const templateName = node.config?.template_name || 'quote_ready';
            const components = [
              {
                type: 'body',
                parameters: [
                  { type: 'text', text: firstName },
                  { type: 'text', text: company?.name || 'our company' },
                ],
              },
            ];
            await sendWhatsAppTemplate(lead.phone, templateName, components, companyId);
            const { rows: [conv] } = await query(
              'SELECT id FROM conversations WHERE lead_id = $1 AND channel = $2 LIMIT 1',
              [lead.id, 'whatsapp']
            );
            if (conv) {
              const preview = `Hi ${firstName}, your roofing quotation from ${company?.name || 'our company'} is now ready. [Template: ${templateName}]`;
              await query(
                `INSERT INTO messages (conversation_id, company_id, direction, sender_type, content, channel)
                 VALUES ($1,$2,'outbound','ai',$3,'whatsapp')`,
                [conv.id, companyId, preview]
              );
            }
          }
          break;
        }

        case 'send_email':
          if (lead.email) {
            const subject = (node.config?.subject || 'Your roofing quote').replace('{{name}}', lead.name);
            const text = (node.config?.body || 'Hi {{name}}, following up on your quote.')
              .replace('{{name}}', lead.name.split(' ')[0]);
            await sendEmail({ to: lead.email, subject, text }, companyId);
          }
          break;

        case 'notify_slack': {
          const { rows: [company] } = await query('SELECT * FROM companies WHERE id = $1', [companyId]);
          await notifySlack(company, lead, node.config?.message || `Workflow triggered: ${workflow.name}`);
          break;
        }

        case 'update_stage':
          if (node.config?.stage) {
            await query(
              'UPDATE leads SET stage = $1, updated_at = NOW() WHERE id = $2',
              [node.config.stage, lead.id]
            );
          }
          break;

        case 'wait':
          // In production this would use a job queue (BullMQ) with a delay
          console.log(`Wait node: ${node.config?.hours || 24} hours`);
          break;

        default:
          console.log(`Unknown workflow node type: ${node.type}`);
      }

      await query(
        `INSERT INTO audit_logs (company_id, action, resource_type, resource_id, metadata)
         VALUES ($1, 'workflow_node_executed', 'lead', $2, $3)`,
        [companyId, lead.id, JSON.stringify({ workflow: workflow.name, node: node.type })]
      );
    } catch (nodeErr) {
      console.error(`Workflow node "${node.type}" failed:`, nodeErr.message);
    }
  }
}

module.exports = { triggerWorkflow };

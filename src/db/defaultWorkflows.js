// Default workflows provisioned for every company so 'quote_accepted' and
// 'meeting_requested' triggers do something out of the box, before a company
// customizes them via the Workflows UI. Deliberately notify_slack only (not
// send_whatsapp) — the AI auto-reply already responds to the lead on every
// inbound message, including these button replies, so a workflow-driven
// WhatsApp send here would double-message the lead.
const DEFAULT_WORKFLOWS = [
  {
    name: 'Quote accepted (default)',
    description: 'Notifies the team when a lead accepts their quote via WhatsApp',
    trigger_type: 'quote_accepted',
    nodes: [{ type: 'notify_slack', config: { message: 'Lead accepted their quote via WhatsApp' } }],
  },
  {
    name: 'Meeting requested (default)',
    description: 'Notifies the team when a lead requests a meeting via WhatsApp',
    trigger_type: 'meeting_requested',
    nodes: [{ type: 'notify_slack', config: { message: 'Lead requested a meeting via WhatsApp' } }],
  },
];

module.exports = { DEFAULT_WORKFLOWS };

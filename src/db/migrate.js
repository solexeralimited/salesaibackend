require('dotenv').config();
const { pool } = require('./index');

const migrations = [
  // ── Companies (tenants) ─────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    industry TEXT DEFAULT 'roofing',
    subdomain TEXT UNIQUE,
    logo_url TEXT,
    primary_channel TEXT DEFAULT 'whatsapp' CHECK (primary_channel IN ('whatsapp','email','both')),
    timezone TEXT DEFAULT 'Pacific/Auckland',
    ai_persona_name TEXT DEFAULT 'Aria',
    ai_escalation_threshold INT DEFAULT 40,
    ai_max_messages INT DEFAULT 8,
    whatsapp_phone_number_id TEXT,
    whatsapp_access_token TEXT,
    sendgrid_api_key TEXT,
    from_email TEXT,
    slack_webhook_url TEXT,
    google_calendar_token JSONB,
    business_hours JSONB DEFAULT '{"start":"08:00","end":"18:00","days":[1,2,3,4,5]}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ── Users ────────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'consultant' CHECK (role IN ('admin','consultant','viewer')),
    avatar_url TEXT,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(company_id, email)
  )`,

  // ── Leads ─────────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    assigned_to UUID REFERENCES users(id),
    name TEXT NOT NULL,
    email TEXT,
    phone TEXT,
    company_name TEXT,
    source TEXT DEFAULT 'manual',
    stage TEXT DEFAULT 'new' CHECK (stage IN ('new','contacted','replied','meeting','quoted','won','lost')),
    interest_score INT DEFAULT 50 CHECK (interest_score >= 0 AND interest_score <= 100),
    score_tier TEXT GENERATED ALWAYS AS (
      CASE WHEN interest_score >= 80 THEN 'green'
           WHEN interest_score >= 40 THEN 'amber'
           ELSE 'red' END
    ) STORED,
    ai_summary TEXT,
    ai_sentiment TEXT DEFAULT 'neutral',
    ai_main_objection TEXT,
    ai_mode_active BOOLEAN DEFAULT TRUE,
    external_crm_id TEXT,
    notes TEXT,
    tags TEXT[],
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ── Quotes ────────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS quotes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    reference TEXT NOT NULL,
    value NUMERIC(12,2) NOT NULL,
    description TEXT,
    line_items JSONB DEFAULT '[]'::jsonb,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending','sent','accepted','declined','expired')),
    sent_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ── Conversations ─────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    channel TEXT NOT NULL CHECK (channel IN ('whatsapp','email','sms')),
    status TEXT DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
    ai_active BOOLEAN DEFAULT TRUE,
    escalated_to UUID REFERENCES users(id),
    escalated_at TIMESTAMPTZ,
    last_message_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ── Messages ──────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
    sender_type TEXT NOT NULL CHECK (sender_type IN ('customer','ai','human')),
    sender_id UUID REFERENCES users(id),
    content TEXT NOT NULL,
    channel TEXT NOT NULL CHECK (channel IN ('whatsapp','email','sms')),
    external_message_id TEXT,
    status TEXT DEFAULT 'sent' CHECK (status IN ('pending','sent','delivered','read','failed')),
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ── Meetings ──────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS meetings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    assigned_to UUID REFERENCES users(id),
    title TEXT NOT NULL,
    scheduled_at TIMESTAMPTZ NOT NULL,
    duration_minutes INT DEFAULT 30,
    status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled','no_show')),
    google_event_id TEXT,
    meeting_url TEXT,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ── Interest scores (history) ─────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS interest_score_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    score INT NOT NULL,
    reason TEXT,
    triggered_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ── Workflows ─────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS workflows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'draft' CHECK (status IN ('active','draft','paused')),
    trigger_type TEXT NOT NULL,
    trigger_config JSONB DEFAULT '{}'::jsonb,
    nodes JSONB DEFAULT '[]'::jsonb,
    edges JSONB DEFAULT '[]'::jsonb,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ── Knowledge base ────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS knowledge_base (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT[],
    embedding_vector TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ── Audit log ─────────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id UUID,
    metadata JSONB DEFAULT '{}'::jsonb,
    ip_address INET,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ── Indexes ───────────────────────────────────────────────────────────────────
  `CREATE INDEX IF NOT EXISTS idx_leads_company ON leads(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(company_id, stage)`,
  `CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(company_id, interest_score)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id)`,
  `CREATE INDEX IF NOT EXISTS idx_conversations_lead ON conversations(lead_id)`,
  `CREATE INDEX IF NOT EXISTS idx_meetings_company ON meetings(company_id, scheduled_at)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_company ON audit_logs(company_id, created_at)`,
];

async function migrate() {
  console.log('🗄  Running database migrations...\n');
  const client = await pool.connect();
  try {
    for (const sql of migrations) {
      const preview = sql.split('\n')[0].substring(0, 60);
      await client.query(sql);
      console.log(`  ✓ ${preview}`);
    }
    console.log('\n✅ All migrations complete.\n');
  } catch (err) {
    console.error('\n❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();

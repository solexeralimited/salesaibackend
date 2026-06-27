require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('./index');

async function seed() {
  console.log('🌱 Seeding database with demo data...\n');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Company
    const { rows: [company] } = await client.query(`
      INSERT INTO companies (name, industry, subdomain, primary_channel, ai_persona_name, from_email)
      VALUES ('RoofPro Auckland', 'roofing', 'roofpro', 'whatsapp', 'Aria', 'aria@roofpro.nz')
      ON CONFLICT (subdomain) DO UPDATE SET name = EXCLUDED.name
      RETURNING *
    `);
    console.log(`  ✓ Company: ${company.name} (${company.id})`);

    // Users
    const hash = await bcrypt.hash('demo1234', 10);
    const users = await Promise.all([
      client.query(`
        INSERT INTO users (company_id, email, password_hash, name, role)
        VALUES ($1, 'admin@roofpro.nz', $2, 'Admin User', 'admin')
        ON CONFLICT (company_id, email) DO UPDATE SET name = EXCLUDED.name RETURNING *
      `, [company.id, hash]),
      client.query(`
        INSERT INTO users (company_id, email, password_hash, name, role)
        VALUES ($1, 'james@roofpro.nz', $2, 'James Morris', 'consultant')
        ON CONFLICT (company_id, email) DO UPDATE SET name = EXCLUDED.name RETURNING *
      `, [company.id, hash]),
      client.query(`
        INSERT INTO users (company_id, email, password_hash, name, role)
        VALUES ($1, 'kelly@roofpro.nz', $2, 'Kelly Lee', 'consultant')
        ON CONFLICT (company_id, email) DO UPDATE SET name = EXCLUDED.name RETURNING *
      `, [company.id, hash]),
    ]);
    const [admin, james, kelly] = users.map(r => r.rows[0]);
    console.log(`  ✓ Users: admin, James Morris, Kelly Lee`);

    // Leads
    const leadData = [
      { name: 'Marcus Webb', email: 'm.webb@webbres.nz', phone: '+6421555182', company_name: 'Webb Residences', score: 87, stage: 'replied', assigned: james.id },
      { name: 'Sarah Nguyen', email: 's.nguyen@nguyen.nz', phone: '+6421555291', company_name: 'Nguyen Holdings', score: 91, stage: 'meeting', assigned: kelly.id },
      { name: 'David Park', email: 'd.park@parkroofing.nz', phone: '+6421555038', company_name: 'Park Roofing', score: 22, stage: 'lost', assigned: james.id },
      { name: 'Emma Taylor', email: 'e.taylor@taylorbuilds.nz', phone: '+6421555447', company_name: 'Taylor Builds', score: 61, stage: 'contacted', assigned: null },
      { name: 'Liam Okoye', email: 'l.okoye@okoyeco.nz', phone: '+6421555563', company_name: 'OkoyeCo', score: 74, stage: 'replied', assigned: kelly.id },
      { name: 'Ava Singh', email: 'a.singh@singhprop.nz', phone: '+6421555612', company_name: 'Singh Properties', score: 93, stage: 'won', assigned: james.id },
    ];

    for (const lead of leadData) {
      const { rows: [l] } = await client.query(`
        INSERT INTO leads (company_id, assigned_to, name, email, phone, company_name, interest_score, stage, source, ai_summary)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'crm_import','AI-generated summary pending')
        ON CONFLICT DO NOTHING RETURNING *
      `, [company.id, lead.assigned, lead.name, lead.email, lead.phone, lead.company_name, lead.score, lead.stage]);
      if (l) {
        // Quote
        await client.query(`
          INSERT INTO quotes (lead_id, company_id, reference, value, description, status)
          VALUES ($1,$2,$3,$4,'Metal standing seam roof replacement','sent')
        `, [l.id, company.id, `QT-${Math.floor(1000+Math.random()*9000)}`, Math.floor(8000+Math.random()*35000)]);
        // Conversation
        const { rows: [conv] } = await client.query(`
          INSERT INTO conversations (lead_id, company_id, channel, ai_active)
          VALUES ($1,$2,'whatsapp',true) RETURNING *
        `, [l.id, company.id]);
        // Seed a few messages
        await client.query(`
          INSERT INTO messages (conversation_id, company_id, direction, sender_type, content, channel)
          VALUES
            ($1,$2,'outbound','ai',$3,'whatsapp'),
            ($1,$2,'inbound','customer','Hi, yes I have some questions about the quote.','whatsapp'),
            ($1,$2,'outbound','ai','Great! I am happy to help. What would you like to know?','whatsapp')
        `, [conv.id, company.id, `Hi ${lead.name.split(' ')[0]}, I'm Aria from RoofPro. I'm reaching out about your roofing quote. Do you have a moment to chat?`]);
      }
    }
    console.log(`  ✓ Leads, quotes, conversations and messages seeded`);

    // Knowledge base
    const kbArticles = [
      { category: 'Warranty FAQ', title: '15-year workmanship warranty explained', content: 'Our workmanship warranty covers any defects in the installation for 15 years from the date of completion. This includes flashing, ridge capping, and waterproofing membranes.' },
      { category: 'Roofing products', title: 'Colorsteel metal roofing overview', content: 'Colorsteel is New Zealand\'s premium pre-painted steel roofing product, backed by a 50-year manufacturer warranty on the coating against peeling, cracking, and fading.' },
      { category: 'Pricing & discounts', title: 'Discount policy', content: 'We offer up to 5% discount for contracts signed within 14 days of quote issue. Discounts above 5% require manager approval.' },
      { category: 'Objection handling', title: 'Price too high', content: 'Acknowledge the concern. Explain the value of our warranty, local reputation, and licensed tradespeople. Offer to break down the quote line by line. Consider offering a discount if within policy.' },
      { category: 'About the company', title: 'About RoofPro Auckland', content: 'RoofPro Auckland has been serving Auckland homeowners since 2005. We are a Licensed Building Practitioner (LBP) company with over 2,000 roofs replaced.' },
    ];
    for (const article of kbArticles) {
      await client.query(`
        INSERT INTO knowledge_base (company_id, category, title, content, created_by)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING
      `, [company.id, article.category, article.title, article.content, admin.id]);
    }
    console.log(`  ✓ Knowledge base articles seeded`);

    await client.query('COMMIT');
    console.log('\n✅ Seed complete.\n');
    console.log('   Login credentials:');
    console.log('   Email:    admin@roofpro.nz');
    console.log('   Password: demo1234\n');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Seed failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();

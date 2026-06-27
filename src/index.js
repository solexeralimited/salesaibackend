require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const authRoutes = require('./routes/auth');
const leadRoutes = require('./routes/leads');
const conversationRoutes = require('./routes/conversations');
const analyticsRoutes = require('./routes/analytics');
const workflowRoutes = require('./routes/workflows');
const knowledgeBaseRoutes = require('./routes/knowledgeBase');
const calendarRoutes = require('./routes/calendar');
const webhookRoutes = require('./routes/webhooks');
const companyRoutes = require('./routes/companies');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 4000;

// Security & middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(morgan('dev'));

// Raw body for webhook signature verification (must be before json parser)
app.use('/api/webhooks', express.raw({ type: 'application/json' }));

// JSON parsing for all other routes
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/workflows', workflowRoutes);
app.use('/api/knowledge-base', knowledgeBaseRoutes);
app.use('/api/calendar', calendarRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/companies', companyRoutes);

// Global error handler
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`\n🚀 SalesAI Backend running on http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Database:    ${process.env.DATABASE_URL ? 'configured' : '⚠ DATABASE_URL not set'}`);
  console.log(`   AI:          ${process.env.ANTHROPIC_API_KEY ? 'configured' : '⚠ ANTHROPIC_API_KEY not set'}\n`);
});

module.exports = app;

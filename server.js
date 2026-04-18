require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── DATABASE SETUP ──────────────────────────────────────────────────
const db = new Database(process.env.DB_PATH || './crm.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT DEFAULT '',
    phone       TEXT DEFAULT '',
    company     TEXT DEFAULT '',
    source      TEXT DEFAULT 'Manual',
    stage       TEXT DEFAULT 'New Lead',
    value       REAL DEFAULT 0,
    notes       TEXT DEFAULT '',
    assigned_to TEXT DEFAULT '',
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS activities (
    id           TEXT PRIMARY KEY,
    lead_id      TEXT NOT NULL,
    type         TEXT NOT NULL,
    title        TEXT DEFAULT '',
    content      TEXT DEFAULT '',
    duration_min INTEGER,
    scheduled_at DATETIME,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS email_templates (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    subject       TEXT NOT NULL,
    body          TEXT NOT NULL,
    stage_trigger TEXT,
    delay_hours   INTEGER DEFAULT 0,
    active        INTEGER DEFAULT 1,
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS emails (
    id           TEXT PRIMARY KEY,
    lead_id      TEXT NOT NULL,
    template_id  TEXT,
    subject      TEXT NOT NULL,
    body         TEXT NOT NULL,
    status       TEXT DEFAULT 'pending',
    scheduled_at DATETIME,
    sent_at      DATETIME,
    error_msg    TEXT,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

// ─── SEED DATA ───────────────────────────────────────────────────────
const leadCount = db.prepare('SELECT COUNT(*) as c FROM leads').get().c;
if (leadCount === 0) {
  const ins = db.prepare(`INSERT INTO leads (id,name,email,phone,company,source,stage,value,notes)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const leads = [
    [uuidv4(),'Sarah Johnson','sarah@techcorp.com','+1-555-0101','TechCorp','Website','Qualified',15000,'Interested in enterprise plan. Very responsive.'],
    [uuidv4(),'Mike Chen','mike@startupxyz.com','+1-555-0102','StartupXYZ','Referral','Proposal Sent',8500,'Needs custom API integration. Sent proposal on Monday.'],
    [uuidv4(),'Emma Davis','emma@bigco.com','+1-555-0103','BigCo Inc','LinkedIn','New Lead',25000,'Came from LinkedIn campaign. CMO level contact.'],
    [uuidv4(),'James Wilson','james@retailbrand.com','+1-555-0104','Retail Brand','Cold Outreach','Contacted',5000,'Responded to cold email. Booked intro call.'],
    [uuidv4(),'Lisa Park','lisa@mediaco.com','+1-555-0105','MediaCo','Conference','Negotiation',18000,'Met at SaaS Summit. Close to agreement on pricing.'],
    [uuidv4(),'Robert Smith','robert@fintech.io','+1-555-0106','FinTech.io','Website','Closed Won',12000,'Signed 12-month contract. Onboarding in progress.'],
    [uuidv4(),'Anna Brown','anna@healthco.com','+1-555-0107','HealthCo','Referral','Closed Lost',9000,'Went with competitor. Budget was main issue.'],
    [uuidv4(),'David Lee','david@saasco.com','+1-555-0108','SaaSCo','Google Ads','Qualified',22000,'Trial user converting to paid. High intent.'],
  ];
  leads.forEach(l => ins.run(...l));

  // Sample activities
  const insA = db.prepare(`INSERT INTO activities (id,lead_id,type,title,content,duration_min,created_at) VALUES (?,?,?,?,?,?,?)`);
  const allLeads = db.prepare('SELECT id FROM leads').all();
  const types = ['call','email','note','meeting'];
  const samples = [
    ['Intro call completed','15-minute discovery call. Good fit, moving to qualified.',15],
    ['Sent product overview','Emailed product deck and pricing sheet.',null],
    ['Left voicemail','Called but no answer, left voicemail.',null],
    ['Meeting scheduled','Demo scheduled for next Tuesday at 2pm.',null],
    ['Follow-up note','Strong interest in analytics module.',null],
  ];
  allLeads.forEach((lead, i) => {
    const s = samples[i % samples.length];
    const t = types[i % types.length];
    const d = new Date(Date.now() - (i * 86400000 * 2)).toISOString();
    insA.run(uuidv4(), lead.id, t, s[0], s[1], s[2], d);
  });
}

const tmplCount = db.prepare('SELECT COUNT(*) as c FROM email_templates').get().c;
if (tmplCount === 0) {
  const insT = db.prepare(`INSERT INTO email_templates (id,name,subject,body,stage_trigger,delay_hours) VALUES (?,?,?,?,?,?)`);
  const templates = [
    [uuidv4(),'Initial Outreach','Quick question about {{company}}',
     `Hi {{name}},\n\nI noticed {{company}} and thought there could be a great fit with what we do.\n\nWe help companies like yours [YOUR VALUE PROP]. I'd love to show you how in a quick 15-minute call.\n\nWould you be open to connecting this week?\n\nBest regards,\n{{sender}}`,
     'Contacted', 0],
    [uuidv4(),'Follow-up #1','Re: {{company}} — following up',
     `Hi {{name}},\n\nJust wanted to follow up on my last message in case it got buried.\n\nI genuinely think there's something here for {{company}} and would love just 15 minutes to show you why.\n\nWorth a quick chat?\n\nBest,\n{{sender}}`,
     'Contacted', 72],
    [uuidv4(),'Follow-up #2','Last note — {{company}}',
     `Hi {{name}},\n\nI'll keep this short — I don't want to be a nuisance. This will be my last follow-up.\n\nIf the timing ever makes sense, feel free to book a call at your convenience: [CALENDAR LINK]\n\nWishing you and the team at {{company}} all the best.\n\n{{sender}}`,
     'Contacted', 168],
    [uuidv4(),'Proposal Follow-up','Re: Proposal for {{company}}',
     `Hi {{name}},\n\nI wanted to follow up on the proposal I sent over. Do you have any questions I can help answer?\n\nI'm happy to jump on a quick call to walk through any details, adjust pricing, or discuss next steps.\n\nLooking forward to hearing from you,\n{{sender}}`,
     'Proposal Sent', 48],
    [uuidv4(),'Negotiation Check-in','Checking in — {{company}} proposal',
     `Hi {{name}},\n\nJust checking in to see if there's anything else you need from my side to move things forward.\n\nI can get on a call with your team any time this week if that would help.\n\nBest,\n{{sender}}`,
     'Negotiation', 24],
    [uuidv4(),'Welcome / Onboarding','Welcome to the team, {{name}}! 🎉',
     `Hi {{name}},\n\nExcited to have {{company}} on board!\n\nHere's everything you need to get started:\n\n1. [ONBOARDING LINK]\n2. Schedule your kickoff call: [CALENDAR LINK]\n3. Join our Slack community: [SLACK LINK]\n\nYour dedicated account manager will reach out within 24 hours.\n\nWelcome aboard!\n{{sender}}`,
     'Closed Won', 0],
  ];
  templates.forEach(t => insT.run(...t));
}

// ─── EMAIL HELPERS ───────────────────────────────────────────────────
function getEmailConfig() {
  const rows = db.prepare('SELECT key, value FROM settings WHERE key IN (?,?,?)').all('email_user','email_pass','sender_name');
  const cfg = {};
  rows.forEach(r => { cfg[r.key] = r.value; });
  return {
    user:   cfg.email_user   || process.env.GMAIL_USER || '',
    pass:   cfg.email_pass   || process.env.GMAIL_APP_PASSWORD || '',
    name:   cfg.sender_name  || process.env.SENDER_NAME || 'CRM',
  };
}

function createTransporter() {
  const { user, pass } = getEmailConfig();
  if (!user || !pass) return null;
  return nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
}

function interpolate(text, lead, senderName) {
  return text
    .replace(/\{\{name\}\}/g,    lead.name    || '')
    .replace(/\{\{company\}\}/g, lead.company || '')
    .replace(/\{\{email\}\}/g,   lead.email   || '')
    .replace(/\{\{phone\}\}/g,   lead.phone   || '')
    .replace(/\{\{stage\}\}/g,   lead.stage   || '')
    .replace(/\{\{sender\}\}/g,  senderName   || 'The Team');
}

async function sendEmail(leadId, subject, body, emailId) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
  if (!lead?.email) {
    db.prepare("UPDATE emails SET status='failed', error_msg='No email address on lead' WHERE id=?").run(emailId);
    return { ok: false, error: 'No email on lead' };
  }
  const cfg = getEmailConfig();
  const t = createTransporter();
  if (!t) {
    db.prepare("UPDATE emails SET status='failed', error_msg='Gmail not configured in Settings' WHERE id=?").run(emailId);
    return { ok: false, error: 'Gmail not configured' };
  }
  const finalSubject = interpolate(subject, lead, cfg.name);
  const finalBody    = interpolate(body,    lead, cfg.name);
  try {
    await t.sendMail({
      from: `"${cfg.name}" <${cfg.user}>`,
      to:   lead.email,
      subject: finalSubject,
      text:    finalBody,
      html:    '<pre style="font-family:Arial,sans-serif;white-space:pre-wrap">' + finalBody.replace(/</g,'&lt;') + '</pre>',
    });
    db.prepare("UPDATE emails SET status='sent', sent_at=CURRENT_TIMESTAMP WHERE id=?").run(emailId);
    db.prepare(`INSERT INTO activities (id,lead_id,type,title,content) VALUES (?,?,?,?,?)`)
      .run(uuidv4(), leadId, 'email', 'Email sent: ' + finalSubject, finalBody.slice(0,600));
    db.prepare("UPDATE leads SET updated_at=CURRENT_TIMESTAMP WHERE id=?").run(leadId);
    return { ok: true };
  } catch (err) {
    db.prepare("UPDATE emails SET status='failed', error_msg=? WHERE id=?").run(err.message, emailId);
    return { ok: false, error: err.message };
  }
}

function scheduleAutomation(leadId, stage) {
  const tmpls = db.prepare("SELECT * FROM email_templates WHERE stage_trigger=? AND active=1").all(stage);
  for (const t of tmpls) {
    const scheduledAt = new Date(Date.now() + t.delay_hours * 3_600_000).toISOString().replace('T',' ').slice(0,19);
    const eid = uuidv4();
    const status = t.delay_hours === 0 ? 'pending' : 'scheduled';
    db.prepare(`INSERT INTO emails (id,lead_id,template_id,subject,body,status,scheduled_at) VALUES (?,?,?,?,?,?,?)`)
      .run(eid, leadId, t.id, t.subject, t.body, status, scheduledAt);
    if (t.delay_hours === 0) sendEmail(leadId, t.subject, t.body, eid);
  }
}

// ─── CRON: Run every 5 min, send due scheduled emails ────────────────
cron.schedule('*/5 * * * *', async () => {
  const due = db.prepare("SELECT * FROM emails WHERE status='scheduled' AND scheduled_at <= datetime('now')").all();
  for (const e of due) {
    db.prepare("UPDATE emails SET status='sending' WHERE id=?").run(e.id);
    await sendEmail(e.lead_id, e.subject, e.body, e.id);
  }
  if (due.length > 0) console.log(`[CRON] Processed ${due.length} scheduled email(s)`);
});

// ─── LEAD ROUTES ─────────────────────────────────────────────────────
app.get('/api/leads', (req, res) => {
  const { stage, search, source } = req.query;
  let sql = 'SELECT * FROM leads WHERE 1=1';
  const p = [];
  if (stage)  { sql += ' AND stage=?';  p.push(stage); }
  if (source) { sql += ' AND source=?'; p.push(source); }
  if (search) {
    sql += ' AND (name LIKE ? OR email LIKE ? OR company LIKE ? OR phone LIKE ?)';
    p.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`);
  }
  sql += ' ORDER BY updated_at DESC';
  res.json(db.prepare(sql).all(...p));
});

app.post('/api/leads', (req, res) => {
  const { name, email='', phone='', company='', source='Manual', stage='New Lead', value=0, notes='' } = req.body;
  const id = uuidv4();
  db.prepare(`INSERT INTO leads (id,name,email,phone,company,source,stage,value,notes) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, name, email, phone, company, source, stage, value, notes);
  db.prepare(`INSERT INTO activities (id,lead_id,type,title,content) VALUES (?,?,?,?,?)`)
    .run(uuidv4(), id, 'note', 'Lead created', `Source: ${source}`);
  res.json(db.prepare('SELECT * FROM leads WHERE id=?').get(id));
});

app.get('/api/leads/:id', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  res.json(lead);
});

app.put('/api/leads/:id', (req, res) => {
  const old = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: 'Not found' });
  const { name, email, phone, company, source, stage, value, notes, assigned_to } = req.body;
  db.prepare(`UPDATE leads SET name=?,email=?,phone=?,company=?,source=?,stage=?,value=?,notes=?,assigned_to=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(name, email, phone, company, source, stage, value, notes, assigned_to||'', req.params.id);
  if (old.stage !== stage) {
    db.prepare(`INSERT INTO activities (id,lead_id,type,title,content) VALUES (?,?,?,?,?)`)
      .run(uuidv4(), req.params.id, 'stage_change', `Moved to ${stage}`, `Stage: ${old.stage} → ${stage}`);
    scheduleAutomation(req.params.id, stage);
  }
  res.json(db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id));
});

app.patch('/api/leads/:id/stage', (req, res) => {
  const { stage } = req.body;
  const old = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE leads SET stage=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(stage, req.params.id);
  if (old.stage !== stage) {
    db.prepare(`INSERT INTO activities (id,lead_id,type,title,content) VALUES (?,?,?,?,?)`)
      .run(uuidv4(), req.params.id, 'stage_change', `Moved to ${stage}`, `${old.stage} → ${stage}`);
    scheduleAutomation(req.params.id, stage);
  }
  res.json({ ok: true });
});

app.delete('/api/leads/:id', (req, res) => {
  db.prepare('DELETE FROM leads WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─── ACTIVITY ROUTES ─────────────────────────────────────────────────
app.get('/api/activities/:leadId', (req, res) => {
  res.json(db.prepare('SELECT * FROM activities WHERE lead_id=? ORDER BY created_at DESC').all(req.params.leadId));
});

app.post('/api/activities', (req, res) => {
  const { lead_id, type, title='', content='', duration_min, scheduled_at } = req.body;
  const id = uuidv4();
  db.prepare(`INSERT INTO activities (id,lead_id,type,title,content,duration_min,scheduled_at) VALUES (?,?,?,?,?,?,?)`)
    .run(id, lead_id, type, title, content, duration_min||null, scheduled_at||null);
  db.prepare("UPDATE leads SET updated_at=CURRENT_TIMESTAMP WHERE id=?").run(lead_id);
  res.json(db.prepare('SELECT * FROM activities WHERE id=?').get(id));
});

app.delete('/api/activities/:id', (req, res) => {
  db.prepare('DELETE FROM activities WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─── EMAIL TEMPLATE ROUTES ───────────────────────────────────────────
app.get('/api/templates', (req, res) => {
  res.json(db.prepare('SELECT * FROM email_templates ORDER BY stage_trigger, delay_hours').all());
});

app.post('/api/templates', (req, res) => {
  const { name, subject, body, stage_trigger='', delay_hours=0 } = req.body;
  const id = uuidv4();
  db.prepare(`INSERT INTO email_templates (id,name,subject,body,stage_trigger,delay_hours) VALUES (?,?,?,?,?,?)`)
    .run(id, name, subject, body, stage_trigger||null, delay_hours);
  res.json(db.prepare('SELECT * FROM email_templates WHERE id=?').get(id));
});

app.put('/api/templates/:id', (req, res) => {
  const { name, subject, body, stage_trigger, delay_hours, active } = req.body;
  db.prepare(`UPDATE email_templates SET name=?,subject=?,body=?,stage_trigger=?,delay_hours=?,active=? WHERE id=?`)
    .run(name, subject, body, stage_trigger||null, delay_hours||0, active===false?0:1, req.params.id);
  res.json(db.prepare('SELECT * FROM email_templates WHERE id=?').get(req.params.id));
});

app.delete('/api/templates/:id', (req, res) => {
  db.prepare('DELETE FROM email_templates WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─── EMAIL SEND / HISTORY ────────────────────────────────────────────
app.get('/api/emails/:leadId', (req, res) => {
  res.json(db.prepare('SELECT * FROM emails WHERE lead_id=? ORDER BY created_at DESC').all(req.params.leadId));
});

app.post('/api/emails/send', async (req, res) => {
  const { lead_id, subject, body, scheduled_at } = req.body;
  const eid = uuidv4();
  const status = scheduled_at ? 'scheduled' : 'pending';
  db.prepare(`INSERT INTO emails (id,lead_id,subject,body,status,scheduled_at) VALUES (?,?,?,?,?,?)`)
    .run(eid, lead_id, subject, body, status, scheduled_at||null);
  if (!scheduled_at) {
    const result = await sendEmail(lead_id, subject, body, eid);
    return res.json({ ...result, emailId: eid });
  }
  res.json({ ok: true, emailId: eid, scheduled: scheduled_at });
});

// ─── ANALYTICS ───────────────────────────────────────────────────────
app.get('/api/analytics/overview', (req, res) => {
  const total      = db.prepare('SELECT COUNT(*) as c FROM leads').get().c;
  const pipeline   = db.prepare("SELECT COALESCE(SUM(value),0) as v FROM leads WHERE stage NOT IN ('Closed Won','Closed Lost')").get().v;
  const won        = db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(value),0) as v FROM leads WHERE stage='Closed Won'").get();
  const lost       = db.prepare("SELECT COUNT(*) as c FROM leads WHERE stage='Closed Lost'").get().c;
  const active     = db.prepare("SELECT COUNT(*) as c FROM leads WHERE stage NOT IN ('Closed Won','Closed Lost')").get().c;
  const emails     = db.prepare("SELECT COUNT(*) as c FROM emails WHERE status='sent'").get().c;
  const calls      = db.prepare("SELECT COUNT(*) as c FROM activities WHERE type='call'").get().c;
  const scheduled  = db.prepare("SELECT COUNT(*) as c FROM emails WHERE status='scheduled'").get().c;
  const totalClosed = won.c + lost;
  const winRate    = totalClosed > 0 ? Math.round((won.c / totalClosed) * 100) : 0;
  res.json({ total, pipeline, wonCount: won.c, wonRevenue: won.v, lost, active, emails, calls, winRate, scheduled });
});

app.get('/api/analytics/pipeline', (req, res) => {
  const stages = ['New Lead','Contacted','Qualified','Proposal Sent','Negotiation','Closed Won','Closed Lost'];
  const data = stages.map(stage => {
    const r = db.prepare('SELECT COUNT(*) as count, COALESCE(SUM(value),0) as value FROM leads WHERE stage=?').get(stage);
    return { stage, count: r.count, value: r.value };
  });
  res.json(data);
});

app.get('/api/analytics/sources', (req, res) => {
  res.json(db.prepare('SELECT source, COUNT(*) as count, COALESCE(SUM(value),0) as value FROM leads GROUP BY source ORDER BY count DESC').all());
});

app.get('/api/analytics/trend', (req, res) => {
  const rows = db.prepare(`SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as leads, COALESCE(SUM(value),0) as value FROM leads GROUP BY month ORDER BY month DESC LIMIT 8`).all();
  res.json(rows.reverse());
});

app.get('/api/analytics/activities', (req, res) => {
  res.json(db.prepare('SELECT type, COUNT(*) as count FROM activities GROUP BY type ORDER BY count DESC').all());
});

app.get('/api/analytics/conversion', (req, res) => {
  const stages = ['New Lead','Contacted','Qualified','Proposal Sent','Negotiation','Closed Won'];
  const data = stages.map(s => ({ stage: s, count: db.prepare('SELECT COUNT(*) as c FROM leads WHERE stage=?').get(s).c }));
  res.json(data);
});

// ─── SETTINGS ────────────────────────────────────────────────────────
app.get('/api/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const obj = {};
  rows.forEach(r => { obj[r.key] = r.value; });
  if (obj.email_pass) obj.email_pass = '••••••••••';
  // Include env fallbacks (masked)
  if (!obj.email_user && process.env.GMAIL_USER) obj.email_user = process.env.GMAIL_USER;
  res.json(obj);
});

app.post('/api/settings', (req, res) => {
  const allowed = ['email_user','email_pass','sender_name','company_name'];
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
  for (const [k, v] of Object.entries(req.body)) {
    if (allowed.includes(k) && v && !v.includes('•')) upsert.run(k, v);
  }
  res.json({ ok: true });
});

app.post('/api/settings/test-email', async (req, res) => {
  const t = createTransporter();
  if (!t) return res.json({ ok: false, error: 'Email credentials not configured. Go to Settings and add your Gmail address and App Password.' });
  const cfg = getEmailConfig();
  try {
    await t.sendMail({ from: cfg.user, to: cfg.user, subject: 'CRM Test Email ✅', text: 'Your CRM email integration is working perfectly!' });
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// ─── CATCH-ALL (SPA) ─────────────────────────────────────────────────
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`\n🚀 CRM running at http://localhost:${PORT}`);
  console.log(`   Gmail configured: ${!!getEmailConfig().user}`);
});

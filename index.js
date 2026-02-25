const express = require('express');
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const SUPABASE_URL = 'https://atyxnuzykfhppbtsfogd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF0eXhudXp5a2ZocHBidHNmb2dkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5NTcwNDcsImV4cCI6MjA4NzUzMzA0N30._JAkiG9WVJ_0BIMoOknWEJQCG4DQT1nLYguDj7Tt4wQ';

const TWILIO_SID = 'AC22dd13eb357286b3b06c6f88b41cb6ec';
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const TWILIO_FROM = 'whatsapp:+14155238886';

const MINUTES_PER_PATIENT = 10;

const headers = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json'
};

async function getPatientByStatus(phone, status) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/patients?phone=eq.${encodeURIComponent(phone)}&status=eq.${status}&select=*`, { headers });
  const data = await res.json();
  return data.length > 0 ? data[0] : null;
}

async function sendWhatsApp(to, message) {
  const credentials = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ From: TWILIO_FROM, To: to, Body: message })
  });
}

app.post('/webhook', async (req, res) => {
  const from = req.body.From;
  const msg = (req.body.Body || '').trim();
  let reply = '';

  try {
    const waiting = await getPatientByStatus(from, 'waiting');
    if (waiting) {
      const aheadRes = await fetch(`${SUPABASE_URL}/rest/v1/patients?status=eq.waiting&queue_number=lt.${waiting.queue_number}&select=id`, { headers });
      const ahead = await aheadRes.json();
      const waitMinutes = ahead.length * MINUTES_PER_PATIENT;
      reply = waitMinutes === 0
        ? `Hi *${waiting.name}*! 🏥 You are *next in line* (number *${waiting.queue_number}*). Please be ready!`
        : `Hi *${waiting.name}*! 🏥 You are number *${waiting.queue_number}* in the queue.\n\nEstimated wait: *~${waitMinutes} minutes*. We'll notify you when it's your turn!`;

    } else if (await getPatientByStatus(from, 'pending_reason')) {
      const pending = await getPatientByStatus(from, 'pending_reason');
      const countRes = await fetch(`${SUPABASE_URL}/rest/v1/patients?status=eq.waiting&select=id`, { headers });
      const waitingList = await countRes.json();
      const queueNumber = waitingList.length + 1;
      const waitMinutes = waitingList.length * MINUTES_PER_PATIENT;

      await fetch(`${SUPABASE_URL}/rest/v1/patients?phone=eq.${encodeURIComponent(from)}&status=eq.pending_reason`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ reason: msg, status: 'waiting', queue_number: queueNumber })
      });

      reply = waitMinutes === 0
        ? `Thank you, *${pending.name}*! 🏥 You are number *${queueNumber}* — you're next! Please be ready.`
        : `Thank you, *${pending.name}*! 🏥 You are number *${queueNumber}* in the queue.\n\nEstimated wait: *~${waitMinutes} minutes*. We'll notify you when it's your turn!`;

    } else if (await getPatientByStatus(from, 'pending_name')) {
      await fetch(`${SUPABASE_URL}/rest/v1/patients?phone=eq.${encodeURIComponent(from)}&status=eq.pending_name`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ name: msg, status: 'pending_reason' })
      });
      reply = `Thank you, *${msg}*! 😊\n\nPlease reply with your *reason for visit* (e.g. fever, checkup, follow-up):`;

    } else {
      await fetch(`${SUPABASE_URL}/rest/v1/patients`, {
        method: 'POST',
        headers: { ...headers, 'Prefer': 'return=representation' },
        body: JSON.stringify({ phone: from, status: 'pending_name' })
      });
      reply = `Welcome to our clinic! 👋 Please reply with your *full name* to join the queue.`;
    }

  } catch (err) {
    console.error('Error:', err);
    reply = 'Sorry, something went wrong. Please try again.';
  }

  const response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${reply}</Message>
</Response>`;
  res.set('Content-Type', 'text/xml');
  res.send(response);
});

app.post('/done', async (req, res) => {
  const { id } = req.body;

  await fetch(`${SUPABASE_URL}/rest/v1/patients?id=eq.${id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'done' })
  });

  const nextRes = await fetch(`${SUPABASE_URL}/rest/v1/patients?status=eq.waiting&order=queue_number.asc&limit=1&select=*`, { headers });
  const nextPatients = await nextRes.json();

  if (nextPatients.length > 0) {
    const next = nextPatients[0];
    await sendWhatsApp(next.phone, `🔔 *${next.name}*, it's your turn! Please come in now. The doctor is ready for you. 🏥`);
  }

  res.json({ success: true });
});

app.get('/doctor', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  // Get today's stats
  const [waitingRes, doneRes, allTodayRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/patients?status=eq.waiting&order=queue_number.asc&select=*`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/patients?status=eq.done&created_at=gte.${today}T00:00:00&select=id`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/patients?created_at=gte.${today}T00:00:00&select=id`, { headers })
  ]);

  const patients = await waitingRes.json();
  const doneToday = await doneRes.json();
  const allToday = await allTodayRes.json();

  const totalSeen = doneToday.length;
  const totalWaiting = patients.length;
  const totalToday = allToday.length;

  const rows = patients.map((p, i) => {
    const waitMins = i * MINUTES_PER_PATIENT;
    return `
    <tr id="row-${p.id}">
      <td>${p.queue_number}</td>
      <td>${p.name || 'Unknown'}</td>
      <td>${p.phone.replace('whatsapp:', '')}</td>
      <td>${p.reason || '—'}</td>
      <td>${new Date(p.created_at).toLocaleTimeString()}</td>
      <td>${waitMins === 0 ? '🟢 Next' : `~${waitMins} mins`}</td>
      <td><button onclick="markDone(${p.id})">✅ Done</button></td>
    </tr>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Clinic Doctor Panel</title>
  <meta http-equiv="refresh" content="15">
  <style>
    body { font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5; }
    h1 { color: #2c3e50; }
    .stats { display: flex; gap: 16px; margin-bottom: 24px; }
    .stat-card { background: white; border-radius: 8px; padding: 16px 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center; min-width: 140px; }
    .stat-card .number { font-size: 36px; font-weight: bold; color: #2c3e50; }
    .stat-card .label { font-size: 13px; color: #888; margin-top: 4px; }
    .stat-card.green .number { color: #27ae60; }
    .stat-card.orange .number { color: #e67e22; }
    .stat-card.blue .number { color: #2980b9; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    th { background: #2c3e50; color: white; padding: 12px; text-align: left; }
    td { padding: 12px; border-bottom: 1px solid #eee; }
    tr:hover { background: #f9f9f9; }
    button { background: #27ae60; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px; }
    button:hover { background: #219a52; }
    .date { color: #888; font-size: 14px; margin-bottom: 16px; }
  </style>
</head>
<body>
  <h1>🏥 Clinic Queue — Doctor Panel</h1>
  <div class="date">📅 ${new Date().toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })} &nbsp;|&nbsp; Auto-refreshes every 15 seconds</div>

  <div class="stats">
    <div class="stat-card blue">
      <div class="number">${totalToday}</div>
      <div class="label">Total Today</div>
    </div>
    <div class="stat-card orange">
      <div class="number">${totalWaiting}</div>
      <div class="label">Currently Waiting</div>
    </div>
    <div class="stat-card green">
      <div class="number">${totalSeen}</div>
      <div class="label">Seen Today</div>
    </div>
    <div class="stat-card">
      <div class="number">${totalWaiting * MINUTES_PER_PATIENT}</div>
      <div class="label">Max Wait (mins)</div>
    </div>
  </div>

  <table>
    <thead>
      <tr><th>#</th><th>Name</th><th>Phone</th><th>Reason</th><th>Arrived</th><th>Est. Wait</th><th>Action</th></tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="7" style="text-align:center;padding:40px;color:#999">No patients waiting 🎉</td></tr>'}
    </tbody>
  </table>

  <script>
    async function markDone(id) {
      await fetch('/done', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id }) });
      document.getElementById('row-' + id).remove();
    }
  </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});

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

  const [waitingRes, doneRes, allTodayRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/patients?status=eq.waiting&order=queue_number.asc&select=*`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/patients?status=eq.done&created_at=gte.${today}T00:00:00&select=id`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/patients?created_at=gte.${today}T00:00:00&select=id`, { headers })
  ]);

  const patients = await waitingRes.json();
  const doneToday = await doneRes.json();
  const allToday = await allTodayRes.json();

  const cards = patients.map((p, i) => {
    const waitMins = i * MINUTES_PER_PATIENT;
    const waitLabel = waitMins === 0 ? '<span class="badge next">🟢 Next</span>' : `<span class="badge wait">~${waitMins} mins</span>`;
    return `
    <div class="patient-card" id="card-${p.id}">
      <div class="card-header">
        <span class="queue-num">#${p.queue_number}</span>
        ${waitLabel}
      </div>
      <div class="patient-name">${p.name || 'Unknown'}</div>
      <div class="patient-info">📞 ${p.phone.replace('whatsapp:', '')}</div>
      <div class="patient-info">🩺 ${p.reason || '—'}</div>
      <div class="patient-info">🕐 Arrived: ${new Date(p.created_at).toLocaleTimeString()}</div>
      <button class="done-btn" onclick="markDone(${p.id})">✅ Done — Call Next</button>
    </div>`;
  }).join('');

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Clinic Panel</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="refresh" content="15">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f4f8; padding: 16px; }
    h1 { font-size: 20px; color: #1a202c; margin-bottom: 4px; }
    .date { font-size: 12px; color: #718096; margin-bottom: 16px; }
    .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 20px; }
    .stat { background: white; border-radius: 12px; padding: 14px; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .stat .num { font-size: 28px; font-weight: 700; }
    .stat .lbl { font-size: 11px; color: #718096; margin-top: 2px; }
    .blue { color: #3182ce; }
    .orange { color: #dd6b20; }
    .green { color: #38a169; }
    .gray { color: #4a5568; }
    .patient-card { background: white; border-radius: 14px; padding: 16px; margin-bottom: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .queue-num { font-size: 22px; font-weight: 800; color: #2d3748; }
    .badge { font-size: 12px; padding: 4px 10px; border-radius: 20px; font-weight: 600; }
    .badge.next { background: #c6f6d5; color: #276749; }
    .badge.wait { background: #feebc8; color: #9c4221; }
    .patient-name { font-size: 18px; font-weight: 700; color: #1a202c; margin-bottom: 6px; }
    .patient-info { font-size: 13px; color: #718096; margin-bottom: 3px; }
    .done-btn { margin-top: 14px; width: 100%; padding: 14px; background: #38a169; color: white; border: none; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; }
    .done-btn:active { background: #2f855a; }
    .empty { text-align: center; padding: 60px 20px; color: #a0aec0; font-size: 16px; }
    .section-title { font-size: 13px; font-weight: 600; color: #718096; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <h1>🏥 Clinic Queue</h1>
  <div class="date">📅 ${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })} · Auto-refreshes every 15s</div>

  <div class="stats">
    <div class="stat"><div class="num blue">${allToday.length}</div><div class="lbl">Total Today</div></div>
    <div class="stat"><div class="num orange">${patients.length}</div><div class="lbl">Waiting Now</div></div>
    <div class="stat"><div class="num green">${doneToday.length}</div><div class="lbl">Seen Today</div></div>
    <div class="stat"><div class="num gray">${patients.length * MINUTES_PER_PATIENT}</div><div class="lbl">Max Wait (mins)</div></div>
  </div>

  <div class="section-title">Patients in Queue</div>
  ${cards || '<div class="empty">🎉 No patients waiting right now!</div>'}

  <script>
    async function markDone(id) {
      const btn = document.querySelector('#card-' + id + ' .done-btn');
      btn.textContent = 'Processing...';
      btn.disabled = true;
      await fetch('/done', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id }) });
      document.getElementById('card-' + id).remove();
    }
  </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});

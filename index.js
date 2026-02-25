const express = require('express');
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const SUPABASE_URL = 'https://atyxnuzykfhppbtsfogd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF0eXhudXp5a2ZocHBidHNmb2dkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5NTcwNDcsImV4cCI6MjA4NzUzMzA0N30._JAkiG9WVJ_0BIMoOknWEJQCG4DQT1nLYguDj7Tt4wQ';

const headers = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json'
};

async function getWaitingPatient(phone) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/patients?phone=eq.${encodeURIComponent(phone)}&status=eq.waiting&select=*`, { headers });
  const data = await res.json();
  return data.length > 0 ? data[0] : null;
}

async function getPendingPatient(phone) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/patients?phone=eq.${encodeURIComponent(phone)}&status=eq.pending_name&select=*`, { headers });
  const data = await res.json();
  return data.length > 0 ? data[0] : null;
}

async function createPendingPatient(phone) {
  await fetch(`${SUPABASE_URL}/rest/v1/patients`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'return=representation' },
    body: JSON.stringify({ phone, status: 'pending_name' })
  });
}

async function confirmPatient(phone, name) {
  const countRes = await fetch(`${SUPABASE_URL}/rest/v1/patients?status=eq.waiting&select=id`, { headers });
  const waiting = await countRes.json();
  const queueNumber = waiting.length + 1;

  await fetch(`${SUPABASE_URL}/rest/v1/patients?phone=eq.${encodeURIComponent(phone)}&status=eq.pending_name`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ name, status: 'waiting', queue_number: queueNumber })
  });

  return queueNumber;
}

// WhatsApp webhook
app.post('/webhook', async (req, res) => {
  const from = req.body.From;
  const msg = (req.body.Body || '').trim();
  let reply = '';

  try {
    const waiting = await getWaitingPatient(from);
    if (waiting) {
      reply = `Hi *${waiting.name}*! You are already in the queue as number *${waiting.queue_number}*. Please wait, we will call you shortly. 🏥`;
    } else {
      const pending = await getPendingPatient(from);
      if (pending) {
        const queueNumber = await confirmPatient(from, msg);
        reply = `Thank you, *${msg}*! 🏥 You are number *${queueNumber}* in the queue. Please wait, we will call you shortly.`;
      } else {
        await createPendingPatient(from);
        reply = `Welcome to our clinic! 👋 Please reply with your *full name* to join the queue.`;
      }
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

// Mark patient as done
app.post('/done', async (req, res) => {
  const { id } = req.body;
  await fetch(`${SUPABASE_URL}/rest/v1/patients?id=eq.${id}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status: 'done' })
  });
  res.json({ success: true });
});

// Doctor panel
app.get('/doctor', async (req, res) => {
  const result = await fetch(`${SUPABASE_URL}/rest/v1/patients?status=eq.waiting&order=queue_number.asc&select=*`, { headers });
  const patients = await result.json();

  const rows = patients.map(p => `
    <tr id="row-${p.id}">
      <td>${p.queue_number}</td>
      <td>${p.name || 'Unknown'}</td>
      <td>${p.phone.replace('whatsapp:', '')}</td>
      <td>${new Date(p.created_at).toLocaleTimeString()}</td>
      <td>
        <button onclick="markDone(${p.id})">✅ Done</button>
      </td>
    </tr>
  `).join('');

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Clinic Doctor Panel</title>
  <meta http-equiv="refresh" content="15">
  <style>
    body { font-family: Arial, sans-serif; padding: 20px; background: #f5f5f5; }
    h1 { color: #2c3e50; }
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    th { background: #2c3e50; color: white; padding: 12px; text-align: left; }
    td { padding: 12px; border-bottom: 1px solid #eee; }
    tr:hover { background: #f9f9f9; }
    button { background: #27ae60; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 14px; }
    button:hover { background: #219a52; }
    .count { font-size: 18px; margin-bottom: 16px; color: #555; }
    .empty { text-align: center; padding: 40px; color: #999; font-size: 18px; }
  </style>
</head>
<body>
  <h1>🏥 Clinic Queue — Doctor Panel</h1>
  <div class="count">Patients waiting: <strong>${patients.length}</strong> &nbsp;|&nbsp; Auto-refreshes every 15 seconds</div>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Name</th>
        <th>Phone</th>
        <th>Arrived</th>
        <th>Action</th>
      </tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="5" class="empty">No patients waiting 🎉</td></tr>'}
    </tbody>
  </table>
  <script>
    async function markDone(id) {
      await fetch('/done', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ id }) });
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

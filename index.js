const express = require('express');
const app = express();

app.use(express.urlencoded({ extended: false }));

const SUPABASE_URL = 'https://atyxnuzykfhppbtsfogd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF0eXhudXp5a2ZocHBidHNmb2dkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE5NTcwNDcsImV4cCI6MjA4NzUzMzA0N30._JAkiG9WVJ_0BIMoOknWEJQCG4DQT1nLYguDj7Tt4wQ';

const headers = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json'
};

async function getPatient(phone) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/patients?phone=eq.${encodeURIComponent(phone)}&status=eq.waiting&select=*`, { headers });
  const data = await res.json();
  return data.length > 0 ? data[0] : null;
}

async function addPatient(phone, name) {
  const countRes = await fetch(`${SUPABASE_URL}/rest/v1/patients?status=eq.waiting&select=id`, { headers });
  const waiting = await countRes.json();
  const queueNumber = waiting.length + 1;

  await fetch(`${SUPABASE_URL}/rest/v1/patients`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'return=representation' },
    body: JSON.stringify({ phone, name, queue_number: queueNumber, status: 'waiting' })
  });

  return queueNumber;
}

async function updateName(phone, name) {
  await fetch(`${SUPABASE_URL}/rest/v1/patients?phone=eq.${encodeURIComponent(phone)}&status=eq.pending_name`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ name, status: 'waiting' })
  });

  const countRes = await fetch(`${SUPABASE_URL}/rest/v1/patients?status=eq.waiting&select=id`, { headers });
  const waiting = await countRes.json();
  const queueNumber = waiting.length;

  await fetch(`${SUPABASE_URL}/rest/v1/patients?phone=eq.${encodeURIComponent(phone)}&status=eq.waiting`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ queue_number: queueNumber })
  });

  return queueNumber;
}

async function createPendingPatient(phone) {
  await fetch(`${SUPABASE_URL}/rest/v1/patients`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'return=representation' },
    body: JSON.stringify({ phone, status: 'pending_name' })
  });
}

async function getPendingPatient(phone) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/patients?phone=eq.${encodeURIComponent(phone)}&status=eq.pending_name&select=*`, { headers });
  const data = await res.json();
  return data.length > 0 ? data[0] : null;
}

app.post('/webhook', async (req, res) => {
  const from = req.body.From;
  const msg = (req.body.Body || '').trim();

  let reply = '';

  try {
    // Check if already in queue
    const existing = await getPatient(from);
    if (existing) {
      reply = `You are already in the queue as *${existing.name}*, number *${existing.queue_number}*. Please wait, we will call you shortly. 🏥`;
    } else {
      // Check if waiting for name
      const pending = await getPendingPatient(from);
      if (pending) {
        // They just sent their name
        const queueNumber = await updateName(from, msg);
        reply = `Thank you, *${msg}*! 🏥 You are number *${queueNumber}* in the queue. Please wait, we will call you shortly.`;
      } else {
        // New patient — ask for name
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});

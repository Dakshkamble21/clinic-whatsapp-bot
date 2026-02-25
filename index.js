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
  // Count current waiting patients
  const countRes = await fetch(`${SUPABASE_URL}/rest/v1/patients?status=eq.waiting&select=id`, { headers });
  const waiting = await countRes.json();
  const queueNumber = waiting.length + 1;

  // Update pending record to waiting with name and queue number
  await fetch(`${SUPABASE_URL}/rest/v1/patients?phone=eq.${encodeURIComponent(phone)}&status=eq.pending_name`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ name, status: 'waiting', queue_number: queueNumber })
  });

  return queueNumber;
}

app.post('/webhook', async (req, res) => {
  const from = req.body.From;
  const msg = (req.body.Body || '').trim();

  let reply = '';

  try {
    // 1. Already in waiting queue?
    const waiting = await getWaitingPatient(from);
    if (waiting) {
      reply = `Hi *${waiting.name}*! You are already in the queue as number *${waiting.queue_number}*. Please wait, we will call you shortly. 🏥`;
    } else {
      // 2. Waiting for name?
      const pending = await getPendingPatient(from);
      if (pending) {
        const queueNumber = await confirmPatient(from, msg);
        reply = `Thank you, *${msg}*! 🏥 You are number *${queueNumber}* in the queue. Please wait, we will call you shortly.`;
      } else {
        // 3. Brand new patient
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

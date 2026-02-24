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

async function savePatient(phone) {
  // Check if patient already in queue
  const checkRes = await fetch(`${SUPABASE_URL}/rest/v1/patients?phone=eq.${encodeURIComponent(phone)}&status=eq.waiting&select=queue_number`, { headers });
  const existing = await checkRes.json();

  if (existing.length > 0) {
    return existing[0].queue_number;
  }

  // Count current waiting patients
  const countRes = await fetch(`${SUPABASE_URL}/rest/v1/patients?status=eq.waiting&select=id`, { headers });
  const waiting = await countRes.json();
  const queueNumber = waiting.length + 1;

  // Insert new patient
  await fetch(`${SUPABASE_URL}/rest/v1/patients`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'return=representation' },
    body: JSON.stringify({ phone, queue_number: queueNumber, status: 'waiting' })
  });

  return queueNumber;
}

app.post('/webhook', async (req, res) => {
  const from = req.body.From;
  console.log('Incoming from:', from);

  try {
    const queueNumber = await savePatient(from);

    const response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>Welcome to our clinic! 🏥 You are number *${queueNumber}* in the queue. Please wait, we will call you shortly.</Message>
</Response>`;

    res.set('Content-Type', 'text/xml');
    res.send(response);
  } catch (err) {
    console.error('Error:', err);
    res.status(500).send('Error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});

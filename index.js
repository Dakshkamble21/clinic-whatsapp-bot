const express = require('express');
const app = express();

app.use(express.urlencoded({ extended: false }));

const SUPABASE_URL = 'https://atyxnuzykfhppbtsfogd.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF0eXhudXp5a2ZocHBidHNmb2dkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDU4NjYyNjAsImV4cCI6MjA2MTQ0MjI2MH0.ImF0eXhudXp5a2ZocHBidHNmb2dkIg';

async function savePatient(phone) {
  // Get current queue count
  const countRes = await fetch(`${SUPABASE_URL}/rest/v1/patients?status=eq.waiting&select=id`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const patients = await countRes.json();
  const queueNumber = patients.length + 1;

  // Check if patient already exists
  const checkRes = await fetch(`${SUPABASE_URL}/rest/v1/patients?phone=eq.${phone}&status=eq.waiting`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const existing = await checkRes.json();

  if (existing.length > 0) {
    return existing[0].queue_number;
  }

  // Insert new patient
  await fetch(`${SUPABASE_URL}/rest/v1/patients`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ phone, queue_number: queueNumber, status: 'waiting' })
  });

  return queueNumber;
}

app.post('/webhook', async (req, res) => {
  const from = req.body.From;

  try {
    const queueNumber = await savePatient(from);

    const response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>Welcome to our clinic! 🏥 You are number *${queueNumber}* in the queue. Please wait, we will call you shortly.</Message>
</Response>`;

    res.set('Content-Type', 'text/xml');
    res.send(response);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot running on port ${PORT}`);
});

const express = require('express');
const app = express();

app.use(express.urlencoded({ extended: false }));

app.post('/webhook', (req, res) => {
  const incomingMsg = req.body.Body;
  const from = req.body.From;

  console.log(`Message from ${from}: ${incomingMsg}`);

  const response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>Welcome to our clinic! 🏥 You are now in the queue. We will call you shortly. Please wait.</Message>
</Response>`;

  res.set('Content-Type', 'text/xml');
  res.send(response);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot is running on port ${PORT}`);
});

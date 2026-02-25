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

// ✅ FIX: Doctor's WhatsApp number for daily reports
const DOCTOR_NUMBER = 'whatsapp:+918839775527';

const headers = {
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json'
};

const MAIN_MENU = `🏥 *Welcome to our Clinic!*

Please choose an option:
*1* — 🩺 Join the queue
*2* — 📋 Check my status
*3* — ❌ Cancel my token
*4* — ⏰ I'm running late
*5* — 🚨 Emergency

Reply with a number (1-5)`;

// ─── Helper Functions ────────────────────────────────────────

async function getSession() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/sessions?order=id.desc&limit=1&select=*`, { headers });
  const data = await res.json();
  return data.length > 0 ? data[0] : { status: 'IDLE' };
}

async function setSession(status) {
  const session = await getSession();
  const now = new Date().toISOString();
  const update = { status };
  if (status === 'RUNNING' && session.status === 'IDLE') update.started_at = now;
  if (status === 'PAUSED') update.paused_at = now;
  if (status === 'CLOSED') update.closed_at = now;
  await fetch(`${SUPABASE_URL}/rest/v1/sessions?id=eq.${session.id}`, {
    method: 'PATCH', headers, body: JSON.stringify(update)
  });
}

async function getPatientByStatus(phone, status) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/patients?phone=eq.${encodeURIComponent(phone)}&status=eq.${status}&select=*`, { headers });
  const data = await res.json();
  return data.length > 0 ? data[0] : null;
}

async function getActivePatient(phone) {
  for (const status of ['waiting', 'running_late', 'emergency']) {
    const p = await getPatientByStatus(phone, status);
    if (p) return p;
  }
  return null;
}

async function getWaitInfo(queueNumber) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/patients?status=in.(waiting,running_late,emergency)&queue_number=lt.${queueNumber}&select=id`, { headers });
  const data = await res.json();
  return data.length;
}

async function sendWhatsApp(to, message) {
  const credentials = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64');
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: TWILIO_FROM, To: to, Body: message })
  });
}

async function notifyAllWaiting(message) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/patients?status=in.(waiting,running_late)&select=*`, { headers });
  const patients = await res.json();
  for (const p of patients) await sendWhatsApp(p.phone, message);
}

// ✅ FIX: Helper to detect greeting/menu trigger words
function isGreeting(msg) {
  const lower = msg.toLowerCase().trim();
  return lower === 'hi' || lower === 'hello' || lower === 'hey' ||
    lower === 'menu' || lower === 'start' || lower === 'helo' ||
    lower === 'hu' || lower === 'hii' || lower === 'hlo' ||
    lower === 'hlw' || lower === 'h' || msg === '0';
}

// ─── WhatsApp Webhook ────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  const from = req.body.From;
  const msg = (req.body.Body || '').trim();
  const msgLower = msg.toLowerCase();
  let reply = '';

  try {
    const session = await getSession();

    // ── Multi-step registration flows ──
    const pendingName = await getPatientByStatus(from, 'pending_name');
    if (pendingName) {
      await fetch(`${SUPABASE_URL}/rest/v1/patients?phone=eq.${encodeURIComponent(from)}&status=eq.pending_name`, {
        method: 'PATCH', headers, body: JSON.stringify({ name: msg, status: 'pending_reason' })
      });
      reply = `Thank you, *${msg}*! 😊\n\nPlease reply with your *reason for visit*\n(e.g. fever, checkup, follow-up):`;

    } else if (await getPatientByStatus(from, 'pending_reason')) {
      await fetch(`${SUPABASE_URL}/rest/v1/patients?phone=eq.${encodeURIComponent(from)}&status=eq.pending_reason`, {
        method: 'PATCH', headers, body: JSON.stringify({ reason: msg, status: 'pending_choice' })
      });
      reply = `Got it! 🩺 *Reason:* ${msg}\n\nHow would you like to see the doctor?\n\n*1* — 🚶 Join walk-in queue now\n*2* — 📅 Book an appointment`;

    } else if (await getPatientByStatus(from, 'pending_choice')) {
      const pending = await getPatientByStatus(from, 'pending_choice');
      if (msg === '1' || msgLower.includes('walk') || msgLower.includes('queue')) {
        const countRes = await fetch(`${SUPABASE_URL}/rest/v1/patients?status=in.(waiting,running_late,emergency)&select=id`, { headers });
        const waitingList = await countRes.json();
        const queueNumber = waitingList.length + 1;
        const waitMinutes = waitingList.length * MINUTES_PER_PATIENT;
        await fetch(`${SUPABASE_URL}/rest/v1/patients?phone=eq.${encodeURIComponent(from)}&status=eq.pending_choice`, {
          method: 'PATCH', headers, body: JSON.stringify({ status: 'waiting', queue_number: queueNumber })
        });
        reply = waitMinutes === 0
          ? `✅ You're in! *${pending.name}*, you are *#${queueNumber}* — you're next! Please be ready. 🏥`
          : `✅ You're in! *${pending.name}*, you are *#${queueNumber}* in the queue.\n\nEstimated wait: *~${waitMinutes} minutes*\n\nWe'll notify you when it's your turn! 🏥\n\nReply *menu* anytime to see options.`;

      } else if (msg === '2' || msgLower.includes('appoint') || msgLower.includes('book')) {
        await fetch(`${SUPABASE_URL}/rest/v1/appointments`, {
          method: 'POST', headers: { ...headers, 'Prefer': 'return=representation' },
          body: JSON.stringify({ phone: from, name: pending.name, reason: pending.reason, status: 'pending_time' })
        });
        await fetch(`${SUPABASE_URL}/rest/v1/patients?phone=eq.${encodeURIComponent(from)}&status=eq.pending_choice`, {
          method: 'DELETE', headers
        });
        reply = `📅 Let's book your appointment!\n\nPlease reply with your preferred *date and time*.\nExample: _Tomorrow 10am_ or _Monday 3pm_`;

      } else {
        reply = `Please reply with:\n*1* — 🚶 Walk-in queue\n*2* — 📅 Book appointment`;
      }

    } else {
      // ── Check if user is booking an appointment ──
      const apptRes = await fetch(`${SUPABASE_URL}/rest/v1/appointments?phone=eq.${encodeURIComponent(from)}&status=eq.pending_time&select=*`, { headers });
      const appts = await apptRes.json();
      if (appts.length > 0) {
        const appt = appts[0];
        await fetch(`${SUPABASE_URL}/rest/v1/appointments?phone=eq.${encodeURIComponent(from)}&status=eq.pending_time`, {
          method: 'PATCH', headers, body: JSON.stringify({ appt_time: msg, status: 'confirmed' })
        });
        reply = `✅ *Appointment Confirmed!*\n\n👤 *Name:* ${appt.name}\n🩺 *Reason:* ${appt.reason}\n🕐 *Time:* ${msg}\n\nWe'll see you then! 🏥\nReply *menu* anytime for options.`;

      } else {

        // ✅ FIX: Session IDLE — clinic not open yet, but allow greetings & menu
        if (session.status === 'IDLE') {
          if (isGreeting(msg)) {
            reply = `🏥 *Clinic is not open yet.*\n\nThe session hasn't started. Please check back soon!\n\nHere's what you can do when we open:\n${MAIN_MENU}`;
          } else if (msg === '2' || msgLower === 'status') {
            reply = `📋 You are not currently in the queue.\n\nThe clinic hasn't opened yet. Reply when we're open!`;
          } else {
            reply = `🏥 *Clinic is not open yet.*\n\nPlease check back soon! Reply *hi* anytime to check.`;
          }

        // ✅ FIX: Session CLOSED — allow menu, greetings, appointment booking
        } else if (session.status === 'CLOSED') {
          if (isGreeting(msg)) {
            reply = `🏥 *Today's session has ended.*\n\nThank you for visiting! Please come back tomorrow.\n\n📅 You can still book an appointment:\nReply *1* to register for tomorrow's queue or *2* to check status.`;
          } else if (msg === '1' || msgLower === 'join') {
            reply = `🏥 *Today's session has ended.*\n\nYou cannot join today's queue anymore.\n\nReply *hi* tomorrow when we open, or send *appointment* to book a slot.`;
          } else if (msg === '2' || msgLower === 'status') {
            const active = await getActivePatient(from);
            if (active) {
              reply = `📋 *${active.name}*, your token *#${active.queue_number}* was for today's session which has ended.\n\nPlease visit again tomorrow! Reply *hi* when we reopen.`;
            } else {
              reply = `You don't have an active token. Today's session has ended.\n\nReply *hi* tomorrow when we open! 🏥`;
            }
          } else if (msgLower === 'appointment' || msgLower.includes('book') || msgLower.includes('appoint')) {
            // Allow booking appointments even when closed
            await fetch(`${SUPABASE_URL}/rest/v1/patients`, {
              method: 'POST', headers: { ...headers, 'Prefer': 'return=representation' },
              body: JSON.stringify({ phone: from, status: 'pending_name' })
            });
            reply = `📅 Let's register you for an appointment!\n\nPlease reply with your *full name*:`;
          } else {
            reply = `🏥 *Today's session has ended.*\n\nThank you for visiting! Please come back tomorrow.\n\nReply *hi* to see options or *appointment* to book a slot. 🏥`;
          }

        // ✅ FIX: Session PAUSED — show proper message
        } else if (session.status === 'PAUSED') {
          const active = await getActivePatient(from);
          if (isGreeting(msg)) {
            reply = `⏸️ *Clinic is temporarily paused.*\n\nWe'll resume shortly!\n\n${active ? `Your token *#${active.queue_number}* is saved, *${active.name}*.` : 'You can join the queue when we resume.'}\n\nReply *2* to check your status.`;
          } else if (msg === '2' || msgLower === 'status') {
            if (active) {
              reply = `⏸️ *${active.name}*, the clinic is paused right now.\n\nYour token *#${active.queue_number}* is saved! We'll notify you when we resume. 🏥`;
            } else {
              reply = `⏸️ *Clinic is temporarily paused.*\n\nWe'll resume shortly! Reply *hi* when we reopen to join the queue.`;
            }
          } else {
            reply = `⏸️ *Clinic is temporarily paused.*\n\nPlease wait, we'll resume shortly! Reply *2* to check your status.`;
          }

        // ── Session RUNNING — normal operation ──
        } else {
          const active = await getActivePatient(from);

          if (msg === '1' || msgLower === 'join') {
            if (active) {
              const ahead = await getWaitInfo(active.queue_number);
              reply = `You are already in the queue as *${active.name}*!\n\n📋 *Queue #:* ${active.queue_number}\n⏳ *Est. wait:* ~${ahead * MINUTES_PER_PATIENT} minutes\n\nReply *menu* to see all options.`;
            } else {
              await fetch(`${SUPABASE_URL}/rest/v1/patients`, {
                method: 'POST', headers: { ...headers, 'Prefer': 'return=representation' },
                body: JSON.stringify({ phone: from, status: 'pending_name' })
              });
              reply = `Let's get you registered! 📝\n\nPlease reply with your *full name*:`;
            }

          } else if (msg === '2' || msgLower === 'status') {
            if (active) {
              const ahead = await getWaitInfo(active.queue_number);
              const waitMins = ahead * MINUTES_PER_PATIENT;
              const emoji = active.status === 'emergency' ? '🚨' : active.status === 'running_late' ? '⏰' : '🟢';
              reply = waitMins === 0
                ? `${emoji} *${active.name}*, you are *NEXT* in line!\n\nPlease make your way to the clinic now. 🏥`
                : `${emoji} *Queue Status for ${active.name}*\n\n🔢 *Your number:* #${active.queue_number}\n👥 *People ahead:* ${ahead}\n⏳ *Est. wait:* ~${waitMins} minutes\n🩺 *Reason:* ${active.reason || '—'}\n\nWe'll notify you when it's your turn!`;
            } else {
              reply = `You are not currently in the queue.\n\n${MAIN_MENU}`;
            }

          } else if (msg === '3' || msgLower === 'cancel') {
            if (active) {
              await fetch(`${SUPABASE_URL}/rest/v1/patients?id=eq.${active.id}`, {
                method: 'PATCH', headers, body: JSON.stringify({ status: 'cancelled' })
              });
              reply = `✅ Your token *#${active.queue_number}* has been cancelled, *${active.name}*.\n\nWe hope to see you soon! 🏥\nReply *1* anytime to rejoin the queue.`;
            } else {
              reply = `You don't have an active token to cancel.\n\n${MAIN_MENU}`;
            }

          } else if (msg === '4' || msgLower.includes('late')) {
            if (active) {
              await fetch(`${SUPABASE_URL}/rest/v1/patients?id=eq.${active.id}`, {
                method: 'PATCH', headers, body: JSON.stringify({ status: 'running_late' })
              });
              reply = `⏰ Got it, *${active.name}*! We've noted that you're running late.\n\nYour token *#${active.queue_number}* is still saved. The doctor has been notified.\n\nPlease come as soon as you can! 🏥`;
            } else {
              reply = `You don't have an active token.\n\n${MAIN_MENU}`;
            }

          } else if (msg === '5' || msgLower.includes('emergency')) {
            if (active) {
              await fetch(`${SUPABASE_URL}/rest/v1/patients?id=eq.${active.id}`, {
                method: 'PATCH', headers, body: JSON.stringify({ status: 'emergency' })
              });
              reply = `🚨 *Emergency request sent for ${active.name}!*\n\nThe doctor has been notified. Please come to the clinic immediately.\n\nIf this is a medical emergency, call *112* right away.`;
            } else {
              await fetch(`${SUPABASE_URL}/rest/v1/patients`, {
                method: 'POST', headers: { ...headers, 'Prefer': 'return=representation' },
                body: JSON.stringify({ phone: from, status: 'emergency', queue_number: 0, name: 'Emergency Patient' })
              });
              reply = `🚨 *Emergency registered!*\n\nPlease come to the clinic immediately. The doctor has been alerted.\n\nIf this is a life-threatening emergency, call *112* right away.`;
            }

          } else if (isGreeting(msg)) {
            reply = MAIN_MENU;

          } else {
            reply = `I didn't understand that. 😊\n\n${MAIN_MENU}`;
          }
        }
      }
    }
  } catch (err) {
    console.error('Error:', err);
    reply = 'Sorry, something went wrong. Please try again or reply *menu*.';
  }

  res.set('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${reply}</Message></Response>`);
});

// ─── Session Controls ────────────────────────────────────────
app.post('/session/start', async (req, res) => {
  await setSession('RUNNING');
  res.json({ success: true, status: 'RUNNING' });
});

app.post('/session/pause', async (req, res) => {
  await setSession('PAUSED');
  await notifyAllWaiting(`⏸️ *Clinic Update:* The session is temporarily paused.\n\nYour token is saved. We'll notify you when we resume! 🏥`);
  res.json({ success: true, status: 'PAUSED' });
});

app.post('/session/resume', async (req, res) => {
  await setSession('RUNNING');
  await notifyAllWaiting(`▶️ *Clinic Update:* We've resumed!\n\nThank you for your patience. Reply *2* to check your current wait time. 🏥`);
  res.json({ success: true, status: 'RUNNING' });
});

app.post('/session/end', async (req, res) => {
  await setSession('CLOSED');
  await notifyAllWaiting(`🏥 *Clinic Update:* Today's session has ended.\n\nThank you for your patience. Please visit again tomorrow or contact us for an appointment.`);
  await fetch(`${SUPABASE_URL}/rest/v1/patients?status=in.(waiting,running_late,emergency)`, {
    method: 'PATCH', headers, body: JSON.stringify({ status: 'cancelled' })
  });
  res.json({ success: true, status: 'CLOSED' });
});

app.post('/session/reset', async (req, res) => {
  await fetch(`${SUPABASE_URL}/rest/v1/sessions`, {
    method: 'POST', headers: { ...headers, 'Prefer': 'return=representation' },
    body: JSON.stringify({ status: 'IDLE' })
  });
  await fetch(`${SUPABASE_URL}/rest/v1/patients?status=in.(waiting,running_late,emergency,cancelled,done)`, {
    method: 'PATCH', headers, body: JSON.stringify({ status: 'archived' })
  });
  res.json({ success: true, status: 'IDLE' });
});

// ─── Done ────────────────────────────────────────────────────
app.post('/done', async (req, res) => {
  const { id, staffName } = req.body;
  await fetch(`${SUPABASE_URL}/rest/v1/patients?id=eq.${id}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ status: 'done', handled_by: staffName || 'Staff' })
  });
  const nextRes = await fetch(`${SUPABASE_URL}/rest/v1/patients?status=in.(waiting,running_late)&order=queue_number.asc&limit=1&select=*`, { headers });
  const next = await nextRes.json();
  if (next.length > 0) {
    await sendWhatsApp(next[0].phone, `🔔 *${next[0].name}*, it's your turn! Please come in now. The doctor is ready for you. 🏥`);
  }
  res.json({ success: true });
});

// ─── Skip ────────────────────────────────────────────────────
app.post('/skip', async (req, res) => {
  const { id, staffName } = req.body;
  const patRes = await fetch(`${SUPABASE_URL}/rest/v1/patients?id=eq.${id}&select=*`, { headers });
  const patients = await patRes.json();
  if (patients.length === 0) return res.json({ success: false, error: 'Patient not found' });
  const skipped = patients[0];

  const maxRes = await fetch(`${SUPABASE_URL}/rest/v1/patients?status=in.(waiting,running_late)&order=queue_number.desc&limit=1&select=queue_number`, { headers });
  const maxData = await maxRes.json();
  const newQueueNumber = maxData.length > 0 ? maxData[0].queue_number + 1 : skipped.queue_number;

  await fetch(`${SUPABASE_URL}/rest/v1/patients?id=eq.${id}`, {
    method: 'PATCH', headers,
    body: JSON.stringify({ queue_number: newQueueNumber, status: 'waiting', skipped_by: staffName || 'Staff' })
  });

  await sendWhatsApp(skipped.phone,
    `⏭️ *${skipped.name}*, you were skipped as you weren't present.\n\nYou've been moved to *#${newQueueNumber}* in the queue.\n\nPlease come to the clinic soon! Reply *2* to check your updated wait time. 🏥`
  );

  const nextRes = await fetch(`${SUPABASE_URL}/rest/v1/patients?status=in.(waiting,running_late)&order=queue_number.asc&limit=1&select=*`, { headers });
  const next = await nextRes.json();
  if (next.length > 0 && next[0].id !== id) {
    await sendWhatsApp(next[0].phone, `🔔 *${next[0].name}*, it's your turn! Please come in now. 🏥`);
  }

  res.json({ success: true, newQueueNumber });
});

// ─── Appointment Done ────────────────────────────────────────
app.post('/appt-done', async (req, res) => {
  const { id } = req.body;
  await fetch(`${SUPABASE_URL}/rest/v1/appointments?id=eq.${id}`, {
    method: 'PATCH', headers, body: JSON.stringify({ status: 'done' })
  });
  res.json({ success: true });
});

// ─── Daily Report ────────────────────────────────────────────
app.post('/report', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  const [allRes, doneRes, cancelledRes, emergencyRes, skippedRes, apptsRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/patients?created_at=gte.${today}T00:00:00&select=id`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/patients?status=eq.done&created_at=gte.${today}T00:00:00&select=id`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/patients?status=eq.cancelled&created_at=gte.${today}T00:00:00&select=id`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/patients?status=eq.emergency&created_at=gte.${today}T00:00:00&select=id`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/patients?skipped_by=not.is.null&created_at=gte.${today}T00:00:00&select=id`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/appointments?created_at=gte.${today}T00:00:00&select=id,status`, { headers })
  ]);

  const all = await allRes.json();
  const done = await doneRes.json();
  const cancelled = await cancelledRes.json();
  const emergency = await emergencyRes.json();
  const skipped = await skippedRes.json();
  const appts = await apptsRes.json();
  const apptsDone = appts.filter(a => a.status === 'done');

  const now = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' });

  const efficiency = all.length > 0 ? Math.round((done.length / all.length) * 100) : 0;

  const report = `📊 *Daily Clinic Report*
📅 ${now}

👥 *Patients Today*
• Total registered: *${all.length}*
• ✅ Seen: *${done.length}*
• ❌ Cancelled: *${cancelled.length}*
• ⏭️ Skipped: *${skipped.length}*
• 🚨 Emergencies: *${emergency.length}*

📅 *Appointments*
• Total booked: *${appts.length}*
• ✅ Completed: *${apptsDone.length}*
• ⏳ Pending: *${appts.length - apptsDone.length}*

⚡ *Efficiency:* ${efficiency}% patients seen

_Sent from Clinic Bot_ 🏥`;

  await sendWhatsApp(DOCTOR_NUMBER, report);
  res.json({ success: true });
});

// ─── Staff Online Ping ───────────────────────────────────────
app.post('/staff/ping', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.json({ success: false });
  await fetch(`${SUPABASE_URL}/rest/v1/staff_online`, {
    method: 'POST',
    headers: { ...headers, 'Prefer': 'resolution=merge-duplicates' },
    body: JSON.stringify({ name, last_seen: new Date().toISOString() })
  }).catch(() => {});
  res.json({ success: true });
});

app.get('/staff/online', async (req, res) => {
  const cutoff = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const result = await fetch(`${SUPABASE_URL}/rest/v1/staff_online?last_seen=gte.${cutoff}&select=name,last_seen`, { headers })
    .then(r => r.json()).catch(() => []);
  res.json(result);
});

// ─── Doctor Panel ────────────────────────────────────────────
app.get('/doctor', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const [sessionData, waitingRes, doneRes, allTodayRes, apptsRes, emergencyRes] = await Promise.all([
    getSession(),
    fetch(`${SUPABASE_URL}/rest/v1/patients?status=in.(waiting,running_late)&order=queue_number.asc&select=*`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/patients?status=eq.done&created_at=gte.${today}T00:00:00&select=id`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/patients?created_at=gte.${today}T00:00:00&select=id`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/appointments?status=eq.confirmed&order=created_at.asc&select=*`, { headers }),
    fetch(`${SUPABASE_URL}/rest/v1/patients?status=eq.emergency&order=created_at.asc&select=*`, { headers })
  ]);

  const patients = await waitingRes.json();
  const doneToday = await doneRes.json();
  const allToday = await allTodayRes.json();
  const appointments = await apptsRes.json();
  const emergencies = await emergencyRes.json();
  const session = sessionData;

  const statusColor = { IDLE: '#718096', RUNNING: '#38a169', PAUSED: '#dd6b20', CLOSED: '#e53e3e' };
  const statusLabel = { IDLE: '⚪ IDLE', RUNNING: '🟢 RUNNING', PAUSED: '🟡 PAUSED', CLOSED: '🔴 CLOSED' };

  const sessionButtons = () => {
    if (session.status === 'IDLE') return `<button class="sess-btn green" onclick="sessionAction('start')">▶️ Start Session</button>`;
    if (session.status === 'RUNNING') return `
      <button class="sess-btn orange" onclick="sessionAction('pause')">⏸️ Pause</button>
      <button class="sess-btn red" onclick="sessionAction('end')">⏹️ End Session</button>`;
    if (session.status === 'PAUSED') return `
      <button class="sess-btn green" onclick="sessionAction('resume')">▶️ Resume</button>
      <button class="sess-btn red" onclick="sessionAction('end')">⏹️ End Session</button>`;
    if (session.status === 'CLOSED') return `<button class="sess-btn gray" onclick="sessionAction('reset')">🔄 New Session</button>`;
    return '';
  };

  const emergencyCards = emergencies.map(p => `
    <div class="patient-card emergency-card" id="card-${p.id}">
      <div class="card-header"><span class="queue-num">🚨</span><span class="badge emergency">EMERGENCY</span></div>
      <div class="patient-name">${p.name || 'Unknown'}</div>
      <div class="patient-info">📞 ${p.phone.replace('whatsapp:', '')}</div>
      <div class="patient-info">🩺 ${p.reason || '—'}</div>
      <div class="patient-info">🕐 ${new Date(p.created_at).toLocaleTimeString()}</div>
      <button class="done-btn emergency-btn" onclick="markDone(${p.id})">✅ Emergency Seen</button>
    </div>`).join('');

  const queueCards = patients.map((p, i) => {
    const waitMins = i * MINUTES_PER_PATIENT;
    const isLate = p.status === 'running_late';
    const badge = waitMins === 0 ? '<span class="badge next">🟢 Next</span>' : `<span class="badge wait">~${waitMins} mins</span>`;
    const lateBadge = isLate ? '<span class="badge late">⏰ Late</span>' : '';
    return `
    <div class="patient-card${isLate ? ' late-card' : ''}" id="card-${p.id}">
      <div class="card-header"><span class="queue-num">#${p.queue_number}</span><div>${badge}${lateBadge}</div></div>
      <div class="patient-name">${p.name || 'Unknown'}</div>
      <div class="patient-info">📞 ${p.phone.replace('whatsapp:', '')}</div>
      <div class="patient-info">🩺 ${p.reason || '—'}</div>
      <div class="patient-info">🕐 Arrived: ${new Date(p.created_at).toLocaleTimeString()}</div>
      <div class="btn-row">
        <button class="done-btn" onclick="markDone(${p.id})">✅ Done</button>
        <button class="skip-btn" onclick="skipPatient(${p.id})">⏭️ Skip</button>
      </div>
    </div>`;
  }).join('');

  const apptCards = appointments.map(a => `
    <div class="patient-card appt-card" id="appt-${a.id}">
      <div class="card-header"><span class="queue-num">📅</span><span class="badge appt">Appointment</span></div>
      <div class="patient-name">${a.name || 'Unknown'}</div>
      <div class="patient-info">📞 ${a.phone.replace('whatsapp:', '')}</div>
      <div class="patient-info">🩺 ${a.reason || '—'}</div>
      <div class="patient-info">🕐 Time: <strong>${a.appt_time}</strong></div>
      <button class="done-btn appt-btn" onclick="apptDone(${a.id})">✅ Appointment Done</button>
    </div>`).join('');

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Clinic Panel</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f0f4f8; padding: 16px; }
    h1 { font-size: 20px; color: #1a202c; margin-bottom: 2px; }
    .date { font-size: 12px; color: #718096; margin-bottom: 12px; }

    .staff-bar { background: white; border-radius: 12px; padding: 12px 16px; margin-bottom: 16px; box-shadow: 0 1px 4px rgba(0,0,0,0.08); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .staff-label { font-size: 12px; color: #718096; }
    .staff-name { font-size: 14px; font-weight: 700; color: #2d3748; }
    .staff-change { font-size: 12px; color: #3182ce; cursor: pointer; text-decoration: underline; }
    .online-dots { display: flex; gap: 6px; flex-wrap: wrap; margin-left: auto; }
    .dot { font-size: 11px; background: #c6f6d5; color: #276749; padding: 3px 8px; border-radius: 20px; font-weight: 600; }

    .session-box { background: white; border-radius: 14px; padding: 16px; margin-bottom: 16px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .session-status { font-size: 20px; font-weight: 800; color: ${statusColor[session.status]}; margin-bottom: 10px; }
    .session-btns { display: flex; gap: 10px; flex-wrap: wrap; }
    .sess-btn { flex: 1; min-width: 120px; padding: 13px; border: none; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; color: white; }
    .sess-btn.green { background: #38a169; }
    .sess-btn.orange { background: #dd6b20; }
    .sess-btn.red { background: #e53e3e; }
    .sess-btn.gray { background: #718096; }
    .sess-btn.blue { background: #3182ce; }

    .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 16px; }
    .stat { background: white; border-radius: 12px; padding: 14px; text-align: center; box-shadow: 0 1px 4px rgba(0,0,0,0.08); }
    .stat .num { font-size: 28px; font-weight: 700; }
    .stat .lbl { font-size: 11px; color: #718096; margin-top: 2px; }
    .blue { color: #3182ce; } .orange { color: #dd6b20; } .green { color: #38a169; } .red { color: #e53e3e; }

    .section-title { font-size: 13px; font-weight: 600; color: #718096; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 12px; margin-top: 16px; }
    .patient-card { background: white; border-radius: 14px; padding: 16px; margin-bottom: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
    .emergency-card { border-left: 4px solid #e53e3e; background: #fff5f5; }
    .late-card { border-left: 4px solid #ed8936; }
    .appt-card { border-left: 4px solid #805ad5; }
    .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; gap: 6px; flex-wrap: wrap; }
    .queue-num { font-size: 22px; font-weight: 800; color: #2d3748; }
    .badge { font-size: 11px; padding: 3px 8px; border-radius: 20px; font-weight: 600; }
    .badge.next { background: #c6f6d5; color: #276749; }
    .badge.wait { background: #feebc8; color: #9c4221; }
    .badge.late { background: #feebc8; color: #9c4221; margin-left: 4px; }
    .badge.appt { background: #e9d8fd; color: #553c9a; }
    .badge.emergency { background: #fed7d7; color: #9b2c2c; }
    .patient-name { font-size: 18px; font-weight: 700; color: #1a202c; margin-bottom: 6px; }
    .patient-info { font-size: 13px; color: #718096; margin-bottom: 3px; }
    .btn-row { display: flex; gap: 8px; margin-top: 14px; }
    .done-btn { flex: 2; padding: 14px; background: #38a169; color: white; border: none; border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer; }
    .skip-btn { flex: 1; padding: 14px; background: #718096; color: white; border: none; border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer; }
    .appt-btn { background: #805ad5; margin-top: 14px; width: 100%; padding: 14px; border: none; border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer; color: white; }
    .emergency-btn { background: #e53e3e; margin-top: 14px; width: 100%; padding: 14px; border: none; border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer; color: white; }
    .report-btn { background: #3182ce; margin-top: 10px; width: 100%; padding: 13px; border: none; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; color: white; }
    .empty { text-align: center; padding: 30px 20px; color: #a0aec0; font-size: 14px; }
    .refresh-info { text-align: center; font-size: 11px; color: #a0aec0; margin-top: 20px; padding-bottom: 30px; }
  </style>
</head>
<body>
  <h1>🏥 Clinic Panel</h1>
  <div class="date">📅 ${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</div>

  <div class="staff-bar">
    <div>
      <div class="staff-label">Logged in as</div>
      <div class="staff-name" id="myName">Loading...</div>
    </div>
    <span class="staff-change" onclick="changeName()">Change</span>
    <div class="online-dots" id="onlineDots"></div>
  </div>

  <div class="session-box">
    <div class="session-status">${statusLabel[session.status]}</div>
    <div class="session-btns">${sessionButtons()}</div>
    <button class="report-btn" onclick="sendReport()">📊 Send Report to Doctor</button>
  </div>

  <div class="stats">
    <div class="stat"><div class="num blue">${allToday.length}</div><div class="lbl">Total Today</div></div>
    <div class="stat"><div class="num orange">${patients.length}</div><div class="lbl">Waiting Now</div></div>
    <div class="stat"><div class="num green">${doneToday.length}</div><div class="lbl">Seen Today</div></div>
    <div class="stat"><div class="num red">${emergencies.length}</div><div class="lbl">Emergencies</div></div>
  </div>

  ${emergencies.length > 0 ? `<div class="section-title">🚨 Emergencies</div>${emergencyCards}` : ''}
  <div class="section-title">🚶 Walk-in Queue</div>
  ${queueCards || '<div class="empty">No walk-in patients right now 🎉</div>'}
  <div class="section-title">📅 Appointments</div>
  ${apptCards || '<div class="empty">No appointments scheduled</div>'}
  <div class="refresh-info">Auto-refreshes every 15s</div>

  <script>
    // ── Staff name management ──
    function getMyName() {
      let name = localStorage.getItem('clinicStaffName');
      if (!name) {
        name = prompt('Welcome! Enter your name (e.g. Dr. Sharma, Nurse Priya, Reception):') || 'Staff';
        localStorage.setItem('clinicStaffName', name);
      }
      return name;
    }
    function changeName() {
      const name = prompt('Enter your new name:');
      if (name) { localStorage.setItem('clinicStaffName', name); location.reload(); }
    }

    const myName = getMyName();
    document.getElementById('myName').textContent = myName;

    async function pingOnline() {
      await fetch('/staff/ping', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ name: myName }) });
    }
    pingOnline();
    setInterval(pingOnline, 30000);

    async function loadOnline() {
      const staff = await fetch('/staff/online').then(r => r.json()).catch(() => []);
      const dots = document.getElementById('onlineDots');
      dots.innerHTML = staff.map(s => \`<span class="dot">🟢 \${s.name}</span>\`).join('');
    }
    loadOnline();

    // ── Auto-refresh every 15s ──
    setInterval(() => location.reload(), 15000);

    // ── Session actions ──
    async function sessionAction(action) {
      const btn = event.target;
      btn.disabled = true; btn.textContent = 'Please wait...';
      await fetch('/session/' + action, { method: 'POST', headers: {'Content-Type':'application/json'} });
      location.reload();
    }

    // ── Send daily report ──
    async function sendReport() {
      const btn = event.target;
      btn.disabled = true; btn.textContent = '📤 Sending...';
      const res = await fetch('/report', { method: 'POST', headers: {'Content-Type':'application/json'} });
      const data = await res.json();
      btn.textContent = data.success ? '✅ Report Sent!' : '❌ Failed — Check Logs';
      setTimeout(() => { btn.textContent = '📊 Send Report to Doctor'; btn.disabled = false; }, 3000);
    }

    // ── Patient actions ──
    async function markDone(id) {
      const btn = document.querySelector('#card-' + id + ' .done-btn');
      btn.textContent = 'Processing...'; btn.disabled = true;
      await fetch('/done', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id, staffName: myName }) });
      document.getElementById('card-' + id).remove();
    }

    async function skipPatient(id) {
      const card = document.getElementById('card-' + id);
      const btn = card.querySelector('.skip-btn');
      btn.textContent = 'Skipping...'; btn.disabled = true;
      const res = await fetch('/skip', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id, staffName: myName }) });
      const data = await res.json();
      if (data.success) { btn.textContent = '✅ #' + data.newQueueNumber; setTimeout(() => location.reload(), 1500); }
    }

    async function apptDone(id) {
      const btn = document.querySelector('#appt-' + id + ' .done-btn');
      btn.textContent = 'Processing...'; btn.disabled = true;
      await fetch('/appt-done', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ id, staffName: myName }) });
      document.getElementById('appt-' + id).remove();
    }
  </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🏥 Clinic Bot running on port ${PORT}`));

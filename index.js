const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  'https://vowebbdkibibcvrgqvqy.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZvd2ViYmRraWJpYmN2cmdxdnF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDUzODUxMzQsImV4cCI6MjA2MDk2MTEzNH0.GZYTU_j86IGBZFNWeSZvHHiG9Ki4ybkyY7ut9Jz800E'
);

const app = express();
app.use(express.json());

let sessionData = null, isReconnecting = false, client = null, startupTime = Date.now();

process.on('unhandledRejection', reason => console.error('🚨 Unhandled Rejection:', reason));
process.on('uncaughtException', err => console.error('🚨 Uncaught Exception:', err));

async function loadSession() {
  try {
    const { data } = await supabase.from('whatsapp_sessions').select('session_data').order('created_at', { ascending: false }).limit(1).single();
    sessionData = data?.session_data || null;
    console.log(sessionData ? '✅ Session loaded.' : '⚠️ No session found.');
  } catch (err) {
    console.error('❌ Load session error:', err.message);
  }
}

async function saveSession(session, attempt = 0) {
  try {
    if (!session || typeof session !== 'object' || Array.isArray(session)) {
      console.warn('⚠️ Invalid session object. Skipping save.');
      return;
    }
    const { error } = await supabase.from('whatsapp_sessions').upsert([{ session_key: 'default', session_data: session }], { onConflict: ['session_key'] });
    if (error) {
      console.error(`❌ Save session error (attempt ${attempt}):`, error.message);
      if (attempt < 2) await saveSession(session, attempt + 1);
    } else {
      console.log('💾 Session saved successfully.');
    }
  } catch (err) {
    console.error('❌ Save session crash:', err.message);
  }
}

function createWhatsAppClient() {
  return new Client({ puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] }, session: sessionData, ignoreSelfMessages: false });
}

function setupClientEvents(c) {
  c.on('qr', qr => console.log('📱 Scan QR:', 'https://api.qrserver.com/v1/create-qr-code/?data=' + encodeURIComponent(qr)));
  
  c.on('authenticated', () => {
  console.log('🔐 Authenticated.');
  // No session save here yet!
});

c.on('ready', async () => {
  console.log('✅ WhatsApp Bot Ready. Fetching session...');
  try {
    const rawSession = await client.pupPage.evaluate(() => window.localStorage.getItem('wweb-session'));
    if (rawSession) {
      await saveSession(JSON.parse(rawSession));
      console.log('💾 Session successfully saved after ready.');
    } else {
      console.warn('⚠️ No session data in browser.');
    }
  } catch (err) {
    console.error('❌ Fetch session error after ready:', err.message);
  }
});


  c.on('auth_failure', msg => console.error('❌ Authentication failed:', msg));
  c.on('ready', () => console.log('✅ WhatsApp Bot Ready.'));
  
  c.on('disconnected', async reason => {
    console.warn('⚠️ Disconnected:', reason);
    if (!isReconnecting) {
      isReconnecting = true;
      try { await client.destroy(); } catch (err) { console.warn('⚠️ Destroy client error:', err.message); }
      console.log('♻️ Restarting client in 10 seconds...');
      setTimeout(startClient, 10000);
    }
  });

  c.on('message', handleIncomingMessage);
}

async function handleIncomingMessage(msg) {
  if (!msg.from.endsWith('@g.us')) return;
  try {
    const groupId = msg.from, senderId = msg.author || msg.from, text = msg.body || '', messageId = msg?.id?.id?.toString?.() || '';
    let replyInfo = null;
    try {
      const quoted = await msg.getQuotedMessage?.();
      if (quoted?.id?.id) replyInfo = { message_id: quoted.id.id, text: quoted.body || '' };
    } catch (e) {
      console.warn('⚠️ Quoted message error:', e.message);
    }
    const isImportant = text.toLowerCase().includes('valuation') || (replyInfo && replyInfo.text.toLowerCase().includes('valuation'));
    if (!isImportant) return console.log('🚫 Non-valuation message ignored.');
    console.log(`[📩 Group]: ${groupId} | [👤 Sender]: ${senderId} | [📝 Text]: ${text} | [🆔]: ${messageId}`);
    await insertMessageSupabase(groupId, senderId, text);
    await sendToN8nWebhook({ groupId, senderId, text, messageId, reply_to_message: replyInfo });
  } catch (err) {
    console.error('❌ Message handler error:', err.message);
  }
}

async function insertMessageSupabase(groupId, senderId, text, attempt = 0) {
  try {
    const { error } = await supabase.from('messages').insert([{ group_id: groupId, sender_id: senderId, text, timestamp: new Date() }]);
    if (error) {
      console.error(`❌ Insert error (attempt ${attempt}):`, error.message);
      if (attempt < 2) await insertMessageSupabase(groupId, senderId, text, attempt + 1);
    } else {
      console.log('✅ Message stored.');
    }
  } catch (err) {
    console.error('❌ Insert crash:', err.message);
  }
}

async function sendToN8nWebhook(payload, attempt = 0) {
  try {
    await axios.post('https://kqmdigital.app.n8n.cloud/webhook/789280c9-ef0c-4c3a-b584-5b3036e5d799', payload);
    console.log('✅ Webhook sent.');
  } catch (err) {
    console.error(`❌ Webhook error (attempt ${attempt}):`, err.message);
    if (attempt < 2) await sendToN8nWebhook(payload, attempt + 1);
  }
}

async function startClient() {
  try {
    await loadSession();
    client = createWhatsAppClient();
    setupClientEvents(client);
    await client.initialize();
    console.log('🚀 WhatsApp client initialized.');
  } catch (err) {
    console.error('❌ Client start error:', err.message);
    setTimeout(startClient, 15000);
  }
}

app.post('/send-message', async (req, res) => {
  if (!client?.info?.wid) {
    console.warn('⚠️ WhatsApp not ready.');
    return res.status(503).send({ error: 'WhatsApp not connected' });
  }
  const { groupId, message } = req.body;
  try {
    const chat = await client.getChatById(groupId);
    const sent = await chat.sendMessage(message);
    res.send({ success: true, messageId: sent.id.id });
  } catch (err) {
    console.error('❌ Send message failed:', err.message);
    res.status(500).send({ error: err.message });
  }
});

app.get('/', (_, res) => res.send('✅ Bot is alive'));

app.get('/restart', async (_, res) => {
  const now = Date.now(), secondsSinceStart = (now - startupTime) / 1000;
  if (secondsSinceStart < 120) {
    console.warn('⚠️ Restart blocked: too soon after startup.');
    return res.status(429).send('Too early to restart after deploy.');
  }
  console.log('♻️ Manual Restart Triggered via /restart');
  try { if (client) await client.destroy().catch(e => console.warn('⚠️ Destroy during restart warning:', e.message)); } catch (e) {}
  client = createWhatsAppClient();
  setupClientEvents(client);
  await client.initialize();
  res.send('♻️ Bot Restarted Successfully');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Listening on http://localhost:${PORT}`));

startClient();

setInterval(async () => {
  console.log('♻️ Scheduled client refresh.');
  try { if (client) await client.destroy().catch(err => console.warn('⚠️ Scheduled destroy warning:', err.message)); } catch (err) {}
  startClient();
}, 21600 * 1000);

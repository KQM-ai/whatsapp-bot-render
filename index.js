const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// ✅ Setup Supabase Client
const supabase = createClient(
  'https://vowebbdkibibcvrgqvqy.supabase.co', // Replace this
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZvd2ViYmRraWJpYmN2cmdxdnF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDUzODUxMzQsImV4cCI6MjA2MDk2MTEzNH0.GZYTU_j86IGBZFNWeSZvHHiG9Ki4ybkyY7ut9Jz800E' // Replace this
);

const app = express();
app.use(express.json());

let sessionData = null;

async function loadSession() {
  const { data, error } = await supabase
    .from('whatsapp_sessions')
    .select('session_data')
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!error && data?.session_data) {
    sessionData = data.session_data;
    console.log('✅ Loaded session from Supabase');
  } else {
    console.warn('⚠️ No session data found, will start fresh.');
  }
}

async function saveSession(session) {
  const { error } = await supabase.from('whatsapp_sessions').insert([
    {
      session_key: 'default',
      session_data: session
    }
  ]);

  if (error) console.error('❌ Failed to save session:', error);
  else console.log('💾 Session saved to Supabase');
}

const client = new Client({
  puppeteer: { headless: true },
  ignoreSelfMessages: false,
  session: sessionData // inject session data if available
});

client.on('qr', (qr) => {
  console.log('📱 Scan your QR here:');
  console.log('🔗 https://api.qrserver.com/v1/create-qr-code/?data=' + encodeURIComponent(qr));
});

client.on('authenticated', async (session) => {
  await saveSession(session);
});

client.on('ready', () => {
  console.log('✅ WhatsApp Bot is ready!');
});

client.on('message', async (msg) => {
  if (!msg.from.endsWith('@g.us')) return;

  const groupId = msg.from;
  const senderId = msg.author || msg.from;
  const text = msg.body;

  console.log(`[Group]: ${groupId} | [Sender]: ${senderId} | [Text]: ${text}`);

  // ✅ Store message to Supabase
  await supabase.from('messages').insert([
    { group_id: groupId, sender_id: senderId, text, timestamp: new Date() }
  ]);

  // ✅ Optional: Send to n8n webhook
  await axios.post('https://kqm.app.n8n.cloud/webhook/28503625-b022-485b-af09-06cf4fd76802', {
    groupId,
    senderId,
    text,
    messageId: msg.id.id
  });
});

app.post('/send-message', async (req, res) => {
  const { groupId, message } = req.body;

  try {
    const chat = await client.getChatById(groupId);
    await chat.sendMessage(message);
    res.send({ success: true });
  } catch (err) {
    console.error('❌ Failed to send:', err.message);
    res.status(500).send({ error: err.message });
  }
});

const PORT = 3000;

// ✅ Health check route first
app.get('/', (req, res) => {
  res.send('✅ Bot is alive');
});

// ✅ Start the Express server
app.listen(PORT, () => {
  console.log(`🚀 Bot is listening on http://localhost:${PORT}`);
});

// ✅ Load WhatsApp session and start bot
loadSession().then(() => client.initialize());

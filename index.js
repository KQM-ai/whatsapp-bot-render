const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// ✅ Setup Supabase Client
const supabase = createClient(
  'https://vowebbdkibibcvrgqvqy.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZvd2ViYmRraWJpYmN2cmdxdnF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDUzODUxMzQsImV4cCI6MjA2MDk2MTEzNH0.GZYTU_j86IGBZFNWeSZvHHiG9Ki4ybkyY7ut9Jz800E'
);


const app = express();
app.use(express.json());

let sessionData = null;
let isReconnecting = false;
let client = null;

// ✅ Protection against unexpected crashes
process.on('unhandledRejection', (reason) => console.error('🚨 Unhandled Rejection:', reason));
process.on('uncaughtException', (err) => console.error('🚨 Uncaught Exception:', err));

// ✅ Load Session
async function loadSession() {
  try {
    const { data } = await supabase.from('whatsapp_sessions')
      .select('session_data')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();
    sessionData = data?.session_data || null;
    console.log(sessionData ? '✅ Session loaded.' : '⚠️ No session found.');
  } catch (err) {
    console.error('❌ Load session error:', err.message);
  }
}

// ✅ Save Session
async function saveSession(session, attempt = 0) {
  try {
    const { error } = await supabase.from('whatsapp_sessions').insert([{ session_key: 'default', session_data: session }]);
    if (error) {
      console.error(`❌ Save session error (attempt ${attempt}):`, error.message);
      if (attempt < 2) await saveSession(session, attempt + 1);
    } else {
      console.log('💾 Session saved.');
    }
  } catch (err) {
    console.error('❌ Save session crash:', err.message);
  }
}

// ✅ Create WhatsApp Client
function createWhatsAppClient() {
  return new Client({
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
    session: sessionData,
    ignoreSelfMessages: false,
  });
}

// ✅ Setup WhatsApp Events
function setupClientEvents(c) {
  c.on('qr', (qr) => {
    console.log('📱 Scan QR: https://api.qrserver.com/v1/create-qr-code/?data=' + encodeURIComponent(qr));
  });

  c.on('authenticated', (session) => {
    console.log('🔐 Authenticated');
    saveSession(session);
  });

  c.on('auth_failure', (msg) => {
    console.error('❌ Authentication failed:', msg);
  });

  c.on('ready', () => {
    console.log('✅ WhatsApp Bot Ready');
  });

  c.on('disconnected', async (reason) => {
    console.warn('⚠️ Disconnected:', reason);
    if (!isReconnecting) {
      isReconnecting = true;
      try {
        await client.destroy();
      } catch (err) {
        console.warn('⚠️ Destroy client error:', err.message);
      }
      console.log('♻️ Restarting client in 10s...');
      setTimeout(startClient, 10000);
    }
  });

  c.on('message', handleIncomingMessage);
}

// ✅ Handle incoming WhatsApp message
async function handleIncomingMessage(msg) {
  if (!msg.from.endsWith('@g.us')) return;

  try {
    const groupId = msg.from;
    const senderId = msg.author || msg.from;
    const text = msg.body || '';
    const messageId = msg?.id?.id?.toString?.() || '';

    let replyInfo = null;
    let hasReply = false;
    try {
      const quoted = await msg.getQuotedMessage?.();
      if (quoted?.id?.id) {
        hasReply = true;
        replyInfo = { message_id: quoted.id.id, text: quoted.body || '' };
      }
    } catch (e) {
      console.warn('⚠️ Quoted message error:', e.message);
    }

    const isImportant = text.toLowerCase().includes('valuation') ||
      (hasReply && replyInfo?.text?.toLowerCase().includes('valuation'));

    if (!isImportant) {
      console.log('🚫 Non-valuation message ignored.');
      return;
    }

    console.log(`[📩 Group]: ${groupId} | [👤 Sender]: ${senderId} | [📝 Text]: ${text} | [🆔]: ${messageId}`);

    await insertMessageSupabase(groupId, senderId, text);
    await sendToN8nWebhook({ groupId, senderId, text, messageId, reply_to_message: replyInfo });

  } catch (err) {
    console.error('❌ Message handler error:', err.message);
  }
}

// ✅ Insert Message to Supabase
async function insertMessageSupabase(groupId, senderId, text, attempt = 0) {
  try {
    const { error } = await supabase.from('messages').insert([
      { group_id: groupId, sender_id: senderId, text, timestamp: new Date() },
    ]);
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

// ✅ Send to n8n Webhook
async function sendToN8nWebhook(payload, attempt = 0) {
  try {
    await axios.post('https://kqmdigital.app.n8n.cloud/webhook/789280c9-ef0c-4c3a-b584-5b3036e5d799', payload);
    console.log('✅ Webhook sent.');
  } catch (err) {
    console.error(`❌ Webhook error (attempt ${attempt}):`, err.message);
    if (attempt < 2) await sendToN8nWebhook(payload, attempt + 1);
  }
}

// ✅ Start Client
async function startClient() {
  try {
    sessionData = null;
    await loadSession();
    client = createWhatsAppClient();
    setupClientEvents(client);
    await client.initialize();
    console.log('🚀 WhatsApp client initialized.');
  } catch (err) {
    console.error('❌ Client start error:', err.message);
    setTimeout(startClient, 15000); // retry if crash
  }
}

// ✅ Express Routes
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

// ✅ Restart API (Triggered by UptimeRobot)
app.get('/restart', async (_, res) => {
  console.log('♻️ Manual Restart Triggered via /restart');
  try {
    await client.destroy();
  } catch (e) {
    console.warn('⚠️ Destroy client failed during restart:', e.message);
  }
  client = createWhatsAppClient();
  setupClientEvents(client);
  await client.initialize();
  res.send('♻️ Bot Restarted Successfully');
});


// ✅ Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Listening on http://localhost:${PORT}`);
});

// ✅ Start everything
startClient();

// ✅ Scheduled Auto Refresh Every 6 Hours
setInterval(async () => {
  console.log('♻️ Scheduled client refresh.');
  try {
    await client.destroy();
  } catch (err) {
    console.warn('⚠️ Destroy during refresh error:', err.message);
  }
  startClient();
}, 21600 * 1000); // 6h

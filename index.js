const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// ✅ Setup Supabase Client
const supabase = createClient(
  'https://vowebbdkibibcvrgqvqy.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9....' // keep your key here
);

const app = express();
app.use(express.json());

let sessionData = null;
let isReconnecting = false;

// ✅ Global Protection
process.on('unhandledRejection', (reason) => {
  console.error('🚨 Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('🚨 Uncaught Exception:', err);
});

// ✅ Load session from Supabase
async function loadSession() {
  try {
    const { data } = await supabase
      .from('whatsapp_sessions')
      .select('session_data')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (data?.session_data) {
      sessionData = data.session_data;
      console.log('✅ Loaded session from Supabase');
    } else {
      console.warn('⚠️ No session found, starting fresh.');
    }
  } catch (err) {
    console.error('❌ Failed loading session:', err.message);
  }
}

// ✅ Save session with retry
async function saveSession(session, attempt = 0) {
  try {
    const { error } = await supabase.from('whatsapp_sessions').insert([
      { session_key: 'default', session_data: session },
    ]);
    if (error) {
      console.error(`❌ Supabase save error (attempt ${attempt}):`, error.message);
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
    ignoreSelfMessages: false,
    session: sessionData,
  });
}

let client = createWhatsAppClient();

// ✅ Setup Client Events
function setupClientEvents(client) {
  client.on('qr', (qr) => {
    console.log('📱 Scan QR:');
    console.log('🔗 https://api.qrserver.com/v1/create-qr-code/?data=' + encodeURIComponent(qr));
  });

  client.on('authenticated', (session) => {
    console.log('🔐 Authenticated');
    saveSession(session);
  });

  client.on('auth_failure', (msg) => {
    console.error('❌ Auth Failure:', msg);
  });

  client.on('disconnected', async (reason) => {
    console.warn('⚠️ Disconnected:', reason);
    if (!isReconnecting) {
      isReconnecting = true;
      try {
        await client.destroy();
      } catch (e) {
        console.warn('⚠️ Destroy client failed:', e.message);
      }
      console.log('♻️ Restarting client in 10s...');
      setTimeout(() => {
        client = createWhatsAppClient();
        setupClientEvents(client);
        client.initialize();
        isReconnecting = false;
      }, 10000);
    }
  });

  client.on('ready', () => {
    console.log('✅ WhatsApp Bot Ready');
  });

  client.on('message', async (msg) => {
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
        console.log('🚫 Ignored non-valuation message.');
        return;
      }

      console.log(`[📩 Group]: ${groupId} | [👤 Sender]: ${senderId} | [📝 Text]: ${text} | [🆔]: ${messageId}`);

      // ✅ Save message to Supabase (with retry)
      await insertMessageSupabase(groupId, senderId, text);

      // ✅ Send to n8n webhook (with retry)
      await sendToN8nWebhook({ groupId, senderId, text, messageId, reply_to_message: replyInfo });

    } catch (err) {
      console.error('❌ Message handling failed:', err.message);
    }
  });
}

// ✅ Insert message to Supabase (with retry)
async function insertMessageSupabase(groupId, senderId, text, attempt = 0) {
  try {
    const { error } = await supabase.from('messages').insert([
      { group_id: groupId, sender_id: senderId, text, timestamp: new Date() },
    ]);
    if (error) {
      console.error(`❌ Supabase insert error (attempt ${attempt}):`, error.message);
      if (attempt < 2) await insertMessageSupabase(groupId, senderId, text, attempt + 1);
    } else {
      console.log('✅ Message inserted to Supabase');
    }
  } catch (err) {
    console.error('❌ Insert crash:', err.message);
  }
}

// ✅ Send to n8n Webhook (with retry)
async function sendToN8nWebhook(payload, attempt = 0) {
  try {
    await axios.post('https://kqmdigital.app.n8n.cloud/webhook/789280c9-ef0c-4c3a-b584-5b3036e5d799', payload);
    console.log('✅ Sent to n8n webhook');
  } catch (err) {
    console.error(`❌ Webhook send error (attempt ${attempt}):`, err.message);
    if (attempt < 2) await sendToN8nWebhook(payload, attempt + 1);
  }
}

// ✅ Setup Express API
app.post('/send-message', async (req, res) => {
  const { groupId, message } = req.body;
  try {
    const chat = await client.getChatById(groupId);
    const sent = await chat.sendMessage(message);
    res.send({ success: true, messageId: sent.id.id });
  } catch (err) {
    console.error('❌ Send message error:', err.message);
    res.status(500).send({ error: err.message });
  }
});

app.get('/', (_, res) => res.send('✅ Bot alive'));

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Listening on http://localhost:${PORT}`);
});

// ✅ Initialize WhatsApp Bot
loadSession().then(() => {
  setupClientEvents(client);
  client.initialize();
});

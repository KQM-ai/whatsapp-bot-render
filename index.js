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
    console.error('❌ Error loading session:', err.message);
  }
}

// ✅ Save session to Supabase
async function saveSession(session) {
  try {
    const { error } = await supabase.from('whatsapp_sessions').insert([
      { session_key: 'default', session_data: session }
    ]);
    if (error) console.error('❌ Supabase save error:', error.message);
    else console.log('💾 Session saved to Supabase');
  } catch (err) {
    console.error('❌ Save session error:', err.message);
  }
}

// ✅ Create WhatsApp Client
function createWhatsAppClient() {
  return new Client({
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
    ignoreSelfMessages: false,
    session: sessionData
  });
}

let client = createWhatsAppClient();

// ✅ Setup Client Event Handlers
function setupClientEvents(client) {
  client.on('qr', (qr) => {
    console.log('📱 Scan QR:');
    console.log('🔗 https://api.qrserver.com/v1/create-qr-code/?data=' + encodeURIComponent(qr));
  });

  client.on('authenticated', async (session) => {
    console.log('🔐 Authenticated');
    await saveSession(session);
  });

  client.on('auth_failure', (msg) => {
    console.error('❌ Authentication failed:', msg);
  });

  client.on('disconnected', async (reason) => {
    console.warn('⚠️ Disconnected:', reason);
    if (!isReconnecting) {
      isReconnecting = true;
      try {
        await client.destroy();
      } catch (err) {
        console.warn('⚠️ Error destroying client:', err.message);
      }
      console.log('♻️ Reinitializing in 10s...');
      setTimeout(() => {
        client = createWhatsAppClient();
        setupClientEvents(client);
        client.initialize();
        isReconnecting = false;
      }, 10000);
    }
  });

  client.on('ready', () => {
    console.log('✅ WhatsApp Bot is ready!');
  });

  // ✅ Main message handler
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
          replyInfo = {
            message_id: quoted.id.id,
            text: quoted.body || ''
          };
        }
      } catch (err) {
        console.warn('⚠️ Failed to get quoted message:', err.message);
      }

      // ✅ Important trigger logic
      const isImportantMessage =
        text.toLowerCase().includes('valuation') || // New Valuation Request
        (hasReply && replyInfo?.text?.toLowerCase().includes('valuation')); // Reply to Valuation

      if (!isImportantMessage) {
        console.log('🚫 Ignored non-valuation message.');
        return;
      }

      console.log(`[Group]: ${groupId} | [Sender]: ${senderId} | [Text]: ${text} | [messageId]: ${messageId}`);

      // ✅ Save message to Supabase
      const { error } = await supabase.from('messages').insert([
        { group_id: groupId, sender_id: senderId, text, timestamp: new Date() }
      ]);
      if (error) console.error('❌ Supabase insert error:', error.message);

      // ✅ Send to n8n webhook
      await axios.post('https://kqmdigital.app.n8n.cloud/webhook/789280c9-ef0c-4c3a-b584-5b3036e5d799', {
        groupId,
        senderId,
        text,
        messageId,
        reply_to_message: replyInfo
      }).catch(err => {
        console.error('❌ Failed to send to n8n:', err.message);
      });

    } catch (err) {
      console.error('❌ Error processing message:', err.message);
    }
  });
}

// ✅ Setup Express Routes
app.post('/send-message', async (req, res) => {
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

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

// ✅ Load session and start bot
loadSession().then(() => {
  setupClientEvents(client);
  client.initialize();
});

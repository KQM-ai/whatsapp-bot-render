const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

let client = null;
let isReconnecting = false;

// ✅ Handle QR Scan
function setupClientEvents(c) {
  c.on('qr', (qr) => {
    console.log('📱 Scan QR:', 'https://api.qrserver.com/v1/create-qr-code/?data=' + encodeURIComponent(qr));
  });

  c.on('authenticated', () => {
    console.log('🔐 Authenticated.');
  });

  c.on('ready', () => {
    console.log('✅ WhatsApp Bot Ready.');
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
      console.log('♻️ Restarting client in 10 seconds...');
      setTimeout(startClient, 10000);
    }
  });

  c.on('message', handleIncomingMessage);
}

// ✅ Handle Incoming Message
async function handleIncomingMessage(msg) {
  if (!msg.from.endsWith('@g.us')) return;

  try {
    const groupId = msg.from;
    const senderId = msg.author || msg.from;
    const text = msg.body || '';
    const messageId = msg?.id?.id?.toString?.() || '';

    const quoted = await msg.getQuotedMessage?.().catch(() => null);
    const replyText = quoted?.body || '';
    const isImportant = text.toLowerCase().includes('valuation') || replyText.toLowerCase().includes('valuation');

    if (!isImportant) {
      console.log('🚫 Non-valuation message ignored.');
      return;
    }

    console.log(`[📩 Group]: ${groupId} | [👤 Sender]: ${senderId} | [📝 Text]: ${text} | [🆔]: ${messageId}`);

    await sendToN8nWebhook({ groupId, senderId, text, messageId, reply_to_message: replyText });

  } catch (err) {
    console.error('❌ Message handler error:', err.message);
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

// ✅ Create WhatsApp Client
function createWhatsAppClient() {
  return new Client({
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
    ignoreSelfMessages: false
  });
}

// ✅ Start WhatsApp Client
async function startClient() {
  try {
    client = createWhatsAppClient();
    setupClientEvents(client);
    await client.initialize();
    console.log('🚀 WhatsApp client initialized.');
  } catch (err) {
    console.error('❌ Client start error:', err.message);
    setTimeout(startClient, 15000);
  }
}

// ✅ API Routes
app.get('/', (_, res) => res.send('✅ Bot is alive'));

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

// ✅ Server Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Listening on http://localhost:${PORT}`);
});

// ✅ Start Bot
startClient();

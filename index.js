const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { headless: true }
});

client.on('qr', (qr) => {
  console.log('📱 Scan your QR here:');
  console.log('🔗 https://api.qrserver.com/v1/create-qr-code/?data=' + encodeURIComponent(qr));
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

  // Optional: Send to your n8n webhook
  await axios.post('https://your-n8n-webhook-url/webhook/whatsapp-incoming', {
    groupId,
    senderId,
    text
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
app.listen(PORT, () => {
  console.log(`🚀 Bot is listening on http://localhost:${PORT}`);
});

client.initialize();

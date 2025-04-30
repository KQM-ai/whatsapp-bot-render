const fs = require('fs');
const path = require('path');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// --- Config ---
const PORT = process.env.PORT || 3000;
const SESSION_ID = process.env.WHATSAPP_SESSION_ID || 'default_session';
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

console.log('🔍 Loaded N8N_WEBHOOK_URL:', N8N_WEBHOOK_URL);

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ Missing Supabase credentials. Exiting.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const log = (level, message, ...args) => {
  const timestamp = new Date().toISOString();
  const formatted = `[${timestamp}] [${level.toUpperCase()}] [${SESSION_ID}] ${message}`;
  console[level](formatted, ...args);
};

// --- Supabase Store for WhatsApp Session ---
class SupabaseStore {
  constructor(supabaseClient, sessionId) {
    this.supabase = supabaseClient;
    this.sessionId = sessionId;
    log('info', `SupabaseStore initialized for session ID: ${this.sessionId}`);
  }

  async sessionExists({ session }) {
    try {
      const { count, error } = await this.supabase
        .from('whatsapp_sessions')
        .select('*', { count: 'exact', head: true })
        .eq('session_key', session);

      if (error) {
        log('error', `Supabase error in sessionExists: ${error.message}`);
        return false;
      }
      return count > 0;
    } catch (err) {
      log('error', `Exception in sessionExists: ${err.message}`);
      return false;
    }
  }

  async extract() {
    const { data, error } = await this.supabase
      .from('whatsapp_sessions')
      .select('session_data')
      .eq('session_key', this.sessionId)
      .limit(1)
      .single();

    if (error) return null;
    return data?.session_data || null;
  }

  async save(sessionData) {
    const { error } = await this.supabase
      .from('whatsapp_sessions')
      .upsert({ session_key: this.sessionId, session_data: sessionData }, { onConflict: 'session_key' });

    if (error) log('error', `Failed to save session: ${error.message}`);
  }

  async delete() {
    const { error } = await this.supabase
      .from('whatsapp_sessions')
      .delete()
      .eq('session_key', this.sessionId);

    if (error) log('error', `Failed to delete session: ${error.message}`);
  }
}

const supabaseStore = new SupabaseStore(supabase, SESSION_ID);
let client = null;
function createWhatsAppClient() {
  const sessionPath = path.join(__dirname, `.wwebjs_auth/session-${SESSION_ID}`);
  const parentDir = path.dirname(sessionPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
    log('info', `📁 Created session directory: ${parentDir}`);
  }

  return new Client({
    authStrategy: new RemoteAuth({
      store: supabaseStore,
      backupSyncIntervalMs: 300000,
      dataPath: sessionPath,
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
      ],
    },
    qrTimeout: 0,
  });
}

function setupClientEvents(c) {
 c.on('qr', qr => {
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}`;
  log('warn', `📱 Scan QR Code: ${qrUrl}`);
});

  c.on('ready', () => {
    log('info', '✅ WhatsApp client is ready.');
  });

  c.on('authenticated', () => {
    log('info', '🔐 Client authenticated.');
  });

  c.on('remote_session_saved', () => {
    log('info', '💾 Session saved to Supabase.');
  });

  c.on('disconnected', async reason => {
    log('warn', `Client disconnected: ${reason}`);
    if (client) {
      await client.destroy();
      client = null;
    }
    setTimeout(startClient, 10000);
  });

  c.on('auth_failure', async () => {
    log('error', '❌ Auth failed. Clearing session.');
    await supabaseStore.delete();
    process.exit(1);
  });

  c.on('message', handleIncomingMessage);
}

let messageCount = 0;

async function handleIncomingMessage(msg) {
  if (!msg.from.endsWith('@g.us')) return;

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
        message_id: quoted?.id?.id || null,
        text: quoted?.body || null,
      };
    }
  } catch (err) {
    log('warn', `⚠️ Failed to get quoted message: ${err.message}`);
  }

  const isImportant =
    text.toLowerCase().includes('valuation') ||
    (hasReply && replyInfo?.text?.toLowerCase().includes('valuation'));

  if (!isImportant) {
    log('info', '🚫 Ignored non-valuation message.');
    return;
  }

  // Memory logging every 50 messages
  messageCount++;
  if (messageCount % 50 === 0) {
    const mem = process.memoryUsage();
    log(
      'info',
      `🧠 Memory usage — RSS: ${(mem.rss / 1024 / 1024).toFixed(1)} MB, Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`
    );
  }

  const payload = {
    groupId,
    senderId,
    text,
    messageId,
    hasReply,
    replyInfo,
    timestamp: new Date(msg.timestamp * 1000).toISOString(),
  };

  await sendToN8nWebhook(payload);
}

async function sendToN8nWebhook(payload, attempt = 0) {
  if (!N8N_WEBHOOK_URL) {
    log('warn', 'Webhook skipped: N8N_WEBHOOK_URL not set.');
    return;
  }

  // Truncate long texts
  if (payload.text?.length > 1000) {
    payload.text = payload.text.slice(0, 1000) + '... [truncated]';
  }
  if (payload.replyInfo?.text?.length > 500) {
    payload.replyInfo.text = payload.replyInfo.text.slice(0, 500) + '... [truncated]';
  }

  // Estimate payload size
  const payloadSize = Buffer.byteLength(JSON.stringify(payload), 'utf8');
  if (payloadSize > 90_000) {
    log('warn', `🚫 Payload too large (${payloadSize} bytes). Skipping webhook.`);
    return;
  }

  try {
    await axios.post(N8N_WEBHOOK_URL, payload, { timeout: 10000 });
    log('info', `✅ Webhook sent (${payloadSize} bytes).`);
  } catch (err) {
    log('error', `Webhook attempt ${attempt + 1} failed: ${err.message}`);
    if (attempt < 2) {
      setTimeout(() => sendToN8nWebhook(payload, attempt + 1), 1000 * (attempt + 1));
    }
  }
}

async function startClient() {
  if (client) return;
  client = createWhatsAppClient();
  setupClientEvents(client);
  await client.initialize();
}

const app = express();
app.use(express.json());

app.get('/', (_, res) => {
  res.status(200).json({ status: '✅ Bot running', sessionId: SESSION_ID });
});
app.post('/send-message', async (req, res) => {
  const { groupId, message } = req.body;

  if (!groupId || !message) {
    return res.status(400).json({ success: false, error: 'Missing groupId or message' });
  }

  if (!client) {
    return res.status(503).json({ success: false, error: 'WhatsApp client not ready' });
  }

  try {
    const formattedGroupId = groupId.endsWith('@g.us') ? groupId : `${groupId}@g.us`;
    const sentMessage = await client.sendMessage(formattedGroupId, message);
    return res.status(200).json({ success: true, messageId: sentMessage.id.id });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  log('info', `🚀 Server started on http://localhost:${PORT}`);
  startClient();
});

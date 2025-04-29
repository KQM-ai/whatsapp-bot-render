const fs = require('fs');
const path = require('path');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://kqmdigital.app.n8n.cloud/webhook/789280c9-ef0c-4c3a-b584-5b3036e5d799';
const SESSION_ID = process.env.WHATSAPP_SESSION_ID || 'default_session';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

console.log('🔍 Loaded N8N_WEBHOOK_URL:', process.env.N8N_WEBHOOK_URL);

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('❌ Missing Supabase credentials.');
  process.exit(1);
}
if (N8N_WEBHOOK_URL === 'https://kqmdigital.app.n8n.cloud/webhook/789280c9-ef0c-4c3a-b584-5b3036e5d799') {
  console.warn('⚠️ N8N_WEBHOOK_URL is not set in environment variables. Webhook sending will fail.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const log = (level, message, ...args) => {
  const timestamp = new Date().toISOString();
  const sanitizedArgs = args.map(arg => (typeof arg === 'object' && arg !== null) ? JSON.stringify(arg) : arg);
  console[level](`[${timestamp}] [${level.toUpperCase()}] [${SESSION_ID}] ${message}`, ...sanitizedArgs);
};

class SupabaseStore {
  constructor(supabaseClient, sessionId) {
    this.supabase = supabaseClient;
    this.sessionId = sessionId;
    log('info', `SupabaseStore initialized for session ID: ${this.sessionId}`);
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
    console.log('📱 Scan QR Code:', `https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(qr)}`);
    qrcode.generate(qr, { small: true });
  });

  c.on('ready', () => {
    log('info', '✅ WhatsApp client ready.');
  });

  c.on('authenticated', () => {
    log('info', '🔐 Authenticated.');
  });

  c.on('remote_session_saved', () => {
    log('info', '💾 Session saved to Supabase.');
  });

  c.on('disconnected', async reason => {
    log('warn', `⚠️ Disconnected: ${reason}`);
    await client.destroy();
    client = null;
    setTimeout(startClient, 10000);
  });

  c.on('auth_failure', async () => {
    log('error', '❌ Auth failed. Clearing session.');
    await supabaseStore.delete();
    process.exit(1);
  });

  c.on('message', handleIncomingMessage);
}

async function handleIncomingMessage(msg) {
  if (!msg.from.endsWith('@g.us')) return;
  const payload = {
    groupId: msg.from,
    senderId: msg.author || msg.from,
    text: msg.body,
    messageId: msg.id.id,
    timestamp: new Date(msg.timestamp * 1000).toISOString(),
  };
  await sendToN8nWebhook(payload);
}

async function sendToN8nWebhook(payload, attempt = 0) {
  try {
    await axios.post(N8N_WEBHOOK_URL, payload, { timeout: 10000 });
    log('info', '✅ Webhook sent.');
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
  res.status(200).json({ status: '✅ Bot is alive', sessionId: SESSION_ID });
});

app.listen(PORT, () => {
  log('info', `🚀 Server running on http://localhost:${PORT}`);
  startClient();
});

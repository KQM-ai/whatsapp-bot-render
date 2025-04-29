// index.js

// --- Core Dependencies ---
const { Client, RemoteAuth } = require('whatsapp-web.js');
// IMPORTANT: Regularly update whatsapp-web.js: npm install whatsapp-web.js@latest
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');
const process = require('process');

// --- Supabase Integration ---
const { createClient } = require('@supabase/supabase-js');

// --- Configuration (Use Environment Variables!) ---
const PORT = process.env.PORT || 3000;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://kqmdigital.app.n8n.cloud/webhook/789280c9-ef0c-4c3a-b584-5b3036e5d799'; // <-- SET VIA ENV VAR
const MAX_WEBHOOK_RETRIES = 3;
const INITIAL_RECONNECT_DELAY = 5000; // 5 seconds
const MAX_RECONNECT_DELAY = 300000; // 5 minutes
const SESSION_ID = process.env.WHATSAPP_SESSION_ID || 'default_session'; // Identifier for this bot's session in Supabase

// Supabase Credentials (LOAD FROM ENVIRONMENT VARIABLES)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables. Exiting.");
  process.exit(1);
}
if (N8N_WEBHOOK_URL === 'https://kqmdigital.app.n8n.cloud/webhook/789280c9-ef0c-4c3a-b584-5b3036e5d799') {
    console.warn("⚠️ N8N_WEBHOOK_URL is not set in environment variables. Webhook sending will fail.");
}

// --- Supabase Client Initialization ---
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// --- Logging Utility ---
const log = (level, message, ...args) => {
  const timestamp = new Date().toISOString();
  // Avoid logging large objects directly unless necessary for debugging
  const sanitizedArgs = args.map(arg => (typeof arg === 'object' && arg !== null) ? JSON.stringify(arg) : arg);
  console[level](`[<span class="math-inline">\{timestamp\}\] \[</span>{level.toUpperCase()}] [${SESSION_ID}] ${message}`, ...sanitizedArgs);
};

// --- Custom Supabase Store for RemoteAuth ---
class SupabaseStore {
  constructor(supabaseClient, sessionId) {
    this.supabase = supabaseClient;
    this.sessionId = sessionId; // The unique key for this session in the DB
    log('info', `SupabaseStore initialized for session ID: ${this.sessionId}`);
  }

  async sessionExists() {
      log('debug', `Checking if session exists for key: ${this.sessionId}`);
      try {
          const { data, error, count } = await this.supabase
              .from('whatsapp_sessions')
              .select('session_key', { count: 'exact', head: true }) // More efficient check
              .eq('session_key', this.sessionId);

          if (error) {
              log('error', `Supabase error checking session existence: ${error.message}`);
              return false; // Assume false on error
          }
          const exists = count > 0;
          log('info', `Session check result for ${this.sessionId}: ${exists}`);
          return exists;
      } catch (err) {
          log('error', `Exception checking session existence: ${err.message}`);
          return false;
      }
  }


  async extract() {
      log('info', `Attempting to extract session for key: ${this.sessionId}`);
      try {
          const { data, error } = await this.supabase
              .from('whatsapp_sessions')
              .select('session_data')
              .eq('session_key', this.sessionId)
              .limit(1)
              .single(); // Expects zero or one row

          if (error && error.code !== 'PGRST116') { // Ignore 'Row not found' error
              log('error', `Supabase error extracting session: ${error.message}`);
              return null;
          }
          if (data?.session_data) {
              log('info', `✅ Successfully extracted session data for ${this.sessionId}.`);
              return data.session_data;
          } else {
              log('info', `No session data found in Supabase for ${this.sessionId}.`);
              return null;
          }
      } catch(err) {
          log('error', `Exception extracting session: ${err.message}`);
          return null;
      }
  }

  async save(sessionData) {
      log('info', `Attempting to save session for key: ${this.sessionId}`);
      try {
          // Use upsert: inserts if session_key doesn't exist, updates if it does
          const { error } = await this.supabase
              .from('whatsapp_sessions')
              .upsert(
                  {
                      session_key: this.sessionId,
                      session_data: sessionData,
                      // updated_at should ideally be handled by DB trigger/default
                  },
                  { onConflict: 'session_key' } // Specify the conflict column
              );

          if (error) {
              log('error', `❌ Supabase error saving session: ${error.message}`);
          } else {
              log('info', `💾 Session successfully saved/updated in Supabase for ${this.sessionId}.`);
          }
      } catch(err) {
          log('error', `Exception saving session: ${err.message}`);
      }
  }

  async delete() {
      log('info', `Attempting to delete session for key: ${this.sessionId}`);
      try {
          const { error } = await this.supabase
              .from('whatsapp_sessions')
              .delete()
              .eq('session_key', this.sessionId);

          if (error) {
              log('error', `❌ Supabase error deleting session: ${error.message}`);
          } else {
              log('info', `🗑️ Session deleted from Supabase for ${this.sessionId}.`);
          }
      } catch (err) {
          log('error', `Exception deleting session: ${err.message}`);
      }
  }
}

// Instantiate the custom store
const supabaseStore = new SupabaseStore(supabase, SESSION_ID);

// --- Global State (WhatsApp Client related) ---
let client = null;
let clientState = 'DISCONNECTED'; // 'DISCONNECTED', 'INITIALIZING', 'QR', 'AUTHENTICATING', 'READY', 'ERROR'
let reconnectAttempts = 0;
let currentReconnectDelay = INITIAL_RECONNECT_DELAY;

// --- Express App Setup ---
const app = express();
app.use(express.json());

// --- Utility Functions ---
const getExponentialBackoffDelay = (attempts, initialDelay, maxDelay) => {
  return Math.min(initialDelay * Math.pow(2, attempts), maxDelay);
};

// --- WhatsApp Client Setup and Event Handling ---

/**
 * Creates and configures the WhatsApp client instance using RemoteAuth with SupabaseStore.
 */
function createWhatsAppClient() {
  log('info', 'Creating WhatsApp client with RemoteAuth (SupabaseStore)...');
  clientState = 'INITIALIZING';

  return new Client({
    authStrategy: new RemoteAuth({
      store: supabaseStore,
      backupSyncIntervalMs: 300000, // How often to sync session data to Supabase (e.g., 5 mins)
      dataPath: `./.wwebjs_auth/session-${SESSION_ID}` // Local cache path (RemoteAuth uses this as a temp cache)
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
        '--single-process', // May reduce memory but test stability
        '--disable-gpu'
      ],
      // executablePath: process.env.PUPPETEER_EXECUTABLE_PATH, // Uncomment if needed
    },
    qrTimeout: 0, // Wait indefinitely for QR scan
  });
}

/**
 * Sets up all the necessary event listeners for the WhatsApp client.
 * @param {Client} c The WhatsApp client instance.
 */
function setupClientEvents(c) {
  log('info', 'Setting up client event listeners...');

  c.on('qr', (qr) => {
    clientState = 'QR';
    log('warn', 'QR code received. Scan required.');
    console.log('📱 Scan QR Code URL:', 'https://api.qrserver.com/v1/create-qr-code/?data=' + encodeURIComponent(qr));
    qrcode.generate(qr, { small: true });
  });

  c.on('authenticated', () => {
    clientState = 'AUTHENTICATING'; // Still need 'ready' event
    log('info', '🔐 Client authenticated successfully.');
    // Session saving is handled automatically by RemoteAuth strategy via the store's save method.
    reconnectAttempts = 0;
    currentReconnectDelay = INITIAL_RECONNECT_DELAY;
  });

  c.on('ready', () => {
    clientState = 'READY';
    log('info', '✅ WhatsApp Bot Ready.');
    reconnectAttempts = 0;
    currentReconnectDelay = INITIAL_RECONNECT_DELAY;
  });

  c.on('remote_session_saved', () => {
      // This event confirms RemoteAuth successfully saved the session via the store
      log('info', '💾 Remote session saved successfully (Confirmed via event).');
  });


  c.on('disconnected', async (reason) => {
    log('warn', `⚠️ Client disconnected. Reason: ${reason}`);
    const oldState = clientState;
    clientState = 'DISCONNECTED';
    if (client) {
      try {
        log('info', 'Attempting to destroy disconnected client instance...');
        await client.destroy();
        log('info', 'Disconnected client instance destroyed.');
      } catch (err) {
        log('error', '⚠️ Error destroying client:', err.message);
      } finally {
        client = null;
      }
    }
    // Only schedule reconnect if it wasn't already in an error/auth_failure state that might need manual intervention
    if (oldState !== 'ERROR' && oldState !== 'AUTHENTICATING') { // Avoid reconnect loops on persistent auth failures
         scheduleReconnect();
    } else {
        log('warn', `Disconnect occurred from state ${oldState}. Reconnect not automatically scheduled.`);
    }
  });

  c.on('auth_failure', async (msg) => {
    clientState = 'ERROR';
    log('error', `❌ Authentication failure: ${msg}`);
    log('error', 'Session might be invalid. Attempting to delete session from Supabase...');
    // Delete the potentially invalid session from Supabase to force a new QR scan on next start
    await supabaseStore.delete(); // Use the delete method of the store
    log('error', 'Authentication failed. Session deleted. Restart required for new QR Scan.');

    // Stop trying to reconnect automatically after auth failure, requires manual restart/intervention
    if (client) {
      try {
        await client.destroy();
      } catch (err) { log('error', 'Error destroying client after auth failure:', err.message); }
      finally { client = null; }
    }
    // Optional: exit process to force manual restart after auth failure
    // process.exit(1);
  });

  c.on('error', (err) => {
      clientState = 'ERROR';
      log('error', '❌ Unhandled WhatsApp client error:', err);
  });

  c.on('message', handleIncomingMessage);
}

/**
 * Schedules a reconnection attempt with exponential backoff.
 */
function scheduleReconnect() {
    if (clientState === 'INITIALIZING' || clientState === 'READY') {
        log('warn', 'Reconnect scheduled but client is already initializing or ready. Aborting reconnect.');
        return;
    }
    if (client) {
        log('warn', 'Client instance still exists during reconnect scheduling. Nullifying.');
        client = null;
    }

    reconnectAttempts++;
    currentReconnectDelay = getExponentialBackoffDelay(reconnectAttempts, INITIAL_RECONNECT_DELAY, MAX_RECONNECT_DELAY);
    log('info', `♻️ Scheduling client restart attempt ${reconnectAttempts} in ${currentReconnectDelay / 1000} seconds...`);
    clientState = 'INITIALIZING';
    setTimeout(startClient, currentReconnectDelay);
}


// --- Message Handling Logic ---

/**
 * Handles incoming WhatsApp messages.
 * @param {Message} msg The received message object.
 */
async function handleIncomingMessage(msg) {
  if (!msg.from.endsWith('@g.us')) return;
  if (clientState !== 'READY') {
      log('warn', `Ignoring message ${msg.id?.id}: Client not ready (state: ${clientState})`);
      return;
  }

  const messageId = msg?.id?.id?.toString?.() || 'UNKNOWN_ID';
  const groupId = msg.from;
  const senderId = msg.author || msg.from;

  try {
    const text = msg.body || '';
    log('debug', `Received message: [Group]: ${groupId} | [Sender]: ${senderId} | [ID]: ${messageId} | [Text]: ${text.substring(0, 50)}...`);

    let quoted = null;
    let replyText = '';
    if (msg.hasQuotedMsg) {
      try {
        quoted = await msg.getQuotedMessage();
        replyText = quoted?.body || '';
      } catch (quoteErr) {
        log('warn', `Error getting quoted message for ${messageId}: ${quoteErr.message}`);
      }
    }

    const isImportant = text.toLowerCase().includes('valuation') || replyText.toLowerCase().includes('valuation');

    if (!isImportant) {
      return;
    }

    log('info', `[VALUATION] Detected: [Group]: ${groupId} | [Sender]: ${senderId} | [Text]: ${text} | [Reply]: ${replyText} | [ID]: ${messageId}`);

    const payload = {
      groupId,
      senderId,
      text,
      messageId,
      reply_to_message: replyText,
      timestamp: new Date(msg.timestamp * 1000).toISOString(),
    };

    await sendToN8nWebhook(payload);

  } catch (err) {
    log('error', `❌ Error handling message ${messageId} from ${senderId} in ${groupId}: ${err.message}`, err.stack);
  }
}

// --- Webhook Interaction ---

/**
 * Sends data to the n8n webhook with retries using exponential backoff.
 * @param {object} payload The data to send.
 * @param {number} attempt The current attempt number (starts at 0).
 */
async function sendToN8nWebhook(payload, attempt = 0) {
  if (!N8N_WEBHOOK_URL || N8N_WEBHOOK_URL === 'YOUR_N8N_WEBHOOK_URL_HERE') {
      log('error', 'N8N_WEBHOOK_URL is not set correctly. Cannot send webhook.');
      return;
  }

  log('info', `Attempting to send webhook (Attempt <span class="math-inline">\{attempt \+ 1\}/</span>{MAX_WEBHOOK_RETRIES})...`);
  try {
    await axios.post(N8N_WEBHOOK_URL, payload, { timeout: 10000 });
    log('info', '✅ Webhook sent successfully.');
  } catch (err) {
    log('error', `❌ Webhook error (Attempt ${attempt + 1}): ${err.message}`);
    if (attempt < MAX_WEBHOOK_RETRIES - 1) {
      const retryDelay = getExponentialBackoffDelay(attempt, 1000, 30000);
      log('info', `Retrying webhook in ${retryDelay / 1000} seconds...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
      await sendToN8nWebhook(payload, attempt + 1);
    } else {
      log('error', `❌ Failed to send webhook after ${MAX_WEBHOOK_RETRIES} attempts. Payload:`, JSON.stringify(payload));
    }
  }
}

// --- Client Initialization ---

/**
 * Initializes the WhatsApp client, sets up events, and starts the connection.
 */
async function startClient() {
  if (client || clientState === 'INITIALIZING') {
    log('warn', `startClient called but client exists or is already initializing (State: ${clientState}). Aborting.`);
    return;
  }

  log('info', '🚀 Starting WhatsApp client initialization...');
  clientState = 'INITIALIZING';

  try {
    client = createWhatsAppClient();
    setupClientEvents(client);
    await client.initialize();
    // 'ready' event confirms success
  } catch (err) {
    clientState = 'ERROR';
    log('error', `❌ Client initialization failed: ${err.message}`, err.stack);
    if (client) {
      try { await client.destroy(); }
      catch (destroyErr) { log('error', 'Error destroying client after init failure:', destroyErr.message); }
      finally { client = null; }
    }
    // Don't automatically reconnect immediately after a failed init, could be QR/Auth issue
    // Consider if scheduleReconnect() is desired here or if manual intervention is better
    log('error', 'Initialization failed. Manual check/restart might be needed.');
    // scheduleReconnect(); // Uncomment if you want auto-retry even on init failure
  }
}

// --- API Routes ---
app.get('/', (_, res) => {
  res.status(200).json({
      status: '✅ Bot is alive',
      clientState: clientState,
      sessionId: SESSION_ID,
      reconnectAttempts: reconnectAttempts,
      webhookUrlSet: !!N8N_WEBHOOK_URL && N8N_WEBHOOK_URL !== 'YOUR_N8N_WEBHOOK_URL_HERE',
      timestamp: new Date().toISOString()
  });
});

app.post('/send-message', async (req, res) => {
  log('info', 'Received POST /send-message request');

  if (clientState !== 'READY' || !client) {
    log('warn', `⚠️ Send message failed: WhatsApp client not ready (State: ${clientState}).`);
    return res.status(503).send({ success: false, error: `WhatsApp client not ready (State: ${clientState})` });
  }

  const { groupId, message } = req.body;
  if (!groupId || !message) {
    log('warn', '⚠️ Send message failed: Missing groupId or message in request body.');
    return res.status(400).send({ success: false, error: 'Missing groupId or message' });
  }

  try {
    log('info', `Attempting to send message to group ${groupId}`);
    const formattedGroupId = groupId.endsWith('@g.us') ? groupId : `${groupId}@g.us`;
    const sentMessage = await client.sendMessage(formattedGroupId, message);
    log('info', `✅ Message sent successfully to ${formattedGroupId}. Message ID: ${sentMessage.id.id}`);
    res.status(200).send({ success: true, messageId: sentMessage.id.id });
  } catch (err) {
    log('error', `❌ Send message failed to group ${groupId}: ${err.message}`, err.stack);
    res.status(500).send({ success: false, error: err.message || 'Failed to send message' });
  }
});

// Optional: Add an endpoint to manually clear the session from Supabase if needed
app.post('/clear-session', async (req, res) => {
    log('warn', 'Received POST /clear-session request');
    // Add security here if needed (e.g., check an API key in headers/body)
    // const apiKey = req.headers['x-api-key'];
    // if (apiKey !== process.env.ADMIN_API_KEY) {
    //     log('error', 'Unauthorized /clear-session attempt');
    //     return res.status(401).send({ success: false, error: 'Unauthorized' });
    // }
    try {
        await supabaseStore.delete();
        log('info', 'Session cleared successfully via API request.');
        // Optionally try to destroy current client if running
        if (client) {
            await client.destroy();
            client = null;
            clientState = 'DISCONNECTED';
            log('info', 'Destroyed current client after session clear.');
        }
        res.status(200).send({ success: true, message: `Session ${SESSION_ID} cleared.`});
    } catch (err) {
        log('error', `Error clearing session via API: ${err.message}`);
        res.status(500).send({ success: false, error: 'Failed to clear session.' });
    }
});


// --- Server Start and Graceful Shutdown ---
const server = app.listen(PORT, () => {
  log('info', `🚀 Server listening on http://localhost:${PORT}`);
  startClient();
});

const gracefulShutdown = async (signal) => {
  log('warn', `Received ${signal}. Shutting down gracefully...`);
  constprevState = clientState;
  clientState = 'DISCONNECTED';

  server.close(async () => {
    log('info', 'HTTP server closed.');
    if (client) {
      log('info', 'Destroying WhatsApp client...');
      try {
        await client.destroy();
        log('info', 'WhatsApp client destroyed successfully.');
      } catch (err) {
        log('error', 'Error destroying WhatsApp client during shutdown:', err.message);
      }
    }
    // Allow RemoteAuth some time to potentially save the session on clean shutdown
    // await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s
    process.exit(0);
  });

  setTimeout(() => {
    log('error', 'Graceful shutdown timed out. Forcing exit.');
    process.exit(1);
  }, 10000); // 10 seconds timeout
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

log('info', 'Application setup complete. Starting server...');

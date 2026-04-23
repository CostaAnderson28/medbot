import 'dotenv/config.js';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { setupDatabase, getDb } from './db/setup.js';
import { buildPrompt } from './prompt-builder.js';
import { parseInstagramMessage, handleInstagramMessage, sendInstagramResponse, fetchInstagramProfile } from './instagram-handler.js';
import { authMiddleware } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import scheduleRoutes from './routes/schedule.js';
import instructionsRoutes from './routes/instructions.js';
import metricsRoutes from './routes/metrics.js';
import settingsRoutes from './routes/settings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
setupDatabase();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '..', 'public')));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'meu_token_secreto';
const PORT = process.env.PORT || 3000;
const ANTHROPIC_TIMEOUT_MS = Number(process.env.ANTHROPIC_TIMEOUT_MS || 15000);
const ANTHROPIC_RETRIES = Number(process.env.ANTHROPIC_RETRIES || 3);
const DEBUG_CLAUDE = process.env.DEBUG_CLAUDE !== '0';

const RETRYABLE_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function isRetryableAnthropicError(status, err) {
  if (RETRYABLE_HTTP_STATUS.has(status)) return true;
  const type = String(err?.type || '').toLowerCase();
  return type.includes('rate_limit') || type.includes('overloaded') || type.includes('timeout');
}

function claudeLog(level, event, payload) {
  if (level === 'info' && !DEBUG_CLAUDE) return;
  const fn = level === 'error' ? console.error : (level === 'warn' ? console.warn : console.log);
  fn(`[Claude][${event}]`, payload);
}

function extractClaudeText(data) {
  const content = Array.isArray(data?.content) ? data.content : [];
  const textFromBlocks = content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('');

  const outputText = typeof data?.output_text === 'string' ? data.output_text : '';
  const legacyCompletion = typeof data?.completion === 'string' ? data.completion : '';

  const rawText = textFromBlocks || outputText || legacyCompletion || '';
  return {
    rawText,
    normalizedText: String(rawText).trim(),
    source: textFromBlocks ? 'content.text' : (outputText ? 'output_text' : (legacyCompletion ? 'completion' : 'none')),
    contentBlockTypes: content.map(b => b?.type || 'unknown'),
    contentBlocks: content.length
  };
}

app.use('/api/auth', authRoutes);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/instructions', instructionsRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/settings', settingsRoutes);

const conversationHistory = new Map();

function getNowInSaoPaulo() {
  const now = new Date();
  const dateText = now.toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  });
  const timeText = now.toLocaleTimeString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit'
  });
  return { dateText, timeText };
}

function buildTemporalSystemContext() {
  const { dateText, timeText } = getNowInSaoPaulo();
  return `## CONTEXTO TEMPORAL ATUAL\n- Data atual (America/Sao_Paulo): ${dateText}\n- Hora atual (America/Sao_Paulo): ${timeText}\n- Se perguntarem data ou hora, use exatamente este contexto e nao invente.`;
}

async function callClaude(systemPrompt, messages, ctx = {}) {
  const systemWithTime = `${systemPrompt}\n\n${buildTemporalSystemContext()}`;
  const reqCtx = {
    channel: ctx.channel || 'api-chat',
    doctorId: ctx.doctorId || null,
    traceId: ctx.traceId || null,
    phase: ctx.phase || 'default'
  };

  for (let attempt = 0; attempt <= ANTHROPIC_RETRIES; attempt++) {
    const attemptNo = attempt + 1;
    const maxAttempts = ANTHROPIC_RETRIES + 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS);
    claudeLog('info', 'attempt_start', { ...reqCtx, attempt: attemptNo, maxAttempts, inputMessages: messages.length });

    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 500, system: systemWithTime, messages }),
        signal: controller.signal
      });
      clearTimeout(timer);

      const raw = await res.text();
      const parsed = safeJsonParse(raw);
      if (!parsed) {
        claudeLog('error', 'parse_error', {
          ...reqCtx,
          attempt: attemptNo,
          maxAttempts,
          status: res.status,
          contentType: res.headers.get('content-type') || null,
          rawLength: raw.length,
          rawSample: raw.slice(0, 300)
        });
        if (attempt < ANTHROPIC_RETRIES) {
          claudeLog('warn', 'retry_scheduled', { ...reqCtx, attempt: attemptNo, reason: 'parse_error' });
          await delay(350 * (2 ** attempt));
          continue;
        }
        return null;
      }

      const data = parsed;
      const apiError = data?.error || null;

      if (!res.ok || apiError) {
        const requestId = res.headers.get('request-id') || res.headers.get('x-request-id') || null;
        claudeLog('error', 'api_error', {
          ...reqCtx,
          attempt: attemptNo,
          maxAttempts,
          status: res.status,
          requestId,
          error: apiError || { message: raw.slice(0, 500) }
        });

        if (attempt < ANTHROPIC_RETRIES && isRetryableAnthropicError(res.status, apiError)) {
          claudeLog('warn', 'retry_scheduled', { ...reqCtx, attempt: attemptNo, reason: 'api_error', status: res.status });
          await delay(350 * (2 ** attempt));
          continue;
        }
        return null;
      }

      const extracted = extractClaudeText(data);
      if (!extracted.normalizedText) {
        claudeLog('warn', 'empty_response', {
          ...reqCtx,
          attempt: attemptNo,
          maxAttempts,
          stopReason: data?.stop_reason || null,
          usage: data?.usage || null,
          outputSource: extracted.source,
          outputCharsRaw: extracted.rawText.length,
          outputPreview: extracted.rawText.slice(0, 120),
          contentBlockTypes: extracted.contentBlockTypes,
          contentBlocks: extracted.contentBlocks
        });
        if (attempt < ANTHROPIC_RETRIES) {
          claudeLog('warn', 'retry_scheduled', { ...reqCtx, attempt: attemptNo, reason: 'empty_response' });
          await delay(350 * (2 ** attempt));
          continue;
        }
        return null;
      }

      claudeLog('info', 'attempt_success', { ...reqCtx, attempt: attemptNo, maxAttempts, outputChars: extracted.normalizedText.length, outputSource: extracted.source });
      return extracted.normalizedText;
    } catch (error) {
      clearTimeout(timer);
      const timedOut = error?.name === 'AbortError';
      claudeLog('error', 'network_error', {
        ...reqCtx,
        attempt: attemptNo,
        maxAttempts,
        timeoutMs: ANTHROPIC_TIMEOUT_MS,
        timedOut,
        message: error?.message
      });

      if (attempt < ANTHROPIC_RETRIES) {
        claudeLog('warn', 'retry_scheduled', { ...reqCtx, attempt: attemptNo, reason: timedOut ? 'timeout' : 'network_error' });
        await delay(350 * (2 ** attempt));
        continue;
      }
      return null;
    }
  }

  return null;
}

function findDoctorByPageId(pageId) {
  const db = getDb();
  const doc = db.prepare('SELECT id FROM doctors WHERE page_id=? AND bot_active=1').get(pageId);
  db.close();
  return doc?.id;
}

function trackConversation(doctorId, senderId, role, content) {
  const db = getDb();
  let conv = db.prepare('SELECT * FROM conversations WHERE doctor_id=? AND sender_id=? ORDER BY started_at DESC LIMIT 1').get(doctorId, senderId);
  if (!conv) {
    const r = db.prepare('INSERT INTO conversations (doctor_id,sender_id) VALUES(?,?)').run(doctorId, senderId);
    conv = { id: r.lastInsertRowid };
  }
  db.prepare('INSERT INTO messages (conversation_id,role,content) VALUES(?,?,?)').run(conv.id, role, content);
  let extra = '';
  if (role === 'assistant') {
    if (content.includes('doclogos')) extra += ',link_sent=1';
    if (/secretaria/i.test(content)) extra += ',whatsapp_redirect=1';
    if (/urgencia/i.test(content)) extra += ',urgency=1';
  }
  db.prepare("UPDATE conversations SET message_count=message_count+1,last_message_at=datetime('now')" + extra + " WHERE id=?").run(conv.id);
  db.close();
}

// Chat endpoint - simulation + demo
app.post('/api/chat', async (req, res) => {
  const { messages, doctorId } = req.body;
  if (!messages) return res.status(400).json({ error: 'Mensagens obrigatorias' });
  const traceId = `chat:${doctorId || 'dr-antonio'}:${Date.now()}`;

  const id = doctorId || 'dr-antonio';
  const result = buildPrompt(id);
  if (!result) return res.status(404).json({ error: 'Doutor nao encontrado' });

  const db = getDb();
  const doc = db.prepare('SELECT delay_first,delay_min,delay_max FROM doctors WHERE id=?').get(id);
  db.close();
  const dFirst = (doc?.delay_first || 3) * 1000;
  const dMin = (doc?.delay_min || 2) * 1000;
  const dMax = (doc?.delay_max || 3) * 1000;
  const isFirst = messages.filter(m => m.role === 'user').length === 1;
  const delay = isFirst ? dFirst : dMin + Math.floor(Math.random() * (dMax - dMin + 1));
  await new Promise(r => setTimeout(r, delay));

  const reply = await callClaude(result.prompt, messages, { channel: 'api-chat', doctorId: id, traceId, phase: 'primary' });
  if (!reply) {
    console.warn('[API_CHAT][fallback]', { traceId, doctorId: id, reason: 'primary_call_failed' });
  }
  res.json({ reply: reply || 'Tive um probleminha. Liga: ' + (result.doctor.phone || '(21) 2703-6100') });
});

// Instagram webhook
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) { console.log('Webhook verificado!'); return res.status(200).send(challenge); }
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  console.log('POST recebido:', JSON.stringify(req.body, null, 2));
  try {
    if (req.body.object !== 'instagram') return;

    for (const entry of req.body.entry || []) {
      const pageId = entry.id;
      const doctorId = findDoctorByPageId(pageId);

      if (!doctorId) {
        console.warn('Nenhum doutor para pageId:', pageId);
        continue;
      }

      // Formato real do Instagram Webhooks
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const event = change.value;

        if (event?.message?.is_echo) continue;

        const senderId = event?.sender?.id;
        const messageText = event?.message?.text;

        if (!senderId || !messageText) {
          console.warn('Mensagem inválida ou sem texto');
          continue;
        }

        await handleInstagramMessage(senderId, messageText, doctorId);
      }

      // Formato Messenger Platform (fallback)
      for (const event of entry.messaging || []) {
        if (event.message?.is_echo) continue;

        const senderId = event.sender?.id;
        const messageText = event.message?.text;

        if (!senderId || !messageText) continue;

        await handleInstagramMessage(senderId, messageText, doctorId);
      }
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }
});
// Rota para buscar conversas reais do banco
app.get('/api/conversations', authMiddleware, async (req, res) => {
  const doctorId = req.doctor.id;
  const db = getDb();

  try {
    // Busca conversas do doutor
    const conversations = db.prepare(`
      SELECT c.*, 
        (SELECT COUNT(*) FROM messages WHERE conversation_id=c.id AND role='user') as user_msg_count
      FROM conversations c 
      WHERE doctor_id=?
      ORDER BY last_message_at DESC
      LIMIT 50
    `).all(doctorId);

    // Tenta enriquecer nomes de conversas antigas ainda sem perfil salvo.
    for (const conv of conversations) {
      if ((conv.lead_name || conv.instagram_username) || !conv.sender_id) continue;
      const profile = await fetchInstagramProfile(conv.sender_id);
      const profileName = profile?.name ? String(profile.name).trim() : null;
      const profileUsername = profile?.username ? String(profile.username).trim() : null;
      if (!profileName && !profileUsername) continue;

      db.prepare('UPDATE conversations SET lead_name=COALESCE(?, lead_name), instagram_username=COALESCE(?, instagram_username) WHERE id=?')
        .run(profileName || null, profileUsername || null, conv.id);

      if (!conv.lead_name && profileName) conv.lead_name = profileName;
      if (!conv.instagram_username && profileUsername) conv.instagram_username = profileUsername;
    }

    // Para cada conversa, busca as mensagens
    const result = conversations.map(conv => {
      const messages = db.prepare(`
        SELECT role, content, created_at FROM messages 
        WHERE conversation_id=? 
        ORDER BY created_at ASC
      `).all(conv.id);

      // Formata para o frontend
      const msgs = messages.map(m => ({
        r: m.role === 'user' ? 'u' : 'b',
        c: m.content,
        t: new Date(m.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      }));

      // Detecta status
      let status = 'sem';
      if (conv.link_sent) status = 'link';
      if (conv.whatsapp_redirect) status = 'wpp';
      if (conv.urgency) status = 'urgencia';

      return {
        id: conv.id,
        name: conv.lead_name || (conv.instagram_username ? '@' + conv.instagram_username : 'Cliente'),
        sender_id: conv.sender_id,
        instagram_username: conv.instagram_username,
        phone: conv.lead_phone,
        conv: conv.lead_convenio,
        mot: messages.length > 0 ? messages[0].content.substring(0, 30) : 'Conversa',
        st: status,
        date: new Date(conv.started_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
        msgs: msgs,
        user_msg_count: conv.user_msg_count
      };
    });

    db.close();
    res.json(result);
  } catch (err) {
    db.close();
    console.error('Error fetching conversations:', err);
    res.status(500).json({ error: 'Erro ao buscar conversas' });
  }
});

app.post('/api/conversations/:id/manual-message', authMiddleware, async (req, res) => {
  const doctorId = req.doctor?.id;
  const conversationId = Number(req.params.id);
  const text = String(req.body?.text || '').trim();

  if (!doctorId) return res.status(401).json({ error: 'Nao autenticado' });
  if (!conversationId || conversationId < 1) return res.status(400).json({ error: 'Conversa invalida' });
  if (!text) return res.status(400).json({ error: 'Mensagem vazia' });

  const db = getDb();
  try {
    const conv = db.prepare('SELECT id, sender_id FROM conversations WHERE id=? AND doctor_id=?').get(conversationId, doctorId);
    if (!conv) {
      db.close();
      return res.status(404).json({ error: 'Conversa nao encontrada' });
    }
    if (!conv.sender_id) {
      db.close();
      return res.status(400).json({ error: 'Conversa sem sender_id do Instagram' });
    }

    const sent = await sendInstagramResponse(conv.sender_id, text);
    if (!sent) {
      db.close();
      return res.status(502).json({ error: 'Falha ao enviar mensagem para o Instagram' });
    }

    db.prepare('INSERT INTO messages (conversation_id,role,content) VALUES(?,?,?)').run(conversationId, 'assistant', text);

    let extra = '';
    if (text.includes('doclogos')) extra += ',link_sent=1';
    if (/secretaria/i.test(text)) extra += ',whatsapp_redirect=1';
    if (/urgencia/i.test(text)) extra += ',urgency=1';
    db.prepare("UPDATE conversations SET message_count=message_count+1,last_message_at=datetime('now')" + extra + ' WHERE id=?').run(conversationId);

    db.close();
    return res.json({ ok: true });
  } catch (err) {
    db.close();
    console.error('Erro ao enviar mensagem manual:', err);
    return res.status(500).json({ error: 'Erro interno ao enviar mensagem' });
  }
});
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.get('*', (req, res) => { if (!req.path.startsWith('/api')) res.sendFile(join(__dirname, '..', 'public', 'index.html')); });
app.listen(PORT, () => console.log('Servidor rodando em http://localhost:' + PORT));

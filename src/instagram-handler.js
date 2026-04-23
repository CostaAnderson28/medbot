import 'dotenv/config.js';
import { buildPrompt } from './prompt-builder.js';
import { getDb } from './db/setup.js';

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const profileCache = new Map();
const ANTHROPIC_TIMEOUT_MS = Number(process.env.ANTHROPIC_TIMEOUT_MS || 15000);
const ANTHROPIC_RETRIES = Number(process.env.ANTHROPIC_RETRIES || 3);
const ANTHROPIC_MODEL_PRIMARY = process.env.ANTHROPIC_MODEL_PRIMARY || 'claude-sonnet-4-20250514';
const ANTHROPIC_MODEL_FALLBACK = process.env.ANTHROPIC_MODEL_FALLBACK || 'claude-3-5-haiku-20241022';
const ANTHROPIC_ENABLE_MODEL_FALLBACK = process.env.ANTHROPIC_ENABLE_MODEL_FALLBACK !== '0';
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

function buildReducedRecentMessages(messages) {
  if (!Array.isArray(messages) || !messages.length) return messages;

  const filtered = messages
    .filter(m => (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string')
    .slice(-8)
    .map(m => ({ role: m.role, content: String(m.content).slice(0, 1200) }));

  return filtered.length ? filtered : messages;
}

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

function pickBestDisplayName(profile) {
  if (!profile) return null;
  if (profile.name && String(profile.name).trim()) return String(profile.name).trim();
  if (profile.username && String(profile.username).trim()) return `@${String(profile.username).trim()}`;
  return null;
}

export async function fetchInstagramProfile(senderId) {
  if (!senderId || !PAGE_ACCESS_TOKEN || PAGE_ACCESS_TOKEN === 'preencher-depois') return null;

  const cacheKey = String(senderId);
  const cached = profileCache.get(cacheKey);
  const now = Date.now();
  if (cached && (now - cached.ts) < 6 * 60 * 60 * 1000) return cached.value;

  const urls = [
    `https://graph.facebook.com/v18.0/${encodeURIComponent(senderId)}?fields=name,username&access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`,
    `https://graph.instagram.com/v18.0/${encodeURIComponent(senderId)}?fields=name,username&access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const value = {
        name: data?.name ? String(data.name) : null,
        username: data?.username ? String(data.username) : null
      };
      profileCache.set(cacheKey, { ts: now, value });
      return value;
    } catch (_) {
      // Tentativa seguinte
    }
  }

  profileCache.set(cacheKey, { ts: now, value: null });
  return null;
}

/**
 * Faz uma chamada para Claude (igual ao server.js)
 */
async function callClaude(systemPrompt, messages, ctx = {}) {
  const systemWithTime = `${systemPrompt}\n\n${buildTemporalSystemContext()}`;
  const model = ctx.model || ANTHROPIC_MODEL_PRIMARY;
  const reqCtx = {
    channel: ctx.channel || 'instagram',
    doctorId: ctx.doctorId || null,
    senderId: ctx.senderId || null,
    traceId: ctx.traceId || null,
    phase: ctx.phase || 'default',
    model
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
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model,
          max_tokens: 500,
          system: systemWithTime,
          messages
        }),
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

async function callClaudeReliable(systemPrompt, messages, ctx = {}) {
  const models = [ANTHROPIC_MODEL_PRIMARY];
  if (ANTHROPIC_ENABLE_MODEL_FALLBACK && ANTHROPIC_MODEL_FALLBACK && ANTHROPIC_MODEL_FALLBACK !== ANTHROPIC_MODEL_PRIMARY) {
    models.push(ANTHROPIC_MODEL_FALLBACK);
  }

  const variants = [
    { name: 'full_context', messages },
    { name: 'reduced_recent_context', messages: buildReducedRecentMessages(messages) }
  ];

  for (const model of models) {
    for (const variant of variants) {
      const reply = await callClaude(systemPrompt, variant.messages, {
        ...ctx,
        model,
        phase: `${ctx.phase || 'default'}:${variant.name}`
      });
      if (reply) return reply;
    }
  }

  return null;
}

/**
 * Rastreia conversa no banco de dados (igual ao server.js)
 */
function trackConversation(doctorId, senderId, role, content, profile = null) {
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
  
  const displayName = pickBestDisplayName(profile);
  const username = profile?.username && String(profile.username).trim() ? String(profile.username).trim() : null;
  let profileSql = '';
  const params = [];

  if (displayName) {
    profileSql += ', lead_name = ?';
    params.push(displayName);
  }
  if (username) {
    profileSql += ', instagram_username = ?';
    params.push(username);
  }

  db.prepare("UPDATE conversations SET message_count=message_count+1,last_message_at=datetime('now')" + extra + profileSql + " WHERE id=?").run(...params, conv.id);
  db.close();
}

/**
 * Extrai dados do webhook do Instagram
 * @param {Object} webhookData - Body do POST /webhook da Meta
 * @returns {Object} { senderId, messageText, pageId }
 */
export function parseInstagramMessage(webhookData) {
  try {
    const entry = webhookData.entry?.[0];
    const messaging = entry?.messaging?.[0];
    
    const senderId = messaging?.sender?.id;
    const messageText = messaging?.message?.text;
    const pageId = entry?.id;
    
    if (!senderId || !messageText) {
      console.warn('Invalid Instagram message format');
      return null;
    }
    
    return { senderId, messageText, pageId };
  } catch (error) {
    console.error('Error parsing Instagram message:', error);
    return null;
  }
}

/**
 * Envia resposta para o Instagram via Meta Graph API
 * @param {string} senderId - ID do usuário no Instagram
 * @param {string} text - Texto da resposta
 * @returns {Promise<boolean>} True se enviou com sucesso
 */
export async function sendInstagramResponse(senderId, text) {
  if (!PAGE_ACCESS_TOKEN || PAGE_ACCESS_TOKEN === 'preencher-depois') {
    console.warn('PAGE_ACCESS_TOKEN não configurado. Resposta não será enviada ao Instagram.');
    return false;
  }

  try {
    const url = 'https://graph.instagram.com/v18.0/me/messages';
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        recipient: { id: senderId },
        message: { text: text },
        access_token: PAGE_ACCESS_TOKEN
      })
    });

    if (!response.ok) {
      const error = await response.json();
      console.error('Instagram API error:', error);
      return false;
    }

    const result = await response.json();
    console.log('Resposta enviada ao Instagram:', result.message_id);
    return true;
  } catch (error) {
    console.error('Error sending Instagram response:', error);
    return false;
  }
}

/**
 * Processa uma mensagem do Instagram:
 * 1. Extrai dados
 * 2. Chama Claude
 * 3. Salva na conversa
 * 4. Envia resposta pro Instagram
 * 
 * @param {string} senderId - ID do usuário
 * @param {string} messageText - Mensagem recebida
 * @param {string} doctorId - ID do médico
 * @returns {Promise<string>} Resposta enviada
 */
export async function handleInstagramMessage(senderId, messageText, doctorId) {
  try {
    // Valida entrada
    if (!senderId || !messageText || !doctorId) {
      console.error('Missing required parameters');
      return null;
    }

    // Salva mensagem do usuário com nome/username do perfil, quando disponível.
    const profile = await fetchInstagramProfile(senderId);
    trackConversation(doctorId, senderId, 'user', messageText, profile);
    const traceId = `${doctorId}:${senderId}:${Date.now()}`;
    console.log('[Instagram][inbound]', { traceId, doctorId, senderId, userChars: String(messageText || '').length });

    // Busca prompt do médico
    const result = buildPrompt(doctorId);
    if (!result) {
      const errorMsg = 'Desculpe, tive uma dificuldade. Tente novamente mais tarde.';
      trackConversation(doctorId, senderId, 'assistant', errorMsg);
      await sendInstagramResponse(senderId, errorMsg);
      return errorMsg;
    }

    // Busca histórico de mensagens
    const db = getDb();
    const conv = db.prepare('SELECT id FROM conversations WHERE doctor_id=? AND sender_id=? ORDER BY started_at DESC LIMIT 1').get(doctorId, senderId);
    
    let messages = [];
    if (conv) {
      const history = db.prepare('SELECT role, content FROM messages WHERE conversation_id=? ORDER BY created_at ASC LIMIT 10').all(conv.id);
      messages = history.map(m => ({ role: m.role, content: m.content }));
    }
    db.close();

    // Chama Claude
    const reply = await callClaudeReliable(result.prompt, messages, { channel: 'instagram', doctorId, senderId, traceId, phase: 'primary' });
    
    if (!reply) {
      console.warn('[Instagram][fallback_phase_1]', { traceId, doctorId, senderId, reason: 'all_reliable_attempts_failed' });
      const finalFallback = 'Obrigada pela paciencia. Pode repetir sua pergunta, por favor?';
      trackConversation(doctorId, senderId, 'assistant', finalFallback);
      await sendInstagramResponse(senderId, finalFallback);
      return finalFallback;
    }

    // Salva resposta
    trackConversation(doctorId, senderId, 'assistant', reply);

    // Envia pro Instagram
    await sendInstagramResponse(senderId, reply);

    console.log('[Instagram][outbound_success]', { traceId, doctorId, senderId, replyChars: reply.length });
    return reply;
  } catch (error) {
    console.error('Error handling Instagram message:', error);
    const errorMsg = 'Desculpe, ocorreu um erro. Tente novamente.';
    await sendInstagramResponse(senderId, errorMsg);
    return null;
  }
}

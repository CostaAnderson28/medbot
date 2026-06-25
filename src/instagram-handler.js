import 'dotenv/config.js';
import { buildPrompt } from './prompt-builder.js';
import { getDb } from './db/setup.js';

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';
const PAGE_TOKEN_ARRASCAETA = process.env.PAGE_TOKEN_ARRASCAETA || '';
const PAGE_TOKEN_ANTONIO = process.env.PAGE_TOKEN_ANTONIO || '';
const PAGE_TOKEN_OFTALMOCLINICA = process.env.PAGE_TOKEN_OFTALMOCLINICA || '';
const PAGE_TOKEN_R15MADEIREIRA = process.env.PAGE_TOKEN_R15MADEIREIRA || '';
const PAGE_TOKEN_ITACARROS = process.env.PAGE_TOKEN_ITACARROS || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const profileCache = new Map();
const ANTHROPIC_TIMEOUT_MS = Number(process.env.ANTHROPIC_TIMEOUT_MS || 15000);
const ANTHROPIC_RETRIES = Number(process.env.ANTHROPIC_RETRIES || 3);
const ANTHROPIC_MODEL_PRIMARY = process.env.ANTHROPIC_MODEL_PRIMARY || 'claude-sonnet-4-6';
const ANTHROPIC_MODEL_FALLBACK = process.env.ANTHROPIC_MODEL_FALLBACK || 'claude-haiku-4-5-20251001';
const ANTHROPIC_ENABLE_MODEL_FALLBACK = process.env.ANTHROPIC_ENABLE_MODEL_FALLBACK !== '0';
const DEBUG_CLAUDE = process.env.DEBUG_CLAUDE !== '0';
const MAX_REPLY_SENTENCES = Number(process.env.MAX_REPLY_SENTENCES || 3);
const MAX_REPLY_CHARS = Number(process.env.MAX_REPLY_CHARS || 360);
// Quantas mensagens do historico recarregar por turno. Antes era 10 fixo (~5 trocas),
// o que fazia o bot "esquecer" dados dados no inicio de conversas mais longas.
const INSTAGRAM_HISTORY_LIMIT = Number(process.env.INSTAGRAM_HISTORY_LIMIT || 40);
// Limite de bytes pra imagem inline (base64). Acima disso, pede por escrito.
const VISION_MAX_BYTES = Number(process.env.VISION_MAX_BYTES || 4 * 1024 * 1024);
const VISION_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
// Instrucao anexada ao turno com imagem: ler e SEMPRE confirmar os valores antes de seguir.
const VISION_INSTRUCTION = 'O paciente enviou a imagem acima. Leia com atencao qualquer informacao relevante (por exemplo, valores de receita: esferico e cilindrico de OD e OE). Antes de prosseguir, REPITA em texto os valores ou dados que voce entendeu e PECA CONFIRMACAO ao paciente. Se a imagem estiver ilegivel ou incompleta, peca os valores por escrito, sem chutar.';
// Resposta quando ha anexo mas nao foi possivel ler a imagem.
const IMAGE_UNREADABLE_REPLY = 'Recebi seu anexo, mas nao consegui abrir a imagem por aqui. Pode me enviar as informacoes por escrito, por favor?';

const RETRYABLE_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function getPageAccessTokenForDoctor(doctorId) {
  // Mapa legado dos tenants antigos (preserva os nomes historicos das env vars).
  const legacyMap = {
    'dr-arrascaeta': PAGE_TOKEN_ARRASCAETA,
    'dr-antonio': PAGE_TOKEN_ANTONIO,
    'oftalmoclinica-icarai': PAGE_TOKEN_OFTALMOCLINICA,
    'r15-madeireira': PAGE_TOKEN_R15MADEIREIRA,
    'ita-carros': PAGE_TOKEN_ITACARROS
  };
  if (legacyMap[doctorId]) return legacyMap[doctorId];

  // Convencao dinamica pra novos tenants:
  //   doctor_id 'dr-francisco' -> env PAGE_TOKEN_DRFRANCISCO
  //   doctor_id 'clinica-xyz'  -> env PAGE_TOKEN_CLINICAXYZ
  // Tira tracos, deixa em UPPERCASE.
  const envName = 'PAGE_TOKEN_' + String(doctorId || '').replace(/-/g, '').toUpperCase();
  const token = process.env[envName];
  if (token) return token;

  return PAGE_ACCESS_TOKEN || '';
}

// Retorna o NOME da env var do token de um tenant (pra mensagens de log/diagnostico).
// Espelha getPageAccessTokenForDoctor: tenants legados tem nomes historicos.
function getPageTokenEnvVarName(doctorId) {
  const legacyNames = {
    'dr-arrascaeta': 'PAGE_TOKEN_ARRASCAETA',
    'dr-antonio': 'PAGE_TOKEN_ANTONIO',
    'oftalmoclinica-icarai': 'PAGE_TOKEN_OFTALMOCLINICA',
    'r15-madeireira': 'PAGE_TOKEN_R15MADEIREIRA',
    'ita-carros': 'PAGE_TOKEN_ITACARROS'
  };
  return legacyNames[doctorId]
    || 'PAGE_TOKEN_' + String(doctorId || '').replace(/-/g, '').toUpperCase();
}

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

function getLogTimeContext() {
  const { dateText, timeText } = getNowInSaoPaulo();
  return { logTimeIso: new Date().toISOString(), spDateText: dateText, spTimeText: timeText };
}

function claudeLog(level, event, payload) {
  if (level === 'info' && !DEBUG_CLAUDE) return;
  const fn = level === 'error' ? console.error : (level === 'warn' ? console.warn : console.log);
  const timeCtx = getLogTimeContext();
  const fullPayload = payload && typeof payload === 'object' ? { ...payload, ...timeCtx } : { payload, ...timeCtx };
  fn(`[Claude][${event}]`, fullPayload);
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

function buildEssentialSystemPrompt(doctorId) {
  const db = getDb();
  try {
    const doc = db.prepare('SELECT name,clinic,address,phone,whatsapp FROM doctors WHERE id=?').get(doctorId);
    if (!doc) return null;

    const schedules = db.prepare(
      "SELECT day,morning_start,morning_end,afternoon_start,afternoon_end,location FROM schedules WHERE doctor_id=? ORDER BY CASE day WHEN 'segunda' THEN 1 WHEN 'terca' THEN 2 WHEN 'quarta' THEN 3 WHEN 'quinta' THEN 4 WHEN 'sexta' THEN 5 WHEN 'sabado' THEN 6 END"
    ).all(doctorId);
    const instructions = db.prepare('SELECT category,content FROM instructions WHERE doctor_id=? AND active=1').all(doctorId);

    const byCat = {};
    for (const i of instructions) {
      if (!byCat[i.category]) byCat[i.category] = [];
      byCat[i.category].push(i.content);
    }

    let p = `Voce e o proprio ${doc.name || 'doutor'} respondendo no Instagram da ${doc.clinic || 'clinica'} em ${doc.address || 'Niteroi'}.
Fale em portugues do Brasil, de forma objetiva e acolhedora.
Nunca use emojis, nunca use diminutivos, nunca invente informacoes.
Se nao souber algo, direcione para consulta presencial sem mencionar IA.
Telefone: ${doc.phone || ''}
WhatsApp: ${doc.whatsapp || ''}
`;

    if (schedules.length) {
      p += '\n## AGENDA\n';
      for (const s of schedules) {
        const parts = [];
        if (s.morning_start && s.morning_end) parts.push(`manha ${s.morning_start}-${s.morning_end}`);
        if (s.afternoon_start && s.afternoon_end) parts.push(`tarde ${s.afternoon_start}-${s.afternoon_end}`);
        p += `- ${s.day}: ${parts.length ? parts.join(' | ') : 'nao atende'}${s.location ? ` (${s.location})` : ''}\n`;
      }
    }

    if (byCat.procedimentos?.length) p += `\n## PROCEDIMENTOS\n${byCat.procedimentos.join('\n')}\n`;
    if (byCat.agendamento?.length) p += `\n## AGENDAMENTO\n${byCat.agendamento.join('\n')}\n`;
    if (byCat.convenios?.length) p += `\n## CONVENIOS\n${byCat.convenios.join('\n')}\n`;

    p += '\nResponda sempre em 2 a 4 frases, com orientacao util e proximo passo claro.';
    return p;
  } finally {
    db.close();
  }
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

function buildTemporalReminderMessage() {
  const { dateText, timeText } = getNowInSaoPaulo();
  return {
    role: 'user',
    content: `[Sistema: A data e hora atual e ${dateText} ${timeText} (America/Sao_Paulo). Ignore qualquer data mencionada no historico e responda com base apenas nesta data atual.]`
  };
}

function pickBestDisplayName(profile) {
  if (!profile) return null;
  if (profile.name && String(profile.name).trim()) return String(profile.name).trim();
  if (profile.username && String(profile.username).trim()) return `@${String(profile.username).trim()}`;
  return null;
}

function isGreetingOnlyMessage(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (!raw) return false;
  const normalized = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return false;
  const greetingPattern = /^(oi|ola|bom dia|boa tarde|boa noite|e ai|fala|opa|tudo bem|tudo bom|bom dia dr|boa tarde dr|boa noite dr)$/;
  return greetingPattern.test(normalized);
}

// Detecta referencia temporal numa mensagem do bot. O trecho de DATA escrita exige
// nome de mes (ex.: "26 de junho") pra NAO confundir com termos do dominio
// (ex.: "-4 de miopia", "2 de astigmatismo") — antes a regex casava "numero + de +
// qualquer palavra" e apagava respostas clinicas inteiras do historico, fazendo o
// bot repetir tudo por nao ver as proprias mensagens.
const TEMPORAL_PATTERN_RE = /(\b(hoje|amanha|amanhã|ontem)\b)|(\b\d{1,2}\/\d{1,2}\/\d{2,4}\b)|(\b\d{1,2}\s+de\s+(janeiro|fevereiro|marco|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b)/i;
function shouldDropTemporalAssistantMessage(message) {
  if (!message || message.role !== 'assistant' || typeof message.content !== 'string') return false;
  const text = message.content.toLowerCase();
  if (text.includes('contexto temporal atual')) return true;
  return TEMPORAL_PATTERN_RE.test(text);
}

function stripTemporalAssistantHistory(messages) {
  if (!Array.isArray(messages) || !messages.length) return { messages, removed: 0 };
  let removed = 0;
  const filtered = messages.filter(m => {
    const drop = shouldDropTemporalAssistantMessage(m);
    if (drop) removed += 1;
    return !drop;
  });
  return { messages: filtered, removed };
}

function pickGreetingText(userMessage) {
  const normalized = String(userMessage || '').trim().toLowerCase();
  if (normalized.includes('boa noite')) return 'Boa noite';
  if (normalized.includes('boa tarde')) return 'Boa tarde';
  if (normalized.includes('bom dia')) return 'Bom dia';

  const hour = Number(getNowInSaoPaulo().timeText.split(':')[0]);
  if (hour >= 18) return 'Boa noite';
  if (hour >= 12) return 'Boa tarde';
  return 'Bom dia';
}

// Abreviacoes em PT-BR que terminam em "." e nao devem ser tratadas como fim de frase.
// Ordem importa: variantes mais longas primeiro (Dra. antes de Dr.) pra evitar match parcial.
const PROTECTED_ABBREV = [
  'Dra.', 'Dras.', 'Drs.', 'Dr.',
  'Sra.', 'Sras.', 'Srs.', 'Sr.',
  'Profa.', 'Profs.', 'Prof.',
  'Av.', 'Sta.', 'Pça.',
  'etc.', 'ex.', 'p.ex.',
  'cm.', 'm.', 'kg.', 'g.'
];

function splitIntoSentences(text) {
  // Substitui abreviacoes por placeholders antes do split pra evitar quebra
  // em pontos que nao sao fim de frase (ex.: "o Dr. Francisco" virava 2 frases).
  let safe = text;
  PROTECTED_ABBREV.forEach((abbr, i) => {
    const placeholder = `__ABBR${i}__`;
    safe = safe.split(abbr).join(placeholder);
  });

  const parts = safe.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);

  // Restaura as abreviacoes em cada sentenca
  return parts.map(p => {
    let restored = p;
    PROTECTED_ABBREV.forEach((abbr, i) => {
      const placeholder = `__ABBR${i}__`;
      restored = restored.split(placeholder).join(abbr);
    });
    return restored;
  });
}

function sanitizeAssistantReply(reply, { userMessage = '', doctorName = '', messages = [], logContext = {} } = {}) {
  if (isGreetingOnlyMessage(userMessage)) {
    // Saudacao neutra de identidade. NAO inclui "Sou o XXX" porque isso pode
    // contradizer a persona definida no system_prompt (ex.: tenants onde o bot
    // e a SECRETARIA do medico, nao o medico em si). A identidade e controlada
    // pelo system_prompt quando o paciente faz uma pergunta substantiva.
    const greeting = pickGreetingText(userMessage);
    return `${greeting}! Como posso te ajudar hoje?`;
  }

  let text = String(reply || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';

  // Evita alegacoes pessoais de experiencia nao verificavel.
  text = text.replace(
    /\b(ja|já)\s+operei\b[^.?!]*(\.|\?|!|$)/gi,
    'Cada caso precisa ser avaliado individualmente em consulta. '
  );

  // CTA-stripping global foi REMOVIDO: o system_prompt + instructions controlam
  // quando incluir link/CTA. Stripping global removia links uteis quando o cliente
  // pedia explicitamente (ex.: "mande link em respostas sobre retinopatia").

  const URL_RE = /https?:\/\/\S+/;
  const sentenceChunks = splitIntoSentences(text);

  if (sentenceChunks.length > MAX_REPLY_SENTENCES) {
    // Preserva sempre sentencas com URL (sao estruturais, nao podem ser cortadas).
    const urlIdx = sentenceChunks
      .map((s, i) => URL_RE.test(s) ? i : -1)
      .filter(i => i >= 0);

    if (urlIdx.length) {
      const kept = new Set(urlIdx);
      // Completa com as primeiras sentencas ate atingir o limite
      for (let i = 0; i < sentenceChunks.length && kept.size < MAX_REPLY_SENTENCES; i++) {
        kept.add(i);
      }
      text = sentenceChunks.filter((_, i) => kept.has(i)).join(' ').trim();
    } else {
      text = sentenceChunks.slice(0, MAX_REPLY_SENTENCES).join(' ').trim();
    }
  }

  // Cap de chars: nao aplica se tem URL (clipping quebraria o link no meio).
  if (text.length > MAX_REPLY_CHARS && !URL_RE.test(text)) {
    const clipped = text.slice(0, MAX_REPLY_CHARS);
    const breakAt = Math.max(clipped.lastIndexOf('. '), clipped.lastIndexOf('? '), clipped.lastIndexOf('! '));
    text = (breakAt > 80 ? clipped.slice(0, breakAt + 1) : clipped).trim();
  }

  return text;
}

export async function fetchInstagramProfile(senderId, doctorId) {
  const token = getPageAccessTokenForDoctor(doctorId);
  if (!senderId || !token || token === 'preencher-depois') return null;

  const cacheKey = String(senderId);
  const cached = profileCache.get(cacheKey);
  const now = Date.now();
  if (cached && (now - cached.ts) < 6 * 60 * 60 * 1000) return cached.value;

  const urls = [
    `https://graph.facebook.com/v18.0/${encodeURIComponent(senderId)}?fields=name,username&access_token=${encodeURIComponent(token)}`,
    `https://graph.instagram.com/v18.0/${encodeURIComponent(senderId)}?fields=name,username&access_token=${encodeURIComponent(token)}`
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
 * Baixa uma imagem (URL do anexo da Meta) e devolve base64 + media_type,
 * pra mandar como bloco de imagem pro Claude (visao). Retorna null se falhar,
 * se o tipo nao for suportado ou se passar do limite de tamanho.
 */
async function fetchImageAsBase64(url) {
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const mediaType = VISION_ALLOWED_TYPES.includes(contentType) ? contentType : 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > VISION_MAX_BYTES) return null;
    return { mediaType, data: buf.toString('base64') };
  } catch (_) {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Faz uma chamada para Claude (igual ao server.js)
 */
async function callClaude(systemPrompt, messages, ctx = {}) {
  // System em blocos: o prompt estatico (grande) e cacheado via cache_control;
  // o contexto temporal (dinamico, muda a cada minuto) fica num bloco separado
  // DEPOIS do breakpoint pra nao invalidar o cache. Caching e no-op se o bloco
  // ficar abaixo do minimo do modelo (1024 tok Sonnet / 4096 Haiku) — sem erro.
  const systemBlocks = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: buildTemporalSystemContext() }
  ];
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
          system: systemBlocks,
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

      claudeLog('info', 'attempt_success', {
        ...reqCtx,
        attempt: attemptNo,
        maxAttempts,
        outputChars: extracted.normalizedText.length,
        outputSource: extracted.source,
        cacheCreate: data?.usage?.cache_creation_input_tokens ?? null,
        cacheRead: data?.usage?.cache_read_input_tokens ?? null
      });
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
  // ctx.primaryOverride: modelo configurado por tenant no banco (sobrescreve env).
  const primary = ctx.primaryOverride || ANTHROPIC_MODEL_PRIMARY;
  const models = [primary];
  if (ANTHROPIC_ENABLE_MODEL_FALLBACK && ANTHROPIC_MODEL_FALLBACK && ANTHROPIC_MODEL_FALLBACK !== primary) {
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
export async function sendInstagramResponse(senderId, text, doctorId) {
  if (!String(text || '').trim()) {
    console.warn('[Instagram][send_skip_empty]', { senderId, doctorId, ...getLogTimeContext() });
    return false;
  }
  const token = getPageAccessTokenForDoctor(doctorId);
  if (!token || token === 'preencher-depois') {
    console.warn('[Instagram][token_missing]', { senderId, doctorId, ...getLogTimeContext() });
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
        access_token: token
      })
    });

    if (!response.ok) {
      const error = await response.json();
      const apiError = error?.error || {};
      const isTokenInvalid = apiError.code === 190 || apiError.type === 'OAuthException';
      const logCtx = {
        doctorId,
        senderId,
        envVar: getPageTokenEnvVarName(doctorId),
        code: apiError.code ?? null,
        subcode: apiError.error_subcode ?? null,
        type: apiError.type ?? null,
        message: apiError.message ?? null,
        fbtrace_id: apiError.fbtrace_id ?? null,
        ...getLogTimeContext()
      };
      if (isTokenInvalid) {
        // Token da página invalidado (troca de senha / sessão expirada pelo Meta).
        // Regerar o token e atualizar a env var indicada em logCtx.envVar.
        console.error('[Instagram][token_invalid]', logCtx);
      } else {
        console.error('[Instagram][send_error]', logCtx);
      }
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

// Numero de mensagens ja existentes na conversa (pra saber se e o primeiro turno).
function conversationMessageCount(doctorId, senderId) {
  const db = getDb();
  try {
    const c = db.prepare('SELECT id FROM conversations WHERE doctor_id=? AND sender_id=? ORDER BY started_at DESC LIMIT 1').get(doctorId, senderId);
    if (!c) return 0;
    return Number(db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?').get(c.id)?.n || 0);
  } finally {
    db.close();
  }
}

// Delay "humano" configurado por tenant (delay_first/delay_min/delay_max, em segundos).
// Primeiro turno usa delay_first; demais, aleatorio entre min e max. Mesma semantica do /api/chat.
function computeSendDelayMs(doctor, isFirst) {
  const dFirst = (doctor?.delay_first ?? 3) * 1000;
  const dMin = (doctor?.delay_min ?? 2) * 1000;
  const dMax = (doctor?.delay_max ?? 3) * 1000;
  if (isFirst) return dFirst;
  const lo = dMin;
  const hi = Math.max(dMax, dMin);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
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
export async function handleInstagramMessage(senderId, messageText, doctorId, mid = null, imageUrls = []) {
  try {
    const hasImages = Array.isArray(imageUrls) && imageUrls.length > 0;
    // Valida entrada (aceita turno so com imagem, sem texto).
    if (!senderId || !doctorId || (!messageText && !hasImages)) {
      console.error('Missing required parameters');
      return null;
    }

    const userMessage = String(messageText || '').trim();
    if (!userMessage && !hasImages) {
      console.error('Empty user message after normalization');
      return null;
    }

    // Representacao textual do turno do usuario pra persistir no historico
    // (a imagem em si nao e guardada; so um marcador).
    const storedUserMessage = userMessage
      ? (hasImages ? `${userMessage} [imagem anexada]` : userMessage)
      : '[Paciente enviou uma imagem]';

    const traceId = `${doctorId}:${senderId}:${Date.now()}`;
    console.log('[Instagram][inbound]', { traceId, doctorId, senderId, mid, userChars: userMessage.length, images: hasImages ? imageUrls.length : 0, ...getLogTimeContext() });

    // Verifica se o bot esta pausado pra esta conversa especifica.
    // Se sim, salva a mensagem do usuario no historico mas NAO responde.
    {
      const dbCheck = getDb();
      const convCheck = dbCheck.prepare('SELECT id, bot_paused FROM conversations WHERE doctor_id=? AND sender_id=? ORDER BY started_at DESC LIMIT 1').get(doctorId, senderId);
      dbCheck.close();
      if (convCheck && convCheck.bot_paused === 1) {
        console.log('[Instagram][bot_paused_skip]', { traceId, doctorId, senderId, conversationId: convCheck.id, ...getLogTimeContext() });
        // Salva a mensagem do usuario pra manter historico atualizado
        const profile = await fetchInstagramProfile(senderId, doctorId);
        trackConversation(doctorId, senderId, 'user', storedUserMessage, profile);
        return null;
      }
    }

    // Baixa as imagens do anexo (se houver) pra mandar como bloco de visao.
    // Se nao conseguir ler nenhuma, pede os valores por escrito e encerra o turno.
    let imageBlocks = [];
    if (hasImages) {
      const fetched = (await Promise.all(imageUrls.slice(0, 4).map(fetchImageAsBase64))).filter(Boolean);
      if (!fetched.length) {
        console.warn('[Instagram][image_fetch_failed]', { traceId, doctorId, senderId, urls: imageUrls.length, ...getLogTimeContext() });
        trackConversation(doctorId, senderId, 'user', storedUserMessage, await fetchInstagramProfile(senderId, doctorId));
        trackConversation(doctorId, senderId, 'assistant', IMAGE_UNREADABLE_REPLY);
        await sendInstagramResponse(senderId, IMAGE_UNREADABLE_REPLY, doctorId);
        return IMAGE_UNREADABLE_REPLY;
      }
      imageBlocks = fetched.map(img => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data }
      }));
      console.log('[Instagram][image_received]', { traceId, doctorId, senderId, images: fetched.length, ...getLogTimeContext() });
    }

    // Busca prompt do médico
    const result = buildPrompt(doctorId);
    if (!result) {
      const errorMsg = 'Desculpe, tive uma dificuldade. Tente novamente mais tarde.';
      trackConversation(doctorId, senderId, 'assistant', errorMsg);
      await sendInstagramResponse(senderId, errorMsg, doctorId);
      return errorMsg;
    }

    // Delay "humano" por tenant, aplicado antes de cada envio ao paciente.
    const isFirstTurn = conversationMessageCount(doctorId, senderId) === 0;
    const sendDelayMs = computeSendDelayMs(result.doctor, isFirstTurn);

    // Saudacao curta so vale pra turno de texto puro (imagem nunca e "so saudacao").
    const isGreetingOnly = !hasImages && isGreetingOnlyMessage(userMessage);
    if (isGreetingOnly) {
      const greetingReply = sanitizeAssistantReply('', {
        userMessage,
        doctorName: result?.doctor?.name || ''
      });
      trackConversation(doctorId, senderId, 'assistant', greetingReply);
      await delay(sendDelayMs);
      await sendInstagramResponse(senderId, greetingReply, doctorId);
      console.log('[Instagram][greeting_short_reply]', { traceId, doctorId, senderId, replyChars: greetingReply.length, ...getLogTimeContext() });
      return greetingReply;
    }

    // Busca histórico de mensagens antes de salvar a atual para evitar duplicidade.
    const db = getDb();
    const conv = db.prepare('SELECT id FROM conversations WHERE doctor_id=? AND sender_id=? ORDER BY started_at DESC LIMIT 1').get(doctorId, senderId);
    
    let messages = [];
    if (conv) {
      const history = db.prepare('SELECT role, content FROM messages WHERE conversation_id=? ORDER BY created_at DESC LIMIT ?').all(conv.id, INSTAGRAM_HISTORY_LIMIT).reverse();
      messages = history
        .map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content || '') }))
        .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content.trim().length > 0);
    }
    db.close();

    // Adiciona a mensagem atual manualmente no payload para o Claude.
    // Com imagem: conteudo multimodal (blocos de imagem + texto com a instrucao de visao).
    if (imageBlocks.length) {
      const visionText = (userMessage ? `${userMessage}\n\n` : '') + VISION_INSTRUCTION;
      messages.push({ role: 'user', content: [...imageBlocks, { type: 'text', text: visionText }] });
    } else {
      messages.push({ role: 'user', content: userMessage });
    }

    const scrubbed = stripTemporalAssistantHistory(messages);
    if (scrubbed.removed > 0) {
      console.log('[Instagram][temporal_history_removed]', { traceId, doctorId, senderId, removed: scrubbed.removed, ...getLogTimeContext() });
    }
    messages = scrubbed.messages;

    // Persiste a mensagem atual do usuário depois da montagem do payload.
    const profile = await fetchInstagramProfile(senderId, doctorId);
    trackConversation(doctorId, senderId, 'user', storedUserMessage, profile);

    claudeLog('info', 'payload_debug', {
      channel: 'instagram',
      doctorId,
      senderId,
      traceId,
      messagesCount: messages.length,
      lastTwoRoles: messages.slice(-2).map(m => m.role),
      hasConsecutiveUser: messages.some((m, i) => i > 0 && m.role === 'user' && messages[i - 1]?.role === 'user'),
      messagesPreview: messages.map((m, i) => {
        const c = typeof m.content === 'string' ? m.content : '[conteudo multimodal: imagem]';
        return { index: i, role: m.role, chars: c.length, preview: c.slice(0, 60) };
      })
    });

    // Lembrete de data/hora atual para evitar respostas com data antiga.
    messages.push(buildTemporalReminderMessage());

    // Delay "humano" configurado por tenant antes de gerar/enviar a resposta.
    await delay(sendDelayMs);

    // Chama Claude
    const rawReply = await callClaudeReliable(result.prompt, messages, { channel: 'instagram', doctorId, senderId, traceId, phase: 'primary', primaryOverride: result.doctor?.model || null });
    const reply = sanitizeAssistantReply(rawReply, {
      userMessage,
      doctorName: result?.doctor?.name || '',
      messages,
      logContext: { channel: 'instagram', doctorId, senderId, traceId }
    });
    
    if (!reply) {
      console.warn('[Instagram][fallback_phase_1]', { traceId, doctorId, senderId, reason: 'all_reliable_attempts_failed', ...getLogTimeContext() });
      const essentialPrompt = buildEssentialSystemPrompt(doctorId);
      if (essentialPrompt) {
        console.warn('[Instagram][processed_recovery_start]', { traceId, doctorId, senderId, ...getLogTimeContext() });
        const recoveredRaw = await callClaudeReliable(essentialPrompt, [{ role: 'user', content: String(messageText || '') }], {
          channel: 'instagram',
          doctorId,
          senderId,
          traceId,
          phase: 'processed_recovery',
          primaryOverride: result.doctor?.model || null
        });
        const recovered = sanitizeAssistantReply(recoveredRaw, {
          userMessage,
          doctorName: result?.doctor?.name || '',
          messages,
          logContext: { channel: 'instagram', doctorId, senderId, traceId }
        });

        if (recovered) {
          trackConversation(doctorId, senderId, 'assistant', recovered);
          await sendInstagramResponse(senderId, recovered, doctorId);
          console.log('[Instagram][processed_recovery_success]', { traceId, doctorId, senderId, replyChars: recovered.length, ...getLogTimeContext() });
          return recovered;
        }
      }

      const finalFallback = 'Obrigada pela paciencia. Pode repetir sua pergunta, por favor?';
      trackConversation(doctorId, senderId, 'assistant', finalFallback);
      await sendInstagramResponse(senderId, finalFallback, doctorId);
      return finalFallback;
    }

    // Salva resposta
    trackConversation(doctorId, senderId, 'assistant', reply);

    // Envia pro Instagram
    await sendInstagramResponse(senderId, reply, doctorId);

    console.log('[Instagram][outbound_success]', { traceId, doctorId, senderId, replyChars: reply.length, ...getLogTimeContext() });
    return reply;
  } catch (error) {
    console.error('Error handling Instagram message:', error);
    const errorMsg = 'Desculpe, ocorreu um erro. Tente novamente.';
    await sendInstagramResponse(senderId, errorMsg, doctorId);
    return null;
  }
}

/**
 * Trata um evento de anuncio (Click-to-Instagram-DM): chega so com `referral`/`ad`,
 * sem texto. Sauda o lead com a saudacao padrao do tenant — mas SO se for um lead
 * novo (conversa ainda sem mensagens), pra nao saudar duas vezes quando o texto vier
 * logo em seguida nem reabrir saudacao no meio de um atendimento ja em andamento.
 */
export async function handleInstagramReferral(senderId, doctorId, referral = null, mid = null) {
  try {
    if (!senderId || !doctorId) return null;
    const traceId = `${doctorId}:${senderId}:ref:${Date.now()}`;

    const db = getDb();
    const conv = db.prepare('SELECT id, bot_paused FROM conversations WHERE doctor_id=? AND sender_id=? ORDER BY started_at DESC LIMIT 1').get(doctorId, senderId);
    let hasMessages = false;
    if (conv) {
      const row = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id=?').get(conv.id);
      hasMessages = Number(row?.n || 0) > 0;
    }
    db.close();

    if (conv && conv.bot_paused === 1) {
      console.log('[Instagram][referral_skip_paused]', { traceId, doctorId, senderId, mid, ...getLogTimeContext() });
      return null;
    }
    if (hasMessages) {
      console.log('[Instagram][referral_skip_existing]', { traceId, doctorId, senderId, mid, ...getLogTimeContext() });
      return null;
    }

    // Saudacao neutra baseada no horario (mesmo texto que o sanitizer usa pra saudacoes).
    const greetingReply = `${pickGreetingText('')}! Como posso te ajudar hoje?`;

    const profile = await fetchInstagramProfile(senderId, doctorId);
    trackConversation(doctorId, senderId, 'assistant', greetingReply, profile);
    await sendInstagramResponse(senderId, greetingReply, doctorId);
    console.log('[Instagram][referral_welcome]', {
      traceId,
      doctorId,
      senderId,
      mid,
      source: referral?.source || referral?.type || referral?.ref || null,
      adId: referral?.ad_id || null,
      replyChars: greetingReply.length,
      ...getLogTimeContext()
    });
    return greetingReply;
  } catch (error) {
    console.error('Error handling Instagram referral:', error);
    return null;
  }
}

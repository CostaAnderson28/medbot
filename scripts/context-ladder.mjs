import 'dotenv/config.js';
import { buildPrompt } from '../src/prompt-builder.js';
import { getDb } from '../src/db/setup.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL_PRIMARY || 'claude-sonnet-4-20250514';
const DEFAULT_TIMEOUT_MS = Number(process.env.ANTHROPIC_TIMEOUT_MS || 15000);

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i++;
  }
  return out;
}

function toNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function buildTemporalSystemContext() {
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
  return `## CONTEXTO TEMPORAL ATUAL\n- Data atual (America/Sao_Paulo): ${dateText}\n- Hora atual (America/Sao_Paulo): ${timeText}`;
}

function pickContentText(data) {
  const content = Array.isArray(data?.content) ? data.content : [];
  const fromBlocks = content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
    .trim();
  const fromOutputText = typeof data?.output_text === 'string' ? data.output_text.trim() : '';
  const fromCompletion = typeof data?.completion === 'string' ? data.completion.trim() : '';
  return fromBlocks || fromOutputText || fromCompletion || '';
}

function buildLadder(maxCount) {
  const base = [1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32];
  return base.filter(n => n <= maxCount);
}

function getConversationData(doctorId, senderId) {
  const db = getDb();
  try {
    let sender = senderId;
    if (!sender) {
      const latest = db.prepare('SELECT sender_id FROM conversations WHERE doctor_id=? ORDER BY last_message_at DESC LIMIT 1').get(doctorId);
      sender = latest?.sender_id || null;
    }

    if (!sender) return { senderId: null, messages: [] };

    const conv = db
      .prepare('SELECT id FROM conversations WHERE doctor_id=? AND sender_id=? ORDER BY last_message_at DESC LIMIT 1')
      .get(doctorId, sender);
    if (!conv) return { senderId: sender, messages: [] };

    const messages = db
      .prepare('SELECT role, content, created_at FROM messages WHERE conversation_id=? ORDER BY created_at ASC')
      .all(conv.id)
      .map(m => ({ role: m.role, content: String(m.content || '') }));

    return { senderId: sender, messages };
  } finally {
    db.close();
  }
}

async function callAnthropic({ model, systemPrompt, messages, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
        system: systemPrompt,
        messages
      }),
      signal: controller.signal
    });

    const raw = await res.text();
    let data = {};
    try {
      data = JSON.parse(raw);
    } catch (_) {
      return {
        ok: false,
        status: res.status,
        kind: 'parse_error',
        text: '',
        stopReason: null,
        outputTokens: null,
        contentBlocks: -1,
        contentTypes: 'parse_error'
      };
    }

    const text = pickContentText(data);
    const content = Array.isArray(data?.content) ? data.content : [];
    const contentTypes = content.map(c => c?.type || 'unknown').join(',');
    const usage = data?.usage || {};

    if (!res.ok || data?.error) {
      return {
        ok: false,
        status: res.status,
        kind: 'api_error',
        text,
        stopReason: data?.stop_reason || null,
        outputTokens: usage?.output_tokens ?? null,
        contentBlocks: content.length,
        contentTypes: contentTypes || 'none'
      };
    }

    return {
      ok: true,
      status: res.status,
      kind: text ? 'success' : 'empty_response',
      text,
      stopReason: data?.stop_reason || null,
      outputTokens: usage?.output_tokens ?? null,
      contentBlocks: content.length,
      contentTypes: contentTypes || 'none'
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      kind: err?.name === 'AbortError' ? 'timeout' : 'network_error',
      text: '',
      stopReason: null,
      outputTokens: null,
      contentBlocks: -1,
      contentTypes: err?.name === 'AbortError' ? 'timeout' : 'network_error'
    };
  } finally {
    clearTimeout(timer);
  }
}

function printHeader(opts, senderId, totalMsgs) {
  console.log('--- Context Ladder ---');
  console.log(`doctorId: ${opts.doctorId}`);
  console.log(`senderId: ${senderId || 'N/A'}`);
  console.log(`model: ${opts.model}`);
  console.log(`runs por degrau: ${opts.runs}`);
  console.log(`timeoutMs: ${opts.timeoutMs}`);
  console.log(`mensagens disponiveis: ${totalMsgs}`);
  console.log('');
  console.log('msgs | run | result         | stop_reason | out_tok | blocks | block_types');
  console.log('-----+-----+----------------+------------+---------+--------+----------------------');
}

async function main() {
  const args = parseArgs(process.argv);
  const opts = {
    doctorId: String(args.doctor || 'dr-antonio'),
    senderId: args.sender ? String(args.sender) : null,
    model: String(args.model || DEFAULT_MODEL),
    runs: Math.max(1, toNumber(args.runs, 3)),
    timeoutMs: Math.max(3000, toNumber(args.timeout, DEFAULT_TIMEOUT_MS)),
    max: Math.max(1, toNumber(args.max, 20))
  };

  if (!ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY ausente no ambiente.');
    process.exit(1);
  }

  const promptData = buildPrompt(opts.doctorId);
  if (!promptData) {
    console.error(`Doutor nao encontrado: ${opts.doctorId}`);
    process.exit(1);
  }

  const { senderId, messages } = getConversationData(opts.doctorId, opts.senderId);
  if (!messages.length) {
    console.error('Nao encontrei mensagens para montar a escada. Use --sender <id> se necessario.');
    process.exit(1);
  }

  const maxUsable = Math.min(opts.max, messages.length);
  const ladder = buildLadder(maxUsable);
  if (!ladder.length) {
    console.error('Escada vazia com os parametros atuais.');
    process.exit(1);
  }

  const systemPrompt = `${promptData.prompt}\n\n${buildTemporalSystemContext()}`;
  printHeader(opts, senderId, messages.length);

  const summary = new Map();

  for (const msgCount of ladder) {
    const subset = messages.slice(-msgCount);
    let success = 0;

    for (let run = 1; run <= opts.runs; run++) {
      const r = await callAnthropic({
        model: opts.model,
        systemPrompt,
        messages: subset,
        timeoutMs: opts.timeoutMs
      });

      if (r.kind === 'success') success++;
      const stop = (r.stopReason || '-').padEnd(10, ' ');
      const outTok = String(r.outputTokens ?? '-').padStart(7, ' ');
      const blocks = String(r.contentBlocks).padStart(6, ' ');
      const kind = r.kind.padEnd(14, ' ');
      console.log(`${String(msgCount).padStart(4, ' ')} | ${String(run).padStart(3, ' ')} | ${kind} | ${stop} | ${outTok} | ${blocks} | ${r.contentTypes}`);
    }

    summary.set(msgCount, { success, total: opts.runs });
  }

  console.log('\nResumo (taxa de sucesso por degrau):');
  for (const [count, s] of summary.entries()) {
    const rate = Math.round((s.success / s.total) * 100);
    console.log(`- ${count} msgs: ${s.success}/${s.total} (${rate}%)`);
  }
}

main().catch(err => {
  console.error('Falha ao executar escada de contexto:', err);
  process.exit(1);
});

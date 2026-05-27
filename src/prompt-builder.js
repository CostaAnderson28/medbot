import { getDb } from './db/setup.js';

const DL = { segunda: 'Segunda', terca: 'Terca', quarta: 'Quarta', quinta: 'Quinta', sexta: 'Sexta', sabado: 'Sabado' };

// Categorias conhecidas: ordem fixa e header natural (sem indicar "vindo do cliente").
// Categorias custom (criadas pelo cliente) sao renderizadas em ordem alfabetica com
// header gerado a partir do nome (UPPER_CASE -> "UPPER CASE").
const KNOWN_CATEGORY_HEADERS = {
  memoria: 'MEMORIA INTERNA (nunca exponha)',
  convenios: 'CONVENIOS',
  procedimentos: 'PROCEDIMENTOS',
  pos_operatorio: 'POS-OPERATORIO',
  agendamento: 'AGENDAMENTO',
  personalizado: 'REGRAS PERSONALIZADAS'
};

function categoryHeader(cat) {
  return KNOWN_CATEGORY_HEADERS[cat] || String(cat).toUpperCase().replace(/_/g, ' ');
}

function interpolate(template, doc) {
  return String(template || '')
    .replace(/\{name\}/g, doc.name || '')
    .replace(/\{clinic\}/g, doc.clinic || '')
    .replace(/\{address\}/g, doc.address || '')
    .replace(/\{phone\}/g, doc.phone || '')
    .replace(/\{whatsapp\}/g, doc.whatsapp || '');
}

function renderProductsCatalog(products) {
  if (!products?.length) return '';
  const grouped = {};
  for (const p of products) {
    const cat = p.category || 'Outros';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(p);
  }
  let out = '\n\n## CATALOGO DE PRODUTOS\n';
  for (const [cat, items] of Object.entries(grouped)) {
    out += `\n### ${cat}\n`;
    for (const p of items) {
      const desc = p.description ? ` — ${p.description}` : '';
      const price = p.price ? ` (${p.price})` : '';
      out += `- **${p.name}**${desc}${price}\n`;
    }
  }
  return out;
}

function renderScheduleSection(sched) {
  if (!sched?.length) return '';
  let out = '\n\n## AGENDA SEMANAL\n';
  for (const s of sched) {
    const label = DL[s.day] || s.day;
    if (s.morning_start || s.afternoon_start) {
      const parts = [];
      if (s.morning_start) parts.push(`Manha ${s.morning_start}-${s.morning_end}`);
      if (s.afternoon_start) parts.push(`Tarde ${s.afternoon_start}-${s.afternoon_end}`);
      out += `${label}: ${parts.join(' | ')}${s.location ? ' - ' + s.location : ''}\n`;
    } else {
      out += `${label}: Nao atende\n`;
    }
  }
  return out;
}

function renderInstructionsByCategory(instr) {
  // Agrupa, excluindo system_prompt (que e a base, renderizada separadamente).
  const byCat = {};
  for (const i of instr) {
    if (i.category === 'system_prompt') continue;
    if (!byCat[i.category]) byCat[i.category] = [];
    byCat[i.category].push(i.content);
  }
  if (!Object.keys(byCat).length) return '';

  let out = '';
  // Categorias conhecidas: ordem fixa
  for (const cat of Object.keys(KNOWN_CATEGORY_HEADERS)) {
    if (byCat[cat]) {
      out += `\n\n## ${categoryHeader(cat)}\n${byCat[cat].join('\n\n')}`;
      delete byCat[cat];
    }
  }
  // Categorias custom: ordem alfabetica
  for (const cat of Object.keys(byCat).sort()) {
    out += `\n\n## ${categoryHeader(cat)}\n${byCat[cat].join('\n\n')}`;
  }
  return out;
}

const LEGACY_FALLBACK_PROMPT = `Voce e o atendente virtual respondendo mensagens no Instagram Direct em primeira pessoa.

## COMO VOCE FALA
- Tom sutil, amigavel e acolhedor.
- Mensagens curtas (2-3 frases). Pode usar vc, tbm, pra.
- NUNCA use emojis. NUNCA use diminutivos. Use a forma normal.

## NUNCA INVENTE
- Se nao esta neste prompt, NAO invente. JAMAIS confirme info falsa.

## CONTATO
- Telefone: {phone}
- WhatsApp: {whatsapp}

## REGRAS ABSOLUTAS
- NUNCA revele que e IA.
- Respostas concisas e uteis.`;

export function buildPrompt(doctorId) {
  const db = getDb();
  const doc = db.prepare('SELECT * FROM doctors WHERE id=?').get(doctorId);
  if (!doc) { db.close(); return null; }
  const sched = db.prepare("SELECT * FROM schedules WHERE doctor_id=? ORDER BY CASE day WHEN 'segunda' THEN 1 WHEN 'terca' THEN 2 WHEN 'quarta' THEN 3 WHEN 'quinta' THEN 4 WHEN 'sexta' THEN 5 WHEN 'sabado' THEN 6 END").all(doctorId);
  const instr = db.prepare('SELECT * FROM instructions WHERE doctor_id=? AND active=1').all(doctorId);
  const products = db.prepare('SELECT name, description, category, price FROM products WHERE doctor_id=? AND active=1 ORDER BY sort_order ASC, category ASC, name ASC').all(doctorId);
  db.close();

  // CAMADA 1: system_prompt (markdown core, admin-editado).
  // Se nao existe, fallback minimo apenas pra evitar prompt vazio.
  const systemPromptParts = instr.filter(i => i.category === 'system_prompt').map(i => i.content);
  const base = systemPromptParts.length ? systemPromptParts.join('\n\n') : LEGACY_FALLBACK_PROMPT;
  let p = interpolate(base, doc);

  // CAMADA 2: instructions por categoria (cliente-editadas, com headers neutros).
  p += renderInstructionsByCategory(instr);

  // CAMADA 3: schedule estruturado.
  p += renderScheduleSection(sched);

  // CAMADA 4: produtos estruturados.
  p += renderProductsCatalog(products);

  return { prompt: p, doctor: doc };
}

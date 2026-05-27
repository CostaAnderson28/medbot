#!/usr/bin/env node
// Diagnostica o sistema de instructions de um tenant.
// - Lista todas as instructions com categoria, tamanho, ativa/inativa
// - Identifica instructions em categorias DESCONHECIDAS pelo prompt-builder
//   (eram orfas no modelo antigo, agora sao renderizadas com header natural)
// - Imprime o prompt final renderizado pelo buildPrompt
//
// Uso: node scripts/diagnose-instructions.mjs <doctor_id> [--search <termo>]
// Ex:  node scripts/diagnose-instructions.mjs dr-antonio
//      node scripts/diagnose-instructions.mjs dr-antonio --search retinopatia

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildPrompt } from '../src/prompt-builder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data.db');

const KNOWN_CATEGORIES = new Set([
  'system_prompt', 'memoria', 'convenios', 'procedimentos',
  'pos_operatorio', 'agendamento', 'personalizado'
]);

const args = process.argv.slice(2);
const doctorId = args[0];
const searchIdx = args.indexOf('--search');
const searchTerm = searchIdx >= 0 ? args[searchIdx + 1] : null;

if (!doctorId) {
  console.error('Uso: node scripts/diagnose-instructions.mjs <doctor_id> [--search <termo>]');
  process.exit(1);
}

const db = new Database(DB_PATH);

const doc = db.prepare('SELECT id, name, prompt_kind, bot_active FROM doctors WHERE id=?').get(doctorId);
if (!doc) {
  console.error(`Tenant '${doctorId}' nao encontrado. IDs disponiveis:`);
  console.error(db.prepare('SELECT id FROM doctors').all().map(r => '  - ' + r.id).join('\n'));
  process.exit(1);
}

console.log('==================== TENANT ====================');
console.log(doc);

const rows = db.prepare('SELECT id, category, content, active FROM instructions WHERE doctor_id=? ORDER BY id').all(doctorId);

console.log(`\n==================== INSTRUCTIONS (${rows.length}) ====================`);
for (const r of rows) {
  const knownTag = KNOWN_CATEGORIES.has(r.category) ? '' : ' ⚠ DESCONHECIDA';
  const activeTag = r.active ? '' : ' [INATIVA]';
  console.log(`#${r.id} [${r.category}]${knownTag}${activeTag} (${r.content.length} chars)`);
  const preview = r.content.length > 200 ? r.content.slice(0, 200) + '...' : r.content;
  console.log('   ' + preview.split('\n').join('\n   '));
  console.log('');
}

if (searchTerm) {
  console.log(`\n==================== BUSCA: "${searchTerm}" ====================`);
  const term = searchTerm.toLowerCase();
  const hits = rows.filter(r => r.content.toLowerCase().includes(term));
  if (!hits.length) {
    console.log('Nenhuma instruction com esse termo. PROVAVEL PROBLEMA: instrucao nao foi salva.');
  } else {
    for (const h of hits) {
      console.log(`✓ Achei em #${h.id} [${h.category}]${h.active ? '' : ' [INATIVA]'}`);
      console.log('  ', h.content);
      if (!KNOWN_CATEGORIES.has(h.category)) {
        console.log('  ⚠ CATEGORIA DESCONHECIDA no modelo antigo. Agora ela e renderizada com header "## ' + h.category.toUpperCase().replace(/_/g, ' ') + '" (apos a refatoracao).');
      }
      if (!h.active) {
        console.log('  ⚠ INATIVA — esta no banco mas NAO entra no prompt.');
      }
    }
  }
}

console.log('\n==================== PROMPT FINAL (render atual) ====================');
const result = buildPrompt(doctorId);
console.log(`Total: ${result.prompt.length} chars\n`);
console.log(result.prompt);

db.close();

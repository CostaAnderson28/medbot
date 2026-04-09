import 'dotenv/config.js';
import Database from 'better-sqlite3';

const db = new Database('./data.db');

// Busca a conversa do cliente_teste
const conv = db.prepare(`
  SELECT * FROM conversations 
  WHERE doctor_id='dr-antonio' AND sender_id='cliente_teste' 
  ORDER BY started_at DESC LIMIT 1
`).get();

if (!conv) {
  console.log('❌ Nenhuma conversa encontrada');
  db.close();
  process.exit(0);
}

console.log('📝 Conversa ID:', conv.id);
console.log('👤 Cliente:', conv.sender_id);
console.log('📊 Total de mensagens:', conv.message_count);
console.log('---\n');

// Busca todas as mensagens da conversa
const messages = db.prepare(`
  SELECT role, content, created_at FROM messages 
  WHERE conversation_id=?
  ORDER BY created_at ASC
`).all(conv.id);

messages.forEach((msg, idx) => {
  console.log(`[${idx + 1}] ${msg.role.toUpperCase()}:`);
  console.log(`    ${msg.content}`);
  console.log('');
});

db.close();

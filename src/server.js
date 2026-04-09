import 'dotenv/config.js';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { setupDatabase, getDb } from './db/setup.js';
import { buildPrompt } from './prompt-builder.js';
import { parseInstagramMessage, handleInstagramMessage } from './instagram-handler.js';
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

app.use('/api/auth', authRoutes);
app.use('/api/schedule', scheduleRoutes);
app.use('/api/instructions', instructionsRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/settings', settingsRoutes);

const conversationHistory = new Map();

async function callClaude(systemPrompt, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 500, system: systemPrompt, messages })
  });
  const data = await res.json();
  if (data.error) { console.error('Claude error:', data.error); return null; }
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
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

  const reply = await callClaude(result.prompt, messages);
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
  try {
    if (req.body.object !== 'instagram') return;
    
    for (const entry of req.body.entry || []) {
      const pageId = entry.id;
      const doctorId = findDoctorByPageId(pageId);
      
      if (!doctorId) {
        console.warn('Nenhum doutor para pageId:', pageId);
        continue;
      }

      for (const event of entry.messaging || []) {
        // Ignora echo messages
        if (event.message?.is_echo) continue;

        const senderId = event.sender?.id;
        const messageText = event.message?.text;

        if (!senderId || !messageText) {
          console.warn('Mensagem inválida ou sem texto');
          continue;
        }

        // Processa com Claude e envia resposta
        await handleInstagramMessage(senderId, messageText, doctorId);
      }
    }
  } catch (err) {
    console.error('Webhook error:', err);
  }
});
// Rota para buscar conversas reais do banco
app.get('/api/conversations', authMiddleware, (req, res) => {
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

    // Para cada conversa, busca as mensagens
    const result = conversations.map(conv => {
      const messages = db.prepare(`
        SELECT role, content FROM messages 
        WHERE conversation_id=? 
        ORDER BY created_at ASC
      `).all(conv.id);

      // Formata para o frontend
      const msgs = messages.map(m => ({
        r: m.role === 'user' ? 'u' : 'b',
        c: m.content,
        t: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
      }));

      // Detecta status
      let status = 'sem';
      if (conv.link_sent) status = 'link';
      if (conv.whatsapp_redirect) status = 'wpp';
      if (conv.urgency) status = 'urgencia';

      return {
        id: conv.id,
        name: conv.lead_name || 'Cliente',
        sender_id: conv.sender_id,
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
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));
app.get('*', (req, res) => { if (!req.path.startsWith('/api')) res.sendFile(join(__dirname, '..', 'public', 'index.html')); });
app.listen(PORT, () => console.log('Servidor rodando em http://localhost:' + PORT));

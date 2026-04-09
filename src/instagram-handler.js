import 'dotenv/config.js';
import { buildPrompt } from './prompt-builder.js';
import { getDb } from './db/setup.js';

const PAGE_ACCESS_TOKEN = process.env.PAGE_ACCESS_TOKEN || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

/**
 * Faz uma chamada para Claude (igual ao server.js)
 */
async function callClaude(systemPrompt, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: systemPrompt,
      messages
    })
  });
  const data = await res.json();
  if (data.error) {
    console.error('Claude error:', data.error);
    return null;
  }
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

/**
 * Rastreia conversa no banco de dados (igual ao server.js)
 */
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

    // Salva mensagem do usuário
    trackConversation(doctorId, senderId, 'user', messageText);

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
    const reply = await callClaude(result.prompt, messages);
    
    if (!reply) {
      const errorMsg = 'Tive uma dificuldade. Liga: ' + (result.doctor.phone || '(21) 2703-6100');
      trackConversation(doctorId, senderId, 'assistant', errorMsg);
      await sendInstagramResponse(senderId, errorMsg);
      return errorMsg;
    }

    // Salva resposta
    trackConversation(doctorId, senderId, 'assistant', reply);

    // Envia pro Instagram
    await sendInstagramResponse(senderId, reply);

    console.log(`[Instagram] ${doctorId} respondeu a ${senderId}`);
    return reply;
  } catch (error) {
    console.error('Error handling Instagram message:', error);
    const errorMsg = 'Desculpe, ocorreu um erro. Tente novamente.';
    await sendInstagramResponse(senderId, errorMsg);
    return null;
  }
}

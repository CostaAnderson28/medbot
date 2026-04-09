import { Router } from 'express';
import { getDb } from '../db/setup.js';
import { authMiddleware } from '../middleware/auth.js';
const router = Router();
router.use(authMiddleware);

router.get('/summary', (req, res) => {
  const db = getDb();
  const id = req.doctor?.id;
  if (!id) { db.close(); return res.status(401).json({ error: 'Não autenticado' }); }
  const q = (sql) => db.prepare(sql).get(id)?.count || 0;
  const r = {
    total: q('SELECT COUNT(*) as count FROM conversations WHERE doctor_id=?'),
    today: q("SELECT COUNT(*) as count FROM conversations WHERE doctor_id=? AND started_at>=date('now')"),
    week: q("SELECT COUNT(*) as count FROM conversations WHERE doctor_id=? AND started_at>=date('now','-7 days')"),
    month: q("SELECT COUNT(*) as count FROM conversations WHERE doctor_id=? AND started_at>=date('now','-30 days')"),
    links: q('SELECT SUM(link_sent) as count FROM conversations WHERE doctor_id=?'),
    wpp: q('SELECT SUM(whatsapp_redirect) as count FROM conversations WHERE doctor_id=?'),
    urg: q('SELECT SUM(urgency) as count FROM conversations WHERE doctor_id=?'),
    msgs: q('SELECT COUNT(*) as count FROM messages m JOIN conversations c ON m.conversation_id=c.id WHERE c.doctor_id=?'),
    engajadas: q("SELECT COUNT(DISTINCT c.id) as count FROM conversations c WHERE c.doctor_id=? AND (SELECT COUNT(*) FROM messages WHERE conversation_id=c.id AND role='user') > 1"),
  };
  db.close();
  res.json(r);
});

router.get('/daily', (req, res) => {
  const db = getDb();
  const id = req.doctor?.id;
  if (!id) { db.close(); return res.status(401).json({ error: 'Não autenticado' }); }
  const r = db.prepare("SELECT date(started_at) as day,COUNT(*) as convs,SUM(link_sent) as links FROM conversations WHERE doctor_id=? AND started_at>=date('now','-60 days') GROUP BY date(started_at) ORDER BY day").all(id);
  db.close();
  res.json(r);
});

router.get('/recent', (req, res) => {
  const db = getDb();
  const id = req.doctor?.id;
  if (!id) { db.close(); return res.status(401).json({ error: 'Não autenticado' }); }
  const data = db.prepare("SELECT c.id,c.sender_id,c.started_at,c.message_count,c.link_sent,c.lead_name,c.lead_convenio,(SELECT content FROM messages WHERE conversation_id=c.id AND role='user' ORDER BY created_at LIMIT 1) as first_message FROM conversations c WHERE c.doctor_id=? ORDER BY c.started_at DESC LIMIT 20").all(id);
  const r = data.map(c => ({
    ...c,
    lead_name: c.lead_name || 'Cliente'
  }));
  db.close();
  res.json(r);
});

export default router;

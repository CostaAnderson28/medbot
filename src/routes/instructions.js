import { Router } from 'express';
import { getDb } from '../db/setup.js';
import { authMiddleware } from '../middleware/auth.js';
const router = Router();
router.use(authMiddleware);

// system_prompt e a base editada apenas pelo admin (via /api/admin/tenants/:id/system-prompt).
// Cliente nunca ve nem mexe aqui.
const PROTECTED_CATEGORIES = new Set(['system_prompt']);

router.get('/', (req, res) => {
  const doctorId = req.doctor?.id || req.doctorId;
  if (!doctorId) return res.status(401).json({ error: 'Nao autenticado' });
  const db = getDb();
  const r = db.prepare("SELECT * FROM instructions WHERE doctor_id=? AND category != 'system_prompt'").all(doctorId);
  db.close();
  res.json(r);
});

router.post('/', (req, res) => {
  const { category, content } = req.body;
  if (!category || !content) return res.status(400).json({ error: 'Categoria e conteudo obrigatorios' });
  if (PROTECTED_CATEGORIES.has(String(category))) return res.status(403).json({ error: 'Categoria reservada ao admin' });
  const doctorId = req.doctor?.id || req.doctorId;
  if (!doctorId) return res.status(401).json({ error: 'Nao autenticado' });
  const db = getDb();
  const r = db.prepare('INSERT INTO instructions (doctor_id,category,content) VALUES(?,?,?)').run(doctorId, category, content);
  db.close();
  res.json({ id: r.lastInsertRowid, category, content, active: 1 });
});

router.put('/:id', (req, res) => {
  const { content, active } = req.body;
  const doctorId = req.doctor?.id || req.doctorId;
  if (!doctorId) return res.status(401).json({ error: 'Nao autenticado' });
  const db = getDb();
  // Garante que o cliente nao edite system_prompt mesmo passando o ID dele
  const existing = db.prepare('SELECT category FROM instructions WHERE id=? AND doctor_id=?').get(req.params.id, doctorId);
  if (!existing) { db.close(); return res.status(404).json({ error: 'Instrucao nao encontrada' }); }
  if (PROTECTED_CATEGORIES.has(existing.category)) { db.close(); return res.status(403).json({ error: 'Categoria reservada ao admin' }); }
  if (content !== undefined) db.prepare('UPDATE instructions SET content=? WHERE id=? AND doctor_id=?').run(content, req.params.id, doctorId);
  if (active !== undefined) db.prepare('UPDATE instructions SET active=? WHERE id=? AND doctor_id=?').run(active ? 1 : 0, req.params.id, doctorId);
  db.close();
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const doctorId = req.doctor?.id || req.doctorId;
  if (!doctorId) return res.status(401).json({ error: 'Nao autenticado' });
  const db = getDb();
  const existing = db.prepare('SELECT category FROM instructions WHERE id=? AND doctor_id=?').get(req.params.id, doctorId);
  if (!existing) { db.close(); return res.status(404).json({ error: 'Instrucao nao encontrada' }); }
  if (PROTECTED_CATEGORIES.has(existing.category)) { db.close(); return res.status(403).json({ error: 'Categoria reservada ao admin' }); }
  db.prepare('DELETE FROM instructions WHERE id=? AND doctor_id=?').run(req.params.id, doctorId);
  db.close();
  res.json({ ok: true });
});

export default router;

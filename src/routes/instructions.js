import { Router } from 'express';
import { getDb } from '../db/setup.js';
import { authMiddleware } from '../middleware/auth.js';
const router = Router();
router.use(authMiddleware);

router.get('/', (req, res) => {
  const doctorId = req.doctor?.id || req.doctorId;
  if (!doctorId) return res.status(401).json({ error: 'Nao autenticado' });
  const db = getDb();
  const r = db.prepare('SELECT * FROM instructions WHERE doctor_id=?').all(doctorId);
  db.close();
  res.json(r);
});

router.post('/', (req, res) => {
  const { category, content } = req.body;
  if (!category || !content) return res.status(400).json({ error: 'Categoria e conteudo obrigatorios' });
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
  if (content !== undefined) db.prepare('UPDATE instructions SET content=? WHERE id=? AND doctor_id=?').run(content, req.params.id, doctorId);
  if (active !== undefined) db.prepare('UPDATE instructions SET active=? WHERE id=? AND doctor_id=?').run(active ? 1 : 0, req.params.id, doctorId);
  db.close();
  res.json({ ok: true });
});

router.delete('/:id', (req, res) => {
  const doctorId = req.doctor?.id || req.doctorId;
  if (!doctorId) return res.status(401).json({ error: 'Nao autenticado' });
  const db = getDb();
  db.prepare('DELETE FROM instructions WHERE id=? AND doctor_id=?').run(req.params.id, doctorId);
  db.close();
  res.json({ ok: true });
});

export default router;

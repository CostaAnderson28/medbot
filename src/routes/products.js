import { Router } from 'express';
import { getDb } from '../db/setup.js';
import { authMiddleware } from '../middleware/auth.js';

const router = Router();
router.use(authMiddleware);

function resolveDoctorId(req) {
  // Admin pode passar ?doctor_id=... pra operar em qualquer tenant
  if (req.doctor?.is_admin && req.query.doctor_id) return String(req.query.doctor_id);
  if (req.doctor?.is_admin && req.body?.doctor_id) return String(req.body.doctor_id);
  return req.doctor?.id || null;
}

router.get('/', (req, res) => {
  const doctorId = resolveDoctorId(req);
  if (!doctorId) return res.status(401).json({ error: 'Nao autenticado' });
  const db = getDb();
  const rows = db.prepare(
    'SELECT id,name,description,category,price,sort_order,active,created_at FROM products WHERE doctor_id=? ORDER BY sort_order ASC, category ASC, name ASC'
  ).all(doctorId);
  db.close();
  res.json(rows);
});

router.post('/', (req, res) => {
  const doctorId = resolveDoctorId(req);
  if (!doctorId) return res.status(401).json({ error: 'Nao autenticado' });
  const { name, description, category, price, sort_order } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Nome obrigatorio' });
  const db = getDb();
  const r = db.prepare(
    'INSERT INTO products (doctor_id,name,description,category,price,sort_order,active) VALUES (?,?,?,?,?,?,1)'
  ).run(doctorId, String(name).trim(), description || null, category || null, price || null, Number(sort_order) || 0);
  const row = db.prepare('SELECT * FROM products WHERE id=?').get(r.lastInsertRowid);
  db.close();
  res.json(row);
});

router.put('/:id', (req, res) => {
  const doctorId = resolveDoctorId(req);
  if (!doctorId) return res.status(401).json({ error: 'Nao autenticado' });
  const id = Number(req.params.id);
  const { name, description, category, price, sort_order, active } = req.body || {};
  const db = getDb();
  const existing = db.prepare('SELECT * FROM products WHERE id=? AND doctor_id=?').get(id, doctorId);
  if (!existing) { db.close(); return res.status(404).json({ error: 'Produto nao encontrado' }); }
  db.prepare(
    'UPDATE products SET name=?,description=?,category=?,price=?,sort_order=?,active=? WHERE id=?'
  ).run(
    name !== undefined ? String(name).trim() : existing.name,
    description !== undefined ? description : existing.description,
    category !== undefined ? category : existing.category,
    price !== undefined ? price : existing.price,
    sort_order !== undefined ? Number(sort_order) || 0 : existing.sort_order,
    active !== undefined ? (active ? 1 : 0) : existing.active,
    id
  );
  const row = db.prepare('SELECT * FROM products WHERE id=?').get(id);
  db.close();
  res.json(row);
});

router.delete('/:id', (req, res) => {
  const doctorId = resolveDoctorId(req);
  if (!doctorId) return res.status(401).json({ error: 'Nao autenticado' });
  const id = Number(req.params.id);
  const db = getDb();
  const r = db.prepare('DELETE FROM products WHERE id=? AND doctor_id=?').run(id, doctorId);
  db.close();
  if (!r.changes) return res.status(404).json({ error: 'Produto nao encontrado' });
  res.json({ ok: true });
});

export default router;

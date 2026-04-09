import { Router } from 'express';
import { getDb } from '../db/setup.js';
import { authMiddleware } from '../middleware/auth.js';
const router = Router();
router.use(authMiddleware);

router.get('/profile', (req, res) => {
  const db = getDb();
  const doc = db.prepare('SELECT id,name,clinic,email,instagram_handle,phone,whatsapp,address,bot_active,delay_first,delay_min,delay_max FROM doctors WHERE id=?').get(req.doctorId);
  db.close();
  res.json(doc);
});

router.put('/profile', (req, res) => {
  const { name, clinic, instagram_handle, phone, whatsapp, address } = req.body;
  const db = getDb();
  db.prepare("UPDATE doctors SET name=?,clinic=?,instagram_handle=?,phone=?,whatsapp=?,address=?,updated_at=datetime('now') WHERE id=?")
    .run(name, clinic, instagram_handle, phone, whatsapp, address, req.doctorId);
  db.close();
  res.json({ ok: true });
});

router.put('/delay', (req, res) => {
  const { delay_first, delay_min, delay_max } = req.body;
  const db = getDb();
  db.prepare("UPDATE doctors SET delay_first=?,delay_min=?,delay_max=?,updated_at=datetime('now') WHERE id=?")
    .run(delay_first || 3, delay_min || 2, delay_max || 3, req.doctorId);
  db.close();
  res.json({ ok: true });
});

router.put('/toggle-bot', (req, res) => {
  const { active } = req.body;
  const db = getDb();
  db.prepare("UPDATE doctors SET bot_active=?,updated_at=datetime('now') WHERE id=?").run(active ? 1 : 0, req.doctorId);
  db.close();
  res.json({ bot_active: active });
});

export default router;

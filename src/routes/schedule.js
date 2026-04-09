import { Router } from 'express';
import { getDb } from '../db/setup.js';
import { authMiddleware } from '../middleware/auth.js';
const router = Router();
router.use(authMiddleware);

router.get('/', (req, res) => {
  const db = getDb();
  const r = db.prepare("SELECT * FROM schedules WHERE doctor_id=? ORDER BY CASE day WHEN 'segunda' THEN 1 WHEN 'terca' THEN 2 WHEN 'quarta' THEN 3 WHEN 'quinta' THEN 4 WHEN 'sexta' THEN 5 WHEN 'sabado' THEN 6 END").all(req.doctorId);
  db.close();
  res.json(r);
});

router.put('/:day', (req, res) => {
  const { morning_start, morning_end, afternoon_start, afternoon_end, location, notes } = req.body;
  const db = getDb();
  db.prepare('INSERT INTO schedules (doctor_id,day,morning_start,morning_end,afternoon_start,afternoon_end,location,notes) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(doctor_id,day) DO UPDATE SET morning_start=excluded.morning_start,morning_end=excluded.morning_end,afternoon_start=excluded.afternoon_start,afternoon_end=excluded.afternoon_end,location=excluded.location,notes=excluded.notes')
    .run(req.doctorId, req.params.day, morning_start || null, morning_end || null, afternoon_start || null, afternoon_end || null, location || null, notes || null);
  db.close();
  res.json({ ok: true });
});

export default router;

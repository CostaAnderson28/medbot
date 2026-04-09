import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/setup.js';
import { generateToken } from '../middleware/auth.js';

const router = Router();

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatórios' });

  const db = getDb();
  const doc = db.prepare('SELECT * FROM doctors WHERE email=?').get(email);
  db.close();

  if (!doc || !bcrypt.compareSync(password, doc.password)) {
    return res.status(401).json({ error: 'Credenciais inválidas' });
  }

  const token = generateToken(doc);
  res.json({ token, doctor: { id: doc.id, name: doc.name, email: doc.email } });
});

router.post('/register', (req, res) => {
  const { name, clinic, email, password, instagram_handle } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatórios' });

  const hash = bcrypt.hashSync(password, 10);
  const db = getDb();
  try {
    const id = `dr-${Date.now()}`;
    db.prepare('INSERT INTO doctors (id,name,clinic,email,password,instagram_handle) VALUES(?,?,?,?,?,?)')
      .run(id, name || 'Doctor', clinic || '', email, hash, instagram_handle || '');
    const doc = db.prepare('SELECT * FROM doctors WHERE id=?').get(id);
    db.close();
    const token = generateToken(doc);
    res.json({ token, doctor: { id: doc.id, name: doc.name, email: doc.email } });
  } catch (e) {
    db.close();
    res.status(400).json({ error: 'Email já cadastrado' });
  }
});

export default router;

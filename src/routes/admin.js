import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/setup.js';
import { adminAuthMiddleware } from '../middleware/auth.js';

const router = Router();
router.use(adminAuthMiddleware);

// Lista todos os tenants
router.get('/tenants', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      d.id, d.name, d.clinic, d.email, d.instagram_handle, d.page_id,
      d.bot_active, d.is_admin, d.prompt_kind, d.tenant_type, d.created_at, d.updated_at,
      (SELECT COUNT(*) FROM conversations WHERE doctor_id=d.id) as conversations_count,
      (SELECT COUNT(*) FROM products WHERE doctor_id=d.id) as products_count
    FROM doctors d
    WHERE d.is_admin=0
    ORDER BY d.created_at DESC
  `).all();
  db.close();
  res.json(rows);
});

// Detalhe de um tenant (sem senha)
router.get('/tenants/:id', (req, res) => {
  const db = getDb();
  const doc = db.prepare(`
    SELECT id,name,clinic,email,instagram_handle,page_id,phone,whatsapp,address,
           bot_active,prompt_kind,tenant_type,model,delay_first,delay_min,delay_max,created_at,updated_at
    FROM doctors WHERE id=?
  `).get(req.params.id);
  if (!doc) { db.close(); return res.status(404).json({ error: 'Tenant nao encontrado' }); }
  const instructions = db.prepare('SELECT id,category,content,active FROM instructions WHERE doctor_id=?').all(doc.id);
  const products = db.prepare('SELECT id,name,description,category,price,sort_order,active FROM products WHERE doctor_id=? ORDER BY sort_order, category, name').all(doc.id);
  const schedules = db.prepare('SELECT id,day,morning_start,morning_end,afternoon_start,afternoon_end,location FROM schedules WHERE doctor_id=?').all(doc.id);
  db.close();
  res.json({ ...doc, instructions, products, schedules });
});

// Toggle bot
router.put('/tenants/:id/toggle-bot', (req, res) => {
  const { active } = req.body || {};
  const db = getDb();
  const r = db.prepare("UPDATE doctors SET bot_active=?,updated_at=datetime('now') WHERE id=? AND is_admin=0")
    .run(active ? 1 : 0, req.params.id);
  db.close();
  if (!r.changes) return res.status(404).json({ error: 'Tenant nao encontrado' });
  res.json({ bot_active: active ? 1 : 0 });
});

// Atualiza dados gerais do tenant (sem senha)
router.put('/tenants/:id', (req, res) => {
  const { name, clinic, email, instagram_handle, page_id, phone, whatsapp, address, prompt_kind, tenant_type, model } = req.body || {};
  const db = getDb();
  const existing = db.prepare('SELECT * FROM doctors WHERE id=? AND is_admin=0').get(req.params.id);
  if (!existing) { db.close(); return res.status(404).json({ error: 'Tenant nao encontrado' }); }
  // model: string vazia ou null -> usa env default. Senao, sobrescreve.
  const newModel = model === undefined
    ? existing.model
    : (model && String(model).trim() ? String(model).trim() : null);
  db.prepare(`UPDATE doctors SET
    name=?, clinic=?, email=?, instagram_handle=?, page_id=?, phone=?, whatsapp=?, address=?, prompt_kind=?, tenant_type=?, model=?,
    updated_at=datetime('now')
    WHERE id=?`).run(
    name ?? existing.name,
    clinic ?? existing.clinic,
    email ?? existing.email,
    instagram_handle ?? existing.instagram_handle,
    page_id ?? existing.page_id,
    phone ?? existing.phone,
    whatsapp ?? existing.whatsapp,
    address ?? existing.address,
    prompt_kind ?? existing.prompt_kind,
    tenant_type ?? existing.tenant_type,
    newModel,
    req.params.id
  );
  db.close();
  res.json({ ok: true });
});

// System prompt (para custom_full: instruction category='system_prompt')
router.get('/tenants/:id/system-prompt', (req, res) => {
  const db = getDb();
  const row = db.prepare("SELECT id,content,active FROM instructions WHERE doctor_id=? AND category='system_prompt' ORDER BY id ASC LIMIT 1").get(req.params.id);
  db.close();
  res.json(row || { id: null, content: '', active: 1 });
});

router.put('/tenants/:id/system-prompt', (req, res) => {
  const { content } = req.body || {};
  if (content === undefined) return res.status(400).json({ error: 'content obrigatorio' });
  const db = getDb();
  const existing = db.prepare("SELECT id FROM instructions WHERE doctor_id=? AND category='system_prompt' ORDER BY id ASC LIMIT 1").get(req.params.id);
  if (existing) {
    db.prepare('UPDATE instructions SET content=?, active=1 WHERE id=?').run(String(content), existing.id);
  } else {
    db.prepare("INSERT INTO instructions (doctor_id,category,content,active) VALUES (?, 'system_prompt', ?, 1)").run(req.params.id, String(content));
  }
  db.close();
  res.json({ ok: true });
});

// Criar novo tenant
router.post('/tenants', (req, res) => {
  const { id, name, clinic, email, password, tenant_type, instagram_handle, phone, whatsapp, address, system_prompt } = req.body || {};
  if (!id || !name || !email || !password) {
    return res.status(400).json({ error: 'id, name, email e password obrigatorios' });
  }
  const slug = String(id).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const hash = bcrypt.hashSync(String(password), 10);
  const tType = tenant_type === 'empresa' ? 'empresa' : 'medico';
  const db = getDb();
  try {
    // prompt_kind agora e sempre 'custom_full' (modelo unificado: prompt vem do banco).
    db.prepare(`INSERT INTO doctors
      (id,name,clinic,email,password,instagram_handle,phone,whatsapp,address,prompt_kind,tenant_type,is_admin,bot_active)
      VALUES (?,?,?,?,?,?,?,?,?, 'custom_full', ?, 0, 1)`).run(
      slug, name, clinic || '', email, hash,
      instagram_handle || '', phone || '', whatsapp || '', address || '', tType
    );
    if (system_prompt && String(system_prompt).trim()) {
      db.prepare("INSERT INTO instructions (doctor_id,category,content,active) VALUES (?, 'system_prompt', ?, 1)")
        .run(slug, String(system_prompt));
    }
    db.close();
    res.json({ id: slug, email });
  } catch (e) {
    db.close();
    if (String(e?.message).includes('UNIQUE')) {
      return res.status(400).json({ error: 'id ou email ja cadastrado' });
    }
    res.status(500).json({ error: 'Erro ao criar tenant', detail: String(e?.message || e) });
  }
});

// Reset password de um tenant
router.put('/tenants/:id/password', (req, res) => {
  const { password } = req.body || {};
  if (!password || String(password).length < 6) return res.status(400).json({ error: 'password (>=6 chars) obrigatorio' });
  const hash = bcrypt.hashSync(String(password), 10);
  const db = getDb();
  const r = db.prepare('UPDATE doctors SET password=? WHERE id=? AND is_admin=0').run(hash, req.params.id);
  db.close();
  if (!r.changes) return res.status(404).json({ error: 'Tenant nao encontrado' });
  res.json({ ok: true });
});

export default router;

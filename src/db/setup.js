import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', '..', 'data.db');

export function getDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function setupDatabase() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS doctors (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      clinic TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      instagram_handle TEXT,
      page_id TEXT,
      phone TEXT,
      whatsapp TEXT,
      address TEXT,
      bot_active INTEGER DEFAULT 1,
      delay_first INTEGER DEFAULT 3,
      delay_min INTEGER DEFAULT 2,
      delay_max INTEGER DEFAULT 3,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doctor_id TEXT NOT NULL,
      day TEXT NOT NULL,
      morning_start TEXT, morning_end TEXT,
      afternoon_start TEXT, afternoon_end TEXT,
      location TEXT, notes TEXT,
      FOREIGN KEY (doctor_id) REFERENCES doctors(id),
      UNIQUE(doctor_id, day)
    );
    CREATE TABLE IF NOT EXISTS instructions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doctor_id TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      FOREIGN KEY (doctor_id) REFERENCES doctors(id)
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doctor_id TEXT NOT NULL,
      sender_id TEXT,
      instagram_username TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      last_message_at TEXT DEFAULT (datetime('now')),
      message_count INTEGER DEFAULT 0,
      link_sent INTEGER DEFAULT 0,
      whatsapp_redirect INTEGER DEFAULT 0,
      urgency INTEGER DEFAULT 0,
      lead_name TEXT, lead_phone TEXT, lead_convenio TEXT,
      FOREIGN KEY (doctor_id) REFERENCES doctors(id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );
  `);

  const convColumns = db.prepare("PRAGMA table_info(conversations)").all();
  const hasInstagramUsername = convColumns.some(c => c.name === 'instagram_username');
  if (!hasInstagramUsername) {
    db.exec('ALTER TABLE conversations ADD COLUMN instagram_username TEXT');
  }

  const exists = db.prepare('SELECT id FROM doctors WHERE id = ?').get('dr-antonio');
  if (!exists) {
    const hash = bcrypt.hashSync('oftalmo2024', 10);
    db.prepare('INSERT INTO doctors (id,name,clinic,email,password,instagram_handle,phone,whatsapp,address) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('dr-antonio','Dr. Antonio','Oftalmoclinica Icarai','dr.antonio@oftalmoclinicaicarai.com',hash,'dr.antonio.oftalmo','(21) 2703-6100','(21) 99662-1437','Icarai, Niteroi - RJ');

    const si = db.prepare('INSERT INTO schedules (doctor_id,day,morning_start,morning_end,afternoon_start,afternoon_end,location) VALUES (?,?,?,?,?,?,?)');
    [['segunda','09:00','11:00','13:30','15:50','Roberto Silveira, 4o andar, Cons. 2'],
     ['terca','09:00','11:00','13:30','15:50','Roberto Silveira, 4o andar, Cons. 2'],
     ['quarta',null,null,null,null,null],
     ['quinta','09:00','11:00','13:30','15:50','Roberto Silveira, 4o andar, Cons. 2'],
     ['sexta',null,null,null,null,null],
     ['sabado',null,null,null,null,null]
    ].forEach(r => si.run('dr-antonio', ...r));

    const ii = db.prepare('INSERT INTO instructions (doctor_id,category,content) VALUES (?,?,?)');
    ii.run('dr-antonio','memoria','Dr. Antonio e filho do Dr. Edison, que tambem atende na clinica.');
    ii.run('dr-antonio','convenios','Allianz, Amil, Assefaz, Assim, Banco Central, Bradesco Saude, Caberj, Caberj Integral, Camarj, Camperj, Capesaude, Care Plus, Cassi, Fapes (BNDES), Fiosaude, Gama Saude, GEAP, Golden Cross, Ipalerj, Life Saude, Mediservice, Memorial Saude, Mutua, Notre Dame, Opty, Pasa Saude, Porto Seguro, Postal Saude, Real Grandeza, Saude Caixa, SulAmerica, Unafisco Saude, Unimed Leste, Unimed, Unimed Nacional, Vale. Tambem PARTICULAR.');
    ii.run('dr-antonio','procedimentos','Catarata: 15-20min, anestesia com colirio, facoemulsificacao, recuperacao rapida.\nInjecoes Intravitreas: DMRI, edema macular diabetico, anti-VEGF, rapido no consultorio.');
    ii.run('dr-antonio','pos_operatorio','Colirios conforme prescricao, nao cocar, evitar esforco 1-2 semanas. URGENCIA se dor intensa ou perda de visao.');
    ii.run('dr-antonio','agendamento','Link: https://doclogos.com/oftalmoclinicaicarai/ - consulta e exame. Orientar escolher Dr. Antonio.');
    ii.run('dr-antonio','personalizado','Nunca use diminutivos (certinho, direitinho). Use a forma normal. Nunca use emojis. Respostas concisas e uteis.');

    console.log('Dr. Antonio criado! Login: dr.antonio@oftalmoclinicaicarai.com / oftalmo2024');
  }
  db.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) { setupDatabase(); console.log('Database OK!'); }

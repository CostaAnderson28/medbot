import Database from 'better-sqlite3';

const db = new Database('./data.db');
db.prepare("UPDATE doctors SET page_id=? WHERE id=?").run('123456789', 'dr-antonio');
const result = db.prepare("SELECT id, name, page_id FROM doctors WHERE id=?").get('dr-antonio');
console.log('✅ Atualizado:', result);
db.close();

import 'dotenv/config.js';
import Database from 'better-sqlite3';

const GRAPH_VERSION = process.env.GRAPH_API_VERSION || 'v25.0';
const PAGE_ACCESS_TOKEN = (process.env.PAGE_ACCESS_TOKEN || '').trim();
const DOCTOR_ID = (process.env.DOCTOR_ID || 'dr-antonio').trim();
const IG_ACCOUNT_ID = (process.env.IG_ACCOUNT_ID || process.env.INSTAGRAM_ACCOUNT_ID || '').trim();
const SUBSCRIBED_FIELDS = (process.env.SUBSCRIBED_FIELDS || 'messages').trim();
const DB_PATH = process.env.DB_PATH || './data.db';

function exitWith(message) {
  console.error(message);
  process.exit(1);
}

function resolveInstagramAccountId() {
  if (IG_ACCOUNT_ID) return IG_ACCOUNT_ID;

  try {
    const db = new Database(DB_PATH, { readonly: true });
    const row = db
      .prepare('SELECT page_id FROM doctors WHERE id = ?')
      .get(DOCTOR_ID);
    db.close();

    if (row?.page_id) return String(row.page_id).trim();
  } catch (err) {
    console.warn('Nao foi possivel ler page_id no banco:', err.message);
  }

  return '';
}

async function postSubscribe(igId) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${igId}/subscribed_apps`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${PAGE_ACCESS_TOKEN}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ subscribed_fields: SUBSCRIBED_FIELDS })
  });

  const data = await response.json();
  if (!response.ok || data?.error) {
    throw new Error(JSON.stringify(data));
  }

  return data;
}

async function getSubscribeStatus(igId) {
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${igId}/subscribed_apps`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${PAGE_ACCESS_TOKEN}`
    }
  });

  const data = await response.json();
  if (!response.ok || data?.error) {
    throw new Error(JSON.stringify(data));
  }

  return data;
}

async function main() {
  if (!PAGE_ACCESS_TOKEN) {
    exitWith('PAGE_ACCESS_TOKEN nao definido no ambiente.');
  }

  const igId = resolveInstagramAccountId();
  if (!igId) {
    exitWith('IG_ACCOUNT_ID/INSTAGRAM_ACCOUNT_ID nao definido e page_id nao encontrado no banco.');
  }

  console.log(`Inscrevendo app para conta IG ${igId}...`);
  const subscribeResult = await postSubscribe(igId);
  console.log('POST /subscribed_apps:', subscribeResult);

  const status = await getSubscribeStatus(igId);
  console.log('GET /subscribed_apps:', JSON.stringify(status, null, 2));
}

main().catch((err) => {
  console.error('Falha ao configurar subscribed_apps:', err.message);
  process.exit(1);
});

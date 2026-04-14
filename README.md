# Chatbot Médico — Instagram + Painel

Sistema completo de chatbot para atendimento médico via Instagram DM, com painel administrativo, simulação, CRM e métricas.

## Estrutura

```
chatbot-medico/
├── package.json
├── .env.example
├── src/
│   ├── server.js             # Express + webhook + chat
│   ├── prompt-builder.js     # Monta prompt do Claude
│   ├── db/setup.js           # SQLite + seed
│   ├── middleware/auth.js    # JWT
│   └── routes/
│       ├── auth.js
│       ├── schedule.js
│       ├── instructions.js
│       ├── metrics.js
│       └── settings.js
└── public/
    ├── index.html            # Painel completo (6 abas)
    └── demo.html             # Chat demo público
```

## Stack

- **Backend:** Node.js + Express + SQLite (better-sqlite3) + JWT
- **Frontend:** HTML/CSS/JS vanilla, sem build step
- **IA:** Anthropic Claude API (Sonnet)
- **Deploy:** PM2 + Nginx + Let's Encrypt

## Setup local

```bash
npm install
cp .env.example .env
# Edite .env com a ANTHROPIC_API_KEY
npm run setup
npm start
```

Acesse:
- http://localhost:3000 → Painel (login: dr.antonio@oftalmoclinicaicarai.com / oftalmo2024)
- http://localhost:3000/demo.html → Chat demo
- http://localhost:3000/health → Status

## Variáveis de ambiente

```
ANTHROPIC_API_KEY=sk-ant-api03-...    # Chave Anthropic
JWT_SECRET=string-forte               # Segredo JWT
PAGE_ACCESS_TOKEN=EAA...              # Token Instagram (depois de criar app no Meta)
VERIFY_TOKEN=oftalmo2024              # Você escolhe
IG_ACCOUNT_ID=1784...                 # ID da conta Instagram (opcional se page_id estiver no banco)
DOCTOR_ID=dr-antonio                  # Doutor usado para fallback de page_id no banco
PORT=3000
```

## Deploy VPS Ubuntu

```bash
# Subir arquivos
scp -r chatbot-medico/ user@IP:~/chatbot-medico

# No servidor
cd chatbot-medico
npm install
cp .env.example .env
nano .env  # preencher
npm run setup

# PM2
npm install -g pm2
pm2 start src/server.js --name chatbot-medico
pm2 save && pm2 startup

# Nginx + SSL
sudo apt install nginx certbot python3-certbot-nginx -y
# Config Nginx apontando pra localhost:3000
sudo certbot --nginx -d bot.dominio.com
```

## Painel — 6 abas

1. **Dashboard** — métricas, funil, conversas recentes
2. **Conversas** — CRM com histórico, busca, filtros por status
3. **Agenda** — horários semanais editáveis
4. **Instruções** — CRUD de instruções por categoria
5. **Simulação** — chat de teste usando o mesmo prompt do Instagram
6. **Configurações** — perfil + delay configurável

## Webhook Instagram

1. Criar app Business em developers.facebook.com
2. Adicionar produto Instagram
3. Gerar Page Access Token → colocar no .env
4. Configurar webhook:
   - URL: `https://bot.dominio.com/webhook`
   - Verify Token: mesmo do .env
   - Campo: `messages`
5. Ativar inscrição da conta no app (subscribed_apps):
    - `npm run subscribe:webhook`
    - Esperado: POST e GET de `/subscribed_apps` com sucesso
6. Adicionar testers ou submeter App Review pra produção

### Script de inscrição (subscribed_apps)

Após deploy e configuração de variáveis, rode:

```bash
npm run subscribe:webhook
```

O script usa `IG_ACCOUNT_ID` (ou `INSTAGRAM_ACCOUNT_ID`). Se não existir, tenta ler `page_id` do doutor no `data.db` usando `DOCTOR_ID`.

## Login padrão

- **Email:** dr.antonio@oftalmoclinicaicarai.com
- **Senha:** oftalmo2024

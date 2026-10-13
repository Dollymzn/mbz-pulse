# MBZ::PULSE

Rastreador de **CPR / eCPM por post, país e site**. Cada leitura gravada é comparada na hora com o último registro da mesma campanha (site + post id + país). Cada usuário tem a própria conta, os próprios sites e o próprio histórico.

## O que faz

- **Contas isoladas** — login por e-mail/senha; ninguém vê site ou leitura de outro usuário.
- **Sites por usuário** — nome, URL e moeda (USD, BRL, EUR).
- **Comparação ao vivo** — ao preencher site + país + post id, o último registro aparece; ao digitar CPR/eCPM, a variação e o veredito (MELHOROU / PIOROU / MISTO / ESTÁVEL) atualizam a cada tecla, antes de gravar.
- **Post novo** — sem histórico do post, compara com a última leitura do mesmo site e país (e avisa que é esse o caso).
- **Histórico** — visão *por campanha* (última leitura de cada uma) ou *todas as leituras*, com Δ contra a leitura anterior, filtros e exportação CSV.
- **Atalho** — clicar numa linha do histórico preenche o formulário para lançar a próxima leitura daquela campanha.

Regra de cor: **CPR caindo é verde** (custo) e **eCPM subindo é verde** (receita); o contrário é rosa; variação de até ±2% conta como estável (`FLAT` em `public/app.js`).

## Deploy no Railway

1. Suba esta pasta para um repositório no GitHub.
2. Railway → **New Project → Deploy from GitHub repo** → escolha o repositório.
3. No mesmo projeto: **+ New → Database → PostgreSQL**.
4. No serviço do app, aba **Variables**:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`
   - `JWT_SECRET` = uma string longa e aleatória
   - `INVITE_CODE` = (opcional, recomendado) código exigido para criar conta
5. **Settings → Networking → Generate Domain**.

As tabelas são criadas sozinhas na primeira subida.

## Rodar local

```bash
cp .env.example .env   # preencha DATABASE_URL e JWT_SECRET
npm install
node --env-file=.env server.js
```

## Variáveis

| Variável | Obrigatória | Para quê |
|---|---|---|
| `DATABASE_URL` | sim | Postgres |
| `JWT_SECRET` | sim em produção | assina a sessão (cookie httpOnly, 30 dias) |
| `INVITE_CODE` | não | trava o cadastro para quem tem o código |
| `PGSSL` | não | `true` se conectar pela URL pública do Postgres |

## API

| Método | Rota | |
|---|---|---|
| POST | `/api/auth/register` · `/login` · `/logout` | conta e sessão |
| GET | `/api/me` | usuário logado |
| GET/POST | `/api/sites` | lista / cria |
| PATCH/DELETE | `/api/sites/:id` | edita / exclui (leva o histórico junto) |
| GET | `/api/records?site_id&country&post_id&latest=1&limit&offset` | histórico com valores anteriores |
| GET | `/api/records/last?site_id&post_id&country` | último registro + série, para a comparação ao vivo |
| POST | `/api/records` | grava leitura; devolve também o registro anterior |
| DELETE | `/api/records/:id` | apaga leitura |
| GET | `/api/records/export.csv` | CSV com os mesmos filtros |

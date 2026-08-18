# Runbook — Deploy do DeskcommCRM via EasyPanel (fork dagleyweyber)

Este documento descreve o fluxo real usado para instalar e manter esta instância,
rodando isolada num projeto próprio (`deskcomm-crm`) dentro de um EasyPanel que já
hospeda outro serviço (`adsiacrm`/n8n) na mesma VPS. Registra também bugs reais da
API do EasyPanel encontrados durante a instalação, para não serem redescobertos.

## Arquitetura

- VPS única (Hostinger, apesar do hostname `.hstgr.cloud`), gerenciada por
  **EasyPanel** rodando em modo **Docker Swarm**.
- EasyPanel já possui seu próprio Traefik ocupando as portas 80/443 — por isso
  **não usamos o Caddy** que vem no `docker-compose.prod.yml` original (ele tentaria
  bindar as mesmas portas e falharia, ou pior, brigaria com o Traefik existente).
- O DeskcommCRM roda como um **projeto isolado** (`deskcomm-crm`) dentro do
  EasyPanel, com seu próprio serviço tipo `compose`, separado de qualquer outro
  projeto já existente na VPS.
- Banco: Supabase (projeto cloud, plano free), acessado via **connection pooler**
  (não a conexão direta — ver "Armadilhas" abaixo).

## Repositórios

- `upstream` → `melgarafael/DeskcommCRM` (autor original, código comprado) — **só
  leitura**, nunca fazemos push aqui.
- `origin` → `dagleyweyber/DeskcommCRM` (nosso fork) — é onde toda mudança nossa
  vive. Push via deploy key SSH dedicada a este repositório (não um PAT de conta
  inteira — escopo mínimo necessário).

Trazer atualizações do autor original quando fizer sentido:
```bash
git fetch upstream
git merge upstream/main   # ou rebase, conforme preferir
git push origin main
```
⚠️ Antes de aplicar migrations novas trazidas do upstream, confirme que a versão de
imagem publicada (`APP_IMAGE`/`WORKER_IMAGE`/`SCHEDULER_IMAGE` no `.env`) já
corresponde a esse código — aplicar schema mais novo que o app rodando pode
quebrar coisa.

## Onde as coisas vivem na VPS

```
/etc/easypanel/projects/deskcomm-crm/deskcomm-crm/code/
  ├── docker-compose.yml           # fonte "inline" registrada no EasyPanel
  ├── docker-compose.override.yml  # gerado PELO EasyPanel (rede/labels do Traefik) — não editar
  └── .env                         # variáveis de ambiente reais (nunca commitar)
```

## Fluxo padrão pra mudar configuração (env, compose)

1. Editar o `.env`/compose localmente (nunca direto na VPS como fluxo normal).
2. Enviar pra API do EasyPanel:
   ```bash
   curl -X POST http://localhost:3000/api/rpc/services/compose/updateEnv \
     -H "Authorization: Bearer $EASYPANEL_API_TOKEN" -H "Content-Type: application/json" \
     -d "$(jq -n --rawfile envfile .env '{json:{projectName:"deskcomm-crm",serviceName:"deskcomm-crm",env:$envfile}}')"
   ```
   (mesma ideia para `services/compose/updateSourceInline` no caso do compose)
3. **Confirmar que o arquivo realmente chegou no disco** (ver "Armadilhas" — a API
   às vezes retorna sucesso sem escrever):
   ```bash
   ssh root@VPS 'cat /etc/easypanel/projects/deskcomm-crm/deskcomm-crm/code/.env | head'
   ```
   Se não bateu, copiar manualmente por scp como contingência.
4. Redeploy:
   ```bash
   cd /etc/easypanel/projects/deskcomm-crm/deskcomm-crm/code/
   docker compose -f docker-compose.yml -f docker-compose.override.yml \
     -p deskcomm-crm_deskcomm-crm up -d
   ```
   **Nunca usar `--build`** nesta instalação — os serviços `worker`/`scheduler`
   têm bloco `build:` no compose original apontando pro Dockerfile, que não existe
   neste diretório (só o compose+env moram aqui, não o repo inteiro). `--build`
   força reconstrução e falha. Usamos imagens publicadas via `image:` — por isso
   removemos o `build:` desses dois serviços no nosso compose.
5. Validar: `docker ps` (todos `healthy`) e `curl -I https://SEU_DOMINIO/`.

## Fluxo pra mudar CÓDIGO de verdade (não só config)

Ponto crítico: hoje o compose puxa **imagens prontas do autor original**
(`ghcr.io/melgarafael/...`). Mudar código no nosso fork **não afeta essas imagens**
— elas continuam sendo as dele. Pra rodar código nosso, duas opções:

- **Build na própria VPS** (mais simples pra uma instância só): apontar `build:`
  do compose pro checkout do nosso fork (`/root/DeskcommCRM` ou equivalente) e usar
  `docker-compose.build.yml`. Mais lento a cada deploy, mas sem precisar de
  registry próprio.
- **Publicar imagem própria**: configurar Actions no nosso fork pra buildar e
  publicar em `ghcr.io/dagleyweyber/...`, e apontar `APP_IMAGE`/etc. pra lá. Vale a
  pena se o ritmo de mudança justificar o esforço de CI.

Nenhuma das duas está configurada ainda — decidir quando a primeira mudança de
código de verdade for necessária.

## Antes de qualquer deploy de código

```bash
pnpm gov:verify   # typecheck + lint + lint:channels + testes unitários
```
Já existe CI (`.github/workflows/ci.yml`) e testes e2e (Playwright) no projeto —
usar antes de subir qualquer mudança de comportamento.

## Mudança de banco (schema)

- **Nunca** SQL solto direto em produção pra mudança estrutural — criar migration
  nova em `supabase/migrations/`, seguindo o padrão de nome existente.
- SQL direto só se justifica pra correção pontual de **dado** (ex.: provisionar
  manualmente um tenant travado), nunca pra mudança de schema.
- `supabase/baseline.sql` é gerado a partir das migrations — não editar à mão.

## Backups

Cron diário já configurado na VPS (3h da manhã), usando a role restrita
`agent_worker` (não o superusuário):
```
0 3 * * * SUPABASE_DB_URL="postgresql://agent_worker.<ref>:***@aws-0-sa-east-1.pooler.supabase.com:5432/postgres" \
  bash /root/DeskcommCRM/scripts/backup-db.sh /root/backups/deskcomm >> /root/backups/backup.log 2>&1
```
Retenção: 14 dias (default do script). Restaurar com:
```bash
pg_restore --clean --no-owner -d "$SUPABASE_DB_URL" arquivo.dump
```

## Armadilhas reais encontradas (17-18/08/2026)

1. **API do EasyPanel (`createService`/`updateEnv`/`updateSourceInline`) às vezes
   retorna sucesso (ou até 500) sem escrever `.env`/`docker-compose.yml` no disco.**
   Sempre conferir com `cat` no arquivo antes de assumir que a config subiu. Se não
   bateu, copiar manualmente via scp como contingência.
2. **`--build` no comando de deploy quebra** porque só o compose+env vivem no
   diretório do projeto, não o repositório inteiro — removemos `build:` de
   `worker`/`scheduler` no nosso compose.
3. **Conexão direta do Supabase (`db.<ref>.supabase.co`) só resolve em IPv6.** Sem
   IPv6 configurado no ambiente Docker, a conexão falha com "Network is
   unreachable". Usar sempre o **connection pooler** (IPv4):
   `postgresql://<user>.<ref>@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`
4. **Confirmação de e-mail com template padrão do Supabase não fecha** nesta
   instalação (PKCE + cookie `sameSite: strict` não sobrevive à navegação
   cross-site do clique no e-mail — ver comentário em
   `app/auth/confirm/route.ts`). O conserto documentado
   (`hostgator-setup-kit/marca-emails.sh`) exige **SMTP customizado** — não
   funciona no plano free do Supabase com o mailer padrão.
   **✅ Resolvido em 18/08/2026** — SMTP próprio configurado via Resend
   (domínio `mail.adsprocompany.com`, verificado com DKIM/SPF/MX). Ver seção
   "SMTP próprio (Resend)" abaixo. Se algum dia o domínio/chave mudar, os
   e-mails voltam a cair no template padrão (PKCE quebrado) até reconfigurar.

## SMTP próprio (Resend)

- Domínio de envio: `mail.adsprocompany.com` (verificado no Resend com DKIM,
  MX/SPF; DMARC opcional — ver `docs/runbooks/` se precisar reconfigurar).
- Credenciais SMTP usadas no Supabase Auth (`PATCH /v1/projects/{ref}/config/auth`):
  `smtp_host=smtp.resend.com`, `smtp_port=465`, `smtp_user=resend`,
  `smtp_pass=<API key do Resend>`, `smtp_admin_email=noreply@mail.adsprocompany.com`,
  `smtp_sender_name=DeskcommCRM`.
- Depois de configurar o SMTP, rodar (ou re-rodar) o
  `hostgator-setup-kit/marca-emails.sh` — só funciona com SMTP já configurado,
  falha em plano free do Supabase sem isso.
- Mesma chave do Resend também vai em `RESEND_API_KEY`/`RESEND_FROM_EMAIL` no
  `.env` do app, pra e-mail transacional próprio (convites de time, etc.).
- Rotacionar a chave do Resend se algum dia vazar: gerar nova em
  resend.com/api-keys, atualizar `smtp_pass` via PATCH acima e `RESEND_API_KEY`
  no `.env`, redeploy.

## Provisionar usuário manualmente (só se o SMTP cair/for reconfigurado errado)

```sql
-- 1. Confirmar e-mail (se ainda não estiver)
update auth.users set email_confirmed_at = now() where email = '...' and email_confirmed_at is null;

-- 2. Criar organização
insert into organizations (slug, display_name, legal_name, status, created_by)
values ('slug-aqui', 'Nome Aqui', 'Nome Aqui', 'active', '<user_id>')
returning id;

-- 3. Vincular como admin
insert into user_organizations (user_id, organization_id, role, accepted_at)
values ('<user_id>', '<organization_id>', 'admin', now());
```

## Pendências conhecidas

- Chave de IA (Anthropic/OpenRouter) — agente não responde sem isso
  (`/app/ai/credentials`).
- Domínio próprio — hoje usa subdomínio temporário do EasyPanel
  (`*.vjlauk.easypanel.host`).
- CI/registry próprio, se/quando começarmos a customizar código de verdade.

# Checklist de Mudança — toda melhoria/ajuste no fork

Processo obrigatório antes de qualquer alteração no CRM, pra garantir que uma
melhoria nova não quebra o que já funciona. Não é opcional nem some se a
mudança parecer pequena — as duas primeiras mudanças reais deste fork
(`fix/convite-org-fantasma`, `feat/lead-campos-extras`) seguiram exatamente
este roteiro, com sucesso.

## 1. Entender antes de escrever

- Procurar se já existe um padrão pronto pra isso (hook, componente, endpoint,
  campo de banco) antes de criar algo novo. Grep pelo conceito, não só pelo
  nome do arquivo.
- Reusar em vez de duplicar. Exemplos reais: `useAssignableMembers` (lista de
  atendentes, já usada no menu de reatribuição do card) e `normalizePhoneBR`
  (normalização de telefone, já usada no webhook inbound).
- Checar se o schema do banco já suporta o que foi pedido antes de propor
  migration. `crm_leads.custom_fields` (jsonb) e `crm_pipelines.settings`
  (jsonb) existem exatamente pra isso — extensão sem migration.

## 2. Escopo isolado

- Branch a partir da **tag/imagem que está rodando em produção**, nunca de
  `main` direto (acumula mudanças não relacionadas e não testadas em prod).
- Uma melhoria por branch. Não empacotar duas mudanças sem relação no mesmo
  deploy — se uma quebrar, a outra não pode ficar refém do rollback.

## 3. Mudança de schema é último recurso

- Ordem de preferência: (1) campo jsonb extensível já existente, (2) coluna
  nova via migration versionada em `supabase/migrations/`, (3) nunca SQL solto
  direto em produção pra mudança **estrutural** (SQL direto só se justifica
  pra correção pontual de **dado**, como o provisionamento manual de tenant
  documentado no outro runbook).

## 4. Não quebrar quem já depende do comportamento atual

- Campo novo nasce **opcional**, com default que preserva o comportamento
  anterior — quem não usar o campo novo nem percebe que ele existe.
- Rodar a suíte inteira antes de buildar, não só o que parece relacionado:
  ```bash
  docker run --rm -v "$(pwd)":/app -w /app node:22 sh -c \
    "corepack enable && corepack prepare pnpm@9.15.9 --activate && pnpm gov:verify"
  ```
  Isso é typecheck + lint + lint:channels + os ~4200 testes unitários do
  projeto. Warning pré-existente (já estava lá antes da mudança) não bloqueia;
  erro novo ou teste quebrado, sim.

## 5. Atenção redobrada em isolamento multi-tenant

Qualquer mudança que toque RLS, `organization_id`, ou dados entre
organizações merece revisão extra — é onde um bug vaza dado de um cliente pro
outro. Ver os comentários de `app/api/v1/leads/_handler.ts` sobre esse
exato risco (already mordeu esse projeto antes, por isso o comentário existe).

## 6. Deploy sempre versionado

- Cada mudança ganha sua própria tag de imagem (`deskcomm-app:nome-da-mudanca`),
  nunca sobrescrever a tag anterior.
- Rollback é só trocar `APP_IMAGE`/`WORKER_IMAGE`/`SCHEDULER_IMAGE` no `.env`
  de volta pra tag anterior e redeployar — a imagem antiga continua no disco
  da VPS, não precisa rebuildar. Ver "Fluxo pra mudar CÓDIGO de verdade" em
  `deploy-fork-easypanel.md`.

## 7. Validar de ponta a ponta depois do deploy

`docker ps` mostrando `healthy` prova que o processo subiu, não que a
funcionalidade funciona. Testar o caminho real (criar o lead, mandar o
convite, o que for) depois de cada deploy, não só checar o status do
container.

## 8. Documentar decisão não-óbvia

Se a investigação revelou algo que não é óbvio pela próxima vez (um bug de
API, uma limitação de plataforma, um padrão existente que vale reusar),
registrar no runbook. O objetivo é nunca redescobrir o mesmo problema duas
vezes.

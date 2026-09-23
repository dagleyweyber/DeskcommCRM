-- 0177: aba "IA" do Inbox mostrava zero mesmo com agente respondendo de verdade
--
-- Achado ao vivo (RevitaFio Mossoro): a aba filtrava por
-- `conversations.status = 'ai_handling'` — valor LEGADO (migration 0032,
-- anterior a `assignee_kind`) que nada no fluxo atual escreve mais. Pior:
-- `assignee_kind = 'ai'` (a substituição oficial) TAMBÉM não serve sozinho —
-- o motor real que atende (lib/agent-engine/agent/inbound-turn.ts, processo
-- `workers/agent-worker/main.ts`) nunca toca essa coluna. Só o sistema
-- irmão (lib/ai/runtime/agent.ts, via lib/escalacao/retomada.ts) escreve
-- nela. Os dois sistemas de fato usados por clientes hoje não convergem num
-- campo comum — a única verdade compartilhada é O QUE FOI ENVIADO
-- (`messages.sent_via`).
--
-- fn_conversas_ia_ativa resolve pela mensagem, não por um campo de estado:
-- conversa ativa (não fechada/arquivada), não reivindicada por humano
-- (assignee_kind distinto de 'user'), cuja ÚLTIMA mensagem outbound tem
-- sent_via='ai'. Funciona pros dois motores, sem tocar em nenhum dos dois —
-- é leitura pura sobre o que já foi mandado de verdade.

-- `security definer` (bypassa RLS de propósito — precisa olhar `messages` sem
-- reexecutar a policy por linha) chamada pelo client de SESSÃO do usuário
-- (`listConversationsHandler` usa `createClient()`, não o admin). Sem o guard
-- de `fn_user_org_ids()` abaixo, `p_organization_id` seria um parâmetro cru:
-- qualquer `authenticated` poderia chamar a função pedindo o id de OUTRA
-- organização e receber ids de conversa que não são dela — o mesmo vazamento
-- entre tenants que `hardening-definer-varredura.test.ts` existe pra pegar.
create or replace function public.fn_conversas_ia_ativa(p_organization_id uuid)
returns table(conversation_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select c.id
  from public.conversations c
  where c.organization_id = p_organization_id
    and p_organization_id in (select public.fn_user_org_ids())
    and c.status not in ('closed', 'archived')
    and coalesce(c.assignee_kind, '') <> 'user'
    and (
      select m.sent_via
      from public.messages m
      where m.conversation_id = c.id
        and m.direction = 'outbound'
      order by m.sent_at desc
      limit 1
    ) = 'ai';
$$;

revoke execute on function public.fn_conversas_ia_ativa(uuid) from public, anon;
grant execute on function public.fn_conversas_ia_ativa(uuid) to authenticated, service_role;

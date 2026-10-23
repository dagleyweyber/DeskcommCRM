-- 0194_channel_sessions_meta_phone_unico_ativo — um número da Meta, uma sessão ATIVA.
--
-- Achado revisando o canal oficial antes de abrir um segundo modo de conexão
-- (Embedded Signup + Coexistência, Fase 0 do projeto): nada impedia duas linhas de
-- `channel_sessions` com o mesmo `meta_phone_number_id`. O delete só ARQUIVA a
-- sessão (o id do número fica na linha), então reconectar um número já usado
-- deixava duas linhas — e o roteamento do webhook e a busca de credencial resolvem a
-- sessão por esse id com `maybeSingle()`, que falha com mais de uma linha. O efeito
-- é silencioso: a credencial some, o envio cai no env e a mensagem de entrada não
-- acha o canal.
--
-- A trava existente (`channel_sessions_phone_per_org_unique`, DEFERRABLE) é sobre o
-- telefone e por organização — não cobre este id, e não impede DUAS organizações
-- apontarem o mesmo número. Este índice cobre os dois casos.
--
-- Parcial em `archived_at is null`: sessão arquivada é histórico e pode repetir o id
-- (é justamente o caso de reconectar). Não é DEFERRABLE (índice único parcial não
-- pode ser): quem arquiva a sessão antiga e cria a nova numa transação tem que
-- arquivar PRIMEIRO — é a ordem que `channels/official` e o delete já seguem.
--
-- Produção verificada antes de escrever: 2 números, nenhuma duplicata ativa.
create unique index if not exists channel_sessions_meta_phone_active_uidx
  on public.channel_sessions (meta_phone_number_id)
  where archived_at is null and meta_phone_number_id is not null;

-- 0195_channel_sessions_meta_connection_mode — COMO a sessão Meta foi conectada.
--
-- Fase 1 do Embedded Signup / Coexistência. O canal continua `provider='meta_cloud'`
-- (doutrina restricao-de-canal, emenda de 2026-10-23: sem provider novo); o que muda
-- é o MODO, e modo é dado da sessão:
--   byo                    — o operador colou token/IDs do próprio app (comportamento
--                            de sempre; é o default, então nenhuma linha existente muda)
--   embedded_coexistence   — conectado pelo popup do Embedded Signup com o número
--                            ainda ativo no app WhatsApp Business do celular
--
-- `meta_onboarded_at` marca o fim do onboarding: a Meta dá 24h a partir dele para
-- sincronizar contatos e histórico (uma vez cada), então a Fase 2 precisa saber
-- quando a janela abriu.
alter table public.channel_sessions
  add column if not exists meta_connection_mode text not null default 'byo',
  add column if not exists meta_onboarded_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.channel_sessions'::regclass
      and conname = 'channel_sessions_meta_connection_mode_check'
  ) then
    alter table public.channel_sessions
      add constraint channel_sessions_meta_connection_mode_check
      check (meta_connection_mode in ('byo', 'embedded_coexistence'));
  end if;
end $$;

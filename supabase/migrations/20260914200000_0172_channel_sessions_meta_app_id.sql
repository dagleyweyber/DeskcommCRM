-- 0172_channel_sessions_meta_app_id — falta o ID do App da Meta pra
-- template com imagem no cabeçalho funcionar.
--
-- Achado ao vivo (RevitaFio Mossoró): criar template com imagem sempre
-- recusava com "Parâmetro de exemplo não fornecido para o tipo do título" —
-- a Meta exige, em `components[].example.header_handle`, um HANDLE de mídia
-- obtido pela Resumable Upload API (`POST /{app_id}/uploads`), não uma URL
-- pública. O código mandava uma URL assinada do nosso Storage nesse campo —
-- a Meta baixa arquivo por URL só no ENVIO de mensagem (Cloud API), não na
-- criação/revisão de definição, onde o contrato é outro.
--
-- Pra chamar a Resumable Upload API é preciso o `app_id` do App da Meta
-- dono da WABA — e essa coluna nunca existiu: conectar o canal oficial só
-- pedia phone_number_id/waba_id/token. Nullable porque toda instalação já
-- conectada continua funcionando pra texto/botão (só o header de IMAGEM
-- precisa do app_id) — reconectar o canal (mesma tela, "Trocar
-- credencial") preenche.
alter table public.channel_sessions
  add column if not exists meta_app_id text;

comment on column public.channel_sessions.meta_app_id is
  'App ID da Meta dono da WABA — necessário pra Resumable Upload API (imagem de cabeçalho de template). Nullable: canais conectados antes desta coluna continuam funcionando pra template sem imagem.';

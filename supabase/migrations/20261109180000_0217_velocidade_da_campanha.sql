-- 0217 — Velocidade do disparo escolhida por campanha.
--
-- Até aqui toda campanha andava no mesmo ritmo (1 mensagem, pausa de 5 s), herdado do WAHA.
-- Na API oficial o teto é o nível do número na Meta, então o operador escolhe: cuidadosa
-- (o ritmo de sempre, padrão), normal ou rápida. O ritmo em si vive em lib/campaigns/velocidade.ts.
--
-- Aditiva: linhas existentes ficam 'cuidadosa', ou seja, nenhuma campanha muda de ritmo.
-- Idempotente: com `add column if not exists`, o CHECK inline só nasce junto com a coluna.

alter table public.whatsapp_campaigns
  add column if not exists velocidade text not null default 'cuidadosa'
    check (velocidade in ('cuidadosa', 'normal', 'rapida'));

notify pgrst, 'reload schema';

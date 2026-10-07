-- ============================================================================
-- 0188 — fn_email_tem_conta(): a tela do convite para de fazer a pessoa adivinhar
--
-- ## O defeito, medido em produção (B'Laser Gravatá, 07/10)
--
-- A gerente recebeu o convite, clicou e a tela ofereceu DUAS portas: "Fazer
-- login" e "Ainda não tenho conta". Ela escolheu a segunda — razoável, já não
-- lembrava de ter criado conta 12 dias antes. A partir dali ficou presa PARA
-- SEMPRE, e nenhum convite novo resolvia:
--
--   1. o GoTrue, ao receber signup de e-mail JÁ cadastrado, devolve sucesso
--      ofuscado (anti-enumeração) e NÃO toca no usuário existente;
--   2. então o `invite_token` novo é descartado e o `user_metadata` continua
--      com o token da tentativa ANTERIOR — expirado havia 11 dias;
--   3. em `/auth/confirm`, `decidirConviteDoSignup` lê esse token velho, falha
--      FECHADA (correto — não se provisiona org com token inválido) e manda
--      para `/login?error=convite_invalido`.
--
-- O laço é perfeito: o caminho de "criar conta" nunca consegue atualizar os
-- dados de uma conta que já existe, então repetir o convite repete o erro.
--
-- ## O conserto é tirar a escolha, não melhorar o aviso
--
-- Explicar melhor o erro deixaria a armadilha no lugar. Quem sabe se o e-mail
-- já tem conta é o SERVIDOR — a pessoa não tem como saber, e não deveria
-- precisar. Com esta função, `/team/accept-invite/[token]` passa a renderizar
-- UMA porta só, a correta, e a escolha errada deixa de existir.
--
-- ## Por que isto não é um oráculo de enumeração
--
-- Exposta a `anon`, esta função diria "este e-mail tem conta?" para qualquer um
-- — exatamente o que a anti-enumeração do GoTrue evita. Por isso: `service_role`
-- e mais ninguém. E o único chamador é uma página que exige token de convite
-- com HMAC válido CONTENDO aquele e-mail — quem tem o token já sabe o e-mail,
-- porque o recebeu. Não se revela nada novo a quem já estava autorizado.
-- ============================================================================

create or replace function public.fn_email_tem_conta(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from auth.users u
    where lower(u.email) = lower(trim(p_email))
      and u.deleted_at is null
  );
$$;

-- Doutrina §9: função nasce exposta, e as três origens de EXECUTE precisam ser
-- revogadas. `authenticated` inclusive — o baseline tem
-- `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO authenticated`, e
-- aqui isso daria um oráculo de enumeração a qualquer usuário logado.
revoke execute on function public.fn_email_tem_conta(text) from public, anon, authenticated;
grant  execute on function public.fn_email_tem_conta(text) to service_role;

notify pgrst, 'reload schema';

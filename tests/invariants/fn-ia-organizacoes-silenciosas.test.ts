import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * Migration 0175 — `fn_ia_organizacoes_silenciosas`.
 *
 * Achado auditando o CHANGELOG do fornecedor e confirmado ao vivo em
 * produção: um agente de IA publicado e ATIVO pode ficar semanas sem
 * responder ninguém (versão publicada sem credencial, entre outras causas
 * estruturais) sem nenhum sinal em lugar nenhum — nem Central de avisos, nem
 * log que alguém leia rotineiramente. Esta função é o "quem está devido"
 * do watcher que fecha esse buraco.
 *
 * Dois motivos, cada um com seu par positivo/negativo:
 *   - sem_credencial: versão publicada sem credential_id — estrutural, não
 *     depende de tráfego nenhum pra ser um problema real.
 *   - sem_atividade: chegou mensagem de cliente e não há NENHUMA atividade
 *     correspondente (nem ai_agent_runs, nem ai_invocations) na mesma janela.
 */

const ORG_SEM_CRED = "ffff0000-0000-4000-8000-000000000001";
const ORG_SEM_ATIV = "ffff0000-0000-4000-8000-000000000002";
const ORG_COM_ATIV = "ffff0000-0000-4000-8000-000000000003";
const ORG_SEM_TRAFEGO = "ffff0000-0000-4000-8000-000000000004";
const ORG_NAO_PUBLICADO = "ffff0000-0000-4000-8000-000000000005";
const ORG_MSG_FRESCA = "ffff0000-0000-4000-8000-000000000006";

const CRED = "ffff1111-0000-4000-8000-000000000001";

function agentId(n: number): string {
  return `ffff2222-0000-4000-8000-00000000000${n}`;
}
function versionId(n: number): string {
  return `ffff3333-0000-4000-8000-00000000000${n}`;
}
function sessionId(n: number): string {
  return `ffff4444-0000-4000-8000-00000000000${n}`;
}
function contatoId(n: number): string {
  return `ffff5555-0000-4000-8000-00000000000${n}`;
}
function convId(n: number): string {
  return `ffff6666-0000-4000-8000-00000000000${n}`;
}

function organizacoesSilenciosas(janelaMinutos = 60): Array<{ org: string; motivo: string }> {
  const out = sql(`
    select organization_id || ':' || motivo
    from public.fn_ia_organizacoes_silenciosas(${janelaMinutos})
    order by 1;
  `);
  if (!out) return [];
  return out.split("\n").map((linha) => {
    const [org, motivo] = linha.split(":");
    return { org: org!, motivo: motivo! };
  });
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_SEM_CRED}', 'ia-sem-cred', 'Sem Credencial', 'Sem Credencial'),
      ('${ORG_SEM_ATIV}', 'ia-sem-ativ', 'Sem Atividade', 'Sem Atividade'),
      ('${ORG_COM_ATIV}', 'ia-com-ativ', 'Com Atividade', 'Com Atividade'),
      ('${ORG_SEM_TRAFEGO}', 'ia-sem-trafego', 'Sem Trafego', 'Sem Trafego'),
      ('${ORG_NAO_PUBLICADO}', 'ia-nao-pub', 'Nao Publicado', 'Nao Publicado'),
      ('${ORG_MSG_FRESCA}', 'ia-msg-fresca', 'Msg Fresca', 'Msg Fresca')
      on conflict do nothing;

    insert into public.ai_provider_credentials
      (id, organization_id, provider, label, api_key_encrypted, api_key_iv, api_key_tag, api_key_last4)
      values ('${CRED}', '${ORG_SEM_ATIV}', 'anthropic', 'Chave', '\\x01'::bytea, '\\x02'::bytea, '\\x03'::bytea, '0001')
      on conflict do nothing;

    insert into public.ai_agents (id, organization_id, name, system_prompt, is_active) values
      ('${agentId(1)}', '${ORG_SEM_CRED}', 'Agente', 'p', true),
      ('${agentId(2)}', '${ORG_SEM_ATIV}', 'Agente', 'p', true),
      ('${agentId(3)}', '${ORG_COM_ATIV}', 'Agente', 'p', true),
      ('${agentId(4)}', '${ORG_SEM_TRAFEGO}', 'Agente', 'p', true),
      ('${agentId(5)}', '${ORG_NAO_PUBLICADO}', 'Agente', 'p', true),
      ('${agentId(6)}', '${ORG_MSG_FRESCA}', 'Agente', 'p', true)
      on conflict do nothing;

    do $sess$ begin
      insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted) values
        ('${sessionId(1)}', '${ORG_SEM_CRED}', 's1', '\\x00'::bytea),
        ('${sessionId(2)}', '${ORG_SEM_ATIV}', 's2', '\\x00'::bytea),
        ('${sessionId(3)}', '${ORG_COM_ATIV}', 's3', '\\x00'::bytea),
        ('${sessionId(4)}', '${ORG_SEM_TRAFEGO}', 's4', '\\x00'::bytea),
        ('${sessionId(6)}', '${ORG_MSG_FRESCA}', 's6', '\\x00'::bytea);
    exception when unique_violation then null; end $sess$;

    insert into public.ai_agent_versions
      (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, credential_id, status)
      values
        ('${versionId(1)}', '${ORG_SEM_CRED}', '${agentId(1)}', 1, 'p', 'anthropic', 'claude-sonnet-4-6', '${sessionId(1)}', null, 'published'),
        ('${versionId(2)}', '${ORG_SEM_ATIV}', '${agentId(2)}', 1, 'p', 'anthropic', 'claude-sonnet-4-6', '${sessionId(2)}', '${CRED}', 'published'),
        ('${versionId(3)}', '${ORG_COM_ATIV}', '${agentId(3)}', 1, 'p', 'anthropic', 'claude-sonnet-4-6', '${sessionId(3)}', '${CRED}', 'published'),
        ('${versionId(4)}', '${ORG_SEM_TRAFEGO}', '${agentId(4)}', 1, 'p', 'anthropic', 'claude-sonnet-4-6', '${sessionId(4)}', '${CRED}', 'published'),
        ('${versionId(6)}', '${ORG_MSG_FRESCA}', '${agentId(6)}', 1, 'p', 'anthropic', 'claude-sonnet-4-6', '${sessionId(6)}', '${CRED}', 'published')
      on conflict do nothing;

    -- ORG_NAO_PUBLICADO nunca recebe published_version_id — fica como rascunho.
    update public.ai_agents set published_version_id = '${versionId(1)}' where id = '${agentId(1)}';
    update public.ai_agents set published_version_id = '${versionId(2)}' where id = '${agentId(2)}';
    update public.ai_agents set published_version_id = '${versionId(3)}' where id = '${agentId(3)}';
    update public.ai_agents set published_version_id = '${versionId(4)}' where id = '${agentId(4)}';
    update public.ai_agents set published_version_id = '${versionId(6)}' where id = '${agentId(6)}';

    insert into public.contacts (id, organization_id) values
      ('${contatoId(2)}', '${ORG_SEM_ATIV}'),
      ('${contatoId(3)}', '${ORG_COM_ATIV}'),
      ('${contatoId(6)}', '${ORG_MSG_FRESCA}')
      on conflict do nothing;

    insert into public.conversations (id, organization_id, contact_id, channel_session_id) values
      ('${convId(2)}', '${ORG_SEM_ATIV}', '${contatoId(2)}', '${sessionId(2)}'),
      ('${convId(3)}', '${ORG_COM_ATIV}', '${contatoId(3)}', '${sessionId(3)}'),
      ('${convId(6)}', '${ORG_MSG_FRESCA}', '${contatoId(6)}', '${sessionId(6)}')
      on conflict do nothing;

    -- ORG_SEM_ATIV: mensagem de cliente há 20min, NENHUMA atividade depois. Silêncio de verdade.
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, sent_at, created_at)
      values ('${ORG_SEM_ATIV}', '${convId(2)}', '${sessionId(2)}', '${contatoId(2)}', 'text', 'inbound', 'received', 'system', now() - interval '20 minutes', now() - interval '20 minutes');

    -- ORG_COM_ATIV: mensagem de cliente há 20min, E uma execução registrada depois dela. Não é silêncio.
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, sent_at, created_at)
      values ('${ORG_COM_ATIV}', '${convId(3)}', '${sessionId(3)}', '${contatoId(3)}', 'text', 'inbound', 'received', 'system', now() - interval '20 minutes', now() - interval '20 minutes');
    insert into public.ai_agent_runs
      (id, organization_id, agent_id, agent_version_id, status, tokens_in, tokens_out, cost_cents, steps_count, tool_calls, is_dry_run, started_at, created_at)
      values (gen_random_uuid(), '${ORG_COM_ATIV}', '${agentId(3)}', '${versionId(3)}', 'completed', 0, 0, 0, 1, '[]'::jsonb, false, now() - interval '10 minutes', now() - interval '10 minutes');

    -- ORG_MSG_FRESCA: mensagem de cliente há só 2min — dentro da carência de 5min, não conta ainda.
    insert into public.messages
      (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, sent_via, sent_at, created_at)
      values ('${ORG_MSG_FRESCA}', '${convId(6)}', '${sessionId(6)}', '${contatoId(6)}', 'text', 'inbound', 'received', 'system', now() - interval '2 minutes', now() - interval '2 minutes');
  `);
});

describe("fn_ia_organizacoes_silenciosas", () => {
  it("⭐ versão publicada sem credencial aparece como sem_credencial, mesmo sem nenhum tráfego", () => {
    const linhas = organizacoesSilenciosas();
    expect(linhas).toContainEqual({ org: ORG_SEM_CRED, motivo: "sem_credencial" });
  });

  it("⭐ mensagem de cliente sem NENHUMA atividade correspondente aparece como sem_atividade", () => {
    const linhas = organizacoesSilenciosas();
    expect(linhas).toContainEqual({ org: ORG_SEM_ATIV, motivo: "sem_atividade" });
  });

  it("CONTROLE: organização com execução registrada depois da mensagem NÃO aparece", () => {
    const linhas = organizacoesSilenciosas();
    expect(linhas.some((l) => l.org === ORG_COM_ATIV)).toBe(false);
  });

  it("CONTROLE: organização sem nenhum tráfego recente NÃO aparece (nada a responder)", () => {
    const linhas = organizacoesSilenciosas();
    expect(linhas.some((l) => l.org === ORG_SEM_TRAFEGO)).toBe(false);
  });

  it("CONTROLE: agente sem versão publicada NÃO aparece (não é dono de resposta nenhuma)", () => {
    const linhas = organizacoesSilenciosas();
    expect(linhas.some((l) => l.org === ORG_NAO_PUBLICADO)).toBe(false);
  });

  it("CONTROLE: mensagem com menos de 5min NÃO aparece ainda (carência do pipeline assíncrono)", () => {
    const linhas = organizacoesSilenciosas();
    expect(linhas.some((l) => l.org === ORG_MSG_FRESCA)).toBe(false);
  });

  it("CONTROLE: função revogada de public/anon (issue #128, hardening-definer)", () => {
    const out = sql(`
      select has_function_privilege('anon', 'public.fn_ia_organizacoes_silenciosas(int)', 'execute');
    `);
    expect(out.trim()).toBe("f");
  });
});

import { describe, it, expect, beforeAll } from "vitest";

import { GOV_ORG, seedGov, sql } from "./gov-helpers";

/**
 * `fn_saude_das_clinicas()` (migration 0186) — o painel cross-tenant.
 *
 * A classificação (o que é "crítico") é função pura e tem teste próprio em
 * `lib/admin/saude-das-clinicas.test.ts`. O que se prova AQUI é o que só o
 * banco pode responder: a função devolve uma linha por organização viva,
 * inclusive as vazias, e não devolve as anonimizadas.
 */

/**
 * Namespace PRÓPRIO (`5a0de5a0` = "saude"), não o `dddddddd` genérico: aquele
 * já é usado por 5 outros arquivos de invariante, e o banco efêmero é
 * COMPARTILHADO entre os arquivos que rodam em paralelo. Reusar o namespace
 * faria a "organização vazia" deste teste nascer com os canais que outro
 * arquivo criou — que é exatamente a família de corrida que já assombra esta
 * suíte (`platform_admins_granted_by_fkey`).
 */
const ORG_VAZIA = "5a0de5a0-0000-4000-8000-000000000001";
const ORG_REDIGIDA = "5a0de5a0-0000-4000-8000-000000000002";

interface LinhaDeSaude {
  organization_id: string;
  display_name: string;
  canais_total: number;
  canais_working: number;
  agentes_publicados: number;
  credenciais_ia_ativas: number;
  mensagens_falhas_24h: number;
  eventos_mortos_7d: number;
  avisos_abertos: number;
}

function chamaFuncao(): LinhaDeSaude[] {
  const out = sql(
    `select coalesce(json_agg(t), '[]') from (select * from public.fn_saude_das_clinicas()) t;`,
  );
  return JSON.parse(out) as LinhaDeSaude[];
}

describe("fn_saude_das_clinicas — painel de saúde cross-tenant (migration 0186)", () => {
  beforeAll(() => {
    seedGov();
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${ORG_VAZIA}', 'org-vazia-saude', 'Org Vazia', 'Org Vazia')
        on conflict do nothing;
      insert into public.organizations (id, slug, legal_name, display_name, redacted_at)
        values ('${ORG_REDIGIDA}', 'org-redigida-saude', 'Org Redigida', 'Org Redigida', now())
        on conflict do nothing;
    `);
  });

  it("devolve a organização semeada com os canais dela contados", () => {
    const linha = chamaFuncao().find((l) => l.organization_id === GOV_ORG);

    expect(linha, "a organização de teste tem que aparecer no painel").toBeDefined();
    // `seedGov` cria pelo menos uma channel_session. Só o piso é afirmado: o
    // banco efêmero é compartilhado com os outros arquivos em paralelo, e
    // vários semeiam sessões na MESMA GOV_ORG — número exato aqui seria um
    // teste que falha por causa do vizinho, não por causa do código.
    expect(linha!.canais_total).toBeGreaterThanOrEqual(1);
    expect(linha!.canais_working).toBeLessThanOrEqual(linha!.canais_total);
  });

  it("⭐ organização SEM nada ainda aparece, com zeros — não some da lista", () => {
    // O `left join lateral` existe por isto: clínica recém-criada, sem canal,
    // sem agente, sem mensagem, é exatamente a que precisa ser vista (está
    // pela metade). Se sumisse do painel, ninguém iria socorrê-la.
    const linha = chamaFuncao().find((l) => l.organization_id === ORG_VAZIA);

    expect(linha, "organização vazia NÃO pode sumir do painel").toBeDefined();
    expect(linha!.canais_total).toBe(0);
    expect(linha!.agentes_publicados).toBe(0);
    expect(linha!.credenciais_ia_ativas).toBe(0);
    expect(linha!.mensagens_falhas_24h).toBe(0);
    expect(linha!.eventos_mortos_7d).toBe(0);
    expect(linha!.avisos_abertos).toBe(0);
  });

  it("organização anonimizada por LGPD fica FORA (não é operação viva)", () => {
    const ids = chamaFuncao().map((l) => l.organization_id);

    expect(ids).not.toContain(ORG_REDIGIDA);
    expect(ids).toContain(ORG_VAZIA); // controle: a exclusão é pelo redacted_at, não geral
  });

  it("guarda de vacuidade: a função devolve linhas (instrumento não está cego)", () => {
    // Sem isto, um `from` errado devolvendo zero linhas faria as asserções de
    // ausência acima passarem por vacuidade.
    expect(chamaFuncao().length).toBeGreaterThanOrEqual(2);
  });

  it("não é executável por anon nem por authenticated (doutrina §9)", () => {
    const anon = sql(
      `select has_function_privilege('anon', 'public.fn_saude_das_clinicas()', 'execute');`,
    );
    const auth = sql(
      `select has_function_privilege('authenticated', 'public.fn_saude_das_clinicas()', 'execute');`,
    );
    expect(anon).toBe("f");
    expect(auth).toBe("f");
  });
});

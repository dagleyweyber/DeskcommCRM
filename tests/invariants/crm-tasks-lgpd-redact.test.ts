import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * ANONIMIZAR UM CONTATO APAGA O TEXTO DAS TAREFAS DELE — E PRESERVA A OPERAÇÃO.
 *
 * `crm_tasks` (migration 0179) guarda `title`, que na prática é "Ligar para
 * Fulano confirmar o orçamento". Sem o trigger `trg_redigir_tarefas_ao_anonimizar`,
 * anonimizar devolveria SUCESSO, o SLA de D+15 seria marcado como cumprido, e o
 * nome de quem exerceu o direito de apagamento continuaria legível no banco.
 *
 * Namespace PRÓPRIO (não GOV_ORG/GOV_CONTACT_*): este teste chama a cascata
 * REAL de anonimização, que redige em cascata várias tabelas da organização —
 * rodar isso contra os fixtures compartilhados corromperia outros arquivos que
 * dependem deles continuarem legíveis.
 */

const ORG = "eeee0000-0000-4000-8000-00000000000a";
const DONO = "eeee0000-1111-4000-8000-000000000001";
const ALVO = "eeee0000-2222-4000-8000-000000000001";
const VIZINHO = "eeee0000-2222-4000-8000-000000000002";

function campo(contato: string, coluna: string): string {
  return sql(
    `select coalesce(${coluna}::text, '<null>') from public.crm_tasks where contact_id = '${contato}' limit 1;`,
  );
}

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${DONO}', 'lgpd-tarefa@invariant.test')
      on conflict (id) do nothing;
  `);
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'tarefa-lgpd-0179', 'Tarefa LGPD 0179', 'Tarefa LGPD 0179')
      on conflict do nothing;
    insert into public.contacts (id, organization_id, name) values
      ('${ALVO}',    '${ORG}', 'Maria Silva'),
      ('${VIZINHO}', '${ORG}', 'Joao Pereira')
      on conflict do nothing;
  `);
  for (const contato of [ALVO, VIZINHO]) {
    sql(`
      insert into public.crm_tasks
        (organization_id, contact_id, created_by, title, description, due_date, priority, status)
      select '${ORG}', '${contato}', '${DONO}',
             'Ligar para ' || c.name || ' confirmar o orcamento',
             'telefone do trabalho, falar com a irma dela',
             '2026-10-10 14:00:00+00', 'high', 'done'
        from public.contacts c
       where c.id = '${contato}'
         and not exists (select 1 from public.crm_tasks t where t.contact_id = '${contato}');
    `);
  }
});

describe("a anonimização de LGPD alcança as tarefas do contato", () => {
  it("ANTES: o nome está legível na tarefa (controle positivo)", () => {
    expect(campo(ALVO, "title")).toContain("Maria");
    expect(campo(ALVO, "description")).toContain("irma dela");
  });

  it("anonimizar o contato apaga o texto livre da tarefa", () => {
    // Chama a FUNÇÃO REAL da cascata, não um `update is_anonymized` à mão: é o
    // caminho por onde a anonimização de verdade passa, e o trigger dispara
    // DENTRO da transação dela.
    sql(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${ALVO}', gen_random_uuid());`);
    expect(campo(ALVO, "title")).toBe("Tarefa anonimizada");
    expect(campo(ALVO, "description")).toBe("<null>");
  });

  it("...e PRESERVA o que é operação: prazo, situação e prioridade", () => {
    expect(campo(ALVO, "due_date")).toContain("2026-10-10");
    expect(campo(ALVO, "status")).toBe("done");
    expect(campo(ALVO, "priority")).toBe("high");
  });

  it("a tarefa de OUTRO contato não é tocada", () => {
    expect(campo(VIZINHO, "title")).toContain("Joao");
    expect(campo(VIZINHO, "description")).toContain("irma dela");
  });
});

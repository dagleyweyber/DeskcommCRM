"use server";

/**
 * Server Action: finalize onboarding — stamps `onboarded_at`, audits, and
 * emits the `tenant.onboarded` domain event. Idempotent: only fires the
 * event the first time `onboarded_at` flips from NULL.
 *
 * GATE DE PRONTIDÃO (item 4 do plano de escala): antes desta correção, este
 * Server Action marcava `onboarded_at` sem checar NADA. Foi exatamente esse
 * buraco que deixou B'Laser Caruaru e RevitaFio Carpina terminarem o cadastro
 * com o Atendente de IA publicado e SEM credencial válida — semanas de
 * silêncio, sem nenhum aviso. A régua de bloqueio (o quê e o porquê) mora em
 * `lib/onboarding/prontidao.ts`, pura e testada — aqui só busca o fato
 * (mesma `fn_saude_das_clinicas()` que alimenta o painel e o vigia) e aplica.
 */
import { redirect } from "next/navigation";

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { pendenciasParaConcluir, type PendenciaCritica } from "@/lib/onboarding/prontidao";
import { requireOnboardingCtx, OnboardingError } from "./_shared";

export type FinishOnboardingResult =
  | { ok: true; alreadyOnboarded: boolean }
  | {
      ok: false;
      error: "auth_required" | "no_active_org" | "db_error";
      details?: unknown;
    }
  | { ok: false; error: "pendencias_criticas"; pendencias: PendenciaCritica[] };

export async function finishOnboarding(): Promise<FinishOnboardingResult> {
  let ctx;
  try {
    ctx = await requireOnboardingCtx();
  } catch (err) {
    if (err instanceof OnboardingError) return { ok: false, error: err.code as never };
    throw err;
  }

  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("organizations")
    .select("onboarded_at")
    .eq("id", ctx.orgId)
    .maybeSingle();

  const alreadyOnboarded = Boolean(existing?.onboarded_at);

  if (!alreadyOnboarded) {
    // GATE. `p_tipos_acionaveis: []` de propósito: o gate só olha canal/IA,
    // nunca `fila_pendente_desde` — não tem sentido cobrar "fila atrasada" de
    // uma clínica que ainda não existia há 5 minutos.
    const { data: linhas, error: erroSaude } = await admin.rpc(
      "fn_saude_das_clinicas" as never,
      { p_tipos_acionaveis: [] } as never,
    );
    if (erroSaude) return { ok: false, error: "db_error", details: erroSaude.message };

    const sinais = (
      (linhas ?? []) as Array<{
        organization_id: string;
        canais_working: number;
        agentes_publicados: number;
        credenciais_ia_ativas: number;
      }>
    ).find((l) => l.organization_id === ctx.orgId);

    // Linha ausente seria a própria organização não existir mais — não é o
    // caso de "sem pendência", é erro genuíno; não deixa passar silencioso.
    if (!sinais) return { ok: false, error: "db_error", details: "organizacao_nao_encontrada" };

    const pendencias = pendenciasParaConcluir(sinais);
    if (pendencias.length > 0) {
      return { ok: false, error: "pendencias_criticas", pendencias };
    }

    const { error } = await admin
      .from("organizations")
      .update({ onboarded_at: new Date().toISOString() })
      .eq("id", ctx.orgId)
      .is("onboarded_at", null);
    if (error) return { ok: false, error: "db_error", details: error.message };

    await admin.from("event_log").insert({
      organization_id: ctx.orgId,
      event_type: "tenant.onboarded",
      payload: { completed_by: ctx.userId },
    });

    await audit({
      action: "onboarding.completed",
      actorUserId: ctx.userId,
      organizationId: ctx.orgId,
    });
    await audit({
      action: "tenant.onboarded",
      actorUserId: ctx.userId,
      organizationId: ctx.orgId,
    });
  }

  redirect("/app/inbox");
}

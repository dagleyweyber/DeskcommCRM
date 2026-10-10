"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { finishOnboarding } from "@/app/actions/onboarding/finishOnboarding";
import type { PendenciaCritica } from "@/lib/onboarding/prontidao";

/**
 * Pra onde mandar a pessoa CONSERTAR cada pendência — não é só avisar o que
 * falta, é apontar o caminho de volta. Lista fechada (não genérica) de
 * propósito: se `pendenciasParaConcluir` ganhar um motivo novo sem entrada
 * aqui, o TypeScript acusa em build, não em produção.
 */
const CAMINHO_DA_PENDENCIA: Record<PendenciaCritica["motivo"], { href: string; rotulo: string }> = {
  sem_canal_funcionando: { href: "/onboarding/connect-whatsapp", rotulo: "Conectar WhatsApp" },
  ia_sem_credencial: { href: "/onboarding/setup-ai", rotulo: "Configurar credencial de IA" },
};

interface Recap {
  welcome: boolean;
  whatsapp: boolean;
  nuvemshop: boolean;
  ai: boolean;
  team: boolean;
}

const ITEMS: { key: keyof Recap; label: string }[] = [
  { key: "welcome", label: "Boas-vindas e termos" },
  { key: "whatsapp", label: "Canal WhatsApp" },
  { key: "nuvemshop", label: "Loja Nuvemshop" },
  { key: "ai", label: "Atendente IA" },
  { key: "team", label: "Convites de time" },
];

export function DoneClient({ recap }: { recap: Recap }) {
  const [pending, startTransition] = useTransition();
  const [pendencias, setPendencias] = useState<PendenciaCritica[] | null>(null);

  return (
    <div className="space-y-6 rounded-lg border bg-background p-6 text-center">
      <h2 className="text-2xl font-semibold tracking-tight">
        {pendencias ? "Quase lá" : "Tudo pronto!"}
      </h2>
      <p className="text-sm text-muted-foreground">
        {pendencias
          ? "Duas coisas puladas aqui não dá pra deixar pra depois — sem elas, o atendimento fica mudo sem ninguém perceber."
          : "Sua operação está configurada. Você pode ajustar tudo nas Configurações."}
      </p>

      {!pendencias && (
        <ul className="mx-auto max-w-sm space-y-2 text-left text-sm">
          {ITEMS.map((it) => {
            const done = recap[it.key];
            return (
              <li key={it.key} className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={
                    "inline-block h-2 w-2 rounded-full " +
                    (done ? "bg-emerald-500" : "bg-muted-foreground/30")
                  }
                />
                <span className={done ? "" : "text-muted-foreground"}>
                  {it.label} {done ? "" : "(pulado)"}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {/* Lista fechada, nunca genérica: cada pendência aponta o caminho de
          volta pra tela certa — "falta algo" sem link é beco sem saída. */}
      {pendencias && (
        <ul className="mx-auto max-w-sm space-y-3 text-left text-sm" role="alert">
          {pendencias.map((p) => (
            <li key={p.motivo} className="rounded-md border border-amber-300/60 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-950/20">
              <p>{p.mensagem}</p>
              <Link
                href={CAMINHO_DA_PENDENCIA[p.motivo].href}
                className="mt-1.5 inline-block font-medium text-foreground underline underline-offset-4"
              >
                {CAMINHO_DA_PENDENCIA[p.motivo].rotulo} →
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const res = await finishOnboarding();
            if (res && !res.ok) {
              if (res.error === "pendencias_criticas") {
                setPendencias(res.pendencias);
                return;
              }
              toast.error(`Falha: ${res.error}`);
            }
          })
        }
      >
        {pending ? "Finalizando..." : pendencias ? "Já resolvi, tentar de novo" : "Ir para o Inbox"}
      </Button>
    </div>
  );
}

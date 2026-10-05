"use client";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useCriarTipoDeCompromisso, useEventTypes } from "@/hooks/agenda/useEventTypes";

function slugifica(nome: string): string {
  return nome
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export function EventTypesClient() {
  const { data: tipos, isLoading } = useEventTypes();
  const criar = useCriarTipoDeCompromisso();

  const [nome, setNome] = useState("");
  const [duracao, setDuracao] = useState(30);

  async function adicionar() {
    if (nome.trim().length < 2) return;
    try {
      await criar.mutateAsync({ name: nome.trim(), slug: slugifica(nome), duration_minutes: duracao });
      toast.success("Tipo de compromisso criado.");
      setNome("");
      setDuracao(30);
    } catch (err) {
      showApiError(err);
    }
  }

  return (
    <div className="max-w-xl space-y-6">
      <Card>
        <CardContent className="flex items-end gap-3 pt-6">
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="novo-tipo-nome">Nome</Label>
            <Input
              id="novo-tipo-nome"
              placeholder="Ex.: Avaliação"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
            />
          </div>
          <div className="w-28 space-y-1.5">
            <Label htmlFor="novo-tipo-duracao">Duração (min)</Label>
            <Input
              id="novo-tipo-duracao"
              type="number"
              min={5}
              max={480}
              value={duracao}
              onChange={(e) => setDuracao(Number(e.target.value))}
            />
          </div>
          <Button disabled={criar.isPending || nome.trim().length < 2} onClick={() => void adicionar()}>
            Adicionar
          </Button>
        </CardContent>
      </Card>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Carregando…</p>
      ) : (tipos ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum tipo de compromisso ainda.</p>
      ) : (
        <ul className="space-y-2">
          {(tipos ?? []).map((t) => (
            <li key={t.id} className="flex items-center justify-between rounded-md border px-3 py-2">
              <span className="text-sm font-medium">{t.name}</span>
              <span className="text-xs text-muted-foreground">{t.duration_minutes}min</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

"use client";
import { useState } from "react";
import Link from "next/link";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { MessageTemplate } from "@/hooks/inbox/useMessageTemplates";

/**
 * Filtro da lista: título, atalho OU texto — quem procura "preço" acha o script
 * que fala de preço mesmo sem lembrar o título. Sem acento nem caixa. Puro (testável).
 */
export function filtrarRespostas(templates: MessageTemplate[], busca: string): MessageTemplate[] {
  const norm = (v: string) =>
    v
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase();
  const q = norm(busca.trim());
  if (!q) return templates;
  return templates.filter((t) => norm(t.title).includes(q) || norm(t.shortcut ?? "").includes(q) || norm(t.body).includes(q));
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: MessageTemplate[];
  carregando?: boolean;
  onPick: (t: MessageTemplate) => void;
  /** Devolve o foco ao campo de mensagem ao fechar (em vez de ao botão "+"). */
  onFechar?: () => void;
}

/**
 * "Respostas rápidas" aberto pelo menu "+" do composer. É a MESMA lista que o
 * atalho "/" já mostrava — só que alcançável com o mouse, que é como a maior
 * parte das atendentes trabalha (e quem não sabe que o "/" existe nunca a achava).
 */
export function RespostasRapidasDialog({ open, onOpenChange, templates, carregando, onPick, onFechar }: Props) {
  const [busca, setBusca] = useState("");
  const lista = filtrarRespostas(templates, busca);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setBusca("");
        onOpenChange(v);
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        onCloseAutoFocus={(e) => {
          if (onFechar) {
            e.preventDefault();
            onFechar();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Respostas rápidas</DialogTitle>
          <DialogDescription>
            Escolha um script: o texto vai para o campo de mensagem, com o nome do contato, para você revisar e enviar.
          </DialogDescription>
        </DialogHeader>
        <Input autoFocus placeholder="Buscar por título, atalho ou texto…" aria-label="Buscar resposta rápida" value={busca} onChange={(e) => setBusca(e.target.value)} />
        <div className="max-h-80 overflow-y-auto rounded-md border" role="listbox" aria-label="Respostas rápidas">
          {carregando ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">Carregando…</p>
          ) : lista.length === 0 ? (
            <p className="px-3 py-4 text-sm text-muted-foreground">
              {templates.length === 0 ? (
                <>
                  Nenhuma resposta rápida ainda.{" "}
                  <Link href="/app/templates" className="underline">
                    Crie a primeira
                  </Link>
                  .
                </>
              ) : (
                "Nenhuma resposta encontrada para essa busca."
              )}
            </p>
          ) : (
            <ul className="divide-y">
              {lista.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                    onClick={() => onPick(t)}
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="text-sm font-medium">{t.title}</span>
                      {t.shortcut && <span className="shrink-0 rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">/{t.shortcut}</span>}
                    </span>
                    <span className="line-clamp-2 text-xs text-muted-foreground">{t.body}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Dica: digitar <kbd className="rounded border px-1">/</kbd> no campo de mensagem abre esta mesma lista.{" "}
          <Link href="/app/templates" className="underline">
            Gerenciar respostas rápidas
          </Link>
        </p>
      </DialogContent>
    </Dialog>
  );
}

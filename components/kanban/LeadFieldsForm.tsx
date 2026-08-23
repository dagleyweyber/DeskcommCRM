"use client";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useEditLead } from "@/hooks/kanban/useUpdateLead";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useServiceOptions } from "@/hooks/pipelines/useServiceOptions";
import { useContact } from "@/hooks/contacts/useContact";
import { useCreateContact } from "@/hooks/contacts/useCreateContact";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import type { Lead } from "@/lib/types/leads";
import { updateLeadSchema, type UpdateLeadInput } from "@/lib/schemas/leads";
import { LEAD_SOURCES, NO_OWNER, normalizePhoneBR } from "@/lib/leads/lead-form-shared";
import { parseReaisToCents } from "@/lib/money";
import { EcoDoValor } from "./EcoDoValor";

interface FormShape {
  title: string;
  description: string;
  valueReais: string;
  tagsRaw: string;
  expected_close_date: string;
  source: string;
  produtoInteresse: string;
  phone: string;
  email: string;
  owner_user_id: string;
}

interface Props {
  lead: Lead;
  pipelineId: string;
  /** Quando o salvamento dá certo. O dossiê NÃO fecha aqui — ver abaixo. */
  onSaved?: () => void;
  /** O dossiê não tem "cancelar"; o diálogo tem. */
  onCancel?: () => void;
}

function centsToReais(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  return (cents / 100).toFixed(2).replace(".", ",");
}

function produtoInteresseDe(customFields: Record<string, unknown> | null | undefined): string {
  const v = customFields?.produto_interesse;
  return typeof v === "string" ? v : "";
}

/**
 * Os campos do lead — extraídos do `EditLeadDialog` para o dossiê usar os
 * MESMOS, em vez de uma cópia que diverge no mês.
 *
 * `onSaved` existe para o dossiê NÃO FECHAR ao salvar: quem edita precisa ver a
 * atividade que acabou de gerar entrar na timeline. Fechar esconderia o
 * registro justamente de quem o produziu — a funcionalidade que prova "sua ação
 * fica registrada" provaria isso para todo mundo menos para o autor.
 *
 * E-mail/telefone NÃO são coluna do lead — moram no `contacts` vinculado por
 * `contact_id` (DIRC: referenciar, não duplicar). Por isso viajam por uma
 * mutação separada (`useUpdateContact`/`useCreateContact`), não pelo PATCH do
 * lead. Lead sem contato ainda (`contact_id null`) cria um na hora, espelhando
 * o mesmo caminho do `NewLeadDialog`.
 *
 * Atendente só entra no `patch` quando o valor do <Select> DIFERE do dono
 * atual do lead — nunca "sempre que o form é enviado". `owner_user_id`
 * explícito sempre resolve para dono HUMANO (lib/leads/owner-patch.ts), então
 * mandar o mesmo valor à toa num lead hoje dono de um AGENTE de IA tomaria a
 * posse dele sem ninguém ter pedido — o mesmo cuidado que o menu "Responsável"
 * do card já tem, só que aqui por comparação em vez de ação direta no clique.
 */
export function LeadFieldsForm({ lead, pipelineId, onSaved, onCancel }: Props) {
  const edit = useEditLead(pipelineId);
  const createContact = useCreateContact();
  const updateContact = useUpdateContact(lead.contact_id ?? "");
  const contact = useContact(lead.contact_id ?? "");
  const { data: members } = useAssignableMembers(true);
  const { data: serviceOptionsRes } = useServiceOptions(pipelineId);
  const serviceOptions = serviceOptionsRes?.data.service_options ?? [];

  const form = useForm<FormShape>({
    defaultValues: {
      title: lead.title,
      description: lead.description ?? "",
      valueReais: centsToReais(lead.value_cents),
      tagsRaw: (lead.tags ?? []).join(", "),
      expected_close_date: lead.expected_close_date ?? "",
      source: lead.source,
      produtoInteresse: produtoInteresseDe(lead.custom_fields),
      phone: "",
      email: "",
      owner_user_id: lead.owner_user_id ?? NO_OWNER,
    },
  });

  useEffect(() => {
    form.reset({
      title: lead.title,
      description: lead.description ?? "",
      valueReais: centsToReais(lead.value_cents),
      tagsRaw: (lead.tags ?? []).join(", "),
      expected_close_date: lead.expected_close_date ?? "",
      source: lead.source,
      produtoInteresse: produtoInteresseDe(lead.custom_fields),
      phone: "",
      email: "",
      owner_user_id: lead.owner_user_id ?? NO_OWNER,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead.id]);

  // Telefone/e-mail chegam depois, num fetch à parte (o contato é outra
  // tabela) — por isso um efeito próprio, que só preenche os DOIS campos dele
  // e não mexe no resto do form enquanto a pessoa já pode estar editando.
  useEffect(() => {
    const c = contact.data?.data;
    if (c) {
      form.setValue("email", c.email ?? "");
      form.setValue("phone", c.phone_number ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead.id, contact.data]);

  async function onSubmit(values: FormShape) {
    const tags = values.tagsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const reais = values.valueReais.trim();
    let valueCents: number | null = null;
    if (reais.length > 0) {
      valueCents = parseReaisToCents(reais);
      if (valueCents === null) {
        form.setError("valueReais", { message: "Valor inválido" });
        return;
      }
    }

    let phoneE164: string | null = null;
    if (values.phone.trim()) {
      phoneE164 = normalizePhoneBR(values.phone);
      if (!phoneE164) {
        form.setError("phone", { message: "Telefone inválido" });
        return;
      }
    }

    const patch: Record<string, unknown> = {
      title: values.title.trim(),
      description: values.description.trim() ? values.description.trim() : null,
      value_cents: valueCents,
      tags,
      expected_close_date: values.expected_close_date || null,
      source: values.source,
      // Mescla com o que já existia: `custom_fields` é substituído inteiro no
      // handler, não mesclado no servidor — mandar só produto_interesse
      // apagaria silenciosamente qualquer outro campo dinâmico do pipeline.
      custom_fields: { ...lead.custom_fields, produto_interesse: values.produtoInteresse.trim() },
    };

    // Só entra no patch se a pessoa MEXEU no seletor — ver o porquê no
    // comentário da função acima (não pisar em dono-agente por omissão).
    const ownerAtual = lead.owner_user_id ?? NO_OWNER;
    if (values.owner_user_id !== ownerAtual) {
      patch.owner_user_id = values.owner_user_id === NO_OWNER ? null : values.owner_user_id;
    }

    // Contato é recurso à parte (DIRC: referenciar). Lead com contato existente
    // tem o e-mail/telefone corrigidos nele; lead ainda sem contato ganha um
    // agora, do mesmo jeito que o NewLeadDialog cria na criação.
    if (lead.contact_id) {
      const current = contact.data?.data;
      const emailChanged = values.email.trim() !== (current?.email ?? "");
      const phoneChanged = phoneE164 !== (current?.phone_number ?? null);
      if (emailChanged || phoneChanged) {
        try {
          await updateContact.mutateAsync({
            email: values.email.trim() || undefined,
            phone_number: phoneE164 ?? undefined,
          });
        } catch {
          // erro já mostrado pelo toast do hook; não bloqueia o resto do salvamento
        }
      }
    } else if (values.email.trim() || phoneE164) {
      try {
        const res = await createContact.mutateAsync({
          name: values.title.trim() || undefined,
          email: values.email.trim() || undefined,
          phone_number: phoneE164 ?? undefined,
          source: values.source,
        });
        patch.contact_id = res.data.id;
      } catch {
        // erro já mostrado pelo toast do hook; segue sem vincular contato
      }
    }

    const parsed = updateLeadSchema.safeParse(patch);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      toast.error(first?.message ?? "Dados inválidos");
      return;
    }

    try {
      await edit.mutateAsync({
        leadId: lead.id,
        patch: parsed.data as UpdateLeadInput,
      });
      toast.success("Lead atualizado");
      onSaved?.();
    } catch {
      // toast already shown
    }
  }

  const source = form.watch("source");
  const ownerUserId = form.watch("owner_user_id");
  const produtoInteresse = form.watch("produtoInteresse");
  const busy = edit.isPending || createContact.isPending || updateContact.isPending;

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="title">Título</Label>
          <Input
            id="title"
            {...form.register("title", { required: true, minLength: 2 })}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="phone">Telefone</Label>
            <Input id="phone" inputMode="tel" placeholder="(11) 98765-4321" {...form.register("phone")} />
            {form.formState.errors.phone && (
              <p className="text-xs text-error-fg">{form.formState.errors.phone.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">E-mail</Label>
            <Input id="email" type="email" placeholder="cliente@exemplo.com" {...form.register("email")} />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="description">Descrição</Label>
          <Textarea id="description" rows={3} {...form.register("description")} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>Atendente</Label>
            <Select value={ownerUserId} onValueChange={(v) => form.setValue("owner_user_id", v)}>
              <SelectTrigger>
                <SelectValue placeholder="Sem atendente" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_OWNER}>Sem atendente</SelectItem>
                {(members ?? []).map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.full_name ?? "Sem nome"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="produtoInteresse">Produto de interesse</Label>
            {serviceOptions.length > 0 ? (
              <Select
                value={produtoInteresse}
                onValueChange={(v) => form.setValue("produtoInteresse", v)}
              >
                <SelectTrigger id="produtoInteresse">
                  <SelectValue placeholder="Selecione o serviço" />
                </SelectTrigger>
                <SelectContent>
                  {/* Lead com valor livre de antes da lista existir (ou digitado fora dela)
                      continua aparecendo e sendo preservado — não é apagado por já não
                      bater com nenhuma opção configurada agora. */}
                  {produtoInteresse && !serviceOptions.includes(produtoInteresse) && (
                    <SelectItem value={produtoInteresse}>{produtoInteresse}</SelectItem>
                  )}
                  {serviceOptions.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input id="produtoInteresse" placeholder="Ex: Combo Presente" {...form.register("produtoInteresse")} />
            )}
          </div>
        </div>

        <div className="space-y-2">
          <Label>Origem do lead</Label>
          <Select value={source} onValueChange={(v) => form.setValue("source", v)}>
            <SelectTrigger>
              <SelectValue placeholder="Selecione a origem" />
            </SelectTrigger>
            <SelectContent>
              {LEAD_SOURCES.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
              {/* Lead antigo pode ter origem fora da lista atual (fonte de webhook,
                  valor legado). Mostrar como opção extra em vez de trocar em
                  silêncio no primeiro salvamento. */}
              {!LEAD_SOURCES.some((s) => s.value === source) && source && (
                <SelectItem value={source}>{source}</SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="valueReais">Valor (R$)</Label>
            <Input
              id="valueReais"
              inputMode="decimal"
              placeholder="0,00"
              {...form.register("valueReais")}
            />
            <EcoDoValor control={form.control} />
            {form.formState.errors.valueReais && (
              <p className="text-xs text-error-fg">
                {form.formState.errors.valueReais.message}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="expected_close_date">Fechamento previsto</Label>
            <Input
              id="expected_close_date"
              type="date"
              {...form.register("expected_close_date")}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="tagsRaw">Tags (separadas por vírgula)</Label>
          <Input id="tagsRaw" placeholder="vip, recompra" {...form.register("tagsRaw")} />
        </div>

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancelar
          </Button>
        )}
        <Button type="submit" disabled={busy}>
          {busy ? "Salvando…" : "Salvar"}
        </Button>
      </div>
    </form>
  );
}

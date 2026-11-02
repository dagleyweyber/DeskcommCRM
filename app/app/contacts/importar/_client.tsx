"use client";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useContactTags } from "@/hooks/contacts/useContactTags";
import { apiClient } from "@/lib/api/client";
import {
  canonizarTag,
  detectarColunas,
  emLotes,
  MAX_TAGS,
  prepararLinhas,
  TEXTO_DO_MOTIVO,
  type CampoDoContato,
  type LinhaComProblema,
  type Mapeamento,
} from "@/lib/contacts/importacao";
import { ACEITA, ErroDePlanilha, lerPlanilha, type Planilha } from "@/lib/contacts/ler-planilha";
import { randomId } from "@/lib/random-id";
import { CaretLeft, CheckCircle, DownloadSimple, Tag, UploadSimple, Warning, X } from "@/lib/ui/icons";

const NENHUMA = "__nenhuma__";

const CAMPOS: { campo: CampoDoContato; rotulo: string; ajuda: string }[] = [
  { campo: "telefone", rotulo: "Telefone (WhatsApp)", ajuda: "Obrigatório. Com ou sem DDI, com ou sem o 9." },
  { campo: "nome", rotulo: "Nome", ajuda: "Preenche o nome só de quem ainda não tem." },
  { campo: "email", rotulo: "E-mail", ajuda: "Opcional." },
  { campo: "tags", rotulo: "Tags da planilha", ajuda: "Opcional. Várias na mesma célula, separadas por vírgula." },
];

interface ResultadoDoLote {
  criados: number;
  atualizados: number;
  ignorados: number;
  avisos: { linha: number; resultado: string; motivo: string }[];
}

type Envio =
  | { fase: "parado" }
  | { fase: "enviando"; feitos: number; total: number }
  | { fase: "concluido"; resultado: ResultadoDoLote }
  | { fase: "interrompido"; resultado: ResultadoDoLote; feitos: number; total: number };

const somar = (a: ResultadoDoLote, b: ResultadoDoLote): ResultadoDoLote => ({
  criados: a.criados + b.criados,
  atualizados: a.atualizados + b.atualizados,
  ignorados: a.ignorados + b.ignorados,
  avisos: [...a.avisos, ...b.avisos],
});
const VAZIO: ResultadoDoLote = { criados: 0, atualizados: 0, ignorados: 0, avisos: [] };

const n = (v: number) => v.toLocaleString("pt-BR");

function baixarCsv(nomeArquivo: string, linhas: string[][]) {
  const corpo = linhas.map((l) => l.map((c) => `"${c.replace(/"/g, '""')}"`).join(";")).join("\r\n");
  // BOM: sem ele o Excel em pt-BR abre o arquivo com acento quebrado.
  const blob = new Blob(["﻿" + corpo], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nomeArquivo;
  a.click();
  URL.revokeObjectURL(url);
}

const textoDoMotivo = (m: string) => TEXTO_DO_MOTIVO[m as keyof typeof TEXTO_DO_MOTIVO] ?? m;

export function ImportarContatosClient() {
  const queryClient = useQueryClient();
  const tagsQ = useContactTags();
  const tagsExistentes = useMemo(() => (tagsQ.data ?? []).map((t) => t.tag), [tagsQ.data]);

  const inputArquivo = useRef<HTMLInputElement>(null);
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [planilha, setPlanilha] = useState<Planilha | null>(null);
  const [erroArquivo, setErroArquivo] = useState<string | null>(null);
  const [lendo, setLendo] = useState(false);
  const [mapa, setMapa] = useState<Mapeamento>({ telefone: null, nome: null, email: null, tags: null });
  const [tags, setTags] = useState<string[]>([]);
  const [tagDigitada, setTagDigitada] = useState("");
  const [consentimento, setConsentimento] = useState(false);
  const [envio, setEnvio] = useState<Envio>({ fase: "parado" });

  const preparo = useMemo(
    () => (planilha && mapa.telefone !== null ? prepararLinhas(planilha.linhas, mapa, tagsExistentes) : null),
    [planilha, mapa, tagsExistentes],
  );

  async function escolherArquivo(f: File | undefined) {
    if (!f) return;
    setErroArquivo(null);
    setPlanilha(null);
    setEnvio({ fase: "parado" });
    setArquivo(f);
    setLendo(true);
    try {
      const p = await lerPlanilha(f);
      setPlanilha(p);
      setMapa(detectarColunas(p.cabecalho));
    } catch (err) {
      setErroArquivo(err instanceof ErroDePlanilha ? err.message : "Não consegui ler este arquivo.");
    } finally {
      setLendo(false);
    }
  }

  function adicionarTag(bruta: string) {
    const t = canonizarTag(bruta, tagsExistentes);
    if (!t || tags.length >= MAX_TAGS) return;
    if (!tags.some((x) => x.toLowerCase() === t.toLowerCase())) setTags([...tags, t]);
    setTagDigitada("");
  }

  const importId = useRef<string>("");
  async function importar(aPartirDe = 0) {
    if (!preparo || !arquivo) return;
    // Retomar usa o MESMO import_id: o audit agrupa os lotes como uma importação só.
    if (aPartirDe === 0) importId.current = randomId();
    const total = preparo.prontas.length;
    let acumulado = envio.fase === "interrompido" && aPartirDe > 0 ? envio.resultado : VAZIO;
    let feitos = aPartirDe;

    for (const lote of emLotes(preparo.prontas.slice(aPartirDe))) {
      setEnvio({ fase: "enviando", feitos, total });
      try {
        const r = await apiClient.post<{ data: ResultadoDoLote }>("/api/v1/contacts/import", {
          import_id: importId.current,
          file_name: arquivo.name,
          tags,
          consentimento_marketing: consentimento,
          linhas: lote,
        });
        acumulado = somar(acumulado, r.data);
        feitos += lote.length;
      } catch (err) {
        showApiError(err);
        setEnvio({ fase: "interrompido", resultado: acumulado, feitos, total });
        return;
      }
    }
    setEnvio({ fase: "concluido", resultado: acumulado });
    void queryClient.invalidateQueries({ queryKey: ["contacts"] });
  }

  const problemas: LinhaComProblema[] = preparo?.problemas ?? [];
  const prontas = preparo?.prontas.length ?? 0;
  const enviando = envio.fase === "enviando";
  const podeImportar = Boolean(preparo && prontas > 0 && consentimento && !enviando && envio.fase !== "concluido");
  const amostra = (i: number | null) => (i === null || !planilha ? "" : (planilha.linhas.find((l) => l[i])?.[i] ?? ""));

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 p-4 sm:p-6">
      <header className="space-y-1">
        <Link
          href="/app/contacts"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <CaretLeft size={14} aria-hidden /> Contatos
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Importar contatos</h1>
        <p className="text-sm text-muted-foreground">
          Traga sua base de clientes de uma planilha para usar em campanhas. Os contatos entram com as tags que você
          escolher. <strong className="font-medium text-foreground">Nenhum negócio é criado no Kanban.</strong> Quem já
          está no CRM não é duplicado: só ganha as tags novas.
        </p>
      </header>

      {/* 1. Arquivo */}
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">1. Planilha</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              baixarCsv("modelo-importacao-contatos.csv", [
                ["Nome", "Telefone", "E-mail", "Tags"],
                ["Maria da Silva", "(81) 99999-0000", "maria@email.com", "clientes-2024, laser"],
              ])
            }
          >
            <DownloadSimple size={14} aria-hidden /> Baixar modelo
          </Button>
        </div>
        <input
          ref={inputArquivo}
          type="file"
          accept={ACEITA}
          className="sr-only"
          onChange={(e) => void escolherArquivo(e.target.files?.[0])}
          aria-label="Escolher planilha"
        />
        <button
          type="button"
          onClick={() => inputArquivo.current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void escolherArquivo(e.dataTransfer.files?.[0]);
          }}
          className="flex w-full flex-col items-center gap-1 rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm hover:bg-muted/50"
        >
          <UploadSimple size={20} aria-hidden />
          {lendo ? (
            <span>Lendo {arquivo?.name}…</span>
          ) : planilha && arquivo ? (
            <span>
              <strong>{arquivo.name}</strong> · {n(planilha.linhas.length)} linhas · clique para trocar
            </span>
          ) : (
            <span>Arraste aqui ou clique para escolher um arquivo .xlsx ou .csv</span>
          )}
        </button>
        {erroArquivo && (
          <p role="alert" className="flex items-start gap-1.5 text-sm text-error-fg">
            <Warning size={16} aria-hidden className="mt-0.5 shrink-0" /> {erroArquivo}
          </p>
        )}
      </Card>

      {planilha && (
        <>
          {/* 2. Colunas */}
          <Card className="space-y-3 p-4">
            <h2 className="font-medium">2. Colunas</h2>
            <p className="text-sm text-muted-foreground">Confira qual coluna da planilha corresponde a cada campo.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {CAMPOS.map(({ campo, rotulo, ajuda }) => (
                <div key={campo} className="space-y-1">
                  <Label htmlFor={`col-${campo}`}>{rotulo}</Label>
                  <Select
                    value={mapa[campo] === null ? NENHUMA : String(mapa[campo])}
                    onValueChange={(v) => setMapa({ ...mapa, [campo]: v === NENHUMA ? null : Number(v) })}
                    disabled={enviando}
                  >
                    <SelectTrigger id={`col-${campo}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NENHUMA}>{campo === "telefone" ? "Escolha a coluna" : "Não importar"}</SelectItem>
                      {planilha.cabecalho.map((c, i) => (
                        <SelectItem key={i} value={String(i)}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="truncate text-xs text-muted-foreground">
                    {mapa[campo] !== null && amostra(mapa[campo]) ? `Ex.: ${amostra(mapa[campo])}` : ajuda}
                  </p>
                </div>
              ))}
            </div>
            {mapa.telefone === null && (
              <p role="alert" className="text-sm text-error-fg">
                Escolha a coluna de telefone — é por ela que o WhatsApp encontra a pessoa.
              </p>
            )}
          </Card>

          {/* 3. Tags */}
          <Card className="space-y-3 p-4">
            <h2 className="flex items-center gap-1.5 font-medium">
              <Tag size={16} aria-hidden /> 3. Tags para todos os contatos desta planilha
            </h2>
            <p className="text-sm text-muted-foreground">
              É pela tag que você encontra esta lista depois, em Contatos e no público da campanha. Ex.:{" "}
              <em>base-2024</em>, <em>clientes-laser</em>.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {tags.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-sm">
                  {t}
                  <button
                    type="button"
                    aria-label={`Remover a tag ${t}`}
                    onClick={() => setTags(tags.filter((x) => x !== t))}
                    disabled={enviando}
                    className="rounded-full p-0.5 hover:bg-background"
                  >
                    <X size={12} aria-hidden />
                  </button>
                </span>
              ))}
              <form
                className="flex min-w-0 flex-1 gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  adicionarTag(tagDigitada);
                }}
              >
                <Input
                  list="tags-existentes"
                  value={tagDigitada}
                  onChange={(e) => setTagDigitada(e.target.value)}
                  placeholder={tags.length >= MAX_TAGS ? `Máximo de ${MAX_TAGS} tags` : "Digite uma tag e Enter"}
                  disabled={enviando || tags.length >= MAX_TAGS}
                  className="h-9 min-w-0 flex-1"
                  aria-label="Nova tag"
                />
                <datalist id="tags-existentes">
                  {(tagsQ.data ?? []).map((t) => (
                    <option key={t.tag} value={t.tag}>{`${n(t.total)} contatos`}</option>
                  ))}
                </datalist>
                <Button type="submit" variant="outline" size="sm" disabled={!tagDigitada.trim() || enviando}>
                  Adicionar
                </Button>
              </form>
            </div>
            {tags.length === 0 && mapa.tags === null && (
              <p className="flex items-start gap-1.5 text-sm text-warning-fg">
                <Warning size={16} aria-hidden className="mt-0.5 shrink-0" /> Sem tag, estes contatos se misturam com o
                resto da base e não dá para mandar a campanha só para eles.
              </p>
            )}
          </Card>

          {/* 4. Conferência e envio */}
          {preparo && (
            <Card className="space-y-4 p-4">
              <h2 className="font-medium">4. Conferir e importar</h2>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="rounded-lg border border-border p-3">
                  <p className="text-2xl font-semibold">{n(prontas)}</p>
                  <p className="text-sm text-muted-foreground">prontos para importar</p>
                </div>
                <div className="rounded-lg border border-border p-3">
                  <p className="text-2xl font-semibold">{n(problemas.length)}</p>
                  <p className="text-sm text-muted-foreground">linhas que não entram</p>
                </div>
              </div>

              {problemas.length > 0 && (
                <details className="rounded-lg border border-border p-3 text-sm">
                  <summary className="cursor-pointer font-medium">Ver as linhas que não entram</summary>
                  <ul className="mt-2 max-h-56 space-y-1 overflow-auto">
                    {problemas.slice(0, 200).map((p) => (
                      <li key={`${p.linha}-${p.motivo}`} className="flex gap-2">
                        <span className="shrink-0 tabular-nums text-muted-foreground">Linha {p.linha}</span>
                        <span className="min-w-0 break-words">
                          {p.nome || p.telefoneBruto || "(vazia)"} — {textoDoMotivo(p.motivo)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() =>
                      baixarCsv("linhas-nao-importadas.csv", [
                        ["Linha", "Nome", "Telefone", "Motivo"],
                        ...problemas.map((p) => [String(p.linha), p.nome, p.telefoneBruto, textoDoMotivo(p.motivo)]),
                      ])
                    }
                  >
                    <DownloadSimple size={14} aria-hidden /> Baixar essas linhas (.csv)
                  </Button>
                </details>
              )}

              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0"
                  checked={consentimento}
                  onChange={(e) => setConsentimento(e.target.checked)}
                  disabled={enviando || envio.fase === "concluido"}
                />
                <span>
                  Confirmo que estas pessoas são clientes ou contatos da empresa e autorizaram receber mensagens dela pelo
                  WhatsApp. A Meta exige essa autorização (opt-in) para mensagens de marketing, e a LGPD exige uma base
                  legal. Quem já pediu para sair continua bloqueado.
                </span>
              </label>

              {envio.fase === "enviando" && (
                <div className="space-y-1" aria-live="polite">
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${Math.round((envio.feitos / Math.max(envio.total, 1)) * 100)}%` }}
                    />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Importando… {n(envio.feitos)} de {n(envio.total)}
                  </p>
                </div>
              )}

              {envio.fase === "interrompido" && (
                <p role="alert" className="text-sm text-error-fg">
                  A importação parou em {n(envio.feitos)} de {n(envio.total)}. O que já entrou está salvo; continuar não
                  duplica ninguém.
                </p>
              )}

              {envio.fase !== "concluido" && (
                <Button
                  onClick={() => void importar(envio.fase === "interrompido" ? envio.feitos : 0)}
                  disabled={!podeImportar}
                >
                  <UploadSimple size={16} aria-hidden />
                  {envio.fase === "interrompido"
                    ? `Continuar (${n(envio.total - envio.feitos)} restantes)`
                    : enviando
                      ? "Importando…"
                      : `Importar ${n(prontas)} contatos`}
                </Button>
              )}
            </Card>
          )}

          {envio.fase === "concluido" && <Resultado resultado={envio.resultado} tags={tags} />}
        </>
      )}
    </div>
  );
}

function Resultado({ resultado, tags }: { resultado: ResultadoDoLote; tags: string[] }) {
  const primeiraTag = tags[0];
  return (
    <Card className="space-y-4 p-4" role="status">
      <h2 className="flex items-center gap-1.5 font-medium">
        <CheckCircle size={18} weight="fill" className="text-success-fg" aria-hidden /> Importação concluída
      </h2>
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="rounded-lg border border-border p-3">
          <p className="text-2xl font-semibold">{n(resultado.criados)}</p>
          <p className="text-sm text-muted-foreground">contatos novos</p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-2xl font-semibold">{n(resultado.atualizados)}</p>
          <p className="text-sm text-muted-foreground">já estavam no CRM e ganharam as tags</p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-2xl font-semibold">{n(resultado.ignorados)}</p>
          <p className="text-sm text-muted-foreground">não entraram</p>
        </div>
      </div>
      {resultado.avisos.length > 0 && (
        <details className="rounded-lg border border-border p-3 text-sm">
          <summary className="cursor-pointer font-medium">Avisos ({n(resultado.avisos.length)})</summary>
          <ul className="mt-2 max-h-56 space-y-1 overflow-auto">
            {resultado.avisos.slice(0, 200).map((a) => (
              <li key={`${a.linha}-${a.motivo}`} className="flex gap-2">
                <span className="shrink-0 tabular-nums text-muted-foreground">Linha {a.linha}</span>
                <span>{textoDoMotivo(a.motivo)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="flex flex-wrap gap-2">
        {primeiraTag && (
          <Button asChild variant="outline">
            <Link href={`/app/contacts?tag=${encodeURIComponent(primeiraTag)}`}>Ver contatos com “{primeiraTag}”</Link>
          </Button>
        )}
        <Button asChild>
          <Link href="/app/campaigns">Criar campanha</Link>
        </Button>
      </div>
    </Card>
  );
}

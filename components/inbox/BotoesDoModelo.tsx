import { ArrowBendUpLeft, ArrowSquareOut, Copy, Phone } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import type { BotaoDoModelo } from "@/lib/messaging/retrato-do-modelo";

/**
 * Os botões de uma mensagem de modelo, empilhados sob o texto como o WhatsApp
 * mostra ao cliente. São só leitura: quem clica é o cliente, no celular dele — o
 * que a equipe precisa é saber QUAIS opções ele recebeu quando a resposta chega.
 */
function IconeDoBotao({ type }: { type: string }) {
  const props = { size: 14, weight: "bold" as const, "aria-hidden": true };
  if (type === "URL") return <ArrowSquareOut {...props} />;
  if (type === "PHONE_NUMBER") return <Phone {...props} />;
  if (type === "COPY_CODE") return <Copy {...props} />;
  return <ArrowBendUpLeft {...props} />;
}

const DESCRICAO: Record<string, string> = {
  URL: "Botão de link",
  PHONE_NUMBER: "Botão de ligação",
  COPY_CODE: "Botão de copiar código",
};

export function BotoesDoModelo({ botoes, isOutbound }: { botoes: BotaoDoModelo[]; isOutbound: boolean }) {
  if (botoes.length === 0) return null;
  return (
    <ul
      aria-label="Botões enviados com a mensagem"
      className={cn(
        "-mx-3 -mb-2 mt-2 border-t",
        isOutbound ? "border-primary-foreground/20" : "border-border",
      )}
    >
      {botoes.map((b, i) => (
        <li
          key={`${i}-${b.text}`}
          title={b.url ?? b.phone ?? DESCRICAO[b.type] ?? "Botão de resposta rápida"}
          className={cn(
            "flex items-center justify-center gap-1.5 px-3 py-1.5 text-center text-[13px] font-medium",
            i > 0 && (isOutbound ? "border-t border-primary-foreground/20" : "border-t border-border"),
          )}
        >
          <IconeDoBotao type={b.type} />
          <span className="break-words">{b.text}</span>
        </li>
      ))}
    </ul>
  );
}

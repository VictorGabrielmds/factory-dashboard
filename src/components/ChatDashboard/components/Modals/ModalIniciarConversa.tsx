import { useEffect, useState } from "react";
import {
  MdCheckCircle,
  MdErrorOutline,
  MdSend,
  MdSettings,
  MdVisibility,
  MdVisibilityOff,
} from "react-icons/md";
import ModalBase from "../../../ModalBase/ModalBase";
import type { Template } from "../../../../types/chat.types";
import { contarVariaveisTemplate } from "../../../../utils/chatHelpers";

interface ComponenteSeguro {
  type: string;
  text?: string;
}

interface IdiomaSeguro {
  code?: string;
}

const CHAVE_TEMPLATES_OCULTOS = "chatDashboard:templatesIniciaisOcultos";

interface ModalIniciarConversaProps {
  isOpen: boolean;
  templates: Template[];
  initialPhone?: string;
  initialName?: string;
  mode?: "new" | "window-closed";
  onClose: () => void;
  onConfirm: (
    telefone: string,
    nome: string,
    templateName: string,
    params: { type: string; text: string }[],
  ) => Promise<void>;
}

export default function ModalIniciarConversa({
  isOpen,
  templates,
  initialPhone = "",
  initialName = "",
  mode = "new",
  onClose,
  onConfirm,
}: ModalIniciarConversaProps) {
  const [telefone, setTelefone] = useState("");
  const [nome, setNome] = useState("");
  const [templateSelecionado, setTemplateSelecionado] = useState<Template | null>(null);
  const [parametros, setParametros] = useState<string[]>([]);
  const [tentouEnviar, setTentouEnviar] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [erroEnvio, setErroEnvio] = useState("");
  const [configurandoMensagens, setConfigurandoMensagens] = useState(false);
  const [templatesOcultos, setTemplatesOcultos] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(CHAVE_TEMPLATES_OCULTOS) || "[]") as string[]);
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    if (!templateSelecionado) return;
    const components = (templateSelecionado.components || []) as unknown as ComponenteSeguro[];
    setParametros(Array(contarVariaveisTemplate(components as never[])).fill(""));
  }, [templateSelecionado]);

  useEffect(() => {
    setTelefone(isOpen ? initialPhone.replace(/\D/g, "").slice(0, 13) : "");
    setNome(isOpen ? initialName : "");
    setTemplateSelecionado(null);
    setParametros([]);
    setTentouEnviar(false);
    setEnviando(false);
    setErroEnvio("");
    setConfigurandoMensagens(false);
  }, [initialName, initialPhone, isOpen]);

  useEffect(() => {
    try {
      localStorage.setItem(CHAVE_TEMPLATES_OCULTOS, JSON.stringify([...templatesOcultos]));
    } catch {
      // Preferência local: se o navegador bloquear o armazenamento, a lista completa continua disponível.
    }
  }, [templatesOcultos]);

  const telefoneNumeros = telefone.replace(/\D/g, "");
  const telefoneValido = telefoneNumeros.length >= 10 && telefoneNumeros.length <= 13;
  const telefoneNormalizado = telefoneNumeros.length <= 11 ? `55${telefoneNumeros}` : telefoneNumeros;
  const faltaVariavel = parametros.some(p => !p.trim());

  const components = (templateSelecionado?.components || []) as unknown as ComponenteSeguro[];
  const bodyText = components.find(c => c.type === "BODY")?.text ?? templateSelecionado?.preview ?? "";
  const templatesVisiveis = templates.filter(template => !templatesOcultos.has(template.id));
  const destinatarioBloqueado = mode === "window-closed";

  const alternarVisibilidadeTemplate = (template: Template) => {
    setTemplatesOcultos(prev => {
      const next = new Set(prev);
      if (next.has(template.id)) next.delete(template.id);
      else next.add(template.id);
      return next;
    });
    if (templateSelecionado?.id === template.id) setTemplateSelecionado(null);
  };

  const handleConfirm = async () => {
    setTentouEnviar(true);
    setErroEnvio("");
    if (!telefoneValido || !templateSelecionado || faltaVariavel || enviando) return;

    setEnviando(true);
    try {
      await onConfirm(
        telefoneNormalizado,
        nome.trim(),
        templateSelecionado.name,
        parametros.map(p => ({ type: "text", text: p.trim() })),
      );
    } catch (err) {
      setErroEnvio(err instanceof Error ? err.message : "Tente novamente em instantes.");
      setEnviando(false);
    }
  };

  return (
    <ModalBase
      isOpen={isOpen}
      onClose={enviando ? () => undefined : onClose}
      title={destinatarioBloqueado ? "Enviar template aprovado" : "Iniciar conversa"}
    >
      <div className="modal-frases-body iniciar-conversa-flow">
        <p className="iniciar-conversa-intro">
          {destinatarioBloqueado
            ? "A janela de 24 horas terminou. Escolha uma mensagem aprovada para retomar o atendimento."
            : "Use uma mensagem aprovada para iniciar o atendimento com segurança."}
        </p>

        <section className="iniciar-section">
          <div className="iniciar-section-heading">
            <span>1</span><strong>{destinatarioBloqueado ? "Cliente atual" : "Cliente"}</strong>
          </div>
          <label className="iniciar-field">
            <span>WhatsApp com DDD <b>Obrigatório</b></span>
            <input
              className={`pendencia-input ${tentouEnviar && !telefoneValido ? "input-error" : ""}`}
              inputMode="tel"
              autoComplete="tel"
              placeholder="Ex.: 98 99123-4567"
              value={telefone}
              onChange={e => {
                setTelefone(e.target.value.replace(/\D/g, "").slice(0, 13));
                setErroEnvio("");
              }}
              aria-invalid={tentouEnviar && !telefoneValido}
              autoFocus={!destinatarioBloqueado}
              disabled={destinatarioBloqueado}
            />
            <small>
              {telefoneNumeros.length <= 11
                ? "O código do Brasil (+55) será incluído automaticamente."
                : "Número internacional identificado."}
            </small>
            {tentouEnviar && !telefoneValido && (
              <span className="field-error">Confira o DDD e o número. Use entre 10 e 13 dígitos.</span>
            )}
          </label>
          <label className="iniciar-field">
            <span>Nome do cliente <em>Opcional</em></span>
            <input
              className="pendencia-input"
              placeholder="Como o cliente será identificado"
              value={nome}
              maxLength={80}
              onChange={e => setNome(e.target.value)}
              disabled={destinatarioBloqueado}
            />
          </label>
        </section>

        <section className="iniciar-section">
          <div className="iniciar-section-title-row">
            <div className="iniciar-section-heading">
              <span>2</span><strong>{destinatarioBloqueado ? "Template aprovado" : "Mensagem inicial"}</strong>
            </div>
            <button
              type="button"
              className={`configurar-templates-btn ${configurandoMensagens ? "active" : ""}`}
              onClick={() => setConfigurandoMensagens(value => !value)}
              aria-expanded={configurandoMensagens}
            >
              <MdSettings size={15} /> {configurandoMensagens ? "Concluir" : "Configurar"}
            </button>
          </div>
          {configurandoMensagens && (
            <div className="templates-config-panel">
              <div>
                <strong>Mensagens disponíveis</strong>
                <span>Escolha o que aparece no uso diário deste computador.</span>
              </div>
              <div className="templates-config-list">
                {templates.map(template => {
                  const visivel = !templatesOcultos.has(template.id);
                  return (
                    <button
                      type="button"
                      key={template.id}
                      className={visivel ? "visible" : ""}
                      onClick={() => alternarVisibilidadeTemplate(template)}
                      aria-pressed={visivel}
                    >
                      {visivel ? <MdVisibility size={16} /> : <MdVisibilityOff size={16} />}
                      <span>{template.name}</span>
                      <em>{visivel ? "Visível" : "Oculta"}</em>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <div className="frases-list iniciar-template-list">
            {templates.length === 0 && (
              <p className="iniciar-empty-template">Nenhuma mensagem aprovada disponível. Tente novamente mais tarde.</p>
            )}
            {templates.length > 0 && templatesVisiveis.length === 0 && !configurandoMensagens && (
              <p className="iniciar-empty-template">
                Todas as mensagens estão ocultas. Use <strong>Configurar</strong> para escolher quais deseja mostrar.
              </p>
            )}
            {templatesVisiveis.map(template => {
              const category = typeof template.category === "string" ? template.category : "Mensagem";
              const language = template.language as string | IdiomaSeguro | undefined;
              const languageLabel = typeof language === "string" ? language : language?.code ?? "";
              const selecionado = templateSelecionado?.id === template.id;

              return (
                <button
                  key={template.id}
                  type="button"
                  className={`frase-item ${selecionado ? "selected" : ""}`}
                  onClick={() => {
                    setTemplateSelecionado(template);
                    setErroEnvio("");
                  }}
                >
                  <div className="frase-info">
                    <span className="frase-shortcut">{template.name}</span>
                    <p className="frase-text">{category}{languageLabel ? ` · ${languageLabel}` : ""}</p>
                  </div>
                  {selecionado && <MdCheckCircle className="template-selected-icon" size={19} />}
                </button>
              );
            })}
          </div>
          {tentouEnviar && !templateSelecionado && (
            <span className="field-error">Escolha uma mensagem inicial.</span>
          )}
        </section>

        {templateSelecionado && parametros.length > 0 && (
          <section className="iniciar-section">
            <div className="iniciar-section-heading"><span>3</span><strong>Complete a mensagem</strong></div>
            {bodyText && <div className="template-preview">{String(bodyText)}</div>}
            {parametros.map((parametro, index) => (
              <label className="iniciar-field" key={index}>
                <span>Informação {index + 1} <b>Obrigatória</b></span>
                <input
                  className={`pendencia-input ${tentouEnviar && !parametro.trim() ? "input-error" : ""}`}
                  placeholder={`Substitui {{${index + 1}}}`}
                  value={parametro}
                  onChange={e => setParametros(prev => prev.map((value, i) => i === index ? e.target.value : value))}
                />
              </label>
            ))}
            {tentouEnviar && faltaVariavel && (
              <span className="field-error">Preencha todas as informações da mensagem.</span>
            )}
          </section>
        )}

        {erroEnvio && (
          <div className="iniciar-error-banner" role="alert">
            <MdErrorOutline size={20} />
            <span><strong>Não foi possível enviar.</strong>{erroEnvio}</span>
          </div>
        )}

        <div className="finalizar-actions iniciar-actions">
          <button type="button" className="pf-cancel" onClick={onClose} disabled={enviando}>Cancelar</button>
          <button type="button" className="pf-save" onClick={handleConfirm} disabled={enviando || templates.length === 0}>
            <MdSend size={15} />{" "}
            {enviando ? "Enviando…" : destinatarioBloqueado ? "Enviar template" : "Enviar e abrir conversa"}
          </button>
        </div>
      </div>
    </ModalBase>
  );
}

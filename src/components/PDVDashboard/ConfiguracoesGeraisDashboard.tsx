// src/components/PDVDashboard/ConfiguracoesGeraisDashboard.tsx
import { useEffect, useState } from "react";
import "./ConfiguracoesGeraisDashboard.css";
import { db, doc, getDoc, setDoc } from "../../services/firebase";
import { useToast } from "../../contexts/ToastContext";

export default function ConfiguracoesGeraisDashboard() {
  const { addToast } = useToast();

  const [taxaDebito, setTaxaDebito] = useState("0");
  const [taxaCredito, setTaxaCredito] = useState("0");
  const [whatsappLoja, setWhatsappLoja] = useState("");
  const [tempoPreparoPadrao, setTempoPreparoPadrao] = useState("0");
  const [valorMinimoEntrega, setValorMinimoEntrega] = useState("20");
  const [enderecoLojaTexto, setEnderecoLojaTexto] = useState("");
  const [enderecoLojaLink, setEnderecoLojaLink] = useState("");
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    getDoc(doc(db, "configuracoes", "geral"))
      .then((snap) => {
        const dados = snap.data();
        if (typeof dados?.taxaDebitoPercentual === "number") setTaxaDebito(String(dados.taxaDebitoPercentual));
        if (typeof dados?.taxaCreditoPercentual === "number") setTaxaCredito(String(dados.taxaCreditoPercentual));
        if (typeof dados?.whatsappLoja === "string") setWhatsappLoja(dados.whatsappLoja);
        if (typeof dados?.tempoPreparoPadraoMinutos === "number") {
          setTempoPreparoPadrao(String(dados.tempoPreparoPadraoMinutos));
        }
        if (typeof dados?.valorMinimoEntrega === "number") setValorMinimoEntrega(String(dados.valorMinimoEntrega));
        if (typeof dados?.enderecoLojaTexto === "string") setEnderecoLojaTexto(dados.enderecoLojaTexto);
        if (typeof dados?.enderecoLojaLink === "string") setEnderecoLojaLink(dados.enderecoLojaLink);
      })
      .finally(() => setCarregando(false));
  }, []);

  const salvar = async () => {
    setSalvando(true);
    try {
      await setDoc(
        doc(db, "configuracoes", "geral"),
        {
          taxaDebitoPercentual: Number(taxaDebito.replace(",", ".")) || 0,
          taxaCreditoPercentual: Number(taxaCredito.replace(",", ".")) || 0,
          whatsappLoja: whatsappLoja.replace(/\D/g, ""),
          tempoPreparoPadraoMinutos: Number(tempoPreparoPadrao.replace(",", ".")) || 0,
          valorMinimoEntrega: Number(valorMinimoEntrega.replace(",", ".")) || 0,
          enderecoLojaTexto: enderecoLojaTexto.trim(),
          enderecoLojaLink: enderecoLojaLink.trim(),
        },
        { merge: true }
      );
      addToast("Configurações gerais salvas!", "success");
    } catch (err) {
      console.error(err);
      addToast("Erro ao salvar configurações gerais.", "error");
    } finally {
      setSalvando(false);
    }
  };

  if (carregando) {
    return (
      <div className="dashboard-loading">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="config-geral-container fade-in">
      <div className="pdv-page-header">
        <div>
          <h1>Loja</h1>
          <p>Informações e regras que organizam a experiência do cliente no aplicativo.</p>
        </div>
        <button className="btn btn-primary" onClick={salvar} disabled={salvando}>
          {salvando ? "Salvando..." : "Salvar alterações"}
        </button>
      </div>

      <div className="config-geral-secoes">
        <section className="config-geral-section">
          <div className="config-geral-section-heading">
            <h2>Pagamentos</h2>
            <p>Taxas adicionadas ao total conforme a forma escolhida pelo cliente.</p>
          </div>
          <div className="config-geral-campos">
            <div className="config-geral-campo">
              <label htmlFor="taxa-debito">Taxa de débito</label>
              <div className="input-with-suffix">
                <input
                  id="taxa-debito"
                  type="text"
                  inputMode="decimal"
                  value={taxaDebito}
                  onChange={(e) => setTaxaDebito(e.target.value)}
                />
                <span className="input-suffix">%</span>
              </div>
              <p>Aplicada quando o pagamento for no débito.</p>
            </div>

            <div className="config-geral-campo">
              <label htmlFor="taxa-credito">Taxa de crédito</label>
              <div className="input-with-suffix">
                <input
                  id="taxa-credito"
                  type="text"
                  inputMode="decimal"
                  value={taxaCredito}
                  onChange={(e) => setTaxaCredito(e.target.value)}
                />
                <span className="input-suffix">%</span>
              </div>
              <p>Aplicada quando o pagamento for no crédito.</p>
            </div>
          </div>
        </section>

        <section className="config-geral-section">
          <div className="config-geral-section-heading">
            <h2>Operação</h2>
            <p>Regras padrão usadas no preparo e na finalização dos pedidos.</p>
          </div>
          <div className="config-geral-campos">
            <div className="config-geral-campo">
              <label htmlFor="tempo-preparo-padrao">Tempo de preparo padrão</label>
              <div className="input-with-suffix">
                <input
                  id="tempo-preparo-padrao"
                  type="text"
                  inputMode="decimal"
                  value={tempoPreparoPadrao}
                  onChange={(e) => setTempoPreparoPadrao(e.target.value)}
                />
                <span className="input-suffix">min</span>
              </div>
              <p>Usado quando o produto não tem um tempo próprio cadastrado.</p>
            </div>

            <div className="config-geral-campo">
              <label htmlFor="valor-minimo-entrega">Valor mínimo para entrega</label>
              <div className="input-with-suffix">
                <span className="input-suffix">R$</span>
                <input
                  id="valor-minimo-entrega"
                  type="text"
                  inputMode="decimal"
                  value={valorMinimoEntrega}
                  onChange={(e) => setValorMinimoEntrega(e.target.value)}
                />
              </div>
              <p>Use 0 quando não quiser exigir um valor mínimo.</p>
            </div>
          </div>
        </section>

        <section className="config-geral-section">
          <div className="config-geral-section-heading">
            <h2>Contato e retirada</h2>
            <p>Informações exibidas ao cliente para falar com a loja ou buscar o pedido.</p>
          </div>
          <div className="config-geral-campos config-geral-campos-wide">
            <div className="config-geral-campo">
              <label htmlFor="whatsapp-loja">WhatsApp da loja</label>
              <input
                id="whatsapp-loja"
                type="text"
                inputMode="numeric"
                value={whatsappLoja}
                onChange={(e) => setWhatsappLoja(e.target.value)}
                placeholder="Ex.: 5598912345678"
              />
              <p>Informe DDI, DDD e número.</p>
            </div>

            <div className="config-geral-campo">
              <label htmlFor="endereco-loja-texto">Endereço da loja</label>
              <input
                id="endereco-loja-texto"
                type="text"
                value={enderecoLojaTexto}
                onChange={(e) => setEnderecoLojaTexto(e.target.value)}
                placeholder="Ex.: Rua Exemplo, 123 — Bairro"
              />
              <p>Texto mostrado para pedidos de retirada.</p>
            </div>

            <div className="config-geral-campo">
              <label htmlFor="endereco-loja-link">Link do Google Maps</label>
              <input
                id="endereco-loja-link"
                type="text"
                value={enderecoLojaLink}
                onChange={(e) => setEnderecoLojaLink(e.target.value)}
                placeholder="https://maps.app.goo.gl/..."
              />
              <p>Use o link de compartilhamento da localização.</p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

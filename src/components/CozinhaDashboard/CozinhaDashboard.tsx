// src/components/CozinhaDashboard/CozinhaDashboard.tsx
import {
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import "./CozinhaDashboard.css";
import { usePedidos } from "../../hooks/usePedidos";
import { PedidoStatus } from "../../types/Pedido";
import type { Pedido } from "../../types/Pedido";
import { db } from "../../services/firebase";
import { doc, updateDoc, arrayUnion, arrayRemove, serverTimestamp } from "firebase/firestore";
import { calcularInteligenciaPedido, pertenceAoDiaAtual, formatarDataCompletaPorExtenso } from "./cozinhaHelpers";
import { toTitleCase, dateToISOString } from "../../utils/dateUtils";
import PedidoTicket from "./PedidoTicket";
import {
  MdRestaurantMenu,
  MdReplay,
  MdFullscreen,
  MdFullscreenExit,
  MdCalendarToday,
  MdZoomOutMap,
  MdSync,
  MdFirstPage,
} from "react-icons/md";

type Filtro = "todos" | "atrasados" | "proximos";
type ItemFila = { pedido: Pedido; intel: ReturnType<typeof calcularInteligenciaPedido> };

const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;

// Precisa bater com o CSS (.pedido-ticket width + .cozinha-arara gap) — é o
// quanto os vizinhos DESLIZAM visualmente pra abrir espaço (a animação
// precisa ser exata, senão fica um degrau/sobreposição).
const LARGURA_TICKET = 300;
const GAP_TICKET = 22;
const PASSO_SLOT = LARGURA_TICKET + GAP_TICKET;
// Já o GATILHO da troca é menor que o slot de verdade — de propósito. Não
// precisa arrastar quase a largura toda do card pra trocar, só uma fração
// do caminho (a troca acontece na METADE deste valor, ou seja, uns 90px
// antes de virar a próxima comanda); o vizinho ainda desliza o PASSO_SLOT
// inteiro na animação, só o "quando dispara" que é mais sensível. Já foi
// 110 (sensível demais, trocava sem querer) — 180 é o meio-termo.
const PASSO_SENSIBILIDADE_TROCA = 180;
const LIMIAR_ARRASTO_REORDENAR = 6; // px — abaixo disso é um toque, não um arrasto

function clamp(valor: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, valor));
}

const CozinhaDashboard = () => {
  const pedidos = usePedidos();
  const [agoraMs, setAgoraMs] = useState(() => Date.now());
  const [filtro, setFiltro] = useState<Filtro>("todos");
  const [emFoco, setEmFoco] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // A urgência (espera/atraso) envelhece sozinha — sem isso, um pedido só
  // "sobe" na fila quando outro snapshot chegasse do Firestore por acaso.
  useEffect(() => {
    const id = setInterval(() => setAgoraMs(Date.now()), 20000);
    return () => clearInterval(id);
  }, []);

  // Sincroniza com o fullscreen de verdade — o usuário pode sair pelo Esc ou
  // F11 sem passar pelo nosso botão, e sem isso o ícone ficaria desatualizado.
  useEffect(() => {
    const handler = () => setEmFoco(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  const alternarModoFoco = useCallback(async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await containerRef.current?.requestFullscreen();
      }
    } catch (err) {
      console.error("Erro ao alternar modo foco da cozinha:", err);
    }
  }, []);

  // "Hoje" recalculado a partir do relógio real (não congelado no mount) —
  // se a tela ficar aberta passando da meia-noite, ela troca de dia sozinha.
  const hojeISO = useMemo(() => dateToISOString(new Date(agoraMs)), [agoraMs]);

  // Mesmo critério de "pertence a hoje" já usado e confiável em OrdersList
  // (agendados contam pelo dia do agendamento, os demais pela data da venda,
  // comparando string sem timezone nenhum) — sem isso, pedidos "Aceito" que
  // ficaram presos de dias anteriores ficavam acumulando na fila pra sempre.
  const pedidosDeHoje = useMemo(
    () => pedidos.filter((p) => pertenceAoDiaAtual(p, hojeISO)),
    [pedidos, hojeISO],
  );

  const filaBase = useMemo<ItemFila[]>(() => {
    return pedidosDeHoje
      .filter((p) => Number(p.status) === PedidoStatus.Aceito && !p.cozinha_concluido)
      .map((p) => ({ pedido: p, intel: calcularInteligenciaPedido(p, agoraMs) }))
      .sort((a, b) => b.intel.score - a.intel.score);
  }, [pedidosDeHoje, agoraMs]);

  // Ordem: por padrão segue o score (sobe sozinho quando um pedido atrasa).
  // No momento em que alguém arrasta uma comanda, essa ordem fica "fixada"
  // aqui — pedidos novos entram no fim sozinhos — até alguém clicar em
  // "ordem automática" pra voltar a deixar o score decidir.
  const [ordemManual, setOrdemManual] = useState<string[]>([]);

  const filaCalculada = useMemo<ItemFila[]>(() => {
    if (ordemManual.length === 0) return filaBase;
    const porId = new Map(filaBase.map((item) => [String(item.pedido.order_id), item]));
    const ordenada = ordemManual.map((id) => porId.get(id)).filter((item): item is ItemFila => !!item);
    const idsConhecidos = new Set(ordenada.map((item) => String(item.pedido.order_id)));
    const novos = filaBase.filter((item) => !idsConhecidos.has(String(item.pedido.order_id)));
    return [...ordenada, ...novos];
  }, [filaBase, ordemManual]);

  const filaVisivel = useMemo(() => {
    if (filtro === "todos") return filaCalculada;
    if (filtro === "atrasados") return filaCalculada.filter(({ intel }) => intel.urgencia === "atrasado");
    return filaCalculada.filter(({ intel }) => intel.urgencia === "urgente");
  }, [filaCalculada, filtro]);

  const concluidosHoje = useMemo(
    () => pedidosDeHoje.filter((p) => p.cozinha_concluido),
    [pedidosDeHoje],
  );

  const totalAtrasados = useMemo(
    () => filaCalculada.filter(({ intel }) => intel.urgencia === "atrasado").length,
    [filaCalculada],
  );

  const totalProximos = useMemo(
    () => filaCalculada.filter(({ intel }) => intel.urgencia === "urgente").length,
    [filaCalculada],
  );

  const toggleItem = useCallback(async (pedido: Pedido, index: number, jaPronto: boolean) => {
    const ref = doc(db, "pedidos", String(pedido.order_id));
    try {
      await updateDoc(ref, {
        cozinha_itens_prontos: jaPronto ? arrayRemove(index) : arrayUnion(index),
      });
    } catch (err) {
      console.error("Erro ao marcar item da cozinha:", err);
    }
  }, []);

  const concluirPedido = useCallback(async (pedido: Pedido) => {
    const ref = doc(db, "pedidos", String(pedido.order_id));
    try {
      await updateDoc(ref, { cozinha_concluido: true, cozinha_concluido_em: serverTimestamp() });
    } catch (err) {
      console.error("Erro ao concluir pedido na cozinha:", err);
    }
  }, []);

  const reabrirPedido = useCallback(async (pedido: Pedido) => {
    const ref = doc(db, "pedidos", String(pedido.order_id));
    try {
      await updateDoc(ref, { cozinha_concluido: false });
    } catch (err) {
      console.error("Erro ao reabrir pedido na cozinha:", err);
    }
  }, []);

  // ══════════════════════════════════════════════════════════════════════
  // A ARARA INTEIRA é o canvas: dá pra afastar/aproximar e arrastar pra
  // navegar, tipo Figma/Canva — as comandas em si não têm zoom próprio.
  // ══════════════════════════════════════════════════════════════════════
  const araraViewportRef = useRef<HTMLDivElement>(null);
  const araraConteudoRef = useRef<HTMLDivElement>(null);
  const [araraTransform, setAraraTransform] = useState({ scale: 1, panX: 0, panY: 0 });
  const ponteirosArara = useRef(new Map<number, { x: number; y: number }>());
  const distanciaAnteriorRef = useRef(0);
  const panInicioRef = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  // Antes o limite de arrasto era um chute baseado só no tamanho do viewport,
  // sem olhar pra quantas comandas existem — com muitos pedidos (ou zoom
  // maior, que aumenta o conteúdo em pixels de tela), o limite ficava curto
  // demais e as últimas comandas à direita ficavam impossíveis de alcançar.
  // Agora mede o tamanho REAL do conteúdo (offsetWidth/Height, que ignora o
  // transform) pra calcular exatamente quanto precisa poder arrastar.
  function limitarPanArara(panX: number, panY: number, scale: number) {
    const rectViewport = medirViewportArara();
    const largura = rectViewport.width;
    const altura = rectViewport.height;
    const conteudo = araraConteudoRef.current;
    const conteudoW = (conteudo?.offsetWidth ?? largura) * scale;
    const conteudoH = (conteudo?.offsetHeight ?? altura) * scale;

    const folgaRespiroX = largura * 0.15;
    const folgaRespiroY = altura * 0.15;
    const minPanX = Math.min(folgaRespiroX, -(Math.max(conteudoW - largura, 0)) - folgaRespiroX);
    const minPanY = Math.min(folgaRespiroY, -(Math.max(conteudoH - altura, 0)) - folgaRespiroY);

    return {
      panX: clamp(panX, minPanX, folgaRespiroX),
      panY: clamp(panY, minPanY, folgaRespiroY),
    };
  }

  function medirViewportArara() {
    const rect = araraViewportRef.current?.getBoundingClientRect();
    return { width: rect?.width ?? 800, height: rect?.height ?? 420 };
  }

  function pontoNaArara(clientX: number, clientY: number) {
    const rect = araraViewportRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  }

  function aplicarZoomAraraRelativo(midpoint: { x: number; y: number }, fatorRelativo: number) {
    setAraraTransform((prev) => {
      const novaScale = clamp(prev.scale * fatorRelativo, ZOOM_MIN, ZOOM_MAX);
      const fator = novaScale / prev.scale;
      const { panX, panY } = limitarPanArara(
        midpoint.x - (midpoint.x - prev.panX) * fator,
        midpoint.y - (midpoint.y - prev.panY) * fator,
        novaScale,
      );
      return { scale: novaScale, panX, panY };
    });
  }

  function handleAraraPointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    ponteirosArara.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ponteirosArara.current.size === 2) {
      panInicioRef.current = null;
      const [a, b] = Array.from(ponteirosArara.current.values());
      distanciaAnteriorRef.current = Math.hypot(a.x - b.x, a.y - b.y);
    } else if (ponteirosArara.current.size === 1) {
      // Um toque que começou EM CIMA de uma comanda ou de um botão (ex.: o
      // indicador de zoom, que fica dentro do próprio viewport) pertence ao
      // gesto/clique dele, não ao pan do canvas — sem esse filtro, o pan
      // "roubava" o pointer do botão e o clique falhava de vez em quando.
      if ((e.target as HTMLElement).closest(".pedido-ticket, button")) return;
      // Arrastar sobre texto tende a iniciar uma seleção nativa do navegador
      // que "gruda" e trava o próximo arrasto até clicar fora pra limpar —
      // limpa qualquer seleção existente e impede que uma nova comece aqui.
      window.getSelection()?.removeAllRanges();
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      panInicioRef.current = { x: e.clientX, y: e.clientY, panX: araraTransform.panX, panY: araraTransform.panY };
    }
  }

  function handleAraraPointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!ponteirosArara.current.has(e.pointerId)) return;
    ponteirosArara.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (ponteirosArara.current.size === 2) {
      e.preventDefault();
      const [a, b] = Array.from(ponteirosArara.current.values());
      const distAtual = Math.hypot(a.x - b.x, a.y - b.y);
      const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const fator = distAtual / (distanciaAnteriorRef.current || distAtual);
      distanciaAnteriorRef.current = distAtual;
      aplicarZoomAraraRelativo(pontoNaArara(midpoint.x, midpoint.y), fator);
    } else if (ponteirosArara.current.size === 1 && panInicioRef.current) {
      const inicio = panInicioRef.current;
      const { panX, panY } = limitarPanArara(
        inicio.panX + (e.clientX - inicio.x),
        inicio.panY + (e.clientY - inicio.y),
        araraTransform.scale,
      );
      setAraraTransform((prev) => ({ ...prev, panX, panY }));
    }
  }

  function handleAraraPointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    ponteirosArara.current.delete(e.pointerId);
    if (ponteirosArara.current.size < 2) distanciaAnteriorRef.current = 0;
    if (ponteirosArara.current.size === 0) panInicioRef.current = null;
  }

  function handleAraraWheel(e: ReactWheelEvent<HTMLDivElement>) {
    if (!e.ctrlKey) return; // pinça de trackpad chega como wheel+ctrlKey
    e.preventDefault();
    aplicarZoomAraraRelativo(pontoNaArara(e.clientX, e.clientY), 1 - e.deltaY * 0.012);
  }

  function handleAraraDoubleClick(e: ReactMouseEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest(".pedido-ticket, button")) return;
    setAraraTransform({ scale: 1, panX: 0, panY: 0 });
  }

  // O primeiro pedido da fila sempre nasce no canto (20,20) do conteúdo do
  // canvas — voltar zoom/pan pra identidade já é "ir pro primeiro pedido".
  const voltarParaPrimeiroPedido = useCallback(() => {
    setAraraTransform({ scale: 1, panX: 0, panY: 0 });
  }, []);

  const zoomAraraAtivo =
    araraTransform.scale !== 1 || Math.abs(araraTransform.panX) > 1 || Math.abs(araraTransform.panY) > 1;

  // ── Arrastar uma comanda entre as outras pra reordenar ──
  // O alvo (sobre qual "slot" o dedo está) é calculado ANALITICAMENTE a
  // partir da posição do ponteiro + as constantes de layout acima, em vez de
  // medir getBoundingClientRect() dos vizinhos — porque durante o arrasto os
  // vizinhos entre a origem e o alvo já estão ANIMANDO um translateX próprio
  // (o efeito de "abrir espaço"), e medir o retângulo deles nesse instante
  // pegaria a posição visual (em animação), não a posição lógica real —
  // fazendo o alvo detectado ficar instável bem no meio do gesto.
  const [arrasto, setArrasto] = useState<{
    id: string;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    alvoAntesDeId: string | null; // null = vai pro final da fila
  } | null>(null);
  // Ref síncrona espelhando o essencial do arrasto — usada só pra decidir,
  // já no primeiro pointermove, se o gesto pertence a um arrasto real, sem
  // depender do React já ter repassado o `arrasto` (state) de volta pro
  // closure. Vale tanto pra fase "pendente" (antes do limiar) quanto pro
  // arrasto já confirmado.
  const arrastoPendenteRef = useRef<{ id: string; startX: number; startY: number } | null>(null);
  const arrastoAtivoRef = useRef<{ id: string; startX: number; startY: number } | null>(null);

  const iniciarArrastoReordenar = useCallback((id: string, clientX: number, clientY: number) => {
    arrastoPendenteRef.current = { id, startX: clientX, startY: clientY };
  }, []);

  const moverArrastoReordenar = useCallback((id: string, clientX: number, clientY: number) => {
    let base = arrastoAtivoRef.current;
    if (!base || base.id !== id) {
      const pendente = arrastoPendenteRef.current;
      if (!pendente || pendente.id !== id) return;
      const offX = clientX - pendente.startX;
      const offY = clientY - pendente.startY;
      if (Math.hypot(offX, offY) < LIMIAR_ARRASTO_REORDENAR) return; // ainda é só um toque
      base = pendente;
      arrastoAtivoRef.current = base;
    }

    const offsetX = clientX - base.startX;
    const offsetY = clientY - base.startY;

    const listaVisivel = filaVisivel.map((item) => String(item.pedido.order_id));
    const origIdx = listaVisivel.indexOf(id);

    let novoAlvo: string | null = null;
    if (origIdx !== -1 && listaVisivel.length > 0) {
      // Baseado no deslocamento TOTAL desde onde a comanda foi pega, não na
      // posição absoluta do dedo — arredondar (em vez de floor) faz a troca
      // acontecer na METADE do caminho até o limiar de sensibilidade, que já
      // é bem menor que o card inteiro. Escala com o zoom do canvas: 1 passo
      // na tela vale menos pixels de dedo quando está tudo mais afastado.
      const passoNaTela = PASSO_SENSIBILIDADE_TROCA * araraTransform.scale;
      const passosDeslocados = Math.round(offsetX / passoNaTela);
      const indiceAlvo = Math.max(0, Math.min(listaVisivel.length - 1, origIdx + passosDeslocados));
      // Sobre o próprio slot original = "não mudou nada": aponta pro vizinho
      // seguinte (equivalente a ficar no lugar), nunca pra si mesmo — senão
      // o soltar não acharia o id (ele é excluído da lista de candidatos) e
      // a comanda acabaria indo parar no final da fila por engano.
      novoAlvo = indiceAlvo === origIdx ? (listaVisivel[origIdx + 1] ?? null) : listaVisivel[indiceAlvo];
    }

    setArrasto({ id, startX: base.startX, startY: base.startY, offsetX, offsetY, alvoAntesDeId: novoAlvo });
  }, [filaVisivel, araraTransform.scale]);

  // A posição final já foi decidida continuamente durante o arrasto
  // (arrasto.alvoAntesDeId) — no soltar só aplica o que já estava sendo
  // mostrado como indicador visual, sem recalcular nada por conta própria.
  const finalizarArrastoReordenar = useCallback((id: string) => {
    arrastoPendenteRef.current = null;
    arrastoAtivoRef.current = null;
    setArrasto((prev) => {
      if (prev && prev.id === id) {
        const alvoAntesDeId = prev.alvoAntesDeId;
        setOrdemManual((prevOrdem) => {
          const baseCompleta = prevOrdem.length > 0 ? prevOrdem : filaCalculada.map((item) => String(item.pedido.order_id));
          const outros = baseCompleta.filter((x) => x !== id);
          const indiceDestino = alvoAntesDeId ? outros.indexOf(alvoAntesDeId) : -1;
          outros.splice(indiceDestino === -1 ? outros.length : indiceDestino, 0, id);
          return outros;
        });
      }
      return null;
    });
  }, [filaCalculada]);

  return (
    <div className={`cozinha-dashboard${emFoco ? " em-foco" : ""}`} ref={containerRef}>
      <div className="cozinha-cabecalho">
        <div className="cozinha-data-hoje">
          <MdCalendarToday size={15} aria-hidden="true" />
          <span>Hoje, {formatarDataCompletaPorExtenso(new Date(agoraMs))}</span>
        </div>
        <button type="button" className="cozinha-foco-btn" onClick={alternarModoFoco}>
          {emFoco ? <MdFullscreenExit size={18} /> : <MdFullscreen size={18} />}
          {emFoco ? "Sair do modo foco" : "Modo foco"}
        </button>
      </div>

      <div className="cozinha-toolbar">
        <div className="cozinha-filtros" role="tablist" aria-label="Filtrar fila da cozinha">
          <button className={filtro === "todos" ? "active" : ""} onClick={() => setFiltro("todos")}>
            Todos <span className="cozinha-filtro-count">{filaCalculada.length}</span>
          </button>
          <button className={filtro === "atrasados" ? "active" : ""} onClick={() => setFiltro("atrasados")}>
            Atrasados <span className="cozinha-filtro-count">{totalAtrasados}</span>
          </button>
          <button className={filtro === "proximos" ? "active" : ""} onClick={() => setFiltro("proximos")}>
            Próximos <span className="cozinha-filtro-count">{totalProximos}</span>
          </button>
        </div>

        <div className="cozinha-toolbar-direita">
          <button type="button" className="cozinha-ir-inicio" onClick={voltarParaPrimeiroPedido}>
            <MdFirstPage size={16} /> Primeiro pedido
          </button>
          {ordemManual.length > 0 && (
            <button type="button" className="cozinha-reset-ordem" onClick={() => setOrdemManual([])}>
              <MdSync size={14} /> Ordem automática
            </button>
          )}
          {totalAtrasados > 0 && (
            <span className="cozinha-alerta-atrasados">
              ⚠ {totalAtrasados} pedido{totalAtrasados > 1 ? "s" : ""} atrasado{totalAtrasados > 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>

      {filaVisivel.length === 0 ? (
        <div className="cozinha-vazio">
          <MdRestaurantMenu size={48} aria-hidden="true" />
          <p>{filtro === "todos" ? "Nenhum pedido para preparar agora 🎉" : "Nenhum pedido nesse filtro."}</p>
        </div>
      ) : (
        <div
          ref={araraViewportRef}
          className="cozinha-arara-viewport"
          onPointerDown={handleAraraPointerDown}
          onPointerMove={handleAraraPointerMove}
          onPointerUp={handleAraraPointerUp}
          onPointerCancel={handleAraraPointerUp}
          onWheel={handleAraraWheel}
          onDoubleClick={handleAraraDoubleClick}
        >
          <div
            ref={araraConteudoRef}
            className="cozinha-arara"
            style={{ transform: `translate(${araraTransform.panX}px, ${araraTransform.panY}px) scale(${araraTransform.scale})` }}
          >
            {(() => {
              // Calculados uma vez só (não a cada comanda) — quem está entre
              // a origem e o alvo do arrasto desliza um slot pra abrir espaço;
              // o efeito de "o vizinho vai pro lugar de quem eu tô segurando"
              // (e volta, se eu voltar) sai puro dessa comparação de índices.
              const origIdx = arrasto ? filaVisivel.findIndex((item) => String(item.pedido.order_id) === arrasto.id) : -1;
              const targetIdx = arrasto
                ? arrasto.alvoAntesDeId
                  ? filaVisivel.findIndex((item) => String(item.pedido.order_id) === arrasto.alvoAntesDeId)
                  : filaVisivel.length
                : -1;

              return filaVisivel.map(({ pedido }, myIdx) => {
                const idStr = String(pedido.order_id);
                const ehArrastado = arrasto?.id === idStr;
                let shiftX = 0;
                if (arrasto && !ehArrastado) {
                  if (origIdx < targetIdx && myIdx > origIdx && myIdx < targetIdx) {
                    shiftX = -PASSO_SLOT; // fecha o espaço deixado pela comanda arrastada
                  } else if (origIdx > targetIdx && myIdx >= targetIdx && myIdx < origIdx) {
                    shiftX = PASSO_SLOT; // abre espaço pra ela entrar
                  }
                }

                return (
                  <div
                    key={idStr}
                    style={{
                      transform: `translateX(${shiftX}px)`,
                      transition: arrasto && !ehArrastado ? "transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1)" : "none",
                      position: "relative",
                      zIndex: ehArrastado ? 999 : 1,
                    }}
                  >
                    <PedidoTicket
                      pedido={pedido}
                      agoraMs={agoraMs}
                      onToggleItem={toggleItem}
                      onConcluir={concluirPedido}
                      arrastoOffset={ehArrastado && arrasto ? { x: arrasto.offsetX, y: arrasto.offsetY } : null}
                      onIniciarArrasto={iniciarArrastoReordenar}
                      onMoverArrasto={moverArrastoReordenar}
                      onFinalizarArrasto={finalizarArrastoReordenar}
                    />
                  </div>
                );
              });
            })()}
          </div>

          <button
            type="button"
            className="cozinha-zoom-indicador"
            onClick={voltarParaPrimeiroPedido}
            title="Restaurar zoom"
          >
            <MdZoomOutMap size={13} /> {Math.round(araraTransform.scale * 100)}%{zoomAraraAtivo ? " · restaurar" : ""}
          </button>
        </div>
      )}

      {concluidosHoje.length > 0 && (
        <div className="cozinha-concluidos">
          <p className="cozinha-concluidos-titulo">Concluídos hoje ({concluidosHoje.length})</p>
          <div className="cozinha-concluidos-lista">
            {concluidosHoje.map((p) => (
              <button
                key={p.order_id}
                type="button"
                className="cozinha-chip-concluido"
                onClick={() => reabrirPedido(p)}
                title="Toque para reabrir na fila"
              >
                <MdReplay size={14} />#{p.order_id} — {toTitleCase(p.nome_destinatario)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default CozinhaDashboard;

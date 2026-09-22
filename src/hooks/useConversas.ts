// src/hooks/useConversas.ts
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { collection, doc, getDoc, onSnapshot, orderBy, limit, query, where, Timestamp, type DocumentData } from "firebase/firestore";
import { db } from "../services/firebase";
import type { Conversa, Mensagem } from "../types/chat.types";

import { apiFetch, BASE_URL } from "../services/api";

// Teto do listener ao vivo — ver comentário na assinatura do efeito abaixo.
const JANELA_CONVERSAS_RECENTES = 200;

// Mesma regra de functions/src/lib/util.js (variantesNumero) — números BR
// existem no Firestore ora com o 9º dígito, ora sem (a normalização mudou
// ao longo do tempo). Sem tentar as duas variantes aqui, uma conversa
// achada pela busca podia apontar pro ID errado e nunca abrir.
function variantesTelefone(numero: string): string[] {
  const variantes = new Set([numero]);
  if (numero.startsWith("55") && numero.length === 13) {
    const ddd = numero.slice(2, 4);
    const resto = numero.slice(4);
    if (resto.length === 9 && resto[0] === "9") variantes.add("55" + ddd + resto.slice(1));
  }
  if (numero.startsWith("55") && numero.length === 12) {
    const ddd = numero.slice(2, 4);
    const resto = numero.slice(4);
    variantes.add("55" + ddd + "9" + resto);
  }
  return Array.from(variantes);
}

export function useConversas(activeChatId: string | null) {
  const [conversas, setConversas] = useState<Conversa[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [pedidoSearchResults, setPedidoSearchResults] = useState<{
    orderId: string;
    nome: string;
    telefone: string;
    status: number;
    total: string;
    bairro: string;
    dataVenda: string;
  }[]>([]);
  const [contatoSearchResults, setContatoSearchResults] = useState<{
    id: string;
    clientName: string;
    phone: string;
  }[]>([]);

  const pedidoSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contatoSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeChatIdRef = useRef<string | null>(null);
  // ID sets por listener — necessário pra saber, quando um doc "some" de UM
  // dos dois listeners (janela recente / fixadas), se ele ainda pertence ao
  // outro antes de removê-lo do estado unificado (ver efeitos abaixo).
  const idsJanelaRef = useRef<Set<string>>(new Set());
  const idsFixadasRef = useRef<Set<string>>(new Set());

  // Mantém a ref atualizada para o onSnapshot ler sem recriar o listener.
  // Isso sozinho não bastava pra ações que TROCAM o chat ativo e GRAVAM
  // unreadCount no mesmo gesto (ex.: "marcar como não lida" fecha a
  // conversa e escreve um unreadCount > 0 ao mesmo tempo): o efeito só
  // atualiza a ref depois de um re-render, e o onSnapshot do Firestore pode
  // disparar ANTES disso, com a ref ainda apontando pro chat que acabou de
  // fechar — mapearConversa então zera de volta o unreadCount que a gente
  // tinha acabado de gravar de propósito. sincronizarChatAtivoAgora existe
  // pra quem precisa da ordem garantida: atualiza a ref na hora, sem
  // esperar o ciclo de render.
  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  const sincronizarChatAtivoAgora = useCallback((id: string | null) => {
    activeChatIdRef.current = id;
  }, []);

  // ─── CARREGAR CONVERSAS DO FIRESTORE ───
  // Usa docChanges() em vez de remapear snapshot.docs inteiro a cada evento:
  // com dezenas/centenas de conversas, uma mensagem nova em UMA conversa
  // disparava o recálculo de TODAS elas a cada disparo do listener (e Isso
  // era o gargalo real de performance, não só de uma tecla digitada). Aqui
  // só a(s) conversa(s) que de fato mudaram são remapeadas; as outras mantêm
  // a mesma referência de objeto de antes.
  const mapearConversa = useMemo(() => (id: string, data: DocumentData): Conversa => {
    const limiteAtividade = Date.now() - (15 * 60 * 1000);
    const ultimoContato = data.timestamp ? data.timestamp.toMillis() : 0;
    const isAtivo = id === activeChatIdRef.current;

    return {
      id,
      clientName: data.clientName || "Cliente",
      phone: data.phone || "Sem número",
      lastMessage: data.lastMessage || "",
      time: data.time || "",
      unreadCount: isAtivo ? 0 : (data.unreadCount || 0),
      hasCallPermission: data.hasCallPermission || false,
      tags: data.tags || [],
      pedidoHoje: data.pedidoHoje || null,
      enderecos: data.enderecos || [],
      totalOrders: data.totalOrders || 0,
      ltv: data.ltv || "R$ 0,00",
      datasHistorico: data.datasHistorico ? data.datasHistorico.map((ts: Timestamp) => ts.toDate()) : [],
      messages: [],
      isOnline: ultimoContato > limiteAtividade,
      finalizado: data.finalizado || false,
      pinned: data.pinned || false,
      lastIncomingAt: data.lastIncomingAt ?? null,
      lastMessageAt: data.lastMessageAt ?? data.lastIncomingAt ?? null,
      lastMessageSender: data.lastMessageSender ?? null,
      lastMessageStatus: data.lastMessageStatus ?? null,
      lastMessageIsAlteracao: data.lastMessageIsAlteracao ?? false,
      pedidosBloqueados: data.pedidosBloqueados === true,
      pedidosBloqueadosEm: data.pedidosBloqueadosEm ?? null,
      lastOrderType: data.lastOrderType ?? null,
      lastOrderAt: data.lastOrderAt ?? null,
    } as Conversa;
  }, []);

  // Baixar a coleção inteira de conversas toda vez que o Chat abre travava a
  // aba (era literalmente TODO cliente que já mandou mensagem, sem limite —
  // ver auditoria de performance). Agora o listener ao vivo cobre só as
  // ~200 conversas com atividade mais recente; fixadas entram sempre, mesmo
  // fora dessa janela. Uma conversa mais antiga que isso ainda é encontrável
  // pela busca (contatoSearchResults, via backend) — só não fica pré-carregada.
  useEffect(() => {
    const qJanela = query(
      collection(db, "conversas"),
      orderBy("lastMessageAt", "desc"),
      limit(JANELA_CONVERSAS_RECENTES),
    );
    const unsubscribe = onSnapshot(qJanela, (snapshot) => {
      setConversas(prev => {
        const porId = new Map(prev.map(c => [c.id, c]));
        for (const change of snapshot.docChanges()) {
          if (change.type === "removed") {
            idsJanelaRef.current.delete(change.doc.id);
            if (!idsFixadasRef.current.has(change.doc.id)) porId.delete(change.doc.id);
          } else {
            idsJanelaRef.current.add(change.doc.id);
            porId.set(change.doc.id, mapearConversa(change.doc.id, change.doc.data()));
          }
        }
        return Array.from(porId.values());
      });
    });
    return () => unsubscribe();
  }, [mapearConversa]);

  useEffect(() => {
    const qFixadas = query(collection(db, "conversas"), where("pinned", "==", true));
    const unsubscribe = onSnapshot(qFixadas, (snapshot) => {
      setConversas(prev => {
        const porId = new Map(prev.map(c => [c.id, c]));
        for (const change of snapshot.docChanges()) {
          if (change.type === "removed") {
            idsFixadasRef.current.delete(change.doc.id);
            if (!idsJanelaRef.current.has(change.doc.id)) porId.delete(change.doc.id);
          } else {
            idsFixadasRef.current.add(change.doc.id);
            porId.set(change.doc.id, mapearConversa(change.doc.id, change.doc.data()));
          }
        }
        return Array.from(porId.values());
      });
    });
    return () => unsubscribe();
  }, [mapearConversa]);

  // Selecionar uma conversa achada pela busca (fora da janela dos 200 mais
  // recentes) só fazia setActiveChatId — mas a tela mostra a conversa
  // procurando o id dentro de `conversas`, que nunca continha esse item.
  // Resultado: a tela ficava presa em "Escolha um cliente", como se o
  // clique não tivesse feito nada. Isso busca o documento avulso (tentando
  // as duas variantes de 8/9 dígitos) e injeta no estado unificado. Devolve
  // o id de fato encontrado, que pode diferir do id clicado se a variante
  // certa for a outra.
  const garantirConversaCarregada = useCallback(async (
    id: string,
  ): Promise<{ id: string; encontrada: boolean }> => {
    if (idsJanelaRef.current.has(id) || idsFixadasRef.current.has(id)) {
      return { id, encontrada: true };
    }
    try {
      for (const variante of variantesTelefone(id)) {
        const snap = await getDoc(doc(db, "conversas", variante));
        if (snap.exists()) {
          const conversa = mapearConversa(variante, snap.data());
          setConversas(prev => {
            const index = prev.findIndex(c => c.id === variante);
            if (index < 0) return [...prev, conversa];
            const next = [...prev];
            next[index] = conversa;
            return next;
          });
          return { id: variante, encontrada: true };
        }
      }
    } catch (err) {
      console.error("Erro ao carregar conversa avulsa:", err);
    }
    return { id, encontrada: false };
  }, [mapearConversa]);

  // ─── ORDENAÇÃO DAS CONVERSAS ───
  const conversasOrdenadas = useMemo(() => {
    return [...conversas]
      .filter(c => !c.finalizado)
      .sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        const ta = a.lastMessageAt?.toMillis?.() ?? 0;
        const tb = b.lastMessageAt?.toMillis?.() ?? 0;
        return tb - ta;
      });
  }, [conversas]);

  // ─── BUSCA LOCAL ───
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return { contatos: [], mensagens: [] };
    const term = searchQuery.toLowerCase();
    
    const contatos = conversas.filter(c =>
      c.clientName.toLowerCase().includes(term) ||
      c.phone.includes(term) ||
      (c.pedidoHoje?.id && c.pedidoHoje.id.includes(term)) ||
      (c.enderecos?.some(e => e.bairro.toLowerCase().includes(term)))
    );
    
    const mensagens: { chatId: string; clientName: string; msg: Mensagem }[] = [];
    conversas.forEach(chat => {
      chat.messages.forEach(m => {
        if (m.text.toLowerCase().includes(term)) {
          mensagens.push({ chatId: chat.id, clientName: chat.clientName, msg: m });
        }
      });
    });
    return { contatos, mensagens };
  }, [searchQuery, conversas]);

  // ─── BUSCA DE PEDIDOS NO BACKEND ───
  useEffect(() => {
    if (pedidoSearchTimerRef.current) clearTimeout(pedidoSearchTimerRef.current);
    const term = searchQuery.trim();
    if (term.length < 3) { setPedidoSearchResults([]); return; }
    
    pedidoSearchTimerRef.current = setTimeout(async () => {
      try {
        const resp = await apiFetch(`${BASE_URL}/conversas`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "buscarPorPedido", termo: term })
        });
        const data = await resp.json();
        if (data.resultados) setPedidoSearchResults(data.resultados);
        else setPedidoSearchResults([]);
      } catch (err) {
        console.error("Erro na busca por pedido:", err);
        setPedidoSearchResults([]);
      }
    }, 400);
  }, [searchQuery]);

  // ─── BUSCA DE CONTATOS ANTIGOS NO BACKEND ───
  // A busca local (searchResults.contatos) só enxerga as ~200 conversas
  // carregadas ao vivo. Isso cobre quem ficou de fora dessa janela.
  useEffect(() => {
    if (contatoSearchTimerRef.current) clearTimeout(contatoSearchTimerRef.current);
    const term = searchQuery.trim();
    if (term.length < 3) { setContatoSearchResults([]); return; }

    contatoSearchTimerRef.current = setTimeout(async () => {
      try {
        const resp = await apiFetch(`${BASE_URL}/conversas`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "buscarContatos", termo: term })
        });
        const data = await resp.json();
        if (data.resultados) setContatoSearchResults(data.resultados);
        else setContatoSearchResults([]);
      } catch (err) {
        console.error("Erro na busca de contatos:", err);
        setContatoSearchResults([]);
      }
    }, 400);
  }, [searchQuery]);

  return {
    conversas,
    setConversas,
    conversasOrdenadas,
    searchQuery,
    setSearchQuery,
    searchResults,
    pedidoSearchResults,
    contatoSearchResults,
    garantirConversaCarregada,
    sincronizarChatAtivoAgora,
  };
}

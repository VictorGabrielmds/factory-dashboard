// src/components/ChatDashboard/ChatDashboard.tsx
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { getToken, onMessage } from "firebase/messaging";
import "./ChatDashboard.css";
import {
  MdSend, MdKeyboardArrowDown,
  MdInsertEmoticon, MdAttachFile, MdImage,
  MdMoreVert, MdBolt, MdCheckCircle, MdClose,
  MdSearch, MdLabel, MdEdit, MdDelete,
  MdPushPin, MdOutlineMic, MdArrowBack, MdReply,
  MdLocationOn, MdForward,
  MdPictureAsPdf, MdDescription, MdTableChart, MdSlideshow,
  MdFolderZip, MdInsertDriveFile, MdFileDownload, MdMic, MdPhoto,
  MdForum, MdArrowForward, MdLockOutline,
} from "react-icons/md";
import {
  collection, onSnapshot, query, orderBy, limitToLast,
  doc, updateDoc, arrayUnion, setDoc, getDoc,
} from "firebase/firestore";
import { db, getMessagingLazy, getStorageLazy } from "../../services/firebase";
import somNotificacao from "../../assets/sounds/notification.mp3";

// ─── HOOKS ───
import { useConversas } from "../../hooks/useConversas";
import { useAudioRecorder } from "../../hooks/useAudioRecorder";

// ─── COMPONENTES FILHOS ───
import ChatSidebar from "./components/Sidebar/ChatSidebar";
import ContextPanel, { type PedidoDetalheData } from "./components/ContextPanel/ContextPanel";
import PainelPendencias from "./components/Pendencias/PainelPendencias";
import ModalFinalizar from "./components/Modals/ModalFinalizar";
import ModalFrases from "./components/Modals/ModalFrases";
import ModalTags from "./components/Modals/ModalTags";
import ModalAplicarTags from "./components/Modals/ModalAplicarTags";
import ModalIniciarConversa from "./components/Modals/ModalIniciarConversa";
import ModalBase from "../ModalBase/ModalBase";
import DatePicker from "react-datepicker";

import type {
  Conversa, Mensagem, PendenciaTipo, Pendencia,
  FrasePredefinida, TagGlobal, Template,
} from "../../types/chat.types";

import {
  FRASES_PADRAO, TAGS_PADRAO, COMMON_EMOJIS,
  getGroupClass, getTagClass, calcularJanela24h
} from "../../utils/chatHelpers";

import { Avatar, MessageStatus, TypingIndicator } from "./components/Shared/ChatUI";
import AudioPlayer from "./components/Shared/AudioPlayer";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";

// Toda comunicação com o backend passa pelo módulo de API (sessão Firebase, timeout, retry)
import { apiFetch, BASE_URL } from "../../services/api";
import { useToast } from "../../contexts/ToastContext";

type ConfigPayload = Record<string, unknown>;

// Mensagem exibida antes da confirmação do backend (bolha otimista, com reloginho)
type MensagemOtimista = Mensagem & { clientId: string; chatId: string };

const CHAVE_MENSAGENS_FALHAS = "chatDashboard:mensagensFalhas";

function horaAgora(): string {
  return new Date().toLocaleTimeString("pt-BR", {
    hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo",
  });
}

// Traduz o erro cru (timeout, rede caída, ou a mensagem que o backend devolveu)
// num texto curto e legível para mostrar perto da mensagem que falhou.
function descreverErroEnvio(err: unknown): string {
  if (err instanceof DOMException && err.name === "AbortError") return "Tempo de resposta esgotado";
  if (err instanceof TypeError) return "Sem conexão com o servidor";
  if (err instanceof Error && err.message) return err.message;
  return "Falha desconhecida ao enviar";
}

type EstadoOutbox = "pendente" | "enviando" | "enviado" | "erro";

// Envia uma mensagem gravando um item em outbox/ pelo SDK do Firestore, em
// vez de chamar o endpoint HTTP direto — o SDK enfileira a escrita sozinho
// quando a internet do operador está ruim/caiu (nunca "perde" a mensagem
// esperando uma resposta HTTP que não vem) e o gatilho processarOutbox
// (functions/src/triggers/outbox.js) entrega com retry automático,
// dedupe por ID do documento (sem risco de mandar 2x pro WhatsApp do
// cliente). O ID gerado aqui vira tanto o ID do item do outbox quanto o
// `clientId` da mensagem real, quando ela chegar — é isso que permite a
// bolha otimista sumir sozinha (ver efeito de activeMessages mais abaixo).
function enviarViaOutbox(
  payload: {
    telefone: string;
    texto?: string;
    mediaUrl?: string | null;
    mediaType?: string | null;
    replyToMsgId?: string | null;
  },
  onEstado?: (estado: EstadoOutbox, dados: Record<string, unknown>) => void,
): { itemId: string; resultado: Promise<string> } {
  const itemId = crypto.randomUUID();
  const ref = doc(db, "outbox", itemId);

  setDoc(ref, {
    telefone: payload.telefone,
    texto: payload.texto ?? "",
    ...(payload.mediaUrl ? { mediaUrl: payload.mediaUrl, mediaType: payload.mediaType } : {}),
    ...(payload.replyToMsgId ? { replyToMsgId: payload.replyToMsgId } : {}),
  }).catch(() => {
    // Falha aqui é erro de permissão/validação, nunca de rede — o SDK
    // enfileira local e sincroniza quando a conexão voltar. Um erro de
    // verdade (ex.: telefone inválido pela regra do Firestore) não gera
    // nenhum documento, então o listener abaixo nunca recebe snapshot; quem
    // fecha esse caso é o timeout natural de quem chamou (mostra "falhou").
  });

  const resultado = new Promise<string>((resolve, reject) => {
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        const dados = snap.data() ?? {};
        const estado = (dados.estado as EstadoOutbox | undefined) ?? "pendente";
        onEstado?.(estado, dados);
        if (estado === "enviado") {
          unsubscribe();
          resolve(String(dados.msgId ?? ""));
        } else if (estado === "erro") {
          unsubscribe();
          reject(new Error(String(dados.erro ?? "Falha ao enviar.")));
        }
      },
      (err) => {
        unsubscribe();
        reject(err);
      },
    );
  });

  return { itemId, resultado };
}

function extensaoDoArquivo(nomeOuUrl?: string | null): string {
  if (!nomeOuUrl) return "";
  const semQuery = nomeOuUrl.split("?")[0];
  const partes = semQuery.split(".");
  return partes.length > 1 ? partes[partes.length - 1].toLowerCase() : "";
}

function IconeDocumento({ extensao }: { extensao: string }) {
  if (extensao === "pdf") return <MdPictureAsPdf size={26} />;
  if (["doc", "docx", "odt", "rtf", "txt"].includes(extensao)) return <MdDescription size={26} />;
  if (["xls", "xlsx", "csv", "ods"].includes(extensao)) return <MdTableChart size={26} />;
  if (["ppt", "pptx", "odp"].includes(extensao)) return <MdSlideshow size={26} />;
  if (["zip", "rar", "7z"].includes(extensao)) return <MdFolderZip size={26} />;
  return <MdInsertDriveFile size={26} />;
}

const ROTULOS_MIDIA_CITACAO: Partial<Record<NonNullable<Mensagem["mediaType"]>, { icon: React.ReactNode; label: string }>> = {
  audio: { icon: <MdMic size={12} />, label: "Áudio" },
  image: { icon: <MdPhoto size={12} />, label: "Imagem" },
  sticker: { icon: <MdPhoto size={12} />, label: "Figurinha" },
  video: { icon: <MdPhoto size={12} />, label: "Vídeo" },
  document: { icon: <MdInsertDriveFile size={12} />, label: "Documento" },
  location: { icon: <MdLocationOn size={12} />, label: "Localização" },
};

// Citação da mensagem original, mostrada acima do texto/mídia de uma resposta.
// Prioriza o texto (inclusive legenda de mídia); só cai pro rótulo do tipo de
// mídia quando não há texto nenhum — antes disso era sempre "Mídia" genérico.
function QuotedReply({ original }: { original: Mensagem }) {
  if (original.text) {
    return <div className="quoted-reply">{original.text.slice(0, 80)}</div>;
  }
  const midia = original.mediaType ? ROTULOS_MIDIA_CITACAO[original.mediaType] : undefined;
  return (
    <div className="quoted-reply">
      {midia ? <span className="quoted-reply-media">{midia.icon} {midia.label}</span> : "Mensagem"}
    </div>
  );
}

const MESSAGE_TOKEN_PATTERN =
  /(https?:\/\/[^\s<]+|www\.[^\s<]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s<]*)?|\+?\d[\d \t().-]{9,}\d)/gi;

function isBrazilianMobileNumber(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  const national = digits.length === 13 && digits.startsWith("55") ? digits.slice(2) : digits;
  if (national.length !== 11 || national[2] !== "9") return false;
  const areaCode = Number(national.slice(0, 2));
  return areaCode >= 11 && areaCode <= 99;
}

function normalizeConversationPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits.length <= 11 ? `55${digits}` : digits;
}

function createPhoneConversation(id: string, displayPhone: string): Conversa {
  return {
    id,
    clientName: displayPhone,
    phone: id,
    lastMessage: "",
    time: "",
    unreadCount: 0,
    hasCallPermission: false,
    tags: [],
    pedidoHoje: null,
    enderecos: [],
    totalOrders: 0,
    ltv: "R$ 0,00",
    messages: [],
    isOnline: false,
    finalizado: false,
    pinned: false,
    lastIncomingAt: null,
    lastMessageAt: null,
    pedidosBloqueados: false,
  };
}

function hasSavedContactName(name: string | null | undefined): boolean {
  const normalized = name?.trim().toLocaleLowerCase("pt-BR") ?? "";
  return normalized !== "" && normalized !== "cliente" && normalized !== "sem nome";
}

type ChatSelectionOptions = {
  // Ao iniciar uma conversa, o nome digitado pelo operador é uma escolha
  // explícita. Ele deve aparecer imediatamente, mesmo que o número já tenha
  // um contato salvo com outro nome.
  preferFallbackName?: boolean;
};

function splitUrlPunctuation(value: string): { url: string; suffix: string } {
  const match = value.match(/[),.!?;:\]]+$/);
  if (!match) return { url: value, suffix: "" };
  return {
    url: value.slice(0, -match[0].length),
    suffix: match[0],
  };
}

function RichMessageText({
  text,
  onPhoneClick,
}: {
  text: string;
  onPhoneClick: (phone: string) => void;
}) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  MESSAGE_TOKEN_PATTERN.lastIndex = 0;

  while ((match = MESSAGE_TOKEN_PATTERN.exec(text)) !== null) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    const token = match[0];
    const looksLikeUrl = /^(?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,})/i.test(token);

    if (looksLikeUrl) {
      const { url, suffix } = splitUrlPunctuation(token);
      const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      parts.push(
        <a
          key={`url-${match.index}`}
          className="message-auto-link"
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          onClick={event => event.stopPropagation()}
          onDoubleClick={event => event.stopPropagation()}
        >
          {url}
        </a>,
      );
      if (suffix) parts.push(suffix);
    } else if (isBrazilianMobileNumber(token)) {
      parts.push(
        <button
          key={`phone-${match.index}`}
          type="button"
          className="message-phone-link"
          title="Iniciar conversa com este número"
          onClick={event => {
            event.stopPropagation();
            onPhoneClick(token);
          }}
          onDoubleClick={event => event.stopPropagation()}
        >
          {token}
        </button>,
      );
    } else {
      parts.push(token);
    }

    cursor = match.index + token.length;
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return <span className="bubble-text">{parts}</span>;
}

export default function ChatDashboard() {
  const { addToast } = useToast();
  // ─── ESTADOS DE UI ───
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [abaAtiva, setAbaAtiva] = useState<"todas" | "naoLidas">("todas");
  const [activeMessages, setActiveMessages] = useState<Mensagem[]>([]);
  const [inputText, setInputText] = useState("");
  const [pendencias, setPendencias] = useState<Pendencia[]>([]);
  const [frasesPredefinidas, setFrasesPredefinidas] = useState<FrasePredefinida[]>(FRASES_PADRAO);
  const [tagsGlobais, setTagsGlobais] = useState<TagGlobal[]>(TAGS_PADRAO);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [figurinhasSalvas, setFigurinhasSalvas] = useState<{ url: string; de: string }[]>([]);
  const [stickerTab, setStickerTab] = useState<"emojis" | "salvas">("emojis");
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [mediaViewer, setMediaViewer] = useState<{ url: string, type: 'image' | 'document' } | null>(null);
  const [pedidoDetalhe, setPedidoDetalhe] = useState<PedidoDetalheData | null>(null);
  const [isZoomed, setIsZoomed] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Mensagem | null>(null);
  const [editingMsg, setEditingMsg] = useState<Mensagem | null>(null);
  const [forwardingMsg, setForwardingMsg] = useState<Mensagem | null>(null);
  const [forwardPhone, setForwardPhone] = useState("");
  const [isForwarding, setIsForwarding] = useState(false);
  const [forwardListOpen, setForwardListOpen] = useState(false);
  const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null);
  // Restaura mensagens que falharam antes de um refresh — sem isso, o aviso
  // de falha e o botão de reenviar sumiam junto com a página, perdendo a
  // mensagem em silêncio (o idempotencyKey continua o mesmo, então reenviar
  // depois de restaurado é seguro).
  const [optimisticMessages, setOptimisticMessages] = useState<MensagemOtimista[]>(() => {
    try {
      const salvo = localStorage.getItem(CHAVE_MENSAGENS_FALHAS);
      return salvo ? (JSON.parse(salvo) as MensagemOtimista[]) : [];
    } catch {
      return [];
    }
  });
  const [suprimirAnimacaoEntrada, setSuprimirAnimacaoEntrada] = useState(false);
  const [prontoParaExibir, setProntoParaExibir] = useState(true);
  const [labelDiaFixo, setLabelDiaFixo] = useState<string | null>(null);

  // ─── HOOKS CUSTOMIZADOS ───
  const {
    conversas, setConversas, conversasOrdenadas,
    searchQuery, setSearchQuery, searchResults, pedidoSearchResults, contatoSearchResults,
    garantirConversaCarregada, sincronizarChatAtivoAgora,
  } = useConversas(activeChatId);

  // ─── CONTROLES DE INTERFACE ───
  const [isLogisticsOpen, setIsLogisticsOpen] = useState(true);
  const [showQuickReplies, setShowQuickReplies] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [isHistoryModalOpen, setIsHistoryModalOpen] = useState(false);
  const [isFichaModalOpen, setIsFichaModalOpen] = useState(false);
  const [isContextPanelOpen, setIsContextPanelOpen] = useState(window.innerWidth > 768);
  const [showMobilePendencias, setShowMobilePendencias] = useState(false);
  const [isFinalizarOpen, setIsFinalizarOpen] = useState(false);
  const [highlightMsgId, setHighlightMsgId] = useState<string | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [quickReplyIndex, setQuickReplyIndex] = useState(-1);
  const [isSendingMedia, setIsSendingMedia] = useState(false);
  const [editNomeChatId, setEditNomeChatId] = useState<string | null>(null);
  const [editNomeValor, setEditNomeValor] = useState("");
  const [isHeaderMenuOpen, setIsHeaderMenuOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ chatId: string; x: number; y: number } | null>(null);

  // Modais de Gerenciamento
  const [isFrasesModalOpen, setIsFrasesModalOpen] = useState(false);
  const [isTagsModalOpen, setIsTagsModalOpen] = useState(false);
  const [isAplicarTagsOpen, setIsAplicarTagsOpen] = useState(false);
  const [isIniciarConversaOpen, setIsIniciarConversaOpen] = useState(false);
  const [iniciarConversaDefaults, setIniciarConversaDefaults] = useState<{
    phone: string;
    name: string;
    mode: "new" | "window-closed";
  } | null>(null);
  const [windowClock, setWindowClock] = useState(() => Date.now());
  const [isOrderBlockUpdating, setIsOrderBlockUpdating] = useState(false);

  // Refs
  const sidebarSearchRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const stickerInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevUnreadRef = useRef(0);
  const audioRef = useRef(new Audio(somNotificacao));
  const desativarOnMessageRef = useRef<(() => void) | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatHistoryRef = useRef<HTMLDivElement>(null);
  const isSendingRef = useRef(false);
  const lastMarkedReadRef = useRef<string | null>(null);
  const prevChatIdRef = useRef<string | null>(null);
  const inputAreaRef = useRef<HTMLDivElement>(null);
  const chatMainViewRef = useRef<HTMLDivElement>(null);
  const initialPhoneHandledRef = useRef(false);

  const isNearBottomRef = useRef(true);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = chatHistoryRef.current;
    if (!el) return;
    // scrollTo no próprio container é mais confiável que scrollIntoView aqui:
    // sempre mira o scrollHeight real, mesmo quando o navegador ainda está
    // terminando de desenhar uma mensagem longa (o recibo, por exemplo).
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  const activeChat = useMemo(
    () => conversas.find(c => c.id === activeChatId) ?? null,
    [conversas, activeChatId],
  );
  const manualWindowRemaining = useMemo(
    () => activeChat ? calcularJanela24h(activeChat.lastIncomingAt) : null,
    [activeChat, windowClock],
  );
  const canSendManualMessage = manualWindowRemaining !== null;
  const canSendManualMessageRef = useRef(canSendManualMessage);
  canSendManualMessageRef.current = canSendManualMessage;

  const openNewConversation = useCallback((
    phone = "",
    name = "",
    mode: "new" | "window-closed" = "new",
  ) => {
    setIniciarConversaDefaults({ phone, name, mode });
    setIsIniciarConversaOpen(true);
  }, []);

  const closeNewConversation = useCallback(() => {
    setIsIniciarConversaOpen(false);
    setIniciarConversaDefaults(null);
  }, []);

  const openTemplateForActiveChat = useCallback(() => {
    if (!activeChat) return;
    openNewConversation(activeChat.phone || activeChat.id, activeChat.clientName, "window-closed");
  }, [activeChat, openNewConversation]);

  const pendenciasDoChat = useMemo(
    () => pendencias.filter(p => p.chatId === activeChatId && !p.resolvida),
    [pendencias, activeChatId],
  );
  const totalPendenciasAbertas = useMemo(
    () => pendencias.filter(p => !p.resolvida).length,
    [pendencias],
  );

  // Esc precisa fechar só o modal na frente, nunca a conversa por trás dele —
  // sem essa checagem, apertar Esc num modal fechava os dois ao mesmo tempo.
  const algumModalAberto =
    isHistoryModalOpen || isFichaModalOpen || isFinalizarOpen ||
    isFrasesModalOpen || isTagsModalOpen || isAplicarTagsOpen ||
    isIniciarConversaOpen || !!editNomeChatId || !!forwardingMsg || !!mediaViewer;

  const forwardSuggestions = useMemo(() => {
  const q = forwardPhone.trim().toLowerCase();
  if (!q) return [];
  const qDigits = q.replace(/\D/g, "");
  return conversas
    .filter(c => {
      const nameMatch = c.clientName?.toLowerCase().includes(q);
      const phoneMatch = qDigits.length > 0 && c.phone?.replace(/\D/g, "").includes(qDigits);
      const matchesQuery = nameMatch || phoneMatch;
      // Só sugere quem ainda está dentro da janela de 24h (WhatsApp exige isso
      // para mensagens de sessão livre; fora da janela, precisaria de template).
      const janelaAberta = calcularJanela24h(c.lastIncomingAt) !== null;
      return matchesQuery && janelaAberta;
    })
    .slice(0, 6);
}, [forwardPhone, conversas]);

// Mensagens reais do Firestore + as que acabaram de ser enviadas e ainda
  // não foram confirmadas (bolha otimista, com reloginho ao lado).
  const mensagensExibidas = useMemo(() => {
    const otimistasDesteChat = optimisticMessages.filter(m => m.chatId === activeChatId);
    return [...activeMessages, ...otimistasDesteChat];
  }, [activeMessages, optimisticMessages, activeChatId]);


  // ─── FUNÇÕES DE INTEGRAÇÃO (declaradas antes dos efeitos que as usam) ───

  const uploadMidiaParaServidor = useCallback(
    async (file: Blob, mimeType: string, fileName?: string): Promise<{ url: string; mimeType: string } | null> => {
      try {
        const storage = await getStorageLazy();
        const storageRef = ref(storage, `whatsapp_midia/${Date.now()}_${fileName ?? "file"}`);
        await uploadBytes(storageRef, file, { contentType: mimeType });
        const url = await getDownloadURL(storageRef);
        return { url, mimeType };
      } catch (err) {
        console.error("Erro no upload para o Storage:", err);
        return null;
      }
    },
    [],
  );

  const enviarMidia = useCallback(
    async (
      mediaUrl: string,
      mediaType: "image" | "audio" | "sticker" | "document" | "video",
      legenda = "",
    ): Promise<void> => {
      if (!activeChat) return;
      if (!canSendManualMessageRef.current) {
        openTemplateForActiveChat();
        return;
      }
      try {
        const { resultado } = enviarViaOutbox({ telefone: activeChat.id, texto: legenda, mediaUrl, mediaType });
        await resultado;
      } catch (err) {
        alert(`Falha ao enviar o arquivo: ${descreverErroEnvio(err)}`);
        console.error("Falha ao enviar mídia:", err);
      }
    },
    [activeChat, openTemplateForActiveChat],
  );

  const handleSelectChat = useCallback(
    async (id: string, fallbackName?: string, options: ChatSelectionOptions = {}) => {
      const preferFallbackName = options.preferFallbackName === true;
      if (fallbackName) {
        setConversas(prev => {
          const existing = prev.find(item => item.id === id);
          if (!existing) return [...prev, createPhoneConversation(id, fallbackName)];
          if (!preferFallbackName && hasSavedContactName(existing.clientName)) return prev;
          return prev.map(item => item.id === id ? { ...item, clientName: fallbackName } : item);
        });
      }

      // Cada conversa comeÃ§a em um estado limpo. No celular, principalmente,
      // um painel ou menu deixado aberto na conversa anterior fazia a nova tela
      // aparecer por cima (ou ao lado) das mensagens.
      setIsHeaderMenuOpen(false);
      setShowQuickReplies(false);
      setShowAttachMenu(false);
      setShowEmojiPicker(false);
      setContextMenu(null);
      setReplyingTo(null);
      setEditingMsg(null);
      setInputText("");
      if (window.matchMedia("(max-width: 768px)").matches) {
        setIsContextPanelOpen(false);
      }

      setActiveChatId(id);
      sincronizarChatAtivoAgora(id);
      setSearchQuery("");
      setIsTyping(false);
      setShowMobilePendencias(false);

      // Resultado de busca (fora da janela das ~200 conversas mais recentes
      // carregadas ao vivo) — sem isso, activeChatId apontava pra uma
      // conversa que não existia em `conversas`, e a tela ficava presa em
      // "Escolha um cliente" mesmo com o clique tendo "funcionado". Também
      // corrige o id se o telefone existir só na variante com/sem o 9º dígito.
      const { id: idResolvido, encontrada } = await garantirConversaCarregada(id);
      if (idResolvido !== id) {
        if (fallbackName) {
          setConversas(prev => prev.filter(item => item.id !== id));
        }
        setActiveChatId(idResolvido);
        sincronizarChatAtivoAgora(idResolvido);
      }

      if (fallbackName) {
        setConversas(prev => prev.map(item => (
          item.id === idResolvido && (preferFallbackName || !hasSavedContactName(item.clientName))
            ? { ...item, clientName: fallbackName }
            : item
        )));
      }

      const currentChat = conversas.find(c => c.id === idResolvido);

      // Atualiza localmente
      setConversas(prev => prev.map(item =>
        item.id === idResolvido ? { ...item, unreadCount: 0, lastUnreadCount: currentChat?.unreadCount || item.lastUnreadCount || 1 } : item
      ));

      if (!encontrada) return;

      try {
        // Salva no banco o valor anterior antes de zerar
        if (currentChat && currentChat.unreadCount > 0) {
          await updateDoc(doc(db, "conversas", idResolvido), {
            lastUnreadCount: currentChat.unreadCount,
            unreadCount: 0
          });
        } else {
          await updateDoc(doc(db, "conversas", idResolvido), { unreadCount: 0 });
        }
      } catch (err: unknown) {
        console.error("Erro ao zerar unreadCount:", err);
      }
    },
    [conversas, setConversas, setSearchQuery, garantirConversaCarregada, sincronizarChatAtivoAgora],
  );

  const handleCloseActiveChat = useCallback(() => {
    textareaRef.current?.blur();
    setActiveChatId(null);
    setIsContextPanelOpen(false);
    setShowMobilePendencias(false);
    setIsHeaderMenuOpen(false);
    setShowQuickReplies(false);
    setShowAttachMenu(false);
    setShowEmojiPicker(false);
    setContextMenu(null);
    setReplyingTo(null);
    setEditingMsg(null);
  }, []);

  const handleDetectedPhone = useCallback((phone: string) => {
    const normalizedPhone = normalizeConversationPhone(phone);
    void handleSelectChat(normalizedPhone, phone.trim());
  }, [handleSelectChat]);

  const handleSetOrderBlocked = useCallback(async (blocked: boolean): Promise<boolean> => {
    if (!activeChat || isOrderBlockUpdating) return false;

    setIsOrderBlockUpdating(true);
    try {
      const response = await apiFetch(`${BASE_URL}/clientes`, {
        method: "POST",
        body: JSON.stringify({
          action: "definirBloqueio",
          telefone: activeChat.phone || activeChat.id,
          nome: activeChat.clientName,
          bloqueado: blocked,
        }),
      });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error || "Não foi possível alterar o acesso do cliente.");
      }

      setConversas((previous) => previous.map((conversation) =>
        conversation.id === activeChat.id
          ? { ...conversation, pedidosBloqueados: blocked }
          : conversation
      ));
      addToast(
        blocked
          ? "Cliente bloqueado para novos pedidos."
          : "Cliente liberado para fazer pedidos.",
        blocked ? "info" : "success"
      );
      return true;
    } catch (error) {
      console.error("Erro ao alterar bloqueio de pedidos:", error);
      addToast(
        error instanceof Error ? error.message : "Não foi possível alterar o acesso do cliente.",
        "error"
      );
      return false;
    } finally {
      setIsOrderBlockUpdating(false);
    }
  }, [activeChat, addToast, isOrderBlockUpdating, setConversas]);

  useEffect(() => {
    if (initialPhoneHandledRef.current) return;

    const phoneFromUrl = new URLSearchParams(window.location.search).get("phone")?.trim();
    if (!phoneFromUrl) return;

    initialPhoneHandledRef.current = true;
    const normalizedPhone = normalizeConversationPhone(phoneFromUrl);
    void handleSelectChat(normalizedPhone, phoneFromUrl);
  }, [handleSelectChat]);

  const handleMarcarNaoLida = useCallback(async (chatId: string) => {
    const chat = conversas.find(c => c.id === chatId);
    const countToRestore = chat?.lastUnreadCount || 1; // Resgata o número antigo ou põe 1

    // Fecha a conversa ANTES de gravar o unreadCount, e sincroniza a ref na
    // hora (não espera o próximo render) — senão o eco do onSnapshot podia
    // chegar com a ref ainda apontando pra esse chat como "ativo", e
    // mapearConversa zerava de volta o unreadCount que a gente acabou de
    // gravar de propósito. Era por isso que "marcar como não lida" só
    // fechava a conversa, mas a bolinha nunca aparecia.
    if (activeChatId === chatId) {
      sincronizarChatAtivoAgora(null);
      setActiveChatId(null);
    }

    setConversas(prev => prev.map(c => c.id === chatId ? { ...c, unreadCount: countToRestore } : c));

    try {
      await updateDoc(doc(db, "conversas", chatId), { unreadCount: countToRestore });
    } catch (err) {
      console.error("Erro ao marcar como não lida:", err);
    }
  }, [conversas, activeChatId, setConversas, sincronizarChatAtivoAgora]);

  const handleToggleDetalhesPedido = async (orderId: string) => {
    // Se já estiver aberto para o mesmo pedido, fecha o painel
    if (pedidoDetalhe?.order_id === orderId || pedidoDetalhe?.id === orderId) {
      setPedidoDetalhe(null);
      return;
    }
    
    try {
      const snap = await getDoc(doc(db, "pedidos", orderId));
      if (snap.exists()) {
        setPedidoDetalhe({ id: snap.id, ...snap.data() });
      } else {
        alert("Detalhes do pedido não encontrados.");
      }
    } catch (err) {
      console.error("Erro ao buscar pedido:", err);
    }
  };

  const apiConfiguracoes = useCallback(async (action: string, payload: ConfigPayload): Promise<void> => {
    await apiFetch(`${BASE_URL}/configuracoes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    }).catch(() => { /* falha silenciosa */ });
  }, []);

  const handleReabrirConversa = useCallback(async (chatId: string) => {
    setConversas(prev => prev.map(c => c.id === chatId ? { ...c, finalizado: false } : c));
    await apiConfiguracoes("reabrirConversa", { telefone: chatId });
  }, [setConversas, apiConfiguracoes]);

  const handleFinalizarConversa = useCallback(async (chatId: string) => {
    setConversas(prev => prev.map(c => c.id === chatId ? { ...c, finalizado: true } : c));
    try {
      await apiConfiguracoes("finalizarConversa", { telefone: chatId });
    } catch (err) {
      console.error("Erro ao finalizar conversa:", err);
    }
  }, [setConversas, apiConfiguracoes]);

  // ─── ÁUDIO E MÍDIA ───
  const {
    isRecording, recordSeconds,
    iniciarGravacaoAudio, pararGravacaoAudio, cancelarGravacaoAudio,
  } = useAudioRecorder(async (blob, mimeType, ext) => {
    if (!canSendManualMessageRef.current) {
      openTemplateForActiveChat();
      return;
    }
    setIsSendingMedia(true);
    // Envia o webm natural mesmo!
    const result = await uploadMidiaParaServidor(blob, mimeType, ext); 
    setIsSendingMedia(false);
    
    if (result) {
      await enviarMidia(result.url, "audio");
    } else {
      alert("Não foi possível enviar o áudio.");
    }
  });

  // ─── EFEITOS ───

  useEffect(() => {
    const unsubFrases = onSnapshot(doc(db, "configuracoes", "frases"), snap => {
      if (snap.exists() && snap.data().frases) {
        setFrasesPredefinidas(snap.data().frases as FrasePredefinida[]);
      }
    });
    const unsubTags = onSnapshot(doc(db, "configuracoes", "tags"), snap => {
      if (snap.exists() && snap.data().tags) {
        setTagsGlobais(snap.data().tags as TagGlobal[]);
      }
    });
    const unsubFigurinhas = onSnapshot(doc(db, "configuracoes", "figurinhas"), snap => {
      if (snap.exists() && snap.data().lista) {
        setFigurinhasSalvas(snap.data().lista as { url: string; de: string }[]);
      }
    });
    return () => {
      unsubFrases();
      unsubTags();
      unsubFigurinhas();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setWindowClock(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  // Paste de imagem — depende de uploadMidiaParaServidor e enviarMidia,
  // que agora são useCallback estáveis, então este efeito não re-registra desnecessariamente.
  useEffect(() => {
    const handlePaste = async (e: ClipboardEvent) => {
      if (!activeChat) return;
      const items = Array.from(e.clipboardData?.items ?? []);
      const imageItem = items.find(i => i.type.startsWith("image/"));
      if (!imageItem) return;
      if (!canSendManualMessage) {
        e.preventDefault();
        openTemplateForActiveChat();
        return;
      }
      const file = imageItem.getAsFile();
      if (!file) return;
      e.preventDefault();
      setIsSendingMedia(true);
      const result = await uploadMidiaParaServidor(file, file.type, "pasted_image.png");
      setIsSendingMedia(false);
      if (result) {
        await enviarMidia(result.url, "image");
      } else {
        alert("Não foi possível enviar a imagem colada.");
      }
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [activeChat, canSendManualMessage, uploadMidiaParaServidor, enviarMidia, openTemplateForActiveChat]);

  

  useEffect(() => {
    const handleGlobalTyping = (e: KeyboardEvent) => {
      // Ignora atalhos de sistema e esc (para fechar chat)
      if (e.ctrlKey || e.metaKey || e.altKey || e.key === "Escape") return;
      // Não rouba foco se o utilizador já estiver num input (como busca ou modal)
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      // Não rouba foco se houver texto selecionado na página (ex.: copiando uma mensagem com Ctrl+C)
      const selecao = window.getSelection();
      if (selecao && selecao.toString().length > 0) return;

      // Se teclou um único caractere imprimível, ativa o textarea
      if (canSendManualMessage && e.key.length === 1 && textareaRef.current) {
        textareaRef.current.focus();
      }
    };
    document.addEventListener("keydown", handleGlobalTyping);
    return () => document.removeEventListener("keydown", handleGlobalTyping);
  }, [canSendManualMessage]);

  useEffect(() => {
    const inputEl = inputAreaRef.current;
    const mainViewEl = chatMainViewRef.current;
    if (!inputEl || !mainViewEl) return;

    const updatePadding = () => {
      const height = inputEl.offsetHeight;
      // 16px de respiro extra entre a última mensagem e o input
      mainViewEl.style.setProperty("--chat-input-height", `${height + 16}px`);
    };

    updatePadding();
    const observer = new ResizeObserver(updatePadding);
    observer.observe(inputEl);
    return () => observer.disconnect();
  }, [activeChatId, canSendManualMessage]);

  useEffect(() => {
    apiFetch(`${BASE_URL}/conversas?action=buscarTemplates`)
      .then(r => r.json())
      .then((data: { templates?: Template[] }) => {
        if (data.templates) setTemplates(data.templates);
      })
      .catch(() => { /* falha silenciosa */ });
  }, []);

  // Mantém o localStorage em sincronia com as mensagens falhas atuais — some
  // sozinho quando a mensagem é reenviada com sucesso (some do estado
  // otimista assim que a real chega pelo Firestore); reaparece se falhar de novo.
  useEffect(() => {
    const falhas = optimisticMessages.filter(m => m.status === "failed");
    try {
      if (falhas.length > 0) {
        localStorage.setItem(CHAVE_MENSAGENS_FALHAS, JSON.stringify(falhas));
      } else {
        localStorage.removeItem(CHAVE_MENSAGENS_FALHAS);
      }
    } catch {
      // localStorage indisponível (modo privado, quota cheia) — segue sem persistir
    }
  }, [optimisticMessages]);

  // Carrega as pendências salvas no Firestore (via Cloud Function) e mantém
  // atualizado em qualquer computador que abrir o painel.
  const falhasConsecutivasPendenciasRef = useRef(0);
  const [pendenciasOffline, setPendenciasOffline] = useState(false);

  const carregarPendencias = useCallback(async () => {
    try {
      const resp = await apiFetch(`${BASE_URL}/pendencias?action=listar`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data: { pendencias?: Pendencia[] } = await resp.json();
      if (data.pendencias) setPendencias(data.pendencias);
      falhasConsecutivasPendenciasRef.current = 0;
      setPendenciasOffline(false);
    } catch (err) {
      console.error("Erro ao carregar pendências:", err);
      falhasConsecutivasPendenciasRef.current += 1;
      if (falhasConsecutivasPendenciasRef.current >= 3) setPendenciasOffline(true);
    }
  }, []);

  // Circuit breaker do polling: depois de 3 falhas seguidas, para de bater a
  // cada 30s (não adianta insistir num servidor fora do ar) e vira uma sonda
  // de recuperação mais espaçada, avisando o usuário enquanto isso.
  useEffect(() => {
    let cancelado = false;
    let timeoutId: ReturnType<typeof setTimeout>;

    const ciclo = async () => {
      await carregarPendencias();
      if (cancelado) return;
      const proximaEsperaMs = falhasConsecutivasPendenciasRef.current >= 3 ? 120000 : 30000;
      timeoutId = setTimeout(ciclo, proximaEsperaMs);
    };

    ciclo();
    return () => {
      cancelado = true;
      clearTimeout(timeoutId);
    };
  }, [carregarPendencias]);

  useEffect(() => {
    const swMessageHandler = (event: MessageEvent) => {
      if (event.data?.type === "ABRIR_CHAT") {
        handleSelectChat(event.data.chatId as string);
      }
    };

    const ativarNotificacoes = async () => {
      try {
        const permission = await Notification.requestPermission();
        navigator.serviceWorker.addEventListener("message", swMessageHandler);
        const messaging = permission === "granted" ? await getMessagingLazy() : null;
        if (messaging) {
          const registration = await navigator.serviceWorker.register(
            "/factory-dashboard/firebase-messaging-sw.js",
          );
          const token = await getToken(messaging, {
            vapidKey: "BKxR575Xtckox8wBh3dxOr2U1VZ5TCil2foY4LovqPQ7fTogjjjIt0nIQa_Li73rjdhqh-8rYi4pi3hQ7keYNHk",
            serviceWorkerRegistration: registration,
          });
          await updateDoc(doc(db, "configuracoes", "notificacoes"), {
            tokenAdmin: token,
            atualizadoEm: new Date(),
          }).catch((err: unknown) => {
            console.error("Erro ao salvar token:", err);
          });

          // Com o app em primeiro plano, a Web Push API não mostra o balão de
          // sistema sozinha — o Firebase entrega o payload aqui em vez de
          // disparar o service worker. Toca o mesmo som já usado no efeito de
          // não-lidas, mas agora reagindo à notificação de verdade.
          desativarOnMessageRef.current = onMessage(messaging, () => {
            audioRef.current.play().catch(() => { /* autoplay bloqueado */ });
          });
        }
      } catch (error) {
        console.error("Erro ao gerar token:", error);
      }
    };

    ativarNotificacoes();
    return () => {
      navigator.serviceWorker.removeEventListener("message", swMessageHandler);
      desativarOnMessageRef.current?.();
    };
  }, [handleSelectChat]);

  useEffect(() => {
    const currentUnread = conversas.reduce((acc, c) => acc + c.unreadCount, 0);
    if (currentUnread > prevUnreadRef.current) {
      document.title = `(${currentUnread}) Mensagem Nova!`;
      audioRef.current.play().catch(() => { /* autoplay bloqueado */ });
    } else if (currentUnread === 0) {
      document.title = "Fábrica de Salgados Dashboard";
    }
    prevUnreadRef.current = currentUnread;
  }, [conversas]);

  useEffect(() => {
    if (!activeChatId) {
      setActiveMessages([]);
      setProntoParaExibir(true);
      return;
    }
    // Só busca as últimas 50 mensagens — evita reler o histórico inteiro,
    // que é a causa da demora ao abrir uma conversa antiga.
    const q = query(
      collection(db, "conversas", activeChatId, "mensagens"),
      orderBy("timestamp", "asc"),
      limitToLast(50),
    );
    const unsubscribe = onSnapshot(q, snapshot => {
      const mensagens = snapshot.docs.map(d => ({ id: d.id, ...d.data() } as Mensagem));
      setActiveMessages(mensagens);

      // Remove da lista otimista qualquer mensagem que já chegou de verdade,
      // casando pelo clientId (a mesma idempotencyKey usada no envio).
      const clientIdsConfirmados = new Set(mensagens.map(m => m.clientId).filter(Boolean));
      setOptimisticMessages(prev => prev.filter(m => !clientIdsConfirmados.has(m.clientId)));

      updateDoc(doc(db, "conversas", activeChatId), { unreadCount: 0 }).catch(
        (err: unknown) => { console.error("Erro ao zerar unreadCount:", err); },
      );
    });
    return () => unsubscribe();
  }, [activeChatId]);

  useEffect(() => {
    if (highlightMsgId) return;
    const isNewChat = prevChatIdRef.current !== activeChatId;
    if (isNewChat) {
      isNearBottomRef.current = true;
      setSuprimirAnimacaoEntrada(true); // some com a animação de entrada no carregamento inicial
      setProntoParaExibir(false); // esconde até a rolagem assentar, evita "piscar"
      setLabelDiaFixo(null);
    }

    // Scroll imediato (instantâneo ao trocar de chat; suave para mensagens novas)...
    scrollToBottom(isNewChat ? "auto" : "smooth");

    // ...de novo assim que o navegador terminar de pintar o quadro atual
    // (pega o caso de mensagens longas ainda sendo medidas)...
    const raf = requestAnimationFrame(() => scrollToBottom("auto"));

    // ...e mais uma vez depois que tudo assentar de vez (fontes, mídia etc.)
    const timer = setTimeout(() => {
      if (isNewChat || isNearBottomRef.current) {
        scrollToBottom("auto");
      }
      prevChatIdRef.current = activeChatId;
      // Só revela e volta a animar mensagens novas depois que a tela já assentou de vez
      if (isNewChat) {
        requestAnimationFrame(() => {
          setProntoParaExibir(true);
          setSuprimirAnimacaoEntrada(false);
        });
      }
    }, 300);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [activeMessages, activeChatId, highlightMsgId, scrollToBottom]);

  useEffect(() => {
    if (isTyping) messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [isTyping]);

  useEffect(() => {
    const fn = () => {
      setShowAttachMenu(false);
      setShowEmojiPicker(false);
      setShowQuickReplies(false);
      setQuickReplyIndex(-1);
      setIsHeaderMenuOpen(false);
      if (contextMenu) setContextMenu(null);
    };
    document.addEventListener("click", fn);
    return () => document.removeEventListener("click", fn);
  }, [contextMenu]);

  // Marca como lida apenas a última mensagem recebida ainda não lida.
  useEffect(() => {
    if (!activeChatId || activeMessages.length === 0 || document.visibilityState !== "visible") return;
    const lastIncoming = activeMessages.slice().reverse().find(
      m => m.sender === "incoming" && m.status !== "read",
    );
    if (lastIncoming && lastIncoming.id !== lastMarkedReadRef.current) {
      lastMarkedReadRef.current = lastIncoming.id;
      updateDoc(doc(db, "conversas", activeChatId, "mensagens", lastIncoming.id), {
        status: "read",
      }).catch((err: unknown) => {
        console.error("Erro ao marcar mensagem como lida:", err);
      });
      apiFetch(`${BASE_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "marcarLida", messageId: lastIncoming.id }),
      }).catch(() => { /* falha silenciosa */ });
    }
  }, [activeMessages, activeChatId]);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !algumModalAberto) {
        setActiveChatId(null);
      }
    };
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [algumModalAberto]);

  // ─── FUNÇÕES DE UI ───

  const handleChatScroll = useCallback(() => {
    const el = chatHistoryRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowScrollDown(distanceFromBottom > 120);
    isNearBottomRef.current = distanceFromBottom < 150;

    // Mantém uma cópia fixa do último separador que já saiu completamente
    // da área visível. A decisão depende somente da posição real do scroll,
    // não da direção, evitando o piscar causado por pequenas oscilações.
    const scrollCutoff = Math.floor(el.scrollTop) + 1;
    const separadores = el.querySelectorAll<HTMLElement>(".day-separator");
    let labelAtual: string | null = null;

    separadores.forEach((separador) => {
      const separadorTerminou = separador.offsetTop + separador.offsetHeight;
      if (separadorTerminou < scrollCutoff) {
        labelAtual = separador.dataset.dayLabel ?? labelAtual;
      }
    });

    setLabelDiaFixo(anterior => anterior === labelAtual ? anterior : labelAtual);
  }, []);

  const jumpToMessage = useCallback((chatId: string, msgId: string) => {
    setActiveChatId(chatId);
    setSearchQuery("");
    setHighlightMsgId(msgId);
    setTimeout(() => {
      document.getElementById(`msg-${msgId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      setTimeout(() => setHighlightMsgId(null), 3000);
    }, 100);
  }, [setSearchQuery]);

  const salvarFigurinha = useCallback(async (url: string) => {
    if (figurinhasSalvas.some(f => f.url === url)) return;
    const figurinhasRef = doc(db, "configuracoes", "figurinhas");
    try {
      await setDoc(
        figurinhasRef,
        { lista: arrayUnion({ url, de: "manual", salvaEm: new Date().toISOString() }) },
        { merge: true },
      );
    } catch (err) {
      console.error("Erro ao salvar figurinha:", err);
    }
  }, [figurinhasSalvas]);

  const autoResizeTextarea = useCallback((el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, []);

  const filteredReplies = useMemo(() => frasesPredefinidas.filter(qr => {
    const s = inputText.substring(inputText.lastIndexOf("/") + 1).toLowerCase();
    return qr.shortcut.toLowerCase().includes(s) || qr.text.toLowerCase().includes(s);
  }), [frasesPredefinidas, inputText]);

  const applyQuickReply = useCallback((text: string) => {
    setInputText(text);
    setShowQuickReplies(false);
    setQuickReplyIndex(-1);
    textareaRef.current?.focus();
    if (textareaRef.current) {
      setTimeout(() => autoResizeTextarea(textareaRef.current!), 0);
    }
  }, [autoResizeTextarea]);

  const addEmoji = useCallback((emoji: string) => {
    setInputText(prev => prev + emoji);
    textareaRef.current?.focus();
    setTimeout(() => {
      if (textareaRef.current) autoResizeTextarea(textareaRef.current);
    }, 0);
  }, [autoResizeTextarea]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInputText(val);
    setShowQuickReplies(val.includes("/"));
    if (!val.includes("/")) setQuickReplyIndex(-1);
    setShowAttachMenu(false);
    setShowEmojiPicker(false);
    autoResizeTextarea(e.target);

    if (!typingTimeoutRef.current && activeChatId && val.trim().length > 0) {
      apiFetch(`${BASE_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "enviarDigitando", telefone: activeChatId }),
      }).catch(() => { /* falha silenciosa */ });
      typingTimeoutRef.current = setTimeout(() => {
        typingTimeoutRef.current = null;
      }, 15000);
    }
  }, [activeChatId, autoResizeTextarea]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showQuickReplies && filteredReplies.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setQuickReplyIndex(i => Math.min(i + 1, filteredReplies.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setQuickReplyIndex(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const index = quickReplyIndex >= 0 ? quickReplyIndex : 0;
        applyQuickReply(filteredReplies[index].text);
        return;
      }
      if (e.key === "Escape") {
        setShowQuickReplies(false);
        setQuickReplyIndex(-1);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showQuickReplies, filteredReplies, quickReplyIndex, applyQuickReply]);

  const handleSendLocation = useCallback(() => {
    if (!activeChat) return;
    if (!canSendManualMessageRef.current) {
      openTemplateForActiveChat();
      return;
    }
    setShowAttachMenu(false);
    if (!navigator.geolocation) {
      alert("Geolocalização não suportada neste navegador.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        if (!canSendManualMessageRef.current) {
          openTemplateForActiveChat();
          return;
        }
        const { latitude, longitude } = pos.coords;
        try {
          const { resultado } = enviarViaOutbox({
            telefone: activeChat.id,
            mediaUrl: `${latitude},${longitude}`,
            mediaType: "location",
            replyToMsgId: replyingTo?.id || null,
          });
          await resultado;
          setReplyingTo(null);
        } catch {
          alert("Falha ao enviar localização.");
        }
      },
      () => alert("Não foi possível obter sua localização. Verifique as permissões."),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }, [activeChat, openTemplateForActiveChat, replyingTo?.id]);

  const handleForwardMessage = useCallback(async () => {
    if (!forwardingMsg) return;
    const telefoneDestino = forwardPhone.replace(/\D/g, ""); // mantém só dígitos (DDI+DDD+número)
    if (telefoneDestino.length < 10) {
      alert("Digite um número válido, com DDI e DDD (ex.: 5592999999999).");
      return;
    }
    setIsForwarding(true);
    try {
      const { resultado } = enviarViaOutbox({
        telefone: telefoneDestino,
        texto: forwardingMsg.text ?? "",
        mediaUrl: forwardingMsg.mediaUrl ?? null,
        mediaType: forwardingMsg.mediaType ?? null,
      });
      await resultado;
      setForwardingMsg(null);
      setForwardPhone("");
    } catch (err) {
      console.error("Erro ao encaminhar mensagem:", err);
      alert("Não foi possível encaminhar. Se o número nunca conversou com você, pode ser necessário iniciar com um template.");
    } finally {
      setIsForwarding(false);
    }
  }, [forwardingMsg, forwardPhone]);

  // Dispara o envio de verdade (outbox) e acompanha o resultado, atualizando
  // a bolha otimista correspondente. Devolve o ID do item na hora (a escrita
  // em si é assíncrona, mas não precisa ser esperada pra já sabermos o ID) —
  // reaproveitada tanto pelo envio normal quanto pelo "tentar novamente" de
  // uma mensagem que falhou.
  const enviarTextoParaBackend = useCallback(
    (telefone: string, texto: string, replyToMsgId: string | null): string => {
      const { itemId, resultado } = enviarViaOutbox({ telefone, texto, replyToMsgId });
      resultado.catch((err) => {
        const motivo = descreverErroEnvio(err);
        setOptimisticMessages(prev =>
          prev.map(m => (m.clientId === itemId ? { ...m, status: "failed", erro: motivo } : m)),
        );
      });
      // Sucesso: nada a fazer aqui — a bolha otimista some sozinha quando a
      // mensagem real chegar pelo Firestore (efeito de activeMessages,
      // casando pelo clientId = itemId, gravado por outbox.js na mensagem).
      return itemId;
    },
    [],
  );

  const reenviarOtimista = useCallback((msg: MensagemOtimista) => {
    if (!canSendManualMessage) {
      openTemplateForActiveChat();
      return;
    }
    // É um item novo no outbox (o antigo já terminou em "erro" — outbox.js
    // nunca reprocessa um item que já chegou a um estado final), então o
    // clientId da bolha também muda pro novo ID.
    const novoClientId = enviarTextoParaBackend(msg.chatId, msg.text ?? "", msg.replyTo ?? null);
    setOptimisticMessages(prev =>
      prev.map(m => (m.clientId === msg.clientId ? { ...m, clientId: novoClientId, status: "pending", erro: undefined } : m)),
    );
  }, [canSendManualMessage, enviarTextoParaBackend, openTemplateForActiveChat]);

  const sendMessage = useCallback(async () => {
    if (!inputText.trim() || !activeChat) return;
    if (!canSendManualMessage) {
      openTemplateForActiveChat();
      return;
    }
    if (isSendingRef.current) return;
    isSendingRef.current = true;

    const textoParaEnviar = inputText.trim();
    setInputText("");
    setShowQuickReplies(false);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = null;
    }

    if (editingMsg) {
      try {
        await apiFetch(`${BASE_URL}/chat`, {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "editarMensagem",
            telefone: activeChat.id,
            chatMsgId: editingMsg.id,
            novoTexto: textoParaEnviar,
          }),
        });
        setEditingMsg(null);
      } catch {
        setInputText(textoParaEnviar);
        alert("Falha ao editar. O prazo de 30 min pode ter expirado.");
      } finally {
        isSendingRef.current = false;
      }
      return;
    }

    const replyToMsgId = replyingTo?.id || null;
    setReplyingTo(null);

    const clientId = enviarTextoParaBackend(activeChat.id, textoParaEnviar, replyToMsgId);

    // Bolha otimista: aparece na hora, com o reloginho, enquanto o outbox
    // entrega de verdade (inclusive enfileirado offline, se a internet do
    // operador estiver ruim). Some sozinha quando a mensagem real chegar, ou
    // vira um aviso de falha (toque para tentar de novo) se não confirmar.
    setOptimisticMessages(prev => [
      ...prev,
      {
        id: `local_${clientId}`,
        clientId,
        chatId: activeChat.id,
        sender: "outgoing",
        text: textoParaEnviar,
        time: horaAgora(),
        status: "pending",
        replyTo: replyToMsgId ?? undefined,
      } as MensagemOtimista,
    ]);

    isSendingRef.current = false;
  }, [inputText, activeChat, canSendManualMessage, replyingTo?.id, editingMsg, enviarTextoParaBackend, openTemplateForActiveChat]);

  const handleFileSelected = useCallback(
    async (
      e: React.ChangeEvent<HTMLInputElement>,
      mediaType: "image" | "sticker" | "document" | "video",
    ) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      setShowAttachMenu(false);
      if (!file || !activeChat) return;
      if (!canSendManualMessage) {
        openTemplateForActiveChat();
        return;
      }
      const MAX_MB = 15;
      if (file.size > MAX_MB * 1024 * 1024) {
        alert(`Arquivo muito grande. Limite: ${MAX_MB}MB`);
        return;
      }
      setIsSendingMedia(true);
      const result = await uploadMidiaParaServidor(
        file,
        file.type || (mediaType === "sticker" ? "image/webp" : "image/jpeg"),
        file.name,
      );
      setIsSendingMedia(false);
      if (!result) {
        alert("Não foi possível enviar o arquivo.");
        return;
      }
      await enviarMidia(result.url, mediaType);
    },
    [activeChat, canSendManualMessage, uploadMidiaParaServidor, enviarMidia, openTemplateForActiveChat],
  );

  const handleExcluirConversa = useCallback(
    async (chatId: string) => {
      const conversa = conversas.find(c => c.id === chatId);
      if (!window.confirm(
        `Excluir toda a conversa com ${conversa?.clientName ?? chatId}? Essa ação não pode ser desfeita.`,
      )) {
        setContextMenu(null);
        return;
      }
      setContextMenu(null);
      setConversas(prev => prev.filter(c => c.id !== chatId));
      if (activeChatId === chatId) setActiveChatId(null);
      try {
        await apiFetch(`${BASE_URL}/configuracoes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "excluirConversa", telefone: chatId }),
        });
      } catch {
        alert("Falha ao excluir a conversa no servidor.");
      }
    },
    [conversas, activeChatId, setConversas],
  );

  const salvarEdicaoNome = useCallback(async () => {
    if (!editNomeChatId || !editNomeValor.trim()) {
      setEditNomeChatId(null);
      return;
    }
    const novoNome = editNomeValor.trim();
    setConversas(prev => prev.map(c => c.id === editNomeChatId ? { ...c, clientName: novoNome } : c));
    const chatId = editNomeChatId;
    setEditNomeChatId(null);
    try {
      await apiFetch(`${BASE_URL}/configuracoes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "editarNomeCliente", telefone: chatId, nome: novoNome }),
      });
    } catch {
      /* falha silenciosa */
    }
  }, [editNomeChatId, editNomeValor, setConversas]);

  const handleResolvePendencia = useCallback(async (id: string) => {
    // Atualização otimista: reflete na tela imediatamente.
    setPendencias(prev => prev.map(p => p.id === id ? { ...p, resolvida: true } : p));
    try {
      const resp = await apiFetch(`${BASE_URL}/pendencias`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolver", id }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } catch (err) {
      console.error("Erro ao resolver pendência:", err);
      // Reverte em caso de falha, buscando o estado real do servidor.
      carregarPendencias();
    }
  }, [carregarPendencias]);

  const handleAddPendencia = useCallback(async (chatId: string, tipo: PendenciaTipo, descricao: string) => {
    // Item temporário para feedback imediato; será substituído pelo próximo carregarPendencias().
    const tempId = `temp_${Date.now()}`;
    setPendencias(prev => [
      { id: tempId, chatId, tipo, descricao, criadaEm: "Agora", resolvida: false },
      ...prev,
    ]);
    // apiFetch reenvia sozinho em timeout/5xx — sem chave de idempotência, um
    // reenvio automático podia criar a mesma pendência duas vezes.
    const idempotencyKey = crypto.randomUUID();
    try {
      const resp = await apiFetch(`${BASE_URL}/pendencias`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "adicionar", chatId, tipo, descricao, idempotencyKey }),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      await carregarPendencias();
    } catch (err) {
      console.error("Erro ao adicionar pendência:", err);
      setPendencias(prev => prev.filter(p => p.id !== tempId));
      alert("Não foi possível salvar a pendência. Tente novamente.");
    }
  }, [carregarPendencias]);

  const handleSalvarTags = useCallback((tags: TagGlobal[]) => {
    setTagsGlobais(tags);
    apiConfiguracoes("salvarTags", { tags });
  }, [apiConfiguracoes]);

  const handleAplicarTags = useCallback((telefone: string, tags: string[]) => {
    setConversas(prev => prev.map(c => c.id === telefone ? { ...c, tags } : c));
    apiConfiguracoes("aplicarTags", { telefone, tags });
  }, [setConversas, apiConfiguracoes]);

  const handleSalvarFrases = useCallback((frases: FrasePredefinida[]) => {
    setFrasesPredefinidas(frases);
    apiConfiguracoes("salvarFrases", { frases });
  }, [apiConfiguracoes]);

  const handleFixar = useCallback((chatId: string, pinned: boolean) => {
    setConversas(prev => prev.map(c => c.id === chatId ? { ...c, pinned } : c));
    apiConfiguracoes("fixarConversa", { telefone: chatId, pinned });
    setContextMenu(null);
  }, [setConversas, apiConfiguracoes]);

  const handleIniciarConversa = useCallback(
    async (telefone: string, nome: string, templateName: string, params: { type: string; text: string }[]) => {
      const template = templates.find(t => t.name === templateName);
      let textoFinal = `Template "${templateName}" enviado`;

      if (template?.preview) {
        textoFinal = template.preview;
        params.forEach((p, idx) => {
          textoFinal = textoFinal.replace(`{{${idx + 1}}}`, p.text || String(p));
        });
      }

      try {
        const response = await apiFetch(`${BASE_URL}/conversas`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "iniciarConversa",
            telefone,
            nomeCliente: nome,
            templateName,
            parameters: params,
            textoPreview: textoFinal,
          }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({})) as { error?: string; message?: string };
          throw new Error(data.error || data.message || "Confira o número e tente novamente.");
        }
        setIsIniciarConversaOpen(false);
        setIniciarConversaDefaults(null);
        const nomeInformado = nome.trim();
        setTimeout(() => {
          void handleSelectChat(
            telefone,
            nomeInformado || undefined,
            { preferFallbackName: nomeInformado.length > 0 },
          );
        }, 800);
      } catch (err) {
        if (err instanceof TypeError) {
          throw new Error("Sem conexão com o servidor. Verifique a internet e tente novamente.");
        }
        throw err;
      }
    },
    [templates, handleSelectChat],
  );

  const datasHistorico = useMemo(
    () => (activeChat?.datasHistorico ?? []).map(ts => (ts instanceof Date ? ts : ts.toDate())),
    [activeChat?.datasHistorico],
  );

  // Handlers da sidebar isolados com useCallback — a sidebar é memo(), então
  // passar uma arrow function inline aqui recriaria a prop a cada render (ex.:
  // a cada tecla digitada) e derrotaria o memo por completo.
  const handleOpenIniciarConversa = useCallback(() => openNewConversation(), [openNewConversation]);
  const handleOpenFrases = useCallback(() => setIsFrasesModalOpen(true), []);
  const handleOpenTags = useCallback(() => setIsTagsModalOpen(true), []);
  const handleSidebarContextMenu = useCallback((e: React.MouseEvent, chatId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ chatId, x: e.clientX, y: e.clientY });
  }, []);
  const handleOpenPendencias = useCallback(() => {
    setActiveChatId(null);
    setShowMobilePendencias(true);
  }, []);

  // ─── RENDER ───
  return (
    <div className={`chat-container fade-in ${activeChatId ? "mobile-chat-active" : ""} ${isContextPanelOpen ? "context-open" : ""} ${showMobilePendencias ? "pendencias-open" : ""}`}>
      <ChatSidebar
        conversas={conversas}
        conversasOrdenadas={conversasOrdenadas}
        activeChatId={activeChatId}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        sidebarSearchRef={sidebarSearchRef}
        totalPendenciasAbertas={totalPendenciasAbertas}
        searchResults={searchResults}
        pedidoSearchResults={pedidoSearchResults}
        contatoSearchResults={contatoSearchResults}
        onSelectChat={handleSelectChat}
        onOpenIniciarConversa={handleOpenIniciarConversa}
        onOpenFrases={handleOpenFrases}
        onOpenTags={handleOpenTags}
        onContextMenu={handleSidebarContextMenu}
        onJumpToMessage={jumpToMessage}
        onOpenPendencias={handleOpenPendencias}
        abaAtiva={abaAtiva}
        onChangeAba={setAbaAtiva}
      />

      {contextMenu && (() => {
        const conversa = conversas.find(c => c.id === contextMenu.chatId);
        return (
          <div
            className="context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={e => e.stopPropagation()}
          >
            <button onClick={() => { handleMarcarNaoLida(contextMenu.chatId); setContextMenu(null); }}>
              <MdLabel size={14} /> Marcar como não lida
            </button>
            <button onClick={() => handleFixar(contextMenu.chatId, !conversa?.pinned)}>
              <MdPushPin size={14} /> {conversa?.pinned ? "Desafixar" : "Fixar conversa"}
            </button>
            <button onClick={() => {
              setActiveChatId(contextMenu.chatId);
              setIsAplicarTagsOpen(true);
              setContextMenu(null);
            }}>
              <MdLabel size={14} /> Editar tags
            </button>
            <button onClick={() => {
              setEditNomeChatId(contextMenu.chatId);
              setEditNomeValor(conversa?.clientName ?? "");
              setContextMenu(null);
            }}>
              <MdEdit size={14} /> Editar nome do cliente
            </button>
            <button
              className="context-menu-danger"
              style={{ color: "#ef4444" }}
              onClick={() => handleExcluirConversa(contextMenu.chatId)}
            >
              <MdDelete size={14} /> Excluir conversa
            </button>
          </div>
        );
      })()}

      <div className="chat-main-view" ref={chatMainViewRef}>
        {activeChat ? (
          <>
            {/* ─── HEADER ─── */}
            <div className="chat-header-main">
              <button
                className="mobile-back-btn"
                onClick={(e) => { 
                  e.stopPropagation(); 
                  handleCloseActiveChat();
                }}
                type="button"
                aria-label="Voltar para a lista de conversas"
                title="Voltar para a lista"
              >
                <MdArrowBack size={24} />
              </button>
              <button
                type="button"
                className="chat-header-clickable"
                onClick={() => setIsContextPanelOpen(v => !v)}
                title={isContextPanelOpen ? "Ocultar painel" : "Ver informações"}
                aria-label={isContextPanelOpen ? "Ocultar informações do cliente" : "Mostrar informações do cliente"}
                aria-expanded={isContextPanelOpen}
              >
                <div className="chat-header-avatar" style={{ position: "relative", flexShrink: 0 }}>
                  <Avatar name={activeChat.clientName} size={44} />
                  {activeChat.isOnline && <span className="avatar-online-ring" />}
                </div>
                <div className="chat-header-info">
                  <h3 className="chat-header-name">
                    {activeChat.clientName}
                    {activeChat.finalizado && (
                      <span className="finalizado-badge">
                        <MdCheckCircle size={12} /> Finalizado
                      </span>
                    )}
                  </h3>
                  <span className="chat-header-sub">
                    {activeChat.isOnline
                      ? <><span className="online-dot" /> Online agora</>
                      : activeChat.phone}
                  </span>
                </div>
                <div className="chat-header-tags">
                  {activeChat.tags.map(tag => (
                    <span key={tag} className={`tag-badge ${getTagClass(tag)}`}>{tag}</span>
                  ))}
                  <span className={`manual-window-badge ${canSendManualMessage ? "open" : "closed"}`}>
                    {!canSendManualMessage && <MdLockOutline size={13} />}
                    {canSendManualMessage ? manualWindowRemaining : "Somente templates"}
                  </span>
                </div>
              </button>

              <div className="chat-header-actions">
                {!activeChat.finalizado ? (
                  <button
                    className="header-btn-finalizar"
                    onClick={() => setIsFinalizarOpen(true)}
                    title="Finalizar atendimento"
                  >
                    <MdCheckCircle size={15} /> Finalizar atendimento
                  </button>
                ) : (
                  <button
                    className="header-btn-reabrir"
                    onClick={() => handleReabrirConversa(activeChat.id)}
                  >
                    Reabrir
                  </button>
                )}
                <button
                  type="button"
                  className="header-icon-btn"
                  onClick={e => { e.stopPropagation(); setIsHeaderMenuOpen(v => !v); }}
                  aria-label="Mais ações da conversa"
                  aria-expanded={isHeaderMenuOpen}
                  title="Mais ações"
                >
                  <MdMoreVert size={20} />
                </button>

                {isHeaderMenuOpen && (
                  <div
                    className="header-dropdown-menu"
                    onClick={e => e.stopPropagation()}
                  >
                    {[
                      {
                        icon: <MdEdit size={16} />, label: "Editar nome",
                        onClick: () => {
                          setIsHeaderMenuOpen(false);
                          setEditNomeChatId(activeChat.id);
                          setEditNomeValor(activeChat.clientName);
                        },
                      },
                      {
                        icon: <MdLabel size={16} />, label: "Por tag",
                        onClick: () => { setIsHeaderMenuOpen(false); setIsAplicarTagsOpen(true); },
                      },
                      {
                        icon: <MdSearch size={16} />, label: "Pesquisar",
                        onClick: () => { setIsHeaderMenuOpen(false); sidebarSearchRef.current?.focus(); },
                      },
                    ].map(item => (
                      <button
                        key={item.label}
                        type="button"
                        className="header-dropdown-item"
                        onClick={item.onClick}
                      >
                        {item.icon} {item.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* ─── ÁREA DE MENSAGENS ─── */}
            <div
              className={`chat-history${suprimirAnimacaoEntrada ? " no-entry-anim" : ""}${prontoParaExibir ? " chat-history-ready" : ""}`}
              ref={chatHistoryRef}
              onScroll={handleChatScroll}
              onDragOver={e => {
                e.preventDefault();
                if (canSendManualMessage) setIsDraggingOver(true);
              }}
              onDragLeave={() => setIsDraggingOver(false)}
              onDrop={async e => {
                e.preventDefault();
                setIsDraggingOver(false);
                if (!activeChat) return;
                if (!canSendManualMessage) {
                  openTemplateForActiveChat();
                  return;
                }
                const file = e.dataTransfer.files?.[0];
                if (!file) return;
                if (!file.type.startsWith("image/")) {
                  alert("Apenas imagens podem ser enviadas por arrastar. Use o botão de anexo para outros arquivos.");
                  return;
                }
                setIsSendingMedia(true);
                const result = await uploadMidiaParaServidor(file, file.type, file.name);
                setIsSendingMedia(false);
                if (result) await enviarMidia(result.url, "image");
                else alert("Não foi possível enviar a imagem.");
              }}
            >
              {labelDiaFixo && (
                <div className="day-separator-sticky" aria-hidden="true">
                  <span>{labelDiaFixo}</span>
                </div>
              )}
              {isDraggingOver && (
                <div className="drag-overlay">
                  <div className="drag-overlay-inner">🖼️ Solte aqui para enviar</div>
                </div>
              )}

              {mensagensExibidas.map((m, idx) => {
                const prevMsg = mensagensExibidas[idx - 1];

                // ── NOVO: separador de dia ──────────────────────────────
                const showDaySep = (() => {
                  if (!m.timestamp) return false;
                  const currDate = new Date(m.timestamp.toMillis());
                  if (!prevMsg?.timestamp) return idx === 0; // primeira mensagem
                  const prevDate = new Date(prevMsg.timestamp.toMillis());
                  return currDate.toDateString() !== prevDate.toDateString();
                })();

                const formatarDiaSep = (ts: { toMillis: () => number }) => {
                  const d = new Date(ts.toMillis());
                  const hoje = new Date();
                  const ontem = new Date();
                  ontem.setDate(ontem.getDate() - 1);
                  if (d.toDateString() === hoje.toDateString()) return "Hoje";
                  if (d.toDateString() === ontem.toDateString()) return "Ontem";
                  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" });
                };
                // ────────────────────────────────────────────────────────

                const showTimeSep = (() => {
                  if (!prevMsg) return false;
                  const curr = m.timestamp?.toMillis?.() ?? 0;
                  const prev = prevMsg.timestamp?.toMillis?.() ?? 0;
                  return !showDaySep && curr - prev > 10 * 60 * 1000; // ← adicione !showDaySep
                })();
                const groupClass = getGroupClass(mensagensExibidas, idx);
                const isGrouped = groupClass === "mid" || groupClass === "last";

                return (
                  <div key={m.id}>
                    {showDaySep && (
                      <div className="day-separator" data-day-label={m.timestamp ? formatarDiaSep(m.timestamp) : ""}>
                        <span>{m.timestamp ? formatarDiaSep(m.timestamp) : ""}</span>
                      </div>
                    )}
                    {showTimeSep && (
                      <div className="time-separator"><span>{m.time}</span></div>
                    )}
                    <div
                      id={`msg-${m.id}`}
                      className={[
                        "msg-row",
                        m.sender,
                        `group-${groupClass}`,
                        isGrouped ? "grouped" : "",
                        highlightMsgId === m.id ? "highlighted-message" : "",
                        m.status === "pending" ? "is-pending" : "",
                        m.status === "failed" ? "is-failed" : "",
                      ].filter(Boolean).join(" ")}
                      data-failure-reason={m.status === "failed" ? (m.erro || "Não foi possível enviar.") : undefined}
                      tabIndex={m.status === "failed" ? 0 : undefined}
                      aria-label={m.status === "failed" ? `Mensagem não enviada: ${m.erro || "motivo não informado"}. Pressione Enter para tentar novamente.` : undefined}
                      onClick={() => { if (m.status === "failed") reenviarOtimista(m as MensagemOtimista); }}
                      onKeyDown={e => {
                        if (m.status === "failed" && (e.key === "Enter" || e.key === " ")) {
                          e.preventDefault();
                          reenviarOtimista(m as MensagemOtimista);
                        }
                      }}
                    >
                      {m.mediaType === "sticker" ? (
                        <div 
                          className="sticker-msg-wrap" 
                          style={{ 
                            display: 'flex', 
                            flexDirection: 'column', 
                            alignItems: m.sender === 'outgoing' ? 'flex-end' : 'flex-start' 
                          }}
                        >
                          <div style={{ position: 'relative' }}>
                            <img
  src={m.mediaUrl!}
  alt="Figurinha"
  className="msg-media-sticker"
  loading="lazy"
  onLoad={() => { if (isNearBottomRef.current) scrollToBottom("auto"); }}
/>
                            {m.sender === "incoming" && (
                              <button
                                className={`sticker-save-btn${figurinhasSalvas.some(f => f.url === m.mediaUrl) ? " sticker-saved" : ""}`}
                                title={figurinhasSalvas.some(f => f.url === m.mediaUrl) ? "Já salva" : "Salvar figurinha"}
                                onClick={() => salvarFigurinha(m.mediaUrl!)}
                                disabled={figurinhasSalvas.some(f => f.url === m.mediaUrl)}
                              >
                                {figurinhasSalvas.some(f => f.url === m.mediaUrl) ? "✓" : "➕"}
                              </button>
                            )}
                          </div>
                          {/* Volta do Horário na Figurinha */}
                          <span className="bubble-meta" style={{ marginTop: '4px' }}>
                            <span className="bubble-time">{m.time}</span>
                            {m.sender === "outgoing" && <MessageStatus status={m.status} reason={m.erro} />}
                          </span>
                        </div>
                      ) : m.mediaType === "audio" ? (
                        <div
                          className="audio-msg-wrap"
                          onMouseEnter={() => setHoveredMsgId(m.id)}
                          onMouseLeave={() => setHoveredMsgId(prev => (prev === m.id ? null : prev))}
                          style={{ position: "relative" }}
                        >
                          {hoveredMsgId === m.id && (
                            <div className={`bubble-hover-actions${m.sender === "outgoing" ? " outgoing" : ""}`}>
                              <button
                                type="button"
                                title="Responder"
                                className="bubble-action-btn"
                                onClick={e => { e.stopPropagation(); setReplyingTo(m); }}
                              >
                                <MdReply size={15} />
                              </button>
                              <button
                                type="button"
                                title="Encaminhar"
                                className="bubble-action-btn"
                                onClick={e => { e.stopPropagation(); setForwardingMsg(m); }}
                              >
                                <MdForward size={15} />
                              </button>
                            </div>
                          )}
                          {m.replyTo && (() => {
                            const original = activeMessages.find(msg => msg.id === m.replyTo);
                            return original ? <QuotedReply original={original} /> : null;
                          })()}
                          {m.mediaUrl && (
                            <AudioPlayer
                              src={m.mediaUrl}
                              onMetadataLoaded={() => { if (isNearBottomRef.current) scrollToBottom("auto"); }}
                            />
                          )}
                          <span className="bubble-meta audio-meta">
                            <span className="bubble-time">{m.time}</span>
                            {m.sender === "outgoing" && <MessageStatus status={m.status} reason={m.erro} />}
                          </span>
                        </div>
                      ) : (
                        <div
                          className="bubble"
                          onDoubleClick={() => setReplyingTo(m)}
                          onMouseEnter={() => setHoveredMsgId(m.id)}
                          onMouseLeave={() => setHoveredMsgId(prev => (prev === m.id ? null : prev))}
                          style={{ position: "relative" }}
                        >
                          {m.isAlteracao && (
                            <span
                              className="chat-alteracao-badge"
                              title="Solicitação de alteração enviada pelo app — o cliente não digitou isso no WhatsApp"
                            >
                              !
                            </span>
                          )}
                          {hoveredMsgId === m.id && (
                            <div className={`bubble-hover-actions${m.sender === "outgoing" ? " outgoing" : ""}`}>
                              <button
                                type="button"
                                title="Responder"
                                className="bubble-action-btn"
                                onClick={e => { e.stopPropagation(); setReplyingTo(m); }}
                              >
                                <MdReply size={15} />
                              </button>

                              <button
                                type="button"
                                title="Encaminhar"
                                className="bubble-action-btn"
                                onClick={e => { e.stopPropagation(); setForwardingMsg(m); }}
                              >
                                <MdForward size={15} />
                              </button>

                              {m.sender === "outgoing" &&
                                !m.mediaType &&
                                m.timestamp &&
                                Date.now() - m.timestamp.toMillis() < 30 * 60 * 1000 && (
                                  <button
                                    type="button"
                                    title="Editar"
                                    className="bubble-action-btn"
                                    onClick={e => {
                                      e.stopPropagation();
                                      setEditingMsg(m);
                                      setInputText(m.text ?? "");
                                      textareaRef.current?.focus();
                                    }}
                                  >
                                    <MdEdit size={15} />
                                  </button>
                                )}
                            </div>
                          )}

                          {m.mediaType === "location" && m.mediaUrl && (
                            <a href={m.mediaUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px', background: m.sender === 'outgoing' ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.05)', borderRadius: '8px', textDecoration: 'none', color: 'inherit' }}>
                              📍 <strong>Abrir Localização no Mapa</strong>
                            </a>
                          )}

                          {/* 🖼️ MINIATURA DE IMAGEM */}
                          {m.mediaType === "image" && m.mediaUrl && (
                            <img
  src={m.mediaUrl}
  alt="Imagem"
  className="media-thumbnail-square"
  loading="lazy"
  onClick={() => setMediaViewer({ url: m.mediaUrl!, type: 'image' })}
  onLoad={() => { if (isNearBottomRef.current) scrollToBottom("auto"); }}
/>
                          )}
                          
                          {/* MINIATURA DE DOCUMENTO — ícone varia pelo tipo de arquivo */}
                          {m.mediaType === "document" && m.mediaUrl && (() => {
                            const extensao = extensaoDoArquivo(m.text || m.mediaUrl);
                            const nomeArquivo = m.text || (extensao ? `Arquivo.${extensao}` : "Documento");
                            return (
                              <div
                                className="media-thumbnail-square"
                                onClick={() => setMediaViewer({ url: m.mediaUrl!, type: 'document' })}
                              >
                                <div className="pdf-icon">
                                  <IconeDocumento extensao={extensao} />
                                </div>
                                <span className="document-filename">{nomeArquivo}</span>
                                <div className="document-actions">
                                  <button type="button" className="pdf-view-btn">Visualizar</button>
                                  <a
                                    href={m.mediaUrl}
                                    download
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="document-download-btn"
                                    title="Baixar arquivo"
                                    onClick={e => e.stopPropagation()}
                                  >
                                    <MdFileDownload size={16} />
                                  </a>
                                </div>
                              </div>
                            );
                          })()}
                          {m.mediaType === "video" && m.mediaUrl && (
                            <video
  controls
  src={m.mediaUrl}
  className="msg-media-video"
  style={{ maxWidth: 260 }}
  onLoadedMetadata={() => { if (isNearBottomRef.current) scrollToBottom("auto"); }}
/>
                          )}
                          {m.replyTo && (() => {
                            const original = activeMessages.find(msg => msg.id === m.replyTo);
                            return original ? <QuotedReply original={original} /> : null;
                          })()}
                          {m.text && <RichMessageText text={m.text} onPhoneClick={handleDetectedPhone} />}
                          <span className="bubble-meta">
                            <span className="bubble-time">{m.time}</span>
                            {m.editada && <span className="edited-tag">editada</span>}
                            {m.sender === "outgoing" && <MessageStatus status={m.status} reason={m.erro} />}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {isTyping && <TypingIndicator />}
              <div ref={messagesEndRef} />
            </div>

            {showScrollDown && (
              <button
                className="scroll-down-btn"
                onClick={() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })}
              >
                <MdKeyboardArrowDown size={20} />
              </button>
            )}

            {/* ─── ÁREA DE INPUT ─── */}
            <div className={`chat-input-area${canSendManualMessage ? "" : " window-closed"}`} ref={inputAreaRef}>

              {editingMsg && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', background: 'rgba(234,179,8,0.08)', borderLeft: '4px solid #eab308', borderTopRightRadius: 12, borderTopLeftRadius: 12, marginBottom: '-4px' }}>
                  <span style={{ fontSize: '0.75rem', fontWeight: 800, color: '#b45309' }}>Editando mensagem</span>
                  <button onClick={() => { setEditingMsg(null); setInputText(""); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }}>
                    <MdClose size={18} />
                  </button>
                </div>
              )}

              {replyingTo && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', background: 'rgba(var(--sys-color-accent-rgb), 0.05)', borderLeft: '4px solid var(--sys-color-accent)', borderTopRightRadius: '12px', borderTopLeftRadius: '12px', marginBottom: '-4px' }}>
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: '0.75rem', fontWeight: '800', color: 'var(--sys-color-accent)' }}>Respondendo a {replyingTo.sender === 'incoming' ? activeChat.clientName : 'Você'}</span>
                    <span style={{ fontSize: '0.85rem', color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '300px' }}>{replyingTo.text || '📷 Mídia'}</span>
                  </div>
                  <button onClick={() => setReplyingTo(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b' }}><MdClose size={18} /></button>
                </div>
              )}

              {showQuickReplies && filteredReplies.length > 0 && (
                <div className="quick-replies-popup" onClick={e => e.stopPropagation()}>
                  {filteredReplies.map((qr, i) => (
                    <button
                      key={qr.shortcut}
                      className={`quick-reply-item ${i === quickReplyIndex ? "active" : ""}`}
                      onClick={() => applyQuickReply(qr.text)}
                    >
                      <span className="qr-shortcut">{qr.shortcut}</span>
                      <span className="qr-text">{qr.text}</span>
                    </button>
                  ))}
                </div>
              )}

              {showEmojiPicker && (
                <div className="emoji-picker sticker-picker" onClick={e => e.stopPropagation()}>
                  <div className="sticker-picker-tabs">
                    <button
                      onClick={() => setStickerTab("emojis")}
                      className={stickerTab === "emojis" ? "active" : ""}
                    >
                      Emojis
                    </button>
                    <button
                      onClick={() => setStickerTab("salvas")}
                      className={stickerTab === "salvas" ? "active" : ""}
                    >
                      Figurinhas ({figurinhasSalvas.length})
                    </button>
                  </div>
                  {stickerTab === "emojis" && (
                    <div className="emoji-picker-grid">
                      {COMMON_EMOJIS.map(e => (
                        <button key={e} className="emoji-btn" onClick={() => addEmoji(e)}>{e}</button>
                      ))}
                    </div>
                  )}
                  {stickerTab === "salvas" && (
                    <div className="sticker-grid">
                      {figurinhasSalvas.length === 0 && (
                        <p className="sticker-empty">Figurinhas recebidas de clientes aparecerão aqui</p>
                      )}
                      {figurinhasSalvas.map((s, i) => (
                        <img
                          key={i}
                          src={s.url}
                          className="sticker-thumb"
                          title={`De ${s.de}`}
                          loading="lazy"
                          onClick={() => { enviarMidia(s.url, "sticker"); setShowEmojiPicker(false); }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {showAttachMenu && (
                <div className="attach-menu" onClick={e => e.stopPropagation()}>
                  <button
                    type="button"
                    className="attach-item"
                    onClick={() => { imageInputRef.current?.click(); setShowAttachMenu(false); }}
                  >
                    <MdImage size={20} /> Imagem
                  </button>
                  <button
                    type="button"
                    className="attach-item"
                    onClick={() => { stickerInputRef.current?.click(); setShowAttachMenu(false); }}
                  >
                    <MdInsertEmoticon size={20} /> Figurinha (.webp)
                  </button>
                  <button
                    type="button"
                    className="attach-item"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <MdAttachFile size={20} /> Arquivo (PDF, doc…)
                  </button>
                  <button type="button" className="attach-item" onClick={handleSendLocation}>
                    <MdLocationOn size={20} /> Localização
                  </button>
                </div>
              )}

              <input
                ref={imageInputRef}
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={e => handleFileSelected(e, "image")}
              />
              <input
                ref={stickerInputRef}
                type="file"
                accept="image/webp,.webp"
                style={{ display: "none" }}
                onChange={e => handleFileSelected(e, "sticker")}
              />
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.doc,.docx,.xls,.xlsx,.zip,.txt"
                style={{ display: "none" }}
                onChange={e => handleFileSelected(e, "document")}
              />

              {isSendingMedia && (
                <div
                  className="media-upload-indicator"
                  style={{ padding: "4px 12px", fontSize: 12, opacity: 0.7 }}
                >
                  Enviando arquivo…
                </div>
              )}

              {isRecording && (
                <div
                  className="recording-indicator"
                  style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", fontSize: 13 }}
                >
                  <span
                    className="recording-dot"
                    style={{
                      width: 8, height: 8, borderRadius: "50%",
                      background: "#ef4444", display: "inline-block",
                    }}
                  />
                  Gravando {Math.floor(recordSeconds / 60)}:{String(recordSeconds % 60).padStart(2, "0")}
                  <button
                    type="button"
                    onClick={cancelarGravacaoAudio}
                    style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer" }}
                  >
                    <MdClose size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={pararGravacaoAudio}
                    style={{ background: "none", border: "none", cursor: "pointer", color: "#22c55e" }}
                  >
                    <MdSend size={16} />
                  </button>
                </div>
              )}

              <form
                className="chat-input-form"
                onSubmit={e => { e.preventDefault(); sendMessage(); }}
              >
                <button
                  type="button"
                  className="input-icon-btn"
                  onClick={e => {
                    e.stopPropagation();
                    setShowEmojiPicker(v => { if (!v) setStickerTab("emojis"); return !v; });
                    setShowAttachMenu(false);
                  }}
                >
                  <MdInsertEmoticon size={22} />
                </button>
                <button
                  type="button"
                  className="input-icon-btn"
                  onClick={e => {
                    e.stopPropagation();
                    setShowAttachMenu(v => !v);
                    setShowEmojiPicker(false);
                  }}
                >
                  <MdAttachFile size={22} />
                </button>
                <button
                  type="button"
                  className="input-icon-btn quick-reply-trigger"
                  onClick={e => { e.stopPropagation(); setShowQuickReplies(v => !v); }}
                >
                  <MdBolt size={20} />
                </button>
                <textarea
                  ref={textareaRef}
                  className="chat-textarea"
                  placeholder="Escreva uma mensagem ou use / para atalhos…"
                  value={inputText}
                  rows={1}
                  onChange={handleInputChange}
                  onKeyDown={handleKeyDown}
                  onClick={() => { setShowAttachMenu(false); setShowEmojiPicker(false); }}
                />
                {inputText.trim() ? (
                  <button type="submit" className="btn-send ready">
                    <MdSend size={17} style={{ marginLeft: "2px" }} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`btn-send${isRecording ? " ready" : ""}`}
                    style={isRecording ? { background: "#ef4444", color: "#fff" } : undefined}
                    onMouseDown={e => { e.stopPropagation(); if (!isRecording) iniciarGravacaoAudio(); }}
                    onTouchStart={e => { e.preventDefault(); if (!isRecording) iniciarGravacaoAudio(); }}
                  >
                    <MdOutlineMic size={17} />
                  </button>
                )}
              </form>

              {!canSendManualMessage && (
                <div className="manual-window-closed" role="status">
                  <span className="manual-window-closed-icon" aria-hidden="true">
                    <MdLockOutline size={19} />
                  </span>
                  <div className="manual-window-closed-copy">
                    <strong>Janela de atendimento encerrada</strong>
                    <span>Até o cliente responder, o WhatsApp permite apenas mensagens de template.</span>
                  </div>
                  <button type="button" onClick={openTemplateForActiveChat}>
                    Escolher template <MdArrowForward size={16} />
                  </button>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="chat-empty-state">
            <div className="empty-state-orb" aria-hidden="true">
              <MdForum size={26} />
            </div>
            <h3>Selecione uma conversa</h3>
            <p>Escolha um cliente na lista para consultar o histórico e continuar o atendimento.</p>
            <div className="empty-state-actions">
              <button type="button" className="empty-primary-action" onClick={() => openNewConversation()}>
                Iniciar conversa <MdArrowForward size={17} />
              </button>
              <button type="button" className="empty-secondary-action" onClick={() => sidebarSearchRef.current?.focus()}>
                Buscar cliente
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="right-panel-wrapper">
        <button 
          className="mobile-close-panel-btn" 
          onClick={() => {
            setIsContextPanelOpen(false);
            setShowMobilePendencias(false);
          }}
        >
          <MdArrowBack size={24} /> Voltar
        </button>

        {activeChat && isContextPanelOpen ? (
          <ContextPanel
            activeChat={activeChat}
            pendenciasDoChat={pendenciasDoChat}
            isLogisticsOpen={isLogisticsOpen}
            setIsLogisticsOpen={setIsLogisticsOpen}
            onCloseActiveChat={handleCloseActiveChat}
            onOpenHistory={() => setIsHistoryModalOpen(true)}
            onOpenFicha={() => setIsFichaModalOpen(true)}
            pedidoDetalhe={pedidoDetalhe}
            onTogglePedido={handleToggleDetalhesPedido}
            onAddPendencia={handleAddPendencia}
            onSetOrderBlocked={handleSetOrderBlocked}
            isOrderBlockUpdating={isOrderBlockUpdating}
          />
        ) : !activeChat ? (
          <PainelPendencias
            pendencias={pendencias}
            conversas={conversas}
            onResolve={handleResolvePendencia}
            onAdd={handleAddPendencia}
            onGoToChat={handleSelectChat}
            offline={pendenciasOffline}
          />
        ) : null}
      </div>

      {/* ─── MODAIS ─── */}
      <ModalBase
        isOpen={isHistoryModalOpen}
        onClose={() => setIsHistoryModalOpen(false)}
        title={`Calendário · ${activeChat?.clientName}`}
      >
        <div className="modal-calendar-body">
          <div className="calendar-wrap">
            <DatePicker
              selected={null}
              onChange={() => { /* navegação apenas */ }}
              highlightDates={datasHistorico}
              inline
            />
          </div>
        </div>
      </ModalBase>

      <ModalBase
        isOpen={isFichaModalOpen}
        onClose={() => setIsFichaModalOpen(false)}
        title={`Ficha · ${activeChat?.clientName}`}
      >
        <div className="modal-ficha-body">
          <div className="ficha-header-row">
            <div>
              <span className="ficha-label">Telefone</span>
              <p className="ficha-value">{activeChat?.phone}</p>
            </div>
            <div className="text-right">
              <span className="ficha-label">Cliente desde</span>
              <p className="ficha-value">
                {activeChat?.criadoEm
                  ? new Date(activeChat.criadoEm.toMillis()).toLocaleDateString("pt-BR", {
                    month: "short", year: "numeric",
                  })
                  : "—"}
              </p>
            </div>
          </div>
          <div className="ficha-stats-row">
            <div className="ficha-stat">
              <span className="ficha-label">Total de Pedidos</span>
              <p className="ficha-stat-value">{activeChat?.totalOrders}</p>
            </div>
            <div className="ficha-stat">
              <span className="ficha-label">LTV Acumulado</span>
              <p className="ficha-stat-value green">{activeChat?.ltv}</p>
            </div>
            <div className="ficha-stat">
              <span className="ficha-label">Tags</span>
              <div className="ficha-tags">
                {activeChat?.tags.map(t => (
                  <span key={t} className={`tag-badge ${getTagClass(t)}`}>{t}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </ModalBase>

      <ModalFinalizar
        isOpen={isFinalizarOpen}
        clientName={activeChat?.clientName ?? ""}
        chatId={activeChatId ?? ""}
        pendenciasAbertas={pendenciasDoChat}
        onClose={() => setIsFinalizarOpen(false)}
        onConfirm={() => {
          if (activeChatId) handleFinalizarConversa(activeChatId);
          setIsFinalizarOpen(false);
          setActiveChatId(null);
        }}
        onGoToPendencias={() => { setIsFinalizarOpen(false); setActiveChatId(null); }}
      />

      <ModalFrases
        isOpen={isFrasesModalOpen}
        frases={frasesPredefinidas}
        onClose={() => setIsFrasesModalOpen(false)}
        onSave={handleSalvarFrases}
      />
      <ModalTags
        isOpen={isTagsModalOpen}
        tagsGlobais={tagsGlobais}
        onClose={() => setIsTagsModalOpen(false)}
        onSave={handleSalvarTags}
      />
      <ModalAplicarTags
        isOpen={isAplicarTagsOpen}
        conversa={activeChat}
        tagsGlobais={tagsGlobais}
        onClose={() => setIsAplicarTagsOpen(false)}
        onSave={handleAplicarTags}
      />
      <ModalIniciarConversa
        isOpen={isIniciarConversaOpen}
        templates={templates}
        initialPhone={iniciarConversaDefaults?.phone ?? ""}
        initialName={iniciarConversaDefaults?.name ?? ""}
        mode={iniciarConversaDefaults?.mode ?? "new"}
        onClose={closeNewConversation}
        onConfirm={handleIniciarConversa}
      />

      <ModalBase
        isOpen={!!editNomeChatId}
        onClose={() => setEditNomeChatId(null)}
        title="Editar nome do cliente"
      >
        <div className="modal-frases-body">
          <input
            className="pendencia-input"
            placeholder="Nome do cliente"
            value={editNomeValor}
            onChange={e => setEditNomeValor(e.target.value)}
            autoFocus
            onKeyDown={e => { if (e.key === "Enter") salvarEdicaoNome(); }}
          />
          <div className="finalizar-actions" style={{ marginTop: 12 }}>
            <button className="pf-cancel" onClick={() => setEditNomeChatId(null)}>
              Cancelar
            </button>
            <button
              className="pf-save"
              onClick={salvarEdicaoNome}
              disabled={!editNomeValor.trim()}
            >
              <MdCheckCircle size={16} /> Salvar
            </button>
          </div>
        </div>
      </ModalBase>

      <ModalBase
        isOpen={!!forwardingMsg}
        onClose={() => { setForwardingMsg(null); setForwardPhone(""); setForwardListOpen(false); }}
        title="Encaminhar mensagem"
      >
        <div className="modal-frases-body">
          {forwardingMsg && (
            <div style={{ marginBottom: 10, fontSize: 13, color: "var(--sys-color-text-muted, #54656f)" }}>
              {forwardingMsg.mediaType === "image" ? "📷 Imagem"
                : forwardingMsg.mediaType === "audio" ? "🎵 Áudio"
                : forwardingMsg.mediaType === "video" ? "🎬 Vídeo"
                : forwardingMsg.mediaType === "document" ? "📄 Documento"
                : forwardingMsg.mediaType === "location" ? "📍 Localização"
                : (forwardingMsg.text ?? "")}
            </div>
          )}
          <div style={{ position: "relative" }}>
  <input
    className="pendencia-input"
    placeholder="Nome ou número (ex.: João ou 5592999999999)"
    value={forwardPhone}
    onChange={e => { setForwardPhone(e.target.value); setForwardListOpen(true); }}
    onFocus={() => setForwardListOpen(true)}
    onBlur={() => setTimeout(() => setForwardListOpen(false), 150)}
    autoFocus
    onKeyDown={e => { if (e.key === "Enter") handleForwardMessage(); }}
  />
  {forwardListOpen && forwardSuggestions.length > 0 && (
    <div className="forward-suggestions">
      {forwardSuggestions.map(c => (
        <button
          key={c.id}
          type="button"
          className="forward-suggestion-item"
          onMouseDown={e => e.preventDefault()} // evita perder foco antes do click
          onClick={() => {
            setForwardPhone(c.id);
            setForwardListOpen(false);
          }}
        >
          <Avatar name={c.clientName} size={28} />
          <div className="forward-suggestion-info">
            <span className="fs-name">{c.clientName}</span>
            <span className="fs-phone">{c.phone}</span>
          </div>
        </button>
      ))}
    </div>
  )}
</div>
          <div className="finalizar-actions" style={{ marginTop: 12 }}>
            <button
              className="pf-cancel"
              onClick={() => { setForwardingMsg(null); setForwardPhone(""); }}
            >
              Cancelar
            </button>
            <button
              className="pf-save"
              onClick={handleForwardMessage}
              disabled={!forwardPhone.trim() || isForwarding}
            >
              <MdForward size={16} /> {isForwarding ? "Encaminhando..." : "Encaminhar"}
            </button>
          </div>
        </div>
      </ModalBase>
      {mediaViewer?.type === 'image' && (
        <div
          className="fullscreen-image-viewer fade-in"
          onClick={() => {
            setMediaViewer(null);
            setIsZoomed(false); // Reseta o zoom ao fechar
          }}
        >
          <img
            src={mediaViewer.url}
            alt="Mídia Ampliada"
            className={`fullscreen-image ${isZoomed ? 'zoomed' : ''}`}
            onClick={(e) => {
              e.stopPropagation(); // Evita fechar o visualizador ao clicar na imagem
              setIsZoomed(prev => !prev);
            }}
          />
        </div>
      )}

      {/* ─── MANTÉM O MODALBASE APENAS PARA DOCUMENTOS/PDF ─── */}
      <ModalBase
        isOpen={mediaViewer?.type === 'document'}
        onClose={() => setMediaViewer(null)}
        title="Visualizador de Documento"
      >
        <div style={{ padding: '10px 0' }}>
          <iframe src={mediaViewer?.url} className="media-viewer-iframe" title="Documento" />
        </div>
      </ModalBase>
    </div> /* Fechamento da div .chat-container principal */
  );
}

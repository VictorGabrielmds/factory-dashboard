import { useEffect, useState, useMemo, useRef, Suspense } from "react";
import "./MotoboyDashboard.css";
import {
  db,
  query,
  getDocs,
  where,
  collection,
  onSnapshot,
  deleteDoc,
  type DocumentData,
  QuerySnapshot,
  doc,
  setDoc,
  updateDoc,
} from "../../services/firebase";
import { deleteField } from "firebase/firestore";

import AddOrderButtom from "./help/AddOrderButtom";
import ModalBase from "../ModalBase/ModalBase";

import {
  BsCircleFill as CircleFill,
  BsExclamationCircleFill as ExclamationCircleFill,
  BsCalendarDate as CalendarDate,
  BsInboxFill as InboxFill,
} from "react-icons/bs";
import {
  MdAdd,
  MdDeleteOutline,
  MdChevronLeft,
  MdChevronRight,
  MdSearch,
  MdClose,
  MdHistory,
  MdCheck,
  MdEditNote,
  MdWhatsapp,
  MdOutlineDeliveryDining,
  MdOutlinePayments,
  MdOutlinePeopleAlt,
} from "react-icons/md";
import type { Pedido } from "../../types/Pedido";
import {
  FUNDOS,
  SEM_TRACO,
  urlAvatarMotoboy,
  sortearSementeAvatar,
  sortearTracos,
  limparTracos,
} from "./avatarMotoboy";
import { TRACOS, type Traco } from "./avatarOpcoes";
import EntregasHoje from "./help/EntregasHoje";
import LazyDatePicker from "../Shared/LazyDatePicker";

/* ============================
   📌 Types
============================ */
interface Motoboy {
  lastPayment: string;
  id?: string;
  nome: string;
  fixo: boolean;
  entregas: number;
  taxas: number;
  extras?: Record<string, ExtrasItem>;
  lastDelivery?: string;
  // Só dígitos, com DDI+DDD (ex.: 5598991234567) — mesmo formato usado no
  // resto do sistema pra montar link de WhatsApp.
  telefone?: string;
  // Avatar montado no editor (ver avatarMotoboy.ts). Sem estes campos, o
  // desenho cai no nome, que é como os avatares de cliente no chat já
  // funcionam — ninguém fica sem carinha e não precisa migrar dado.
  avatarSeed?: string;
  /** Traço a traço, no formato do DiceBear: { hair: "variant05", ... } */
  avatarOpcoes?: Record<string, string>;
  avatarFundo?: string;
}

interface ExtrasItem {
  haveMachine: boolean;
  machineNumber: string;
}

type VisaoEquipe = "todos" | "ativos" | "pendencias";

/* ============================
   📌 Utils
============================ */
const normalizeText = (text: string): string =>
  text.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const formatMotoboyId = (nome: string): string =>
  normalizeText(nome.trim()).replace(/\s+/g, "_").toLowerCase();

const formatName = (nome: string): string => {
  const preps = ["da", "de", "do", "das", "dos", "e"];
  return nome
    .toLowerCase()
    .split(" ")
    .map((palavra, i) =>
      i > 0 && preps.includes(palavra)
        ? palavra
        : palavra.charAt(0).toUpperCase() + palavra.slice(1)
    )
    .join(" ");
};

// Guarda só dígitos com DDI+DDD (5598991234567) — mesmo formato que o resto
// do sistema usa pra montar link de WhatsApp. 12 dígitos = fixo/8 dígitos,
// 13 = celular com o nono dígito.
const TELEFONE_VALIDO = /^55\d{10,11}$/;

// "5598991234567" → "(98) 99123-4567". Mostra o que a pessoa reconhece,
// escondendo o DDI que fica implícito.
const formatarTelefoneVisivel = (bruto: string): string => {
  const d = bruto.replace(/\D/g, "").replace(/^55/, "").slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  const corte = d.length > 10 ? 7 : 6;
  return `(${d.slice(0, 2)}) ${d.slice(2, corte)}-${d.slice(corte)}`;
};

// Só dígitos, sempre com o 55 na frente — o que vai pro Firestore.
const telefoneParaGravar = (visivel: string): string => {
  const d = visivel.replace(/\D/g, "");
  if (!d) return "";
  return d.startsWith("55") ? d : `55${d}`;
};

// "variant05" / "shortHairShortFlat" não dizem nada pra quem está montando o
// avatar. Vira "5 de 48" (posição na lista), que é o que a pessoa acompanha
// enquanto gira as setas. Sem escolha, mostra o que veio do sorteio da semente.
const rotuloDoTraco = (traco: Traco, valor: string | undefined): string => {
  if (valor === undefined) return `— de ${traco.valores.length}`;
  if (valor === SEM_TRACO) return "Nenhum";
  const i = traco.valores.indexOf(valor);
  return i === -1 ? valor : `${i + 1} de ${traco.valores.length}`;
};

const countPendingExtras = (motoboy: Motoboy): number =>
  Object.values(motoboy.extras ?? {}).filter((extra) => extra?.haveMachine).length;

const formatDateTime = (date: Date): string => {
  date.setMinutes(date.getMinutes() - 1);
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} às ${hh}:${mi}`;
};

const parseDateTime = (dateStr: string): Date => {
  try {
    const [d, t] = dateStr.split(" às ");
    const [day, month, year] = d.split("/").map(Number);
    const [hour, min] = t.split(":").map(Number);
    return new Date(year, month - 1, day, hour, min);
  } catch {
    return new Date(0);
  }
};

const isToday = (dateStr?: string): boolean => {
  if (!dateStr) return false;
  const d = parseDateTime(dateStr);
  const now = new Date();
  return (
    d.getDate() === now.getDate() &&
    d.getMonth() === now.getMonth() &&
    d.getFullYear() === now.getFullYear()
  );
};

// Compara se uma data é hoje ou está no futuro (usado para travar o botão "próximo dia")
const isTodayOrFuture = (date: Date): boolean => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const cmp = new Date(date);
  cmp.setHours(0, 0, 0, 0);
  return cmp.getTime() >= today.getTime();
};

// Formata um valor numérico (ou string numérica) como moeda BRL, com fallback "—"
const formatCurrencySafe = (value: unknown): string => {
  const parsed = parseFloat(String(value ?? "").replace(",", "."));
  if (isNaN(parsed)) return "—";
  return parsed.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
};

/* ============================
   📌 Component
============================ */
const MotoboyDashboard = () => {
  const [motoboys, setMotoboys] = useState<Motoboy[]>([]);
  const [newName, setNewName] = useState("");
  const [isFixed, setIsFixed] = useState(false);
  const [coopRate, setCoopRate] = useState(0);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [isPayModalOpen, setIsPayModalOpen] = useState(false);
  const [isExtrasModalOpen, setIsExtrasModalOpen] = useState(false);

  // ─── LÓGICA DE HISTÓRICO ───
  const [isOrdersModalOpen, setIsOrdersModalOpen] = useState(false);
  const [historyDate, setHistoryDate] = useState<Date>(new Date());
  const [isHistoryCalendarOpen, setIsHistoryCalendarOpen] = useState(false);

  const [isNewMotoboyModalOpen, setIsNewMotoboyModalOpen] = useState(false);

  // ─── EDIÇÃO DE CADASTRO (nome, WhatsApp, avatar) ───
  const [motoboyEmEdicao, setMotoboyEmEdicao] = useState<Motoboy | null>(null);
  const [edicaoNome, setEdicaoNome] = useState("");
  const [edicaoTelefone, setEdicaoTelefone] = useState("");
  const [edicaoSeed, setEdicaoSeed] = useState("");
  const [edicaoOpcoes, setEdicaoOpcoes] = useState<Record<string, string>>({});
  const [edicaoFundo, setEdicaoFundo] = useState("");
  const [editorAvatarAberto, setEditorAvatarAberto] = useState(false);
  const [salvandoEdicao, setSalvandoEdicao] = useState(false);

  const [motoboySelected, setMotoboySelected] = useState<Motoboy | null>(null);
  const [totalPedidos, setTotalPedidos] = useState<number>(0);
  const [pendingExtras, setPendingExtras] = useState<[string, ExtrasItem][]>([]);
  const [selectedOrders, setSelectedOrders] = useState<DocumentData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [visaoEquipe, setVisaoEquipe] = useState<VisaoEquipe>("todos");
  const inputRef = useRef<HTMLInputElement>(null);

  /* ============================
     🔄 Load motoboys
  ============================ */
  useEffect(() => {
    const q = collection(db, "motoboys");
    const unsubscribe = onSnapshot(q, async (snapshot: QuerySnapshot<DocumentData>) => {
      setIsLoading(true);

      const list = snapshot.docs.map((doc) => ({
        id: doc.id,
        ...(doc.data() as Omit<Motoboy, "id">),
      }));

      setMotoboys(list);

      const somaTaxas = list.filter((m) => !m.fixo).reduce((acc, m) => acc + m.taxas, 0);
      setCoopRate(somaTaxas);

      setIsLoading(false);
    });

    return () => unsubscribe();
  }, []);

  /* ============================
     📌 Actions
  ============================ */
  const addMotoboy = async () => {
    if (!newName.trim()) return;

    const id = formatMotoboyId(newName);
    const docRef = doc(db, "motoboys", id);

    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);

    const day = String(midnight.getDate()).padStart(2, "0");
    const month = String(midnight.getMonth() + 1).padStart(2, "0");
    const year = String(midnight.getFullYear()).slice(-2);
    const payment = `${day}/${month}/${year} 00:00:00`;

    await setDoc(docRef, {
      nome: newName.trim(),
      fixo: isFixed,
      entregas: 0,
      lastPayment: payment,
      taxas: 0,
      lastDelivery: formatDateTime(new Date()),
    });

    setNewName("");
    setIsFixed(false);
    setIsNewMotoboyModalOpen(false);
  };

  const filteredMotoboys = useMemo(() => {
    const busca = normalizeText(searchTerm.trim().toLowerCase());
    return motoboys.filter((motoboy) => {
      const correspondeBusca =
        !busca || normalizeText(motoboy.nome.toLowerCase()).includes(busca);
      const correspondeVisao =
        visaoEquipe === "todos" ||
        (visaoEquipe === "ativos" && isToday(motoboy.lastDelivery)) ||
        (visaoEquipe === "pendencias" && countPendingExtras(motoboy) > 0);

      return correspondeBusca && correspondeVisao;
    });
  }, [motoboys, searchTerm, visaoEquipe]);

  const confirmDeleteMotoboy = (motoboy: Motoboy) => {
    setMotoboySelected(motoboy);
    setIsDeleteModalOpen(true);
  };

  const deleteMotoboy = async () => {
    if (!motoboySelected?.id) return;
    try {
      await deleteDoc(doc(db, "motoboys", motoboySelected.id));
      setIsDeleteModalOpen(false);
      setMotoboySelected(null);
    } catch (err) {
      console.error("Erro ao excluir:", err);
    }
  };

  const confirmPayMotoboy = (motoboy: Motoboy) => {
    setMotoboySelected(motoboy);
    setIsPayModalOpen(true);
  };

  const payMotoboy = async () => {
    if (!motoboySelected?.id) return;
    try {
      await updateDoc(doc(db, "motoboys", motoboySelected.id), {
        entregas: 0,
        taxas: 0,
        lastDelivery: formatDateTime(new Date(Date.now() - 3 * 86400000)),
        lastPayment: getDateTimeString(),
      });
      setIsPayModalOpen(false);
      setMotoboySelected(null);
    } catch (err) {
      console.error("Erro ao pagar:", err);
    }
  };

  const toggleFixedStatus = async (motoboy: Motoboy) => {
    if (!motoboy.id) return;
    try {
      await updateDoc(doc(db, "motoboys", motoboy.id), {
        fixo: !motoboy.fixo,
      });
    } catch (err) {
      console.error("Erro ao atualizar fixo:", err);
    }
  };

  const abrirEdicaoCadastro = (motoboy: Motoboy) => {
    setMotoboyEmEdicao(motoboy);
    setEdicaoNome(formatName(motoboy.nome.replace(/_/g, " ")));
    setEdicaoTelefone(formatarTelefoneVisivel(motoboy.telefone ?? ""));
    setEdicaoSeed(motoboy.avatarSeed ?? "");
    setEdicaoOpcoes(limparTracos(motoboy.avatarOpcoes));
    setEdicaoFundo(motoboy.avatarFundo ?? "");
    setEditorAvatarAberto(false);
  };

  const escolherTraco = (chave: string, valor: string) =>
    setEdicaoOpcoes((atual) => ({ ...atual, [chave]: valor }));

  const zapCompleto = TELEFONE_VALIDO.test(telefoneParaGravar(edicaoTelefone));

  // Uma fonte só pro preview e pro que vai ser gravado — assim o que a pessoa
  // vê é exatamente o que salva.
  const previewAvatar = useMemo(
    () => ({
      nome: edicaoNome || motoboyEmEdicao?.nome || "",
      avatarSeed: edicaoSeed,
      avatarOpcoes: edicaoOpcoes,
      avatarFundo: edicaoFundo,
    }),
    [edicaoNome, motoboyEmEdicao, edicaoSeed, edicaoOpcoes, edicaoFundo]
  );

  // Avança/volta dentro da lista do traço, dando a volta nas pontas. Traço
  // opcional ganha "Nenhum" como se fosse mais um item da lista.
  const girarTraco = (traco: Traco, passo: 1 | -1) => {
    const lista = traco.opcional ? [SEM_TRACO, ...traco.valores] : traco.valores;
    const atual = edicaoOpcoes[traco.chave];
    const i = atual === undefined ? -1 : lista.indexOf(atual);
    const proximo = (((i === -1 ? 0 : i + passo) % lista.length) + lista.length) % lista.length;
    escolherTraco(traco.chave, lista[proximo]);
  };

  const salvarEdicaoCadastro = async () => {
    if (!motoboyEmEdicao?.id) return;

    const nome = edicaoNome.trim();
    if (!nome) return;

    const digitos = telefoneParaGravar(edicaoTelefone);
    // Aceita vazio (limpar o cadastro) ou um número brasileiro completo.
    if (digitos && !TELEFONE_VALIDO.test(digitos)) return;

    setSalvandoEdicao(true);
    try {
      // ⚠️ O ID do documento NUNCA muda aqui, mesmo renomeando: ele é o nome
      // normalizado de quando o motoboy foi criado, e é esse valor que ficou
      // gravado em motoboy_id de todos os pedidos já entregues. Trocar o ID
      // (criar doc novo + apagar o antigo) desligaria o histórico inteiro do
      // motoboy — entregas, taxas e acertos deixariam de casar.
      await updateDoc(doc(db, "motoboys", motoboyEmEdicao.id), {
        nome,
        telefone: digitos || deleteField(),
        avatarSeed: edicaoSeed.trim() || deleteField(),
        avatarOpcoes: Object.keys(edicaoOpcoes).length ? edicaoOpcoes : deleteField(),
        avatarFundo: edicaoFundo || deleteField(),
      });
      setMotoboyEmEdicao(null);
    } catch (err) {
      console.error("Erro ao salvar cadastro do motoboy:", err);
    } finally {
      setSalvandoEdicao(false);
    }
  };

  // ─── MÁQUINA DO TEMPO: Buscar pedidos por data específica ───
  const fetchOrdersByDate = async (motoboy: Motoboy, targetDate: Date) => {
    if (!motoboy.id) return;

    try {
      const q = query(
        collection(db, "pedidos"),
        where("status", "==", 5),
        where("motoboy_id", "==", motoboy.id.toLowerCase())
      );

      const snapshot = await getDocs(q);

      const startOfDay = new Date(targetDate);
      startOfDay.setHours(0, 0, 0, 0);

      const orders: Pedido[] = snapshot.docs
        .map((d) => ({ id: d.id, ...(d.data() as Omit<Pedido, "id">) }))
        .filter((order) => {
          if (!order.data_saida) return false;
          const dataSaida = parseDateTime(order.data_saida);
          const orderStartOfDay = new Date(dataSaida);
          orderStartOfDay.setHours(0, 0, 0, 0);

          return orderStartOfDay.getTime() === startOfDay.getTime();
        });

      const total = orders.reduce((acc, o) => {
        const valor = parseFloat(String(o.valor_taxa ?? "0").replace(",", "."));
        return acc + (isNaN(valor) ? 0 : valor);
      }, 0);

      setSelectedOrders(orders);
      setTotalPedidos(total);
    } catch (err) {
      console.error("Erro ao buscar pedidos do histórico:", err);
    }
  };

  // Quando abre o modal ou muda a data do histórico
  useEffect(() => {
    if (isOrdersModalOpen && motoboySelected) {
      fetchOrdersByDate(motoboySelected, historyDate);
    }
  }, [historyDate, isOrdersModalOpen, motoboySelected]);

  const openOrdersModal = (motoboy: Motoboy) => {
    setMotoboySelected(motoboy);
    setHistoryDate(new Date()); // Reseta para hoje sempre que abre
    setIsOrdersModalOpen(true);
  };

  const reloadOrders = async () => {
    if (!motoboySelected?.id) return;
    await fetchOrdersByDate(motoboySelected, historyDate);
  };

  // Navega o histórico um dia para trás/frente (usado pelas setas do toolbar)
  const shiftHistoryDate = (days: number) => {
    setIsHistoryCalendarOpen(false);
    setHistoryDate((prev) => {
      const next = new Date(prev);
      next.setDate(next.getDate() + days);
      return next;
    });
  };

  const openExtrasModal = (motoboy: Motoboy) => {
    if (!motoboy.extras) return;

    const pendentes = Object.entries(motoboy.extras).filter(
      ([, e]) => e && e.haveMachine
    );

    setMotoboySelected(motoboy);
    setPendingExtras(pendentes);
    setIsExtrasModalOpen(true);
  };

  const removeExtra = async (extraKey: string) => {
    if (!motoboySelected?.id) return;

    const newExtras = { ...motoboySelected.extras };
    delete newExtras?.[extraKey];

    try {
      await updateDoc(doc(db, "motoboys", motoboySelected.id), { extras: newExtras });
      setMotoboys((prev) =>
        prev.map((m) =>
          m.id === motoboySelected.id ? { ...m, extras: newExtras } : m
        )
      );
      setMotoboySelected((prev) => (prev ? { ...prev, extras: newExtras } : null));
      setPendingExtras((prev) => prev.filter(([key]) => key !== extraKey));
      if (!Object.keys(newExtras || {}).length) setIsExtrasModalOpen(false);
    } catch (err) {
      console.error("Erro ao remover extra:", err);
    }
  };

  /* ============================
     📌 Derived state
  ============================ */
  const motoboysSorted = useMemo(
    () =>
      [...filteredMotoboys].sort(
        (a, b) =>
          parseDateTime(b.lastDelivery || "").getTime() -
          parseDateTime(a.lastDelivery || "").getTime()
      ),
    [filteredMotoboys]
  );

  const totalAtivosHoje = useMemo(
    () => motoboys.filter((motoboy) => isToday(motoboy.lastDelivery)).length,
    [motoboys]
  );

  const totalEntregasAcumuladas = useMemo(
    () => motoboys.reduce((total, motoboy) => total + (Number(motoboy.entregas) || 0), 0),
    [motoboys]
  );

  const totalComPendencias = useMemo(
    () => motoboys.filter((motoboy) => countPendingExtras(motoboy) > 0).length,
    [motoboys]
  );

  const sortedSelectedOrders = useMemo(
    () =>
      selectedOrders
        .slice()
        .sort(
          (a, b) =>
            parseDateTime(a.data_saida || "").getTime() -
            parseDateTime(b.data_saida || "").getTime()
        ),
    [selectedOrders]
  );

  /* ============================
     📌 UI
  ============================ */
  return (
    <div className="motoboy-dashboard">
      <section className="motoboy-overview" aria-label="Resumo da equipe de motoboys">
        <div className="motoboy-overview-copy">
          <span className="motoboy-overview-kicker">
            <span className="motoboy-live-dot" aria-hidden="true" />
            Operação de hoje
          </span>
          <h2>{totalAtivosHoje === 1 ? "1 motoboy rodou hoje" : `${totalAtivosHoje} motoboys rodaram hoje`}</h2>
          <p>Acompanhe a equipe e finalize os acertos sem perder o contexto.</p>
        </div>

        <div className="motoboy-metrics">
          <div className="motoboy-metric">
            <span className="motoboy-metric-icon"><MdOutlinePeopleAlt /></span>
            <span>
              <small>Ativos hoje</small>
              <strong>{totalAtivosHoje}</strong>
            </span>
          </div>
          <div
            className="motoboy-metric"
            title="Soma das entregas registradas desde o último acerto de cada motoboy."
          >
            <span className="motoboy-metric-icon"><MdOutlineDeliveryDining /></span>
            <span>
              <small>Entregas acumuladas</small>
              <strong>{totalEntregasAcumuladas}</strong>
            </span>
          </div>
          <div className="motoboy-metric">
            <span className="motoboy-metric-icon"><MdOutlinePayments /></span>
            <span>
              <small>Cooperativa</small>
              <strong>{coopRate.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</strong>
            </span>
          </div>
        </div>

        <div className="motoboy-overview-actions">
          <EntregasHoje motoboys={motoboys} />
          <button
            type="button"
            className="motoboy-add-button"
            onClick={() => setIsNewMotoboyModalOpen(true)}
          >
            <MdAdd size={18} /> Novo motoboy
          </button>
        </div>
      </section>

      <section className="motoboy-team-panel">
        <div className="motoboy-team-toolbar">
          <div className="motoboy-team-title">
            <div>
              <h2>Equipe</h2>
              <span className="motoboy-team-count">{motoboys.length}</span>
            </div>
            <p>Valores acumulados desde o último acerto.</p>
          </div>

          <div className="motoboy-search">
            <MdSearch size={18} aria-hidden="true" />
            <input
              ref={inputRef}
              type="search"
              value={searchTerm}
              aria-label="Buscar motoboy por nome"
              placeholder="Buscar motoboy"
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            {searchTerm && (
              <button
                type="button"
                onClick={() => {
                  setSearchTerm("");
                  inputRef.current?.focus();
                }}
                aria-label="Limpar busca"
                title="Limpar busca"
              >
                <MdClose size={17} />
              </button>
            )}
          </div>
        </div>

        <div className="motoboy-view-filters" aria-label="Filtrar equipe">
          <button
            type="button"
            className={visaoEquipe === "todos" ? "active" : ""}
            onClick={() => setVisaoEquipe("todos")}
            aria-pressed={visaoEquipe === "todos"}
          >
            Todos <span>{motoboys.length}</span>
          </button>
          <button
            type="button"
            className={visaoEquipe === "ativos" ? "active" : ""}
            onClick={() => setVisaoEquipe("ativos")}
            aria-pressed={visaoEquipe === "ativos"}
          >
            Ativos hoje <span>{totalAtivosHoje}</span>
          </button>
          <button
            type="button"
            className={visaoEquipe === "pendencias" ? "active" : ""}
            onClick={() => setVisaoEquipe("pendencias")}
            aria-pressed={visaoEquipe === "pendencias"}
          >
            Com pendência <span>{totalComPendencias}</span>
          </button>
        </div>

        <div className="table-container">
          <table className="md-table">
            <thead>
              <tr>
                <th>Motoboy</th>
                <th>Vínculo</th>
                <th>Entregas</th>
                <th>A pagar</th>
                <th>Pendências</th>
                <th><span className="visually-hidden">Ações</span></th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr className="loading-form">
                  <td colSpan={6}><span>Carregando equipe...</span></td>
                </tr>
              ) : motoboysSorted.length === 0 ? (
                <tr className="motoboy-empty-row">
                  <td colSpan={6}>
                    <div>
                      <MdOutlinePeopleAlt size={26} />
                      <strong>Nenhum motoboy encontrado</strong>
                      <span>Ajuste a busca ou escolha outro filtro.</span>
                    </div>
                  </td>
                </tr>
              ) : motoboysSorted.map((m) => {
                const pendencias = countPendingExtras(m);
                const ativoHoje = isToday(m.lastDelivery);

                return (
                  <tr
                    key={m.id}
                    className={ativoHoje ? "active-moto" : "non-active-moto"}
                  >
                    <td>
                      <button
                        type="button"
                        className="motoboy-identity"
                        onClick={() => openOrdersModal(m)}
                        title={`Ver histórico de ${m.nome}`}
                      >
                        <img
                          className="motoboy-avatar"
                          src={urlAvatarMotoboy(m, 44)}
                          alt=""
                          width={44}
                          height={44}
                          loading="lazy"
                        />
                        <span className="motoboy-identity-copy">
                          <strong>{formatName(m.nome.replace(/_/g, " "))}</strong>
                          <span className={ativoHoje ? "motoboy-status active" : "motoboy-status"}>
                            <span aria-hidden="true" />
                            {ativoHoje ? "Ativo hoje" : "Sem atividade hoje"}
                            {m.telefone && (
                              <em className="motoboy-zap-inline">
                                <MdWhatsapp size={11} />
                                {formatarTelefoneVisivel(m.telefone)}
                              </em>
                            )}
                          </span>
                        </span>
                      </button>
                    </td>
                    <td>
                      <button
                        type="button"
                        onClick={() => toggleFixedStatus(m)}
                        className={m.fixo ? "is-fixed fixed-motoboy" : "is-fixed"}
                        aria-label={`${m.nome}: alterar vínculo atual`}
                        title="Clique para alterar o vínculo"
                      >
                        <span><CircleFill /></span>
                        {m.fixo ? "Fixo da casa" : "Parceiro"}
                      </button>
                    </td>
                    <td>
                      <span className="motoboy-number-cell">
                        <strong>{m.entregas}</strong>
                        <small>desde o acerto</small>
                      </span>
                    </td>
                    <td>
                      <span className="motoboy-money-cell">
                        {m.taxas.toLocaleString("pt-BR", {
                          style: "currency",
                          currency: "BRL",
                        })}
                      </span>
                    </td>
                    <td>
                      {pendencias > 0 ? (
                        <button
                          type="button"
                          className="extras-button"
                          onClick={() => openExtrasModal(m)}
                        >
                          <ExclamationCircleFill />
                          {pendencias} {pendencias === 1 ? "máquina" : "máquinas"}
                        </button>
                      ) : (
                        <span className="motoboy-no-pending">Tudo certo</span>
                      )}
                    </td>
                    <td>
                      <div className="motoboy-row-actions">
                        <button
                          type="button"
                          className="motoboy-history-button"
                          onClick={() => abrirEdicaoCadastro(m)}
                          aria-label={`Editar cadastro de ${m.nome}`}
                          title="Editar nome, WhatsApp e avatar"
                        >
                          <MdEditNote size={19} />
                        </button>
                        <button
                          type="button"
                          className="motoboy-history-button"
                          onClick={() => openOrdersModal(m)}
                          aria-label={`Ver histórico de ${m.nome}`}
                          title="Ver histórico"
                        >
                          <MdHistory size={18} />
                        </button>
                        <button
                          type="button"
                          className="pay-button"
                          onClick={() => confirmPayMotoboy(m)}
                        >
                          Acertar
                        </button>
                        <button
                          type="button"
                          className="trash-button"
                          onClick={() => confirmDeleteMotoboy(m)}
                          aria-label={`Excluir ${m.nome}`}
                          title="Excluir motoboy"
                        >
                          <MdDeleteOutline />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ===== Modals ===== */}
      <ModalBase
        isOpen={isDeleteModalOpen}
        onClose={() => setIsDeleteModalOpen(false)}
        title="Excluir motoboy"
      >
        <p>Tem certeza que deseja excluir <strong>{motoboySelected?.nome}</strong> da equipe?</p>
        <div className="modal-buttons" style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
          <button className="secondary" style={{ flex: 1 }} onClick={() => setIsDeleteModalOpen(false)}>
            Cancelar
          </button>
          <button className="primary" style={{ flex: 1, backgroundColor: 'var(--sys-color-danger)' }} onClick={deleteMotoboy}>Sim, excluir</button>
        </div>
      </ModalBase>

      <ModalBase
        isOpen={isPayModalOpen}
        onClose={() => setIsPayModalOpen(false)}
        title="Finalizar acerto"
      >
        <p>Finalizar o acerto com <strong>{motoboySelected?.nome}</strong>?</p>
        <p style={{ color: 'var(--sys-color-text-muted)' }}>As entregas e o valor em aberto serão zerados.</p>
        <div className="modal-buttons" style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
          <button className="secondary" style={{ flex: 1 }} onClick={() => setIsPayModalOpen(false)}>
            Cancelar
          </button>
          <button className="primary" style={{ flex: 1, backgroundColor: 'var(--sys-color-success)' }} onClick={payMotoboy}>Finalizar acerto</button>
        </div>
      </ModalBase>

      <ModalBase
        isOpen={isExtrasModalOpen}
        onClose={() => setIsExtrasModalOpen(false)}
        title={`Pendências de ${motoboySelected?.nome}`}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {pendingExtras.length > 0 ? (
            pendingExtras.map(([key, data]) => (
              <div key={key} className="card" style={{ padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <p style={{ margin: '0 0 4px', fontWeight: 600 }}>Pedido #{key}</p>
                  <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--sys-color-text-muted)' }}>Máquina: {data.machineNumber}</p>
                </div>
                <button className="btn btn-outline" onClick={() => removeExtra(key)}>Devolvida</button>
              </div>
            ))
          ) : (
            <p>Nenhum extra pendente.</p>
          )}
        </div>
      </ModalBase>

      {/* ── Modal de Histórico: navegação por data + resumo + lista de pedidos ── */}
      <ModalBase
        isOpen={isOrdersModalOpen}
        onClose={() => setIsOrdersModalOpen(false)}
        title={`Histórico de ${formatName(motoboySelected?.nome?.replace(/_/g, " ") ?? "")}`}
        className="motoboy-history-modal"
        size="lg"
      >
        <div className="history-modal-content">
          <div className="history-toolbar">
            <div className="history-date-nav">
              <button
                className="date-nav-btn"
                onClick={() => shiftHistoryDate(-1)}
                title="Dia anterior"
              >
                <MdChevronLeft size={20} />
              </button>

              <div className="history-date-picker">
                <button
                  className="date-display-btn"
                  onClick={() => setIsHistoryCalendarOpen(!isHistoryCalendarOpen)}
                >
                  <CalendarDate size={15} />
                  {historyDate.toLocaleDateString('pt-BR', {
                    weekday: 'short',
                    day: '2-digit',
                    month: 'short',
                  })}
                </button>
                {isHistoryCalendarOpen && (
                  <div className="history-calendar-popover">
                    <Suspense fallback={null}>
                      <LazyDatePicker
                        selected={historyDate}
                        onChange={(date: Date | null) => {
                          if (date) {
                            setHistoryDate(date);
                            setIsHistoryCalendarOpen(false);
                          }
                        }}
                        inline
                      />
                    </Suspense>
                  </div>
                )}
              </div>

              <button
                className="date-nav-btn"
                onClick={() => shiftHistoryDate(1)}
                disabled={isTodayOrFuture(historyDate)}
                title="Próximo dia"
              >
                <MdChevronRight size={20} />
              </button>
            </div>

            <div className="history-summary">
              <div className="summary-item">
                <span className="summary-label">Entregas</span>
                <span className="summary-value">{selectedOrders.length}</span>
              </div>
              <div className="summary-divider" />
              <div className="summary-item">
                <span className="summary-label">Total do dia</span>
                <span className="summary-value highlight">
                  {totalPedidos.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}
                </span>
              </div>
            </div>
          </div>

          <div className="history-section-heading">
            <div>
              <strong>Entregas do dia</strong>
              <span>Ordenadas pelo horário de saída</span>
            </div>
            <span>{sortedSelectedOrders.length} {sortedSelectedOrders.length === 1 ? "registro" : "registros"}</span>
          </div>

          {sortedSelectedOrders.length > 0 ? (
            <div className="order-history-list">
              {sortedSelectedOrders.map((order, i) => (
                <div key={order.id} className="order-history-row">
                  <div className="order-history-index">{i + 1}</div>
                  <div className="order-history-main">
                    <span className="order-history-name">
                      {formatName(order.nome_destinatario)}
                    </span>
                    <span className="order-history-id">#{order.id}</span>
                  </div>
                  <div className="order-history-time">
                    {order.data_saida?.split(' às ')[1] || "—"}
                  </div>
                  <div className="order-history-value">
                    {formatCurrencySafe(order.valor_taxa)}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="order-history-empty">
              <InboxFill size={32} />
              <p>Nenhum pedido registrado nesta data.</p>
            </div>
          )}

          <div className="options-orders-modal">
            <div className="history-extra-copy">
              <strong>Lançamento avulso</strong>
              <span>Inclua pedágios, retornos ou outros custos.</span>
            </div>
            <AddOrderButtom motoboyId={motoboySelected?.id} att={reloadOrders} />
          </div>
        </div>
      </ModalBase>

      <ModalBase
        isOpen={motoboyEmEdicao !== null}
        // Os dois modais escutam Esc no document, então sem esta guarda um Esc
        // dentro do editor de avatar fechava o cadastro junto. Backdrop e X
        // daqui ficam cobertos pelo editor, então Esc é o único caminho.
        onClose={() => {
          if (!editorAvatarAberto) setMotoboyEmEdicao(null);
        }}
        title="Editar motoboy"
      >
        <div className="motoboy-editar">
          <div className="motoboy-editar-avatar">
            <div className="motoboy-editar-avatar-alvo">
              <img src={urlAvatarMotoboy(previewAvatar, 112)} alt="" width={112} height={112} />
              <button
                type="button"
                className="motoboy-editar-avatar-badge"
                onClick={() => setEditorAvatarAberto(true)}
                aria-label="Montar avatar"
                title="Montar avatar"
              >
                <MdEditNote size={18} />
              </button>
            </div>
            <span className="motoboy-editar-avatar-dica">Clique no lápis para montar o avatar</span>
          </div>

          <div className="form-group">
            <label htmlFor="motoboy-editar-nome">Nome</label>
            <input
              id="motoboy-editar-nome"
              type="text"
              value={edicaoNome}
              placeholder="Ex: João Silva"
              onChange={(e) => setEdicaoNome(e.target.value)}
            />
          </div>

          <div className="form-group">
            <label htmlFor="motoboy-editar-zap">WhatsApp <span className="label-optional">(opcional)</span></label>
            <div
              className={`campo-zap${edicaoTelefone && !zapCompleto ? " tem-erro" : ""}${
                zapCompleto ? " esta-ok" : ""
              }`}
            >
              <MdWhatsapp className="campo-zap-icone" size={17} aria-hidden="true" />
              {/* O +55 é gravado sempre, mas ficava escondido: quem digita só vê
                  DDD + número. Mostrar aqui evita a dúvida de "preciso pôr 55?" */}
              <span className="campo-zap-ddi">+55</span>
              <input
                id="motoboy-editar-zap"
                type="tel"
                inputMode="numeric"
                autoComplete="tel-national"
                value={edicaoTelefone}
                placeholder="(98) 99123-4567"
                onChange={(e) => setEdicaoTelefone(formatarTelefoneVisivel(e.target.value))}
              />
              {zapCompleto && <MdCheck className="campo-zap-ok" size={16} aria-hidden="true" />}
            </div>
            {/* Espaço reservado: sem isto a linha de erro empurrava o modal
                inteiro a cada dígito digitado. */}
            <small className="campo-zap-aviso">
              {edicaoTelefone && !zapCompleto ? "Falta número — informe DDD e os 8 ou 9 dígitos." : ""}
            </small>
          </div>

          <div className="modal-buttons">
            <button
              className="primary"
              style={{ width: "100%" }}
              disabled={salvandoEdicao || !edicaoNome.trim() || (!!edicaoTelefone && !zapCompleto)}
              onClick={salvarEdicaoCadastro}
            >
              {salvandoEdicao ? "Salvando..." : "Salvar alterações"}
            </button>
          </div>
        </div>
      </ModalBase>

      {/* Editor do avatar. Vem DEPOIS do modal de cadastro no JSX de propósito:
          os dois usam o mesmo z-index, então quem é renderizado por último
          fica por cima. Fechar aqui volta pro cadastro com o desenho novo —
          nada é gravado antes do "Salvar alterações" de lá. */}
      <ModalBase
        isOpen={motoboyEmEdicao !== null && editorAvatarAberto}
        onClose={() => setEditorAvatarAberto(false)}
        title="Montar avatar"
      >
        <div className="avatar-editor">
          {/* Gruda no topo da rolagem: a graça é ver o desenho mudando
              enquanto se mexe nos traços lá embaixo. */}
          <div className="avatar-editor-palco">
            <img src={urlAvatarMotoboy(previewAvatar, 128)} alt="" width={128} height={128} />
            <div className="avatar-editor-palco-acoes">
              <button
                type="button"
                className="motoboy-editar-sortear"
                onClick={() => {
                  setEdicaoSeed(sortearSementeAvatar());
                  setEdicaoOpcoes(sortearTracos());
                  setEdicaoFundo(FUNDOS[Math.floor(Math.random() * FUNDOS.length)]);
                }}
              >
                Sortear tudo
              </button>
              <button
                type="button"
                className="motoboy-editar-sortear"
                onClick={() => {
                  setEdicaoOpcoes({});
                  setEdicaoFundo("");
                }}
                disabled={!Object.keys(edicaoOpcoes).length && !edicaoFundo}
              >
                Limpar
              </button>
            </div>
          </div>

          <div className="form-group">
            <label>Fundo</label>
            <div className="motoboy-editar-fundos">
              {FUNDOS.map((cor) => (
                <button
                  key={cor}
                  type="button"
                  className={`motoboy-editar-fundo${edicaoFundo === cor ? " is-active" : ""}`}
                  style={{ background: `#${cor}` }}
                  onClick={() => setEdicaoFundo(cor)}
                  aria-label={`Fundo #${cor}`}
                  aria-pressed={edicaoFundo === cor}
                />
              ))}
            </div>
          </div>

          <div className="form-group">
            <label>Traços</label>
            <div className="motoboy-editar-tracos">
              {TRACOS.map((traco) =>
                traco.cor ? (
                  <div key={traco.chave} className="motoboy-traco motoboy-traco--cor">
                    <span className="motoboy-traco-nome">{traco.rotulo}</span>
                    <div className="motoboy-traco-cores">
                      {traco.valores.map((cor) => (
                        <button
                          key={cor}
                          type="button"
                          className={`motoboy-traco-cor${edicaoOpcoes[traco.chave] === cor ? " is-active" : ""}`}
                          style={{ background: `#${cor}` }}
                          onClick={() => escolherTraco(traco.chave, cor)}
                          aria-label={`${traco.rotulo}: #${cor}`}
                          aria-pressed={edicaoOpcoes[traco.chave] === cor}
                        />
                      ))}
                    </div>
                  </div>
                ) : (
                  <div key={traco.chave} className="motoboy-traco">
                    <span className="motoboy-traco-nome">{traco.rotulo}</span>
                    <div className="motoboy-traco-girar">
                      <button
                        type="button"
                        onClick={() => girarTraco(traco, -1)}
                        aria-label={`${traco.rotulo}: anterior`}
                      >
                        <MdChevronLeft size={18} />
                      </button>
                      <span className="motoboy-traco-valor">{rotuloDoTraco(traco, edicaoOpcoes[traco.chave])}</span>
                      <button
                        type="button"
                        onClick={() => girarTraco(traco, 1)}
                        aria-label={`${traco.rotulo}: próximo`}
                      >
                        <MdChevronRight size={18} />
                      </button>
                    </div>
                  </div>
                )
              )}
            </div>
          </div>

          <div className="modal-buttons">
            <button
              className="primary"
              style={{ width: "100%" }}
              onClick={() => setEditorAvatarAberto(false)}
            >
              Pronto
            </button>
          </div>
        </div>
      </ModalBase>

      <ModalBase
        isOpen={isNewMotoboyModalOpen}
        onClose={() => setIsNewMotoboyModalOpen(false)}
        title="Novo motoboy"
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          <div className="form-group">
            <label>Nome do motoboy</label>
            <input
              type="text"
              value={newName}
              placeholder="Ex: João Silva"
              onChange={(e) => setNewName(e.target.value)}
            />
          </div>

          <div className="switch-wrapper" style={{ marginTop: '8px' }}>
            <label className="switch">
              <input
                type="checkbox"
                checked={isFixed}
                onChange={(e) => setIsFixed(e.target.checked)}
              />
              <div className="slider"></div>
              <span className="slider-label">Tornar motoboy fixo da casa</span>
            </label>
          </div>

          <div className="modal-buttons" style={{ marginTop: '12px' }}>
            <button className="primary" style={{ width: '100%' }} onClick={addMotoboy}>
              Adicionar à equipe
            </button>
          </div>
        </div>
      </ModalBase>
    </div>
  );
};

export default MotoboyDashboard;

function getDateTimeString(): string {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = String(now.getFullYear()).slice(-2);
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}

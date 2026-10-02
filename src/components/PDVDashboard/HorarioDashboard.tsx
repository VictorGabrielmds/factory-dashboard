// src/components/PDVDashboard/HorarioDashboard.tsx
import { useEffect, useState } from "react";
import "./HorarioDashboard.css";
import { db, doc, getDoc, setDoc } from "../../services/firebase";
import { useToast } from "../../contexts/ToastContext";
import { MdOutlineAccessTime, MdOutlineContentCopy, MdAdd, MdDeleteOutline } from "react-icons/md";
import {
  DIAS_SEMANA,
  DIA_LABEL,
  DIAS_ANTECEDENCIA_PADRAO,
  INTERVALO_MINUTOS_PADRAO,
  OPCOES_INTERVALO_MINUTOS,
  horarioFuncionamentoPadrao,
  turnoPadrao,
  clonarDiaHorario,
  type DiaSemana,
  type Turno,
  type DiaHorario,
  type HorarioFuncionamento,
} from "../../types/Horario";

// Normaliza o que vem do Firestore: aceita o doc no formato novo (turnos:
// Turno[]) e não quebra se algum dia individual estiver ausente — nunca lê
// o formato antigo (abre/fecha direto no dia, de antes dos turnos) como
// turno válido, só ignora.
function normalizarDia(bruto: unknown): DiaHorario {
  const dados = (bruto ?? {}) as Partial<DiaHorario>;
  const turnos = Array.isArray(dados.turnos)
    ? dados.turnos
        .filter((t): t is Turno => !!t && typeof t.abre === "string" && typeof t.fecha === "string")
        .map((t) => ({
          id: t.id || turnoPadrao().id,
          abre: t.abre,
          fecha: t.fecha,
          deliveryAtivo: t.deliveryAtivo ?? true,
          retiradaAtivo: t.retiradaAtivo ?? true,
        }))
    : [];
  return { ativo: dados.ativo ?? false, turnos };
}

export default function HorarioDashboard() {
  const { addToast } = useToast();
  const [horario, setHorario] = useState<HorarioFuncionamento>(horarioFuncionamentoPadrao());
  const [diasAntecedencia, setDiasAntecedencia] = useState(DIAS_ANTECEDENCIA_PADRAO);
  const [intervaloMinutos, setIntervaloMinutos] = useState(INTERVALO_MINUTOS_PADRAO);
  const [carregando, setCarregando] = useState(true);
  const [salvando, setSalvando] = useState(false);
  const [copiarOrigem, setCopiarOrigem] = useState<Record<DiaSemana, DiaSemana | "">>(
    () => DIAS_SEMANA.reduce((acc, dia) => ({ ...acc, [dia]: "" }), {} as Record<DiaSemana, DiaSemana | "">)
  );

  useEffect(() => {
    getDoc(doc(db, "configuracoes", "horario"))
      .then((snap) => {
        const dados = snap.data() as Record<string, unknown> | undefined;
        if (!dados) return;

        if (typeof dados.diasAntecedencia === "number") setDiasAntecedencia(dados.diasAntecedencia);
        if (typeof dados.intervaloMinutos === "number") setIntervaloMinutos(dados.intervaloMinutos);

        // Compatível com o formato anterior (dias direto na raiz do doc, sem
        // diasAntecedencia/intervaloMinutos) — se não existir "dias", usa o
        // próprio doc como mapa de dias.
        const diasSalvos = (
          dados.dias && typeof dados.dias === "object" ? dados.dias : dados
        ) as Record<string, unknown>;

        setHorario((atual) => {
          const completo = { ...atual };
          for (const dia of DIAS_SEMANA) {
            if (diasSalvos[dia]) completo[dia] = normalizarDia(diasSalvos[dia]);
          }
          return completo;
        });
      })
      .catch((err) => {
        console.error("Erro ao carregar horário de funcionamento:", err);
        addToast("Erro ao carregar horário de funcionamento.", "error");
      })
      .finally(() => setCarregando(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- carrega uma única vez
  }, []);

  const salvar = async () => {
    setSalvando(true);
    try {
      await setDoc(doc(db, "configuracoes", "horario"), { diasAntecedencia, intervaloMinutos, dias: horario });
      addToast("Horário de funcionamento salvo!", "success");
    } catch (err) {
      console.error("Erro ao salvar horário de funcionamento:", err);
      addToast("Erro ao salvar horário de funcionamento.", "error");
    } finally {
      setSalvando(false);
    }
  };

  const toggleDiaAtivo = (dia: DiaSemana, ativo: boolean) => {
    setHorario((atual) => ({ ...atual, [dia]: { ...atual[dia], ativo } }));
  };

  const adicionarTurno = (dia: DiaSemana) => {
    setHorario((atual) => ({
      ...atual,
      [dia]: { ...atual[dia], ativo: true, turnos: [...atual[dia].turnos, turnoPadrao()] },
    }));
  };

  const removerTurno = (dia: DiaSemana, turnoId: string) => {
    setHorario((atual) => ({
      ...atual,
      [dia]: { ...atual[dia], turnos: atual[dia].turnos.filter((t) => t.id !== turnoId) },
    }));
  };

  const atualizarTurno = (dia: DiaSemana, turnoId: string, campo: keyof Turno, valor: string | boolean) => {
    setHorario((atual) => ({
      ...atual,
      [dia]: {
        ...atual[dia],
        turnos: atual[dia].turnos.map((t) => (t.id === turnoId ? { ...t, [campo]: valor } : t)),
      },
    }));
  };

  const copiarDeOutroDia = (diaDestino: DiaSemana) => {
    const origem = copiarOrigem[diaDestino];
    if (!origem) return;
    setHorario((atual) => ({ ...atual, [diaDestino]: clonarDiaHorario(atual[origem]) }));
    addToast(`Horário de ${DIA_LABEL[origem]} copiado pra ${DIA_LABEL[diaDestino]}.`, "success");
  };

  if (carregando) {
    return (
      <div className="dashboard-loading">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="horario-container fade-in">
      <div className="pdv-page-header">
        <div>
          <h1>Horário de funcionamento</h1>
          <p>
            Cada dia pode ter vários turnos (ex.: almoço e jantar) — cada um liga delivery e retirada
            de forma independente.
          </p>
        </div>
        <button className="btn btn-primary" onClick={salvar} disabled={salvando}>
          {salvando ? "Salvando..." : "Salvar horário"}
        </button>
      </div>

      <div className="horario-globais">
        <div className="horario-globais-campo">
          <label htmlFor="dias-antecedencia">Agendamento com até</label>
          <div className="input-with-suffix">
            <input
              id="dias-antecedencia"
              type="number"
              min="0"
              max="30"
              value={diasAntecedencia}
              onChange={(e) => setDiasAntecedencia(Math.max(0, Number(e.target.value) || 0))}
            />
            <span className="input-suffix">{diasAntecedencia === 1 ? "dia" : "dias"} à frente</span>
          </div>
          <p>0 = só permite agendar pra hoje.</p>
        </div>

        <div className="horario-globais-campo">
          <label htmlFor="intervalo-minutos">Intervalo entre horários</label>
          <select
            id="intervalo-minutos"
            value={intervaloMinutos}
            onChange={(e) => setIntervaloMinutos(Number(e.target.value))}
          >
            {OPCOES_INTERVALO_MINUTOS.map((min) => (
              <option key={min} value={min}>
                a cada {min} min
              </option>
            ))}
          </select>
          <p>Ex.: 30 min mostra 9:00, 9:30, 10:00... — 20 min mostra 9:00, 9:20, 9:40...</p>
        </div>
      </div>

      <div className="horario-lista">
        {DIAS_SEMANA.map((dia) => {
          const config = horario[dia];
          const outrosDias = DIAS_SEMANA.filter((d) => d !== dia);

          return (
            <div key={dia} className={`horario-dia${config.ativo ? "" : " indisponivel"}`}>
              <div className="horario-dia-topo">
                <label className="produto-toggle">
                  <input
                    type="checkbox"
                    checked={config.ativo}
                    onChange={(e) => toggleDiaAtivo(dia, e.target.checked)}
                  />
                  <span>{DIA_LABEL[dia]}</span>
                </label>

                <div className="horario-copiar">
                  <MdOutlineContentCopy aria-hidden="true" />
                  <select
                    aria-label={`Copiar horário de outro dia pra ${DIA_LABEL[dia]}`}
                    value={copiarOrigem[dia]}
                    onChange={(e) =>
                      setCopiarOrigem((atual) => ({ ...atual, [dia]: e.target.value as DiaSemana | "" }))
                    }
                  >
                    <option value="">Copiar de...</option>
                    {outrosDias.map((d) => (
                      <option key={d} value={d}>
                        {DIA_LABEL[d]}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="btn-icon-action"
                    title="Copiar horário do dia selecionado"
                    disabled={!copiarOrigem[dia]}
                    onClick={() => copiarDeOutroDia(dia)}
                  >
                    Copiar
                  </button>
                </div>
              </div>

              {config.ativo && (
                <div className="horario-dia-campos">
                  {config.turnos.length === 0 && (
                    <p className="horario-sem-turnos">Nenhum turno ainda — adicione um horário abaixo.</p>
                  )}

                  {config.turnos.map((turno) => (
                    <div key={turno.id} className="horario-turno">
                      <div className="horario-horas">
                        <MdOutlineAccessTime aria-hidden="true" />
                        <input
                          type="time"
                          value={turno.abre}
                          onChange={(e) => atualizarTurno(dia, turno.id, "abre", e.target.value)}
                          aria-label={`Abre (${DIA_LABEL[dia]})`}
                        />
                        <span>até</span>
                        <input
                          type="time"
                          value={turno.fecha}
                          onChange={(e) => atualizarTurno(dia, turno.id, "fecha", e.target.value)}
                          aria-label={`Fecha (${DIA_LABEL[dia]})`}
                        />
                      </div>

                      <div className="horario-tipos">
                        <label className="produto-toggle">
                          <input
                            type="checkbox"
                            checked={turno.deliveryAtivo}
                            onChange={(e) => atualizarTurno(dia, turno.id, "deliveryAtivo", e.target.checked)}
                          />
                          <span>Delivery</span>
                        </label>
                        <label className="produto-toggle">
                          <input
                            type="checkbox"
                            checked={turno.retiradaAtivo}
                            onChange={(e) => atualizarTurno(dia, turno.id, "retiradaAtivo", e.target.checked)}
                          />
                          <span>Retirada</span>
                        </label>
                      </div>

                      <button
                        type="button"
                        className="btn-icon-action btn-trash"
                        title="Remover turno"
                        onClick={() => removerTurno(dia, turno.id)}
                      >
                        <MdDeleteOutline size={16} />
                      </button>
                    </div>
                  ))}

                  <button type="button" className="horario-add-turno" onClick={() => adicionarTurno(dia)}>
                    <MdAdd size={16} aria-hidden="true" /> Adicionar turno
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

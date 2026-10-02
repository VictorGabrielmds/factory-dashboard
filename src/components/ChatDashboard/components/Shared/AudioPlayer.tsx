// src/components/ChatDashboard/components/Shared/AudioPlayer.tsx
import { useEffect, useRef, useState } from "react";
import { MdPlayArrow, MdPause } from "react-icons/md";

function formatarTempo(segundos: number): string {
  if (!Number.isFinite(segundos) || segundos < 0) return "0:00";
  const min = Math.floor(segundos / 60);
  const seg = Math.floor(segundos % 60);
  return `${min}:${seg.toString().padStart(2, "0")}`;
}

interface AudioPlayerProps {
  src: string;
  onMetadataLoaded?: () => void;
}

// Player customizado no lugar do <audio controls> nativo do navegador — a tag
// <audio> continua sendo a fonte real dos dados (eventos de tempo/duração),
// só que escondida; toda a UI visível (play/pause, barra, tempo) é nossa.
export default function AudioPlayer({ src, onMetadataLoaded }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [tocando, setTocando] = useState(false);
  const [duracao, setDuracao] = useState(0);
  const [posicao, setPosicao] = useState(0);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const aoCarregarMetadados = () => {
      setDuracao(Number.isFinite(audio.duration) ? audio.duration : 0);
      onMetadataLoaded?.();
    };
    const aoAtualizarTempo = () => setPosicao(audio.currentTime);
    const aoTerminar = () => {
      setTocando(false);
      setPosicao(0);
    };

    audio.addEventListener("loadedmetadata", aoCarregarMetadados);
    audio.addEventListener("timeupdate", aoAtualizarTempo);
    audio.addEventListener("ended", aoTerminar);
    return () => {
      audio.removeEventListener("loadedmetadata", aoCarregarMetadados);
      audio.removeEventListener("timeupdate", aoAtualizarTempo);
      audio.removeEventListener("ended", aoTerminar);
    };
  }, [onMetadataLoaded]);

  const alternarPlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (tocando) {
      audio.pause();
      setTocando(false);
    } else {
      void audio.play();
      setTocando(true);
    }
  };

  const buscarPosicao = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    const novaPosicao = Number(e.target.value);
    audio.currentTime = novaPosicao;
    setPosicao(novaPosicao);
  };

  const progresso = duracao > 0 ? (posicao / duracao) * 100 : 0;
  const tempoExibido = posicao > 0 ? posicao : duracao;

  return (
    <div className="audio-player">
      <audio ref={audioRef} src={src} preload="metadata" style={{ display: "none" }} />
      <button
        type="button"
        className="audio-player-toggle"
        onClick={alternarPlayback}
        aria-label={tocando ? "Pausar áudio" : "Tocar áudio"}
      >
        {tocando ? <MdPause size={20} /> : <MdPlayArrow size={20} />}
      </button>
      <div className="audio-player-track">
        <input
          type="range"
          className="audio-player-seek"
          min={0}
          max={duracao || 0}
          step={0.01}
          value={posicao}
          onChange={buscarPosicao}
          style={{ backgroundSize: `${progresso}% 100%` }}
        />
        <span className="audio-player-time">{formatarTempo(tempoExibido)}</span>
      </div>
    </div>
  );
}

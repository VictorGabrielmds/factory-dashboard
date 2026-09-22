// src/hooks/useAudioRecorder.ts
import { useState, useRef } from "react";

export function useAudioRecorder(onAudioReady: (audioBlob: Blob, mimeType: string, extension: string) => Promise<void>) {
  const [isRecording, setIsRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const iniciarGravacaoAudio = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimePreferido = MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")
        ? "audio/ogg;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
        
      const recorder = new MediaRecorder(stream, { mimeType: mimePreferido });
      recordChunksRef.current = [];
      
      recorder.ondataavailable = (ev) => { 
        if (ev.data.size > 0) recordChunksRef.current.push(ev.data); 
      };
      
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        if (recordTimerRef.current) { clearInterval(recordTimerRef.current); recordTimerRef.current = null; }
        
        setIsRecording(false); 
        setRecordSeconds(0);
        
        const blobMime = recorder.mimeType || mimePreferido;
        const blob = new Blob(recordChunksRef.current, { type: blobMime });
        if (blob.size === 0) return;
        
        const ext = blobMime.startsWith("audio/ogg") ? "audio.ogg" : "audio.webm";
        await onAudioReady(blob, blobMime, ext);
      };
      
      mediaRecorderRef.current = recorder;
      recorder.start();
      setIsRecording(true); 
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(() => setRecordSeconds(s => s + 1), 1000);
      
    } catch (erro) {
      console.error("Erro ao acessar microfone:", erro);
      alert("Não foi possível acessar o microfone.");
    }
  };

  const pararGravacaoAudio = () => {
    mediaRecorderRef.current?.stop();
  };

  const cancelarGravacaoAudio = () => {
    if (mediaRecorderRef.current) {
      recordChunksRef.current = [];
      mediaRecorderRef.current.onstop = () => {
        mediaRecorderRef.current?.stream?.getTracks?.().forEach(t => t.stop());
      };
      mediaRecorderRef.current.stop();
    }
    if (recordTimerRef.current) { 
      clearInterval(recordTimerRef.current); 
      recordTimerRef.current = null; 
    }
    setIsRecording(false); 
    setRecordSeconds(0);
  };

  return {
    isRecording,
    recordSeconds,
    iniciarGravacaoAudio,
    pararGravacaoAudio,
    cancelarGravacaoAudio
  };
}
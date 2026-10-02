import React, { useState, useEffect, useRef } from 'react';
import './ElasticChristmasBall.css';

export const ElasticChristmasBall = () => {
  // Posição visual (X, Y)
  const [position, setPosition] = useState({ x: 0, y: 60 });
  const [isDragging, setIsDragging] = useState(false);

  // Variáveis para a física (não precisam causar re-render, então usamos useRef)
  const velocity = useRef({ x: 0, y: 0 }); // Velocidade atual
  const animationFrameId = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    // Zera a velocidade quando pega a bola
    velocity.current = { x: 0, y: 0 };
    cancelAnimationFrame(animationFrameId.current);
  };

  // 1. Lógica de ARRASTAR (Segue o mouse)
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      // Ponto de ancoragem (o prego)
      const anchorX = rect.left + rect.width / 2;
      const anchorY = rect.top;

      setPosition({
        x: e.clientX - anchorX,
        y: e.clientY - anchorY
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  // 2. Lógica de SOLTAR (Física de Mola)
useEffect(() => {
    if (!isDragging) {
      const loop = () => {
        // --- AJUSTES DE SUAVIDADE AQUI ---
        
        // TENSION: Quanto menor, mais lenta e suave é a volta.
        // Tente 0.01 ou 0.02 (Antes estava 0.05)
        const tension = 0.015; 

        // FRICTION: Quanto mais perto de 1.0, mais "deslizante" é o movimento.
        // Se for baixo (ex: 0.80), ela para bruscamente. 
        // Se for alto (ex: 0.95), ela balança suavemente até parar.
        const friction = 0.99; 

        const target = { x: 0, y: 60 }; // Posição de descanso

        // 1. Calcula a força
        const forceX = (target.x - position.x) * tension;
        const forceY = (target.y - position.y) * tension;

        // 2. Aplica na velocidade
        velocity.current.x += forceX;
        velocity.current.y += forceY;

        // 3. Aplica fricção
        velocity.current.x *= friction;
        velocity.current.y *= friction;

        // 4. Nova Posição
        const newX = position.x + velocity.current.x;
        const newY = position.y + velocity.current.y;

        // Verifica se parou (aumentei a precisão pra não "cortar" o movimento suave no final)
        const isStopped = Math.abs(velocity.current.x) < 0.01 && 
                          Math.abs(velocity.current.y) < 0.01 && 
                          Math.abs(newX - target.x) < 0.1 && 
                          Math.abs(newY - target.y) < 0.1;

        if (isStopped) {
            setPosition(target);
        } else {
            setPosition({ x: newX, y: newY });
            animationFrameId.current = requestAnimationFrame(loop);
        }
      };
      
      loop();
    }
    return () => cancelAnimationFrame(animationFrameId.current);
   
  }, [isDragging, position.x, position.y]);

  return (
    <div ref={containerRef} className="elastic-container">
      <svg width="100" height="100" style={{ overflow: 'visible' }}>
        {/* FIO: Agora usa a mesma "position" da bola, então nunca desgruda */}
        <line 
          x1="50" y1="0" 
          x2={50 + position.x} y2={position.y} 
          stroke="#C0C0C0" strokeWidth="2"
        />

        {/* BOLA: Usa transform baseado na mesma "position" */}
        <g 
          transform={`translate(${50 + position.x}, ${position.y})`}
          className={isDragging ? "ball-group dragging" : "ball-group"}
        >
          <path d="M-0 -20 H5 L3 -15 H-3 L-5 -20Z" fill="#D4AF37" />
          <circle cx="0" cy="0" r="15" fill="#D32F2F" cursor={isDragging ? 'grabbing' : 'grab'} onMouseDown={handleMouseDown} />
          <circle cx="-8" cy="-8" r="5" fill="rgba(255,255,255,0.3)" pointerEvents="none" />
        </g>
      </svg>
    </div>
  );
};
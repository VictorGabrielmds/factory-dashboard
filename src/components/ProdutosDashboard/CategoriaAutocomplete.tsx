import { useEffect, useRef, useState } from "react";

interface CategoriaAutocompleteProps {
  value: string;
  categorias: string[];
  onChange: (valor: string) => void;
}

export default function CategoriaAutocomplete({ value, categorias, onChange }: CategoriaAutocompleteProps) {
  const [aberto, setAberto] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickFora(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setAberto(false);
      }
    }
    document.addEventListener("mousedown", handleClickFora);
    return () => document.removeEventListener("mousedown", handleClickFora);
  }, []);

  const termo = value.trim().toLowerCase();
  const sugestoes = categorias.filter((c) => c.toLowerCase().includes(termo));
  const ehCategoriaNova = termo.length > 0 && !categorias.some((c) => c.toLowerCase() === termo);

  return (
    <div className="categoria-autocomplete" ref={containerRef}>
      <input
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setAberto(true);
        }}
        onFocus={() => setAberto(true)}
        placeholder="Ex: Salgados"
        autoComplete="off"
        required
      />
      {aberto && (sugestoes.length > 0 || ehCategoriaNova) && (
        <ul className="categoria-dropdown">
          {sugestoes.map((c) => (
            // onMouseDown (não onClick) dispara antes do input perder o foco —
            // com onClick, o onBlur do input fecharia a lista antes do clique registrar.
            <li key={c} onMouseDown={() => { onChange(c); setAberto(false); }}>
              {c}
            </li>
          ))}
          {ehCategoriaNova && (
            <li className="categoria-dropdown-nova" onMouseDown={() => setAberto(false)}>
              Nova categoria: <strong>“{value.trim()}”</strong>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

#!/usr/bin/env node
/**
 * geocode-bairros.mjs
 * ------------------------------------------------------------------
 * Geocodifica os bairros de bairrosRaw.json (lat/lng) usando o
 * Nominatim (OpenStreetMap, gratuito) e, opcionalmente, o Google
 * Geocoding API como fallback pros bairros que o Nominatim não achar
 * (comum em nomes informais tipo "ALAMEDA DOS SONHOS").
 *
 * REQUISITOS:
 *   - Node.js 18+ (usa fetch nativo)
 *   - Rodar de uma máquina com internet livre (não funciona em sandboxes
 *     restritos, como o ambiente que gerou este script)
 *
 * COMO RODAR:
 *   node geocode-bairros.mjs ./bairrosRaw.json
 *
 *   # Com fallback no Google pros que o Nominatim não encontrar:
 *   GOOGLE_MAPS_API_KEY=<chave-com-restricao-adequada> node geocode-bairros.mjs ./bairrosRaw.json
 *
 * SAÍDA:
 *   - bairrosGeo.json          → todos os bairros, com lat/lng quando encontrado
 *   - bairrosGeo.pendentes.json → lista dos que ficaram sem coordenada (pra revisão manual)
 *   - .geocode-cache.json       → cache incremental (permite retomar se cair a conexão)
 *
 * ATENÇÃO — Política de uso do Nominatim:
 *   Máx. 1 requisição/segundo, com um User-Agent identificável.
 *   Ajuste CONTACT_INFO abaixo antes de rodar.
 * ------------------------------------------------------------------
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

// ── CONFIGURAÇÃO ────────────────────────────────────────────────
const CITY_CONTEXT = "São Luís, Maranhão, Brasil";
const CONTACT_INFO = "roteirizador-interno (contato: fabricadossalgadosma@gmail.com)"; // 🔧 AJUSTE AQUI
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const RATE_LIMIT_MS = 1100; // Nominatim exige >= 1s entre requisições
const CACHE_FILE = ".geocode-cache.json";
const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY?.trim() || "";

const inputPath = process.argv[2] || "./bairrosRaw.json";

// ── UTILITÁRIOS ──────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stripAccents = (s) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

function loadCache() {
  if (!existsSync(CACHE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ── GEOCODIFICAÇÃO — NOMINATIM ──────────────────────────────────
async function geocodeNominatim(query) {
  const url = `${NOMINATIM_URL}?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=br`;
  const res = await fetch(url, {
    headers: { "User-Agent": CONTACT_INFO },
  });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const data = await res.json();
  if (!data || data.length === 0) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), source: "nominatim" };
}

// ── GEOCODIFICAÇÃO — GOOGLE (fallback opcional) ─────────────────
async function geocodeGoogle(query) {
  if (!GOOGLE_API_KEY) return null;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${GOOGLE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google HTTP ${res.status}`);
  const data = await res.json();
  if (data.status !== "OK" || !data.results?.[0]) return null;
  const loc = data.results[0].geometry.location;
  return { lat: loc.lat, lng: loc.lng, source: "google" };
}

// ── TENTA VÁRIAS VARIANTES DE QUERY ATÉ ACHAR ───────────────────
async function geocodeBairro(bairro, cache) {
  if (cache[bairro.id]) return cache[bairro.id]; // já resolvido antes

  const variants = [
    `${bairro.nome}, ${CITY_CONTEXT}`,
    `Bairro ${bairro.nome}, ${CITY_CONTEXT}`,
    `${stripAccents(bairro.nome)}, ${CITY_CONTEXT}`,
  ];

  for (const query of variants) {
    try {
      const result = await geocodeNominatim(query);
      await sleep(RATE_LIMIT_MS);
      if (result) return result;
    } catch (err) {
      console.warn(`  ⚠ erro Nominatim em "${query}": ${err.message}`);
      await sleep(RATE_LIMIT_MS);
    }
  }

  // Fallback no Google, se configurado
  if (GOOGLE_API_KEY) {
    try {
      const result = await geocodeGoogle(`${bairro.nome}, ${CITY_CONTEXT}`);
      if (result) return result;
    } catch (err) {
      console.warn(`  ⚠ erro Google em "${bairro.nome}": ${err.message}`);
    }
  }

  return null;
}

// ── MAIN ─────────────────────────────────────────────────────────
async function main() {
  const bairros = JSON.parse(readFileSync(inputPath, "utf-8"));
  const cache = loadCache();

  console.log(`Geocodificando ${bairros.length} bairros (${CITY_CONTEXT})...`);
  if (GOOGLE_API_KEY) console.log("Fallback Google ativado.");
  console.log("");

  const enriched = [];
  const pendentes = [];

  for (let i = 0; i < bairros.length; i++) {
    const bairro = bairros[i];
    process.stdout.write(`[${i + 1}/${bairros.length}] ${bairro.nome}... `);

    const geo = await geocodeBairro(bairro, cache);

    if (geo) {
      cache[bairro.id] = geo;
      saveCache(cache); // salva a cada passo — se cair a conexão, retoma de onde parou
      enriched.push({ ...bairro, lat: geo.lat, lng: geo.lng, geoSource: geo.source });
      console.log(`✓ (${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}) via ${geo.source}`);
    } else {
      enriched.push({ ...bairro, lat: null, lng: null, geoSource: null });
      pendentes.push(bairro);
      console.log("✗ não encontrado");
    }
  }

  writeFileSync("bairrosGeo.json", JSON.stringify(enriched, null, 2));
  writeFileSync("bairrosGeo.pendentes.json", JSON.stringify(pendentes, null, 2));

  console.log("");
  console.log(`Concluído: ${enriched.length - pendentes.length}/${bairros.length} geocodificados.`);
  if (pendentes.length > 0) {
    console.log(`${pendentes.length} bairros ficaram sem coordenada — veja bairrosGeo.pendentes.json`);
    console.log("Esses precisam de um pin manual (ou revisão do nome) depois.");
  }
}

main().catch((err) => {
  console.error("Erro fatal:", err);
  process.exit(1);
});

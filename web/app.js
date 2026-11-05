/* Predial — mapa de predios del SII en vivo.
   Cartografía: WMS del SII cargado como imagen (no necesita CORS).
   Ficha del predio: vía el intermediario (Cloudflare Worker), porque la API del SII no admite CORS. */
(() => {
  "use strict";

  const WMS_SII = "https://www4.sii.cl/mapasui/services/ui/wmsProxyService/call";
  const TGR_URL = "https://tgr.gob.cl/tramites-tgr/certificado-de-deuda-de-contribuciones/";
  const PI_URL = "https://www.portalinmobiliario.com/";
  const SII_AVALUOS_URL = "https://www.sii.cl/servicios_online/1048-.html";
  const CHILE = L.latLngBounds([-56.0, -76.2], [-17.4, -66.3]);
  const ZOOM_PREDIOS = 13;   // desde aquí se cargan las teselas del SII
  const ZOOM_CLIC = 15;      // desde aquí un clic consulta un predio
  const MAX_CAPAS = 6;

  const $ = (s) => document.querySelector(s);
  const api = (() => {
    const q = new URLSearchParams(location.search).get("api");
    try { if (q) localStorage.setItem("predial-api", q); } catch {}
    let guardada = "";
    try { guardada = localStorage.getItem("predial-api") || ""; } catch {}
    return (q || window.PREDIAL_API || guardada || "").replace(/\/+$/, "");
  })();

  const clp = new Intl.NumberFormat("es-CL", { style: "currency", currency: "CLP", maximumFractionDigits: 0 });
  const num = new Intl.NumberFormat("es-CL", { maximumFractionDigits: 1 });
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const MENORES = new Set(["de", "del", "la", "las", "los", "el", "y", "e", "en", "a", "con", "por"]);
  const titulo = (s) => String(s || "").toLowerCase().split(" ")
    .map((w, i) => (i && MENORES.has(w) ? w : w.replace(/^\p{L}/u, (m) => m.toUpperCase()))).join(" ");
  const movil = () => matchMedia("(max-width: 760px)").matches;

  const estado = { regiones: [], comunas: [], porCod: new Map(), region: null, comuna: null, rotulos: false, fondo: "noche" };

  // ── Mapa ────────────────────────────────────────────────
  const mapa = L.map("mapa", {
    zoomControl: false, minZoom: 3, maxZoom: 20, zoomSnap: 0.25, zoomDelta: 0.5,
    wheelPxPerZoomLevel: 90, worldCopyJump: false,
  });
  L.control.zoom({ position: "bottomright" }).addTo(mapa);
  mapa.createPane("rotulos").style.zIndex = 460;
  mapa.getPane("rotulos").style.pointerEvents = "none";

  const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
  const fondos = {
    noche: L.tileLayer(ESRI + "Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 20, maxNativeZoom: 16, className: "base-noche", attribution: "Fondo &copy; Esri, HERE, Garmin, &copy; OpenStreetMap",
    }),
    satelite: L.tileLayer(ESRI + "World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      maxZoom: 20, maxNativeZoom: 18, className: "base-sat", attribution: "Imágenes &copy; Esri, Maxar",
    }),
  };
  const rotulosBase = L.tileLayer(ESRI + "Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 20, maxNativeZoom: 16, pane: "rotulos", opacity: 0.8,
  });
  fondos.noche.addTo(mapa);
  rotulosBase.addTo(mapa);
  document.body.classList.add("fondo-noche");
  mapa.attributionControl.setPrefix("Predios: <a href='https://www4.sii.cl/mapasui/' target='_blank' rel='noopener'>SII</a>");

  // Espacio que tapan los paneles: el mapa encuadra en la parte libre.
  const clase = (c) => document.body.classList.contains(c);
  function altoHoja() {
    if (!movil()) return 0;
    // Alto final según el estado de la hoja (no el actual, que puede estar en transición).
    if (clase("hoja-cerrada")) return 184;
    if (clase("hoja-abierta")) return innerHeight * 0.88;
    return innerHeight * 0.46;
  }
  function paddingVista() {
    if (movil()) return { paddingTopLeft: [16, 64], paddingBottomRight: [16, altoHoja() + 16] };
    const izq = clase("panel-oculto") ? 40 : 420;
    const der = clase("con-ficha") && !clase("ficha-min") ? 440 : 60;
    return { paddingTopLeft: [izq, 40], paddingBottomRight: [der, 40] };
  }
  function encuadreInicial(anim) {
    // Chile continental (sin islas): completo y centrado en el espacio libre.
    mapa.fitBounds(L.latLngBounds([-55.9, -75.8], [-17.5, -66.4]), { ...paddingVista(), animate: anim });
  }
  encuadreInicial(false);  // se repite al final, cuando los paneles ya tienen su tamaño

  // ── Lecturas ────────────────────────────────────────────
  const fmtCoord = (v) => v.toFixed(5).replace(".", ",");
  mapa.on("mousemove", (e) => { $("#lat").value = fmtCoord(e.latlng.lat); $("#lon").value = fmtCoord(e.latlng.lng); });
  const actualizarZoom = () => { $("#zoom").value = mapa.getZoom().toFixed(1).replace(".0", ""); };
  mapa.on("zoomend", actualizarZoom); actualizarZoom();

  // ── Contornos comunales ─────────────────────────────────
  const renderer = L.canvas({ padding: 0.3, tolerance: 4 });
  let contornos = null;
  const estiloContorno = (f) => {
    const cod = f.properties.cod;
    const c = estado.porCod.get(cod);
    const enRegion = estado.region && c && c.region === estado.region;
    if (estado.comuna && (cod === estado.comuna.cod || (estado.comuna.cod === 13134 || estado.comuna.cod === 13135) && cod === 13101)) {
      return estado.fondo === "satelite"
        ? { color: "#f4f1e6", weight: 1.4, opacity: 0.75, fillColor: "#000", fillOpacity: 0.0, dashArray: "6 4" }
        : { color: "#c8ff3c", weight: 2.2, opacity: 1, fillColor: "#c8ff3c", fillOpacity: 0.0, dashArray: null };
    }
    if (enRegion) return { color: "#e8e6df", weight: 0.9, opacity: 0.55, fillColor: "#c8ff3c", fillOpacity: 0.035, dashArray: null };
    return { color: "#e8e6df", weight: 0.5, opacity: estado.region ? 0.12 : 0.28, fillOpacity: 0, fillColor: "#000", dashArray: null };
  };

  function prepararContornos(geo) {
    contornos = L.geoJSON(geo, {
      renderer, style: estiloContorno,
      onEachFeature: (f, capa) => {
        const c = estado.porCod.get(f.properties.cod);
        if (!c) return;
        capa.bindTooltip(c.nombre, { className: "etiqueta-comuna", sticky: true, direction: "right", offset: [14, 0], opacity: 1 });
        capa.on("mouseover", () => {
          if (mapa.getZoom() >= ZOOM_PREDIOS) return capa.closeTooltip();
          if (!estado.comuna || estado.comuna.cod !== c.cod) capa.setStyle({ color: "#c8ff3c", opacity: 0.9, weight: 1.4 });
        });
        capa.on("mouseout", () => contornos.resetStyle(capa));
        capa.on("tooltipopen", () => { if (mapa.getZoom() >= ZOOM_PREDIOS) capa.closeTooltip(); });
        capa.on("click", (e) => {
          if (mapa.getZoom() >= ZOOM_PREDIOS) return;  // el clic lo maneja la consulta de predios
          L.DomEvent.stop(e);
          elegirComuna(c);
        });
      },
    }).addTo(mapa);
  }
  const refrescarContornos = () => contornos && contornos.setStyle(estiloContorno);

  // Punto en polígono (ray casting) para saber qué comuna se tocó
  function dentro(pt, anillo) {
    let x = pt[0], y = pt[1], ok = false;
    for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
      const xi = anillo[i][0], yi = anillo[i][1], xj = anillo[j][0], yj = anillo[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ok = !ok;
    }
    return ok;
  }
  function comunasEnPunto(lat, lon, { estricto = false } = {}) {
    const pt = [lon, lat], res = [];
    if (contornos) contornos.eachLayer((capa) => {
      const g = capa.feature.geometry;
      if (!capa.getBounds().contains([lat, lon])) return;
      const polis = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      if (polis.some((p) => dentro(pt, p[0]) && !p.slice(1).some((h) => dentro(pt, h)))) res.push(capa.feature.properties.cod);
    });
    if (estricto) return res.map((c) => estado.porCod.get(c)).filter(Boolean);
    // Santiago: el SII lo divide en Centro, Oeste y Sur sobre el mismo límite comunal
    if (res.includes(13101)) res.push(13134, 13135);
    // Respaldo: comunas cuya extensión contiene el punto (diferencias de límite BCN vs SII)
    estado.comunas.forEach((c) => {
      if (!res.includes(c.cod) && c.bbox && lon >= c.bbox[0] && lon <= c.bbox[2] && lat >= c.bbox[1] && lat <= c.bbox[3]) res.push(c.cod);
    });
    if (estado.comuna) res.sort((a, b) => (b === estado.comuna.cod) - (a === estado.comuna.cod));
    return res.slice(0, 5).map((c) => estado.porCod.get(c)).filter(Boolean);
  }

  // ── Capas de predios del SII ────────────────────────────
  const capasSII = new Map();
  // Se pide cada tesela al SII en 1,5× su tamaño y se muestra a 256 px: las líneas quedan más delgadas.
  // Con los números de rol se pide al tamaño normal para que el texto no se achique.
  const ESCALA_LINEAS = 1.5;
  function capaSII(c) {
    const capa = crearCapaSII(c);
    const px = Math.round(256 * (estado.rotulos ? 1 : ESCALA_LINEAS));
    capa.wmsParams.width = capa.wmsParams.height = px;
    return capa;
  }
  function crearCapaSII(c) {
    return L.tileLayer.wms(WMS_SII, {
      layers: c.layer, styles: estado.rotulos ? "PREDIOS_WMS_V0" : "polygon",
      format: "image/png", transparent: true, version: "1.1.1",
      tileSize: 256, maxZoom: 20, minZoom: ZOOM_PREDIOS - 0.5,
      className: "predios-sii", zIndex: 10, opacity: 0.95, updateWhenIdle: true, keepBuffer: 1,
      bounds: c.bbox ? L.latLngBounds([c.bbox[1], c.bbox[0]], [c.bbox[3], c.bbox[2]]).pad(0.02) : undefined,
    });
  }
  function actualizarCapas() {
    const z = mapa.getZoom();
    if (z < ZOOM_PREDIOS - 0.5) {
      capasSII.forEach((capa) => mapa.removeLayer(capa)); capasSII.clear();
      return;
    }
    const v = mapa.getBounds(), centro = v.getCenter();
    const visibles = estado.comunas
      .filter((c) => c.bbox && v.intersects([[c.bbox[1], c.bbox[0]], [c.bbox[3], c.bbox[2]]]))
      .map((c) => ({ c, d: centro.distanceTo([c.lat, c.lon]) }))
      .sort((a, b) => a.d - b.d).slice(0, MAX_CAPAS).map((x) => x.c);
    const quedan = new Set(visibles.map((c) => c.cod));
    capasSII.forEach((capa, cod) => { if (!quedan.has(cod)) { mapa.removeLayer(capa); capasSII.delete(cod); } });
    visibles.forEach((c) => { if (!capasSII.has(c.cod)) { const capa = capaSII(c).addTo(mapa); capasSII.set(c.cod, capa); } });
  }
  function rehacerCapas() { capasSII.forEach((capa) => mapa.removeLayer(capa)); capasSII.clear(); actualizarCapas(); }

  const aviso = $("#aviso");
  function actualizarAviso() {
    const z = mapa.getZoom();
    let t = "";
    if (estado.comuna && z < ZOOM_PREDIOS - 0.5) t = "Acércate para ver los deslindes de los predios";
    else if (z >= ZOOM_PREDIOS - 0.5 && z < ZOOM_CLIC) t = "Acércate un poco más y toca un predio";
    aviso.textContent = t; aviso.hidden = !t;
  }
  mapa.on("moveend zoomend", () => { actualizarCapas(); actualizarAviso(); });

  // ── Región y comuna ─────────────────────────────────────
  function pintarRegiones() {
    const cont = $("#regiones");
    cont.innerHTML = estado.regiones.map((r) =>
      `<button role="option" aria-selected="false" data-r="${r.id}" title="${esc(r.nombre)}">${esc(r.romano)}<small>${esc(r.nombre)}</small></button>`).join("");
    cont.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      elegirRegion(+b.dataset.r);
    });
  }

  function extensionRegion(id) {
    const cs = estado.comunas.filter((c) => c.region === id && c.bbox);
    // Isla de Pascua y Juan Fernández desplazan el encuadre de Valparaíso al Pacífico
    const cont = cs.filter((c) => c.bbox[0] > -80);
    return L.latLngBounds(cont.flatMap((c) => [[c.bbox[1], c.bbox[0]], [c.bbox[3], c.bbox[2]]]));
  }

  function elegirRegion(id, { volar = true } = {}) {
    estado.region = id;
    if (volar) estado.editandoLugar = true;
    document.querySelectorAll("#regiones button").forEach((b) => b.setAttribute("aria-selected", String(+b.dataset.r === id)));
    const input = $("#comuna");
    input.disabled = false;
    if (!estado.comuna || estado.comuna.region !== id) { input.value = ""; estado.comuna = null; bloquearRol(true); }
    refrescarContornos();
    if (volar) {
      mapa.flyToBounds(extensionRegion(id), { ...paddingVista(), duration: 1.6 });
      if (!movil()) input.focus();
    }
    document.body.classList.remove("inicio");
  }

  function elegirComuna(c, { volar = true } = {}) {
    if (estado.region !== c.region) elegirRegion(c.region, { volar: false });
    estado.comuna = c;
    estado.editandoLugar = false;
    pintarLugar();
    if (volar && movil()) fijarHoja("cerrada");
    $("#comuna").value = c.nombre;
    cerrarSugerencias();
    bloquearRol(false);
    $("#resultadosDir").hidden = true;
    refrescarContornos();
    document.body.classList.remove("inicio");
    pintarEstado(`<span class="ok">●</span> <b>${esc(c.nombre)}</b> · código SII ${c.cod}`);
    if (volar && c.bbox) {
      const b = L.latLngBounds([c.bbox[1], c.bbox[0]], [c.bbox[3], c.bbox[2]]);
      mapa.flyToBounds(b, { ...paddingVista(), duration: 2.2, maxZoom: 15 });
    }
    escribirHash();
  }

  // Resumen "RM · Metropolitana > Vitacura": pliega la grilla de regiones una vez elegida la comuna.
  function pintarLugar() {
    const c = estado.comuna, r = c && estado.regiones.find((x) => x.id === c.region);
    const compacto = !!c && !estado.editandoLugar;
    document.body.classList.toggle("lugar-compacto", compacto);
    $("#lugarResumen").hidden = !compacto;
    if (c) $("#lugarResumen .lr-ruta").innerHTML =
      `<span>${esc(r ? r.romano : "")}</span>${esc(r ? r.nombre : "")}<i>›</i><b>${esc(c.nombre)}</b>`;
  }
  $("#cambiarLugar").addEventListener("click", () => {
    estado.editandoLugar = true; pintarLugar();
    if (movil()) fijarHoja("abierta");
    setTimeout(() => $("#comuna").focus(), 50);
  });

  function bloquearRol(si) {
    $("#rol").disabled = si; $("#formRol button").disabled = si;
    if (si) $("#rol").value = "";
  }
  const pintarEstado = (html) => { $("#estado").innerHTML = html; };

  // Buscador de comunas con teclado
  const input = $("#comuna"), lista = $("#sugerencias");
  let activa = -1, opciones = [];
  const normal = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  function sugerir() {
    const q = normal(input.value.trim());
    opciones = estado.comunas.filter((c) => (!estado.region || c.region === estado.region) && normal(c.nombre).includes(q));
    if (!estado.region && !q) opciones = [];
    activa = opciones.length ? 0 : -1;
    lista.innerHTML = opciones.slice(0, 60).map((c, i) =>
      `<li role="option" data-cod="${c.cod}" class="${i === activa ? "activa" : ""}">${esc(c.nombre)}<small>${c.cod}</small></li>`).join("")
      || `<li aria-disabled="true"><small>Sin coincidencias</small></li>`;
    lista.hidden = false;
  }
  function cerrarSugerencias() { lista.hidden = true; activa = -1; }
  input.addEventListener("focus", sugerir);
  input.addEventListener("input", sugerir);
  input.addEventListener("keydown", (e) => {
    if (lista.hidden) return;
    const n = Math.min(opciones.length, 60);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      activa = (activa + (e.key === "ArrowDown" ? 1 : -1) + n) % n;
      lista.querySelectorAll("li").forEach((li, i) => li.classList.toggle("activa", i === activa));
      lista.children[activa]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && activa >= 0) {
      e.preventDefault(); elegirComuna(opciones[activa]); input.blur();
    } else if (e.key === "Escape") cerrarSugerencias();
  });
  lista.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-cod]"); if (!li) return;
    e.preventDefault(); elegirComuna(estado.porCod.get(+li.dataset.cod)); input.blur();
  });
  input.addEventListener("blur", () => setTimeout(cerrarSugerencias, 120));

  // ── Consulta de predios ─────────────────────────────────
  let marca = null, consultaId = 0;
  const icono = (cargando) => L.divIcon({ className: "", html: `<div class="mira${cargando ? " cargando" : ""}"><i></i></div>`, iconSize: [44, 44], iconAnchor: [22, 22] });

  async function llamar(ruta, params) {
    if (!api) throw new Error("sin-api");
    const r = await fetch(`${api}${ruta}?${new URLSearchParams(params)}`);
    if (!r.ok) throw new Error(`http-${r.status}`);
    return r.json();
  }

  async function consultar(lat, lon, { candidatas } = {}) {
    const id = ++consultaId;
    if (marca) marca.setLatLng([lat, lon]).setIcon(icono(true)); else marca = L.marker([lat, lon], { icon: icono(true), interactive: false, keyboard: false }).addTo(mapa);
    abrirFicha(`<div class="esqueleto"><i></i><i></i><i style="width:70%"></i><i></i><i style="width:40%"></i></div>`);
    const lista = candidatas || comunasEnPunto(lat, lon);
    if (!lista.length) return fichaVacia("Fuera de las comunas", "Este punto no cae dentro de ninguna comuna con cartografía del SII.");
    try {
      for (const c of lista) {
        const r = await llamar("/predio", { cod: c.cod, layer: c.layer, lat: lat.toFixed(6), lon: lon.toFixed(6) });
        if (id !== consultaId) return;
        if (r.predio) {
          marca.setIcon(icono(false));
          if (!estado.comuna || estado.comuna.cod !== c.cod) elegirComuna(c, { volar: false });
          pintarFicha(r.predio, c, lat, lon);
          escribirHash(lat, lon);
          return r.predio;
        }
      }
      fichaVacia("Sin predio aquí", "El SII no tiene un predio registrado en este punto. Puede ser un bien nacional de uso público, como una calle, un río o una plaza. Prueba tocando dentro de un lote.");
    } catch (err) {
      if (id !== consultaId) return;
      if (err.message === "sin-api") {
        fichaVacia("Falta el intermediario", "Los deslindes se ven directo desde el SII, pero para leer la ficha la web necesita el Worker de Cloudflare. Configura la variable PREDIAL_API del repositorio (ver README).");
      } else {
        fichaVacia("El SII no respondió", "La consulta no llegó a buen puerto. Espera unos segundos y vuelve a tocar el predio.");
      }
    }
  }

  function fichaVacia(t, p) {
    if (marca) marca.setIcon(icono(false));
    abrirFicha(`<div class="vacio"><h2>${esc(t)}</h2><p>${esc(p)}</p></div>`);
  }

  mapa.on("click", (e) => {
    if (mapa.getZoom() < ZOOM_PREDIOS - 0.5) return;
    if (mapa.getZoom() < ZOOM_CLIC) { mapa.flyTo(e.latlng, 17, { duration: 0.9 }); return; }
    consultar(e.latlng.lat, e.latlng.lng);
  });

  // ── Ficha ───────────────────────────────────────────────
  const ficha = $("#ficha"), fichaCuerpo = $("#fichaCuerpo");
  function abrirFicha(html) {
    fichaCuerpo.innerHTML = html; ficha.hidden = false; document.body.classList.add("con-ficha");
    minimizarFicha(false);
  }
  function minimizarFicha(si) {
    document.body.classList.toggle("ficha-min", si);
    $("#fichaPill").hidden = !si;
  }
  $("#minimizarFicha").addEventListener("click", () => minimizarFicha(true));
  $("#fichaPill").addEventListener("click", () => minimizarFicha(false));
  function cerrarFicha() {
    ficha.hidden = true; document.body.classList.remove("con-ficha");
    minimizarFicha(false);
    consultaId++;
    if (marca) { mapa.removeLayer(marca); marca = null; }
    escribirHash();
  }
  $("#cerrarFicha").addEventListener("click", cerrarFicha);
  addEventListener("keydown", (e) => { if (e.key === "Escape" && !ficha.hidden) cerrarFicha(); });

  function pintarFicha(p, c, lat, lon) {
    const region = estado.regiones.find((r) => r.id === c.region);
    const rol = p.rol || `${p.manzana}-${p.predio}`;
    const total = +p.valorTotal || 0, afecto = +p.valorAfecto || 0, exento = +p.valorExento || 0;
    const pa = total ? (afecto / total) * 100 : 0;
    const supCons = Math.max(+p.supConsMt2 || 0, +p.supConsMt3 || 0);
    const supTerr = +p.supTerreno || 0;
    const ah = p.datosAh || {};
    const plat = p.ubicacionX || lat, plon = p.ubicacionY || lon;
    const filas = [
      ["Destino", titulo(p.destinoDescripcion)],
      ["Ubicación", titulo(p.ubicacion)],
      supTerr ? ["Sup. terreno", `${num.format(supTerr)} m²`] : null,
      supCons ? ["Sup. construida", `${num.format(supCons)} m²`] : null,
      ["Periodo", titulo(p.periodo)],
      ["Reavalúo", titulo(p.eacsDescripcion)],
      p.agnoSancion ? ["Año sanción", p.agnoSancion] : null,
      ["Coordenadas", `${plat.toFixed(5)}, ${plon.toFixed(5)}`],
    ].filter(Boolean);
    const filasAh = ah.codigoAh ? [
      ["Código", ah.codigoAh],
      ah.valorUnitario ? ["Valor unitario", `${clp.format(ah.valorUnitario)} / m²`] : null,
      ah.rangoSuperficie && ah.rangoSuperficie.trim() ? ["Rango superficie", `${ah.rangoSuperficie.trim()} m²`] : null,
    ].filter(Boolean) : [];
    const dl = (fs) => `<dl class="tabla">${fs.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>`;

    abrirFicha(`
      <div class="ficha-cab">
        <div class="tipo">Rol de avalúo</div>
        <div class="rol-grande">${esc(rol)}<small>${c.cod}</small></div>
        <div class="dir">${esc((p.direccion || "Sin dirección registrada").trim())}</div>
        <div class="com">${esc(c.nombre)} · Región ${esc(region ? region.nombre : c.region)}</div>
      </div>
      <div class="cifra">
        <div class="eti">Avalúo fiscal total</div>
        <div class="val">${total ? clp.format(total) : "—"}</div>
        ${total ? `<div class="barra" aria-hidden="true"><i style="width:${pa}%"></i><i style="width:${100 - pa}%"></i></div>
        <div class="leyenda"><span>Afecto <b>${clp.format(afecto)}</b></span><span>Exento <b>${clp.format(exento)}</b></span></div>` : ""}
      </div>
      ${dl(filas)}
      ${filasAh.length ? `<div class="seccion">Área homogénea</div>${dl(filasAh)}` : ""}
      <div class="tgr sii">
        <h3>Más antecedentes en el SII</h3>
        <p>El detalle de cada construcción (material, calidad, año y superficie) y el tipo de exención no se publican en el mapa del SII. Están en el <b>certificado de avalúo fiscal detallado</b>, que pide la clave tributaria del propietario. La <b>consulta de avalúos y contribuciones</b> es pública, pero tiene captcha.</p>
        <div class="acciones">
          <a class="boton" href="${SII_AVALUOS_URL}" target="_blank" rel="noopener" data-copiar-al-abrir="${esc(rol)}">Avalúos y certificados SII ↗</a>
        </div>
      </div>
      <div class="tgr">
        <h3>¿De quién es?</h3>
        <p>La TGR emite el certificado de deuda de contribuciones con el nombre del propietario. Copia estos datos, abre la TGR y completa el formulario; el certificado se abre como PDF.</p>
        <div class="copias">
          <button class="copia" data-copiar="${esc(region ? region.nombre : "")}"><span>Región</span><b>${esc(region ? `${region.romano} · ${region.nombre}` : c.region)}</b></button>
          <button class="copia" data-copiar="${esc(c.nombre)}"><span>Comuna</span><b>${esc(c.nombre)}</b></button>
          <button class="copia" data-copiar="${esc(rol)}"><span>Rol</span><b>${esc(rol)}</b></button>
        </div>
        <div class="acciones">
          <a class="boton primario" href="${TGR_URL}" target="_blank" rel="noopener" data-copiar-al-abrir="${esc(rol)}">Abrir certificado TGR ↗</a>
        </div>
      </div>
      <div class="otros">
        <button class="boton primario" id="compartirFicha" type="button">Compartir</button>
        <a class="boton" id="ofertaCerca" target="_blank" rel="noopener" href="${urlOferta(fichaZona = L.latLng(+plat, +plon).toBounds(1000))}" title="Portal Inmobiliario, 500 m alrededor del predio">${oferta.operacion === "arriendo" ? "En arriendo" : "En venta"} cerca ↗</a>
        <button class="boton" id="copiarFicha">Copiar ficha</button>
        <a class="boton" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${plat},${plon}">Google Maps ↗</a>
        <a class="boton" target="_blank" rel="noopener" href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${plat},${plon}">Street View ↗</a>
      </div>`);

    $("#fichaPill").innerHTML = `<span>Rol</span> ${esc(rol)} <small>${esc(c.nombre)}</small>`;
    $("#compartirFicha").addEventListener("click", async (e) => {
      const url = location.href;
      if (navigator.share && movil()) { try { await navigator.share({ title: `Rol ${rol} · ${c.nombre}`, url }); } catch {} return; }
      copiar(url, e.currentTarget, "Enlace copiado ✓");
    });
    $("#copiarFicha").addEventListener("click", (e) => {
      const txt = [`Rol ${rol} · ${c.nombre} (${c.cod})`, (p.direccion || "").trim(),
        `Avalúo total: ${clp.format(total)} (afecto ${clp.format(afecto)}, exento ${clp.format(exento)})`,
        ...filas.map(([k, v]) => `${k}: ${v}`), location.href].filter(Boolean).join("\n");
      copiar(txt, e.currentTarget, "Copiado ✓");
    });
  }

  // ── Oferta en Portal Inmobiliario ───────────────────────
  // No se copia ningún aviso: solo se arma el enlace a la búsqueda en mapa del portal
  // con el mismo recuadro (lat/lon) que se ve en Predial.
  const oferta = { operacion: "venta", tipo: "" };
  let fichaZona = null;  // recuadro de ~500 m alrededor del predio abierto en la ficha
  try { Object.assign(oferta, JSON.parse(localStorage.getItem("predial-oferta") || "{}")); } catch {}
  function urlOferta(b) {
    const f = (n) => n.toFixed(6);
    const ruta = [oferta.operacion, oferta.tipo].filter(Boolean).join("/");
    return `${PI_URL}${ruta}/_DisplayType_M_item*location_lat:${f(b.getSouth())}*${f(b.getNorth())},lon:${f(b.getWest())}*${f(b.getEast())}`;
  }
  function actualizarOferta() {
    const b = mapa.getBounds();
    $("#verOferta").href = urlOferta(b);
    const ancho = b.getSouthWest().distanceTo(b.getSouthEast()) / 1000;
    const alto = b.getSouthWest().distanceTo(b.getNorthWest()) / 1000;
    $("#zonaOferta").textContent = `zona visible · ${num.format(ancho)} × ${num.format(alto)} km`;
    const cerca = $("#ofertaCerca");
    if (cerca && fichaZona) {
      cerca.href = urlOferta(fichaZona);
      cerca.textContent = `${oferta.operacion === "arriendo" ? "En arriendo" : "En venta"} cerca ↗`;
    }
    document.querySelectorAll("[data-operacion]").forEach((x) => x.classList.toggle("activo", x.dataset.operacion === oferta.operacion));
    $("#tipoOferta").value = oferta.tipo;
    try { localStorage.setItem("predial-oferta", JSON.stringify(oferta)); } catch {}
  }
  document.querySelectorAll("[data-operacion]").forEach((x) => x.addEventListener("click", () => { oferta.operacion = x.dataset.operacion; actualizarOferta(); }));
  $("#tipoOferta").addEventListener("change", (e) => { oferta.tipo = e.target.value; actualizarOferta(); });
  mapa.on("moveend zoomend", actualizarOferta);
  actualizarOferta();

  async function copiar(texto, el, etiqueta) {
    try { await navigator.clipboard.writeText(texto); } catch { return; }
    if (el.classList.contains("copia")) { el.classList.add("hecho"); setTimeout(() => el.classList.remove("hecho"), 1600); }
    else if (etiqueta) { const t = el.textContent; el.textContent = etiqueta; setTimeout(() => (el.textContent = t), 1400); }
  }
  fichaCuerpo.addEventListener("click", (e) => {
    const b = e.target.closest("[data-copiar]"); if (b) copiar(b.dataset.copiar, b);
    const a = e.target.closest("[data-copiar-al-abrir]"); if (a) navigator.clipboard?.writeText(a.dataset.copiarAlAbrir).catch(() => {});
  });

  // ── Búsqueda por rol o dirección ────────────────────────
  // Abre la ficha con los datos del rol (no con el punto): en un edificio, el punto devuelve
  // los bienes comunes y no la unidad buscada (depto, oficina, bodega…).
  async function mostrarRol(c, manzana, predio) {
    pintarEstado(`Buscando rol <b>${manzana}-${predio}</b> en ${esc(c.nombre)}…`);
    const r = await llamar("/rol", { cod: c.cod, manzana, predio });
    if (!r.predio) return pintarEstado(`<span class="mal">●</span> El SII no encontró el rol ${manzana}-${predio} en ${esc(c.nombre)}`);
    const lat = +r.predio.ubicacionX, lon = +r.predio.ubicacionY;
    pintarEstado(`<span class="ok">●</span> Rol <b>${manzana}-${predio}</b> encontrado`);
    if (marca) marca.setLatLng([lat, lon]).setIcon(icono(false)); else marca = L.marker([lat, lon], { icon: icono(false), interactive: false, keyboard: false }).addTo(mapa);
    pintarFicha(r.predio, c, lat, lon);
    escribirHash(lat, lon, `${manzana}-${predio}`);
    const z = Math.max(mapa.getZoom(), 18);
    // En celular la ficha tapa la parte baja: el predio queda en la franja visible de arriba.
    const destino = movil() ? mapa.unproject(mapa.project([lat, lon], z).add([0, innerHeight * 0.39]), z) : L.latLng(lat, lon);
    mapa.flyTo(destino, z, { duration: 1.6 });
  }

  // Tipos de unidad que entiende el buscador del SII (listDestinos).
  const UNIDADES = {
    casa: 1, cs: 1, depto: 2, dpto: 2, dto: 2, dp: 2, departamento: 2, of: 3, ofi: 3, oficina: 3,
    box: 4, bx: 4, estacionamiento: 4, est: 4, bodega: 5, bd: 5, parcela: 8, pc: 8,
    local: 9, loc: 9, lc: 9, sitio: 10, lote: 10, block: 12, blk: 12,
  };
  const sinTildes = (t) => t.replace(/[áàäâ]/gi, (m) => (m === m.toUpperCase() ? "A" : "a")).replace(/[éèëê]/gi, "e")
    .replace(/[íìïî]/gi, "i").replace(/[óòöô]/gi, "o").replace(/[úùüû]/gi, "u");
  function leerDireccion(txt) {
    let t = sinTildes(txt).replace(/[,#°º]/g, " ").replace(/\s+/g, " ").trim();
    let detalle = 0, unidad = "";
    const u = t.match(new RegExp(`\\s(${Object.keys(UNIDADES).join("|")})\\.?\\s*([a-z0-9-]{1,10})$`, "i"));
    if (u) { detalle = UNIDADES[u[1].toLowerCase()]; unidad = u[2].toUpperCase(); t = t.slice(0, u.index).trim(); }
    const n = t.match(/^(.*?[a-zñ].*?)\s+(?:n\.?\s*)?(\d{1,6})$/i);
    if (!n) return null;
    const calle = n[1].replace(/^(avenida|avda\.?|av\.?)\s+/i, "").replace(/[^a-zñ0-9 .'-]/gi, " ").replace(/\s+/g, " ").trim().toUpperCase();
    return calle.length >= 2 ? { calle, numero: n[2], detalle, unidad } : null;
  }

  const resDir = $("#resultadosDir");
  let candidatosDir = [];
  function cerrarResultados() { resDir.hidden = true; resDir.innerHTML = ""; candidatosDir = []; }
  async function buscarDireccion(c, d) {
    const etiqueta = `${d.calle} ${d.numero}${d.unidad ? ` · ${d.unidad}` : ""}`;
    pintarEstado(`Buscando <b>${esc(etiqueta)}</b> en ${esc(c.nombre)}…`);
    const r = await llamar("/direccion", { cod: c.cod, calle: d.calle, numero: d.numero, detalle: d.detalle, unidad: d.unidad });
    const todos = r.resultados || [];
    // El SII compara de forma aproximada: primero los que tienen exactamente ese número (y esa unidad).
    // Exacto: el número viene justo después de la última palabra de la calle (VELASQUEZ 2071),
    // y la unidad, si se pidió, aparece después (DP 1001).
    const ultima = d.calle.split(" ").pop().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const base = new RegExp(`(^|\\s)\\S*${ultima}\\s+0*${d.numero}(?=\\s|$)`, "i");
    const uni = d.unidad ? new RegExp(`(^|\\s)0*${d.unidad.replace(/^0+/, "")}(\\s|$)`) : null;
    const puntaje = (x) => {
      const m = x.direccion.match(base);
      if (!m) return 2;
      return uni && !uni.test(x.direccion.slice(m.index + m[0].length)) ? 1 : 0;
    };
    // Dentro de cada grupo: viviendas, oficinas y locales antes que bodegas y estacionamientos.
    const secundario = (x) => (/ESTACIONAMIENTO|BODEGA/.test(x.destino) ? 1 : 0);
    candidatosDir = todos.map((x) => ({ ...x, p: puntaje(x) })).sort((a, b) =>
      a.p - b.p || secundario(a) - secundario(b) || a.direccion.localeCompare(b.direccion, "es", { numeric: true }));
    const exactos = candidatosDir.filter((x) => x.p === 0);
    if (!candidatosDir.length) {
      cerrarResultados();
      return pintarEstado(`<span class="mal">●</span> El SII no encontró <b>${esc(etiqueta)}</b> en ${esc(c.nombre)}. Revisa el número o prueba sin “avenida”, “pasaje”, etc.`);
    }
    if (exactos.length === 1) { cerrarResultados(); return mostrarRol(c, exactos[0].manzana, exactos[0].predio); }
    const MAX = 60, lista = candidatosDir.slice(0, MAX);
    const total = r.total || candidatosDir.length;
    pintarEstado(`<span class="ok">●</span> ${total.toLocaleString("es-CL")} resultado${total === 1 ? "" : "s"} para <b>${esc(etiqueta)}</b>`);
    resDir.innerHTML = `
      <div class="res-cab">${exactos.length ? `${exactos.length} con ese número` : "Sin coincidencia exacta; los más parecidos"}${total > MAX ? ` · muestro ${MAX} de ${total.toLocaleString("es-CL")}` : ""}
        <button type="button" class="res-cerrar" aria-label="Cerrar resultados">×</button></div>
      <ul>${lista.map((x, i) => `<li><button type="button" data-i="${i}"${x.p ? ' class="lejano"' : ""}>
        <b>${esc(x.direccion)}</b><span>${esc(x.rol)} · ${esc(titulo(x.destino))}</span></button></li>`).join("")}</ul>
      ${total > MAX && !d.unidad ? `<p class="res-nota">Agrega el depto, oficina o bodega para acotar, por ejemplo “${esc(d.calle.toLowerCase())} ${d.numero} depto 101”.</p>` : ""}`;
    resDir.hidden = false;
  }
  resDir.addEventListener("click", async (e) => {
    if (e.target.closest(".res-cerrar")) return cerrarResultados();
    const b = e.target.closest("[data-i]"); if (!b) return;
    const x = candidatosDir[+b.dataset.i], c = estado.comuna; if (!x || !c) return;
    resDir.querySelectorAll("[data-i]").forEach((y) => y.classList.toggle("elegido", y === b));
    try { await mostrarRol(c, x.manzana, x.predio); } catch (err) { errorBusqueda(err); }
  });
  function errorBusqueda(err) {
    pintarEstado(`<span class="mal">●</span> ${err.message === "sin-api" ? "Falta configurar el intermediario (PREDIAL_API)" : "El SII no respondió; intenta de nuevo"}`);
  }

  $("#formRol").addEventListener("submit", async (e) => {
    e.preventDefault();
    const c = estado.comuna; if (!c) return;
    const txt = $("#rol").value.trim(); if (!txt) return;
    try {
      const m = txt.match(/^(\d{1,6})\s*[-–\s/]\s*(\d{1,6})$/);
      if (m) { cerrarResultados(); return await mostrarRol(c, +m[1], +m[2]); }
      const d = leerDireccion(txt);
      if (!d) return pintarEstado(`<span class="mal">●</span> Escribe un rol (1235-5) o una dirección con número (Espoz 5783, opcional “depto 12”)`);
      await buscarDireccion(c, d);
    } catch (err) { errorBusqueda(err); }
  });

  // ── Fondo y rótulos ─────────────────────────────────────
  document.querySelectorAll("[data-fondo]").forEach((b) => b.addEventListener("click", () => {
    const f = b.dataset.fondo; if (f === estado.fondo) return;
    mapa.removeLayer(fondos[estado.fondo]); fondos[f].addTo(mapa).bringToBack();
    document.body.classList.replace(`fondo-${estado.fondo}`, `fondo-${f}`);
    estado.fondo = f;
    document.querySelectorAll("[data-fondo]").forEach((x) => x.classList.toggle("activo", x === b));
    refrescarContornos();
  }));
  // Intensidad de los deslindes (se guarda en el navegador)
  const intensidad = $("#intensidad");
  function fijarIntensidad(v) {
    document.documentElement.style.setProperty("--lineas", v);
    try { localStorage.setItem("predial-lineas", v); } catch {}
  }
  try { const v = localStorage.getItem("predial-lineas"); if (v) intensidad.value = v; } catch {}
  fijarIntensidad(intensidad.value);
  intensidad.addEventListener("input", () => fijarIntensidad(intensidad.value));

  $("#btnRotulos").addEventListener("click", (e) => {
    estado.rotulos = !estado.rotulos;
    e.currentTarget.classList.toggle("activo", estado.rotulos);
    rehacerCapas();
  });

  // ── Enlace compartible: #comuna[/lat/lon[/manzana-predio]] ──
  // Con el rol, el enlace abre la unidad exacta (en un edificio, el punto solo da los bienes comunes).
  function escribirHash(lat, lon, rol) {
    const h = estado.comuna ? `#${estado.comuna.cod}${lat != null ? `/${lat.toFixed(6)}/${lon.toFixed(6)}${rol ? `/${rol}` : ""}` : ""}` : "";
    history.replaceState(null, "", h || location.pathname + location.search);
  }
  function leerHash() {
    const [cod, lat, lon, rol] = location.hash.slice(1).split("/");
    const c = estado.porCod.get(+cod); if (!c) return;
    const m = (rol || "").match(/^(\d{1,6})-(\d{1,6})$/);
    if (lat && lon && m) {
      elegirComuna(c, { volar: false });
      mapa.setView([+lat, +lon], 18);
      mostrarRol(c, +m[1], +m[2]).catch(errorBusqueda);
    } else if (lat && lon) {
      elegirComuna(c, { volar: false });
      mapa.setView([+lat, +lon], 18);
      consultar(+lat, +lon, { candidatas: [c] });
    } else elegirComuna(c);
  }

  // ── Buscar lugar o dirección (OpenStreetMap / Nominatim) ──
  // Se consulta solo al apretar Enter (sin autocompletar), como pide la política de uso de Nominatim.
  const NOMINATIM = "https://nominatim.openstreetmap.org/search";
  const TIPOS_LUGAR = {
    city: "Ciudad", town: "Pueblo", village: "Localidad", hamlet: "Caserío", locality: "Sector", suburb: "Barrio",
    neighbourhood: "Barrio", quarter: "Barrio", municipality: "Comuna", county: "Provincia", state: "Región",
    road: "Calle", residential: "Calle", living_street: "Pasaje", pedestrian: "Paseo", primary: "Avenida", secondary: "Avenida",
    tertiary: "Calle", unclassified: "Camino", service: "Calle", track: "Camino", highway: "Calle", house: "Dirección", building: "Edificio", amenity: "Lugar", tourism: "Turismo",
    natural: "Lugar natural", water: "Agua", peak: "Cerro", beach: "Playa", bay: "Bahía", island: "Isla",
  };
  // Nombre legible: en una dirección OSM entrega "5783, Espoz, …"; se arma "Espoz 5783".
  function nombreLugar(x) {
    const partes = x.display_name.split(", ").filter((p) => p !== "Chile" && !/^\d{5,}$/.test(p));
    if (/^\d+[a-z]?$/i.test(partes[0]) && partes[1]) return { nombre: `${partes[1]} ${partes[0]}`, resto: partes.slice(2, 5).join(", ") };
    const nombre = x.name || partes[0];
    return { nombre, resto: partes.filter((p) => p !== nombre).slice(0, 3).join(", ") };
  }
  const resLugar = $("#resultadosLugar");
  let lugares = [];
  function cerrarLugares() { resLugar.hidden = true; resLugar.innerHTML = ""; lugares = []; }
  function irALugar(r) {
    cerrarLugares();
    const lat = +r.lat, lon = +r.lon;
    const [s, n, w, e] = (r.boundingbox || []).map(Number);
    const esPunto = r.place_rank >= 26;  // calle, número o edificio: se abre el predio
    const cs = comunasEnPunto(lat, lon, { estricto: true });
    if (cs.length && (!estado.comuna || estado.comuna.cod !== cs[0].cod)) elegirComuna(cs[0], { volar: false });
    if (movil()) fijarHoja("cerrada");
    pintarEstado(`<span class="ok">●</span> <b>${esc(nombreLugar(r).nombre)}</b>${cs.length ? ` · ${esc(cs[0].nombre)}` : ""}`);
    if (esPunto && r.addresstype !== "road") {
      mapa.flyTo([lat, lon], 18, { duration: 1.8 });
      if (cs.length) mapa.once("moveend", () => consultar(lat, lon, { candidatas: cs }));
    } else if (isFinite(s) && isFinite(n)) {
      mapa.flyToBounds([[s, w], [n, e]], { ...paddingVista(), duration: 1.8, maxZoom: esPunto ? 18 : 16 });
    } else mapa.flyTo([lat, lon], 15, { duration: 1.8 });
  }
  $("#formLugar").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("#lugarBuscado").value.trim(); if (q.length < 2) return;
    $("#lugarBuscado").blur();
    pintarEstado(`Buscando <b>${esc(q)}</b>…`);
    try {
      const url = `${NOMINATIM}?${new URLSearchParams({ q, countrycodes: "cl", format: "jsonv2", limit: "8", "accept-language": "es" })}`;
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error("http");
      lugares = (await r.json()).filter((x) => x.lat && x.lon);
    } catch {
      cerrarLugares();
      return pintarEstado(`<span class="mal">●</span> El buscador de lugares no respondió; intenta de nuevo`);
    }
    if (!lugares.length) { cerrarLugares(); return pintarEstado(`<span class="mal">●</span> No encontré <b>${esc(q)}</b> en Chile`); }
    if (lugares.length === 1) return irALugar(lugares[0]);
    pintarEstado("");
    resLugar.innerHTML = `
      <div class="res-cab">${lugares.length} lugares para “${esc(q)}”<button type="button" class="res-cerrar" aria-label="Cerrar resultados">×</button></div>
      <ul>${lugares.map((x, i) => {
        const { nombre, resto } = nombreLugar(x);
        const tipo = TIPOS_LUGAR[x.addresstype] || TIPOS_LUGAR[x.type] || TIPOS_LUGAR[x.category] || "";
        return `<li><button type="button" data-l="${i}"><b>${esc(nombre)}</b><span>${tipo ? `${esc(tipo)} · ` : ""}${esc(resto)}</span></button></li>`;
      }).join("")}</ul>
      <p class="res-nota">Búsqueda: © colaboradores de OpenStreetMap</p>`;
    resLugar.hidden = false;
    if (movil()) fijarHoja("media");
  });
  resLugar.addEventListener("click", (e) => {
    if (e.target.closest(".res-cerrar")) return cerrarLugares();
    const b = e.target.closest("[data-l]"); if (b && lugares[+b.dataset.l]) irALugar(lugares[+b.dataset.l]);
  });

  // ── Panel lateral (escritorio) ──────────────────────────
  function plegarPanel(si) {
    document.body.classList.toggle("panel-oculto", si);
    $("#abrirPanel").hidden = !si;
    try { localStorage.setItem("predial-panel", si ? "oculto" : ""); } catch {}
  }
  $("#plegarPanel").addEventListener("click", () => plegarPanel(true));
  $("#abrirPanel").addEventListener("click", () => plegarPanel(false));

  // ── Hoja deslizable (celular) ───────────────────────────
  const ESTADOS_HOJA = ["cerrada", "media", "abierta"];
  function fijarHoja(e) {
    ESTADOS_HOJA.forEach((x) => document.body.classList.toggle(`hoja-${x}`, x === e));
    $("#consola").style.maxHeight = "";
  }
  (() => {
    const asa = $("#asa"), consola = $("#consola");
    let y0 = null, h0 = 0, movido = false;
    asa.addEventListener("pointerdown", (e) => {
      if (!movil()) return;
      y0 = e.clientY; h0 = consola.getBoundingClientRect().height; movido = false;
      asa.setPointerCapture(e.pointerId); consola.classList.add("arrastrando");
    });
    asa.addEventListener("pointermove", (e) => {
      if (y0 === null) return;
      const dy = e.clientY - y0; if (Math.abs(dy) > 4) movido = true;
      consola.style.maxHeight = `${Math.max(96, Math.min(innerHeight * 0.9, h0 - dy))}px`;
    });
    const soltar = () => {
      if (y0 === null) return;
      consola.classList.remove("arrastrando");
      const actual = ESTADOS_HOJA.find((x) => clase(`hoja-${x}`)) || "media";
      if (!movido) fijarHoja(actual === "cerrada" ? "media" : "cerrada");
      else {
        const h = consola.getBoundingClientRect().height / innerHeight;
        fijarHoja(h < 0.3 ? "cerrada" : h < 0.66 ? "media" : "abierta");
      }
      y0 = null;
    };
    asa.addEventListener("pointerup", soltar);
    asa.addEventListener("pointercancel", soltar);
  })();
  fijarHoja("media");

  // ── Control del mapa: mi ubicación ──────────────────────
  const ICONO_UBIC = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7.5"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/></svg>`;
  let puntoYo = null;
  const ControlUbicacion = L.Control.extend({
    options: { position: "bottomright" },
    onAdd() {
      const d = L.DomUtil.create("div", "leaflet-bar control-extra");
      d.innerHTML = `<a href="#" role="button" id="btnUbicacion" title="Mi ubicación" aria-label="Ir a mi ubicación">${ICONO_UBIC}</a>`;
      L.DomEvent.disableClickPropagation(d);
      return d;
    },
  });
  new ControlUbicacion().addTo(mapa);
  $("#btnUbicacion").addEventListener("click", (e) => {
    e.preventDefault();
    const b = e.currentTarget;
    if (!navigator.geolocation) return pintarEstado(`<span class="mal">●</span> Este navegador no permite obtener tu ubicación`);
    b.classList.add("cargando");
    navigator.geolocation.getCurrentPosition((pos) => {
      b.classList.remove("cargando");
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;
      if (puntoYo) mapa.removeLayer(puntoYo);
      puntoYo = L.layerGroup([
        L.circle([lat, lon], { radius: Math.min(accuracy, 300), color: "#e8e6df", weight: 1, opacity: 0.5, fillOpacity: 0.06, interactive: false }),
        L.circleMarker([lat, lon], { radius: 6, color: "#0a0c0b", weight: 2, fillColor: "#e8e6df", fillOpacity: 1, interactive: false }),
      ]).addTo(mapa);
      if (!comunasEnPunto(lat, lon, { estricto: true }).length) {
        mapa.flyTo([lat, lon], 11, { duration: 1.4 });
        return pintarEstado(`<span class="mal">●</span> Tu ubicación no cae en una comuna con cartografía del SII`);
      }
      if (movil()) fijarHoja("cerrada");
      mapa.flyTo([lat, lon], 18, { duration: 1.6 });
      mapa.once("moveend", () => consultar(lat, lon));
    }, () => {
      b.classList.remove("cargando");
      pintarEstado(`<span class="mal">●</span> No se pudo obtener tu ubicación (revisa el permiso del navegador)`);
    }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  });

  try { if (!movil() && localStorage.getItem("predial-panel") === "oculto") plegarPanel(true); } catch {}
  encuadreInicial(false);

  // ── Arranque ────────────────────────────────────────────
  Promise.all([fetch("data/comunas.json").then((r) => r.json()), fetch("data/comunas.geojson").then((r) => r.json())])
    .then(([cat, geo]) => {
      estado.regiones = cat.regiones;
      estado.comunas = cat.comunas;
      cat.comunas.forEach((c) => estado.porCod.set(c.cod, c));
      pintarRegiones();
      prepararContornos(geo);
      input.disabled = false;
      input.placeholder = "Escribe una comuna…";
      if (location.hash.length > 1) leerHash();
    })
    .catch(() => pintarEstado(`<span class="mal">●</span> No se pudo cargar el catálogo de comunas`));

  addEventListener("resize", () => mapa.invalidateSize());

  // Funciones compartidas con capa.js (importación de KML/KMZ)
  window.Predial = { mapa, estado, llamar, consultar, comunasEnPunto, abrirFicha, cerrarFicha, pintarEstado, paddingVista, esc, clp, num, titulo, $ };
})();

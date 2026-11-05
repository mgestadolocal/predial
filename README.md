# Predial

Mapa de Chile para consultar los predios del SII: eliges región y comuna, el mapa vuela a la comuna, aparecen los deslindes de los predios y, al tocar uno, se abre su ficha (rol, dirección, destino, avalúo total, afecto y exento, área homogénea). La ficha incluye un acceso asistido al certificado de deuda de contribuciones de la TGR, que trae el nombre del propietario.

No se descarga ni se aloja cartografía: los deslindes se cargan **en vivo** desde el WMS público del SII.

## Cómo funciona

```
navegador ──(imágenes WMS, sin CORS)──────────────► SII  wmsProxyService
    │
    └──(fetch /predio, /rol, /direccion)──► Cloudflare Worker ──► SII  mapasFacadeService
```

- `web/`: sitio estático (Leaflet). Se publica en GitHub Pages con `.github/workflows/pages.yml`.
- `worker/`: intermediario mínimo. La API del SII no envía cabeceras CORS, así que el navegador no puede leer la ficha directamente. Solo expone tres consultas de lectura, valida los parámetros y guarda en caché las respuestas por 24 horas. Se publica con `.github/workflows/worker.yml`.
- `web/data/comunas.json`: catálogo de las 347 comunas con cartografía del SII (código SII, capa WMS, región y extensión). `web/data/comunas.geojson` tiene los contornos simplificados de la BCN.
- `tools/`: scripts para rehacer el catálogo (`catalogo_comunas.py`, `catalogo_completar.py`, `cruce.py`, `armar_datos_web.py`) y un servidor de prueba (`servidor_local.py`).

## Puesta en marcha

1. **GitHub Pages:** Settings → Pages → Source: *GitHub Actions*. Cada push a `main` que toque `web/` publica el sitio.
2. **Worker en Cloudflare** (gratis, hasta 100 mil consultas al día):
   - Crea una cuenta en Cloudflare y un API token con la plantilla *Edit Cloudflare Workers*.
   - En el repo, en Settings → Secrets and variables → Actions, agrega:
     - Secretos: `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`.
     - Variable: `ALLOWED_ORIGINS` = `https://<usuario>.github.io`.
   - Ejecuta el workflow *Publicar intermediario*. Te entrega una URL del tipo `https://predial-sii.<subdominio>.workers.dev`.
   - Agrega la variable `PREDIAL_API` con esa URL y vuelve a ejecutar *Publicar web*.

Sin el Worker, el mapa y los deslindes funcionan igual, pero la ficha avisa que falta el intermediario.

## Probar en local

```
python tools/servidor_local.py
# abrir http://localhost:8787/?api=http://localhost:8787
```

## Búsqueda por rol o dirección

El paso 03 acepta un rol (`1235-5`) o una dirección con número (`Espoz 5783`, `Apoquindo 3000 of 301`, `Diego de Velásquez 2071 depto 1001`). La dirección se busca con el buscador del propio SII (ruta `/direccion` del Worker). Si se indica la unidad (depto, oficina, local, bodega, box, casa, parcela, sitio, block), se llega al rol de esa unidad y no al del edificio. La ficha se arma con los datos del rol, no con el punto del mapa.

## Oferta en Portal Inmobiliario

El paso 04 de la consola abre la búsqueda en mapa de Portal Inmobiliario con el mismo recuadro que se ve en Predial (venta o arriendo, y tipo de propiedad). La ficha de cada predio tiene además un botón que abre el portal en 500 m alrededor. No se copia ningún aviso: solo se arma el enlace.

## Importar KML / KMZ / GeoJSON (desactivado)

`web/capa.js` importa un archivo, lo dibuja y busca los predios por muestreo. Está desactivado por ahora: para volver a activarlo, restaurar en `web/index.html` el paso de importación, la zona para soltar archivos y los scripts de JSZip, togeojson y `capa.js` (ver el commit 712f423).

## Enlaces compartibles

`#15160` abre Vitacura y `#15160/-33.387958/-70.580208` abre directamente la ficha del predio en ese punto.

## TGR

El certificado de deuda de contribuciones de la TGR tiene captcha. La web no lo automatiza: copia región, comuna y rol, y abre el trámite para que la persona lo complete. El nombre del propietario es un dato personal (Ley 21.719), por eso no se guarda ni se publica.

## Aviso

Sitio independiente, sin relación con el SII ni con la TGR. Los datos se muestran tal como los entrega el SII en el momento de la consulta.

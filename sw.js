/* ==========================================================================
   SW.JS — SERVICE WORKER: CACHE DELL'APP SHELL E SUPPORTO OFFLINE
   ==========================================================================
   Responsabilità minima e deliberata: questa non è un'applicazione con
   dati remoti o API di backend — è un'unica pagina statica con tutta la
   logica lato client — quindi il service worker si limita a due compiti:

     1) Precaricare in cache, all'installazione, tutti i file dell'app
        shell (HTML, CSS, JS, manifest, icone): da quel momento l'intera
        esperienza funziona anche offline o su reti lentissime, senza
        alcuna richiesta di rete per il contenuto statico.
     2) Servire ogni richiesta successiva "cache-first, poi rete": la
        cache risponde immediatamente (percepito come istantaneo), la
        rete viene comunque interrogata in parallelo per aggiornare la
        cache in background (stale-while-revalidate) — così un
        eventuale nuovo deploy viene comunque raccolto alla visita
        successiva, senza mai bloccare quella corrente in attesa della
        rete.

   Cosa NON fa, deliberatamente:
   - Nessuna gestione di richieste dinamiche/API: l'app non ne ha.
   - Nessun "background sync" o notifiche push: fuori scopo per un
     modulo didattico di poche schermate.
   - Non intercetta richieste non-GET (POST/PUT/...): l'app non ne
     effettua mai, ma un service worker "onesto" deve comunque
     dichiararlo esplicitamente piuttosto che assumerlo per omissione.

   VERSIONAMENTO DELLA CACHE
   --------------------------------------------------------------------
   CACHE_NAME include un numero di versione: incrementarlo a ogni
   deploy che modifica uno qualunque dei file elencati in
   APP_SHELL_FILES è l'UNICO modo per far sì che activate() elimini la
   cache precedente e forzi il ripopolamento — un service worker che
   riusasse sempre lo stesso nome di cache rischierebbe di servire
   indefinitamente versioni obsolete dei file a chi ha già installato
   l'app.
   ========================================================================== */

const CACHE_VERSION = 'v1';
const CACHE_NAME = `security-check-course-shell-${CACHE_VERSION}`;

/**
 * Percorsi relativi alla root del sito (coerenti con quelli già usati
 * in index.html: css/, js/, icons/). Elenco esaustivo e non generato
 * dinamicamente: un service worker deve sapere ESATTAMENTE cosa
 * precaricare, mai scoprirlo "al volo" scansionando il DOM (tecnica
 * fragile e non supportata da questa API).
 */
const APP_SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/variables.css',
  './css/base.css',
  './css/components.css',
  './css/screens.css',
  './css/animations.css',
  './js/main.js',
  './js/uiController.js',
  './js/scanEngine.js',
  './js/dashboardRenderer.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
];

// --------------------------------------------------------------------
// INSTALL — precarica l'intera app shell in una nuova cache versionata
// --------------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_FILES))
  );
  // Attiva il nuovo service worker subito dopo l'installazione, senza
  // attendere che tutte le tab con la versione precedente si chiudano:
  // per un'app di poche schermate aperta tipicamente in una sola tab
  // per volta, aspettare non porterebbe alcun beneficio reale e
  // ritarderebbe solo l'adozione degli aggiornamenti.
  self.skipWaiting();
});

// --------------------------------------------------------------------
// ACTIVATE — rimuove le cache di versioni precedenti (vedi banner sopra)
// --------------------------------------------------------------------

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => Promise.all(
      cacheNames
        .filter((name) => name !== CACHE_NAME)
        .map((staleName) => caches.delete(staleName))
    ))
  );
  self.clients.claim();
});

// --------------------------------------------------------------------
// FETCH — cache-first con aggiornamento in background (stale-while-revalidate)
// --------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  // Solo GET: vedi nota nel banner introduttivo. Qualunque altro
  // metodo passa direttamente alla rete, senza intervento di questo
  // service worker.
  if (event.request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cachedResponse = await cache.match(event.request);

      // La richiesta di rete parte SEMPRE (anche quando la cache ha già
      // risposto): è quel che rende questa una strategia
      // stale-while-revalidate e non un semplice "cache-first statico".
      // Eventuali errori di rete (offline, timeout) vengono qui
      // deliberatamente ignorati: se la cache aveva già una risposta
      // valida l'utente non deve percepire alcun problema; se non
      // l'aveva, l'errore si propaga naturalmente alla Promise
      // principale restituita da respondWith più sotto.
      const networkFetch = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            cache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
        })
        .catch(() => null);

      return cachedResponse || networkFetch;
    })
  );
});

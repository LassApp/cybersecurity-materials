/* ==========================================================================
   UICONTROLLER.JS — ORCHESTRAZIONE SCHERMATE, STATO HEADER, ANNUNCI A11Y
   ==========================================================================
   Primo modulo della fase JS. Espone le primitive di basso livello che
   scanEngine.js, dashboardRenderer.js e main.js useranno per far avanzare
   la simulazione, senza che nessuno di quei moduli debba mai toccare
   direttamente gli attributi [hidden] o le classi di stato dell'header:
   qui vive l'UNICA fonte di verità su "quale schermata è visibile ora" e
   su "come si passa da una schermata alla successiva".

   RESPONSABILITÀ DI QUESTO FILE
   --------------------------------------------------------------------
   1) showScreen()      — nasconde la schermata corrente e mostra quella
                           richiesta, con crossfade morbido; sposta il
                           focus per lo screen reader; aggiorna (in modo
                           opzionale, in un'unica chiamata) stato header
                           e live region.
   2) setHeaderStatus() — applica una delle 5 classi di stato già
                           definite in components.css (--neutral/-active/
                           -warning/-danger/-success) sia al pallino sia
                           al testo, sempre in coppia.
   3) announce()        — scrive un messaggio in #live-announcer per gli
                           screen reader, con il piccolo accorgimento
                           necessario a far annunciare anche messaggi
                           ripetuti identici al precedente.
   4) waitForAdvance()  — utility generica "avanza al click O dopo un
                           timeout", pensata per la schermata alert (vedi
                           il commento in index.html sopra
                           <section id="screen-alert">: "prosegue
                           automaticamente dopo una breve pausa, oppure
                           subito al click — vedi uiController.js").
                           Resta qui perché è meccanismo di UI generico,
                           non logica di punteggio: la decisione di QUALE
                           timeout usare e cosa succede dopo resta a
                           main.js, che la richiama.

   DECISIONE DI TECNICA — CROSSFADE FRA SCHERMATE VIA WEB ANIMATIONS API
   --------------------------------------------------------------------
   screens.css e animations.css avevano deliberatamente lasciato aperta
   questa decisione (il meccanismo [hidden] → display:none non è
   animabile in puro CSS; serve una classe transitoria coordinata da JS).
   La scelta qui è di NON introdurre alcuna classe CSS aggiuntiva, ma di
   animare opacità e una leggera traslazione verticale direttamente con
   la Web Animations API (element.animate()):
     - zero righe aggiuntive nei fogli di stile, già dichiarati completi;
     - i valori di durata/curva NON sono duplicati a mano in JS: vengono
       letti a runtime dai design token (--duration-moderate,
       --ease-standard) tramite getCssToken() qui sotto, così restano
       sincronizzati con variables.css anche se in futuro cambiassero;
     - prefers-reduced-motion è rispettato esplicitamente (vedi
       prefersReducedMotion()): sotto quella preferenza il cambio
       schermata è istantaneo, senza far comunque girare un'animazione
       "compressa" a 0.01ms come accadrebbe lasciando fare solo a
       variables.css (utile per le transition CSS "semplici", ma qui
       l'animazione è pilotata da JS e merita uno stop esplicito, non
       un collasso di durata).
   Ogni animazione viene sempre chiusa con animation.cancel() al termine
   (mai lasciata "finished" con fill:'both' attivo): altrimenti l'effetto
   dell'ultimo keyframe continuerebbe a sovrascrivere lo stile reale
   dell'elemento anche dopo la fine, producendo un elemento invisibile
   la prossima volta che si prova a mostrarlo.

   MODIFICA 6 LUGLIO 2026 — NUOVA SCHERMATA D'INGRESSO #screen-course
   --------------------------------------------------------------------
   Fino a questa versione, la schermata visibile di default nell'HTML
   statico era #screen-landing (nessun [hidden] su di essa, tutte le
   altre lo avevano) e showScreen() lo presupponeva tramite la variabile
   `currentScreenId` inizializzata a `null`: il primo showScreen()
   chiamato dall'app trattava il proprio target come "già in vista dal
   primo paint" (isInitialReveal), saltando sia il fade-out di una
   schermata precedente (che semplicemente non esisteva) sia il fade-in
   della prima schermata mostrata via JS.
   Ora la schermata visibile di default è #screen-course (il finto
   portale corso — vedi main.js e index.html), non più #screen-landing.
   `currentScreenId` viene quindi inizializzato direttamente a
   `'screen-course'`, non più a `null`: il primo showScreen() dell'app
   (verso 'screen-landing', dal click su "Apri il materiale") viene così
   trattato come una transizione NORMALE, con tanto di crossfade in
   uscita dal portale corso — un tocco di realismo in più, non un
   dettaglio trascurabile: è visivamente il momento in cui il finto
   documento "si apre" davvero.
   Il ramo `isInitialReveal` più sotto resta nel codice come guardia
   defensiva generica (rimane corretto se in futuro questo modulo venisse
   riusato con un'altra schermata staticamente visibile e nessuna
   inizializzazione esplicita), ma nel flusso attuale dell'app non si
   attiva mai: `currentScreenId` non è più `null` al primo utilizzo.

   MODIFICA 7 LUGLIO 2026 — HEADER NASCOSTO FINO ALLA LANDING
   --------------------------------------------------------------------
   #app-header nasce ora con l'attributo [hidden] (era sempre visibile
   fino a questa versione, comprese durante #screen-course — vedi il
   banner in index.html per il dettaglio narrativo del cambio).
   showScreen() lo rivela una tantum, con un fade-in dedicato
   (HEADER_REVEAL_KEYFRAMES, sezione 5), nel momento esatto della prima
   transizione reale della sequenza — non essendoci alcun percorso che
   torni a #screen-course, non serve alcuna logica di
   "ri-nascondimento" dell'header in seguito.
   ========================================================================== */

// --------------------------------------------------------------------
// 1. RIFERIMENTI DOM
// --------------------------------------------------------------------

const SCREEN_IDS = [
  'screen-course',
  'screen-landing',
  'screen-scan',
  'screen-alert',
  'screen-reveal',
  'screen-results',
];

/** Map<id, HTMLElement> — costruita una sola volta al caricamento del modulo. */
const screens = new Map(
  SCREEN_IDS.map((id) => [id, document.getElementById(id)])
);

// Verifica di integrità: un id mancante nell'HTML è un errore di markup,
// non un caso da gestire silenziosamente in produzione.
for (const [id, element] of screens) {
  if (!element) {
    console.error(`[uiController] elemento schermata non trovato: #${id}`);
  }
}

const appHeaderEl = document.getElementById('app-header');
const headerStatusDot = document.getElementById('header-status-dot');
const headerStatusText = document.getElementById('header-status-text');
const liveAnnouncer = document.getElementById('live-announcer');

if (!appHeaderEl) {
  console.error('[uiController] elemento header non trovato: #app-header');
}

const STATUS_STATES = ['neutral', 'active', 'warning', 'danger', 'success'];

/**
 * Id della schermata attualmente visibile. Inizializzato a
 * 'screen-course' (non più a null): è quella la schermata priva di
 * [hidden] nell'HTML statico, quindi già effettivamente in vista dal
 * primissimo paint della pagina — vedi il changelog nel banner
 * introduttivo per il perché questo valore iniziale è cambiato.
 */
let currentScreenId = 'screen-course';

// --------------------------------------------------------------------
// 2. UTILITY — LETTURA DEI DESIGN TOKEN A RUNTIME
// --------------------------------------------------------------------

/**
 * Legge il valore grezzo (stringa) di una custom property da :root.
 * @param {string} tokenName - es. '--duration-moderate'
 * @param {string} fallback - usato solo se il token non è definito
 */
function getCssToken(tokenName, fallback) {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(tokenName)
    .trim();
  return value || fallback;
}

/** Converte un token di durata (es. "320ms") in un numero di millisecondi. */
function getDurationMs(tokenName, fallbackMs) {
  const parsed = parseFloat(getCssToken(tokenName, `${fallbackMs}ms`));
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// --------------------------------------------------------------------
// 3. LIVE REGION (ANNUNCI PER SCREEN READER)
// --------------------------------------------------------------------

/**
 * Scrive un messaggio in #live-announcer (role="status", aria-live="polite").
 * Svuota il contenuto e lo riscrive al frame successivo: senza questo
 * accorgimento, annunciare due volte di fila lo stesso testo non
 * produrrebbe un secondo annuncio in molti screen reader, perché il nodo
 * di testo non risulta "cambiato".
 */
function announce(message) {
  if (!liveAnnouncer || !message) return;
  liveAnnouncer.textContent = '';
  window.requestAnimationFrame(() => {
    liveAnnouncer.textContent = message;
  });
}

// --------------------------------------------------------------------
// 4. STATO DELL'HEADER (.status-dot / .status-text)
// --------------------------------------------------------------------

/**
 * Applica uno dei 5 stati definiti in components.css a #header-status-dot
 * e #header-status-text, sempre in coppia (mai uno solo dei due), come
 * richiesto dal commento di components.css su questo componente.
 * @param {'neutral'|'active'|'warning'|'danger'|'success'} state
 * @param {string} label - testo visibile, es. "Analyzing device…"
 */
function setHeaderStatus(state, label) {
  if (!STATUS_STATES.includes(state)) {
    console.warn(`[uiController] stato header non valido: "${state}"`);
    return;
  }
  if (headerStatusDot) {
    headerStatusDot.className = `status-dot status-dot--${state}`;
  }
  if (headerStatusText) {
    headerStatusText.className = `status-text status-text--${state}`;
    if (typeof label === 'string') {
      headerStatusText.textContent = label;
    }
  }
}

// --------------------------------------------------------------------
// 5. CROSSFADE FRA SCHERMATE
// --------------------------------------------------------------------

const FADE_OUT_KEYFRAMES = [
  { opacity: 1, transform: 'translateY(0)' },
  { opacity: 0, transform: 'translateY(-8px)' },
];

const FADE_IN_KEYFRAMES = [
  { opacity: 0, transform: 'translateY(8px)' },
  { opacity: 1, transform: 'translateY(0)' },
];

/*
  MODIFICA 7 luglio 2026 — RIVELAZIONE DELL'HEADER
  ......................................................................
  #app-header nasce con l'attributo [hidden] nel markup statico (vedi
  il banner sopra la sezione header in index.html per il perché):
  fino alla primissima transizione reale della sequenza, l'header non
  deve mostrare alcun indizio del brand "Security Check". showScreen()
  lo rivela con questo fade-in dedicato, separato da FADE_IN_KEYFRAMES
  perché la direzione del movimento è opposta (l'header "scende" dalla
  cima dello schermo, una schermata "sale" da sotto): stessa tecnica,
  significante coerente con la posizione reale dell'elemento.
*/
const HEADER_REVEAL_KEYFRAMES = [
  { opacity: 0, transform: 'translateY(-8px)' },
  { opacity: 1, transform: 'translateY(0)' },
];

/**
 * Anima un elemento con la Web Animations API e risolve la Promise quando
 * l'animazione termina, avendo prima rilasciato il suo effetto
 * (animation.cancel()) per non lasciare stili "fantasma" sull'elemento.
 */
function animateElement(element, keyframes, durationMs, easing) {
  return new Promise((resolve) => {
    if (typeof element.animate !== 'function') {
      // Fallback per ambienti privi di supporto WAAPI: nessuna animazione,
      // si passa comunque allo stato finale in modo istantaneo.
      resolve();
      return;
    }
    const animation = element.animate(keyframes, {
      duration: durationMs,
      easing,
      fill: 'both',
    });
    const settle = () => {
      animation.cancel();
      resolve();
    };
    animation.addEventListener('finish', settle);
    animation.addEventListener('cancel', () => resolve());
  });
}

/**
 * Mostra la schermata `targetId`, nascondendo quella corrente (se
 * presente) con un crossfade morbido. Opzionalmente aggiorna in un'unica
 * chiamata anche lo stato dell'header e la live region, per evitare che
 * chi orchestra la sequenza (main.js) debba fare tre chiamate separate
 * ogni volta che cambia schermata.
 *
 * @param {string} targetId - uno degli id in SCREEN_IDS
 * @param {object} [options]
 * @param {'neutral'|'active'|'warning'|'danger'|'success'} [options.statusState]
 * @param {string} [options.statusLabel]
 * @param {string} [options.announceText]
 * @returns {Promise<void>} risolta a transizione completata
 */
async function showScreen(targetId, options = {}) {
  const targetScreen = screens.get(targetId);
  if (!targetScreen) {
    console.error(`[uiController] impossibile mostrare schermata sconosciuta: "${targetId}"`);
    return;
  }
  if (targetId === currentScreenId) {
    // Nessun cambio di schermata: aggiorna comunque stato/annuncio se richiesti,
    // così una chiamata "ridondante" resta comunque utile per aggiornare l'header.
    if (options.statusState) setHeaderStatus(options.statusState, options.statusLabel);
    if (options.announceText) announce(options.announceText);
    return;
  }

  // NOTA (6 luglio 2026): con currentScreenId inizializzato a
  // 'screen-course' (non più a null — vedi banner introduttivo),
  // isInitialReveal non si verifica mai nel flusso reale dell'app: resta
  // qui solo come guardia defensiva generica, vedi changelog sopra.
  const isInitialReveal = currentScreenId === null;
  const previousScreen = isInitialReveal ? null : screens.get(currentScreenId);
  const reducedMotion = prefersReducedMotion();

  const fadeDurationMs = getDurationMs('--duration-moderate', 320);
  const easing = getCssToken('--ease-standard', 'cubic-bezier(0.4, 0, 0.2, 1)');

  // Rivelazione dell'header (una tantum): se è ancora nascosto — cioè
  // siamo alla primissima transizione reale della sequenza, in uscita
  // da #screen-course — lo si mostra qui, con un fade-in che si
  // sovrappone DELIBERATAMENTE al crossfade della schermata qui sotto
  // (nessun await sulla sua Promise): i due movimenti devono leggersi
  // come un solo istante di rivelazione, non come due passaggi in
  // sequenza. Non essendoci alcun percorso che torni a #screen-course,
  // questo blocco non si attiva mai una seconda volta nella stessa
  // sessione.
  // Rivelazione dell'header (una tantum): legata specificamente
  // all'ingresso in #screen-reveal, non più alla prima transizione in
  // assoluto (course→landing). È quello il momento narrativo in cui il
  // vero brand "Security Check" può comparire, perché coincide con la
  // rivelazione esplicita "è stata una simulazione". Mostrarlo prima
  // tradiva l'inganno con troppo anticipo: lo studente vedeva il logo
  // blu (rassicurante) nell'header mentre la schermata centrale
  // mostrava ancora lo scudo ambra "di allerta" — due segnali di brand
  // disallineati nello stesso istante, uno tranquillizzante e uno no.
  if (appHeaderEl && appHeaderEl.hidden && targetId === 'screen-reveal') {
    appHeaderEl.hidden = false;
    if (!reducedMotion) {
      animateElement(appHeaderEl, HEADER_REVEAL_KEYFRAMES, fadeDurationMs, easing);
    }
  }

  // Uscita della schermata precedente (se esiste). Alla prima chiamata in
  // assoluto (isInitialReveal) non c'è nulla da nascondere: la schermata
  // statica di default è già visibile, senza bisogno di animarla.
  if (previousScreen && !reducedMotion) {
    await animateElement(previousScreen, FADE_OUT_KEYFRAMES, fadeDurationMs, easing);
  }
  if (previousScreen) {
    previousScreen.hidden = true;
  }

  targetScreen.hidden = false;

  // Anche qui: se è la primissima rivelazione, la schermata è già quella
  // visibile a schermo (nessun [hidden] da rimuovere in pratica) — animare
  // comunque un fade-in produrrebbe un flash indesiderato (opacity da 0 a 1
  // su un elemento che l'utente sta già vedendo dal primo paint).
  if (!reducedMotion && !isInitialReveal) {
    await animateElement(targetScreen, FADE_IN_KEYFRAMES, fadeDurationMs, easing);
  }

  currentScreenId = targetId;

  // Sposta il focus sulla schermata (tabindex="-1" in HTML): permette agli
  // screen reader di annunciare il titolo via aria-labelledby, senza
  // inserire la schermata nell'ordine di tabulazione da tastiera.
  targetScreen.focus({ preventScroll: false });

  if (options.statusState) {
    setHeaderStatus(options.statusState, options.statusLabel);
  }
  if (options.announceText) {
    announce(options.announceText);
  }
}

/** @returns {string|null} l'id della schermata attualmente visibile. */
function getCurrentScreenId() {
  return currentScreenId;
}

// --------------------------------------------------------------------
// 6. AVANZAMENTO "AL CLICK O DOPO UN TIMEOUT"
// --------------------------------------------------------------------

/**
 * Risolve la Promise alla prima delle tre condizioni: un click ovunque
 * dentro `screenElement`, la pressione di Invio/Spazio mentre
 * `screenElement` ha il focus, oppure lo scadere di `timeoutMs`. Usata
 * dalla schermata alert (vedi il commento "Click anywhere to continue" /
 * "#alert-hint" in index.html), ma scritta in modo generico: qualunque
 * futura schermata con lo stesso pattern può riusarla senza duplicarne
 * la logica di cleanup dei listener.
 *
 * NOTA DI ACCESSIBILITÀ (aggiunta in fase di QA): la sola gestione del
 * click lasciava chi naviga da tastiera senza un modo per far avanzare
 * subito la schermata — non un blocco totale (il timeout garantisce
 * comunque l'avanzamento automatico), ma un'assenza reale di un
 * equivalente da tastiera per un'azione disponibile al mouse (WCAG
 * 2.1.1). `screenElement` riceve già il focus programmatico da
 * showScreen() subito prima di chiamare questa funzione (tabindex="-1"
 * + .focus() in uiController.js): un keydown su Invio/Spazio mentre è
 * l'elemento attivo replica lo stesso comportamento che un <button>
 * nativo offrirebbe gratis, senza alterare l'ordine di tabulazione né
 * il markup HTML esistente.
 *
 * @param {HTMLElement} screenElement
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
function waitForAdvance(screenElement, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timerId;

    const finish = () => {
      if (settled) return;
      settled = true;
      screenElement.removeEventListener('click', onClick);
      screenElement.removeEventListener('keydown', onKeydown);
      clearTimeout(timerId);
      resolve();
    };

    const onClick = () => finish();

    // preventDefault su Spazio: evita che il browser interpreti la
    // pressione come uno scroll della pagina (comportamento di default
    // quando il focus è su un elemento non nativamente interattivo).
    const onKeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        finish();
      }
    };

    screenElement.addEventListener('click', onClick);
    screenElement.addEventListener('keydown', onKeydown);
    timerId = setTimeout(finish, timeoutMs);
  });
}

// --------------------------------------------------------------------
// 7. ESPORTAZIONI
// --------------------------------------------------------------------

export {
  showScreen,
  setHeaderStatus,
  announce,
  waitForAdvance,
  getCurrentScreenId,
};

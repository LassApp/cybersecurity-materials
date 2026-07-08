/* ==========================================================================
   MAIN.JS — ENTRY POINT, ORCHESTRAZIONE DELL'INTERA SEQUENZA APPLICATIVA
   ==========================================================================
   Unico modulo importato direttamente da index.html
   (<script type="module" src="js/main.js">). Non contiene logica propria
   di rendering o di calcolo — quella vive già nei tre moduli precedenti —
   ma decide QUANDO ciascun pezzo entra in scena e CON QUALE stato
   dell'header/annuncio per lo screen reader, cioè la sequenza narrativa
   completa:

     course --(click "Apri il materiale")--> landing --(timer)--> scan
       --(runScan)--> alert --(click|timeout)--> reveal --(5s min. +
       click)--> results --(click)--> fine lezione

   MODIFICA 6 LUGLIO 2026 — NUOVO PUNTO D'INGRESSO UNIVERSALE
   --------------------------------------------------------------------
   Fino a questa versione la sequenza partiva automaticamente al
   caricamento della pagina (init() chiamava subito runLandingPhase()).
   Ora la primissima schermata visibile è #screen-course — un finto
   "portale corso" che si presenta come una normale pagina di accesso a
   un documento didattico (vedi la sezione dedicata in index.html) — e
   la sequenza automatica landing → scan → alert parte SOLO dopo il
   click su "Apri il materiale" (#btn-open-course-material).
   Questo è oggi l'UNICO punto d'ingresso dell'app: che lo studente apra
   l'URL direttamente o lo raggiunga scansionando un QR code stampato sul
   materiale del corso, l'esperienza è IDENTICA in entrambi i casi — per
   scelta esplicita, non per semplificazione tecnica. Non esiste alcuna
   logica di branching basata su parametri d'URL o referrer: il finto
   portale corso è semplicemente ciò che l'app mostra sempre per prima,
   indipendentemente da come si è arrivati a quell'URL. È il volantino
   fisico/QR stampato a fornire il pretesto ("materiale del corso"), non
   il codice a doverlo riconoscere.

   MODIFICA 7 LUGLIO 2026 — LETTURA MINIMA FORZATA SUL REVEAL
   --------------------------------------------------------------------
   Il passaggio reveal → results non è più un click libero in qualsiasi
   istante: lockContinueButtonForReading() (sezione 7) disabilita
   #btn-see-results per REVEAL_MIN_READ_MS (5 secondi fissi) subito dopo
   la comparsa del reveal, mostrando un conto alla rovescia testuale.
   Obiettivo puramente didattico: il testo del reveal è la rivelazione
   della simulazione stessa, probabilmente il momento più importante
   dell'intera lezione — merita un tempo minimo di lettura garantito,
   non un click riflesso.
   ========================================================================== */

import { showScreen, setHeaderStatus, announce, waitForAdvance } from './uiController.js';
import { runScan } from './scanEngine.js';
import {
  collectDeviceData,
  renderAlertFindings,
  renderResultsDashboard,
} from './dashboardRenderer.js';

// --------------------------------------------------------------------
// 1. RIFERIMENTI DOM
// --------------------------------------------------------------------

const btnOpenCourseMaterial = document.getElementById('btn-open-course-material');
const screenAlertEl = document.getElementById('screen-alert');
const btnSeeResults = document.getElementById('btn-see-results');
const btnContinueLesson = document.getElementById('btn-continue-lesson');
const ctaSectionEl = document.querySelector('.cta-section');
const revealWaitHintEl = document.getElementById('reveal-wait-hint');
const revealWaitCountdownEl = document.getElementById('reveal-wait-countdown');

for (const [name, el] of Object.entries({
  btnOpenCourseMaterial,
  screenAlertEl,
  btnSeeResults,
  btnContinueLesson,
  ctaSectionEl,
  revealWaitHintEl,
  revealWaitCountdownEl,
})) {
  if (!el) {
    console.error(`[main] elemento non trovato in pagina: ${name}`);
  }
}

// --------------------------------------------------------------------
// 2. UTILITY LOCALI
// --------------------------------------------------------------------
// prefersReducedMotion non è fra le esportazioni di uiController.js/
// scanEngine.js (tenuta privata in entrambi di proposito): ogni modulo
// che ne ha bisogno se ne ridichiara una copia minima locale, stessa
// scelta già motivata nel banner introduttivo di scanEngine.js.

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Promise che si risolve dopo `ms` millisecondi. */
function wait(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --------------------------------------------------------------------
// 3. COSTANTI DI SEQUENZA
// --------------------------------------------------------------------

/**
 * Durata dello splash di landing in condizioni normali: abbastanza
 * lunga da leggere il brand e percepire un "avvio" reale del motore di
 * sicurezza (coerente col testo "Initializing security engine…"), ma
 * senza risultare un'attesa fastidiosa.
 */
const LANDING_DURATION_MS = 2200;

/**
 * Sotto prefers-reduced-motion lo splash resta comunque percepibile
 * (non è un'animazione da sopprimere, è un tempo di lettura) ma si
 * riduce: chi ha richiesto meno movimento nel sistema difficilmente
 * vuole anche attendere secondi extra di puro branding.
 */
const LANDING_DURATION_REDUCED_MS = 700;

/**
 * Timeout massimo di permanenza sulla schermata alert prima di passare
 * automaticamente al reveal, se l'utente non clicca prima. Abbastanza
 * lungo da permettere la lettura del gauge e delle findings sintetiche,
 * coerente con l'hint testuale "Click anywhere to continue" (che resta
 * comunque la via più rapida).
 */
const ALERT_AUTO_ADVANCE_MS = 6000;

/**
 * Tempo minimo (ms) durante il quale #btn-see-results resta disabilitato
 * dopo la comparsa della schermata reveal (vedi lockContinueButtonForReading
 * più sotto). Il testo di quella schermata — la rivelazione della
 * simulazione e il perché conta per la sicurezza dello studente — è
 * probabilmente il messaggio più importante di tutta la lezione dal
 * punto di vista didattico: un click riflesso troppo rapido per essere
 * stato davvero letto ne vanificherebbe lo scopo. Valore fisso,
 * DELIBERATAMENTE indipendente da prefers-reduced-motion: non è
 * un'animazione comprimibile, è un tempo minimo di lettura — le due
 * preferenze rispondono a esigenze di accessibilità diverse (motion
 * sensitivity la prima, comprensione del contenuto la seconda), e
 * comprimerlo per chi ha richiesto meno movimento non avrebbe alcuna
 * reale giustificazione di accessibilità.
 */
const REVEAL_MIN_READ_MS = 5000;

// --------------------------------------------------------------------
// 4. STATO CONDIVISO FRA LE FASI
// --------------------------------------------------------------------

/**
 * Dati reali del dispositivo, raccolti UNA SOLA VOLTA subito dopo la
 * fine della scansione simulata e riusati sia per la schermata alert
 * sia per la schermata risultati — mai riletti una seconda volta (vedi
 * banner introduttivo e nota in dashboardRenderer.js).
 * @type {object|null}
 */
let deviceData = null;

// --------------------------------------------------------------------
// 5. FASE 0 — PORTALE CORSO → LANDING (click su "Apri il materiale")
// --------------------------------------------------------------------

/**
 * Gestore del click su "Apri il materiale" (#btn-open-course-material):
 * è questo il vero innesco dell'intera sequenza automatica, non più il
 * semplice caricamento della pagina (vedi changelog nel banner
 * introduttivo). Disabilita il bottone per primissima cosa — un secondo
 * click durante la transizione non deve poter avviare due sequenze in
 * parallelo — poi mostra la landing con un crossfade dal portale corso
 * (il momento in cui il finto documento "si apre" davvero) ed esegue,
 * in ordine, tutte le fasi successive fino all'ingresso in
 * #screen-alert.
 * @returns {Promise<void>}
 */
async function handleOpenCourseMaterialClick() {
  if (btnOpenCourseMaterial) {
    btnOpenCourseMaterial.disabled = true;
  }

  await showScreen('screen-landing', {
    statusState: 'neutral',
    statusLabel: 'Initializing…',
    announceText: 'Opening course material…',
  });

  await runLandingPhase();
  await runScanPhase();
  await runAlertPhase();
}

/**
 * Attende il tempo di splash della landing (già mostrata da
 * handleOpenCourseMaterialClick subito prima di chiamare questa
 * funzione) e poi avvia la sequenza di scansione.
 * @returns {Promise<void>}
 */
async function runLandingPhase() {
  const durationMs = prefersReducedMotion()
    ? LANDING_DURATION_REDUCED_MS
    : LANDING_DURATION_MS;
  await wait(durationMs);

  await showScreen('screen-scan', {
    statusState: 'active',
    statusLabel: 'Analyzing device…',
    announceText: 'Starting security diagnostics.',
  });
}

// --------------------------------------------------------------------
// 6. FASE 2 — SCAN → ALERT (+ raccolta dati e findings sintetiche)
// --------------------------------------------------------------------

/**
 * Esegue la scansione simulata (che si occupa da sola di navigare
 * verso #screen-alert e animare il proprio gauge) e, alla sua
 * risoluzione, raccoglie i dati reali del dispositivo popolando subito
 * la lista sintetica dei rischi — senza questa chiamata immediata
 * l'utente vedrebbe momentaneamente #alert-findings vuoto, come già
 * segnalato nel banner introduttivo di scanEngine.js.
 * @returns {Promise<void>}
 */
async function runScanPhase() {
  await runScan();

  // Prima e unica lettura dei dati reali del dispositivo: da qui in
  // avanti ogni schermata successiva riusa `deviceData`, mai una nuova
  // chiamata a collectDeviceData().
  deviceData = collectDeviceData();
  renderAlertFindings(deviceData);
}

// --------------------------------------------------------------------
// 7. FASE 3 — ALERT → REVEAL (click sulla schermata o timeout)
// --------------------------------------------------------------------

/**
 * Disabilita #btn-see-results per REVEAL_MIN_READ_MS a partire dal
 * momento in cui la schermata reveal diventa visibile, mostrando un
 * conto alla rovescia testuale in #reveal-wait-hint. Il conto alla
 * rovescia NON usa aria-live: un aggiornamento al secondo — pur non
 * "ad alta frequenza" come il count-up dei data point in
 * scanEngine.js — resta comunque un dettaglio che uno screen reader
 * non deve annunciare tick per tick (stessa convenzione già stabilita
 * in animations.css). L'unico annuncio è la singola chiamata ad
 * announce() qui sotto, quando il bottone torna disponibile.
 * @returns {void}
 */
function lockContinueButtonForReading() {
  if (!btnSeeResults) return;

  btnSeeResults.disabled = true;
  if (revealWaitHintEl) revealWaitHintEl.hidden = false;

  let remainingSeconds = Math.ceil(REVEAL_MIN_READ_MS / 1000);

  const updateCountdownText = () => {
    if (!revealWaitCountdownEl) return;
    revealWaitCountdownEl.textContent = remainingSeconds === 1
      ? '1 secondo'
      : `${remainingSeconds} secondi`;
  };
  updateCountdownText();

  const intervalId = setInterval(() => {
    remainingSeconds -= 1;

    if (remainingSeconds <= 0) {
      clearInterval(intervalId);
      btnSeeResults.disabled = false;
      if (revealWaitHintEl) revealWaitHintEl.hidden = true;
      announce('You can now continue to your full report.');
      return;
    }

    updateCountdownText();
  }, 1000);
}

/**
 * Attende che l'utente clicchi in un punto qualunque della schermata
 * alert, oppure che scada il timeout automatico — la prima delle due
 * condizioni vince (comportamento già descritto in index.html e già
 * implementato come utility generica in uiController.js). Al termine,
 * transita verso il reveal e avvia la lettura minima forzata del
 * bottone di continuazione (vedi lockContinueButtonForReading sopra).
 * @returns {Promise<void>}
 */
async function runAlertPhase() {
  if (!screenAlertEl) return;

  await waitForAdvance(screenAlertEl, ALERT_AUTO_ADVANCE_MS);

  await showScreen('screen-reveal', {
    statusState: 'neutral',
    statusLabel: 'Simulation complete',
    announceText: 'This was a training simulation. No data was collected.',
  });

  lockContinueButtonForReading();
}

// --------------------------------------------------------------------
// 8. FASE 4 — REVEAL → RESULTS (click su #btn-see-results)
// --------------------------------------------------------------------

/**
 * Gestore del click su "Vedi il report completo": popola la dashboard
 * reale (card + lista completa + placeholder inline) riusando i dati
 * già raccolti in fase 2, poi mostra la schermata risultati con stato
 * header "success" (verifica conclusa, esito stabile — coerente con la
 * semantica non pulsante di .status-dot--success già documentata in
 * components.css).
 * @returns {Promise<void>}
 */
async function handleSeeResultsClick() {
  if (!deviceData) {
    // Non dovrebbe mai accadere nel flusso normale (il bottone diventa
    // visibile solo dopo runScanPhase), ma un fallback esplicito evita
    // un report vuoto in caso di sequenza anomala (es. test manuale
    // della schermata isolata).
    console.error('[main] dati del dispositivo non ancora raccolti: report non generabile.');
    deviceData = collectDeviceData();
  }

  renderResultsDashboard(deviceData);

  await showScreen('screen-results', {
    statusState: 'success',
    statusLabel: 'Report generated',
    announceText: 'Full security report ready.',
  });
}

// --------------------------------------------------------------------
// 9. FASE 5 — CHIUSURA LEZIONE (click su #btn-continue-lesson)
// --------------------------------------------------------------------

/**
 * Gestore del click su "Continua la lezione": non esiste una schermata
 * successiva nel progetto (6 schermate totali, già tutte attraversate),
 * quindi l'esito credibile e definitivo è chiudere il modulo qui,
 * sostituendo la sola CTA con una conferma di completamento — mai un
 * semplice "TODO" o un alert() invasivo, che romperebbero il registro
 * professionale mantenuto in tutta l'app. Il bottone viene disattivato
 * per impedire riattivazioni accidentali della stessa conferma.
 */
function handleContinueLessonClick() {
  if (!ctaSectionEl || !btnContinueLesson) return;

  btnContinueLesson.disabled = true;

  // Sostituisce il contenuto della sola sezione CTA (non l'intera
  // schermata risultati, che resta consultabile: dashboard e findings
  // restano visibili sopra, l'utente può ancora rileggerli in
  // qualunque momento) con un messaggio di chiusura in linea con il
  // tono didattico e rassicurante già stabilito nel reveal. Costruito
  // via DOM API (mai innerHTML con stringhe interpolate) per restare
  // coerente con la convenzione "testo dinamico sempre via textContent"
  // già seguita in dashboardRenderer.js.
  ctaSectionEl.innerHTML = '';

  const completionIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  completionIcon.setAttribute('class', 'icon icon--reveal');
  completionIcon.setAttribute('aria-hidden', 'true');
  completionIcon.setAttribute('focusable', 'false');
  completionIcon.style.marginInline = 'auto';
  const useEl = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  useEl.setAttribute('href', '#icon-check-circle');
  completionIcon.appendChild(useEl);

  const completionTitle = document.createElement('h3');
  completionTitle.textContent = 'Modulo completato';
  completionTitle.style.marginTop = 'var(--space-4)';

  const completionText = document.createElement('p');
  completionText.textContent = 'Hai completato la simulazione di cybersecurity awareness. Ricorda i punti chiave: mantieni aggiornati i tuoi dispositivi, diffida di QR code e messaggi non richiesti, e limita le informazioni che condividi online.';
  completionText.style.marginTop = 'var(--space-3)';
  completionText.style.color = 'var(--color-text-secondary)';
  completionText.style.lineHeight = 'var(--leading-relaxed)';
  completionText.style.maxWidth = 'var(--container-default)';
  completionText.style.marginInline = 'auto';

  ctaSectionEl.appendChild(completionIcon);
  ctaSectionEl.appendChild(completionTitle);
  ctaSectionEl.appendChild(completionText);

  setHeaderStatus('success', 'Module completed');
  announce('Training module completed. Thank you for taking part.');
}

// --------------------------------------------------------------------
// 10. INIZIALIZZAZIONE
// --------------------------------------------------------------------

/**
 * Collega i gestori di evento delle tre CTA manuali dell'app — il click
 * su "Apri il materiale" (che ora è il VERO innesco dell'intera
 * sequenza, non più il semplice caricamento della pagina — vedi
 * changelog nel banner introduttivo) e le due CTA indipendenti dal
 * timing della sequenza automatica (possono scattare in qualunque
 * momento le rispettive schermate diventino visibili).
 * Nessuna sequenza viene avviata automaticamente qui: #screen-course è
 * già la schermata visibile di default nell'HTML statico, e resta così
 * finché lo studente non clicca "Apri il materiale" di sua iniziativa —
 * esattamente il comportamento di un vero portale di download.
 * @returns {void}
 */
function init() {
  if (btnOpenCourseMaterial) {
    btnOpenCourseMaterial.addEventListener('click', handleOpenCourseMaterialClick);
  }
  if (btnSeeResults) {
    btnSeeResults.addEventListener('click', handleSeeResultsClick);
  }
  if (btnContinueLesson) {
    btnContinueLesson.addEventListener('click', handleContinueLessonClick);
  }
}

init();

/* ==========================================================================
   SCANENGINE.JS — MOTORE DELLA SCHERMATA DI SCANSIONE (#screen-scan)
   ==========================================================================
   Secondo modulo della fase JS, costruito sopra le primitive esposte da
   uiController.js (showScreen, setHeaderStatus, announce). Di competenza
   di questo file:

     1) generare dinamicamente gli <li class="scan-step"> dentro
        #scan-steps, tutti inseriti in un solo colpo con lo stagger via
        custom property --step-index già predisposto in animations.css
        (.scan-step--appear) — NON una creazione sequenziale nel tempo,
        che romperebbe l'effetto di comparsa "a cascata" già disegnato lì;
     2) far avanzare quegli step nei loro 3 stati (pending → active →
        done, classi già definite in screens.css), aggiornare in parallelo
        la barra di avanzamento (#scan-progress-fill/-percentage), il
        testo di stato (#scan-status) e il contatore "data points
        analyzed" (#scan-metric-count);
     3) gestire #scan-skip-btn ("Salta al risultato"): non un semplice
        salto istantaneo, ma un passaggio a un ritmo accelerato degli step
        rimanenti, per non perdere la percezione che una sequenza di
        controlli sia comunque avvenuta;
     4) calcolare il punteggio di rischio finale e orchestrare la
        transizione automatica verso #screen-alert (via showScreen di
        uiController.js), incluso il riempimento animato del gauge
        circolare e del suo valore numerico.

   COSA QUESTO MODULO NON FA (per progettazione, non per dimenticanza)
   --------------------------------------------------------------------
   - Non tocca #alert-findings: quella lista dipende da DATI REALI del
     browser (non dal punteggio, che è simulato), quindi resta di
     competenza esclusiva di dashboardRenderer.js. main.js dovrà invocare
     dashboardRenderer subito dopo la risoluzione di runScan(), prima che
     l'utente faccia caso a una lista vuota nella schermata alert.
   - Non mostra #screen-scan: si presuppone che main.js l'abbia già
     mostrata (showScreen('screen-scan', ...)) PRIMA di chiamare
     runScan(). Questo modulo entra in scena a schermata già visibile e
     ne esce da solo, chiamando showScreen verso 'screen-alert' al
     termine — è lui il proprietario dell'intero ciclo di vita della
     scansione, dall'inizio alla transizione in uscita.

   DUPLICAZIONE DELIBERATA DI DUE UTILITY DI uiController.js
   --------------------------------------------------------------------
   getCssToken/getDurationMs/prefersReducedMotion non sono fra le
   esportazioni di uiController.js (quel file le tiene private). Anziché
   allargarne la superficie pubblica per un consumo cross-modulo non
   previsto in origine, questo file ne ridichiara una propria copia
   minima: sono 8 righe innocue, la duplicazione qui costa meno del
   couplaggio implicito che creerebbe importarle da un modulo pensato
   per restare "generico e riusabile" a sé stante.

   CHANGELOG — AUDIT DI ACCESSIBILITÀ DEL 6 LUGLIO 2026
   --------------------------------------------------------------------
   Due correzioni puntuali rispetto alla versione precedente, entrambe
   circoscritte alla sezione 6 (gauge) e ai punti in cui viene invocata:
     a) animateNumber() ora accetta un quinto parametro opzionale
        `suffix` (default stringa vuota): senza di esso, il conteggio
        del gauge di rischio terminava mostrando un numero nudo ("82")
        invece di "82%" — un difetto funzionale reale, non solo
        estetico, dato che l'unità di misura andava persa proprio nel
        componente più "clou" della simulazione. La chiamata per
        #scan-metric-count resta invariata (nessun suffisso: quel
        contatore non è mai stato una percentuale).
     b) animateGaugeTo() ora aggiorna anche l'aria-label di
        #alert-gauge (impostato come role="img" in index.html): l'SVG
        e il valore numerico sono entrambi aria-hidden per costruzione
        (sono ridondanti fra loro e, da soli, privi di contesto per chi
        usa uno screen reader), quindi l'unica via per rendere il
        punteggio realmente accessibile è esporlo come frase coerente
        su un contenitore comune.

   CHANGELOG — RITMO DELLA RIVELAZIONE DEL RISCHIO, 8 LUGLIO 2026
   --------------------------------------------------------------------
   Due correzioni di ritmo narrativo, decise dopo un primo giro di test
   dell'esperienza completa:
     a) Introdotta SCAN_COMPLETE_PAUSE_MS (sezione 2): la pausa fra il
        100% della barra di avanzamento e la navigazione verso
        #screen-alert è passata da 400ms a 2000ms, per dare al momento
        di passaggio — probabilmente il più teso dell'intera sequenza —
        un vero respiro percettivo invece di un salto quasi immediato.
        Resta 0 in modalità skip/reduced-motion, coerente con ogni
        altro tempo di attesa di questo modulo.
     b) computeRiskScore() (sezione 6) ora restituisce sempre un valore
        sopra DANGER_THRESHOLD (range 89–97, era 68–96): il gauge deve
        comparire SEMPRE nella variante rossa "danger", mai in quella
        ambra "warning" — vedi il commento aggiornato su
        DANGER_THRESHOLD per il dettaglio del cambio di intento.
   ========================================================================== */

import { showScreen } from './uiController.js';

// --------------------------------------------------------------------
// 1. RIFERIMENTI DOM
// --------------------------------------------------------------------

const scanStepsContainer = document.getElementById('scan-steps');
const progressFillEl = document.getElementById('scan-progress-fill');
const progressPercentageEl = document.getElementById('scan-progress-percentage');
const scanStatusEl = document.getElementById('scan-status');
const metricCountEl = document.getElementById('scan-metric-count');
const skipBtn = document.getElementById('scan-skip-btn');

const alertGaugeContainer = document.querySelector('.alert-gauge');
const alertGaugeFillEl = document.getElementById('alert-gauge-fill');
const alertGaugeValueEl = document.getElementById('alert-gauge-value');

for (const [name, el] of Object.entries({
  scanStepsContainer,
  progressFillEl,
  progressPercentageEl,
  scanStatusEl,
  metricCountEl,
  alertGaugeContainer,
  alertGaugeFillEl,
  alertGaugeValueEl,
})) {
  if (!el) {
    console.error(`[scanEngine] elemento non trovato in pagina: ${name}`);
  }
}
// skipBtn non è verificato con la stessa severità: è funzionalmente
// opzionale (il modulo degrada bene alla sua assenza, vedi sezione 4).

// --------------------------------------------------------------------
// 2. DATI DELLA SIMULAZIONE — STEP DI SCANSIONE
// --------------------------------------------------------------------

/**
 * Elenco statico degli step mostrati durante la scansione. Ogni voce:
 *   - label: testo mostrato in #scan-status e nel .scan-step__label
 *     mentre lo step è attivo/completato;
 *   - durationMs: quanto resta "active" questo step in modalità normale
 *     (varia leggermente da step a step per un ritmo meno meccanico:
 *     il controllo di rete dura volutamente di più degli altri, dà
 *     l'idea di un'operazione più pesante);
 *   - dataPointsRange: [min, max] di "data points" che questo step
 *     aggiunge al contatore progressivo, con un valore casuale scelto
 *     ad ogni esecuzione (vedi randomInt in sezione 3).
 */
const SCAN_STEPS = [
  { label: 'Reading browser configuration', durationMs: 900, dataPointsRange: [3, 6] },
  { label: 'Detecting installed plugins and extensions', durationMs: 850, dataPointsRange: [2, 5] },
  { label: 'Analyzing display and hardware parameters', durationMs: 950, dataPointsRange: [4, 8] },
  { label: 'Evaluating time zone and language settings', durationMs: 800, dataPointsRange: [2, 4] },
  { label: 'Cross-referencing exposure against known tracking patterns', durationMs: 1200, dataPointsRange: [6, 11] },
  { label: 'Calculating identification confidence score', durationMs: 900, dataPointsRange: [3, 7] },
];

/** Durata (ms) di ogni step una volta che lo skip è stato richiesto: non
 *  zero, per lasciare comunque una percezione di sequenza reale. */
const FAST_STEP_MS = 90;

/** Pausa (ms) fra il momento in cui la barra di avanzamento raggiunge
 *  il 100% (testo di stato: "Analysis complete.") e la navigazione
 *  verso #screen-alert — vedi l'uso in sezione 7. Applicata solo al
 *  percorso normale: in modalità skip (o reduced-motion, che la
 *  implica fin dall'inizio di runScan) resta 0, coerente con ogni
 *  altro tempo di attesa di questo modulo, dove skip/reduced-motion
 *  comprimono sempre i tempi piuttosto che allungarli.
 *  MODIFICA 8 luglio 2026: alzata da 400ms a 2000ms per dare al
 *  passaggio verso il gauge di rischio un vero respiro percettivo. */
const SCAN_COMPLETE_PAUSE_MS = 2000;

/** Punteggio (0–100) a partire dal quale il gauge passa dal tono di
 *  riposo "warning" al tono "danger" — vedi .alert-gauge--danger in
 *  components.css.
 *  MODIFICA 8 luglio 2026: la nota precedente qui diceva che una
 *  soglia alta avrebbe reso il tono "danger" un esito non scontato,
 *  non la norma di ogni scansione. Scelta ribaltata di proposito: vedi
 *  il commento su computeRiskScore() più sotto, dove il range è stato
 *  innalzato per superare SEMPRE questa soglia — l'anello rosso e lo
 *  stato "Critical risk detected" devono comparire a ogni esecuzione,
 *  non a intermittenza. La costante resta comunque il riferimento
 *  singolo per quella soglia, utile se in futuro si volesse
 *  reintrodurre variabilità. */
const DANGER_THRESHOLD = 85;

/** Circonferenza del gauge (2 × π × 52), identica al valore statico già
 *  dichiarato su .alert-gauge-fill in components.css. */
const GAUGE_CIRCUMFERENCE = 326.73;

// --------------------------------------------------------------------
// 3. UTILITY GENERICHE
// --------------------------------------------------------------------

function getCssToken(tokenName, fallback) {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(tokenName)
    .trim();
  return value || fallback;
}

function getDurationMs(tokenName, fallbackMs) {
  const parsed = parseFloat(getCssToken(tokenName, `${fallbackMs}ms`));
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Intero casuale incluso fra min e max (entrambi inclusi). */
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Promise che si risolve dopo `ms` millisecondi. */
function wait(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Anima il contenuto testuale numerico di un elemento da `from` a `to`
 * nell'arco di `durationMs`, con un frame rate legato a
 * requestAnimationFrame. Se `durationMs` è 0 (o non finito), il valore
 * finale viene scritto immediatamente senza alcun passaggio intermedio
 * — comportamento corretto sia per il caso "reduced motion" sia per il
 * caso "skip", dove ogni tick intermedio sarebbe solo rumore visivo.
 * Nessun aria-live è coinvolto qui: come da nota in animations.css, un
 * count-up ad alta frequenza non va annunciato tick per tick, solo il
 * valore finale (a cura del chiamante).
 *
 * FIX AUDIT 6 luglio 2026: aggiunto il parametro `suffix` (default
 * stringa vuota, comportamento invariato per chi non lo passa — vedi
 * uso su #scan-metric-count più sotto). Prima di questa correzione,
 * qualunque chiamante avesse bisogno di un'unità di misura nel testo
 * finale (es. "%") se la vedeva sistematicamente rimossa dal count-up:
 * il valore veniva sempre scritto come numero nudo, in ogni ramo della
 * funzione. Vedi animateGaugeTo() più sotto per il caso che ha reso
 * evidente il problema.
 * @param {HTMLElement} el
 * @param {number} from
 * @param {number} to
 * @param {number} durationMs
 * @param {string} [suffix=''] - testo da accodare al numero, es. '%'
 * @returns {Promise<void>} risolta quando il conteggio raggiunge `to`
 */
function animateNumber(el, from, to, durationMs, suffix = '') {
  return new Promise((resolve) => {
    if (!el) {
      resolve();
      return;
    }
    if (!Number.isFinite(durationMs) || durationMs <= 0 || from === to) {
      el.textContent = `${to}${suffix}`;
      resolve();
      return;
    }
    const startTime = performance.now();
    const step = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / durationMs, 1);
      // ease-out semplice: rallenta verso il valore finale invece di
      // fermarsi di scatto, coerente con il tono "morbido" delle
      // transizioni CSS del resto dell'app.
      const eased = 1 - (1 - progress) * (1 - progress);
      const currentValue = Math.round(from + (to - from) * eased);
      el.textContent = `${currentValue}${suffix}`;
      if (progress < 1) {
        requestAnimationFrame(step);
      } else {
        el.textContent = `${to}${suffix}`;
        resolve();
      }
    };
    requestAnimationFrame(step);
  });
}

// --------------------------------------------------------------------
// 4. COSTRUZIONE E STATO DEGLI STEP (#scan-steps)
// --------------------------------------------------------------------

/**
 * Costruisce il markup di un singolo step, seguendo esattamente la
 * struttura già documentata in screens.css (indicatore a due livelli
 * sovrapposti — pallino pending/active e spunta done — più etichetta).
 * Lo stato iniziale è sempre "pending": è runStepSequence() a farlo
 * avanzare nel tempo.
 * @param {{label: string}} stepData
 * @param {number} index - usato per lo stagger via --step-index
 * @returns {HTMLLIElement}
 */
function createStepElement(stepData, index) {
  const li = document.createElement('li');
  li.className = 'scan-step scan-step--pending scan-step--appear';
  li.style.setProperty('--step-index', String(index));

  li.innerHTML = `
    <span class="scan-step__indicator">
      <span class="scan-step__dot" aria-hidden="true"></span>
      <svg class="icon icon--scan-step" aria-hidden="true" focusable="false">
        <use href="#icon-check-circle"></use>
      </svg>
    </span>
    <span class="scan-step__label"></span>
  `;
  // Il testo dell'etichetta è assegnato via textContent (non innerHTML)
  // anche se qui non arriva da input utente: abitudine corretta da non
  // rompere, ed evita comunque qualunque escaping manuale della label.
  li.querySelector('.scan-step__label').textContent = stepData.label;

  return li;
}

/**
 * Svuota #scan-steps e lo ripopola da zero con tutti gli step in stato
 * "pending", inseriti in un solo colpo (lo stagger di comparsa è
 * interamente demandato a --step-index + .scan-step--appear, non alla
 * sequenza di inserimento nel DOM — vedi banner introduttivo).
 * @returns {HTMLLIElement[]} gli elementi creati, nello stesso ordine di SCAN_STEPS
 */
function buildStepElements() {
  if (!scanStepsContainer) return [];
  scanStepsContainer.innerHTML = '';
  const fragment = document.createDocumentFragment();
  const elements = SCAN_STEPS.map((stepData, index) => {
    const li = createStepElement(stepData, index);
    fragment.appendChild(li);
    return li;
  });
  scanStepsContainer.appendChild(fragment);
  return elements;
}

/**
 * Applica uno dei 3 stati mutuamente esclusivi a uno step, rimuovendo
 * sempre prima gli altri due (mai un accumulo di classi contrastanti
 * sullo stesso elemento).
 * @param {HTMLLIElement} li
 * @param {'pending'|'active'|'done'} state
 */
function setStepState(li, state) {
  li.classList.remove('scan-step--pending', 'scan-step--active', 'scan-step--done');
  li.classList.add(`scan-step--${state}`);
}

// --------------------------------------------------------------------
// 5. BARRA DI AVANZAMENTO, STATO TESTUALE, CONTATORE
// --------------------------------------------------------------------

function setProgress(percent) {
  if (progressFillEl) progressFillEl.style.width = `${percent}%`;
  if (progressPercentageEl) progressPercentageEl.textContent = `${percent}%`;
}

function setScanStatusText(text) {
  if (scanStatusEl) scanStatusEl.textContent = text;
}

/** Riporta l'intera UI della schermata scan allo stato iniziale
 *  visibile nell'HTML statico — necessario per rendere runScan()
 *  richiamabile più di una volta senza residui della corsa precedente
 *  (utile in fase di test/QA, anche se il flusso reale la invoca una
 *  sola volta per sessione). */
function resetScanUI() {
  setProgress(0);
  setScanStatusText('Preparing analysis…');
  if (metricCountEl) metricCountEl.textContent = '0';
  if (skipBtn) skipBtn.hidden = false;
}

// --------------------------------------------------------------------
// 6. GAUGE DI RISCHIO (#screen-alert)
// --------------------------------------------------------------------

/**
 * Calcola un punteggio di rischio simulato. Il progetto è didattico:
 * il punteggio non deriva da un'analisi reale del dispositivo (quella
 * vive in dashboardRenderer.js, come dati grezzi separati) ma da un
 * intervallo di valori scelto a tavolino.
 *
 * MODIFICA 8 luglio 2026: range innalzato da 68–96 a 89–97. Con
 * l'intervallo precedente il punteggio poteva ricadere sotto
 * DANGER_THRESHOLD (85) in una minoranza di casi, mostrando il gauge
 * nella variante "warning" (ambra) invece che "danger" (rossa): un
 * esito plausibile in astratto, ma non più coerente con l'obiettivo
 * didattico attuale, per cui l'anello rosso e l'etichetta "Critical
 * risk detected" devono comparire SEMPRE, a ogni esecuzione, mai a
 * intermittenza casuale. Il limite inferiore (89) resta sopra soglia
 * con un margine reale, non 85 esatto: un punteggio a ridosso del
 * confine apparirebbe "casualmente" meno grave a un occhio attento.
 * Resta comunque un intervallo, non un valore fisso: il numero esatto
 * continua a variare a ogni scansione, cambia solo la fascia (ora
 * sempre "danger").
 * @returns {number} intero fra 89 e 97
 */
function computeRiskScore() {
  return randomInt(89, 97);
}

/**
 * Anima il gauge circolare (#alert-gauge-fill) e il suo valore numerico
 * (#alert-gauge-value) fino al punteggio finale, applicando la
 * variante --danger al contenitore quando il punteggio supera la
 * soglia. Il riempimento dell'anello è affidato interamente alla
 * transition CSS già dichiarata su .alert-gauge-fill (animations.css):
 * qui si imposta solo il valore di arrivo di stroke-dashoffset, mai la
 * proprietà "transition" stessa. La durata del count-up numerico è
 * letta a runtime dallo stesso token (--duration-slow) così i due
 * movimenti — anello e cifra — restano percepibilmente sincronizzati,
 * e collassano insieme a un aggiornamento istantaneo sotto
 * prefers-reduced-motion (il token vale 0.01ms in quel caso, gestito
 * da variables.css senza bisogno di alcuna diramazione qui).
 *
 * @param {number} score - punteggio finale, 0–100
 * @param {'warning'|'danger'} severity
 * @returns {Promise<void>} risolta a count-up numerico completato
 */
async function animateGaugeTo(score, severity) {
  if (alertGaugeContainer) {
    alertGaugeContainer.classList.toggle('alert-gauge--danger', severity === 'danger');

    // FIX AUDIT 6 luglio 2026: #alert-gauge-svg e #alert-gauge-value
    // sono entrambi aria-hidden in index.html (l'SVG è puramente
    // decorativo, il numero da solo sarebbe privo di contesto per uno
    // screen reader). .alert-gauge è stato dichiarato role="img" in
    // index.html proprio per fare da unico punto di accesso assistivo:
    // qui gli si assegna l'aria-label definitiva, con l'informazione
    // equivalente in un'unica frase coerente — invece di far leggere un
    // numero nudo, fuori contesto e prima della sua stessa etichetta
    // visiva (.alert-score-label viene dopo nel DOM).
    const severityLabel = severity === 'danger' ? 'critical risk detected' : 'potential risk detected';
    alertGaugeContainer.setAttribute('aria-label', `Confidence score: ${score} percent — ${severityLabel}`);
  }
  if (alertGaugeFillEl) {
    const offset = GAUGE_CIRCUMFERENCE * (1 - score / 100);
    alertGaugeFillEl.style.strokeDashoffset = String(offset);
  }
  const countUpDurationMs = getDurationMs('--duration-slow', 480);
  // FIX AUDIT 6 luglio 2026: suffisso '%' esplicito — vedi changelog
  // in testa al file e docblock di animateNumber() per il dettaglio
  // del difetto corretto (il valore terminava senza unità di misura).
  await animateNumber(alertGaugeValueEl, 0, score, countUpDurationMs, '%');
}

// --------------------------------------------------------------------
// 7. ORCHESTRAZIONE PRINCIPALE
// --------------------------------------------------------------------

/**
 * Esegue l'intera sequenza della schermata di scansione e la transizione
 * automatica verso la schermata di alert.
 *
 * Presupposto: #screen-scan è già la schermata visibile al momento della
 * chiamata (main.js la mostra prima di invocare questa funzione). Al
 * termine, questa funzione ha già navigato verso #screen-alert e animato
 * il suo gauge: il chiamante non deve fare altro che, subito dopo, far
 * popolare a dashboardRenderer.js la lista #alert-findings.
 *
 * @returns {Promise<{riskScore: number, severity: 'warning'|'danger'}>}
 */
async function runScan() {
  const reducedMotion = prefersReducedMotion();

  resetScanUI();
  const stepElements = buildStepElements();

  // Sotto reduced-motion trattiamo l'intera scansione come se lo skip
  // fosse già stato richiesto fin dall'inizio: chi ha chiesto un
  // sistema meno "in movimento" difficilmente vuole anche attendere
  // diversi secondi di step scenografici — vedi banner introduttivo.
  let skipRequested = reducedMotion;
  let resolveSkip;
  const skipPromise = new Promise((resolve) => {
    resolveSkip = resolve;
  });

  const handleSkipClick = () => {
    if (skipRequested) return;
    skipRequested = true;
    resolveSkip();
  };

  if (skipBtn) {
    skipBtn.addEventListener('click', handleSkipClick);
  }

  let metricTotal = 0;

  for (let i = 0; i < SCAN_STEPS.length; i += 1) {
    const stepData = SCAN_STEPS[i];
    const li = stepElements[i];

    if (li) setStepState(li, 'active');
    setScanStatusText(`${stepData.label}…`);

    if (skipRequested) {
      // Già in modalità accelerata (skip cliccato in un giro precedente,
      // o reduced-motion attivo fin dall'inizio): nessuna race da fare,
      // solo un piccolo intervallo fisso per mantenere leggibile la
      // sequenza invece di un salto istantaneo a occhio nudo.
      await wait(FAST_STEP_MS);
    } else {
      // Attesa normale, interrompibile in qualunque istante dal click
      // su "Salta al risultato": la prima delle due condizioni vince.
      await Promise.race([wait(stepData.durationMs), skipPromise]);
    }

    if (li) setStepState(li, 'done');

    const increment = randomInt(stepData.dataPointsRange[0], stepData.dataPointsRange[1]);
    const newTotal = metricTotal + increment;
    const countUpDuration = skipRequested ? 0 : Math.min(stepData.durationMs, 400);
    await animateNumber(metricCountEl, metricTotal, newTotal, countUpDuration);
    metricTotal = newTotal;

    setProgress(Math.round(((i + 1) / SCAN_STEPS.length) * 100));
  }

  if (skipBtn) {
    skipBtn.removeEventListener('click', handleSkipClick);
    skipBtn.hidden = true;
  }

  setScanStatusText('Analysis complete.');
  // Pausa di lettura prima di navigare verso #screen-alert — vedi
  // SCAN_COMPLETE_PAUSE_MS in sezione 2 per valore e changelog.
  await wait(skipRequested ? 0 : SCAN_COMPLETE_PAUSE_MS);

  const riskScore = computeRiskScore();
  const severity = riskScore >= DANGER_THRESHOLD ? 'danger' : 'warning';

  await showScreen('screen-alert', {
    statusState: severity,
    statusLabel: severity === 'danger' ? 'Critical risk detected' : 'Potential risk detected',
    announceText: 'Security analysis complete. Reviewing results.',
  });

  await animateGaugeTo(riskScore, severity);

  return { riskScore, severity };
}

// --------------------------------------------------------------------
// 8. ESPORTAZIONI
// --------------------------------------------------------------------

export { runScan };

/* ==========================================================================
   DASHBOARDRENDERER.JS — RACCOLTA DATI REALI DEL BROWSER E RENDERING
   ==========================================================================
   Terzo modulo della fase JS. A differenza di scanEngine.js (che lavora
   su un punteggio SIMULATO), questo modulo legge dati VERI del browser
   tramite API pubbliche e documentate — sono esattamente i dati che il
   testo didattico di #screen-results promette di mostrare ("nessun
   hacking, solo API pubbliche"). Nessun dato qui è inventato: dove un
   valore non è disponibile in un dato browser (deviceMemory su Firefox/
   Safari, stato online in contesti non standard...), viene mostrata
   un'etichetta esplicita ("Non rilevabile"), mai un dato fittizio che
   comprometterebbe la credibilità didattica del progetto.

   RESPONSABILITÀ DI QUESTO FILE
   --------------------------------------------------------------------
   1) collectDeviceData()     — legge tutti i dati grezzi una sola volta
                                 e li restituisce come oggetto semplice,
                                 così main.js può raccoglierli UNA VOLTA
                                 sola e passarli sia a renderAlertFindings
                                 sia a renderResultsDashboard, evitando
                                 letture ripetute (e piccoli disallineamenti,
                                 es. sull'ora locale) fra le due schermate.
   2) renderAlertFindings()   — popola la lista sintetica #alert-findings
                                 nella schermata alert (poche voci, le più
                                 "d'impatto").
   3) renderResultsDashboard()— popola in un solo colpo le 11 card di
                                 #dashboard-grid, la lista completa
                                 #findings-list e i due placeholder
                                 inline della spiegazione didattica
                                 (#explain-browser-name/#explain-os-name).
                                 Le tre operazioni sono raggruppate perché
                                 main.js le invoca sempre insieme, al
                                 momento di mostrare #screen-results — non
                                 hanno mai bisogno di essere richiamate
                                 separatamente, a differenza di
                                 renderAlertFindings (che vive in un
                                 momento distinto della sequenza).

   DATA POINT COPERTI (aggiornato — terza passata)
   --------------------------------------------------------------------
   Identità/software : browser + versione, sistema operativo.
   Display           : risoluzione schermo, dimensione finestra
                        (viewport), densità pixel, color depth.
   Hardware          : core CPU logici, RAM stimata (deviceMemory),
                        tipo di dispositivo (desktop/tablet/smartphone)
                        e supporto touch.
   Rete/tempo        : stato online, tipo/velocità di connessione
                        stimata (Network Information API), fuso
                        orario, ora locale.
   Preferenze/privacy: lingue, tema chiaro/scuro, reduced motion,
                        Do Not Track, cookie abilitati.

   TERZA PASSATA — 9 luglio 2026: aggiunta la velocità di connessione
   stimata (readConnectionInfo(), sezione 3). Stesso principio di
   onestà già stabilito per deviceMemory: la Network Information API
   (navigator.connection) è implementata solo su browser Chromium
   (Firefox e Safari non la espongono, scelta anti-fingerprinting delle
   rispettive organizzazioni) — quindi null è un esito reale e
   frequente, mostrato come "Non rilevabile (solo Chromium)", mai un
   valore indovinato.

   COSA QUESTO MODULO NON FA
   --------------------------------------------------------------------
   - Non mostra/nasconde alcuna schermata: resta compito di main.js
     tramite showScreen() di uiController.js.
   - Non richiede alcun permesso al browser (geolocalizzazione, camera,
     notifiche...): tutti i dati letti qui sono disponibili senza alcuna
     autorizzazione esplicita dell'utente — è esattamente il punto
     didattico del progetto, quindi il modulo si limita deliberatamente
     alle sole API "silenziose".
   ========================================================================== */

// --------------------------------------------------------------------
// 1. RIFERIMENTI DOM
// --------------------------------------------------------------------

const dashboardGridEl = document.getElementById('dashboard-grid');
const findingsListEl = document.getElementById('findings-list');
const alertFindingsEl = document.getElementById('alert-findings');
const explainBrowserNameEl = document.getElementById('explain-browser-name');
const explainOsNameEl = document.getElementById('explain-os-name');

for (const [name, el] of Object.entries({
  dashboardGridEl,
  findingsListEl,
  alertFindingsEl,
  explainBrowserNameEl,
  explainOsNameEl,
})) {
  if (!el) {
    console.error(`[dashboardRenderer] elemento non trovato in pagina: ${name}`);
  }
}

/** Numero di voci mostrate nella lista sintetica della schermata alert:
 *  poche e ad alto impatto, la lista completa resta compito esclusivo
 *  della schermata risultati (#findings-list). */
const ALERT_FINDINGS_COUNT = 4;

// --------------------------------------------------------------------
// 2. PARSING USER AGENT — BROWSER E SISTEMA OPERATIVO
// --------------------------------------------------------------------

/**
 * Ricava nome e versione del browser da navigator.userAgent con un set
 * di espressioni regolari ordinate dal caso più specifico al più
 * generico (Edge ed Opera includono "Chrome" nella propria UA string,
 * quindi vanno controllati PRIMA di Chrome, o verrebbero identificati
 * erroneamente). Nessuna dipendenza da navigator.userAgentData: quella
 * API è disponibile solo su alcuni browser Chromium ed è pensata per
 * ridurre proprio il fingerprinting tramite UA — usarla al posto della
 * stringa classica indebolirebbe il valore dimostrativo della lezione,
 * il cui punto è mostrare quanto la UA "classica" sia già di per sé
 * informativa.
 * @param {string} ua - navigator.userAgent
 * @returns {{name: string, version: string}}
 */
function parseBrowser(ua) {
  const patterns = [
    { name: 'Microsoft Edge', regex: /Edg\/([\d.]+)/ },
    { name: 'Opera', regex: /(?:OPR|Opera)\/([\d.]+)/ },
    { name: 'Samsung Internet', regex: /SamsungBrowser\/([\d.]+)/ },
    { name: 'Firefox', regex: /Firefox\/([\d.]+)/ },
    { name: 'Chrome', regex: /Chrome\/([\d.]+)/ },
    { name: 'Safari', regex: /Version\/([\d.]+).*Safari/ },
  ];
  for (const { name, regex } of patterns) {
    const match = ua.match(regex);
    if (match) {
      return { name, version: match[1] };
    }
  }
  return { name: 'Browser non identificato', version: '' };
}

/**
 * Ricava un'etichetta leggibile del sistema operativo da
 * navigator.userAgent. Le versioni di Windows vengono distinte solo
 * dove la UA lo permette realmente (da Windows 11 in poi molti browser
 * riportano ancora "Windows NT 10.0" per ragioni di compatibilità:
 * mostrare "Windows 10/11" invece di inventare una distinzione che
 * l'API non garantisce è una scelta di onestà del dato, coerente con
 * lo spirito dell'intero modulo). navigator.platform non è usato qui:
 * è classifyDeviceType() più sotto a farne un uso mirato, per l'unico
 * caso in cui è davvero l'unico segnale utile (iPad che si presenta
 * con una UA identica a macOS — vedi il relativo commento).
 * @param {string} ua - navigator.userAgent
 * @returns {string}
 */
function parseOperatingSystem(ua) {
  if (/Windows NT 10\.0/.test(ua)) return 'Windows 10/11';
  if (/Windows NT 6\.3/.test(ua)) return 'Windows 8.1';
  if (/Windows NT 6\.1/.test(ua)) return 'Windows 7';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Mac OS X ([\d_]+)/.test(ua)) {
    const version = ua.match(/Mac OS X ([\d_]+)/)[1].replace(/_/g, '.');
    return `macOS ${version}`;
  }
  if (/Android ([\d.]+)/.test(ua)) {
    return `Android ${ua.match(/Android ([\d.]+)/)[1]}`;
  }
  if (/iPhone|iPad|iPod/.test(ua)) {
    const match = ua.match(/OS ([\d_]+)/);
    return match ? `iOS ${match[1].replace(/_/g, '.')}` : 'iOS';
  }
  if (/Linux/.test(ua)) return 'Linux';
  return 'Sistema operativo non identificato';
}

// --------------------------------------------------------------------
// 3. RILEVAMENTO HARDWARE E TIPO DI DISPOSITIVO
// --------------------------------------------------------------------

/**
 * Legge navigator.deviceMemory: RAM approssimata in GB. La specifica la
 * arrotonda DELIBERATAMENTE a una potenza di 2 fra 0.25 e 8 (un
 * dispositivo con 32GB reali risulterà comunque "8"): è un limite di
 * privacy della API stessa, non un'imprecisione di questo modulo — per
 * questo il valore va mostrato così com'è, senza mai presentarlo come
 * "RAM esatta". Disponibile solo su browser basati su Chromium: Firefox
 * e Safari non la implementano affatto (scelta esplicita
 * anti-fingerprinting delle rispettive organizzazioni), quindi `null`
 * è un esito reale e frequente, non un errore da correggere.
 * @returns {number|null}
 */
function readDeviceMemoryGB() {
  return typeof navigator.deviceMemory === 'number' ? navigator.deviceMemory : null;
}

/**
 * Legge navigator.connection (Network Information API): tipo di
 * connessione stimato ("4g", "3g", "2g", "slow-2g"), velocità di
 * downlink stimata in Mbps e se l'utente ha attivato il risparmio dati
 * a livello di sistema/browser. Come deviceMemory, è un'API
 * implementata SOLO su browser Chromium — Firefox e Safari non la
 * espongono affatto — quindi `null` è un esito reale e frequente, non
 * un errore. I tre valori vanno sempre trattati come un'unica unità
 * (nessuno dei tre ha senso mostrato isolatamente se manca il resto),
 * per questo la funzione restituisce un solo oggetto o null, mai
 * proprietà singole opzionali.
 * @returns {{effectiveType: string, downlinkMbps: number, saveData: boolean}|null}
 */
function readConnectionInfo() {
  // Vendor prefix legacy (webkit/moz) mantenuto per completezza: sui
  // browser che oggi implementano l'API, è comunque "connection" senza
  // prefisso a essere popolato, ma un fallback esplicito non costa nulla.
  const connection = navigator.connection
    || navigator.webkitConnection
    || navigator.mozConnection
    || null;
  if (!connection || typeof connection.effectiveType !== 'string') {
    return null;
  }
  return {
    effectiveType: connection.effectiveType,
    downlinkMbps: typeof connection.downlink === 'number' ? connection.downlink : null,
    saveData: Boolean(connection.saveData),
  };
}

/**
 * Rileva il supporto touch combinando i due segnali standard
 * disponibili: nessuno dei due, da solo, è affidabile in ogni
 * configurazione (alcuni laptop Windows con schermo touch ma mouse
 * come input primario popolano solo uno dei due, a seconda del
 * browser), quindi si considera "touch" se ALMENO uno dei due lo
 * conferma.
 * @returns {boolean}
 */
function detectTouchSupport() {
  return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
}

/**
 * Classifica il tipo di dispositivo (Smartphone / Tablet / Desktop-
 * Laptop) combinando user agent e supporto touch, con un caso speciale
 * per l'iPad: da iPadOS 13 in poi Safari invia di default una UA
 * identica a un vero Mac ("Macintosh; Intel Mac OS X..."), senza alcun
 * token "iPad" o "Mobile" — la sola UA non basta più a distinguerlo.
 * L'unico segnale ancora affidabile è che un Mac reale riporta sempre
 * navigator.maxTouchPoints === 0, mentre un iPad (anche travestito) ne
 * riporta sempre più di uno: è la tecnica usata qui prima di ricadere
 * sul solo controllo della UA. Quando nessun pattern trova
 * corrispondenza, l'esito è "Desktop/Laptop": il fallback più onesto e
 * statisticamente più probabile, mai una categoria inventata per
 * sembrare più precisi di quanto i dati permettano davvero.
 * @param {string} ua - navigator.userAgent
 * @param {boolean} touchSupport - esito di detectTouchSupport()
 * @returns {string}
 */
function classifyDeviceType(ua, touchSupport) {
  if (/iPad/.test(ua)) return 'Tablet';
  // iPad travestito da Mac (iPadOS 13+, UA "Macintosh" di default): un
  // Mac reale ha sempre maxTouchPoints 0, un iPad no — vedi commento sopra.
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) return 'Tablet';
  if (/Android/.test(ua) && !/Mobile/.test(ua)) return 'Tablet';
  if (/Mobi|Android.*Mobile|iPhone|iPod/.test(ua)) return 'Smartphone';
  return touchSupport ? 'Desktop/Laptop (touch screen)' : 'Desktop/Laptop';
}

// --------------------------------------------------------------------
// 4. RACCOLTA DATI GREZZI
// --------------------------------------------------------------------

/**
 * Formatta lo scostamento (in minuti, come restituito da
 * Date.prototype.getTimezoneOffset — segno invertito rispetto a UTC)
 * in una stringa "UTC±HH:MM" leggibile.
 * @param {number} offsetMinutes
 * @returns {string}
 */
function formatUtcOffset(offsetMinutes) {
  const sign = offsetMinutes <= 0 ? '+' : '-'; // getTimezoneOffset ha segno invertito
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, '0');
  const minutes = String(abs % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${minutes}`;
}

/**
 * Raccoglie in un solo oggetto tutti i dati grezzi che il resto del
 * modulo userà per popolare card, findings e placeholder testuali. Va
 * chiamata UNA SOLA VOLTA da main.js (subito dopo la fine di
 * scanEngine.runScan()) e il risultato va riutilizzato sia per
 * renderAlertFindings sia per renderResultsDashboard: rileggere i dati
 * due volte in momenti diversi produrrebbe un'ora locale leggermente
 * diversa fra le due schermate, un dettaglio piccolo ma che un occhio
 * attento potrebbe notare e che comprometterebbe la coerenza percepita
 * del "report".
 * @returns {object} dati grezzi del dispositivo
 */
function collectDeviceData() {
  const ua = navigator.userAgent || '';
  const browser = parseBrowser(ua);
  const os = parseOperatingSystem(ua);

  const dpr = window.devicePixelRatio || 1;
  const resolution = `${window.screen.width}×${window.screen.height}`;
  // Dimensione ATTUALE della finestra del browser, distinta apposta
  // dalla risoluzione dello schermo qui sopra: sono due dati diversi
  // (un browser non massimizzato ha un viewport più piccolo dello
  // schermo fisico) e la differenza fra i due è essa stessa un segnale
  // interessante da mostrare nei findings.
  const viewport = `${window.innerWidth}×${window.innerHeight}`;
  const colorDepth = window.screen.colorDepth || null;

  const cpuCores = typeof navigator.hardwareConcurrency === 'number'
    ? navigator.hardwareConcurrency
    : null;
  const deviceMemoryGB = readDeviceMemoryGB();

  const touchSupport = detectTouchSupport();
  const deviceType = classifyDeviceType(ua, touchSupport);
  const connectionInfo = readConnectionInfo();

  let timezoneName = 'Non rilevabile';
  try {
    timezoneName = Intl.DateTimeFormat().resolvedOptions().timeZone || timezoneName;
  } catch {
    // Intl.DateTimeFormat non dovrebbe mai lanciare in un browser
    // moderno, ma un fallback esplicito evita che un'eccezione qui
    // blocchi l'intera schermata risultati per un dato non essenziale.
  }
  const utcOffset = formatUtcOffset(new Date().getTimezoneOffset());

  const now = new Date();
  const localTime = now.toLocaleTimeString(navigator.language || 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const languages = Array.isArray(navigator.languages) && navigator.languages.length
    ? navigator.languages
    : [navigator.language || 'Non rilevabile'];

  const prefersDark = window.matchMedia
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const prefersReducedMotion = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const doNotTrack = navigator.doNotTrack === '1' || navigator.doNotTrack === 'yes';
  const cookiesEnabled = Boolean(navigator.cookieEnabled);
  // navigator.onLine può in teoria essere assente in ambienti non
  // standard: il controllo esplicito di tipo mantiene lo stesso
  // principio di onestà già applicato a deviceMemory qui sopra (null,
  // mai un valore indovinato).
  const isOnline = typeof navigator.onLine === 'boolean' ? navigator.onLine : null;

  return {
    browserName: browser.name,
    browserVersion: browser.version,
    osName: os,
    resolution,
    viewport,
    dpr,
    colorDepth,
    cpuCores,
    deviceMemoryGB,
    touchSupport,
    deviceType,
    connectionInfo,
    timezoneName,
    utcOffset,
    localTime,
    languages,
    prefersDark,
    prefersReducedMotion,
    doNotTrack,
    cookiesEnabled,
    isOnline,
  };
}

// --------------------------------------------------------------------
// 5. COSTRUZIONE MARKUP — CARD E VOCI DI RISCHIO
// --------------------------------------------------------------------

/**
 * Crea una singola card della dashboard, seguendo esattamente la
 * struttura già documentata in components.css (icona in wrap + label +
 * value).
 * @param {{iconId: string, label: string, value: string}} card
 * @returns {HTMLDivElement}
 */
function createDashboardCard({ iconId, label, value }) {
  const card = document.createElement('div');
  card.className = 'dashboard-card';
  card.innerHTML = `
    <div class="dashboard-card__icon-wrap">
      <svg class="icon icon--dashboard-card" aria-hidden="true" focusable="false">
        <use href="#${iconId}"></use>
      </svg>
    </div>
    <div class="dashboard-card__body">
      <p class="dashboard-card__label"></p>
      <p class="dashboard-card__value"></p>
    </div>
  `;
  // Testo assegnato via textContent (mai innerHTML) anche per i due nodi
  // di testo: i valori grezzi del browser (es. user agent completo)
  // potrebbero in teoria contenere caratteri "<"/">" in configurazioni
  // esotiche, quindi vanno sempre trattati come testo puro, mai come
  // markup.
  card.querySelector('.dashboard-card__label').textContent = label;
  card.querySelector('.dashboard-card__value').textContent = value;
  return card;
}

/**
 * Crea una singola voce di rischio (.finding-item), riutilizzata sia
 * da #alert-findings sia da #findings-list — struttura e mapping icone
 * già documentati in components.css.
 * @param {{severity: 'success'|'warning'|'danger', text: string}} finding
 * @returns {HTMLLIElement}
 */
function createFindingItem({ severity, text }) {
  const li = document.createElement('li');
  li.className = `finding-item finding-item--${severity}`;
  const iconId = severity === 'success' ? 'icon-check-circle' : 'icon-warning';
  li.innerHTML = `
    <svg class="icon icon--finding" aria-hidden="true" focusable="false">
      <use href="#${iconId}"></use>
    </svg>
    <span class="finding-item__text"></span>
  `;
  li.querySelector('.finding-item__text').textContent = text;
  return li;
}

// --------------------------------------------------------------------
// 6. GENERAZIONE DELLE VOCI DI RISCHIO A PARTIRE DAI DATI RACCOLTI
// --------------------------------------------------------------------

/**
 * Traduce i dati grezzi in un elenco ORDINATO di voci di rischio (dalla
 * più "d'impatto" alla più marginale): l'ordine conta perché
 * renderAlertFindings ne mostra solo le prime N, quindi le voci più
 * rilevanti dal punto di vista didattico devono comparire per prime — e
 * per lo stesso motivo le nuove voci di questa seconda passata (tipo
 * dispositivo, RAM, viewport, stato online) sono state inserite DOPO
 * le sei voci storiche, non prima: arricchiscono la lista completa
 * della schermata risultati senza spostare cosa compare nella sintesi
 * della schermata alert. Ogni voce è conseguenza diretta di un dato
 * REALMENTE raccolto: le voci il cui dato sorgente può non essere
 * disponibile su ogni browser (RAM, stato online) vengono aggiunte solo
 * quando il dato è stato effettivamente letto — mai una voce che parli
 * di un "Non rilevabile" come se fosse essa stessa un rischio.
 * @param {object} data - oggetto restituito da collectDeviceData()
 * @returns {Array<{severity: 'success'|'warning'|'danger', text: string}>}
 */
function buildFindings(data) {
  const findings = [];

  // Combinazione ad alta entropia: è il concetto chiave della lezione
  // (device fingerprinting), quindi in cima con severità massima.
  findings.push({
    severity: 'danger',
    text: 'La combinazione di risoluzione, fuso orario, lingua e hardware rilevati può rendere questo dispositivo praticamente unico fra migliaia di altri, anche senza cookie.',
  });

  findings.push({
    severity: 'warning',
    text: `Il tuo browser dichiara pubblicamente di essere ${data.browserName}${data.browserVersion ? ' ' + data.browserVersion : ''}: un dettaglio che rende più credibile un falso avviso di aggiornamento mirato.`,
  });

  findings.push({
    severity: 'warning',
    text: `Il sistema operativo (${data.osName}) è leggibile da qualunque sito, un'informazione spesso usata per costruire falsi messaggi di supporto tecnico "su misura".`,
  });

  findings.push({
    severity: 'warning',
    text: `Fuso orario (${data.timezoneName}, ${data.utcOffset}) e ora locale (${data.localTime}) sono esposti automaticamente: permettono di calcolare in quale fascia oraria e con ogni probabilità in quale area geografica ti trovi.`,
  });

  findings.push({
    severity: 'warning',
    text: `Risoluzione dello schermo (${data.resolution}, densità pixel ${data.dpr}×) e numero di core del processore${data.cpuCores ? ` (${data.cpuCores})` : ''} contribuiscono ulteriormente a un'impronta hardware distintiva.`,
  });

  findings.push({
    severity: 'warning',
    text: `Le lingue preferite dal browser (${data.languages.join(', ')}) rivelano provenienza o abitudini linguistiche, utili per phishing localizzato.`,
  });

  // --- Nuove voci (seconda passata): tipo dispositivo, RAM, viewport,
  // stato online — vedi nota nel docblock sopra sul perché stanno qui
  // e non più in alto.
  findings.push({
    severity: 'warning',
    text: `Il sito classifica questo dispositivo come "${data.deviceType}"${data.touchSupport ? ', con schermo touch rilevato' : ''}: un'altra variabile che si combina con le altre per rendere il dispositivo riconoscibile.`,
  });

  if (data.deviceMemoryGB !== null) {
    findings.push({
      severity: 'warning',
      text: `Il browser espone anche una stima della memoria RAM disponibile (${data.deviceMemoryGB} GB, arrotondata per specifica): un dettaglio hardware che normalmente si considera privato.`,
    });
  }

  findings.push({
    severity: 'warning',
    text: `Il sito vede sia la risoluzione reale dello schermo (${data.resolution}) sia la dimensione attuale della finestra del browser (${data.viewport}): se differiscono, è un'informazione in più su come stai usando il dispositivo proprio ora.`,
  });

  if (data.isOnline !== null) {
    findings.push({
      severity: 'warning',
      text: `Anche lo stato della connessione è leggibile senza alcun permesso: in questo momento risulti ${data.isOnline ? 'online' : 'offline'}.`,
    });
  }

  if (data.connectionInfo !== null) {
    findings.push({
      severity: 'warning',
      text: `Il browser espone anche una stima del tipo e della velocità della tua connessione (${data.connectionInfo.effectiveType.toUpperCase()}${data.connectionInfo.downlinkMbps !== null ? `, ~${data.connectionInfo.downlinkMbps} Mbps` : ''}): un ulteriore dettaglio che si combina con gli altri nell'impronta del dispositivo.`,
    });
  }

  // Voci potenzialmente "success": dipendono da impostazioni che
  // l'utente potrebbe già avere attivo. Vengono aggiunte in coda
  // perché rappresentano una buona notizia, non un rischio da
  // approfondire con priorità.
  findings.push({
    severity: data.doNotTrack ? 'success' : 'warning',
    text: data.doNotTrack
      ? 'Il tuo browser sta inviando il segnale "Do Not Track": un buon segnale, anche se molti siti scelgono comunque di ignorarlo.'
      : 'Il segnale "Do Not Track" non risulta attivo: puoi abilitarlo dalle impostazioni del browser, anche se non tutti i siti sono tenuti a rispettarlo.',
  });

  findings.push({
    severity: data.cookiesEnabled ? 'warning' : 'success',
    text: data.cookiesEnabled
      ? 'I cookie risultano abilitati in questo browser: una delle tecniche di tracciamento più comuni può quindi funzionare qui senza ostacoli.'
      : 'I cookie risultano disabilitati in questo browser: molte tecniche di tracciamento classiche ne risentono, anche se il fingerprinting descritto sopra non dipende dai cookie.',
  });

  findings.push({
    severity: 'success',
    text: 'Nessuno di questi dati è stato copiato, salvato o inviato altrove: l\'intera analisi è avvenuta localmente, nel tuo browser.',
  });

  return findings;
}

// --------------------------------------------------------------------
// 7. FUNZIONI ESPORTATE
// --------------------------------------------------------------------

/**
 * Popola la lista sintetica #alert-findings nella schermata di alert,
 * con le prime ALERT_FINDINGS_COUNT voci generate da buildFindings()
 * (le più rilevanti dal punto di vista didattico — vedi ordine in
 * buildFindings). Va chiamata da main.js subito dopo la risoluzione di
 * scanEngine.runScan(), quando #screen-alert è già visibile: senza
 * questa chiamata l'utente vedrebbe momentaneamente una lista vuota,
 * come già segnalato nel banner introduttivo di scanEngine.js.
 * @param {object} data - oggetto restituito da collectDeviceData()
 */
function renderAlertFindings(data) {
  if (!alertFindingsEl) return;
  const findings = buildFindings(data).slice(0, ALERT_FINDINGS_COUNT);
  alertFindingsEl.innerHTML = '';
  const fragment = document.createDocumentFragment();
  findings.forEach((finding) => fragment.appendChild(createFindingItem(finding)));
  alertFindingsEl.appendChild(fragment);
}

/**
 * Popola in un solo colpo tutto il contenuto "a dati reali" della
 * schermata risultati: le 11 card di #dashboard-grid, la lista
 * completa #findings-list e i due placeholder inline della spiegazione
 * didattica (#explain-browser-name/#explain-os-name). Va chiamata da
 * main.js nel momento in cui #screen-results sta per diventare
 * visibile.
 * @param {object} data - oggetto restituito da collectDeviceData()
 */
function renderResultsDashboard(data) {
  // --- 11 card della dashboard --------------------------------------
  if (dashboardGridEl) {
    const cards = [
      {
        iconId: 'icon-browser',
        label: 'Browser',
        value: data.browserVersion ? `${data.browserName} ${data.browserVersion}` : data.browserName,
      },
      { iconId: 'icon-os', label: 'Sistema operativo', value: data.osName },
      {
        iconId: 'icon-display',
        label: 'Risoluzione schermo',
        value: `${data.resolution} (finestra ${data.viewport}) · dpr ${data.dpr}×${data.colorDepth ? ` · ${data.colorDepth}-bit` : ''}`,
      },
      {
        iconId: 'icon-cpu',
        label: 'CPU / core logici',
        value: data.cpuCores ? `${data.cpuCores} core` : 'Non rilevabile',
      },
      {
        iconId: 'icon-memory',
        label: 'Memoria stimata',
        value: data.deviceMemoryGB !== null ? `${data.deviceMemoryGB} GB` : 'Non rilevabile (solo Chromium)',
      },
      {
        iconId: 'icon-device',
        label: 'Tipo di dispositivo',
        value: data.touchSupport ? `${data.deviceType} · touch` : data.deviceType,
      },
      {
        iconId: 'icon-connection',
        label: 'Connessione',
        value: data.isOnline === null ? 'Non rilevabile' : (data.isOnline ? 'Online' : 'Offline'),
      },
      {
        iconId: 'icon-signal',
        label: 'Velocità di connessione stimata',
        value: data.connectionInfo === null
          ? 'Non rilevabile (solo Chromium)'
          : `${data.connectionInfo.effectiveType.toUpperCase()}${data.connectionInfo.downlinkMbps !== null ? ` · ~${data.connectionInfo.downlinkMbps} Mbps` : ''}${data.connectionInfo.saveData ? ' · risparmio dati attivo' : ''}`,
      },
      {
        iconId: 'icon-network',
        label: 'Fuso orario',
        value: `${data.timezoneName} (${data.utcOffset})`,
      },
      { iconId: 'icon-clock', label: 'Ora locale rilevata', value: data.localTime },
      {
        iconId: 'icon-sliders',
        label: 'Preferenze',
        value: `${data.languages.join(', ')} · Tema ${data.prefersDark ? 'scuro' : 'chiaro'} · Movimento ridotto: ${data.prefersReducedMotion ? 'sì' : 'no'}`,
      },
    ];
    dashboardGridEl.innerHTML = '';
    const cardsFragment = document.createDocumentFragment();
    cards.forEach((card) => cardsFragment.appendChild(createDashboardCard(card)));
    dashboardGridEl.appendChild(cardsFragment);
  }

  // --- Lista completa delle voci di rischio -------------------------
  if (findingsListEl) {
    const findings = buildFindings(data);
    findingsListEl.innerHTML = '';
    const findingsFragment = document.createDocumentFragment();
    findings.forEach((finding) => findingsFragment.appendChild(createFindingItem(finding)));
    findingsListEl.appendChild(findingsFragment);
  }

  // --- Placeholder inline nel testo didattico -----------------------
  if (explainBrowserNameEl) {
    explainBrowserNameEl.textContent = data.browserVersion
      ? `${data.browserName} ${data.browserVersion}`
      : data.browserName;
  }
  if (explainOsNameEl) {
    explainOsNameEl.textContent = data.osName;
  }
}

export { collectDeviceData, renderAlertFindings, renderResultsDashboard };

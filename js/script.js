/* =====================================================================
   Intercambio de textos · lógica de la aplicación (v2)
   ---------------------------------------------------------------------
   Habla SOLO con las dos Edge Functions de Supabase (nunca con las tablas):
     intercambio-public  -> acciones: event, register, result
     intercambio-admin   -> acciones: list_events, create_event, status, set_min,
                            set_auto, distribute, redistribute, list_participants,
                            add_participant, update_participant,
                            set_participant_status, remove_participant
                            (cabecera x-admin-token, validada en el servidor)
   No hay datos de ejemplo ni almacenamiento local: todo viene de Supabase.
   Todo lo que llega del servidor se pinta con textContent (nunca innerHTML).
   ===================================================================== */
(function () {
  'use strict';

  /* ------------------------------ Configuración ----------------------------- */

  const cfg = window.APP_CONFIG || {};
  const CFG_SLUG = String(cfg.EVENT_SLUG || '').trim();     // evento por defecto (puede estar vacío)
  const POLL_MS = Math.max(5, Number(cfg.POLL_SECONDS) || 15) * 1000;
  const FN_PUBLIC = 'intercambio-public';
  const FN_ADMIN = 'intercambio-admin';
  const SLUG_RE = /^[a-z0-9-]{3,40}$/;

  /* --------------------------------- Estado --------------------------------- */

  let sb = null;             // cliente de Supabase
  let eventInfo = null;      // último estado público del evento
  let loadedSlug = null;     // evento al que corresponde eventInfo
  let adminToken = '';       // credencial del admin: solo en memoria
  let adminSlug = '';        // evento que administra
  let adminEvents = [];      // lista de eventos (administración)
  let adminStatus = null;    // último estado del evento administrado
  let partList = [];         // participantes del evento administrado
  let partSig = '';          // firma de partList (evita repintar si no cambia)
  let memberList = [];       // participantes guardados (administración)
  let memberSig = '';        // firma de memberList
  let partFilter = 'all';    // filtro activo de la lista de participantes
  let filterAuto = true;     // elegir el filtro automáticamente al cambiar de evento
  let adminDirty = false;    // el admin está editando la configuración
  let adminBusy = false;     // hay una operación de administración en curso
  let editingPerson = null;  // participante que se edita en el diálogo (null = alta)
  let route = 'participant';
  let firstRoute = true;

  /* -------------------------------- Utilidades ------------------------------ */

  const $ = (id) => document.getElementById(id);

  const MESSAGES = {
    NO_EVENT: 'No se ha indicado ningún evento. Usa el enlace que te ha dado la organización.',
    EVENT_NOT_FOUND: 'El evento no existe. Comprueba el enlace que te han dado (o EVENT_SLUG en config.js).',
    INVALID_NAME: 'El nombre debe tener entre 1 y 60 caracteres.',
    INVALID_SURNAME: 'Los apellidos deben tener entre 1 y 60 caracteres.',
    INVALID_TEXT: 'El texto no puede estar vacío.',
    TEXT_TOO_LONG: 'El texto supera la longitud máxima permitida.',
    INVALID_PIN: 'PIN no reconocido (formato SION-XXXXXX).',
    PIN_TAKEN: 'Ese PIN ya pertenece a otra persona. Elige otro o deja que se genere uno.',
    ALREADY_REGISTERED: 'Ya has enviado tu intención en este evento.',
    PIN_REQUIRED: 'El PIN es obligatorio (formato SION-XXXXXX).',
    NAME_TAKEN: 'Ya existe una persona con ese nombre y apellidos. Si eres tú, vuelve a la pantalla anterior y entra con tu PIN.',
    REGISTRATION_CLOSED: 'El envío está cerrado: el reparto ya se ha realizado.',
    NOT_APPROVED: 'Tu registro no fue aprobado, así que no estás incluido en el reparto.',
    NOT_IN_DISTRIBUTION: 'Todavía no estás incluido en el reparto. Consulta con la organización.',
    EXPIRED: 'Los resultados de este evento han caducado y ya no están disponibles.',
    EVENT_EXPIRED: 'Los resultados de este evento han caducado: ya no admite cambios.',
    RATE_LIMIT: 'Demasiados intentos seguidos. Espera unos minutos y vuelve a probar.',
    INVALID_CLIENT_KEY: 'No se pudo identificar tu conexión. Recarga la página e inténtalo de nuevo.',
    UNAUTHORIZED: 'Credencial de administrador no válida.',
    ALREADY_DISTRIBUTED: 'El reparto ya se realizó.',
    NOT_DISTRIBUTED: 'El evento aún no se ha repartido: usa «Iniciar reparto ahora».',
    NOT_ENOUGH_PARTICIPANTS: 'Se necesitan al menos 2 participantes aprobados para repartir.',
    INVALID_MIN: 'El mínimo debe ser un número entero igual o superior a 2.',
    INVALID_MAX_LEN: 'La longitud máxima del texto debe estar entre 1 y 10000.',
    INVALID_SLUG: 'El identificador solo admite minúsculas, números y guiones (3 a 40 caracteres).',
    SLUG_EXISTS: 'Ya existe un evento con ese identificador.',
    INVALID_STATUS: 'Estado no válido.',
    INVALID_VALUE: 'Valor no válido.',
    PARTICIPANT_NOT_FOUND: 'Ese participante ya no existe. Actualiza la lista.',
    MEMBER_NOT_FOUND: 'Esa persona ya no está en la lista de guardados. Actualiza la lista.',
    UNKNOWN_ACTION: 'La función del servidor está desactualizada. Vuelve a desplegar intercambio-admin ' +
                    'e intercambio-public con la última versión.',
    PAYLOAD_TOO_LARGE: 'El contenido enviado es demasiado grande.',
    SERVER_ERROR: 'Error interno del servidor. Inténtalo de nuevo en unos minutos.',
    NETWORK: 'No se pudo conectar con el servidor. Comprueba tu conexión a internet.',
    GATEWAY: 'Supabase rechazó la petición. Comprueba la clave anónima de config.js y que ' +
             '«Verify JWT» esté desactivado en las dos Edge Functions.'
  };

  function errText(r) {
    return MESSAGES[r && r.code] || (r && typeof r.message === 'string' && r.message) ||
           'Ha ocurrido un error inesperado.';
  }

  function plural(n, one, many) { return n === 1 ? one : many; }

  function setText(id, value) { const el = $(id); if (el) el.textContent = String(value); }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function setBusy(btn, busy, busyLabel) {
    if (!btn) return;
    if (busy) {
      if (!btn.dataset.label) btn.dataset.label = btn.textContent;
      btn.textContent = busyLabel;
      btn.setAttribute('aria-busy', 'true');
      btn.disabled = true;
    } else {
      if (btn.dataset.label) btn.textContent = btn.dataset.label;
      delete btn.dataset.label;
      btn.removeAttribute('aria-busy');
      btn.disabled = false;
    }
  }

  function fieldError(inputId, message) {
    const input = $(inputId);
    const err = $(inputId + '-error');
    if (err) err.textContent = message || '';
    if (input) {
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    }
  }

  function clearFieldErrors(ids) { ids.forEach((id) => fieldError(id, '')); }

  function showFeedback(container, kind, title, text) {
    container.replaceChildren();
    const box = el('div', 'alert alert-' + kind);
    if (title) box.appendChild(el('strong', null, title));
    if (text) box.appendChild(el('p', null, text));
    container.appendChild(box);
  }

  function clearFeedback(container) { container.replaceChildren(); }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('es-ES', { dateStyle: 'long', timeStyle: 'short' });
  }

  function slugify(text) {
    return String(text || '').toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  }

  /* ----------------------- Llamadas a las Edge Functions -------------------- */

  // Devuelve siempre un objeto { ok, code, ... }; nunca lanza excepciones.
  async function call(fn, body, headers) {
    let res;
    try {
      res = await sb.functions.invoke(fn, { body: body, headers: headers || {} });
    } catch (e) {
      return { ok: false, code: 'NETWORK' };
    }
    const data = res.data;
    const error = res.error;
    if (!error) {
      return (data && typeof data === 'object') ? data : { ok: false, code: 'SERVER_ERROR' };
    }
    // Respuesta HTTP no 2xx: nuestras funciones devuelven JSON { ok:false, code, message }
    const ctx = error.context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const payload = await ctx.json();
        if (payload && typeof payload.code === 'string') return payload;
        return { ok: false, code: 'GATEWAY' };      // p. ej. {"code":401,"message":"Invalid JWT"}
      } catch (e) {
        return { ok: false, code: 'SERVER_ERROR' };
      }
    }
    return { ok: false, code: 'NETWORK' };
  }

  // Evento de la zona de participantes: el del enlace (#/e/<slug>) o el de config.js
  function participantSlug() {
    const m = /^#\/e\/([a-z0-9-]{3,40})\/?$/.exec(location.hash);
    return m ? m[1] : CFG_SLUG;
  }

  const callPublic = (action, extra) =>
    call(FN_PUBLIC, Object.assign({ action: action, slug: participantSlug() }, extra || {}));

  const callAdmin = (action, extra) =>
    call(FN_ADMIN, Object.assign({ action: action, slug: adminSlug }, extra || {}),
         { 'x-admin-token': adminToken });

  /* ------------------------------ Diálogo confirmar ------------------------- */

  function confirmDialog(opts) {
    return new Promise((resolve) => {
      const dlg = $('confirm-dialog');
      const ok = $('confirm-ok');
      const cancel = $('confirm-cancel');
      setText('confirm-title', opts.title);
      setText('confirm-message', opts.message);
      ok.textContent = opts.okText || 'Confirmar';
      ok.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');

      if (typeof dlg.showModal !== 'function') {          // navegadores muy antiguos
        resolve(window.confirm(opts.message));
        return;
      }
      const finish = (value) => {
        ok.onclick = null;
        cancel.onclick = null;
        dlg.oncancel = null;
        if (dlg.open) dlg.close();
        resolve(value);
      };
      ok.onclick = () => finish(true);
      cancel.onclick = () => finish(false);
      dlg.oncancel = (e) => { e.preventDefault(); finish(false); };
      dlg.showModal();
      cancel.focus();
    });
  }

  /* ============================ ZONA DE PARTICIPANTES ======================== */

  const PHASES = {
    pending: { label: 'Pendiente', cls: 'badge-pending' },
    ready: { label: 'Esperando reparto', cls: 'badge-ready' },
    done: { label: 'Realizado', cls: 'badge-done' },
    expired: { label: 'Caducado', cls: 'badge-muted' }
  };

  function setBadge(id, phase) {
    const node = $(id);
    const p = PHASES[phase];
    node.className = 'badge ' + (p ? p.cls : 'badge-muted');
    node.textContent = p ? p.label : '–';
  }

  function phaseSentence(info) {
    const missing = Math.max(info.min_participants - info.participants, 0);
    const until = formatDate(info.results_until);
    if (info.phase === 'expired') {
      return 'Los resultados de este evento han caducado y se han borrado. Ya no se pueden consultar.';
    }
    if (info.phase === 'done') {
      return 'El reparto ya se ha realizado. Entra con tu PIN para ver la intención ' +
             'por la que vas a rezar esta semana.' + (until ? ' Podrás consultarlo hasta el ' + until + '.' : '');
    }
    if (info.phase === 'ready') {
      return 'Esperando reparto: se ha alcanzado el mínimo de participantes confirmados y el reparto se hará ' +
             'en cuanto se inicie.';
    }
    return (missing === 1 ? 'Falta 1 participante confirmado' : 'Faltan ' + missing + ' participantes confirmados') +
           ' para alcanzar el mínimo (' + info.participants + ' de ' + info.min_participants + '). ' +
           'Solo cuentan los registros ya validados por un administrador.';
  }

  function ensureClosedNote() {
    let note = $('reg-closed-note');
    if (!note) {
      note = el('div', 'alert alert-info');
      note.id = 'reg-closed-note';
      note.setAttribute('role', 'status');
      note.hidden = true;
      note.textContent = 'El envío de intenciones está cerrado: el reparto ya se ha realizado. ' +
                         'Si participaste, entra con tu PIN para ver tu intención.';
      $('card-access').before(note);
    }
    return note;
  }

  function setRegisterEnabled(enabled) {
    ['register-form', 'first-form'].forEach((fid) => {
      Array.prototype.forEach.call($(fid).elements, (node) => {
        if ((node.id === 'btn-register' || node.id === 'btn-first') && node.getAttribute('aria-busy') === 'true') return;
        node.disabled = !enabled;
      });
    });
    ensureClosedNote().hidden = enabled;
  }

  function renderEvent(info) {
    eventInfo = info;
    loadedSlug = participantSlug();
    const n = info.participants;
    const min = info.min_participants;
    const missing = Math.max(min - n, 0);
    const finished = info.phase === 'done' || info.phase === 'expired';

    setText('stat-count', n);
    setText('stat-min', min);
    setText('stat-missing', finished ? '–' : missing);

    const pct = min > 0 ? Math.min(100, Math.round((n * 100) / min)) : 0;
    $('progress').setAttribute('aria-valuenow', String(pct));
    $('progress-bar').style.width = pct + '%';

    setBadge('phase-badge', info.phase);
    setText('phase-text', phaseSentence(info));

    if (info.name && route === 'participant') document.title = info.name + ' · Intercambio de textos';

    // Longitud máxima real del texto (la define el evento en el servidor)
    const max = Number(info.max_text_length) || 2000;
    $('reg-text').setAttribute('maxlength', String(max));
    $('first-text').setAttribute('maxlength', String(max));
    updateCounter();

    setRegisterEnabled(info.registration_open === true);
  }

  function renderEventError(r) {
    setBadge('phase-badge', null);
    $('phase-badge').className = 'badge badge-error';
    $('phase-badge').textContent = 'Sin datos';
    setText('phase-text', errText(r));
    setText('stat-count', '–');
    setText('stat-min', '–');
    setText('stat-missing', '–');
    $('progress').setAttribute('aria-valuenow', '0');
    $('progress-bar').style.width = '0%';
    setRegisterEnabled(false);
    ensureClosedNote().hidden = true;
  }

  async function loadEvent(silent) {
    if (!SLUG_RE.test(participantSlug())) {
      const r = { ok: false, code: 'NO_EVENT' };
      renderEventError(r);
      return r;
    }
    const slugAtStart = participantSlug();
    const r = await callPublic('event');
    if (slugAtStart !== participantSlug()) return r;         // el enlace cambió mientras se consultaba
    if (r.ok) renderEvent(r);
    else if (!silent || !eventInfo) renderEventError(r);
    return r;
  }

  function updateCounter() {
    ['reg', 'first'].forEach((p) => {
      const ta = $(p + '-text');
      const max = ta.getAttribute('maxlength') || '2000';
      setText(p + '-text-count', ta.value.length + ' / ' + max);
    });
  }

  /* ---- Acceso del participante (solo con el PIN) ----
     El servidor reconoce a la persona por su PIN, devuelve su nombre y dice si ya envió su intención en este
     evento: si la envió se muestra el botón «Ver intención», y si no, el formulario de envío.
     La primera vez, la persona escribe nombre, apellidos e intención y el servidor le genera el PIN.
     La sesión solo vive en memoria (nada se guarda en el navegador): al recargar hay que volver a entrar. */

  // PIN: «SION-» + 6 letras mayúsculas o cifras. Se acepta en minúsculas y se pasa a mayúsculas.
  const PIN_RE = /^SION-[A-Z0-9]{6}$/;
  function normPin(v) { return String(v || '').trim().toUpperCase(); }

  let session = null;          // { name, pin, state: 'sent' | 'not_sent' }
  let firstTime = false;       // se muestra el formulario de primera vez en lugar del acceso
  let resultShown = false;     // ya se mostró la intención asignada en esta sesión

  function sessionText() {
    if (session.state === 'sent') {
      return 'Pulsa el botón para ver la intención por la que vas a rezar esta semana.';
    }
    return 'Escribe tu intención para esta semana y pulsa «Enviar».';
  }

  // Muestra solo lo que corresponde: acceso, primera vez, envío o consulta
  function renderParticipantView(confirmation, pin) {
    const inSession = !!session;
    $('card-access').hidden = inSession || firstTime;
    $('card-first').hidden = inSession || !firstTime;
    $('session-bar').hidden = !inSession;
    const sent = inSession && session.state === 'sent';
    $('participant-grid').hidden = !inSession;
    $('card-register').hidden = !inSession || sent;
    $('card-result').hidden = !sent;
    $('sent-note').hidden = !(inSession && confirmation);
    $('sent-pin-row').hidden = !(inSession && confirmation && pin);
    if (inSession) {
      setText('session-greeting', 'Hola, ' + session.name);
      setText('session-text', sessionText());
      if (confirmation) setText('sent-note-text', confirmation);
      if (pin) setText('sent-pin', pin);
    }
  }

  function startSession(data, pin) {
    session = { name: String(data.name || ''), pin: pin, state: data.state === 'sent' ? 'sent' : 'not_sent' };
    firstTime = false;
    resultShown = false;
    clearResult();
    renderParticipantView();
    if (session.state === 'sent') $('btn-result').focus();
    else $('reg-text').focus();
  }

  function endSession() {
    session = null;
    firstTime = false;
    resultShown = false;
    ['access-form', 'first-form', 'register-form'].forEach((id) => $(id).reset());
    updateCounter();
    clearFieldErrors(['acc-pin', 'first-name', 'first-surname', 'first-text', 'reg-text']);
    ['access-feedback', 'first-feedback', 'register-feedback'].forEach((id) => clearFeedback($(id)));
    clearResult();
    $('sent-pin').textContent = '';
    renderParticipantView();
  }

  function onSwitchPerson() {
    endSession();
    $('acc-pin').focus();
  }

  function showFirstTime(show) {
    firstTime = show;
    renderParticipantView();
    $(show ? 'first-name' : 'acc-pin').focus();
  }

  async function onAccess(e) {
    e.preventDefault();
    const fb = $('access-feedback');
    const btn = $('btn-access');
    clearFieldErrors(['acc-pin']);
    clearFeedback(fb);

    const pin = normPin($('acc-pin').value);
    if (!PIN_RE.test(pin)) {
      fieldError('acc-pin', 'El PIN debe tener el formato SION-XXXXXX (6 letras o cifras).');
      $('acc-pin').focus();
      return;
    }

    setBusy(btn, true, 'Comprobando…');
    const r = await callPublic('access', { pin: pin });
    setBusy(btn, false);

    if (r.ok && (r.state === 'sent' || r.state === 'not_sent')) {
      $('acc-pin').value = '';
      startSession(r, pin);
      return;
    }
    switch (r.code) {
      case 'PIN_REQUIRED': fieldError('acc-pin', errText(r)); $('acc-pin').focus(); break;
      case 'INVALID_PIN':
        fieldError('acc-pin', 'No reconocemos ese PIN. Revísalo; si es tu primera vez, pulsa «Es mi primera vez»; ' +
                              'si lo has olvidado, pide a un administrador que te dé uno nuevo.');
        $('acc-pin').focus();
        break;
      default:
        showFeedback(fb, 'error', 'No se pudo comprobar tu PIN', errText(r));
    }
  }

  /* ---- Primera vez: nombre, apellidos e intención; el servidor genera el PIN ---- */

  async function onFirstTime(e) {
    e.preventDefault();
    const fb = $('first-feedback');
    const btn = $('btn-first');
    const ids = ['first-name', 'first-surname', 'first-text'];
    clearFieldErrors(ids);
    clearFeedback(fb);

    const name = $('first-name').value.trim();
    const surname = $('first-surname').value.trim();
    const text = $('first-text').value.trim();
    const max = Number($('first-text').getAttribute('maxlength')) || 2000;

    let invalid = null;
    const bad = (id, msg) => { fieldError(id, msg); invalid = invalid || id; };
    if (!name) bad('first-name', 'Escribe tu nombre.');
    else if (name.length > 60) bad('first-name', 'El nombre no puede superar los 60 caracteres.');
    if (!surname) bad('first-surname', 'Escribe tus apellidos.');
    else if (surname.length > 60) bad('first-surname', 'Los apellidos no pueden superar los 60 caracteres.');
    if (!text) bad('first-text', 'Escribe tu intención antes de enviarla.');
    else if (text.length > max) bad('first-text', 'La intención no puede superar los ' + max + ' caracteres.');
    if (invalid) { $(invalid).focus(); return; }

    setBusy(btn, true, 'Enviando…');
    const r = await callPublic('register', { name: name, surname: surname, text: text });
    setBusy(btn, false);

    if (r.ok && typeof r.pin === 'string') {
      const msg = '¡Intención enviada! Gracias, ' + name + '. Tu registro está pendiente de validación: un ' +
                  'administrador debe aprobarlo antes de que cuente para el reparto. Apunta tu PIN ahora: lo ' +
                  'necesitarás cada vez que entres y no se puede volver a mostrar.';
      $('first-form').reset();
      updateCounter();
      session = { name: r.name || name, pin: r.pin, state: 'sent' };
      firstTime = false;
      resultShown = false;
      clearResult();
      renderParticipantView(msg, r.pin);
      $('sent-note').focus();
      loadEvent(true);
      return;
    }

    switch (r.code) {
      case 'INVALID_NAME': fieldError('first-name', errText(r)); $('first-name').focus(); break;
      case 'INVALID_SURNAME': fieldError('first-surname', errText(r)); $('first-surname').focus(); break;
      case 'INVALID_TEXT':
      case 'TEXT_TOO_LONG': fieldError('first-text', errText(r)); $('first-text').focus(); break;
      default:
        showFeedback(fb, 'error', 'No se pudo enviar tu registro', errText(r));
        if (r.code === 'REGISTRATION_CLOSED') loadEvent(true);
    }
  }

  /* ---- Envío de la intención (persona que ya tiene PIN) ---- */

  async function onRegister(e) {
    e.preventDefault();
    const fb = $('register-form') && $('register-feedback');
    const btn = $('btn-register');
    clearFieldErrors(['reg-text']);
    clearFeedback(fb);
    if (!session) return;

    const text = $('reg-text').value.trim();
    const max = Number($('reg-text').getAttribute('maxlength')) || 2000;
    if (!text) { fieldError('reg-text', 'Escribe tu intención antes de enviarla.'); $('reg-text').focus(); return; }
    if (text.length > max) { fieldError('reg-text', 'La intención no puede superar los ' + max + ' caracteres.'); $('reg-text').focus(); return; }

    setBusy(btn, true, 'Enviando…');
    const who = session;
    const r = await callPublic('register', { text: text, pin: who.pin });
    setBusy(btn, false);
    if (session !== who) return;

    if (r.ok) {
      const msg = '¡Intención enviada! Gracias, ' + who.name + '. Tu registro queda aprobado al instante y cuenta ' +
                  'para el reparto.' +
                  (r.distributed ? ' Se ha alcanzado el mínimo y el reparto automático ya se ha hecho.'
                                 : ' Cuando se haga el reparto, vuelve a entrar con tu PIN para ver la intención por la que vas a rezar.');
      $('register-form').reset();
      updateCounter();
      session.state = 'sent';
      resultShown = false;
      clearResult();
      renderParticipantView(msg);
      $('sent-note').focus();
      loadEvent(true);
      return;
    }

    switch (r.code) {
      case 'INVALID_TEXT':
      case 'TEXT_TOO_LONG': fieldError('reg-text', errText(r)); $('reg-text').focus(); break;
      case 'ALREADY_REGISTERED':
        // Ya había enviado en este evento (por ejemplo, desde otro dispositivo): se pasa a la consulta
        session.state = 'sent';
        renderParticipantView();
        break;
      case 'INVALID_PIN':
        endSession();
        showFeedback($('access-feedback'), 'info', 'Vuelve a entrar', 'Tu PIN ha cambiado. Pide el nuevo a un administrador.');
        break;
      default:
        showFeedback(fb, 'error', 'No se pudo enviar tu intención', errText(r));
        if (r.code === 'REGISTRATION_CLOSED') loadEvent(true);
    }
  }

  /* ---- Consulta de resultado ---- */

  function clearResult() { clearFeedback($('result-output')); }

  function showResult(text) {
    const out = $('result-output');
    out.replaceChildren();
    const box = el('div', 'result-box');

    const h = el('h3', null, 'Esta es la intención por la que vas a rezar esta semana');
    h.tabIndex = -1;
    box.appendChild(h);
    box.appendChild(el('p', 'muted small', 'El autor es anónimo y no se muestra.'));
    box.appendChild(el('blockquote', 'result-text', text));

    const hide = el('button', 'btn btn-ghost btn-small', 'Ocultar resultado');
    hide.type = 'button';
    hide.addEventListener('click', () => { clearResult(); resultShown = false; $('btn-result').focus(); });
    box.appendChild(hide);

    out.appendChild(box);
    resultShown = true;
    h.focus();
  }

  function pendingMessage(reg) {
    if (reg === 'approved') {
      return ['Tu registro está aprobado',
        'Ya estás confirmado. Esperando el reparto: vuelve más tarde, el estado de arriba se actualiza solo.'];
    }
    if (reg === 'rejected') {
      return ['Tu registro no ha sido aprobado',
        'Un administrador ha rechazado tu registro, así que no entrarás en el reparto. ' +
        'Si crees que es un error, habla con la organización.'];
    }
    if (reg === 'pending') {
      return ['Tu registro está pendiente de validación',
        'Un administrador todavía debe aprobarlo. Hasta entonces no cuenta para el reparto. Cuando se haga el reparto, vuelve y pulsa el botón.'];
    }
    return ['El reparto todavía no está disponible',
      'Aún no se ha realizado el reparto, así que no hay ningún texto que mostrar. ' +
      'Vuelve más tarde: el estado de arriba se actualiza solo.'];
  }

  // Consulta el resultado de la persona que ha accedido (sin volver a pedir sus datos)
  async function fetchResult() {
    if (!session) return;
    const out = $('result-output');
    const btn = $('btn-result');
    const who = session;                       // por si cambia de persona mientras se consulta
    clearResult();

    setBusy(btn, true, 'Consultando…');
    const r = await callPublic('result', { pin: who.pin });
    setBusy(btn, false);
    if (session !== who) return;

    if (r.ok && r.code === 'OK' && typeof r.text === 'string') {
      showResult(r.text);
      return;
    }
    if (r.ok && r.code === 'PENDING') {
      const m = pendingMessage(r.registration);
      showFeedback(out, 'info', m[0], m[1]);
      loadEvent(true);
      return;
    }
    switch (r.code) {
      case 'NOT_APPROVED':
      case 'NOT_IN_DISTRIBUTION':
      case 'EXPIRED':
        showFeedback(out, 'info', 'Sin resultado', errText(r));
        loadEvent(true);
        break;
      case 'PIN_REQUIRED':
      case 'INVALID_PIN':
        // Tu PIN cambió (por ejemplo, un administrador lo restableció): hay que volver a entrar
        endSession();
        showFeedback($('access-feedback'), 'info', 'Vuelve a entrar', errText(r));
        break;
      default:
        showFeedback(out, 'error', 'No se pudo consultar el resultado', errText(r));
    }
  }

  /* ============================ ZONA DE ADMINISTRACIÓN ======================= */

  const STATUS_LABEL = { pending: 'Pendiente de validar', approved: 'Aprobado', rejected: 'Rechazado' };
  const STATUS_CLS = { pending: 'badge-pending', approved: 'badge-done', rejected: 'badge-error' };

  function adminPhase(s) {
    if (s.purged_at) return 'expired';
    if (s.status === 'distributed') return 'done';
    return s.participants >= s.min_participants ? 'ready' : 'pending';
  }

  function setConfigEnabled(enabled) {
    ['adm-min', 'adm-auto', 'btn-save'].forEach((id) => { $(id).disabled = !enabled; });
  }

  function shareUrl(slug) {
    return location.href.split('#')[0] + '#/e/' + slug;
  }

  function renderAdmin() {
    const s = adminStatus;
    if (!s) return;
    const done = s.status === 'distributed';
    const expired = !!s.purged_at;
    const until = formatDate(s.results_until);

    setText('adm-count', s.participants);
    setText('adm-pending', s.pending);
    setText('adm-min-view', s.min_participants);
    setText('adm-missing', done ? '–' : s.remaining);
    setBadge('adm-badge', adminPhase(s));
    setText('adm-event-name', 'Evento: ' + s.name + ' (' + s.slug + ')');

    if (!adminDirty) {
      $('adm-min').value = String(s.min_participants);
      $('adm-auto').checked = s.auto_distribute === true;
    }

    if (expired) {
      setText('adm-mode-text',
        'Los resultados caducaron: se han borrado los textos y el reparto. El evento ya no admite cambios.');
    } else if (done) {
      const when = formatDate(s.distributed_at);
      setText('adm-mode-text',
        'Reparto realizado' + (when ? ' el ' + when : '') +
        (s.distribution_mode === 'manual' ? ' (iniciado manualmente).' : ' (de forma automática).') +
        (until ? ' Los resultados se podrán consultar hasta el ' + until + ', y después se borrarán.' : ''));
    } else if (s.auto_distribute) {
      setText('adm-mode-text', 'Reparto automático activado: se realizará solo al alcanzar el mínimo de participantes aprobados.');
    } else {
      setText('adm-mode-text', 'Reparto automático desactivado: solo se repartirá cuando tú lo inicies.');
    }

    setConfigEnabled(!done && !expired && !adminBusy);

    const canDistribute = !done && s.participants >= 2;
    const dist = $('btn-distribute');
    const redo = $('btn-redistribute');
    dist.hidden = done || expired;
    redo.hidden = !(done && !expired);
    dist.disabled = !canDistribute || adminBusy;
    redo.disabled = s.participants < 2 || adminBusy;

    if (expired) {
      setText('adm-dist-help', 'Los resultados ya han caducado.');
      setText('adm-dist-note', '');
    } else if (done) {
      setText('adm-dist-help',
        'El reparto está hecho. Puedes repetirlo (se descarta el anterior y se hace otro al azar con los ' +
        'participantes aprobados actuales); quien ya hubiera consultado su resultado verá otro texto.');
      setText('adm-dist-note', s.participants < 2
        ? 'Para repetirlo necesitas al menos 2 participantes aprobados.'
        : 'Si añades, apruebas o quitas gente, el reparto actual puede quedar anulado o desfasado.');
    } else {
      setText('adm-dist-help',
        'Puedes repartir en cualquier momento, aunque no se haya alcanzado el mínimo ' +
        '(se necesitan al menos 2 participantes aprobados).');
      let note;
      if (!canDistribute) note = 'Necesitas al menos 2 participantes aprobados para poder repartir.';
      else if (s.participants < s.min_participants) note = 'Aún no se ha alcanzado el mínimo, pero puedes repartir ya si lo prefieres.';
      else note = 'Mínimo alcanzado: puedes repartir cuando quieras.';
      if (s.pending > 0) {
        note += ' Hay ' + s.pending + ' ' + plural(s.pending, 'registro pendiente', 'registros pendientes') +
                ' de validar que no entrarían en el reparto.';
      }
      setText('adm-dist-note', note);
    }

    // La lista de participantes se puede editar mientras los resultados existan
    $('btn-add-person').disabled = expired || adminBusy;
    renderPartHelp();
  }

  function showAdminPanel(on) {
    $('admin-login').hidden = on;
    $('admin-panel').hidden = !on;
  }

  function resetAdminState() {
    adminToken = '';
    adminSlug = '';
    adminEvents = [];
    adminStatus = null;
    partList = [];
    partSig = '';
    memberList = [];
    memberSig = '';
    partFilter = 'all';
    filterAuto = true;
    adminDirty = false;
    adminBusy = false;
  }

  function logout(message) {
    resetAdminState();
    const dlg = $('person-dialog');
    if (dlg && dlg.open) dlg.close();
    $('adm-token').value = '';
    $('adm-event-select').replaceChildren();
    $('part-list').replaceChildren();
    $('admin-create-form').hidden = true;
    $('btn-new-event').setAttribute('aria-expanded', 'false');
    clearFeedback($('admin-feedback'));
    clearFeedback($('events-feedback'));
    clearFieldErrors(['adm-token', 'adm-min']);
    showAdminPanel(false);
    if (message) showFeedback($('login-feedback'), 'info', null, message);
    else clearFeedback($('login-feedback'));
  }

  /* ---- Eventos ---- */

  function optionLabel(ev) {
    let text = ev.name + ' (' + ev.slug + ') · ' + ev.approved + ' ' + plural(ev.approved, 'aprobado', 'aprobados');
    if (ev.pending > 0) text += ', ' + ev.pending + ' ' + plural(ev.pending, 'pendiente', 'pendientes');
    if (ev.purged_at) text += ' · caducado';
    else if (ev.status === 'distributed') text += ' · repartido';
    return text;
  }

  function renderEventSelect() {
    const sel = $('adm-event-select');
    const sig = JSON.stringify(adminEvents.map((ev) => [ev.slug, optionLabel(ev)]));
    if (sel.dataset.sig !== sig) {
      sel.replaceChildren();
      adminEvents.forEach((ev) => {
        const o = el('option', null, optionLabel(ev));
        o.value = ev.slug;
        sel.appendChild(o);
      });
      sel.dataset.sig = sig;
    }
    sel.value = adminSlug;
    $('adm-share').value = adminSlug ? shareUrl(adminSlug) : '';
  }

  function setEventAreaVisible(visible) {
    $('adm-events-body').hidden = !visible;
    $('adm-event-area').hidden = !visible;
    $('adm-events-empty').hidden = visible;
  }

  function applyEvents(r) {
    adminEvents = Array.isArray(r.events) ? r.events : [];
    if (!adminEvents.length) {
      adminSlug = '';
      adminStatus = null;
      setEventAreaVisible(false);
      return false;
    }
    if (!adminEvents.some((ev) => ev.slug === adminSlug)) {
      const preferred = adminEvents.find((ev) => ev.slug === CFG_SLUG) || adminEvents[0];
      adminSlug = preferred.slug;
      adminStatus = null;
      partList = [];
      partSig = '';
      filterAuto = true;
      adminDirty = false;
    }
    setEventAreaVisible(true);
    renderEventSelect();
    return true;
  }

  async function loadAdminAll(silent) {
    const r = await callAdmin('list_events');
    if (r.code === 'UNAUTHORIZED') { logout('Tu sesión ya no es válida. Introduce de nuevo la credencial.'); return r; }
    if (!r.ok) {
      if (!silent) showFeedback($('events-feedback'), 'error', 'No se pudo cargar la lista de eventos', errText(r));
      return r;
    }
    clearFeedback($('events-feedback'));
    if (!applyEvents(r)) return r;
    const s = await loadAdmin(silent);
    if (s.code === 'UNAUTHORIZED') return s;
    const p = await loadParticipants(silent);
    if (p.code === 'UNAUTHORIZED') return p;
    const m = await loadMembers(silent);
    if (m.code === 'UNAUTHORIZED') return m;
    return r;
  }

  async function loadAdmin(silent) {
    const slugAtStart = adminSlug;
    const r = await callAdmin('status');
    if (slugAtStart !== adminSlug) return r;                 // se cambió de evento mientras tanto
    if (r.code === 'UNAUTHORIZED') {
      logout('Tu sesión ya no es válida. Introduce de nuevo la credencial.');
    } else if (r.ok) {
      adminStatus = r;
      renderAdmin();
    } else if (!silent) {
      showFeedback($('admin-feedback'), 'error', 'No se pudo actualizar el estado', errText(r));
    }
    return r;
  }

  async function onEventChange() {
    if (adminBusy) { $('adm-event-select').value = adminSlug; return; }
    adminSlug = $('adm-event-select').value;
    adminStatus = null;
    partList = [];
    partSig = '';
    filterAuto = true;
    adminDirty = false;
    clearFeedback($('admin-feedback'));
    $('adm-share').value = shareUrl(adminSlug);
    $('part-list').replaceChildren();
    await loadAdmin(false);
    if (adminToken) await loadParticipants(false);
  }

  async function copyLink() {
    const input = $('adm-share');
    const fb = $('events-feedback');
    try {
      await navigator.clipboard.writeText(input.value);
      showFeedback(fb, 'success', null, 'Enlace copiado.');
    } catch (e) {
      input.focus();
      input.select();
      showFeedback(fb, 'info', null, 'Selecciona el enlace y cópialo con Ctrl+C (o con «Copiar» del menú).');
    }
  }

  function toggleCreateForm(show) {
    const form = $('admin-create-form');
    form.hidden = !show;
    $('btn-new-event').setAttribute('aria-expanded', String(show));
    if (show) {
      form.dataset.slugTouched = '';
      $('new-name').focus();
    } else {
      form.reset();
      clearFieldErrors(['new-name', 'new-slug', 'new-min', 'new-max']);
    }
  }

  async function onCreateEvent(e) {
    e.preventDefault();
    if (adminBusy) return;
    const fb = $('events-feedback');
    const btn = $('btn-new-create');
    clearFieldErrors(['new-name', 'new-slug', 'new-min', 'new-max']);
    clearFeedback(fb);

    const name = $('new-name').value.trim();
    const slug = $('new-slug').value.trim();
    const minRaw = $('new-min').value.trim();
    const maxRaw = $('new-max').value.trim();
    const min = Number(minRaw);
    const max = Number(maxRaw);

    let invalid = null;
    const bad = (id, msg) => { fieldError(id, msg); invalid = invalid || id; };
    if (!name || name.length > 120) bad('new-name', 'Escribe un nombre de entre 1 y 120 caracteres.');
    if (!SLUG_RE.test(slug)) bad('new-slug', MESSAGES.INVALID_SLUG);
    if (!/^[0-9]+$/.test(minRaw) || min < 2 || min > 100000) bad('new-min', MESSAGES.INVALID_MIN);
    if (!/^[0-9]+$/.test(maxRaw) || max < 1 || max > 10000) bad('new-max', MESSAGES.INVALID_MAX_LEN);
    if (invalid) { $(invalid).focus(); return; }

    setAdminBusy(true, btn, 'Creando…');
    const r = await callAdmin('create_event', {
      slug: slug, name: name, min_participants: min, max_text_length: max,
      auto_distribute: $('new-auto').checked
    });
    if (r.ok) {
      adminSlug = slug;                       // pasa a administrar el evento recién creado
      adminStatus = null;
      partList = [];
      partSig = '';
      filterAuto = true;
      adminDirty = false;
      toggleCreateForm(false);
      await loadAdminAll(true);
    }
    setAdminBusy(false, btn);
    if (r.code === 'UNAUTHORIZED') { logout('Tu sesión ya no es válida. Introduce de nuevo la credencial.'); return; }
    if (r.ok) {
      showFeedback(fb, 'success', 'Evento creado',
        'Ya puedes compartir el enlace de abajo con los participantes. Sus registros aparecerán como pendientes ' +
        'hasta que los apruebes.');
    } else {
      if (r.code === 'SLUG_EXISTS' || r.code === 'INVALID_SLUG') { fieldError('new-slug', errText(r)); $('new-slug').focus(); }
      else if (r.code === 'INVALID_NAME') { fieldError('new-name', errText(r)); $('new-name').focus(); }
      else showFeedback(fb, 'error', 'No se pudo crear el evento', errText(r));
    }
  }

  /* ---- Login ---- */

  async function onAdminLogin(e) {
    e.preventDefault();
    const btn = $('btn-login');
    const lf = $('login-feedback');
    fieldError('adm-token', '');
    clearFeedback(lf);

    const token = $('adm-token').value;
    if (!token.trim()) { fieldError('adm-token', 'Introduce la credencial de administrador.'); $('adm-token').focus(); return; }

    setBusy(btn, true, 'Comprobando…');
    adminToken = token.trim();
    const r = await callAdmin('list_events');
    setBusy(btn, false);

    if (r.code === 'UNAUTHORIZED') {
      adminToken = '';
      fieldError('adm-token', errText(r));
      $('adm-token').focus();
      return;
    }
    if (!r.ok) {
      adminToken = '';
      showFeedback(lf, 'error', 'No se pudo acceder', errText(r));
      return;
    }
    $('adm-token').value = '';
    adminDirty = false;
    clearFeedback($('admin-feedback'));
    clearFeedback($('events-feedback'));
    showAdminPanel(true);
    if (applyEvents(r)) {
      await loadAdmin(true);
      if (adminToken) await loadParticipants(true);
    }
    if (adminToken) {
      const heading = $('adm-events-title');
      heading.tabIndex = -1;
      heading.focus();
    }
  }

  function setAdminBusy(busy, btn, label) {
    adminBusy = busy;
    if (btn) setBusy(btn, busy, label);
    ['btn-save', 'btn-distribute', 'btn-redistribute', 'btn-adm-refresh', 'btn-add-person', 'btn-new-create']
      .forEach((id) => {
        const node = $(id);
        if (!node || (btn && node === btn)) return;
        if (busy) node.disabled = true;
      });
    if (!busy) {
      $('btn-adm-refresh').disabled = false;
      $('btn-new-create').disabled = false;
      if (adminStatus) renderAdmin();
    }
  }

  /* ---- Configuración y reparto ---- */

  async function onAdminSave(e) {
    e.preventDefault();
    if (adminBusy || !adminStatus) return;
    const fb = $('admin-feedback');
    const btn = $('btn-save');
    fieldError('adm-min', '');
    clearFeedback(fb);

    const raw = $('adm-min').value.trim();
    const newMin = Number(raw);
    if (!/^[0-9]+$/.test(raw) || !Number.isInteger(newMin) || newMin < 2 || newMin > 100000) {
      fieldError('adm-min', MESSAGES.INVALID_MIN);
      $('adm-min').focus();
      return;
    }
    const newAuto = $('adm-auto').checked;
    const minChanged = newMin !== adminStatus.min_participants;
    const autoChanged = newAuto !== (adminStatus.auto_distribute === true);
    if (!minChanged && !autoChanged) {
      adminDirty = false;
      showFeedback(fb, 'info', null, 'No hay cambios que guardar.');
      return;
    }

    // Si, con la nueva configuración, el reparto se ejecutaría al instante, se avisa antes.
    if (newAuto && adminStatus.participants >= newMin) {
      const ok = await confirmDialog({
        title: 'Esta configuración repartirá ahora',
        message: 'Con el reparto automático activado y un mínimo de ' + newMin + ', ya se cumple la condición ' +
                 '(hay ' + adminStatus.participants + ' participantes aprobados). Al guardar se hará el reparto de ' +
                 'inmediato.',
        okText: 'Guardar y repartir',
        danger: true
      });
      if (!ok) return;
    }

    setAdminBusy(true, btn, 'Guardando…');
    // Orden pensado para que el modo nunca reparta con una configuración a medias:
    //  - al DESACTIVAR el automático se aplica primero el modo y luego el mínimo;
    //  - al ACTIVARLO se aplica primero el mínimo y luego el modo.
    const steps = [];
    const stepMin = () => callAdmin('set_min', { min_participants: newMin });
    const stepAuto = () => callAdmin('set_auto', { auto_distribute: newAuto });
    if (autoChanged && !newAuto) steps.push(stepAuto);
    if (minChanged) steps.push(stepMin);
    if (autoChanged && newAuto) steps.push(stepAuto);

    let distributed = false;
    let failure = null;
    for (const step of steps) {
      const r = await step();
      if (!r.ok) { failure = r; break; }
      if (r.distributed) distributed = true;
    }
    adminDirty = false;
    const status = await loadAdminAll(true);
    setAdminBusy(false, btn);
    if (status.code === 'UNAUTHORIZED') return;

    if (failure) {
      showFeedback(fb, 'error', 'No se pudo guardar la configuración', errText(failure));
      if (failure.code === 'INVALID_MIN') fieldError('adm-min', errText(failure));
    } else if (distributed) {
      showFeedback(fb, 'success', 'Configuración guardada y reparto realizado',
        'Se cumplía el mínimo con el modo automático, así que el reparto se ha hecho ahora.');
    } else {
      showFeedback(fb, 'success', 'Configuración guardada', 'Los cambios se han aplicado correctamente.');
    }
  }

  async function onAdminDistribute() {
    if (adminBusy || !adminStatus || adminStatus.status === 'distributed') return;
    const fb = $('admin-feedback');
    const btn = $('btn-distribute');
    clearFeedback(fb);

    const n = adminStatus.participants;
    const belowMin = n < adminStatus.min_participants;
    const ok = await confirmDialog({
      title: '¿Iniciar el reparto ahora?',
      message: 'Se repartirán los textos entre ' + n + ' ' + plural(n, 'participante aprobado', 'participantes aprobados') + '. ' +
               (belowMin ? 'Todavía no se ha alcanzado el mínimo (' + adminStatus.min_participants + '). ' : '') +
               (adminStatus.pending > 0
                 ? 'Los ' + adminStatus.pending + ' registros pendientes de validar se quedarán fuera. ' : '') +
               'El registro se cerrará. Después podrás repetir el reparto si hace falta.',
      okText: 'Repartir ahora',
      danger: true
    });
    if (!ok) return;

    setAdminBusy(true, btn, 'Repartiendo…');
    const r = await callAdmin('distribute');
    const status = await loadAdminAll(true);
    setAdminBusy(false, btn);
    if (status.code === 'UNAUTHORIZED') return;

    if (r.ok) {
      showFeedback(fb, 'success', 'Reparto realizado',
        'Los textos se han repartido entre ' + r.participants + ' ' +
        plural(r.participants, 'participante', 'participantes') + '. Ya pueden consultar su resultado.');
    } else {
      showFeedback(fb, 'error', 'No se pudo realizar el reparto', errText(r));
    }
  }

  async function onAdminRedistribute() {
    if (adminBusy || !adminStatus || adminStatus.status !== 'distributed' || adminStatus.purged_at) return;
    const fb = $('admin-feedback');
    const btn = $('btn-redistribute');
    clearFeedback(fb);

    const n = adminStatus.participants;
    const ok = await confirmDialog({
      title: '¿Repetir el reparto?',
      message: 'Se descartará el reparto actual y se hará otro al azar entre los ' + n + ' participantes aprobados. ' +
               'Quien ya haya consultado su resultado verá, al volver a consultarlo, otro texto distinto.',
      okText: 'Repetir el reparto',
      danger: true
    });
    if (!ok) return;

    setAdminBusy(true, btn, 'Repartiendo…');
    const r = await callAdmin('redistribute');
    const status = await loadAdminAll(true);
    setAdminBusy(false, btn);
    if (status.code === 'UNAUTHORIZED') return;

    if (r.ok) {
      showFeedback(fb, 'success', 'Reparto repetido',
        'Se ha hecho un reparto nuevo entre ' + r.participants + ' ' +
        plural(r.participants, 'participante', 'participantes') + '. El anterior ha quedado descartado.');
    } else {
      showFeedback(fb, 'error', 'No se pudo repetir el reparto', errText(r));
    }
  }

  async function onAdminRefresh() {
    if (adminBusy) return;
    const btn = $('btn-adm-refresh');
    adminDirty = false;
    clearFeedback($('admin-feedback'));
    setBusy(btn, true, 'Actualizando…');
    const r = await loadAdminAll(false);
    setBusy(btn, false);
    if (r.ok) showFeedback($('admin-feedback'), 'info', null, 'Estado actualizado.');
  }

  /* ---- Participantes ---- */

  async function loadParticipants(silent) {
    const slugAtStart = adminSlug;
    const r = await callAdmin('list_participants');
    if (slugAtStart !== adminSlug) return r;
    if (r.code === 'UNAUTHORIZED') {
      logout('Tu sesión ya no es válida. Introduce de nuevo la credencial.');
    } else if (r.ok) {
      const list = Array.isArray(r.participants) ? r.participants : [];
      const sig = JSON.stringify(list);
      if (sig !== partSig) {
        partSig = sig;
        partList = list;
        if (filterAuto) {
          partFilter = list.some((p) => p.status === 'pending') ? 'pending' : 'all';
          filterAuto = false;
        }
        renderParticipants();
      }
    } else if (!silent) {
      showFeedback($('admin-feedback'), 'error', 'No se pudo cargar la lista de participantes', errText(r));
    }
    return r;
  }

  /* ---- Participantes guardados ---- */

  async function loadMembers(silent) {
    const r = await callAdmin('list_members');
    if (r.code === 'UNAUTHORIZED') {
      logout('Tu sesión ya no es válida. Introduce de nuevo la credencial.');
    } else if (r.ok) {
      const list = Array.isArray(r.members) ? r.members : [];
      const sig = JSON.stringify(list);
      if (sig !== memberSig) {
        memberSig = sig;
        memberList = list;
        renderMembers();
      }
    } else if (!silent) {
      showFeedback($('admin-feedback'), 'error', 'No se pudo cargar la lista de guardados', errText(r));
    }
    return r;
  }

  function renderMembers() {
    const ul = $('members-list');
    ul.replaceChildren();
    setText('members-count', String(memberList.length));
    $('members-empty').hidden = memberList.length > 0;
    memberList.forEach((m) => {
      const li = el('li', 'person');
      const head = el('div', 'person-head');
      head.appendChild(el('span', 'person-name', m.name + ' ' + m.surname));
      const acts = el('span', 'person-badges');
      const pb = el('button', 'btn btn-small btn-secondary', m.has_pin ? 'Nuevo PIN' : 'Generar PIN');
      pb.type = 'button';
      pb.addEventListener('click', () => resetMemberPin(m, pb));
      if (m.has_pin) {
        const sb = el('button', 'btn btn-small btn-ghost', 'Mostrar PIN');
        sb.type = 'button';
        sb.addEventListener('click', () => revealPin('member', m, sb));
        acts.appendChild(sb);
      }
      acts.appendChild(pb);
      const b = el('button', 'btn btn-small btn-danger', 'Quitar de guardados');
      b.type = 'button';
      b.addEventListener('click', () => forgetMember(m, b));
      acts.appendChild(b);
      head.appendChild(acts);
      li.appendChild(head);
      li.appendChild(el('p', 'person-meta',
        'Guardado el ' + formatDate(m.created_at) + ' · último registro el ' + formatDate(m.last_seen_at) +
        (!m.has_pin ? ' · sin PIN: genera uno para que pueda entrar'
          : (m.can_show_pin ? '' : ' · PIN no consultable (creado antes): pulsa «Nuevo PIN»'))));
      ul.appendChild(li);
    });
  }

  /* ---- Importar personas con PIN existentes ---- */

  const IMPORT_MSG = {
    INVALID_NAME: 'nombre no válido', INVALID_SURNAME: 'falta el apellido o no es válido',
    INVALID_PIN: 'PIN con formato incorrecto (debe ser SION-XXXXXX)', PIN_TAKEN: 'ese PIN ya es de otra persona'
  };

  async function importMembers() {
    if (adminBusy) return;
    const fb = $('import-feedback');
    const btn = $('btn-import');
    clearFeedback(fb);
    const lines = $('import-text').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const rows = [];
    const problems = [];
    lines.forEach((line, i) => {
      const parts = line.split(/[;\t,]/).map((x) => x.trim());
      if (parts.length < 3 || !parts[0] || !parts[1]) {
        problems.push('Línea ' + (i + 1) + ': usa «Nombre; Apellidos; PIN».');
        return;
      }
      rows.push({ name: parts[0], surname: parts[1], pin: normPin(parts[2]), line: i + 1 });
    });
    if (!rows.length) {
      showFeedback(fb, 'error', 'No hay nada que importar', problems.join(' ') || 'Escribe al menos una persona.');
      return;
    }
    if (rows.length > 500) { showFeedback(fb, 'error', 'Demasiadas personas', 'El máximo es 500 por importación.'); return; }
    setAdminBusy(true, btn, 'Importando…');
    const r = await callAdmin('import_members', { rows: rows.map((x) => ({ name: x.name, surname: x.surname, pin: x.pin })) });
    if (r.ok) {
      (r.results || []).forEach((x) => {
        if (x.code !== 'ADDED' && x.code !== 'UPDATED') {
          problems.push('Línea ' + rows[x.row - 1].line + ' (' + rows[x.row - 1].name + '): ' + (IMPORT_MSG[x.code] || x.code) + '.');
        }
      });
    }
    const all = await loadAdminAll(true);
    setAdminBusy(false, btn);
    if (all.code === 'UNAUTHORIZED') return;
    if (!r.ok) { showFeedback(fb, 'error', 'No se pudo importar', errText(r)); return; }
    const summary = r.added + ' añadidas, ' + r.updated + ' actualizadas' + (r.errors ? ', ' + r.errors + ' con error' : '') + '.';
    if (problems.length) showFeedback(fb, r.added + r.updated ? 'info' : 'error', summary, problems.join(' '));
    else { showFeedback(fb, 'success', null, summary); $('import-text').value = ''; }
  }

  async function resetMemberPin(m, btn) {
    if (adminBusy) return;
    const fb = $('admin-feedback');
    clearFeedback(fb);
    if (m.has_pin) {
      const ok = await confirmDialog({
        title: '¿Generar un PIN nuevo para ' + m.name + ' ' + m.surname + '?',
        message: 'El PIN actual dejará de valer. El nuevo se mostrará una sola vez.',
        okText: 'Generar',
        danger: false
      });
      if (!ok) return;
    }
    setAdminBusy(true, btn, '…');
    const r = await callAdmin('reset_member_pin', { id: m.id });
    const all = await loadAdminAll(true);
    setAdminBusy(false, btn);
    if (all.code === 'UNAUTHORIZED') return;
    if (r.ok && typeof r.pin === 'string') showPinDialog(m.name + ' ' + m.surname, r.pin);
    else showFeedback(fb, 'error', 'No se pudo generar el PIN', errText(r));
  }

  async function forgetMember(m, btn) {
    if (adminBusy) return;
    const fb = $('admin-feedback');
    clearFeedback(fb);
    const ok = await confirmDialog({
      title: '¿Quitar a ' + m.name + ' ' + m.surname + ' de guardados?',
      message: 'En el próximo evento volverá a necesitar validación y recibirá un PIN nuevo. ' +
               'Sus registros en eventos anteriores no cambian.',
      okText: 'Quitar',
      danger: true
    });
    if (!ok) return;
    setAdminBusy(true, btn, '…');
    const r = await callAdmin('forget_member', { id: m.id });
    const all = await loadAdminAll(true);
    setAdminBusy(false, btn);
    if (all.code === 'UNAUTHORIZED') return;
    if (r.ok) showFeedback(fb, 'success', null, m.name + ' ' + m.surname + ' ya no está en guardados.');
    else showFeedback(fb, 'error', 'No se pudo quitar de guardados', errText(r));
  }

  function renderPartHelp() {
    const s = adminStatus;
    if (!s) return;
    let text = 'Los registros nuevos quedan pendientes hasta que los apruebes; al aprobar, la persona queda guardada y ' +
               'en los próximos eventos entrará aprobada sola al enviar su intención con su PIN. Aquí ves el texto de cada persona para ' +
               'revisarlo; nunca se muestra quién recibe qué.';
    if (s.purged_at) {
      text = 'Los resultados caducaron: se han borrado los textos y el reparto. Se conservan los nombres como registro.';
    } else if (s.status === 'distributed') {
      text += ' Quitar o rechazar a alguien ya repartido anula el reparto; aprobar o añadir a alguien nuevo no lo ' +
              'cambia hasta que lo repitas.';
    }
    setText('adm-people-help', text);
  }

  function partMatches(p) { return partFilter === 'all' || p.status === partFilter; }

  function renderFilters() {
    const box = $('part-filters');
    const counts = { all: partList.length, pending: 0, approved: 0, rejected: 0 };
    partList.forEach((p) => { if (counts[p.status] !== undefined) counts[p.status] += 1; });
    const defs = [['all', 'Todos'], ['pending', 'Pendientes'], ['approved', 'Aprobados'], ['rejected', 'Rechazados']];
    box.replaceChildren();
    defs.forEach((d) => {
      const b = el('button', 'btn btn-ghost btn-small', d[1] + ' (' + counts[d[0]] + ')');
      b.type = 'button';
      b.setAttribute('aria-pressed', String(partFilter === d[0]));
      b.addEventListener('click', () => { partFilter = d[0]; renderParticipants(); });
      box.appendChild(b);
    });
  }

  function renderParticipants() {
    renderFilters();
    const list = $('part-list');
    const empty = $('part-empty');

    // Conserva qué textos estaban desplegados y dónde estaba el foco
    const open = new Set();
    list.querySelectorAll('li[data-id] details[open]').forEach((d) => open.add(d.closest('li').dataset.id));

    list.replaceChildren();
    const visible = partList.filter(partMatches);
    visible.forEach((p) => list.appendChild(renderPerson(p, open.has(p.id))));

    if (!visible.length) {
      empty.hidden = false;
      empty.textContent = partList.length
        ? 'No hay participantes en este filtro.'
        : (adminStatus && adminStatus.purged_at
            ? 'No quedan participantes: se borraron al caducar los resultados.'
            : 'Todavía no se ha registrado nadie en este evento.');
    } else {
      empty.hidden = true;
    }
    renderPartHelp();
  }

  function renderPerson(p, isOpen) {
    const s = adminStatus || {};
    const li = el('li', 'person');
    li.dataset.id = p.id;

    const head = el('div', 'person-head');
    head.appendChild(el('span', 'person-name', p.name + ' ' + p.surname));
    const badges = el('span', 'person-badges');
    badges.appendChild(el('span', 'badge ' + (STATUS_CLS[p.status] || 'badge-muted'), STATUS_LABEL[p.status] || p.status));
    if (p.saved) badges.appendChild(el('span', 'badge badge-muted', 'Guardado'));
    if (s.status === 'distributed' && !s.purged_at) {
      badges.appendChild(p.in_distribution
        ? el('span', 'badge badge-ready', 'En el reparto')
        : el('span', 'badge badge-muted', 'Fuera del reparto'));
    }
    head.appendChild(badges);
    li.appendChild(head);

    const when = formatDate(p.created_at);
    const rev = formatDate(p.reviewed_at);
    li.appendChild(el('p', 'person-meta',
      'Registrado el ' + when + (rev ? ' · revisado el ' + rev : '') +
      (!p.has_pin ? ' · sin PIN' : (p.can_show_pin ? '' : ' · PIN no consultable (creado antes): usa «Editar» → nuevo PIN'))));

    if (typeof p.content === 'string' && p.content) {
      const det = document.createElement('details');
      det.open = !!isOpen;
      det.appendChild(el('summary', null, 'Ver texto (' + p.content.length + ' caracteres)'));
      det.appendChild(el('div', 'person-text', p.content));
      li.appendChild(det);
    }

    if (!s.purged_at) {
      const actions = el('div', 'person-actions');
      const add = (label, cls, handler) => {
        const b = el('button', 'btn btn-small ' + cls, label);
        b.type = 'button';
        b.addEventListener('click', () => handler(b));
        actions.appendChild(b);
      };
      if (p.status !== 'approved') add('Aprobar', 'btn-primary', (b) => changeStatus(p, 'approved', b));
      if (p.status !== 'rejected') add('Rechazar', 'btn-secondary', (b) => changeStatus(p, 'rejected', b));
      if (p.status !== 'pending') add('Volver a pendiente', 'btn-ghost', (b) => changeStatus(p, 'pending', b));
      if (p.has_pin) {
        add('Mostrar PIN', 'btn-ghost', (b) => revealPin('participant', p, b));
      }
      add('Editar', 'btn-ghost', () => openPersonDialog(p));
      add('Eliminar', 'btn-danger', (b) => removePerson(p, b));
      li.appendChild(actions);
    }
    return li;
  }

  function resultMessage(r, base) {
    let text = base;
    if (r.reset && r.distributed) text += ' El reparto anterior se anuló y, al cumplirse el mínimo, se ha hecho uno nuevo.';
    else if (r.reset) text += ' El reparto anterior se ha anulado: el evento vuelve a estar abierto hasta que se reparta de nuevo.';
    else if (r.distributed) text += ' Se ha alcanzado el mínimo y el reparto automático se ha realizado.';
    if (r.needs_redistribution) text += ' Esa persona no entra en el reparto actual hasta que lo repitas.';
    return text;
  }

  async function changeStatus(p, status, btn) {
    if (adminBusy || !adminStatus) return;
    const fb = $('admin-feedback');
    clearFeedback(fb);
    const labels = { approved: 'aprobada', rejected: 'rechazada', pending: 'devuelta a pendiente' };

    if (adminStatus.status === 'distributed' && p.status === 'approved') {
      const ok = await confirmDialog({
        title: '¿Anular el reparto?',
        message: p.name + ' ' + p.surname + ' ya está incluido en el reparto. Si deja de estar aprobado, el reparto ' +
                 'actual se anula y el evento se reabre.',
        okText: 'Anular y continuar',
        danger: true
      });
      if (!ok) return;
    }

    setAdminBusy(true, btn, '…');
    const r = await callAdmin('set_participant_status', { id: p.id, status: status });
    const all = await loadAdminAll(true);
    setAdminBusy(false, btn);
    if (all.code === 'UNAUTHORIZED') return;
    if (r.ok) {
      showFeedback(fb, 'success', null,
        resultMessage(r, 'Persona ' + labels[status] + ': ' + p.name + ' ' + p.surname + '.'));
    } else {
      showFeedback(fb, 'error', 'No se pudo cambiar el estado', errText(r));
    }
  }

  async function removePerson(p, btn) {
    if (adminBusy || !adminStatus) return;
    const fb = $('admin-feedback');
    clearFeedback(fb);
    const resets = adminStatus.status === 'distributed' && p.status === 'approved';
    const ok = await confirmDialog({
      title: '¿Eliminar a ' + p.name + ' ' + p.surname + '?',
      message: 'Se borrarán sus datos y su texto de este evento. No se puede deshacer.' +
               (resets ? ' Como ya está incluido en el reparto, el reparto actual se anulará.' : ''),
      okText: 'Eliminar',
      danger: true
    });
    if (!ok) return;

    setAdminBusy(true, btn, '…');
    const r = await callAdmin('remove_participant', { id: p.id });
    const all = await loadAdminAll(true);
    setAdminBusy(false, btn);
    if (all.code === 'UNAUTHORIZED') return;
    if (r.ok) {
      showFeedback(fb, 'success', null, resultMessage(r, 'Participante eliminado: ' + p.name + ' ' + p.surname + '.'));
    } else {
      showFeedback(fb, 'error', 'No se pudo eliminar', errText(r));
    }
  }

  /* ---- Diálogo de alta / edición ---- */

  function openPersonDialog(p) {
    editingPerson = p || null;
    clearFieldErrors(['per-name', 'per-surname', 'per-text', 'per-pin']);
    clearFeedback($('person-feedback'));
    $('per-name').value = p ? p.name : '';
    $('per-surname').value = p ? p.surname : '';
    $('per-text').value = p && typeof p.content === 'string' ? p.content : '';
    $('per-text').setAttribute('maxlength', String((adminStatus && adminStatus.max_text_length) || 2000));
    $('per-pin').value = '';
    setText('person-title', p ? 'Editar participante' : 'Añadir participante');
    $('per-regen').checked = false;
    $('per-regen-wrap').hidden = !p;
    setText('per-pin-label', p ? 'Escribir un PIN concreto (opcional)' : 'PIN (opcional)');
    setText('per-pin-hint', p
      ? 'Déjalo vacío para mantener el PIN actual, o marca «Generar un PIN nuevo». El PIN nuevo se muestra una sola vez.'
      : 'Déjalo vacío y se generará uno (formato SION-XXXXXX) que verás una sola vez. El alta queda aprobada. ' +
        'Si la persona ya estaba guardada, conserva su PIN.');
    const dlg = $('person-dialog');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    $('per-name').focus();
  }

  function closePersonDialog() {
    const dlg = $('person-dialog');
    if (typeof dlg.close === 'function' && dlg.open) dlg.close();
    else dlg.removeAttribute('open');
    editingPerson = null;
  }

  async function onPersonSubmit(e) {
    e.preventDefault();
    if (adminBusy || !adminStatus) return;
    const btn = $('person-save');
    const fb = $('person-feedback');
    clearFieldErrors(['per-name', 'per-surname', 'per-text', 'per-pin']);
    clearFeedback(fb);

    const name = $('per-name').value.trim();
    const surname = $('per-surname').value.trim();
    const text = $('per-text').value.trim();
    const pin = normPin($('per-pin').value);
    const max = Number(adminStatus.max_text_length) || 2000;

    let invalid = null;
    const bad = (id, msg) => { fieldError(id, msg); invalid = invalid || id; };
    if (!name || name.length > 60) bad('per-name', 'El nombre debe tener entre 1 y 60 caracteres.');
    if (!surname || surname.length > 60) bad('per-surname', 'Los apellidos deben tener entre 1 y 60 caracteres.');
    if (!text) bad('per-text', 'El texto no puede estar vacío.');
    else if (text.length > max) bad('per-text', 'El texto no puede superar los ' + max + ' caracteres.');
    if (pin && !PIN_RE.test(pin)) bad('per-pin', 'El PIN debe tener el formato SION-XXXXXX (6 letras o cifras).');
    if (invalid) { $(invalid).focus(); return; }

    const adding = !editingPerson;
    const person = editingPerson;
    setAdminBusy(true, btn, 'Guardando…');
    const r = adding
      ? await callAdmin('add_participant', { name: name, surname: surname, text: text, pin: pin || null })
      : await callAdmin('update_participant', {
          id: person.id, name: name, surname: surname, text: text, pin: pin || null,
          regen_pin: $('per-regen').checked
        });

    if (!r.ok) {
      setAdminBusy(false, btn);
      if (r.code === 'UNAUTHORIZED') { logout('Tu sesión ya no es válida. Introduce de nuevo la credencial.'); return; }
      switch (r.code) {
        case 'NAME_TAKEN':
        case 'INVALID_NAME': fieldError('per-name', errText(r)); $('per-name').focus(); break;
        case 'INVALID_SURNAME': fieldError('per-surname', errText(r)); $('per-surname').focus(); break;
        case 'INVALID_TEXT':
        case 'TEXT_TOO_LONG': fieldError('per-text', errText(r)); $('per-text').focus(); break;
        case 'PIN_TAKEN':
        case 'INVALID_PIN': fieldError('per-pin', errText(r)); $('per-pin').focus(); break;
        default: showFeedback(fb, 'error', 'No se pudo guardar', errText(r));
      }
      return;
    }

    closePersonDialog();
    const all = await loadAdminAll(true);
    setAdminBusy(false, btn);
    if (all.code === 'UNAUTHORIZED') return;
    const msg = adding
      ? resultMessage(r, 'Participante añadido y aprobado: ' + name + ' ' + surname + '.')
      : 'Datos actualizados: ' + name + ' ' + surname + '.' +
        (adminStatus && adminStatus.status === 'distributed' && !adminStatus.purged_at
          ? ' Si cambiaste su texto, quien lo recibió verá el texto nuevo.' : '');
    showFeedback($('admin-feedback'), 'success', null, msg);
    if (typeof r.pin === 'string') showPinDialog(name + ' ' + surname, r.pin);
  }

  /* Mostrar el PIN guardado (cifrado en el servidor; solo se descifra con la credencial de admin) */
  async function revealPin(kind, p, btn) {
    if (adminBusy) return;
    const fb = $('admin-feedback');
    clearFeedback(fb);
    setAdminBusy(true, btn, '…');
    const r = await callAdmin('reveal_pin', { kind, id: p.id });
    setAdminBusy(false, btn);
    if (r.code === 'UNAUTHORIZED') return;
    if (r.ok && typeof r.pin === 'string') showPinDialog(p.name + ' ' + p.surname, r.pin, true);
    else showFeedback(fb, 'error', 'No se pudo mostrar el PIN', errText(r));
  }

  /* PIN en pantalla (recién generado o consultado) */
  function showPinDialog(who, pin, consulted) {
    setText('pin-dialog-title', consulted ? 'PIN guardado' : 'PIN generado');
    setText('pin-dialog-text', 'PIN de ' + who + ':');
    setText('pin-dialog-pin', pin);
    $('pin-dialog-copy').textContent = 'Copiar PIN';
    const dlg = $('pin-dialog');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    $('pin-dialog-close').focus();
  }

  function closePinDialog() {
    const dlg = $('pin-dialog');
    setText('pin-dialog-pin', '');
    if (typeof dlg.close === 'function' && dlg.open) dlg.close();
    else dlg.removeAttribute('open');
  }

  /* ================================== Rutas ================================== */

  function currentRoute() {
    return /^#\/admin/.test(location.hash) ? 'admin' : 'participant';
  }

  function applyRoute() {
    route = currentRoute();
    const isAdmin = route === 'admin';
    $('view-participant').hidden = isAdmin;
    $('view-admin').hidden = !isAdmin;
    $('nav-participant').classList.toggle('active', !isAdmin);
    $('nav-admin').classList.toggle('active', isAdmin);
    if (isAdmin) $('nav-admin').setAttribute('aria-current', 'page'); else $('nav-admin').removeAttribute('aria-current');
    if (!isAdmin) $('nav-participant').setAttribute('aria-current', 'page'); else $('nav-participant').removeAttribute('aria-current');

    if (!isAdmin) document.title = (eventInfo && eventInfo.name ? eventInfo.name + ' · ' : '') + 'Intercambio de textos';
    else document.title = 'Administración · Intercambio de textos';

    // Al salir de la zona de administración se cierra la sesión: el token solo vive en memoria.
    if (!isAdmin && adminToken) {
      logout('Has salido de la zona de administración y la sesión se ha cerrado. Introduce de nuevo la credencial.');
    }

    // Si cambia el evento del enlace, se descarta lo que se mostraba del anterior
    if (!isAdmin && loadedSlug !== null && loadedSlug !== participantSlug()) {
      eventInfo = null;
      loadedSlug = null;
        endSession();                       // otro evento: hay que volver a acceder
      setBadge('phase-badge', null);
      $('phase-badge').textContent = 'Cargando…';
      setText('phase-text', 'Consultando el estado del evento…');
    }

    if (!sb) return;
    if (!isAdmin) loadEvent(true);

    if (!firstRoute) $(isAdmin ? 'title-admin' : 'title-participant').focus();
    firstRoute = false;
  }

  function tick() {
    if (document.hidden || !sb) return;
    if (route === 'participant') loadEvent(true);
    else if (adminToken && !adminBusy && !$('person-dialog').open) loadAdminAll(true);
  }

  /* =============================== Arranque ================================== */

  // Red de seguridad: detecta una clave SECRETA pegada por error en config.js
  // (service_role en formato JWT o sb_secret_...). Nunca debe usarse en el navegador.
  function isSecretKey(key) {
    if (/^sb_secret_/i.test(key)) return true;
    const parts = key.split('.');
    if (parts.length !== 3) return false;
    try {
      const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
      return !!payload && payload.role === 'service_role';
    } catch (e) {
      return false;
    }
  }

  function configProblem() {
    const url = String(cfg.SUPABASE_URL || '');
    const key = String(cfg.SUPABASE_ANON_KEY || '');
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      return 'No se pudo cargar el SDK de Supabase. Comprueba tu conexión o consulta «Errores habituales» en el README.';
    }
    if (!/^https?:\/\//.test(url) || /TU_PROJECT_REF/.test(url)) {
      return 'Falta configurar SUPABASE_URL en config.js (Project URL de tu proyecto de Supabase).';
    }
    if (!key || /TU_CLAVE/.test(key)) {
      return 'Falta configurar SUPABASE_ANON_KEY en config.js (clave pública «anon» de Supabase).';
    }
    if (isSecretKey(key)) {
      return '¡PELIGRO! La clave de config.js es una clave SECRETA (service_role / secret), no la pública. ' +
             'La web se ha detenido. Sustitúyela por la clave anon / publishable y, si ya publicaste este archivo, ' +
             'genera una clave nueva en Supabase (Project Settings > API) porque la actual ha quedado expuesta.';
    }
    if (CFG_SLUG && !SLUG_RE.test(CFG_SLUG)) {
      return 'EVENT_SLUG de config.js no es válido: usa 3 a 40 caracteres entre minúsculas, números y guiones (o déjalo vacío).';
    }
    return '';
  }

  function disableEverything() {
    document.querySelectorAll('form').forEach((form) => {
      Array.prototype.forEach.call(form.elements, (node) => { node.disabled = true; });
    });
    $('btn-refresh').disabled = true;
    setBadge('phase-badge', null);
    $('phase-badge').textContent = 'Sin configurar';
    setText('phase-text', 'La aplicación no está configurada.');
  }

  /* Frase del pie: una sola línea que ocupa justo el ancho del contenido (se reajusta al cambiar el tamaño) */
  function setupFitLine() {
    const fitEl = document.querySelector('.fit-line');
    if (!fitEl) return;
    const narrow = window.matchMedia('(max-width: 40rem)');   // teléfonos: la frase se parte en varias líneas
    const fit = () => {
      if (narrow.matches) { fitEl.style.fontSize = ''; fitEl.style.display = ''; return; }
      const box = fitEl.parentElement;
      const cs = getComputedStyle(box);
      const avail = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (avail <= 0) return;
      fitEl.style.display = 'inline-block';
      fitEl.style.fontSize = '100px';
      const w = fitEl.getBoundingClientRect().width;
      fitEl.style.display = '';
      if (w > 0) fitEl.style.fontSize = Math.max(6, Math.min(48, (98 * avail) / w)) + 'px';
    };
    fit();
    window.addEventListener('resize', fit);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);
  }

  function init() {
    setupFitLine();
    const problem = configProblem();
    if (problem) {
      const box = $('config-error');
      box.textContent = problem;
      box.hidden = false;
      disableEverything();
      window.addEventListener('hashchange', applyRoute);
      applyRoute();
      return;
    }

    sb = window.supabase.createClient(String(cfg.SUPABASE_URL), String(cfg.SUPABASE_ANON_KEY), {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });

    // Participantes
    $('register-form').addEventListener('submit', onRegister);
    $('access-form').addEventListener('submit', onAccess);
    $('btn-switch-person').addEventListener('click', onSwitchPerson);
    $('btn-result').addEventListener('click', fetchResult);
    $('reg-text').addEventListener('input', updateCounter);
    $('acc-pin').addEventListener('input', () => { fieldError('acc-pin', ''); });
    // Botón «Mostrar/Ocultar» en los campos con data-peek (PIN y credencial)
    document.querySelectorAll('input[data-peek]').forEach((inp) => {
      const wrap = document.createElement('div');
      wrap.className = 'peek-wrap';
      inp.parentNode.insertBefore(wrap, inp);
      wrap.appendChild(inp);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'peek-btn';
      btn.textContent = 'Mostrar';
      btn.setAttribute('aria-pressed', 'false');
      btn.setAttribute('aria-controls', inp.id);
      btn.addEventListener('click', () => {
        const show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        btn.textContent = show ? 'Ocultar' : 'Mostrar';
        btn.setAttribute('aria-pressed', String(show));
        inp.focus();
      });
      wrap.appendChild(btn);
    });
    $('first-form').addEventListener('submit', onFirstTime);
    $('first-text').addEventListener('input', updateCounter);
    $('btn-first-time').addEventListener('click', () => showFirstTime(true));
    $('btn-have-pin').addEventListener('click', () => showFirstTime(false));
    $('btn-copy-pin').addEventListener('click', async () => {
      const btn = $('btn-copy-pin');
      try { await navigator.clipboard.writeText($('sent-pin').textContent); btn.textContent = 'Copiado'; }
      catch (_) { btn.textContent = 'Selecciónalo y cópialo'; }
    });
    $('btn-refresh').addEventListener('click', async () => {
      const btn = $('btn-refresh');
      setBusy(btn, true, 'Actualizando…');
      await loadEvent(false);
      setBusy(btn, false);
    });

    // Administración
    $('admin-login-form').addEventListener('submit', onAdminLogin);
    $('admin-config-form').addEventListener('submit', onAdminSave);
    $('adm-min').addEventListener('input', () => { adminDirty = true; fieldError('adm-min', ''); });
    $('adm-auto').addEventListener('change', () => { adminDirty = true; });
    $('btn-distribute').addEventListener('click', onAdminDistribute);
    $('btn-redistribute').addEventListener('click', onAdminRedistribute);
    $('btn-adm-refresh').addEventListener('click', onAdminRefresh);
    $('btn-logout').addEventListener('click', () => logout('Has cerrado la sesión de administración.'));

    $('adm-event-select').addEventListener('change', onEventChange);
    $('btn-copy-link').addEventListener('click', copyLink);
    $('btn-new-event').addEventListener('click', () => toggleCreateForm($('admin-create-form').hidden));
    $('btn-new-cancel').addEventListener('click', () => toggleCreateForm(false));
    $('admin-create-form').addEventListener('submit', onCreateEvent);
    $('new-name').addEventListener('input', () => {
      const form = $('admin-create-form');
      if (!form.dataset.slugTouched) $('new-slug').value = slugify($('new-name').value);
    });
    $('new-slug').addEventListener('input', () => { $('admin-create-form').dataset.slugTouched = '1'; });

    $('btn-add-person').addEventListener('click', () => openPersonDialog(null));
    $('person-form').addEventListener('submit', onPersonSubmit);
    $('person-cancel').addEventListener('click', closePersonDialog);
    $('pin-dialog-close').addEventListener('click', closePinDialog);
    $('btn-import').addEventListener('click', importMembers);
    $('pin-dialog').addEventListener('close', () => { setText('pin-dialog-pin', ''); });
    $('pin-dialog-copy').addEventListener('click', async () => {
      const b = $('pin-dialog-copy');
      try { await navigator.clipboard.writeText($('pin-dialog-pin').textContent); b.textContent = 'Copiado'; }
      catch (_) { b.textContent = 'Selecciónalo y cópialo'; }
    });
    $('person-dialog').addEventListener('close', () => { editingPerson = null; });

    window.addEventListener('hashchange', applyRoute);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
    setInterval(tick, POLL_MS);

    updateCounter();
    applyRoute();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
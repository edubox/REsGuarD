import { describirMotivo } from './motivos.js';

const claveDe = (f) => (f.estado === 'ok' || f.estado === 'pendiente' ? 'ok' : `${f.estado}|${f.motivo}`);

function textoDe(fuente, detalle) {
  const nombre = `${fuente.owner}/${fuente.repo}`;
  if (claveDe(fuente) === 'ok') return `✅ REsGuarD · ${nombre}\nVuelve a copiarse con normalidad.`;
  const lineas = [
    `${fuente.estado === 'error' ? '🔴' : '🟡'} REsGuarD · ${nombre}`,
    describirMotivo(fuente.motivo),
  ];
  if (detalle) lineas.push(detalle);
  lineas.push(`Se conserva lo ya guardado. Última instantánea: ${fuente.ultima_instantanea ?? 'ninguna'}`);
  return lineas.join('\n');
}

export function crearNotificador({ store, fetch = globalThis.fetch }) {
  async function enviar(texto) {
    let token = null;
    const limpiar = (s) => (token ? String(s).replaceAll(token, '***') : String(s));
    try {
      token = store.ajuste('telegram_token');
      const chat = store.ajuste('telegram_chat');
      if (!token || !chat) return { enviado: false, detalle: 'Telegram no está configurado' };
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: texto, disable_web_page_preview: true }),
        // Un Telegram colgado no debe bloquear el ciclo de copias.
        signal: AbortSignal.timeout(30_000),
      });
      const cuerpo = await r.json().catch(() => ({}));
      if (!r.ok || cuerpo.ok === false) return { enviado: false, detalle: limpiar(cuerpo.description ?? `HTTP ${r.status}`) };
      return { enviado: true };
    } catch (e) {
      return { enviado: false, detalle: limpiar(e?.message ?? e) };
    }
  }

  // Se compara con el último estado avisado con éxito, no con el estado anterior:
  // así un aviso que no pudo salir se reintenta en la copia siguiente.
  async function avisar(fuente, { detalle = null } = {}) {
    const clave = claveDe(fuente);
    if (clave === (fuente.clave_avisada ?? 'ok')) return { enviado: false, detalle: 'sin cambios' };
    const r = await enviar(textoDe(fuente, detalle));
    if (r.enviado) {
      // El aviso ya salió: si no se puede anotar, como mucho se repetirá.
      try {
        store.actualizarFuente(fuente.id, { clave_avisada: clave });
      } catch { /* se repetirá en la copia siguiente */ }
    }
    return r;
  }

  return { enviar, avisar };
}

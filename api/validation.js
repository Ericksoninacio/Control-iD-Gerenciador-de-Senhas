// Validações puras (sem acesso a rede, DOM ou APIs do Chrome).

export const REFERENCE_FIRMWARES = Object.freeze(['6.23.0']);
export const REFERENCE_SECBOX = '2.2.3';
export const LIMITS = Object.freeze({
  timeoutMin: 500,
  timeoutMax: 30000,
  concurrencyMin: 1,
  concurrencyMax: 10,
});

export function parseIntStrict(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return /^\d{1,5}$/.test(t) ? Number(t) : null;
}

export function isValidIpv4(ip) {
  if (typeof ip !== 'string') return false;
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255 && String(Number(p)) === p);
}

/** Gera a lista de IPs a partir de base ("172.15.30."), inicial e final. */
export function buildRange({ base, start, end }) {
  const errors = [];
  let b = String(base ?? '').trim();
  if (b && !b.endsWith('.')) b += '.';
  if (!/^(\d{1,3}\.){3}$/.test(b) || !isValidIpv4(b + '1')) {
    errors.push('IP base inválido. Use o formato 172.15.30. (três octetos).');
  }
  const s = parseIntStrict(start);
  const e = parseIntStrict(end);
  if (s === null || s < 1 || s > 254) errors.push('IP inicial deve ser um inteiro entre 1 e 254.');
  if (e === null || e < 1 || e > 254) errors.push('IP final deve ser um inteiro entre 1 e 254.');
  if (s !== null && e !== null && s > e) errors.push('IP inicial não pode ser maior que o IP final.');
  if (errors.length) return { ok: false, errors, ips: [] };
  const ips = [];
  for (let i = s; i <= e; i++) ips.push(b + i);
  return { ok: true, errors: [], ips };
}

export function validatePort(value) {
  const n = parseIntStrict(value);
  if (n === null || n < 1 || n > 65535) return { ok: false, error: 'Porta deve ser um inteiro entre 1 e 65535.' };
  return { ok: true, value: n };
}

export function validateBounded(value, min, max, label) {
  const n = parseIntStrict(value);
  if (n === null || n < min || n > max) return { ok: false, error: `${label} deve estar entre ${min} e ${max}.` };
  return { ok: true, value: n };
}

export function validatePasswordFields({ current, next, confirm, allowSame = false }) {
  const errors = [];
  if (!current) errors.push('Informe a senha atual.');
  if (!next) errors.push('Informe a nova senha.');
  if (next !== confirm) errors.push('A confirmação não confere com a nova senha.');
  if (next && current && next === current && !allowSame) {
    errors.push('A nova senha é igual à atual. Confirme explicitamente para prosseguir.');
  }
  return { ok: errors.length === 0, errors };
}

/** Texto vindo do equipamento só é exibido se tiver formato simples. */
export function safeText(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '?';
  const s = String(value);
  return /^[\w.\-/ ]{1,40}$/.test(s) ? s : '?';
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Classifica a resposta de POST /login.fcgi.
 * HTTP 200 NUNCA basta: é preciso um campo "session" não vazio.
 */
export function classifyLoginResponse(status, bodyText) {
  const json = tryParseJson(bodyText);
  const isObj = json !== null && typeof json === 'object' && !Array.isArray(json);
  if (status >= 200 && status < 300) {
    if (!isObj) return { kind: 'invalid-json', status };
    if (typeof json.session === 'string' && json.session.length > 0) {
      return { kind: 'ok', status, session: json.session };
    }
    if (json.error) return { kind: 'refused', status };
    return { kind: 'no-session', status };
  }
  if (status === 401 || status === 403) return { kind: 'refused', status };
  return { kind: 'unexpected-status', status };
}

/** Classifica a resposta de POST /system_information.fcgi. */
export function classifySystemInfo(status, bodyText) {
  if (status < 200 || status >= 300) return { ok: false, reason: 'status', status };
  const json = tryParseJson(bodyText);
  if (json === null || typeof json !== 'object' || Array.isArray(json)) return { ok: false, reason: 'json', status };
  if (typeof json.version !== 'string') return { ok: false, reason: 'sem-versao', status };
  return {
    ok: true,
    version: safeText(json.version),
    secbox: safeText(json.secbox_version),
    serial: safeText(json.serial),
    deviceId: safeText(json.device_id),
  };
}

export function firmwareStatus(version) {
  return REFERENCE_FIRMWARES.includes(version) ? 'confirmed' : 'unconfirmed';
}

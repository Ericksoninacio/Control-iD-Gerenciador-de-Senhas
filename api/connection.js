// Camada HTTP mínima: timeout, cancelamento e classificação do tipo de falha.
// Importante: o navegador NÃO distingue "host desligado" de bloqueio por CORS/rede
// local — ambos viram TypeError no fetch(). Por isso o tipo 'network' é genérico.

export class RequestError extends Error {
  /** @param {'timeout'|'aborted'|'network'} kind */
  constructor(kind, message, elapsedMs = 0) {
    super(message);
    this.name = 'RequestError';
    this.kind = kind;
    this.elapsedMs = elapsedMs;
  }
}

export async function request(fetchImpl, url, { method = 'GET', headers, body, timeoutMs, signal } = {}) {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const t0 = performance.now();
  try {
    const res = await fetchImpl(url, {
      method,
      headers,
      body,
      signal: ctrl.signal,
      cache: 'no-store',
      credentials: 'omit',
    });
    const text = await res.text();
    return { status: res.status, text, elapsedMs: Math.round(performance.now() - t0) };
  } catch (err) {
    const elapsedMs = Math.round(performance.now() - t0);
    if (timedOut) throw new RequestError('timeout', 'timeout', elapsedMs);
    if (signal?.aborted) throw new RequestError('aborted', 'aborted', elapsedMs);
    throw new RequestError('network', 'network', elapsedMs);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

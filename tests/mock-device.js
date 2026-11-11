// Equipamento Control iD simulado, usado no lugar de fetch() nos testes.
// Modos: ok | wrongpass | badjson | nosession | http500 | nosysinfo | oldfw | unreachable | timeout

export const MOCK_PASSWORD = 'SenhaSecreta!';
export const MOCK_SESSION = 'SESSION-SECRET-TOKEN';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createMockFetch(devices) {
  const calls = [];
  const state = { inFlight: 0, maxInFlight: 0 };

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const dev = devices[u.hostname];
    calls.push({ host: u.hostname, path: u.pathname, method: init.method });
    if (!dev || dev.mode === 'unreachable') throw new TypeError('Failed to fetch');

    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    try {
      if (dev.mode === 'timeout') {
        await new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }
      if (dev.delayMs) await sleep(dev.delayMs);

      switch (u.pathname) {
        case '/':
          return new Response('<html>iDFace</html>', { status: 200 });
        case '/login.fcgi': {
          if (dev.mode === 'http500') return new Response('erro', { status: 500 });
          if (dev.mode === 'badjson') return new Response('<html>não é json</html>', { status: 200 });
          if (dev.mode === 'nosession') return new Response('{}', { status: 200 });
          const body = JSON.parse(init.body);
          if (dev.mode === 'wrongpass' || body.password !== (dev.password ?? MOCK_PASSWORD)) {
            return new Response('{"error":"invalid"}', { status: 401 });
          }
          return new Response(JSON.stringify({ session: MOCK_SESSION }), { status: 200 });
        }
        case '/system_information.fcgi': {
          if (u.searchParams.get('session') !== MOCK_SESSION) return new Response('{}', { status: 401 });
          if (dev.mode === 'nosysinfo') return new Response('{}', { status: 200 });
          return new Response(
            JSON.stringify({
              version: dev.mode === 'oldfw' ? '5.0.1' : '6.23.0',
              secbox_version: '2.2.3',
              serial: '0M0300/002DAB',
              device_id: '12345',
            }),
            { status: 200 },
          );
        }
        case '/change_login.fcgi': {
          if (u.searchParams.get('session') !== MOCK_SESSION) return new Response('{}', { status: 401 });
          const body = JSON.parse(init.body);
          if (dev.chg === '404') return new Response('nf', { status: 404 });
          if (dev.chg === '500') return new Response('erro', { status: 500 });
          if (dev.chg === 'timeout') {
            await new Promise((_, reject) => {
              init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
            });
          }
          if (dev.chg === 'noapply') return new Response('', { status: 200 });
          if (dev.chg === 'broken') {
            dev.password = 'x-unknown-123';
            return new Response('', { status: 200 });
          }
          dev.password = body.password;
          return new Response('', { status: 200 });
        }
        case '/logout.fcgi':
          return new Response('', { status: 200 });
        default:
          return new Response('not found', { status: 404 });
      }
    } finally {
      state.inFlight--;
    }
  }
  return { fetch: fetchImpl, calls, state };
}

// Diagnóstico por equipamento e varredura de faixa (com limite de concorrência).
// Esta versão NÃO altera senhas. Mensagens são sempre textos fixos deste arquivo:
// nenhum texto livre vindo do equipamento, senha ou token entra nos resultados.

import { RequestError } from '../api/connection.js';
import { probe, login, systemInformation, logout } from '../api/controlid-api.js';
import { firmwareStatus, REFERENCE_FIRMWARES } from '../api/validation.js';

export const STATE = Object.freeze({
  WAITING: 'Aguardando',
  CHECKING: 'Verificando conexão',
  UNREACHABLE: 'Equipamento inacessível',
  REACHABLE: 'Equipamento acessível',
  AUTH_REFUSED: 'Autenticação recusada',
  SESSION: 'Sessão obtida',
  API_OK: 'API validada',
  MANUAL: 'Requer validação manual',
  FW_UNCONFIRMED: 'Firmware não confirmado',
  COMM_ERROR: 'Erro de comunicação',
  CANCELLED: 'Cancelado',
});

/** level: 'connect' (só alcançabilidade) | 'auth' (+ login) | 'validate' (+ system_information e firmware) */
export async function scanDevice(ip, cfg, deps, onUpdate = () => {}) {
  const t0 = performance.now();
  const row = {
    ip,
    state: STATE.CHECKING,
    connection: 'Não verificada',
    auth: 'Não verificada',
    identification: '—',
    apiValidation: 'Não verificada',
    ms: null,
    message: '',
    timestamp: new Date().toISOString(),
  };
  const finish = (state, message, extra = {}) => {
    Object.assign(row, extra, { state, message });
    row.ms = Math.round(performance.now() - t0);
    onUpdate({ ...row });
    return { ...row };
  };
  onUpdate({ ...row });

  const ctx = { fetchImpl: deps.fetchImpl, ip, port: cfg.port, timeoutMs: cfg.timeoutMs, signal: cfg.signal };
  let session = null;
  let stage = 'conexão';

  const transportFailure = (e) => {
    if (e.kind === 'aborted') return finish(STATE.CANCELLED, 'Operação cancelada pelo operador.');
    if (stage === 'conexão') {
      const msg =
        e.kind === 'timeout'
          ? `Sem resposta em ${cfg.timeoutMs} ms.`
          : 'Sem resposta HTTP: equipamento desligado, IP incorreto, bloqueio de rede ou restrição do navegador (CORS/rede local). O Chrome não distingue estes casos.';
      return finish(STATE.UNREACHABLE, msg, { connection: 'Sem resposta' });
    }
    const detail = e.kind === 'timeout' ? 'tempo esgotado' : 'falha de rede';
    return finish(STATE.COMM_ERROR, `Falha de comunicação na etapa "${stage}" (${detail}).`, {
      auth: stage === 'autenticação' ? 'Erro de comunicação' : row.auth,
    });
  };

  try {
    if (deps.hasHostPermission && !(await deps.hasHostPermission(ip))) {
      return finish(STATE.COMM_ERROR, 'Permissão de acesso a este IP não concedida ao navegador.', {
        connection: 'Bloqueada pelo navegador',
      });
    }

    await probe(ctx);
    row.connection = 'Acessível';
    if (cfg.level === 'connect') return finish(STATE.REACHABLE, 'Host respondeu via HTTP.');

    stage = 'autenticação';
    const res = await login(ctx, cfg.username, cfg.password);
    switch (res.kind) {
      case 'ok':
        session = res.session;
        row.auth = 'Aceita';
        break;
      case 'refused':
        return finish(STATE.AUTH_REFUSED, 'Credenciais recusadas pelo equipamento.', { auth: 'Recusada' });
      case 'invalid-json':
        return finish(STATE.MANUAL, `Resposta de login (HTTP ${res.status}) não é JSON.`, { auth: 'Indeterminada' });
      case 'no-session':
        return finish(STATE.MANUAL, `Resposta de login (HTTP ${res.status}) sem identificador de sessão.`, {
          auth: 'Indeterminada',
        });
      default:
        return finish(STATE.MANUAL, `HTTP ${res.status} inesperado no login.`, { auth: 'Indeterminada' });
    }
    if (cfg.level === 'auth') return finish(STATE.SESSION, 'Sessão obtida com as credenciais informadas.');

    stage = 'leitura do sistema';
    const info = await systemInformation(ctx, session);
    if (!info.ok) {
      return finish(STATE.MANUAL, 'system_information não retornou dados interpretáveis.', {
        apiValidation: 'Não confirmada',
      });
    }
    const identification = `Série ${info.serial} · FW ${info.version} · SecBox ${info.secbox}`;
    if (firmwareStatus(info.version) === 'confirmed') {
      return finish(
        STATE.API_OK,
        'Login e leitura do sistema validados no firmware de referência. change_login NÃO foi executado.',
        { identification, firmware: info.version, apiValidation: 'Leitura OK; change_login pendente de teste real' },
      );
    }
    return finish(
      STATE.FW_UNCONFIRMED,
      `Firmware ${info.version} não confirmado (referência: ${REFERENCE_FIRMWARES.join(', ')}). Login e leitura OK; a alteração pode ser liberada manualmente, com cautela.`,
      { identification, firmware: info.version, apiValidation: 'Leitura OK; firmware fora da referência' },
    );
  } catch (e) {
    if (e instanceof RequestError) return transportFailure(e);
    return finish(STATE.COMM_ERROR, 'Erro interno inesperado durante o diagnóstico.');
  } finally {
    if (session) await logout(ctx, session);
    session = null;
  }
}

/** Processa os IPs com no máximo `concurrency` requisições simultâneas. */
export async function scanRange(ips, cfg, deps, { concurrency = 4, onRow = () => {} } = {}) {
  const results = new Array(ips.length);
  let next = 0;
  async function worker() {
    for (;;) {
      if (cfg.signal?.aborted) return;
      const i = next++;
      if (i >= ips.length) return;
      results[i] = await scanDevice(ips[i], cfg, deps, onRow);
    }
  }
  const n = Math.max(1, Math.min(concurrency, ips.length));
  await Promise.all(Array.from({ length: n }, worker));
  for (let i = 0; i < ips.length; i++) {
    if (!results[i]) {
      results[i] = {
        ip: ips[i],
        state: STATE.CANCELLED,
        connection: 'Não verificada',
        auth: 'Não verificada',
        identification: '—',
        apiValidation: 'Não verificada',
        ms: 0,
        message: 'Operação cancelada antes de iniciar.',
        timestamp: new Date().toISOString(),
      };
      onRow({ ...results[i] });
    }
  }
  return results;
}

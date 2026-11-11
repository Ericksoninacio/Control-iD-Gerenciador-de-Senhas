// Fase 4 — alteração controlada da senha administrativa via POST /change_login.fcgi.
//
// Regras implementadas:
//  * só altera após login aceito com as credenciais atuais;
//  * NUNCA repete a alteração (timeout/resposta ambígua => "Resultado indeterminado");
//  * sucesso só é declarado após novo login com a nova senha;
//  * se a verificação falhar, tenta (somente leitura) a senha antiga para dizer o que ocorreu;
//  * após o envio da alteração o equipamento é processado até o fim (cancelar vale só entre equipamentos);
//  * mensagens são textos fixos: nenhuma senha, token ou texto do equipamento entra nos resultados.

import { RequestError } from '../api/connection.js';
import { login, logout, changeLogin } from '../api/controlid-api.js';

export const CHG = Object.freeze({
  OK: 'Senha alterada e verificada',
  NOT_CHANGED: 'Senha não alterada',
  INDETERMINATE: 'Resultado indeterminado',
  VERIFY_FAILED: 'Falha na verificação posterior',
  AUTH_REFUSED: 'Autenticação recusada',
  MANUAL: 'Requer validação manual',
  COMM_ERROR: 'Erro de comunicação',
  CANCELLED: 'Cancelado',
  RUNNING: 'Alterando',
});

export async function changeDevicePassword(ip, cfg, deps, onUpdate = () => {}) {
  const t0 = performance.now();
  const row = {
    ip,
    state: CHG.RUNNING,
    connection: 'Não verificada',
    auth: 'Não verificada',
    identification: '—',
    apiValidation: '—',
    change: 'Não executado',
    verify: 'Não executada',
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

  const ctx = { fetchImpl: deps.fetchImpl, ip, port: cfg.port, timeoutMs: cfg.timeoutMs };
  let oldSession = null;
  let newSession = null;
  let sent = false;

  try {
    if (deps.hasHostPermission && !(await deps.hasHostPermission(ip))) {
      return finish(CHG.COMM_ERROR, 'Permissão de acesso a este IP não concedida ao navegador. Nenhuma alteração enviada.', {
        connection: 'Bloqueada pelo navegador',
      });
    }

    const a = await login({ ...ctx, signal: cfg.signal }, cfg.username, cfg.password);
    row.connection = 'Acessível';
    if (a.kind === 'refused') {
      return finish(CHG.AUTH_REFUSED, 'Credenciais atuais recusadas. Nenhuma alteração enviada.', { auth: 'Recusada' });
    }
    if (a.kind !== 'ok') {
      return finish(CHG.MANUAL, 'Login inconclusivo. Nenhuma alteração enviada.', { auth: 'Indeterminada' });
    }
    oldSession = a.session;
    row.auth = 'Aceita';
    if (cfg.signal?.aborted) return finish(CHG.CANCELLED, 'Cancelado antes do envio. Nenhuma alteração feita.');

    sent = true; // a partir daqui qualquer falha é ambígua
    let res;
    try {
      res = await changeLogin(ctx, oldSession, cfg.username, cfg.newPassword);
    } catch (e) {
      if (e instanceof RequestError) {
        return finish(
          CHG.INDETERMINATE,
          'Sem resposta definitiva após o envio. A alteração NÃO foi repetida; verifique manualmente.',
          { change: 'Indeterminada' },
        );
      }
      throw e;
    }
    if (res.status === 401 || res.status === 403) {
      return finish(CHG.NOT_CHANGED, 'O equipamento recusou a sessão. Senha não alterada.', { change: 'Recusada' });
    }
    if (res.status === 404) {
      return finish(CHG.NOT_CHANGED, 'Este firmware não possui o endpoint change_login (HTTP 404). Senha não alterada.', {
        change: 'Endpoint inexistente',
      });
    }
    if (res.status < 200 || res.status >= 300) {
      return finish(
        CHG.INDETERMINATE,
        `HTTP ${res.status} inesperado na alteração. A alteração NÃO foi repetida; verifique manualmente.`,
        { change: 'Indeterminada' },
      );
    }
    row.change = 'Enviada (HTTP 2xx)';
    await logout(ctx, oldSession);
    oldSession = null;

    let v;
    try {
      v = await login(ctx, cfg.username, cfg.newPassword);
    } catch (e) {
      if (e instanceof RequestError) {
        return finish(CHG.INDETERMINATE, 'Sem resposta na verificação posterior. Verifique manualmente.', {
          verify: 'Indeterminada',
        });
      }
      throw e;
    }
    if (v.kind === 'ok') {
      newSession = v.session;
      return finish(CHG.OK, 'Senha alterada; login com a nova senha confirmado.', {
        change: 'Confirmada',
        verify: 'Login com a nova senha OK',
      });
    }

    let o = null;
    try {
      o = await login(ctx, cfg.username, cfg.password);
    } catch {
      /* sem resposta: tratado abaixo como falha de verificação */
    }
    if (o?.kind === 'ok') {
      oldSession = o.session;
      return finish(CHG.NOT_CHANGED, 'O envio foi aceito, mas a senha antiga continua válida. Senha não alterada.', {
        change: 'Não aplicada',
        verify: 'Senha antiga ainda válida',
      });
    }
    return finish(
      CHG.VERIFY_FAILED,
      'ATENÇÃO: nem a senha nova nem a antiga foram aceitas. Verifique manualmente (acesso local ao equipamento).',
      { change: 'Enviada', verify: 'Falhou' },
    );
  } catch (e) {
    if (e instanceof RequestError && !sent) {
      if (e.kind === 'aborted') return finish(CHG.CANCELLED, 'Cancelado. Nenhuma alteração enviada.');
      return finish(CHG.COMM_ERROR, 'Falha de comunicação no login. Nenhuma alteração enviada.', { auth: 'Erro de comunicação' });
    }
    return finish(
      sent ? CHG.INDETERMINATE : CHG.COMM_ERROR,
      sent ? 'Erro inesperado após o envio. Verifique manualmente.' : 'Erro interno. Nenhuma alteração enviada.',
    );
  } finally {
    if (oldSession) await logout(ctx, oldSession);
    if (newSession) await logout(ctx, newSession);
  }
}

/** Processa um equipamento por vez; cancelar impede apenas o início dos próximos. */
export async function changeRange(ips, cfg, deps, { onRow = () => {} } = {}) {
  const results = [];
  for (const ip of ips) {
    if (cfg.signal?.aborted) {
      const r = {
        ip, state: CHG.CANCELLED, connection: 'Não verificada', auth: 'Não verificada', identification: '—',
        apiValidation: '—', change: 'Não executado', verify: 'Não executada', ms: 0,
        message: 'Cancelado antes de iniciar. Nenhuma alteração enviada.', timestamp: new Date().toISOString(),
      };
      onRow({ ...r });
      results.push(r);
      continue;
    }
    results.push(await changeDevicePassword(ip, cfg, deps, onRow));
  }
  return results;
}

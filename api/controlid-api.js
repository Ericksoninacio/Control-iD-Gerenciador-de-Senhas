// Chamadas à API Control iD usadas na FASE DE DIAGNÓSTICO.
// Documentação: https://www.controlid.com.br/docs/access-api-pt/
//
// Endpoints usados (todos de leitura/sessão):
//   POST /login.fcgi               -> { session }        (documentado)
//   POST /system_information.fcgi  -> { version, ... }   (documentado)
//   POST /logout.fcgi?session=...                          (documentado; sem retorno relevante)
//
// changeLogin() (POST /change_login.fcgi) só é usado por services/password-manager.js (Fase 4).
// /set_objects.fcgi NUNCA é usado para alterar a senha administrativa.
// Tokens de sessão nunca são registrados nem retornados à interface.

import { request } from './connection.js';
import { classifyLoginResponse, classifySystemInfo } from './validation.js';

export function baseUrl(ip, port) {
  return port === 80 ? `http://${ip}` : `http://${ip}:${port}`;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Qualquer resposta HTTP (mesmo 404) prova que o host está respondendo. */
export async function probe(ctx) {
  return request(ctx.fetchImpl, `${baseUrl(ctx.ip, ctx.port)}/`, {
    method: 'GET',
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  });
}

export async function login(ctx, username, password) {
  const res = await request(ctx.fetchImpl, `${baseUrl(ctx.ip, ctx.port)}/login.fcgi`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ login: username, password }),
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
  });
  return { ...classifyLoginResponse(res.status, res.text), elapsedMs: res.elapsedMs };
}

export async function systemInformation(ctx, session) {
  const res = await request(
    ctx.fetchImpl,
    `${baseUrl(ctx.ip, ctx.port)}/system_information.fcgi?session=${encodeURIComponent(session)}`,
    { method: 'POST', headers: JSON_HEADERS, timeoutMs: ctx.timeoutMs, signal: ctx.signal },
  );
  return classifySystemInfo(res.status, res.text);
}

/** Melhor esforço; falhas aqui não alteram o resultado do diagnóstico. */
export async function logout(ctx, session) {
  try {
    await request(ctx.fetchImpl, `${baseUrl(ctx.ip, ctx.port)}/logout.fcgi?session=${encodeURIComponent(session)}`, {
      method: 'POST',
      headers: JSON_HEADERS,
      timeoutMs: Math.min(ctx.timeoutMs, 2000),
    });
  } catch {
    /* ignorado de propósito */
  }
}

/**
 * POST /change_login.fcgi?session=...  corpo {login, password} (senha em texto claro).
 * A documentação diz que a chamada NÃO tem retorno: só o status HTTP é considerado
 * e o sucesso real precisa ser comprovado por um novo login (feito pelo chamador).
 */
export async function changeLogin(ctx, session, username, newPassword) {
  const res = await request(
    ctx.fetchImpl,
    `${baseUrl(ctx.ip, ctx.port)}/change_login.fcgi?session=${encodeURIComponent(session)}`,
    {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ login: username, password: newPassword }),
      timeoutMs: ctx.timeoutMs,
    },
  );
  return { status: res.status };
}

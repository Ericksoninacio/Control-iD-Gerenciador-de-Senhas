import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidIpv4, buildRange, validatePasswordFields, classifyLoginResponse, firmwareStatus,
} from '../api/validation.js';
import { scanDevice, scanRange, STATE } from '../services/device-scanner.js';
import { toCsv, redact, CSV_COLUMNS } from '../services/report-exporter.js';
import { createMockFetch, MOCK_PASSWORD, MOCK_SESSION } from './mock-device.js';

const baseCfg = { port: 80, timeoutMs: 100, level: 'validate', username: 'admin', password: MOCK_PASSWORD };
const mk = (devices) => {
  const mock = createMockFetch(devices);
  return { mock, deps: { fetchImpl: mock.fetch, hasHostPermission: async () => true } };
};

test('IP válido e inválido', () => {
  assert.equal(isValidIpv4('172.15.30.4'), true);
  for (const bad of ['172.15.30', '172.15.30.256', '172.15.30.04', 'a.b.c.d', '', null, '1.2.3.4.5']) {
    assert.equal(isValidIpv4(bad), false, String(bad));
  }
});

test('faixa: gera IPs, rejeita inicial > final e octetos inválidos', () => {
  assert.deepEqual(buildRange({ base: '172.15.30.', start: '4', end: '6' }).ips, ['172.15.30.4', '172.15.30.5', '172.15.30.6']);
  assert.equal(buildRange({ base: '172.15.30', start: 4, end: 4 }).ok, true); // ponto final é opcional
  assert.equal(buildRange({ base: '172.15.30.', start: 10, end: 4 }).ok, false);
  assert.equal(buildRange({ base: '172.15.300.', start: 1, end: 2 }).ok, false);
  assert.equal(buildRange({ base: '172.15.30.', start: 0, end: 300 }).ok, false);
});

test('nova senha igual à atual exige confirmação explícita', () => {
  assert.equal(validatePasswordFields({ current: 'abc1', next: 'abc1', confirm: 'abc1' }).ok, false);
  assert.equal(validatePasswordFields({ current: 'abc1', next: 'abc1', confirm: 'abc1', allowSame: true }).ok, true);
  assert.equal(validatePasswordFields({ current: 'abc1', next: 'x', confirm: 'y' }).ok, false);
});

test('login: HTTP 200 sozinho não é sucesso', () => {
  assert.equal(classifyLoginResponse(200, '{}').kind, 'no-session');
  assert.equal(classifyLoginResponse(200, '<html>').kind, 'invalid-json');
  assert.equal(classifyLoginResponse(200, '{"session":""}').kind, 'no-session');
  assert.equal(classifyLoginResponse(401, '{"error":"x"}').kind, 'refused');
  assert.equal(classifyLoginResponse(500, '').kind, 'unexpected-status');
  assert.equal(classifyLoginResponse(200, '{"session":"abc"}').kind, 'ok');
});

test('firmware de referência confirmado; outros não', () => {
  assert.equal(firmwareStatus('6.23.0'), 'confirmed');
  assert.equal(firmwareStatus('5.0.1'), 'unconfirmed');
});

test('equipamento de referência: API validada', async () => {
  const { deps } = mk({ '172.15.30.4': { mode: 'ok' } });
  const r = await scanDevice('172.15.30.4', baseCfg, deps);
  assert.equal(r.state, STATE.API_OK);
  assert.equal(r.auth, 'Aceita');
  assert.match(r.identification, /FW 6\.23\.0/);
});

test('equipamento inacessível (e falha de CORS/rede, indistinguível no fetch)', async () => {
  const { deps } = mk({ '172.15.30.4': { mode: 'unreachable' } });
  const r = await scanDevice('172.15.30.4', baseCfg, deps);
  assert.equal(r.state, STATE.UNREACHABLE);
});

test('timeout é respeitado', async () => {
  const { deps } = mk({ '172.15.30.4': { mode: 'timeout' } });
  const t0 = Date.now();
  const r = await scanDevice('172.15.30.4', { ...baseCfg, timeoutMs: 60 }, deps);
  assert.equal(r.state, STATE.UNREACHABLE);
  assert.match(r.message, /Sem resposta em 60 ms/);
  assert.ok(Date.now() - t0 < 1000);
});

test('credenciais incorretas', async () => {
  const { deps } = mk({ '172.15.30.4': { mode: 'ok' } });
  const r = await scanDevice('172.15.30.4', { ...baseCfg, password: 'errada' }, deps);
  assert.equal(r.state, STATE.AUTH_REFUSED);
});

test('HTTP inesperado, JSON inválido e resposta sem token exigem validação manual', async () => {
  for (const mode of ['http500', 'badjson', 'nosession', 'nosysinfo']) {
    const { deps } = mk({ '172.15.30.4': { mode } });
    const r = await scanDevice('172.15.30.4', baseCfg, deps);
    assert.equal(r.state, STATE.MANUAL, mode);
  }
});

test('firmware fora da referência: estado próprio, com firmware registrado', async () => {
  const { deps } = mk({ '172.15.30.4': { mode: 'oldfw' } });
  const r = await scanDevice('172.15.30.4', baseCfg, deps);
  assert.equal(r.state, STATE.FW_UNCONFIRMED);
  assert.equal(r.firmware, '5.0.1');
  assert.match(r.message, /não confirmado/);
});

test('sem permissão de host: nenhuma requisição é feita', async () => {
  const mock = createMockFetch({ '172.15.30.4': { mode: 'ok' } });
  const r = await scanDevice('172.15.30.4', baseCfg, { fetchImpl: mock.fetch, hasHostPermission: async () => false });
  assert.equal(r.state, STATE.COMM_ERROR);
  assert.match(r.message, /Permissão/);
  assert.equal(mock.calls.length, 0);
});

test('cancelamento interrompe o equipamento em andamento', async () => {
  const { deps } = mk({ '172.15.30.4': { mode: 'timeout' } });
  const ctrl = new AbortController();
  const p = scanDevice('172.15.30.4', { ...baseCfg, timeoutMs: 5000, signal: ctrl.signal }, deps);
  setTimeout(() => ctrl.abort(), 20);
  const t0 = Date.now();
  const r = await p;
  assert.equal(r.state, STATE.CANCELLED);
  assert.ok(Date.now() - t0 < 1000);
});

test('varredura: falha em um IP não interrompe os demais; concorrência limitada', async () => {
  const devices = {};
  const ips = [];
  for (let i = 1; i <= 8; i++) {
    const ip = `172.15.30.${i}`;
    ips.push(ip);
    devices[ip] = { mode: i === 3 ? 'unreachable' : 'ok', delayMs: 15 };
  }
  const { mock, deps } = mk(devices);
  const rows = await scanRange(ips, { ...baseCfg, timeoutMs: 500 }, deps, { concurrency: 3 });
  assert.equal(rows.length, 8);
  assert.equal(rows[2].state, STATE.UNREACHABLE);
  assert.equal(rows.filter((r) => r.state === STATE.API_OK).length, 7);
  assert.ok(mock.state.maxInFlight <= 3, `maxInFlight=${mock.state.maxInFlight}`);
});

test('varredura cancelada marca pendentes como cancelados', async () => {
  const { deps } = mk({ '172.15.30.1': { mode: 'ok', delayMs: 30 }, '172.15.30.2': { mode: 'ok' }, '172.15.30.3': { mode: 'ok' } });
  const ctrl = new AbortController();
  ctrl.abort();
  const rows = await scanRange(['172.15.30.1', '172.15.30.2', '172.15.30.3'], { ...baseCfg, signal: ctrl.signal }, deps, { concurrency: 1 });
  assert.ok(rows.every((r) => r.state === STATE.CANCELLED));
});

test('diagnóstico nunca chama endpoints de alteração', async () => {
  const { mock, deps } = mk({ '172.15.30.4': { mode: 'ok' } });
  await scanDevice('172.15.30.4', baseCfg, deps);
  const paths = mock.calls.map((c) => c.path);
  assert.ok(!paths.includes('/change_login.fcgi'));
  assert.ok(!paths.includes('/set_objects.fcgi'));
  assert.ok(paths.includes('/logout.fcgi'));
});

test('relatório CSV não contém senhas nem tokens', async () => {
  const { deps } = mk({ '172.15.30.4': { mode: 'ok' }, '172.15.30.5': { mode: 'ok', password: 'outra' } });
  const rows = await scanRange(['172.15.30.4', '172.15.30.5'], baseCfg, deps, { concurrency: 2 });
  const csv = toCsv(rows, { secrets: [MOCK_PASSWORD] });
  assert.ok(!csv.includes(MOCK_PASSWORD));
  assert.ok(!csv.includes(MOCK_SESSION));
  assert.ok(csv.startsWith(CSV_COLUMNS[0]));
  assert.equal(csv.trim().split('\r\n').length, 3);
});

test('exportador remove segredos e neutraliza fórmulas', () => {
  assert.equal(redact('erro com SenhaSecreta! no texto', ['SenhaSecreta!']), 'erro com [removido] no texto');
  const csv = toCsv([{ timestamp: 't', ip: '1.1.1.1', connection: 'x', auth: 'y', message: '=HYPERLINK("x")', ms: 1 }]);
  assert.ok(csv.includes(`"'=HYPERLINK`));
});

// ---------------- Fase 4: alteração de senha ----------------
import { changeDevicePassword, changeRange, CHG } from '../services/password-manager.js';

const NEW_PW = 'NovaSenha#9';
const chgCfg = { port: 80, timeoutMs: 100, username: 'admin', password: MOCK_PASSWORD, newPassword: NEW_PW };

test('alteração: sucesso só após login com a nova senha; sessão antiga encerrada antes', async () => {
  const dev = { mode: 'ok' };
  const { mock, deps } = mk({ '172.15.30.4': dev });
  const r = await changeDevicePassword('172.15.30.4', chgCfg, deps);
  assert.equal(r.state, CHG.OK);
  assert.equal(dev.password, NEW_PW);
  assert.deepEqual(mock.calls.map((c) => c.path), [
    '/login.fcgi', '/change_login.fcgi', '/logout.fcgi', '/login.fcgi', '/logout.fcgi',
  ]);
});

test('alteração: credenciais atuais erradas => nenhuma chamada de alteração', async () => {
  const { mock, deps } = mk({ '172.15.30.4': { mode: 'ok' } });
  const r = await changeDevicePassword('172.15.30.4', { ...chgCfg, password: 'errada' }, deps);
  assert.equal(r.state, CHG.AUTH_REFUSED);
  assert.ok(!mock.calls.some((c) => c.path === '/change_login.fcgi'));
});

test('alteração aceita (200) mas não aplicada: senha antiga ainda vale => não alterada', async () => {
  const { deps } = mk({ '172.15.30.4': { mode: 'ok', chg: 'noapply' } });
  const r = await changeDevicePassword('172.15.30.4', chgCfg, deps);
  assert.equal(r.state, CHG.NOT_CHANGED);
});

test('falha de autenticação após a alteração (nenhuma senha vale) => alerta crítico', async () => {
  const { deps } = mk({ '172.15.30.4': { mode: 'ok', chg: 'broken' } });
  const r = await changeDevicePassword('172.15.30.4', chgCfg, deps);
  assert.equal(r.state, CHG.VERIFY_FAILED);
  assert.match(r.message, /ATENÇÃO/);
});

test('resposta ambígua (HTTP 500) ou timeout após envio => indeterminado, sem repetir', async () => {
  for (const chg of ['500', 'timeout']) {
    const { mock, deps } = mk({ '172.15.30.4': { mode: 'ok', chg } });
    const r = await changeDevicePassword('172.15.30.4', chgCfg, deps);
    assert.equal(r.state, CHG.INDETERMINATE, chg);
    assert.equal(mock.calls.filter((c) => c.path === '/change_login.fcgi').length, 1, chg);
  }
});

test('lote: falha em um equipamento não impede os demais; cancelamento marca os pendentes', async () => {
  const { deps } = mk({
    '172.15.30.1': { mode: 'ok' }, '172.15.30.2': { mode: 'unreachable' }, '172.15.30.3': { mode: 'ok' },
  });
  const rows = await changeRange(['172.15.30.1', '172.15.30.2', '172.15.30.3'], chgCfg, deps);
  assert.deepEqual(rows.map((r) => r.state), [CHG.OK, CHG.COMM_ERROR, CHG.OK]);
  const ctrl = new AbortController();
  ctrl.abort();
  const rows2 = await changeRange(['172.15.30.1'], { ...chgCfg, signal: ctrl.signal }, deps);
  assert.equal(rows2[0].state, CHG.CANCELLED);
});

test('relatório da Fase 4 não contém senha antiga, nova nem token', async () => {
  const { deps } = mk({ '172.15.30.4': { mode: 'ok' } });
  const rows = await changeRange(['172.15.30.4'], chgCfg, deps);
  const csv = toCsv(rows, { secrets: [MOCK_PASSWORD, NEW_PW] });
  for (const secret of [MOCK_PASSWORD, NEW_PW, MOCK_SESSION]) assert.ok(!csv.includes(secret));
  assert.ok(csv.includes('Confirmada'));
});

test('firmware sem change_login (HTTP 404) => não alterada, sem tratar como indeterminado', async () => {
  const dev = { mode: 'ok', chg: '404' };
  const { deps } = mk({ '172.15.30.4': dev });
  const r = await changeDevicePassword('172.15.30.4', chgCfg, deps);
  assert.equal(r.state, CHG.NOT_CHANGED);
  assert.equal(dev.password, undefined);
});

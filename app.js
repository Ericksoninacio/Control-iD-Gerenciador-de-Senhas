import { buildRange, validatePort, validateBounded, validatePasswordFields, LIMITS } from './api/validation.js';
import { scanRange, STATE } from './services/device-scanner.js';
import { changeRange, CHG } from './services/password-manager.js';
import { toCsv } from './services/report-exporter.js';

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = 'settings'; // somente valores NÃO sensíveis
const rowEls = new Map(); // ip -> <tr>
const data = new Map(); // ip -> última linha de resultado
let abortCtrl = null;
let running = false;

const TABS = [
  { id: 'all', label: 'Todos', states: null },
  { id: 'ok', label: 'Sessão obtida', states: [STATE.SESSION, STATE.API_OK, CHG.OK],
    hint: 'Equipamentos com login aceito. Marque os desejados (ou use a caixa do cabeçalho) e clique em "Alterar senha dos selecionados".' },
  { id: 'refused', label: 'Autenticação recusada', states: [STATE.AUTH_REFUSED],
    hint: 'A senha informada não foi aceita nestes equipamentos. Tente outra senha atual ou verifique manualmente.' },
  { id: 'down', label: 'Equipamento inacessível', states: [STATE.UNREACHABLE, STATE.COMM_ERROR],
    hint: 'Sem resposta HTTP: verifique energia, IP, rede, porta e permissão do navegador.' },
  { id: 'fw', label: 'Firmware não confirmado', states: [STATE.FW_UNCONFIRMED],
    hint: 'Login e leitura funcionaram, mas o firmware difere do de referência (6.23.0). Podem ser selecionados normalmente; cada alteração é conferida por novo login.' },
  { id: 'manual', label: 'Requer validação manual', states: [STATE.MANUAL, CHG.INDETERMINATE, CHG.NOT_CHANGED, CHG.VERIFY_FAILED],
    hint: 'Resposta inesperada, firmware não confirmado ou alteração sem resultado definitivo. Confira cada equipamento manualmente.' },
];
let activeTab = 'all';
const inTab = (row, tab) => !tab.states || tab.states.includes(row.state);

const BADGE = {
  [STATE.API_OK]: 'ok', [STATE.SESSION]: 'ok', [STATE.REACHABLE]: 'ok', [CHG.OK]: 'ok',
  [STATE.AUTH_REFUSED]: 'bad', [STATE.UNREACHABLE]: 'bad', [STATE.COMM_ERROR]: 'bad', [CHG.VERIFY_FAILED]: 'bad',
  [STATE.MANUAL]: 'mid', [STATE.FW_UNCONFIRMED]: 'mid', [STATE.CHECKING]: 'mid', [CHG.RUNNING]: 'mid', [CHG.INDETERMINATE]: 'mid', [CHG.NOT_CHANGED]: 'mid',
  [STATE.CANCELLED]: 'idle', [STATE.WAITING]: 'idle',
};

function readNetwork() {
  const errors = [];
  const range = buildRange({ base: $('base').value, start: $('start').value, end: $('end').value });
  errors.push(...range.errors);
  const port = validatePort($('port').value);
  if (!port.ok) errors.push(port.error);
  const timeout = validateBounded($('timeout').value, LIMITS.timeoutMin, LIMITS.timeoutMax, 'Timeout (ms)');
  if (!timeout.ok) errors.push(timeout.error);
  const conc = validateBounded($('concurrency').value, LIMITS.concurrencyMin, LIMITS.concurrencyMax, 'Simultâneos');
  if (!conc.ok) errors.push(conc.error);
  return { errors, ips: range.ips, port: port.value, timeoutMs: timeout.value, concurrency: conc.value };
}

function selectedIps() {
  // só conta linhas visíveis na aba atual: a alteração em massa vale para o que o operador está vendo
  return [...rowEls.entries()].filter(([, tr]) => !tr.hidden && tr.querySelector('input')?.checked).map(([ip]) => ip);
}

function renderTabs() {
  const rows = [...data.values()];
  $('tabs').replaceChildren(
    ...TABS.map((t) => {
      const b = Object.assign(document.createElement('button'), { className: 'tab', type: 'button' });
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(t.id === activeTab));
      b.append(t.label, Object.assign(document.createElement('span'), { className: 'n', textContent: `(${rows.filter((r) => inTab(r, t)).length})` }));
      b.addEventListener('click', () => {
        activeTab = t.id;
        applyFilter();
      });
      return b;
    }),
  );
  $('tabHint').textContent = TABS.find((t) => t.id === activeTab).hint ?? '';
}

function applyFilter() {
  const tab = TABS.find((t) => t.id === activeTab);
  for (const [ip, tr] of rowEls) tr.hidden = !inTab(data.get(ip), tab);
  renderTabs();
  updateButtons();
}

function updateButtons() {
  const sel = selectedIps().length;
  for (const id of ['btnTest', 'btnDiagnose', 'btnValidate']) $(id).disabled = running;
  $('btnChangeOne').disabled = running || sel !== 1;
  $('btnChangeSel').disabled = running || sel < 1;
  $('btnCancel').disabled = !running;
  $('btnExport').disabled = running || data.size === 0;
  $('btnClear').disabled = running || data.size === 0;
  const boxes = [...rowEls.values()].filter((tr) => !tr.hidden).map((tr) => tr.firstChild.firstChild).filter((cb) => !cb.disabled);
  $('selAll').disabled = running || boxes.length === 0;
  $('selAll').checked = boxes.length > 0 && boxes.every((cb) => cb.checked);
}

function renderPreview() {
  const r = readNetwork();
  $('preview').textContent = r.errors.length
    ? ''
    : `Faixa: ${r.ips[0]} → ${r.ips[r.ips.length - 1]} (${r.ips.length} equipamento${r.ips.length > 1 ? 's' : ''}), porta ${r.port}.`;
  const pw = validatePasswordFields({
    current: $('current').value, next: $('next').value, confirm: $('confirm').value, allowSame: $('allowSame').checked,
  });
  $('pwHint').textContent = $('next').value || $('confirm').value ? (pw.ok ? 'Campos de senha consistentes.' : pw.errors.join(' ')) : '';
}

function showErrors(list) {
  $('errors').replaceChildren(...list.map((m) => Object.assign(document.createElement('li'), { textContent: m })));
}

function renderRow(row) {
  row = { ...row, firmware: row.firmware ?? data.get(row.ip)?.firmware };
  data.set(row.ip, row);
  let tr = rowEls.get(row.ip);
  if (!tr) {
    tr = document.createElement('tr');
    for (let i = 0; i < 11; i++) tr.appendChild(document.createElement('td'));
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox' });
    cb.addEventListener('change', updateButtons);
    tr.children[0].appendChild(cb);
    rowEls.set(row.ip, tr);
    $('rows').appendChild(tr);
  }
  const [, ip, state, conn, auth, ident, api, change, verify, ms, msg] = tr.children;
  const cb = tr.children[0].firstChild;
  cb.disabled = ![STATE.API_OK, STATE.FW_UNCONFIRMED, STATE.SESSION].includes(row.state); // basta o login ter funcionado; o firmware não bloqueia
  if (cb.disabled) cb.checked = false;
  ip.textContent = row.ip;
  state.replaceChildren(Object.assign(document.createElement('span'), { className: `badge ${BADGE[row.state] ?? ''}`, textContent: row.state }));
  conn.textContent = row.connection;
  auth.textContent = row.auth;
  ident.textContent = row.identification;
  api.textContent = row.apiValidation;
  change.textContent = row.change ?? 'Não executado';
  verify.textContent = row.verify ?? 'Não executada';
  ms.textContent = row.ms == null ? '' : `${row.ms} ms`;
  msg.textContent = row.message;
  tr.hidden = !inTab(row, TABS.find((t) => t.id === activeTab));
  renderTabs();
  updateButtons();
}

async function ensurePermissions(ips) {
  const origins = ips.map((ip) => `http://${ip}/*`);
  if (await chrome.permissions.contains({ origins })) return true;
  return chrome.permissions.request({ origins });
}

const makeDeps = () => ({
  fetchImpl: (...a) => fetch(...a),
  hasHostPermission: (ip) => chrome.permissions.contains({ origins: [`http://${ip}/*`] }),
});

function summarize(label) {
  const rows = [...data.values()];
  const n = (...s) => rows.filter((r) => s.includes(r.state)).length;
  $('summary').textContent =
    `${label}: ${rows.length} equipamento(s) — OK: ${n(STATE.API_OK, STATE.SESSION, STATE.REACHABLE, CHG.OK)}; ` +
    `firmware não confirmado: ${n(STATE.FW_UNCONFIRMED)}; validação manual/indeterminado/não alterada: ${n(STATE.MANUAL, CHG.INDETERMINATE, CHG.NOT_CHANGED)}; ` +
    `credenciais recusadas: ${n(STATE.AUTH_REFUSED)}; sem comunicação: ${n(STATE.UNREACHABLE, STATE.COMM_ERROR)}; ` +
    `falha na verificação: ${n(CHG.VERIFY_FAILED)}.`;
}

async function run(level) {
  if (running) return;
  // Tudo até o pedido de permissão é síncrono: ele exige gesto do usuário.
  const net = readNetwork();
  const errors = [...net.errors];
  if (!$('authorized').checked) errors.push('Marque a confirmação de autorização para continuar.');
  if (level !== 'connect' && (!$('username').value || !$('current').value)) errors.push('Informe usuário e senha atuais.');
  showErrors(errors);
  if (errors.length) return;

  const ips = level === 'connect' ? net.ips.slice(0, 1) : net.ips;
  if (!(await ensurePermissions(ips))) {
    showErrors(['O Chrome não concedeu permissão de acesso aos IPs da faixa.']);
    return;
  }
  chrome.storage.local.set({
    [SETTINGS_KEY]: {
      base: $('base').value, start: $('start').value, end: $('end').value,
      port: $('port').value, timeout: $('timeout').value, concurrency: $('concurrency').value, username: $('username').value,
    },
  });

  clearResults();
  abortCtrl = new AbortController();
  running = true;
  updateButtons();
  const cfg = {
    port: net.port, timeoutMs: net.timeoutMs, level, signal: abortCtrl.signal,
    username: $('username').value, password: $('current').value,
  };
  const results = await scanRange(ips, cfg, makeDeps(), { concurrency: net.concurrency, onRow: renderRow });
  results.forEach(renderRow);
  summarize('Diagnóstico concluído');
  abortCtrl = null;
  running = false;
  updateButtons();
}

async function change(mode) {
  if (running) return;
  const net = readNetwork();
  const errors = [...net.errors];
  const ips = selectedIps();
  if (!$('authorized').checked) errors.push('Marque a confirmação de autorização para continuar.');
  if (!$('username').value) errors.push('Informe o usuário administrativo.');
  const pw = validatePasswordFields({
    current: $('current').value, next: $('next').value, confirm: $('confirm').value, allowSame: $('allowSame').checked,
  });
  errors.push(...pw.errors);
  if (mode === 'one' && ips.length !== 1) errors.push('Selecione exatamente um equipamento validado.');
  if (mode === 'many' && ips.length < 1) errors.push('Selecione ao menos um equipamento validado.');
  showErrors(errors);
  if (errors.length) return;

  const next = $('next').value;
  if (next.toLowerCase() === 'admin' || next.length < 6) {
    if (!confirm('A nova senha é padrão/curta e fácil de adivinhar. Deseja realmente usá-la?')) return;
  }
  const unconf = ips.filter((ip) => data.get(ip)?.state === STATE.FW_UNCONFIRMED).length;
  const resumo = ips.length === 1 ? ips[0] : `${ips[0]} … ${ips[ips.length - 1]}`;
  if (!confirm(`Alterar a senha administrativa de ${ips.length} equipamento(s)?\nIPs: ${resumo}\nUsuário: ${$('username').value}${unconf ? `\n(${unconf} com firmware fora da referência: o resultado de cada um é conferido por novo login.)` : ''}`)) return;
  if (prompt('Para confirmar, digite ALTERAR (em maiúsculas):') !== 'ALTERAR') {
    showErrors(['Confirmação não realizada. Nenhuma alteração foi enviada.']);
    return;
  }

  abortCtrl = new AbortController();
  running = true;
  updateButtons();
  const cfg = {
    port: net.port, timeoutMs: net.timeoutMs, signal: abortCtrl.signal,
    username: $('username').value, password: $('current').value, newPassword: next,
  };
  const results = await changeRange(ips, cfg, makeDeps(), { onRow: renderRow });
  results.forEach(renderRow);
  summarize('Alteração concluída');
  abortCtrl = null;
  running = false;
  clearSensitiveFields(); // a senha digitada não deve permanecer na tela
  updateButtons();
}

function clearResults() {
  data.clear();
  rowEls.clear();
  $('rows').replaceChildren();
  $('summary').textContent = '';
  renderTabs();
  updateButtons();
}

function clearSensitiveFields() {
  for (const id of ['current', 'next', 'confirm']) $(id).value = '';
  renderPreview();
}

function exportReport() {
  const csv = toCsv([...data.values()], { secrets: [$('current').value, $('next').value] });
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const name = `controlid-relatorio-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.csv`;
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$('btnTest').addEventListener('click', () => run('connect'));
$('btnDiagnose').addEventListener('click', () => run('auth'));
$('btnValidate').addEventListener('click', () => run('validate'));
$('btnChangeOne').addEventListener('click', () => change('one'));
$('btnChangeSel').addEventListener('click', () => change('many'));
$('btnCancel').addEventListener('click', () => {
  abortCtrl?.abort();
  clearSensitiveFields();
});
$('selAll').addEventListener('change', (e) => {
  for (const tr of rowEls.values()) {
    const cb = tr.firstChild.firstChild;
    if (!tr.hidden && !cb.disabled) cb.checked = e.target.checked;
  }
  updateButtons();
});
$('btnExport').addEventListener('click', exportReport);
$('btnClear').addEventListener('click', () => {
  clearResults();
  clearSensitiveFields();
});
$('show').addEventListener('change', (e) => {
  for (const id of ['current', 'next', 'confirm']) $(id).type = e.target.checked ? 'text' : 'password';
});
for (const id of ['base', 'start', 'end', 'port', 'current', 'next', 'confirm', 'allowSame']) {
  $(id).addEventListener('input', renderPreview);
}

const saved = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
if (saved) for (const [k, v] of Object.entries(saved)) if ($(k) && typeof v === 'string') $(k).value = v;
renderPreview();
renderTabs();
updateButtons();

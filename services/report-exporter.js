// Exportação de relatório CSV (separador ";" e CRLF, compatível com Excel pt-BR).
// O relatório contém apenas campos operacionais — nunca senhas nem tokens.

export const CSV_COLUMNS = Object.freeze([
  'Data/hora',
  'Endereço IP',
  'Conexão',
  'Autenticação',
  'Alteração',
  'Verificação posterior',
  'Mensagem',
  'Duração (ms)',
]);

/** Remove segredos conhecidos (>= 4 caracteres) de um texto. */
export function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (typeof s === 'string' && s.length >= 4) out = out.split(s).join('[removido]');
  }
  return out;
}

function cell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // evita injeção de fórmula em planilhas
  if (/[";\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows, { secrets = [] } = {}) {
  const lines = [CSV_COLUMNS.map(cell).join(';')];
  for (const r of rows) {
    lines.push(
      [
        r.timestamp,
        r.ip,
        r.connection,
        r.auth,
        r.change ?? 'Não executado',
        r.verify ?? 'Não executada',
        redact(r.message, secrets),
        r.ms ?? '',
      ]
        .map((v) => cell(redact(v, secrets)))
        .join(';'),
    );
  }
  return lines.join('\r\n') + '\r\n';
}

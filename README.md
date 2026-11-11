# Control iD – Gerenciador de Senhas (versão 0.2 · Diagnóstico + alteração controlada)

Extensão Chrome (Manifest V3, JavaScript puro, sem dependências) para diagnosticar e validar a API de
equipamentos **Control iD iDFace** na rede local. O diagnóstico (leitura) foi validado no equipamento de referência (iDFace, firmware 6.23.0, SecBox 2.2.3,
`172.15.30.4`) e, a partir da 0.2, a **alteração de senha** está disponível com salvaguardas. O comportamento
de `change_login` no 6.23.0 ainda **não foi observado de ponta a ponta**: faça a primeira alteração em UM equipamento.

## Instalação (modo desenvolvedor)
1. Abra `chrome://extensions` e ative **Modo do desenvolvedor**.
2. **Carregar sem compactação** → selecione a pasta `controlid-password-manager`.
3. Clique no ícone da extensão: abre a página `app.html` em uma aba.

## Como diagnosticar o equipamento de referência
1. Rede: base `172.15.30.`, inicial `4`, final `4`, porta `80`.
2. Marque a confirmação de autorização.
3. **Testar conexão** (não usa credenciais). O Chrome pedirá permissão para `http://172.15.30.4/*` — aceite.
4. Informe usuário e senha atuais → **Diagnosticar faixa de IPs** (login + logout).
5. **Validar compatibilidade da API** (login + `system_information` + checagem do firmware + logout).
6. Resultado esperado: estado **API validada** e identificação `Série 0M0300/002DAB · FW 6.23.0 · SecBox 2.2.3`.
7. **Exportar relatório (CSV)**. Separador `;`, UTF-8 com BOM (abre direto no Excel pt-BR).

## Alteração de senha (Fase 4)
Os resultados são separados em abas com contagem: **Todos**, **Sessão obtida** (inclui API validada e senha alterada), **Autenticação recusada**, **Firmware não confirmado**, **Equipamento inacessível** e **Requer validação manual**. A caixa do cabeçalho seleciona todos os equipamentos validados da aba visível; a alteração em massa vale só para o que está visível.

1. Rode **Diagnosticar faixa de IPs** (ou **Validar compatibilidade**). Equipamentos com login aceito — incluindo os de firmware diferente do de referência — ganham a caixa de seleção.
2. Preencha usuário/senha atuais, nova senha e confirmação. Marque a autorização.
3. Selecione **um** equipamento → **Alterar senha de um equipamento**. Há três confirmações (aviso de senha padrão/curta, resumo com IPs e digitar `ALTERAR`).
4. Fluxo por equipamento: login com a senha atual → `POST /change_login.fcgi` (mesmo usuário) → logout da sessão antiga → **novo login com a senha nova**.
   Só então aparece **Senha alterada e verificada**.
5. **Alterar senha dos selecionados** funciona em massa, sem bloqueio por versão de firmware: processa um por vez, uma falha não interrompe os demais, e cada equipamento só é dado como alterado após novo login com a nova senha.
6. Se um firmware não tiver o endpoint (HTTP 404), o resultado é *Senha não alterada*; respostas ambíguas viram *Resultado indeterminado* (nunca repetidas).

Resultados possíveis e o que fazer:
| Estado | Significado |
|---|---|
| Senha alterada e verificada | Novo login com a nova senha funcionou |
| Senha não alterada | Recusada, ou o envio foi aceito mas a senha antiga continua válida |
| Resultado indeterminado | Timeout/HTTP inesperado após o envio. **Não é repetido automaticamente**; teste o login manualmente (nova e antiga) |
| Falha na verificação posterior | Nem a senha nova nem a antiga foram aceitas. Exige acesso local/manual ao equipamento |

Os campos de senha são limpos ao cancelar, ao limpar resultados e ao terminar uma alteração. O CSV traz as colunas
Alteração e Verificação posterior, sem senhas nem tokens.

## Permissões
- `storage`: só guarda faixa, porta, timeout, concorrência e nome de usuário. Nunca senhas nem tokens.
- `optional_host_permissions: http://*/*`: **não é concedida na instalação**. Em cada execução a extensão pede ao Chrome
  somente os IPs exatos da faixa configurada (`http://IP/*`). Match patterns do Chrome não aceitam faixas de IP parciais,
  por isso a declaração opcional precisa ser ampla; a concessão efetiva é restrita.

## Testes
`npm test` (ou `node --test tests/validation-tests.js`; Node 18+, nenhuma dependência). Usa `tests/mock-device.js`,
um equipamento simulado — nenhuma senha real é alterada. Cobertos: IP válido/inválido, faixa invertida, timeout,
inacessível, credenciais incorretas, HTTP inesperado, JSON inválido, resposta sem token, falha de rede/CORS
(indistinguível no `fetch`), permissão ausente, cancelamento, concorrência limitada, firmware incompatível,
garantia de que nenhum endpoint de alteração é chamado e CSV sem segredos.

Fase 4 coberta no simulador: alteração verificada (e ordem das chamadas), credenciais atuais erradas, alteração aceita mas não aplicada, nenhuma senha válida depois, HTTP 500/timeout sem repetição, lote com falha parcial e cancelamento, CSV sem segredos.

## O que está documentado × o que falta testar
| Item | Situação |
|---|---|
| `POST /login.fcgi` com `{login, password}` → `{session}` | Documentado |
| `POST /system_information.fcgi?session=` → `version`, `secbox_version`, `serial`, `device_id` | Documentado; **não há campo "modelo"**, por isso a identificação usa série + firmware |
| `POST /change_login.fcgi?session=` com `{login, password}` (senha em texto claro) | Documentado; **a documentação diz que não há retorno** |
| `POST /login.fcgi` + `system_information` no iDFace de referência (6.23.0) | **Validado** no equipamento real (login aceito, série/FW/SecBox lidos) |
| Comportamento de `change_login` no firmware 6.23.0 (sucesso, erro, sessão após a troca) | **Ainda não observado.** Sem retorno, a evidência é o novo login; a extensão sempre o faz |
| Código HTTP/corpo exato de login recusado no 6.23.0 | **A confirmar** (tratamos 401/403 e `error` como recusa; o resto vira "Requer validação manual") |
| Corpo vazio em `system_information.fcgi` e `logout.fcgi` no 6.23.0 | **A confirmar** no equipamento |
| Chrome (versões recentes com restrições de rede local) liberar `fetch` de página de extensão a IP privado | **A confirmar** no seu Chrome |

## Limitações conhecidas
- O `fetch` não distingue host desligado de bloqueio por CORS/rede local: ambos aparecem como "inacessível".
- Tráfego HTTP sem criptografia (credenciais trafegam em texto claro na rede): use rede administrativa isolada.
- Se o equipamento exigir regras de complexidade de senha, o `change_login` pode responder de forma não documentada; nesse caso o estado será indeterminado ou não alterada.

# Portal do Cliente SaMe Contabilidade (Vercel)

Relatórios de entradas e saídas a partir de NF-e, NFC-e, CT-e e NFS-e, com **busca automática das notas na SEFAZ às 6h e às 18h** e acesso seguro para cada cliente.

| Perfil | O que pode fazer |
|---|---|
| **Escritório (ADM)** | Cadastrar clientes, enviar o certificado A1, ligar a busca na SEFAZ, importar XMLs (.zip ou soltos), ver o relatório de qualquer cliente, acompanhar a atividade do portal. |
| **Cliente** | Entrar com e-mail, CNPJ ou CPF, ver **somente o próprio** relatório, baixar os XMLs em .zip, trocar a senha e sair de todos os aparelhos. |

## O que mudou na versão 3

**Visual:** mesma identidade do site (fonte Schibsted Grotesk, azul #00509E, laranja #FF8C00, logo SaMe), tela de entrada nova, resumo do mês, situação das notas (canceladas fora dos totais) e painel do escritório em abas.

**Segurança**
- Sessões guardadas no banco: sair encerra a sessão de verdade, e o cliente pode sair de todos os aparelhos. A sessão cai após 2 h sem uso (1 h para o escritório) e dura no máximo 12 h.
- O cliente recebe uma **senha provisória** e é obrigado a criar a dele no primeiro acesso (mínimo de 10 caracteres, letras e números, sem senhas comuns).
- **Verificação em duas etapas** (Google Authenticator etc.) para o escritório.
- Limite de tentativas por login, por IP e pela combinação dos dois (bloqueio de 15 minutos).
- Registro de atividade (entradas, tentativas recusadas, alterações, downloads), guardado por 1 ano.
- Certificados A1 guardados criptografados (AES-256-GCM); a senha do certificado não é armazenada.
- Bloqueio de requisições vindas de outros sites, cookie `__Host-` com `HttpOnly`/`Secure`/`SameSite=Strict`, cabeçalhos HSTS, CSP sem scripts de terceiros (o JSZip agora vem do próprio portal), `noindex`.
- CPF/CNPJ validados pelos dígitos verificadores, já aceitando o **CNPJ alfanumérico** (2026).

**Busca automática na SEFAZ** (Distribuição DF-e, NT 2014.002 e 2015.002)
- Usa o certificado A1 de cada cliente. A SEFAZ entrega as NF-e e CT-e em que o cliente é destinatário/tomador (entradas) dos últimos 90 dias, além dos cancelamentos.
- **Saídas não vêm pela SEFAZ**: continue importando os XMLs de venda pela aba "Importar XMLs".
- Sem a ciência da operação, a SEFAZ entrega só o **resumo** da NF-e (suficiente para o relatório). Com a **ciência automática** ligada (por cliente, com autorização dele), o portal registra o evento 210210 e o XML completo chega na busca seguinte.
- Respeita as regras de consumo da SEFAZ (espera de 1 hora quando não há mais documentos e após o erro 656).

## Publicar ou atualizar na Vercel

1. **Banco de dados:** se ainda não tiver, abra o projeto na Vercel, vá em *Storage* e crie um **Postgres (Neon)** gratuito. Isso cria `DATABASE_URL`.
2. **Variáveis de ambiente** (*Settings, Environment Variables*). Veja `.env.example`:
   - `SESSION_SECRET`: já existe se você publicou a versão anterior.
   - `ENCRYPTION_KEY` (**nova**): texto aleatório com 32+ caracteres. Guarde uma cópia: se mudar, os certificados precisam ser enviados de novo.
   - `CRON_SECRET` (**nova**): texto aleatório com 16+ caracteres. A Vercel usa nas buscas das 6h e 18h.
   - `ADMIN_EMAIL` e `ADMIN_PASSWORD`: só para criar o primeiro ADM.
3. **Enviar o código:** substitua os arquivos do repositório por estes (ou rode `npx vercel --prod` dentro da pasta). Não precisa configurar *build*.
4. Entre como ADM, ative a verificação em duas etapas (aba Segurança) e envie o certificado A1 de cada cliente.

As tabelas novas são criadas sozinhas no primeiro acesso. Clientes e notas que já existem continuam lá. Todos precisarão entrar de novo uma vez, porque o formato da sessão mudou.

### Horários da busca

O `vercel.json` tem dois agendamentos diários (09:00 e 21:00 UTC, ou seja, **6h e 18h em Brasília**). São dois agendamentos de uma vez por dia porque o plano gratuito (Hobby) da Vercel não aceita um agendamento a cada 12 horas; no plano Hobby o horário pode variar em até 59 minutos. O botão "Buscar agora" na aba "Busca na SEFAZ" roda a busca na hora.

### Busca retroativa (notas de até 90 dias atrás)

A SEFAZ guarda as notas por 90 dias depois de recebê-las. Notas mais antigas não podem mais ser baixadas por ela: importe o XML pela aba "Importar XMLs".

- **CNPJ que nenhum outro sistema consulta:** a primeira busca já traz os últimos 90 dias.
- **Botão "Busca retroativa"** (aba Busca na SEFAZ): abre uma janela onde você escolhe a data inicial (no máximo 90 dias atrás) e, se quiser, cola ou carrega um .txt/.csv com chaves de acesso de NF-e.
  - **Por chave:** busca direto cada nota informada. Funciona mesmo quando outro sistema disputa o CNPJ na SEFAZ. Chaves que já têm XML completo no portal são ignoradas.
  - **Pela sequência da SEFAZ:** percorre as notas do cliente da mais recente para a mais antiga, até a data escolhida. Recupera também o que outro sistema baixou antes.
- **Ritmo:** a SEFAZ libera no máximo 20 consultas desse tipo por hora, então o portal faz 18 por hora, sozinho, nos horários de hora em hora do `vercel.json`. Cada consulta traz uma nota ou evento: um cliente com 300 notas no período leva cerca de 17 horas.
- O andamento aparece na linha do cliente, com a opção "Cancelar busca retroativa". As notas já recuperadas continuam no portal.
- Quando a consulta normal recebe o erro 656, o trecho que outro sistema já baixou entra sozinho na busca retroativa.

O `vercel.json` tem 24 agendamentos diários (o plano Hobby permite até 100, cada um uma vez por dia): 2 de busca completa (6h e 18h) e 22 de busca retroativa.

### Erro 656 "Consumo indevido"

A SEFAZ trata todos os sistemas que consultam o mesmo CNPJ como um só e exige que eles sigam a mesma sequência de NSU. Se o emissor, o ERP do cliente, o sistema contábil ou outro portal (Qive, SIEG etc.) já baixou as notas desse CNPJ, a primeira consulta do portal é recusada com o erro 656 e as consultas do CNPJ ficam pausadas por 1 hora.

- O portal guarda a posição que a SEFAZ informa e continua sozinho depois de 1 hora. Não é preciso fazer nada.
- As notas que o outro sistema já baixou entram na **recuperação automática**: o portal busca uma por uma (consulta por NSU), do mais recente para o mais antigo, até o limite de 90 dias.
- Se o erro voltar ("Outro sistema consultando"), os dois sistemas estão disputando o mesmo CNPJ. Deixe só um deles com a consulta automática na SEFAZ para esse cliente.

### Cadeia ICP-Brasil

Os servidores da SEFAZ usam certificados da ICP-Brasil, que não vêm no Node.js. Na primeira busca o portal baixa o pacote oficial do ITI (`acraiz.icpbrasil.gov.br`), confere o SHA-512 e guarda no banco por 30 dias. Se a busca mostrar "Falha na conexão segura com a SEFAZ", baixe a cadeia no site do ITI, converta para PEM e cole em `ICP_BRASIL_CA_PEM`.

### Ligar o site ao portal

No `index.html` do site (pasta "01 - Site"), preencha `portalLogin` em `CONFIG` com o endereço do portal na Vercel para o botão "Entrar" da área do cliente levar até aqui.

## Estrutura

```
portal-contabil/
├── vercel.json            páginas, cabeçalhos de segurança, agendamentos (cron) e tempo máximo das funções
├── api/                   funções da Vercel (todas repassam para lib/routes.js)
├── lib/
│   ├── routes.js          rotas e regras de acesso (ADM x CLIENTE)
│   ├── auth.js            senhas (scrypt) e sessões no banco
│   ├── totp.js            verificação em duas etapas
│   ├── vault.js           criptografia dos certificados
│   ├── pkcs12.js          leitura do certificado A1 (.pfx), sem dependências
│   ├── sefaz.js           Distribuição DF-e (NF-e/CT-e) e evento de ciência assinado
│   ├── sync.js            busca automática cliente a cliente
│   ├── icp.js             cadeia ICP-Brasil
│   ├── audit.js           registro de atividade
│   ├── doc.js             CPF/CNPJ (inclusive alfanumérico)
│   ├── xml.js, db.js, schema.js, setup.js, http.js
├── public/                site estático (index = entrada, senha, cliente, admin)
└── tests/                 servidor local e testes (npm test)
```

## Rodar localmente

```
npm run dev     # http://localhost:3100 com banco SQLite local (adm@local.test / adm-local-123)
npm test
```

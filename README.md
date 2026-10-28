# Portal Contábil (Vercel)

Relatório de Entradas/Compras a partir de NF-e (XML), com dois perfis:

| Perfil | O que pode fazer |
|---|---|
| **ADM** | Cadastrar clientes, definir/gerar e-mail e senha, liberar ou bloquear o acesso, editar dados do CNPJ, importar XMLs (.zip ou soltos), apagar histórico e abrir o relatório de qualquer cliente. |
| **CLIENTE** | Entrar com o login recebido e ver **somente o próprio** relatório. Não altera e-mail, senha nem dados. |

## Estrutura

```
portal-contabil/
├── vercel.json            publica a pasta public/ e define cabeçalhos de segurança
├── package.json
├── .env.example           variáveis necessárias
├── api/
│   └── [...path].js       função serverless única (recebe tudo de /api/*)
├── lib/                   código do servidor
│   ├── routes.js          rotas e regras de acesso (ADM x CLIENTE)
│   ├── auth.js            senhas (scrypt) e sessão por cookie assinado
│   ├── db.js              conexão com o Postgres
│   ├── schema.js          tabelas (criadas sozinhas no 1º acesso)
│   ├── setup.js           prepara o banco e cria o primeiro ADM
│   └── http.js            utilitários HTTP
├── public/                site estático
│   ├── index.html         login
│   ├── admin.html         painel do ADM
│   ├── cliente.html       relatório do cliente
│   ├── partials/report.html
│   ├── css/               base, components, report, print
│   └── js/                api, util, parser, report, login, admin, cliente
└── tests/                 apoio a testes locais (não é usado em produção)
```

## Publicar na Vercel

1. **Banco de dados:** no painel da Vercel, abra seu projeto → *Storage* → crie um banco **Postgres (Neon)** gratuito e conecte ao projeto. Isso cria a variável `DATABASE_URL`.
2. **Variáveis de ambiente** (*Settings → Environment Variables*):
   - `SESSION_SECRET`: texto aleatório com 32+ caracteres (ex.: gere em https://generate-secret.vercel.app/48).
   - `ADMIN_EMAIL` e `ADMIN_PASSWORD`: login do primeiro ADM (senha com 8+ caracteres).
3. **Enviar o código:** suba esta pasta para um repositório no GitHub e importe em vercel.com/new, ou rode `npx vercel --prod` dentro da pasta. Não precisa configurar *build*.
4. Abra o endereço do projeto e entre com o ADM. As tabelas são criadas automaticamente no primeiro acesso.

`ADMIN_EMAIL`/`ADMIN_PASSWORD` só são usados para criar o primeiro ADM. Depois disso, trocar essas variáveis não altera o ADM existente.

## Observações

- **Sessão:** cookie assinado, `HttpOnly`, `Secure` e `SameSite=Strict`, válido por 12 h. Bloquear um cliente ou trocar o e-mail/senha dele encerra as sessões abertas dele imediatamente.
- **Importação:** o `.zip` é aberto no navegador do ADM e enviado em lotes de 1.000 notas (a Vercel limita cada envio a ~4,5 MB). Só entram notas cujo destinatário é o CNPJ/CPF do cliente escolhido; repetidas são ignoradas pela chave de acesso.
- **Leitura de .zip:** usa a biblioteca JSZip via cdnjs (internet necessária no navegador do ADM).
- **Tentativas de login:** 5 erros seguidos para o mesmo e-mail e IP bloqueiam por 15 minutos.

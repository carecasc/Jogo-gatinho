# 🐱 Batalha dos Gatinhos

Jogo multiplayer online para 2 pessoas (cada uma no seu celular), inspirado em
Batalha Naval — mas com gatinhos, miados sintetizados e **repelentes** que
devolvem o ataque em cruz.

- **Frontend:** Vite + TypeScript + Three.js (3D low poly, câmera estilo auto chess)
- **Backend:** Node.js + Express + Socket.IO (servidor autoritativo)
- **Um único serviço:** o Express serve o build do cliente e o Socket.IO na mesma porta (`PORT`)

## Como jogar

1. Um jogador toca em **Criar sala** e compartilha o link (ou o código de 4 letras).
2. O outro abre o link (ou toca em **Entrar com código**).
3. Cada um posiciona os 5 gatinhos: toque no gato na bandeja, toque na grade para colocar,
   **↻** para girar, **🎲** para posição aleatória, toque num gato já colocado para movê-lo.
   Depois toque em **Pronto**.
4. Na sua vez, toque numa casa do tabuleiro adversário (ela fica destacada) e confirme em
   **Atacar** (ou toque de novo na mesma casa).
5. Depois de atacar você **precisa** esconder um repelente 🧴 numa casa vazia do seu
   tabuleiro (sem gato, sem repelente e ainda não atacada).
6. Se o adversário atacar um repelente seu, ele explode e atinge o tabuleiro **dele** em cruz
   (cima, baixo, esquerda, direita da mesma coordenada).
7. Vence quem eliminar todos os gatos do outro — inclusive se forem eliminados pela explosão.
8. Sair no meio da batalha conta como desistência. Sair durante a preparação libera a vaga
   (outra pessoa pode entrar com o mesmo código).

| Gato | Casas | Miado |
| --- | --- | --- |
| Gato Gordo | 5 | grave e lento |
| Gato Siamês | 4 | agudo e longo |
| Gato Malhado | 3 | médio |
| Gato Preto | 3 | rouco |
| Filhote | 2 | fininho e curto |

## Ajustando as regras

Tudo fica em [`server/src/gameConfig.ts`](server/src/gameConfig.ts):

```ts
repellent: {
  enabled: true,
  blastPattern: [[0, -1], [0, 1], [-1, 0], [1, 0]], // formato da cruz
  maxActive: 3,                     // limite de repelentes ativos (Infinity = sem limite)
  whenLimitReached: 'replaceOldest', // ou 'skip' (não coloca e passa a vez)
  chainReaction: false,             // explosão atinge outro repelente => explode também
},
```

- Para incluir o centro da cruz, adicione `[0, 0]`; para uma cruz maior, adicione `[0, -2]`, `[2, 0]` etc.
- Também dá para mudar o tamanho do tabuleiro (`boardSize`) e a frota (`fleet`).
- Tempo de expiração das salas: `ROOM_CONFIG` no mesmo arquivo (padrão: 30 min sem ações,
  10 min se ninguém estiver conectado).

O cliente recebe a configuração do servidor, então não precisa mexer no frontend.

## Rodando localmente

Requer Node.js 20+.

```bash
npm install
npm test          # testes das regras + multiplayer
npm run build     # compila client e server
npm start         # http://localhost:3000
```

Abra `http://localhost:3000` em **duas abas** (ou dois navegadores / celular na mesma rede
usando o IP do computador) para jogar contra você mesmo.

Desenvolvimento com recarregamento automático (dois terminais):

```bash
npm run dev:server   # servidor na porta 3000
npm run dev:client   # Vite na porta 5173 (proxy do Socket.IO para a 3000)
```

## Publicando no Railway (via GitHub)

1. Suba este repositório para o GitHub.
2. Acesse [railway.com](https://railway.com), faça login e clique em **New Project →
   Deploy from GitHub repo**. Autorize o acesso e escolha o repositório.
3. O Railway detecta o Node.js automaticamente. O arquivo [`railway.json`](railway.json) já
   define:
   - build: `npm run build` (compila cliente e servidor)
   - start: `npm start` (inicia o servidor)
   - health check em `/health`
4. Quando o deploy terminar, vá em **Settings → Networking → Generate Domain** para ganhar
   uma URL pública (ex.: `batalha-dos-gatinhos.up.railway.app`).
5. Abra a URL no celular, crie uma sala e mande o link para a outra pessoa. 🎉

Não é preciso configurar a porta: o servidor usa `process.env.PORT`, que o Railway define.

**Observações**

- As salas ficam na memória do servidor. Um novo deploy/reinício encerra partidas em
  andamento — mantenha **1 réplica** (o padrão).
- Se o build falhar com `tsc: not found` ou `vite: not found`, adicione a variável
  `NPM_CONFIG_PRODUCTION=false` em **Variables** (garante a instalação das devDependencies
  durante o build).

## Estrutura

```
server/
  src/gameConfig.ts   regras ajustáveis (repelente, frota, salas)
  src/game/game.ts    lógica pura do jogo (validação de tudo)
  src/rooms.ts        salas, visão personalizada de cada jogador, expiração
  src/server.ts       Express + Socket.IO
  src/protocol.ts     tipos compartilhados com o cliente
  test/               testes (vitest)
client/
  src/main.ts         interface, fluxo do jogo e fila de animações
  src/net.ts          conexão, sessão e reconexão
  src/audio.ts        miados e efeitos sintetizados (Web Audio API)
  src/scene/          Three.js: cena, gatinhos procedurais, efeitos
```

## Segurança e justiça

- O cliente só envia **intenções** (posicionar, atacar, colocar repelente); o servidor valida
  tudo e responde.
- O servidor **nunca** envia ao cliente a posição dos gatos vivos nem dos repelentes do
  adversário — só resultados de ataques e gatos já eliminados (no fim, os restantes são revelados).
- Reconexão: o ID do jogador fica no `sessionStorage` (por aba) e no `localStorage` (reserva);
  ao voltar (tela bloqueada, rede caiu, recarregou a página) o jogador retorna à mesma
  partida. Duas abas no mesmo navegador funcionam como dois jogadores diferentes.

# Binance Futures Bot Avançado

## Visão Geral

Este projeto é um bot de trading automatizado para Binance Futures, focado em estratégias quantitativas e inteligência artificial. Ele opera múltiplos pares e múltiplos timeframes, combinando estratégias tradicionais (Trend Following, Mean Reversion, Breakout) com um módulo proprietário de IA baseada em perceptron simplificado.

---

## Arquitetura dos Módulos

- **index.js**: Cérebro principal. Orquestra a inicialização, coleta de dados históricos, integração com WebSocket, execução das estratégias e controle de ordens.
- **aiModule.js**: Módulo de Inteligência Artificial. Gerencia coleta de dados, treinamento, normalização, previsão de sinais de entrada/saída e persistência do modelo.
- **dataHttp.js**: Responsável por buscar dados históricos via API HTTP da Binance, processando candles e calculando indicadores para o aquecimento inicial do bot e da IA.
- **websocketService.js**: Gerencia conexões WebSocket para todos os pares/timeframes, atualiza o estado em tempo real, calcula indicadores e notifica o bot principal sobre novas velas.
- **config.json**: Arquivo de configuração central, define pares, timeframes, parâmetros de risco, estratégias e IA.
- **package.json**: Dependências e scripts de execução.

---

## Fluxo de Execução

1. **Inicialização**
   - Carrega configurações e dependências.
   - Inicializa o módulo de IA (carrega modelo, dados e estatísticas).
   - Busca dados históricos via HTTP para todos os pares/timeframes, pré-aquecendo o bot e a IA.
   - Inicia o WebSocket para dados em tempo real, usando o histórico pré-carregado.

2. **Coleta e Processamento de Dados**
   - Cada nova vela finalizada é processada, calculando indicadores (RSI, EMA, Bollinger Bands, SMA de volume).
   - Os dados são enviados para o módulo de IA e para o motor de estratégias.

3. **Execução de Estratégias**
   - O bot avalia sinais da IA e das estratégias tradicionais:
     - **Trend Following**: Confluência de preço acima/abaixo da EMA de longo prazo e RSI em sobrecompra/sobrevenda.
     - **Mean Reversion**: Sinais baseados em toques/extremos das bandas de Bollinger e RSI.
     - **Breakout**: Ruptura das bandas de Bollinger com spike de volume.
   - A IA pode atuar como fonte primária de sinal ou como confluência para as estratégias tradicionais.
   - Em caso de conflito entre IA e estratégia tradicional, o trade é evitado.

4. **Gestão de Posições**
   - O bot monitora posições abertas, aplicando take profit, stop loss, invalidação por estratégia e sinais de saída da IA.

5. **Treinamento da IA**
   - Periodicamente, a IA é treinada com os dados mais recentes, desde que haja dados suficientes para todos os pares/timeframes.
   - O modelo, dados e estatísticas são persistidos em disco.

---

## Estratégias Implementadas

- **Trend Following**
  - Entrada LONG: Preço acima da EMA de confirmação e RSI abaixo do limiar de sobrevenda.
  - Entrada SHORT: Preço abaixo da EMA de confirmação e RSI acima do limiar de sobrecompra.
  - Parâmetros: `emaPeriod`, `rsiPeriod`, `rsiOversold`, `rsiOverbought`, `takeProfitPercent`, `stopLossPercent`.

- **Mean Reversion**
  - Entrada LONG: Preço abaixo da banda inferior de Bollinger e RSI abaixo do limiar.
  - Entrada SHORT: Preço acima da banda superior de Bollinger e RSI acima do limiar.
  - Parâmetros: `bollingerPeriod`, `bollingerStdDev`, `rsiPeriod`, `rsiOversold`, `rsiOverbought`, `takeProfitPercent`, `stopLossPercent`.

- **Breakout**
  - Entrada LONG/SHORT: Ruptura das bandas de Bollinger com volume acima de um múltiplo da SMA de volume.
  - Parâmetros: `bollingerPeriod`, `bollingerStdDev`, `volumeSmaPeriod`, `minVolumeSpike`, `takeProfitPercent`, `stopLossPercent`.

- **IA Proprietária**
  - Modelo linear (perceptron simplificado) treinado com features de candles e indicadores.
  - Sinal de entrada: LONG, SHORT ou HOLD, com confiança.
  - Sinal de saída: CLOSE baseado em análise de lucro/prejuízo e padrões de RSI.
  - Parâmetros: `minDataForTraining`, `learningRate`, `epochs` (definidos no código).

---

## Parâmetros de Configuração (`config.json`)

- **symbolsToWatch**: Lista de pares a monitorar (ex: BTCUSDT, ETHUSDT).
- **timeframesToWatch**: Lista de timeframes (ex: 1m, 5m, 15m, 1h).
- **quoteAsset**: Ativo de margem (ex: USDT).
- **leverage**: Alavancagem utilizada nas operações.
- **marginPercentPerTrade**: Percentual do saldo a ser alocado por trade.
- **takerFeePercent**: Taxa de taker da Binance (em %).
- **strategies**: Bloco de configuração das estratégias tradicionais (Trend Following, Mean Reversion, Breakout), cada uma com seus parâmetros.
- **aiModule**: Bloco de configuração da IA:
  - `enabled`: Ativa/desativa o uso da IA.
  - `trainingIntervalMs`: Intervalo de re-treinamento da IA (em ms).
  - `tradeConfig`: Parâmetros de take profit e stop loss para trades baseados em IA.

---

## Execução

1. Instale as dependências:
   ```bash
   npm install
   ```
2. Configure o arquivo `config.json` conforme desejado.
3. Insira suas chaves de API da Binance no `index.js` (ou adapte para usar `.env`).
4. Inicie o bot:
   ```bash
   npm start
   ```
   Ou, para desenvolvimento com hot reload:
   ```bash
   npm run dev
   ```

---

## Requisitos
- Node.js >= 14
- Conta Binance Futures habilitada
- Chave de API com permissões de trading e leitura de informações de conta

---

## Observações Avançadas
- O modelo de IA é global para todos os pares/timeframes, mas a normalização é feita por par/timeframe.
- O bot armazena dados de candles, modelo e estatísticas em arquivos JSON na raiz do projeto (`ai_data.json`, `ai_model.json`, `ai_stats.json`).
- O sistema de confluência entre IA e estratégias tradicionais visa evitar overfitting e trades de baixa probabilidade.
- O gerenciamento de risco é centralizado e parametrizável.
- O código é modular e facilmente extensível para novas estratégias ou aprimoramento do modelo de IA.

---

## Licença
MIT 
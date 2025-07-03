// =================================================================================================
// websocketService.js: Módulo de Serviço de WebSockets (DADOS EM TEMPO REAL E GERENCIA ESTADO)
// =================================================================================================
const Binance = require('binance-api-node').default;
const { RSI, EMA, SMA, BollingerBands } = require('technicalindicators');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const log = require('./log');

const STRATEGY_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const colors = { reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", magenta: "\x1b[35m", gray: "\x1b[37m" };

let client;
let botState = {}; // O estado principal do bot, mantido aqui e atualizado com WS
let candleCallbacks = {};
let subscribedSymbols = new Set();

// Constantes para os períodos dos indicadores, obtidas da configuração
const requiredCandlesForIndicators = {
    'rsi': STRATEGY_CONFIG.strategies.trendFollowing.rsiPeriod || 14,
    'ema': STRATEGY_CONFIG.strategies.trendFollowing.emaPeriod || 200,
    'bb': STRATEGY_CONFIG.strategies.meanReversion.bollingerPeriod || 20,
    'smaVolume': STRATEGY_CONFIG.strategies.breakout?.volumeSmaPeriod || 20
};
const MIN_CANDLES_FOR_FULL_INDICATORS = Math.max(...Object.values(requiredCandlesForIndicators));

// Utilitário para dividir array em chunks
function chunkArray(array, size) {
    const result = [];
    for (let i = 0; i < array.length; i += size) {
        result.push(array.slice(i, i + size));
    }
    return result;
}

/**
 * Inicializa o serviço de WebSockets e começa a coletar dados em tempo real.
 * Recebe um estado inicial que pode conter dados históricos pré-aquecidos via HTTP.
 * @param {object} binanceClient - O cliente Binance API já autenticado.
 * @param {object} initialBotState - O objeto de estado global do bot, PREENCHIDO com histórico HTTP.
 * @param {function} onCandleReceived - Callback para quando uma nova vela final é processada e o histórico está pronto.
 * @returns {object} O estado do bot atualizado.
 */
async function initialize(binanceClient, initialBotState, onCandleReceived) {
    client = binanceClient;
    botState = initialBotState;
    candleCallbacks.onCandleReceived = onCandleReceivedWrapper;

    log('info', '[WebSocketService] Iniciando monitoramento de dados em tempo real via WebSockets...');
    log('info', `[WebSocketService] Estratégias e IA usarão histórico pré-carregado + dados em tempo real.\n    Mínimo de velas para indicadores: ${MIN_CANDLES_FOR_FULL_INDICATORS}.`);

    // Configuração de margem e alavancagem para cada símbolo (continua individual)
    for (const symbol of STRATEGY_CONFIG.symbolsToWatch) {
        if (!botState[symbol]) {
            botState[symbol] = { data: {}, position: { side: 'NONE', entryPrice: 0, quantity: 0, entryFee: 0, activeStrategy: null, activeStrategyConfig: null } };
        }
        if (!botState[symbol].position) {
             botState[symbol].position = { side: 'NONE', entryPrice: 0, quantity: 0, entryFee: 0, activeStrategy: null, activeStrategyConfig: null };
        }
        try {
            try {
                await client.futuresMarginType({ symbol, marginType: 'ISOLATED' });
            } catch (e) {
                if (e.code !== -4046) log('warning', `  [${symbol}] Aviso: Erro ao definir margem ISOLADA: ${e.message}`);
                else log('warning', `  [${symbol}] Aviso: Tipo de margem já é ISOLADA.`);
            }
            await client.futuresLeverage({ symbol, leverage: STRATEGY_CONFIG.leverage });
            log('info', `  [${symbol}] Alavancagem: ${STRATEGY_CONFIG.leverage}x | Margem: ISOLADA.`);
        } catch (symbolError) {
            log('error', `  [${symbol}] FALHA GERAL ao configurar o par:`, `[${symbolError.code || 'S/C'}] ${symbolError.message}`);
            log('warning', `  [${symbol}] Este par pode não ser totalmente monitorado.`);
        }
    }

    // Antes de montar a lista de streams, filtrar os símbolos se estiver em modo MANAGEMENT_ONLY
    const onlyManagement = typeof global !== 'undefined' && global.tradingMode === 'MANAGEMENT_ONLY';
    let symbolsToSubscribe = STRATEGY_CONFIG.symbolsToWatch;
    if (onlyManagement) {
      const botState = initialBotState || {};
      symbolsToSubscribe = symbolsToSubscribe.filter(symbol => {
        const pos = botState[symbol]?.position;
        return pos && pos.side && pos.side !== 'NONE';
      });
      log('info', `[WEBSOCKET] Modo MANAGEMENT_ONLY: assinando apenas ativos com posição aberta: ${symbolsToSubscribe.join(', ')}`);
    }
    // Monta lista de streams para todos os pares/timeframes
    const streams = [];
    for (const symbol of symbolsToSubscribe) {
            for (const timeframe of STRATEGY_CONFIG.timeframesToWatch) {
                    if (!botState[symbol].data[timeframe]) {
                         botState[symbol].data[timeframe] = { candles: [], indicators: {}, lastPrice: 0, isReady: false };
                    }
                    let isTimeframeAlreadyReady = botState[symbol].data[timeframe].isReady || false;
                    if (isTimeframeAlreadyReady) {
                log('success', `  [${symbol}] [${timeframe}] já está PRÉ-AQUECIDO com ${botState[symbol].data[timeframe].candles.length} velas.`);
                    } else {
                log('warning', `  [${symbol}] [${timeframe}] precisa ser "aquecido" via WebSocket.`);
                    }
            streams.push(`${symbol.toLowerCase()}@kline_${timeframe}`);
        }
    }

    // Divide os streams em grupos de até 900
    const streamChunks = chunkArray(streams, 900);
    const wsConnections = [];

    streamChunks.forEach((chunk, idx) => {
        const wsUrl = `wss://fstream.binance.com/stream?streams=${chunk.join('/')}`;
        let reconnectAttempts = 0;
        function connectWS() {
            const ws = new WebSocket(wsUrl);
            wsConnections.push(ws);
            ws.on('open', () => {
                reconnectAttempts = 0;
                log('info', `[WebSocketService] WebSocket #${idx + 1} aberto com ${chunk.length} streams.`);
            });
            ws.on('message', (msg) => {
                try {
                    const data = JSON.parse(msg);
                    if (data && data.data && data.data.s && data.data.k) {
                        const symbol = data.data.s;
                        const timeframe = data.data.k.i;
                        const candle = {
                            openTime: data.data.k.t,
                            closeTime: data.data.k.T,
                            open: data.data.k.o,
                            high: data.data.k.h,
                            low: data.data.k.l,
                            close: data.data.k.c,
                            volume: data.data.k.v,
                            isFinal: data.data.k.x
                        };
                        const isTimeframeAlreadyReady = botState[symbol] && botState[symbol].data[timeframe] && botState[symbol].data[timeframe].isReady;
                        handleRealtimeCandle(symbol, timeframe, candle, isTimeframeAlreadyReady);
                    }
                } catch (err) {
                    log('error', '[WebSocketService] Erro ao processar mensagem WS:', err);
                }
            });
            ws.on('error', (err) => {
                log('error', `[WebSocketService] Erro no WebSocket #${idx + 1}:`, err.message);
            });
            ws.on('close', () => {
                log('warning', `[WebSocketService] WebSocket #${idx + 1} fechado. Tentando reconectar...`);
                setTimeout(() => {
                    reconnectAttempts++;
                    connectWS();
                }, Math.min(30000, 1000 * Math.pow(2, reconnectAttempts))); // backoff exponencial até 30s
            });
        }
        connectWS();
    });

    subscribedSymbols = new Set(symbolsToSubscribe);

    return botState;
}

/**
 * Lida com uma vela recebida em tempo real, acumula-a, calcula indicadores
 * e chama o callback APENAS se a vela for final E houver histórico suficiente.
 * @param {string} symbol - O símbolo do par.
 * @param {string} timeframe - O tempo gráfico.
 * @param {object} candle - A vela recebida do WebSocket (pode ser parcial ou final).
 * @param {boolean} initialReady - Indica se este timeframe já estava pronto via histórico HTTP.
 */
function handleRealtimeCandle(symbol, timeframe, candle, initialReady) {
    const symbolData = botState[symbol].data[timeframe];

    // Se a vela não for final, apenas atualizamos o último preço e retornamos.
    if (!candle.isFinal) {
        symbolData.lastPrice = parseFloat(candle.close);
        return;
    }

    // Adiciona a nova vela final ao histórico
    symbolData.candles.push(candle);
    // Limita o número de velas em memória.
    // É importante manter um histórico suficiente para os indicadores e para a IA.
    const maxCandlesToStore = Math.max(MIN_CANDLES_FOR_FULL_INDICATORS, 500);
    if (symbolData.candles.length > maxCandlesToStore) {
        symbolData.candles.shift(); // Remove a vela mais antiga
    }
    symbolData.lastPrice = parseFloat(candle.close);

    // Recalcula indicadores com base no histórico atualizado
    const closePrices = symbolData.candles.map(c => parseFloat(c.close));
    const volumes = symbolData.candles.map(c => parseFloat(c.volume));

    const breakoutStrategyConfig = STRATEGY_CONFIG.strategies.breakout || { volumeSmaPeriod: 20 };

    symbolData.indicators = {
        rsi: closePrices.length >= requiredCandlesForIndicators.rsi ? RSI.calculate({ period: requiredCandlesForIndicators.rsi, values: closePrices }).pop() : null,
        ema: closePrices.length >= requiredCandlesForIndicators.ema ? EMA.calculate({ period: requiredCandlesForIndicators.ema, values: closePrices }).pop() : null,
        bb: closePrices.length >= requiredCandlesForIndicators.bb ? BollingerBands.calculate({ period: requiredCandlesForIndicators.bb, stdDev: 2, values: closePrices }).pop() : null,
        smaVolume: volumes.length >= requiredCandlesForIndicators.smaVolume ? SMA.calculate({ period: requiredCandlesForIndicators.smaVolume, values: volumes }).pop() : null,
    };

    // Atualiza a flag `isReady` para o timeframe.
    // Se já estava pronto via HTTP (initialReady), continua pronto.
    // Se não estava pronto, verifica se atingiu o mínimo via WebSocket.
    if (!symbolData.isReady) { // Só atualiza se ainda não estiver pronto
        symbolData.isReady = symbolData.candles.length >= MIN_CANDLES_FOR_FULL_INDICATORS;
        if (symbolData.isReady && !initialReady) { // Se acabou de ficar pronto via WS e não via HTTP
            log('success', `  [${symbol}] [${timeframe}] Histórico "aquecido" via WebSocket (${symbolData.candles.length} velas).`);
        }
    }

    // Notifica o bot principal APENAS se este timeframe estiver pronto para operar (isReady === true)
    if (symbolData.isReady && candleCallbacks.onCandleReceived) {
        candleCallbacks.onCandleReceived(symbol, timeframe, candle, symbolData.indicators);
    } else {
        log('debug', `  [${symbol}] [${timeframe}] Vela final recebida, mas histórico ainda não está PRONTO para operação (${symbolData.candles.length}/${MIN_CANDLES_FOR_FULL_INDICATORS} velas).`);
    }
}

/**
 * Retorna o estado atualizado das velas e indicadores para o bot principal.
 */
function getBotState() {
    return botState;
}

// Função para desinscrever stream de um símbolo
function unsubscribeSymbolStream(symbol) {
  // Fechar WebSocket específico do símbolo
  if (Array.isArray(wsConnections)) {
    for (let i = 0; i < wsConnections.length; i++) {
      const ws = wsConnections[i];
      if (ws && ws.readyState === WebSocket.OPEN) {
        // Verificar se este WebSocket contém o símbolo
        const wsStreams = ws.streams || [];
        if (wsStreams.some(stream => stream.includes(symbol.toLowerCase()))) {
          log('info', `[WEBSOCKET] Fechando WebSocket para ${symbol} (streams: ${wsStreams.join(', ')})`);
          ws.close();
          break; // Fecha apenas o primeiro WebSocket que contém o símbolo
        }
      }
    }
  }
}

// Wrapper para o callback de candle/evento
async function onCandleReceivedWrapper(symbol, timeframe, candle, indicators) {
  // Chama o callback original
  if (candleCallbacks.onCandleReceived && candleCallbacks.onCandleReceived !== onCandleReceivedWrapper) {
    await candleCallbacks.onCandleReceived(symbol, timeframe, candle, indicators);
  }

  // Verifica desinscrição apenas uma vez após o primeiro evento
  if (typeof global !== 'undefined' && global.tradingMode === 'MANAGEMENT_ONLY' && !onCandleReceivedWrapper.checkedOnce) {
    onCandleReceivedWrapper.checkedOnce = true;
    log('info', '[WEBSOCKET] Primeiro evento recebido. Verificando posições abertas para desinscrição...');
    
    const botState = getBotState();
    const symbolsToUnsubscribe = [];
    
    for (const sym of Array.from(subscribedSymbols)) {
      const pos = botState[sym]?.position;
      if (!pos || pos.side === 'NONE') {
        symbolsToUnsubscribe.push(sym);
      }
    }
    
    if (symbolsToUnsubscribe.length > 0) {
      log('info', `[WEBSOCKET] Desinscrevendo ${symbolsToUnsubscribe.length} símbolos sem posição aberta: ${symbolsToUnsubscribe.join(', ')}`);
      
      for (const sym of symbolsToUnsubscribe) {
        unsubscribeSymbolStream(sym);
        subscribedSymbols.delete(sym);
        log('info', `[WEBSOCKET] Desinscrito de ${sym} pois não há posição aberta.`);
      }
    } else {
      log('info', '[WEBSOCKET] Todos os símbolos assinados têm posição aberta. Mantendo assinaturas.');
    }
  }
}

module.exports = {
    initialize,
    getBotState,
    MIN_CANDLES_FOR_FULL_INDICATORS // Exporta para que o bot.js possa usá-lo
};
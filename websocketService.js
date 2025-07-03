// =================================================================================================
// websocketService.js: Módulo de Serviço de WebSockets (DADOS EM TEMPO REAL E GERENCIA ESTADO)
// =================================================================================================
const Binance = require('binance-api-node').default;
const { RSI, EMA, SMA, BollingerBands } = require('technicalindicators');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const STRATEGY_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const colors = { reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", magenta: "\x1b[35m", gray: "\x1b[37m" };

let client;
let botState = {}; // O estado principal do bot, mantido aqui e atualizado com WS
let candleCallbacks = {};

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
    candleCallbacks.onCandleReceived = onCandleReceived;

    console.log('\n[WebSocketService] Iniciando monitoramento de dados em tempo real via WebSockets...');
    console.log(colors.yellow, `[WebSocketService] Estratégias e IA usarão histórico pré-carregado + dados em tempo real.\n    Mínimo de velas para indicadores: ${MIN_CANDLES_FOR_FULL_INDICATORS}.`, colors.reset);

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
                if (e.code !== -4046) console.log(colors.yellow, `  [${symbol}] Aviso: Erro ao definir margem ISOLADA: ${e.message}`);
                else console.log(colors.yellow, `  [${symbol}] Aviso: Tipo de margem já é ISOLADA.`);
            }
            await client.futuresLeverage({ symbol, leverage: STRATEGY_CONFIG.leverage });
            console.log(colors.cyan, `  [${symbol}] Alavancagem: ${STRATEGY_CONFIG.leverage}x | Margem: ISOLADA.`);
        } catch (symbolError) {
            console.error(colors.red, `  [${symbol}] FALHA GERAL ao configurar o par:`, `[${symbolError.code || 'S/C'}] ${symbolError.message}`, colors.reset);
            console.log(colors.yellow, `  [${symbol}] Este par pode não ser totalmente monitorado.`, colors.reset);
        }
    }

    // Monta lista de streams para todos os pares/timeframes
    const streams = [];
    for (const symbol of STRATEGY_CONFIG.symbolsToWatch) {
            for (const timeframe of STRATEGY_CONFIG.timeframesToWatch) {
                    if (!botState[symbol].data[timeframe]) {
                         botState[symbol].data[timeframe] = { candles: [], indicators: {}, lastPrice: 0, isReady: false };
                    }
                    let isTimeframeAlreadyReady = botState[symbol].data[timeframe].isReady || false;
                    if (isTimeframeAlreadyReady) {
                console.log(colors.green, `  [${symbol}] [${timeframe}] já está PRÉ-AQUECIDO com ${botState[symbol].data[timeframe].candles.length} velas.`);
                    } else {
                console.log(colors.yellow, `  [${symbol}] [${timeframe}] precisa ser "aquecido" via WebSocket.`, colors.reset);
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
                console.log(colors.cyan, `[WebSocketService] WebSocket #${idx + 1} aberto com ${chunk.length} streams.`, colors.reset);
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
                    console.error(colors.red, '[WebSocketService] Erro ao processar mensagem WS:', err, colors.reset);
                }
            });
            ws.on('error', (err) => {
                console.error(colors.red, `[WebSocketService] Erro no WebSocket #${idx + 1}:`, err.message, colors.reset);
            });
            ws.on('close', () => {
                console.log(colors.yellow, `[WebSocketService] WebSocket #${idx + 1} fechado. Tentando reconectar...`, colors.reset);
                setTimeout(() => {
                    reconnectAttempts++;
                    connectWS();
                }, Math.min(30000, 1000 * Math.pow(2, reconnectAttempts))); // backoff exponencial até 30s
            });
        }
        connectWS();
    });

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
            console.log(colors.green, `  [${symbol}] [${timeframe}] Histórico "aquecido" via WebSocket (${symbolData.candles.length} velas).`, colors.reset);
        }
    }

    // Notifica o bot principal APENAS se este timeframe estiver pronto para operar (isReady === true)
    if (symbolData.isReady && candleCallbacks.onCandleReceived) {
        candleCallbacks.onCandleReceived(symbol, timeframe, candle, symbolData.indicators);
    } else {
        console.log(colors.gray, `  [${symbol}] [${timeframe}] Vela final recebida, mas histórico ainda não está PRONTO para operação (${symbolData.candles.length}/${MIN_CANDLES_FOR_FULL_INDICATORS} velas).`, colors.reset);
    }
}

/**
 * Retorna o estado atualizado das velas e indicadores para o bot principal.
 */
function getBotState() {
    return botState;
}

module.exports = {
    initialize,
    getBotState,
    MIN_CANDLES_FOR_FULL_INDICATORS // Exporta para que o bot.js possa usá-lo
};
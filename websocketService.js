// =================================================================================================
// websocketService.js: Módulo de Serviço de WebSockets (DADOS EM TEMPO REAL E GERENCIA ESTADO)
// =================================================================================================
const Binance = require('binance-api-node').default;
const { RSI, EMA, SMA, BollingerBands } = require('technicalindicators');
const fs = require('fs');
const path = require('path');

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
    botState = initialBotState; // Recebe o estado já pré-preenchido do bot.js
    candleCallbacks.onCandleReceived = onCandleReceived;

    console.log('\n[WebSocketService] Iniciando monitoramento de dados em tempo real via WebSockets...');
    console.log(colors.yellow, `[WebSocketService] Estratégias e IA usarão histórico pré-carregado + dados em tempo real.
    Mínimo de velas para indicadores: ${MIN_CANDLES_FOR_FULL_INDICATORS}.`, colors.reset);

    for (const symbol of STRATEGY_CONFIG.symbolsToWatch) {
        console.log(`[WebSocketService] Configurando para ${symbol}...`);

        // Certifica-se que a estrutura básica do símbolo e posição existem no botState
        if (!botState[symbol]) {
            botState[symbol] = { data: {}, position: { side: 'NONE', entryPrice: 0, quantity: 0, entryFee: 0, activeStrategy: null, activeStrategyConfig: null } };
        }
        if (!botState[symbol].position) { // Garante que a posição foi inicializada
             botState[symbol].position = { side: 'NONE', entryPrice: 0, quantity: 0, entryFee: 0, activeStrategy: null, activeStrategyConfig: null };
        }


        try {
            // Configurações de margem e alavancagem para o par (ainda são requisições HTTP REST)
            try {
                await client.futuresMarginType({ symbol, marginType: 'ISOLATED' });
            } catch (e) {
                if (e.code !== -4046) console.log(colors.yellow, `  [${symbol}] Aviso: Erro ao definir margem ISOLADA: ${e.message}`);
                else console.log(colors.yellow, `  [${symbol}] Aviso: Tipo de margem já é ISOLADA.`);
            }
            await client.futuresLeverage({ symbol, leverage: STRATEGY_CONFIG.leverage });
            console.log(colors.cyan, `  [${symbol}] Alavancagem: ${STRATEGY_CONFIG.leverage}x | Margem: ISOLADA.`);

            for (const timeframe of STRATEGY_CONFIG.timeframesToWatch) {
                try {
                    // Verifica se este timeframe já foi pré-aquecido via HTTP
                    // Se não, inicializa vazio. Se sim, já tem os dados.
                    if (!botState[symbol].data[timeframe]) {
                         botState[symbol].data[timeframe] = { candles: [], indicators: {}, lastPrice: 0, isReady: false };
                    }
                    // A flag `isReady` (se existir) dirá se já está pronto via HTTP
                    let isTimeframeAlreadyReady = botState[symbol].data[timeframe].isReady || false;

                    // Loga o estado inicial de prontidão
                    if (isTimeframeAlreadyReady) {
                         console.log(colors.green, `  [${symbol}] [${timeframe}] já está PRÉ-AQUECIDO com ${botState[symbol].data[timeframe].candles.length} velas.`);
                    } else {
                         console.log(colors.yellow, `  [${symbol}] [${timeframe}] precisa ser "aquecido" via WebSocket.`, colors.reset);
                    }

                    console.log(`  [${symbol}] Abrindo WebSocket para [${timeframe}]...`);

                    client.ws.futuresCandles(symbol, timeframe, (candle) => {
                        handleRealtimeCandle(symbol, timeframe, candle, isTimeframeAlreadyReady);
                    });

                    console.log(colors.green, `  [${symbol}] Monitoramento de stream em [${timeframe}] iniciado.`);

                    await new Promise(resolve => setTimeout(resolve, 500));

                } catch (tfError) {
                    console.error(colors.red, `  [${symbol}] FALHA ao configurar WebSocket para [${timeframe}]:`, `[${tfError.code || 'S/C'}] ${tfError.message}`, colors.reset);
                    console.log(colors.yellow, `  [${symbol}] Pulando monitoramento para [${timeframe}].`, colors.reset);
                    // Marca o timeframe como não pronto se o WS falhar, mesmo que o HTTP tenha funcionado
                    if (botState[symbol].data[timeframe]) {
                        botState[symbol].data[timeframe].isReady = false;
                    }
                }
            }
        } catch (symbolError) {
            console.error(colors.red, `  [${symbol}] FALHA GERAL ao configurar o par:`, `[${symbolError.code || 'S/C'}] ${symbolError.message}`, colors.reset);
            console.log(colors.yellow, `  [${symbol}] Este par pode não ser totalmente monitorado.`, colors.reset);
        }
    }
    return botState; // Retorna o estado atualizado
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
            console.log(colors.green, `  [${symbol}] [${timeframe}] Histórico "aquecido" via WebSocket (${symbolData.candles.length} velas).`, colors.reset);
        }
    }


    // Notifica o bot principal APENAS se este timeframe estiver pronto para operar (isReady === true)
    if (symbolData.isReady && candleCallbacks.onCandleReceived) {
        candleCallbacks.onCandleReceived(symbol, timeframe, candle, symbolData.indicators);
    } else {
        console.log(colors.gray, `  [${symbol}] [${timeframe}] Vela final recebida, mas histórico ainda não está PRONTO para operação (${symbolData.candles.length}/${MIN_CANDLES_FOR_FULL_INDICATORS} velas).`, colors.reset);
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
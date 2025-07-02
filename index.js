// =================================================================================================
// 1. IMPORTAÇÕES E CONFIGURAÇÃO INICIAL (bot.js)
// =================================================================================================
const Binance = require('binance-api-node').default;
const { RSI, EMA, MACD, SMA, BollingerBands } = require('technicalindicators');
const fs = require('fs');
const path = require('path');

// Importa os módulos
const aiModule = require('./aiModule');
const websocketService = require('./websocketService');
const dataHttp = require('./dataHttp'); // NOVO: Importa o módulo para dados históricos HTTP

// --- ATENÇÃO: DADOS DE AUTENTICAÇÃO ---
const apiKey = '';
const apiSecret = '';

const STRATEGY_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const colors = { reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", magenta: "\x1b[35m", gray: "\x1b[37m" };
// Aumentar o recvWindow para dar mais tempo para as requisições REST
const client = Binance({ apiKey, apiSecret, timeSync: true, recvWindow: 15000 });

// --- ESTADO GLOBAL E REGRAS DE MERCADO ---
let botState = {}; // Gerenciado e atualizado pelo websocketService
let exchangeRules = {};

// =================================================================================================
// 2. CÉREBRO PRINCIPAL DO BOT (ANÁLISE MULTI-TIMEFRAME E AI)
// =================================================================================================

// Função de callback para ser chamada pelo websocketService quando uma nova vela final é processada
async function onNewCandleProcessed(symbol, timeframe, candle, indicators) {
    // console.log(colors.cyan, `\n[${new Date().toLocaleTimeString()}] [${symbol}] [${timeframe}] Nova Vela Processada...`);

    // A IA deve coletar os dados processados em tempo real (do WebSocket)
    aiModule.collectData(symbol, timeframe, candle, indicators);

    // Roda a estratégia principal apenas para o timeframe principal (o primeiro da lista)
    // E APENAS se o histórico para este timeframe estiver "aquecido" via WebSocket
    const isPrimaryTimeframeWebSocketReady = websocketService.getBotState()[symbol]?.data[timeframe]?.candles?.length >= websocketService.MIN_CANDLES_FOR_FULL_INDICATORS;

    if (timeframe === STRATEGY_CONFIG.timeframesToWatch[0] && isPrimaryTimeframeWebSocketReady) {
        await runMasterStrategy(symbol, timeframe);
    } else if (timeframe === STRATEGY_CONFIG.timeframesToWatch[0] && !isPrimaryTimeframeWebSocketReady) {
        console.log(colors.gray, `  [${symbol}] [${timeframe}] Histórico via WebSocket insuficiente para tomar decisões (${websocketService.getBotState()[symbol]?.data[timeframe]?.candles?.length || 0}/${websocketService.MIN_CANDLES_FOR_FULL_INDICATORS} velas).`, colors.reset);
    }
}


async function runMasterStrategy(symbol, timeframe) {
    const symbolState = websocketService.getBotState()[symbol];

    if (!symbolState?.data[timeframe]?.candles || symbolState.data[timeframe].candles.length < websocketService.MIN_CANDLES_FOR_FULL_INDICATORS) {
        // Isso não deve acontecer se onNewCandleProcessed já filtrou
        console.log(`  [${symbol}] [${timeframe}] ATENÇÃO: runMasterStrategy chamado com histórico insuficiente.`);
        return;
    }

    if (symbolState.position.side !== 'NONE') {
        await manageOpenPosition(symbol);
        return;
    }

    const { strategies, aiModule: aiModuleConfig } = STRATEGY_CONFIG;
    let signal = null;
    let aiReasoning = null; // Para guardar a previsão da IA

    // --- LÓGICA DE DECISÃO COMBINADA ---
    // 1. Prioriza o sinal da IA se ela estiver pronta E a confiança for alta
    if (aiModuleConfig.enabled && aiModule.isReadyForTrading()) {
        const aiPrediction = await aiModule.predict(symbol, timeframe, symbolState.data[timeframe].candles);

        if (aiPrediction && aiPrediction.action !== 'HOLD' && aiPrediction.confidence > 70) { // Ex: Confiança > 70% para sinal forte da IA
            console.log(colors.magenta, `\n[${symbol}] 🤖 PREVISÃO DA IA (confiança alta): ${aiPrediction.action} (${aiPrediction.confidence.toFixed(2)}%)`);
            signal = {
                side: aiPrediction.action,
                strategy: 'AI_Prediction',
                config: {
                    takeProfitPercent: aiModuleConfig.tradeConfig.takeProfitPercent,
                    stopLossPercent: aiModuleConfig.tradeConfig.stopLossPercent,
                    useInvalidationExit: true
                }
            };
            aiReasoning = aiPrediction.action;
        } else if (aiPrediction && aiPrediction.action !== 'HOLD' && aiPrediction.confidence > 50) { // Confiança média para usar como confluência
             console.log(colors.gray, `  [${symbol}] 🤖 PREVISÃO DA IA (confiança média): ${aiPrediction.action} (${aiPrediction.confidence.toFixed(2)}%). Usando como confluência.`, colors.reset);
             aiReasoning = aiPrediction.action;
        } else if (aiPrediction && aiPrediction.action === 'HOLD') {
            console.log(colors.gray, `  [${symbol}] 🤖 PREVISÃO DA IA: HOLD (${aiPrediction.confidence.toFixed(2)}%).`, colors.reset);
            aiReasoning = 'HOLD';
        }
    } else if (aiModuleConfig.enabled && !aiModule.isReadyForTrading()) {
        console.log(colors.gray, `  [${symbol}] 🤖 IA ainda em treinamento ou não pronta. Usando apenas estratégias tradicionais.`, colors.reset);
    }

    // 2. Estratégias tradicionais (agora podem usar a "opinião" da IA como confluência)
    if (!signal) { // Se a IA não deu um sinal forte para entrar
        if (strategies.trendFollowing.enabled) {
            const tfSignal = checkTrendFollowingStrategy(symbol, strategies.trendFollowing);
            // Se a IA está pronta E o sinal tradicional faz sentido com a IA
            if (tfSignal && aiModule.isReadyForTrading() && aiReasoning && aiReasoning === tfSignal.side) {
                console.log(colors.green, `\n[${symbol}] 📈 SINAL DE TENDÊNCIA + IA CONFLUÊNCIA: ${tfSignal.side}`);
                signal = tfSignal;
            } else if (tfSignal && (!aiModule.isReadyForTrading() || aiReasoning === 'HOLD')) {
                 // Se IA não está pronta OU IA diz HOLD, ainda considera o sinal tradicional
                console.log(colors.green, `\n[${symbol}] 📈 SINAL DE TENDÊNCIA (IA não relevante ou HOLD): ${tfSignal.side}`);
                signal = tfSignal;
            } else if (tfSignal) {
                console.log(colors.yellow, `\n[${symbol}] 🔀 SINAL DE TENDÊNCIA CONFLITANTE COM IA (${tfSignal.side} vs IA ${aiReasoning}). Ignorando.`, colors.reset);
            }
        }
        
        // Só verifica outras estratégias se ainda não houver um sinal forte (e não conflitante)
        if (!signal && strategies.meanReversion.enabled) {
            const mrSignal = checkMeanReversionStrategy(symbol, strategies.meanReversion);
            if (mrSignal && aiModule.isReadyForTrading() && aiReasoning && aiReasoning === mrSignal.side) {
                console.log(colors.green, `\n[${symbol}] 📈 SINAL DE REVERSÃO + IA CONFLUÊNCIA: ${mrSignal.side}`);
                signal = mrSignal;
            } else if (mrSignal && (!aiModule.isReadyForTrading() || aiReasoning === 'HOLD')) {
                console.log(colors.green, `\n[${symbol}] 📈 SINAL DE REVERSÃO (IA não relevante ou HOLD): ${mrSignal.side}`);
                signal = mrSignal;
            } else if (mrSignal) {
                console.log(colors.yellow, `\n[${symbol}] 🔀 SINAL DE REVERSÃO CONFLITANTE COM IA (${mrSignal.side} vs IA ${aiReasoning}). Ignorando.`, colors.reset);
            }
        }

        if (!signal && strategies.breakout.enabled) {
            const boSignal = checkBreakoutStrategy(symbol, strategies.breakout);
            if (boSignal && aiModule.isReadyForTrading() && aiReasoning && aiReasoning === boSignal.side) {
                console.log(colors.green, `\n[${symbol}] 📈 SINAL DE ROMPIMENTO + IA CONFLUÊNCIA: ${boSignal.side}`);
                signal = boSignal;
            } else if (boSignal && (!aiModule.isReadyForTrading() || aiReasoning === 'HOLD')) {
                console.log(colors.green, `\n[${symbol}] 📈 SINAL DE ROMPIMENTO (IA não relevante ou HOLD): ${boSignal.side}`);
                signal = boSignal;
            } else if (boSignal) {
                console.log(colors.yellow, `\n[${symbol}] 🔀 SINAL DE ROMPIMENTO CONFLITANTE COM IA (${boSignal.side} vs IA ${aiReasoning}). Ignorando.`, colors.reset);
            }
        }
    }
    // FIM DA LÓGICA DE DECISÃO COMBINADA

    if (signal) {
        console.log(colors.green, `\n[${symbol}] 📈 SINAL DE CONFLUÊNCIA FINAL: ${signal.strategy} (${signal.side})`);
        await openPosition(symbol, signal);
    } else {
        console.log(`  [${symbol}] Nenhuma oportunidade com confluência encontrada.`);
    }
}

async function manageOpenPosition(symbol) {
    const symbolState = websocketService.getBotState()[symbol];
    const { entryPrice, side, activeStrategyConfig, activeStrategy } = symbolState.position;
    const { takeProfitPercent, stopLossPercent, useInvalidationExit } = activeStrategyConfig;
    const { takerFeePercent } = STRATEGY_CONFIG;
    const price = symbolState.data[STRATEGY_CONFIG.timeframesToWatch[0]].lastPrice;
    let closeReason = null;

    // 1. Checagem de Stop-Loss e Take-Profit fixos
    const adjustedTakeProfitPercent = takeProfitPercent + (takerFeePercent * 2);
    const slLong = entryPrice * (1 - stopLossPercent / 100);
    const tpLong = entryPrice * (1 + adjustedTakeProfitPercent / 100);
    const slShort = entryPrice * (1 + stopLossPercent / 100);
    const tpShort = entryPrice * (1 - adjustedTakeProfitPercent / 100);

    if (side === 'LONG' && (price <= slLong || price >= tpLong)) {
        closeReason = price <= slLong ? 'STOP-LOSS' : 'TAKE-PROFIT';
    } else if (side === 'SHORT' && (price >= slShort || price <= tpShort)) {
        closeReason = price >= slShort ? 'STOP-LOSS' : 'TAKE-PROFIT';
    }

    // 2. Invalidação impulsionada pela IA ou realização de lucro (se a IA abriu a posição)
    if (!closeReason && activeStrategy === 'AI_Prediction' && useInvalidationExit && STRATEGY_CONFIG.aiModule.enabled && aiModule.isReadyForTrading()) {
        const aiCloseSignal = await aiModule.predictExit(symbol, STRATEGY_CONFIG.timeframesToWatch[0], symbolState.data[STRATEGY_CONFIG.timeframesToWatch[0]].candles, symbolState.position);
        if (aiCloseSignal && aiCloseSignal.action === 'CLOSE') {
            console.log(colors.magenta, `  [${symbol}] 🤖 SINAL DE SAÍDA DA IA: ${aiCloseSignal.reason} (${aiCloseSignal.confidence.toFixed(2)}% de confiança)`);
            closeReason = 'AI_EXIT_SIGNAL';
        }
    }

    // 3. Invalidação de Estratégia Tradicional
    if (!closeReason && useInvalidationExit && activeStrategy !== 'AI_Prediction') {
        let isSignalStillValid = true;
        if (activeStrategy === 'TrendFollowing') {
            const longTermTimeframe = STRATEGY_CONFIG.timeframesToWatch[STRATEGY_CONFIG.timeframesToWatch.length - 1];
            const longTermEma = symbolState.data[longTermTimeframe].indicators.ema;
            if ((side === 'LONG' && price < longTermEma) || (side === 'SHORT' && price > longTermEma)) {
                isSignalStillValid = false;
            }
        } else if (activeStrategy === 'MeanReversion') {
            const triggerTF = STRATEGY_CONFIG.timeframesToWatch[0];
            const { bb } = symbolState.data[triggerTF].indicators;
            if (bb && ((side === 'LONG' && price > bb.middle) || (side === 'SHORT' && price < bb.middle))) {
                isSignalStillValid = false;
            }
        } else if (activeStrategy === 'Breakout') {
            const triggerTF = STRATEGY_CONFIG.timeframesToWatch[0];
            const { bb } = symbolState.data[triggerTF].indicators;
            if (bb && ((side === 'LONG' && price < bb.middle) || (side === 'SHORT' && price > bb.middle))) {
                isSignalStillValid = false;
            }
        }

        if (!isSignalStillValid) {
            closeReason = 'INVALIDATION';
        }
    }

    if (closeReason) {
        console.log(colors.yellow, `\n[${symbol}] 🚨 SINAL PARA FECHAR POSIÇÃO ${side}! Motivo: ${closeReason}`);
        await closePosition(symbol, closeReason);
    } else {
        console.log(`  [${symbol}] Posição ${side} aberta (${symbolState.position.activeStrategy}).`);
    }
}

// =================================================================================================
// 3. MÓDULO DE ESTRATÉGIAS (TRADICIONAIS)
// =================================================================================================

function checkTrendFollowingStrategy(symbol, config) {
    const symbolState = websocketService.getBotState()[symbol];
    const timeframes = STRATEGY_CONFIG.timeframesToWatch;
    const triggerTF = timeframes[0];
    const confirmationTF = timeframes[timeframes.length - 1];

    const triggerIndicators = symbolState.data[triggerTF].indicators;
    const confirmationIndicators = symbolState.data[confirmationTF].indicators;
    const price = symbolState.data[triggerTF].lastPrice;

    if (!triggerIndicators || !confirmationIndicators || triggerIndicators.rsi === null || confirmationIndicators.ema === null) return null;

    const longConfluence =
        price > confirmationIndicators.ema &&
        triggerIndicators.rsi < config.rsiOversold;

    if (longConfluence) {
        return { side: 'LONG', strategy: 'TrendFollowing', config };
    }

    const shortConfluence =
        price < confirmationIndicators.ema &&
        triggerIndicators.rsi > config.rsiOverbought;

    if (shortConfluence) {
        return { side: 'SHORT', strategy: 'TrendFollowing', config };
    }

    return null;
}

function checkMeanReversionStrategy(symbol, config) {
    const symbolState = websocketService.getBotState()[symbol];
    const triggerTF = STRATEGY_CONFIG.timeframesToWatch[0];
    const { bb, rsi } = symbolState.data[triggerTF].indicators;
    const price = symbolState.data[triggerTF].lastPrice;

    if (!bb || !rsi || bb.lower === null || bb.upper === null || rsi === null) return null;

    if (price < bb.lower && rsi < config.rsiOversold) {
        return { side: 'LONG', strategy: 'MeanReversion', config };
    }
    if (price > bb.upper && rsi > config.rsiOverbought) {
        return { side: 'SHORT', strategy: 'MeanReversion', config };
    }
    return null;
}

function checkBreakoutStrategy(symbol, config) {
    const symbolState = websocketService.getBotState()[symbol];
    const triggerTF = STRATEGY_CONFIG.timeframesToWatch[0];
    const { bb, smaVolume } = symbolState.data[triggerTF].indicators;
    const price = symbolState.data[triggerTF].lastPrice;
    const currentVolume = symbolState.data[triggerTF].candles[symbolState.data[triggerTF].candles.length - 1].volume;

    if (!bb || bb.upper === null || bb.lower === null || smaVolume === null || !currentVolume) return null;

    if (price > bb.upper && currentVolume > (smaVolume * config.minVolumeSpike)) {
        return { side: 'LONG', strategy: 'Breakout', config };
    }
    if (price < bb.lower && currentVolume > (smaVolume * config.minVolumeSpike)) {
        return { side: 'SHORT', strategy: 'Breakout', config };
    }
    return null;
}


// =================================================================================================
// 4. FUNÇÕES DE ORDEM E AUXILIARES
// =================================================================================================

async function openPosition(symbol, signal) {
    const { leverage, marginPercentPerTrade, quoteAsset } = STRATEGY_CONFIG;
    const price = websocketService.getBotState()[symbol].data[STRATEGY_CONFIG.timeframesToWatch[0]].lastPrice;

    try {
        const accountInfo = await client.futuresAccountInfo();
        const usdtBalance = parseFloat(accountInfo.assets.find(a => a.asset === quoteAsset)?.availableBalance || '0');
        const marginToUse = usdtBalance * (marginPercentPerTrade / 100);

        if (marginToUse * leverage < 5.1) {
            console.log(colors.yellow, `  [${symbol}] AVISO: Valor da posição (${(marginToUse * leverage).toFixed(2)} USDT) é muito baixo para operar (mínimo Binance: ~5 USDT).`);
            return;
        }

        const positionSizeInUsd = marginToUse * leverage;
        const quantity = positionSizeInUsd / price;
        const formattedQuantity = parseFloat(quantity).toFixed(exchangeRules[symbol].quantityPrecision);

        const order = await client.futuresOrder({
            symbol,
            side: signal.side === 'LONG' ? 'BUY' : 'SELL',
            type: 'MARKET',
            quantity: formattedQuantity,
        });

        const positionState = websocketService.getBotState()[symbol].position;
        positionState.side = signal.side;
        positionState.quantity = parseFloat(order.executedQty);
        positionState.activeStrategy = signal.strategy;
        positionState.activeStrategyConfig = signal.config;

        const trades = await client.futuresUserTrades({ symbol, orderId: order.orderId });
        if (trades && trades.length > 0) {
            positionState.entryFee = parseFloat(trades[0].commission);
            positionState.entryPrice = parseFloat(trades[0].price);
        } else {
            console.log(colors.yellow, `  [${symbol}] Aviso: Detalhes do trade não disponíveis imediatamente. Usando preço e taxa estimados.`);
            positionState.entryFee = (parseFloat(order.executedQty) * price * STRATEGY_CONFIG.takerFeePercent) / 100;
            positionState.entryPrice = price;
        }

        console.log(colors.green, `  [${symbol}] POSIÇÃO ABERTA: ${positionState.side} ${positionState.quantity} @ ${positionState.entryPrice.toFixed(exchangeRules[symbol].quantityPrecision)} (${positionState.activeStrategy})`);
    } catch (error) { handleApiError(error); }
}

async function closePosition(symbol, reason) {
    const positionState = websocketService.getBotState()[symbol].position;
    try {
        const order = await client.futuresOrder({
            symbol,
            side: positionState.side === 'LONG' ? 'SELL' : 'BUY',
            type: 'MARKET',
            quantity: positionState.quantity.toString(),
            reduceOnly: 'true',
        });

        console.log(colors.yellow, `  [${symbol}] POSIÇÃO FECHADA: ${positionState.side} ${positionState.quantity} @ ${websocketService.getBotState()[symbol].data[STRATEGY_CONFIG.timeframesToWatch[0]].lastPrice.toFixed(exchangeRules[symbol].quantityPrecision)}. Motivo: ${reason}`);

        websocketService.getBotState()[symbol].position = { side: 'NONE' };

    } catch (error) { handleApiError(error); }
}

async function main() {
    showHeader(`Bot MTA v5 - [${STRATEGY_CONFIG.symbolsToWatch.join(', ')}]`);
    try {
        console.log('Buscando regras dos ativos...');
        const exchangeInfo = await client.futuresExchangeInfo();
        for (const rule of exchangeInfo.symbols) {
            exchangeRules[rule.symbol] = { quantityPrecision: rule.quantityPrecision };
        }

        console.log('Verificando saldo...');
        const accountInfo = await client.futuresAccountInfo();
        const usdtBalance = parseFloat(accountInfo.assets.find(a => a.asset === STRATEGY_CONFIG.quoteAsset)?.availableBalance || '0');
        if (usdtBalance < 10) {
            console.log(colors.red, `❌ Saldo de ${STRATEGY_CONFIG.quoteAsset} (${usdtBalance.toFixed(2)}) é muito baixo. Mínimo necessário: 10 USDT.`, colors.reset);
            return;
        }
        console.log(colors.green, `✅ Saldo de margem: ${usdtBalance.toFixed(2)} ${STRATEGY_CONFIG.quoteAsset}`);

        // Inicializa o módulo de IA primeiro (carrega modelo, dados e estatísticas)
        console.log('Iniciando módulo de IA...');
        await aiModule.init();

        // NOVO: Busca dados históricos via HTTP para a IA no início
        console.log('\n[Bot] Buscando dados históricos via HTTP para treinamento inicial da IA...');
        dataHttp.setBinanceClient(client); // Passa o cliente Binance para o módulo dataHttp
        for (const symbol of STRATEGY_CONFIG.symbolsToWatch) {
            for (const timeframe of STRATEGY_CONFIG.timeframesToWatch) {
                const historicalData = await dataHttp.getHistoricalData(symbol, timeframe);
                if (historicalData) {
                    aiModule.collectHistoricalDataFromHttp(symbol, timeframe, historicalData);
                }
            }
        }
        console.log('[Bot] Coleta de dados históricos HTTP para IA concluída.');


        // Inicia o serviço de WebSockets para dados em tempo real
        console.log('\nIniciando serviço de WebSockets e monitoramento em tempo real...');
        // botState é inicializado e atualizado pelo websocketService
        botState = await websocketService.initialize(client, botState, onNewCandleProcessed);


        console.log(colors.yellow, "\nO bot está operando. Pressione CTRL + C para parar.", colors.reset);
        console.log(colors.yellow, "A IA começará a treinar periodicamente com os dados coletados.");

        if (STRATEGY_CONFIG.aiModule.enabled) {
            setInterval(async () => {
                // A IA só deve treinar se houver dados suficientes para TODOS os timeframes configurados
                // O treinamento agora usa dados históricos HTTP + dados em tempo real acumulados
                const allTimeframesHaveSomeData = STRATEGY_CONFIG.symbolsToWatch.every(symbol =>
                    STRATEGY_CONFIG.timeframesToWatch.every(tf =>
                        aiModule.getCollectedDataCount(symbol, tf) >= aiModule.aiModel.minDataForTraining
                    )
                );
                
                if (allTimeframesHaveSomeData) {
                    console.log(colors.yellow, "\nIniciando treinamento da IA...");
                    await aiModule.train();
                    console.log(colors.yellow, "Treinamento da IA concluído.");
                } else {
                    console.log(colors.gray, "🤖 IA: Histórico insuficiente em um ou mais timeframes para iniciar o treinamento.", colors.reset);
                }
            }, STRATEGY_CONFIG.aiModule.trainingIntervalMs || 3600000);
        } else {
            console.log(colors.yellow, "Módulo de IA desabilitado na configuração. O treinamento automático não será iniciado.", colors.reset);
        }

    } catch (error) {
        handleApiError(error);
        process.exit(1);
    }
}

function showHeader(title) { console.clear(); console.log(colors.cyan, `================== ${title} ==================\n`, colors.reset); }
function handleApiError(error) { console.error(colors.red, '\n❌ Erro na API:', `[${error.code || 'S/C'}] ${error.message}`, colors.reset); }
function gracefulShutdown() { console.log(colors.yellow, "\nEncerrando bot..."); process.exit(0); }

process.on('SIGINT', gracefulShutdown);
main();
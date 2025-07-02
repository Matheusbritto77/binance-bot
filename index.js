// =================================================================================================
// 1. IMPORTAÇÕES E CONFIGURAÇÃO INICIAL (bot.js)
// =================================================================================================
const Binance = require('binance-api-node').default;
const { RSI, EMA, MACD, SMA, BollingerBands } = require('technicalindicators');
const fs = require('fs');
const path = require('path');

const aiModule = require('./aiModule');
const websocketService = require('./websocketService');
const dataHttp = require('./dataHttp'); // Módulo para dados históricos HTTP

const apiKey = '';
const apiSecret = '';

const STRATEGY_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const colors = { reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", magenta: "\x1b[35m", gray: "\x1b[37m" };
const client = Binance({ apiKey, apiSecret, timeSync: true, recvWindow: 15000 });

let botState = {}; // Será inicializado com dados históricos via HTTP
let exchangeRules = {};

// =================================================================================================
// 2. CÉREBRO PRINCIPAL DO BOT (ANÁLISE MULTI-TIMEFRAME E AI)
// =================================================================================================

async function onNewCandleProcessed(symbol, timeframe, candle, indicators) {
    // console.log(colors.cyan, `\n[${new Date().toLocaleTimeString()}] [${symbol}] [${timeframe}] Nova Vela Processada...`);

    // A IA deve coletar os dados processados em tempo real (do WebSocket)
    aiModule.collectData(symbol, timeframe, candle, indicators);

    // O websocketService agora já garante que o histórico está pronto para notificar o bot
    // Então, se o callback é chamado, podemos prosseguir com a estratégia principal.
    if (timeframe === STRATEGY_CONFIG.timeframesToWatch[0]) {
        console.log(colors.cyan, `\n[${new Date().toLocaleTimeString()}] [${symbol}] [${timeframe}] Vela Principal Processada!`, colors.reset);
        await runMasterStrategy(symbol, timeframe);
    }
}

async function runMasterStrategy(symbol, timeframe) {
    const symbolState = websocketService.getBotState()[symbol];

    // Com o pré-preenchimento, esta checagem deve sempre ser bem-sucedida ao iniciar.
    if (!symbolState?.data[timeframe]?.candles || symbolState.data[timeframe].candles.length < websocketService.MIN_CANDLES_FOR_FULL_INDICATORS) {
        console.log(`  [${symbol}] [${timeframe}] ATENÇÃO: runMasterStrategy chamado com histórico insuficiente APÓS AQUECIMENTO INICIAL. Isso não deveria acontecer.`);
        return;
    }

    if (symbolState.position.side !== 'NONE') {
        await manageOpenPosition(symbol);
        return;
    }

    const { strategies, aiModule: aiModuleConfig } = STRATEGY_CONFIG;
    let signal = null;
    let aiReasoning = null;

    // 1. Prioriza o sinal da IA se ela estiver pronta E a confiança for alta
    if (aiModuleConfig.enabled && aiModule.isReadyForTrading()) {
        const aiPrediction = await aiModule.predict(symbol, timeframe, symbolState.data[timeframe].candles);

        if (aiPrediction && aiPrediction.action !== 'HOLD') {
            if (aiPrediction.confidence > 70) {
                console.log(colors.magenta, `\n[${symbol}] 🤖 PREVISÃO DA IA (confiança ALTA): ${aiPrediction.action} (${aiPrediction.confidence.toFixed(2)}%)`);
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
            } else if (aiPrediction.confidence > 50) {
                console.log(colors.gray, `  [${symbol}] 🤖 PREVISÃO DA IA (confiança média): ${aiPrediction.action} (${aiPrediction.confidence.toFixed(2)}%). Usando como confluência.`, colors.reset);
                aiReasoning = aiPrediction.action;
            }
        } else if (aiPrediction && aiPrediction.action === 'HOLD') {
            console.log(colors.gray, `  [${symbol}] 🤖 PREVISÃO DA IA: HOLD (${aiPrediction.confidence.toFixed(2)}%).`, colors.reset);
            aiReasoning = 'HOLD';
        }
    } else if (aiModuleConfig.enabled && !aiModule.isReadyForTrading()) {
        console.log(colors.gray, `  [${symbol}] 🤖 IA ainda em treinamento ou não pronta. Usando apenas estratégias tradicionais.`, colors.reset);
    }

    // 2. Estratégias tradicionais (agora podem usar a "opinião" da IA como confluência)
    if (!signal) {
        let traditionalSignal = null;
        if (strategies.trendFollowing.enabled) {
            traditionalSignal = checkTrendFollowingStrategy(symbol, strategies.trendFollowing);
        }
        if (!traditionalSignal && strategies.meanReversion.enabled) {
            traditionalSignal = checkMeanReversionStrategy(symbol, strategies.meanReversion);
        }
        if (!traditionalSignal && strategies.breakout.enabled) {
            traditionalSignal = checkBreakoutStrategy(symbol, strategies.breakout);
        }

        if (traditionalSignal) {
            // Se a IA está pronta E a previsão da IA CONFLITA com o sinal tradicional, NÃO operamos
            if (aiModule.isReadyForTrading() && aiReasoning && aiReasoning !== 'HOLD' && aiReasoning !== traditionalSignal.side) {
                console.log(colors.yellow, `\n[${symbol}] 🔀 SINAL TRADICIONAL CONFLITANTE COM IA (${traditionalSignal.side} vs IA ${aiReasoning}). IGNORANDO.`, colors.reset);
                signal = null; // Zera o sinal se houver conflito
            }
            // Se a IA está pronta E a previsão da IA CONFLUI com o sinal tradicional, USAMOS
            else if (aiModule.isReadyForTrading() && aiReasoning === traditionalSignal.side) {
                console.log(colors.green, `\n[${symbol}] 📈 SINAL TRADICIONAL (${traditionalSignal.strategy}) + IA CONFLUÊNCIA: ${traditionalSignal.side}`);
                signal = traditionalSignal;
            }
            // Se a IA NÃO ESTÁ PRONTA OU diz HOLD, usamos o sinal tradicional sem confluência
            else {
                console.log(colors.green, `\n[${symbol}] 📈 SINAL TRADICIONAL (${traditionalSignal.strategy}) (IA não relevante ou HOLD): ${traditionalSignal.side}`);
                signal = traditionalSignal;
            }
        }
    }

    if (signal) {
        console.log(colors.green, `\n[${symbol}] 📈 SINAL DE ENTRADA FINAL: ${signal.strategy} (${signal.side})`);
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

    if (!closeReason && activeStrategy === 'AI_Prediction' && useInvalidationExit && STRATEGY_CONFIG.aiModule.enabled && aiModule.isReadyForTrading()) {
        const aiCloseSignal = await aiModule.predictExit(symbol, STRATEGY_CONFIG.timeframesToWatch[0], symbolState.data[STRATEGY_CONFIG.timeframesToWatch[0]].candles, symbolState.position);
        if (aiCloseSignal && aiCloseSignal.action === 'CLOSE') {
            console.log(colors.magenta, `  [${symbol}] 🤖 SINAL DE SAÍDA DA IA: ${aiCloseSignal.reason} (${aiCloseSignal.confidence.toFixed(2)}% de confiança)`);
            closeReason = 'AI_EXIT_SIGNAL';
        }
    }

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

        // NOVO: Busca dados históricos via HTTP para a IA no início E PRE-PREENCHE botState
        console.log('\n[Bot] Buscando dados históricos via HTTP para treinamento inicial da IA e pré-aquecimento das estratégias...');
        dataHttp.setBinanceClient(client);
        
        // Objeto temporário para acumular os dados históricos que serão passados para o websocketService
        const historicalDataForBotState = {}; 

        for (const symbol of STRATEGY_CONFIG.symbolsToWatch) {
            historicalDataForBotState[symbol] = { data: {} }; // Inicializa a estrutura para o símbolo
            for (const timeframe of STRATEGY_CONFIG.timeframesToWatch) {
                const historicalData = await dataHttp.getHistoricalData(symbol, timeframe);
                
                // Se obteve dados históricos via HTTP, armazena para a IA e para o botState
                if (historicalData && historicalData.length > 0) {
                    aiModule.collectHistoricalDataFromHttp(symbol, timeframe, historicalData);
                    // Copia as velas para o botState ANTES de iniciar os WebSockets
                    historicalDataForBotState[symbol].data[timeframe] = {
                        candles: historicalData, // Usa os candles já processados do dataHttp
                        indicators: historicalData[historicalData.length - 1], // Últimos indicadores da última vela
                        lastPrice: historicalData[historicalData.length - 1].close, // Último preço de fechamento
                        // Marca como pronto pois já tem o histórico via HTTP
                        isReady: true // Uma nova flag para o websocketService saber que já está pronto
                    };
                    console.log(colors.green, `  [Bot] Histórico (${historicalData.length} velas) para ${symbol} - [${timeframe}] PRÉ-AQUECIDO via HTTP.`);
                } else {
                    // Se a busca HTTP falhou ou não retornou dados, o timeframe não estará "aquecido" inicialmente
                    console.log(colors.yellow, `  [Bot] Nenhum histórico HTTP para ${symbol} - [${timeframe}]. Ele aquecerá via WebSocket.`, colors.reset);
                    historicalDataForBotState[symbol].data[timeframe] = {
                        candles: [], indicators: {}, lastPrice: 0, isReady: false
                    };
                }
            }
        }
        console.log('[Bot] Coleta de dados históricos HTTP para IA e pré-aquecimento concluída.');


        // Inicia o serviço de WebSockets para dados em tempo real, passando os dados pré-aquecidos
        console.log('\nIniciando serviço de WebSockets e monitoramento em tempo real...');
        botState = await websocketService.initialize(client, historicalDataForBotState, onNewCandleProcessed);


        console.log(colors.yellow, "\nO bot está operando. Pressione CTRL + C para parar.", colors.reset);
        console.log(colors.yellow, "A IA começará a treinar periodicamente com os dados coletados.");

        if (STRATEGY_CONFIG.aiModule.enabled) {
            setInterval(async () => {
                // A IA só deve treinar se houver dados suficientes para TODOS os timeframes configurados
                // A condição é baseada no aiModule.aiTrainingData (que já tem os dados HTTP + WS)
                const allTimeframesHaveEnoughDataForAI = STRATEGY_CONFIG.symbolsToWatch.every(symbol =>
                    STRATEGY_CONFIG.timeframesToWatch.every(tf =>
                        aiModule.getCollectedDataCount(symbol, tf) >= aiModule.aiModel.minDataForTraining
                    )
                );
                
                if (allTimeframesHaveEnoughDataForAI) {
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
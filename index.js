// =================================================================================================
// 1. IMPORTAÇÕES E CONFIGURAÇÃO INICIAL (bot.js)
// =================================================================================================
let Binance = require('binance-api-node').default;
const { RSI, EMA, MACD, SMA, BollingerBands } = require('technicalindicators');
const fs = require('fs');
const path = require('path');

// Importa os módulos
let aiModule = require('./aiModule');
let websocketService = require('./websocketService');
const dataHttp = require('./dataHttp'); // NOVO: Importa o módulo para dados históricos HTTP
const database = require('./database');

// --- ATENÇÃO: DADOS DE AUTENTICAÇÃO ---
const apiKey = '';
const apiSecret = '';

const STRATEGY_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const colors = { reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", magenta: "\x1b[35m", gray: "\x1b[37m" };
// Aumentar o recvWindow para dar mais tempo para as requisições REST
let client = Binance({ apiKey, apiSecret, timeSync: true, recvWindow: 15000 });

// --- ESTADO GLOBAL E REGRAS DE MERCADO ---
let botState = {}; // Gerenciado e atualizado pelo websocketService
let exchangeRules = {};
let tradingMode = 'FULL_TRADING'; // 'FULL_TRADING' or 'MANAGEMENT_ONLY'

const UPDATE_STATUS_FILE = path.join(__dirname, 'update_status.json');
const UPDATE_INTERVAL_HOURS = 24;


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
        console.log(colors.gray, `  [${symbol}] [${timeframe}] Histórico via WebSocket insuficiente para tomar decisões (${websocketService.getBotState()[symbol]?.data[timeframe]?.candles?.length || 0}/${websocketService.MIN_CANDLES_FOR_FULL_INDICATORS} velas).`, colors.reset);
    }
}


async function runMasterStrategy(symbol, timeframe, manageOpenPositionFn = manageOpenPosition) {
    const symbolState = websocketService.getBotState()[symbol];

    if (!symbolState?.data[timeframe]?.candles || symbolState.data[timeframe].candles.length < websocketService.MIN_CANDLES_FOR_FULL_INDICATORS) {
        console.log(colors.yellow, `[DECISÃO] [${symbol}][${timeframe}] Histórico insuficiente para decisão.`, colors.reset);
        return;
    }

    // Log detalhado dos indicadores e parâmetros
    const triggerTF = STRATEGY_CONFIG.timeframesToWatch[0];
    const confirmationTF = STRATEGY_CONFIG.timeframesToWatch[STRATEGY_CONFIG.timeframesToWatch.length - 1];
    const triggerIndicators = symbolState.data[triggerTF].indicators;
    const confirmationIndicators = symbolState.data[confirmationTF].indicators;
    const price = symbolState.data[triggerTF].lastPrice;
    const currentVolume = symbolState.data[triggerTF].candles[symbolState.data[triggerTF].candles.length - 1]?.volume;
    console.log(colors.cyan, `[DECISÃO] [${symbol}][${timeframe}] Indicadores:`);
    console.log(`  Preço atual: ${price}`);
    console.log(`  RSI: ${triggerIndicators.rsi} | EMA: ${confirmationIndicators.ema} | BB: [${triggerIndicators.bb?.lower}, ${triggerIndicators.bb?.upper}]`);
    console.log(`  Volume: ${currentVolume} | SMA Volume: ${triggerIndicators.smaVolume}`);
    console.log(`  Parâmetros Estratégia:`, STRATEGY_CONFIG.strategies);
    console.log(colors.reset);

    // Always manage open positions, regardless of trading mode
    if (symbolState.position.side !== 'NONE') {
        await manageOpenPositionFn(symbol, timeframe);
        return; // If there's an open position, just manage it and return
    }

    // If in management-only mode and no open position, do not look for new opportunities
    if (tradingMode === 'MANAGEMENT_ONLY') {
        console.log(colors.gray, `  [${symbol}] Modo de gerenciamento ativo. Não buscando novas oportunidades.`, colors.reset);
        return;
    }

    const { strategies, aiModule: aiModuleConfig } = STRATEGY_CONFIG;
    let signal = null;
    let aiReasoning = null; // Para guardar a previsão da IA
    let aiPrediction = null;

    // --- LÓGICA DE DECISÃO COMBINADA ---
    // 1. IA funciona como ponto de equilíbrio/confirmação, não decisão final
    if (aiModuleConfig.enabled && aiModule.isReadyForTrading()) {
        aiPrediction = await aiModule.predict(symbol, timeframe, symbolState.data[timeframe].candles);
        if (aiPrediction) {
            console.log(colors.magenta, `[IA] Previsão: ${aiPrediction.action} (confiança: ${aiPrediction.confidence.toFixed(2)}%)`);
            console.log(`[IA] Features analisadas:`, aiPrediction.features || 'N/A');
            console.log(colors.reset);
        }
        // IA agora é apenas confirmação, não decisão final
        if (aiPrediction && aiPrediction.action !== 'HOLD') {
            aiReasoning = aiPrediction.action;
            console.log(colors.gray, `  [${symbol}] 🤖 IA como confirmação: ${aiPrediction.action} (${aiPrediction.confidence.toFixed(2)}%)`, colors.reset);
        } else if (aiPrediction && aiPrediction.action === 'HOLD') {
            console.log(colors.gray, `  [${symbol}] 🤖 IA: HOLD (${aiPrediction.confidence.toFixed(2)}%).`, colors.reset);
            aiReasoning = 'HOLD';
        }
    } else if (aiModuleConfig.enabled && !aiModule.isReadyForTrading()) {
        console.log(colors.gray, `  [${symbol}] 🤖 IA ainda em treinamento ou não pronta. Usando apenas estratégias tradicionais.`, colors.reset);
    }

    // 2. Estratégias tradicionais são a base da decisão, IA é confirmação
        if (strategies.trendFollowing.enabled) {
            const tfSignal = checkTrendFollowingStrategy(symbol, strategies.trendFollowing);
        if (tfSignal) {
            // Se IA está pronta e concorda com a estratégia tradicional
            if (aiModule.isReadyForTrading() && aiReasoning && aiReasoning === tfSignal.side) {
                console.log(colors.green, `[DECISÃO] SINAL DE TENDÊNCIA + CONFIRMAÇÃO IA: ${tfSignal.side}`);
                signal = tfSignal;
                console.log(colors.green, `[MOTIVO] Sinal aceito: Estratégia tradicional + confirmação IA.`, colors.reset);
            } 
            // Se IA não está pronta ou dá HOLD, aceita estratégia tradicional
            else if (!aiModule.isReadyForTrading() || aiReasoning === 'HOLD') {
                console.log(colors.green, `[DECISÃO] SINAL DE TENDÊNCIA (IA não relevante): ${tfSignal.side}`);
                signal = tfSignal;
                console.log(colors.green, `[MOTIVO] Sinal aceito: Estratégia tradicional válida.`, colors.reset);
            } 
            // Se IA discorda, rejeita o sinal
            else if (aiReasoning && aiReasoning !== tfSignal.side) {
                console.log(colors.yellow, `[DECISÃO] SINAL DE TENDÊNCIA REJEITADO - IA discorda (${tfSignal.side} vs IA ${aiReasoning}).`, colors.reset);
                console.log(colors.yellow, `[MOTIVO] Sinal rejeitado: Conflito com IA.`, colors.reset);
            }
            // Se não há IA, aceita estratégia tradicional
            else if (!aiReasoning) {
                console.log(colors.green, `[DECISÃO] SINAL DE TENDÊNCIA (sem IA): ${tfSignal.side}`);
                signal = tfSignal;
                console.log(colors.green, `[MOTIVO] Sinal aceito: Estratégia tradicional.`, colors.reset);
            }
            }
        }
        
    // Só verifica outras estratégias se ainda não houver um sinal válido
        if (!signal && strategies.meanReversion.enabled) {
            const mrSignal = checkMeanReversionStrategy(symbol, strategies.meanReversion);
        if (mrSignal) {
            // Se IA está pronta e concorda com a estratégia tradicional
            if (aiModule.isReadyForTrading() && aiReasoning && aiReasoning === mrSignal.side) {
                console.log(colors.green, `[DECISÃO] SINAL DE REVERSÃO + CONFIRMAÇÃO IA: ${mrSignal.side}`);
                signal = mrSignal;
                console.log(colors.green, `[MOTIVO] Sinal aceito: Estratégia tradicional + confirmação IA.`, colors.reset);
            } 
            // Se IA não está pronta ou dá HOLD, aceita estratégia tradicional
            else if (!aiModule.isReadyForTrading() || aiReasoning === 'HOLD') {
                console.log(colors.green, `[DECISÃO] SINAL DE REVERSÃO (IA não relevante): ${mrSignal.side}`);
                signal = mrSignal;
                console.log(colors.green, `[MOTIVO] Sinal aceito: Estratégia tradicional válida.`, colors.reset);
            } 
            // Se IA discorda, rejeita o sinal
            else if (aiReasoning && aiReasoning !== mrSignal.side) {
                console.log(colors.yellow, `[DECISÃO] SINAL DE REVERSÃO REJEITADO - IA discorda (${mrSignal.side} vs IA ${aiReasoning}).`, colors.reset);
                console.log(colors.yellow, `[MOTIVO] Sinal rejeitado: Conflito com IA.`, colors.reset);
            }
            // Se não há IA, aceita estratégia tradicional
            else if (!aiReasoning) {
                console.log(colors.green, `[DECISÃO] SINAL DE REVERSÃO (sem IA): ${mrSignal.side}`);
                signal = mrSignal;
                console.log(colors.green, `[MOTIVO] Sinal aceito: Estratégia tradicional.`, colors.reset);
            }
            }
        }

        if (!signal && strategies.breakout.enabled) {
            const boSignal = checkBreakoutStrategy(symbol, strategies.breakout);
        if (boSignal) {
            // Se IA está pronta e concorda com a estratégia tradicional
            if (aiModule.isReadyForTrading() && aiReasoning && aiReasoning === boSignal.side) {
                console.log(colors.green, `[DECISÃO] SINAL DE ROMPIMENTO + CONFIRMAÇÃO IA: ${boSignal.side}`);
                signal = boSignal;
                console.log(colors.green, `[MOTIVO] Sinal aceito: Estratégia tradicional + confirmação IA.`, colors.reset);
            } 
            // Se IA não está pronta ou dá HOLD, aceita estratégia tradicional
            else if (!aiModule.isReadyForTrading() || aiReasoning === 'HOLD') {
                console.log(colors.green, `[DECISÃO] SINAL DE ROMPIMENTO (IA não relevante): ${boSignal.side}`);
                signal = boSignal;
                console.log(colors.green, `[MOTIVO] Sinal aceito: Estratégia tradicional válida.`, colors.reset);
            } 
            // Se IA discorda, rejeita o sinal
            else if (aiReasoning && aiReasoning !== boSignal.side) {
                console.log(colors.yellow, `[DECISÃO] SINAL DE ROMPIMENTO REJEITADO - IA discorda (${boSignal.side} vs IA ${aiReasoning}).`, colors.reset);
                console.log(colors.yellow, `[MOTIVO] Sinal rejeitado: Conflito com IA.`, colors.reset);
            }
            // Se não há IA, aceita estratégia tradicional
            else if (!aiReasoning) {
                console.log(colors.green, `[DECISÃO] SINAL DE ROMPIMENTO (sem IA): ${boSignal.side}`);
                signal = boSignal;
                console.log(colors.green, `[MOTIVO] Sinal aceito: Estratégia tradicional.`, colors.reset);
            }
        }
    }
}

async function manageOpenPosition(symbol, timeframe) {
    const symbolState = websocketService.getBotState()[symbol];
    const { entryPrice, side, activeStrategyConfig, activeStrategy, openTime, maxDurationMs, trailingActive } = symbolState.position;
    const { takeProfitPercent, stopLossPercent, useInvalidationExit, trailingStopPercent = 0.5 } = activeStrategyConfig;
    const { takerFeePercent } = STRATEGY_CONFIG;
    const price = symbolState.data[STRATEGY_CONFIG.timeframesToWatch[0]].lastPrice;
    let closeReason = null;
    const now = Date.now();

    // 1. Trailing Stop baseado em indicador da estratégia
    let trailingIndicatorValue = null;
    if (activeStrategy === 'TrendFollowing') {
        // Usa EMA do timeframe de confirmação
        const confirmationTF = STRATEGY_CONFIG.timeframesToWatch[STRATEGY_CONFIG.timeframesToWatch.length - 1];
        trailingIndicatorValue = symbolState.data[confirmationTF].indicators.ema;
    } else if (activeStrategy === 'MeanReversion') {
        // Usa BB middle do timeframe de entrada
        const triggerTF = STRATEGY_CONFIG.timeframesToWatch[0];
        trailingIndicatorValue = symbolState.data[triggerTF].indicators.bb?.middle;
    } else if (activeStrategy === 'Breakout') {
        // Usa BB oposta ao lado da operação
        const triggerTF = STRATEGY_CONFIG.timeframesToWatch[0];
        const bb = symbolState.data[triggerTF].indicators.bb;
        if (side === 'LONG') trailingIndicatorValue = bb?.lower;
        else if (side === 'SHORT') trailingIndicatorValue = bb?.upper;
    }

    if (trailingIndicatorValue && !isNaN(trailingIndicatorValue)) {
        if (!symbolState.position.trailingActive) {
            symbolState.position.trailingActive = true;
            symbolState.position.trailingStopPrice = trailingIndicatorValue;
            console.log(colors.cyan, `[${symbol}] Trailing stop ativado! Novo stop (indicador): ${trailingIndicatorValue.toFixed(4)}`);
        } else {
            // Só move o trailing se for mais favorável
            if ((side === 'LONG' && trailingIndicatorValue > symbolState.position.trailingStopPrice) ||
                (side === 'SHORT' && trailingIndicatorValue < symbolState.position.trailingStopPrice)) {
                symbolState.position.trailingStopPrice = trailingIndicatorValue;
                console.log(colors.cyan, `[${symbol}] Trailing stop movido para: ${trailingIndicatorValue.toFixed(4)}`);
            }
        }
        // Se o preço atingir o trailing, fecha a posição
        if ((side === 'LONG' && price <= symbolState.position.trailingStopPrice) ||
            (side === 'SHORT' && price >= symbolState.position.trailingStopPrice)) {
            closeReason = 'TRAILING_STOP_HIT';
        }
    }

    // 2. Fechamento automático ao atingir o tempo máximo
    if (openTime && maxDurationMs && now - openTime >= maxDurationMs) {
        closeReason = 'MAX_DURATION_REACHED';
        console.log(colors.yellow, `[${symbol}] Tempo máximo da operação atingido (${maxDurationMs / 60000} min). Fechando posição.`);
    }

    // 3. Decisão baseada em indicadores ao final do tempo
    if (!closeReason && openTime && maxDurationMs && now - openTime >= maxDurationMs * 0.95) {
        // Se está perto do tempo limite, use indicadores para decidir
        const indicators = symbolState.data[timeframe].indicators;
        // Exemplo: se RSI está sobrecomprado em LONG, fecha
        if (side === 'LONG' && indicators.rsi > 70) {
            closeReason = 'RSI_OVERBOUGHT_CLOSE';
        } else if (side === 'SHORT' && indicators.rsi < 30) {
            closeReason = 'RSI_OVERSOLD_CLOSE';
        }
        // (Adicione outras regras de indicadores conforme desejar)
    }

    // 4. Invalidação impulsionada pela IA ou realização de lucro (se a IA abriu a posição)
    if (!closeReason && activeStrategy === 'AI_Prediction' && useInvalidationExit && STRATEGY_CONFIG.aiModule.enabled && aiModule.isReadyForTrading()) {
        const aiCloseSignal = await aiModule.predictExit(symbol, STRATEGY_CONFIG.timeframesToWatch[0], symbolState.data[STRATEGY_CONFIG.timeframesToWatch[0]].candles, symbolState.position);
        if (aiCloseSignal && aiCloseSignal.action === 'CLOSE') {
            console.log(colors.magenta, `  [${symbol}] 🤖 SINAL DE SAÍDA DA IA: ${aiCloseSignal.reason} (${aiCloseSignal.confidence.toFixed(2)}% de confiança)`);
            closeReason = 'AI_EXIT_SIGNAL';
        }
    }

    // 5. Invalidação de Estratégia Tradicional
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
        console.log(colors.yellow, `[GERENCIAMENTO] [${symbol}] ${side} Q:${symbolState.position.quantity} @${price} | Estrat:${symbolState.position.activeStrategy} | Motivo:${closeReason} | Ordem:${symbolState.position.stopOrderId || '-'} / ${symbolState.position.takeOrderId || '-'}`);
        await closePosition(symbol, closeReason);
    } else {
        console.log(colors.cyan, `[GERENCIAMENTO] [${symbol}] ${side} Q:${symbolState.position.quantity} @${price} | Estrat:${symbolState.position.activeStrategy} | OK | Ordem:${symbolState.position.stopOrderId || '-'} / ${symbolState.position.takeOrderId || '-'}`);
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

// Função utilitária para obter saldo USDT do User Data Stream
function getUSDTBalanceFromUserData() {
    if (userAccountInfo && userAccountInfo.B) {
        const usdt = userAccountInfo.B.find(b => b.a === STRATEGY_CONFIG.quoteAsset);
        if (usdt) return parseFloat(usdt.wb);
    }
    return null;
}

async function openPosition(symbol, signal) {
    const { leverage, marginPercentPerTrade, quoteAsset } = STRATEGY_CONFIG;
    const price = websocketService.getBotState()[symbol].data[STRATEGY_CONFIG.timeframesToWatch[0]].lastPrice;
    const strategyConfig = signal.config;
    const maxDurationMs = (strategyConfig.maxOperationDurationMinutes || 60) * 60 * 1000;

    try {
        // Usa saldo do WebSocket se disponível
        let usdtBalance = getUSDTBalanceFromUserData();
        if (usdtBalance === null) {
            // Fallback para REST apenas se necessário
        const accountInfo = await client.futuresAccountInfo();
            usdtBalance = parseFloat(accountInfo.assets.find(a => a.asset === quoteAsset)?.availableBalance || '0');
        }
        const marginToUse = usdtBalance * (marginPercentPerTrade / 100);

        if (marginToUse * leverage < 5.1) {
            console.log(colors.yellow, `  [${symbol}] AVISO: Valor da posição (${(marginToUse * leverage).toFixed(2)} USDT) é muito baixo para operar (mínimo Binance: ~5 USDT).`);
            return;
        }

        const positionSizeInUsd = marginToUse * leverage;
        const quantity = positionSizeInUsd / price;
        const formattedQuantity = parseFloat(quantity).toFixed(exchangeRules[symbol].quantityPrecision);

        // 1. Abre a posição a mercado
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
        positionState.openTime = Date.now();
        positionState.maxDurationMs = maxDurationMs;

        // 2. Calcula preços de stop loss e take profit
        const stopLossPercent = strategyConfig.stopLossPercent;
        const takeProfitPercent = strategyConfig.takeProfitPercent;
        let stopPrice, takePrice;
        if (signal.side === 'LONG') {
            stopPrice = price * (1 - stopLossPercent / 100);
            takePrice = price * (1 + takeProfitPercent / 100);
        } else {
            stopPrice = price * (1 + stopLossPercent / 100);
            takePrice = price * (1 - takeProfitPercent / 100);
        }
        stopPrice = stopPrice.toFixed(exchangeRules[symbol].quantityPrecision);
        takePrice = takePrice.toFixed(exchangeRules[symbol].quantityPrecision);

        // 3. Envia ordens de stop loss e take profit (ordens separadas)
        const stopOrder = await client.futuresOrder({
            symbol,
            side: signal.side === 'LONG' ? 'SELL' : 'BUY',
            type: 'STOP_MARKET',
            stopPrice: stopPrice,
            closePosition: 'true',
        });
        const takeOrder = await client.futuresOrder({
            symbol,
            side: signal.side === 'LONG' ? 'SELL' : 'BUY',
            type: 'TAKE_PROFIT_MARKET',
            stopPrice: takePrice,
            closePosition: 'true',
        });
        positionState.stopOrderId = stopOrder.orderId;
        positionState.takeOrderId = takeOrder.orderId;
        positionState.trailingActive = false;

        // Usa dados do User Data Stream para trade/execução
        let tradeInfo = null;
        if (userOrders[symbol]) {
            tradeInfo = userOrders[symbol];
        }
        if (tradeInfo) {
            positionState.entryFee = parseFloat(tradeInfo.n || 0); // comissão
            positionState.entryPrice = parseFloat(tradeInfo.ap || price); // preço médio
        } else {
            // Fallback para REST apenas se necessário
        const trades = await client.futuresUserTrades({ symbol, orderId: order.orderId });
        if (trades && trades.length > 0) {
            positionState.entryFee = parseFloat(trades[0].commission);
            positionState.entryPrice = parseFloat(trades[0].price);
        } else {
            positionState.entryFee = (parseFloat(order.executedQty) * price * STRATEGY_CONFIG.takerFeePercent) / 100;
            positionState.entryPrice = price;
            }
        }

        console.log(colors.green, `[OP] [${symbol}] ${positionState.side} Q:${positionState.quantity} @${positionState.entryPrice.toFixed(exchangeRules[symbol].quantityPrecision)} | SL:${stopPrice} TP:${takePrice} | Estrat:${positionState.activeStrategy} | Fee:${positionState.entryFee} | Ordem:${order.orderId} SL_ID:${positionState.stopOrderId} TP_ID:${positionState.takeOrderId}`);
        console.log(colors.green, `  [${symbol}] STOP LOSS: ${stopPrice} | TAKE PROFIT: ${takePrice}`);
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

        // Usa dados do User Data Stream para trade/execução de fechamento
        let tradeInfo = null;
        if (userOrders[symbol]) {
            tradeInfo = userOrders[symbol];
        }
        if (tradeInfo) {
            positionState.exitFee = parseFloat(tradeInfo.n || 0); // comissão
            positionState.exitPrice = parseFloat(tradeInfo.ap || websocketService.getBotState()[symbol].data[STRATEGY_CONFIG.timeframesToWatch[0]].lastPrice);
        } else {
            // Fallback para REST apenas se necessário
            // (Opcional: buscar trades de fechamento se necessário)
            positionState.exitFee = 0;
            positionState.exitPrice = websocketService.getBotState()[symbol].data[STRATEGY_CONFIG.timeframesToWatch[0]].lastPrice;
        }

        console.log(colors.yellow, `[FECHAMENTO] [${symbol}] ${positionState.side} Q:${positionState.quantity} @${positionState.exitPrice.toFixed(exchangeRules[symbol].quantityPrecision)} | Estrat:${positionState.activeStrategy} | Motivo:${reason} | Fee:${positionState.exitFee} | Ordem:${order.orderId}`);

        websocketService.getBotState()[symbol].position = { side: 'NONE' };

    } catch (error) { handleApiError(error); }
}

async function allFilesExist(symbols, timeframes) {
    // Checa no MongoDB primeiro
    if (database.isConnected()) {
        try {
            for (const symbol of symbols) {
                for (const timeframe of timeframes) {
                    const historicalData = await database.loadData('historical_data', symbol, timeframe);
                    const rawData = await database.loadData('raw_candles', symbol, timeframe);
                    if (!historicalData || !rawData) {
                        console.log('📊 [MongoDB] Dados ausentes:', symbol, timeframe);
                        return false;
                    }
                }
            }
            const aiData = await database.loadData('ai_data');
            const aiModel = await database.loadData('ai_model');
            const aiStats = await database.loadData('ai_stats');
            if (!aiData || !aiModel || !aiStats) {
                console.log('📊 [MongoDB] Dados globais ausentes');
                return false;
            }
            return true;
        } catch (error) {
            console.log('❌ [MongoDB] Erro ao verificar dados:', error.message);
            return false;
        }
    }
    
    // Fallback para JSON apenas se FORCE_MONGO_ONLY estiver desabilitado
    if (!database.isConnected() || !database.FORCE_MONGO_ONLY) {
        for (const symbol of symbols) {
            for (const timeframe of timeframes) {
                const rawFileName = `raw_candles_${symbol}_${timeframe}.json`;
                const aiFileName = `historical_data_${symbol}_${timeframe}.json`;
                if (!fs.existsSync(path.join(__dirname, 'raw_candles', rawFileName))) {
                    console.log('📁 [JSON] Dados ausentes:', rawFileName);
                    return false;
                }
                if (!fs.existsSync(path.join(__dirname, 'historical_data', aiFileName))) {
                    console.log('📁 [JSON] Dados ausentes:', aiFileName);
                    return false;
                }
            }
        }
        if (!fs.existsSync(path.join(__dirname, 'ai_data', 'ai_data.json'))) {
            console.log('📁 [JSON] Dados ausentes: ai_data.json');
            return false;
        }
        if (!fs.existsSync(path.join(__dirname, 'ai_data', 'ai_model.json'))) {
            console.log('📁 [JSON] Dados ausentes: ai_model.json');
            return false;
        }
        if (!fs.existsSync(path.join(__dirname, 'ai_data', 'ai_stats.json'))) {
            console.log('📁 [JSON] Dados ausentes: ai_stats.json');
            return false;
        }
        return true;
    } else {
        console.log('🚫 [FORCE_MONGO_ONLY] Ignorando verificação de arquivos JSON');
        return false; // Se FORCE_MONGO_ONLY está ativo, sempre retorna false para forçar atualização
    }
}

async function getLastUpdateTime() {
    if (database.isConnected()) {
        try {
            const updateData = await database.loadData('update_status');
            if (updateData) {
                console.log('📊 [MongoDB] Status de atualização carregado do MongoDB');
                return new Date(updateData.lastUpdate || updateData.last_update);
            }
        } catch (error) {
            console.log('❌ [MongoDB] Erro ao buscar status:', error.message);
        }
    }
    
    // Fallback para JSON apenas se FORCE_MONGO_ONLY estiver desabilitado
    if (!database.isConnected() || !database.FORCE_MONGO_ONLY) {
        if (!fs.existsSync(UPDATE_STATUS_FILE)) return null;
        try {
            const data = JSON.parse(fs.readFileSync(UPDATE_STATUS_FILE, 'utf-8'));
            console.log('📁 [JSON] Status de atualização carregado do JSON');
            return data.lastUpdate ? new Date(data.lastUpdate) : null;
        } catch { return null; }
    } else {
        console.log('🚫 [FORCE_MONGO_ONLY] Ignorando JSON para status de atualização');
        return null;
    }
}

async function setLastUpdateTime() {
    if (database.isConnected()) {
        await database.saveData('update_status', { lastUpdate: new Date().toISOString() });
        console.log('📊 [MongoDB] Status de atualização salvo no MongoDB');
    } else {
        // Fallback para JSON apenas se FORCE_MONGO_ONLY estiver desabilitado
        if (!database.FORCE_MONGO_ONLY) {
            fs.writeFileSync(UPDATE_STATUS_FILE, JSON.stringify({ lastUpdate: new Date().toISOString() }, null, 2));
            console.log('📁 [JSON] Status de atualização salvo no JSON');
        } else {
            console.log('🚫 [FORCE_MONGO_ONLY] Ignorando salvamento JSON para status de atualização');
        }
    }
}

// ================= USER DATA STREAM (WebSocket Privado) =====================
let userDataStreamWS = null;
let userDataListenKey = null;
let userAccountInfo = null; // Saldo e posições em tempo real
let userOrders = {}; // Status de ordens em tempo real

async function startUserDataStream() {
    // 1. Solicita listenKey
    userDataListenKey = await client.futuresGetDataStream();
    const listenKey = userDataListenKey.listenKey;
    // 2. Abre WebSocket
    const wsUrl = `wss://fstream.binance.com/ws/${listenKey}`;
    userDataStreamWS = new (require('ws'))(wsUrl);
    userDataStreamWS.on('open', () => {
        console.log(colors.cyan, '[UserDataStream] WebSocket privado aberto!', colors.reset);
    });
    userDataStreamWS.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.e === 'ACCOUNT_UPDATE') {
                // Atualização de saldo e posições
                userAccountInfo = data.a;
                // Exemplo: saldo USDT
                const usdt = userAccountInfo.B.find(b => b.a === STRATEGY_CONFIG.quoteAsset);
                if (usdt) {
                    console.log(colors.green, `[UserDataStream] Saldo atualizado: ${usdt.wb} ${STRATEGY_CONFIG.quoteAsset}`, colors.reset);
                }
            } else if (data.e === 'ORDER_TRADE_UPDATE') {
                // Atualização de ordens/trades
                const order = data.o;
                userOrders[order.s] = order;
                console.log(colors.magenta, `[UserDataStream] Ordem/Trade: ${order.s} ${order.S} ${order.X} ${order.z} @ ${order.ap}`, colors.reset);
            }
        } catch (err) {
            console.error(colors.red, '[UserDataStream] Erro ao processar mensagem:', err, colors.reset);
        }
    });
    userDataStreamWS.on('error', (err) => {
        console.error(colors.red, '[UserDataStream] Erro no WebSocket:', err.message, colors.reset);
    });
    userDataStreamWS.on('close', () => {
        console.log(colors.yellow, '[UserDataStream] WebSocket fechado. Tentando reconectar...', colors.reset);
        setTimeout(startUserDataStream, 10000);
    });
    // 3. Mantém listenKey vivo
    setInterval(async () => {
        if (userDataListenKey) {
            await client.futuresKeepDataStream({ listenKey });
        }
    }, 30 * 60 * 1000); // 30 minutos
}

async function main() {
    showHeader(`Bot MTA v5 - [${STRATEGY_CONFIG.symbolsToWatch.join(', ')}]`);
    try {
        // Inicializa o banco de dados
        console.log('🔌 Inicializando conexão com MongoDB...');
        await database.connect();

        // Inicia o User Data Stream
        await startUserDataStream();

        console.log('Buscando regras dos ativos...');
        const exchangeInfo = await client.futuresExchangeInfo();
        for (const rule of exchangeInfo.symbols) {
            exchangeRules[rule.symbol] = { quantityPrecision: rule.quantityPrecision };
        }

        console.log('Verificando saldo inicial...');
        const accountInfo = await client.futuresAccountInfo();
        const usdtBalance = parseFloat(accountInfo.assets.find(a => a.asset === STRATEGY_CONFIG.quoteAsset)?.availableBalance || '0');
        console.log(colors.green, `✅ Saldo de margem disponível: ${usdtBalance.toFixed(2)} ${STRATEGY_CONFIG.quoteAsset}`);
        const MIN_INITIAL_BALANCE = 10;
        if (usdtBalance < MIN_INITIAL_BALANCE) {
            tradingMode = 'MANAGEMENT_ONLY';
            console.log(colors.yellow, `\n⚠️ Saldo inicial (${usdtBalance.toFixed(2)} ${STRATEGY_CONFIG.quoteAsset}) é inferior a ${MIN_INITIAL_BALANCE} ${STRATEGY_CONFIG.quoteAsset}.`);
            console.log(colors.yellow, `O bot iniciará em modo de GERENCIAMENTO DE POSIÇÕES. Novas operações NÃO serão abertas.`);
            console.log(colors.yellow, `Se houver posições ativas, elas serão gerenciadas até o fechamento.`);
            console.log(colors.yellow, `Para habilitar a abertura de novas posições, deposite pelo menos ${MIN_INITIAL_BALANCE} ${STRATEGY_CONFIG.quoteAsset}.`, colors.reset);
        } else {
            tradingMode = 'FULL_TRADING';
            console.log(colors.green, `Bot iniciando em modo de NEGOCIAÇÃO COMPLETA.`, colors.reset);
        }

        // Lógica de redundância para atualização de dados - SEMPRE PRIORIZA MONGODB
        let needsUpdate = false;
        let mongoDataExists = false;
        
        // Verifica se há dados no MongoDB primeiro
        if (database.isConnected()) {
            console.log(colors.cyan, '[MONGODB] Verificando dados existentes no MongoDB...', colors.reset);
            let totalMongoData = 0;
            
            for (const symbol of STRATEGY_CONFIG.symbolsToWatch) {
                for (const timeframe of STRATEGY_CONFIG.timeframesToWatch) {
                    const rawData = await database.loadData('raw_candles', symbol, timeframe);
                    const historicalData = await database.loadData('historical_data', symbol, timeframe);
                    
                    if (rawData && rawData.length > 0) {
                        totalMongoData += rawData.length;
                        console.log(colors.green, `📊 [MongoDB] ${rawData.length} velas brutas encontradas para ${symbol} - ${timeframe}`, colors.reset);
                    }
                    
                    if (historicalData && historicalData.length > 0) {
                        console.log(colors.green, `📊 [MongoDB] ${historicalData.length} dados históricos processados encontrados para ${symbol} - ${timeframe}`, colors.reset);
                    }
                }
            }
            
            if (totalMongoData > 0) {
                mongoDataExists = true;
                console.log(colors.green, `📊 [MongoDB] Total de ${totalMongoData} velas encontradas no MongoDB`, colors.reset);
            } else {
                console.log(colors.yellow, `📊 [MongoDB] Nenhum dado encontrado no MongoDB. Iniciando ciclo de aquisição...`, colors.reset);
            }
        }
        
        // Se não há dados no MongoDB, verifica JSON como fallback apenas se FORCE_MONGO_ONLY estiver desabilitado
        if (!mongoDataExists) {
            if (!database.isConnected() || !database.FORCE_MONGO_ONLY) {
                if (!(await allFilesExist(STRATEGY_CONFIG.symbolsToWatch, STRATEGY_CONFIG.timeframesToWatch))) {
                    console.log(colors.yellow, '[ATUALIZAÇÃO] Dados ausentes no MongoDB e JSON. Será feita atualização completa.', colors.reset);
                    needsUpdate = true;
                } else {
                    const lastUpdate = await getLastUpdateTime();
                    if (!lastUpdate) {
                        console.log(colors.yellow, '[ATUALIZAÇÃO] Data da última atualização não encontrada. Será feita atualização.', colors.reset);
                        needsUpdate = true;
                    } else {
                        const hoursSince = (Date.now() - lastUpdate.getTime()) / (1000 * 60 * 60);
                        if (hoursSince >= UPDATE_INTERVAL_HOURS) {
                            console.log(colors.yellow, `[ATUALIZAÇÃO] Última atualização há ${hoursSince.toFixed(2)} horas. Será feita atualização.`, colors.reset);
                            needsUpdate = true;
                        } else {
                            console.log(colors.green, `[ATUALIZAÇÃO] Dados atualizados há ${hoursSince.toFixed(2)} horas. Não será feita atualização via HTTP.`, colors.reset);
                        }
                    }
                }
            } else {
                console.log(colors.yellow, '[ATUALIZAÇÃO] FORCE_MONGO_ONLY ativo - dados ausentes no MongoDB, será feita atualização completa.', colors.reset);
                needsUpdate = true;
            }
        } else {
            // Se há dados no MongoDB, verifica se precisa atualizar baseado no tempo
            const lastUpdate = await getLastUpdateTime();
            if (!lastUpdate) {
                console.log(colors.yellow, '[ATUALIZAÇÃO] Dados no MongoDB mas data da última atualização não encontrada. Será feita atualização.', colors.reset);
                needsUpdate = true;
            } else {
                const hoursSince = (Date.now() - lastUpdate.getTime()) / (1000 * 60 * 60);
                if (hoursSince >= UPDATE_INTERVAL_HOURS) {
                    console.log(colors.yellow, `[ATUALIZAÇÃO] Dados no MongoDB mas última atualização há ${hoursSince.toFixed(2)} horas. Será feita atualização.`, colors.reset);
                    needsUpdate = true;
                } else {
                    console.log(colors.green, `[ATUALIZAÇÃO] Dados no MongoDB atualizados há ${hoursSince.toFixed(2)} horas. Não será feita atualização via HTTP.`, colors.reset);
                }
            }
        }

        // Carrega dados existentes (raw/historical/ai_data)
        const MIN_CANDLES_FOR_FULL_INDICATORS = 200;
        for (const symbol of STRATEGY_CONFIG.symbolsToWatch) {
            if (!botState[symbol]) botState[symbol] = { data: {}, position: { side: 'NONE' } };
            for (const timeframe of STRATEGY_CONFIG.timeframesToWatch) {
                // Carrega do MongoDB ou JSON
                let candles = await database.loadData('raw_candles', symbol, timeframe);
                if (!candles) candles = [];
                candles = candles.map(c => ({
                    ...c,
                    open: parseFloat(c.open),
                    high: parseFloat(c.high),
                    low: parseFloat(c.low),
                    close: parseFloat(c.close),
                    volume: parseFloat(c.volume),
                    isFinal: true
                })).sort((a, b) => a.openTime - b.openTime);
                botState[symbol].data[timeframe] = {
                    candles: candles,
                    indicators: {},
                    lastPrice: candles.length > 0 ? parseFloat(candles[candles.length - 1].close) : 0,
                    isReady: candles.length >= MIN_CANDLES_FOR_FULL_INDICATORS
                };
            }
        }

        // Inicializa o módulo de IA
        console.log('Iniciando módulo de IA...');
        await aiModule.init();

        // Carrega dados históricos processados para IA
        for (const symbol of STRATEGY_CONFIG.symbolsToWatch) {
            for (const timeframe of STRATEGY_CONFIG.timeframesToWatch) {
                let historicalProcessedData = await database.loadData('historical_data', symbol, timeframe);
                if (!historicalProcessedData) {
                    // Fallback para JSON já está no database.js
                    historicalProcessedData = [];
                }
                aiModule.collectHistoricalDataFromHttp(symbol, timeframe, historicalProcessedData);
            }
        }

        // Só treina a IA se houve atualização de dados
        if (needsUpdate) {
            // Se precisa atualizar, faz a busca via HTTP, salva e treina IA
            console.log(colors.yellow, '[ATUALIZAÇÃO] Buscando dados históricos via HTTP para atualização...', colors.reset);
            dataHttp.setBinanceClient(client);

            // Monta array de tarefas para busca em lote
            const batchArray = [];
        for (const symbol of STRATEGY_CONFIG.symbolsToWatch) {
            for (const timeframe of STRATEGY_CONFIG.timeframesToWatch) {
                    batchArray.push({ symbol, timeframe });
                }
            }

            // Busca todos os dados em lote
            const batchResults = await dataHttp.getHistoricalDataBatch(batchArray);

            // Alimenta IA e prepara array para salvar em lote
            const saveBatch = [];
            for (const result of batchResults) {
                if (result.data) {
                    aiModule.collectHistoricalDataFromHttp(result.symbol, result.timeframe, result.data);
                    saveBatch.push({
                        collection: 'historical_data',
                        data: result.data,
                        symbol: result.symbol,
                        timeframe: result.timeframe
                    });
                    }
                }
            if (saveBatch.length > 0) {
                await database.saveDataBatch(saveBatch);
            }
            await setLastUpdateTime();
            console.log(colors.green, '[ATUALIZAÇÃO] Dados históricos atualizados e data registrada.', colors.reset);
            // Treinamento da IA sempre após garantir dados atualizados
            await aiModule.train();
            console.log('[Bot] Treinamento da IA concluído.');
        } else {
            console.log(colors.green, '[IA] Dados e modelo já atualizados. Não será feito novo treinamento.', colors.reset);
        }

        // Inicia o serviço de WebSockets para dados em tempo real
        console.log('\nIniciando serviço de WebSockets e monitoramento em tempo real...');
        botState = await websocketService.initialize(client, botState, onNewCandleProcessed);

        console.log(colors.yellow, "\nO bot está operando. Pressione CTRL + C para parar.", colors.reset);
        console.log(colors.yellow, "A IA começará a treinar periodicamente com os dados coletados.");

        if (STRATEGY_CONFIG.aiModule.enabled) {
            setInterval(async () => {
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
    } finally {
        await database.close();
    }
}

function showHeader(title) { console.clear(); console.log(colors.cyan, `================== ${title} ==================\n`, colors.reset); }
function handleApiError(error) {
    // Se a API retornar uma mensagem informativa, mostre-a de forma destacada
    if (error && error.body) {
        try {
            const apiMsg = typeof error.body === 'string' ? JSON.parse(error.body) : error.body;
            if (apiMsg && apiMsg.msg) {
                console.log(colors.yellow, `\n[INFO API] ${apiMsg.msg}`, colors.reset);
                return;
            }
        } catch (e) { /* Se não for JSON, ignora */ }
    }
    // Fallback para o log padrão
    console.error(colors.red, '\n[INFO API]', `[${error.code || 'S/C'}] ${error.message}`, colors.reset);
}
function gracefulShutdown() { console.log(colors.yellow, "\nEncerrando bot..."); process.exit(0); }

process.on('SIGINT', gracefulShutdown);

// No final do arquivo, exporte a função para testes
module.exports = {
  runMasterStrategy,
  manageOpenPosition,
  openPosition // <--- exportando para teste
};

// Só execute main() se o arquivo for chamado diretamente
if (require.main === module) {
main();
}
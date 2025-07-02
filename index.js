// =================================================================================================
// 1. IMPORTAÇÕES E CONFIGURAÇÃO INICIAL (bot.js)
// =================================================================================================
const Binance = require('binance-api-node').default;
const { RSI, EMA, MACD, SMA, BollingerBands } = require('technicalindicators');
const fs = require('fs');
const path = require('path');

const aiModule = require('./aiModule');
const websocketService = require('./websocketService');
const dataHttp = require('./dataHttp');

const apiKey = '';
const apiSecret = ''; // Substitua pela sua chave secreta real!

const STRATEGY_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const colors = { reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", magenta: "\x1b[35m", gray: "\x1b[37m" };
const client = Binance({ apiKey, apiSecret, timeSync: true, recvWindow: 15000 });

let botState = {};
let exchangeRules = {};

// =================================================================================================
// 2. CÉREBRO PRINCIPAL DO BOT (ANÁLISE MULTI-TIMEFRAME E AI)
// =================================================================================================

async function onNewCandleProcessed(symbol, timeframe, candle, indicators) {
    aiModule.collectData(symbol, timeframe, candle, indicators);

    if (timeframe === STRATEGY_CONFIG.timeframesToWatch[0]) {
        await runMasterStrategy(symbol, timeframe);
    }
}

async function runMasterStrategy(symbol, timeframe) {
    const symbolState = websocketService.getBotState()[symbol];

    // Checagem de histórico suficiente. Esta é crucial para estratégias e IA.
    if (!symbolState?.data[timeframe]?.candles || symbolState.data[timeframe].candles.length < websocketService.MIN_CANDLES_FOR_FULL_INDICATORS) {
        console.log(colors.gray, `  [${symbol}] [${timeframe}] Histórico insuficiente (${symbolState.data[timeframe].candles?.length || 0}/${websocketService.MIN_CANDLES_FOR_FULL_INDICATORS}) para tomar decisões ou gerenciar. Aguardando.`, colors.reset);
        return;
    }

    // --- PRIORIDADE MÁXIMA: GERENCIAR POSIÇÕES ABERTAS ---
    // O bot SEMPRE tentará gerenciar posições ativas, independentemente do saldo.
    if (symbolState.position.side !== 'NONE') {
        console.log(colors.cyan, `  [${symbol}] Gerenciando posição ${symbolState.position.side} ativa.`, colors.reset);
        await manageOpenPosition(symbol);
        return; // Termina o ciclo para este símbolo após gerenciar a posição
    }

    // --- Lógica para ABRIR NOVAS POSIÇÕES (requer saldo suficiente) ---
    // Verifica o saldo disponível para novas operações. Esta é a *única* verificação
    // que impede uma NOVA entrada, mas não o gerenciamento de posições existentes.
    const accountInfo = await client.futuresAccountInfo();
    const usdtBalance = parseFloat(accountInfo.assets.find(a => a.asset === STRATEGY_CONFIG.quoteAsset)?.availableBalance || '0');

    if (usdtBalance < STRATEGY_CONFIG.minNotionalForNewOrder) { // Usa um mínimo configurável para entradas
        console.log(colors.yellow, `  [${symbol}] Saldo disponível (${usdtBalance.toFixed(2)} ${STRATEGY_CONFIG.quoteAsset}) abaixo do mínimo para abrir novas posições (${STRATEGY_CONFIG.minNotionalForNewOrder} USDT). Somente observando.`, colors.reset);
        return; // Não procura sinais de entrada se o saldo for muito baixo para uma nova ordem
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
            if (aiModule.isReadyForTrading() && aiReasoning && aiReasoning !== 'HOLD' && aiReasoning !== traditionalSignal.side) {
                console.log(colors.yellow, `\n[${symbol}] 🔀 SINAL TRADICIONAL CONFLITANTE COM IA (${traditionalSignal.side} vs IA ${aiReasoning}). IGNORANDO.`, colors.reset);
                signal = null;
            } else if (aiModule.isReadyForTrading() && aiReasoning === traditionalSignal.side) {
                console.log(colors.green, `\n[${symbol}] 📈 SINAL TRADICIONAL (${traditionalSignal.strategy}) + IA CONFLUÊNCIA: ${traditionalSignal.side}`);
                signal = traditionalSignal;
            } else {
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
    const { entryPrice, side, activeStrategyConfig, activeStrategy, quantity, currentStopLossPrice, currentTakeProfitPrice, stopLossOrderId, takeProfitOrderId } = symbolState.position;
    const { takeProfitPercent, stopLossPercent, useInvalidationExit } = activeStrategyConfig;
    const { takerFeePercent } = STRATEGY_CONFIG;
    const price = symbolState.data[STRATEGY_CONFIG.timeframesToWatch[0]].lastPrice;
    let closeReason = null;

    // Calculo do PnL atual para logs e decisões
    const pnl = side === 'LONG'
        ? (price - entryPrice) * quantity
        : (entryPrice - price) * quantity;
    const pnlPercent = (pnl / (entryPrice * quantity)) * 100;

    console.log(colors.cyan, `  [${symbol}] Posição ${side} aberta (${activeStrategy}). PnL: ${pnl.toFixed(2)} USDT (${pnlPercent.toFixed(2)}%)`, colors.reset);


    // 1. **Verificar SL/TP Fixos ou Dinâmicos (Ordens Ativas na Binance)**
    // Se não há ordens de SL/TP ativas, ou se elas precisam ser atualizadas.
    // Buscamos as ordens ativas na Binance para garantir que nosso estado esteja sincronizado
    // e para poder ajustar uma ordem OCO se necessário.
    let currentOpenOrders;
    try {
        currentOpenOrders = await client.futuresOpenOrders({ symbol });
    } catch (error) {
        console.error(colors.red, `  [${symbol}] ❌ ERRO ao buscar ordens abertas para SL/TP:`, `[${error.code || 'S/C'}] ${error.message}`, colors.reset);
        // Se não conseguir buscar ordens, não podemos gerenciar SL/TP dinamicamente neste ciclo.
        // O bot continuará monitorando, mas as ordens podem não ser ajustadas.
        currentOpenOrders = []; // Trata como se não houvesse ordens abertas
    }

    const slOrderFound = currentOpenOrders.find(o => o.orderId === stopLossOrderId || o.clientOrderId === `SL_${positionState.entryPrice}_${positionState.quantity}` || o.clientOrderId?.startsWith('SL_UPD_'));
    const tpOrderFound = currentOpenOrders.find(o => o.orderId === takeProfitOrderId || o.clientOrderId === `TP_${positionState.entryPrice}_${positionState.quantity}` || o.clientOrderId?.startsWith('TP_UPD_'));

    // Se as ordens não estão no estado do bot, mas estão ativas na Binance, atualizamos o estado
    if (!stopLossOrderId && slOrderFound) symbolState.position.stopLossOrderId = slOrderFound.orderId;
    if (!takeProfitOrderId && tpOrderFound) symbolState.position.takeProfitOrderId = tpOrderFound.orderId;

    // Se ainda não temos IDs de ordens SL/TP (ou elas sumiram da Binance), tentamos colocá-las
    if (!symbolState.position.stopLossOrderId || !symbolState.position.takeProfitOrderId) {
        console.log(colors.yellow, `  [${symbol}] Ordens SL/TP não encontradas ativas. Tentando RECONFIGURAR para a posição aberta.`, colors.reset);
        await placeInitialStopLossAndTakeProfit(symbol, quantity, side, entryPrice, takeProfitPercent, stopLossPercent);
        return; // Retornar para o próximo ciclo para evitar processamento duplicado ou corrida
    }


    // 2. **Lógica de Trailing Stop Loss ou Move Stop to Break Even (Dynamic SL)**
    const currentPnLPercent = pnlPercent;

    const breakEvenPrice = side === 'LONG'
        ? entryPrice * (1 + (takerFeePercent * 2) / 100)
        : entryPrice * (1 - (takerFeePercent * 2) / 100);

    const TRAIL_ACTIVATION_PERCENT = STRATEGY_CONFIG.trailingStop?.activationPercent || 0.5; // Ex: 0.5% lucro
    const TRAIL_PROFIT_PROTECTION_PERCENT = STRATEGY_CONFIG.trailingStop?.profitProtectionPercent || 0.2; // Ex: 0.2% lucro garantido

    let newStopLossPrice = currentStopLossPrice; // Inicializa com o SL atual do estado do bot

    if (side === 'LONG') {
        if (currentPnLPercent >= TRAIL_ACTIVATION_PERCENT) {
            const potentialNewSL = price * (1 - TRAIL_PROFIT_PROTECTION_PERCENT / 100); // SL abaixo do preço atual
            // O novo SL deve ser MAIOR que o SL atual E maior que o breakEvenPrice (para LONG)
            if (potentialNewSL > currentStopLossPrice) {
                newStopLossPrice = Math.max(potentialNewSL, breakEvenPrice);
            }
        }
    } else { // SHORT
        if (currentPnLPercent >= TRAIL_ACTIVATION_PERCENT) {
            const potentialNewSL = price * (1 + TRAIL_PROFIT_PROTECTION_PERCENT / 100); // SL acima do preço atual
            // O novo SL deve ser MENOR que o SL atual E menor que o breakEvenPrice (para SHORT)
            if (potentialNewSL < currentStopLossPrice) {
                newStopLossPrice = Math.min(potentialNewSL, breakEvenPrice);
            }
        }
    }

    // Compara o novo SL calculado com o SL ativo na Binance para evitar chamadas de API desnecessárias
    const SL_PRECISION = exchangeRules[symbol].pricePrecision || 8;
    const formattedNewSL = parseFloat(newStopLossPrice).toFixed(SL_PRECISION);

    // Verifica se há uma mudança significativa e se o novo SL realmente melhora a proteção
    if (Math.abs(parseFloat(formattedNewSL) - currentStopLossPrice) > (0.0001 / Math.pow(10, SL_PRECISION)) // Checa por uma diferença minúscula para floats
        && ((side === 'LONG' && parseFloat(formattedNewSL) > currentStopLossPrice) || (side === 'SHORT' && parseFloat(formattedNewSL) < currentStopLossPrice)) ) {
        
        console.log(colors.magenta, `  [${symbol}] 🚀 MOVENDO STOP LOSS de ${currentStopLossPrice.toFixed(SL_PRECISION)} para ${formattedNewSL}.`, colors.reset);
        const success = await updateStopLoss(symbol, quantity, side, formattedNewSL, symbolState.position.stopLossOrderId, symbolState.position.takeProfitOrderId);
        if (success) {
            symbolState.position.currentStopLossPrice = parseFloat(formattedNewSL); // Atualiza no estado do bot
        }
        return; // Retornar para evitar múltiplas ações no mesmo ciclo
    }


    // 3. Checagem de Stop-Loss e Take-Profit fixos (fallback: se a ordem na Binance falhou ou não foi capturada)
    const adjustedTakeProfitPercent = takeProfitPercent + (takerFeePercent * 2);
    const calculatedSlPrice = entryPrice * (side === 'LONG' ? (1 - stopLossPercent / 100) : (1 + stopLossPercent / 100));
    const calculatedTpPrice = entryPrice * (side === 'LONG' ? (1 + adjustedTakeProfitPercent / 100) : (1 - adjustedTakeProfitPercent / 100));

    if ((side === 'LONG' && price <= calculatedSlPrice) || (side === 'SHORT' && price >= calculatedSlPrice)) {
        closeReason = 'STOP-LOSS_FALLBACK'; // Adicionado _FALLBACK para diferenciar
    } else if ((side === 'LONG' && price >= calculatedTpPrice) || (side === 'SHORT' && price <= calculatedTpPrice)) {
        closeReason = 'TAKE-PROFIT_FALLBACK'; // Adicionado _FALLBACK para diferenciar
    }


    // 4. Invalidação impulsionada pela IA ou realização de lucro (se a IA abriu a posição)
    if (!closeReason && activeStrategy === 'AI_Prediction' && useInvalidationExit && STRATEGY_CONFIG.aiModule.enabled && aiModule.isReadyForTrading()) {
        const aiCloseSignal = await aiModule.predictExit(symbol, STRATEGY_CONFIG.timeframesToWatch[0], symbolState.data[STRATEGY_CONFIG.timeframesToWatch[0]].candles, symbolState.position);
        if (aiCloseSignal && aiCloseSignal.action === 'CLOSE') {
            console.log(colors.magenta, `  [${symbol}] 🤖 SINAL DE SAÍDA DA IA: ${aiCloseSignal.reason} (${aiCloseSignal.confidence.toFixed(2)}% de confiança)`);
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
        console.log(colors.yellow, `\n[${symbol}] 🚨 SINAL PARA FECHAR POSIÇÃO ${side}! Motivo: ${closeReason}`);
        await closePosition(symbol, closeReason);
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
// 4. FUNÇÕES DE ORDEM E AUXILIARES (MODIFICADAS)
// =================================================================================================

// Função para colocar as ordens iniciais de SL e TP (Limitadas)
async function placeInitialStopLossAndTakeProfit(symbol, quantity, side, entryPrice, takeProfitPercent, stopLossPercent) {
    const { takerFeePercent } = STRATEGY_CONFIG;
    // Assume que pricePrecision já está disponível em exchangeRules
    const SL_PRECISION = exchangeRules[symbol].pricePrecision !== undefined ? exchangeRules[symbol].pricePrecision : 8;
    const TP_PRECISION = exchangeRules[symbol].pricePrecision !== undefined ? exchangeRules[symbol].pricePrecision : 8;

    const adjustedTakeProfitPercent = takeProfitPercent + (takerFeePercent * 2);

    const slPriceRaw = side === 'LONG'
        ? entryPrice * (1 - stopLossPercent / 100)
        : entryPrice * (1 + stopLossPercent / 100);
    const tpPriceRaw = side === 'LONG'
        ? entryPrice * (1 + adjustedTakeProfitPercent / 100)
        : entryPrice * (1 - adjustedTakeProfitPercent / 100);

    const formattedSlPrice = parseFloat(slPriceRaw).toFixed(SL_PRECISION);
    const formattedTpPrice = parseFloat(tpPriceRaw).toFixed(TP_PRECISION);

    const orderSideForExit = side === 'LONG' ? 'SELL' : 'BUY';

    // Para evitar ordens "muito próximas" do preço atual na abertura
    // Binance pode rejeitar STOP_MARKET/TAKE_PROFIT_MARKET se stopPrice estiver muito perto do markPrice.
    // Isso é uma consideração avançada para robustez em produção.

    try {
        // Envia a ordem de STOP_MARKET (Stop Loss)
        const stopLossOrder = await client.futuresOrder({
            symbol,
            side: orderSideForExit,
            type: 'STOP_MARKET',
            quantity: quantity.toFixed(exchangeRules[symbol].quantityPrecision),
            stopPrice: formattedSlPrice, // Preço que aciona a ordem a mercado
            closePosition: 'true', // Garante que fecha a posição
            newClientOrderId: `SL_${symbol}_${Date.now()}` // ID único para rastreamento
        });
        console.log(colors.red, `  [${symbol}] 🛑 Ordem STOP_LOSS enviada: ${orderSideForExit} ${quantity.toFixed(exchangeRules[symbol].quantityPrecision)} @ StopPrice ${formattedSlPrice}`);

        // Envia a ordem de TAKE_PROFIT_MARKET (Take Profit)
        const takeProfitOrder = await client.futuresOrder({
            symbol,
            side: orderSideForExit,
            type: 'TAKE_PROFIT_MARKET',
            quantity: quantity.toFixed(exchangeRules[symbol].quantityPrecision),
            stopPrice: formattedTpPrice, // Preço que aciona a ordem a mercado
            closePosition: 'true', // Garante que fecha a posição
            newClientOrderId: `TP_${symbol}_${Date.now()}`
        });
        console.log(colors.green, `  [${symbol}] ✅ Ordem TAKE_PROFIT enviada: ${orderSideForExit} ${quantity.toFixed(exchangeRules[symbol].quantityPrecision)} @ StopPrice ${formattedTpPrice}`);

        // Atualiza o estado da posição com os IDs das ordens e os preços
        const positionState = websocketService.getBotState()[symbol].position;
        positionState.currentStopLossPrice = parseFloat(formattedSlPrice);
        positionState.currentTakeProfitPrice = parseFloat(formattedTpPrice);
        positionState.stopLossOrderId = stopLossOrder.orderId;
        positionState.takeProfitOrderId = takeProfitOrder.orderId;

    } catch (error) {
        console.error(colors.red, `  [${symbol}] ❌ ERRO ao colocar SL/TP iniciais:`, `[${error.code || 'S/C'}] ${error.message}`, colors.reset);
        console.log(colors.yellow, `  [${symbol}] AVISO: Falha ao configurar SL/TP automáticos. Fechando posição para segurança.`, colors.reset);
        await closePosition(symbol, 'FAILED_SL_TP_PLACEMENT'); // Fecha imediatamente para não ficar desprotegido
    }
}

// Função para atualizar o Stop Loss (para Trailing Stop ou Break Even)
async function updateStopLoss(symbol, quantity, side, newStopLossPrice, oldStopLossOrderId) { // oldTakeProfitOrderId não é mais necessário aqui
    const orderSideForExit = side === 'LONG' ? 'SELL' : 'BUY';
    const SL_PRECISION = exchangeRules[symbol].pricePrecision !== undefined ? exchangeRules[symbol].pricePrecision : 8;
    const formattedNewSL = parseFloat(newStopLossPrice).toFixed(SL_PRECISION);

    try {
        // 1. Cancelar a ordem de Stop Loss antiga
        if (oldStopLossOrderId) {
            try {
                await client.futuresCancelOrder({ symbol, orderId: oldStopLossOrderId });
                console.log(colors.red, `  [${symbol}] ↩️ Stop Loss antigo (${oldStopLossOrderId}) CANCELADO.`);
            } catch (cancelError) {
                if (cancelError.code === -2011) { // -2011: Unknown order (já foi preenchida/cancelada)
                    console.log(colors.yellow, `  [${symbol}] Aviso: SL antigo (${oldStopLossOrderId}) já cancelado ou preenchido.`, colors.reset);
                } else {
                    console.error(colors.red, `  [${symbol}] ❌ ERRO ao cancelar SL antigo (${oldStopLossOrderId}):`, cancelError.message, colors.reset);
                    return false; // Retorna false se não conseguir cancelar o antigo
                }
            }
        }

        // 2. Colocar uma nova ordem de STOP_MARKET com o novo preço
        const newStopLossOrder = await client.futuresOrder({
            symbol,
            side: orderSideForExit,
            type: 'STOP_MARKET',
            quantity: quantity.toFixed(exchangeRules[symbol].quantityPrecision),
            stopPrice: formattedNewSL,
            closePosition: 'true',
            newClientOrderId: `SL_UPD_${symbol}_${Date.now()}`
        });
        console.log(colors.red, `  [${symbol}] ⬆️ NOVO STOP_LOSS enviado: ${orderSideForExit} ${quantity.toFixed(exchangeRules[symbol].quantityPrecision)} @ StopPrice ${formattedNewSL}`);

        // Atualiza o estado da posição com o novo ID da ordem de SL
        const positionState = websocketService.getBotState()[symbol].position;
        positionState.currentStopLossPrice = parseFloat(formattedNewSL);
        positionState.stopLossOrderId = newStopLossOrder.orderId;
        return true; // Sucesso na atualização

    } catch (error) {
        console.error(colors.red, `  [${symbol}] ❌ ERRO ao atualizar STOP LOSS:`, `[${error.code || 'S/C'}] ${error.message}`, colors.reset);
        console.log(colors.yellow, `  [${symbol}] AVISO: Falha ao mover o SL. Posição pode estar desprotegida ou fechará no SL original/hard stop.`, colors.reset);
        return false; // Falha na atualização
    }
}

async function openPosition(symbol, signal) {
    const { leverage, marginPercentPerTrade, quoteAsset } = STRATEGY_CONFIG;
    const price = websocketService.getBotState()[symbol].data[STRATEGY_CONFIG.timeframesToWatch[0]].lastPrice;

    try {
        const accountInfo = await client.futuresAccountInfo();
        const usdtBalance = parseFloat(accountInfo.assets.find(a => a.asset === quoteAsset)?.availableBalance || '0');
        const marginToUse = usdtBalance * (marginPercentPerTrade / 100);

        // Verifica se o valor nocional da ordem é suficiente
        if (marginToUse * leverage < STRATEGY_CONFIG.minNotionalForNewOrder) {
            console.log(colors.yellow, `  [${symbol}] AVISO: Saldo insuficiente (${usdtBalance.toFixed(2)} ${quoteAsset}) ou valor da posição (${(marginToUse * leverage).toFixed(2)} USDT) muito baixo para abrir nova posição (mínimo exigido: ${STRATEGY_CONFIG.minNotionalForNewOrder} USDT).`);
            return;
        }

        const positionSizeInUsd = marginToUse * leverage;
        const quantity = positionSizeInUsd / price;
        const formattedQuantity = parseFloat(quantity).toFixed(exchangeRules[symbol].quantityPrecision);

        console.log(colors.green, `  [${symbol}] Tentando abrir posição: ${signal.side} ${formattedQuantity} ${symbol} @ ${price}`);
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
        positionState.stopLossOrderId = null; // Inicializa IDs para que `manageOpenPosition` saiba que precisa colocá-los
        positionState.takeProfitOrderId = null;
        positionState.currentStopLossPrice = 0;
        positionState.currentTakeProfitPrice = 0;

        const trades = await client.futuresUserTrades({ symbol, orderId: order.orderId });
        if (trades && trades.length > 0) {
            positionState.entryFee = parseFloat(trades[0].commission);
            positionState.entryPrice = parseFloat(trades[0].price);
        } else {
            console.log(colors.yellow, `  [${symbol}] Aviso: Detalhes do trade não disponíveis imediatamente. Usando preço e taxa estimados.`);
            positionState.entryFee = (parseFloat(order.executedQty) * price * STRATEGY_CONFIG.takerFeePercent) / 100;
            positionState.entryPrice = price;
        }

        console.log(colors.green, `  [${symbol}] POSIÇÃO ABERTA: ${positionState.side} ${positionState.quantity} @ ${positionState.entryPrice.toFixed(exchangeRules[symbol].pricePrecision)} (${positionState.activeStrategy})`);
        
        // Chamado para colocar as ordens iniciais de SL/TP no próximo ciclo de manageOpenPosition
        // Não chamamos aqui imediatamente para evitar race conditions com a ordem MARKET
        // e permitir que manageOpenPosition sincronize as ordens.
    } catch (error) { handleApiError(error); }
}

async function closePosition(symbol, reason) {
    const positionState = websocketService.getBotState()[symbol].position;
    try {
        // 1. Cancelar quaisquer ordens de SL/TP pendentes antes de fechar a posição
        // Verificar se há um orderId válido antes de tentar cancelar
        if (positionState.stopLossOrderId) {
            try {
                await client.futuresCancelOrder({ symbol, orderId: positionState.stopLossOrderId });
                console.log(colors.red, `  [${symbol}] ↩️ Stop Loss pendente (${positionState.stopLossOrderId}) CANCELADO.`);
            } catch (cancelError) {
                if (cancelError.code === -2011) console.log(colors.yellow, `  [${symbol}] Aviso: SL pendente (${positionState.stopLossOrderId}) já cancelado/preenchido.`, colors.reset);
                else console.error(colors.red, `  [${symbol}] ❌ ERRO ao cancelar SL (${positionState.stopLossOrderId}):`, cancelError.message, colors.reset);
            }
        }
        if (positionState.takeProfitOrderId) {
            try {
                await client.futuresCancelOrder({ symbol, orderId: positionState.takeProfitOrderId });
                console.log(colors.green, `  [${symbol}] ↩️ Take Profit pendente (${positionState.takeProfitOrderId}) CANCELADO.`);
            } catch (cancelError) {
                if (cancelError.code === -2011) console.log(colors.yellow, `  [${symbol}] Aviso: TP pendente (${positionState.takeProfitOrderId}) já cancelado/preenchido.`, colors.reset);
                else console.error(colors.red, `  [${symbol}] ❌ ERRO ao cancelar TP (${positionState.takeProfitOrderId}):`, cancelError.message, colors.reset);
            }
        }

        // 2. Envia a ordem de fechamento da posição
        const order = await client.futuresOrder({
            symbol,
            side: positionState.side === 'LONG' ? 'SELL' : 'BUY',
            type: 'MARKET',
            quantity: positionState.quantity.toString(),
            reduceOnly: 'true',
        });

        // Use pricePrecision para o log de preço de fechamento
        console.log(colors.yellow, `  [${symbol}] POSIÇÃO FECHADA: ${positionState.side} ${positionState.quantity} @ ${websocketService.getBotState()[symbol].data[STRATEGY_CONFIG.timeframesToWatch[0]].lastPrice.toFixed(exchangeRules[symbol].pricePrecision)}. Motivo: ${reason}`);

        // Limpa o estado da posição e IDs de ordens
        websocketService.getBotState()[symbol].position = { side: 'NONE', stopLossOrderId: null, takeProfitOrderId: null, currentStopLossPrice: 0, currentTakeProfitPrice: 0 };

    } catch (error) { handleApiError(error); }
}

async function main() {
    showHeader(`Bot MTA v5 - [${STRATEGY_CONFIG.symbolsToWatch.join(', ')}]`);
    try {
        console.log('Buscando regras dos ativos...');
        const exchangeInfo = await client.futuresExchangeInfo();
        for (const rule of exchangeInfo.symbols) {
            exchangeRules[rule.symbol] = { quantityPrecision: rule.quantityPrecision, pricePrecision: rule.pricePrecision };
        }

        console.log('Verificando saldo inicial...');
        const accountInfo = await client.futuresAccountInfo();
        const usdtBalance = parseFloat(accountInfo.assets.find(a => a.asset === STRATEGY_CONFIG.quoteAsset)?.availableBalance || '0');
        
        // Removida a condição `return` para que o bot sempre continue.
        if (usdtBalance < STRATEGY_CONFIG.minInitialBalance) { // Usar minInitialBalance da config
            console.log(colors.red, `❌ ATENÇÃO: Saldo inicial de ${STRATEGY_CONFIG.quoteAsset} (${usdtBalance.toFixed(2)}) é muito baixo. O bot NÃO ABRIRÁ NOVAS POSIÇÕES até que o saldo aumente, mas CONTINUARÁ MONITORANDO e GERENCIANDO POSIÇÕES ATIVAS.`, colors.reset);
        } else {
            console.log(colors.green, `✅ Saldo de margem inicial: ${usdtBalance.toFixed(2)} ${STRATEGY_CONFIG.quoteAsset}`);
        }

        console.log('Iniciando módulo de IA...');
        await aiModule.init();

        console.log('\n[Bot] Buscando dados históricos via HTTP para treinamento inicial da IA e pré-aquecimento das estratégias...');
        dataHttp.setBinanceClient(client);
        
        const historicalDataForBotState = {}; 

        for (const symbol of STRATEGY_CONFIG.symbolsToWatch) {
            // Inicializa a posição para cada símbolo com os campos de ordens
            historicalDataForBotState[symbol] = { 
                data: {}, 
                position: { 
                    side: 'NONE', 
                    entryPrice: 0, 
                    quantity: 0, 
                    entryFee: 0, 
                    activeStrategy: null, 
                    activeStrategyConfig: null,
                    currentStopLossPrice: 0, 
                    currentTakeProfitPrice: 0, 
                    stopLossOrderId: null,    
                    takeProfitOrderId: null   
                } 
            }; 
            for (const timeframe of STRATEGY_CONFIG.timeframesToWatch) {
                const historicalData = await dataHttp.getHistoricalData(symbol, timeframe);
                
                if (historicalData && historicalData.length > 0) {
                    aiModule.collectHistoricalDataFromHttp(symbol, timeframe, historicalData);
                    historicalDataForBotState[symbol].data[timeframe] = {
                        candles: historicalData,
                        indicators: historicalData[historicalData.length - 1], // Últimos indicadores da última vela
                        lastPrice: historicalData[historicalData.length - 1].close,
                        isReady: true
                    };
                    console.log(colors.green, `  [Bot] Histórico (${historicalData.length} velas) para ${symbol} - [${timeframe}] PRÉ-AQUECIDO via HTTP.`);
                } else {
                    console.log(colors.yellow, `  [Bot] Nenhum histórico HTTP para ${symbol} - [${timeframe}]. Ele aquecerá via WebSocket.`, colors.reset);
                    historicalDataForBotState[symbol].data[timeframe] = {
                        candles: [], indicators: {}, lastPrice: 0, isReady: false
                    };
                }
            }
        }
        console.log('[Bot] Coleta de dados históricos HTTP para IA e pré-aquecimento concluída.');


        console.log('\nIniciando serviço de WebSockets e monitoramento em tempo real...');
        botState = await websocketService.initialize(client, historicalDataForBotState, onNewCandleProcessed, accountInfo);


        console.log(colors.yellow, "\nO bot está operando. Pressione CTRL + C para parar.", colors.reset);
        console.log(colors.yellow, "A IA começará a treinar periodicamente com os dados coletados.");

        if (STRATEGY_CONFIG.aiModule.enabled) {
            setInterval(async () => {
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
// Este é um bot de scalping avançado que escaneia múltiplos pares de moedas no modo MARGEM.

// 1. Importa as bibliotecas necessárias
const Binance = require('binance-api-node').default;
const { RSI, EMA, MACD, SMA } = require('technicalindicators');
const fs = require('fs');

// --- ATENÇÃO: DADOS DE AUTENTICAÇÃO ---
const apiKey = ''; // Substitua pelas suas chaves reais
const apiSecret = ''; // Substitua pelas suas chaves reais

// --- CARREGA CONFIGURAÇÕES DO ARQUIVO JSON ---
const STRATEGY_CONFIG = JSON.parse(fs.readFileSync('config.json'));

// --- CORES E CLIENTE BINANCE ---
const colors = { reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m" };
const client = Binance({ apiKey, apiSecret, timeSync: true });

// --- ESTADO GLOBAL DO BOT (AGORA UM OBJETO PARA MÚLTIPLOS SÍMBOLOS) ---
let botState = {}; // Ex: { 'SOLUSDT': { candles: [], hasPosition: false, lastBuyPrice: 0, liquidationPrice: 0 }, 'ADAUSDT': { ... } }

// =================================================================================================
// FUNÇÃO PRINCIPAL E CONTROLE DO BOT
// =================================================================================================
async function main() {
    showHeader(`Bot Scanner (Margem) - [${STRATEGY_CONFIG.symbolsToWatch.join(', ')}]`);
    try {
        console.log('Verificando saldo inicial e conta de margem...');
        
        // --- 1. Gerenciamento de Fundos (Spot para Margem) ---
        await manageMarginFunds();

        console.log('Iniciando monitoramento de múltiplos pares...');
        for (const symbol of STRATEGY_CONFIG.symbolsToWatch) {
            await initializeSymbol(symbol);
        }
        console.log(colors.yellow, "\nO bot está operando em todos os pares via MARGEM. Pressione CTRL + C para parar.", colors.reset);

        // --- 2. Monitoramento Contínuo de Liquidação (Opcional, para alerta mais rápido) ---
        setInterval(async () => {
            await checkMarginHealth();
        }, 30 * 1000); // Verifica a cada 30 segundos
        
    } catch (error) {
        handleApiError(error);
        process.exit(1);
    }
}

/**
 * Gerencia a transferência automática de fundos do Spot para a carteira de Margem.
 */
async function manageMarginFunds() {
    const { quoteAsset, minMarginBalanceTransfer, transferAmountPercent } = STRATEGY_CONFIG;
    try {
        const spotAccountInfo = await client.accountInfo();
        const usdtSpotBalance = parseFloat(spotAccountInfo.balances.find(b => b.asset === quoteAsset)?.free || '0');

        const marginAccountInfo = await client.marginAccountInfo();
        const usdtMarginBalance = parseFloat(marginAccountInfo.userAssets.find(b => b.asset === quoteAsset)?.free || '0');
        const marginLevel = parseFloat(marginAccountInfo.marginLevel);

        console.log(`\n[FUNDS] Saldo SPOT de ${quoteAsset}: ${usdtSpotBalance.toFixed(2)}`);
        console.log(`[FUNDS] Saldo MARGEM de ${quoteAsset}: ${usdtMarginBalance.toFixed(2)}`);
        console.log(`[FUNDS] Nível de Margem: ${marginLevel.toFixed(2)}`);

        // Condição para transferir: Saldo de Margem muito baixo E Saldo Spot suficiente
        if (usdtMarginBalance < minMarginBalanceTransfer && usdtSpotBalance >= (minMarginBalanceTransfer * 0.5)) { // Garante que há algo no spot para transferir
            const amountToTransfer = usdtSpotBalance * (transferAmountPercent / 100);
            if (amountToTransfer > 0) {
                console.log(colors.yellow, `  [FUNDS] Saldo de margem (${usdtMarginBalance.toFixed(2)}) abaixo do limite (${minMarginBalanceTransfer}).`);
                console.log(colors.yellow, `  [FUNDS] Transferindo ${amountToTransfer.toFixed(2)} ${quoteAsset} do SPOT para MARGEM...`);
                await client.transfer({
                    asset: quoteAsset,
                    amount: amountToTransfer.toFixed(2), // Garante que o valor está formatado corretamente
                    type: 'MAIN_MARGIN' // Para Cross Margin
                });
                console.log(colors.green, `  [FUNDS] Transferência concluída com sucesso!`, colors.reset);
            } else {
                console.log(colors.yellow, `  [FUNDS] Saldo SPOT insuficiente para transferência.`, colors.reset);
            }
        } else {
            console.log(colors.green, `  [FUNDS] Saldo de margem OK.`, colors.reset);
        }

        if (usdtMarginBalance < 11 && usdtSpotBalance < 11) { // Mínimo para operar
            console.log(colors.red, `❌ Saldo total (${quoteAsset}) muito baixo para iniciar as operações.`, colors.reset);
            process.exit(1);
        }
    } catch (error) {
        console.error(colors.red, `Erro ao gerenciar fundos de margem:`, error.body || error.message, colors.reset);
    }
}

/**
 * Verifica a saúde geral da conta de margem e o risco de liquidação.
 */
async function checkMarginHealth() {
    const { targetMarginLevel } = STRATEGY_CONFIG;
    try {
        const marginAccountInfo = await client.marginAccountInfo();
        const marginLevel = parseFloat(marginAccountInfo.marginLevel);
        
        console.log(colors.yellow, `\n[RISK] Nível de Margem Geral: ${marginLevel.toFixed(2)} (Alvo: >${targetMarginLevel})`);

        if (marginLevel <= targetMarginLevel) {
            console.log(colors.red, `🚨🚨🚨 [RISK] NÍVEL DE MARGEM CRÍTICO! ${marginLevel.toFixed(2)} Abaixo do alvo (${targetMarginLevel}). Risco de LIQUIDAÇÃO!`);
            console.log(colors.red, `  Considere adicionar fundos ou fechar posições manualmente.`, colors.reset);
            // Aqui você poderia adicionar lógica para:
            // 1. Enviar um alerta (e-mail, Telegram).
            // 2. Tentar fechar todas as posições (fechamento de emergência).
            // 3. Transferir mais fundos (se houver no Spot e não tiver sido feito).
        }
        
        // Para cada símbolo com posição aberta, verificar o preço de liquidação
        for (const symbol of STRATEGY_CONFIG.symbolsToWatch) {
            const state = botState[symbol];
            if (state && state.hasPosition && state.liquidationPrice > 0) {
                const currentPrice = parseFloat(state.candles[state.candles.length - 1]?.close || 0);
                if (currentPrice > 0) {
                    const distanceToLiquidation = ((currentPrice - state.liquidationPrice) / currentPrice) * 100;
                    const color = distanceToLiquidation < 5 ? colors.red : (distanceToLiquidation < 10 ? colors.yellow : colors.green);
                    console.log(color, `  [RISK] [${symbol}] Preço Atual: ${currentPrice.toFixed(4)} | Preço de Liquidação: ${state.liquidationPrice.toFixed(4)} | Distância: ${distanceToLiquidation.toFixed(2)}%`, colors.reset);
                    
                    if (distanceToLiquidation < 2) { // Exemplo: alerta muito próximo da liquidação
                        console.log(colors.red, `    [RISK] ⚠️⚠️⚠️ [${symbol}] MUITO PRÓXIMO DA LIQUIDAÇÃO!`, colors.reset);
                        // Lógica de emergência para fechar a posição se o risco for extremo
                        // await executeSellOrder(symbol, currentPrice, "LIQUIDACAO_EMINENTE", state.baseAssetAmount);
                    }
                }
            }
        }
    } catch (error) {
        console.error(colors.red, `Erro ao verificar saúde da margem:`, error.body || error.message, colors.reset);
    }
}


async function initializeSymbol(symbol) {
    console.log(`[${symbol}] Buscando histórico de candles...`);
    botState[symbol] = {
        websocket: null,
        candles: [],
        hasPosition: false,
        lastBuyPrice: 0,
        liquidationPrice: 0, // Adicionado para armazenar o preço de liquidação
        baseAssetAmount: 0 // Quantidade do ativo base em posse
    };

    const historicalCandles = await client.candles({ symbol, interval: STRATEGY_CONFIG.interval, limit: STRATEGY_CONFIG.emaPeriod + 50 });
    botState[symbol].candles = historicalCandles;

    botState[symbol].websocket = client.ws.candles(symbol, STRATEGY_CONFIG.interval, (candle) => {
        if (candle.isFinal) {
            handleCandle(candle);
        }
    });
    console.log(colors.green, `[${symbol}] Monitoramento em tempo real iniciado.`);
}

/**
 * Função central que recebe todos os candles e direciona para a análise correta.
 */
async function handleCandle(candle) {
    const symbol = candle.symbol;
    const currentPrice = parseFloat(candle.close);
    console.log(colors.cyan, `\n[${new Date().toLocaleTimeString()}] [${symbol}] Preço: ${currentPrice.toFixed(4)}`);
    
    const state = botState[symbol];
    state.candles.push(candle);
    if (state.candles.length > STRATEGY_CONFIG.emaPeriod + 50) state.candles.shift();
    
    const closePrices = state.candles.map(c => parseFloat(c.close));
    const volumes = state.candles.map(c => parseFloat(c.volume));
    const macdInput = { values: closePrices, ...STRATEGY_CONFIG.macd };

    const indicators = {
        rsi: RSI.calculate({ period: STRATEGY_CONFIG.rsiPeriod, values: closePrices }).pop(),
        ema: EMA.calculate({ period: STRATEGY_CONFIG.emaPeriod, values: closePrices }).pop(),
        macd: MACD.calculate(macdInput).pop(),
        volume: volumes[volumes.length - 1],
        volumeSma: SMA.calculate({ period: STRATEGY_CONFIG.volumeSmaPeriod, values: volumes }).pop(),
    };
    
    console.log(`  [${symbol}] Indicadores: RSI=${indicators.rsi.toFixed(2)} | EMA=${indicators.ema.toFixed(2)} | MACD Hist=${indicators.macd?.histogram.toFixed(4)}`);
    
    // Atualiza o estado da posição e o preço de liquidação
    await updatePositionAndLiquidation(symbol);

    await runTradingStrategy(symbol, currentPrice, indicators);
}

/**
 * Atualiza o estado da posição e o preço de liquidação para um dado símbolo.
 */
async function updatePositionAndLiquidation(symbol) {
    const state = botState[symbol];
    const baseAsset = symbol.replace(STRATEGY_CONFIG.quoteAsset, '');
    try {
        const marginAccountInfo = await client.marginAccountInfo();
        const baseAssetInfo = marginAccountInfo.userAssets.find(a => a.asset === baseAsset);
        const quoteAssetInfo = marginAccountInfo.userAssets.find(a => a.asset === STRATEGY_CONFIG.quoteAsset);
        
        state.baseAssetAmount = parseFloat(baseAssetInfo?.netAsset || '0');
        state.hasPosition = state.baseAssetAmount > 0.0001; // Verifica se há uma posição significativa
        state.liquidationPrice = parseFloat(baseAssetInfo?.liquidationPrice || '0'); // Preço de liquidação do ativo

        // O lastBuyPrice precisa ser rastreado de forma mais robusta em margem,
        // mas para este scalping simples, continuaremos usando o preço da ordem de compra.
        // Se o bot for reiniciado com posições abertas, lastBuyPrice será 0.
        // Uma solução mais avançada leria as posições da Binance para inicializar lastBuyPrice.

        // Se o bot tem uma posição mas o lastBuyPrice não foi setado (ex: bot reiniciado com posições),
        // uma forma de estimar seria olhar para o histórico de ordens ou calcular um custo médio.
        // Por simplicidade, se lastBuyPrice for 0 e hasPosition for true, não calcularemos stop/take.
        if (state.hasPosition && state.lastBuyPrice === 0) {
            console.log(colors.yellow, `  [${symbol}] Posição detectada, mas lastBuyPrice não está disponível (bot pode ter sido reiniciado). Stop/Take não serão calculados.`, colors.reset);
        }

    } catch (error) {
        console.error(colors.red, `Erro ao atualizar posição/liquidação para ${symbol}:`, error.body || error.message, colors.reset);
        state.hasPosition = false; // Assume que não há posição para evitar erros de cálculo
    }
}


// =================================================================================================
// LÓGICA DE TRADING (AGORA RECEBE O SÍMBOLO COMO PARÂMETRO)
// =================================================================================================
async function runTradingStrategy(symbol, price, indicators) {
    const { rsiOversold, rsiOverbought, stopLossPercent, takeProfitPercent } = STRATEGY_CONFIG;
    const { rsi, ema, macd, volume, volumeSma } = indicators;
    const symbolState = botState[symbol];

    // Verifica a saúde da margem antes de qualquer decisão de trade
    const marginAccountInfo = await client.marginAccountInfo();
    const marginLevel = parseFloat(marginAccountInfo.marginLevel);
    if (marginLevel <= STRATEGY_CONFIG.targetMarginLevel) {
        console.log(colors.red, `  [${symbol}] 🚨 Nível de Margem Crítico (${marginLevel.toFixed(2)})! Não realizando novas ordens.`, colors.reset);
        return; // Impede novas ordens se o risco de liquidação for alto
    }

    if (symbolState.hasPosition) {
        if (symbolState.lastBuyPrice === 0) {
            console.log(colors.yellow, `  [${symbol}] Posição aberta, mas sem lastBuyPrice. Não é possível calcular Stop/Take.`, colors.reset);
            return;
        }

        const { lastBuyPrice } = symbolState;
        const stopLossPrice = lastBuyPrice * (1 - (stopLossPercent / 100));
        const takeProfitPrice = lastBuyPrice * (1 + (takeProfitPercent / 100));
        let sellReason = null;

        // Prioridade: Stop-Loss, Take-Profit, Sinais de Indicadores (RSI sobrecomprado)
        if (price <= stopLossPrice) sellReason = `STOP-LOSS (Margem)`;
        else if (price >= takeProfitPrice) sellReason = `TAKE-PROFIT (Margem)`;
        else if (rsi > rsiOverbought) sellReason = `SINAL RSI (Margem)`;
        // Considerar também o nível de liquidação como motivo para venda de emergência
        else if (price <= symbolState.liquidationPrice * 1.005 && symbolState.liquidationPrice > 0) { // 0.5% acima do preço de liquidação
            sellReason = `PRÓXIMO_LIQUIDACAO_EMERGENCIA`;
        }

        if (sellReason) {
            console.log(colors.red, `\n[${symbol}] 📉 SINAL DE VENDA! Motivo: ${sellReason}`);
            await executeSellOrder(symbol, price, sellReason, symbolState.baseAssetAmount);
        } else {
            console.log(`  [${symbol}] Posição aberta em margem. Alvo: ${takeProfitPrice.toFixed(4)} | Stop: ${stopLossPrice.toFixed(4)} | Liq: ${symbolState.liquidationPrice.toFixed(4)} | Saldo Base: ${symbolState.baseAssetAmount.toFixed(4)}`);
        }
    } else {
        const isRsiLow = rsi < rsiOversold;
        const isAboveEma = price > ema;
        const isMacdPositive = macd?.histogram > 0;
        const isVolumeHigh = volume > volumeSma;

        console.log(`  [${symbol}] Analisando Compra (Margem): RSI? ${isRsiLow} | EMA? ${isAboveEma} | MACD? ${isMacdPositive} | Vol? ${isVolumeHigh}`);
        if (isRsiLow && isAboveEma && isMacdPositive && isVolumeHigh) {
            console.log(colors.green, `\n[${symbol}] 📈 SINAL DE COMPRA CONFIRMADO!`);
            await executeBuyOrder(symbol);
        }
    }
}

// =================================================================================================
// FUNÇÕES DE EXECUÇÃO DE ORDEM (AGORA PARA MARGEM)
// =================================================================================================
async function executeBuyOrder(symbol) {
    const { capitalAllocationPercent, quoteAsset } = STRATEGY_CONFIG;
    const baseAsset = symbol.replace(quoteAsset, '');
    try {
        const marginAccountInfo = await client.marginAccountInfo();
        const usdtMarginBalance = parseFloat(marginAccountInfo.userAssets.find(b => b.asset === quoteAsset)?.free || '0');
        
        // Calcular o capital a ser alocado para este trade (5% do saldo disponível na carteira de margem)
        const capitalToAllocate = usdtMarginBalance * (capitalAllocationPercent / 100);
        
        // Obter informações do símbolo para precisão
        const exchangeInfo = await client.exchangeInfo({ symbol });
        const symbolFilter = exchangeInfo.symbols.find(s => s.symbol === symbol);
        const minNotionalFilter = symbolFilter.filters.find(f => f.filterType === 'MIN_NOTIONAL');
        const minNotional = parseFloat(minNotionalFilter?.minNotional || '10'); // Default para 10 se não encontrar

        if (capitalToAllocate < minNotional) {
            console.log(colors.yellow, `  [${symbol}] AVISO: Capital alocado (${capitalToAllocate.toFixed(2)} ${quoteAsset}) é menor que o mínimo nocional (${minNotional}) para o par.`, colors.reset);
            return;
        }

        console.log(`  [${symbol}] Executando ordem de compra a mercado de MARGEM de ${capitalToAllocate.toFixed(2)} ${quoteAsset} (5% do capital)...`);
        
        const order = await client.marginOrder({ 
            symbol, 
            side: 'BUY', 
            type: 'MARKET', 
            quoteOrderQty: capitalToAllocate.toFixed(2), // Usamos quoteOrderQty para especificar o valor em USDT
            sideEffectType: 'AUTO_BORROW_AND_REPAY' 
        });
        
        const symbolState = botState[symbol];
        symbolState.hasPosition = true;
        symbolState.lastBuyPrice = parseFloat(order.cummulativeQuoteQty) / parseFloat(order.executedQty); 
        symbolState.baseAssetAmount = parseFloat(order.executedQty); // Armazena a quantidade comprada
        logOrderExecution(order, 'BUY', symbolState.lastBuyPrice);

        // Após a compra, atualiza o preço de liquidação
        await updatePositionAndLiquidation(symbol);

    } catch (error) { 
        console.error(colors.red, `Erro ao executar ordem de compra em margem para ${symbol}:`, error.body || error.message, colors.reset);
        handleApiError(error); 
    }
}

async function executeSellOrder(symbol, price, reason, amountToSellFromState) {
    const baseAsset = symbol.replace(STRATEGY_CONFIG.quoteAsset, '');
    try {
        // Usamos a quantidade armazenada no estado ou buscamos se for 0
        let assetBalanceToSell = amountToSellFromState; 
        if (!assetBalanceToSell || assetBalanceToSell < 0.0001) { // Garante que a quantidade é válida
            const marginAccountInfo = await client.marginAccountInfo();
            assetBalanceToSell = parseFloat(marginAccountInfo.userAssets.find(b => b.asset === baseAsset)?.netAsset || '0');
        }

        const exchangeInfo = await client.exchangeInfo({ symbol });
        const symbolFilter = exchangeInfo.symbols.find(s => s.symbol === symbol);
        const minNotionalFilter = symbolFilter.filters.find(f => f.filterType === 'MIN_NOTIONAL');
        const minNotional = parseFloat(minNotionalFilter?.minNotional || '10');

        if (assetBalanceToSell * price < minNotional) {
            console.log(colors.yellow, `  [${symbol}] AVISO: Valor da ordem de venda (${(assetBalanceToSell * price).toFixed(2)}) é menor que o mínimo nocional (${minNotional}).`, colors.reset);
            return;
        }

        // Arredondar a quantidade para a precisão do ativo
        const assetPrecision = symbolFilter.filters.find(f => f.filterType === 'LOT_SIZE').stepSize.indexOf('1') -1;
        const roundedAssetBalanceToSell = parseFloat(assetBalanceToSell.toFixed(assetPrecision));

        if (roundedAssetBalanceToSell <= 0) {
            console.log(colors.yellow, `  [${symbol}] Nenhuma quantidade válida para vender (${roundedAssetBalanceToSell}). Pulando venda.`, colors.reset);
            return;
        }

        console.log(`  [${symbol}] Executando ordem de venda a mercado de MARGEM de ${roundedAssetBalanceToSell.toFixed(4)} ${baseAsset}... (Motivo: ${reason})`);
        
        const order = await client.marginOrder({ 
            symbol, 
            side: 'SELL', 
            type: 'MARKET', 
            quantity: roundedAssetBalanceToSell, // Vende a quantidade exata
            sideEffectType: 'AUTO_BORROW_AND_REPAY' 
        });
        
        const symbolState = botState[symbol];
        logOrderExecution(order, 'SELL', symbolState.lastBuyPrice, price, reason);
        symbolState.hasPosition = false;
        symbolState.lastBuyPrice = 0; 
        symbolState.liquidationPrice = 0;
        symbolState.baseAssetAmount = 0;

        // Após a venda, é bom verificar a saúde da margem novamente
        await checkMarginHealth();
    } catch (error) { 
        console.error(colors.red, `Erro ao executar ordem de venda em margem para ${symbol}:`, error.body || error.message, colors.reset);
        handleApiError(error); 
    }
}

// =================================================================================================
// FUNÇÕES AUXILIARES
// =================================================================================================
function logOrderExecution(order, side, buyPrice, sellPrice, reason) {
    const pnl = side === 'SELL' ? (sellPrice - buyPrice) * parseFloat(order.executedQty) : 0;
    const color = side === 'BUY' ? colors.green : (pnl > 0 ? colors.green : colors.red);
    const title = side === 'BUY' ? `ORDEM DE COMPRA EXECUTADA (MARGEM)!` : `ORDEM DE VENDA EXECUTADA (MARGEM)! (${reason})`;
    
    console.log(color, `  [${order.symbol}] ------------------------------------------`);
    console.log(`  [${order.symbol}] ✅ ${title}`);
    console.log(`  - Quantidade: ${parseFloat(order.executedQty).toFixed(4)}`);
    console.log(`  - Valor Total: ${parseFloat(order.cummulativeQuoteQty).toFixed(2)} USDT`);
    if (side === 'SELL') console.log(`  - Lucro/Prejuízo (P&L): ${pnl.toFixed(2)} USDT`);
    console.log(`  [${order.symbol}] ------------------------------------------`, colors.reset);
}
function showHeader(title) { console.clear(); console.log(colors.cyan, `================== ${title} ==================\n`, colors.reset); }
function handleApiError(error) { 
    console.error(colors.red, '\n❌ Ocorreu um erro:', `[${error.code || 'S/C'}] ${error.message}`, colors.reset); 
    if (error.code === -2011) { 
        console.log(colors.yellow, '  (Pode indicar um problema de saldo de margem ou limite de empréstimo/ordem).', colors.reset);
    } else if (error.code === -1021) { 
        console.log(colors.yellow, '  (Erro de sincronização de tempo. Verifique a hora do seu sistema).', colors.reset);
    } else if (error.code === -4028) { // Order would immediately trigger.
        console.log(colors.yellow, '  (Erro de precificação: A ordem de mercado pode ter falhado devido a grande variação no livro de ordens, ou preço de Stop/Take muito próximo).', colors.reset);
    } else if (error.code === -1013) { // Filter failure: MIN_NOTIONAL, LOT_SIZE
        console.log(colors.yellow, `  (Erro de filtro: Quantidade ou valor da ordem não atende aos requisitos mínimos/máximos do par. Checar STRATEGY_CONFIG e precisão. ${error.message})`, colors.reset);
    }
    // Adicionar mais tratamentos de erro específicos da API de margem
}
function gracefulShutdown() {
    console.log(colors.yellow, "\nRecebido sinal de encerramento...");
    for (const symbol in botState) {
        if (botState[symbol].websocket) {
            console.log(`[${symbol}] Fechando conexão WebSocket...`);
            botState[symbol].websocket();
        }
    }
    console.log("Bot encerrado de forma limpa.", colors.reset);
    process.exit(0);
}

// --- INÍCIO DO PROGRAMA ---
process.on('SIGINT', gracefulShutdown);
main().catch(error => { console.error(colors.red, '❌ Erro fatal:', error, colors.reset); process.exit(1); });

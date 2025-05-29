const express = require('express');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const { Connection, PublicKey, Transaction, Keypair, SystemProgram } = require('@solana/web3.js');
const { createTransferInstruction, getAssociatedTokenAddress } = require('@solana/spl-token');
const TOKEN_EXTENSIONS_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const bs58 = require('bs58');
const BN = require('bn.js');
require('dotenv').config();

const app = express();

// Constants
const TREASURY_ACCOUNT = process.env.TREASURY_WALLET || "8VPZGxMMcyFykMPAApeyhsNwVtrgXZYpu28Rm2iLknbq";
const CARDS_TOKEN_MINT = process.env.TOKEN_MINT || "5Xbscj1D5R3RrSpeQyYe4zCkdGqZTrjxVuNszrhDacjv";
const ENTRY_FEE = 3; // 3 CARDS tokens

// Solana connection
const SOLANA_NETWORK = process.env.SOLANA_NETWORK || 'devnet';
const SOLANA_ENDPOINT = SOLANA_NETWORK === 'mainnet-beta' 
  ? 'https://api.mainnet-beta.solana.com' 
  : SOLANA_NETWORK === 'testnet' 
    ? 'https://api.testnet.solana.com' 
    : 'https://api.devnet.solana.com';
const connection = new Connection(SOLANA_ENDPOINT, 'confirmed');

// Initialize treasury wallet from seed
let treasuryKeypair;

try {
  // Try to parse the treasury seed from environment variable
  const TREASURY_SEED = process.env.TREASURY_SEED;
  
  if (TREASURY_SEED) {
    // Check if it's a JSON array
    if (TREASURY_SEED.startsWith('[') && TREASURY_SEED.endsWith(']')) {
      try {
        // Parse the array of numbers
        const seedArray = JSON.parse(TREASURY_SEED);
        const uint8Array = new Uint8Array(seedArray);
        treasuryKeypair = Keypair.fromSecretKey(uint8Array);
        console.log('Treasury wallet loaded from seed array:', treasuryKeypair.publicKey.toString());
      } catch (e) {
        console.error('Error parsing seed array:', e);
        throw new Error('Invalid seed array format');
      }
    } else {
      // Try to parse as base58 encoded private key
      try {
        const secretKey = bs58.decode(TREASURY_SEED);
        treasuryKeypair = Keypair.fromSecretKey(secretKey);
        console.log('Treasury wallet loaded from base58 private key:', treasuryKeypair.publicKey.toString());
      } catch (e) {
        console.error('Error decoding base58 seed:', e);
        throw new Error('Invalid base58 private key format');
      }
    }
    
    // Verify that the keypair matches the expected public key
    if (treasuryKeypair.publicKey.toString() !== TREASURY_ACCOUNT) {
      console.warn(`Warning: Generated keypair public key (${treasuryKeypair.publicKey.toString()}) doesn't match the expected treasury address (${TREASURY_ACCOUNT})`);
    }
  } else {
    console.error('TREASURY_SEED environment variable not set');
    // For demo purposes, generate a keypair
    treasuryKeypair = Keypair.generate();
    console.warn('Using generated keypair for demo (no funds):', treasuryKeypair.publicKey.toString());
  }
} catch (error) {
  console.error('Error initializing treasury wallet:', error);
  process.exit(1);
}

// Track paid rewards to prevent double payments
const paidRewards = new Map();

// Track completed games to prevent replays
const completedGames = new Map();

// Lucky Triple Game State - używamy playerId jako klucza (wzorowane na wargame_server.js)
const playerGameSessions = new Map(); // Zmieniona nazwa dla jasności

// Configure rate limiters
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // zwiększony limit do 1000 zapytań
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many requests from this IP, please try again after 15 minutes"
});

// More strict limiter for game actions
const gameActionLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 200, // zwiększony limit do 200 zapytań
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many game actions from this IP, please try again after 5 minutes"
});

// Even stricter limiter for create/reset operations
const createGameLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // zmniejszony czas do 1 minuty
    max: 30, // zwiększony limit do 30 gier
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many game creation requests, please try again later"
});

// Middleware - prosta konfiguracja CORS, identyczna jak w blackjack_server.js
app.use(cors());
app.use(express.json());
app.use(apiLimiter); // Apply general rate limiting to all routes by default

// Basic route
app.get('/', (req, res) => {
    res.json({ message: 'The Lucky Triple Server is running!' });
});

// Game routes with specific limiters
app.post('/lucky-triple/start', createGameLimiter, (req, res) => {
    // Dodaj sprawdzenie czy opłata została wniesiona
    const { playerId, entryFeePaid } = req.body;
    
    if (!playerId) {
        return res.status(400).json({ error: 'Player ID is required' });
    }
    
    // Validate player has a valid Solana address format
    try {
        new PublicKey(playerId);
    } catch (error) {
        console.error(`Invalid Solana address format: ${playerId}`);
        return res.status(400).json({ error: 'Invalid player account. Must be a valid Solana address.' });
    }
    
    // Check if entry fee is paid
    if (!entryFeePaid) {
        console.error(`Entry fee not paid for player: ${playerId}`);
        return res.status(400).json({ error: 'Entry fee of 3 CARDS must be paid before creating a game' });
    }
    
    // Wzorowane na wargame_server.js - zastąp istniejącą grę zamiast blokować
    if (playerGameSessions.has(playerId)) {
        console.log(`💰 Replacing existing game for player ${playerId}`);
        playerGameSessions.delete(playerId);
    }
    
    // Generate unique game ID using timestamp and random number to ensure uniqueness
    const gameId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const deck = createAndShuffleLuckyTripleDeck();
    
    const startTime = Date.now();
    const gameState = {
        gameId,
        playerId,
        deck,
        cards: [],
        heldCards: [],
        timestamp: startTime,
        lastActionTime: startTime,
        currentCombination: 'None',
        currentReward: 0,
        roundsPlayed: 0,
        maxRounds: GAME_CONFIG.MAX_ROUNDS,
        isEnded: false,
        timedOut: false,
        rewardPaid: false
    };
    
    // Atomowe dodanie gry (używamy playerId jako klucza)
    playerGameSessions.set(playerId, gameState);
    
    // Log new game creation
    console.log(`[${new Date().toISOString()}] New game created: ${gameId} for player: ${playerId}`);
    
    res.json({
        gameId,
        playerId,
        cards: [],
        combination: 'None',
        reward: 0,
        roundsLeft: GAME_CONFIG.MAX_ROUNDS,
        isEnded: false,
        timeRemaining: GAME_CONFIG.GAME_TIMEOUT_MS / 1000, // Send initial time in seconds
        maxRounds: GAME_CONFIG.MAX_ROUNDS,
        serverTime: startTime,
        message: "Press 'draw' to start the game and receive your first cards"
    });
});

// Add new endpoint for handling card holds
app.post('/lucky-triple/hold', gameActionLimiter, (req, res) => {
    const { gameId, cardIndexes } = req.body;
    
    // Znajdź grę na podstawie gameId (w gameState)
    let gameState = null;
    let playerId = null;
    
    for (const [pid, state] of playerGameSessions.entries()) {
        if (state.gameId === gameId) {
            gameState = state;
            playerId = pid;
            break;
        }
    }
    
    if (!gameState) {
        return res.status(404).json({ error: 'Game not found' });
    }
    
    // Check if not exceeding 2 cards limit
    if (cardIndexes.length > 2) {
        return res.status(400).json({ error: 'Cannot hold more than 2 cards' });
    }
    
    // Check if appropriate round (only first and second)
    if (gameState.roundsPlayed === 0 || gameState.roundsPlayed >= 3) {
        return res.status(400).json({ error: 'Can only hold cards after first and second round' });
    }
    
    gameState.heldCards = cardIndexes;
    gameState.lastActionTime = Date.now(); // Aktualizuj czas aktywności
    playerGameSessions.set(playerId, gameState);
    
    res.json({
        success: true,
        heldCards: cardIndexes
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ message: 'Something went wrong!' });
});

// Start server
const PORT = process.env.PORT || 3004;
console.log(`Starting The Lucky Triple Server`);
console.log(`Solana network: ${SOLANA_NETWORK}`);

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Utility function to create and shuffle deck
function createAndShuffleLuckyTripleDeck() {
    const suits = ['hearts', 'diamonds', 'clubs', 'spades'];
    const deck = [];
    
    // Create deck with cards from Ace (1) to 6 in each suit
    for (let suit of suits) {
        for (let value = 1; value <= 6; value++) {
            const rank = value === 1 ? 'A' : value.toString();
            deck.push({ suit, rank, hidden: false });
        }
    }
    
    // Fisher-Yates shuffle
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    
    return deck;
}

// Rank order for straights
const RANK_ORDER = {
    'A': 1,
    '2': 2,
    '3': 3,
    '4': 4,
    '5': 5,
    '6': 6
};

// Reward values for each hand combination
const REWARDS = {
    'Lucky Triple': 15,
    'Triple': 9,
    'Straight Flush': 12,
    'Straight': 6,
    'Flush': 5,
    'None': 0
};

// Function to evaluate hand combination
function evaluateHandCombination(cards) {
    if (cards.length !== 3) return { combination: 'None', reward: 0 };

    // Check if all cards have the same suit
    const sameSuit = cards.every(card => card.suit === cards[0].suit);
    
    // Check if all cards have the same rank
    const sameRank = cards.every(card => card.rank === cards[0].rank);
    
    // Check for Lucky Triple (same rank, same suit)
    if (sameRank && sameSuit) {
        return { 
            combination: 'Lucky Triple', 
            reward: REWARDS['Lucky Triple']
        };
    }
    
    // Check for Triple (same rank, different suits)
    if (sameRank) {
        return { 
            combination: 'Triple',
            reward: REWARDS['Triple']
        };
    }
    
    // Sort cards by rank for straight check
    const sortedCards = [...cards].sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank]);
    
    // Check for straight
    const isStraight = sortedCards.every((card, index) => {
        if (index === 0) return true;
        return RANK_ORDER[card.rank] - RANK_ORDER[sortedCards[index - 1].rank] === 1;
    });
    
    // Check for Straight Flush (straight with same suit)
    if (isStraight && sameSuit) {
        return { 
            combination: 'Straight Flush',
            reward: REWARDS['Straight Flush']
        };
    }
    
    // Check for Straight
    if (isStraight) {
        return { 
            combination: 'Straight',
            reward: REWARDS['Straight']
        };
    }
    
    // Check for Flush (same suit)
    if (sameSuit) {
        return { 
            combination: 'Flush',
            reward: REWARDS['Flush']
        };
    }
    
    // Default: None
    return { 
        combination: 'None',
        reward: REWARDS['None']
    };
}

// Game configuration
const GAME_CONFIG = {
    MAX_ROUNDS: 3,
    GAME_TIMEOUT_MS: 60 * 1000, // 60 seconds timer for each game
    CLEANUP_INTERVAL_MS: 20 * 1000, // Check for inactive games every 20 seconds
    TIME_CHECK_INTERVAL_MS: 1000 // Client should check time every second
};

// Add rate limiter specifically for time checks
const timeCheckLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 120, // Allow checking twice per second on average
    standardHeaders: true,
    legacyHeaders: false,
    message: "Too many time check requests, please slow down"
});

// Apply the time check limiter to the time endpoint
app.get('/lucky-triple/time/:gameId', timeCheckLimiter, (req, res) => {
    const { gameId } = req.params;
    
    // Find game based on gameId
    let gameState = null;
    let playerId = null;
    
    for (const [pid, state] of playerGameSessions.entries()) {
        if (state.gameId === gameId) {
            gameState = state;
            playerId = pid;
            break;
        }
    }
    
    if (!gameState) {
        return res.status(404).json({ error: 'Game not found' });
    }
    
    // Calculate remaining time
    const now = Date.now();
    const elapsed = now - gameState.timestamp;
    const timeRemaining = Math.max(0, GAME_CONFIG.GAME_TIMEOUT_MS - elapsed);
    
    // If time's up and game is not marked as ended
    if (timeRemaining <= 0 && !gameState.isEnded) {
        gameState.isEnded = true;
        gameState.timedOut = true;
        
        // Add to completed games
        completedGames.set(gameState.gameId, {
            playerId: playerId,
            result: 'timeout',
            timestamp: now,
            processed: true
        });
        
        // Schedule removal from active sessions
        setTimeout(() => {
            playerGameSessions.delete(playerId);
        }, 5000);
        
        return res.json({
            timeRemaining: 0,
            isTimedOut: true,
            isEnded: true,
            serverTime: now
        });
    }
    
    return res.json({
        timeRemaining: Math.ceil(timeRemaining / 1000), // in seconds
        isTimedOut: false,
        isEnded: gameState.isEnded,
        serverTime: now
    });
});

// Modify verifyTimeRemaining function to be more strict
function verifyTimeRemaining(gameState, playerId = null) {
    if (!gameState) return null;
    
    const now = Date.now();
    const elapsed = now - gameState.timestamp;
    const timeRemaining = Math.max(0, GAME_CONFIG.GAME_TIMEOUT_MS - elapsed);
    
    // If time's up and game is not marked as ended
    if (timeRemaining <= 0 && !gameState.isEnded) {
        gameState.isEnded = true;
        gameState.timedOut = true;
        
        // Add to completed games
        if (playerId) {
            completedGames.set(gameState.gameId, {
                playerId: playerId,
                result: 'timeout',
                timestamp: now,
                processed: true
            });
        }
        
        return {
            timeRemaining: 0,
            isTimedOut: true,
            isEnded: true,
            serverTime: now
        };
    }
    
    return {
        timeRemaining: Math.ceil(timeRemaining / 1000), // in seconds
        isTimedOut: false,
        isEnded: gameState.isEnded,
        serverTime: now
    };
}

// Funkcja do przetwarzania nagrody
async function processReward(gameState) {
    // Check if reward was already processed
    if (gameState.rewardPaid) {
        console.log(`Reward already paid for game ${gameState.gameId}`);
        return;
    }
    
    // Check if player won
    if (gameState.currentReward <= 0) {
        console.log(`No reward for game ${gameState.gameId}, player didn't win`);
        return;
    }
    
    try {
        // Send CARDS reward
        await sendCardsReward(gameState.playerId, gameState.gameId, gameState.currentReward);
        
        // Mark as paid
        gameState.rewardPaid = true;
        
        console.log(`Reward of ${gameState.currentReward} CARDS sent for game ${gameState.gameId} to player ${gameState.playerId}`);
    } catch (error) {
        console.error(`Failed to process reward for game ${gameState.gameId}:`, error);
    }
}

// Check for timed out games and clean them up
function cleanupInactiveGameSessions() {
    const oneHourAgo = Date.now() - 60 * 60 * 1000; // 1 godzina dla Lucky Triple
    const initialSize = playerGameSessions.size;
    let removedCount = 0;
    
    for (const [playerId, gameState] of playerGameSessions.entries()) {
        // Sprawdź ostatni czas aktywności gry
        const lastActionTime = gameState.lastActionTime || gameState.timestamp || 0;
        
        // Jeśli nie było aktywności przez 1 godzinę, usuń sesję
        if (lastActionTime < oneHourAgo) {
            playerGameSessions.delete(playerId);
            removedCount++;
            console.log(`🧹 Removed inactive game session for player: ${playerId}`);
        }
    }
    
    if (removedCount > 0) {
        console.log(`🧹 Cleanup: Removed ${removedCount} inactive game sessions. Remaining: ${playerGameSessions.size}`);
    }
}

// Czyść nieaktywne sesje gier co 30 minut
setInterval(cleanupInactiveGameSessions, 30 * 60 * 1000);

// Function to clean up old completed games to prevent memory leaks
function cleanupOldCompletedGames() {
    const twentyFourHoursAgo = Date.now() - 24 * 60 * 60 * 1000;
    const initialSize = completedGames.size;
    
    for (const [gameId, gameData] of completedGames.entries()) {
        // Remove entries older than 24 hours
        if (gameData.timestamp < twentyFourHoursAgo) {
            completedGames.delete(gameId);
        }
    }
    
    const removedCount = initialSize - completedGames.size;
    console.log(`Memory cleanup: Removed ${removedCount} old completed games. Remaining: ${completedGames.size}`);
}

// Clean up old completed games once per day
setInterval(cleanupOldCompletedGames, 24 * 60 * 60 * 1000);

// Add debugging endpoint (only in non-production)
if (process.env.NODE_ENV !== 'production') {
    app.get('/lucky-triple/debug/server-state', (req, res) => {
        const activePlayersList = Array.from(playerGameSessions.keys());
        const completedGamesList = Array.from(completedGames.entries()).map(([gameId, data]) => ({
            gameId,
            ...data
        }));
        const paidRewardsList = Array.from(paidRewards.entries()).map(([key, status]) => ({
            key,
            status
        }));
        
        res.json({
            activePlayers: activePlayersList,
            activePlayerCount: activePlayersList.length,
            completedGames: completedGamesList,
            completedGameCount: completedGamesList.length,
            paidRewards: paidRewardsList,
            paidRewardsCount: paidRewardsList.length,
            totalGames: playerGameSessions.size
        });
    });
} else {
    // In production, return 404 for this endpoint
    app.get('/lucky-triple/debug/server-state', (req, res) => {
        res.status(404).json({ error: 'Endpoint not found' });
    });
}

app.post('/lucky-triple/draw', gameActionLimiter, (req, res) => {
    const { gameId } = req.body;
    
    // Znajdź grę na podstawie gameId (w gameState)
    let gameState = null;
    let playerId = null;
    
    for (const [pid, state] of playerGameSessions.entries()) {
        if (state.gameId === gameId) {
            gameState = state;
            playerId = pid;
            break;
        }
    }
    
    if (!gameState) {
        return res.status(404).json({ error: 'Game not found' });
    }
    
    // Check if game is already ended
    if (gameState.isEnded) {
        return res.status(400).json({ error: 'Game has already ended' });
    }
    
    // Weryfikacja czasu - użyj nowej funkcji
    const timeCheck = verifyTimeRemaining(gameState, playerId);
    if (!timeCheck) {
        return res.status(404).json({ error: 'Game not found' });
    }
    
    if (timeCheck.isTimedOut) {
        // Remove from session
        playerGameSessions.delete(playerId);
        
        return res.status(400).json({
            error: 'Game has timed out',
            timeRemaining: 0,
            isTimedOut: true,
            isEnded: true,
            serverTime: timeCheck.serverTime
        });
    }
    
    // Check if max rounds reached
    if (gameState.roundsPlayed >= gameState.maxRounds) {
        // Mark game as ended
        gameState.isEnded = true;
        gameState.lastActionTime = Date.now();
        playerGameSessions.set(playerId, gameState);
        return res.status(400).json({ error: 'Maximum rounds reached for this game' });
    }
    
    // If not enough cards left, recreate deck
    if (gameState.deck.length < 3) {
        gameState.deck = createAndShuffleLuckyTripleDeck();
    }
    
    // Store current held cards before resetting them
    const currentHeldCards = [...(gameState.heldCards || [])];
    const previousCards = [...(gameState.cards || [])];
    
    // Draw new cards, keeping held cards for current draw
    let newCards = new Array(3);
    
    if (gameState.roundsPlayed === 0) {
        // First round - draw all new cards
        for (let i = 0; i < 3; i++) {
            newCards[i] = gameState.deck.pop();
        }
    } else {
        // Subsequent rounds - preserve held cards
        for (let i = 0; i < 3; i++) {
            if (currentHeldCards.includes(i)) {
                // Keep the held card from previous round
                newCards[i] = previousCards[i];
            } else {
                // Draw new card for non-held position
                newCards[i] = gameState.deck.pop();
            }
        }
    }
    
    // Evaluate the hand
    const handResult = evaluateHandCombination(newCards);
    
    // Update game state
    gameState.cards = newCards;
    gameState.currentCombination = handResult.combination;
    gameState.currentReward = handResult.reward;
    gameState.roundsPlayed += 1;
    gameState.lastActionTime = Date.now(); // Aktualizuj czas aktywności
    
    // Reset held cards for next round
    gameState.heldCards = [];
    
    // Check if this is the last round
    if (gameState.roundsPlayed >= gameState.maxRounds) {
        gameState.isEnded = true;
        
        // Jeśli jest to ostatnia runda i gracz wygrał, przetwórz nagrodę
        if (gameState.currentReward > 0) {
            // Dodaj grę do zakończonych
            completedGames.set(gameState.gameId, {
                playerId: playerId,
                result: 'win',
                timestamp: Date.now(),
                processed: false
            });
            
            // Process reward asynchronously
            processReward(gameState).catch(error => {
                console.error(`Failed to process reward for game ${gameState.gameId}:`, error);
            });
        } else {
            // Dodaj grę do zakończonych (przegrana)
            completedGames.set(gameState.gameId, {
                playerId: playerId,
                result: 'loss',
                timestamp: Date.now(),
                processed: true // Nie ma nagrody, więc oznaczamy jako przetworzone
            });
            
            // Usuń gracza z aktywnych po opóźnieniu
            setTimeout(() => {
                playerGameSessions.delete(playerId);
            }, 5000);
        }
    }
    
    playerGameSessions.set(playerId, gameState);
    
    // Enhanced logging
    console.log(`[${new Date().toISOString()}] Game ${gameState.gameId} - Round ${gameState.roundsPlayed}/3:`);
    if (gameState.roundsPlayed > 1) {
        // W rundach 2 i 3 najpierw pokazujemy zatrzymane karty
        console.log(`Held cards from previous round: ${currentHeldCards.length > 0 ? currentHeldCards.map(i => formatCardForLog(previousCards[i])).join(' ') : 'none'}`);
        console.log(`Cards on table: ${formatCardsForLog(newCards)}`);
    } else {
        // W pierwszej rundzie pokazujemy tylko karty na stole
        console.log(`Cards on table: ${formatCardsForLog(newCards)}`);
    }
    console.log(`Combination: ${handResult.combination} (${handResult.reward} CARDS)`);
    
    // Calculate remaining time
    let remainingTime;
    if (gameState.isEnded) {
        remainingTime = 0;
    } else {
        const timeStatus = verifyTimeRemaining(gameState, playerId);
        remainingTime = timeStatus.timeRemaining;
    }
    
    res.json({
        cards: newCards,
        combination: handResult.combination,
        reward: handResult.reward,
        roundsLeft: gameState.maxRounds - gameState.roundsPlayed,
        remainingCards: gameState.deck.length,
        isEnded: gameState.isEnded,
        timeRemaining: remainingTime,
        serverTime: timeCheck.serverTime,
        heldCards: [],
        previouslyHeld: currentHeldCards,
        playerId: playerId,
        rewardPaid: gameState.rewardPaid
    });
});

app.post('/lucky-triple/check', gameActionLimiter, async (req, res) => {
    const { gameId } = req.body;
    
    // Znajdź grę na podstawie gameId (w gameState)
    let gameState = null;
    let playerId = null;
    
    for (const [pid, state] of playerGameSessions.entries()) {
        if (state.gameId === gameId) {
            gameState = state;
            playerId = pid;
            break;
        }
    }
    
    if (!gameState) {
        return res.status(404).json({ error: 'Game not found' });
    }
    
    // Weryfikacja czasu - użyj nowej funkcji
    const timeCheck = verifyTimeRemaining(gameState, playerId);
    if (!timeCheck) {
        return res.status(404).json({ error: 'Game not found' });
    }
    
    if (timeCheck.isTimedOut) {
        // Remove from session
        playerGameSessions.delete(playerId);
        
        return res.status(400).json({
            error: 'Game has timed out',
            timeRemaining: 0,
            isTimedOut: true,
            isEnded: true,
            serverTime: timeCheck.serverTime
        });
    }
    
    // Mark game as ended
    gameState.isEnded = true;
    gameState.lastActionTime = Date.now();
    
    // Dodajemy grę do zakończonych
    completedGames.set(gameState.gameId, {
        playerId: playerId,
        result: gameState.currentReward > 0 ? 'win' : 'loss',
        timestamp: Date.now(),
        processed: false
    });
    
    // Usuń gracza z aktywnych po opóźnieniu, aby zapobiec wyścigom
    setTimeout(() => {
        playerGameSessions.delete(playerId);
    }, 5000);
    
    // Generate a message based on the combination and reward
    let message;
    if (gameState.currentReward > 0) {
        message = `Congratulations! You won ${gameState.currentReward} CARDS with a ${gameState.currentCombination} hand!`;
        
        // Process reward asynchronicznie
        processReward(gameState).catch(error => {
            console.error(`Failed to process reward for game ${gameState.gameId}:`, error);
        });
    } else {
        message = `Game over. Your final hand was ${gameState.currentCombination}.`;
    }
    
    // Log game completion with detailed information
    console.log(`[${new Date().toISOString()}] Game ${gameState.gameId} completed after ${gameState.roundsPlayed} rounds`);
    console.log(`Final cards on table: ${formatCardsForLog(gameState.cards)}`);
    console.log(`Final combination: ${gameState.currentCombination}`);
    console.log(`Reward: ${gameState.currentReward} CARDS`);
    
    // Update game state before response
    playerGameSessions.set(playerId, gameState);
    
    // Return final result
    res.json({
        gameId: gameState.gameId,
        playerId: playerId,
        combination: gameState.currentCombination,
        reward: gameState.currentReward, // Wyślij nagrodę w CARDS
        gameCompleted: true,
        isEnded: true,
        isWin: gameState.currentReward > 0,
        timeRemaining: 0,
        message: message,
        rewardPaid: gameState.rewardPaid
    });
    
    // Clear the game from memory after it's completed
    setTimeout(() => {
        playerGameSessions.delete(playerId);
    }, 10000); // Opóźnione usuwanie, aby umożliwić sprawdzenie stanu gry
});

// Add status endpoint
app.get('/lucky-triple/status/:gameId', (req, res) => {
    const { gameId } = req.params;
    
    // Znajdź grę na podstawie gameId (w gameState)
    let gameState = null;
    let playerId = null;
    
    for (const [pid, state] of playerGameSessions.entries()) {
        if (state.gameId === gameId) {
            gameState = state;
            playerId = pid;
            break;
        }
    }
    
    if (!gameState) {
        return res.status(404).json({ error: 'Game not found' });
    }
    
    // Check time remaining using new function
    const timeCheck = verifyTimeRemaining(gameState, playerId);
    if (!timeCheck) {
        return res.status(404).json({ error: 'Game not found' });
    }
    
    if (timeCheck.isTimedOut) {
        // Remove game from memory if timed out
        playerGameSessions.delete(playerId);
        return res.status(400).json({
            error: 'Game has timed out',
            timeRemaining: 0,
            isTimedOut: true,
            isEnded: true,
            serverTime: timeCheck.serverTime
        });
    }
    
    return res.json({
        gameId: gameState.gameId,
        playerId: playerId,
        isEnded: gameState.isEnded || timeCheck.isEnded,
        timedOut: gameState.timedOut || timeCheck.isTimedOut,
        timeRemaining: timeCheck.timeRemaining,
        serverTime: timeCheck.serverTime,
        roundsLeft: gameState.maxRounds - gameState.roundsPlayed,
        currentCombination: gameState.currentCombination,
        currentReward: gameState.currentReward,
        rewardPaid: gameState.rewardPaid
    });
});

// Helper function to format card for logging
function formatCardForLog(card) {
    const suitSymbols = {
        'hearts': '♥',
        'diamonds': '♦',
        'clubs': '♣',
        'spades': '♠'
    };
    return `${card.rank}${suitSymbols[card.suit]}`;
}

// Helper function to format cards array for logging
function formatCardsForLog(cards) {
    return cards.map(formatCardForLog).join(' ');
}

// Helper function to send CARDS token reward
async function sendCardsReward(receiverAddress, gameId, rewardAmount) {
  // Validate receiver address is a valid Solana public key
  let receiverPublicKey;
  try {
    receiverPublicKey = new PublicKey(receiverAddress);
  } catch (error) {
    console.error(`Invalid Solana address: ${receiverAddress}`);
    throw new Error('Invalid Solana address format');
  }
  
  // Create a unique transaction ID combining player ID and game session
  const transactionKey = `${receiverAddress}-${gameId}`;
  
  try {
    // Check if this reward was already paid
    if (paidRewards.has(transactionKey)) {
      console.log(`Reward already paid for transaction ${transactionKey}, skipping duplicate payment`);
      return null;
    }
    
    // Mark as pending before sending to prevent race conditions
    paidRewards.set(transactionKey, 'pending');
    
    // Get token accounts
    const treasuryTokenAccount = await getAssociatedTokenAddress(
      new PublicKey(CARDS_TOKEN_MINT),
      treasuryKeypair.publicKey,
      false,
      TOKEN_EXTENSIONS_PROGRAM_ID
    );
    
    const receiverTokenAccount = await getAssociatedTokenAddress(
      new PublicKey(CARDS_TOKEN_MINT),
      receiverPublicKey,
      false,
      TOKEN_EXTENSIONS_PROGRAM_ID
    );
    
    // Check if receiver token account exists
    const receiverTokenAccountInfo = await connection.getAccountInfo(receiverTokenAccount);
    if (!receiverTokenAccountInfo) {
      console.error('Receiver does not have a token account for CARDS');
      throw new Error('Receiver needs to create a CARDS token account first');
    }
    
    // Create transaction to send tokens
    const transaction = new Transaction();
    
    // Calculate token amount with decimals (assuming 9 decimals for CARDS token)
    const tokenAmount = rewardAmount * Math.pow(10, 9); // 9 decimals
    
    // Add token transfer instruction
    transaction.add(
      createTransferInstruction(
        treasuryTokenAccount,      // source
        receiverTokenAccount,      // destination
        treasuryKeypair.publicKey, // owner
        tokenAmount,               // amount with decimals
        [],                        // multisigners
        TOKEN_EXTENSIONS_PROGRAM_ID // programId
      )
    );
    
    // Set recent blockhash and fee payer
    transaction.recentBlockhash = (await connection.getRecentBlockhash()).blockhash;
    transaction.feePayer = treasuryKeypair.publicKey;
    
    // Sign and send transaction
    transaction.sign(treasuryKeypair);
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true,
      maxRetries: 5
    });
    
    // For devnet, we don't need to wait for confirmation - transactions are generally confirmed if accepted
    // Mark as completed after successful transaction submission
    paidRewards.set(transactionKey, 'completed');
    
    console.log(`Successfully sent ${rewardAmount} CARDS to ${receiverAddress} for game ${gameId}, signature: ${signature}`);
    return signature;
  } catch (error) {
    // On error, mark transaction as failed but still tracked to prevent retries
    paidRewards.set(transactionKey, 'failed');
    console.error('Failed to send CARDS:', error);
    throw error;
  }
}

// Funkcja do czyszczenia starych informacji o wypłatach
function cleanupOldPaidRewards() {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const initialSize = paidRewards.size;
  let removedCount = 0;
  
  for (const [key, status] of paidRewards.entries()) {
    // Try to extract timestamp from the key format: "accountId-timestamp-randomString"
    const parts = key.split('-');
    if (parts.length >= 2) {
      const timestampPart = parts[1];
      const timestamp = parseInt(timestampPart, 10);
      
      // If timestamp is valid and older than 7 days, delete the entry
      if (!isNaN(timestamp) && timestamp < sevenDaysAgo) {
        paidRewards.delete(key);
        removedCount++;
      }
    }
  }
  
  console.log(`Memory cleanup: Removed ${removedCount} old paid rewards records. Remaining: ${paidRewards.size}`);
}

// Clean up old paid rewards once per week
setInterval(cleanupOldPaidRewards, 7 * 24 * 60 * 60 * 1000);

// Add a Reset Game endpoint
app.post('/lucky-triple/reset', createGameLimiter, (req, res) => {
    const { playerId, entryFeePaid } = req.body;
    
    if (!playerId) {
        return res.status(400).json({ error: 'Player ID is required' });
    }
    
    // Validate player has a valid Solana address format
    try {
        new PublicKey(playerId);
    } catch (error) {
        console.error(`Invalid Solana address format: ${playerId}`);
        return res.status(400).json({ error: 'Invalid player account. Must be a valid Solana address.' });
    }
    
    // Check if entry fee is paid
    if (!entryFeePaid) {
        console.error(`Entry fee not paid for player: ${playerId}`);
        return res.status(400).json({ error: 'Entry fee of 3 CARDS must be paid before resetting a game' });
    }
    
    // Wzorowane na wargame_server.js - po prostu usuń istniejącą grę (jeśli istnieje)
    if (playerGameSessions.has(playerId)) {
        console.log(`🔄 Removing existing game for player ${playerId} due to reset request`);
        playerGameSessions.delete(playerId);
    }
    
    // Utwórz nową grę
    const gameId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const deck = createAndShuffleLuckyTripleDeck();
    
    const gameState = {
        gameId,
        playerId,
        deck,
        cards: [],
        heldCards: [],
        timestamp: Date.now(),
        lastActionTime: Date.now(),
        currentCombination: 'None',
        currentReward: 0,
        roundsPlayed: 0,
        maxRounds: GAME_CONFIG.MAX_ROUNDS,
        isEnded: false,
        timedOut: false,
        rewardPaid: false
    };
    
    // Atomowe dodanie nowej gry
    playerGameSessions.set(playerId, gameState);
    
    // Log game reset
    console.log(`[${new Date().toISOString()}] Game reset for player: ${playerId}, new game ID: ${gameId}`);
    
    res.json({
        gameId,
        playerId,
        cards: [],
        combination: 'None',
        reward: 0,
        roundsLeft: GAME_CONFIG.MAX_ROUNDS,
        isEnded: false,
        timeRemaining: Math.ceil(GAME_CONFIG.GAME_TIMEOUT_MS / 1000),
        maxRounds: GAME_CONFIG.MAX_ROUNDS,
        message: "Game reset. Press 'draw' to start the game and receive your first cards"
    });
});

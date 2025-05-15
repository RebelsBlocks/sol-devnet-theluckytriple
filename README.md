# The Lucky Triple

A Solana blockchain-based card game server for The Lucky Triple game.

## Overview

The Lucky Triple is a card game where players aim to create the best possible combination from three cards drawn from a deck. The game is built on the Solana blockchain, with rewards paid in CARDS tokens.

## Game Rules

1. Players pay an entry fee of 3 CARDS tokens to start a game
2. Each game consists of 3 rounds maximum
3. In each round, players receive cards and can hold up to 2 cards for the next round
4. The goal is to create the best possible card combination
5. If a winning combination is achieved, players receive CARDS tokens as rewards

### Card Combinations (from highest to lowest reward)

- **Lucky Triple** (15 CARDS): Three cards of the same rank and suit
- **Straight Flush** (12 CARDS): Three consecutive cards of the same suit
- **Triple** (9 CARDS): Three cards of the same rank
- **Straight** (6 CARDS): Three consecutive cards
- **Flush** (5 CARDS): Three cards of the same suit
- **None** (0 CARDS): No winning combination

## Server Features

- Secure Solana wallet integration for handling token transactions
- Rate limiting to prevent abuse
- Game timeout system to prevent abandoned games
- Memory management to prevent server overload
- Detailed logging for game events
- Reward payout system for winners

## Environment Variables

- `TREASURY_WALLET`: Public key of the treasury wallet
- `TREASURY_SEED`: Private key or seed array for the treasury wallet
- `TOKEN_MINT`: Address of the CARDS token mint
- `SOLANA_NETWORK`: Network to connect to (devnet, testnet, mainnet-beta)
- `PORT`: Port number for the server (default: 3004)
- `NODE_ENV`: Environment (development, production)

## API Endpoints

### Game Management

- `POST /lucky-triple/start`: Start a new game
- `POST /lucky-triple/draw`: Draw cards
- `POST /lucky-triple/hold`: Hold cards for the next round
- `POST /lucky-triple/check`: End the game and check the final result
- `GET /lucky-triple/status/:gameId`: Check the status of a game
- `POST /lucky-triple/reset`: Reset a player's game

### Status

- `GET /`: Check if server is running

## Setup and Installation

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
3. Create a `.env` file with the required environment variables
4. Start the server:
   ```
   npm start
   ```



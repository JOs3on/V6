const { Connection, PublicKey, Keypair, ComputeBudgetProgram } = require("@solana/web3.js");
const { MongoClient } = require("mongodb");
const bs58 = require("bs58");
require("dotenv").config();

const connection = new Connection(process.env.SOLANA_WS_URL, "confirmed");
const RAYDIUM_AMM_PROGRAM_ID = new PublicKey(process.env.RAYDIUM_AMM_PROGRAM_ID);
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const TOKEN_PROGRAM_ID_STR = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM_ID_STR = "ATokenGPv1sfdS5qUnx9GbS6hX1TTjR1L6rT3HaZJFA";
const COMPUTE_UNIT_LIMIT = 120_000;
const PRIORITY_RATE_MULTIPLIER = 1.3;

let db;
let walletKeypair;

function initializeWallet() {
    try {
        const secretKeyString = process.env.WALLET_PRIVATE_KEY;
        if (!secretKeyString) {
            throw new Error("WALLET_PRIVATE_KEY not found in environment variables");
        }
        walletKeypair = Keypair.fromSecretKey(bs58.decode(secretKeyString));
        console.log("Wallet initialized with public key:", walletKeypair.publicKey.toString());
    } catch (error) {
        console.error("Error initializing wallet:", error.message);
        process.exit(1);
    }
}

async function connectToDatabase() {
    const mongoUri = process.env.MONGO_URI;
    const client = new MongoClient(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true });
    try {
        await client.connect();
        db = client.db("bot");
        console.log("Connected to MongoDB successfully.");
        initializeWallet();
    } catch (error) {
        console.error("MongoDB connection failed:", error.message);
        process.exit(1);
    }
}

async function saveToMongo(tokenData) {
    try {
        if (!db) {
            throw new Error("Database connection is not initialized");
        }
        const collection = db.collection("raydium_lp_transactions");
        const result = await collection.insertOne(tokenData);

        if (result.acknowledged) {
            console.log("Token data saved to MongoDB:", result.insertedId);
        } else {
            console.error("Failed to save token data to MongoDB.");
        }
    } catch (error) {
        console.error("Error saving token data to MongoDB:", error.message);
    }
}

function invertCoinAndPcMint(tokenData) {
    const SPECIAL_COIN_MINT = "So11111111111111111111111111111111111111112";
    if (tokenData.tokenAddress === SPECIAL_COIN_MINT) {
        [tokenData.tokenAddress, tokenData.solAddress] = [tokenData.solAddress, tokenData.tokenAddress];
    }
    return tokenData;
}

async function processRaydiumLpTransaction(connection, signature) {
    try {
        const transactionDetails = await connection.getTransaction(signature, {
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0,
        });

        if (!transactionDetails) {
            console.error("No transaction details found for signature:", signature);
            return;
        }

        const message = transactionDetails.transaction.message;
        const accounts = message.staticAccountKeys
            ? message.staticAccountKeys.map((key) => key.toString())
            : message.accountKeys.map((key) => key.toString());

        const instructions = message.compiledInstructions || message.instructions;

        if (!instructions) {
            console.error("No instructions found in transaction");
            return;
        }

        console.log("Transaction Message:", message);
        console.log("Accounts:", accounts);

        for (const ix of instructions) {
            const programId = accounts[ix.programIdIndex];

            if (programId === RAYDIUM_AMM_PROGRAM_ID.toString() && ix.data.length > 0) {
                const accountIndices = ix.accounts || ix.accountKeyIndexes;
                if (!accountIndices) {
                    console.error("No account indices found in instruction");
                    continue;
                }

                const mint0 = accounts[accountIndices[8]];
                const mint1 = accounts[accountIndices[9]];
                const lpTokenMint = accounts[accountIndices[7]];
                const deployer = accounts[accountIndices[17]];
                const poolId = accounts[accountIndices[4]];
                const baseVault = accounts[accountIndices[10]];
                const quoteVault = accounts[accountIndices[11]];
                const ammAuthority = accounts[accountIndices[5]];
                const ammTarget = accounts[accountIndices[13]];
                const ammOpenOrder = accounts[accountIndices[6]];
                const serumMarket = accounts[accountIndices[16]];
                const serumProgram = accounts[accountIndices[15]];

                let tokenData = {
                    programId: programId,
                    ammId: poolId,
                    ammAuthority: ammAuthority,
                    ammOpenOrders: ammOpenOrder,
                    lpMint: lpTokenMint,
                    tokenAddress: mint0,
                    solAddress: mint1,
                    tokenVault: baseVault,
                    solVault: quoteVault,
                    ammTargetOrders: ammTarget,
                    deployer: deployer,
                    serumMarket: serumMarket,
                    serumProgram: serumProgram,
                    systemProgramId: SYSTEM_PROGRAM_ID,
                    tokenProgramId: TOKEN_PROGRAM_ID_STR,
                    associatedTokenProgramId: ASSOCIATED_TOKEN_PROGRAM_ID_STR,
                };

                tokenData = invertCoinAndPcMint(tokenData);

                await saveToMongo(tokenData);
                return tokenData;
            }
        }
    } catch (error) {
        console.error("Error fetching/processing transaction:", error.message);
    }
}

module.exports = {
    connectToDatabase,
    processRaydiumLpTransaction,
    walletKeypair,
};

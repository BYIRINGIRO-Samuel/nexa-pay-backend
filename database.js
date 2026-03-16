const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();

// MongoDB Atlas connection (update with your connection string)
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";
const DB_NAME = "smartpay";

let client = null;
let db = null;

// Initialize MongoDB connection
async function connectDB() {
    try {
        client = new MongoClient(MONGODB_URI, {
            maxPoolSize: 10,
            minPoolSize: 5
        });

        await client.connect();
        db = client.db(DB_NAME);

        console.log(" Connected to MongoDB Atlas");

        // Initialize collections with indexes
        await initializeCollections();

        return db;
    } catch (error) {
        console.error("✗ MongoDB connection failed:", error.message);
        process.exit(1);
    }
}

// Initialize collections and create indexes
async function initializeCollections() {
    try {
        const collections = await db.listCollections().toArray();
        const collectionNames = collections.map(c => c.name);

        // Create collections if they don't exist
        if (!collectionNames.includes('cards')) {
            await db.createCollection('cards');
            await db.collection('cards').createIndex({ uid: 1 }, { unique: true });
            console.log("✓ Created 'cards' collection");
        }

        if (!collectionNames.includes('wallets')) {
            await db.createCollection('wallets');
            await db.collection('wallets').createIndex({ cardUid: 1 }, { unique: true });
            console.log("✓ Created 'wallets' collection");
        }

        if (!collectionNames.includes('products')) {
            await db.createCollection('products');
            console.log("✓ Created 'products' collection");
        }

        if (!collectionNames.includes('transactions')) {
            await db.createCollection('transactions');
            await db.collection('transactions').createIndex({ cardUid: 1 });
            await db.collection('transactions').createIndex({ userId: 1 });
            await db.collection('transactions').createIndex({ createdAt: 1 });
            console.log("✓ Created 'transactions' collection");
        }

        if (!collectionNames.includes('user_cards')) {
            await db.createCollection('user_cards');
            await db.collection('user_cards').createIndex({ userId: 1 });
            await db.collection('user_cards').createIndex({ cardUid: 1 });
            await db.collection('user_cards').createIndex({ userId: 1, cardUid: 1 }, { unique: true });
            console.log("✓ Created 'user_cards' collection");
        }

        if (!collectionNames.includes('users')) {
            await db.createCollection('users');
            await db.collection('users').createIndex({ email: 1 }, { unique: true });
            await db.collection('users').createIndex({ username: 1 }, { unique: true });
            console.log("✓ Created 'users' collection");
        }

        if (!collectionNames.includes('notifications')) {
            await db.createCollection('notifications');
            await db.collection('notifications').createIndex({ userId: 1 });
            await db.collection('notifications').createIndex({ createdAt: -1 });
            await db.collection('notifications').createIndex({ read: 1 });
            console.log("✓ Created 'notifications' collection");
        }

    } catch (error) {
        console.error("Collection initialization error:", error.message);
    }
}

// Get database instance
function getDB() {
    if (!db) {
        throw new Error("Database not connected. Call connectDB() first");
    }
    return db;
}

// Get MongoDB client
function getClient() {
    if (!client) {
        throw new Error("MongoDB client not initialized");
    }
    return client;
}

// Safe wallet update with atomic transaction
async function updateWalletAtomic(cardUid, amount, transactionType, reason = null, userId = null) {
    const session = client.startSession();

    try {
        const result = await session.withTransaction(async () => {
            const walletCollection = db.collection('wallets');
            const transactionCollection = db.collection('transactions');

            // 1. Get current wallet
            const wallet = await walletCollection.findOne({ cardUid });

            if (!wallet) {
                throw new Error(`Wallet not found for card ${cardUid}`);
            }

            const previousBalance = wallet.balance;
            const newBalance = previousBalance + amount;

            // Prevent negative balance on payment
            if (transactionType === 'PAYMENT' && newBalance < 0) {
                throw new Error('Insufficient balance');
            }

            // 2. Update wallet
            await walletCollection.updateOne(
                { cardUid },
                {
                    $set: {
                        balance: newBalance,
                        updatedAt: new Date()
                    }
                },
                { session }
            );

            // 3. Record transaction with user context
            const transaction = {
                cardUid,
                userId: userId ? new ObjectId(userId) : null, // Convert userId to ObjectId if provided
                type: transactionType,
                amount: Math.abs(amount),
                previousBalance,
                newBalance,
                status: 'SUCCESS',
                reason,
                createdAt: new Date()
            };

            const txResult = await transactionCollection.insertOne(transaction, { session });

            return {
                success: true,
                cardUid,
                previousBalance,
                newBalance,
                transactionId: txResult.insertedId,
                timestamp: new Date()
            };
        });

        return result;
    } catch (error) {
        // Transaction automatically aborted on error
        return {
            success: false,
            error: error.message,
            cardUid
        };
    } finally {
        await session.endSession();
    }
}

// Get or create wallet for a card
async function getOrCreateWallet(cardUid) {
    try {
        const walletCollection = db.collection('wallets');
        const cardsCollection = db.collection('cards');

        // Check if card exists
        let card = await cardsCollection.findOne({ uid: cardUid });
        if (!card) {
            // Create new card
            await cardsCollection.insertOne({
                uid: cardUid,
                owner: null,
                createdAt: new Date()
            });
        }

        // Get or create wallet
        let wallet = await walletCollection.findOne({ cardUid });
        if (!wallet) {
            const result = await walletCollection.insertOne({
                cardUid,
                balance: 0,
                updatedAt: new Date()
            });
            wallet = {
                _id: result.insertedId,
                cardUid,
                balance: 0,
                updatedAt: new Date()
            };
        }

        return wallet;
    } catch (error) {
        throw new Error(`Failed to get/create wallet: ${error.message}`);
    }
}

// Get wallet balance
async function getWalletBalance(cardUid) {
    try {
        const wallet = await db.collection('wallets').findOne({ cardUid });
        return wallet ? wallet.balance : null;
    } catch (error) {
        throw new Error(`Failed to fetch balance: ${error.message}`);
    }
}

// Get transaction history for a user (all their cards)
async function getUserTransactionHistory(userId, limit = 10) {
    try {
        // Convert userId string to ObjectId for user_cards query
        const objectId = new ObjectId(userId);

        // Get all cards owned by the user
        const userCards = await db.collection('user_cards')
            .find({ userId: objectId })
            .toArray();

        if (userCards.length === 0) {
            return [];
        }

        const cardUids = userCards.map(uc => uc.cardUid);

        // Get transactions for all user's cards
        const transactions = await db.collection('transactions')
            .find({
                $or: [
                    { userId: objectId }, // Direct user transactions
                    { cardUid: { $in: cardUids } } // Card-based transactions
                ]
            })
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray();

        return transactions;
    } catch (error) {
        throw new Error(`Failed to fetch user transactions: ${error.message}`);
    }
}

// Get transaction history for a specific card (with user validation)
async function getTransactionHistory(cardUid, limit = 10, userId = null) {
    try {
        let query = { cardUid };

        // If userId is provided, validate that user owns the card
        if (userId) {
            const objectId = new ObjectId(userId);
            const userCard = await db.collection('user_cards')
                .findOne({ userId: objectId, cardUid });

            if (!userCard) {
                throw new Error('Access denied: Card not owned by user');
            }
        }

        const transactions = await db.collection('transactions')
            .find(query)
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray();

        return transactions;
    } catch (error) {
        throw new Error(`Failed to fetch transactions: ${error.message}`);
    }
}

// Assign a card to a user
async function assignCardToUser(userId, cardUid) {
    try {
        const userCardsCollection = db.collection('user_cards');

        // Convert userId string to ObjectId
        const objectId = new ObjectId(userId);

        // Check if assignment already exists
        const existing = await userCardsCollection.findOne({ userId: objectId, cardUid });
        if (existing) {
            return { success: true, message: 'Card already assigned to user' };
        }

        // Create the assignment
        await userCardsCollection.insertOne({
            userId: objectId,
            cardUid,
            assignedAt: new Date()
        });

        return { success: true, message: 'Card assigned to user successfully' };
    } catch (error) {
        throw new Error(`Failed to assign card to user: ${error.message}`);
    }
}

// Get all cards owned by a user
async function getUserCards(userId) {
    try {
        // Convert userId string to ObjectId
        const objectId = new ObjectId(userId);

        const userCards = await db.collection('user_cards')
            .find({ userId: objectId })
            .toArray();

        // Get card details and balances
        const cardDetails = [];
        for (const userCard of userCards) {
            const wallet = await db.collection('wallets')
                .findOne({ cardUid: userCard.cardUid });

            cardDetails.push({
                cardUid: userCard.cardUid,
                balance: wallet ? wallet.balance : 0,
                assignedAt: userCard.assignedAt
            });
        }

        return cardDetails;
    } catch (error) {
        throw new Error(`Failed to fetch user cards: ${error.message}`);
    }
}

// Get all products
async function getProducts() {
    try {
        const products = await db.collection('products')
            .find({ active: true })
            .toArray();
        return products;
    } catch (error) {
        throw new Error(`Failed to fetch products: ${error.message}`);
    }
}

// Seed default products with real e-commerce data
async function seedProducts() {
    try {
        const productsCollection = db.collection('products');
        const count = await productsCollection.countDocuments();

        console.log(`📦 Current products in database: ${count}`);

        if (count === 0) {
            const defaultProducts = [
                {
                    name: "Classic White T-Shirt",
                    price: 2999, // $29.99 in cents
                    originalPrice: 3999, // $39.99 in cents
                    category: "Clothing",
                    description: "Premium cotton classic white t-shirt, perfect for everyday wear",
                    image: "https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=400&h=400&fit=crop",
                    badge: "Popular",
                    badgeColor: "#10b981", // green
                    rating: 4.8,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "Denim Jeans",
                    price: 7999, // $79.99 in cents
                    originalPrice: 9999, // $99.99 in cents
                    category: "Clothing",
                    description: "High-quality denim jeans with perfect fit and comfort",
                    image: "https://images.unsplash.com/photo-1542272604-787c3835535d?w=400&h=400&fit=crop",
                    badge: "Best Seller",
                    badgeColor: "#f59e0b", // yellow
                    rating: 4.6,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "Summer Dress",
                    price: 5999, // $59.99 in cents
                    originalPrice: 8999, // $89.99 in cents
                    category: "Clothing",
                    description: "Elegant summer dress perfect for casual and formal occasions",
                    image: "https://images.unsplash.com/photo-1515372039744-b8f02a3ae446?w=400&h=400&fit=crop",
                    badge: "New",
                    badgeColor: "#3b82f6", // blue
                    rating: 4.9,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "Leather Jacket",
                    price: 12999, // $129.99 in cents
                    originalPrice: 15999, // $159.99 in cents
                    category: "Clothing",
                    description: "Premium leather jacket with modern design and superior quality",
                    image: "https://images.unsplash.com/photo-1551028719-00167b16eac5?w=400&h=400&fit=crop",
                    badge: "Premium",
                    badgeColor: "#8b5cf6", // purple
                    rating: 4.7,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "Casual Sneakers",
                    price: 8999, // $89.99 in cents
                    originalPrice: 11999, // $119.99 in cents
                    category: "Footwear",
                    description: "Comfortable casual sneakers for everyday activities",
                    image: "https://images.unsplash.com/photo-1549298916-b41d501d3772?w=400&h=400&fit=crop",
                    badge: "Trending",
                    badgeColor: "#ef4444", // red
                    rating: 4.5,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "Wireless Headphones",
                    price: 14999, // $149.99 in cents
                    originalPrice: 19999, // $199.99 in cents
                    category: "Electronics",
                    description: "High-quality wireless headphones with noise cancellation",
                    image: "https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=400&h=400&fit=crop",
                    badge: "Featured",
                    badgeColor: "#06b6d4", // cyan
                    rating: 4.8,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "Smartphone Case",
                    price: 1999, // $19.99 in cents
                    originalPrice: 2999, // $29.99 in cents
                    category: "Electronics",
                    description: "Protective smartphone case with elegant design",
                    image: "https://images.unsplash.com/photo-1556656793-08538906a9f8?w=400&h=400&fit=crop",
                    badge: "Popular",
                    badgeColor: "#10b981", // green
                    rating: 4.6,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "Coffee Mug",
                    price: 1299, // $12.99 in cents
                    originalPrice: 1799, // $17.99 in cents
                    category: "Home",
                    description: "Premium ceramic coffee mug for your morning coffee",
                    image: "https://images.unsplash.com/photo-1514228742587-6b1558fcf93a?w=400&h=400&fit=crop",
                    badge: "Limited",
                    badgeColor: "#ec4899", // pink
                    rating: 4.4,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                }
            ];

            console.log(`🌱 Inserting ${defaultProducts.length} products...`);
            const result = await productsCollection.insertMany(defaultProducts);
            console.log(`✅ Successfully inserted ${result.insertedCount} products`);
            console.log("✓ E-commerce products seeded with images and details");

            // Log the inserted products
            defaultProducts.forEach((product, index) => {
                console.log(`   ${index + 1}. ${product.name} - $${(product.price / 100).toFixed(2)} (${product.category}) [${product.badge}]`);
            });
        } else {
            console.log("ℹ️  Products already exist in database, skipping seeding");
        }
    } catch (error) {
        console.error("❌ Product seeding error:", error.message);
        throw error;
    }
}

// Force seed products (for manual seeding)
async function forceSeedProducts() {
    try {
        const productsCollection = db.collection('products');

        // Clear existing products
        console.log('🗑️  Clearing existing products...');
        await productsCollection.deleteMany({});

        // Seed new products
        await seedProducts();

        return { success: true, message: 'Products force-seeded successfully' };
    } catch (error) {
        console.error("❌ Force seed error:", error.message);
        throw error;
    }
}

// User management functions
async function createUser(userData) {
    try {
        const usersCollection = db.collection('users');
        const result = await usersCollection.insertOne({
            ...userData,
            createdAt: new Date(),
            updatedAt: new Date()
        });
        return { success: true, userId: result.insertedId };
    } catch (error) {
        throw new Error(`Failed to create user: ${error.message}`);
    }
}

async function findUserByEmail(email) {
    try {
        const usersCollection = db.collection('users');
        return await usersCollection.findOne({ email });
    } catch (error) {
        throw new Error(`Failed to find user by email: ${error.message}`);
    }
}

async function findUserByUsername(username) {
    try {
        const usersCollection = db.collection('users');
        return await usersCollection.findOne({ username });
    } catch (error) {
        throw new Error(`Failed to find user by username: ${error.message}`);
    }
}

// Update user profile
async function updateUserProfile(userId, updateData) {
    try {
        const usersCollection = db.collection('users');

        // Convert userId string to ObjectId
        const objectId = new ObjectId(userId);

        // Remove undefined fields
        const cleanUpdateData = Object.fromEntries(
            Object.entries(updateData).filter(([_, value]) => value !== undefined)
        );

        cleanUpdateData.updatedAt = new Date();

        const result = await usersCollection.updateOne(
            { _id: objectId },
            { $set: cleanUpdateData }
        );

        if (result.matchedCount === 0) {
            throw new Error('User not found');
        }

        // Return updated user
        const updatedUser = await usersCollection.findOne({ _id: objectId });
        return { success: true, user: updatedUser };
    } catch (error) {
        throw new Error(`Failed to update user profile: ${error.message}`);
    }
}

// Close database connection
async function closeDB() {
    if (client) {
        await client.close();
        console.log("✓ Database connection closed");
    }
}

// Notification management functions
async function createNotification(userId, type, title, message, metadata = null) {
    try {
        const notificationsCollection = db.collection('notifications');

        const notification = {
            userId: new ObjectId(userId),
            type,
            title,
            message,
            metadata,
            read: false,
            createdAt: new Date()
        };

        const result = await notificationsCollection.insertOne(notification);
        return { success: true, notificationId: result.insertedId };
    } catch (error) {
        throw new Error(`Failed to create notification: ${error.message}`);
    }
}

async function getUserNotifications(userId, limit = 20) {
    try {
        const notificationsCollection = db.collection('notifications');
        const objectId = new ObjectId(userId);

        const notifications = await notificationsCollection
            .find({ userId: objectId })
            .sort({ createdAt: -1 })
            .limit(limit)
            .toArray();

        return notifications;
    } catch (error) {
        throw new Error(`Failed to fetch notifications: ${error.message}`);
    }
}

async function markNotificationAsRead(userId, notificationId) {
    try {
        const notificationsCollection = db.collection('notifications');
        const userObjectId = new ObjectId(userId);
        const notifObjectId = new ObjectId(notificationId);

        const result = await notificationsCollection.updateOne(
            { _id: notifObjectId, userId: userObjectId },
            { $set: { read: true, readAt: new Date() } }
        );

        return { success: result.matchedCount > 0 };
    } catch (error) {
        throw new Error(`Failed to mark notification as read: ${error.message}`);
    }
}

async function markAllNotificationsAsRead(userId) {
    try {
        const notificationsCollection = db.collection('notifications');
        const objectId = new ObjectId(userId);

        const result = await notificationsCollection.updateMany(
            { userId: objectId, read: false },
            { $set: { read: true, readAt: new Date() } }
        );

        return { success: true, modifiedCount: result.modifiedCount };
    } catch (error) {
        throw new Error(`Failed to mark all notifications as read: ${error.message}`);
    }
}

async function deleteNotification(userId, notificationId) {
    try {
        const notificationsCollection = db.collection('notifications');
        const userObjectId = new ObjectId(userId);
        const notifObjectId = new ObjectId(notificationId);

        const result = await notificationsCollection.deleteOne({
            _id: notifObjectId,
            userId: userObjectId
        });

        return { success: result.deletedCount > 0 };
    } catch (error) {
        throw new Error(`Failed to delete notification: ${error.message}`);
    }
}

async function getUnreadNotificationCount(userId) {
    try {
        const notificationsCollection = db.collection('notifications');
        const objectId = new ObjectId(userId);

        const count = await notificationsCollection.countDocuments({
            userId: objectId,
            read: false
        });

        return count;
    } catch (error) {
        throw new Error(`Failed to get unread notification count: ${error.message}`);
    }
}

module.exports = {
    connectDB,
    getDB,
    getClient,
    updateWalletAtomic,
    getOrCreateWallet,
    getWalletBalance,
    getTransactionHistory,
    getUserTransactionHistory,
    assignCardToUser,
    getUserCards,
    getProducts,
    seedProducts,
    forceSeedProducts,
    createUser,
    findUserByEmail,
    findUserByUsername,
    updateUserProfile,
    createNotification,
    getUserNotifications,
    markNotificationAsRead,
    markAllNotificationsAsRead,
    deleteNotification,
    getUnreadNotificationCount,
    closeDB
};

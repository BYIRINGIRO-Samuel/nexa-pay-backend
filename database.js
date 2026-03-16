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

// Seed default vehicles with real automotive data
async function seedProducts() {
    try {
        const productsCollection = db.collection('products');
        const count = await productsCollection.countDocuments();

        console.log(`🚗 Current vehicles in database: ${count}`);

        if (count === 0) {
            const defaultVehicles = [
                // Luxury Cars
                {
                    name: "Tesla Model S Plaid",
                    price: 12999900, // $129,999.00 in cents
                    originalPrice: 13999900, // $139,999.00 in cents
                    category: "Electric",
                    description: "Fastest production sedan with tri-motor all-wheel drive and 1,020 hp",
                    image: "https://images.unsplash.com/photo-1617788138017-80ad40651399?w=400&h=400&fit=crop",
                    badge: "Popular",
                    badgeColor: "#10b981", // green
                    rating: 4.8,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "BMW M3 Competition",
                    price: 7299900, // $72,999.00 in cents
                    originalPrice: 7599900, // $75,999.00 in cents
                    category: "Sports",
                    description: "High-performance sports sedan with twin-turbo engine",
                    image: "https://images.unsplash.com/photo-1555215695-3004980ad54e?w=400&h=400&fit=crop",
                    badge: "Best Seller",
                    badgeColor: "#f59e0b", // yellow
                    rating: 4.7,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "Mercedes-Benz G63 AMG",
                    price: 17999900, // $179,999.00 in cents
                    originalPrice: 18999900, // $189,999.00 in cents
                    category: "SUV",
                    description: "Luxury off-road SUV with 577 hp V8 biturbo engine",
                    image: "https://images.unsplash.com/photo-1606664515524-ed2f786a0bd6?w=400&h=400&fit=crop",
                    badge: "New",
                    badgeColor: "#3b82f6", // blue
                    rating: 4.9,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "Porsche 911 Turbo S",
                    price: 20799900, // $207,999.00 in cents
                    originalPrice: 21999900, // $219,999.00 in cents
                    category: "Sports",
                    description: "Iconic sports car with 640 hp turbocharged engine",
                    image: "https://images.unsplash.com/photo-1544636331-e26879cd4d9b?w=400&h=400&fit=crop",
                    badge: "Premium",
                    badgeColor: "#8b5cf6", // purple
                    rating: 4.9,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "Range Rover Sport SVR",
                    price: 11999900, // $119,999.00 in cents
                    originalPrice: 12999900, // $129,999.00 in cents
                    category: "SUV",
                    description: "High-performance luxury SUV with supercharged V8",
                    image: "https://images.unsplash.com/photo-1494905998402-395d579af36f?w=400&h=400&fit=crop",
                    badge: "Trending",
                    badgeColor: "#ef4444", // red
                    rating: 4.6,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "Audi RS6 Avant",
                    price: 11499900, // $114,999.00 in cents
                    originalPrice: 11999900, // $119,999.00 in cents
                    category: "Wagon",
                    description: "High-performance luxury wagon with 591 hp twin-turbo V8",
                    image: "https://images.unsplash.com/photo-1606664515524-ed2f786a0bd6?w=400&h=400&fit=crop",
                    badge: "Featured",
                    badgeColor: "#06b6d4", // cyan
                    rating: 4.8,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "Lamborghini Huracán EVO",
                    price: 24999900, // $249,999.00 in cents
                    originalPrice: 26999900, // $269,999.00 in cents
                    category: "Supercar",
                    description: "Italian supercar with 630 hp naturally aspirated V10",
                    image: "https://images.unsplash.com/photo-1544636331-e26879cd4d9b?w=400&h=400&fit=crop",
                    badge: "Limited",
                    badgeColor: "#ec4899", // pink
                    rating: 5.0,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "Ferrari F8 Tributo",
                    price: 27999900, // $279,999.00 in cents
                    originalPrice: 29999900, // $299,999.00 in cents
                    category: "Supercar",
                    description: "Mid-engine supercar with 710 hp twin-turbo V8",
                    image: "https://images.unsplash.com/photo-1583121274602-3e2820c69888?w=400&h=400&fit=crop",
                    badge: "Exclusive",
                    badgeColor: "#dc2626", // red
                    rating: 4.9,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "McLaren 720S",
                    price: 31999900, // $319,999.00 in cents
                    originalPrice: 33999900, // $339,999.00 in cents
                    category: "Supercar",
                    description: "British supercar with 710 hp twin-turbo V8 and carbon fiber body",
                    image: "https://images.unsplash.com/photo-1544636331-e26879cd4d9b?w=400&h=400&fit=crop",
                    badge: "Premium",
                    badgeColor: "#8b5cf6", // purple
                    rating: 4.8,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "Ford F-150 Lightning",
                    price: 5999900, // $59,999.00 in cents
                    originalPrice: 6499900, // $64,999.00 in cents
                    category: "Electric",
                    description: "Electric pickup truck with 563 hp and 775 lb-ft torque",
                    image: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&h=400&fit=crop",
                    badge: "New",
                    badgeColor: "#3b82f6", // blue
                    rating: 4.5,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                // Motorcycles
                {
                    name: "Ducati Panigale V4 S",
                    price: 2899900, // $28,999.00 in cents
                    originalPrice: 3199900, // $31,999.00 in cents
                    category: "Motorcycle",
                    description: "Italian superbike with 214 hp Desmosedici Stradale V4 engine",
                    image: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&h=400&fit=crop",
                    badge: "Racing",
                    badgeColor: "#dc2626", // red
                    rating: 4.9,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "Kawasaki Ninja H2R",
                    price: 5999900, // $59,999.00 in cents
                    originalPrice: 6499900, // $64,999.00 in cents
                    category: "Motorcycle",
                    description: "Track-only hyperbike with supercharged 310 hp engine",
                    image: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&h=400&fit=crop",
                    badge: "Track Only",
                    badgeColor: "#059669", // green
                    rating: 5.0,
                    inStock: false,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "Harley-Davidson CVO Limited",
                    price: 4699900, // $46,999.00 in cents
                    originalPrice: 4999900, // $49,999.00 in cents
                    category: "Motorcycle",
                    description: "Premium touring motorcycle with 117 cubic inch Milwaukee-Eight engine",
                    image: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&h=400&fit=crop",
                    badge: "Touring",
                    badgeColor: "#f97316", // orange
                    rating: 4.6,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "BMW S1000RR",
                    price: 1799900, // $17,999.00 in cents
                    originalPrice: 1999900, // $19,999.00 in cents
                    category: "Motorcycle",
                    description: "German superbike with 205 hp inline-four engine and advanced electronics",
                    image: "https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=400&h=400&fit=crop",
                    badge: "Sport",
                    badgeColor: "#3b82f6", // blue
                    rating: 4.7,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                // Private Jets
                {
                    name: "Cessna Citation CJ4",
                    price: 999999900, // $9,999,999.00 in cents
                    originalPrice: 1099999900, // $10,999,999.00 in cents
                    category: "Private Jet",
                    description: "Light business jet with seating for up to 10 passengers",
                    image: "https://images.unsplash.com/photo-1540962351504-03099e0a754b?w=400&h=400&fit=crop",
                    badge: "Business",
                    badgeColor: "#1f2937", // gray
                    rating: 4.8,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "Gulfstream G650ER",
                    price: 7000000000, // $70,000,000.00 in cents
                    originalPrice: 7500000000, // $75,000,000.00 in cents
                    category: "Private Jet",
                    description: "Ultra-long-range business jet with intercontinental capability",
                    image: "https://images.unsplash.com/photo-1540962351504-03099e0a754b?w=400&h=400&fit=crop",
                    badge: "Ultra Luxury",
                    badgeColor: "#fbbf24", // yellow
                    rating: 5.0,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "Bombardier Global 7500",
                    price: 7300000000, // $73,000,000.00 in cents
                    originalPrice: 7800000000, // $78,000,000.00 in cents
                    category: "Private Jet",
                    description: "Flagship business jet with the longest range in its class",
                    image: "https://images.unsplash.com/photo-1540962351504-03099e0a754b?w=400&h=400&fit=crop",
                    badge: "Flagship",
                    badgeColor: "#8b5cf6", // purple
                    rating: 4.9,
                    inStock: false,
                    active: true,
                    createdAt: new Date()
                },
                // Luxury Boats
                {
                    name: "Azimut S7",
                    price: 299999900, // $2,999,999.00 in cents
                    originalPrice: 329999900, // $3,299,999.00 in cents
                    category: "Yacht",
                    description: "70-foot luxury yacht with twin MAN V12 engines",
                    image: "https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=400&h=400&fit=crop",
                    badge: "Luxury",
                    badgeColor: "#0ea5e9", // sky blue
                    rating: 4.7,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                {
                    name: "Sunseeker Predator 74",
                    price: 399999900, // $3,999,999.00 in cents
                    originalPrice: 449999900, // $4,499,999.00 in cents
                    category: "Yacht",
                    description: "74-foot performance yacht with triple MAN V8 engines",
                    image: "https://images.unsplash.com/photo-1544551763-46a013bb70d5?w=400&h=400&fit=crop",
                    badge: "Performance",
                    badgeColor: "#ef4444", // red
                    rating: 4.8,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                },
                // Luxury RV
                {
                    name: "Prevost H3-45 VIP",
                    price: 199999900, // $1,999,999.00 in cents
                    originalPrice: 219999900, // $2,199,999.00 in cents
                    category: "RV",
                    description: "Luxury motorcoach with custom interior and premium amenities",
                    image: "https://images.unsplash.com/photo-1544636331-e26879cd4d9b?w=400&h=400&fit=crop",
                    badge: "Custom",
                    badgeColor: "#7c3aed", // violet
                    rating: 4.6,
                    inStock: true,
                    active: true,
                    createdAt: new Date()
                }
            ];

            console.log(`🌱 Inserting ${defaultVehicles.length} vehicles...`);
            const result = await productsCollection.insertMany(defaultVehicles);
            console.log(`✅ Successfully inserted ${result.insertedCount} vehicles`);
            console.log("✓ Luxury vehicle dealership products seeded with images and details");

            // Log the inserted vehicles
            defaultVehicles.forEach((vehicle, index) => {
                console.log(`   ${index + 1}. ${vehicle.name} - $${(vehicle.price / 100).toFixed(2)} (${vehicle.category}) [${vehicle.badge}]`);
            });
        } else {
            console.log("ℹ️  Vehicles already exist in database, skipping seeding");
        }
    } catch (error) {
        console.error("❌ Vehicle seeding error:", error.message);
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

        return { success: true, message: 'Cars force-seeded successfully' };
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
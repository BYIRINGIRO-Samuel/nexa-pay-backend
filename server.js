const express = require('express');
const mqtt = require('mqtt');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const {
  connectDB,
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
} = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));
app.use(express.json());

// ========================================
// CONFIGURATION
// ========================================
const PORT = process.env.PORT || 9210;
const TEAM_ID = "team_07";
const MQTT_BROKER = "mqtt://157.173.101.159:1883";
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// JWT Authentication Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, error: 'Access token required' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, error: 'Invalid token' });
    req.user = user;
    next();
  });
}

// MQTT Topics
const TOPICS = {
  STATUS: `rfid/${TEAM_ID}/card/status`,
  BALANCE: `rfid/${TEAM_ID}/card/balance`,
  TOPUP: `rfid/${TEAM_ID}/card/topup`,
  PAY: `rfid/${TEAM_ID}/card/pay`,
  HEALTH: `rfid/${TEAM_ID}/device/health`,
  LWT: `rfid/${TEAM_ID}/device/status`
};

let mqttClient = null;

// ========================================
// SERVE FRONTEND
// ========================================
const frontendPath = path.resolve(__dirname, '../frontend');
app.use(express.static(frontendPath));

app.get('/', (req, res) => {
  res.sendFile(path.join(frontendPath, 'index.html'));
});

// ========================================
// MQTT SETUP
// ========================================
function setupMQTT() {
  mqttClient = mqtt.connect(MQTT_BROKER, {
    clientId: `backend_${TEAM_ID}_${Date.now()}`,
    will: {
      topic: TOPICS.LWT,
      payload: JSON.stringify({ status: 'offline', timestamp: new Date() }),
      qos: 1,
      retain: true
    }
  });

  mqttClient.on('connect', () => {
    console.log(' Connected to MQTT Broker');

    // Subscribe to all incoming topics
    const subscribes = [
      TOPICS.STATUS,
      TOPICS.BALANCE,
      TOPICS.TOPUP,
      TOPICS.PAY,
      TOPICS.HEALTH
    ];

    mqttClient.subscribe(subscribes, (err) => {
      if (!err) console.log(' Subscribed to MQTT topics');
      else console.error('MQTT subscription error:', err);
    });

    // Publish backend online status
    mqttClient.publish(
      TOPICS.LWT,
      JSON.stringify({ status: 'online', timestamp: new Date() }),
      { retain: true }
    );
  });

  mqttClient.on('message', async (topic, message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log(`📨 MQTT [${topic}]:`, data);

      // Handle card scans
      if (topic === TOPICS.STATUS) {
        const { uid, balance } = data;

        // Ensure wallet exists in DB
        await getOrCreateWallet(uid);

        // Broadcast to all connected clients
        io.emit('card-scanned', {
          uid,
          deviceBalance: balance,
          timestamp: new Date()
        });
      }

      // Handle payment confirmations
      if (topic === TOPICS.PAY) {
        const { uid, status, newBalance } = data;
        io.emit('payment-confirmed', {
          uid,
          status,
          newBalance,
          timestamp: new Date()
        });
      }

      // Handle balance updates
      if (topic === TOPICS.BALANCE) {
        const { uid, new_balance } = data;
        io.emit('balance-updated', {
          uid,
          newBalance: new_balance,
          timestamp: new Date()
        });
      }

    } catch (error) {
      console.error('❌ MQTT message parse error:', error.message);
    }
  });

  mqttClient.on('error', (err) => {
    console.error('❌ MQTT error:', err.message);
  });

  mqttClient.on('offline', () => {
    console.log('⚠️  MQTT connection lost');
  });
}

// ========================================
// WEBSOCKET SETUP
// ========================================
io.on('connection', (socket) => {
  console.log(` WebSocket client connected: ${socket.id}`);

  socket.on('disconnect', () => {
    console.log(` WebSocket client disconnected: ${socket.id}`);
  });

  // Client requests current balance
  socket.on('request-balance', async (data) => {
    try {
      const { uid } = data;
      const balance = await getWalletBalance(uid);
      socket.emit('balance-response', { uid, balance, success: true });
    } catch (error) {
      socket.emit('balance-response', { success: false, error: error.message });
    }
  });

  // Client requests products
  socket.on('request-products', async () => {
    try {
      const products = await getProducts();
      socket.emit('products-response', { products, success: true });
    } catch (error) {
      socket.emit('products-response', { success: false, error: error.message });
    }
  });

  // Client requests transaction history
  socket.on('request-history', async (data) => {
    try {
      const { uid, limit } = data;
      const transactions = await getTransactionHistory(uid, limit || 10);
      socket.emit('history-response', { uid, transactions, success: true });
    } catch (error) {
      socket.emit('history-response', { success: false, error: error.message });
    }
  });
});

// ========================================
// HTTP API ENDPOINTS
// ========================================

/**
 * GET /health
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'Smart-Pay Backend is running',
    timestamp: new Date(),
    version: '1.0.0'
  });
});

/**
 * POST /auth/signup
 * Register a new user
 * 
 * Request body:
 * {
 *   "username": "string",
 *   "email": "string",
 *   "password": "string",
 *   "role": "admin" | "cashier" (default: "admin")
 * }
 */
app.post('/auth/signup', async (req, res) => {
  try {
    const { username, email, password, role = 'admin' } = req.body;

    // Validation
    if (!username || !email || !password) {
      return res.status(400).json({ success: false, error: 'Username, email, and password are required' });
    }

    // Check if user exists
    const existingEmail = await findUserByEmail(email);
    const existingUsername = await findUserByUsername(username);
    if (existingEmail || existingUsername) {
      return res.status(400).json({ success: false, error: 'User already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const result = await createUser({
      username,
      email,
      password: hashedPassword,
      role
    });

    if (!result.success) {
      return res.status(500).json({ success: false, error: 'Failed to create user' });
    }

    // Generate JWT
    const token = jwt.sign({ userId: result.userId, username, email, role }, JWT_SECRET, { expiresIn: '24h' });

    res.status(201).json({
      success: true,
      message: 'User created successfully',
      token,
      user: { username, email, role }
    });
  } catch (error) {
    console.error('Signup error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /auth/login
 * Authenticate user
 * 
 * Request body:
 * {
 *   "email": "string",
 *   "password": "string"
 * }
 */
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    // Find user
    const user = await findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    // Compare password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }

    // Generate JWT
    const token = jwt.sign({ userId: user._id, username: user.username, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '24h' });

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: { username: user.username, email: user.email, role: user.role }
    });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /balance/:uid
 * Retrieve wallet balance for a specific card (Protected)
 */
app.get('/balance/:uid', authenticateToken, async (req, res) => {
  try {
    const { uid } = req.params;
    const userId = req.user.userId;

    if (!uid) {
      return res.status(400).json({ success: false, error: 'UID required' });
    }

    // Validate that user owns this card
    const userCards = await getUserCards(userId);
    const ownsCard = userCards.some(card => card.cardUid === uid);

    if (!ownsCard) {
      return res.status(403).json({ success: false, error: 'Access denied: Card not owned by user' });
    }

    // Ensure wallet exists
    const wallet = await getOrCreateWallet(uid);

    res.json({
      success: true,
      uid,
      balance: wallet.balance,
      timestamp: new Date()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /topup
 * Add balance to a card (Admin action - Protected)
 * 
 * Request body:
 * {
 *   "uid": "A1B2C3D4",
 *   "amount": 1000
 * }
 */
app.post('/topup', authenticateToken, async (req, res) => {
  try {
    const { uid, amount } = req.body;
    const userId = req.user.userId;

    // Validation
    if (!uid || !amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid UID or amount'
      });
    }

    // Only admin users can perform top-ups
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied: Admin role required'
      });
    }

    // Ensure wallet exists
    await getOrCreateWallet(uid);

    // Assign card to user if not already assigned
    await assignCardToUser(userId, uid);

    // Perform atomic wallet update with user context
    const result = await updateWalletAtomic(uid, amount, 'TOPUP', 'Admin top-up', userId);

    if (!result.success) {
      return res.status(400).json(result);
    }

    console.log(`✓ Top-up successful: ${uid} +${amount} by user ${req.user.username}`);

    // Create notification for successful top-up
    await createNotification(
      userId,
      'transaction',
      'Top-up Successful',
      `Successfully added $${amount} to card ${uid}. New balance: $${result.newBalance}`,
      { cardUid: uid, amount, newBalance: result.newBalance, type: 'TOPUP' }
    );

    // Publish to MQTT for device confirmation
    if (mqttClient && mqttClient.connected) {
      mqttClient.publish(
        TOPICS.TOPUP,
        JSON.stringify({
          uid,
          amount,
          previousBalance: result.previousBalance,
          newBalance: result.newBalance,
          timestamp: new Date()
        })
      );
    }

    // Broadcast to all WebSocket clients
    io.emit('topup-success', {
      uid,
      amount,
      previousBalance: result.previousBalance,
      newBalance: result.newBalance,
      timestamp: result.timestamp
    });

    res.json(result);
  } catch (error) {
    console.error('❌ Top-up error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /pay
 * Deduct balance from a card (Cashier action - Protected)
 * 
 * Request body:
 * {
 *   "uid": "A1B2C3D4",
 *   "productId": "123",
 *   "quantity": 2,
 *   "totalAmount": 1000
 * }
 */
app.post('/pay', authenticateToken, async (req, res) => {
  try {
    const { uid, productId, quantity, totalAmount } = req.body;
    const userId = req.user.userId;

    // Validation
    if (!uid || !totalAmount || totalAmount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid UID or amount'
      });
    }

    // Ensure wallet exists
    await getOrCreateWallet(uid);

    // Get current balance
    const wallet = await getWalletBalance(uid);

    // Check sufficient balance
    if (wallet < totalAmount) {
      // Log failed transaction with user context
      await updateWalletAtomic(
        uid,
        0,
        'PAYMENT',
        `Failed: Insufficient balance. Required: ${totalAmount}, Available: ${wallet}`,
        userId
      );

      console.log(`❌ Payment declined: ${uid} - Insufficient balance by user ${req.user.username}`);

      io.emit('payment-declined', {
        uid,
        reason: 'Insufficient balance',
        required: totalAmount,
        available: wallet,
        timestamp: new Date()
      });

      return res.status(400).json({
        success: false,
        reason: 'Insufficient balance',
        required: totalAmount,
        available: wallet
      });
    }

    // Perform atomic wallet update (deduct = negative amount) with user context
    const result = await updateWalletAtomic(
      uid,
      -totalAmount,
      'PAYMENT',
      `Product: ${productId}, Qty: ${quantity}`,
      userId
    );

    if (!result.success) {
      return res.status(400).json(result);
    }

    console.log(`✓ Payment successful: ${uid} -${totalAmount} by user ${req.user.username}`);

    // Create notification for successful payment
    await createNotification(
      userId,
      'transaction',
      'Payment Processed',
      `Payment of $${totalAmount} processed successfully. New balance: $${result.newBalance}`,
      { cardUid: uid, amount: totalAmount, newBalance: result.newBalance, type: 'PAYMENT', productId, quantity }
    );

    // Publish to MQTT for device confirmation
    if (mqttClient && mqttClient.connected) {
      mqttClient.publish(
        TOPICS.PAY,
        JSON.stringify({
          uid,
          amount: totalAmount,
          previousBalance: result.previousBalance,
          newBalance: result.newBalance,
          status: 'approved',
          timestamp: new Date()
        })
      );
    }

    // Broadcast to all WebSocket clients
    io.emit('payment-success', {
      uid,
      amount: totalAmount,
      previousBalance: result.previousBalance,
      newBalance: result.newBalance,
      productId,
      quantity,
      timestamp: result.timestamp
    });

    res.json({
      success: true,
      uid,
      amount: totalAmount,
      previousBalance: result.previousBalance,
      newBalance: result.newBalance,
      status: 'approved',
      timestamp: result.timestamp
    });
  } catch (error) {
    console.error('❌ Payment error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /products
 * Retrieve all active products (Protected)
 */
app.get('/products', authenticateToken, async (req, res) => {
  try {
    const products = await getProducts();
    res.json({
      success: true,
      products
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /products/:id
 * Retrieve a single product by ID (Protected)
 */
app.get('/products/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const products = await getProducts();
    const product = products.find(p => p._id.toString() === id);

    if (!product) {
      return res.status(404).json({
        success: false,
        error: 'Product not found'
      });
    }

    res.json({
      success: true,
      product
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /seed-products
 * Manually seed products (Protected - Admin only)
 */
app.post('/seed-products', authenticateToken, async (req, res) => {
  try {
    // Only admin users can seed products
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied: Admin role required'
      });
    }

    console.log('🌱 Manual product seeding requested by:', req.user.username);
    await seedProducts();

    res.json({
      success: true,
      message: 'Products seeded successfully'
    });
  } catch (error) {
    console.error('Manual product seeding error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /force-seed-products
 * Force seed products (clears existing and re-seeds) - Admin only
 */
app.post('/force-seed-products', authenticateToken, async (req, res) => {
  try {
    // Only admin users can force seed products
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Access denied: Admin role required'
      });
    }

    console.log('🔄 Force product seeding requested by:', req.user.username);
    const result = await forceSeedProducts();

    res.json({
      success: true,
      message: 'Products force-seeded successfully',
      result
    });
  } catch (error) {
    console.error('Force product seeding error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /transactions/:uid
 * Get transaction history for a card (Protected)
 */
app.get('/transactions/:uid', authenticateToken, async (req, res) => {
  try {
    const { uid } = req.params;
    const { limit } = req.query;
    const userId = req.user.userId;

    const transactions = await getTransactionHistory(uid, parseInt(limit) || 10, userId);

    res.json({
      success: true,
      uid,
      transactions,
      count: transactions.length
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /user/transactions
 * Get all transactions for the current user (Protected)
 */
app.get('/user/transactions', authenticateToken, async (req, res) => {
  try {
    const { limit } = req.query;
    const userId = req.user.userId;

    const transactions = await getUserTransactionHistory(userId, parseInt(limit) || 20);

    res.json({
      success: true,
      transactions,
      count: transactions.length
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /user/cards
 * Get all cards owned by the current user (Protected)
 */
app.get('/user/cards', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const cards = await getUserCards(userId);

    res.json({
      success: true,
      cards,
      count: cards.length
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /user/assign-card
 * Assign a card to the current user (Protected)
 */
app.post('/user/assign-card', authenticateToken, async (req, res) => {
  try {
    const { uid } = req.body;
    const userId = req.user.userId;

    if (!uid) {
      return res.status(400).json({ success: false, error: 'Card UID required' });
    }

    // Ensure wallet exists for the card
    await getOrCreateWallet(uid);

    // Assign card to user
    const result = await assignCardToUser(userId, uid);

    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /user/profile
 * Update user profile (Protected)
 */
app.put('/user/profile', authenticateToken, async (req, res) => {
  try {
    const { username, email, currentPassword, newPassword } = req.body;
    const userId = req.user.userId;

    // Validation
    if (!username && !email && !newPassword) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    // If updating password, verify current password
    if (newPassword) {
      if (!currentPassword) {
        return res.status(400).json({ success: false, error: 'Current password required' });
      }

      // Get current user to verify password
      const currentUser = await findUserByEmail(req.user.email);
      if (!currentUser) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      // Verify current password
      const isValidPassword = await bcrypt.compare(currentPassword, currentUser.password);
      if (!isValidPassword) {
        return res.status(401).json({ success: false, error: 'Current password is incorrect' });
      }

      // Validate new password
      if (newPassword.length < 6) {
        return res.status(400).json({ success: false, error: 'New password must be at least 6 characters long' });
      }
    }

    // Check for duplicate username/email (excluding current user)
    if (username && username !== req.user.username) {
      const existingUser = await findUserByUsername(username);
      if (existingUser && existingUser._id.toString() !== userId.toString()) {
        return res.status(400).json({ success: false, error: 'Username already exists' });
      }
    }

    if (email && email !== req.user.email) {
      const existingUser = await findUserByEmail(email);
      if (existingUser && existingUser._id.toString() !== userId.toString()) {
        return res.status(400).json({ success: false, error: 'Email already exists' });
      }
    }

    // Prepare update data
    const updateData = {};
    if (username) updateData.username = username;
    if (email) updateData.email = email;
    if (newPassword) {
      updateData.password = await bcrypt.hash(newPassword, 10);
    }

    // Update user profile
    const result = await updateUserProfile(userId, updateData);

    if (!result.success) {
      return res.status(500).json({ success: false, error: 'Failed to update profile' });
    }

    // Generate new JWT with updated info
    const token = jwt.sign(
      {
        userId: result.user._id,
        username: result.user.username,
        email: result.user.email,
        role: result.user.role
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      message: 'Profile updated successfully',
      token,
      user: {
        username: result.user.username,
        email: result.user.email,
        role: result.user.role
      }
    });
  } catch (error) {
    console.error('Profile update error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================
// NOTIFICATION ENDPOINTS
// ========================================

/**
 * GET /user/notifications
 * Get user notifications (Protected)
 */
app.get('/user/notifications', authenticateToken, async (req, res) => {
  try {
    const { limit } = req.query;
    const userId = req.user.userId;

    const notifications = await getUserNotifications(userId, parseInt(limit) || 20);

    res.json({
      success: true,
      notifications,
      count: notifications.length
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /user/notifications/unread-count
 * Get unread notification count (Protected)
 */
app.get('/user/notifications/unread-count', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const count = await getUnreadNotificationCount(userId);

    res.json({
      success: true,
      unreadCount: count
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /user/notifications/:id/read
 * Mark notification as read (Protected)
 */
app.put('/user/notifications/:id/read', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const result = await markNotificationAsRead(userId, id);

    if (!result.success) {
      return res.status(404).json({ success: false, error: 'Notification not found' });
    }

    res.json({
      success: true,
      message: 'Notification marked as read'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PUT /user/notifications/mark-all-read
 * Mark all notifications as read (Protected)
 */
app.put('/user/notifications/mark-all-read', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const result = await markAllNotificationsAsRead(userId);

    res.json({
      success: true,
      message: `${result.modifiedCount} notifications marked as read`
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /user/notifications/:id
 * Delete notification (Protected)
 */
app.delete('/user/notifications/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.userId;

    const result = await deleteNotification(userId, id);

    if (!result.success) {
      return res.status(404).json({ success: false, error: 'Notification not found' });
    }

    res.json({
      success: true,
      message: 'Notification deleted successfully'
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================
// INITIALIZATION & STARTUP
// ========================================
async function startup() {
  try {
    // Connect to MongoDB
    console.log('\n🔄 Initializing Smart-Pay Backend...\n');
    await connectDB();

    // Seed default products
    await seedProducts();

    // Setup MQTT
    setupMQTT();

    // Start HTTP server
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`\n✓ Server running on http://0.0.0.0:${PORT}`);
      console.log(`✓ Local access: http://localhost:${PORT}`);
      console.log(`✓ Network access: http://10.12.72.161:${PORT}`);
      console.log(`✓ Android emulator: http://10.0.2.2:${PORT}`);
      console.log(`✓ Team ID: ${TEAM_ID}`);
      console.log(`✓ MQTT Broker: ${MQTT_BROKER}\n`);
    });
  } catch (error) {
    console.error('❌ Startup failed:', error.message);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n Shutting down gracefully...');

  if (mqttClient) {
    mqttClient.end();
    console.log('MQTT disconnected');
  }

  await closeDB();
  process.exit(0);
});

// Start the server
startup();

module.exports = { app, server };

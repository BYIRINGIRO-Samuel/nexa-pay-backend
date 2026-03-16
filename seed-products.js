const { connectDB, seedProducts, closeDB } = require('./database');

async function runSeedScript() {
    try {
        console.log('🌱 Starting product seeding script...');

        // Connect to database
        await connectDB();

        // Seed products
        await seedProducts();

        console.log('✅ Product seeding completed successfully!');

        // Close connection
        await closeDB();

        process.exit(0);
    } catch (error) {
        console.error('❌ Product seeding failed:', error);
        process.exit(1);
    }
}

// Run the script
runSeedScript();
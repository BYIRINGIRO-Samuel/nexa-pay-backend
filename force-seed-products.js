const { connectDB, forceSeedProducts, closeDB } = require('./database');

async function runForceSeedScript() {
    try {
        console.log('🔄 Starting FORCE product seeding script...');

        // Connect to database
        await connectDB();

        // Force seed products (clears existing first)
        await forceSeedProducts();

        console.log('✅ Force product seeding completed successfully!');

        // Close connection
        await closeDB();

        process.exit(0);
    } catch (error) {
        console.error('❌ Force product seeding failed:', error);
        process.exit(1);
    }
}

// Run the script
runForceSeedScript();
#!/usr/bin/env node

/**
 * Helper script to generate secure keys for the bot
 * Run: node scripts/generate-keys.js
 */

const crypto = require('crypto');

console.log('\n🔐 FC26 Bot - Key Generator\n');
console.log('=' .repeat(50));

// Generate encryption key (32 bytes for AES-256)
const encryptionKey = crypto.randomBytes(32).toString('hex').slice(0, 32);
console.log('\n📝 ENCRYPTION_KEY:');
console.log(encryptionKey);

// Generate JWT secret
const jwtSecret = crypto.randomBytes(64).toString('hex');
console.log('\n📝 JWT_SECRET:');
console.log(jwtSecret);

console.log('\n' + '=' .repeat(50));
console.log('\n✅ Copy these values to your .env file\n');

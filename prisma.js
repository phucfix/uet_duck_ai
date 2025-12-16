// Kết nối Prisma client đến database course-platform
const path = require('path');
let PrismaClient;
try {
	// Try local dependency first
	PrismaClient = require('@prisma/client').PrismaClient;
} catch (err) {
	// Fallback to the course-platform backend generated client if available
	try {
		const alt = path.join(__dirname, '..', 'course-platform', 'backend', 'node_modules', '@prisma', 'client');
		PrismaClient = require(alt).PrismaClient;
	} catch (err2) {
		console.error('Could not load @prisma/client from either local or course-platform/backend:', err2.message);
		throw err2;
	}
}

const prisma = new PrismaClient();
module.exports = prisma;

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.connectDB = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const connectDB = async () => {
    if (!process.env.MONGODB_URI) {
        throw new Error("MONGODB_URI is missing from the Hostinger environment variables.");
    }
    try {
        const conn = await mongoose_1.default.connect(process.env.MONGODB_URI, {
            serverSelectionTimeoutMS: 15000,
            connectTimeoutMS: 15000,
            maxPoolSize: 10,
        });
        console.log(`MongoDB connected: ${conn.connection.host}`);
        return conn;
    }
    catch (error) {
        throw new Error(`MongoDB connection failed: ${error.message}. Check the Atlas IP access list, database user, and MONGODB_URI.`);
    }
};
exports.connectDB = connectDB;

"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.emitToUser = exports.emitToAdmins = exports.getIO = exports.initSocket = void 0;
const socket_io_1 = require("socket.io");
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const User_js_1 = __importDefault(require("../models/User.js"));
let ioInstance = null;
const initSocket = (httpServer, allowedOrigins = []) => {
    const io = new socket_io_1.Server(httpServer, {
        cors: {
            origin: allowedOrigins.length ? allowedOrigins : true,
            credentials: true,
        },
    });
    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth?.token;
            if (!token)
                return next(new Error("Socket token is missing."));
            const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
            const user = await User_js_1.default.findById(decoded.id);
            const canUseSocket = user
                ? user.userType === "admin"
                    ? user.status === "active"
                    : ["active", "verified", "pending", "resubmitted", "rejected"].includes(user.status)
                : false;
            if (!canUseSocket) {
                return next(new Error("Socket user is not authorized."));
            }
            socket.user = {
                id: String(user._id),
                email: user.email,
                role: user.role,
                userType: user.userType,
            };
            next();
        }
        catch (error) {
            next(new Error("Invalid socket token."));
        }
    });
    io.on("connection", (socket) => {
        socket.join(`user:${socket.user.id}`);
        if (socket.user.userType === "admin")
            socket.join("admins");
        if (socket.user.userType === "client")
            socket.join("clients");
        socket.emit("socket:connected", {
            message: "Real-time connection established.",
            user: socket.user,
        });
        socket.on("disconnect", () => { });
    });
    ioInstance = io;
    return io;
};
exports.initSocket = initSocket;
const getIO = () => ioInstance;
exports.getIO = getIO;
const emitToAdmins = (event, payload) => {
    if (!ioInstance)
        return;
    ioInstance.to("admins").emit(event, payload);
};
exports.emitToAdmins = emitToAdmins;
const emitToUser = (userId, event, payload) => {
    if (!ioInstance || !userId)
        return;
    ioInstance.to(`user:${userId}`).emit(event, payload);
};
exports.emitToUser = emitToUser;
